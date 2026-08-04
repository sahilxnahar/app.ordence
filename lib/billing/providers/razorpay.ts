/**
 * Ordence — Razorpay Adapter
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO `razorpay` NPM PACKAGE IN package.json
 * ══════════════════════════════════════════════════════════════════════
 * The official SDK is a thin wrapper over four REST calls plus an HMAC.
 * We need exactly those, and taking the dependency would cost us:
 *
 *   • a transitive `request`-family HTTP stack in a serverless bundle
 *     where cold-start size is the thing you actually pay for;
 *   • a package that must be kept current in a code path that handles
 *     money, adding supply-chain surface to the highest-value target in
 *     the application;
 *   • an abstraction over `fetch`, which is already global in Node 18+
 *     and on the Edge runtime.
 *
 * `node:crypto` and `fetch` are both platform primitives. The signature
 * algorithm is documented, stable, and fifteen lines. This file is that
 * trade made explicitly rather than by default.
 *
 * ⚠️ NODE RUNTIME ONLY. `node:crypto`'s `timingSafeEqual` has no Edge
 * equivalent, so any route importing this must declare
 * `export const runtime = "nodejs"`.
 */

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ProviderError,
  ProviderNotConfiguredError,
  type CheckoutSession,
  type NormalizedEvent,
  type PaymentProviderAdapter,
  type VerificationResult,
} from "./types";
import { redactPayloadObject } from "../redact";
import type { PaymentEventType } from "@/db/schema/billing";

const RAZORPAY_API = "https://api.razorpay.com/v1";
const SIGNATURE_HEADER = "x-razorpay-signature";

/* ------------------------------------------------------------------ */
/* CONFIGURATION                                                       */
/* ------------------------------------------------------------------ */

type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

/**
 * Read config at CALL TIME, not at module load.
 *
 * A module-level `getServerEnv()` would run during the Next.js build,
 * when secrets are legitimately absent, and fail the build. It would also
 * bake the value in for the process lifetime, which breaks key rotation.
 */
function readConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!keyId || !keySecret || !webhookSecret) return null;
  return { keyId, keySecret, webhookSecret };
}

/* ------------------------------------------------------------------ */
/* EVENT VOCABULARY MAPPING                                            */
/* ------------------------------------------------------------------ */

/**
 * Razorpay's event names → ours.
 *
 * Deliberately a CLOSED map. An event we have never seen becomes
 * `unmapped` — recorded in full, acted upon not at all. The alternative
 * (pattern-matching on the string, e.g. anything containing "failed") is
 * how a new `payment.downtime.started` event ends up putting healthy
 * subscriptions into dunning.
 */
const RAZORPAY_EVENT_MAP: Readonly<Record<string, PaymentEventType>> = Object.freeze({
  "payment.captured": "payment_succeeded",
  "payment.authorized": "payment_succeeded",
  "payment.failed": "payment_failed",
  "refund.created": "payment_refunded",
  "refund.processed": "payment_refunded",

  "subscription.activated": "subscription_created",
  "subscription.authenticated": "subscription_created",
  "subscription.charged": "subscription_renewed",
  "subscription.updated": "subscription_updated",
  "subscription.pending": "subscription_updated",
  "subscription.halted": "subscription_updated",
  "subscription.paused": "subscription_updated",
  "subscription.resumed": "subscription_updated",
  "subscription.cancelled": "subscription_cancelled",
  "subscription.completed": "subscription_cancelled",

  "invoice.paid": "invoice_paid",
  "invoice.partially_paid": "invoice_created",
  "invoice.expired": "invoice_created",

  "token.confirmed": "mandate_created",
  "token.rejected": "mandate_revoked",
  "token.cancelled": "mandate_revoked",

  "payment.dispute.created": "dispute_opened",
});

/* ------------------------------------------------------------------ */
/* PAYLOAD SHAPE HELPERS                                               */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Razorpay sends amounts as an integer in paise already — the same unit
 * we store. No conversion, and importantly no division: the moment you
 * write `amount / 100` you have created a float.
 */
function readAmountMinor(source: Record<string, unknown> | null): bigint | null {
  if (!source) return null;
  const value = source["amount"];
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Razorpay timestamps are UNIX SECONDS. Milliseconds would be year 56000. */
function readUnixSeconds(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Sanity window: 2000-01-01 to 2100-01-01. A timestamp outside it is a
  // unit error somewhere, and silently accepting it would corrupt the
  // monotonic ordering guard on the subscription.
  if (value < 946_684_800 || value > 4_102_444_800) return null;
  return new Date(value * 1000);
}

/**
 * Dig the first `entity` of a given type out of Razorpay's payload.
 *
 * Their envelope is `{ event, payload: { payment: { entity: {...} },
 * subscription: { entity: {...} } } }` and which keys are present depends
 * entirely on the event. Rather than a switch per event, this looks for
 * the entity we want wherever it happens to be.
 */
function extractEntity(
  payload: Record<string, unknown> | null,
  entityName: string,
): Record<string, unknown> | null {
  const container = asRecord(payload?.["payload"]);
  const wrapper = asRecord(container?.[entityName]);
  return asRecord(wrapper?.["entity"]);
}

/* ------------------------------------------------------------------ */
/* THE ADAPTER                                                         */
/* ------------------------------------------------------------------ */

export const razorpayAdapter: PaymentProviderAdapter = {
  provider: "razorpay",

  isConfigured(): boolean {
    return readConfig() !== null;
  },

  /**
   * ══════════════════════════════════════════════════════════════════
   * RAZORPAY WEBHOOK SIGNATURE
   * ══════════════════════════════════════════════════════════════════
   * `X-Razorpay-Signature: <hex>` where hex is
   * HMAC-SHA256(rawBody, webhookSecret).
   *
   * Compared with `timingSafeEqual`, not `===`. A string comparison
   * short-circuits at the first differing byte, so the time it takes
   * leaks how many leading characters were correct — enough, over enough
   * requests, to reconstruct a valid signature one character at a time.
   * The window is small over a network but it is not zero, and the fix
   * costs nothing.
   *
   * ⚠️ Razorpay's webhook signature carries NO TIMESTAMP, so unlike
   * Stripe there is no replay window to enforce here. Replay protection
   * for this provider rests entirely on the UNIQUE index over
   * `payment_events(provider, provider_event_id)`. That is why the index
   * exists at the database level rather than as an application check.
   */
  verifyWebhook(rawBody: string, headers: Headers): VerificationResult {
    const config = readConfig();
    if (!config) return { ok: false, reason: "missing_secret" };

    const provided = headers.get(SIGNATURE_HEADER);
    if (!provided) return { ok: false, reason: "missing_signature" };

    const normalized = provided.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      return { ok: false, reason: "malformed_signature" };
    }

    const expected = createHmac("sha256", config.webhookSecret)
      .update(rawBody, "utf8")
      .digest("hex");

    // Both are known to be 64 hex chars by construction and by the regex
    // above, so the lengths match and timingSafeEqual cannot throw.
    const matches = timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(normalized, "hex"),
    );

    return matches ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  },

  /**
   * Never throws. A webhook handler that throws returns 5xx, and a 5xx
   * makes Razorpay retry — for days, at increasing intervals, for an
   * event that will never parse. A malformed payload should be recorded
   * and acknowledged, not retried.
   */
  normalizeEvent(payload: unknown): NormalizedEvent | null {
    try {
      const root = asRecord(payload);
      if (!root) return null;

      const providerEventName = readString(root, "event");
      if (!providerEventName) return null;

      const payment = extractEntity(root, "payment");
      const subscription = extractEntity(root, "subscription");
      const invoice = extractEntity(root, "invoice");
      const refund = extractEntity(root, "refund");
      const token = extractEntity(root, "token");

      /**
       * ⚠️ THE IDEMPOTENCY KEY, AND WHY IT IS NOT ALWAYS `root.id`.
       *
       * Razorpay's documented webhook id lives in the `x-razorpay-event-id`
       * HEADER, and older payload versions omit an `id` at the root
       * entirely. Falling back to a synthesised key here would be a
       * disaster: a synthesised key that varies between two deliveries of
       * the SAME event defeats the unique index and permits a double
       * charge.
       *
       * So the fallback is DETERMINISTIC — event name plus the entity id
       * plus the entity's own creation timestamp. Two deliveries of one
       * event produce the same string; two genuinely different events do
       * not. The route handler passes the header id in preference to this
       * whenever it is present.
       */
      const rootId = readString(root, "id");
      const entityId =
        readString(payment, "id") ??
        readString(subscription, "id") ??
        readString(invoice, "id") ??
        readString(refund, "id") ??
        readString(token, "id");
      const createdAtRaw =
        root["created_at"] ??
        payment?.["created_at"] ??
        subscription?.["created_at"] ??
        invoice?.["created_at"];

      const providerEventId =
        rootId ??
        `rzp:${providerEventName}:${entityId ?? "none"}:${
          typeof createdAtRaw === "number" ? createdAtRaw : "0"
        }`;

      const eventType: PaymentEventType =
        RAZORPAY_EVENT_MAP[providerEventName] ?? "unmapped";

      /**
       * Tenant hint. We set `notes.tenant_id` when creating the
       * subscription, and Razorpay echoes `notes` back on every related
       * event. Checked on the subscription first, then the payment —
       * the subscription's notes are the ones we authored.
       */
      const subscriptionNotes = asRecord(subscription?.["notes"]);
      const paymentNotes = asRecord(payment?.["notes"]);
      const tenantIdHint =
        readString(subscriptionNotes, "tenant_id") ?? readString(paymentNotes, "tenant_id");

      const amountMinor =
        readAmountMinor(payment) ?? readAmountMinor(invoice) ?? readAmountMinor(refund);

      const currency =
        readString(payment, "currency") ??
        readString(invoice, "currency") ??
        readString(refund, "currency");

      return {
        provider: "razorpay",
        providerEventId,
        providerEventName,
        eventType,
        occurredAt: readUnixSeconds(createdAtRaw),

        providerSubscriptionId:
          readString(subscription, "id") ?? readString(payment, "subscription_id"),
        providerCustomerId:
          readString(subscription, "customer_id") ?? readString(payment, "customer_id"),
        providerPaymentId: readString(payment, "id") ?? readString(refund, "payment_id"),
        providerInvoiceId: readString(invoice, "id") ?? readString(payment, "invoice_id"),

        tenantIdHint,
        amountMinor,
        currency,

        periodStart: readUnixSeconds(subscription?.["current_start"]),
        periodEnd: readUnixSeconds(subscription?.["current_end"]),
        providerStatus: readString(subscription, "status") ?? readString(payment, "status"),

        payload: redactPayloadObject(payload),
      };
    } catch {
      // Deliberately swallowed. See the doc comment above: an exception
      // here becomes an infinite provider retry.
      return null;
    }
  },

  /* ---------------------------------------------------------------- */
  /* API CALLS                                                        */
  /* ---------------------------------------------------------------- */

  async createSubscription(args): Promise<CheckoutSession> {
    const config = readConfig();
    if (!config) throw new ProviderNotConfiguredError("razorpay");

    /**
     * `total_count` is how many cycles to bill. Razorpay requires a
     * finite number — there is no "until cancelled". 120 monthly cycles
     * is ten years, comfortably beyond any realistic subscription life,
     * and the subscription is renewed or replaced long before then.
     * Setting it to something small would silently stop billing a happy
     * customer, which is the worst failure mode available here.
     */
    const body: Record<string, unknown> = {
      plan_id: args.providerPlanId,
      total_count: 120,
      quantity: Math.max(1, args.seats),
      customer_notify: 1,
      // Echoed back on every webhook — our correlation path home.
      notes: {
        tenant_id: args.tenantId,
        customer_email: args.customerEmail,
      },
    };

    if (args.trialEndsAt) {
      // `start_at` is UNIX SECONDS. Billing begins when the trial ends.
      body["start_at"] = Math.floor(args.trialEndsAt.getTime() / 1000);
    }

    const response = await razorpayFetch(config, "/subscriptions", {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey: args.idempotencyKey,
    });

    const subscriptionId = readString(response, "id");
    if (!subscriptionId) {
      throw new ProviderError(
        "Razorpay accepted the subscription but returned no id.",
        "razorpay",
        false,
      );
    }

    return {
      // Razorpay's short_url is a hosted page; when absent the client
      // opens the Checkout widget with the params below instead.
      url: readString(response, "short_url"),
      providerReferenceId: subscriptionId,
      clientParams: {
        subscription_id: subscriptionId,
        key: config.keyId, // The PUBLISHABLE key. The secret never leaves here.
      },
    };
  },

  async cancelSubscription(args): Promise<void> {
    const config = readConfig();
    if (!config) throw new ProviderNotConfiguredError("razorpay");

    await razorpayFetch(config, `/subscriptions/${encodeURIComponent(args.providerSubscriptionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ cancel_at_cycle_end: args.atPeriodEnd ? 1 : 0 }),
    });
  },
};

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/**
 * One place where every Razorpay HTTP call goes.
 *
 * Two things it guarantees that scattered `fetch` calls would not:
 *
 * • A TIMEOUT. `fetch` has none by default. A hung connection to a
 *   provider would occupy a Vercel function until the platform kills it
 *   at the plan limit, and on a webhook path that means the provider
 *   times out and retries into an already-overloaded handler.
 *
 * • RETRYABILITY CLASSIFICATION. 5xx and 429 are retryable; 4xx is not.
 *   Retrying a 400 forever is how a misconfigured plan id turns into a
 *   rate-limit ban.
 */
async function razorpayFetch(
  config: RazorpayConfig,
  path: string,
  init: { method: string; body?: string; idempotencyKey?: string },
): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    };
    if (init.idempotencyKey) {
      headers["X-Razorpay-Idempotency-Key"] = init.idempotencyKey;
    }

    const response = await fetch(`${RAZORPAY_API}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const errorBody = asRecord(asRecord(parsed)?.["error"]);
      const description =
        readString(errorBody, "description") ?? `HTTP ${response.status}`;
      throw new ProviderError(
        `Razorpay ${init.method} ${path} failed: ${description}`,
        "razorpay",
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    return asRecord(parsed) ?? {};
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // AbortError, DNS failure, socket reset — all genuinely transient.
    throw new ProviderError(
      `Razorpay ${init.method} ${path} did not complete: ${
        error instanceof Error ? error.message : "unknown transport error"
      }`,
      "razorpay",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Exposed for tests. Not part of the adapter interface. */
export const __razorpayInternals = {
  RAZORPAY_EVENT_MAP,
  extractEntity,
  readUnixSeconds,
};
