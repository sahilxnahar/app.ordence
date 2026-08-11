import "server-only";

/**
 * Ordence — Job Processors
 * Version: v0.4.0-alpha
 *
 * ⚠️ GUARD ADDED v0.84.0 — found by `scripts/check-server-boundaries.mjs`
 * on its first run. This module opens tenant-scoped transactions via
 * `withTenant()` and had no boundary declared, so nothing would have
 * failed the build if a client component imported it. Its only callers
 * are `server/actions/documents.ts` and `app/api/workers/route.ts`, both
 * server-side, so the guard changes no behaviour — it just makes the
 * mistake impossible rather than merely absent.
 *
 * The actual work each job kind performs. Shared by both execution paths:
 *   - `/api/workers` (Vercel, batch drain)
 *   - `scripts/worker.ts` (a real daemon, when you outgrow Hobby)
 *
 * Every processor re-establishes tenant scope from the job payload. There is no
 * HTTP request and no Clerk session here — `withTenant()` pins the tenant so RLS
 * applies exactly as it would during a normal request.
 */

import { eq, and, isNull, sql, gte, lte } from "drizzle-orm";
import { db, withTenant } from "@/db";
import {
  contracts,
  contractVersions,
  ledgers,
  journalEntries,
  transactions,
  assets,
  contacts,
  companies,
} from "@/db/schema";
import type { JobData } from "./jobs";
import { renderContractHtml, contentHash } from "@/lib/documents/render";

export type ProcessorResult = {
  ok: boolean;
  kind: string;
  tenantId: string;
  detail: Record<string, unknown>;
  error?: string;
};

/** Dispatch a job to its processor. */
export async function processJob(data: JobData): Promise<ProcessorResult> {
  const base = { kind: data.kind, tenantId: data.tenantId };

  try {
    switch (data.kind) {
      case "generate_pdf":
        return { ok: true, ...base, detail: await processGeneratePdf(data) };
      case "assemble_document":
        return { ok: true, ...base, detail: await processAssembleDocument(data) };
      case "ledger_aggregation":
        return { ok: true, ...base, detail: await processLedgerAggregation(data) };
      case "contract_expiry_scan":
        return { ok: true, ...base, detail: await processContractExpiryScan(data) };
      default: {
        // Exhaustiveness check — a new job kind without a processor fails to compile.
        const _never: never = data;
        void _never;
        return { ok: false, ...base, detail: {}, error: "Unknown job kind." };
      }
    }
  } catch (err) {
    console.error(`[processor:${data.kind}]`, err);
    return {
      ok: false,
      ...base,
      detail: {},
      error: err instanceof Error ? err.message : "Processing failed.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* GENERATE PDF                                                        */
/* ------------------------------------------------------------------ */

/**
 * Render a contract to a print-ready HTML document.
 *
 * WHY HTML AND NOT A PDF BINARY:
 *   Real PDF generation needs headless Chromium (~200 MB) or a native library.
 *   Neither fits in a Vercel Hobby function, and adding Puppeteer would put the
 *   bundle over the size limit outright. The honest options are:
 *     (a) render print-optimised HTML and let the browser's Print-to-PDF do it
 *     (b) call a PDF service (Browserless, DocRaptor, Gotenberg) — costs money
 *     (c) run this processor on a real worker host with Chromium available
 *
 *   (a) is implemented here because it works today at zero cost and produces a
 *   genuinely usable document. The seam for (b)/(c) is `renderContractHtml` —
 *   swapping it for a PDF call changes nothing else.
 */
async function processGeneratePdf(
  data: Extract<JobData, { kind: "generate_pdf" }>,
): Promise<Record<string, unknown>> {
  return withTenant(data.tenantId, async (tx) => {
    const contract = await tx.query.contracts.findFirst({
      where: and(
        eq(contracts.id, data.contractId),
        eq(contracts.tenantId, data.tenantId),
        isNull(contracts.deletedAt),
      ),
    });

    if (!contract) throw new Error("Contract not found or not accessible.");

    // A specific version was requested — render that snapshot, not current state.
    let documentData = contract.documentData;
    let versionNumber = contract.currentVersion;

    if (data.versionNumber != null) {
      const version = await tx.query.contractVersions.findFirst({
        where: and(
          eq(contractVersions.contractId, contract.id),
          eq(contractVersions.tenantId, data.tenantId),
          eq(contractVersions.versionNumber, data.versionNumber),
        ),
      });
      if (!version) throw new Error(`Version ${data.versionNumber} not found.`);
      documentData = version.documentData;
      versionNumber = version.versionNumber;
    }

    const html = renderContractHtml({
      title: contract.title,
      contractNumber: contract.contractNumber,
      status: contract.status,
      versionNumber,
      documentData,
      watermark: data.options?.includeWatermark
        ? (data.options.watermarkText ?? "DRAFT")
        : undefined,
      pageSize: data.options?.pageSize ?? "A4",
    });

    return {
      contractId: contract.id,
      versionNumber,
      outputKey: data.outputKey,
      byteLength: html.length,
      contentHash: contentHash(html),
      format: "print-html",
      note: "Print-optimised HTML. Swap renderContractHtml for a PDF service to emit binary PDF.",
    };
  });
}

/* ------------------------------------------------------------------ */
/* ASSEMBLE DOCUMENT                                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolve merge fields from a source record and write a new contract version.
 * The version chain is what makes assembly auditable — you can always see what
 * the document looked like before the merge.
 */
async function processAssembleDocument(
  data: Extract<JobData, { kind: "assemble_document" }>,
): Promise<Record<string, unknown>> {
  return withTenant(data.tenantId, async (tx) => {
    const contract = await tx.query.contracts.findFirst({
      where: and(
        eq(contracts.id, data.contractId),
        eq(contracts.tenantId, data.tenantId),
        isNull(contracts.deletedAt),
      ),
    });
    if (!contract) throw new Error("Contract not found.");

    // Pull merge values from the linked business record.
    const mergeFields: Record<string, string | number | boolean | null> = {
      ...(contract.documentData.mergeFields ?? {}),
    };

    if (data.mergeSourceType && data.mergeSourceId) {
      const resolved = await resolveMergeSource(
        tx,
        data.tenantId,
        data.mergeSourceType,
        data.mergeSourceId,
      );
      Object.assign(mergeFields, resolved);
    }

    // Substitute {{field}} placeholders in every section body.
    const sections = (contract.documentData.sections ?? []).map((section) => ({
      ...section,
      body: substituteMergeFields(section.body, mergeFields),
    }));

    const nextDocumentData = { ...contract.documentData, sections, mergeFields };
    const nextVersion = contract.currentVersion + 1;

    const previous = await tx.query.contractVersions.findFirst({
      where: and(
        eq(contractVersions.contractId, contract.id),
        eq(contractVersions.versionNumber, contract.currentVersion),
      ),
      columns: { contentHash: true },
    });

    const hash = contentHash(JSON.stringify(nextDocumentData));

    await tx.insert(contractVersions).values({
      tenantId: data.tenantId,
      contractId: contract.id,
      versionNumber: nextVersion,
      changeType: "edited",
      documentData: nextDocumentData,
      contentHash: hash,
      previousVersionHash: previous?.contentHash ?? null,
      statusAtVersion: contract.status,
      changeSummary: `Merge fields resolved from ${data.mergeSourceType ?? "template"}.`,
      authorUserId: data.requestedByUserId ?? null,
      authorName: "Document Assembly Engine",
    });

    await tx
      .update(contracts)
      .set({ documentData: nextDocumentData, currentVersion: nextVersion, updatedAt: new Date() })
      .where(and(eq(contracts.id, contract.id), eq(contracts.tenantId, data.tenantId)));

    return {
      contractId: contract.id,
      newVersion: nextVersion,
      mergeFieldsResolved: Object.keys(mergeFields).length,
      sectionsProcessed: sections.length,
      contentHash: hash,
    };
  });
}

/* ------------------------------------------------------------------ */
/* LEDGER AGGREGATION                                                  */
/* ------------------------------------------------------------------ */

/**
 * Heavy accounting rollup. Exactly the kind of work that must not run inline —
 * a trial balance across a year of entries will blow a 10s serverless budget.
 */
async function processLedgerAggregation(
  data: Extract<JobData, { kind: "ledger_aggregation" }>,
): Promise<Record<string, unknown>> {
  return withTenant(data.tenantId, async (tx) => {
    if (data.reportType === "trial_balance") {
      const rows = await tx
        .select({
          ledgerId: ledgers.id,
          ledgerCode: ledgers.code,
          ledgerName: ledgers.name,
          ledgerType: ledgers.type,
          accountType: ledgers.accountType,
          totalDebit: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit'  THEN ${journalEntries.amount} ELSE 0 END), 0)`,
          totalCredit: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)`,
        })
        .from(ledgers)
        .leftJoin(
          journalEntries,
          and(
            eq(journalEntries.ledgerId, ledgers.id),
            eq(journalEntries.tenantId, data.tenantId),
          ),
        )
        .where(and(eq(ledgers.tenantId, data.tenantId), isNull(ledgers.deletedAt)))
        .groupBy(ledgers.id, ledgers.code, ledgers.name, ledgers.type, ledgers.accountType);

      const totalDebits = rows.reduce((sum, r) => sum + Number(r.totalDebit), 0);
      const totalCredits = rows.reduce((sum, r) => sum + Number(r.totalCredit), 0);

      return {
        reportType: "trial_balance",
        ledgerCount: rows.length,
        totalDebits: totalDebits.toFixed(2),
        totalCredits: totalCredits.toFixed(2),
        // If this is ever false, the double-entry guarantee has been violated.
        isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
        rows,
      };
    }

    if (data.reportType === "ledger_statement" && data.ledgerId) {
      const entries = await tx
        .select({
          id: journalEntries.id,
          entryType: journalEntries.entryType,
          amount: journalEntries.amount,
          description: journalEntries.description,
          balanceAfter: journalEntries.balanceAfter,
          counterpartyName: journalEntries.counterpartyName,
          createdAt: journalEntries.createdAt,
        })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.tenantId, data.tenantId),
            eq(journalEntries.ledgerId, data.ledgerId),
            gte(journalEntries.createdAt, new Date(data.fromDate)),
            lte(journalEntries.createdAt, new Date(`${data.toDate}T23:59:59Z`)),
          ),
        )
        .orderBy(journalEntries.createdAt)
        .limit(5_000);

      return { reportType: "ledger_statement", ledgerId: data.ledgerId, entryCount: entries.length, entries };
    }

    // Reconciliation: unreconciled entries in reconciliation-required ledgers.
    const unreconciled = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(journalEntries)
      .innerJoin(ledgers, eq(ledgers.id, journalEntries.ledgerId))
      .where(
        and(
          eq(journalEntries.tenantId, data.tenantId),
          eq(journalEntries.isReconciled, false),
          eq(ledgers.requiresReconciliation, true),
        ),
      );

    return {
      reportType: "reconciliation",
      unreconciledCount: unreconciled[0]?.value ?? 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* CONTRACT EXPIRY SCAN                                                */
/* ------------------------------------------------------------------ */

async function processContractExpiryScan(
  data: Extract<JobData, { kind: "contract_expiry_scan" }>,
): Promise<Record<string, unknown>> {
  return withTenant(data.tenantId, async (tx) => {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + data.lookaheadDays);
    const horizonDate = horizon.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const expiring = await tx
      .select({
        id: contracts.id,
        title: contracts.title,
        contractNumber: contracts.contractNumber,
        expiryDate: contracts.expiryDate,
        autoRenew: contracts.autoRenew,
        ownerId: contracts.ownerId,
      })
      .from(contracts)
      .where(
        and(
          eq(contracts.tenantId, data.tenantId),
          isNull(contracts.deletedAt),
          gte(contracts.expiryDate, today),
          lte(contracts.expiryDate, horizonDate),
        ),
      )
      .limit(500);

    return {
      lookaheadDays: data.lookaheadDays,
      expiringCount: expiring.length,
      contracts: expiring,
    };
  });
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** Pull merge values out of the linked business record. Tenant-scoped. */
async function resolveMergeSource(
  tx: Tx,
  tenantId: string,
  sourceType: "asset" | "contact" | "company" | "deal",
  sourceId: string,
): Promise<Record<string, string | number | boolean | null>> {
  switch (sourceType) {
    case "asset": {
      const row = await tx.query.assets.findFirst({
        where: and(eq(assets.id, sourceId), eq(assets.tenantId, tenantId)),
      });
      if (!row) return {};
      return {
        asset_name: row.name,
        asset_code: row.code ?? "",
        asset_value: row.valueAmount ?? "",
        asset_currency: row.currency,
        asset_area: row.areaValue ?? "",
        asset_area_unit: row.areaUnit ?? "",
        asset_address: [row.addressLine1, row.addressLine2, row.locality, row.city, row.state, row.postalCode]
          .filter(Boolean)
          .join(", "),
        asset_status: row.status,
      };
    }
    case "contact": {
      const row = await tx.query.contacts.findFirst({
        where: and(eq(contacts.id, sourceId), eq(contacts.tenantId, tenantId)),
      });
      if (!row) return {};
      return {
        contact_name: [row.firstName, row.lastName].filter(Boolean).join(" "),
        contact_email: row.email ?? "",
        contact_phone: row.phone ?? "",
        contact_job_title: row.jobTitle ?? "",
      };
    }
    case "company": {
      const row = await tx.query.companies.findFirst({
        where: and(eq(companies.id, sourceId), eq(companies.tenantId, tenantId)),
      });
      if (!row) return {};
      return {
        company_name: row.name,
        company_domain: row.domain ?? "",
        company_industry: row.industry ?? "",
        company_address: [row.addressLine1, row.city, row.state, row.postalCode]
          .filter(Boolean)
          .join(", "),
      };
    }
    default:
      return {};
  }
}

/**
 * Replace `{{field_name}}` placeholders.
 *
 * Unresolved placeholders are left INTACT rather than blanked. A contract that
 * silently reads "Payment of  shall be due" is far more dangerous than one that
 * visibly reads "Payment of {{amount}} shall be due" — the second is obviously
 * unfinished; the first looks executed.
 */
export function substituteMergeFields(
  template: string,
  fields: Record<string, string | number | boolean | null>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => {
    const value = fields[key];
    if (value === undefined || value === null || value === "") return match;
    return String(value);
  });
}
