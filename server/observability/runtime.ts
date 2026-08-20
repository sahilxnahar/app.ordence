import "server-only";

/**
 * Ordence — Process-level observability install, and the evaluation sweep
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT `installObservability()` DOES AND, MORE IMPORTANTLY, DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It installs two process listeners and writes one boot line. It opens no
 * database connection, reads no secret and validates nothing.
 *
 * ⚠️ BOOT MUST NOT DEPEND ON THE DATABASE. `instrumentation.ts#register()`
 * runs before the first request is served; a database call here would
 * make a Neon cold start into a failed deploy, and the error would name
 * the observability layer rather than the database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `uncaughtExceptionMonitor`, NOT `uncaughtException`
 * ══════════════════════════════════════════════════════════════════════
 * This is the most consequential line in the file and it is one word.
 *
 * Registering an `uncaughtException` listener SUPPRESSES Node's default
 * behaviour: the process stops crashing and keeps serving from a state
 * nobody has reasoned about — a half-rolled-back transaction, a
 * connection pool with a broken client in it, module state mid-mutation.
 * That is strictly worse than a restart, and it would have been
 * introduced here by an observability change, which is the worst possible
 * provenance for it.
 *
 * `uncaughtExceptionMonitor` fires for the same events and changes
 * nothing: the process still crashes exactly as it would have. We get the
 * fact; Railway gets the restart.
 *
 * ⚠️ `unhandledRejection` IS OBSERVED AND ALSO NOT SUPPRESSED. Node's
 * default since v15 is to crash, and adding a listener DOES suppress it —
 * so this handler deliberately re-raises by rethrowing on the next tick,
 * preserving the crash while keeping the report.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE DELIBERATELY DOES **NOT** INSTALL, AND WHY
 * ══════════════════════════════════════════════════════════════════════
 * It does NOT call `onSecurityRecordFailure()`.
 *
 * That hook is a MODULE-LEVEL SINGLE LISTENER in
 * `server/security/record.ts` — registering a second one REPLACES the
 * first. `server/security/alerting.ts#installSecurityAlerting()` already
 * holds it, and that listener is the only thing that reports a CRITICAL
 * security event which failed to persist.
 *
 * Wiring Discord alerts by calling `onSecurityRecordFailure()` here would
 * have silently switched off an existing security control, in the file
 * that exists to improve alerting, and every test of it would still pass
 * because the hook would still have exactly one listener. Chaining it
 * properly is a two-line change inside `server/security/alerting.ts`,
 * which Track B does not own — the code is in PATCH-REQUEST-B.md.
 */

import { log, detachedContext } from "@/lib/telemetry/log";
import { newTraceId } from "@/lib/telemetry/trace";
import { raiseAlert, raiseBurnAlert } from "./alerts";
import { observe, observeJob } from "./observe";
import { getHealthSnapshot, RECORDER_STALL_MINUTES } from "./health";
import { burnAlertFor } from "./slo";

/* ================================================================== */
/* INSTALL                                                             */
/* ================================================================== */

let installed = false;

export function installObservability(): void {
  if (installed) return;
  installed = true;

  const boot = detachedContext({ outcome: "ok" });

  try {
    process.on("uncaughtExceptionMonitor", (error: unknown, origin: unknown) => {
      // ⚠️ Synchronous and cheap. The process is about to die; an await
      // here would not complete, and a database write certainly would not.
      log("error", "process.uncaught_exception", detachedContext({ outcome: "failed" }), {
        component: "runtime",
        errorName: error instanceof Error ? error.name : "UnknownError",
        reason: error instanceof Error ? error.message : String(error),
        action: typeof origin === "string" ? origin : "uncaught",
      });
    });

    process.on("unhandledRejection", (reason: unknown) => {
      log("error", "process.unhandled_rejection", detachedContext({ outcome: "failed" }), {
        component: "runtime",
        errorName: reason instanceof Error ? reason.name : "UnknownError",
        reason: reason instanceof Error ? reason.message : String(reason),
      });

      /**
       * 🔴 RE-RAISE. Attaching this listener suppressed Node's default,
       * which since v15 is to terminate. Keeping the process alive after an
       * unhandled rejection is how a pool of half-broken connections serves
       * traffic for hours; the report is worth having, the suppression is
       * not, and `setImmediate` gets it out of the listener so Node treats
       * it as a genuine uncaught exception.
       */
      setImmediate(() => {
        throw reason instanceof Error ? reason : new Error(String(reason));
      });
    });

    /**
     * ⭐ ONE BOOT LINE, AND IT IS NOT DECORATION. It carries a trace id, so
     * "which boot was this" is answerable, and its presence in the log
     * drain is the only evidence that `register()` reached this file at
     * all — which is precisely the class of question this wave exists to
     * make answerable.
     */
    log("notice", "observability.installed", { ...boot, traceId: newTraceId() }, {
      component: "runtime",
      // Deliberately no environment names, no hostnames, no versions read
      // from anywhere that could carry a secret.
      action: "install",
    });
  } catch (error) {
    installed = false;
    log("error", "observability.install_failed", detachedContext({ outcome: "failed" }), {
      component: "runtime",
      errorName: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Test seam. Never called by application code. */
export function __resetObservabilityInstallForTests(): void {
  installed = false;
}

/* ================================================================== */
/* THE SWEEP                                                           */
/* ================================================================== */

export type SweepResult = {
  evaluated: number;
  raised: number;
  suppressed: number;
  notes: string[];
};

/**
 * Evaluate the objectives and raise whatever the burn justifies.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT RUNS ON READ, FROM THE STATUS SURFACE, AND THAT IS A CHOICE
 * ══════════════════════════════════════════════════════════════════════
 * `app/platform/health/page.tsx` already states the reasoning for the
 * account-health sweep and it applies unchanged here: "A cron would be
 * tidier and would also leave this screen silently empty on the morning
 * the scheduler is the thing that broke."
 *
 * There is a second reason specific to this wave: until Track A's
 * scheduler lands, a sweep that only a cron could call would be a
 * function with no callers — which is the defect this whole track was
 * commissioned to fix, committed inside the fix.
 *
 * ⭐ IT IS STILL SAFE TO CALL FROM A CRON, and should be once one exists:
 * the per-key window in `observability_alerts` means two callers a second
 * apart produce one message, not two. The patch request wires it into
 * `server/scheduling/registry.ts`.
 *
 * ⚠️ NEVER THROWS. It is called during a page render; an exception here
 * would take down the one screen an operator opens when things are
 * already wrong.
 */
export async function sweepObservability(): Promise<SweepResult> {
  const result: SweepResult = { evaluated: 0, raised: 0, suppressed: 0, notes: [] };

  try {
    /**
     * ⭐ THE SWEEP OBSERVES ITSELF. `observeJob` enters a trace context
     * with `kind: "job"`, so the sweep's own duration and outcome land in
     * `request_outcomes` under `/jobs/observability.sweep` — separate from
     * the HTTP availability denominator, which is the whole reason `kind`
     * exists.
     *
     * ⚠️ AND IT IS NOT VANITY. A sweep that has stopped running is
     * indistinguishable from a quiet system, which is the failure this
     * track exists to remove; the sweep's own job row is the only evidence
     * that the evaluator ran at all.
     */
    return await observeJob({ jobId: "observability.sweep" }, () => runSweep(result));
  } catch (error) {
    log("error", "observability.sweep_failed", detachedContext({ outcome: "failed" }), {
      component: "runtime",
      errorName: error instanceof Error ? error.name : "UnknownError",
      reason: error instanceof Error ? error.message : String(error),
    });
    result.notes.push("The evaluation sweep failed; no alert can be inferred from its silence.");
    return result;
  }
}

async function runSweep(result: SweepResult): Promise<SweepResult> {
  const snapshot = await getHealthSnapshot({ windowDays: 30 });

    /**
     * 🔴 THE STALL ALERT COMES FIRST, because if it fires every other
     * number in the snapshot is computed over a window the recorder did
     * not observe — and they will all look healthy.
     */
    if (snapshot.recorderStalled) {
      const outcome = await raiseAlert({
        alertKey: "observability.recorder_stalled",
        runbook: "recorder-stalled",
        severity: "critical",
        title: `The request recorder has written nothing for over ${RECORDER_STALL_MINUTES} minutes`,
        detail: {
          lastWriteAt: snapshot.recorderLastWriteAt?.toISOString() ?? "never",
          stallMinutes: RECORDER_STALL_MINUTES,
        },
        windowMinutes: 60,
      });
      tally(result, outcome);
    }

    for (const entry of snapshot.slos) {
      result.evaluated++;

      if (entry.evaluation.state === "unmeasured") {
        /**
         * ⚠️ AN UNMEASURED OBJECTIVE DOES NOT RAISE AN ALERT, AND IT DOES
         * NOT PASS EITHER. It becomes a note on the surface. Alerting on
         * "not enough data" would page somebody every night of a quiet
         * week; treating it as healthy is the defect this track exists to
         * remove. A note is the honest third option.
         */
        result.notes.push(`${entry.evaluation.slo.id}: unmeasured — ${entry.evaluation.why}`);
        continue;
      }

      const fast = entry.fastBurn;
      if (!fast) continue;

      const window = burnAlertFor(entry.evaluation.slo.id, fast.windowHours, fast.failureFraction);
      if (!window) continue;

      const outcome = await raiseBurnAlert({
        sloId: entry.evaluation.slo.id,
        windowHours: fast.windowHours,
        failureFraction: fast.failureFraction,
        burnRate: fast.burnRate,
        windowLabel: window.id,
      });
      tally(result, outcome);
    }

    /**
     * ⭐ THE ANOMALY SWEEP'S FINDINGS, WHICH HAD A RUNBOOK AND NO EMITTER.
     *
     * `server/security/anomalies.ts` has raised `anomaly.detected` and its
     * four siblings into `security_events` since Phase 20 — and until Track
     * D's fix those writes were refused for every tenant-attributed row, so
     * the rows are new as well as the alert.
     *
     * ⚠️ ONE ALERT FOR THE WHOLE SWEEP, NOT ONE PER FINDING. A detector that
     * fires on a burst produces a burst of findings by construction, and an
     * alert per finding is the flood the durable limiter would then have to
     * absorb. The count goes in the detail; the names are in the table the
     * runbook sends you to.
     */
    const anomalies = snapshot.recentSecurity.filter(
      (e) =>
        e.eventType.startsWith("anomaly.") ||
        e.eventType === "auth.brute_force_suspected" ||
        e.eventType === "authz.denial_spike" ||
        e.eventType === "portal.token_shared_suspected" ||
        e.eventType === "export.off_hours" ||
        e.eventType === "tenant.cross_access_attempt",
    );

    if (anomalies.length > 0) {
      const total = anomalies.reduce((n, e) => n + e.n, 0);
      const worst = anomalies.some((e) => e.severity === "critical");
      const outcome = await raiseAlert({
        alertKey: "anomaly.detected",
        runbook: "anomaly-detected",
        severity: worst ? "critical" : "warning",
        title: `The anomaly sweep recorded ${total} finding(s) in the last hour`,
        detail: {
          findings: total,
          kinds: anomalies.length,
          worst: worst ? "critical" : "warning",
          // ⚠️ THE TOP TYPE ONLY. A list of every type is a chat message
          // nobody reads; the runbook names the query that gives all of them.
          topType: anomalies[0]?.eventType ?? "unknown",
        },
        windowMinutes: 30,
      });
      tally(result, outcome);
    }

    /**
     * ⭐ TRACK A'S SCHEDULER, OBSERVED RATHER THAN RE-DERIVED.
     *
     * ⚠️ THE OBSERVATION IS RECORDED FIRST AND THE ALERT SECOND, and the
     * order matters: the `job.cadence` objective is computed from these
     * rows, so a sweep that alerted without recording would raise an alarm
     * about a number it had just declined to write down.
     */
    if (snapshot.scheduler.callable && snapshot.overdueNow !== null) {
      await observe({
        event: "scheduler.cadence_check",
        tenantId: null,
        /**
         * ⚠️ A FIXED ROUTE PATTERN, not one per job. The objective is "was
         * anything overdue at this check", and interpolating job names here
         * would make the label set grow with the job registry — the exact
         * unbounded-cardinality problem `scrubUrl()` exists to prevent on
         * the HTTP side. The names live in `scheduler_overdue()`, which the
         * runbook sends you to read.
         */
        route: "/jobs/scheduler.cadence",
        outcome: snapshot.overdueNow > 0 ? "failed" : "ok",
        durationMs: 0,
        kind: "job",
        extras: { component: "scheduler", count: snapshot.overdueNow },
      });

      if (snapshot.overdueNow > 0) {
        const outcome = await raiseAlert({
          alertKey: "scheduler.overdue",
          runbook: "scheduler-overdue",
          severity: snapshot.overdueNow >= 3 ? "critical" : "warning",
          title: `${snapshot.overdueNow} scheduled job(s) are outside their cadence window`,
          detail: { overdue: snapshot.overdueNow },
          windowMinutes: 60,
        });
        tally(result, outcome);
      }
    } else if (!snapshot.scheduler.present) {
      /**
       * ⚠️ NO ALERT, A NOTE. A database that has not had Track A's
       * migrations applied is a real state — a fresh environment, a
       * partially-assembled tree — and paging somebody about it would train
       * them to ignore the channel. The objective already reports
       * unmeasured, which is the honest signal.
       */
      result.notes.push(
        `Track A's scheduler is absent: ${snapshot.scheduler.why} No cadence alert can be raised.`,
      );
    }

    /**
     * ⭐ THE PER-TENANT ALERT — the one a global average structurally
     * cannot produce, and the reason this track exists.
     */
    for (const tenant of snapshot.tenants) {
      // ⚠️ A FLOOR ON VOLUME. Two failures out of three is a 66% error
      // rate and is also three requests. Without this the noisiest alert
      // in the system would be about the quietest workspaces.
      if (tenant.requests < 200) continue;
      if (tenant.errorRate < 0.05) continue;

      const outcome = await raiseAlert({
        alertKey: "tenant.error_rate",
        runbook: "tenant-error-rate",
        severity: tenant.errorRate >= 0.25 ? "critical" : "warning",
        title: `One workspace is failing ${(tenant.errorRate * 100).toFixed(1)}% of its requests`,
        tenantId: tenant.tenantId,
        detail: {
          errorPercent: Number((tenant.errorRate * 100).toFixed(2)),
          requests: tenant.requests,
          failed: tenant.failed,
          p95Ms: tenant.p95Ms,
        },
        windowMinutes: 60,
      });
      tally(result, outcome);
    }

  result.notes.push(...snapshot.notes);
  return result;
}

function tally(
  result: SweepResult,
  outcome: Awaited<ReturnType<typeof raiseAlert>> | null,
): void {
  if (!outcome) return;
  if (outcome.raised && outcome.delivered) result.raised++;
  else if (outcome.raised) result.suppressed++;
}
