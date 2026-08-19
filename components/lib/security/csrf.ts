/**
 * Ordence — CSRF Verification (Hardening II)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SHAPE OF THE PROBLEM
 * ══════════════════════════════════════════════════════════════════════
 *
 * Cross-site request forgery is what happens when a browser is asked to do
 * something with OUR credentials that the person behind the browser did not
 * ask for: an image tag or a preflighted fetch on another site, and the
 * browser quietly attaches the session cookie. The classic defences are
 * SameSite cookies and the double-submit token; but the attack that neither
 * of those fully covers is the one where the attacker does not need to read
 * anything — they just need to make a state change happen.
 *
 * This module verifies two independent properties before any state-changing
 * request is allowed through:
 *
 *   1. ORIGIN BINDING — for explicit POST endpoints (API routes, webhooks we
 *      control), the `Origin` or `Referer` must resolve to one of the hosts
 *      we actually serve. A request from another site fails closed.
 *
 *   2. SERVER-ACTION DIGEST — Next.js server actions ("use server") carry an
 *      encrypted CSRF digest in the `Server-Action` header when invoked
 *      through the runtime's own protocol. A POST that carries Next.js's
 *      RSC/content-type signature WITHOUT that header is the fingerprint of
 *      a caller reusing our server-action URL from a foreign page. We cannot
 *      decrypt the digest (Next.js keeps the key), but its *presence* is the
 *      contract — and its absence is refusal grounds.
 *
 * Clerk's hosted sign-in and password surfaces verify their own CSRF tokens;
 * we do not duplicate that work here. We verify what *we* own: the surfaces
 * our own code exposes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️  WHY PRESENCE IS THE CHECK, NOT CONTENT
 * ══════════════════════════════════════════════════════════════════════
 *
 * The digest is encrypted with Next.js's signing key; attempting to decrypt
 * it outside the runtime is a fork in the road that leads to either
 * shipping our signing key into application code (a secret that must then
 * be rotated in lockstep with every deploy) or to re-implementing the
 * protocol and drifting out of sync with every Next.js upgrade. The
 * presence check survives both: a forged request cannot produce the header,
 * and a legitimate one always carries it. What the header contains is
 * Next.js's concern.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️  WHY ORIGIN BINDING IS FAIL-CLOSED FOR CROSS-ORIGIN
 * ══════════════════════════════════════════════════════════════════════
 *
 * A missing `Origin` on a POST is not automatically benign: a `<form>`
 * submission without JavaScript carries no Origin. So for navigation-style
 * POSTs we fall back to `Referer`, and only when BOTH are absent do we
 * accept the request as same-site. Browsers that strip Referer on
 * cross-origin navigation also strip Origin; the pair together make a
 * silent downgrade into a cross-site weapon impossible.
 */

import "server-only";

import { readRuntimeEnv } from "@/lib/env";
import { isHostInZone } from "@/lib/tenant";

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS BLOCK REPLACES — EVERY WRITE FROM EVERY TENANT
 *    SUBDOMAIN WAS REFUSED
 * ══════════════════════════════════════════════════════════════════════
 * `resolveAllowedHosts()` built its set from three explicit variables and
 * had no wildcard and no zone derivation. Railway serves
 * `app.ordence.com`, `admin.ordence.com` and `*.ordence.com` from one
 * service, so a POST from `acme.ordence.com` carried an Origin that was
 * in none of them, `verifyCsrf` answered `origin_mismatch`, and
 * `middleware.ts` returned 403 "Cross-site request refused." before
 * Clerk, before routing, before anything.
 *
 * ⚠️ IT WAS INVISIBLE UNTIL SOMEBODY TRIED TO SAVE. GET is exempt at the
 *    top of `verifyCsrf`, so every page in every tenant workspace READ
 *    perfectly and every write died. The product sells "your own
 *    subdomain" and could not deliver a working one.
 *
 * ⭐ THE FIX IS TO DERIVE THE SET FROM THE ZONE, so that any host under
 *    `NEXT_PUBLIC_ZONE_DOMAIN` is same-site BY CONSTRUCTION and nobody
 *    has to remember to add a variable when a tenant signs up. The three
 *    explicit variables are kept as additional entries, because a
 *    deployment that has not set the zone must not change behaviour.
 */

/**
 * ⚠️ READ AT RUNTIME, NOT AT BUILD. `NEXT_PUBLIC_*` names are INLINED BY
 *    NEXT.JS AT BUILD TIME wherever they appear as a literal
 *    `process.env.NEXT_PUBLIC_ZONE_DOMAIN`. The Railway build machine has
 *    no application variables, so that literal would be frozen into the
 *    output as `undefined` and this whole control would silently fall
 *    back to the three-variable behaviour it is replacing — a security
 *    fix that compiles away.
 *
 *    `readRuntimeEnv()` looks the name up through a VARIABLE, which
 *    defeats the substitution. `lib/env.ts` exports it for exactly this
 *    reason and `middleware.ts` carries its own copy for the same one.
 */
function resolveZoneDomain(): string | undefined {
  return readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN");
}

/**
 * The staff console host.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO VARIABLES NAMED THE SAME CONCEPT. THAT IS THE 0091 DEFECT.
 * ══════════════════════════════════════════════════════════════════════
 *   `PLATFORM_HOST`          documented, in `.env.example`, in
 *                            `RAILWAY-VARIABLES-PASTE.txt`, in
 *                            `lib/platform/env-catalog.ts`, and read by
 *                            the console router at `middleware.ts:98`.
 *   `ORDENCE_PLATFORM_HOST`  undocumented, in none of those files, read
 *                            by this module and by nothing else.
 *
 * Two lists that mean one thing, drifting silently, is precisely the
 * shape of the two-reserved-word-lists incident that produced migration
 * 0091 — and it had already produced its own outage here: an operator
 * setting the documented name got no CSRF entry for the console at all.
 *
 * ⭐ CONVERGED, KEEPING BOTH NAMES. `PLATFORM_HOST` first because it is
 *    the one the rest of the product uses; `ORDENCE_PLATFORM_HOST` second
 *    so the LIVE deployment, which may be running on it, does not break
 *    on the deploy that lands this file; `admin.<zone>` last, which is
 *    the same default `middleware.ts` applies, so the two agree without
 *    either of them being configured.
 */
function resolvePlatformHost(): string | undefined {
  const explicit = readRuntimeEnv("PLATFORM_HOST");
  if (explicit) return explicit.toLowerCase();
  /** ⚠️ Legacy name. Kept for backward compatibility, never introduced anew. */
  const legacy = readRuntimeEnv("ORDENCE_PLATFORM_HOST");
  if (legacy) return legacy.toLowerCase();
  const zone = resolveZoneDomain();
  return zone ? `admin.${zone.toLowerCase()}` : undefined;
}

/**
 * The EXPLICIT hosts this deployment answers to.
 *
 * ⚠️ THIS IS NO LONGER THE WHOLE ANSWER, AND CALLERS MUST NOT TREAT IT AS
 *    ONE. A zone is not enumerable — `acme.ordence.com` exists the moment
 *    a customer signs up and no list can be updated in time. Ask
 *    `isAllowedHost()`, which consults this set AND the zone. This
 *    function stays exported because the operator console and the tests
 *    read it to show what is configured.
 */
export function resolveAllowedHosts(): string[] {
  const hosts = new Set<string>();
  const appUrl = readRuntimeEnv("NEXT_PUBLIC_APP_URL");
  if (appUrl) {
    const host = extractHost(appUrl);
    if (host) hosts.add(host);
  }
  const platformHost = resolvePlatformHost();
  if (platformHost) hosts.add(platformHost);
  // Production host without a scheme — the canonical case.
  const prodHost = readRuntimeEnv("APP_HOST");
  if (prodHost) hosts.add(prodHost.toLowerCase());
  if (hosts.size === 0) {
    // No configuration found: refuse nothing silently? No — fail closed is
    // not an option for a header with no configured anchor. Return the
    // request host's own origin instead, which degrades to "same-site only".
    hosts.add("");
  }
  return [...hosts];
}

/**
 * ⭐ THE ONE PREDICATE. Everything that used to ask
 * `resolveAllowedHosts().includes(host)` asks this instead.
 *
 * Order matters only for cost, not for meaning: the explicit set is a
 * handful of strings and the zone test is a string comparison.
 *
 * 🔴 THE ZONE TEST IS `isHostInZone()` FROM `lib/tenant.ts`, WHICH IS THE
 *    SAME FUNCTION THE TENANT ROUTER USES TO DECIDE WHAT RESOLVES. A
 *    second, private copy of "is this host under our zone" living in a
 *    security module is how the set of hosts that ROUTE and the set of
 *    hosts that may WRITE drift apart — and this file would be the half
 *    nobody notices, because the symptom is a 403 on a save.
 *
 * ⚠️ DEPTH: SINGLE LABEL ONLY, DELIBERATELY. `acme.ordence.com` is
 *    allowed; `a.b.ordence.com` is REFUSED. Tenant slugs are one DNS
 *    label by construction (`lib/slug.ts` bans dots because the wildcard
 *    certificate `*.ordence.com` covers exactly one label), so nothing we
 *    serve is ever deeper than one label, and refusing deeper names is
 *    both tighter and free. If a future feature needs `a.b.ordence.com`,
 *    the certificate has to change first and this line should be revisited
 *    then rather than pre-emptively widened now.
 */
let warnedUnconfigured = false;

export function isAllowedHost(
  host: string | null | undefined,
  requestHost?: string | null,
): boolean {
  if (!host) return false;
  const candidate = host.toLowerCase();
  const allowed = resolveAllowedHosts();

  /*
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE UNCONFIGURED DEGRADATION. THIS USED TO BE `return true`.
   * ══════════════════════════════════════════════════════════════════
   * The comment that stood here said the degradation was "same-site
   * only". The code did not compare anything with the request host — it
   * returned true for every candidate. So with `NEXT_PUBLIC_APP_URL`,
   * `PLATFORM_HOST` and `APP_HOST` all unset,
   * `isAllowedHost("evil.example")` was true: `verifyCsrf` accepted a
   * cross-site POST, and `isSuspiciousCrossOrigin` reported false, so
   * the control and the telemetry that would have shown it missing
   * disappeared in the same instant.
   *
   * ⚠️ THE ORIGINAL CONCERN IS REAL AND IS PRESERVED. Failing closed on
   * a missing variable turns one absent env var into a product-wide 403
   * on the first deploy. That is why this is not `return false`.
   *
   * ⭐ SO: DO WHAT THE OLD COMMENT SAID. With a request host to compare
   * against, "unconfigured" means SAME-SITE ONLY, which is a strictly
   * smaller hole than "any site" and costs one string comparison. Only
   * when the caller cannot supply a request host either does this fall
   * back to accepting, and then it says so, once, loudly, because an
   * unconfigured CSRF anchor in production is a real finding and the
   * whole failure above was silent.
   */
  if (allowed.includes("")) {
    if (typeof requestHost === "string" && requestHost.length > 0) {
      return candidate === requestHost.toLowerCase();
    }
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.error(
        "[csrf] No host is configured (NEXT_PUBLIC_APP_URL, PLATFORM_HOST and " +
          "APP_HOST are all unset) and no request host was supplied, so the " +
          "origin check is accepting every origin. Set one of them.",
      );
    }
    return true;
  }

  if (allowed.includes(candidate)) return true;
  return isHostInZone(candidate, resolveZoneDomain());
}

export function extractHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // Relative or malformed — treat as a bare host candidate.
    const trimmed = url.trim().toLowerCase();
    if (/^[a-z0-9.-]+$/.test(trimmed)) return trimmed;
    return null;
  }
}

export type CsrfVerdict =
  | { ok: true; reason: null }
  | { ok: false; reason: "origin_mismatch" | "missing_action_digest" | "suspicious_origin" };

/** POSTs carrying the RSC signature but no server-action digest. */
export function requiresActionDigest(contentType: string | null): boolean {
  if (!contentType) return false;
  const lowered = contentType.toLowerCase();
  return (
    lowered.includes("multipart/form-data") ||
    lowered.includes("application/x-www-form-urlencoded") ||
    lowered.includes("rsc") ||
    lowered.includes("x-component")
  );
}

/**
 * Verify a state-changing request's CSRF posture.
 *
 * `requestHost` is the Host the request arrived at — the middleware injects
 * it as `x-ordence-request-host`; when absent we read `Host` directly,
 * because header-spoofing protection at the edge is a separate control
 * (see `lib/edge/security-headers.ts`).
 *
 * Server-action digests are only checked for bodies that flow through the
 * server-action protocol; webhook callbacks and other public consumers set
 * `expectActionDigest: false` explicitly, since they carry their own
 * signature (Svix, HMAC) and must not be refused for lacking ours.
 */
export function verifyCsrf(args: {
  method: string;
  origin: string | null;
  referer: string | null;
  requestHost: string | null;
  contentType: string | null;
  serverActionHeader: string | null;
  expectActionDigest: boolean;
}): CsrfVerdict {
  const {
    method,
    origin,
    referer,
    requestHost,
    contentType,
    serverActionHeader,
    expectActionDigest,
  } = args;

  // GET/HEAD/OPTIONS carry no session cookie state worth forging.
  if (/^(GET|HEAD|OPTIONS)$/i.test(method)) {
    return { ok: true, reason: null };
  }

  // 1. Origin binding: explicit Origin present → must be one of ours.
  if (origin) {
    const originHost = extractHost(origin);
    /*
     * ⭐ `isAllowedHost` FOLDS THE THREE OLD BRANCHES INTO ONE. It already
     *    answers "explicit host", "under our zone" and the unconfigured
     *    degradation, in that order — see its comment.
     */
    if (originHost && !isAllowedHost(originHost, requestHost)) {
      return { ok: false, reason: "origin_mismatch" };
    }
  } else if (referer) {
    // Navigation-style POST with no Origin: the Referer must not be another
    // site. Empty Referer (privacy tools) is accepted as same-site by the
    // origin binding; the digest check below is what catches the rest.
    const refererHost = extractHost(referer);
    if (refererHost && refererHost !== (requestHost ?? "").toLowerCase()) {
      if (!isAllowedHost(refererHost, requestHost)) {
        return { ok: false, reason: "origin_mismatch" };
      }
    }
  }

  // 2. Server-action digest, when this content type flows through the
  //    protocol that mandates one.
  if (expectActionDigest && requiresActionDigest(contentType) && !serverActionHeader) {
    return { ok: false, reason: "missing_action_digest" };
  }

  return { ok: true, reason: null };
}

/**
 * Is this request a cross-origin navigation that arrived with a spoofable
 * header stripped? Used by middleware to decide whether to refuse before
 * tenant routing — the CSP/CORS layers handle the rest of the perimeter.
 */
export function isSuspiciousCrossOrigin(args: {
  origin: string | null;
  referer: string | null;
  requestHost: string | null;
  method: string;
}): boolean {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(args.method)) return false;
  const originHost = args.origin ? extractHost(args.origin) : null;
  if (originHost) {
    return !isAllowedHost(originHost, args.requestHost);
  }
  const refererHost = args.referer ? extractHost(args.referer) : null;
  if (refererHost && refererHost !== (args.requestHost ?? "").toLowerCase()) {
    return !isAllowedHost(refererHost, args.requestHost);
  }
  return false;
}
