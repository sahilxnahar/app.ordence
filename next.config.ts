import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Security headers applied to every response.
 * Ref: Blueprint Part "Browser Security Headers".
 */
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

const nextConfig: NextConfig = {
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
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "X-Frame-Options", value: "DENY" },
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
