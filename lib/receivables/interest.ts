/**
 * Ordence — ⭐ Interest on Delayed Payment
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. No `@/db` import, no I/O. Money is `bigint` paise,
 * rates are integer basis points, dates are civil days as
 * `YYYY-MM-DD` strings.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ INTEREST MUST NOT COMPOUND SILENTLY
 * ══════════════════════════════════════════════════════════════════════
 * ₹10,00,000 outstanding for a year at 18%:
 *
 *     simple                 ₹1,80,000
 *     compounded quarterly   ₹1,92,519
 *     compounded monthly     ₹1,95,618
 *
 * All three are defensible. Charging one while the notice implies another
 * is not — and the difference is a default in a configuration file, not a
 * decision anybody made. It is discovered by a buyer with a calculator,
 * in front of an Authority, on a document that says nothing about which
 * rule was applied.
 *
 * So EVERY accrual this module returns carries:
 *
 *   • `basis` — the sentence for the notice, generated from the same
 *     values the arithmetic used, so the two cannot drift apart.
 *   • `periods` — every rest period, with its opening balance, its days
 *     and its interest. A buyer disputing ₹1,95,618 can be handed the
 *     twelve lines that make it up.
 *   • `compounded` — a plain boolean, so a caller can refuse to send a
 *     notice whose template has no compounding sentence in it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ RERA AND THE RATE: SECTION 2(za)
 * ══════════════════════════════════════════════════════════════════════
 * The Act defines "interest" SYMMETRICALLY. The rate a promoter charges
 * an allottee for a late instalment must equal the rate the promoter PAYS
 * an allottee for delayed possession — which the State rules set at SBI's
 * highest marginal cost of lending rate plus 2%, currently around 11.1%.
 *
 * Most builder-buyer agreements in circulation still say 18% or 24%,
 * written before 2016 and never revised. `assessInterestRate` does NOT
 * refuse those: whether a pre-RERA contract's rate survives is a legal
 * judgement about that contract, and a product that refuses to record
 * what an agreement says is a product somebody keeps a spreadsheet
 * beside.
 *
 * It FLAGS them, with the reasoning attached, so the gap is on the demand
 * and in the register rather than discovered at a hearing.
 */

import { toCivilDay } from "@/lib/gst/constants";
import type {
  InterestCompounding,
  InterestDayCount,
} from "@/db/schema/receivables";
import { formatPaise, formatRateBps } from "./numbers";

/* ------------------------------------------------------------------ */
/* CIVIL-DAY HELPERS                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ CIVIL DAYS, NOT `Date` OBJECTS, AND THE REASON IS A DAY OF INTEREST.
 *
 * `new Date("2026-05-15")` is midnight UTC, which is 05:30 on the 15th in
 * Mumbai and 20:00 on the 14th in Los Angeles. A due date compared as a
 * `Date` on a server in the wrong hemisphere charges a buyer who paid on
 * time, or forgives one who did not — and the two are indistinguishable
 * afterwards because the stored data is identical.
 *
 * ⚠️ `toCivilDay` IS IMPORTED FROM `lib/gst/constants.ts`, NOT REWRITTEN.
 * It is the one place in this product that parses a day, and Phase 36
 * imported it for the same reason: two functions that answer "which day
 * is this" slightly differently is worse than one that answers it at all.
 *
 * `addDays` and `daysBetween` ARE restated, and deliberately so: the only
 * other copies live in `lib/tds/calendar.ts`, a module about quarters,
 * assessment years and Section 201(1A) deposit dates. Importing a
 * receivables module from the TDS calendar to borrow two lines of UTC
 * arithmetic would tie the demand engine to the tax-deduction engine's
 * release cycle for no benefit.
 */
export { toCivilDay };

/**
 * ⚠️ DONE IN UTC AND RETURNED AS A CIVIL DAY. `Date.UTC` has no zone to
 * drift in; the local constructor moves the result by up to a day
 * depending on where the server is.
 */
export function addDays(day: string, days: number): string {
  const ms = utcOf(day) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86_400_000);
}

/**
 * ⚠️ SLICED, NOT DESTRUCTURED FROM `split("-").map(Number)`. Under
 * `noUncheckedIndexedAccess` that produces `number | undefined`, and the
 * obvious `!` on each element is how a malformed day silently becomes
 * `NaN`, then `Invalid Date`, which compares false against every
 * threshold — reporting a demand 400 days overdue as not yet due.
 */
export function utcOf(day: string): number {
  const civil = toCivilDay(day);
  return Date.UTC(
    Number(civil.slice(0, 4)),
    Number(civil.slice(5, 7)) - 1,
    Number(civil.slice(8, 10)),
  );
}

/** Add whole calendar months to a civil day, clamping the day of month. */
export function addMonths(day: string, months: number): string {
  const civil = toCivilDay(day);
  const year = Number(civil.slice(0, 4));
  const month = Number(civil.slice(5, 7));
  const date = Number(civil.slice(8, 10));

  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;

  // ⚠️ CLAMPED. 31 January plus one month is 28 February, not 3 March.
  // Rolling over shortens the rest period by two or three days and puts
  // every subsequent rest on the wrong date for the rest of the year.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDate = Math.min(date, lastDay);

  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDate).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* DAY COUNT                                                           */
/* ------------------------------------------------------------------ */

export const DAY_COUNT_DIVISOR: Readonly<Record<InterestDayCount, number>> =
  Object.freeze({
    actual_365: 365,
    actual_360: 360,
    thirty_360: 360,
  });

export const DAY_COUNT_LABELS: Readonly<Record<InterestDayCount, string>> =
  Object.freeze({
    actual_365: "actual days over 365",
    actual_360: "actual days over 360",
    thirty_360: "30/360",
  });

/**
 * Days between two civil days under a day-count convention.
 *
 * ⚠️ `thirty_360` IS NOT "ACTUAL DAYS, DIVIDED BY 360". It counts every
 * month as 30 days, which is what a spreadsheet does when somebody writes
 * `= months * rate / 12` — and it is the reason a buyer's own calculation
 * disagrees with a bank-convention one by a few hundred rupees whenever a
 * demand falls due on the 31st. Implementing it is what lets a workspace
 * whose agreement says "per month" produce the number their agreement
 * implies instead of arguing about a convention nobody named.
 */
export function dayCountDays(
  from: string,
  to: string,
  basis: InterestDayCount,
): number {
  if (basis !== "thirty_360") return daysBetween(from, to);

  const a = toCivilDay(from);
  const b = toCivilDay(to);

  const y1 = Number(a.slice(0, 4));
  const m1 = Number(a.slice(5, 7));
  let d1 = Number(a.slice(8, 10));
  const y2 = Number(b.slice(0, 4));
  const m2 = Number(b.slice(5, 7));
  let d2 = Number(b.slice(8, 10));

  if (d1 > 30) d1 = 30;
  if (d1 === 30 && d2 > 30) d2 = 30;

  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
}

/* ------------------------------------------------------------------ */
/* THE ARITHMETIC                                                      */
/* ------------------------------------------------------------------ */

/**
 * principal × rate × days ÷ (divisor × 10000), rounded half-up.
 *
 * ⚠️ ENTIRELY IN `bigint`. The obvious floating-point version is correct
 * for almost every input and wrong for the ones that matter: 0.1 + 0.2
 * arithmetic on a nine-figure principal drifts by paise, and paise on an
 * interest figure are exactly what a buyer recomputing the demand by hand
 * will find.
 *
 * ⚠️ HALF-UP, MATCHING `applyRateBps` IN `lib/billing/money.ts`. The rest
 * of this platform rounds half-up because that is what an auditor
 * recomputing a figure by hand does; a second rounding rule here would
 * put this module one paisa away from every other money calculation in
 * the product, forever, for no reason anybody could later reconstruct.
 */
export function simpleInterestMinor(args: {
  principalMinor: bigint;
  rateBps: number;
  days: number;
  dayCount: InterestDayCount;
}): bigint {
  const { principalMinor, rateBps, days, dayCount } = args;

  if (days <= 0 || rateBps <= 0 || principalMinor <= 0n) return 0n;
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new InterestInputError(
      `An interest rate must be a non-negative whole number of basis points. Got ${rateBps}.`,
    );
  }

  const numerator = principalMinor * BigInt(rateBps) * BigInt(days);
  const denominator = BigInt(DAY_COUNT_DIVISOR[dayCount]) * 10_000n;

  // Half-up in exact integer arithmetic: (2n + d) / 2d.
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export class InterestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterestInputError";
  }
}

/* ------------------------------------------------------------------ */
/* TERMS                                                               */
/* ------------------------------------------------------------------ */

export type InterestTerms = {
  /** Per annum, basis points. 1800 = 18%. */
  rateBps: number;
  compounding: InterestCompounding;
  dayCount: InterestDayCount;
  /** Days after the due date before interest begins to be charged. */
  graceDays: number;
  /**
   * ⚠️ WHAT THE GRACE ACTUALLY DOES ONCE IT IS EXCEEDED, AND THE TWO
   * ANSWERS DIFFER BY THE GRACE PERIOD ITSELF.
   *
   *   false (default) — the grace forgives the trivially late payer and
   *     nothing else. A buyer who pays on day 6 of a 7-day grace pays no
   *     interest; one who pays on day 40 pays from the DUE DATE.
   *   true — the graced days are forgiven to everybody, so day 40 accrues
   *     33 days.
   *
   * Most agreements mean the first. Both are written the same way in
   * English ("a grace period of seven days"), which is precisely why the
   * choice has to be stored and stated rather than assumed.
   */
  graceForgivesElapsedDays?: boolean;
};

export const COMPOUNDING_MONTHS: Readonly<Record<InterestCompounding, number>> =
  Object.freeze({ simple: 0, monthly: 1, quarterly: 3, annual: 12 });

export const COMPOUNDING_LABELS: Readonly<Record<InterestCompounding, string>> =
  Object.freeze({
    simple: "simple",
    monthly: "compounded monthly",
    quarterly: "compounded quarterly",
    annual: "compounded annually",
  });

/* ------------------------------------------------------------------ */
/* ACCRUAL                                                             */
/* ------------------------------------------------------------------ */

export type InterestPeriod = {
  from: string;
  to: string;
  days: number;
  /** The balance interest was charged on for this rest period. */
  openingMinor: bigint;
  interestMinor: bigint;
  /** True when this period's interest was added to the balance. */
  capitalised: boolean;
};

export type InterestAccrual = {
  principalMinor: bigint;
  dueDate: string;
  asOf: string;
  /** The day interest actually started. Null when nothing has accrued. */
  accruesFrom: string | null;
  /** Days charged, under the day-count convention in force. */
  days: number;
  interestMinor: bigint;
  /** Every rest period, so the figure can be handed over line by line. */
  periods: InterestPeriod[];
  compounded: boolean;
  /** ⭐ The sentence for the notice. See the file header. */
  basis: string;
  terms: InterestTerms;
};

/**
 * Accrue interest on an overdue principal from its due date to a day.
 *
 * ⚠️ THE PRINCIPAL IS THE OUTSTANDING PRINCIPAL, NOT THE DEMAND TOTAL.
 * Interest on the GST element is not the developer's to charge — the tax
 * was collected for the Government, and charging delay interest on it
 * turns a compliance amount into a revenue line. The caller passes what
 * is actually owed on the flat.
 */
export function accrueInterest(args: {
  principalMinor: bigint;
  dueDate: string;
  asOf: string;
  terms: InterestTerms;
}): InterestAccrual {
  const { principalMinor, terms } = args;
  const dueDate = toCivilDay(args.dueDate);
  const asOf = toCivilDay(args.asOf);

  const graceEnds = addDays(dueDate, Math.max(0, terms.graceDays));
  const basis = describeInterestBasis({ terms, dueDate });

  const empty = (from: string | null): InterestAccrual => ({
    principalMinor,
    dueDate,
    asOf,
    accruesFrom: from,
    days: 0,
    interestMinor: 0n,
    periods: [],
    compounded: false,
    basis,
    terms,
  });

  if (principalMinor <= 0n || terms.rateBps <= 0) return empty(null);

  // ⚠️ WITHIN GRACE IS NOT "ZERO DAYS", IT IS "NO INTEREST AT ALL". The
  // distinction matters on the notice: a demand that says "interest ₹0
  // for 4 days" invites the buyer to ask what happens on day 8, and the
  // answer is not four days' interest.
  if (daysBetween(asOf, graceEnds) >= 0) return empty(null);

  const accruesFrom = terms.graceForgivesElapsedDays ? graceEnds : dueDate;
  const totalDays = dayCountDays(accruesFrom, asOf, terms.dayCount);
  if (totalDays <= 0) return empty(accruesFrom);

  const restMonths = COMPOUNDING_MONTHS[terms.compounding];

  /* --- Simple: one period, one line. ----------------------------- */
  if (restMonths === 0) {
    const interest = simpleInterestMinor({
      principalMinor,
      rateBps: terms.rateBps,
      days: totalDays,
      dayCount: terms.dayCount,
    });
    return {
      principalMinor,
      dueDate,
      asOf,
      accruesFrom,
      days: totalDays,
      interestMinor: interest,
      periods: [
        {
          from: accruesFrom,
          to: asOf,
          days: totalDays,
          openingMinor: principalMinor,
          interestMinor: interest,
          capitalised: false,
        },
      ],
      compounded: false,
      basis,
      terms,
    };
  }

  /* --- Compounding: rest by rest, each one visible. -------------- */
  //
  // ⚠️ THE REST PERIODS ARE CALENDAR MONTHS, NOT 30-DAY BLOCKS. An
  // agreement that says "compounded monthly" means on the same day of
  // each month, which is what a buyer's own bank statement would show. A
  // 30-day block drifts a day per month and by the eleventh rest the two
  // calculations are a week apart.
  const periods: InterestPeriod[] = [];
  let balance = principalMinor;
  let cursor = accruesFrom;
  let accruedDays = 0;
  let totalInterest = 0n;
  let restIndex = 0;

  // Bounded: a demand more than fifty years overdue is a data problem,
  // and an unbounded loop over a corrupt date is a hung request.
  const MAX_RESTS = 12 * 50;

  while (restIndex < MAX_RESTS) {
    const nextRest = addMonths(accruesFrom, restMonths * (restIndex + 1));
    const periodEnd = daysBetween(nextRest, asOf) >= 0 ? nextRest : asOf;
    const isFinal = periodEnd === asOf;

    const days = dayCountDays(cursor, periodEnd, terms.dayCount);
    if (days > 0) {
      const interest = simpleInterestMinor({
        principalMinor: balance,
        rateBps: terms.rateBps,
        days,
        dayCount: terms.dayCount,
      });
      totalInterest += interest;
      accruedDays += days;
      periods.push({
        from: cursor,
        to: periodEnd,
        days,
        openingMinor: balance,
        interestMinor: interest,
        // ⚠️ THE FINAL, PART-ELAPSED PERIOD IS NOT CAPITALISED. Rolling
        // an incomplete rest into the balance charges interest on
        // interest that has not yet fallen due — which is the one form of
        // compounding no agreement anywhere provides for.
        capitalised: !isFinal,
      });
      if (!isFinal) balance += interest;
    }

    if (isFinal) break;
    cursor = periodEnd;
    restIndex += 1;
  }

  return {
    principalMinor,
    dueDate,
    asOf,
    accruesFrom,
    days: accruedDays,
    interestMinor: totalInterest,
    periods,
    compounded: periods.some((p) => p.capitalised),
    basis,
    terms,
  };
}

/* ------------------------------------------------------------------ */
/* THE SENTENCE                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE BASIS NOTE. English; `lib/receivables/templates/index.ts`
 * produces the same sentence in the notice's own language from the same
 * values.
 *
 * ⚠️ GENERATED, NEVER TYPED. A workspace that could type its own basis
 * note would eventually have one that says "simple interest" beside an
 * accrual that compounds — and the note is the part of the document that
 * gets read.
 */
export function describeInterestBasis(args: {
  terms: InterestTerms;
  dueDate: string;
}): string {
  const { terms } = args;
  const dueDate = toCivilDay(args.dueDate);

  if (terms.rateBps <= 0) {
    return "No interest is charged on this demand.";
  }

  const rate = formatRateBps(terms.rateBps);
  const rule = COMPOUNDING_LABELS[terms.compounding];
  const count = DAY_COUNT_LABELS[terms.dayCount];

  const parts = [
    `Interest at ${rate} per annum, ${rule}, on the outstanding principal`,
  ];

  if (terms.graceDays > 0) {
    const graceEnds = addDays(dueDate, terms.graceDays);
    parts.push(
      terms.graceForgivesElapsedDays
        ? `from ${graceEnds} (a grace period of ${terms.graceDays} days from the due date of ${dueDate}, which is not charged)`
        : `from the due date of ${dueDate}, charged only if payment is not made within ${terms.graceDays} days of that date`,
    );
  } else {
    parts.push(`from the due date of ${dueDate}`);
  }

  parts.push(`calculated on ${count}`);

  return `${parts.join(", ")}.`;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE RATE CAP                                                     */
/* ------------------------------------------------------------------ */

/**
 * A rate above this is not a commercial position, it is a typing error or
 * a term nobody will enforce. 36% per annum is twice what any bank
 * charges an unsecured borrower.
 *
 * ⚠️ IT IS STILL NOT A REFUSAL HERE. The database caps at 100% per annum
 * (a typed extra digit); this is where a human is TOLD. A library that
 * threw would stop a workspace recording a term their own signed
 * agreement contains, and the term does not stop existing because the
 * software disapproves of it.
 */
export const ABSURD_RATE_BPS = 3600;

export type RateVerdict = {
  rateBps: number;
  referenceRateBps: number;
  /** ⭐ The flag stored on the demand. */
  exceedsReference: boolean;
  excessBps: number;
  severity: "ok" | "warning" | "severe";
  message: string;
  remedy: string;
};

/**
 * ⭐ COMPARE THE AGREEMENT'S RATE AGAINST THE RERA SYMMETRIC RATE.
 *
 * Section 2(za) of the Real Estate (Regulation and Development) Act
 * defines interest symmetrically: what the promoter charges the allottee
 * must equal what the promoter pays the allottee for delayed possession.
 * The State rules put that at SBI's highest MCLR + 2%.
 *
 * ⚠️ WHAT THIS FUNCTION DELIBERATELY DOES NOT DO IS DECIDE. Whether a
 * pre-RERA agreement's 18% survives Section 2(za) is a question about
 * that agreement, its date and the State's rules, and it is answered by
 * the developer's counsel. What the product owes them is that nobody can
 * send a notice at 24% without the position having been put in front of
 * them in writing first.
 */
export function assessInterestRate(args: {
  rateBps: number;
  referenceRateBps: number;
}): RateVerdict {
  const rateBps = Math.trunc(args.rateBps);
  const referenceRateBps = Math.trunc(args.referenceRateBps);
  const excessBps = Math.max(0, rateBps - referenceRateBps);
  const exceedsReference = referenceRateBps > 0 && rateBps > referenceRateBps;

  if (rateBps >= ABSURD_RATE_BPS) {
    return {
      rateBps,
      referenceRateBps,
      exceedsReference: true,
      excessBps,
      severity: "severe",
      message:
        `${formatRateBps(rateBps)} per annum is not a rate any Indian lender charges ` +
        `an unsecured borrower, and it is far above the RERA reference rate of ` +
        `${formatRateBps(referenceRateBps)}. ⚠️ Check whether a digit has been ` +
        `typed twice before this reaches a buyer: a demand at this rate will be ` +
        `read as punitive on its face.`,
      remedy:
        "Correct the rate, or record the clause of the agreement it comes from " +
        "in the policy notes so the position is on file before a notice is sent.",
    };
  }

  if (!exceedsReference) {
    return {
      rateBps,
      referenceRateBps,
      exceedsReference: false,
      excessBps: 0,
      severity: "ok",
      message:
        `${formatRateBps(rateBps)} per annum is at or below the RERA reference ` +
        `rate of ${formatRateBps(referenceRateBps)} (SBI's highest MCLR + 2%).`,
      remedy: "",
    };
  }

  return {
    rateBps,
    referenceRateBps,
    exceedsReference: true,
    excessBps,
    severity: "warning",
    message:
      `⚠️ This demand charges ${formatRateBps(rateBps)} per annum where the RERA ` +
      `reference rate is ${formatRateBps(referenceRateBps)} — ${formatRateBps(excessBps)} ` +
      `higher. Section 2(za) defines interest SYMMETRICALLY: the rate charged to an ` +
      `allottee for a late payment is the same rate the promoter must PAY that ` +
      `allottee for delayed possession. A rate above the reference is therefore a ` +
      `rate the developer has also agreed to pay on every delayed flat, and it is ` +
      `the first thing raised in an Authority complaint.`,
    remedy:
      "Either bring the rate to the reference rate, or have counsel confirm the " +
      "agreement's clause is enforceable and record that on the policy. The rate " +
      "is charged either way — this is a flag, not a refusal.",
  };
}

/* ------------------------------------------------------------------ */
/* PRESENTATION HELPERS                                                */
/* ------------------------------------------------------------------ */

/**
 * The accrual as lines a person can be handed. Used by the statement of
 * account and by the notice when interest is compounded — a compounded
 * figure that arrives as one number is a figure nobody can check.
 */
export function explainAccrual(accrual: InterestAccrual): string[] {
  if (accrual.interestMinor === 0n) {
    return [accrual.basis, "No interest has accrued on this demand."];
  }

  const lines = [accrual.basis];

  if (accrual.periods.length === 1) {
    const only = accrual.periods[0];
    if (only) {
      lines.push(
        `₹${formatPaise(only.openingMinor)} × ${formatRateBps(accrual.terms.rateBps)} ` +
          `× ${only.days} days ÷ ${DAY_COUNT_DIVISOR[accrual.terms.dayCount]} = ` +
          `₹${formatPaise(only.interestMinor)}`,
      );
    }
    return lines;
  }

  for (const [index, period] of accrual.periods.entries()) {
    lines.push(
      `Rest ${index + 1}: ${period.from} to ${period.to} (${period.days} days) on ` +
        `₹${formatPaise(period.openingMinor)} = ₹${formatPaise(period.interestMinor)}` +
        (period.capitalised ? " — added to the balance" : ""),
    );
  }
  lines.push(`Total interest: ₹${formatPaise(accrual.interestMinor)}`);
  return lines;
}
