/**
 * Ordence — Portal Layout
 * Version: v0.9.0-alpha
 *
 * A separate root-level layout for the external portal, outside the
 * `(crm)` group entirely. External visitors get no application chrome:
 * no navigation, no workspace switcher, no hint of the internal product.
 * They came to read one document.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Document Review",
  description: "Secure document review.",
  // ══════════════════════════════════════════════════════════════
  // NEVER INDEXED.
  //
  // A portal URL contains a live credential. A search engine that
  // crawled one — from a link in a public forum, a pasted URL in an
  // indexed support ticket — would publish working access to a legal
  // contract. `noindex, nofollow` plus `noarchive` is the minimum.
  // ══════════════════════════════════════════════════════════════
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[#FAF8F5]">{children}</div>;
}
