"use client";

import Link from "next/link";
import { BrandLogo } from "@/components/branding/brand-logo";
import { usePathname } from "next/navigation";
import { Icon } from "./icon";
import { cn } from "@/lib/utils";
import type { NavSection } from "@/lib/industry-templates";

/**
 * Industry-aware sidebar. Receives already role-filtered sections from the
 * server layout, so no permission logic runs in the browser.
 */
export function Sidebar({
  sections,
  industryLabel,
  tenantName,
  logoSrc = null,
}: {
  sections: NavSection[];
  industryLabel: string;
  tenantName: string;
  /** Null for a workspace with no logo , the name is shown instead. */
  logoSrc?: string | null;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main navigation"
      className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card"
    >
      <div className="border-b border-border px-4 py-3">
        {/*
              ⚠️ THE NAME IS THE FALLBACK AND IS ALWAYS AVAILABLE. This
              header is how a person knows WHICH WORKSPACE THEY ARE IN; an
              `<img>` that 404s after a bucket move would otherwise leave
              an empty box in the one place that answers that question.
            */}
            <BrandLogo src={logoSrc} tenantName={tenantName} height={24} />
        <p className="truncate text-xs text-muted-foreground">{industryLabel}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section) => (
          <div key={section.id} className="mb-4">
            {section.label && (
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                // Compare pathname only — query strings differentiate filtered
                // views of the same route and must not all light up at once.
                const itemPath = item.href.split("?")[0] ?? item.href;
                const isActive =
                  pathname === itemPath ||
                  (itemPath !== "/" && pathname.startsWith(`${itemPath}/`));

                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isActive
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
