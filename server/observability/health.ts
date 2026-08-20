import "server-only";

/**
 * Ordence — Reading the evidence back: SLO state, per-tenant health,
 *           and the freshness of the recorder itself
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE RULE THIS FILE IS ORGANISED AROUND
 * ══════════════════════════════════════════════════════════════════════
 * NOTHING HERE MAY TURN AN ABSENT MEASUREMENT INTO A HEALTHY ONE.
 *
 * Every function returns a discriminated state, every table is probed
 * with `to_regclass` before it is read, and a missing table, a missing
 * column or an empty window produces `"unmeasured"` — never zero, never
 * 100%, never green.
 *
 * That is not defensive style. It is the direct answer to this
 * repository's twenty-three-instance defect: a coverage check written
 * `count(*) >= 10 THEN 'PASS'` for a property that needed to hold on 303
 * tables, which passed at 48; a gate whose skip path exited 0; three
 * observability modules with no callers whose dashboards were all green
 * because green meant "no data has ever arrived here".
 *
 * ⚠️ AND IT IS WHY `job.cadence` REPORTS UNMEASURED IN THIS ZIP. Track A
 * is producing the job-run table in this same wave and it does not exist
 * yet. Reading a table that is not there and reporting "0 failures" would
 * be the most on-brand defect available.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY READ HERE IS PLATFORM-SCOPED AND AGGREGATE-ONLY
 * ══════════════════════════════════════════════════════════════════════
 * Counts, sums, ratios, timestamps. Not one customer record reaches this
 * module — `app/platform/observatory/page.tsx` makes the same commitment
 * in the same words, and it is worth repeating because the pressure
 * during an incident is always "just show me the record that errored".
 * The answer is still an impersonation session: consented, time-limited,
 * bannered and audited.
 */

import {
  SLOS,
  evaluateSlo,
  burnRateOver,
  type SloEvaluation,
  type SloId,
} from "./slo";

/* ================================================================== */
/* SHARED PLUMBING                                                     */
/* ================================================================== */

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  const r = (result as { rows?: Row[] })?.rows;
  if (Array.isArray(r)) return r;
  return Array.isArray(result) ? (result as Row[]) : [];
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Ask Postgres whether a relation exists, without throwing if it does not.
 *
 * ⚠️ `to_regclass` AND NOT A TRY/CATCH AROUND A SELECT. A failed SELECT
 * inside a transaction aborts the transaction, so the next probe in the
 * same connection fails for a reason that has nothing to do with the
 * table it was asking about — and the report then says every table is
 * missing.
 */
async function relationExists(tx: TxLike, name: string): Promise<boolean> {
  const { sql } = await import("drizzle-orm");
  const result = await tx.execute(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`);
  return rows(result)[0]?.present === true;
}

import type { withPlatformScope } from "@/db";

/**
 * The transaction handle type, derived from `withPlatformScope` rather
 * than named, so it cannot drift from the real one. Same trick as
 * `server/metering/record.ts`, `server/security/record.ts` and
 * `server/billing/audit-billing.ts`.
 *
 * ⚠️ `import type`, SO THERE IS NO RUNTIME IMPORT OF `@/db`. That matters
 * here for the reason `server/metering/record.ts` states about its own:
 * `db/index.ts` validates the environment while constructing its client,
 * so a value import would mean merely importing this module can throw —
 * and these modules are imported from the surfaces they must never break.
 */
type TxLike = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

async function readPlatform<T>(
  reason: string,
  work: (tx: TxLike) => Promise<T>,
): Promise<T | null> {
  try {
    const { withPlatformScope } = await import("@/db");
    return (await withPlatformScope(reason, work as never)) as T;
  } catch {
    /**
     * ⚠️ NULL, WHICH EVERY CALLER RENDERS AS "unmeasured". Returning an
     * empty result set here would report a healthy, quiet system every
     * time the database was unreachable — which is the one moment the
     * status surface exists for.
     */
    return null;
  }
}

/* ================================================================== */
/* p95 FROM A CUMULATIVE HISTOGRAM                                     */
/* ================================================================== */

/** Must match the columns created by SQL 0133. */
const HISTOGRAM_EDGES = [100, 250, 500, 1_000, 2_000, 5_000] as const;

export type HistogramCounts = {
  observations: number;
  le: readonly number[];
};

/**
 * The smallest bucket edge at or below which 95% of observations fall.
 *
 * ⚠️ IT RETURNS AN UPPER BOUND, NOT AN INTERPOLATED ESTIMATE, AND SAYS SO
 * BY RETURNING `null` WHEN THE 95TH PERCENTILE IS ABOVE THE LAST EDGE.
 * Linear interpolation inside a bucket invents precision the data does
 * not have; interpolating past the last edge invents a NUMBER, and the
 * number it invents is always reassuringly close to the last edge. "p95
 * is above 5 s" is the honest answer and it is also the actionable one.
 */
export function p95FromHistogram(h: HistogramCounts): number | null {
  if (h.observations <= 0) return null;
  const target = h.observations * 0.95;
  for (let i = 0; i < HISTOGRAM_EDGES.length; i++) {
    if ((h.le[i] ?? 0) >= target) return HISTOGRAM_EDGES[i] as number;
  }
  return null;
}

/* ================================================================== */
/* SLO SNAPSHOT                                                        */
/* ================================================================== */

export type SloSnapshot = {
  evaluation: SloEvaluation;
  /** Short-window burn, for the alerting decision. Null when unmeasured. */
  fastBurn: { windowHours: number; failureFraction: number; burnRate: number } | null;
};

export type HealthSnapshot = {
  generatedAt: Date;
  slos: SloSnapshot[];
  /** When the recorder last wrote anything. Null means it never has. */
  recorderLastWriteAt: Date | null;
  /** True when the recorder has been silent long enough to distrust the rest. */
  recorderStalled: boolean;
  tenants: TenantHealth[];
  alerts: AlertRow[];
  /** What the security vocabulary produced in the last hour, by type. */
  recentSecurity: { eventType: string; severity: string; n: number }[];
  /** Track A's scheduler: present, readable, and what it says right now. */
  scheduler: SchedulerProbe;
  /** Jobs outside their window at this instant, per `scheduler_overdue()`. */
  overdueNow: number | null;
  /** Anything the snapshot could not measure, and why. Never empty silently. */
  notes: string[];
};

export type TenantHealth = {
  tenantId: string;
  requests: number;
  failed: number;
  errorRate: number;
  p95Ms: number | null;
  jobFailures: number | null;
  openAlerts: number;
};

export type AlertRow = {
  id: string;
  alertKey: string;
  runbookKey: string;
  severity: string;
  title: string;
  tenantId: string | null;
  firstRaisedAt: Date | null;
  lastRaisedAt: Date | null;
  raiseCount: number;
  suppressedCount: number;
  delivered: boolean;
  deliveryError: string | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
};

/**
 * Everything the status surface needs, in one platform-scoped read.
 *
 * ⚠️ ONE TRANSACTION, NOT SIX. Each `withPlatformScope` opens its own
 * transaction on the pool; six of them for one page render is six
 * connection acquisitions on a Neon Free plan whose connection budget is
 * the tightest resource this deployment has.
 */
export async function getHealthSnapshot(options?: {
  windowDays?: number;
  tenantLimit?: number;
}): Promise<HealthSnapshot> {
  const windowDays = clampDays(options?.windowDays);
  const tenantLimit = Math.min(Math.max(options?.tenantLimit ?? 25, 1), 200);
  const notes: string[] = [];
  const generatedAt = new Date();

  const data = await readPlatform(
    "observability status surface: cross-tenant availability, latency and alert aggregates",
    async (tx) => {
      const { sql } = await import("drizzle-orm");

      const haveOutcomes = await relationExists(tx, "request_outcomes");
      const haveAlerts = await relationExists(tx, "observability_alerts");
      const haveOutbox = await relationExists(tx, "email_outbox");
      /**
       * ⭐ TRACK A'S SCHEDULER, PROBED BY ITS REAL NAMES.
       *
       * ⚠️ THE FIRST VERSION GUESSED FOUR NAMES — `scheduled_job_runs`,
       * `job_runs`, `cron_runs`, `scheduler_runs` — and took the first that
       * existed. Three of those do not exist and never did. A probe that
       * guesses is a probe that will one day match a table belonging to
       * something else and report its rows as job health.
       *
       * The ledger is `scheduler_runs`; the declared cadence lives in
       * `scheduler_job_expectations`; and `scheduler_overdue()` already
       * answers "which jobs have not run inside their window".
       *
       * 🔴 `scheduler_overdue()` IS READ RATHER THAN RECOMPUTED FROM
       * `scheduler_runs`, AND THAT IS THE WHOLE DESIGN OF THIS SECTION.
       * Two definitions of "overdue" — Track A's and a second one here —
       * would agree for a while and then quietly disagree, and the one on
       * the status page would be the one nobody had tested. One definition,
       * owned by the track that owns the scheduler.
       */
      const scheduler = await probeScheduler(tx);

      /* ---- availability + latency ------------------------------- */
      let availability = { sample: 0, bad: 0 };
      let fastWindow = { sample: 0, bad: 0 };
      let latency = { buckets: 0, breaching: 0 };
      let latencyFast = { buckets: 0, breaching: 0 };
      let recorderLastWriteAt: Date | null = null;
      let tenants: TenantHealth[] = [];

      if (haveOutcomes) {
        const totals = rows(
          await tx.execute(sql`
            SELECT
              COALESCE(SUM(observations) FILTER (WHERE outcome IN ('ok','failed')), 0) AS sample,
              COALESCE(SUM(observations) FILTER (WHERE outcome = 'failed'), 0)         AS bad
              FROM request_outcomes
             WHERE kind = 'http'
               AND bucket_start >= now() - make_interval(days => ${windowDays})
          `),
        )[0];
        availability = { sample: num(totals?.sample), bad: num(totals?.bad) };

        const fast = rows(
          await tx.execute(sql`
            SELECT
              COALESCE(SUM(observations) FILTER (WHERE outcome IN ('ok','failed')), 0) AS sample,
              COALESCE(SUM(observations) FILTER (WHERE outcome = 'failed'), 0)         AS bad
              FROM request_outcomes
             WHERE kind = 'http'
               AND bucket_start >= now() - interval '1 hour'
          `),
        )[0];
        fastWindow = { sample: num(fast?.sample), bad: num(fast?.bad) };

        recorderLastWriteAt = toDate(
          rows(await tx.execute(sql`SELECT max(last_seen_at) AS at FROM request_outcomes`))[0]?.at,
        );

        /**
         * ⭐ LATENCY IS EVALUATED PER FIVE-MINUTE BUCKET PER ROUTE, over
         * the ten busiest routes — which is what the objective in
         * `docs/SLOS.md` actually says. Evaluating the average across all
         * routes would let a hundred fast health checks hide one slow
         * page, and the slow page is the product.
         */
        const latencyRows = rows(
          await tx.execute(sql`
            WITH hot AS (
              SELECT route_pattern
                FROM request_outcomes
               WHERE kind = 'http'
                 AND bucket_start >= now() - make_interval(days => ${windowDays})
               GROUP BY route_pattern
               ORDER BY SUM(observations) DESC
               LIMIT 10
            ),
            windows AS (
              SELECT r.route_pattern,
                     to_timestamp(floor(extract(epoch from r.bucket_start) / 300) * 300) AS w,
                     SUM(r.observations) AS observations,
                     SUM(r.le_100)  AS le_100,
                     SUM(r.le_250)  AS le_250,
                     SUM(r.le_500)  AS le_500,
                     SUM(r.le_1000) AS le_1000,
                     SUM(r.le_2000) AS le_2000,
                     SUM(r.le_5000) AS le_5000
                FROM request_outcomes r
                JOIN hot ON hot.route_pattern = r.route_pattern
               WHERE r.kind = 'http'
                 AND r.bucket_start >= now() - make_interval(days => ${windowDays})
               GROUP BY 1, 2
            )
            SELECT observations, le_100, le_250, le_500, le_1000, le_2000, le_5000,
                   (w >= now() - interval '1 hour') AS recent
              FROM windows
          `),
        );

        for (const r of latencyRows) {
          const observations = num(r.observations);
          if (observations <= 0) continue;
          latency.buckets++;
          const p95 = p95FromHistogram({
            observations,
            le: [
              num(r.le_100),
              num(r.le_250),
              num(r.le_500),
              num(r.le_1000),
              num(r.le_2000),
              num(r.le_5000),
            ],
          });
          // null means "above the last edge", which is a breach by
          // definition and must not be treated as a missing value.
          const breaching = p95 === null || p95 > 800;
          if (breaching) latency.breaching++;

          /*
           * ⭐ THE SHORT WINDOW, WHICH IS WHAT MAKES THIS OBJECTIVE
           * ALERTABLE AT ALL. `slo-latency` had a runbook, a burn threshold
           * and a RUNBOOK_FOR_SLO entry, and `fastBurnFor()` returned null
           * for every id except app.availability — so the latency budget
           * could be fully spent without one message being sent. Declared
           * and unenforced, in the alerting layer, found by asking what
           * actually raises each runbook.
           */
          if (r.recent === true) {
            latencyFast.buckets++;
            if (breaching) latencyFast.breaching++;
          }
        }

        /* ---- per-tenant ----------------------------------------- */
        const tenantRows = rows(
          await tx.execute(sql`
            SELECT
              tenant_id,
              COALESCE(SUM(observations) FILTER (WHERE outcome IN ('ok','failed')), 0) AS requests,
              COALESCE(SUM(observations) FILTER (WHERE outcome = 'failed'), 0)         AS failed,
              COALESCE(SUM(observations), 0)  AS all_observations,
              COALESCE(SUM(le_100), 0)   AS le_100,
              COALESCE(SUM(le_250), 0)   AS le_250,
              COALESCE(SUM(le_500), 0)   AS le_500,
              COALESCE(SUM(le_1000), 0)  AS le_1000,
              COALESCE(SUM(le_2000), 0)  AS le_2000,
              COALESCE(SUM(le_5000), 0)  AS le_5000
              FROM request_outcomes
             WHERE kind = 'http'
               AND tenant_id IS NOT NULL
               AND bucket_start >= now() - make_interval(days => ${windowDays})
             GROUP BY tenant_id
            /*
              ⚠️ ORDERED BY FAILURES FIRST, NOT BY VOLUME. The whole
              argument of this track is that one workspace at 40% hides
              inside two hundred healthy ones; sorting by traffic puts the
              biggest customer at the top and the broken one on page four.
            */
             ORDER BY SUM(observations) FILTER (WHERE outcome = 'failed') DESC NULLS LAST,
                      SUM(observations) DESC
             LIMIT ${tenantLimit}
          `),
        );

        tenants = tenantRows.map((r) => {
          const requests = num(r.requests);
          const failed = num(r.failed);
          return {
            tenantId: str(r.tenant_id) ?? "unknown",
            requests,
            failed,
            errorRate: requests > 0 ? failed / requests : 0,
            p95Ms: p95FromHistogram({
              observations: num(r.all_observations),
              le: [
                num(r.le_100),
                num(r.le_250),
                num(r.le_500),
                num(r.le_1000),
                num(r.le_2000),
                num(r.le_5000),
              ],
            }),
            jobFailures: null,
            openAlerts: 0,
          };
        });
      }

      /* ---- mail ------------------------------------------------- */
      let mail: { sample: number; bad: number } | null = null;
      if (haveOutbox) {
        const mailRow = rows(
          await tx.execute(sql`
            SELECT
              count(*) FILTER (WHERE status IN ('sent','dead')) AS sample,
              count(*) FILTER (WHERE status = 'dead')           AS bad
              FROM email_outbox
             WHERE queued_at >= now() - make_interval(days => ${windowDays})
          `),
        )[0];
        mail = { sample: num(mailRow?.sample), bad: num(mailRow?.bad) };
      }

      /* ---- scheduler ---------------------------------------------- */
      /**
       * ⚠️ THE SAMPLE IS THIS SWEEP'S OWN OBSERVATIONS, NOT `scheduler_runs`
       * ROWS, AND THE DIFFERENCE IS NOT COSMETIC.
       *
       * `scheduler_overdue()` answers a question about NOW: which jobs are
       * outside their window at this instant. It is not a thirty-day
       * history, and turning it into one would mean recomputing lateness
       * from `scheduler_runs` — the second definition this section exists to
       * avoid.
       *
       * So the sweep records what it saw, into `request_outcomes` under
       * `kind = 'job'`, and the objective is computed over those
       * observations: the fraction of checks in which nothing was overdue.
       * `scheduler_overdue()` remains the only thing that decides what
       * "overdue" means.
       *
       * ⚠️ THE COST, STATED: the objective is unmeasured until the sweep has
       * run `minimumSample` times. At a fifteen-minute cadence that is about
       * a day. Unmeasured is the honest answer for a window nothing
       * observed, and it is exactly what §0 of docs/SLOS.md is about.
       */
      let jobs: { sample: number; bad: number } | null = null;
      let overdueNow: number | null = null;

      if (scheduler.callable) {
        const overdue = rows(
          await tx.execute(sql`SELECT count(*)::int AS n FROM scheduler_overdue()`),
        )[0];
        overdueNow = num(overdue?.n);

        const observed = rows(
          await tx.execute(sql`
            SELECT
              COALESCE(SUM(observations), 0)                                  AS sample,
              COALESCE(SUM(observations) FILTER (WHERE outcome = 'failed'), 0) AS bad
              FROM request_outcomes
             WHERE kind = 'job'
               AND route_pattern = '/jobs/scheduler.cadence'
               AND bucket_start >= now() - make_interval(days => ${windowDays})
          `),
        )[0];
        jobs = { sample: num(observed?.sample), bad: num(observed?.bad) };
      }

      /* ---- the security stream, including Track D's new types ----- */
      /**
       * ⭐ TRACK D ADDED FOUR EVENT TYPES AND A WRITER THAT ROUTES THEM
       * CORRECTLY, so these rows exist for the first time.
       *
       * ⚠️ READ FROM `security_events` DIRECTLY AND NOT FROM
       * `security_event_stream`. The view unions six tables and is the right
       * shape for an export; for "what fired in the last hour" it is six
       * scans where one indexed one will do, on a page an operator opens
       * during an incident.
       *
       * ⚠️ AND THE READ IS PLATFORM-SCOPED, WHICH WORKS ONLY BECAUSE 0079
       * WIDENED `security_events` — a widening `check-rls-coverage.mjs`
       * records as ACCEPTED with the note that `server/security/anomalies.ts`
       * depends on it. This page is now a second dependant; that is stated
       * here rather than discovered later.
       */
      let recentSecurity: { eventType: string; severity: string; n: number }[] = [];
      if (await relationExists(tx, "security_events")) {
        recentSecurity = rows(
          await tx.execute(sql`
            SELECT event_type::text AS event_type,
                   severity::text   AS severity,
                   count(*)::int    AS n
              FROM security_events
             WHERE occurred_at >= now() - interval '1 hour'
             GROUP BY 1, 2
             ORDER BY 3 DESC
             LIMIT 20
          `),
        ).map((r) => ({
          eventType: str(r.event_type) ?? "unknown",
          severity: str(r.severity) ?? "info",
          n: num(r.n),
        }));
      }

      /* ---- alerts ------------------------------------------------ */
      let alerts: AlertRow[] = [];
      if (haveAlerts) {
        alerts = rows(
          await tx.execute(sql`
            SELECT id, alert_key, runbook_key, severity, title, tenant_id,
                   first_raised_at, last_raised_at, raise_count, suppressed_count,
                   delivered_at, delivery_error, acknowledged_at, acknowledged_by
              FROM observability_alerts
             ORDER BY last_raised_at DESC
             LIMIT 40
          `),
        ).map((r) => ({
          id: str(r.id) ?? "",
          alertKey: str(r.alert_key) ?? "",
          runbookKey: str(r.runbook_key) ?? "",
          severity: str(r.severity) ?? "warning",
          title: str(r.title) ?? "",
          tenantId: str(r.tenant_id),
          firstRaisedAt: toDate(r.first_raised_at),
          lastRaisedAt: toDate(r.last_raised_at),
          raiseCount: num(r.raise_count),
          suppressedCount: num(r.suppressed_count),
          delivered: r.delivered_at !== null && r.delivered_at !== undefined,
          deliveryError: str(r.delivery_error),
          acknowledgedAt: toDate(r.acknowledged_at),
          acknowledgedBy: str(r.acknowledged_by),
        }));

        const openByTenant = rows(
          await tx.execute(sql`
            SELECT tenant_id, count(*)::int AS n
              FROM observability_alerts
             WHERE acknowledged_at IS NULL AND tenant_id IS NOT NULL
             GROUP BY tenant_id
          `),
        );
        const openMap = new Map(openByTenant.map((r) => [str(r.tenant_id) ?? "", num(r.n)]));
        tenants = tenants.map((t) => ({ ...t, openAlerts: openMap.get(t.tenantId) ?? 0 }));
      }

      return {
        haveOutcomes,
        haveAlerts,
        scheduler,
        overdueNow,
        availability,
        fastWindow,
        latency,
        latencyFast,
        mail,
        jobs,
        tenants,
        alerts,
        recentSecurity,
        recorderLastWriteAt,
      };
    },
  );

  if (!data) {
    notes.push(
      "The database could not be read. Every objective below is reported as unmeasured " +
        "rather than healthy — an unreachable database is the moment a status page is for.",
    );
    return {
      generatedAt,
      slos: SLOS.map((s) => ({
        evaluation: evaluateSlo(s.id, 0, 0),
        fastBurn: null,
      })),
      recorderLastWriteAt: null,
      recorderStalled: true,
      tenants: [],
      alerts: [],
      recentSecurity: [],
      scheduler: {
        present: false,
        callable: false,
        found: [],
        why: "the database could not be read at all.",
      },
      overdueNow: null,
      notes,
    };
  }

  if (!data.haveOutcomes) {
    notes.push(
      "request_outcomes does not exist. SQL-FILES/0133 has not been applied to this " +
        "database, so availability and latency have no denominator and are unmeasured.",
    );
  }
  if (!data.haveAlerts) {
    notes.push("observability_alerts does not exist. SQL-FILES/0135 has not been applied.");
  }
  if (!data.scheduler.present) {
    notes.push(
      "Track A's scheduler is not in this database: " +
        data.scheduler.why +
        " Job cadence is unmeasured, which is not the same as no failures.",
    );
  } else if (!data.scheduler.callable) {
    notes.push(
      "scheduler_overdue() exists but could not be read: " +
        data.scheduler.why +
        " Reading it is the only definition of 'overdue' this page will accept, so job " +
        "cadence stays unmeasured rather than being recomputed a second way.",
    );
  } else if (data.overdueNow !== null && data.overdueNow > 0) {
    notes.push(
      `scheduler_overdue() reports ${data.overdueNow} job(s) outside their window right now. ` +
        "That is a current state, not a thirty-day rate — the objective below is computed " +
        "from this sweep's own observations.",
    );
  }
  if (data.mail === null) {
    notes.push("email_outbox does not exist; mail delivery is unmeasured.");
  } else if (data.mail.sample === 0) {
    notes.push(
      "email_outbox has no terminal rows in the window. 🔴 SQL-FILES/0127 exists because " +
        "the application role held no UPDATE on that table, so its delivery status could " +
        "never be written back — check that 0127 is applied before reading anything into this.",
    );
  }

  const slos: SloSnapshot[] = SLOS.map((slo) => {
    const measured = measurementFor(slo.id, data);
    const evaluation = evaluateSlo(slo.id, measured.sample, measured.bad);
    return { evaluation, fastBurn: fastBurnFor(slo.id, data) };
  });

  const recorderStalled = isStalled(data.recorderLastWriteAt, generatedAt, data.haveOutcomes);
  if (recorderStalled && data.haveOutcomes) {
    notes.push(
      "🔴 The recorder has not written for more than 15 minutes. Every number above is " +
        "computed over a window it may not have observed. Runbook: recorder-stalled.",
    );
  }

  return {
    generatedAt,
    slos,
    recorderLastWriteAt: data.recorderLastWriteAt,
    recorderStalled,
    tenants: data.tenants,
    alerts: data.alerts,
    recentSecurity: data.recentSecurity,
    scheduler: data.scheduler,
    overdueNow: data.overdueNow,
    notes,
  };
}

/* ================================================================== */
/* MEASUREMENT SELECTION                                               */
/* ================================================================== */

type SnapshotData = {
  availability: { sample: number; bad: number };
  scheduler: SchedulerProbe;
  overdueNow: number | null;
  fastWindow: { sample: number; bad: number };
  latency: { buckets: number; breaching: number };
  latencyFast: { buckets: number; breaching: number };
  mail: { sample: number; bad: number } | null;
  jobs: { sample: number; bad: number } | null;
};

function measurementFor(id: SloId, data: SnapshotData): { sample: number; bad: number } {
  switch (id) {
    case "app.availability":
      return data.availability;
    case "route.latency_p95":
      return { sample: data.latency.buckets, bad: data.latency.breaching };
    case "mail.delivery":
      // ⚠️ `{0,0}` MEANS UNMEASURED, because `evaluateSlo` refuses any
      // sample below the objective's `minimumSample`. It does NOT mean
      // "zero failures".
      return data.mail ?? { sample: 0, bad: 0 };
    case "job.cadence":
      return data.jobs ?? { sample: 0, bad: 0 };
    default:
      return { sample: 0, bad: 0 };
  }
}

function fastBurnFor(
  id: SloId,
  data: SnapshotData,
): { windowHours: number; failureFraction: number; burnRate: number } | null {
  /**
   * ⚠️ EACH OBJECTIVE NAMES ITS OWN SHORT-WINDOW SAMPLE AND ITS OWN FLOOR.
   * The floors are not decoration: two failures out of three at 4am is a 66%
   * failure rate, a 133x burn rate, and also three requests. Paging for that
   * is how an alert channel gets muted.
   *
   * ⚠️ AND AN OBJECTIVE WITH NO SHORT-WINDOW SOURCE RETURNS null RATHER THAN
   * A ZERO BURN. `mail.delivery` and `job.cadence` are both slow-moving —
   * a mail failure is visible in the thirty-day number and a job check
   * arrives every fifteen minutes — so neither has an hourly burn, and
   * saying "no burn" for them would be a measurement nobody took.
   */
  if (id === "app.availability") {
    const { sample, bad } = data.fastWindow;
    if (sample < 100) return null;
    const failureFraction = bad / sample;
    return { windowHours: 1, failureFraction, burnRate: burnRateOver(id, failureFraction) };
  }

  if (id === "route.latency_p95") {
    const { buckets, breaching } = data.latencyFast;
    /*
     * ⚠️ SIX FIVE-MINUTE BUCKETS — half an hour of traffic on the hot
     * routes. Below that a single slow bucket is a 16% breach rate and a
     * 16x burn, which is one unlucky cold start.
     */
    if (buckets < 6) return null;
    const failureFraction = breaching / buckets;
    return { windowHours: 1, failureFraction, burnRate: burnRateOver(id, failureFraction) };
  }

  return null;
}

/* ================================================================== */
/* RECORDER FRESHNESS                                                  */
/* ================================================================== */

/** Minutes of silence after which the numbers above stop being trustworthy. */
export const RECORDER_STALL_MINUTES = 15;

function isStalled(last: Date | null, now: Date, haveTable: boolean): boolean {
  if (!haveTable) return true;
  if (!last) {
    /**
     * ⚠️ NEVER WRITTEN IS STALLED, NOT FRESH. A brand-new deployment and a
     * recorder that has never worked look identical from here, and only
     * one of them is safe to assume.
     */
    return true;
  }
  return now.getTime() - last.getTime() > RECORDER_STALL_MINUTES * 60 * 1_000;
}

/* ================================================================== */
/* SMALL HELPERS                                                       */
/* ================================================================== */

function clampDays(days: number | undefined): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(Math.round(days as number), 1), 90);
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Is Track A's scheduler here, and can its own definition of "overdue" be
 * read?
 *
 * ⚠️ THREE SEPARATE QUESTIONS, ANSWERED SEPARATELY, because "no scheduler",
 * "a scheduler whose function signature changed" and "a scheduler with
 * nothing overdue" are three different facts and only one of them is good
 * news. Collapsing them is how a status page reports a healthy scheduler
 * that is not installed.
 *
 * ⚠️ THE ARGUMENT LIST IS CHECKED, NOT ASSUMED. `scheduler_overdue()` is
 * called with no arguments; if Track A ever gives it a parameter, calling it
 * would throw inside a platform-scoped transaction and take the whole
 * snapshot down — on the one page an operator opens when things are already
 * wrong. Reading `pg_get_function_arguments` first turns that into a note.
 *
 * ⚠️ AND ONLY `count(*)` IS READ FROM IT. Nothing here touches a column of
 * its result, so a change to what `scheduler_overdue()` RETURNS cannot break
 * this page. The one thing this depends on is that a row means an overdue
 * job, which is the function's whole purpose.
 */
export type SchedulerProbe = {
  /** The run ledger and the expectations table both exist. */
  present: boolean;
  /** `scheduler_overdue()` exists, takes no arguments, and was read. */
  callable: boolean;
  /** Which of Track A's objects were found. Rendered on the surface. */
  found: string[];
  why: string;
};

/** Track A's objects, by their real names. No guessing. */
const SCHEDULER_TABLES = [
  "scheduler_runs",
  "scheduler_job_controls",
  "scheduler_job_expectations",
  "scheduler_tenant_schedules",
  "scheduler_tenant_pauses",
  "scheduler_heartbeat",
] as const;

async function probeScheduler(tx: TxLike): Promise<SchedulerProbe> {
  const { sql } = await import("drizzle-orm");

  const found: string[] = [];
  for (const table of SCHEDULER_TABLES) {
    if (await relationExists(tx, table)) found.push(table);
  }

  const hasLedger = found.includes("scheduler_runs");
  const hasExpectations = found.includes("scheduler_job_expectations");

  if (!hasLedger || !hasExpectations) {
    return {
      present: false,
      callable: false,
      found,
      why:
        `found ${found.length} of ${SCHEDULER_TABLES.length} scheduler tables` +
        (found.length > 0 ? ` (${found.join(", ")})` : "") +
        `; scheduler_runs and scheduler_job_expectations are both required.`,
    };
  }

  const signature = rows(
    await tx.execute(sql`
      SELECT pg_get_function_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'scheduler_overdue'
       LIMIT 1
    `),
  )[0];

  if (!signature) {
    return {
      present: true,
      callable: false,
      found,
      why: "scheduler_overdue() does not exist, so there is no authoritative definition of overdue to read.",
    };
  }

  const args = typeof signature.args === "string" ? signature.args.trim() : "?";
  if (args.length > 0) {
    return {
      present: true,
      callable: false,
      found,
      why: `scheduler_overdue(${args}) takes arguments; this page only calls the no-argument form, so it will not guess at them.`,
    };
  }

  return { present: true, callable: true, found, why: "scheduler_overdue() read." };
}

/**
 * ⚠️ 🔴 THERE WAS A `columnExists()` HELPER HERE AND IT WAS DELETED.
 *
 * It probed for `status` and `started_at` on whichever job table the old
 * guessing probe happened to match. Pinning to Track A's real names and
 * reading `scheduler_overdue()` removed its only caller. Deleted rather than
 * left: the rule this track enforces on everybody else is call it or delete
 * it, and an unused schema-probing helper is exactly the sort of thing the
 * next person reaches for instead of asking which table they mean.
 */
