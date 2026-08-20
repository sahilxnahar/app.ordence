/**
 * Ordence , The tenant logo, by hostname
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONLY SESSION-LESS READ OF THE OBJECT STORE IN THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * Every other file is reached through `/api/documents/[id]/download`,
 * which re-derives the Clerk session on each request. That is correct
 * for an executed contract and impossible for a logo, because the logo
 * has to appear on the SIGN-IN PAGE at `companyname.ordence.com` , where
 * there is no session and the tenant is known only from the hostname.
 *
 * The decisions this route makes, and each one's refusal:
 *
 *   1. WHICH TENANT , from the hostname via `resolveTenantFromHost()`,
 *      the same pure resolver `middleware.ts` uses. Not from a header,
 *      not from a query parameter. No subdomain and no session → 404.
 *   2. WHICH OBJECT , `branding.logoKey` from that tenant's row. There
 *      is no key parameter. A caller cannot ask for a different object.
 *   3. WHETHER THAT KEY IS THEIRS , `pathnameBelongsToTenant()`, which
 *      also refuses `..`. The action already refused a foreign key on
 *      the way in; this refuses it again on the way out, because a value
 *      validated once is only as trustworthy as everything that could
 *      have written it since.
 *
 * ⚠️ A MISS IS A 404 AND NOT AN ERROR. No logo, no tenant, no object,
 * storage unconfigured , all 404. The component behind this renders the
 * workspace's name instead, so the failure is invisible to the user and
 * silent in the log, which is what it should be for an image.
 */

import { NextResponse, type NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenants } from "@/db/schema";
import { resolveTenantFromHost } from "@/lib/tenant";
import { getStoredObject, isStorageConfigured } from "@/lib/storage/r2";
import { pathnameBelongsToTenant } from "@/lib/validators/storage";
import { servableLogoKey } from "@/lib/branding/logo";
import { getTenantContext } from "@/server/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readRuntimeEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const NOT_FOUND = () => new NextResponse(null, { status: 404 });

export async function GET(request: NextRequest): Promise<Response> {
  if (!isStorageConfigured()) return NOT_FOUND();

  const locator = resolveTenantFromHost(
    request.headers.get("host"),
    readRuntimeEnv("NEXT_PUBLIC_ROOT_DOMAIN") ?? "localhost:3000",
    { zoneDomain: readRuntimeEnv("NEXT_PUBLIC_ZONE_DOMAIN") },
  );

  let tenantId: string | null = null;
  let branding: unknown = null;

  if (locator.kind === "subdomain") {
    /*
     * ⚠️ PLATFORM SCOPE, AND IT IS THE RIGHT CALL HERE FOR THE SAME
     * REASON `requireTenantContext` USES IT: this asks "which workspace
     * is at this hostname" BEFORE any workspace is known, which is by
     * definition a question no single workspace can answer. The SELECT
     * is pinned to one slug and returns two columns.
     */
    const row = await withPlatformScope(
      "Resolving which workspace is at this hostname so its logo can be served on a " +
        "sign-in page, where by definition no session and no tenant scope exist yet.",
      (tx) =>
      tx.query.tenants.findFirst({
        where: and(eq(tenants.slug, locator.slug), isNull(tenants.deletedAt)),
        columns: { id: true, branding: true },
      }),
    );
    if (row) {
      tenantId = row.id;
      branding = row.branding;
    }
  } else {
    /*
     * The canonical app host has no tenant in it, so the CRM shell on
     * `app.ordence.com` falls back to the session. Signed out on a host
     * with no subdomain there is nothing to serve, and nothing is.
     */
    const ctx = await getTenantContext();
    if (ctx) {
      tenantId = ctx.tenant.id;
      branding = ctx.tenant.branding;
    }
  }

  if (!tenantId) return NOT_FOUND();

  const key = servableLogoKey(branding, tenantId, pathnameBelongsToTenant);
  if (!key) return NOT_FOUND();

  const object = await getStoredObject(key);
  if (!object) return NOT_FOUND();

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      /*
       * 🔴 `private`, NEVER `public`. This response varies by hostname;
       * a shared cache that keyed it wrongly even once would serve one
       * workspace's logo on another workspace's login page.
       */
      "cache-control": "private, max-age=300, must-revalidate",
      "x-content-type-options": "nosniff",
      /*
       * The stored type is already constrained to four raster formats
       * by the upload allowlist. `Content-Disposition: inline` with
       * `nosniff` means a file that somehow got past that renders as a
       * download rather than as a document in this origin.
       */
      "content-disposition": "inline",
    },
  });
}
