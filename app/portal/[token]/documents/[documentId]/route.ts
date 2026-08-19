/**
 * Ordence — Portal Document Download
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS RATHER THAN REUSING THE INTERNAL DOWNLOAD ROUTE
 * ══════════════════════════════════════════════════════════════════════
 * `/api/documents/[id]/download` already streams a private blob after
 * checking session and tenant. Reusing it here was the obvious move and it
 * is the wrong one.
 *
 * That route authenticates with `requireTenantContext()` — a Clerk
 * session. A portal visitor has none. Making it *also* accept a portal
 * token would mean the endpoint every authenticated user relies on now has
 * a second, weaker way in, and any future mistake in the token path would
 * become a mistake in the internal path too.
 *
 * So the portal gets its own route with its own credential. Two doors,
 * each with one lock, instead of one door with two.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS CHECKED, IN ORDER, ON EVERY REQUEST
 * ══════════════════════════════════════════════════════════════════════
 *   1. The token resolves — well-formed, exists, active, unexpired,
 *      tenant still active
 *   2. The document belongs to the SAME TENANT the token resolved to
 *   3. The document is attached to the EXACT record the link points at
 *
 * Step 3 is the one that is easy to miss and the one that matters most.
 * Without it, a client holding a valid link to their own ₹5 lakh purchase
 * order could pass any other document id from the same tenant and read it
 * — every other check would pass honestly. A portal link grants access to
 * ONE record, not to a workspace.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  getStoredObject,
  isStorageConfigured,
  STORAGE_UNCONFIGURED_MESSAGE,
} from "@/lib/storage/r2";
import { and, eq, isNull } from "drizzle-orm";
import { documents } from "@/db/schema";
import {
  resolvePortalToken,
  withPortalTenant,
  getVisitorFacts,
  writePortalAudit,
} from "@/server/portal-context";
import { pathnameBelongsToTenant, sanitizeFileName } from "@/lib/validators/storage";
import {
  checkRateLimit,
  portalRateLimitKey,
  portalSourceRateLimitKey,
} from "@/lib/security/rate-limit";
import { recordSecurityEvent } from "@/server/security/record";
import { portalTokenRef } from "@/lib/portal/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One response for every failure. See the portal page for the reasoning. */
function refuse(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string; documentId: string }> },
): Promise<NextResponse | Response> {
  try {
    const { token, documentId } = await context.params;

    // A malformed uuid is refused before the database sees it. Postgres
    // raises 22P02 on a bad cast, which would surface as a 500 and read
    // like a server fault rather than a bad request.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        documentId,
      )
    ) {
      return refuse();
    }

    // ---- 0. RATE LIMIT (SEC-020) --------------------------------------
    // Same two-key reasoning as the portal page. This endpoint streams
    // file bytes, so an unthrottled enumerator costs bandwidth as well
    // as invocations.
    const downloadIp =
      _request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    const [byToken, bySource] = await Promise.all([
      checkRateLimit("portal", await portalRateLimitKey(token, downloadIp)),
      checkRateLimit("portal", portalSourceRateLimitKey(downloadIp)),
    ]);

    if (!byToken.allowed || !bySource.allowed) {
      await recordSecurityEvent({
        type: "rate_limit.exceeded",
        source: "portal_download",
        ipAddress: downloadIp,
        subjectType: "portal_token_ref",
        // ⭐ WAVE 9 — the hash reference, not a credential fragment, and
        // the same key `detectPortalTokenSharing` groups on. See the note
        // in `lib/portal/tokens.ts#portalTokenRef`.
        subjectId: portalTokenRef(token),
        detail: { policy: "portal", scope: byToken.allowed ? "source" : "token" },
        reason: "Portal download rate limit exceeded.",
      });
      // `refuse()` is the same opaque response every other failure in
      // this route returns. No new oracle.
      return refuse();
    }

    // ---- 1. THE TOKEN -------------------------------------------------
    const resolution = await resolvePortalToken(token);

    if (!resolution.ok) {
      console.warn("[portal download] refused — token invalid", {
        reason: resolution.reason,
      });
      return refuse();
    }

    const { link, tenantId } = resolution;

    // ---- 2 & 3. THE DOCUMENT, TENANT-PINNED AND RECORD-PINNED ---------
    const doc = await withPortalTenant(tenantId, async (tx) => {
      const row = await tx.query.documents.findFirst({
        where: and(
          eq(documents.id, documentId),
          eq(documents.tenantId, tenantId),
          // ⭐ The document must hang off the record THIS LINK points at.
          // Without these two predicates, any document in the tenant would
          // be reachable with a valid link to any other record.
          eq(documents.entityType, link.entityType),
          eq(documents.entityId, link.entityId),
          isNull(documents.deletedAt),
        ),
      });
      return row ?? null;
    });

    if (!doc) {
      console.warn("[portal download] refused — document not attached to this link", {
        linkId: link.id,
        documentId,
      });
      return refuse();
    }

    // Defence in depth: even a row that passed every check must point
    // inside this tenant's storage prefix before we stream any bytes.
    if (!pathnameBelongsToTenant(doc.blobPathname, tenantId)) {
      console.error("[portal download] refusing out-of-tenant object", {
        tenantId,
        documentId,
      });
      return refuse();
    }

    if (!isStorageConfigured()) {
      // Deliberately NOT `STORAGE_UNCONFIGURED_MESSAGE`. That sentence names
      // our infrastructure and tells an external counterparty how to file a
      // useful bug report against us; it belongs in the operator-facing
      // routes, not on a portal a stranger can reach. The real reason is in
      // the log line below.
      console.error("[portal download] storage unbound:", STORAGE_UNCONFIGURED_MESSAGE);
      return NextResponse.json(
        { error: "This document is temporarily unavailable." },
        { status: 503 },
      );
    }

    const facts = await getVisitorFacts();

    // Every external download is recorded. "Did they ever actually open
    // the annexure?" is a question that gets asked after a dispute.
    await writePortalAudit({
      tenantId,
      action: "read",
      resourceType: "document",
      resourceId: doc.id,
      severity: "info",
      portalLinkId: link.id,
      actorEmail: link.recipientEmail,
      facts,
      metadata: {
        event: "portal_document_downloaded",
        fileName: doc.fileName,
        entityType: link.entityType,
        entityId: link.entityId,
      },
    });

    // ---- 4. STREAM ----------------------------------------------------
    const result = await getStoredObject(doc.blobPathname);

    if (!result) {
      console.error("[portal download] object missing in storage", {
        documentId: doc.id,
      });
      return NextResponse.json(
        { error: "This document is no longer available." },
        { status: 410 },
      );
    }

    const safeName = sanitizeFileName(doc.fileName);
    const headers = new Headers();

    headers.set("Content-Type", doc.mimeType);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
    );
    // R2's size, not the database's — see the note in the internal
    // download route. A mismatched Content-Length truncates the download.
    headers.set("Content-Length", String(result.size));

    // `attachment` + `nosniff` together: an uploaded file must never be
    // rendered inline on our own origin, where it would become
    // same-origin script.
    headers.set("X-Content-Type-Options", "nosniff");

    // Never cached by a shared cache. These bytes are tenant-scoped and
    // reachable only with a token that can be revoked at any moment.
    headers.set("Cache-Control", "private, no-store, max-age=0");

    // The URL contains a live credential. Without this, following any link
    // out of a downloaded HTML file would leak the token in a `Referer`
    // header to a third-party server.
    headers.set("Referrer-Policy", "no-referrer");

    return new Response(result.body, { status: 200, headers });
  } catch (err) {
    console.error("[portal download]", err);
    return refuse();
  }
}
