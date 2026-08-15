#!/usr/bin/env node
/**
 * Ordence — Action guard census · THE FOURTH STRUCTURAL GATE
 * Version: v1.26.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `"use server"` turns every export of a module into a PUBLIC HTTP
 * ENDPOINT. Not "an internal function the UI happens to call" — a URL,
 * reachable with curl, by anybody who has ever loaded the app and can
 * read a network tab.
 *
 * The existing boundary gate already checks that such a module exports
 * only async functions, which stops a constant or a schema being
 * published as one. What it has never checked is the thing that
 * actually matters: WHETHER THE FUNCTION ASKS WHO IS CALLING IT.
 *
 * ⚠️ AND NOTHING ELSE CATCHES IT. An action that forgets its guard type
 * checks, builds, renders and works perfectly — for the person testing
 * it, who is signed in as an administrator. It is indistinguishable from
 * a correct one until somebody who should not have the permission calls
 * it, and by then the only record is in the data.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO TIERS, BECAUSE "GUARDED" IS NOT ONE QUESTION
 * ══════════════════════════════════════════════════════════════════════
 * There is a real and frequently-missed difference between:
 *
 *   TIER 1 — IDENTITY. `requireTenantContext()` answers "who are you and
 *            which workspace are you in", and pins the tenant so RLS can
 *            do its job. It answers NOTHING about whether you may do
 *            this particular thing.
 *
 *   TIER 2 — AUTHORISATION. `requirePermission()`, `requireRole()`,
 *            `guardSalesWrite()`. These answer "may THIS person do THIS".
 *
 * A READ may legitimately stop at tier 1: everyone in a workspace can
 * usually see the workspace. A WRITE may not. An action that mutates
 * data behind tier 1 alone lets the newest junior in the workspace post
 * a journal entry, cancel a booking or delete a saved view — because
 * they are, correctly, a member of the tenant.
 *
 * 🔴 THAT IS THE HOLE THIS GATE IS FOR, and it is invisible in review
 * because `const ctx = await requireTenantContext()` LOOKS like a guard.
 * It is a guard. It is the wrong one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE HOP, AND ONLY ONE
 * ══════════════════════════════════════════════════════════════════════
 * Several action files are deliberately thin: `server/actions/views.ts`
 * knocks on `server/views/definitions.ts` and does nothing else, which is
 * right — the same work is reachable from a background job that is not a
 * server action, and a gate living in the action file would exist in one
 * of the two paths.
 *
 * So an action satisfies this gate if IT guards, or if the `@/server/...`
 * function it delegates to guards. ONE hop.
 *
 * ⭐ NOT TWO, AND THE LIMIT IS DELIBERATE. A gate that chases delegation
 * to arbitrary depth is a type-checker with a worse error message, and
 * every additional hop is another place the analysis can be wrong while
 * reporting confidence. One hop covers the delegation pattern this
 * codebase actually uses; anything deeper has to be declared.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE ALLOWLIST HAS REASONS AND NOT JUST NAMES
 * ══════════════════════════════════════════════════════════════════════
 * Same rule as `KNOWN_UNPOSTED` in the posting gate: an entry has to say
 * WHY in a sentence somebody else can disagree with. A list of bare
 * names is a list nobody ever removes anything from, because there is
 * nothing written down to argue against.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ACTIONS_DIR = join(ROOT, "server", "actions");

/* ------------------------------------------------------------------ */
/* WHAT COUNTS AS A GUARD                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ TIER 2 — AUTHORISATION. These decide whether this person may do
 * this thing.
 *
 * ⚠️ `requireRole` IS HERE AND THAT IS NOT AN OVERSIGHT. Ordence has
 * two authorisation models: permission keys for most of the product, and
 * role sets for the trust-accounting core, which predates the permission
 * table. `requireRole(FINANCE_ROLES)` is a real answer to "may this
 * person post a journal entry" — a narrower one than most permission
 * checks, in fact. A gate that only recognised one spelling would report
 * the most carefully-guarded module in the repo as unguarded, and the
 * fix would be to weaken it.
 */
const TIER2 = [
  "requirePermission",
  "requireAllPermissions",
  "requireFeatureAndPermission",
  "requireRole",
  "requirePlatformAdmin",
  /**
   * ⭐ THE `guard*Write` FAMILY. Each one is a module's own composed
   * gate — entitlement, then permission, then the module's own rule —
   * and every one of them ends in a permission check. Listing them
   * individually rather than matching `guard.*Write` is deliberate: a
   * pattern would silently accept a future `guardNothingWrite`.
   */
  "guardDynamicWrite",
  "guardGstWrite",
  /**
   * ⭐ ADDED v1.45.0. `guardImport` (server/actions/import.ts) is the
   * same shape as its neighbours above: tenant context, then account
   * access, then two entitlement checks, then
   * `requirePermission(entity.createPermission)` — and
   * `requirePermission(entity.updatePermission)` as well when the run
   * may overwrite.
   *
   * ⚠️ IT WAS THE LIST THAT WAS INCOMPLETE, NOT THE CODE. Two agents
   * working on unrelated batches both hit this in one run and both
   * correctly diagnosed it as a checker limitation rather than a hole.
   * The alternative fix — a second guard call at the export purely to
   * satisfy the one-hop walk — would have added a duplicate context
   * resolution on every import to make a script happy, which is how a
   * gate teaches people to write code for the gate.
   */
  "guardImport",
  "guardPurchaseWrite",
  "guardReceivablesWrite",
  "guardSalesWrite",
  "guardTallyWrite",
  "guardTdsWrite",
  "guardViewWrite",
  "guardWorkflowWrite",
  /**
   * ⭐ THE PURE PREDICATE, WHICH IS SOMETIMES THE BETTER CHOICE.
   *
   * `bulk.ts` writes `if (!can(subject, spec.deletePermission)) return
   * {ok:false, error: ...}` instead of letting `requirePermission` throw
   * — so a bulk delete of five hundred records refuses with a sentence
   * naming the entity rather than an exception. It is a real
   * authorisation check and a more considerate one.
   *
   * ⚠️ A GATE THAT ONLY RECOGNISED THE THROWING HELPER WOULD HAVE
   * REPORTED THE MOST DESTRUCTIVE ACTION IN THE PRODUCT AS UNGUARDED,
   * and the "fix" would have been to make its error message worse.
   */
  "can",
  "canAll",
  "canAny",
];

/**
 * 🔴 NOT GUARDS, AND THE DISTINCTION IS THE POINT OF THIS LIST EXISTING.
 *
 * `requireFeature`, `requireAccess`, `requireSeat`, `requireQuota` all
 * refuse things, all appear at the top of an action next to the real
 * guard, and all read like authorisation. None of them is.
 *
 *   requireFeature  — "does your PLAN include this"
 *   requireAccess   — "is your ACCOUNT in good standing"
 *   requireSeat     — "have you paid for this many people"
 *   requireQuota    — "have you used this up"
 *
 * ⚠️ EVERY ONE OF THOSE IS A PROPERTY OF THE WORKSPACE, NOT OF THE
 * PERSON. A workspace on the right plan, paid up and within quota,
 * passes all four for the newest junior who joined this morning. An
 * action guarded by them alone is guarded against the wrong thing
 * entirely — and it looks more careful than one with a single
 * `requirePermission`, which is what makes it worth naming here.
 */
const NOT_GUARDS = ["requireFeature", "requireAccess", "requireSeat", "requireQuota"];

/**
 * TIER 1 — IDENTITY ONLY. Enough for a read. Never enough for a write.
 */
const TIER1 = ["requireTenantContext", "requirePageContext", "getTenantContext"];

/**
 * ⚠️ SIGNALS THAT A FUNCTION MUTATES SOMETHING.
 *
 * `revalidatePath` is in here and it is the most reliable of them.
 * Drizzle calls can be built in a helper and passed around; nobody
 * revalidates a path after a read. It is the one marker that is present
 * because the author KNEW they had changed something.
 */
const WRITE_MARKERS = [
  /\.insert\(/,
  /\.update\(/,
  /\.delete\(/,
  /revalidatePath\(/,
  /\bwriteAudit\(/,
];

/* ------------------------------------------------------------------ */
/* THE ALLOWLIST                                                       */
/* ------------------------------------------------------------------ */

/**
 * `"file.ts#functionName": "why"` — and the why has to be a sentence
 * somebody can disagree with.
 */
const ALLOWED = {
  /**
   * ⭐ OPENING A THREAD IS READING IT.
   *
   * `getThread` writes exactly one thing: `lastReadAt` on the CALLER'S
   * OWN participant row, scoped by `userId = ctx.user.id`. It changes
   * no message, no participant list and nobody else's state.
   *
   * ⚠️ A read-with-a-side-effect is the one honest exception to the
   * write-behind-a-read rule, and it is only honest while the side
   * effect is the caller's own read marker. If this function ever edits
   * a message or adds a participant, this entry is wrong and should be
   * deleted rather than widened.
   */
  "messages.ts#getThread":
    "Marks the caller's own participant row as read. Writes nothing else, and nothing belonging to anybody else.",

  /**
   * ⭐ A PRICING PAGE IS PUBLIC BY DESIGN.
   *
   * `listPublicPlans` reads rows already filtered to `isActive AND
   * isPublic` and returns what is printed on the marketing site. It is
   * reachable before anybody has an account, which is the point.
   *
   * ⚠️ THE GUARD IS THE `isPublic` COLUMN, and that is a real guard —
   * a plan not marked public is not returned to anybody through this
   * path. Adding a session check would break sign-up.
   */
  "billing.ts#listPublicPlans":
    "A pricing page has to render before anybody has an account. The rows are filtered to isActive AND isPublic in the query, so the column is the guard.",

  /**
   * ⭐⭐ A DIFFERENT AUTHENTICATION MECHANISM, NOT AN ABSENT ONE.
   *
   * The portal has no Clerk session. A customer signing a contract
   * arrives with a signed, expiring token in a link, and the action
   * RE-VERIFIES THAT TOKEN FROM SCRATCH rather than trusting the page
   * that rendered the form — because, as its own comment says, it is
   * reachable by anyone who can POST to it.
   *
   * ⚠️ THIS IS THE ENTRY MOST WORTH BEING SUSPICIOUS OF, because "it
   * uses a different mechanism" is also what a genuinely unguarded
   * endpoint would say. What makes it true here is that the token check
   * happens INSIDE this function and refuses before anything is read.
   */
  "signatures.ts#signContractViaPortal":
    "Authenticated by a signed portal token that the action re-verifies from scratch, not by a workspace session. A permission check would require a session the signer does not have.",

  /**
   * ⭐ YOUR OWN INBOX. "May you read your own post" is not a question
   * the permission table should have an opinion about.
   *
   * 🔴 THE INVARIANT THESE RELY ON IS THE `mine` PREDICATE — `userId =
   * caller OR userId IS NULL` — and it is asserted by a test rather than
   * trusted, because it is the whole authorisation. Until v1.26.0-alpha
   * it was absent, and `markAllAsRead` cleared every unread notification
   * in the workspace for everybody.
   */
  "notifications.ts#markAsRead":
    "Acts only on the caller's own notification row, enforced by the `mine` predicate rather than by a permission. A permission key would still let its holder clear somebody else's inbox.",
  "notifications.ts#markAllAsRead":
    "Same as markAsRead. The `mine` predicate is the authorisation, and a test asserts it is present.",
  "notifications.ts#dismissNotification":
    "Same as markAsRead. The `mine` predicate is the authorisation, and a test asserts it is present.",
};

/* ------------------------------------------------------------------ */
/* PARSING                                                             */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 STRIP COMMENTS FIRST, AND THIS IS THE THIRD BUG THIS GATE FOUND
 *      IN ITSELF
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/contacts.ts#createContact` passed the gate. It writes,
 * and its only guard is `requireTenantContext()` — it should have
 * failed. What made it pass was this, in a doc comment above the call:
 *
 *     *     requireAccess()      ← is the account in good standing?
 *     *     requireFeature()     ← is it in the plan?
 *     *     requirePermission()  ← may this person do it?
 *
 * The gate matched `requirePermission(` in the COMMENT and concluded the
 * function was authorised. The comment describes the intended order.
 * The code stops after the second line.
 *
 * ⚠️ SO THE GATE BELIEVED THE DOCUMENTATION INSTEAD OF THE CODE — which
 * is precisely the class of defect it exists to catch, and precisely
 * what a stale `TDS_194H_BPS = 500` did last session while
 * `lib/tds/sections.ts` described the correct rate in prose two files
 * away.
 *
 * ⭐ A CHECK THAT CAN BE SATISFIED BY WRITING THE RIGHT WORDS IN A
 *   COMMENT IS NOT A CHECK. Comments and strings go before anything is
 *   matched.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    /**
     * ⚠️ STRING LITERALS TOO. `throw new Error("call requirePermission")`
     * is the same hole with a different quote mark, and it is the exact
     * shape a helpful error message takes.
     */
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const read = (f) => stripComments(readFileSync(f, "utf8"));

/** ⚠️ The RAW text, for the one thing that must see the directive. */
const readRaw = (f) => readFileSync(f, "utf8");

/**
 * ⚠️ BRACE-MATCHED, NOT REGEX-TO-THE-NEXT-EXPORT. A regex that stops at
 * the next `export` misses everything after a nested function and
 * silently shortens the body it inspects — which for THIS gate means
 * reporting a guarded function as unguarded, or worse, the reverse.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE FIRST VERSION OF THIS FUNCTION DID EXACTLY THAT, ON ITS
 *    FIRST RUN, AGAINST THE MOST CAREFULLY-GUARDED FILE IN THE REPO
 * ══════════════════════════════════════════════════════════════════════
 * It took `indexOf("{")` after the function name as the start of the
 * body. For a signature like
 *
 *     export async function reverseTransaction(
 *       input: z.input<typeof reverseSchema>,
 *     ): Promise<ActionResult<{ originalId: string; reversalId: string }>> {
 *
 * the first `{` is inside the RETURN TYPE. Brace matching then closed on
 * the type's own `}`, and the "body" the gate inspected was thirty
 * characters of type annotation containing no guard call — so
 * `reverseTransaction`, which opens with `await requireRole(
 * FINANCE_ROLES)`, was reported as asking nothing about its caller.
 *
 * ⚠️ IT FAILED LOUDLY, AND THAT WAS LUCK. Roughly two hundred false
 * positives is obviously a broken gate. The same bug on a codebase with
 * ten actions would have produced two plausible-looking findings, and
 * the fix would have been to add guards that were already there.
 *
 * ⭐ SO THE BODY IS FOUND BY ANGLE-BRACKET DEPTH: skip the parameter
 *   list, then take the first `{` that appears while no type parameter
 *   is open. A `{` inside `Promise<...>` is at depth ≥ 1 and is not a
 *   body.
 */
function functionBodies(source, pattern) {
  const out = [];
  const re = pattern
    ? new RegExp(pattern.source, pattern.flags)
    : /^export\s+async\s+function\s+([A-Za-z0-9_]+)\s*(?:<[^>(]*>)?\s*\(/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];

    /* ---- step past the parameter list ---------------------------- */
    let i = re.lastIndex - 1; // at the '('
    let paren = 0;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") paren += 1;
      else if (source[i] === ")") {
        paren -= 1;
        if (paren === 0) break;
      }
    }
    if (i >= source.length) continue;

    /* ---- find the body brace, ignoring braces inside a type ------ */
    let angle = 0;
    let open = -1;
    for (i += 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "<") angle += 1;
      // ⚠️ `=>` is a greater-than that closes nothing.
      else if (ch === ">" && source[i - 1] !== "=") angle = Math.max(0, angle - 1);
      else if (ch === "{" && angle === 0) {
        open = i;
        break;
      }
    }
    if (open === -1) continue;

    let depth = 0;
    let j = open;
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({ name, body: source.slice(open, j + 1) });
  }
  return out;
}

/**
 * `import { a as b, c } from "@/server/x"` → Map(b → {module:"@/server/x", real:"a"})
 *
 * ⚠️ ALIASES MATTER. The delegation pattern in this codebase is
 * `import { createView as createViewImpl }`, so a resolver that ignored
 * the alias would look for `createViewImpl` in the target module and not
 * find it — then report the action as unguarded, which is exactly the
 * false positive that teaches people to add allowlist entries.
 */
/**
 * ⚠️ EVERY function declaration in the file, exported or not.
 *
 * The exported ones are the endpoints; the unexported ones are where the
 * guard very often actually lives, because a module with four state
 * transitions writes the check once.
 */
function allFunctionBodies(source) {
  const out = new Map();
  for (const f of functionBodies(source, /^(?:export\s+)?async\s+function\s+([A-Za-z0-9_]+)\s*(?:<[^>(]*>)?\s*\(/gm)) {
    out.set(f.name, f.body);
  }
  return out;
}

function serverImports(source) {
  const map = new Map();
  const re = /import\s*\{([^}]+)\}\s*from\s*"(@\/server\/[^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const module = m[2];
    for (const piece of m[1].split(",")) {
      const text = piece.trim();
      if (!text || text.startsWith("type ")) continue;
      const parts = text.split(/\s+as\s+/);
      const real = parts[0].trim();
      const local = (parts[1] ?? parts[0]).trim();
      if (local) map.set(local, { module, real });
    }
  }
  return map;
}

function resolveModule(spec) {
  const base = join(ROOT, spec.replace(/^@\//, ""));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const bodyCache = new Map();
function bodiesOf(file) {
  if (!bodyCache.has(file)) {
    const map = new Map();
    for (const f of functionBodies(read(file))) map.set(f.name, f.body);
    bodyCache.set(file, map);
  }
  return bodyCache.get(file);
}

const has = (body, names) => names.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body));
const writes = (body) => WRITE_MARKERS.some((re) => re.test(body));

/* ------------------------------------------------------------------ */
/* ⭐ THE THIRD ASSERTION: A READ KEY ON A WRITE                        */
/* ------------------------------------------------------------------ */

/**
 * 🔴 WHY THIS EXISTS.
 *
 * Until v1.31.0 this gate matched guard NAMES and never once looked at
 * the argument. It reported `578 endpoints, 534 authorisation-checked`
 * while `exportWorkspace` — which returns 26 tables including the
 * ledger and the audit log — sat behind `settings:read`, a permission
 * the `read_only` role holds.
 *
 * ⚠️ THE KEY ITSELF IS NOW THE COMPILER'S JOB. `requirePermission` takes
 * `PermissionKey`, so a key that is not in the catalogue is a type
 * error, and the five dead keys that denied twenty modules cannot recur.
 * What the compiler CANNOT see is a key that exists, is spelt right, and
 * is the wrong side of the read/write line. That is this check.
 */
const READ_SHAPED = /[.:](read|list|read_all_records)$/;

/**
 * Permission keys named anywhere in a body, including via a file-local
 * `const READ = "contacts:read" as const;` — which is how most of this
 * codebase writes them.
 */
function permissionKeysIn(body, constMap) {
  const keys = new Set();
  const callRe =
    /(?:requirePermission|requireAllPermissions|requireFeatureAndPermission|checkPermission|canAll|canAny|can)\s*\(([^;]{0,300})/g;
  const propRe = /permission:\s*([A-Za-z0-9_]+|"[a-z0-9_]+[.:][a-z0-9_.:]+")/g;
  for (const m of [...body.matchAll(callRe)].map((x) => x[1]).concat(
    [...body.matchAll(propRe)].map((x) => x[1]),
  )) {
    for (const lit of m.matchAll(/"([a-z0-9_]+[.:][a-z0-9_.:]+)"/g)) keys.add(lit[1]);
    for (const id of m.matchAll(/\b([A-Z][A-Z0-9_]{1,})\b/g)) {
      if (constMap[id[1]]) keys.add(constMap[id[1]]);
    }
  }
  return [...keys];
}

/** `const READ = "contacts:read" as const;` → { READ: "contacts:read" } */
function permissionConsts(rawSource) {
  const map = {};
  for (const m of rawSource.matchAll(
    /(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+[.:][a-z0-9_.:]+)"/g,
  )) {
    map[m[1]] = m[2];
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* THE CENSUS                                                          */
/* ------------------------------------------------------------------ */

let failures = 0;
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  failures += 1;
};

const files = readdirSync(ACTIONS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

let checked = 0;
let tier2Count = 0;
let tier1Reads = 0;
let delegated = 0;
const allowedUsed = new Set();

for (const fileName of files) {
  const full = join(ACTIONS_DIR, fileName);
  const source = read(full);

  /**
   * ⚠️ THE DIRECTIVE IS READ FROM THE RAW FILE. `"use server"` is a
   * string literal, and the stripper has just turned it into `""`.
   */
  const firstRaw = (readRaw(full).split("\n").find((l) => l.trim()) ?? "").trim();
  if (firstRaw !== '"use server";') continue;

  /**
   * ⚠️ IMPORTS ARE PARSED FROM THE RAW FILE AND GUARDS FROM THE STRIPPED
   * ONE, and mixing the two up cost a round trip.
   *
   * The stripper turns every string literal into `""` — including
   * `from "@/server/views/definitions"`. Parsing imports out of the
   * stripped text found none, so the delegation hop stopped working and
   * the gate reported forty extra unguarded endpoints across
   * `views.ts`, `workflows.ts` and `dynamic-objects.ts`, all of which
   * delegate correctly.
   *
   * ⭐ THE TWO PASSES WANT OPPOSITE THINGS. Guard detection must not see
   * strings; import resolution is nothing but strings.
   */
  const imports = serverImports(readRaw(full));
  const localFunctions = allFunctionBodies(source);
  const constMap = permissionConsts(readRaw(full));

  for (const { name, body } of functionBodies(source)) {
    checked += 1;
    const key = `${fileName}#${name}`;

    if (Object.prototype.hasOwnProperty.call(ALLOWED, key)) {
      allowedUsed.add(key);
      continue;
    }

    const inlineTier = has(body, TIER2) ? 2 : has(body, TIER1) ? 1 : 0;
    let tier = inlineTier;
    let mutates = writes(body);
    let via = null;
    /** Bodies whose permission arguments count for this endpoint. */
    const guardBodies = [body];

    /* ---- ONE HOP ------------------------------------------------- */
    /**
     * ⚠️ THE WRITE CLASSIFICATION IS INHERITED FROM A CALLEE ONLY WHEN
     * THE ACTION IS A PURE DELEGATE — no guard of its own at all.
     *
     * 🔴 THE FIRST VERSION INHERITED IT ALWAYS, and reported
     * `variations.ts#listVariations` — a read whose whole body is a
     * SELECT — as a mutation behind an identity check. It calls a shared
     * helper that CAN write, and the gate concluded that it therefore
     * does.
     *
     * ⭐ THAT IS THE FALSE POSITIVE THAT KILLS A GATE. It is specific,
     * it is confidently worded, and the "fix" is to put a permission
     * check on a list endpoint — which would lock people out of a screen
     * to satisfy a script that was wrong. A gate people learn to
     * override is worse than no gate, and it is earned in exactly this
     * way.
     */
    const pureDelegate = inlineTier === 0;

    const consider = (calleeBody, label) => {
      if (!calleeBody) return;
      if (pureDelegate && writes(calleeBody)) mutates = true;
      const calleeTier = has(calleeBody, TIER2) ? 2 : has(calleeBody, TIER1) ? 1 : 0;
      if (calleeTier > tier) {
        tier = calleeTier;
        via = label;
        /**
         * ⚠️ The delegate's permission argument is the one that counts.
         * A local `transition(input, "cancelled", "sales.orders.cancel")`
         * carries its key at the CALL site, and the guard lives in the
         * helper — so the read/write assertion below has to see both.
         */
        guardBodies.push(calleeBody);
      }
    };

    if (tier < 2) {
      /* ---- HOP ①: a helper in THIS file --------------------------- */
      /**
       * ⭐⭐ THE PATTERN THIS EXISTS FOR IS THE BEST ONE IN THE
       *    CODEBASE, AND THE FIRST VERSION OF THIS GATE PUNISHED IT.
       *
       * `orders.ts` funnels cancel, hold, release and close through one
       * local `transition()` helper that takes the permission as a
       * parameter. So does `variations.ts`. That is strictly better than
       * four copies of the same guard — there is one place the rule
       * lives and one place to get it wrong.
       *
       * The gate reported all eight of those functions as asking nothing
       * about their caller, because the guard was one call away in a
       * function that is not exported and therefore not imported.
       *
       * ⚠️ EIGHT CONFIDENT FINDINGS AGAINST THE MOST DISCIPLINED CODE
       * IN THE REPO. Acting on them would have meant unpicking a shared
       * helper into four duplicated checks to satisfy a script.
       */
      for (const [localName, localBody] of localFunctions) {
        if (localName === name) continue;
        if (!new RegExp(`\\b${localName}\\s*\\(`).test(body)) continue;
        consider(localBody, `${fileName}#${localName} (local helper)`);
      }
    }

    if (tier < 2) {
      /* ---- HOP ②: a function imported from `@/server/...` --------- */
      for (const [local, target] of imports) {
        if (!new RegExp(`\\b${local}\\s*\\(`).test(body)) continue;
        const resolved = resolveModule(target.module);
        if (!resolved) continue;
        consider(
          bodiesOf(resolved).get(target.real),
          `${relative(ROOT, resolved)}#${target.real}`,
        );
      }
    }

    if (tier === 0) {
      fail(
        `${key} is a public endpoint and asks NOTHING about who is calling it. ` +
          `Add a guard, or add an allowlist entry saying why it cannot have one.`,
      );
      continue;
    }

    if (mutates && tier < 2) {
      fail(
        `${key} MUTATES data behind an identity check only. ` +
          `${TIER1.join("/")} answers "who are you", not "may you do this" — so any member ` +
          `of the workspace can call this. Use a tier-2 guard (${TIER2.slice(0, 3).join(", ")}).`,
      );
      continue;
    }

    /**
     * 🔴 A WRITE BEHIND A READ KEY.
     *
     * Only fires when the endpoint mutates, a tier-2 guard was found,
     * at least one permission key could be resolved, and EVERY resolved
     * key is read-shaped. If any key is a write key the endpoint is
     * fine; if none could be resolved (a `requireRole` guard, say) this
     * says nothing rather than guessing.
     */
    if (mutates && tier === 2) {
      const keys = guardBodies.flatMap((b) => permissionKeysIn(b, constMap));
      if (keys.length > 0 && keys.every((k) => READ_SHAPED.test(k))) {
        fail(
          `${key} MUTATES data but every permission it requires is a READ key ` +
            `(${keys.join(", ")}). A read permission on a write is how ` +
            `\`exportWorkspace\` ended up reachable by the read-only role. Use a ` +
            `write-side key, or add an allowlist entry saying why the read key is right.`,
        );
        continue;
      }
    }

    if (via) delegated += 1;
    if (tier === 2) tier2Count += 1;
    else tier1Reads += 1;
  }
}

/* ------------------------------------------------------------------ */
/* THE ALLOWLIST MUST NOT ROT                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A STALE EXEMPTION IS WORSE THAN NO EXEMPTION. It reads as a
 * considered decision and is actually a function somebody renamed.
 */
for (const key of Object.keys(ALLOWED)) {
  if (!allowedUsed.has(key)) {
    fail(
      `The allowlist exempts ${key}, which no longer exists. Remove the entry — a stale ` +
        `exemption reads as a decision and is a rename.`,
    );
  }
}

/* ------------------------------------------------------------------ */

console.log("");
if (failures === 0) {
  console.log(
    `✅ Action guards intact — ${checked} public endpoints, ${tier2Count} authorisation-checked, ` +
      `${tier1Reads} identity-checked reads, ${delegated} guarded one hop away, ` +
      `${Object.keys(ALLOWED).length} declared exemptions.`,
  );
  process.exit(0);
}

console.error("");
console.error(`❌ check:guards FAILED — ${failures} problem${failures === 1 ? "" : "s"}.`);
console.error(
  "   Every export of a `use server` module is a URL. One that does not ask who is " +
    "calling it is an unauthenticated endpoint.",
);
process.exit(1);
