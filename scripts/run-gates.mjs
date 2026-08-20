#!/usr/bin/env node
/**
 * Ordence — ⭐⭐ RUN A TIER OF GATES
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE COMMAND, DRIVEN BY THE MANIFEST
 * ══════════════════════════════════════════════════════════════════════
 *     npm run gates:static      every gate that reads the tree
 *     npm run gates:database    every gate that needs PostgreSQL
 *     npm run gates:all         both
 *
 * CI runs the first two. `preflight` runs them too, through the same
 * manifest, so the local command and the CI command cannot be different
 * lists , which is the entire point.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY GATE RUNS EVEN AFTER ONE FAILS
 * ══════════════════════════════════════════════════════════════════════
 * Stopping at the first failure means fixing one thing, rerunning,
 * waiting, finding the next. Running all of them costs the same
 * wall-clock time and produces one list. `preflight.mjs` made this
 * argument first and it is right.
 *
 * ⚠️ A SKIP IS COUNTED SEPARATELY AND IS NOT A PASS. Two gates degrade
 * to a skip without a database. A run with skips is reported as such,
 * because "green with four things unchecked" and "green" are different
 * states and only one of them is safe to deploy from.
 */

import { spawnSync } from "node:child_process";
import { GATES } from "./gates.mjs";

/** EX_CONFIG from sysexits.h: the tool is fine, its configuration is absent. */
const SKIP_CODE = 78;

/**
 * 🔴 IN CI A SKIP IS A FAILURE. Locally, "I have no throwaway Postgres
 * right now" is a reasonable state and the summary says so. In CI the
 * database is a service container, so a skip means the wiring broke ,
 * a renamed variable, a service that did not come up , and that is
 * exactly the silence this whole manifest exists to end.
 */
const SKIPS_ARE_FATAL = process.env.CI === "true" || process.env.CI === "1";

const tier = process.argv[2];
const TIERS = tier === "all" ? ["static", "database"] : [tier];

if (!tier || !["static", "database", "all"].includes(tier)) {
  console.error("usage: node scripts/run-gates.mjs <static|database|all>");
  process.exit(2);
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ A FOURTH STATE: PENDING , AN ACCEPTANCE CRITERION NOT YET OWED
 * ══════════════════════════════════════════════════════════════════════
 * `check:writer-registry` was written by integration BEFORE Phase 1
 * delivered, so that the track could build to its acceptance criterion
 * instead of discovering it in review. Until Phase 1 lands, the tree
 * genuinely does not satisfy it.
 *
 * Three ways to handle that, and two of them are wrong:
 *
 *   ① Leave it out of the manifest. Refused , by `check:gate-coverage`,
 *      correctly: "a gate that is not in the manifest is a gate that runs
 *      only when somebody remembers, which is the state fourteen of them
 *      were in."
 *   ② Run it and let the suite go red. Honest, and it makes `gates:static`
 *      red for every other track too. A suite that is always red is a
 *      suite people stop reading, which removes the signal for the case
 *      it exists for , the same argument the watchdog makes about alarms
 *      that fire on healthy systems.
 *   ③ Run it, report PENDING, and name who owes it. Chosen.
 *
 * ⚠️ PENDING IS NOT SKIPPED AND IT IS NOT PASSED. It is printed on every
 * run with the owner attached, it is counted separately in the summary,
 * and the day `pendingOn` is removed from the manifest it becomes an
 * ordinary gate that can fail. What it must never become is a quiet
 * green: a gate whose failure is expected is still a gate whose failure
 * has to be visible.
 */
const selected = GATES.filter((g) => TIERS.includes(g.tier));
const results = [];

for (const gate of selected) {
  process.stdout.write(`\n──── check:${gate.id} ────\n`);
  /**
   * A gate may declare `args`. `check:track-ownership` needs `--tree`,
   * because without it the script validates only the map and would pass
   * while the tree it is meant to police went unread , a gate that runs
   * and checks nothing, which is the failure this manifest exists for.
   */
  const r = spawnSync("node", [gate.script, ...(gate.args ?? [])], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (gate.pendingOn && r.status !== 0) {
    process.stdout.write(
      `\n⏳ PENDING , this acceptance criterion is owed by ${gate.pendingOn}.\n` +
        `   It is expected to be red until then. It is NOT a pass.\n`,
    );
    results.push({ gate, ok: false, skipped: false, pending: gate.pendingOn, code: r.status });
    continue;
  }

  /**
   * ⚠️ THREE STATES, NOT TWO.
   *
   *   0   passed
   *   78  SKIPPED , EX_CONFIG. The gate ran, found its configuration
   *       absent, and said so. Only gates marked `canSkip` in the
   *       manifest may do this; a 78 from any other gate is a failure,
   *       because it means something is exiting 78 by accident.
   *   *   failed, INCLUDING a gate that could not start. A gate that
   *       crashes on a missing file is not "not applicable"; it is a
   *       gate that is not protecting anything, and calling that a skip
   *       would hide it.
   */
  const skipped = r.status === SKIP_CODE && gate.canSkip === true;
  results.push({ gate, ok: r.status === 0, skipped, code: r.status });
}

const failed = results.filter((r) => !r.ok && !r.skipped && !r.pending);
const skips = results.filter((r) => r.skipped);
const pad = (s, n) => String(s).padEnd(n);

console.log("\n" + "═".repeat(72));
console.log(`  GATES — ${TIERS.join(" + ")}`);
console.log("═".repeat(72));
for (const r of results) {
  const mark = r.ok ? "✅" : r.skipped ? "⏭️ " : "🔴";
  const note = r.ok ? "" : r.skipped ? "SKIPPED , not checked: " + r.gate.why : r.gate.why;
  console.log(`  ${mark}  ${pad("check:" + r.gate.id, 26)} ${note}`);
}
console.log("═".repeat(72));

const pendings = results.filter((r) => r.pending);
const passed = results.filter((r) => r.ok).length;
console.log(
  `  ${passed}/${results.length - pendings.length} passed` +
    (failed.length > 0 ? `  ·  ${failed.length} FAILED` : "") +
    (skips.length > 0 ? `  ·  ${skips.length} SKIPPED` : "") +
    (pendings.length > 0 ? `  ·  ${pendings.length} PENDING` : ""),
);

/**
 * ⚠️ NAMED, EVERY RUN, WITH THE OWNER. A pending gate that scrolls past
 * in silence is a pending gate nobody chases, and the whole point of
 * writing the acceptance criterion early is that somebody is building to
 * it right now.
 */
if (pendings.length > 0) {
  console.log("");
  console.log(`  ⏳  ${pendings.length} acceptance criterion/criteria not yet met, by design:`);
  for (const p of pendings) {
    console.log(`       check:${p.gate.id}  ,  owed by ${p.pending}`);
  }
  console.log("     These are NOT passes. When the owing track lands, remove");
  console.log("     `pendingOn` from scripts/gates.mjs and the gate must go green.");
}

if (skips.length > 0) {
  console.log("");
  console.log(
    `  ⚠️  ${skips.length} gate(s) did not run. "Green with ${skips.length} thing(s) unchecked"`,
  );
  console.log("     and \"green\" are different states, and only one is safe to deploy from.");
  for (const s of skips) console.log(`       check:${s.gate.id}`);
}

if (skips.length > 0 && SKIPS_ARE_FATAL) {
  console.log("");
  console.error(
    `  🔴 CI is set, so a skip is a failure. In CI the database is a service` +
      ` container;\n     a gate that cannot find it means the wiring broke.`,
  );
}
console.log("");

process.exit(failed.length > 0 || (skips.length > 0 && SKIPS_ARE_FATAL) ? 1 : 0);
