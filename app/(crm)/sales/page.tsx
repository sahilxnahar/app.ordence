/**
 * Ordence — Sales section index
 * Version: v1.37.0-alpha (Mega-wave 1, Batch 35)
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS PAGE DID NOT EXIST, AND WHY THAT MATTERED
 * ══════════════════════════════════════════════════════════════════════
 * `app/(crm)/sales/` held seven working sub-sections — inventory,
 * bookings, leads, partners, brokerage, cancellations, possession — and
 * no index. So `/sales` was a 404, and the land register linked to it as
 * "Projects & units".
 *
 * ⚠️ THE SHAPE OF THE BUG IS THE POINT. Nobody wrote a broken link. Seven
 * pages were built underneath a path that was never given a page, and
 * every gate stayed green: `tsc` sees a valid string, `check:reachability`
 * asks whether server actions have callers, not whether links have
 * destinations. It took a gate that walks the route table to see it.
 *
 * ⭐ AND IT IS DELIBERATELY A DIRECTORY, NOT A DASHBOARD. A landing page
 * that computes counts is a landing page that gets slow and then gets
 * cached and then gets wrong. This one navigates. The screens it points
 * at already carry their own numbers, correctly, over the whole filtered
 * set rather than the page.
 */

import Link from "next/link";
import {
  Building2,
  ClipboardList,
  Handshake,
  KeyRound,
  Percent,
  UserRound,
  XCircle,
} from "lucide-react";

export const dynamic = "force-static";

const SECTIONS = [
  {
    href: "/sales/inventory",
    icon: Building2,
    title: "Projects & units",
    blurb:
      "Every unit and its live status. The board a sales team quotes off, with holds swept on load so a lapsed hold never reads as held.",
  },
  {
    href: "/sales/leads",
    icon: UserRound,
    title: "Leads",
    blurb: "Enquiries, scoring and the pipeline from first contact to booking.",
  },
  {
    href: "/sales/bookings",
    icon: ClipboardList,
    title: "Bookings",
    blurb:
      "Units sold, their payment plans and their demand schedules. One live booking per unit, enforced by the database.",
  },
  {
    href: "/sales/partners",
    icon: Handshake,
    title: "Channel partners",
    blurb: "Brokers, their registrations and the units they have introduced.",
  },
  {
    href: "/sales/brokerage",
    icon: Percent,
    title: "Brokerage",
    blurb: "What commission is owed, on what, and what has been paid.",
  },
  {
    href: "/sales/possession",
    icon: KeyRound,
    title: "Possession",
    blurb: "Handover, snagging and the documents that go with the keys.",
  },
  {
    href: "/sales/cancellations",
    icon: XCircle,
    title: "Cancellations",
    blurb:
      "Bookings that stopped, what is refundable, and what returns the unit to inventory.",
  },
] as const;

export default function SalesIndexPage() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Units, the people buying them, and everything between the first
          enquiry and the keys.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/40"
          >
            <div className="flex items-start gap-3">
              <s.icon
                className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground"
                aria-hidden
              />
              <div className="min-w-0">
                <div className="font-medium">{s.title}</div>
                <p className="mt-1 text-sm text-muted-foreground">{s.blurb}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
