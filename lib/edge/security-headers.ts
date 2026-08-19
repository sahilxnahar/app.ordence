/**
 * =====================================================================
 * ⭐⭐⭐ SECURITY RESPONSE HEADERS — Wave 7 (Hardening I)
 * =====================================================================
 * v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════
 * `next.config.ts` emits the hard transport headers (HSTS, nosniff,
 * SAMEORIGIN, Referrer-Policy, Permissions-Policy, COOP) for every
 * response rendered by the Next.js server via `headers()`. That covers
 * application HTML and API responses served by route handlers — but
 * NOT the responses the edge middleware itself synthesises:
 *
 *   - a rate-limited 429,
 *   - a body-limit 413,
 *   - a tenant refusal, a CSP refusal, the platform 404,
 *   - the sign-in redirect and the JSON 401/403.
 *
 * Those are built with `new NextResponse(...)` and never pass through
 * `headers()`, so an attacker probing a refused endpoint historically
 * saw NO hardening headers at all — a 429 that leaks X-Powered-By's
 * absence tells them less, but the HSTS absence tells them the request
 * never reached a hardened surface, and the missing X-Frame-Options
 * on a 401 page means the page itself can be framed.
 *
 * This module is the SINGLE source of truth for those headers.
 * `next.config.ts` and the middleware read the SAME array, so the two
 * surfaces can never drift apart — a header added here is added
 * everywhere, and a header removed here is removed everywhere.
 *
 * ⚠️ CSP IS DELIBERATELY NOT HERE. The Content-Security-Policy is a
 * per-request nonce policy built in `lib/security/csp.ts` and applied
 * by `withCsp()` in the middleware; `headers()` sets its own variant
 * for rendered pages. One header name with two different values in
 * one response is a browser-enforced blank page, so the CSP lives in
 * exactly one place — `csp.ts` — and never in this array.
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ RUN ORDER MATTERS FOR THE TEST, NOT THE BROWSER. `next.config.ts`
 * reads `SECURITY_HEADERS` from this module at build time; the
 * middleware reads it at runtime. If the two ever disagree, the
 * consistency test in `tests/security/security-headers-consistency.test.ts`
 * fails the build — that is the property this module exists to make
 * checkable.
 * =====================================================================
 */

export const SECURITY_HEADERS: Array<{ key: string; value: string }> = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

/** Stricter overrides for the external portal surface — see next.config.ts. */
export const PORTAL_OVERRIDE_HEADERS: Array<{ key: string; value: string }> = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
  { key: "X-Frame-Options", value: "DENY" },
];

/**
 * Stamp every hardening header onto a response. Idempotent by design —
 * calling it twice with the same response sets the same values, so any
 * call site can apply it unconditionally without caring whether some
 * other path already did.
 */
export function applySecurityHeaders<T extends Response>(res: T): T {
  for (const { key, value } of SECURITY_HEADERS) res.headers.set(key, value);
  return res;
}
