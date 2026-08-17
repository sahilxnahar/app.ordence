#!/usr/bin/env node
/**
 * Ordence — ⭐⭐ THE CONSOLE IS SERVED AT TWO BASE PATHS
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * The staff console is reachable two ways:
 *
 *   app.ordence.com/platform/tenants   ← the route that exists on disk
 *   admin.ordence.com/tenants          ← the console's own host, where
 *                                        middleware REWRITES /x to /platform/x
 *
 * Every link in the console was written as `/platform/...`. On the console
 * host that is NOT a rewritten path, so it fell through to tenant
 * resolution, redirected to `/dashboard`, which WAS rewritten to
 * `/platform/dashboard`, which does not exist. 404.
 *
 * ⚠️ THE CONSOLE THEREFORE LOADED PERFECTLY AND EVERY LINK IN IT WAS
 * BROKEN. Traced live in a browser against production. Nothing in the
 * build, the type-check or 4,467 tests saw it, because every individual
 * page is fine , it is only the navigation between them that fails, and
 * only on one of the two hosts.
 *
 * ⭐ THE RULE: inside `app/platform/**`, a link to another console page
 * goes through `consoleHref()`, which maps the canonical path onto
 * whatever this host serves.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIR = join(ROOT, "app", "platform");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const blank = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
   .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
   .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "));

const files = walk(DIR);
const problems = [];

for (const f of files) {
  const code = blank(readFileSync(f, "utf8"));
  for (const m of code.matchAll(/href=(?:"|\{")(\/platform[^"]*)"/g)) {
    problems.push({
      file: f.slice(ROOT.length + 1),
      line: code.slice(0, m.index).split("\n").length,
      href: m[1],
    });
  }
}

console.log("🔎 check:console-links");
console.log(`   ${files.length} files scanned in app/platform.`);

if (problems.length) {
  console.log(`\n❌ ${problems.length} hard-coded /platform link(s):\n`);
  for (const p of problems) console.log(`      ${p.file}:${p.line}  href="${p.href}"`);
  console.log(`
   On admin.ordence.com these do not resolve: the middleware rewrites
   /x to /platform/x, so a link already starting with /platform is not
   rewritten, falls through to tenant resolution, and lands on a 404.

   Use consoleHref("/platform/...", isConsole) from
   lib/platform/console-href.ts. In a client component, use a RELATIVE
   href instead , it resolves against whichever base the page is on.
`);
  process.exit(1);
}
console.log("✅ Every console link is host-aware.");
