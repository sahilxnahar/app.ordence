import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE DRY RUN, MADE CHECKABLE
 * Version: v1.84.1-alpha · Phase 3
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO CLAIMS, AND WHY NEITHER OF THEM IS SELF-EVIDENT
 * ══════════════════════════════════════════════════════════════════════
 *   ① A DRY RUN TOUCHES NOTHING.
 *   ② THE NUMBER IT REPORTS IS THE NUMBER THAT LANDS.
 *
 * `server/actions/import.ts` already argues for both at length, and its
 * argument is correct: `previewImport` and `commitImport` are two thin
 * wrappers over one private `runImport`, which branches on `mode` exactly
 * once, BELOW every decision about every row.
 *
 * ⚠️ AN ARGUMENT IS NOT A CHECK. This repository's characteristic defect
 * is built-and-unreachable, declared-and-unenforced, or verified-by-a-
 * floor, and it has been found more than thirty times — including four
 * times in the checkers written to catch it. A guarantee whose only
 * evidence is a comment describing the shape of the code is a guarantee
 * one refactor from being false, silently, with a preview that still
 * prints a confident number.
 *
 * 🔴 SO THIS FILE IS NOT A SECOND IMPORT ENGINE. It executes the shipping
 * one, twice, and measures. That distinction is the whole design and it
 * is defended in `verifyDryRun` below: the verifier is handed a RUNNER
 * and the only thing it may vary is `mode` — the same single argument
 * `previewImport` and `commitImport` themselves differ by. A verifier
 * that could pass anything else would be a verifier that could take a
 * path the product does not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THE OBVIOUS VERSION OF THIS FILE GETS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * The obvious footprint check counts `companies` before and after and
 * asserts equality. Four ways that passes while the property is false,
 * all four handled below and three of them in SQL 0216 rather than here:
 *
 *   ⓐ IT COUNTS AS A ROLE THAT BYPASSES RLS. Every count spans every
 *      tenant, so a write into the workspace under test is a rounding
 *      error in somebody else's data.
 *   ⓑ IT COUNTS WITH NO TENANT SET. Under FORCE ROW LEVEL SECURITY every
 *      policy is false, `count(*)` is 0 on a table of a million rows, and
 *      before = after = 0. The proof passes without looking at anything.
 *   ⓒ IT COUNTS ONLY THE ENTITY'S OWN TABLE. `opening-trial-balance`
 *      declares `targets: ["transactions"]` and its writer also inserts
 *      into `journal_entries` — so the check is blind to the table that
 *      holds the money. `everyTenantScopedDestination()` exists for this,
 *      and `undeclaredDestinations` on the verdict reports the gap rather
 *      than papering over it.
 *   ⓓ IT COUNTS `import_row_provenance` ONLY IF IT EXISTS. A footprint
 *      that quietly omits a table it was asked about is a proof with a
 *      hole in the exact place somebody asked. SQL 0216 refuses.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import type { ContractedImportEntity, ImportReport, RowDisposition } from "@/lib/import/types";

/* ------------------------------------------------------------------ */
/* WHAT MUST ALWAYS BE COUNTED                                         */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE SIDECAR IS A DESTINATION EVEN THOUGH NO ENTITY DECLARES IT.
 *
 * A row and its provenance are written in the same transaction (SQL
 * 0215), so provenance appearing during a preview is the same defect as
 * a company appearing during a preview — and it is the one a footprint
 * built from `contract.provenance.targets` would never look at, because
 * the sidecar is not any entity's target. It is every entity's target.
 */
export const PROVENANCE_TABLE = "import_row_provenance";

/**
 * Every table this entity's contract says it may write, plus the sidecar.
 *
 * ⚠️ READ FROM THE CONTRACT, NEVER FROM A LIST HERE. A second list of
 * destinations would be a second model of a fact `ImportProvenancePolicy`
 * already holds, and it would go stale on the first entity Phase 4 adds —
 * silently, because a destination missing from a footprint does not fail,
 * it just stops being looked at.
 */
export function declaredDestinations(entity: ContractedImportEntity): readonly string[] {
  return unique([...entity.contract.provenance.targets, PROVENANCE_TABLE]);
}

/**
 * The union across a whole registry — for a folder migration that loads
 * several entities and must be shown to have moved nothing between them.
 */
export function allDeclaredDestinations(
  entities: Readonly<Record<string, ContractedImportEntity>>,
): readonly string[] {
  return unique([
    ...Object.values(entities).flatMap((entity) => [...entity.contract.provenance.targets]),
    PROVENANCE_TABLE,
  ]);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * ⭐⭐ EVERY TENANT-SCOPED TABLE IN THE DATABASE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE ONLY COMPLETE ANSWER TO "DID THE PREVIEW WRITE ANYTHING"
 * ══════════════════════════════════════════════════════════════════════
 * A footprint built from the contracts can only detect a write to a table
 * somebody DECLARED. The write worth catching is the one nobody declared:
 * an audit row, a counter, a cache, a sidecar — or `journal_entries`,
 * which `opening-trial-balance` writes and does not declare.
 *
 * ⚠️ IT IS EXPENSIVE AND SAYING SO IS PART OF OFFERING IT. Three hundred
 * `count(*)`s against a large workspace is not something to run inside a
 * customer's import. It is what a TEST and a cutover rehearsal run, and
 * `declaredDestinations()` is what a production self-check runs. The
 * choice is the caller's and it is explicit rather than defaulted,
 * because a default here decides between "complete" and "fast" for
 * somebody who did not know they were choosing.
 *
 * ⚠️ `tenant_id` IS THE MEMBERSHIP TEST, THE SAME ONE
 * `scripts/check-rls-coverage.mjs` USES. A table with no `tenant_id`
 * cannot hold a row belonging to the workspace under test, so a change in
 * it is not attributable to this run and counting it would produce
 * unexplainable noise — platform tables tick over on their own.
 */
export async function everyTenantScopedDestination(
  tenantId: string,
): Promise<readonly string[]> {
  const rows = await withTenant(tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT c.table_name::text AS table_name
        FROM information_schema.columns c
        JOIN pg_class k
          ON k.relname = c.table_name
         AND k.relnamespace = 'public'::regnamespace
       WHERE c.table_schema = 'public'
         AND c.column_name  = 'tenant_id'
         AND k.relkind      = 'r'
       ORDER BY c.table_name
    `);
    return result.rows as { table_name: string }[];
  });

  /*
   * ⚠️ THE SIDECAR IS ADDED RATHER THAN ASSUMED PRESENT. It carries a
   * `tenant_id` and so it is already in the list — but only once SQL 0215
   * has been applied, and on a database where it has NOT been applied the
   * union is what turns a silent omission into SQL 0216's refusal. The
   * difference between "not counted" and "counted and missing" is the
   * whole of ⓓ in the header.
   */
  return unique([...rows.map((row) => row.table_name), PROVENANCE_TABLE]);
}

/* ------------------------------------------------------------------ */
/* THE MEASUREMENT                                                     */
/* ------------------------------------------------------------------ */

export type Footprint = {
  readonly tenantId: string;
  /** Destination → row count, as one snapshot. */
  readonly counts: ReadonlyMap<string, number>;
};

export type FootprintDelta = {
  readonly destination: string;
  readonly before: number;
  readonly after: number;
  /** Signed. A negative number is a DELETE and is drift just the same. */
  readonly moved: number;
};

/**
 * ⭐ ONE SNAPSHOT, THROUGH THE CALLER'S OWN POLICIES.
 *
 * ⚠️ ALL THE REFUSALS ARE IN SQL 0216 AND NOT HERE, AND THAT IS THE
 * POINT. ⓐ and ⓑ from the header are properties of the CONNECTION — a
 * guard written in TypeScript is a guard the next caller can forget to
 * call. `import_destination_row_count()` refuses a superuser, refuses a
 * BYPASSRLS role, refuses a call with no tenant scope, refuses an empty
 * list and refuses a name that is not a table, and it does all five
 * inside the transaction doing the counting.
 *
 * ⚠️ AND IT THROWS RATHER THAN RETURNING A RESULT. Every other refusal in
 * the import framework is a value, because the audience is a customer
 * with a file. The audience for this one is a test and a rehearsal, where
 * a measurement that could not be taken must stop the run rather than
 * flow onward as an empty map that compares equal to everything.
 */
/**
 * ⚠️ THE DATABASE'S OWN SENTENCE, NOT "FAILED QUERY".
 *
 * Drizzle wraps a driver error in `Failed query: SELECT …` with three
 * hundred bound parameters after it and puts the real message on `cause`.
 * Every refusal `import_destination_row_count()` raises was written for a
 * person to read — *"was called as postgres, which is a superuser"*,
 * *"was called with no tenant scope"* — and losing them behind a query
 * dump is the same mistake `describeWriteFailure` in
 * `server/actions/import.ts` exists to avoid, one layer down.
 */
function withDatabaseSentence(err: unknown): Error {
  for (let cause: unknown = err, depth = 0; cause && depth < 5; depth += 1) {
    const candidate = cause as { message?: unknown; cause?: unknown; code?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      const wrapped = new Error(`[import:dryrun] ${candidate.message}`);
      wrapped.cause = err;
      return wrapped;
    }
    cause = candidate.cause;
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function measureFootprint(
  tenantId: string,
  destinations: readonly string[],
): Promise<Footprint> {
  const rows = await withTenant(tenantId, async (tx) => {
    /*
     * ⚠️ `sql.param()`, NOT A BARE ARRAY. Drizzle expands a plain JS array
     * inside a template into a COMMA-SEPARATED LIST of placeholders —
     * `($1, $2, … $307)` — which Postgres reads as a record and refuses to
     * cast to `text[]`. The failure is loud (42846) rather than silent,
     * which is the only good thing about it. `sql.param()` binds the whole
     * array as one value and node-postgres serialises it as an array
     * literal.
     */
    const result = await tx.execute(sql`
      SELECT destination, row_count
        FROM import_destination_row_count(${sql.param([...destinations])}::text[])
    `);
    return result.rows as { destination: string; row_count: string | number }[];
  }).catch((err: unknown) => {
    throw withDatabaseSentence(err);
  });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.destination, Number(row.row_count));

  /*
   * 🔴 THE FUNCTION MUST HAVE ANSWERED ABOUT EVERY DESTINATION IT WAS
   * ASKED ABOUT. 0216 refuses an unknown name, so a short answer can only
   * mean the two sides disagree about what was asked — and a footprint
   * missing a row silently becomes a footprint that cannot detect a
   * change in it.
   */
  if (counts.size !== new Set(destinations).size) {
    throw new Error(
      `[import:dryrun] asked import_destination_row_count() about ` +
        `${new Set(destinations).size} destination(s) and it answered about ` +
        `${counts.size}. A footprint that is short by one is blind to that one.`,
    );
  }

  return { tenantId, counts };
}

/**
 * What moved between two footprints. Empty is the answer a preview must
 * produce.
 *
 * ⚠️ IT REFUSES TWO FOOTPRINTS OF DIFFERENT SHAPES rather than comparing
 * the intersection. Comparing what they have in common is how a
 * destination that appeared between the two measurements — a table
 * created by a concurrent migration, or a list built twice from two
 * different sources — drops out of the comparison entirely.
 */
export function footprintDelta(
  before: Footprint,
  after: Footprint,
): readonly FootprintDelta[] {
  if (before.tenantId !== after.tenantId) {
    throw new Error(
      `[import:dryrun] compared a footprint of tenant ${before.tenantId} with one of ` +
        `${after.tenantId}. Those are two different databases as far as row-level ` +
        `security is concerned.`,
    );
  }

  const destinations = unique([...before.counts.keys(), ...after.counts.keys()]);
  const missing = destinations.filter(
    (d) => !before.counts.has(d) || !after.counts.has(d),
  );
  if (missing.length > 0) {
    throw new Error(
      `[import:dryrun] the two footprints do not cover the same destinations. ` +
        `Only one of them counted: ${missing.join(", ")}.`,
    );
  }

  const deltas: FootprintDelta[] = [];
  for (const destination of destinations) {
    const from = before.counts.get(destination) ?? 0;
    const to = after.counts.get(destination) ?? 0;
    if (from !== to) deltas.push({ destination, before: from, after: to, moved: to - from });
  }
  return deltas;
}

/* ------------------------------------------------------------------ */
/* THE COMPARISON                                                      */
/* ------------------------------------------------------------------ */

export type CountDrift = {
  readonly disposition: RowDisposition;
  readonly preview: number;
  readonly commit: number;
};

export type RowDrift = {
  readonly recordNumber: number;
  readonly preview: RowDisposition;
  readonly commit: RowDisposition;
  /** What the commit said, when it turned an outcome into an error. */
  readonly commitErrors: readonly string[];
};

export type ReportComparison = {
  /**
   * 🔴 A DISPOSITION THAT CHANGED IN A WAY THE PREVIEW COULD HAVE KNOWN.
   * Every one of these is the failure this phase exists to prevent.
   */
  readonly drift: readonly RowDrift[];
  /**
   * ⚠️ `create` → `error`, AND ONLY THAT, KEPT APART FROM DRIFT.
   *
   * `server/actions/import.ts` names exactly two things a preview cannot
   * foresee: a database constraint nothing in the schema layer models,
   * and anything a colleague writes in the seconds between the two
   * clicks. Both surface as a planned creation the database refused, and
   * both are honest — the wizard says so before the run.
   *
   * 🔴 IT IS STILL NOT "FINE". Folding it into drift would make the
   * verifier unusable on a real customer run; folding drift into it would
   * make the verifier useless. So they are two fields and the corpus is
   * built so this one is EMPTY — see `exact` below. A residue that
   * appears where none should is a finding, and it is visible.
   */
  readonly writeResidue: readonly RowDrift[];
  /** Every disposition whose totals differ. Reported whatever the cause. */
  readonly countDrift: readonly CountDrift[];
  /** Set when the two runs disagreed about whether the FILE was refused. */
  readonly fatalDrift: string | null;
  /** Set when the two runs disagreed about how many rows the file had. */
  readonly totalRowsDrift: string | null;
};

/**
 * ⭐⭐⭐ THE COMPARISON, ROW BY ROW AND NOT COUNT BY COUNT.
 *
 * ⚠️ EQUAL COUNTS ARE NOT EQUAL OUTCOMES, AND THE DIFFERENCE IS A REAL
 * FAILURE. A commit that turns row 4 from `create` into `skip` and row 9
 * from `skip` into `create` reports the identical four totals the preview
 * did. The customer is told 412 will be created and 412 are created — and
 * they are not the same 412. Comparing totals alone cannot see it;
 * comparing per-record dispositions can, and costs one map.
 */
export function compareRuns(preview: ImportReport, commit: ImportReport): ReportComparison {
  const drift: RowDrift[] = [];
  const writeResidue: RowDrift[] = [];

  const commitRows = new Map(commit.rows.map((row) => [row.recordNumber, row]));

  for (const previewRow of preview.rows) {
    const commitRow = commitRows.get(previewRow.recordNumber);

    if (!commitRow) {
      drift.push({
        recordNumber: previewRow.recordNumber,
        preview: previewRow.disposition,
        commit: "error",
        commitErrors: [
          "The commit report does not mention this record at all. A row that " +
            "vanishes between the two runs is a row nobody can be told about.",
        ],
      });
      continue;
    }

    if (commitRow.disposition === previewRow.disposition) continue;

    const entry: RowDrift = {
      recordNumber: previewRow.recordNumber,
      preview: previewRow.disposition,
      commit: commitRow.disposition,
      commitErrors: commitRow.errors.map((error) => error.message),
    };

    if (previewRow.disposition === "create" && commitRow.disposition === "error") {
      writeResidue.push(entry);
    } else {
      drift.push(entry);
    }
  }

  /*
   * ⚠️ AND THE OTHER DIRECTION. A record the COMMIT reports and the
   * preview does not is the same defect read from the other end, and a
   * loop over the preview's rows alone would never see it.
   *
   * `ImportReport.rows` samples its successes — see the note on it — so
   * the two reports can legitimately show different SUBSETS of successful
   * rows. That is why a record present in one and absent from the other is
   * only drift when it is present in the PREVIEW (above): the preview's
   * sample is the promise, and the commit's sample is a different draw
   * from the same list.
   */
  const previewRecords = new Set(preview.rows.map((row) => row.recordNumber));
  for (const commitRow of commit.rows) {
    if (previewRecords.has(commitRow.recordNumber)) continue;
    if (commitRow.disposition !== "error") continue;
    drift.push({
      recordNumber: commitRow.recordNumber,
      preview: "skip",
      commit: commitRow.disposition,
      commitErrors: [
        "The commit reported this record as an error and the preview did not " +
          "mention it. Every failed row is reported in full by both runs — see " +
          "ImportReport.rows — so an error visible in only one of them is drift.",
        ...commitRow.errors.map((error) => error.message),
      ],
    });
  }

  const countDrift: CountDrift[] = [];
  for (const disposition of ["create", "update", "skip", "error"] as const) {
    if (preview.counts[disposition] !== commit.counts[disposition]) {
      countDrift.push({
        disposition,
        preview: preview.counts[disposition],
        commit: commit.counts[disposition],
      });
    }
  }

  return {
    drift: drift.sort((a, b) => a.recordNumber - b.recordNumber),
    writeResidue,
    countDrift,
    fatalDrift:
      preview.fatal === commit.fatal
        ? null
        : `The preview ${preview.fatal ? `refused the file: "${preview.fatal}"` : "accepted the file"}, ` +
          `and the commit ${commit.fatal ? `refused it: "${commit.fatal}"` : "accepted it"}. ` +
          `A file rule that reaches a different verdict on the second reading is a ` +
          `rule that depends on something other than the file.`,
    totalRowsDrift:
      preview.totalRows === commit.totalRows
        ? null
        : `The preview read ${preview.totalRows} rows and the commit read ` +
          `${commit.totalRows}. Both parsed the same bytes with the same parser.`,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE VERIFICATION                                              */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE ONLY THING THE VERIFIER MAY VARY.
 *
 * `mode` is the single argument `previewImport` and `commitImport`
 * themselves differ by. A runner taking anything else — a flag, an
 * options object, a "skip the slow parts" — would let the verifier drive
 * a path the product does not have, and a green verification of a path
 * nobody ships is the most expensive kind of green.
 */
export type DryRunRunner = (mode: "preview" | "commit") => Promise<ImportReport>;

export type DryRunVerdict = {
  /**
   * ⚠️ `ok` MEANS "NOTHING DRIFTED", NOT "NOTHING FAILED". A file whose
   * every row is an error is a perfectly good dry run if the commit says
   * the same thing about the same rows. What this verifies is agreement,
   * not success — and conflating the two would make the verifier refuse
   * exactly the corpus that proves it works.
   */
  readonly ok: boolean;
  /** `ok`, and additionally no write residue: the counts are equal outright. */
  readonly exact: boolean;
  readonly problems: readonly string[];

  readonly preview: ImportReport;
  readonly commit: ImportReport;
  readonly comparison: ReportComparison;

  /** 🔴 MUST BE EMPTY. What the PREVIEW moved. */
  readonly previewMoved: readonly FootprintDelta[];
  /** What the COMMIT moved. Reported, never required to be anything. */
  readonly commitMoved: readonly FootprintDelta[];
  /**
   * ⭐ DESTINATIONS THE COMMIT MOVED THAT THE ENTITY'S CONTRACT DOES NOT
   * DECLARE. Not a failure of the dry run — a gap in
   * `ImportProvenancePolicy.targets`, which decides what a reversal can
   * undo and what a reconciliation can tie. Reported here because this is
   * the only place in the product that both writes and measures.
   */
  readonly undeclaredDestinations: readonly string[];
};

/**
 * Run the shipping preview, prove it moved nothing, run the shipping
 * commit, and prove it did exactly what the preview said it would.
 *
 * ⚠️ THE ORDER OF THE THREE MEASUREMENTS IS THE PROOF AND IT IS NOT
 * REARRANGEABLE. `before → preview → afterPreview → commit → afterCommit`.
 * Measuring only before and after BOTH runs would let a preview that
 * wrote a row and a commit that failed to write one cancel out — two
 * defects producing a clean bill of health.
 */
export async function verifyDryRun(args: {
  readonly tenantId: string;
  readonly entity: ContractedImportEntity;
  readonly destinations: readonly string[];
  readonly run: DryRunRunner;
}): Promise<DryRunVerdict> {
  const { tenantId, entity, destinations, run } = args;

  const before = await measureFootprint(tenantId, destinations);

  const preview = await run("preview");
  const afterPreview = await measureFootprint(tenantId, destinations);
  const previewMoved = footprintDelta(before, afterPreview);

  const commit = await run("commit");
  const afterCommit = await measureFootprint(tenantId, destinations);
  const commitMoved = footprintDelta(afterPreview, afterCommit);

  const comparison = compareRuns(preview, commit);

  const declared = new Set(declaredDestinations(entity));
  const undeclaredDestinations = commitMoved
    .map((delta) => delta.destination)
    .filter((destination) => !declared.has(destination))
    .sort();

  const problems: string[] = [];

  for (const delta of previewMoved) {
    problems.push(
      `The dry run moved ${Math.abs(delta.moved)} row${Math.abs(delta.moved) === 1 ? "" : "s"} ` +
        `${delta.moved > 0 ? "into" : "out of"} ${delta.destination} ` +
        `(${delta.before} → ${delta.after}). A dry run must touch nothing, and every ` +
        `safety mechanism in this product is decoration once it does.`,
    );
  }

  if (comparison.fatalDrift) problems.push(comparison.fatalDrift);
  if (comparison.totalRowsDrift) problems.push(comparison.totalRowsDrift);

  for (const row of comparison.drift) {
    problems.push(
      `Record ${row.recordNumber}: the preview said "${row.preview}" and the commit ` +
        `did "${row.commit}"` +
        (row.commitErrors.length > 0 ? ` — ${row.commitErrors[0]}` : ".") +
        ` The preview is the promise; this is the drift that teaches a customer to ` +
        `stop reading previews.`,
    );
  }

  const ok = problems.length === 0;

  return {
    ok,
    exact: ok && comparison.writeResidue.length === 0 && comparison.countDrift.length === 0,
    problems,
    preview,
    commit,
    comparison,
    previewMoved,
    commitMoved,
    undeclaredDestinations,
  };
}

/**
 * ⚠️ ONE SENTENCE PER PROBLEM, ASSEMBLED HERE RATHER THAN AT EVERY CALL
 * SITE. A rehearsal, a test failure message and a support transcript
 * should say the same thing about the same verdict.
 */
export function describeVerdict(verdict: DryRunVerdict): string {
  if (verdict.exact) {
    return (
      `The dry run moved nothing and the commit did exactly what it said: ` +
      `${verdict.preview.counts.create} created, ${verdict.preview.counts.update} updated, ` +
      `${verdict.preview.counts.skip} skipped, ${verdict.preview.counts.error} refused.`
    );
  }
  if (verdict.ok) {
    return (
      `The dry run moved nothing and no row's outcome drifted, but the database ` +
      `refused ${verdict.comparison.writeResidue.length} row(s) the preview expected to ` +
      `create — the residue a preview genuinely cannot foresee. ` +
      `Record${verdict.comparison.writeResidue.length === 1 ? "" : "s"} ` +
      `${verdict.comparison.writeResidue.map((r) => r.recordNumber).join(", ")}.`
    );
  }
  return verdict.problems.join("\n");
}
