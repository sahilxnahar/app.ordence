import "server-only";

/**
 * Ordence — The request-scoped observability context
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `lib/telemetry/log.ts` refuses to write a line without a tenant, a
 * user, a request id, a trace id, a route and an outcome. That is the
 * right contract and it would be unusable if every call site had to
 * thread six values down through four layers to satisfy it.
 *
 * `AsyncLocalStorage` is how Node lets a value follow an async call chain
 * without a parameter. Enter the context once, at the top of a request or
 * a job, and anything underneath can ask for it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY `currentTrace()` RETURNS NULL RATHER THAN A DEFAULT
 * ══════════════════════════════════════════════════════════════════════
 * A "safe default" here would be a context with null tenant and a freshly
 * minted trace id. Every call site that forgot to enter the store would
 * then log successfully, with a trace id belonging to no request — and
 * the logs would look complete. The absence has to be visible at the call
 * site, because the call site is the only place that can fix it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ASYNCLOCALSTORAGE IS NODE-ONLY, AND THAT DECIDES WHERE THIS LIVES
 * ══════════════════════════════════════════════════════════════════════
 * `node:async_hooks` does not exist on the edge runtime, which is where
 * `middleware.ts` runs. That is precisely why the trace id is DERIVED
 * from the `x-request-id` middleware already sets (see
 * `lib/telemetry/trace.ts`) rather than being generated here and pushed
 * outward: the edge half of the request needs no import from this file to
 * participate.
 *
 * ⚠️ SO THE STATIC `node:async_hooks` IMPORT BELOW IS SAFE ONLY BECAUSE
 * OF THE `import "server-only"` ON LINE 1 AND THE FACT THAT NOTHING ON
 * THE EDGE PATH IMPORTS THIS FILE. `instrumentation.ts` reaches it
 * through a dynamic import inside `if (process.env.NEXT_RUNTIME ===
 * "nodejs")`, which is the same shape it already uses for the Sentry
 * Node integrations and for the same reason: a static top-level import
 * of a Node builtin breaks the edge bundle at BUILD time, with an error
 * that names neither this file nor the runtime.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  newSpanId,
  traceForRequest,
  formatTraceparent,
  parseTraceparent,
  isTraceId,
  isSpanId,
  TRACEPARENT_HEADER,
  type TraceIds,
} from "@/lib/telemetry/trace";
import type { LogContext, LogOutcome } from "@/lib/telemetry/log";

/* ================================================================== */
/* THE CONTEXT                                                         */
/* ================================================================== */

export type ObservabilityContext = {
  traceId: string;
  spanId: string;
  /** The uuid form, as `middleware.ts` minted it. Null for detached work. */
  requestId: string | null;
  tenantId: string | null;
  userId: string | null;
  /** A pattern from `scrubUrl()`, never a raw URL. */
  route: string | null;
  /** `"http"`, or a job id for scheduled work. Used to separate the two. */
  kind: "http" | "job" | "boot";
  /** Wall clock at entry, for duration. `Date.now()` is enough; this is not a benchmark. */
  startedAtMs: number;
};

/* ================================================================== */
/* THE STORE                                                           */
/* ================================================================== */

/**
 * ⚠️ ONE STORE PER PROCESS, CREATED AT MODULE LOAD.
 *
 * A lazily-created store would be created once per importer under some
 * bundler configurations, and two AsyncLocalStorage instances do not see
 * each other's values: the context would be present in the half of the
 * codebase that happened to load the same copy and silently absent in the
 * other, which reads as "logging works on some routes".
 */
const store = new AsyncLocalStorage<ObservabilityContext>();

/* ================================================================== */
/* ENTER                                                               */
/* ================================================================== */

/**
 * Enter an observability context for the duration of `fn`.
 *
 * Returns whatever `fn` returns and never changes it. A wrapper that can
 * alter the value it wraps is a wrapper people are right to refuse to put
 * on their critical path.
 */
export function runWithObservability<T>(ctx: ObservabilityContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The context, or null when nothing entered one. */
export function currentObservability(): ObservabilityContext | null {
  return store.getStore() ?? null;
}

/**
 * Build a context for an HTTP request from the facts a caller already has.
 *
 * ⚠️ `requestId` COMES FROM `ctx.requestId`, WHICH CAME FROM THE
 * `x-request-id` HEADER, WHICH `middleware.ts` SET AFTER STRIPPING ANY
 * CLIENT-SUPPLIED COPY. Nothing here re-reads a header, so there is no
 * second place for that stripping to be forgotten.
 */
export function httpContext(args: {
  requestId: string | null;
  /**
   * ⭐ AN INBOUND W3C `traceparent`, WHEN THE CALLER SENT ONE.
   *
   * A customer's own APM, an API gateway in front of us, or their
   * integration's HTTP client will send this. Continuing their trace
   * rather than starting a new one is the difference between "our API was
   * slow" and a single timeline that spans both systems — which is the
   * evidence that ends the argument about whose latency it was.
   *
   * ⚠️ IT IS PARSED STRICTLY AND IT IS NOT TRUSTED FOR ANYTHING ELSE. A
   * trace id is a grouping key, so a caller who chooses one can group
   * their own requests together and nothing more; they cannot read
   * anybody's traces, because there is no trace store to read. The
   * request id, which IS security-relevant, still comes only from
   * middleware. `parseTraceparent` refuses anything that is not exactly a
   * version-00 header — a lenient parser would let a caller pin every
   * request in the system to one trace id and make the view useless.
   */
  traceparent?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  route?: string | null;
  nowMs?: number;
}): ObservabilityContext {
  const inbound = parseTraceparent(args.traceparent);
  const ids = inbound
    ? { traceId: inbound.traceId, spanId: newSpanId(), derived: true }
    : traceForRequest(args.requestId);
  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    requestId: ids.derived ? (args.requestId ?? null) : null,
    tenantId: args.tenantId ?? null,
    userId: args.userId ?? null,
    route: args.route ?? null,
    kind: "http",
    startedAtMs: args.nowMs ?? Date.now(),
  };
}

/**
 * A context for work with no request behind it.
 *
 * ⭐ `kind: "job"` IS THE POINT. A scheduled sweep that errors for every
 * tenant is one incident; the same count of errors spread across user
 * requests is a different one. Mixing them into one availability number
 * is how a broken cron reads as a broken product.
 */
export function jobContext(args: {
  jobId: string;
  tenantId?: string | null;
  nowMs?: number;
}): ObservabilityContext {
  const ids: TraceIds = {
    traceId: traceForRequest(null).traceId,
    spanId: newSpanId(),
    sampled: true,
  };
  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    requestId: null,
    tenantId: args.tenantId ?? null,
    userId: null,
    route: null,
    kind: "job",
    startedAtMs: args.nowMs ?? Date.now(),
  };
}

/* ================================================================== */
/* PROJECTIONS                                                         */
/* ================================================================== */

/**
 * The context as a `LogContext`, which is the only shape `log()` accepts.
 * `outcome` is not part of the context because it is not known until the
 * work finishes — that is why it is a parameter here.
 */
export function logContext(
  outcome: LogOutcome,
  ctx: ObservabilityContext | null = currentObservability(),
): LogContext {
  return {
    requestId: ctx?.requestId ?? null,
    traceId: ctx?.traceId ?? null,
    tenantId: ctx?.tenantId ?? null,
    userId: ctx?.userId ?? null,
    route: ctx?.route ?? null,
    outcome,
  };
}

/**
 * The `traceparent` value for an outbound hop.
 *
 * ⚠️ A FRESH SPAN ID EACH TIME. Reusing this hop's span id for a call we
 * make would tell a collector the callee IS us, and a trace where two
 * spans share an id renders as a cycle rather than a chain.
 */
/** The header name to read an inbound trace from, and to write an outbound one to. */
export const TRACE_HEADER = TRACEPARENT_HEADER;

export function outboundTraceparent(
  ctx: ObservabilityContext | null = currentObservability(),
): string | null {
  if (!ctx) return null;
  return formatTraceparent({ traceId: ctx.traceId, spanId: newSpanId(), sampled: true });
}

/* ================================================================== */
/* THE DATABASE HOP                                                    */
/* ================================================================== */

/**
 * A SQL comment carrying the trace, to be prefixed to a statement.
 *
 * ⭐ THIS IS THE LAST HOP, AND IT IS WHY THE TRACE ID IS USEFUL AT ALL.
 * A slow page and the query behind it are two separate facts until
 * something carries one id across the boundary. Postgres records the
 * statement text verbatim in `pg_stat_statements`, in `log_min_duration`
 * output and in Neon's own query log, so a comment is enough — there is
 * no protocol field to put it in and no extension to install.
 *
 * This is the `sqlcommenter` convention, which Google's tooling, Neon's
 * console and Datadog's APM all already parse.
 *
 * ⚠️ 🔴 IT IS BUILT FROM VALIDATED IDS AND NOTHING ELSE. A trace id is 32
 * hex characters by `isTraceId()` or this returns the empty string. That
 * check is the entire defence against the only thing that could go wrong
 * here: a star-slash sequence inside an interpolated value would end the
 * comment early and the remainder would become executable SQL. (Written
 * in words rather than as the literal characters, because the literal
 * would close THIS comment — which it did, on the first attempt, and
 * turned the rest of the file into a parse error.) No escaping is applied
 * because there is nothing to escape — the character class cannot contain
 * a quote, a slash or a star.
 *
 * ⚠️ AND IT RETURNS "" RATHER THAN THROWING when there is no context, so
 * `sql.raw(traceSqlComment())` is always safe to write and a query is
 * never lost because tracing was unavailable.
 */
export function traceSqlComment(
  ctx: ObservabilityContext | null = currentObservability(),
): string {
  if (!ctx) return "";
  if (!isTraceId(ctx.traceId) || !isSpanId(ctx.spanId)) return "";
  return `/*traceparent='00-${ctx.traceId}-${ctx.spanId}-01'*/ `;
}

/**
 * ⚠️ 🔴 THERE WAS A `traceGucStatement()` HERE AND IT WAS DELETED.
 *
 * It returned `SELECT set_config('app.trace_id', …, true)` so a trigger
 * could read the trace id beside `app.current_tenant_id`. Plausible,
 * cheap, and called by nothing — `traceSqlComment()` above already
 * carries the trace into Postgres, in a format four other tools already
 * parse, at no extra statement.
 *
 * `check:observability-callers` reported it on its first run. Deleted
 * rather than exempted: a second mechanism for the same fact is how two
 * mechanisms end up disagreeing.
 */

/* ================================================================== */
/* TIMING                                                              */
/* ================================================================== */

/** Milliseconds since the context was entered. Zero when detached. */
export function elapsedMs(
  ctx: ObservabilityContext | null = currentObservability(),
  nowMs: number = Date.now(),
): number {
  if (!ctx) return 0;
  const d = nowMs - ctx.startedAtMs;
  // A clock that went backwards (NTP step, container migration) must not
  // produce a negative duration in a latency histogram.
  return d < 0 ? 0 : d;
}
