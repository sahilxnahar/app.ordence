/**
 * Ordence — The Platform Action Register, Rendered
 * Version: v0.29.0-alpha (Phase 29)
 *
 * A server component: no state, no handlers, nothing to ship to the
 * browser. The register has to render on the day the bundle is broken.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY IN EVERY ROW
 * ══════════════════════════════════════════════════════════════════════
 *   • THE JUSTIFICATION, IN FULL AND UNTRUNCATED. It is the entire value
 *     of the row six months later. A log that elides the sentence
 *     somebody typed keeps the shape of accountability and throws away
 *     the content.
 *
 *   • THE GRADE THE OPERATOR HELD AT THE TIME. Grades change; the row
 *     must keep saying what it was when the action happened.
 *
 *   • "YOU" ON YOUR OWN ROWS. Seeing your own trail next to everyone
 *     else's is the cheapest way to make the logging real — a log nobody
 *     reads is a log nobody notices has stopped working.
 *
 * ⚠️ WHAT IS NOT HERE AND MUST NEVER BE: a raw search term. Terms are
 * masked by `maskSearchTerm()` before they are written, because a
 * verbatim search log across every customer is itself an unbounded copy
 * of customer identities. If a term ever appears in this table, the
 * masking has regressed.
 */

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { PlatformActionRow } from "@/server/platform/action-log";

export function ActionLogTable({ rows }: { rows: PlatformActionRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No entries in this window. On a quiet week that is the expected answer — this
        register only holds actions that belong to no single workspace.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Operator</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Severity</TableHead>
          <TableHead>Results</TableHead>
          <TableHead>Reason given</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} data-testid={`action-${row.id}`}>
            <TableCell className="whitespace-nowrap text-xs">
              {row.createdAt.slice(0, 16).replace("T", " ")}
            </TableCell>

            <TableCell>
              <div className="flex items-center gap-2 text-sm">
                {row.actorEmail}
                {row.isYou ? <Badge variant="secondary">you</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {row.actorGrade} · {row.ipAddress ?? "no address recorded"}
              </div>
            </TableCell>

            <TableCell>
              <div className="font-mono text-xs">{row.action}</div>
              <div className="text-xs text-muted-foreground">{row.resourceType}</div>
            </TableCell>

            <TableCell>
              {/* The word carries the meaning; the variant is emphasis only. */}
              <Badge
                variant={
                  row.severity === "critical"
                    ? "destructive"
                    : row.severity === "warning"
                      ? "outline"
                      : "secondary"
                }
              >
                {row.severity}
              </Badge>
            </TableCell>

            <TableCell className="tabular-nums text-xs">
              {row.resultCount === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                `${row.resultCount} row${row.resultCount === 1 ? "" : "s"} seen`
              )}
            </TableCell>

            {/* Untruncated on purpose. See the header. */}
            <TableCell className="max-w-md text-xs">{row.justification}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
