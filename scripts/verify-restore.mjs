#!/usr/bin/env node
/**
 * Ordence — RESTORE COHERENCE HARNESS
 * Run: node scripts/verify-restore.mjs --i-know-this-is-a-restore
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS IS FOR, AND WHAT IT DELIBERATELY IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It answers ONE question about a database you have just restored onto a
 * Neon branch: is this thing coherent, or is it a shape that merely
 * resembles the product?
 *
 * It does NOT measure a restore. It cannot: it runs after the restore,
 * against the result. The wall-clock number that makes a backup real is
 * produced by a human with a clock, and it goes in the results table in
 * docs/current/RESTORE-DRILL.md. A harness that printed an RTO it did
 * not observe would be the same lie in a nicer font.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS FILE WAS WRITTEN AGAINST — TWICE, THIS WEEK
 * ══════════════════════════════════════════════════════════════════════
 * A verifier that iterates over "every table" and reports "0 problems
 * found" when there are zero tables. An empty database is the single
 * most important failure a restore check can catch, and it is the exact
 * input on which a naive loop is silent. So emptiness is checked FIRST,
 * explicitly, and it is FATAL. Zero tables is never a pass here.
 *
 * The same rule governs rows. A schema with no data is a restore that
 * restored the schema and nothing else — which is what happens when you
 * branch from the wrong point, or point at the wrong project.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY IT REFUSES TO RUN WITHOUT AN EXPLICIT FLAG
 * ══════════════════════════════════════════════════════════════════════
 * Every read here is harmless. The danger is not damage, it is BELIEF:
 * pointed at production by a tired hand at 3am it prints a clean bill of
 * health, and that clean bill gets read as "the restore is verified"
 * when nothing was restored at all. A drill that can accidentally grade
 * production is a drill that can certify a backup that does not exist.
 *
 * Hence: an explicit flag, plus a host comparison against
 * PRODUCTION_DATABASE_URL when that is available. Fail closed, and say
 * why in words rather than a usage string.
 */

import { Pool } from "pg";

const ARGV = process.argv.slice(2);
const ACK = "--i-know-this-is-a-restore";
const LINE = "═".repeat(70);

/** ⚠️ Every refusal explains itself. A bare exit code teaches nobody. */
function refuse(headline, body) {
  console.error(`\n${LINE}\n  REFUSING TO RUN — ${headline}\n${LINE}\n`);
  console.error(body.trim() + "\n");
  process.exit(2);
}

function fatal(headline, body) {
  console.error(`\n${LINE}\n  🔴 RESTORE VERIFICATION FAILED — ${headline}\n${LINE}\n`);
  console.error(body.trim() + "\n");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* THE GUARD — before a single byte is read                            */
/* ------------------------------------------------------------------ */

if (!ARGV.includes(ACK)) {
  refuse(
    "no explicit acknowledgement",
    `This harness grades a RESTORED database. Run it as:\n\n` +
      `  RESTORE_DATABASE_URL="postgresql://…the recovery BRANCH…" \\\n` +
      `    node scripts/verify-restore.mjs ${ACK}\n\n` +
      `The flag is not ceremony. Without it, the easiest mistake in the\n` +
      `whole procedure — running this against production and reading the\n` +
      `green output as proof the backup works — is one arrow-up away.`,
  );
}

const TARGET = process.env.RESTORE_DATABASE_URL ?? process.env.DATABASE_URL;

if (!TARGET) {
  refuse(
    "no target database",
    `Set RESTORE_DATABASE_URL to the connection string of the Neon branch\n` +
      `you restored. DATABASE_URL is accepted as a fallback, which is\n` +
      `precisely why the checks below exist.`,
  );
}

/**
 * ⚠️ HOST-LEVEL COMPARISON, NOT STRING EQUALITY.
 *
 * The production URL and the branch URL differ in the endpoint id and
 * usually in nothing else; passwords rotate, pooler suffixes come and
 * go, `?sslmode=` gets appended by hand. Comparing whole strings would
 * pass the moment anyone appended a query parameter — a guard that is
 * one keystroke from silently opening.
 */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^([^.]+)-pooler\./, "$1.").toLowerCase();
  } catch {
    return null;
  }
}

const PROD = process.env.PRODUCTION_DATABASE_URL;
if (PROD && hostOf(PROD) && hostOf(PROD) === hostOf(TARGET)) {
  refuse(
    "the target IS production",
    `RESTORE_DATABASE_URL resolves to the same host as\n` +
      `PRODUCTION_DATABASE_URL (${hostOf(PROD)}).\n\n` +
      `Nothing would have been damaged — every statement here is a SELECT.\n` +
      `What would have been damaged is the record: a PASS printed against\n` +
      `production, pasted into the runbook, certifying a restore that never\n` +
      `happened.`,
  );
}

/**
 * ⚠️ THE WORD-MARKER CHECK IS A BACKSTOP, NOT THE GUARD.
 *
 * It catches `…-prod.…` and `…/ordence_production`. It cannot catch a
 * production host with an innocuous name, which is why the host
 * comparison above exists and why the flag exists. Three weak checks
 * that fail closed beat one clever check that fails open.
 */
const NAME_MARKERS = ["prod", "production", "live"];
const lowered = TARGET.toLowerCase();
const hit = NAME_MARKERS.find((m) => lowered.includes(m));
if (hit && !ARGV.includes("--yes-the-branch-name-contains-" + hit)) {
  refuse(
    `the target name contains "${hit}"`,
    `The connection string contains "${hit}", which is how production\n` +
      `strings usually read.\n\n` +
      `If this really is a recovery branch that happens to carry the word —\n` +
      `for example a branch cut FROM production and named after it — re-run\n` +
      `with --yes-the-branch-name-contains-${hit} and be certain, because\n` +
      `that flag is the last thing standing between you and grading the\n` +
      `wrong database.`,
  );
}

/* ------------------------------------------------------------------ */
/* WHAT "COHERENT" MEANS HERE                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EXHAUSTIVE NAMED LISTS, NEVER A NUMERIC FLOOR.
 *
 * `check-rls-coverage.mjs` carries the reason in its header: a floor
 * ("at least 100 policies") measures how much was done right and is
 * structurally blind to what was done wrong. A named list of tables that
 * MUST be present cannot be satisfied by a large number of other tables.
 */
const CORE_TABLES = [
  "tenants",
  "plans",
  "audit_logs",
  "platform_action_log",
  "companies",
  "contacts",
  "documents",
  "financial_periods",
  "subscriptions",
  "change_log",
];

/**
 * The tables whose emptiness means the restore restored a SHAPE.
 * `tenants` is the one that cannot legitimately be zero: no tenants
 * means no customer exists in this database, whatever else survived.
 */
const MUST_HAVE_ROWS = ["tenants"];
const COUNTED = [...CORE_TABLES, "users"];

/**
 * ⚠️ MIGRATION SIGNATURE OBJECTS.
 *
 * There is no migrations ledger table in this product — migrations are
 * numbered SQL files a human runs. SQL-FILES/WHICH-MIGRATIONS-ARE-APPLIED-neon-safe.sql
 * asks the only answerable question instead: does the object that
 * migration creates exist. This is the same question for the four that a
 * restore most often loses, not a replacement for that file's full sweep.
 */
const MIGRATION_SIGNATURES = [
  ["0001", "function app_current_tenant_id()", "SELECT to_regprocedure('public.app_current_tenant_id()') IS NOT NULL AS ok"],
  ["0081", "function audit_chain_link_hash(text,bigint,text,text)", "SELECT to_regprocedure('public.audit_chain_link_hash(text,bigint,text,text)') IS NOT NULL AS ok"],
  ["0079", "function app_platform_scope()", "SELECT to_regprocedure('public.app_platform_scope()') IS NOT NULL AS ok"],
  ["0091", "table tenant_slug_history", "SELECT to_regclass('public.tenant_slug_history') IS NOT NULL AS ok"],
];

/* ------------------------------------------------------------------ */
/* THE RUN                                                             */
/* ------------------------------------------------------------------ */

const problems = [];
const notes = [];
const fail = (what, detail) => problems.push({ what, detail });

const pool = new Pool({
  connectionString: TARGET,
  ssl: /localhost|127\.0\.0\.1/.test(TARGET) ? undefined : { rejectUnauthorized: true },
  connectionTimeoutMillis: 15_000,
  max: 2,
});

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

try {
  /**
   * 🔴 STEP 0 — IS THERE ANYTHING HERE AT ALL.
   *
   * This runs before every other check and exits immediately. It is not
   * one finding among many: a zero-table database makes every subsequent
   * check vacuously true, and a list of vacuous truths reads exactly like
   * a pass.
   */
  const [{ tables }] = await q(
    `SELECT count(*)::int AS tables
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );

  if (tables === 0) {
    await pool.end();
    fatal(
      "THE DATABASE IS EMPTY — zero tables in schema public",
      `This is not "0 problems found". It is the worst possible restore\n` +
        `result wearing the costume of a clean one.\n\n` +
        `Likely causes, in the order they actually happen:\n` +
        `  • the branch was created from the wrong project;\n` +
        `  • the connection string points at a fresh Neon database rather\n` +
        `    than the recovery branch;\n` +
        `  • the restore step was skipped and the branch is a blank one.\n\n` +
        `Nothing below ran. There was nothing to run it against.`,
    );
  }

  notes.push(`schema public contains ${tables} tables`);

  /* -- 1. the named tables that must exist ------------------------- */

  const present = new Set(
    (
      await q(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'`,
      )
    ).map((r) => r.relname),
  );

  const missingCore = CORE_TABLES.filter((t) => !present.has(t));
  if (missingCore.length > 0) {
    fail(
      "core tables are missing from the restore",
      `Missing: ${missingCore.join(", ")}\n` +
        `A restore that lost these is not a restore of this product. Do not\n` +
        `point the application at this branch.`,
    );
  }

  /* -- 2. rows, not just shape ------------------------------------- */

  const counts = new Map();
  for (const t of COUNTED) {
    if (!present.has(t)) continue;
    /**
     * ⚠️ THE COUNT MUST NOT BE FILTERED BY RLS, or an empty result would
     * mean "no tenant is set in this session", not "no rows exist" — the
     * two most different possible answers rendered identically. The
     * owner role bypasses ENABLE but not FORCE, so the count is taken
     * from a session with no tenant GUC and the reading is stated as
     * what it is: rows visible to this connection.
     */
    const [{ n }] = await q(`SELECT count(*)::bigint::text AS n FROM public."${t}"`);
    counts.set(t, Number(n));
  }

  const totalRows = [...counts.values()].reduce((a, b) => a + b, 0);
  if (totalRows === 0) {
    fail(
      "every table counted is EMPTY — the schema restored, the data did not",
      `${counts.size} tables checked, ${totalRows} rows between them.\n` +
        `This is the second face of the empty-database defect: the tables\n` +
        `exist, so a loop over tables finds nothing wrong.`,
    );
  }

  for (const t of MUST_HAVE_ROWS) {
    if (counts.get(t) === 0) {
      fail(
        `\`${t}\` has zero rows`,
        `There is no customer in this database. Whatever was restored, it\n` +
          `was not the production tenant list.`,
      );
    }
  }

  /* -- 3. RLS survived the restore --------------------------------- */

  /**
   * 🔴 FORCE, NOT JUST ENABLE.
   *
   * The application connects as the table owner on Neon, and ENABLE does
   * not apply to the owner. A restored branch with ENABLE and no FORCE
   * renders every page perfectly and serves every tenant's rows to every
   * other tenant. This is the single check most likely to catch a real
   * defect in a real restore, because some restore paths reproduce
   * tables without reproducing their policies.
   */
  const NOT_TENANT_SCOPED = new Set(["tenants", "plans"]);
  const rls = await q(
    `SELECT c.relname AS table_name, c.relrowsecurity AS enabled,
            c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY c.relname`,
  );

  const unprotected = rls.filter(
    (r) => !NOT_TENANT_SCOPED.has(r.table_name) && (!r.enabled || !r.forced || r.policies === 0),
  );

  if (rls.length === 0) {
    fail(
      "no tenant-scoped table was found at all",
      `Not one table in this database carries a tenant_id column. Either\n` +
        `this is not Ordence's schema, or the restore is far more damaged\n` +
        `than a policy check can describe.`,
    );
  } else if (unprotected.length > 0) {
    fail(
      `${unprotected.length} tenant-scoped table(s) lost row-level security`,
      unprotected
        .map((r) => `  ${r.table_name}: enabled=${r.enabled} forced=${r.forced} policies=${r.policies}`)
        .join("\n") +
        `\n\nRe-apply SQL-FILES/ALL-IN-ONE-SETUP.sql against this branch and\n` +
        `run this harness again. Do not route traffic here first: the\n` +
        `application works perfectly in this state, and the only difference\n` +
        `is that every tenant can read every other tenant's data.`,
    );
  } else {
    notes.push(`${rls.length} tenant-scoped tables, all ENABLE + FORCE + policy`);
  }

  /* -- 4. the 0081 audit hash chain still verifies ------------------ */

  /**
   * ⭐ WHY THE CHAIN IS THE RIGHT INTEGRITY PROBE FOR A RESTORE.
   *
   * Row counts prove volume. The chain proves ORDER AND CONTENT-LINKAGE:
   * every row's hash covers its position and its predecessor, so a
   * restore that silently dropped rows from the middle of a table, or
   * reassembled them out of order, breaks here and nowhere else.
   *
   * ⚠️ It verifies STRUCTURE only, exactly as SQL-FILES/VERIFY-0081-neon-safe.sql
   * says: content_hash is over canonical JSON produced by
   * lib/audit/chain.ts and is verified by verifyAuditChain() there.
   */
  const hasChainFn = (await q(
    `SELECT to_regprocedure('public.audit_chain_link_hash(text,bigint,text,text)') IS NOT NULL AS ok`,
  ))[0].ok;

  if (!present.has("audit_logs")) {
    fail("audit_logs is not in the restore", "The audit trail did not survive. Stop and investigate.");
  } else if (!hasChainFn) {
    fail(
      "audit_chain_link_hash() is missing — 0081 did not survive the restore",
      `The chain columns may be present while the verifier function is not,\n` +
        `which is a state in which nobody can prove the audit trail was not\n` +
        `edited. Re-apply SQL-FILES/0081_audit_hash_chain.sql to the branch.`,
    );
  } else {
    const chain = await q(`
      WITH chained AS (
        SELECT coalesce(tenant_id::text, 'platform') AS scope,
               chain_seq, prev_hash, content_hash, row_hash
          FROM audit_logs WHERE chain_seq IS NOT NULL
      ), linked AS (
        SELECT c.*, lag(c.row_hash) OVER w AS predecessor_hash,
               lag(c.chain_seq) OVER w AS predecessor_seq
          FROM chained c WINDOW w AS (PARTITION BY c.scope ORDER BY c.chain_seq)
      ), judged AS (
        SELECT scope, chain_seq,
               CASE
                 WHEN row_hash <> audit_chain_link_hash(scope, chain_seq, coalesce(prev_hash, ''), content_hash)
                   THEN 'row_hash_mismatch'
                 WHEN predecessor_seq IS NULL AND (chain_seq <> 1 OR prev_hash IS NOT NULL)
                   THEN 'head_truncated'
                 WHEN predecessor_seq IS NOT NULL AND chain_seq <> predecessor_seq + 1
                   THEN 'sequence_gap'
                 WHEN predecessor_seq IS NOT NULL AND prev_hash IS DISTINCT FROM predecessor_hash
                   THEN 'link_broken'
                 ELSE NULL END AS break_kind
          FROM linked
      )
      SELECT count(*)::int AS chained_rows,
             count(*) FILTER (WHERE break_kind IS NOT NULL)::int AS broken,
             coalesce((array_agg(scope || ' @seq ' || chain_seq || ' ' || break_kind)
                        FILTER (WHERE break_kind IS NOT NULL))[1], '') AS first_break
        FROM judged`);

    const c = chain[0];
    if (c.broken > 0) {
      fail(
        `the audit hash chain is BROKEN in the restore (${c.broken} link(s))`,
        `First break: ${c.first_break}\n\n` +
          `On a restored branch this usually means the restore is partial —\n` +
          `rows missing from the middle of the chain — rather than tampering.\n` +
          `Either way the restored audit trail cannot be relied on as\n` +
          `evidence until the cause is known.`,
      );
    } else if (c.chained_rows === 0) {
      /**
       * ⚠️ NOT A FAILURE, AND SAID OUT LOUD RATHER THAN PASSED OVER.
       * 0081 never backfills — a hash computed later proves nothing about
       * earlier rows — so a database whose audit rows all predate the
       * migration legitimately has zero chained rows. Silence here would
       * read as "chain verified".
       */
      notes.push("⚠️ audit chain: ZERO chained rows — nothing was verified, not 'verified OK'");
    } else {
      notes.push(`audit chain: ${c.chained_rows} chained rows, structure intact`);
    }

    const [{ unchained }] = await q(
      `SELECT count(*)::int AS unchained FROM audit_logs WHERE chain_seq IS NULL`,
    );
    if (unchained > 0) notes.push(`audit rows outside the chain: ${unchained} (expected for pre-0081 history)`);
  }

  /* -- 5. migration objects ---------------------------------------- */

  for (const [num, what, sql] of MIGRATION_SIGNATURES) {
    const [{ ok }] = await q(sql);
    if (!ok) {
      fail(
        `migration ${num} is not present on the restore`,
        `Missing signature object: ${what}\n` +
          `Run SQL-FILES/WHICH-MIGRATIONS-ARE-APPLIED-neon-safe.sql against\n` +
          `this branch for the full list of what to re-apply, oldest first.`,
      );
    }
  }
} catch (err) {
  /**
   * 🔴 AN UNREACHABLE DATABASE IS A FAILED VERIFICATION, NOT A SKIP.
   * The tempting shape here is a try/catch that warns and exits 0 so CI
   * stays green. That is how a restore drill comes to certify a database
   * nobody ever connected to.
   */
  await pool.end().catch(() => {});
  fatal(
    "could not verify — the database did not answer",
    `${err && err.message ? err.message : String(err)}\n\n` +
      `A database that cannot be reached has not been verified. This exits\n` +
      `non-zero on purpose: "could not check" and "checked, fine" must never\n` +
      `produce the same exit code.`,
  );
}

await pool.end().catch(() => {});

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

console.log(`\n${LINE}\n  RESTORE COHERENCE — ${new Date().toISOString()}\n${LINE}`);
for (const n of notes) console.log(`  · ${n}`);

if (problems.length > 0) {
  console.error(`\n${LINE}\n  🔴 ${problems.length} PROBLEM(S) — this branch is NOT a usable restore\n${LINE}\n`);
  for (const p of problems) console.error(`▸ ${p.what}\n${p.detail}\n`);
  process.exit(1);
}

console.log(`
  ✅ The restored branch is COHERENT.

  ⚠️ Read that precisely. It means: tables present, rows present, RLS
     enabled and FORCED, audit chain structurally intact, migration
     objects present.

  🔴 It does NOT mean the restore is complete, and it measures NOTHING.
     Not in this database, and therefore not checked by anything above:
       • the Clerk user directory — logins live outside Postgres;
       • R2 objects — this restores document ROWS, not the files;
       • Railway secrets, including VAULT_ENCRYPTION_KEY. Without that
         key every encrypted column here is ciphertext forever.

  The number that makes this a drill is wall-clock time, and only a human
  with a clock produces it. Write it into the results table in
  docs/current/RESTORE-DRILL.md now, while you still remember it.
`);
