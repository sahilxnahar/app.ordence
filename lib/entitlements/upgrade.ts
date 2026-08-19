/**
 * Ordence — What A Refusal Has To Tell The Person Reading It
 * Version: v1.68.0-alpha · Batch 0109
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A REFUSAL THAT DOES NOT NAME A REMEDY IS AN OUTAGE
 * ══════════════════════════════════════════════════════════════════════
 * `evaluateFeature()` already produces a sentence, and for the ordinary
 * case it is a good one: "Payroll is available on the Advanced plan."
 * What it cannot produce is the OTHER half of what the reader needs,
 * because it has no idea what state the account is in:
 *
 *   • A workspace on Basic that never bought payroll needs a PRICE and a
 *     link. That is a purchase decision.
 *   • A workspace on Advanced whose card failed needs to know their data
 *     is safe and that a card update restores it. That is alarm, not a
 *     purchase decision, and offering to sell them something they already
 *     own is the worst available answer.
 *   • A workspace whose feature was switched off by our own staff must
 *     never be offered an upgrade at all — they may already be paying for
 *     the tier, and an upgrade will not restore it.
 *
 * `evaluateFeature` distinguishes those three by `reason`. Nothing was
 * reading the distinction. By the time a refusal reached a customer it
 * had been flattened to `err.message` inside an `ActionResult`, and the
 * three remedies had become one string.
 *
 * ⭐ SO THE REMEDY IS DATA HERE, AND THE SENTENCE IS DERIVED FROM IT.
 * `server/entitlements.ts` builds one of these at the moment it throws,
 * and `FeatureLockedError.message` IS `refusal.sentence` — so the words
 * a customer sees are computed from the reason and the standing rather
 * than from whichever call site happened to catch the error.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS PURE
 * ══════════════════════════════════════════════════════════════════════
 * The same three sentences are needed by the server gate (which throws
 * them), by an upgrade panel (which renders them) and by a test (which
 * asserts that every refusing reason names a plan). A second copy on the
 * client is how "the page said upgrade and the server said contact
 * support" happens.
 */

import {
  FEATURE_CATALOG,
  TIER_LABELS,
  isFeatureKey,
  type EntitlementDecision,
  type FeatureKey,
} from "./features";
import type { AccessLevel } from "@/lib/billing/access-state";
import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* THE STANDING THIS READS                                             */
/* ------------------------------------------------------------------ */

/**
 * The part of `AccessDecision` that changes the WORDS of a refusal.
 *
 * ⚠️ Deliberately a narrow structural type rather than `AccessDecision`
 * itself. `server/billing/access.ts` computes the full decision from the
 * subscription; this file needs two fields of it, and taking the whole
 * shape would drag a server module's return type into a pure one and
 * make the pure module impossible to test without inventing a
 * subscription.
 */
export type BillingStanding = {
  level: AccessLevel;
  /** Days left in a trial or a dunning grace window. Null when neither. */
  daysRemaining: number | null;
};

/* ------------------------------------------------------------------ */
/* THE REFUSAL                                                         */
/* ------------------------------------------------------------------ */

/**
 * What to do about it. Four values, because there are four different
 * people who can act and telling one of them to do another's job is the
 * failure this whole file exists to prevent.
 */
export const REFUSAL_REMEDIES = [
  /** Buy a higher tier. Aimed at whoever holds the card. */
  "upgrade",
  /** Fix the payment method. The plan already includes it. */
  "restore_payment",
  /** A human at Ordence turned it off. Only a human can turn it back on. */
  "contact_support",
  /** The key does not exist. Nobody can buy it; this is a defect. */
  "unavailable",
  /** Not refused at all. */
  "none",
] as const;

export type RefusalRemedy = (typeof REFUSAL_REMEDIES)[number];

export type FeatureRefusal = {
  feature: FeatureKey;
  /** Plain language. Never a feature key — customers do not read keys. */
  featureLabel: string;
  /** The tier in force right now. */
  currentTier: PlanTier;
  /**
   * The cheapest tier that includes it, and `null` when no tier does —
   * an unknown key, which is a defect rather than a purchase.
   */
  requiredTier: PlanTier | null;
  remedy: RefusalRemedy;
  /** Where the remedy is carried out. Null when no screen can help. */
  href: string | null;
  /** Ready to show a customer, and it always names the plan when one exists. */
  sentence: string;
};

/** The one screen that can take money or a new card. */
const BILLING_HREF = "/settings/billing";

/* ------------------------------------------------------------------ */
/* THE DERIVATION                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `standing` IS OPTIONAL AND ITS ABSENCE IS NOT AN ERROR.
 *
 * `server/billing/access.ts` fails OPEN by design — a billing-table
 * outage must never become an outage in a customer's business. A gate
 * that could not resolve the standing therefore passes `null` and gets a
 * sentence that is still correct, just without the "4 days left" clause.
 * Making the standing mandatory would mean a refusal could fail to be
 * produced at all, which turns a paywall into a 500.
 */
export function refusalFor(
  decision: EntitlementDecision,
  standing?: BillingStanding | null,
): FeatureRefusal {
  const known = isFeatureKey(decision.feature);
  const label = known
    ? FEATURE_CATALOG[decision.feature].label
    : String(decision.feature);
  const requiredTier = known ? FEATURE_CATALOG[decision.feature].minTier : null;

  const base = {
    feature: decision.feature,
    featureLabel: label,
    currentTier: decision.effectiveTier,
    requiredTier,
  };

  if (decision.allowed) {
    return {
      ...base,
      remedy: "none",
      href: null,
      sentence: decision.message,
    };
  }

  switch (decision.reason) {
    /**
     * 🔴 NO UPGRADE OFFER, EVER. See `evaluateFeature` — the customer may
     * already be paying for the tier that includes this, and inviting
     * them to buy it again is the single worst response available.
     */
    case "revoked_by_override":
      return {
        ...base,
        remedy: "contact_support",
        href: null,
        sentence:
          `${label} has been switched off for this workspace by Ordence. ` +
          `An upgrade will not restore it — please contact support, and ` +
          `whoever switched it off recorded a reason they can give you.`,
      };

    /**
     * The plan already includes it. The reader's first question is
     * whether their records have gone, so that is answered first and
     * nothing else can be heard until it is.
     */
    case "subscription_inactive":
      return {
        ...base,
        remedy: "restore_payment",
        href: BILLING_HREF,
        sentence:
          `${label} is paused because the subscription is not active. ` +
          `Everything already entered is safe and can still be read and ` +
          `exported.${graceClause(standing)} Updating the payment details ` +
          `restores it straight away.`,
      };

    /**
     * ⚠️ A TYPO AT A CALL SITE LANDS HERE. It must not read as a sales
     * message: there is no plan to buy, and telling somebody to upgrade
     * for a capability that does not exist wastes their money and our
     * support time. It says the true thing, which is that this is ours
     * to fix.
     */
    case "unknown_feature":
      return {
        ...base,
        remedy: "unavailable",
        href: null,
        sentence:
          `That capability does not exist in Ordence, so no plan includes ` +
          `it. This is a defect rather than a limit — please report it.`,
      };

    case "requires_upgrade":
    default:
      return {
        ...base,
        remedy: "upgrade",
        href: BILLING_HREF,
        sentence:
          `${label} is on the ${planLabel(requiredTier)} plan. This ` +
          `workspace is on ${TIER_LABELS[decision.effectiveTier]}.` +
          `${trialClause(standing)} Upgrading to ` +
          `${planLabel(requiredTier)} switches it on immediately — ` +
          `nothing already entered is lost and nothing needs setting up again.`,
      };
  }
}

/**
 * ⚠️ `requiredTier` can be null only for an unknown key, and that branch
 * never reaches here. The fallback exists so a future reason cannot make
 * this throw — a refusal that throws while explaining a refusal is an
 * error page where a paywall should have been.
 */
function planLabel(tier: PlanTier | null): string {
  return tier ? TIER_LABELS[tier] : "a higher";
}

/**
 * The dunning clause.
 *
 * ⚠️ Only at the rungs where a clock is actually running. `full` has no
 * deadline and inventing one would be a threat we do not mean; `locked`
 * is an administrative suspension where a countdown is simply false.
 */
function graceClause(standing?: BillingStanding | null): string {
  if (!standing || standing.daysRemaining === null) return "";
  if (standing.level !== "notice" && standing.level !== "warning") return "";
  if (standing.daysRemaining <= 0) return "";
  return standing.daysRemaining === 1
    ? " There is one day left to settle it."
    : ` There are ${standing.daysRemaining} days left to settle it.`;
}

/**
 * The trial clause.
 *
 * A prospect being refused something mid-trial is deciding whether to
 * buy, and "your trial ends in three days" is the fact that decides it.
 * Anything else is noise on a purchase screen, so nothing else is added.
 */
function trialClause(standing?: BillingStanding | null): string {
  if (!standing || standing.daysRemaining === null) return "";
  if (standing.level !== "notice") return "";
  if (standing.daysRemaining <= 0) return "";
  return standing.daysRemaining === 1
    ? " Your trial ends tomorrow."
    : ` Your trial ends in ${standing.daysRemaining} days.`;
}

/**
 * ⭐ THE PROPERTY THE LEDGER'S TEST ASSERTS.
 *
 * Every refusal a customer can reach, except the two where no plan
 * exists to name, must name the plan. Stated as a function rather than
 * left implicit in the switch above so the test asserts the RULE and not
 * the wording — the wording will be edited by whoever next reads a
 * support ticket, and it should be.
 */
export function mustNamePlan(remedy: RefusalRemedy): boolean {
  return remedy === "upgrade";
}
