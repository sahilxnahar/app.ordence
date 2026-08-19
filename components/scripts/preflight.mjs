#!/usr/bin/env node
/**
 * Ordence — Preflight
 * Version: v0.84.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE GATE, RUN IN TWO PLACES
 * ══════════════════════════════════════════════════════════════════════
 * CI invokes this, and so do you, before pushing. That is the entire
 * design goal: if the local command and the CI command are different
 * lists, they drift, and the first thing anyone learns is that green
 * locally means nothing.
 *
 *     npm run preflight          — everything that needs no database
 *     npm run preflight:full     — the above plus the DB-backed checks
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY EVERY CHECK RUNS EVEN AFTER ONE FAILS
 * ══════════════════════════════════════════════════════════════════════
 * Stopping at the first failure means a developer fixes one thing, reruns,
 * waits, finds the next, and repeats. Running all of them and reporting a
 * table at the end costs the same wall-clock time and produces one list.
 *
 * The exception is `build`, which is skipped when `typecheck` has already
 * failed — a build after a type error produces a second, longer report of
 * the same fault.
 */

import { spawnSync } from "node:child_process";
import { gatesInTier } from "./gates.mjs";

const FULL = process.argv.includes("--full");

/**
 * ⚠️ ORDER IS BY COST, NOT BY IMPORTANCE. The two static checks take
 * milliseconds and catch the two worst incidents in this project's
 * history — a stripped boundary and an unnumbered migration. They run
 * first so that the common case fails in under a second rather than after
 * a four-minute build.
 */
/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ INFRA WAVE 12 — THIS LIST IS NO LONGER WRITTEN HERE
 * ══════════════════════════════════════════════════════════════════════
 * It used to be eight gates, hand-typed. There were twenty-three, and
 * `.github/workflows/security-ci.yml` had a third list of five. The file
 * header above says the design goal is "if the local command and the CI
 * command are different lists, they drift" — and they had.
 *
 * `scripts/gates.mjs` is now the only list. Preflight reads it, CI reads
 * it, and `check:gate-coverage` fails the build if they ever disagree
 * again.
 *
 * ⚠️ THE SLOW CHECKS STAY HERE AND ARE NOT IN THE MANIFEST. `tsc`, the
 * build and the two suites are not gates — they are the compiler and the
 * tests, they take minutes rather than milliseconds, and CI runs each in
 * its own job for that reason. Putting them in the manifest would make
 * `gates:static` a five-minute command that nobody runs before a commit,
 * which is exactly how a fast check stops being fast enough to use.
 */
const CHECKS = [
  ...gatesInTier("static").map((gate) => ({
    name: `check:${gate.id}`,
    cmd: ["node", [gate.script]],
    why: gate.why,
  })),

  {
    name: "typecheck",
    cmd: ["npx", ["tsc", "--noEmit"]],
    why: "type errors",
  },
  {
    name: "ui tests",
    cmd: ["npx", ["vitest", "run", "--project=ui"]],
    why: "component behaviour and the source-level wiring assertions",
  },
  {
    name: "build",
    cmd: ["npm", ["run", "build"]],
    why: "webpack boundary errors that tsc cannot see",
    skipIfFailed: "typecheck",
  },

  ...(FULL
    ? [
        ...gatesInTier("database").map((gate) => ({
          name: `check:${gate.id}`,
          cmd: ["node", [gate.script]],
          why: gate.why,
          needsDb: true,
        })),
        {
          name: "security tests",
          cmd: ["npx", ["vitest", "run", "--project=security"]],
          why: "tenant isolation, financial integrity, the billing gate",
          needsDb: true,
        },
      ]
    : []),
];

/* ------------------------------------------------------------------ */

const results = [];
const failed = new Set();

for (const check of CHECKS) {
  if (check.skipIfFailed && failed.has(check.skipIfFailed)) {
    results.push({ name: check.name, status: "skipped", note: `${check.skipIfFailed} failed first` });
    continue;
  }

  process.stdout.write(`\n──── ${check.name} ────\n`);
  const [bin, args] = check.cmd;
  const r = spawnSync(bin, args, { stdio: "inherit", shell: process.platform === "win32" });

  if (r.status === 0) {
    results.push({ name: check.name, status: "pass" });
  } else {
    failed.add(check.name);
    results.push({ name: check.name, status: "FAIL", note: check.why });
  }
}

/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + "═".repeat(66));
console.log("  PREFLIGHT" + (FULL ? " (full — database checks included)" : ""));
console.log("═".repeat(66));
for (const r of results) {
  const mark = r.status === "pass" ? "✅" : r.status === "skipped" ? "⏭ " : "❌";
  console.log(`  ${mark} ${pad(r.name, 22)} ${r.status}${r.note ? ` — ${r.note}` : ""}`);
}
console.log("═".repeat(66));

if (!FULL) {
  console.log(
    "  ⚠️  Database checks NOT run. `npm run preflight:full` with a\n" +
      "      TEST_DATABASE_URL covers RLS coverage and tenant isolation.",
  );
  console.log("═".repeat(66));
}

if (failed.size > 0) {
  console.error(`\n❌ PREFLIGHT FAILED — ${failed.size} check(s). Do not push.\n`);
  process.exit(1);
}

console.log("\n✅ PREFLIGHT PASSED — safe to push.\n");
