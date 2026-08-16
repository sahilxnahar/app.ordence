/**
 * =====================================================================
 * ⭐⭐⭐ CORS — DENY-BY-DEFAULT — Wave 7 (Hardening I)
 * =====================================================================
 * v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ NO ACCESS-CONTROL HEADERS IS THE SAFE DEFAULT
 * ══════════════════════════════════════════════════════════════════
 *
 * Browser-enforced CORS exists because a script at evil.example can
 * `fetch('https://app.ordence.com/api/...', { credentials: 'include' })`
 * and, if the server responds with `Access-Control-Allow-Origin`, the
 * browser hands that script the response body — including every
 * authenticated read and write the victim's session is entitled to.
 *
 * Next.js does NOT set any CORS headers by default. The hole opens the
 * day somebody adds `*` to "make the API work from a test page" and
 * leaves it there. So this module is an explicit DECISION, not a
 * convenience:
 *
 *   1. No surface opts in by accident — the allowlist must be named,
 *      per origin, with the methods each one gets.
 *   2. A preflight (OPTIONS) from an origin not on the list gets NO
 *      Access-Control-* headers and a 204 that no browser will allow
 *      a credentialed read across. The request simply fails at the
 *      browser, which is the whole point.
 *   3. A preflight from a listed origin gets exactly its list — the
 *      Origin is echoed ONLY if it matched, never `*`, and only the
 *      methods that origin is allowed to use.
 *
 * ⚠️ WHY THE LIST IS EMPTY BY DEFAULT — THE SAFEST VALUE A LIST CAN
 * HAVE. Ordence is a single-origin product: every page that consumes
 * the API shares its origin with it, so NO browser script ever needs
 * cross-origin access. The only callers that genuinely need CORS are
 * registered integrations, and those should be enumerated explicitly
 * the day one exists. A default-empty allowlist means the feature is
 * on precisely when it should be: never, until somebody writes down
 * why it must be.
 *
 * ⚠️ CREDENTIALS IS THE LINE THAT MATTERS. `Access-Control-Allow-
 * Credentials: true` is what turns cross-origin fetch into "the
 * attacker's script with my cookies". It is only emitted when the
 * requesting origin is on the allowlist AND the allowlist entry asks
 * for credentials. The browser refuses to honour both `*` and
 * credentials anyway; we never send `*` at all.
 * ══════════════════════════════════════════════════════════════════
 */

export interface CorsOriginEntry {
  origin: string;
  methods: string[];
  withCredentials?: boolean;
  maxAgeSeconds?: number;
}

export interface CorsDecision {
  /** The finished response to return for a preflight, or null to pass
   *  through (non-OPTIONS requests never reach here — CORS is header
   *  only, and this module never sets response headers on GET/POST). */
  preflight: {
    status: number;
    headers: Record<string, string>;
  } | null;
  /** True when the origin was on the allowlist at all — useful to the
   *  middleware for logging a security event. */
  listed: boolean;
}

const ALLOWED_ORIGINS: CorsOriginEntry[] = (readOriginsEnv()).entries;

/**
 * Read the allowlist from the environment, once, lazily. Shape:
 *   CORS_ALLOWED_ORIGINS=https://one.example.com|GET,POST,PUT;https://two.example.com|GET
 * An entry without a method list gets GET. An unset variable means the
 * empty list above — which is the default policy, not a missing config.
 */
function readOriginsEnv(): { entries: CorsOriginEntry[] } {
  try {
    const raw = process.env.CORS_ALLOWED_ORIGINS;
    if (!raw || !raw.trim()) return { entries: [] };
    const entries: CorsOriginEntry[] = [];
    for (const part of raw.split(";")) {
      const [origin, methods = "GET"] = part.trim().split("|");
      if (!origin) continue;
      entries.push({
        origin: origin.trim(),
        methods: methods
          .split(",")
          .map((m) => m.trim().toUpperCase())
          .filter((m) => m.length > 0),
      });
    }
    return { entries };
  } catch {
    return { entries: [] };
  }
}

/** Every header a preflight may set. Nothing else is ever added. */
const CORS_HEADER_NAMES = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "access-control-allow-credentials",
  "vary",
];

/**
 * Decide what a preflight gets. `origin` is the request's Origin
 * header, verbatim — compared as-is, case-sensitive, scheme included,
 * because a scheme-bent origin ("http://" for an "https://" site) is a
 * different security context and must not inherit its trust.
 *
 * A null return means "nothing to say": the middleware sends the plain
 * 204 and no browser will believe a credentialed cross-origin request
 * can be made. That silence IS the policy.
 */
export function decidePreflight(origin: string | null): CorsDecision {
  if (!origin) return { preflight: null, listed: false };

  const entry = ALLOWED_ORIGINS.find((e) => e.origin === origin);
  if (!entry) return { preflight: null, listed: false };

  /**
   * ⭐ THE ECHO IS THE CONTRACT. The browser compares the
   * Access-Control-Allow-Origin header against the request's Origin
   * and refuses the exchange unless they match. Echoing the approved
   * origin back — never `*`, never the whole list — is what makes a
   * per-origin allowlist enforceable at all.
   */
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": entry.methods.join(", "),
    /**
     * ⚠️ REQUESTED HEADERS ARE NOT ECHOED. The browser promises the
     * server only the safe set on a preflight unless we name more;
     * naming more would let a script ask for X-Internal-Token style
     * headers we never wanted to promise. The safe headers are enough
     * for every listed integration, and if one is not, the allowlist
     * entry grows — explicitly, with a reason.
     */
    "access-control-allow-headers":
      "content-type, authorization, x-request-id",
  };
  if (entry.maxAgeSeconds) {
    headers["access-control-max-age"] = String(entry.maxAgeSeconds);
  }
  if (entry.withCredentials) {
    headers["access-control-allow-credentials"] = "true";
    /**
     * ⚠️ CREDENTIALS AND ORIGIN MUST BOTH BE SET FOR THE BROWSER.
     * `Access-Control-Allow-Credentials: true` without a matching
     * origin header is rejected by every browser — so the echo above
     * is mandatory here, not optional polish.
     */
  }
  /**
   * ⭐ THE VARY MATTERS FOR THE CDN AND THE BROWSER CACHE. Without
   * `Vary: Origin`, a cache could serve the approved-headers response
   * to a request from a different (blocked) origin — handing a
   * cross-origin read to exactly the caller this module exists to
   * refuse.
   */
  headers["vary"] = "Origin";

  return { preflight: { status: 204, headers }, listed: true };
}

/** The header names this module may emit — used by the middleware and
 *  the gate test to confirm nothing else leaks. */
export const CORS_HEADER_SET = new Set(CORS_HEADER_NAMES);
