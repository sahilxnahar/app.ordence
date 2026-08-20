#!/usr/bin/env node
/**
 * Ordence , CUT A RELEASE, OR REFUSE TO
 * Version: v1.82.0-alpha - Infra wave H2 (integration, track H)
 *
 * WHY
 * ---
 * Shipping has been six careful manual steps, and it has gone wrong three
 * times in three different ways: an archive extracted one level too deep,
 * a patch where a full tree was needed, and a tree missing its root
 * layout. Every one was a step somebody performed correctly ninety-five
 * times and then did not.
 *
 * This makes it one command with an exit code.
 *
 * WHAT IT DOES, IN ORDER, STOPPING AT THE FIRST REFUSAL
 *   1. every static gate
 *   2. the UI test project
 *   3. asserts the spine exists , the files whose absence kills the build
 *   4. bumps the version
 *   5. writes ONE full-tree zip, never a patch
 *   6. writes RUN-ORDER.md: what SQL to run, in what order, relative to
 *      the code push
 *
 * ⚠️ IT DOES NOT DEPLOY, PUSH, TAG OR COMMIT. It produces a file and a
 * piece of paper. A tool that can deploy is a tool that can deploy by
 * accident at 2am.
 *
 * USAGE
 *   node scripts/release.mjs --version 1.82.0-alpha
 *   node scripts/release.mjs --version 1.82.0-alpha --skip-tests   (dry run)
 *
 * EXIT  0 the zip is ready   1 refused   78 EX_CONFIG
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };

const version = arg("--version");
if (!version || !/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(version)) {
  console.error("usage: release.mjs --version <x.y.z[-tag]> [--skip-tests]");
  process.exit(78);
}

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });

const step = (n, s) => console.log(`\n[${n}] ${s}`);
const refuse = (m) => { console.error(`\nREFUSED , ${m}`); process.exit(1); };

// ── 1. gates ─────────────────────────────────────────────────────────
step(1, "static gates");
if (run("node", ["scripts/run-gates.mjs", "static"], { stdio: "inherit" }).status !== 0) {
  refuse("a static gate failed. Fix it; do not ship around it.");
}

// ── 2. tests ─────────────────────────────────────────────────────────
if (argv.includes("--skip-tests")) {
  console.log("\n[2] tests , SKIPPED by flag. This is a dry run, not a release.");
} else {
  step(2, "ui test project");
  if (run("npx", ["vitest", "run", "--project", "ui"], { stdio: "inherit" }).status !== 0) {
    refuse("tests failed");
  }
}

/**
 * ⚠️ NOT `next build`. It is OOM killed in an 8GB container, every time,
 * and CI builds on every push anyway. Pretending to build here would add
 * a step that always fails and teach everybody to pass --skip.
 */

// ── 3. the spine ─────────────────────────────────────────────────────
step(3, "spine , the files whose absence kills the build");
const SPINE = ["package.json", "middleware.ts", "app/layout.tsx", "app/page.tsx", "db/schema"];
for (const f of SPINE) {
  if (!fs.existsSync(path.join(ROOT, f))) refuse(`missing: ${f}`);
  console.log(`  ok  ${f}`);
}
if (!fs.existsSync(path.join(ROOT, "next.config.ts")) && !fs.existsSync(path.join(ROOT, "next.config.mjs"))) {
  refuse("missing: next.config");
}
console.log("  ok  next.config");

// ── 4. version ───────────────────────────────────────────────────────
step(4, `version , ${version}`);
const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const previous = pkg.version;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`  ${previous} -> ${version}`);

// ── 5. one full tree ─────────────────────────────────────────────────
step(5, "packaging , FULL TREE, never a patch");
const out = path.join(ROOT, "..", `ordence-FULL-v${version}.zip`);
fs.rmSync(out, { force: true });
const zip = run("zip", ["-qr", out, ".",
  "-x", ".next/*", "-x", "node_modules/*", "-x", "tsconfig.tsbuildinfo", "-x", ".git/*"]);
if (zip.status !== 0) refuse(`zip failed: ${zip.stderr}`);
const listed = run("unzip", ["-Z1", out]).stdout.split("\n").filter(Boolean);
if (!listed.includes("app/layout.tsx") || !listed.includes("package.json")) {
  refuse("the zip is missing spine files. Do not send it.");
}
console.log(`  ${listed.length} entries -> ${path.resolve(out)}`);

// ── 6. the run order ─────────────────────────────────────────────────
step(6, "run order");
const sqlDir = path.join(ROOT, "SQL-FILES");
const migrations = fs.readdirSync(sqlDir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const runOrder = `# Run order for v${version}

Repo: \`app.ordence\`.

## Database
Highest numbered migration in this build: **${migrations.at(-1)?.slice(0, 4) ?? "none"}**.

Run \`SQL-FILES/WHATS-PENDING-neon-safe.sql\` in the Neon console FIRST.
It is read only. It tells you exactly which files this database is
missing. Run only those, oldest first, one at a time.

Do not run migrations by guessing from this list. The checker is the
authority; this file only says what is available.

## Order relative to the code push
Every migration in this build is additive, so SQL may be applied before
or after the code push unless a specific file says otherwise in its own
header. When in doubt: SQL first, then the code.

## Never
- \`drizzle-kit push\` against production. It drops row-level security
  policies on 300+ tables and exits 0.
- Any file named \`DRILL-DO-NOT-RUN-IN-NEON-*.sql\`.
- Skipping \`ALL-IN-ONE-SETUP.sql\` when rebuilding from scratch. Run
  \`node scripts/report-allinone-dependency.mjs\` to see exactly what that
  costs. As of this build: 26 objects, 23 of them protections.

## Rebuilding from nothing
1. \`drizzle-kit push\` (test and local only)
2. \`SQL-FILES/ALL-IN-ONE-SETUP.sql\`
3. the numbered files, in order

Applying the numbered files to an empty database refuses 111 of 122. They
ALTER tables they do not create. This is expected, not a fault.
`;
fs.writeFileSync(path.join(ROOT, "..", `RUN-ORDER-v${version}.md`), runOrder);
console.log(`  ${migrations.length} migrations, highest ${migrations.at(-1)?.slice(0, 4)}`);

console.log(`\nREADY , v${version}. Nothing was deployed, pushed, tagged or committed.`);
