/**
 * Ordence — ⭐⭐ SPLITTING A MIGRATION THE WAY THE CONSOLE SEES IT
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS MOVED OUT OF `run-sql-statement-per-connection.mjs`
 * ══════════════════════════════════════════════════════════════════════
 * Because `scripts/migrate.mjs` needs exactly the same splitter, and a
 * second copy of a parser that has to respect `$tag$ ... $tag$` bodies,
 * single-quoted strings with doubled quotes, line comments and nested
 * block comments is a second copy that will diverge on the day one of
 * them is fixed.
 *
 * ⚠️ THE SPLIT IS THE LOAD-BEARING PART OF BOTH TOOLS. A naive split on
 * ";" tears every `DO $$ ... $$` block in this repository in half , and a
 * DO block is precisely the construct the house rules require for any
 * statement that must be atomic, because `SET LOCAL` as its own
 * statement does not work in the Neon console.
 */

/**
 * ⚠️ SPLITS ON `;` AT DEPTH ZERO, respecting `$tag$ ... $tag$` bodies,
 * single-quoted strings and both comment forms. A naive split on ";" tears
 * every DO block in this repo in half — and a DO block is precisely the
 * construct the house rules require for any statement that must be atomic.
 */
export function splitStatements(src) {
  const out = [];
  let buf = "";
  let i = 0;
  let inLine = false;
  let inBlock = 0;
  let inStr = false;
  let dollar = null;

  while (i < src.length) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);

    if (inLine) { buf += c; if (c === "\n") inLine = false; i++; continue; }
    if (inBlock > 0) {
      buf += c;
      if (c2 === "/*") { inBlock++; buf += src[i + 1]; i += 2; continue; }
      if (c2 === "*/") { inBlock--; buf += src[i + 1]; i += 2; continue; }
      i++; continue;
    }
    if (dollar) {
      buf += c;
      if (src.startsWith(dollar, i)) { buf += src.slice(i + 1, i + dollar.length); i += dollar.length; dollar = null; continue; }
      i++; continue;
    }
    if (inStr) {
      buf += c;
      if (c === "'") { if (src[i + 1] === "'") { buf += "'"; i += 2; continue; } inStr = false; }
      i++; continue;
    }
    if (c2 === "--") { inLine = true; buf += c2; i += 2; continue; }
    if (c2 === "/*") { inBlock = 1; buf += c2; i += 2; continue; }
    if (c === "'") { inStr = true; buf += c; i++; continue; }

    const tag = /^\$[A-Za-z_0-9]*\$/.exec(src.slice(i));
    if (tag) { dollar = tag[0]; buf += tag[0]; i += tag[0].length; continue; }

    if (c === ";") { out.push(buf + ";"); buf = ""; i++; continue; }
    buf += c; i++;
  }
  if (buf.trim()) out.push(buf);

  const isBlank = (s) =>
    s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().length === 0;
  return out.map((s) => s.trim()).filter((s) => !isBlank(s));
}
