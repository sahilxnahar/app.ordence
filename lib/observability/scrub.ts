/**
 * Ordence — What may leave this server in an error report
 * Version: v0.95.0-alpha
 *
 * Pure. No Sentry import, no side effects — so it is testable without a
 * network, and so the rules can be read without reading the SDK.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RULE THIS FILE ENFORCES
 * ══════════════════════════════════════════════════════════════════════
 * `instrumentation.ts` already states it for the server log:
 *
 *   > Request headers, cookies, query strings, bodies — NEVER. A Clerk
 *   > session cookie in a log line is a stealable session, and a query
 *   > string routinely carries a customer's search terms.
 *
 * ⚠️ SENTRY IS STRICTLY WORSE THAN A LOG LINE, so the same rule has to
 * hold harder here. A log stays on Railway; an error event leaves your
 * infrastructure, crosses a border, and sits in a third party's database
 * under someone else's retention policy. Anything not scrubbed before
 * `beforeSend` is a copy you no longer control.
 *
 * ⭐ WHAT WE DO KEEP: the exception, the stack, the route, and the TENANT
 *    ID. "Something broke" is a shrug; "TenantAccessError on /orders for
 *    workspace 4f2a…" is a fix. The tenant id is an opaque uuid — it
 *    identifies a workspace to us and means nothing to anyone else.
 */

/** Header names that may travel. Everything else is dropped. */
const HEADER_ALLOWLIST = new Set(["content-type", "user-agent"]);

/**
 * ⚠️ MATCHED AGAINST THE KEY, CASE-INSENSITIVELY, AS A SUBSTRING.
 *
 * A denylist of exact names fails on the first `X-My-App-Api-Key`. This
 * catches the shape rather than the spelling — `authorization`,
 * `x-clerk-auth-token`, `stripe_secret`, `db_password` all match.
 */
const SENSITIVE_KEY_PATTERNS = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "api-key",
  "apikey",
  "session",
  "credential",
  "signature",
  "gstin",
  "pan",
  "aadhaar",
  "email",
  "phone",
];

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Strip a URL down to its path.
 *
 * ⚠️ THE QUERY STRING IS REMOVED WHOLESALE, NOT FILTERED. A search box
 * puts a customer's own words in `?q=`, an invoice link puts a document
 * id in it, and a badly-built integration puts a token there. Deciding
 * which params are safe is a judgement that has to be right every time;
 * dropping all of them has to be right once.
 */
export function scrubUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const queryAt = url.indexOf("?");
  const hashAt = url.indexOf("#");
  const cut = Math.min(
    queryAt === -1 ? url.length : queryAt,
    hashAt === -1 ? url.length : hashAt,
  );
  return url.slice(0, cut);
}

export function scrubHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HEADER_ALLOWLIST.has(key.toLowerCase()) && typeof value === "string") {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/**
 * The shape of a Sentry event, reduced to what this module touches.
 * ⚠️ DELIBERATELY NOT `Sentry.Event` — importing the SDK's types here
 * would make this module untestable without the SDK, and the whole point
 * is that the rules can be checked in isolation.
 */
export type ScrubbableEvent = {
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
  };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: { data?: Record<string, unknown>; message?: string }[];
  message?: string;
};

/**
 * ⭐ THE LAST THING THAT RUNS BEFORE AN EVENT LEAVES THE PROCESS.
 *
 * ⚠️ IT REBUILDS `request` FROM NOTHING RATHER THAN DELETING FIELDS.
 * A denylist has to anticipate every key the SDK might add in a future
 * version; starting from `{}` and adding back two fields cannot be
 * out-of-date. When Sentry adds a new request field next year, it is
 * excluded by default rather than shipped by accident.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    event.request = {
      url: scrubUrl(event.request.url),
      headers: scrubHeaders(event.request.headers),
    };
  }

  /**
   * ⚠️ THE USER OBJECT KEEPS AN ID AND NOTHING ELSE. Sentry attaches
   * `email`, `username` and `ip_address` by default. An email address is
   * the single most identifying field a support system can hold, and it
   * is never needed to fix a bug.
   */
  if (event.user) {
    const id = event.user.id;
    event.user = typeof id === "string" ? { id } : {};
  }

  if (event.extra) event.extra = scrubRecord(event.extra);

  /**
   * ⚠️ BREADCRUMB DATA IS SCRUBBED TOO, AND IT IS THE ONE PEOPLE FORGET.
   * A fetch breadcrumb carries the full URL of every request the page
   * made — including the query strings that `scrubUrl` just removed from
   * the event itself.
   */
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      data: crumb.data ? scrubRecord(crumb.data) : undefined,
    }));
  }

  return event;
}

/** One level of key-based redaction. Nested objects are dropped entirely. */
export function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    /**
     * ⚠️ A NESTED OBJECT IS REPLACED, NOT WALKED. Recursing means an
     * attacker-controlled shape decides how deep this goes, and a
     * request body nested four levels down would survive a shallow
     * check. Types and scalars are useful; arbitrary structures are not
     * worth the risk of carrying one field nobody thought about.
     */
    if (value !== null && typeof value === "object") {
      out[key] = Array.isArray(value) ? `[array:${value.length}]` : "[object]";
      continue;
    }
    out[key] = value;
  }
  return out;
}
