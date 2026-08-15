"use server";

/**
 * Ordence — ⭐⭐⭐ MESSAGING
 * Version: v1.14.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN THIS FEEDS ANSWERS THREE QUESTIONS, IN THIS ORDER
 * ══════════════════════════════════════════════════════════════════════
 *   ① What did we spend today, and what did the window save us?
 *   ② Which templates cannot be used, and what should be done?
 *   ③ What did not reach somebody, and why?
 *
 * ⚠️ NOT "how many messages did we send". That number is on every
 * messaging product ever built and it answers nothing anybody asks.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { messageSends, messageTemplates } from "@/db/schema/messaging";
import { requirePermission } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  categoryDrifted,
  mayUseTemplate,
  type MessageCategory,
  type TemplateSnapshot,
} from "@/lib/messaging/window";

const READ = "contacts:read" as const;

export interface SpendToday {
  readonly connectionName: string;
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly spentMinor: string;
  readonly freeWindowSends: number;
  readonly sendCap: number | null;
  readonly spendCapMinor: string | null;
  /** ⭐ How much the open windows saved, at the rate actually charged. */
  readonly savedMinor: string;
}

export interface TemplateCard {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly category: string;
  readonly status: string;
  readonly quality: string | null;
  readonly maySend: boolean;
  readonly reason: string;
  readonly actionRequired: string | null;
  readonly drift: string | null;
}

export interface FailedSend {
  readonly id: string;
  readonly toPhone: string | null;
  readonly subjectType: string | null;
  readonly status: string;
  readonly errorMessage: string | null;
  readonly queuedAt: string;
  readonly renderedBody: string;
}

export async function getMessagingOverview(): Promise<
  ActionResult<{
    readonly spend: readonly SpendToday[];
    readonly templates: readonly TemplateCard[];
    readonly failures: readonly FailedSend[];
    readonly pendingUnknown: number;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const now = new Date();

    const data = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const spendRows = await tx.execute(sql`
          SELECT
            c.name                                                    AS connection_name,
            c.daily_send_cap                                          AS send_cap,
            c.daily_spend_cap_minor                                   AS spend_cap,
            count(s.*) FILTER (WHERE s.status <> 'refused')::int       AS attempted,
            count(s.*) FILTER (WHERE s.delivered_at IS NOT NULL)::int  AS delivered,
            count(s.*) FILTER (WHERE s.status = 'failed')::int         AS failed,
            COALESCE(sum(s.cost_minor), 0)::bigint                     AS spent_minor,
            count(s.*) FILTER (WHERE s.inside_service_window)::int     AS free_window,
            /**
             * ⭐ WHAT THE OPEN WINDOWS SAVED, priced at the rate this
             * connection actually paid rather than at a guess.
             */
            COALESCE(
              count(s.*) FILTER (WHERE s.inside_service_window)
              * NULLIF(max(s.rate_minor), 0), 0)::bigint               AS saved_minor
          FROM connections c
          LEFT JOIN message_sends s
            ON s.connection_id = c.id
           AND s.queued_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
          WHERE c.tenant_id = ${ctx.tenant.id}::uuid
          GROUP BY c.id, c.name, c.daily_send_cap, c.daily_spend_cap_minor
          HAVING count(s.*) > 0 OR c.daily_send_cap IS NOT NULL
          ORDER BY c.name
        `);

        const templateRows = await tx
          .select()
          .from(messageTemplates)
          .where(eq(messageTemplates.tenantId, ctx.tenant.id))
          .orderBy(messageTemplates.name);

        const failureRows = await tx
          .select({
            id: messageSends.id,
            toPhone: messageSends.toPhone,
            subjectType: messageSends.subjectType,
            status: messageSends.status,
            errorMessage: messageSends.errorMessage,
            queuedAt: messageSends.queuedAt,
            renderedBody: messageSends.renderedBody,
          })
          .from(messageSends)
          .where(
            and(
              eq(messageSends.tenantId, ctx.tenant.id),
              sql`${messageSends.status} IN ('failed', 'refused')`,
            ),
          )
          .orderBy(desc(messageSends.queuedAt))
          .limit(50);

        /**
         * 🔴 THE ONES WE GENUINELY DO NOT KNOW ABOUT.
         *
         * ⚠️ A send that timed out is left pending on purpose, because
         * retrying may deliver a second copy of a payment reminder. It
         * is the most uncomfortable number on the screen and it is the
         * honest one.
         */
        const unknown = await tx.execute(sql`
          SELECT count(*)::int AS n
            FROM message_sends
           WHERE tenant_id = ${ctx.tenant.id}::uuid
             AND status IN ('queued', 'sent')
             AND queued_at < now() - interval '1 hour'
        `);

        return {
          spend: rowsOf<Record<string, unknown>>(spendRows).map((r) => ({
            connectionName: String(r.connection_name),
            attempted: Number(r.attempted ?? 0),
            delivered: Number(r.delivered ?? 0),
            failed: Number(r.failed ?? 0),
            spentMinor: String(r.spent_minor ?? "0"),
            freeWindowSends: Number(r.free_window ?? 0),
            sendCap: r.send_cap === null ? null : Number(r.send_cap),
            spendCapMinor: r.spend_cap === null ? null : String(r.spend_cap),
            savedMinor: String(r.saved_minor ?? "0"),
          })),
          templates: templateRows.map((t: Record<string, unknown>) => {
            const snapshot: TemplateSnapshot = {
              name: String(t.name),
              status: t.status as TemplateSnapshot["status"],
              category: t.category as MessageCategory,
              requestedCategory: (t.requestedCategory as MessageCategory) ?? null,
              variableCount: Number(t.variableCount ?? 0),
              pausedUntil: (t.pausedUntil as Date | null) ?? null,
              pauseCount: Number(t.pauseCount ?? 0),
              quality: (t.quality as TemplateSnapshot["quality"]) ?? null,
              rejectionReason: (t.rejectionReason as string | null) ?? null,
            };
            const gate = mayUseTemplate(snapshot, now);
            return {
              id: String(t.id),
              name: snapshot.name,
              language: String(t.language),
              category: snapshot.category,
              status: snapshot.status,
              quality: snapshot.quality,
              maySend: gate.maySend,
              reason: gate.reason,
              actionRequired: gate.actionRequired,
              drift: categoryDrifted(snapshot),
            };
          }),
          failures: failureRows.map((f: Record<string, unknown>) => ({
            id: String(f.id),
            toPhone: f.toPhone ? String(f.toPhone) : null,
            subjectType: f.subjectType ? String(f.subjectType) : null,
            status: String(f.status),
            errorMessage: f.errorMessage ? String(f.errorMessage) : null,
            queuedAt: (f.queuedAt as Date).toISOString(),
            renderedBody: String(f.renderedBody),
          })),
          pendingUnknown: firstRow<{ n: number }>(unknown)?.n ?? 0,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getMessagingOverview");
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
