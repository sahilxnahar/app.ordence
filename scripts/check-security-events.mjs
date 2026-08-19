#!/usr/bin/env node
/**
 * Ordence — CI GATE 21: A DECLARED SECURITY EVENT MUST BE EMITTED
 * Version: v1.77.0-alpha · Wave 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS GATE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `lib/security/events.ts` is a closed vocabulary. Adding a member is
 * deliberately expensive: a code change, a schema change and a migration.
 * That friction is the right amount for extending a security vocabulary
 * and it produced exactly the failure it was designed to prevent, one
 * layer up — TEN of the twenty-one declared types had never been written
 * by any code path in the product:
 *
 *     auth.brute_force_suspected      (critical, and the only critical
 *                                      in the authentication group)
 *     authz.denial_spike
 *     webhook.replay_suspected
 *     portal.token_invalid
 *     portal.token_expired
 *     portal.token_revoked_use
 *     portal.token_shared_suspected
 *     export.bulk
 *     export.off_hours
 *     upload.rejected
 *
 * Each one had a default severity, a human label and a SIEM mapping.
 * Every dashboard, alert rule and runbook built on them was green, and
 * green meant "no data has ever arrived here", which is indistinguishable
 * from "nothing has happened".
 *
 * Two anomaly detection rules were dead as a direct consequence: both
 * filtered on event types nothing emitted, so they examined zero rows on
 * every sweep since Phase 20.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE MATCHER IS FUSSIER THAN "IS THE STRING ANYWHERE"
 * ══════════════════════════════════════════════════════════════════════
 * The audit that found this originally used "does the literal appear
 * outside the catalogue" and MISSED `authz.denial_spike`, because an
 * anomaly rule uses the same text as its `ruleId`. A rule identifier that
 * happens to read like an event type is not an emission, and a matcher
 * that cannot tell the difference reports nine problems where there are
 * ten — with no way to know which way it erred.
 *
 * So an occurrence counts as an EMISSION only when it is in a value
 * position and not a `ruleId`. Concretely, these count:
 *
 *     type: "portal.token_invalid"
 *     ? "webhook.replay_suspected" : "webhook.signature_invalid"
 *     "auth.failed_login_burst": "auth.brute_force_suspected"   ← value
 *
 * and these do not:
 *
 *     ruleId: "authz.denial_spike"
 *     "authz.denial_spike": SOMETHING                           ← key
 *
 * ══════════════════════════════════════════════════════════════════════
 * SECOND CHECK: EVERY ANOMALY RULE MAPS TO A TYPE, OR SAYS IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * `server/security/anomalies.ts#eventTypeForRule` falls back to
 * `anomaly.detected` rather than throwing, because a throw inside the
 * sweep loses the findings of every rule that already ran. The fallback
 * is correct at runtime and invisible, so the omission is caught HERE
 * instead: a `ruleId` literal that is neither in `RULE_EVENT_TYPE` nor in
 * `GENERIC_BY_DESIGN` fails the build.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = process.cwd();

/** Comments are not code. A type named in a doc block is not an emission. */
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
 * ⚠️ THE CATALOGUE AND THE SIEM SERIALISER ARE EXCLUDED, and nothing else
 * is. The catalogue names every type by definition; the serialiser maps
 * every type by definition. Excluding a third file would be excluding a
 * place an emission could legitimately live.
 */
const DECLARING = new Set(["lib/security/events.ts", "lib/security/siem.ts"]);

const source = new Map();
for (const file of files) {
  try {
    source.set(file, codeOnly(readFileSync(`${ROOT}/${file}`, "utf8")));
  } catch {
    /* unreadable is not a security finding */
  }
}

const catalogue = codeOnly(readFileSync(`${ROOT}/lib/security/events.ts`, "utf8"));
const block = catalogue.match(/export const SECURITY_EVENT_TYPES = \[([\s\S]*?)\] as const;/);
if (!block) {
  console.error("check:security-events — could not read SECURITY_EVENT_TYPES.");
  process.exit(1);
}
const eventTypes = [...block[1].matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);

/** True when `"type"` appears in a value position on this line. */
function emits(text, type) {
  const needle = `"${type}"`;
  let at = text.indexOf(needle);
  while (at !== -1) {
    const after = text.slice(at + needle.length, at + needle.length + 4);
    const before = text.slice(Math.max(0, at - 40), at);
    const isKey = /^\s*:/.test(after);
    const isRuleId = /(ruleId|rule|ruleName)\s*:\s*$/.test(before);
    if (!isKey && !isRuleId) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

const failures = [];

for (const type of eventTypes) {
  let found = null;
  for (const [file, text] of source) {
    if (DECLARING.has(file)) continue;
    if (emits(text, type)) {
      found = file;
      break;
    }
  }
  if (!found) failures.push(`${type} — declared in lib/security/events.ts, emitted by nothing`);
}

/* ---- SECOND CHECK: RULES WITHOUT A TYPE -------------------------- */

/**
 * Rules that deliberately keep `anomaly.detected`. Each needs a reason
 * written at `RULE_EVENT_TYPE` in `server/security/anomalies.ts`; this
 * list is only the machine-readable half of that decision.
 */
const GENERIC_BY_DESIGN = new Set(["rate_limit.sustained_pressure"]);

const anomalies = codeOnly(readFileSync(`${ROOT}/server/security/anomalies.ts`, "utf8"));
const ruleIds = new Set([...anomalies.matchAll(/ruleId:\s*"([a-z_.]+)"/g)].map((m) => m[1]));
const mapBlock = anomalies.match(/const RULE_EVENT_TYPE[^=]*=\s*\{([\s\S]*?)\n\};/);
const mapped = new Set(
  mapBlock ? [...mapBlock[1].matchAll(/"([a-z_.]+)"\s*:/g)].map((m) => m[1]) : [],
);

for (const rule of ruleIds) {
  if (mapped.has(rule) || GENERIC_BY_DESIGN.has(rule)) continue;
  failures.push(
    `${rule} — an anomaly rule with no entry in RULE_EVENT_TYPE, so its findings ` +
      `silently fall back to anomaly.detected`,
  );
}

if (failures.length > 0) {
  console.error("\ncheck:security-events FAILED\n");
  for (const line of failures) console.error(`  ✗ ${line}`);
  console.error(
    `\n${failures.length} problem(s). A declared security event that nothing emits is ` +
      `an alarm that reads as silent when it is simply not wired. Either emit it from ` +
      `the surface it describes, or remove it from the catalogue and its schema.\n`,
  );
  process.exit(1);
}

console.log(
  `check:security-events — ${eventTypes.length} declared event types, all emitted; ` +
    `${ruleIds.size} anomaly rules, all mapped.`,
);
