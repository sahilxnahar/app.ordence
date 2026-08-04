/**
 * Ordence — Contract Detail
 * Version: v0.8.0-alpha
 *
 * Where Phase 4's contract lifecycle engine, Phase 7's UI conventions and
 * Phase 8's document storage meet on one screen.
 *
 * The Document Vault is mounted here with `entityType="contract"`. That is
 * the whole integration — the vault is deliberately entity-agnostic, so the
 * same component will attach files to an asset or a deal without a line of
 * new code.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  FileSignature,
  ShieldAlert,
  ShieldCheck,
  Building2,
  User as UserIcon,
  Package,
} from "lucide-react";
import { requirePageContext } from "@/server/tenant-context";
import { can } from "@/lib/permissions";
import { getContractById } from "@/server/actions/contracts";
import { getDocuments } from "@/server/actions/storage";
import { getPortalLinks } from "@/server/actions/portal";
import { getContractSignatures } from "@/server/actions/signatures";
import { isEmailEnabled } from "@/lib/email/resend";
import { DocumentVault } from "@/components/crm/document-vault";
import { PortalManager } from "@/components/crm/portal-manager";
import { SendToClientButton } from "../send-to-client";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/** "counterparty_review" → "Counterparty review". */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatMoney(value: string | null, currency: string): string {
  if (!value) return "—";
  const [whole = "0", fraction = "00"] = String(value).split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "INR" ? "₹" : `${currency} `;
  return `${symbol}${withSeparators}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/** Which visual treatment a status gets. Executed contracts read as final. */
function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "executed":
    case "active":
    case "signed":
      return "default";
    case "terminated":
    case "cancelled":
    case "expired":
      return "destructive";
    case "draft":
      return "outline";
    default:
      return "secondary";
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePageContext();

  const result = await getContractById(id);

  // A contract belonging to another tenant returns "not found" rather than
  // "forbidden" — a different status would confirm the id exists somewhere.
  if (!result.ok) notFound();

  const { contract, counterparty, assetName, versions } = result.data;

  const [documentsResult, portalLinksResult, signaturesResult] = await Promise.all([
    getDocuments({ entityType: "contract", entityId: contract.id }),
    getPortalLinks({ entityType: "contract", entityId: contract.id }),
    getContractSignatures(contract.id),
  ]);

  const documents = documentsResult.ok ? documentsResult.data : [];
  const portalLinks = portalLinksResult.ok ? portalLinksResult.data : [];
  const signatures = signaturesResult.ok ? signaturesResult.data : [];

  const subject = { role: ctx.role, overrides: ctx.user.permissionOverrides };
  const canUpdate = can(subject, "contracts:update");

  // A contract under legal hold must not have its evidence altered — that
  // is the entire point of a hold. Uploads and deletions are both refused
  // while it is in force.
  const underLegalHold = contract.legalHold === true;
  const canUpload = canUpdate && !underLegalHold;
  const canDelete = canUpdate && !underLegalHold;

  // Issuing a client link is `contracts:update`. Issuing one that can SIGN
  // is `contracts:approve` — strictly more, because it delegates the
  // authority to execute the agreement to someone outside the workspace.
  // The server re-checks both; this only decides what the UI offers.
  const canCreatePortalLink = canUpdate && !underLegalHold;
  const canCreateSigningLink = can(subject, "contracts:approve") && !underLegalHold;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      {/* ── HEADER ────────────────────────────────────────────────── */}
      <header className="space-y-3">
        <Link
          href="/contracts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to contracts
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
              <FileSignature className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true" />
              {contract.title}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {contract.contractNumber && (
                <span className="font-mono text-xs">{contract.contractNumber}</span>
              )}
              <span>{humanise(contract.contractType)}</span>
              <span aria-hidden="true">·</span>
              <span>version {contract.currentVersion}</span>
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge variant={statusTone(contract.status)}>{humanise(contract.status)}</Badge>

            <SendToClientButton
              contractId={contract.id}
              contractTitle={contract.title}
              recipientName={counterparty.contactName}
              recipientEmail={counterparty.contactEmail}
              currentStatus={contract.status}
              emailConfigured={isEmailEnabled()}
            />
          </div>
        </div>

        {underLegalHold && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <div>
              <p className="font-medium text-destructive">This contract is under legal hold.</p>
              <p className="mt-0.5 text-muted-foreground">
                {contract.legalHoldReason ??
                  "Documents cannot be added or removed while a hold is in force."}
              </p>
            </div>
          </div>
        )}
      </header>

      {/* ── SUMMARY ───────────────────────────────────────────────── */}
      <section aria-labelledby="summary-heading" className="space-y-3">
        <h2 id="summary-heading" className="text-lg font-semibold">
          Summary
        </h2>

        <dl className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-3">
          <Field label="Value" value={formatMoney(contract.value, contract.currency)} />
          <Field
            label="Effective from"
            value={contract.effectiveDate ? String(contract.effectiveDate) : "—"}
          />
          <Field
            label="Expires"
            value={contract.expiryDate ? String(contract.expiryDate) : "—"}
          />
          <Field label="Governing law" value={contract.governingLaw ?? "—"} />
          <Field label="Jurisdiction" value={contract.jurisdiction ?? "—"} />
          <Field
            label="Auto-renew"
            value={
              contract.autoRenew
                ? `Yes — ${contract.renewalNoticeDays} days notice`
                : "No"
            }
          />
        </dl>
      </section>

      {/* ── COUNTERPARTY ──────────────────────────────────────────── */}
      <section aria-labelledby="parties-heading" className="space-y-3">
        <h2 id="parties-heading" className="text-lg font-semibold">
          Linked records
        </h2>

        <ul className="divide-y divide-border rounded-md border border-border">
          {counterparty.companyId && (
            <li>
              <Link
                href={`/companies/${counterparty.companyId}/edit`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50"
              >
                <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {counterparty.companyName}
                </span>
                <span className="text-xs text-muted-foreground">Company</span>
              </Link>
            </li>
          )}

          {counterparty.contactId && (
            <li>
              <Link
                href={`/contacts/${counterparty.contactId}/edit`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50"
              >
                <UserIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {counterparty.contactName ?? "Contact"}
                  {counterparty.contactEmail && (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {counterparty.contactEmail}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">Client contact</span>
              </Link>
            </li>
          )}

          {assetName && (
            <li className="flex items-center gap-3 px-4 py-3">
              <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{assetName}</span>
              <span className="text-xs text-muted-foreground">Asset</span>
            </li>
          )}

          {!counterparty.companyId && !counterparty.contactId && !assetName && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing linked yet. Link a client contact to enable &ldquo;Send to
              client&rdquo;.
            </li>
          )}
        </ul>
      </section>

      {/* ── DOCUMENT VAULT ────────────────────────────────────────── */}
      <div className="rounded-md border border-border p-4">
        <DocumentVault
          entityType="contract"
          entityId={contract.id}
          initialDocuments={documents}
          canUpload={canUpload}
          canDelete={canDelete}
          title="Attached documents"
          description={
            underLegalHold
              ? "Locked — this contract is under legal hold."
              : "Signed copies, annexures, correspondence and site photographs."
          }
        />

        {!documentsResult.ok && (
          <p className="mt-2 text-sm text-destructive">{documentsResult.error}</p>
        )}
      </div>

      {/* ── CLIENT PORTAL ─────────────────────────────────────────── */}
      <div className="rounded-md border border-border p-4">
        <PortalManager
          entityType="contract"
          entityId={contract.id}
          initialLinks={portalLinks}
          defaultRecipientEmail={counterparty.contactEmail}
          defaultRecipientName={counterparty.contactName}
          canCreate={canCreatePortalLink}
          canCreateSigning={canCreateSigningLink}
          disabledReason={
            underLegalHold
              ? "This contract is under legal hold. New client links cannot be issued while a hold is in force."
              : !canUpdate
                ? "Your role does not include permission to share this contract externally."
                : null
          }
        />

        {!portalLinksResult.ok && (
          <p className="mt-2 text-sm text-destructive">{portalLinksResult.error}</p>
        )}
      </div>

      {/* ── SIGNATURE RECORD ──────────────────────────────────────── */}
      {signatures.length > 0 && (
        <section aria-labelledby="signatures-heading" className="space-y-3">
          <h2 id="signatures-heading" className="text-lg font-semibold">
            Signature record
          </h2>

          <ul className="divide-y divide-border rounded-md border border-border">
            {signatures.map((signature) => (
              <li key={signature.id} className="px-4 py-3">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <ShieldCheck
                    className="h-4 w-4 shrink-0 text-emerald-600"
                    aria-hidden="true"
                  />
                  {signature.signerName}
                  {signature.signerTitle && (
                    <span className="font-normal text-muted-foreground">
                      {signature.signerTitle}
                    </span>
                  )}
                </p>

                <p className="mt-0.5 text-xs text-muted-foreground">
                  {signature.signerEmail} ·{" "}
                  {new Date(signature.signedAt).toLocaleString("en-IN", {
                    dateStyle: "long",
                    timeStyle: "short",
                  })}
                  {signature.ipAddress ? ` · from ${signature.ipAddress}` : ""}
                  {signature.country ? ` (${signature.country})` : ""}
                  {signature.contractVersion
                    ? ` · version ${signature.contractVersion}`
                    : ""}
                </p>

                {signature.contentHash && (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    content {signature.contentHash.slice(0, 16)}…
                  </p>
                )}
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted-foreground">
            Signatures are append-only — the database refuses any edit or deletion.
            The content hash records exactly what was shown to the signer, so a later
            change to this contract becomes detectable rather than arguable. This is
            an electronic record of assent, not a PKI digital signature.
          </p>
        </section>
      )}

      {/* ── VERSION HISTORY ───────────────────────────────────────── */}
      <section aria-labelledby="versions-heading" className="space-y-3">
        <h2 id="versions-heading" className="text-lg font-semibold">
          Version history
        </h2>

        {versions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No versions recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    Version {version.versionNumber}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {humanise(version.changeType)}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {version.changeSummary ?? "No summary recorded"} ·{" "}
                    {version.createdAt.slice(0, 10)}
                  </p>
                </div>

                {version.contentHash && (
                  <code
                    className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    title="SHA-256 of the version content — the hash chain that makes tampering detectable"
                  >
                    {version.contentHash.slice(0, 12)}
                  </code>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          Versions are append-only and hash-chained. The database blocks any
          UPDATE or DELETE on them, so an altered history is detectable rather
          than merely discouraged.
        </p>
      </section>
    </main>
  );
}
