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

const failed = results.filter((r) => !r.ok && !r.skipped);
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

const passed = results.filter((r) => r.ok).length;
console.log(
  `  ${passed}/${results.length} passed` +
    (failed.length > 0 ? `  ·  ${failed.length} FAILED` : "") +
    (skips.length > 0 ? `  ·  ${skips.length} SKIPPED` : ""),
);

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
