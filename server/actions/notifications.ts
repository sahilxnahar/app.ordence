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

import { and, eq, or, desc, isNull, isNotNull, sql } from "drizzle-orm";
import { db, withTenant } from "@/db";
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

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
    );

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

    const result = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, ctx.tenant.id),
            isNull(notifications.readAt),
            isNull(notifications.dismissedAt),
          ),
        )
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


    /**
     * ══════════════════════════════════════════════════════════════
     * 🔴 SCOPED TO THE CALLER — ADDED IN v1.26.0-alpha BY `check:guards`
     * ══════════════════════════════════════════════════════════════
     * This matched on the notification id and the TENANT only. Any
     * member of the workspace could mark or dismiss anybody else's
     * notification — including the owner's "your GST return is due on
     * the 20th", which is the one thing in this table that costs money
     * to miss.
     *
     * ⚠️ AND `markAllAsRead` WAS THE BAD ONE. It carried no id at all,
     * so one click by any member cleared every unread notification in
     * the entire workspace. Nothing errored; the owner simply had an
     * empty inbox.
     *
     * ⭐ THE FIX IS NOT A PERMISSION. "May you read your own post" is
     * not a question the permission table should have an opinion about;
     * the right answer is that the row has to be YOURS. A
     * `notifications:manage` key would have looked like a fix and would
     * still have let anybody holding it clear the owner's inbox.
     *
     * ⚠️ `userId IS NULL` IS A WORKSPACE-WIDE BROADCAST, and it is
     * included deliberately — otherwise nobody could ever dismiss one.
     * That does mean a broadcast has ONE shared read state across the
     * workspace: whoever dismisses it dismisses it for everybody. That
     * is a limitation of the schema, which has no per-user read row, and
     * it is worth stating rather than discovering.
     */
    const mine = or(eq(notifications.userId, ctx.user.id), isNull(notifications.userId));

    await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.tenantId, ctx.tenant.id),
            mine,
          ),
        )
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

    const mine = or(eq(notifications.userId, ctx.user.id), isNull(notifications.userId));

    const result = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.tenantId, ctx.tenant.id),
            /** 🔴 See `markAsRead`. Without this line, one click cleared the whole workspace. */
            mine,
            isNull(notifications.readAt),
            isNull(notifications.dismissedAt),
          ),
        )
        .returning({ id: notifications.id })
    );

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

    const mine = or(eq(notifications.userId, ctx.user.id), isNull(notifications.userId));

    await withTenant(ctx.tenant.id, (tx) =>
      tx
        .update(notifications)
        .set({ dismissedAt: new Date(), readAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.tenantId, ctx.tenant.id),
            /** 🔴 See `markAsRead`. */
            mine,
          ),
        )
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
