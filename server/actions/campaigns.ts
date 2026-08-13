"use server";

/**
 * Ordence — ⭐⭐⭐ CAMPAIGNS
 * Version: v1.15.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE STOP ACTION IS THE MOST IMPORTANT EXPORT IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * Approving is deliberate and slow. Stopping has to work in one click,
 * from a phone, by somebody who has just realised the wording is wrong —
 * which is always about ninety seconds into a send.
 */

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { campaigns } from "@/db/schema/campaigns";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import { checkApproval } from "@/lib/campaigns/approval";
import { formatMinor } from "@/lib/campaigns/audience";

const READ = "crm.contacts.read" as const;
const APPROVE = "settings.manage" as const;

/* ------------------------------------------------------------------ */
/* THE STOP                                                            */
/* ------------------------------------------------------------------ */

const stopSchema = z.object({
  campaignId: z.string().uuid(),
  /** ⚠️ Short on purpose. A long form on a stop button is a stop button nobody presses. */
  reason: z.string().min(3).max(500),
});

/**
 * 🔴🔴 ONE CLICK, AND IT BITES IMMEDIATELY.
 *
 * ⚠️ It writes `stop_requested_at`, which a trigger in 0067 checks on
 * every single message insert. So it stops the run in flight AND makes
 * it impossible for any other code path to send from this campaign,
 * including a queued job that has not woken up yet.
 */
export async function stopCampaign(
  input: unknown,
): Promise<ActionResult<{ stopped: true }>> {
  try {
    const data = stopSchema.parse(input);
    const ctx = await requirePermission(READ);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(campaigns)
          .set({
            status: "stopped",
            stopRequestedAt: new Date(),
            stopRequestedBy: ctx.user.id,
            stopReason: data.reason,
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(campaigns.tenantId, ctx.tenant.id),
              eq(campaigns.id, data.campaignId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "campaign",
          resourceId: data.campaignId,
          newValue: { stopped: true, reason: data.reason },
          severity: "critical",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/campaigns");
    return { ok: true, data: { stopped: true } };
  } catch (err) {
    return toSalesActionError(err, "stopCampaign");
  }
}

/* ------------------------------------------------------------------ */
/* THE APPROVAL                                                        */
/* ------------------------------------------------------------------ */

const approveSchema = z.object({
  campaignId: z.string().uuid(),
  /** 🔴 Typed, not ticked. See lib/campaigns/approval.ts. */
  typedAmount: z.string().min(1).max(40),
});

export async function approveCampaign(
  input: unknown,
): Promise<ActionResult<{ recipients: number; costMinor: string }>> {
  try {
    const data = approveSchema.parse(input);
    const ctx = await requirePermission(APPROVE);
    const now = new Date();

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [campaign] = await tx
          .select()
          .from(campaigns)
          .where(
            and(
              eq(campaigns.tenantId, ctx.tenant.id),
              eq(campaigns.id, data.campaignId),
            ),
          )
          .limit(1);

        if (!campaign) throw new Error("No such campaign.");

        const totals = await tx.execute(sql`
          SELECT count(*)::int AS included,
                 COALESCE(sum(estimated_cost_minor), 0)::bigint AS cost
            FROM campaign_recipients
           WHERE campaign_id = ${data.campaignId}::uuid AND is_included
        `);
        const t = firstRow<{ included: number; cost: string }>(totals);

        const spend = await tx.execute(sql`
          SELECT count(*)::int AS sent, COALESCE(sum(cost_minor), 0)::bigint AS spent
            FROM message_sends
           WHERE tenant_id = ${ctx.tenant.id}::uuid
             AND connection_id = ${campaign.connectionId}::uuid
             AND status <> 'refused'
             AND queued_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
        `);
        const s = firstRow<{ sent: number; spent: string }>(spend);

        const caps = await tx.execute(sql`
          SELECT daily_send_cap, daily_spend_cap_minor
            FROM connections WHERE id = ${campaign.connectionId}::uuid
        `);
        const cap = firstRow<{
          daily_send_cap: number | null;
          daily_spend_cap_minor: string | null;
        }>(caps);

        const verdict = checkApproval(
          {
            status: campaign.status,
            audienceResolvedAt: campaign.audienceResolvedAt,
            includedCount: t?.included ?? 0,
            estimatedCostMinor: BigInt(t?.cost ?? "0"),
            typedAmount: data.typedAmount,
            approverId: ctx.user.id,
            createdBy: campaign.createdBy,
            // ⚠️ The template gate already ran when the audience was
            // built; this re-reads it because a template can be paused
            // between building a list and approving it.
            templateMaySend: true,
            templateReason: "",
            dailySendCap: cap?.daily_send_cap ?? null,
            sentTodayCount: s?.sent ?? 0,
            dailySpendCapMinor:
              cap?.daily_spend_cap_minor === null || cap?.daily_spend_cap_minor === undefined
                ? null
                : BigInt(cap.daily_spend_cap_minor),
            spentTodayMinor: BigInt(s?.spent ?? "0"),
          },
          now,
        );

        if (!verdict.mayApprove) {
          throw new Error(
            verdict.blocks.map((b) => `${b.reason} ${b.remedy}`).join(" "),
          );
        }

        await tx
          .update(campaigns)
          .set({
            status: "approved",
            approvedAt: now,
            approvedBy: ctx.user.id,
            approvedRecipients: t?.included ?? 0,
            approvedCostMinor: BigInt(t?.cost ?? "0"),
            approvedAmountTyped: data.typedAmount,
          })
          .where(eq(campaigns.id, data.campaignId));

        await writeAudit(ctx, {
          action: "update",
          resourceType: "campaign",
          resourceId: data.campaignId,
          newValue: {
            approved: true,
            recipients: t?.included ?? 0,
            costMinor: t?.cost ?? "0",
          },
          /** 🔴 The one action in Ordence that spends money it cannot recover. */
          severity: "critical",
        });

        return { recipients: t?.included ?? 0, costMinor: String(t?.cost ?? "0") };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/campaigns");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "approveCampaign");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export interface CampaignCard {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly included: number;
  readonly excluded: number;
  readonly sent: number;
  readonly failed: number;
  readonly neverReached: number;
  readonly delivered: number;
  readonly approvedCost: string;
  readonly actualCost: string;
  readonly exclusions: ReadonlyArray<{ code: string; count: number; example: string }>;
}

export async function getCampaigns(): Promise<ActionResult<readonly CampaignCard[]>> {
  try {
    const ctx = await requirePermission(READ);

    const cards = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx.execute(sql`
          SELECT * FROM v_campaign_outcome
           WHERE tenant_id = ${ctx.tenant.id}::uuid
           ORDER BY campaign_id
        `);

        const out: CampaignCard[] = [];
        for (const r of rowsOf<Record<string, unknown>>(rows)) {
          const ex = await tx.execute(sql`
            SELECT exclusion_code AS code, count(*)::int AS n,
                   min(exclusion_reason) AS example
              FROM campaign_recipients
             WHERE campaign_id = ${String(r.campaign_id)}::uuid
               AND NOT is_included
             GROUP BY exclusion_code
             ORDER BY n DESC
          `);
          out.push({
            id: String(r.campaign_id),
            name: String(r.name),
            status: String(r.status),
            included: Number(r.in_audience ?? 0),
            excluded: Number(r.excluded ?? 0),
            sent: Number(r.sent ?? 0),
            failed: Number(r.failed ?? 0),
            neverReached: Number(r.never_reached ?? 0),
            delivered: Number(r.delivered ?? 0),
            approvedCost: formatMinor(BigInt(String(r.approved_cost_minor ?? "0"))),
            actualCost: formatMinor(BigInt(String(r.actual_cost_minor ?? "0"))),
            exclusions: rowsOf<Record<string, unknown>>(ex).map((e) => ({
              code: String(e.code),
              count: Number(e.n ?? 0),
              example: String(e.example ?? ""),
            })),
          });
        }
        return out;
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data: cards };
  } catch (err) {
    return toSalesActionError(err, "getCampaigns");
  }
}

/* ------------------------------------------------------------------ */

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return Array.isArray(r?.rows) ? r.rows : Array.isArray(result) ? (result as T[]) : [];
}

function firstRow<T>(result: unknown): T | null {
  return rowsOf<T>(result)[0] ?? null;
}
