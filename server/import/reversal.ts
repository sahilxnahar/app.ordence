import "server-only";

/**
 * Ordence — ⭐⭐⭐ UNDOING A MIGRATION, AND SAYING WHAT DID NOT COME BACK
 * Version: v1.84.1-alpha · Phase 2
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SENTENCE THIS FILE EXISTS TO MAKE IMPOSSIBLE
 * ══════════════════════════════════════════════════════════════════════
 *     "Your migration has been reversed."
 * — said over a run where 900 of 1,000 rows came back and 100 did not.
 *
 * The brief names the consequence and it is the reason every count in here
 * is carried separately rather than reduced to a boolean: *"The failure
 * mode to design against is a customer who believes their failed migration
 * is gone and starts again on top of it."* They import the corrected file
 * over a hundred rows that were never removed, in `skip` mode, where those
 * rows are matched by natural key, reported as "already here", and never
 * looked at again.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR KINDS, AND THEY ARE FOUR DIFFERENT OPERATIONS
 * ══════════════════════════════════════════════════════════════════════
 *   delete         remove the ids this run created, found through the
 *                  sidecar — never through "rows created between these two
 *                  timestamps", which catches every row the customer's
 *                  staff typed by hand during the migration window.
 *   restore-prior  put the captured values back — AND delete the rows the
 *                  same run created. See below; this is the case the brief's
 *                  own description of the sidecar cannot express.
 *   reverse-entry  post the compensating record the destination defines.
 *                  An accounting act with its own date and audit trail.
 *   irreversible   refuse, and say what escapes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 `restore-prior` IS TWO OPERATIONS, NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * `companies` offers duplicate mode `update` and declares `restore-prior`.
 * One run over one file does both of these, row by row:
 *
 *     no match  → INSERT.  There is no prior. Undo = DELETE.
 *     matched   → UPDATE.  There is a prior. Undo = RESTORE.
 *
 * An undo that only restores leaves every row the run CREATED behind and
 * reports success. An undo that only deletes destroys records the customer
 * had before the migration — the combination CI gate 29 refuses at
 * definition time, reached from the other side at undo time where gate 29
 * cannot see it. `import_row_provenance.operation` is the discriminator and
 * only the write path could ever have recorded it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE TRANSACTION PER ROW, AND IT IS THE ONLY SHAPE THAT WORKS
 * ══════════════════════════════════════════════════════════════════════
 * `performWrites` in `server/actions/import.ts` argues this for the write
 * side and the argument is stronger here. An error inside a PostgreSQL
 * transaction poisons it: every later statement returns `25P02 current
 * transaction is aborted`. A single transaction around the whole undo would
 * therefore turn the FIRST blocked row into a total failure — and the
 * report would name one row out of a hundred, which is the "count with
 * nothing behind it" defect arrived at through the driver.
 *
 * ⭐ AND THE MARK IS IN THE SAME TRANSACTION AS THE UNDO. A row that is
 * deleted and not marked would be attempted again by the next reversal and
 * counted as a failure ("row not found") on a row that came back perfectly.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT ESCAPES IS MEASURED, NOT DECLARED
 * ══════════════════════════════════════════════════════════════════════
 * `companies` declares `escapes: null` — nothing survives an undo of it —
 * and carries `companies_set_updated_at`, a BEFORE UPDATE trigger whose
 * whole body is `NEW.updated_at = now()`. Every restore of that row, by any
 * caller, leaves `updated_at` reading the moment of the undo.
 *
 * `import_restore_prior_values()` (SQL 0210 §3) re-reads each row after
 * writing it and returns every column that did not come back, so the
 * sentence the customer is shown is the one the database produced rather
 * than the one an author wrote.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  importReversalFailures,
  importReversals,
  importRowProvenance,
  importRuns,
} from "@/db/schema/import-runs";
import { journalEntries, transactions } from "@/db/schema/accounting";
import { stockMovements } from "@/db/schema/inventory";
import type { ImportReversalKind } from "@/lib/import/types";
import {
  destinationVerdict,
  readRunLedger,
  rootCause,
  type LedgerRow,
  type LedgerTx,
} from "./ledger";

export class ImportReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportReversalError";
  }
}

export type ReversalFailure = {
  readonly provenanceId: string | null;
  readonly targetTable: string | null;
  readonly targetId: string | null;
  readonly inputRowNumber: number | null;
  /** What stopped this row coming back, in a sentence somebody can act on. */
  readonly blockedBy: string;
  readonly sqlstate: string | null;
};

export type ReversalResult = {
  readonly status: "reversed" | "partial" | "refused" | "failed";
  readonly reversalId: string | null;
  readonly kind: ImportReversalKind | null;
  readonly rowsConsidered: number;
  readonly rowsReversed: number;
  readonly rowsUnreversed: number;
  readonly failures: readonly ReversalFailure[];
  /** The declared sentence, as it was shown before the run. */
  readonly escapes: string | null;
  /**
   * ⭐ What actually did not come back, measured by the restore itself.
   * Column names, deduplicated across rows.
   */
  readonly measuredEscapes: readonly string[];
  /** The sentence to put in front of the customer. */
  readonly message: string;
};

/* ------------------------------------------------------------------ */

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * ⚠️ THE DATABASE'S OWN SENTENCE, NOT A CATEGORY.
 *
 * `trg_stock_ledger_append_only` explains what to do instead; a foreign key
 * names the table that still references the row; `42501` versus `23503`
 * sends support to two completely different places. Replacing any of that
 * with "could not be reversed" is the failure this whole file is about, one
 * level down.
 */
function describeFailure(err: unknown): { blockedBy: string; sqlstate: string | null } {
  const e = rootCause(err);
  const parts = [e?.message ?? String(err)];
  if (e?.detail) parts.push(e.detail);
  const blockedBy = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 2000);
  return {
    /** ⚠️ The `blocked_by` CHECK refuses anything under 10 characters. */
    blockedBy: blockedBy.length >= 10 ? blockedBy : `The database refused this row: ${blockedBy}`,
    sqlstate: typeof e?.code === "string" && e.code.length === 5 ? e.code : null,
  };
}

const number = (n: number) => n.toLocaleString("en-IN");

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ UNDO ONE RUN.
 *
 * ⚠️ NO PERMISSION CHECK HERE, DELIBERATELY, AND IT IS THE PATTERN THIS
 * REPOSITORY ALREADY USES. `server/accounting/post-sales.ts` posts; the
 * `server/actions/*` layer above it does `requireRole`, `requireAccess` and
 * `requireFeature`. Putting the checks here would make this module
 * unrunnable outside a request — which is to say untestable against a real
 * database, which is the only place any of its claims can be verified.
 * PATCH-REQUEST-PHASE-2.md carries the action wrapper.
 */
export async function reverseImportRun(args: {
  readonly tenantId: string;
  readonly runId: string;
  readonly requestedBy: string;
}): Promise<ReversalResult> {
  const { tenantId, runId, requestedBy } = args;

  /* ---- 1. what was this run, and can it be undone at all? --------- */
  const prepared = await withTenant(tenantId, async (tx) => {
    const [run] = await tx
      .select({
        entityKey: importRuns.entityKey,
        rowsWritten: importRuns.rowsWritten,
        supersededAt: importRuns.supersededAt,
        /** 🔴 THE RUN'S OWN COPY, NOT THE REGISTRY'S. See SQL 0208 §0. */
        reversalEscapes: importRuns.reversalEscapes,
      })
      .from(importRuns)
      .where(and(eq(importRuns.tenantId, tenantId), eq(importRuns.id, runId)));

    if (!run) {
      throw new ImportReversalError(
        "That migration run no longer exists in this workspace. Nothing has been undone.",
      );
    }

    const ledger = await readRunLedger(tx, { tenantId, runId, unreversedOnly: true });
    return { run, ledger };
  });

  const { run, ledger } = prepared;

  /* ---- 2. the entity, and the kind the ROWS were written under ---- */
  /**
   * ⚠️ THE KIND COMES FROM THE PROVENANCE ROWS, NOT FROM THE ENTITY. An
   * entity's declaration can be edited between the run and the undo, and
   * `lib/import/types.ts` gives the reason the contract exists at all:
   * "at undo time the entity that wrote the row may no longer be the one
   * being asked." A run written under `delete` captured no prior values, so
   * undoing it as `restore-prior` would restore nothing and report success.
   */
  const kinds = [...new Set(ledger.map((r) => r.reversalKind))];

  if (ledger.length === 0) {
    return finishedWithNothingToDo(run.entityKey, run.rowsWritten, run.supersededAt);
  }

  if (kinds.length > 1) {
    return {
      status: "refused",
      reversalId: null,
      kind: null,
      rowsConsidered: ledger.length,
      rowsReversed: 0,
      rowsUnreversed: ledger.length,
      failures: [],
      escapes: null,
      measuredEscapes: [],
      message:
        `The ${number(ledger.length)} rows this migration wrote were recorded under more than ` +
        `one reversal policy (${kinds.join(", ")}), so there is no single way to undo them. ` +
        `Nothing has been changed. This means the entity's declaration was edited between the ` +
        `import and now; the rows written before the edit have to be undone under the policy ` +
        `they were written under.`,
    };
  }

  const kind = kinds[0] as ImportReversalKind;

  /**
   * 🔴 THE SENTENCE THE CUSTOMER WAS SHOWN BEFORE THIS RUN, TAKEN FROM THE
   * RUN. Reading `ALL_IMPORT_ENTITIES` here instead — which the first draft
   * of this file did — means an entity edited between the migration and the
   * undo changes what the customer is told survived it. A run started when
   * the entity said "the welcome email has already gone out" would be undone
   * months later under an `escapes: null` and the customer told that nothing
   * escaped.
   *
   * ⭐ AND THE REGISTRY IS NOT CONSULTED AT ALL IN THIS FILE. That is worth
   * stating: everything an undo needs — the kind, the operation, the
   * destination, the prior values, the promise — is in the ledger, written
   * when the run was written. An entity that has since been removed from
   * `ALL_IMPORT_ENTITIES` altogether can still be undone, which is exactly
   * the case a customer hits after a product change.
   */
  const escapes = run.reversalEscapes;

  /* ---- 3. `irreversible` refuses, and says what escapes ----------- */
  if (kind === "irreversible") {
    const reason =
      `This import cannot be undone. ` +
      (escapes ??
        `The entity that wrote these ${number(ledger.length)} rows declares its effects ` +
          `irreversible and gives no further detail.`) +
      ` Nothing has been changed.`;

    const reversalId = await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(importReversals)
        .values({
          tenantId,
          runId,
          entityKey: run.entityKey,
          kind,
          requestedBy,
          status: "running",
          rowsConsidered: ledger.length,
          escapes,
        })
        .returning({ id: importReversals.id });
      if (!row) throw new ImportReversalError("The refusal could not be recorded.");
      /**
       * ⚠️ RECORDED AS A REFUSAL, NOT SIMPLY RETURNED. "Did anyone try to
       * undo this?" is a support question, and an `irreversible` entity is
       * exactly the one where somebody will have tried.
       *
       * `import_reversals_irreversible_refuses` (SQL 0208) makes this the
       * only ending this row can have: kind `irreversible` may never reach
       * status `reversed` and may never report a reversed row.
       */
      await tx
        .update(importReversals)
        .set({ status: "refused", finishedAt: new Date(), refusalReason: reason })
        .where(and(eq(importReversals.id, row.id), eq(importReversals.tenantId, tenantId)));
      return row.id;
    });

    return {
      status: "refused",
      reversalId,
      kind,
      rowsConsidered: ledger.length,
      rowsReversed: 0,
      rowsUnreversed: 0,
      failures: [],
      escapes,
      measuredEscapes: [],
      message: reason,
    };
  }

  /* ---- 4. ask the database what it will allow, BEFORE touching ---- */
  /**
   * 🔴 THE CHECK THAT FINDS `opening-stock`.
   *
   * That entity declares `kind: "delete"` and its destination carries
   * `trg_stock_ledger_append_only`, which raises on every DELETE for every
   * role. Without this the undo would attempt one row, fail, attempt the
   * next, fail, and hand the customer a report naming every row in their
   * file with the same message — technically complete and useless.
   *
   * ⚠️ AND AN UNCLASSIFIED TRIGGER IS A REFUSAL. SQL 0209 returns the names
   * of trigger functions nobody has read rather than assuming them harmless,
   * because a guard attached to a destination next quarter would otherwise
   * be silently ignored until it started blocking undos in production.
   */
  const tables = [...new Set(ledger.map((r) => r.targetTable))];
  const needsDelete = kind === "delete" || ledger.some((r) => r.operation === "insert");
  const needsUpdate = kind === "restore-prior" && ledger.some((r) => r.operation === "update");

  for (const table of tables) {
    const verdict = await withTenant(tenantId, (tx) => destinationVerdict(tx, table));

    if (verdict.unknownGuards.length > 0) {
      return refusedUpFront(
        tenantId, runId, run.entityKey, kind, requestedBy, ledger.length, escapes,
        `"${table}" carries trigger(s) nobody has classified: ` +
          `${verdict.unknownGuards.join(", ")}. Whether an undo is possible there is unknown, ` +
          `and proceeding on the assumption that it is would risk a half-finished reversal. ` +
          `Nothing has been changed.`,
      );
    }

    if (needsDelete && verdict.deleteBlockedBy) {
      return refusedUpFront(
        tenantId, runId, run.entityKey, kind, requestedBy, ledger.length, escapes,
        `This migration's undo would have to delete ${number(ledger.length)} row(s) from ` +
          `"${table}", and that table refuses every delete — ${verdict.deleteBlockedBy} is an ` +
          `append-only guard that applies to every role. The entity's declared reversal is not ` +
          `possible against this database and never has been; it needs a compensating record ` +
          `rather than a deletion. Nothing has been changed.`,
      );
    }

    if (needsUpdate && verdict.updateBlockedBy) {
      return refusedUpFront(
        tenantId, runId, run.entityKey, kind, requestedBy, ledger.length, escapes,
        `This migration's undo would have to restore prior values into "${table}", and that ` +
          `table refuses every update — ${verdict.updateBlockedBy} is an append-only guard ` +
          `that applies to every role. Nothing has been changed.`,
      );
    }
  }

  /* ---- 5. claim the undo ------------------------------------------ */
  let reversalId: string;
  try {
    reversalId = await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(importReversals)
        .values({
          tenantId,
          runId,
          entityKey: run.entityKey,
          kind,
          requestedBy,
          status: "running",
          rowsConsidered: ledger.length,
          escapes,
        })
        .returning({ id: importReversals.id });
      if (!row) throw new ImportReversalError("The undo could not be started.");
      return row.id;
    });
  } catch (err) {
    /**
     * ⚠️ `import_reversals_one_live_per_run` IS THE LOCK, AND HITTING IT IS
     * NOT AN ERROR TO SHOW RAW. The undo button is a button; a customer
     * watching nothing happen presses it again. Two concurrent reversals
     * would each read the same unreversed rows and each try to remove the
     * same destination row — the loser recording a failure against a row
     * that came back perfectly well.
     */
    const { blockedBy } = describeFailure(err);
    if (/one_live_per_run|one_success_per_run/.test(blockedBy)) {
      return {
        status: "failed",
        reversalId: null,
        kind,
        rowsConsidered: ledger.length,
        rowsReversed: 0,
        rowsUnreversed: 0,
        failures: [],
        escapes,
        measuredEscapes: [],
        message:
          /one_success_per_run/.test(blockedBy)
            ? "This migration has already been undone in full. Nothing further has been changed."
            : "An undo of this migration is already running. Nothing further has been started — " +
              "two undos of one migration would each try to remove the same rows, and the " +
              "second would report failures against rows the first had already removed.",
      };
    }
    throw err;
  }

  /* ---- 6. row by row, each in its own transaction ----------------- */
  const failures: ReversalFailure[] = [];
  const measured = new Set<string>();
  let reversed = 0;

  for (const row of ledger) {
    try {
      const escaped = await withTenant(tenantId, async (tx) => {
        const left = await undoOneRow(tx, { tenantId, kind, row, requestedBy });

        /**
         * ⭐ THE MARK IS IN THE SAME TRANSACTION AS THE UNDO. A row that came
         * back but was not marked would be attempted again by the next
         * reversal and counted as a failure on a row that is already gone.
         */
        await tx
          .update(importRowProvenance)
          .set({ reversedAt: new Date(), reversalId })
          .where(
            and(
              eq(importRowProvenance.id, row.provenanceId),
              eq(importRowProvenance.tenantId, tenantId),
            ),
          );

        return left;
      });

      for (const column of escaped) measured.add(`${row.targetTable}.${column}`);
      reversed += 1;
    } catch (err) {
      const { blockedBy, sqlstate } = describeFailure(err);
      failures.push({
        provenanceId: row.provenanceId,
        targetTable: row.targetTable,
        targetId: row.targetId,
        inputRowNumber: row.inputRowNumber,
        blockedBy,
        sqlstate,
      });
    }
  }

  /* ---- 7. finish, and the database refuses a dishonest ending ----- */
  return finishReversal({
    tenantId,
    runId,
    reversalId,
    kind,
    entityKey: run.entityKey,
    considered: ledger.length,
    reversed,
    failures,
    escapes,
    measuredEscapes: [...measured].sort(),
  });
}

/* ------------------------------------------------------------------ */
/* ONE ROW                                                             */
/* ------------------------------------------------------------------ */

/**
 * Returns the column names that did NOT come back, measured by the restore.
 * Empty for a delete, which either happened or raised.
 */
async function undoOneRow(
  tx: LedgerTx,
  args: {
    readonly tenantId: string;
    readonly kind: ImportReversalKind;
    readonly row: LedgerRow;
    readonly requestedBy: string;
  },
): Promise<readonly string[]> {
  const { tenantId, kind, row } = args;

  /**
   * 🔴 `restore-prior` DISPATCHES ON `operation`, NOT ON THE KIND. See this
   * file's header: a row the run CREATED has no prior and its undo is a
   * delete. Treating the two the same is how an undo either leaves created
   * rows behind or destroys pre-existing records.
   */
  if (kind === "delete" || (kind === "restore-prior" && row.operation === "insert")) {
    await deleteRow(tx, tenantId, row);
    return [];
  }

  if (kind === "restore-prior") {
    return restoreRow(tx, tenantId, row);
  }

  if (kind === "reverse-entry") {
    await postCompensatingRecord(tx, tenantId, row, args.requestedBy);
    return [];
  }

  throw new ImportReversalError(
    `No undo is defined for reversal kind "${kind}". Rather than guess, this row has been ` +
      `left exactly as the migration wrote it.`,
  );
}

async function deleteRow(tx: LedgerTx, tenantId: string, row: LedgerRow): Promise<void> {
  const result = await tx.execute(sql`
    SELECT import_delete_row(${row.targetTable}, ${row.targetId}::uuid, ${tenantId}::uuid) AS n
  `);
  const n = Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
  if (n !== 1) {
    /**
     * ⚠️ ZERO IS A FAILURE AND IT IS NOT PEDANTRY. A row this run created
     * that is no longer there was removed by something else — most often the
     * customer, by hand, after deciding the migration was wrong. Counting
     * that as "reversed" is defensible; counting it SILENTLY is not, because
     * the run report would then say the undo removed a row it did not touch.
     */
    throw new ImportReversalError(
      `Row ${row.targetId} in "${row.targetTable}" is no longer in this workspace, so this ` +
        `undo did not remove it. Something else did — most likely somebody deleting it by hand ` +
        `after the import. Nothing about this row has been changed.`,
    );
  }
}

async function restoreRow(
  tx: LedgerTx,
  tenantId: string,
  row: LedgerRow,
): Promise<readonly string[]> {
  if (!row.priorValues || !row.capturedFields || row.capturedFields.length === 0) {
    /**
     * 🔴 THE CASE SQL 0206 §4 EXISTS TO PREVENT, CAUGHT AT THE OTHER END.
     * A `restore-prior` update with no capture cannot be undone at all, and
     * the honest answer is to name it rather than to run an UPDATE that sets
     * nothing and report success.
     */
    throw new ImportReversalError(
      `Row ${row.targetId} in "${row.targetTable}" was overwritten by this migration and its ` +
        `prior values were never captured, so there is nothing to put back. The row still holds ` +
        `what the import wrote. This is a defect in the writer for this entity, not something ` +
        `the file can be corrected for.`,
    );
  }

  const result = await tx.execute(sql`
    SELECT rows_affected, unrestored
      FROM import_restore_prior_values(
        ${row.targetTable},
        ${row.targetId}::uuid,
        ${tenantId}::uuid,
        ${JSON.stringify(row.priorValues)}::jsonb,
        ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(row.capturedFields)}::jsonb))
      )
  `);

  const out = rowsOf<{ rows_affected: number; unrestored: string[] | null }>(result)[0];
  if (!out || Number(out.rows_affected) !== 1) {
    throw new ImportReversalError(
      `Row ${row.targetId} in "${row.targetTable}" could not be restored: it is no longer ` +
        `visible in this workspace. Its prior values are still recorded against this migration ` +
        `and nothing has been lost, but the row itself is not there to write them into.`,
    );
  }
  return out.unrestored ?? [];
}

/* ------------------------------------------------------------------ */
/* reverse-entry                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE COMPENSATING RECORD IS THE DESTINATION'S, NOT A GENERIC ONE.
 *
 * "Append-only, so post the opposite" is one idea with two completely
 * different implementations here, and the schema already carries both:
 * `transactions.reverses_transaction_id` and
 * `stock_movements.reverses_movement_id`. A destination with neither has no
 * defined compensating record, and inventing one — a negative row of some
 * shape nothing else in the product writes — would put a figure in a ledger
 * that no report knows how to read.
 *
 * ⚠️ THIS IS THE THIRD PLACE THE LEDGER-REVERSAL SHAPE IS WRITTEN, and the
 * other two are `reverseTransaction` in `server/actions/accounting.ts` and
 * the manual path a person uses. That is one too many. It is not imported
 * from there because that module is `"use server"`: calling it would run
 * `requireRole` against a cookie jar and `revalidatePath` against a request
 * that does not exist, which is the difference between a module that can be
 * proven against a real database and one that cannot.
 * PATCH-REQUEST-PHASE-2.md asks for `postReversingEntry(tx, …)` to be lifted
 * into `server/accounting/post-sales.ts`, where the other twenty posting
 * primitives already live, and for both callers to use it.
 */
async function postCompensatingRecord(
  tx: LedgerTx,
  tenantId: string,
  row: LedgerRow,
  requestedBy: string,
): Promise<void> {
  if (row.targetTable === "transactions") {
    return postReversingJournalEntry(tx, tenantId, row, requestedBy);
  }
  if (row.targetTable === "stock_movements") {
    return postReversingStockMovement(tx, tenantId, row, requestedBy);
  }
  throw new ImportReversalError(
    `"${row.targetTable}" is append-only but defines no compensating record, so there is no ` +
      `honest way to undo a row in it. Inventing one would put a figure in a ledger that no ` +
      `report in this product knows how to read.`,
  );
}

async function postReversingJournalEntry(
  tx: LedgerTx,
  tenantId: string,
  row: LedgerRow,
  requestedBy: string,
): Promise<void> {
  const [original] = await tx
    .select({
      id: transactions.id,
      description: transactions.description,
      status: transactions.status,
      referenceType: transactions.referenceType,
      referenceId: transactions.referenceId,
      currency: transactions.currency,
      totalAmount: transactions.totalAmount,
    })
    .from(transactions)
    .where(and(eq(transactions.id, row.targetId), eq(transactions.tenantId, tenantId)));

  if (!original) {
    throw new ImportReversalError(
      `The opening entry this migration posted (transaction ${row.targetId}) is not in this ` +
        `workspace, so there is nothing to reverse.`,
    );
  }
  if (original.status === "reversed") {
    throw new ImportReversalError(
      `The opening entry this migration posted has already been reversed — by hand, or by an ` +
        `earlier undo. Posting a second reversal would credit the accounts twice.`,
    );
  }

  const legs = await tx
    .select({
      ledgerId: journalEntries.ledgerId,
      entryType: journalEntries.entryType,
      amountMinor: journalEntries.amountMinor,
      counterpartyType: journalEntries.counterpartyType,
      counterpartyId: journalEntries.counterpartyId,
      counterpartyName: journalEntries.counterpartyName,
    })
    .from(journalEntries)
    .where(
      and(eq(journalEntries.transactionId, original.id), eq(journalEntries.tenantId, tenantId)),
    );

  if (legs.length === 0) {
    throw new ImportReversalError(
      `The opening entry this migration posted has no legs, so there is nothing to reverse.`,
    );
  }

  /**
   * 🔴 REFUSED, NOT ROUNDED. Batch 0108's rule, and `reverseTransaction`
   * makes the same refusal in the same words: a leg with no integer minor
   * amount has nothing to negate, and reversing it from the two-decimal
   * `amount` mirror would leave a residue of up to 9 fils per leg in a real
   * account. The remedy is to scale the leg, not to approximate the undo.
   */
  const unscaled = legs.filter((l) => l.amountMinor === null).length;
  if (unscaled > 0) {
    throw new ImportReversalError(
      `${unscaled} of this opening entry's legs have no amount in minor units, so a reversal ` +
        `would be an approximation of them. Run the census in SQL-FILES/0108 to see which ` +
        `currency is unscaled. Nothing has been posted.`,
    );
  }

  const [reversal] = await tx
    .insert(transactions)
    .values({
      tenantId,
      description: `Reversal of: ${original.description}`,
      /**
       * ⚠️ TODAY'S DATE, NOT THE ORIGINAL'S. A reversing entry is a
       * transaction in its own right and belongs in the period it is made
       * in; back-dating it into the opening period would reopen a period the
       * customer may have closed and reported from.
       */
      transactionDate: new Date().toISOString().slice(0, 10),
      status: "posted",
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      currency: original.currency,
      totalAmount: original.totalAmount,
      reversesTransactionId: original.id,
      reversalReason:
        "The migration that posted this opening balance was undone. The opening entry stays in " +
        "the ledger and this entry cancels it, because a posted entry is corrected by reversing " +
        "it rather than by being deleted.",
      createdBy: requestedBy,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!reversal) {
    throw new ImportReversalError("The reversing entry could not be posted.");
  }

  await tx.insert(journalEntries).values(
    legs.map((leg) => ({
      tenantId,
      transactionId: reversal.id,
      ledgerId: leg.ledgerId,
      entryType: leg.entryType === "debit" ? ("credit" as const) : ("debit" as const),
      /** ⚠️ The original's integer, copied — never re-parsed from `amount`. */
      amountMinor: leg.amountMinor as bigint,
      description: "Reversal: the migration that posted this opening balance was undone.",
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      counterpartyType: leg.counterpartyType,
      counterpartyId: leg.counterpartyId,
      counterpartyName: leg.counterpartyName,
      createdBy: requestedBy,
    })),
  );

  await tx
    .update(transactions)
    .set({ status: "reversed", reversedByTransactionId: reversal.id })
    .where(and(eq(transactions.id, original.id), eq(transactions.tenantId, tenantId)));
}

async function postReversingStockMovement(
  tx: LedgerTx,
  tenantId: string,
  row: LedgerRow,
  requestedBy: string,
): Promise<void> {
  const [original] = await tx
    .select({
      id: stockMovements.id,
      stockItemId: stockMovements.stockItemId,
      warehouseId: stockMovements.warehouseId,
      quantity: stockMovements.quantity,
      unitCostMinor: stockMovements.unitCostMinor,
      valueMinor: stockMovements.valueMinor,
      batchNo: stockMovements.batchNo,
      documentNo: stockMovements.documentNo,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.id, row.targetId), eq(stockMovements.tenantId, tenantId)));

  if (!original) {
    throw new ImportReversalError(
      `The opening stock movement this migration posted (${row.targetId}) is not in this ` +
        `workspace, so there is nothing to reverse.`,
    );
  }

  if (
    await hasReversal(tx, tenantId, original.id)
  ) {
    throw new ImportReversalError(
      `The opening stock movement this migration posted has already been reversed. Posting a ` +
        `second reversal would take the quantity below where it started.`,
    );
  }

  /**
   * ⚠️ THE NEGATION IS DONE IN SQL ON `numeric`, NOT IN JAVASCRIPT.
   * `quantity` is `numeric(18,3)` and arrives here as a string. Parsing it to
   * a JS number to negate it is where `0.1 + 0.2 !== 0.3` gets into a stock
   * ledger — the exact thing `thousandthsToDecimal` in
   * `server/actions/import.ts` exists to avoid on the way in.
   */
  await tx.insert(stockMovements).values({
    tenantId,
    stockItemId: original.stockItemId,
    warehouseId: original.warehouseId,
    quantity: sql`(${original.quantity}::numeric * -1)`,
    reason: "opening_balance",
    movedAt: new Date(),
    unitCostMinor: original.unitCostMinor,
    valueMinor: -(original.valueMinor ?? 0n),
    batchNo: original.batchNo,
    referenceType: "opening_balance",
    documentNo: original.documentNo,
    reversesMovementId: original.id,
    adjustmentNote:
      "The migration that posted this opening stock was undone. The opening movement stays in " +
      "the ledger and this movement cancels it, because a stock history that can be rewritten " +
      "is a stock history that proves nothing.",
    createdBy: requestedBy,
  });
}

async function hasReversal(tx: LedgerTx, tenantId: string, movementId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.tenantId, tenantId),
        eq(stockMovements.reversesMovementId, movementId),
      ),
    );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* ENDINGS                                                             */
/* ------------------------------------------------------------------ */

async function finishReversal(args: {
  readonly tenantId: string;
  readonly runId: string;
  readonly reversalId: string;
  readonly kind: ImportReversalKind;
  readonly entityKey: string;
  readonly considered: number;
  readonly reversed: number;
  readonly failures: readonly ReversalFailure[];
  readonly escapes: string | null;
  readonly measuredEscapes: readonly string[];
}): Promise<ReversalResult> {
  const unreversed = args.failures.length;
  const complete = unreversed === 0 && args.reversed === args.considered;
  const status: "reversed" | "partial" = complete ? "reversed" : "partial";

  /**
   * ⭐⭐ THE SENTENCE IS THE PRODUCT HERE, exactly as `finishImportRun`
   * argues for the import side. "Undo finished" over a run that left a
   * hundred rows behind is the failure this whole file exists to prevent,
   * and the number has to be IN the message rather than in a status field
   * somebody has to go and look at.
   */
  const escapeNote =
    args.measuredEscapes.length > 0
      ? ` One thing did not come back and it is not an error: ` +
        `${args.measuredEscapes.join(", ")} — a database trigger rewrites it on every change, ` +
        `so it now reads the moment of the undo rather than the moment before the import.`
      : "";

  const message = complete
    ? `All ${number(args.considered)} row(s) this migration wrote have been undone.` +
      escapeNote +
      (args.escapes ? ` ${args.escapes}` : "")
    : `🔴 ${number(unreversed)} of ${number(args.considered)} row(s) could NOT be undone and are ` +
      `still in your workspace. ${number(args.reversed)} were undone. Do not import this file ` +
      `again until the ${number(unreversed)} listed below have been dealt with — a second import ` +
      `would match them as records that are already here and never look at them again.` +
      escapeNote;

  await withTenant(args.tenantId, async (tx) => {
    if (args.failures.length > 0) {
      /**
       * ⚠️ INSERTED BEFORE THE STATUS MOVES, IN THE SAME TRANSACTION. SQL
       * 0208 §4 is a DEFERRED constraint trigger: at COMMIT it counts the
       * rows in `import_reversal_failures` and refuses the whole transaction
       * unless the number equals `rows_unreversed`. A reversal that reports
       * a hundred and names three cannot be committed.
       */
      await tx.insert(importReversalFailures).values(
        args.failures.map((f) => ({
          tenantId: args.tenantId,
          reversalId: args.reversalId,
          provenanceId: f.provenanceId,
          targetTable: f.targetTable,
          targetId: f.targetId,
          inputRowNumber: f.inputRowNumber,
          blockedBy: f.blockedBy,
          sqlstate: f.sqlstate,
        })),
      );
    }

    await tx
      .update(importReversals)
      .set({
        status,
        finishedAt: new Date(),
        rowsReversed: args.reversed,
        rowsUnreversed: unreversed,
        refusalReason: complete ? null : message,
      })
      .where(
        and(
          eq(importReversals.id, args.reversalId),
          eq(importReversals.tenantId, args.tenantId),
        ),
      );

    /**
     * ⭐ AND THE RUN RELEASES ITS CLAIM ON THE FILE — BUT ONLY ON A COMPLETE
     * UNDO. `import_runs_one_live_per_source` (SQL 0207) stops the same file
     * being imported twice; a customer who has undone their migration is
     * entitled to import it again, and that is what undoing it was for.
     *
     * 🔴 A PARTIAL UNDO DOES NOT RELEASE IT, and that is the single most
     * important line in this function. Releasing the claim after a partial
     * undo is precisely the *"customer who believes their failed migration
     * is gone and starts again on top of it"* — the product would be
     * inviting them to.
     */
    if (complete) {
      await tx
        .update(importRuns)
        .set({
          supersededAt: new Date(),
          supersededReason:
            `Undone in full on ${new Date().toISOString().slice(0, 10)}. The same file may be ` +
            `imported again.`,
        })
        .where(and(eq(importRuns.id, args.runId), eq(importRuns.tenantId, args.tenantId)));
    }
  });

  return {
    status,
    reversalId: args.reversalId,
    kind: args.kind,
    rowsConsidered: args.considered,
    rowsReversed: args.reversed,
    rowsUnreversed: unreversed,
    failures: args.failures,
    escapes: args.escapes,
    measuredEscapes: args.measuredEscapes,
    message,
  };
}

async function refusedUpFront(
  tenantId: string,
  runId: string,
  entityKey: string,
  kind: ImportReversalKind,
  requestedBy: string,
  considered: number,
  escapes: string | null,
  reason: string,
): Promise<ReversalResult> {
  const reversalId = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(importReversals)
      .values({
        tenantId,
        runId,
        entityKey,
        kind,
        requestedBy,
        status: "running",
        rowsConsidered: considered,
        escapes,
      })
      .returning({ id: importReversals.id });
    if (!row) throw new ImportReversalError("The refusal could not be recorded.");
    await tx
      .update(importReversals)
      .set({ status: "refused", finishedAt: new Date(), refusalReason: reason })
      .where(and(eq(importReversals.id, row.id), eq(importReversals.tenantId, tenantId)));
    return row.id;
  });

  return {
    status: "refused",
    reversalId,
    kind,
    rowsConsidered: considered,
    rowsReversed: 0,
    rowsUnreversed: 0,
    failures: [],
    escapes,
    measuredEscapes: [],
    message: reason,
  };
}

function finishedWithNothingToDo(
  entityKey: string,
  rowsWritten: number,
  supersededAt: Date | null,
): ReversalResult {
  /**
   * ⚠️ THREE DIFFERENT SITUATIONS AND THEY GET THREE DIFFERENT SENTENCES.
   * "Nothing to undo" over a run that wrote 40,000 rows is the report a
   * customer would take to mean their data is safe.
   */
  const message = supersededAt
    ? "This migration has already been undone. Nothing further has been changed."
    : rowsWritten > 0
      ? `🔴 This migration reports ${number(rowsWritten)} row(s) written, and the migration ` +
        `ledger holds none of them. They cannot be undone, because nothing records which rows ` +
        `they are. This run was written by a code path that does not record provenance — see ` +
        `SQL 0205. Nothing has been changed.`
      : "This migration wrote no rows, so there is nothing to undo.";

  return {
    status: supersededAt ? "reversed" : rowsWritten > 0 ? "refused" : "reversed",
    reversalId: null,
    kind: null,
    rowsConsidered: 0,
    rowsReversed: 0,
    rowsUnreversed: 0,
    failures: [],
    escapes: null,
    measuredEscapes: [],
    message: `${message} (${entityKey})`,
  };
}

/* ------------------------------------------------------------------ */
/* THE INTERRUPTED UNDO                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐ AN UNDO THAT DIED HALFWAY LEAVES A `running` ROW, AND THAT ROW HOLDS
 * THE LOCK FOR EVER.
 *
 * ⚠️ AND THE ANSWER IS NOT A TIMEOUT. "It has been running for an hour so it
 * must be dead" is a guess, and acting on it while the first undo is in fact
 * still going is how two reversals end up removing the same rows. This is a
 * deliberate act with a person's name against it.
 *
 * 🔴 IT NAMES EVERY ROW IT DID NOT REACH. `import_reversal_failures_named`
 * would refuse the write otherwise, and it is right to: an abandoned undo
 * whose report says "interrupted" and lists nothing tells the customer that
 * some unknown subset of their migration is still there.
 */
export async function abandonReversal(args: {
  readonly tenantId: string;
  readonly reversalId: string;
  readonly because: string;
}): Promise<{ readonly rowsLeft: number }> {
  if (args.because.trim().length < 10) {
    throw new ImportReversalError(
      "Abandoning an undo needs a written reason. It is the only record of why a migration was " +
        "left half-undone.",
    );
  }

  return withTenant(args.tenantId, async (tx) => {
    const [reversal] = await tx
      .select({ runId: importReversals.runId, status: importReversals.status })
      .from(importReversals)
      .where(
        and(
          eq(importReversals.id, args.reversalId),
          eq(importReversals.tenantId, args.tenantId),
        ),
      );

    if (!reversal) throw new ImportReversalError("That undo does not exist in this workspace.");
    if (reversal.status !== "running") {
      throw new ImportReversalError(
        `That undo already finished with status "${reversal.status}". Nothing has been changed.`,
      );
    }

    const left = await readRunLedger(tx, {
      tenantId: args.tenantId,
      runId: reversal.runId,
      unreversedOnly: true,
    });

    if (left.length > 0) {
      await tx.insert(importReversalFailures).values(
        left.map((row) => ({
          tenantId: args.tenantId,
          reversalId: args.reversalId,
          provenanceId: row.provenanceId,
          targetTable: row.targetTable,
          targetId: row.targetId,
          inputRowNumber: row.inputRowNumber,
          blockedBy:
            `The undo was interrupted before this row was reached, so it is still exactly as ` +
            `the migration wrote it. Reason recorded: ${args.because.trim()}`,
          sqlstate: null,
        })),
      );
    }

    await tx
      .update(importReversals)
      .set({
        status: "failed",
        finishedAt: new Date(),
        rowsUnreversed: left.length,
        refusalReason:
          `The undo was abandoned with ${number(left.length)} row(s) still in the workspace. ` +
          `${args.because.trim()}`,
      })
      .where(
        and(
          eq(importReversals.id, args.reversalId),
          eq(importReversals.tenantId, args.tenantId),
        ),
      );

    return { rowsLeft: left.length };
  });
}

/* ------------------------------------------------------------------ */
/* READING BACK                                                        */
/* ------------------------------------------------------------------ */

export type ReversalView = {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly status: string;
  readonly requestedAt: Date;
  readonly finishedAt: Date | null;
  readonly rowsConsidered: number;
  readonly rowsReversed: number;
  readonly rowsUnreversed: number;
  readonly refusalReason: string | null;
};

export async function listReversals(
  tenantId: string,
  runId: string,
): Promise<ReversalView[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: importReversals.id,
        runId: importReversals.runId,
        kind: importReversals.kind,
        status: importReversals.status,
        requestedAt: importReversals.requestedAt,
        finishedAt: importReversals.finishedAt,
        rowsConsidered: importReversals.rowsConsidered,
        rowsReversed: importReversals.rowsReversed,
        rowsUnreversed: importReversals.rowsUnreversed,
        refusalReason: importReversals.refusalReason,
      })
      .from(importReversals)
      .where(and(eq(importReversals.tenantId, tenantId), eq(importReversals.runId, runId)))
      .orderBy(sql`${importReversals.requestedAt} DESC`),
  );
}

/** The rows an undo could not undo, in the order of the customer's file. */
export async function listReversalFailures(
  tenantId: string,
  reversalId: string,
): Promise<ReversalFailure[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        provenanceId: importReversalFailures.provenanceId,
        targetTable: importReversalFailures.targetTable,
        targetId: importReversalFailures.targetId,
        inputRowNumber: importReversalFailures.inputRowNumber,
        blockedBy: importReversalFailures.blockedBy,
        sqlstate: importReversalFailures.sqlstate,
      })
      .from(importReversalFailures)
      .where(
        and(
          eq(importReversalFailures.tenantId, tenantId),
          eq(importReversalFailures.reversalId, reversalId),
        ),
      )
      .orderBy(sql`${importReversalFailures.inputRowNumber} ASC NULLS FIRST`);
    return rows;
  });
}
