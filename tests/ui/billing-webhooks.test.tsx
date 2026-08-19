/**
 * Ordence — Webhook Verification & Subscription State Machine
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 11 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * "Webhook handling with signature verification, idempotent payment
 *  reconciliation."
 *
 * The webhook endpoints are PUBLIC and UNAUTHENTICATED. The HMAC is the
 * only thing between the internet and our subscription state — so anyone
 * who can forge a signature can grant themselves a free enterprise plan,
 * or mark another tenant's subscription cancelled.
 *
 * These tests do not check that the code "calls crypto". They construct
 * real signatures with the real algorithm and assert that valid ones pass
 * and every category of invalid one fails.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { razorpayAdapter } from "@/lib/billing/providers/razorpay";
import { stripeAdapter, __stripeInternals } from "@/lib/billing/providers/stripe";
import { manualAdapter } from "@/lib/billing/providers/manual";
import { redactPayload, redactPayloadObject } from "@/lib/billing/redact";
import {
  buildSubscriptionPatch,
  shouldApply,
  mapProviderStatus,
  MAX_DUNNING_ATTEMPTS,
  DUNNING_GRACE_DAYS,
  type SubscriptionState,
} from "@/lib/billing/state-machine";
import type { NormalizedEvent } from "@/lib/billing/providers/types";

const RZP_SECRET = "rzp_test_webhook_secret_value";
const STRIPE_SECRET = "whsec_test_signing_secret_value";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_keyid";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_keysecret";
  process.env.RAZORPAY_WEBHOOK_SECRET = RZP_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_key";
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/* ================================================================== */
/* RAZORPAY SIGNATURES                                                 */
/* ================================================================== */

function razorpaySignature(body: string, secret = RZP_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function razorpayHeaders(body: string, secret = RZP_SECRET): Headers {
  return new Headers({ "x-razorpay-signature": razorpaySignature(body, secret) });
}

describe("Razorpay webhook signature", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: {} });

  it("accepts a correctly signed body", () => {
    expect(razorpayAdapter.verifyWebhook(body, razorpayHeaders(body))).toEqual({ ok: true });
  });

  it("rejects a body signed with the WRONG secret", () => {
    const headers = razorpayHeaders(body, "not-the-real-secret");
    expect(razorpayAdapter.verifyWebhook(body, headers)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a TAMPERED body carrying a once-valid signature", () => {
    // The whole point: an attacker who captures a real webhook must not be
    // able to change the amount and replay it.
    const headers = razorpayHeaders(body);
    const tampered = JSON.stringify({ event: "payment.captured", payload: { amount: 1 } });
    expect(razorpayAdapter.verifyWebhook(tampered, headers)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a missing signature header", () => {
    expect(razorpayAdapter.verifyWebhook(body, new Headers())).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a malformed signature rather than throwing", () => {
    // `timingSafeEqual` THROWS on differing buffer lengths. Without the
    // shape check first, a short signature would produce a 500 — which
    // makes the provider retry forever and looks like an outage.
    for (const bad of ["", "abc", "zz".repeat(32), "0".repeat(63), "0".repeat(65)]) {
      const result = razorpayAdapter.verifyWebhook(
        body,
        new Headers({ "x-razorpay-signature": bad }),
      );
      expect(result.ok, `"${bad.slice(0, 8)}…" should be rejected`).toBe(false);
    }
  });

  it("accepts an upper-case hex signature", () => {
    const headers = new Headers({
      "x-razorpay-signature": razorpaySignature(body).toUpperCase(),
    });
    expect(razorpayAdapter.verifyWebhook(body, headers)).toEqual({ ok: true });
  });

  it("reports missing_secret rather than passing when unconfigured", () => {
    // ⭐ The dangerous default. An adapter that returned ok:true when it
    // had no secret to check against would make the endpoint completely
    // open the moment someone forgot an environment variable.
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect(razorpayAdapter.verifyWebhook(body, razorpayHeaders(body))).toEqual({
      ok: false,
      reason: "missing_secret",
    });
    expect(razorpayAdapter.isConfigured()).toBe(false);
  });

  it("is sensitive to whitespace, proving the raw body is what is signed", () => {
    // If a handler ever did JSON.parse → JSON.stringify before verifying,
    // this is the failure it would cause on every single webhook.
    const reSerialized = JSON.stringify(JSON.parse(body));
    const spaced = JSON.stringify(JSON.parse(body), null, 2);
    expect(razorpayAdapter.verifyWebhook(reSerialized, razorpayHeaders(body)).ok).toBe(true);
    expect(razorpayAdapter.verifyWebhook(spaced, razorpayHeaders(body)).ok).toBe(false);
  });
});

/* ================================================================== */
/* STRIPE SIGNATURES                                                   */
/* ================================================================== */

function stripeHeader(
  body: string,
  opts: { timestamp?: number; secret?: string; extraV1?: string } = {},
): Headers {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = opts.secret ?? STRIPE_SECRET;
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  const parts = [`t=${timestamp}`, `v1=${signature}`];
  if (opts.extraV1) parts.push(`v1=${opts.extraV1}`);
  return new Headers({ "stripe-signature": parts.join(",") });
}

describe("Stripe webhook signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });

  it("accepts a correctly signed body", () => {
    expect(stripeAdapter.verifyWebhook(body, stripeHeader(body))).toEqual({ ok: true });
  });

  it("signs `timestamp.body`, not the body alone", () => {
    // The separator prevents a body starting with digits from being split
    // differently against another timestamp to yield the same signed string.
    const bare = createHmac("sha256", STRIPE_SECRET).update(body, "utf8").digest("hex");
    const headers = new Headers({
      "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${bare}`,
    });
    expect(stripeAdapter.verifyWebhook(body, headers)).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("⭐ rejects a REPLAYED request once the tolerance has passed", () => {
    // A perfectly valid signature from six minutes ago. This is the check
    // Razorpay's scheme cannot offer, which is why that provider's replay
    // defence rests entirely on the database unique index.
    const stale = Math.floor(Date.now() / 1000) - (__stripeInternals.TIMESTAMP_TOLERANCE_SECONDS + 60);
    expect(stripeAdapter.verifyWebhook(body, stripeHeader(body, { timestamp: stale }))).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  it("accepts a timestamp just inside the tolerance", () => {
    const recent = Math.floor(Date.now() / 1000) - (__stripeInternals.TIMESTAMP_TOLERANCE_SECONDS - 30);
    expect(stripeAdapter.verifyWebhook(body, stripeHeader(body, { timestamp: recent }))).toEqual({
      ok: true,
    });
  });

  it("rejects a timestamp from the FUTURE", () => {
    // Without an absolute-value comparison, a far-future timestamp would
    // stay valid indefinitely — a replay window of years.
    const future = Math.floor(Date.now() / 1000) + 86_400;
    expect(stripeAdapter.verifyWebhook(body, stripeHeader(body, { timestamp: future }))).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  it("accepts MULTIPLE v1 signatures, as sent during a secret rotation", () => {
    // Taking only the first v1 would reject every webhook for the whole
    // duration of a rotation.
    const headers = stripeHeader(body, { extraV1: "a".repeat(64) });
    expect(stripeAdapter.verifyWebhook(body, headers)).toEqual({ ok: true });

    // And the same in the other order — the real signature second.
    const timestamp = Math.floor(Date.now() / 1000);
    const real = createHmac("sha256", STRIPE_SECRET)
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");
    const reordered = new Headers({
      "stripe-signature": `t=${timestamp},v1=${"b".repeat(64)},v1=${real}`,
    });
    expect(stripeAdapter.verifyWebhook(body, reordered)).toEqual({ ok: true });
  });

  it("rejects malformed headers rather than throwing", () => {
    for (const bad of [
      "",
      "garbage",
      "t=abc,v1=" + "0".repeat(64),
      "v1=" + "0".repeat(64), // no timestamp
      `t=${Math.floor(Date.now() / 1000)}`, // no signature
      `t=${Math.floor(Date.now() / 1000)},v1=short`,
    ]) {
      const result = stripeAdapter.verifyWebhook(
        body,
        new Headers({ "stripe-signature": bad }),
      );
      expect(result.ok, `"${bad}" should be rejected`).toBe(false);
    }
  });

  it("reports missing_secret rather than passing when unconfigured", () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(stripeAdapter.verifyWebhook(body, stripeHeader(body))).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });
});

/* ================================================================== */
/* THE MANUAL ADAPTER MUST NEVER VERIFY ANYTHING                       */
/* ================================================================== */

describe("manual adapter", () => {
  it("⭐ NEVER accepts a webhook, under any input", () => {
    // If this ever returned ok:true, anyone able to reach a webhook route
    // with provider=manual could mark any invoice paid.
    for (const body of ["", "{}", JSON.stringify({ amount: 1 })]) {
      expect(manualAdapter.verifyWebhook(body, new Headers()).ok).toBe(false);
      expect(manualAdapter.verifyWebhook(body, new Headers({ "x-anything": "y" })).ok).toBe(
        false,
      );
    }
  });

  it("normalises nothing", () => {
    expect(manualAdapter.normalizeEvent({ event: "payment.captured" })).toBeNull();
  });

  it("refuses to create a checkout rather than returning an empty session", () => {
    // A silent empty session would grant an unpaid subscription.
    return expect(
      manualAdapter.createSubscription({
        tenantId: "t",
        providerPlanId: "p",
        customerEmail: "a@b.c",
        customerName: "X",
        seats: 1,
        trialEndsAt: null,
        successUrl: "/",
        cancelUrl: "/",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/administrator/i);
  });
});

/* ================================================================== */
/* EVENT NORMALISATION                                                 */
/* ================================================================== */

describe("Razorpay event normalisation", () => {
  it("extracts ids, amount and tenant hint from a real-shaped payload", () => {
    const event = razorpayAdapter.normalizeEvent({
      entity: "event",
      event: "subscription.charged",
      created_at: 1_785_000_000,
      payload: {
        subscription: {
          entity: {
            id: "sub_ABC123",
            customer_id: "cust_XYZ",
            status: "active",
            current_start: 1_785_000_000,
            current_end: 1_787_678_400,
            notes: { tenant_id: "11111111-1111-4111-8111-111111111111" },
          },
        },
        payment: {
          entity: { id: "pay_999", amount: 499900, currency: "INR", status: "captured" },
        },
      },
    });

    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("subscription_renewed");
    expect(event!.providerSubscriptionId).toBe("sub_ABC123");
    expect(event!.providerPaymentId).toBe("pay_999");
    expect(event!.tenantIdHint).toBe("11111111-1111-4111-8111-111111111111");
    // ⚠️ 499900 paise, NOT 4999 rupees. Any `/100` here is a 100× error.
    expect(event!.amountMinor).toBe(499900n);
    expect(event!.currency).toBe("INR");
    expect(event!.occurredAt?.toISOString()).toBe(new Date(1_785_000_000_000).toISOString());
  });

  it("maps an UNKNOWN event to `unmapped` instead of guessing", () => {
    // A new provider event containing the word "failed" must not be
    // pattern-matched into dunning.
    const event = razorpayAdapter.normalizeEvent({
      event: "payment.downtime.started",
      payload: { payment: { entity: { id: "pay_1", failed: true } } },
    });
    expect(event!.eventType).toBe("unmapped");
    expect(event!.providerEventName).toBe("payment.downtime.started");
  });

  it("produces a DETERMINISTIC id when the payload carries none", () => {
    // ⭐ A fallback that varied between two deliveries of the same event
    // would defeat the unique index and permit a double charge.
    const payload = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_777", created_at: 1_785_000_000 } } },
    };
    const first = razorpayAdapter.normalizeEvent(payload);
    const second = razorpayAdapter.normalizeEvent(JSON.parse(JSON.stringify(payload)));
    expect(first!.providerEventId).toBe(second!.providerEventId);
    expect(first!.providerEventId).toContain("pay_777");
  });

  it("returns null rather than throwing on rubbish", () => {
    // A throw inside a webhook handler is a 500, and a 500 is an infinite
    // provider retry loop for an event that will never parse.
    for (const rubbish of [null, undefined, 42, "string", [], {}, { event: 5 }]) {
      expect(() => razorpayAdapter.normalizeEvent(rubbish)).not.toThrow();
    }
    expect(razorpayAdapter.normalizeEvent({})).toBeNull();
  });

  it("ignores an out-of-range timestamp instead of storing a nonsense date", () => {
    // Milliseconds passed where seconds were expected would be year 56000
    // and would poison the monotonic ordering guard forever.
    const event = razorpayAdapter.normalizeEvent({
      event: "payment.captured",
      created_at: 1_785_000_000_000, // ms, not s
      payload: { payment: { entity: { id: "pay_1" } } },
    });
    expect(event!.occurredAt).toBeNull();
  });
});

describe("Stripe event normalisation", () => {
  it("extracts ids and metadata from a subscription event", () => {
    const event = stripeAdapter.normalizeEvent({
      id: "evt_abc",
      type: "customer.subscription.updated",
      created: 1_785_000_000,
      data: {
        object: {
          id: "sub_stripe_1",
          object: "subscription",
          customer: "cus_1",
          status: "past_due",
          current_period_start: 1_785_000_000,
          current_period_end: 1_787_678_400,
          metadata: { tenant_id: "22222222-2222-4222-8222-222222222222" },
        },
      },
    });

    expect(event!.providerEventId).toBe("evt_abc");
    expect(event!.eventType).toBe("subscription_updated");
    expect(event!.providerSubscriptionId).toBe("sub_stripe_1");
    expect(event!.providerStatus).toBe("past_due");
    expect(event!.tenantIdHint).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("prefers amount_paid over amount_due on an invoice", () => {
    // Recording the billed figure on a PARTIAL payment would overstate
    // revenue in the permanent event log.
    const event = stripeAdapter.normalizeEvent({
      id: "evt_inv",
      type: "invoice.paid",
      created: 1_785_000_000,
      data: {
        object: {
          id: "in_1",
          object: "invoice",
          subscription: "sub_1",
          amount_due: 500000,
          amount_paid: 250000,
          currency: "inr",
        },
      },
    });
    expect(event!.amountMinor).toBe(250000n);
    expect(event!.currency).toBe("INR");
  });

  it("returns null on a payload with no id or type", () => {
    expect(stripeAdapter.normalizeEvent({ data: {} })).toBeNull();
    expect(stripeAdapter.normalizeEvent({ id: "evt_1" })).toBeNull();
  });
});

/* ================================================================== */
/* REDACTION                                                           */
/* ================================================================== */

describe("payload redaction", () => {
  it("removes values under sensitive keys", () => {
    const result = redactPayloadObject({
      card: { number: "4111111111111111", cvv: "123", last4: "1111", network: "Visa" },
    });
    const card = (result.card ?? {}) as Record<string, unknown>;
    expect(card.number).toBe("[redacted]");
    expect(card.cvv).toBe("[redacted]");
    // Kept — needed to render "Visa ending 1111" and not sensitive.
    expect(card.last4).toBe("1111");
    expect(card.network).toBe("Visa");
  });

  it("keeps token_id, because renewals break without it", () => {
    const result = redactPayloadObject({ token_id: "token_ABC123", secret: "shh" });
    expect(result.token_id).toBe("token_ABC123");
    expect(result.secret).toBe("[redacted]");
  });

  it("catches a card number in a free-text field by Luhn", () => {
    const result = redactPayloadObject({
      description: "customer said card 4111111111111111 was declined",
    });
    expect(result.description).not.toContain("4111111111111111");
    expect(result.description).toContain("[redacted]");
  });

  it("does NOT redact long numbers that fail Luhn", () => {
    // An over-eager redactor that ate provider reference ids would destroy
    // the forensic value of the very log it is protecting.
    const result = redactPayloadObject({ reference: "1234567890123456" });
    expect(result.reference).toBe("1234567890123456");
  });

  it("does not mutate its input", () => {
    // The caller still needs the original to verify against.
    const input = { cvv: "123" };
    redactPayload(input);
    expect(input.cvv).toBe("123");
  });

  it("survives a cyclic object instead of blowing the stack", () => {
    // A stack overflow here is a 500 inside a webhook handler, which is an
    // infinite retry loop.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redactPayload(cyclic)).not.toThrow();
  });
});

/* ================================================================== */
/* THE SUBSCRIPTION STATE MACHINE                                      */
/* ================================================================== */

const PERIOD_END = new Date("2026-08-01T00:00:00Z");

function baseState(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    status: "active",
    currentPeriodEnd: PERIOD_END,
    interval: "monthly",
    failedPaymentCount: 0,
    providerSubscriptionId: "sub_existing",
    providerCustomerId: "cus_existing",
    ...overrides,
  };
}

function evt(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: "razorpay",
    providerEventId: "evt_1",
    providerEventName: "test.event",
    eventType: "payment_succeeded",
    occurredAt: new Date("2026-07-15T00:00:00Z"),
    payload: {},
    ...overrides,
  };
}

describe("shouldApply — the out-of-order guard", () => {
  it("applies a newer event", () => {
    expect(
      shouldApply(new Date("2026-07-15T10:02:00Z"), new Date("2026-07-15T10:00:00Z")),
    ).toBe(true);
  });

  it("⭐ REFUSES an older event, so a retried failure cannot undo a success", () => {
    // The exact scenario: payment_failed at 10:00 is retried at 10:05,
    // after payment_succeeded at 10:02 has already been applied.
    expect(
      shouldApply(new Date("2026-07-15T10:00:00Z"), new Date("2026-07-15T10:02:00Z")),
    ).toBe(false);
  });

  it("applies an event with the same timestamp", () => {
    const when = new Date("2026-07-15T10:00:00Z");
    expect(shouldApply(when, when)).toBe(true);
  });

  it("applies when either side is unknown", () => {
    expect(shouldApply(null, new Date())).toBe(true);
    expect(shouldApply(new Date(), null)).toBe(true);
  });
});

describe("buildSubscriptionPatch — payment success", () => {
  it("activates and clears all dunning state", () => {
    const patch = buildSubscriptionPatch(
      evt({ eventType: "payment_succeeded" }),
      baseState({ status: "past_due", failedPaymentCount: 3 }),
    );
    expect(patch.status).toBe("active");
    expect(patch.failedPaymentCount).toBe(0);
    expect(patch.lastPaymentFailedAt).toBeNull();
    expect(patch.graceEndsAt).toBeNull();
  });

  it("⭐ advances the period from the PREVIOUS END, not from now", () => {
    // A renewal processed three days late must not gift three free days
    // and permanently drift the customer's billing anchor.
    const patch = buildSubscriptionPatch(
      evt({ eventType: "subscription_renewed", occurredAt: new Date("2026-08-04T00:00:00Z") }),
      baseState({ currentPeriodEnd: PERIOD_END }),
    );
    expect(patch.currentPeriodStart?.toISOString()).toBe(PERIOD_END.toISOString());
    expect(patch.currentPeriodEnd?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("prefers the provider's own period boundaries when they are present", () => {
    const patch = buildSubscriptionPatch(
      evt({
        eventType: "subscription_renewed",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-05T00:00:00Z"),
      }),
      baseState(),
    );
    expect(patch.currentPeriodEnd?.toISOString()).toBe("2026-09-05T00:00:00.000Z");
  });

  it("ignores provider boundaries that are inverted", () => {
    const patch = buildSubscriptionPatch(
      evt({
        eventType: "subscription_renewed",
        periodStart: new Date("2026-09-05T00:00:00Z"),
        periodEnd: new Date("2026-08-01T00:00:00Z"),
      }),
      baseState(),
    );
    // Falls back to our own arithmetic rather than storing a period that
    // ends before it starts — which the CHECK constraint would reject.
    expect(patch.currentPeriodEnd?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("does NOT advance the period on a bare payment_succeeded", () => {
    // A one-off payment is not a renewal. Advancing on both would double
    // the period on providers that send each event separately.
    const patch = buildSubscriptionPatch(
      evt({ eventType: "payment_succeeded" }),
      baseState(),
    );
    expect(patch.currentPeriodEnd).toBeUndefined();
  });
});

describe("buildSubscriptionPatch — dunning", () => {
  it("first failure goes to past_due, which still grants access", () => {
    const patch = buildSubscriptionPatch(
      evt({ eventType: "payment_failed" }),
      baseState({ failedPaymentCount: 0 }),
    );
    expect(patch.status).toBe("past_due");
    expect(patch.failedPaymentCount).toBe(1);
    expect(patch.graceEndsAt).toBeInstanceOf(Date);
  });

  it("escalates to unpaid only after the attempts are exhausted", () => {
    for (let attempts = 0; attempts < MAX_DUNNING_ATTEMPTS - 1; attempts += 1) {
      const patch = buildSubscriptionPatch(
        evt({ eventType: "payment_failed" }),
        baseState({ failedPaymentCount: attempts }),
      );
      expect(patch.status, `after ${attempts + 1} failures`).toBe("past_due");
    }
    const final = buildSubscriptionPatch(
      evt({ eventType: "payment_failed" }),
      baseState({ failedPaymentCount: MAX_DUNNING_ATTEMPTS - 1 }),
    );
    expect(final.status).toBe("unpaid");
  });

  it("sets the grace window the documented number of days out", () => {
    const occurredAt = new Date("2026-07-15T00:00:00Z");
    const patch = buildSubscriptionPatch(
      evt({ eventType: "payment_failed", occurredAt }),
      baseState(),
    );
    const expected = occurredAt.getTime() + DUNNING_GRACE_DAYS * 86_400_000;
    expect(patch.graceEndsAt?.getTime()).toBe(expected);
  });

  it("⭐ does NOT drag a CANCELLED subscription back into dunning", () => {
    // A late failure webhook arriving after cancellation would otherwise
    // start dunning emails at someone who has already left.
    for (const status of ["cancelled", "expired"] as const) {
      const patch = buildSubscriptionPatch(
        evt({ eventType: "payment_failed" }),
        baseState({ status }),
      );
      expect(patch.status, status).toBeUndefined();
      expect(patch.failedPaymentCount).toBeUndefined();
    }
  });
});

describe("buildSubscriptionPatch — cancellation and refunds", () => {
  it("cancels at period end, preserving paid-for time", () => {
    const patch = buildSubscriptionPatch(
      evt({ eventType: "subscription_cancelled" }),
      baseState(),
    );
    expect(patch.status).toBe("cancelled");
    expect(patch.cancelAtPeriodEnd).toBe(true);
    expect(patch.cancelledAt).toBeInstanceOf(Date);
  });

  it("⭐ a REFUND does not revoke access", () => {
    // Refunds are partial, goodwill, or a duplicate charge being returned.
    // None of those mean the customer stopped being a customer.
    const patch = buildSubscriptionPatch(
      evt({ eventType: "payment_refunded" }),
      baseState(),
    );
    expect(patch.status).toBeUndefined();
  });

  it("⭐ a DISPUTE does not revoke access either", () => {
    // A dispute is a claim, not a verdict.
    const patch = buildSubscriptionPatch(evt({ eventType: "dispute_opened" }), baseState());
    expect(patch.status).toBeUndefined();
  });
});

describe("buildSubscriptionPatch — provider ids", () => {
  it("backfills ids the first time they are seen", () => {
    const patch = buildSubscriptionPatch(
      evt({ providerSubscriptionId: "sub_new", providerCustomerId: "cus_new" }),
      baseState({ providerSubscriptionId: null, providerCustomerId: null }),
    );
    expect(patch.providerSubscriptionId).toBe("sub_new");
    expect(patch.providerCustomerId).toBe("cus_new");
  });

  it("⭐ NEVER overwrites an existing provider id", () => {
    // A subscription whose provider id changed would silently detach from
    // its own billing history at the provider.
    const patch = buildSubscriptionPatch(
      evt({ providerSubscriptionId: "sub_different" }),
      baseState({ providerSubscriptionId: "sub_existing" }),
    );
    expect(patch.providerSubscriptionId).toBeUndefined();
  });
});

describe("mapProviderStatus", () => {
  it("maps both providers' vocabularies", () => {
    expect(mapProviderStatus("active")).toBe("active");
    expect(mapProviderStatus("halted")).toBe("past_due"); // Razorpay
    expect(mapProviderStatus("past_due")).toBe("past_due"); // Stripe
    expect(mapProviderStatus("canceled")).toBe("cancelled"); // Stripe's one L
    expect(mapProviderStatus("cancelled")).toBe("cancelled"); // Razorpay's two
    expect(mapProviderStatus("incomplete_expired")).toBe("expired");
  });

  it("⭐ returns null for anything unrecognised", () => {
    // A default of "cancelled" would let a provider's new status string in
    // a minor release revoke a paying customer's access.
    for (const unknown of ["", "brand_new_status", "ACTIVE_PENDING", "deleted"]) {
      expect(mapProviderStatus(unknown), unknown).toBeNull();
    }
    expect(mapProviderStatus(null)).toBeNull();
    expect(mapProviderStatus(undefined)).toBeNull();
  });

  it("leaves the status alone when the provider status is unmapped", () => {
    const patch = buildSubscriptionPatch(
      evt({ eventType: "subscription_updated", providerStatus: "some_new_thing" }),
      baseState({ status: "active" }),
    );
    expect(patch.status).toBeUndefined();
  });
});

/* ================================================================== */
/* SOURCE-LEVEL GUARDS                                                 */
/* ================================================================== */

describe("webhook handlers follow the verify-before-parse rule", () => {
  for (const provider of ["razorpay", "stripe"]) {
    it(`${provider}: reads the RAW body and never request.json()`, () => {
      const source = readFileSync(
        join(process.cwd(), `app/api/webhooks/${provider}/route.ts`),
        "utf8",
      );
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

      // request.json() would parse BEFORE verifying, and the re-serialised
      // object does not produce the same HMAC.
      expect(code).not.toMatch(/request\.json\(\)/);
      expect(code).toMatch(/request\.text\(\)/);

      // The verification call must appear before the JSON.parse call.
      const verifyAt = code.indexOf("verifyWebhook");
      const parseAt = code.indexOf("JSON.parse");
      expect(verifyAt).toBeGreaterThan(-1);
      expect(parseAt).toBeGreaterThan(verifyAt);
    });

    it(`${provider}: pins the Node runtime, which timingSafeEqual requires`, () => {
      const source = readFileSync(
        join(process.cwd(), `app/api/webhooks/${provider}/route.ts`),
        "utf8",
      );
      expect(source).toMatch(/export const runtime = "nodejs"/);
    });
  }
});

describe("adapters use constant-time comparison", () => {
  for (const provider of ["razorpay", "stripe"]) {
    it(`${provider}: uses timingSafeEqual, never === on a signature`, () => {
      const source = readFileSync(
        join(process.cwd(), `lib/billing/providers/${provider}.ts`),
        "utf8",
      );
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

      expect(code).toMatch(/timingSafeEqual/);
      // A string comparison short-circuits at the first differing byte,
      // leaking how many leading characters were correct.
      expect(code).not.toMatch(/expected\s*===\s*/);
      expect(code).not.toMatch(/===\s*expected/);
    });
  }
});
