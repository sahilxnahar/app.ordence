#!/usr/bin/env node
/**
 * Ordence — ⭐⭐ A SERVER COMPONENT MAY NOT CALL A CLIENT HOOK
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `app/layout.tsx` imported `useUtmReport` from a `"use client"` module
 * and called it inside a small wrapper declared in the layout itself:
 *
 *     function UtmCapture() { useUtmReport(); return null; }
 *
 * That looks like a client component and is not. A function declared in
 * a server module is server code, wherever the hook it calls lives. At
 * render time React threw:
 *
 *     Attempted to call useUtmReport() from the server but useUtmReport
 *     is on the client.
 *
 * ⚠️ AND IT WAS THE ROOT LAYOUT, so it was not one broken page. Every
 * route in the product returned 500 , the customer app and the staff
 * console , while `/api/health` stayed 200 and the deployment looked
 * healthy. The Railway build passed. Every gate passed. It surfaced only
 * in Sentry, after real requests.
 *
 * ⭐ THE CHECK IS TRIVIAL AND STATIC. A file WITHOUT `"use client"` may
 * not import an identifier beginning `use` from a file WITH it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = process.cwd();
const exts = [".ts", ".tsx"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const blank = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
   .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const isClient = (src) => /^\s*['"]use client['"]/.test(src);

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const e of exts) {
    for (const cand of [base + e, join(base, "index" + e)]) {
      try { if (statSync(cand).isFile()) return cand; } catch {}
    }
  }
  return null;
}

const files = [
  ...walk(join(ROOT, "app")),
  ...walk(join(ROOT, "components")),
];

const clientCache = new Map();
const isClientFile = (f) => {
  if (!clientCache.has(f)) {
    try { clientCache.set(f, isClient(readFileSync(f, "utf8"))); }
    catch { clientCache.set(f, false); }
  }
  return clientCache.get(f);
};

const problems = [];
for (const f of files) {
  const raw = readFileSync(f, "utf8");
  if (isClient(raw)) continue;               // client file: hooks are fine
  const code = blank(raw);
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveImport(f, m[2]);
    if (!target || !isClientFile(target)) continue;
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/i).pop().trim();
      if (!/^use[A-Z]/.test(name)) continue;
      // Only a finding if the hook is actually CALLED in this file.
      if (!new RegExp(`\\b${name}\\s*\\(`).test(code)) continue;
      problems.push({
        file: f.slice(ROOT.length + 1),
        line: code.slice(0, m.index).split("\n").length,
        name,
        from: m[2],
      });
    }
  }
}

console.log("🔎 check:client-hooks");
console.log(`   ${files.length} files scanned in app/ and components/.`);

if (problems.length) {
  console.log(`\n❌ ${problems.length} server module(s) call a client hook:\n`);
  for (const p of problems) {
    console.log(`      ${p.file}:${p.line}  calls ${p.name}() imported from "${p.from}"`);
  }
  console.log(`
   A file without "use client" is server code, and a wrapper component
   declared inside it is server code too. Move the wrapper into the
   "use client" module and render it as a child.

   This throws at REQUEST time, not build time. In a layout it is a 500
   on every route while the deployment reports healthy.
`);
  process.exit(1);
}
console.log("✅ No server module calls a client hook.");
