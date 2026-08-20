/**
 * Ordence — PROOF: the ratchet matches the repository.
 * Track G / wave 17 / v1.83.0-alpha
 *
 * RUN IT (from the repository root):
 *
 *     npx tsx lib/email/proofs/provider-callers.proof.ts
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT MAKES THIS A PROOF RATHER THAN A LIST
 * ══════════════════════════════════════════════════════════════════════
 * It reads the repository. `lib/email/provider-callers.ts` says who may call
 * the mail provider; this walks `app/`, `components/`, `lib/`, `server/` and
 * `db/` and finds who actually does. A list nobody re-derives is a list that
 * describes the codebase of the day it was written.
 *
 * ⚠️ IT FAILS IN BOTH DIRECTIONS, AND FOR DIFFERENT REASONS. A caller that is
 * not on the list is a regression: somebody added a fifth way to send mail
 * around the suppression list. A listed caller that no longer exists is
 * progress that has not been recorded, and an over-stated ratchet stops being
 * believed, which is the only thing keeping the number useful.
 *
 * ⚠️ THE SCAN EXCLUDES `lib/email/` ITSELF, on purpose. The provider module
 * lives there, and so does the catalogue — a catalogue that appears in its own
 * scan is `check:reachability`'s problem one layer down, where a file that
 * merely NAMES a thing is counted as using it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PROVIDER_MODULE, PROVIDER_CALLERS, diffProviderCallers } from "../provider-callers";

const ROOT = path.resolve(__dirname, "../../..");
const SEARCH_DIRS = ["app", "components", "lib", "server", "db"];
/** `lib/email/` holds the provider and the catalogue. See the note above. */
const EXCLUDE_PREFIX = path.join("lib", "email") + path.sep;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage"]);
const EXTENSIONS = new Set([".ts", ".tsx"]);

let failures = 0;

function claim(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.error(`  🔴 ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
}

/**
 * ⚠️ THE PATTERN MATCHES AN IMPORT, NOT A MENTION. `from "<module>"` and
 * `import("<module>")` only. A comment naming the module — and several files
 * in this repository name it in prose, correctly, while warning against it —
 * must not count as a caller, or the ratchet inflates every time somebody
 * documents the rule.
 */
function importsProvider(source: string): boolean {
  const escaped = PROVIDER_MODULE.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`(?:from|import\\()\\s*["']${escaped}["']`).test(source);
}

console.log("\nPROOF — lib/email/provider-callers.ts against the repository\n");

const files: string[] = [];
for (const dir of SEARCH_DIRS) walk(path.join(ROOT, dir), files);

/*
 * ⚠️ A VACUOUS PASS GUARD, because a scan that found nothing would agree with
 * an empty list and report success. `check-action-reachability.mjs` carries
 * the same guard for the same reason.
 */
claim(
  "the scan actually read the repository",
  files.length > 500,
  `only ${files.length} source files found under ${SEARCH_DIRS.join(", ")} — the walk is broken, and a broken walk agrees with any list`,
);

const actual = files
  .filter((f) => importsProvider(readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f))
  .filter((rel) => !rel.startsWith(EXCLUDE_PREFIX))
  .sort();

claim(
  "the pattern found the callers at all",
  actual.length > 0,
  "zero importers found — either the regex is wrong or PROVIDER_MODULE no longer names the provider",
);

const diff = diffProviderCallers(actual);

claim(
  "🔴 no module calls the mail provider that is not on the list",
  diff.added.length === 0,
  `NEW DIRECT CALLER(S): ${diff.added.join(", ")}\n     Each one bypasses the suppression list, the attempt ceiling, the retry schedule and the delivery record. Route it through enqueueEmail() in server/email/outbox.ts, or add it to PROVIDER_CALLERS with an honest reason.`,
);

claim(
  "⭐ every listed caller still exists, so the ratchet is not over-stating the problem",
  diff.removed.length === 0,
  `NO LONGER PRESENT: ${diff.removed.join(", ")}\n     If these moved onto the outbox, remove them from PROVIDER_CALLERS — that is the ratchet turning, and it should be recorded.`,
);

/*
 * The headline number, printed whether or not anything failed. It is the
 * thing wave 17 asked to be kept and made to shrink.
 */
const bypasses = PROVIDER_CALLERS.filter((c) => c.kind === "bypass");
console.log(`\n  ${bypasses.length} module(s) still send without the outbox:`);
for (const c of bypasses) console.log(`    · ${c.path}`);

console.log("");
if (failures > 0) {
  console.error(`🔴 ${failures} claim(s) FAILED.\n`);
  process.exit(1);
}
console.log("✅ every claim holds.\n");
