"use server";

/**
 * Ordence — ⭐⭐⭐ PAYROLL
 * Version: v1.23.0-alpha · Batch 15
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT ID. Each
 * one is a browser-reachable endpoint whether or not a screen ever
 * renders a button for it, so the guard lives on the function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 FOUR PERMISSIONS AND THREE OF THE SEPARATIONS ARE THE CONTROL
 * ══════════════════════════════════════════════════════════════════════
 * `payroll.manage` sets salaries. `payroll.approve` signs off the wage
 * bill. `payroll.post` puts it in the books. `payroll.read` sees any of
 * it at all.
 *
 * ⚠️ COLLAPSING MANAGE AND APPROVE WOULD MEAN WHOEVER EDITS THE
 * SALARIES ALSO APPROVES THE TOTAL, which is the exact arrangement a
 * payroll control exists to prevent — and the same argument as the two
 * stock-count keys in `stock-counts.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT MAKES THIS BATCH DIFFERENT FROM EVERY OTHER ONE
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in Ordence is checked by a machine or not at all. A
 * payslip is checked by a person with a calculator who is owed the
 * money, and they are right to. So the payslip carries its own working,
 * nothing is netted, and a figure the system is not sure of is a stated
 * PROBLEM rather than a confident number.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  employeePayStructure,
  employees,
  payComponents,
  payrollRuns,
  payslips,
  statutoryRates,
} from "@/db/schema/payroll";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireAccess } from "@/server/billing/access";
import { requirePayrollEntitlement } from "@/server/payroll/entitlement";
import { toSalesActionError } from "@/server/sales/guards";
import { postPayrollRun } from "@/server/accounting/post-sales";
import { computeRun, daysInPeriod, daysOnRollsIn, writeRun } from "@/server/payroll/run";
import {
  loadRunAttendance,
  splitLopForPayslip,
  type RunLopRow,
} from "@/server/payroll/attendance-bridge";
import { formatDays, parseDaysOrZero } from "@/lib/leave/days";
import { PAYROLL_ROLE_META } from "@/lib/accounting/sales-posting";
import { STARTER_COMPONENTS, STARTER_RATES } from "@/lib/payroll/starter";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "payroll.read" as const;
const MANAGE = "payroll.manage" as const;
const APPROVE = "payroll.approve" as const;
const POST = "payroll.post" as const;

/* ================================================================== */
/* ① EMPLOYEES                                                         */
/* ================================================================== */

const employeeSchema = z.object({
  employeeCode: z.string().trim().min(1).max(40),
  fullName: z.string().trim().min(2).max(200),
  designation: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
  workStateCode: z.string().trim().length(2).toUpperCase(),
  joinedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  leftOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "A PAN is five letters, four digits and a letter.")
    .nullish(),
  uan: z.string().trim().regex(/^[0-9]{12}$/).nullish(),
  esicNumber: z.string().trim().max(17).nullish(),
  pfExempt: z.boolean().default(false),
  pfOnFullWages: z.boolean().default(false),
  esiExempt: z.boolean().default(false),
  taxRegime: z.enum(["new", "old"]).default("new"),
  declaredDeductionsMinor: z.string().regex(/^\d+$/).default("0"),
  tdsOverrideMinor: z.string().regex(/^\d+$/).nullish(),
});

export async function saveEmployee(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    await requirePayrollEntitlement();
    const ctx = await requirePermission(MANAGE);
    const parsed = employeeSchema.extend({ id: z.string().uuid().optional() }).safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        employeeCode: d.employeeCode,
        fullName: d.fullName,
        designation: d.designation ?? null,
        department: d.department ?? null,
        workStateCode: d.workStateCode,
        joinedOn: d.joinedOn,
        leftOn: d.leftOn ?? null,
        pan: d.pan ?? null,
        uan: d.uan ?? null,
        esicNumber: d.esicNumber ?? null,
        pfExempt: d.pfExempt,
        pfOnFullWages: d.pfOnFullWages,
        esiExempt: d.esiExempt,
        taxRegime: d.taxRegime,
        declaredDeductionsMinor: d.declaredDeductionsMinor,
        tdsOverrideMinor: d.tdsOverrideMinor ?? null,
        updatedAt: new Date(),
      };

      if (d.id) {
        await tx.update(employees).set(values).where(eq(employees.id, d.id));
        return d.id;
      }

      const [row] = await tx
        .insert(employees)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: employees.id });
      return row?.id ?? "";
    });

    await writeAudit(ctx, {
      action: d.id ? "update" : "create",
      resourceType: "employee",
      resourceId: id,
      // ⚠️ NO SALARY IN THE AUDIT REASON. The audit log is read by more
      // people than the payroll screen is, and a reason line carrying a
      // figure would publish through the back door what the permission
      // keeps out of the front.
      newValue: { employeeCode: d.employeeCode },
    });

    revalidatePath("/payroll/employees");
    return { ok: true, data: { id } };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

export async function listEmployees(): Promise<
  ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(employees)
        .where(eq(employees.tenantId, ctx.tenant.id))
        .orderBy(employees.fullName)
        .limit(500),
    );
    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* ② PAY COMPONENTS AND STRUCTURE                                      */
/* ================================================================== */

/**
 * ⭐ THE STARTER SET, SO A TENANT IS NOT ASKED TO INVENT PAYROLL FROM
 * FIRST PRINCIPLES.
 *
 * ⚠️ IT IS A SEED, NOT A DEFAULT. The rows are written once and are then
 * the tenant's to change. A "default" that is re-applied on every load
 * silently undoes whatever they corrected.
 */
export async function seedPayrollSetup(): Promise<
  ActionResult<{ components: number; rates: number; note: string }>
> {
  try {
    await requirePayrollEntitlement();
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      let components = 0;
      for (const c of STARTER_COMPONENTS) {
        const inserted = await tx
          .insert(payComponents)
          .values({ tenantId: ctx.tenant.id, ...c })
          .onConflictDoNothing()
          .returning({ id: payComponents.id });
        components += inserted.length;
      }

      let rates = 0;
      for (const r of STARTER_RATES) {
        // ⚠️ ONLY IF NOTHING OF THAT KIND EXISTS. Re-seeding a tenant
        // who has corrected a rate would overwrite their correction
        // with the number they corrected away from.
        const [existing] = await tx
          .select({ id: statutoryRates.id })
          .from(statutoryRates)
          .where(
            and(
              eq(statutoryRates.tenantId, ctx.tenant.id),
              eq(statutoryRates.kind, r.kind),
              r.scope === null
                ? sql`${statutoryRates.scope} IS NULL`
                : eq(statutoryRates.scope, r.scope),
            ),
          )
          .limit(1);
        if (existing) continue;

        await tx.insert(statutoryRates).values({
          tenantId: ctx.tenant.id,
          kind: r.kind,
          scope: r.scope,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: null,
          payload: r.payload,
          note: r.note,
          createdBy: ctx.user.id,
        });
        rates += 1;
      }

      return { components, rates };
    });

    revalidatePath("/payroll/setup");
    return {
      ok: true,
      data: {
        ...result,
        note: "These are Ordence's opening numbers, not legal advice. Check every rate and every professional tax slab against what your State and your auditor say before the first run.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

const structureSchema = z.object({
  employeeId: z.string().uuid(),
  componentId: z.string().uuid(),
  monthlyAmountMinor: z.string().regex(/^\d+$/),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().max(500).optional(),
});

/**
 * ⭐⭐ A RAISE IS A NEW ROW AND THE OLD ONE IS CLOSED, NEVER EDITED.
 *
 * 🔴 EDITING IN PLACE SILENTLY RE-PRICES EVERY PAYSLIP EVER REISSUED
 * FROM IT. Payroll is retrospective by nature: an employee asks for last
 * March's payslip and it must produce the number they were actually
 * paid, not the number they would be paid today.
 */
export async function setPayStructure(
  input: unknown,
): Promise<ActionResult<{ id: string; note: string }>> {
  try {
    await requirePayrollEntitlement();
    const ctx = await requirePermission(MANAGE);
    const parsed = structureSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      // ⚠️ THE DAY BEFORE THE NEW ROW STARTS, so there is never a gap
      // and never an overlap. The partial unique index in 0075 refuses
      // two open rows for the same component, which is what makes this
      // close-then-insert safe under a double submit.
      const closeOn = previousDay(d.effectiveFrom);

      await tx
        .update(employeePayStructure)
        .set({ effectiveTo: closeOn })
        .where(
          and(
            eq(employeePayStructure.tenantId, ctx.tenant.id),
            eq(employeePayStructure.employeeId, d.employeeId),
            eq(employeePayStructure.componentId, d.componentId),
            sql`${employeePayStructure.effectiveTo} IS NULL`,
          ),
        );

      const [row] = await tx
        .insert(employeePayStructure)
        .values({
          tenantId: ctx.tenant.id,
          employeeId: d.employeeId,
          componentId: d.componentId,
          monthlyAmountMinor: d.monthlyAmountMinor,
          effectiveFrom: d.effectiveFrom,
          reason: d.reason ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: employeePayStructure.id });

      return row?.id ?? "";
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "employee_pay_structure",
      resourceId: id,
      newValue: { employeeId: d.employeeId, effectiveFrom: d.effectiveFrom },
    });

    revalidatePath(`/payroll/employees/${d.employeeId}`);
    return {
      ok: true,
      data: {
        id,
        note: "The previous amount has been closed the day before this one starts, so old payslips still reproduce the figures that were actually paid.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

function previousDay(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export async function getEmployeeStructure(
  employeeId: string,
): Promise<ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: employeePayStructure.id,
          componentId: employeePayStructure.componentId,
          code: payComponents.code,
          label: payComponents.label,
          kind: payComponents.kind,
          monthlyAmountMinor: employeePayStructure.monthlyAmountMinor,
          effectiveFrom: employeePayStructure.effectiveFrom,
          effectiveTo: employeePayStructure.effectiveTo,
          reason: employeePayStructure.reason,
        })
        .from(employeePayStructure)
        .innerJoin(payComponents, eq(payComponents.id, employeePayStructure.componentId))
        .where(
          and(
            eq(employeePayStructure.tenantId, ctx.tenant.id),
            eq(employeePayStructure.employeeId, employeeId),
          ),
        )
        .orderBy(desc(employeePayStructure.effectiveFrom)),
    );
    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

export async function listPayComponents(): Promise<
  ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(payComponents)
        .where(eq(payComponents.tenantId, ctx.tenant.id))
        .orderBy(payComponents.displayOrder),
    );
    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/**
 * ⚠️ THE CALLBACK RETURN TYPES BELOW ARE WRITTEN OUT RATHER THAN
 * INFERRED, AND THAT IS NOT STYLE.
 *
 * 🔴 WITH SEVERAL `return { error: ... }` BRANCHES AND ONE SUCCESS
 * BRANCH, TypeScript collapses the inferred union into a single object
 * with every property optional — and the success fields become possibly
 * undefined AFTER a check that was supposed to have ruled that out.
 * `server/platform/impersonation.ts` hit this first and documented it;
 * the same shape appears four times in this file.
 */
type Refusal = { error: string };
type Ok<T> = T & { error?: undefined };
type Outcome<T> = Refusal | Ok<T>;

/* ================================================================== */
/* ③ THE RUN                                                           */
/* ================================================================== */

const openRunSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function openPayrollRun(
  input: unknown,
): Promise<ActionResult<{ id: string; runNo: string }>> {
  try {
    await requirePayrollEntitlement();
    const ctx = await requirePermission(MANAGE);
    const parsed = openRunSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the dates." };
    const d = parsed.data;

    if (d.periodEnd < d.periodStart) {
      return { ok: false, error: "The period ends before it starts." };
    }

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const runNo = `PR-${d.periodStart.slice(0, 7).replace("-", "")}`;
      const [row] = await tx
        .insert(payrollRuns)
        .values({
          tenantId: ctx.tenant.id,
          runNo,
          periodStart: d.periodStart,
          periodEnd: d.periodEnd,
          createdBy: ctx.user.id,
        })
        .returning({ id: payrollRuns.id, runNo: payrollRuns.runNo });
      return row ?? null;
    });

    if (!created) return { ok: false, error: "The run could not be opened." };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "payroll_run",
      resourceId: created.id,
      newValue: { period: d.periodStart },
    });

    revalidatePath("/payroll");
    return { ok: true, data: created };
  } catch (error) {
    // ⚠️ THE UNIQUE INDEX IS WHAT ACTUALLY PREVENTS TWO RUNS FOR ONE
    // MARCH. This turns its error into a sentence a person can act on.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("payroll_runs_one_live_per_period")) {
      return {
        ok: false,
        error:
          "There is already a payroll run for this period. Two runs for the same month would post the wage bill twice, so cancel the existing one with a reason if you need to start again.",
      };
    }
    return toSalesActionError(error, "payroll");
  }
}

/**
 * ⭐⭐⭐ v1.47.0 (BATCH 50): THE SCHEMA NO LONGER ACCEPTS ATTENDANCE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT USED TO, AND THE BOARD SENT `attendance: []` EVERY TIME
 * ══════════════════════════════════════════════════════════════════════
 * So every run paid every salaried person a full month whatever the
 * register said, and loss of pay could not be entered at all. That is the
 * defect this batch exists to fix, and the fix is NOT to have the browser
 * send the right array instead of an empty one.
 *
 * ⚠️ BECAUSE THE FIELD WAS ALSO A HOLE. A `"use server"` export is a
 * public endpoint. `attendance` was an array of
 * `{employeeId, payableDays, lopDays}` that was shape-validated and then
 * believed — so a crafted request could dock any employee any number of
 * days, or send zero days of loss of pay for somebody the register says
 * was absent all month, and the wage bill would be computed from it with
 * nothing anywhere recording that the figure did not come from the
 * register. Approval then froze it.
 *
 * ⭐ `computeRun()` READS THE REGISTER ITSELF, INSIDE THE TRANSACTION
 * THAT WRITES THE PAYSLIPS. The only thing this endpoint now takes is
 * which run to compute.
 */
const computeSchema = z.object({
  runId: z.string().uuid(),
});

export async function computePayrollRun(
  input: unknown,
): Promise<ActionResult<{ employeeCount: number; problemCount: number; note: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = computeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (
        tx,
      ): Promise<
        Outcome<{
          employeeCount: number;
          problemCount: number;
          assumption: string;
          lopDays: string;
        }>
      > => {
      const [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, d.runId)))
        .limit(1);

      if (!run) return { error: "No such payroll run." };
      if (run.status !== "draft" && run.status !== "computed") {
        return {
          error:
            "This run has been approved. Recomputing it would change a wage bill somebody has already signed off — cancel it with a reason and raise a new one.",
        };
      }

      const periodStart = String(run.periodStart);
      const periodEnd = String(run.periodEnd);

      const computed = await computeRun(tx, {
        tenantId: ctx.tenant.id,
        runId: d.runId,
        periodStart,
        periodEnd,
      });

      const staff = await tx
        .select({
          id: employees.id,
          fullName: employees.fullName,
          employeeCode: employees.employeeCode,
          joinedOn: employees.joinedOn,
          leftOn: employees.leftOn,
        })
        .from(employees)
        .where(eq(employees.tenantId, ctx.tenant.id));

      const days = daysInPeriod(periodStart, periodEnd);

      await writeRun(tx, {
        tenantId: ctx.tenant.id,
        runId: d.runId,
        outcome: computed,
        employeeNames: new Map(
          staff.map((s) => [s.id, { name: s.fullName, code: s.employeeCode }]),
        ),
        daysInMonth: days,
      });

      return {
        employeeCount: computed.totals.employeeCount,
        problemCount: computed.totals.withProblems,
        /* ⭐ Said back to the operator, so the assumption is not silent. */
        assumption: computed.attendance.assumption,
        lopDays: formatDays(computed.attendance.totalLopCentidays),
      };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    revalidatePath(`/payroll/${d.runId}`);
    return {
      ok: true,
      data: {
        employeeCount: outcome.employeeCount,
        problemCount: outcome.problemCount,
        note:
          outcome.problemCount > 0
            ? `${outcome.problemCount} payslip${outcome.problemCount === 1 ? "" : "s"} carry a problem. The run cannot be approved until every one is resolved.`
            : `Every payslip computed without a problem. ${outcome.lopDays} days of loss of pay charged. ${outcome.assumption}`,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ------------------------------------------------------------------ */
/* THE LOSS-OF-PAY POSITION, BEFORE ANYBODY SIGNS                      */
/* ------------------------------------------------------------------ */

export interface LopPositionRow {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly employeeCode: string;
  readonly payableDays: number;
  /** Formatted days, `"1.50"`. ⚠️ A string because a float is not a day. */
  readonly lopDays: string;
  readonly chargedDays: number;
  readonly unchargedDays: string;
  readonly fromRegisterDays: string;
  readonly fromApprovedUnpaidDays: string;
  readonly approvedPaidDays: string;
  readonly unregularisedDays: string;
  readonly registerDayCount: number;
  readonly capped: boolean;
  readonly source: string;
}

/**
 * ⭐⭐⭐ WHO IS LOSING PAY THIS MONTH, AND WHY, BEFORE THE RUN IS
 * APPROVED.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE POINT IS THAT IT IS SEEN BEFORE THE SIGNATURE, NOT AFTER
 * ══════════════════════════════════════════════════════════════════════
 * A deduction discovered on a payslip has already been paid, already been
 * remitted, and is already an argument with an employee who is holding
 * the piece of paper. The same figure shown on the run board is a
 * question somebody can answer by opening the attendance register.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND AN APPROVED OR POSTED RUN IS READ FROM ITS OWN PAYSLIPS
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NOT RE-READ FROM THE REGISTER. Approval freezes the payslips — the
 * database refuses a change to any of them. If this screen went back to
 * `staff_attendance` afterwards it would show the CURRENT register beside
 * a FROZEN wage bill, and the two would diverge the first time anybody
 * regularised an absence for last month. Somebody reconciling a payslip
 * would then be reading a number that was never used to pay anybody, on
 * a screen that gives no hint of it.
 *
 * So: `draft` and `computed` read the register live, because that is what
 * the next compute will charge. Everything else reads what was actually
 * charged, and says so.
 */
export async function getPayrollLopPosition(input: unknown): Promise<
  ActionResult<{
    live: boolean;
    status: string;
    periodStart: string;
    periodEnd: string;
    rows: readonly LopPositionRow[];
    employeesInRun: number;
    employeesWithRecords: number;
    employeesAssumedFullMonth: number;
    unregularisedCount: number;
    unchargeableCount: number;
    totalLopDays: string;
    assumption: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = z.object({ runId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Pick a payroll run." };
    const runId = parsed.data.runId;

    type Position = {
      live: boolean;
      status: string;
      periodStart: string;
      periodEnd: string;
      rows: LopPositionRow[];
      employeesInRun: number;
      employeesWithRecords: number;
      employeesAssumedFullMonth: number;
      unregularisedCount: number;
      unchargeableCount: number;
      totalLopDays: string;
      assumption: string;
    };

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<Position>> => {
        const [run] = await tx
          .select({
            id: payrollRuns.id,
            status: payrollRuns.status,
            periodStart: payrollRuns.periodStart,
            periodEnd: payrollRuns.periodEnd,
          })
          .from(payrollRuns)
          .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, runId)))
          .limit(1);
        if (!run) return { error: "No such payroll run." };

        const status = String(run.status);
        const periodStart = String(run.periodStart);
        const periodEnd = String(run.periodEnd);
        const live = status === "draft" || status === "computed";

        if (!live) {
          /* ⭐ THE FROZEN POSITION: what this run actually charged. */
          const rows = await tx
            .select({
              employeeId: payslips.employeeId,
              employeeName: payslips.employeeName,
              employeeCode: payslips.employeeCode,
              payableDays: payslips.payableDays,
              lopDays: payslips.lopDays,
            })
            .from(payslips)
            .where(and(eq(payslips.tenantId, ctx.tenant.id), eq(payslips.runId, runId)));

          const charged = rows
            .map((r) => ({
              employeeId: String(r.employeeId),
              employeeName: String(r.employeeName),
              employeeCode: String(r.employeeCode),
              payableDays: Number(r.payableDays ?? 0),
              lopCentidays: parseDaysOrZero(r.lopDays),
            }))
            .filter((r) => r.lopCentidays > 0)
            .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

          let total = 0;
          for (const r of charged) total += r.lopCentidays;

          return {
            live: false,
            status,
            periodStart,
            periodEnd,
            rows: charged.map((r) => ({
              employeeId: r.employeeId,
              employeeName: r.employeeName,
              employeeCode: r.employeeCode,
              payableDays: r.payableDays,
              lopDays: formatDays(r.lopCentidays),
              /* ⚠️ Whole days, without a float — see `splitLopForPayslip`. */
              chargedDays: splitLopForPayslip(r.lopCentidays).wholeDays,
              unchargedDays: "0.00",
              fromRegisterDays: "0.00",
              fromApprovedUnpaidDays: "0.00",
              approvedPaidDays: "0.00",
              unregularisedDays: "0.00",
              registerDayCount: 0,
              capped: false,
              source: "frozen",
            })),
            employeesInRun: rows.length,
            employeesWithRecords: charged.length,
            employeesAssumedFullMonth: rows.length - charged.length,
            unregularisedCount: 0,
            unchargeableCount: 0,
            totalLopDays: formatDays(total),
            assumption: `This run is ${status}. What is shown is what it actually charged, read from its own payslips — not from the attendance register, which may have moved since.`,
          };
        }

        /**
         * ⚠️ THE SAME POPULATION `computeRun()` USES — everybody on the
         * rolls at any point inside the period, not everybody active
         * today. Somebody who left on the 20th is owed twenty days.
         */
        const staff = await tx
          .select({
            id: employees.id,
            fullName: employees.fullName,
            employeeCode: employees.employeeCode,
            joinedOn: employees.joinedOn,
            leftOn: employees.leftOn,
            workStateCode: employees.workStateCode,
          })
          .from(employees)
          .where(
            and(
              eq(employees.tenantId, ctx.tenant.id),
              sql`${employees.joinedOn} <= ${periodEnd}::date`,
              sql`(${employees.leftOn} IS NULL OR ${employees.leftOn} >= ${periodStart}::date)`,
            ),
          );

        const days = daysInPeriod(periodStart, periodEnd);
        const payableDaysByEmployee = new Map<string, number>(
          staff.map((s) => [
            String(s.id),
            Math.min(
              daysOnRollsIn(
                String(s.joinedOn),
                s.leftOn === null ? null : String(s.leftOn),
                periodStart,
                periodEnd,
                days,
              ),
              days,
            ),
          ]),
        );

        const position = await loadRunAttendance(tx, {
          tenantId: ctx.tenant.id,
          periodStart,
          periodEnd,
          payableDaysByEmployee,
          workStateByEmployee: new Map(
            staff.map((s) => [String(s.id), s.workStateCode === null ? null : String(s.workStateCode)]),
          ),
        });

        const nameById = new Map(
          staff.map((s) => [
            String(s.id),
            { name: String(s.fullName), code: String(s.employeeCode) },
          ]),
        );

        const rows = position.rows
          .map((r: RunLopRow) => ({
            employeeId: r.employeeId,
            employeeName: nameById.get(r.employeeId)?.name ?? "Unknown",
            employeeCode: nameById.get(r.employeeId)?.code ?? "-",
            payableDays: r.payableDays,
            lopDays: formatDays(r.totalLopCentidays),
            chargedDays: r.chargedLopDays,
            unchargedDays: formatDays(r.unrepresentableCentidays),
            fromRegisterDays: formatDays(r.registerCentidays),
            fromApprovedUnpaidDays: formatDays(r.approvedUnpaidCentidays),
            approvedPaidDays: formatDays(r.approvedPaidCentidays),
            unregularisedDays: formatDays(r.unregularisedCentidays),
            registerDayCount: r.registerDayCount,
            capped: r.cappedAtPayableDays,
            source: r.source,
          }))
          .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

        return {
          live: true,
          status,
          periodStart,
          periodEnd,
          rows,
          employeesInRun: position.employeesInRun,
          employeesWithRecords: position.employeesWithRegisterRows,
          employeesAssumedFullMonth: position.employeesAssumedFullMonth.length,
          unregularisedCount: position.unregularisedEmployeeIds.length,
          unchargeableCount: position.fractionalEmployeeIds.length,
          totalLopDays: formatDays(position.totalLopCentidays),
          assumption: position.assumption,
        };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };
    return { ok: true, data: outcome };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

const approveSchema = z.object({
  runId: z.string().uuid(),
  note: z.string().trim().min(10).max(1000),
});

/**
 * ⭐⭐ APPROVAL FREEZES THE PAYSLIPS, AND THE FREEZE IS IN THE DATABASE.
 *
 * ⚠️ APPROVAL IS A SIGNATURE. If a payslip can still change afterwards
 * the signature attaches to nothing, and the change made after approval
 * is never a typo — it is a number somebody wanted to be different.
 */
export async function approvePayrollRun(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(APPROVE);
    /**
     * 🔴 CALLED SO THAT THE EXEMPTION IS LOAD-BEARING, NOT ACCIDENTAL.
     *
     * Payroll survived dunning until now only because nobody had got
     * round to gating it — which is not a guarantee, it is an oversight
     * that happens to point the right way. The first person to add
     * `requireAccess("payroll:approve")` without reading
     * `STATUTORY_WRITE_PREFIXES` would have turned a failed card on the
     * 5th into a missed salary run on the 7th.
     *
     * So the call is here, the `payroll:` prefix is exempt at every rung
     * of the ladder, and `tests/ui/entitlement-enforcement.test.ts` fails
     * if that exemption is ever removed. An SMB whose card bounced must
     * still be able to pay its staff; the money we are owed is a smaller
     * problem than the PF deadline they would miss.
     */
    await requireAccess("payroll:approve", ctx);
    const parsed = approveSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "A note of at least ten characters is required. You are signing off what everybody is paid this month, and in six months this line is the only record of why.",
      };
    }
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ runNo: string; net: string }>> => {
      const [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, d.runId)))
        .limit(1);

      if (!run) return { error: "No such payroll run." };
      if (run.status !== "computed") {
        return { error: `This run is ${run.status} and only a computed run can be approved.` };
      }

      // 🔴 A RUN WITH ANY PROBLEM CANNOT BE APPROVED. Every problem is a
      // figure the system is not sure of, and approving past it means
      // somebody is paid a number nobody stands behind.
      if (run.problemCount > 0) {
        return {
          error: `${run.problemCount} payslip${run.problemCount === 1 ? "" : "s"} still carry a problem. Fix them and recompute — approving over a problem means paying a figure nothing in this system stands behind.`,
        };
      }

      if (run.employeeCount === 0) {
        return { error: "There is nobody in this run." };
      }

      await tx
        .update(payrollRuns)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedBy: ctx.user.id,
          approvalNote: d.note,
        })
        .where(eq(payrollRuns.id, d.runId));

      return { runNo: run.runNo, net: String(run.netPayMinor) };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "payroll_run",
      resourceId: d.runId,
      newValue: { stage: "approved", runNo: outcome.runNo },
    });

    revalidatePath(`/payroll/${d.runId}`);
    return {
      ok: true,
      data: {
        note: "Approved. The payslips are now frozen — the database refuses a change to any of them, and a correction means cancelling this run and raising another.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/**
 * ⭐⭐⭐ POSTING: THE WAGE BILL REACHES THE LEDGER.
 *
 * ⚠️ THE DATE IS THE PERIOD END, NOT TODAY. A March payroll posted on
 * the 7th of April belongs in March — which is correct accounting and
 * also the thing that makes the period lock mean anything.
 */
export async function postPayroll(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(POST);
    // ⭐ Same reasoning as `approvePayrollRun`. Posting payroll to the
    // ledger is the write that makes the statutory liability real; a
    // billing dispute is not a reason to leave it unrecorded.
    await requireAccess("payroll:post", ctx);
    const { runId } = z.object({ runId: z.string().uuid() }).parse(input);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ transactionId: string; runNo: string }>> => {
      const [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, runId)))
        .limit(1);

      if (!run) return { error: "No such payroll run." };
      if (run.status === "posted") {
        return { error: "This run is already in the ledger." };
      }
      if (run.status !== "approved") {
        return {
          error: "Only an approved run can be posted. Somebody has to sign off the wage bill first.",
        };
      }

      const periodEnd = String(run.periodEnd);
      const posted = await postPayrollRun(tx, {
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        runId,
        runNo: run.runNo,
        periodEnd,
        periodLabel: monthLabel(periodEnd),
        facts: {
          grossMinor: BigInt(run.grossMinor),
          employeePfMinor: BigInt(run.employeePfMinor),
          employerPfMinor: BigInt(run.employerPfMinor),
          employerPensionMinor: BigInt(run.employerPensionMinor),
          edliMinor: BigInt(run.edliMinor),
          pfAdminMinor: BigInt(run.pfAdminMinor),
          employeeEsiMinor: BigInt(run.employeeEsiMinor),
          employerEsiMinor: BigInt(run.employerEsiMinor),
          professionalTaxMinor: BigInt(run.professionalTaxMinor),
          tdsMinor: BigInt(run.tdsMinor),
          otherDeductionsMinor: BigInt(run.otherDeductionsMinor),
          netPayMinor: BigInt(run.netPayMinor),
        },
      });

      if (!posted.posted) {
        if (posted.reason === "unmapped_roles") {
          return {
            error: `The wage bill cannot reach the ledger until these accounts are mapped: ${posted.missing
              .map((r) => PAYROLL_ROLE_META[r as keyof typeof PAYROLL_ROLE_META]?.label ?? r)
              .join(", ")}. Nothing has been posted — a payroll journal missing a leg does not balance.`,
          };
        }
        if (posted.reason === "period_closed") {
          return {
            error: `${posted.period} is closed, and this payroll is dated in it. Reopen the period deliberately or correct the run's dates.`,
          };
        }
        if (posted.reason === "already_posted") {
          return { error: "This wage bill is already in the ledger." };
        }
        return { error: "There is nothing in this run to post." };
      }

      await tx
        .update(payrollRuns)
        .set({ status: "posted", postedAt: new Date(), transactionId: posted.transactionId })
        .where(eq(payrollRuns.id, runId));

      return { transactionId: posted.transactionId, runNo: run.runNo };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "transaction",
      resourceId: outcome.transactionId,
      newValue: { source: "payroll", runNo: outcome.runNo },
    });

    revalidatePath(`/payroll/${runId}`);
    return {
      ok: true,
      data: {
        note: "Posted. The gross is in Salaries and Wages, the employer's own contributions are separate expenses, and what was withheld sits in five payable accounts. Nothing has left the bank — that happens when the transfer clears, against Salaries Payable.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

const cancelSchema = z.object({
  runId: z.string().uuid(),
  reason: z.string().trim().min(10).max(1000),
});

export async function cancelPayrollRun(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(APPROVE);
    const parsed = cancelSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "A reason of at least ten characters is required. A cancelled run with no reason is a row nobody can explain later.",
      };
    }

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ done: true }>> => {
      const [run] = await tx
        .select({ status: payrollRuns.status })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, parsed.data.runId)))
        .limit(1);

      if (!run) return { error: "No such payroll run." };
      if (run.status === "posted") {
        return {
          error:
            "This run is in the ledger and cannot be cancelled. A posted wage bill is reversed with a journal entry, not by changing a status.",
        };
      }

      await tx
        .update(payrollRuns)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: parsed.data.reason,
        })
        .where(eq(payrollRuns.id, parsed.data.runId));

      return { done: true };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "payroll_run",
      resourceId: parsed.data.runId,
      newValue: { stage: "cancelled" },
    });

    revalidatePath("/payroll");
    return {
      ok: true,
      data: {
        note: "Cancelled. The run stays on the record with its reason, and the period is free for a new one.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* ④ READS                                                             */
/* ================================================================== */

export async function listPayrollRuns(): Promise<
  ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(payrollRuns)
        .where(eq(payrollRuns.tenantId, ctx.tenant.id))
        .orderBy(desc(payrollRuns.periodStart))
        .limit(60),
    );
    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

export async function getPayrollRun(runId: string): Promise<
  ActionResult<{
    run: Record<string, unknown> | null;
    slips: ReadonlyArray<Record<string, unknown>>;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [run] = await tx
        .select()
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, runId)))
        .limit(1);

      const slips = await tx
        .select()
        .from(payslips)
        .where(and(eq(payslips.tenantId, ctx.tenant.id), eq(payslips.runId, runId)))
        .orderBy(payslips.employeeName);

      return { run: run ?? null, slips };
    });

    return {
      ok: true,
      data: {
        run: (data.run ?? null) as Record<string, unknown> | null,
        slips: data.slips as ReadonlyArray<Record<string, unknown>>,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/**
 * ⭐ THE ACCOUNTS THIS TENANT STILL HAS TO MAP, ANSWERED BEFORE THE
 * FIRST RUN RATHER THAN AT THE MOMENT POSTING FAILS.
 */
export async function payrollAccountsNeeded(): Promise<
  ActionResult<{ roles: ReadonlyArray<{ role: string; label: string; help: string; mapped: boolean }> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const mapped = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT role FROM sales_posting_accounts WHERE tenant_id = ${ctx.tenant.id}::uuid
      `);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{
        role?: string;
      }>;
      return new Set(list.map((r) => String(r.role)));
    });

    return {
      ok: true,
      data: {
        roles: Object.entries(PAYROLL_ROLE_META).map(([role, meta]) => ({
          role,
          label: meta.label,
          help: meta.help,
          mapped: mapped.has(role),
        })),
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

function monthLabel(periodEnd: string): string {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const month = Number(periodEnd.slice(5, 7));
  const year = periodEnd.slice(0, 4);
  return `${months[month - 1] ?? periodEnd.slice(5, 7)} ${year}`;
}
