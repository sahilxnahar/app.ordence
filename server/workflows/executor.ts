import "server-only";

/**
 * Ordence — The Executor
 * Version: v0.23.0-alpha
 *
 * Takes a queued run and drives it until it finishes, suspends, or hits a
 * limit. Every decision about WHAT to do next comes from the pure planner
 * in `lib/workflows/planner.ts`; this file does the parts that touch the
 * world — writing step rows, performing effects, and telling the
 * dispatcher that a record changed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE TRANSACTION PER STEP, NOT ONE PER RUN
 * ══════════════════════════════════════════════════════════════════════
 * A run may take minutes: an `http_request` waits ten seconds, a loop of
 * two hundred iterations does two hundred writes. Holding one transaction
 * open across that pins a connection, blocks vacuum, and turns one slow
 * third-party endpoint into a database-wide problem.
 *
 * So each step commits on its own. The consequence is honest and worth
 * stating: **a workflow is not atomic.** Step 1 can send an email and
 * step 2 can fail, and the email is gone. Nothing in this design pretends
 * otherwise — which is exactly why `lib/workflows/validation.ts` refuses
 * to publish a definition whose steps could not work, and why the cursor
 * is advanced before the step runs so a crash cannot re-send.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE LOOP THAT DRIVES THE LOOP IS ITSELF BOUNDED
 * ══════════════════════════════════════════════════════════════════════
 * `while (true)` around a planner that always returns something is one
 * off-by-one away from a worker that never yields. The bound below is
 * larger than any run can legitimately need, and reaching it is reported
 * as an engine defect rather than a workflow problem.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { workflowRuns, workflowRunSteps, workflowTasks, workflowVersions } from "@/db/schema";
import { planNext, type Cursor, type PlanState } from "@/lib/workflows/planner";
import {
  DEFAULT_FORM_DUE_HOURS,
  MAX_STEPS_PER_RUN,
  MAX_FORM_DUE_HOURS,
} from "@/lib/workflows/limits";
import { readPath, resolveValue, interpolate } from "@/lib/workflows/bindings";
import { runEffect, EffectError } from "./effects";
import { ActorDeniedError, type RunActor } from "./guards";
import { dispatchRecordEvent } from "./dispatch";
import type { RunContext, WorkflowProgram, WorkflowStep } from "@/lib/workflows/program";
import type { SystemRole } from "@/db/schema/core";

/** Generous: MAX_STEPS_PER_RUN effects, plus control-flow transitions. */
const MAX_EXECUTOR_TURNS = MAX_STEPS_PER_RUN * 4;

export type ExecuteOutcome = {
  runId: string;
  status: "succeeded" | "stopped" | "failed" | "waiting_delay" | "waiting_form" | "skipped";
  steps: number;
  message?: string;
};

type LoadedRun = {
  id: string;
  workflowId: string;
  versionId: string;
  context: RunContext;
  cursor: Cursor;
  stepsExecuted: number;
  iterationsUsed: number;
  depth: number;
  originChain: string[];
  actor: RunActor;
  program: WorkflowProgram;
  stepBudget: number;
};

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

export async function executeRun(args: {
  tenantId: string;
  runId: string;
  now?: Date;
}): Promise<ExecuteOutcome> {
  const { tenantId, runId } = args;

  const claimed = await claimRun(tenantId, runId);
  if (!claimed) {
    // Another worker has it, or it has already finished. Both are normal:
    // the alternative — executing it anyway — is every effect happening
    // twice.
    return { runId, status: "skipped", steps: 0, message: "Not claimable." };
  }

  let run = claimed;
  let sequence = await nextSequence(tenantId, runId);

  for (let turn = 0; turn < MAX_EXECUTOR_TURNS; turn += 1) {
    const now = args.now ?? new Date();

    const state: PlanState = {
      program: run.program,
      cursor: run.cursor,
      context: run.context,
      counters: {
        stepsExecuted: run.stepsExecuted,
        iterationsUsed: run.iterationsUsed,
        stepBudget: run.stepBudget,
      },
      depth: run.depth,
      now,
    };

    const plan = planNext(state);

    if (plan.kind === "finish") {
      if (plan.status === "succeeded") {
        await finishRun(tenantId, runId, { status: "succeeded" });
        return { runId, status: "succeeded", steps: run.stepsExecuted };
      }
      await finishRun(tenantId, runId, { status: "stopped", stopReason: plan.message });
      return { runId, status: "stopped", steps: run.stepsExecuted, message: plan.message };
    }

    if (plan.kind === "abort") {
      // ⚠️ A LIMIT IS A FAILURE, NOT A QUIET STOP. The author has built
      // something that does not terminate, and the only way they find out
      // is a run that says so in red.
      await finishRun(tenantId, runId, {
        status: "failed",
        error: plan.message,
      });
      return { runId, status: "failed", steps: run.stepsExecuted, message: plan.message };
    }

    if (plan.kind === "sleep") {
      await suspendRun(tenantId, runId, {
        status: "waiting_delay",
        cursor: plan.cursor,
        resumeAt: plan.resumeAt,
      });
      return { runId, status: "waiting_delay", steps: run.stepsExecuted };
    }

    if (plan.kind === "await_form") {
      const message = await requestApproval({
        tenantId,
        run,
        step: plan.step,
        cursor: plan.cursor,
        scope: plan.scope,
        now,
      });
      if (message) {
        await finishRun(tenantId, runId, { status: "failed", error: message });
        return { runId, status: "failed", steps: run.stepsExecuted, message };
      }
      return { runId, status: "waiting_form", steps: run.stepsExecuted };
    }

    /* --- An effect ------------------------------------------------ */
    sequence += 1;
    const outcome = await executeStep({
      tenantId,
      run,
      step: plan.step,
      path: plan.path,
      scope: plan.scope,
      cursor: plan.cursor,
      sequence,
      now,
    });

    if (!outcome.ok) {
      return {
        runId,
        status: "failed",
        steps: run.stepsExecuted,
        message: outcome.message,
      };
    }

    run = outcome.run;
  }

  const message =
    "This run did not finish within the engine's own turn limit. That is a " +
    "defect in the engine rather than in the workflow — report it.";
  await finishRun(tenantId, runId, { status: "failed", error: message });
  return { runId, status: "failed", steps: run.stepsExecuted, message };
}

/* ------------------------------------------------------------------ */
/* CLAIMING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Move a run from `queued` to `running` and load everything needed.
 *
 * ⚠️ THE `status = 'queued'` IN THE WHERE CLAUSE IS THE LOCK.
 *
 * Two workers reading the row and both proceeding is the same race as two
 * reps booking one flat in Phase 22, and it has the same shape of
 * consequence: every effect in the run happens twice. Making the claim a
 * conditional UPDATE means exactly one of them changes a row.
 */
async function claimRun(tenantId: string, runId: string): Promise<LoadedRun | null> {
  return withTenant(tenantId, async (tx) => {
    const claimed = await tx
      .update(workflowRuns)
      .set({ status: "running", startedAt: sql`COALESCE(${workflowRuns.startedAt}, now())` })
      .where(
        and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.tenantId, tenantId),
          eq(workflowRuns.status, "queued"),
        ),
      )
      .returning();

    const row = claimed[0];
    if (!row) return null;

    const [version] = await tx
      .select({
        steps: workflowVersions.steps,
        stepBudget: workflowVersions.stepBudget,
        status: workflowVersions.status,
      })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.id, row.versionId),
          eq(workflowVersions.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (!version) return null;

    const actor = await loadActor(tx, tenantId, row.actorUserId, row.actorRole);

    return {
      id: row.id,
      workflowId: row.workflowId,
      versionId: row.versionId,
      context: (row.context ?? {}) as unknown as RunContext,
      cursor: normaliseCursor(row.cursor),
      stepsExecuted: row.stepsExecuted,
      iterationsUsed: row.iterationsUsed,
      depth: row.depth,
      originChain: row.originChain ?? [],
      actor,
      // ⚠️ Read from the VERSION the run points at, which may be archived
      // by now. That is the whole reason archived versions are kept: a run
      // must execute the definition it started against, not the one that
      // happens to be live when it resumes.
      program: { steps: (version.steps ?? []) as WorkflowStep[] },
      stepBudget: version.stepBudget,
    };
  });
}

/**
 * The identity the run acts as.
 *
 * ⚠️ THE ROLE IS RE-READ, NOT TAKEN FROM THE RUN ROW.
 *
 * `workflow_runs.actor_role` is a snapshot for the history. Authorisation
 * uses the CURRENT role and the CURRENT overrides, so revoking somebody's
 * permissions takes effect on the automations they left behind — which is
 * the entire point of revoking them. A run that resumes after a delay is
 * the case that matters: the delay may have been thirty days.
 */
async function loadActor(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  userId: string,
  recordedRole: string,
): Promise<RunActor> {
  const result = await tx.execute(sql`
    SELECT role, status, permission_overrides
      FROM users
     WHERE id = ${userId}::uuid AND tenant_id = ${tenantId}::uuid
     LIMIT 1
  `);

  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
  const row = rows[0];

  if (!row) {
    // The user row is gone. Fail closed: a status nothing recognises means
    // `authoriseActor` refuses every step, with a message about it.
    return { userId, role: recordedRole as SystemRole, overrides: null, status: "missing" };
  }

  return {
    userId,
    role: row.role as SystemRole,
    overrides: (row.permission_overrides ?? null) as Record<string, boolean> | null,
    status: String(row.status),
  };
}

/* ------------------------------------------------------------------ */
/* ONE STEP                                                            */
/* ------------------------------------------------------------------ */

type StepResult =
  | { ok: true; run: LoadedRun }
  | { ok: false; message: string };

async function executeStep(args: {
  tenantId: string;
  run: LoadedRun;
  step: WorkflowStep;
  path: string;
  scope: Record<string, unknown>;
  cursor: Cursor;
  sequence: number;
  now: Date;
}): Promise<StepResult> {
  const { tenantId, run, step, scope } = args;
  const scopedContext = { ...run.context, ...scope } as RunContext;
  const iteration = typeof scope.index === "number" ? scope.index : null;

  let outcome: { input: Record<string, unknown>; output: Record<string, unknown> };

  try {
    outcome = await withTenant(tenantId, async (tx) => {
      return runEffect({
        tx,
        tenantId,
        actor: run.actor,
        step,
        context: scopedContext,
        runId: run.id,
        now: args.now,
      });
    });
  } catch (err) {
    const message =
      err instanceof EffectError || err instanceof ActorDeniedError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    // ⚠️ RECORDED IN A SEPARATE TRANSACTION. The failed effect's own
    // transaction rolled back — including any step row written inside it —
    // so the evidence has to be written by a transaction that did not fail.
    // This is the same lesson as `writeAudit` in Phase 5: history written
    // inside the thing it is recording disappears with it.
    await withTenant(tenantId, async (tx) => {
      await tx.insert(workflowRunSteps).values({
        tenantId,
        runId: run.id,
        stepKey: step.key,
        stepPath: args.path,
        actionType: step.action,
        status: "failed",
        iteration,
        sequence: args.sequence,
        error: message,
        finishedAt: args.now,
      });

      await tx
        .update(workflowRuns)
        .set({
          status: "failed",
          error: message,
          errorStepKey: step.key,
          finishedAt: args.now,
          cursor: args.cursor,
          updatedAt: args.now,
        })
        .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.tenantId, tenantId)));
    });

    return { ok: false, message };
  }

  const nextContext: RunContext = {
    ...run.context,
    steps: { ...(run.context.steps ?? {}), [step.key]: outcome.output },
  };

  const stepsExecuted = run.stepsExecuted + 1;
  const iterationsUsed = run.iterationsUsed + (iteration !== null ? 1 : 0);

  await withTenant(tenantId, async (tx) => {
    await tx.insert(workflowRunSteps).values({
      tenantId,
      runId: run.id,
      stepKey: step.key,
      stepPath: args.path,
      actionType: step.action,
      status: "succeeded",
      iteration,
      sequence: args.sequence,
      input: outcome.input,
      output: outcome.output,
      finishedAt: args.now,
    });

    await tx
      .update(workflowRuns)
      .set({
        context: nextContext as unknown as Record<string, unknown>,
        cursor: args.cursor,
        stepsExecuted,
        iterationsUsed,
        updatedAt: args.now,
      })
      .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.tenantId, tenantId)));
  });

  // ⭐ TELL THE DISPATCHER. This is where a workflow can trigger another
  // one — and therefore where every loop in the system begins.
  await announceRecordChange({
    tenantId,
    run,
    step,
    output: outcome.output,
    input: outcome.input,
    now: args.now,
  });

  return {
    ok: true,
    run: { ...run, context: nextContext, cursor: args.cursor, stepsExecuted, iterationsUsed },
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ CAUSING THE NEXT EVENT                                            */
/* ------------------------------------------------------------------ */

/**
 * A step changed a record; other workflows may be watching.
 *
 * ⚠️ THE PROVENANCE IS THREADED THROUGH, AND IT IS THE WHOLE POINT.
 *
 * `causedByRunId` becomes the child run's `parent_run_id`, from which the
 * database trigger recomputes depth and the causal chain. Forget it and
 * every child run looks like a fresh root: depth stays 0, the chain stays
 * empty, and a two-workflow ping-pong runs until somebody notices the
 * database is on fire.
 *
 * ⚠️ FAILURES HERE DO NOT FAIL THE PARENT RUN. The step already happened
 * and is already committed. Rolling back the parent because a downstream
 * workflow could not start would be undoing work that succeeded — and the
 * commonest reason for a refusal here is the loop guard doing its job,
 * which is not an error at all.
 */
async function announceRecordChange(args: {
  tenantId: string;
  run: LoadedRun;
  step: WorkflowStep;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  now: Date;
}): Promise<void> {
  const { step, output } = args;

  const type =
    step.action === "create_record"
      ? "record_created"
      : step.action === "update_record"
        ? "record_updated"
        : step.action === "delete_record"
          ? "record_deleted"
          : null;

  if (!type) return;
  if (output.created === false || output.updated === false || output.deleted === false) return;

  const recordId = typeof output.id === "string" ? output.id : undefined;
  const recordType = typeof output.recordType === "string" ? output.recordType : undefined;
  if (!recordId || !recordType) return;

  const changedFields =
    step.action === "update_record" || step.action === "create_record"
      ? Object.keys((args.input.values as Record<string, unknown>) ?? {})
      : [];

  try {
    await dispatchRecordEvent({
      tenantId: args.tenantId,
      actor: { userId: args.run.actor.userId, role: args.run.actor.role },
      event: {
        type,
        recordType,
        recordId,
        record: { id: recordId, ...((args.input.values as Record<string, unknown>) ?? {}) },
        changedFields,
        firedAt: args.now,
        causedByRunId: args.run.id,
        causedByVersionId: args.run.versionId,
        causedByDepth: args.run.depth,
        originChain: args.run.originChain,
      },
    });
  } catch (err) {
    // Includes the loop guard refusing a cycle, which is the system
    // working. Logged, never escalated.
    console.info("[workflows] downstream dispatch refused", {
      runId: args.run.id,
      step: step.key,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ------------------------------------------------------------------ */
/* SUSPENSION                                                          */
/* ------------------------------------------------------------------ */

async function suspendRun(
  tenantId: string,
  runId: string,
  args: { status: "waiting_delay" | "waiting_form"; cursor: Cursor; resumeAt?: Date | null },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        status: args.status,
        cursor: args.cursor,
        resumeAt: args.resumeAt ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  });
}

/**
 * Create the approval request and suspend.
 *
 * Returns a message when the request could not be created — in which case
 * the caller fails the run rather than leaving it waiting for something
 * that does not exist.
 */
async function requestApproval(args: {
  tenantId: string;
  run: LoadedRun;
  step: WorkflowStep;
  cursor: Cursor;
  scope: Record<string, unknown>;
  now: Date;
}): Promise<string | null> {
  const step = args.step as Extract<WorkflowStep, { action: "form" }>;
  const context = { ...args.run.context, ...args.scope } as RunContext;

  try {
    // The author's own permission to interrupt somebody. Checked here
    // rather than at publish alone, for the same reason every other
    // permission is: publish was months ago.
    const { authoriseActor } = await import("./guards");
    authoriseActor(args.run.actor, "workflows:request_approval");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const dueHours = Math.min(
    Math.max(1, step.dueInHours ?? DEFAULT_FORM_DUE_HOURS),
    MAX_FORM_DUE_HOURS,
  );

  const assignee = step.assignTo ? resolveValue(step.assignTo, context) : null;
  const assignedToUserId =
    typeof assignee === "string" && /^[0-9a-f-]{36}$/i.test(assignee) ? assignee : null;

  await withTenant(args.tenantId, async (tx) => {
    await tx.insert(workflowTasks).values({
      tenantId: args.tenantId,
      runId: args.run.id,
      stepKey: step.key,
      title: interpolate(step.title, context).slice(0, 200) || step.key,
      instructions: step.instructions ? interpolate(step.instructions, context) : null,
      assignedToUserId,
      status: "pending",
      expiresAt: new Date(args.now.getTime() + dueHours * 3_600_000),
    });

    await tx
      .update(workflowRuns)
      .set({
        status: "waiting_form",
        cursor: args.cursor,
        resumeAt: null,
        updatedAt: args.now,
      })
      .where(
        and(eq(workflowRuns.id, args.run.id), eq(workflowRuns.tenantId, args.tenantId)),
      );
  });

  return null;
}

/* ------------------------------------------------------------------ */
/* FINISHING                                                           */
/* ------------------------------------------------------------------ */

async function finishRun(
  tenantId: string,
  runId: string,
  args: {
    status: "succeeded" | "stopped" | "failed";
    error?: string;
    stopReason?: string;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        status: args.status,
        error: args.error ?? null,
        stopReason: args.stopReason ?? null,
        finishedAt: new Date(),
        resumeAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  });
}

async function nextSequence(tenantId: string, runId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ value: sql<string>`COALESCE(MAX(${workflowRunSteps.sequence}), 0)::text` })
      .from(workflowRunSteps)
      .where(
        and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.tenantId, tenantId)),
      );
    return Number(row?.value ?? "0");
  });
}

/**
 * A cursor read back from the database.
 *
 * ⚠️ An empty object is the column default, and it is NOT a finished run —
 * it is a run that has never started. Treating `{}` as "no frames left"
 * would mark every freshly queued run as succeeded, having done nothing,
 * which is the friendliest possible way to silently break the product.
 */
function normaliseCursor(value: unknown): Cursor {
  const candidate = value as Cursor | Record<string, never> | null;
  if (!candidate || !Array.isArray((candidate as Cursor).frames)) {
    return { frames: [{ list: [], index: 0 }] };
  }
  return candidate as Cursor;
}

/** Exported for the run-detail page: what a binding would resolve to. */
export function previewBinding(context: RunContext, path: string): unknown {
  return readPath(context, path);
}
