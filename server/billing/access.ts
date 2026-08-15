import "server-only";

/**
 * Ordence — Server-Side Access Gate
 * Version: v0.14.0-alpha
 *
 * The enforcement half of `lib/billing/access-state.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THREE GATES NOW EXIST, AND THEY ANSWER DIFFERENT QUESTIONS
 * ══════════════════════════════════════════════════════════════════════
 *   PERMISSION    (Phase 5)  — "may this PERSON do it?"      → ask your admin
 *   ENTITLEMENT   (Phase 12) — "is it in the PLAN?"          → upgrade
 *   SEATS         (Phase 13) — "is there room for another?"  → buy or free a seat
 *   ACCESS        (this)     — "is the account in good standing?" → pay
 *
 * Four denials, four remedies. Collapsing any two guarantees that
 * somebody is eventually told to solve the wrong problem — and the worst
 * version of that is telling a workspace owner whose card expired that
 * they "lack permission", which sends them to an administrator who is
 * themselves.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS GATE IS THE MOST DANGEROUS OF THE FOUR
 * ══════════════════════════════════════════════════════════════════════
 * The other three refuse a specific capability. This one can refuse
 * EVERYTHING. A bug here does not break a feature — it takes a paying
 * customer's whole workspace away, and they will not wait patiently for a
 * fix.
 *
 * So it is written to fail OPEN on its own errors. If the subscription
 * lookup throws, the answer is "full access", not "restricted". An
 * outage in our billing tables must never become an outage in our
 * customers' businesses. The revenue risk of a few hours of unbilled
 * access is trivially smaller than the alternative.
 */

import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { subscriptions, plans } from "@/db/schema";
import { requireTenantContext, type TenantContext } from "@/server/tenant-context";
import {
  evaluateAccess,
  isExemptWrite,
  type AccessDecision,
} from "@/lib/billing/access-state";

/* ------------------------------------------------------------------ */
/* ERROR                                                               */
/* ------------------------------------------------------------------ */

export class AccessRestrictedError extends Error {
  constructor(readonly decision: AccessDecision) {
    super(decision.detail ?? decision.headline ?? "This workspace is read-only.");
    this.name = "AccessRestrictedError";
  }
}

/* ------------------------------------------------------------------ */
/* RESOLUTION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Work out the workspace's standing.
 *
 * `cache()` deduplicates within a single request — a page with a banner
 * and six gated panels does one query, not seven. Deliberately not a TTL
 * cache: a customer who has just paid must not sit behind a paywall for
 * however long the TTL is, and that is the most expensive moment in the
 * product to look broken.
 */
export const getAccessDecision = cache(async function getAccessDecision(
  ctx?: TenantContext,
): Promise<AccessDecision> {
  const tenantContext = ctx ?? (await requireTenantContext());
  const now = new Date();

  try {
    const [row] = await withTenant(tenantContext.tenant.id, (tx) =>
      tx
        .select({
          status: subscriptions.status,
          trialEndsAt: subscriptions.trialEndsAt,
          graceEndsAt: subscriptions.graceEndsAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          failedPaymentCount: subscriptions.failedPaymentCount,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          tier: plans.tier,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, tenantContext.tenant.id),
            sql`${subscriptions.deletedAt} IS NULL`,
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused','cancelled')`,
          ),
        )
        .limit(1)
    );

    return evaluateAccess({
      subscriptionStatus: row?.status ?? null,
      planTier: row?.tier ?? tenantContext.tenant.planTier,
      tenantStatus: tenantContext.tenant.status,
      trialEndsAt: row?.trialEndsAt ?? tenantContext.tenant.trialEndsAt ?? null,
      graceEndsAt: row?.graceEndsAt ?? null,
      currentPeriodEnd: row?.currentPeriodEnd ?? null,
      failedPaymentCount: row?.failedPaymentCount ?? 0,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
      now,
    });
  } catch (error) {
    /**
     * ⚠️ FAIL OPEN. THIS IS DELIBERATE AND IT IS THE RIGHT DIRECTION.
     *
     * Every other gate in this system fails CLOSED, because the cost of
     * wrongly granting is a leak. Here the cost of wrongly DENYING is
     * that every paying customer loses their workspace because one query
     * failed — a self-inflicted outage with a far larger blast radius
     * than a few hours of unbilled access.
     *
     * The administrative suspension check is the one thing that still
     * applies, because that is a safety control rather than a
     * commercial one and it is decided from the tenant row we already
     * hold, not from the query that just failed.
     */
    console.error(
      "[billing:access] Could not resolve subscription standing; failing OPEN.",
      error instanceof Error ? error.message : "unknown",
    );

    return evaluateAccess({
      subscriptionStatus: null,
      planTier: tenantContext.tenant.planTier,
      tenantStatus: tenantContext.tenant.status,
      trialEndsAt: null,
      graceEndsAt: null,
      currentPeriodEnd: null,
      failedPaymentCount: 0,
      cancelAtPeriodEnd: false,
      now,
    });
  }
});

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

/**
 * Refuse a write when the workspace is restricted.
 *
 * `operation` is a namespaced string such as `"contacts:create"`.
 * Anything matching an exempt prefix — billing, payment, export, session,
 * support — is always permitted, because a read-only mode that blocks
 * the payment form is a trap the customer cannot get out of without
 * contacting support.
 *
 * ⚠️ CALL ORDER at a write site:
 *     requireAccess()      ← is the account in good standing?
 *     requireFeature()     ← is it in the plan?
 *     requirePermission()  ← may this person do it?
 *
 * Broadest first, so the message the customer receives describes the
 * outermost reason rather than an inner one they cannot act on.
 */
export async function requireAccess(
  operation: string,
  ctx?: TenantContext,
): Promise<AccessDecision> {
  const decision = await getAccessDecision(ctx);

  if (decision.canWrite) return decision;
  if (isExemptWrite(operation)) return decision;

  throw new AccessRestrictedError(decision);
}

/** Non-throwing variant, for rendering. */
export async function checkAccess(ctx?: TenantContext): Promise<AccessDecision> {
  return getAccessDecision(ctx);
}

/* ------------------------------------------------------------------ */
/* THE NON-BROWSER PATH — S1, v0.83.2                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ BILLING STANDING FOR A CALLER THAT HAS NO CLERK SESSION.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS SEPARATELY FROM `getAccessDecision()`
 * ══════════════════════════════════════════════════════════════════════
 * Everything above resolves the tenant from `requireTenantContext()`,
 * which reads a Clerk session. The MCP surface has no Clerk session — it
 * authenticates a BEARER TOKEN and carries only `session.tenantId`.
 *
 * That mismatch left a real hole. `server/mcp/dispatch.ts` checks that the
 * token exists, that its scope permits the tool, and that RLS pins the
 * tenant — but nothing anywhere asked whether the workspace was still
 * PAYING. So an AI agent holding a `read_write` token could keep writing
 * to a `past_due` workspace that the same company's staff had just been
 * put into read-only mode. The rule has to be the same for both, or the
 * read-only state is decoration.
 *
 * ⚠️ FAILS OPEN, exactly like `getAccessDecision()` and for the same
 * reason stated at the top of this file: a billing-table outage must not
 * become an outage in our customers' businesses. The revenue risk of a
 * few hours of unbilled agent activity is far smaller than an agent
 * pipeline stopping because one query timed out.
 *
 * ⚠️ NOT WRAPPED IN React `cache()`. That deduplicates within a single
 * React render pass, which an MCP request is not.
 */
export async function getAccessDecisionForTenant(
  tenantId: string,
): Promise<AccessDecision> {
  const now = new Date();

  try {
    const { withTenant } = await import("@/db");
    const { tenants } = await import("@/db/schema");

    /*
     * ⚠️ INSIDE `withTenant()`. A plain `db` read here would carry no
     * tenant context, every RLS policy would evaluate against NULL, and
     * the query would return zero rows — which would silently look like
     * "no subscription" and grant full access to everyone. That is the
     * same failure documented on `withPlatformScope()` in `db/index.ts`.
     */
    const row = await withTenant(tenantId, async (tx) => {
      const [tenant] = await tx
        .select({
          status: tenants.status,
          planTier: tenants.planTier,
          trialEndsAt: tenants.trialEndsAt,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const [sub] = await tx
        .select({
          status: subscriptions.status,
          trialEndsAt: subscriptions.trialEndsAt,
          graceEndsAt: subscriptions.graceEndsAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          failedPaymentCount: subscriptions.failedPaymentCount,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          tier: plans.tier,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
            sql`${subscriptions.deletedAt} IS NULL`,
            sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused','cancelled')`,
          ),
        )
        .limit(1);

      return { tenant, sub };
    });

    return evaluateAccess({
      subscriptionStatus: row.sub?.status ?? null,
      planTier: row.sub?.tier ?? row.tenant?.planTier ?? "trial",
      tenantStatus: row.tenant?.status ?? "active",
      trialEndsAt: row.sub?.trialEndsAt ?? row.tenant?.trialEndsAt ?? null,
      graceEndsAt: row.sub?.graceEndsAt ?? null,
      currentPeriodEnd: row.sub?.currentPeriodEnd ?? null,
      failedPaymentCount: row.sub?.failedPaymentCount ?? 0,
      cancelAtPeriodEnd: row.sub?.cancelAtPeriodEnd ?? false,
      now,
    });
  } catch (error) {
    console.error(
      "[billing:access] Could not resolve standing for tenant; failing OPEN.",
      error instanceof Error ? error.message : "unknown",
    );
    return evaluateAccess({
      subscriptionStatus: null,
      planTier: "trial",
      tenantStatus: "active",
      trialEndsAt: null,
      graceEndsAt: null,
      currentPeriodEnd: null,
      failedPaymentCount: 0,
      cancelAtPeriodEnd: false,
      now,
    });
  }
}

/**
 * Throwing variant for the MCP surface.
 *
 * `operation` follows the same `namespace:verb` convention the browser
 * path uses, so the exempt prefixes in `ALWAYS_PERMITTED_WRITE_PREFIXES`
 * (billing, payment, export, session, support) behave identically.
 */
export async function requireAccessForTenant(
  tenantId: string,
  operation: string,
): Promise<AccessDecision> {
  const decision = await getAccessDecisionForTenant(tenantId);

  if (decision.canWrite) return decision;
  if (isExemptWrite(operation)) return decision;

  throw new AccessRestrictedError(decision);
}

/**
 * Everything a banner needs, serialisable for a client component.
 *
 * ⚠️ A RENDERING HINT, NEVER A BOUNDARY. Anything sent to a browser can
 * be edited in a browser; every write path calls `requireAccess()` on the
 * server regardless of what the client believed.
 */
export type AccessBannerData = {
  level: AccessDecision["level"];
  headline: string | null;
  detail: string | null;
  callToAction: AccessDecision["callToAction"];
  daysRemaining: number | null;
  /** `notice` may be dismissed for the session; nothing above it may. */
  dismissible: boolean;
};

export async function getAccessBanner(
  ctx?: TenantContext,
): Promise<AccessBannerData | null> {
  const decision = await getAccessDecision(ctx);
  if (!decision.headline) return null;

  return {
    level: decision.level,
    headline: decision.headline,
    detail: decision.detail,
    callToAction: decision.callToAction,
    daysRemaining: decision.daysRemaining,
    // Only the gentlest rung is dismissible. A warning that can be
    // dismissed is a warning nobody sees on the day it matters.
    dismissible: decision.level === "notice",
  };
}
