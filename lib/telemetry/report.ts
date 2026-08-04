/**
 * Ordence — Server-Side Telemetry Capture
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE RULE: A MONITORING SYSTEM MUST NOT BE ABLE TO TAKE THE APP DOWN
 * ══════════════════════════════════════════════════════════════════════
 * Every function exported here returns a result object and NEVER throws
 * and NEVER rejects. Not "should not" — cannot, by construction, because
 * the entire body is inside a try/catch whose catch returns.
 *
 * That is not defensive padding. Telemetry runs in the WORST possible
 * place: inside error handlers, inside catch blocks, inside error
 * boundaries. Those are exactly the moments when the database is already
 * refusing connections, and a `captureError()` that throws while handling
 * an error produces a second exception with the first one's stack
 * discarded — the classic "the logger ate the bug" failure, where the
 * only trace of the real outage is a stack pointing at the logger.
 *
 * Concretely, this file must survive all of:
 *   • DATABASE_URL absent (a preview deploy, a unit test)
 *   • the database being the thing that is down
 *   • a CHECK constraint rejecting a row
 *   • `tenants` no longer containing the tenant id we were handed
 *   • being called from a context where `getServerEnv()` itself throws
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE WRITE IS NOT AWAITED BY THE CALLER'S CRITICAL PATH
 * ══════════════════════════════════════════════════════════════════════
 * `captureError` is awaitable, because a route handler that returns
 * before its telemetry write lands on a serverless platform gets the
 * function frozen mid-INSERT and loses the event. But `captureErrorSync`
 * exists for call sites that genuinely cannot wait (a React error
 * boundary, a render path), and it deliberately drops the promise after
 * attaching a no-op catch — an unhandled rejection in Node is a process
 * crash, so the `.catch()` there is load-bearing rather than tidy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO SDK
 * ══════════════════════════════════════════════════════════════════════
 * An error-tracking SDK installs global handlers, monkey-patches fetch,
 * and ships whatever it collects to a vendor. In a CRM holding Indian
 * customer data, every one of those is a decision about cross-border
 * transfer of personal data that a package install should not be making.
 * This writes structured, allow-listed rows into our own Postgres. The
 * cost is that we build the dashboards; the benefit is that we can say
 * exactly what leaves the system, which is "nothing".
 */

import "server-only";

import {
  scrubText,
  scrubStack,
  scrubUrl,
  scrubMetadata,
  fingerprintError,
  MAX_MESSAGE_LENGTH,
} from "./scrub";

/* ================================================================== */
/* TYPES                                                               */
/* ================================================================== */

export type TelemetrySeverity = "fatal" | "error" | "warning";
export type TelemetrySource = "client" | "server" | "edge" | "worker";

export type CaptureErrorInput = {
  /** The thrown value. Anything — JS lets you throw a number. */
  error: unknown;
  severity?: TelemetrySeverity;
  source?: TelemetrySource;
  /** Raw path or URL. Scrubbed to a pattern before storage. */
  route?: string | null;
  /** Resolved tenant, or null/undefined when there is none. */
  tenantId?: string | null;
  userId?: string | null;
  /** Filtered against `TELEMETRY_METADATA_KEYS`. */
  metadata?: Record<string, unknown> | null;
  /** Override the computed grouping key. */
  fingerprintHint?: string | null;
  occurredAt?: Date;
};

export type CaptureEventInput = {
  /**
   * A short, STATIC label — `"invoice.pdf.render_failed"`, never an
   * interpolated string. This becomes the message column and, through it,
   * a grouping key; interpolating an id here reintroduces exactly the
   * unbounded cardinality the fingerprint scheme exists to prevent.
   */
  name: string;
  severity?: TelemetrySeverity;
  source?: TelemetrySource;
  route?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CaptureResult =
  | { ok: true; fingerprint: string }
  /**
   * `ok: false` carries a COARSE reason, never the underlying database
   * error. Callers are error handlers; handing them a driver message
   * invites it into a user-facing response, and a Postgres error can
   * contain a row value.
   */
  | { ok: false; reason: "disabled" | "invalid" | "write_failed" };

/* ================================================================== */
/* ENVIRONMENT                                                         */
/* ================================================================== */

/**
 * Deploy identity. Vercel populates VERCEL_GIT_COMMIT_SHA; everything
 * else falls back to "unknown" rather than to a timestamp, because a
 * release label that changes on every boot makes "did the fix ship?"
 * unanswerable — which is the only question the column is for.
 */
function currentRelease(): string {
  const sha =
    process.env.TELEMETRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_RELEASE;
  return (sha ?? "unknown").slice(0, 80);
}

function currentEnvironment(): string {
  return (process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development").slice(0, 24);
}

/**
 * The kill switch.
 *
 * WHY OPT-OUT AND NOT OPT-IN: telemetry that has to be switched on is
 * telemetry that is off in the one environment where it mattered. But it
 * must be switchable off in a single environment variable, because the
 * first thing you want during a write-amplification incident is to stop
 * the highest-volume writer in the system without a deploy.
 */
function telemetryEnabled(): boolean {
  return process.env.TELEMETRY_DISABLED !== "true";
}

/* ================================================================== */
/* NORMALISATION                                                       */
/* ================================================================== */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A tenant id that is not a uuid must become NULL, not be passed through.
 *
 * The alternative — letting it reach the INSERT — turns a typo into a
 * foreign-key violation that fails the whole capture, so an error handler
 * with a slightly wrong tenant id would silently record nothing at all.
 * A null-tenant row is still a recorded error.
 */
function normaliseId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return UUID_RE.test(value) ? value : null;
}

/**
 * Pull a message/stack/name out of anything a `throw` can produce.
 *
 * `throw "boom"`, `throw { code: 42 }` and `throw undefined` are all
 * legal JavaScript and all reach real catch blocks — usually from a
 * third-party library. Assuming `error instanceof Error` here would mean
 * the least-diagnosable failures are the ones we fail to record.
 */
export function describeThrown(error: unknown): {
  name: string;
  message: string;
  stack: string | null;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      stack: typeof error.stack === "string" ? error.stack : null,
    };
  }

  if (typeof error === "string") {
    return { name: "ThrownString", message: error, stack: null };
  }

  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "ThrownObject",
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : safeStringify(error),
      stack: typeof candidate.stack === "string" ? candidate.stack : null,
    };
  }

  return { name: "ThrownValue", message: String(error), stack: null };
}

/**
 * `JSON.stringify` throws on a circular structure, and a circular thrown
 * object is common (a DOM node, a driver error holding its connection).
 * A throw here would defeat the whole no-throw contract at the exact
 * moment it matters.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, MAX_MESSAGE_LENGTH) ?? "[unserialisable]";
  } catch {
    return "[unserialisable]";
  }
}

/**
 * Build the row WITHOUT touching the database.
 *
 * Split out from `captureError` on purpose: it is pure, synchronous and
 * therefore directly unit-testable. The assertion "no PII survives" is
 * about this function, and testing it through a database write would make
 * that assertion depend on a live Postgres.
 */
export function buildErrorRow(input: CaptureErrorInput): {
  fingerprint: string;
  message: string;
  errorName: string;
  stack: string | null;
  severity: TelemetrySeverity;
  source: TelemetrySource;
  routePattern: string | null;
  tenantId: string | null;
  userId: string | null;
  release: string;
  environment: string;
  occurredAt: Date;
  metadata: Record<string, string | number | boolean>;
} {
  const described = describeThrown(input.error);

  return {
    fingerprint: fingerprintError({
      message: described.message,
      stack: described.stack,
      name: described.name,
      fingerprintHint: input.fingerprintHint ?? null,
    }),
    // `|| "(no message)"` because the column is NOT NULL with a
    // char_length >= 1 CHECK, and an error whose message scrubs down to
    // nothing must still be recorded — the stack is the useful half.
    message: scrubText(described.message) || "(no message)",
    errorName: described.name.slice(0, 120),
    stack: scrubStack(described.stack),
    severity: input.severity ?? "error",
    source: input.source ?? "server",
    routePattern: input.route ? scrubUrl(input.route) : null,
    tenantId: normaliseId(input.tenantId),
    userId: normaliseId(input.userId),
    release: currentRelease(),
    environment: currentEnvironment(),
    occurredAt: input.occurredAt ?? new Date(),
    metadata: scrubMetadata(input.metadata),
  };
}

/* ================================================================== */
/* CAPTURE                                                             */
/* ================================================================== */

/**
 * Record an error. Never throws, never rejects.
 *
 * ⚠️ THE WRITE PATH DELIBERATELY DOES NOT USE `withTenant()`.
 *
 * `withTenant` opens a WebSocket pool and a real transaction. Doing that
 * from inside an error handler — potentially thousands of times during an
 * incident, when the error IS the database — turns a bad minute into an
 * outage by exhausting connections. It also cannot be used at all for the
 * null-tenant rows, which are the ones produced when auth itself failed.
 *
 * So the insert goes through the HTTP client under `withPlatformScope`,
 * with the tenant id written EXPLICITLY as a column value that has
 * already been validated as a uuid. The row's attribution is therefore as
 * correct as the caller's, and RLS still governs every READ of these
 * tables from tenant sessions. The justification string is mandatory and
 * greppable, exactly as the reconciler's is.
 */
export async function captureError(input: CaptureErrorInput): Promise<CaptureResult> {
  if (!telemetryEnabled()) return { ok: false, reason: "disabled" };

  let row: ReturnType<typeof buildErrorRow>;
  try {
    row = buildErrorRow(input);
  } catch {
    // Scrubbing itself failed. Nothing safe to store.
    return { ok: false, reason: "invalid" };
  }

  try {
    // Imported lazily so that merely importing this module does not
    // construct a database client. Without that, a unit test or a preview
    // build with no DATABASE_URL fails at IMPORT time — before any
    // try/catch of ours can run — and the no-throw contract is a lie.
    const { withPlatformScope } = await import("@/db");
    const { errorEvents } = await import("@/db/schema/telemetry");

    await withPlatformScope(
      "telemetry error capture: writes an explicitly-scoped diagnostics row, " +
        "including null-tenant rows produced when auth itself failed",
      async (database) => {
        await database.insert(errorEvents).values(row);
      },
    );

    return { ok: true, fingerprint: row.fingerprint };
  } catch (writeError) {
    // ⚠️ console, not a re-throw, and not a recursive captureError().
    // Reporting a telemetry failure through telemetry is an infinite
    // loop that ends in an out-of-memory kill.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[telemetry] error capture failed (swallowed by design):",
        writeError instanceof Error ? writeError.message : String(writeError),
      );
    }
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Record a non-exception event of interest — a degraded path, a retry
 * exhaustion, a quota refusal. Same guarantees.
 *
 * It funnels into `captureError` with a synthetic Error so there is ONE
 * write path and ONE scrubbing pass. Two capture paths means two places
 * for a PII rule to be applied, which historically means one.
 */
export async function captureEvent(input: CaptureEventInput): Promise<CaptureResult> {
  const synthetic = new Error(input.name);
  // No stack: it would point at this line for every event, which groups
  // every distinct event name into one fingerprint. The hint below is
  // what actually does the grouping.
  synthetic.stack = undefined;
  synthetic.name = "TelemetryEvent";

  return captureError({
    error: synthetic,
    severity: input.severity ?? "warning",
    source: input.source ?? "server",
    route: input.route,
    tenantId: input.tenantId,
    userId: input.userId,
    metadata: input.metadata,
    fingerprintHint: `event:${input.name}`,
  });
}

/**
 * Fire-and-forget variant for call sites that cannot await — a render
 * path, an error boundary, a `finally` block.
 *
 * The `.catch()` is NOT decoration. An unhandled promise rejection
 * terminates a Node process by default since Node 15, so a floating
 * promise from the telemetry path would be a way for the monitoring
 * system to crash the server — the precise failure this whole file is
 * written to prevent.
 *
 * ⚠️ On a serverless platform the function may freeze before this
 * resolves, and the event is then lost. That trade is accepted here and
 * NOT accepted in the ingest route, which awaits its write.
 */
export function captureErrorSync(input: CaptureErrorInput): void {
  void captureError(input).catch(() => {
    /* unreachable — captureError never rejects — but belt and braces */
  });
}
