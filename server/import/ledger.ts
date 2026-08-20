import "server-only";

/**
 * Ordence — ⭐⭐⭐ WHAT A MIGRATION DID, ROW BY ROW, SO IT CAN BE UNDONE
 * Version: v1.84.1-alpha · Phase 2
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TABLE THIS FILE WRITES DID NOT EXIST WHEN THIS PHASE STARTED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/types.ts` says twice that `import_row_provenance` is written
 * "by the same transaction as the row it describes — see SQL 0196", and the
 * Phase 2 brief repeats it. Measured on the delivered v1.84.1-alpha tree:
 * the highest numbered migration is `0168`, and the string
 * `import_row_provenance` occurs in exactly one file in the repository —
 * that comment. Track M1 reserved the number, made `provenance` a required
 * member of every contract, and shipped no DDL.
 *
 * So every entity in `ALL_IMPORT_ENTITIES` currently declares a provenance
 * policy pointing at a table that has never existed. Declared and
 * unenforced, which is the defect the contract's own header says it was
 * written to remove. SQL 0205 writes the table; this file writes the rows.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SHAPE: ONE CALL, NOT FOUR
 * ══════════════════════════════════════════════════════════════════════
 * Recording a write correctly is four ordered steps, and three of the four
 * orderings are silently wrong:
 *
 *   1. read the prior values          ← BEFORE the overwrite, or they are
 *                                       the import's own values
 *   2. write the row
 *   3. record provenance              ← in the SAME transaction as 2
 *   4. store the prior values         ← same transaction again
 *
 * A writer that does 1 after 2 produces an undo that restores the
 * migration. A writer that does 3 in its own `withTenant()` — which is
 * what every branch of `writeRow` in `server/actions/import.ts` does today
 * — produces rows no undo can find. Both compile.
 *
 * ⭐ SO THE ONLY EXPORT A WRITER NEEDS IS `writeRowWithLedger`, which takes
 * the write itself as a callback and does the other three around it. The
 * order is not a rule a reviewer has to check; there is no way to express
 * the wrong one.
 *
 * ⚠️ AND THE DATABASE STILL CHECKS. A helper is a convention — the next
 * writer can always not call it. SQL 0205 §4 refuses a provenance row
 * unless the destination row's `xmin` is the writing transaction's own id,
 * and SQL 0206 §3 refuses a capture whose observed `xmin` IS that id. Both
 * are properties of the heap, not of this file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE COLUMN THE BRIEF DOES NOT LIST AND THE UNDO CANNOT WORK WITHOUT
 * ══════════════════════════════════════════════════════════════════════
 * The brief describes the sidecar as "(run, entity, input row number,
 * target table, target id)". That set cannot undo `companies`, which
 * offers duplicate mode `update` and declares `restore-prior`.
 *
 * One run over one file does both of these, row by row, decided by whether
 * the natural key matched:
 *
 *     no match  → INSERT.  There is no prior. Undo = DELETE.
 *     matched   → UPDATE.  There is a prior. Undo = RESTORE.
 *
 * An undo that only restores leaves every row the run CREATED behind and
 * reports success. An undo that only deletes destroys the customer's
 * pre-existing records — the exact combination CI gate 29 refuses at
 * definition time, arrived at from the other side at undo time, where gate
 * 29 cannot see it. `operation` is where the write path says which it did,
 * and it is the only moment anything knows.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  importRowPriorValues,
  importRowProvenance,
} from "@/db/schema/import-runs";
import type { ContractedImportEntity } from "@/lib/import/types";

/**
 * The transaction handle `withTenant()` hands its callback.
 *
 * ⚠️ DERIVED FROM `withTenant` RATHER THAN IMPORTED FROM DRIZZLE. `db/index.ts`
 * does not export a name for it, and restating the drizzle generic here would
 * be a second model of the same type that can drift from the first — which is
 * the failure `scripts/check-import-contract.mjs` refuses to risk by importing
 * the real modules instead of regexing them.
 */
export type LedgerTx = Parameters<Parameters<typeof withTenant>[1]>[0];

export class ImportLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportLedgerError";
  }
}

/**
 * ⚠️ THE TWO DRIVERS DISAGREE ABOUT THE SHAPE OF A RAW RESULT, and this
 * repository already carries the same three-line reconciliation in nine
 * files. `neon-http` resolves to an array; `neon-serverless` (which is what
 * `withTenant` uses) resolves to a `QueryResult` with `.rows`. Reading the
 * wrong one gives `undefined` rather than an error.
 */
/**
 * 🔴 THE DRIVER'S WRAPPER IS NOT THE DATABASE'S SENTENCE.
 *
 * Drizzle rethrows a failed statement as `Failed query: insert into
 * "import_row_provenance" … params: …`, with the real error on `.cause`.
 * That wrapper is what a caller sees, what a report would print and what a
 * customer would be shown — and it contains no SQLSTATE, no constraint
 * name, and none of the explanation the trigger raising it wrote.
 *
 * ⚠️ THE INNERMOST ERROR CARRYING A FIVE-CHARACTER SQLSTATE IS THE ONE
 * POSTGRES RAISED. Taking the outermost, or the first with a `message`,
 * gets the wrapper back.
 *
 * ⚠️ EXPORTED, AND `server/import/reversal.ts` IMPORTS IT RATHER THAN
 * RESTATING IT. Two copies of one unwrapping rule is how one of them stops
 * matching the driver after an upgrade — and the symptom would be a
 * customer-facing failure report full of SQL text.
 */
export function rootCause(err: unknown): {
  message?: string;
  code?: string;
  detail?: string;
} {
  let current = err as { message?: string; code?: string; detail?: string; cause?: unknown };
  let best = current;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string" && current.code.length === 5) best = current;
    current = current.cause as typeof current;
  }
  return best;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** A jsonb bind, so no value is ever concatenated into SQL. */
function jsonParam(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

/**
 * `text[]` from a jsonb array.
 *
 * ⚠️ NOT A DIRECT ARRAY BIND. How a JS array reaches Postgres depends on
 * which driver is underneath and on whether the parameter's type can be
 * inferred from context; going through jsonb is the same on both and cannot
 * be affected by a driver upgrade.
 */
function textArrayParam(values: readonly string[]) {
  return sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

/* ------------------------------------------------------------------ */
/* PRIOR VALUES                                                        */
/* ------------------------------------------------------------------ */

export type PriorSnapshot = {
  readonly targetTable: string;
  readonly targetId: string;
  readonly capturedFields: readonly string[];
  readonly priorValues: Record<string, unknown>;
  /** The destination row's `xmin` at the moment of the read. Evidence. */
  readonly observedXmin: string;
};

/**
 * ⭐⭐ READ WHAT THE ROW SAYS, BEFORE ANYTHING OVERWRITES IT.
 *
 * ⚠️ CALL THIS BEFORE THE WRITE OR NOT AT ALL. Called after, it returns the
 * import's own values and every undo built on them restores the migration.
 * `writeRowWithLedger` is the reason no caller has to remember that;
 * SQL 0206 §3 is the reason forgetting it is a refusal rather than a
 * silently wrong undo.
 *
 * Returns `null` when there is no such row — which is the ordinary answer
 * for an insert and the reason this is not called for one.
 */
export async function capturePriorSnapshot(
  tx: LedgerTx,
  args: {
    readonly tenantId: string;
    readonly targetTable: string;
    readonly targetId: string;
    readonly fields: readonly string[];
  },
): Promise<PriorSnapshot | null> {
  if (args.fields.length === 0) {
    /**
     * 🔴 THE SAME REFUSAL `checkImportContract()` MAKES, AT THE OTHER END OF
     * THE LIFECYCLE. An entity can be edited after CI ran; a capture list
     * that has become empty between the gate and the write would produce an
     * undo that runs, reports success and restores nothing.
     */
    throw new ImportLedgerError(
      `Entity writing "${args.targetTable}" asked to capture prior values and named no ` +
        `fields. An undo that restores nothing while reporting that it did is worse than ` +
        `one that refuses.`,
    );
  }

  const result = await tx.execute(sql`
    SELECT prior_values, observed_xmin::text AS observed_xmin
      FROM import_capture_prior_values(
        ${args.targetTable},
        ${args.targetId}::uuid,
        ${args.tenantId}::uuid,
        ${textArrayParam(args.fields)}
      )
  `);

  const row = rowsOf<{ prior_values: unknown; observed_xmin: string }>(result)[0];
  if (!row) return null;

  return {
    targetTable: args.targetTable,
    targetId: args.targetId,
    capturedFields: args.fields,
    priorValues: (row.prior_values ?? {}) as Record<string, unknown>,
    observedXmin: String(row.observed_xmin),
  };
}

/* ------------------------------------------------------------------ */
/* THE ONE CALL A WRITER MAKES                                         */
/* ------------------------------------------------------------------ */

export type LedgerWrite = {
  readonly provenanceId: string;
  readonly targetId: string;
  readonly operation: "insert" | "update";
  /**
   * `captured` when this write stored prior values; `already-captured` when
   * an earlier row of the SAME run had already captured this destination
   * row and the first capture was kept; `not-required` for every other
   * reversal kind and for inserts.
   */
  readonly prior: "captured" | "already-captured" | "not-required";
};

/**
 * ⭐⭐⭐ WRITE ONE ROW AND ITS LEDGER ENTRY, INSEPARABLY.
 *
 * `write` is the entity's own insert or update. It receives the SAME `tx`
 * and must return the id of the destination row it wrote.
 *
 * ⚠️ IT MUST NOT OPEN ITS OWN TRANSACTION. Every branch of `writeRow` in
 * `server/actions/import.ts` currently calls `withTenant()` internally, which
 * would put the row in a transaction that has already committed by the time
 * provenance is written — and SQL 0205 §4 refuses that by name, with the
 * two transaction ids in the message. Phase 1 owns those writers; the
 * change is set out in PATCH-REQUEST-PHASE-2.md.
 */
export async function writeRowWithLedger(
  tx: LedgerTx,
  args: {
    readonly tenantId: string;
    readonly runId: string;
    readonly entityKey: string;
    readonly entity: ContractedImportEntity;
    /** `null` only for a `whole-file` entity. */
    readonly inputRowNumber: number | null;
    /** The row this write MATCHED, or `null` when it is creating one. */
    readonly existingId: string | null;
    readonly write: (tx: LedgerTx) => Promise<string>;
  },
): Promise<LedgerWrite> {
  const { contract, table } = args.entity;
  const { cardinality } = contract.provenance;
  const kind = contract.reversal.kind;
  const operation: "insert" | "update" = args.existingId ? "update" : "insert";

  /**
   * ⚠️ THE CARDINALITY AND THE ROW NUMBER ARE ONE STATEMENT, NOT TWO.
   * `import_row_provenance_row_number_present` says the same thing in the
   * database; saying it here too means the writer is told which of its two
   * arguments is wrong rather than being handed a constraint name.
   */
  if (cardinality === "whole-file" && args.inputRowNumber !== null) {
    throw new ImportLedgerError(
      `Entity "${args.entityKey}" declares cardinality "whole-file" — one document ` +
        `assembled from every line of the file — and this write named input row ` +
        `${args.inputRowNumber}. Attributing a whole-file document to one line would make ` +
        `reconciliation report every other line as lost.`,
    );
  }
  if (cardinality !== "whole-file" && args.inputRowNumber === null) {
    throw new ImportLedgerError(
      `Entity "${args.entityKey}" declares cardinality "${cardinality}" and this write ` +
        `named no input row. "Which line of my file produced this row" is the question the ` +
        `sidecar exists to answer, and a NULL is not an answer.`,
    );
  }

  /* ---- 1. the prior values, BEFORE the write ---------------------- */
  /**
   * ⚠️ ONLY FOR THE ONE COMBINATION THAT READS THEM, and the brief asks for
   * that by name: *"Capture is not free and it is not universal. An entity
   * declaring `delete` must not pay for it."*
   *
   * `restore-prior` AND `update`. An INSERT under `restore-prior` has no
   * prior — the run created that row, and its undo is a delete. Capturing
   * for it would write a copy of a row that did not exist.
   */
  let snapshot: PriorSnapshot | null = null;
  if (kind === "restore-prior" && operation === "update" && args.existingId) {
    snapshot = await capturePriorSnapshot(tx, {
      tenantId: args.tenantId,
      targetTable: table,
      targetId: args.existingId,
      fields: contract.reversal.capturePriorFields ?? [],
    });
    if (!snapshot) {
      throw new ImportLedgerError(
        `Row ${args.existingId} in "${table}" was matched as an existing record but cannot ` +
          `be read back in this workspace. Nothing has been written: an update whose prior ` +
          `values could not be captured is an update that cannot be undone.`,
      );
    }
  }

  /* ---- 2. the entity's own write ---------------------------------- */
  const targetId = await args.write(tx);

  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new ImportLedgerError(
      `The writer for "${args.entityKey}" returned no destination row id. A row whose id is ` +
        `not returned is a row with no provenance, which is a row no undo can find and no ` +
        `reconciliation can count.`,
    );
  }
  if (operation === "update" && targetId !== args.existingId) {
    /**
     * 🔴 A WRITER THAT MATCHED ONE ROW AND WROTE ANOTHER. Rare, and the
     * consequence is not rare at all: the prior values captured above belong
     * to `existingId` and the undo would write them into `targetId`,
     * overwriting a second customer record with the contents of a first.
     */
    throw new ImportLedgerError(
      `The writer for "${args.entityKey}" matched row ${args.existingId} and wrote row ` +
        `${targetId}. The prior values captured belong to the row it matched; restoring them ` +
        `into the row it wrote would overwrite one customer record with another.`,
    );
  }

  /* ---- 3. provenance, same transaction ---------------------------- */
  /**
   * ⚠️ WRAPPED, SO THE DATABASE'S OWN SENTENCE REACHES THE CALLER.
   * `import_row_provenance_same_transaction` raises with both transaction
   * ids in the message and an explanation of why they have to match;
   * unwrapped, the caller sees only drizzle's `Failed query: insert into
   * "import_row_provenance" … params: …`, which names the symptom and
   * hides the cause.
   */
  const provenance = await insertProvenance(tx, {
      tenantId: args.tenantId,
      runId: args.runId,
      entityKey: args.entityKey,
      inputRowNumber: args.inputRowNumber,
      cardinality,
      targetTable: table,
      targetId,
      operation,
      reversalKind: kind,
      /**
       * ⚠️ A PLACEHOLDER, AND THE TRIGGER OVERWRITES IT. The column is NOT
       * NULL because it is evidence; the value is the database's own
       * `pg_current_xact_id()`, taken inside the BEFORE INSERT trigger, so a
       * caller cannot supply one. Sending `0n` and having it replaced is the
       * shape that makes "the caller does not decide this" true rather than
       * merely intended.
       */
      writtenXid: 0n,
  });

  /* ---- 4. and the capture, same transaction again ----------------- */
  let prior: LedgerWrite["prior"] = "not-required";
  if (snapshot) {
    /**
     * ⭐⭐ `onConflictDoNothing` AGAINST `import_row_prior_values_first_wins`,
     * AND THE FIRST CAPTURE IS THE ONE THAT MATTERS.
     *
     * A file with two rows sharing a natural key updates the same
     * destination row twice in one run. The second capture read what the
     * FIRST write left behind — the import's own values — so keeping it
     * would produce an undo that restores the migration. The unique index
     * discards it and the true prior survives.
     *
     * ⚠️ AND THE CHECK THAT WOULD OTHERWISE REFUSE IT IS AN `AFTER` TRIGGER
     * (SQL 0206 §3) for exactly this reason: a BEFORE trigger fires for a row
     * ON CONFLICT then discards, and would refuse the correct second capture.
     */
    const inserted = await tx
      .insert(importRowPriorValues)
      .values({
        tenantId: args.tenantId,
        provenanceId: provenance.id,
        runId: args.runId,
        targetTable: snapshot.targetTable,
        targetId: snapshot.targetId,
        capturedFields: [...snapshot.capturedFields],
        priorValues: snapshot.priorValues,
        observedXmin: BigInt(snapshot.observedXmin),
      })
      .onConflictDoNothing()
      .returning({ id: importRowPriorValues.id });

    prior = inserted.length > 0 ? "captured" : "already-captured";

    if (prior === "already-captured") {
      /**
       * 🔴 AND THEN THE PROVENANCE ROW MUST GO TOO, because SQL 0206 §4
       * requires exactly one capture per (restore-prior, update) provenance
       * row and would refuse the whole transaction at COMMIT.
       *
       * ⚠️ THAT IS NOT A WORKAROUND — IT IS THE RIGHT ANSWER. The run has
       * already recorded that it overwrote this destination row, once, with
       * the true prior beside it. A second provenance row for the same
       * (run, table, id) is refused by `import_row_provenance_once` anyway,
       * for the reason that index gives: it would make the undo try twice and
       * count the second attempt as a failure on a correct import.
       */
      await tx
        .delete(importRowProvenance)
        .where(
          and(
            eq(importRowProvenance.id, provenance.id),
            eq(importRowProvenance.tenantId, args.tenantId),
          ),
        );
      return {
        provenanceId: provenance.id,
        targetId,
        operation,
        prior: "already-captured",
      };
    }
  }

  return { provenanceId: provenance.id, targetId, operation, prior };
}

/**
 * ⚠️ ONE PLACE, SO THE UNWRAPPING CANNOT BE FORGOTTEN AT ONE CALL SITE.
 */
async function insertProvenance(
  tx: LedgerTx,
  values: typeof importRowProvenance.$inferInsert,
): Promise<{ id: string }> {
  try {
    const [row] = await tx
      .insert(importRowProvenance)
      .values(values)
      .returning({ id: importRowProvenance.id });
    if (row) return row;
  } catch (err) {
    const cause = rootCause(err);
    throw new ImportLedgerError(
      cause.message ??
        `Provenance for row ${values.targetId} in "${values.targetTable}" was refused and the ` +
          `database gave no reason.`,
    );
  }
  throw new ImportLedgerError(
    `Provenance for row ${values.targetId} in "${values.targetTable}" was not recorded. Nothing ` +
      `has been committed — the row and its provenance are in one transaction precisely so that ` +
      `neither can exist without the other.`,
  );
}

/* ------------------------------------------------------------------ */
/* READING THE LEDGER BACK                                             */
/* ------------------------------------------------------------------ */

export type LedgerRow = {
  readonly provenanceId: string;
  readonly inputRowNumber: number | null;
  readonly targetTable: string;
  readonly targetId: string;
  readonly operation: "insert" | "update";
  readonly reversalKind: string;
  readonly cardinality: string;
  readonly reversedAt: Date | null;
  readonly capturedFields: string[] | null;
  readonly priorValues: Record<string, unknown> | null;
};

/**
 * ⭐ EVERYTHING A RUN WROTE, WITH ITS CAPTURED PRIORS ALONGSIDE.
 *
 * ⚠️ A LEFT JOIN, NOT AN INNER ONE. Most rows have no capture and should
 * not: an inner join would silently return only the updates and an undo
 * built on it would leave every created row behind, reporting success.
 *
 * ⚠️ ORDERED BY INPUT ROW NUMBER so the failure report reads in the same
 * order as the customer's file. `NULLS FIRST` puts the whole-file document,
 * which has no line number, at the top where it belongs.
 */
export async function readRunLedger(
  tx: LedgerTx,
  args: {
    readonly tenantId: string;
    readonly runId: string;
    /** Skip rows an earlier reversal already undid. */
    readonly unreversedOnly?: boolean;
  },
): Promise<LedgerRow[]> {
  const result = await tx.execute(sql`
    SELECT p.id                AS provenance_id,
           p.input_row_number  AS input_row_number,
           p.target_table      AS target_table,
           p.target_id         AS target_id,
           p.operation         AS operation,
           p.reversal_kind     AS reversal_kind,
           p.cardinality       AS cardinality,
           p.reversed_at       AS reversed_at,
           v.captured_fields   AS captured_fields,
           v.prior_values      AS prior_values
      FROM import_row_provenance p
      LEFT JOIN import_row_prior_values v
             ON v.provenance_id = p.id AND v.tenant_id = p.tenant_id
     WHERE p.tenant_id = ${args.tenantId}::uuid
       AND p.run_id    = ${args.runId}::uuid
       ${args.unreversedOnly ? sql`AND p.reversed_at IS NULL` : sql``}
     ORDER BY p.input_row_number ASC NULLS FIRST, p.written_at ASC
  `);

  return rowsOf<Record<string, unknown>>(result).map((r) => ({
    provenanceId: String(r.provenance_id),
    inputRowNumber: r.input_row_number === null ? null : Number(r.input_row_number),
    targetTable: String(r.target_table),
    targetId: String(r.target_id),
    operation: r.operation as "insert" | "update",
    reversalKind: String(r.reversal_kind),
    cardinality: String(r.cardinality),
    reversedAt: r.reversed_at ? new Date(r.reversed_at as string) : null,
    capturedFields: (r.captured_fields as string[] | null) ?? null,
    priorValues: (r.prior_values as Record<string, unknown> | null) ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* WHAT THE DATABASE WILL ACTUALLY ALLOW                               */
/* ------------------------------------------------------------------ */

export type DestinationVerdict = {
  readonly targetTable: string;
  /** The absolute guard that refuses a DELETE here, or `null`. */
  readonly deleteBlockedBy: string | null;
  readonly updateBlockedBy: string | null;
  /** Trigger functions on this table nobody has classified. */
  readonly unknownGuards: string[];
};

/**
 * ⭐⭐⭐ THE HALF OF THE CONTRACT ONLY THE DATABASE CAN CHECK.
 *
 * `checkImportContract()` is pure — its header says so twice, and being pure
 * is what lets the wizard run it in a browser. A pure checker cannot ask
 * `pg_trigger` whether the undo an entity declares is possible.
 *
 * 🔴 IT IS NOT POSSIBLE FOR ONE OF THE SIX ENTITIES TODAY. `opening-stock`
 * declares `reversal: { kind: "delete" }`; `stock_movements` carries
 * `trg_stock_ledger_append_only`, whose first statement is
 * `IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Stock movements cannot be
 * deleted…'`. Gate 29 passes and always will. See SQL 0209 and
 * PATCH-REQUEST-PHASE-2.md.
 */
export async function destinationVerdict(
  tx: LedgerTx,
  targetTable: string,
): Promise<DestinationVerdict> {
  const result = await tx.execute(sql`
    SELECT target_table, delete_blocked_by, update_blocked_by, unknown_guards
      FROM import_destination_reversibility(${targetTable})
  `);
  const row = rowsOf<Record<string, unknown>>(result)[0];
  if (!row) {
    throw new ImportLedgerError(
      `The database returned no reversibility verdict for "${targetTable}". Nothing has been ` +
        `undone: an undo that proceeds without knowing what the destination allows discovers ` +
        `it one row at a time, as a thousand identical failures.`,
    );
  }
  return {
    targetTable: String(row.target_table),
    deleteBlockedBy: (row.delete_blocked_by as string | null) ?? null,
    updateBlockedBy: (row.update_blocked_by as string | null) ?? null,
    unknownGuards: (row.unknown_guards as string[] | null) ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* RECONCILIATION'S FIRST QUESTION                                     */
/* ------------------------------------------------------------------ */

export type LedgerCensus = {
  readonly rowsWritten: number;
  readonly provenanceRows: number;
  readonly inserts: number;
  readonly updates: number;
  readonly priorCaptures: number;
  readonly cardinality: string | null;
  /**
   * `null` when the counts agree or cannot disagree; a sentence when they
   * do. See below — this is the check that must NOT fire for a whole-file
   * entity.
   */
  readonly disagreement: string | null;
};

/**
 * ⭐⭐ "DID THE SIDECAR RECORD EVERYTHING THE RUN WROTE?"
 *
 * ⚠️ AND `cardinality` IS WHY THIS IS NOT A SUBTRACTION. An opening trial
 * balance of 40 lines writes ONE document; a checker expecting one output
 * per input would report 39 missing rows on a correct import, every time,
 * and the customer would learn to ignore it. `whole-file` is exempted by
 * name rather than by a tolerance.
 *
 * ⚠️ AND `many` IS EXEMPTED TOO, in the other direction: an invoice with
 * lines writes more destination rows than the file has lines. Only
 * `one-to-one` can be counted, and for it the count is exact.
 */
export async function ledgerCensus(args: {
  readonly tenantId: string;
  readonly runId: string;
  readonly rowsWritten: number;
}): Promise<LedgerCensus> {
  return withTenant(args.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT count(*)::int                                                    AS provenance_rows,
             count(*) FILTER (WHERE p.operation = 'insert')::int              AS inserts,
             count(*) FILTER (WHERE p.operation = 'update')::int              AS updates,
             (SELECT count(*)::int FROM import_row_prior_values v
               WHERE v.tenant_id = ${args.tenantId}::uuid
                 AND v.run_id    = ${args.runId}::uuid)                       AS prior_captures,
             min(p.cardinality)                                               AS cardinality
        FROM import_row_provenance p
       WHERE p.tenant_id = ${args.tenantId}::uuid
         AND p.run_id    = ${args.runId}::uuid
    `);

    const row = rowsOf<Record<string, unknown>>(result)[0] ?? {};
    const provenanceRows = Number(row.provenance_rows ?? 0);
    const cardinality = (row.cardinality as string | null) ?? null;

    const disagreement =
      cardinality === "one-to-one" && provenanceRows !== args.rowsWritten
        ? `This run reports ${args.rowsWritten.toLocaleString("en-IN")} rows written and the ` +
          `migration ledger holds ${provenanceRows.toLocaleString("en-IN")} of them. ` +
          `${Math.abs(args.rowsWritten - provenanceRows).toLocaleString("en-IN")} row(s) ` +
          `cannot be attributed to this run, which means they cannot be undone and cannot be ` +
          `reconciled.`
        : null;

    return {
      rowsWritten: args.rowsWritten,
      provenanceRows,
      inserts: Number(row.inserts ?? 0),
      updates: Number(row.updates ?? 0),
      priorCaptures: Number(row.prior_captures ?? 0),
      cardinality,
      disagreement,
    };
  });
}
