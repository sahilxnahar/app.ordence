"use server";

/**
 * Ordence — ⭐⭐⭐ A TENANT'S OWN AGENTS
 * Version: v1.20.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO RULES THIS FILE EXISTS TO ENFORCE
 * ══════════════════════════════════════════════════════════════════════
 * ① AN AGENT WITH ANY TOOL IS ON THE CONFIDENTIAL LANE. A tool returns
 *    real business data, and most free AI providers reserve the right to
 *    train on what they are sent. `lib/ai/providers.ts` already sorts
 *    them by that; this is the half that decides which lane an agent
 *    belongs in, and it is not a choice the tenant gets to make.
 *
 * ② AN AGENT THAT RUNS WITHOUT A PERSON PRESENT MAY NOT ACT WITHOUT ONE.
 *    An event-triggered run writes text into `agent_runs.output` and
 *    stops. Sending stays behind the campaign approval, the consent gate
 *    and the daily spend cap that already exist.
 *
 * ⚠️ THE FAILURE ② PREVENTS IS NOT HYPOTHETICAL. An agent bound to
 * "a lead was created", holding a write tool and a WhatsApp template,
 * would message every new lead the moment it arrives, at about ₹1 each,
 * to people who never consented, from a number that gets banned for it.
 * Every step is individually reasonable.
 */

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { agentDefinitions, agentRuns, agentTriggers } from "@/db/schema/agents";
import { requirePermission, writeAudit } from "@/server/audit";
import { requireFeature } from "@/server/entitlements";
import { toSalesActionError } from "@/server/sales/guards";
import {
  CATALOGUE_BY_KEY,
  STARTER_CATALOGUE,
  laneFor,
  type CatalogueAgent,
} from "@/lib/ai/agents/catalogue";
import { MCP_TOOLS } from "@/lib/mcp/registry";
import type { ActionResult } from "@/lib/validators/crm";

const MANAGE = "settings:update" as const;

/**
 * ⭐ THE ENTITLEMENT — Batch 0109.
 *
 * ⚠️ `ai.copilot` sits at the `ai` tier in the price list and, until
 * this batch, was refused by nothing anywhere in the product. Installing,
 * editing and arming an agent are the three writes that CREATE the thing
 * the tier is sold for, so the gate is on those and not on
 * `getAgentShelf` or `getAgentRuns` — a workspace that drops off the AI
 * tier keeps reading what its agents did, because that record is theirs.
 */
const AI_FEATURE = "ai.copilot" as const;

/* ------------------------------------------------------------------ */
/* THE SHELF                                                           */
/* ------------------------------------------------------------------ */

export interface ShelfItem {
  readonly key: string;
  readonly label: string;
  readonly blurb: string;
  readonly tools: readonly string[];
  readonly sensitivity: string;
  readonly installed: boolean;
}

export async function getAgentShelf(): Promise<
  ActionResult<{ shelf: readonly ShelfItem[]; mine: readonly MyAgent[] }>
> {
  try {
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select()
          .from(agentDefinitions)
          .where(eq(agentDefinitions.tenantId, ctx.tenant.id))
          .orderBy(desc(agentDefinitions.createdAt));

        const installedKeys = new Set(
          (rows as Array<Record<string, unknown>>)
            .map((r) => r.catalogueKey as string | null)
            .filter(Boolean),
        );

        const triggers = await tx
          .select()
          .from(agentTriggers)
          .where(eq(agentTriggers.tenantId, ctx.tenant.id));

        const byAgent = new Map<string, Array<Record<string, unknown>>>();
        for (const t of triggers as Array<Record<string, unknown>>) {
          const k = t.agentId as string;
          if (!byAgent.has(k)) byAgent.set(k, []);
          byAgent.get(k)!.push(t);
        }

        return {
          ok: true as const,
          data: {
            shelf: STARTER_CATALOGUE.map((c) => ({
              key: c.key,
              label: c.label,
              blurb: c.blurb,
              tools: c.tools,
              sensitivity: c.sensitivity,
              installed: installedKeys.has(c.key),
            })),
            mine: (rows as Array<Record<string, unknown>>).map((r) => ({
              id: r.id as string,
              name: r.name as string,
              blurb: (r.blurb as string | null) ?? "",
              catalogueKey: (r.catalogueKey as string | null) ?? null,
              tools: (r.tools as string[] | null) ?? [],
              sensitivity: r.sensitivity as string,
              isEnabled: r.isEnabled as boolean,
              triggers: (byAgent.get(r.id as string) ?? []).map((t) => ({
                id: t.id as string,
                triggerType: t.triggerType as string,
                recordType: t.recordType as string,
                dailyCap: t.dailyCap as number,
                isEnabled: t.isEnabled as boolean,
              })),
            })),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getAgentShelf");
  }
}

export interface MyAgent {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly catalogueKey: string | null;
  readonly tools: readonly string[];
  readonly sensitivity: string;
  readonly isEnabled: boolean;
  readonly triggers: ReadonlyArray<{
    id: string;
    triggerType: string;
    recordType: string;
    dailyCap: number;
    isEnabled: boolean;
  }>;
}

/* ------------------------------------------------------------------ */
/* INSTALL                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ COPY A SHELF ITEM INTO THE TENANT. The copy is theirs from that
 * moment: editing it never changes the shelf, and a later catalogue
 * update never overwrites their words.
 *
 * ⚠️ THE ALTERNATIVE WAS A REFERENCE RATHER THAN A COPY, and it is worse
 * in the way that only shows up later. A tenant who has spent an hour
 * making an agent sound like their business, then finds it reverted
 * because the vendor improved the wording, does not use agents again.
 */
export async function installAgent(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    await requireFeature(AI_FEATURE);
    const { catalogueKey } = z
      .object({ catalogueKey: z.string().min(1).max(80) })
      .parse(input);
    const ctx = await requirePermission(MANAGE);

    const item: CatalogueAgent | undefined = CATALOGUE_BY_KEY[catalogueKey];
    if (!item) return { ok: false, error: "There is no such agent on the shelf." };

    const unknownTools = item.tools.filter((t) => !toolExists(t));
    if (unknownTools.length > 0) {
      // 🔴 A CATALOGUE ENTRY NAMING A TOOL THAT DOES NOT EXIST IS A BUG
      // IN THE CATALOGUE, and installing it would produce an agent that
      // fails on its first useful question.
      return {
        ok: false,
        error: `This agent asks for tools Ordence does not have: ${unknownTools.join(", ")}. That is a fault in the catalogue rather than in your workspace.`,
      };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(agentDefinitions)
          .values({
            tenantId: ctx.tenant.id,
            catalogueKey: item.key,
            name: item.label,
            blurb: item.blurb,
            systemPrompt: item.systemPrompt,
            tools: [...item.tools],
            // 🔴 DERIVED, NEVER COPIED FROM THE SHELF. If a catalogue
            // entry ever claims `open` while carrying a tool, this is
            // where that claim stops.
            sensitivity: laneFor(item.tools),
            isEnabled: true,
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: agentDefinitions.id });

        if (!row) throw new Error("The agent could not be installed.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "agent_definition",
          resourceId: row.id,
          newValue: { catalogueKey: item.key, lane: laneFor(item.tools) },
          severity: "notice",
        });

        return { id: row.id, name: item.label };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/assistant/agents");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "installAgent");
  }
}

/* ------------------------------------------------------------------ */
/* EDIT                                                                */
/* ------------------------------------------------------------------ */

const editSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(160).optional(),
  blurb: z.string().max(400).optional(),
  systemPrompt: z.string().min(20).max(60_000).optional(),
  tools: z.array(z.string().min(1).max(80)).max(40).optional(),
  isEnabled: z.boolean().optional(),
});

/**
 * ⚠️ THE LANE IS RECOMPUTED ON EVERY EDIT AND IS NOT AN INPUT.
 *
 * 🔴 THE DANGEROUS EDIT IS NOT THE INSTALL. It is somebody adding a tool
 * six months later to an agent that has always been `open`. Nothing
 * about that edit looks alarming on a screen, and the agent silently
 * begins sending customer records to a provider chosen for being fast
 * and free. 0071 carries the same rule as a CHECK, so a future caller
 * that forgets this is refused by the database rather than trusted.
 */
export async function editAgent(
  input: unknown,
): Promise<ActionResult<{ sensitivity: string; laneChanged: boolean }>> {
  try {
    await requireFeature(AI_FEATURE);
    const data = editSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    if (data.tools) {
      const unknown = data.tools.filter((t) => !toolExists(t));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `Ordence has no tool called ${unknown.join(", ")}. An agent can only be given tools that already exist.`,
        };
      }
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(agentDefinitions)
          .where(
            and(
              eq(agentDefinitions.tenantId, ctx.tenant.id),
              eq(agentDefinitions.id, data.agentId),
            ),
          )
          .limit(1);

        if (!existing) throw new Error("No such agent.");

        const tools = data.tools ?? ((existing.tools as string[] | null) ?? []);
        const lane = laneFor(tools);
        const laneChanged = lane !== (existing.sensitivity as string);

        await tx
          .update(agentDefinitions)
          .set({
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.blurb !== undefined ? { blurb: data.blurb } : {}),
            ...(data.systemPrompt !== undefined
              ? { systemPrompt: data.systemPrompt }
              : {}),
            tools: [...tools],
            sensitivity: lane,
            ...(data.isEnabled !== undefined ? { isEnabled: data.isEnabled } : {}),
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(agentDefinitions.tenantId, ctx.tenant.id),
              eq(agentDefinitions.id, data.agentId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "agent_definition",
          resourceId: data.agentId,
          newValue: { tools, sensitivity: lane, laneChanged },
          // ⭐ A LANE CHANGE IS CRITICAL, because it changes which
          // companies are allowed to see this tenant's data.
          severity: laneChanged ? "critical" : "notice",
        });

        return { sensitivity: lane, laneChanged };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/assistant/agents");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "editAgent");
  }
}

/* ------------------------------------------------------------------ */
/* THE TRIGGER                                                         */
/* ------------------------------------------------------------------ */

const bindSchema = z.object({
  agentId: z.string().uuid(),
  triggerType: z.enum([
    "record_created",
    "record_updated",
    "record_deleted",
    "webhook",
  ]),
  recordType: z.string().min(1).max(40),
  dailyCap: z.number().int().min(1).max(1000).default(50),
});

/**
 * ⭐⭐ THE POINT AT WHICH AN AGENT BECOMES AUTONOMOUS.
 *
 * ⚠️ AND THE POINT AT WHICH THE CAP MATTERS. A binding on
 * `record_updated` against a busy table will fire hundreds of times a
 * day. Free AI tiers have rate limits, so one careless trigger exhausts
 * the quota before lunch and every other agent in the workspace stops
 * working for reasons that look unrelated.
 */
export async function bindAgentTrigger(
  input: unknown,
): Promise<ActionResult<{ bound: true; note: string }>> {
  try {
    await requireFeature(AI_FEATURE);
    const data = bindSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [agent] = await tx
          .select({
            id: agentDefinitions.id,
            name: agentDefinitions.name,
            tools: agentDefinitions.tools,
            sensitivity: agentDefinitions.sensitivity,
          })
          .from(agentDefinitions)
          .where(
            and(
              eq(agentDefinitions.tenantId, ctx.tenant.id),
              eq(agentDefinitions.id, data.agentId),
            ),
          )
          .limit(1);

        if (!agent) throw new Error("No such agent.");

        await tx.insert(agentTriggers).values({
          tenantId: ctx.tenant.id,
          agentId: data.agentId,
          triggerType: data.triggerType,
          recordType: data.recordType,
          dailyCap: data.dailyCap,
          createdBy: ctx.user.id,
        });

        await writeAudit(ctx, {
          action: "create",
          resourceType: "agent_trigger",
          resourceId: data.agentId,
          newValue: {
            triggerType: data.triggerType,
            recordType: data.recordType,
            dailyCap: data.dailyCap,
          },
          severity: "critical",
        });

        return {
          bound: true as const,
          // 🔴 SAID PLAINLY AT THE MOMENT IT IS SWITCHED ON, because this
          // is the one thing people assume works the other way.
          note: `${agent.name} will now run by itself when this happens, at most ${data.dailyCap} times a day. It writes a draft you can read. It cannot send anything, and it cannot change any record.`,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/assistant/agents");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "bindAgentTrigger");
  }
}

/* ------------------------------------------------------------------ */
/* THE CAP                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE DAILY CAP IS COUNTED INSIDE `server/automation/agent-dispatch.ts`
 * AND NOT EXPORTED FROM HERE.
 *
 * ⚠️ IT WAS A HELPER IN THIS FILE UNTIL `check:boundaries` REFUSED IT,
 * and the gate was right twice over. `"use server"` makes every export a
 * browser-reachable endpoint, so a helper taking a `tenantId` argument is
 * an endpoint that lets its caller pick a workspace, which is the one
 * route past row-level security. It also exported a plain constant, which
 * the same gate forbids for the same reason.
 *
 * 🔴 THE POINT WORTH KEEPING: the cap is counted from `agent_runs` rather
 * than from a counter column. A counter has to be reset, and a reset that
 * does not happen is a cap that stops working silently at midnight on the
 * day somebody needed it.
 */

/* ------------------------------------------------------------------ */
/* RUNS                                                                */
/* ------------------------------------------------------------------ */

export interface RunRow {
  readonly id: string;
  readonly agentName: string;
  readonly startedBy: string;
  readonly providerId: string | null;
  readonly output: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
}

export async function getAgentRuns(): Promise<ActionResult<readonly RunRow[]>> {
  try {
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select({
            id: agentRuns.id,
            agentName: agentDefinitions.name,
            startedBy: agentRuns.startedBy,
            providerId: agentRuns.providerId,
            output: agentRuns.output,
            errorMessage: agentRuns.errorMessage,
            startedAt: agentRuns.startedAt,
          })
          .from(agentRuns)
          .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentRuns.agentId))
          .where(eq(agentRuns.tenantId, ctx.tenant.id))
          .orderBy(desc(agentRuns.startedAt))
          .limit(50);

        return {
          ok: true as const,
          data: (rows as Array<Record<string, unknown>>).map((r) => ({
            id: r.id as string,
            agentName: r.agentName as string,
            startedBy: r.startedBy as string,
            providerId: (r.providerId as string | null) ?? null,
            output: (r.output as string | null) ?? null,
            errorMessage: (r.errorMessage as string | null) ?? null,
            startedAt: (r.startedAt as Date).toISOString(),
          })),
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getAgentRuns");
  }
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE WHITELIST IS CHECKED AGAINST THE REAL REGISTRY, not against a
 * copy of its names. The registry header already states the rule: every
 * agent's tool list is a subset of the MCP registry. This is where a
 * tenant typing into a form meets that rule.
 */
function toolExists(name: string): boolean {
  return MCP_TOOLS.some(
    (t: { name?: string; id?: string }) => t.name === name || t.id === name,
  );
}
