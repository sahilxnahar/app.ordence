#!/usr/bin/env node
/**
 * Ordence — Track F · THE QUERY BUDGET GATE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE ONLY DELIVERABLE OF THIS TRACK THAT SURVIVES
 * ══════════════════════════════════════════════════════════════════════
 * Indexes rot. A query gets a new WHERE clause, a table grows past the
 * point where a plan holds, somebody adds an ORDER BY. Every performance
 * fix in this repository will decay the moment it stops being measured,
 * and nothing measures it. This does.
 *
 * It runs the catalogue in `scripts/perf/queries.mjs` against a real
 * Postgres at a real load profile, as `ordence_app` with RLS in force,
 * and exits non-zero when a query exceeds either its declared time
 * budget or its declared row budget.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 HOW THIS GATE AVOIDS BEING THE DEFECT IT IS CHECKING FOR
 * ══════════════════════════════════════════════════════════════════════
 * The brief names three real gates from this repo's history that passed
 * without ever doing anything:
 *
 *   • a gate whose skip path exited 0, tested only for `exit === 0`;
 *   • `count(*) >= 10 THEN 'PASS'` on a property needing 303 tables;
 *   • an error handler behind a filter that was provably always empty.
 *
 * So, in order:
 *
 * ① THE SKIP PATH EXITS 78, NOT 0. 78 is EX_CONFIG, the code
 *    `scripts/run-gates.mjs:35` treats as SKIPPED — and only honours for
 *    a gate whose manifest entry says `canSkip: true`. In CI,
 *    `SKIPS_ARE_FATAL` (run-gates.mjs:44) makes even that a failure. A
 *    skip here can never read as a pass.
 *
 * ② THERE IS NO FLOOR. It does not check "at least N queries were under
 *    budget". It checks EVERY catalogued query, and separately asserts
 *    the catalogue still has at least `MIN_CATALOGUE` entries — so the
 *    gate cannot be made green by deleting the queries that fail it.
 *
 * ③ IT REFUSES AN EMPTY DATABASE. A budget met against 40 rows is met
 *    against nothing. If the corpus is too small, the gate FAILS rather
 *    than passing, because a benchmark that quietly measures an empty
 *    table is precisely the `count(*) >= 10` bug wearing a stopwatch.
 *
 * ④ IT CAN BE SHOWN TO FAIL. `--self-test` runs the whole gate with
 *    every budget forced to an impossible 0.001 ms and asserts that it
 *    exits non-zero. A gate nobody has watched fail is a gate nobody
 *    knows works.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO QUERIES IN THE CATALOGUE ARE EXPECTED TO FAIL TODAY
 * ══════════════════════════════════════════════════════════════════════
 * `export.contacts` and `audit.deepOffset` carry `expectFail`. They are
 * real defects with no fix inside Track F's file ownership — the export
 * builder and the pagination validators belong to other tracks. They are
 * reported as KNOWN and do not fail the gate, exactly like
 * `KNOWN_UNPOSTED` in the posting gate. The list can only shrink.
 *
 * 🔴 AND IF ONE OF THEM STARTS PASSING, THE GATE FAILS. An entry in the
 * known list that no longer reproduces means somebody fixed it and the
 * exemption is now hiding the next regression. That is the failure mode
 * every allow-list in this repository eventually has.
 *
 * Usage:
 *   node scripts/perf/check-query-budgets.mjs
 *   node scripts/perf/check-query-budgets.mjs --self-test
 */

import pg from "pg";
import { QUERIES, EXTRA_PARAMS, BIG_TENANT_SLUG } from "./queries.mjs";

const SKIP_CODE = 78; // EX_CONFIG — see scripts/run-gates.mjs:35
const SELF_TEST = process.argv.includes("--self-test");
const RUNS = 7;

/**
 * ⚠️ THE ANTI-DELETION FLOOR. Not "how many must pass" — how many must
 * EXIST. Lowering it is a visible edit to this file.
 */
const MIN_CATALOGUE = 12;

/** Rows below which a measurement is not evidence of anything. */
const MIN_ROWS = { sales_invoices: 20000, journal_entries: 100000, contacts: 5000 };

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";
const APP_PASS = process.env.TEST_APP_PASSWORD ?? "test_only_not_a_secret";

const fail = (msg) => {
  console.error(`::error::${msg}`);
  failures.push(msg);
};
const failures = [];

if (QUERIES.length < MIN_CATALOGUE) {
  console.error(
    `\n🔴 The query catalogue has ${QUERIES.length} entries; ${MIN_CATALOGUE} is the floor.\n` +
      `   A budget gate you can pass by deleting the slow query is not a gate.\n`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* CONNECT, OR SKIP HONESTLY                                           */
/* ------------------------------------------------------------------ */

const app = new pg.Client({
  connectionString: `postgresql://ordence_app:${APP_PASS}@${HOST}:${PORT}/${DB}`,
});

try {
  await app.connect();
} catch (err) {
  /*
   * ⚠️ EXIT 78, NOT 0. And the message says what to run, because a skip
   * whose remedy is undocumented is a skip forever.
   */
  console.error(
    `\n⏭️  SKIPPED — no Postgres at ${HOST}:${PORT}/${DB} (${err.code ?? err.message}).\n\n` +
      `   npm run test:bootstrap\n` +
      `   node scripts/perf/seed-load.mjs\n\n` +
      `   In CI a skip is a failure (run-gates.mjs:44). This is deliberate.\n`,
  );
  process.exit(SKIP_CODE);
}

/* ------------------------------------------------------------------ */
/* REFUSE TO MEASURE SOMETHING MEANINGLESS                             */
/* ------------------------------------------------------------------ */

const counts = Object.fromEntries(
  (
    await app.query(
      `SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE relname = ANY($1)`,
      [Object.keys(MIN_ROWS)],
    )
  ).rows.map((r) => [r.relname, Number(r.n_live_tup)]),
);

for (const [table, floor] of Object.entries(MIN_ROWS)) {
  if ((counts[table] ?? 0) < floor) {
    fail(
      `${table} holds ${counts[table] ?? 0} rows; ${floor} is the minimum for a budget to mean ` +
        `anything. Run: node scripts/perf/seed-load.mjs`,
    );
  }
}
if (failures.length > 0) {
  console.error(`\n🔴 Refusing to certify budgets against a corpus this small.\n`);
  process.exit(1);
}

/**
 * ⚠️ And the role really must be subject to RLS. A gate that measured as
 * a BYPASSRLS role would pass budgets the application can never meet.
 */
const me = (
  await app.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
).rows[0];
if (!me || me.rolsuper || me.rolbypassrls) {
  console.error(
    `\n🔴 This gate is connected as a superuser or BYPASSRLS role. Every number would be wrong.\n`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */

/**
 * ⚠️ READING `tenants` AS THE APP ROLE NEEDS PLATFORM SCOPE, AND FINDING
 * THAT OUT WAS THIS GATE'S FIRST USEFUL OUTPUT.
 *
 * The first run of this file reported `no tenant "enterprise-01"` against
 * a database that demonstrably had one. `tenants` is under FORCE RLS and
 * its policy is `tenant_id = app_current_tenant_id() OR
 * app_is_platform_scope()`. With no tenant pinned, `app_current_tenant_id()`
 * is NULL, `id = NULL` is NULL — never TRUE — and the read returns ZERO
 * ROWS while looking exactly like "the seed did not run".
 *
 * That is verbatim the defect documented at `db/index.ts:337`, which
 * `withPlatformScope()` exists to solve. This is the same fix: the
 * marker, transaction-local, inside an explicit transaction so it is
 * discarded at COMMIT and cannot ride a pooled connection to the next
 * borrower.
 */
async function inPlatformScope(fn) {
  await app.query("BEGIN");
  try {
    await app.query(`SELECT set_config('app.platform_scope', 'on', true)`);
    return await fn();
  } finally {
    await app.query("ROLLBACK");
  }
}

/**
 * ⚠️ TWO DIFFERENT SCOPES, AND THE DIFFERENCE MATTERS.
 *
 * `tenants` is a platform table: reading a row by SLUG is exactly what
 * `withPlatformScope()` is for. Everything after it is ordinary tenant
 * data and is read with the tenant PINNED — the same scope the queries
 * under test will run in. Reading the sample ids under platform scope
 * instead would have worked here and would have been wrong in principle:
 * this gate must never demonstrate that a tenant-scoped read succeeds
 * under a marker the application does not set on that path.
 */
const tenantRow = await inPlatformScope(() =>
  app.query(`SELECT id FROM tenants WHERE slug = $1`, [BIG_TENANT_SLUG]),
);

if (tenantRow.rowCount === 0) {
  console.error(
    `\n🔴 No tenant "${BIG_TENANT_SLUG}" is visible even under platform scope.\n` +
      `   Run: node scripts/perf/seed-load.mjs\n`,
  );
  process.exit(1);
}
const tenantId = tenantRow.rows[0].id;

async function inTenantScope(fn) {
  await app.query("BEGIN");
  try {
    await app.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    return await fn();
  } finally {
    await app.query("ROLLBACK");
  }
}

const ctx = await inTenantScope(async () => ({
  ledgerId: (
    await app.query(
      `SELECT ledger_id FROM journal_entries WHERE tenant_id=$1
        GROUP BY ledger_id ORDER BY count(*) DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0]?.ledger_id,
  transactionId: (await app.query(`SELECT id FROM transactions WHERE tenant_id=$1 LIMIT 1`, [tenantId]))
    .rows[0]?.id,
  invoiceId: (await app.query(`SELECT id FROM sales_invoices WHERE tenant_id=$1 LIMIT 1`, [tenantId]))
    .rows[0]?.id,
}));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log(`\nQuery budgets  ·  ${QUERIES.length} queries  ·  tenant ${BIG_TENANT_SLUG}\n`);

const known = [];
let checked = 0;

for (const q of QUERIES) {
  const params = [tenantId, ...(EXTRA_PARAMS[q.id] ? EXTRA_PARAMS[q.id](ctx) : [])];
  if (params.some((p) => p == null)) {
    fail(`${q.id} — its parameters could not be resolved from the corpus; it was NOT measured`);
    continue;
  }

  const samples = [];
  let rows = 0;
  for (let i = 0; i <= RUNS; i++) {
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const t = process.hrtime.bigint();
    const res = await app.query(q.sql, params);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    await app.query("ROLLBACK");
    if (i > 0) samples.push(ms);
    rows = res.rowCount;
  }
  checked++;

  const ms = median(samples);
  const budgetMs = SELF_TEST ? 0.001 : q.budgetMs;
  const budgetRows = SELF_TEST ? 0 : q.budgetRows;
  const overTime = ms > budgetMs;
  const overRows = rows > budgetRows;

  if (q.expectFail && !SELF_TEST) {
    /*
     * 🔴 THE ALLOW-LIST THAT POLICES ITSELF. If a known-bad query starts
     * meeting its budget, somebody fixed it and this exemption is now a
     * blindfold. That is a failure, not a celebration.
     */
    if (!overTime && !overRows) {
      fail(
        `${q.id} is on the known-defect list (${q.expectFail}) but now meets its budget ` +
          `(${ms.toFixed(2)} ms, ${rows} rows). Remove \`expectFail\` from scripts/perf/queries.mjs — ` +
          `an exemption that no longer reproduces hides the next regression.`,
      );
    } else {
      known.push(`${q.id} (${q.expectFail}): ${ms.toFixed(2)} ms, ${rows} rows`);
      console.log(`  ⚠️  ${q.id.padEnd(24)} ${ms.toFixed(2).padStart(9)} ms  ${String(rows).padStart(7)} rows  KNOWN: ${q.expectFail}`);
    }
    continue;
  }

  if (overTime) {
    fail(
      `${q.id} took ${ms.toFixed(2)} ms, budget ${budgetMs} ms — ${q.source}`,
    );
  }
  if (overRows) {
    fail(
      `${q.id} returned ${rows} rows, ceiling ${budgetRows} — an endpoint with no ceiling is an ` +
        `availability incident with a polite name. ${q.source}`,
    );
  }
  if (!overTime && !overRows) {
    console.log(
      `  ✅ ${q.id.padEnd(24)} ${ms.toFixed(2).padStart(9)} ms  ${String(rows).padStart(7)} rows  (budget ${budgetMs} ms)`,
    );
  } else {
    console.log(
      `  🔴 ${q.id.padEnd(24)} ${ms.toFixed(2).padStart(9)} ms  ${String(rows).padStart(7)} rows  (budget ${budgetMs} ms)`,
    );
  }
}

await app.end();

/**
 * ⚠️ AND FINALLY: DID IT ACTUALLY MEASURE ANYTHING? A run in which every
 * query was skipped for want of parameters would otherwise print a tidy
 * empty report and exit 0 — the exact failure this file's header is
 * about.
 */
if (checked < MIN_CATALOGUE) {
  fail(`only ${checked} of ${QUERIES.length} queries were actually executed`);
}

if (known.length > 0) {
  console.log(`\n  Known defects, not fixed by Track F (see TRACK-REPORT.md §4):`);
  for (const k of known) console.log(`    • ${k}`);
}

if (SELF_TEST) {
  if (failures.length === 0) {
    console.error(
      `\n🔴 SELF-TEST FAILED. With every budget set to 0.001 ms this gate reported no failures,\n` +
        `   which means it cannot fail, which means it is not a gate.\n`,
    );
    process.exit(1);
  }
  console.log(
    `\n✅ SELF-TEST PASSED — ${failures.length} failures at an impossible budget. The gate can fail.\n`,
  );
  process.exit(0);
}

if (failures.length > 0) {
  console.error(`\n🔴 ${failures.length} query budget violation(s).\n`);
  process.exit(1);
}

console.log(`\n✅ ${checked} queries within budget, ${known.length} known defect(s) tracked.\n`);
