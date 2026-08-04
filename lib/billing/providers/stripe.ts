/**
 * Ordence — Stripe Adapter
 * Version: v0.11.0-alpha
 *
 * Same reasoning as the Razorpay adapter: no SDK, `node:crypto` plus
 * `fetch`. See `razorpay.ts` for the full argument.
 *
 * Stripe's webhook signature scheme is materially better than Razorpay's
 * because it INCLUDES A TIMESTAMP, which permits a replay window. That is
 * implemented below and is the main difference between the two files.
 *
 * ⚠️ NODE RUNTIME ONLY (`node:crypto`).
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

const STRIPE_API = "https://api.stripe.com/v1";
const SIGNATURE_HEADER = "stripe-signature";

/**
 * How stale a signed timestamp may be before the request is rejected.
 *
 * Five minutes is Stripe's own documented default. It is a compromise:
 * long enough to survive clock skew between their servers and ours plus
 * a slow retry, short enough that a captured request is useless by the
 * time an attacker has extracted it from a log. Making it longer to "be
 * safe" is backwards — the tolerance IS the replay window.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

/* ------------------------------------------------------------------ */
/* CONFIGURATION                                                       */
/* ------------------------------------------------------------------ */

type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
};

function readConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  return { secretKey, webhookSecret };
}

/* ------------------------------------------------------------------ */
/* EVENT VOCABULARY MAPPING                                            */
/* ------------------------------------------------------------------ */

const STRIPE_EVENT_MAP: Readonly<Record<string, PaymentEventType>> = Object.freeze({
  "payment_intent.succeeded": "payment_succeeded",
  "charge.succeeded": "payment_succeeded",
  "payment_intent.payment_failed": "payment_failed",
  "charge.failed": "payment_failed",
  "charge.refunded": "payment_refunded",
  "charge.refund.updated": "payment_refunded",

  "customer.subscription.created": "subscription_created",
  "customer.subscription.updated": "subscription_updated",
  "customer.subscription.paused": "subscription_updated",
  "customer.subscription.resumed": "subscription_updated",
  "customer.subscription.deleted": "subscription_cancelled",
  "customer.subscription.trial_will_end": "subscription_updated",

  "invoice.created": "invoice_created",
  "invoice.finalized": "invoice_created",
  "invoice.paid": "invoice_paid",
  "invoice.payment_succeeded": "subscription_renewed",
  "invoice.payment_failed": "payment_failed",

  "setup_intent.succeeded": "mandate_created",
  "payment_method.detached": "mandate_revoked",

  "charge.dispute.created": "dispute_opened",
});

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
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
 * Stripe amounts are already in the smallest currency unit — cents for
 * USD, paise for INR. No conversion, and specifically no `/ 100`.
 */
function readAmountMinor(
  source: Record<string, unknown> | null,
  ...keys: string[]
): bigint | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  }
  return null;
}

function readUnixSeconds(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 946_684_800 || value > 4_102_444_800) return null;
  return new Date(value * 1000);
}

/**
 * Parse the `Stripe-Signature` header.
 *
 * Format: `t=1699999999,v1=abc...,v1=def...` — note that v1 may appear
 * MORE THAN ONCE. Stripe sends one signature per configured endpoint
 * secret during a secret rotation, and a parser that took only the first
 * would reject every webhook for the duration of the rotation. Each
 * candidate is checked and any match is accepted.
 */
function parseSignatureHeader(
  header: string,
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    if (key === "t") {
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (/^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/* ------------------------------------------------------------------ */
/* THE ADAPTER                                                         */
/* ------------------------------------------------------------------ */

export const stripeAdapter: PaymentProviderAdapter = {
  provider: "stripe",

  isConfigured(): boolean {
    return readConfig() !== null;
  },

  /**
   * ══════════════════════════════════════════════════════════════════
   * STRIPE WEBHOOK SIGNATURE
   * ══════════════════════════════════════════════════════════════════
   * The signed payload is the literal string `${timestamp}.${rawBody}`,
   * HMAC-SHA256 with the endpoint's signing secret, hex encoded.
   *
   * The dot matters. Without it, a body starting with digits could be
   * split differently against a different timestamp to produce the same
   * signed string — a length-extension-flavoured ambiguity that the
   * separator removes.
   *
   * TWO independent checks, both required:
   *   1. The timestamp is within tolerance  → replay protection.
   *   2. The HMAC matches                   → authenticity.
   *
   * Order matters for cost, not correctness: the timestamp check is
   * arithmetic and rejects a flood of replayed requests before any HMAC
   * is computed.
   */
  verifyWebhook(rawBody: string, headers: Headers): VerificationResult {
    const config = readConfig();
    if (!config) return { ok: false, reason: "missing_secret" };

    const header = headers.get(SIGNATURE_HEADER);
    if (!header) return { ok: false, reason: "missing_signature" };

    const parsed = parseSignatureHeader(header);
    if (!parsed) return { ok: false, reason: "malformed_signature" };

    const nowSeconds = Math.floor(Date.now() / 1000);
    const drift = Math.abs(nowSeconds - parsed.timestamp);
    // Absolute value, so a signature from the FUTURE is rejected too.
    // A far-future timestamp would otherwise stay valid indefinitely.
    if (drift > TIMESTAMP_TOLERANCE_SECONDS) {
      return { ok: false, reason: "timestamp_out_of_tolerance" };
    }

    const signedPayload = `${parsed.timestamp}.${rawBody}`;
    const expected = createHmac("sha256", config.webhookSecret)
      .update(signedPayload, "utf8")
      .digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    // Every candidate is compared even after a match is found, so the
    // total time does not depend on WHICH secret matched during a
    // rotation. Cheap, and it keeps the timing property honest.
    let matched = false;
    for (const candidate of parsed.signatures) {
      const candidateBuffer = Buffer.from(candidate, "hex");
      if (candidateBuffer.length !== expectedBuffer.length) continue;
      if (timingSafeEqual(expectedBuffer, candidateBuffer)) matched = true;
    }

    return matched ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  },

  normalizeEvent(payload: unknown): NormalizedEvent | null {
    try {
      const root = asRecord(payload);
      if (!root) return null;

      const providerEventId = readString(root, "id");
      const providerEventName = readString(root, "type");
      if (!providerEventId || !providerEventName) return null;

      // Stripe's envelope: { id, type, created, data: { object: {...} } }
      const dataObject = asRecord(asRecord(root["data"])?.["object"]);

      const eventType: PaymentEventType = STRIPE_EVENT_MAP[providerEventName] ?? "unmapped";

      const objectType = readString(dataObject, "object");

      /**
       * Correlation depends on which object the event carries, and the
       * field names differ. A subscription event's own id IS the
       * subscription id; an invoice event carries it in `subscription`.
       */
      const providerSubscriptionId =
        objectType === "subscription"
          ? readString(dataObject, "id")
          : readString(dataObject, "subscription");

      const providerInvoiceId =
        objectType === "invoice"
          ? readString(dataObject, "id")
          : readString(dataObject, "invoice");

      const providerPaymentId =
        objectType === "payment_intent" || objectType === "charge"
          ? readString(dataObject, "id")
          : readString(dataObject, "payment_intent");

      const metadata = asRecord(dataObject?.["metadata"]);
      const tenantIdHint = readString(metadata, "tenant_id");

      /**
       * `amount_paid` before `amount_due` before `amount`: on an invoice,
       * `amount_due` is what was billed and `amount_paid` is what
       * actually arrived. Recording the billed figure on a partial
       * payment would overstate revenue in the event log.
       */
      const amountMinor = readAmountMinor(
        dataObject,
        "amount_paid",
        "amount_received",
        "amount_due",
        "amount",
      );

      return {
        provider: "stripe",
        providerEventId,
        providerEventName,
        eventType,
        occurredAt: readUnixSeconds(root["created"]),

        providerSubscriptionId,
        providerCustomerId: readString(dataObject, "customer"),
        providerPaymentId,
        providerInvoiceId,

        tenantIdHint,
        amountMinor,
        currency: readString(dataObject, "currency")?.toUpperCase() ?? null,

        periodStart: readUnixSeconds(dataObject?.["current_period_start"]),
        periodEnd: readUnixSeconds(dataObject?.["current_period_end"]),
        providerStatus: readString(dataObject, "status"),

        payload: redactPayloadObject(payload),
      };
    } catch {
      return null;
    }
  },

  /* ---------------------------------------------------------------- */
  /* API CALLS                                                        */
  /* ---------------------------------------------------------------- */

  async createSubscription(args): Promise<CheckoutSession> {
    const config = readConfig();
    if (!config) throw new ProviderNotConfiguredError("stripe");

    /**
     * A Checkout Session in `subscription` mode, rather than creating a
     * Subscription directly. Stripe hosts the payment page, which keeps
     * card data entirely off our origin and out of PCI scope — the same
     * reasoning as the direct-to-blob upload in Phase 8.
     */
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("success_url", args.successUrl);
    form.set("cancel_url", args.cancelUrl);
    form.set("customer_email", args.customerEmail);
    form.set("line_items[0][price]", args.providerPlanId);
    form.set("line_items[0][quantity]", String(Math.max(1, args.seats)));

    // Metadata on BOTH the session and the resulting subscription.
    // Session metadata does not propagate automatically, and it is the
    // SUBSCRIPTION's metadata that later renewal webhooks carry.
    form.set("metadata[tenant_id]", args.tenantId);
    form.set("subscription_data[metadata][tenant_id]", args.tenantId);

    if (args.trialEndsAt) {
      const days = Math.ceil((args.trialEndsAt.getTime() - Date.now()) / 86_400_000);
      // Stripe rejects trial_period_days < 1. A trial ending today is
      // simply no trial, not an error.
      if (days >= 1) form.set("subscription_data[trial_period_days]", String(days));
    }

    const response = await stripeFetch(config, "/checkout/sessions", {
      method: "POST",
      body: form.toString(),
      idempotencyKey: args.idempotencyKey,
    });

    const sessionId = readString(response, "id");
    if (!sessionId) {
      throw new ProviderError(
        "Stripe accepted the checkout session but returned no id.",
        "stripe",
        false,
      );
    }

    return {
      url: readString(response, "url"),
      providerReferenceId: sessionId,
      clientParams: {},
    };
  },

  async cancelSubscription(args): Promise<void> {
    const config = readConfig();
    if (!config) throw new ProviderNotConfiguredError("stripe");

    const path = `/subscriptions/${encodeURIComponent(args.providerSubscriptionId)}`;

    if (args.atPeriodEnd) {
      const form = new URLSearchParams();
      form.set("cancel_at_period_end", "true");
      await stripeFetch(config, path, { method: "POST", body: form.toString() });
      return;
    }

    await stripeFetch(config, path, { method: "DELETE" });
  },
};

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function stripeFetch(
  config: StripeConfig,
  path: string,
  init: { method: string; body?: string; idempotencyKey?: string },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      /**
       * PINNED API VERSION. Stripe rolls accounts forward onto new
       * versions, and a version change alters payload shapes — which
       * would silently break the field reads in `normalizeEvent` at a
       * moment nobody chose. Pinning means upgrades are a deliberate
       * commit with a test run, not a surprise.
       */
      "Stripe-Version": "2024-06-20",
    };
    if (init.idempotencyKey) {
      headers["Idempotency-Key"] = init.idempotencyKey;
    }

    const response = await fetch(`${STRIPE_API}${path}`, {
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
      const message = readString(errorBody, "message") ?? `HTTP ${response.status}`;
      throw new ProviderError(
        `Stripe ${init.method} ${path} failed: ${message}`,
        "stripe",
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    return asRecord(parsed) ?? {};
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `Stripe ${init.method} ${path} did not complete: ${
        error instanceof Error ? error.message : "unknown transport error"
      }`,
      "stripe",
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Exposed for tests. Not part of the adapter interface. */
export const __stripeInternals = {
  STRIPE_EVENT_MAP,
  parseSignatureHeader,
  TIMESTAMP_TOLERANCE_SECONDS,
};
