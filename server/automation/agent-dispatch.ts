import "server-only";

/**
 * Ordence — ⭐⭐⭐ AN AGENT THAT RUNS BY ITSELF
 * Version: v1.20.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE RULE THAT MAKES THIS SAFE, STATED BEFORE ANYTHING ELSE
 * ══════════════════════════════════════════════════════════════════════
 * AN AGENT THAT RUNS WITHOUT A PERSON PRESENT MAY NOT ACT WITHOUT ONE.
 *
 * It writes text into `agent_runs.output` and stops. It sends no message,
 * changes no record, and spends no money. Sending stays where it already
 * is: behind the campaign approval with its typed amount, the consent
 * gate, and the daily spend cap.
 *
 * ⚠️ THE FAILURE THIS PREVENTS IS THE OBVIOUS FEATURE. An agent bound to
 * "a lead was created", given a write tool and a WhatsApp template, would
 * message every new lead the instant it arrives, at roughly ₹1 each, to
 * people who never consented, from a number that gets banned for exactly
 * that. Every step in that chain is individually reasonable and somebody
 * would ship it in an afternoon.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS THE SECOND CONSUMER OF 0068'S QUEUE
 * ══════════════════════════════════════════════════════════════════════
 * v1.19.0 wired the queue to `dispatchRecordEvent`, which starts
 * workflows. This reads the same rows and starts agents. Neither knows
 * about the other, and an event may legitimately do both: a workflow
 * moves the record along, the agent drafts the note that goes with it.
 */

import { and, eq, sql } from "drizzle-orm";
import { agentDefinitions, agentRuns, agentTriggers } from "@/db/schema/agents";
import { chatCompletion } from "@/lib/ai/client";
import type { Sensitivity } from "@/lib/ai/router";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/** 🔴 DPDP: a run's output may quote somebody's data. */
export const RUN_RETENTION_DAYS = 90;

/**
 * ⚠️ HOW MUCH OF THE EVENT THE AGENT IS TOLD.
 *
 * 🔴 NOT THE RECORD. The event carries a type, an id and a small payload,
 * and that is all the agent gets. Handing it the whole row would send a
 * customer's details to whichever provider answered, and for an `open`
 * lane agent that provider may train on them.
 *
 * ⭐ AN AGENT THAT NEEDS THE RECORD HAS A TOOL, WHICH PUTS IT ON THE
 * CONFIDENTIAL LANE, WHICH IS THE WHOLE POINT OF THE LANE.
 */
export interface AgentEventContext {
  readonly triggerType: string;
  readonly recordType: string;
  readonly recordId: string;
  readonly payload: Record<string, unknown>;
}

export interface AgentDispatchReport {
  readonly matched: number;
  readonly started: number;
  readonly cappedOut: number;
  readonly failed: number;
}

export async function dispatchAgentsForEvent(args: {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly now: Date;
  readonly eventId: string;
  readonly context: AgentEventContext;
}): Promise<AgentDispatchReport> {
  const { tx, tenantId, now, eventId, context } = args;

  const bindings = await tx
    .select({
      triggerId: agentTriggers.id,
      agentId: agentTriggers.agentId,
      dailyCap: agentTriggers.dailyCap,
      name: agentDefinitions.name,
      systemPrompt: agentDefinitions.systemPrompt,
      sensitivity: agentDefinitions.sensitivity,
      tools: agentDefinitions.tools,
      isEnabled: agentDefinitions.isEnabled,
    })
    .from(agentTriggers)
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentTriggers.agentId))
    .where(
      and(
        eq(agentTriggers.tenantId, tenantId),
        eq(agentTriggers.isEnabled, true),
        eq(agentTriggers.recordType, context.recordType),
        eq(agentTriggers.triggerType, context.triggerType),
        eq(agentDefinitions.isEnabled, true),
      ),
    );

  let started = 0;
  let cappedOut = 0;
  let failed = 0;

  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);

  for (const b of bindings as Array<Record<string, unknown>>) {
    const agentId = b.agentId as string;

    /**
     * ⭐ THE CAP, COUNTED FROM THE RUNS THEMSELVES.
     *
     * ⚠️ A counter column has to be reset, and a reset that does not
     * happen is a cap that stops working silently at midnight on the day
     * somebody needed it. Counting rows cannot drift.
     */
    const usedRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.tenantId, tenantId),
          eq(agentRuns.agentId, agentId),
          sql`${agentRuns.startedAt} >= ${midnight.toISOString()}::timestamptz`,
        ),
      );

    const used = Number((usedRows as Array<{ n: number }>)[0]?.n ?? 0);
    if (used >= Number(b.dailyCap ?? 50)) {
      cappedOut += 1;
      continue;
    }

    const purgeAfter = new Date(now.getTime() + RUN_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    // 🔴 THE RUN ROW IS OPENED FIRST, so an agent that hangs or crashes
    // still leaves evidence it was started. The same ordering the
    // credential reads use, for the same reason.
    const [run] = await tx
      .insert(agentRuns)
      .values({
        tenantId,
        agentId,
        startedBy: "event",
        // ⚠️ NULL. Nobody was standing there, and naming a person for
        // something they did not do is worse than an empty column.
        userId: null,
        eventId,
        sensitivity: b.sensitivity as string,
        purgeAfter,
        startedAt: now,
      })
      .returning({ id: agentRuns.id });

    if (!run) {
      failed += 1;
      continue;
    }

    try {
      const answer = await chatCompletion({
        sensitivity: b.sensitivity as Sensitivity,
        messages: [
          { role: "system", content: String(b.systemPrompt) },
          {
            role: "user",
            content: describeEvent(context),
          },
        ],
        temperature: 0.4,
      });

      if (answer.ok) {
        await tx
          .update(agentRuns)
          .set({
            // ⚠️ The content may legitimately be null when the model
            // chose to make a tool call and nothing else. Recorded as
            // null rather than as an empty string, because "it said
            // nothing" and "it said the empty string" are different.
            output:
              typeof answer.result.message.content === "string"
                ? answer.result.message.content.slice(0, 20_000)
                : null,
            providerId: answer.providerId,
            tokensUsed: answer.result.usage?.total_tokens ?? null,
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        started += 1;
      } else {
        /**
         * ⚠️ A REFUSAL IS RECORDED AS ITS OWN SENTENCE, not as a generic
         * failure. The router refuses for reasons a person can act on:
         * no confidential provider is configured, every provider is out
         * of budget, the breaker is open. "Agent failed" tells them none
         * of that.
         */
        await tx
          .update(agentRuns)
          .set({
            errorMessage: String(answer.reason ?? "The router refused.").slice(0, 500),
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
        failed += 1;
      }
    } catch (e) {
      await tx
        .update(agentRuns)
        .set({
          errorMessage:
            e instanceof Error ? e.message.slice(0, 500) : "The agent did not finish.",
          finishedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));
      failed += 1;
    }
  }

  return { matched: bindings.length, started, cappedOut, failed };
}

/**
 * ⭐ WHAT THE AGENT IS ACTUALLY ASKED.
 *
 * ⚠️ DELIBERATELY THIN, AND IT NAMES ITS OWN LIMITS. An agent told only
 * that "a lead was created" will either use its tools to go and look, or
 * say it needs more. Both are better than being handed a record it did
 * not ask for and may not be cleared to see.
 */
function describeEvent(c: AgentEventContext): string {
  const payload =
    Object.keys(c.payload).length > 0
      ? `\n\nWhat we know about it: ${JSON.stringify(c.payload)}`
      : "";

  return `Something happened in this workspace and you have been asked to respond to it.

WHAT HAPPENED: ${c.triggerType.replace(/_/g, " ")}
WHAT KIND OF RECORD: ${c.recordType.replace(/_/g, " ")}
ITS ID: ${c.recordId}${payload}

Nobody is watching this run. Write your answer as something a person will read later.

You cannot send anything, message anyone, or change any record from here. If the right next step is to contact somebody, write the message you would send and say who should send it and why. Somebody will decide.`;
}
