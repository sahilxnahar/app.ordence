#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ GATE 19 · THE EXPORT FORMAT LIST, IN FOUR PLACES
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE THIS EXISTS TO PREVENT
 * ══════════════════════════════════════════════════════════════════════
 * A format lives in four places at once:
 *
 *   ① `lib/export/registry.ts`   → what the picker offers
 *   ② `server/export/render.ts`  → the writer that produces the bytes
 *   ③ `SQL-FILES/0116_*.sql`     → a value `data_exports.format` accepts
 *   ④ `db/schema/dpdp.ts`        → the same CHECK, in Drizzle
 *
 * ⚠️ ADD ONE TO ① AND FORGET ③ AND THE EXPORT SUCCEEDS AND THE LOG DOES
 * NOT. The file has been rendered and is about to be returned; the INSERT
 * fails on the CHECK; `server/export/log.ts` turns that into a refusal
 * — correctly — but the person is now told their export failed for a
 * reason that has nothing to do with them, and the only reason it is not
 * WORSE is that the log is written before the bytes are released. Reverse
 * that order in a future edit and the customer has the file and there is
 * no record of it.
 *
 * ⭐ ADD ONE TO ① AND FORGET ② AND `tsc` CATCHES IT, because the switch in
 * `render.ts` is exhaustive over the union. That is the one leg already
 * guarded, and it is checked here anyway: a future `default:` clause would
 * silence the compiler and this gate would keep failing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS GATE DOES NOT PROVE
 * ══════════════════════════════════════════════════════════════════════
 * That any of the writers produce a file that opens. Four lists agreeing
 * is not four lists being right. `tests/ui/export-formats.test.ts` opens
 * the bytes and checks their structure; this gate only proves nobody can
 * add a seventh format to one list and not the others.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const SOURCES = {
  registry: "lib/export/registry.ts",
  render: "server/export/render.ts",
  sql: "SQL-FILES/0116_data_exports.sql",
  schema: "db/schema/dpdp.ts",
  tests: "tests/ui/export-formats.test.ts",
};

/**
 * ⚠️ COMMENTS ARE STRIPPED BEFORE ANYTHING IS MATCHED. `check:action-reach`
 * shipped counting a DOC COMMENT as a caller and reported 181 orphans
 * where there were 207. The same class of mistake here would let a format
 * mentioned only in prose satisfy a list it is not actually in.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function sqlCodeOnly(source) {
  return source.replace(/^\s*--[^\n]*$/gm, " ");
}

const failures = [];

/* ① THE REGISTRY — the definition everything else is compared against */

const registrySource = codeOnly(read(SOURCES.registry));
const registryBlock = registrySource.match(
  /export const EXPORT_FORMATS = \[([\s\S]*?)\] as const;/,
);
if (!registryBlock) {
  console.error(
    `⛔ Could not find EXPORT_FORMATS in ${SOURCES.registry}. This gate compares four ` +
      `lists against it, so it cannot run at all.`,
  );
  process.exit(1);
}
const FORMATS = [...registryBlock[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

if (FORMATS.length === 0) {
  console.error(`⛔ EXPORT_FORMATS in ${SOURCES.registry} is empty.`);
  process.exit(1);
}

/* ⚠️ AND EVERY FORMAT MUST HAVE A DESCRIPTOR. A format in the union with
   no entry in FORMAT_DESCRIPTORS is a runtime `undefined.label`. */
for (const format of FORMATS) {
  const key = /^[a-z][a-z0-9]*$/.test(format) ? format : `"${format}"`;
  const pattern = new RegExp(`(^|[\\s{,])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m");
  if (!pattern.test(registrySource)) {
    failures.push(
      `"${format}" is in EXPORT_FORMATS and has no entry in FORMAT_DESCRIPTORS ` +
        `(${SOURCES.registry}). The picker would render it with no label and no summary.`,
    );
  }
}

/* ② THE WRITER */

const renderSource = codeOnly(read(SOURCES.render));
for (const format of FORMATS) {
  if (!new RegExp(`case\\s+"${format}"\\s*:`).test(renderSource)) {
    failures.push(
      `"${format}" is offered by ${SOURCES.registry} and ${SOURCES.render} has no ` +
        `\`case "${format}":\`. The picker would offer a format nothing can write.`,
    );
  }
}

/**
 * 🔴 A `default:` IN THAT SWITCH WOULD SILENCE THE EXHAUSTIVENESS CHECK
 * `tsc` currently performs, which is the only reason ② is normally caught
 * at compile time. If one is ever added, this gate is what is left.
 */
if (/switch\s*\(format\)[\s\S]*?default\s*:/.test(renderSource)) {
  failures.push(
    `${SOURCES.render} has a \`default:\` in the format switch. That silences TypeScript's ` +
      `exhaustiveness check, so a format added to the registry and not to the switch would ` +
      `compile and then fall through to nothing at runtime. Remove it and let the compiler ` +
      `name the missing case.`,
  );
}

/* ③ THE SQL CHECK CONSTRAINT */

const sqlSource = sqlCodeOnly(read(SOURCES.sql));
const sqlCheck = sqlSource.match(
  /CONSTRAINT\s+data_exports_format_known\s*\n?\s*CHECK\s*\(format IN \(([^)]*)\)\)/,
);
if (!sqlCheck) {
  failures.push(
    `Could not find the \`data_exports_format_known\` CHECK in ${SOURCES.sql}. Without it the ` +
      `log accepts any string, and "xslx" becomes a format nobody notices for a year.`,
  );
} else {
  const sqlFormats = [...sqlCheck[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  for (const format of FORMATS) {
    if (!sqlFormats.includes(format)) {
      failures.push(
        `"${format}" is offered by ${SOURCES.registry} and is NOT in the ` +
          `\`data_exports_format_known\` CHECK in ${SOURCES.sql}. Every export in that format ` +
          `would be rendered and then refused at the log, and the person would be told their ` +
          `export failed for a reason that is not about them.`,
      );
    }
  }
  for (const format of sqlFormats) {
    if (!FORMATS.includes(format)) {
      failures.push(
        `"${format}" is allowed by the CHECK in ${SOURCES.sql} and is not a format ` +
          `${SOURCES.registry} knows. Either it was removed and the constraint was not, or it ` +
          `is a typo that will silently accept a value nothing writes.`,
      );
    }
  }
}

/* ④ THE DRIZZLE CHECK — the same constraint, in the other language */

const schemaSource = codeOnly(read(SOURCES.schema));
const schemaCheck = schemaSource.match(
  /"data_exports_format_known",\s*sql`\$\{t\.format\} IN \(([^)]*)\)`/,
);
if (!schemaCheck) {
  failures.push(
    `Could not find the \`data_exports_format_known\` check in ${SOURCES.schema}. ` +
      `\`drizzle-kit\` generates from the schema, so a constraint present only in SQL is a ` +
      `constraint a generated migration would drop.`,
  );
} else {
  const schemaFormats = [...schemaCheck[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  const differs =
    schemaFormats.length !== FORMATS.length ||
    FORMATS.some((f) => !schemaFormats.includes(f));
  if (differs) {
    failures.push(
      `The format list in ${SOURCES.schema} is [${schemaFormats.join(", ")}] and the registry ` +
        `says [${FORMATS.join(", ")}]. These must be identical.`,
    );
  }
}

/* ⑤ THE TEST MATRIX — somebody has actually opened each one */

let testSource = "";
try {
  testSource = codeOnly(read(SOURCES.tests));
} catch {
  failures.push(
    `${SOURCES.tests} does not exist. Four lists agreeing is not four lists being right — ` +
      `something has to open the bytes.`,
  );
}
if (testSource) {
  for (const format of FORMATS) {
    if (!testSource.includes(`"${format}"`)) {
      failures.push(
        `"${format}" is never named in ${SOURCES.tests}. Nothing has opened a file in that ` +
          `format, so "it is in the registry" is the only evidence it works.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error("\n⛔ export registry check failed\n");
  for (const failure of failures) console.error(`  • ${failure}\n`);
  console.error(
    `  A format is declared in four places and enforced in a fifth. They agree or the build ` +
      `does not pass.\n`,
  );
  process.exit(1);
}

console.log(
  `✅ export registry: ${FORMATS.length} formats (${FORMATS.join(", ")}) agree across the ` +
    `registry, the writer, the SQL constraint, the Drizzle schema and the test matrix.`,
);
