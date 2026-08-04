"use server";

/**
 * Ordence — Lead & Pipeline Actions
 * Version: v0.22.0-alpha
 *
 * ⚠️ EVERY EXPORT IN THIS FILE IS AN ASYNC FUNCTION. A `"use server"`
 * file may export nothing else — anything else is compiled into a public
 * RPC endpoint. Schemas live in `lib/validators/sales.ts`; decision logic
 * lives in `lib/sales/pipeline.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE IDOR DEFENCE, RESTATED BECAUSE IT IS THE WHOLE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * `tenantId` is NEVER a parameter. It comes from the Clerk session via
 * `requireTenantContext()`. Every query runs inside `withTenant()`, which
 * opens a transaction and sets `app.current_tenant_id` transaction-locally
 * so row-level security applies.
 *
 * The explicit `eq(table.tenantId, ctx.tenant.id)` predicates below are
 * therefore REDUNDANT with RLS — deliberately. If a policy is ever
 * dropped by a `drizzle-kit push` (which removes them, measured: 25
 * tables to 0), the application still refuses. Defence in depth means
 * both, not either.
 */

import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import { leads, leadActivities, bookings, channelPartners } from "@/db/schema";
import { requirePermission, writeAudit } from "@/server/audit";
import { checkFeature } from "@/server/entitlements";
import { guardSalesWrite, salesFail, toSalesActionError } from "@/server/sales/guards";
import { withGeneratedReference } from "@/server/sales/references";
import {
  createLeadSchema,
  updateLeadSchema,
  transitionLeadSchema,
  logActivitySchema,
  leadFilterSchema,
} from "@/lib/validators/sales";
import { toMinorUnits } from "@/lib/validators/accounting";
import {
  canTransition,
  scoreLead,
  followUpUrgency,
  BOARD_COLUMN_LIMIT,
} from "@/lib/sales/pipeline";
import { canAttribute, resolveCpLockDays, cpLockExpiry } from "@/lib/sales/commission";
import type { ActionResult } from "@/lib/validators/crm";
import type { Lead, LeadStatus } from "@/db/schema/sales";

/* ------------------------------------------------------------------ */
/* READ                                                               */
/* ------------------------------------------------------------------ */

export type LeadRow = Lead & {
  partnerFirmName: string | null;
  activityCount: number;
  urgency: ReturnType<typeof followUpUrgency>;
};

export async function listLeads(
  input: unknown = {},
): Promise<ActionResult<{ rows: LeadRow[]; total: number; page: number; pageSize: number }>> {
  try {
    // ⚠️ READS ARE PERMISSION-GATED ONLY.
    //
    // No entitlement gate, and that is not an oversight. A workspace that
    // has lapsed to a lower tier must still be able to SEE the leads it
    // created — locking a customer out of their own data to encourage an
    // upgrade is hostage-taking, not product design. The gates sit on the
    // writes.
    const ctx = await requirePermission("leads:read");
    const filter = leadFilterSchema.parse(input ?? {});
    const now = new Date();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const conditions = [eq(leads.tenantId, ctx.tenant.id), isNull(leads.deletedAt)];

      if (filter.status?.length) conditions.push(inArray(leads.status, filter.status));
      if (filter.temperature?.length) {
        conditions.push(inArray(leads.temperature, filter.temperature));
      }
      if (filter.ownerId) conditions.push(eq(leads.ownerId, filter.ownerId));
      if (filter.projectId) conditions.push(eq(leads.projectId, filter.projectId));
      if (filter.channelPartnerId) {
        conditions.push(eq(leads.channelPartnerId, filter.channelPartnerId));
      }
      if (filter.isNri !== undefined) conditions.push(eq(leads.isNri, filter.isNri));
      if (filter.minScore !== undefined) conditions.push(gte(leads.score, filter.minScore));
      if (filter.overdueOnly) {
        conditions.push(sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} < now()`);
      }
      if (filter.search) {
        // Parameterised by Drizzle. The `%` wrapping is the only string
        // concatenation, and it happens outside the SQL.
        const term = `%${filter.search}%`;
        const clause = or(
          ilike(leads.name, term),
          ilike(leads.email, term),
          ilike(leads.phone, term),
          ilike(leads.reference, term),
          ilike(leads.locality, term),
        );
        if (clause) conditions.push(clause);
      }

      const where = and(...conditions);

      // ⚠️ A FIXED MAP, NOT A DYNAMIC COLUMN NAME.
      //
      // `sortBy` arrives from a saved view, which is stored and replayed.
      // Interpolating it would be an ORDER BY injection with a pleasant
      // UI on top. The Zod enum already narrows it; this is the second
      // layer.
      const sortColumn = {
        created_at: leads.createdAt,
        updated_at: leads.updatedAt,
        score: leads.score,
        next_follow_up_at: leads.nextFollowUpAt,
        name: leads.name,
      }[filter.sortBy];

      const orderBy = filter.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);
      const offset = (filter.page - 1) * filter.pageSize;

      const rows = await tx
        .select({
          lead: leads,
          partnerFirmName: channelPartners.firmName,
          activityCount: sql<number>`(
            SELECT count(*)::int FROM lead_activities la WHERE la.lead_id = ${leads.id}
          )`,
        })
        .from(leads)
        // ⚠️ The join predicate carries the tenant too. A join is a second
        // read path, and a join without it is how a cross-tenant firm name
        // appears next to your own lead.
        .leftJoin(
          channelPartners,
          and(
            eq(channelPartners.id, leads.channelPartnerId),
            eq(channelPartners.tenantId, ctx.tenant.id),
          ),
        )
        .where(where)
        .orderBy(orderBy)
        .limit(filter.pageSize)
        .offset(offset);

      const [totals] = await tx.select({ value: count() }).from(leads).where(where);

      return {
        rows: rows.map((row) => ({
          ...row.lead,
          partnerFirmName: row.partnerFirmName ?? null,
          activityCount: Number(row.activityCount ?? 0),
          urgency: followUpUrgency(row.lead.nextFollowUpAt, now),
        })),
        total: Number(totals?.value ?? 0),
      };
    });

    return {
      ok: true,
      data: { ...result, page: filter.page, pageSize: filter.pageSize },
    };
  } catch (err) {
    return toSalesActionError(err, "listLeads");
  }
}

/**
 * The Kanban board: leads grouped by pipeline stage.
 *
 * ⚠️ CAPPED PER COLUMN, and the cap is reported rather than silently
 * applied. A board that loads 4,000 leads renders for nobody, and a board
 * that quietly shows the first 50 of 900 is worse — the rep concludes
 * those are all the leads there are.
 */
export type BoardColumn = {
  status: LeadStatus;
  total: number;
  shown: number;
  truncated: boolean;
  leads: LeadRow[];
};

export async function getPipelineBoard(
  input: unknown = {},
): Promise<ActionResult<{ columns: BoardColumn[] }>> {
  try {
    const ctx = await requirePermission("leads:read");
    const filter = leadFilterSchema.parse(input ?? {});
    const now = new Date();

    const columns = await withTenant(ctx.tenant.id, async (tx) => {
      const base = [eq(leads.tenantId, ctx.tenant.id), isNull(leads.deletedAt)];
      if (filter.ownerId) base.push(eq(leads.ownerId, filter.ownerId));
      if (filter.projectId) base.push(eq(leads.projectId, filter.projectId));
      if (filter.temperature?.length) {
        base.push(inArray(leads.temperature, filter.temperature));
      }

      const stages: LeadStatus[] = [
        "new",
        "contacted",
        "qualified",
        "site_visit",
        "negotiation",
        "booked",
      ];

      const built: BoardColumn[] = [];

      for (const stage of stages) {
        const where = and(...base, eq(leads.status, stage));

        const [totals] = await tx.select({ value: count() }).from(leads).where(where);
        const rows = await tx
          .select()
          .from(leads)
          .where(where)
          .orderBy(desc(leads.score), desc(leads.updatedAt))
          .limit(BOARD_COLUMN_LIMIT);

        const total = Number(totals?.value ?? 0);
        built.push({
          status: stage,
          total,
          shown: rows.length,
          truncated: total > rows.length,
          leads: rows.map((lead) => ({
            ...lead,
            partnerFirmName: null,
            activityCount: 0,
            urgency: followUpUrgency(lead.nextFollowUpAt, now),
          })),
        });
      }

      return built;
    });

    return { ok: true, data: { columns } };
  } catch (err) {
    return toSalesActionError(err, "getPipelineBoard");
  }
}

export async function getLead(input: { id: string }): Promise<
  ActionResult<{ lead: Lead; activities: (typeof leadActivities.$inferSelect)[] }>
> {
  try {
    const ctx = await requirePermission("leads:read");

    const found = await withTenant(ctx.tenant.id, async (tx) => {
      const [lead] = await tx
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.id, input.id),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!lead) return null;

      const activities = await tx
        .select()
        .from(leadActivities)
        .where(
          and(
            eq(leadActivities.leadId, lead.id),
            eq(leadActivities.tenantId, ctx.tenant.id),
          ),
        )
        .orderBy(desc(leadActivities.occurredAt))
        .limit(200);

      return { lead, activities };
    });

    if (!found) return salesFail("That lead does not exist, or you cannot see it.");
    return { ok: true, data: found };
  } catch (err) {
    return toSalesActionError(err, "getLead");
  }
}

/* ------------------------------------------------------------------ */
/* WRITE                                                              */
/* ------------------------------------------------------------------ */

export async function createLead(input: unknown): Promise<ActionResult<{ id: string; reference: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "leads:create",
      feature: "sales.pipeline",
      permission: "leads:create",
    });

    const data = createLeadSchema.parse(input);

    if (!data.email?.trim() && !data.phone?.trim()) {
      return salesFail(
        "Add a phone number or an email address — a lead you cannot reach is not a lead.",
        { phone: ["Add a phone number or an email address."] },
      );
    }

    // The channel-partner protection window is set AT REGISTRATION, not
    // later. A lead attributed to a broker with no window recorded is a
    // commission argument with no evidence on either side.
    const now = new Date();
    const cpLockedUntil = data.channelPartnerId
      ? cpLockExpiry(now, resolveCpLockDays(null))
      : null;

    const score = scoreLead({
      source: data.source,
      status: "new",
      temperature: data.temperature,
      phone: data.phone,
      email: data.email,
      budgetMinMinor: data.budgetMin ? toMinorUnits(data.budgetMin) : null,
      budgetMaxMinor: data.budgetMax ? toMinorUnits(data.budgetMax) : null,
      projectId: data.projectId,
      consentAt: data.consentSource ? now : null,
    });

    const created = await withTenant(ctx.tenant.id, async (tx) =>
      withGeneratedReference(tx, "lead", async (reference) => {
        const [row] = await tx
          .insert(leads)
          .values({
            tenantId: ctx.tenant.id,
            reference,
            name: data.name,
            email: data.email ?? null,
            phone: data.phone ?? null,
            preferredLang: data.preferredLang ?? "en",
            source: data.source,
            status: "new",
            temperature: data.temperature,
            score,
            budgetMinMinor: data.budgetMin ? toMinorUnits(data.budgetMin) : null,
            budgetMaxMinor: data.budgetMax ? toMinorUnits(data.budgetMax) : null,
            requirement: data.requirement ?? null,
            projectId: data.projectId ?? null,
            ownerId: data.ownerId ?? ctx.user.id,
            isNri: data.isNri,
            country: data.country ?? null,
            timezone: data.timezone ?? null,
            locality: data.locality ?? null,
            latitude: data.latitude ?? null,
            longitude: data.longitude ?? null,
            consentAt: data.consentSource ? now : null,
            consentSource: data.consentSource ?? null,
            channelPartnerId: data.channelPartnerId ?? null,
            cpLockedUntil,
            customFields: data.customFields ?? {},
          })
          .returning({ id: leads.id, reference: leads.reference });

        if (!row) throw new Error("Insert returned no row.");

        // The first entry in the lead's history. Append-only, so this is
        // the permanent record of where the lead came from.
        await tx.insert(leadActivities).values({
          tenantId: ctx.tenant.id,
          leadId: row.id,
          userId: ctx.user.id,
          type: "note",
          subject: "Lead created",
          notes: `Source: ${data.source}.`,
          occurredAt: now,
        });

        return row;
      }),
    );

    await writeAudit(ctx, {
      action: "create",
      resourceType: "lead",
      resourceId: created.id,
      newValue: { reference: created.reference, name: data.name, source: data.source },
      metadata: { channelPartnerId: data.channelPartnerId ?? null },
    });

    revalidatePath("/sales/leads");
    return { ok: true, data: created };
  } catch (err) {
    return toSalesActionError(err, "createLead");
  }
}

export async function updateLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "leads:update",
      feature: "sales.pipeline",
      permission: "leads:update",
    });

    const data = updateLeadSchema.parse(input);
    const now = new Date();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.id, data.id),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) return { kind: "not_found" as const };

      // ⭐ The commission-protection window, checked BEFORE the write so
      // the person gets an explanation rather than a trigger message.
      // The trigger `leads_cp_lock` is what actually enforces it.
      if (data.channelPartnerId !== undefined) {
        const verdict = canAttribute({
          currentPartnerId: existing.channelPartnerId,
          cpLockedUntil: existing.cpLockedUntil,
          incomingPartnerId: data.channelPartnerId ?? null,
          now,
        });
        if (!verdict.allowed) {
          return { kind: "blocked" as const, message: `${verdict.reason} ${verdict.remedy}` };
        }
      }

      const nextScore = scoreLead({
        source: data.source ?? existing.source,
        status: existing.status,
        temperature: data.temperature ?? existing.temperature,
        phone: data.phone ?? existing.phone,
        email: data.email ?? existing.email,
        budgetMinMinor: data.budgetMin
          ? toMinorUnits(data.budgetMin)
          : existing.budgetMinMinor,
        budgetMaxMinor: data.budgetMax
          ? toMinorUnits(data.budgetMax)
          : existing.budgetMaxMinor,
        projectId: data.projectId ?? existing.projectId,
        consentAt: existing.consentAt,
      });

      await tx
        .update(leads)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.phone !== undefined ? { phone: data.phone } : {}),
          ...(data.preferredLang !== undefined ? { preferredLang: data.preferredLang } : {}),
          ...(data.source !== undefined ? { source: data.source } : {}),
          ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
          ...(data.requirement !== undefined ? { requirement: data.requirement } : {}),
          ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
          ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
          ...(data.isNri !== undefined ? { isNri: data.isNri } : {}),
          ...(data.country !== undefined ? { country: data.country } : {}),
          ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
          ...(data.locality !== undefined ? { locality: data.locality } : {}),
          ...(data.latitude !== undefined ? { latitude: data.latitude } : {}),
          ...(data.longitude !== undefined ? { longitude: data.longitude } : {}),
          ...(data.budgetMin !== undefined
            ? { budgetMinMinor: data.budgetMin ? toMinorUnits(data.budgetMin) : null }
            : {}),
          ...(data.budgetMax !== undefined
            ? { budgetMaxMinor: data.budgetMax ? toMinorUnits(data.budgetMax) : null }
            : {}),
          ...(data.consentSource !== undefined
            ? {
                consentSource: data.consentSource,
                consentAt: data.consentSource ? (existing.consentAt ?? now) : null,
              }
            : {}),
          ...(data.channelPartnerId !== undefined
            ? {
                channelPartnerId: data.channelPartnerId,
                cpLockedUntil: data.channelPartnerId
                  ? cpLockExpiry(now, resolveCpLockDays(null))
                  : null,
              }
            : {}),
          score: nextScore,
          updatedAt: now,
        })
        .where(and(eq(leads.id, data.id), eq(leads.tenantId, ctx.tenant.id)));

      return { kind: "ok" as const, existing };
    });

    if (result.kind === "not_found") {
      return salesFail("That lead does not exist, or you cannot see it.");
    }
    if (result.kind === "blocked") return salesFail(result.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "lead",
      resourceId: data.id,
      newValue: { ...data } as Record<string, unknown>,
    });

    revalidatePath("/sales/leads");
    return { ok: true, data: { id: data.id } };
  } catch (err) {
    return toSalesActionError(err, "updateLead");
  }
}

/**
 * Move a lead through the pipeline.
 *
 * ⚠️ THE TRANSITION IS ALSO RECORDED AS AN ACTIVITY, IN THE SAME
 * TRANSACTION.
 *
 * A status column tells you where a lead is. It does not tell you when it
 * got there or who moved it, and that is exactly what is asked six weeks
 * later when a deal is disputed. `lead_activities` is append-only, so the
 * trail cannot be tidied afterwards.
 */
export async function transitionLead(input: unknown): Promise<ActionResult<{ id: string; status: LeadStatus }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "leads:update",
      feature: "sales.pipeline",
      permission: "leads:update",
    });

    const data = transitionLeadSchema.parse(input);
    const now = new Date();

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const [existing] = await tx
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.id, data.id),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!existing) return { kind: "not_found" as const };

      const [live] = await tx
        .select({ value: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.leadId, existing.id),
            eq(bookings.tenantId, ctx.tenant.id),
            sql`${bookings.status} <> 'cancelled'`,
          ),
        );

      const hasLiveBooking = Number(live?.value ?? 0) > 0;

      const verdict = canTransition({
        from: existing.status,
        to: data.status,
        hasLiveBooking,
        lostReason: data.lostReason,
      });

      if (!verdict.allowed) {
        return { kind: "blocked" as const, message: `${verdict.reason} ${verdict.remedy}` };
      }

      await tx
        .update(leads)
        .set({
          status: data.status,
          lostReason: data.status === "lost" ? (data.lostReason ?? null) : existing.lostReason,
          nextFollowUpAt:
            data.nextFollowUpAt !== undefined ? data.nextFollowUpAt : existing.nextFollowUpAt,
          score: scoreLead({
            source: existing.source,
            status: data.status,
            temperature: existing.temperature,
            phone: existing.phone,
            email: existing.email,
            budgetMinMinor: existing.budgetMinMinor,
            budgetMaxMinor: existing.budgetMaxMinor,
            projectId: existing.projectId,
            consentAt: existing.consentAt,
          }),
          updatedAt: now,
        })
        .where(and(eq(leads.id, data.id), eq(leads.tenantId, ctx.tenant.id)));

      await tx.insert(leadActivities).values({
        tenantId: ctx.tenant.id,
        leadId: existing.id,
        userId: ctx.user.id,
        type: "status_change",
        subject: `${existing.status} → ${data.status}`,
        notes: data.lostReason ?? null,
        occurredAt: now,
      });

      return { kind: "ok" as const, from: existing.status };
    });

    if (result.kind === "not_found") {
      return salesFail("That lead does not exist, or you cannot see it.");
    }
    if (result.kind === "blocked") return salesFail(result.message);

    await writeAudit(ctx, {
      action: "update",
      resourceType: "lead",
      resourceId: data.id,
      oldValue: { status: result.from },
      newValue: { status: data.status },
      reason: data.lostReason ?? undefined,
    });

    revalidatePath("/sales/leads");
    return { ok: true, data: { id: data.id, status: data.status } };
  } catch (err) {
    return toSalesActionError(err, "transitionLead");
  }
}

export async function logLeadActivity(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardSalesWrite({
      operation: "leads:update",
      feature: "sales.pipeline",
      permission: "leads:update",
    });

    const data = logActivitySchema.parse(input);
    const now = new Date();

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const [lead] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.id, data.leadId),
            eq(leads.tenantId, ctx.tenant.id),
            isNull(leads.deletedAt),
          ),
        )
        .limit(1);

      if (!lead) return null;

      const [row] = await tx
        .insert(leadActivities)
        .values({
          tenantId: ctx.tenant.id,
          leadId: lead.id,
          userId: ctx.user.id,
          type: data.type,
          subject: data.subject ?? null,
          notes: data.notes ?? null,
          outcome: data.outcome ?? null,
          scheduledAt: data.scheduledAt ?? null,
          occurredAt: data.occurredAt ?? now,
        })
        .returning({ id: leadActivities.id });

      // A logged call moves the follow-up forward. Without this the rep
      // makes the call and the lead still shows as overdue, so they stop
      // trusting the overdue list — which is the only list that matters.
      if (data.scheduledAt) {
        await tx
          .update(leads)
          .set({ nextFollowUpAt: data.scheduledAt, updatedAt: now })
          .where(and(eq(leads.id, lead.id), eq(leads.tenantId, ctx.tenant.id)));
      }

      return row ?? null;
    });

    if (!created) return salesFail("That lead does not exist, or you cannot see it.");

    revalidatePath(`/sales/leads/${data.leadId}`);
    return { ok: true, data: created };
  } catch (err) {
    return toSalesActionError(err, "logLeadActivity");
  }
}

/**
 * Whether the current workspace may use the pipeline features.
 *
 * ⚠️ NON-THROWING. Used by the UI to decide what to render. The throwing
 * variant guards the writes; a page that throws on an entitlement check
 * is a page that shows an error instead of an upgrade prompt.
 */
export async function getSalesEntitlements(): Promise<
  ActionResult<Record<string, boolean>>
> {
  try {
    await requirePermission("leads:read");
    const keys = [
      "sales.pipeline",
      "sales.inventory",
      "sales.bookings",
      "sales.payment_plans",
      "sales.channel_partners",
      "sales.brokerage",
    ] as const;

    const entries = await Promise.all(
      keys.map(async (key) => [key, (await checkFeature(key)).allowed] as const),
    );

    return { ok: true, data: Object.fromEntries(entries) };
  } catch (err) {
    return toSalesActionError(err, "getSalesEntitlements");
  }
}
