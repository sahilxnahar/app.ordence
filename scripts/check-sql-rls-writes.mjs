#!/usr/bin/env node
/**
 * Ordence — migration DML vs FORCE ROW LEVEL SECURITY
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `0092_reserve_clerk_hosts.sql` failed in the Neon SQL editor. The file
 * was valid PostgreSQL, it had been reviewed, and it applied perfectly
 * from a terminal. It had never been EXECUTED as the role that would run
 * it.
 *
 * `0091` puts FORCE ROW LEVEL SECURITY on `reserved_slugs` with
 *
 *     WITH CHECK (app_platform_scope())
 *
 * and `app_platform_scope()` is false unless the transaction has done
 * `SET LOCAL app.platform_scope = 'on'`. So a plain INSERT into that
 * table is refused:
 *
 *     ERROR: new row violates row-level security policy for table "reserved_slugs"
 *
 * ⚠️ FORCE IS THE WHOLE POINT AND IT IS WHY THIS IS EASY TO MISS. Plain
 *    ENABLE does not apply to the table OWNER, and migrations run as the
 *    owner. FORCE exists precisely so the owner is not exempt — which is
 *    correct for the application and surprising for a migration, because
 *    every migration written before the table was forced worked fine.
 *
 * ⚠️ AND A SUPERUSER STILL BYPASSES IT. A drill run as a superuser
 *    applies the file happily and proves nothing. The reproduction that
 *    matters is a non-superuser, non-BYPASSRLS role, which is what the
 *    application connects as.
 *
 * 🔴 `0091` ITSELF HAS THE SAME SHAPE. Its section 6 backfills
 *    `tenant_slug_history` after section 4 forced RLS on it. That did not
 *    surface only because the backfill inserts nothing on a database with
 *    no tenants. A latent failure that waits for the first customer is
 *    worse than one that fails today.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS CHECKS
 * ══════════════════════════════════════════════════════════════════════
 * Across SQL-FILES/ in numeric order it builds the set of tables that
 * have had FORCE ROW LEVEL SECURITY enabled. Then, for every file, it
 * reports an INSERT / UPDATE / DELETE targeting one of those tables
 * unless that file sets `app.platform_scope`.
 *
 * ⚠️ IT IS HONEST ABOUT BEING A SUBSET. It does not read policies, so it
 *    cannot tell a table whose WITH CHECK needs platform scope from one
 *    whose WITH CHECK a migration would satisfy anyway. It flags the
 *    shape that has actually broken a deploy here, and the fix, setting
 *    the scope, is correct and harmless in both cases.
 *
 * No database required. Pure text.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "SQL-FILES";
let failures = 0;
const fail = (m) => { console.error(`::error::${m}`); failures += 1; };

/**
 * ⚠️ GRANDFATHERED, BY NAME AND ONLY BY NAME.
 *
 * These files are already applied to production. Editing an applied
 * migration is re-running history under the same name, which is how a
 * database ends up in a state no file describes. They are corrected by a
 * LATER file instead, never in place.
 *
 * Adding a name here must be a visible decision, so the list is explicit
 * and each entry says why.
 */
const GRANDFATHERED = new Map([
  [
    "0091_slug_authority.sql",
    "already applied. Its section 6 backfill of tenant_slug_history sits after " +
      "FORCE RLS on the same table. It did not fail because the backfill inserts " +
      "nothing on a database with no tenants, so the policy was never exercised.",
  ],
  /**
   * ⚠️ THE FOLLOWING ARE ALL ALREADY APPLIED TO PRODUCTION, AND EVERY ONE OF
   *    THEM APPLIED SUCCESSFULLY. That is evidence, not luck: the role that
   *    ran them either carried BYPASSRLS at the time, or their DML happened
   *    to touch zero rows. Section 3 of 0092 now reports which.
   *
   * 🔴 THEY ARE NOT FIXED IN PLACE, AND THAT IS DELIBERATE. Editing an
   *    applied migration is re-running history under the same name, which is
   *    how a database ends up in a state no file describes. `check-migrations`
   *    exists because that already happened here once. If one of these turns
   *    out to matter, it is corrected by a NEW numbered file.
   */
  ["0018_phase23_workflows.sql", "applied"],
  ["0019_phase24_dynamic_objects.sql", "applied"],
  ["0020_phase25_views.sql", "applied"],
  ["0021_phase32_gst.sql", "applied"],
  ["0023_phase33_purchases.sql", "applied"],
  ["0024_phase34_gstr2b.sql", "applied"],
  ["0025_phase36_tds.sql", "applied"],
  ["0026_phase37_tally.sql", "applied"],
  ["0027_phase38_receivables.sql", "applied"],
  ["0049_sales_invoices.sql", "applied"],
  ["0063_purchase_orders_payments.sql", "applied"],
  ["0080_orders_place_of_supply.sql", "applied"],
  ["0083_credit_control_and_dunning.sql", "applied"],
  /**
   * ⚠️ Legacy aggregate files. Neither is in the numbered run order and
   *    neither is applied by anything today. They are kept for reference and
   *    are the first things to delete when somebody has an afternoon.
   */
  ["ALL-IN-ONE-SETUP.sql", "legacy aggregate, not in the run order"],
  ["RUN-THESE-IN-ORDER-13.sql", "legacy aggregate, not in the run order"],
]);

/** Files that never touch a browser console or the app role. */
const isDrill = (f) => f.startsWith("DRILL-");

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

if (files.length === 0) {
  fail("No .sql files in SQL-FILES/ — this check would pass vacuously, which is worse than failing.");
}

/** Strip comments so prose about a table never counts as DML on it. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ")
    .replace(/--[^\n']*$/gm, " ");
}

const forced = new Set();
let scanned = 0;

for (const file of files) {
  if (isDrill(file)) continue;
  const raw = readFileSync(join(DIR, file), "utf8");
  const sql = stripComments(raw);
  scanned += 1;

  /**
   * 🔴 ONLY ONE SPELLING COUNTS, AND THE OTHER ONE LOOKS FINE UNTIL IT IS NOT.
   *
   * `SET LOCAL app.platform_scope = 'on';` issued as its OWN statement is
   * correct PostgreSQL and useless in a browser SQL console. The console
   * sends each statement separately, so the setting is scoped to a
   * transaction on a connection the next statement does not use. The console
   * shows:
   *
   *     1: BEGIN   executed successfully
   *     2: SET     executed successfully
   *     3: ERROR   new row violates row-level security policy
   *
   * The SET tab is telling the truth about a setting that is already gone.
   *
   * ⚠️ `psql -f` DOES NOT REPRODUCE IT. psql sends the whole file on one
   *    connection, so the file applies perfectly from a terminal and fails in
   *    the browser. Every migration in this project is pasted into a browser.
   *
   * ⭐ So the scope and the write must be in ONE statement: a `DO $$ ... $$`
   *    block using `set_config(name, value, true)`. One statement is one
   *    connection and one transaction by construction, and there is no gap
   *    for the setting to be lost in.
   */
  const setsScopeInStatement = /set_config\s*\(\s*'app\.platform_scope'/i.test(sql);
  const setsScopeAcrossStatements = /SET\s+(LOCAL\s+)?app\.platform_scope/i.test(sql);
  const setsScope = setsScopeInStatement;

  if (setsScopeAcrossStatements && !setsScopeInStatement && !GRANDFATHERED.has(file)) {
    fail(
      `${DIR}/${file} — uses \`SET LOCAL app.platform_scope\` as its only scope mechanism. ` +
      `That succeeds and then evaporates in a browser SQL console, which sends each statement ` +
      `on its own connection, and the write is refused by RLS with the SET tab still reading ` +
      `"executed successfully". Move the scope and the write into ONE statement: ` +
      `DO $$ BEGIN PERFORM set_config('app.platform_scope','on',true); <the write> END $$;`,
    );
  }

  if (forced.size > 0 && !setsScope) {
    const dml = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    const seen = new Set();
    let m;
    while ((m = dml.exec(sql)) !== null) {
      const table = m[2].toLowerCase();
      if (!forced.has(table) || seen.has(table)) continue;
      seen.add(table);
      if (GRANDFATHERED.has(file)) continue;
      fail(
        `${DIR}/${file} — ${m[1].toUpperCase()} on "${table}", which has FORCE ROW LEVEL SECURITY. ` +
        `The file never sets app.platform_scope, so this is refused with ` +
        `"new row violates row-level security policy" for any role without BYPASSRLS. ` +
        `Add SET LOCAL app.platform_scope = 'on'; inside the transaction.`,
      );
    }
  }

  // Only after checking THIS file: a file may force a table and then
  // legitimately seed it earlier in its own text.
  const force = /ALTER\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
  let f;
  while ((f = force.exec(sql)) !== null) forced.add(f[1].toLowerCase());
}

if (failures > 0) {
  console.error(`\n❌ Migration RLS writes FAILED — ${failures} problem(s) across ${scanned} file(s).\n`);
  process.exit(1);
}

console.log(
  `✅ Migration RLS writes — ${scanned} file(s), ${forced.size} forced table(s), ` +
  `${GRANDFATHERED.size} grandfathered by name.`,
);
