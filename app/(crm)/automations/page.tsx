/**
 * Ordence — Automations List
 * Version: v0.24.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO READS, ONE TABLE, AND THE SECOND ONE IS HONEST ABOUT ITS SCOPE
 * ══════════════════════════════════════════════════════════════════════
 * `listWorkflows` gives the definitions. It does not give a run count,
 * because a `count(*)` over run history per workflow on every page load
 * is the query that gets slower every day this feature is used.
 *
 * So the recent-runs column is a tally over the most recent runs in the
 * workspace, and the table SAYS SO underneath. A number in a column
 * headed "Runs" that silently means something narrower is a lie somebody
 * will quote in a meeting.
 */

import { Suspense } from "react";
import { listWorkflowRuns, listWorkflows, createWorkflow } from "@/server/actions/workflows";
import {
  WorkflowList,
  triggerSummary,
  type WorkflowListRow,
} from "@/components/workflows/workflow-list";
import { CreateWorkflowDialog } from "@/components/workflows/create-workflow-dialog";
import { Refusal } from "./refusal";

export const dynamic = "force-dynamic";

const RUN_WINDOW = 200;

export default function AutomationsPage() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {/*
          ⚠️ The server action is PASSED to the client component, not
          imported by it. `server/actions/workflows.ts` reaches the
          database at module scope; importing it from a `"use client"`
          file would drag the whole server graph toward the bundle and
          make the component untestable outside a provisioned
          environment.
        */}
        <CreateWorkflowDialog onCreate={createWorkflow} />
      </div>

      <Suspense fallback={<TableSkeleton />}>
        <ListView />
      </Suspense>
    </div>
  );
}

async function ListView() {
  const [workflows, runs] = await Promise.all([
    listWorkflows(),
    listWorkflowRuns({ limit: RUN_WINDOW }),
  ]);

  if (!workflows.ok) return <Refusal message={workflows.error} />;

  const recent = runs.ok ? runs.data.rows : [];

  const rows: WorkflowListRow[] = workflows.data.rows.map((workflow) => {
    const mine = recent.filter((run) => run.workflowId === workflow.id);
    const latest = mine[0] ?? null;

    return {
      id: workflow.id,
      key: workflow.key,
      name: workflow.name,
      description: workflow.description,
      isEnabled: workflow.isEnabled,
      archivedAt: workflow.archivedAt ? workflow.archivedAt.toISOString() : null,
      activeVersion: workflow.activeVersion,
      draftVersion: workflow.draftVersion,
      activeTrigger: workflow.activeTrigger,
      triggerSummary: triggerSummary(workflow.activeTrigger, null),
      lastRunAt:
        workflow.lastRunAt?.toISOString() ??
        (latest ? new Date(latest.queuedAt).toISOString() : null),
      lastRunStatus: latest?.status ?? null,
      recentRunCount: mine.length,
    };
  });

  return <WorkflowList rows={rows} runWindow={RUN_WINDOW} />;
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="h-14 animate-pulse rounded-lg border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}
