/**
 * Ordence — Structured logging with tenant identity
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT DEBUGGING A TENANT-SPECIFIC ISSUE COSTS TODAY
 * ══════════════════════════════════════════════════════════════════════
 * Every log line this product writes is a sentence. `instrumentation.ts`
 * writes `[ordence:error] TenantAccessError: … | route=/dashboard`,
 * `server/audit.ts` writes `[AUDIT WRITE FAILED]`, `db/index.ts` writes
 * `[PLATFORM SCOPE] Reading across tenants: <reason>`, and
 * `server/security/alerting.ts` writes `[ORDENCE-SECURITY-ALERT] …`.
 *
 * Not one of them names the workspace. So "Acme says the invoice screen
 * has been failing since Tuesday" is answered by reading every error line
 * in the window and guessing which ones are theirs — and in a product
 * where one process serves every customer, the global picture and one
 * customer's picture are different pictures.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE CONTEXT IS A REQUIRED PARAMETER, NOT AN OPTIONAL BAG
 * ══════════════════════════════════════════════════════════════════════
 * `log()` cannot be called without passing tenant, user, request, trace,
 * route and outcome. Each may be `null` — a boot-time event genuinely has
 * no tenant — but `null` has to be WRITTEN, which makes "there is no
 * tenant here" a claim somebody made rather than a field somebody forgot.
 *
 * An optional context object would have been friendlier and would have
 * produced exactly the log we already have: the call sites that most need
 * the tenant are the ones written in a hurry during an incident.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 REDACTION IS A POSITIVE ALLOW-LIST. THIS IS NOT NEGOTIABLE.
 * ══════════════════════════════════════════════════════════════════════
 * `LOG_FIELDS` below is the complete set of keys that may appear in a log
 * line, each with the SHAPE its value must have. Anything else is
 * dropped.
 *
 * A deny-list of forbidden keys fails silently on the field added next
 * month, and it fails in the direction that cannot be undone: a log drain
 * is append-only, replicated, and read by people who are not the ones who
 * added the field. `lib/telemetry/scrub.ts` made the same choice for
 * `metadata` and states the same reason; this is that decision applied to
 * the second place structured data leaves the process.
 *
 * ⚠️ AND THE DROP IS COUNTED, NOT SILENT. A line that dropped fields
 * carries `dropped: <n>`. A redactor nobody can see working is one nobody
 * notices has stopped.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY JSON AND NOT THE SENTENCE STYLE THE REST OF THE REPO USES
 * ══════════════════════════════════════════════════════════════════════
 * Because the question is "show me every line for tenant X in the last
 * hour, with its outcome", and no amount of grep gets that out of prose.
 * Every line carries `"src":"ordence"`, so the old habit — grep the log
 * drain for a literal string — still works.
 *
 * ⚠️ PURE AND EDGE-SAFE. No `server-only`, no `node:` imports, no
 * database. It must be callable from middleware, from a route handler,
 * from a job and from `instrumentation.ts`, and a module that cannot be
 * imported from one of those is a module those call sites will not use.
 */

import { scrubText } from "./scrub";

/* ================================================================== */
/* LEVELS                                                              */
/* ================================================================== */

/**
 * ⚠️ NOT EXPORTED. The type below is what consumers need; the array is an
 * implementation detail of the type. `check:observability-callers`
 * reported it as an export with no caller and it was right — an exported
 * constant nobody reads is the same defect as an exported function nobody
 * calls, one size smaller.
 */
const LOG_LEVELS = ["debug", "info", "notice", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  notice: 30,
  warn: 40,
  error: 50,
};

/**
 * Outcome is a CLOSED vocabulary, not free text.
 *
 * ⚠️ The whole reason to record an outcome is to divide a denominator by
 * it. `"ok"` and `"success"` and `"OK"` in the same table is three
 * denominators and no availability number, and nothing would ever have
 * told you — the query returns a result either way.
 */
/**
 * ⚠️ NOT EXPORTED, for the same reason as `LOG_LEVELS`. Consumers need the
 * TYPE and, at runtime, the SET below — which is what actually refuses an
 * unknown outcome before the `request_outcomes_outcome_known` CHECK
 * constraint has to. The array itself has no reader outside this file.
 */
const LOG_OUTCOMES = [
  "ok",
  /** The caller asked for something it was not allowed to have. Not our fault, not an outage. */
  "denied",
  /** The caller sent something invalid. 4xx. Excluded from the availability SLO on purpose. */
  "invalid",
  /** We failed. 5xx. This is what burns the error budget. */
  "failed",
  /** Refused by a limiter or a quota. Deliberate, and separate from "failed". */
  "throttled",
  /** Deliberately not done: feature not entitled, job skipped, tenant suspended. */
  "skipped",
] as const;
export type LogOutcome = (typeof LOG_OUTCOMES)[number];

/** Exported so a caller can refuse an unknown outcome BEFORE the database does. */
export const LOG_OUTCOME_SET: ReadonlySet<string> = new Set(LOG_OUTCOMES);
const OUTCOME_SET = LOG_OUTCOME_SET;

/* ================================================================== */
/* THE ALLOW-LIST                                                      */
/* ================================================================== */

/**
 * The shape a value must have to be logged under a given key.
 *
 *   hex32   — a trace id
 *   uuid    — a tenant, user or request id we generated
 *   route   — an already-scrubbed route PATTERN, never a raw URL
 *   word    — a short symbolic token: an event name, a job id, a status
 *   int     — a finite integer: a duration, a count, a status code
 *   bool    — a flag
 *   text    — bounded free text, run through `scrubText`
 */
type FieldKind = "hex32" | "uuid" | "route" | "word" | "int" | "bool" | "text";

/**
 * 🔴 THE COMPLETE SET OF LOGGABLE KEYS.
 *
 * Adding one is a decision about what is in the log drain forever.
 * Everything not named here is dropped, including — deliberately — every
 * key that sounds harmless: `email`, `name`, `query`, `body`, `params`,
 * `headers`, `payload`, `input`, `result`.
 */
export const LOG_FIELDS: Readonly<Record<string, FieldKind>> = {
  /* --- identity: the five the brief demands, plus the trace --- */
  requestId: "uuid",
  traceId: "hex32",
  spanId: "word",
  tenantId: "uuid",
  userId: "uuid",
  route: "route",
  outcome: "word",

  /* --- what happened --- */
  event: "word",
  component: "word",
  action: "word",
  status: "int",
  durationMs: "int",
  attempt: "int",
  count: "int",

  /* --- background work --- */
  jobId: "word",
  queue: "word",
  cadence: "word",

  /* --- diagnosis --- */
  errorName: "word",
  /** Bounded, scrubbed. An exception MESSAGE — never a record's contents. */
  reason: "text",
  digest: "word",
  provider: "word",

  /* --- observability's own bookkeeping --- */
  slo: "word",
  burnRate: "int",
  runbook: "word",
  degraded: "bool",
} as const;

export type LogField = keyof typeof LOG_FIELDS;

/* ================================================================== */
/* VALIDATION                                                          */
/* ================================================================== */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/;
/**
 * A "word": lowercase-ish symbolic token. Colons and dots are allowed
 * because the event vocabulary in this repo already uses them
 * (`rate_limit.exceeded`, `contacts:create`).
 */
const WORD_RE = /^[A-Za-z0-9_.:@-]{1,80}$/;
/**
 * A route PATTERN — what `scrubUrl()` produces. A raw URL is refused
 * rather than scrubbed here, because scrubbing at the sink means the call
 * site never learns it passed one, and the next sink will not scrub.
 */
const ROUTE_RE = /^\/[A-Za-z0-9_./:()[\]-]{0,200}$/;

const MAX_TEXT = 300;

function coerce(kind: FieldKind, value: unknown): string | number | boolean | null {
  switch (kind) {
    case "uuid":
      return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
    case "hex32":
      return typeof value === "string" && HEX32_RE.test(value) ? value : null;
    case "word":
      return typeof value === "string" && WORD_RE.test(value) ? value : null;
    case "route":
      return typeof value === "string" && ROUTE_RE.test(value) ? value : null;
    case "int":
      return typeof value === "number" && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
    case "bool":
      return typeof value === "boolean" ? value : null;
    case "text": {
      if (typeof value !== "string") return null;
      const scrubbed = scrubText(value, MAX_TEXT);
      return scrubbed.length > 0 ? scrubbed : null;
    }
    default:
      return null;
  }
}

/* ================================================================== */
/* THE CONTEXT EVERY LINE CARRIES                                      */
/* ================================================================== */

/**
 * 🔴 EVERY FIELD IS REQUIRED. `null` is an answer; omission is not.
 */
export type LogContext = {
  requestId: string | null;
  traceId: string | null;
  tenantId: string | null;
  userId: string | null;
  /** A route pattern from `scrubUrl()`, or null for work with no route. */
  route: string | null;
  outcome: LogOutcome;
};

/** Anything else. Filtered against `LOG_FIELDS` and dropped if unknown. */
export type LogExtras = Record<string, unknown>;

export type LogRecord = {
  ts: string;
  lvl: LogLevel;
  src: "ordence";
  evt: string;
} & Record<string, unknown>;

/* ================================================================== */
/* BUILD                                                               */
/* ================================================================== */

/**
 * Build the record WITHOUT emitting it.
 *
 * Split out for the same reason `buildErrorRow()` is: the assertion
 * "nothing outside the allow-list survives" is about this function, and a
 * test that had to capture stdout to make it would be a test people
 * disable.
 *
 * Never throws.
 */
export function buildLogRecord(
  level: LogLevel,
  event: string,
  context: LogContext,
  extras: LogExtras = {},
  now: Date = new Date(),
): LogRecord {
  const record: LogRecord = {
    ts: now.toISOString(),
    lvl: level,
    src: "ordence",
    // The event name is the grouping key. It goes through the same `word`
    // shape as everything else; an event name that fails it becomes
    // "unnamed", which is visible, rather than being dropped, which is not.
    evt: (coerce("word", event) as string | null) ?? "unnamed",
  };

  let dropped = 0;

  // ⚠️ CONTEXT FIRST, AND EXTRAS CANNOT OVERWRITE IT. A caller passing
  // `{ tenantId: someOtherTenant }` in extras would otherwise relabel the
  // line — which is the one way this could produce a log that is worse
  // than no log.
  const contextEntries: Array<[string, unknown]> = [
    ["requestId", context.requestId],
    ["traceId", context.traceId],
    ["tenantId", context.tenantId],
    ["userId", context.userId],
    ["route", context.route],
    ["outcome", OUTCOME_SET.has(context.outcome) ? context.outcome : null],
  ];

  for (const [key, value] of contextEntries) {
    if (value === null || value === undefined) {
      // Written explicitly. An absent key reads as "not applicable"; an
      // explicit null reads as "asked, and there was none".
      record[key] = null;
      continue;
    }
    const kind = LOG_FIELDS[key];
    const coerced = kind ? coerce(kind, value) : null;
    if (coerced === null) {
      record[key] = null;
      dropped++;
      continue;
    }
    record[key] = coerced;
  }

  try {
    for (const [key, value] of Object.entries(extras)) {
      if (key in record) continue; // never overwrite context
      const kind = LOG_FIELDS[key];
      if (!kind) {
        dropped++;
        continue;
      }
      const coerced = coerce(kind, value);
      if (coerced === null) {
        dropped++;
        continue;
      }
      record[key] = coerced;
    }
  } catch {
    /* An exotic object with a throwing getter must not break the log. */
  }

  if (dropped > 0) record.dropped = dropped;

  return record;
}

/* ================================================================== */
/* EMIT                                                               */
/* ================================================================== */

/**
 * ⚠️ NO `ORDENCE_LOG_LEVEL` ENVIRONMENT VARIABLE, AND THE REASON IS WORTH
 * WRITING DOWN BECAUSE THE OMISSION LOOKS LIKE AN OVERSIGHT.
 *
 * A runtime log level is the obvious thing to add and it would have been
 * a NEW SETTING. `scripts/check-env-catalogue.mjs` fails the build on any
 * `process.env` read whose name is not in `lib/platform/env-catalog.ts` —
 * that catalogue is what `/api/diag` reports and what the rotation board
 * reads, and Track B does not own it. A new name here would turn a green
 * gate red in every other track's checkout until an unrelated patch
 * landed.
 *
 * So the level is derived from `NODE_ENV`, which every deployment already
 * sets and the catalogue already carries. `debug` is available where
 * somebody is watching a terminal and nowhere else, which is the only
 * place it was ever going to be read.
 *
 * ⭐ IF A RUNTIME SWITCH IS WANTED, IT IS ONE LINE HERE PLUS ONE
 * CATALOGUE ENTRY — see PATCH-REQUEST-B.md, which carries both.
 */
function minimumLevel(): LogLevel {
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

/**
 * Emit one line.
 *
 * ⚠️ `warn` AND `error` GO TO stderr, EVERYTHING ELSE TO stdout, and that
 * split is load-bearing on Railway: the deploy log shows stderr in red
 * and a platform that treats every line as an error teaches people to
 * ignore red. It is also why `notice` exists between `info` and `warn` —
 * "this is worth seeing and nothing is wrong" had nowhere to go.
 *
 * ⚠️ NEVER THROWS. Same contract as `lib/telemetry/report.ts`, for the
 * same reason: this gets called from catch blocks.
 */
export function log(
  level: LogLevel,
  event: string,
  context: LogContext,
  extras: LogExtras = {},
): void {
  try {
    if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel()]) return;
    const line = JSON.stringify(buildLogRecord(level, event, context, extras));
    if (level === "warn" || level === "error") console.error(line);
    else console.log(line);
  } catch {
    /* A logger that can take the process down is worse than no logger. */
  }
}

/** The context for work that genuinely has no request behind it. */
export function detachedContext(
  overrides: Partial<LogContext> & { outcome: LogOutcome },
): LogContext {
  return {
    requestId: overrides.requestId ?? null,
    traceId: overrides.traceId ?? null,
    tenantId: overrides.tenantId ?? null,
    userId: overrides.userId ?? null,
    route: overrides.route ?? null,
    outcome: overrides.outcome,
  };
}
