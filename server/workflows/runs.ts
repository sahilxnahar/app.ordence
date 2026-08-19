import "server-only";

/**
 * Ordence — Runs, Approvals and the Sweepers
 * Version: v0.23.0-alpha
 *
 * Reading run history, stopping a run, answering an approval, and the two
 * background sweeps that stop suspended runs waiting forever.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY RUN HISTORY IS A FIRST-CLASS SURFACE AND NOT A LOG FILE
 * ══════════════════════════════════════════════════════════════════════
 * The question this table answers is "why is this record like this?", and
 * it is asked in exactly the situations where somebody would prefer a
 * different answer: a buyer was emailed the wrong figure, a lead was
 * reassigned overnight, a record vanished.
 *
 * An engine whose answer is "check the server logs" has no answer, because
 * the person asking is a sales manager. So every step execution is a row,
 * with the RESOLVED input — the address the email actually went to, not
 * the template that produced it.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  workflowRuns,
  workflowRunSteps,
  workflowTasks,
  workflowVersions,
  workflows,
} from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { workflowFail, toWorkflowActionError } from "./guards";
import { executeRun } from "./executor";
import { cancelRunSchema, getRunSchema, listRunsSchema, respondToTaskSchema } from "@/lib/validators/workflows";
import { collectSteps } from "@/lib/workflows/planner";
import type { ActionResult } from "@/lib/validators/crm";
import type { WorkflowRun, WorkflowRunStep, WorkflowTask } from "@/db/schema/workflows";
import type { WorkflowStep } from "@/lib/workflows/program";

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type RunRow = WorkflowRun & { workflowName: string | null };

export async function listRuns(input: unknown = {}): Promise<
  ActionResult<{ rows: RunRow[] }>
> {
  try {
    const ctx = await requirePermission("workflows:runs_read");
    const data = listRunsSchema.parse(input ?? {});

    const rows = await withTenant(ctx.tenant.id, async (tx) => {
      const conditions = [eq(workflowRuns.tenantId, ctx.tenant.id)];
      if (data.workflowId) conditions.push(eq(workflowRuns.workflowId, data.workflowId));
      if (data.status) conditions.push(eq(workflowRuns.status, data.status));

      const found = await tx
        .select({ run: workflowRuns, workflowName: workflows.name })
        .from(workflowRuns)
        .leftJoin(
          workflows,
          and(
            eq(workflows.id, workflowRuns.workflowId),
            eq(workflows.tenantId, ctx.tenant.id),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(workflowRuns.queuedAt))
        .limit(data.limit ?? 50);

      return found.map((r) => ({ ...r.run, workflowName: r.workflowName ?? null }));
    });

    return { ok: true, data: { rows } };
  } catch (err) {
    return toWorkflowActionError(err, "listRuns");
  }
}

export async function getRun(input: unknown): Promise<
  ActionResult<{ run: RunRow; steps: WorkflowRunStep[]; tasks: WorkflowTask[] }>
> {
  try {
    const ctx = await requirePermission("workflows:runs_read");
    const data = getRunSchema.parse(input);

    const found = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .select({ run: workflowRuns, workflowName: workflows.name })
        .from(workflowRuns)
        .leftJoin(
          workflows,
          and(
            eq(workflows.id, workflowRuns.workflowId),
            eq(workflows.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(eq(workflowRuns.id, data.runId), eq(workflowRuns.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!row) return null;

      const steps = await tx
        .select()
        .from(workflowRunSteps)
        .where(
          and(
            eq(workflowRunSteps.runId, data.runId),
            eq(workflowRunSteps.tenantId, ctx.tenant.id),
          ),
        )
        .orderBy(workflowRunSteps.sequence);

      const tasks = await tx
        .select()
        .from(workflowTasks)
        .where(
          and(
            eq(workflowTasks.runId, data.runId),
            eq(workflowTasks.tenantId, ctx.tenant.id),
          ),
        );

      return {
        run: { ...row.run, workflowName: row.workflowName ?? null },
        steps,
        tasks,
      };
    });

    if (!found) return workflowFail("That run does not exist, or you cannot see it.");
    return { ok: true, data: found };
  } catch (err) {
    return toWorkflowActionError(err, "getRun");
  }
}

/* ------------------------------------------------------------------ */
/* CANCEL                                                             */
/* ------------------------------------------------------------------ */

/**
 * Stop a run.
 *
 * ⚠️ CANCELLATION IS NOT A ROLLBACK, AND SAYING SO IS PART OF THE
 * FEATURE. Steps already executed have already happened: the email is
 * sent, the record is written. Cancelling stops what has not happened
 * yet. A UI that implies otherwise produces a worse outcome than no
 * cancel button, because somebody presses it and stops looking.
 *
 * ⚠️ Gated on `requirePermission` alone, deliberately — no entitlement
 * check. A workspace whose subscription lapsed must still be able to stop
 * a runaway automation; a gate that says "upgrade to stop your workflow"
 * is the worst error message this product could produce.
 */
export async function cancelRun(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission("workflows:cancel_run");
    const data = cancelRunSchema.parse(input);
    const now = new Date();

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [run] = await tx
        .select({ id: workflowRuns.id, status: workflowRuns.status })
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.id, data.runId), eq(workflowRuns.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!run) return { kind: "not_found" as const };

      if (["succeeded", "stopped", "failed", "cancelled"].includes(run.status)) {
        return { kind: "already" as const, status: run.status };
      }

      await tx
        .update(workflowRuns)
        .set({
          status: "cancelled",
          stopReason: data.reason,
          finishedAt: now,
          resumeAt: null,
          updatedAt: now,
        })
        .where(
          and(eq(workflowRuns.id, data.runId), eq(workflowRuns.tenantId, ctx.tenant.id)),
        );

      // Any open approval goes with it. Leaving it pending would put a
      // request in somebody's queue for a run that no longer exists.
      await tx
        .update(workflowTasks)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(workflowTasks.runId, data.runId),
            eq(workflowTasks.tenantId, ctx.tenant.id),
            eq(workflowTasks.status, "pending"),
          ),
        );

      return { kind: "ok" as const };
    });

    if (outcome.kind === "not_found") {
      return workflowFail("That run does not exist, or you cannot see it.");
    }
    if (outcome.kind === "already") {
      return workflowFail(`That run has already finished (${outcome.status}).`);
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "workflow_run",
      resourceId: data.runId,
      newValue: { status: "cancelled" },
      reason: data.reason,
      severity: "warning",
    });

    return { ok: true, data: { id: data.runId } };
  } catch (err) {
    return toWorkflowActionError(err, "cancelRun");
  }
}

/* ------------------------------------------------------------------ */
/* APPROVALS                                                          */
/* ------------------------------------------------------------------ */

export async function listMyTasks(): Promise<ActionResult<{ rows: WorkflowTask[] }>> {
  try {
    const ctx = await requirePermission("workflows:approve");

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(workflowTasks)
        .where(
          and(
            eq(workflowTasks.tenantId, ctx.tenant.id),
            eq(workflowTasks.status, "pending"),
            // Unassigned tasks are visible to everybody who may approve —
            // the validator warns the author when they leave one that way.
            sql`(${workflowTasks.assignedToUserId} IS NULL
                 OR ${workflowTasks.assignedToUserId} = ${ctx.user.id})`,
          ),
        )
        .orderBy(workflowTasks.expiresAt)
        .limit(100),
    );

    return { ok: true, data: { rows } };
  } catch (err) {
    return toWorkflowActionError(err, "listMyTasks");
  }
}

/**
 * Approve or reject.
 *
 * ⚠️ THE RESPONSE AND THE RESUME ARE SEPARATE TRANSACTIONS, IN THAT ORDER.
 *
 * Recording the answer must not depend on the run resuming successfully —
 * if the resume fails, the person's decision is still a fact and must not
 * be lost. The database refuses a second answer
 * (`workflow_tasks_answered_once`), so the worst case is a recorded
 * decision and a run somebody has to nudge, rather than a lost decision or
 * a double execution.
 */
export async function respondToTask(input: unknown): Promise<
  ActionResult<{ taskId: string; runStatus: string }>
> {
  try {
    const ctx = await requirePermission("workflows:approve");
    const data = respondToTaskSchema.parse(input);
    const now = new Date();

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [task] = await tx
        .select()
        .from(workflowTasks)
        .where(
          and(eq(workflowTasks.id, data.taskId), eq(workflowTasks.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!task) return { kind: "not_found" as const };
      if (task.status !== "pending") {
        return { kind: "already" as const, status: task.status };
      }

      // ⚠️ AN ASSIGNED TASK IS ANSWERED BY ITS ASSIGNEE. Holding
      // `workflows:approve` is permission to approve the things asked of
      // you, not to answer on somebody else's behalf — an approval chain
      // where anybody can sign for anybody is not an approval chain.
      if (task.assignedToUserId && task.assignedToUserId !== ctx.user.id) {
        return { kind: "not_yours" as const };
      }

      await tx
        .update(workflowTasks)
        .set({
          status: data.decision === "approve" ? "approved" : "rejected",
          response: { comment: data.comment ?? null },
          respondedBy: ctx.user.id,
          respondedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(workflowTasks.id, task.id), eq(workflowTasks.tenantId, ctx.tenant.id)),
        );

      const [run] = await tx
        .select({
          id: workflowRuns.id,
          status: workflowRuns.status,
          versionId: workflowRuns.versionId,
        })
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.id, task.runId), eq(workflowRuns.tenantId, ctx.tenant.id)),
        )
        .limit(1);

      if (!run || run.status !== "waiting_form") {
        return { kind: "answered_only" as const, runId: task.runId };
      }

      if (data.decision === "approve") {
        await tx
          .update(workflowRuns)
          .set({ status: "queued", updatedAt: now })
          .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.tenantId, ctx.tenant.id)));
        return { kind: "resume" as const, runId: run.id };
      }

      // A rejection means what the author said it means.
      const [version] = await tx
        .select({ steps: workflowVersions.steps })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.id, run.versionId),
            eq(workflowVersions.tenantId, ctx.tenant.id),
          ),
        )
        .limit(1);

      const step = collectSteps({ steps: (version?.steps ?? []) as WorkflowStep[] }).find(
        (s) => s.key === task.stepKey,
      );
      const onReject =
        step && step.action === "form" ? (step.onReject ?? "stop") : "stop";

      await tx
        .update(workflowRuns)
        .set(
          onReject === "fail"
            ? {
                status: "failed",
                error: `"${task.title}" was rejected by ${ctx.user.email}.`,
                errorStepKey: task.stepKey,
                finishedAt: now,
                updatedAt: now,
              }
            : {
                status: "stopped",
                stopReason: `"${task.title}" was rejected by ${ctx.user.email}.`,
                finishedAt: now,
                updatedAt: now,
              },
        )
        .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.tenantId, ctx.tenant.id)));

      return { kind: "rejected" as const, runId: run.id, onReject };
    });

    if (outcome.kind === "not_found") {
      return workflowFail("That request does not exist, or you cannot see it.");
    }
    if (outcome.kind === "already") {
      return workflowFail(`That request was already ${outcome.status}.`);
    }
    if (outcome.kind === "not_yours") {
      return workflowFail(
        "That request is assigned to somebody else. Approving on their behalf " +
          "would make the approval trail meaningless.",
      );
    }

    await writeAudit(ctx, {
      action: "update",
      resourceType: "workflow_task",
      resourceId: data.taskId,
      newValue: { decision: data.decision },
      reason: data.comment ?? undefined,
      severity: "notice",
    });

    if (outcome.kind === "resume") {
      const result = await executeRun({ tenantId: ctx.tenant.id, runId: outcome.runId });
      return { ok: true, data: { taskId: data.taskId, runStatus: result.status } };
    }

    return {
      ok: true,
      data: {
        taskId: data.taskId,
        runStatus: outcome.kind === "rejected" ? outcome.onReject : "unchanged",
      },
    };
  } catch (err) {
    return toWorkflowActionError(err, "respondToTask");
  }
}

/* ------------------------------------------------------------------ */
/* SWEEPERS                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resume runs whose delay has elapsed.
 *
 * ⚠️ CALLED FROM A SCHEDULED ROUTE, AND SAFE TO CALL TWICE.
 * `claim_due_workflow_runs` takes `FOR UPDATE SKIP LOCKED`, so two
 * workers cannot claim the same run — without which a `send_email` after
 * a delay goes out twice.
 *
 * ⚠️ IT MOVES RUNS TO `queued` AND NOTHING ELSE DESTRUCTIVE. Same
 * reasoning as the hold sweeper in Phase 22: an unattended job whose
 * failure mode is destroying customer state is a bad trade.
 */
export async function resumeDueRuns(args: {
  tenantId: string;
  limit?: number;
}): Promise<{ resumed: string[]; outcomes: string[] }> {
  const claimed = await withTenant(args.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT * FROM claim_due_workflow_runs(${args.tenantId}::uuid, ${args.limit ?? 25})
    `);
    const rows = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
    return rows.map((row) => String(row.run_id));
  });

  const outcomes: string[] = [];
  for (const runId of claimed) {
    const result = await executeRun({ tenantId: args.tenantId, runId });
    outcomes.push(`${runId}:${result.status}`);
  }

  return { resumed: claimed, outcomes };
}

/**
 * Expire approval requests nobody answered.
 *
 * The task expires AND its run fails, in one statement each inside
 * `expire_workflow_tasks`. An expired task that left its run waiting
 * would be the worst of both: the request is gone from everybody's list
 * and the run still holds a cursor, waiting for a reply that can no
 * longer be given.
 */
export async function expireOverdueTasks(args: {
  tenantId: string;
}): Promise<{ expired: number }> {
  return withTenant(args.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT * FROM expire_workflow_tasks(${args.tenantId}::uuid)
    `);
    const rows = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
    return { expired: rows.length };
  });
}
