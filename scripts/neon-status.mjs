#!/usr/bin/env node
/**
 * Ordence — What is actually applied to this database?
 * Version: v0.84.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS ANSWERS
 * ══════════════════════════════════════════════════════════════════════
 * "Which SQL files have I already run, and which do I still need to?"
 *
 * `SQL-FILES/` has no migration ledger — there is no `_migrations` table
 * recording what ran. Files are applied by hand in the Neon console or by
 * a glob in CI. So the only way to know the true state is to ask the
 * database what exists.
 *
 * This script does that: it reads every `CREATE TABLE` out of every
 * numbered file, checks which of those tables are present, and reports
 * each migration as APPLIED, PARTIAL or MISSING.
 *
 *     DATABASE_URL="postgres://…" node scripts/neon-status.mjs
 *
 * ⚠️ READ-ONLY. It issues no DDL and writes nothing. Safe against
 * production — which is the point, because guessing is not.
 *
 * ⚠️ PARTIAL IS THE INTERESTING RESULT. It means a file was applied and
 * failed part-way, or a later `drizzle-kit push` dropped something. Both
 * leave a database that no single file describes.
 */

import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!URL) {
  console.error("Set DATABASE_URL to the database you want to inspect.");
  console.error('  DATABASE_URL="postgres://user:pass@host/db" node scripts/neon-status.mjs');
  process.exit(1);
}

const DIR = "SQL-FILES";
const files = readdirSync(DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

/** Every table a file creates. */
function tablesIn(sql) {
  const out = new Set();
  for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?["']?(\w+)["']?/gi)) {
    out.add(m[1].toLowerCase());
  }
  // The `DO $$ … EXECUTE format('CREATE TABLE %I' …)` loops cannot be read
  // statically. Files using them will under-report, never over-report.
  return [...out];
}

const pool = new Pool({ connectionString: URL });

try {
  const { rows: present } = await pool.query(
    `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public'`,
  );
  const have = new Map(present.map((r) => [r.tablename, r.rowsecurity]));

  const { rows: polCount } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`,
  );

  console.log("═".repeat(72));
  console.log(`  ORDENCE — DATABASE STATE`);
  console.log(`  ${present.length} tables · ${present.filter((r) => r.rowsecurity).length} with RLS · ${polCount[0].n} policies`);
  console.log("═".repeat(72));

  const todo = [];
  let applied = 0;

  for (const f of files) {
    const declared = tablesIn(readFileSync(join(DIR, f), "utf8"));
    if (declared.length === 0) {
      console.log(`  ?  ${f}  (creates no tables — cannot infer; re-running is safe if idempotent)`);
      continue;
    }
    const found = declared.filter((t) => have.has(t));
    const missing = declared.filter((t) => !have.has(t));
    const noRls = found.filter((t) => have.get(t) === false);

    if (missing.length === 0) {
      applied++;
      const warn = noRls.length ? `  ⚠️ no RLS on: ${noRls.join(", ")}` : "";
      console.log(`  ✅ ${f}${warn}`);
      if (noRls.length) todo.push(`${f} — tables exist but RLS is OFF; re-run it`);
    } else if (found.length === 0) {
      console.log(`  ❌ ${f}  MISSING (${declared.length} tables absent)`);
      todo.push(`${f} — not applied`);
    } else {
      console.log(`  ⚠️  ${f}  PARTIAL — missing: ${missing.join(", ")}`);
      todo.push(`${f} — PARTIAL, missing ${missing.join(", ")}`);
    }
  }

  console.log("═".repeat(72));
  console.log(`  ${applied}/${files.length} migrations look fully applied.`);

  if (todo.length) {
    console.log("\n  STILL TO RUN, in this order:\n");
    for (const t of todo) console.log(`    • ${t}`);
    console.log(
      "\n  Apply with:\n" +
        "    psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f SQL-FILES/<file>\n" +
        "  or paste into the Neon SQL editor, one file at a time, in numeric order.\n",
    );
  } else {
    console.log("\n  ✅ Nothing outstanding.\n");
  }

  console.log("  Then verify:  npm run db:verify  &&  npm run check:rls\n");
} finally {
  await pool.end();
}
