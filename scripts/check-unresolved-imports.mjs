#!/usr/bin/env node
/**
 * Ordence , CI GATE 26: EVERY `@/` IMPORT RESOLVES TO A REAL FILE
 * Version: v1.81.0-alpha · Infra wave 13
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEPLOY THIS GATE WAS WRITTEN THE HOUR AFTER
 * ══════════════════════════════════════════════════════════════════════
 * A release archive was extracted into `components/` instead of at the
 * repository root. Every path in it landed one level too deep ,
 * `components/app/...`, `components/server/...`, `components/lib/...` ,
 * and the 213 real component files that had been in `components/` were
 * lost in the same operation.
 *
 * The commit was made, pushed, and Railway started a build. It failed:
 *
 *     Module not found: Can't resolve '@/components/budgets/budget-editor'
 *     Module not found: Can't resolve '@/components/accounting/close-board'
 *
 * ⚠️ WEBPACK REPORTED FIVE. THERE WERE 305. It stops early. So the first
 * error a human sees understates the damage by two orders of magnitude,
 * and fixing the five named files would have produced another failed
 * build, and another, and another.
 *
 * ⚠️ AND NOTHING ELSE IN THIS REPOSITORY WOULD HAVE CAUGHT IT.
 *   • `tsc --noEmit` runs against the tree as it is on disk, so it is
 *     clean on a correct tree and never sees the broken commit.
 *   • The 23 static gates read specific files for specific properties.
 *     None of them asks "does every import point at something".
 *   • The security and UI suites import what they import; a module that
 *     nothing under test imports is invisible to them.
 *   • `next build` catches it, and `next build` is the expensive last
 *     step that costs a failed deploy to learn from.
 *
 * ⭐ THIS GATE IS `next build`'s MODULE RESOLUTION, IN ISOLATION, IN
 * UNDER A SECOND. It is the cheapest possible place to learn that a file
 * is missing, and it runs on a laptop before a commit rather than on
 * Railway after a push.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT DOES AND DOES NOT CHECK
 * ══════════════════════════════════════════════════════════════════════
 * It resolves `@/...` specifiers only , the project alias for the repo
 * root. It does NOT check bare package imports (`react`, `drizzle-orm`):
 * those are `node_modules`, which is `npm ci`'s job and is a different
 * failure with a different fix. It does NOT check relative imports,
 * which a rename breaks locally and loudly.
 *
 * The alias set matches `tsconfig.json`'s `paths`. If that ever gains a
 * second alias, add it here , a resolver that silently ignores an alias
 * reports a clean tree it did not check.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css"];
const SKIP = new Set(["node_modules", ".git", ".next", "out", "dist", ".open-next", ".wrangler"]);

function walk(d, acc = []) {
  for (const e of readdirSync(d)) {
    if (SKIP.has(e)) continue;
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?|mjs)$/.test(e)) acc.push(p);
  }
  return acc;
}
/** does `base` resolve to a real module? */
function resolves(base) {
  if (existsSync(base) && statSync(base).isFile()) return true;
  for (const x of EXT) if (existsSync(base + x)) return true;
  for (const x of EXT) if (existsSync(join(base, "index" + x))) return true;
  return false;
}

const files = walk(ROOT);
const missing = new Map();
const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+["'](@\/[^"']+)["']|import\(\s*["'](@\/[^"']+)["']\s*\)/g;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    const base = join(ROOT, spec.slice(2));           // "@/x" -> ROOT/x
    if (resolves(base)) continue;
    if (!missing.has(spec)) missing.set(spec, []);
    missing.get(spec).push(f.replace(ROOT + "/", ""));
  }
}
console.log(`check:unresolved-imports , ${files.length} source files scanned`);
if (missing.size === 0) {
  console.log("✅ every @/ import resolves to a real file");
  process.exit(0);
}
console.error("");
console.error(`::error::${missing.size} unresolved @/ import(s). \`next build\` will fail on these.`);
console.error("");
for (const [spec, users] of [...missing].sort()) {
  console.error(`  ${spec}`);
  for (const u of users.slice(0, 3)) console.error(`      imported by ${u}`);
  if (users.length > 3) console.error(`      ...and ${users.length - 3} more`);
}
console.error("");
console.error("  ⚠️ webpack stops after the first few. This is the full list.");
process.exit(1);
