/**
 * Ordence — Signed Upload Tickets
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS AND WHY IT EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 * On Vercel, `/api/upload` minted a Vercel Blob client token: a short-lived,
 * cryptographically-signed capability that pinned the storage path, the
 * allowed content types and the maximum size. The browser then uploaded
 * directly to Vercel, and Vercel — not us — enforced those constraints.
 *
 * On Cloudflare the bytes come back through our own Worker, so there is no
 * third party to enforce anything. The constraints have to travel with the
 * request, and they have to be untamperable, because the code that decides
 * them (`/api/upload`, which has the session, the quota and the tenant) is
 * not the code that receives the bytes (`/api/upload/put`, which has the
 * stream).
 *
 * A ticket is that carrier. It is an HMAC-SHA256 signature over a small JSON
 * payload. It is NOT an authorisation by itself:
 *
 *   ⚠️ `/api/upload/put` ALSO requires a live Clerk session and ALSO checks
 *   that the ticket's tenant matches the session's tenant. A stolen ticket is
 *   useless without a session in the same workspace, and a session is useless
 *   without a ticket. Both, or nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY WebCrypto AND NOT node:crypto
 * ══════════════════════════════════════════════════════════════════════════
 * `nodejs_compat` does provide `createHmac`, so `node:crypto` would work.
 * `crypto.subtle` is used anyway because it is the one API that behaves
 * identically in the Worker, in Node during tests, and in the Next.js Edge
 * runtime — this module is small, security-critical, and benefits from having
 * exactly one implementation everywhere rather than a runtime-dependent one.
 */

/** Bumped if the payload shape ever changes. Old tickets then fail closed. */
const TICKET_VERSION = 1;

/** Ten minutes — long enough for a 50 MB file on a slow connection. */
export const TICKET_TTL_MS = 10 * 60 * 1000;

/**
 * The minimum acceptable secret length.
 *
 * 32 characters of the output of `openssl rand -hex 32` is 128 bits of
 * entropy. Refusing shorter values is not pedantry: an HMAC key that someone
 * typed by hand is the weakest link in this whole file.
 */
export const MIN_SECRET_LENGTH = 32;

export type UploadTicketPayload = {
  /** Ticket format version. */
  v: number;
  /** The exact R2 key the bytes may be written to. Built server-side. */
  p: string;
  /** The exact Content-Type the upload must declare. */
  ct: string;
  /** Hard ceiling in bytes. */
  mb: number;
  /** Tenant the ticket was issued to. */
  t: string;
  /** User the ticket was issued to, for audit attribution. */
  u: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
};

export type TicketVerification =
  | { ok: true; payload: UploadTicketPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_version" };

/* ------------------------------------------------------------------ */
/* ENCODING                                                            */
/* ------------------------------------------------------------------ */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* SIGNING                                                             */
/* ------------------------------------------------------------------ */

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Constant-time byte comparison.
 *
 * `a === b` on the base64 strings would return at the first differing byte,
 * so response time reveals how many leading characters of a forged signature
 * were correct. Given enough attempts an attacker recovers a valid signature
 * one character at a time. This always examines every byte of the longer
 * input.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Length is not secret (SHA-256 output is always 32 bytes), but comparing
  // it early must not short-circuit the loop below in the equal-length case.
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Sign a payload. The returned string is `<base64url payload>.<base64url mac>`. */
export async function signUploadTicket(
  payload: Omit<UploadTicketPayload, "v">,
  secret: string,
): Promise<string> {
  assertUsableSecret(secret);

  const full: UploadTicketPayload = { v: TICKET_VERSION, ...payload };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(full)));
  const key = await importKey(secret);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  return `${body}.${toBase64Url(mac)}`;
}

/**
 * Verify a ticket.
 *
 * ⚠️ ORDER IS DELIBERATE: signature BEFORE expiry, and both before the
 * payload is trusted for anything. Checking expiry first would mean parsing
 * and acting on an unverified payload, which is how "just read the tenant id
 * out of the token" becomes a cross-tenant write.
 */
export async function verifyUploadTicket(
  ticket: string,
  secret: string,
  now: number = Date.now(),
): Promise<TicketVerification> {
  assertUsableSecret(secret);

  const parts = ticket.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [body, providedMac] = parts as [string, string];

  const providedBytes = fromBase64Url(providedMac);
  if (!providedBytes) return { ok: false, reason: "malformed" };

  const key = await importKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  if (!constantTimeEqual(expected, providedBytes)) {
    return { ok: false, reason: "bad_signature" };
  }

  const decoded = fromBase64Url(body);
  if (!decoded) return { ok: false, reason: "malformed" };

  let payload: UploadTicketPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded)) as UploadTicketPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload?.v !== TICKET_VERSION) return { ok: false, reason: "wrong_version" };

  if (
    typeof payload.p !== "string" ||
    typeof payload.ct !== "string" ||
    typeof payload.t !== "string" ||
    typeof payload.u !== "string" ||
    typeof payload.mb !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

/**
 * The signing secret, or null when it is unset or too weak.
 *
 * Returning null rather than throwing lets `/api/upload` answer 503 with a
 * sentence an operator can act on, which is the same degradation the Vercel
 * build used when `BLOB_READ_WRITE_TOKEN` was missing.
 */
export function getTicketSecret(): string | null {
  const secret = process.env.UPLOAD_TICKET_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

function assertUsableSecret(secret: string): void {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    // Programmer error, not a runtime condition. Callers are expected to
    // have gone through `getTicketSecret()` and refused already.
    throw new Error(
      `[SECURITY] Upload ticket secret must be at least ${MIN_SECRET_LENGTH} characters.`,
    );
  }
}
