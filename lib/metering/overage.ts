/**
 * Ordence — What Happens ABOVE the Line
 * Version: v1.52.0-alpha (Batch 56)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AN UNSTATED OVERAGE POLICY IS THE WORST OF THE THREE OPTIONS.
 * ══════════════════════════════════════════════════════════════════════
 * There are exactly two defensible answers to "what happens when I go
 * over": REFUSED, or BILLED. Both are honest. What is not honest is the
 * third answer this codebase had until now — the behaviour existed
 * (`hardBlockBps` in `lib/metering/quota.ts` decides it, per metric) but
 * the sentence describing it appeared on no screen. A customer discovers
 * a refusal when an upload fails, and discovers a charge when the invoice
 * arrives. Both discoveries are support tickets, and the second one is a
 * chargeback.
 *
 * So the policy is DATA here, it is derived from the same `hardBlockBps`
 * that enforces it (rather than being a second copy that can disagree),
 * and `serialiseQuotaState` carries the sentence to the screen so the
 * pricing page, the usage card and the refusal message cannot drift apart.
 *
 * ⚠️ This file imports only a TYPE from `quota.ts`. `quota.ts` imports a
 * VALUE from here. That asymmetry is deliberate — a type-only edge is
 * erased at compile time, so there is no runtime cycle.
 */

import type { UsageMetric } from "./quota";

/**
 * REFUSED — consumption stops at a stated ceiling. Nothing is charged.
 * BILLED  — consumption continues and appears as a line on the next
 *           invoice at the plan's stated per-unit rate.
 * NONE    — the metric is measured for support and capacity, never capped
 *           and never charged. It cannot surprise anyone.
 */
export const OVERAGE_POLICIES = ["refused", "billed", "none"] as const;
export type OveragePolicy = (typeof OVERAGE_POLICIES)[number];

/**
 * ⭐ THE DECISION, PER METRIC, WITH THE REASON.
 *
 * STORAGE → REFUSED. An un-refused byte is a bill we pay every month
 *   forever, and the remedy (delete something) is free and instant. Billing
 *   for it instead would mean a customer who forgot about an import wakes
 *   up to a charge they never chose. Refusal is reversible; a surprise
 *   invoice is not.
 *
 * EMAILS → REFUSED, but at 150% rather than 100% (see `hardBlockBps`).
 *   Email in this product is transactional and involves a THIRD PARTY who
 *   is waiting for a document. Charging for it would be defensible; the
 *   headroom is the kinder version of the same answer.
 *
 * API CALLS → BILLED. This is the metric an integrator builds against, and
 *   an API that starts returning 429 at an unannounced threshold breaks a
 *   pipeline at 3am. A line on an invoice does not.
 *
 * PORTAL LINKS → NONE. No plan column, no cap, no charge.
 */
const POLICY: Readonly<Record<UsageMetric, OveragePolicy>> = Object.freeze({
  storage_bytes: "refused",
  emails_sent: "refused",
  api_calls: "billed",
  portal_links_created: "none",
});

export function overagePolicy(metric: UsageMetric): OveragePolicy {
  const policy = POLICY[metric];
  // Loud beats silent, same rule as `metricDefinition`. Falling through to
  // "none" would quietly promise a customer that a capped metric is free.
  if (!policy) throw new Error(`No overage policy declared for metric "${metric}".`);
  return policy;
}

/**
 * The sentence the customer reads, BEFORE they are over rather than after.
 *
 * Written in the second person and in the present tense because it
 * describes a rule that is already in force, not a threat about the
 * future. No number is interpolated here — the numbers live in the quota
 * state and are rendered next to this line, and duplicating them would
 * create a second place for "500 MB" to be wrong.
 */
export function overageSentence(metric: UsageMetric): string {
  switch (overagePolicy(metric)) {
    case "refused":
      return (
        "Going over is refused, not charged. Nothing you already have is " +
        "touched, and you are never billed for use you did not agree to."
      );
    case "billed":
      return (
        "Going over is billed, not refused. Nothing stops working; use above " +
        "your allowance appears as a separate line on your next invoice."
      );
    case "none":
      return "Not limited and not charged on any plan.";
  }
}

/** True when exceeding this metric can produce a charge. Drives the UI tone. */
export function overageCosts(metric: UsageMetric): boolean {
  return overagePolicy(metric) === "billed";
}
