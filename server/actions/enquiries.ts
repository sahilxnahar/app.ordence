"use server";

/**
 * Ordence — ⭐⭐⭐ ENQUIRIES THAT ARRIVED BY THEMSELVES
 * Version: v1.13.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SCREEN THIS FEEDS IS ABOUT THE ONES THAT DID NOT MAKE IT
 * ══════════════════════════════════════════════════════════════════════
 * The leads that filed cleanly are already in the pipeline, where they
 * belong. What has nowhere else to live is the enquiry that arrived and
 * could not be turned into a lead, and the customer paid for that one
 * exactly as much as the others.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { connections, leadIntakeFailures } from "@/db/schema/integrations";
import { leads } from "@/db/schema/sales";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import { policyFor } from "@/lib/integrations/policy";

const READ = "contacts:read" as const;
const WRITE = "contacts:update" as const;

export interface IntakeFailureRow {
  readonly id: string;
  readonly connectorLabel: string;
  readonly connectionName: string;
  readonly externalId: string | null;
  readonly occurredAt: string;
  readonly reason: string;
  readonly reasonCode: string;
  /** ⭐ What a person should actually do about it. */
  readonly whatToDo: string;
}

/**
 * ⚠️ EACH REASON GETS AN INSTRUCTION, NOT A CATEGORY.
 *
 * 🔴 "no_contact_details" on a screen is a code. "The buyer did not
 * leave a number, so open the IndiaMART panel and look" is something
 * somebody can do before lunch.
 */
const WHAT_TO_DO: Readonly<Record<string, string>> = Object.freeze({
  no_contact_details:
    "The buyer left no number and no email address. Open the provider's own panel: they often show a contact there that is not sent to us.",
  unknown_shape:
    "This arrived without the provider's own reference number, so filing it would create a fresh copy every time they resend. File it by hand from their panel.",
  unparseable:
    "This did not arrive in a shape we recognise. If it keeps happening, the provider may have changed their format and we should be told.",
  lead_fetch_failed:
    "The provider told us an enquiry exists but would not give us the answers. The usual cause is an expired access token. The reference below will find it in their own leads centre.",
  rejected_by_rules:
    "This was refused by a rule you set. Change the rule if that was not what you meant.",
  internal_error:
    "Something went wrong at our end. The enquiry is stored and can be filed by hand; please tell us the reference.",
});

export async function getEnquiryIntake(): Promise<
  ActionResult<{
    readonly failures: readonly IntakeFailureRow[];
    readonly openFailureCount: number;
    readonly arrivedToday: number;
    readonly arrivedThisWeek: number;
    readonly lastArrivalAt: string | null;
    readonly quietConnections: readonly string[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select({
            id: leadIntakeFailures.id,
            externalId: leadIntakeFailures.externalId,
            occurredAt: leadIntakeFailures.occurredAt,
            reason: leadIntakeFailures.reason,
            reasonCode: leadIntakeFailures.reasonCode,
            connectorKey: connections.connectorKey,
            connectionName: connections.name,
          })
          .from(leadIntakeFailures)
          .innerJoin(
            connections,
            eq(connections.id, leadIntakeFailures.connectionId),
          )
          .where(
            and(
              eq(leadIntakeFailures.tenantId, ctx.tenant.id),
              isNull(leadIntakeFailures.resolvedAt),
            ),
          )
          .orderBy(desc(leadIntakeFailures.occurredAt))
          .limit(100);

        const counts = await tx.execute(sql`
          SELECT
            count(*) FILTER (
              WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
            )::int AS today,
            count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week,
            max(created_at) AS last_at
          FROM leads
          WHERE tenant_id = ${ctx.tenant.id}::uuid
            AND connection_id IS NOT NULL
        `);
        const c = firstRow<{ today: number; week: number; last_at: string | null }>(counts);

        /**
         * ⭐⭐ A CONNECTION THAT IS "WORKING" AND HAS BROUGHT NOTHING
         * FOR A WEEK.
         *
         * 🔴 Nothing else reports this. Every run succeeded, the state
         * says connected, and the customer's enquiries have been going
         * somewhere else the whole time — usually because a filter or a
         * subscription changed at the provider's end.
         */
        const quiet = await tx.execute(sql`
          SELECT c.name
            FROM connections c
           WHERE c.tenant_id = ${ctx.tenant.id}::uuid
             AND c.is_active
             AND c.state = 'connected'
             AND NOT EXISTS (
                   SELECT 1 FROM leads l
                    WHERE l.connection_id = c.id
                      AND l.created_at >= now() - interval '7 days')
           ORDER BY c.name
           LIMIT 10
        `);

        return {
          failures: rows.map((r: Record<string, unknown>) => ({
            id: String(r.id),
            connectorLabel:
              policyFor(String(r.connectorKey))?.label ?? String(r.connectorKey),
            connectionName: String(r.connectionName),
            externalId: r.externalId ? String(r.externalId) : null,
            occurredAt: (r.occurredAt as Date).toISOString(),
            reason: String(r.reason),
            reasonCode: String(r.reasonCode),
            whatToDo:
              WHAT_TO_DO[String(r.reasonCode)] ??
              "Open the provider's own panel and file this enquiry by hand.",
          })),
          openFailureCount: rows.length,
          arrivedToday: c?.today ?? 0,
          arrivedThisWeek: c?.week ?? 0,
          lastArrivalAt: c?.last_at ? new Date(c.last_at).toISOString() : null,
          quietConnections: rowsOf<{ name: string }>(quiet).map((q) => q.name),
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getEnquiryIntake");
  }
}

/* ------------------------------------------------------------------ */
/* CLEARING ONE                                                        */
/* ------------------------------------------------------------------ */

const resolveSchema = z.object({
  failureId: z.string().uuid(),
  note: z.string().min(3).max(500),
  /** Where somebody filed it by hand after all. */
  leadId: z.string().uuid().optional().nullable(),
});

/**
 * ⚠️ A FAILURE LIST THAT CANNOT BE CLEARED IS A LIST NOBODY OPENS TWICE.
 *
 * 🔴 And 0065 refuses to let a resolved one be reopened, because a lost
 * enquiry counted twice in whatever report reads this is worse than not
 * counting it at all.
 */
export async function resolveIntakeFailure(
  input: unknown,
): Promise<ActionResult<{ resolved: true }>> {
  try {
    const data = resolveSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(leadIntakeFailures)
          .set({
            resolvedAt: new Date(),
            resolvedBy: ctx.user.id,
            resolvedNote: data.note,
            resolvedLeadId: data.leadId ?? null,
          })
          .where(
            and(
              eq(leadIntakeFailures.tenantId, ctx.tenant.id),
              eq(leadIntakeFailures.id, data.failureId),
              isNull(leadIntakeFailures.resolvedAt),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "lead_intake_failure",
          resourceId: data.failureId,
          newValue: { note: data.note, leadId: data.leadId ?? null },
          severity: "notice",
        });
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/enquiries");
    return { ok: true, data: { resolved: true } };
  } catch (err) {
    return toSalesActionError(err, "resolveIntakeFailure");
  }
}

/* ------------------------------------------------------------------ */
/* WHAT ARRIVED                                                        */
/* ------------------------------------------------------------------ */

export interface ArrivedLead {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly phone: string | null;
  readonly interestLabel: string | null;
  readonly connectorLabel: string;
  readonly createdAt: string;
}

export async function getArrivedLeads(): Promise<ActionResult<readonly ArrivedLead[]>> {
  try {
    const ctx = await requirePermission(READ);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: leads.id,
            reference: leads.reference,
            name: leads.name,
            phone: leads.phone,
            interestLabel: leads.interestLabel,
            createdAt: leads.createdAt,
            connectorKey: connections.connectorKey,
          })
          .from(leads)
          .innerJoin(connections, eq(connections.id, leads.connectionId))
          .where(eq(leads.tenantId, ctx.tenant.id))
          .orderBy(desc(leads.createdAt))
          .limit(50),
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        reference: String(r.reference),
        name: String(r.name),
        phone: r.phone ? String(r.phone) : null,
        interestLabel: r.interestLabel ? String(r.interestLabel) : null,
        connectorLabel:
          policyFor(String(r.connectorKey))?.label ?? String(r.connectorKey),
        createdAt: (r.createdAt as Date).toISOString(),
      })),
    };
  } catch (err) {
    return toSalesActionError(err, "getArrivedLeads");
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
