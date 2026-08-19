import "server-only";

/**
 * Ordence — Dispatch
 * Version: v0.23.0-alpha
 *
 * Something happened; which workflows should run, and as whom?
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DECISIONS ARE NOT MADE HERE
 * ══════════════════════════════════════════════════════════════════════
 * This file finds candidates and inserts rows. Whether a candidate fires
 * is decided by `decideTrigger` in `lib/workflows/triggers.ts`, which is
 * pure — so the four refusals that stop runaway execution (self-trigger,
 * cycle, depth, field scope) are tested without a database, and the same
 * function answers for the dispatcher, the builder's preview and the
 * "why did this not run?" panel.
 *
 * ⚠️ AND THE DECISIONS ARE MADE AGAIN, BY THE DATABASE.
 *
 * `workflow_runs_chain_guard` recomputes depth and the causal chain from
 * the parent row and refuses a cycle regardless of what this file
 * concluded. That is not belt and braces for its own sake: this file is
 * one of several things that can insert a run — an import, a support fix,
 * a future API route — and a loop guard that only exists in the code path
 * somebody remembered is a loop guard with a hole in it.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withTenant } from "@/db";
import { workflows, workflowVersions, workflowRuns } from "@/db/schema";
import {
  contextFromEvent,
  decideAll,
  type TriggerCandidate,
  type TriggerEvent,
} from "@/lib/workflows/triggers";
import { initialCursor } from "@/lib/workflows/planner";
import { nextCronFireAt } from "@/lib/workflows/cron";
import type { TriggerConfig, WorkflowTriggerType } from "@/lib/workflows/program";
import type { SystemRole } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type DispatchActor = {
  userId: string;
  role: SystemRole;
};

export type DispatchResult = {
  started: { runId: string; workflowId: string; versionId: string }[];
  /** Why each candidate did NOT fire. Surfaced in the "why?" panel. */
  skipped: { workflowId: string; reason: string; detail: string }[];
  /** Candidates dropped because one event may only start so many runs. */
  overflow: string[];
};

/* ------------------------------------------------------------------ */
/* CANDIDATES                                                          */
/* ------------------------------------------------------------------ */

type CandidateRow = TriggerCandidate & { runAsUserId: string | null };

async function loadCandidates(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  triggerType: WorkflowTriggerType,
): Promise<CandidateRow[]> {
  const rows = await tx
    .select({
      workflowId: workflows.id,
      isEnabled: workflows.isEnabled,
      archivedAt: workflows.archivedAt,
      versionId: workflowVersions.id,
      triggerType: workflowVersions.triggerType,
      triggerConfig: workflowVersions.triggerConfig,
      runAsUserId: workflowVersions.runAsUserId,
      createdAt: workflows.createdAt,
    })
    .from(workflowVersions)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, workflowVersions.workflowId),
        eq(workflows.tenantId, tenantId),
      ),
    )
    .where(
      and(
        eq(workflowVersions.tenantId, tenantId),
        eq(workflowVersions.status, "active"),
        eq(workflowVersions.triggerType, triggerType),
      ),
    )
    // ⚠️ DETERMINISTIC ORDER. When more workflows match than one event may
    // start, the ones that are dropped must always be the same ones —
    // otherwise the behaviour is random and the situation is undiagnosable.
    .orderBy(asc(workflows.createdAt), asc(workflows.id))
    .limit(100);

  return rows
    .filter((row) => row.archivedAt === null)
    .map((row) => ({
      workflowId: row.workflowId,
      versionId: row.versionId,
      triggerType: row.triggerType,
      triggerConfig: (row.triggerConfig ?? {}) as TriggerConfig,
      isEnabled: row.isEnabled,
      runAsUserId: row.runAsUserId,
    }));
}

/* ------------------------------------------------------------------ */
/* ⭐ RECORD EVENTS                                                    */
/* ------------------------------------------------------------------ */

/**
 * A record was created, changed or deleted. Start whatever should run.
 *
 * ⚠️ `event.causedByRunId` IS THE WHOLE LOOP STORY.
 *
 * When a person edits a lead, it is absent: the event is the root of a
 * new chain. When a WORKFLOW STEP edits a lead, the executor passes the
 * run that did it, and every guard downstream — self-trigger suppression,
 * cycle detection, depth — has the history it needs.
 *
 * An engine that forgets to thread this through has all the loop
 * protection in the world and no information to apply it to.
 */
export async function dispatchRecordEvent(args: {
  tenantId: string;
  actor: DispatchActor;
  event: TriggerEvent;
}): Promise<DispatchResult> {
  const { tenantId, actor, event } = args;

  return withTenant(tenantId, async (tx) => {
    const candidates = await loadCandidates(tx, tenantId, event.type);
    const decisions = decideAll(candidates, event);

    const result: DispatchResult = {
      started: [],
      skipped: decisions.skipped.map((d) => ({
        workflowId: d.candidate.workflowId,
        reason: d.fires ? "" : d.reason,
        detail: d.fires ? "" : d.detail,
      })),
      overflow: decisions.overflow.map((c) => c.workflowId),
    };

    for (const decision of decisions.firing) {
      const candidate = decision.candidate as CandidateRow;
      const context = contextFromEvent(event, {
        userId: actor.userId,
        role: actor.role,
      });

      const [row] = await tx
        .insert(workflowRuns)
        .values({
          tenantId,
          workflowId: candidate.workflowId,
          versionId: candidate.versionId,
          status: "queued",
          triggerType: event.type,
          recordType: event.recordType ?? null,
          recordId: event.recordId ?? null,
          context: context as unknown as Record<string, unknown>,
          cursor: initialCursor(),
          // ⭐ The run acts as the person whose change caused it — not as
          // the workflow's author, and never as the engine.
          actorUserId: actor.userId,
          actorRole: actor.role,
          // ⚠️ THE ONLY PROVENANCE COLUMN SUPPLIED. `depth`, `origin_chain`
          // and `root_run_id` are computed by the database trigger from
          // this parent. Sending them would mean the guard trusts its
          // caller, which is the same as not having one.
          parentRunId: event.causedByRunId ?? null,
        })
        .returning({ id: workflowRuns.id });

      if (row) {
        result.started.push({
          runId: row.id,
          workflowId: candidate.workflowId,
          versionId: candidate.versionId,
        });
      }
    }

    return result;
  });
}

/* ------------------------------------------------------------------ */
/* MANUAL                                                              */
/* ------------------------------------------------------------------ */

/**
 * Somebody pressed the button.
 *
 * ⚠️ THE RUN ACTS AS THE PRESSER, NOT AS THE AUTHOR.
 *
 * Which means a manual run can FAIL on a step the author could perform
 * and the presser cannot. That is correct and it is worth being explicit
 * about, because the "friendlier" alternative — run it as the author — is
 * a button that lends one person's authority to everybody who can see it.
 */
export async function dispatchManual(args: {
  tenantId: string;
  actor: DispatchActor;
  workflowId: string;
  recordId?: string;
  input?: Record<string, unknown>;
}): Promise<{ runId: string } | { refused: string }> {
  const { tenantId, actor } = args;

  return withTenant(tenantId, async (tx) => {
    const [candidate] = await tx
      .select({
        workflowId: workflows.id,
        isEnabled: workflows.isEnabled,
        archivedAt: workflows.archivedAt,
        versionId: workflowVersions.id,
        triggerType: workflowVersions.triggerType,
      })
      .from(workflowVersions)
      .innerJoin(
        workflows,
        and(eq(workflows.id, workflowVersions.workflowId), eq(workflows.tenantId, tenantId)),
      )
      .where(
        and(
          eq(workflowVersions.tenantId, tenantId),
          eq(workflowVersions.workflowId, args.workflowId),
          eq(workflowVersions.status, "active"),
        ),
      )
      .limit(1);

    if (!candidate) {
      return {
        refused:
          "This workflow has no published version, so there is nothing to run. " +
          "Publish a draft first.",
      };
    }
    if (candidate.archivedAt) return { refused: "This workflow has been archived." };
    if (!candidate.isEnabled) {
      return { refused: "This workflow is switched off. Switch it on to run it." };
    }
    if (candidate.triggerType !== "manual") {
      return {
        refused:
          `This workflow runs on "${candidate.triggerType}", not on demand. ` +
          `Running it by hand would give it a context its steps do not expect.`,
      };
    }

    const context = contextFromEvent(
      {
        type: "manual",
        recordId: args.recordId,
        input: args.input ?? null,
        firedAt: new Date(),
      },
      { userId: actor.userId, role: actor.role },
    );

    const [row] = await tx
      .insert(workflowRuns)
      .values({
        tenantId,
        workflowId: candidate.workflowId,
        versionId: candidate.versionId,
        status: "queued",
        triggerType: "manual",
        recordId: args.recordId ?? null,
        context: context as unknown as Record<string, unknown>,
        cursor: initialCursor(),
        actorUserId: actor.userId,
        actorRole: actor.role,
      })
      .returning({ id: workflowRuns.id });

    if (!row) return { refused: "The run could not be started." };
    return { runId: row.id };
  });
}

/* ------------------------------------------------------------------ */
/* SCHEDULED                                                           */
/* ------------------------------------------------------------------ */

/**
 * Start whatever is due, and compute the next fire.
 *
 * ⚠️ `next_run_at` IS ADVANCED FROM `now`, NOT FROM THE MISSED SLOT.
 *
 * If the dispatcher was down from 02:00 to 06:00, an hourly workflow does
 * NOT fire four times at 06:00. It fires once. Catch-up is the behaviour
 * everybody implements first and nobody wants: a four-hour outage becomes
 * a thousand emails at the moment the system comes back, which is the
 * worst possible moment.
 *
 * ⚠️ AND THE ROW IS CLAIMED BEFORE THE RUN IS CREATED. Two dispatchers
 * running at once would otherwise both see the same due workflow. The
 * UPDATE ... WHERE next_run_at = <the value we read> makes the claim
 * atomic: exactly one of them changes a row.
 */
export async function dispatchScheduled(args: {
  tenantId: string;
  now?: Date;
  limit?: number;
}): Promise<{ started: string[]; skipped: string[] }> {
  const now = args.now ?? new Date();
  const limit = Math.min(Math.max(1, args.limit ?? 25), 100);

  return withTenant(args.tenantId, async (tx) => {
    const due = await tx
      .select({
        workflowId: workflows.id,
        nextRunAt: workflows.nextRunAt,
        versionId: workflowVersions.id,
        triggerConfig: workflowVersions.triggerConfig,
        runAsUserId: workflowVersions.runAsUserId,
      })
      .from(workflows)
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.workflowId, workflows.id),
          eq(workflowVersions.tenantId, args.tenantId),
          eq(workflowVersions.status, "active"),
        ),
      )
      .where(
        and(
          eq(workflows.tenantId, args.tenantId),
          eq(workflows.isEnabled, true),
          sql`${workflows.archivedAt} IS NULL`,
          sql`${workflows.nextRunAt} IS NOT NULL AND ${workflows.nextRunAt} <= ${now}`,
        ),
      )
      .limit(limit);

    const started: string[] = [];
    const skipped: string[] = [];

    for (const row of due) {
      const config = (row.triggerConfig ?? {}) as TriggerConfig;
      const nextRunAt = config.cron
        ? nextCronFireAt(config.cron, now, config.timezone ?? "UTC")
        : null;

      const claimed = await tx
        .update(workflows)
        .set({ nextRunAt: nextRunAt ?? null, lastRunAt: now, updatedAt: now })
        .where(
          and(
            eq(workflows.id, row.workflowId),
            eq(workflows.tenantId, args.tenantId),
            // The atomic claim. If another dispatcher got here first, this
            // matches nothing and we skip.
            sql`${workflows.nextRunAt} = ${row.nextRunAt}`,
          ),
        )
        .returning({ id: workflows.id });

      if (claimed.length === 0) {
        skipped.push(row.workflowId);
        continue;
      }

      // ⚠️ NO ACTOR, NO RUN. The publisher's user row is gone (the
      // composite FK set this to NULL when they were deleted), so there is
      // nobody for the run to act as. Refusing is the point: an automation
      // acting on behalf of somebody who no longer works here is exactly
      // what should stop.
      if (!row.runAsUserId) {
        skipped.push(row.workflowId);
        continue;
      }

      const actorRole = await roleOf(tx, args.tenantId, row.runAsUserId);
      if (!actorRole) {
        skipped.push(row.workflowId);
        continue;
      }

      const context = contextFromEvent(
        { type: "scheduled", firedAt: now },
        { userId: row.runAsUserId, role: actorRole },
      );

      const [run] = await tx
        .insert(workflowRuns)
        .values({
          tenantId: args.tenantId,
          workflowId: row.workflowId,
          versionId: row.versionId,
          status: "queued",
          triggerType: "scheduled",
          context: context as unknown as Record<string, unknown>,
          cursor: initialCursor(),
          actorUserId: row.runAsUserId,
          actorRole,
        })
        .returning({ id: workflowRuns.id });

      if (run) started.push(run.id);
    }

    return { started, skipped };
  });
}

/* ------------------------------------------------------------------ */
/* WEBHOOK                                                             */
/* ------------------------------------------------------------------ */

/**
 * An external system called in.
 *
 * ⚠️ THE TOKEN IS COMPARED IN CONSTANT TIME, AGAINST A HASH.
 *
 * Two separate points. The hash means a leak of the `workflows` table —
 * a backup, a support session, a `SELECT *` in a screenshot — is not a
 * leak of the credential. The constant-time comparison means the number
 * of matching leading characters is not observable in the response time,
 * which is how a token gets guessed one character at a time by somebody
 * with patience and a script.
 *
 * ⚠️ THE TENANT IS RESOLVED FROM THE PATH, NOT FROM THE TOKEN. Looking a
 * token up across all tenants would need a query that bypasses RLS, and
 * an unauthenticated endpoint that runs a cross-tenant query is the
 * beginning of a bad afternoon. The caller supplies both; the token then
 * only has to be unique within the workspace.
 */
export async function dispatchWebhook(args: {
  tenantId: string;
  workflowId: string;
  token: string;
  payload?: Record<string, unknown>;
}): Promise<{ runId: string } | { refused: string }> {
  return withTenant(args.tenantId, async (tx) => {
    const [candidate] = await tx
      .select({
        workflowId: workflows.id,
        isEnabled: workflows.isEnabled,
        archivedAt: workflows.archivedAt,
        secretHash: workflows.webhookSecretHash,
        versionId: workflowVersions.id,
        triggerType: workflowVersions.triggerType,
        runAsUserId: workflowVersions.runAsUserId,
      })
      .from(workflowVersions)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, workflowVersions.workflowId),
          eq(workflows.tenantId, args.tenantId),
        ),
      )
      .where(
        and(
          eq(workflowVersions.tenantId, args.tenantId),
          eq(workflowVersions.workflowId, args.workflowId),
          eq(workflowVersions.status, "active"),
        ),
      )
      .limit(1);

    // ⚠️ ONE MESSAGE FOR EVERY REFUSAL. "No such workflow", "wrong token"
    // and "switched off" are the same sentence to the caller, because the
    // difference between them is an oracle: it tells an unauthenticated
    // stranger which workflow ids are real.
    const refusal = { refused: "This webhook is not available." };

    if (!candidate || candidate.archivedAt || !candidate.isEnabled) return refusal;
    if (candidate.triggerType !== "webhook") return refusal;
    if (!candidate.secretHash || !verifyWebhookToken(args.token, candidate.secretHash)) {
      return refusal;
    }
    if (!candidate.runAsUserId) return refusal;

    const actorRole = await roleOf(tx, args.tenantId, candidate.runAsUserId);
    if (!actorRole) return refusal;

    const context = contextFromEvent(
      { type: "webhook", input: args.payload ?? null, firedAt: new Date() },
      { userId: candidate.runAsUserId, role: actorRole },
    );

    const [run] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: args.tenantId,
        workflowId: candidate.workflowId,
        versionId: candidate.versionId,
        status: "queued",
        triggerType: "webhook",
        context: context as unknown as Record<string, unknown>,
        cursor: initialCursor(),
        actorUserId: candidate.runAsUserId,
        actorRole,
      })
      .returning({ id: workflowRuns.id });

    if (!run) return refusal;
    return { runId: run.id };
  });
}

/** Generate a webhook token. Returned once; only its hash is stored. */
export function generateWebhookToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashWebhookToken(token) };
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function verifyWebhookToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashWebhookToken(token ?? ""), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  // ⚠️ `timingSafeEqual` throws on a length mismatch, which would itself
  // be an observable difference. Both sides are SHA-256 digests, so the
  // lengths match unless the stored value is corrupt — checked, not
  // assumed.
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

async function roleOf(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  userId: string,
): Promise<SystemRole | null> {
  const result = await tx.execute(sql`
    SELECT role, status FROM users
     WHERE id = ${userId}::uuid AND tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
     LIMIT 1
  `);
  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);
  const row = rows[0];
  if (!row) return null;
  // A suspended user authorises nothing; `authoriseActor` says so too,
  // but refusing to start the run at all avoids creating a run whose every
  // step is going to fail.
  if (row.status !== "active") return null;
  return row.role as SystemRole;
}
