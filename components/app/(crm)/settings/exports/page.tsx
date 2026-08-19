/**
 * Ordence — ⭐⭐⭐ EXPORT, AND THE RECORD OF WHAT HAS BEEN EXPORTED
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO PANELS, AND THE SECOND IS THE REASON THE FIRST IS SAFE TO SHIP
 * ══════════════════════════════════════════════════════════════════════
 * The top of this page puts every register in the product one click from
 * a spreadsheet. That is the feature. The bottom of this page is the log
 * of everything anybody has taken, because the same click is also how a
 * customer master leaves a workspace on somebody's last day.
 *
 * ⚠️ THE PAGE AND THE ENGINE LAND IN THE SAME COMMIT. This codebase has
 * shipped a complete depreciation engine that no navigation reached for
 * four batches, thirty-four entitlement keys that nothing gated, and
 * dunning letters that queued and never sent — fourteen instances of the
 * same defect. `scripts/check-action-reachability.mjs` exists because of
 * them, and it is why the route, the tab and the actions are one change.
 */

import { Suspense } from "react";
import { Download, ScrollText, ShieldAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { getExportLog, listExportableDatasets } from "@/server/actions/export";
import { ExportWorkbench } from "./export-workbench";
import { ExportLogTable } from "./export-log-table";

export const dynamic = "force-dynamic";

async function Workbench() {
  const result = await listExportableDatasets();
  if (!result.ok) {
    return <p className="text-sm text-destructive">{result.error}</p>;
  }
  return <ExportWorkbench datasets={result.data} />;
}

async function Log() {
  const result = await getExportLog({ limit: 100 });
  if (!result.ok) {
    /**
     * ⚠️ NOT AN ERROR STATE FOR MOST PEOPLE. `audit:read` is an
     * administrator's permission, and an ordinary member reaching this
     * page should be told the log exists and is not theirs to read —
     * which is a different sentence from "something went wrong".
     */
    return (
      <p className="text-sm text-muted-foreground">
        The export log is visible to roles that can read the audit trail. Every export you take is
        recorded in it whether or not you can see it.
      </p>
    );
  }

  return (
    <ExportLogTable rows={result.data.rows} personalCount={result.data.personalCount} />
  );
}

export default function ExportsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Export"
        description="Take a register out of Ordence as a spreadsheet, a document, a PDF or a file for another system."
      />

      <SectionCard
        title="Export data"
        description="Every format states what it cannot carry before you download it, not after."
      >
        <Suspense
          fallback={
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Download className="h-4 w-4" aria-hidden />
              Loading what you can export…
            </p>
          }
        >
          <Workbench />
        </Suspense>
      </SectionCard>

      <SectionCard
        title="What has been exported"
        description="Who took what, when, and whether personal data was in it. Ordence keeps this record; it never keeps the file."
      >
        <p className="mb-4 flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span>
            Section 8(5) of the Digital Personal Data Protection Act 2023 makes the Data Fiduciary
            answerable for the personal data it discloses. This log is what turns that from a
            promise into an answer.
          </span>
        </p>
        <Suspense
          fallback={
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ScrollText className="h-4 w-4" aria-hidden />
              Loading the export log…
            </p>
          }
        >
          <Log />
        </Suspense>
      </SectionCard>
    </div>
  );
}
