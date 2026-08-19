/**
 * Ordence — Authenticated Document Download
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS ROUTE IS WHAT MAKES A PRIVATE BUCKET USABLE
 * ══════════════════════════════════════════════════════════════════════
 * Files live in a Cloudflare R2 bucket with no public URL and no `r2.dev`
 * access, so there is no address for them that anyone could fetch. That is
 * the correct default for executed legal agreements — but it means the
 * browser cannot simply link to the object, and something has to stand in
 * between.
 *
 * This is that something. On every single request it:
 *
 *   1. re-derives the session and tenant from the Clerk cookie
 *   2. loads the document row scoped to that tenant (RLS applies too)
 *   3. confirms the stored path sits inside the tenant's storage prefix
 *   4. streams the bytes back
 *
 * There is no token in the URL, nothing to forward, and nothing that keeps
 * working after someone leaves the organisation. A stale link fails.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY STREAMING THROUGH A WORKER IS ACCEPTABLE HERE
 * ══════════════════════════════════════════════════════════════════════
 * Response size is not capped, and the body is PIPED from R2 rather than
 * buffered, so Worker memory stays flat regardless of file size.
 *
 * It costs Worker CPU and duration — but R2 charges NO EGRESS FEE, which is
 * the single biggest cost improvement in this migration and the reason
 * proxying every byte is affordable rather than merely correct.
 *
 * If throughput ever becomes the constraint, the fix is short-lived R2
 * presigned URLs issued after these same checks — the checks do not change,
 * only what gets returned.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  getStoredObject,
  isStorageConfigured,
  STORAGE_UNCONFIGURED_MESSAGE,
} from "@/lib/storage/r2";
import { and, eq, isNull } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { documents } from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { pathnameBelongsToTenant, sanitizeFileName } from "@/lib/validators/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
  try {
    const { id } = await context.params;

    // A malformed id is refused before it reaches the database. Postgres
    // raises 22P02 on a bad uuid cast, which would surface as a 500 and
    // read like a server fault rather than a bad request.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // ---- 1. SESSION AND TENANT ------------------------------------
    const ctx = await requireTenantContext();

    // ---- 2. THE ROW, SCOPED TO THIS TENANT ------------------------
    /**
     * ⚠️ SCOPED, NOT MERELY FILTERED. The `eq(tenantId)` predicate below
     * is correct and was never the whole story: under a database role
     * that does not bypass RLS this ran with no session variable, so the
     * policy matched nothing and every download 404'd. The filter and
     * the policy now agree instead of one standing in for the other.
     */
    const doc = await withTenant(ctx.tenant.id, (tx) =>
      tx.query.documents.findFirst({
        where: and(
          eq(documents.id, id),
          eq(documents.tenantId, ctx.tenant.id),
          isNull(documents.deletedAt),
        ),
      }),
    );

    // 404, not 403. A different status for "exists but not yours" would
    // turn this endpoint into an oracle for which document ids are real.
    if (!doc) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // ---- 3. THE PATH MUST BE INSIDE OUR PREFIX --------------------
    // The row already passed RLS, so this is redundant in every expected
    // case. It is here for the unexpected one: a row whose pathname was
    // tampered with would otherwise let us stream another tenant's object
    // while every check above passed honestly.
    if (!pathnameBelongsToTenant(doc.blobPathname, ctx.tenant.id)) {
      console.error("[download] refusing out-of-tenant object", {
        tenantId: ctx.tenant.id,
        documentId: doc.id,
      });
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    if (!isStorageConfigured()) {
      return NextResponse.json({ error: STORAGE_UNCONFIGURED_MESSAGE }, { status: 503 });
    }

    // ---- 4. STREAM ------------------------------------------------
    const result = await getStoredObject(doc.blobPathname);

    if (!result) {
      // The row says the file exists; storage disagrees. Report it rather
      // than returning an empty 200 that looks like a corrupt download.
      console.error("[download] object missing in storage", {
        documentId: doc.id,
        pathname: doc.blobPathname,
      });
      return NextResponse.json(
        { error: "This file is no longer available in storage." },
        { status: 410 },
      );
    }

    // `attachment` forces a download rather than inline rendering. That is
    // a security decision as much as a UX one: rendering an uploaded file
    // inline on our own origin is how a crafted document becomes a
    // same-origin script. Combined with `X-Content-Type-Options: nosniff`,
    // the browser will neither sniff a different type nor execute it here.
    const safeName = sanitizeFileName(doc.fileName);

    const headers = new Headers();
    headers.set("Content-Type", doc.mimeType);
    headers.set(
      "Content-Disposition",
      // Both forms: `filename` for old clients, `filename*` (RFC 5987) so
      // non-ASCII names survive. The bare form is the sanitised ASCII one,
      // which is also why it cannot break out of the quotes.
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
    );
    // ⚠️ R2's size, not the database's. The row records what was uploaded;
    // only storage knows what is actually there. A Content-Length that does
    // not match the body is a truncated or hung download in every browser.
    headers.set("Content-Length", String(result.size));
    headers.set("X-Content-Type-Options", "nosniff");
    // Never cached by a shared cache. These bytes are tenant-scoped and a
    // CDN has no way to know that.
    headers.set("Cache-Control", "private, no-store, max-age=0");

    return new Response(result.body, { status: 200, headers });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.code === "unauthenticated" ? 401 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }

    console.error("[download]", err);
    return NextResponse.json({ error: "Could not retrieve that file." }, { status: 500 });
  }
}
