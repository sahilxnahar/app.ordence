/**
 * Ordence — ⭐⭐ Retention: Held, and Released Once
 * Version: v0.43.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ RETENTION RELEASED TWICE IS MONEY GONE
 * ══════════════════════════════════════════════════════════════════════
 * Five per cent of every bill, held across twenty-odd bills over three
 * years, released in two tranches — half at practical completion, half
 * when the defect liability period expires. On a ₹40 crore contract that
 * is ₹2 crore.
 *
 * ⚠️ THE TWO TRANCHES ARE RELEASED YEARS APART, BY DIFFERENT PEOPLE. The
 * person releasing the second tranche in 2029 has no way of knowing the
 * first was released in 2027 unless the system tells them — and the
 * contractor asking for it has every reason not to mention it. There is
 * no error message when it happens. There is a payment.
 *
 * So this module models retention as a TWO-SIDED LEDGER rather than a
 * balance:
 *
 *   • every rupee held is an entry against the bill that held it;
 *   • every rupee released is an entry against the STAGE that released
 *     it, with a reason and a named person;
 *   • a named stage occurs exactly once (SQL 0028 §9 has the partial
 *     unique index);
 *   • cumulative released may never exceed cumulative held.
 *
 * ⚠️ A SINGLE `retention_balance` COLUMN IS THE DEFECT THIS REPLACES.
 * Edited by four people over five years, it reconciles to nothing, and it
 * cannot answer the only question that matters in 2029: "was the first
 * tranche released, and by whom?"
 */

import { applyBps, sumMinor } from "./quantities";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type RetentionReleaseStageLike =
  | "practical_completion"
  | "defect_liability_expiry"
  | "bank_guarantee_substitution"
  | "ad_hoc";

export type RetentionEntry = {
  id?: string;
  entryKind: "held" | "released";
  /** Set on a hold. */
  raBillId?: string | null;
  /** Set on a release. */
  releaseStage?: RetentionReleaseStageLike | null;
  /** ⚠️ ALWAYS POSITIVE. The direction is `entryKind`, not the sign. */
  amountMinor: bigint;
  effectiveOn: string;
  reason?: string | null;
  actorId?: string | null;
};

export type RetentionPosition = {
  heldMinor: bigint;
  releasedMinor: bigint;
  /** held − released. What is still ours to give back. */
  outstandingMinor: bigint;
  holdCount: number;
  releaseCount: number;
  stagesReleased: RetentionReleaseStageLike[];
};

export class RetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionError";
  }
}

/** ⭐ The stages that may happen exactly once. `ad_hoc` may repeat. */
export const SINGLE_USE_RELEASE_STAGES: readonly RetentionReleaseStageLike[] = [
  "practical_completion",
  "defect_liability_expiry",
  "bank_guarantee_substitution",
];

/* ------------------------------------------------------------------ */
/* THE POSITION                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ RECONCILE THE LEDGER. Held, released, outstanding — from the rows,
 * never from a stored balance.
 */
export function retentionPosition(
  entries: readonly RetentionEntry[],
): RetentionPosition {
  const holds = entries.filter((entry) => entry.entryKind === "held");
  const releases = entries.filter((entry) => entry.entryKind === "released");

  for (const entry of entries) {
    if (entry.amountMinor <= 0n) {
      throw new RetentionError(
        `A retention entry of ${entry.amountMinor} paise is not an entry. Every ` +
          `row is a positive amount and the direction is the entry kind — a ` +
          `signed amount would let a release be typed as a hold with nothing ` +
          `visible to tell them apart.`,
      );
    }
  }

  const heldMinor = sumMinor(holds.map((entry) => entry.amountMinor));
  const releasedMinor = sumMinor(releases.map((entry) => entry.amountMinor));

  return {
    heldMinor,
    releasedMinor,
    outstandingMinor: heldMinor - releasedMinor,
    holdCount: holds.length,
    releaseCount: releases.length,
    stagesReleased: releases
      .map((entry) => entry.releaseStage)
      .filter((stage): stage is RetentionReleaseStageLike => Boolean(stage)),
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE RELEASE                                                    */
/* ------------------------------------------------------------------ */

export type ReleaseRequest = {
  stage: RetentionReleaseStageLike;
  amountMinor: bigint;
  effectiveOn: string;
  reason: string;
  actorId: string;
};

/**
 * ⭐⭐ MAY THIS RELEASE HAPPEN?
 *
 * Three refusals, and each of them is money:
 *
 *   1. ⭐⭐ THE STAGE HAS ALREADY BEEN RELEASED. The defect liability
 *      tranche released a second time is the full second half of the
 *      retention paid out twice — and the first release was two years
 *      ago, by somebody who has left.
 *
 *   2. ⭐ IT EXCEEDS WHAT IS OUTSTANDING. Releasing more than was ever
 *      held is not a release, it is a payment with no basis, and it will
 *      be reconciled by nobody because retention is not on any report
 *      until handover.
 *
 *   3. ⭐ IT HAS NO REASON. "Released per clause 12.3 on expiry of the
 *      defect liability period, engineer's certificate dated 14 Mar 2029"
 *      is what somebody has to be able to read in five years. "Released"
 *      is not.
 */
export function assertReleasable(args: {
  entries: readonly RetentionEntry[];
  request: ReleaseRequest;
}): void {
  const position = retentionPosition(args.entries);

  if (args.request.amountMinor <= 0n) {
    throw new RetentionError(
      `A release of ${args.request.amountMinor} paise is not a release.`,
    );
  }

  if (
    SINGLE_USE_RELEASE_STAGES.includes(args.request.stage) &&
    position.stagesReleased.includes(args.request.stage)
  ) {
    const previous = args.entries.find(
      (entry) =>
        entry.entryKind === "released" && entry.releaseStage === args.request.stage,
    );
    throw new RetentionError(
      `Retention has already been released at the "${args.request.stage.replace(/_/g, " ")}" ` +
        `stage${previous ? ` on ${previous.effectiveOn}` : ""}. ⚠️ REFUSED: this ` +
        `would pay the same tranche a SECOND time. The two tranches of a ` +
        `retention are released years apart by different people, and nothing ` +
        `about the second request looks wrong — the contractor asks, the clause ` +
        `is real, the amount is right. The only thing that shows it has already ` +
        `happened is this ledger.`,
    );
  }

  if (args.request.amountMinor > position.outstandingMinor) {
    throw new RetentionError(
      `This release is ${args.request.amountMinor} paise and only ` +
        `${position.outstandingMinor} is outstanding (${position.heldMinor} held, ` +
        `${position.releasedMinor} already released). ⚠️ REFUSED: releasing more ` +
        `than was ever held is a payment with no basis behind it, and retention ` +
        `appears on no report until handover — so nothing would surface it until ` +
        `the contract account is closed years later.`,
    );
  }

  if (!args.request.reason?.trim()) {
    throw new RetentionError(
      "A retention release needs a reason. ⚠️ In five years somebody will be " +
        "asked why ₹1 crore left the retention account, and 'released' with " +
        "nothing beside it is not an answer. Name the clause, the certificate " +
        "and the date.",
    );
  }

  if (!args.request.actorId?.trim()) {
    throw new RetentionError(
      "A retention release needs a named person behind it. A scheduled job may " +
        "not release retention — the defect liability period expiring is a date, " +
        "but deciding that the defects have actually been made good is a " +
        "judgement.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE RELEASE SCHEDULE                                             */
/* ------------------------------------------------------------------ */

export type ReleasePlanEntry = {
  stage: RetentionReleaseStageLike;
  amountMinor: bigint;
  dueOn: string;
  note: string;
};

/**
 * ⭐ WHAT IS DUE BACK, AND WHEN.
 *
 * ⚠️ THE SECOND TRANCHE IS THE ONE THAT GETS FORGOTTEN — in the other
 * direction. It falls due twelve months after practical completion, by
 * which time the project team has moved on, and a contractor who does not
 * chase it never gets it. That is not a saving; it is a liability sitting
 * on the balance sheet with a contractor entitled to it, and it turns up
 * as a claim with interest.
 */
export function releasePlan(args: {
  heldMinor: bigint;
  releaseOnCompletionBps: number;
  practicalCompletionOn: string;
  defectLiabilityMonths: number;
}): ReleasePlanEntry[] {
  if (
    !Number.isInteger(args.releaseOnCompletionBps) ||
    args.releaseOnCompletionBps < 0 ||
    args.releaseOnCompletionBps > 10_000
  ) {
    throw new RetentionError(
      `The completion tranche is ${args.releaseOnCompletionBps} basis points. It ` +
        `is a share of the retention between 0 and 100% — 5000 is half.`,
    );
  }

  const first = applyBps(args.heldMinor, args.releaseOnCompletionBps);
  // ⚠️ THE REMAINDER, NOT A SECOND PERCENTAGE. Two independent roundings
  // of 50% leave a paisa in the retention account forever, and a contract
  // account that does not close to zero is one somebody has to explain.
  const second = args.heldMinor - first;

  const plan: ReleasePlanEntry[] = [];

  if (first > 0n) {
    plan.push({
      stage: "practical_completion",
      amountMinor: first,
      dueOn: args.practicalCompletionOn,
      note:
        `Released on practical completion — ` +
        `${(args.releaseOnCompletionBps / 100).toFixed(0)}% of the retention held.`,
    });
  }

  if (second > 0n) {
    plan.push({
      stage: "defect_liability_expiry",
      amountMinor: second,
      dueOn: addMonths(args.practicalCompletionOn, args.defectLiabilityMonths),
      note:
        `Released on expiry of the ${args.defectLiabilityMonths}-month defect ` +
        `liability period, subject to defects having been made good. ⚠️ This is ` +
        `the tranche that gets forgotten: the project team has moved on, and a ` +
        `contractor who does not chase it is owed it anyway — with interest, ` +
        `when they eventually do.`,
    });
  }

  return plan;
}

/**
 * Civil-day month arithmetic, clamped to the end of the month.
 *
 * ⚠️ NO `Date` OBJECT AND NO TIMEZONE. 31 August plus 12 months is 31
 * August; 31 January plus 1 month is 28 or 29 February, never 3 March.
 * A retention release date that moves by a timezone is a payment made on
 * the wrong side of a year end.
 */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) {
    throw new RetentionError(`"${day}" is not a civil day in YYYY-MM-DD form.`);
  }

  const total = (y * 12 + (m - 1)) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayOfMonth = Math.min(d, lastDay);

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    dayOfMonth,
  ).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* ⭐ RECONCILIATION AGAINST THE BILLS                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE LEDGER AND THE BILLS MUST AGREE.
 *
 * Every bill's `retentionThisMinor` should have produced exactly one hold
 * entry. ⚠️ A bill that deducted retention and never wrote the ledger row
 * is retention taken from a contractor that the system has no record of
 * owing back — and it is invisible from both sides: the contractor sees
 * the deduction on their bill, we see nothing on the ledger, and it is
 * discovered at handover when they ask for it.
 */
export function reconcileAgainstBills(args: {
  entries: readonly RetentionEntry[];
  bills: readonly { id: string; sequence: number; retentionThisMinor: bigint }[];
}): string[] {
  const problems: string[] = [];
  const holds = args.entries.filter((entry) => entry.entryKind === "held");

  const byBill = new Map<string, bigint>();
  for (const hold of holds) {
    if (!hold.raBillId) {
      problems.push(
        "A retention HOLD has no bill against it. Retention is withheld from a " +
          "bill; a hold with no bill cannot be traced to what it was taken from.",
      );
      continue;
    }
    if (byBill.has(hold.raBillId)) {
      problems.push(
        `Bill ${hold.raBillId} has more than one retention hold. ⚠️ Retention ` +
          `counted twice against a contractor who was only deducted once.`,
      );
    }
    byBill.set(hold.raBillId, (byBill.get(hold.raBillId) ?? 0n) + hold.amountMinor);
  }

  for (const bill of args.bills) {
    const held = byBill.get(bill.id) ?? 0n;
    if (held !== bill.retentionThisMinor) {
      problems.push(
        `Bill ${bill.sequence} deducted ${bill.retentionThisMinor} paise of ` +
          `retention and the ledger records ${held}. ⚠️ The difference is money ` +
          `taken from a contractor that nothing records owing back — invisible ` +
          `from both sides until they ask for it at handover.`,
      );
    }
    byBill.delete(bill.id);
  }

  for (const [billId, amount] of byBill) {
    problems.push(
      `The ledger holds ${amount} paise against bill ${billId}, which is not in ` +
        `this contract's bills. A hold against a bill that does not exist is ` +
        `retention nobody can release.`,
    );
  }

  return problems;
}
