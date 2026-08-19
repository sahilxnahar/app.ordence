/**
 * Ordence — Razorpay Webhook Endpoint
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS ROUTE IS PUBLIC AND UNAUTHENTICATED. THE HMAC IS THE AUTH.
 * ══════════════════════════════════════════════════════════════════════
 * It must be listed in `middleware.ts` as a public route, because Clerk
 * would otherwise 401 a server-to-server call that carries no session
 * cookie — and the provider would read that 401 as a failure and retry
 * forever. (That is exactly the mistake made with the Blob
 * `onUploadCompleted` callback in Phase 8, which is why it was removed
 * rather than shipped broken.)
 *
 * Being public means the signature check is the ONLY thing between the
 * internet and our subscription state. It runs before anything else
 * touches the payload, and nothing downstream re-parses the raw body.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR RULES THIS HANDLER FOLLOWS
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. READ THE RAW BODY, ONCE, AS TEXT.
 *    `request.json()` would parse before verifying, and the re-serialised
 *    object does not produce the same HMAC — different key order,
 *    different whitespace, different unicode escaping. Every legitimate
 *    webhook would fail. `request.text()` and nothing else.
 *
 * 2. VERIFY BEFORE PARSING.
 *    An unverified payload is attacker-controlled input. It is not parsed,
 *    not logged in full, and not written anywhere until the HMAC passes.
 *
 * 3. RESPOND WITH ALMOST NOTHING.
 *    `{ received: true }` or a bare status. No error detail, no stack, no
 *    indication of which check failed. A 401 that says "bad signature" and
 *    a 401 that says "stale timestamp" are two free bits for an attacker.
 *
 * 4. ACKNOWLEDGE UNLESS A RETRY WOULD HELP.
 *    Duplicate, unmapped, unknown tenant, malformed → 200. Only a genuine
 *    transient failure on our side returns 500, because only that will
 *    succeed on the retry the 500 provokes.
 */

import { NextResponse } from "next/server";
import { razorpayAdapter } from "@/lib/billing/providers/razorpay";
import { reconcileEvent } from "@/server/billing/reconcile";
import {
  checkRateLimit,
  webhookRateLimitKey,
  rateLimitBody,
  rateLimitHeaders,
} from "@/lib/security/rate-limit";
import { recordRateLimitTrip, recordSecurityEvent } from "@/server/security/record";

/**
 * ⚠️ NODE RUNTIME IS MANDATORY, NOT A PREFERENCE.
 * `node:crypto`'s `timingSafeEqual` does not exist on the Edge runtime.
 * On Edge this route would fail to build — or worse, fall back to a
 * variable-time comparison.
 */
export const runtime = "nodejs";

/**
 * Never cached, never statically analysed into a build-time value. A
 * cached webhook response would acknowledge events that were never
 * processed.
 */
export const dynamic = "force-dynamic";

/**
 * Razorpay's own webhook event id header. Preferred over anything dug out
 * of the payload because it is guaranteed stable across retries of the
 * same event — which is precisely the property an idempotency key needs.
 */
const EVENT_ID_HEADER = "x-razorpay-event-id";

export async function POST(request: Request): Promise<NextResponse> {
  /* ---- 1. Raw body, exactly as sent ----------------------------- */

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    // Truncated upload or a client that hung up. Retryable.
    return NextResponse.json({ received: false }, { status: 500 });
  }

  // A body large enough to be a denial-of-service attempt rather than a
  // webhook. Razorpay payloads are single-digit kilobytes; 1 MB is three
  // orders of magnitude of headroom and still bounded.
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
  // payments. It sits far above anything Razorpay would ever send.
  const sourceIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const rl = await checkRateLimit("webhook", webhookRateLimitKey("razorpay", sourceIp));
  if (!rl.allowed) {
    await recordRateLimitTrip({
      policy: "webhook",
      source: "api/webhooks/razorpay",
      ipAddress: sourceIp,
      route: "/api/webhooks/razorpay",
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

  /* ---- 2. Verify BEFORE parsing --------------------------------- */

  const verification = razorpayAdapter.verifyWebhook(rawBody, request.headers);

  if (!verification.ok) {
    // Logged server-side with the reason; the RESPONSE carries none of it.
    console.warn(
      `[billing] Razorpay webhook rejected: ${verification.reason}`,
    );

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
      source: "api/webhooks/razorpay",
      tenantId: null,
      ipAddress: sourceIp,
      route: "/api/webhooks/razorpay",
      detail: { provider: "razorpay", reason: verification.reason },
      reason: "Webhook signature verification failed.",
    });

    // 401 for an authenticity failure. 503 when WE are misconfigured —
    // that is our fault, a retry after the secret is set will succeed,
    // and it should not look like the provider did anything wrong.
    const status = verification.reason === "missing_secret" ? 503 : 401;
    return NextResponse.json({ received: false }, { status });
  }

  /* ---- 3. Parse (now trusted) ----------------------------------- */

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Signed by us-and-them, yet not JSON. Bizarre, but not retryable:
    // it will never parse. Acknowledge so Razorpay stops.
    console.error("[billing] Razorpay webhook passed HMAC but was not valid JSON.");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const event = razorpayAdapter.normalizeEvent(parsed);
  if (!event) {
    console.error("[billing] Razorpay webhook could not be normalised. Acknowledged.");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  /**
   * Prefer the header event id. `normalizeEvent` has already produced a
   * deterministic fallback, but the header is the provider's own
   * canonical id and is stable across retries by contract.
   */
  const headerEventId = request.headers.get(EVENT_ID_HEADER);
  const finalEvent = headerEventId
    ? { ...event, providerEventId: headerEventId }
    : event;

  /* ---- 4. Reconcile --------------------------------------------- */

  try {
    const outcome = await reconcileEvent(finalEvent);

    console.info(
      `[billing] razorpay ${finalEvent.providerEventName} → ${outcome.status}: ${outcome.detail}`,
    );

    return NextResponse.json(
      { received: true },
      { status: outcome.acknowledge ? 200 : 500 },
    );
  } catch (error) {
    // reconcileEvent is written not to throw, so reaching here means
    // something genuinely unexpected. Retryable by default — losing a
    // payment event is worse than processing one twice, and the unique
    // index makes the second attempt safe.
    console.error(
      "[billing] Razorpay reconciliation threw unexpectedly:",
      error instanceof Error ? error.message : "unknown",
    );
    return NextResponse.json({ received: false }, { status: 500 });
  }
}

/**
 * Explicit 405 for every other verb.
 *
 * Without this, Next.js returns its own 405 — which is fine — but an
 * explicit handler means a GET to this URL from a browser or a scanner
 * produces a deliberate, body-less response rather than a framework page
 * that might reveal the route exists and what it is called.
 */
export async function GET(): Promise<NextResponse> {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
