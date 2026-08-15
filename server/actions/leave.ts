"use server";

/**
 * Ordence — ⭐⭐⭐ LEAVE AND STAFF ATTENDANCE
 * Version: v1.46.0-alpha · Batch 59
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT ID. Each
 * one is a browser-reachable endpoint whether or not a screen ever
 * renders a button for it, so the guard lives on the function and is
 * visible at the export.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 FIVE PERMISSIONS, AND THE FIRST SEPARATION IS FROM PAYROLL
 * ══════════════════════════════════════════════════════════════════════
 * The obvious shortcut is to gate all of this on `payroll.manage`. It is
 * wrong in the direction that leaks: a line manager approving three days
 * off would then hold the key that reads everybody's salary. Leave is
 * administered by people all over an organisation; payroll is done by
 * two of them.
 *
 * `leave.read`        the whole register — everybody's balances
 * `leave.request`     your own leave and your own balance, nobody else's
 * `leave.approve`     somebody else's application
 * `leave.manage`      types, leave years, holidays, accrual, adjustments
 * `attendance.record` 🔴 the only key here that moves MONEY
 *
 * ⚠️ `leave.manage` AND `leave.approve` ARE SEPARATE ON PURPOSE.
 * `leave.manage` can write an `adjustment` that credits days out of
 * nothing. If it also approved requests, one person could grant
 * themselves a balance and then approve their own absence against it,
 * and both halves would look entirely ordinary in the ledger.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FOUR DECISIONS, AS THEY SHOW UP IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * ① ACCRUAL IS EARNED. `runLeaveAccrual` walks month ends and writes a
 *    dated entry per month. Nothing grants a year up front.
 * ② A BALANCE IS A FOLD. Every balance in this file comes from
 *    `foldLedger()` over `leave_ledger`. There is no balance column to
 *    read and none to forget to update.
 * ③ CAPS ARE EXPLICIT. `closeLeavePeriod` writes a `lapse` entry with a
 *    reason on it for every day above the cap, rather than letting the
 *    balance quietly vanish.
 * ④ AN APPROVAL IS NOT AN ABSENCE. `decideLeaveRequest` writes a
 *    `commitment`. Only `recordAttendance` writes `taken`.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { employees, payrollRuns } from "@/db/schema/payroll";
import {
  holidayCalendar,
  leaveLedger,
  leavePeriods,
  leaveRequests,
  leaveTypes,
  staffAttendance,
} from "@/db/schema/leave";
import { can } from "@/lib/permissions";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { loadPayrollAttendance } from "@/server/leave/attendance";
import { accrueTo, monthEndsIn, policyFromRow } from "@/lib/leave/accrual";
import {
  carryForward,
  foldLedger,
  type LeaveEntryKind,
  type LedgerEntryFacts,
} from "@/lib/leave/balance";
import { formatDays, parseDays, parseDaysOrZero } from "@/lib/leave/days";
import { checkRequestPolicy, countRequestDays } from "@/lib/leave/request";
import { defaultLopFraction, type AttendanceSummary } from "@/lib/leave/attendance";
import { STARTER_LEAVE_TYPES, proposedLeaveYear } from "@/lib/leave/starter";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "leave.read" as const;
const REQUEST = "leave.request" as const;
const APPROVE = "leave.approve" as const;
const MANAGE = "leave.manage" as const;
const RECORD = "attendance.record" as const;
/** ⭐ The payroll side of the boundary. See `getPayrollAttendance`. */
const PAYROLL_MANAGE = "payroll.manage" as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ⚠️ THE CALLBACK RETURN TYPES BELOW ARE WRITTEN OUT RATHER THAN
 * INFERRED, AND THAT IS NOT STYLE.
 *
 * 🔴 WITH SEVERAL `return { error: ... }` BRANCHES AND ONE SUCCESS
 * BRANCH, TypeScript collapses the inferred union into a single object
 * with every property optional — and the success fields become possibly
 * undefined AFTER a check that was supposed to have ruled that out. The
 * same three lines appear in `server/actions/payroll.ts`, which
 * documented the shape first.
 */
type Refusal = { error: string };
type Ok<T> = T & { error?: undefined };
type Outcome<T> = Refusal | Ok<T>;

/**
 * ⚠️ SUNDAY OFF, WHICH IS A DEFAULT AND NOT A RULE.
 *
 * 🔴 THE SIX-DAY WEEK IS STILL THE COMMON CASE IN INDIA, so assuming a
 * five-day week would silently stop deducting Saturdays from everybody's
 * casual leave. A per-tenant working-week setting is a real feature and
 * is not in this batch; until it exists this constant is the assumption,
 * written down in one place where it can be found and argued with rather
 * than inlined at three call sites.
 */
const DEFAULT_WEEKLY_OFF_DAYS = [0] as const;

/* ================================================================== */
/* ① SETUP — TYPES, LEAVE YEARS, HOLIDAYS                              */
/* ================================================================== */

const leaveTypeSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  label: z.string().trim().min(2).max(120),
  isPaid: z.boolean().default(true),
  accrualMethod: z.enum(["monthly_earned", "annual_advance", "none"]).default("monthly_earned"),
  annualEntitlementDays: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  accrualRoundToDays: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0.5"),
  probationDays: z.number().int().min(0).max(730).default(0),
  /**
   * 🔴 DECISION ③. BOTH CAPS ARE REQUIRED FIELDS WITH NO "UNLIMITED"
   * OPTION. Zod defaults them to "0" rather than to null, so a form that
   * omits them produces use-it-or-lose-it — the conservative answer —
   * instead of an uncapped liability nobody typed.
   */
  carryForwardCapDays: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  encashmentCapDays: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  encashmentMinRetainDays: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  allowNegativeBalance: z.boolean().default(false),
  maxNegativeDays: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"),
  countsHolidaysAndOffs: z.boolean().default(false),
  minNoticeDays: z.number().int().min(0).max(365).default(0),
  maxConsecutiveDays: z.string().regex(/^\d+(\.\d{1,2})?$/).nullish(),
  allowHalfDay: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(9999).default(100),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(2000).nullish(),
});

export async function saveLeaveType(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = leaveTypeSchema.safeParse(input);
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
        code: d.code,
        label: d.label,
        isPaid: d.isPaid,
        accrualMethod: d.accrualMethod,
        annualEntitlementDays: d.annualEntitlementDays,
        accrualRoundToDays: d.accrualRoundToDays,
        probationDays: d.probationDays,
        carryForwardCapDays: d.carryForwardCapDays,
        encashmentCapDays: d.encashmentCapDays,
        encashmentMinRetainDays: d.encashmentMinRetainDays,
        allowNegativeBalance: d.allowNegativeBalance,
        maxNegativeDays: d.maxNegativeDays,
        countsHolidaysAndOffs: d.countsHolidaysAndOffs,
        minNoticeDays: d.minNoticeDays,
        maxConsecutiveDays: d.maxConsecutiveDays ?? null,
        allowHalfDay: d.allowHalfDay,
        displayOrder: d.displayOrder,
        isActive: d.isActive,
        notes: d.notes ?? null,
        updatedAt: new Date(),
      };

      if (d.id) {
        await tx
          .update(leaveTypes)
          .set(values)
          .where(and(eq(leaveTypes.tenantId, ctx.tenant.id), eq(leaveTypes.id, d.id)));
        return d.id;
      }

      const [row] = await tx.insert(leaveTypes).values(values).returning({ id: leaveTypes.id });
      return String(row?.id ?? "");
    });

    if (!id) return { ok: false, error: "The leave type could not be saved." };

    await writeAudit(ctx, {
      action: d.id ? "update" : "create",
      resourceType: "leave_type",
      resourceId: id,
      newValue: {
        code: d.code,
        accrualMethod: d.accrualMethod,
        annualEntitlementDays: d.annualEntitlementDays,
        carryForwardCapDays: d.carryForwardCapDays,
      },
    });

    revalidatePath("/payroll/leave");
    return { ok: true, data: { id } };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

const leavePeriodSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(2).max(60),
  startsOn: z.string().regex(ISO),
  endsOn: z.string().regex(ISO),
});

export async function saveLeavePeriod(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = leavePeriodSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    if (d.endsOn <= d.startsOn) {
      return { ok: false, error: "A leave year has to end after it starts." };
    }

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      if (d.id) {
        /**
         * 🔴 A CLOSED PERIOD IS NOT EDITABLE. Its carry-forward entries
         * already exist in the following year; moving its end date would
         * make them refer to a span nobody carried anything for, and the
         * ledger is append-only so they cannot be revised.
         */
        const [existing] = await tx
          .select({ isClosed: leavePeriods.isClosed })
          .from(leavePeriods)
          .where(and(eq(leavePeriods.tenantId, ctx.tenant.id), eq(leavePeriods.id, d.id)))
          .limit(1);
        if (existing?.isClosed) return "";

        await tx
          .update(leavePeriods)
          .set({ label: d.label, startsOn: d.startsOn, endsOn: d.endsOn, updatedAt: new Date() })
          .where(and(eq(leavePeriods.tenantId, ctx.tenant.id), eq(leavePeriods.id, d.id)));
        return d.id;
      }

      const [row] = await tx
        .insert(leavePeriods)
        .values({
          tenantId: ctx.tenant.id,
          label: d.label,
          startsOn: d.startsOn,
          endsOn: d.endsOn,
        })
        .returning({ id: leavePeriods.id });
      return String(row?.id ?? "");
    });

    if (!id) {
      return {
        ok: false,
        error:
          "That leave year is already closed. Its carry-forward entries are in the next year and the ledger cannot be rewritten, so raise a correction there instead.",
      };
    }

    await writeAudit(ctx, {
      action: d.id ? "update" : "create",
      resourceType: "leave_period",
      resourceId: id,
      newValue: { label: d.label, startsOn: d.startsOn, endsOn: d.endsOn },
    });

    revalidatePath("/payroll/leave");
    return { ok: true, data: { id } };
  } catch (error) {
    /**
     * ⚠️ THE EXCLUSION CONSTRAINT IS WHAT ACTUALLY PREVENTS TWO LEAVE
     * YEARS COVERING ONE AUGUST. This turns its error into a sentence
     * somebody can act on rather than a constraint name.
     */
    const message = error instanceof Error ? error.message : "";
    if (message.includes("leave_periods_no_overlap")) {
      return {
        ok: false,
        error:
          "Those dates overlap a leave year that already exists. Two leave years covering one date means the accrual credits that month twice — once in each — so check whether the end date should be a day earlier.",
      };
    }
    return toSalesActionError(error, "leave");
  }
}

const holidaySchema = z.object({
  onDate: z.string().regex(ISO),
  label: z.string().trim().min(2).max(120),
  workStateCode: z.string().trim().length(2).toUpperCase().nullish(),
  isRestricted: z.boolean().default(false),
});

export async function saveHoliday(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = holidaySchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(holidayCalendar)
        .values({
          tenantId: ctx.tenant.id,
          onDate: d.onDate,
          label: d.label,
          workStateCode: d.workStateCode ?? null,
          isRestricted: d.isRestricted,
          createdBy: ctx.user.id,
        })
        .onConflictDoNothing()
        .returning({ id: holidayCalendar.id });
      return String(row?.id ?? "");
    });

    if (!id) return { ok: false, error: "That date is already on the holiday list." };

    revalidatePath("/payroll/leave");
    return { ok: true, data: { id } };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/**
 * ⭐ THE STARTER POLICY, SO A TENANT IS NOT ASKED TO INVENT LEAVE FROM
 * FIRST PRINCIPLES.
 *
 * ⚠️ A SEED, NOT A DEFAULT. Rows are written once and are then the
 * tenant's to change; a default re-applied on every load silently undoes
 * whatever they corrected.
 */
export async function seedLeaveSetup(): Promise<
  ActionResult<{ types: number; periods: number; note: string }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    const today = new Date().toISOString().slice(0, 10);
    const year = proposedLeaveYear(today);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      let types = 0;
      for (const t of STARTER_LEAVE_TYPES) {
        const inserted = await tx
          .insert(leaveTypes)
          .values({
            tenantId: ctx.tenant.id,
            code: t.code,
            label: t.label,
            isPaid: t.isPaid,
            accrualMethod: t.accrualMethod,
            annualEntitlementDays: t.annualEntitlementDays,
            carryForwardCapDays: t.carryForwardCapDays,
            encashmentCapDays: t.encashmentCapDays,
            countsHolidaysAndOffs: t.countsHolidaysAndOffs,
            probationDays: t.probationDays,
            displayOrder: t.displayOrder,
            notes: t.notes,
          })
          .onConflictDoNothing()
          .returning({ id: leaveTypes.id });
        types += inserted.length;
      }

      const inserted = await tx
        .insert(leavePeriods)
        .values({
          tenantId: ctx.tenant.id,
          label: year.label,
          startsOn: year.startsOn,
          endsOn: year.endsOn,
        })
        .onConflictDoNothing()
        .returning({ id: leavePeriods.id });

      return { types, periods: inserted.length };
    });

    revalidatePath("/payroll/leave");
    return {
      ok: true,
      data: {
        ...result,
        note:
          "These are ordinary Indian practice, not a statutory minimum and not legal advice. Earned leave for a factory comes from section 79 of the Factories Act; everybody else is covered by their State's Shops and Establishments Act, and those differ. Check every entitlement and every cap against the Act your establishment is registered under before the first accrual.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

export async function listLeaveSetup(): Promise<
  ActionResult<{
    types: ReadonlyArray<Record<string, unknown>>;
    periods: ReadonlyArray<Record<string, unknown>>;
    holidays: ReadonlyArray<Record<string, unknown>>;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const types = await tx
        .select()
        .from(leaveTypes)
        .where(eq(leaveTypes.tenantId, ctx.tenant.id))
        .orderBy(asc(leaveTypes.displayOrder), asc(leaveTypes.code));
      const periods = await tx
        .select()
        .from(leavePeriods)
        .where(eq(leavePeriods.tenantId, ctx.tenant.id))
        .orderBy(desc(leavePeriods.startsOn))
        .limit(20);
      const holidays = await tx
        .select()
        .from(holidayCalendar)
        .where(eq(holidayCalendar.tenantId, ctx.tenant.id))
        .orderBy(asc(holidayCalendar.onDate))
        .limit(400);
      return { types, periods, holidays };
    });

    return {
      ok: true,
      data: {
        types: data.types as ReadonlyArray<Record<string, unknown>>,
        periods: data.periods as ReadonlyArray<Record<string, unknown>>,
        holidays: data.holidays as ReadonlyArray<Record<string, unknown>>,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/* ================================================================== */
/* ② ACCRUAL — DECISION ①                                              */
/* ================================================================== */

const accrualSchema = z.object({
  periodId: z.string().uuid(),
  /** Accrue up to and including this date. Defaults to today. */
  asOf: z.string().regex(ISO).optional(),
});

/**
 * ⭐⭐⭐ THE ACCRUAL RUN.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT IS SAFE TO RUN TWICE, AND THAT IS NOT A CONVENIENCE
 * ══════════════════════════════════════════════════════════════════════
 * An accrual run is exactly the kind of job that gets triggered twice: a
 * cron that retried, an admin who clicked because the first click seemed
 * slow, a deploy that replayed a queue. Two things make the second run a
 * no-op:
 *
 *   ⭐ THE ARITHMETIC IS CUMULATIVE. `accrueTo()` computes the
 *      entitlement earned TO DATE and subtracts what is already in the
 *      ledger, so a second run for the same month computes a delta of
 *      zero and writes nothing.
 *
 *   ⭐ AND `leave_ledger_accrual_once` REFUSES A DUPLICATE ANYWAY. Belt
 *      to the braces, because the arithmetic depends on reading the
 *      ledger correctly and the index does not.
 *
 * ⚠️ IT ALSO CATCHES UP. A month the job missed is written by the next
 * run, because the target does not care how many entries preceded it.
 *
 * 🔴 AND IT NEVER WRITES A NEGATIVE ACCRUAL. Somebody whose leaving date
 * was backdated after the accrual ran is OVER-accrued; that is reported
 * in `overAccrued` and left for a human, because taking days back that an
 * employee has already been told about — and may already have taken — is
 * a decision with a name on it, not a background job.
 */
export async function runLeaveAccrual(
  input: unknown,
): Promise<
  ActionResult<{
    entriesWritten: number;
    employeesTouched: number;
    overAccruedEmployees: number;
    note: string;
  }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = accrualSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;
    const asOf = d.asOf ?? new Date().toISOString().slice(0, 10);

    const outcome = await withTenant(ctx.tenant.id, async (tx): Promise<Outcome<{ entriesWritten: number; employeesTouched: number; overAccruedEmployees: number }>> => {
      const [period] = await tx
        .select()
        .from(leavePeriods)
        .where(and(eq(leavePeriods.tenantId, ctx.tenant.id), eq(leavePeriods.id, d.periodId)))
        .limit(1);
      if (!period) return { error: "No such leave year." as const };
      if (period.isClosed) {
        return {
          error:
            "That leave year is closed. Its balances have already been carried forward, so accruing into it now would credit days that were never carried." as const,
        };
      }

      const periodFacts = {
        startsOn: String(period.startsOn),
        endsOn: String(period.endsOn),
      };

      const types = await tx
        .select()
        .from(leaveTypes)
        .where(
          and(
            eq(leaveTypes.tenantId, ctx.tenant.id),
            eq(leaveTypes.isActive, true),
          ),
        );

      /**
       * ⚠️ EVERYBODY WHO WAS ON THE ROLLS AT ANY POINT INSIDE THE PERIOD,
       * not "everybody active today". Somebody who left in November
       * earned seven months of leave, and excluding them because they are
       * inactive now is how a final settlement goes short. The same
       * argument `computeRun()` makes about payslips.
       */
      const staff = await tx
        .select({
          id: employees.id,
          joinedOn: employees.joinedOn,
          leftOn: employees.leftOn,
        })
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, ctx.tenant.id),
            lte(employees.joinedOn, periodFacts.endsOn),
            sql`(${employees.leftOn} IS NULL OR ${employees.leftOn} >= ${periodFacts.startsOn}::date)`,
          ),
        );

      /**
       * ⭐ ONE QUERY FOR EVERY EXISTING ACCRUAL IN THE PERIOD, NOT ONE
       * PER EMPLOYEE PER TYPE PER MONTH. Four hundred people, four types
       * and twelve months is nineteen thousand round trips the other way.
       */
      const existing = await tx
        .select({
          employeeId: leaveLedger.employeeId,
          leaveTypeId: leaveLedger.leaveTypeId,
          effectiveOn: leaveLedger.effectiveOn,
          daysDelta: leaveLedger.daysDelta,
        })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.tenantId, ctx.tenant.id),
            eq(leaveLedger.periodId, d.periodId),
            eq(leaveLedger.kind, "accrual"),
          ),
        );

      const accruedByKey = new Map<string, number>();
      const datesByKey = new Map<string, Set<string>>();
      for (const row of existing) {
        const key = `${row.employeeId}:${row.leaveTypeId}`;
        accruedByKey.set(key, (accruedByKey.get(key) ?? 0) + parseDaysOrZero(row.daysDelta));
        const dates = datesByKey.get(key) ?? new Set<string>();
        dates.add(String(row.effectiveOn));
        datesByKey.set(key, dates);
      }

      const monthEnds = monthEndsIn(periodFacts, asOf);
      const rows: (typeof leaveLedger.$inferInsert)[] = [];
      const touched = new Set<string>();
      let overAccrued = 0;

      for (const type of types) {
        const policy = policyFromRow({
          accrualMethod: type.accrualMethod,
          annualEntitlementDays: type.annualEntitlementDays,
          accrualRoundToDays: type.accrualRoundToDays,
          probationDays: type.probationDays,
        });
        if (policy.method === "none" || policy.annualEntitlementCentidays <= 0) continue;

        for (const person of staff) {
          const key = `${person.id}:${type.id}`;
          let already = accruedByKey.get(key) ?? 0;
          const seen = datesByKey.get(key) ?? new Set<string>();

          for (const monthEnd of monthEnds) {
            if (seen.has(monthEnd)) continue;

            const outcome = accrueTo({
              policy,
              employee: {
                joinedOn: String(person.joinedOn),
                leftOn: person.leftOn === null ? null : String(person.leftOn),
              },
              period: periodFacts,
              asOf: monthEnd,
              alreadyAccruedCentidays: already,
            });

            if (outcome.overAccruedCentidays > 0) overAccrued++;
            if (outcome.deltaCentidays <= 0) continue;

            rows.push({
              tenantId: ctx.tenant.id,
              employeeId: person.id,
              leaveTypeId: type.id,
              periodId: d.periodId,
              kind: "accrual",
              daysDelta: formatDays(outcome.deltaCentidays),
              effectiveOn: monthEnd,
              note: outcome.workingNote,
              createdBy: ctx.user.id,
            });
            already += outcome.deltaCentidays;
            touched.add(String(person.id));
          }
        }
      }

      /*
       * ⚠️ ONE INSERT, IN CHUNKS. `onConflictDoNothing` makes the write
       * itself idempotent against `leave_ledger_accrual_once`, so a
       * concurrent second run loses the race rather than raising a 23505
       * that would roll back everything the first one wrote.
       */
      let written = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const done = await tx
          .insert(leaveLedger)
          .values(chunk)
          .onConflictDoNothing()
          .returning({ id: leaveLedger.id });
        written += done.length;
      }

      return {
        entriesWritten: written,
        employeesTouched: touched.size,
        overAccruedEmployees: overAccrued,
      };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "leave_accrual",
      resourceId: d.periodId,
      newValue: { asOf, entries: outcome.entriesWritten },
    });

    revalidatePath("/payroll/leave");
    return {
      ok: true,
      data: {
        ...outcome,
        note:
          outcome.overAccruedEmployees > 0
            ? `${outcome.overAccruedEmployees} employee balances hold more than is now earned — usually somebody whose leaving date was set after the accrual ran. Nothing has been taken back. Raise an adjustment with a note if that is what you mean to do.`
            : "Leave accrues in proportion to the days each person was on the rolls, so a mid-year joiner earns a part year and not a whole one. Running this again writes nothing new.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/* ================================================================== */
/* ③ CLOSING A LEAVE YEAR — DECISION ③                                 */
/* ================================================================== */

const closeSchema = z.object({
  periodId: z.string().uuid(),
  nextPeriodId: z.string().uuid(),
});

/**
 * ⭐⭐ THE CARRY-FORWARD, WHICH IS WHERE THE CAP EITHER EXISTS OR DOES
 * NOT.
 *
 * 🔴 EVERY LAPSED DAY IS AN ENTRY WITH A REASON ON IT. The alternative —
 * simply not carrying the excess — makes the days vanish between two
 * screens, and an employee who asks what happened to their three days
 * gets a shrug. With the entry they get a date, a cap and a sentence.
 *
 * ⚠️ AND A NEGATIVE BALANCE CARRIES IN FULL. A cap limits what an
 * employee may KEEP, not what they OWE; lapsing a debt would write off an
 * overdraft nobody decided to forgive.
 */
export async function closeLeavePeriod(
  input: unknown,
): Promise<ActionResult<{ carried: number; lapsed: number; note: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = closeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(ctx.tenant.id, async (tx): Promise<Outcome<{ carried: number; lapsed: number }>> => {
      const rows = await tx
        .select()
        .from(leavePeriods)
        .where(
          and(
            eq(leavePeriods.tenantId, ctx.tenant.id),
            inArray(leavePeriods.id, [d.periodId, d.nextPeriodId]),
          ),
        );
      const period = rows.find((p) => p.id === d.periodId);
      const next = rows.find((p) => p.id === d.nextPeriodId);
      if (!period || !next) return { error: "No such leave year." as const };
      if (period.isClosed) {
        return {
          error:
            "That leave year is already closed. Closing it again would write a second set of carry-forward entries and double everybody's opening balance." as const,
        };
      }
      if (String(next.startsOn) <= String(period.endsOn)) {
        return { error: "The next leave year has to start after this one ends." as const };
      }

      const entries = await tx
        .select({
          employeeId: leaveLedger.employeeId,
          leaveTypeId: leaveLedger.leaveTypeId,
          kind: leaveLedger.kind,
          daysDelta: leaveLedger.daysDelta,
        })
        .from(leaveLedger)
        .where(
          and(eq(leaveLedger.tenantId, ctx.tenant.id), eq(leaveLedger.periodId, d.periodId)),
        );

      const byKey = new Map<string, LedgerEntryFacts[]>();
      for (const e of entries) {
        const key = `${e.employeeId}:${e.leaveTypeId}`;
        const list = byKey.get(key) ?? [];
        list.push({ kind: e.kind as LeaveEntryKind, daysDelta: String(e.daysDelta) });
        byKey.set(key, list);
      }

      const types = await tx
        .select()
        .from(leaveTypes)
        .where(eq(leaveTypes.tenantId, ctx.tenant.id));
      const typeById = new Map(types.map((t) => [String(t.id), t]));

      const writes: (typeof leaveLedger.$inferInsert)[] = [];
      let carried = 0;
      let lapsed = 0;

      for (const [key, list] of byKey) {
        const [employeeId, leaveTypeId] = key.split(":");
        /*
         * ⚠️ A KEY THAT DOES NOT SPLIT INTO TWO IDS IS A KEY THIS LOOP
         * did not build. Skipping it is right — carrying forward against a
         * guess would credit somebody's balance from a row nobody can
         * trace back, and the ledger is append-only.
         */
        if (!employeeId || !leaveTypeId) continue;
        const type = typeById.get(leaveTypeId);
        if (!type) continue;

        const balance = foldLedger(list);
        if (balance.balanceCentidays === 0) continue;

        const result = carryForward({
          closingCentidays: balance.balanceCentidays,
          capCentidays: parseDays(type.carryForwardCapDays) ?? 0,
        });

        if (result.lapsedCentidays > 0) {
          writes.push({
            tenantId: ctx.tenant.id,
            employeeId,
            leaveTypeId,
            periodId: d.periodId,
            kind: "lapse",
            daysDelta: formatDays(-result.lapsedCentidays),
            effectiveOn: String(period.endsOn),
            note: result.workingNote,
            createdBy: ctx.user.id,
          });
          lapsed++;
        }

        if (result.carriedCentidays !== 0) {
          /**
           * ⚠️ A NEGATIVE CARRY IS AN `adjustment`, NOT A
           * `carry_forward_in`. The sign CHECK on the ledger refuses a
           * negative `carry_forward_in` — deliberately, because "carried
           * forward" reads as a credit everywhere it appears — so a debt
           * crossing the year boundary is recorded as what it is.
           */
          writes.push({
            tenantId: ctx.tenant.id,
            employeeId,
            leaveTypeId,
            periodId: d.nextPeriodId,
            kind: result.carriedCentidays > 0 ? "carry_forward_in" : "adjustment",
            daysDelta: formatDays(result.carriedCentidays),
            effectiveOn: String(next.startsOn),
            note: result.workingNote,
            createdBy: ctx.user.id,
          });
          carried++;
        }
      }

      for (let i = 0; i < writes.length; i += 500) {
        await tx.insert(leaveLedger).values(writes.slice(i, i + 500));
      }

      await tx
        .update(leavePeriods)
        .set({ isClosed: true, closedAt: new Date(), closedBy: ctx.user.id, updatedAt: new Date() })
        .where(and(eq(leavePeriods.tenantId, ctx.tenant.id), eq(leavePeriods.id, d.periodId)));

      return { carried, lapsed };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "leave_period",
      resourceId: d.periodId,
      newValue: { closed: true, ...outcome },
      // ⚠️ Closing a leave year lapses balances irreversibly — the ledger
      // is append-only, so this is the audit row somebody comes back to.
      severity: "warning",
    });

    revalidatePath("/payroll/leave");
    return {
      ok: true,
      data: {
        ...outcome,
        note:
          outcome.lapsed > 0
            ? `${outcome.lapsed} balances were above the carry-forward cap. Every lapsed day is an entry in the ledger with the cap and the date on it, so an employee who asks what happened to them gets an answer.`
            : "Nothing was above a carry-forward cap.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/* ================================================================== */
/* ④ BALANCES — DECISION ②                                             */
/* ================================================================== */

/**
 * ⭐⭐ EVERY BALANCE IN THIS FILE COMES FROM HERE, AND HERE IS A FOLD
 * OVER THE LEDGER.
 *
 * 🔴 THERE IS NO BALANCE COLUMN TO READ AND NONE TO FORGET TO UPDATE. A
 * cached balance that disagrees with its ledger is unarguable with an
 * employee: they have their own list of the days they took.
 */
async function balancesFor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  args: { tenantId: string; periodId: string; employeeIds?: readonly string[] },
) {
  const where = args.employeeIds
    ? and(
        eq(leaveLedger.tenantId, args.tenantId),
        eq(leaveLedger.periodId, args.periodId),
        inArray(leaveLedger.employeeId, [...args.employeeIds]),
      )
    : and(eq(leaveLedger.tenantId, args.tenantId), eq(leaveLedger.periodId, args.periodId));

  const entries = await tx
    .select({
      employeeId: leaveLedger.employeeId,
      leaveTypeId: leaveLedger.leaveTypeId,
      kind: leaveLedger.kind,
      daysDelta: leaveLedger.daysDelta,
    })
    .from(leaveLedger)
    .where(where);

  const byKey = new Map<string, LedgerEntryFacts[]>();
  for (const e of entries) {
    const key = `${e.employeeId}:${e.leaveTypeId}`;
    const list = byKey.get(key) ?? [];
    list.push({ kind: e.kind as LeaveEntryKind, daysDelta: String(e.daysDelta) });
    byKey.set(key, list);
  }

  return new Map([...byKey].map(([key, list]) => [key, foldLedger(list)]));
}

export async function listLeaveBalances(
  input: unknown,
): Promise<ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = z.object({ periodId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Pick a leave year." };
    const periodId = parsed.data.periodId;

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const balances = await balancesFor(tx, { tenantId: ctx.tenant.id, periodId });
      const staff = await tx
        .select({
          id: employees.id,
          employeeCode: employees.employeeCode,
          fullName: employees.fullName,
        })
        .from(employees)
        .where(eq(employees.tenantId, ctx.tenant.id))
        .orderBy(asc(employees.fullName))
        .limit(1000);
      const types = await tx
        .select({ id: leaveTypes.id, code: leaveTypes.code, label: leaveTypes.label })
        .from(leaveTypes)
        .where(eq(leaveTypes.tenantId, ctx.tenant.id))
        .orderBy(asc(leaveTypes.displayOrder));

      const out: Record<string, unknown>[] = [];
      for (const person of staff) {
        for (const type of types) {
          const b = balances.get(`${person.id}:${type.id}`);
          if (!b) continue;
          out.push({
            employeeId: String(person.id),
            employeeCode: String(person.employeeCode),
            fullName: String(person.fullName),
            leaveTypeId: String(type.id),
            code: String(type.code),
            label: String(type.label),
            accruedDays: formatDays(b.accruedCentidays),
            carriedInDays: formatDays(b.carriedInCentidays),
            takenDays: formatDays(b.takenCentidays),
            lapsedDays: formatDays(b.lapsedCentidays),
            balanceDays: formatDays(b.balanceCentidays),
            committedDays: formatDays(b.committedCentidays),
            availableDays: formatDays(b.availableCentidays),
          });
        }
      }
      return out;
    });

    return { ok: true, data: { rows } };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/* ================================================================== */
/* ⑤ APPLYING, AND DECIDING — DECISION ④                               */
/* ================================================================== */

/**
 * ⚠️ THE CALLER'S OWN EMPLOYEE ROW, RESOLVED FROM THE SESSION AND FROM
 * NOTHING ELSE.
 *
 * 🔴 THE TEMPTING VERSION TAKES AN `employeeId` AND CHECKS IT. It reads
 * as safe and is one refactor away from unsafe forever: a `"use server"`
 * export is a URL, and anybody who has loaded the app can POST any uuid
 * to it. `submitLeaveRequest` therefore has no employee parameter at all,
 * which is a change a reviewer sees. The same argument
 * `server/actions/payroll-self.ts` makes about payslips.
 */
async function selfEmployee(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  args: { tenantId: string; userId: string },
) {
  const [row] = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.tenantId, args.tenantId), eq(employees.userId, args.userId)))
    .limit(1);
  return row ?? null;
}

const requestSchema = z.object({
  leaveTypeId: z.string().uuid(),
  fromOn: z.string().regex(ISO),
  toOn: z.string().regex(ISO),
  halfDayStart: z.boolean().default(false),
  halfDayEnd: z.boolean().default(false),
  reason: z.string().trim().max(1000).nullish(),
});

export async function submitLeaveRequest(
  input: unknown,
): Promise<ActionResult<{ id: string; days: string; note: string }>> {
  try {
    const ctx = await requirePermission(REQUEST);
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(ctx.tenant.id, async (tx): Promise<Outcome<{ id: string; days: string; note: string }>> => {
      const me = await selfEmployee(tx, { tenantId: ctx.tenant.id, userId: ctx.user.id });
      if (!me) {
        return {
          error:
            "Your sign-in is not linked to an employee record, so there is nothing to book leave against. Ask whoever administers payroll to link them." as const,
        };
      }

      const [type] = await tx
        .select()
        .from(leaveTypes)
        .where(and(eq(leaveTypes.tenantId, ctx.tenant.id), eq(leaveTypes.id, d.leaveTypeId)))
        .limit(1);
      if (!type || !type.isActive) return { error: "That leave type is not available." as const };

      const [period] = await tx
        .select()
        .from(leavePeriods)
        .where(
          and(
            eq(leavePeriods.tenantId, ctx.tenant.id),
            lte(leavePeriods.startsOn, d.fromOn),
            gte(leavePeriods.endsOn, d.fromOn),
          ),
        )
        .limit(1);
      if (!period) {
        return {
          error:
            "There is no leave year covering those dates, so the days cannot be counted against a balance. Set the leave year up first." as const,
        };
      }

      const holidayRows = await tx
        .select({ onDate: holidayCalendar.onDate, state: holidayCalendar.workStateCode })
        .from(holidayCalendar)
        .where(
          and(
            eq(holidayCalendar.tenantId, ctx.tenant.id),
            gte(holidayCalendar.onDate, d.fromOn),
            lte(holidayCalendar.onDate, d.toOn),
          ),
        );

      /*
       * ⚠️ A HOLIDAY LIST WITH NO STATE APPLIES EVERYWHERE; one with a
       * state applies only to people who work there. Ignoring the state
       * would give a Bengaluru employee Maharashtra's Gudi Padwa.
       */
      const holidays = holidayRows
        .filter((h) => h.state === null || h.state === me.workStateCode)
        .map((h) => String(h.onDate));

      const countInput = {
        fromOn: d.fromOn,
        toOn: d.toOn,
        halfDayStart: d.halfDayStart,
        halfDayEnd: d.halfDayEnd,
        countsHolidaysAndOffs: type.countsHolidaysAndOffs,
        weeklyOffDays: DEFAULT_WEEKLY_OFF_DAYS,
        holidays,
      };
      const count = countRequestDays(countInput);
      if (count.problems.length > 0) {
        return { error: count.problems[0] ?? "Those dates do not work." };
      }

      const balances = await balancesFor(tx, {
        tenantId: ctx.tenant.id,
        periodId: String(period.id),
        employeeIds: [String(me.id)],
      });
      const balance = balances.get(`${me.id}:${type.id}`);

      const today = new Date().toISOString().slice(0, 10);
      const noticeDays = Math.max(
        0,
        Math.round(
          (Date.parse(`${d.fromOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
        ),
      );

      const policyProblems = checkRequestPolicy({
        requestedCentidays: count.chargeableCentidays,
        availableCentidays: balance?.availableCentidays ?? 0,
        allowNegativeBalance: type.allowNegativeBalance,
        maxNegativeCentidays: parseDays(type.maxNegativeDays) ?? 0,
        maxConsecutiveCentidays: parseDays(type.maxConsecutiveDays),
        minNoticeDays: type.minNoticeDays,
        allowHalfDay: type.allowHalfDay,
        usesHalfDay: d.halfDayStart || d.halfDayEnd,
        noticeDays,
        isPaid: type.isPaid,
      });
      if (policyProblems.length > 0) {
        return { error: policyProblems[0] ?? "That application cannot be made." };
      }

      const [row] = await tx
        .insert(leaveRequests)
        .values({
          tenantId: ctx.tenant.id,
          employeeId: me.id,
          leaveTypeId: type.id,
          fromOn: d.fromOn,
          toOn: d.toOn,
          halfDayStart: d.halfDayStart,
          halfDayEnd: d.halfDayEnd,
          days: formatDays(count.chargeableCentidays),
          status: "submitted",
          reason: d.reason ?? null,
          submittedAt: new Date(),
          createdBy: ctx.user.id,
        })
        .returning({ id: leaveRequests.id });

      return {
        id: String(row?.id ?? ""),
        days: formatDays(count.chargeableCentidays),
        note: count.workingNote,
      };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };
    if (!outcome.id) return { ok: false, error: "The application could not be saved." };

    revalidatePath("/payroll/leave");
    return { ok: true, data: outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("leave_requests_no_overlap")) {
      return {
        ok: false,
        error:
          "You already have leave applied for or approved across some of those dates. Two applications over one day would take the days out of your balance twice, so cancel the other one first.",
      };
    }
    return toSalesActionError(error, "leave");
  }
}

const decideSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(1000).optional(),
});

/**
 * ⭐⭐⭐ DECISION ④, IN ONE FUNCTION.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 APPROVING WRITES A `commitment`, NOT A `taken`
 * ══════════════════════════════════════════════════════════════════════
 * The balance does not move. What moves is `available`, so nobody can
 * approve a second application against the same remaining days.
 *
 * ⚠️ THE TEMPTING SIMPLIFICATION IS TO SPEND THE DAYS HERE. It is one
 * fewer step and it is wrong in a way that is very hard to unpick: an
 * employee who cancels their holiday has lost the days until somebody
 * notices, and the leave register says they were absent on days they
 * came in and worked. The ledger's `leave_ledger_taken_from_attendance`
 * CHECK refuses the shortcut outright, which is deliberate — a rule that
 * lives only in this function is a rule the next handler does not have.
 */
export async function decideLeaveRequest(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string; note: string }>> {
  try {
    const ctx = await requirePermission(APPROVE);
    const parsed = decideSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    if (d.decision === "rejected" && (d.note ?? "").trim().length < 3) {
      return {
        ok: false,
        error:
          "A refusal needs a reason. It is the thing an employee escalates, and the person who has to answer for it in three months is not always the person who clicked.",
      };
    }

    const outcome = await withTenant(ctx.tenant.id, async (tx): Promise<Outcome<{ status: string; committed: boolean }>> => {
      const [request] = await tx
        .select()
        .from(leaveRequests)
        .where(and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.id, d.id)))
        .limit(1);
      if (!request) return { error: "No such leave application." as const };
      if (request.status !== "submitted") {
        return {
          error: `That application is already ${request.status}. Decide it once.` as const,
        };
      }

      /**
       * 🔴 NOBODY APPROVES THEIR OWN LEAVE. `leave.approve` is a real
       * key and a person may legitimately hold it — an HR manager, an
       * owner — and holding it does not make them the right person to
       * sign off their own absence. Same argument as the two stock-count
       * keys and the two payroll keys.
       */
      const [me] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(eq(employees.tenantId, ctx.tenant.id), eq(employees.userId, ctx.user.id)),
        )
        .limit(1);
      if (me && String(me.id) === String(request.employeeId)) {
        return {
          error:
            "You cannot approve your own leave. Ask somebody else who holds the approval permission to decide it." as const,
        };
      }

      await tx
        .update(leaveRequests)
        .set({
          status: d.decision,
          decidedAt: new Date(),
          decidedBy: ctx.user.id,
          decisionNote: d.note ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.id, d.id)));

      if (d.decision !== "approved") return { status: d.decision, committed: false };

      const [period] = await tx
        .select({ id: leavePeriods.id })
        .from(leavePeriods)
        .where(
          and(
            eq(leavePeriods.tenantId, ctx.tenant.id),
            lte(leavePeriods.startsOn, String(request.fromOn)),
            gte(leavePeriods.endsOn, String(request.fromOn)),
          ),
        )
        .limit(1);
      if (!period) {
        return {
          error:
            "There is no leave year covering those dates any more, so the days cannot be reserved against a balance." as const,
        };
      }

      const [type] = await tx
        .select({ isPaid: leaveTypes.isPaid, accrualMethod: leaveTypes.accrualMethod })
        .from(leaveTypes)
        .where(eq(leaveTypes.id, request.leaveTypeId))
        .limit(1);

      /*
       * ⚠️ AN UNPAID TYPE RESERVES NOTHING. Loss of pay has no balance to
       * commit against, and writing a commitment for it would show an
       * employee a negative available figure on a type that never had a
       * positive one.
       */
      const reserves = Boolean(type?.isPaid) && type?.accrualMethod !== "none";
      if (reserves) {
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenant.id,
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          periodId: period.id,
          kind: "commitment",
          daysDelta: formatDays(-(parseDaysOrZero(request.days))),
          effectiveOn: String(request.fromOn),
          requestId: request.id,
          note: "Reserved by an approval. The balance moves when the attendance for these days is recorded.",
          createdBy: ctx.user.id,
        });
      }

      return { status: d.decision, committed: reserves };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "leave_request",
      resourceId: d.id,
      newValue: { status: outcome.status },
    });

    revalidatePath("/payroll/leave");
    return {
      ok: true,
      data: {
        id: d.id,
        status: outcome.status,
        note: outcome.committed
          ? "The days are reserved, not spent. The balance moves when the attendance for them is recorded — an approved leave that was never taken is not an absence."
          : "Recorded.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/**
 * ⚠️ CANCELLING RELEASES THE RESERVATION AND TOUCHES NO BALANCE, because
 * the approval never took one. That is the whole payoff of decision ④:
 * cancelling a holiday is one entry, not a reversal of a spend that has
 * to be found first.
 */
export async function cancelLeaveRequest(
  input: unknown,
): Promise<ActionResult<{ id: string; note: string }>> {
  try {
    const ctx = await requirePermission(REQUEST);
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const id = parsed.data.id;

    const outcome = await withTenant(ctx.tenant.id, async (tx): Promise<Outcome<{ released: boolean }>> => {
      const [request] = await tx
        .select()
        .from(leaveRequests)
        .where(and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.id, id)))
        .limit(1);
      if (!request) return { error: "No such leave application." as const };
      if (request.status === "cancelled") return { error: "It is already cancelled." as const };
      if (request.status === "rejected") {
        return { error: "A refused application does not need cancelling." as const };
      }

      /**
       * 🔴 YOUR OWN, OR SOMEBODY ELSE'S ONLY WITH THE APPROVAL KEY.
       * `leave.request` is held by everybody, so without this check any
       * employee could cancel any colleague's holiday.
       */
      const [me] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(and(eq(employees.tenantId, ctx.tenant.id), eq(employees.userId, ctx.user.id)))
        .limit(1);
      const isMine = me && String(me.id) === String(request.employeeId);
      if (!isMine && !can({ role: ctx.role, overrides: ctx.user.permissionOverrides }, APPROVE)) {
        return { error: "That is not your leave application." as const };
      }

      /*
       * ⚠️ NOT IF IT HAS ALREADY BEEN TAKEN. A `taken` entry exists only
       * because attendance said the person was away, and cancelling the
       * paperwork afterwards would leave the register saying they were
       * absent against nothing.
       */
      const [taken] = await tx
        .select({ id: leaveLedger.id })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.tenantId, ctx.tenant.id),
            eq(leaveLedger.requestId, id),
            eq(leaveLedger.kind, "taken"),
          ),
        )
        .limit(1);
      if (taken) {
        return {
          error:
            "Some of those days have already been recorded as taken, so the application cannot be cancelled. Correct the attendance for those days instead." as const,
        };
      }

      const commitments = await tx
        .select({
          daysDelta: leaveLedger.daysDelta,
          employeeId: leaveLedger.employeeId,
          leaveTypeId: leaveLedger.leaveTypeId,
          periodId: leaveLedger.periodId,
        })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.tenantId, ctx.tenant.id),
            eq(leaveLedger.requestId, id),
            eq(leaveLedger.kind, "commitment"),
          ),
        );
      const released = await tx
        .select({ daysDelta: leaveLedger.daysDelta })
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.tenantId, ctx.tenant.id),
            eq(leaveLedger.requestId, id),
            eq(leaveLedger.kind, "commitment_release"),
          ),
        );

      const outstanding =
        commitments.reduce((t, c) => t + parseDaysOrZero(c.daysDelta), 0) +
        released.reduce((t, r) => t + parseDaysOrZero(r.daysDelta), 0);

      if (outstanding < 0 && commitments[0]) {
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenant.id,
          employeeId: commitments[0].employeeId,
          leaveTypeId: commitments[0].leaveTypeId,
          periodId: commitments[0].periodId,
          kind: "commitment_release",
          daysDelta: formatDays(-outstanding),
          effectiveOn: String(request.fromOn),
          requestId: id,
          note: "The application was cancelled, so the reserved days go back to the available balance.",
          createdBy: ctx.user.id,
        });
      }

      await tx
        .update(leaveRequests)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.id, id)));

      return { released: outstanding < 0 };
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    revalidatePath("/payroll/leave");
    return {
      ok: true,
      data: {
        id,
        note: outcome.released
          ? "The reserved days are back in the available balance. Nothing was ever deducted, because an approval reserves days and does not spend them."
          : "Cancelled.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

export async function listLeaveRequests(
  input: unknown,
): Promise<ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = z
      .object({ status: z.enum(["submitted", "approved", "rejected", "cancelled"]).optional() })
      .safeParse(input ?? {});
    const status = parsed.success ? parsed.data.status : undefined;

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: leaveRequests.id,
          employeeId: leaveRequests.employeeId,
          fullName: employees.fullName,
          employeeCode: employees.employeeCode,
          code: leaveTypes.code,
          label: leaveTypes.label,
          fromOn: leaveRequests.fromOn,
          toOn: leaveRequests.toOn,
          days: leaveRequests.days,
          status: leaveRequests.status,
          reason: leaveRequests.reason,
          decisionNote: leaveRequests.decisionNote,
        })
        .from(leaveRequests)
        .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
        .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
        .where(
          status
            ? and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.status, status))
            : eq(leaveRequests.tenantId, ctx.tenant.id),
        )
        .orderBy(desc(leaveRequests.fromOn))
        .limit(300),
    );

    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/**
 * ⭐ THE EMPLOYEE'S OWN VIEW, AND IT TAKES NO ARGUMENTS.
 *
 * 🔴 THE SAME CONTROL AS `myPayslips()`: a function with no parameter
 * cannot be given somebody else's id by any future edit that does not
 * first change its signature, and that is a change a reviewer sees.
 * `leave.read` — the whole register — is deliberately not what gates it,
 * because that key is exactly the one an ordinary employee does not have.
 */
export async function myLeaveOverview(): Promise<
  ActionResult<{
    balances: ReadonlyArray<Record<string, unknown>>;
    requests: ReadonlyArray<Record<string, unknown>>;
    linked: boolean;
  }>
> {
  try {
    const ctx = await requirePermission(REQUEST);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const me = await selfEmployee(tx, { tenantId: ctx.tenant.id, userId: ctx.user.id });
      if (!me) return { balances: [], requests: [], linked: false };

      const [period] = await tx
        .select({ id: leavePeriods.id })
        .from(leavePeriods)
        .where(and(eq(leavePeriods.tenantId, ctx.tenant.id), eq(leavePeriods.isClosed, false)))
        .orderBy(desc(leavePeriods.startsOn))
        .limit(1);

      const types = await tx
        .select({ id: leaveTypes.id, code: leaveTypes.code, label: leaveTypes.label })
        .from(leaveTypes)
        .where(and(eq(leaveTypes.tenantId, ctx.tenant.id), eq(leaveTypes.isActive, true)))
        .orderBy(asc(leaveTypes.displayOrder));

      const balances = period
        ? await balancesFor(tx, {
            tenantId: ctx.tenant.id,
            periodId: String(period.id),
            employeeIds: [String(me.id)],
          })
        : new Map();

      const requests = await tx
        .select({
          id: leaveRequests.id,
          code: leaveTypes.code,
          fromOn: leaveRequests.fromOn,
          toOn: leaveRequests.toOn,
          days: leaveRequests.days,
          status: leaveRequests.status,
          decisionNote: leaveRequests.decisionNote,
        })
        .from(leaveRequests)
        .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
        /* 🔴 THE WHERE CLAUSE IS THE AUTHORISATION. It is not a filter. */
        .where(
          and(eq(leaveRequests.tenantId, ctx.tenant.id), eq(leaveRequests.employeeId, me.id)),
        )
        .orderBy(desc(leaveRequests.fromOn))
        .limit(50);

      return {
        linked: true,
        balances: types.map((t) => {
          const b = balances.get(`${me.id}:${t.id}`);
          return {
            leaveTypeId: String(t.id),
            code: String(t.code),
            label: String(t.label),
            balanceDays: formatDays(b?.balanceCentidays ?? 0),
            committedDays: formatDays(b?.committedCentidays ?? 0),
            availableDays: formatDays(b?.availableCentidays ?? 0),
          };
        }),
        requests: requests as ReadonlyArray<Record<string, unknown>>,
      };
    });

    return { ok: true, data };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/* ================================================================== */
/* ⑥ ATTENDANCE — THE ONLY THING THAT SPENDS DAYS OR MONEY             */
/* ================================================================== */

const attendanceSchema = z.object({
  rows: z
    .array(
      z.object({
        employeeId: z.string().uuid(),
        onDate: z.string().regex(ISO),
        status: z.enum([
          "present",
          "on_duty",
          "weekly_off",
          "holiday",
          "paid_leave",
          "unpaid_leave",
          "absent",
        ]),
        lopFraction: z.string().regex(/^[01](\.\d{1,2})?$/).optional(),
        leaveTypeId: z.string().uuid().nullish(),
        requestId: z.string().uuid().nullish(),
        note: z.string().trim().max(500).nullish(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * ⭐⭐⭐ RECORDING WHAT ACTUALLY HAPPENED, WHICH IS THE ONLY THING THAT
 * MOVES A BALANCE OR A PAYSLIP.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE WRITE BATCH 50 IS WAITING FOR
 * ══════════════════════════════════════════════════════════════════════
 * `staff_attendance.lop_fraction` summed over a payroll period is
 * `lopDays`. Until this table has rows in it, `attendance: []` in the
 * payroll board is not even wrong — there is nothing to pass.
 *
 * ⚠️ AN ATTENDANCE ROW IS UPSERTED, NOT APPENDED. A wrong "present" is a
 * data-entry error rather than a business event, and a correction loop
 * over a thirty-day grid has to be possible. What stops a correction
 * being made AFTER the money moved is the database trigger
 * `ordence_guard_staff_attendance_frozen`, which refuses any write to a
 * date inside an approved or posted payroll run — and refuses it with the
 * run number and the real remedy in the message.
 */
export async function recordAttendance(
  input: unknown,
): Promise<ActionResult<{ written: number; ledgerEntries: number; note: string }>> {
  try {
    const ctx = await requirePermission(RECORD);
    const parsed = attendanceSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      let written = 0;
      let ledgerEntries = 0;

      for (const row of d.rows) {
        const lop =
          row.lopFraction !== undefined
            ? row.lopFraction
            : formatDays(defaultLopFraction(row.status));

        const [saved] = await tx
          .insert(staffAttendance)
          .values({
            tenantId: ctx.tenant.id,
            employeeId: row.employeeId,
            onDate: row.onDate,
            status: row.status,
            lopFraction: lop,
            leaveTypeId: row.leaveTypeId ?? null,
            requestId: row.requestId ?? null,
            note: row.note ?? null,
            createdBy: ctx.user.id,
          })
          .onConflictDoUpdate({
            target: [
              staffAttendance.tenantId,
              staffAttendance.employeeId,
              staffAttendance.onDate,
            ],
            set: {
              status: row.status,
              lopFraction: lop,
              leaveTypeId: row.leaveTypeId ?? null,
              requestId: row.requestId ?? null,
              note: row.note ?? null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: staffAttendance.id });
        if (!saved) continue;
        written++;

        /*
         * ⭐ DECISION ④, THE OTHER HALF. A paid-leave day spends the
         * balance — and it spends only the part of the day that was not
         * loss of pay, which is how "a full day taken against half a day
         * of balance" comes out right.
         */
        if (row.status !== "paid_leave" || !row.leaveTypeId) continue;

        const [period] = await tx
          .select({ id: leavePeriods.id })
          .from(leavePeriods)
          .where(
            and(
              eq(leavePeriods.tenantId, ctx.tenant.id),
              lte(leavePeriods.startsOn, row.onDate),
              gte(leavePeriods.endsOn, row.onDate),
            ),
          )
          .limit(1);
        if (!period) continue;

        const chargeable = 100 - parseDaysOrZero(lop);
        if (chargeable <= 0) continue;

        /*
         * ⚠️ ONE `taken` PER ATTENDANCE ROW. `attendance_id` is what the
         * ledger's CHECK requires and what makes a second recording of
         * the same day findable rather than silently additive.
         */
        const [already] = await tx
          .select({ id: leaveLedger.id })
          .from(leaveLedger)
          .where(
            and(
              eq(leaveLedger.tenantId, ctx.tenant.id),
              eq(leaveLedger.attendanceId, saved.id),
              eq(leaveLedger.kind, "taken"),
            ),
          )
          .limit(1);
        if (already) continue;

        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenant.id,
          employeeId: row.employeeId,
          leaveTypeId: row.leaveTypeId,
          periodId: period.id,
          kind: "taken",
          daysDelta: formatDays(-chargeable),
          effectiveOn: row.onDate,
          requestId: row.requestId ?? null,
          attendanceId: saved.id,
          note: "Recorded from the attendance register.",
          createdBy: ctx.user.id,
        });
        ledgerEntries++;

        /* And the reservation that approval made is released for this day. */
        if (row.requestId) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenant.id,
            employeeId: row.employeeId,
            leaveTypeId: row.leaveTypeId,
            periodId: period.id,
            kind: "commitment_release",
            daysDelta: formatDays(chargeable),
            effectiveOn: row.onDate,
            requestId: row.requestId,
            note: "The day has been taken, so it is no longer reserved.",
            createdBy: ctx.user.id,
          });
          ledgerEntries++;
        }
      }

      return { written, ledgerEntries };
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "staff_attendance",
      resourceId: ctx.tenant.id,
      newValue: { days: outcome.written },
    });

    revalidatePath("/payroll/leave");
    revalidatePath("/payroll");
    return {
      ok: true,
      data: {
        ...outcome,
        note:
          "Loss of pay recorded here is what the payroll run reads. A day marked absent costs the employee that day's pay, so check the register before the wage bill is approved — after that it is frozen.",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("staff_attendance_status_fraction_coherent")) {
      return {
        ok: false,
        error:
          "A weekly off or a declared holiday cannot carry loss of pay, and an absence cannot be paid in full. Check the loss-of-pay column against the day's status.",
      };
    }
    if (message.includes("is already approved") || message.includes("is already posted")) {
      return { ok: false, error: message };
    }
    return toSalesActionError(error, "leave");
  }
}

export async function listAttendance(
  input: unknown,
): Promise<ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = z
      .object({ fromOn: z.string().regex(ISO), toOn: z.string().regex(ISO) })
      .safeParse(input);
    if (!parsed.success) return { ok: false, error: "Pick a date range." };
    const d = parsed.data;

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          id: staffAttendance.id,
          employeeId: staffAttendance.employeeId,
          employeeCode: employees.employeeCode,
          fullName: employees.fullName,
          onDate: staffAttendance.onDate,
          status: staffAttendance.status,
          lopFraction: staffAttendance.lopFraction,
          note: staffAttendance.note,
        })
        .from(staffAttendance)
        .innerJoin(employees, eq(employees.id, staffAttendance.employeeId))
        .where(
          and(
            eq(staffAttendance.tenantId, ctx.tenant.id),
            gte(staffAttendance.onDate, d.fromOn),
            lte(staffAttendance.onDate, d.toOn),
          ),
        )
        .orderBy(asc(staffAttendance.onDate), asc(employees.fullName))
        .limit(2000),
    );

    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}

/* ================================================================== */
/* ⑦ THE HANDOVER TO PAYROLL — WHAT BATCH 50 CALLS                     */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE ONE-LINE FIX FOR THE HARDCODED `attendance: []`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT BATCH 50 HAS TO DO, EXACTLY
 * ══════════════════════════════════════════════════════════════════════
 * `components/payroll/payroll-run-board.tsx` calls
 * `computePayrollRun({ runId, attendance: [] })`. It replaces the empty
 * array with the `rows` this returns, which is already the shape
 * `server/payroll/run.ts#AttendanceInput` accepts and which
 * `server/actions/payroll.ts#computeSchema` already validates.
 *
 * ⚠️ THE GUARD HERE IS `payroll.manage` AND NOT A LEAVE KEY, ON PURPOSE.
 * This endpoint returns per-employee loss of pay for a wage bill, and it
 * is called from the payroll board by the person computing the run. A
 * leave key would mean the payroll operator needed a second permission to
 * do their own job, which is how a permission gets granted to everybody.
 *
 * ⭐ AND THE BETTER PLACE FOR IT IS INSIDE THE COMPUTE'S TRANSACTION.
 * `server/leave/attendance.ts#loadPayrollAttendance` takes a `tx` for
 * exactly that reason — attendance read outside the transaction that
 * computes the run can change between the read and the write. This action
 * exists so the board can also SHOW the operator what it is about to
 * charge before they press the button.
 */
export async function getPayrollAttendance(input: unknown): Promise<
  ActionResult<{
    rows: ReadonlyArray<{ employeeId: string; payableDays: number; lopDays: number }>;
    employeesWithRecords: number;
    totalLopDays: string;
    unexplainedAbsences: number;
    note: string;
  }>
> {
  try {
    const ctx = await requirePermission(PAYROLL_MANAGE);
    const parsed = z.object({ runId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Pick a payroll run." };

    const outcome = await withTenant(ctx.tenant.id, async (tx): Promise<Outcome<AttendanceSummary>> => {
      const [run] = await tx
        .select({
          id: payrollRuns.id,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
        })
        .from(payrollRuns)
        .where(
          and(eq(payrollRuns.tenantId, ctx.tenant.id), eq(payrollRuns.id, parsed.data.runId)),
        )
        .limit(1);
      if (!run) return { error: "No such payroll run." as const };

      const periodStart = String(run.periodStart);
      const periodEnd = String(run.periodEnd);

      /**
       * ⚠️ THE SAME POPULATION `computeRun()` USES — everybody on the
       * rolls at any point inside the period, not everybody active today.
       * A different population here would produce attendance rows for
       * people the run has no payslip for, which `summariseAttendance()`
       * drops rather than guesses at.
       */
      const staff = await tx
        .select({
          id: employees.id,
          joinedOn: employees.joinedOn,
          leftOn: employees.leftOn,
        })
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, ctx.tenant.id),
            lte(employees.joinedOn, periodEnd),
            sql`(${employees.leftOn} IS NULL OR ${employees.leftOn} >= ${periodStart}::date)`,
          ),
        );

      const days =
        Math.round(
          (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) /
            86_400_000,
        ) + 1;

      const payableDaysByEmployee = new Map<string, number>();
      for (const p of staff) {
        const from = String(p.joinedOn) > periodStart ? String(p.joinedOn) : periodStart;
        const to =
          p.leftOn && String(p.leftOn) < periodEnd ? String(p.leftOn) : periodEnd;
        const onRolls =
          from > to
            ? 0
            : Math.round(
                (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
              ) + 1;
        payableDaysByEmployee.set(String(p.id), Math.min(onRolls, days));
      }

      return loadPayrollAttendance(tx, {
        tenantId: ctx.tenant.id,
        periodStart,
        periodEnd,
        payableDaysByEmployee,
      });
    });

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    return {
      ok: true,
      data: {
        rows: outcome.rows,
        employeesWithRecords: outcome.employeesWithRecords,
        totalLopDays: formatDays(outcome.totalLopCentidays),
        unexplainedAbsences: outcome.unexplainedAbsenceEmployeeIds.length,
        note:
          outcome.rows.length === 0
            ? "Nothing is recorded in the attendance register for this period, so everybody is paid a full month. That is the correct default — most salaried staff are never marked present at all — but it is not the same as having checked."
            : `${outcome.employeesWithRecords} people have attendance recorded, totalling ${formatDays(outcome.totalLopCentidays)} days of loss of pay. Nothing is charged until the run is computed with these figures.`,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "leave");
  }
}
