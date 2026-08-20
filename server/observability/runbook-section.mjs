#!/usr/bin/env node
/**
 * Ordence — generate the observability section of `docs/RUNBOOK.md`
 * Version: v1.83.0-alpha · Wave 17 · Track B
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS GENERATED AND NOT WRITTEN
 * ══════════════════════════════════════════════════════════════════════
 * `docs/RUNBOOK.md` lives on the assembled tree and is not Track B's to
 * edit. The runbooks themselves are `RUNBOOKS` in
 * `server/observability/alerts.ts`, which IS Track B's, and which the
 * database already enforces: `observability_alerts.runbook_key` is NOT
 * NULL with a length CHECK, so no alert can exist without naming one.
 *
 * ⚠️ TWO LISTS KEPT IN STEP BY DISCIPLINE IS THE DEFECT THAT PRODUCED
 * MIGRATION 0091 — `lib/platform/env-catalog.ts` records it in those
 * words, and by v1.65.0-alpha that catalogue had drifted by fourteen
 * names. A runbook pasted into a document once is that defect with an
 * on-call engineer at the other end of it.
 *
 * So: this prints the section. Integration pastes it, or pipes it, and
 * `check:observability-callers` fails the build if `docs/RUNBOOK.md`
 * exists and is missing a runbook key.
 *
 *   node server/observability/runbook-section.mjs            # print the section
 *   node server/observability/runbook-section.mjs <root>     # for a tree elsewhere
 *
 * ⚠️ IT DOES NOT CHECK THE DOCUMENT. `check:observability-callers` does
 * that, because two places that both verify the same agreement is two
 * places that can disagree about whether they verified it. The generator
 * generates; the gate refuses.
 *
 * ⚠️ IT PARSES `alerts.ts` AS TEXT rather than importing it. The module is
 * TypeScript and pulls in the database client; a generator that cannot run
 * without a database is a generator nobody runs. The parse is anchored on
 * the literal shape of the `RUNBOOKS` object and FAILS LOUDLY if it finds
 * fewer entries than the RunbookKey union declares — a silently short
 * runbook section is the failure this file exists to prevent.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]) ?? process.cwd();
const SOURCE = join(ROOT, "server/observability/alerts.ts");

if (!existsSync(SOURCE)) {
  console.error(`::error::runbook-section: ${SOURCE} not found.`);
  process.exit(1);
}

const src = readFileSync(SOURCE, "utf8");

/* The declared vocabulary, so the parse can be checked against it. */
const unionBlock = src.match(/export type RunbookKey =([\s\S]*?);/);
const declared = unionBlock
  ? [...unionBlock[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
  : [];

/* The entries. Anchored on the object literal's own shape. */
const body = src.slice(src.indexOf("export const RUNBOOKS"));
const entries = [];
const entryRe =
  /"([a-z-]+)":\s*\{\s*key:\s*"[a-z-]+",\s*title:\s*([\s\S]*?),\s*whatToDoNow:\s*([\s\S]*?),\s*escalateIf:\s*([\s\S]*?),\s*\},/g;

for (const m of body.matchAll(entryRe)) {
  entries.push({
    key: m[1],
    title: joinStrings(m[2]),
    whatToDoNow: joinStrings(m[3]),
    escalateIf: joinStrings(m[4]),
  });
}

/** `"a " + "b"` across lines → `a b`. */
function joinStrings(raw) {
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/* 🔴 REFUSE TO PRODUCE A SHORT SECTION. */
if (declared.length === 0) {
  console.error("::error::runbook-section: could not read the RunbookKey union. Refusing to emit.");
  process.exit(1);
}
if (entries.length !== declared.length) {
  console.error(
    `::error::runbook-section: the RunbookKey union declares ${declared.length} runbook(s) ` +
      `and the parser found ${entries.length}. A short runbook section is worse than none — ` +
      `it reads as complete. Missing: ${declared.filter((d) => !entries.some((e) => e.key === d)).join(", ") || "(shape changed)"}`,
  );
  process.exit(1);
}
for (const e of entries) {
  if (e.whatToDoNow.length < 80 || e.escalateIf.length < 40 || e.title.length < 5) {
    console.error(`::error::runbook-section: ${e.key} has no real 3am answer.`);
    process.exit(1);
  }
}

process.stdout.write(renderSection(entries));

/* ------------------------------------------------------------------ */

function renderSection(list) {
  const lines = [];
  lines.push("## Observability alerts");
  lines.push("");
  lines.push(
    "🔴 **Generated from `server/observability/alerts.ts#RUNBOOKS`. Do not edit by hand.**",
  );
  lines.push(
    "Regenerate with `node server/observability/runbook-section.mjs`. " +
      "This generator does not verify the document — `npm run check:observability-callers` " +
      "does, and fails naming any alert key that is missing from here.",
  );
  lines.push("");
  lines.push(
    "Every alert this product can raise names one of these keys. " +
      "`observability_alerts.runbook_key` is `NOT NULL` with a length `CHECK`, so there is " +
      "no code path — including a cast during an incident — that can raise an alert with " +
      "no answer attached to it.",
  );
  lines.push("");
  lines.push("| Key | Fires when |");
  lines.push("|---|---|");
  for (const e of list) lines.push(`| \`${e.key}\` | ${e.title} |`);
  lines.push("");
  for (const e of list) {
    lines.push(`### \`${e.key}\` — ${e.title}`);
    lines.push("");
    lines.push(`**What to do now.** ${e.whatToDoNow}`);
    lines.push("");
    lines.push(`**Escalate if.** ${e.escalateIf}`);
    lines.push("");
  }
  return lines.join("\n");
}
