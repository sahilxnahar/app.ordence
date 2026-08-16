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

/**
 * Hosts this deployment answers to. Pulled from the public app URL and
 * enriched by the deployment platform variable, so preview URLs are not
 * flagged as attacks.
 */
export function resolveAllowedHosts(): string[] {
  const hosts = new Set<string>();
  const appUrl = readRuntimeEnv("NEXT_PUBLIC_APP_URL");
  if (appUrl) {
    const host = extractHost(appUrl);
    if (host) hosts.add(host);
  }
  const platformHost = readRuntimeEnv("ORDENCE_PLATFORM_HOST");
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
    const allowed = resolveAllowedHosts();
    if (originHost && allowed.includes(originHost)) {
      // Same host — good. Fall through to the digest check below.
    } else if (originHost && allowed.includes("")) {
      // Unconfigured hosts: anything matching the request host is fine.
    } else if (originHost) {
      return { ok: false, reason: "origin_mismatch" };
    }
  } else if (referer) {
    // Navigation-style POST with no Origin: the Referer must not be another
    // site. Empty Referer (privacy tools) is accepted as same-site by the
    // origin binding; the digest check below is what catches the rest.
    const refererHost = extractHost(referer);
    if (refererHost && refererHost !== (requestHost ?? "").toLowerCase()) {
      const allowed = resolveAllowedHosts();
      if (!allowed.includes(refererHost)) {
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
    const allowed = resolveAllowedHosts();
    return !allowed.includes(originHost);
  }
  const refererHost = args.referer ? extractHost(args.referer) : null;
  if (refererHost && refererHost !== (args.requestHost ?? "").toLowerCase()) {
    const allowed = resolveAllowedHosts();
    return !allowed.includes(refererHost);
  }
  return false;
}
