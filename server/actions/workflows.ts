"use server";

/**
 * Ordence — Workflow Actions
 * Version: v0.23.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION.
 *
 * Next.js turns every export of a `"use server"` module into a callable
 * RPC endpoint. A constant, a schema or a type exported from here would
 * be published to the internet as one. The catalogues live in
 * `lib/workflows/`, the schemas in `lib/validators/workflows.ts`, and the
 * implementations in `server/workflows/` — this file is the boundary and
 * nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE ACTIONS ARE THIN AND THE ENGINE IS NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * A workflow starts from four places: a person pressing a button, a
 * record changing, a schedule, and an external webhook. Only the first is
 * a server action. If the engine lived in this file, the other three
 * would each grow their own copy of "start a run" — and the loop guard,
 * the actor resolution and the entitlement check would exist in one of
 * them and be forgotten in the rest.
 *
 * So `server/workflows/dispatch.ts` is the single door, and this file
 * knocks on it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE ROUTES ARE `/automations`, NOT `/workflows` — FIXED v0.31.0
 * ══════════════════════════════════════════════════════════════════════
 * Every `revalidatePath` below pointed at `/workflows`, `/workflows/runs`
 * and `/workflows/tasks`. Those routes do not exist. Phase 26 named the
 * pages after what a customer calls them:
 *
 *     /workflows        →  /automations
 *     /workflows/runs   →  /automations/runs
 *     /workflows/tasks  →  /automations/approvals
 *
 * `revalidatePath` on a path with no route is NOT an error. It returns
 * quietly, which is exactly why this survived: publishing a workflow
 * appeared to work, the action returned `ok`, and the list page kept
 * serving its cached copy. The symptom is "I published it and the page
 * still says draft" — reported as a caching bug, reproduced by nobody,
 * because a hard refresh fixes it.
 *
 * ⚠️ A NEW ROUTE FOLDER MEANS A NEW STRING HERE. There is no compiler
 * check on these; the only defence is that they are all in this file.
 */

import { revalidatePath } from "next/cache";
import { requirePermission, writeAudit } from "@/server/audit";
import {
  archiveWorkflow as archiveWorkflowImpl,
  createWorkflow as createWorkflowImpl,
  getWorkflow as getWorkflowImpl,
  listWorkflows as listWorkflowsImpl,
  publishVersion as publishVersionImpl,
  saveDraft as saveDraftImpl,
  setWorkflowEnabled as setWorkflowEnabledImpl,
} from "@/server/workflows/definitions";
import {
  cancelRun as cancelRunImpl,
  expireOverdueTasks,
  getRun as getRunImpl,
  listMyTasks as listMyTasksImpl,
  listRuns as listRunsImpl,
  respondToTask as respondToTaskImpl,
  resumeDueRuns,
} from "@/server/workflows/runs";
import { dispatchManual, dispatchScheduled, generateWebhookToken } from "@/server/workflows/dispatch";
import { executeRun } from "@/server/workflows/executor";
import { guardWorkflowWrite, workflowFail, toWorkflowActionError } from "@/server/workflows/guards";
import { runManuallySchema } from "@/lib/validators/workflows";
import { withTenant } from "@/db";
import { workflows } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { ActionResult } from "@/lib/validators/crm";

/* ------------------------------------------------------------------ */
/* DEFINITIONS                                                        */
/* ------------------------------------------------------------------ */

export async function listWorkflows() {
  return listWorkflowsImpl();
}

export async function getWorkflow(input: { id: string }) {
  return getWorkflowImpl(input);
}

export async function createWorkflow(input: unknown) {
  const result = await createWorkflowImpl(input);
  if (result.ok) revalidatePath("/automations");
  return result;
}

export async function saveWorkflowDraft(input: unknown) {
  const result = await saveDraftImpl(input);
  if (result.ok) revalidatePath("/automations");
  return result;
}

export async function publishWorkflowVersion(input: unknown) {
  const result = await publishVersionImpl(input);
  if (result.ok) revalidatePath("/automations");
  return result;
}

export async function setWorkflowEnabled(input: unknown) {
  const result = await setWorkflowEnabledImpl(input);
  if (result.ok) revalidatePath("/automations");
  return result;
}

export async function archiveWorkflow(input: unknown) {
  const result = await archiveWorkflowImpl(input);
  if (result.ok) revalidatePath("/automations");
  return result;
}

/**
 * Issue a webhook token.
 *
 * ⚠️ RETURNED EXACTLY ONCE. Only the SHA-256 hash is stored, so this
 * value cannot be recovered — a leak of the `workflows` table is then not
 * a leak of the credential. Rotating simply issues a new one and the old
 * one stops working, which is the behaviour somebody wants at the moment
 * they ask for it.
 */
export async function rotateWebhookToken(input: { workflowId: string }): Promise<
  ActionResult<{ token: string }>
> {
  try {
    const ctx = await guardWorkflowWrite({
      operation: "workflows:publish",
      feature: "workflows.webhooks",
      permission: "workflows:publish",
    });

    const { token, hash } = generateWebhookToken();

    const updated = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(workflows)
        .set({ webhookSecretHash: hash, updatedAt: new Date() })
        .where(
          and(eq(workflows.id, input.workflowId), eq(workflows.tenantId, ctx.tenant.id)),
        )
        .returning({ id: workflows.id }),
    );

    if (updated.length === 0) {
      return workflowFail("That workflow does not exist, or you cannot see it.");
    }

    await writeAudit(ctx, {
      action: "config_change",
      resourceType: "workflow",
      resourceId: input.workflowId,
      newValue: { webhookTokenRotated: true },
      severity: "warning",
    });

    return { ok: true, data: { token } };
  } catch (err) {
    return toWorkflowActionError(err, "rotateWebhookToken");
  }
}

/* ------------------------------------------------------------------ */
/* RUNS                                                               */
/* ------------------------------------------------------------------ */

export async function listWorkflowRuns(input: unknown = {}) {
  return listRunsImpl(input);
}

export async function getWorkflowRun(input: unknown) {
  return getRunImpl(input);
}

export async function cancelWorkflowRun(input: unknown) {
  const result = await cancelRunImpl(input);
  if (result.ok) revalidatePath("/automations/runs");
  return result;
}

/**
 * Run a workflow by hand.
 *
 * ⚠️ IT RUNS AS THE PERSON WHO PRESSED THE BUTTON.
 *
 * Not as the workflow's author. So a manual run can fail on a step the
 * author could perform and the presser cannot — which is correct, and is
 * the difference between a shortcut and a privilege. The "friendlier"
 * alternative is a button that lends one person's authority to everyone
 * who can see it.
 */
export async function runWorkflowNow(input: unknown): Promise<
  ActionResult<{ runId: string; status: string }>
> {
  try {
    const ctx = await guardWorkflowWrite({
      operation: "workflows:run",
      feature: "workflows.builder",
      permission: "workflows:run",
    });

    const data = runManuallySchema.parse(input);

    const dispatched = await dispatchManual({
      tenantId: ctx.tenant.id,
      actor: { userId: ctx.user.id, role: ctx.role },
      workflowId: data.workflowId,
      recordId: data.recordId,
      input: data.input,
    });

    if ("refused" in dispatched) return workflowFail(dispatched.refused);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "workflow_run",
      resourceId: dispatched.runId,
      newValue: { workflowId: data.workflowId, trigger: "manual" },
    });

    // Executed inline rather than queued. A person watching a button they
    // pressed should see what happened; a background queue for a run
    // somebody is waiting on is a spinner that never resolves.
    const result = await executeRun({ tenantId: ctx.tenant.id, runId: dispatched.runId });

    revalidatePath("/automations/runs");
    return { ok: true, data: { runId: dispatched.runId, status: result.status } };
  } catch (err) {
    return toWorkflowActionError(err, "runWorkflowNow");
  }
}

/* ------------------------------------------------------------------ */
/* APPROVALS                                                          */
/* ------------------------------------------------------------------ */

export async function listMyWorkflowTasks() {
  return listMyTasksImpl();
}

export async function respondToWorkflowTask(input: unknown) {
  const result = await respondToTaskImpl(input);
  if (result.ok) revalidatePath("/automations/approvals");
  return result;
}

/* ------------------------------------------------------------------ */
/* MAINTENANCE                                                        */
/* ------------------------------------------------------------------ */

/**
 * The tick: fire what is due, resume what has waited, expire what nobody
 * answered.
 *
 * ⚠️ TENANT-SCOPED AND PERMISSION-GATED, even though it looks like a
 * system job. It is reachable as a server action, so an ungated version
 * would let any authenticated user drive another workspace's automations
 * — the tenant context is what stops that, and the permission is what
 * stops a member triggering everybody's schedule by refreshing a page.
 *
 * A platform-wide scheduler calls the same three functions per tenant
 * from a route that authenticates differently.
 */
export async function runWorkflowMaintenance(): Promise<
  ActionResult<{ started: number; resumed: number; expired: number }>
> {
  try {
    const ctx = await requirePermission("workflows:runs_read");

    const scheduled = await dispatchScheduled({ tenantId: ctx.tenant.id });
    for (const runId of scheduled.started) {
      await executeRun({ tenantId: ctx.tenant.id, runId });
    }

    const resumed = await resumeDueRuns({ tenantId: ctx.tenant.id });
    const expired = await expireOverdueTasks({ tenantId: ctx.tenant.id });

    return {
      ok: true,
      data: {
        started: scheduled.started.length,
        resumed: resumed.resumed.length,
        expired: expired.expired,
      },
    };
  } catch (err) {
    return toWorkflowActionError(err, "runWorkflowMaintenance");
  }
}
