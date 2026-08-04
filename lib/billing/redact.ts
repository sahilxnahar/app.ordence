/**
 * Ordence — Webhook Payload Redaction
 * Version: v0.11.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY REDACT SOMETHING THE PROVIDER ALREADY REDACTED
 * ══════════════════════════════════════════════════════════════════════
 * Neither Razorpay nor Stripe sends a full card number in a webhook. Both
 * send a last4 and a network. So this pass should, in normal operation,
 * find nothing.
 *
 * It runs anyway, for three reasons:
 *
 * 1. `payment_events.payload` is stored FOREVER and is APPEND-ONLY. If a
 *    provider ever changes what it sends — a new API version, a new
 *    payment method type, a field added in a minor release — the first we
 *    would know is a PCI finding against data we can no longer delete.
 *
 * 2. The `manual` provider path accepts payloads assembled by our own
 *    code from human input. A support engineer pasting a reference into
 *    the wrong field is exactly the kind of thing that ends up in a
 *    database and never comes out.
 *
 * 3. The cost is one traversal of an object we are already serialising.
 *
 * A redaction pass that never fires is not wasted work; it is the reason
 * the interesting case never happens.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not attempt to detect names, addresses or email addresses.
 * Those ARE present in provider payloads, they are legitimately needed to
 * render an invoice, and they are already covered by the tenant-scoped
 * RLS policy on `payment_events`. Redaction here targets material that
 * has no business being retained at all under any access control.
 */

/** Keys whose VALUE is replaced outright, regardless of content. */
const REDACTED_KEYS = new Set([
  // Card data — PCI-DSS scope the moment any of it is stored.
  "card_number",
  "cardnumber",
  "number",
  "pan",
  "cvv",
  "cvc",
  "cvv2",
  "card_security_code",
  "expiry",
  "exp_month_year",

  // Bank instruments.
  "account_number",
  "accountnumber",
  "bank_account_number",
  "iban",
  "routing_number",
  "ifsc_account",

  // Credentials that occasionally appear in echoed request metadata.
  "api_key",
  "secret",
  "client_secret",
  "webhook_secret",
  "authorization",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
]);

/**
 * Keys that LOOK sensitive by the rule above but are safe and necessary.
 *
 * `token` is the interesting one: Razorpay's `token_id` is a saved-
 * instrument handle we must keep in order to charge a recurring mandate.
 * It is a reference, not an instrument — useless without our API secret.
 * Redacting it would break renewals, so it is exempted explicitly rather
 * than by loosening the rule.
 */
const ALLOWED_KEYS = new Set([
  "token_id",
  "payment_token",
  "setup_intent",
  "idempotency_key",
  "last4",
  "network",
  "issuer",
  "exp_month",
  "exp_year",
]);

const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * A bare sequence of 13–19 digits is a card number by length, whatever
 * the field is called. Anchored to word boundaries so it does not match
 * inside a longer identifier, and Luhn-checked so it does not fire on a
 * timestamp, an amount in paise, or a provider reference that happens to
 * be numeric.
 */
const CARD_LIKE = /\b\d{13,19}\b/g;

function looksLikeCardNumber(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;

  // Luhn. A random 16-digit number passes about 1 time in 10, so this is
  // a filter against false positives rather than proof of a card — which
  // is the right trade when the action on a match is "replace the value".
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactString(value: string): string {
  if (value.length < 13) return value;
  return value.replace(CARD_LIKE, (match) =>
    looksLikeCardNumber(match) ? REDACTION_PLACEHOLDER : match,
  );
}

/**
 * Depth limit. A payload with a cycle would otherwise recurse until the
 * stack blows — inside a webhook handler, which would produce a 500 and
 * an infinite provider retry loop. Provider payloads nest four or five
 * levels; twelve is generous and finite.
 */
const MAX_DEPTH = 12;

/**
 * Return a redacted deep copy. The input is never mutated — the caller
 * still needs the original to verify against, and mutating a payload
 * mid-verification is how a signature check starts passing for the wrong
 * bytes.
 */
export function redactPayload(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTION_PLACEHOLDER;

  if (input === null || input === undefined) return input;

  if (typeof input === "string") return redactString(input);

  if (typeof input === "number" || typeof input === "boolean") return input;

  if (typeof input === "bigint") return input.toString();

  if (Array.isArray(input)) {
    return input.map((item) => redactPayload(item, depth + 1));
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();

      if (ALLOWED_KEYS.has(lowerKey)) {
        out[key] = redactPayload(value, depth + 1);
        continue;
      }
      if (REDACTED_KEYS.has(lowerKey)) {
        out[key] = REDACTION_PLACEHOLDER;
        continue;
      }
      out[key] = redactPayload(value, depth + 1);
    }
    return out;
  }

  // Functions, symbols — cannot occur in parsed JSON, but the type system
  // does not know that and a silent `undefined` would be worse than a
  // visible marker.
  return REDACTION_PLACEHOLDER;
}

/** Convenience wrapper that guarantees an object, never a scalar. */
export function redactPayloadObject(input: unknown): Record<string, unknown> {
  const redacted = redactPayload(input);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  // A provider that sent a bare array or scalar is not something to drop —
  // wrap it so the column's shape holds and the oddity stays visible.
  return { _nonObjectPayload: redacted };
}
