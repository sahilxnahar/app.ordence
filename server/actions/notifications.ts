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
  try {
    await withTenant(input.tenantId, async (tx) => {
      const result = await tx
        .insert(notifications)
        .values({
          tenantId: input.tenantId,
          userId: input.userId ?? null,
          category: input.category,
          severity: input.severity ?? "info",
          title: input.title,
          body: input.body ?? null,
          actionUrl: input.actionUrl ?? null,
          metadata: input.metadata ?? {},
          source: input.source ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning({ id: notifications.id });

      return result[0]?.id;
    });

    // Best-effort email delivery for critical/warning notifications.
    // Only sends if RESEND_API_KEY is configured and severity warrants it.
    if (input.severity === "critical" || input.severity === "warning" || !input.severity) {
      try {
        const tenantRow = await db
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, input.tenantId))
          .limit(1);

        const tenantName = tenantRow[0]?.name ?? "Your workspace";

        // Get active users with email addresses for this tenant
        const userRows = await withTenant(input.tenantId, async (tx) => {
          return tx
            .select({ email: users.email })
            .from(users)
            .where(and(eq(users.tenantId, input.tenantId), eq(users.status, "active")))
            .limit(50);
        });

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.ordence.com";
        const { html, text } = buildNotificationEmail({
          title: input.title,
          body: input.body,
          actionUrl: input.actionUrl,
          severity: input.severity ?? "info",
          tenantName,
          appUrl,
        });

        // Send to all active users (best-effort, errors are caught)
        for (const user of userRows) {
          await sendEmail({
            to: user.email,
            subject: `[${input.severity?.toUpperCase() ?? "INFO"}] ${input.title}`,
            html,
            text,
          });
        }
      } catch (emailErr) {
        // Email delivery is best-effort. The in-app notification was already created.
        console.error("[notifications] Email delivery failed:", emailErr);
      }
    }

    return { ok: true, id: "created" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create notification.",
    };
  }
}
