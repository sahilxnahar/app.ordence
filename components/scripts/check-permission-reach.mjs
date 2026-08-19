#!/usr/bin/env node
/**
 * Ordence — CI GATE 22: A DECLARED PERMISSION MUST REACH SOME CODE
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT REFUSES
 * ══════════════════════════════════════════════════════════════════════
 * A key in `PERMISSION_CATALOG` that appears NOWHERE in the product's
 * code outside `db/schema/auth.ts` itself, and is not recorded in
 * `lib/auth/permission-enforcement.ts` with a written reason.
 *
 * Eleven such keys existed when this gate was written. Each was granted
 * to some roles and withheld from others, so the role screen described
 * boundaries that were not there — including one
 * (`transactions:read` / `ledgers:read`) under which every member of
 * every workspace could read the complete general ledger.
 *
 * ⚠️ IT ALSO REFUSES A STALE LEDGER ENTRY. A key listed as unenforced
 * that HAS since appeared in code fails just as loudly. An entry saying
 * "nothing checks this" long after something does is a lie in a security
 * file, and the only person who would ever notice is the one who wired
 * it — on the day they wired it, and never again.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT DELIBERATELY DOES NOT CHECK
 * ══════════════════════════════════════════════════════════════════════
 * It does not verify that a key is used AS A GUARD. Many are passed
 * through wrappers — `guardSalesWrite({ permission })`, `guardDrawings`,
 * `lib/views/access.ts`, the workflow action table — and a matcher strict
 * enough to demand a literal `requirePermission("key")` reports about a
 * hundred false positives, which is the number at which a gate stops
 * being read. `check:guards` (gate 5) is what verifies that an action has
 * a guard at all. This gate answers a narrower and completely
 * unambiguous question: does this key exist in the product, or only in
 * the catalogue?
 *
 * Comments do not count. Four of the eleven were "referenced" only inside
 * doc blocks that discussed them, which is exactly the shape of evidence
 * that makes a key look wired when it is not.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = process.cwd();

const codeOnly = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const files = execSync(
  "find lib server app components db middleware.ts instrumentation.ts -type f " +
    "\\( -name '*.ts' -o -name '*.tsx' \\) 2>/dev/null | grep -v node_modules",
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .trim()
  .split("\n")
  .filter(Boolean);

/**
 * ⚠️ THE LEDGER IS EXCLUDED FROM THE SEARCH. It names every unenforced
 * key by definition; counting it as a reference would make every entry
 * self-satisfying and the gate would pass on an empty product.
 */
const EXCLUDED = new Set(["db/schema/auth.ts", "lib/auth/permission-enforcement.ts"]);

const source = new Map();
for (const file of files) {
  if (EXCLUDED.has(file)) continue;
  try {
    source.set(file, codeOnly(readFileSync(`${ROOT}/${file}`, "utf8")));
  } catch {
    /* unreadable is not a finding */
  }
}

const auth = codeOnly(readFileSync(`${ROOT}/db/schema/auth.ts`, "utf8"));
const catalogue = auth.match(/export const PERMISSION_CATALOG[^=]*=\s*\{([\s\S]*?)\n\} as const;/);
if (!catalogue) {
  console.error("check:permission-reach — could not read PERMISSION_CATALOG.");
  process.exit(1);
}
const keys = [...catalogue[1].matchAll(/"([a-z_]+[.:][a-z_.]+)":/g)].map((m) => m[1]);

const ledgerSrc = readFileSync(`${ROOT}/lib/auth/permission-enforcement.ts`, "utf8");
const ledgerEntries = [...ledgerSrc.matchAll(/key:\s*"([a-z_]+[.:][a-z_.]+)"/g)].map((m) => m[1]);
const ledger = new Set(ledgerEntries);

/** Every ledger entry must carry a reason of substance, not a placeholder. */
const reasons = [...ledgerSrc.matchAll(/key:\s*"([a-z_]+[.:][a-z_.]+)"[\s\S]*?reason:\s*([\s\S]*?)\n  \},/g)];

function referenced(key) {
  const needle = `"${key}"`;
  for (const [file, text] of source) {
    if (text.includes(needle)) return file;
  }
  return null;
}

const failures = [];

for (const key of keys) {
  const where = referenced(key);
  if (where && ledger.has(key)) {
    failures.push(
      `${key} — listed in lib/auth/permission-enforcement.ts as unenforced, but it now ` +
        `appears in ${where}. Remove the ledger entry.`,
    );
    continue;
  }
  if (!where && !ledger.has(key)) {
    failures.push(
      `${key} — declared in PERMISSION_CATALOG and named by no code anywhere. Either check it ` +
        `at the surface it describes, or record it in lib/auth/permission-enforcement.ts with ` +
        `the reason nothing does.`,
    );
  }
}

for (const entry of ledgerEntries) {
  if (!keys.includes(entry)) {
    failures.push(
      `${entry} — listed in lib/auth/permission-enforcement.ts but no longer in ` +
        `PERMISSION_CATALOG. Remove the ledger entry.`,
    );
  }
}

for (const [, key, reasonText] of reasons) {
  const cleaned = reasonText.replace(/["+\s]/g, "");
  if (cleaned.length < 80) {
    failures.push(`${key} — its ledger reason is too short to be a reason.`);
  }
}

if (failures.length > 0) {
  console.error("\ncheck:permission-reach FAILED\n");
  for (const line of failures) console.error(`  ✗ ${line}`);
  console.error(
    `\n${failures.length} problem(s). A permission granted to some roles and withheld from ` +
      `others, that no code consults, is a boundary the role screen promises and the product ` +
      `does not keep.\n`,
  );
  process.exit(1);
}

console.log(
  `check:permission-reach — ${keys.length} catalogue keys; ${ledger.size} recorded as ` +
    `declared-only with a written reason; the rest reach code.`,
);
