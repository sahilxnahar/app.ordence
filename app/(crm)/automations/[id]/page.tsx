/**
 * Ordence — The Builder Route
 * Version: v0.24.0-alpha
 * Runtime: Node
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHICH VERSION THE BUILDER OPENS ON, AND WHY IT IS NOT "THE LATEST"
 * ══════════════════════════════════════════════════════════════════════
 * A workflow has at most one ACTIVE version and any number of drafts and
 * archived ones. Opening the highest-numbered version would routinely
 * open an ARCHIVED one after a publish, which is read-only — so the
 * builder would greet its author with a form they cannot type in.
 *
 * The order is: the version asked for in the URL, then the newest draft
 * (the thing somebody was working on), then the active one (the thing
 * that is running), then whatever exists.
 *
 * ⚠️ THE SERVER ACTIONS ARE PASSED AS PROPS. `WorkflowBuilder` is a
 * client component and imports none of them; it takes them as functions.
 * That keeps the database out of its module graph, which is what makes
 * it mountable in a test — and it makes the component's dependencies
 * visible in its own type signature rather than hidden in its imports.
 */

import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  getWorkflow,
  publishWorkflowVersion,
  runWorkflowNow,
  saveWorkflowDraft,
  setWorkflowEnabled,
} from "@/server/actions/workflows";
import { getTenantContext } from "@/server/tenant-context";
import {
  WorkflowBuilder,
  type BuilderVersion,
} from "@/components/workflows/workflow-builder";
import { DEFAULT_STEP_BUDGET } from "@/lib/workflows/limits";
import type { WorkflowStep } from "@/lib/workflows/program";
import { Refusal } from "../refusal";

export const dynamic = "force-dynamic";

export default async function BuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { id } = await params;
  const { version } = await searchParams;

  return (
    <Suspense fallback={<BuilderSkeleton />}>
      <BuilderView id={id} versionId={version} />
    </Suspense>
  );
}

async function BuilderView({ id, versionId }: { id: string; versionId?: string }) {
  const [result, ctx] = await Promise.all([getWorkflow({ id }), getTenantContext()]);

  if (!result.ok) return <Refusal message={result.error} />;

  const { workflow, versions } = result.data;
  if (versions.length === 0) notFound();

  const chosen =
    (versionId ? versions.find((v) => v.id === versionId) : undefined) ??
    versions.find((v) => v.status === "draft") ??
    versions.find((v) => v.status === "active") ??
    versions[0];

  if (!chosen) notFound();

  const builderVersion: BuilderVersion = {
    id: chosen.id,
    version: chosen.version,
    status: chosen.status,
    triggerType: chosen.triggerType,
    triggerConfig: chosen.triggerConfig ?? {},
    steps: (chosen.steps ?? []) as WorkflowStep[],
    stepBudget: chosen.stepBudget ?? DEFAULT_STEP_BUDGET,
    notes: chosen.notes,
  };

  const publisherLabel =
    ctx?.user.firstName && ctx.user.lastName
      ? `${ctx.user.firstName} ${ctx.user.lastName} (${ctx.user.email})`
      : (ctx?.user.email ?? "you");

  return (
    <WorkflowBuilder
      workflowId={workflow.id}
      workflowName={workflow.name}
      workflowKey={workflow.key}
      isEnabled={workflow.isEnabled}
      version={builderVersion}
      versions={versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
      }))}
      publisherLabel={publisherLabel}
      onSaveDraft={saveWorkflowDraft}
      onPublish={publishWorkflowVersion}
      onSetEnabled={setWorkflowEnabled}
      onRunNow={runWorkflowNow}
    />
  );
}

function BuilderSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="space-y-4">
        <div className="h-40 animate-pulse rounded-lg border border-border bg-muted/30" />
        <div className="h-80 animate-pulse rounded-lg border border-border bg-muted/30" />
      </div>
      <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/30" />
    </div>
  );
}
