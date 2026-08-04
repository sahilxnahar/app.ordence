/**
 * Ordence — External Client Portal
 * Version: v0.9.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONLY PAGE IN THIS PLATFORM THAT SERVES TENANT DATA WITH NO SESSION
 * ══════════════════════════════════════════════════════════════════════
 * Everything else in the application is reached through
 * `middleware → Clerk → requireTenantContext() → RLS`. This page has no
 * Clerk session at all, so the chain starts from the token instead:
 *
 *     token → resolvePortalToken() → tenantId → withTenant() → RLS
 *
 * `resolvePortalToken` performs the checks in order and fails closed on
 * every one: shape, existence, revocation, expiry, tenant still active. If
 * any fails, this page renders `notFound()` — the SAME response for all of
 * them, so an anonymous visitor cannot distinguish "never existed" from
 * "revoked yesterday".
 *
 * After resolution, every read is pinned to the resolved tenant. Full
 * Row-Level Security applies from that point exactly as it would for an
 * authenticated user; the only difference is where the tenant id came from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT SHOWN
 * ══════════════════════════════════════════════════════════════════════
 * A counterparty gets the document they were sent and nothing else. No
 * internal notes, no owner, no linked deal, no other contracts, no
 * navigation into the application, and no indication that any of it
 * exists. The queries below select named columns rather than `SELECT *`
 * for exactly that reason — a future column called `internal_risk_notes`
 * should not appear here because someone used a wildcard.
 */

import { notFound } from "next/navigation";
import { and, eq, isNull, desc } from "drizzle-orm";
import { FileText, Download, Clock, ShieldCheck, Eye } from "lucide-react";
import {
  resolvePortalToken,
  recordPortalView,
  getVisitorFacts,
  writePortalAudit,
  withPortalTenant,
} from "@/server/portal-context";
import { contracts, assets, documents, tenants } from "@/db/schema";
import { describeTimeRemaining } from "@/lib/validators/portal";
import { formatBytes } from "@/lib/validators/storage";
import { SignatureForm } from "./signature-form";
import {
  checkRateLimit,
  portalRateLimitKey,
  portalSourceRateLimitKey,
} from "@/lib/security/rate-limit";
import { recordSecurityEvent } from "@/server/security/record";

// Never statically rendered or cached. A cached portal page would serve
// one client's contract to whoever asked next, and a revoked link would
// keep working until the cache expired.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatMoney(value: string | null, currency: string): string | null {
  if (!value) return null;
  const [whole = "0", fraction = "00"] = String(value).split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${withSeparators}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex flex-wrap justify-between gap-4 border-b border-[#E5E1DA] py-2.5 last:border-b-0">
      <dt className="text-sm text-[#6B6B6B]">{label}</dt>
      <dd className="text-sm font-medium text-[#1A1A1A]">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PAGE                                                                */
/* ------------------------------------------------------------------ */

export default async function PortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // ---- 0. RATE LIMIT (SEC-020) ---------------------------------------
  //
  // ══════════════════════════════════════════════════════════════════
  // TWO CHECKS, BECAUSE ONE KEY CANNOT COVER BOTH ATTACKS
  // ══════════════════════════════════════════════════════════════════
  // The COMPOUND key (token + IP prefix) catches someone hammering a
  // link they legitimately hold.
  //
  // The SOURCE key (IP prefix alone) catches an ENUMERATOR — someone
  // guessing tokens. Every guess is a different token, so a token-keyed
  // budget hands them a fresh allowance for each attempt and stops
  // nothing at all.
  //
  // Keying only by IP would be worse in the other direction: an office
  // behind one NAT gateway is many legitimate clients sharing an
  // address, and a tight IP limit would lock all of them out at once.
  // Hence both, with different budgets.
  //
  // ⚠️ The raw token never enters a rate-limit key — it is hashed first.
  // A key ends up in Redis, in logs and in metrics; a bearer credential
  // must not.
  const visitorFacts = await getVisitorFacts();

  const [byToken, bySource] = await Promise.all([
    checkRateLimit("portal", await portalRateLimitKey(token, visitorFacts.ipAddress)),
    checkRateLimit("portal", portalSourceRateLimitKey(visitorFacts.ipAddress)),
  ]);

  if (!byToken.allowed || !bySource.allowed) {
    await recordSecurityEvent({
      type: "rate_limit.exceeded",
      source: "portal",
      ipAddress: visitorFacts.ipAddress,
      subjectType: "portal_token_ref",
      // ⚠️ PREFIX ONLY, NEVER THE TOKEN. This row is readable by support
      // staff and exportable to a SIEM; a full token in it would be a
      // live credential sitting in a log aggregator.
      subjectId: token.slice(0, 8),
      detail: { policy: "portal", scope: byToken.allowed ? "source" : "token" },
      reason: "Portal rate limit exceeded.",
    });

    // ⚠️ `notFound()`, NOT a 429. Every portal failure — expired,
    // revoked, forged, throttled — renders the identical page. A
    // distinguishable 429 would confirm to an enumerator that they had
    // found a REAL token and merely needed to slow down, which is
    // precisely the signal the token's 256 bits of entropy exist to
    // withhold.
    notFound();
  }

  // ---- 1. RESOLVE, OR REFUSE ----------------------------------------
  const resolution = await resolvePortalToken(token);

  if (!resolution.ok) {
    // The specific reason goes to the server log and nowhere near the
    // response. `notFound()` renders the same page for all six causes.
    console.warn("[portal] refused", { reason: resolution.reason });
    notFound();
  }

  const { link, tenantId } = resolution;
  // Already resolved above for the rate-limit keys; one call, not two.
  const facts = visitorFacts;

  // ---- 2. RECORD THE VISIT ------------------------------------------
  // Forensics, not access control. Never throws — bookkeeping must not be
  // able to stop a client reading their own contract.
  await recordPortalView(link, facts);

  const isFirstView = link.viewCount === 0;
  if (isFirstView) {
    await writePortalAudit({
      tenantId,
      action: "read",
      resourceType: link.entityType,
      resourceId: link.entityId,
      severity: "info",
      portalLinkId: link.id,
      actorEmail: link.recipientEmail,
      facts,
      metadata: { event: "portal_first_opened" },
    });
  }

  // ---- 3. LOAD, TENANT-PINNED ---------------------------------------
  // From here on RLS applies exactly as it would for an internal user.
  const data = await withPortalTenant(tenantId, async (tx) => {
    const workspace = await tx.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { name: true },
    });

    // Named columns, never `SELECT *`. See the header note.
    const contract =
      link.entityType === "contract"
        ? await tx
            .select({
              id: contracts.id,
              title: contracts.title,
              contractNumber: contracts.contractNumber,
              contractType: contracts.contractType,
              status: contracts.status,
              value: contracts.value,
              currency: contracts.currency,
              effectiveDate: contracts.effectiveDate,
              expiryDate: contracts.expiryDate,
              governingLaw: contracts.governingLaw,
              jurisdiction: contracts.jurisdiction,
              documentData: contracts.documentData,
              currentVersion: contracts.currentVersion,
              signedAt: contracts.signedAt,
              legalHold: contracts.legalHold,
              deletedAt: contracts.deletedAt,
            })
            .from(contracts)
            .where(and(eq(contracts.id, link.entityId), eq(contracts.tenantId, tenantId)))
            .limit(1)
        : [];

    const asset =
      link.entityType === "asset"
        ? await tx
            .select({
              id: assets.id,
              name: assets.name,
              code: assets.code,
              assetType: assets.assetType,
              status: assets.status,
              description: assets.description,
              valueAmount: assets.valueAmount,
              currency: assets.currency,
              areaValue: assets.areaValue,
              areaUnit: assets.areaUnit,
              locality: assets.locality,
              city: assets.city,
              state: assets.state,
              deletedAt: assets.deletedAt,
            })
            .from(assets)
            .where(and(eq(assets.id, link.entityId), eq(assets.tenantId, tenantId)))
            .limit(1)
        : [];

    const files = await tx
      .select({
        id: documents.id,
        fileName: documents.fileName,
        sizeBytes: documents.sizeBytes,
        mimeType: documents.mimeType,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, tenantId),
          eq(documents.entityType, link.entityType),
          eq(documents.entityId, link.entityId),
          isNull(documents.deletedAt),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(100);

    return {
      workspaceName: workspace?.name ?? "Ordence",
      contract: contract[0] ?? null,
      asset: asset[0] ?? null,
      files,
    };
  });

  // A soft-deleted record behind a live link is indistinguishable from a
  // dead link, on purpose.
  const record = data.contract ?? data.asset;
  if (!record || record.deletedAt) {
    console.warn("[portal] refused — target record missing or deleted", {
      linkId: link.id,
    });
    notFound();
  }

  const timeLeft = describeTimeRemaining(link.expiresAt);

  const alreadyFinal =
    data.contract &&
    ["signed", "executed", "terminated", "cancelled", "expired"].includes(
      data.contract.status,
    );

  const canSign =
    link.permission === "view_and_sign" &&
    Boolean(data.contract) &&
    !alreadyFinal &&
    !data.contract?.legalHold;

  const title = data.contract?.title ?? data.asset?.name ?? "Document";
  const sections = (data.contract?.documentData?.sections ?? []) as Array<{
    id?: string;
    heading?: string;
    body?: string;
  }>;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      {/* ── BRAND HEADER ──────────────────────────────────────────── */}
      <header className="mb-6 text-center">
        <p className="font-serif text-2xl font-bold tracking-tight text-[#1A1A1A]">
          {data.workspaceName}
        </p>
        <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-[#6B6B6B]">
          Secure Document Review
        </p>
      </header>

      {/* ── LINK STATUS STRIP ─────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 rounded-md border border-[#E5E1DA] bg-white px-4 py-2.5 text-xs text-[#6B6B6B]">
        {link.recipientName || link.recipientEmail ? (
          <span>
            Prepared for{" "}
            <strong className="text-[#1A1A1A]">
              {link.recipientName ?? link.recipientEmail}
            </strong>
          </span>
        ) : null}

        {timeLeft && (
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Access expires in {timeLeft}
          </span>
        )}

        {link.viewCount > 0 && (
          <span className="flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            Opened {link.viewCount + 1} times
          </span>
        )}
      </div>

      {/* ── THE DOCUMENT ──────────────────────────────────────────── */}
      <article className="rounded-lg border border-[#E5E1DA] bg-white shadow-sm">
        <div className="border-b border-[#E5E1DA] px-6 py-5 sm:px-8">
          <h1 className="font-serif text-2xl font-bold leading-tight text-[#1A1A1A]">
            {title}
          </h1>

          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#6B6B6B]">
            {data.contract?.contractNumber && (
              <span className="font-mono text-xs">{data.contract.contractNumber}</span>
            )}
            {data.contract && <span>{humanise(data.contract.contractType)}</span>}
            {data.asset && <span>{humanise(data.asset.assetType)}</span>}
            <span aria-hidden="true">·</span>
            <span>{humanise(record.status)}</span>
          </p>
        </div>

        {/* Key terms */}
        <div className="px-6 py-5 sm:px-8">
          <dl>
            {data.contract && (
              <>
                <Row
                  label="Value"
                  value={formatMoney(data.contract.value, data.contract.currency)}
                />
                <Row
                  label="Effective from"
                  value={
                    data.contract.effectiveDate ? String(data.contract.effectiveDate) : null
                  }
                />
                <Row
                  label="Expires"
                  value={data.contract.expiryDate ? String(data.contract.expiryDate) : null}
                />
                <Row label="Governing law" value={data.contract.governingLaw} />
                <Row label="Jurisdiction" value={data.contract.jurisdiction} />
                <Row label="Version" value={data.contract.currentVersion} />
              </>
            )}

            {data.asset && (
              <>
                <Row label="Reference" value={data.asset.code} />
                <Row
                  label="Value"
                  value={formatMoney(data.asset.valueAmount, data.asset.currency)}
                />
                <Row
                  label="Area"
                  value={
                    data.asset.areaValue
                      ? `${data.asset.areaValue} ${data.asset.areaUnit ?? ""}`.trim()
                      : null
                  }
                />
                <Row
                  label="Location"
                  value={
                    [data.asset.locality, data.asset.city, data.asset.state]
                      .filter(Boolean)
                      .join(", ") || null
                  }
                />
              </>
            )}
          </dl>

          {data.asset?.description && (
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[#1A1A1A]">
              {data.asset.description}
            </p>
          )}
        </div>

        {/* Contract body.
            Rendered as TEXT, never with dangerouslySetInnerHTML. Clause
            content is tenant-supplied, and this page is served to third
            parties — injecting markup here would be handing one tenant a
            script that runs in another party's browser. React escapes it
            automatically; `whitespace-pre-wrap` keeps the formatting. */}
        {sections.length > 0 && (
          <div className="border-t border-[#E5E1DA] px-6 py-6 sm:px-8">
            <div className="space-y-5">
              {sections.map((section, index) => (
                <section key={section.id ?? index}>
                  {section.heading && (
                    <h2 className="font-serif text-base font-bold text-[#1A1A1A]">
                      {index + 1}. {section.heading}
                    </h2>
                  )}
                  {section.body && (
                    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-[#1A1A1A]">
                      {section.body}
                    </p>
                  )}
                </section>
              ))}
            </div>
          </div>
        )}

        {/* Attachments */}
        {data.files.length > 0 && (
          <div className="border-t border-[#E5E1DA] px-6 py-5 sm:px-8">
            <h2 className="text-sm font-bold text-[#1A1A1A]">Attached documents</h2>

            <ul className="mt-3 divide-y divide-[#E5E1DA] rounded-md border border-[#E5E1DA]">
              {data.files.map((file) => (
                <li key={file.id} className="flex items-center gap-3 px-3 py-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-[#6B6B6B]" aria-hidden="true" />

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[#1A1A1A]">
                      {file.fileName}
                    </span>
                    <span className="block text-xs text-[#6B6B6B]">
                      {formatBytes(Number(file.sizeBytes))}
                    </span>
                  </span>

                  {/*
                    The download goes through the PORTAL's own route, which
                    re-resolves this token before streaming a byte. It does
                    NOT reuse the internal `/api/documents/[id]/download`
                    endpoint, because that one requires a Clerk session the
                    visitor does not have — and loosening it to accept
                    portal tokens would weaken the internal path for every
                    authenticated user.
                  */}
                  <a
                    href={`/portal/${token}/documents/${file.id}`}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#E5E1DA] px-2.5 py-1.5 text-xs font-medium text-[#1A1A1A] hover:bg-[#FAF8F5]"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      {/* ── SIGNATURE ─────────────────────────────────────────────── */}
      <div className="mt-6 rounded-lg border border-[#E5E1DA] bg-white p-6 shadow-sm sm:p-8">
        {alreadyFinal && data.contract ? (
          <div className="flex items-start gap-3" role="status">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700"
              aria-hidden="true"
            />
            <div>
              <p className="font-serif text-base font-bold text-[#1A1A1A]">
                This document is {humanise(data.contract.status).toLowerCase()}
              </p>
              {data.contract.signedAt && (
                <p className="mt-1 text-sm text-[#6B6B6B]">
                  Signed on{" "}
                  {new Date(data.contract.signedAt).toLocaleDateString("en-IN", {
                    dateStyle: "long",
                  })}
                  . No further action is needed.
                </p>
              )}
            </div>
          </div>
        ) : canSign ? (
          <SignatureForm
            token={token}
            contractTitle={title}
            recipientName={link.recipientName}
            recipientEmail={link.recipientEmail}
          />
        ) : (
          <div className="text-center">
            <p className="text-sm text-[#6B6B6B]">
              This document has been shared with you for review.
            </p>
            <p className="mt-1 text-sm text-[#6B6B6B]">
              If you would like to approve it, please contact{" "}
              <strong className="text-[#1A1A1A]">{data.workspaceName}</strong>.
            </p>
          </div>
        )}
      </div>

      {/* ── FOOTER ────────────────────────────────────────────────── */}
      <footer className="mt-8 text-center text-xs leading-relaxed text-[#6B6B6B]">
        <p>
          This is a private link prepared for you. Please do not forward it — it
          opens this document without a password.
        </p>
        <p className="mt-2">
          Sent securely by {data.workspaceName} via Ordence
        </p>
      </footer>
    </main>
  );
}
