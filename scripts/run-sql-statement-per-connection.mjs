#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ RUN A MIGRATION THE WAY IT IS ACTUALLY USED
 * Added by Batch 0108.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * Every numbered file in SQL-FILES/ is pasted into the Neon browser
 * console, WHICH SENDS EACH STATEMENT ON ITS OWN CONNECTION. That single
 * fact has cost this project more time than everything else combined, and
 * the reason it keeps costing is that nothing reproduced it.
 *
 * ⚠️ `psql -f file.sql` DOES NOT REPRODUCE IT. psql sends the whole file
 * on ONE connection, inside one session, so a transaction-local setting
 * survives from statement to statement and a failure part-way leaves a
 * different state than the console would. Testing a file the way it is
 * NOT used proves nothing about the way it IS used.
 *
 * This script opens a NEW CONNECTION PER STATEMENT, as a role you name,
 * and reports each one independently — success, failure, SQLSTATE, rows
 * and NOTICEs. That is the console, near enough to catch what matters.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT CAUGHT IN THE BATCH THAT ADDED IT
 * ══════════════════════════════════════════════════════════════════════
 * Three defects in 0108, none of which was visible by reading the file:
 *
 *   1. `ALTER TABLE ... ENABLE TRIGGER` fails with "cannot ALTER TABLE
 *      because it has pending trigger events" when a DEFERRABLE CONSTRAINT
 *      TRIGGER fired earlier in the same transaction. The re-enable — the
 *      one statement that must not fail — was the statement that failed.
 *
 *   2. A `RETURNS TABLE(... bigint)` function whose body does `sum()`
 *      raises `42804 structure of query does not match function result
 *      type` at CALL time, not at CREATE time. It created cleanly and
 *      every call failed.
 *
 *   3. `SELECT count(*) FROM journal_entries` returns 0 for the TABLE
 *      OWNER, because the table is FORCE ROW LEVEL SECURITY with no
 *      platform-scope clause. Only a superuser sees the rows. The
 *      diagnostic reported "0 legs" about a populated table.
 *
 * 🔴 RUN IT AS A NON-SUPERUSER. A drill run as `postgres` passes every
 * refusal test and proves nothing; item 3 above is invisible to one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * USAGE — AGAINST A THROWAWAY POSTGRES, NEVER NEON
 * ══════════════════════════════════════════════════════════════════════
 *   PGHOST=/tmp PGPORT=5433 PGDATABASE=ordence_sbx \
 *     node scripts/run-sql-statement-per-connection.mjs \
 *       SQL-FILES/0108_journal_entries_minor_units.sql ordence_owner
 *
 * ⚠️ IT REFUSES A DATABASE NAME THAT LOOKS REAL, for the same reason the
 * DRILL-DO-NOT-RUN-IN-NEON-####.sql files carry a step 0.
 */

import { readFileSync } from "node:fs";
import { splitStatements } from "./lib/sql-statements.mjs";
import pg from "pg";

const file = process.argv[2];
const user = process.argv[3] ?? process.env.PGUSER ?? "postgres";
const database = process.env.PGDATABASE ?? "ordence_sbx";
const host = process.env.PGHOST ?? "/tmp";
const port = Number(process.env.PGPORT ?? 5433);

if (!file) {
  console.error("usage: node scripts/run-sql-statement-per-connection.mjs <file.sql> [role]");
  process.exit(2);
}

/**
 * 🔴 STEP 0. A name that looks like production stops the run. This script
 * disables triggers and runs backfills; pointing it at a real database
 * would be the most expensive mistake available in this repo.
 */
if (/neon|prod|ordence_live|main|railway/i.test(`${database} ${host}`)) {
  console.error(
    `\n⛔ REFUSING TO RUN.\n   database="${database}" host="${host}" looks like a real deployment.\n` +
      `   This script disables triggers and executes backfills. Point it at a throwaway\n` +
      `   PostgreSQL only.\n`,
  );
  process.exit(3);
}

const statements = splitStatements(readFileSync(file, "utf8"));
console.log(`${file}`);
console.log(`${statements.length} statements, each on its own connection, as ${user}@${database}\n`);

let failures = 0;
for (const [n, stmt] of statements.entries()) {
  const client = new pg.Client({ host, port, user, database });
  const label = stmt.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().slice(0, 76);
  const notices = [];
  await client.connect();
  client.on("notice", (m) => notices.push(m.message));
  try {
    const res = await client.query(stmt);
    const rows = Array.isArray(res) ? res.flatMap((r) => r.rows ?? []) : (res.rows ?? []);
    console.log(`✅ [${String(n + 1).padStart(2)}] ${label}`);
    for (const note of notices) console.log(`      NOTICE: ${note}`);
    for (const row of rows.slice(0, 8)) console.log(`      ${JSON.stringify(row)}`);
  } catch (err) {
    failures++;
    console.log(`❌ [${String(n + 1).padStart(2)}] ${label}`);
    console.log(`      ${err.code ?? ""} ${err.message}`);
    for (const note of notices) console.log(`      NOTICE: ${note}`);
  } finally {
    await client.end();
  }
}

console.log(`\n${failures === 0 ? "ALL STATEMENTS SUCCEEDED" : `${failures} STATEMENT(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
