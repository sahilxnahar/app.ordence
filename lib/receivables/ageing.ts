/**
 * Ordence — ⭐ Receivable Ageing
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. Money is `bigint` paise; days are civil days.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT AN AGEING REPORT IS FOR, WHICH DECIDES WHERE THE LINES GO
 * ══════════════════════════════════════════════════════════════════════
 * It is the report a developer runs on the 1st of the month to decide who
 * gets chased and in what order, and the one a lender asks for before
 * releasing a tranche. Four buckets — 0-30, 31-60, 61-90, 90+ — because
 * those are the four the whole Indian construction-finance world uses,
 * and a product with its own bucket boundaries produces a number that
 * cannot be compared to anything.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHERE EXACTLY 30, 31, 60, 61 AND 90 DAYS LAND, AND WHY IT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * Every off-by-one in an ageing report is invisible and consequential:
 * a demand that should be in 61-90 sitting in 31-60 is one that does not
 * appear in the escalation list, so it is not chased, so it ages another
 * month.
 *
 * The boundaries are INCLUSIVE UPPER BOUNDS, which is how every Indian
 * bank's stock statement reads:
 *
 *      < 0 days   →  `current`   (not yet due — not an arrear at all)
 *     0–30 days   →  `0-30`      (30 is IN this bucket)
 *    31–60 days   →  `31-60`     (31 is IN this bucket, and 60 is too)
 *    61–90 days   →  `61-90`     (61 is IN this bucket, and 90 is too)
 *      > 90 days  →  `90+`
 *
 * ⚠️ SO `90+` MEANS "MORE THAN 90", NOT "90 OR MORE". The label is the
 * industry's and it is genuinely ambiguous — which is exactly why it is
 * written down here: day 90 is the last day of the 61-90 bucket, and a
 * reimplementation that puts it in 90+ moves an account into the bucket
 * that triggers a cancellation review a day early.
 *
 * ⚠️ AND DAY 0 IS AN ARREAR. A demand due today and unpaid at the moment
 * the report runs is overdue by zero days and belongs in 0-30, not in
 * `current`. Putting it in `current` is how the first day of a chase is
 * lost across an entire portfolio.
 */

import { daysBetween, toCivilDay } from "./interest";
import { formatPaise } from "./numbers";

/* ------------------------------------------------------------------ */
/* BUCKETS                                                             */
/* ------------------------------------------------------------------ */

export const AGEING_BUCKETS = Object.freeze([
  "current",
  "0-30",
  "31-60",
  "61-90",
  "90+",
] as const);

export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const AGEING_BUCKET_LABELS: Readonly<Record<AgeingBucket, string>> =
  Object.freeze({
    current: "Not yet due",
    "0-30": "0–30 days",
    "31-60": "31–60 days",
    "61-90": "61–90 days",
    "90+": "Over 90 days",
  });

/** The inclusive upper bound of each arrears bucket, in days past due. */
export const AGEING_BOUNDARIES = Object.freeze({
  first: 30,
  second: 60,
  third: 90,
});

/**
 * Which bucket a number of days past due falls in.
 *
 * ⚠️ TAKES DAYS, NOT DATES. The two dates are turned into a day count
 * once, by `daysOverdue`, so a report cannot end up with two different
 * definitions of "how late" inside it.
 */
export function bucketForDaysOverdue(daysOverdue: number): AgeingBucket {
  if (daysOverdue < 0) return "current";
  if (daysOverdue <= AGEING_BOUNDARIES.first) return "0-30";
  if (daysOverdue <= AGEING_BOUNDARIES.second) return "31-60";
  if (daysOverdue <= AGEING_BOUNDARIES.third) return "61-90";
  return "90+";
}

/**
 * Days past due. Negative when the demand is not yet due.
 *
 * ⚠️ `asOf` MINUS `dueDate`, in civil days. A demand due on the 15th,
 * unpaid on the 15th, is 0 days overdue — see the file header.
 */
export function daysOverdue(dueDate: string, asOf: string): number {
  return daysBetween(toCivilDay(dueDate), toCivilDay(asOf));
}

export function bucketFor(dueDate: string, asOf: string): AgeingBucket {
  return bucketForDaysOverdue(daysOverdue(dueDate, asOf));
}

/* ------------------------------------------------------------------ */
/* THE REPORT                                                          */
/* ------------------------------------------------------------------ */

/**
 * One outstanding demand, reduced to what the ageing report needs.
 *
 * ⚠️ `outstandingMinor` IS PASSED IN, NOT DERIVED HERE. What is
 * outstanding on a demand depends on receipts, bounced cheques and
 * credits — facts that live in the database — and a pure module that
 * recomputed it from a total and a paid figure would be a second opinion
 * on the number the ledger already holds.
 */
export type AgeingRow = {
  demandId: string;
  noticeNumber: string;
  dueDate: string;
  outstandingMinor: bigint;
  /** Interest accrued and unpaid. Reported beside, never inside, the buckets. */
  interestMinor?: bigint;
  projectId?: string | null;
  projectName?: string | null;
  bookingId?: string | null;
  bookingReference?: string | null;
  buyerId?: string | null;
  buyerName?: string | null;
  unitLabel?: string | null;
};

export type BucketTotals = Readonly<Record<AgeingBucket, bigint>>;

export type AgeingGroup = {
  key: string;
  label: string;
  buckets: BucketTotals;
  totalMinor: bigint;
  /** Arrears only — everything except `current`. */
  overdueMinor: bigint;
  interestMinor: bigint;
  demandCount: number;
  oldestDaysOverdue: number;
};

export type AgeingReport = {
  asOf: string;
  totals: BucketTotals;
  totalMinor: bigint;
  overdueMinor: bigint;
  interestMinor: bigint;
  demandCount: number;
  byProject: AgeingGroup[];
  byBooking: AgeingGroup[];
  byBuyer: AgeingGroup[];
  /** Every row, with its bucket resolved. Drives the drill-down. */
  rows: Array<AgeingRow & { bucket: AgeingBucket; daysOverdue: number }>;
};

function emptyBuckets(): Record<AgeingBucket, bigint> {
  return {
    current: 0n,
    "0-30": 0n,
    "31-60": 0n,
    "61-90": 0n,
    "90+": 0n,
  };
}

/**
 * Age a set of outstanding demands.
 *
 * ⚠️ INTEREST IS REPORTED BESIDE THE BUCKETS AND NEVER INSIDE THEM, and
 * that is a decision rather than an omission. Interest accrues daily, so
 * folding it into a bucket makes the bucket move when nothing happened —
 * and the figure a lender is comparing month on month stops being "money
 * the buyers owe us" and becomes "money plus a clock". The principal
 * ages; the interest is stated.
 */
export function ageReceivables(
  rows: readonly AgeingRow[],
  asOfDay: string,
): AgeingReport {
  const asOf = toCivilDay(asOfDay);

  const totals = emptyBuckets();
  let totalMinor = 0n;
  let overdueMinor = 0n;
  let interestMinor = 0n;

  const projects = new Map<string, AgeingGroup>();
  const bookings = new Map<string, AgeingGroup>();
  const buyers = new Map<string, AgeingGroup>();

  const resolved: AgeingReport["rows"] = [];

  const touch = (
    map: Map<string, AgeingGroup>,
    key: string | null | undefined,
    label: string | null | undefined,
    bucket: AgeingBucket,
    amount: bigint,
    interest: bigint,
    late: number,
  ) => {
    const groupKey = key ?? "unassigned";
    const existing = map.get(groupKey) ?? {
      key: groupKey,
      label: label ?? "Unassigned",
      buckets: emptyBuckets(),
      totalMinor: 0n,
      overdueMinor: 0n,
      interestMinor: 0n,
      demandCount: 0,
      oldestDaysOverdue: 0,
    };
    const buckets = { ...existing.buckets };
    buckets[bucket] = (buckets[bucket] ?? 0n) + amount;
    map.set(groupKey, {
      ...existing,
      buckets,
      totalMinor: existing.totalMinor + amount,
      overdueMinor: existing.overdueMinor + (bucket === "current" ? 0n : amount),
      interestMinor: existing.interestMinor + interest,
      demandCount: existing.demandCount + 1,
      oldestDaysOverdue: Math.max(existing.oldestDaysOverdue, late),
    });
  };

  for (const row of rows) {
    // ⚠️ A ZERO OR NEGATIVE OUTSTANDING IS SKIPPED, NOT BUCKETED. A fully
    // paid demand in an ageing report is a line somebody chases.
    if (row.outstandingMinor <= 0n) continue;

    const late = daysOverdue(row.dueDate, asOf);
    const bucket = bucketForDaysOverdue(late);
    const interest = row.interestMinor ?? 0n;

    totals[bucket] += row.outstandingMinor;
    totalMinor += row.outstandingMinor;
    if (bucket !== "current") overdueMinor += row.outstandingMinor;
    interestMinor += interest;

    resolved.push({ ...row, bucket, daysOverdue: late });

    touch(projects, row.projectId, row.projectName, bucket, row.outstandingMinor, interest, late);
    touch(bookings, row.bookingId, row.bookingReference, bucket, row.outstandingMinor, interest, late);
    touch(buyers, row.buyerId, row.buyerName, bucket, row.outstandingMinor, interest, late);
  }

  // Sorted by what is most overdue, because that is the order somebody
  // works the list in. An alphabetical ageing report is a report nobody
  // reads past the first screen.
  const byOverdue = (a: AgeingGroup, b: AgeingGroup) =>
    b.oldestDaysOverdue - a.oldestDaysOverdue ||
    (b.overdueMinor > a.overdueMinor ? 1 : b.overdueMinor < a.overdueMinor ? -1 : 0);

  return {
    asOf,
    totals,
    totalMinor,
    overdueMinor,
    interestMinor,
    demandCount: resolved.length,
    byProject: [...projects.values()].sort(byOverdue),
    byBooking: [...bookings.values()].sort(byOverdue),
    byBuyer: [...buyers.values()].sort(byOverdue),
    rows: resolved.sort((a, b) => b.daysOverdue - a.daysOverdue),
  };
}

/**
 * The report as lines somebody can read out in a collections meeting.
 * Also the thing that gets pasted into an email to a lender.
 */
export function describeAgeing(report: AgeingReport): string[] {
  return [
    `Receivables as at ${report.asOf}`,
    ...AGEING_BUCKETS.map(
      (bucket) =>
        `${AGEING_BUCKET_LABELS[bucket].padEnd(14)} ₹${formatPaise(report.totals[bucket])}`,
    ),
    `Total outstanding ₹${formatPaise(report.totalMinor)}, of which ₹${formatPaise(report.overdueMinor)} is overdue`,
    `Interest accrued and unpaid ₹${formatPaise(report.interestMinor)} (stated separately — it accrues daily and is not aged)`,
  ];
}
