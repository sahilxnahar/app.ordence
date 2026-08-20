#!/usr/bin/env node
/**
 * Ordence — Track F · THE CATALOGUE MUST STILL DESCRIBE THE CODE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ROT THIS PREVENTS
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/perf/queries.mjs` is a set of SQL transcriptions of queries
 * the application really issues, each citing the file it came from. That
 * makes it useful and it makes it a liability: the day somebody edits
 * `server/actions/contacts.ts`, the transcription is a description of
 * code that no longer exists — and the budget gate goes on cheerfully
 * measuring a query nothing runs.
 *
 * A benchmark that measures a query the product no longer issues is not
 * a weaker benchmark. It is a worse one than none, because it is green.
 *
 * ⚠️ THIS DOES NOT PARSE DRIZZLE. It cannot: the real call sites build
 * queries from a fluent builder across a dozen lines. What it CAN do is
 * assert that the cited FILE still exists, and that the tables the
 * transcription reads are still named in it. That is a weak check, and a
 * weak check that runs beats a strong one that does not.
 *
 * ⚠️ AND IT SAYS SO. The output states exactly what was and was not
 * verified, because "catalogue verified" would overstate this by a mile.
 *
 * Exit 0 pass · 1 fail. No database needed, runs in milliseconds.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QUERIES } from "./queries.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];
const fail = (m) => {
  console.error(`::error::${m}`);
  failures.push(m);
};

/** Pull `path/to/file.ts` out of a `source` string, ignoring the rest. */
function citedFiles(source) {
  return [...source.matchAll(/([\w./-]+\.(?:ts|tsx|sql|mjs))/g)].map((m) => m[1]);
}

/** Tables a transcription reads: everything after FROM or JOIN. */
function tablesIn(sql) {
  return [
    ...new Set(
      [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()),
    ),
  ];
}

let checkedFiles = 0;
let checkedTables = 0;
let derivedCount = 0;

for (const q of QUERIES) {
  if (!q.source || q.source.trim() === "") {
    fail(`${q.id} has no \`source\`. An entry with no provenance is a synthetic benchmark.`);
    continue;
  }

  const files = citedFiles(q.source);
  if (files.length === 0) {
    fail(`${q.id} cites no file in its \`source\` ("${q.source}").`);
    continue;
  }

  for (const rel of files) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      fail(
        `${q.id} cites ${rel}, which no longer exists. Either the query moved or it is ` +
          `gone; either way the transcription in scripts/perf/queries.mjs is now fiction.`,
      );
      continue;
    }
    checkedFiles++;
    if (q.derived) derivedCount++;

    /*
     * ⚠️ A DERIVED ENTRY REPRODUCES A PATTERN, NOT A STATEMENT.
     * `invoices.overdue` pushes a predicate the application evaluates in
     * JavaScript down into SQL; `audit.deepOffset` measures the
     * unbounded-OFFSET shape from `records.ts` against a bigger table.
     * Demanding that the cited file name the table would be demanding
     * something untrue, so the table check is skipped — and the entry
     * must SAY it is derived, in writing, which is the whole point.
     */
    if (q.derived) {
      if (typeof q.derived !== "string" || q.derived.length < 20) {
        fail(
          `${q.id} is marked \`derived\` without a real explanation. "derived" is an ` +
            `exemption from the table check; an exemption nobody justified is how a ` +
            `catalogue stops describing the product.`,
        );
      }
      continue;
    }

    const src = readFileSync(abs, "utf8");
    for (const table of tablesIn(q.sql)) {
      checkedTables++;
      /*
       * ⚠️ Drizzle names tables in camelCase in TypeScript and snake_case
       * in SQL, so both spellings count. A miss on both is real drift.
       */
      const camel = table.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (!src.includes(table) && !src.includes(camel)) {
        fail(
          `${q.id} reads "${table}" but ${rel} names neither "${table}" nor "${camel}". ` +
            `The transcription and the source have drifted apart.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\n🔴 Query catalogue drift — ${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log(
  `\n✅ Catalogue provenance intact — ${QUERIES.length} queries, ${checkedFiles} cited file(s) ` +
    `present, ${checkedTables} table reference(s) still named in them.\n` +
    `   ⚠️ VERIFIED: the cited files exist and mention the tables.\n` +
    `   ⚠️ NOT VERIFIED: that the predicates, ordering and limits still match. Drizzle's\n` +
    `      fluent builder cannot be compared to SQL text without executing it, and this\n` +
    `      check does not execute anything. Treat it as a tripwire, not a proof.\n`,
);
