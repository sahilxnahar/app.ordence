"use server";

/**
 * Ordence — Appearance preference: load and save
 * Version: v1.54.0-alpha
 *
 * ⚠️ `"use server"` PUBLISHES EVERY EXPORT AS AN RPC ENDPOINT. Both
 * exports here are async functions and both call `requirePermission()`
 * as their first statement — one hop from the export, with nothing
 * between the boundary and the guard. The theme catalogue, the default
 * and the parser live in `lib/appearance/preferences.ts` precisely so
 * that none of them has to be exported from a file with this directive
 * at the top.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SERVER VALUE IS THE TRUTH. STORAGE IS A CACHE OF IT.
 * ══════════════════════════════════════════════════════════════════════
 * The theme used to exist only in one browser's `localStorage`, so an
 * accountant who set dark mode on the office desktop got a white flash
 * of surprise on the laptop at home, and a site engineer who set light
 * mode on his phone got whatever his tablet's OS felt like. Persisting
 * on the user row makes the choice follow the PERSON.
 *
 * `theme-provider.tsx` still writes a copy into `localStorage`, and that
 * copy is still legitimate — read the header of that file before you
 * delete it. It exists to paint the correct palette before hydration and
 * is refreshed FROM this row on every authenticated load.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO USER PARAMETER, FOR THE SAME REASON AS BATCH 135
 * ══════════════════════════════════════════════════════════════════════
 * A caller who could name the row to write could force a colleague's UI
 * into a mode they cannot read — dark mode for the engineer standing in
 * the sun is not cosmetic, it is a person who cannot close his job card.
 * The id is re-derived from the session on every call and the UPDATE is
 * pinned to it, so there is no argument to forge.
 *
 * ⚠️ THE GUARD IS `settings:read`, NOT `settings:update`, matching the
 * notification action next door: `settings:update` is the WORKSPACE
 * permission held by administrators, and gating a personal display
 * choice behind it would mean an ordinary member cannot choose their own
 * palette. The row-level rule — "you may only write YOUR row" — is not a
 * permission at all, it is the WHERE clause below.
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
  defaultAppearancePreferences,
  mergeAppearancePreferences,
  parseAppearancePreferences,
  type AppearancePreferences,
} from "@/lib/appearance/preferences";

export type AppearancePreferencesResult =
  | { ok: true; data: AppearancePreferences }
  | { ok: false; error: string };

/**
 * ⚠️ THE ENUM IS RESTATED FOR ZOD RATHER THAN DERIVED WITH A CAST.
 * `z.enum` needs a non-empty literal tuple; building one with
 * `as [string, ...string[]]` would accept any string at the type level
 * and hand an unvalidated value to the parser. The parser would still
 * reject it — but a validator that lies about what it validated is the
 * kind of thing the next person builds on.
 */
const saveSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
});

export type SaveAppearancePreferencesInput = z.input<typeof saveSchema>;

function toError(err: unknown): { ok: false; error: string } {
  if (err instanceof TenantAccessError) return { ok: false, error: err.message };
  if (err instanceof PermissionDeniedError) return { ok: false, error: err.message };
  if (err instanceof z.ZodError) {
    return { ok: false, error: "That appearance setting was not recognised." };
  }
  console.error("[appearance-preferences]", err);
  return { ok: false, error: "Something went wrong. Please try again." };
}

/**
 * Read the signed-in user's appearance preference.
 *
 * ⚠️ RE-READS THE ROW rather than trusting a cached session context: this
 * is called straight after a save, where a stale value would show the
 * user the state they just replaced and teach them the control does not
 * stick.
 */
export async function getAppearancePreferences(): Promise<AppearancePreferencesResult> {
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
     * missing row is real (a user soft-deleted mid-session). Defaults,
     * not an error: the light palette is the safe answer for somebody
     * whose stored choice we cannot read.
     */
    const row = rows[0];
    return { ok: true, data: parseAppearancePreferences(row?.preferences) };
  } catch (err) {
    return toError(err);
  }
}

/**
 * Save the signed-in user's appearance preference.
 *
 * 🔴 THERE IS NO USER PARAMETER. See the file header.
 */
export async function saveAppearancePreferences(
  input: SaveAppearancePreferencesInput,
): Promise<AppearancePreferencesResult> {
  try {
    const ctx = await requirePermission("settings:read");
    const parsed = saveSchema.parse(input);

    /*
     * ⚠️ NORMALISED THROUGH THE SAME PARSER EVERY READER USES. Zod proved
     * the payload is well formed; the parser decides what it MEANS. The
     * two are not the same job, and skipping the second is how a value
     * that is valid JSON but not a valid theme reaches the column.
     */
    const next = parseAppearancePreferences({
      ...defaultAppearancePreferences(),
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
          /*
           * ⭐ MERGE, NEVER REPLACE. `notifications` lives in this same
           * column. Choosing dark mode must not be able to reset
           * somebody's GST alert preferences.
           */
          preferences: mergeAppearancePreferences(existing[0]?.preferences, next),
          updatedAt: new Date(),
        })
        /*
         * 🔴 THE OWNERSHIP CLAUSE. `ctx.user.id` comes from
         * `requirePermission()` → `requireTenantContext()`, which re-reads
         * the Clerk session server-side. Nothing the browser sent reaches
         * this line. The `tenantId` is pinned on top of RLS so the
         * statement stays correct if it is ever read or copied out of
         * `withTenant()`.
         */
        .where(and(eq(users.id, ctx.user.id), eq(users.tenantId, ctx.tenant.id)))
        .returning({ preferences: users.preferences });
    });

    const row = updated[0];
    if (!row) return { ok: false, error: "Your account could not be found in this workspace." };

    revalidatePath("/settings/appearance");
    return { ok: true, data: parseAppearancePreferences(row.preferences) };
  } catch (err) {
    return toError(err);
  }
}
