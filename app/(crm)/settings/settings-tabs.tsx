"use client";

/**
 * The tab strip. A client component only because it needs `usePathname`
 * to know which tab is current — the panels themselves stay on the server.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings", label: "General" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/financial", label: "Financial" },
  { href: "/settings/billing", label: "Billing" },
  // ⚠️ TWO TABS, TWO OWNERS, AND THEY ARE NOT THE SAME THING.
  // "Integrations" is what ORDENCE is configured with (our Resend key,
  // our payment provider) and is identical for every tenant.
  // "Connections" is the customer's OWN accounts on other systems.
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/connections", label: "Connections" },
  { href: "/settings/ai", label: "AI assistant" },
  { href: "/settings/notifications", label: "Notifications" },
  // ⭐ Batch 142. Appearance is a PERSONAL preference stored on the user
  // row, not a workspace setting — it sits here because this is the only
  // settings surface an ordinary member can reach, and the alternative
  // (a separate "my account" area) would be one screen deep for one
  // control.
  { href: "/settings/appearance", label: "Appearance" },
  /*
   * ⭐ WAVE 2E. The WORKSPACE's logo and colour , distinct from
   * "Appearance" one line above, which is a PERSONAL light/dark choice
   * stored on the user row. One is what this company looks like to its
   * customers; the other is what this person's screen looks like. Two
   * tabs, because merging them would put a setting one person changes
   * next to a setting that changes what every customer sees.
   */
  { href: "/settings/branding", label: "Branding" },
  // ⚠️ THE DEFINITIONS, NOT THE RECORDS. `/objects` is where the records
  // live and is reached from the main navigation; this tab is where the
  // shapes are inspected. Two routes, two questions.
  { href: "/settings/objects", label: "Custom objects" },
  // ⭐ Batch 57. Under Settings rather than on each list page: one screen
  // with an entity picker is what keeps "add an importable entity" a
  // table entry in `lib/import/entities.ts` instead of a new page.
  { href: "/settings/import", label: "Import" },
  { href: "/settings/support-access", label: "Support access" },
  // ⭐ Wave 5. Export in every format, and the log of what has been taken.
  // ⚠️ THE TAB AND THE ENGINE LAND IN THE SAME COMMIT, for the reason
  // stated two lines below about Batch H: an export service with no
  // navigation to it is the fourteenth instance of built-and-unreachable
  // in this codebase, and `scripts/check-action-reachability.mjs` exists
  // because the thirteen before it were not noticed.
  { href: "/settings/exports", label: "Export" },
  // ⭐ Batch H. DPDPA 2023 data-principal rights. The tab lands in the SAME
  // commit as the engine behind it, deliberately: 0100 shipped a complete
  // depreciation engine that no navigation reached for four batches, and
  // built-and-unreachable is the same defect as declared-and-unenforced.
  { href: "/settings/privacy", label: "Data principal rights" },
  { href: "/settings/recovery", label: "Recycle bin" },
];

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="border-b border-border">
      <ul className="flex gap-1">
        {TABS.map((tab) => {
          // "/settings" would otherwise match every child route.
          const isActive =
            tab.href === "/settings" ? pathname === "/settings" : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
