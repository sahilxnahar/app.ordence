/**
 * Ordence — Manual / Offline Settlement Adapter
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Enterprise customers in India frequently will not put a subscription on
 * a card. They want a proforma invoice, they pay by NEFT or RTGS against
 * a purchase order, and finance reconciles it by hand weeks later. That
 * is a completely normal way to be paid and the system has to model it.
 *
 * It is NOT a fallback for a broken integration, and it is NOT a way to
 * grant free access. Every manual payment produces a real invoice and a
 * real `payment_events` row, recorded by a named user with a bank
 * reference, and every one is visible in the same audit trail as a card
 * payment. The only difference is that a human asserts the money arrived
 * instead of a webhook doing so.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY IT IMPLEMENTS THE ADAPTER INTERFACE AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * So that nothing downstream needs a special case. The reconciler, the
 * invoice renderer, the billing portal and the entitlement engine all
 * work against `provider` generically. A `manual` subscription that was
 * modelled as "no provider" would need a null check in each of those, and
 * one of them would eventually be missed.
 */

import "server-only";

import {
  ProviderError,
  type CheckoutSession,
  type NormalizedEvent,
  type PaymentProviderAdapter,
  type VerificationResult,
} from "./types";

export const manualAdapter: PaymentProviderAdapter = {
  provider: "manual",

  /** Always available — it requires no keys, only a person. */
  isConfigured(): boolean {
    return true;
  },

  /**
   * There is no such thing as a manual webhook.
   *
   * This returns `missing_secret` rather than throwing, so that a
   * misrouted request to a webhook endpoint carrying `provider=manual`
   * is rejected cleanly instead of producing a 500. Returning `ok: true`
   * here would be a catastrophic hole: anyone who could reach the
   * webhook route could mark any invoice paid.
   */
  verifyWebhook(_rawBody: string, _headers: Headers): VerificationResult {
    return { ok: false, reason: "missing_secret" };
  },

  /** Nothing arrives by webhook, so nothing is ever normalised. */
  normalizeEvent(_payload: unknown): NormalizedEvent | null {
    return null;
  },

  /**
   * A manual subscription is created directly in `server/actions/billing.ts`
   * by a platform administrator; there is no remote object to create and
   * no page to redirect to.
   *
   * Throwing rather than returning an empty session is deliberate. If
   * some future checkout flow accidentally routes a self-serve customer
   * here, they must hit a loud error — not a blank page that silently
   * grants them an unpaid subscription.
   */
  async createSubscription(): Promise<CheckoutSession> {
    throw new ProviderError(
      "Manual subscriptions are created by a platform administrator, not through checkout.",
      "manual",
      false,
    );
  },

  /**
   * Cancellation of a manual subscription is a database state change with
   * no remote counterpart, handled by the billing action. This is a
   * deliberate no-op so the generic cancel path does not need a branch.
   */
  async cancelSubscription(): Promise<void> {
    return;
  },
};
