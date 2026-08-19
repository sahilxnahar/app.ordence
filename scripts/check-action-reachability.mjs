#!/usr/bin/env node
/**
 * Ordence — 🔴🔴🔴 SERVER ACTIONS THAT NO SCREEN CAN REACH
 * Version: v1.69.0-alpha (wave one)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS ANSWERS
 * ══════════════════════════════════════════════════════════════════════
 * "Which capabilities exist, work, are tested, and cannot be reached by
 *  a human being?"
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THAT MADE THIS NECESSARY, AND IT IS THE THIRTEENTH
 * ══════════════════════════════════════════════════════════════════════
 * `recordDeduction` in `server/actions/tds.ts` holds the ONLY INSERT into
 * `tds_deductions` anywhere in this product. Nothing called it. No screen,
 * no route, no job. `/tds` imported three reads.
 *
 * So the TDS register could never receive a row. Which meant:
 *
 *   • `getInterestExposure` could only ever report zero;
 *   • `buildQuarterlyReturn` could only ever produce an empty Form 26Q;
 *   • `buildCertificates` could only ever produce an empty Form 16A;
 *   • and the Rule 26 foreign-payment engine sat behind all of it.
 *
 * ⚠️ AND EVERY GATE WAS GREEN. `tsc` passed. `check:reachability` passed,
 * because it asks whether a TABLE is named by any code, and
 * `tds_deductions` is named — by the action nobody calls.
 * `check:tenant-isolation` passed. The tests passed. The screen rendered
 * an empty register, which reads as "nothing owed".
 *
 * 🔴 THIS IS THE SAME DEFECT AS ELEVEN OTHERS: approval policies,
 * `requireMfa`, 34 of 71 entitlement keys, dunning letters that queued
 * and never sent, ESI hardcoded, `valuationMethod` read at zero
 * computations, `bank_accounts.reconciled_to`, `suggestSlugs` unused on
 * the workspace-creation path, `0100`'s depreciation engine unreachable
 * for four batches, `settings.clerkSlug` written and never reconciled,
 * and `/banking` in no navigation since v1.18.0. Built-and-unreachable
 * and declared-and-unread are one defect wearing two hats, and NO GATE IN
 * THIS REPOSITORY ASKED THE QUESTION AT THE LEVEL A CAPABILITY LIVES AT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT IS A CENSUS, NOT A PASS/FAIL, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * Exactly the reasoning in `scripts/check-reachability.mjs`, which this
 * is the action-level twin of. A hard failure would be wrong because:
 *
 *  ① SOME ACTIONS ARE LEGITIMATELY CALLED FROM SERVER CODE — a scheduled
 *    job, `server/mcp/dispatch.ts`, another action. Those are reported
 *    separately and are not orphans.
 *
 *  ② AN ACTION BUILT THIS SPRINT FOR NEXT SPRINT'S SCREEN is not a
 *    defect. Failing the build teaches people to add a fake import,
 *    which is worse than the thing being measured.
 *
 * 🔴 SO IT PRINTS THE LIST AND EXITS 0 UNLESS THE COUNT GOES UP against
 * a recorded baseline. The number can only shrink by somebody deciding to
 * shrink it. Same shape as `KNOWN_UNPOSTED` and the reachability
 * baseline, and for the same reason: a number nobody has to justify is a
 * number that grows.
 *
 * ⚠️ THE MATCH IS DELIBERATELY DUMB — the identifier appearing anywhere
 * in `app/` or `components/`. A clever import-graph walk that silently
 * matched nothing would make this gate pass by finding no callers at all,
 * which is the failure mode every check in this directory warns about. A
 * dumb match errs toward calling something reached, so the number it
 * prints is a FLOOR.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const ACTIONS_DIR = join(ROOT, "server", "actions");
const BASELINE = join(ROOT, "scripts", "action-reachability-baseline.json");

/** Where a human being can reach an action from. */
const UI_DIRS = ["app", "components"];
/** Where server-side callers live — jobs, MCP, other actions. */
const SERVER_DIRS = ["server", "lib"];
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if ([".ts", ".tsx"].includes(extname(e.name))) out.push(rel);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ① EVERY EXPORTED SERVER ACTION                                      */
/* ------------------------------------------------------------------ */

const actions = new Map();
for (const f of readdirSync(ACTIONS_DIR).filter((x) => extname(x) === ".ts")) {
  const src = readFileSync(join(ACTIONS_DIR, f), "utf8");
  for (const m of src.matchAll(/^export async function (\w+)/gm)) {
    actions.set(m[1], `server/actions/${f}`);
  }
}

if (actions.size < 50) {
  console.error(
    `::error::Parsed only ${actions.size} server actions. The matcher has broken — ` +
      `a gate that finds nothing to check passes for the wrong reason.`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* ② WHO NAMES THEM                                                    */
/* ------------------------------------------------------------------ */

const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 COMMENTS ARE STRIPPED, AND THIS GATE FAILED WITHOUT IT ON ITS
 *      SECOND RUN
 * ══════════════════════════════════════════════════════════════════════
 * `components/accounting/create-period-form.tsx` opens with a paragraph
 * explaining that `createFinancialPeriod` had no caller. The paragraph
 * was TRUE and the form had not yet been wired to anything — and this
 * gate reported the action as reachable, because the identifier appeared
 * in the file.
 *
 * ⚠️ THAT IS THE GATE MARKING ITSELF SATISFIED BY ITS OWN DOCUMENTATION.
 * Worse than a false negative: writing ABOUT an unreachable capability
 * would silently retire it from the census, and this codebase documents
 * heavily on purpose. The more carefully somebody explained the defect,
 * the more certainly it would disappear from the list.
 *
 * ⭐ `scripts/check-env-catalogue.mjs` ALREADY SOLVED THIS, and its
 * reasoning transfers exactly: that gate strips comments because this
 * repository documents its environment variables in prose next to the
 * code that reads them, and "the only way anybody would ever have made
 * this gate pass is by deleting the explanations."
 *
 * ⚠️ Brief H hit the same shape in `check-reachability.mjs` from a
 * different direction — `lib/dpdp/` names every table in the schema
 * while reaching none of them — and excluded those directories. Two
 * gates, two mechanisms, one fault: a census that counts mentions
 * counts writing.
 *
 * ⚠️ THE STRIP IS DELIBERATELY CRUDE and errs toward keeping code. A
 * `//` inside a string literal costs us the rest of that line, which can
 * only ever make this gate report MORE orphans, never fewer. Reporting a
 * wired action as an orphan is a visible, arguable mistake; reporting an
 * orphan as wired is the one that hides.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const uiIdents = new Set();
for (const f of UI_DIRS.flatMap((d) => walk(d))) {
  const code = codeOnly(readFileSync(join(ROOT, f), "utf8"));
  for (const m of code.matchAll(IDENT)) uiIdents.add(m[0]);
}

/** file → identifier set, so an action's OWN file never counts as a caller. */
const serverIdents = new Map();
for (const f of SERVER_DIRS.flatMap((d) => walk(d))) {
  const set = new Set();
  const code = codeOnly(readFileSync(join(ROOT, f), "utf8"));
  for (const m of code.matchAll(IDENT)) set.add(m[0]);
  serverIdents.set(f, set);
}

if (uiIdents.size < 500) {
  console.error(
    `::error::Only ${uiIdents.size} identifiers found across app/ and components/. ` +
      `The walk has broken, and every action would be reported as an orphan.`,
  );
  process.exit(1);
}

const orphans = [];
const serverOnly = [];

for (const [name, file] of [...actions].sort()) {
  if (uiIdents.has(name)) continue;
  let elsewhere = null;
  for (const [f, set] of serverIdents) {
    if (f !== file && set.has(name)) {
      elsewhere = f;
      break;
    }
  }
  if (elsewhere) serverOnly.push({ name, file, calledFrom: elsewhere });
  else orphans.push({ name, file });
}

/* ------------------------------------------------------------------ */
/* ③ THE VERDICT                                                       */
/* ------------------------------------------------------------------ */

console.log("══════════════════════════════════════════════════════════");
console.log("  SERVER ACTION REACHABILITY");
console.log("══════════════════════════════════════════════════════════");
console.log(`  exported server actions        ${actions.size}`);
console.log(`  reached from app/ or components/ ${actions.size - orphans.length - serverOnly.length}`);
console.log(`  reached only from server code    ${serverOnly.length}`);
console.log(`  🔴 reached from nowhere          ${orphans.length}`);

if (process.env.ORDENCE_ACTION_REACH_LIST === "1") {
  console.log("\n  Reached from nowhere:");
  for (const o of orphans) console.log(`    ${o.file} · ${o.name}`);
}

if (process.argv.includes("--write-baseline")) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify({ orphans: orphans.length, serverOnly: serverOnly.length, names: orphans.map((o) => `${o.file}#${o.name}`) }, null, 2)}\n`,
  );
  console.log(`\n  baseline written: ${orphans.length} orphan(s).`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(
    `\n::error::No baseline at ${BASELINE}. Run ` +
      `\`node scripts/check-action-reachability.mjs --write-baseline\` and commit it.`,
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

/**
 * 🔴 THE COUNT MAY NOT RISE, AND A NEWLY UNREACHABLE ACTION IS NAMED.
 *
 * ⚠️ REPORTING THE DELTA BY NAME RATHER THAN THE COUNT ALONE. "182, was
 * 181" tells nobody which one, and the whole value of this gate is that
 * it names the capability on the day it is built rather than in an audit
 * two quarters later.
 */
const known = new Set(baseline.names ?? []);
const fresh = orphans
  .map((o) => `${o.file}#${o.name}`)
  .filter((k) => !known.has(k));

if (fresh.length > 0) {
  console.error(
    `\n::error::${fresh.length} server action(s) newly reachable from nothing:`,
  );
  for (const k of fresh) {
    console.error(
      `  • ${k} — no file under app/ or components/ names it, and no other ` +
        `file under server/ or lib/ does either. If a screen is coming, say so ` +
        `in the baseline; if one is not, this capability does not exist.`,
    );
  }
  console.error(
    `\n⚠️ Do NOT make this pass by adding an unused import. The point of ` +
      `the check is that somebody has to look.\n`,
  );
  process.exit(1);
}

const shrunk = [...known].filter(
  (k) => !orphans.some((o) => `${o.file}#${o.name}` === k),
);
if (shrunk.length > 0) {
  console.log(`\n  ⭐ ${shrunk.length} action(s) became reachable since the baseline:`);
  for (const k of shrunk) console.log(`    ${k}`);
  console.log(
    `  Update the baseline so the number can never climb back silently:`,
  );
  console.log(`    node scripts/check-action-reachability.mjs --write-baseline`);
}

console.log(
  `\n✅ No server action became unreachable. ` +
    `${orphans.length} still are (baseline ${baseline.orphans}).\n`,
);
