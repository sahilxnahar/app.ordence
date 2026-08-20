#!/usr/bin/env node
/**
 * Ordence — Track F · IS `lib/cache` ACTUALLY REACHED?
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS GATE EXISTS TO FAIL ON MY OWN WORK
 * ══════════════════════════════════════════════════════════════════════
 * The defect this repository keeps producing is a module that was built,
 * documented, reviewed — and never called. Twenty-three instances across
 * twelve audits. `lib/redis.ts` is one of them right now: `cacheGet`,
 * `cacheSet` and `tenantKey` have existed since v0.1.0-alpha with ZERO
 * production callers. `lib/pagination.ts` is another: a complete
 * cursor-pagination contract, 344 lines, whose only importer renders two
 * of its constants to the customer as prose.
 *
 * `lib/cache/**` is Track F's contribution and it starts life in exactly
 * that state, BY CONSTRUCTION: every place that should call it —
 * `server/gst/registry.ts`, `server/actions/accounting.ts`,
 * `server/entitlements.ts` — belongs to another track's file ownership,
 * so Track F cannot wire it up. `PATCH-REQUEST-F.md` asks for the first
 * call site.
 *
 * ⚠️ SO THIS GATE SHIPS RED, ON PURPOSE, AND SAYS WHY.
 *
 * It is NOT registered in `scripts/gates.mjs` — that file is shared and
 * Track F does not own it — so it does not break anybody's CI today.
 * PATCH-REQUEST-F.md asks integration to register it AFTER the first
 * call site lands. At that moment it turns green and starts doing its
 * real job: making it impossible for the cache to be quietly removed
 * from the request path and become the twenty-fourth instance.
 *
 * Exit 0 · the cache has production callers.
 * Exit 1 · it does not, or it lost the ones it had.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEARCH = ["server", "app", "components", "lib"];
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);

/**
 * ⚠️ `lib/cache` ITSELF DOES NOT COUNT AS A CALLER. Its files import each
 * other; counting those would make this gate green on the day the module
 * was written, which is the day it was least reached.
 */
const SELF = join(ROOT, "lib", "cache");

if (!existsSync(join(ROOT, "lib", "cache", "index.ts"))) {
  console.error(`\n🔴 lib/cache/index.ts does not exist. Nothing to check.\n`);
  process.exit(1);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const files = SEARCH.flatMap((d) => walk(join(ROOT, d)));

/**
 * ⚠️ IMPORTING IS NOT CALLING, and the distinction is the entire point.
 * `lib/pagination.ts` HAS an importer — a settings page that renders two
 * of its constants as text. That importer is why nobody noticed the
 * module was dead. So an import only counts when the file also calls one
 * of the functions that actually reaches Redis.
 */
const CALLS = /\b(cached|cacheRead|cacheWrite|invalidateTenant|invalidate)\s*\(/;

const importers = [];
const callers = [];

for (const f of files) {
  if (f.startsWith(SELF)) continue;
  const src = readFileSync(f, "utf8");
  if (!/from\s+["']@\/lib\/cache/.test(src)) continue;
  const rel = relative(ROOT, f);
  importers.push(rel);
  if (CALLS.test(src)) callers.push(rel);
}

console.log(`\nCache adoption\n`);
console.log(`  files importing @/lib/cache : ${importers.length}`);
console.log(`  files that also CALL it     : ${callers.length}`);
for (const c of callers) console.log(`      ✅ ${c}`);
for (const i of importers.filter((x) => !callers.includes(x))) {
  console.log(`      ⚠️  ${i}  — imports but never calls`);
}

if (callers.length === 0) {
  console.error(
    `\n🔴 lib/cache has ZERO production callers.\n\n` +
      `   This is expected TODAY and it is not acceptable indefinitely. Track F owns\n` +
      `   lib/cache/** and none of the call sites; the first one is requested in\n` +
      `   PATCH-REQUEST-F.md:\n\n` +
      `       server/gst/registry.ts:156 and :182 — two withTenant transactions per\n` +
      `       INVOICE LINE to resolve an HSN rate that changes on GST Council\n` +
      `       notification. The "hsn-rate" namespace exists for exactly this.\n\n` +
      `   Until that lands, lib/cache is a module that was built and is not reached —\n` +
      `   the twenty-fourth instance of this repository's characteristic defect, and\n` +
      `   the only honest thing to do is say so in red.\n`,
  );
  process.exit(1);
}

console.log(`\n✅ lib/cache is reached from ${callers.length} production file(s).\n`);
