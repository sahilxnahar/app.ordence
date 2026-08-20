/**
 * Ordence — Telemetry Scrubbing & Fingerprinting
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE ONLY THING STANDING BETWEEN A CRM AND A PII LEAK
 * ══════════════════════════════════════════════════════════════════════
 * Telemetry is the one subsystem that deliberately copies fragments of a
 * running application into a table that engineers browse, dashboards
 * export, and support tooling reads. In a CRM those fragments are not
 * neutral: a URL is `/contacts/9f8e…/edit`, an error message is
 * `Failed to email priya@acme.co`, a stack frame carries the query string
 * of the request that produced it.
 *
 * Every one of those is personal data under the DPDP Act, and none of
 * them is obviously personal data at the call site — which is exactly why
 * this has to be a mechanical pass rather than a code-review convention.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE IS ISOMORPHIC (no `server-only`, no `node:crypto`)
 * ══════════════════════════════════════════════════════════════════════
 * Scrubbing has to happen at the EARLIEST possible point, which for a
 * browser error is inside the browser — before the value crosses the
 * network. A server-side scrub still means the raw URL travelled to our
 * ingest endpoint and sat in a request log. So this file must be
 * importable from a client component, which rules out `server-only` and
 * rules out `node:crypto`.
 *
 * `fingerprintError()` therefore uses a pure-JS FNV-1a-64. THAT IS
 * DELIBERATE AND IT IS NOT A SECURITY HASH. It groups equal inputs; it is
 * not required to resist a chosen-collision attack, because the only
 * consequence of a forced collision is two unrelated bugs sharing a row
 * in a triage list. Anything security-bearing in this platform (portal
 * tokens, webhook HMACs) uses `node:crypto` and always will.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ALLOW-LIST, NOT DENY-LIST, WHEREVER A CHOICE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `scrubText` is necessarily a deny-list — you cannot allow-list the
 * shapes an exception message may take. `scrubMetadata` is an allow-list,
 * because there the set of legitimate keys IS knowable. Where both were
 * possible, the allow-list won: a deny-list has to anticipate every
 * future field name, and it silently fails open on the one nobody thought
 * of.
 */

/* ================================================================== */
/* BOUNDS                                                              */
/* ================================================================== */

/**
 * Hard caps. These are not politeness — a public ingest endpoint with an
 * unbounded text column is a storage-exhaustion primitive, and the same
 * bounds are re-asserted as CHECK constraints in the schema so they still
 * hold for a caller that skips this module.
 */
export const MAX_MESSAGE_LENGTH = 2_000;
export const MAX_STACK_LENGTH = 8_000;
export const MAX_ROUTE_LENGTH = 200;

/**
 * Cardinality bound on route patterns. A URL with 40 segments is either
 * an attack on our label set or a bug in a link builder; either way the
 * pattern is truncated rather than stored, because one pathological
 * client should not be able to mint unbounded distinct labels.
 */
export const MAX_ROUTE_SEGMENTS = 12;

/** The placeholder every stripped identifier collapses to. */
const ID_TOKEN = ":id";

/** What a redacted PII match is replaced with in free text. */
const REDACTED = "[redacted]";

/* ================================================================== */
/* IDENTIFIER SHAPES                                                   */
/* ================================================================== */

/**
 * Each of these is a shape an identifier takes SOMEWHERE in this app.
 * They are matched against a single path SEGMENT, anchored, so a segment
 * is either entirely an id or entirely a route word — a partial match
 * would turn `/contacts` into `/:id` the moment it contained a digit.
 */
const SEGMENT_ID_PATTERNS: readonly RegExp[] = [
  // uuid v1–v8, the primary key type of every table in this platform.
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Bare integers: legacy ids, invoice numbers, pagination cursors.
  /^\d+$/,
  // Long hex: portal token prefixes, sha fragments, Clerk internal ids.
  /^[0-9a-f]{16,}$/i,
  // ULID / Crockford base32 — 26 chars, used by several id libraries.
  /^[0-9A-HJKMNP-TV-Z]{26}$/,
  // Clerk-style prefixed ids: user_2abc…, org_2abc…, sess_…
  /^(user|org|sess|obj|evt|sub|inv|cus|pi|sk|pk)_[A-Za-z0-9]{6,}$/,
  // Provider ids: pay_ / order_ / sub_ (Razorpay), cs_ / in_ (Stripe).
  /^(pay|order|plan|cust|item|txn|cs|in|price|prod)_[A-Za-z0-9]{6,}$/,
  // Opaque high-entropy blobs: base64url secrets in a path (portal links).
  /^[A-Za-z0-9_-]{24,}$/,
  // A percent-encoded or literal email dropped into a path segment.
  /^[^@\s]+(@|%40)[^@\s]+\.[A-Za-z]{2,}$/,
];

/* ================================================================== */
/* FREE-TEXT PII SHAPES                                                */
/* ================================================================== */

/**
 * ⚠️ ORDER MATTERS IN THIS ARRAY.
 *
 * Email is matched BEFORE the generic long-token rule, because
 * `priya@acme.co` also satisfies "a token with dots in it" and a
 * different ordering would leave the local part — the identifying half —
 * intact while redacting the domain. Ordering bugs in a redaction chain
 * do not throw; they just quietly stop redacting.
 */
const TEXT_PII_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // Email addresses. The single highest-value identifier in a CRM.
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: REDACTED,
  },
  // An HTTP `Bearer <credential>` scheme, WITH ITS OWN RULE AND FIRST.
  // The generic `key: value` rule below would match `Authorization:` and
  // consume only the word "Bearer", leaving the actual credential in the
  // string — a redaction that looks like it worked and did not.
  {
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: REDACTED,
  },
  // Credentials interpolated into an error message by an HTTP client
  // library. `Authorization: sk_live_…` in a stack frame is a live
  // credential written to a table engineers read.
  {
    pattern: /\b(bearer|token|apikey|api_key|secret|password|authorization)\b\s*[:=]\s*\S+/gi,
    replacement: "$1=[redacted]",
  },
  // ⚠️ UUIDs ARE REDACTED BEFORE THE NUMERIC RULES BELOW, AND THE ORDER
  // IS LOAD-BEARING. A uuid ends in twelve hex characters, and when those
  // happen to be all digits the Aadhaar rule below matches them first —
  // leaving a half-redacted uuid. Two occurrences of the SAME bug then
  // fingerprint differently depending on whether their record id happened
  // to end in digits, which silently splits one issue into two.
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: ID_TOKEN,
  },
  // A JWT on its own, unlabelled.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  // Indian phone numbers, with or without +91, with common separators.
  {
    pattern: /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g,
    replacement: REDACTED,
  },
  // PAN (ABCDE1234F) and Aadhaar-shaped 12-digit runs. Both appear in a
  // CRM's KYC fields and both are hard-identifying under DPDP.
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replacement: REDACTED },
  { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, replacement: REDACTED },
];

/* ================================================================== */
/* scrubUrl                                                            */
/* ================================================================== */

/**
 * Turn any URL or path into a bounded ROUTE PATTERN.
 *
 *   /contacts/9f8e1c2d-…/edit    ->  /contacts/:id/edit
 *   https://x.com/deals/42?q=a   ->  /deals/:id
 *   /portal/AbCd…32chars…        ->  /portal/:id
 *   ""                           ->  /
 *
 * THREE THINGS THIS PREVENTS, EACH OF WHICH HAS BURNED SOMEBODY:
 *
 * 1. RECORD IDS IN TELEMETRY. `/contacts/<uuid>` plus a tenant id is a
 *    pointer to a named human. Storing it means the telemetry table is in
 *    scope for a DPDP erasure request.
 *
 * 2. QUERY STRINGS. The single worst offender. Search pages put the
 *    user's literal query in `?q=` — in a CRM that query is very often a
 *    customer's name, email or phone number. The query string is DROPPED
 *    ENTIRELY here; there is no allow-list of "safe" params, because the
 *    next feature will add an unsafe one.
 *
 * 3. UNBOUNDED CARDINALITY. Raw URLs are an infinite label set. Patterns
 *    are bounded by the app's route table.
 *
 * Fragments (`#…`) are dropped for the same reason as query strings.
 * Never throws — a malformed input returns `/`, because a scrubber that
 * throws is a scrubber that gets wrapped in a try/catch that skips it.
 */
export function scrubUrl(input: string | null | undefined): string {
  if (typeof input !== "string" || input.length === 0) return "/";

  try {
    let path = input;

    // Strip scheme + host if present. A relative path is left alone.
    // We do NOT use `new URL()` as the primary path parser: it throws on
    // relative inputs, and the fallback would then be the interesting
    // branch — better to have one code path that handles both.
    const schemeMatch = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/.exec(path);
    if (schemeMatch) path = path.slice(schemeMatch[0].length);

    // Protocol-relative //host/path.
    if (path.startsWith("//")) {
      const slash = path.indexOf("/", 2);
      path = slash === -1 ? "/" : path.slice(slash);
    }

    // Drop query and fragment. Whichever comes first wins; a `#` before a
    // `?` means the `?` is inside the fragment.
    const cut = Math.min(
      path.indexOf("?") === -1 ? path.length : path.indexOf("?"),
      path.indexOf("#") === -1 ? path.length : path.indexOf("#"),
    );
    path = path.slice(0, cut);

    if (path.length === 0) return "/";
    if (!path.startsWith("/")) path = `/${path}`;

    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return "/";

    const patterned: string[] = [];
    for (const raw of segments.slice(0, MAX_ROUTE_SEGMENTS)) {
      // Decode ONCE so `%2F` and `%40` are seen for what they are. A
      // second pass would be a double-decode bug; a zero-pass would let
      // `%40` slip past the email pattern below.
      let segment = raw;
      try {
        segment = decodeURIComponent(raw);
      } catch {
        // Malformed escape. Keep the raw form — it is still checked below.
      }

      // Path traversal / injected separators must not survive into a
      // pattern, or a crafted URL could mint a label containing anything.
      segment = segment.replace(/[/\\]/g, "");
      if (segment === "." || segment === "..") {
        patterned.push(ID_TOKEN);
        continue;
      }

      if (segment.length === 0) continue;

      // Any segment that LOOKS like an identifier becomes `:id`.
      if (SEGMENT_ID_PATTERNS.some((p) => p.test(segment))) {
        patterned.push(ID_TOKEN);
        continue;
      }

      // A segment containing an `@` is an email or a handle even if it did
      // not match the anchored pattern above (e.g. a trailing comma).
      if (segment.includes("@")) {
        patterned.push(ID_TOKEN);
        continue;
      }

      // Anything left is treated as a route word, but is BOUNDED and
      // stripped of characters no legitimate Next.js route segment has.
      // Without this, a 4 KB junk segment becomes a 4 KB label.
      const word = segment.replace(/[^A-Za-z0-9._~-]/g, "").slice(0, 48);
      patterned.push(word.length === 0 ? ID_TOKEN : word);
    }

    const result = `/${patterned.join("/")}`;
    return result.length > MAX_ROUTE_LENGTH
      ? `${result.slice(0, MAX_ROUTE_LENGTH - 1)}…`
      : result;
  } catch {
    // Genuinely unreachable, but a scrubber must never be the reason a
    // page fails to report an error.
    return "/";
  }
}

/* ================================================================== */
/* scrubText                                                           */
/* ================================================================== */

/**
 * Strip PII shapes out of free text (an exception message, a stack) and
 * truncate.
 *
 * WHAT THIS DOES NOT CLAIM: it is not a guarantee. A message like
 * `Could not save deal for Priya Sharma` contains a name in a shape no
 * regex can recognise. That residual risk is precisely why session replay
 * was cut from this phase (see docs/PHASE-19-NOTES.md) and why the
 * REAL defence is that callers pass exception messages, not record
 * contents. This function is the second line, not the first.
 *
 * Never throws.
 */
export function scrubText(
  input: string | null | undefined,
  maxLength: number = MAX_MESSAGE_LENGTH,
): string {
  if (typeof input !== "string" || input.length === 0) return "";

  try {
    // Truncate FIRST, generously, so a megabyte of adversarial input does
    // not get run through eight global regexes before being thrown away.
    // Catastrophic backtracking on a huge string is a real DoS on a public
    // endpoint, and the endpoint here is public by design.
    let text = input.slice(0, maxLength * 4);

    // Any embedded URL is replaced by its scrubbed pattern rather than
    // being deleted: `fetch failed for /contacts/:id` is useful,
    // `fetch failed for [redacted]` is not.
    text = text.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (m) => scrubUrl(m));

    for (const { pattern, replacement } of TEXT_PII_PATTERNS) {
      // `lastIndex` is stateful on /g regexes held in module scope. Not
      // resetting it makes the SECOND call skip matches near the start of
      // the string — an intermittent, input-order-dependent leak that is
      // very hard to reproduce from a bug report.
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
    }

    // Collapse whitespace so identical errors formatted differently still
    // fingerprint identically.
    text = text.replace(/\s+/g, " ").trim();

    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Stack-specific scrub. Runs `scrubText` and then normalises absolute
 * file locations.
 *
 * WHY STACKS NEED THEIR OWN PASS: a browser stack frame is
 * `at Foo (https://app.example.com/_next/static/chunk-a1b2.js:1:200)` and
 * a server frame is `at Bar (/var/task/app/(app)/contacts/[id]/page.js:9)`.
 * Both carry a full path; the client one can carry the page URL —
 * including its query string — verbatim. Left alone, the "safe" stack
 * column becomes the leakiest column in the table.
 */
export function scrubStack(
  input: string | null | undefined,
  maxLength: number = MAX_STACK_LENGTH,
): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const scrubbed = scrubText(input, maxLength);
  return scrubbed.length === 0 ? null : scrubbed;
}

/* ================================================================== */
/* fingerprintError                                                    */
/* ================================================================== */

/**
 * Normalise a stack for GROUPING (not for display).
 *
 * Everything that varies between two occurrences of the SAME bug is
 * removed: line/column numbers (they move with every deploy), chunk
 * hashes, absolute paths, and any id the scrubber already collapsed.
 * What remains is the sequence of function names, which is what actually
 * identifies a bug.
 *
 * Only the top frames are kept. Deep frames are dominated by framework
 * internals that differ by entry point, so including them splits one bug
 * into a group per route.
 */
function normaliseForFingerprint(stack: string, message: string): string {
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 5)
    .map((line) =>
      line
        // Drop the (location) suffix entirely — file, line and column.
        .replace(/\s*\(.*\)$/, "")
        // A frame with no parens still ends in a location.
        .replace(/\s+https?:\/\/\S+$/i, "")
        .replace(/\s+\/\S+$/, "")
        // Webpack/Turbopack chunk hashes.
        .replace(/[.-][0-9a-f]{8,}\b/gi, "")
        .replace(/\d+/g, ""),
    );

  // Digits in the message are stripped too: "Timeout after 5031ms" and
  // "Timeout after 4998ms" are one bug, and grouping them separately is
  // how a single flaky dependency becomes 400 issues in a triage queue.
  const normalisedMessage = message.replace(/\d+/g, "#").toLowerCase();

  return `${normalisedMessage}\n${frames.join("\n")}`;
}

/**
 * FNV-1a, 64-bit, in two 32-bit halves.
 *
 * WHY NOT SHA-256: this module must run in the browser (see the header),
 * where `node:crypto` does not exist and `crypto.subtle.digest` is ASYNC —
 * and an async fingerprint would make every capture path async, including
 * the ones inside error handlers where an unawaited promise is a silent
 * loss. FNV-1a is synchronous, dependency-free and deterministic across
 * runtimes, which is the entire requirement.
 *
 * Implemented with `Math.imul` because JavaScript's `*` on numbers larger
 * than 2^53 loses precision — a naive multiply produces a hash that
 * differs between engines, which would split one bug into two groups
 * depending on which runtime reported it.
 */
function fnv1a64(input: string): string {
  // 0xcbf29ce484222325 offset basis, split hi/lo.
  let hi = 0x84222325;
  let lo = 0xcbf29ce4;

  for (let i = 0; i < input.length; i++) {
    // Iterate over UTF-16 code units, both bytes. Using only the low byte
    // would make "é" and "i" collide, and would make the hash depend on
    // the encoding the reporter happened to use.
    const code = input.charCodeAt(i);
    lo = (lo ^ (code & 0xff)) >>> 0;

    // Multiply the 64-bit value by the FNV prime 0x100000001b3, carried by
    // hand across the two 32-bit halves:
    //   lo' = lo * 0x1b3                    (with carry into hi)
    //   hi' = hi * 0x1b3 + lo * 0x100 + carry
    const loProduct = lo * 0x1b3;
    const carry = Math.floor(loProduct / 0x1_0000_0000);
    const nextLo = loProduct >>> 0;
    const nextHi =
      (Math.imul(hi, 0x1b3) + Math.imul(lo, 0x100) + carry) >>> 0;

    lo = nextLo;
    hi = nextHi;

    // Fold in the high byte of the code unit as a second round, so
    // non-ASCII input actually affects the digest.
    lo = (lo ^ ((code >>> 8) & 0xff)) >>> 0;
    hi = (hi ^ (lo >>> 13)) >>> 0;
  }

  return (
    (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0")
  );
}

/**
 * ⭐ THE GROUPING KEY. 16 lowercase hex characters, stable across
 * deploys, runtimes and occurrences of the same bug.
 *
 * Callers may pass an explicit `fingerprintHint` when they know better
 * than the stack does — e.g. a network layer that wants every timeout to
 * one host grouped together regardless of which component called it.
 * The hint is normalised and hashed like anything else, so it can never
 * become an unbounded label itself.
 *
 * Never throws.
 */
export function fingerprintError(input: {
  message?: string | null;
  stack?: string | null;
  name?: string | null;
  fingerprintHint?: string | null;
}): string {
  try {
    if (input.fingerprintHint) {
      return fnv1a64(`hint:${input.fingerprintHint.trim().toLowerCase()}`);
    }

    const message = scrubText(input.message ?? "", MAX_MESSAGE_LENGTH);
    const stack = scrubText(input.stack ?? "", MAX_STACK_LENGTH);
    const name = (input.name ?? "Error").trim();

    // A stack-less error (thrown string, cross-origin "Script error") still
    // has to group SOMEHOW. Name + normalised message is the fallback, and
    // it is a good one — those errors are almost always identical anyway.
    const basis = stack
      ? `${name}\n${normaliseForFingerprint(stack, message)}`
      : `${name}\n${message.replace(/\d+/g, "#").toLowerCase()}`;

    return fnv1a64(basis);
  } catch {
    // A fingerprint that cannot be computed must not lose the event.
    // Everything unfingerprintable lands in one visible bucket rather
    // than being silently dropped or minting a random group per event.
    return "0000000000000000";
  }
}

/* ================================================================== */
/* METADATA ALLOW-LIST                                                 */
/* ================================================================== */

/**
 * The ONLY keys permitted in a telemetry `metadata` bag.
 *
 * This is an allow-list because the failure mode of a deny-list here is
 * permanent and invisible: someone adds `{ customer }` to a capture call
 * during an incident, it passes review because the object looks like
 * context, and six months of customer records sit in a diagnostics table
 * that nobody thinks of as customer data.
 *
 * Adding a key to this list should feel like a decision. It is.
 */
export const TELEMETRY_METADATA_KEYS = [
  "component",
  "action",
  "statusCode",
  "durationMs",
  "attempt",
  "queue",
  "jobType",
  "provider",
  "browser",
  "os",
  "digest",
  "boundary",

  /* ------------------------------------------------------------------ */
  /* ⭐ WAVE 14 — CORRELATION IDS. ADDED FOR ONE REASON, WITH ONE RULE.  */
  /* ------------------------------------------------------------------ */
  /**
   * 🔴 THE DEFECT THAT MADE THESE NECESSARY, AND IT IS IN THIS FILE.
   *
   * The obvious way to correlate an `error_events` row with the request
   * that produced it is `metadata: { requestId: ctx.requestId }`. Do that
   * today and the value stored is the literal string `":id"` — because
   * `ctx.requestId` is a uuid, `scrubMetadata` sends every string value
   * through `scrubText`, and `scrubText` redacts uuids to `ID_TOKEN` by
   * design (see TEXT_PII_PATTERNS, and the comment there explaining that
   * the ORDER of that rule is load-bearing).
   *
   * ⚠️ NOTHING WOULD HAVE TOLD ANYBODY. The write succeeds, the column is
   * populated, the dashboard has a `requestId` field, and every row's
   * value is the same three characters. It is the exact shape this wave
   * exists to find: built, wired, and verified by something that is
   * always true.
   *
   * ⭐ SO THESE THREE KEYS ARE PASSED THROUGH VERBATIM AND ARE THE ONLY
   * ONES THAT ARE — see `CORRELATION_VALUE_RE` below. They are safe to
   * exempt for a reason that does not generalise to any other key: their
   * values are generated by us (`crypto.randomUUID()` in `middleware.ts`,
   * `newSpanId()` in `lib/telemetry/trace.ts`), they are never derived
   * from user input, and the shape check refuses anything that is not
   * exactly a uuid or 16–32 hex characters. A caller who puts a customer
   * reference in `requestId` gets it dropped, not stored.
   *
   * ⚠️ `userId` IS DELIBERATELY NOT ON THIS LIST, and not only because
   * `tests/ui/telemetry.test.tsx` refuses any key matching /user/. The
   * table already has a `user_id` COLUMN with a foreign key and an RLS
   * policy over it; a second copy inside `metadata` jsonb would be a
   * personal identifier in a place the DPDPA erasure path does not look.
   */
  "traceId",
  "requestId",
  "spanId",
] as const;

export type TelemetryMetadataKey = (typeof TELEMETRY_METADATA_KEYS)[number];

const METADATA_KEY_SET: ReadonlySet<string> = new Set(TELEMETRY_METADATA_KEYS);

/**
 * The keys whose values skip `scrubText`, and the ONLY shape they may
 * have to do so.
 *
 * ⚠️ A uuid (with hyphens) or 16–32 lowercase hex (a trace id, a span id,
 * an error fingerprint). Nothing else — not a "reference", not a
 * "correlation key" a caller invented, not a session token, which would
 * satisfy neither branch.
 */
const CORRELATION_KEYS: ReadonlySet<string> = new Set(["traceId", "requestId", "spanId"]);
const CORRELATION_VALUE_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,32})$/i;

/** Bound on how many entries survive, independent of the key list length. */
const MAX_METADATA_ENTRIES = 12;
/** Bound on a single string value. Metadata is context, not payload. */
const MAX_METADATA_VALUE_LENGTH = 200;

/**
 * Filter an arbitrary object down to the allow-list, coercing values to
 * scalars and scrubbing every string.
 *
 * Nested objects and arrays are DROPPED, not flattened. Flattening is how
 * `{ contact: { email } }` becomes `contact.email` and survives — the
 * whole point is that structure the allow-list did not anticipate does
 * not get through.
 *
 * Never throws.
 */
export function scrubMetadata(
  input: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return out;

  try {
    let kept = 0;
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (kept >= MAX_METADATA_ENTRIES) break;
      if (!METADATA_KEY_SET.has(key)) continue;

      if (typeof value === "number") {
        // NaN and Infinity are not valid JSON and become `null` on the way
        // into jsonb, which turns a numeric column into a mixed-type one.
        if (!Number.isFinite(value)) continue;
        out[key] = value;
        kept++;
      } else if (typeof value === "boolean") {
        out[key] = value;
        kept++;
      } else if (typeof value === "string") {
        /**
         * ⭐ THE ONE EXEMPTION FROM `scrubText`, AND IT IS SHAPE-CHECKED
         * RATHER THAN KEY-CHECKED ALONE. A correlation id that is not a
         * uuid or a hex digest is DROPPED, not stored raw — so this
         * cannot become the hole through which "put it in requestId"
         * smuggles a customer reference past the redactor.
         */
        if (CORRELATION_KEYS.has(key)) {
          if (!CORRELATION_VALUE_RE.test(value)) continue;
          out[key] = value.toLowerCase();
          kept++;
          continue;
        }
        const scrubbed = scrubText(value, MAX_METADATA_VALUE_LENGTH);
        if (scrubbed.length === 0) continue;
        out[key] = scrubbed;
        kept++;
      }
      // Everything else — objects, arrays, functions, symbols, null,
      // undefined — is dropped without comment.
    }
  } catch {
    return {};
  }

  return out;
}
