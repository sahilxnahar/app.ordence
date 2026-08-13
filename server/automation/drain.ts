import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE OTHER HALF OF THE BRIDGE
 * Version: v1.19.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `dispatchRecordEvent` HAS BEEN COMPLETE AND UNCALLED SINCE v0.23.0
 * ══════════════════════════════════════════════════════════════════════
 * It finds candidate workflows, asks the pure `decideAll` whether each
 * fires, and inserts the runs. It handles self-trigger, cycles, depth and
 * field scope. It was written correctly and `server/actions/workflows.ts`
 * imports its three siblings and not it.
 *
 * ⚠️ SO A WORKFLOW COULD BE STARTED BY A BUTTON, A SCHEDULE OR A WEBHOOK,
 * AND NEVER BY ANYTHING THE BUSINESS DID. This file is the loop that
 * takes 0068's queue and finally hands it to that function.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT IS DELIBERATELY BORING, AND EVERY INTERESTING DECISION IS
 * SOMEBODY ELSE'S
 * ══════════════════════════════════════════════════════════════════════
 * Whether a workflow fires is `decideAll`, which is pure and tested
 * without a database. Whether a chain is a cycle is the database trigger
 * `workflow_runs_chain_guard`, which recomputes from the parent row and
 * does not trust its caller. This file decides only which events to pick
 * up and in what order.
 */

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { automationEvents } from "@/db/schema/patterns";
import { dispatchRecordEvent } from "@/server/workflows/dispatch";
import { dispatchAgentsForEvent } from "./agent-dispatch";
import type { WorkflowTriggerType } from "@/lib/workflows/program";

/**
 * 🔴 HOW MANY EVENTS ONE PASS WILL TAKE.
 *
 * ⚠️ Unbounded draining is how a backlog turns into a stall: a queue
 * with forty thousand rows in it holds a connection for minutes and the
 * next pass finds the same rows locked. A bounded pass that runs again
 * shortly is slower on paper and finishes.
 */
export const DRAIN_BATCH = 200;

/**
 * ⭐ HOW OLD AN EVENT MAY BE AND STILL BE ACTED ON.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A STALE EVENT IS WORSE THAN A MISSED ONE
 * ══════════════════════════════════════════════════════════════════════
 * If the drainer has been down for two days, running every queued
 * workflow at once sends two days of reminders in one minute, to real
 * customers, at real cost. The messages are individually correct and the
 * effect is a business that looks like it is malfunctioning, because it
 * is.
 *
 * ⚠️ SO OLD EVENTS ARE MARKED PROCESSED WITH A REASON RATHER THAN RUN.
 * The row stays, the reason is readable, and somebody can decide to
 * replay deliberately. Silently discarding them would be the same
 * outcome with no evidence.
 */
export const STALE_AFTER_HOURS = 6;

export interface DrainReport {
  readonly considered: number;
  readonly dispatched: number;
  readonly runsStarted: number;
  /** ⭐ v1.20.0: agents started by the same events. */
  readonly agentRunsStarted: number;
  readonly stale: number;
  readonly failed: number;
  readonly note: string;
}

export async function drainAutomationEvents(args: {
  readonly tenantId: string;
  readonly now: Date;
  readonly limit?: number;
  /**
   * ⚠️ WHO THE RESULTING RUNS ACT AS. `dispatchRecordEvent` takes an
   * actor because a run acts as the person whose change caused it, never
   * as the workflow's author and never as the engine. An event queue has
   * no person standing at it, so the caller has to say.
   */
  readonly actor: { userId: string; role: string };
}): Promise<DrainReport> {
  const { tenantId, now } = args;
  const limit = args.limit ?? DRAIN_BATCH;
  const staleBefore = new Date(now.getTime() - STALE_AFTER_HOURS * 3_600_000);

  const pending = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: automationEvents.id,
        triggerType: automationEvents.triggerType,
        recordType: automationEvents.recordType,
        recordId: automationEvents.recordId,
        changedFields: automationEvents.changedFields,
        payload: automationEvents.payload,
        occurredAt: automationEvents.occurredAt,
      })
      .from(automationEvents)
      .where(
        and(
          eq(automationEvents.tenantId, tenantId),
          isNull(automationEvents.processedAt),
          // ⭐ Never pick up an event dated in the future. A clock skew
          // on one machine should not start work early.
          lte(automationEvents.occurredAt, now),
        ),
      )
      // ⚠️ OLDEST FIRST, ALWAYS. Order matters to anybody reading the
      // run history afterwards, and newest-first makes a backlog look
      // like the system started in the middle.
      .orderBy(asc(automationEvents.occurredAt))
      .limit(limit),
  );

  let dispatched = 0;
  let runsStarted = 0;
  let agentRunsStarted = 0;
  let stale = 0;
  let failed = 0;

  for (const event of pending as Array<Record<string, unknown>>) {
    const occurredAt = event.occurredAt as Date;
    const id = event.id as string;

    if (occurredAt.getTime() < staleBefore.getTime()) {
      stale += 1;
      await markProcessed(tenantId, id, now, 0, {
        error: `Not run: this event is older than ${STALE_AFTER_HOURS} hours. Acting on it now would fire work the business has already moved past, so it is recorded and skipped rather than replayed.`,
      });
      continue;
    }

    try {
      const result = await dispatchRecordEvent({
        tenantId,
        actor: {
          userId: args.actor.userId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role: args.actor.role as any,
        },
        event: {
          type: event.triggerType as WorkflowTriggerType,
          recordType: event.recordType as string,
          recordId: event.recordId as string,
          changedFields: (event.changedFields as string[] | null) ?? undefined,
          input: (event.payload as Record<string, unknown> | null) ?? null,
          firedAt: occurredAt,
        },
      });

      dispatched += 1;
      runsStarted += result.started.length;

      /**
       * ⭐⭐ THE SECOND CONSUMER OF THE SAME EVENT, ADDED IN v1.20.0.
       *
       * ⚠️ AN EVENT MAY LEGITIMATELY DO BOTH. A workflow moves the record
       * along; the agent drafts the note that goes with it. Neither knows
       * about the other, which is why this is a separate call rather than
       * a branch inside the dispatcher.
       *
       * 🔴 A FAILING AGENT MUST NOT LOSE THE WORKFLOW RUN that already
       * succeeded, so this is caught here rather than allowed to reach
       * the outer handler that marks the whole event failed.
       */
      try {
        const agentReport = await withTenant(tenantId, async (tx) =>
          dispatchAgentsForEvent({
            tx,
            tenantId,
            now,
            eventId: id,
            context: {
              triggerType: event.triggerType as string,
              recordType: event.recordType as string,
              recordId: event.recordId as string,
              payload:
                (event.payload as Record<string, unknown> | null) ?? {},
            },
          }),
        );
        agentRunsStarted += agentReport.started;
      } catch {
        // ⚠️ Deliberately swallowed and NOT counted as an event failure.
        // The agent's own run row already carries its error; the event
        // itself was dispatched correctly.
      }

      await markProcessed(tenantId, id, now, result.started.length, null);
    } catch (e) {
      failed += 1;
      /**
       * 🔴 A FAILED EVENT IS MARKED PROCESSED WITH ITS REASON, NOT LEFT
       * PENDING.
       *
       * ⚠️ Leaving it pending means the next pass picks it up, fails the
       * same way, and the queue never drains past the first poisonous
       * row. A retry loop that cannot make progress is an outage that
       * looks like a backlog.
       */
      await markProcessed(tenantId, id, now, 0, {
        error: e instanceof Error ? e.message : "Dispatch failed.",
      });
    }
  }

  const parts: string[] = [];
  if (dispatched > 0) parts.push(`${dispatched} dispatched`);
  if (runsStarted > 0) parts.push(`${runsStarted} workflow run(s) started`);
  if (agentRunsStarted > 0) parts.push(`${agentRunsStarted} agent draft(s) written`);
  if (stale > 0) parts.push(`${stale} skipped as stale`);
  if (failed > 0) parts.push(`${failed} failed`);

  return {
    considered: pending.length,
    dispatched,
    runsStarted,
    agentRunsStarted,
    stale,
    failed,
    note:
      parts.length > 0
        ? parts.join(", ")
        : "Nothing waiting. On most passes this is the correct answer.",
  };
}

async function markProcessed(
  tenantId: string,
  eventId: string,
  now: Date,
  runsStarted: number,
  failure: { error: string } | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(automationEvents)
      .set({
        processedAt: now,
        runsStarted,
        errorMessage: failure ? failure.error.slice(0, 500) : null,
      })
      .where(
        and(
          eq(automationEvents.tenantId, tenantId),
          eq(automationEvents.id, eventId),
        ),
      );
  });
}

/**
 * ⭐ HOUSEKEEPING, BECAUSE 0068 MADE `purge_after` NOT NULL AND NOBODY
 * WAS EVER GOING TO ACT ON IT.
 *
 * ⚠️ A retention column with no deleter is a promise in a comment. This
 * is the deleter, and it removes only rows that have been dealt with:
 * an unprocessed event past its purge date is a bug worth seeing rather
 * than a row worth tidying away.
 */
export async function purgeExpiredEvents(args: {
  tenantId: string;
  today: string;
}): Promise<number> {
  return withTenant(args.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      DELETE FROM automation_events
       WHERE tenant_id = ${args.tenantId}::uuid
         AND purge_after < ${args.today}::date
         AND processed_at IS NOT NULL
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Number((result as any)?.rowCount ?? 0);
  });
}
