/**
 * Ordence — Payment Provider Adapter Contract
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY AN ADAPTER LAYER AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Not for the usual "we might swap providers one day" reason — that is
 * rarely worth the abstraction. It is because we need BOTH, concurrently
 * and permanently: Razorpay settles INR natively and supports UPI,
 * NetBanking and RuPay, which is how Indian customers actually pay;
 * Stripe is the rail for international cards. Neither one covers the
 * other's customers.
 *
 * With both live, the alternative to an adapter is a `if (provider ===
 * 'razorpay')` branch at every call site — including inside the
 * reconciliation logic, which is where a missed branch turns into a
 * missed payment.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT AN ADAPTER MAY AND MAY NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * MAY:  verify signatures, call the provider's HTTP API, translate the
 *       provider's event vocabulary into ours.
 * MUST NOT: touch the database, resolve a tenant, or decide whether an
 *       event should be applied. Adapters are pure translation. All
 *       state changes happen in `server/billing/reconcile.ts`, in one
 *       place, under one set of idempotency rules.
 *
 * This division is what makes the reconciliation logic testable without a
 * network, and the adapters testable without a database.
 */

import type {
  PaymentEventType,
  PaymentProvider,
  BillingInterval,
} from "@/db/schema/billing";

/* ------------------------------------------------------------------ */
/* NORMALISED EVENT                                                    */
/* ------------------------------------------------------------------ */

/**
 * A provider webhook, translated into our vocabulary.
 *
 * Every field that could be absent IS optional, and the reconciler is
 * written to cope with each absence. Providers add fields, rename them
 * between API versions, and omit them in test mode; an adapter that
 * assumed a field was present would throw inside a webhook handler, which
 * means a non-2xx response, which means the provider retries forever.
 */
export type NormalizedEvent = {
  provider: PaymentProvider;

  /** The provider's own event id. THE idempotency key. Never synthesised. */
  providerEventId: string;

  /** The provider's raw event name, kept verbatim for forensics. */
  providerEventName: string;

  /** Our closed vocabulary. `unmapped` for anything we do not act on. */
  eventType: PaymentEventType;

  /** When the PROVIDER says it happened — not when we received it. */
  occurredAt: Date | null;

  /* --- Correlation handles, any of which may be absent --- */
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  providerPaymentId?: string | null;
  providerInvoiceId?: string | null;

  /**
   * Our tenant id, when the provider echoed it back in metadata. This is
   * the PREFERRED correlation path — see the note in `reconcile.ts` about
   * why metadata is checked before provider ids.
   */
  tenantIdHint?: string | null;

  amountMinor?: bigint | null;
  currency?: string | null;

  /** New period boundaries, when the event carries them. */
  periodStart?: Date | null;
  periodEnd?: Date | null;

  /** Provider's own subscription status string, if present. */
  providerStatus?: string | null;

  /** The verified payload, redacted, exactly as stored. */
  payload: Record<string, unknown>;
};

/* ------------------------------------------------------------------ */
/* SIGNATURE VERIFICATION RESULT                                       */
/* ------------------------------------------------------------------ */

export type VerificationResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * Machine-readable reason. Logged and counted; NEVER returned to
       * the caller in a response body. Telling an attacker whether their
       * signature was malformed, stale or simply wrong is three bits of
       * feedback they did not have to earn.
       */
      reason:
        | "missing_secret"
        | "missing_signature"
        | "malformed_signature"
        | "timestamp_out_of_tolerance"
        | "signature_mismatch";
    };

/* ------------------------------------------------------------------ */
/* THE ADAPTER INTERFACE                                               */
/* ------------------------------------------------------------------ */

export type CheckoutSession = {
  /** Where to send the browser to complete payment. */
  url: string | null;
  /** The provider's id for the thing we just created. */
  providerReferenceId: string;
  /** Provider-specific fields the client widget needs (Razorpay Checkout). */
  clientParams: Record<string, string>;
};

export interface PaymentProviderAdapter {
  readonly provider: PaymentProvider;

  /** False when the provider's keys are absent from the environment. */
  isConfigured(): boolean;

  /**
   * Verify a webhook against the RAW request body.
   *
   * ⚠️ The body MUST be the exact bytes received. `JSON.parse` followed by
   * `JSON.stringify` reorders keys, drops insignificant whitespace and
   * normalises unicode escapes — any one of which changes the HMAC and
   * turns every legitimate webhook into a signature failure. Route
   * handlers therefore call `request.text()` and pass that string
   * through untouched.
   */
  verifyWebhook(rawBody: string, headers: Headers): VerificationResult;

  /** Translate a verified payload into our vocabulary. Never throws. */
  normalizeEvent(payload: unknown): NormalizedEvent | null;

  /**
   * Create a subscription at the provider and return whatever the client
   * needs to complete it. `tenantId` is passed so the adapter can attach
   * it as provider-side metadata — that metadata is what lets a later
   * webhook resolve back to a tenant without a database scan.
   */
  createSubscription(args: {
    tenantId: string;
    providerPlanId: string;
    customerEmail: string;
    customerName: string;
    seats: number;
    trialEndsAt: Date | null;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession>;

  /** Cancel at the provider. `atPeriodEnd = false` cancels immediately. */
  cancelSubscription(args: {
    providerSubscriptionId: string;
    atPeriodEnd: boolean;
  }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Thrown for provider API failures. Carries a flag saying whether a retry
 * could plausibly succeed, because the caller's correct behaviour differs
 * completely: a 5xx or a network timeout should be retried, while a 400
 * ("plan does not exist") never will be and should surface to a human.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: PaymentProvider,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: PaymentProvider) {
    super(
      `Payment provider "${provider}" is not configured. ` +
        `Set its API keys in the environment before attempting to charge anyone.`,
      provider,
      false,
    );
    this.name = "ProviderNotConfiguredError";
  }
}

/* ------------------------------------------------------------------ */
/* INTERVAL MAPPING                                                    */
/* ------------------------------------------------------------------ */

/** Our interval → the number of months it spans. */
export const INTERVAL_MONTHS: Readonly<Record<BillingInterval, number>> = Object.freeze({
  monthly: 1,
  quarterly: 3,
  annual: 12,
});
