#!/usr/bin/env node
/**
 * Ordence — ⭐⭐ THE GATE THAT WOULD HAVE CAUGHT THE RAILWAY BUILD FAILURE
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `app/api/webhooks/clerk/route.ts` exported three handler functions so a
 * sibling module could re-export them for the evidence tests. Next.js
 * refuses that:
 *
 *     Type error: Route "app/api/webhooks/clerk/route.ts" does not match
 *     the required types of a Next.js Route.
 *       "handleUserCreated" is not a valid Route export field.
 *
 * ⚠️ AND EVERY GATE IN THIS REPOSITORY WAS GREEN WHEN IT SHIPPED.
 * `tsc --noEmit` passed. All 4,467 tests passed. Fifteen checks passed.
 * The rule is enforced by types Next.js GENERATES into `.next/types`
 * during `next build`, so it does not exist until a full production build
 * runs — and a full production build needs more memory than the machines
 * this project is developed on. The failure therefore surfaced for the
 * first time on Railway, after a push, as a red deploy.
 *
 * ⭐ THIS CHECK IS CHEAP AND STATIC. It reads the export statements of
 * every route file and compares them against the list Next.js accepts. It
 * needs no build, no types, and no memory.
 *
 * ⚠️ IT IS A SUBSET OF WHAT `next build` ENFORCES, AND SAYS SO. It cannot
 * check handler signatures or `params` shapes. It catches the one class
 * that has actually bitten this product: an export that is not a route.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/**
 * ⚠️ THIS LIST IS NEXT.JS'S, NOT OURS. Adding a name here to make a build
 * pass does not make Next.js accept it. If Next adds a field, add it here
 * with the version that introduced it.
 */
const ALLOWED = new Set([
  "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS",
  "runtime", "dynamic", "dynamicParams", "revalidate", "fetchCache",
  "preferredRegion", "maxDuration", "generateStaticParams",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "route.ts" || name === "route.tsx" || name === "route.js") out.push(p);
  }
  return out;
}

/** Blanks comments and strings so an export named in prose is not a finding. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m.replace(/[^\n]/g, " "));
}

function exportsOf(src) {
  const code = codeOnly(src);
  const found = [];
  const push = (n, i) => found.push({ name: n, line: code.slice(0, i).split("\n").length });

  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) push(m[1], m.index);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) push(m[1], m.index);
  for (const m of code.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) push(m[1], m.index);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const alias = part.split(/\s+as\s+/i).pop().trim();
      if (alias) push(alias, m.index);
    }
  }
  if (/export\s+default\b/.test(code)) push("default", code.search(/export\s+default\b/));
  if (/export\s*\*\s*from/.test(code)) push("* (star re-export)", code.search(/export\s*\*/));
  return found;
}

const files = walk(join(ROOT, "app"));
const problems = [];
for (const f of files) {
  const rel = f.slice(ROOT.length + 1);
  for (const e of exportsOf(readFileSync(f, "utf8"))) {
    if (!ALLOWED.has(e.name)) problems.push({ rel, ...e });
  }
}

console.log("🔎 check:route-exports");
console.log(`   ${files.length} route files scanned.`);

if (problems.length > 0) {
  console.log(`\n❌ ${problems.length} export(s) Next.js will refuse at build time:\n`);
  for (const p of problems) {
    console.log(`      ${p.rel}:${p.line}  "${p.name}" is not a valid Route export field`);
  }
  console.log(`
   A route file may export only the HTTP verbs and Next's config fields.
   Move the implementation into a sibling module whose name Next does not
   treat as a route (a leading underscore is the convention already used
   here, e.g. \`_webhook.ts\`), and let route.ts re-export the verb.

   This is a BUILD failure on Railway, not a warning: the deploy goes red
   and the previous version keeps serving.
`);
  process.exit(1);
}

console.log("✅ Every route file exports only what Next.js accepts.");
console.log("   ⚠️ Subset check: signatures and params shapes are still only");
console.log("      proved by a full `next build`.");
