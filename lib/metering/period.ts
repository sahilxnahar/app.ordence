/**
 * Ordence — Metering Period Resolution
 * Version: v0.14.0-alpha (Phase 15)
 *
 * Pure and isomorphic. Which bucket a unit of usage lands in decides which
 * invoice it appears on, so the server recorder, the usage page and Phase
 * 16's overage run must all compute it identically.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PERIOD IS THE BILLING PERIOD. IT IS NOT THE CALENDAR MONTH.
 * ══════════════════════════════════════════════════════════════════════
 * A subscription bought on the 9th of March renews on the 9th of April.
 * Its allowance therefore runs 9th→9th. Bucketing that usage by calendar
 * month produces two failures at once:
 *
 *   • The customer's allowance appears to reset on the 1st, three weeks
 *     into a period they have already half-consumed — so the figure on the
 *     usage page does not match the figure on the invoice, and the invoice
 *     is the one they will read carefully.
 *   • The overage line for April would cover 1–30 April while the
 *     subscription covers 9 April – 9 May, and the eight days in between
 *     are either billed twice or not at all. Both are discovered by a
 *     customer, not by us.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHERE THE BOUNDARY COMES FROM, IN PRIORITY ORDER
 * ══════════════════════════════════════════════════════════════════════
 *
 *   1. `subscriptions.current_period_start` / `current_period_end`.
 *      These are maintained by the Phase 11 webhook path and are what the
 *      customer is actually billed against. They are AUTHORITATIVE. This
 *      module does not recompute what the provider has already told us.
 *
 *   2. Rolled forward with `addInterval` when `now` has passed the stored
 *      period end. That happens routinely for minutes to hours: the
 *      renewal has occurred but the webhook confirming it has not landed
 *      yet. Usage in that window must still be recorded somewhere, and
 *      putting it in the OLD period would inflate a month that has closed
 *      and is about to be invoiced.
 *
 *   3. A UTC calendar month, ONLY when there is no subscription at all —
 *      a workspace mid-signup, or one created before billing existed.
 *      There is no billing anchor to honour, so the calendar is the only
 *      honest answer. Flagged as `calendar_fallback` so a reader of the
 *      data can tell the difference.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE 31ST, AND WHY `addInterval` IS IMPORTED RATHER THAN REWRITTEN
 * ══════════════════════════════════════════════════════════════════════
 * `lib/billing/money.ts` already solved this: a subscription anchored on
 * 31 January has no 31 February, JavaScript's `Date` rolls that over to
 * 2 March, and the anchor silently walks forward for the rest of time
 * until the customer is billed on the 3rd and nobody can say why. Its
 * `addInterval` clamps to the last day of the target month instead.
 *
 * A second month-arithmetic implementation here would be a second place
 * for that bug to live, and the two would disagree at precisely the
 * boundary where the disagreement costs money. So it is imported.
 *
 * ⚠️ ONE HONEST CAVEAT, stated because it is real. Rolling forward
 * repeatedly from a CLAMPED date drifts: 31 Jan → 28 Feb → 28 Mar, where
 * the provider would have said 31 Mar. That only matters if the renewal
 * webhook is missing for an entire extra period, which is a billing
 * incident with its own alarm (Phase 11 reconciliation), and the moment
 * the webhook lands rule 1 takes over again and the boundary is exact.
 * The alternative — reconstructing the anchor day ourselves — means
 * reimplementing the month-length clamp this module exists to avoid.
 */

import { addInterval, type BillingIntervalName } from "@/lib/billing/money";

export type PeriodSource = "subscription" | "rolled_forward" | "calendar_fallback";

export type MeteringPeriod = {
  /** Inclusive. The bucket key. */
  periodStart: Date;
  /** Exclusive. `periodStart` of the next period. */
  periodEnd: Date;
  source: PeriodSource;
};

export type PeriodInput = {
  /** `subscriptions.current_period_start`, or null when there is none. */
  subscriptionPeriodStart: Date | null;
  /** `subscriptions.current_period_end`, or null. */
  subscriptionPeriodEnd: Date | null;
  /** `subscriptions.interval`. Defaults to monthly when absent. */
  interval: BillingIntervalName | null;
  /** Injected so the decision is deterministic and testable. */
  now: Date;
};

/**
 * A guard on the roll-forward loop.
 *
 * A corrupt anchor far in the past (a bad backfill, a clock at the epoch)
 * would otherwise spin for tens of thousands of iterations inside a
 * best-effort recorder that is supposed to be invisible. Twenty-four steps
 * is two years of monthly periods; anything beyond that is not a late
 * webhook, it is bad data, and the calendar fallback is a better answer
 * than a hung request.
 */
const MAX_ROLL_FORWARD_STEPS = 24;

/**
 * The UTC calendar month containing `now`.
 *
 * Used only as the no-subscription fallback. Built by truncating to the
 * first of the month and then calling `addInterval`, so even the fallback
 * does not contain hand-written month arithmetic.
 */
export function calendarMonthPeriod(now: Date): MeteringPeriod {
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  return {
    periodStart,
    periodEnd: addInterval(periodStart, "monthly"),
    source: "calendar_fallback",
  };
}

/**
 * Work out which bucket a unit of usage recorded at `now` belongs to.
 */
export function resolveMeteringPeriod(input: PeriodInput): MeteringPeriod {
  const { subscriptionPeriodStart, subscriptionPeriodEnd, now } = input;
  const interval: BillingIntervalName = input.interval ?? "monthly";

  if (!subscriptionPeriodStart || !subscriptionPeriodEnd) {
    return calendarMonthPeriod(now);
  }

  // A period that does not end after it starts is corrupt — the Phase 11
  // CHECK constraint makes it impossible to store, so seeing one means the
  // value did not come from the database. Do not bucket usage against it.
  if (subscriptionPeriodEnd.getTime() <= subscriptionPeriodStart.getTime()) {
    return calendarMonthPeriod(now);
  }

  // Inside the stored period, including exactly at its start. This is the
  // overwhelmingly common case and it does no arithmetic at all.
  if (now.getTime() < subscriptionPeriodEnd.getTime()) {
    /**
     * `now` BEFORE the period start is possible: a webhook can advance the
     * period a few seconds ahead of our clock, and a plan change writes a
     * future-dated period. The usage still belongs to the subscription the
     * customer holds, so it goes in the stored period rather than into a
     * synthesised past one that nothing will ever invoice.
     */
    return {
      periodStart: subscriptionPeriodStart,
      periodEnd: subscriptionPeriodEnd,
      source: "subscription",
    };
  }

  // Past the stored end — the renewal happened, the webhook has not landed.
  let periodStart = subscriptionPeriodEnd;
  let periodEnd = addInterval(periodStart, interval);

  for (let step = 0; step < MAX_ROLL_FORWARD_STEPS; step += 1) {
    if (now.getTime() < periodEnd.getTime()) {
      return { periodStart, periodEnd, source: "rolled_forward" };
    }
    periodStart = periodEnd;
    periodEnd = addInterval(periodStart, interval);
  }

  // Two years of unreconciled periods. That is not a late webhook.
  return calendarMonthPeriod(now);
}

/** Bucket identity. Two periods are the same bucket iff they start together. */
export function isSamePeriod(a: MeteringPeriod, b: MeteringPeriod): boolean {
  return a.periodStart.getTime() === b.periodStart.getTime();
}

/**
 * A stable, human-readable key for logs and cache keys.
 *
 * ISO-8601 of the start instant in UTC. NOT `YYYY-MM`, which would collide
 * for any subscription whose anchor is not the 1st — the entire point of
 * this module.
 */
export function periodKey(period: MeteringPeriod): string {
  return period.periodStart.toISOString();
}
