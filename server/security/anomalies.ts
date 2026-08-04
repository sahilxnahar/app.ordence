import "server-only";

/**
 * Ordence — Rule-Based Anomaly Detection
 * Version: v0.12.0-alpha (Phase 20)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THERE IS NO MACHINE LEARNING HERE, AND THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * Every rule below is a counting rule with a threshold and a window, written
 * out in TypeScript, readable by anyone, and testable with a fixed array of
 * inputs. That is a deliberate refusal, not a shortcut.
 *
 * An anomaly model on this data would be worse in four specific ways:
 *
 *   1. IT COULD NOT BE EXPLAINED. "Why was this account locked?" has to have
 *      an answer a support agent can give a customer. "The model scored the
 *      session at 0.83" is not that answer, and on a platform holding
 *      accounting records it is not a defensible one either.
 *
 *   2. IT WOULD BE TRAINED ON NOTHING. We have no labelled intrusions. A
 *      model trained on our current traffic learns that our current traffic
 *      is normal — including any compromise already in progress.
 *
 *   3. IT WOULD DRIFT SILENTLY. A threshold that stops firing is visible in
 *      code review. A model that stops firing looks exactly like a quiet
 *      month.
 *
 *   4. THE ATTACKS WORTH CATCHING ARE NOT SUBTLE. Credential stuffing,
 *      token enumeration and bulk export at 3am are all obvious in a COUNT.
 *      Anything subtle enough to need a model is beyond what a five-rule
 *      detector was ever going to catch, and pretending otherwise is how a
 *      security feature becomes decorative.
 *
 * When these rules produce too many false positives, RAISE THE THRESHOLD and
 * write down why. That is a conversation. A model retrain is not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * STRUCTURE: PURE RULES, IMPURE RUNNER
 * ══════════════════════════════════════════════════════════════════════
 * Each rule is a pure function over an array of observations. The runner
 * fetches the observations and records the findings. Splitting them means the
 * thresholds are tested with fixed arrays in `tests/ui/security-events.test.tsx`
 * — with no database, no clock and no flakiness — which is the only way a
 * boundary condition ("exactly at the threshold does NOT fire, one past it
 * does") gets asserted honestly.
 */

import { and, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { securityEvents } from "@/db/schema/secops";
import { permissionDenials } from "@/db/schema";
import { recordSecurityEvent } from "./record";
import type { SecuritySeverity } from "@/lib/security/events";

/* ------------------------------------------------------------------ */
/* OBSERVATIONS                                                        */
/* ------------------------------------------------------------------ */

/**
 * The minimal shape a rule needs. Deliberately NOT the full row type: a rule
 * that can see the whole row will eventually reach for a field that only
 * exists in the database, and then it can no longer be tested without one.
 */
export type Observation = {
  eventType: string;
  tenantId: string | null;
  subjectId: string | null;
  ipPrefix: string | null;
  occurrenceCount: number;
  occurredAt: Date;
};

export type DenialObservation = {
  tenantId: string;
  userId: string | null;
  permission: string;
  createdAt: Date;
};

export type AnomalyFinding = {
  /** Stable identifier. SIEM correlation rules key on this, so it never changes. */
  ruleId: string;
  title: string;
  severity: SecuritySeverity;
  tenantId: string | null;
  /** What the finding is about — an IP prefix, a user id, a token hash. */
  subjectType: string;
  subjectId: string | null;
  /** How many underlying occurrences supported it. */
  count: number;
  windowMinutes: number;
  detail: Record<string, unknown>;
};

/* ------------------------------------------------------------------ */
/* THRESHOLDS                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every number here is a judgement call and each one is justified where it is
 * defined. They are collected in one object so tuning is a single reviewable
 * diff rather than a hunt through five functions.
 */
export const ANOMALY_THRESHOLDS = {
  /**
   * 15 failed sign-ins from one network in 10 minutes.
   *
   * The auth rate limit already caps a single source at 10/minute, so this
   * fires on someone SUSTAINING the attempt across the limit rather than
   * bouncing off it once. A shared office network with genuinely forgetful
   * users produces perhaps three or four in ten minutes.
   */
  failedLoginCount: 15,
  failedLoginWindowMinutes: 10,

  /**
   * 25 permission denials by ONE USER in 15 minutes.
   *
   * A confused user clicks a forbidden button two or three times and then
   * asks someone. Twenty-five is a script walking the route table — which is
   * what a compromised session does first, to find out what it has.
   *
   * ⚠️ Keyed by user, not by tenant. A tenant-wide count would fire on a
   * Monday morning after a role change removed a permission from forty
   * people at once, which is a misconfiguration, not an attack.
   */
  denialCount: 25,
  denialWindowMinutes: 15,

  /**
   * One portal token presented from 5 distinct /24s (or /64s) in an hour.
   *
   * A legitimate recipient opens a link from the office and then from their
   * phone: two networks, maybe three with a VPN. Five distinct networks for
   * one contract link means the URL has been forwarded — or is being
   * enumerated from a proxy pool.
   *
   * Prefixes, not addresses: a mobile client changes address between requests
   * within one /64, and counting addresses would fire on one person on a
   * train.
   */
  portalDistinctNetworks: 5,
  portalWindowMinutes: 60,

  /**
   * 500 records exported in one action, or ANY export in the off-hours
   * window, are separately interesting; both together are the classic
   * departing-employee signature.
   */
  bulkExportRecords: 500,
  /** IST. 22:00–06:00 is outside every working pattern this product serves. */
  offHoursStartHourIst: 22,
  offHoursEndHourIst: 6,

  /**
   * 40 rate-limit trips from one network in 15 minutes.
   *
   * One trip is a client bug. Forty is someone who has noticed the limit and
   * is running against it deliberately.
   */
  rateLimitTripCount: 40,
  rateLimitTripWindowMinutes: 15,
} as const;

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

function withinWindow(at: Date, nowMs: number, windowMinutes: number): boolean {
  return nowMs - at.getTime() <= windowMinutes * 60_000;
}

/**
 * The hour of a timestamp in Asia/Kolkata.
 *
 * Computed by offset rather than by `Intl` because this runs on the Edge and
 * in Node and in a test, and `Intl` timezone data is not guaranteed present
 * in every one of those. IST is UTC+05:30 and has no daylight saving — the
 * one timezone where fixed-offset arithmetic is actually correct.
 */
export function istHour(at: Date): number {
  const istMs = at.getTime() + (5 * 60 + 30) * 60_000;
  return new Date(istMs).getUTCHours();
}

/** True when the moment falls in the off-hours window (22:00–06:00 IST). */
export function isOffHoursIst(at: Date): boolean {
  const hour = istHour(at);
  return (
    hour >= ANOMALY_THRESHOLDS.offHoursStartHourIst ||
    hour < ANOMALY_THRESHOLDS.offHoursEndHourIst
  );
}

/** Group observations by a key, skipping those with no key. */
function groupBy<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* RULE 1 — FAILED LOGIN BURST                                         */
/* ------------------------------------------------------------------ */

/**
 * N failed sign-ins from one network inside a window.
 *
 * ⚠️ Uses `occurrenceCount`, not row count. The recorder coalesces bursts, so
 * counting rows would UNDERCOUNT an attack by exactly the factor that makes
 * it an attack — the more aggressive the attempt, the more it is coalesced,
 * the less it looks like one. That inversion is the subtle bug this line
 * exists to avoid.
 */
export function detectFailedLoginBurst(
  observations: Observation[],
  nowMs: number,
): AnomalyFinding[] {
  const relevant = observations.filter(
    (o) =>
      o.eventType === "auth.login_failed" &&
      withinWindow(o.occurredAt, nowMs, ANOMALY_THRESHOLDS.failedLoginWindowMinutes),
  );

  const findings: AnomalyFinding[] = [];

  for (const [prefix, rows] of groupBy(relevant, (o) => o.ipPrefix)) {
    const count = rows.reduce((sum, r) => sum + r.occurrenceCount, 0);
    if (count <= ANOMALY_THRESHOLDS.failedLoginCount) continue;

    findings.push({
      ruleId: "auth.failed_login_burst",
      title: "Repeated failed sign-ins from one network",
      severity: "critical",
      tenantId: rows[0]?.tenantId ?? null,
      subjectType: "ip_prefix",
      subjectId: prefix,
      count,
      windowMinutes: ANOMALY_THRESHOLDS.failedLoginWindowMinutes,
      detail: {
        rule: "auth.failed_login_burst",
        threshold: ANOMALY_THRESHOLDS.failedLoginCount,
        distinctAccounts: new Set(rows.map((r) => r.subjectId ?? "-")).size,
      },
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* RULE 2 — PERMISSION DENIAL SPIKE                                    */
/* ------------------------------------------------------------------ */

/**
 * A single user being refused repeatedly.
 *
 * This is the one rule that reads the OTHER table. `permission_denials` owns
 * the individual denials; this produces a `security_events` row saying the
 * SHAPE of them changed. Nothing is duplicated — the denials are not copied,
 * only counted, and the finding points back at them.
 */
export function detectDenialSpike(
  denials: DenialObservation[],
  nowMs: number,
): AnomalyFinding[] {
  const relevant = denials.filter((d) =>
    withinWindow(d.createdAt, nowMs, ANOMALY_THRESHOLDS.denialWindowMinutes),
  );

  const findings: AnomalyFinding[] = [];

  for (const [userId, rows] of groupBy(relevant, (d) => d.userId)) {
    if (rows.length <= ANOMALY_THRESHOLDS.denialCount) continue;

    const distinctPermissions = new Set(rows.map((r) => r.permission));

    findings.push({
      ruleId: "authz.denial_spike",
      title: "One user refused many permissions in a short window",
      severity: "warning",
      tenantId: rows[0]?.tenantId ?? null,
      subjectType: "user",
      subjectId: userId,
      count: rows.length,
      windowMinutes: ANOMALY_THRESHOLDS.denialWindowMinutes,
      detail: {
        rule: "authz.denial_spike",
        threshold: ANOMALY_THRESHOLDS.denialCount,
        // Many DISTINCT permissions is the signal that separates "a script
        // enumerating what it can do" from "one broken button clicked a lot".
        distinctPermissions: distinctPermissions.size,
        sample: Array.from(distinctPermissions).slice(0, 10),
      },
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* RULE 3 — PORTAL TOKEN SEEN FROM MANY NETWORKS                       */
/* ------------------------------------------------------------------ */

/**
 * One portal token presented from many distinct networks.
 *
 * The subject is the token HASH prefix that the portal surface records — never
 * the token itself. A rule that needed the raw credential to work would be a
 * rule that forced us to store live credentials in a SIEM-exported table.
 */
export function detectPortalTokenSharing(
  observations: Observation[],
  nowMs: number,
): AnomalyFinding[] {
  const relevant = observations.filter(
    (o) =>
      o.eventType.startsWith("portal.") &&
      o.subjectId !== null &&
      withinWindow(o.occurredAt, nowMs, ANOMALY_THRESHOLDS.portalWindowMinutes),
  );

  const findings: AnomalyFinding[] = [];

  for (const [tokenRef, rows] of groupBy(relevant, (o) => o.subjectId)) {
    const networks = new Set(rows.map((r) => r.ipPrefix ?? "unknown"));
    if (networks.size <= ANOMALY_THRESHOLDS.portalDistinctNetworks) continue;

    findings.push({
      ruleId: "portal.token_shared",
      title: "One portal link used from many networks",
      severity: "warning",
      tenantId: rows[0]?.tenantId ?? null,
      subjectType: "portal_token_ref",
      subjectId: tokenRef,
      count: networks.size,
      windowMinutes: ANOMALY_THRESHOLDS.portalWindowMinutes,
      detail: {
        rule: "portal.token_shared",
        threshold: ANOMALY_THRESHOLDS.portalDistinctNetworks,
        distinctNetworks: networks.size,
        requests: rows.reduce((s, r) => s + r.occurrenceCount, 0),
      },
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* RULE 4 — OFF-HOURS BULK EXPORT                                      */
/* ------------------------------------------------------------------ */

/**
 * A large export outside working hours.
 *
 * ⚠️ THIS RULE DESCRIBES A PERSON, WHICH MAKES IT THE MOST DANGEROUS ONE
 * HERE. "Employee downloaded the client list at 2am" is an accusation, and it
 * is also a perfectly normal thing for an operations lead in a different
 * timezone to do. So it is `notice`, never `critical`, it never triggers an
 * automatic block, and the finding records the volume and the hour rather
 * than an interpretation. It is a prompt to go and ask, not a verdict.
 */
export function detectOffHoursBulkExport(
  observations: Observation[],
  nowMs: number,
): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];

  const relevant = observations.filter(
    (o) => o.eventType.startsWith("export.") && withinWindow(o.occurredAt, nowMs, 24 * 60),
  );

  for (const row of relevant) {
    if (!isOffHoursIst(row.occurredAt)) continue;
    if (row.occurrenceCount < ANOMALY_THRESHOLDS.bulkExportRecords) continue;

    findings.push({
      ruleId: "export.off_hours_bulk",
      title: "Large export outside working hours",
      severity: "notice",
      tenantId: row.tenantId,
      subjectType: "export",
      subjectId: row.subjectId,
      count: row.occurrenceCount,
      windowMinutes: 24 * 60,
      detail: {
        rule: "export.off_hours_bulk",
        istHour: istHour(row.occurredAt),
        recordCount: row.occurrenceCount,
        threshold: ANOMALY_THRESHOLDS.bulkExportRecords,
      },
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* RULE 5 — SUSTAINED RATE-LIMIT PRESSURE                              */
/* ------------------------------------------------------------------ */

/**
 * Many limiter trips from one network.
 *
 * The limiter refusing a request is a non-event. The limiter refusing forty
 * requests from one network in fifteen minutes means the limit is the only
 * thing standing between that source and whatever it wants, which is worth
 * knowing BEFORE the source finds a route that is not limited.
 */
export function detectRateLimitPressure(
  observations: Observation[],
  nowMs: number,
): AnomalyFinding[] {
  const relevant = observations.filter(
    (o) =>
      o.eventType === "rate_limit.exceeded" &&
      withinWindow(o.occurredAt, nowMs, ANOMALY_THRESHOLDS.rateLimitTripWindowMinutes),
  );

  const findings: AnomalyFinding[] = [];

  for (const [prefix, rows] of groupBy(relevant, (o) => o.ipPrefix)) {
    const count = rows.reduce((s, r) => s + r.occurrenceCount, 0);
    if (count <= ANOMALY_THRESHOLDS.rateLimitTripCount) continue;

    findings.push({
      ruleId: "rate_limit.sustained_pressure",
      title: "Sustained rate-limit pressure from one network",
      severity: "warning",
      tenantId: rows[0]?.tenantId ?? null,
      subjectType: "ip_prefix",
      subjectId: prefix,
      count,
      windowMinutes: ANOMALY_THRESHOLDS.rateLimitTripWindowMinutes,
      detail: {
        rule: "rate_limit.sustained_pressure",
        threshold: ANOMALY_THRESHOLDS.rateLimitTripCount,
        policies: Array.from(new Set(rows.map((r) => r.eventType))),
      },
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* EVALUATION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run every rule. Pure — no database, no `Date.now()`.
 *
 * `nowMs` is a parameter rather than a call to the clock because a detector
 * that reads the clock internally can only be tested with sleeps or with the
 * timer mocked globally, and both make the boundary assertions unreliable.
 */
export function evaluateAnomalyRules(
  input: { events: Observation[]; denials: DenialObservation[] },
  nowMs: number,
): AnomalyFinding[] {
  return [
    ...detectFailedLoginBurst(input.events, nowMs),
    ...detectDenialSpike(input.denials, nowMs),
    ...detectPortalTokenSharing(input.events, nowMs),
    ...detectOffHoursBulkExport(input.events, nowMs),
    ...detectRateLimitPressure(input.events, nowMs),
  ];
}

/* ------------------------------------------------------------------ */
/* THE RUNNER                                                          */
/* ------------------------------------------------------------------ */

/** How far back the runner reads. The widest rule window, with headroom. */
const LOOKBACK_MINUTES = 2 * 60;

/**
 * Fetch recent observations, evaluate the rules and record the findings.
 *
 * Intended to be invoked from a scheduled job (QStash / cron), NOT from a
 * request path — it reads a couple of hours of two tables, which is not work
 * a user should ever wait for.
 *
 * ⚠️ Findings are recorded with `noCoalesce: true`. The detector already
 * aggregates; coalescing an aggregate would drop the second distinct finding
 * of the same rule in the same window, and two different networks brute-
 * forcing at once is precisely when you want both rows.
 *
 * ⚠️ IT DOES NOT ACT. No account is locked, no token is revoked, no IP is
 * banned. Automated response on rules this simple would mean an attacker who
 * can forge an `X-Forwarded-For` can get any user locked out on demand —
 * turning our detector into their denial-of-service tool. Response stays
 * human until the rules have a track record.
 */
export async function runAnomalyDetection(options: {
  tenantId?: string | null;
  nowMs?: number;
} = {}): Promise<AnomalyFinding[]> {
  const nowMs = options.nowMs ?? Date.now();
  const since = new Date(nowMs - LOOKBACK_MINUTES * 60_000);

  try {
    /**
     * With no `tenantId` this is a PLATFORM-WIDE run and the filter is the
     * time window alone — deliberately, because that is the only way the
     * unattributed perimeter rows (`tenant_id IS NULL`: forged signatures,
     * unknown portal tokens, pre-session limiter trips) are considered at
     * all, and those are where a pre-authentication attack shows up first.
     *
     * ⚠️ That means this call must be made on a platform-scoped connection.
     * Under RLS a tenant-scoped session sees only its own rows, so a
     * platform run from inside a tenant context silently degrades to a
     * single-tenant run and reports nothing about the perimeter.
     */
    const timeFilter = gte(securityEvents.occurredAt, since);
    const eventWhere = options.tenantId
      ? and(timeFilter, eq(securityEvents.tenantId, options.tenantId))
      : timeFilter;

    const eventRows = await db
      .select({
        eventType: securityEvents.eventType,
        tenantId: securityEvents.tenantId,
        subjectId: securityEvents.subjectId,
        ipPrefix: securityEvents.ipPrefix,
        occurrenceCount: securityEvents.occurrenceCount,
        occurredAt: securityEvents.occurredAt,
      })
      .from(securityEvents)
      .where(eventWhere)
      .limit(20_000);

    const denialRows = options.tenantId
      ? await db
          .select({
            tenantId: permissionDenials.tenantId,
            userId: permissionDenials.userId,
            permission: permissionDenials.permission,
            createdAt: permissionDenials.createdAt,
          })
          .from(permissionDenials)
          .where(
            and(
              gte(permissionDenials.createdAt, since),
              eq(permissionDenials.tenantId, options.tenantId),
            ),
          )
          .limit(20_000)
      : await db
          .select({
            tenantId: permissionDenials.tenantId,
            userId: permissionDenials.userId,
            permission: permissionDenials.permission,
            createdAt: permissionDenials.createdAt,
          })
          .from(permissionDenials)
          .where(gte(permissionDenials.createdAt, since))
          .limit(20_000);

    const findings = evaluateAnomalyRules(
      { events: eventRows as Observation[], denials: denialRows as DenialObservation[] },
      nowMs,
    );

    for (const finding of findings) {
      await recordSecurityEvent(
        {
          type: "anomaly.detected",
          severity: finding.severity,
          tenantId: finding.tenantId,
          source: "anomaly-detector",
          subjectType: finding.subjectType,
          subjectId: finding.subjectId,
          detail: {
            ...finding.detail,
            ruleId: finding.ruleId,
            count: finding.count,
            windowMinutes: finding.windowMinutes,
          },
          reason: finding.title,
        },
        { noCoalesce: true },
      );
    }

    return findings;
  } catch (err) {
    // A detector that throws takes down the cron that runs it, and a cron
    // that has been failing for three weeks is indistinguishable from a quiet
    // three weeks. Loud, and return nothing.
    console.error(
      "[SECURITY] Anomaly detection run failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
