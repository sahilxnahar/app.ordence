"use server";

/**
 * Ordence — Document Server Actions
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE DATABASE ROW IS WRITTEN HERE AND NOT AT THE MOMENT OF UPLOAD
 * ══════════════════════════════════════════════════════════════════════
 * `/api/upload/put` receives the bytes and could write this row itself —
 * one source of truth, driven by storage. It deliberately does not.
 *
 * That route's job is to be a narrow, ticket-checked pipe into R2. Giving
 * it the document table, the metering reservation, the parent-ownership
 * check and the audit write would make the widest-input surface in the
 * application also the one with the most authority.
 *
 * So the client calls this action once the PUT returns. The tenant is
 * re-derived from the session here, exactly as it was in the route, and the
 * claimed storage path is re-checked against the tenant prefix — a second
 * time, independently.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ORPHAN PROBLEM, STATED HONESTLY
 * ══════════════════════════════════════════════════════════════════════
 * Between the browser finishing its upload and this action committing a
 * row, there is a window. If the tab closes in that window the object
 * exists in storage with no row describing it.
 *
 * That is a storage-cost leak, not a security hole — the object is private,
 * its path is unguessable, and nothing in the application can reach it
 * without a row. It is listed as SEC-018 with a reconciliation sweep as the
 * fix, rather than papered over here.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, isNull, desc } from "drizzle-orm";
import { deleteStoredObject, isStorageConfigured, STORAGE_UNCONFIGURED_MESSAGE } from "@/lib/storage/r2";
import { db } from "@/db";
import { documents, contracts, assets, deals, contacts, companies } from "@/db/schema";
import { requireTenantContext, TenantAccessError } from "@/server/tenant-context";
import {
  assertImpersonationAllows,
  ImpersonationForbiddenError,
} from "@/server/platform/impersonation";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { withTenant } from "@/db";
import { reserveStorageBytes, releaseStorageBytes } from "@/server/metering/record";
import { getTenantMeteringContext } from "@/server/metering/query";
import { writeAudit, auditMeta } from "@/server/audit";
import {
  saveDocumentSchema,
  isAllowedMimeType,
  pathnameBelongsToTenant,
} from "@/lib/validators/storage";
import type { ActionResult } from "@/lib/validators/crm";
import type {
  SaveDocumentInput,
  DocumentEntityTypeInput,
} from "@/lib/validators/storage";
import type { Document } from "@/db/schema";

export type { SaveDocumentInput };

function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

function toActionError(err: unknown): ActionResult<never> {
  // A read-only workspace is an account-standing answer with its own
  // remedy. It must not surface as a generic failure — and it must not
  // be confused with a permission or plan problem.
  if (err instanceof AccessRestrictedError) return fail(err.message);
  // A locked feature is a commercial answer, not a fault. It must
  // never surface as "something went wrong" — the customer can act
  // on "upgrade to Advanced" and cannot act on a generic error.
  if (err instanceof FeatureLockedError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof ImpersonationForbiddenError) return fail(err.message);
  if (err instanceof z.ZodError) {
    return fail("Validation failed.", err.flatten().fieldErrors as Record<string, string[]>);
  }
  console.error("[storage action]", err);
  return fail("Something went wrong. Please try again.");
}

/* ------------------------------------------------------------------ */
/* PARENT OWNERSHIP                                                    */
/* ------------------------------------------------------------------ */

/**
 * Confirm the record a document is being attached to exists AND belongs to
 * this tenant.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FUNCTION HAS TO EXIST
 * ══════════════════════════════════════════════════════════════════════
 * The `(entity_type, entity_id)` link is polymorphic, so PostgreSQL cannot
 * back it with a foreign key — it does not know which table to look in.
 * Every guarantee a foreign key would have given us has to be re-created
 * here, in code, before the insert.
 *
 * And a plain existence check would not be enough even if we had an FK. A
 * foreign key proves a row EXISTS; it does not prove it is YOURS. Tenant B
 * passing tenant A's contract id would satisfy `EXISTS` perfectly. That is
 * why every branch below filters on `tenantId` as well as `id` — the same
 * reasoning behind the cross-tenant reference triggers added in Phase 2.
 */
async function parentBelongsToTenant(
  entityType: DocumentEntityTypeInput,
  entityId: string,
  tenantId: string,
): Promise<boolean> {
  switch (entityType) {
    case "contract": {
      const row = await db.query.contracts.findFirst({
        where: and(
          eq(contracts.id, entityId),
          eq(contracts.tenantId, tenantId),
          isNull(contracts.deletedAt),
        ),
        columns: { id: true },
      });
      return Boolean(row);
    }
    case "asset": {
      const row = await db.query.assets.findFirst({
        where: and(
          eq(assets.id, entityId),
          eq(assets.tenantId, tenantId),
          isNull(assets.deletedAt),
        ),
        columns: { id: true },
      });
      return Boolean(row);
    }
    case "deal": {
      const row = await db.query.deals.findFirst({
        where: and(
          eq(deals.id, entityId),
          eq(deals.tenantId, tenantId),
          isNull(deals.deletedAt),
        ),
        columns: { id: true },
      });
      return Boolean(row);
    }
    case "contact": {
      const row = await db.query.contacts.findFirst({
        where: and(
          eq(contacts.id, entityId),
          eq(contacts.tenantId, tenantId),
          isNull(contacts.deletedAt),
        ),
        columns: { id: true },
      });
      return Boolean(row);
    }
    case "company": {
      const row = await db.query.companies.findFirst({
        where: and(
          eq(companies.id, entityId),
          eq(companies.tenantId, tenantId),
          isNull(companies.deletedAt),
        ),
        columns: { id: true },
      });
      return Boolean(row);
    }
    default: {
      // Exhaustiveness guard. If a member is added to the enum and this
      // switch is not updated, TypeScript fails the build here rather than
      // letting an unchecked entity type through at runtime.
      const exhaustive: never = entityType;
      return exhaustive;
    }
  }
}

/** Where a given entity's detail page lives, for cache revalidation. */
function pathForEntity(entityType: DocumentEntityTypeInput, entityId: string): string {
  switch (entityType) {
    case "contract": return `/contracts/${entityId}`;
    case "asset": return `/assets/${entityId}`;
    case "deal": return `/deals/${entityId}`;
    case "contact": return `/contacts/${entityId}`;
    case "company": return `/companies/${entityId}`;
    default: return "/dashboard";
  }
}

/* ------------------------------------------------------------------ */
/* SAVE                                                                */
/* ------------------------------------------------------------------ */

export async function saveDocumentRecord(
  input: SaveDocumentInput,
): Promise<ActionResult<Document>> {
  try {
    const ctx = await requireTenantContext();
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("documents:create", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("storage.documents", ctx);
    const data = saveDocumentSchema.parse(input);

    // The MIME type is re-checked even though the upload token already
    // constrained it. This action is a public RPC endpoint in its own right
    // — anyone with a session can call it with any arguments, including
    // arguments no upload ever produced.
    if (!isAllowedMimeType(data.mimeType)) {
      return fail("That file type is not permitted.", {
        mimeType: ["Unsupported file type."],
      });
    }

    // The claimed storage path must sit inside THIS tenant's prefix. Without
    // this, a caller could register a row pointing at another tenant's
    // object and then download it through our own download route — the row
    // would pass RLS perfectly, because the row itself would be theirs.
    if (!pathnameBelongsToTenant(data.blobPathname, ctx.tenant.id)) {
      console.warn("[storage] rejected out-of-tenant pathname", {
        tenantId: ctx.tenant.id,
        pathname: data.blobPathname,
      });
      return fail("That file does not belong to this workspace.");
    }

    // The parent record must exist and be ours. See `parentBelongsToTenant`.
    const parentOk = await parentBelongsToTenant(
      data.entityType,
      data.entityId,
      ctx.tenant.id,
    );
    if (!parentOk) {
      return fail("The record this file is attached to could not be found.");
    }

    /**
     * ══════════════════════════════════════════════════════════════
     * THE ROW AND THE RESERVATION MUST LAND TOGETHER (Phase 15)
     * ══════════════════════════════════════════════════════════════
     * A document row without a storage reservation is a file the
     * customer is using and not being metered for — free storage that
     * compounds silently and shows up as a hosting bill nobody can
     * explain. A reservation without a row is the opposite: quota
     * consumed by a file that does not exist, so an honest customer is
     * eventually refused an upload for space they are not using.
     *
     * Both are silent. Neither throws. So they share one transaction
     * and `reserveStorageBytes` THROWS rather than logging — an upload
     * we cannot meter is an upload that did not happen.
     */
    const { period } = await getTenantMeteringContext(ctx.tenant.id);

    const created = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(documents)
        .values({
          // From the session. Never from `input`.
          tenantId: ctx.tenant.id,
          entityType: data.entityType,
          entityId: data.entityId,
          fileName: data.fileName,
          fileUrl: data.fileUrl,
          blobPathname: data.blobPathname,
          sizeBytes: data.sizeBytes,
          mimeType: data.mimeType,
          description: data.description ?? null,
          uploadedBy: ctx.user.id,
        })
        .returning();

      if (!row) return null;

      await reserveStorageBytes(tx, {
        tenantId: ctx.tenant.id,
        bytes: BigInt(data.sizeBytes),
        period,
      });

      return row;
    });

    if (!created) return fail("Could not record that file.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "document",
      resourceId: created.id,
      severity: "info",
      metadata: auditMeta({
        event: "document_uploaded",
        fileName: data.fileName,
        sizeBytes: data.sizeBytes,
        mimeType: data.mimeType,
        entityType: data.entityType,
        entityId: data.entityId,
      }),
    });

    revalidatePath(pathForEntity(data.entityType, data.entityId));
    return { ok: true, data: created };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

export type DocumentListItem = {
  id: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  description: string | null;
  createdAt: string;
  uploadedBy: string | null;
};

export async function getDocuments(input: {
  entityType: DocumentEntityTypeInput;
  entityId: string;
}): Promise<ActionResult<DocumentListItem[]>> {
  try {
    const ctx = await requireTenantContext();

    const params = z
      .object({
        entityType: z.enum(["contract", "asset", "deal", "contact", "company"]),
        entityId: z.string().uuid("Invalid record identifier."),
      })
      .parse(input);

    const rows = await db
      .select({
        id: documents.id,
        fileName: documents.fileName,
        sizeBytes: documents.sizeBytes,
        mimeType: documents.mimeType,
        description: documents.description,
        createdAt: documents.createdAt,
        uploadedBy: documents.uploadedBy,
      })
      .from(documents)
      .where(
        and(
          // Tenant predicate first. RLS enforces this independently; two
          // checks, either sufficient alone.
          eq(documents.tenantId, ctx.tenant.id),
          eq(documents.entityType, params.entityType),
          eq(documents.entityId, params.entityId),
          isNull(documents.deletedAt),
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(1000);

    return {
      ok: true,
      data: rows.map((r) => ({
        ...r,
        sizeBytes: Number(r.sizeBytes),
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* DELETE                                                              */
/* ------------------------------------------------------------------ */

/**
 * Remove a document.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ROW IS SOFT-DELETED; THE OBJECT IS HARD-DELETED
 * ══════════════════════════════════════════════════════════════════════
 * Those sound inconsistent. They are not.
 *
 * The ROW is evidence — it records that a file existed, who uploaded it and
 * who removed it. Destroying that erases the audit trail along with the
 * file. So `deleted_at` is stamped and the row stays.
 *
 * The OBJECT is the actual confidential content. When someone deletes a
 * misfiled salary annexure, "we hid it from the list" is not what they
 * asked for and not what a data-deletion obligation means. The bytes go.
 *
 * ORDER MATTERS, AND IT IS DELIBERATE:
 * The blob is deleted FIRST, then the row is stamped. If the blob delete
 * fails we abort and the row stays visible — the user sees the file still
 * listed and can retry, which is truthful. The other order would show a
 * file as deleted while its bytes remained, and nobody would ever find out.
 */
export async function deleteDocument(id: string): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requireTenantContext();
    // ACCOUNT STANDING FIRST, then plan, then person. Broadest
    // reason outermost, so the customer is told the thing they can
    // actually act on rather than an inner detail.
    await requireAccess("documents:delete", ctx);
    // ⚠️ A document delete removes BYTES from blob storage as well as
    // stamping the row. Nothing about it is reversible by the customer,
    // which is the whole test the forbidden list applies.
    await assertImpersonationAllows("delete:document", ctx);
    // ⚠️ ENTITLEMENT BEFORE PERMISSION. If a workspace owner on a plan
    // without this feature hits it, the true answer is "your plan does
    // not include it" — not "you lack permission", which would send the
    // owner to ask an administrator who is themselves.
    await requireFeature("storage.documents", ctx);
    const documentId = z.string().uuid("Invalid identifier.").parse(id);

    const existing = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.tenantId, ctx.tenant.id),
        isNull(documents.deletedAt),
      ),
    });

    // Deliberately the same message as a genuinely missing row. Telling a
    // caller "that exists but is not yours" confirms an id belongs to
    // someone — a small leak, but a free one to avoid.
    if (!existing) return fail("File not found.");

    // Defence in depth: even a row that passed RLS must point inside this
    // tenant's storage prefix before we delete any bytes.
    if (!pathnameBelongsToTenant(existing.blobPathname, ctx.tenant.id)) {
      console.error("[storage] refusing to delete out-of-tenant object", {
        tenantId: ctx.tenant.id,
        documentId,
      });
      return fail("That file does not belong to this workspace.");
    }

    // 1. The bytes.
    //
    // Storage unbound is checked FIRST and separately. Without this the
    // delete would throw and be reported as "please try again", which is
    // advice that can never work — the operator, not the user, has to act.
    if (!isStorageConfigured()) {
      return fail(STORAGE_UNCONFIGURED_MESSAGE);
    }

    try {
      await deleteStoredObject(existing.blobPathname);
    } catch (err) {
      console.error("[storage] R2 delete failed", err);
      return fail(
        "The file could not be removed from storage. Nothing was changed — please try again.",
      );
    }

    // 2. The row.
    const [deleted] = await db
      .update(documents)
      .set({ deletedAt: new Date(), deletedBy: ctx.user.id })
      .where(and(eq(documents.id, documentId), eq(documents.tenantId, ctx.tenant.id)))
      .returning({ id: documents.id });

    if (!deleted) return fail("File not found.");

    /**
     * Release the space — AFTER the row is stamped, OUTSIDE any
     * transaction, and best-effort.
     *
     * Deliberately not inside the delete's transaction: if the meter
     * update failed, rolling back would leave the blob already gone from
     * storage (step 1 above is irreversible) while the row survived —
     * a document the customer can see and can never open.
     *
     * The cost of the other direction is that a failed release leaves
     * the tenant metered for space they freed, which the nightly
     * `reconcileStorageLevel()` corrects. An over-count that self-heals
     * beats a dangling reference that does not.
     */
    await releaseStorageBytes(ctx.tenant.id, BigInt(existing.sizeBytes));

    await writeAudit(ctx, {
      action: "delete",
      resourceType: "document",
      resourceId: documentId,
      severity: "notice",
      metadata: auditMeta({
        event: "document_deleted",
        fileName: existing.fileName,
        entityType: existing.entityType,
        entityId: existing.entityId,
      }),
    });

    revalidatePath(
      pathForEntity(existing.entityType as DocumentEntityTypeInput, existing.entityId),
    );
    return { ok: true, data: { id: deleted.id } };
  } catch (err) {
    return toActionError(err);
  }
}
