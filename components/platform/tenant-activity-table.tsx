"use client";

/**
 * Ordence — What the platform did to this workspace, as a real table
 * Version: v1.52.0-alpha (Batch 125)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A CLIENT FILE WHEN EVERY OTHER PANEL IS A SERVER ONE
 * ══════════════════════════════════════════════════════════════════════
 * `DataTable` takes `accessor` and `cell` FUNCTIONS in its column
 * definitions, and a function cannot cross the server→client boundary —
 * React refuses to serialise it. So the column table has to be built on
 * the side of the boundary that consumes it. The rows themselves are
 * plain strings and booleans and cross fine.
 *
 * ⭐ AND IT BUYS THE THING AN AUDIT TRAIL ACTUALLY NEEDS: search and a
 * filter. "Did anybody suspend them in March?" is one keystroke here and
 * a page of scrolling in a plain list.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE POLL IS DELIBERATELY SLOW AND STOPS WHEN NOBODY IS LOOKING
 * ══════════════════════════════════════════════════════════════════════
 * This list changes when a colleague acts on the same workspace during
 * the same call, which is worth seeing without a manual reload — and is
 * not worth a request every few seconds from a tab left open overnight.
 * `useVisiblePoll` handles the hidden-tab half; the interval handles the
 * rest. Not a websocket: see the header of `use-visible-poll.ts`.
 */

import { useRouter } from "next/navigation";
import { DataTable } from "./data-table";
import { Badge } from "@/components/ui/badge";
import { useVisiblePoll } from "./use-visible-poll";

export type ActivityTableRow = {
  id: string;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  reason: string | null;
  severity: string;
  impersonationId: string | null;
  createdAt: string;
};

/**
 * One minute. An audit trail is not a live tile — nobody is watching it
 * for a number to move — but an operator who has been on a call for ten
 * minutes should not be reading a ten-minute-old list either.
 */
const ACTIVITY_POLL_MS = 60_000;

export function TenantActivityTable({ rows }: { rows: readonly ActivityTableRow[] }) {
  const router = useRouter();
  useVisiblePoll(() => router.refresh(), ACTIVITY_POLL_MS);

  return (
    <DataTable
      /*
       * ⚠️ REQUIRED, AND IT NAMESPACES THE QUERY PARAMS. The tab itself
       * lives in `?tab=`; without a distinct id here a sort written by
       * this table could collide with any other table that lands on this
       * screen later.
       */
      id="tenant-activity"
      caption="Every platform action taken against this workspace, newest first."
      rows={rows}
      rowId={(r) => r.id}
      searchable
      searchLabel="Search this workspace's platform activity"
      searchText={(r) =>
        [r.actorEmail, r.action, r.resourceType, r.reason].filter(Boolean).join(" ")
      }
      filters={[
        {
          key: "severity",
          label: "Severity",
          options: [
            { value: "critical", label: "critical" },
            { value: "warning", label: "warning" },
            { value: "info", label: "info" },
          ],
          match: (r, v) => r.severity === v,
        },
        {
          key: "impersonated",
          label: "Taken while impersonating",
          options: [
            { value: "yes", label: "yes" },
            { value: "no", label: "no" },
          ],
          match: (r, v) => (v === "yes") === (r.impersonationId !== null),
        },
      ]}
      defaultSort={{ key: "when", dir: "desc" }}
      emptyTitle="Nobody from the platform has touched this workspace through the console."
      emptyHint="Empty because nothing happened — not because a read failed. A failed read is reported at the top of the page."
      columns={[
        {
          key: "when",
          header: "When",
          sortable: true,
          accessor: (r) => r.createdAt,
          cell: (r) => (
            <span className="whitespace-nowrap text-xs">
              {r.createdAt.slice(0, 16).replace("T", " ")}
            </span>
          ),
        },
        {
          key: "actor",
          header: "Operator",
          sortable: true,
          accessor: (r) => r.actorEmail ?? "",
          cell: (r) => r.actorEmail ?? "unknown operator",
        },
        {
          key: "action",
          header: "Action",
          sortable: true,
          accessor: (r) => r.action,
          cell: (r) => <span className="font-mono text-xs">{r.action}</span>,
        },
        {
          key: "resource",
          header: "On",
          sortable: true,
          accessor: (r) => r.resourceType,
          hideOnMobile: true,
        },
        {
          key: "severity",
          header: "Severity",
          sortable: true,
          accessor: (r) => r.severity,
          /*
           * ⚠️ THE WORD IS THE MEANING. One in twelve Indian men is
           * colour-blind; the red is emphasis on a label that already
           * says "critical" in text.
           */
          cell: (r) => (
            <span className="flex flex-wrap items-center gap-1">
              <Badge variant={r.severity === "critical" ? "destructive" : "outline"}>
                {r.severity}
              </Badge>
              {r.impersonationId ? (
                <Badge variant="destructive">taken while impersonating</Badge>
              ) : null}
            </span>
          ),
        },
        {
          key: "reason",
          header: "Reason given",
          hideOnMobile: true,
          cell: (r) => (
            <span className="text-xs text-muted-foreground">{r.reason ?? "—"}</span>
          ),
        },
      ]}
    />
  );
}
