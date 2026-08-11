"use server";

/**
 * Ordence — Notifications Server Actions
 * Version: v0.81.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone.
 *
 * All actions go through requireTenantContext() so RLS is enforced.
 */

import { and, eq, desc, isNull, isNotNull, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { notifications, users, tenants } from "@/db/schema";
import { requireTenantContext } from "@/server/tenant-context";
import { writeAudit } from "@/server/audit";
import { sendEmail, buildNotificationEmail } from "@/lib/email/notifications";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type NotificationRow = {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  metadata: Record<string, unknown>;
  source: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
};

export type NotificationFilter = "all" | "unread" | "read";

/* ------------------------------------------------------------------ */
/* LIST NOTIFICATIONS                                                  */
/* ------------------------------------------------------------------ */

export async function listNotifications(opts?: {
  filter?: NotificationFilter;
  category?: string;
  limit?: number;
}): Promise<{ ok: true; rows: NotificationRow[] } | { ok: false; error: string }> {
  try {
    const ctx = await requireTenantContext();
    const limit = Math.min(opts?.limit ?? 50, 100);

    const conditions = [eq(notifications.tenantId, ctx.tenant.id)];

    if (opts?.filter === "unread") {
      conditions.push(isNull(notifications.readAt));
      conditions.push(isNull(notifications.dismissedAt));
    } else if (opts?.filter === "read") {
      conditions.push(isNotNull(notifications.readAt));
    }

    if (opts?.category && opts.category !== "all") {
      conditions.push(eq(notifications.category, opts.category));
    }

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return {
      ok: true,
      rows: rows.map((r) => ({
        id: r.id,
        category: r.category,
        severity: r.severity,
        title: r.title,
        body: r.body,
        actionUrl: r.actionUrl,
        metadata: r.metadata as Record<string, unknown>,
        source: r.source,
        readAt: r.readAt?.toISOString() ?? null,
        dismissedAt: r.dismissedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to list notifications.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* UNREAD COUNT                                                        */
/* ------------------------------------------------------------------ */

export async function getUnreadCount(): Promise<
  { ok: true; count: number } | { ok: false; error: string }
> {
  try {
    const ctx = await requireTenantContext();

    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, ctx.tenant.id),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
        ),
      );

    return { ok: true, count: result[0]?.count ?? 0 };
  } catch {
    // If the notifications table doesn't exist yet (pre-migration), return 0.
    return { ok: true, count: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* MARK AS READ                                                        */
/* ------------------------------------------------------------------ */

export async function markAsRead(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireTenantContext();

    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.tenantId, ctx.tenant.id),
        ),
      );

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to mark notification as read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* MARK ALL AS READ                                                    */
/* ------------------------------------------------------------------ */

export async function markAllAsRead(): Promise<
  { ok: true; updated: number } | { ok: false; error: string }
> {
  try {
    const ctx = await requireTenantContext();

    const result = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.tenantId, ctx.tenant.id),
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
        ),
      )
      .returning({ id: notifications.id });

    return { ok: true, updated: result.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to mark all as read.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* DISMISS                                                             */
/* ------------------------------------------------------------------ */

export async function dismissNotification(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const ctx = await requireTenantContext();

    await db
      .update(notifications)
      .set({ dismissedAt: new Date(), readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.tenantId, ctx.tenant.id),
        ),
      );

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to dismiss notification.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* CREATE NOTIFICATION (internal — called by background workers)       */
/* ------------------------------------------------------------------ */

export async function createNotification(input: {
  tenantId: string;
  userId?: string;
  category: string;
  severity?: string;
  title: string;
  body?: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  source?: string;
  expiresAt?: Date;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const severity = input.severity ?? "info";

  /*
   * ⚠️ EMAIL IS OPT-IN BY SEVERITY, AND THE TEST IS EXHAUSTIVE ON PURPOSE.
   *
   * This condition used to read:
   *
   *     severity === "critical" || severity === "warning" || !input.severity
   *
   * The third clause meant the DEFAULT — an ordinary `info` notification with
   * no severity passed — also emailed every active user in the workspace.
   * `server/ai/background-workers.ts` creates these on a schedule, so the
   * practical effect was a mail-out per worker run per tenant. The comment
   * above it said "only if severity warrants it"; the code disagreed.
   */
  const shouldEmail = severity === "critical" || severity === "warning";

  try {
    /*
     * ⚠️ ONE TRANSACTION, NOT THREE ROUND TRIPS.
     *
     * The insert, the tenant name and the recipient list are all tenant-scoped
     * reads, so they belong in the same `withTenant()` block. Previously this
     * was an insert in one transaction, a `db` read, and a SECOND transaction
     * for the recipients — three separate connections per notification.
     *
     * 🔴 The tenant-name lookup was also silently broken. It used the plain
     * `db` client, which carries NO tenant context, so every RLS policy
     * evaluates `tenant_id = app_current_tenant_id()` against NULL and matches
     * nothing — the same failure documented on `withPlatformScope()`. It
     * returned zero rows and fell through to "Your workspace" every single
     * time. Inside the transaction it actually resolves.
     */
    const created = await withTenant(input.tenantId, async (tx) => {
      const result = await tx
        .insert(notifications)
        .values({
          tenantId: input.tenantId,
          userId: input.userId ?? null,
          category: input.category,
          severity,
          title: input.title,
          body: input.body ?? null,
          actionUrl: input.actionUrl ?? null,
          metadata: input.metadata ?? {},
          source: input.source ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning({ id: notifications.id });

      const id = result[0]?.id;
      if (!id) throw new Error("Notification insert returned no id.");

      if (!shouldEmail) {
        return { id, tenantName: null as string | null, recipients: [] as string[] };
      }

      const tenantRow = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);

      const userRows = await tx
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.status, "active")))
        .limit(50);

      return {
        id,
        tenantName: tenantRow[0]?.name ?? null,
        recipients: userRows.map((u) => u.email).filter(Boolean),
      };
    });

    if (shouldEmail && created.recipients.length > 0) {
      /*
       * ⚠️ PARALLEL, NOT SEQUENTIAL, AND NEVER ALLOWED TO THROW.
       *
       * This was a `for` loop with an `await` inside it — up to fifty
       * sequential HTTPS round trips to Resend, on the request path, before
       * the caller got its notification id back. `allSettled` collapses that
       * to one round and cannot reject, so a single bad address cannot lose
       * the other forty-nine.
       *
       * TODO: move this to the existing QStash queue (`lib/queue/`). Email is
       * not the caller's business and should not be on its clock at all.
       * Parallelising is the containment, not the cure.
       */
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.ordence.com";
      const { html, text } = buildNotificationEmail({
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        severity,
        tenantName: created.tenantName ?? "Your workspace",
        appUrl,
      });

      const subject = `[${severity.toUpperCase()}] ${input.title}`;

      const results = await Promise.allSettled(
        created.recipients.map((to) => sendEmail({ to, subject, html, text })),
      );

      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        console.error(
          `[notifications] ${failed}/${created.recipients.length} notification emails failed for tenant ${input.tenantId}.`,
        );
      }
    }

    /*
     * ⚠️ THE REAL ID. This used to return the literal string "created",
     * discarding the UUID the transaction had just computed. Every caller
     * that stored or echoed the id — including the `ordence_create_reminder`
     * MCP tool, which hands it to an AI agent — received the word "created"
     * where a UUID was promised by this function's own return type.
     */
    return { ok: true, id: created.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create notification.",
    };
  }
}
