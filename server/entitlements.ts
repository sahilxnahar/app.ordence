import "server-only";

/**
 * Ordence — The Server-Side Entitlement Gate
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE GATE. EVERY ROUTE CONSULTS IT.
 * ══════════════════════════════════════════════════════════════════════
 * `requireFeature("accounting.ledger")` is the whole interface. It
 * resolves the caller's tenant, works out the tier actually in force,
 * consults the matrix, and throws if the answer is no.
 *
 * The alternative — scattering `if (tenant.planTier === "advanced")`
 * through the codebase — fails in a specific and predictable way: you add
 * a tier, and you find the seventeenth comparison eight months later
 * because a customer on the new plan cannot reach something they paid
 * for. There is exactly one comparison in this system and it is in
 * `evaluateFeature`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ GRACEFUL DEGRADATION IS NOT OPTIONAL, AND IT IS NOT A HARD CRASH
 * ══════════════════════════════════════════════════════════════════════
 * The Phase 12 brief says "graceful degradation, never a hard crash", and
 * that is a real constraint rather than a nicety.
 *
 * A workspace can lose a feature it was using — a downgrade, an expired
 * card, a plan change. When that happens the RECORDS ARE STILL THERE.
 * Their contracts, their ledger, their documents. If the gate threw a 500
 * on any page that touched a locked feature, the customer would see their
 * data as GONE at exactly the moment we are asking them to pay us. That
 * is the worst possible time to look unreliable.
 *
 * So there are two shapes, deliberately:
 *
 *   `requireFeature()` — for WRITES. Throws. Creating a new journal entry
 *                        on a plan without accounting must fail.
 *   `checkFeature()`   — for READS and rendering. Returns a decision.
 *                        Callers show the data read-only with an upgrade
 *                        prompt beside it.
 *
 * Read your data, always. Add to it, only if you have paid.
 */

import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { subscriptions, plans, grantsAccess } from "@/db/schema";
import { platformTenantFlags } from "@/db/schema/platform";
import { ENTITLEMENT_OVERRIDE_PREFIX } from "@/lib/entitlements/overrides";
import { refusalFor, type BillingStanding } from "@/lib/entitlements/upgrade";
import { requireTenantContext, type TenantContext } from "@/server/tenant-context";
import {
  evaluateFeature,
  effectiveTier,
  featuresForTier,
  FEATURE_CATALOG,
  type EntitlementDecision,
  type FeatureKey,
} from "@/lib/entitlements/features";
import type { PlanTier } from "@/db/schema/core";
import type { PermissionKey } from "@/db/schema/auth";

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Distinct from `PermissionDeniedError` on purpose.
 *
 * They need different HTTP statuses, different UI, and different words.
 * A permission denial says "ask your admin"; an entitlement denial says
 * "upgrade" and is aimed at whoever holds the card. Catching one type for
 * both would guarantee the wrong message eventually.
 */
export class FeatureLockedError extends Error {
  /**
   * ⭐ THE REMEDY, AS DATA — Batch 0109.
   *
   * ⚠️ `message` IS `refusal.sentence`, NOT `decision.message`.
   *
   * Everything that catches this flattens it to a string: every
   * `toSalesActionError` in the product returns `salesFail(err.message)`,
   * and that string is the entire refusal a customer ever sees. So the
   * string has to be the one that names the plan — or the remedy is
   * computed carefully in `lib/entitlements/upgrade.ts` and then thrown
   * away one line later at every single call site.
   *
   * `decision.message` remains available on `decision` for anything that
   * wants the shorter form, and `refusalFor(err.decision, null)` rebuilds
   * the structured remedy in one line for anything that wants that.
   *
   * ⚠️ THE STRUCTURE IS DELIBERATELY NOT KEPT AS A FIELD. Nothing reads
   * it — every catch site in the product uses `err.message` — and a field
   * that is populated and read by nothing is the precise defect this
   * batch was sent to remove. It is one call away when somebody needs it.
   */
  constructor(
    readonly decision: EntitlementDecision,
    standing?: BillingStanding | null,
  ) {
    super(refusalFor(decision, standing).sentence);
    this.name = "FeatureLockedError";
  }

  get feature(): FeatureKey {
    return this.decision.feature;
  }

  get requiredTier(): PlanTier {
    return this.decision.requiredTier;
  }
}

/* ------------------------------------------------------------------ */
/* RESOLVING THE TIER IN FORCE                                         */
/* ------------------------------------------------------------------ */

export type EntitlementContext = {
  tenantId: string;
  /** The tier after trial and lapse adjustment. What the gate uses. */
  effectiveTier: PlanTier;
  /** The raw tier on the plan, before adjustment. For display. */
  planTier: PlanTier;
  subscriptionGrantsAccess: boolean;
  subscriptionStatus: string | null;
  /** True when there is no subscription row at all — a brand-new workspace. */
  isUnsubscribed: boolean;
  /**
   * ⭐ PER-TENANT FEATURE OVERRIDES SET BY PLATFORM STAFF — v0.43.0.
   * Feature key → true (granted above plan) or false (revoked).
   * Empty for almost every workspace.
   */
  overrides: Readonly<Record<string, boolean>>;
};

/**
 * Resolve the entitlement context for the signed-in tenant.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS READS THE SUBSCRIPTION AND NOT JUST `tenants.plan_tier`
 * ══════════════════════════════════════════════════════════════════════
 * `tenants.plan_tier` is a denormalised cache maintained by
 * `reconcile.ts`. It is correct almost always — and "almost always" is
 * not good enough for the column that decides what someone can reach.
 *
 * Two ways it goes stale, both real:
 *   • a webhook is delayed, so a customer who has just upgraded is still
 *     shown the old tier;
 *   • a webhook is lost entirely, so a cancelled customer keeps access.
 *
 * The subscription row is the authority. Reading both and preferring the
 * subscription costs one indexed query per request and removes the
 * failure mode. When there is no subscription — a workspace mid-signup —
 * the cached column is the only thing available and is used as-is.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `cache()` AND NOT A TTL
 * ══════════════════════════════════════════════════════════════════════
 * React's `cache()` deduplicates within a SINGLE REQUEST. A page that
 * gates six panels does one query, not six. It does NOT persist between
 * requests, which is exactly right here: a time-based cache would mean a
 * customer who has just paid still sees a paywall for however long the
 * TTL is, and that is the most expensive moment in the product to look
 * broken.
 */
export const getEntitlementContext = cache(async function getEntitlementContext(
  ctx?: TenantContext,
): Promise<EntitlementContext> {
  const tenantContext = ctx ?? (await requireTenantContext());

  /**
   * ⚠️ READ IN PARALLEL WITH THE SUBSCRIPTION, NOT AFTER IT. Both are
   * needed for every gated panel on a page, `cache()` deduplicates them
   * to one round trip each per request, and running them in sequence
   * would add a full network hop to Neon on the render path of every
   * screen in the product.
   *
   * ⚠️ AN EXPIRED OVERRIDE IS NOT AN OVERRIDE. `expires_at` is filtered
   * in SQL rather than in TypeScript so a forgotten pilot switches itself
   * off at the moment it is supposed to, without anybody remembering.
   */
  const [row, flagRows] = await withTenant(tenantContext.tenant.id, (tx) =>
    Promise.all([
      tx
        .select({ status: subscriptions.status, tier: plans.tier })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, tenantContext.tenant.id),
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
            eq(platformTenantFlags.tenantId, tenantContext.tenant.id),
            sql`${platformTenantFlags.flagKey} LIKE ${ENTITLEMENT_OVERRIDE_PREFIX + "%"}`,
            sql`(${platformTenantFlags.expiresAt} IS NULL OR ${platformTenantFlags.expiresAt} > now())`,
          ),
        ),
    ]),
  );

  /**
   * ⚠️ ONLY `entitlement:` KEYS, AND THE PREFIX IS THE WHOLE POINT.
   *
   * `platform_tenant_flags` already holds BETA FLAGS — `beta.ai_assistant`
   * and friends — and `lib/platform/flags-catalog.ts` states plainly why
   * those must never grant a paid capability permanently: "the price list
   * would quietly move into a table with no invoice attached to it."
   *
   * That boundary is right, and reading the table unfiltered would have
   * demolished it: a beta flag and a feature key would have shared one
   * namespace, and any beta flag whose name happened to match a feature
   * would silently have become a free upgrade. So entitlement overrides
   * live under their own prefix in the same table — same RLS, same
   * mandatory reason, same expiry discipline, no collision.
   */
  const overrides: Record<string, boolean> = {};
  for (const flag of flagRows) {
    overrides[flag.flagKey.slice(ENTITLEMENT_OVERRIDE_PREFIX.length)] = flag.enabled;
  }


  if (!row) {
    // No subscription: fall back to the cached column. A workspace in
    // this state is normally mid-signup, and it will have `trial`.
    const planTier = tenantContext.tenant.planTier;
    return {
      tenantId: tenantContext.tenant.id,
      planTier,
      effectiveTier: effectiveTier({
        planTier,
        subscriptionGrantsAccess: true,
      }),
      subscriptionGrantsAccess: true,
      subscriptionStatus: null,
      isUnsubscribed: true,
      overrides,
    };
  }

  const subscriptionGrantsAccess = grantsAccess(row.status);

  return {
    tenantId: tenantContext.tenant.id,
    planTier: row.tier,
    effectiveTier: effectiveTier({ planTier: row.tier, subscriptionGrantsAccess }),
    subscriptionGrantsAccess,
    subscriptionStatus: row.status,
    isUnsubscribed: false,
    overrides,
  };
});

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

/**
 * Non-throwing check. Use for READS, navigation and rendering.
 *
 * Returns the full decision so the caller can render an accurate upgrade
 * prompt — which tier is needed, and whether this is "never had it" or
 * "lost it".
 */
export async function checkFeature(
  feature: FeatureKey,
  ctx?: TenantContext,
): Promise<EntitlementDecision> {
  const entitlements = await getEntitlementContext(ctx);
  return evaluateFeature(feature, {
    planTier: entitlements.effectiveTier,
    subscriptionGrantsAccess: entitlements.subscriptionGrantsAccess,
    overrides: entitlements.overrides,
  });
}

/** Boolean shorthand. `can()` reads well at a call site. */
export async function can(feature: FeatureKey, ctx?: TenantContext): Promise<boolean> {
  return (await checkFeature(feature, ctx)).allowed;
}

/**
 * Throwing gate. Use for WRITES.
 *
 * ⚠️ CALL THIS BEFORE THE PERMISSION CHECK, NOT AFTER.
 *
 * Order matters for the message, not the outcome. If a workspace owner on
 * Basic tries to post a journal entry, the true answer is "your plan does
 * not include accounting". Checking the permission first would tell them
 * "you do not have permission" — and send the owner of the workspace to
 * ask an administrator who is themselves. That is the single worst error
 * message a SaaS product can produce, and the only defence is the order
 * of two lines.
 */
export async function requireFeature(
  feature: FeatureKey,
  ctx?: TenantContext,
): Promise<EntitlementDecision> {
  const decision = await checkFeature(feature, ctx);
  if (!decision.allowed) {
    throw new FeatureLockedError(decision, await billingStanding(ctx));
  }
  return decision;
}

/**
 * ⭐ THE STANDING THAT SHAPES THE REFUSAL — Batch 0109.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONLY ON THE REFUSAL PATH, AND ONLY BEHIND A `catch`
 * ══════════════════════════════════════════════════════════════════════
 * Two properties matter here and both are easy to lose:
 *
 *   • It costs nothing on the ordinary path. `requireFeature` returns
 *     before reaching this line whenever the answer is yes, which is
 *     almost every call. And on the path that DOES reach it,
 *     `getAccessDecision` is wrapped in React `cache()` — a write site
 *     calls `requireAccess()` first (see `guardSalesWrite`), so the
 *     query has already been made and this is a map lookup.
 *
 *   • 🔴 IT CANNOT TURN A PAYWALL INTO A 500. `getAccessDecision` already
 *     fails open on its own errors, but it still needs a tenant context
 *     and there are call sites — a background worker, a route that
 *     resolved the tenant some other way — where that could throw. A
 *     refusal that fails while explaining itself would replace a clear
 *     "your plan does not include this" with an error page, which is the
 *     worse of the two outcomes by a distance. So the standing is
 *     OPTIONAL and its absence costs one clause of one sentence.
 */
async function billingStanding(
  ctx?: TenantContext,
): Promise<BillingStanding | null> {
  try {
    const { getAccessDecision } = await import("@/server/billing/access");
    const decision = await getAccessDecision(ctx);
    return { level: decision.level, daysRemaining: decision.daysRemaining };
  } catch {
    return null;
  }
}

/**
 * Check several features in one pass.
 *
 * Navigation needs a dozen answers to render one menu. Twelve separate
 * `checkFeature` calls would each hit `getEntitlementContext` — which
 * `cache()` deduplicates within a request, so it is one query either way,
 * but this returns a shape the renderer can index directly.
 */
export async function checkFeatures<K extends FeatureKey>(
  features: readonly K[],
  ctx?: TenantContext,
): Promise<Record<K, boolean>> {
  const entitlements = await getEntitlementContext(ctx);
  const result = {} as Record<K, boolean>;
  for (const feature of features) {
    result[feature] = evaluateFeature(feature, {
      planTier: entitlements.effectiveTier,
      subscriptionGrantsAccess: entitlements.subscriptionGrantsAccess,
      overrides: entitlements.overrides,
    }).allowed;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* SUMMARY FOR THE CLIENT                                              */
/* ------------------------------------------------------------------ */

export type EntitlementSummary = {
  effectiveTier: PlanTier;
  planTier: PlanTier;
  subscriptionStatus: string | null;
  subscriptionGrantsAccess: boolean;
  /** Every feature the workspace currently has. */
  enabled: FeatureKey[];
  /** Everything it does not, with the tier that would unlock each. */
  locked: { feature: FeatureKey; label: string; requiredTier: PlanTier }[];
};

/**
 * A serialisable snapshot for client components.
 *
 * ⚠️ THIS IS A RENDERING HINT, NEVER A SECURITY BOUNDARY. Anything sent
 * to the browser can be edited in the browser. Every write path calls
 * `requireFeature()` on the server regardless of what the client believed
 * — the client copy exists so a locked panel renders as locked on the
 * first paint instead of flashing and then disappearing.
 */
export async function getEntitlementSummary(
  ctx?: TenantContext,
): Promise<EntitlementSummary> {
  const entitlements = await getEntitlementContext(ctx);

  const enabled = entitlements.subscriptionGrantsAccess
    ? featuresForTier(entitlements.effectiveTier)
    : featuresForTier(entitlements.effectiveTier);

  const enabledSet = new Set(enabled);

  const locked = (Object.keys(FEATURE_CATALOG) as FeatureKey[])
    .filter((key) => !enabledSet.has(key))
    .map((key) => ({
      feature: key,
      label: FEATURE_CATALOG[key].label,
      requiredTier: FEATURE_CATALOG[key].minTier,
    }));

  return {
    effectiveTier: entitlements.effectiveTier,
    planTier: entitlements.planTier,
    subscriptionStatus: entitlements.subscriptionStatus,
    subscriptionGrantsAccess: entitlements.subscriptionGrantsAccess,
    enabled,
    locked,
  };
}

/* ------------------------------------------------------------------ */
/* COMBINED GATE                                                       */
/* ------------------------------------------------------------------ */

/**
 * Both gates, in the correct order, in one call.
 *
 * Most write paths need exactly this: "is the feature in the plan, and is
 * this person allowed to use it?" Providing it as one function means the
 * ORDER cannot be got wrong at a call site — which is the whole point,
 * given that the order is invisible in its effects until a customer
 * receives the wrong message.
 *
 * Imported lazily to avoid a cycle: `server/audit.ts` imports the tenant
 * context, which this module also uses.
 */
export async function requireFeatureAndPermission(
  feature: FeatureKey,
  permission: PermissionKey,
): Promise<TenantContext> {
  const ctx = await requireTenantContext();

  // Entitlement FIRST. See the note on requireFeature().
  await requireFeature(feature, ctx);

  const { requirePermission } = await import("@/server/audit");
  return requirePermission(permission);
}

/* ------------------------------------------------------------------ */
/* ⭐ THE NON-BROWSER PATH — Batch 0109                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ ENTITLEMENT FOR A CALLER THAT HAS NO CLERK SESSION.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE HOLE THIS CLOSES, AND IT IS THE SAME ONE `access.ts` CLOSED
 * ══════════════════════════════════════════════════════════════════════
 * Everything above resolves the tenant through `requireTenantContext()`,
 * which reads a Clerk session. The MCP surface has none: it authenticates
 * a BEARER TOKEN and carries only `session.tenantId`.
 *
 * `server/billing/access.ts` hit exactly this and grew
 * `getAccessDecisionForTenant` for it, with the note that without it "an
 * AI agent holding a read_write token could keep writing to a past_due
 * workspace". The entitlement gate had the identical gap and nobody had
 * written the second half: an MCP client could reach the whole tool
 * surface on a plan that includes no AI at all, because the only gate
 * that could have said otherwise needed a cookie.
 *
 * ⚠️ NOT WRAPPED IN React `cache()`, and deliberately. `cache()`
 * deduplicates within one React render pass, which an MCP request is not
 * — the memo would either never hit or, worse, be shared across requests
 * if the runtime ever changed shape. One indexed query per tool call is
 * the honest cost.
 *
 * ⚠️ FAILS CLOSED, unlike its neighbour in `access.ts`, and the asymmetry
 * is deliberate. That gate can refuse EVERYTHING, so a billing outage
 * failing it closed would take a customer's whole workspace away. This
 * one refuses ONE capability, so the blast radius of failing closed is a
 * feature being unavailable for the length of an outage — against the
 * alternative, which is handing out a paid module whenever a query is
 * slow. Same reasoning as `evaluateFeature`'s unknown-key branch.
 */
export async function checkFeatureForTenant(
  tenantId: string,
  feature: FeatureKey,
): Promise<EntitlementDecision> {
  const [row, flagRows] = await withTenant(tenantId, (tx) =>
    Promise.all([
      tx
        .select({ status: subscriptions.status, tier: plans.tier })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
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
            eq(platformTenantFlags.tenantId, tenantId),
            sql`${platformTenantFlags.flagKey} LIKE ${ENTITLEMENT_OVERRIDE_PREFIX + "%"}`,
            sql`(${platformTenantFlags.expiresAt} IS NULL OR ${platformTenantFlags.expiresAt} > now())`,
          ),
        ),
    ]),
  );

  const overrides: Record<string, boolean> = {};
  for (const flag of flagRows) {
    overrides[flag.flagKey.slice(ENTITLEMENT_OVERRIDE_PREFIX.length)] = flag.enabled;
  }

  /**
   * ⚠️ NO SUBSCRIPTION ROW MEANS NO ANSWER, AND NO ANSWER MEANS NO.
   *
   * The browser path falls back to `tenants.plan_tier` here, because a
   * workspace mid-signup has a real person in front of it who would
   * otherwise see a broken product. A token-authenticated agent is not
   * mid-signup: an MCP grant is issued from inside a workspace that
   * already exists. Reading the denormalised cache on this path would
   * mean a stale column decides what an automated caller may reach.
   */
  const planTier = row?.tier ?? "trial";
  const subscriptionGrantsAccess = row ? grantsAccess(row.status) : false;

  return evaluateFeature(feature, {
    planTier,
    subscriptionGrantsAccess,
    overrides,
  });
}

/**
 * ⚠️ THERE IS NO `requireFeatureForTenant`, AND ITS ABSENCE IS A DECISION.
 *
 * One was written for this batch and deleted before it shipped, because
 * nothing called it. `server/mcp/dispatch.ts` uses the non-throwing form:
 * every refusal on that surface has to come back as a JSON-RPC result
 * carrying a sentence the agent can relay, not as an exception the
 * dispatcher would have to catch and unwrap one line later.
 *
 * A throwing variant is four lines whenever a caller genuinely needs one.
 * Shipping it now would have been a helper declared and called by
 * nothing, which is the shape this batch exists to remove.
 */
