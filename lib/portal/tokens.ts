import "server-only";

/**
 * Ordence — Portal Token Cryptography
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * `import "server-only"` IS THE FIRST LINE FOR A REASON
 * ══════════════════════════════════════════════════════════════════════
 * If a client component ever imports this module — directly, or three
 * layers down through a shared barrel — the build FAILS. Token minting
 * belongs on the server and nowhere else. A generator that reached the
 * browser would let anyone mint their own portal credentials.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `crypto.randomBytes` AND NEVER `Math.random()`
 * ══════════════════════════════════════════════════════════════════════
 * `Math.random()` is a pseudo-random number generator optimised for speed,
 * not secrecy. In V8 it is xorshift128+, it is seeded from a value an
 * attacker can often influence, and — this is the part that matters —
 * given a handful of consecutive outputs, its internal state can be solved
 * for and every past and future output reconstructed.
 *
 * Applied here that means: obtain two or three portal links legitimately
 * (you are a client of this firm, you were sent some), recover the
 * generator state, and derive the tokens for every OTHER client's
 * contracts. No brute force required. That is not a theoretical attack;
 * it is a well-documented one with public tooling.
 *
 * `crypto.randomBytes` draws from the operating system's CSPRNG. Its
 * output does not reveal its state, so past and future tokens stay
 * unrelated to the ones an attacker holds.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY 256 BITS
 * ══════════════════════════════════════════════════════════════════════
 * 32 bytes → 64 hex characters. Guessing one specific token requires
 * ~2^255 attempts on average. Even at a trillion guesses per second — far
 * beyond what a rate-limited HTTPS endpoint could ever serve — that
 * exceeds the age of the universe by an absurd margin.
 *
 * This is why brute force is not on the threat list for portal tokens.
 * The realistic risks are LEAKAGE (a forwarded email, a browser history, a
 * `Referer` header, a screenshot) and they are addressed by expiry,
 * revocation, single-use signing, and a strict referrer policy on the
 * portal route — not by entropy.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** Bytes of entropy per token. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

/** Characters of the token kept in the clear, for identification only. */
const PREFIX_LENGTH = 8;

export type GeneratedToken = {
  /**
   * The raw token. This is the CREDENTIAL.
   *
   * It is returned exactly once, at generation, and never stored. Log it,
   * and the log becomes as sensitive as the contract.
   */
  token: string;
  /** SHA-256 of the token, hex. This is what goes in the database. */
  tokenHash: string;
  /** First 8 characters, for telling links apart in the UI. Not a secret. */
  tokenPrefix: string;
};

/**
 * Mint a new portal token.
 *
 * @example
 *   const { token, tokenHash, tokenPrefix } = generatePortalToken();
 *   // store tokenHash + tokenPrefix; send `token` to the recipient; forget it
 */
export function generatePortalToken(): GeneratedToken {
  // ════════════════════════════════════════════════════════════════
  // THE CRYPTOGRAPHICALLY SECURE RANDOMISER.
  //
  // `randomBytes` is Node's binding to the OS CSPRNG (getrandom(2) on
  // Linux). It is NOT `Math.random()`, and the difference is the whole
  // security of this feature. See the header.
  // ════════════════════════════════════════════════════════════════
  const raw = randomBytes(TOKEN_BYTES);

  // Hex rather than base64url: URL-safe with no escaping, no padding, and
  // no characters that a mail client might mangle when it linkifies the
  // URL. The cost is a longer string, which nobody types by hand anyway.
  const token = raw.toString("hex");

  return {
    token,
    tokenHash: hashPortalToken(token),
    tokenPrefix: token.slice(0, PREFIX_LENGTH),
  };
}

/**
 * Hash a token for storage or lookup.
 *
 * WHY PLAIN SHA-256 RATHER THAN bcrypt / argon2:
 * Slow key-derivation functions exist to make brute force expensive
 * against LOW-entropy secrets that humans chose. These tokens are 256 bits
 * from a CSPRNG — there is no dictionary, no pattern, and no feasible
 * search space. A slow KDF would add latency to every portal page load and
 * buy precisely nothing.
 *
 * The property we actually need is one-wayness, so that a leaked database
 * does not hand over working credentials. SHA-256 provides that.
 */
export function hashPortalToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Shape check for a token arriving from a URL.
 *
 * Run BEFORE touching the database. A request for `/portal/<script>` or a
 * 40 kB path should be refused on the spot rather than becoming a query —
 * it saves a round trip and keeps obviously-hostile input away from the
 * data layer entirely.
 */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Constant-time comparison of two hex hashes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS EVEN THOUGH THE LOOKUP IS BY INDEX
 * ══════════════════════════════════════════════════════════════════════
 * The portal resolves a token with `WHERE token_hash = $1`, so the
 * comparison happens inside PostgreSQL's index and there is no meaningful
 * timing channel to exploit.
 *
 * This is here for the paths where a hash is compared in JavaScript —
 * present or future. `a === b` on strings short-circuits at the first
 * differing character, so the time it takes leaks how many leading
 * characters were correct. Given enough samples that is a byte-by-byte
 * oracle. `timingSafeEqual` always compares the full buffer.
 *
 * The length check before it is not a leak: both inputs are fixed-width
 * SHA-256 hex, so a length mismatch means malformed input, not a near miss.
 */
export function tokenHashesMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Build the absolute URL a recipient will click.
 *
 * Absolute, because this goes into an email — a relative path in an inbox
 * resolves against the mail client's own origin and goes nowhere useful.
 */
export function buildPortalUrl(token: string, appUrl?: string): string {
  const base = (appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return `${base}/portal/${token}`;
}

/**
 * Mask a token for display or logging.
 *
 * Use this anywhere a token might otherwise be written down. `console.log`
 * of a live token puts a working credential into a log aggregator that
 * almost certainly has a wider audience than the contract does.
 */
export function maskToken(token: string): string {
  if (typeof token !== "string" || token.length < PREFIX_LENGTH) return "…";
  return `${token.slice(0, PREFIX_LENGTH)}…${token.slice(-4)}`;
}
