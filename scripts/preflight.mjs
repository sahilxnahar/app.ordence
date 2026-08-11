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

const FULL = process.argv.includes("--full");

/**
 * ⚠️ ORDER IS BY COST, NOT BY IMPORTANCE. The two static checks take
 * milliseconds and catch the two worst incidents in this project's
 * history — a stripped boundary and an unnumbered migration. They run
 * first so that the common case fails in under a second rather than after
 * a four-minute build.
 */
const CHECKS = [
  {
    name: "server boundaries",
    cmd: ["node", ["scripts/check-server-boundaries.mjs"]],
    why: "a client component importing a server module, or a stripped server-only guard",
  },
  {
    name: "migration numbering",
    cmd: ["node", ["scripts/check-migrations.mjs"]],
    why: "duplicate or out-of-sequence SQL files",
  },
  {
    name: "SQL completeness",
    cmd: ["node", ["scripts/check-sql-completeness.mjs"]],
    why: "a tenant table with no RLS anywhere in SQL, or a table drizzle-kit push would drop",
  },
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
        {
          name: "RLS coverage",
          cmd: ["node", ["scripts/check-rls-coverage.mjs"]],
          why: "a tenant table with no row-level security",
          needsDb: true,
        },
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
