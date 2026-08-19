/**
 * Ordence — ⭐ THE EXPORT LOG, AS A TABLE
 * Version: v1.73.0-alpha · Wave 5
 *
 * ⚠️ A SERVER COMPONENT. Nothing here is interactive, and the rows carry
 * the names of the people who ran the exports — data that has no reason
 * to cross into a client bundle.
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
import type { ExportLogRow } from "@/server/export/log";

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ExportLogTable({
  rows,
  personalCount,
}: {
  rows: readonly ExportLogRow[];
  personalCount: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has been exported from this workspace yet. This is an empty log, not a missing one
        — the first export will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {rows.length.toLocaleString("en-IN")} export{rows.length === 1 ? "" : "s"} shown.{" "}
        {personalCount === 0
          ? "None of them contained personal data."
          : `${personalCount.toLocaleString("en-IN")} contained personal data.`}
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Format</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Personal data</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap text-xs">
                  {row.occurredAt.toISOString().replace("T", " ").slice(0, 16)}
                </TableCell>
                <TableCell className="text-xs">{row.actorName}</TableCell>
                <TableCell className="text-xs">{row.subject}</TableCell>
                <TableCell className="text-xs uppercase">{row.format}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {row.rowCount.toLocaleString("en-IN")}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {humanBytes(row.byteCount)}
                </TableCell>
                <TableCell className="text-xs">
                  {row.includesPersonalData ? (
                    /**
                     * ⭐ THE FIELDS, NOT JUST A TICK. "Personal data: yes"
                     * is not what a breach notification under s.8(6) has
                     * to state; "Name, Email, Mobile" is.
                     */
                    <span className="flex flex-wrap gap-1">
                      {row.personalColumns.map((column) => (
                        <Badge key={column} variant="secondary">
                          {column}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {row.outcome === "delivered" ? (
                    <span className="text-muted-foreground">Delivered</span>
                  ) : (
                    <span title={row.failureReason ?? undefined}>
                      <Badge variant="destructive">
                        {row.outcome === "refused" ? "Refused" : "Failed"}
                      </Badge>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
