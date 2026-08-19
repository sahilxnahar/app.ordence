#!/usr/bin/env node
/**
 * Ordence , CI GATE 25: A SEALED PRIVILEGE MUST NEVER BE GRANTED
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BUG THIS GATE WAS WRITTEN THE DAY AFTER
 * ══════════════════════════════════════════════════════════════════════
 * The application role could delete six months of security history.
 *
 * `prune_security_events()` is SECURITY DEFINER and is the one sanctioned
 * way past the append-only trigger on `security_events`. 0012 refused it
 * to `ordence_app` and said so, in a comment inside the grant block:
 *
 *     -- Explicitly NOT granted: EXECUTE on prune_security_events(). The
 *     -- web application must not be able to delete security history
 *     -- under any circumstances, including via a function that is
 *     -- allowed to.
 *
 * 0087_hardening_narrow_grants.sql, line 282, seventy-five files later:
 *
 *     GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean)  TO ordence_app;
 *
 * 0087 revoked EXECUTE on all functions from PUBLIC , correct and
 * overdue , and re-granted the thirty the application calls, with the
 * method in its own comment: "Signatures copied verbatim from the modules
 * that GRANT them." Twenty-nine of those thirty are granted by their
 * module to `ordence_app`. This one is granted to `ordence_maintenance`.
 * The signature was copied; the role was not read.
 *
 * ⚠️ THE LINE IS INDISTINGUISHABLE FROM ITS NEIGHBOURS. That is why
 * review did not catch it and why no amount of care would reliably catch
 * the next one. 0012 even shipped a verification query for exactly this
 * case , it prints "*** FAIL: the web application can delete security
 * history ***" , and it never fired, because it lives in 0012 and the
 * regression arrived in 0087. Nobody re-runs an old file's SELECTs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SO: A REFUSAL IS A DECLARATION, NOT A COMMENT
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/sealed-grants.json` lists (role, object, privilege) triples
 * that must never be granted. This gate reads every .sql file in the
 * repository and fails the build on any GRANT that matches , whatever
 * file it is in, however many waves later, however ordinary it looks.
 *
 * The gate is static. It needs no database, so it runs on every push,
 * which is the entire point: the database check in 0012 was correct and
 * ran once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THE MATCHER MUST AND MUST NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * MUST match, because these are all real grants:
 *     GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean) TO ordence_app;
 *     GRANT EXECUTE ON FUNCTION public.prune_security_events(int, bool) TO ordence_app;
 *     GRANT ALL     ON FUNCTION prune_security_events(integer, boolean) TO ordence_app;
 *     GRANT SELECT, DELETE ON security_events TO ordence_app;
 *     GRANT EXECUTE ON FUNCTION x() TO ordence_maintenance, ordence_app;
 *
 * MUST NOT match, because these are not:
 *     -- GRANT EXECUTE ON FUNCTION prune_security_events(...) TO ordence_app;   (comment)
 *     REVOKE EXECUTE ON FUNCTION prune_security_events(...) FROM ordence_app;
 *     GRANT EXECUTE ON FUNCTION prune_security_events(...) TO ordence_maintenance;
 *     'GRANT EXECUTE ... TO ordence_app'   inside a string literal in a NOTICE
 *
 * The comment case is the one that matters most, because the seal's own
 * documentation quotes the offending line, and a matcher that cannot tell
 * documentation from code would fail on the file that fixes the bug.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAL_FILE = join(ROOT, "scripts", "sealed-grants.json");

/* ────────────────────────────────────────────────────────────────────
 * 1. STRIP COMMENTS AND STRING LITERALS
 *
 * Not a full SQL parser and it does not need to be. It needs to know
 * that text inside `--`, `/* … *​/`, `'…'` and `$tag$ … $tag$` is not a
 * statement. Dollar-quoted bodies are KEPT, because a DO block can
 * legitimately contain `EXECUTE format('GRANT …')` and that is a real
 * grant , so only the single-quoted string inside it is blanked, which
 * is handled by the ordinary quote rule.
 * ──────────────────────────────────────────────────────────────────── */
function stripNonCode(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const two = sql.slice(i, i + 2);

    // line comment
    if (two === "--") {
      while (i < n && sql[i] !== "\n") {
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // block comment, nestable in PostgreSQL
    if (two === "/*") {
      let depth = 1;
      i += 2;
      out += "  ";
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth += 1; out += "  "; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { depth -= 1; out += "  "; i += 2; continue; }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // single-quoted literal, '' escapes
    if (sql[i] === "'") {
      out += " ";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "  "; i += 2; continue; }
        if (sql[i] === "'") { out += " "; i += 1; break; }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }

    // dollar quote: keep the body, blank only the delimiters
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      out += " ".repeat(tag.length);
      i += tag.length;
      const close = sql.indexOf(tag, i);
      const bodyEnd = close === -1 ? n : close;
      // ⚠️ RECURSE. The body of a DO block is ordinary SQL and contains
      // ordinary `--` comments. Copying it verbatim was the first version
      // of this function and it reported the fix for the bug as the bug:
      // 0087's replacement comment QUOTES the offending GRANT, inside a
      // DO block, and an un-stripped body matched it.
      out += stripNonCode(sql.slice(i, bodyEnd));
      i = bodyEnd;
      if (close !== -1) { out += " ".repeat(tag.length); i += tag.length; }
      continue;
    }

    out += sql[i];
    i += 1;
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────
 * 2. FIND THE GRANTS
 * ──────────────────────────────────────────────────────────────────── */

/** GRANT <privs> ON [FUNCTION|TABLE|…] <object> TO <roles> */
const GRANT_RE =
  /\bGRANT\s+([\s\S]{1,400}?)\s+\bTO\s+([A-Za-z_][\w",\s]*?)\s*(?:WITH\s+GRANT\s+OPTION\s*)?;/gi;

/** CREATE|ALTER ROLE <name> … BYPASSRLS|SUPERUSER (without NO in front) */
const ROLE_ATTR_RE =
  /\b(?:CREATE|ALTER)\s+ROLE\s+([A-Za-z_]\w*)\s+([\s\S]{0,300}?);/gi;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function rolesIn(clause) {
  return clause
    .split(",")
    .map((r) => r.trim().replace(/^"(.*)"$/, "$1").toLowerCase())
    .filter(Boolean);
}

/**
 * Does a GRANT body name this object?
 *
 * ⚠️ Word-boundary, not `includes`. `security_events` must not be found
 * inside `security_events_archive`, which is a different table with
 * different rules.
 */
function namesObject(body, object) {
  const re = new RegExp(`(^|[^\\w.])(?:[a-z_]\\w*\\.)?${object}\\b`, "i");
  return re.test(body);
}

function grantsPrivilege(body, privilege) {
  const head = body.split(/\bON\b/i)[0] ?? body;
  if (/\bALL\b/i.test(head)) return true;
  return new RegExp(`\\b${privilege}\\b`, "i").test(head);
}

/* ────────────────────────────────────────────────────────────────────
 * 3. WALK
 * ──────────────────────────────────────────────────────────────────── */

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "_superseded"]);

function sqlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) sqlFiles(full, acc);
    else if (entry.toLowerCase().endsWith(".sql")) acc.push(full);
  }
  return acc;
}

/* ────────────────────────────────────────────────────────────────────
 * 4. RUN
 * ──────────────────────────────────────────────────────────────────── */

let raw;
try {
  raw = JSON.parse(readFileSync(SEAL_FILE, "utf8"));
} catch (err) {
  console.error(`❌ cannot read ${relative(ROOT, SEAL_FILE)}: ${err.message}`);
  process.exit(1);
}

const seals = raw.seals ?? [];
if (seals.length === 0) {
  console.error("❌ scripts/sealed-grants.json declares no seals. An empty seal list is a gate that cannot fail.");
  process.exit(1);
}

for (const seal of seals) {
  for (const field of ["id", "role", "object", "privilege", "kind", "why"]) {
    if (!seal[field]) {
      console.error(`❌ seal ${seal.id ?? "(unnamed)"} is missing \`${field}\`.`);
      process.exit(1);
    }
  }
  if (String(seal.why).length < 40) {
    console.error(`❌ seal ${seal.id}: \`why\` is ${String(seal.why).length} characters. A seal nobody can justify is a seal somebody will delete.`);
    process.exit(1);
  }
}

const files = sqlFiles(ROOT);
const violations = [];

for (const file of files) {
  const rel = relative(ROOT, file);
  const original = readFileSync(file, "utf8");
  const code = stripNonCode(original);

  /* ---- object privileges ---- */
  for (const m of code.matchAll(GRANT_RE)) {
    const body = m[1] ?? "";
    const roles = rolesIn(m[2] ?? "");

    for (const seal of seals) {
      if (seal.kind === "role-attribute") continue;
      if (!roles.includes(seal.role.toLowerCase())) continue;
      if (!namesObject(body, seal.object)) continue;
      if (!grantsPrivilege(body, seal.privilege)) continue;

      violations.push({
        seal,
        file: rel,
        line: lineOf(code, m.index ?? 0),
        text: m[0].replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  }

  /* ---- role attributes ---- */
  for (const m of code.matchAll(ROLE_ATTR_RE)) {
    const role = (m[1] ?? "").toLowerCase();
    const attrs = m[2] ?? "";

    for (const seal of seals) {
      if (seal.kind !== "role-attribute") continue;
      if (role !== seal.role.toLowerCase()) continue;

      // NOBYPASSRLS / NOSUPERUSER are the CORRECT form and must not match.
      const re = new RegExp(`(^|[^\\w])(?<!NO)${seal.privilege}\\b`, "i");
      const cleaned = attrs.replace(/\bNO(BYPASSRLS|SUPERUSER)\b/gi, " ");
      if (!re.test(cleaned)) continue;

      violations.push({
        seal,
        file: rel,
        line: lineOf(code, m.index ?? 0),
        text: m[0].replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  }
}

console.log(`sealed-grants: ${seals.length} seal(s) checked against ${files.length} .sql file(s)`);

if (violations.length === 0) {
  console.log("✅ no sealed privilege is granted anywhere in the repository");
  process.exit(0);
}

console.error("");
console.error("🔴 A SEALED PRIVILEGE IS GRANTED.");
console.error("");

for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    ${v.text}`);
  console.error(`    seal      : ${v.seal.id}`);
  console.error(`    refuses   : ${v.seal.privilege} on ${v.seal.object} to ${v.seal.role}`);
  console.error(`    because   : ${v.seal.why}`);
  console.error(`    declared  : ${v.seal.declaredBy ?? "(unrecorded)"}`);
  console.error("");
}

console.error("If the seal is wrong, change scripts/sealed-grants.json and say why there.");
console.error("Do not change the .sql file to slip past the matcher.");
process.exit(1);
