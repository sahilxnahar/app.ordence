#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ CI GATE: AN OBSERVABILITY EXPORT MUST HAVE A CALLER
 * Version: v1.82.0-alpha · Wave 14 · Track B
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS EXISTS FOR, WHICH IS THE LARGEST OF ITS KIND HERE
 * ══════════════════════════════════════════════════════════════════════
 * At v1.81.0-alpha, verified by grep across the whole tree:
 *
 *   lib/telemetry/report.ts      captureError            0 callers
 *                                captureEvent            0 callers
 *                                captureErrorSync        0 callers
 *                                buildErrorRow           0 callers
 *                                describeThrown          0 callers
 *   lib/security/siem.ts         EVERY export            0 callers
 *   server/metering/record.ts    recordApiCall           0 callers
 *                                recordEmailSent         0 callers
 *                                recordUsage             0 callers
 *   server/security/record.ts    recordSecurityEventTx   0 callers
 *   server/security/anomalies.ts the five detectors      0 callers
 *
 * Every one of them is good code. Every one is tested. `lib/security/
 * siem.ts` alone carries 38 assertions in `tests/ui/security-events.tsx`.
 * All of it was reviewed, merged, and has never run in production.
 *
 * ⚠️ AND THE DASHBOARDS BUILT ON THEM WERE GREEN, because green meant
 * "no data has ever arrived here", which is indistinguishable from
 * "nothing has happened". That indistinguishability is the whole problem:
 * an observability module with no caller is not a dormant feature, it is
 * a monitoring system that reports everything is fine.
 *
 * ⭐ WIRING THEM IS WORTH ONE WAVE. THIS GATE IS WORTH EVERY WAVE AFTER,
 * because it is what stops the next module joining the list.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT COUNTS AS A CALLER, AND WHY THE MATCHER IS FUSSY
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/check-security-events.mjs` learned this the expensive way: its
 * first version used "does the literal appear anywhere" and missed a real
 * orphan because a rule identifier happened to read like an event type.
 * The rules here:
 *
 *   ① COMMENTS ARE NOT CODE. Every one of these files documents its own
 *      exports at length in block comments — `captureError` appears
 *      eleven times inside `lib/telemetry/report.ts`'s own prose. A
 *      matcher that counts prose would report full coverage over a tree
 *      in which nothing is called.
 *
 *   ② THE DECLARING FILE DOES NOT COUNT. A module that calls its own
 *      export is exactly what an orphan looks like from the inside:
 *      `captureErrorSync` calls `captureError`, and both had no callers.
 *
 *   ③ TESTS DO NOT COUNT. "It is covered" is how every module on the
 *      list above justified its existence. A test proves the code is
 *      correct; it says nothing about whether it runs.
 *
 *   ④ TYPES DO NOT COUNT AND ARE NOT CHECKED. `export type CaptureResult`
 *      has no runtime caller and never will.
 *
 *   ⑤ A NAME EXPORTED FOR A TEST SEAM IS EXEMPT BY SUFFIX, and the
 *      exemptions are PRINTED rather than hidden. `__resetXForTests` is a
 *      real pattern in this repo and refusing it would push people to
 *      delete test seams, which is worse.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT REFUSES TO PASS VACUOUSLY
 * ══════════════════════════════════════════════════════════════════════
 * If it finds zero watched files, or parses zero exports, or reads an
 * empty corpus, it EXITS NON-ZERO. A gate everybody believes is running
 * and is not is the same defect as no gate, wearing a green tick — which
 * is the lesson `vitest.config.ts` records about twenty-three suites that
 * were silently never collected, and the lesson `check:sql-executes`
 * records about a skip path that exited 0.
 *
 * ══════════════════════════════════════════════════════════════════════
 * USAGE
 * ══════════════════════════════════════════════════════════════════════
 *   node server/observability/caller-census.mjs [root]
 *
 * `[root]` exists so a test can point it at a synthesised tree and watch
 * it FAIL. A gate that has only ever been seen to pass is a gate nobody
 * has watched fail.
 *
 * Exit codes: 0 pass · 1 fail. Never 78 — this gate needs no database and
 * has nothing it could legitimately skip.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();

/* ================================================================== */
/* ① THE WATCH LIST                                                    */
/* ================================================================== */

/**
 * Files whose exports must be reachable.
 *
 * ⚠️ AN EXPLICIT LIST, NOT A GLOB OVER `lib/**`. The question this gate
 * asks — "does anything call this" — is a fair question for an
 * observability module and a bad one for a validator, a formatter or a
 * schema, where an export existing for a consumer that is not written yet
 * is ordinary. A glob would produce hundreds of findings, and a gate that
 * cries wolf gets disabled.
 *
 * Add a file here when it becomes part of the evidence layer.
 */
const WATCHED = [
  "lib/telemetry/report.ts",
  "lib/telemetry/log.ts",
  "lib/telemetry/trace.ts",
  "lib/security/siem.ts",
  "server/observability/trace.ts",
  "server/observability/observe.ts",
  "server/observability/slo.ts",
  "server/observability/health.ts",
  "server/observability/cost.ts",
  "server/observability/alerts.ts",
  "server/observability/runtime.ts",
  "server/observability/reliability-page.tsx",
  "server/observability/siem-export-handler.ts",
  "server/security/siem.ts",
  "server/security/alerting.ts",
  /**
   * ⭐ THE EVIDENCE LAYER IS WIDER THAN THE TELEMETRY DIRECTORY. These
   * three are here because the brief's headline orphan lived in the first
   * one: `recordApiCall` is a BILLING counter, and the reason it went a
   * year uncalled is that nobody thought of the metering module as part of
   * observability. A watch list drawn along directory lines would have
   * missed it again.
   */
  "server/metering/record.ts",
  "server/security/record.ts",
  "server/security/anomalies.ts",
];

/** Where a caller may live. The schema layer and the tests are not here. */
const SEARCH_DIRS = ["app", "components", "lib", "server", "db", "scripts"];
const SEARCH_FILES = ["middleware.ts", "instrumentation.ts", "instrumentation-client.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage", "out", "tests"]);

/**
 * ⚠️ 🔴 THIS FILE EXCLUDES ITSELF, AND IT DID NOT ON THE FIRST RUN.
 *
 * `KNOWN_UNCALLED` names every exempted export as a string key, so the
 * census read its own exemption list as evidence that those exports had
 * callers — and then reported the exemptions as stale. Three false
 * findings, all of them confidently worded, all of them about entries
 * that were correct.
 *
 * ⭐ IT IS THE SAME SHAPE `check-reachability.mjs` documents about
 * `lib/dpdp/classification.ts`: "a file that enumerates the schema is
 * invisible to a census OF the schema". A census that cites itself is
 * worse than one that misses a file, because its output reads as
 * progress.
 */
const SELF = "server/observability/caller-census.mjs";

/**
 * ⚠️ EXEMPTIONS, EACH WITH A SENTENCE. This is the same shape as
 * `KNOWN_GAPS` in `check-migrations.mjs` and `KNOWN_UNPOSTED` in the
 * posting gate, and for the same reason: a number nobody has to justify
 * is a number that grows. The list can only shrink by somebody deciding
 * to shrink it.
 */
const KNOWN_UNCALLED = {
  "lib/telemetry/log.ts#buildLogRecord":
    "Pure record builder split out of log() so the assertion 'nothing outside LOG_FIELDS survives' can be made without capturing stdout. Reached at runtime through log() in the same file; rule ② hides that, correctly.",
  "lib/telemetry/log.ts#LOG_FIELDS":
    "The positive allow-list itself. It is exported so a test can assert no personal-looking key was ever added to it — the same tripwire tests/ui/telemetry.test.tsx already keeps over TELEMETRY_METADATA_KEYS. Its runtime reader is coerce() in the same file.",
  "lib/telemetry/trace.ts#traceIdFromRequestId":
    "Reached through traceForRequest() in the same file. Exported because the uuid-to-trace-id derivation is this module's central claim — that the trace id already existed and nobody had named it — and that claim has to be exercisable directly.",
  "lib/security/siem.ts#toNdjsonLine":
    "Reached through serialiseForSiem(), which server/security/siem.ts now calls. Exported so tests/ui/security-events.test.tsx can assert the ECS field mapping and the newline-stripping log-injection defence line by line. 🔴 lib/security/ is OUTSIDE Track B's ownership; these six exports were not changed and are not proposed for change.",
  "lib/security/siem.ts#toNdjson":
    "As toNdjsonLine — the batch form, reached through serialiseForSiem(). Exported so a test can assert that a batch ends with a trailing newline and that an empty batch produces an empty string rather than a stray one.",
  "lib/security/siem.ts#toCefLine":
    "As toNdjsonLine, for the CEF format, reached through serialiseForSiem(). Exported so a test can assert the CEF header prefix and the severity mapping, which a customer SOC writes rules against.",
  "lib/security/siem.ts#toCef":
    "As toNdjsonLine — the CEF batch form, reached through serialiseForSiem(). Exported for the same trailing-newline assertion as toNdjson.",
  "lib/security/siem.ts#cefEscape":
    "CEF extension-value escaping, reached through toCefLine(). Exported because escaping rules are the part of a wire format that is worth testing in isolation.",
  "lib/security/siem.ts#cefHeaderEscape":
    "CEF header escaping — a different rule from the extension escaping above, which is exactly why both are exported and tested separately.",
  "server/observability/observe.ts#recordRequestOutcome":
    "The primitive that writes one observation into the minute bucket. Called by observe() in the same file. Exported so a test can drive the cumulative histogram directly — the histogram is where a broken writer produces a plausible wrong percentile.",
  "server/observability/slo.ts#sloById":
    "Reached through evaluateSlo() in the same file. Exported because 'is this id in the catalogue' is the question a caller with a string wants to ask.",
  "server/observability/health.ts#p95FromHistogram":
    "Reached through getHealthSnapshot() in the same file. Exported because reading a percentile off a cumulative histogram — and returning null rather than an invented number above the last edge — is the single most testable claim in this track.",
  "server/security/siem.ts#siemStreamAvailability":
    "Called by exportForSiem(), exportTenantReview() and summariseStream() in the same file. Exported so a caller can ask whether SQL-FILES/0134 has been applied before offering a download button that would 503.",
  "lib/telemetry/report.ts#buildErrorRow":
    "Pure, synchronous row builder split out of captureError() so the assertion 'no PII survives' can be tested without a database. It is genuinely reached at runtime through captureError() in the same file; the gate cannot see that because the declaring file does not count, which is rule ② and is correct.",
  "lib/telemetry/report.ts#describeThrown":
    "Same shape as buildErrorRow: reached through captureError() inside its own module. Exported because 'what does `throw 42` produce' is the part worth testing directly.",
  "server/observability/alerts.ts#redactDeliveryError":
    "The single choke point between the Discord webhook URL — which is a credential — and the delivery_error column. Reached through deliverToDiscord() in the same file; rule ② hides that. Exported because it is the one function in this track that must be tested against the real error strings Node produces, including the misconfiguration case that pattern-matching alone leaks.",
  "server/observability/reliability-page.tsx#ReliabilityPage":
    "🔴 THE ONE DELIVERABLE IN THIS TRACK THAT CANNOT BE WIRED FROM WITHIN ITS OWN OWNERSHIP. A Next.js page body needs a `page.tsx` under `app/` to render it, and tests/security/route-audit.test.ts forbids every file under an `admin` segment — which is the whole of Track B's assigned `app/` block. The three-line route file is in PATCH-REQUEST-B.md. DELETE THIS ENTRY when it lands; until then this gate is the record that the status surface is built and unreachable.",
  "server/observability/siem-export-handler.ts#handleSiemExport":
    "🔴 As ReliabilityPage. A route handler needs a `route.ts` under `app/`, and Track B's `app/` block cannot contain one. The handler is complete, guarded by requireCapability() and wrapped by withObservedApiRoute(); PATCH-REQUEST-B.md carries the two-line file that gives it a URL. DELETE THIS ENTRY when it lands.",

  /* ---- server/metering/record.ts ------------------------------- */
  "server/metering/record.ts#incrementCounterStatement":
    "The single atomic INSERT ... ON CONFLICT statement, reached through recordUsageTx() in the same file. Exported so the security suite can assert that the shape it tests is the shape actually executed.",
  "server/metering/record.ts#recordUsage":
    "Reached through recordEmailSent(), recordApiCall() and recordPortalLinkCreated() in the same file. It is the general form; the wrappers exist so six call sites cannot each choose their own metric string.",
  "server/metering/record.ts#recordUsageTx":
    "Reached through recordUsage() in the same file. 🔴 ITS OWN DOCSTRING SAYS 'prefer this wherever a transaction already exists' AND NOTHING DOES — which is a real finding rather than a comfortable one, and it needs a period from getTenantMeteringContext() that no external caller can currently obtain because resolvePeriod() is private. Recorded in TRACK-REPORT.md §4.",
  "server/metering/record.ts#reserveUsage":
    "The one recorder that THROWS, reached through reserveStorageBytes() in the same file, which server/actions/storage.ts calls inside its upload transaction.",
  "server/metering/record.ts#adjustLevel":
    "Reached through releaseStorageBytes() in the same file, which server/actions/storage.ts calls on delete.",
  "server/metering/record.ts#adjustLevelTx":
    "Reached through adjustLevel() in the same file.",
  "server/metering/record.ts#recordEmailSent":
    "🔴 A GENUINE ORPHAN AND NOT AN ARTEFACT OF RULE ②. Zero callers anywhere in the tree, exactly like recordApiCall() was. Every email this product sends is unmetered, so `emails_sent` is 0 for every workspace on every plan — and `emailsPerMonth` is a plan limit with a hard block at 150% (lib/metering/quota.ts), which means the block has never been able to fire either. The call site is one line in server/email/outbox.ts after the provider accepts, which is OUTSIDE Track B's ownership: the code is in PATCH-REQUEST-B.md. Exempted here so the gate can go green on the rest; DELETE THIS ENTRY when the patch lands.",

  /* ---- server/security/record.ts ------------------------------- */
  "server/security/record.ts#buildSecurityEventRow":
    "Reached through recordSecurityEvent() and recordSecurityEventTx() in the same file. ⚠️ Its comment says 'exported for tests' and no test imports it — harmless, but the claim is not currently true.",
  /*
   * ⭐ `server/security/record.ts#recordSecurityEventTx` WAS EXEMPTED HERE AND
   * THE EXEMPTION IS GONE, BECAUSE THE GATE'S REVERSE CHECK REMOVED IT.
   *
   * Wave 14 recorded it as a genuine orphan: the transactional variant that
   * THROWS so a security event which cannot be recorded rolls back the state
   * change it was recording, with zero callers including tests. On the
   * assembled tree the gate reported:
   *
   *   ✗ recordSecurityEventTx — listed in KNOWN_UNCALLED as unreachable, but
   *     lib/security/evidence.ts calls it. Delete the exemption; it is now a
   *     false statement about this codebase.
   *
   * Track D wired it. The entry is deleted rather than kept, which is what
   * the reverse check exists to force: an exemption nobody revisits is a
   * claim about the codebase that quietly stops being true.
   */

  /* ---- server/security/anomalies.ts ---------------------------- */
  "server/security/anomalies.ts#evaluateAnomalyRules":
    "Reached through runAnomalyDetection() in the same file, which server/scheduling/registry.ts calls. Exported because the rule set is worth evaluating against fixture observations without a database.",
  "server/security/anomalies.ts#detectFailedLoginBurst":
    "One of five detectors, all reached through evaluateAnomalyRules() in the same file. Each is exported because a detector's THRESHOLD BOUNDARY — fires at N+1, not at N — is the part that has to be tested directly.",
  "server/security/anomalies.ts#detectDenialSpike":
    "As detectFailedLoginBurst — reached through evaluateAnomalyRules(). Exported separately because it keys on the USER rather than the tenant, which is the distinction a test has to be able to exercise directly.",
  "server/security/anomalies.ts#detectPortalTokenSharing":
    "As detectFailedLoginBurst — reached through evaluateAnomalyRules(). Exported separately because it counts DISTINCT NETWORKS rather than events, which is a different shape of threshold and the one most likely to be got wrong.",
  "server/security/anomalies.ts#detectOffHoursBulkExport":
    "As detectFailedLoginBurst — reached through evaluateAnomalyRules(). Exported separately because it depends on the IST hour boundary from lib/security/hours.ts, and a timezone boundary is the part of a rule that has to be tested at the edge.",
  "server/security/anomalies.ts#detectRateLimitPressure":
    "As detectFailedLoginBurst — reached through evaluateAnomalyRules(). Exported separately because it is the one rule deliberately left mapped to the generic anomaly.detected event type, which scripts/check-security-events.mjs records in GENERIC_BY_DESIGN.",
  "server/security/anomalies.ts#eventTypeForRule":
    "Reached through runAnomalyDetection() in the same file. scripts/check-security-events.mjs asserts against the RULE_EVENT_TYPE map it reads, which is the coverage that matters here.",
  "server/security/anomalies.ts#ANOMALY_THRESHOLDS":
    "The threshold table the five detectors read, in the same file. Exported so a test can assert the boundary rather than restating the numbers — restating them is how a test and its subject drift apart.",

  "server/security/alerting.ts#SECURITY_ALERT_PREFIX":
    "The greppable marker an operator searches the Railway log drain for. Its consumer is a human with a search box, not a call site.",
  "server/security/alerting.ts#raiseSecurityAlert":
    "Called by the listener installSecurityAlerting() registers, in the same file. Rule ② hides it. 🔴 KEEP THIS ENTRY EVEN AFTER PATCH-REQUEST-B ITEM ⑨ LANDS. Wave 14 said to delete it once the chaining patch landed; that was WRONG and was caught by running the deletion. Item ⑨ chains raiseSecurityAlert to server/observability/alerts.ts#raiseAlert INSIDE server/security/alerting.ts, which is the declaring file, so rule ② still hides the caller and deleting this entry turns the gate red on a correctly-wired tree. The exemption the patch DOES retire is security-event-unrecorded in KNOWN_UNRAISED, below.",
};

/* ================================================================== */
/* ② PARSING                                                           */
/* ================================================================== */

/** Comments are not code. Rule ①. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Runtime exports only — rule ④.
 *
 * ⚠️ `export type` AND `export interface` ARE EXCLUDED BY THE PATTERN
 * ITSELF rather than filtered afterwards, because `export type Foo` and
 * `export const Foo` differ by one word and a filter applied later is a
 * filter somebody edits out.
 */
function runtimeExports(code) {
  const names = new Set();

  for (const m of code.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }

  /**
   * ⚠️ `export { a, b }` IS PARSED, AND `export { type X }` INSIDE IT IS
   * DROPPED. `server/observability/observe.ts` re-exports four names this
   * way; without this branch they would be invisible to the census and
   * the gate would under-report — which is the failure direction that
   * matters, because it is the silent one.
   */
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const piece = raw.trim();
      if (!piece || piece.startsWith("type ")) continue;
      const asMatch = piece.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const name = asMatch ? asMatch[2] : piece.match(/^[A-Za-z_$][\w$]*$/)?.[0];
      if (name) names.add(name);
    }
  }

  return [...names];
}

/** Rule ⑤. Printed, never silent. */
function isTestSeam(name) {
  return name.startsWith("__") || /ForTests$/.test(name);
}

/* ================================================================== */
/* ③ THE CORPUS                                                        */
/* ================================================================== */

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if ([".ts", ".tsx", ".mjs", ".js"].includes(extname(entry))) out.push(full);
  }
  return out;
}

/* ================================================================== */
/* ④ THE CENSUS                                                        */
/* ================================================================== */

const watched = WATCHED.filter((f) => existsSync(join(ROOT, f)));

if (watched.length === 0) {
  console.error(
    "::error::check:observability-callers found NONE of its watched files under " +
      `${ROOT}. It has checked nothing and is reporting nothing, which is the ` +
      "defect it exists to catch. Refusing to pass.",
  );
  process.exit(1);
}

const corpusFiles = [
  ...SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...SEARCH_FILES.map((f) => join(ROOT, f)).filter((f) => existsSync(f)),
];

if (corpusFiles.length === 0) {
  console.error(
    "::error::check:observability-callers read an EMPTY corpus. Every export would " +
      "report as uncalled, which is a false alarm, or the walk is broken, which is " +
      "worse. Refusing to run.",
  );
  process.exit(1);
}

/** file -> comment-stripped source. */
const corpus = new Map();
for (const file of corpusFiles) {
  try {
    corpus.set(relative(ROOT, file).split("\\").join("/"), codeOnly(readFileSync(file, "utf8")));
  } catch {
    /* unreadable is not a finding */
  }
}

const findings = [];
const exempted = [];
const seams = [];
let checked = 0;
let reached = 0;

for (const watchedFile of watched) {
  const code = codeOnly(readFileSync(join(ROOT, watchedFile), "utf8"));
  const names = runtimeExports(code);

  for (const name of names) {
    if (isTestSeam(name)) {
      seams.push(`${watchedFile}#${name}`);
      continue;
    }

    checked++;
    const key = `${watchedFile}#${name}`;

    let caller = null;
    const needle = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`);
    for (const [file, text] of corpus) {
      if (file === watchedFile) continue; // rule ②
      if (file === SELF) continue; // see SELF above
      if (needle.test(text)) {
        caller = file;
        break;
      }
    }

    if (caller) {
      reached++;
      if (KNOWN_UNCALLED[key]) {
        /**
         * 🔴 THE REVERSE CHECK, and it is the half that keeps the list
         * honest. An exemption that is no longer true is a claim in the
         * repository that has quietly become false — the same reasoning
         * `check-env-catalogue.mjs` applies to its KNOWN_UNREAD list.
         */
        findings.push(
          `${key} — listed in KNOWN_UNCALLED as unreachable, but ${caller} calls it. ` +
            `Delete the exemption; it is now a false statement about this codebase.`,
        );
      }
      continue;
    }

    if (KNOWN_UNCALLED[key]) {
      exempted.push(`${key} — ${KNOWN_UNCALLED[key]}`);
      continue;
    }

    findings.push(
      `${key} — exported by an observability module and called by NOTHING in ` +
        `${SEARCH_DIRS.join(", ")}. An observability export with no caller is a ` +
        `monitoring system that reports everything is fine.`,
    );
  }
}

/* ================================================================== */
/* ⑤ SECOND CHECK: docs/SLOS.md HAS NOT DRIFTED FROM slo.ts            */
/* ================================================================== */

/**
 * ⚠️ TWO LISTS KEPT IN STEP BY DISCIPLINE IS THE DEFECT THAT PRODUCED
 * MIGRATION 0091. `lib/platform/env-catalog.ts` records it in those words,
 * and by v1.65.0-alpha that catalogue had drifted from the code by
 * fourteen names.
 *
 * `docs/SLOS.md` is the document somebody reads during an incident and
 * quotes in a customer conversation. A target that says 99.9% there and
 * 0.995 in `server/observability/slo.ts` is a promise nobody is keeping
 * and nobody knows they are not keeping.
 *
 * ⭐ SO EVERY OBJECTIVE'S ID, TARGET AND WINDOW MUST APPEAR IN THE
 * DOCUMENT, VERBATIM. This is deliberately a text search rather than a
 * parse: the document is prose, and demanding a machine-readable block
 * inside it would produce a machine-readable block that nobody reads
 * beside prose that drifts anyway.
 */
const SLO_SOURCE = "server/observability/slo.ts";
const SLO_DOC = "docs/SLOS.md";

if (existsSync(join(ROOT, SLO_SOURCE)) && existsSync(join(ROOT, SLO_DOC))) {
  const sloCode = codeOnly(readFileSync(join(ROOT, SLO_SOURCE), "utf8"));
  const doc = readFileSync(join(ROOT, SLO_DOC), "utf8");

  const declared = [
    ...sloCode.matchAll(
      /id:\s*"([a-z][a-z0-9_.]*)"[\s\S]{0,900}?target:\s*([0-9.]+)[\s\S]{0,400}?windowDays:\s*(\d+)/g,
    ),
  ];

  if (declared.length === 0) {
    findings.push(
      `${SLO_SOURCE} — the objective matcher found ZERO objectives. Either the ` +
        `catalogue is empty or this check has stopped working; both mean the ` +
        `documentation agreement below is vacuous.`,
    );
  }

  /**
   * ⚠️ 🔴 SECTION-SCOPED, AND THE FIRST VERSION WAS NOT.
   *
   * The first draft asked "does the string 99.5% appear anywhere in the
   * document". It passed a doc whose target table had been changed to
   * 99.9% — because 99.5% still appeared once, in a runbook sentence
   * three sections away. A whole-document search for a number that occurs
   * in prose is the `count(*) >= 10` defect wearing a different hat, and
   * it was committed here, in the gate written to catch that defect.
   *
   * So the document is split on `## ` headings and each objective's
   * numbers must appear in ITS OWN section.
   */
  const sections = doc.split(/\n## /);

  for (const [, id, target, windowDays] of declared) {
    /**
     * ⚠️ THE SECTION WHOSE *HEADING* NAMES THE OBJECTIVE, not the first
     * section that mentions it anywhere. The preamble of `docs/SLOS.md`
     * lists every objective in a table, so a first-match search always
     * landed on the preamble — which carries no targets — and reported
     * every objective as undocumented. A check that fails for the wrong
     * reason is a check people learn to re-run instead of read.
     */
    const section =
      sections.find((chunk) => chunk.split("\n")[0]?.includes(`\`${id}\``)) ??
      sections.find((chunk) => chunk.includes(`\`${id}\``));
    if (!section) {
      findings.push(
        `${SLO_DOC} — has no \`## \` section mentioning the objective \`${id}\`.`,
      );
      continue;
    }

    // 0.995 -> "99.5%", 0.99 -> "99%" or "99.0%". Both spellings accepted;
    // a doc that writes the number a third way is a doc worth failing on.
    const asPercent = Number(target) * 100;
    const spellings = [`${asPercent}%`, `${asPercent.toFixed(1)}%`, `${asPercent.toFixed(2)}%`];
    /**
     * ⚠️ 🔴 THE TARGET IS READ OUT OF THE `| Target | … |` TABLE ROW, NOT
     * OUT OF THE SECTION'S PROSE, AND THE SECOND ATTEMPT AT THIS CHECK
     * STILL GOT IT WRONG.
     *
     * Scoping the search to the section was not enough: section 1 contains
     * the sentence "Why 99.5% and not 99.9%", so changing the table row to
     * 99.9% and leaving that sentence intact still passed. Twice now this
     * check has been satisfied by a string that was not the claim.
     *
     * The row is the claim. Prose may discuss any number it likes.
     */
    const targetRow = section.match(/\|\s*Target\s*\|([^|]*)\|/);
    const windowRow = section.match(/\|\s*Window\s*\|([^|]*)\|/);

    if (!targetRow) {
      findings.push(
        `${SLO_DOC} — the section for \`${id}\` has no "| Target | … |" row. That row ` +
          `is the machine-checkable half of this document; without it the objective is ` +
          `prose and can say anything.`,
      );
    } else if (!spellings.some((spelling) => targetRow[1].includes(spelling))) {
      findings.push(
        `${SLO_DOC} — the section for \`${id}\` states a target of "${targetRow[1].trim()}" ` +
          `and ${SLO_SOURCE} declares ${spellings.join(" or ")}. A target that disagrees ` +
          `with the code is a promise nobody knows they are not keeping.`,
      );
    }

    if (!windowRow) {
      findings.push(`${SLO_DOC} — the section for \`${id}\` has no "| Window | … |" row.`);
    } else if (!windowRow[1].includes(`${windowDays} days`)) {
      findings.push(
        `${SLO_DOC} — the section for \`${id}\` states a window of "${windowRow[1].trim()}" ` +
          `and ${SLO_SOURCE} declares ${windowDays} days.`,
      );
    }
  }
}

/* ================================================================== */
/* ⑥ THIRD CHECK: EVERY ALERT'S RUNBOOK IS IN docs/RUNBOOK.md           */
/* ================================================================== */

/**
 * ⭐ AN ALERT WHOSE RUNBOOK IS NOT IN THE DOCUMENT IS AN ALERT THE ON-CALL
 * CANNOT ACTION, AND THE DATABASE WILL STILL LET IT FIRE.
 *
 * `observability_alerts.runbook_key` is NOT NULL with a length CHECK, so no
 * alert can exist without NAMING a runbook. That guarantees the key exists;
 * it says nothing about whether anybody wrote the paragraph down where the
 * person woken at 3am will look for it.
 *
 * ⚠️ `docs/RUNBOOK.md` IS NOT TRACK B'S FILE. It lives on the assembled tree
 * with ten sections of somebody else's content. So this check is
 * conditional — and the condition is REPORTED IN THE SUMMARY LINE rather
 * than skipped silently, because a check that quietly does nothing is the
 * defect this whole gate exists for. On a tree without the document it says
 * so out loud; on the assembled tree it fails until the section generated by
 * `server/observability/runbook-section.mjs` has been merged.
 */
const RUNBOOK_SOURCE = "server/observability/alerts.ts";
const RUNBOOK_DOC = "docs/RUNBOOK.md";
let runbookNote = "";

if (existsSync(join(ROOT, RUNBOOK_SOURCE))) {
  const alertsSrc = readFileSync(join(ROOT, RUNBOOK_SOURCE), "utf8");
  const union = alertsSrc.match(/export type RunbookKey =([\s\S]*?);/);
  const keys = union ? [...union[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]) : [];

  if (keys.length === 0) {
    findings.push(
      `${RUNBOOK_SOURCE} — the RunbookKey union could not be read, so the runbook check ` +
        `below is vacuous. That is worse than no check.`,
    );
  } else if (!existsSync(join(ROOT, RUNBOOK_DOC))) {
    runbookNote =
      `; ${RUNBOOK_DOC} is absent from this tree — ${keys.length} runbook(s) are ready to ` +
      `merge via server/observability/runbook-section.mjs`;
  } else {
    const doc = readFileSync(join(ROOT, RUNBOOK_DOC), "utf8");
    const missing = keys.filter((k) => !doc.includes(k));
    for (const key of missing) {
      findings.push(
        `${RUNBOOK_DOC} — no runbook for the alert key \`${key}\`. The database will let ` +
          `that alert fire and the on-call has nowhere to look. Regenerate the section: ` +
          `node server/observability/runbook-section.mjs`,
      );
    }
    if (missing.length === 0) runbookNote = `; all ${keys.length} runbook(s) are in ${RUNBOOK_DOC}`;
  }
}

/* ================================================================== */
/* ⑦ FOURTH CHECK: EVERY RUNBOOK IS ACTUALLY RAISED BY SOMETHING        */
/* ================================================================== */

/**
 * ⭐ THE MIRROR OF `check-security-events.mjs`, WHICH FAILS ON A DECLARED
 * SECURITY EVENT THAT NOTHING EMITS.
 *
 * A runbook with no emitter is the same defect one layer up: a paragraph in
 * `docs/RUNBOOK.md` describing what to do when an alert fires, for an alert
 * that cannot fire. It reads as coverage. Ten declared security event types
 * spent a phase in exactly that state and every dashboard built on them was
 * green.
 *
 * ⚠️ THIS CHECK REMOVED ONE OF TRACK B'S OWN RUNBOOKS ON ITS FIRST RUN.
 * `scheduler-silent` was written for "the scheduler has not checked in" and
 * nothing raised it, because raising it correctly needs the return contract
 * of Track A's `scheduler_watchdog_status()`, which Track B does not have.
 * Deleted rather than left: a runbook for an alert nobody can raise is the
 * thing this check exists to refuse.
 */
if (existsSync(join(ROOT, RUNBOOK_SOURCE))) {
  const alertsSrc = codeOnly(readFileSync(join(ROOT, RUNBOOK_SOURCE), "utf8"));
  const union = alertsSrc.match(/export type RunbookKey =([\s\S]*?);/);
  const keys = union ? [...union[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]) : [];

  /*
   * An emitter is `runbook: "key"` at a raiseAlert() call site, or an entry
   * in the SLO→runbook map, which raiseBurnAlert() reads. Both are value
   * positions; the RUNBOOKS object literal itself is a declaration and is
   * excluded, which is the same distinction check-security-events.mjs draws
   * between an emission and a ruleId.
   */
  const emitterCorpus = [...corpus.entries()]
    .filter(([file]) => file.startsWith("server/") || file.startsWith("app/") || file.startsWith("lib/"))
    .map(([, text]) => text)
    .join("\n");
  const declarationBlock = alertsSrc.slice(
    alertsSrc.indexOf("export const RUNBOOKS"),
    alertsSrc.indexOf("const RUNBOOK_FOR_SLO"),
  );
  const emitted = new Set(
    [...emitterCorpus.replace(declarationBlock, " ").matchAll(/runbook(?:_key)?:\s*"([a-z-]+)"/g)].map(
      (m) => m[1],
    ),
  );
  /*
   * ⚠️ THE CHARACTER CLASS INCLUDES DIGITS AND UNDERSCORES, AND THE FIRST
   * VERSION DID NOT. `"route.latency_p95": "slo-latency",` did not match
   * `/"[a-z.]+":/`, so the gate reported a mapped runbook as unraised — a
   * false finding, confidently worded, about an entry that was correct.
   */
  const mapped = new Set(
    [...alertsSrc.matchAll(/"[a-z0-9._]+":\s*"([a-z-]+)",/g)].map((m) => m[1]),
  );

  /**
   * ⚠️ EXEMPTIONS, EACH WITH A SENTENCE AND A DELETION CONDITION — the same
   * shape as KNOWN_UNCALLED above, and reversed the same way: an exemption
   * that has become false is reported, not tolerated.
   */
  const KNOWN_UNRAISED = {
    "security-event-unrecorded":
      "🔴 ITS ONLY EMITTER IS IN PATCH-REQUEST-B ITEM ⑨, inside the listener that server/security/alerting.ts already registers — a file Track B does not own. Chaining there rather than registering a second listener is deliberate: onSecurityRecordFailure() holds ONE listener and a second registration replaces the first, silently, with nothing thrown. Proven both ways in tests/security/observability-alert-chaining.test.ts. DELETE THIS ENTRY when the patch lands; the check below will tell you to.",
  };

  for (const key of keys) {
    if (emitted.has(key) || mapped.has(key)) {
      if (KNOWN_UNRAISED[key]) {
        findings.push(
          `${RUNBOOK_SOURCE} — the runbook \`${key}\` is listed in KNOWN_UNRAISED as having ` +
            `no emitter, and something now raises it. Delete the exemption; it is a false ` +
            `statement about this codebase.`,
        );
      }
      continue;
    }
    if (KNOWN_UNRAISED[key]) {
      exempted.push(`${RUNBOOK_SOURCE}#runbook:${key} — ${KNOWN_UNRAISED[key]}`);
      continue;
    }
    findings.push(
      `${RUNBOOK_SOURCE} — the runbook \`${key}\` is declared and nothing raises an alert ` +
        `with it. A paragraph telling the on-call what to do about an alert that cannot ` +
        `fire reads as coverage. Raise it, or delete the runbook.`,
    );
  }
}

if (checked === 0) {
  console.error(
    "::error::check:observability-callers parsed ZERO runtime exports from " +
      `${watched.length} watched file(s). The export matcher is broken; a green ` +
      "result here would mean nothing. Refusing to pass.",
  );
  process.exit(1);
}

/* ================================================================== */
/* ⑤ THE REPORT                                                        */
/* ================================================================== */

if (seams.length > 0) {
  console.log(`  test seams, exempt by naming convention (${seams.length}):`);
  for (const s of seams) console.log(`    · ${s}`);
}

if (exempted.length > 0) {
  console.log(`  exempt, each with a written reason (${exempted.length}):`);
  for (const e of exempted) console.log(`    · ${e}`);
}

if (findings.length > 0) {
  console.error("\ncheck:observability-callers FAILED\n");
  for (const f of findings) console.error(`  ✗ ${f}`);
  console.error(
    `\n${findings.length} problem(s) across ${watched.length} watched file(s). ` +
      `Each finding above says what to do about ITSELF — this footer is not the ` +
      `instruction. For an uncalled export: call it from the surface it was written ` +
      `for, delete it, or add it to KNOWN_UNCALLED with a sentence saying why it is ` +
      `unreachable on purpose. For a stale exemption: delete the exemption. Do not ` +
      `add an entry to silence a finding that told you to remove one.\n`,
  );
  process.exit(1);
}

console.log(
  `check:observability-callers — ${watched.length} watched file(s), ${checked} runtime ` +
    `export(s), ${reached} with a caller, ${exempted.length} exempt with a reason, ` +
    `${seams.length} test seam(s); docs/SLOS.md agrees with server/observability/slo.ts` +
    `${runbookNote}.`,
);
