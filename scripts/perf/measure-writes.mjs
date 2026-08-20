#!/usr/bin/env node
/**
 * Ordence — Track F · WHAT A WRITE ACTUALLY COSTS
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE HALF OF PERFORMANCE WORK THAT GETS SKIPPED
 * ══════════════════════════════════════════════════════════════════════
 * Index work is almost always presented as free: a read got faster, ship
 * it. It is not free. Every index is another B-tree page written on every
 * INSERT and on every UPDATE that touches its columns. This repository
 * carries 1,499 indexes across 319 tables and 979 non-internal triggers,
 * 289 of them the `record_change()` change-log trigger which writes a
 * FULL `to_jsonb` image of the row into `change_log` FOR EACH ROW.
 *
 * Nobody has measured what that costs. So a proposal to add an index has
 * had no denominator, and a proposal to remove 102 redundant ones has
 * had no numerator.
 *
 * This measures four write configurations against the same INSERT:
 *
 *   A. as production runs today            — every trigger, every index
 *   B. without the change-log trigger      — isolates trigger cost
 *   C. without the redundant bare indexes  — isolates the saving
 *   D. bare table                          — the floor
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERYTHING HAPPENS INSIDE A TRANSACTION THAT IS ROLLED BACK
 * ══════════════════════════════════════════════════════════════════════
 * `ALTER TABLE ... DISABLE TRIGGER` and `DROP INDEX` are transactional in
 * PostgreSQL. The whole experiment therefore reverses itself, including
 * on a crash. The script asserts afterwards that the index and trigger
 * counts are unchanged, because "it should have rolled back" is exactly
 * the kind of assumption this codebase punishes.
 *
 * Usage: node scripts/perf/measure-writes.mjs [--rows=2000]
 */

import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

const ROWS = Number(process.argv.find((a) => a.startsWith("--rows="))?.slice(7) ?? 2000);
const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";

if (!["localhost", "127.0.0.1", "::1"].includes(HOST) || !/test/i.test(DB)) {
  console.error(`\n🔴 REFUSING: ${HOST}/${DB} is not obviously a throwaway database.\n`);
  process.exit(2);
}

const db = new pg.Client({
  connectionString: `postgresql://${process.env.PGUSER ?? "postgres"}@${HOST}:${PORT}/${DB}`,
});
await db.connect();

const tenantId = (await db.query(`SELECT id FROM tenants WHERE slug='enterprise-01'`)).rows[0]?.id;
const companyId = (
  await db.query(`SELECT id FROM companies WHERE tenant_id=$1 LIMIT 1`, [tenantId])
).rows[0]?.id;
const transactionId = (
  await db.query(`SELECT id FROM transactions WHERE tenant_id=$1 LIMIT 1`, [tenantId])
).rows[0]?.id;
const ledgerId = (await db.query(`SELECT id FROM ledgers WHERE tenant_id=$1 LIMIT 1`, [tenantId]))
  .rows[0]?.id;

if (!tenantId || !companyId || !transactionId || !ledgerId) {
  console.error(`\n🔴 No seeded corpus. Run scripts/perf/seed-load.mjs first.\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */

const indexCountBefore = (
  await db.query(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public'`)
).rows[0].n;
const triggerCountBefore = (
  await db.query(
    `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND NOT t.tgisinternal`,
  )
).rows[0].n;

/**
 * The redundant set, computed from the catalogue rather than listed:
 * a non-unique, non-partial index on `(tenant_id)` alone, on a table that
 * already has a non-partial index whose first key column is `tenant_id`
 * and which is wider. By the B-tree prefix rule the wide index serves
 * every query the narrow one could.
 */
const REDUNDANT_SQL = `
  WITH ix AS (
    SELECT c.oid, c.relname AS tbl, ic.relname AS idx, i.indisunique,
           i.indpred IS NOT NULL AS partial, i.indnkeyatts AS ncols,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum = i.indkey[0]) AS col1
      FROM pg_index i
      JOIN pg_class c  ON c.oid  = i.indrelid
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  )
  SELECT a.tbl, a.idx
    FROM ix a
   WHERE a.col1 = 'tenant_id' AND a.ncols = 1
     AND NOT a.partial AND NOT a.indisunique
     AND EXISTS (SELECT 1 FROM ix b
                  WHERE b.oid = a.oid AND b.col1 = 'tenant_id'
                    AND b.ncols > 1 AND NOT b.partial)`;

const redundant = (await db.query(REDUNDANT_SQL)).rows;

console.log(
  `\nWrite cost  ·  ${ROWS} INSERTs per scenario  ·  ` +
    `${indexCountBefore} indexes, ${triggerCountBefore} triggers in the schema\n`,
);

const TARGETS = {
  sales_invoices: {
    sql: `
      INSERT INTO sales_invoices (
          tenant_id, invoice_number, financial_year, status, company_id,
          invoice_date, due_date, customer_address, currency,
          subtotal_minor, taxable_value_minor, cgst_minor, sgst_minor,
          total_minor, received_minor, issued_at, created_at, updated_at)
      SELECT $1, 'PERF-' || $3 || '-' || g, '2024-2025', 'issued', $2,
             current_date, current_date + 30, '{}'::jsonb, 'INR',
             10000, 10000, 900, 900, 11800, 0, now(), now(), now()
        FROM generate_series(1, $4) g`,
    trigger: "sales_invoices_change_log",
    // $1 tenant, $2 company, $3 label, $4 rows — the ledger id is unused here.
    params: (ids, label) => [ids.tenantId, ids.companyId, label, ROWS],
  },
  /**
   * ⭐ `journal_entries` IS THE ONE THAT MATTERS. It is the line table for
   * every posting — four rows per transaction in a normal Indian GST
   * entry — it carries 9 indexes, and one of them
   * (`journal_entries_tenant_idx`) is a bare `(tenant_id)` index made
   * redundant by `journal_entries_ledger_idx (tenant_id, ledger_id,
   * created_at)`. It is therefore the table where the index tax and the
   * trigger tax are both largest and both measurable.
   */
  journal_entries: {
    sql: `
      INSERT INTO journal_entries (
          tenant_id, transaction_id, ledger_id, entry_type,
          amount_minor, amount, description, reference_type, metadata, created_at)
      SELECT $1, $2, $5, 'debit'::entry_type,
             1000, 10.00, 'perf ' || $3 || ' ' || g, 'journal'::reference_type,
             '{}'::jsonb, now()
        FROM generate_series(1, $4) g`,
    trigger: "journal_entries_change_log",
    // $1 tenant, $2 transaction, $3 label, $4 rows, $5 ledger.
    params: (ids, label) => [ids.tenantId, ids.transactionId, label, ROWS, ids.ledgerId],
  },
};

async function scenario(table, label, setup) {
  await db.query("BEGIN");
  try {
    const changeLogBefore = Number(
      (await db.query(`SELECT count(*)::bigint n FROM change_log`)).rows[0].n,
    );
    if (setup) await db.query(setup);
    const t = process.hrtime.bigint();
    await db.query(
      TARGETS[table].sql,
      TARGETS[table].params({ tenantId, companyId, transactionId, ledgerId }, label.replace(/\W/g, "")),
    );
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const changeLogAfter = Number(
      (await db.query(`SELECT count(*)::bigint n FROM change_log`)).rows[0].n,
    );
    return { table, label, ms, perRowMs: ms / ROWS, changeLogRows: changeLogAfter - changeLogBefore };
  } finally {
    // ⚠️ ALWAYS. The DDL above is transactional; this is what undoes it.
    await db.query("ROLLBACK");
  }
}

const results = [];

for (const table of Object.keys(TARGETS)) {
  const bare = redundant.filter((r) => r.tbl === table);
  console.log(`  ── ${table} ──`);

  const rows = [];
  rows.push(await scenario(table, "A · production shape", null));
  rows.push(
    await scenario(
      table,
      "B · change-log trigger off",
      `ALTER TABLE ${table} DISABLE TRIGGER ${TARGETS[table].trigger}`,
    ),
  );
  if (bare.length > 0) {
    rows.push(
      await scenario(
        table,
        `C · ${bare.length} redundant bare index dropped`,
        bare.map((r) => `DROP INDEX ${r.idx}`).join("; "),
      ),
    );
  } else {
    console.log(`     (no redundant bare (tenant_id) index on this table — scenario C skipped)`);
  }
  rows.push(await scenario(table, "D · all user triggers off", `ALTER TABLE ${table} DISABLE TRIGGER USER`));

  const base = rows[0];
  for (const r of rows) {
    const delta = r === base ? "" : `  ${(((base.ms - r.ms) / base.ms) * 100).toFixed(1)}% cheaper`;
    console.log(
      `     ${r.label.padEnd(36)} ${r.ms.toFixed(1).padStart(8)} ms` +
        `  ${(r.perRowMs * 1000).toFixed(0).padStart(5)} µs/row` +
        `  change_log +${String(r.changeLogRows).padStart(6)}${delta}`,
    );
  }
  results.push(...rows);
  console.log("");
}

/* ------------------------------------------------------------------ */
/* ⚠️ ASSERT THE ROLLBACK ACTUALLY HAPPENED                            */
/* ------------------------------------------------------------------ */

const indexCountAfter = (
  await db.query(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public'`)
).rows[0].n;
const triggerCountAfter = (
  await db.query(
    `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND NOT t.tgisinternal`,
  )
).rows[0].n;
const enabled = (
  await db.query(
    `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relname='sales_invoices' AND NOT t.tgisinternal AND t.tgenabled <> 'O'`,
  )
).rows[0].n;

if (indexCountAfter !== indexCountBefore || triggerCountAfter !== triggerCountBefore || enabled > 0) {
  console.error(
    `\n🔴 THE DATABASE DID NOT RETURN TO ITS ORIGINAL STATE.\n` +
      `   indexes ${indexCountBefore} → ${indexCountAfter}, triggers ${triggerCountBefore} → ${triggerCountAfter},` +
      ` ${enabled} disabled trigger(s) on sales_invoices.\n` +
      `   Re-bootstrap before trusting anything measured after this point.\n`,
  );
  process.exitCode = 1;
} else {
  console.log(`\n  ✅ schema restored: ${indexCountAfter} indexes, ${triggerCountAfter} triggers.`);
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, "write-cost.json"),
  JSON.stringify(
    {
      rows: ROWS,
      indexes: indexCountBefore,
      triggers: triggerCountBefore,
      redundantBareTenantIndexes: redundant.length,
      redundantByTable: redundant.reduce((acc, r) => {
        (acc[r.tbl] ??= []).push(r.idx);
        return acc;
      }, {}),
      scenarios: results.map((r) => ({
        table: r.table,
        label: r.label,
        totalMs: Number(r.ms.toFixed(2)),
        perRowUs: Number((r.perRowMs * 1000).toFixed(1)),
        changeLogRowsWritten: r.changeLogRows,
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(`  Wrote scripts/perf/results/write-cost.json\n`);

await db.end();
