"use server";

/**
 * Ordence — ⭐⭐ THE AUTOMATION QUEUE, REACHABLE
 * Version: v1.19.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * 🔴 THE DRAIN EXISTS AS AN ACTION SO THERE IS A DOOR, not because a
 * person should be pressing it every few minutes. The intended caller is
 * a scheduled job; the button is what makes the queue inspectable on the
 * morning somebody asks why a workflow did not run.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { automationEvents } from "@/db/schema/patterns";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { drainAutomationEvents, purgeExpiredEvents } from "@/server/automation/drain";
import type { ActionResult } from "@/lib/validators/crm";

const MANAGE = "settings:update" as const;

export async function runAutomationQueue(): Promise<
  ActionResult<{ considered: number; runsStarted: number; note: string }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    const report = await drainAutomationEvents({
      tenantId: ctx.tenant.id,
      now: new Date(),
      actor: { userId: ctx.user.id, role: ctx.user.role ?? "member" },
    });
    revalidatePath("/automations");
    return {
      ok: true,
      data: {
        considered: report.considered,
        runsStarted: report.runsStarted,
        note: report.note,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "runAutomationQueue");
  }
}

export async function purgeAutomationEvents(): Promise<ActionResult<{ removed: number }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const removed = await purgeExpiredEvents({
      tenantId: ctx.tenant.id,
      today: new Date().toISOString().slice(0, 10),
    });
    revalidatePath("/automations");
    return { ok: true, data: { removed } };
  } catch (err) {
    return toSalesActionError(err, "purgeAutomationEvents");
  }
}

export interface QueueRow {
  readonly id: string;
  readonly triggerType: string;
  readonly recordType: string;
  readonly occurredAt: string;
  readonly processedAt: string | null;
  readonly runsStarted: number;
  readonly errorMessage: string | null;
}

export async function getAutomationQueue(): Promise<
  ActionResult<{ pending: number; recent: readonly QueueRow[] }>
> {
  try {
    const ctx = await requirePermission(MANAGE);

    return await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const pendingRows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(automationEvents)
          .where(
            and(
              eq(automationEvents.tenantId, ctx.tenant.id),
              isNull(automationEvents.processedAt),
            ),
          );

        const recent = await tx
          .select({
            id: automationEvents.id,
            triggerType: automationEvents.triggerType,
            recordType: automationEvents.recordType,
            occurredAt: automationEvents.occurredAt,
            processedAt: automationEvents.processedAt,
            runsStarted: automationEvents.runsStarted,
            errorMessage: automationEvents.errorMessage,
          })
          .from(automationEvents)
          .where(eq(automationEvents.tenantId, ctx.tenant.id))
          .orderBy(desc(automationEvents.occurredAt))
          .limit(50);

        return {
          ok: true as const,
          data: {
            pending: Number(
              (pendingRows as Array<{ n: number }>)[0]?.n ?? 0,
            ),
            recent: (recent as Array<Record<string, unknown>>).map((r) => ({
              id: r.id as string,
              triggerType: r.triggerType as string,
              recordType: r.recordType as string,
              occurredAt: (r.occurredAt as Date).toISOString(),
              processedAt: (r.processedAt as Date | null)?.toISOString() ?? null,
              runsStarted: r.runsStarted as number,
              errorMessage: (r.errorMessage as string | null) ?? null,
            })),
          },
        };
      },
      { impersonationId: ctx.impersonationId },
    );
  } catch (err) {
    return toSalesActionError(err, "getAutomationQueue");
  }
}
