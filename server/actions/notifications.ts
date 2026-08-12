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
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireTenantContext } from "@/server/tenant-context";

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
/* CREATE NOTIFICATION — MOVED OUT OF THIS FILE (v0.88.0-alpha)         */
/* ------------------------------------------------------------------ */
/*
 * 🔴 `createNotification` now lives in `server/notifications/create.ts`.
 *
 * It took `tenantId` from its caller and never called
 * `requireTenantContext()`. Exported from this `"use server"` file it was
 * therefore a browser-reachable endpoint that accepted the tenant to write
 * into as a parameter — a cross-tenant insert, and at severity "critical"
 * or "warning" an Ordence-branded email to every active user of that
 * workspace with an attacker-chosen link.
 *
 * RLS could not catch it: RLS enforces the tenant the transaction declares,
 * and this function let the caller declare it.
 *
 * Its two real callers are server-side and have no user session, so the fix
 * is the boundary, not a check inside the function. If the UI ever needs to
 * create a notification, add a thin wrapper HERE that calls
 * `requireTenantContext()` and passes `ctx.tenant.id` — never a tenant id
 * that arrived from a client.
 */
