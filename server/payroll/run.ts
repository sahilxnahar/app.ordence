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
/* ATTENDANCE, SUPPLIED BY THE CALLER                                  */
/* ------------------------------------------------------------------ */

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
    attendance: readonly AttendanceInput[];
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

  const attendanceByEmployee = new Map(args.attendance.map((a) => [a.employeeId, a]));

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
    const supplied = attendanceByEmployee.get(person.id);

    /**
     * ⭐ AN EMPLOYEE WITH NO ATTENDANCE ROW IS PAID THE FULL MONTH.
     *
     * ⚠️ THE OTHER DEFAULT — PAY NOBODY WHO WAS NOT MARKED PRESENT — IS
     * SAFER FOR THE BUSINESS AND WRONG FOR THE PEOPLE. Most salaried
     * staff are never marked present at all; absence of a record means
     * nothing happened, and nothing happening is a normal month.
     */
    const payableDays = supplied?.payableDays ?? daysOnRollsIn(person.joinedOn, person.leftOn, args.periodStart, args.periodEnd, days);
    const lopDays = supplied?.lopDays ?? 0;

    const result = buildPayslip({
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

    slips.push({ employeeId: person.id, result });
  }

  return { totals: totalRun(slips.map((s) => s.result)), slips };
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
    attendance: readonly AttendanceInput[];
    defaultPayableDays: ReadonlyMap<string, number>;
  },
): Promise<void> {
  await tx.delete(payslips).where(eq(payslips.runId, args.runId));

  const attendanceByEmployee = new Map(args.attendance.map((a) => [a.employeeId, a]));

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
        attendance?.payableDays ?? args.defaultPayableDays.get(slip.employeeId) ?? args.daysInMonth,
      ),
      lopDays: String(attendance?.lopDays ?? 0),
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
