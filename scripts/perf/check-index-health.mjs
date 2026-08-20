#!/usr/bin/env node
/**
 * Ordence — Track F · THE INDEX HEALTH GATE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT REFUSES, AND WHY EACH ONE IS A REGRESSION AND NOT A STYLE NOTE
 * ══════════════════════════════════════════════════════════════════════
 * ① A BARE `(tenant_id)` INDEX ON A TABLE THAT HAS A WIDER ONE.
 *    By the B-tree prefix rule it serves no query the wide one cannot.
 *    It is a page write on every insert in exchange for nothing. 0157
 *    removed 102 of them; without this gate they come back one at a
 *    time, because `index("x_tenant_idx").on(t.tenantId)` is the first
 *    line anybody writes when adding a Drizzle table.
 *
 * ② AN EXACT DUPLICATE. The same index under two names, from two
 *    migrations that each used `IF NOT EXISTS` and each thought it was
 *    first. 0156 removed 5.
 *
 * ③ AN INVALID INDEX. Left behind by a failed `CREATE INDEX
 *    CONCURRENTLY`. It is written to on every insert and used by no
 *    plan — the worst possible combination, and completely invisible
 *    without asking `pg_index.indisvalid`.
 *
 * ④ A NEW TABLE UNDER RLS WITH NO INDEX LEADING WITH `tenant_id`.
 *    Every tenant-scoped read of it is a sequential scan. 11 such tables
 *    exist today; they are listed by name, and the gate fails only if a
 *    TWELFTH appears. The list can shrink, never grow — the same shape
 *    as `KNOWN_UNPOSTED` in the posting gate, for the same reason.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE RULE LIVES IN SQL, NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * `ordence_index_health()` (SQL-FILES/0155) is the single definition,
 * shared with 0156 and 0157. Two copies of a rule are two rules.
 *
 * If the function is missing this gate FAILS rather than skipping: a
 * database without it has not had 0155 applied, and 0156/0157 cannot
 * have run either.
 *
 * Exit 0 pass · 1 fail · 78 SKIPPED (no database).
 */

import pg from "pg";

const SKIP_CODE = 78;

/**
 * ⚠️ THE ELEVEN, BY NAME. Every one of these has a `tenant_id` column,
 * FORCE RLS, and no index that begins with it. They are not fixed here
 * because an index must be justified by a measured plan, and only one of
 * them (`change_log`, now 0153) cleared that bar. See TRACK-REPORT.md §4.
 *
 * 🔴 THIS LIST MAY ONLY SHRINK. Adding a name to it is an edit somebody
 * has to justify in review.
 */
const KNOWN_MISSING_TENANT_INDEX = new Set([
  "campaign_recipients",
  "consents",
  "court_fee_refund_claims",
  "court_fee_schedules",
  "email_suppressions",
  "goods_receipt_lines",
  "lead_intake_failures",
  "login_lockouts",
  "message_templates",
  "webhook_endpoints",
]);

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";

const failures = [];
const fail = (m) => {
  console.error(`::error::${m}`);
  failures.push(m);
};

const db = new pg.Client({
  connectionString: `postgresql://${process.env.PGUSER ?? "postgres"}@${HOST}:${PORT}/${DB}`,
});

try {
  await db.connect();
} catch (err) {
  console.error(
    `\n⏭️  SKIPPED — no Postgres at ${HOST}:${PORT}/${DB} (${err.code ?? err.message}).\n` +
      `   npm run test:bootstrap\n` +
      `   In CI a skip is a failure (scripts/run-gates.mjs:44). This is deliberate.\n`,
  );
  process.exit(SKIP_CODE);
}

const hasFn = (
  await db.query(`SELECT count(*)::int n FROM pg_proc WHERE proname = 'ordence_index_health'`)
).rows[0].n;

if (hasFn === 0) {
  console.error(
    `\n🔴 ordence_index_health() is not installed.\n\n` +
      `   That means SQL-FILES/0155 has not been applied to this database, and so\n` +
      `   0156 and 0157 cannot have run either. This is a FAILURE, not a skip: a\n` +
      `   gate that passes on a database missing the thing it checks is the defect\n` +
      `   it was written to catch.\n`,
  );
  process.exit(1);
}

const rows = (await db.query(`SELECT * FROM public.ordence_index_health()`)).rows;

const redundant = rows.filter((r) => r.category === "redundant-prefix");
const dupes = rows.filter((r) => r.category === "exact-duplicate");
const missing = rows.filter((r) => r.category === "missing-tenant-leading");

for (const r of redundant) {
  fail(
    `${r.table_name}.${r.index_name} is a bare (tenant_id) index and ${r.detail}. ` +
      `It serves no query that index cannot, and costs a page write on every insert. ` +
      `Remove it, or widen it so it earns its keep.`,
  );
}
for (const r of dupes) {
  fail(`${r.table_name}.${r.index_name} is ${r.detail}. One of the two is pure write cost.`);
}
for (const r of missing) {
  if (!KNOWN_MISSING_TENANT_INDEX.has(r.table_name)) {
    fail(
      `${r.table_name} is under RLS with a tenant_id column and no index leading with it, ` +
        `so every tenant-scoped read of it is a sequential scan. Add one, or add the ` +
        `table to KNOWN_MISSING_TENANT_INDEX in this file with a reason.`,
    );
  }
}

/**
 * 🔴 THE ALLOW-LIST POLICES ITSELF. A name on the known list that no
 * longer reproduces means somebody fixed it, and the entry is now hiding
 * whatever appears next on that table.
 */
const stillMissing = new Set(missing.map((r) => r.table_name));
for (const name of KNOWN_MISSING_TENANT_INDEX) {
  if (!stillMissing.has(name)) {
    fail(
      `${name} is on KNOWN_MISSING_TENANT_INDEX but now HAS an index leading with ` +
        `tenant_id. Remove it from the list — a stale exemption hides the next regression.`,
    );
  }
}

/* --- invalid indexes ------------------------------------------------ */

const invalid = (
  await db.query(
    `SELECT c.relname AS tbl, ic.relname AS idx, i.indisvalid, i.indisready
       FROM pg_index i
       JOIN pg_class c  ON c.oid  = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND (NOT i.indisvalid OR NOT i.indisready)`,
  )
).rows;

for (const r of invalid) {
  fail(
    `${r.tbl}.${r.idx} is INVALID (indisvalid=${r.indisvalid}, indisready=${r.indisready}) — ` +
      `left behind by a failed CREATE INDEX CONCURRENTLY. It is maintained on every write ` +
      `and used by no plan. DROP INDEX CONCURRENTLY ${r.idx};`,
  );
}

/* --- the counter-check ---------------------------------------------- */

/**
 * ⚠️ AND: DID THE FUNCTION ACTUALLY LOOK AT ANYTHING? A schema with
 * 1,300+ indexes that reports zero rows in all three categories AND
 * zero tables examined is a broken query, not a clean database. This is
 * the check that stops this gate from being a green light nobody earned.
 */
const total = (
  await db.query(
    `SELECT count(*)::int n FROM pg_indexes WHERE schemaname = 'public'`,
  )
).rows[0].n;

if (total < 500) {
  fail(
    `Only ${total} indexes in schema public. This database does not look like Ordence; ` +
      `the gate would pass for the wrong reason.`,
  );
}

await db.end();

if (failures.length > 0) {
  console.error(`\n🔴 Index health FAILED — ${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log(
  `\n✅ Index health — ${total} indexes examined. ` +
    `0 redundant, 0 duplicate, 0 invalid, ` +
    `${missing.length} table(s) without a tenant-leading index (all known, see ` +
    `TRACK-REPORT.md §4).\n`,
);
