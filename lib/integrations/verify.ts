/**
 * Ordence — ⭐⭐⭐ DID THIS DELIVERY REALLY COME FROM WHO IT SAYS?
 * Version: v1.12.0-alpha
 *
 * `node:crypto` only, exactly as `lib/portal/tokens.ts` and the payment
 * adapters do. No database, no clock: `now` is always an argument.
 *
 * ⚠️ NODE RUNTIME ONLY. `timingSafeEqual` has no Edge equivalent, so any
 * route importing this must declare `export const runtime = "nodejs"`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A WEBHOOK ENDPOINT IS A PUBLIC URL THAT WRITES TO THE DATABASE
 * ══════════════════════════════════════════════════════════════════════
 * That is the whole of it. Anyone on the internet who finds the address
 * can post to it, and whatever they post becomes a lead, a message, or a
 * delivery receipt in somebody's account.
 *
 * ⚠️ THE ATTACK IS NOT THEORETICAL AND IT IS NOT CLEVER. It is a
 * competitor filling a rival's CRM with fake enquiries so the real ones
 * are never called back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FOUR SIGNATURE STATES, NOT A BOOLEAN
 * ══════════════════════════════════════════════════════════════════════
 *   `verified`     Signed and correct.
 *   `invalid`      Signed and WRONG. Kept, never acted on.
 *   `absent`       Signing expected, nothing offered.
 *   `not_required` The endpoint is unsigned by design.
 *
 * ⭐ THE LAST TWO ARE THE REASON THIS IS NOT A BOOLEAN. Collapse them
 * and an endpoint whose signing was accidentally switched off reads
 * exactly like an endpoint whose signature is passing. Every delivery
 * shows a tick. The one meaningful security control in the whole feature
 * disappears without a single error anywhere.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND JUSTDIAL SIGNS NOTHING AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Their integration is a plain GET to a URL. So for an unsigned
 * connector the ONLY defence is that the address cannot be guessed,
 * which is why 0064 refuses a path token under 32 characters at the
 * database level rather than trusting whatever generated it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/** Mirrors `webhook_endpoints.verification` in 0064. */
export type VerificationMethod =
  | "hmac_sha256"
  | "hmac_sha1"
  | "shared_token"
  | "none";

/** Mirrors `webhook_deliveries.signature_state` in 0064. */
export type SignatureState = "verified" | "invalid" | "absent" | "not_required";

/** Mirrors `webhook_deliveries.outcome` in 0064. */
export type DeliveryOutcome =
  | "received"
  | "processed"
  | "rejected"
  | "failed"
  | "ignored_replay";

/* ------------------------------------------------------------------ */
/* CONSTANT TIME                                                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 `a === b` ON A SIGNATURE IS A VULNERABILITY, not a style question.
 *
 * String comparison stops at the first differing character, so the time
 * it takes leaks how much of the guess was right. That is enough to
 * recover a signature one character at a time.
 *
 * ⚠️ `timingSafeEqual` THROWS on unequal lengths, which would leak the
 * length by throwing. So the length is checked first and the comparison
 * still runs, against a value of the right size, so that a wrong-length
 * signature costs the same as a wrong-value one.
 */
export function constantTimeEquals(
  expected: string,
  presented: string,
): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");

  if (a.length !== b.length) {
    // Burn the same work, then refuse.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* SIGNATURES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SIGNATURE IS OVER THE RAW BODY, byte for byte as it arrived.
 *
 * 🔴 `JSON.parse` then `JSON.stringify` reorders keys, drops whitespace
 * and changes number formatting. The signature then never matches and
 * the cause is invisible, because the parsed object looks identical to
 * the one the sender signed.
 */
export function computeSignature(
  method: VerificationMethod,
  secret: string,
  rawBody: string,
  timestamp?: string | null,
): string | null {
  if (method === "none" || method === "shared_token") return null;

  const algorithm = method === "hmac_sha1" ? "sha1" : "sha256";
  // ⭐ Where a timestamp is signed it is prefixed, exactly as Stripe and
  // Razorpay do, so that a captured signature cannot be replayed against
  // a different time.
  const material = timestamp ? `${timestamp}.${rawBody}` : rawBody;
  return createHmac(algorithm, secret).update(material, "utf8").digest("hex");
}

/**
 * Some senders prefix or wrap the value: `sha256=abc…`, `t=…,v1=…`.
 * Normalising here keeps that mess out of the comparison.
 */
export function normaliseSignatureHeader(value: string): string {
  const trimmed = value.trim();
  const eq = trimmed.lastIndexOf("=");
  if (eq >= 0 && eq < trimmed.length - 1) {
    const tail = trimmed.slice(eq + 1);
    if (/^[0-9a-fA-F]+$/.test(tail)) return tail.toLowerCase();
  }
  return trimmed.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* TIME                                                                */
/* ------------------------------------------------------------------ */

export interface TimestampVerdict {
  readonly withinTolerance: boolean;
  readonly reason: string | null;
  readonly skewSeconds: number | null;
}

/**
 * ⚠️ A TIMESTAMP IN THE FUTURE IS ALSO WRONG.
 *
 * 🔴 Checking only "not too old" is the standard mistake. A signature
 * dated a year ahead then passes forever, which is precisely the replay
 * the timestamp exists to prevent.
 */
export function timestampWithinTolerance(
  sentAt: Date | null,
  now: Date,
  toleranceSeconds: number,
): TimestampVerdict {
  if (!sentAt) {
    return {
      withinTolerance: false,
      reason: "The delivery carried no timestamp, so it cannot be checked for replay.",
      skewSeconds: null,
    };
  }
  if (Number.isNaN(sentAt.getTime())) {
    return {
      withinTolerance: false,
      reason: "The delivery's timestamp could not be read.",
      skewSeconds: null,
    };
  }

  const skewSeconds = Math.round((now.getTime() - sentAt.getTime()) / 1000);

  if (skewSeconds > toleranceSeconds) {
    return {
      withinTolerance: false,
      reason: `The delivery is ${skewSeconds} seconds old and this endpoint accepts up to ${toleranceSeconds}. An old delivery arriving now is usually one that was captured and sent again.`,
      skewSeconds,
    };
  }
  if (-skewSeconds > toleranceSeconds) {
    return {
      withinTolerance: false,
      reason: `The delivery is dated ${-skewSeconds} seconds in the future, which is beyond the ${toleranceSeconds} seconds of clock difference this endpoint allows.`,
      skewSeconds,
    };
  }

  return { withinTolerance: true, reason: null, skewSeconds };
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export interface EndpointSnapshot {
  readonly verification: VerificationMethod;
  readonly signatureHeader: string | null;
  readonly timestampToleranceSeconds: number;
  readonly isActive: boolean;
}

export interface DeliveryInput {
  /** The raw body exactly as received. Never a re-serialised object. */
  readonly rawBody: string;
  /** The signature the sender presented, if any. */
  readonly presentedSignature: string | null;
  /** The signed timestamp, if the sender sends one. */
  readonly sentAt?: Date | null;
  /** The sender's own id for this event, where it gives one. */
  readonly externalId?: string | null;
  /** 🔴 Whether we have already stored a delivery with this external id. */
  readonly alreadySeen?: boolean;
  /** The decrypted signing secret. Never logged, never returned. */
  readonly secret?: string | null;
}

export interface DeliveryVerdict {
  readonly signatureState: SignatureState;
  readonly isReplay: boolean;
  /** ⭐ The only field the caller should branch on before writing anything. */
  readonly mayProcess: boolean;
  readonly outcome: DeliveryOutcome;
  /**
   * 🔴 0064 REQUIRES this for `rejected` and `failed`, and refuses the
   * row without it. A rejection log whose rows say "rejected" answers
   * nothing at three in the morning.
   */
  readonly errorMessage: string | null;
}

/**
 * ⚠️ THE ORDER OF THESE CHECKS IS DELIBERATE AND NOT INTERCHANGEABLE.
 *
 * The signature is settled BEFORE the replay check, because the state
 * we record for a forged delivery should say "the signature was wrong",
 * not "we had seen that id before". Those are different incidents and
 * only one of them means somebody is probing the endpoint.
 */
export function assessDelivery(
  endpoint: EndpointSnapshot,
  input: DeliveryInput,
  now: Date,
): DeliveryVerdict {
  // ① A switched-off endpoint accepts nothing, but still keeps the row.
  if (!endpoint.isActive) {
    return {
      signatureState:
        endpoint.verification === "none" ? "not_required" : "absent",
      isReplay: false,
      mayProcess: false,
      outcome: "rejected",
      errorMessage:
        "This endpoint is switched off. The delivery was kept but not acted on.",
    };
  }

  // ② The signature.
  const signature = settleSignature(endpoint, input);

  // 🔴 A WRONG SIGNATURE IS NEVER PROCESSED, AND IS ALWAYS KEPT.
  //
  // ⚠️ Kept because an endpoint that suddenly starts receiving invalid
  // signatures is either a secret somebody rotated without telling us,
  // or somebody probing. Both are worth seeing. Neither is worth acting
  // on. 0064 enforces this in a CHECK constraint as well, because a
  // rule that matters twice should be written down twice.
  if (signature.state === "invalid") {
    return {
      signatureState: "invalid",
      isReplay: false,
      mayProcess: false,
      outcome: "rejected",
      errorMessage: signature.reason,
    };
  }
  if (signature.state === "absent") {
    return {
      signatureState: "absent",
      isReplay: false,
      mayProcess: false,
      outcome: "rejected",
      errorMessage: signature.reason,
    };
  }

  // ③ ⚠️ THE TIMESTAMP, EVEN WHEN THE SIGNATURE IS PERFECT.
  //
  // 🔴 A replayed request is correctly signed. That is what makes it a
  // replay rather than a forgery. Skipping this check because the
  // signature passed is skipping the only check that catches it.
  if (endpoint.verification !== "none" && input.sentAt !== undefined) {
    const time = timestampWithinTolerance(
      input.sentAt ?? null,
      now,
      endpoint.timestampToleranceSeconds,
    );
    if (!time.withinTolerance) {
      return {
        signatureState: signature.state,
        isReplay: true,
        mayProcess: false,
        outcome: "ignored_replay",
        errorMessage: time.reason,
      };
    }
  }

  // ④ ⭐ THE SAME DELIVERY, AGAIN. Every one of these senders retries.
  //
  // ⚠️ A retry is not a fault. It is the sender doing the right thing
  // after our own timeout. It must land exactly once, and the second
  // arrival must be recorded rather than dropped, or a duplicated lead
  // has no explanation.
  if (input.alreadySeen && input.externalId) {
    return {
      signatureState: signature.state,
      isReplay: true,
      mayProcess: false,
      outcome: "ignored_replay",
      errorMessage: null,
    };
  }

  return {
    signatureState: signature.state,
    isReplay: false,
    mayProcess: true,
    outcome: "received",
    errorMessage: null,
  };
}

function settleSignature(
  endpoint: EndpointSnapshot,
  input: DeliveryInput,
): { state: SignatureState; reason: string | null } {
  if (endpoint.verification === "none") {
    // 🔴 NOT "verified". Unsigned by design is its own answer.
    return { state: "not_required", reason: null };
  }

  const presented = input.presentedSignature?.trim();
  if (!presented) {
    return {
      state: "absent",
      reason: `This endpoint expects a signature in ${endpoint.signatureHeader ?? "the agreed header"} and none was sent.`,
    };
  }

  const secret = input.secret;
  if (!secret) {
    // ⚠️ NOT "verified" AND NOT "absent". We could not check, so we did
    // not, and saying otherwise would be a lie recorded in evidence.
    return {
      state: "invalid",
      reason:
        "The signing secret for this endpoint could not be read, so the delivery could not be checked. It was kept and not acted on.",
    };
  }

  if (endpoint.verification === "shared_token") {
    return constantTimeEquals(secret, presented)
      ? { state: "verified", reason: null }
      : { state: "invalid", reason: "The shared token did not match." };
  }

  const expected = computeSignature(
    endpoint.verification,
    secret,
    input.rawBody,
    input.sentAt ? String(Math.floor(input.sentAt.getTime() / 1000)) : null,
  );
  if (!expected) {
    return { state: "invalid", reason: "The signature could not be computed." };
  }

  return constantTimeEquals(expected, normaliseSignatureHeader(presented))
    ? { state: "verified", reason: null }
    : {
        state: "invalid",
        reason:
          "The signature did not match. Either the signing secret has been changed at the sender's end, or this delivery did not come from them.",
      };
}

/* ------------------------------------------------------------------ */
/* RETENTION                                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 EVERY DELIVERY GETS A DELETION DATE WHEN IT IS WRITTEN.
 *
 * ⚠️ A webhook body is somebody's name, phone number and what they
 * asked about. A debugging table that keeps that forever is a DPDP
 * problem hiding inside a developer tool, and it is the kind that is
 * only ever found by somebody looking for it.
 *
 * ⭐ WHICH IS WHY `purge_after` IS `NOT NULL` IN 0064. A retention that
 * has to be remembered is a retention that will be forgotten, and the
 * only reliable moment to decide when a row dies is the moment it is
 * born.
 */
export const DEFAULT_DELIVERY_RETENTION_DAYS = 90;

/**
 * ⚠️ A FAILED DELIVERY IS KEPT LONGER, AND ON PURPOSE. Ninety days is
 * plenty to debug a working integration; the one nobody noticed broke in
 * January is the one still being argued about in May.
 */
export const FAILED_DELIVERY_RETENTION_DAYS = 180;

export function purgeAfterFor(
  receivedAt: Date,
  outcome: DeliveryOutcome,
  overrideDays?: number,
): string {
  const days =
    overrideDays ??
    (outcome === "rejected" || outcome === "failed"
      ? FAILED_DELIVERY_RETENTION_DAYS
      : DEFAULT_DELIVERY_RETENTION_DAYS);

  const purge = new Date(receivedAt.getTime() + days * 86_400_000);
  const iso = purge.toISOString();
  // `purge_after` is a DATE column.
  return iso.slice(0, 10);
}
