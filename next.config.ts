import type { NextConfig } from "next";

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

export default nextConfig;
