import "server-only";

/**
 * Ordence — Alerts: a runbook the database insists on, and a limiter that
 *           counts across instances
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RULE: NO RUNBOOK, NO ALERT
 * ══════════════════════════════════════════════════════════════════════
 * Every alert raised here names a key in `RUNBOOKS` below, and every
 * entry answers one question: what does the person do at 3am when this
 * fires. TypeScript enforces the key; `observability_alerts.runbook_key`
 * is NOT NULL with a length CHECK, so the database enforces it too, on
 * the day somebody reaches for `as unknown as RunbookKey` during an
 * incident.
 *
 * An alert nobody can action is not neutral. It trains the on-call to
 * ignore the channel, and it takes the actionable alerts down with it.
 * That is why this file has EIGHT alerts and not thirty.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE LIMITER IS IN POSTGRES, NOT IN MEMORY
 * ══════════════════════════════════════════════════════════════════════
 * `lib/security/rate-limit.ts` has said since Phase 20: "Per-instance
 * memory counters are a speed bump, not a control: on a serverless
 * deployment the effective limit is (limit × instances)." Wave 8 found
 * that had been literally true of the authentication limiter for the
 * whole life of the deployment.
 *
 * A `Map` of last-sent timestamps here would be that defect a third time,
 * in the file whose entire job is to not flood a channel. So the limiter
 * is a UNIQUE key and an `ON CONFLICT DO UPDATE ... RETURNING (xmax = 0)`
 * — one atomic statement, correct with any number of Railway instances
 * and no Redis. SQL 0135 proves the discrimination in its own verify
 * block: first raise reports inserted, second reports not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE WEBHOOK URL IS A CREDENTIAL
 * ══════════════════════════════════════════════════════════════════════
 * Anybody holding it can post into the operations channel as us, which is
 * a very convincing place from which to tell an engineer to do something.
 * It is read from the environment at dispatch time and:
 *
 *   • never written to a column, a log line, a report or an error string
 *   • stripped out of any provider error before that error is stored —
 *     the one string a failing HTTP client most likes to include is the
 *     URL it was calling
 *   • never asserted about in a test beyond "set or not set"
 *
 * 🔴 `DISCORD_ALERT_WEBHOOK_URL` IS A NEW SETTING AND IS NOT YET IN
 *    `lib/platform/env-catalog.ts`, WHICH TRACK B DOES NOT OWN. Until the
 *    entry in PATCH-REQUEST-B.md is applied, `npm run check:env-catalogue`
 *    FAILS with exactly one problem naming this file. That is recorded
 *    here, in TRACK-REPORT.md §4 and in the patch request, rather than
 *    worked around — a gate evaded is worse than a gate red.
 */

import { log } from "@/lib/telemetry/log";
import { logContext, outboundTraceparent, TRACE_HEADER } from "./trace";
import { SLOS, type SloId } from "./slo";

/* ================================================================== */
/* RUNBOOKS                                                            */
/* ================================================================== */

export type RunbookKey =
  | "slo-availability"
  | "slo-latency"
  | "slo-mail"
  | "slo-jobs"
  | "tenant-error-rate"
  | "security-event-unrecorded"
  | "anomaly-detected"
  | "recorder-stalled"
  | "scheduler-overdue";

export type Runbook = {
  key: RunbookKey;
  title: string;
  /** 🔴 The 3am answer. Present tense, imperative, first action first. */
  whatToDoNow: string;
  /** When this stops being a "look at it" and becomes a "wake somebody". */
  escalateIf: string;
};

export const RUNBOOKS: Readonly<Record<RunbookKey, Runbook>> = {
  "slo-availability": {
    key: "slo-availability",
    title: "The authenticated app is failing requests",
    whatToDoNow:
      "Open /platform/reliability and read the PER-TENANT table before the total. One " +
      "workspace at 40% among two hundred healthy ones is a data problem in that workspace; " +
      "a flat rise across all of them is the platform. Then group error_events by fingerprint " +
      "over the same window — the top fingerprint is usually the whole incident. If the top " +
      "fingerprint appeared with the last deploy, roll back before diagnosing.",
    escalateIf:
      "The burn rate is above 14.4x for a full hour, or any single tenant is above 25% for " +
      "fifteen minutes. Below that it can wait for the morning.",
  },
  "slo-latency": {
    key: "slo-latency",
    title: "A hot route has slowed down",
    whatToDoNow:
      "Identify WHICH route from the alert, then find the statement: the trace id is in the " +
      "sqlcommenter comment on the SQL the request issued, so the query can be found by trace " +
      "id rather than guessed. If every route moved at once it is the database and not the " +
      "code — check whether Neon's compute suspended and resumed, which shows as a uniform " +
      "multi-second step across unrelated routes.",
    escalateIf:
      "p95 is above 5 seconds on any route for more than fifteen minutes. Users have already " +
      "given up by then and the reports will start arriving.",
  },
  "slo-mail": {
    key: "slo-mail",
    title: "Mail we accepted is not being delivered",
    whatToDoNow:
      "Check the provider's own status page first — a Resend outage is not a code defect and " +
      "the queue drains on its own. If the provider is healthy, read failure_reason: a " +
      "concentration on one recipient domain is a reputation problem; a spread across every " +
      "domain is an API key or a quota. Pause campaigns before touching transactional mail.",
    escalateIf:
      "Invoices or password resets are among the failures. A newsletter that is late costs " +
      "nothing; an invoice that never arrives costs a customer money.",
  },
  "slo-jobs": {
    key: "slo-jobs",
    title: "Scheduled work is not completing within its cadence",
    whatToDoNow:
      "Ask whether the job RAN before asking why it failed. Six of these functions spent a " +
      "year being correct and uncalled, so 'no rows at all' is the historically likely answer " +
      "and it means the scheduler, not the job. If it ran and overran, check whether it loops " +
      "every workspace — a per-tenant sweep grows with the customer count and eventually " +
      "cannot finish inside any cadence.",
    escalateIf:
      "The dunning sweep or the storage reconciliation has missed twice. Both move money or " +
      "quota, and both are silent when they do not run.",
  },
  "tenant-error-rate": {
    key: "tenant-error-rate",
    title: "One workspace is failing far more than the rest",
    whatToDoNow:
      "This is the alert the global average cannot produce, so trust it over the dashboard. " +
      "Read that tenant's error_events by fingerprint. A single fingerprint means their data " +
      "hits a code path nobody else does — usually a null in a column the code assumes; that " +
      "is fixable today. Many fingerprints from one workspace usually means an integration of " +
      "theirs is retrying a bad request in a loop.",
    escalateIf:
      "The workspace is on a paid plan and the rate has held for an hour. Call them before " +
      "they call you; they have almost certainly not noticed yet, and being told is the " +
      "difference between a good story and a bad one.",
  },
  "security-event-unrecorded": {
    key: "security-event-unrecorded",
    title: "A CRITICAL security event could not be written down",
    whatToDoNow:
      "Treat the gap as the finding. `security_events` is append-only and this alert means a " +
      "critical row FAILED to land — the failure mode server/security/record.ts names is 'the " +
      "database is unreachable during an intrusion, so nothing is recorded and nothing is " +
      "alerted either'. Check database reachability first, then look for what was happening " +
      "in the same minute in audit_logs, which is a different table and may have survived.",
    escalateIf:
      "Always. This is the only alert in this file with no quiet version — a critical security " +
      "event with no record is exactly the state an attacker wants the system in.",
  },
  "anomaly-detected": {
    key: "anomaly-detected",
    title: "The anomaly sweep found something",
    whatToDoNow:
      "Read the ruleId in the alert and go to that rule's thresholds in " +
      "server/security/anomalies.ts — every one of them is a count over a window, and the " +
      "window matters as much as the count. A failed-login burst against one email is a " +
      "targeted attempt; the same count spread across many emails is credential stuffing and " +
      "needs a different answer.",
    escalateIf:
      "The rule is auth.failed_login_burst or tenant.cross_access_attempt. The first is " +
      "somebody trying; the second is somebody who may already be inside.",
  },
  "scheduler-overdue": {
    key: "scheduler-overdue",
    title: "A scheduled job is outside its cadence window",
    whatToDoNow:
      "Read scheduler_overdue() itself — it names the jobs, and this alert deliberately " +
      "does not repeat the list because a stale copy in a chat message is worse than one " +
      "query. Then decide which of three things it is: the scheduler is not running at all " +
      "(check scheduler_heartbeat and scheduler_watchdog_status() — one alert, every job " +
      "overdue), one job is failing (its rows in scheduler_runs will show attempts), or a " +
      "workspace is deliberately paused (scheduler_tenant_pauses, and " +
      "scheduler_pause_reason() says who and why). A paused workspace is a decision " +
      "somebody made, not an incident.",
    escalateIf:
      "The dunning sweep or the storage reconciliation is among them, or every job is " +
      "overdue at once. The first two move money and quota; the third is the scheduler.",
  },
  /*
   * ⚠️ 🔴 THERE WAS A `scheduler-silent` RUNBOOK HERE AND IT WAS DELETED.
   *
   * It answered "the scheduler has not checked in", which is the alert that
   * makes every other scheduler alert trustworthy: if nothing is running,
   * no job is "late" and every per-job view looks calm.
   *
   * ⭐ NOTHING COULD RAISE IT. Deciding the scheduler is silent needs the
   * RETURN CONTRACT of Track A's `scheduler_watchdog_status()`, or the
   * column names of `scheduler_heartbeat` — neither of which Track B has,
   * and guessing at them is the exact thing the job probe was rewritten to
   * stop doing. `check:observability-callers` reported it on the first run
   * of the new fourth check:
   *
   *   ✗ the runbook `scheduler-silent` is declared and nothing raises an
   *     alert with it.
   *
   * A paragraph telling the on-call what to do about an alert that cannot
   * fire reads as coverage. Deleted rather than left, and recorded in
   * TRACK-REPORT.md §4 as the one alert this track knows it is missing.
   */
  "recorder-stalled": {
    key: "recorder-stalled",
    title: "The observability recorder has stopped writing",
    whatToDoNow:
      "🔴 EVERY OTHER NUMBER ON THE STATUS SURFACE IS NOW MEANINGLESS AND WILL LOOK HEALTHY. " +
      "An availability ratio over an empty denominator is what this whole track exists to " +
      "prevent, and this alert is the tripwire for it. Check whether TELEMETRY_DISABLED was " +
      "set, then whether request_outcomes still exists, then whether the writes are being " +
      "refused by row-level security — a mis-scoped write is refused silently by design.",
    escalateIf:
      "It has been quiet for more than fifteen minutes during working hours in India. " +
      "Overnight quiet is normal; quiet at 11am is not.",
  },
} as const;

/** Which runbook an SLO's burn alert uses. Total by construction. */
const RUNBOOK_FOR_SLO: Readonly<Record<SloId, RunbookKey>> = {
  "app.availability": "slo-availability",
  "route.latency_p95": "slo-latency",
  "mail.delivery": "slo-mail",
  "job.cadence": "slo-jobs",
};

export function runbookForSlo(id: SloId): Runbook {
  return RUNBOOKS[RUNBOOK_FOR_SLO[id]];
}

/* ================================================================== */
/* RAISING                                                             */
/* ================================================================== */

export type AlertSeverity = "info" | "notice" | "warning" | "critical";

export type RaiseAlertInput = {
  /** Stable, symbolic, and NOT interpolated with an id. It is a limiter key. */
  alertKey: string;
  runbook: RunbookKey;
  severity: AlertSeverity;
  /** One line, no customer data. Shown in the channel and stored. */
  title: string;
  tenantId?: string | null;
  /** Numbers and short symbolic strings only. Never a record. */
  detail?: Record<string, string | number | boolean | null>;
  /** How long one raise silences the rest. Default 30 minutes. */
  windowMinutes?: number;
};

export type RaiseResult =
  | { raised: true; delivered: boolean; reason?: string }
  | { raised: false; reason: "suppressed" | "unavailable" | "failed" };

const DEFAULT_WINDOW_MINUTES = 30;

/**
 * 🔴 THE HARD CEILING, AND IT IS SEPARATE FROM THE PER-KEY WINDOW.
 *
 * The per-key window stops one alert repeating. It does nothing about
 * fifty DIFFERENT alerts firing in the same minute, which is precisely
 * what a real incident produces — and a channel with fifty messages in it
 * is a channel nobody reads, at the moment it matters most.
 *
 * So no more than this many messages leave in any ten-minute window,
 * counted in the database across every instance. Suppressed raises are
 * still RECORDED — the row is written, only the delivery is skipped — so
 * the status surface shows what the channel did not.
 */
const GLOBAL_DELIVERIES_PER_10_MIN = 12;

/**
 * Raise an alert. Records it, rate-limits it, and delivers it if this is
 * the first raise in its window.
 *
 * Never throws. An alerting system that can take the process down is a
 * worse outage than the one it was reporting.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<RaiseResult> {
  const runbook = RUNBOOKS[input.runbook];
  if (!runbook) {
    // Unreachable through TypeScript; reachable through a cast during an
    // incident, which is exactly when it would happen.
    log("error", "alert.no_runbook", logContext("failed"), {
      component: "alerts",
      reason: `alert ${input.alertKey} named a runbook that does not exist`,
    });
    return { raised: false, reason: "failed" };
  }

  const windowMinutes = clampWindow(input.windowMinutes);
  const title = boundedTitle(input.title);

  try {
    const { withPlatformScope, withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    /**
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ THE CEILING IS COUNTED FIRST, IN ITS OWN PLATFORM-SCOPED READ,
     *    AND THE ORDER IS A COMPROMISE THAT IS WORTH NAMING
     * ══════════════════════════════════════════════════════════════════
     * The first version claimed the window and counted the ceiling in ONE
     * transaction, so two instances racing could not both decide they were
     * under the cap. That is no longer possible: the window claim for a
     * tenant-attributed alert must happen inside `withTenant()` (SQL 0135's
     * policy refuses a platform-scoped write of a tenant row, proven in
     * TRACK-REPORT.md §3), and a tenant-scoped read of the ceiling would
     * see only that tenant's rows — i.e. no ceiling at all.
     *
     * So the ceiling is read platform-scoped, first, and the claim happens
     * after. The residual race is that N instances all read 11 and all
     * deliver, so the ten-minute cap can overshoot by roughly the instance
     * count. Bounded, harmless, and far better than the alternative, which
     * was a ceiling that silently did not apply to per-tenant alerts —
     * exactly the alerts that arrive in bursts.
     */
    const underCeiling = await withPlatformScope(
      "observability: count recent alert deliveries across every instance before sending another",
      async (tx) => {
        const recent = await tx.execute(sql`
          SELECT count(*)::int AS n
            FROM observability_alerts
           WHERE delivered_at > now() - interval '10 minutes'
        `);
        return (firstRow<{ n: number }>(recent)?.n ?? 0) < GLOBAL_DELIVERIES_PER_10_MIN;
      },
    );

    /**
     * ⚠️ `to_timestamp(floor(epoch / N) * N)` RATHER THAN
     * `date_trunc('minute')`. date_trunc gives a one-minute bucket and the
     * window is thirty; flooring the epoch to the window size is what makes
     * the unique key a THIRTY-minute limiter. It is still minute-aligned,
     * which the CHECK constraint requires.
     */
    const claim = sql`
      INSERT INTO observability_alerts (
        alert_key, runbook_key, tenant_id, severity, title, detail, window_start
      ) VALUES (
        ${input.alertKey},
        ${runbook.key},
        ${input.tenantId ?? null}::uuid,
        ${input.severity},
        ${title},
        ${JSON.stringify(sanitiseDetail(input.detail))}::jsonb,
        to_timestamp(floor(extract(epoch from now()) / ${windowMinutes * 60}) * ${windowMinutes * 60})
      )
      ON CONFLICT ON CONSTRAINT observability_alerts_window_unique DO UPDATE SET
        raise_count      = observability_alerts.raise_count + 1,
        suppressed_count = observability_alerts.suppressed_count + 1,
        last_raised_at   = now()
      RETURNING id, (xmax = 0) AS was_inserted
    `;

    const claimRow = input.tenantId
      ? await withTenant(input.tenantId, async (tx) =>
          firstRow<{ id: string; was_inserted: boolean }>(await tx.execute(claim)),
        )
      : await withPlatformScope(
          "observability: claim the rate-limit window for a platform-wide operator alert",
          async (tx) =>
            firstRow<{ id: string; was_inserted: boolean }>(await tx.execute(claim)),
        );

    const decision = claimRow
      ? { id: claimRow.id, deliver: claimRow.was_inserted && underCeiling }
      : null;

    if (!decision) return { raised: false, reason: "failed" };

    if (!decision.deliver) {
      log("notice", "alert.suppressed", logContext("throttled"), {
        component: "alerts",
        action: input.alertKey,
        runbook: runbook.key,
        tenantId: input.tenantId ?? null,
      });
      return { raised: true, delivered: false, reason: "rate-limited" };
    }

    /**
     * ⭐ THE ALERT IS LOGGED WHETHER OR NOT DISCORD IS CONFIGURED, AND THE
     * LOG LINE IS NOT A CONSOLATION PRIZE. Railway's log drain is always
     * on, has no vendor and no quota, and is the only thing that still
     * works when the alert destination is itself the outage —
     * `instrumentation.ts` makes the same argument about keeping
     * console.error beside Sentry.
     */
    log("warn", "alert.raised", logContext("failed"), {
      component: "alerts",
      action: input.alertKey,
      runbook: runbook.key,
      tenantId: input.tenantId ?? null,
      reason: title,
    });

    const delivery = await deliverToDiscord({
      severity: input.severity,
      title,
      runbook,
      alertKey: input.alertKey,
      tenantId: input.tenantId ?? null,
      detail: sanitiseDetail(input.detail),
    });

    await recordDelivery(decision.id, input.tenantId ?? null, delivery);

    return { raised: true, delivered: delivery.ok, reason: delivery.ok ? undefined : delivery.reason };
  } catch (error) {
    log("error", "alert.raise_failed", logContext("failed"), {
      component: "alerts",
      action: input.alertKey,
      errorName: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof Error ? error.message : String(error),
    });
    return { raised: false, reason: "unavailable" };
  }
}

/* ================================================================== */
/* DELIVERY                                                            */
/* ================================================================== */

type Delivery = { ok: true } | { ok: false; reason: string };

const SEVERITY_COLOUR: Record<AlertSeverity, number> = {
  info: 0x5865f2,
  notice: 0x57f287,
  warning: 0xfee75c,
  critical: 0xed4245,
};

async function deliverToDiscord(args: {
  severity: AlertSeverity;
  title: string;
  runbook: Runbook;
  alertKey: string;
  tenantId: string | null;
  detail: Record<string, string | number | boolean | null>;
}): Promise<Delivery> {
  const webhook = process.env.DISCORD_ALERT_WEBHOOK_URL;

  if (!webhook || webhook.length < 20) {
    /**
     * ⚠️ "NOT CONFIGURED" IS REPORTED AS A NON-DELIVERY, NOT AS A SUCCESS.
     * An alerting path that returns ok when it sent nothing is the
     * fail-open shape this wave keeps finding: the CSRF check that
     * accepted every origin when unconfigured, the mail sender that
     * returned true without reading the provider's answer.
     */
    return { ok: false, reason: "no destination configured" };
  }

  const body = {
    // ⚠️ `username` and `content` are attacker-adjacent surfaces: `title`
    // is built from our own vocabulary, but the ceiling on a mistake is
    // that a crafted string mass-pings a channel at 3am. `allowed_mentions`
    // with an empty parse list makes @everyone inert regardless.
    username: "Ordence",
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: `${args.severity.toUpperCase()} — ${args.title}`.slice(0, 250),
        description: args.runbook.whatToDoNow.slice(0, 1_500),
        color: SEVERITY_COLOUR[args.severity],
        fields: [
          { name: "Alert", value: codeSpan(args.alertKey), inline: true },
          { name: "Runbook", value: codeSpan(args.runbook.key), inline: true },
          // ⚠️ THE TENANT ID AND NOT THE TENANT NAME. A uuid identifies a
          // workspace to us and means nothing in a chat client's search
          // index, its notifications or somebody's phone lock screen.
          { name: "Workspace", value: codeSpan(args.tenantId ?? "platform-wide"), inline: true },
          { name: "Escalate if", value: args.runbook.escalateIf.slice(0, 900), inline: false },
          { name: "Detail", value: codeSpan(JSON.stringify(args.detail).slice(0, 900)), inline: false },
        ],
      },
    ],
  };

  try {
    /**
     * ⚠️ A TIMEOUT, BECAUSE A HANGING WEBHOOK MUST NOT HOLD A REQUEST OPEN.
     * Five seconds is generous for a chat webhook and short enough that a
     * dead destination costs one sweep rather than the sweep.
     */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let response: Response;
    try {
      /**
       * ⭐ THE TRACE FOLLOWS THE ALERT OUT OF THE PROCESS. A fresh span id
       * on the same trace, so "the sweep that raised this" and "the POST
       * that delivered it" are one object. `outboundTraceparent()` returns
       * null outside a context, and a null header is simply not sent
       * rather than being sent empty.
       */
      const traceparent = outboundTraceparent();
      response = await fetch(webhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(traceparent ? { [TRACE_HEADER]: traceparent } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      /*
       * 🔴 STATUS ONLY, AND THE BODY IS NOT READ AT ALL. A webhook error
       * body routinely echoes the URL that was called. Not reading it is
       * stronger than redacting it: there is nothing to get wrong.
       */
      return { ok: false, reason: `discord responded ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: redactDeliveryError(
        error instanceof Error ? error.message : String(error),
        webhook,
      ),
    };
  }
}

/**
 * ⚠️ THE SCOPE IS CHOSEN BY WHETHER THE ROW HAS A TENANT, and getting it
 * wrong is silent in the worst direction: an UPDATE refused by row-level
 * security raises, is caught below, and the alert simply never records
 * that it was delivered — so the ceiling read above under-counts and the
 * channel is flooded during the next incident. Proven refused in
 * TRACK-REPORT.md §3.
 */
async function recordDelivery(
  alertId: string,
  tenantId: string | null,
  delivery: Delivery,
): Promise<void> {
  try {
    const { withPlatformScope, withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    const statement = sql`
      UPDATE observability_alerts
         SET delivered_at   = CASE WHEN ${delivery.ok} THEN now() ELSE delivered_at END,
             delivery_error = ${delivery.ok ? null : delivery.reason}
       WHERE id = ${alertId}::uuid
    `;

    if (tenantId) {
      await withTenant(tenantId, async (tx) => {
        await tx.execute(statement);
      });
    } else {
      await withPlatformScope(
        "observability: record whether a platform-wide operator alert reached its destination",
        async (tx) => {
          await tx.execute(statement);
        },
      );
    }
  } catch {
    /* the alert already fired; failing to note the receipt must not undo it */
  }
}

/* ================================================================== */
/* SANITISERS                                                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE FUNCTION BETWEEN A CREDENTIAL AND A DATABASE COLUMN
 * ══════════════════════════════════════════════════════════════════════
 * `delivery_error` is written to `observability_alerts` and rendered on the
 * status surface. The string that reaches it is a provider or runtime error
 * message, and the one thing an HTTP client most reliably puts in an error
 * message is the URL it was calling — which here IS the credential: anybody
 * holding the Discord webhook URL can post into the operations channel as
 * Ordence, which is a very convincing place from which to tell an engineer
 * to do something at 3am.
 *
 * ⚠️ 🔴 PATTERN-MATCHING ALONE WAS NOT ENOUGH, AND THE HOLE IS THE
 *    INTERESTING PART.
 *
 * The first version stripped `https?://\S+` and stopped there. It is
 * correct for the case everybody pictures — a fetch failure quoting a
 * well-formed URL — and it misses the case that actually leaks:
 *
 *     DISCORD_ALERT_WEBHOOK_URL=<somebody pastes the token, no scheme>
 *     → TypeError: Failed to parse URL from 1234567890/AbCd…
 *
 * That message contains the whole configured value, has no scheme, and
 * matches no URL pattern. A misconfiguration — the single most likely thing
 * to go wrong with a new setting — would have written the credential into a
 * column and onto a screen.
 *
 * ⭐ SO THE CONFIGURED VALUE IS REMOVED BY EXACT SUBSTRING FIRST, and the
 * patterns run afterwards as a second line rather than the only one. An
 * exact match cannot be fooled by a shape nobody anticipated.
 *
 * ⚠️ AND THE SECRET IS NEVER USED AS A REGEX. Building one from it would
 * make a value containing `(` a syntax error thrown from inside the error
 * handler — the logger eating the bug, in the function written to stop the
 * logger leaking one. `split`/`join` is a literal replace and has no such
 * failure mode.
 *
 * ⚠️ A SHORT OR ABSENT SECRET IS NOT SUBSTITUTED, deliberately. Replacing
 * every occurrence of a two-character value would corrupt every message; and
 * a value that short is not a webhook URL anyway.
 */
export function redactDeliveryError(text: string, secret: string | undefined): string {
  let out = typeof text === "string" ? text : String(text ?? "");

  if (typeof secret === "string" && secret.length >= 12) {
    out = out.split(secret).join("[redacted-webhook]");
    /*
     * ⚠️ AND THE TAIL ON ITS OWN. Node sometimes reports only the part of a
     * URL after the origin, so the path — which is where the webhook id and
     * token live — can appear without the prefix that was just removed.
     */
    const slash = secret.indexOf("/", secret.indexOf("//") + 2);
    if (slash > 0) {
      const tail = secret.slice(slash);
      if (tail.length >= 12) out = out.split(tail).join("[redacted-webhook]");
    }
  }

  return out
    // Any remaining URL, whatever host.
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    // A schemeless Discord webhook path, which no URL pattern catches.
    .replace(/\b(?:[a-z0-9-]+\.)*discord(?:app)?\.com\/api\/webhooks\/\S*/gi, "[redacted-url]")
    // A bare `<digits>/<long token>` — the shape of a webhook with the origin
    // already stripped by something upstream.
    .replace(/\b\d{6,}\/[A-Za-z0-9_-]{20,}/g, "[redacted-webhook]")
    .slice(0, 300);
}

/** Discord renders a code span literally, so markdown in a value is inert. */
function codeSpan(value: string): string {
  return "`" + value.replace(/`/g, "'").slice(0, 200) + "`";
}

function boundedTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "(untitled alert)";
}

/**
 * Detail is numbers and short symbolic strings. Anything else is dropped.
 *
 * ⚠️ THE SAME POSITIVE-SHAPE ARGUMENT AS `lib/telemetry/log.ts`: this
 * object is serialised into a chat channel and into a jsonb column, and
 * the field somebody adds next month will be added during an incident.
 */
function sanitiseDetail(
  detail: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!detail) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(detail)) {
    if (kept >= 12) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (value === null || typeof value === "boolean") {
      out[key] = value;
      kept++;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
      kept++;
    } else if (typeof value === "string") {
      // Short and symbolic. A sentence here is a place a record's contents
      // can hide, and this string is going into a chat channel.
      if (!/^[A-Za-z0-9_.:@ /-]{1,80}$/.test(value)) continue;
      out[key] = value;
      kept++;
    }
  }
  return out;
}

function clampWindow(minutes: number | undefined): number {
  if (!Number.isFinite(minutes) || (minutes as number) < 1) return DEFAULT_WINDOW_MINUTES;
  return Math.min(Math.round(minutes as number), 24 * 60);
}

function firstRow<T>(result: unknown): T | null {
  const rows =
    (result as { rows?: T[] })?.rows ?? (Array.isArray(result) ? (result as T[]) : []);
  return rows[0] ?? null;
}

/* ================================================================== */
/* THE FOUR SLO BURN ALERTS                                            */
/* ================================================================== */

/**
 * Raise the burn alert for an SLO, if the burn justifies one.
 *
 * ⚠️ RETURNS `null` WHEN NOTHING SHOULD FIRE, AND THAT IS THE COMMON CASE
 * BY DESIGN. `burnAlertFor()` in slo.ts decides; this function only
 * carries the decision to a channel.
 */
export async function raiseBurnAlert(args: {
  sloId: SloId;
  windowHours: number;
  failureFraction: number;
  burnRate: number;
  windowLabel: string;
  tenantId?: string | null;
}): Promise<RaiseResult | null> {
  const slo = SLOS.find((s) => s.id === args.sloId);
  if (!slo) return null;

  return raiseAlert({
    alertKey: `slo.burn:${args.sloId}:${args.windowLabel}`,
    runbook: RUNBOOK_FOR_SLO[args.sloId],
    severity: args.burnRate >= 14.4 ? "critical" : "warning",
    title: `${slo.title} — burning error budget at ${args.burnRate.toFixed(1)}x`,
    tenantId: args.tenantId ?? null,
    detail: {
      slo: args.sloId,
      burnRate: Number(args.burnRate.toFixed(2)),
      failurePercent: Number((args.failureFraction * 100).toFixed(3)),
      windowHours: args.windowHours,
      target: slo.target,
    },
    // A fast burn is allowed to repeat sooner than a slow one: an hour of
    // silence during a 14.4x burn is 2% of the month gone unremarked.
    windowMinutes: args.windowHours <= 1 ? 15 : 60,
  });
}
