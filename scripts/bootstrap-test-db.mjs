#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ MAKE `npm run test:security` RUNNABLE
 * Version: v1.79.0-alpha · Infra wave 12
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM THIS SOLVES
 * ══════════════════════════════════════════════════════════════════════
 * The security project is the most important suite in this repository.
 * It runs against a REAL PostgreSQL and proves that row-level security
 * actually holds , not that some SQL file says it should.
 *
 * It has run in CI on every push, in a job that stands up a service
 * container and hand-writes `.env.test` in a shell heredoc. It has run
 * on a developer machine approximately never, because standing that up
 * by hand is: install Postgres, create a database, create a NON-superuser
 * role (a superuser bypasses RLS and every test passes for the wrong
 * reason), push the schema, apply 114 SQL files in order, and write
 * `.env.test` with the right variable names.
 *
 * Nobody does that twice. So the suite that proves tenant isolation was
 * a suite only a robot ran, and a developer's local "green" meant the UI
 * tests passed.
 *
 *     node scripts/bootstrap-test-db.mjs
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE NON-SUPERUSER ROLE IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * A superuser, and any role with BYPASSRLS, is exempt from every policy.
 * A test suite connected as one would pass every isolation test on a
 * database with no policies at all , the most expensive kind of green.
 *
 * So this creates `ordence_app` with `NOSUPERUSER NOBYPASSRLS`, exactly
 * as `RAILWAY-EVERYTHING-STEP-BY-STEP.md` demands for production, and
 * points `TEST_DATABASE_URL` at it. `TEST_ADMIN_DATABASE_URL` gets the
 * superuser, for the fixtures that legitimately need to set up state.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT REFUSES ANYTHING THAT IS NOT OBVIOUSLY LOCAL
 * ══════════════════════════════════════════════════════════════════════
 * It creates roles and drops a database. `tests/setup.ts` already refuses
 * a URL without `localhost`, `127.0.0.1`, `test` or `_test` in it; this
 * refuses earlier, because by the time the suite refuses, this script has
 * already dropped something.
 */

import { writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { splitStatements } from "./lib/sql-statements.mjs";
import { expandPsqlVariables } from "./lib/psql-variables.mjs";

const ROOT = process.cwd();

const HOST = process.env.PGHOST ?? "localhost";
const PORT = Number(process.env.PGPORT ?? 5432);
const SUPERUSER = process.env.PGUSER ?? "postgres";
const SUPERPASS = process.env.PGPASSWORD ?? "";
const DBNAME = process.env.TEST_DB_NAME ?? "ordence_test";
const APP_ROLE = "ordence_app";
const APP_PASS = process.env.TEST_APP_PASSWORD ?? "test_only_not_a_secret";

const SKIP_SQL = process.argv.includes("--skip-sql");
const KEEP = process.argv.includes("--keep");

/* ------------------------------------------------------------------ */

function localish(host) {
  return ["localhost", "127.0.0.1", "::1", "/tmp", "host.docker.internal"].includes(host);
}

if (!localish(HOST)) {
  console.error(
    `\n🔴 PGHOST is "${HOST}", which is not obviously local.\n\n` +
      `   This script creates roles and DROPS a database. It will not do that to\n` +
      `   anything it cannot see is a throwaway. Set PGHOST=localhost and point it at\n` +
      `   a Postgres you are willing to lose.\n`,
  );
  process.exit(2);
}

function adminUrl(database) {
  const auth = SUPERPASS ? `${SUPERUSER}:${SUPERPASS}` : SUPERUSER;
  return `postgresql://${auth}@${HOST}:${PORT}/${database}`;
}

async function run(url, sql, params) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function step(label, fn) {
  process.stdout.write(`  ${label}… `);
  try {
    const note = await fn();
    process.stdout.write(`✅${note ? "  " + note : ""}\n`);
  } catch (err) {
    process.stdout.write(`🔴\n\n     ${err.message}\n\n`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\nBootstrapping ${DBNAME} on ${HOST}:${PORT}\n`);

await step(`connect as ${SUPERUSER}`, async () => {
  await run(adminUrl("postgres"), "SELECT 1");
});

if (!KEEP) {
  await step(`drop ${DBNAME} if it exists`, async () => {
    /**
     * ⚠️ TERMINATE FIRST. A leftover connection from a crashed test run
     * makes DROP DATABASE hang forever with no message, which reads as
     * "the script is broken" rather than "close your psql".
     */
    await run(
      adminUrl("postgres"),
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [DBNAME],
    );
    await run(adminUrl("postgres"), `DROP DATABASE IF EXISTS ${DBNAME}`);
  });
}

await step(`create ${DBNAME}`, async () => {
  const exists = await run(adminUrl("postgres"), `SELECT 1 FROM pg_database WHERE datname = $1`, [
    DBNAME,
  ]);
  if (exists.rowCount === 0) await run(adminUrl("postgres"), `CREATE DATABASE ${DBNAME}`);
  else return "already there";
});

await step(`create ${APP_ROLE} — NOSUPERUSER NOBYPASSRLS`, async () => {
  /**
   * 🔴 THE TWO NEGATIVES ARE THE ENTIRE VALUE OF THIS ROLE. A role with
   * either of them missing passes every isolation test on a database
   * with no policies at all.
   */
  await run(
    adminUrl("postgres"),
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
         CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASS}';
       END IF;
     END $$;`,
  );
  await run(adminUrl("postgres"), `ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB`);
  await run(adminUrl("postgres"), `GRANT ALL ON DATABASE ${DBNAME} TO ${APP_ROLE}`);
});

await step(`grant the schema to ${APP_ROLE}`, async () => {
  const url = adminUrl(DBNAME);

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 USAGE, NOT ALL. THE DIFFERENCE IS `CREATE`.
   * ══════════════════════════════════════════════════════════════════
   * This line used to read `GRANT ALL ON SCHEMA public`, which includes
   * CREATE, on the reasoning that 0019 §9 revokes it later anyway:
   *
   *     REVOKE CREATE ON SCHEMA public FROM ordence_app;
   *
   * ⚠️ THAT MADE THE TEST DATABASE DEPEND ON A MIGRATION TO UNDO THIS
   * SCRIPT'S OWN OVER-GRANT. It held, until it did not: a bootstrap in
   * which 0019 was among the refused statements produced a database
   * where `ordence_app` could `CREATE TABLE`, and
   * `tests/security/dynamic-objects.test.ts` , which asserts precisely
   * that it cannot , created a real table called `leak_probe` owned by
   * the application role and left it there.
   *
   * ⭐ THE TEST DATABASE MUST NOT BE MORE PERMISSIVE THAN PRODUCTION AT
   * ANY POINT, not even briefly, because a suite that runs against a
   * weaker database proves something weaker than it claims. The
   * application role never needs CREATE: `drizzle-kit push` and every
   * numbered file run as the superuser above, and runtime tables are
   * made by the SECURITY DEFINER factory in 0019.
   */
  await run(url, `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await run(url, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${APP_ROLE}`);
  await run(url, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${APP_ROLE}`);

  // Clear anything a previous bootstrap of this cluster left on the role.
  // Roles are cluster-wide; only the database is dropped and recreated.
  await run(url, `REVOKE CREATE ON SCHEMA public FROM ${APP_ROLE}`);
  await run(url, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
});

/* ---- the schema --------------------------------------------------- */

if (!SKIP_SQL) {
  /**
   * ⚠️ THE BASE SCHEMA COMES FROM DRIZZLE AND THE POLICIES COME FROM THE
   * SQL FILES, and that split is not an accident , it is the same split
   * `check:sql-completeness` documents. Roughly fifty tables are created
   * by `drizzle-kit push`; the numbered files then ALTER them to add
   * row-level security.
   *
   * 🔴 `drizzle-kit push` IS BANNED IN PRODUCTION and is correct here.
   * The ban exists because push DROPS RLS policies on 300+ tables. On a
   * database that has no policies yet, there is nothing to drop, and
   * this is the only place in the repository where it is the right tool.
   * `npm run db:push` has a production guard; this calls the wrapper in
   * `scripts/drizzle-kit.mjs` with the test URL so the guard is not the
   * thing being worked around.
   *
   * 🔴 THE WRAPPER IS NOT OPTIONAL. `npx drizzle-kit push --force` in a
   * non-TTY shell prints a BigInt serialisation error, prints a TTY
   * error, creates ZERO tables and EXITS 0. That is what this step did
   * on its first run — 55 tables from a partial earlier attempt, none of
   * them `tenants`, and 2,386 refused statements downstream. The RLS
   * floor at the end of this script is the only reason it was caught.
   */
  await step("push the base schema (drizzle-kit)", async () => {
    const r = spawnSync("node", ["scripts/drizzle-kit.mjs", "push", "--force"], {
      env: { ...process.env, DATABASE_URL: adminUrl(DBNAME), NODE_ENV: "test" },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (r.status !== 0) {
      throw new Error(
        `drizzle-kit push failed:\n${(r.stderr || r.stdout || "").split("\n").slice(-12).join("\n")}`,
      );
    }
    /**
     * 🔴 AND THEN CHECK. A green exit code from a schema tool is not
     * evidence that a schema exists — that is the entire lesson of this
     * step. `tenants` is the table every numbered file references first.
     */
    const check = await run(
      adminUrl(DBNAME),
      `SELECT to_regclass('public.tenants') IS NOT NULL AS present,
              (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS n`,
    );
    if (!check.rows[0].present) {
      throw new Error(
        `push exited 0 and did not create \`tenants\`. ${check.rows[0].n} tables exist. ` +
          `Every numbered SQL file references it, so nothing downstream would apply.`,
      );
    }
    return `${check.rows[0].n} base tables`;
  });

  /**
   * ⭐⭐⭐ `ALL-IN-ONE-SETUP.sql` COMES BETWEEN THEM, AND MISSING IT IS
   * WHY THE FIRST VERSION OF THIS SCRIPT PRODUCED 2,386 REFUSED
   * STATEMENTS AND TWELVE PROTECTED TABLES.
   *
   * 🔴 `drizzle-kit push` DOES NOT CREATE `tenants`, `users`, `roles` OR
   * `audit_logs`. It creates 55 of the 313 tables in `db/schema/`; the
   * rest — including every table `0001_rls_and_audit_guard.sql`
   * immediately references — come from the SQL. That split is documented
   * in `check:sql-completeness` and it is easy to read and still get
   * wrong, because push exits 0 either way.
   *
   * ⚠️ SO THE ORDER IS: push, then ALL-IN-ONE, then the numbered files.
   * `.github/workflows/security-ci.yml` has always done this. This script
   * did not, and the RLS floor at the end is the only reason that was
   * caught rather than shipped as a bootstrap that produces a database
   * every isolation test passes against for the wrong reason.
   */
  await step("apply ALL-IN-ONE-SETUP.sql (the base tables)", async () => {
    const path = join(ROOT, "SQL-FILES", "ALL-IN-ONE-SETUP.sql");
    if (!existsSync(path)) throw new Error("SQL-FILES/ALL-IN-ONE-SETUP.sql is missing");

    const statements = splitStatements(readFileSync(path, "utf8"));
    const url = adminUrl(DBNAME);
    let failed = 0;
    for (const statement of statements) {
      try {
        await run(url, statement);
      } catch (err) {
        failed += 1;
        if (process.env.VERBOSE) console.log(`\n     ALL-IN-ONE: ${err.code} ${err.message}`);
      }
    }
    return `${statements.length} statements, ${failed} refused`;
  });

  await step("apply the numbered SQL files, in order", async () => {
    const dir = join(ROOT, "SQL-FILES");
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();

    let applied = 0;
    let failed = 0;
    const url = adminUrl(DBNAME);

    for (const filename of files) {
      const statements = splitStatements(readFileSync(join(dir, filename), "utf8"));
      for (const statement of statements) {
        try {
          await run(url, statement);
        } catch (err) {
          /**
           * ⚠️ A FAILING STATEMENT IS COUNTED AND DOES NOT STOP THE RUN,
           * which is the OPPOSITE of `scripts/migrate.mjs` and is right
           * here for one reason: this is a fresh database being brought
           * up from nothing, and a handful of the older files assume
           * state that a later file supersedes. The count is printed so
           * the number is visible rather than hidden, and CI applies the
           * same files with `ON_ERROR_STOP=1` where stopping IS correct.
           */
          failed += 1;
          if (process.env.VERBOSE) {
            console.log(`\n     ${filename}: ${err.code} ${err.message}`);
          }
        }
      }
      applied += 1;
    }
    return `${applied} files, ${failed} statement(s) refused`;
  });
}

/* ---- prove RLS is really on ---------------------------------------- */

await step("confirm row-level security is actually enabled", async () => {
  const r = await run(
    adminUrl(DBNAME),
    `SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = true`,
  );
  const n = r.rows[0].n;
  /**
   * 🔴 A FLOOR, AND IT FAILS RATHER THAN WARNS. A test database with no
   * policies would let the whole security suite pass while proving
   * nothing, which is the single most expensive failure this script
   * could allow.
   */
  if (n < 100) {
    throw new Error(
      `only ${n} tables have RLS enabled. Expected at least 100. The SQL files did not ` +
        `apply — running the suite against this database would pass for the wrong reason.`,
    );
  }
  return `${n} tables protected`;
});

await step("build the SQL harness database", async () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐ WHY THIS IS A SECOND, SEPARATE DATABASE
   * ══════════════════════════════════════════════════════════════════
   * `check:sql-executes` runs the close-readiness probes , queries built
   * by string concatenation, so a wrong column name compiles, typechecks
   * and passes every other gate in this repo. It needs a SMALL database
   * with a known seed whose expected answers are exact counts and exact
   * totals. Running it against the full test database gives 0 for every
   * probe, because the seed rows are not there.
   *
   * 🔴 AND WITHOUT `HARNESS_DATABASE_URL` THE GATE SKIPS. It now exits 78
   * rather than 0 so a skip is visible, but the honest fix is for the
   * bootstrap to build the thing the gate needs, so the skip stops
   * happening at all. A gate that always skips locally is a gate that
   * only ever runs in CI, which is where this whole wave started.
   */
  const harnessDb = `${DBNAME}_harness`;
  await run(adminUrl("postgres"), `DROP DATABASE IF EXISTS ${harnessDb}`);
  await run(adminUrl("postgres"), `CREATE DATABASE ${harnessDb}`);

  const url = adminUrl(harnessDb);
  let statements = 0;
  for (const file of ["schema.sql", "seed.sql"]) {
    const path = join(ROOT, "scripts", "harness", file);
    if (!existsSync(path)) {
      throw new Error(`scripts/harness/${file} is missing; check:sql-executes cannot run.`);
    }
    // ⚠️ The harness files are written for psql and use `\set` / `:'NAME'`.
    // Expanded here rather than shelling out, so the bootstrap does not
    // require a psql binary on the developer's machine.
    const text = expandPsqlVariables(readFileSync(path, "utf8"), `scripts/harness/${file}`);
    for (const statement of splitStatements(text)) {
      await run(url, statement);
      statements += 1;
    }
  }
  return `${harnessDb}, ${statements} statements`;
});

await step(`confirm ${APP_ROLE} cannot create a table`, async () => {
  /**
   * 🔴 THE SECOND FLOOR, AND IT FAILS RATHER THAN WARNS.
   *
   * RLS is only a guarantee if every table has it, and every table only
   * has it if the application role cannot make one. With CREATE on the
   * schema, a single stray `CREATE TABLE` anywhere , in the product, in
   * a migration helper, in a debugging session , is an unprotected
   * table that the RLS floor above would not notice, because it counts
   * protected tables rather than unprotected ones.
   */
  const r = await run(
    adminUrl(DBNAME),
    `SELECT has_schema_privilege($1, 'public', 'CREATE') AS can_create`,
    [APP_ROLE],
  );
  if (r.rows[0].can_create) {
    throw new Error(
      `${APP_ROLE} can CREATE in schema public. This database is more permissive ` +
        `than production, so the security suite would prove less than it claims. ` +
        `0019 §9 revokes this — check whether it was among the refused statements.`,
    );
  }

  // And no table in the database is owned by the application role, which is
  // the residue a previous run with CREATE would have left behind.
  const owned = await run(
    adminUrl(DBNAME),
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1`,
    [APP_ROLE],
  );
  if (owned.rows.length > 0) {
    throw new Error(
      `${owned.rows.length} table(s) in this database are owned by ${APP_ROLE}: ` +
        `${owned.rows.map((t) => t.tablename).join(", ")}. The application role made ` +
        `them, which it must not be able to do.`,
    );
  }

  return "no CREATE, no owned tables";
});

/* ---- .env.test ------------------------------------------------------ */

await step("write .env.test", async () => {
  const path = join(ROOT, ".env.test");
  if (existsSync(path) && !process.argv.includes("--force")) {
    return "already exists — pass --force to overwrite";
  }
  writeFileSync(
    path,
    [
      "# Written by scripts/bootstrap-test-db.mjs. Safe to delete and regenerate.",
      "#",
      "# ⚠️ TEST_DATABASE_URL points at a NON-SUPERUSER role with NOBYPASSRLS.",
      "#    That is what makes the isolation tests mean anything.",
      `TEST_DATABASE_URL="postgresql://${APP_ROLE}:${APP_PASS}@${HOST}:${PORT}/${DBNAME}"`,
      "",
      "# ⭐ THE SQL HARNESS. A small database with a known seed, used by",
      "# `check:sql-executes` to prove the close-readiness probes actually run.",
      "# Without it that gate SKIPS, and a gate that always skips locally is a",
      "# gate that only ever runs in CI.",
      "#",
      "# ⚠️ SUPERUSER ON PURPOSE. The harness creates and drops its own fixture",
      "# objects; it is not testing the application role's privileges, and",
      "# giving it the app role would make its failures ambiguous.",
      `HARNESS_DATABASE_URL="postgresql://${SUPERUSER}${SUPERPASS ? ":" + SUPERPASS : ""}@${HOST}:${PORT}/${DBNAME}_harness"`,
      "",
      "# The superuser, for fixtures that legitimately set up state.",
      `TEST_ADMIN_DATABASE_URL="${adminUrl(DBNAME)}"`,
      "",
      "# The suite refuses to start without this. It is meant to be a deliberate act.",
      'ALLOW_DESTRUCTIVE_TESTS="true"',
      'NODE_ENV="test"',
      "",
      "# ══════════════════════════════════════════════════════════════════",
      "# ⚠️ PLACEHOLDER APPLICATION SETTINGS — NOT SECRETS, AND NOT OPTIONAL",
      "# ══════════════════════════════════════════════════════════════════",
      "# Half the security suite drives the REAL application path on",
      "# purpose: `getAccessDecisionForTenant`, the Clerk webhook, the",
      "# lockout. Those call `getServerEnv()`, which validates the whole",
      "# schema and throws on a missing CLERK_SECRET_KEY.",
      "#",
      "# 🔴 AND `server/billing/access.ts` FAILS **OPEN** WHEN IT CANNOT",
      "#    RESOLVE STANDING. So without these lines the billing-gate tests",
      "#    do not error — they PASS THE WRONG WAY: every assertion that a",
      "#    restricted workspace is refused sees a permissive decision and",
      "#    reads it as the gate being broken, or worse, reads a permissive",
      "#    default as correct.",
      "#",
      "# ⚠️ EVERY VALUE HERE IS SYNTACTICALLY VALID AND FUNCTIONALLY DEAD.",
      "# No Clerk instance answers to them. They exist so the schema",
      "# validates and the code under test runs; a real key in this file",
      "# would be a real key in a throwaway database's configuration.",
      'CLERK_SECRET_KEY="sk_test_not_a_real_key_bootstrap_placeholder"',
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_not_a_real_key_bootstrap_placeholder"',
      'CLERK_WEBHOOK_SIGNING_SECRET="whsec_bootstrap_placeholder_not_a_real_secret"',
      'NEXT_PUBLIC_APP_URL="http://localhost:3000"',
      'NEXT_PUBLIC_ROOT_DOMAIN="localhost:3000"',
      'NEXT_PUBLIC_ZONE_DOMAIN="localhost:3000"',
      'PLATFORM_ADMIN_EMAILS="platform@example.test"',
      "",
      "# ⚠️ `DATABASE_URL` IS DELIBERATELY ABSENT FROM THIS FILE.",
      "# `tests/setup.ts` check 5 refuses a TEST_DATABASE_URL identical to",
      "# DATABASE_URL — it cannot tell a deliberate test alias from somebody",
      "# pasting production into the wrong variable, and that check is worth",
      "# more than the convenience. The alias is made in `tests/setup.ts`",
      "# AFTER all six checks have passed. See the note there.",
      "",
    ].join("\n"),
    "utf8",
  );
  return "written";
});

console.log(
  `\n✅ Ready.\n\n` +
    `   npm run test:security\n\n` +
    `   The suite connects as ${APP_ROLE}, which has NOBYPASSRLS — so a policy that is\n` +
    `   missing is a test that fails rather than a test that passes.\n`,
);
