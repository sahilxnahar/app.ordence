/**
 * Ordence — Service level objectives, error budgets and burn rate
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * AN SLO WITHOUT A BUDGET AND A WRITTEN CONSEQUENCE IS A WISH
 * ══════════════════════════════════════════════════════════════════════
 * "99.9% uptime" on a slide commits nobody to anything. What makes it an
 * objective is the second sentence: how much failure it BUYS you, and
 * what happens when you have spent it. Both are fields on the type below,
 * both are required, and `docs/SLOS.md` is generated from the same
 * constant so the document cannot drift from the code the way
 * `RAILWAY-VARIABLES-PASTE.txt` drifted from `lib/platform/env-catalog.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY OBJECTIVE HERE CAN REPORT "UNMEASURED", AND MUST
 * ══════════════════════════════════════════════════════════════════════
 * This is the single most important design decision in the file, and it
 * is a direct answer to this repository's characteristic defect: a
 * coverage check written `count(*) >= 10 THEN 'PASS'` on a property that
 * needed to hold for 303 tables, which passed at 48.
 *
 * A ratio over an empty denominator is 0/0. Report it as 100% and every
 * dashboard is green on the morning the recorder stopped writing — which
 * is exactly the morning you need it. So `evaluateSlo()` returns the
 * discriminated state `"unmeasured"` when there is not enough data, the
 * status surface renders that in its own colour, and there is no code
 * path anywhere in this track that turns an absent measurement into a
 * healthy one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TARGETS ARE DELIBERATELY MODEST
 * ══════════════════════════════════════════════════════════════════════
 * This is a single Railway service, one region, on a Neon Free-tier
 * database, with no scheduler until wave 14 and no multi-region anything.
 * 99.9% would be a number nobody could hold and everybody would learn to
 * ignore. 99.5% over thirty days is 3 hours 39 minutes of budget, which
 * is roughly what one bad deploy plus one Neon cold-start incident costs
 * — i.e. it is a number that will actually be spent, noticed and argued
 * about, which is the only kind worth writing down.
 */

/* ================================================================== */
/* TYPES                                                               */
/* ================================================================== */

export type SloId =
  | "app.availability"
  | "route.latency_p95"
  | "mail.delivery"
  | "job.cadence";

export type SloKind =
  /** A fraction of events that must succeed. Budget is measured in events. */
  | "ratio"
  /** A fraction of TIME BUCKETS that must meet a threshold. Budget is in buckets. */
  | "bucketed";

export type Slo = {
  id: SloId;
  title: string;
  /** The objective in one sentence, in the words you would use to a customer. */
  statement: string;
  kind: SloKind;
  /** 0..1. The fraction of good events (or good buckets) required. */
  target: number;
  /** Rolling window, in days. */
  windowDays: number;
  /**
   * ⚠️ THE SMALLEST DENOMINATOR AT WHICH THIS OBJECTIVE MEANS ANYTHING.
   * Below it, `evaluateSlo` returns "unmeasured" rather than a ratio. A
   * 100% success rate over four requests is not a 100% success rate.
   */
  minimumSample: number;
  /** For `bucketed`: the threshold a bucket must beat. Milliseconds. */
  thresholdMs?: number;
  /** Where the numbers come from. Named so a reader can go and check. */
  measuredBy: string;
  /**
   * 🔴 WHAT HAPPENS WHEN THE BUDGET IS GONE. Not advice — the rule.
   */
  consequence: string;
  /**
   * ⭐ WHAT THE PERSON DOES AT 3AM. Every alert this track can raise has
   * one of these, and an alert that cannot be given one is not added.
   */
  runbook: string;
};

/* ================================================================== */
/* THE FOUR                                                            */
/* ================================================================== */

export const SLOS: readonly Slo[] = [
  {
    id: "app.availability",
    title: "The authenticated app answers",
    statement:
      "99.5% of authenticated requests over 30 days complete without a server error.",
    kind: "ratio",
    target: 0.995,
    windowDays: 30,
    /**
     * ⚠️ 1,000 REQUESTS, NOT 100. At 99.5% the budget is 5 failures per
     * thousand; a window holding 100 requests cannot distinguish 99.5%
     * from 99% and would flip the objective red or green on one event.
     */
    minimumSample: 1_000,
    measuredBy:
      "request_outcomes: outcome='failed' against all outcomes, per tenant and overall. " +
      "'invalid' (4xx) and 'denied' are excluded — a customer sending a bad request is not an outage.",
    consequence:
      "Feature work stops. The next deploy may contain only reliability fixes, and the " +
      "burn is reviewed before any release goes out. Exhausting this budget twice in " +
      "two consecutive windows moves the region/replica decision from the roadmap to the sprint.",
    runbook:
      "Open /platform/reliability and read the per-tenant table first, not the total. " +
      "One tenant at 40% and 200 tenants at 0% is a data problem in one workspace; a flat " +
      "rise across every tenant is the platform. Then group error_events by fingerprint over " +
      "the same window — the top fingerprint is almost always the whole incident.",
  },
  {
    id: "route.latency_p95",
    title: "The ten hottest routes stay quick",
    statement:
      "In 99% of five-minute buckets over 30 days, p95 latency on each of the ten " +
      "busiest routes is at or below 800 ms.",
    kind: "bucketed",
    target: 0.99,
    windowDays: 30,
    thresholdMs: 800,
    /**
     * 288 buckets is one day. Judging a 30-day objective on less than a
     * day of buckets reports yesterday's deploy as this month's trend.
     */
    minimumSample: 288,
    measuredBy:
      "request_outcomes latency histogram buckets, per route_pattern. p95 is read off the " +
      "histogram, not computed from an average — an average latency cannot tell a slow " +
      "route from a route with a slow tail, and only the tail is felt.",
    consequence:
      "The slowest route by budget spend gets an owner and a written plan before the next " +
      "planning cycle. If a single route is responsible for more than half the spend it is " +
      "capped or paginated, not optimised in place.",
    runbook:
      "Read which ROUTE is burning, then the query behind it: the trace id on the slow " +
      "request appears in the statement's sqlcommenter comment, so " +
      "pg_stat_statements can be filtered to exactly that request. If every route moved at " +
      "once it is the database, not the code — check Neon compute suspend/resume first, " +
      "which shows as a uniform multi-second step across unrelated routes.",
  },
  {
    id: "mail.delivery",
    title: "Mail we accepted actually leaves",
    statement:
      "99.0% of messages the product queues over 30 days are accepted by the provider.",
    kind: "ratio",
    target: 0.99,
    windowDays: 30,
    minimumSample: 200,
    measuredBy:
      "The email outbox delivery column, populated by server/email/outbox.ts. " +
      "🔴 SEE THE CAVEAT IN docs/SLOS.md: SQL-FILES/0127 exists because the application role " +
      "held no UPDATE on that table, so the column could never be written. This objective is " +
      "'unmeasured' until 0127 is applied AND a delivery result has actually been written back.",
    consequence:
      "Below target, outbound campaigns are paused before transactional mail is touched: an " +
      "invoice that does not arrive costs a customer money, a newsletter that does not arrive " +
      "costs nothing. Sustained failure means the sending domain's reputation is investigated " +
      "before any code is changed.",
    runbook:
      "Check the provider's own status first — a Resend outage is not a code defect and the " +
      "queue will drain. If the provider is healthy, read the failure_reason column: a " +
      "concentration on one recipient domain is a reputation problem, a spread across all " +
      "domains is an API key or quota problem.",
  },
  {
    id: "job.cadence",
    title: "Scheduled work runs when it says it does",
    statement:
      "In 99% of checks over 30 days, no scheduled job is outside its declared cadence window.",
    kind: "ratio",
    target: 0.99,
    windowDays: 30,
    minimumSample: 100,
    measuredBy:
      "scheduler_overdue(), Track A's own answer to 'which jobs have not run inside their " +
      "window', observed by each sweep and recorded into request_outcomes under " +
      "kind='job', route '/jobs/scheduler.cadence'. The cadence itself lives in " +
      "scheduler_job_expectations and is NOT re-derived here — two definitions of overdue " +
      "would agree for a while and then quietly disagree, and the one on this page would " +
      "be the untested one. 🔴 Reports 'unmeasured' until the sweep has run 100 times " +
      "(about a day at a fifteen-minute cadence) and whenever scheduler_overdue() is " +
      "absent or has grown an argument list.",
    consequence:
      "A job that is overdue in two consecutive checks is disabled rather than left to " +
      "retry: six of these functions already spent a year being correct and uncalled, and " +
      "a job that silently half-runs is worse than one that is visibly off.",
    runbook:
      "Ask whether the scheduler is RUNNING before asking why a job is late — " +
      "scheduler_heartbeat and scheduler_watchdog_status() answer that, and 'nothing has " +
      "run at all' is a different incident from 'one job is slow'. Then read " +
      "scheduler_overdue() itself rather than this page: it names the jobs. If a job is " +
      "per-tenant, check scheduler_tenant_pauses before assuming it is broken — a paused " +
      "workspace is a decision somebody made, and scheduler_pause_reason() says who and " +
      "why. A sweep that overruns its own cadence grows with the customer count and will " +
      "not fix itself.",
  },
] as const;

const SLO_BY_ID = new Map<SloId, Slo>(SLOS.map((s) => [s.id, s]));

export function sloById(id: SloId): Slo {
  const found = SLO_BY_ID.get(id);
  // Unreachable while SloId is derived from SLOS, and cheap insurance
  // against the day somebody widens the union without adding the entry.
  if (!found) throw new Error(`Unknown SLO id: ${id}`);
  return found;
}

/* ================================================================== */
/* ERROR BUDGET                                                        */
/* ================================================================== */

export type SloEvaluation =
  | {
      state: "unmeasured";
      slo: Slo;
      /** How many events/buckets were seen, so the reader knows how far off it is. */
      sample: number;
      why: string;
    }
  | {
      state: "measured";
      slo: Slo;
      sample: number;
      /** Events (or buckets) that failed the objective. */
      bad: number;
      /** 0..1, observed. */
      achieved: number;
      /** Total budget for the window, in events/buckets. */
      budget: number;
      /** How much of it is gone, 0..1. Can exceed 1 — that is the point. */
      consumed: number;
      /**
       * Burn rate: how many times faster than "spend it evenly across the
       * window" the budget is going. 1.0 means it lasts exactly the window.
       */
      burnRate: number;
      breached: boolean;
    };

/**
 * Evaluate an objective from a numerator and a denominator.
 *
 * ⚠️ `bad` IS THE NUMERATOR OF FAILURE, NOT SUCCESS. Passing successes
 * here would produce a number that looks plausible and is inverted, and
 * nothing downstream could tell. The parameter is named for the thing it
 * counts for exactly that reason.
 */
export function evaluateSlo(id: SloId, sample: number, bad: number): SloEvaluation {
  const slo = sloById(id);

  if (!Number.isFinite(sample) || sample < slo.minimumSample) {
    return {
      state: "unmeasured",
      slo,
      sample: Number.isFinite(sample) ? sample : 0,
      why:
        `Only ${Number.isFinite(sample) ? sample : 0} of the ${slo.minimumSample} ` +
        `observations this objective needs. A ratio over too small a denominator is ` +
        `not a measurement, and reporting it as healthy is how a stopped recorder ` +
        `reads as a working system.`,
    };
  }

  const badCount = Number.isFinite(bad) && bad > 0 ? Math.min(bad, sample) : 0;
  const achieved = (sample - badCount) / sample;
  const budget = sample * (1 - slo.target);
  // budget is > 0 whenever target < 1 and sample >= minimumSample >= 100.
  const consumed = budget > 0 ? badCount / budget : badCount > 0 ? Infinity : 0;

  return {
    state: "measured",
    slo,
    sample,
    bad: badCount,
    achieved,
    budget,
    consumed,
    /**
     * ⚠️ BURN RATE AND CONSUMPTION ARE THE SAME NUMBER OVER A FULL
     * WINDOW, AND DIFFERENT OVER A SHORT ONE. This function is given
     * whatever window the caller measured; `burnRateOver()` below is what
     * turns a one-hour sample into "at this rate the month is gone in
     * two days".
     */
    burnRate: consumed,
    breached: achieved < slo.target,
  };
}

/**
 * Multi-window burn rate: given a short window's failure fraction, how
 * fast is the month's budget going?
 *
 * ⭐ THE TWO THRESHOLDS BELOW ARE THE GOOGLE SRE WORKBOOK'S, and they are
 * used unmodified because the arithmetic behind them does not depend on
 * our traffic: 14.4x over one hour spends 2% of a 30-day budget in that
 * hour; 6x over six hours spends 5%. Inventing our own numbers here would
 * be inventing our own answer to "how long may we not notice", which is
 * the one question the literature has already answered well.
 */
export const BURN_ALERT_WINDOWS = [
  {
    id: "fast",
    windowHours: 1,
    burnRate: 14.4,
    meaning: "2% of a 30-day budget in one hour. Page somebody.",
  },
  {
    id: "slow",
    windowHours: 6,
    burnRate: 6,
    meaning: "5% of a 30-day budget in six hours. Look today, not now.",
  },
] as const;

export function burnRateOver(
  id: SloId,
  failureFraction: number,
): number {
  const slo = sloById(id);
  const allowed = 1 - slo.target;
  if (allowed <= 0) return failureFraction > 0 ? Infinity : 0;
  if (!Number.isFinite(failureFraction) || failureFraction <= 0) return 0;
  return failureFraction / allowed;
}

/**
 * Which alert, if any, a short-window observation justifies. Returns null
 * when nothing should fire — and null is the common case by design.
 */
/**
 * ⚠️ 🔴 THE EPSILON BELOW IS NOT DEFENSIVE PADDING. IT IS A DEFECT THAT
 *    WAS FOUND BY A TEST AND WOULD NEVER HAVE BEEN FOUND BY READING.
 *
 * `1 - 0.995` is not 0.005 in IEEE 754. It is 0.0050000000000000044. So a
 * failure fraction of exactly 7.2% — which is exactly 14.4x the allowed
 * budget, the threshold at which somebody gets paged — divides out to
 * 14.399999999999987, and `rate < 14.4` is TRUE.
 *
 * 🔴 THE CONSEQUENCE IS PRECISELY THE WORST ONE AVAILABLE: at the
 * boundary, the PAGE-SOMEBODY alert silently degrades into the
 * LOOK-AT-IT-TODAY alert. Nothing errors, an alert still fires, and it
 * fires with the wrong urgency at the one moment urgency is the whole
 * point. An alert that is quietly one severity too low is worse than no
 * alert, because it is believed.
 *
 * A relative epsilon rather than an absolute one, because the same
 * arithmetic applies to any target somebody adds later.
 */
const BURN_COMPARISON_EPSILON = 1e-9;

export function burnAlertFor(
  id: SloId,
  windowHours: number,
  failureFraction: number,
): (typeof BURN_ALERT_WINDOWS)[number] | null {
  const rate = burnRateOver(id, failureFraction);
  let match: (typeof BURN_ALERT_WINDOWS)[number] | null = null;
  for (const w of BURN_ALERT_WINDOWS) {
    if (windowHours > w.windowHours) continue;
    if (rate < w.burnRate * (1 - BURN_COMPARISON_EPSILON)) continue;
    // Prefer the fastest window that fires, so a genuine emergency is not
    // reported as a "look at it today".
    if (!match || w.windowHours < match.windowHours) match = w;
  }
  return match;
}

/** Budget expressed as time, which is the only form anybody argues about. */
export function budgetMinutes(id: SloId): number {
  const slo = sloById(id);
  return Math.round(slo.windowDays * 24 * 60 * (1 - slo.target));
}
