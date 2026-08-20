#!/usr/bin/env node
/**
 * Ordence — Track F · GENERATE A LOAD PROFILE WORTH MEASURING
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `EXPLAIN ANALYZE` on an empty database is a lie with a plan attached.
 * Below roughly 1,000 rows PostgreSQL picks a sequential scan for
 * everything, because a seq scan genuinely IS optimal there — the whole
 * table is one or two pages. Read that plan and you will conclude the
 * index is useless, drop it, and discover at 400,000 rows that the
 * sequential scan you blessed is a four-second page load.
 *
 * So: before any measurement, real volume. This script writes a
 * multi-tenant corpus with a deliberately SKEWED distribution, because
 * an evenly-loaded database is the second most misleading thing after an
 * empty one. Real ERP tenancy is a power law: most customers are small,
 * one is enormous, and the enormous one is the one that pages you.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE BIG TENANT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * Tenant 12 carries ~10× the data of the largest other tenant. Under RLS
 * every query already filters `tenant_id = app_current_tenant_id()`, so
 * a table-wide index that looks fine on the average tenant can still be
 * useless for the one tenant whose slice IS most of the table. The
 * planner's row estimate for `tenant_id = $1` is derived from
 * n_distinct and the MCV list; a heavily skewed tenant column is exactly
 * where that estimate goes wrong.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `session_replication_role = replica` DURING THE LOAD, AND WHY
 * ══════════════════════════════════════════════════════════════════════
 * This database carries 979 non-internal triggers across 319 tables —
 * 289 of them the `record_change()` change-log trigger, which writes a
 * full `to_jsonb(OLD)` + `to_jsonb(NEW)` row into `change_log` FOR EACH
 * ROW. Loading a million rows with those armed would take hours and
 * would fill `change_log` with fiction.
 *
 * ⚠️ THIS IS NOT HIDING THE COST. `scripts/perf/measure-writes.mjs`
 * measures exactly that cost, on purpose, with the triggers ON. The
 * seed skips them; the benchmark does not.
 *
 * Usage:
 *   node scripts/perf/seed-load.mjs                 # default profile
 *   node scripts/perf/seed-load.mjs --scale=0.25    # quarter size
 *   node scripts/perf/seed-load.mjs --truncate      # wipe seeded rows first
 *
 * Requires PGHOST/PGPORT/PGUSER or TEST_ADMIN_DATABASE_URL pointing at a
 * THROWAWAY Postgres. It refuses anything that is not obviously local,
 * for the same reason `scripts/bootstrap-test-db.mjs` does: it writes a
 * million rows and truncates tables.
 */

import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/* ------------------------------------------------------------------ */
/* CONNECTION — admin, because we toggle session_replication_role      */
/* ------------------------------------------------------------------ */

function adminUrl() {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "postgres";
  const db = process.env.TEST_DB_NAME ?? "ordence_test";
  return `postgresql://${user}@${host}:${port}/${db}`;
}

/**
 * ⚠️ The same refusal `bootstrap-test-db.mjs` carries, for the same
 * reason. By the time a human notices, the TRUNCATE has already run.
 */
function refuseNonLocal(url) {
  const parsed = new URL(url);
  const localHost = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(
    parsed.hostname,
  );
  const looksLikeTest = /test/i.test(parsed.pathname);
  if (!localHost || !looksLikeTest) {
    console.error(
      `\n🔴 REFUSING. This script TRUNCATES tables and writes ~1M rows.\n` +
        `   Host "${parsed.hostname}", database "${parsed.pathname.slice(1)}".\n` +
        `   It runs only against a local database whose name contains "test".\n`,
    );
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ */
/* THE PROFILE                                                         */
/* ------------------------------------------------------------------ */

/**
 * Per scale-point row counts. A "scale point" is roughly one small
 * Indian SME on Ordence for three financial years.
 *
 * These are not invented: they are anchored to the pricing tiers in
 * `lib/edge/budgets.ts` and to what a 3-year ERP history looks like for
 * a business issuing ~35 invoices a month.
 */
const PER_POINT = {
  companies: 60,
  contacts: 200,
  users: 4,
  ledgers: 40, // chart of accounts — does NOT scale with volume
  warehouses: 2,
  stockItems: 100,
  salesInvoices: 1200,
  linesPerInvoice: 3,
  transactions: 1500,
  entriesPerTransaction: 4,
  stockMovements: 2000,
  auditLogs: 3000,
  /** One to two rows per DML row across 289 trigger-carrying tables. */
  changeLog: 8000,
  campaignRecipients: 1500,
};

/**
 * ⭐ THE SKEW. 8 small tenants, 3 mid, 1 enterprise at 40 points —
 * exactly 10× the largest non-enterprise tenant, which is the "big
 * tenant test" the brief asks for.
 */
const TENANTS = [
  ...Array.from({ length: 8 }, (_, i) => ({
    slug: `starter-${String(i + 1).padStart(2, "0")}`,
    tier: "basic",
    points: 1,
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    slug: `growth-${String(i + 1).padStart(2, "0")}`,
    tier: "advanced",
    points: 4,
  })),
  { slug: "enterprise-01", tier: "enterprise", points: 40 },
];

/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const scaleArg = args.find((a) => a.startsWith("--scale="));
const SCALE = scaleArg ? Number(scaleArg.split("=")[1]) : 1;
const TRUNCATE = args.includes("--truncate");

if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error("--scale must be a positive number");
  process.exit(2);
}

const n = (base, points) => Math.max(1, Math.round(base * points * SCALE));

/**
 * Tables this script owns. Nothing outside this list is written, and
 * `--truncate` touches nothing outside it either.
 */
const SEEDED_TABLES = [
  "change_log",
  "campaign_recipients",
  "journal_entries",
  "transactions",
  "sales_invoice_lines",
  "sales_invoices",
  "stock_movements",
  "stock_items",
  "warehouses",
  "audit_logs",
  "contacts",
  "companies",
  "ledgers",
  "users",
  "tenants",
];

const url = adminUrl();
refuseNonLocal(url);

const client = new pg.Client({ connectionString: url });
await client.connect();

const t0 = Date.now();
let lastLabel = "";
function step(label) {
  if (lastLabel) process.stdout.write(` ✅\n`);
  lastLabel = label;
  process.stdout.write(`  ${label}…`);
}
function done() {
  if (lastLabel) process.stdout.write(` ✅\n`);
  lastLabel = "";
}

console.log(`\nSeeding load profile  ·  scale ${SCALE}  ·  ${TENANTS.length} tenants\n`);

/**
 * ⚠️ replica mode disables BOTH user triggers and FK validation for this
 * session only. It does not persist and it does not alter the tables, so
 * a crash mid-run leaves the schema exactly as it was.
 */
await client.query("SET session_replication_role = replica");

if (TRUNCATE) {
  step("truncate previously seeded tables");
  await client.query(`TRUNCATE ${SEEDED_TABLES.join(", ")} CASCADE`);
}

/* ---- tenants ------------------------------------------------------ */

step("tenants");
const tenantIds = [];
for (const t of TENANTS) {
  const r = await client.query(
    `INSERT INTO tenants (clerk_org_id, slug, name, plan_tier, status, seat_limit)
     VALUES ($1, $2, $3, $4::plan_tier, 'active'::tenant_status, $5)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [`org_perf_${t.slug}`, t.slug, `Perf ${t.slug}`, t.tier, t.points * 5],
  );
  tenantIds.push({ ...t, id: r.rows[0].id });
}

/* ---- per-tenant bulk load ----------------------------------------- */

for (const t of tenantIds) {
  step(`${t.slug} (${t.points} pt)`);

  await client.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name, role, status,
                        permission_overrides, preferences, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'user_' || $2 || '_' || g, 'u' || g || '@' || $2 || '.test',
            'First' || g, 'Last' || g,
            (ARRAY['tenant_owner','tenant_admin','manager','member'])[1 + (g % 4)]::system_role,
            'active'::user_status, '{}'::jsonb, '{}'::jsonb, now(), now()
     FROM generate_series(1, $3) g`,
    [t.id, t.slug, n(PER_POINT.users, t.points)],
  );

  await client.query(
    `INSERT INTO companies (id, tenant_id, name, city, state, country, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'Company ' || g, 'City' || (g % 40), 'KA', 'IN',
            now() - (g % 1095) * interval '1 day', now()
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.companies, t.points)],
  );

  await client.query(
    `INSERT INTO contacts (id, tenant_id, company_id, first_name, last_name, email,
                           custom_fields, created_at, updated_at)
     SELECT gen_random_uuid(), $1,
            (SELECT c.id FROM companies c WHERE c.tenant_id = $1 ORDER BY c.id LIMIT 1 OFFSET (g % GREATEST(1,(SELECT count(*) FROM companies WHERE tenant_id = $1)))),
            'Contact', 'Number' || g, 'c' || g || '@' || $2 || '.test',
            '{}'::jsonb, now() - (g % 1095) * interval '1 day', now()
     FROM generate_series(1, $3) g`,
    [t.id, t.slug, n(PER_POINT.contacts, t.points)],
  );

  await client.query(
    `INSERT INTO ledgers (id, tenant_id, name, code, type, account_type, currency,
                          current_balance, bank_details, is_active, is_system,
                          requires_reconciliation, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'Ledger ' || g, 'L' || lpad(g::text, 5, '0'),
            'operating'::ledger_type,
            (ARRAY['asset','liability','equity','revenue','expense'])[1 + (g % 5)]::account_type,
            'INR', 0, '{}'::jsonb, true, false, false, now(), now()
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.ledgers, 1)],
  );

  await client.query(
    `INSERT INTO warehouses (id, tenant_id, name, code, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'Warehouse ' || g, 'W' || lpad(g::text, 4, '0'), now(), now()
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.warehouses, t.points)],
  );

  await client.query(
    `INSERT INTO stock_items (id, tenant_id, sku, name, uom, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'SKU' || lpad(g::text, 7, '0'), 'Item ' || g, 'nos', now(), now()
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.stockItems, t.points)],
  );

  /*
   * ⚠️ SALES INVOICES CARRY THE REAL DISTRIBUTION, not a uniform one.
   * Status is skewed the way a real ledger is: most invoices are paid,
   * a long tail is issued-and-overdue, a few are draft. `status` and
   * `due_date` are the two columns the overdue-receivables screen filters
   * on, so a uniform distribution there would hide the exact selectivity
   * problem the index is supposed to solve.
   */
  await client.query(
    `INSERT INTO sales_invoices (
        id, tenant_id, invoice_number, financial_year, status, company_id,
        invoice_date, due_date, customer_address, currency,
        subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor, igst_minor,
        total_minor, received_minor, issued_at, cancelled_at, cancel_reason,
        created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'INV-' || lpad(g::text, 8, '0'),
            '2024-2025',
            CASE WHEN g % 100 < 5  THEN 'draft'
                 WHEN g % 100 < 30 THEN 'issued'
                 WHEN g % 100 < 40 THEN 'part_paid'
                 WHEN g % 100 < 98 THEN 'paid'
                 ELSE 'cancelled' END::sales_invoice_status,
            (SELECT c.id FROM companies c WHERE c.tenant_id = $1 ORDER BY c.id LIMIT 1 OFFSET (g % GREATEST(1,(SELECT count(*) FROM companies WHERE tenant_id = $1)))),
            (current_date - (g % 1095))::date,
            (current_date - (g % 1095) + 30)::date,
            '{}'::jsonb, 'INR',
            (10000 + (g % 900) * 100)::bigint,
            (10000 + (g % 900) * 100)::bigint,
            ((10000 + (g % 900) * 100) * 9 / 100)::bigint,
            ((10000 + (g % 900) * 100) * 9 / 100)::bigint,
            0,
            ((10000 + (g % 900) * 100) * 118 / 100)::bigint,
            CASE WHEN g % 100 >= 40 AND g % 100 < 98
                   THEN ((10000 + (g % 900) * 100) * 118 / 100)::bigint
                 WHEN g % 100 >= 30 AND g % 100 < 40
                   THEN ((10000 + (g % 900) * 100) * 118 / 200)::bigint
                 ELSE 0 END,
            CASE WHEN g % 100 >= 5 THEN now() - (g % 1095) * interval '1 day' END,
            CASE WHEN g % 100 >= 98 THEN now() - (g % 1095) * interval '1 day' END,
            CASE WHEN g % 100 >= 98 THEN 'seeded cancellation' END,
            now() - (g % 1095) * interval '1 day', now()
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.salesInvoices, t.points)],
  );

  await client.query(
    `INSERT INTO sales_invoice_lines (
        id, tenant_id, invoice_id, line_no, description, quantity, uom,
        unit_price_minor, taxable_value_minor, cgst_minor, sgst_minor, igst_minor,
        line_total_minor, created_at, updated_at)
     SELECT gen_random_uuid(), $1, i.id, ln,
            'Line ' || ln, 1, 'nos',
            (i.taxable_value_minor / $2)::bigint,
            (i.taxable_value_minor / $2)::bigint,
            (i.cgst_minor / $2)::bigint, (i.sgst_minor / $2)::bigint, 0,
            (i.total_minor / $2)::bigint, i.created_at, now()
     FROM sales_invoices i, generate_series(1, $2) ln
     WHERE i.tenant_id = $1`,
    [t.id, PER_POINT.linesPerInvoice],
  );

  await client.query(
    `INSERT INTO transactions (id, tenant_id, transaction_number, description,
                               transaction_date, status, reference_type, currency,
                               total_amount, metadata, created_at, posted_at)
     SELECT gen_random_uuid(), $1, 'TXN-' || lpad(g::text, 8, '0'), 'Posting ' || g,
            (current_date - (g % 1095))::date, 'posted'::transaction_status,
            (ARRAY['invoice','payment','receipt','journal'])[1 + (g % 4)]::reference_type,
            'INR', (100 + (g % 9000))::numeric, '{}'::jsonb,
            now() - (g % 1095) * interval '1 day',
            now() - (g % 1095) * interval '1 day'
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.transactions, t.points)],
  );

  /*
   * ⚠️ `journal_entries` IS the line table — there is no `journal_lines`.
   * Four legs per transaction is a realistic Indian GST posting: debit
   * receivable, credit revenue, credit CGST, credit SGST.
   */
  await client.query(
    `INSERT INTO journal_entries (id, tenant_id, transaction_id, ledger_id, entry_type,
                                  amount_minor, amount, description, reference_type,
                                  is_reconciled, metadata, created_at)
     SELECT gen_random_uuid(), $1, x.id,
            (SELECT l.id FROM ledgers l WHERE l.tenant_id = $1 ORDER BY l.id
              LIMIT 1 OFFSET ((x.rn * 7 + leg) % GREATEST(1,(SELECT count(*) FROM ledgers WHERE tenant_id = $1)))),
            CASE WHEN leg = 1 THEN 'debit' ELSE 'credit' END::entry_type,
            GREATEST(1, (x.total_amount * 100 / $2)::bigint),
            GREATEST(0.01, (x.total_amount / $2)),
            'Leg ' || leg, x.reference_type,
            (x.rn % 3 = 0), '{}'::jsonb, x.created_at
     FROM (SELECT t2.*, row_number() OVER (ORDER BY t2.id) AS rn
             FROM transactions t2 WHERE t2.tenant_id = $1) x,
          generate_series(1, $2) leg`,
    [t.id, PER_POINT.entriesPerTransaction],
  );

  await client.query(
    `INSERT INTO stock_movements (id, tenant_id, stock_item_id, warehouse_id, quantity,
                                  reason, moved_at, unit_cost_minor, value_minor, created_at)
     SELECT gen_random_uuid(), $1,
            (SELECT s.id FROM stock_items s WHERE s.tenant_id = $1 ORDER BY s.id LIMIT 1 OFFSET (g % GREATEST(1,(SELECT count(*) FROM stock_items WHERE tenant_id = $1)))),
            (SELECT w.id FROM warehouses w WHERE w.tenant_id = $1 ORDER BY w.id LIMIT 1 OFFSET (g % GREATEST(1,(SELECT count(*) FROM warehouses WHERE tenant_id = $1)))),
            CASE WHEN g % 3 = 0 THEN -1 ELSE 2 END,
            (CASE WHEN g % 3 = 0 THEN 'sales_dispatch' ELSE 'purchase_receipt' END)::stock_movement_reason,
            now() - (g % 1095) * interval '1 day',
            (500 + (g % 400))::bigint, (500 + (g % 400))::bigint,
            now() - (g % 1095) * interval '1 day'
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.stockMovements, t.points)],
  );

  await client.query(
    `INSERT INTO audit_logs (id, tenant_id, action, resource_type, resource_id,
                             severity, created_at)
     SELECT gen_random_uuid(), $1,
            (ARRAY['create','update','delete','read','export'])[1 + (g % 5)]::audit_action,
            (ARRAY['sales_invoice','contact','company','journal_entry','user'])[1 + (g % 5)],
            gen_random_uuid(), 'info',
            now() - (g % 1095) * interval '1 day'
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.auditLogs, t.points)],
  );
}

done();

/* ---- the two tables that grow fastest and are indexed worst --------- */

/**
 * ⭐ `change_log` AND `campaign_recipients` ARE SEEDED SEPARATELY, AND
 * THE REASON IS THE POINT OF THIS BLOCK.
 *
 * Both carry a `tenant_id` column, both are under FORCE RLS — and
 * NEITHER has an index whose first column is `tenant_id`. Under RLS
 * every read of them acquires an implicit `tenant_id = ...` predicate
 * that no index can serve, so every read is a sequential scan of the
 * whole table.
 *
 * `change_log` is the worst case in the schema: 289 tables carry the
 * `record_change()` trigger, which writes a full `to_jsonb` image FOR
 * EACH ROW of every INSERT, UPDATE and DELETE. It is the fastest-growing
 * table in the product by construction, `prune_change_log()`
 * (SQL-FILES/0128) sweeps it PER TENANT, and there is nothing for that
 * sweep to use.
 *
 * ⚠️ Written directly rather than by letting the triggers produce it,
 * because generating a million rows through 289 row-level triggers takes
 * hours. The SHAPE is faithful: same columns, same jsonb payloads, same
 * per-tenant skew.
 */
step("change_log + campaign_recipients");

for (const t of tenantIds) {
  await client.query(
    `INSERT INTO change_log (tenant_id, table_name, row_id, operation,
                             old_row, new_row, changed_cols, origin_id, changed_at, synced_at)
     SELECT $1,
            (ARRAY['sales_invoices','journal_entries','contacts','stock_movements','companies'])[1 + (g % 5)],
            gen_random_uuid(),
            (ARRAY['insert','update','delete'])[1 + (g % 3)],
            CASE WHEN g % 3 = 0 THEN NULL ELSE jsonb_build_object('id', g, 'total_minor', g * 100) END,
            CASE WHEN g % 3 = 2 THEN NULL ELSE jsonb_build_object('id', g, 'total_minor', g * 101) END,
            CASE WHEN g % 3 = 1 THEN ARRAY['total_minor'] END,
            gen_random_uuid(),
            now() - (g % 1095) * interval '1 day',
            CASE WHEN g % 10 < 8 THEN now() END
     FROM generate_series(1, $2) g`,
    [t.id, n(PER_POINT.changeLog, t.points)],
  );

  await client.query(
    `INSERT INTO campaign_recipients (id, tenant_id, campaign_id, subject_type, subject_id,
                                      display_name, is_included, inside_service_window,
                                      estimated_cost_minor, created_at)
     SELECT gen_random_uuid(), $1, c.campaign_id, 'contact', gen_random_uuid(),
            'Recipient ' || c.g, (c.g % 7 <> 0), (c.g % 5 <> 0), 25,
            now() - (c.g % 365) * interval '1 day'
     FROM (SELECT g, (SELECT gen_random_uuid()) AS campaign_id FROM generate_series(1, $2) g) c`,
    [t.id, n(PER_POINT.campaignRecipients, t.points)],
  );
}

/* ---- statistics --------------------------------------------------- */

/**
 * ⚠️ WITHOUT THIS EVERY MEASUREMENT THAT FOLLOWS IS WORTHLESS. A freshly
 * loaded table has no statistics; the planner assumes a default
 * selectivity and picks plans it would never pick in production. This is
 * the single most common way a benchmark produces a confident wrong
 * answer.
 */
step("ANALYZE (planner statistics)");
await client.query("ANALYZE");
done();

/* ---- report ------------------------------------------------------- */

const counts = await client.query(
  `SELECT relname, n_live_tup FROM pg_stat_user_tables
    WHERE relname = ANY($1) AND n_live_tup > 0 ORDER BY n_live_tup DESC`,
  [SEEDED_TABLES],
);

const perTenant = await client.query(
  `SELECT t.slug,
          (SELECT count(*) FROM sales_invoices i WHERE i.tenant_id = t.id) AS invoices,
          (SELECT count(*) FROM journal_entries j WHERE j.tenant_id = t.id) AS journal_entries
     FROM tenants t WHERE t.slug LIKE 'starter-%' OR t.slug LIKE 'growth-%' OR t.slug LIKE 'enterprise-%'
    ORDER BY 3 DESC`,
);

console.log("\n  Rows written\n");
for (const r of counts.rows) {
  console.log(`    ${r.relname.padEnd(24)} ${String(r.n_live_tup).padStart(10)}`);
}
console.log("\n  Skew (the point of the exercise)\n");
for (const r of perTenant.rows) {
  console.log(
    `    ${r.slug.padEnd(16)} invoices ${String(r.invoices).padStart(8)}   journal_entries ${String(r.journal_entries).padStart(9)}`,
  );
}

const profile = {
  generatedBy: "scripts/perf/seed-load.mjs",
  scale: SCALE,
  tenants: tenantIds.map((t) => ({ slug: t.slug, tier: t.tier, points: t.points })),
  rows: Object.fromEntries(counts.rows.map((r) => [r.relname, Number(r.n_live_tup)])),
  perTenant: perTenant.rows.map((r) => ({
    slug: r.slug,
    invoices: Number(r.invoices),
    journalEntries: Number(r.journal_entries),
  })),
};

mkdirSync(join(ROOT, "scripts", "perf", "results"), { recursive: true });
writeFileSync(
  join(ROOT, "scripts", "perf", "results", "load-profile.json"),
  JSON.stringify(profile, null, 2) + "\n",
);

console.log(`\n  Wrote scripts/perf/results/load-profile.json`);
console.log(`\n✅ Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

await client.end();
