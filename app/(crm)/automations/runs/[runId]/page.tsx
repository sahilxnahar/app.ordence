/**
 * Ordence — One Run
 * Version: v0.24.0-alpha
 * Runtime: Node
 *
 * The page somebody reaches from "why is this lead assigned to me?".
 * Everything it needs is in `getWorkflowRun`, which returns the run, one
 * row per STEP EXECUTION and any approval tasks the run created.
 */

import { Suspense } from "react";
import { getWorkflowRun } from "@/server/actions/workflows";
import { RunDetail, type RunDetailStep } from "@/components/workflows/run-detail";
import { Refusal } from "../../refusal";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <RunView runId={runId} />
    </Suspense>
  );
}

async function RunView({ runId }: { runId: string }) {
  const result = await getWorkflowRun({ runId });
  if (!result.ok) return <Refusal message={result.error} />;

  const { run, steps, tasks } = result.data;

  const detailSteps: RunDetailStep[] = steps.map((step) => ({
    id: step.id,
    stepKey: step.stepKey,
    stepPath: step.stepPath,
    actionType: step.actionType,
    status: step.status,
    iteration: step.iteration,
    sequence: step.sequence,
    input: step.input,
    output: step.output,
    error: step.error,
    startedAt: step.startedAt.toISOString(),
    finishedAt: step.finishedAt ? step.finishedAt.toISOString() : null,
  }));

  return (
    <RunDetail
      run={{
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        status: run.status,
        triggerType: run.triggerType,
        recordType: run.recordType,
        recordId: run.recordId,
        actorRole: run.actorRole,
        depth: run.depth,
        stepsExecuted: run.stepsExecuted,
        iterationsUsed: run.iterationsUsed,
        error: run.error,
        errorStepKey: run.errorStepKey,
        stopReason: run.stopReason,
        queuedAt: run.queuedAt.toISOString(),
        startedAt: run.startedAt ? run.startedAt.toISOString() : null,
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        resumeAt: run.resumeAt ? run.resumeAt.toISOString() : null,
      }}
      steps={detailSteps}
      tasks={tasks.map((task) => ({
        id: task.id,
        stepKey: task.stepKey,
        title: task.title,
        status: task.status,
        expiresAt: task.expiresAt.toISOString(),
        respondedAt: task.respondedAt ? task.respondedAt.toISOString() : null,
      }))}
    />
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/30" />
      <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/30" />
    </div>
  );
}
