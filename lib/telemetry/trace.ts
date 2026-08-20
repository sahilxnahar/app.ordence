/**
 * Ordence — Trace identity
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TRACE ID ALREADY EXISTED. NOTHING HAD EVER NAMED IT.
 * ══════════════════════════════════════════════════════════════════════
 * `middleware.ts` has minted a fresh `x-request-id` on every request
 * since Phase 17: it strips any client-supplied value first (see
 * `SPOOFABLE_HEADERS` in `lib/tenant.ts`) and then sets its own uuid.
 * `requireTenantContext()` reads it back onto `ctx.requestId`, and
 * `audit_logs`, `security_events` and `permission_denials` all carry a
 * `request_id` column that is populated from it.
 *
 * So a correlation id is already generated, already unforgeable, already
 * carried through the whole request and already written to three tables.
 * What was missing was a NAME for the same value in the one format every
 * other tool in the world understands.
 *
 * ⭐ A uuid with its four hyphens removed is EXACTLY the W3C Trace
 * Context `trace-id`: 32 lowercase hex characters. This file is that
 * observation, written down and tested, and it is why trace propagation
 * in this codebase needed no new header, no new generator, no new
 * middleware hop and no new column.
 *
 * ⚠️ AND IT IS THEREFORE NOT A NEW SECURITY SURFACE. The trace id is a
 * derivation of a value the server already generated and never trusted
 * from the client. `traceIdFromRequestId()` REFUSES anything that is not
 * a well-formed uuid rather than passing it through, because the one way
 * to turn this into a header-injection vector would be to let a caller's
 * string become a log field verbatim.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is not a tracing SDK. There is no exporter, no sampler, no span
 * processor and no OpenTelemetry dependency — the wave-wide constraint is
 * zero new npm packages, and more importantly an SDK that monkey-patches
 * `fetch` and `http` is a decision about what leaves this process, which
 * belongs to the people who own the customer data and not to a package
 * install.
 *
 * What it is: the identity half of tracing, in the standard encoding, so
 * that if an exporter is ever added it has nothing to invent.
 *
 * ⚠️ PURE, AND EDGE-SAFE ON PURPOSE. No `server-only`, no `node:` import,
 * no database. `middleware.ts` runs on the edge runtime and is the one
 * place that could later stamp `traceparent` onto a response; a file it
 * cannot import would make that a rewrite instead of an import.
 */

/* ================================================================== */
/* SHAPES                                                              */
/* ================================================================== */

/** W3C trace-id: 32 lowercase hex, not all zeros. */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** W3C parent-id (span id): 16 lowercase hex, not all zeros. */
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

/**
 * The header name, spelled once.
 *
 * ⚠️ LOWERCASE. `Headers.get()` is case-insensitive but a `Headers`
 * constructed from a plain object is not always, and the one bug this
 * costs is invisible: the value is simply never found.
 */
export const TRACEPARENT_HEADER = "traceparent";

/** The trace id of a request, plus where in it we currently are. */
export type TraceIds = {
  /** 32 lowercase hex. Constant for the whole request. */
  traceId: string;
  /** 16 lowercase hex. Identifies this hop. */
  spanId: string;
  /**
   * Whether a collector should keep this trace.
   *
   * ⚠️ ALWAYS TRUE TODAY, and that is a decision rather than a stub: with
   * no collector, sampling would only lose data. The field exists so that
   * turning sampling on later does not change this type.
   */
  sampled: boolean;
};

/* ================================================================== */
/* PREDICATES                                                          */
/* ================================================================== */

export function isTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_RE.test(value) && value !== ALL_ZERO_TRACE;
}

export function isSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_RE.test(value) && value !== ALL_ZERO_SPAN;
}

/* ================================================================== */
/* DERIVATION                                                          */
/* ================================================================== */

/**
 * Turn the request id middleware already made into a W3C trace id.
 *
 * Returns null — never a fabricated id — when the input is not a uuid.
 *
 * ⚠️ NULL RATHER THAN A FRESH ID, AND THIS IS THE WHOLE POINT OF THE
 * FUNCTION. A fallback that mints a new trace id on a malformed input
 * produces a trace that correlates with nothing and looks exactly like
 * one that correlates with everything. The caller has to decide what to
 * do about "I have no request id", and it must be able to tell.
 */
export function traceIdFromRequestId(requestId: string | null | undefined): string | null {
  if (typeof requestId !== "string") return null;
  if (!UUID_RE.test(requestId)) return null;
  const hex = requestId.replace(/-/g, "").toLowerCase();
  return isTraceId(hex) ? hex : null;
}

/**
 * ⚠️ 🔴 THERE WAS A `requestIdFromTraceId()` HERE AND IT WAS DELETED.
 *
 * It turned a trace id back into the uuid form that `audit_logs.
 * request_id` and `security_events.request_id` are stored in — genuinely
 * useful to a human holding a trace id, and called by nothing.
 * `check:observability-callers`, written in this same track, reported it
 * on its first run.
 *
 * ⭐ IT IS RECORDED HERE RATHER THAN QUIETLY REMOVED because the gate
 * catching an export written by the author of the gate, within the hour,
 * is the most useful evidence available that the gate works. The rule it
 * enforces is "call it or delete it", and the honest answer for a
 * speculative convenience is delete.
 *
 * Reinstating it is four lines and a caller. Do not reinstate it without
 * the caller.
 */

/* ================================================================== */
/* GENERATION                                                          */
/* ================================================================== */

/**
 * ⚠️ `crypto.getRandomValues` AND NOT `Math.random()`.
 *
 * A span id is not a secret, so the argument is not cryptographic — it is
 * that `Math.random()` is seeded per-process and several Node versions
 * have produced correlated sequences across `fork()`ed workers. Two hops
 * of one request sharing a span id is a trace that reads as a cycle.
 *
 * `globalThis.crypto` is present in Node 20+, on the edge runtime and in
 * every browser this app supports. The fallback exists for the jsdom test
 * environment, which has historically shipped without it, and it is
 * deliberately obvious rather than clever so nobody mistakes it for the
 * real path.
 */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (const byte of buf) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function newTraceId(): string {
  let id = randomHex(16);
  // An all-zero trace id is reserved by the spec as "invalid". Astronomically
  // unlikely and cheap to exclude; a reserved value that reaches a collector
  // is dropped silently, which is the worst way to lose a trace.
  while (id === ALL_ZERO_TRACE) id = randomHex(16);
  return id;
}

export function newSpanId(): string {
  let id = randomHex(8);
  while (id === ALL_ZERO_SPAN) id = randomHex(8);
  return id;
}

/* ================================================================== */
/* W3C TRACE CONTEXT                                                   */
/* ================================================================== */

/**
 * `00-<trace-id>-<parent-id>-<flags>` — W3C Trace Context, version 00.
 *
 * Anything that speaks this header — a load balancer, a browser
 * extension, a customer's own APM, a future collector — will link a hop
 * carrying it to the same trace without being told anything about us.
 */
export function formatTraceparent(ids: TraceIds): string {
  return `00-${ids.traceId}-${ids.spanId}-${ids.sampled ? "01" : "00"}`;
}

/**
 * Parse a `traceparent`. Returns null on anything that is not exactly
 * right.
 *
 * ⚠️ STRICT, AND NOT FOR TIDINESS. This value can arrive from a client.
 * A lenient parser that accepts `00-<32 hex>-<junk>-01` and keeps the
 * trace id is an attacker-chosen grouping key: point every request at one
 * trace id and the trace view of an incident becomes unreadable. Being
 * strict costs a caller nothing — the fallback is "mint your own".
 *
 * ⚠️ VERSIONS ABOVE 00 ARE REFUSED RATHER THAN BEST-EFFORT PARSED. The
 * spec allows forward-compatible parsing; this refuses, because there is
 * no collector to be compatible with yet, and "we accepted a format we do
 * not understand" is not a property worth having in a security-relevant
 * log field.
 */
export function parseTraceparent(header: string | null | undefined): TraceIds | null {
  if (typeof header !== "string") return null;
  const parts = header.trim().toLowerCase().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version !== "00") return null;
  if (!isTraceId(traceId) || !isSpanId(spanId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags ?? "")) return null;
  return {
    traceId: traceId as string,
    spanId: spanId as string,
    sampled: (Number.parseInt(flags as string, 16) & 0x01) === 0x01,
  };
}

/**
 * The one call sites should use: derive the trace from the request id if
 * there is one, otherwise mint a fresh trace and SAY that is what
 * happened.
 *
 * `derived: false` means this hop is the root of its own trace and
 * correlates with no HTTP request — a scheduled job, a boot-time event, a
 * process-level unhandled rejection. That distinction is what stops a
 * background job's trace being mistaken for a user's.
 */
export function traceForRequest(requestId: string | null | undefined): TraceIds & {
  derived: boolean;
} {
  const derivedId = traceIdFromRequestId(requestId);
  return {
    traceId: derivedId ?? newTraceId(),
    spanId: newSpanId(),
    sampled: true,
    derived: derivedId !== null,
  };
}
