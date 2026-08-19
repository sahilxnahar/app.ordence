/**
 * Ordence — Payment Reconciliation
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE PLACE WHERE A PROVIDER EVENT CHANGES OUR STATE
 * ══════════════════════════════════════════════════════════════════════
 * Adapters translate. This applies. Nothing else in the codebase mutates
 * a subscription in response to a webhook, because idempotency that is
 * implemented in two places is idempotency that holds in one of them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FOUR THINGS THAT GO WRONG WITH WEBHOOKS, AND THE DEFENCE FOR EACH
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. DUPLICATE DELIVERY. Both providers retry on any non-2xx, and both
 *    occasionally redeliver a successful one. Without a guard, a retried
 *    `payment_succeeded` extends the billing period twice.
 *    → DEFENCE: a UNIQUE index on `payment_events(provider,
 *      provider_event_id)`. The insert of the event row happens FIRST, in
 *      the same transaction as the effect. A duplicate raises 23505, the
 *      transaction rolls back, nothing is applied, and we return 200.
 *      Enforced by the DATABASE, so two concurrent Vercel invocations
 *      racing on the same retry cannot both succeed.
 *
 * 2. OUT-OF-ORDER DELIVERY. Retries mean an OLD event can arrive AFTER a
 *    newer one. A `payment_failed` from 10:00, retried at 10:05, must not
 *    undo a `payment_succeeded` from 10:02.
 *    → DEFENCE: `subscriptions.last_provider_event_at`. An event whose
 *      `occurredAt` is older than that is recorded but not applied.
 *
 * 3. UNRESOLVABLE TENANT. Test-mode traffic, an object created in the
 *    provider's dashboard by hand, a customer from a previous system.
 *    → DEFENCE: recorded with `ignored_unknown_tenant` and acknowledged.
 *      Never dropped — an event you cannot explain is the one you will
 *      want to read later — and never retried, because it never will
 *      resolve.
 *
 * 4. PARTIAL APPLICATION. The event row is written, then the process dies
 *    before the subscription is updated. The unique index now blocks the
 *    retry, so the update is lost forever — silently.
 *    → DEFENCE: event insert and state change share ONE transaction.
 *      Either both land or neither does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS RUNS UNDER `withPlatformScope` AND NOT `withTenant`
 * ══════════════════════════════════════════════════════════════════════
 * A webhook arrives with no session and no tenant — resolving the tenant
 * IS the work. `withTenant` cannot be entered before the answer is known.
 *
 * The mitigation is that the platform-scoped section is as small as it
 * can be: it resolves an id and nothing else. Every subsequent read and
 * write happens inside `withTenant(resolvedTenantId, ...)`, so RLS is in
 * force for all of it. The lookup is by a provider-issued opaque id or by
 * a tenant uuid we ourselves put into provider metadata — neither is
 * attacker-chosen, because the payload carrying them was HMAC-verified
 * before this function was called.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db, withTenant, withPlatformScope } from "@/db";
import {
  subscriptions,
  paymentEvents,
  invoices,
  tenants,
  plans,
  grantsAccess,
  type PaymentEventStatus,
  type SubscriptionStatus,
} from "@/db/schema";
import type { NormalizedEvent } from "@/lib/billing/providers/types";
import {
  buildSubscriptionPatch,
  shouldApply,
  type SubscriptionPatch,
} from "@/lib/billing/state-machine";
import { recordSystemAudit } from "@/server/billing/audit-billing";

/* ------------------------------------------------------------------ */
/* RESULT                                                              */
/* ------------------------------------------------------------------ */

export type ReconcileOutcome = {
  /**
   * Whether to return 2xx to the provider.
   *
   * TRUE for almost everything, including events we deliberately ignored
   * — acknowledging is how you tell a provider "received, stop retrying".
   * FALSE only for a genuine transient failure on our side, where a retry
   * could plausibly succeed.
   */
  acknowledge: boolean;
  status: PaymentEventStatus;
  /** Safe to log. Never returned in an HTTP response body. */
  detail: string;
  tenantId: string | null;
  subscriptionId: string | null;
};

/* ------------------------------------------------------------------ */
/* ENTRY POINT                                                         */
/* ------------------------------------------------------------------ */

export async function reconcileEvent(event: NormalizedEvent): Promise<ReconcileOutcome> {
  /* ---------- Step 1: resolve the tenant ------------------------- */

  let tenantId: string | null = null;
  let subscriptionId: string | null = null;

  try {
    const resolved = await resolveTenant(event);
    tenantId = resolved.tenantId;
    subscriptionId = resolved.subscriptionId;
  } catch (error) {
    // A lookup failure is infrastructure, not data. This is the one case
    // where a retry genuinely helps, so do NOT acknowledge.
    return {
      acknowledge: false,
      status: "failed",
      detail: `Tenant resolution failed: ${errorMessage(error)}`,
      tenantId: null,
      subscriptionId: null,
    };
  }

  /* ---------- Step 2: unresolvable tenant ------------------------ */

  if (!tenantId) {
    // Recorded with a null tenant so the event is not lost. This insert
    // is outside withTenant because there is no tenant to scope to; the
    // RLS policy on `payment_events` permits a NULL tenant row for
    // exactly this case (see 0009_phase11_billing.sql).
    const recorded = await recordOrphanEvent(event);
    return {
      acknowledge: true,
      status: recorded,
      detail:
        `No tenant maps to ${event.provider} subscription ` +
        `"${event.providerSubscriptionId ?? "-"}" / customer ` +
        `"${event.providerCustomerId ?? "-"}". Recorded and ignored.`,
      tenantId: null,
      subscriptionId: null,
    };
  }

  /* ---------- Step 3: apply, inside the tenant boundary ---------- */

  try {
    return await withTenant(tenantId, async (tx) => {
      /**
       * ⭐ THE EVENT ROW IS INSERTED FIRST, IN THIS TRANSACTION.
       *
       * If this is a duplicate, the unique index raises 23505 here,
       * before any state has been touched, and the whole transaction —
       * including every update below — is rolled back. That single index
       * is the entire replay defence, and it is why the insert cannot be
       * moved after the effect "for cleanliness".
       */
      const eventStatus: PaymentEventStatus =
        event.eventType === "unmapped" ? "ignored_duplicate" : "processed";

      await tx.insert(paymentEvents).values({
        tenantId,
        subscriptionId,
        provider: event.provider,
        providerEventId: event.providerEventId,
        providerEventName: event.providerEventName,
        eventType: event.eventType,
        status: event.eventType === "unmapped" ? "received" : eventStatus,
        amountMinor: event.amountMinor ?? null,
        currency: event.currency ?? null,
        providerPaymentId: event.providerPaymentId ?? null,
        occurredAt: event.occurredAt ?? null,
        payload: event.payload,
      });

      // An event we do not act on still gets its evidence row above.
      if (event.eventType === "unmapped") {
        return {
          acknowledge: true,
          status: "received" as PaymentEventStatus,
          detail: `Unmapped provider event "${event.providerEventName}" recorded, not applied.`,
          tenantId,
          subscriptionId,
        };
      }

      if (!subscriptionId) {
        return {
          acknowledge: true,
          status: "processed" as PaymentEventStatus,
          detail:
            `Event recorded against tenant ${tenantId} but no subscription ` +
            `could be matched, so no state was changed.`,
          tenantId,
          subscriptionId: null,
        };
      }

      /* ---- The ordering guard --------------------------------- */

      const [current] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .limit(1);

      if (!current) {
        return {
          acknowledge: true,
          status: "processed" as PaymentEventStatus,
          detail: "Subscription vanished between resolution and update.",
          tenantId,
          subscriptionId,
        };
      }

      if (!shouldApply(event.occurredAt, current.lastProviderEventAt)) {
        return {
          acknowledge: true,
          status: "processed" as PaymentEventStatus,
          detail:
            `Stale event: occurred ${event.occurredAt?.toISOString() ?? "unknown"}, ` +
            `subscription already at ` +
            `${current.lastProviderEventAt?.toISOString() ?? "unknown"}. ` +
            `Recorded, not applied.`,
          tenantId,
          subscriptionId,
        };
      }

      /* ---- Apply ---------------------------------------------- */

      const patch = buildSubscriptionPatch(event, current);

      if (Object.keys(patch).length > 0) {
        await tx
          .update(subscriptions)
          .set({
            ...patch,
            lastProviderEventAt: event.occurredAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, subscriptionId));
      }

      /**
       * Keep `tenants.plan_tier` in step.
       *
       * That column is a DENORMALISED CACHE of the subscription's plan
       * tier. It exists because middleware and the entitlement engine
       * read the tier on every request, and joining subscriptions →
       * plans on every request would be a needless round trip. The cost
       * of denormalising is this update, which must not be forgotten —
       * a stale `plan_tier` means a customer who paid for Advanced is
       * still gated at Basic, and they will notice within minutes.
       */
      const nextStatus = (patch.status as SubscriptionStatus | undefined) ?? current.status;
      await syncTenantPlanTier(tx, tenantId, current.planId, nextStatus);

      await recordSystemAudit(tx, {
        tenantId,
        action: "config_change",
        resourceType: "subscription",
        resourceId: subscriptionId,
        severity: event.eventType === "payment_failed" ? "warning" : "info",
        metadata: {
          provider: event.provider,
          providerEventName: event.providerEventName,
          eventType: event.eventType,
          previousStatus: current.status,
          newStatus: nextStatus,
          amountMinor: event.amountMinor?.toString() ?? null,
        },
        reason: `Provider webhook: ${event.providerEventName}`,
      });

      return {
        acknowledge: true,
        status: "processed" as PaymentEventStatus,
        detail: `Applied ${event.eventType} to subscription ${subscriptionId}.`,
        tenantId,
        subscriptionId,
      };
    });
  } catch (error) {
    /**
     * A unique-violation here means a duplicate delivery, which is a
     * SUCCESS from the provider's point of view: the event was already
     * processed. Acknowledge so they stop retrying.
     *
     * Anything else is a real failure — do not acknowledge, let them
     * retry.
     */
    if (isUniqueViolation(error)) {
      return {
        acknowledge: true,
        status: "ignored_duplicate",
        detail: `Duplicate delivery of ${event.provider} event ${event.providerEventId}.`,
        tenantId,
        subscriptionId,
      };
    }

    return {
      acknowledge: false,
      status: "failed",
      detail: `Reconciliation failed: ${errorMessage(error)}`,
      tenantId,
      subscriptionId,
    };
  }
}

/* ------------------------------------------------------------------ */
/* TENANT RESOLUTION                                                   */
/* ------------------------------------------------------------------ */

/**
 * Map a provider event to one of our tenants.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE METADATA HINT IS CHECKED FIRST — AND WHY IT IS STILL VERIFIED
 * ══════════════════════════════════════════════════════════════════════
 * `tenantIdHint` comes from metadata WE set when creating the
 * subscription, echoed back by the provider. It is the most direct path.
 *
 * It is still not trusted on its own. The hint is used to LOOK UP a
 * tenant, and the lookup only succeeds if such a tenant exists and is not
 * deleted. If the event also carries a provider subscription id, the two
 * must agree — a mismatch means either a provider bug or a payload that
 * somehow reached us with the wrong metadata, and in both cases the right
 * answer is to trust the provider id (which we never wrote) over the
 * metadata (which is a string field anyone with dashboard access could
 * edit).
 *
 * That last point is the reason for the ordering check below. A hostile
 * or careless actor with access to the payment provider's dashboard could
 * set `notes.tenant_id` on their own subscription to another tenant's
 * uuid. If the hint won unconditionally, their payment events would be
 * applied to that tenant's subscription. Preferring the provider
 * subscription id — which is bound to a row by a unique index we control
 * — closes that.
 */
async function resolveTenant(
  event: NormalizedEvent,
): Promise<{ tenantId: string | null; subscriptionId: string | null }> {
  return withPlatformScope(
    "Webhook arrives without a session; resolving which tenant a provider event belongs to.",
    async (database) => {
      /* --- Path 1 (authoritative): provider subscription id ------ */
      if (event.providerSubscriptionId) {
        const [row] = await database
          .select({ id: subscriptions.id, tenantId: subscriptions.tenantId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.provider, event.provider),
              eq(subscriptions.providerSubscriptionId, event.providerSubscriptionId),
            ),
          )
          .limit(1);

        if (row) return { tenantId: row.tenantId, subscriptionId: row.id };
      }

      /* --- Path 2: provider customer id -------------------------- */
      if (event.providerCustomerId) {
        const [row] = await database
          .select({ id: subscriptions.id, tenantId: subscriptions.tenantId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.provider, event.provider),
              eq(subscriptions.providerCustomerId, event.providerCustomerId),
            ),
          )
          .orderBy(sql`${subscriptions.createdAt} DESC`)
          .limit(1);

        if (row) return { tenantId: row.tenantId, subscriptionId: row.id };
      }

      /* --- Path 3 (weakest): our own metadata hint ---------------- */
      //
      // Reached only when neither provider id matches a row — which is
      // the normal case for the very FIRST event of a new subscription,
      // arriving before our checkout callback has stored the provider id.
      // The hint is validated against a real, live tenant row before use.
      if (event.tenantIdHint && isUuid(event.tenantIdHint)) {
        const [tenant] = await database
          .select({ id: tenants.id })
          .from(tenants)
          .where(and(eq(tenants.id, event.tenantIdHint), sql`${tenants.deletedAt} IS NULL`))
          .limit(1);

        if (tenant) {
          // Attach to the tenant's live subscription if it has one.
          const [row] = await database
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.tenantId, tenant.id),
                sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
                sql`${subscriptions.deletedAt} IS NULL`,
              ),
            )
            .limit(1);

          return { tenantId: tenant.id, subscriptionId: row?.id ?? null };
        }
      }

      return { tenantId: null, subscriptionId: null };
    },
  );
}

/* ------------------------------------------------------------------ */
/* DENORMALISED TIER CACHE                                             */
/* ------------------------------------------------------------------ */

/**
 * Push the effective tier back onto `tenants.plan_tier`.
 *
 * When the subscription no longer grants access the tenant drops to
 * `trial` rather than to their paid tier — so a lapsed customer keeps a
 * usable, limited product rather than a broken one. Phase 14 turns that
 * into a paywall; Phase 12's gate reads it directly.
 */
async function syncTenantPlanTier(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  planId: string,
  status: SubscriptionStatus,
): Promise<void> {
  const [plan] = await tx
    .select({ tier: plans.tier })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);

  if (!plan) return;

  const effectiveTier = grantsAccess(status) ? plan.tier : "trial";

  await tx
    .update(tenants)
    .set({ planTier: effectiveTier, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
}

/* ------------------------------------------------------------------ */
/* ORPHAN EVENTS                                                       */
/* ------------------------------------------------------------------ */

/**
 * Record an event we cannot attribute to a tenant.
 *
 * Runs on the platform-scoped client because there is no tenant to pin.
 * A duplicate orphan is swallowed — the same unknown event redelivered is
 * still an event we do not act on, and returning a failure would make the
 * provider retry it forever.
 */
async function recordOrphanEvent(event: NormalizedEvent): Promise<PaymentEventStatus> {
  try {
    await withPlatformScope(
      "Recording a provider webhook that maps to no known tenant, so it is not lost.",
      async (database) => {
        await database.insert(paymentEvents).values({
          tenantId: null,
          subscriptionId: null,
          provider: event.provider,
          providerEventId: event.providerEventId,
          providerEventName: event.providerEventName,
          eventType: event.eventType,
          status: "ignored_unknown_tenant",
          amountMinor: event.amountMinor ?? null,
          currency: event.currency ?? null,
          providerPaymentId: event.providerPaymentId ?? null,
          occurredAt: event.occurredAt ?? null,
          payload: event.payload,
        });
      },
    );
    return "ignored_unknown_tenant";
  } catch (error) {
    if (isUniqueViolation(error)) return "ignored_duplicate";
    // Even a failure to RECORD is acknowledged: the event is unactionable
    // either way, and a retry storm helps nobody.
    return "failed";
  }
}

/* ------------------------------------------------------------------ */
/* UTILITIES                                                           */
/* ------------------------------------------------------------------ */

/**
 * PostgreSQL SQLSTATE 23505 = unique_violation.
 *
 * Matched on the CODE, not on the message text. Message matching would
 * break under a different locale setting on the server, and would also
 * match a message that merely mentioned a constraint name.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;

  // Drizzle and the Neon driver both wrap the driver error in `cause`.
  const cause = candidate.cause as { code?: unknown } | undefined;
  return cause?.code === "23505";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The pure state machine lives in `lib/billing/state-machine.ts` and is
 * tested directly there. Nothing in this file needs a test hatch: what
 * remains is transaction handling and tenant resolution, both of which
 * are exercised against a real PostgreSQL in
 * tests/security/billing-isolation.test.ts.
 */
