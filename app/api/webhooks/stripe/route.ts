/**
 * Ordence — Stripe Webhook Endpoint
 * Version: v0.11.0-alpha
 *
 * Structurally identical to the Razorpay endpoint — see that file for the
 * full reasoning behind raw-body reading, verify-before-parse, opaque
 * responses, and the acknowledge-unless-retryable rule.
 *
 * The one substantive difference: Stripe's signature carries a timestamp,
 * so a replayed request is rejected by `verifyWebhook` after five minutes
 * without ever reaching the database. Razorpay has no such field, and its
 * replay defence rests entirely on the unique index.
 */

import { NextResponse } from "next/server";
import { stripeAdapter } from "@/lib/billing/providers/stripe";
import { reconcileEvent } from "@/server/billing/reconcile";
import {
  checkRateLimit,
  webhookRateLimitKey,
  rateLimitBody,
  rateLimitHeaders,
} from "@/lib/security/rate-limit";
import { recordRateLimitTrip, recordSecurityEvent } from "@/server/security/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ received: false }, { status: 500 });
  }

  if (rawBody.length > 1_000_000) {
    return NextResponse.json({ received: false }, { status: 413 });
  }

  /* ---- 1b. Rate limit (SEC-024) --------------------------------- */
  //
  // ⚠️ DELIBERATELY AFTER THE SIZE CHECK AND BEFORE SIGNATURE VERIFICATION.
  //
  // After the size check, because a multi-megabyte body should be refused
  // on sight rather than counted against a budget. Before verification,
  // because computing an HMAC is the work an attacker is trying to make
  // us do for free — checking the limit afterwards would pay for exactly
  // what we are defending against.
  //
  // Keyed by SOURCE IP, never by the endpoint. An endpoint-wide counter
  // would let anyone starve the provider's budget and stop real payments
  // from being recorded.
  //
  // The ceiling (600/min) is a denial-of-service backstop, not a traffic
  // shaper. A provider retry storm is LEGITIMATE traffic — a genuine
  // outage produces a burst of redeliveries, and throttling those loses
  // payments. It sits far above anything Stripe would ever send.
  const sourceIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const rl = await checkRateLimit("webhook", webhookRateLimitKey("stripe", sourceIp));
  if (!rl.allowed) {
    await recordRateLimitTrip({
      policy: "webhook",
      source: "api/webhooks/stripe",
      ipAddress: sourceIp,
      route: "/api/webhooks/stripe",
      degraded: rl.degraded,
    });
    // Retry-After only. The body carries no detail: this endpoint is
    // public, and telling a caller which limit they hit is free
    // reconnaissance.
    return NextResponse.json(rateLimitBody(), {
      status: 429,
      headers: rateLimitHeaders(rl, { authenticated: false }),
    });
  }

  const verification = stripeAdapter.verifyWebhook(rawBody, request.headers);

  if (!verification.ok) {
    console.warn(`[billing] Stripe webhook rejected: ${verification.reason}`);

    /**
     * ⭐ THE HIGHEST-VALUE ROW IN `security_events`.
     *
     * A failed signature on a payment webhook is either our own
     * misconfiguration or somebody actively trying to forge a payment
     * notification. Both are worth knowing about within minutes, and
     * neither leaves a trace anywhere else — the response to the caller
     * is deliberately opaque, so without this row the attempt is
     * invisible.
     *
     * `tenantId: null` is unavoidable: an unverified payload cannot be
     * attributed to anyone, because attributing it would mean trusting
     * the very bytes that just failed authentication.
     */
    await recordSecurityEvent({
      type:
        verification.reason === "missing_secret"
          ? "webhook.secret_missing"
          : "webhook.signature_invalid",
      source: "api/webhooks/stripe",
      tenantId: null,
      ipAddress: sourceIp,
      route: "/api/webhooks/stripe",
      detail: { provider: "stripe", reason: verification.reason },
      reason: "Webhook signature verification failed.",
    });
    const status = verification.reason === "missing_secret" ? 503 : 401;
    return NextResponse.json({ received: false }, { status });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    console.error("[billing] Stripe webhook passed HMAC but was not valid JSON.");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const event = stripeAdapter.normalizeEvent(parsed);
  if (!event) {
    console.error("[billing] Stripe webhook could not be normalised. Acknowledged.");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  try {
    const outcome = await reconcileEvent(event);

    console.info(
      `[billing] stripe ${event.providerEventName} → ${outcome.status}: ${outcome.detail}`,
    );

    return NextResponse.json(
      { received: true },
      { status: outcome.acknowledge ? 200 : 500 },
    );
  } catch (error) {
    console.error(
      "[billing] Stripe reconciliation threw unexpectedly:",
      error instanceof Error ? error.message : "unknown",
    );
    return NextResponse.json({ received: false }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
