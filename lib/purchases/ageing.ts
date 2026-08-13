/**
 * Ordence — ⭐⭐ WHO GETS PAID THIS WEEK
 * Version: v1.11.0-alpha
 *
 * Pure. No database, no clock. `today` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MONEY GOING OUT HAS LESS DISCIPLINE ON IT THAN THE MONEY COMING
 *    IN, WHICH IS THE WRONG WAY ROUND
 * ══════════════════════════════════════════════════════════════════════
 * Receivables have ageing, credit limits, statements and reminders.
 * Payables, in most businesses, have a printout and a partner deciding
 * on a Friday.
 *
 * ⭐ AND THE DECISION IS NOT "WHO IS OLDEST". Two bills of the same size
 * and the same age are not equally urgent:
 *
 *   - One is to a micro enterprise and costs the DEDUCTION on its whole
 *     value if it is still unpaid on 31 March.
 *   - One is accruing compound interest at three times the bank rate
 *     that is never deductible.
 *   - One is a bill whose goods never arrived and should not be paid at
 *     all.
 *
 * 🔴 A payment run that sorts by age pays the third one first.
 */

import { assertDay, daysBetween } from "./msme";

export class AgeingError extends Error {}

/* ------------------------------------------------------------------ */

export type AgeingBucket = "not_due" | "1_30" | "31_60" | "61_90" | "over_90";

export const AGEING_BUCKETS: readonly AgeingBucket[] = [
  "not_due",
  "1_30",
  "31_60",
  "61_90",
  "over_90",
] as const;

export const BUCKET_LABEL: Readonly<Record<AgeingBucket, string>> = {
  not_due: "Not yet due",
  "1_30": "1 to 30 days",
  "31_60": "31 to 60 days",
  "61_90": "61 to 90 days",
  over_90: "Over 90 days",
};

/**
 * 🔴 AGEING RUNS FROM THE DUE DATE, NOT THE BILL DATE.
 *
 * ⚠️ These are different numbers and only one of them is true. A bill
 * dated the 1st on sixty day terms is not sixty days overdue on the 1st
 * of March; it is not due at all. The receivables side has worked this
 * way since 0027 and the payables side has to agree, or the two reports
 * describe different worlds.
 */
export function bucketOf(args: { dueOn: string | null; today: string }): AgeingBucket {
  assertDay(args.today);
  /** ⚠️ No due date is treated as due now, not as never due. */
  if (args.dueOn === null) return "1_30";
  const days = daysBetween(args.dueOn, args.today);
  if (days <= 0) return "not_due";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "over_90";
}

/* ------------------------------------------------------------------ */
/* THE PAYMENT RUN                                                     */
/* ------------------------------------------------------------------ */

export type PayableBill = {
  id: string;
  vendorId: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueOn: string | null;
  totalMinor: bigint;
  paidMinor: bigint;
  /** 🔴 From the three-way match. A bill that failed cannot be paid. */
  matchState: "matched" | "matched_within_tolerance" | "unmatched" | "no_order" | null;
  /** From the MSME assessment. */
  msmePriority: number;
  msmeDeductionAtRisk: boolean;
  msmeInterestMinor: bigint;
  /** ⚠️ A bill on hold is not paid, whatever else is true of it. */
  onHold: boolean;
  holdReason?: string | null;
};

export type RunLine = {
  bill: PayableBill;
  outstandingMinor: bigint;
  bucket: AgeingBucket;
  daysOverdue: number;
  /** 🔴 Whether it may be paid at all. */
  payable: boolean;
  blockedReason: string | null;
  /** Higher is sooner. */
  priority: number;
  why: string;
};

export type PaymentRun = {
  lines: readonly RunLine[];
  /** What the run would pay, if everything payable were selected. */
  payableTotalMinor: bigint;
  /** ⚠️ Sitting there and NOT payable. */
  blockedTotalMinor: bigint;
  blockedCount: number;
  /** 🔴 Deduction lost if these are not paid before year end. */
  deductionAtRiskMinor: bigint;
  deductionAtRiskCount: number;
  /** Interest already accrued and never deductible. */
  interestAccruedMinor: bigint;
  byBucket: Readonly<Record<AgeingBucket, bigint>>;
};

/**
 * ⭐⭐ BUILD THE RUN.
 *
 * 🔴 THE BLOCKING RULES COME FIRST AND THEY ARE NOT OVERRIDABLE HERE.
 *
 *   ① A bill whose three-way match FAILED is not payable. A payment run
 *      over unmatched bills pays the wrong things faster, and that is
 *      the whole reason the match shipped in the same session.
 *   ② A bill on hold is not payable.
 *   ③ A bill with nothing outstanding is not payable, which sounds
 *      obvious and is the second most common duplicate payment: the
 *      same bill, paid on two runs three weeks apart.
 *
 * ⚠️ `no_order` is NOT blocked. Plenty of legitimate spend has no
 * purchase order — a utility bill, a professional fee, a statutory
 * payment. Blocking it would make the run useless and teach people to
 * raise fake orders.
 */
export function buildPaymentRun(args: {
  bills: readonly PayableBill[];
  today: string;
}): PaymentRun {
  assertDay(args.today);

  const lines: RunLine[] = [];
  let payableTotal = 0n;
  let blockedTotal = 0n;
  let blockedCount = 0;
  let atRisk = 0n;
  let atRiskCount = 0;
  let interest = 0n;

  const byBucket: Record<AgeingBucket, bigint> = {
    not_due: 0n,
    "1_30": 0n,
    "31_60": 0n,
    "61_90": 0n,
    over_90: 0n,
  };

  for (const b of args.bills) {
    if (b.totalMinor < 0n || b.paidMinor < 0n) {
      throw new AgeingError(`Amounts cannot be negative on bill ${b.invoiceNumber}.`);
    }
    const outstanding = b.totalMinor - b.paidMinor;
    const bucket = bucketOf({ dueOn: b.dueOn, today: args.today });
    const daysOverdue = b.dueOn === null ? 0 : Math.max(0, daysBetween(b.dueOn, args.today));

    let payable = true;
    let blocked: string | null = null;

    if (outstanding <= 0n) {
      payable = false;
      blocked =
        "Nothing outstanding. This bill is settled, and paying it again is the commonest loss in accounts payable.";
    } else if (b.onHold) {
      payable = false;
      blocked = b.holdReason ?? "On hold.";
    } else if (b.matchState === "unmatched") {
      payable = false;
      blocked =
        "The three-way match failed: what was ordered, what arrived and what was billed do not agree. Resolve the discrepancy or correct the receipt before this is paid.";
    }

    /**
     * ⭐ PRIORITY. The MSME assessment already scored the tax
     * consequence; age only breaks ties below it.
     */
    let priority = b.msmePriority;
    const reasons: string[] = [];

    if (b.msmeDeductionAtRisk) {
      reasons.push("the deduction on the whole value is lost if this is unpaid at 31 March");
    }
    if (b.msmeInterestMinor > 0n) {
      reasons.push("compound interest under s.16 MSMED is already running and is never deductible");
    }
    if (daysOverdue > 90) {
      priority = Math.max(priority, 30);
      reasons.push(`${daysOverdue} days past its due date`);
    } else if (daysOverdue > 0) {
      priority = Math.max(priority, 20);
      reasons.push(`${daysOverdue} days past its due date`);
    }
    if (!payable) priority = 0;

    if (payable) {
      payableTotal += outstanding;
      byBucket[bucket] += outstanding;
      if (b.msmeDeductionAtRisk) {
        atRisk += outstanding;
        atRiskCount += 1;
      }
      interest += b.msmeInterestMinor;
    } else {
      blockedTotal += outstanding > 0n ? outstanding : 0n;
      blockedCount += 1;
    }

    lines.push({
      bill: b,
      outstandingMinor: outstanding,
      bucket,
      daysOverdue,
      payable,
      blockedReason: blocked,
      priority,
      why: blocked ?? (reasons.length > 0 ? `Pay soon: ${reasons.join("; ")}.` : "Not urgent."),
    });
  }

  /**
   * 🔴 BLOCKED BILLS SORT TO THE TOP, NOT THE BOTTOM.
   *
   * ⚠️ They are the ones needing a decision. Pushing them to the end of
   * a long list is how a bill sits unmatched for five months while
   * everybody assumes somebody else is looking at it.
   */
  lines.sort((a, b) => {
    if (a.payable !== b.payable) return a.payable ? 1 : -1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
    return a.bill.invoiceNumber < b.bill.invoiceNumber ? -1 : 1;
  });

  return {
    lines,
    payableTotalMinor: payableTotal,
    blockedTotalMinor: blockedTotal,
    blockedCount,
    deductionAtRiskMinor: atRisk,
    deductionAtRiskCount: atRiskCount,
    interestAccruedMinor: interest,
    byBucket,
  };
}

/* ------------------------------------------------------------------ */
/* ALLOCATION                                                          */
/* ------------------------------------------------------------------ */

export type Allocation = { invoiceId: string; allocatedMinor: bigint };

/**
 * ⭐ SPREAD A PAYMENT ACROSS BILLS, OLDEST FIRST.
 *
 * 🔴 NEVER MORE THAN THE OUTSTANDING BALANCE ON ANY BILL, and never
 *    more in total than the amount being paid. The database refuses an
 *    over-allocation as well; this makes the arithmetic right before it
 *    is attempted rather than producing a constraint violation on a
 *    screen.
 *
 * ⚠️ AND THE REMAINDER IS RETURNED RATHER THAN SILENTLY ABSORBED. Money
 * paid that lands on no bill is an advance to the vendor, which is a
 * real thing and a different ledger account. Swallowing it would leave a
 * payment that does not reconcile to anything.
 */
export function allocateOldestFirst(args: {
  amountMinor: bigint;
  bills: readonly { id: string; dueOn: string | null; outstandingMinor: bigint }[];
}): { allocations: Allocation[]; unallocatedMinor: bigint } {
  if (args.amountMinor < 0n) {
    throw new AgeingError("A payment cannot be negative.");
  }

  const ordered = [...args.bills]
    .filter((b) => b.outstandingMinor > 0n)
    .sort((a, b) => {
      /** ⚠️ Undated bills are treated as oldest, not newest. */
      const ad = a.dueOn ?? "0000-00-00";
      const bd = b.dueOn ?? "0000-00-00";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  let left = args.amountMinor;
  const allocations: Allocation[] = [];

  for (const b of ordered) {
    if (left <= 0n) break;
    const take = b.outstandingMinor < left ? b.outstandingMinor : left;
    allocations.push({ invoiceId: b.id, allocatedMinor: take });
    left -= take;
  }

  return { allocations, unallocatedMinor: left };
}
