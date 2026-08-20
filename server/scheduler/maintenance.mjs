/**
 * Ordence — THE MAINTENANCE LANE
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE IS A SECOND LANE AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Four retention functions must run on a clock and the application role
 * must not be able to call any of them:
 *
 *   prune_security_events()  0012 refused it to `ordence_app` in a comment
 *                            inside its own grant block; 0087 granted it
 *                            back 75 files later by copying a signature
 *                            without reading the role; 0121 revoked it and
 *                            `scripts/sealed-grants.json` now fails the
 *                            build on any .sql file that grants it again.
 *   prune_usage_counters()   sealed the same way by 0121.
 *   prune_change_log()       withheld at creation by 0128, which says
 *                            outright: "⭐ AND WHEN THE SCHEDULER EXISTS,
 *                            this belongs beside prune_security_events()".
 *   prune_scheduler_runs()   created by 0132, withheld for the same reason
 *                            — an application that can delete its own
 *                            operational record has no operational record.
 *
 * `/api/workers` executes as the application role. Registering these there
 * has two possible outcomes: permission denied on every run, or a fourth
 * reversal of a control that has already been reversed once and repaired
 * once. So they run over a second connection as `ordence_maintenance`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ PLAIN `.mjs`, AND EVERY DEPENDENCY IS INJECTED
 * ══════════════════════════════════════════════════════════════════════
 * The cron service has no build step (see `cron-entrypoint.mjs`), so this
 * is plain ESM. The database client is a PARAMETER rather than an import,
 * which is what lets `server/scheduler/self-check.mjs` exercise the
 * refusal path, the finish-every-handoff path and the transaction shape
 * against a fake client — this track cannot add a file under `tests/`,
 * so a module that could only be tested by connecting to Neon could not
 * be tested at all.
 */

/**
 * 🔴 SQL ARRIVING OVER HTTP IS EXECUTED ONLY IF IT MATCHES THIS.
 *
 * The primary control is the grant list: `ordence_maintenance` holds
 * EXECUTE on four prune functions and SELECT/INSERT/UPDATE/DELETE on the
 * scheduler tables, and nothing else. This pattern is defence in depth
 * against the ordinary cases — a typo, a merge that mangles a string, a
 * future catalog entry written with a semicolon in it.
 *
 * One statement, `SELECT`, a `public.` function whose name begins with
 * `prune_`, no nested parentheses and no semicolon.
 */
export const ALLOWED_SQL = /^SELECT (?:\* FROM )?public\.prune_[a-z_]+\([^;()]*\)$/;

/**
 * ⚠️ TRANSACTION-LOCAL (`true`), AND IT MUST SHARE A TRANSACTION WITH THE
 * STATEMENT IT PROTECTS.
 *
 * Every scheduler table is FORCE ROW LEVEL SECURITY with a policy of
 * `app_platform_scope()`. Without the marker, the UPDATEs below match ZERO
 * rows and report success — which is exactly the failure 0128 records
 * finding in its own first draft, and which here would mean a ledger that
 * silently never records a maintenance run.
 *
 * 🔴 AND THE FIRST DRAFT OF THIS FILE GOT IT WRONG IN AN INSTRUCTIVE WAY.
 * It set the marker in the SELECT LIST of the same statement:
 *
 *     SELECT set_config('app.platform_scope','on',false) , x
 *       FROM (SELECT * FROM public.prune_change_log(180,false)) AS x
 *
 * Postgres evaluates the FROM clause before the select list, so the prune
 * would have run with NO platform marker — deleting nothing, per tenant,
 * and returning success. A neon() HTTP query is one statement per
 * session, so there is no way to set it "first" outside a transaction.
 * `transaction([...])` is the only correct shape here, and that is why
 * this function requires a client that has one.
 */
const SET_SCOPE = "SELECT set_config('app.platform_scope','on',true)";

/**
 * Execute the slots the application claimed and may not run itself.
 *
 * @param {object} args
 * @param {{ query: (sql: string, params?: unknown[]) => unknown,
 *           transaction: (queries: unknown[]) => Promise<unknown[]> }} args.client
 *        A neon() HTTP client, or anything with the same two calls.
 * @param {Array<{runId: string, jobId: string, sqlCall: string}>} args.handoffs
 * @param {(message: string) => void} [args.log]
 * @param {(message: string) => void} [args.error]
 * @param {() => number} [args.now]
 * @returns {Promise<{ok: boolean, results: Array<{jobId: string, state: string, error: string|null, tookMs: number}>}>}
 */
export async function runMaintenanceHandoffs(args) {
  const { client, handoffs } = args;
  const log = args.log ?? (() => {});
  const error = args.error ?? (() => {});
  const now = args.now ?? (() => Date.now());

  /** @type {Array<{jobId: string, state: string, error: string|null, tookMs: number}>} */
  const results = [];
  let ok = true;

  for (const work of handoffs) {
    const startedAt = now();

    /* ---- 1. Refuse anything that is not the shape we expect --------- */
    if (typeof work?.sqlCall !== "string" || !ALLOWED_SQL.test(work.sqlCall)) {
      ok = false;
      const message =
        `Refused to execute "${String(work?.sqlCall).slice(0, 200)}": it does not match the ` +
        `allowed shape (one SELECT of a public.prune_* function, no semicolon, no nested ` +
        `parentheses). See ALLOWED_SQL in server/scheduler/maintenance.mjs.`;
      error(message);
      /**
       * 🔴 THE REFUSAL IS STILL WRITTEN TO THE LEDGER. The slot is already
       * claimed by the application; abandoning it would leave a row in
       * `claimed` that the watchdog reclaims half an hour later, and in the
       * meantime the `skip` overrun policy suppresses the next slot. A
       * refusal that is invisible for thirty minutes is worse than a
       * failure that is visible now.
       */
      await finishRun({ client, runId: work?.runId, state: "failed", error: message });
      results.push({ jobId: work?.jobId ?? "?", state: "failed", error: message, tookMs: 0 });
      continue;
    }

    /* ---- 2. Run it -------------------------------------------------- */
    try {
      await client.transaction([
        client.query(SET_SCOPE),
        client.query(
          `UPDATE scheduler_runs
              SET state = 'running', started_at = now(), heartbeat_at = now()
            WHERE id = $1::uuid AND state = 'claimed'`,
          [work.runId],
        ),
      ]);

      const rows = await client.transaction([
        client.query(SET_SCOPE),
        client.query(work.sqlCall),
      ]);

      /**
       * `transaction()` returns one result per statement, in order, so the
       * prune's own output is the SECOND element. Recording it matters:
       * `prune_change_log` returns how many rows it removed and across how
       * many workspaces, and "removed 0 across 0 workspaces" is the shape
       * that means the function could not see the tenant list rather than
       * that there was nothing to prune.
       */
      const output = Array.isArray(rows) ? rows[1] : null;
      const tookMs = now() - startedAt;

      await finishRun({
        client,
        runId: work.runId,
        state: "succeeded",
        outcome: { result: summarise(output), tookMs },
      });

      log(`maintenance ${work.jobId} succeeded in ${tookMs}ms: ${JSON.stringify(summarise(output))}`);
      results.push({ jobId: work.jobId, state: "succeeded", error: null, tookMs });
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      error(`maintenance ${work.jobId} FAILED: ${message}`);
      try {
        await finishRun({ client, runId: work.runId, state: "failed", error: message });
      } catch (inner) {
        /**
         * ⚠️ THE LEDGER WRITE ITSELF FAILING IS A DIFFERENT AND WORSE
         * FAULT: it means the claim stays open. Said separately so the
         * operator reading the log can tell "the prune failed" from "we
         * cannot record anything at all".
         */
        error(
          `could not record the failure of ${work.jobId} — the claim stays open until the ` +
            `watchdog reclaims it: ${inner instanceof Error ? inner.message : String(inner)}`,
        );
      }
      results.push({
        jobId: work.jobId,
        state: "failed",
        error: message,
        tookMs: now() - startedAt,
      });
    }
  }

  return { ok, results };
}

async function finishRun(args) {
  await args.client.transaction([
    args.client.query(SET_SCOPE),
    args.client.query(
      `UPDATE scheduler_runs
          SET state = $2, finished_at = now(), heartbeat_at = now(),
              outcome = $3::jsonb, error = $4
        WHERE id = $1::uuid AND finished_at IS NULL`,
      [args.runId, args.state, JSON.stringify(args.outcome ?? {}), args.error ?? null],
    ),
  ]);
}

/** Keep the ledger row small. A prune returns one or two rows of counters. */
function summarise(output) {
  if (!Array.isArray(output)) return output ?? null;
  return output.slice(0, 5);
}
