"use server";

/**
 * Ordence — Document Assembly Engine
 * Version: v0.4.0-alpha
 *
 * Takes a contract template, merges dynamic values from a linked business record,
 * and enqueues rendering to the background worker.
 *
 * WHY ASSEMBLY IS SPLIT ACROSS SYNC AND ASYNC:
 *   Resolving merge fields is fast (a handful of indexed reads) and the user needs
 *   the result immediately — so it runs inline. Rendering to a paginated document
 *   is slow and unbounded — so it is enqueued.
 *
 * GRACEFUL DEGRADATION (v0.21.0 — Cloudflare):
 *   Background work now goes to Cloudflare Queues. If no queue is bound,
 *   `enqueueJob` either runs the processor synchronously (`via: "inline"`) or
 *   refuses — and this action reports which, honestly, in `rendering`. It
 *   never reports success for rendering that did not happen.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import { db, withTenant } from "@/db";
import {
  contracts,
  contractVersions,
  clauseLibrary,
  assets,
  contacts,
  companies,
  deals,
  documents,
  users,
  auditLogs,
} from "@/db/schema";
import { requirePermission } from "@/server/audit";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import { enqueueJob, describeJobTransport } from "@/lib/queue/jobs";
import { substituteMergeFields } from "@/lib/queue/processors";
import { contentHash, renderContractHtml } from "@/lib/documents/render";
import type { ActionResult } from "@/lib/validators/crm";
import {
  createContractSchema,
  assembleDocumentSchema,
} from "@/lib/validators/documents";
import type {
  CreateContractInput,
  AssembleDocumentInput,
} from "@/lib/validators/documents";
import type { Contract, ContractDocumentData } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

const uuidSchema = z.string().uuid("Invalid identifier.");

// Contract schemas now live in `lib/validators/documents.ts` — a
// "use server" file may only export async functions.

export type { CreateContractInput, AssembleDocumentInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[documents action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* CREATE CONTRACT                                                     */
/* ------------------------------------------------------------------ */

export async function createContract(
  input: CreateContractInput,
): Promise<ActionResult<Contract>> {
  try {
    const ctx = await requireTenantContext();
    const data = createContractSchema.parse(input);

    // Every linked record must belong to this tenant.
    if (data.assetId) {
      const owned = await db.query.assets.findFirst({
        where: and(eq(assets.id, data.assetId), eq(assets.tenantId, ctx.tenant.id)),
        columns: { id: true },
      });
      if (!owned) return fail("Selected asset does not exist.");
    }
    if (data.contactId) {
      const owned = await db.query.contacts.findFirst({
        where: and(eq(contacts.id, data.contactId), eq(contacts.tenantId, ctx.tenant.id)),
        columns: { id: true },
      });
      if (!owned) return fail("Selected contact does not exist.");
    }
    if (data.companyId) {
      const owned = await db.query.companies.findFirst({
        where: and(eq(companies.id, data.companyId), eq(companies.tenantId, ctx.tenant.id)),
        columns: { id: true },
      });
      if (!owned) return fail("Selected company does not exist.");
    }

    // Append clauses from the library, tenant-scoped.
    const sections = [...data.sections];
    if (data.clauseIds.length > 0) {
      const { inArray } = await import("drizzle-orm");
      const clauses = await db
        .select({
          id: clauseLibrary.id,
          title: clauseLibrary.title,
          content: clauseLibrary.content,
        })
        .from(clauseLibrary)
        .where(
          and(
            inArray(clauseLibrary.id, data.clauseIds),
            eq(clauseLibrary.tenantId, ctx.tenant.id),
            isNull(clauseLibrary.deletedAt),
          ),
        );

      // Preserve the caller's ordering rather than the database's.
      const byId = new Map(clauses.map((c) => [c.id, c]));
      let order = sections.length;
      for (const clauseId of data.clauseIds) {
        const clause = byId.get(clauseId);
        if (!clause) continue;
        sections.push({
          id: `clause-${clause.id}`,
          heading: clause.title,
          body: clause.content,
          clauseId: clause.id,
          order: order++,
        });
      }
    }

    const documentData: ContractDocumentData = {
      sections,
      parties: data.parties,
      mergeFields: {},
      commercials: data.value
        ? { value: data.value, currency: data.currency }
        : undefined,
    };

    const [created] = await db
      .insert(contracts)
      .values({
        tenantId: ctx.tenant.id,
        title: data.title,
        contractNumber: data.contractNumber ?? null,
        contractType: data.contractType,
        status: "draft",
        assetId: data.assetId ?? null,
        contactId: data.contactId ?? null,
        companyId: data.companyId ?? null,
        dealId: data.dealId ?? null,
        value: data.value ?? null,
        currency: data.currency,
        effectiveDate: data.effectiveDate ?? null,
        expiryDate: data.expiryDate ?? null,
        governingLaw: data.governingLaw,
        jurisdiction: data.jurisdiction ?? null,
        documentData,
        currentVersion: 1,
        ownerId: ctx.user.id,
        createdBy: ctx.user.id,
      })
      .returning();

    if (!created) return fail("Failed to create contract.");

    // Version 1 — the genesis block of the hash chain.
    await db.insert(contractVersions).values({
      tenantId: ctx.tenant.id,
      contractId: created.id,
      versionNumber: 1,
      changeType: "created",
      documentData,
      contentHash: contentHash(JSON.stringify(documentData)),
      previousVersionHash: null,
      statusAtVersion: "draft",
      changeSummary: "Contract created.",
      authorUserId: ctx.user.id,
      authorName: [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(" ") || null,
      authorEmail: ctx.user.email,
    });

    revalidatePath("/contracts");
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* ASSEMBLE DOCUMENT                                                   */
/* ------------------------------------------------------------------ */

export type AssembleResult = {
  contractId: string;
  newVersion: number;
  mergeFieldsResolved: number;
  unresolvedPlaceholders: string[];
  contentHash: string;
  rendering:
    /**
     * The work is accounted for.
     *
     * ⚠️ `via` is not decoration. "queue" means it will happen shortly and
     * the caller should expect the document to appear later; "inline" means
     * it has ALREADY happened, inside this request. Collapsing the two into
     * a bare `queued: true` is how a UI ends up showing "processing…"
     * forever for work that finished before the response was sent.
     */
    | { queued: true; via: "queue" | "inline"; jobId: string }
    /** The work did NOT happen. `reason` is safe to show a human. */
    | { queued: false; reason: string; renderedInline: boolean };
};

/**
 * Resolve merge fields into the contract body, write a new immutable version,
 * and enqueue rendering.
 */
export async function assembleDocument(
  input: AssembleDocumentInput,
): Promise<ActionResult<AssembleResult>> {
  try {
    const ctx = await requireTenantContext();
    const data = assembleDocumentSchema.parse(input);

    const contract = await db.query.contracts.findFirst({
      where: and(
        eq(contracts.id, data.contractId),
        eq(contracts.tenantId, ctx.tenant.id),
        isNull(contracts.deletedAt),
      ),
    });
    if (!contract) return fail("Contract not found.");

    // Executed contracts are immutable. Assembling into one would rewrite a
    // legally binding document — refuse rather than version it.
    if (contract.status === "executed" || contract.status === "signed") {
      return fail("This contract is signed and can no longer be modified.");
    }
    if (contract.legalHold) {
      return fail("This contract is under legal hold and cannot be modified.");
    }

    /* ---- Resolve merge fields (fast, inline) --------------------- */
    const mergeFields: Record<string, string | number | boolean | null> = {
      ...(contract.documentData.mergeFields ?? {}),
      ...data.additionalFields,
      // Always-available system fields.
      today: new Date().toISOString().slice(0, 10),
      contract_number: contract.contractNumber ?? "",
      contract_title: contract.title,
      governing_law: contract.governingLaw ?? "India",
      jurisdiction: contract.jurisdiction ?? "",
    };

    const sourceType = data.mergeSourceType ?? inferSourceType(contract);
    const sourceId =
      data.mergeSourceId ??
      (sourceType === "asset"
        ? contract.assetId
        : sourceType === "contact"
          ? contract.contactId
          : contract.companyId);

    if (sourceType && sourceId) {
      Object.assign(mergeFields, await resolveSource(ctx.tenant.id, sourceType, sourceId));
    }

    /* ---- Substitute placeholders --------------------------------- */
    const sections = (contract.documentData.sections ?? []).map((s) => ({
      ...s,
      body: substituteMergeFields(s.body, mergeFields),
    }));

    // Report what did not resolve. A silently blank contract clause is dangerous;
    // a visibly unresolved one is merely unfinished.
    const unresolved = new Set<string>();
    for (const s of sections) {
      for (const match of s.body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
        if (match[1]) unresolved.add(match[1]);
      }
    }

    const nextDocumentData: ContractDocumentData = {
      ...contract.documentData,
      sections,
      mergeFields,
    };
    const nextVersion = contract.currentVersion + 1;
    const hash = contentHash(JSON.stringify(nextDocumentData));

    const previous = await db.query.contractVersions.findFirst({
      where: and(
        eq(contractVersions.contractId, contract.id),
        eq(contractVersions.tenantId, ctx.tenant.id),
      ),
      orderBy: [desc(contractVersions.versionNumber)],
      columns: { contentHash: true },
    });

    await db.insert(contractVersions).values({
      tenantId: ctx.tenant.id,
      contractId: contract.id,
      versionNumber: nextVersion,
      changeType: "edited",
      documentData: nextDocumentData,
      contentHash: hash,
      previousVersionHash: previous?.contentHash ?? null,
      statusAtVersion: contract.status,
      changeSummary: `Assembled with ${Object.keys(mergeFields).length} merge fields${
        sourceType ? ` from ${sourceType}` : ""
      }.`,
      authorUserId: ctx.user.id,
      authorName: [ctx.user.firstName, ctx.user.lastName].filter(Boolean).join(" ") || null,
      authorEmail: ctx.user.email,
    });

    await db
      .update(contracts)
      .set({
        documentData: nextDocumentData,
        currentVersion: nextVersion,
        updatedAt: new Date(),
        updatedBy: ctx.user.id,
      })
      .where(and(eq(contracts.id, contract.id), eq(contracts.tenantId, ctx.tenant.id)));

    /* ---- Enqueue rendering (slow, async) ------------------------- */
    let rendering: AssembleResult["rendering"];

    if (data.generateDocument) {
      const enqueued = await enqueueJob({
        kind: "generate_pdf",
        tenantId: ctx.tenant.id,
        requestedByUserId: ctx.user.id,
        correlationId: ctx.requestId,
        contractId: contract.id,
        versionNumber: nextVersion,
        outputKey: `contracts/${ctx.tenant.id}/${contract.id}/v${nextVersion}.html`,
        options: {
          includeWatermark: Boolean(data.watermark),
          watermarkText: data.watermark,
          pageSize: "A4",
        },
      });

      if (enqueued.queued) {
        // `via` is passed through untouched — see the note on AssembleResult.
        // "inline" means `enqueueJob` already ran the processor to completion
        // inside this request; "queue" means Cloudflare accepted the message.
        rendering = { queued: true, via: enqueued.via, jobId: enqueued.jobId };
      } else {
        /**
         * ⚠️ THE JOB DID NOT HAPPEN, AND THE CALLER IS BEING TOLD SO.
         *
         * A last-ditch inline render still runs, because a contract the user
         * can read beats a contract they cannot — but `queued:false` and a
         * specific `reason` go back with it. This branch must never look
         * like success.
         */
        renderContractHtml({
          title: contract.title,
          contractNumber: contract.contractNumber,
          status: contract.status,
          versionNumber: nextVersion,
          documentData: nextDocumentData,
          watermark: data.watermark,
        });
        rendering = {
          queued: false,
          reason:
            enqueued.reason === "queue_unavailable"
              ? `Background processing is unavailable (transport: ${describeJobTransport()}).`
              : enqueued.reason === "inline_failed"
                ? `Rendering failed: ${enqueued.error ?? "unknown error"}.`
                : `Could not queue rendering: ${enqueued.error ?? "unknown error"}.`,
          renderedInline: true,
        };
      }
    } else {
      rendering = { queued: false, reason: "Rendering not requested.", renderedInline: false };
    }

    await db.insert(auditLogs).values({
      tenantId: ctx.tenant.id,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      actorRole: ctx.role,
      action: "update",
      resourceType: "contract",
      resourceId: contract.id,
      newValue: { version: nextVersion, contentHash: hash },
      reason: "Document assembly",
    });

    revalidatePath(`/contracts/${contract.id}`);

    return {
      ok: true,
      data: {
        contractId: contract.id,
        newVersion: nextVersion,
        mergeFieldsResolved: Object.keys(mergeFields).length,
        unresolvedPlaceholders: [...unresolved],
        contentHash: hash,
        rendering,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* VERSION HISTORY & INTEGRITY                                         */
/* ------------------------------------------------------------------ */

/**
 * Walk the version chain and verify every hash link.
 *
 * This is what makes the audit trail defensible: if a version was altered at the
 * storage layer, its recomputed hash no longer matches the stored one, and its
 * child's `previousVersionHash` no longer matches either.
 */
export async function verifyContractIntegrity(
  contractId: string,
): Promise<
  ActionResult<{
    contractId: string;
    versionCount: number;
    intact: boolean;
    brokenAt: number[];
  }>
> {
  try {
    const ctx = await requireTenantContext();
    const id = uuidSchema.parse(contractId);

    const versions = await db
      .select({
        versionNumber: contractVersions.versionNumber,
        documentData: contractVersions.documentData,
        contentHash: contractVersions.contentHash,
        previousVersionHash: contractVersions.previousVersionHash,
      })
      .from(contractVersions)
      .where(
        and(
          eq(contractVersions.contractId, id),
          eq(contractVersions.tenantId, ctx.tenant.id),
        ),
      )
      .orderBy(contractVersions.versionNumber);

    if (versions.length === 0) return fail("Contract not found.");

    const brokenAt: number[] = [];
    let expectedPrevious: string | null = null;

    for (const version of versions) {
      const recomputed = contentHash(JSON.stringify(version.documentData));
      if (recomputed !== version.contentHash) {
        brokenAt.push(version.versionNumber);
      } else if (version.previousVersionHash !== expectedPrevious) {
        brokenAt.push(version.versionNumber);
      }
      expectedPrevious = version.contentHash;
    }

    return {
      ok: true,
      data: {
        contractId: id,
        versionCount: versions.length,
        intact: brokenAt.length === 0,
        brokenAt,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function inferSourceType(contract: Contract): "asset" | "contact" | "company" | null {
  if (contract.assetId) return "asset";
  if (contract.contactId) return "contact";
  if (contract.companyId) return "company";
  return null;
}

/** Read merge values from a linked record. Always tenant-scoped. */
async function resolveSource(
  tenantId: string,
  sourceType: "asset" | "contact" | "company",
  sourceId: string,
): Promise<Record<string, string | number | boolean | null>> {
  if (sourceType === "asset") {
    const row = await db.query.assets.findFirst({
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
      asset_status: row.status,
      asset_address: [row.addressLine1, row.addressLine2, row.locality, row.city, row.state, row.postalCode]
        .filter(Boolean)
        .join(", "),
    };
  }

  if (sourceType === "contact") {
    const row = await db.query.contacts.findFirst({
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

  const row = await db.query.companies.findFirst({
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

/* ══════════════════════════════════════════════════════════════════════
 * THE DOCUMENT REGISTER — every file, and the ones nothing points at
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⭐ WHY THIS SCREEN EXISTS AT ALL, WHEN EVERY RECORD ALREADY SHOWS ITS
 *    OWN ATTACHMENTS
 *
 * `documents.entity_id` HAS NO FOREIGN KEY. It cannot have one: the link
 * is polymorphic — `(entity_type, entity_id)` — and Postgres cannot
 * point a constraint at five tables at once. The schema file says so in
 * as many words, and calls the trade honest. It is. But it has a
 * consequence nobody sees from a record page:
 *
 * ⚠️ A FILE WHOSE PARENT IS GONE IS REACHABLE FROM NOWHERE, AND NOTHING
 * IN THE DATABASE OBJECTS.
 *
 * Delete a deal and its attachments do not cascade — no FK, no cascade.
 * The rows stay. The BYTES stay, in a private blob store that bills by
 * the gigabyte, past whatever retention period the contract with the
 * client stated. The only screen that lists them is the deal page, and
 * that page is gone. From every other screen the file has ceased to
 * exist, which is precisely the state in which a signed agreement is
 * still sitting in a bucket the day a data-deletion request is audited.
 *
 * So this register leads with two counts nobody else in the product can
 * produce:
 *
 *   1. ORPHANED  — the parent id matches no row at all. Hard-deleted, or
 *                  never existed.
 *   2. STRANDED  — the parent row exists but is soft-deleted. The file is
 *                  intact, the audit trail is intact, and no screen in
 *                  the product will ever show it again.
 *
 * Everything else here — the storage footprint, the largest files, who
 * uploaded what — is the ordinary register. Those two are the reason.
 * ══════════════════════════════════════════════════════════════════════ */

export type RegisterEntityType =
  | "contract"
  | "asset"
  | "deal"
  | "contact"
  | "company";

export type DocumentRegisterRow = {
  id: string;
  fileName: string;
  mimeType: string;
  /** Bytes. `number`, matching the column's `mode: "number"`. */
  sizeBytes: number;
  description: string | null;
  entityType: RegisterEntityType;
  entityId: string;
  /** The parent's own name, or null when there is no parent to name. */
  entityLabel: string | null;
  /** ⭐ Nothing in the database matches `entityId`. */
  isOrphaned: boolean;
  /** ⭐ The parent exists but is soft-deleted. Reachable from no screen. */
  isStranded: boolean;
  /** This document row itself was soft-deleted; its bytes are already gone. */
  isDeleted: boolean;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
  deletedAt: string | null;
};

/** Per-entity-type footprint. */
export type RegisterBreakdown = {
  entityType: RegisterEntityType;
  count: number;
  bytes: number;
};

/** Not exported — see the "use server" note at the top of this file. */
const REGISTER_ENTITY_TYPES: readonly RegisterEntityType[] = [
  "contract",
  "asset",
  "deal",
  "contact",
  "company",
];

/**
 * The whole register, with every polymorphic link resolved.
 *
 * ⚠️ `contracts:read` — an EXISTING key in `PERMISSION_CATALOG`, and the
 * broadest read key held by every role that has any document-facing
 * access at all (member, counsel, accountant, security admin). There is
 * no `documents:*` key in the catalogue, and inventing one here without
 * adding it to `ROLE_TEMPLATES` would deny this page to every user
 * including the workspace owner, silently, forever — see the block
 * comment at the top of `PERMISSION_CATALOG`.
 */
export async function listDocumentRegister(): Promise<
  ActionResult<{
    documents: DocumentRegisterRow[];
    /** ⭐ Files whose parent id matches nothing. These lead the screen. */
    orphaned: DocumentRegisterRow[];
    /** ⭐ Files whose parent is soft-deleted. Reachable from no screen. */
    stranded: DocumentRegisterRow[];
    breakdown: RegisterBreakdown[];
    /** Live bytes — excludes rows whose blob was already destroyed. */
    totalBytes: number;
    /** Bytes held by orphaned and stranded files together. */
    unreachableBytes: number;
    liveCount: number;
    /** Rows kept as evidence of a file that no longer exists. */
    deletedCount: number;
    /** Live files with no uploader recorded. */
    unattributedCount: number;
    largest: DocumentRegisterRow[];
  }>
> {
  try {
    const ctx = await requirePermission("contracts:read");

    const payload = await withTenant(ctx.tenant.id, async (tx) => {
      /* ⚠️ Soft-deleted rows are READ, not filtered out. The row is the
       * evidence that a file existed and was removed; a register that
       * hides them cannot answer the only question anybody asks it
       * after an incident. They are flagged, not dropped. */
      const rows = await tx
        .select({
          id: documents.id,
          fileName: documents.fileName,
          mimeType: documents.mimeType,
          sizeBytes: documents.sizeBytes,
          description: documents.description,
          entityType: documents.entityType,
          entityId: documents.entityId,
          uploadedBy: documents.uploadedBy,
          createdAt: documents.createdAt,
          deletedAt: documents.deletedAt,
          uploaderFirstName: users.firstName,
          uploaderLastName: users.lastName,
          uploaderEmail: users.email,
        })
        .from(documents)
        .leftJoin(
          users,
          and(
            eq(users.id, documents.uploadedBy),
            eq(users.tenantId, documents.tenantId),
          ),
        )
        .where(eq(documents.tenantId, ctx.tenant.id))
        .orderBy(desc(documents.createdAt))
        .limit(2000);

      /* ---- Resolve the polymorphic link, one query per type ------- */
      const idsByType = new Map<RegisterEntityType, string[]>();
      for (const type of REGISTER_ENTITY_TYPES) {
        const ids = [
          ...new Set(
            rows.filter((r) => r.entityType === type).map((r) => r.entityId),
          ),
        ];
        // ⚠️ `inArray` with an empty list produces `IN ()`, which is a
        // syntax error in Postgres. Skip the type entirely.
        if (ids.length > 0) idsByType.set(type, ids);
      }

      const parents = new Map<
        string,
        { label: string | null; deleted: boolean }
      >();
      const remember = (
        type: RegisterEntityType,
        id: string,
        label: string | null,
        deletedAt: Date | null,
      ) => {
        parents.set(`${type}:${id}`, { label, deleted: deletedAt !== null });
      };

      const contractIds = idsByType.get("contract");
      if (contractIds) {
        const found = await tx
          .select({
            id: contracts.id,
            title: contracts.title,
            deletedAt: contracts.deletedAt,
          })
          .from(contracts)
          .where(
            and(
              eq(contracts.tenantId, ctx.tenant.id),
              inArray(contracts.id, contractIds),
            ),
          );
        for (const r of found) remember("contract", r.id, r.title, r.deletedAt);
      }

      const assetIds = idsByType.get("asset");
      if (assetIds) {
        const found = await tx
          .select({
            id: assets.id,
            name: assets.name,
            deletedAt: assets.deletedAt,
          })
          .from(assets)
          .where(
            and(eq(assets.tenantId, ctx.tenant.id), inArray(assets.id, assetIds)),
          );
        for (const r of found) remember("asset", r.id, r.name, r.deletedAt);
      }

      const dealIds = idsByType.get("deal");
      if (dealIds) {
        const found = await tx
          .select({
            id: deals.id,
            title: deals.title,
            deletedAt: deals.deletedAt,
          })
          .from(deals)
          .where(
            and(eq(deals.tenantId, ctx.tenant.id), inArray(deals.id, dealIds)),
          );
        for (const r of found) remember("deal", r.id, r.title, r.deletedAt);
      }

      const contactIds = idsByType.get("contact");
      if (contactIds) {
        const found = await tx
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            deletedAt: contacts.deletedAt,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.tenantId, ctx.tenant.id),
              inArray(contacts.id, contactIds),
            ),
          );
        for (const r of found) {
          remember(
            "contact",
            r.id,
            [r.firstName, r.lastName].filter(Boolean).join(" ") || null,
            r.deletedAt,
          );
        }
      }

      const companyIds = idsByType.get("company");
      if (companyIds) {
        const found = await tx
          .select({
            id: companies.id,
            name: companies.name,
            deletedAt: companies.deletedAt,
          })
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, ctx.tenant.id),
              inArray(companies.id, companyIds),
            ),
          );
        for (const r of found) remember("company", r.id, r.name, r.deletedAt);
      }

      return { rows, parents };
    });

    const register: DocumentRegisterRow[] = payload.rows.map((r) => {
      const parent = payload.parents.get(`${r.entityType}:${r.entityId}`);
      const isDeleted = r.deletedAt !== null;
      return {
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        sizeBytes: Number(r.sizeBytes ?? 0),
        description: r.description,
        entityType: r.entityType as RegisterEntityType,
        entityId: r.entityId,
        entityLabel: parent?.label ?? null,
        /* ⚠️ A row whose own blob is already destroyed cannot be
         * "unreachable" in any way that matters — there is nothing left
         * to reach. Both flags stay false for it so the two leading
         * counts stay honest about live bytes. */
        isOrphaned: !isDeleted && parent === undefined,
        isStranded: !isDeleted && parent !== undefined && parent.deleted,
        isDeleted,
        uploadedBy: r.uploadedBy,
        uploadedByName:
          [r.uploaderFirstName, r.uploaderLastName].filter(Boolean).join(" ") ||
          r.uploaderEmail ||
          null,
        createdAt: new Date(r.createdAt).toISOString(),
        deletedAt: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
      };
    });

    const live = register.filter((d) => !d.isDeleted);
    const orphaned = register.filter((d) => d.isOrphaned);
    const stranded = register.filter((d) => d.isStranded);

    return {
      ok: true,
      data: {
        documents: register,
        orphaned,
        stranded,
        breakdown: REGISTER_ENTITY_TYPES.map((entityType) => {
          const inType = live.filter((d) => d.entityType === entityType);
          return {
            entityType,
            count: inType.length,
            bytes: inType.reduce((acc, d) => acc + d.sizeBytes, 0),
          };
        }),
        totalBytes: live.reduce((acc, d) => acc + d.sizeBytes, 0),
        unreachableBytes: [...orphaned, ...stranded].reduce(
          (acc, d) => acc + d.sizeBytes,
          0,
        ),
        liveCount: live.length,
        deletedCount: register.length - live.length,
        unattributedCount: live.filter((d) => d.uploadedBy === null).length,
        largest: [...live].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 10),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The document register could not be read.",
    };
  }
}
