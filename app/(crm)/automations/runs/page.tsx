/**
 * Ordence — Run History
 * Version: v0.24.0-alpha
 * Runtime: Node
 *
 * Filterable by status, because the realistic first question is "what
 * failed?" and a list of five hundred successes is not an answer to it.
 *
 * ⚠️ THE FILTER IS IN THE URL. Somebody who finds a failing run wants to
 * send the address to a colleague; a filter held in component state
 * produces a link that shows them everything.
 */

import Link from "next/link";
import { Suspense } from "react";
import { listWorkflowRuns } from "@/server/actions/workflows";
import { RunList, type RunListRow } from "@/components/workflows/run-list";
import { RUN_STATUS_LABELS } from "@/components/workflows/presentation";
import type { WorkflowRunStatus } from "@/db/schema/workflows";
import { Refusal } from "../refusal";

export const dynamic = "force-dynamic";

const STATUSES: WorkflowRunStatus[] = [
  "queued",
  "running",
  "waiting_delay",
  "waiting_form",
  "succeeded",
  "stopped",
  "failed",
  "cancelled",
];

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; workflowId?: string }>;
}) {
  const params = await searchParams;
  const status = STATUSES.includes(params.status as WorkflowRunStatus)
    ? (params.status as WorkflowRunStatus)
    : undefined;

  return (
    <div className="space-y-4">
      <nav aria-label="Filter runs by outcome" className="flex flex-wrap gap-1.5">
        <FilterLink
          href={buildHref(undefined, params.workflowId)}
          label="Everything"
          active={!status}
        />
        {STATUSES.map((value) => (
          <FilterLink
            key={value}
            href={buildHref(value, params.workflowId)}
            label={RUN_STATUS_LABELS[value]}
            active={status === value}
          />
        ))}
      </nav>

      <Suspense fallback={<ListSkeleton />}>
        <RunsView status={status} workflowId={params.workflowId} />
      </Suspense>
    </div>
  );
}

async function RunsView({
  status,
  workflowId,
}: {
  status?: WorkflowRunStatus;
  workflowId?: string;
}) {
  const result = await listWorkflowRuns({
    ...(status ? { status } : {}),
    ...(workflowId ? { workflowId } : {}),
    limit: 100,
  });

  if (!result.ok) return <Refusal message={result.error} />;

  const rows: RunListRow[] = result.data.rows.map((run) => ({
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: run.status,
    triggerType: run.triggerType,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    stepsExecuted: run.stepsExecuted,
    error: run.error,
    errorStepKey: run.errorStepKey,
    stopReason: run.stopReason,
    depth: run.depth,
  }));

  return <RunList rows={rows} />;
}

function buildHref(status: string | undefined, workflowId: string | undefined): string {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (workflowId) query.set("workflowId", workflowId);
  const search = query.toString();
  return search ? `/automations/runs?${search}` : "/automations/runs";
}

function FilterLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={[
        "rounded-md border px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="h-12 animate-pulse rounded-lg border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}
