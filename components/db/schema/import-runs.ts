/**
 * Ordence — ⭐⭐⭐ THE MIGRATION TABLES — SQL 0117 · WAVE 6
 * Version: v1.74.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE TABLES, AND NOT ONE OF THEM HOLDS THE CUSTOMER'S FILE
 * ══════════════════════════════════════════════════════════════════════
 * Same argument `data_exports` makes in 0116, in the other direction:
 * storing a migration file would be a second copy of a workspace's entire
 * master data, in a table nobody thinks of as sensitive, growing forever,
 * outliving the erasure meant to remove the original.
 *
 * The file stays on the customer's machine. `lib/import/plan.ts` is pure,
 * so the browser plans it there and submits it in chunks. These tables
 * hold what was expected, what arrived, and who decided what the columns
 * meant.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A SEPARATE SCHEMA FILE, AND NOT `db/schema/integrations.ts`
 * ══════════════════════════════════════════════════════════════════════
 * A migration is not an integration. An integration is an ongoing
 * relationship between two live systems; a migration happens once and
 * ends, and the interesting question about it is whether it FINISHED —
 * which no integration table has a column for.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./core";

/**
 * ⭐⭐⭐ ONE MIGRATION, ACROSS HOWEVER MANY CHUNKS THE BROWSER SENT.
 *
 * 🔴 `expectedRows` IS DECLARED BEFORE THE FIRST CHUNK AND COMPARED AT
 * THE END. Without it a run that lost its last chunk to a closed laptop
 * is indistinguishable from one that finished, and the customer believes
 * they migrated 40,000 records when 38,400 arrived.
 */
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /** ⚠️ RESTRICT. Offboarding a user must not delete the record of the
     * migration they ran — that record is how "where did these 40,000
     * records come from" is answered. */
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    entityKey: varchar("entity_key", { length: 60 }).notNull(),
    sourceFormat: varchar("source_format", { length: 20 }).notNull(),
    /** What they called the file. Not the file. */
    sourceName: varchar("source_name", { length: 255 }),
    /** Sheet, for a workbook with several. The wrong tab is a real failure. */
    sourceSheet: varchar("source_sheet", { length: 120 }),

    duplicateMode: varchar("duplicate_mode", { length: 10 }).notNull(),

    expectedRows: integer("expected_rows").notNull(),
    rowsWritten: integer("rows_written").default(0).notNull(),
    rowsSkipped: integer("rows_skipped").default(0).notNull(),
    rowsFailed: integer("rows_failed").default(0).notNull(),

    status: varchar("status", { length: 16 }).default("running").notNull(),
    stoppedReason: text("stopped_reason"),
  },
  (t) => ({
    tenantIdx: index("import_runs_tenant_idx").on(t.tenantId, t.startedAt),

    statusKnown: check(
      "import_runs_status_known",
      sql`${t.status} IN ('running', 'completed', 'incomplete', 'abandoned')`,
    ),
    /**
     * ⚠️ Kept in step with `IMPORT_SOURCE_FORMATS` in
     * `lib/import/sources/index.ts` by `scripts/check-import-sources.mjs`.
     */
    sourceFormatKnown: check(
      "import_runs_source_format_known",
      sql`${t.sourceFormat} IN ('csv', 'xlsx', 'json', 'tally-xml')`,
    ),
    countsSane: check(
      "import_runs_counts_sane",
      sql`${t.expectedRows} >= 0 AND ${t.rowsWritten} >= 0 AND ${t.rowsSkipped} >= 0 AND ${t.rowsFailed} >= 0`,
    ),
    /** 🔴 A run cannot report more outcomes than it had rows. */
    withinExpected: check(
      "import_runs_outcomes_within_expected",
      sql`${t.rowsWritten} + ${t.rowsSkipped} + ${t.rowsFailed} <= ${t.expectedRows}`,
    ),
    /** ⚠️ "Completed" means every row was accounted for, not "no error". */
    completedIsComplete: check(
      "import_runs_completed_is_complete",
      sql`${t.status} <> 'completed' OR ${t.rowsWritten} + ${t.rowsSkipped} + ${t.rowsFailed} = ${t.expectedRows}`,
    ),
    finishedHasTime: check(
      "import_runs_finished_has_time",
      sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`,
    ),
    stopNamed: check(
      "import_runs_stop_named",
      sql`${t.status} NOT IN ('incomplete', 'abandoned') OR ${t.stoppedReason} IS NOT NULL`,
    ),
  }),
);

/**
 * 🔴 WHAT MAKES A RETRY SAFE.
 *
 * A chunk that times out has often already committed, and the browser
 * cannot tell "never arrived" from "arrived and the answer was lost".
 * The unique index on (run, index) is the lock: a replayed chunk is
 * reported as already done rather than written again.
 *
 * ⚠️ BELT TO THE NATURAL-KEY BRACES, NOT INSTEAD OF THEM. The natural key
 * protects the ROWS from duplication; this protects the COUNTS.
 */
export const importRunChunks = pgTable(
  "import_run_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => importRuns.id, { onDelete: "cascade" }),

    chunkIndex: integer("chunk_index").notNull(),
    rowCount: integer("row_count").notNull(),
    rowsWritten: integer("rows_written").default(0).notNull(),
    rowsSkipped: integer("rows_skipped").default(0).notNull(),
    rowsFailed: integer("rows_failed").default(0).notNull(),

    committedAt: timestamp("committed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    once: uniqueIndex("import_run_chunks_once").on(t.runId, t.chunkIndex),
    runIdx: index("import_run_chunks_run_idx").on(t.tenantId, t.runId, t.chunkIndex),

    indexSane: check("import_run_chunks_index_sane", sql`${t.chunkIndex} >= 0`),
    countsSane: check(
      "import_run_chunks_counts_sane",
      sql`${t.rowCount} >= 0 AND ${t.rowsWritten} >= 0 AND ${t.rowsSkipped} >= 0 AND ${t.rowsFailed} >= 0 AND ${t.rowsWritten} + ${t.rowsSkipped} + ${t.rowsFailed} = ${t.rowCount}`,
    ),
  }),
);

/**
 * ⭐⭐ WHAT ORDENCE PROPOSED A CUSTOMER'S COLUMNS MEANT, AND WHO AGREED.
 *
 * 🔴 `corrections` IS THE MOST VALUABLE COLUMN IN THIS TABLE. Every entry
 * is a case the deterministic matcher got wrong, recorded by the only
 * process that can tell — a person who knew the answer.
 */
export const importMappingProposals = pgTable(
  "import_mapping_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => importRuns.id, { onDelete: "set null" }),

    proposedAt: timestamp("proposed_at", { withTimezone: true }).defaultNow().notNull(),
    proposedFor: uuid("proposed_for")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    entityKey: varchar("entity_key", { length: 60 }).notNull(),
    sourceHeaders: text("source_headers").array().notNull(),

    proposal: jsonb("proposal").notNull(),

    /**
     * 🔴 THE WEAKEST REQUIRED COLUMN, ×1000. Not the average: an average
     * lets nine certain columns carry one guess over the line, and the
     * guess is the one that puts four hundred PANs in the GSTIN field.
     */
    confidenceMilli: integer("confidence_milli").notNull(),

    /**
     * ⚠️ WAS A MODEL INVOLVED, AND WHOSE KEY PAID FOR IT. 0115 made
     * "whose credits" answerable for the assistant; a migration is the
     * single largest AI spend a new workspace generates, so it is
     * answerable here too.
     */
    usedModel: boolean("used_model").default(false).notNull(),
    modelSource: varchar("model_source", { length: 16 }),

    outcome: varchar("outcome", { length: 16 }).default("proposed").notNull(),
    corrections: jsonb("corrections").notNull().default({}),
  },
  (t) => ({
    tenantIdx: index("import_mapping_tenant_idx").on(t.tenantId, t.proposedAt),

    outcomeKnown: check(
      "import_mapping_outcome_known",
      sql`${t.outcome} IN ('proposed', 'confirmed', 'corrected', 'auto', 'discarded')`,
    ),
    confidenceRange: check(
      "import_mapping_confidence_range",
      sql`${t.confidenceMilli} BETWEEN 0 AND 1000`,
    ),
    /**
     * 🔴 THE DATABASE REFUSING TO HOLD A RECORD THAT CONTRADICTS THE CODE.
     * If this and `AUTO_COMMIT_THRESHOLD` ever disagree, the write fails
     * loudly here rather than the log quietly recording an auto-commit the
     * code says was impossible.
     */
    autoClearedThreshold: check(
      "import_mapping_auto_cleared_threshold",
      sql`${t.outcome} <> 'auto' OR ${t.confidenceMilli} >= 900`,
    ),
    correctedHasCorrections: check(
      "import_mapping_corrected_has_corrections",
      sql`${t.outcome} <> 'corrected' OR ${t.corrections} <> '{}'::jsonb`,
    ),
    modelSourceKnown: check(
      "import_mapping_model_source_known",
      sql`${t.modelSource} IS NULL OR ${t.modelSource} IN ('platform', 'tenant')`,
    ),
    /** ⭐ A model was either used, with a key, or not used at all. */
    modelPair: check(
      "import_mapping_model_pair",
      sql`${t.usedModel} = (${t.modelSource} IS NOT NULL)`,
    ),
  }),
);
