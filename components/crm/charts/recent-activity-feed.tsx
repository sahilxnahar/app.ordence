"use client";

/**
 * Ordence — Recent Activity Feed
 * Version: v0.10.0-alpha
 *
 * The last 24 hours of audit activity, virtualized.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY VIRTUALIZED FOR A LIST THAT IS USUALLY SHORT
 * ══════════════════════════════════════════════════════════════════════
 * A quiet workspace produces a dozen rows a day. A busy one during a
 * migration, a bulk import or an incident produces thousands — and the
 * dashboard is exactly where someone looks when that is happening.
 *
 * Rendering only the visible window means the cost of this component does
 * not depend on how bad the day was. The alternative fails precisely when
 * it is most needed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT SHOWN
 * ══════════════════════════════════════════════════════════════════════
 * The server sends a single derived sentence per event, never the raw
 * `metadata` blob. That column carries recipient email addresses, portal
 * token prefixes and previous field values — none of which belong on a
 * screen the whole team can see, and all of which would arrive here if the
 * action simply passed the column through.
 *
 * External portal actions are marked, because "a client opened the
 * contract" and "Anita opened the contract" are different facts and the
 * distinction is easy to lose in a flat list.
 */

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  FileText,
  ShieldAlert,
  UserCog,
  Globe,
  Trash2,
  PenLine,
  Settings,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { humaniseLabel } from "./use-chart-mode";

export type ActivityItem = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  severity: string;
  createdAt: string;
  actorName: string;
  actorEmail: string | null;
  isExternal: boolean;
  summary: string | null;
};

/* ------------------------------------------------------------------ */
/* PRESENTATION                                                        */
/* ------------------------------------------------------------------ */

function iconForEvent(item: ActivityItem) {
  if (item.isExternal) return Globe;
  if (item.severity === "critical" || item.severity === "warning") return ShieldAlert;

  switch (item.resourceType) {
    case "document": return FileText;
    case "contract": return PenLine;
    case "user": return UserCog;
    case "tenant": return Settings;
    case "portal_link": return Globe;
    default:
      return item.action === "create" ? Plus : item.action === "delete" ? Trash2 : Activity;
  }
}

/**
 * Severity styling.
 *
 * Status colours are reserved and never double as category colours, and
 * every one of them ships beside an icon and a word — never colour alone.
 */
function severityTone(severity: string): string {
  switch (severity) {
    case "critical":
      return "text-destructive";
    case "warning":
      return "text-amber-600 dark:text-amber-400";
    case "notice":
      return "text-foreground";
    default:
      return "text-muted-foreground";
  }
}

/** "3 minutes ago". Recomputed on the client so it is never a stale SSR value. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.floor((Date.now() - then) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(seconds / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Fallback wording when the event has no known summary. */
function describe(item: ActivityItem): string {
  if (item.summary) return item.summary;

  const verb =
    item.action === "create" ? "Created" :
    item.action === "update" ? "Updated" :
    item.action === "delete" ? "Deleted" :
    item.action === "read" ? "Viewed" :
    item.action === "security_event" ? "Security event on" :
    humaniseLabel(item.action);

  return `${verb} ${item.resourceType.replace(/_/g, " ")}`;
}

/* ------------------------------------------------------------------ */
/* COMPONENT                                                           */
/* ------------------------------------------------------------------ */

export function RecentActivityFeed({
  items,
  height = 340,
}: {
  items: ActivityItem[];
  height?: number;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 58;

  // Relative times are computed on the client and refreshed on a timer.
  // Rendering "2 minutes ago" on the server would bake in the build time
  // and then never change, which is worse than showing nothing.
  const [now, setNow] = React.useState<number | null>(null);

  React.useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  });

  const virtualRows = virtualizer.getVirtualItems();

  if (items.length === 0) {
    return (
      <section className="space-y-3" aria-labelledby="activity-heading">
        <div>
          <h3 id="activity-heading" className="text-sm font-semibold">
            Recent activity
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Last 24 hours</p>
        </div>

        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Nothing has happened in the last 24 hours.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3" aria-labelledby="activity-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 id="activity-heading" className="text-sm font-semibold">
            Recent activity
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Last 24 hours</p>
        </div>
        <span className="text-xs text-muted-foreground">
          {items.length} event{items.length === 1 ? "" : "s"}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="overflow-auto rounded-md border border-border"
        style={{ height: Math.min(height, items.length * ROW_HEIGHT + 2) }}
      >
        {/* Sized to the full list so the scrollbar tells the truth about
            how much there is, even though only a window is in the DOM. */}
        <div
          style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
        >
          <ul aria-label="Recent activity">
            {virtualRows.map((virtualRow) => {
              const item = items[virtualRow.index];
              if (!item) return null;

              const Icon = iconForEvent(item);

              return (
                <li
                  key={item.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 flex w-full items-start gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <Icon
                    className={cn("mt-0.5 h-4 w-4 shrink-0", severityTone(item.severity))}
                    aria-hidden="true"
                  />

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="font-medium">{item.actorName}</span>
                      {item.isExternal && (
                        <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          external
                        </span>
                      )}
                    </p>

                    <p className="truncate text-xs text-muted-foreground">
                      {describe(item)}
                    </p>
                  </div>

                  <time
                    dateTime={item.createdAt}
                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                    // The absolute time is always available on hover, so a
                    // relative label never hides when something happened.
                    title={new Date(item.createdAt).toLocaleString("en-IN", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  >
                    {now === null ? "" : relativeTime(item.createdAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Every entry is written to an append-only audit log. Actions taken through a
        client portal link are marked <strong>external</strong>.
      </p>
    </section>
  );
}
