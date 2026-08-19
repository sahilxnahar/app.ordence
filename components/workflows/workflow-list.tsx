/**
 * Ordence — The Automations List
 * Version: v0.24.0-alpha
 *
 * Pure presentation over data the page already decided to show. No
 * fetching, no server actions, no privilege of its own.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE STATUS COLUMN IS THREE FACTS, NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * A workflow runs only when it has an ACTIVE VERSION and the kill switch
 * is on. Those are separate, deliberately — the switch exists so that an
 * automation misbehaving at 6pm can be stopped without archiving a
 * version or editing a definition.
 *
 * A list that collapses them into "Active/Inactive" is how somebody
 * spends an afternoon debugging a workflow that was simply switched off.
 * So `workflowState` reports four states and each one is a sentence.
 */

import Link from "next/link";
import { Pencil } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { TRIGGER_CATALOG } from "@/lib/workflows/triggers";
import { describeCron } from "@/lib/workflows/cron";
import type { WorkflowTriggerType } from "@/lib/workflows/program";
import type { WorkflowRunStatus } from "@/db/schema/workflows";
import {
  formatMoment,
  RUN_STATUS_LABELS,
  RUN_STATUS_STYLES,
  workflowState,
  WORKFLOW_STATE_LABELS,
  WORKFLOW_STATE_STYLES,
} from "./presentation";

export type WorkflowListRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  archivedAt: string | null;
  activeVersion: number | null;
  draftVersion: number | null;
  activeTrigger: WorkflowTriggerType | null;
  /** The trigger of whatever version is being described. */
  triggerSummary: string;
  lastRunAt: string | null;
  lastRunStatus: WorkflowRunStatus | null;
  recentRunCount: number;
};

export function WorkflowList({
  rows,
  runWindow,
}: {
  rows: readonly WorkflowListRow[];
  runWindow: number;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium">No automations yet.</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          An automation watches for something happening — a lead changing, a schedule
          coming round — and then does a short list of things. Nothing runs until a
          version is published.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead className="text-right">Recent runs</TableHead>
            <TableHead className="sr-only">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const state = workflowState({
              archivedAt: row.archivedAt,
              isEnabled: row.isEnabled,
              activeVersion: row.activeVersion,
            });

            return (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/automations/${row.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {row.name}
                  </Link>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {row.key}
                  </p>
                  {row.description ? (
                    <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                      {row.description}
                    </p>
                  ) : null}
                </TableCell>

                <TableCell>
                  <span
                    className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${WORKFLOW_STATE_STYLES[state]}`}
                  >
                    {WORKFLOW_STATE_LABELS[state]}
                  </span>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {row.activeVersion !== null
                      ? `Version ${row.activeVersion} is live`
                      : "Nothing published"}
                    {row.draftVersion !== null
                      ? ` · draft ${row.draftVersion} in progress`
                      : ""}
                  </p>
                </TableCell>

                <TableCell className="max-w-[18rem]">
                  <p className="text-xs">{row.triggerSummary}</p>
                </TableCell>

                <TableCell>
                  {row.lastRunAt ? (
                    <>
                      <p className="text-xs">{formatMoment(row.lastRunAt)}</p>
                      {row.lastRunStatus ? (
                        <span
                          className={`mt-0.5 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${RUN_STATUS_STYLES[row.lastRunStatus]}`}
                        >
                          {RUN_STATUS_LABELS[row.lastRunStatus]}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Never run</span>
                  )}
                </TableCell>

                <TableCell className="text-right text-xs tabular-nums">
                  {row.recentRunCount.toLocaleString("en-IN")}
                </TableCell>

                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm" className="h-8">
                    <Link href={`/automations/${row.id}`}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      Open
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/*
        ⚠️ THE COUNT IS SCOPED, AND THE SCOPE IS STATED. A column headed
        "Runs" showing a number drawn from the last N runs in the
        workspace is a lie in a table cell; naming the window costs one
        line and makes the number usable.
      */}
      <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        &ldquo;Recent runs&rdquo; counts this workflow&apos;s share of the most recent{" "}
        {runWindow.toLocaleString("en-IN")} runs in this workspace, not its lifetime
        total. Open a workflow for its full history.
      </p>
    </div>
  );
}

/** A sentence describing what sets a workflow off. */
export function triggerSummary(
  triggerType: WorkflowTriggerType | null,
  config: { recordType?: string; watchFields?: string[]; cron?: string; timezone?: string } | null,
): string {
  if (!triggerType) return "No published trigger yet.";

  const definition = TRIGGER_CATALOG[triggerType];

  // ⚠️ The list view knows the trigger TYPE of the live version but not
  // its configuration — `listWorkflows` deliberately does not load every
  // version's JSON to draw a table. Saying less is correct here; guessing
  // "On a schedule — none set" for a workflow that has one would be worse
  // than saying "On a schedule".
  if (!config) return definition.label;

  if (triggerType === "scheduled") {
    const cron = config?.cron;
    return cron
      ? `${describeCron(cron)} (${config?.timezone ?? "UTC"})`
      : "On a schedule — none set.";
  }

  if (definition.recordScoped) {
    const noun = config?.recordType ?? "record";
    const watched = config?.watchFields ?? [];
    if (triggerType === "record_updated") {
      return watched.length > 0
        ? `When a ${noun} changes: ${watched.join(", ")}`
        : `When a ${noun} changes in ANY way`;
    }
    return `${definition.label.replace("a record", `a ${noun}`)}`;
  }

  return definition.label;
}
