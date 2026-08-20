#!/usr/bin/env node
/**
 * Ordence , GATE 28: A FAILURE MUST NEVER BE RECORDED AS A SUCCESS
 * Version: v1.82.0-alpha - Infra wave 14 (integration, track H)
 *
 * WHY
 * ---
 * The single most repeated defect in this codebase is not code that
 * crashes. It is code that fails and reports success. Four found so far:
 *
 *   - the billing gate grants access when the database is unreachable
 *   - `lockout.ts` cannot tell a failed write from a successful one
 *   - `tryEmitAutomationEvent` discards the reason it failed
 *   - a mail sender returned `true` without reading the SDK's result
 *
 * Each was written by somebody sensible and each looked fine in review.
 * They are invisible because the swallowing IS the bug: nothing throws,
 * nothing logs, and the happy path is indistinguishable from the sad one.
 *
 * WHAT THIS REFUSES
 * -----------------
 * In security-relevant files, a `catch` block that
 *
 *   (a) returns a permissive value , true, "allowed", "granted", ok:true
 *   (b) or is empty, or contains only a comment
 *
 * ...unless the block is DECLARED. Declaring means the word FAIL OPEN in
 * a comment inside the block, or an entry in `fail-open-registry.json`.
 *
 * ⚠️ IT DOES NOT BAN FAILING OPEN. Sometimes that is correct: the
 * billing gate fails open on purpose, because wrongly DENYING would take
 * every paying customer's workspace offline over one bad query, which is
 * a far larger blast radius than a few hours of unbilled access. That
 * decision is right and it is written down. The gate's job is to make
 * sure every such decision IS written down, so the deliberate ones stay
 * visible and the accidental ones cannot hide among them.
 *
 * EXIT  0 clean   1 an undeclared fail-open   78 EX_CONFIG
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

/** Where a swallowed failure has a security or money consequence. */
const SCOPES = [
  "lib/security", "lib/rbac", "lib/billing", "lib/email",
  "server/security", "server/billing", "server/automation",
  "server/notifications", "middleware.ts",
];

const REGISTRY_PATH = path.join(import.meta.dirname, "fail-open-registry.json");
const REGISTRY = fs.existsSync(REGISTRY_PATH)
  ? JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")).declared
  : [];

function walk(p, out = []) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) return out;
  if (fs.statSync(abs).isFile()) { out.push(p); return out; }
  for (const e of fs.readdirSync(abs)) walk(path.join(p, e), out);
  return out;
}

const files = SCOPES.flatMap((s) => walk(s)).filter((f) => /\.(ts|tsx|mts)$/.test(f) && !/\.test\./.test(f));

/** Permissive returns. `false` is fine: refusing on failure is the point. */
const PERMISSIVE = /return\s+(true\b|\{[^}]*\b(ok|allowed|granted|success|valid|permitted)\s*:\s*true)/;

/**
 * Character scan from an opening brace to its match, ignoring braces in
 * strings, template literals and comments.
 */
/** Replace comments and string bodies with spaces, preserving every offset. */
function blankNonCode(src) {
  const out = src.split("");
  let inS = null, inBlock = false, inLine = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === "\n") inLine = false; else out[i] = " "; continue; }
    if (inBlock) { if (c === "*" && n === "/") { out[i] = out[i + 1] = " "; i++; inBlock = false; } else if (c !== "\n") out[i] = " "; continue; }
    if (inS) {
      if (c === "\\") { out[i] = out[i + 1] = " "; i++; continue; }
      if (c === inS) inS = null;
      if (c !== "\n") out[i] = " ";
      continue;
    }
    if (c === "/" && n === "*") { out[i] = out[i + 1] = " "; i++; inBlock = true; continue; }
    if (c === "/" && n === "/") { out[i] = out[i + 1] = " "; i++; inLine = true; continue; }
    if (c === '"' || c === "'" || c === "`") { inS = c; out[i] = " "; continue; }
  }
  return out.join("");
}

function matchingBraceAt(src, openIndex) {
  let depth = 0, inS = null, inBlock = false, inLine = false;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inS) {
      if (c === "\\") { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const findings = [];

for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

  /**
   * OFFSETS, NOT LINES. The first version worked line by line, so
   * `} catch {}` on a single line came out non-empty and was never
   * flagged , the gate passed on exactly the shape it was written to
   * catch. Its own test found this.
   */
  /**
   * Scan a COMMENT-BLANKED copy. `session-policy.ts` explains the defect
   * in prose and the sentence contains the literal `catch {}`; scanning
   * raw source reported the explanation as the bug. That is the third
   * time in this project a checker has flagged its own documentation.
   */
  const masked = blankNonCode(src);
  const CATCH = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m;
  while ((m = CATCH.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchingBraceAt(src, open);
    if (close === -1) continue;
    const body = src.slice(open + 1, close);
    const line = src.slice(0, m.index).split("\n").length;

    const codeOnly = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .trim();

    if (/\bthrow\b/.test(codeOnly)) continue;   // rethrowing is not swallowing

    const isEmpty = codeOnly.length === 0;
    const isPermissive = PERMISSIVE.test(codeOnly);
    if (!isEmpty && !isPermissive) continue;

    const declaredInline = /FAIL[\s-]?OPEN|DELIBERATELY IGNORED|SWALLOW(ED)? ON PURPOSE/i.test(body);
    const declaredInRegistry = REGISTRY.some((d) => d.file === rel && Math.abs(d.line - line) <= 5);
    if (declaredInline || declaredInRegistry) continue;

    findings.push({
      file: rel,
      line,
      kind: isEmpty ? "swallowed" : "permissive",
      snippet: (codeOnly.split("\n").map((x) => x.trim()).filter(Boolean)[0] || "(empty)").slice(0, 70),
    });
  }
}

if (findings.length > 0) {
  console.error("check:fail-open , a failure is being recorded as a success:\n");
  for (const f of findings) {
    console.error(`  x ${f.file}:${f.line}  [${f.kind}]  ${f.snippet}`);
  }
  console.error(
    `\n${findings.length} undeclared. Either make it fail CLOSED, or write` +
    ` FAIL OPEN in a comment inside the catch block with the reason. The` +
    ` gate exists to make the decision explicit, not to forbid it.`,
  );
  process.exit(1);
}

console.log(
  `check:fail-open , ${files.length} security-relevant files scanned, every catch either refuses or declares itself` +
  (REGISTRY.length ? `\n  ${REGISTRY.length} declared in fail-open-registry.json and still carried as a baseline:` : ""),
);
/**
 * PRINTED EVERY RUN, ON PURPOSE. A baseline you cannot see is a baseline
 * that becomes permanent. Listing them keeps the number in front of
 * whoever is reading CI output.
 */
for (const d of REGISTRY) console.log(`    - ${d.file}:${d.line}  ${d.reason.slice(0, 88)}`);
