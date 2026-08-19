/**
 * Ordence — Run History
 * Version: v0.24.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS TABLE ANSWERS IS "WHY IS THIS RECORD LIKE THIS?"
 * ══════════════════════════════════════════════════════════════════════
 * It is asked in exactly the situations where somebody would prefer a
 * different answer: a buyer was emailed the wrong figure, a lead was
 * reassigned overnight, a record vanished. The person asking is a sales
 * manager, so "check the server logs" is not an answer.
 *
 * ⚠️ A FAILED ROW NAMES THE STEP IN THE LIST, NOT ONLY IN THE DETAIL.
 * "Failed" on its own sends somebody into a detail page to find out
 * what; "failed at notify_manager" tells them whether it is their
 * problem before they click.
 *
 * ⚠️ `stopped` IS NOT A FAILURE AND IS NOT STYLED AS ONE. A filter that
 * ended a run correctly, having done nothing, is a normal Tuesday. A
 * table that paints it red teaches people to ignore red.
 */

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import type { WorkflowRunStatus } from "@/db/schema/workflows";
import type { WorkflowTriggerType } from "@/lib/workflows/program";
import {
  formatMoment,
  runDuration,
  RUN_STATUS_LABELS,
  RUN_STATUS_STYLES,
} from "./presentation";

export type RunListRow = {
  id: string;
  workflowId: string;
  workflowName: string | null;
  status: WorkflowRunStatus;
  triggerType: WorkflowTriggerType;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stepsExecuted: number;
  error: string | null;
  errorStepKey: string | null;
  stopReason: string | null;
  depth: number;
};

export function RunList({ rows }: { rows: readonly RunListRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium">No runs yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A run appears here the first time a published workflow&apos;s trigger fires.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workflow</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Steps</TableHead>
            <TableHead className="sr-only">Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((run) => {
            const duration = runDuration(run.startedAt, run.finishedAt);
            return (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    href={`/automations/runs/${run.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {run.workflowName ?? "(deleted workflow)"}
                  </Link>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {TRIGGER_CATALOG[run.triggerType].label}
                    {run.depth > 0
                      ? ` · started by another workflow, ${run.depth} deep in the chain`
                      : ""}
                  </p>
                </TableCell>

                <TableCell className="max-w-[24rem]">
                  <span
                    className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${RUN_STATUS_STYLES[run.status]}`}
                  >
                    {RUN_STATUS_LABELS[run.status]}
                  </span>
                  {run.status === "failed" ? (
                    <p className="mt-0.5 text-[11px] text-red-700">
                      {run.errorStepKey ? (
                        <>
                          Failed at{" "}
                          <code className="font-mono font-medium">
                            {run.errorStepKey}
                          </code>
                          :{" "}
                        </>
                      ) : null}
                      {run.error ?? "No reason recorded."}
                    </p>
                  ) : null}
                  {run.status === "stopped" && run.stopReason ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {run.stopReason}
                    </p>
                  ) : null}
                </TableCell>

                <TableCell className="text-xs">
                  {formatMoment(run.startedAt ?? run.queuedAt)}
                </TableCell>

                <TableCell className="text-right text-xs tabular-nums">
                  {duration ?? <span className="text-muted-foreground">—</span>}
                </TableCell>

                <TableCell className="text-right text-xs tabular-nums">
                  {run.stepsExecuted}
                </TableCell>

                <TableCell className="text-right">
                  <Link
                    href={`/automations/runs/${run.id}`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Open<span className="sr-only"> run detail</span>
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
