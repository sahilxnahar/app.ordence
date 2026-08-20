import "server-only";

/**
 * Ordence — The request observer: the one place an outcome is recorded
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THREE THINGS THAT WERE BUILT, TESTED, AND CALLED BY NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * Verified by repo-wide grep at v1.81.0-alpha, before a line of this was
 * written:
 *
 *   server/metering/record.ts#recordApiCall     0 callers
 *   server/metering/record.ts#recordEmailSent   0 callers  ← not in the brief
 *   lib/telemetry/report.ts#captureError        0 callers
 *   lib/telemetry/report.ts#captureEvent        0 callers
 *   lib/telemetry/report.ts#captureErrorSync    0 callers
 *   lib/security/siem.ts (every export)         0 callers
 *
 * This file is the wiring for the first of those, and it is deliberately
 * thin: the modules it calls are good and are not rewritten. What was
 * missing was a place to call them from.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 recordApiCall IS **NOT** CALLED ON EVERY REQUEST, AND THIS IS THE
 *    MOST CONSEQUENTIAL DECISION IN THE FILE
 * ══════════════════════════════════════════════════════════════════════
 * The obvious wiring — call it from `requireTenantContext()`, which every
 * authenticated page and action passes through — would be a BILLING BUG,
 * not a metering improvement.
 *
 *   lib/validators/billing.ts  trial plan:   apiCallsPerMonth = 1_000
 *   lib/metering/overage.ts    api_calls:    "billed"
 *
 * One person browsing an ERP for a morning is several hundred server
 * renders. Metering those as API calls exhausts a trial plan's monthly
 * allowance in a day and then INVOICES the overage, because `api_calls`
 * is billed rather than blocked (`hardBlockBps: null`). The customer's
 * first symptom is a bill.
 *
 * ⭐ SO `meterAsApiCall` IS AN EXPLICIT ARGUMENT WITH NO DEFAULT OF TRUE.
 * It is passed only by `app/api/**` handlers serving an authenticated
 * tenant — the surface a customer's own integration calls, which is what
 * the plan limit is a limit ON. Health checks, readiness probes, provider
 * webhooks and page renders are observed for the SLO and NOT metered.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CONTRACT: THIS FILE CANNOT BREAK THE REQUEST IT MEASURES
 * ══════════════════════════════════════════════════════════════════════
 * The same contract `server/metering/record.ts` states at length and for
 * the same reasons. Every exported function here swallows its own errors.
 * A telemetry write that can throw means a database hiccup turns a
 * successful request into a 500 — and it turns it into a 500 for the
 * busiest customer first, because they hit the contended path first.
 *
 * ⚠️ THE ONE THING IT WILL NOT DO IS PRETEND. A failed rollup write is
 * logged at `warn` with `degraded: true`. It is not counted as a success
 * and it is not silently dropped, because an availability number computed
 * from a recorder that stopped recording is the failure this whole track
 * exists to prevent.
 */

import { log, LOG_OUTCOME_SET, type LogOutcome } from "@/lib/telemetry/log";
import { scrubUrl } from "@/lib/telemetry/scrub";
import {
  currentObservability,
  elapsedMs,
  httpContext,
  jobContext,
  logContext,
  runWithObservability,
  traceSqlComment,
  type ObservabilityContext,
} from "./trace";

/* ================================================================== */
/* SWITCHES                                                            */
/* ================================================================== */

/**
 * Opt-OUT, matching `lib/telemetry/report.ts`.
 *
 * Telemetry that has to be switched on is telemetry that is off in the
 * one environment where it mattered. But it must be switchable off in a
 * single environment variable, because the first thing you want during a
 * write-amplification incident is to stop the highest-volume writer in
 * the system without a deploy.
 */
/**
 * ⚠️ ONE SWITCH, SHARED WITH `lib/telemetry/report.ts`, AND NOT A NEW ONE.
 *
 * A dedicated `OBSERVABILITY_ROLLUP_DISABLED` would be better: during a
 * write-amplification incident you want to stop the highest-volume writer
 * without also blinding error capture, and this switch stops both.
 *
 * It is not here because a new environment name fails
 * `check:env-catalogue` until `lib/platform/env-catalog.ts` — which Track
 * B does not own — carries it. Trading a slightly blunter kill switch for
 * a green gate in six other tracks' checkouts is the right way round; the
 * finer switch is in PATCH-REQUEST-B.md with its catalogue entry.
 */
function rollupEnabled(): boolean {
  return process.env.TELEMETRY_DISABLED !== "true";
}

/* ================================================================== */
/* THE ROLLUP WRITE                                                    */
/* ================================================================== */

/** Cumulative histogram edges, in milliseconds. Must match SQL 0133. */
const HISTOGRAM_EDGES = [100, 250, 500, 1_000, 2_000, 5_000] as const;

export type ObservedOutcome = {
  tenantId: string | null;
  /** A raw path is accepted and scrubbed here; the column refuses a URL. */
  route: string;
  outcome: LogOutcome;
  durationMs: number;
  kind?: "http" | "job";
};

/**
 * Write one observation into the minute bucket.
 *
 * ⚠️ ONE STATEMENT. The read-modify-write alternative is not "slightly
 * racy" here, it is wrong by construction — Railway runs however many
 * instances it likes, they share nothing, and under READ COMMITTED two
 * transactions that both read 41 both write 42. `server/metering/
 * record.ts` makes the same argument at length about the same shape.
 *
 * ⚠️ AND `date_trunc` IS COMPUTED BY POSTGRES, not by JavaScript. The
 * bucket has a CHECK constraint requiring minute alignment; computing it
 * from a container clock that has drifted would produce a row Postgres
 * refuses, at 3am, on the busiest instance.
 *
 * Returns true when the row was written. Never throws.
 */
export async function recordRequestOutcome(input: ObservedOutcome): Promise<boolean> {
  if (!rollupEnabled()) return false;

  try {
    const routePattern = scrubUrl(input.route);
    const kind = input.kind ?? "http";
    const duration = clampDuration(input.durationMs);

    // Cumulative: an observation at 60 ms increments every bucket at or
    // above 100. Anything above 5,000 increments none of them and is still
    // counted in `observations`, which is what makes le_5000 <= observations
    // a meaningful constraint rather than an equality.
    const buckets = HISTOGRAM_EDGES.map((edge) => (duration <= edge ? 1 : 0));

    const { withTenant, withPlatformScope } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    // ⭐ THE TRACE FOLLOWS THE REQUEST INTO POSTGRES. sqlcommenter format,
    // built only from validated hex — see `traceSqlComment`.
    const comment = traceSqlComment();

    /**
     * ⚠️ 🔴 THE COMMENT IS PART OF *THIS* STATEMENT, NOT A SEPARATE ONE.
     *
     * The first draft issued `SELECT 1` carrying the comment and then the
     * INSERT without it. That looks like trace propagation in a diff and is
     * not: `pg_stat_statements` would show a traced `SELECT 1` beside an
     * untraced INSERT, so the one statement anybody would ever want to find
     * by trace id is the one with no trace id on it. It is this repo's
     * signature defect — built, plausible, and verified by nothing — and it
     * survived until the assertion "grep the executed SQL for the trace id"
     * was actually run against a live Postgres.
     */
    const statement = sql`
      ${sql.raw(comment)}INSERT INTO request_outcomes (
        tenant_id, route_pattern, kind, outcome, bucket_start,
        observations, duration_ms_sum, duration_ms_max,
        le_100, le_250, le_500, le_1000, le_2000, le_5000,
        first_seen_at, last_seen_at
      ) VALUES (
        ${input.tenantId}::uuid,
        ${routePattern},
        ${kind},
        ${input.outcome},
        date_trunc('minute', now()),
        1, ${duration}, ${duration},
        ${buckets[0]}, ${buckets[1]}, ${buckets[2]},
        ${buckets[3]}, ${buckets[4]}, ${buckets[5]},
        now(), now()
      )
      ON CONFLICT ON CONSTRAINT request_outcomes_bucket_unique DO UPDATE SET
        observations    = request_outcomes.observations    + 1,
        duration_ms_sum = request_outcomes.duration_ms_sum + excluded.duration_ms_sum,
        duration_ms_max = GREATEST(request_outcomes.duration_ms_max, excluded.duration_ms_max),
        le_100          = request_outcomes.le_100   + excluded.le_100,
        le_250          = request_outcomes.le_250   + excluded.le_250,
        le_500          = request_outcomes.le_500   + excluded.le_500,
        le_1000         = request_outcomes.le_1000  + excluded.le_1000,
        le_2000         = request_outcomes.le_2000  + excluded.le_2000,
        le_5000         = request_outcomes.le_5000  + excluded.le_5000,
        last_seen_at    = now()
    `;

    if (input.tenantId) {
      /**
       * ⚠️ `withTenant`, NOT `withPlatformScope`, AND THE POLICY IN 0133
       * ENFORCES IT. A platform-scoped write of a tenant-attributed row is
       * refused by the WITH CHECK clause — deliberately, so a mis-scoped
       * caller gets an error rather than a wrong number about somebody
       * else's service. Proven: see TRACK-REPORT.md §3, probe 1.
       */
      await withTenant(input.tenantId, async (tx) => {
        await tx.execute(statement);
      });
    } else {
      /**
       * The global row: an unauthenticated request, which is exactly the
       * one that matters when sign-in itself is the outage. `tenant_id IS
       * NULL AND app_platform_scope()` is the one write branch the policy
       * allows from platform scope — the `isGlobalWriteOnly` idiom
       * `scripts/check-rls-coverage.mjs` already recognises.
       */
      await withPlatformScope(
        "observability: record an unauthenticated request outcome, which has no tenant by definition",
        async (tx) => {
          await tx.execute(statement);
        },
      );
    }

    return true;
  } catch (error) {
    /**
     * ⚠️ `warn`, NOT `error`, AND `degraded: true`. This is the recorder
     * failing, not the request failing. Logging it at error level would
     * make the availability SLO's own instrumentation the loudest source
     * of errors during any database incident — which is how a monitoring
     * system gets muted.
     */
    log("warn", "observability.rollup_failed", logContext("failed"), {
      degraded: true,
      component: "observe",
      errorName: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof Error ? error.message : String(error),
    });

    /**
     * ⭐ AND TO `captureEvent()`, WHICH ALSO HAD NO CALLERS.
     *
     * `lib/telemetry/report.ts` wrote it for exactly this: "a non-exception
     * event of interest — a degraded path, a retry exhaustion, a quota
     * refusal". A recorder that cannot write is the single most important
     * degraded path in this track, because every number downstream of it
     * silently becomes a ratio over a window nobody observed.
     *
     * ⚠️ IT WRITES TO A DIFFERENT TABLE (`error_events`) THAN THE ONE THAT
     * JUST FAILED (`request_outcomes`), which is why this is not a loop.
     * If the database itself is down both fail, and `captureError`'s
     * no-throw contract means the second failure is swallowed rather than
     * recursing — see its own comment about the out-of-memory kill.
     */
    try {
      const { captureEvent } = await import("@/lib/telemetry/report");
      await captureEvent({
        name: "observability.rollup_write_failed",
        severity: "warning",
        source: "server",
        route: input.route,
        tenantId: input.tenantId,
        metadata: { component: "observe", action: "rollup" },
      });
    } catch {
      /* the reporter cannot throw; this is the second belt */
    }

    return false;
  }
}

/**
 * Milliseconds, bounded into something a histogram and an `integer`
 * column can hold.
 *
 * ⚠️ THE UPPER BOUND IS NOT COSMETIC. `duration_ms_max` is `integer`; a
 * clock step or a resumed serverless freeze can produce a "duration" of
 * days, which overflows the column and takes the whole INSERT with it —
 * losing the observation AND every other observation in that statement.
 * One hour is far beyond any real request and safely inside int4.
 */
function clampDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), 3_600_000);
}

/* ================================================================== */
/* ATTRIBUTION                                                         */
/* ================================================================== */

/**
 * Tell the observation which workspace it turned out to belong to.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FUNCTION HAS TO EXIST, AND WHY IT MUTATES
 * ══════════════════════════════════════════════════════════════════════
 * The context is entered at the OUTSIDE of a request, where the tenant is
 * not yet known — resolving it needs Clerk and a database read, both of
 * which happen inside the handler. So the wrapper starts with
 * `tenantId: null` and something on the inside has to say who it was.
 *
 * ⚠️ WITHOUT THIS EVERY OBSERVATION WOULD BE A NULL-TENANT ROW. The whole
 * argument of this track is that a global average hides one workspace at
 * 40% among two hundred healthy ones; an observer that cannot attribute
 * anything produces exactly that global average and nothing else. The
 * first draft of `withObservedApiRoute` had precisely this bug: it read
 * `ctx.tenantId`, which was structurally always null, so `meterAsApiCall`
 * could never fire either.
 *
 * ⚠️ IT MUTATES THE STORED OBJECT RATHER THAN RE-ENTERING THE STORE.
 * `AsyncLocalStorage.run()` cannot be re-entered for an already-running
 * async chain without wrapping the remainder of it in a callback, which
 * would mean every call site restructuring its control flow. The object
 * is per-request and never shared across requests, so mutation is safe;
 * it is called out because "a mutable ambient object" is otherwise the
 * sort of thing a reviewer is right to stop at.
 *
 * Never throws. Does nothing outside a context, which is the correct
 * behaviour for a page render that nothing wrapped.
 */
export function attributeObservationTo(args: {
  tenantId?: string | null;
  userId?: string | null;
  route?: string | null;
}): void {
  try {
    const ctx = currentObservability();
    if (!ctx) return;
    if (args.tenantId) ctx.tenantId = args.tenantId;
    if (args.userId) ctx.userId = args.userId;
    if (args.route) ctx.route = scrubUrl(args.route);
  } catch {
    /* attribution must never break the request it labels */
  }
}

/* ================================================================== */
/* THE OUTCOME OF ONE PIECE OF WORK                                    */
/* ================================================================== */

export type ObserveArgs = {
  /** A short, static event name. Never interpolated with an id. */
  event: string;
  tenantId: string | null;
  userId?: string | null;
  route: string;
  outcome: LogOutcome;
  durationMs: number;
  kind?: "http" | "job";
  /**
   * 🔴 BILLING. True ONLY for an authenticated request to `app/api/**`
   * from a customer's own integration. See the header — the default is
   * false and it stays false.
   */
  meterAsApiCall?: boolean;
  /** Extra fields. Filtered against `LOG_FIELDS`; unknown keys are dropped and counted. */
  extras?: Record<string, unknown>;
};

/**
 * Record one unit of work: a log line, a rollup row, and — only when
 * asked — a billing counter.
 *
 * Never throws. Returns nothing on purpose: a caller that branched on
 * whether its telemetry landed would be a caller whose behaviour depends
 * on its telemetry.
 */
export async function observe(args: ObserveArgs): Promise<void> {
  const routePattern = scrubUrl(args.route);

  /**
   * ⚠️ REFUSED HERE RATHER THAN BY THE `request_outcomes_outcome_known`
   * CHECK CONSTRAINT. Both would reject it, but the constraint rejects it
   * inside a swallowed catch on the request path — so an outcome spelled
   * "success" instead of "ok" would produce a silent hole in the
   * denominator, which is an availability number that is quietly wrong
   * rather than visibly missing.
   */
  if (!LOG_OUTCOME_SET.has(args.outcome)) {
    log("warn", "observability.unknown_outcome", logContext("failed"), {
      degraded: true,
      component: "observe",
      reason: `outcome "${String(args.outcome)}" is not in the closed vocabulary`,
    });
    return;
  }

  /**
   * ⭐ LABEL THE AMBIENT CONTEXT. The wrapper entered the context before
   * the tenant was known; from here on every log line in this request
   * carries the workspace, without any of them being changed.
   */
  attributeObservationTo({ tenantId: args.tenantId, userId: args.userId, route: routePattern });

  try {
    log(
      args.outcome === "failed" ? "error" : args.outcome === "ok" ? "info" : "notice",
      args.event,
      {
        ...logContext(args.outcome),
        tenantId: args.tenantId,
        userId: args.userId ?? logContext(args.outcome).userId,
        route: routePattern,
      },
      { durationMs: args.durationMs, ...(args.extras ?? {}) },
    );
  } catch {
    /* the logger already cannot throw; this is the second belt */
  }

  await recordRequestOutcome({
    tenantId: args.tenantId,
    route: routePattern,
    outcome: args.outcome,
    durationMs: args.durationMs,
    kind: args.kind ?? "http",
  });

  if (args.meterAsApiCall === true && args.tenantId) {
    try {
      /**
       * ⭐ THE WIRING. `recordApiCall` has existed since Phase 15 with a
       * plan limit, an overage rule, a quota definition and a usage page
       * built on it, and has never been called.
       *
       * ⚠️ Imported lazily for the reason `server/metering/record.ts`
       * states about its own imports: `db/index.ts` validates the
       * environment while constructing its client, so a static import
       * means merely importing this module can throw — and this module is
       * imported by the route handlers it must never break.
       */
      const { recordApiCall } = await import("@/server/metering/record");
      const written = await recordApiCall(args.tenantId);
      if (!written) {
        // `recordApiCall` swallows its own errors and returns false. That
        // is right for the request and wrong for the invoice, so the miss
        // is recorded here rather than nowhere.
        log("warn", "metering.api_call_not_recorded", logContext(args.outcome), {
          degraded: true,
          component: "observe",
          tenantId: args.tenantId,
        });
      }
    } catch {
      /* metering must never break the request it measures */
    }
  }
}

/* ================================================================== */
/* THE WRAPPERS                                                        */
/* ================================================================== */

export type ApiRouteOptions = {
  /** Static route pattern, e.g. "/api/upload". Never interpolated. */
  route: string;
  /** 🔴 See the header. Only a customer-facing API call. */
  meterAsApiCall?: boolean;
};

/**
 * Wrap an `app/api/**` route handler so that it is observed.
 *
 * ⭐ THIS EXISTS BECAUSE THERE IS NO SHARED API WRAPPER IN THIS
 * CODEBASE. Twenty-one `route.ts` files each hand-roll their own auth,
 * their own parsing and their own error shape; there is no
 * `withApiAuth`, no `apiHandler`, and therefore no single place a
 * request's outcome could be recorded. That absence is why the
 * availability of this product has never been measured.
 *
 * ⚠️ IT DOES NOT AUTHENTICATE, AUTHORISE OR VALIDATE ANYTHING, and it
 * must not be mistaken for a gate. It observes. Adding auth here would
 * put a security control in a file whose stated contract is "never
 * changes the behaviour of what it wraps", and the two contracts are
 * incompatible.
 *
 * ⚠️ THE ERROR IS RE-THROWN. A wrapper that swallowed it would convert
 * every 500 into a 200 with an empty body — an availability metric that
 * caused the outage it was measuring.
 */
export function withObservedApiRoute<A extends unknown[]>(
  options: ApiRouteOptions,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    const requestId = requestIdFromArgs(args);
    const ctx = httpContext({ requestId, route: options.route });

    return runWithObservability(ctx, async () => {
      let response: Response | null = null;
      let thrown: unknown = null;

      try {
        response = await handler(...args);
      } catch (error) {
        thrown = error;
      }

      const durationMs = elapsedMs(ctx);
      const outcome = thrown
        ? "failed"
        : outcomeForStatus(response?.status ?? 500);

      await observe({
        event: "http.request",
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        route: options.route,
        outcome,
        durationMs,
        kind: "http",
        meterAsApiCall: options.meterAsApiCall === true && outcome === "ok",
        extras: { status: response?.status ?? 500, component: "api" },
      });

      if (thrown) {
        /**
         * ⭐ AND THE ERROR GOES TO `captureError`, WHICH ALSO HAD NO
         * CALLERS. `instrumentation.ts#onRequestError` catches uncaught
         * errors from pages and server actions; a route handler that
         * throws inside a wrapper is caught HERE and would otherwise
         * never reach either.
         */
        await captureThrown(thrown, options.route, ctx);
        throw thrown;
      }

      return response as Response;
    });
  };
}

/**
 * Observe a scheduled job run.
 *
 * ⚠️ `kind: "job"` KEEPS IT OUT OF THE AVAILABILITY SLO. A nightly sweep
 * that fails for every workspace and a page that fails for every user are
 * the same count of failures and two entirely different incidents; mixing
 * them means a broken cron reads as a broken product and the on-call
 * looks in the wrong place.
 */
export async function observeJob<T>(
  args: { jobId: string; tenantId?: string | null },
  work: () => Promise<T>,
): Promise<T> {
  const ctx = jobContext({ jobId: args.jobId, tenantId: args.tenantId ?? null });

  return runWithObservability(ctx, async () => {
    try {
      const result = await work();
      await observe({
        event: "job.run",
        tenantId: ctx.tenantId,
        route: `/jobs/${sanitiseJobId(args.jobId)}`,
        outcome: "ok",
        durationMs: elapsedMs(ctx),
        kind: "job",
        extras: { jobId: sanitiseJobId(args.jobId), component: "scheduler" },
      });
      return result;
    } catch (error) {
      await observe({
        event: "job.run",
        tenantId: ctx.tenantId,
        route: `/jobs/${sanitiseJobId(args.jobId)}`,
        outcome: "failed",
        durationMs: elapsedMs(ctx),
        kind: "job",
        extras: {
          jobId: sanitiseJobId(args.jobId),
          component: "scheduler",
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      });
      await captureThrown(error, `/jobs/${sanitiseJobId(args.jobId)}`, ctx);
      // Re-thrown: the scheduler decides what a failed job means, not the
      // thing watching it.
      throw error;
    }
  });
}

/* ================================================================== */
/* HELPERS                                                             */
/* ================================================================== */

/**
 * ⚠️ A JOB ID BECOMES PART OF A ROUTE PATTERN, WHICH IS A LABEL SET. An
 * interpolated id here is unbounded cardinality in `request_outcomes` —
 * the exact thing `scrubUrl` exists to prevent on the HTTP side.
 */
function sanitiseJobId(jobId: string): string {
  const cleaned = jobId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * 4xx is not an outage. 5xx is.
 *
 * ⚠️ 429 IS `throttled` AND NOT `failed`, AND THAT IS A DELIBERATE
 * DECISION RATHER THAN A ROUNDING. A rate limiter doing its job would
 * otherwise burn the availability budget every time it worked, and the
 * remedy an on-call would reach for is to loosen the limiter.
 */
function outcomeForStatus(status: number): LogOutcome {
  if (status >= 500) return "failed";
  if (status === 429) return "throttled";
  if (status === 401 || status === 403) return "denied";
  if (status >= 400) return "invalid";
  return "ok";
}

/**
 * Pull the request id out of whatever Next.js handed the handler.
 *
 * ⚠️ READ FROM THE REQUEST HEADERS, WHICH `middleware.ts` HAS ALREADY
 * STRIPPED OF ANY CLIENT-SUPPLIED COPY (`SPOOFABLE_HEADERS` in
 * `lib/tenant.ts`, deleted before the server's own value is set). If that
 * stripping were ever removed, this would inherit a caller-chosen
 * correlation id — which is why it is called out here rather than
 * assumed.
 */
function requestIdFromArgs(args: unknown[]): string | null {
  const first = args[0] as { headers?: { get?: (k: string) => string | null } } | undefined;
  try {
    return first?.headers?.get?.("x-request-id") ?? null;
  } catch {
    return null;
  }
}

/**
 * Hand a thrown value to `lib/telemetry/report.ts`.
 *
 * ⚠️ AWAITED, NOT `captureErrorSync`. On a platform that can freeze the
 * function the moment the response is returned, the sync variant loses
 * the event — and this is called before the re-throw, so there is still a
 * request to be inside.
 */
async function captureThrown(
  error: unknown,
  route: string,
  ctx: ObservabilityContext,
): Promise<void> {
  try {
    const { captureError } = await import("@/lib/telemetry/report");
    await captureError({
      error,
      severity: "error",
      source: "server",
      route,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      // ⭐ THE CORRELATION IDS SURVIVE `scrubMetadata` ONLY BECAUSE OF THE
      // exemption added to `lib/telemetry/scrub.ts` in this same wave.
      // Without it these become the literal string ":id".
      metadata: { traceId: ctx.traceId, requestId: ctx.requestId, component: "api" },
    });
  } catch {
    /* the reporter already cannot throw; this is the second belt */
  }
}

/** Re-exported so a caller needs one import to observe something. */
export { currentObservability, runWithObservability, httpContext, jobContext };
