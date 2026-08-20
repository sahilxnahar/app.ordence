#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE CLOCK
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ══════════════════════════════════════════════════════════════════════
 * The start command of a SECOND Railway service, on a five-minute cron
 * schedule (`railway.cron.json`). It runs, it exits, and its exit code is
 * what Railway shows as a green or red run.
 *
 * It is deliberately the stupidest component in this design. It does not
 * know what the jobs are, when they run, or what they do. It asks the
 * application, and the application answers from
 * `server/scheduler/catalog.ts`. That is what keeps every cadence in this
 * repository instead of in a web console, and it is why adding a job
 * schedules it by the commit that adds it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE CRON IS NOT ON THE WEB SERVICE
 * ══════════════════════════════════════════════════════════════════════
 * Two independent reasons, either of which is sufficient:
 *
 *   1. Railway's cron feature RESTARTS A SERVICE on a schedule. Attaching
 *      it to a web service that never exits means restarting the website
 *      every five minutes.
 *   2. A scaled web tier runs N replicas. A scheduler inside the web
 *      service fires every job once per replica — so scaling to two
 *      instances would send every customer two dunning letters, at two
 *      serial numbers. In India a demand notice is served under statute
 *      and two of them for one debt is a legal problem, not a cosmetic
 *      one. The ledger claim in 0129 would catch it; a design that relies
 *      on the last line of defence catching it every night is not a
 *      design.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ PLAIN `.mjs`, NO BUILD STEP, AND NO NEW DEPENDENCY
 * ══════════════════════════════════════════════════════════════════════
 * `package.json` is shared and owned by nobody this wave, so no npm
 * script can be added and the Railway start command runs `node` against
 * this file directly. It therefore uses only `fetch` (Node 20+) and
 * `@neondatabase/serverless`, which is already a dependency of this
 * project and is what `db/index.ts` connects with.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EXIT CODES
 * ══════════════════════════════════════════════════════════════════════
 *   0  everything the scheduler was asked to do, it did
 *   1  the tick reported a failure, or a maintenance job failed
 *   2  configuration is missing or wrong
 *   3  the application could not be reached
 *
 * 🔴 NON-ZERO ON A PARTIAL FAILURE, ALWAYS. A run in which one workspace
 * failed, or in which the workspace bound was hit, is a run somebody must
 * look at. Exiting 0 on a 500 is the mistake `docs/current/CRON-RUNBOOK.md`
 * warns about in its own curl examples: "`-f` is not optional. Without it
 * curl exits 0 on an HTTP 500, so a run in which every workspace failed
 * reports green to whatever is watching."
 */

import { runMaintenanceHandoffs } from "./maintenance.mjs";

/* ══════════════════════════════════════════════════════════════════════
 * ⚠️ FIVE ENVIRONMENT NAMES BECAME TWO, AND BOTH OF THOSE ARE OPTIONAL
 * ══════════════════════════════════════════════════════════════════════
 * The first delivery read `APP_URL`, `SCHEDULER_APP_URL`,
 * `SCHEDULER_SOURCE`, `SCHEDULER_TIMEOUT_MS` and
 * `MAINTENANCE_DATABASE_URL`, none of which existed in
 * `lib/platform/env-catalog.ts`, so `check:env-catalogue` refused the
 * delivery. That gate is right: a setting the code reads and the
 * catalogue omits is invisible to `/api/diag`, so an operator cannot be
 * told it is missing.
 *
 * The correct response was not to catalogue five names, it was to need
 * fewer:
 *
 *   APP_URL              → deleted. `NEXT_PUBLIC_APP_URL` already exists,
 *                          is already catalogued, and is already set —
 *                          Railway shares project variables with every
 *                          service, so the cron service can read it.
 *   SCHEDULER_TIMEOUT_MS → deleted, hardcoded below. A knob nobody will
 *                          ever turn is a catalogue entry nobody will
 *                          ever read.
 *   SCHEDULER_SOURCE     → deleted. It named the clock, and there is
 *                          exactly one clock; if a second appears, the
 *                          `triggered_by` column on every ledger row
 *                          already distinguishes them.
 *
 * 🔴 AND THE SECRET IS `WORKER_API_SECRET`, WHICH IS ALREADY SET ON THE
 * LIVE SERVICE. Somebody prepared for scheduled work and nothing ever
 * called it. Introducing a second name would mean two secrets for one
 * job, which is how a scheduler authenticates against the wrong one at
 * 3am. `CRON_SECRET` — also already set — is deliberately NOT read here:
 * it belongs to `/api/cron/canary`, whose response names real workspace
 * ids and should not be reachable with the token a cron runner holds for
 * everything else. The canary now runs as the `rls_canary` job INSIDE
 * the application, so this process never needs it.
 * ══════════════════════════════════════════════════════════════════════ */

const APP_URL = (
  process.env.SCHEDULER_APP_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  ""
).replace(/\/+$/, "");
const WORKER_SECRET = process.env.WORKER_API_SECRET ?? "";
const MAINTENANCE_URL = process.env.MAINTENANCE_DATABASE_URL ?? "";

/** Named after the service, because there is one clock. */
const SOURCE = "railway-cron";

/**
 * Just under Railway's own five-minute cron interval, so a hung request
 * cannot outlive the tick that issued it and overlap its successor.
 */
const TIMEOUT_MS = 280_000;

function fail(code, message, detail) {
  console.error(`[scheduler] ${message}`);
  if (detail !== undefined) console.error(detail);
  process.exit(code);
}

function log(message) {
  console.log(`[scheduler] ${message}`);
}

/* ------------------------------------------------------------------ */
/* CONFIGURATION                                                       */
/* ------------------------------------------------------------------ */

if (!APP_URL) {
  fail(
    2,
    "Neither SCHEDULER_APP_URL nor NEXT_PUBLIC_APP_URL is set on this service. One of " +
      "them must point at the web service, e.g. https://app.ordence.com — inside Railway " +
      "you can use the private networking address. Nothing has been scheduled.",
  );
}

if (!WORKER_SECRET) {
  /**
   * ⚠️ REFUSE RATHER THAN TRY. `/api/workers` answers 503 with no
   * authentication configured, and a cron service that discovered that by
   * being refused would look identical to one whose secret was wrong.
   * Generate it with `openssl rand -hex 32` and paste it into Railway.
   */
  fail(
    2,
    "WORKER_API_SECRET is not set on the cron service. /api/workers would refuse every " +
      "call. Generate one with `openssl rand -hex 32` and set the SAME value on both the " +
      "web service and this one.",
  );
}

const canRunMaintenance = MAINTENANCE_URL.length > 0;

if (!canRunMaintenance) {
  /**
   * ⭐ THIS IS A WARNING AND NOT A FAILURE, AND THE JOBS STILL SHOW AS
   * OVERDUE. The four retention jobs — prune_scheduler_runs,
   * prune_change_log, prune_security_events, prune_usage_counters — are
   * declared in the catalog whether or not this connection exists, so
   * `scheduler_overdue()` reports them and
   * `GET /api/workers?watchdog=1` goes red. "Retention is not configured"
   * is visible, which is the whole difference between this and the years
   * in which it was not.
   */
  log(
    "MAINTENANCE_DATABASE_URL is not set, so the maintenance lane will not run. " +
      "prune_change_log, prune_security_events, prune_usage_counters and " +
      "prune_scheduler_runs stay dormant and WILL be reported overdue by the watchdog. " +
      "See SQL-FILES/0132 Section 6 and docs/SCHEDULER.md.",
  );
}

/* ------------------------------------------------------------------ */
/* 1. THE TICK                                                         */
/* ------------------------------------------------------------------ */

async function postTick() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${APP_URL}/api/workers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "tick", source: SOURCE, maintenance: canRunMaintenance }),
      signal: controller.signal,
    });
  } catch (err) {
    fail(
      3,
      `Could not reach ${APP_URL}/api/workers. Nothing was scheduled this cycle.`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 2000) };
  }

  /**
   * 🔴 THE STATUS CODE DECIDES, NOT THE BODY. A 500 carrying
   * `{"ok": false}` and a 500 carrying an HTML error page must both be
   * red, and only the status code is present in both.
   */
  if (!response.ok) {
    console.error(`[scheduler] tick returned HTTP ${response.status}`);
    console.error(JSON.stringify(body, null, 2).slice(0, 4000));
    // Still hand back the body: it may carry maintenance work that was
    // claimed before whatever failed, and an unexecuted claim is worse
    // than a failed one.
    return { ok: false, body };
  }

  log(
    `tick ok — ${body.unitsRun ?? 0} run, ${body.unitsSkipped ?? 0} skipped, ` +
      `${body.unitsFailed ?? 0} failed, ${body.staleReclaimed ?? 0} stale reclaimed, ` +
      `${(body.maintenance ?? []).length} maintenance slot(s) claimed`,
  );

  return { ok: body.ok !== false, body };
}

/* ------------------------------------------------------------------ */
/* MAIN                                                                */
/* ------------------------------------------------------------------ */

const tick = await postTick();
if (!tick) process.exit(3);

const handoffs = Array.isArray(tick.body?.maintenance) ? tick.body.maintenance : [];

let maintenanceOk = true;
if (canRunMaintenance) {
  try {
    /**
     * ⚠️ THE CLIENT IS BUILT HERE AND THE LOGIC LIVES IN maintenance.mjs
     * WITH THE CLIENT AS A PARAMETER. This track cannot add a file under
     * `tests/`, so a module that could only be exercised by connecting to
     * Neon could not be exercised at all;
     * `server/scheduler/self-check.mjs` runs it against a fake client.
     */
    const { neon } = await import("@neondatabase/serverless");
    const client = neon(MAINTENANCE_URL);
    const outcome = await runMaintenanceHandoffs({
      client,
      handoffs,
      log,
      error: (m) => console.error(`[scheduler] ${m}`),
    });
    maintenanceOk = outcome.ok;
  } catch (err) {
    maintenanceOk = false;
    console.error(
      `[scheduler] the maintenance lane could not connect: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
} else if (handoffs.length > 0) {
  /**
   * 🔴 THE APPLICATION CLAIMED WORK THIS PROCESS CANNOT DO. That should be
   * impossible — the claim is gated on the `maintenance: true` flag this
   * process sends — so it means the flag and the connection have got out
   * of step. Loud, and non-zero.
   */
  maintenanceOk = false;
  console.error(
    `[scheduler] the application handed back ${handoffs.length} maintenance slot(s) but ` +
      `MAINTENANCE_DATABASE_URL is not set. Those slots are claimed and will not run until ` +
      `the watchdog reclaims them.`,
  );
}

if (!tick.ok || !maintenanceOk) {
  fail(1, "this cycle did not fully succeed. See the output above.");
}

log("cycle complete");
process.exit(0);
