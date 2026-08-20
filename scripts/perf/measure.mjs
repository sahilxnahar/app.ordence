#!/usr/bin/env node
/**
 * Ordence — Track F · THE MEASUREMENT HARNESS
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR WAYS A DATABASE BENCHMARK LIES, AND WHAT IS DONE ABOUT EACH
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. NO STATISTICS. A freshly loaded table has none; the planner guesses
 *    and picks plans production would never pick. → `seed-load.mjs` runs
 *    ANALYZE, and this harness refuses to start if `pg_stat_user_tables`
 *    shows a seeded table with `last_analyze IS NULL`.
 *
 * 2. NO RLS. Measuring as a superuser measures a different query. Every
 *    policy on this database is `FORCE ROW LEVEL SECURITY`, so the
 *    predicate `tenant_id = app_current_tenant_id()` is added to every
 *    plan — but ONLY for a role that is subject to it. → this connects
 *    as `ordence_app` (NOSUPERUSER NOBYPASSRLS) and sets the tenant with
 *    `set_config(..., true)` inside a transaction, which is what
 *    `db/index.ts:284 withTenant()` does.
 *
 * 3. ONE RUN. The first execution of anything pays for cold shared
 *    buffers, and `EXPLAIN ANALYZE` itself adds per-node timing
 *    overhead. → one discarded warm-up, then N timed plain executions
 *    (no EXPLAIN) for the number that is quoted, and ONE separate
 *    `EXPLAIN (ANALYZE, BUFFERS)` for the plan.
 *
 * 4. THE AVERAGE. One GC pause moves a mean and tells you nothing. →
 *    median and p95 are reported; the mean is not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RLS DELTA IS MEASURED, NOT ASSUMED
 * ══════════════════════════════════════════════════════════════════════
 * Every query is ALSO run as a BYPASSRLS role with the same explicit
 * `tenant_id = $1` predicate. The difference between the two is the cost
 * of row-level security on this schema, in milliseconds, per query.
 * Nobody in this repository has ever had that number.
 *
 * Usage:
 *   node scripts/perf/measure.mjs
 *   node scripts/perf/measure.mjs --runs=15 --tenant=starter-01
 *   node scripts/perf/measure.mjs --tag=after-indexes
 */

import pg from "pg";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { QUERIES, EXTRA_PARAMS, BIG_TENANT_SLUG } from "./queries.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const RESULTS = join(HERE, "results");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const RUNS = Number(opt("runs", "11"));
const TENANT_SLUG = opt("tenant", BIG_TENANT_SLUG);
const TAG = opt("tag", "baseline");

/* ------------------------------------------------------------------ */
/* CONNECTIONS                                                         */
/* ------------------------------------------------------------------ */

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";
const ADMIN_USER = process.env.PGUSER ?? "postgres";
const APP_USER = "ordence_app";
const APP_PASS = process.env.TEST_APP_PASSWORD ?? "test_only_not_a_secret";

const adminUrl = `postgresql://${ADMIN_USER}@${HOST}:${PORT}/${DB}`;
const appUrl = `postgresql://${APP_USER}:${APP_PASS}@${HOST}:${PORT}/${DB}`;

if (!["localhost", "127.0.0.1", "::1"].includes(HOST) || !/test/i.test(DB)) {
  console.error(`\n🔴 REFUSING: ${HOST}/${DB} is not obviously a throwaway database.\n`);
  process.exit(2);
}

const admin = new pg.Client({ connectionString: adminUrl });
const app = new pg.Client({ connectionString: appUrl });
await admin.connect();
await app.connect();

/* ------------------------------------------------------------------ */
/* PRE-FLIGHT — refuse to produce numbers that would be wrong          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE CHECK THAT STOPS THIS TOOL FROM BEING THE `count(*) >= 10` GATE.
 *
 * A harness that silently produces plans against an un-ANALYZEd or empty
 * database is worse than no harness: it produces confident numbers that
 * justify dropping the wrong index. So it refuses, loudly, rather than
 * degrading.
 */
const preflight = await admin.query(
  `SELECT relname, n_live_tup, last_analyze, last_autoanalyze
     FROM pg_stat_user_tables
    WHERE relname IN ('sales_invoices','journal_entries','contacts','audit_logs','stock_movements')`,
);
const problems = [];
for (const r of preflight.rows) {
  if (Number(r.n_live_tup) < 1000) {
    problems.push(`${r.relname} holds ${r.n_live_tup} rows — a plan on that says nothing`);
  }
  if (!r.last_analyze && !r.last_autoanalyze) {
    problems.push(`${r.relname} has never been ANALYZEd — the planner is guessing`);
  }
}
if (preflight.rows.length === 0) problems.push("none of the measured tables exist");
if (problems.length > 0) {
  console.error(`\n🔴 REFUSING TO MEASURE:\n`);
  for (const p of problems) console.error(`   • ${p}`);
  console.error(`\n   Run: node scripts/perf/seed-load.mjs --truncate\n`);
  process.exit(1);
}

/**
 * ⚠️ AND THE OTHER HALF: prove the app role really is subject to RLS
 * before quoting a single "with RLS" number. A role that quietly gained
 * BYPASSRLS would make every measurement below a measurement of nothing.
 */
const roleCheck = await admin.query(
  `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
  [APP_USER],
);
if (!roleCheck.rows[0] || roleCheck.rows[0].rolsuper || roleCheck.rows[0].rolbypassrls) {
  console.error(
    `\n🔴 ${APP_USER} is superuser or BYPASSRLS. Every "with RLS" number below would be a lie.\n`,
  );
  process.exit(1);
}

const forced = await admin.query(
  `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity`,
);
console.log(
  `\nMeasuring  ·  tenant ${TENANT_SLUG}  ·  ${RUNS} runs  ·  ` +
    `${forced.rows[0].n} tables under FORCE RLS  ·  tag "${TAG}"\n`,
);

/* ------------------------------------------------------------------ */
/* CONTEXT — real ids from the seeded corpus                           */
/* ------------------------------------------------------------------ */

const tenantRow = await admin.query(`SELECT id FROM tenants WHERE slug = $1`, [TENANT_SLUG]);
if (tenantRow.rowCount === 0) {
  console.error(`\n🔴 No tenant with slug "${TENANT_SLUG}". Run seed-load.mjs first.\n`);
  process.exit(1);
}
const tenantId = tenantRow.rows[0].id;

const ctx = {
  tenantId,
  ledgerId: (
    await admin.query(
      `SELECT ledger_id FROM journal_entries WHERE tenant_id = $1
        GROUP BY ledger_id ORDER BY count(*) DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0]?.ledger_id,
  transactionId: (
    await admin.query(`SELECT id FROM transactions WHERE tenant_id = $1 LIMIT 1`, [tenantId])
  ).rows[0]?.id,
  invoiceId: (
    await admin.query(`SELECT id FROM sales_invoices WHERE tenant_id = $1 LIMIT 1`, [tenantId])
  ).rows[0]?.id,
};

/* ------------------------------------------------------------------ */
/* THE RUNNER                                                          */
/* ------------------------------------------------------------------ */

function paramsFor(q) {
  const extra = EXTRA_PARAMS[q.id] ? EXTRA_PARAMS[q.id](ctx) : [];
  return [tenantId, ...extra];
}

/**
 * One measured execution inside a real tenant transaction — the same
 * shape `withTenant()` opens. `set_config(..., true)` is transaction
 * local; outside a transaction it would be discarded immediately and
 * every query would return zero rows, which is the exact bug documented
 * at `db/index.ts:151`.
 */
async function runOnce(client, q, params, { rls }) {
  await client.query("BEGIN");
  try {
    if (rls) {
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    }
    const started = process.hrtime.bigint();
    const res = await client.query(q.sql, params);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms: elapsed, rows: res.rowCount };
  } finally {
    await client.query("ROLLBACK");
  }
}

async function explainOnce(client, q, params, { rls }) {
  await client.query("BEGIN");
  try {
    if (rls) {
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    }
    const res = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE false, FORMAT JSON) ${q.sql}`,
      params,
    );
    return res.rows[0]["QUERY PLAN"][0];
  } finally {
    await client.query("ROLLBACK");
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
};

/**
 * Walk the plan tree and describe it in one line: the scan nodes that
 * actually touched a table, and whether anything sorted or spilled.
 * A plan blob nobody reads is not a measurement.
 */
function summarisePlan(node, acc = { scans: [], sorts: [], rowsRemoved: 0, maxRows: 0 }) {
  const type = node["Node Type"];
  if (/Scan/.test(type)) {
    acc.scans.push(
      `${type}${node["Relation Name"] ? ` on ${node["Relation Name"]}` : ""}` +
        `${node["Index Name"] ? ` using ${node["Index Name"]}` : ""}`,
    );
  }
  if (/Sort|Incremental Sort/.test(type)) {
    acc.sorts.push(`${type}${node["Sort Method"] ? ` (${node["Sort Method"]})` : ""}`);
  }
  acc.rowsRemoved += Number(node["Rows Removed by Filter"] ?? 0);
  acc.maxRows = Math.max(acc.maxRows, Number(node["Actual Rows"] ?? 0));
  for (const child of node["Plans"] ?? []) summarisePlan(child, acc);
  return acc;
}

const results = [];

for (const q of QUERIES) {
  const params = paramsFor(q);
  if (params.some((p) => p === undefined || p === null)) {
    console.log(`  ${q.id.padEnd(24)} SKIPPED — no seed data for its parameters`);
    continue;
  }

  // Warm-up, discarded. Cold shared buffers are not a query property.
  await runOnce(app, q, params, { rls: true });

  const withRls = [];
  for (let i = 0; i < RUNS; i++) withRls.push((await runOnce(app, q, params, { rls: true })).ms);

  const withoutRls = [];
  await runOnce(admin, q, params, { rls: false });
  for (let i = 0; i < RUNS; i++)
    withoutRls.push((await runOnce(admin, q, params, { rls: false })).ms);

  const plan = await explainOnce(app, q, params, { rls: true });
  const shape = summarisePlan(plan["Plan"]);
  const rowCount = (await runOnce(app, q, params, { rls: true })).rows;

  const medMs = median(withRls);
  const record = {
    id: q.id,
    title: q.title,
    source: q.source,
    tenant: TENANT_SLUG,
    rows: rowCount,
    medianMs: Number(medMs.toFixed(3)),
    p95Ms: Number(p95(withRls).toFixed(3)),
    bypassRlsMedianMs: Number(median(withoutRls).toFixed(3)),
    rlsOverheadMs: Number((medMs - median(withoutRls)).toFixed(3)),
    planningMs: plan["Planning Time"],
    executionMs: plan["Execution Time"],
    sharedRead: plan["Plan"]["Shared Read Blocks"] ?? 0,
    sharedHit: plan["Plan"]["Shared Hit Blocks"] ?? 0,
    scans: shape.scans,
    sorts: shape.sorts,
    rowsRemovedByFilter: shape.rowsRemoved,
    budgetMs: q.budgetMs,
    budgetRows: q.budgetRows,
    overBudgetMs: medMs > q.budgetMs,
    overBudgetRows: rowCount > q.budgetRows,
    expectFail: q.expectFail ?? null,
    plan,
  };
  results.push(record);

  const verdict = record.overBudgetMs || record.overBudgetRows ? "🔴" : "✅";
  console.log(
    `  ${verdict} ${q.id.padEnd(24)} ${String(record.medianMs).padStart(9)} ms` +
      `  (budget ${String(q.budgetMs).padStart(4)})` +
      `  rows ${String(record.rows).padStart(7)}` +
      `  rls +${String(record.rlsOverheadMs).padStart(7)} ms` +
      `  ${shape.scans.slice(0, 2).join(" + ")}`,
  );
}

/* ------------------------------------------------------------------ */

mkdirSync(RESULTS, { recursive: true });
const out = {
  tag: TAG,
  tenant: TENANT_SLUG,
  runs: RUNS,
  measuredAt: new Date().toISOString(),
  postgres: (await admin.query("SHOW server_version")).rows[0].server_version,
  loadProfile: existsSync(join(RESULTS, "load-profile.json"))
    ? JSON.parse(readFileSync(join(RESULTS, "load-profile.json"), "utf8")).rows
    : null,
  queries: results,
};
writeFileSync(join(RESULTS, `measure-${TAG}.json`), JSON.stringify(out, null, 2) + "\n");

const over = results.filter((r) => r.overBudgetMs || r.overBudgetRows);
console.log(`\n  ${over.length} of ${results.length} queries outside budget.`);
console.log(`  Wrote scripts/perf/results/measure-${TAG}.json\n`);

await app.end();
await admin.end();
