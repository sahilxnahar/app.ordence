/**
 * Ordence — ⭐ Per-Tenant Entitlement Overrides
 * Version: v0.43.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PREFIX AND NOT A NEW TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `platform_tenant_flags` already exists, already has forced row-level
 * security, already requires a written reason on every row, and already
 * has the expiry column. A second table would duplicate all four and
 * eventually disagree with one of them.
 *
 * ⚠️ BUT IT ALSO ALREADY HOLDS BETA FLAGS, and
 * `lib/platform/flags-catalog.ts` is explicit that those must never
 * permanently grant a paid capability — "the price list would quietly
 * move into a table with no invoice attached to it."
 *
 * So the two live in one table under separate namespaces. A beta flag is
 * `beta.ai_assistant`; an entitlement override is
 * `entitlement:sales.orders`. Without the prefix the two namespaces would
 * be one, and a beta flag whose name happened to collide with a feature
 * key would become a silent free upgrade that no invoice ever mentions.
 */

import type { FeatureKey } from "./features";

/** ⚠️ Changing this orphans every existing override. It is a constant. */
export const ENTITLEMENT_OVERRIDE_PREFIX = "entitlement:";

export function overrideKeyFor(feature: FeatureKey): string {
  return `${ENTITLEMENT_OVERRIDE_PREFIX}${feature}`;
}

export function isOverrideKey(key: string): boolean {
  return key.startsWith(ENTITLEMENT_OVERRIDE_PREFIX);
}

export function featureFromOverrideKey(key: string): string {
  return key.slice(ENTITLEMENT_OVERRIDE_PREFIX.length);
}

/**
 * ⭐ GRANTING A FEATURE ABOVE THE PLAN REQUIRES AN END DATE.
 *
 * ⚠️ THIS IS THE RULE THAT KEEPS THE PRICE LIST HONEST. A grant with no
 * expiry is a discount nobody signed off, applied to one customer,
 * invisible in every revenue report, and remembered by nobody after the
 * salesperson who promised it leaves. An expiry turns it into what it
 * actually is — a trial with an end.
 *
 * REVOKING is deliberately exempt. The moment you most need to switch
 * something off is the moment a validation rule refusing you is most
 * expensive.
 */
export function overrideRequiresExpiry(args: {
  enabled: boolean;
  includedInPlan: boolean;
}): boolean {
  return args.enabled && !args.includedInPlan;
}
