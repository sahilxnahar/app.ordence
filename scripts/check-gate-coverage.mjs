#!/usr/bin/env node
/**
 * Ordence — CI GATE 24: EVERY GATE IS IN THE MANIFEST, AND CI RUNS IT
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS REFUSES
 * ══════════════════════════════════════════════════════════════════════
 * Twenty-three gates existed. `preflight` ran eight. CI ran five.
 * Fourteen ran only when somebody typed the command , including the four
 * that found cross-tenant query shapes, 192 unreachable features, ten
 * security alarms that had never fired, and eleven permissions the role
 * screen promised and the product did not keep.
 *
 * Nobody decided that. Three hand-maintained lists drifted, which is
 * what three hand-maintained lists do.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT CHECKS THREE DIRECTIONS, AND THE THIRD IS THE ONE THAT MATTERS
 * ══════════════════════════════════════════════════════════════════════
 *   ① a `check:*` script in package.json that is not in the manifest
 *      → the new gate nobody added to the list
 *   ② a manifest entry whose script file does not exist
 *      → a gate deleted without its entry
 *   ③ 🔴 a manifest entry that the CI workflow does not run
 *      → the gate that exists, is listed, and still never runs
 *
 * ③ is why this gate is worth having. ① and ② are hygiene; ③ is the
 * actual failure that happened.
 *
 * ⚠️ CI IS CHECKED BY READING THE WORKFLOW FILE, not by trusting a
 * comment in it. The workflow runs the static tier through one command,
 * so what is verified is that the command is present AND that the
 * manifest is the thing it reads , which means a gate added to the
 * manifest is in CI the moment it is added, with no second edit.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GATES, npmScript } from "./gates.mjs";

const ROOT = process.cwd();
const failures = [];

/* ---- ① package.json → manifest ------------------------------------ */

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = Object.keys(pkg.scripts ?? {});
const declared = scripts.filter((s) => s.startsWith("check:"));
const inManifest = new Set(GATES.map((g) => npmScript(g)));

for (const script of declared) {
  if (!inManifest.has(script)) {
    failures.push(
      `${script} — a gate in package.json that is not in scripts/gates.mjs, so preflight ` +
        `and CI do not know it exists.`,
    );
  }
}

/* ---- ② manifest → the files --------------------------------------- */

for (const gate of GATES) {
  if (!existsSync(join(ROOT, gate.script))) {
    failures.push(`${gate.id} — the manifest names ${gate.script} and that file is not there.`);
  }
  if (!declared.includes(npmScript(gate))) {
    failures.push(
      `${gate.id} — in the manifest with no ${npmScript(gate)} script in package.json, so ` +
        `nobody can run it by name.`,
    );
  }
  /**
   * ⚠️ EVERY GATE STATES WHAT IT CATCHES. A `why` of a dozen characters
   * is a placeholder, and a placeholder in this field is how a gate ends
   * up nobody remembering why it fails.
   */
  if (!gate.why || gate.why.length < 30) {
    failures.push(`${gate.id} — its \`why\` is too short to tell anybody what it catches.`);
  }
}

/* ---- ③ manifest → CI ---------------------------------------------- */

const WORKFLOW = ".github/workflows/security-ci.yml";
const workflowPath = join(ROOT, WORKFLOW);

if (!existsSync(workflowPath)) {
  failures.push(`${WORKFLOW} is missing, so nothing runs any gate on a push.`);
} else {
  const workflow = readFileSync(workflowPath, "utf8");

  /**
   * 🔴 THE WORKFLOW MUST DRIVE THE STATIC TIER FROM THE MANIFEST, not
   * from a hand-written list of steps. That is the whole fix: a list of
   * steps drifts, a loop over the manifest cannot.
   */
  if (!workflow.includes("npm run gates:static")) {
    failures.push(
      `${WORKFLOW} does not run \`npm run gates:static\`. Without it the workflow is back to a ` +
        `hand-maintained list of steps, which is the drift this gate exists to refuse.`,
    );
  }

  /**
   * ⚠️ AND THE DATABASE TIER TOO. It cannot run in the static job , it
   * needs the service container , so it is checked separately rather
   * than assumed.
   */
  if (!workflow.includes("npm run gates:database")) {
    failures.push(
      `${WORKFLOW} does not run \`npm run gates:database\` in the job that has PostgreSQL. The ` +
        `two database gates would then never run anywhere.`,
    );
  }
}

/* ---- and the runner scripts themselves ---------------------------- */

for (const script of ["gates:static", "gates:database", "gates:all"]) {
  if (!declared.concat(scripts).includes(script)) {
    failures.push(`package.json has no \`${script}\` script, so nothing can run the tier.`);
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error("\ncheck:gate-coverage FAILED\n");
  for (const line of failures) console.error(`  ✗ ${line}`);
  console.error(
    `\n${failures.length} problem(s). A gate that is not in the manifest is a gate that runs ` +
      `only when somebody remembers, which is the state fourteen of them were in.\n`,
  );
  process.exit(1);
}

const staticCount = GATES.filter((g) => g.tier === "static").length;
const dbCount = GATES.filter((g) => g.tier === "database").length;
console.log(
  `check:gate-coverage — ${GATES.length} gates in the manifest (${staticCount} static, ` +
    `${dbCount} database); package.json, the files and the CI workflow all agree.`,
);
