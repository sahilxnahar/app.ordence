import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * ⭐⭐⭐ SINGLE SOURCE OF TRUTH — Wave 7 (Hardening I)
 *
 * The hard transport headers are owned by `lib/edge/security-headers.ts`.
 * The edge middleware reads the SAME array at runtime for the responses it
 * synthesises itself (413, 429, 404, 401, 403, redirects), so the two
 * surfaces can never drift: one array, two read sites, and one
 * consistency test — `tests/security/security-headers-consistency.test.ts`.
 *
 * This file only re-exports it into the build-time `headers()` config.
 * CSP is deliberately not in that array — it is a per-request nonce
 * policy built by `lib/security/csp.ts` and attached by the middleware.
 */
import { SECURITY_HEADERS, PORTAL_OVERRIDE_HEADERS } from "@/lib/edge/security-headers";
const securityHeaders = SECURITY_HEADERS;

const nextConfig: NextConfig = {
  /**
   * ══════════════════════════════════════════════════════════════════════
   * 🔴 WAVE 0 , THE BUILD RAN OUT OF HEAP, AND IT WAS SIZE AND NOTHING ELSE
   * ══════════════════════════════════════════════════════════════════════
   * v1.88.0-alpha failed on Railway with:
   *
   *     FatalProcessOutOfMemory
   *     process "sh -c npm run build" did not complete successfully: exit 134
   *
   * ⚠️ EXIT 134 IS A HEAP ABORT, NOT A COMPILE FAILURE. `tsc --noEmit` was
   * clean and all 29 gates passed on the same tree. v1.84.1 built in three
   * minutes; nothing about v1.88.0 is special except how much of it there is.
   *
   * Measured on the tree that failed:
   *
   *     routes (page.tsx)                                    218
   *     TypeScript files                                   1,377
   *     schema files                                          70
   *     modules importing the whole `@/db/schema` barrel      108
   *
   * 🔴 THE LAST NUMBER IS THE CAUSE. Next builds each of 218 routes, and
   *    108 modules pull all 70 schema files in transitively, so peak heap
   *    during "Collecting page data" grows with the PRODUCT of the two.
   *
   * ⚠️ THIS FLAG IS THE SMALLER HALF OF THE FIX AND IS NOT A CURE. It tells
   * webpack to release the module graph between compilations, which lowers
   * the peak; it does not stop the peak growing. The real repair is to split
   * the schema barrel so a route that imports `companies` stops importing
   * payroll, and that is a change across 108 files , a wave of its own.
   *
   * ⭐ THE OTHER HALF IS `NODE_OPTIONS=--max-old-space-size` on the BUILD,
   * in `railway.json`. Neither alone was trusted to be enough, and the one
   * that can be verified locally is the one in `railway.json` , this one
   * cannot be, because `next build` OOMs in the 8 GB container this repo is
   * assembled in and always has.
   */
  experimental: {
    webpackMemoryOptimizations: true,
  },

  reactStrictMode: true,
  poweredByHeader: false,
  // Never ship source maps to the browser in production (IP protection).
  productionBrowserSourceMaps: false,
  // Keep server-only packages out of the client bundle.
  serverExternalPackages: ["@neondatabase/serverless"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },

      // ══════════════════════════════════════════════════════════════
      // THE EXTERNAL PORTAL (Phase 9) — STRICTER THAN EVERYWHERE ELSE
      // ══════════════════════════════════════════════════════════════
      // A portal URL contains a live 256-bit credential IN THE PATH.
      // That changes what the default headers are worth:
      //
      //   Referrer-Policy: the global `strict-origin-when-cross-origin`
      //     withholds the path cross-origin but still sends the FULL URL
      //     — token and all — on same-origin navigations, and to any
      //     `Referer`-honouring resource. `no-referrer` sends nothing,
      //     ever. The realistic leak for a bearer token in a URL is a
      //     `Referer` header, not brute force, so this matters more than
      //     the entropy does.
      //
      //   X-Robots-Tag: a crawler that reached a portal URL — from a
      //     pasted link in an indexed forum or support ticket — would
      //     publish working access to a legal contract. The layout also
      //     sets robots metadata; this header covers non-HTML responses
      //     such as document downloads, which carry no meta tags.
      //
      //   X-Frame-Options DENY: stricter than the global SAMEORIGIN.
      //     Nothing should ever frame a signing page — clickjacking a
      //     signature is precisely the attack worth ruling out.
      // ══════════════════════════════════════════════════════════════
      {
        source: "/portal/:path*",
        headers: [
          ...securityHeaders,
          ...PORTAL_OVERRIDE_HEADERS,
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SENTRY — v0.95.0
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `productionBrowserSourceMaps: false` ABOVE IS UNCHANGED, AND THE TWO
 *    SETTINGS ARE NOT IN CONFLICT.
 *
 * That flag stops maps being SERVED TO BROWSERS, which is the IP
 * protection it was added for. Sentry's upload does something different:
 * maps are generated at build time, uploaded to Sentry, and then deleted
 * from the output. Stack traces become readable in Sentry, and a stranger
 * hitting app.ordence.com still cannot download the sources.
 *
 * ⚠️ `widenClientFileUpload: false` — the wider mode uploads more bundles
 *    for marginally better traces and materially longer builds. Yours is
 *    already 50–106 seconds; this is not the place to spend more.
 */
const sentryBuildOptions = {
  org: "ordence",
  project: "javascript-nextjs",

  /**
   * ⚠️ UPLOAD ONLY WHEN A TOKEN EXISTS. Without `SENTRY_AUTH_TOKEN` the
   * plugin logs a warning and continues — so `npm run build` works on
   * this machine, in CI, and on Railway before the token is ever set.
   * A build that FAILS because a monitoring vendor is unconfigured is a
   * build that gets the monitoring removed.
   */
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.SENTRY_AUTH_TOKEN,

  widenClientFileUpload: false,

  /**
   * ⚠️ WAS `disableLogger: true` — THE SDK DEPRECATED IT AND SAID SO ON
   * EVERY BUILD. A deprecation warning that is left in place stops being
   * read, and then the one that matters is in the same list.
   *
   * Same effect: strip the SDK's debug logging out of the browser
   * bundle. Nobody debugging Ordence reads Sentry's own console noise,
   * and it is dead weight on every page load.
   */
  webpack: { treeshake: { removeDebugLogging: true } },

  /**
   * ⭐ Routes browser events through your own domain, so an ad-blocker
   * does not silently discard the errors of the users most likely to
   * have one.
   */
  tunnelRoute: "/monitoring",

  sourcemaps: {
    /** Deleted after upload — never served, never in the image. */
    deleteSourcemapsAfterUpload: true,
  },
};

export default withSentryConfig(nextConfig, sentryBuildOptions);
