/**
 * Ordence — Upload Byte Receiver (Cloudflare R2)
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE NARROWEST ROUTE IN THE APPLICATION, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * This is the only endpoint in Ordence that accepts a large, arbitrary
 * request body. Everything it is allowed to do is therefore decided
 * somewhere else and handed to it in a signed ticket: it chooses no path,
 * trusts no filename, writes no database row and grants no permission.
 *
 * It streams bytes to one key and returns how many landed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SIX CHECKS, IN THIS ORDER, ALL FAIL-CLOSED
 * ══════════════════════════════════════════════════════════════════════
 *   1. A live Clerk session (and an active tenant).
 *   2. A ticket that verifies against UPLOAD_TICKET_SECRET and has not
 *      expired.
 *   3. ⭐ The ticket's tenant equals the SESSION's tenant.
 *   4. The ticket's path sits inside that tenant's storage prefix.
 *   5. The declared Content-Type equals the one pinned in the ticket, and
 *      the declared Content-Length is within the ticket's ceiling.
 *   6. Nothing already exists at that key.
 *
 * ⭐ CHECK 3 IS THE ONE THAT MATTERS MOST and it is the one that is easy to
 * leave out, because checks 2 and 4 already look sufficient. They are not.
 * Without check 3, a ticket issued to tenant A remains a valid write
 * capability for tenant A's prefix in the hands of ANY logged-in user of ANY
 * tenant who obtains it — from a shared browser profile, a copied HAR file, a
 * proxy log. The signature proves the ticket is genuine; only this check
 * proves the person presenting it is the person it was issued to.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE SIZE IS CHECKED TWICE
 * ══════════════════════════════════════════════════════════════════════
 * `Content-Length` is a claim. It is checked first because refusing before
 * transferring 50 MB is kinder and cheaper. But it is not trusted: after the
 * write, R2 reports the size it actually stored, and if THAT exceeds the
 * ticket's ceiling the object is deleted again and the request fails. The
 * quota system bills against the second number, never the first.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import {
  isStorageConfigured,
  objectExists,
  putStoredObject,
  deleteStoredObject,
  STORAGE_UNCONFIGURED_MESSAGE,
} from "@/lib/storage/r2";
import { verifyUploadTicket, getTicketSecret } from "@/lib/storage/upload-ticket";
import { pathnameBelongsToTenant, isAllowedMimeType } from "@/lib/validators/storage";
import { peekAndSniff } from "@/lib/validators/peek-stream";
import { recordSecurityEvent } from "@/server/security/record";

// Node runtime: `requireTenantContext` queries PostgreSQL.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Header the browser presents the ticket in. */
const TICKET_HEADER = "x-ordence-upload-ticket";

/**
 * One refusal for every ticket problem.
 *
 * "Expired", "bad signature" and "wrong tenant" are three different sentences
 * that tell someone probing this endpoint three different things. They are
 * logged separately server-side and reported identically to the caller.
 */
function refuseTicket(): NextResponse {
  return NextResponse.json({ error: "This upload is no longer valid. Please try again." }, {
    status: 403,
  });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isStorageConfigured()) {
      return NextResponse.json({ error: STORAGE_UNCONFIGURED_MESSAGE }, { status: 503 });
    }

    const secret = getTicketSecret();
    if (!secret) {
      return NextResponse.json(
        { error: "File uploads are not configured for this deployment." },
        { status: 503 },
      );
    }

    /* ---- 1. SESSION ------------------------------------------------ */
    const ctx = await requireTenantContext();

    /* ---- 2. TICKET ------------------------------------------------- */
    const presented = request.headers.get(TICKET_HEADER);
    if (!presented) {
      return NextResponse.json({ error: "Missing upload ticket." }, { status: 400 });
    }

    const verified = await verifyUploadTicket(presented, secret);
    if (!verified.ok) {
      console.warn("[upload put] ticket refused", {
        reason: verified.reason,
        tenantId: ctx.tenant.id,
      });
      return refuseTicket();
    }

    const ticket = verified.payload;

    /* ---- 3. ⭐ THE TICKET MUST BELONG TO THIS SESSION --------------- */
    if (ticket.t !== ctx.tenant.id) {
      console.error("[upload put] cross-tenant ticket presented", {
        sessionTenantId: ctx.tenant.id,
        ticketTenantId: ticket.t,
      });

      /**
       * ⭐⭐⭐ WAVE 9 — THIS IS THE EVENT `tenant.cross_access_attempt`
       * WAS DECLARED FOR, AND THIS SURFACE ONLY WROTE A CONSOLE LINE.
       *
       * The catalogue says of this type: *"If this ever fires in
       * production it is either an attack or a bug in our scoping, and
       * both are page-someone events."* A `console.error` is not a page.
       * It is a line in Railway's log stream that nobody reads unless
       * they are already looking, which means the one condition the file
       * header calls the reason this check exists produced no alert.
       *
       * ⚠️ AWAITED, NOT FIRE-AND-FORGET. The refusal is cheap and the
       * event is `critical`; returning before the write means an attacker
       * who can make the process exit mid-request also decides whether
       * the attempt was recorded.
       */
      await recordSecurityEvent({
        type: "tenant.cross_access_attempt",
        tenantId: ctx.tenant.id,
        source: "api/upload/put",
        subjectType: "upload_ticket",
        /** The PATH the ticket authorised. Never the ticket itself. */
        subjectId: ticket.p.slice(0, 200),
        actorUserId: ctx.user.id,
        route: "/api/upload/put",
        detail: {
          sessionTenantId: ctx.tenant.id,
          ticketTenantId: ticket.t,
          contentType: ticket.ct,
        },
        reason: "An upload ticket issued to one workspace was presented by another.",
      });

      return refuseTicket();
    }

    /* ---- 4. THE PATH MUST BE INSIDE OUR PREFIX ---------------------
     *
     * Redundant in every expected case: `/api/upload` built this path from
     * this tenant's id and signed it. It is here for the unexpected one —
     * a signing bug, or a secret shared between environments — where every
     * check above would pass honestly and this is the last thing standing
     * between a valid ticket and another tenant's namespace.
     */
    if (!pathnameBelongsToTenant(ticket.p, ctx.tenant.id)) {
      console.error("[upload put] refusing out-of-tenant path", {
        tenantId: ctx.tenant.id,
        pathname: ticket.p,
      });
      return refuseTicket();
    }

    /* ---- 5. CONTENT TYPE AND DECLARED SIZE -------------------------
     *
     * The allowlist is re-applied to the ticket's own value rather than
     * trusted from it. A ticket is only as good as the code that signed it,
     * and this costs one array lookup.
     */
    if (!isAllowedMimeType(ticket.ct)) {
      return NextResponse.json({ error: "That file type is not permitted." }, { status: 415 });
    }

    const declaredType = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (declaredType !== ticket.ct) {
      return NextResponse.json(
        { error: "This upload does not match the file it was authorised for." },
        { status: 415 },
      );
    }

    const declaredLength = Number(request.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
      return NextResponse.json({ error: "A Content-Length header is required." }, { status: 411 });
    }
    if (declaredLength > ticket.mb) {
      return NextResponse.json({ error: "That file is larger than allowed." }, { status: 413 });
    }

    /* ---- 6. NO OVERWRITES ------------------------------------------
     *
     * The path carries a millisecond timestamp, so a collision means either
     * a replayed ticket or a genuine race. Both must fail: silently
     * replacing an executed agreement's bytes is the worst outcome this
     * route could produce.
     */
    if (await objectExists(ticket.p)) {
      return NextResponse.json({ error: "That file has already been uploaded." }, { status: 409 });
    }

    if (!request.body) {
      return NextResponse.json({ error: "Empty upload." }, { status: 400 });
    }

    /* ---- 6b. ⭐ WHAT THE BYTES ACTUALLY ARE — v0.67.0 ---------------
     *
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ EVERY CHECK UNTIL NOW HAS READ A STRING THE CLIENT WROTE.
     * ══════════════════════════════════════════════════════════════════
     * The allowlist, the pinned ticket type, the Content-Type header
     * comparison above — all three are rigorous, and all three verify
     * that the attacker told the same lie twice. `text/html` and
     * `image/svg+xml` are excluded from the allowlist precisely because
     * they can carry script; uploading an HTML file that CLAIMS to be
     * `application/pdf` walks past all of it.
     *
     * This is the first check that looks at the file.
     *
     * ⚠️ IT PEEKS, IT DOES NOT BUFFER. The body stays a stream — a 50 MB
     * `arrayBuffer()` inside a Worker with a 128 MB ceiling is a
     * self-inflicted outage under any concurrency at all, which is why
     * the write below pipes. `peekAndSniff` reads only far enough to
     * answer, then hands back a stream that replays what it consumed.
     *
     * ⚠️ IT REFUSES BEFORE THE WRITE, NOT AFTER. Storing the object and
     * deleting it on a bad verdict would leave a window — however short —
     * in which a script file exists at a path that has already been
     * returned to the caller.
     */
    const { verdict, stream } = await peekAndSniff(request.body, ticket.ct);

    if (!verdict.ok) {
      console.warn("[upload put] refused on content inspection", {
        tenantId: ctx.tenant.id,
        pathname: ticket.p,
        declared: ticket.ct,
        reason: verdict.reason,
      });

      /**
       * ⭐⭐ WAVE 9 — `upload.rejected` HAD NEVER BEEN EMITTED EITHER.
       *
       * ⚠️ EMITTED HERE AND NOT AT THE ALLOWLIST CHECKS ABOVE, WHICH IS
       * THE WHOLE POINT OF THE DISTINCTION. Every refusal before this one
       * caught a client that ASKED for something not permitted — a
       * mistake, a stale page, an unsupported file. This one caught a
       * client whose bytes do not match what it declared them to be,
       * twice, in two places it had to keep consistent. That is not a
       * mistake; the only way to produce it is to try.
       *
       * A row for every 415 would bury that signal under ordinary
       * user error, which is how a security table stops being read.
       */
      await recordSecurityEvent({
        type: "upload.rejected",
        tenantId: ctx.tenant.id,
        source: "api/upload/put",
        subjectType: "upload",
        subjectId: ticket.p.slice(0, 200),
        actorUserId: ctx.user.id,
        route: "/api/upload/put",
        detail: {
          declaredContentType: ticket.ct,
          verdict: verdict.reason,
          declaredBytes: declaredLength,
        },
        reason: "Upload contents did not match the declared file type.",
      });

      return NextResponse.json({ error: verdict.detail }, { status: 415 });
    }

    /* ---- 7. WRITE --------------------------------------------------
     *
     * The body is PIPED, not buffered. A 50 MB `arrayBuffer()` inside a
     * Worker with a 128 MB memory ceiling is a self-inflicted outage under
     * any concurrency at all.
     */
    /*
     * ⚠️ `declaredLength` IS PASSED THROUGH — v0.71.0, for the S3 backend.
     *
     * The R2 binding accepted a stream of unknown length. A signed S3 PUT
     * does not: SigV4 needs a `Content-Length`, and without one the
     * request is refused — or, on some stacks, the whole body is silently
     * buffered into memory to compute it, which is a 50 MB allocation per
     * concurrent upload.
     *
     * This value has already been validated against the ticket's ceiling
     * above, and step 8 below re-reads the size that ACTUALLY landed, so
     * an understated length is caught there and the object removed. The
     * claim is used to sign; it is never used to bill.
     */
    const stored = await putStoredObject(ticket.p, stream, ticket.ct, declaredLength);

    if (!stored) {
      return NextResponse.json({ error: STORAGE_UNCONFIGURED_MESSAGE }, { status: 503 });
    }

    /* ---- 8. THE SIZE THAT ACTUALLY LANDED --------------------------
     *
     * See the header note. If the real object exceeds the ceiling the
     * ticket authorised, it does not get to stay — and the client is told,
     * so it does not go on to write a document row for bytes we removed.
     */
    if (stored.size > ticket.mb) {
      console.warn("[upload put] stored object exceeded ticket ceiling; removing", {
        tenantId: ctx.tenant.id,
        pathname: ticket.p,
        storedSize: stored.size,
        ceiling: ticket.mb,
      });
      try {
        await deleteStoredObject(ticket.p);
      } catch (err) {
        console.error("[upload put] failed to remove oversized object", err);
      }
      return NextResponse.json({ error: "That file is larger than allowed." }, { status: 413 });
    }

    return NextResponse.json({
      pathname: ticket.p,
      sizeBytes: stored.size,
      contentType: ticket.ct,
      /**
       * A locator, NOT an address.
       *
       * `documents.file_url` is a required column that has always held
       * something that could not simply be handed to a browser (the Vercel
       * blob URL was private too). An `r2://` scheme makes that explicit:
       * there is no HTTPS address for this object, and anyone who finds this
       * string in a log or an export learns nothing they can fetch.
       */
      url: `r2://ordence-documents/${ticket.p}`,
    });
  } catch (err) {
    if (err instanceof TenantAccessError) {
      const status = err.code === "unauthenticated" ? 401 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }

    console.error("[upload put]", err);
    return NextResponse.json({ error: "Could not store that file." }, { status: 500 });
  }
}

/** One verb only. See the note on `/api/upload`. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
