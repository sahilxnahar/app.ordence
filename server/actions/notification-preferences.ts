"use server";

/**
 * Ordence — Notification preferences: load and save
 * Version: v1.53.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that exports
 * anything else publishes it as an RPC endpoint reachable by anyone. The
 * category list, the severity list and the parser all live in
 * `lib/notifications/preferences.ts` for exactly that reason — and
 * because the mail sender has to import them too.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THING THIS FILE MUST NEVER GET WRONG
 * ══════════════════════════════════════════════════════════════════════
 * These preferences decide whether a human receives mail. A caller who
 * could name the user to write would be able to switch OFF every alert
 * for a colleague — the workspace's finance lead, say — and the victim's
 * only symptom is mail that stops arriving. Nobody reports that. They
 * assume nothing happened.
 *
 * ⭐ SO THE USER ID IS NEVER AN ARGUMENT. It is re-derived from the
 *    session on every call, and the UPDATE is pinned to it. There is no
 *    parameter to forge because there is no parameter. `saveInput` is
 *    parsed with a non-strict Zod object, so a `userId` smuggled into
 *    the payload is not rejected with a hint — it is silently dropped
 *    before the write is even constructed.
 *
 * ⚠️ AND THE `tenantId` IS PINNED TOO, on top of RLS. `withTenant()`
 *    already scopes the transaction, but the extra `eq(users.tenantId,
 *    ...)` costs nothing and means the statement is still correct if it
 *    is ever read, copied or run outside that wrapper.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE GUARD IS `settings:read` AND NOT `settings:update`
 * ══════════════════════════════════════════════════════════════════════
 * `settings:update` is the WORKSPACE settings permission — currency,
 * fiscal year, industry — and it is held by administrators. Requiring it
 * here would mean an ordinary member could not turn off their own email,
 * which is not a security posture, it is a bug with a permission check
 * in front of it.
 *
 * The authorisation question this action actually asks is "are you a
 * provisioned member of this workspace with a settings surface at all",
 * and `settings:read` is precisely that key — the `read_only` role holds
 * it. The row-level answer, "and you may only write YOUR row", is not a
 * permission at all; it is the WHERE clause below, which is the only
 * place it can be enforced without inventing a permission per user.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { users } from "@/db/schema";
import { requirePermission } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  NOTIFICATION_CATEGORIES,
  defaultNotificationPreferences,
  mergeNotificationPreferences,
  parseNotificationPreferences,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";

export type NotificationPreferencesResult =
  | { ok: true; data: NotificationPreferences }
  | { ok: false; error: string };

/**
 * ⚠️ CATEGORY KEYS ARE VALIDATED AGAINST THE CATALOGUE, NOT ACCEPTED AS
 * FREE TEXT. Without this an attacker could grow one row's JSONB without
 * limit, one unknown key at a time. The parser would ignore them on read
 * — but the bytes would still be stored, and stored bytes are the part
 * that costs money and gets dumped into a support ticket.
 */
const categoryKeys = NOTIFICATION_CATEGORIES.map((c) => c.key) as [string, ...string[]];

const saveSchema = z.object({
  emailEnabled: z.boolean(),
  minSeverity: z.enum(["critical", "warning", "info"]),
  categories: z.record(z.enum(categoryKeys), z.boolean()),
});

export type SaveNotificationPreferencesInput = z.input<typeof saveSchema>;

function toError(err: unknown): { ok: false; error: string } {
  if (err instanceof TenantAccessError) return { ok: false, error: err.message };
  if (err instanceof PermissionDeniedError) return { ok: false, error: err.message };
  if (err instanceof z.ZodError) {
    return { ok: false, error: "Those notification settings were not recognised." };
  }
  console.error("[notification-preferences]", err);
  return { ok: false, error: "Something went wrong. Please try again." };
}

/**
 * Read the signed-in user's preferences.
 *
 * ⚠️ RE-READS THE ROW rather than trusting `ctx.user.preferences`. The
 * session context is resolved once per request and this action is also
 * called straight after a save, where a cached value would show the user
 * the state they just replaced and teach them the switch did not stick.
 */
export async function getNotificationPreferences(): Promise<NotificationPreferencesResult> {
  try {
    const ctx = await requirePermission("settings:read");

    const rows = await withTenant(ctx.tenant.id, (tx) =>
      tx
        .select({ preferences: users.preferences })
        .from(users)
        .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id)))
        .limit(1),
    );

    /*
     * 🔴 `noUncheckedIndexedAccess` — `rows[0]` is `T | undefined`, and a
     * missing row is a real possibility (a user soft-deleted mid-session).
     * Defaults, not an error: a settings page that cannot render is worse
     * than one showing the values that are in force anyway.
     */
    const row = rows[0];
    return { ok: true, data: parseNotificationPreferences(row?.preferences) };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Save the signed-in user's preferences.
 *
 * 🔴 THERE IS NO USER PARAMETER. See the file header.
 */
export async function saveNotificationPreferences(
  input: SaveNotificationPreferencesInput,
): Promise<NotificationPreferencesResult> {
  try {
    const ctx = await requirePermission("settings:read");
    const parsed = saveSchema.parse(input);

    /*
     * ⚠️ NORMALISED THROUGH THE SAME PARSER THE SENDER USES. Zod proved
     * the payload is well formed; the parser decides what it MEANS,
     * including filling in categories the form did not submit. Writing
     * the raw payload would let a partial submission persist a shape the
     * sender then has to guess about.
     */
    const next = parseNotificationPreferences({
      ...defaultNotificationPreferences(),
      ...parsed,
    });

    const updated = await withTenant(ctx.tenant.id, async (tx) => {
      const existing = await tx
        .select({ preferences: users.preferences })
        .from(users)
        .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id)))
        .limit(1);

      return tx
        .update(users)
        .set({
          preferences: mergeNotificationPreferences(existing[0]?.preferences, next),
          updatedAt: new Date(),
        })
        /*
         * 🔴 THE OWNERSHIP CLAUSE. `ctx.user.id` comes from
         * `requirePermission()` → `requireTenantContext()`, which
         * re-reads the Clerk session server-side. Nothing the browser
         * sent reaches this line.
         */
        .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id)))
        .returning({ preferences: users.preferences });
    });

    const row = updated[0];
    if (!row) return { ok: false, error: "Your account could not be found in this workspace." };

    revalidatePath("/settings/notifications");
    return { ok: true, data: parseNotificationPreferences(row.preferences) };
  } catch (err) {
    return toError(err);
  }
}
