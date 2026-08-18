import "server-only";

/**
 * Ordence — Resend delivery webhook. THE IMPLEMENTATION.
 * Version: v1.54.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY AN UNVERIFIED WEBHOOK HERE WOULD BE A WEAPON
 * ══════════════════════════════════════════════════════════════════════
 * This endpoint SUPPRESSES EMAIL ADDRESSES. Permanently, for every
 * tenant, without a human in the loop — which is exactly what makes
 * suppression work and exactly what makes it dangerous.
 *
 * An unauthenticated version of this route lets anybody on the internet
 * POST `{"type":"email.bounced","data":{"to":["ceo@their-biggest-
 * customer.com"]}}` and silence a real business's mail to a real
 * customer. It is a denial of service on somebody else's collections,
 * costing one curl.
 *
 * ⚠️ SO THE SIGNATURE IS THE AUTHENTICATION, AND IT IS THE ONLY ONE.
 * There is no session cookie on a server-to-server call, and Clerk would
 * 401 it — which the provider would read as a failure and retry forever.
 * `middleware.ts` lists `/api/webhooks(.*)` as public precisely so this
 * file, not Clerk, is the gate.
 *
 * ⭐ AND IF THE SECRET IS ABSENT, THE ROUTE REFUSES EVERYTHING. Not
 * "verify when configured" — a webhook that degrades to trusting its
 * input when a variable is missing is a webhook that is unauthenticated
 * on exactly the day somebody forgets to set it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE RULES THIS HANDLER FOLLOWS — the same four as the Razorpay one
 * ══════════════════════════════════════════════════════════════════════
 * 1. READ THE RAW BODY, ONCE, AS TEXT. `request.json()` parses before
 *    verifying and the re-serialised object does not produce the same
 *    signature — different key order, different unicode escaping.
 * 2. VERIFY BEFORE PARSING. An unverified payload is attacker-controlled
 *    input and is not written anywhere until the signature passes.
 * 3. RESPOND WITH ALMOST NOTHING. A 401 that says "bad signature" and a
 *    401 that says "stale timestamp" are two free bits for an attacker.
 * 4. ACKNOWLEDGE UNLESS A RETRY WOULD HELP. Unknown event, unmatched
 *    message id, malformed body → 200, because the provider retrying
 *    cannot fix any of them.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { Webhook } from "svix";
import { recordDeliveryEvent } from "@/server/email/outbox";
import { bounceIsPermanent } from "@/lib/email/outbox";

/* ------------------------------------------------------------------ */
/* PAYLOAD READING — TOTAL, NEVER THROWS                               */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * ⚠️ EVERY FIELD IS READ DEFENSIVELY EVEN THOUGH THE SIGNATURE PASSED.
 * A verified payload proves it came from Resend; it does not promise the
 * shape this code was written against. Providers add fields, rename them
 * and change nesting, and a `payload.data.email_id.toLowerCase()` on a
 * shape that moved is a 500 that makes the provider retry forever.
 */
function readEvent(payload: unknown): {
  type: string;
  messageId: string;
  bounceType: unknown;
  detail: string | null;
} | null {
  const root = asRecord(payload);
  if (!root) return null;

  const type = typeof root["type"] === "string" ? root["type"] : "";
  if (!type) return null;

  const data = asRecord(root["data"]);
  const rawId = data?.["email_id"];
  const messageId = typeof rawId === "string" ? rawId : "";

  const bounce = asRecord(data?.["bounce"]);
  const bounceType = bounce?.["type"];

  const messageParts = [
    typeof bounce?.["subType"] === "string" ? bounce["subType"] : null,
    typeof bounce?.["message"] === "string" ? bounce["message"] : null,
  ].filter((part): part is string => Boolean(part));

  return {
    type,
    messageId,
    bounceType,
    detail: messageParts.length > 0 ? messageParts.join(" — ") : null,
  };
}

/* ------------------------------------------------------------------ */
/* THE HANDLER                                                         */
/* ------------------------------------------------------------------ */

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  /*
   * 🔴 FAIL CLOSED. Without a secret this handler cannot tell Resend from
   * anybody else, and the one thing it does is take addresses out of
   * service. 503 tells the provider to retry later, which is the truth:
   * the endpoint is not ready, and the events are not lost.
   */
  if (!secret) {
    console.error(
      "[resend-webhook] refused — RESEND_WEBHOOK_SECRET is not set. Bounce and complaint handling is OFF, so suppression will not happen automatically.",
    );
    return new NextResponse(null, { status: 503 });
  }

  const headerList = await headers();
  const svixId = headerList.get("svix-id");
  const svixTimestamp = headerList.get("svix-timestamp");
  const svixSignature = headerList.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new NextResponse(null, { status: 401 });
  }

  // Rule 1: raw text, once, before anything parses it.
  const raw = await request.text();

  let payload: unknown;
  try {
    // Rule 2: verify, then parse. `svix` throws on a bad signature and on
    // a timestamp outside its tolerance window, which is the replay
    // defence — a captured delivery cannot be resent tomorrow.
    payload = new Webhook(secret).verify(raw, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch {
    // Rule 3: no detail. Which check failed is not the sender's business.
    return new NextResponse(null, { status: 401 });
  }

  const event = readEvent(payload);
  if (!event || !event.messageId) {
    // Rule 4: a retry cannot fix a shape we do not understand.
    return NextResponse.json({ received: true });
  }

  /*
   * ⚠️ ONLY THREE EVENT TYPES ARE ACTED ON, AND `email.delivered` IS HERE
   * ONLY TO RECORD, NEVER TO SUPPRESS. Resend also emits `sent`,
   * `opened`, `clicked` and `delivery_delayed`; a handler that treated an
   * unrecognised type as a failure would suppress an address on an open.
   */
  const kind =
    event.type === "email.bounced"
      ? "bounced"
      : event.type === "email.complained"
        ? "complained"
        : event.type === "email.delivered"
          ? "delivered"
          : null;

  if (!kind) return NextResponse.json({ received: true });

  try {
    const outcome = await recordDeliveryEvent({
      providerMessageId: event.messageId,
      event: kind,
      detail: event.detail,
      /*
       * 🔴 A SOFT BOUNCE IS NOT A SUPPRESSION. "Mailbox full" and
       * "greylisted" are temporary, and suppressing on them would
       * permanently silence a customer whose inbox was briefly over
       * quota — a control that fires on the wrong signal is worse than
       * one that does not fire.
       */
      permanent: bounceIsPermanent(event.bounceType),
      at: new Date(),
    });

    if (outcome.suppressedEmail) {
      console.warn("[resend-webhook] address suppressed", {
        event: kind,
        // ⚠️ The address is logged because deliverability cannot be
        // investigated without it. Nothing else from the payload is.
        email: outcome.suppressedEmail,
      });
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    /*
     * ⚠️ THE ONLY 500 IN THIS FILE, AND IT IS DELIBERATE. A database
     * failure is the one thing a provider retry genuinely fixes. Every
     * other outcome above is a 200, because retrying them just produces
     * the same answer more expensively.
     */
    console.error("[resend-webhook] could not record the event", err);
    return new NextResponse(null, { status: 500 });
  }
}
