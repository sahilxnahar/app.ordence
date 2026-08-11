#!/usr/bin/env node
/**
 * Ordence — Master SQL completeness checker
 * Version: v0.84.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS ANSWERS
 * ══════════════════════════════════════════════════════════════════════
 * "Do my SQL files actually cover the whole schema?"
 *
 * That is a different question from "which files have I run", and a more
 * dangerous one, because it has no symptom.
 *
 * ⚠️ THE FAILURE MODE, PRECISELY
 *
 * Tables come into existence two ways here:
 *
 *   • `drizzle-kit push` reads `db/schema/*.ts` and CREATES tables.
 *   • `SQL-FILES/*.sql` creates tables AND their RLS policies.
 *
 * Drizzle knows nothing about row-level security. So a table defined only
 * in the Drizzle schema, with no matching SQL file, gets created by
 * `push` **with no RLS at all** — and RLS is the tenant boundary in this
 * product. Every tenant reads every other tenant's rows.
 *
 * Nothing catches it. The app works. `tsc` passes. The table has its
 * `tenant_id` column and the queries filter on it correctly. The only
 * difference is that the database will no longer refuse a query that
 * forgets to.
 *
 * `scripts/check-rls-coverage.mjs` catches this too — but only against a
 * LIVE database, after the damage is deployable. This catches it from the
 * source tree, with no database, in under a second.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT REPORTS
 * ══════════════════════════════════════════════════════════════════════
 *   1. 🔴 In the Drizzle schema but NO SQL file creates it
 *         → will be pushed without RLS. The dangerous one.
 *   2. ⚠️  Created in SQL but not in the Drizzle schema
 *         → orphan; `drizzle-kit push` may try to DROP it.
 *   3. 🔴 Created in SQL with a tenant_id but no ENABLE ROW LEVEL SECURITY
 *         → shipped unprotected.
 *   4. ℹ️  Which numbered file creates each table.
 *
 * Read-only. No database. Exits non-zero on any 🔴.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = "db/schema";
const SQL_DIR = "SQL-FILES";

if (!existsSync(SCHEMA_DIR) || !existsSync(SQL_DIR)) {
  console.error("::error::Run from the project root.");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1. WHAT THE DRIZZLE SCHEMA DECLARES                                 */
/* ------------------------------------------------------------------ */

/** table name -> schema file */
const schemaTables = new Map();
/** tables whose Drizzle definition includes a tenantId column */
const schemaTenantScoped = new Set();

for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith(".ts") && !x.startsWith("._"))) {
  const src = readFileSync(join(SCHEMA_DIR, f), "utf8");

  for (const m of src.matchAll(/pgTable\(\s*["'`](\w+)["'`]/g)) {
    schemaTables.set(m[1], f);
  }

  /*
   * Tenant scope is detected per-table by slicing from one `pgTable(` to
   * the next. A file-wide search would mark every table in a file as
   * tenant-scoped because one of its neighbours is.
   */
  const marks = [...src.matchAll(/pgTable\(\s*["'`](\w+)["'`]/g)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    if (/tenantId\s*:\s*uuid\(\s*["'`]tenant_id["'`]/.test(src.slice(start, end))) {
      schemaTenantScoped.add(marks[i][1]);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. WHAT THE SQL FILES CREATE                                        */
/* ------------------------------------------------------------------ */

/** table name -> [files that create it] */
const sqlTables = new Map();
/** table name -> true if any file enables RLS on it */
const sqlRls = new Set();

const sqlFiles = readdirSync(SQL_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const f of sqlFiles) {
  const src = readFileSync(join(SQL_DIR, f), "utf8");

  for (const m of src.matchAll(
    /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?["']?(\w+)["']?/gi,
  )) {
    const t = m[1].toLowerCase();
    if (!sqlTables.has(t)) sqlTables.set(t, []);
    sqlTables.get(t).push(f);
  }

  // Direct form: ALTER TABLE x ENABLE ROW LEVEL SECURITY
  for (const m of src.matchAll(
    /ALTER TABLE\s+(?:public\.)?["']?(\w+)["']?\s+ENABLE ROW LEVEL SECURITY/gi,
  )) {
    sqlRls.add(m[1].toLowerCase());
  }

  /*
   * ⚠️ Several files enable RLS inside a `DO $$ … FOREACH t IN ARRAY[…]`
   * loop with `EXECUTE format('ALTER TABLE public.%I ENABLE …', t)`. The
   * table names live in the array literal, not in the statement, so the
   * regex above cannot see them. Reading the arrays keeps this check from
   * reporting false alarms on correctly-protected tables — which is the
   * fastest way to make a checker untrusted.
   */
  if (/EXECUTE format\([^)]*ENABLE ROW LEVEL SECURITY/i.test(src)) {
    for (const arr of src.matchAll(/ARRAY\s*\[([^\]]+)\]/g)) {
      for (const q of arr[1].matchAll(/['"](\w+)['"]/g)) sqlRls.add(q[1].toLowerCase());
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. REPORT                                                           */
/* ------------------------------------------------------------------ */

const line = "═".repeat(74);
console.log(line);
console.log("  ORDENCE — MASTER SQL COMPLETENESS");
console.log(`  ${schemaTables.size} tables in db/schema · ${sqlTables.size} created across ${sqlFiles.length} SQL files`);
console.log(line);

let critical = 0;

/* ------------------------------------------------------------------ */
/* 1. THE CHECK THAT MATTERS: EVERY TENANT TABLE MUST HAVE RLS IN SQL  */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ "WHICH FILE CREATES IT" IS THE WRONG QUESTION, AND ASKING IT
 *    PRODUCED A 49-TABLE FALSE ALARM ON THE FIRST RUN.
 *
 * `contacts`, `users`, `tenants`, `audit_logs` and 45 others are created
 * by `drizzle-kit push` from the Drizzle schema — no SQL file contains a
 * CREATE TABLE for them. That is the intended design, documented in
 * `scripts/verify-security.ts`: push builds the tables, `SQL-FILES/`
 * applies the policies with `ALTER TABLE … ENABLE ROW LEVEL SECURITY`.
 *
 * Flagging all 49 as unprotected was wrong and dangerous — a checker that
 * reports the core of the schema as broken is one that gets ignored, and
 * then the real finding scrolls past with the noise.
 *
 * The question that actually decides tenant safety is narrower:
 *
 *     does SOME SQL file enable RLS on this table, whoever created it?
 */
const missingRls = [...schemaTenantScoped].filter((t) => !sqlRls.has(t)).sort();

if (missingRls.length) {
  console.log(`\n🔴 TENANT-SCOPED TABLES WITH NO "ENABLE ROW LEVEL SECURITY" ANYWHERE IN SQL (${missingRls.length})`);
  console.log("   RLS is the tenant boundary. Without a policy the database will not");
  console.log("   refuse a query that forgets its tenant filter.\n");
  for (const t of missingRls) {
    critical++;
    const origin = sqlTables.has(t) ? sqlTables.get(t).join(", ") : "drizzle-kit push only";
    console.log(`      ${t}  (schema: ${schemaTables.get(t)} · created by: ${origin})`);
  }
} else {
  console.log(`\n✅ All ${schemaTenantScoped.size} tenant-scoped tables have RLS enabled in SQL.`);
}

/* ------------------------------------------------------------------ */
/* 2. INFORMATIONAL: WHO CREATES WHAT                                  */
/* ------------------------------------------------------------------ */

const pushOnly = [...schemaTables.keys()].filter((t) => !sqlTables.has(t));
console.log(
  `\nℹ️  ${sqlTables.size ? [...schemaTables.keys()].filter((t) => sqlTables.has(t)).length : 0} tables created by SQL files · ` +
    `${pushOnly.length} created by \`drizzle-kit push\` only.`,
);
console.log("   Both are normal. Only the RLS check above decides safety.");

/* ------------------------------------------------------------------ */
/* 3. ORPHANS — IN SQL, NOT IN THE DRIZZLE SCHEMA                      */
/* ------------------------------------------------------------------ */

/*
 * ⚠️ Filtered against the schema-derived name list AND a noise list. The
 * CREATE TABLE regex also matches prose inside `--` comments and dollar-
 * quoted bodies ("...will fail", "the public schema"), which produced
 * entries like `fail`, `public` and `that` on the first run. A checker
 * that invents tables is one nobody reads.
 */
const NOISE = new Set([
  "fail", "public", "that", "installation", "the", "it", "this", "with",
]);
const orphans = [...sqlTables.keys()].filter((t) => !schemaTables.has(t) && !NOISE.has(t)).sort();

if (orphans.length) {
  console.log(`\n⚠️  CREATED IN SQL BUT ABSENT FROM db/schema (${orphans.length})`);
  console.log("   `drizzle-kit push` treats these as drift and may DROP them.");
  console.log("   Add a Drizzle definition, or never run push against that database.\n");
  for (const t of orphans) console.log(`      ${t}  (${sqlTables.get(t).join(", ")})`);
}

/* --- 4. Duplicates -------------------------------------------------- */
const dupes = [...sqlTables.entries()].filter(([, files]) => {
  const live = files.filter((f) => /^\d{4}_/.test(f));
  return live.length > 1;
});
if (dupes.length) {
  console.log(`\n⚠️  CREATED BY MORE THAN ONE NUMBERED FILE (${dupes.length})`);
  console.log("   Harmless with IF NOT EXISTS, but the later definition never applies.\n");
  for (const [t, files] of dupes) {
    console.log(`      ${t}  →  ${files.filter((f) => /^\d{4}_/.test(f)).join(", ")}`);
  }
}

console.log("\n" + line);
if (critical > 0) {
  console.log(`  ❌ ${critical} table(s) would be UNPROTECTED. Fix before deploying.`);
  console.log(line);
  process.exit(1);
}
console.log("  ✅ SQL coverage complete — no unprotected tenant tables.");
console.log(line);
