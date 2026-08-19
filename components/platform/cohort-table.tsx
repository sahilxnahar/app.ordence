"use client";

/**
 * Ordence — ⭐⭐ JOIN-MONTH COHORTS, SORTABLE, AND THE SORT IS THE URL
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY EVERY CELL PRINTS ITS DENOMINATOR
 * ══════════════════════════════════════════════════════════════════════
 * This platform has months with four signups in them. "75% completed" is
 * three workspaces, and a rate without its denominator is a sentence
 * somebody repeats in a meeting with no way to check it. So every derived
 * number on this table is rendered as `n of m`, and the median refuses to
 * print at all below `MIN_COHORT_FOR_MEDIAN` — in words, not by greying
 * out, because roughly one in twelve Indian men is colour-blind.
 *
 * ⚠️ `consoleHref` COMES FROM `@/lib/platform/console-paths`. Importing
 * it from `console-href` fails `check-server-boundaries` the moment a
 * client file does it; `isConsoleHost` arrives as a prop from the page.
 */

import { DataTable, type DataTableColumn } from "@/components/platform/data-table";
import { Badge } from "@/components/ui/badge";
import {
  MIN_COHORT_FOR_MEDIAN,
  medianWord,
  rateWord,
  type CohortRow,
} from "@/lib/platform/cohorts";

export function CohortTable({
  rows,
  totalWorkspaces,
  truncated,
}: {
  rows: readonly CohortRow[];
  totalWorkspaces: number;
  truncated: boolean;
}) {
  const columns: readonly DataTableColumn<CohortRow>[] = [
    {
      key: "cohort",
      header: "Joined",
      // ⚠️ Sorts on `2026-03`, not on "March 2026". The label sorts
      // alphabetically, which puts April before January in every year.
      accessor: (r) => r.key,
      sortable: true,
      cell: (r) => <span className="font-medium">{r.label}</span>,
    },
    {
      key: "created",
      header: "Workspaces created",
      accessor: (r) => r.created,
      sortable: true,
      align: "right",
      cell: (r) => <span className="tabular-nums">{r.created}</span>,
    },
    {
      key: "completed",
      header: "Completed onboarding",
      /*
       * ⚠️ SORTS ON THE RATE, NOT THE COUNT, because "which month
       * onboarded best" is the question — and the count column already
       * exists beside it. The CELL still carries both numbers, so a month
       * that sorts to the top on 3-of-4 cannot be mistaken for a good one.
       */
      accessor: (r) => r.completionRate ?? 0,
      sortable: true,
      align: "right",
      cell: (r) => <span className="tabular-nums">{rateWord(r.completed, r.created)}</span>,
    },
    {
      key: "active",
      header: "Still active",
      accessor: (r) => r.stillActive,
      sortable: true,
      align: "right",
      cell: (r) => (
        <span className="tabular-nums">{rateWord(r.stillActive, r.created)}</span>
      ),
    },
    {
      key: "median",
      header: "Median days to activation",
      /*
       * 🔴 SUPPRESSED ROWS SORT LAST IN BOTH DIRECTIONS IS NOT ACHIEVABLE
       * with one accessor, so they sort as blank — `DataTable` treats
       * null as blank and keeps it out of the way of real values. What
       * must never happen is a suppressed cohort sorting as `0` and
       * appearing to be the fastest month on record.
       */
      accessor: (r) => r.medianDaysToActivation,
      sortable: true,
      align: "right",
      cell: (r) =>
        r.medianSuppressed ? (
          // ⭐ THE WORD, NOT AN EMPTY CELL. An empty cell reads as a bug;
          // "Too few to say" reads as a decision, which it is.
          <Badge variant="secondary" className="font-normal">
            {medianWord(r)}
          </Badge>
        ) : (
          <span className="tabular-nums">{medianWord(r)}</span>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      {truncated ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          Truncated: not every workspace was read, so the oldest cohorts on this
          table are incomplete. Treat the trend, not the totals, as unreliable.
        </p>
      ) : null}

      <DataTable
        id="cohort"
        rows={rows}
        columns={columns}
        rowId={(r) => r.key}
        caption={`${rows.length} monthly cohorts covering ${totalWorkspaces} workspaces.`}
        unit="cohorts"
        mode="client"
        /*
         * ⭐ NEWEST FIRST, because the question is "is onboarding getting
         * better" and the answer lives in the most recent months. Any
         * column re-sorts, and the sort lands in the query string — so a
         * view of "worst completion rate first" is a link somebody can
         * paste into a ticket rather than twelve clicks of instructions.
         */
        defaultSort={{ key: "cohort", dir: "desc" }}
        searchable
        searchLabel="Find a month"
        searchText={(r) => `${r.label} ${r.key}`}
        emptyTitle="No workspaces yet"
        emptyHint="Cohorts appear as soon as the first workspace is provisioned."
      />

      <p className="text-xs text-muted-foreground">
        Every rate is printed as <span className="font-medium">n of m</span> on
        purpose. A month with four signups can read 75% and mean three
        workspaces. The median is withheld below {MIN_COHORT_FOR_MEDIAN}{" "}
        completed workspaces in a cohort: with fewer than that, one customer who
        finished late moves it by a week and there is no trend to see.
      </p>
    </div>
  );
}
