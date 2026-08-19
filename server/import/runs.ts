import "server-only";

/**
 * Ordence — ⭐⭐⭐ A MIGRATION THAT FINISHES
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THING THIS REPLACES IS A SENTENCE IN `lib/import/plan.ts`
 * ══════════════════════════════════════════════════════════════════════
 *     "A customer with more than this has a genuine migration, not a CSV
 *      upload, and the honest answer is to say so and split the file."
 *
 * That is the right answer for a CSV upload and the wrong one for the
 * thing this wave exists to build. A prospect with 40,000 customers told
 * to cut their file into forty pieces, upload them one at a time and keep
 * track of which ones worked is a prospect who stays where they are.
 *
 * ⚠️ AND THE FIX IS NOT A BIGGER CAP. Raising `MAX_IMPORT_ROWS` to
 * 100,000 with the same architecture produces exactly what that comment
 * describes: *"a request that times out halfway with some rows written
 * and no report"*.
 *
 * ⭐ THE FIX IS THIS: the file stays on the customer's machine, the
 * browser plans it — `planImportRecords` is pure — and submits it in
 * chunks of `MAX_IMPORT_ROWS`. A run ties the chunks together, knows how
 * many rows were expected, and REFUSES TO CALL ITSELF COMPLETE until
 * every one is accounted for.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT MAKES A RETRY SAFE, IN TWO LAYERS
 * ══════════════════════════════════════════════════════════════════════
 * ① THE ROWS. Every entity declares a natural key — `lib/import/types.ts`
 *    makes it a required member with no opt-out — so a re-run matches
 *    rather than duplicates. This is the layer that already existed.
 *
 * ② THE COUNTS. A chunk that timed out has often already committed, and
 *    the browser cannot tell "never arrived" from "arrived and the answer
 *    was lost". `import_run_chunks` has a unique index on (run, index),
 *    so a replay is REPORTED as already done rather than counted twice.
 *
 * Without ②, a replayed chunk reports 500 more rows written than exist,
 * and `import_runs_outcomes_within_expected` then fails the whole run for
 * an arithmetic error rather than a data one — which is a support ticket
 * about a migration that actually worked.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { importRunChunks, importRuns } from "@/db/schema/import-runs";

export type StartRunArgs = {
  readonly tenantId: string;
  readonly startedBy: string;
  readonly entityKey: string;
  readonly sourceFormat: string;
  readonly sourceName?: string | null;
  readonly sourceSheet?: string | null;
  readonly duplicateMode: string;
  readonly expectedRows: number;
};

export class ImportRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRunError";
  }
}

export async function startImportRun(args: StartRunArgs): Promise<string> {
  if (args.expectedRows <= 0) {
    throw new ImportRunError(
      "That file has no rows to import. Nothing has been started.",
    );
  }
  return withTenant(args.tenantId, async (tx) => {
    const [row] = await tx
      .insert(importRuns)
      .values({
        tenantId: args.tenantId,
        startedBy: args.startedBy,
        entityKey: args.entityKey,
        sourceFormat: args.sourceFormat,
        sourceName: args.sourceName?.slice(0, 255) ?? null,
        sourceSheet: args.sourceSheet?.slice(0, 120) ?? null,
        duplicateMode: args.duplicateMode,
        expectedRows: args.expectedRows,
      })
      .returning({ id: importRuns.id });
    if (!row) throw new ImportRunError("The migration could not be started.");
    return row.id;
  });
}

export type ChunkOutcome = {
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
};

export type ChunkResult = {
  /** ⭐ False when this chunk had already been committed. See ② above. */
  readonly recorded: boolean;
  readonly runTotals: ChunkOutcome & { readonly expectedRows: number };
  readonly note?: string;
};

/**
 * ⭐⭐⭐ RECORD A COMMITTED CHUNK, EXACTLY ONCE.
 *
 * ⚠️ THE INSERT IS THE LOCK. Checking first and inserting after is a race
 * two browser tabs — or one browser and its own retry — will lose: both
 * read "not committed", both insert, and the totals double. Letting the
 * unique index refuse the second is the only version that is correct
 * without a lock held across the whole chunk.
 *
 * 🔴 AND THE RUN TOTALS ARE UPDATED FROM THE CHUNKS, NOT INCREMENTED.
 * `rows_written = rows_written + n` is wrong for the same reason: a
 * retried chunk that DID insert but whose response was lost would be
 * added twice on the second attempt. Summing the chunk table is
 * idempotent by construction.
 */
export async function recordChunk(args: {
  readonly tenantId: string;
  readonly runId: string;
  readonly chunkIndex: number;
  readonly rowCount: number;
  readonly outcome: ChunkOutcome;
}): Promise<ChunkResult> {
  const { tenantId, runId, chunkIndex, rowCount, outcome } = args;

  const sum = outcome.rowsWritten + outcome.rowsSkipped + outcome.rowsFailed;
  if (sum !== rowCount) {
    throw new ImportRunError(
      `Chunk ${chunkIndex} reported ${sum} outcomes for ${rowCount} rows. Nothing has been ` +
        `recorded — a chunk whose arithmetic does not add up would make the run's totals wrong ` +
        `in a way nobody could later untangle.`,
    );
  }

  return withTenant(tenantId, async (tx) => {
    const inserted = await tx
      .insert(importRunChunks)
      .values({
        tenantId,
        runId,
        chunkIndex,
        rowCount,
        rowsWritten: outcome.rowsWritten,
        rowsSkipped: outcome.rowsSkipped,
        rowsFailed: outcome.rowsFailed,
      })
      /** ⚠️ The unique index on (run_id, chunk_index) is the guarantee. */
      .onConflictDoNothing()
      .returning({ id: importRunChunks.id });

    const recorded = inserted.length > 0;

    const totals = await tx
      .select({
        written: sql<number>`coalesce(sum(${importRunChunks.rowsWritten}), 0)::int`,
        skipped: sql<number>`coalesce(sum(${importRunChunks.rowsSkipped}), 0)::int`,
        failed: sql<number>`coalesce(sum(${importRunChunks.rowsFailed}), 0)::int`,
      })
      .from(importRunChunks)
      .where(and(eq(importRunChunks.tenantId, tenantId), eq(importRunChunks.runId, runId)));

    const written = Number(totals[0]?.written ?? 0);
    const skipped = Number(totals[0]?.skipped ?? 0);
    const failed = Number(totals[0]?.failed ?? 0);

    const [run] = await tx
      .update(importRuns)
      .set({ rowsWritten: written, rowsSkipped: skipped, rowsFailed: failed })
      .where(and(eq(importRuns.tenantId, tenantId), eq(importRuns.id, runId)))
      .returning({ expectedRows: importRuns.expectedRows });

    if (!run) {
      throw new ImportRunError(
        "That migration run no longer exists. Nothing further has been recorded against it.",
      );
    }

    return {
      recorded,
      runTotals: {
        rowsWritten: written,
        rowsSkipped: skipped,
        rowsFailed: failed,
        expectedRows: run.expectedRows,
      },
      ...(recorded
        ? {}
        : {
            note:
              `Part ${chunkIndex + 1} had already been imported, so it was not imported again. ` +
              `This is what happens when a connection drops after the rows were written but ` +
              `before the answer got back — the rows are there, and they are there once.`,
          }),
    };
  });
}

export type FinishResult = {
  readonly status: "completed" | "incomplete";
  readonly message: string;
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly expectedRows: number;
  readonly unaccounted: number;
};

/**
 * ⭐⭐ CLOSE THE RUN — AND IT IS THE DATABASE THAT DECIDES WHETHER IT
 * FINISHED, NOT THE BROWSER.
 *
 * 🔴 `import_runs_completed_is_complete` REFUSES `status = 'completed'`
 * unless every expected row is accounted for. So this function cannot lie
 * even if a future caller asks it to: it computes the status from the
 * totals, and if it ever computed it wrongly the write would fail rather
 * than the customer being told their migration finished.
 */
export async function finishImportRun(args: {
  readonly tenantId: string;
  readonly runId: string;
  /** Set when the person walked away rather than the run failing. */
  readonly abandoned?: boolean;
}): Promise<FinishResult> {
  return withTenant(args.tenantId, async (tx) => {
    const [current] = await tx
      .select({
        expectedRows: importRuns.expectedRows,
        rowsWritten: importRuns.rowsWritten,
        rowsSkipped: importRuns.rowsSkipped,
        rowsFailed: importRuns.rowsFailed,
        entityKey: importRuns.entityKey,
      })
      .from(importRuns)
      .where(and(eq(importRuns.tenantId, args.tenantId), eq(importRuns.id, args.runId)));

    if (!current) throw new ImportRunError("That migration run no longer exists.");

    const accounted = current.rowsWritten + current.rowsSkipped + current.rowsFailed;
    const unaccounted = current.expectedRows - accounted;
    const complete = unaccounted === 0;

    const status = complete ? "completed" : args.abandoned ? "abandoned" : "incomplete";

    /**
     * ⚠️ THE SENTENCE IS THE PRODUCT HERE. "Import finished" over a run
     * that lost 1,600 rows is the failure this whole table exists to
     * prevent, and the number has to be in the message rather than in a
     * status field somebody has to go and look at.
     */
    const message = complete
      ? `All ${current.expectedRows.toLocaleString("en-IN")} rows were accounted for: ` +
        `${current.rowsWritten.toLocaleString("en-IN")} imported, ` +
        `${current.rowsSkipped.toLocaleString("en-IN")} already here, ` +
        `${current.rowsFailed.toLocaleString("en-IN")} refused.`
      : `🔴 ${unaccounted.toLocaleString("en-IN")} of ${current.expectedRows.toLocaleString("en-IN")} ` +
        `rows never arrived. ${current.rowsWritten.toLocaleString("en-IN")} were imported, ` +
        `${current.rowsSkipped.toLocaleString("en-IN")} were already here and ` +
        `${current.rowsFailed.toLocaleString("en-IN")} were refused. Upload the same file again — ` +
        `matching on ${current.entityKey} identity means the rows already here will be recognised ` +
        `rather than duplicated, and only the missing ones will be written.`;

    await tx
      .update(importRuns)
      .set({
        status,
        finishedAt: new Date(),
        stoppedReason: complete ? null : message,
      })
      .where(and(eq(importRuns.tenantId, args.tenantId), eq(importRuns.id, args.runId)));

    return {
      status: complete ? "completed" : "incomplete",
      message,
      rowsWritten: current.rowsWritten,
      rowsSkipped: current.rowsSkipped,
      rowsFailed: current.rowsFailed,
      expectedRows: current.expectedRows,
      unaccounted,
    };
  });
}

export type ImportRunView = {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly entityKey: string;
  readonly sourceFormat: string;
  readonly sourceName: string | null;
  readonly status: string;
  readonly expectedRows: number;
  readonly rowsWritten: number;
  readonly rowsSkipped: number;
  readonly rowsFailed: number;
  readonly stoppedReason: string | null;
};

/**
 * ⭐ THE RUNS, NEWEST FIRST — AND THE UNFINISHED ONES ARE THE POINT.
 * "Which of my uploads did not finish" is the only question this screen
 * is really for.
 */
export async function listImportRuns(
  tenantId: string,
  limit = 50,
): Promise<ImportRunView[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: importRuns.id,
        startedAt: importRuns.startedAt,
        finishedAt: importRuns.finishedAt,
        entityKey: importRuns.entityKey,
        sourceFormat: importRuns.sourceFormat,
        sourceName: importRuns.sourceName,
        status: importRuns.status,
        expectedRows: importRuns.expectedRows,
        rowsWritten: importRuns.rowsWritten,
        rowsSkipped: importRuns.rowsSkipped,
        rowsFailed: importRuns.rowsFailed,
        stoppedReason: importRuns.stoppedReason,
      })
      .from(importRuns)
      .where(eq(importRuns.tenantId, tenantId))
      .orderBy(sql`${importRuns.startedAt} DESC`)
      .limit(Math.min(200, Math.max(1, limit)));
    return rows;
  });
}
