#!/usr/bin/env node
/**
 * Ordence — GATE 29: THE MIGRATION CONTRACT IS COMPLETE AND COHERENT
 * Version: v1.84.0-alpha · Track M1, wired by Track H
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS GATE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `ContractedImportEntity` gets TypeScript to insist that every entity on
 * the write path HAS a contract. TypeScript cannot insist that the
 * contract MEANS anything, and six tracks are about to write twenty of
 * them under time pressure.
 *
 * The combination this gate exists for, above all others:
 *
 *     duplicateModes: ["skip", "update"]
 *     reversal: { kind: "delete" }
 *
 * That is type-correct, reads as complete, and describes an undo which
 * DELETES RECORDS THE CUSTOMER HAD BEFORE THE MIGRATION STARTED. It is
 * also the combination a hurried author writes, because `delete` is the
 * obvious answer and `update` is the mode customers ask for. Nothing
 * except a rule stops it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS GATE DOES NOT CLAIM
 * ══════════════════════════════════════════════════════════════════════
 * It does not check that a reversal WORKS — Track M2 builds the machinery
 * and owns that proof. It does not check that a dependency order is the
 * RIGHT one, only that one exists and resolves. It reads declarations and
 * refuses declarations that contradict each other or say nothing.
 *
 * ⭐ AND IT PRINTS ITS CENSUS ON SUCCESS. A gate that prints only "OK" is
 * a gate that reads as green when it has examined nothing — the failure
 * mode this project found in `drill-rebuild` (RESTORE COMPLETE while
 * expecting 2 policies against 313 present) and in `measure-query`
 * (measuring as a superuser under a header saying NOBYPASSRLS). So the
 * counts are on stdout every run, and a floor below refuses a suspiciously
 * empty read rather than passing it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTITIES = "lib/import/entities.ts";
const CHECK = "lib/import/contract/check.ts";

for (const f of [ENTITIES, CHECK]) {
  if (!existsSync(f)) {
    console.error(`🔴 check:import-contract , ${f} is missing.`);
    console.error(
      "   This gate reads the real registry through the real checker. With the\n" +
        "   file gone there is nothing to read, and passing here would be the\n" +
        "   gate reporting a green it did not earn.",
    );
    process.exit(1);
  }
}

/**
 * ⚠️ THE CHECK RUNS THROUGH `tsx` AGAINST THE REAL MODULES, NOT AGAINST A
 * PARSE OF THE SOURCE TEXT.
 *
 * A regex over `entities.ts` would be a second, drifting model of what an
 * entity is , and this repository has been bitten by exactly that four
 * times (the `>=?` floor matching the `>` inside `<>`; the brace counter
 * that walked into a template literal; the index probe defeated by a
 * dynamic DROP; the `boolean::text` compared against 't'). Importing the
 * module means the thing checked is the thing shipped.
 */
const dir = mkdtempSync(join(tmpdir(), "ordence-contract-"));
const runner = join(dir, "run.mts");

writeFileSync(
  runner,
  `import { ALL_IMPORT_ENTITIES } from "${process.cwd()}/lib/import/entities.ts";
import { checkImportContract } from "${process.cwd()}/lib/import/contract/check.ts";
import { resolveImportOrder } from "${process.cwd()}/lib/import/contract/graph.ts";
import { OPENING_CONTRACTS } from "${process.cwd()}/lib/import/contract/opening-policies.ts";

const result = checkImportContract(ALL_IMPORT_ENTITIES);
const order = resolveImportOrder(ALL_IMPORT_ENTITIES);

/* A contract decorating an entity that does not exist is a contract
 * somebody believes is in force. Reported here rather than in check.ts
 * because check.ts is handed the merged map and cannot see the seam. */
const orphanDecorations = Object.keys(OPENING_CONTRACTS).filter(
  (k) => !Object.hasOwn(ALL_IMPORT_ENTITIES, k),
);

console.log(JSON.stringify({
  ok: result.ok && orphanDecorations.length === 0,
  examined: result.examined,
  problems: result.problems,
  orphanDecorations,
  waves: order.ok ? order.waves : null,
  order: order.ok ? order.steps : null,
  orderProblem: order.ok ? null : order.problem,
}));
`,
  "utf8",
);

const proc = spawnSync("npx", ["tsx", runner], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
rmSync(dir, { recursive: true, force: true });

if (proc.status !== 0) {
  console.error("🔴 check:import-contract , could not evaluate the registry.");
  console.error(proc.stderr || proc.stdout || "(no output)");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(proc.stdout.trim().split("\n").pop() ?? "");
} catch {
  console.error("🔴 check:import-contract , the checker produced no readable result.");
  console.error(proc.stdout);
  process.exit(1);
}

/**
 * 🔴 THE FLOOR. Not decoration.
 *
 * An empty or near-empty registry passes every rule above trivially, and
 * a gate that says OK because it found nothing is the exact defect shape
 * this project keeps finding. Six entities ship today. A read that
 * returns fewer than that means the import failed, the registry was
 * gutted, or the module now throws at evaluation , none of which are a
 * pass.
 */
const FLOOR = 6;
if (typeof data.examined !== "number" || data.examined < FLOOR) {
  console.error(
    `🔴 check:import-contract , examined ${data.examined} entities, expected at least ${FLOOR}.`,
  );
  console.error(
    "   This is the gate refusing to pass on an empty read. Either the registry\n" +
      "   lost entries or the module no longer evaluates. Raise the floor when\n" +
      "   entities are added; never lower it to make this message go away.",
  );
  process.exit(1);
}

if (data.orphanDecorations.length > 0) {
  console.error("🔴 check:import-contract , contracts written for entities that do not exist:");
  for (const k of data.orphanDecorations) {
    console.error(`   · ${k}`);
  }
  console.error(
    "\n   A contract keyed to nothing is a policy somebody believes is in force.\n" +
      "   Either the entity key was renamed on one side only, or the decoration\n" +
      "   outlived the entity.",
  );
  process.exit(1);
}

if (!data.ok) {
  console.error(`🔴 check:import-contract , ${data.problems.length} problem(s):\n`);
  for (const p of data.problems) {
    console.error(`   ${p.entity}  ·  ${p.member}`);
    console.error(`      ${p.problem}\n`);
  }
  if (data.orderProblem) console.error(`   ORDER: ${data.orderProblem}\n`);
  process.exit(1);
}

console.log(`✅ check:import-contract`);
console.log(`   ${data.examined} entities examined, every contract complete and coherent.`);
console.log(`   Load order resolves in ${data.waves} wave(s):`);
const byWave = new Map();
for (const step of data.order ?? []) {
  if (!byWave.has(step.wave)) byWave.set(step.wave, []);
  byWave.get(step.wave).push(step.entity);
}
for (const [wave, entities] of [...byWave.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`     wave ${wave}: ${entities.join(", ")}`);
}
