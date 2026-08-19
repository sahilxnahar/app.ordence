#!/usr/bin/env node
/**
 * Ordence — Server boundary census
 * Version: v0.84.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * A recursive `sed` was run across the tree to silence one build error:
 *
 *     find . -name '*.ts' -exec sed -i '' '/import "server-only";/d' {} +
 *
 * It stripped the guard from SIXTY-SIX files, including
 * `server/tenant-context.ts`, `server/billing/access.ts`,
 * `server/platform/guard.ts`, `server/audit.ts` and both payment
 * providers.
 *
 * ⚠️ EVERY EXISTING GATE STAYED GREEN. `tsc --noEmit` passed. `next
 * build` passed. The whole security test suite would have passed. The
 * guard has no runtime behaviour — it exists purely to make the BUILD
 * fail when a client component imports a server module. Removing it does
 * not break anything today; it removes the alarm that would tell you
 * about tomorrow.
 *
 * That is the worst shape a defect can take: a safety net deleted, with
 * no symptom until the day it was needed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS CHECKS
 * ══════════════════════════════════════════════════════════════════════
 * 1. Every module that reaches the database, the session, or request
 *    headers declares EITHER `import "server-only"` OR `"use server"`.
 * 2. No `"use client"` file imports a `server-only` module — the exact
 *    fault that broke the Railway build in v0.83.0.
 * 3. A `"use server"` file exports only async functions, because every
 *    export in one is a public HTTP endpoint.
 *
 * Exits non-zero on any violation. Runs in milliseconds, needs no
 * database, and is the cheapest check in the repo.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
let failures = 0;
const fail = (msg) => {
  console.error(`::error::${msg}`);
  failures++;
};

/* ------------------------------------------------------------------ */

/**
 * ⚠️ TEST SCRATCH FILES ARE SKIPPED UNLESS A TEST ASKS FOR THEM, AND BOTH
 *    HALVES OF THAT SENTENCE ARE LOAD-BEARING.
 *
 * 🔴 THE INCIDENT. `tests/ui/dpdp-inventory.test.ts` and
 * `tests/ui/boundary-rule-4.test.ts` each write a deliberately-bad file
 * into the source tree to prove their gate CATCHES it, then delete it.
 * Run the suite and the gates at the same time — which anybody doing
 * `npm test & npm run check:*` will, and which I did — and the gate scans
 * the other's scratch file and fails on a table that does not exist.
 *
 * ⚠️ IT LOOKS EXACTLY LIKE A REAL FAILURE. It names a plausible table
 * (`global_newsletter_signups`), it cites a real rule, and it goes away
 * on a re-run. A red gate that passes on retry is a gate people learn to
 * re-run instead of read, which is how a real failure gets clicked past.
 *
 * 🔴 AND THE OBVIOUS FIX — SKIP `__` FILES ALWAYS — IS WRONG, WHICH THOSE
 * TESTS PROVED IMMEDIATELY BY FAILING. Skipping them unconditionally
 * means the gate can no longer be shown to fire at all, and a check
 * nobody can demonstrate catching anything is a check nobody should
 * believe. The tests set `ORDENCE_GATE_FIXTURES=1`; nothing else does.
 */
const SCAN_FIXTURES = process.env.ORDENCE_GATE_FIXTURES === "1";
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (!SCAN_FIXTURES && entry.includes("__")) continue;
    if (entry === "node_modules" || entry === ".next" || entry.startsWith("._")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ["server", "lib", "db", "components", "app"]
  .filter((d) => {
    try {
      return statSync(join(ROOT, d)).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap((d) => walk(join(ROOT, d)));

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => relative(ROOT, f);

const firstLine = (src) => (src.split("\n").find((l) => l.trim()) ?? "").trim();
const isServerOnly = (src) => /^import "server-only";$/m.test(src);
const isUseServer = (src) => firstLine(src) === '"use server";';
const isUseClient = (src) => firstLine(src) === '"use client";';

/* ------------------------------------------------------------------ */
/* 1. MODULES THAT TOUCH PRIVILEGED THINGS MUST DECLARE A BOUNDARY     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Import-based, not name-based. A file is privileged because of what
 * it PULLS IN, not because of where it sits — `lib/ai/client.ts` reaches
 * the database and is as sensitive as anything under `server/`.
 *
 * ⚠️ `@/db/schema` IS DELIBERATELY ABSENT, AND THIS COST A FALSE-POSITIVE
 * SWEEP TO LEARN. The first version of this check flagged 30+ files in
 * `lib/` — `entitlements/features.ts`, `gst/gstin.ts`, `receivables/
 * interest.ts` — every one of which imports the schema for TYPES:
 *
 *     import type { PlanTier } from "@/db/schema/core";
 *
 * A type import is erased at compile time. It opens no connection, reads
 * no session, and ships nothing to a browser. Those files are pure
 * calculation — GST arithmetic, interest, seat maths — and are correctly
 * importable from anywhere.
 *
 * Demanding a boundary on them would have meant adding `server-only` to
 * thirty innocent modules, which is how a check trains people to silence
 * it. What is actually privileged is the CLIENT (`@/db`), the request
 * (`next/headers`), the session (`@clerk/nextjs/server`) and the secrets
 * (`@/lib/env`).
 */
const PRIVILEGED_IMPORTS = [
  // `@/db` exactly — NOT `@/db/schema`, which is table definitions only.
  /from "@\/db"/,
  /from "next\/headers"/,
  /from "@clerk\/nextjs\/server"/,
  /from "@\/lib\/env"/,
];

/**
 * `import type { X } from "@/db"` is also erased. Only a value import
 * actually pulls the client in.
 */
const stripTypeImports = (src) =>
  src.replace(/^\s*import\s+type\s+[^;]+;$/gm, "");

for (const f of files) {
  const src = read(f);
  const r = rel(f);

  // Route handlers and pages are server components by construction; Next
  // guarantees they never reach a client bundle.
  if (/\/(route|page|layout|error|not-found|template|loading)\.tsx?$/.test(r)) continue;
  // Config, tests and type declarations are not runtime modules.
  if (/^(tests|scripts|types)\//.test(r) || r.endsWith(".d.ts")) continue;

  const runtime = stripTypeImports(src);
  const privileged = PRIVILEGED_IMPORTS.some((p) => p.test(runtime));
  if (!privileged) continue;

  if (isUseClient(src)) {
    fail(
      `${r} is "use client" but imports a privileged module (db / next-headers / clerk-server). ` +
        `Move the logic to a "use server" action and call that instead.`,
    );
    continue;
  }

  if (!isServerOnly(src) && !isUseServer(src)) {
    fail(
      `${r} reaches the database or session but declares no boundary. ` +
        `Add \`import "server-only";\` (an internal module) or \`"use server";\` (a callable action).`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 2. NO CLIENT COMPONENT MAY IMPORT A `server-only` MODULE            */
/* ------------------------------------------------------------------ */

/**
 * This is the fault that actually broke the production build:
 *
 *     components/platform/user-actions.tsx   ("use client")
 *       -> server/platform/users.ts          (server-only)
 *          -> server/platform/guard.ts       (server-only + next/headers)
 *
 *     x You're importing a component that needs "server-only".
 *     > Build failed because of webpack errors
 *
 * `next build` does catch it — but only after a full production build,
 * which on Railway means finding out at deploy time. This catches it in
 * under a second.
 */
const boundaryOf = new Map();
for (const f of files) {
  const src = read(f);
  boundaryOf.set(
    "@/" + rel(f).replace(/\.tsx?$/, ""),
    isUseServer(src) ? "use-server" : isServerOnly(src) ? "server-only" : "plain",
  );
}

for (const f of files) {
  const src = read(f);
  if (!isUseClient(src)) continue;

  for (const m of src.matchAll(/from "(@\/[^"]+)"/g)) {
    if (boundaryOf.get(m[1]) === "server-only") {
      fail(
        `${rel(f)} is "use client" and imports ${m[1]}, which is server-only. ` +
          `Import the "use server" wrapper instead — see components/platform/user-actions.tsx.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. A `"use server"` FILE EXPORTS ONLY ASYNC FUNCTIONS               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Every export in a `"use server"` file is published as a callable
 * HTTP endpoint with a stable action id. Exporting a constant publishes
 * that constant; exporting a non-async function fails the production
 * build. `server/platform/actions.ts` states this rule in its own header
 * — this enforces it.
 */
for (const f of files) {
  const src = read(f);
  if (!isUseServer(src)) continue;

  for (const m of src.matchAll(/^export\s+(?!async function|type|interface|\{)(\w+)/gm)) {
    // `export const`/`export function` in a "use server" file is the fault.
    if (m[1] === "const" || m[1] === "function" || m[1] === "let" || m[1] === "var") {
      fail(
        `${rel(f)} is "use server" but has a non-async export (\`export ${m[1]}\`). ` +
          `Every export becomes a public endpoint — move it to lib/.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. ⭐ NO `"use server"` EXPORT MAY ACCEPT A TENANT                   */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THIS RULE EXISTS BECAUSE RULE 3 WAS NOT ENOUGH, AND v005 PROVED IT.
 *
 * `server/actions/notifications.ts` obeyed rule 3 perfectly — every
 * export was an async function, and its own header said so. It was still
 * a cross-tenant write endpoint reachable from a browser:
 *
 *     export async function createNotification(input: {
 *       tenantId: string;          // <- from the caller
 *       ...
 *     }) {
 *       await withTenant(input.tenantId, ...)   // <- used directly
 *
 * Row-level security enforces the tenant THE TRANSACTION DECLARES. A
 * function that lets its caller declare it is the single route past RLS,
 * and that one was published as an endpoint. Any authenticated session
 * could write a notification into another workspace — and at severity
 * `critical`, email every active user of it.
 *
 * ⭐ THE RULE AS WRITTEN IN RULE 3 IS NECESSARY BUT NOT SUFFICIENT. The
 *    missing half is: **and no export takes the tenant as a parameter.**
 *    That half is mechanically checkable, so it is checked here.
 *
 * ⚠️ WHAT THIS CANNOT SEE. It reads the SIGNATURE only. An action whose
 * parameter is a named type declared elsewhere, and that type contains
 * `tenantId`, will pass. That is a real gap and it is not worth closing
 * with a regex — it needs the type checker. The inline form is what the
 * v005 bug looked like and what a hurried edit produces, so this catches
 * the shape that actually occurs.
 *
 * ⚠️ AND THE FIX IS NEVER "add a check inside the function". It is to
 * move the function to an `import "server-only"` module, which rule 1
 * then covers — exactly what `server/notifications/create.ts`,
 * `server/credit/position.ts` and `server/invoicing/documents.ts` are.
 */
/**
 * ⚠️ `server/platform/` IS EXEMPT, AND THIS IS THE MOST IMPORTANT
 *    PARAGRAPH IN THE FILE, BECAUSE AN EXEMPTION IS HOW A CHECK DIES.
 *
 * There are TWO tenancy models in this codebase and they are opposites:
 *
 *   TENANT actions  — the tenant comes from the SESSION
 *                     (`requireTenantContext()` → `withTenant()`).
 *                     A caller-supplied tenant is the v005 bug.
 *
 *   PLATFORM actions — the tenant is the SUBJECT of the operation.
 *                     `admin.ordence.com` exists to act ON a named
 *                     workspace: suspend it, change its plan, revoke an
 *                     impersonation. `tenantId` is not a leak here, it is
 *                     the argument. Their gate is
 *                     `capabilityOrStepUp()` from `server/platform/
 *                     guard.ts`, and they use `withPlatformScope()`.
 *
 * ⭐ SO THE EXEMPTION IS PAIRED WITH A COMPENSATING CHECK, BELOW: a
 *    platform action file may not call `withTenant(`. If one ever does,
 *    it has stopped being a platform action and is operating inside a
 *    tenant with a tenant id it was handed — which is the v005 bug
 *    wearing a platform badge, and the exemption would have hidden it.
 */
const isPlatformAction = (f) => rel(f).startsWith("server/platform/");

for (const f of files) {
  const src = read(f);
  if (!isUseServer(src)) continue;

  if (isPlatformAction(f)) {
    if (/\bwithTenant\s*\(/.test(src)) {
      fail(
        `${rel(f)} is a platform action file and calls withTenant(). Platform actions are ` +
          `exempt from the tenant-parameter rule because the tenant is their SUBJECT — but ` +
          `that exemption assumes they use withPlatformScope(). Calling withTenant() with a ` +
          `caller-supplied tenant is the v005 bug with a platform badge on.`,
      );
    }
    continue;
  }

  /**
   * ⚠️ `[^)]*` AND NOT `[\s\S]*?`, AND THE DIFFERENCE MATTERS.
   *
   * The first draft of this rule used a lazy `[\s\S]*?` terminated by
   * `)\s*:`. On an action written `foo(input: unknown) {` — no return
   * type — there is no `):` to stop at, so the match ran FORWARD through
   * the file until it found one, swallowing several functions and
   * reporting the violation against the wrong name. It named
   * `listTenantsAction`, which takes `input: unknown` and is blameless.
   *
   * A check that reports the wrong file is worse than no check: somebody
   * opens it, sees nothing wrong, and learns to distrust the checker.
   */
  for (const m of src.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)) {
    const [, name, params] = m;
    if (/\btenantId\b/.test(params)) {
      fail(
        `${rel(f)} is "use server" and its export \`${name}()\` accepts \`tenantId\`. ` +
          `Every export here is a browser-reachable endpoint, so this lets a caller choose ` +
          `which workspace to operate on — the one route past row-level security. ` +
          `Move it to a module with \`import "server-only"\` and derive the tenant from ` +
          `requireTenantContext(). See server/notifications/create.ts.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */

const guarded = files.filter((f) => isServerOnly(read(f))).length;
const actions = files.filter((f) => isUseServer(read(f))).length;

if (failures > 0) {
  console.error(`\n❌ Server boundary census FAILED — ${failures} violation(s).\n`);
  process.exit(1);
}

console.log(
  `✅ Server boundaries intact — ${guarded} server-only modules, ${actions} action modules, ` +
    `${files.length} files scanned.`,
);
