/**
 * Ordence — Brokerage & the Commission-Protection Window
 * Version: v0.22.0-alpha
 *
 * Pure and isomorphic. Money is `bigint` paise throughout — see the note
 * in `lib/billing/money.ts` on why a float is never acceptable here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE MOST ARGUED-ABOUT ARITHMETIC IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * Brokerage is the one number in a real-estate CRM that somebody outside
 * the company checks. A buyer never audits your pipeline. A broker
 * absolutely audits their commission, with a calculator, the same
 * afternoon.
 *
 * Two consequences shape this file:
 *
 *   1. EVERY FIGURE IS REPRODUCIBLE. The result carries the inputs and
 *      the basis used, so a disputed payment can be re-derived months
 *      later rather than re-negotiated.
 *
 *   2. ROUNDING IS EXPLICIT AND IN ONE PLACE. Rupees rounded a second
 *      way in a second file is how the statement and the invoice differ
 *      by one paisa, which is small enough to ignore and large enough to
 *      cost an afternoon.
 */

import { applyRateBps } from "@/lib/billing/money";
import type { CommissionBasis } from "@/db/schema/sales";

/* ------------------------------------------------------------------ */
/* COMPUTATION                                                         */
/* ------------------------------------------------------------------ */

export type CommissionInput = {
  basis: CommissionBasis;
  /** Basis points. 200 = 2%. Used by `percent_of_sale`. */
  rateBps: number;
  /** Months of rent × 100. 150 = 1.5 months. Used by `months_of_rent`. */
  monthsCentis?: number | null;
  /** Used by `flat_fee`. */
  flatMinor?: bigint | null;
  /** The agreed sale value, in paise. */
  agreementValueMinor?: bigint | null;
  /** Monthly rent, in paise. Lettings only. */
  monthlyRentMinor?: bigint | null;
};

export type CommissionResult = {
  /** What the partner earns, before tax, in paise. */
  grossMinor: bigint;
  basis: CommissionBasis;
  /** Human-readable derivation — shown on the statement. */
  workings: string;
  /** Populated when the inputs cannot produce a figure. */
  problem: string | null;
};

/**
 * ⚠️ RETURNS ZERO WITH A `problem`, NEVER THROWS.
 *
 * A commission page listing 200 partners must not blank out because one
 * of them has a half-configured agreement. The row shows ₹0 and says
 * why, which is both honest and actionable — whereas an exception takes
 * the page down and tells the user nothing.
 */
export function computeCommission(input: CommissionInput): CommissionResult {
  const { basis } = input;

  switch (basis) {
    case "percent_of_sale": {
      const value = input.agreementValueMinor;
      if (value == null) {
        return problem(basis, "No agreement value on the booking yet.");
      }
      if (value < 0n) {
        return problem(basis, "The agreement value is negative.");
      }
      if (!isSaneRate(input.rateBps)) {
        return problem(basis, `Commission rate ${input.rateBps} bps is out of range.`);
      }
      const gross = applyRateBps(value, input.rateBps);
      return {
        grossMinor: gross,
        basis,
        workings: `${formatBps(input.rateBps)} of ${formatPaise(value)}`,
        problem: null,
      };
    }

    case "months_of_rent": {
      const rent = input.monthlyRentMinor;
      const months = input.monthsCentis;
      if (rent == null) {
        return problem(basis, "No monthly rent recorded.");
      }
      if (months == null || months <= 0) {
        return problem(basis, "The number of months of rent has not been agreed.");
      }
      // ══════════════════════════════════════════════════════════════
      // 🔴 THE UNIT CONVERSION THAT WAS WRONG, AND HOW IT WAS CAUGHT
      // ══════════════════════════════════════════════════════════════
      // `monthsCentis` is months × 100 (150 = 1.5 months). `rateBps` is
      // parts per 10,000. They are NOT the same scale, and the first
      // draft passed one where the other was expected:
      //
      //     applyRateBps(₹45,000, 150) = ₹675      ← 1/100th
      //     correct:                     ₹67,500
      //
      // Every lettings commission would have paid out at one percent of
      // what was agreed. Nothing would have errored. The broker would
      // have noticed — that is the only reason it would ever have been
      // found in production, and by then it is a conversation about
      // whether the developer is trying it on.
      //
      // ⚠️ Two representations of "a proportion" in one codebase is the
      // whole hazard. The × 100 below converts centis → basis points and
      // is the ONLY place the two scales meet.
      const gross = applyRateBps(rent, months * 100);
      return {
        grossMinor: gross,
        basis,
        workings: `${(months / 100).toFixed(2)} months × ${formatPaise(rent)}`,
        problem: null,
      };
    }

    case "flat_fee": {
      const flat = input.flatMinor;
      if (flat == null) {
        return problem(basis, "No flat fee has been agreed.");
      }
      if (flat < 0n) {
        return problem(basis, "The flat fee is negative.");
      }
      return {
        grossMinor: flat,
        basis,
        workings: `Flat fee of ${formatPaise(flat)}`,
        problem: null,
      };
    }
  }
}

function problem(basis: CommissionBasis, message: string): CommissionResult {
  return { grossMinor: 0n, basis, workings: "—", problem: message };
}

function isSaneRate(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function formatPaise(minor: bigint): string {
  const rupees = minor / 100n;
  const paise = (minor < 0n ? -minor : minor) % 100n;
  return `₹${rupees.toString()}.${paise.toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* TDS                                                                 */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * TAX DEDUCTED AT SOURCE — WHY IT BELONGS HERE AND NOT IN THE PAYOUT
 * ══════════════════════════════════════════════════════════════════════
 * Brokerage in India attracts TDS under section 194H. The developer
 * deducts it, pays it to the government, and hands the broker a
 * certificate. The broker sees a smaller number than the one agreed and
 * asks why — every single time — so the deduction has to be visible on
 * the statement rather than applied silently at payment.
 *
 * ⚠️ 5% WITH A PAN, 20% WITHOUT.
 *
 * That is not a penalty we invented; section 206AA requires the higher
 * rate when the deductee has not furnished a PAN. It is also, in
 * practice, the single most effective way to get a broker to submit
 * their KYC — so surfacing the reason matters commercially, not just
 * legally.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 TWO DEFECTS FOUND AND FIXED IN v1.25.0-alpha, BOTH OF THEM
 *        SILENT, AND BOTH FOUND BY THE CODEBASE ARGUING WITH ITSELF
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① THE RATE WAS STALE BY NEARLY TWO YEARS.
 *
 *    This file said `TDS_194H_BPS = 500` — five percent. 194H fell to
 *    TWO percent with effect from 1 October 2024, and it is still two
 *    percent for FY 2026-27.
 *
 *    ⚠️ AND `lib/tds/sections.ts` ALREADY SAID SO, IN PROSE, WHILE
 *    IMPORTING THE WRONG NUMBER FROM HERE. Its header carries the
 *    warning "194H fell from 5% to 2% with effect from 1 October 2024 —
 *    MID-YEAR. A workspace deducting 5% in November is over-deducting",
 *    and then it sets `rateBpsOther: TDS_194H_BPS` and imports 500. The
 *    knowledge was in the repository. The arithmetic never read it.
 *
 *    Over-deducting is not the harmless direction people assume. The
 *    broker is short 3% of their brokerage today and gets it back, if at
 *    all, when they file a return the following year — and they raise it
 *    with the developer, every time, because they check.
 *
 * ② THE THRESHOLD BEHAVED AS `per_transaction` WHERE THE PRODUCT'S OWN
 *    SECTION TABLE DECLARES `aggregate_whole`.
 *
 *    `lib/tds/sections.ts` classifies 194H as `aggregate_whole` and its
 *    comment on that mode reads "⭐ This is the one everybody gets
 *    wrong." The old code here got it wrong: once the year crossed
 *    ₹20,000 it deducted on the CURRENT payment only, and the payments
 *    made earlier in the year while still below the threshold were never
 *    caught up.
 *
 *    ₹15,000 in April and ₹10,000 in July is ₹25,000 of chargeable base,
 *    not ₹10,000. The old code deducted ₹200. The right figure is ₹500.
 *    The ₹300 gap carries interest at 1% a month under s.201(1A) and
 *    disallows 30% of the expense under s.40(a)(ia) — so a ₹300
 *    shortfall can cost several thousand.
 *
 * ⭐ THE STRUCTURAL FIX, WHICH IS THE POINT: NO RATE IS A CONSTANT ANY
 *   MORE. Rates and thresholds are effective-dated DATA and are resolved
 *   against the date the brokerage was credited. This is the same rule
 *   payroll adopted in v1.23.0 — every statutory figure arrives from an
 *   effective-dated row, so that next October's change is a row rather
 *   than an edit that silently restates last year.
 *
 * ⚠️ AND `onDate` IS REQUIRED, NOT OPTIONAL WITH A DEFAULT. A rate
 * resolved against "now" is exactly how a correction statement for a
 * closed year gets recomputed at this year's rate. The caller has the
 * date; it must pass it.
 *
 * ⚠️ NOTE FOR THE NEXT MAINTAINER: the Income-tax Act, 2025 renumbers
 * 194H as clause 393 from 1 April 2026. The rate and the threshold are
 * unchanged; only the citation moves. `statutoryRef` is a string in the
 * section table for exactly this reason.
 */

export type DatedRate = {
  /** ISO date the rate takes effect, inclusive. */
  readonly from: string;
  readonly rateBps: number;
  readonly why: string;
};

/**
 * ⚠️ NEWEST FIRST. `resolveDated` takes the first entry whose `from` is
 * on or before the date asked about, so the ordering is load-bearing —
 * see the test that asserts it rather than trusting the comment.
 */
export const TDS_194H_RATE_HISTORY: readonly DatedRate[] = [
  {
    from: "2024-10-01",
    rateBps: 200,
    why: "Finance (No. 2) Act 2024 reduced section 194H from 5% to 2%, mid-year.",
  },
  {
    from: "2007-06-01",
    rateBps: 500,
    why: "The long-standing 5% rate, in force until 30 September 2024.",
  },
];

export type DatedThreshold = {
  readonly from: string;
  readonly thresholdMinor: bigint;
  readonly why: string;
};

export const TDS_194H_THRESHOLD_HISTORY: readonly DatedThreshold[] = [
  {
    from: "2025-04-01",
    thresholdMinor: 2_000_000n,
    why: "Finance Act 2025 raised the annual 194H threshold to ₹20,000.",
  },
  {
    from: "2001-06-01",
    thresholdMinor: 1_500_000n,
    why: "The earlier ₹15,000 annual threshold.",
  },
];

/** Section 206AA. Not a rate we invented, and not effective-dated so far. */
export const TDS_NO_PAN_BPS = 2000; // 20%

/**
 * ⚠️ RETAINED ONLY BECAUSE `lib/tds/sections.ts` RENDERS A STATIC
 * REFERENCE TABLE FROM IT. Nothing deducts from these — use the
 * resolvers. They now hold the CURRENT figures rather than the 2007 ones.
 */
export const TDS_194H_BPS = 200; // 2%, from 1 October 2024
export const TDS_194H_THRESHOLD_MINOR = 2_000_000n; // ₹20,000, from 1 April 2025

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS THROWS ON A MISSING DATE, AND THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * The first version of this function fell back to the oldest rate when
 * the date did not match anything. That is right for a genuinely ancient
 * date and CATASTROPHIC for `undefined`, because `"2024-10-01" <=
 * undefined` is false in JavaScript — so every entry misses, the fallback
 * fires, and a caller who forgot the date silently gets 5%.
 *
 * ⚠️ AND IT WAS CAUGHT BY A TEST THAT KEPT PASSING. `tests/security/
 * sales-logic.test.ts` asserted 5% of ₹15,000 and went on asserting it
 * after the rate moved to 2%, because it called the new signature
 * without a date and the fallback handed back exactly the stale answer
 * it expected. A green test agreeing with a wrong constant is worse than
 * no test: it is evidence for the wrong answer.
 *
 * So a date that is absent or malformed is a programming error and says
 * so. A date that is merely older than every entry still falls back,
 * because that is a real question with a real answer.
 */
function assertDate(onDate: string, what: string): void {
  if (typeof onDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
    throw new Error(
      `${what} needs the date the amount was credited, as YYYY-MM-DD. Got ${JSON.stringify(onDate)}. ` +
        `Section 194H changed rate mid-year on 1 October 2024, so a rate resolved without a date ` +
        `is a guess — and the guess is wrong for every credit on one side of that line.`,
    );
  }
}

export function resolve194hRateBps(onDate: string): number {
  assertDate(onDate, "resolve194hRateBps");
  const hit = TDS_194H_RATE_HISTORY.find((r) => r.from <= onDate);
  // ⚠️ Falls back to the OLDEST rate, not the newest. A date before every
  // entry is a data problem, and answering it with today's rate hides it.
  return hit ? hit.rateBps : TDS_194H_RATE_HISTORY[TDS_194H_RATE_HISTORY.length - 1]!.rateBps;
}

export function resolve194hThresholdMinor(onDate: string): bigint {
  assertDate(onDate, "resolve194hThresholdMinor");
  const hit = TDS_194H_THRESHOLD_HISTORY.find((t) => t.from <= onDate);
  return hit
    ? hit.thresholdMinor
    : TDS_194H_THRESHOLD_HISTORY[TDS_194H_THRESHOLD_HISTORY.length - 1]!.thresholdMinor;
}

/** Did the financial year this credit sits in straddle a rate change? */
export function rateChangedDuring(fromDate: string, toDate: string): boolean {
  return resolve194hRateBps(fromDate) !== resolve194hRateBps(toDate);
}

export type TdsResult = {
  applicable: boolean;
  rateBps: number;
  tdsMinor: bigint;
  netMinor: bigint;
  explanation: string;
  /** ⭐ The whole year's chargeable base, not just this credit. */
  chargeableBaseMinor: bigint;
  /** Non-null when the figure needs a human to look at it. */
  caution: string | null;
};

export function computeTds(args: {
  grossMinor: bigint;
  hasPan: boolean;
  /**
   * 🔴 THE DATE THE BROKERAGE IS CREDITED. Required. The rate and the
   * threshold are both resolved against it.
   */
  onDate: string;
  /** Everything already credited to this partner this financial year. */
  ytdGrossMinor?: bigint;
  /**
   * ⭐ WHAT HAS ALREADY BEEN DEDUCTED THIS YEAR. Without it the catch-up
   * on a threshold crossing would be charged twice on every later bill.
   */
  ytdTdsMinor?: bigint;
  /**
   * Optional. The date of the earliest credit in `ytdGrossMinor`, used
   * only to warn when the year straddles a rate change.
   */
  ytdEarliestDate?: string | null;
}): TdsResult {
  const { grossMinor, hasPan, onDate } = args;
  const ytdGross = args.ytdGrossMinor ?? 0n;
  const ytdTds = args.ytdTdsMinor ?? 0n;

  if (grossMinor <= 0n) {
    return {
      applicable: false,
      rateBps: 0,
      tdsMinor: 0n,
      netMinor: grossMinor,
      explanation: "Nothing to deduct.",
      chargeableBaseMinor: 0n,
      caution: null,
    };
  }

  const threshold = resolve194hThresholdMinor(onDate);

  // ⚠️ The threshold is on the YEAR, not the payment. A partner paid
  // ₹15,000 twice has crossed it, and testing each payment separately is
  // the classic way to under-deduct and be assessed for it later.
  if (ytdGross + grossMinor < threshold) {
    return {
      applicable: false,
      rateBps: 0,
      tdsMinor: 0n,
      netMinor: grossMinor,
      explanation:
        `Below the ${formatPaise(threshold)} annual threshold for section 194H — ` +
        `${formatPaise(ytdGross + grossMinor)} credited this year so far — ` +
        `so no deduction applies yet.`,
      chargeableBaseMinor: 0n,
      caution: null,
    };
  }

  const statutoryBps = resolve194hRateBps(onDate);
  const rateBps = hasPan ? statutoryBps : TDS_NO_PAN_BPS;

  // ══════════════════════════════════════════════════════════════════
  // 🔴 `aggregate_whole`. THE BASE IS THE WHOLE YEAR, NOT THIS CREDIT.
  // ══════════════════════════════════════════════════════════════════
  // Once the year crosses the threshold, tax is due on everything
  // credited in it — including the amounts paid out earlier while the
  // running total was still below. Subtracting what has already been
  // deducted turns that into a catch-up on the crossing bill and a
  // plain per-bill deduction on every bill after it.
  const chargeableBaseMinor = ytdGross + grossMinor;
  const cumulative = applyRateBps(chargeableBaseMinor, rateBps);
  const raw = cumulative - ytdTds;
  // ⚠️ Never negative. An over-deduction earlier in the year is refunded
  // by the return, not by a negative deduction on a later bill.
  const tdsMinor = raw < 0n ? 0n : raw;

  const caughtUp = ytdGross > 0n && ytdTds < applyRateBps(ytdGross, rateBps);

  const parts: string[] = [
    hasPan
      ? `TDS at ${formatBps(rateBps)} under section 194H.`
      : `TDS at ${formatBps(rateBps)} — no PAN on file, so section 206AA requires ` +
        `the higher rate. Add the partner's PAN to reduce this to ` +
        `${formatBps(statutoryBps)}.`,
  ];
  if (caughtUp) {
    parts.push(
      `The ${formatPaise(threshold)} annual threshold has been crossed, so tax is ` +
        `due on the whole ${formatPaise(chargeableBaseMinor)} credited this year, ` +
        `not just this bill. ${formatPaise(ytdTds)} has already been deducted, so ` +
        `this bill carries the catch-up.`,
    );
  }

  const caution =
    args.ytdEarliestDate && rateChangedDuring(args.ytdEarliestDate, onDate)
      ? `⚠️ The 194H rate changed part-way through this financial year. The ` +
        `catch-up above is computed at ${formatBps(statutoryBps)} for the whole ` +
        `year. Earlier credits were chargeable at the rate then in force — check ` +
        `this figure with your accountant before paying it.`
      : null;

  return {
    applicable: true,
    rateBps,
    tdsMinor,
    netMinor: grossMinor - tdsMinor,
    explanation: parts.join(" "),
    chargeableBaseMinor,
    caution,
  };
}

/* ------------------------------------------------------------------ */
/* THE COMMISSION-PROTECTION WINDOW                                    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHOSE LEAD IS IT?
 * ══════════════════════════════════════════════════════════════════════
 * A broker registers a buyer. For a defined period that buyer is theirs,
 * so a second broker — or the in-house team — cannot claim the
 * commission by re-registering the same person.
 *
 * This is where brokers and developers actually fall out. The dispute is
 * never about the percentage; it is about who introduced the buyer, and
 * it is settled by whoever has a dated record.
 *
 * ⚠️ 90 DAYS IS A DEFAULT, NOT A STANDARD. It varies by developer and by
 * agreement, so it is tenant-configurable. What is NOT configurable is
 * that the window is recorded on the lead at registration and enforced
 * by a trigger — see Section 6 of the SQL file.
 */
export const DEFAULT_CP_LOCK_DAYS = 90;
export const MAX_CP_LOCK_DAYS = 365;

export function resolveCpLockDays(configured?: number | null): number {
  if (configured == null || !Number.isFinite(configured)) {
    return DEFAULT_CP_LOCK_DAYS;
  }
  return Math.max(1, Math.min(MAX_CP_LOCK_DAYS, Math.floor(configured)));
}

export function cpLockExpiry(registeredAt: Date, days: number): Date {
  return new Date(registeredAt.getTime() + resolveCpLockDays(days) * 86_400_000);
}

export type AttributionVerdict =
  | { allowed: true; note: string }
  | { allowed: false; reason: string; remedy: string; lockedUntil: Date };

/**
 * May this lead be attributed to `incomingPartnerId` right now?
 *
 * Mirrors the trigger `leads_cp_lock`.
 */
export function canAttribute(args: {
  currentPartnerId: string | null;
  cpLockedUntil: Date | null;
  incomingPartnerId: string | null;
  now: Date;
}): AttributionVerdict {
  const { currentPartnerId, cpLockedUntil, incomingPartnerId, now } = args;

  if (!currentPartnerId || !cpLockedUntil) {
    return { allowed: true, note: "This lead is not registered to a partner." };
  }

  if (currentPartnerId === incomingPartnerId) {
    return { allowed: true, note: "Already registered to this partner." };
  }

  if (cpLockedUntil.getTime() <= now.getTime()) {
    return {
      allowed: true,
      note: "The previous partner's protection window has closed.",
    };
  }

  return {
    allowed: false,
    reason:
      "This buyer is registered to another channel partner, and their " +
      "protection window has not closed.",
    remedy:
      "Re-attributing now would move a commission that has already been " +
      "earned. If the partner has agreed to release the lead, clear the " +
      "protection window first — that is recorded, so there is a record of " +
      "who decided it.",
    lockedUntil: cpLockedUntil,
  };
}

export function cpLockDaysRemaining(cpLockedUntil: Date | null, now: Date): number | null {
  if (!cpLockedUntil) return null;
  const ms = cpLockedUntil.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}
