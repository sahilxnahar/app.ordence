/**
 * Ordence — Where a tenant's logo is read from
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A LOGO NEEDS A ROUTE AND A DOCUMENT DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * The R2 bucket is private and has no public address; every other file in
 * the product is reached through `/api/documents/[id]/download`, which
 * re-derives the session on each request. That is right for an executed
 * contract and impossible for a logo, because one of the three places a
 * logo has to appear is the SIGN-IN SCREEN — where by definition there is
 * no session, and the tenant is known only from the hostname.
 *
 * So a logo is served by its own route, and this module holds the two
 * decisions that route makes, as pure functions:
 *
 *   1. Which key may be served for a given tenant  (`servableLogoKey`)
 *   2. What the browser should ask for             (`logoSrc`)
 *
 * ⚠️ WHAT IS AND IS NOT EXPOSED BY THIS. The route serves ONE object per
 * tenant — the one named by `branding.logoKey` — and nothing else. It is
 * not a public read of the bucket, not a key-guessing surface, and not a
 * listing: an attacker who knows a slug learns the logo that is already
 * printed on that customer's invoices and login page. A logo is public by
 * purpose, which is why this and only this may be served without a
 * session.
 */

import { parseBranding } from "./schema";

/** Where the logo route lives. Referenced by the components and the route. */
export const LOGO_ROUTE = "/api/branding/logo";

/**
 * The key a request for `tenantId` may be served, or `null`.
 *
 * 🔴 THE PREFIX CHECK IS THE WHOLE SECURITY OF THIS ROUTE. `logoKey`
 * reaches the column through a form; if a caller could store
 * `tenants/<someone-else>/...` there, this route would fetch and publish
 * another tenant's object with no session at all. The action refuses such
 * a key on the way in, and this refuses it again on the way out, because
 * a value that was validated once is only as trustworthy as everything
 * that could have written it since.
 *
 * ⚠️ THE COMPARISON IS THE SAME ONE THE DOWNLOAD ROUTE MAKES.
 * `pathnameBelongsToTenant()` lives in `lib/validators/storage.ts`; it is
 * passed in rather than imported so this module stays free of the
 * validator's zod dependency and can be exercised on its own.
 */
export function servableLogoKey(
  branding: unknown,
  tenantId: string,
  belongsToTenant: (key: string, tenantId: string) => boolean,
): string | null {
  const parsed = parseBranding(branding);
  const key = parsed.logoKey;
  if (!key) return null;
  if (!belongsToTenant(key, tenantId)) return null;
  return key;
}

/**
 * What an `<img>` should point at, or `null` for "no logo — show the
 * wordmark".
 *
 * Preference order, and it matters:
 *   1. `logoKey`  — what the customer uploaded, through our own storage
 *   2. `logoUrl`  — whatever Clerk had for the organisation
 *
 * ⚠️ THE CLERK URL IS A FALLBACK AND NOT A DEFAULT. It is a third party's
 * address for an image the customer did not choose for this product; when
 * they upload one, theirs wins immediately and permanently.
 */
export function logoSrc(branding: unknown, options: { tenantSlug?: string } = {}): string | null {
  const parsed = parseBranding(branding);

  if (parsed.logoKey) {
    const params = new URLSearchParams();
    if (options.tenantSlug) params.set("t", options.tenantSlug);
    /*
     * The cache-buster. Without it a customer who replaces their logo
     * sees the old one until the browser's cache expires, reports it as
     * "the upload did not work", and uploads it again.
     */
    if (parsed.logoUpdatedAt) params.set("v", String(parsed.logoUpdatedAt));
    const query = params.toString();
    return query ? `${LOGO_ROUTE}?${query}` : LOGO_ROUTE;
  }

  if (parsed.logoUrl && /^https:\/\//i.test(parsed.logoUrl)) {
    /*
     * ⚠️ https ONLY, AND CHECKED HERE RATHER THAN TRUSTED. The column is
     * writable by three paths; a `javascript:` value reaching an `<img
     * src>` is inert, but the same value reaching an `<a href>` in a
     * later wave would not be, and the refusal belongs with the value.
     */
    return parsed.logoUrl;
  }

  return null;
}

/**
 * The wordmark shown when there is no logo, or when the logo fails to
 * load.
 *
 * ⚠️ THIS IS NOT A NICETY. Customers change R2 buckets, revoke Clerk
 * images and mistype domains, and an `<img>` that 404s renders as a
 * broken-image glyph or an empty box — in the SIDEBAR HEADER, which is
 * how a workspace tells you which workspace you are in. The fallback is
 * the workspace's name, always readable, and it is what the component
 * paints first and keeps if the image never arrives.
 */
export function wordmark(tenantName: string): string {
  const trimmed = tenantName.trim();
  return trimmed.length > 0 ? trimmed : "Workspace";
}
