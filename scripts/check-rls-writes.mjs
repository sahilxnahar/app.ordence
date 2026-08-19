#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE ELEVENTH GATE: WRITES THAT ROW-LEVEL SECURITY REFUSES
 * Version: v1.33.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FOUND, AND IT WAS FOUND BY EXECUTING
 * ══════════════════════════════════════════════════════════════════════
 * Every deployment document in this repository says, in bold, as a STOP
 * gate, that `DATABASE_URL` must name `ordence_app` and NOT the Neon
 * owner role, because the owner carries BYPASSRLS and that overrides
 * even FORCE ROW LEVEL SECURITY.
 *
 * The application cannot currently run as `ordence_app`.
 *
 * 51 write statements across 18 files are issued on the MODULE-LEVEL
 * `db` client — the plain Neon HTTP connection with no session variable
 * set at all — against tables whose policies read
 * `tenant_id = app_current_tenant_id()`. With no GUC that function
 * returns NULL, the WITH CHECK fails, and Postgres raises 42501.
 *
 * That includes `app/api/webhooks/clerk/route.ts`, which is the SOLE
 * path that creates a `tenants` row or a `users` row. So on a correctly
 * configured database, NOBODY CAN EVER GET A WORKSPACE.
 *
 * ⚠️ AND THE INVERSE IS THE UNCOMFORTABLE HALF. It all works today
 * because the connection bypasses RLS — which means row-level security,
 * the SOLE tenant isolation mechanism in this product, is not in effect
 * on the deployment it was written for. Every audit that read the
 * policies and pronounced them correct, including mine, was reading
 * something that is not running.
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO HALVES, AND THE FIRST ONE IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * ① EXECUTE. Build the real policy shapes on a throwaway Postgres,
 *    connect as a NON-SUPERUSER TABLE OWNER with FORCE RLS, and prove
 *    what is accepted and what is refused. Every refusal is paired with
 *    the positive case that must still work, because a test that only
 *    shows things being refused cannot tell "correctly locked down"
 *    from "broken".
 *
 * ② SCAN. Count the write statements still issued on the unscoped
 *    client, and fail when the number goes UP. The remaining ones are a
 *    declared, shrinking debt rather than a paragraph nobody re-reads.
 *
 * 🔴 NEVER RUN THE EXECUTING HALF AGAINST NEON. Same rule as the drills.
 *    It creates roles and tables. `HARNESS_DATABASE_URL` only.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const URL_ENV = process.env.HARNESS_DATABASE_URL;

let failures = 0;
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  failures += 1;
};
const pass = (msg) => console.log(`   ✅ ${msg}`);

/* ================================================================== */
/* ② THE SCAN                                                          */
/* ================================================================== */

/**
 * ⚠️ THE ALLOWANCE IS A NUMBER, NOT A LIST OF EXCUSES.
 *
 * A per-file allowlist would need an entry written for each of 51
 * sites, and 51 written excuses is a document that reads as a decision
 * and is actually a backlog. One number that may only go down is
 * harder to argue with and impossible to misread.
 *
 * ⭐ LOWER THIS EVERY TIME A SITE IS FIXED. The gate fails if the real
 * count exceeds it, and NAGS if the count is below it, so the number
 * cannot silently drift away from the truth either.
 */
const UNSCOPED_WRITE_BUDGET = 0;

/**
 * 🔴 ZERO, AND THE ROUTE TO ZERO CORRECTED A CLAIM I MADE.
 *
 * v1.34.0 said nine of the fifteen remaining reads were "correct as they
 * are" because they are genuinely cross-tenant: the two cron sweeps, the
 * platform user directory, the anomaly detector.
 *
 * ⚠️ THAT WAS WRONG. "Cross-tenant" and "unscoped" are not the same
 * thing. Reading across every workspace REQUIRES the platform marker;
 * with no session variable the policy matches nothing, so those nine
 * were not seeing everything, they were seeing NOTHING. The nightly
 * sweep would have enqueued work for zero workspaces, every night,
 * silently. The anomaly detector would have found zero anomalies, which
 * is the most dangerous shape of broken there is: quiet reads as safe.
 *
 * ⭐ ALL NINE NEEDED `withPlatformScope`. The distinction the code was
 * missing is not tenant-versus-platform, it is SCOPED-versus-NOT.
 */
const UNSCOPED_READ_BUDGET = 0;

/**
 * Files whose `db` is genuinely the platform-scoped or tenant-scoped
 * transaction handle, shadowed by the callback parameter name.
 * Detected rather than listed: a file that binds `db` in a callback is
 * ambiguous to a regex, so it is skipped and reported.
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(rel, out);
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * ⭐ TABLE-AWARE, BECAUSE NOT EVERY TABLE HAS A POLICY.
 *
 * `plans` and `permissions` are GLOBAL CATALOGUES with no RLS: the
 * pricing page reads `plans` before anybody has an account, which is the
 * point of it. Counting those as defects would push the budget toward a
 * number that can never be reached, and a target nobody can hit stops
 * being read. Only tables the schema declares with a `tenantId` count.
 */
function tenantScopedTables(physical = false) {
  const names = new Set();
  for (const file of walk("db/schema")) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const m of src.matchAll(
      /export const (\w+) = pgTable\(\s*"([a-z_]+)"([\s\S]*?)\n\s*\);/g,
    )) {
      if (/tenantId:\s*uuid\("tenant_id"\)/.test(m[3])) names.add(physical ? m[2] : m[1]);
    }
  }
  // `tenants` itself is keyed on `id`, not `tenant_id`, and carries a policy.
  names.add("tenants");
  return names;
}

function scan() {
  const files = [...walk("app"), ...walk("server"), ...walk("lib")];
  const scoped = tenantScopedTables();
  /** Raw SQL names the PHYSICAL table, not the Drizzle relation. */
  const scopedPhysical = tenantScopedTables(true);
  const writes = [];
  const reads = [];
  const rawSql = [];
  const ambiguousFiles = [];
  let ambiguous = 0;

  /** `db.query.salesInvoices` and `.from(salesInvoices)` both name it. */
  const relationOf = (src, index) => {
    const after = src.slice(index, index + 400);
    const q = after.match(/\bdb\s*\.\s*query\s*\.\s*(\w+)/);
    if (q) return q[1];
    const f = after.match(/\.from\(\s*(\w+)/);
    return f ? f[1] : null;
  };

  for (const file of files) {
    const src = readFileSync(join(ROOT, file), "utf8");
    if (!/import\s*{[^}]*\bdb\b[^}]*}\s*from\s*"@\/db"/.test(src)) continue;

    /**
     * 🔴 AMBIGUITY IS NOW A FAILURE, NOT A SKIP.
     *
     * Twelve files name their scope handle `db` — `withPlatformScope(r,
     * async (db) => ...)` — and thirty-seven import the module-level
     * `db`. Today the two sets do not overlap, so nothing is skipped.
     *
     * ⚠️ THE DAY THEY OVERLAP, THIS GATE GOES BLIND ON A WHOLE FILE.
     * Every statement in it would read as scoped, because a regex
     * cannot tell the shadowed parameter from the import. The gate that
     * proved the largest defect in this tree would then quietly stop
     * covering the file most likely to contain the next one.
     *
     * ⭐ SO THE OVERLAP IS THE ERROR. Rename the callback parameter to
     * `tx`, which is what every other call site already uses.
     */
    if (/\(\s*db\s*\)\s*=>|async\s*\(\s*db\s*\)/.test(src)) {
      ambiguous += 1;
      ambiguousFiles.push(file);
      continue;
    }

    const at = (index) => src.slice(0, index).split("\n").length;

    for (const m of src.matchAll(/\bdb\s*\.\s*(insert|update|delete)\s*\(\s*([A-Za-z0-9_]+)/g)) {
      if (!scoped.has(m[2])) continue;
      writes.push({ file, line: at(m.index), op: m[1], table: m[2] });
    }

    /**
     * ⚠️ READS ARE THE HALF THAT DOES NOT ERROR, AND THEY ARE WORSE FOR
     * IT. A write with no session variable raises 42501 and somebody
     * sees a stack trace. A read RETURNS NOTHING, so the screen is empty
     * and the product looks merely unpopulated.
     */
    for (const m of src.matchAll(/\bdb\s*\.\s*(select|query)\b|await db$/gm)) {
      const table = relationOf(src, m.index);
      if (!table || !scoped.has(table)) continue;
      reads.push({ file, line: at(m.index), op: "read", table });
    }

    /**
     * ⭐ THE RESIDUAL I NAMED IN v1.35.0: "a raw SQL string built
     * somewhere the gate does not look."
     *
     * `db.execute(sql`...`)` bypasses Drizzle's table objects entirely,
     * so the scans above cannot see the tables it touches. This one
     * reads the statement text and looks for a tenant-scoped table name
     * after FROM / JOIN / INTO / UPDATE.
     *
     * ⚠️ ONLY ON THE MODULE CLIENT. A `tx.execute(...)` is by
     * construction inside a scope — that is what the handle IS — and
     * the 140-odd of those in this tree are correct.
     */
    for (const m of src.matchAll(/\bdb\s*\.\s*execute\s*\(/g)) {
      const statement = src.slice(m.index, m.index + 900);
      const named = [
        ...new Set(
          [...statement.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gi)].map((x) =>
            x[1].toLowerCase(),
          ),
        ),
      ].filter((t) => scopedPhysical.has(t));
      if (named.length === 0) continue;
      rawSql.push({ file, line: at(m.index), op: "execute", table: named.join(", ") });
    }
  }

  return { writes, reads, rawSql, ambiguous, ambiguousFiles };
}

/* ================================================================== */
/* ① THE EXECUTION                                                     */
/* ================================================================== */

/**
 * The four policy shapes this codebase actually uses, reproduced from
 * the migrations rather than invented:
 *
 *   tenants  — platform may read AND write            (0014:566)
 *   users    — platform may read, tenant may write    (0014:578)
 *   contacts — tenant only, both clauses              (0002 and friends)
 *   platform_action_log — platform only, both clauses (0014:135)
 */
const SETUP = `
DROP SCHEMA IF EXISTS rlsprobe CASCADE;
CREATE SCHEMA rlsprobe;
SET search_path = rlsprobe, public;

CREATE OR REPLACE FUNCTION rlsprobe.app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid;
$fn$;

CREATE OR REPLACE FUNCTION rlsprobe.app_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on';
$fn$;

CREATE TABLE rlsprobe.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE rlsprobe.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  email text NOT NULL
);
CREATE TABLE rlsprobe.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  full_name text
);
CREATE TABLE rlsprobe.platform_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  justification text NOT NULL
);

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','contacts','platform_action_log'] LOOP
    EXECUTE format('ALTER TABLE rlsprobe.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE rlsprobe.%I FORCE  ROW LEVEL SECURITY', t);
  END LOOP;
END $do$;

CREATE POLICY tenant_self_isolation ON rlsprobe.tenants
  USING      (id = rlsprobe.app_current_tenant_id() OR rlsprobe.app_platform_scope())
  WITH CHECK (id = rlsprobe.app_current_tenant_id() OR rlsprobe.app_platform_scope());

CREATE POLICY users_tenant_isolation ON rlsprobe.users
  USING      (tenant_id = rlsprobe.app_current_tenant_id() OR rlsprobe.app_platform_scope())
  WITH CHECK (tenant_id = rlsprobe.app_current_tenant_id());

CREATE POLICY contacts_tenant_isolation ON rlsprobe.contacts
  USING      (tenant_id = rlsprobe.app_current_tenant_id())
  WITH CHECK (tenant_id = rlsprobe.app_current_tenant_id());

CREATE POLICY platform_only ON rlsprobe.platform_action_log
  USING      (rlsprobe.app_current_tenant_id() IS NULL)
  WITH CHECK (rlsprobe.app_current_tenant_id() IS NULL);
`;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

async function execute() {
  const pg = (await import("pg")).default;
  const admin = new pg.Client({ connectionString: URL_ENV });
  await admin.connect();

  const owner = `rls_probe_owner`;
  const pw = "probe_only_never_neon";

  await admin.query(SETUP);
  await admin.query(`
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${owner}') THEN
        CREATE ROLE ${owner} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $do$;
  `);
  await admin.query(`GRANT USAGE ON SCHEMA rlsprobe TO ${owner}`);
  for (const t of ["tenants", "users", "contacts", "platform_action_log"]) {
    await admin.query(`ALTER TABLE rlsprobe.${t} OWNER TO ${owner}`);
  }
  await admin.query(`ALTER FUNCTION rlsprobe.app_current_tenant_id() OWNER TO ${owner}`);
  await admin.query(`ALTER FUNCTION rlsprobe.app_platform_scope() OWNER TO ${owner}`);

  /**
   * ⚠️ CONNECT AS THE ROLE THE DEPLOY CHECKLIST DEMANDS, not as the one
   * the deployment currently uses. That difference is the whole gate.
   */
  const url = new URL(URL_ENV);
  url.username = owner;
  url.password = pw;
  const app = new pg.Client({ connectionString: url.toString() });
  await app.connect();
  await app.query("SET search_path = rlsprobe, public");

  const isSuper = await app.query(
    `SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname = current_user`,
  );
  if (isSuper.rows[0]?.privileged) {
    fail("The probe role bypasses RLS. Every assertion below would pass for the wrong reason.");
    await app.end();
    await admin.end();
    return;
  }
  pass("probe connects as a non-superuser, non-BYPASSRLS table owner");

  /** Run `sql`, expecting either success or a specific SQLSTATE. */
  const expect = async (label, sql, params, wantCode) => {
    try {
      await app.query("BEGIN");
      for (const [k, v] of Object.entries(params.settings ?? {})) {
        await app.query("SELECT set_config($1, $2, true)", [k, v]);
      }
      await app.query(sql, params.values ?? []);
      await app.query("COMMIT");
      if (wantCode) {
        fail(`${label}: expected ${wantCode}, but it SUCCEEDED.`);
      } else {
        pass(label);
      }
    } catch (err) {
      await app.query("ROLLBACK").catch(() => {});
      if (!wantCode) {
        fail(`${label}: expected success, got ${err.code ?? "?"} ${err.message}`);
      } else if (err.code !== wantCode) {
        fail(`${label}: expected ${wantCode}, got ${err.code ?? "?"} ${err.message}`);
      } else {
        pass(`${label} (refused with ${err.code})`);
      }
    }
  };

  console.log("\n🔴 THE UNSCOPED CLIENT — what 51 write statements do today\n");

  await expect(
    "an unscoped INSERT into `tenants` is refused (the Clerk webhook's first statement)",
    `INSERT INTO tenants (name) VALUES ('acme')`,
    {},
    "42501",
  );
  await expect(
    "an unscoped INSERT into `users` is refused (the Clerk webhook's second statement)",
    `INSERT INTO users (tenant_id, email) VALUES ($1, 'a@b.c')`,
    { values: [TENANT_A] },
    "42501",
  );
  await expect(
    "an unscoped INSERT into `contacts` is refused (createContact)",
    `INSERT INTO contacts (tenant_id, full_name) VALUES ($1, 'Priya')`,
    { values: [TENANT_A] },
    "42501",
  );

  console.log("\n⭐ THE SANCTIONED PATHS — what must still work\n");

  await expect(
    "withPlatformScope may INSERT a tenant",
    `INSERT INTO tenants (name) VALUES ('acme')`,
    { settings: { "app.platform_scope": "on" } },
  );
  await expect(
    "withTenant may INSERT its own contact",
    `INSERT INTO contacts (tenant_id, full_name) VALUES ($1, 'Priya')`,
    { settings: { "app.current_tenant_id": TENANT_A }, values: [TENANT_A] },
  );
  await expect(
    "withTenant may INSERT its own user",
    `INSERT INTO users (tenant_id, email) VALUES ($1, 'ok@b.c')`,
    { settings: { "app.current_tenant_id": TENANT_A }, values: [TENANT_A] },
  );
  await expect(
    "withPlatformScope may INSERT into the platform action log",
    `INSERT INTO platform_action_log (justification) VALUES ('a written reason')`,
    { settings: { "app.platform_scope": "on" } },
  );

  console.log("\n🔴 THE PAIRED REFUSALS — isolation is still isolation\n");

  await expect(
    "withTenant A may NOT write a row belonging to tenant B",
    `INSERT INTO contacts (tenant_id, full_name) VALUES ($1, 'stolen')`,
    { settings: { "app.current_tenant_id": TENANT_A }, values: [TENANT_B] },
    "42501",
  );
  await expect(
    "withPlatformScope may NOT write a customer's user row",
    `INSERT INTO users (tenant_id, email) VALUES ($1, 'support@ordence.com')`,
    { settings: { "app.platform_scope": "on" }, values: [TENANT_A] },
    "42501",
  );
  await expect(
    "a tenant session may NOT write the platform action log",
    `INSERT INTO platform_action_log (justification) VALUES ('forged')`,
    { settings: { "app.current_tenant_id": TENANT_A } },
    "42501",
  );

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE HALF THAT DOES NOT ERROR, AND IS WORSE FOR IT
   * ══════════════════════════════════════════════════════════════════
   * A write with no session variable raises 42501 and somebody sees a
   * stack trace. A READ returns NOTHING, silently — so a screen is
   * empty and the product looks merely unpopulated.
   *
   * ⚠️ THIS IS WHAT BROKE THE CLERK WEBHOOK'S IDEMPOTENCY. Its
   * `existing` lookup always came back undefined, so every delivery
   * took the INSERT branch, and Svix delivers at least once.
   */
  console.log("\n🔴 AND THE READS, WHICH DO NOT ERROR AT ALL\n");

  const rows = async (label, sql, settings, want) => {
    await app.query("BEGIN");
    for (const [k, v] of Object.entries(settings ?? {})) {
      await app.query("SELECT set_config($1, $2, true)", [k, v]);
    }
    const r = await app.query(sql);
    await app.query("COMMIT");
    if (r.rows.length === want) pass(`${label} → ${r.rows.length} row(s)`);
    else fail(`${label}: expected ${want} row(s), got ${r.rows.length}`);
  };

  await rows(
    "an unscoped read of a seeded contact returns NOTHING and raises no error",
    `SELECT * FROM contacts`,
    {},
    0,
  );
  await rows(
    "the same read under withTenant returns the row",
    `SELECT * FROM contacts`,
    { "app.current_tenant_id": TENANT_A },
    1,
  );
  await rows(
    "and tenant B still sees none of it",
    `SELECT * FROM contacts`,
    { "app.current_tenant_id": TENANT_B },
    0,
  );

  /**
   * ⭐⭐ THE ASSERTION THAT WOULD HAVE CAUGHT THE NINE.
   *
   * A cron sweep, a platform directory and an anomaly detector all read
   * across every workspace by design. Unscoped they see nothing;
   * `withPlatformScope` is what actually widens the view. Proving both
   * halves here is what turns "cross-tenant" from an intention in a
   * comment into a mechanism.
   */
  await rows(
    "a cross-tenant read UNSCOPED sees nothing, however much it means to",
    `SELECT * FROM tenants`,
    {},
    0,
  );
  await rows(
    "the same read under withPlatformScope sees every workspace",
    `SELECT * FROM tenants`,
    { "app.platform_scope": "on" },
    1,
  );

  /**
   * ⭐⭐ THE ONE THAT EXPLAINS WHY NOBODY NOTICED. Run the identical
   * refused statement as a BYPASSRLS role and it succeeds. That is the
   * deployment as it stands, and it is why every audit of these
   * policies, including mine, was reading something that is not running.
   */
  console.log("\n⚠️  AND WHY IT WENT UNNOTICED\n");
  try {
    await admin.query("SET search_path = rlsprobe, public");
    await admin.query(`INSERT INTO contacts (tenant_id, full_name) VALUES ($1, 'bypassed')`, [
      TENANT_A,
    ]);
    pass(
      "the same refused statement SUCCEEDS for a privileged role — which is the deployment today",
    );
  } catch (err) {
    fail(`the privileged control case failed unexpectedly: ${err.message}`);
  }

  await app.end();
  await admin.query("DROP SCHEMA IF EXISTS rlsprobe CASCADE").catch(() => {});
  await admin.end();
}

/* ================================================================== */
/* MAIN                                                                */
/* ================================================================== */

console.log("\n🔎 check:rls-writes\n");

const { writes, reads, rawSql, ambiguous, ambiguousFiles } = scan();

const report = (label, found, budget, name, consequence) => {
  console.log(`   ${label}: ${found.length} on tenant-scoped tables (budget ${budget}).`);
  if (found.length > budget) {
    fail(
      `${found.length} ${label.toLowerCase()}, budget is ${budget}. ${consequence}\n` +
        found.map((h) => `      ${h.file}:${h.line}  db.${h.op}(${h.table})`).join("\n"),
    );
  } else if (found.length < budget) {
    console.log(`   ⭐ Below budget. Lower ${name} to ${found.length} so it cannot drift back up.`);
  }
};

if (ambiguous > 0) {
  fail(
    `${ambiguous} file(s) both import \`db\` and shadow it as a callback parameter, ` +
      `so this gate cannot tell the two apart and would go blind on the whole file. ` +
      `Rename the parameter to \`tx\`:\n` +
      ambiguousFiles.map((f) => `      ${f}`).join("\n"),
  );
} else {
  console.log(
    `   No file both imports \`db\` and shadows it, so nothing is invisible to this scan.`,
  );
}

report(
  "Unscoped writes",
  writes,
  UNSCOPED_WRITE_BUDGET,
  "UNSCOPED_WRITE_BUDGET",
  "Every one raises 42501 under the role the deploy checklist demands.",
);
report(
  "Unscoped reads",
  reads,
  UNSCOPED_READ_BUDGET,
  "UNSCOPED_READ_BUDGET",
  "Every one silently returns NOTHING under that role, which is worse than an error.",
);
report(
  "Raw SQL on the unscoped client",
  rawSql,
  0,
  "the raw-SQL budget (hard zero)",
  "A `db.execute(sql`...`)` naming a tenant table bypasses every other check in this gate.",
);

if (!URL_ENV) {
  console.log(
    `\n⏭️  EXECUTING HALF SKIPPED — no HARNESS_DATABASE_URL.\n` +
      `   NOT CHECKED: that an unscoped write is actually refused, that the\n` +
      `   sanctioned paths are actually accepted, and that cross-tenant writes\n` +
      `   are actually blocked. The scan above is text; this is the behaviour.\n` +
      `   Set HARNESS_DATABASE_URL against a THROWAWAY Postgres. NEVER NEON.\n`,
  );
} else {
  await execute();
}

if (failures === 0) {
  console.log(`\n✅ check:rls-writes passed.\n`);
  process.exit(0);
}
console.error(`\n❌ check:rls-writes FAILED — ${failures} problem${failures === 1 ? "" : "s"}.\n`);
process.exit(1);
