"use server";

/**
 * Ordence — ⭐⭐⭐ THE UNIVERSAL TIMELINE
 * Version: v1.9.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE QUESTION NO SCREEN IN ORDENCE COULD ANSWER
 * ══════════════════════════════════════════════════════════════════════
 * "What has happened with this customer?"
 *
 * Before this, the answer lived in six places: the invoices screen, the
 * receipts screen, the deals screen, somebody's email, somebody's phone,
 * and a notebook. Each of them true, none of them the answer.
 *
 * ⭐ ONE TABLE, EVERY MODULE, ONE ORDER. And it is append-only for
 * anything the system or an integration wrote, because a history that
 * can be edited is not a history.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { activities } from "@/db/schema/work";
import { users } from "@/db/schema/core";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "contacts:read" as const;
const WRITE = "contacts:update" as const;

const SUBJECT_TYPES = [
  "company",
  "contact",
  "deal",
  "lead",
  "sales_order",
  "sales_invoice",
  "purchase_invoice",
  "receipt",
  "matter",
  "hearing",
  "project",
  "unit",
  "booking",
  "consignment",
  "stock_item",
  "asset",
  "licence",
  "compliance_task",
  "campaign",
  "other",
] as const;

const CONTACT_KINDS = ["call", "email", "whatsapp", "sms", "visit"] as const;

const logSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().uuid(),
  subjectLabel: z.string().trim().max(300).nullish(),
  kind: z.enum([
    "note",
    "call",
    "email",
    "meeting",
    "whatsapp",
    "sms",
    "visit",
    "document",
  ]),
  direction: z.enum(["inbound", "outbound"]).nullish(),
  summary: z.string().trim().min(1, "Say what happened.").max(500),
  body: z.string().trim().max(8000).optional(),
  /** ⚠️ When it HAPPENED. Defaults to now, but a call written up on
   *  Friday belongs on Tuesday. */
  occurredAt: z.string().datetime().optional(),
});

/**
 * ⭐⭐ WRITE UP WHAT HAPPENED.
 *
 * 🔴 A CONTACT EVENT MUST SAY WHICH WAY IT WENT. "A call happened" with
 *    nobody knowing who rang whom is the note that starts an argument
 *    six months later, and it is the note people write when the form
 *    lets them.
 *
 * ⚠️ AND `occurredAt` CANNOT BE IN THE FUTURE. A timeline entry dated
 * next Tuesday is not a record of anything; it is a plan, and plans are
 * tasks.
 */
export async function logActivity(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const data = logSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    const isContact = (CONTACT_KINDS as readonly string[]).includes(data.kind);
    if (isContact && !data.direction) {
      throw new Error(
        "Say which way it went. A call, email or message with no direction recorded cannot answer who contacted whom, which is the first thing anybody asks about it later.",
      );
    }

    const when = data.occurredAt ? new Date(data.occurredAt) : new Date();
    if (Number.isNaN(when.getTime())) {
      throw new Error("That is not a valid date and time.");
    }
    if (when.getTime() > Date.now() + 60_000) {
      throw new Error(
        "This is dated in the future, so it has not happened yet. Something that has not happened is a task, not a record of what was done.",
      );
    }

    const id = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(activities)
          .values({
            tenantId: ctx.tenant.id,
            subjectType: data.subjectType,
            subjectId: data.subjectId,
            subjectLabel: data.subjectLabel ?? null,
            kind: data.kind,
            occurredAt: when,
            direction: data.direction ?? null,
            summary: data.summary,
            body: data.body ?? null,
            userId: ctx.user.id,
            /** ⭐ A person typed it, so a person may correct the wording. */
            source: "manual",
            createdBy: ctx.user.id,
          })
          .returning({ id: activities.id });

        if (!row) throw new Error("The note could not be saved.");

        await writeAudit(ctx, {
          action: "create",
          resourceType: "activity",
          resourceId: row.id,
          newValue: { kind: data.kind, subjectType: data.subjectType },
          severity: "info",
        });
        return row.id;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/tasks");
    return { ok: true, data: { id } };
  } catch (err) {
    return toSalesActionError(err, "logActivity");
  }
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ EVERYTHING THAT EVER HAPPENED WITH ONE RECORD, NEWEST FIRST.
 *
 * ⚠️ Ordered by `occurred_at`, not by `created_at`. A call made on
 * Tuesday and written up on Friday belongs on Tuesday, and a timeline
 * sorted by when it was typed tells the story in the wrong order.
 */
export async function getTimeline(input: unknown): Promise<
  ActionResult<{
    rows: {
      id: string;
      kind: string;
      occurredAt: string;
      direction: string | null;
      summary: string;
      body: string | null;
      userName: string | null;
      source: string;
      sourceName: string | null;
      /** ⭐ True where the row is evidence and cannot be edited. */
      immutable: boolean;
    }[];
    total: number;
  }>
> {
  try {
    const data = z
      .object({
        subjectType: z.enum(SUBJECT_TYPES),
        subjectId: z.string().uuid(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(input);
    const ctx = await requirePermission(READ);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: activities.id,
            kind: activities.kind,
            occurredAt: activities.occurredAt,
            direction: activities.direction,
            summary: activities.summary,
            body: activities.body,
            source: activities.source,
            sourceName: activities.sourceName,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(activities)
          .leftJoin(users, eq(users.id, activities.userId))
          .where(
            and(
              eq(activities.tenantId, ctx.tenant.id),
              eq(activities.subjectType, data.subjectType),
              eq(activities.subjectId, data.subjectId),
            ),
          )
          .orderBy(desc(activities.occurredAt))
          .limit(data.limit),
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          occurredAt: r.occurredAt.toISOString(),
          direction: r.direction,
          summary: r.summary,
          body: r.body,
          userName:
            [r.first, r.last].filter(Boolean).join(" ").trim() || r.email || null,
          source: r.source,
          sourceName: r.sourceName,
          immutable: r.source !== "manual",
        })),
        total: rows.length,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getTimeline");
  }
}

/**
 * ⭐ THE WHOLE FIRM'S RECENT ACTIVITY.
 *
 * ⚠️ This is the screen a manager reads to see that anything is
 * happening at all. It is deliberately not filtered by person, because
 * the useful reading is who is NOT on it.
 */
export async function getRecentActivity(
  limit = 50,
): Promise<
  ActionResult<{
    rows: {
      id: string;
      kind: string;
      occurredAt: string;
      summary: string;
      subjectType: string;
      subjectLabel: string | null;
      userName: string | null;
      source: string;
    }[];
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const n = Math.min(Math.max(1, Math.trunc(limit)), 200);

    const rows = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        tx
          .select({
            id: activities.id,
            kind: activities.kind,
            occurredAt: activities.occurredAt,
            summary: activities.summary,
            subjectType: activities.subjectType,
            subjectLabel: activities.subjectLabel,
            source: activities.source,
            first: users.firstName,
            last: users.lastName,
            email: users.email,
          })
          .from(activities)
          .leftJoin(users, eq(users.id, activities.userId))
          .where(eq(activities.tenantId, ctx.tenant.id))
          .orderBy(desc(activities.occurredAt))
          .limit(n),
      { impersonationId: ctx.impersonationId },
    );

    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          occurredAt: r.occurredAt.toISOString(),
          summary: r.summary,
          subjectType: r.subjectType,
          subjectLabel: r.subjectLabel,
          userName:
            [r.first, r.last].filter(Boolean).join(" ").trim() || r.email || null,
          source: r.source,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getRecentActivity");
  }
}
