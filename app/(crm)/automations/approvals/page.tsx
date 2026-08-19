/**
 * Ordence — Approvals Inbox
 * Version: v0.24.0-alpha
 * Runtime: Node
 *
 * ⚠️ THE LIST IS SCOPED BY THE SERVER, NOT BY THE PAGE.
 *
 * `listMyTasks` returns pending tasks that are assigned to the caller OR
 * to nobody. That scoping is a permission decision and it belongs behind
 * the tenant context — a page that fetched everything and filtered in
 * React would have already sent one person's approval queue to another
 * person's browser.
 */

import { Suspense } from "react";
import {
  listMyWorkflowTasks,
  respondToWorkflowTask,
} from "@/server/actions/workflows";
import { getTenantContext } from "@/server/tenant-context";
import {
  ApprovalsInbox,
  type ApprovalTask,
} from "@/components/workflows/approvals-inbox";
import { Refusal } from "../refusal";

export const dynamic = "force-dynamic";

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<InboxSkeleton />}>
      <InboxView />
    </Suspense>
  );
}

async function InboxView() {
  const [result, ctx] = await Promise.all([listMyWorkflowTasks(), getTenantContext()]);

  if (!result.ok) return <Refusal message={result.error} />;

  const tasks: ApprovalTask[] = result.data.rows.map((task) => ({
    id: task.id,
    runId: task.runId,
    stepKey: task.stepKey,
    title: task.title,
    instructions: task.instructions,
    expiresAt: task.expiresAt.toISOString(),
    assignedToMe: Boolean(ctx && task.assignedToUserId === ctx.user.id),
  }));

  return <ApprovalsInbox tasks={tasks} onRespond={respondToWorkflowTask} />;
}

function InboxSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="h-40 animate-pulse rounded-lg border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}
