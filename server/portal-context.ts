import "server-only";

/**
 * Ordence — Portal Token Resolution
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURAL PROBLEM THIS FILE SOLVES
 * ══════════════════════════════════════════════════════════════════════
 * Every security layer built in Phases 1–8 derives the tenant FROM THE
 * CLERK SESSION:
 *
 *     middleware → requireTenantContext() → withTenant() → RLS
 *
 * A client opening `/portal/<token>` has no Clerk session. They have no
 * account at all, and creating one for every counterparty who needs to
 * read a single contract would be both hostile and a licensing cost.
 *
 * So the chain has to start somewhere else. In this file, and only in this
 * file, THE TOKEN IS THE TENANT CONTEXT:
 *
 *     token → resolve (unscoped) → tenantId → withTenant() → RLS
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE FIRST LOOKUP MUST BYPASS TENANT SCOPING, AND WHY THAT IS SAFE
 * ══════════════════════════════════════════════════════════════════════
 * `portal_links` is under RLS like everything else, so a query against it
 * with no `app.current_tenant_id` returns ZERO ROWS. That is the correct,
 * fail-closed default — and it is a chicken-and-egg problem here, because
 * we cannot know which tenant to set until we have found the link.
 *
 * The single resolving query therefore runs through `withPlatformScope()`,
 * which is deliberately noisy: it demands a written justification, logs
 * outside production, and is named to be obvious in a diff.
 *
 * That bypass is safe for three specific reasons, and it would not be safe
 * without all three:
 *
 *   1. IT IS EXACTLY ONE QUERY, on exactly one table, filtered by an
 *      indexed 256-bit secret. Nothing else in the request is unscoped.
 *   2. WHAT IT RETURNS IS ONLY THE LINK ROW. Not the contract, not the
 *      documents, not the tenant's other data.
 *   3. EVERY SUBSEQUENT READ IS PINNED to the tenant the token resolved
 *      to, via `withTenant()`. Full RLS applies from that point on, so a
 *      bug in the portal page cannot read across tenants even in principle.
 *
 * The alternative — an RLS policy allowing anonymous reads of
 * `portal_links` — would leave that table permanently readable with no
 * tenant context by anything that ever connects to the database. A
 * narrowly-scoped, loudly-named bypass in one function is far easier to
 * audit than a permanently weakened policy.
 */

import { headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { db, withPlatformScope, withTenant } from "@/db";
import { portalLinks, auditLogs } from "@/db/schema";
import { hashPortalToken, isWellFormedToken, portalTokenRef } from "@/lib/portal/tokens";
import { recordSecurityEvent } from "@/server/security/record";
import type { SecurityEventType } from "@/lib/security/events";
import type { PortalLink } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* RESULT TYPES                                                        */
/* ------------------------------------------------------------------ */

/**
 * Why a token was refused.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THESE REASONS ARE FOR US, NOT FOR THE VISITOR
 * ══════════════════════════════════════════════════════════════════════
 * The distinction between "no such token" and "that token was revoked
 * yesterday" is useful in our logs and actively harmful on the page.
 * Telling an anonymous visitor which of the two applies confirms that a
 * token was once valid, which is information they did not have.
 *
 * The portal renders ONE message for every failure. These codes stay on
 * the server.
 */
export type PortalRejectionReason =
  | "malformed"
  | "not_found"
  | "revoked"
  | "expired"
  | "already_signed"
  | "tenant_inactive"
  /** The lookup itself failed — a database outage, a timeout. */
  | "lookup_failed";

export type PortalResolution =
  | { ok: true; link: PortalLink; tenantId: string }
  | { ok: false; reason: PortalRejectionReason };

/* ------------------------------------------------------------------ */
/* REQUEST FACTS                                                       */
/* ------------------------------------------------------------------ */

export type VisitorFacts = {
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
};

/**
 * What we can observe about an anonymous visitor.
 *
 * None of it authenticates anybody — every field is client-supplied or
 * proxy-supplied and trivially forged. It is EVIDENCE, recorded so that a
 * signature has context, not a control.
 */
export async function getVisitorFacts(): Promise<VisitorFacts> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    return {
      ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
      country: h.get("x-vercel-ip-country") ?? null,
    };
  } catch {
    return { ipAddress: null, userAgent: null, country: null };
  }
}

/* ------------------------------------------------------------------ */
/* RESOLUTION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Turn a URL token into a verified portal link, or a refusal.
 *
 * The checks run in this order deliberately — cheapest and most
 * information-free first, so a hostile request is dropped before it costs
 * us a query.
 */
export async function resolvePortalToken(token: unknown): Promise<PortalResolution> {
  // ══════════════════════════════════════════════════════════════════
  // THIS FUNCTION NEVER THROWS.
  //
  // Its caller is a page served to an anonymous member of the public. If
  // a database blip propagated out of here, Next.js would render a 500
  // with a stack trace to an external client — leaking framework and
  // query internals to exactly the audience that should see least.
  //
  // Any unexpected failure therefore becomes a REFUSAL. That is the
  // fail-closed direction: a transient outage denies access rather than
  // granting it, and the visitor sees the same neutral "link not
  // available" page as every other failure.
  // ══════════════════════════════════════════════════════════════════
  try {
    const resolution = await resolvePortalTokenUnsafe(token);
    if (!resolution.ok) await recordPortalRefusal(token, resolution.reason);
    return resolution;
  } catch (err) {
    console.error("[portal] token lookup failed", err);
    return { ok: false, reason: "lookup_failed" };
  }
}

/* ------------------------------------------------------------------ */
/* WAVE 9 — THE REFUSAL BECOMES EVIDENCE                               */
/* ------------------------------------------------------------------ */

/**
 * Which refusals are worth a `security_events` row, and as what.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 UNTIL WAVE 9 THIS FUNCTION DID NOT EXIST AND NOTHING REPLACED IT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/security/events.ts` has declared four portal event types since
 * Phase 20 — `portal.token_invalid`, `portal.token_expired`,
 * `portal.token_revoked_use`, `portal.token_shared_suspected` — each with
 * a default severity, a label and a SIEM mapping.
 *
 * NOT ONE OF THEM HAD EVER BEEN WRITTEN. The rejection reasons were
 * computed carefully, documented at length as being "for us, not for the
 * visitor", returned to the caller, and thrown away. The whole apparatus
 * existed except the line that recorded anything.
 *
 * The consequence was not only a missing log. `detectPortalTokenSharing`
 * in `server/security/anomalies.ts` filters observations by
 * `eventType.startsWith("portal.")` — so a detection rule with its own
 * threshold, its own test and its own justification could not fire, ever,
 * for any input. A rule that cannot fire is indistinguishable from a rule
 * that is not firing because everything is fine.
 *
 * ⚠️ EMITTED HERE, IN THE RESOLVER, AND NOT AT THE THREE CALL SITES.
 * `resolvePortalToken` is the single door: the page, the document
 * download route and `server/actions/signatures.ts` all pass through it.
 * A per-surface emission would be three chances to forget, and the one
 * that forgot would be the new surface added next year.
 */
const REFUSAL_EVENT: Partial<Record<PortalRejectionReason, SecurityEventType>> = {
  /**
   * A path that is not 64 hex characters. Almost always a crawler or a
   * truncated link in an email client, occasionally the first probe of
   * someone testing what the route does with rubbish.
   */
  malformed: "portal.token_invalid",
  /** Well-formed and unknown. This is what enumeration looks like. */
  not_found: "portal.token_invalid",
  expired: "portal.token_expired",
  /**
   * ⚠️ REVOKED, NOT `already_signed`. A revoked link being presented means
   * somebody still holds a credential we deliberately withdrew, which is
   * the reason the type is `warning` and the other two are `info`. A
   * signed link being reopened is a client re-reading their own contract
   * and is not a security event by any definition.
   */
  revoked: "portal.token_revoked_use",
};

/**
 * Record a portal refusal. Never throws, never blocks the refusal itself.
 *
 * ⚠️ `already_signed`, `tenant_inactive` and `lookup_failed` are absent
 * from the map on purpose. The first is ordinary use; the second is our
 * own administrative state; the third is our database being unwell, which
 * is an OUTAGE and belongs in Sentry, not in a table a security reviewer
 * reads for signs of an attacker.
 */
async function recordPortalRefusal(
  token: unknown,
  reason: PortalRejectionReason,
): Promise<void> {
  const type = REFUSAL_EVENT[reason];
  if (!type) return;

  try {
    const facts = await getVisitorFacts();

    /**
     * ⚠️ A REFERENCE ONLY WHEN THE INPUT WAS SHAPED LIKE A TOKEN.
     * Hashing `<script>alert(1)</script>` would produce a stable-looking
     * 16 characters that groups every piece of junk from one scanner
     * under one "token", and `detectPortalTokenSharing` would then report
     * a shared portal link that never existed.
     */
    const subjectId = isWellFormedToken(token) ? portalTokenRef(token) : null;

    await recordSecurityEvent({
      type,
      tenantId: null, // Unknown by construction — the token did not resolve.
      source: "portal",
      subjectType: "portal_token_ref",
      subjectId,
      ipAddress: facts.ipAddress,
      userAgent: facts.userAgent,
      detail: { reason, wellFormed: isWellFormedToken(token) },
      reason: `Portal token refused: ${reason}.`,
    });
  } catch (err) {
    /*
     * Recording must not be able to change the outcome of a refusal. The
     * visitor is being denied either way; a failure here is our telemetry
     * being broken, and `onSecurityRecordFailure` (wired in
     * `instrumentation.ts` since wave 9) is what escalates that.
     */
    console.error("[portal] could not record refusal", err);
  }
}

/** The actual checks. Only ever called through `resolvePortalToken`. */
async function resolvePortalTokenUnsafe(token: unknown): Promise<PortalResolution> {
  // ---- 1. SHAPE, BEFORE THE DATABASE IS TOUCHED --------------------
  // `/portal/<script>alert(1)</script>` and a 40 kB path are both refused
  // here, without a round trip and without hostile input reaching the
  // data layer at all.
  if (!isWellFormedToken(token)) {
    return { ok: false, reason: "malformed" };
  }

  // ---- 2. HASH, THEN LOOK UP BY HASH -------------------------------
  // The raw token is never sent to the database and never stored. A leaked
  // backup therefore yields hashes, which are useless without a preimage.
  const tokenHash = hashPortalToken(token);

  const link = await withPlatformScope(
    "Resolving an external portal token: the tenant is unknown until the token " +
      "is found, so this single lookup cannot be tenant-scoped. Everything " +
      "afterwards is pinned to the resolved tenant.",
    async (database) => {
      const row = await database.query.portalLinks.findFirst({
        where: eq(portalLinks.tokenHash, tokenHash),
      });
      return row ?? null;
    },
  );

  if (!link) {
    return { ok: false, reason: "not_found" };
  }

  // ---- 3. REVOCATION -----------------------------------------------
  // Checked on EVERY request and never cached. Revocation that takes
  // effect "within five minutes" is not revocation.
  if (!link.isActive) {
    return { ok: false, reason: link.signedAt ? "already_signed" : "revoked" };
  }

  // ---- 4. EXPIRY ----------------------------------------------------
  // Compared against the server clock. A client-side expiry check would be
  // a suggestion; this is the enforcement.
  if (new Date(link.expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  // ---- 5. THE TENANT MUST STILL BE ACTIVE ---------------------------
  // A workspace that has been suspended or closed must not keep serving
  // its documents to the outside world through links issued while it was
  // live. This is the one check people forget, because the link itself
  // looks perfectly valid.
  const tenantOk = await withPlatformScope(
    "Confirming the tenant behind a portal token is still active before " +
      "serving any of its data to an anonymous visitor.",
    async (database) => {
      const row = await database.query.tenants.findFirst({
        where: (t, { eq: e, and: a, isNull }) =>
          a(e(t.id, link.tenantId), e(t.status, "active"), isNull(t.deletedAt)),
        columns: { id: true },
      });
      return Boolean(row);
    },
  );

  if (!tenantOk) {
    return { ok: false, reason: "tenant_inactive" };
  }

  return { ok: true, link, tenantId: link.tenantId };
}

/* ------------------------------------------------------------------ */
/* SCOPED READS                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run a query pinned to the tenant a token resolved to.
 *
 * Everything the portal reads after resolution goes through here. From
 * this point the portal is under exactly the same Row-Level Security as
 * the authenticated application — the only difference is where the tenant
 * id came from.
 */
export async function withPortalTenant<T>(
  tenantId: string,
  callback: Parameters<typeof withTenant<T>>[1],
): Promise<T> {
  return withTenant(tenantId, callback);
}

/* ------------------------------------------------------------------ */
/* ACCESS RECORDING                                                    */
/* ------------------------------------------------------------------ */

/**
 * Record that a link was opened.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A READ-ONLY PAGE PERFORMS A WRITE
 * ══════════════════════════════════════════════════════════════════════
 * Because "when was this opened, how often, and from where?" is the
 * question that gets asked after a signature is disputed. A signature on a
 * link that was never viewed before the moment it was signed looks very
 * different from one viewed three times over two days.
 *
 * It never throws. Forensic bookkeeping must not be able to stop a client
 * reading their own contract.
 *
 * Counts may be slightly high — a refresh counts, and React may render a
 * server component more than once. That imprecision is acceptable; the
 * value is in the timestamps and the pattern, not an exact integer.
 */
export async function recordPortalView(
  link: PortalLink,
  facts: VisitorFacts,
): Promise<void> {
  try {
    const now = new Date();

    await withTenant(link.tenantId, async (tx) => {
      await tx
        .update(portalLinks)
        .set({
          viewCount: sql`${portalLinks.viewCount} + 1`,
          lastViewedAt: now,
          lastViewedIp: facts.ipAddress,
          // Only set on the first view. `COALESCE` rather than a read-then-
          // write, so two concurrent opens cannot both believe they are first.
          firstViewedAt: sql`COALESCE(${portalLinks.firstViewedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(
          and(eq(portalLinks.id, link.id), eq(portalLinks.tenantId, link.tenantId)),
        );
    });
  } catch (err) {
    console.error("[portal] could not record view", err);
  }
}

/**
 * Write an audit row for something an EXTERNAL, unauthenticated visitor did.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `writeAudit()` CANNOT BE USED HERE
 * ══════════════════════════════════════════════════════════════════════
 * `writeAudit()` takes a `TenantContext` — a Clerk user, a role, an email.
 * A portal visitor has none of those, and inventing a synthetic user to
 * satisfy the signature would put a fictional actor in the audit trail.
 *
 * So this writes directly, with `actorUserId` left NULL and the actor
 * described honestly: an external party identified only by the link they
 * held. Every row is marked `portal: true` in its metadata so external
 * actions can be filtered out of — or specifically searched for in — an
 * internal review.
 *
 * Like `writeAudit`, it never throws. An audit failure must not roll back
 * a client's signature.
 */
export async function writePortalAudit(params: {
  tenantId: string;
  action: "read" | "update" | "create" | "security_event";
  resourceType: string;
  resourceId: string;
  severity?: "info" | "notice" | "warning" | "critical";
  portalLinkId: string;
  actorEmail?: string | null;
  facts: VisitorFacts;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    /** ⚠️ Into the customer's own log, so it writes AS that tenant. */
    await withTenant(params.tenantId, (tx) =>
      tx.insert(auditLogs).values({
      tenantId: params.tenantId,
      // NULL — there is no internal user. This is the honest value.
      actorUserId: null,
      actorClerkId: null,
      actorEmail: params.actorEmail ?? null,
      actorRole: "external_portal",
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      severity: params.severity ?? "info",
      ipAddress: params.facts.ipAddress,
      userAgent: params.facts.userAgent,
      country: params.facts.country,
      metadata: {
        portal: true,
        portalLinkId: params.portalLinkId,
        ...params.metadata,
      },
      }),
    );
  } catch (err) {
    console.error("[portal] audit write failed", err);
  }
}
