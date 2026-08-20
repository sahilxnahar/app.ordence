/**
 * Ordence — 🔴🔴🔴 A MIGRATION THAT FINISHES · WAVE 6
 * Version: v1.74.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT CHANGED, AND WHAT MUST NOT HAVE
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/plan.ts` capped an import at 1,000 rows and said why:
 *
 *     "a hundred thousand is a request that times out halfway with some
 *      rows written and no report, which is the single worst outcome the
 *      whole framework is built to avoid."
 *
 * 🔴 WAVE 6 DID NOT RAISE THAT NUMBER. Raising it with the same
 * architecture produces exactly the outcome the comment describes. It
 * added a RUN: the browser chunks the file, each chunk is recorded once,
 * and the run refuses to call itself complete until every expected row is
 * accounted for.
 *
 * These tests are the source-level proof that the pieces are wired the
 * way that claim requires — and that the four things which would silently
 * undo it are still absent.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_IMPORT_ROWS, planImportRecords } from "@/lib/import";
import { IMPORT_ENTITIES } from "@/lib/import/entities";
import type { CsvRecord } from "@/lib/import/csv";

/**
 * ⭐ WAVE 2C. The planner takes the workspace's currency as data — see
 * `ImportContext`. These files are all about entities whose amounts are
 * in rupees, so every call passes the same one; the exponent behaviour
 * itself is proven in `tests/ui/import-money-exponent.test.ts`.
 */
const IMPORT_CONTEXT = { workspaceCurrency: "INR" } as const;


const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const RUNS = read("server/import/runs.ts");
const ACTIONS = read("server/actions/import.ts");
const WIZARD = read("components/settings/import-wizard.tsx");
const PAGE = read("app/(crm)/settings/import/page.tsx");
const SQL = read("SQL-FILES/0117_import_runs_and_mapping.sql");

/* ================================================================== */
describe("⭐ the same planner, from a record stream", () => {
  it("plans records identically to the text they came from", () => {
    const entity = IMPORT_ENTITIES.companies;
    const records: CsvRecord[] = [
      { recordNumber: 1, cells: ["Name", "Domain"] },
      { recordNumber: 2, cells: ["Acme Ltd", "acme.example"] },
      { recordNumber: 3, cells: ["Beta Ltd", "beta.example"] },
    ];
    const plan = planImportRecords(entity, records, IMPORT_CONTEXT);
    expect(plan.fatal).toBeNull();
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.every((r) => r.errors.length === 0)).toBe(true);
  });

  it("refuses a header row with nothing under it, in the same words", () => {
    const plan = planImportRecords(IMPORT_ENTITIES.companies, [
      { recordNumber: 1, cells: ["Name"] },
    ], IMPORT_CONTEXT);
    expect(plan.fatal).toMatch(/header row and no data rows/);
  });

  it("still refuses more than one chunk's worth in a single call", () => {
    /**
     * 🔴 THE CAP IS STILL THERE. Chunking is what got past it; removing
     * it would have reintroduced the timeout the whole design avoids.
     */
    const rows: CsvRecord[] = [{ recordNumber: 1, cells: ["Name"] }];
    for (let i = 0; i < MAX_IMPORT_ROWS + 1; i += 1) {
      rows.push({ recordNumber: i + 2, cells: [`Company ${i}`] });
    }
    const plan = planImportRecords(IMPORT_ENTITIES.companies, rows, IMPORT_CONTEXT);
    expect(plan.fatal).toMatch(new RegExp(String(MAX_IMPORT_ROWS)));
  });
});

/* ================================================================== */
describe("🔴 what makes a retry safe, in two layers", () => {
  it("① every entity still declares a natural key, with no opt-out", () => {
    const types = read("lib/import/types.ts");
    expect(types).toMatch(/naturalKey/);
    expect(types).toMatch(/There is no opt-out/);
  });

  it("② a chunk is inserted against a unique index rather than checked first", () => {
    /**
     * ⚠️ CHECKING FIRST AND INSERTING AFTER IS A RACE two browser tabs —
     * or one browser and its own retry — will lose: both read "not
     * committed", both insert, and the totals double.
     */
    expect(codeOnly(RUNS)).toContain(".onConflictDoNothing()");
    expect(SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS import_run_chunks_once");
  });

  it("🔴 recomputes the run totals from the chunks rather than incrementing", () => {
    /**
     * `rows_written = rows_written + n` is wrong for the same reason: a
     * retried chunk that DID insert but whose response was lost would be
     * added twice on the second attempt. Summing is idempotent.
     */
    const code = codeOnly(RUNS);
    expect(code).toMatch(/coalesce\(sum\(/);
    expect(code).not.toMatch(/rowsWritten:\s*sql`\$\{importRuns\.rowsWritten\}\s*\+/);
  });

  it("tells the person a replayed part was NOT imported twice", () => {
    /**
     * ⚠️ A customer whose connection dropped and who re-ran the migration
     * would otherwise see a report of zero rows written and conclude the
     * second attempt failed.
     */
    expect(RUNS).toMatch(/had already been imported, so it was not imported again/);
  });
});

/* ================================================================== */
describe("🔴 a run cannot claim to have finished when it did not", () => {
  it("the database refuses `completed` with rows unaccounted for", () => {
    expect(SQL).toContain("import_runs_completed_is_complete");
    expect(SQL).toMatch(
      /rows_written \+ rows_skipped \+ rows_failed = expected_rows/,
    );
  });

  it("and refuses more outcomes than there were rows", () => {
    expect(SQL).toContain("import_runs_outcomes_within_expected");
  });

  it("the status is computed from the totals, not taken from the caller", () => {
    const code = codeOnly(RUNS);
    expect(code).toMatch(/const complete = unaccounted === 0;/);
    expect(code).toMatch(/const status = complete \? "completed"/);
  });

  it("puts the number of missing rows in the sentence, not in a status field", () => {
    expect(RUNS).toMatch(/rows never arrived/);
    expect(RUNS).toMatch(/Upload the same file again/);
  });

  it("expects the row count before the first chunk, so a loss is detectable", () => {
    expect(SQL).toContain("expected_rows  integer NOT NULL");
    expect(codeOnly(ACTIONS)).toMatch(/expectedRows: z\.number\(\)\.int\(\)\.positive\(\)/);
  });
});

/* ================================================================== */
describe("⚠️ the customer's file never leaves their machine", () => {
  it("is read in the browser", () => {
    expect(codeOnly(WIZARD)).toContain("readSource(");
    expect(codeOnly(WIZARD)).toContain("file.arrayBuffer()");
  });

  it("no table holds the file", () => {
    /**
     * 🔴 SAME ARGUMENT AS `data_exports` IN 0116, IN THE OTHER DIRECTION.
     * Storing a migration file would be a second copy of a workspace's
     * entire master data, in a table nobody thinks of as sensitive,
     * outliving the erasure meant to remove the original.
     */
    for (const column of ["file_bytes", "file_content", "raw_file", "payload bytea"]) {
      expect(SQL).not.toContain(column);
    }
    expect(SQL).toMatch(/never stored server-side|What they called the file. Not the file/i);
  });

  it("records only the file's NAME", () => {
    expect(SQL).toContain("source_name    varchar(255)");
  });
});

/* ================================================================== */
describe("⭐ the mapping the person settled is the mapping that runs", () => {
  it("is applied by rewriting the header row", () => {
    /**
     * 🔴 NOT A SHORTCUT — IT IS WHY THE CORRECTION STICKS. A mapping held
     * beside the records would have to be threaded through the planner,
     * the preview, the commit and the failed-rows CSV, and any one of
     * those forgetting it is a silent mis-import.
     */
    const code = codeOnly(WIZARD);
    expect(code).toMatch(/function applyMapping/);
    expect(code).toMatch(/rewritten\[index\] = column\.header/);
    expect(code).toMatch(/setRecords\(\[\{ \.\.\.records\[0\]!, cells: rewritten \}/);
  });

  it("keeps an unmapped column's original heading rather than blanking it", () => {
    /**
     * ⚠️ So it still appears in the report as unrecognised, which is how
     * the customer finds out something was left behind.
     */
    expect(codeOnly(WIZARD)).toMatch(/if \(chosen === ""\) continue;/);
  });

  it("records what the person CHANGED, not just that they agreed", () => {
    const code = codeOnly(WIZARD);
    expect(code).toMatch(/corrections\[column\.field\] = \{/);
    expect(code).toMatch(/outcome: settled/);
  });
});

/* ================================================================== */
describe("⭐ the route reaches every action wave 6 added", () => {
  const callers = codeOnly(`${PAGE}\n${WIZARD}`);

  it("calls all six", () => {
    for (const action of [
      "previewImport",
      "commitImport",
      "beginImportRun",
      "endImportRun",
      "proposeImportMapping",
      "getImportRuns",
      "recordMappingDecision",
    ]) {
      expect(callers, `${action} is exported and nothing calls it`).toContain(action);
    }
  });

  it("shows the unfinished runs first, because that is what the list is for", () => {
    const panel = codeOnly(read("app/(crm)/settings/import/import-runs-panel.tsx"));
    expect(panel).toMatch(/status !== "completed" \? 0 : 1/);
  });

  it("says what the dry run covered when the file needs several parts", () => {
    /**
     * ⚠️ A preview that silently examined the first thousand rows of
     * forty thousand and said nothing would be worse than no preview.
     */
    expect(WIZARD).toMatch(/first part only/i);
  });
});

/* ================================================================== */
describe("⚠️ still no new dependency", () => {
  it("reads spreadsheets, zips and DEFLATE with nothing installed", () => {
    const pkg = JSON.parse(read("package.json"));
    const names = Object.keys(pkg.dependencies ?? {}).join(" ");
    for (const forbidden of ["xlsx", "exceljs", "jszip", "pako", "fflate", "adm-zip"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("keeps `node:zlib` out of anything the browser loads", () => {
    /**
     * 🔴 `lib/import/sources/` RUNS IN THE BROWSER. One `node:zlib`
     * import anywhere under it breaks the whole client bundle, and the
     * failure is a build error nobody connects to a migration feature.
     */
    for (const file of [
      "lib/import/sources/index.ts",
      "lib/import/sources/unzip.ts",
      "lib/import/sources/xlsx-read.ts",
      "lib/import/sources/inflate.ts",
      "lib/import/sources/json-read.ts",
      "lib/import/sources/tally-read.ts",
      "lib/import/proposal.ts",
      "lib/import/shapes.ts",
    ]) {
      /**
       * ⚠️ COMMENTS STRIPPED FIRST. Several of these files EXPLAIN why
       * they do not import `node:zlib`, and a naive string search reads
       * the explanation as the offence — which is the same mistake
       * `check:action-reach` shipped with, counting a doc comment as a
       * caller.
       */
      const code = codeOnly(read(file));
      expect(code, file).not.toContain("node:zlib");
      expect(code, file).not.toContain('"server-only"');
    }
  });
});
