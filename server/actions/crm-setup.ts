"use server";

/**
 * Ordence — ⭐⭐⭐ LEAD SOURCES AND PIPELINE STAGES
 * Version: v1.21.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A CORRECTION TO BATCH 3, WHICH I REPORTED AS FINISHED IN v1.10.0
 * ══════════════════════════════════════════════════════════════════════
 * `0061` created `lead_sources` and `pipeline_stages` and **no code has
 * ever referenced either table.** There has never been a way to add a
 * source or define a stage.
 *
 * ⚠️ AND IT HAS BEEN QUIETLY BREAKING SOMETHING SINCE v1.13.0. Lead
 * intake carries a `lead_source_id` column pointing at a table nobody
 * can put a row into, so every lead that has ever arrived from
 * IndiaMART, JustDial or Meta carries a null source. "Where do our
 * enquiries come from" is the first question anybody asks of a CRM and
 * it has had no answer.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { leadSources, pipelineStages } from "@/db/schema/front-office";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

const MANAGE = "settings:update" as const;
const READ = "contacts:read" as const;

/* ------------------------------------------------------------------ */
/* SOURCES                                                             */
/* ------------------------------------------------------------------ */

const sourceSchema = z.object({
  name: z.string().min(1).max(160),
  /**
   * ⚠️ REQUIRED BY 0061, AND RIGHTLY. "Where did this lead come from" is
   * two different questions: which channel (a directory, a referral, a
   * walk-in) and which specific account. Collapsing them makes the
   * channel report impossible.
   */
  channel: z.enum([
    "directory",
    "referral",
    "walk_in",
    "website",
    "social",
    "outbound",
    "other",
  ]),
  isPaid: z.boolean().default(false),
  /**
   * ⭐ THE CONNECTOR KEY, WHERE THIS SOURCE IS AN INTEGRATION.
   *
   * ⚠️ This is the field that makes intake able to set a source
   * automatically. Without it every automatic lead is "unknown" and a
   * person has to label it by hand, which nobody does.
   */
  connectorKey: z.string().max(40).optional().nullable(),
  isActive: z.boolean().default(true),
});

export async function createLeadSource(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const data = sourceSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(leadSources)
          .values({
            tenantId: ctx.tenant.id,
            name: data.name,
            channel: data.channel,
            isPaid: data.isPaid,
            connectorKey: data.connectorKey ?? null,
            isActive: data.isActive,
            createdBy: ctx.user.id,
          })
          .returning({ id: leadSources.id });

        if (!row) throw new Error("The source could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "lead_source",
          resourceId: row.id,
          newValue: {
            name: data.name,
            channel: data.channel,
            connectorKey: data.connectorKey ?? null,
          },
          severity: "notice",
        });

        return { id: row.id, name: data.name };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/crm");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "createLeadSource");
  }
}

/* ------------------------------------------------------------------ */
/* STAGES                                                              */
/* ------------------------------------------------------------------ */

const stageSchema = z.object({
  name: z.string().min(1).max(120),
  /** ⚠️ Where it sits in the pipeline. Gaps are fine; order is what matters. */
  position: z.number().int().min(0).max(999),
  /**
   * 🔴 A STAGE THAT ENDS THE PIPELINE HAS TO SAY WHICH WAY IT ENDED.
   *
   * ⚠️ "Closed" as a single stage makes the conversion rate
   * uncomputable, because won and lost land in the same bucket. Every
   * CRM that gets this wrong reports a 100% close rate.
   */
  outcome: z.enum(["open", "won", "lost"]).default("open"),
  /** ⚠️ A lost stage should demand a reason. See below. */
  requiresReason: z.boolean().optional(),
});

export async function createPipelineStage(
  input: unknown,
): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const data = stageSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(pipelineStages)
          .values({
            tenantId: ctx.tenant.id,
            name: data.name,
            position: data.position,
            // 🔴 TWO BOOLEANS, WHICH IS 0061'S SHAPE, AND THE ACTION
            // TRANSLATES RATHER THAN THE SCREEN.
            //
            // ⚠️ Both true is nonsense and is refused here, because a
            // stage that is simultaneously won and lost makes every
            // conversion figure meaningless and nothing downstream would
            // notice.
            isWon: data.outcome === "won",
            isLost: data.outcome === "lost",
            // ⭐ A lost stage demands a reason by default. "Why did we
            // lose it" is the only question that improves a pipeline,
            // and it is never answered unless it is asked at the moment.
            requiresReason: data.requiresReason ?? data.outcome === "lost",
          })
          .returning({ id: pipelineStages.id });

        if (!row) throw new Error("The stage could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "pipeline_stage",
          resourceId: row.id,
          newValue: { name: data.name, position: data.position, outcome: data.outcome },
          severity: "notice",
        });

        return { id: row.id, name: data.name };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/crm");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "createPipelineStage");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export interface CrmSetup {
  readonly sources: ReadonlyArray<{
    id: string;
    name: string;
    connectorKey: string | null;
    isActive: boolean;
    leadCount: number;
  }>;
  readonly stages: ReadonlyArray<{
    id: string;
    name: string;
    position: number;
    outcome: string;
  }>;
  /** ⚠️ The number this whole screen exists to drive to zero. */
  readonly leadsWithNoSource: number;
}

export async function getCrmSetup(): Promise<ActionResult<CrmSetup>> {
  try {
    const ctx = await requirePermission(READ);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const sources = await tx.execute(sql`
          SELECT s.id::text, s.name, s.connector_key, s.is_active,
                 (SELECT count(*) FROM leads l
                   WHERE l.tenant_id = s.tenant_id
                     AND l.lead_source_id = s.id)::int AS lead_count
            FROM lead_sources s
           WHERE s.tenant_id = ${ctx.tenant.id}::uuid
           ORDER BY s.name
        `);

        const stages = await tx
          .select({
            id: pipelineStages.id,
            name: pipelineStages.name,
            position: pipelineStages.position,
            isWon: pipelineStages.isWon,
            isLost: pipelineStages.isLost,
          })
          .from(pipelineStages)
          .where(eq(pipelineStages.tenantId, ctx.tenant.id))
          .orderBy(asc(pipelineStages.position));

        const orphaned = await tx.execute(sql`
          SELECT count(*)::int AS n FROM leads
           WHERE tenant_id = ${ctx.tenant.id}::uuid
             AND lead_source_id IS NULL
        `);

        return {
          ok: true as const,
          data: {
            sources: rowsOf<Record<string, unknown>>(sources).map((r) => ({
              id: String(r.id),
              name: String(r.name),
              connectorKey: (r.connector_key as string | null) ?? null,
              isActive: Boolean(r.is_active),
              leadCount: Number(r.lead_count ?? 0),
            })),
            stages: (stages as Array<Record<string, unknown>>).map((r) => ({
              id: r.id as string,
              name: r.name as string,
              position: r.position as number,
              outcome: r.isWon ? "won" : r.isLost ? "lost" : "open",
            })),
            leadsWithNoSource: Number(
              rowsOf<{ n?: number }>(orphaned)[0]?.n ?? 0,
            ),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getCrmSetup");
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

void and;
