/**
 * Ordence — Test Environment Guard
 * Version: v0.6.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE EXISTS TO STOP ONE SPECIFIC DISASTER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * These tests CREATE tenants, INSERT rows, and DELETE everything they made.
 * If they ever ran against production, they would destroy live customer data.
 *
 * That is not a hypothetical. It happens to real teams, usually like this:
 * someone copies `.env.local` to `.env.test` "just to get the tests running",
 * forgets, and two weeks later the cleanup step wipes a customer's ledger.
 *
 * So this file refuses to let the suite start unless EVERY check passes:
 *
 *   1. `.env.test` must exist. No silent fallback to `.env.local`.
 *   2. `TEST_DATABASE_URL` must be set — a different variable name from the
 *      production `DATABASE_URL`, so a copy-paste cannot smuggle it in.
 *   3. The URL must contain an explicit test marker (`test`, `_test`, `localhost`
 *      or `127.0.0.1`).
 *   4. It must NOT match any known production hostname pattern.
 *   5. It must NOT equal `DATABASE_URL`, if that happens to be set.
 *   6. `ALLOW_DESTRUCTIVE_TESTS=true` must be present — a deliberate,
 *      typed-by-a-human acknowledgement.
 *
 * Any failure aborts the whole run with a loud message. Fail closed, always.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

/* ------------------------------------------------------------------ */
/* 1. LOAD .env.test — AND ONLY .env.test                              */
/* ------------------------------------------------------------------ */

const ENV_TEST_PATH = resolve(process.cwd(), ".env.test");

if (!existsSync(ENV_TEST_PATH)) {
  abort(
    "`.env.test` not found.",
    [
      "Tests will not run without it — falling back to .env.local would risk",
      "pointing this destructive suite at your real database.",
      "",
      "Create it with:",
      "",
      "    cp .env.test.example .env.test",
      "",
      "then edit it to point at a THROWAWAY database.",
    ].join("\n"),
  );
}

// `override: true` so a stray value already in the shell cannot win.
config({ path: ENV_TEST_PATH, override: true });

/* ------------------------------------------------------------------ */
/* 2–6. THE GUARD                                                      */
/* ------------------------------------------------------------------ */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const PRODUCTION_DATABASE_URL = process.env.DATABASE_URL;

/** Hostname fragments that indicate a managed/production database. */
const PRODUCTION_MARKERS = [
  ".neon.tech",
  ".supabase.co",
  ".rds.amazonaws.com",
  ".render.com",
  ".railway.app",
  ".planetscale",
  ".azure.com",
  ".cloudsql",
  "prod",
  "production",
] as const;

/** Fragments that positively identify a safe, disposable target. */
const TEST_MARKERS = ["localhost", "127.0.0.1", "test", "_test", "ameya_test"] as const;

if (!TEST_DATABASE_URL) {
  abort(
    "TEST_DATABASE_URL is not set.",
    [
      "This must be a SEPARATE variable from DATABASE_URL. That separation is",
      "deliberate: copying your production connection string in would not work,",
      "because the name would be wrong.",
      "",
      "Add to .env.test:",
      "",
      "    TEST_DATABASE_URL=\"postgresql://postgres@localhost:5432/ameya_test\"",
    ].join("\n"),
  );
}

const lowerUrl = TEST_DATABASE_URL.toLowerCase();

// --- Check 3: must positively look like a test database ---
const hasTestMarker = TEST_MARKERS.some((m) => lowerUrl.includes(m));
if (!hasTestMarker) {
  abort(
    "TEST_DATABASE_URL does not look like a test database.",
    [
      `  Got: ${maskUrl(TEST_DATABASE_URL)}`,
      "",
      "It must contain one of: localhost, 127.0.0.1, test, _test",
      "",
      "This suite CREATES AND DELETES data. Point it at a throwaway database.",
    ].join("\n"),
  );
}

// --- Check 4: must not look like production ---
const productionHit = PRODUCTION_MARKERS.find((m) => lowerUrl.includes(m));
if (productionHit) {
  // A managed host is allowed ONLY if the database name itself says test.
  const dbName = lowerUrl.split("/").pop()?.split("?")[0] ?? "";
  const dbNameIsTest = dbName.includes("test");

  if (!dbNameIsTest) {
    abort(
      "🚨 TEST_DATABASE_URL points at what looks like a PRODUCTION database.",
      [
        `  Matched: "${productionHit}"`,
        `  URL:     ${maskUrl(TEST_DATABASE_URL)}`,
        "",
        "REFUSING TO RUN. This suite would create and delete data.",
        "",
        "If this really is a disposable branch on a managed host, name the",
        "database itself with 'test' in it (e.g. `ameya_test`) and try again.",
      ].join("\n"),
    );
  }
}

// --- Check 5: must not equal the production URL ---
if (PRODUCTION_DATABASE_URL && TEST_DATABASE_URL === PRODUCTION_DATABASE_URL) {
  abort(
    "🚨 TEST_DATABASE_URL is IDENTICAL to DATABASE_URL.",
    [
      "This is the exact mistake this guard exists to catch.",
      "",
      "REFUSING TO RUN.",
    ].join("\n"),
  );
}

// --- Check 6: explicit human acknowledgement ---
if (process.env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
  abort(
    "ALLOW_DESTRUCTIVE_TESTS is not set to 'true'.",
    [
      "These tests create and delete data. That acknowledgement has to be",
      "typed by a person, not inherited from somewhere.",
      "",
      "Add to .env.test:",
      "",
      "    ALLOW_DESTRUCTIVE_TESTS=\"true\"",
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------ */
/* CONFIRMATION BANNER                                                 */
/* ------------------------------------------------------------------ */

console.log(`
┌────────────────────────────────────────────────────────────────┐
│  ORDENCE — SECURITY TEST SUITE                                 │
├────────────────────────────────────────────────────────────────┤
│  Target: ${maskUrl(TEST_DATABASE_URL).padEnd(53)}│
│  Guard:  ✅ all 6 production-safety checks passed              │
└────────────────────────────────────────────────────────────────┘
`);

/* ------------------------------------------------------------------ */
/* SHARED POOL                                                         */
/* ------------------------------------------------------------------ */

/**
 * A raw `pg` pool, deliberately NOT Drizzle.
 *
 * These tests must prove the DATABASE enforces isolation. Going through the ORM
 * would test the ORM's filtering as much as the database's. Raw SQL removes that
 * ambiguity: if a query returns rows it should not, the database let it through.
 */
/**
 * ⚠️ `max` MUST EXCEED THE LARGEST NUMBER OF SIMULTANEOUS CONNECTIONS ANY
 * SINGLE TEST NEEDS, WITH HEADROOM.
 *
 * It was 4. `tests/security/metering-isolation.test.ts` opens exactly 4
 * concurrent connections to prove the counter upsert is atomic under real
 * contention — which is the central claim of Phase 15 and cannot be tested
 * any other way.
 *
 * Sized exactly to demand, the pool had no slack. A connection still being
 * reaped from a previous file (`idleTimeoutMillis` is 5s) left three slots
 * free, the fourth worker waited, and `connectionTimeoutMillis` failed it
 * after ten seconds. The suite then reported a CONCURRENCY test failing —
 * pointing at the code under test rather than at the harness.
 *
 * That is the worst shape a flake can take in a security suite: it looks
 * like the thing you are most worried about, so it trains people to re-run
 * until green instead of investigating. Observed once after a database
 * restart, then unreproducible across five consecutive full runs.
 *
 * Doubled, so the concurrency test has slack and a future test needing more
 * than four has room before it starts producing the same misleading signal.
 */
export const testPool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Separate ADMIN connection, used only for fixture setup and teardown.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY TWO POOLS — THIS IS THE MOST IMPORTANT DETAIL IN THE FILE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A PostgreSQL SUPERUSER bypasses Row-Level Security completely. Not partially —
 * completely. `FORCE ROW LEVEL SECURITY` makes policies apply to the table
 * OWNER, but a superuser (or any role with BYPASSRLS) still sees everything.
 *
 * So a test suite that connects as `postgres` would pass every isolation
 * assertion while proving NOTHING. It would report green forever, including
 * on the day someone drops a policy.
 *
 * Therefore:
 *   testPool  → a NON-superuser role, exactly like the application uses.
 *               Every assertion runs here.
 *   adminPool → superuser, used ONLY to create and destroy fixtures.
 *
 * If `adminPool` ever appears inside an assertion, that assertion is worthless.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? TEST_DATABASE_URL;

export const adminPool = new Pool({
  connectionString: ADMIN_URL,
  max: 2,
  idleTimeoutMillis: 5_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Run a callback inside a transaction with tenant context pinned — the same
 * mechanism the application uses in `withTenant()`.
 */
export async function asTenant<T>(
  tenantId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run with NO tenant context. Used to prove the fail-closed default:
 * no context must mean zero rows, never all rows.
 */
export async function withoutTenant<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run with the PLATFORM SCOPE marker set — the same thing
 * `withPlatformScope()` does in `db/index.ts`.
 *
 * ⚠️ NOT the same as `withoutTenant()`, and the difference is the whole
 * point of the v0.14.1 fix. "No tenant context" used to be assumed to
 * mean "unrestricted"; it actually meant `tenant_id = NULL`, which is
 * never TRUE, so the escape hatch read ZERO ROWS from every table.
 *
 * Platform scope is now an explicit opt-in, and it is READ-ONLY and
 * NARROW: it reaches tenants, users, subscriptions, invoices, payment,
 * usage and observability rows — never customer content.
 */
export async function asPlatform<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.platform_scope', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Escape hatch that BYPASSES RLS — used only for test setup and teardown,
 * where fixtures must be created across tenants.
 *
 * Named to be obvious in a diff. If this appears inside an assertion, the test
 * is not proving what it claims to prove.
 */
export async function asSuperuser<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Capture the error a query raises, or null if it unexpectedly succeeded. */
export async function expectError(
  fn: () => Promise<unknown>,
): Promise<{ message: string; code?: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    return { message: e.message ?? String(err), code: e.code };
  }
}

/* ------------------------------------------------------------------ */
/* LIFECYCLE                                                           */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  // Prove connectivity before any test claims a database-level guarantee.
  const client = await testPool.connect();
  try {
    const { rows } = await client.query(`
      SELECT current_database() AS db,
             current_user       AS usr,
             (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_super,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `);
    const info = rows[0];
    console.log(`  Connected to: ${info?.db} as ${info?.usr}`);

    // THE CHECK THAT MAKES THIS SUITE MEAN ANYTHING.
    // A superuser bypasses RLS entirely — every isolation assertion would pass
    // while proving nothing at all.
    if (info?.is_super || info?.bypass_rls) {
      throw new Error(
        `\n\n🚨 TEST_DATABASE_URL connects as "${info.usr}", which ` +
          `${info.is_super ? "is a SUPERUSER" : "has BYPASSRLS"}.\n\n` +
          "Superusers bypass Row-Level Security completely. Every isolation\n" +
          "test would PASS while proving nothing — including on the day a\n" +
          "policy gets dropped.\n\n" +
          "Create a normal role and use it instead:\n\n" +
          "  CREATE ROLE ordence_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;\n" +
          "  GRANT USAGE ON SCHEMA public TO ordence_app;\n" +
          "  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ordence_app;\n",
      );
    }
    console.log("  RLS check: ✅ non-superuser role — isolation tests are meaningful");
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await Promise.all([testPool.end(), adminPool.end()]);
});

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/** Hide credentials before printing a connection string. */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const db = parsed.pathname.replace("/", "");
    return `${parsed.protocol}//***@${host}:${parsed.port || "5432"}/${db}`;
  } catch {
    return "***";
  }
}

/** Print a loud failure and stop the process. */
function abort(title: string, detail: string): never {
  const line = "═".repeat(66);
  console.error(`\n${line}`);
  console.error(`  TEST SUITE ABORTED — ${title}`);
  console.error(line);
  console.error(`\n${detail}\n`);
  console.error(line + "\n");
  process.exit(1);
}
