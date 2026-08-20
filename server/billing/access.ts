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
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 IT USED TO FAIL **OPEN**. WAVE 15 REVERSED THAT. READ WHY.
 * ══════════════════════════════════════════════════════════════════════
 * Until v1.82.0 this file's header argued, at length and in good faith,
 * that a subscription lookup which throws should answer "full access".
 * The argument was: an outage in our billing tables must not become an
 * outage in our customers' businesses, and a few hours of unbilled
 * access is cheaper than a self-inflicted lockout.
 *
 * ⚠️ THE ARGUMENT WAS RIGHT ABOUT THE COST AND WRONG ABOUT THE CHOICE,
 * because it compared "grant everything" against "refuse everything" and
 * those are not the only two options this file has.
 *
 * What it actually did, measured rather than assumed:
 *
 *   • `evaluateAccess({ subscriptionStatus: null, … })` returns `full`
 *     for a `trial` tenant row and for any tenant whose `plan_tier`
 *     column still reads like a paid tier. So a database blip did not
 *     merely preserve access — it promoted every workspace to whatever
 *     its stalest column said, with no subscription checked at all.
 *   • It was ALSO the state the tests ran in. `.env.test` says so in its
 *     own comments: without Clerk placeholders the billing tests "PASS
 *     THE WRONG WAY", because a permissive default is indistinguishable
 *     from a working gate.
 *   • And it left no record. One `console.error` into a log drain, no
 *     row, no count, no way afterwards to answer "for how long, and for
 *     how many tenants, was this gate not running?"
 *
 * ⭐ THE THIRD OPTION, WHICH IS WHAT THIS FILE DOES NOW: fail closed to
 * `restricted`, not to `locked`.
 *
 *   `restricted` means canWrite=false, **canRead=true, canExport=true**,
 *   and every exempt prefix — `billing:`, `payment:`, `export:`,
 *   `session:`, `support:` and the statutory ones (payroll, GST, TDS
 *   filings) — still passes through `requireAccess()` untouched.
 *
 * So during a billing-table outage a customer can still open their
 * workspace, read everything in it, run payroll, file a return, export
 * the lot and pay us. What they cannot do is create a new contact for a
 * few minutes. That is a materially different outage from the one the
 * old header was arguing against, and it is not the one it compared
 * itself to.
 *
 * ⚠️ ADMINISTRATIVE SUSPENSION IS STILL DECIDED FIRST AND SEPARATELY. It
 * comes from the tenant row already in hand, not from the query that
 * failed, so a workspace suspended for abuse stays `locked` rather than
 * being softened to `restricted` by an unrelated fault.
 *
 * ⚠️ THERE IS NO GRACE WINDOW AND NO LAST-KNOWN-GOOD CACHE, DELIBERATELY.
 * Both were written and both were deleted. A cache that answers from a
 * previous success is a path on which the failure produces `canWrite:
 * true` again — and a gate whose refusal can be suppressed by a cache
 * that is nearly always warm is a gate that never actually refuses in
 * production while passing every test that clears the cache first. That
 * is this repository's signature defect wearing a performance argument.
 *
 * ⚠️ AND THERE IS NO ENVIRONMENT KILL SWITCH. An `ORDENCE_BILLING_FAIL_OPEN`
 * flag was considered as an incident escape hatch and rejected for the
 * same reason: it would be set once during an incident and never unset,
 * and the file would then document a control it does not have.
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
import { recordSecurityEvidence } from "@/lib/security/evidence";

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
/* WHEN STANDING CANNOT BE RESOLVED                                     */
/* ------------------------------------------------------------------ */

/**
 * How a caller tells "we asked the database" from "we could not".
 *
 * ⚠️ THIS IS AN ADDITIVE FIELD ON A SHAPE OTHER CODE ALREADY CONSUMES.
 * `AccessDecision.reason` is a closed union in `lib/billing/access-state.ts`,
 * which Track D does not own, so there is no `standing_unresolved` member to
 * put there. Widening the union is the right long-term fix and is requested
 * in `PATCH-REQUEST-D.md`; until then the honest signal lives in its own
 * field rather than being smuggled into a `reason` that would then read
 * "no_subscription" for a workspace whose subscription was never looked at.
 */
export type StandingResolution = "resolved" | "unresolved";

export type GatedAccessDecision = AccessDecision & {
  readonly standing: StandingResolution;
};

/** Tag a decision that came from a query that actually answered. */
function resolved(decision: AccessDecision): GatedAccessDecision {
  return { ...decision, standing: "resolved" };
}

/**
 * ⭐ THE REFUSAL. Read-only, readable, exportable, payable.
 *
 * ⚠️ `canRead: true` AND `canExport: true` ARE THE LOAD-BEARING HALF. A
 * fail-closed billing gate that also hid the customer's data would be a
 * worse outage than the fail-open version it replaces, and it would be a
 * data-protection problem on top: under DPDP the right of access does not
 * lapse because our database had a bad minute.
 *
 * `level: "restricted"` is chosen so that `permitsWrites()`,
 * `permitsReads()` and every banner in the product treat this exactly as
 * they treat dunning restriction — one code path, already built, already
 * tested, rather than a sixth level nothing knows how to render.
 */
function unresolvedStanding(): GatedAccessDecision {
  return {
    level: "restricted",
    canWrite: false,
    canRead: true,
    canExport: true,
    headline: "We could not confirm this workspace's billing status",
    detail:
      "This is a fault on our side, not a problem with your account or your " +
      "payment. Everything here is still readable and exportable, and payroll, " +
      "GST and TDS filing still work. New changes are paused for a few minutes " +
      "while we re-check. Nothing has been lost.",
    callToAction: { label: "Check billing", href: "/settings/billing" },
    /*
     * ⚠️ `no_subscription` IS THE LEAST-WRONG MEMBER OF A UNION THAT HAS NO
     * RIGHT ANSWER, AND IT IS NOT WHAT CODE SHOULD BRANCH ON. Branch on
     * `standing === "unresolved"`. See `PATCH-REQUEST-D.md` item 3.
     */
    reason: "no_subscription",
    daysRemaining: null,
    standing: "unresolved",
  };
}

/**
 * Write the row that says the gate could not decide.
 *
 * ⚠️ AWAITED, NOT FIRE-AND-FORGET. A floating promise in a serverless
 * function is a promise that may be killed with the instance the moment the
 * response is sent — which would give exactly the empty table this whole
 * change exists to prevent. The cost is one insert on a path that is already
 * failing, and this path must be rare or we have a much larger problem.
 */
async function recordUnresolvedStanding(args: {
  readonly tenantId: string | null;
  readonly surface: string;
  readonly error: unknown;
}): Promise<void> {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error ?? "unknown");

  console.error(
    "[billing:access] Could not resolve subscription standing; failing CLOSED to read-only.",
    message,
  );

  await recordSecurityEvidence({
    type: "billing.standing_unresolved",
    severity: "warning",
    source: args.surface,
    tenantId: args.tenantId,
    subjectType: "tenant",
    subjectId: args.tenantId,
    reason:
      "Billing standing could not be resolved; the workspace was placed in " +
      "read-only rather than granted full access.",
    detail: { error: message.slice(0, 300) },
  });
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
): Promise<GatedAccessDecision> {
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

    return resolved(
      evaluateAccess({
        subscriptionStatus: row?.status ?? null,
        planTier: row?.tier ?? tenantContext.tenant.planTier,
        tenantStatus: tenantContext.tenant.status,
        trialEndsAt: row?.trialEndsAt ?? tenantContext.tenant.trialEndsAt ?? null,
        graceEndsAt: row?.graceEndsAt ?? null,
        currentPeriodEnd: row?.currentPeriodEnd ?? null,
        failedPaymentCount: row?.failedPaymentCount ?? 0,
        cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
        now,
      }),
    );
  } catch (error) {
    /**
     * ⭐ FAIL CLOSED — v1.82.0, Track D. The long argument is in the file
     * header; the short version is that this returns READ-ONLY, not locked,
     * and the exempt prefixes still pass.
     *
     * ⚠️ ADMINISTRATIVE SUSPENSION IS DECIDED FIRST AND FROM THE TENANT ROW
     * WE ALREADY HOLD, not from the query that just failed. A workspace
     * suspended for abuse must stay `locked`; softening it to `restricted`
     * because an unrelated query timed out would restore reads to an account
     * we deliberately took reads away from.
     */
    await recordUnresolvedStanding({
      tenantId: tenantContext.tenant.id,
      surface: "server/billing/access#getAccessDecision",
      error,
    });

    const administrative = evaluateAccess({
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
    if (administrative.level === "locked") return resolved(administrative);

    return unresolvedStanding();
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
): Promise<GatedAccessDecision> {
  const decision = await getAccessDecision(ctx);

  if (decision.canWrite) return decision;
  if (isExemptWrite(operation)) return decision;

  throw new AccessRestrictedError(decision);
}

/** Non-throwing variant, for rendering. */
export async function checkAccess(ctx?: TenantContext): Promise<GatedAccessDecision> {
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
 * ⭐ FAILS **CLOSED**, exactly like `getAccessDecision()` and for the same
 * reason stated at the top of this file. On this surface the reversal
 * matters more, not less: the browser path at least has a human watching
 * who would notice a paywall behaving oddly. An MCP agent holding a
 * `read_write` token has nobody watching, runs unattended, and under the
 * old behaviour would have kept writing to any workspace at all for as
 * long as the billing tables were unreachable.
 *
 * ⚠️ THERE IS NO TENANT ROW TO FALL BACK ON HERE. The browser path can
 * still honour administrative suspension from the context it already
 * holds; this path resolves the tenant row INSIDE the same failed
 * transaction, so when it fails there is nothing in hand. It therefore
 * refuses on every fault, including a malformed tenant id — which is a
 * caller bug, and answering "full access" to a caller who could not name a
 * valid tenant was never defensible.
 *
 * ⚠️ NOT WRAPPED IN React `cache()`. That deduplicates within a single
 * React render pass, which an MCP request is not.
 */
export async function getAccessDecisionForTenant(
  tenantId: string,
): Promise<GatedAccessDecision> {
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

    return resolved(
      evaluateAccess({
        subscriptionStatus: row.sub?.status ?? null,
        planTier: row.sub?.tier ?? row.tenant?.planTier ?? "trial",
        tenantStatus: row.tenant?.status ?? "active",
        trialEndsAt: row.sub?.trialEndsAt ?? row.tenant?.trialEndsAt ?? null,
        graceEndsAt: row.sub?.graceEndsAt ?? null,
        currentPeriodEnd: row.sub?.currentPeriodEnd ?? null,
        failedPaymentCount: row.sub?.failedPaymentCount ?? 0,
        cancelAtPeriodEnd: row.sub?.cancelAtPeriodEnd ?? false,
        now,
      }),
    );
  } catch (error) {
    await recordUnresolvedStanding({
      tenantId: isLikelyUuid(tenantId) ? tenantId : null,
      surface: "server/billing/access#getAccessDecisionForTenant",
      error,
    });
    return unresolvedStanding();
  }
}

/**
 * ⚠️ ONLY FOR DECIDING WHETHER A STRING IS SAFE TO STORE IN A `uuid` COLUMN.
 *
 * `security_events.tenant_id` is a real `uuid` with a foreign key. Passing
 * the caller's malformed string through would make the evidence insert fail
 * too — turning "the gate refused and said why" into "the gate refused
 * silently", which is the defect this change exists to remove. Never used
 * for an authorisation decision.
 */
function isLikelyUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
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
): Promise<GatedAccessDecision> {
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
