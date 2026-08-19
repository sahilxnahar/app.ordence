#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE ENVIRONMENT CATALOGUE GATE
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS EXISTS TO STOP
 * ══════════════════════════════════════════════════════════════════════
 * `lib/platform/env-catalog.ts` is the only written-down answer to "what
 * settings does this product read". `/api/diag` reports ONLY names that
 * are in it, and the secret rotation board lists only names it can reach
 * through it. A setting the code reads and the catalogue omits is a
 * setting that is invisible to both — so when it is missing in
 * production, the one endpoint built to explain that class of failure
 * says nothing at all.
 *
 * That had happened to fourteen names by v1.65.0-alpha, including
 * `RESEND_WEBHOOK_SECRET`, which gates ALL bounce and complaint handling.
 *
 * ⚠️ THE CATALOGUE'S OWN HEADER NAMES THE DEFECT: "TWO LISTS KEPT IN STEP
 * BY DISCIPLINE IS THE DEFECT THAT PRODUCED MIGRATION 0091." Correcting
 * the fourteen names without building this gate would have been fixing
 * instance eleven of the pattern and creating instance twelve.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT COUNTS AS A READ, AND WHY THE LIST IS FIVE SHAPES AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * A gate that only understood `process.env.X` would have passed a tree in
 * which most reads go through `readRuntimeEnv("X")` — which exists
 * BECAUSE Next.js inlines the literal form at build time, so the literal
 * form is the one this codebase deliberately avoids. Five shapes:
 *
 *   ① process.env.NAME
 *   ② process.env["NAME"]
 *   ③ readRuntimeEnv("NAME")          — lib/env.ts, the runtime lookup
 *   ④ envVar: "NAME"                  — lib/ai/providers.ts, where the
 *                                       name is DATA and the read is
 *                                       `process.env[provider.envVar]`
 *   ⑤ const bag = process.env as …;   — lib/storage/s3.ts and six other
 *     bag.NAME  /  bag["NAME"]          files alias the environment once
 *                                       and then read fields off it
 *
 * 🔴 SHAPE ④ IS WHY `OPENROUTER_API_KEY` WAS MISSING and a regex over
 * shape ① would never have found it. It is also the shape that will
 * break first if somebody restructures the provider table, and the gate
 * says so out loud rather than silently going quiet: if the provider file
 * yields zero names it FAILS, because "no AI keys are read" is a claim
 * about this product that is false.
 *
 * 🔴 AND SHAPE ⑤ IS WHY THE FIRST DRAFT OF THIS GATE WAS WRONG. Without
 * it, all four `S3_*` names came back as "catalogued and read by
 * nothing", and the obvious response to that report would have been to
 * DELETE the only settings that give this product document storage.
 * `lib/storage/s3.ts` reads them off a local alias, which is not an
 * exotic style — it is what `middleware.ts`, `lib/edge/limits.ts` and
 * `app/api/diag/route.ts` all do, because `process.env.LITERAL` is
 * inlined at build time and this codebase deliberately avoids it. A gate
 * that cannot see the dominant idiom in the tree it guards would have
 * caused damage rather than prevented it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND IT CHECKS BOTH DIRECTIONS
 * ══════════════════════════════════════════════════════════════════════
 * Read-but-uncatalogued is an ERROR: the diagnostic is blind to it.
 * Catalogued-but-unread is a WARNING with an explicit allowlist, because
 * three of those are legitimate — a name read by a vendor SDK rather than
 * by us, a name read only by scripts, and a name kept for rollback. Each
 * has to be named in `KNOWN_UNREAD` with a sentence, so the list can only
 * shrink by somebody deciding to shrink it. Same ratchet as
 * `KNOWN_UNPOSTED` in the posting gate and the reachability baseline.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();

/**
 * ⚠️ `next.config.ts`, `instrumentation.ts` AND `instrumentation-client.ts`
 * ARE IN SCOPE.
 *
 * `SENTRY_AUTH_TOKEN` is read only by `next.config.ts`. A gate scoped to
 * `app/ lib/ server/ db/ middleware.ts` — the five the brief named —
 * would have declared the catalogue clean while the one name an operator
 * needs for readable stack traces was still missing from it. Build-time
 * settings are settings.
 */
const SEARCH_ROOTS = [
  "app",
  "lib",
  "server",
  "db",
  "components",
  "middleware.ts",
  "next.config.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".mjs"]);

/**
 * Names the HOSTING PLATFORM injects. Nobody sets them in Railway, and
 * putting them on a rotation board would tell an operator to rotate a
 * value they do not own.
 */
const PLATFORM_INJECTED = new Set([
  "NODE_ENV",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_GIT_COMMIT_SHA",
  "RAILWAY_SERVICE_NAME",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_URL",
  "PORT",
  "npm_package_version",
  /**
   * ⚠️ Set by Next.js itself so `instrumentation.ts` can tell the node
   * runtime from the edge one. Nobody sets it in Railway.
   */
  "NEXT_RUNTIME",
]);

/**
 * 🔴 CATALOGUED AND READ BY NOTHING IN THE RUNNING APP. Each needs a
 * sentence. The list is a RATCHET: it may shrink, never grow. A name that
 * appears here without a reason fails the gate, because "we know" is not
 * a reason anybody can act on eighteen months later.
 */
const KNOWN_UNREAD = {
  CLERK_ENCRYPTION_KEY:
    "Read by the Clerk SDK, not by us. It is a real setting an operator must supply for handshake encryption; the absence of a `process.env` read in our tree does not mean the deployment does not need it. Keep, annotated.",
  BLOB_READ_WRITE_TOKEN:
    "Legacy Vercel Blob. Honestly labelled 'Legacy — kept for rollback safety; no live code path'. Delete it when the Cloudflare rollback is retired.",
  SEED_ALLOW_PROD:
    "Read by `scripts/` only, never by the application. It is still an operator-set safety catch and belongs on the paste sheet, so it stays catalogued with this note rather than being removed.",
  DATABASE_URL_UNPOOLED:
    "Read by migration tooling, never by the running app. Same reasoning as SEED_ALLOW_PROD.",
  FINANCE_ALERT_EMAILS:
    "Genuinely dead — declared in `lib/env.ts`'s schema and read by no code path in `app/`, `lib/`, `server/`, `db/` or `middleware.ts`. Kept catalogued ONLY so an existing deployment that already sets it is not told by /api/diag that it does not exist. Candidate for deletion together with its `lib/env.ts` line; that is a batch of its own because it touches the boot schema.",
};

/* ------------------------------------------------------------------ */
/* ① WHAT THE CODE READS                                               */
/* ------------------------------------------------------------------ */

function sourceFiles() {
  const out = [];
  const walk = (path) => {
    const st = statSync(path);
    if (st.isFile()) {
      if (SOURCE_EXT.has(extname(path))) out.push(path);
      return;
    }
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(join(path, entry));
    }
  };
  for (const rel of SEARCH_ROOTS) {
    const path = join(ROOT, rel);
    if (existsSync(path)) walk(path);
  }
  return out;
}

/**
 * ⚠️ COMMENTS ARE STRIPPED BEFORE MATCHING, and this is not cosmetic.
 * This repository documents its environment variables IN PROSE next to
 * the code that reads them — `process.env.NEXT_PUBLIC_FOO` appears in
 * `middleware.ts`'s header as an EXAMPLE of the inlining problem, and
 * `process.env.X` appears in `lib/billing/grace.ts`. Matching those would
 * have demanded catalogue entries for `NEXT_PUBLIC_FOO`, `X`, `NAME` and
 * `SOMETHING`, and the only way anybody would ever have made this gate
 * pass is by deleting the explanations.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const READ_SHAPES = [
  /process\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /readRuntimeEnv\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g,
  /\benvVar:\s*["']([A-Z][A-Z0-9_]*)["']/g,
];

/**
 * Shape ⑤. Finds every local name a file binds `process.env` to, then
 * reads the fields taken off it.
 *
 * ⚠️ FILE-LOCAL, NOT GLOBAL. Binding `bag` in one file must not make
 * `bag.ANYTHING` in another file count as an environment read — that
 * would turn any variable called `bag`, `env` or `e` into a source of
 * phantom names, and phantom names in an error list are how a gate gets
 * switched off.
 */
const ALIAS_BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:\()?\s*process\.env\b/g;

function aliasReads(code, found, file) {
  ALIAS_BINDING.lastIndex = 0;
  const aliases = new Set();
  let m;
  while ((m = ALIAS_BINDING.exec(code)) !== null) aliases.add(m[1]);
  let hits = 0;
  for (const alias of aliases) {
    const re = new RegExp(
      `\\b${alias}\\s*(?:\\?\\.)?(?:\\.([A-Z][A-Z0-9_]*)\\b|\\[\\s*["']([A-Z][A-Z0-9_]*)["']\\s*\\])`,
      "g",
    );
    let hit;
    while ((hit = re.exec(code)) !== null) {
      const name = hit[1] ?? hit[2];
      if (!name) continue;
      hits += 1;
      if (!found.has(name)) found.set(name, file);
    }
  }
  return hits;
}

/**
 * Shape ⑥. `process.env[SOME_CONSTANT]`, where `SOME_CONSTANT` is a
 * module-level binding to a literal variable name.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS EXISTS FOR, AND IT WAS THIS GATE'S FIRST RUN
 * ══════════════════════════════════════════════════════════════════════
 * `CLOUDFLARE_ACCOUNT_ID` was reported as catalogued and read by nothing.
 * It is read. `lib/ai/client.ts` line 205 does
 *
 *     process.env[PLATFORM_ACCOUNT_ID_ENV]
 *
 * and `lib/ai/credentials.ts` declares
 *
 *     export const PLATFORM_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
 *
 * The indirection arrived with the per-tenant AI credentials work, whose
 * whole point is that the platform key is NAMED in one place and valued
 * in none — the settings screen, the resolver and the refusal message all
 * print the name, and printing a name you have hard-coded in four files
 * is how they drift apart. Shapes ① and ② look for a literal inside the
 * brackets and there is not one.
 *
 * ⚠️ AND THE OBVIOUS FIX WAS THE WRONG ONE. `KNOWN_UNREAD` says "read by
 * nothing, and here is why that is fine". Putting this name there would
 * have made this gate assert something false about the exact class of
 * fault it exists to catch, and it would have stayed false and unread
 * long after somebody deleted the last real reader.
 *
 * ⚠️ THE BINDING IS RESOLVED REPO-WIDE, UNLIKE SHAPE ⑤. The alias shape
 * is deliberately file-local because binding `env` in one file must not
 * make `env.ANYTHING` elsewhere count. This one is safe to widen because
 * the identifier has to appear INSIDE `process.env[...]` to be credited
 * at all: an unrelated `const MODE = "PRODUCTION"` is never consulted
 * unless somebody also wrote `process.env[MODE]`, at which point it is a
 * genuine environment read whatever it is called.
 */
const NAME_CONST_BINDING =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["']([A-Z][A-Z0-9_]*)["']\s*(?:as\s+const\s*)?[;,\n]/g;
const COMPUTED_ENV_READ = /process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]/g;

function constNameBindings(files) {
  const bindings = new Map();
  for (const { code } of files) {
    NAME_CONST_BINDING.lastIndex = 0;
    let m;
    while ((m = NAME_CONST_BINDING.exec(code)) !== null) {
      if (!bindings.has(m[1])) bindings.set(m[1], m[2]);
    }
  }
  return bindings;
}

function readNames() {
  /** name → the first file that reads it, for the error message. */
  const found = new Map();
  let providerShapeHits = 0;
  let aliasShapeHits = 0;
  let constShapeHits = 0;

  /**
   * ⚠️ READ EVERY FILE ONCE, BEFORE MATCHING ANY OF THEM. Shape ⑥ needs
   * a binding that may live in a different file from the read, and
   * `sourceFiles()` is in no meaningful order.
   */
  const files = sourceFiles().map((file) => ({
    rel: file.slice(ROOT.length + 1),
    code: codeOnly(readFileSync(file, "utf8")),
  }));

  const nameConsts = constNameBindings(files);

  for (const { rel, code } of files) {
    READ_SHAPES.forEach((re, shapeIndex) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code)) !== null) {
        const name = m[1];
        if (shapeIndex === 3) providerShapeHits += 1;
        if (!found.has(name)) found.set(name, rel);
      }
    });
    aliasShapeHits += aliasReads(code, found, rel);

    COMPUTED_ENV_READ.lastIndex = 0;
    let hit;
    while ((hit = COMPUTED_ENV_READ.exec(code)) !== null) {
      const name = nameConsts.get(hit[1]);
      if (!name) continue;
      constShapeHits += 1;
      if (!found.has(name)) found.set(name, rel);
    }
  }

  return { found, providerShapeHits, aliasShapeHits, constShapeHits };
}

/* ------------------------------------------------------------------ */
/* ② WHAT THE CATALOGUE DECLARES                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ PARSED FROM SOURCE, NOT IMPORTED.
 *
 * `lib/platform/env-catalog.ts` is TypeScript, and a `.mjs` gate cannot
 * import it without a build step. Every other gate in this repository
 * reads source text for the same reason. The parse is deliberately dumb —
 * every quoted upper-case identifier inside the `required` and `optional`
 * arrays — because a clever parse that silently matched nothing would
 * make this gate pass by finding no catalogue at all.
 */
function cataloguedNames() {
  const file = join(ROOT, "lib", "platform", "env-catalog.ts");
  const source = readFileSync(file, "utf8");
  const body = source.slice(source.indexOf("export const ENV_CATEGORIES"));
  const names = new Set();
  const re = /["']([A-Z][A-Z0-9_]*)["']/g;
  let m;
  while ((m = re.exec(body)) !== null) names.add(m[1]);
  return names;
}

/* ------------------------------------------------------------------ */
/* ③ THE PASTE SHEET, GENERATED RATHER THAN MAINTAINED                 */
/* ------------------------------------------------------------------ */

/**
 * 🔴 `RAILWAY-VARIABLES-PASTE.txt` OMITTED ALL FOUR `S3_*` NAMES AND
 * EVERY AI KEY. An operator following it verbatim got a deployment with
 * no document storage and no AI, and nothing said so. That is the same
 * defect as the catalogue drift, one level up: a hand-maintained list
 * beside a source of truth.
 *
 * So the sheet is generated by `scripts/generate-railway-variables.mjs`
 * and this gate asserts that every catalogued name appears in it. It does
 * NOT assert the reverse: the sheet legitimately carries `NODE_ENV`,
 * which is platform-injected and still worth pinning explicitly.
 */
function pasteSheetNames() {
  const file = join(ROOT, "RAILWAY-VARIABLES-PASTE.txt");
  if (!existsSync(file)) return null;
  const names = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

const { found, providerShapeHits, aliasShapeHits, constShapeHits } = readNames();
const catalogued = cataloguedNames();
const sheet = pasteSheetNames();

const errors = [];
const notes = [];

/**
 * ⚠️ THE GATE'S OWN SELF-CHECK COMES FIRST, for the reason the SQL files
 * put the diagnostic first: if the risky part refuses, the operator still
 * learns something. A gate whose matcher has silently stopped matching
 * passes every run and proves nothing, which is worse than a gate that
 * fails.
 */
if (found.size < 20) {
  errors.push(
    `The reader found only ${found.size} environment names across ${SEARCH_ROOTS.length} roots. ` +
      `That is not a clean tree, it is a broken matcher — this product reads dozens. Fix this gate.`,
  );
}
if (providerShapeHits === 0) {
  errors.push(
    'No `envVar: "NAME"` matches were found. That shape is how `lib/ai/providers.ts` names the AI keys ' +
      "that `lib/ai/client.ts` then reads through `process.env[provider.envVar]`. Zero matches means the " +
      "provider table has been restructured and this gate can no longer see any AI key. Teach it the new shape.",
  );
}
if (aliasShapeHits === 0) {
  errors.push(
    "No `const bag = process.env` alias reads were found. `lib/storage/s3.ts` reads all four S3_* " +
      "names that way and six other files use the same idiom, so zero matches means this gate has " +
      "gone blind to the DOMINANT read shape in the tree — and would then report the storage " +
      "settings as dead. Fix the matcher; do not delete the names it stops seeing.",
  );
}
/**
 * ⚠️ THE SAME SELF-CHECK THE OTHER SHAPES GET, AND FOR THE SAME REASON.
 * `PLATFORM_ACCOUNT_ID_ENV` is the only binding this shape currently
 * resolves, so a refactor that inlines it would take this count to zero.
 * That is fine and this check would then be wrong — which is why it says
 * so rather than failing silently, and why the sentence names the file
 * to look in before anybody deletes the shape.
 */
if (constShapeHits === 0) {
  errors.push(
    "No `process.env[SOME_CONSTANT]` reads were found. `lib/ai/client.ts` reads the platform " +
      "Cloudflare account id through `PLATFORM_ACCOUNT_ID_ENV`, declared in `lib/ai/credentials.ts`. " +
      "Zero matches means either that indirection is gone — in which case delete this check and the " +
      "shape with it — or this matcher has gone blind and CLOUDFLARE_ACCOUNT_ID is about to be " +
      "reported as dead again. Do not silence it with KNOWN_UNREAD; that says 'read by nothing' " +
      "about a name that is read.",
  );
}
if (catalogued.size < 20) {
  errors.push(
    `Parsed only ${catalogued.size} names out of lib/platform/env-catalog.ts. The parse has broken.`,
  );
}

const readButUncatalogued = [...found.keys()]
  .filter((n) => !PLATFORM_INJECTED.has(n))
  .filter((n) => !catalogued.has(n))
  .sort();

for (const name of readButUncatalogued) {
  errors.push(
    `${name} is read by ${found.get(name)} and is NOT in lib/platform/env-catalog.ts. ` +
      `/api/diag reports only catalogued names, so this setting is invisible to the one endpoint ` +
      `built to explain a missing setting. Add it to the category it belongs to.`,
  );
}

const cataloguedButUnread = [...catalogued]
  .filter((n) => !found.has(n))
  .sort();

for (const name of cataloguedButUnread) {
  if (KNOWN_UNREAD[name]) {
    notes.push(`  ${name} — ${KNOWN_UNREAD[name]}`);
    continue;
  }
  errors.push(
    `${name} is in lib/platform/env-catalog.ts and is read by nothing in ` +
      `${SEARCH_ROOTS.join(", ")}. Either wire it, delete it, or add it to KNOWN_UNREAD in this ` +
      `file WITH THE SENTENCE that says why it is still listed.`,
  );
}

for (const stale of Object.keys(KNOWN_UNREAD)) {
  if (found.has(stale)) {
    errors.push(
      `${stale} is listed in KNOWN_UNREAD as read by nothing, but ${found.get(stale)} reads it. ` +
        `Remove the entry — a stale exemption is how a real gap hides.`,
    );
  }
}

if (sheet === null) {
  errors.push("RAILWAY-VARIABLES-PASTE.txt is missing.");
} else {
  const missingFromSheet = [...catalogued].filter((n) => !sheet.has(n)).sort();
  for (const name of missingFromSheet) {
    errors.push(
      `${name} is catalogued but absent from RAILWAY-VARIABLES-PASTE.txt. An operator pasting that ` +
        `block verbatim gets a deployment without it. Regenerate: node scripts/generate-railway-variables.mjs`,
    );
  }
}

console.log("══════════════════════════════════════════════════════");
console.log("  ENVIRONMENT CATALOGUE");
console.log("══════════════════════════════════════════════════════");
console.log(`  names read by code      ${found.size}`);
console.log(`  read via an env alias   ${aliasShapeHits}`);
console.log(`  read via a named const  ${constShapeHits}`);
console.log(`  names in the catalogue  ${catalogued.size}`);
console.log(`  names on the paste sheet ${sheet ? sheet.size : "—"}`);
if (notes.length > 0) {
  console.log("\n  Catalogued and read by nothing, each with a reason:");
  for (const note of notes) console.log(note);
}

if (errors.length > 0) {
  console.error(`\n❌ ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error("");
  process.exit(1);
}

console.log("\n✅ Every setting the code reads is catalogued and on the paste sheet.");
