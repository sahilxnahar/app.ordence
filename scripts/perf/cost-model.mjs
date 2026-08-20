#!/usr/bin/env node
/**
 * Ordence — Track F · WHAT A TENANT COSTS TO SERVE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS THE MOST COMMERCIALLY USEFUL OUTPUT OF THE TRACK
 * ══════════════════════════════════════════════════════════════════════
 * Ordence has pricing tiers (`lib/edge/budgets.ts`) and no idea what any
 * of them costs to serve. Every pricing conversation until now has been
 * about what customers will pay, with the other side of the equation
 * blank.
 *
 * This fills it in from MEASURED numbers, not estimates:
 *
 *   • per-query milliseconds and shared buffers, from
 *     `scripts/perf/results/measure-baseline.json`
 *   • per-write microseconds, from
 *     `scripts/perf/results/write-cost.json`
 *   • real bytes on disk per tenant, from `pg_total_relation_size`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IS MEASURED AND WHAT IS ASSUMED — THE LINE IS DRAWN LOUDLY
 * ══════════════════════════════════════════════════════════════════════
 * MEASURED: cost per operation, bytes per tenant, write amplification.
 * ASSUMED : how many operations a tenant performs in a month, and the
 *           unit price of compute and storage.
 *
 * The assumptions are all in `ACTIVITY` and `RATES` below, in one place,
 * each with a sentence saying where it came from. A cost model whose
 * assumptions are scattered through the arithmetic is a model nobody can
 * argue with, which makes it useless.
 *
 * ⚠️ THE PRICES ARE PLACEHOLDERS AND THE OUTPUT SAYS SO ON EVERY LINE.
 * Cloud list prices change; this file does not know today's. Override
 * them: --cu-hour-usd=0.16 --gb-month-usd=0.35
 *
 * Usage:
 *   node scripts/perf/cost-model.mjs
 *   node scripts/perf/cost-model.mjs --cu-hour-usd=0.16 --gb-month-usd=0.35
 */

import pg from "pg";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.slice(n.length + 3)) : d;
};

/**
 * ⚠️ ASSUMED, NOT MEASURED. Placeholder list prices for a serverless
 * Postgres. Confirm against the provider's current pricing page before
 * quoting any number below to anybody.
 */
const RATES = {
  cuHourUsd: arg("cu-hour-usd", 0.16),
  gbMonthUsd: arg("gb-month-usd", 0.35),
};

/**
 * ⚠️ ASSUMED, NOT MEASURED. A month of activity per tier, derived from
 * the seat limits and the load profile in `scripts/perf/seed-load.mjs`:
 * a starter tenant is one small business issuing ~35 invoices a month
 * with 5 users; enterprise is 40× that. Every number here is arguable
 * and every one is in one place so it CAN be argued with.
 */
const ACTIVITY = {
  basic: { label: "starter", users: 5, listViews: 6000, invoices: 35, postings: 45 },
  advanced: { label: "growth", users: 20, listViews: 26000, invoices: 140, postings: 180 },
  enterprise: { label: "enterprise", users: 200, listViews: 260000, invoices: 1400, postings: 1800 },
};

/** Reads per list view. Assumed: one page query plus its count. */
const QUERIES_PER_VIEW = 2;
/** Journal legs per posting. Measured shape: a GST posting has four. */
const LEGS_PER_POSTING = 4;
/** Lines per invoice, from the load profile. */
const LINES_PER_INVOICE = 3;

/* ------------------------------------------------------------------ */

const measurePath = join(RESULTS, "measure-baseline.json");
const writePath = join(RESULTS, "write-cost.json");

for (const [p, how] of [
  [measurePath, "node scripts/perf/measure.mjs --tag=baseline"],
  [writePath, "node scripts/perf/measure-writes.mjs"],
]) {
  if (!existsSync(p)) {
    console.error(
      `\n🔴 ${p} is missing. This model refuses to run on invented numbers.\n   Run: ${how}\n`,
    );
    process.exit(1);
  }
}

const measured = JSON.parse(readFileSync(measurePath, "utf8"));
const writes = JSON.parse(readFileSync(writePath, "utf8"));

const q = Object.fromEntries(measured.queries.map((r) => [r.id, r]));
const need = ["contacts.page", "contacts.count", "invoices.list"];
for (const id of need) {
  if (!q[id]) {
    console.error(`\n🔴 measure-baseline.json has no "${id}". Re-run the measurement.\n`);
    process.exit(1);
  }
}

/** Median read cost of a list view: the page query plus its count. */
const readMs = q["contacts.page"].medianMs + q["contacts.count"].medianMs;

const invoiceWriteUs =
  writes.scenarios.find((s) => s.table === "sales_invoices" && s.label.startsWith("A"))?.perRowUs ??
  null;
const legWriteUs =
  writes.scenarios.find((s) => s.table === "journal_entries" && s.label.startsWith("A"))?.perRowUs ??
  null;
const legWriteBareUs =
  writes.scenarios.find((s) => s.table === "journal_entries" && s.label.startsWith("D"))?.perRowUs ??
  null;

if (invoiceWriteUs === null || legWriteUs === null) {
  console.error(`\n🔴 write-cost.json does not carry both tables. Re-run measure-writes.mjs.\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* MEASURED STORAGE, PER TENANT                                        */
/* ------------------------------------------------------------------ */

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";

const db = new pg.Client({
  connectionString: `postgresql://${process.env.PGUSER ?? "postgres"}@${HOST}:${PORT}/${DB}`,
});
await db.connect();

/**
 * ⚠️ Bytes per ROW, measured, then multiplied by the tenant's row count.
 * `pg_total_relation_size` is per table, not per tenant, so a per-tenant
 * figure has to come from (table bytes / table rows) × tenant rows. It
 * includes indexes and TOAST, which is the point: an index is storage
 * somebody pays for.
 */
const sizes = (
  await db.query(
    `SELECT c.relname AS tbl,
            pg_total_relation_size(c.oid) AS bytes,
            GREATEST(s.n_live_tup, 1)     AS rows
       FROM pg_class c
       JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname IN ('sales_invoices','sales_invoice_lines','journal_entries',
                          'transactions','change_log','audit_logs','contacts','companies')`,
  )
).rows;

const bytesPerRow = Object.fromEntries(
  sizes.map((r) => [r.tbl, Number(r.bytes) / Number(r.rows)]),
);

const perTenant = (
  await db.query(
    `SELECT t.slug, t.plan_tier::text AS tier,
            (SELECT count(*) FROM sales_invoices    x WHERE x.tenant_id = t.id) AS invoices,
            (SELECT count(*) FROM journal_entries   x WHERE x.tenant_id = t.id) AS legs,
            (SELECT count(*) FROM change_log        x WHERE x.tenant_id = t.id) AS change_rows,
            (SELECT count(*) FROM audit_logs        x WHERE x.tenant_id = t.id) AS audit_rows
       FROM tenants t
      WHERE t.slug LIKE 'starter-%' OR t.slug LIKE 'growth-%' OR t.slug LIKE 'enterprise-%'
      ORDER BY 3 DESC`,
  )
).rows;

await db.end();

/* ------------------------------------------------------------------ */
/* THE MODEL                                                           */
/* ------------------------------------------------------------------ */

const MS_PER_MONTH_CU = 3600 * 1000; // one compute-unit-hour in ms of DB time

function monthlyFor(tierKey) {
  const a = ACTIVITY[tierKey];

  const readMsTotal = a.listViews * QUERIES_PER_VIEW * readMs;
  const invoiceMs = a.invoices * (invoiceWriteUs / 1000) * (1 + LINES_PER_INVOICE);
  const postingMs = a.postings * LEGS_PER_POSTING * (legWriteUs / 1000);
  const totalMs = readMsTotal + invoiceMs + postingMs;

  const sample = perTenant.find((r) => r.tier === tierKey);
  const storageBytes = sample
    ? Number(sample.invoices) * (bytesPerRow["sales_invoices"] ?? 0) +
      Number(sample.legs) * (bytesPerRow["journal_entries"] ?? 0) +
      Number(sample.change_rows) * (bytesPerRow["change_log"] ?? 0) +
      Number(sample.audit_rows) * (bytesPerRow["audit_logs"] ?? 0)
    : 0;

  const cuHours = totalMs / MS_PER_MONTH_CU;
  const gb = storageBytes / 1024 ** 3;

  return {
    tier: tierKey,
    label: a.label,
    users: a.users,
    readMs: readMsTotal,
    writeMs: invoiceMs + postingMs,
    totalMs,
    totalSeconds: totalMs / 1000,
    cuHours,
    computeUsd: cuHours * RATES.cuHourUsd,
    storageGb: gb,
    storageUsd: gb * RATES.gbMonthUsd,
    totalUsd: cuHours * RATES.cuHourUsd + gb * RATES.gbMonthUsd,
    perUserUsd: (cuHours * RATES.cuHourUsd + gb * RATES.gbMonthUsd) / a.users,
    sampleSlug: sample?.slug ?? null,
  };
}

const rows = Object.keys(ACTIVITY).map(monthlyFor);

console.log(`\nCost to serve, per tenant, per month\n`);
console.log(
  `  ${"tier".padEnd(12)}${"users".padStart(6)}${"DB seconds".padStart(12)}` +
    `${"storage".padStart(11)}${"compute $".padStart(11)}${"storage $".padStart(11)}` +
    `${"total $".padStart(10)}${"$/user".padStart(9)}`,
);
console.log("  " + "─".repeat(82));
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(12)}${String(r.users).padStart(6)}` +
      `${r.totalSeconds.toFixed(1).padStart(12)}` +
      `${(r.storageGb * 1024).toFixed(0).padStart(9)} MB` +
      `${r.computeUsd.toFixed(3).padStart(11)}` +
      `${r.storageUsd.toFixed(3).padStart(11)}` +
      `${r.totalUsd.toFixed(3).padStart(10)}` +
      `${r.perUserUsd.toFixed(4).padStart(9)}`,
  );
}

const starter = rows.find((r) => r.tier === "basic");
const ent = rows.find((r) => r.tier === "enterprise");

console.log(`\n  What the numbers say\n`);
console.log(
  `    • An enterprise tenant costs ${(ent.totalUsd / starter.totalUsd).toFixed(1)}× a starter ` +
    `tenant to serve, on ${(ent.users / starter.users).toFixed(0)}× the seats.`,
);
console.log(
  `    • Per user it is ${(ent.perUserUsd / starter.perUserUsd).toFixed(2)}× — ` +
    `${ent.perUserUsd / starter.perUserUsd < 1 ? "CHEAPER" : "MORE EXPENSIVE"} per seat at the top ` +
    `of the range, which is the number a per-seat price list has to survive.`,
);
console.log(
  `    • Reads are ${((starter.readMs / starter.totalMs) * 100).toFixed(0)}% of a starter ` +
    `tenant's database time and ${((ent.readMs / ent.totalMs) * 100).toFixed(0)}% of an ` +
    `enterprise tenant's.`,
);

if (legWriteBareUs) {
  console.log(
    `\n    🔴 ${(((legWriteUs - legWriteBareUs) / legWriteUs) * 100).toFixed(0)}% of every ` +
      `journal-leg write is triggers, not the insert. Measured: ${legWriteUs} µs/row with ` +
      `them, ${legWriteBareUs} µs/row without. On the enterprise line above that is ` +
      `${((ent.writeMs * (legWriteUs - legWriteBareUs)) / legWriteUs / 1000).toFixed(1)} ` +
      `seconds a month of pure trigger time, $${(
        ((ent.writeMs * (legWriteUs - legWriteBareUs)) / legWriteUs / MS_PER_MONTH_CU) *
        RATES.cuHourUsd
      ).toFixed(5)}. Small in money at this volume; the reason it matters is LATENCY ` +
      `on the posting path and LOCK HOLD TIME on the ledger row, neither of which ` +
      `appears in a monthly total. See docs/PERFORMANCE.md §6.`,
  );
}

console.log(
  `\n  ⚠️ MEASURED: per-operation cost, bytes per row, write amplification.` +
    `\n  ⚠️ ASSUMED : the activity model in ACTIVITY, and the prices in RATES` +
    ` ($${RATES.cuHourUsd}/CU-hour, $${RATES.gbMonthUsd}/GB-month).` +
    `\n     Confirm the prices before quoting any figure above to anybody.` +
    `\n  ⚠️ EXCLUDED: Railway compute, Clerk, Resend, R2, Upstash. This is the` +
    `\n     database only — the part this track measured.\n`,
);

writeFileSync(
  join(RESULTS, "cost-model.json"),
  JSON.stringify({ rates: RATES, activity: ACTIVITY, measured: { readMs, invoiceWriteUs, legWriteUs, legWriteBareUs }, bytesPerRow, rows }, null, 2) + "\n",
);
console.log(`  Wrote scripts/perf/results/cost-model.json\n`);
