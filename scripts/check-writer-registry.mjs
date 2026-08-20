#!/usr/bin/env node
/**
 * Ordence — GATE 30: THE WRITER REGISTRY IS EXHAUSTIVE
 * Version: v1.84.2-alpha · Track H (integration), written BEFORE Phase 1 delivers
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE PROPERTY NINE CHATS DEPEND ON
 * ══════════════════════════════════════════════════════════════════════
 * Phase 1 replaces four `if (entity.table === ...)` chains in
 * `server/actions/import.ts` with a registry of per-entity writer modules,
 * so that ten tracks can add ten writers and touch ten different files.
 *
 * ⚠️ THE REFACTOR IS NOT THE DELIVERABLE. A registry shaped like
 *
 *     const WRITERS: Record<string, Writer> = { ... }
 *     const w = WRITERS[entity.table];
 *     if (!w) throw new Error("no writer");
 *
 * compiles, reads as complete, passes every test that exercises an entity
 * that HAS a writer, and reproduces exactly the fall-through it was
 * written to remove , one level down. An entity registered without its
 * writer would still reach the customer's picker and still write nothing.
 * That is this codebase's characteristic defect, found more than thirty
 * times, and it would have been reintroduced by the track sent to remove
 * an instance of it.
 *
 * ⭐ SO THE PROPERTY IS: A DESTINATION WITH NO WRITER MUST FAIL TO
 *    COMPILE. Not throw. Not log. Not 500. Fail the build, the way
 *    `REVALIDATE_AFTER` already does , that `Record` is keyed on the
 *    destination union and its own comment says it is a `Record` rather
 *    than a ternary so that TypeScript refuses to compile when a
 *    destination is added without one. It worked: adding a `contacts`
 *    destination during Track M1 broke the build there and nowhere else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ HOW THIS GATE PROVES IT: BY INDUCTION, NOT BY INSPECTION
 * ══════════════════════════════════════════════════════════════════════
 * Reading the source for `Record<ImportTableKey, ...>` would be a second,
 * drifting model of what exhaustiveness means , and this repository has
 * been bitten four times by exactly that (the `>=?` floor matching the
 * `>` inside `<>`; the brace counter that walked into a template literal;
 * the index probe defeated by a dynamic DROP; `boolean::text` compared
 * against 't').
 *
 * So instead: ADD A DESTINATION THE REGISTRY CANNOT KNOW ABOUT, run the
 * real compiler, and require it to fail. Then put the file back and
 * require it to pass. A gate that only ever sees green has proven
 * nothing.
 *
 * ⚠️ IT RESTORES THE FILE IN A `finally`. A gate that leaves the tree
 * mutated after a crash is a gate that breaks the next thing that runs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TYPES = "lib/import/types.ts";
const ACTION = "server/actions/import.ts";
const REGISTRY_CANDIDATES = [
  "server/import/writers/registry.ts",
  "server/import/writers/index.ts",
];

function fail(msg, detail) {
  console.error(`🔴 check:writer-registry , ${msg}`);
  if (detail) console.error(detail);
  process.exit(1);
}

/* ---------------------------------------------------------------- */
/* 1. The registry has to exist at all.                              */
/* ---------------------------------------------------------------- */

const registry = REGISTRY_CANDIDATES.find((p) => existsSync(p));
if (!registry) {
  fail(
    "no writer registry found.",
    `   Looked for:\n${REGISTRY_CANDIDATES.map((p) => `     · ${p}`).join("\n")}\n\n` +
      "   Phase 1 has not landed yet, or landed under a different path. This\n" +
      "   gate is the acceptance criterion for Phase 1 and is expected to be\n" +
      "   red until then.",
  );
}

/* ---------------------------------------------------------------- */
/* 2. The dispatch chains have to be GONE, not merely joined.        */
/* ---------------------------------------------------------------- */

/**
 * ⚠️ COUNTED, NOT EYEBALLED, AND THE NUMBER IS THE BEFORE-STATE.
 * `server/actions/import.ts` at v1.84.1-alpha contains 11 occurrences of
 * `entity.table === "..."`. A delivery that leaves any of them has left a
 * path that dispatches without consulting the registry, which is a second
 * dispatcher , and a second dispatcher is the thing whose divergence
 * nobody notices.
 */
/**
 * 🔴 COMMENTS ARE STRIPPED FIRST, AND THIS IS THE FOURTH TIME THIS
 *    PROJECT HAS LEARNED IT.
 *
 * The comment in `performWrites` explaining what the dispatch USED to
 * read contains the literal `entity.table === "transactions"`. A scan
 * over raw source counts it and reports the explanation as the defect ,
 * exactly what `check-fail-open` did to `lib/security/session-policy.ts`,
 * and what the sealed-grants floor regex did by matching the `>` inside
 * `<>`.
 *
 * ⚠️ AND THE FIX IS NOT TO DELETE THE COMMENT. The comment is the record
 * of why the branch is gone; a gate that makes people erase their
 * reasoning to stay green is a gate that costs more than it catches.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const actionSrc = stripComments(readFileSync(ACTION, "utf8"));
const chains = [...actionSrc.matchAll(/entity\.table\s*===\s*"[a-z_]+"/g)];
if (chains.length > 0) {
  fail(
    `${chains.length} literal destination comparison(s) still in ${ACTION}.`,
    `   ${chains.map((m) => m[0]).join("\n   ")}\n\n` +
      "   Each of these dispatches on a destination without consulting the\n" +
      "   registry. One of them is how an entity ends up writing nothing while\n" +
      "   the registry looks complete.",
  );
}

/* ---------------------------------------------------------------- */
/* 3. THE INDUCTION. A destination with no writer must not compile.  */
/* ---------------------------------------------------------------- */

const typesSrc = readFileSync(TYPES, "utf8");
const anchor = "export type ImportTableKey =\n  | \"companies\"";
if (!typesSrc.includes(anchor)) {
  fail(
    `could not find the destination union in ${TYPES}.`,
    "   This gate mutates that union to induce a compile error. If the union\n" +
      "   moved, the induction is silently not running, and a gate that cannot\n" +
      "   induce its own failure has proven nothing.",
  );
}

function tsc() {
  try {
    execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { ok: true, out: "" };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const SENTINEL = "__gate30_unregistered_destination__";

/**
 * 🔴 A `finally` IS NOT ENOUGH, AND THIS GATE PROVED IT ON ITSELF.
 *
 * The first run of this gate was killed by a `timeout` while `tsc` was
 * working. SIGTERM does not run `finally`, so the sentinel stayed in
 * `lib/import/types.ts` , and the next command to touch the tree failed
 * with an error about a destination nobody had written, which is exactly
 * the confusing state this gate exists to prevent elsewhere.
 *
 * The file's own comment already said "a gate that leaves the tree
 * mutated after a crash is a gate that breaks the next thing that runs".
 * It was right and it was not sufficient. Signals need handlers.
 */
function restore() {
  try {
    writeFileSync(TYPES, typesSrc, "utf8");
  } catch {
    /* FAIL OPEN, deliberately: if the restore itself cannot write there is
     * nothing better to do here, and throwing would replace a bad message
     * with a worse one. The next `tsc` will say what is wrong. */
  }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

let induced;
try {
  writeFileSync(
    TYPES,
    typesSrc.replace(anchor, `${anchor}\n  | "${SENTINEL}"`),
    "utf8",
  );
  induced = tsc();
} finally {
  restore();
}

if (induced.ok) {
  fail(
    "a destination with NO writer compiled cleanly.",
    `   Added "${SENTINEL}" to ImportTableKey and \`tsc --noEmit\` passed.\n\n` +
      "   The registry is not exhaustive over the destination union. It is\n" +
      "   probably keyed by \`string\`, or built with an index signature, or\n" +
      "   resolved at runtime with a \`if (!writer) throw\`. All three compile,\n" +
      "   all three read as complete, and all three mean an entity can be\n" +
      "   registered with no writer and reach the customer's picker while\n" +
      "   writing nothing.\n\n" +
      "   This is the single property Phases 4 to 8 depend on. Without it they\n" +
      "   cannot run in parallel safely.",
  );
}

/* ⚠️ AND THE ERROR HAS TO COME FROM THE REGISTRY, NOT FROM ANYWHERE.
 * A tree that fails to compile for an unrelated reason would satisfy the
 * check above while proving nothing about the registry. */
const registryName = registry.split("/").pop();
const blamedRegistry =
  induced.out.includes(registry) || induced.out.includes(registryName);
if (!blamedRegistry) {
  fail(
    "the induced build failed, but not because of the registry.",
    `   Expected an error mentioning ${registry}. Got:\n\n${induced.out.slice(0, 1500)}\n\n` +
      "   Either the tree was already broken, or something other than the\n" +
      "   registry is refusing the new destination. Fix the tree and re-run.",
  );
}

/* ---------------------------------------------------------------- */
/* 4. And the unmutated tree must still be green.                    */
/* ---------------------------------------------------------------- */

const restored = tsc();
if (!restored.ok) {
  fail(
    "the tree does not compile after restoring the union.",
    restored.out.slice(0, 1500),
  );
}

console.log("✅ check:writer-registry");
console.log(`   registry: ${registry}`);
console.log(`   ${ACTION} carries 0 literal destination comparisons.`);
console.log(
  `   Induction: adding an unregistered destination FAILED to compile, and the`,
);
console.log(`   error named the registry. Restored tree compiles clean.`);
