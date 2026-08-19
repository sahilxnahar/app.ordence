#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ GATE 20 · THE INPUT FORMAT LIST, IN FIVE PLACES
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE SIBLING OF GATE 19, AND THE FAILURE IS WORSE ON THIS SIDE
 * ══════════════════════════════════════════════════════════════════════
 * An input format lives in five places:
 *
 *   ① `lib/import/sources/index.ts` → `IMPORT_SOURCE_FORMATS`, the union
 *   ② the same file's `readSource` switch → the reader that runs
 *   ③ `detectFormat` → the bytes that identify it
 *   ④ `SQL-FILES/0117_*.sql` → a value `import_runs.source_format` accepts
 *   ⑤ `tests/ui/import-sources.test.ts` → a file somebody actually read
 *
 * ⚠️ ON THE EXPORT SIDE (gate 19) a missing SQL value fails BEFORE the
 * bytes reach the customer, because the log is written first. HERE THE
 * ROWS ARE ALREADY IN THE DATABASE by the time the run record is written:
 * a format the reader accepts and ④ refuses produces a migration that
 * reads the file, plans it, writes forty thousand rows, and then fails at
 * the run record — leaving the customer's data imported with no record of
 * where it came from and a screen that says the import failed.
 *
 * ⭐ ③ IS THE ONE THAT IS EASIEST TO FORGET and the one with no other
 * safety net. A format in the union with no detection rule can never be
 * chosen — `detectFormat` falls through to CSV — so the reader is dead
 * code that looks alive, which is this codebase's most frequent defect
 * wearing a new hat.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SOURCES = {
  registry: "lib/import/sources/index.ts",
  sql: "SQL-FILES/0117_import_runs_and_mapping.sql",
  schema: "db/schema/import-runs.ts",
  tests: "tests/ui/import-sources.test.ts",
};

/**
 * ⚠️ COMMENTS STRIPPED FIRST. `check:action-reach` shipped counting a doc
 * comment as a caller and under-reported by twenty-six; the same mistake
 * here would let a format mentioned only in prose satisfy a list it is
 * not in.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
function sqlCodeOnly(source) {
  return source.replace(/^\s*--[^\n]*$/gm, " ");
}

const failures = [];

/* ① THE UNION */

const registry = codeOnly(read(SOURCES.registry));
const block = registry.match(/export const IMPORT_SOURCE_FORMATS = \[([\s\S]*?)\] as const;/);
if (!block) {
  console.error(
    `⛔ Could not find IMPORT_SOURCE_FORMATS in ${SOURCES.registry}. This gate compares four ` +
      `other lists against it, so it cannot run.`,
  );
  process.exit(1);
}
const FORMATS = [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
if (FORMATS.length === 0) {
  console.error(`⛔ IMPORT_SOURCE_FORMATS in ${SOURCES.registry} is empty.`);
  process.exit(1);
}

/* ② THE READER */

for (const format of FORMATS) {
  if (!new RegExp(`case\\s+"${format}"\\s*:`).test(registry)) {
    failures.push(
      `"${format}" is in IMPORT_SOURCE_FORMATS and \`readSource\` has no \`case "${format}":\`. ` +
        `A file detected as that format would fall out of the switch with nothing returned.`,
    );
  }
}

if (/switch\s*\(detection\.format\)[\s\S]*?default\s*:/.test(registry)) {
  failures.push(
    `${SOURCES.registry} has a \`default:\` in the \`readSource\` switch. That silences ` +
      `TypeScript's exhaustiveness check, so a format added to the union and not to the switch ` +
      `would compile and then fall through at runtime.`,
  );
}

/* ③ DETECTION — the one with no other safety net */

const detect = registry.slice(
  registry.indexOf("export function detectFormat"),
  registry.indexOf("export type SourceTable"),
);
if (detect.length < 50) {
  failures.push(`Could not find \`detectFormat\` in ${SOURCES.registry}.`);
} else {
  for (const format of FORMATS) {
    if (!detect.includes(`"${format}"`)) {
      failures.push(
        `"${format}" is in IMPORT_SOURCE_FORMATS and \`detectFormat\` never returns it. Nothing ` +
          `can ever be read as that format — detection falls through to CSV — so its reader is ` +
          `dead code that looks alive.`,
      );
    }
  }
}

/* ④ THE SQL CHECK CONSTRAINT */

const sql = sqlCodeOnly(read(SOURCES.sql));
const sqlCheck = sql.match(
  /CONSTRAINT\s+import_runs_source_format_known\s*\n?\s*CHECK\s*\(source_format IN \(([^)]*)\)\)/,
);
if (!sqlCheck) {
  failures.push(
    `Could not find the \`import_runs_source_format_known\` CHECK in ${SOURCES.sql}. Without it ` +
      `the run record accepts any string, and a typo becomes a format nobody notices.`,
  );
} else {
  const sqlFormats = [...sqlCheck[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  for (const format of FORMATS) {
    if (!sqlFormats.includes(format)) {
      failures.push(
        `"${format}" can be read by ${SOURCES.registry} and is NOT in the ` +
          `\`import_runs_source_format_known\` CHECK in ${SOURCES.sql}. A migration in that ` +
          `format would read the file, write every row, and THEN fail at the run record — the ` +
          `customer's data imported, with no record of where it came from.`,
      );
    }
  }
  for (const format of sqlFormats) {
    if (!FORMATS.includes(format)) {
      failures.push(
        `"${format}" is allowed by the CHECK in ${SOURCES.sql} and no reader produces it.`,
      );
    }
  }
}

/* ⑤ THE DRIZZLE CHECK */

const schema = codeOnly(read(SOURCES.schema));
const schemaCheck = schema.match(
  /"import_runs_source_format_known",\s*sql`\$\{t\.sourceFormat\} IN \(([^)]*)\)`/,
);
if (!schemaCheck) {
  failures.push(
    `Could not find the \`import_runs_source_format_known\` check in ${SOURCES.schema}. ` +
      `\`drizzle-kit\` generates from the schema, so a constraint present only in SQL is one a ` +
      `generated migration would drop.`,
  );
} else {
  const schemaFormats = [...schemaCheck[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  const differs =
    schemaFormats.length !== FORMATS.length || FORMATS.some((f) => !schemaFormats.includes(f));
  if (differs) {
    failures.push(
      `The format list in ${SOURCES.schema} is [${schemaFormats.join(", ")}] and the reader ` +
        `supports [${FORMATS.join(", ")}]. These must be identical.`,
    );
  }
}

/* ⑥ THE TEST MATRIX */

let tests = "";
try {
  tests = codeOnly(read(SOURCES.tests));
} catch {
  failures.push(
    `${SOURCES.tests} does not exist. Five lists agreeing is not five lists being right — ` +
      `something has to read a real file of each kind.`,
  );
}
if (tests) {
  for (const format of FORMATS) {
    if (!tests.includes(`"${format}"`)) {
      failures.push(
        `"${format}" is never named in ${SOURCES.tests}. Nothing has read a file in that format.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error("\n⛔ import source check failed\n");
  for (const failure of failures) console.error(`  • ${failure}\n`);
  console.error(
    "  An input format is declared in five places. They agree or the build does not pass.\n",
  );
  process.exit(1);
}

console.log(
  `✅ import sources: ${FORMATS.length} formats (${FORMATS.join(", ")}) agree across the reader, ` +
    `the detector, the SQL constraint, the Drizzle schema and the test matrix.`,
);
