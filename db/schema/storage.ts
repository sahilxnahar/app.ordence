/**
 * Ordence — Document Storage Schema
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS TABLE IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * This table stores METADATA about files. The bytes live in Vercel Blob,
 * outside PostgreSQL entirely.
 *
 * That distinction is the single most important security fact in this
 * phase. Row-Level Security protects rows in this table. It does not — it
 * cannot — protect an object sitting in a blob store. If a file were
 * uploaded with `access: 'public'`, its URL would be readable by anyone on
 * the internet who ever saw it, forever, and no policy written here would
 * change that by one byte.
 *
 * So files are uploaded with `access: 'private'` and served through
 * `/api/documents/[id]/download`, which re-checks the session and the
 * tenant before streaming anything. RLS on this table and private access on
 * the blob are two halves of one control; either alone leaks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE ENTITY LINK IS POLYMORPHIC AND WHAT THAT COSTS
 * ══════════════════════════════════════════════════════════════════════
 * A document can hang off a contract, an asset or a deal. Three nullable
 * foreign-key columns would give real referential integrity but need a new
 * migration for every future entity type. `(entity_type, entity_id)` needs
 * none.
 *
 * The cost is honest and worth stating: **the database cannot enforce that
 * `entity_id` points at a row that exists**, because it does not know which
 * table to look in. That check lives in `saveDocumentRecord`, which
 * verifies the parent row exists AND belongs to the caller's tenant before
 * writing. A polymorphic link is a deliberate trade of one guarantee for
 * one degree of freedom — not a free lunch.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * Which kind of record a document is attached to.
 *
 * An enum rather than free text so a typo cannot silently create an
 * orphaned category that no screen ever queries. Adding a member is a
 * migration, which is the correct amount of friction for something that
 * changes how records are found.
 */
export const documentEntityTypeEnum = pgEnum("document_entity_type", [
  "contract",
  "asset",
  "deal",
  "contact",
  "company",
]);

/* ------------------------------------------------------------------ */
/* DOCUMENTS                                                           */
/* ------------------------------------------------------------------ */

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /* --- Polymorphic parent -------------------------------------- */
    entityType: documentEntityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),

    /* --- File identity ------------------------------------------- */

    /** The name the user recognises, e.g. "Sale Agreement — Unit 304.pdf". */
    fileName: varchar("file_name", { length: 400 }).notNull(),

    /**
     * The blob URL. For a private blob this is NOT directly fetchable
     * without authentication — it is stored so the object can be located,
     * not so it can be handed to a browser.
     */
    fileUrl: text("file_url").notNull(),

    /**
     * The blob's pathname within the store, e.g.
     * `tenants/<uuid>/contract/<uuid>/1753900000-agreement.pdf`.
     *
     * Kept as its own column rather than parsed out of `fileUrl` at read
     * time. Deletion and streaming both need it, and a URL-parsing helper
     * that is subtly wrong would mean deleting the wrong object — or, far
     * worse, failing to delete and reporting success.
     */
    blobPathname: text("blob_pathname").notNull(),

    /**
     * Size in bytes. `bigint` rather than `integer` because a 4 GB file
     * overflows a signed 32-bit integer, and a size that silently wraps
     * negative is a bug that only appears once someone uploads a video.
     */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),

    mimeType: varchar("mime_type", { length: 200 }).notNull(),

    /** Optional human note about what this file is. */
    description: text("description"),

    /* --- Provenance ---------------------------------------------- */
    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Soft delete, consistent with the rest of the platform.
     *
     * The blob object itself IS hard-deleted at the same moment — leaving
     * bytes in a store that the application believes are gone is how a
     * deletion request quietly fails to be a deletion. The row survives so
     * the audit trail can still answer "what was removed, by whom, when".
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    /* Tenant column FIRST in every index — it is in every WHERE clause. */
    tenantIdx: index("documents_tenant_idx").on(t.tenantId),

    /** The lookup the Document Vault performs on every page load. */
    entityIdx: index("documents_entity_idx").on(t.tenantId, t.entityType, t.entityId),

    createdIdx: index("documents_created_idx").on(t.tenantId, t.createdAt),

    /**
     * One row per blob object. Prevents a retried `saveDocumentRecord` from
     * creating a duplicate row pointing at the same file — which would then
     * let one delete remove the object while the other row still advertises
     * a download link to a file that is gone.
     */
    pathnameUnique: uniqueIndex("documents_blob_pathname_unique").on(t.blobPathname),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

/**
 * Only the relations a real foreign key backs. There is deliberately no
 * `contract`/`asset`/`deal` relation here: the polymorphic link has no FK,
 * so Drizzle could not join it, and declaring one would imply an integrity
 * guarantee that does not exist.
 */
export const documentsRelations = relations(documents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [documents.tenantId],
    references: [tenants.id],
  }),
  uploader: one(users, {
    fields: [documents.uploadedBy],
    references: [users.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentEntityType = (typeof documentEntityTypeEnum.enumValues)[number];
