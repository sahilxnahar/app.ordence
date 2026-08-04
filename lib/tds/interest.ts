/**
 * Ordence — ⭐ Section 201(1A) Interest and Section 234E Fee
 * Version: v0.36.0-alpha
 *
 * Pure. `bigint` paise, integer basis points, civil-day strings.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO RATES, AND THEY MEASURE FROM DIFFERENT PLACES
 * ══════════════════════════════════════════════════════════════════════
 *   201(1A)(i)  — ONE per cent per month, from the date the tax was
 *                 DEDUCTIBLE to the date it was actually DEDUCTED.
 *                 This is the "we should have deducted in April and only
 *                 noticed in December" interest — and it is exactly what
 *                 the cumulative-threshold catch-up produces.
 *
 *   201(1A)(ii) — ONE AND A HALF per cent per month, from the date of
 *                 DEDUCTION to the date the tax is actually PAID.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE MISTAKE: MEASURING THE 1.5% FROM THE DUE DATE
 * ══════════════════════════════════════════════════════════════════════
 * Every accounting package that gets this wrong gets it wrong the same
 * way: it computes the deposit due date (the 7th of the following month),
 * sees the payment was three days late, and charges 1.5% for one month.
 *
 * The statute says "from the date on which such tax was DEDUCTED to the
 * date on which such tax is actually paid". Not from the due date.
 *
 *     Tax deducted 1 May, deposited 8 June — one day late.
 *     Wrong:   1 month  × 1.5% = 1.5%
 *     ⭐ Right: 2 months × 1.5% = 3.0%
 *
 * Twice the interest, on a one-day delay, and the second month is entirely
 * created by a rule about where the clock starts. On a month's TDS for a
 * mid-size developer that is real money, and TRACES computes it the right
 * way — so the demand arrives, is disputed, and is upheld.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND "MONTH" MEANS MONTH, NOT THIRTY DAYS
 * ══════════════════════════════════════════════════════════════════════
 * "for every month or part of a month". A single day into a new month is
 * a whole month's interest. Pro-rating by days is the other half of the
 * same error and it always under-charges — which means the books say the
 * exposure is smaller than the demand that is coming.
 */

import { applyRateBps } from "@/lib/billing/money";
import { depositDueDate, daysBetween, toCivilDay } from "./calendar";
import { formatPaise } from "./sections";
import type { TdsSectionCode } from "@/db/schema/tds";

/** ⭐ 201(1A)(i) — deductible and not deducted. 1% per month. */
export const INTEREST_NOT_DEDUCTED_BPS_PER_MONTH = 100;

/** ⭐ 201(1A)(ii) — deducted and not deposited. 1.5% per month. */
export const INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH = 150;

/** ⭐ Section 234E. ₹200 for every day the quarterly statement is late. */
export const LATE_FILING_FEE_PER_DAY_MINOR = 20_000n;

/** Section 272A(2)(g). ₹100 a day for a late Form 16A. */
export const LATE_CERTIFICATE_FEE_PER_DAY_MINOR = 10_000n;

/* ------------------------------------------------------------------ */
/* ⭐ MONTHS, OR PART THEREOF                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE COUNT THE WHOLE FILE TURNS ON.
 *
 * Calendar months from `from` to `to`, rounding ANY remainder up to a
 * whole month — "every month or part of a month".
 *
 *     1 May → 1 May      0 months (nothing has elapsed)
 *     1 May → 2 May      1 month  (a part of a month is a month)
 *     1 May → 1 June     1 month
 *     1 May → 2 June     2 months
 *     1 May → 8 June     2 months  ⭐ the one-day-late case
 *     7 Jun → 6 Jul      1 month   (29 days is still one)
 *
 * ⚠️ NOT `Math.ceil(days / 30)`. That gives 1 month for 1 May → 8 June
 * (38 days → 2, as it happens) but 1 month for 7 June → 6 July (29 days
 * → 1, correct) and 2 months for 1 January → 30 January in a 31-day month
 * (29 days → 1, correct) — the two agree often enough to pass a casual
 * test and disagree on precisely the month boundaries that matter.
 */
export function monthsOrPartThereof(from: string, to: string): number {
  const a = toCivilDay(from);
  const b = toCivilDay(to);
  if (b <= a) return 0;

  const ay = Number(a.slice(0, 4));
  const am = Number(a.slice(5, 7));
  const ad = Number(a.slice(8, 10));
  const by = Number(b.slice(0, 4));
  const bm = Number(b.slice(5, 7));
  const bd = Number(b.slice(8, 10));

  let months = (by - ay) * 12 + (bm - am);
  // A day past the anniversary starts another month.
  if (bd > ad) months += 1;
  // Anything at all elapsed is at least one month.
  return months <= 0 ? 1 : months;
}

/* ------------------------------------------------------------------ */
/* LATE DEPOSIT                                                        */
/* ------------------------------------------------------------------ */

export type LateDepositAssessment = {
  /** Was the deposit late at all? */
  late: boolean;
  /** The statutory deposit deadline. Rule 30. */
  dueDate: string;
  daysLate: number;
  /** ⭐ Counted from the DEDUCTION date, not from the due date. */
  monthsCharged: number;
  rateBpsPerMonth: number;
  interestMinor: bigint;
  explanation: string;
};

/**
 * ⭐ SECTION 201(1A)(ii): TAX DEDUCTED AND NOT DEPOSITED ON TIME.
 *
 * ⚠️ `monthsCharged` RUNS FROM `deductionDate`, NOT FROM `dueDate`. See
 * the file header — this is the whole point of the function, and the
 * difference on a one-day delay is a full extra month.
 *
 * ⚠️ AND THE LATENESS TEST IS AGAINST THE DUE DATE while the CHARGE runs
 * from the deduction date. Those are two different dates doing two
 * different jobs, and collapsing them into one is how the calculation
 * goes wrong in either direction: charge from the due date and it is
 * half; test against the deduction date and every on-time deposit is
 * reported as late.
 */
export function assessLateDeposit(args: {
  deductionDate: string;
  /** `null` when the tax has not been deposited at all yet. */
  depositDate: string | null;
  tdsMinor: bigint;
  section?: TdsSectionCode | null;
  /** For the "not deposited yet" case: how far the clock has run. */
  asOf?: string;
}): LateDepositAssessment {
  const deductionDate = toCivilDay(args.deductionDate);
  const dueDate = depositDueDate(deductionDate, args.section);
  const paidOn = args.depositDate ? toCivilDay(args.depositDate) : null;
  const measureTo = paidOn ?? (args.asOf ? toCivilDay(args.asOf) : null);

  if (!measureTo) {
    return {
      late: false,
      dueDate,
      daysLate: 0,
      monthsCharged: 0,
      rateBpsPerMonth: INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH,
      interestMinor: 0n,
      explanation:
        `Not yet deposited. Due on ${dueDate}. ⚠️ Interest under Section ` +
        `201(1A)(ii) runs at 1.5% per month or part of a month from the DATE OF ` +
        `DEDUCTION (${deductionDate}) — not from the due date — so the clock is ` +
        `already running.`,
    };
  }

  if (measureTo <= dueDate) {
    return {
      late: false,
      dueDate,
      daysLate: 0,
      monthsCharged: 0,
      rateBpsPerMonth: INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH,
      interestMinor: 0n,
      explanation: `Deposited on ${measureTo}, on or before the ${dueDate} deadline.`,
    };
  }

  // ⭐ FROM THE DEDUCTION DATE. See the header.
  const months = monthsOrPartThereof(deductionDate, measureTo);
  const daysLate = daysBetween(dueDate, measureTo);
  const interestMinor = applyRateBps(
    args.tdsMinor,
    INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH * months,
  );

  return {
    late: true,
    dueDate,
    daysLate,
    monthsCharged: months,
    rateBpsPerMonth: INTEREST_DEDUCTED_NOT_PAID_BPS_PER_MONTH,
    interestMinor,
    explanation:
      `⭐ ${formatPaise(args.tdsMinor)} was deducted on ${deductionDate}, was due ` +
      `on ${dueDate}, and was deposited on ${measureTo} — ${daysLate} day(s) late. ` +
      `Interest under Section 201(1A)(ii) is 1.5% for every month OR PART OF A ` +
      `MONTH from the DATE OF DEDUCTION, which is ${months} month(s): ` +
      `${formatPaise(interestMinor)}. ⚠️ Measuring from the due date instead — the ` +
      `commonest error — would give a smaller figure, and TRACES computes it this ` +
      `way. ⚠️ A part of a month is a whole month; there is no pro-rating by days.`,
  };
}

/**
 * ⭐ SECTION 201(1A)(i): TAX THAT WAS DEDUCTIBLE AND WAS NOT DEDUCTED.
 *
 * 1% per month from the day it became deductible to the day it was
 * actually deducted.
 *
 * ⚠️ THIS IS EXACTLY WHAT THE CUMULATIVE-THRESHOLD CATCH-UP PRODUCES, AND
 * IT IS THE PART PEOPLE FORGET TO PAY. When the fourth ₹25,000 payment
 * crosses ₹1,00,000 under Section 194C, the three earlier payments became
 * deductible on the day the aggregate crossed — but the tax on them is
 * being deducted now. The gap between those two dates carries interest at
 * 1%, per earlier payment, and the register has the dates to compute it
 * because `catch_up_base_minor` records that the catch-up happened.
 */
export function assessLateDeduction(args: {
  /** When the tax first became deductible. */
  deductibleFrom: string;
  /** When it was actually deducted. */
  deductedOn: string;
  tdsMinor: bigint;
}): LateDepositAssessment {
  const from = toCivilDay(args.deductibleFrom);
  const to = toCivilDay(args.deductedOn);

  if (to <= from) {
    return {
      late: false,
      dueDate: from,
      daysLate: 0,
      monthsCharged: 0,
      rateBpsPerMonth: INTEREST_NOT_DEDUCTED_BPS_PER_MONTH,
      interestMinor: 0n,
      explanation: "Deducted when it became deductible.",
    };
  }

  const months = monthsOrPartThereof(from, to);
  const interestMinor = applyRateBps(
    args.tdsMinor,
    INTEREST_NOT_DEDUCTED_BPS_PER_MONTH * months,
  );

  return {
    late: true,
    dueDate: from,
    daysLate: daysBetween(from, to),
    monthsCharged: months,
    rateBpsPerMonth: INTEREST_NOT_DEDUCTED_BPS_PER_MONTH,
    interestMinor,
    explanation:
      `⭐ ${formatPaise(args.tdsMinor)} became deductible on ${from} and was ` +
      `deducted on ${to}. Interest under Section 201(1A)(i) is 1% for every month ` +
      `or part of a month between them — ${months} month(s), ` +
      `${formatPaise(interestMinor)}. ⚠️ This is the interest a threshold catch-up ` +
      `creates, and it is the one that gets left out: the tax is paid, the ` +
      `interest on the delay in DEDUCTING it is not.`,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ SECTION 234E — THE LATE-FILING FEE                                */
/* ------------------------------------------------------------------ */

export type LateFilingAssessment = {
  late: boolean;
  daysLate: number;
  feeMinor: bigint;
  /** Was the fee limited by the cap? */
  capped: boolean;
  explanation: string;
};

/**
 * ⭐ ₹200 A DAY, CAPPED AT THE TAX DEDUCTED.
 *
 * ⚠️ IT IS A FEE, NOT A PENALTY, AND THE DIFFERENCE IS NOT SEMANTIC. A
 * penalty can be waived for reasonable cause under Section 273B; a fee
 * under Section 234E cannot, and the statement will not even be ACCEPTED
 * until it is paid. So a return held back for three weeks while somebody
 * chases one missing PAN costs ₹4,200 that nobody can argue down — which
 * is why `lib/tds/returns.ts` runs the validation pass before the due
 * date rather than at filing time.
 *
 * ⚠️ THE CAP IS THE TDS, AND IT MAKES SMALL QUARTERS DANGEROUS. A quarter
 * with ₹6,000 of tax caps the fee at ₹6,000 — reached in 30 days. After
 * that the fee stops and Section 271H's ₹10,000-to-₹1,00,000 penalty
 * starts, so "the fee has stopped growing" is not the good news it looks
 * like.
 */
export function assessLateFiling(args: {
  dueDate: string;
  /** `null` when it has not been filed. */
  filedOn: string | null;
  totalTdsMinor: bigint;
  asOf?: string;
}): LateFilingAssessment {
  const due = toCivilDay(args.dueDate);
  const measureTo = args.filedOn
    ? toCivilDay(args.filedOn)
    : args.asOf
      ? toCivilDay(args.asOf)
      : null;

  if (!measureTo || measureTo <= due) {
    return {
      late: false,
      daysLate: 0,
      feeMinor: 0n,
      capped: false,
      explanation: measureTo
        ? `Filed on ${measureTo}, on or before the ${due} deadline.`
        : `Not yet filed. Due on ${due}. ⚠️ Section 234E charges ₹200 for every ` +
          `day after that, and it cannot be waived for reasonable cause.`,
    };
  }

  const daysLate = daysBetween(due, measureTo);
  const uncapped = LATE_FILING_FEE_PER_DAY_MINOR * BigInt(daysLate);
  // ⭐ Section 234E(3): the fee shall not exceed the tax deductible.
  const capped = uncapped > args.totalTdsMinor;
  const feeMinor = capped ? args.totalTdsMinor : uncapped;

  return {
    late: true,
    daysLate,
    feeMinor,
    capped,
    explanation:
      `⭐ The statement was due on ${due} and ${args.filedOn ? `was filed on ${measureTo}` : `is still unfiled as at ${measureTo}`} ` +
      `— ${daysLate} day(s) late. Section 234E charges ₹200 a day: ` +
      `${formatPaise(feeMinor)}` +
      (capped
        ? `, capped at the ${formatPaise(args.totalTdsMinor)} of tax deducted. ` +
          `⚠️ The cap having been reached is not good news — Section 271H's ` +
          `penalty of ₹10,000 to ₹1,00,000 is what follows it.`
        : ` (uncapped; the cap is the ${formatPaise(args.totalTdsMinor)} of tax ` +
          `deducted).`) +
      ` ⚠️ A fee under 234E cannot be waived for reasonable cause, and the ` +
      `statement is not accepted until it is paid.`,
  };
}

/* ------------------------------------------------------------------ */
/* THE WHOLE EXPOSURE                                                  */
/* ------------------------------------------------------------------ */

export type InterestExposure = {
  notDepositedCount: number;
  notDepositedTdsMinor: bigint;
  interestMinor: bigint;
  findings: Array<{
    deductionId: string;
    deductionDate: string;
    dueDate: string;
    tdsMinor: bigint;
    monthsCharged: number;
    interestMinor: bigint;
    message: string;
  }>;
};

/**
 * The 1.5%-a-month exposure across a set of deductions.
 *
 * ⚠️ IT INCLUDES DEDUCTIONS THAT HAVE NOT BEEN DEPOSITED AT ALL, measured
 * to `asOf`. Those are the expensive ones and they are the ones a report
 * keyed on "deposited late" would leave out entirely — the exposure that
 * is still growing does not appear in a list of things that went wrong.
 */
export function assessInterestExposure(args: {
  deductions: readonly {
    id: string;
    deductionDate: string;
    depositDate: string | null;
    tdsMinor: bigint;
    section?: TdsSectionCode | null;
  }[];
  asOf: string;
}): InterestExposure {
  let interestMinor = 0n;
  let notDepositedTdsMinor = 0n;
  let notDepositedCount = 0;
  const findings: InterestExposure["findings"] = [];

  for (const d of args.deductions) {
    if (d.tdsMinor <= 0n) continue;
    if (!d.depositDate) {
      notDepositedCount += 1;
      notDepositedTdsMinor += d.tdsMinor;
    }

    const assessment = assessLateDeposit({
      deductionDate: d.deductionDate,
      depositDate: d.depositDate,
      tdsMinor: d.tdsMinor,
      section: d.section,
      asOf: args.asOf,
    });
    if (!assessment.late) continue;

    interestMinor += assessment.interestMinor;
    findings.push({
      deductionId: d.id,
      deductionDate: d.deductionDate,
      dueDate: assessment.dueDate,
      tdsMinor: d.tdsMinor,
      monthsCharged: assessment.monthsCharged,
      interestMinor: assessment.interestMinor,
      message: assessment.explanation,
    });
  }

  return { notDepositedCount, notDepositedTdsMinor, interestMinor, findings };
}
