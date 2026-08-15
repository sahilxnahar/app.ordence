import "server-only";

/**
 * Ordence — ⭐⭐⭐ COMPUTING A PAYROLL RUN
 * Version: v1.23.0-alpha · Batch 15
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE HOLDS NO ARITHMETIC
 * ══════════════════════════════════════════════════════════════════════
 * Every rupee is decided in `lib/payroll/statutory.ts` and
 * `lib/payroll/payslip.ts`, which are pure and tested without a
 * database. This file loads rows, hands them over, and writes the answer
 * down.
 *
 * 🔴 THAT SPLIT IS NOT TIDINESS. Payroll arithmetic is the code most
 * likely to be checked by hand, by an employee with a calculator and a
 * reason to care. Arithmetic that can only be exercised by standing up
 * Postgres gets tested once and then trusted forever.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND EVERY RATE IS READ FOR THE PERIOD, NOT FOR TODAY
 * ══════════════════════════════════════════════════════════════════════
 * A March run computed in September uses March's provident fund
 * ceiling. Reading today's would produce a different payslip from the
 * one the employee is holding, and the employee is right.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ v1.47.0 (BATCH 50): AND ATTENDANCE IS READ FOR THE PERIOD TOO
 * ══════════════════════════════════════════════════════════════════════
 * `attendance` used to be an argument, and the run board hardcoded it to
 * `[]` — so every run paid every salaried person a full month whatever
 * the register said. `computeRun()` now reads `staff_attendance` and the
 * approved leave register through `server/payroll/attendance-bridge.ts`,
 * in this transaction, and carries the position out in `ComputeOutcome`
 * so the payslips are written from the same numbers they were priced on.
 */

import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  employeePayStructure,
  employees,
  payComponents,
  payrollRuns,
  payslips,
  statutoryRates,
} from "@/db/schema/payroll";
import {
  buildPayslip,
  totalRun,
  type PayComponent,
  type PayslipResult,
  type RunTotals,
  type StructureLine,
} from "@/lib/payroll/payslip";
import { formatDays } from "@/lib/leave/days";
import {
  loadRunAttendance,
  type RunAttendance,
  type RunLopRow,
} from "@/server/payroll/attendance-bridge";
import {
  pickEffective,
  type EsiRules,
  type PfRules,
  type PtSlab,
  type TaxRules,
  type TaxSlab,
} from "@/lib/payroll/statutory";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/* ------------------------------------------------------------------ */
/* ATTENDANCE, READ FROM THE REGISTER                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SHAPE THE COMPUTE CONSUMES. Unchanged since Batch 15, and
 * `lib/leave/attendance.ts#PayrollAttendanceRow` is pinned to it field
 * for field by `tests/ui/leave.test.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 v1.47.0 (BATCH 50): IT IS NO LONGER SUPPLIED BY THE CALLER.
 * ══════════════════════════════════════════════════════════════════════
 * It used to arrive from `computePayrollRun`, which took it from the
 * browser. Two things were wrong with that and only one of them was the
 * hardcoded `attendance: []`:
 *
 *   ① THE BOARD SENT AN EMPTY ARRAY, so every run paid every salaried
 *      person a full month whatever the register said.
 *
 *   ② A `"use server"` EXPORT IS A PUBLIC ENDPOINT. `attendance` was a
 *      validated-but-trusted array of `{employeeId, payableDays, lopDays}`
 *      — so anybody who could reach the endpoint could post any loss of
 *      pay against any employee UUID, and the wage bill would be computed
 *      from it with nothing anywhere recording that the figure did not
 *      come from the attendance register.
 *
 * `computeRun()` now reads `staff_attendance` and the approved leave
 * register itself, inside the transaction that writes the payslips.
 */
export interface AttendanceInput {
  readonly employeeId: string;
  readonly payableDays: number;
  readonly lopDays: number;
}

/* ------------------------------------------------------------------ */
/* LOADING THE RATES                                                   */
/* ------------------------------------------------------------------ */

interface LoadedRates {
  readonly pf: PfRules | null;
  readonly esi: EsiRules | null;
  readonly ptSlabs: readonly PtSlab[];
  readonly taxByRegime: Readonly<Record<"new" | "old", TaxRules | null>>;
  readonly taxSlabs: readonly TaxSlab[];
}

/**
 * ⚠️ THE PAYLOADS ARE VALIDATED SHALLOWLY AND THE FAILURE IS A NULL.
 *
 * 🔴 A MALFORMED RATE ROW MUST NOT PRODUCE A PAYSLIP WITH A ZERO IN IT.
 * `buildPayslip` turns a null ruleset into a stated PROBLEM on the
 * payslip, and a run with problems cannot be approved. A silent zero
 * would look like a correctly calculated exemption.
 */
export async function loadRates(
  tx: Tx,
  tenantId: string,
  onDate: string,
): Promise<LoadedRates> {
  const rows = await tx
    .select()
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.tenantId, tenantId),
        lte(statutoryRates.effectiveFrom, onDate),
        or(
          isNull(statutoryRates.effectiveTo),
          sql`${statutoryRates.effectiveTo} >= ${onDate}::date`,
        ),
      ),
    );

  const dated = rows.map((r) => ({
    ...r,
    effectiveFrom: String(r.effectiveFrom),
    effectiveTo: r.effectiveTo === null ? null : String(r.effectiveTo),
  }));

  const pfRow = pickEffective(
    dated.filter((r) => r.kind === "pf"),
    onDate,
  );
  const esiRow = pickEffective(
    dated.filter((r) => r.kind === "esi"),
    onDate,
  );

  const taxRow = (regime: "new" | "old") =>
    pickEffective(
      dated.filter((r) => r.kind === "income_tax" && r.scope === regime),
      onDate,
    );

  return {
    pf: pfRow ? asPf(pfRow.payload, pfRow.effectiveFrom, pfRow.effectiveTo) : null,
    esi: esiRow ? asEsi(esiRow.payload, esiRow.effectiveFrom, esiRow.effectiveTo) : null,
    ptSlabs: dated
      .filter((r) => r.kind === "professional_tax")
      .flatMap((r) => asPtSlabs(r.payload, r.scope ?? "", r.effectiveFrom, r.effectiveTo)),
    taxByRegime: {
      new: (() => {
        const row = taxRow("new");
        return row ? asTaxRules(row.payload, "new", row.effectiveFrom, row.effectiveTo) : null;
      })(),
      old: (() => {
        const row = taxRow("old");
        return row ? asTaxRules(row.payload, "old", row.effectiveFrom, row.effectiveTo) : null;
      })(),
    },
    taxSlabs: dated
      .filter((r) => r.kind === "income_tax_slab")
      .flatMap((r) =>
        asTaxSlabs(r.payload, (r.scope as "new" | "old") ?? "new", r.effectiveFrom, r.effectiveTo),
      ),
  };
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function str(value: unknown, fallback = "0"): string {
  return value === null || value === undefined ? fallback : String(value);
}

function asPf(p: Record<string, unknown>, from: string, to: string | null): PfRules | null {
  if (p.employeeRateBp === undefined || p.wageCeilingMinor === undefined) return null;
  return {
    effectiveFrom: from,
    effectiveTo: to,
    employeeRateBp: num(p.employeeRateBp),
    employerRateBp: num(p.employerRateBp),
    pensionRateBp: num(p.pensionRateBp),
    edliRateBp: num(p.edliRateBp),
    adminRateBp: num(p.adminRateBp),
    wageCeilingMinor: str(p.wageCeilingMinor),
    pensionCeilingMinor: str(p.pensionCeilingMinor ?? p.wageCeilingMinor),
  };
}

function asEsi(p: Record<string, unknown>, from: string, to: string | null): EsiRules | null {
  if (p.employeeRateBp === undefined || p.wageLimitMinor === undefined) return null;
  return {
    effectiveFrom: from,
    effectiveTo: to,
    employeeRateBp: num(p.employeeRateBp),
    employerRateBp: num(p.employerRateBp),
    wageLimitMinor: str(p.wageLimitMinor),
  };
}

function asPtSlabs(
  p: Record<string, unknown>,
  stateCode: string,
  from: string,
  to: string | null,
): PtSlab[] {
  const raw = Array.isArray(p.slabs) ? (p.slabs as Record<string, unknown>[]) : [];
  return raw.map((slab) => ({
    effectiveFrom: from,
    effectiveTo: to,
    stateCode,
    fromMinor: str(slab.fromMinor),
    toMinor: slab.toMinor === null || slab.toMinor === undefined ? null : String(slab.toMinor),
    amountMinor: str(slab.amountMinor),
    februaryAmountMinor:
      slab.februaryAmountMinor === null || slab.februaryAmountMinor === undefined
        ? null
        : String(slab.februaryAmountMinor),
  }));
}

function asTaxRules(
  p: Record<string, unknown>,
  regime: "new" | "old",
  from: string,
  to: string | null,
): TaxRules {
  return {
    effectiveFrom: from,
    effectiveTo: to,
    regime,
    standardDeductionMinor: str(p.standardDeductionMinor),
    rebateLimitMinor: str(p.rebateLimitMinor),
    rebateMaxMinor: str(p.rebateMaxMinor),
    cessRateBp: num(p.cessRateBp),
    surchargeThresholdMinor:
      p.surchargeThresholdMinor === null || p.surchargeThresholdMinor === undefined
        ? null
        : String(p.surchargeThresholdMinor),
  };
}

function asTaxSlabs(
  p: Record<string, unknown>,
  regime: "new" | "old",
  from: string,
  to: string | null,
): TaxSlab[] {
  const raw = Array.isArray(p.slabs) ? (p.slabs as Record<string, unknown>[]) : [];
  return raw.map((slab) => ({
    effectiveFrom: from,
    effectiveTo: to,
    regime,
    fromMinor: str(slab.fromMinor),
    toMinor: slab.toMinor === null || slab.toMinor === undefined ? null : String(slab.toMinor),
    rateBp: num(slab.rateBp),
  }));
}

/* ------------------------------------------------------------------ */
/* COMPUTE                                                             */
/* ------------------------------------------------------------------ */

export interface ComputeOutcome {
  readonly totals: RunTotals;
  readonly slips: readonly { employeeId: string; result: PayslipResult }[];
  /**
   * ⭐ THE LOSS-OF-PAY POSITION THE RUN WAS COMPUTED FROM, CARRIED OUT
   * WITH THE ANSWER. `writeRun()` needs it and the caller needs it, and
   * re-reading it would be a second read of a table that can change
   * between the two.
   */
  readonly attendance: RunAttendance;
  /** Days on the rolls per employee, from `daysOnRollsIn()`. */
  readonly payableDaysByEmployee: ReadonlyMap<string, number>;
}

/** ⚠️ Calendar days, from the period itself. Never a fixed thirty. */
export function daysInPeriod(periodStart: string, periodEnd: string): number {
  const start = Date.parse(`${periodStart}T00:00:00Z`);
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 30;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * ⭐ MONTHS LEFT IN THE FINANCIAL YEAR, INCLUDING THIS ONE.
 *
 * ⚠️ THE INDIAN FINANCIAL YEAR STARTS IN APRIL. Computing tax over a
 * calendar year spreads the liability across the wrong twelve months
 * and under-withholds every January to March.
 */
export function monthsRemainingInFy(periodEnd: string): number {
  const month = Number(periodEnd.slice(5, 7));
  if (!Number.isFinite(month) || month < 1 || month > 12) return 12;
  // April is 1 of 12, March is 12 of 12.
  const indexInFy = month >= 4 ? month - 3 : month + 9;
  return 13 - indexInFy;
}

/**
 * ⭐ THE FIRST DAY OF THE INDIAN FINANCIAL YEAR CONTAINING `date`.
 * Added v1.38.0 (Batch 51).
 *
 * ⚠️ APRIL, NOT JANUARY, AND THE DIFFERENCE IS NOT COSMETIC. TDS on
 * salary is computed on projected ANNUAL income and trued up against
 * what has already been deducted THIS financial year. Using a calendar
 * year would reset the running total every January and under-deduct for
 * three months, then over-deduct in the fourth quarter when the mistake
 * compounds into the projection.
 */
export function fyStartFor(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-04-01`;
}

/**
 * ⭐⭐ WHAT HAS ALREADY BEEN DEDUCTED FROM EACH PERSON THIS FINANCIAL YEAR.
 * Added v1.38.0 (Batch 51).
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS WAS THE LITERAL `"0"`, AND ZERO IS NEVER RIGHT AFTER APRIL.
 * ══════════════════════════════════════════════════════════════════════
 * `buildPayslip` implements the true-up correctly: it projects annual
 * income, computes the annual liability, subtracts what has already been
 * deducted, and spreads the remainder over the months left in the year.
 * That is the right algorithm and it was fed a constant zero.
 *
 * The consequence is not a small error. Every month was computed as if
 * it were the first month of the year:
 *
 *   • APRIL is correct, because nothing has been deducted yet.
 *   • By SEPTEMBER the employee has paid six months of tax that the
 *     calculation cannot see, so it deducts a sixth of the FULL annual
 *     liability again rather than a sixth of what remains.
 *   • By MARCH `monthsRemaining` is 1, so the entire annual liability is
 *     deducted in one month, on top of eleven months already paid.
 *
 * ⚠️ AND IT FAILS IN THE DIRECTION THAT LOOKS FINE. Over-deduction is
 * refunded by the Income Tax Department when the employee files, so
 * nobody complains to the employer. The employer just quietly took
 * roughly double the tax from every salary and remitted it, and the
 * employee financed the government for a year.
 *
 * ⭐ ONLY POSTED AND APPROVED RUNS COUNT. A draft or computed run is a
 * calculation somebody is still editing; counting it would make the
 * current month depend on a number that changes when a colleague
 * recomputes last month. `cancelled` is excluded because the money never
 * moved.
 */
async function tdsDeductedThisFy(
  tx: Tx,
  args: { tenantId: string; periodStart: string; employeeIds: readonly string[] },
): Promise<ReadonlyMap<string, bigint>> {
  const out = new Map<string, bigint>();
  if (args.employeeIds.length === 0) return out;

  const rows = await tx
    .select({
      employeeId: payslips.employeeId,
      tdsMinor: payslips.tdsMinor,
    })
    .from(payslips)
    .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
    .where(
      and(
        eq(payslips.tenantId, args.tenantId),
        inArray(payslips.employeeId, [...args.employeeIds]),
        inArray(payrollRuns.status, ["approved", "posted"]),
        gte(payrollRuns.periodStart, fyStartFor(args.periodStart)),
        /**
         * ⚠️ STRICTLY BEFORE THIS PERIOD. A recompute of the CURRENT
         * month must not count its own previous payslips, or every
         * recompute would deduct the tax again on top of itself.
         */
        lt(payrollRuns.periodStart, args.periodStart),
      ),
    );

  for (const r of rows) {
    out.set(r.employeeId, (out.get(r.employeeId) ?? 0n) + BigInt(r.tdsMinor));
  }
  return out;
}

export async function computeRun(
  tx: Tx,
  args: {
    tenantId: string;
    runId: string;
    periodStart: string;
    periodEnd: string;
  },
): Promise<ComputeOutcome> {
  const rates = await loadRates(tx, args.tenantId, args.periodEnd);
  const days = daysInPeriod(args.periodStart, args.periodEnd);
  const month = Number(args.periodEnd.slice(5, 7));
  const monthsRemaining = monthsRemainingInFy(args.periodEnd);

  const componentRows = await tx
    .select()
    .from(payComponents)
    .where(and(eq(payComponents.tenantId, args.tenantId), eq(payComponents.isActive, true)));

  const components: PayComponent[] = componentRows.map((c) => ({
    code: c.code,
    label: c.label,
    kind: c.kind === "deduction" ? "deduction" : "earning",
    pfApplicable: c.pfApplicable,
    esiApplicable: c.esiApplicable,
    taxable: c.taxable,
    proRates: c.proRates,
    displayOrder: c.displayOrder,
  }));

  const componentCodeById = new Map(componentRows.map((c) => [c.id, c.code]));

  /**
   * ⚠️ EVERY ACTIVE EMPLOYEE WHO WAS ON THE ROLLS DURING THE PERIOD.
   *
   * 🔴 NOT "EVERY ACTIVE EMPLOYEE TODAY". Somebody who left on the 20th
   * is owed twenty days, and excluding them because they are inactive
   * now is how a final month goes unpaid.
   */
  const staff = await tx
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, args.tenantId),
        lte(employees.joinedOn, args.periodEnd),
        or(isNull(employees.leftOn), sql`${employees.leftOn} >= ${args.periodStart}::date`),
      ),
    );

  const structureRows = await tx
    .select()
    .from(employeePayStructure)
    .where(
      and(
        eq(employeePayStructure.tenantId, args.tenantId),
        lte(employeePayStructure.effectiveFrom, args.periodEnd),
        or(
          isNull(employeePayStructure.effectiveTo),
          sql`${employeePayStructure.effectiveTo} >= ${args.periodEnd}::date`,
        ),
      ),
    );

  const structureByEmployee = new Map<string, StructureLine[]>();
  for (const row of structureRows) {
    const code = componentCodeById.get(row.componentId);
    if (!code) continue;
    const list = structureByEmployee.get(row.employeeId) ?? [];
    list.push({ componentCode: code, monthlyAmountMinor: String(row.monthlyAmountMinor) });
    structureByEmployee.set(row.employeeId, list);
  }

  /**
   * ⭐⭐ THE DAYS EACH PERSON WAS ON THE ROLLS, DERIVED HERE AND NOWHERE
   * ELSE. Attendance never computes it: somebody who joined on the 12th
   * has 20 payable days whether or not anybody ticked a box for the 12th,
   * and `daysOnRollsIn()` already gets the joiner and leaver cases right.
   */
  const payableDaysByEmployee = new Map<string, number>(
    staff.map((p) => [
      p.id,
      Math.min(
        daysOnRollsIn(
          String(p.joinedOn),
          p.leftOn === null ? null : String(p.leftOn),
          args.periodStart,
          args.periodEnd,
          days,
        ),
        days,
      ),
    ]),
  );

  /**
   * ⭐⭐⭐ v1.47.0 (BATCH 50): THE REGISTER IS READ, IN HERE, IN THIS
   * TRANSACTION.
   *
   * 🔴 THIS REPLACES `attendance: []`. Read outside the transaction that
   * writes the payslips, attendance can change between the read and the
   * write — somebody regularising an absence while the run computes — and
   * the payslip would then state a loss of pay the register no longer
   * holds, with no way afterwards to tell which of the two is the lie.
   */
  const attendance = await loadRunAttendance(tx, {
    tenantId: args.tenantId,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    payableDaysByEmployee,
    workStateByEmployee: new Map(staff.map((p) => [p.id, p.workStateCode ?? null])),
  });

  /**
   * ⭐ ONE QUERY FOR THE WHOLE RUN, NOT ONE PER EMPLOYEE. A payroll of
   * four hundred people would otherwise issue four hundred round trips
   * inside a transaction, which is how a compute that took two seconds
   * starts timing out in month nine and gets "fixed" by hardcoding a
   * zero again.
   */
  const alreadyDeducted = await tdsDeductedThisFy(tx, {
    tenantId: args.tenantId,
    periodStart: args.periodStart,
    employeeIds: staff.map((p) => p.id),
  });

  const slips: { employeeId: string; result: PayslipResult }[] = [];

  for (const person of staff) {
    const position = attendance.byEmployee.get(person.id);

    /**
     * ⭐ AN EMPLOYEE WITH NO ATTENDANCE ROW IS PAID THE FULL MONTH.
     *
     * ⚠️ THE OTHER DEFAULT — PAY NOBODY WHO WAS NOT MARKED PRESENT — IS
     * SAFER FOR THE BUSINESS AND WRONG FOR THE PEOPLE. Most salaried
     * staff are never marked present at all; absence of a record means
     * nothing happened, and nothing happening is a normal month.
     *
     * 🔴 BUT IT IS NO LONGER SILENT. The assumption is written onto the
     * payslip below, and counted on the board above the approve button.
     * "Not a full month of loss of pay" and "a full month of pay nobody
     * checked" are both defensible; being unable to tell which one you
     * got is not.
     */
    const payableDays = payableDaysByEmployee.get(person.id) ?? days;
    const lopDays = position?.chargedLopDays ?? 0;

    const built = buildPayslip({
      employee: {
        stateCode: person.workStateCode,
        pfExempt: person.pfExempt,
        pfOnFullWages: person.pfOnFullWages,
        esiExempt: person.esiExempt,
        // ⚠️ APPROXIMATED, AND SAID SO. Proper handling of the ESI
        // contribution period needs last period's payslips; until the
        // history exists, an employee under the limit is treated as
        // covered and one above it as not. See the batch notes.
        esiCoveredAtPeriodStart: false,
        taxRegime: person.taxRegime,
        declaredDeductionsMinor: String(person.declaredDeductionsMinor),
        tdsOverrideMinor:
          person.tdsOverrideMinor === null ? null : String(person.tdsOverrideMinor),
        hasPan: Boolean(person.pan),
      },
      components,
      structure: structureByEmployee.get(person.id) ?? [],
      attendance: { daysInMonth: days, payableDays, lopDays },
      month,
      periodEnd: args.periodEnd,
      pfRules: rates.pf,
      esiRules: rates.esi,
      ptSlabs: rates.ptSlabs,
      taxRules: rates.taxByRegime[person.taxRegime],
      taxSlabs: rates.taxSlabs,
      monthsRemaining,
      /**
       * ⭐ v1.38.0 (Batch 51): THE HISTORY EXISTS AND IS NOW READ.
       *
       * This read `"0"`, so every month was computed as if it were
       * April. See `tdsDeductedThisFy` for what that cost.
       */
      tdsAlreadyDeductedMinor: String(alreadyDeducted.get(person.id) ?? 0n),
    });

    /**
     * ⭐⭐ THE ATTENDANCE STORY IS ADDED TO THE PAYSLIP HERE, BEFORE THE
     * TOTALS ARE STRUCK, AND NOT AT WRITE TIME.
     *
     * 🔴 `totalRun()` COUNTS THE SLIPS THAT CARRY A PROBLEM, and that
     * count is what disables the approve button and what
     * `approvePayrollRun` re-checks. A problem appended in `writeRun()`
     * would be printed on the payslip and would NOT block approval, which
     * is the worst of both: the objection is on the record and nobody had
     * to answer it.
     */
    const result = withAttendanceStory(built, position, days);

    slips.push({ employeeId: person.id, result });
  }

  return {
    totals: totalRun(slips.map((s) => s.result)),
    slips,
    attendance,
    payableDaysByEmployee,
  };
}

/**
 * ⭐⭐ WHY THIS PAYSLIP SAYS WHAT IT SAYS ABOUT DAYS, IN WORDS.
 *
 * Four things can be true of one person's month and each one is a
 * sentence somebody may have to answer for:
 *
 *   ⚠️ NOTHING RECORDED — paid in full on an assumption. A note.
 *   ⚠️ CHARGED FROM AN APPROVED APPLICATION rather than from the
 *      register. A note, because the money came from a decision rather
 *      than from an observation and the two are reconciled differently.
 *   🔴 AN UNEXPLAINED ABSENCE — charged, and named, because it is a
 *      conversation and not an accounting entry.
 *   🔴 A FRACTION OF A DAY THAT COULD NOT BE CHARGED — a PROBLEM, which
 *      blocks approval. See `splitLopForPayslip()` for why the engine
 *      cannot take it and why rounding it away is not an option.
 */
function withAttendanceStory(
  slip: PayslipResult,
  position: RunLopRow | undefined,
  daysInMonth: number,
): PayslipResult {
  if (position === undefined) {
    return {
      ...slip,
      notes: [
        ...slip.notes,
        `Nothing was recorded in the attendance register for this period and no leave was approved, so a full month of ${daysInMonth} days has been paid on the assumption that nothing happened.`,
      ],
    };
  }

  const notes = [...slip.notes];
  const problems = [...slip.problems];

  if (position.approvedUnpaidCentidays > 0) {
    notes.push(
      `${formatDays(position.approvedUnpaidCentidays)} days of this loss of pay come from approved UNPAID leave for days the attendance register has no entry for. Approving unpaid leave is a decision that the days are not paid; recording them in the register as well would not change the figure.`,
    );
  }
  if (position.approvedPaidCentidays > 0) {
    notes.push(
      `${formatDays(position.approvedPaidCentidays)} days of approved PAID leave fall in this period and cost nothing. They are stated so that a short payslip is not blamed on them.`,
    );
  }
  if (position.unregularisedCentidays > 0) {
    notes.push(
      `${formatDays(position.unregularisedCentidays)} days are marked absent with no leave type against them. They have been charged because the register says so, but nobody has said why the person was away.`,
    );
  }
  if (position.cappedAtPayableDays) {
    notes.push(
      "The recorded loss of pay exceeded the days this person was on the rolls this period and has been capped at those days. Nobody can lose more pay than they were owed.",
    );
  }
  if (position.unrepresentableCentidays > 0) {
    problems.push(
      `The register holds ${formatDays(position.totalLopCentidays)} days of loss of pay for this person, and only the ${position.chargedLopDays} whole days of it have been charged — the payslip calculation cannot yet pro-rate a part day. The remaining ${formatDays(position.unrepresentableCentidays)} of a day is NOT on this payslip. Record the part day as a whole day in the attendance register if that is what was meant, or leave this run unapproved.`,
    );
  }

  return { ...slip, notes, problems };
}

/**
 * ⚠️ A JOINER OR A LEAVER IS PAID FOR THE DAYS THEY WERE ON THE ROLLS,
 * not for the whole month, and the default has to know that or every
 * first and last month is wrong.
 */
export function daysOnRollsIn(
  joinedOn: string,
  leftOn: string | null,
  periodStart: string,
  periodEnd: string,
  daysInMonth: number,
): number {
  const start = joinedOn > periodStart ? joinedOn : periodStart;
  const end = leftOn !== null && leftOn < periodEnd ? leftOn : periodEnd;
  if (start > end) return 0;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(ms)) return daysInMonth;
  return Math.round(ms / 86_400_000) + 1;
}

/* ------------------------------------------------------------------ */
/* WRITING IT DOWN                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ REPLACES EVERY PAYSLIP IN THE RUN, and can only do so while the run
 * is `draft` or `computed` — 0075's trigger refuses it once approved.
 *
 * ⭐ DELETE-THEN-INSERT RATHER THAN UPSERT. A recompute after somebody
 * was removed from the run must not leave their payslip behind, and an
 * upsert leaves it behind silently.
 */
export async function writeRun(
  tx: Tx,
  args: {
    tenantId: string;
    runId: string;
    outcome: ComputeOutcome;
    employeeNames: ReadonlyMap<string, { name: string; code: string }>;
    daysInMonth: number;
  },
): Promise<void> {
  await tx.delete(payslips).where(eq(payslips.runId, args.runId));

  /**
   * ⭐ THE DAYS COME OUT OF THE OUTCOME, NOT OUT OF A SECOND ARGUMENT.
   *
   * 🔴 THEY USED TO BE PASSED IN SEPARATELY FROM WHAT WAS COMPUTED, so
   * the `payableDays` and `lopDays` PRINTED on the payslip and the ones
   * the money was PRO-RATED BY were two different values that happened to
   * agree. A caller that passed one and not the other would produce a
   * payslip whose own header disagreed with its own arithmetic.
   */
  const attendanceByEmployee = args.outcome.attendance.byEmployee;

  for (const slip of args.outcome.slips) {
    const who = args.employeeNames.get(slip.employeeId);
    const attendance = attendanceByEmployee.get(slip.employeeId);
    const r = slip.result;

    await tx.insert(payslips).values({
      tenantId: args.tenantId,
      runId: args.runId,
      employeeId: slip.employeeId,
      employeeName: who?.name ?? "Unknown",
      employeeCode: who?.code ?? "-",
      daysInMonth: args.daysInMonth,
      payableDays: String(
        attendance?.payableDays ??
          args.outcome.payableDaysByEmployee.get(slip.employeeId) ??
          args.daysInMonth,
      ),
      /**
       * ⚠️ THE CHARGED FIGURE, NOT THE RECORDED ONE. Where they differ,
       * `withAttendanceStory()` has already put a PROBLEM on this payslip
       * naming the difference, so the run cannot be approved. Printing
       * the recorded figure here instead would state a deduction the
       * arithmetic did not make.
       */
      lopDays: String(attendance?.chargedLopDays ?? 0),
      grossMinor: r.grossEarningsMinor.toString(),
      pfWagesMinor: r.pfWagesMinor.toString(),
      employeePfMinor: r.employeePfMinor.toString(),
      employerPfMinor: r.employerPfMinor.toString(),
      employerPensionMinor: r.employerPensionMinor.toString(),
      edliMinor: r.employerEdliMinor.toString(),
      pfAdminMinor: r.employerPfAdminMinor.toString(),
      employeeEsiMinor: r.employeeEsiMinor.toString(),
      employerEsiMinor: r.employerEsiMinor.toString(),
      professionalTaxMinor: r.professionalTaxMinor.toString(),
      tdsMinor: r.tdsMinor.toString(),
      otherDeductionsMinor: r.otherDeductionsMinor.toString(),
      totalDeductionsMinor: r.totalDeductionsMinor.toString(),
      netPayMinor: r.netPayMinor.toString(),
      tdsIsProjection: r.tdsIsProjection,
      tdsOverridden: r.tdsOverridden,
      lines: r.lines.map((l) => ({
        ...l,
        fullMonthMinor: l.fullMonthMinor.toString(),
        amountMinor: l.amountMinor.toString(),
      })),
      notes: [...r.notes],
      problems: [...r.problems],
    });
  }

  const t = args.outcome.totals;
  await tx
    .update(payrollRuns)
    .set({
      status: "computed",
      computedAt: new Date(),
      employeeCount: t.employeeCount,
      grossMinor: t.grossMinor.toString(),
      employeePfMinor: t.employeePfMinor.toString(),
      employerPfMinor: t.employerPfMinor.toString(),
      employerPensionMinor: t.employerPensionMinor.toString(),
      edliMinor: t.edliMinor.toString(),
      pfAdminMinor: t.pfAdminMinor.toString(),
      employeeEsiMinor: t.employeeEsiMinor.toString(),
      employerEsiMinor: t.employerEsiMinor.toString(),
      professionalTaxMinor: t.professionalTaxMinor.toString(),
      tdsMinor: t.tdsMinor.toString(),
      otherDeductionsMinor: t.otherDeductionsMinor.toString(),
      netPayMinor: t.netPayMinor.toString(),
      employerCostMinor: t.employerCostMinor.toString(),
      problemCount: t.withProblems,
    })
    .where(eq(payrollRuns.id, args.runId));
}
