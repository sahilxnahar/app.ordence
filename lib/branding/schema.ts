/**
 * Ordence — The shape of `tenants.branding`
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE COLUMN IS OLDER THAN THIS WAVE AND HAS THREE WRITERS
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/core.ts` says of it: "Shape validated by Zod at the edge
 * (lib/validators)". No such validator existed. This is it.
 *
 * The three existing writers are `scripts/seed-basaveshwar-project.ts`,
 * `server/platform/claim-slug.ts` and `app/api/webhooks/clerk/_webhook.ts`
 * — and the webhook writes `logoUrl: org.image_url`, a Clerk-hosted URL
 * this wave neither controls nor can revoke.
 *
 * 🔴 THEREFORE EVERY FIELD IS OPTIONAL AND THE PARSER NEVER THROWS ON A
 * STORED VALUE. A tenant row written by a path that predates this file
 * must still render. `parseBranding()` is total; the write path
 * (`brandingUpdateSchema`) is strict, because that input comes from a
 * browser.
 */

import { z } from "zod";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * What is stored. `bannerUrl`, `faviconUrl` and `fontFamily` are carried
 * because the column already has them; **this wave does not write them**
 * and the screen does not offer them. A font picker is a theme editor,
 * and a theme editor is how a customer makes their own ledger unreadable.
 */
export type StoredBranding = {
  /**
   * An absolute URL. Today only ever Clerk's organisation image, written
   * by the webhook. Kept as a FALLBACK behind `logoKey` rather than
   * overwritten — a customer who has not uploaded anything still gets
   * whatever logo Clerk already holds for them.
   */
  logoUrl?: string;
  /**
   * ⭐ NEW IN WAVE 2E. The R2 object key of a logo uploaded through the
   * product's existing three-step upload. NOT a URL: the bucket is
   * private and has no public address, so the key is resolved to a route
   * at render time (`lib/branding/logo.ts`).
   */
  logoKey?: string;
  /** Cache-buster. Milliseconds. A logo replaced at the same key must repaint. */
  logoUpdatedAt?: number;
  /**
   * ⭐ NEW IN WAVE 2E. When the owner finished — or deliberately skipped —
   * the first-run branding screen. Milliseconds.
   *
   * ⚠️ IT MARKS THE DECISION, NOT THE OUTCOME. Somebody who looked at the
   * screen and chose to keep the product's own colours has decided, and
   * must never be sent back to it. Testing `logoKey` instead would nag
   * that person on every sign-in forever, which is how a setup step turns
   * into the reason somebody stops using a product.
   */
  setupCompletedAt?: number;
  /** The brand colour, hex. Already written by the webhook as `#B08D3C`. */
  primaryColor?: string;
  accentColor?: string;
  bannerUrl?: string;
  faviconUrl?: string;
  fontFamily?: string;
};

const optionalHex = z
  .string()
  .trim()
  .regex(HEX, "Use a hex colour such as #1D4ED8.");

/**
 * What a browser may send.
 *
 * ⚠️ `logoKey` IS ACCEPTED FROM THE CLIENT AND IS NOT TRUSTED HERE. The
 * shape check below only proves it looks like one of our keys; the action
 * re-checks that the key sits inside THIS tenant's storage prefix, using
 * `pathnameBelongsToTenant()` — the same function the download route
 * uses. A shape check standing in for an ownership check is how one
 * tenant ends up rendering another tenant's object.
 */
export const brandingUpdateSchema = z.object({
  primaryColor: optionalHex,
  logoKey: z.string().trim().min(1).max(1024).optional(),
  /** Explicitly clearing the logo, as distinct from "not changing it". */
  removeLogo: z.boolean().optional(),
});

export type BrandingUpdateInput = z.input<typeof brandingUpdateSchema>;

/** The product's own colour, from the Clerk webhook's `DEFAULT_BRANDING`. */
export const ORDENCE_DEFAULT_COLOR = "#B08D3C";

/**
 * Total parse of whatever the column holds. Unknown keys are dropped
 * rather than carried, and a bad value is treated as absent.
 */
export function parseBranding(raw: unknown): StoredBranding {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;

  const str = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  const colour = (key: string): string | undefined => {
    const value = str(key);
    return value && HEX.test(value) ? value : undefined;
  };

  const updatedAt = record.logoUpdatedAt;

  return {
    ...(str("logoUrl") ? { logoUrl: str("logoUrl") } : {}),
    ...(str("logoKey") ? { logoKey: str("logoKey") } : {}),
    ...(typeof updatedAt === "number" && Number.isFinite(updatedAt)
      ? { logoUpdatedAt: updatedAt }
      : {}),
    ...(typeof record.setupCompletedAt === "number" && Number.isFinite(record.setupCompletedAt)
      ? { setupCompletedAt: record.setupCompletedAt }
      : {}),
    ...(colour("primaryColor") ? { primaryColor: colour("primaryColor") } : {}),
    ...(colour("accentColor") ? { accentColor: colour("accentColor") } : {}),
    ...(str("bannerUrl") ? { bannerUrl: str("bannerUrl") } : {}),
    ...(str("faviconUrl") ? { faviconUrl: str("faviconUrl") } : {}),
    ...(str("fontFamily") ? { fontFamily: str("fontFamily") } : {}),
  };
}

/**
 * Merge a patch into what is stored, the way `mergeSettings()` does for
 * `settings`.
 *
 * 🔴 MERGE, NEVER REPLACE. Three other paths write this column. A form
 * that replaced the object would erase `logoUrl` on the first save, and
 * the Clerk webhook would put it back on the next organisation update —
 * a value that flickers between two writers is the hardest kind of bug to
 * be told about.
 */
export type BrandingPatch = {
  [K in keyof StoredBranding]?: StoredBranding[K] | null;
};

export function mergeBranding(existing: unknown, patch: BrandingPatch): StoredBranding {
  const current = parseBranding(existing);
  const next: StoredBranding = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key as keyof StoredBranding];
      continue;
    }
    if (value === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next as any)[key] = value;
  }

  return next;
}
