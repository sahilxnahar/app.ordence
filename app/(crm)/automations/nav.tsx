"use client";

/**
 * Ordence — Automations Sub-navigation
 * Version: v0.24.0-alpha
 *
 * Four surfaces, one strip. Real links rather than a tab widget, because
 * each one is a route with its own data and its own URL — a person
 * sending "look at this failed run" to a colleague needs the address bar
 * to mean something.
 *
 * `aria-current="page"` rather than a colour alone, for the same reason
 * the badges everywhere else carry words.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/automations", label: "Automations", exact: true },
  { href: "/automations/runs", label: "Run history", exact: false },
  { href: "/automations/approvals", label: "Approvals", exact: false },
] as const;

export function AutomationsNav() {
  const pathname = usePathname() ?? "/automations";

  return (
    <nav aria-label="Automations sections" className="flex gap-1">
      {LINKS.map((link) => {
        const active = link.exact
          ? pathname === link.href
          : pathname.startsWith(link.href);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={[
              "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
