/**
 * Ordence — Upload Ticket Issuer (Cloudflare R2)
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT CHANGED FROM THE VERCEL BLOB VERSION, AND WHAT DID NOT
 * ══════════════════════════════════════════════════════════════════════
 * WHAT CHANGED: this route no longer mints a Vercel Blob client token, and
 * the browser no longer uploads to a third party. It issues a SIGNED TICKET
 * (lib/storage/upload-ticket.ts) and the browser PUTs the bytes to
 * `/api/upload/put`, which streams them into R2.
 *
 * WHAT DID NOT CHANGE: every decision this route made still gets made here,
 * at the same moment, on the same evidence. The five things it decides — and
 * which the client still cannot alter — are unchanged:
 *
 *   1. WHETHER there is a valid Clerk session at all       (else 401)
 *   2. WHICH TENANT the caller belongs to — derived from the session,
 *      never read from the request                          (§ pathname)
 *   3. WHERE the object may be written — a path prefixed with that
 *      tenant's id, rebuilt server-side from a sanitised filename
 *   4. WHAT content type is permitted                       (allowlist)
 *   5. HOW LARGE the object may be                          (50 MB)
 *
 * The single most important line in this file is still that the pathname is
 * REBUILT here rather than taken from the client. If we honoured a
 * client-supplied path, a caller could request
 * `tenants/<someone-else>/contract/.../x.pdf` and write into another
 * tenant's namespace with a perfectly valid ticket.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE CONSTRAINTS ARE SIGNED RATHER THAN REMEMBERED
 * ══════════════════════════════════════════════════════════════════════
 * Vercel Blob enforced `allowedContentTypes` and `maximumSizeInBytes`
 * itself, because it held the token. Nothing external holds anything now, so
 * the constraints must survive the round trip to the browser and come back
 * intact. Signing them is what makes "the browser is carrying our security
 * decisions" acceptable: it can carry them, it cannot edit them.
 *
 * A server-side store (KV, the database) would also work and would allow
 * single-use tickets. It is not used because it adds a write and a read to
 * every upload, plus a binding, in exchange for closing a replay window that
 * the overwrite refusal already closes — a replayed ticket can only attempt
 * to write a key that now exists, and is refused with 409.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY FILES STAY PRIVATE
 * ══════════════════════════════════════════════════════════════════════
 * The R2 bucket has no public URL and no `r2.dev` access. A public object URL
 * is readable by anyone who ever sees it — forever, with no session, no
 * tenant check and no audit trail. For a CRM holding executed legal
 * agreements that is not an acceptable default, and no amount of Row-Level
 * Security on the metadata table compensates, because the bytes are not in
 * PostgreSQL.
 *
 * Reads therefore go through `/api/documents/[id]/download`, which re-checks
 * session and tenant on every single request.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import {
  checkRateLimit,
  tenantRateLimitKey,
  rateLimitBody,
  rateLimitHeaders,
} from "@/lib/security/rate-limit";
import { recordRateLimitTrip } from "@/server/security/record";
import { requireQuota, QuotaExceededError } from "@/server/metering/query";
import { isStorageConfigured, STORAGE_UNCONFIGURED_MESSAGE } from "@/lib/storage/r2";
import { signUploadTicket, getTicketSecret, TICKET_TTL_MS } from "@/lib/storage/upload-ticket";
import {
  uploadClientPayloadSchema,
  buildBlobPathname,
  isAllowedMimeType,
  MAX_FILE_BYTES,
} from "@/lib/validators/storage";

// Node runtime: `requireTenantContext` queries PostgreSQL and the metering
// gate reads it too. Neither belongs on the Edge.
export const runtime = "nodejs";

// Never cached. A ticket is per-user, per-file and short-lived; a cached one
// handed to a second user would be a capability leak.
export const dynamic = "force-dynamic";

/** Where the browser sends the bytes once it holds a ticket. */
const UPLOAD_PUT_PATH = "/api/upload/put";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  try {
    /* ---- 1. THERE MUST BE A VALID SESSION --------------------------
     *
     * `requireTenantContext()` re-derives everything from the Clerk session
     * cookie: it throws `TenantAccessError` when the caller is
     * unauthenticated, has no organisation, belongs to a tenant that is
     * inactive, or is a suspended user.
     *
     * This is the second of three independent layers. `middleware.ts`
     * already refused anyone without a session and an active organisation
     * before the request reached this file; this call re-derives the tenant
     * from the session rather than trusting any header the middleware set,
     * because a header is only as trustworthy as everything that can write
     * one.
     */
    const ctx = await requireTenantContext();

    /* ---- 1a. ⭐ ONLY NOW: IS STORAGE ACTUALLY CONFIGURED? ----------
     *
     * ══════════════════════════════════════════════════════════════
     * 🔴 THESE TWO CHECKS USED TO RUN *BEFORE* AUTHENTICATION.
     * ══════════════════════════════════════════════════════════════
     * That ordering leaked deployment state to strangers. Anyone at all
     * — no session, no organisation, no account — could POST to
     * `/api/upload` and read back one of two distinct 503 messages:
     * "the bucket does not exist" or "UPLOAD_TICKET_SECRET is not set".
     * Two different sentences, so the probe distinguished them, and both
     * describe internal infrastructure to somebody with no right to ask.
     *
     * It also made nineteen tests fail for a misleading reason. They
     * asserted 401 for no session and 403 for a suspended user, and got
     * 503 every time — because the request never reached the auth check
     * at all. The tests were right; the route was wrong.
     *
     * ⚠️ THE RULE: ESTABLISH WHO IS ASKING BEFORE EXPLAINING ANYTHING.
     * A misconfiguration is a message for the operator, not a fact owed
     * to an anonymous caller. `requireTenantContext()` above throws for
     * every unauthenticated case, so by this line the caller is a known
     * user of a known active tenant — and telling THEM why uploads are
     * unavailable is help rather than disclosure.
     *
     * The two remain separate because the remedies differ: one is
     * "create the bucket", the other is "set the secret".
     */
    if (!isStorageConfigured()) {
      return NextResponse.json(
        { error: STORAGE_UNCONFIGURED_MESSAGE },
        { status: 503 },
      );
    }

    const ticketSecret = getTicketSecret();
    if (!ticketSecret) {
      return NextResponse.json(
        {
          error:
            "File uploads are not configured for this deployment. " +
            "Set UPLOAD_TICKET_SECRET (at least 32 characters) and redeploy.",
        },
        { status: 503 },
      );
    }

    /* ---- 1b. RATE LIMIT (SEC-005) ----------------------------------
     *
     * This endpoint mints a write capability. Each one is a licence to
     * upload a file, so an unthrottled caller with a valid session can mint
     * them in a loop and fill the bucket — a cost attack that needs no
     * vulnerability at all, only patience.
     *
     * Keyed by TENANT AND USER. The tenant prefix is mandatory: a key built
     * from the user id alone would let two tenants collide, so one
     * customer's activity could throttle another's.
     */
    const uploadLimit = await checkRateLimit(
      "upload",
      tenantRateLimitKey(ctx.tenant.id, ctx.user.id),
    );
    if (!uploadLimit.allowed) {
      await recordRateLimitTrip({
        policy: "upload",
        source: "api/upload",
        tenantId: ctx.tenant.id,
        actorUserId: ctx.user.id,
        route: "/api/upload",
        degraded: uploadLimit.degraded,
      });
      return NextResponse.json(rateLimitBody(), {
        status: 429,
        headers: rateLimitHeaders(uploadLimit, { authenticated: true }),
      });
    }

    /* ---- 2. THE CLIENT PAYLOAD IS UNTRUSTED INPUT ------------------ */
    const payload = uploadClientPayloadSchema.parse(rawBody);

    /* ---- 2b. CONTENT TYPE ALLOWLIST --------------------------------
     *
     * ⚠️ THIS CHECK MOVED, AND MOVING IT WAS THE RISK IN THIS MIGRATION.
     *
     * Under Vercel Blob the allowlist was handed to the storage provider as
     * `allowedContentTypes` and enforced by them. Nobody enforces it for us
     * any more, so it is enforced HERE and pinned into the ticket, and
     * `/api/upload/put` refuses any request whose Content-Type differs from
     * the pinned one.
     *
     * `text/html` and `image/svg+xml` are absent from the allowlist for the
     * reason given in lib/validators/storage.ts: both can carry script, and
     * a file served from an origin a user is logged into becomes stored XSS.
     */
    if (!isAllowedMimeType(payload.contentType)) {
      return NextResponse.json({ error: "That file type is not permitted." }, { status: 415 });
    }

    /* ---- 2c. STORAGE QUOTA (Phase 15) ------------------------------
     *
     * ⚠️ Checked against the CLIENT-DECLARED size, which is the only figure
     * available before the bytes exist. A caller could understate it to slip
     * past the quota — so this is a courtesy gate, not the enforcement
     * point. The real reservation happens in `saveDocumentRecord()` against
     * the size R2 actually stored, and the ticket carries a hard byte
     * ceiling that `/api/upload/put` enforces against the stored object.
     *
     * The value of checking here anyway: an honest customer who is out of
     * space is told BEFORE they wait for a 40 MB upload to finish and then
     * fail. Refusing after the transfer is the same outcome delivered
     * rudely.
     *
     * ⚠️ Gates the UPLOAD only. Never a delete, a download or an export — a
     * customer at their limit must always be able to free space and to leave
     * with their data.
     */
    try {
      await requireQuota(ctx.tenant.id, "storage_bytes", BigInt(payload.sizeBytes));
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        // 413 rather than 402: the request is too large for the space
        // available, which is what the status means. A 402 would imply the
        // account is unpaid, which it may not be.
        return NextResponse.json({ error: err.message }, { status: 413 });
      }
      throw err;
    }

    /* ---- 3. THE PATH IS OURS, NOT THEIRS ---------------------------
     *
     * Nothing the client sent contributes to placement except the FILENAME,
     * and that is sanitised. The tenant id comes from the verified session,
     * so a caller cannot steer the object into another tenant's prefix or
     * traverse out of it with `../`.
     */
    const blobPathname = buildBlobPathname({
      tenantId: ctx.tenant.id,
      entityType: payload.entityType,
      entityId: payload.entityId,
      fileName: payload.fileName,
      now: Date.now(),
    });

    /**
     * The ceiling is the smaller of the global maximum and what the client
     * said it would send. A client that understated its size has only
     * constrained itself; one that overstated it is still capped at 50 MB.
     */
    const maxBytes = Math.min(MAX_FILE_BYTES, payload.sizeBytes);

    /* ---- 4. SIGN ---------------------------------------------------
     *
     * The ticket is good for ten minutes. Long enough for a slow connection
     * to finish a 50 MB file, short enough that a ticket captured from a log
     * is not a durable write capability.
     */
    const expiresAt = Date.now() + TICKET_TTL_MS;

    const ticket = await signUploadTicket(
      {
        p: blobPathname,
        ct: payload.contentType,
        mb: maxBytes,
        t: ctx.tenant.id,
        u: ctx.user.id,
        exp: expiresAt,
      },
      ticketSecret,
    );

    return NextResponse.json({
      uploadUrl: UPLOAD_PUT_PATH,
      ticket,
      pathname: blobPathname,
      expiresAt,
      maxBytes,
    });
  } catch (err) {
    /* ---- FAIL CLOSED, AND SAY AS LITTLE AS POSSIBLE ----------------
     *
     * A refusal must not double as a reconnaissance tool. "No tenant with
     * that id" and "you are not a member of that tenant" are different
     * sentences that tell an attacker different things; both become 403.
     */
    if (err instanceof TenantAccessError) {
      const status = err.code === "unauthenticated" ? 401 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }

    console.error("[upload ticket]", err);
    return NextResponse.json({ error: "Could not authorise this upload." }, { status: 400 });
  }
}

/**
 * Anything other than POST is refused explicitly.
 *
 * Without this, Next.js returns 405 for undefined methods, which is fine —
 * but being explicit documents that this endpoint has exactly one verb, and
 * makes a future accidental `GET` handler a deliberate act.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
