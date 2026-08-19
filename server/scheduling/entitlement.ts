import "server-only";

/**
 * Ordence — ⭐⭐ "MAY THIS WORKSPACE HAVE THIS DONE FOR IT", WITH NO SESSION
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY `getEntitlementContext()` COULD NOT BE REUSED
 * ══════════════════════════════════════════════════════════════════════
 * `server/entitlements.ts` resolves entitlements from a `TenantContext`,
 * and a `TenantContext` contains a `User`, a Clerk user id, a Clerk org
 * id, a role and a request id. A scheduler has none of those. The only
 * ways to reuse it were to fabricate a `TenantContext` — a service
 * account by another name, with a fake user id that would then be written
 * into `created_by` columns and audit rows — or to run the sweep with no
 * entitlement check at all.
 *
 * 🔴 NO CHECK AT ALL IS THE DEFECT THIS CODEBASE KEEPS PRODUCING. Thirty
 * four of seventy one entitlement keys have been declared, displayed and
 * gated by nothing. A nightly job that chases debtors for a workspace
 * whose plan does not include `sales.orders` is that defect with a cron
 * attached: the capability is being delivered, on a schedule, to somebody
 * who is not paying for it, and no screen would ever show it.
 *
 * ⭐ SO THE TWO READS ARE REPEATED HERE AGAINST A TENANT ID, and the
 * DECISION is made by the same pure `evaluateFeature` the interactive
 * gate uses. There is no second copy of the rules — only a second way of
 * finding the two facts the rules need.
 *
 * ⚠️ NO `cache()`. React's `cache()` deduplicates within one request; a
 * sweep is one request across five hundred workspaces, and a cache keyed
 * on nothing would hand workspace two the answer for workspace one.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { subscriptions, plans, grantsAccess } from "@/db/schema";
import { platformTenantFlags } from "@/db/schema/platform";
import { ENTITLEMENT_OVERRIDE_PREFIX } from "@/lib/entitlements/overrides";
import { evaluateFeature } from "@/lib/entitlements/features";
import type { PlanTier } from "@/db/schema/core";

/**
 * ⚠️ `cachedPlanTier` IS THE FALLBACK, NOT THE AUTHORITY, for exactly the
 * reason `server/entitlements.ts` gives: `tenants.plan_tier` is a
 * denormalised cache that goes stale when a webhook is delayed or lost.
 * The subscription row wins when there is one. The caller reads the
 * cached column out of the same `tenants` row it already selected to
 * build the sweep list, so this costs no extra query.
 */
export async function tenantAllowsFeature(args: {
  tenantId: string;
  feature: string;
  cachedPlanTier: PlanTier;
}): Promise<{ allowed: boolean; reason: string }> {
  const [row, flagRows] = await withTenant(args.tenantId, (tx) =>
    Promise.all([
      tx
        .select({ status: subscriptions.status, tier: plans.tier })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, args.tenantId),
            sql`${subscriptions.deletedAt} IS NULL`,
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0]),
      tx
        .select({
          flagKey: platformTenantFlags.flagKey,
          enabled: platformTenantFlags.enabled,
        })
        .from(platformTenantFlags)
        .where(
          and(
            eq(platformTenantFlags.tenantId, args.tenantId),
            sql`${platformTenantFlags.flagKey} LIKE ${ENTITLEMENT_OVERRIDE_PREFIX + "%"}`,
            /**
             * ⚠️ AN EXPIRED OVERRIDE IS NOT AN OVERRIDE, and the filter is
             * in SQL rather than TypeScript so a forgotten pilot switches
             * itself off without anybody remembering. Copied deliberately
             * from `getEntitlementContext`; a nightly job that kept
             * honouring an expired grant would be the one place nobody
             * ever looked.
             */
            sql`(${platformTenantFlags.expiresAt} IS NULL OR ${platformTenantFlags.expiresAt} > now())`,
          ),
        ),
    ]),
  );

  const overrides: Record<string, boolean> = {};
  for (const flag of flagRows) {
    overrides[flag.flagKey.slice(ENTITLEMENT_OVERRIDE_PREFIX.length)] = flag.enabled;
  }

  const subscriptionGrantsAccess = row ? grantsAccess(row.status) : true;
  const planTier: PlanTier = row ? row.tier : args.cachedPlanTier;

  const decision = evaluateFeature(args.feature, {
    planTier,
    subscriptionGrantsAccess,
    overrides,
  });

  return {
    allowed: decision.allowed,
    /**
     * ⚠️ THE REASON IS RETURNED, NOT SWALLOWED. "Skipped 40 of 500
     * workspaces" with no reason reads as a bug; "skipped because the plan
     * does not include sales.orders" reads as the product working.
     */
    reason: decision.allowed
      ? `Entitled to ${args.feature}.`
      : `Not entitled to ${args.feature} on the ${planTier} plan${
          subscriptionGrantsAccess ? "" : " (subscription does not grant access)"
        }.`,
  };
}
