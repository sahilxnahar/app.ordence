#!/usr/bin/env node
/**
 * Ordence — GATE 31: THE SOURCE PROFILES AGREE WITH THE SCHEMA AND THE SQL
 * Version: v1.86.0-alpha · Phase 9, wired by Track H
 *
 * ⚠️ NUMBERED 31, NOT 30. Phase 9 wrote this as "gate 30" before Phase 1
 * landed; 30 is `check:writer-registry`. Two gates sharing a number is two
 * gates one of which nobody can talk about.
 *
 * Five places, the same discipline as gate 20:
 *   ① lib/import/profiles/registry.ts   → SOURCE_PROFILES, the one map
 *   ② lib/import/profiles/check.ts      → the rules, run against it
 *   ③ SQL-FILES/0275_*.sql              → the CHECK constraint
 *   ④ db/schema/import-runs.ts          → the Drizzle mirror (see §8)
 *   ⑤ tests/ui/import-profiles.test.ts  → a file somebody actually read
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "lib/import/profiles/registry.ts";
const CHECK = "lib/import/profiles/check.ts";
const SQL = "SQL-FILES/0275_import_runs_source_profile.sql";

for (const f of [REGISTRY, CHECK, SQL]) {
  if (!existsSync(f)) {
    console.error(`🔴 check:import-profiles , ${f} is missing.`);
    console.error("   This gate reads the real registry through the real checker.");
    process.exit(1);
  }
}

/** ⚠️ Comments stripped, so a key mentioned only in prose cannot satisfy the list. */
const sql = readFileSync(SQL, "utf8").replace(/^\s*--[^\n]*$/gm, " ");
const constraint =
  /ADD CONSTRAINT\s+import_runs_source_profile_known\s+CHECK\s*\(([\s\S]*?)\)\);/.exec(sql);
if (!constraint) {
  console.error(`🔴 import_runs_source_profile_known not found in ${SQL}.`);
  process.exit(1);
}
const sqlProfileKeys = [...constraint[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);

const dir = mkdtempSync(join(tmpdir(), "ordence-profiles-"));
const runner = join(dir, "run.ts");
writeFileSync(
  runner,
  `import { SOURCE_PROFILES } from "${process.cwd()}/lib/import/profiles/registry";\n` +
    `import { checkSourceProfiles } from "${process.cwd()}/lib/import/profiles/check";\n` +
    `const r = checkSourceProfiles(SOURCE_PROFILES, { sqlProfileKeys: ${JSON.stringify(sqlProfileKeys)} });\n` +
    `console.log(JSON.stringify(r));\n`,
);
const proc = spawnSync("npx", ["tsx", runner], { encoding: "utf8" });
rmSync(dir, { recursive: true, force: true });

if (proc.status !== 0) {
  console.error("🔴 check:import-profiles , the registry could not be loaded.");
  console.error(proc.stderr);
  process.exit(1);
}

const result = JSON.parse(proc.stdout.trim().split("\n").pop());

if (!result.ok) {
  console.error("\n⛔ check:import-profiles failed\n");
  for (const p of result.problems) console.error(`  • ${p.profile} · ${p.where} , ${p.problem}\n`);
  process.exit(1);
}

/** ⭐ A floor that refuses a suspiciously empty read, as gate 29 does. */
if (result.census.profiles < 2 || result.census.exports < 5) {
  console.error(
    `🔴 check:import-profiles read ${result.census.profiles} profile(s) and ` +
      `${result.census.exports} export(s). That is fewer than any real registry, so this is a ` +
      `gate reporting a green it did not earn.`,
  );
  process.exit(1);
}

console.log(
  `✅ check:import-profiles\n` +
    `   ${result.census.profiles} profiles, ${result.census.exports} exports, ` +
    `${result.census.headerSpellings} header spellings.\n` +
    `   ${result.census.reachableExports} exports reach an entity in ALL_IMPORT_ENTITIES.\n` +
    `   ${result.census.validatedAgainstRealExport} validated against a real export.\n` +
    `   ${result.census.exportsMissingRequired.length} exports are short of a required column:\n` +
    result.census.exportsMissingRequired.map((s) => `     ${s}`).join("\n"),
);
