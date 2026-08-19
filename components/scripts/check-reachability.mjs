#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE ORPHAN CENSUS
 * Version: v1.19.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE GAP THIS CLOSES, WRITTEN DOWN AT THE END OF v1.18.0
 * ══════════════════════════════════════════════════════════════════════
 * `tests/ui/connection-setup.test.ts` was added in v1.17.0 to fail the
 * build when a server action exists that no screen calls. It caught the
 * thing it was built for and then failed to catch the next one, because
 * it asks the wrong half of the question.
 *
 * ⚠️ `stock_counts` HID FOR A YEAR. It was designed correctly in 0029,
 * carried the hard reasoning in its own comments, and no action ever
 * referenced it. The action-to-screen gate could not see it, because
 * there was no action either. A table nothing reaches has no action to
 * check.
 *
 * ⭐ SO THIS ONE WALKS THE OTHER DIRECTION: every table in `db/schema`,
 * and whether ANY code outside the schema layer names it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT IS A CENSUS, NOT A PASS/FAIL, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * A hard failure would be wrong here for two reasons.
 *
 * ① SOME TABLES ARE LEGITIMATELY WRITTEN ONLY BY SQL. Audit trails,
 *    append-only logs and trigger-populated tables are reached by
 *    triggers rather than by TypeScript, and demanding an import would
 *    push somebody to add a pointless one.
 *
 * ② A TABLE BUILT THIS SPRINT FOR NEXT SPRINT'S FEATURE is not a defect.
 *    Failing the build for it teaches people to add a fake reference,
 *    which is worse than the thing being measured.
 *
 * 🔴 SO IT PRINTS A LIST AND EXITS 0 unless the count goes UP against a
 * recorded baseline. The list can only shrink by somebody deciding to
 * shrink it, which is the same shape as `KNOWN_UNPOSTED` in the posting
 * gate, and for the same reason: a number nobody has to justify is a
 * number that grows.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const SCHEMA_DIR = join(ROOT, "db", "schema");
const BASELINE = join(ROOT, "scripts", "reachability-baseline.json");

/**
 * ⚠️ WHERE A TABLE COUNTS AS REACHED. The schema layer itself does not:
 * a table referenced only by its own relations block is exactly the
 * thing being looked for.
 */
const SEARCH_DIRS = ["server", "lib", "app", "components", "db/queries"];

/** Directories that are never source. */
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

/**
 * 🔴🔴 FILES THAT NAME EVERY TABLE AND REACH NONE OF THEM.
 *
 * `lib/dpdp/classification.ts` is the DPDPA personal-data inventory: one
 * entry per table in the schema, each carrying the table's name as a
 * string literal. It is a catalogue, not a caller — reading it tells you
 * nothing about whether any code path touches `powers_of_attorney`.
 *
 * ⚠️ WHEN IT LANDED THIS GATE IMMEDIATELY REPORTED TWENTY ORPHANS
 * "REACHED SINCE THE BASELINE", INCLUDING `powers_of_attorney`,
 * `welfare_logs`, `site_photos` AND `vault_consents` — every one of which
 * is exactly as unreachable as it was the day before. Accepting that
 * improvement would have emptied the orphan baseline and permanently
 * disabled the check, and the output would have looked like progress.
 *
 * ⭐ THE GENERAL RULE, WORTH MORE THAN THE FIX: a file that enumerates
 * the schema is invisible to a census OF the schema, and anything else
 * added later with the same shape — a documentation generator, a
 * fixture factory, a migration linter — belongs on this list too.
 */
const CATALOGUE_DIRS = [join(ROOT, "lib", "dpdp")];

/**
 * ⚠️ THE WHOLE `lib/dpdp/` DIRECTORY, NOT ONLY THE INVENTORY FILE.
 *
 * Excluding `classification.ts` alone left three tables still falsely
 * reached — `powers_of_attorney`, `vault_consents` and
 * `deployment_releases` — because `detector.ts` and `retention.ts`
 * discuss them in PROSE while explaining why a rule exists. A comment is
 * not a caller, and this gate greps text on purpose (its own header
 * explains why demanding an import would be worse).
 *
 * ⭐ Every file under `lib/dpdp/` is pure and opens no connection; the
 * code that actually queries these tables lives in `server/dpdp/` and is
 * NOT excluded, so a genuine reach still counts.
 */
const isCatalogue = (file) => CATALOGUE_DIRS.some((d) => file.startsWith(d));

/* ------------------------------------------------------------------ */
/* ① EVERY TABLE THE SCHEMA DECLARES                                   */
/* ------------------------------------------------------------------ */

function schemaFiles() {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => extname(f) === ".ts" && f !== "index.ts")
    .map((f) => join(SCHEMA_DIR, f));
}

/**
 * Matches `export const someName = pgTable("some_table"` across the
 * newline the formatter usually puts in.
 */
const TABLE_RE = /export const (\w+)\s*=\s*pgTable\(\s*\n?\s*"([a-z0-9_]+)"/g;

function declaredTables() {
  const tables = [];
  for (const file of schemaFiles()) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(TABLE_RE)) {
      tables.push({
        constName: m[1],
        tableName: m[2],
        file: file.slice(ROOT.length + 1),
      });
    }
  }
  return tables;
}

/* ------------------------------------------------------------------ */
/* ② EVERY FILE THAT COULD REACH ONE                                   */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if ([".ts", ".tsx", ".mjs"].includes(extname(entry))) out.push(full);
  }
  return out;
}

function sourceCorpus() {
  const files = [];
  for (const d of SEARCH_DIRS) walk(join(ROOT, d), files);
  // ⚠️ The schema layer is excluded on purpose. See SEARCH_DIRS.
  return files
    .filter((f) => !f.startsWith(SCHEMA_DIR))
    .filter((f) => !isCatalogue(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* ③ THE CENSUS                                                        */
/* ------------------------------------------------------------------ */

const tables = declaredTables();
const corpus = sourceCorpus();

const orphans = [];
for (const t of tables) {
  /**
   * ⭐ EITHER NAME COUNTS AS REACHED. Drizzle callers use the constant;
   * raw `sql` blocks and views use the snake_case table name. Requiring
   * the constant would report every table only touched by a hand-written
   * query, and there are legitimately several.
   */
  const byConst = new RegExp(`\\b${t.constName}\\b`).test(corpus);
  const byName = new RegExp(`\\b${t.tableName}\\b`).test(corpus);
  if (!byConst && !byName) orphans.push(t);
}

/* ------------------------------------------------------------------ */
/* ④ THE REPORT                                                        */
/* ------------------------------------------------------------------ */

const bar = "=".repeat(70);
console.log("");

if (orphans.length === 0) {
  console.log(
    `✅ Reachability census — all ${tables.length} tables are referenced by code.`,
  );
} else {
  console.log(bar);
  console.log(
    `  ⚠️  ${orphans.length} of ${tables.length} tables are declared and never referenced`,
  );
  console.log(bar);
  console.log("");
  console.log("  These exist in the schema and in the database, and no server");
  console.log("  action, library or screen names them. Some are legitimately");
  console.log("  written by triggers alone. The rest are features that were");
  console.log("  built and then never connected to anything.");
  console.log("");

  const byFile = new Map();
  for (const o of orphans) {
    if (!byFile.has(o.file)) byFile.set(o.file, []);
    byFile.get(o.file).push(o);
  }

  for (const [file, rows] of [...byFile].sort()) {
    console.log(`  ${file}`);
    for (const r of rows) console.log(`      ${r.tableName}`);
    console.log("");
  }
}

/* ------------------------------------------------------------------ */
/* ⑤ THE RATCHET                                                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE LIST MAY SHRINK FREELY AND MAY NOT GROW.
 *
 * ⚠️ Without this the census is a report nobody reads, and the number
 * climbs one table at a time with every session. With it, adding an
 * unreachable table is a deliberate act that updates a checked-in file,
 * which is a conversation in a code review rather than a silent drift.
 */
const current = orphans.map((o) => o.tableName).sort();

if (process.argv.includes("--accept")) {
  writeFileSync(BASELINE, `${JSON.stringify({ orphans: current }, null, 2)}\n`);
  console.log(`  ⭐ Baseline written: ${current.length} known orphan tables.\n`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.log("  ⚠️  No baseline recorded yet. Run with --accept to write one.\n");
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8")).orphans ?? [];
const known = new Set(baseline);
const added = current.filter((t) => !known.has(t));
const fixed = baseline.filter((t) => !current.includes(t));

if (fixed.length > 0) {
  console.log(`  ⭐ ${fixed.length} table(s) reached since the baseline: ${fixed.join(", ")}`);
  console.log("     Run with --accept to record the improvement.\n");
}

if (added.length > 0) {
  console.error(
    `  ❌ ${added.length} NEW unreachable table(s): ${added.join(", ")}\n` +
      "     A table nothing reaches is a feature nobody can use. Either wire it\n" +
      "     up, or run this with --accept and say in the commit why it waits.\n",
  );
  process.exit(1);
}

console.log(`  ✅ No new orphans. ${current.length} known, ${tables.length} tables total.\n`);
process.exit(0);
