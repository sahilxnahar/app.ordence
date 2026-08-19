/**
 * Ordence — ⭐⭐ WHICH OF MY UPLOADS DID NOT FINISH
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS PANEL EXISTS FOR THE UNFINISHED RUNS AND NOTHING ELSE
 * ══════════════════════════════════════════════════════════════════════
 * A completed migration needs no screen — the records are in the product
 * and the customer can see them. The run that lost 1,600 rows to a closed
 * laptop needs one, because there is otherwise NOTHING anywhere that says
 * so: the browser that was doing the chunking is gone, and the data looks
 * plausible.
 *
 * ⚠️ SO THE UNFINISHED ONES ARE SHOWN FIRST AND IN RED, and every one
 * carries the sentence `server/import/runs.ts` wrote when it closed —
 * including how many rows never arrived and what to do about it.
 *
 * ⭐ AND THE REMEDY IS ALWAYS THE SAME AND ALWAYS SAFE: upload the same
 * file again. Every entity declares a natural key, so rows already here
 * are recognised rather than duplicated.
 */

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ImportRunView } from "@/server/import/runs";

export function ImportRunsPanel({ runs }: { runs: readonly ImportRunView[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has been imported into this workspace yet. This is an empty list, not a
        missing one.
      </p>
    );
  }

  /**
   * ⚠️ SORTED BY WHETHER THEY FINISHED, NOT ONLY BY TIME. A run that lost
   * rows three weeks ago is more urgent than one that completed this
   * morning, and a plain reverse-chronological list buries it.
   */
  const ordered = [...runs].sort((a, b) => {
    const aBad = a.status !== "completed" ? 0 : 1;
    const bBad = b.status !== "completed" ? 0 : 1;
    if (aBad !== bBad) return aBad - bBad;
    return b.startedAt.getTime() - a.startedAt.getTime();
  });

  const unfinished = ordered.filter((r) => r.status !== "completed").length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {unfinished === 0
          ? `${runs.length} import${runs.length === 1 ? "" : "s"}, all of which accounted for every row.`
          : `${unfinished} of ${runs.length} imports did not account for every row. Those are listed first.`}
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>What</TableHead>
              <TableHead>File</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((run) => {
              const accounted = run.rowsWritten + run.rowsSkipped + run.rowsFailed;
              const missing = run.expectedRows - accounted;
              return (
                <TableRow key={run.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {run.startedAt.toISOString().replace("T", " ").slice(0, 16)}
                  </TableCell>
                  <TableCell className="text-xs">{run.entityKey}</TableCell>
                  <TableCell className="text-xs">
                    {run.sourceName ?? "—"}
                    <span className="ml-1 uppercase text-muted-foreground">
                      {run.sourceFormat}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {run.rowsWritten.toLocaleString("en-IN")} of{" "}
                    {run.expectedRows.toLocaleString("en-IN")}
                  </TableCell>
                  <TableCell className="text-xs">
                    {run.status === "completed" ? (
                      <span className="text-muted-foreground">
                        Every row accounted for
                      </span>
                    ) : run.status === "running" ? (
                      <Badge variant="secondary">In progress</Badge>
                    ) : (
                      <span className="space-y-1">
                        <Badge variant="destructive">
                          {missing.toLocaleString("en-IN")} rows never arrived
                        </Badge>
                        {/*
                          ⭐ THE REMEDY, ON THE ROW. A status with no next
                          step is a status the customer reads twice and
                          then raises a ticket about.
                        */}
                        {run.stoppedReason ? (
                          <span className="block text-muted-foreground">
                            {run.stoppedReason}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
