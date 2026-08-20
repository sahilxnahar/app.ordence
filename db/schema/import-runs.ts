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
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  foreignKey,
  timestamp,
  unique,
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

    /* ------------------------------------------------------------------ */
    /* ⭐⭐ PHASE 2 · SQL 0207 — RUN-LEVEL IDEMPOTENCY                     */
    /* ------------------------------------------------------------------ */

    /**
     * ⭐⭐⭐ `sha256:<64 lower-case hex>` OVER THE BYTES OF THE SOURCE FILE.
     *
     * ══════════════════════════════════════════════════════════════════
     * 🔴 THE THIRD LAYER, AND THE FIRST ONE THAT IS ABOUT TWO RUNS
     * ══════════════════════════════════════════════════════════════════
     * The natural key protects the ROWS from duplication and
     * `import_run_chunks_once` protects the COUNTS — and both are scoped
     * to one run. Neither has anything to say about the same file being
     * started twice, which is the ordinary case: the wizard lives in a
     * browser and a customer watching nothing happen presses the button
     * again.
     *
     * Two runs over one file in `update` mode is not merely untidy. The
     * second run overwrites what the first wrote and CAPTURES THE FIRST
     * RUN'S VALUES AS THE PRIOR — so undoing run 2 restores the
     * migration, and undoing run 1 afterwards destroys what run 2 put
     * back. There is no order in which the customer can be told what
     * will happen.
     *
     * ⚠️ THE SERVER NEVER SEES THE BYTES, and that is deliberate — see
     * this file's own header. The fingerprint is computed in the browser
     * with WebCrypto; `importSourceFingerprint()` in
     * `server/import/runs.ts` is the same algorithm for callers that
     * genuinely have the bytes, such as a test.
     *
     * ⚠️ NULLABLE ONLY FOR RUNS THAT PRE-DATE 0207. `StartRunArgs` makes
     * it required, for the reason `lib/import/types.ts` gives about every
     * member of the contract: an optional one is a member the next six
     * callers omit.
     */
    sourceFingerprint: varchar("source_fingerprint", { length: 71 }),

    /**
     * ⭐ WHEN THIS RUN STOPPED HOLDING THE CLAIM ON ITS FILE.
     *
     * Set by a completed reversal, because a customer who has undone a
     * migration is entitled to import the same file again — that is what
     * undoing it was for.
     *
     * ⚠️ A DATE RATHER THAN A NEW `status` VALUE. "How did this run end"
     * and "does it still hold the file" are two questions, and putting
     * them in one column would mean reasoning about
     * `import_runs_finished_has_time` and `import_runs_stop_named` again
     * to express something neither of them is about.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededReason: text("superseded_reason"),

    /**
     * ⭐⭐ WHAT THE CUSTOMER WAS PROMISED, RECORDED WHEN IT WAS PROMISED.
     * SQL 0208 §0.
     *
     * 🔴 THE UNDO READS THIS AND NOT THE REGISTRY, and the first draft of
     * `server/import/reversal.ts` got it wrong — a run started when the
     * entity said "the welcome email has already gone out and removing the
     * records does not un-send it" would be undone, months later, under an
     * entity whose `escapes` had since been edited to `null`, and the
     * customer would be told that nothing survived.
     *
     * Same argument as `importRowProvenance.reversalKind`, one member over:
     * the contract is declared at DEFINITION time because at undo time the
     * entity that wrote the row may no longer be the one being asked.
     */
    reversalEscapes: text("reversal_escapes"),
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

    /**
     * ⭐ SO ANOTHER TABLE CAN POINT AT A RUN WITH A COMPOSITE KEY. SQL 0205.
     *
     * ⚠️ SINGLE-COLUMN FOREIGN KEYS ARE NOT ENOUGH IN THIS SCHEMA, and
     * 0021, 0146 and 0150 each say so at length: referential integrity
     * runs as the REFERENCED table's owner with row security OFF, so a
     * single-column FK happily resolves a run row the writing session
     * cannot even SELECT.
     */
    idTenantKey: unique("import_runs_id_tenant_key").on(t.id, t.tenantId),

    /**
     * 🔴 THE SHAPE, NOT MERELY THE PRESENCE. SQL 0207.
     *
     * A fingerprint that is the file NAME, or a truncated hash, or
     * upper-case hex, produces a claim that never collides with the one
     * the second browser tab computes — run-level idempotency that is
     * present, declared and inert, which is this repository's
     * characteristic defect in its purest form.
     */
    fingerprintShape: check(
      "import_runs_fingerprint_shape",
      sql`${t.sourceFingerprint} IS NULL OR ${t.sourceFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    supersededNamed: check(
      "import_runs_superseded_named",
      sql`(${t.supersededAt} IS NULL) = (${t.supersededReason} IS NULL)`,
    ),

    /**
     * ⭐⭐⭐ THE RUN-LEVEL CLAIM. THE INDEX IS THE MECHANISM.
     *
     * ⚠️ CHECKING FIRST AND INSERTING AFTER IS A RACE TWO BROWSER TABS
     * WILL LOSE — the argument `recordChunk` already makes for chunks,
     * unchanged. Letting the unique index refuse the second is the only
     * version that is correct without a lock held across the whole run.
     *
     * ⚠️ ALL THREE PREDICATES ARE LOAD-BEARING AND EACH REMOVAL IS A
     * DIFFERENT PRODUCT BUG:
     *   · without `source_fingerprint IS NOT NULL`, runs that pre-date
     *     0207 are swept into a claim they never made;
     *   · without `superseded_at IS NULL`, a customer can never
     *     re-import a file they undid;
     *   · without `status <> 'abandoned'`, they can never start again
     *     after walking away.
     *
     * ⚠️ AND `incomplete` IS DELIBERATELY NOT EXCLUDED. That is the case
     * the resume path exists for: `finishImportRun` tells the customer to
     * upload the same file again, and this index is what makes that land
     * in the SAME run rather than a second one.
     */
    oneLivePerSource: uniqueIndex("import_runs_one_live_per_source")
      .on(t.tenantId, t.entityKey, t.sourceFingerprint)
      .where(
        sql`${t.sourceFingerprint} IS NOT NULL AND ${t.supersededAt} IS NULL AND ${t.status} <> 'abandoned'`,
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


/* ────────────────────────────────────────────────────────────────────── */
/* ⭐⭐⭐ PHASE 2 — THE SIDECAR, THE CAPTURE, AND THE UNDO                */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHICH RUN PUT THIS ROW HERE, AND WHAT DID IT DO TO IT — SQL 0205
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `lib/import/types.ts` ATTRIBUTES THIS TABLE TO SQL 0196, WHICH DOES
 *    NOT EXIST. Track M1 reserved the number (its block is [196, 199] in
 *    `scripts/track-ownership.json`), described the table in a comment,
 *    made `provenance` a required member of every contract — and shipped
 *    no DDL. Measured on v1.84.1-alpha: the highest numbered migration is
 *    `0168`, and `import_row_provenance` appears in exactly one file in
 *    the repository, as prose. Phase 2 writes it as 0205; reusing 0196
 *    is the mistake `check:migrations` has already refused four times.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A SIDECAR AND NOT A COLUMN PAIR ON 313 TABLES
 * ══════════════════════════════════════════════════════════════════════
 * The obvious implementation adds `import_run_id` and `import_row_no` to
 * every destination. Each pair is a migration, an index, a schema change
 * on a live table and a column every non-import write leaves empty. One
 * table instead, written by the same transaction as the row it describes.
 *
 * ⚠️ AND IT IS WHAT MAKES REVERSAL POSSIBLE AT ALL. Without it the only
 * available answer to "which rows did this run create" is "rows created
 * between these two timestamps", which catches every row the customer's
 * staff typed by hand during the migration window. A migration takes
 * hours and the office does not stop.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 `operation` IS NOT IN THE BRIEF'S LIST AND THE UNDO CANNOT WORK
 *      WITHOUT IT
 * ══════════════════════════════════════════════════════════════════════
 * The brief describes the sidecar as holding "(run, entity, input row
 * number, target table, target id)". That set cannot undo a
 * `restore-prior` entity, and `companies` is one.
 *
 * A single run over one file in `update` mode does both of these, row by
 * row, decided by whether the natural key matched:
 *
 *     no match  → INSERT.  There is no prior. Undo = DELETE.
 *     matched   → UPDATE.  There is a prior. Undo = RESTORE.
 *
 * An undo that only restores leaves every row the run CREATED behind and
 * reports success. An undo that only deletes destroys the customer's
 * pre-existing records — the precise combination CI gate 29 refuses at
 * definition time, arrived at from the other side, at undo time, where
 * gate 29 cannot see it.
 *
 * Only the write path knows which happened, and only while it is
 * happening.
 */
export const importRowProvenance = pgTable(
  "import_row_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    runId: uuid("run_id").notNull(),
    entityKey: varchar("entity_key", { length: 60 }).notNull(),

    /**
     * ⚠️ NULL ONLY FOR `whole-file`. An opening trial balance is one
     * document assembled from every line in the file; there is no single
     * input row to name, and inventing one would make reconciliation
     * report 39 losses on a correct import.
     */
    inputRowNumber: integer("input_row_number"),

    /** Copied from `contract.provenance.cardinality` at write time. */
    cardinality: varchar("cardinality", { length: 12 }).notNull(),

    targetTable: varchar("target_table", { length: 63 }).notNull(),
    targetId: uuid("target_id").notNull(),

    /** 🔴 `insert` | `update`. See the header. */
    operation: varchar("operation", { length: 6 }).notNull(),

    /**
     * 🔴 THE KIND IN FORCE WHEN THE ROW WAS WRITTEN, COPIED — NOT LOOKED
     * UP AT UNDO TIME.
     *
     * `lib/import/types.ts` gives the reason the contract exists at all:
     * reversal is declared at DEFINITION time "because at undo time the
     * entity that wrote the row may no longer be the one being asked."
     * The same argument applies one level down. An entity whose kind is
     * changed from `delete` to `restore-prior` next quarter must not
     * change how a run written last quarter is undone — that run captured
     * no prior values, so a `restore-prior` undo of it would restore
     * nothing and say it had.
     */
    reversalKind: varchar("reversal_kind", { length: 16 }).notNull(),

    writtenAt: timestamp("written_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ⭐⭐ THE TRANSACTION THAT WROTE THE ROW, AS POSTGRES COUNTED IT.
     *
     * Filled by a BEFORE INSERT trigger (SQL 0205 §4), which refuses the
     * write unless the destination row's `xmin` is this transaction's id
     * — that is, unless the row and its provenance are committing
     * together. Passing a `tx` handle enforces the same thing in one
     * language, in one process, for as long as nobody opens a nested
     * `withTenant()` inside the loop. This is enforced against the heap.
     */
    writtenXid: bigint("written_xid", { mode: "bigint" }).notNull(),

    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalId: uuid("reversal_id"),
  },
  (t) => ({
    runIdx: index("import_row_provenance_run_idx").on(t.tenantId, t.runId, t.targetTable),
    targetIdx: index("import_row_provenance_target_idx").on(
      t.tenantId,
      t.targetTable,
      t.targetId,
    ),

    idTenantKey: unique("import_row_provenance_id_tenant_key").on(t.id, t.tenantId),

    runSameTenant: foreignKey({
      columns: [t.runId, t.tenantId],
      foreignColumns: [importRuns.id, importRuns.tenantId],
      name: "import_row_provenance_run_same_tenant",
    }).onDelete("cascade"),

    /**
     * ⚠️ ONE PROVENANCE ROW PER (run, destination row). A run that writes
     * the same destination row twice — two file rows sharing a natural
     * key — has written it once as far as an undo is concerned, and two
     * provenance rows would make the undo try twice and count the second
     * attempt as a failure ("row not found") on a correct import.
     */
    once: unique("import_row_provenance_once").on(t.runId, t.targetTable, t.targetId),

    operationKnown: check(
      "import_row_provenance_operation_known",
      sql`${t.operation} IN ('insert', 'update')`,
    ),
    cardinalityKnown: check(
      "import_row_provenance_cardinality_known",
      sql`${t.cardinality} IN ('one-to-one', 'many', 'whole-file')`,
    ),
    reversalKindKnown: check(
      "import_row_provenance_reversal_kind_known",
      sql`${t.reversalKind} IN ('delete', 'restore-prior', 'reverse-entry', 'irreversible')`,
    ),
    /**
     * ⚠️ THE ONLY PLACE THE THREE CARDINALITIES DIFFER IN THE DATA.
     * Without this a `one-to-one` entity that forgot to pass the row
     * number writes NULLs, and support loses the one question the sidecar
     * exists to answer.
     */
    rowNumberPresent: check(
      "import_row_provenance_row_number_present",
      sql`(${t.cardinality} = 'whole-file') = (${t.inputRowNumber} IS NULL)`,
    ),
    rowNumberSane: check(
      "import_row_provenance_row_number_sane",
      sql`${t.inputRowNumber} IS NULL OR ${t.inputRowNumber} >= 1`,
    ),
    /** ⚠️ Half of the pair is how a row becomes invisible to the next
     * undo with no record of what undid it. */
    reversalPair: check(
      "import_row_provenance_reversal_pair",
      sql`(${t.reversedAt} IS NULL) = (${t.reversalId} IS NULL)`,
    ),
  }),
);

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ WHAT THE ROW SAID BEFORE THE MIGRATION OVERWROTE IT — SQL 0206
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A SEPARATE TABLE AND NOT A NULLABLE COLUMN ON THE SIDECAR, because
 * the two assert OPPOSITE things about the same transaction:
 *
 *   provenance    the destination row's xmin MUST EQUAL this transaction
 *                 — the row and its attribution commit together.
 *   prior values  the destination row's xmin MUST NOT EQUAL it — the
 *                 values were read BEFORE this transaction overwrote them.
 *
 * ⭐ AND IT MAKES "DO NOT CAPTURE DEFENSIVELY" MEASURABLE. The cost of a
 * `delete` entity is a row count of zero, which a test can assert. As a
 * nullable column it would be a NULL per row, indistinguishable from a
 * capture that was attempted and lost.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE THIS IS BUILT AGAINST IS NOT A MISSING CAPTURE
 * ══════════════════════════════════════════════════════════════════════
 * A missing capture fails loudly at undo time. The failure that does not
 * is a capture taken ONE STATEMENT TOO LATE — after the UPDATE rather
 * than before it. There is a row, it has values in it, the undo runs, it
 * reports success, and it restores the values the import itself just
 * wrote. Both orderings compile.
 *
 * `observedXmin` is the destination row's `xmin` at the moment of the
 * READ, and SQL 0206 §3 refuses any row where it equals the writing
 * transaction — by name, with that sentence in the error.
 */
export const importRowPriorValues = pgTable(
  "import_row_prior_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    provenanceId: uuid("provenance_id").notNull(),
    runId: uuid("run_id").notNull(),

    targetTable: varchar("target_table", { length: 63 }).notNull(),
    targetId: uuid("target_id").notNull(),

    /**
     * ⚠️ THE DECLARATION, COPIED. `["*"]` means the whole row and is what
     * both contracted `restore-prior` entities use. Storing the list
     * rather than inferring it from the keys of `priorValues` is what
     * lets an undo tell "the author asked for three fields" from "the row
     * only had three non-null columns".
     */
    capturedFields: text("captured_fields").array().notNull(),

    /**
     * ⚠️ EVERY COLUMN THE CAPTURE ASKED FOR, INCLUDING THE NULLS. A field
     * that was NULL before the import and is absent here would come back
     * as "not restored" rather than "restored to NULL", and the row would
     * keep whatever the import put in it.
     */
    priorValues: jsonb("prior_values").notNull(),

    /** 🔴 The destination row's xmin AS READ. See the header. */
    observedXmin: bigint("observed_xmin", { mode: "bigint" }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index("import_row_prior_values_run_idx").on(t.tenantId, t.runId),

    idTenantKey: unique("import_row_prior_values_id_tenant_key").on(t.id, t.tenantId),

    provenanceSameTenant: foreignKey({
      columns: [t.provenanceId, t.tenantId],
      foreignColumns: [importRowProvenance.id, importRowProvenance.tenantId],
      name: "import_row_prior_values_provenance_same_tenant",
    }).onDelete("cascade"),

    runSameTenant: foreignKey({
      columns: [t.runId, t.tenantId],
      foreignColumns: [importRuns.id, importRuns.tenantId],
      name: "import_row_prior_values_run_same_tenant",
    }).onDelete("cascade"),

    onePerWrite: unique("import_row_prior_values_one_per_write").on(t.provenanceId),

    /**
     * ⭐⭐ THE FIRST CAPTURE WINS, AND THIS IS WHAT MAKES THAT TRUE.
     *
     * A file with two rows sharing a natural key updates the same
     * destination row twice in one run. The second capture would read
     * what the FIRST write left behind — the import's own values — and an
     * undo built on it restores the migration rather than removing it.
     * `writeRowWithLedger()` inserts with `onConflictDoNothing` against
     * this constraint, so the second capture is discarded and the true
     * prior survives.
     */
    firstWins: unique("import_row_prior_values_first_wins").on(
      t.runId,
      t.targetTable,
      t.targetId,
    ),

    /**
     * 🔴 AN EMPTY CAPTURE LIST IS THE SAME FAILURE AS A MISSING ONE: an
     * undo that runs, reports success and restores nothing.
     * `checkImportContract()` refuses it at definition time; this refuses
     * it at write time, and those are different moments.
     */
    fieldsNamed: check(
      "import_row_prior_values_fields_named",
      sql`array_length(${t.capturedFields}, 1) >= 1`,
    ),
    valuesPresent: check(
      "import_row_prior_values_values_present",
      sql`jsonb_typeof(${t.priorValues}) = 'object' AND ${t.priorValues} <> '{}'::jsonb`,
    ),
  }),
);

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ ONE ATTEMPT TO UNDO ONE RUN — SQL 0208
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SENTENCE THIS TABLE EXISTS TO MAKE IMPOSSIBLE is "your migration
 * has been reversed", said over a run where 900 of 1,000 rows came back.
 *
 * The consequence is not embarrassment. The customer believes the failed
 * migration is gone and starts again on top of it — importing the
 * corrected file over a hundred rows that were never removed, in `skip`
 * mode, where they are matched by natural key, reported as "already
 * here", and never looked at again.
 *
 * TWO CONTROLS, AND THE SECOND IS THE UNUSUAL ONE:
 *   ① `reversed` requires `rowsUnreversed = 0`. An ordinary CHECK; it
 *      stops the status contradicting the number beside it.
 *   ② SQL 0208 §4 requires every unreversed row to be NAMED, one row each
 *      in `import_reversal_failures`. A reversal that says 100 and names
 *      three satisfies ① perfectly: the count is honest and the report is
 *      useless. That true-summary-over-absent-detail shape is this
 *      codebase's characteristic defect, and a CHECK cannot see it,
 *      because the evidence is in another table.
 */
export const importReversals = pgTable(
  "import_reversals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    runId: uuid("run_id").notNull(),
    entityKey: varchar("entity_key", { length: 60 }).notNull(),

    /**
     * ⚠️ THE KIND THIS REVERSAL ACTED UNDER, read from the provenance
     * rows rather than from the entity definition — for the reason
     * `importRowProvenance.reversalKind` gives.
     */
    kind: varchar("kind", { length: 16 }).notNull(),

    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    /** ⚠️ RESTRICT, as `startedBy` is: offboarding the person who undid a
     * migration must not delete the record that it was undone. */
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    status: varchar("status", { length: 10 }).default("running").notNull(),

    rowsConsidered: integer("rows_considered").default(0).notNull(),
    rowsReversed: integer("rows_reversed").default(0).notNull(),
    rowsUnreversed: integer("rows_unreversed").default(0).notNull(),

    /**
     * ⭐ THE SENTENCE THE CUSTOMER WAS SHOWN BEFORE THE RUN, AS IT WAS
     * SHOWN. `contract.reversal.escapes` is a first-class output — the
     * planner puts it on screen BEFORE a migration starts. Storing it
     * means "what did we tell them would survive this?" is answered with
     * the string they saw, not the string in the code today.
     */
    escapes: text("escapes"),

    refusalReason: text("refusal_reason"),

    /** For `reverse-entry`: the compensating record this reversal posted. */
    reversingTransactionId: uuid("reversing_transaction_id"),
  },
  (t) => ({
    runIdx: index("import_reversals_run_idx").on(t.tenantId, t.runId, t.requestedAt),

    idTenantKey: unique("import_reversals_id_tenant_key").on(t.id, t.tenantId),

    runSameTenant: foreignKey({
      columns: [t.runId, t.tenantId],
      foreignColumns: [importRuns.id, importRuns.tenantId],
      name: "import_reversals_run_same_tenant",
    }).onDelete("cascade"),

    /**
     * ⚠️ ONE LIVE ATTEMPT PER RUN. The undo button is a button, and a
     * customer watching nothing happen presses it again. Two concurrent
     * reversals would each read the same unreversed provenance rows and
     * each try to delete the same destination row; the loser records a
     * failure against a row that was reversed perfectly well, and the
     * report names rows that are gone.
     */
    oneLivePerRun: uniqueIndex("import_reversals_one_live_per_run")
      .on(t.runId)
      .where(sql`${t.status} = 'running'`),

    /**
     * ⚠️ AND ONE SUCCESS. A second reversal after a PARTIAL one is the
     * retry the customer is told to make and must stay possible; a second
     * one after a complete reversal has nothing to do and would report
     * zero rows considered, which reads like a failure.
     */
    oneSuccessPerRun: uniqueIndex("import_reversals_one_success_per_run")
      .on(t.runId)
      .where(sql`${t.status} = 'reversed'`),

    kindKnown: check(
      "import_reversals_kind_known",
      sql`${t.kind} IN ('delete', 'restore-prior', 'reverse-entry', 'irreversible')`,
    ),
    statusKnown: check(
      "import_reversals_status_known",
      sql`${t.status} IN ('running', 'reversed', 'partial', 'refused', 'failed')`,
    ),
    countsSane: check(
      "import_reversals_counts_sane",
      sql`${t.rowsConsidered} >= 0 AND ${t.rowsReversed} >= 0 AND ${t.rowsUnreversed} >= 0 AND ${t.rowsReversed} + ${t.rowsUnreversed} <= ${t.rowsConsidered}`,
    ),

    /** 🔴 ①. THE HEADLINE. "Reversed" means every row came back. */
    reversedIsComplete: check(
      "import_reversals_reversed_is_complete",
      sql`${t.status} <> 'reversed' OR (${t.rowsUnreversed} = 0 AND ${t.rowsReversed} = ${t.rowsConsidered})`,
    ),
    /**
     * ⚠️ AND THE OTHER DIRECTION, WHICH IS NOT DECORATION. A reversal
     * that reversed everything and filed itself as `partial` would leave
     * the customer believing rows are still there when they are not, and
     * send support looking for a failure that never happened.
     */
    partialIsPartial: check(
      "import_reversals_partial_is_partial",
      sql`${t.status} <> 'partial' OR ${t.rowsUnreversed} > 0`,
    ),
    /**
     * 🔴 `irreversible` NEVER REVERSES ANYTHING. A row saying
     * kind = 'irreversible', status = 'reversed' would be the product
     * claiming it un-sent an email.
     */
    irreversibleRefuses: check(
      "import_reversals_irreversible_refuses",
      sql`${t.kind} <> 'irreversible' OR (${t.status} IN ('running', 'refused') AND ${t.rowsReversed} = 0)`,
    ),
    explained: check(
      "import_reversals_explained",
      sql`${t.status} NOT IN ('refused', 'failed') OR ${t.refusalReason} IS NOT NULL`,
    ),
    finishedHasTime: check(
      "import_reversals_finished_has_time",
      sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`,
    ),
    reversingEntryKind: check(
      "import_reversals_reversing_entry_kind",
      sql`${t.reversingTransactionId} IS NULL OR ${t.kind} = 'reverse-entry'`,
    ),
  }),
);

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ NAME THE HUNDRED — SQL 0208 §2
 * ══════════════════════════════════════════════════════════════════════
 * One row per row an undo could not undo, and what blocked each one.
 *
 * 🔴 `blockedBy` IS THE COLUMN THIS TABLE EXISTS FOR. "Row 412, invoice
 * INV-0412: a payment has been recorded against it since the import." Not
 * "failed". A customer told that a hundred rows are still there, and
 * given no way to find them, has been handed a number rather than an
 * answer — and will start their migration again on top of those rows.
 */
export const importReversalFailures = pgTable(
  "import_reversal_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    reversalId: uuid("reversal_id").notNull(),

    /**
     * ⚠️ NULLABLE, AND THE NULL CASE IS REAL. A reversal can fail for the
     * whole run rather than per row — the entity is gone from the
     * registry, the destination table is refused outright. That is one
     * failure with no provenance row behind it, and forcing a fake one
     * would put an id in the customer's report that does not exist.
     */
    provenanceId: uuid("provenance_id"),

    targetTable: varchar("target_table", { length: 63 }),
    targetId: uuid("target_id"),
    inputRowNumber: integer("input_row_number"),

    blockedBy: text("blocked_by").notNull(),

    /** ⚠️ `42501` and `23503` send support to two completely different places. */
    sqlstate: varchar("sqlstate", { length: 5 }),

    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reversalIdx: index("import_reversal_failures_reversal_idx").on(t.tenantId, t.reversalId),

    reversalSameTenant: foreignKey({
      columns: [t.reversalId, t.tenantId],
      foreignColumns: [importReversals.id, importReversals.tenantId],
      name: "import_reversal_failures_reversal_same_tenant",
    }).onDelete("cascade"),

    provenanceSameTenant: foreignKey({
      columns: [t.provenanceId, t.tenantId],
      foreignColumns: [importRowProvenance.id, importRowProvenance.tenantId],
      name: "import_reversal_failures_provenance_same_tenant",
    }).onDelete("cascade"),

    once: unique("import_reversal_failures_once").on(t.reversalId, t.provenanceId),

    /**
     * ⚠️ A BLANK REASON IS THE SAME DEFECT AS A MISSING ROW, WEARING A
     * VALUE. "failed" and "error" are not answers, and this string is the
     * whole content of the report the customer is given.
     */
    named: check(
      "import_reversal_failures_named",
      sql`length(btrim(${t.blockedBy})) >= 10`,
    ),
    targetPair: check(
      "import_reversal_failures_target_pair",
      sql`(${t.targetTable} IS NULL) = (${t.targetId} IS NULL)`,
    ),
  }),
);
