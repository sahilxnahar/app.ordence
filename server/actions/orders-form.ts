"use server";

/**
 * Ordence — Options the order form needs
 * Version: v1.42.0-alpha (Mega-wave 1, Batch 34)
 *
 * ⚠️ SEPARATE FROM `orders.ts` ON PURPOSE. That file is the write path
 * and every export of it is a browser-reachable RPC endpoint. A read
 * helper for a dropdown does not belong beside `cancelOrder`, and mixing
 * them makes the guard audit of that file harder to read.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import { projects } from "@/db/schema/sales";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

export async function listProjectOptions(): Promise<
  ActionResult<{ rows: Array<{ id: string; label: string; hint?: string }> }>
> {
  try {
    const ctx = await requirePermission("sales.orders.read");

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({
          id: projects.id,
          name: projects.name,
          code: projects.code,
          stateCode: projects.stateCode,
        })
        .from(projects)
        .where(and(eq(projects.tenantId, ctx.tenant.id), isNull(projects.deletedAt)))
        .orderBy(asc(projects.name)),
    );

    return {
      ok: true,
      data: {
        rows: rows.map((p) => ({
          id: p.id,
          label: `${p.code} · ${p.name}`,
          /**
           * ⭐ THE STATE CODE IS THE HINT, AND ITS ABSENCE IS THE POINT.
           *
           * 🔴 Under s.12(3) the place of supply for a works contract is
           * the SITE. A project with no `state_code` makes the engine
           * refuse, by design (Batch 33). Showing which projects can
           * answer the question, and which cannot, turns that refusal
           * from a surprise at save time into something visible while
           * choosing.
           */
          hint: p.stateCode ? `GST state ${p.stateCode}` : undefined,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "listProjectOptions");
  }
}
