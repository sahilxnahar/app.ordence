/**
 * Ordence — ⭐⭐⭐ THE BILL YOU MUST PAY BEFORE 31 MARCH
 * Version: v1.11.0-alpha
 *
 * Pure. No database, no clock. `today` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RULE THAT DECIDES WHICH VENDOR GETS PAID FIRST
 * ══════════════════════════════════════════════════════════════════════
 * A sum payable to a **micro or small enterprise** beyond the time limit
 * in **section 15 of the MSMED Act 2006** is allowed as a deduction
 * **only on actual payment**.
 *
 * ⚠️ In plain terms: an unpaid MSME bill sitting on the books at 31
 * March is **added back to taxable income** for that year. Not delayed.
 * Added back. The deduction returns in whichever year the money actually
 * moves, which is a cash-flow problem converted into a tax problem.
 *
 * ⭐ AND THIS IS WHY IT BELONGS IN A PAYMENT RUN RATHER THAN A REPORT.
 * Two bills of the same size and the same age are not equally urgent.
 * One of them costs 25% of its value if it is still there on 1 April,
 * and the other one does not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE STATUTE WAS RENUMBERED, AND BOTH CITATIONS ARE CARRIED
 * ══════════════════════════════════════════════════════════════════════
 * The rule arrived as **s.43B(h) of the Income Tax Act 1961**, effective
 * from assessment year 2024-25. From **tax year 2026-27** it is
 * **s.37(2)(g) of the Income Tax Act 2025**.
 *
 * 🔴 Both are cited, because a firm looking at a FY 2024-25 assessment
 * and a firm looking at this year need different section numbers for the
 * same rule, and a product that names only one of them looks wrong to
 * one of them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FOUR THINGS THAT ARE COMMONLY GOT WRONG
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① **Medium enterprises are NOT covered.** Only micro and small. A
 *    vendor waving an Udyam certificate is not automatically in scope,
 *    and treating every registered MSME as in scope makes the report
 *    cry wolf until nobody reads it.
 *
 * ② **Traders are NOT covered.** Only manufacturers and service
 *    providers are "suppliers" under s.15 of the MSMED Act. A trading
 *    firm registered on Udyam for lending purposes is outside it.
 *
 * ③ **15 days, not 45, unless there is a written agreement.** The
 *    default is fifteen. Forty-five is the maximum a written agreement
 *    can stretch to, and no contract can exceed it however it is worded.
 *
 * ④ **Paid late but before 31 March is still deductible.** The
 *    disallowance bites on what is OUTSTANDING at year end, not on
 *    lateness itself. Late payment costs interest; unpaid at year end
 *    costs the deduction.
 */

export class MsmeError extends Error {}

/* ------------------------------------------------------------------ */

export type MsmeCategory = "micro" | "small" | "medium" | "not_registered";

/**
 * 🔴 What the vendor actually DOES, which decides whether s.15 reaches
 * them at all. A trader registered on Udyam is not a "supplier".
 */
export type SupplierKind = "manufacturer" | "service_provider" | "trader" | "unknown";

export type MsmeScope = {
  /** 🔴 Whether s.15 and the disallowance reach this vendor at all. */
  inScope: boolean;
  reason: string;
  citation: string;
  /** ⚠️ True where the answer depends on something nobody has recorded. */
  uncertain: boolean;
};

export function msmeScope(args: {
  category: MsmeCategory;
  supplierKind: SupplierKind;
}): MsmeScope {
  if (args.category === "not_registered") {
    return {
      inScope: false,
      reason:
        "This vendor is not recorded as a registered micro or small enterprise, so the 45 day rule does not reach them.",
      citation: "s.15 MSMED Act 2006",
      uncertain: false,
    };
  }

  if (args.category === "medium") {
    return {
      inScope: false,
      reason:
        "Medium enterprises are outside the rule. It reaches micro and small enterprises only, and treating every registered MSME as in scope makes the report cry wolf until nobody reads it.",
      citation: "s.43B(h) IT Act 1961 / s.37(2)(g) IT Act 2025",
      uncertain: false,
    };
  }

  if (args.supplierKind === "trader") {
    return {
      inScope: false,
      reason:
        "Only manufacturers and service providers are suppliers under s.15 of the MSMED Act. A trading firm registered on Udyam for lending purposes is outside it.",
      citation: "s.2(n) read with s.15 MSMED Act 2006",
      uncertain: false,
    };
  }

  if (args.supplierKind === "unknown") {
    /**
     * ⚠️ NOT SILENTLY ASSUMED EITHER WAY. Assuming in-scope produces a
     * report full of vendors it does not apply to; assuming out-of-scope
     * loses the deduction. So it is flagged, and the answer is the
     * cautious one.
     */
    return {
      inScope: true,
      reason:
        "This vendor is a registered micro or small enterprise, but nobody has recorded whether they manufacture, supply services or trade. Ordence has assumed the rule applies, which is the answer that does not lose a deduction if it is right.",
      citation: "s.43B(h) IT Act 1961 / s.37(2)(g) IT Act 2025",
      uncertain: true,
    };
  }

  return {
    inScope: true,
    reason: `This vendor is a registered ${args.category} enterprise supplying ${
      args.supplierKind === "manufacturer" ? "goods it manufactures" : "services"
    }, so a sum still payable to them beyond the s.15 limit is deductible only when it is actually paid.`,
    citation: "s.43B(h) IT Act 1961 / s.37(2)(g) IT Act 2025",
    uncertain: false,
  };
}

/* ------------------------------------------------------------------ */
/* THE DEADLINE                                                        */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

export function assertDay(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new MsmeError(`Expected a date as YYYY-MM-DD, got "${iso}".`);
  }
  return iso;
}

export function addDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new MsmeError("Days must be whole.");
  return new Date(Date.parse(`${assertDay(iso)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${assertDay(to)}T00:00:00Z`) - Date.parse(`${assertDay(from)}T00:00:00Z`)) /
      DAY_MS,
  );
}

/** ⭐ 31 March of the financial year the day falls in. */
export function financialYearEnd(day: string): string {
  const iso = assertDay(day);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  /** April to March. January to March belongs to the year that started last April. */
  return month >= 4 ? `${year + 1}-03-31` : `${year}-03-31`;
}

export type MsmeDeadline = {
  /** The appointed day: payment is late from here. */
  dueOn: string;
  daysAllowed: number;
  citation: string;
  note: string;
};

/**
 * ⭐⭐ WHEN THE MONEY IS DUE UNDER SECTION 15.
 *
 * 🔴 FIFTEEN DAYS IS THE DEFAULT, NOT FORTY-FIVE. Forty-five is the
 *    maximum a **written** agreement can stretch to, and no contract can
 *    exceed it however it is drafted. Most firms assume 45 and most of
 *    their purchases have no written agreement at all.
 *
 * ⚠️ AND THE CLOCK RUNS FROM ACCEPTANCE, NOT FROM THE INVOICE. Where
 * nobody objected in writing, acceptance is deemed 15 days after
 * delivery, which is why the goods receipt date matters and the invoice
 * date usually does not.
 */
export function msmeDueDate(args: {
  /** The date the goods or services were accepted, or deemed accepted. */
  acceptedOn: string;
  /** ⭐ A written agreement, and what it says. Capped at 45 by statute. */
  writtenAgreementDays?: number | null;
}): MsmeDeadline {
  assertDay(args.acceptedOn);

  const agreed = args.writtenAgreementDays;
  if (agreed === null || agreed === undefined) {
    return {
      dueOn: addDays(args.acceptedOn, 15),
      daysAllowed: 15,
      citation: "s.15 MSMED Act 2006",
      note: "No written agreement is recorded, so the statutory fifteen days apply. Forty-five is the maximum a written agreement can reach, not the default.",
    };
  }

  if (!Number.isInteger(agreed) || agreed <= 0) {
    throw new MsmeError("An agreed credit period must be a whole number of days above zero.");
  }

  if (agreed > 45) {
    /**
     * 🔴 THE CONTRACT DOES NOT WIN. s.15 caps the period at forty-five
     * days "from the day of acceptance", and a ninety day payment clause
     * is simply void to that extent. A product that honours the contract
     * here reports a deadline the statute does not recognise.
     */
    return {
      dueOn: addDays(args.acceptedOn, 45),
      daysAllowed: 45,
      citation: "s.15 MSMED Act 2006, second proviso",
      note: `The agreement says ${agreed} days, but no contract can exceed forty-five. The clause is void to that extent and the deadline is forty-five days, whatever was signed.`,
    };
  }

  return {
    dueOn: addDays(args.acceptedOn, agreed),
    daysAllowed: agreed,
    citation: "s.15 MSMED Act 2006",
    note: `A written agreement of ${agreed} days is on file, which is within the forty-five day ceiling.`,
  };
}

/* ------------------------------------------------------------------ */
/* WHAT IT COSTS                                                       */
/* ------------------------------------------------------------------ */

export type MsmeVerdict = {
  inScope: boolean;
  dueOn: string | null;
  daysLate: number;
  /** 🔴 The deduction is lost for this year if it is still unpaid at 31 March. */
  deductionAtRisk: boolean;
  financialYearEndsOn: string;
  daysToYearEnd: number;
  /** ⚠️ Mandatory, compounding, and never deductible. */
  interestMinor: bigint;
  /**
   * How urgently to pay it, for the payment run. Higher is sooner.
   */
  priority: number;
  headline: string;
  detail: string;
  citation: string;
  uncertain: boolean;
};

/**
 * 🔴 SECTION 16 INTEREST: THREE TIMES THE RBI BANK RATE, COMPOUNDED
 *    MONTHLY, AND NOT DEDUCTIBLE UNDER ANY SECTION OF THE INCOME TAX
 *    ACT.
 *
 * ⚠️ THE RATE IS AN ARGUMENT, NOT A CONSTANT. The bank rate moves, and a
 * multiple of a stale rate is a stale rate. The caller supplies the
 * current bank rate in basis points; there is no default that could
 * quietly go out of date.
 */
export function msmeInterestMinor(args: {
  principalMinor: bigint;
  dueOn: string;
  paidOn: string;
  /** RBI bank rate in basis points. 600 = 6.00%. */
  bankRateBps: number;
}): bigint {
  if (args.principalMinor < 0n) throw new MsmeError("A principal cannot be negative.");
  if (!Number.isInteger(args.bankRateBps) || args.bankRateBps < 0) {
    throw new MsmeError("A bank rate must be a whole number of basis points, zero or more.");
  }
  const days = daysBetween(args.dueOn, args.paidOn);
  if (days <= 0) return 0n;

  /** Three times the bank rate, per annum. */
  const annualBps = BigInt(args.bankRateBps) * 3n;
  const months = Math.floor(days / 30);
  const spareDays = days % 30;

  /**
   * ⭐ Monthly compounding in integer arithmetic. Each month multiplies
   * by (10000*12 + annualBps) / (10000*12), done as a bigint ratio so
   * nothing ever becomes a float.
   */
  const denom = 10_000n * 12n;
  const num = denom + annualBps;

  let amount = args.principalMinor;
  for (let i = 0; i < months; i++) {
    amount = (amount * num) / denom;
  }
  /** ⚠️ The part month is simple, not compounded. Rounding down favours nobody. */
  const partMonth = (amount * annualBps * BigInt(spareDays)) / (10_000n * 365n);

  return amount - args.principalMinor + partMonth;
}

/**
 * ⭐⭐ THE WHOLE VERDICT FOR ONE UNPAID BILL.
 */
export function assessMsmeBill(args: {
  category: MsmeCategory;
  supplierKind: SupplierKind;
  acceptedOn: string | null;
  writtenAgreementDays?: number | null;
  outstandingMinor: bigint;
  today: string;
  bankRateBps: number;
}): MsmeVerdict {
  assertDay(args.today);
  const scope = msmeScope({ category: args.category, supplierKind: args.supplierKind });
  const fyEnd = financialYearEnd(args.today);
  const daysToYearEnd = daysBetween(args.today, fyEnd);

  if (!scope.inScope) {
    return {
      inScope: false,
      dueOn: null,
      daysLate: 0,
      deductionAtRisk: false,
      financialYearEndsOn: fyEnd,
      daysToYearEnd,
      interestMinor: 0n,
      priority: 0,
      headline: "Not an MSME bill",
      detail: scope.reason,
      citation: scope.citation,
      uncertain: false,
    };
  }

  if (args.acceptedOn === null) {
    /**
     * ⚠️ NO ACCEPTANCE DATE MEANS NO DEADLINE CAN BE COMPUTED, and that
     * is itself dangerous: a bill with no deadline never appears on the
     * report that would have saved the deduction. Reported loudly rather
     * than skipped.
     */
    return {
      inScope: true,
      dueOn: null,
      daysLate: 0,
      deductionAtRisk: true,
      financialYearEndsOn: fyEnd,
      daysToYearEnd,
      interestMinor: 0n,
      priority: 60,
      headline: "MSME bill with no acceptance date",
      detail:
        "This is a micro or small enterprise bill and nothing records when the goods or services were accepted, so the section 15 deadline cannot be worked out. It will never appear on the report that would have saved the deduction. Record the receipt date.",
      citation: scope.citation,
      uncertain: true,
    };
  }

  const deadline = msmeDueDate({
    acceptedOn: args.acceptedOn,
    writtenAgreementDays: args.writtenAgreementDays,
  });
  const daysLate = Math.max(0, daysBetween(deadline.dueOn, args.today));
  const interest =
    daysLate > 0
      ? msmeInterestMinor({
          principalMinor: args.outstandingMinor,
          dueOn: deadline.dueOn,
          paidOn: args.today,
          bankRateBps: args.bankRateBps,
        })
      : 0n;

  /**
   * 🔴 THE DISALLOWANCE BITES ON WHAT IS OUTSTANDING AT 31 MARCH, NOT ON
   *    LATENESS. A bill paid late but before year end keeps its
   *    deduction; it just costs interest.
   */
  const willBeLateAtYearEnd = deadline.dueOn <= fyEnd;
  const deductionAtRisk = args.outstandingMinor > 0n && willBeLateAtYearEnd;

  /**
   * ⭐ PRIORITY FOR THE PAYMENT RUN.
   * The closer to 31 March with the deduction at risk, the louder.
   */
  let priority = 0;
  if (deductionAtRisk) {
    priority = daysToYearEnd <= 30 ? 100 : daysToYearEnd <= 90 ? 80 : 50;
  } else if (daysLate > 0) {
    priority = 40;
  }

  const headline = deductionAtRisk
    ? daysToYearEnd <= 30
      ? `Pay before 31 March or lose the deduction (${daysToYearEnd} days)`
      : "Deduction at risk if unpaid at 31 March"
    : daysLate > 0
      ? `${daysLate} days late, interest running`
      : `Due ${deadline.dueOn}`;

  const detail = [
    deadline.note,
    daysLate > 0
      ? `It is ${daysLate} days past the appointed day, so interest under s.16 of the MSMED Act is running at three times the RBI bank rate, compounded monthly. That interest is not deductible under any section of the Income Tax Act.`
      : null,
    deductionAtRisk
      ? `If this is still unpaid on ${fyEnd} the whole expense is added back to taxable income for the year, and the deduction only returns in the year the money actually moves.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    inScope: true,
    dueOn: deadline.dueOn,
    daysLate,
    deductionAtRisk,
    financialYearEndsOn: fyEnd,
    daysToYearEnd,
    interestMinor: interest,
    priority,
    headline,
    detail,
    citation: `${deadline.citation}; ${scope.citation}`,
    uncertain: scope.uncertain,
  };
}
