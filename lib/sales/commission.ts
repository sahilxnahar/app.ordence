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
 * ⚠️ These are DEFAULTS AS OF THIS BUILD. Rates change with the Finance
 * Act. They are constants in one place so a change is one edit, and any
 * figure already recorded against a payout keeps the rate it was
 * computed with.
 */
export const TDS_194H_BPS = 500; // 5%
export const TDS_NO_PAN_BPS = 2000; // 20%, section 206AA

/** Below this in a financial year, no deduction is required. */
export const TDS_194H_THRESHOLD_MINOR = 2_000_000n; // ₹20,000

export type TdsResult = {
  applicable: boolean;
  rateBps: number;
  tdsMinor: bigint;
  netMinor: bigint;
  explanation: string;
};

export function computeTds(args: {
  grossMinor: bigint;
  hasPan: boolean;
  /** Everything already paid to this partner this financial year. */
  ytdGrossMinor?: bigint;
}): TdsResult {
  const { grossMinor, hasPan } = args;
  const ytd = args.ytdGrossMinor ?? 0n;

  if (grossMinor <= 0n) {
    return {
      applicable: false,
      rateBps: 0,
      tdsMinor: 0n,
      netMinor: grossMinor,
      explanation: "Nothing to deduct.",
    };
  }

  // ⚠️ The threshold is on the YEAR, not the payment. A partner paid
  // ₹15,000 twice has crossed it, and testing each payment separately is
  // the classic way to under-deduct and be assessed for it later.
  if (ytd + grossMinor < TDS_194H_THRESHOLD_MINOR) {
    return {
      applicable: false,
      rateBps: 0,
      tdsMinor: 0n,
      netMinor: grossMinor,
      explanation:
        `Below the ${formatPaise(TDS_194H_THRESHOLD_MINOR)} annual threshold ` +
        `for section 194H, so no deduction applies yet.`,
    };
  }

  const rateBps = hasPan ? TDS_194H_BPS : TDS_NO_PAN_BPS;
  const tdsMinor = applyRateBps(grossMinor, rateBps);

  return {
    applicable: true,
    rateBps,
    tdsMinor,
    netMinor: grossMinor - tdsMinor,
    explanation: hasPan
      ? `TDS at ${formatBps(rateBps)} under section 194H.`
      : `TDS at ${formatBps(rateBps)} — no PAN on file, so section 206AA ` +
        `requires the higher rate. Add the partner's PAN to reduce this to ` +
        `${formatBps(TDS_194H_BPS)}.`,
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
