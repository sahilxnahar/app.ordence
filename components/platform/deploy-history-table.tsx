"use client";

/**
 * Ordence — Platform Console · DEPLOY HISTORY, WITH ITS LIMITS ON SCREEN
 * Version: v1.58.0-alpha
 *
 * ⚠️ A CLIENT COMPONENT ONLY BECAUSE `cell` RENDERERS ARE FUNCTIONS, and
 * functions do not cross the server/client boundary as props. The data is
 * read on the server and handed down already shaped.
 */

import { DataTable, type DataTableColumn } from "./data-table";
import {
  DEPLOY_OUTCOME_LABELS,
  DEPLOY_SOURCE_LABELS,
  shortCommit,
  type DeployRow,
} from "@/lib/platform/deploy-history";

export function DeployHistoryTable({ rows }: { rows: readonly DeployRow[] }) {
  const columns: DataTableColumn<DeployRow>[] = [
    {
      key: "version",
      header: "Version",
      accessor: (r) => r.version,
      sortable: true,
      cell: (r) => (
        <span className="font-medium">
          {r.version}
          {r.source === "observed" ? " — running now" : ""}
        </span>
      ),
    },
    {
      key: "commit",
      header: "Commit",
      accessor: (r) => r.commit ?? "",
      // ⚠️ "not injected" rather than an em dash. A dash reads as "none",
      // and the truth is "Railway did not tell this process".
      cell: (r) => <code className="text-xs">{shortCommit(r.commit)}</code>,
    },
    {
      key: "deployedAt",
      header: "Deployed at",
      accessor: (r) => r.deployedAt ?? "",
      sortable: true,
      cell: (r) =>
        r.deployedAt ? (
          <span title="Process start — the closest thing this process knows to a deploy time.">
            {r.deployedAt} (process start)
          </span>
        ) : (
          <span>not recorded anywhere</span>
        ),
      hideOnMobile: true,
    },
    {
      key: "migrations",
      header: "Migrations",
      accessor: (r) => r.migrationRange,
      cell: (r) => <span className="text-xs">{r.migrationRange}</span>,
    },
    {
      key: "outcome",
      header: "Outcome",
      accessor: (r) => r.outcome,
      sortable: true,
      // ⚠️ THE STATE IS A WORD, not a green tick. One in twelve Indian men
      // is colour-blind, and "unknown" is the answer people most need to
      // read here — it must not be conveyed by a pale dot.
      cell: (r) => <span>{DEPLOY_OUTCOME_LABELS[r.outcome]}</span>,
    },
    {
      key: "source",
      header: "Where this row came from",
      accessor: (r) => r.source,
      cell: (r) => <span className="text-xs">{DEPLOY_SOURCE_LABELS[r.source]}</span>,
      hideOnMobile: true,
    },
  ];

  return (
    <DataTable
      id="deploys"
      rows={rows}
      columns={columns}
      rowId={(r) => r.id}
      caption="Deploy records this system can actually see."
      unit="records"
      searchable
      filters={[
        {
          key: "source",
          label: "Row source",
          options: [
            { value: "observed", label: "Observed (live process)" },
            { value: "recorded", label: "Recorded (release note)" },
          ],
          match: (row, value) => row.source === value,
          hint: "Only one row is ever observed: the process serving this page.",
        },
        {
          key: "outcome",
          label: "Outcome",
          options: [
            { value: "running", label: "Running" },
            { value: "unknown", label: "Unknown — not observed" },
          ],
          match: (row, value) => row.outcome === value,
        },
      ]}
      defaultSort={{ key: "version", dir: "desc" }}
      emptyTitle="Nothing readable"
      emptyHint="Neither the running process nor CHANGELOG.md could be read from this build."
    />
  );
}
