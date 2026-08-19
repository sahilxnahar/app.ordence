/**
 * Ordence — ⭐⭐⭐ THE STATUTORY ENGINE
 * Version: v1.23.0-alpha
 *
 * Pure. No database, no network, no clock. Every date is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 NOT ONE RATE IN THIS FILE IS A CONSTANT
 * ══════════════════════════════════════════════════════════════════════
 * Every percentage, every ceiling and every slab arrives as an argument,
 * loaded from an effective-dated table. The numbers written in the
 * comments below are what the law says TODAY, and they are in comments
 * precisely so that nobody edits code when they change.
 *
 * ⚠️ THE FAILURE THIS PREVENTS IS SPECIFIC AND ANNUAL. The Finance Act
 * changes something every February. A rate compiled into a function
 * means a deploy in the middle of a payroll cycle, and — far worse — it
 * means March's payslips get recalculated with April's rate the next
 * time anybody reruns them. Payroll is retrospective by nature: you
 * reissue a payslip months later and it must produce the number the
 * employee was actually paid.
 *
 * 🔴 SO EVERY CALCULATION TAKES THE RATES THAT WERE IN FORCE ON THE
 * PERIOD'S OWN DATES, and the caller is responsible for selecting them.
 * `pickEffective` below is how it does that.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not decide who is an employee, it does not know about
 * attendance, and it does not touch the ledger. It answers exactly one
 * question: given a set of earnings and a set of rules, what is
 * withheld and what does the employer owe on top.
 */

/* ------------------------------------------------------------------ */
/* MONEY                                                               */
/* ------------------------------------------------------------------ */

/**
 * 🔴 EVERY AMOUNT IN THIS FILE IS `bigint` PAISE. Payroll in floating
 * point produces a payslip that does not add up to itself, and the
 * person who notices is the employee.
 */
export type Paise = bigint;

/**
 * ⚠️ STATUTORY ROUNDING IS TO THE RUPEE AND IT IS NOT "round half up"
 * EVERYWHERE.
 *
 * PF and ESI are rounded to the nearest rupee. TDS is rounded to the
 * nearest rupee. Professional tax is a slab amount and needs no
 * rounding at all. Applying one rule to all three would be tidier and
 * would disagree with the challan.
 */
export function roundToRupee(paise: Paise): Paise {
  const rupees = paise / 100n;
  const remainder = paise % 100n;
  // ⚠️ Half rounds AWAY from zero, which is what "nearest rupee" means
  // on a challan. Banker's rounding would be defensible in a spreadsheet
  // and would differ from the department's own arithmetic.
  if (remainder >= 50n) return (rupees + 1n) * 100n;
  if (remainder <= -50n) return (rupees - 1n) * 100n;
  return rupees * 100n;
}

/** ⚠️ Always rounds DOWN, and only ever used where the law says so. */
export function floorToRupee(paise: Paise): Paise {
  return (paise / 100n) * 100n;
}

/* ------------------------------------------------------------------ */
/* EFFECTIVE DATING                                                    */
/* ------------------------------------------------------------------ */

export interface EffectiveDated {
  /** ISO date, inclusive. */
  readonly effectiveFrom: string;
  /** ISO date, inclusive. Null means "still in force". */
  readonly effectiveTo: string | null;
}

/**
 * ⭐ THE ROW IN FORCE ON A GIVEN DAY, or null.
 *
 * ⚠️ IT RETURNS NULL RATHER THAN FALLING BACK TO THE NEWEST ROW. A
 * fallback here would mean a payroll for a period with no configured
 * rates silently uses today's, produce a plausible payslip, and be
 * discovered at assessment. Refusing is the only safe answer.
 */
export function pickEffective<T extends EffectiveDated>(
  rows: readonly T[],
  onDate: string,
): T | null {
  const matches = rows.filter(
    (r) => r.effectiveFrom <= onDate && (r.effectiveTo === null || r.effectiveTo >= onDate),
  );
  if (matches.length === 0) return null;
  // ⚠️ Latest start wins, so an overlapping correction row supersedes
  // the original rather than being ambiguous.
  return [...matches].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]!;
}

/* ------------------------------------------------------------------ */
/* ① PROVIDENT FUND                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE EMPLOYER'S 12% SPLITS, AND THE SPLIT IS NOT COSMETIC.
 *
 * Of the employer's contribution, part goes to the Pension Scheme (EPS)
 * and the rest to the Provident Fund. EPS is capped at the statutory
 * wage ceiling EVEN WHEN the PF contribution itself is not — an employer
 * who voluntarily contributes on full wages still pays EPS on ₹15,000.
 *
 * ⚠️ TWO PAYABLE ACCOUNTS AND NOT ONE. The challan separates them, and
 * a single "PF payable" balance cannot be reconciled against an ECR.
 *
 * Today's numbers, for the reader rather than for the code:
 *   employee 12% · employer 12% (8.33% EPS + 3.67% EPF) · ceiling ₹15,000
 *   EDLI 0.50% · administration 0.50%, both employer-only
 */
export interface PfRules extends EffectiveDated {
  readonly employeeRateBp: number;
  readonly employerRateBp: number;
  /** Of the employer's share, the portion that goes to pension. */
  readonly pensionRateBp: number;
  readonly edliRateBp: number;
  readonly adminRateBp: number;
  /** Paise. Wages above this are ignored unless `contributeAboveCeiling`. */
  readonly wageCeilingMinor: string;
  /** Paise. Below this an employee may be excluded entirely. */
  readonly pensionCeilingMinor: string;
}

export interface PfResult {
  readonly pfWagesMinor: Paise;
  readonly employeeMinor: Paise;
  readonly employerPfMinor: Paise;
  readonly employerPensionMinor: Paise;
  readonly edliMinor: Paise;
  readonly adminMinor: Paise;
  /** ⭐ What the employer pays in total. Not the same as the deduction. */
  readonly employerTotalMinor: Paise;
  readonly note: string;
}

function bp(amount: Paise, basisPoints: number): Paise {
  // ⚠️ MULTIPLY BEFORE DIVIDE, always. Dividing first throws away the
  // paise and the error compounds across five hundred employees.
  return (amount * BigInt(Math.round(basisPoints))) / 10_000n;
}

export function computePf(args: {
  /** Basic + DA + retaining allowance, already pro-rated for LOP. */
  readonly pfEligibleWagesMinor: Paise;
  readonly rules: PfRules;
  /**
   * ⚠️ TRUE MEANS THE EMPLOYER HAS CHOSEN TO CONTRIBUTE ON FULL WAGES.
   * It is a real and common choice, it is irreversible in practice, and
   * it must be a property of the employee rather than a global setting.
   */
  readonly contributeAboveCeiling: boolean;
  /** An employee who has opted out, or who is above the ceiling on joining. */
  readonly isExempt: boolean;
}): PfResult {
  const zero: PfResult = {
    pfWagesMinor: 0n,
    employeeMinor: 0n,
    employerPfMinor: 0n,
    employerPensionMinor: 0n,
    edliMinor: 0n,
    adminMinor: 0n,
    employerTotalMinor: 0n,
    note: "Not covered by provident fund.",
  };

  if (args.isExempt) return zero;

  const ceiling = BigInt(args.rules.wageCeilingMinor);
  const actual = args.pfEligibleWagesMinor;

  const pfWages = args.contributeAboveCeiling ? actual : actual < ceiling ? actual : ceiling;

  // 🔴 THE PENSION BASE IS CAPPED SEPARATELY AND ALWAYS.
  const pensionBase = actual < BigInt(args.rules.pensionCeilingMinor)
    ? actual
    : BigInt(args.rules.pensionCeilingMinor);

  const employee = roundToRupee(bp(pfWages, args.rules.employeeRateBp));
  const employerTotal = roundToRupee(bp(pfWages, args.rules.employerRateBp));
  const pension = roundToRupee(bp(pensionBase, args.rules.pensionRateBp));

  // ⚠️ THE PF HALF IS THE REMAINDER, NEVER ITS OWN PERCENTAGE. Computing
  // both from rates independently leaves a rupee of rounding that
  // belongs to neither account, and the ECR then rejects the file.
  const employerPf = employerTotal - pension;

  const edli = roundToRupee(bp(pensionBase, args.rules.edliRateBp));
  const admin = roundToRupee(bp(pfWages, args.rules.adminRateBp));

  return {
    pfWagesMinor: pfWages,
    employeeMinor: employee,
    employerPfMinor: employerPf,
    employerPensionMinor: pension,
    edliMinor: edli,
    adminMinor: admin,
    employerTotalMinor: employerPf + pension + edli + admin,
    note: args.contributeAboveCeiling
      ? "Contributed on full wages by employer choice. Pension is still capped at the statutory ceiling."
      : actual > ceiling
        ? "Wages exceed the statutory ceiling, so contributions are on the ceiling."
        : "Contributed on actual wages.",
  };
}

/* ------------------------------------------------------------------ */
/* ② EMPLOYEES' STATE INSURANCE                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ESI HAS A CLIFF, NOT A CEILING, AND THAT IS THE WHOLE TRAP.
 *
 * PF contributes on the ceiling when wages exceed it. ESI STOPS
 * ALTOGETHER. Treating ESI like PF deducts 0.75% of ₹21,000 from
 * somebody earning ₹40,000 who is not covered at all.
 *
 * 🔴 AND THE CONTRIBUTION PERIOD RULE IS STRANGER STILL. An employee who
 * crosses the limit mid-period stays covered until the END of the
 * contribution period (April–September, October–March). Dropping them
 * the month they get a rise is wrong, and it is wrong in the direction
 * that loses them medical cover.
 *
 * Today: employee 0.75% · employer 3.25% · limit ₹21,000 gross.
 */
export interface EsiRules extends EffectiveDated {
  readonly employeeRateBp: number;
  readonly employerRateBp: number;
  /** Paise. Gross ABOVE this and the employee is out entirely. */
  readonly wageLimitMinor: string;
}

export interface EsiResult {
  readonly covered: boolean;
  readonly esiWagesMinor: Paise;
  readonly employeeMinor: Paise;
  readonly employerMinor: Paise;
  readonly note: string;
}

export function computeEsi(args: {
  /** Gross for ESI purposes, pro-rated. */
  readonly grossMinor: Paise;
  readonly rules: EsiRules;
  /**
   * ⭐ TRUE WHEN THE EMPLOYEE WAS COVERED AT THE START OF THE CURRENT
   * CONTRIBUTION PERIOD. Set by the caller from history; this function
   * does not know what month it is.
   */
  readonly coveredAtPeriodStart: boolean;
  readonly isExempt: boolean;
}): EsiResult {
  if (args.isExempt) {
    return {
      covered: false,
      esiWagesMinor: 0n,
      employeeMinor: 0n,
      employerMinor: 0n,
      note: "Not covered by ESI.",
    };
  }

  const limit = BigInt(args.rules.wageLimitMinor);
  const overLimit = args.grossMinor > limit;

  // 🔴 THE CONTINUATION RULE. Over the limit but covered when the period
  // began means still covered, on ACTUAL wages, not on the limit.
  const covered = !overLimit || args.coveredAtPeriodStart;

  if (!covered) {
    return {
      covered: false,
      esiWagesMinor: 0n,
      employeeMinor: 0n,
      employerMinor: 0n,
      note: "Gross is above the ESI wage limit, so no contribution is due.",
    };
  }

  // ⚠️ ESI IS ROUNDED UP TO THE NEXT RUPEE, both halves, by regulation.
  // This is the one place the general `roundToRupee` would be wrong.
  //
  // 🔴 AND IT ROUNDS UP FROM THE EXACT VALUE, NOT FROM A TRUNCATED ONE.
  // `bp()` divides by 10,000 in integer arithmetic and throws away the
  // sub-paise remainder first, so ₹18,001 at 0.75% — which is 13,500.75
  // paise — would truncate to 13,500 and then "round up" to ₹135, when
  // the regulation says ₹136. One rupee, on every payslip, in the
  // employer's favour, discovered by whoever reconciles the challan.
  const employee = ceilRupeeFromBp(args.grossMinor, args.rules.employeeRateBp);
  const employer = ceilRupeeFromBp(args.grossMinor, args.rules.employerRateBp);

  return {
    covered: true,
    esiWagesMinor: args.grossMinor,
    employeeMinor: employee,
    employerMinor: employer,
    note: overLimit
      ? "Above the wage limit but covered for the rest of this contribution period, on actual wages."
      : "Covered on actual wages.",
  };
}

export function ceilToRupee(paise: Paise): Paise {
  const remainder = paise % 100n;
  return remainder === 0n ? paise : ((paise / 100n) + 1n) * 100n;
}

/**
 * ⭐ CEILING TO THE RUPEE WITHOUT LOSING THE SUB-PAISE ON THE WAY.
 *
 * ⚠️ One division, at the end. `amount × rate / 10,000` then ceiling to
 * a rupee is `ceil(amount × rate / 1,000,000) × 100` — and doing it in
 * two steps truncates a remainder that would have pushed the answer to
 * the next rupee.
 */
function ceilRupeeFromBp(amount: Paise, basisPoints: number): Paise {
  const numerator = amount * BigInt(Math.round(basisPoints));
  const denominator = 1_000_000n; // 10,000 basis points × 100 paise
  const whole = numerator / denominator;
  return (numerator % denominator === 0n ? whole : whole + 1n) * 100n;
}

/* ------------------------------------------------------------------ */
/* ③ PROFESSIONAL TAX                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ PROFESSIONAL TAX IS A STATE TAX AND THE STATES DISAGREE ABOUT
 * EVERYTHING — the slabs, the amounts, whether there is a February
 * top-up, and whether it exists at all.
 *
 * 🔴 SO IT IS A TABLE OF SLABS KEYED BY STATE, and a state with no rows
 * means no professional tax rather than an error. Delhi, Haryana, Uttar
 * Pradesh and several others genuinely do not levy it, and treating the
 * absence of slabs as a misconfiguration would block payroll in half the
 * country.
 */
export interface PtSlab extends EffectiveDated {
  readonly stateCode: string;
  /** Paise, inclusive. */
  readonly fromMinor: string;
  /** Paise, inclusive. Null means no upper bound. */
  readonly toMinor: string | null;
  readonly amountMinor: string;
  /**
   * ⭐ SOME STATES CHARGE A DIFFERENT AMOUNT IN ONE MONTH OF THE YEAR.
   * Maharashtra's February is the well-known one. Null means the same
   * every month.
   */
  readonly februaryAmountMinor: string | null;
}

export function computeProfessionalTax(args: {
  readonly grossMinor: Paise;
  readonly stateCode: string;
  readonly month: number;
  readonly slabs: readonly PtSlab[];
  readonly onDate: string;
}): { amountMinor: Paise; note: string } {
  const forState = args.slabs.filter(
    (s) =>
      s.stateCode === args.stateCode &&
      s.effectiveFrom <= args.onDate &&
      (s.effectiveTo === null || s.effectiveTo >= args.onDate),
  );

  if (forState.length === 0) {
    return {
      amountMinor: 0n,
      // ⚠️ SAID PLAINLY. An operator who sees zero and no explanation
      // assumes the calculation is broken and goes looking for a bug
      // that is not there.
      note: noStateSlabsNote(args.stateCode),
    };
  }

  const slab = forState.find((s) => {
    const from = BigInt(s.fromMinor);
    const to = s.toMinor === null ? null : BigInt(s.toMinor);
    return args.grossMinor >= from && (to === null || args.grossMinor <= to);
  });

  if (!slab) {
    return {
      amountMinor: 0n,
      note: `No professional tax slab in ${args.stateCode} covers this salary. That is a gap in the slab table rather than a nil liability, and it is worth checking before the challan.`,
    };
  }

  const isFebruary = args.month === 2;
  const amount =
    isFebruary && slab.februaryAmountMinor !== null
      ? BigInt(slab.februaryAmountMinor)
      : BigInt(slab.amountMinor);

  return {
    amountMinor: amount,
    note:
      isFebruary && slab.februaryAmountMinor !== null
        ? `${args.stateCode} charges a different amount in February.`
        : `${args.stateCode} slab.`,
  };
}

function noStateSlabsNote(stateCode: string): string {
  return `${stateCode} has no professional tax slabs configured. Several States genuinely do not levy it, so this is a nil deduction rather than an error — but if you believe it should apply, the slabs have not been set up.`;
}

/* ------------------------------------------------------------------ */
/* ④ INCOME TAX ON SALARY                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE HONEST HEADER FOR THIS SECTION.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS A PROJECTION, AND THE CODE SAYS SO EVERYWHERE
 * ══════════════════════════════════════════════════════════════════════
 * Monthly TDS on salary under section 192 is one twelfth of the tax on
 * the EMPLOYEE'S ESTIMATED ANNUAL INCOME. That estimate depends on
 * declarations the employee has not made yet, investments they have not
 * made yet, and other income the employer does not know about.
 *
 * ⚠️ SO ANY MONTHLY TDS NUMBER IS AN ESTIMATE THAT WILL BE TRUED UP,
 * and a system that presents it as a settled figure is lying to both
 * the employee and the accountant. Every result here carries the
 * projection it was built from, and the payslip prints it.
 *
 * ⭐ AND AN OVERRIDE IS FIRST-CLASS, NOT A HACK. Accountants run their
 * own computation, and a payroll system that will not accept the number
 * they arrived at is a payroll system that gets bypassed with a
 * spreadsheet — after which nothing in the ledger is right.
 */
export interface TaxSlab extends EffectiveDated {
  readonly regime: "new" | "old";
  readonly fromMinor: string;
  readonly toMinor: string | null;
  readonly rateBp: number;
}

export interface TaxRules extends EffectiveDated {
  readonly regime: "new" | "old";
  readonly standardDeductionMinor: string;
  /** Total income at or below which the rebate wipes the liability out. */
  readonly rebateLimitMinor: string;
  readonly rebateMaxMinor: string;
  readonly cessRateBp: number;
  /** Surcharge is deliberately out of scope. See the note below. */
  readonly surchargeThresholdMinor: string | null;
}

export interface TaxResult {
  readonly annualTaxableMinor: Paise;
  readonly annualTaxMinor: Paise;
  readonly cessMinor: Paise;
  readonly annualLiabilityMinor: Paise;
  readonly monthlyMinor: Paise;
  readonly isProjection: true;
  readonly note: string;
  readonly caveats: readonly string[];
}

export function projectMonthlyTds(args: {
  /** Taxable salary for the whole year, as currently projected. */
  readonly projectedAnnualGrossMinor: Paise;
  /** Section 80C and friends, as declared. Zero under the new regime. */
  readonly declaredDeductionsMinor: Paise;
  /** Professional tax paid is itself deductible under the old regime. */
  readonly annualProfessionalTaxMinor: Paise;
  readonly rules: TaxRules;
  readonly slabs: readonly TaxSlab[];
  /** Months left in the year INCLUDING this one. Never zero. */
  readonly monthsRemaining: number;
  /** Tax already withheld this year. */
  readonly alreadyDeductedMinor: Paise;
}): TaxResult {
  const caveats: string[] = [
    "This is an estimate of the year's tax spread over the months remaining, not a settled amount.",
  ];

  const standard = BigInt(args.rules.standardDeductionMinor);

  // ⚠️ THE OLD REGIME ALLOWS PROFESSIONAL TAX AND CHAPTER VI-A; THE NEW
  // ONE ALLOWS NEITHER. Applying both to both is the single most common
  // payroll bug in the country and it always under-withholds.
  const deductions =
    args.rules.regime === "old"
      ? standard + args.declaredDeductionsMinor + args.annualProfessionalTaxMinor
      : standard;

  if (args.rules.regime === "new" && args.declaredDeductionsMinor > 0n) {
    caveats.push(
      "Declared investments have been ignored because this employee is on the new regime, which does not allow them.",
    );
  }

  const taxableRaw = args.projectedAnnualGrossMinor - deductions;
  const taxable = taxableRaw > 0n ? floorToRupee(taxableRaw) : 0n;

  const slabs = args.slabs
    .filter((s) => s.regime === args.rules.regime)
    .sort((a, b) => (BigInt(a.fromMinor) < BigInt(b.fromMinor) ? -1 : 1));

  let tax = 0n;
  for (const slab of slabs) {
    const from = BigInt(slab.fromMinor);
    const to = slab.toMinor === null ? null : BigInt(slab.toMinor);
    if (taxable <= from) continue;
    const upper = to === null ? taxable : taxable < to ? taxable : to;
    tax += bp(upper - from, slab.rateBp);
  }

  // ⭐ THE REBATE, WHICH IS A CLIFF AND NOT A TAPER. One rupee over the
  // limit and the whole rebate disappears, which is why an employee just
  // above it can take home less than one just below.
  const rebateLimit = BigInt(args.rules.rebateLimitMinor);
  if (taxable <= rebateLimit) {
    const rebate = BigInt(args.rules.rebateMaxMinor);
    tax = tax > rebate ? tax - rebate : 0n;
  }

  const cess = bp(tax, args.rules.cessRateBp);
  const liability = roundToRupee(tax + cess);

  if (args.rules.surchargeThresholdMinor !== null &&
      taxable > BigInt(args.rules.surchargeThresholdMinor)) {
    // 🔴 REFUSED RATHER THAN GUESSED. Surcharge has marginal relief, and
    // marginal relief computed wrongly is worse than not computed: it
    // produces a number that looks right.
    caveats.push(
      "This salary is in surcharge territory. Ordence does not compute surcharge or marginal relief, so this figure is understated. Use an override with your accountant's number.",
    );
  }

  const remaining = args.monthsRemaining < 1 ? 1 : args.monthsRemaining;
  const outstanding = liability - args.alreadyDeductedMinor;
  const monthly = outstanding > 0n ? roundToRupee(outstanding / BigInt(remaining)) : 0n;

  if (outstanding <= 0n && liability > 0n) {
    caveats.push(
      "The year's estimated tax has already been withheld, so nothing further is due this month. If the estimate rises later, the remaining months carry the difference.",
    );
  }

  return {
    annualTaxableMinor: taxable,
    annualTaxMinor: tax,
    cessMinor: cess,
    annualLiabilityMinor: liability,
    monthlyMinor: monthly,
    isProjection: true,
    note: `Estimated on a projected annual taxable income of ₹${(taxable / 100n).toLocaleString("en-IN")}, spread over ${remaining} month${remaining === 1 ? "" : "s"}.`,
    caveats,
  };
}
