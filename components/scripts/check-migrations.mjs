#!/usr/bin/env node
/**
 * Ordence — Migration numbering gate
 * Version: v0.84.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Three migrations were added numbered 0062, 0072 and 0076 while the
 * highest real file was 0045. That left permanent holes at 0046–0061,
 * 0063–0071 and 0073–0075 — numbers that do not exist and never will.
 *
 * `SQL-FILES/` is applied IN NUMERIC ORDER, by a glob in CI and by hand
 * in Neon. Numbering is therefore not cosmetic: it is the execution
 * order, and a file numbered three-quarters of the way into a future that
 * has not happened yet cannot be reasoned about. `SQL-RUN-ORDER-*.md`
 * stopped describing reality the moment they landed.
 *
 * ⚠️ Nothing caught it. `tsc` does not read SQL. The CI glob would have
 * applied them happily in sorted order. The only symptom was a human
 * noticing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS CHECKS
 * ══════════════════════════════════════════════════════════════════════
 *   1. No duplicate numbers.
 *   2. No gaps beyond the two documented historical ones.
 *   3. A `_superseded/` file's number is never reused by a live file —
 *      re-running history under the same name is how a database ends up
 *      in a state no file describes.
 *
 * It does NOT require a database.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "SQL-FILES";
let failures = 0;
const fail = (m) => {
  console.error(`::error::${m}`);
  failures++;
};

/**
 * ⚠️ HISTORICAL GAPS, ALLOWED BY NAME AND ONLY BY NAME.
 *
 * 0004 and 0010 were never written — the phases they were reserved for
 * merged into their neighbours. They predate this gate.
 *
 * Listing them explicitly, rather than tolerating "some gaps", is the
 * whole design: a new gap fails, and the only way to make it pass is to
 * add the number here with a reason, which forces somebody to look at it.
 * A check that tolerates a category of fault stops catching that fault.
 */
const KNOWN_GAPS = new Map([
  [4, "never written — phase merged into 0005"],
  [10, "never written — phase merged into 0011"],
  /**
   * ⭐ 0062 IS RETIRED, NOT MISSING. `0062_security_batches.sql` was
   * superseded and moved to `_superseded/`, and this gate correctly
   * refused to let v1.11.0 reuse the number: two different scripts
   * sharing one position in history is exactly what it exists to stop.
   * The batch went out as 0063 instead.
   */
  [62, "retired — 0062_security_batches.sql superseded, number not reused"],
  /**
   * ⭐ 0072 IS RETIRED FOR THE SAME REASON, AND THE GATE CAUGHT IT THE
   * SAME WAY. `0072_quick_flows.sql` was superseded and sits in
   * `_superseded/`. v1.21.0 tried to reuse the number for the period
   * lock; this check refused, and the file went out as 0073 instead.
   *
   * ⚠️ That is twice now that reusing a retired number has been the
   * obvious thing to do and twice that it would have produced a
   * migration log which cannot be replayed from scratch.
   */
  [72, "retired — 0072_quick_flows.sql superseded, number not reused"],
  /**
   * ⭐ 0076 IS RETIRED, AND THIS IS THE THIRD TIME.
   * `0076_mass_deployment_backup.sql` was superseded and sits in
   * `_superseded/`. v1.24.0 tried to reuse the number for the monthly
   * return; this check refused, and the file went out as 0077.
   *
   * ⚠️ THREE TIMES NOW, and the pattern is worth naming: the retired
   * numbers were 0062, 0072 and 0076 — all of them from the same batch
   * of three files that were numbered far ahead of the real sequence
   * years ago. Every time the real sequence catches up with one of
   * them, reusing it is the obvious move and would produce a migration
   * log that cannot be replayed from scratch.
   */
  [76, "retired — 0076_mass_deployment_backup.sql superseded, number not reused"],
  /**
   * ⭐ 0107 WAS RESERVED AND NEVER WRITTEN. A different shape from the
   * three above, and the first of its kind here.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 FIVE BRIEFS WERE NUMBERED IN PARALLEL AND THE MAIN LINE HELD TWO
   * ══════════════════════════════════════════════════════════════════
   * The main line kept 0106 and 0107 while five parallel streams took
   * 0108 through 0112. 0106 shipped as the TDS Rule 26 migration. 0107
   * never became anything: the work it was held for turned out to need
   * tables that 0110 creates, so it had to be numbered ABOVE the
   * streams rather than below them, and it went out as 0112 instead.
   *
   * ⚠️ AND THE CASE FOR *NOT* PUTTING IT HERE WAS ARGUED FIRST, in
   * `OPTIONAL-migration-reservations.md`, which said plainly: do not
   * close this gap with KNOWN_GAPS, because that list means "never
   * written" and these files exist. That was right about 0106, which
   * does exist. It was wrong about 0107 only because the prediction
   * behind it — that the main line would write one — did not come true.
   * "Never written, and never will be" is now simply what happened.
   *
   * 🔴 DO NOT REUSE 0107. The same rule as the three retired numbers
   * above, for a different reason: not because a script once held the
   * position, but because four delivered batches, five reports and
   * every comment in them describe a sequence in which 0107 is absent.
   */
  [107, "reserved by the main line during the five-stream wave and never written — the work it was held for became 0112, which had to run after 0110"],
]);

/* ------------------------------------------------------------------ */

if (!existsSync(DIR)) {
  console.error(`::error::${DIR}/ not found — run from the project root.`);
  process.exit(1);
}

const numbered = readdirSync(DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

if (numbered.length === 0) {
  fail(`No numbered migrations found in ${DIR}/ — the glob or the directory is wrong.`);
  process.exit(1);
}

/* --- 1. duplicates --------------------------------------------------- */

const seen = new Map();
for (const f of numbered) {
  const n = Number(f.slice(0, 4));
  if (seen.has(n)) {
    fail(
      `Duplicate migration number ${String(n).padStart(4, "0")}: ` +
        `"${seen.get(n)}" and "${f}". Applied in sorted order, one silently ` +
        `runs before the other and the pair is unreproducible.`,
    );
  }
  seen.set(n, f);
}

/* --- 2. gaps --------------------------------------------------------- */

const numbers = [...seen.keys()].sort((a, b) => a - b);
const max = numbers[numbers.length - 1];

for (let n = 1; n <= max; n++) {
  if (seen.has(n) || KNOWN_GAPS.has(n)) continue;
  fail(
    `Missing migration ${String(n).padStart(4, "0")} — the sequence jumps over it. ` +
      `A new file must be exactly max+1 (currently ${String(max + 1).padStart(4, "0")}). ` +
      `If this gap is deliberate, add it to KNOWN_GAPS with a reason.`,
  );
}

/* --- 3. superseded numbers must not be reused ------------------------ */

const supersededDir = join(DIR, "_superseded");
if (existsSync(supersededDir)) {
  for (const f of readdirSync(supersededDir).filter((x) => /^\d{4}_/.test(x))) {
    const n = Number(f.slice(0, 4));
    if (seen.has(n)) {
      fail(
        `Migration ${String(n).padStart(4, "0")} exists as both a live file ` +
          `("${seen.get(n)}") and a superseded one ("${f}"). Reusing a retired ` +
          `number means two different scripts share one position in history.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */

if (failures > 0) {
  console.error(`\n❌ Migration numbering FAILED — ${failures} problem(s).\n`);
  process.exit(1);
}

const gapNote = KNOWN_GAPS.size ? ` (${KNOWN_GAPS.size} documented historical gaps)` : "";
console.log(
  `✅ Migrations contiguous — ${numbered.length} files, 0001…${String(max).padStart(4, "0")}${gapNote}. ` +
    `Next number: ${String(max + 1).padStart(4, "0")}.`,
);
