/**
 * Ordence — Content-Security-Policy
 * Version: v0.67.0-alpha
 * Runtime: Edge-safe. Pure string logic, no Node APIs, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE WAS NO CSP UNTIL NOW, AND WHY THAT MATTERED
 * ══════════════════════════════════════════════════════════════════════
 * `next.config.ts` has carried eight security headers since Phase 2 —
 * HSTS, nosniff, frame options, referrer policy. All eight are useful and
 * none of them stops the attack that actually matters here.
 *
 * This application renders tenant-authored text in a hundred places:
 * contact names, deal titles, custom-object field values, BOQ line
 * descriptions, document filenames. React escapes all of it, which is the
 * real defence. But React escaping is a property that must hold in EVERY
 * component forever, including the one somebody adds next month with a
 * `dangerouslySetInnerHTML` because a customer wanted rich text in a
 * quotation. CSP is the layer that survives that mistake.
 *
 * The consequence of not having it is specific. A single injected
 * `<script>` on a CRM page runs with the signed-in user's session, and
 * this product's server actions will do anything that user could: move
 * stock, post journal entries, read the vault, invite a new admin. There
 * is no second factor between "script runs" and "tenant owner acts".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NONCE, NOT `unsafe-inline`
 * ══════════════════════════════════════════════════════════════════════
 * A CSP containing `script-src 'unsafe-inline'` blocks nothing. It is the
 * most common shape of deployed CSP and it is decoration.
 *
 * Next.js emits inline bootstrap scripts on every page, so `unsafe-inline`
 * looks like the only option. It is not: Next reads a nonce out of the
 * `Content-Security-Policy` REQUEST header and stamps it onto every script
 * tag it generates. Middleware mints one nonce per request and puts it
 * there. That is the entire mechanism, and it is why `generateNonce()`
 * lives next to this function rather than anywhere convenient.
 *
 * ⚠️ `'strict-dynamic'` IS LOAD-BEARING. Clerk's bundle loads further
 * scripts at runtime, and no host allowlist survives that. `strict-dynamic`
 * says: a script the browser already trusted may load more. Without it the
 * sign-in box breaks and the next person deletes the whole policy.
 *
 * ⚠️ AND `'strict-dynamic'` MAKES HOST ALLOWLISTS IN `script-src` INERT.
 * The `https:` fallback below is there for browsers that do not support
 * `strict-dynamic`, and for nothing else. Do not read it as permission.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT SHIPS REPORT-ONLY, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * An enforcing CSP that is one directive short does not degrade — it
 * white-screens the application for every customer at once, and the only
 * evidence is in each user's browser console. This product has never run
 * behind a CSP, so the true set of required sources is not yet known;
 * it is a belief.
 *
 * Report-Only sends the identical policy and blocks nothing, so violations
 * can be collected from real sessions before anything is enforced.
 * `CSP_ENFORCE=true` on the Worker flips it, with no code change and no
 * redeploy of the bundle. Flip it back the same way.
 */

/** Directive sources that never vary by request. */
const SELF = "'self'";

/**
 * Mint a fresh nonce.
 *
 * ⚠️ ONE PER REQUEST, NEVER CACHED, NEVER DERIVED. A nonce reused across
 * requests — or worse, computed from something an attacker can observe —
 * is exactly equivalent to `unsafe-inline`, while looking rigorous.
 *
 * 16 bytes via `crypto.getRandomValues`, which exists on the Edge runtime.
 * Base64 rather than hex only because it is shorter on the wire.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type CspOptions = {
  /** The per-request nonce from `generateNonce()`. */
  nonce: string;
  /**
   * Development needs `'unsafe-eval'` — the Next dev server's React Refresh
   * runtime uses `eval`. It is NEVER added in production, and the parameter
   * is explicit rather than read from `process.env` inside this function so
   * that a test can prove production does not get it.
   */
  isDev?: boolean;
  /** Where violation reports are POSTed. Omitted when not configured. */
  reportUri?: string;
};

/**
 * Build the policy string.
 *
 * Pure: same inputs, same output, no environment access. Every branch is
 * reachable from a test, which is the only reason the flags are arguments.
 */
export function buildCsp({ nonce, isDev = false, reportUri }: CspOptions): string {
  const scriptSrc = [
    SELF,
    `'nonce-${nonce}'`,
    // See the header: this is what lets Clerk's bundle load its own chunks.
    "'strict-dynamic'",
    // Ignored by any browser that understands `strict-dynamic`. Present as
    // a fallback for those that do not.
    "https:",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ];

  const directives: Array<[string, string[]]> = [
    ["default-src", [SELF]],
    ["script-src", scriptSrc],
    /**
     * ⚠️ `'unsafe-inline'` IS PRESENT FOR STYLES AND ONLY FOR STYLES.
     *
     * Tailwind is compiled to a stylesheet, but React still emits inline
     * `style` attributes for anything computed — the pipeline bars on the
     * dashboard set `width` from a percentage, and there are dozens more.
     * Nonces do not apply to style ATTRIBUTES, only to `<style>` elements,
     * so there is no nonce-shaped answer here short of rewriting every
     * computed style into a class.
     *
     * The exposure is CSS injection, not script execution: data
     * exfiltration through crafted selectors is real but requires the
     * attacker to already control markup, which `script-src` is what
     * prevents. Accepted knowingly, written down rather than silently
     * copied from a blog post.
     */
    ["style-src", [SELF, "'unsafe-inline'", "https://fonts.googleapis.com"]],
    ["font-src", [SELF, "https://fonts.gstatic.com", "data:"]],
    /**
     * `data:` and `blob:` are needed for generated content — chart exports,
     * document previews rendered client-side, and the avatar images Clerk
     * serves. `https:` is broad, but an image source cannot execute.
     */
    ["img-src", [SELF, "data:", "blob:", "https:"]],
    /**
     * ⚠️ THE ONE DIRECTIVE MOST LIKELY TO BREAK IN PRODUCTION.
     *
     * Every fetch the browser makes must be listed: Clerk's API, the
     * telemetry beacon (same origin), and the storage host that signed
     * upload URLs point at. `https:` is deliberately NOT used here —
     * `connect-src` is the directive that governs exfiltration, so a
     * wildcard would give away most of what the policy buys.
     */
    ["connect-src", [SELF, "https://*.clerk.accounts.dev", "https://clerk.ordence.com", "https://*.blob.vercel-storage.com"]],
    /** Clerk renders its components in the page, not a frame; keep this tight. */
    ["frame-src", [SELF, "https://*.clerk.accounts.dev", "https://clerk.ordence.com"]],
    ["worker-src", [SELF, "blob:"]],
    ["manifest-src", [SELF]],
    ["media-src", [SELF, "blob:", "data:"]],
    /**
     * ⚠️ THESE THREE ARE THE CHEAPEST LINES IN THE FILE.
     *
     * `object-src 'none'` kills Flash/plugin vectors outright.
     * `base-uri 'self'` stops an injected `<base>` from silently
     *   repointing every relative script URL on the page — a bypass that
     *   defeats a nonce policy completely.
     * `form-action 'self'` stops an injected form from POSTing a
     *   customer's data somewhere else.
     */
    ["object-src", ["'none'"]],
    ["base-uri", [SELF]],
    ["form-action", [SELF]],
    /** Belt and braces with the X-Frame-Options header already set. */
    ["frame-ancestors", ["'none'"]],
    ["upgrade-insecure-requests", []],
  ];

  const parts = directives.map(([name, sources]) =>
    sources.length === 0 ? name : `${name} ${sources.join(" ")}`,
  );

  if (reportUri) parts.push(`report-uri ${reportUri}`);

  return parts.join("; ");
}

/**
 * Which response header carries the policy.
 *
 * ⚠️ THE REQUEST header is ALWAYS `content-security-policy`, regardless of
 * this, because that is the only name Next.js reads the nonce from. Getting
 * this backwards produces a policy that enforces correctly and strips the
 * nonce off every script tag — i.e. a blank page.
 */
export function cspHeaderName(enforce: boolean): string {
  return enforce ? "content-security-policy" : "content-security-policy-report-only";
}
