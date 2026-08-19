/**
 * Ordence — Invoice Line Composition
 * Version: v0.16.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM `server/billing/invoice-generator.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Everything here is PURE: given a plan, a period and a seat count, it
 * returns the lines that should appear on the bill. No database, no
 * clock beyond what is passed in.
 *
 * That matters because this is where the commercial judgement lives —
 * whether extra seats get their own line, how a proration is described,
 * what a customer can actually check — while the generator is mechanical
 * bookkeeping around it.
 *
 * It is also the THIRD time this split has been needed. The subscription
 * state machine (Phase 11) and now this both started inside a module that
 * imports `@/db`, and both had to come out: `db/index.ts` builds its
 * client at module load, which reads the environment, and `getServerEnv()`
 * correctly refuses to run under jsdom. So any pure logic living beside a
 * database import cannot be unit-tested without mocking the database —
 * which means mocking the thing you are trying to test around.
 *
 * The rule that falls out of it: **decision logic does not live in a file
 * that imports the database.** Worth applying deliberately from here on
 * rather than discovering it a fourth time.
 */

import { computeProration } from "@/lib/billing/money";

export type InvoiceLineDraft = {
  description: string;
  quantity: number;
  /** Unit price in minor units, EXCLUSIVE of tax. May be negative. */
  unitAmountMinor: bigint;
  lineType: "subscription" | "seat" | "overage" | "proration" | "adjustment";
  periodStart?: Date | null;
  periodEnd?: Date | null;
  sacCode?: string;
};


/* ------------------------------------------------------------------ */
/* BUILDING THE LINES FOR A SUBSCRIPTION PERIOD                        */
/* ------------------------------------------------------------------ */

/**
 * Compose the lines for one billing period of a subscription.
 *
 * Separated from `generateInvoice` because this is the part with
 * commercial judgement in it — what to charge — while the other is
 * mechanical. It is also pure enough to test without a database.
 */
export function buildSubscriptionLines(args: {
  planName: string;
  periodStart: Date;
  periodEnd: Date;
  unitAmountMinor: bigint;
  perSeatAmountMinor: bigint;
  seatsPurchased: number;
  includedSeats: number;
}): InvoiceLineDraft[] {
  const lines: InvoiceLineDraft[] = [];

  const periodLabel = `${args.periodStart.toISOString().slice(0, 10)} to ${args.periodEnd
    .toISOString()
    .slice(0, 10)}`;

  lines.push({
    description: `${args.planName} subscription (${periodLabel})`,
    quantity: 1,
    unitAmountMinor: args.unitAmountMinor,
    lineType: "subscription",
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
  });

  /**
   * Extra seats appear as their OWN LINE, never folded into the plan
   * price.
   *
   * A single line reading "Advanced — ₹8,486" is arithmetic the customer
   * cannot check. Two lines — the plan, then "9 additional users at ₹349"
   * — is a bill someone can reconcile against their own headcount without
   * calling you. Invoices that cannot be checked generate support tickets
   * out of all proportion to the amounts on them.
   */
  const extraSeats = Math.max(0, args.seatsPurchased - args.includedSeats);
  if (extraSeats > 0 && args.perSeatAmountMinor > 0n) {
    lines.push({
      description: `${extraSeats} additional user${extraSeats === 1 ? "" : "s"} beyond the ${args.includedSeats} included`,
      quantity: extraSeats,
      unitAmountMinor: args.perSeatAmountMinor,
      lineType: "seat",
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
    });
  }

  return lines;
}

/**
 * Compose the lines for a mid-cycle plan change.
 *
 * Two lines, always: the credit for unused time on the old plan, and the
 * charge for the remainder on the new one. Netting them into a single
 * "plan change — ₹2,847" line is smaller and completely unverifiable.
 */
export function buildProrationLines(args: {
  oldPlanName: string;
  newPlanName: string;
  periodStart: Date;
  periodEnd: Date;
  changeAt: Date;
  oldAmountMinor: bigint;
  newAmountMinor: bigint;
}): InvoiceLineDraft[] {
  const proration = computeProration({
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    changeAt: args.changeAt,
    oldAmountMinor: args.oldAmountMinor,
    newAmountMinor: args.newAmountMinor,
  });

  const remainingDays = Math.ceil(proration.remainingSeconds / 86_400);

  return [
    {
      description:
        `Credit for ${remainingDays} unused day${remainingDays === 1 ? "" : "s"} ` +
        `on ${args.oldPlanName}`,
      quantity: 1,
      unitAmountMinor: proration.creditMinor,
      lineType: "proration",
      periodStart: args.changeAt,
      periodEnd: args.periodEnd,
    },
    {
      description:
        `${args.newPlanName} for the remaining ${remainingDays} day` +
        `${remainingDays === 1 ? "" : "s"} of this period`,
      quantity: 1,
      unitAmountMinor: proration.chargeMinor,
      lineType: "proration",
      periodStart: args.changeAt,
      periodEnd: args.periodEnd,
    },
  ];
}

