"use server";

/**
 * Ordence — ⭐⭐⭐ THE STATUTORY REGISTERS PACK
 * Version: v1.48.0-alpha · Batch 76
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * These are the registers a labour inspector asks to see, GENERATED FROM
 * WHAT ORDENCE ALREADY HOLDS. Nothing here is typed by a user, nothing
 * here is stored, and — the part that matters — nothing here fills a
 * statutory column that has no data behind it.
 *
 * ⭐ THE READ PATH IS THE WHOLE FILE. No table was created for this
 * batch and no row is written by it. Both exports are reads, both go
 * through `withTenant`, and RLS remains the only isolation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO EXPORTS, AND BOTH ARE PUBLIC HTTP ENDPOINTS
 * ══════════════════════════════════════════════════════════════════════
 * `"use server"` publishes every export as a URL. A wage register is a
 * list of every colleague's salary and a leave register is everybody's
 * absence history, so neither may sit behind tenant membership alone.
 *
 * 🔴 THE PERMISSION SET DEPENDS ON THE REGISTER, AND IT IS THE SPEC THAT
 * DECIDES:
 *
 *   Every register              → `payroll.read`
 *   Attendance and leave        → `payroll.read` AND `leave.read`
 *
 * ⚠️ `payroll.read` ALONE WOULD NOT DO FOR THE LAST TWO. `leave.read` is
 * described in the catalogue as "the whole leave register for everybody"
 * and is deliberately kept out of the default role templates — exactly
 * so that somebody who may see the payroll totals does not automatically
 * acquire every employee's sickness pattern. Reaching leave data through
 * a payroll-shaped door would undo that decision quietly.
 *
 * ⭐ AND `payroll.read` IS REQUIRED FOR THEM TOO, not instead. A muster
 * roll is the document a wage register is checked against; whoever can
 * produce one for an inspection is being trusted with the payroll
 * relationship either way.
 *
 * 🔴 WHAT I WANTED AND DO NOT HAVE: a `registers.read` key, so that a
 * compliance officer could produce statutory registers without holding
 * the keys that also open individual salaries. `requirePermission` is
 * typed `PermissionKey` and the catalogue lives in `db/schema/auth.ts`,
 * which this batch must not touch. Composing the two existing read keys
 * is the honest approximation and is strictly no weaker than either.
 * Reported.
 */

import { and, asc, eq, gte, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/db";
import { employees, payrollRuns, payslips } from "@/db/schema/payroll";
import { leaveLedger, leavePeriods, leaveTypes, staffAttendance } from "@/db/schema/leave";
import { requireAllPermissions } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import { fyEndFor, fyStartFor, isIsoDate, todayInIndia } from "@/lib/accounting/periods";
import {
  DEFAULT_RULE_SET_ID,
  REGISTER_KINDS,
  RULE_SETS,
  type RegisterKind,
} from "@/lib/registers/forms";
import { REGISTER_SPECS, specFor } from "@/lib/registers/spec";
import type { RegisterOutcome } from "@/lib/registers/document";
import {
  buildAttendanceRegister,
  buildEmployeeRegister,
  buildLeaveRegister,
  buildWageRegister,
  refuseLoansRegister,
  type AttendanceFact,
  type EmployeeFact,
  type LeaveLedgerFact,
  type PayslipFact,
  type RunFact,
  type WageLineFact,
} from "@/lib/registers/build";
import { centidaysFromNumeric, paiseFromNumeric } from "@/lib/registers/format";

const PAYROLL_READ = "payroll.read" as const;
const LEAVE_READ = "leave.read" as const;

/* ================================================================== */
/* INPUT                                                               */
/* ================================================================== */

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in the form YYYY-MM-DD.");

const registerInput = z.object({
  kind: z.enum([
    "employee_register",
    "wage_register",
    "attendance_register",
    "leave_with_wages_register",
    "loans_and_advances_register",
  ]),
  /**
   * ⚠️ OPTIONAL, AND THE DEFAULT IS THE INDIAN FINANCIAL YEAR — 1 April
   * to 31 March — resolved through `todayInIndia()`. A default computed
   * from `new Date().toISOString()` is the UTC date, which between
   * midnight and 05:30 IST is yesterday; on one night a year that
   * yesterday is 31 March and the register silently covers the wrong
   * year.
   */
  from: isoDate.optional(),
  to: isoDate.optional(),
  ruleSetId: z.string().trim().max(60).optional(),
  /** ⭐ One State per establishment. See `multiStateWarning`. */
  stateCode: z
    .string()
    .trim()
    .length(2)
    .toUpperCase()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type RegisterInput = z.input<typeof registerInput>;

/* ================================================================== */
/* ① THE CATALOGUE                                                     */
/* ================================================================== */

export interface RegisterCatalogue {
  readonly registers: readonly {
    readonly kind: RegisterKind;
    readonly title: string;
    readonly purpose: string;
    readonly periodic: boolean;
    readonly needsLeave: boolean;
    readonly refusal: string | null;
    readonly sourcedColumns: number;
    readonly unsourcedColumns: number;
  }[];
  readonly ruleSets: readonly {
    readonly id: string;
    readonly label: string;
    readonly citation: string;
    readonly confidence: string;
    readonly note: string;
    readonly hasFormNumbers: boolean;
  }[];
  readonly defaultRuleSetId: string;
  readonly defaultFrom: string;
  readonly defaultTo: string;
  readonly today: string;
  /** ⭐ So the picker can offer one State per establishment. */
  readonly states: readonly string[];
  readonly runs: readonly {
    readonly runNo: string;
    readonly status: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  }[];
}

/**
 * ⭐ WHAT CAN BE PRODUCED, AND WHAT IT WILL AND WILL NOT CONTAIN, BEFORE
 * ANYBODY GENERATES ANYTHING.
 *
 * ⚠️ IT PUBLISHES THE UNSOURCED COLUMN COUNT. A picker that hid that
 * number until after generation would let somebody choose the employee
 * register believing it is complete, and discover the seven blanks after
 * they had printed it.
 */
export async function listRegisterCatalogue(): Promise<ActionResult<RegisterCatalogue>> {
  try {
    const ctx = await requireAllPermissions([PAYROLL_READ]);
    const today = todayInIndia();

    const { states, runs } = await withTenant(ctx.tenant.id, async (tx) => {
      const stateRows = await tx
        .selectDistinct({ code: employees.workStateCode })
        .from(employees);

      const runRows = await tx
        .select({
          runNo: payrollRuns.runNo,
          status: payrollRuns.status,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
        })
        .from(payrollRuns)
        .where(ne(payrollRuns.status, "cancelled"))
        .orderBy(asc(payrollRuns.periodStart))
        .limit(240);

      return { states: stateRows, runs: runRows };
    });

    return {
      ok: true,
      data: {
        registers: REGISTER_KINDS.map((kind) => {
          const spec = REGISTER_SPECS[kind];
          return {
            kind,
            title: spec.title,
            purpose: spec.purpose,
            periodic: spec.periodic,
            needsLeave: spec.needsLeave,
            refusal: spec.refusal,
            sourcedColumns: spec.columns.filter((c) => c.sourcing.kind === "sourced").length,
            unsourcedColumns: spec.columns.filter((c) => c.sourcing.kind === "unsourced").length,
          };
        }),
        ruleSets: RULE_SETS.map((r) => ({
          id: r.id,
          label: r.label,
          citation: r.citation,
          confidence: r.confidence,
          note: r.note,
          hasFormNumbers: Object.keys(r.forms).length > 0,
        })),
        defaultRuleSetId: DEFAULT_RULE_SET_ID,
        defaultFrom: fyStartFor(today),
        defaultTo: fyEndFor(today),
        today,
        states: [
          ...new Set(
            states
              .map((s) => (s.code ?? "").trim().toUpperCase())
              .filter((s) => s.length > 0),
          ),
        ].sort(),
        runs,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "registers");
  }
}

/* ================================================================== */
/* ② GENERATION                                                        */
/* ================================================================== */

/**
 * 🔴 ONE EXPORT FOR FIVE REGISTERS, AND THE GUARD IS STILL ONE HOP FROM
 * THE EXPORT.
 *
 * The permission SET varies by register, so it is computed from the spec
 * and handed to `requireAllPermissions` inside this function — which is
 * where `check:guards` looks. Five separate exports would each need
 * their own guard and the fifth one added next year would be the one
 * that forgets it.
 *
 * ⚠️ THE PERMISSIONS ARE CHECKED BEFORE ANY QUERY RUNS AND BEFORE THE
 * DATES ARE EVEN RESOLVED. An unauthorised caller must not be able to
 * distinguish a workspace with payroll data from one without by timing
 * the refusal.
 */
export async function generateRegister(
  input: RegisterInput,
): Promise<ActionResult<RegisterOutcome>> {
  try {
    const parsed = registerInput.parse(input);
    const spec = specFor(parsed.kind);

    const ctx = await requireAllPermissions(
      spec.needsLeave ? [PAYROLL_READ, LEAVE_READ] : [PAYROLL_READ],
    );

    const today = todayInIndia();
    const from = parsed.from ?? fyStartFor(today);
    const to = parsed.to ?? fyEndFor(today);

    if (!isIsoDate(from) || !isIsoDate(to)) {
      return { ok: false, error: "The period must be two dates in the form YYYY-MM-DD." };
    }
    if (from > to) {
      return { ok: false, error: "The period ends before it begins." };
    }

    const ruleSetId = parsed.ruleSetId ?? DEFAULT_RULE_SET_ID;
    const stateCode = parsed.stateCode ?? null;

    const outcome = await withTenant(ctx.tenant.id, (tx) =>
      buildFor({ tx, kind: parsed.kind, from, to, ruleSetId, stateCode, today }),
    );

    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "registers");
  }
}

/* ================================================================== */
/* THE READS                                                           */
/* ================================================================== */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⚠️ EVERY QUERY BELOW RUNS INSIDE `withTenant`, WHICH IS WHERE THE
 * TENANT PREDICATE COMES FROM. Not one of them repeats `tenant_id = ...`
 * in its own WHERE clause, and that is deliberate: a hand-written tenant
 * filter is a second source of truth that can be right on nine queries
 * and forgotten on the tenth, and its presence teaches the next reader
 * that RLS is optional.
 */
async function buildFor(args: {
  tx: Tx;
  kind: RegisterKind;
  from: string;
  to: string;
  ruleSetId: string;
  stateCode: string | null;
  today: string;
}): Promise<RegisterOutcome> {
  const { tx, kind, from, to, ruleSetId, stateCode, today } = args;

  if (kind === "employee_register") {
    const staff = await readEmployees(tx, { stateCode, activeOn: null, from: null, to: null });
    return {
      generated: true,
      document: buildEmployeeRegister({
        employees: staff,
        ruleSetId,
        generatedOn: today,
        stateFilter: stateCode,
      }),
    };
  }

  if (kind === "wage_register" || kind === "loans_and_advances_register") {
    const { runs, slips } = await readPayroll(tx, { from, to });
    if (kind === "loans_and_advances_register") {
      return refuseLoansRegister({
        payslips: slips,
        generatedOn: today,
        periodFrom: from,
        periodTo: to,
      });
    }
    return {
      generated: true,
      document: buildWageRegister({
        runs,
        payslips: slips,
        ruleSetId,
        generatedOn: today,
        periodFrom: from,
        periodTo: to,
      }),
    };
  }

  if (kind === "attendance_register") {
    const staff = await readEmployees(tx, { stateCode, activeOn: null, from, to });
    const rows = await tx
      .select({
        employeeId: staffAttendance.employeeId,
        onDate: staffAttendance.onDate,
        status: staffAttendance.status,
        lopFraction: staffAttendance.lopFraction,
      })
      .from(staffAttendance)
      .where(and(gte(staffAttendance.onDate, from), lte(staffAttendance.onDate, to)))
      .orderBy(asc(staffAttendance.onDate));

    const known = new Set(staff.map((s) => s.id));
    const attendance: AttendanceFact[] = rows
      .filter((r) => known.has(r.employeeId))
      .map((r) => ({
        employeeId: r.employeeId,
        onDate: r.onDate,
        status: r.status,
        lopCentidays: centidaysFromNumeric(r.lopFraction),
      }));

    return {
      generated: true,
      document: buildAttendanceRegister({
        employees: staff,
        attendance,
        ruleSetId,
        generatedOn: today,
        periodFrom: from,
        periodTo: to,
      }),
    };
  }

  /* leave_with_wages_register */
  const staff = await readEmployees(tx, { stateCode, activeOn: null, from, to });
  const entries = await tx
    .select({
      employeeId: leaveLedger.employeeId,
      leaveTypeId: leaveLedger.leaveTypeId,
      kind: leaveLedger.kind,
      daysDelta: leaveLedger.daysDelta,
      code: leaveTypes.code,
      label: leaveTypes.label,
    })
    .from(leaveLedger)
    .innerJoin(leaveTypes, eq(leaveLedger.leaveTypeId, leaveTypes.id))
    .where(and(gte(leaveLedger.effectiveOn, from), lte(leaveLedger.effectiveOn, to)))
    .orderBy(asc(leaveLedger.effectiveOn));

  const known = new Set(staff.map((s) => s.id));
  const ledger: LeaveLedgerFact[] = entries
    .filter((e) => known.has(e.employeeId))
    .map((e) => ({
      employeeId: e.employeeId,
      leaveTypeId: e.leaveTypeId,
      leaveTypeCode: e.code,
      leaveTypeLabel: e.label,
      kind: e.kind,
      daysDeltaCentidays: centidaysFromNumeric(e.daysDelta),
    }));

  /**
   * ⭐ THE LEAVE YEAR'S OWN LABEL, WHEN THE WINDOW IS EXACTLY ONE.
   *
   * ⚠️ ONLY WHEN IT IS EXACTLY ONE. Labelling a nine-month window "FY
   * 2025-26" because it happens to sit inside that year would put a
   * leave year's name on a document that is not a leave year, and the
   * carry-forward figures on it would not reconcile to anything.
   */
  const periods = await tx
    .select({ label: leavePeriods.label, startsOn: leavePeriods.startsOn, endsOn: leavePeriods.endsOn })
    .from(leavePeriods)
    .where(and(eq(leavePeriods.startsOn, from), eq(leavePeriods.endsOn, to)))
    .limit(2);

  return {
    generated: true,
    document: buildLeaveRegister({
      employees: staff,
      ledger,
      ruleSetId,
      generatedOn: today,
      periodFrom: from,
      periodTo: to,
      periodLabel: periods.length === 1 ? (periods[0]?.label ?? null) : null,
    }),
  };
}

/**
 * ⚠️ "ON THE ROLLS AT SOME POINT IN THE WINDOW", NOT "ACTIVE TODAY".
 *
 * 🔴 A REGISTER FOR APRIL MUST CONTAIN THE PERSON WHO LEFT IN MAY.
 * Filtering on `is_active` would drop every leaver from every historical
 * register, and the registers most likely to be inspected are the ones
 * covering somebody who has since gone.
 */
async function readEmployees(
  tx: Tx,
  opts: { stateCode: string | null; activeOn: string | null; from: string | null; to: string | null },
): Promise<EmployeeFact[]> {
  const conditions = [];
  if (opts.stateCode !== null) conditions.push(eq(employees.workStateCode, opts.stateCode));
  if (opts.from !== null && opts.to !== null) {
    conditions.push(lte(employees.joinedOn, opts.to));
    conditions.push(sql`(${employees.leftOn} IS NULL OR ${employees.leftOn} >= ${opts.from})`);
  }

  const rows = await tx
    .select({
      id: employees.id,
      employeeCode: employees.employeeCode,
      fullName: employees.fullName,
      designation: employees.designation,
      department: employees.department,
      workStateCode: employees.workStateCode,
      joinedOn: employees.joinedOn,
      leftOn: employees.leftOn,
      pan: employees.pan,
      uan: employees.uan,
      esicNumber: employees.esicNumber,
    })
    .from(employees)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(employees.fullName), asc(employees.employeeCode));

  return rows.map((r) => ({ ...r }));
}

/**
 * ⭐ RUNS FIRST, THEN THEIR PAYSLIPS. Two queries rather than one join,
 * because the register has to state the STATUS of every run in the
 * window even when a run produced no payslips at all — and an inner join
 * would drop exactly those, which are the ones most worth naming.
 *
 * 🔴 CANCELLED RUNS ARE EXCLUDED HERE. Their payslips still exist and
 * describe wages that were never paid; a wage register containing them
 * overstates the wage bill and double-counts the month if the run was
 * redone.
 */
async function readPayroll(
  tx: Tx,
  opts: { from: string; to: string },
): Promise<{ runs: RunFact[]; slips: PayslipFact[] }> {
  const runs = await tx
    .select({
      id: payrollRuns.id,
      runNo: payrollRuns.runNo,
      status: payrollRuns.status,
      periodStart: payrollRuns.periodStart,
      periodEnd: payrollRuns.periodEnd,
    })
    .from(payrollRuns)
    .where(
      and(
        ne(payrollRuns.status, "cancelled"),
        gte(payrollRuns.periodEnd, opts.from),
        lte(payrollRuns.periodEnd, opts.to),
      ),
    )
    .orderBy(asc(payrollRuns.periodStart), asc(payrollRuns.runNo));

  if (runs.length === 0) return { runs: [], slips: [] };

  const runIds = new Set(runs.map((r) => r.id));

  const rows = await tx
    .select({
      runId: payslips.runId,
      employeeId: payslips.employeeId,
      employeeCode: payslips.employeeCode,
      employeeName: payslips.employeeName,
      daysInMonth: payslips.daysInMonth,
      payableDays: payslips.payableDays,
      lopDays: payslips.lopDays,
      grossMinor: payslips.grossMinor,
      employeePfMinor: payslips.employeePfMinor,
      employeeEsiMinor: payslips.employeeEsiMinor,
      professionalTaxMinor: payslips.professionalTaxMinor,
      tdsMinor: payslips.tdsMinor,
      otherDeductionsMinor: payslips.otherDeductionsMinor,
      totalDeductionsMinor: payslips.totalDeductionsMinor,
      netPayMinor: payslips.netPayMinor,
      lines: payslips.lines,
    })
    .from(payslips)
    .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
    .where(
      and(
        ne(payrollRuns.status, "cancelled"),
        gte(payrollRuns.periodEnd, opts.from),
        lte(payrollRuns.periodEnd, opts.to),
      ),
    )
    .orderBy(asc(payslips.employeeName), asc(payslips.employeeCode));

  const slips: PayslipFact[] = rows
    .filter((r) => runIds.has(r.runId))
    .map((r) => ({
      runId: r.runId,
      employeeId: r.employeeId,
      employeeCode: r.employeeCode,
      employeeName: r.employeeName,
      daysInMonth: r.daysInMonth,
      payableCentidays: centidaysFromNumeric(r.payableDays),
      lopCentidays: centidaysFromNumeric(r.lopDays),
      grossMinor: paiseFromNumeric(r.grossMinor),
      employeePfMinor: paiseFromNumeric(r.employeePfMinor),
      employeeEsiMinor: paiseFromNumeric(r.employeeEsiMinor),
      professionalTaxMinor: paiseFromNumeric(r.professionalTaxMinor),
      tdsMinor: paiseFromNumeric(r.tdsMinor),
      otherDeductionsMinor: paiseFromNumeric(r.otherDeductionsMinor),
      totalDeductionsMinor: paiseFromNumeric(r.totalDeductionsMinor),
      netMinor: paiseFromNumeric(r.netPayMinor),
      lines: readLines(r.lines),
    }));

  return { runs, slips };
}

/**
 * 🔴 `payslips.lines` IS `jsonb` TYPED `unknown[]`, WHICH MEANS NOTHING
 * VALIDATES IT ON THE WAY OUT.
 *
 * ⚠️ THE MONEY IN IT IS A DIGIT STRING, NOT A NUMBER — `server/payroll/run.ts`
 * writes `amountMinor: l.amountMinor.toString()` precisely because JSON
 * numbers are IEEE doubles. Reading it back with `Number(...)` would
 * undo that, quietly, at the one place the value becomes a wage rate on
 * a statutory document.
 *
 * ⭐ ANYTHING THIS CANNOT READ BECOMES `null`, WHICH BECOMES A BLANK
 * CELL. A line with an unparseable amount must not contribute zero to a
 * rate of wages — see `buildWageRegister`, which blanks the whole cell
 * rather than printing a short sum.
 */
function readLines(raw: unknown): WageLineFact[] {
  if (!Array.isArray(raw)) return [];
  const out: WageLineFact[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const kind = record.kind === "deduction" ? "deduction" : "earning";
    out.push({
      label: typeof record.label === "string" ? record.label : "(unnamed)",
      kind,
      fullMonthMinor:
        typeof record.fullMonthMinor === "string"
          ? paiseFromNumeric(record.fullMonthMinor)
          : null,
      amountMinor:
        typeof record.amountMinor === "string" ? paiseFromNumeric(record.amountMinor) : null,
    });
  }
  return out;
}

/**
 * ⭐ TYPE-ONLY, AND ERASED AT COMPILE TIME. It is not an endpoint.
 *
 * 🔴 THERE IS NO THIRD EXPORT AND THERE MUST NOT BE ONE. A `"use server"`
 * module publishes every export as a URL, so even a pure predicate like
 * "is this a register kind" would have to be an async function with a
 * guard on it, and the guard would be theatre. `isRegisterKind` lives in
 * `lib/registers/forms.ts` and pages import it from there directly.
 */
export type { RegisterKind };
