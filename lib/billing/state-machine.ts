/**
 * Ordence — Subscription State Machine
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE FILE FROM `server/billing/reconcile.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Everything here is PURE: given an event and the current subscription
 * state, it returns what should change. No database, no network, no
 * clock beyond what is passed in.
 *
 * That matters because this is where the interesting bugs live. "A
 * retried failure webhook must not undo a successful payment" and "a
 * cancelled subscription must not be dragged back into dunning" are
 * decisions, not I/O — and a decision that can only be tested through a
 * real PostgreSQL and a real HTTP call will be tested for three cases
 * instead of twenty.
 *
 * `reconcile.ts` keeps the transaction, the idempotency insert and the
 * tenant resolution. It calls into this. The split is the reason the
 * state table below is exhaustively covered by tests that run in
 * milliseconds.
 *
 * NO `server-only` GUARD: this module touches nothing secret and nothing
 * server-specific. It is guarded by having no reason to be imported on
 * the client rather than by a directive that would make it untestable.
 */

import { addDays, addInterval } from "./money";
import type {
  BillingInterval,
  SubscriptionStatus,
} from "@/db/schema/billing";
import type { NormalizedEvent } from "./providers/types";

/* ------------------------------------------------------------------ */
/* TUNING                                                              */
/* ------------------------------------------------------------------ */

/**
 * How long a failed payment keeps FULL access before Phase 14 is
 * permitted to restrict anything.
 *
 * Seven days is chosen against the most common cause: an expired card.
 * Replacing a card and updating it takes a person a few days at worst,
 * and cutting them off before that converts a renewal they intended to
 * make into churn they did not.
 */
export const DUNNING_GRACE_DAYS = 7;

/**
 * Failed attempts before `past_due` becomes `unpaid`.
 *
 * Four, because both providers retry a failed charge roughly 3–4 times
 * over two weeks. Matching their cadence means we exhaust dunning at
 * about the moment they do — rather than locking a customer out while
 * the provider is still successfully collecting from them, which is the
 * worst of both worlds.
 */
export const MAX_DUNNING_ATTEMPTS = 4;

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

/** The minimum a caller must know about the current subscription. */
export type SubscriptionState = {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  interval: BillingInterval;
  failedPaymentCount: number;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
};

export type SubscriptionPatch = Partial<{
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  failedPaymentCount: number;
  lastPaymentFailedAt: Date | null;
  graceEndsAt: Date | null;
  cancelledAt: Date | null;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string;
  providerCustomerId: string;
}>;

/* ------------------------------------------------------------------ */
/* THE ORDERING GUARD                                                  */
/* ------------------------------------------------------------------ */

/**
 * Should this event be APPLIED, or merely recorded?
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS SOLVES
 * ══════════════════════════════════════════════════════════════════════
 * Webhook delivery is not ordered. A `payment_failed` generated at 10:00
 * that fails to reach us is retried at 10:05 — by which time a
 * `payment_succeeded` from 10:02 has already been applied. Applying the
 * late failure would push a customer who has just paid into dunning, and
 * eventually lock them out of a product they are paid up on.
 *
 * The guard is a monotonic high-water mark of the PROVIDER's timestamp,
 * not ours. Our receipt time is exactly the thing that is out of order.
 *
 * An event with NO timestamp is applied. Providers occasionally omit it
 * in test mode, and refusing those would make the whole system untestable
 * against a provider sandbox — a real cost against a hypothetical one.
 */
export function shouldApply(
  eventOccurredAt: Date | null | undefined,
  lastAppliedAt: Date | null | undefined,
): boolean {
  if (!eventOccurredAt) return true;
  if (!lastAppliedAt) return true;
  return eventOccurredAt.getTime() >= lastAppliedAt.getTime();
}

/* ------------------------------------------------------------------ */
/* THE TRANSITION TABLE                                                */
/* ------------------------------------------------------------------ */

/**
 * Decide what an event changes about a subscription.
 *
 * Returns a PATCH, not a new state — so an event that changes nothing
 * returns `{}` and the caller can skip the UPDATE entirely.
 */
export function buildSubscriptionPatch(
  event: NormalizedEvent,
  current: SubscriptionState,
  now: Date = new Date(),
): SubscriptionPatch {
  const patch: SubscriptionPatch = {};
  const eventTime = event.occurredAt ?? now;

  /**
   * Backfill provider ids the first time we see them, and ONLY the first
   * time. This is what makes provider-id-based tenant resolution work for
   * every subsequent event.
   *
   * Never OVERWRITES an existing id. A subscription whose provider id
   * changed would silently detach from its own billing history at the
   * provider, and there is no legitimate reason for it to change.
   */
  if (event.providerSubscriptionId && !current.providerSubscriptionId) {
    patch.providerSubscriptionId = event.providerSubscriptionId;
  }
  if (event.providerCustomerId && !current.providerCustomerId) {
    patch.providerCustomerId = event.providerCustomerId;
  }

  switch (event.eventType) {
    /* ---------------------------------------------------------------- */
    case "subscription_created":
    case "payment_succeeded":
    case "subscription_renewed":
    case "invoice_paid": {
      patch.status = "active";

      // Dunning is fully reset by ANY successful payment. A customer who
      // failed twice and then paid is CURRENT, not "two-thirds of the way
      // to lockout".
      patch.failedPaymentCount = 0;
      patch.lastPaymentFailedAt = null;
      patch.graceEndsAt = null;

      if (event.periodStart && event.periodEnd && event.periodEnd > event.periodStart) {
        // The provider's own boundaries win when present — they are the
        // authority on what the customer was actually charged for.
        patch.currentPeriodStart = event.periodStart;
        patch.currentPeriodEnd = event.periodEnd;
      } else if (
        event.eventType === "subscription_renewed" ||
        event.eventType === "invoice_paid"
      ) {
        /**
         * ⭐ ADVANCE FROM THE EXISTING PERIOD END, NOT FROM NOW.
         *
         * If a renewal is processed three days late — a retry, a queue
         * backlog, an outage — advancing from `now` gifts the customer
         * three free days and moves their billing anchor forward. Every
         * cycle. Within a year their renewal date has drifted by weeks
         * and no one can explain why.
         *
         * Advancing from the previous end keeps the anchor fixed, which
         * is also what makes a proration computed months later
         * reproducible.
         */
        patch.currentPeriodStart = current.currentPeriodEnd;
        patch.currentPeriodEnd = addInterval(current.currentPeriodEnd, current.interval);
      }
      break;
    }

    /* ---------------------------------------------------------------- */
    case "payment_failed": {
      /**
       * A late failure must not resurrect a finished subscription. Without
       * this guard, a retried failure webhook arriving after cancellation
       * would move a cancelled customer to `past_due` — and Phase 14 would
       * then start dunning emails at someone who already left.
       */
      if (current.status === "cancelled" || current.status === "expired") break;

      const attempts = current.failedPaymentCount + 1;
      patch.failedPaymentCount = attempts;
      patch.lastPaymentFailedAt = eventTime;

      // `past_due` keeps full access; `unpaid` is what Phase 14 may gate on.
      patch.status = attempts >= MAX_DUNNING_ATTEMPTS ? "unpaid" : "past_due";
      patch.graceEndsAt = addDays(eventTime, DUNNING_GRACE_DAYS);
      break;
    }

    /* ---------------------------------------------------------------- */
    case "subscription_cancelled": {
      patch.status = "cancelled";
      patch.cancelledAt = eventTime;
      // They keep access to the end of the period they have paid for.
      patch.cancelAtPeriodEnd = true;
      break;
    }

    /* ---------------------------------------------------------------- */
    case "subscription_updated": {
      /**
       * An unrecognised provider status leaves ours ALONE.
       *
       * The alternative — defaulting to some value — means a provider
       * adding a new status string in a minor release could move a paying
       * customer into an arbitrary state. `unmapped → cancelled` would be
       * the worst available default and is exactly what a naive
       * `?? "cancelled"` would produce.
       */
      const mapped = mapProviderStatus(event.providerStatus);
      if (mapped) patch.status = mapped;

      if (event.periodStart && event.periodEnd && event.periodEnd > event.periodStart) {
        patch.currentPeriodStart = event.periodStart;
        patch.currentPeriodEnd = event.periodEnd;
      }
      break;
    }

    /* ---------------------------------------------------------------- */
    case "payment_refunded":
    case "dispute_opened": {
      /**
       * Deliberately changes NOTHING about the subscription.
       *
       * A refund can be partial, a goodwill gesture, or a duplicate charge
       * being returned — none of which mean the customer has stopped being
       * a customer. A dispute is a claim, not a verdict; revoking access
       * on one would punish someone who may simply not have recognised a
       * line on their statement.
       *
       * Both are recorded as high-signal events for a human to act on.
       */
      break;
    }

    /* ---------------------------------------------------------------- */
    case "mandate_created":
    case "mandate_revoked":
    case "invoice_created":
    case "unmapped":
      break;
  }

  return patch;
}

/* ------------------------------------------------------------------ */
/* PROVIDER STATUS MAPPING                                             */
/* ------------------------------------------------------------------ */

/**
 * Provider status strings → ours.
 *
 * One map covers both providers because their vocabularies do not
 * collide on any string where they would mean different things.
 * Returns `null` for anything unrecognised — see the note above about
 * why that is not a defaultable decision.
 */
export function mapProviderStatus(
  providerStatus: string | null | undefined,
): SubscriptionStatus | null {
  if (!providerStatus) return null;

  switch (providerStatus.toLowerCase()) {
    /* --- Shared --- */
    case "active":
      return "active";
    case "trialing":
    case "created":
    case "authenticated":
      return "trialing";
    case "paused":
      return "paused";
    case "cancelled":
    case "canceled": // Stripe spells it with one L.
      return "cancelled";
    case "completed":
    case "expired":
      return "expired";

    /* --- Razorpay --- */
    case "pending":
    case "halted":
      return "past_due";

    /* --- Stripe --- */
    case "past_due":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "incomplete":
      // Created but the first payment has not confirmed. Closest to a
      // trial: no money has moved and nothing should be revoked yet.
      return "trialing";
    case "incomplete_expired":
      return "expired";

    default:
      return null;
  }
}
