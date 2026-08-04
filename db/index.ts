/**
 * Ordence — Serverless Database Client
 * Version: v0.1.0-alpha
 *
 * WHY THIS SHAPE (Blueprint: "Vercel Architecture Principles"):
 * Vercel functions are short-lived and can scale to hundreds of concurrent
 * instances. A traditional TCP connection pool would exhaust Postgres'
 * connection limit almost immediately. Neon's serverless driver speaks HTTP,
 * so every query is a stateless fetch — no pool to leak, no cold-start penalty,
 * and it works inside the Edge runtime.
 *
 * Two clients are exported:
 *   `db`         — HTTP, single-shot queries. Default for reads/writes.
 *   `withTenant` — WebSocket transaction that pins tenant context for RLS.
 */

import { neon, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { drizzle as drizzleServerless } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index";
import { getServerEnv } from "@/lib/env";

// Neon caches fetch connections automatically on warm instances.

/* ------------------------------------------------------------------ */
/* PRIMARY CLIENT — HTTP, stateless                                    */
/* ------------------------------------------------------------------ */

function createDb() {
  const { DATABASE_URL } = getServerEnv();
  const client = neon(DATABASE_URL);
  return drizzle(client, {
    schema,
    logger: process.env.NODE_ENV === "development",
  });
}

type Db = ReturnType<typeof createDb>;

// Reuse across hot reloads in dev; avoids exhausting connections locally.
const globalForDb = globalThis as unknown as { __ordenceDb?: Db };

let cachedDb: Db | null = null;

/**
 * Build the client on FIRST USE, never at import.
 *
 * ⚠️ This used to be `export const db = globalForDb.__ordenceDb ?? createDb()`
 * — a single line that ran the moment ANY module imported `db`, which meant
 * it also ran during `next build`, in a build container that has no database
 * credentials and should not have any.
 *
 * The build failed like this, and the message named the wrong file:
 *
 *     Error: Invalid server environment variables:
 *       • DATABASE_URL: Required
 *       • CLERK_SECRET_KEY: Required
 *     Failed to collect page data for /api/documents/[id]/download
 *
 * That route was merely the first thing Next.js happened to import. Any of
 * fifty others would have produced the same error with a different name on
 * it, which is what made it hard to chase.
 *
 * Deferring creation means the credentials are read when a REQUEST arrives —
 * on the running Worker, where they exist — rather than on the build machine,
 * where they never will.
 */
function getDb(): Db {
  if (cachedDb) return cachedDb;
  if (globalForDb.__ordenceDb) {
    cachedDb = globalForDb.__ordenceDb;
    return cachedDb;
  }
  cachedDb = createDb();
  if (process.env.NODE_ENV !== "production") globalForDb.__ordenceDb = cachedDb;
  return cachedDb;
}

/**
 * The Drizzle client, exported with its original shape.
 *
 * ⚠️ A Proxy rather than the object itself. Every call site in the codebase
 * writes `db.select(...)`, `db.query.contacts...`, `db.transaction(...)`, and
 * all of those keep working unchanged — the difference is only WHEN the
 * underlying client comes into existence. Rewriting several hundred call
 * sites to `getDb().select(...)` would have achieved the same thing and
 * risked missing one; a missed one is a build failure with a misleading
 * message, which is precisely the problem being solved.
 *
 * Methods are bound to the real client. Without the bind, Drizzle's internals
 * would receive the Proxy as `this` and re-enter this trap on every internal
 * property read.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
  has(_target, prop) {
    return prop in (getDb() as unknown as object);
  },
  ownKeys() {
    return Reflect.ownKeys(getDb() as unknown as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Reflect.getOwnPropertyDescriptor(
      getDb() as unknown as object,
      prop,
    );
    // The Proxy invariant: a descriptor reported for a non-existent target
    // property must be configurable, or the engine throws a TypeError.
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
});

export { schema };
export type Database = typeof db;

/* ------------------------------------------------------------------ */
/* TENANT-SCOPED TRANSACTION — the RLS enforcement path                */
/* ------------------------------------------------------------------ */

/**
 * Runs `callback` inside a REAL TRANSACTION where `app.current_tenant_id` is
 * pinned. Every Row-Level Security policy reads that setting, so any query
 * issued inside this block is physically incapable of returning another
 * tenant's rows — even if the application forgot its own WHERE clause.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE EXPLICIT `transaction()` WRAPPER IS LOAD-BEARING
 * ══════════════════════════════════════════════════════════════════════
 * `set_config(name, value, is_local)` behaves in two very different ways,
 * and BOTH of the obvious approaches are wrong here.
 *
 * `is_local = true` scopes the setting to the CURRENT TRANSACTION. Outside
 * an explicit transaction every statement is its own implicit transaction,
 * so the setting is discarded the instant the `SELECT set_config(...)`
 * returns. A later query in the same callback then sees an EMPTY tenant,
 * RLS matches nothing, and every read comes back with ZERO ROWS.
 *
 * That was the behaviour of this function before v0.9.0. It fails CLOSED —
 * no data leaked — but it meant `withTenant()` silently returned nothing.
 * Verified against PostgreSQL 16:
 *
 *     set_config(..., true) then a separate query  ->  ""
 *     same, inside BEGIN/COMMIT                    ->  "<tenant-uuid>"
 *
 * `is_local = false` is the tempting fix and it is DANGEROUS. It sets the
 * value for the whole SESSION — that is, the pooled CONNECTION. The
 * connection then goes back to the pool still carrying tenant A's id, and
 * the next request to borrow it inherits that context. Also verified:
 *
 *     set_config(..., false); release(); connect()  ->  "<previous tenant>"
 *
 * A cross-tenant leak, from the "fix".
 *
 * So: an explicit transaction, with `is_local = true` inside it. The
 * setting survives for every statement in the callback and is discarded at
 * COMMIT, before the connection is reused.
 *
 * @example
 *   const rows = await withTenant(tenantId, (tx) => tx.select().from(users));
 */
export type WithTenantOptions = {
  /**
   * ⭐ THE LIVE IMPERSONATION SESSION ID, OR NULL — v0.31.0.
   *
   * ══════════════════════════════════════════════════════════════════
   * WHAT THIS ARMS, AND WHY IT LIVED IN THE DATABASE FIRST
   * ══════════════════════════════════════════════════════════════════
   * `SQL-FILES/0014_phase17_platform.sql` installs
   * `refuse_delete_under_impersonation()` on nineteen tables holding
   * customer records, financial history, money and access. It reads
   * `app.impersonation_id` and refuses every DELETE while that setting
   * is present.
   *
   * Until this option existed, NOTHING SET IT. The trigger was
   * installed, correct, tested — and inert, because `withTenant()`
   * pinned only the tenant. The SQL file says so in its own comments;
   * this is the other half.
   *
   * ⚠️ TRANSACTION-LOCAL, exactly like the tenant id, and for exactly
   * the same reason: `is_local = false` would leave the marker on a
   * POOLED CONNECTION, so the next borrower — an ordinary customer
   * request — would inherit it and find itself unable to delete
   * anything, with no explanation anywhere.
   *
   * ⚠️ NULL AND UNDEFINED BOTH MEAN "NOT IMPERSONATING", and the
   * setting is then never issued at all. A guard that fires for
   * ordinary traffic is an outage.
   */
  impersonationId?: string | null;
};

export async function withTenant<T>(
  tenantId: string,
  callback: (tx: Parameters<Parameters<ReturnType<typeof drizzleServerless<typeof schema>>["transaction"]>[0]>[0]) => Promise<T>,
  options?: WithTenantOptions,
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new Error("[SECURITY] withTenant() called with a malformed tenant id.");
  }

  const impersonationId = options?.impersonationId ?? null;

  // ⚠️ Shape-checked before it reaches `set_config`. It is bound as a
  // parameter and never concatenated, so this is not about injection —
  // it is that `app_current_impersonation_id()` casts the setting to
  // `uuid`, and a malformed value there raises `invalid input syntax`
  // from inside a BEFORE DELETE trigger on nineteen tables. Refusing
  // early names the caller instead of the trigger.
  if (impersonationId !== null && !isUuid(impersonationId)) {
    throw new Error("[SECURITY] withTenant() called with a malformed impersonation id.");
  }

  const { DATABASE_URL } = getServerEnv();
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const database = drizzleServerless(pool, { schema });

    return await database.transaction(async (tx) => {
      // Parameterised — tenantId is never string-concatenated into SQL.
      // `true` = transaction-local, which is only meaningful because we are
      // genuinely inside a transaction here.
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);

      if (impersonationId !== null) {
        await tx.execute(
          sql`SELECT set_config('app.impersonation_id', ${impersonationId}, true)`,
        );
      }

      return callback(tx);
    });
  } finally {
    // Always release; a leaked pool on a serverless instance is a hard outage.
    await pool.end();
  }
}

/**
 * Escape hatch for genuine platform-wide reads (super-admin tooling,
 * resolving a payment webhook to a tenant). Deliberately verbose so it is
 * easy to grep for in a security review — every call site must justify
 * itself in writing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FUNCTION READ ZERO ROWS UNTIL v0.14.1. THE FIX IS BELOW.
 * ══════════════════════════════════════════════════════════════════════
 * It used to hand back the plain `db` client on the assumption that "no
 * tenant context" meant "unrestricted". It does not. Every RLS policy
 * reads `tenant_id = app_current_tenant_id()`, and with no context set
 * that is `tenant_id = NULL` — which is NULL in SQL, never TRUE.
 *
 * Measured against PostgreSQL 16:
 *     rows in `tenants`                        12
 *     rows visible to withPlatformScope()       0
 *
 * It failed CLOSED, so nothing ever leaked — but the Phase 11 webhook
 * resolver could never have matched a subscription, and every real
 * payment event would have resolved to "unknown tenant" the moment
 * traffic arrived. It had simply never been exercised against a database
 * with RLS in force.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY AN EXPLICIT MARKER RATHER THAN A PRIVILEGED ROLE
 * ══════════════════════════════════════════════════════════════════════
 * The obvious alternative is a second connection as a role with
 * BYPASSRLS. It works, and it was rejected: it needs a second connection
 * string the operator must configure correctly, and if they get it wrong
 * the failure is a role that bypasses isolation everywhere rather than
 * here.
 *
 * `app.platform_scope` is an OPT-IN. The old behaviour was satisfied by
 * FORGETTING to set something; this one requires saying so. That
 * difference is the whole point — a path that neglects to open a tenant
 * transaction now sees nothing, instead of being one policy edit away
 * from seeing everything.
 *
 * ⚠️ READ ONLY. The marker appears in every policy's USING clause and in
 * NO policy's WITH CHECK clause, so this function cannot write across
 * tenants. Verified: an INSERT against another tenant's `audit_logs`
 * under this marker is still refused by RLS. A cross-tenant write has no
 * legitimate caller here, and leaving it impossible costs nothing.
 *
 * ⚠️ Requires `SQL-FILES/ALL-IN-ONE-SETUP.sql` at v0.14.1 or later. On an
 * older database the marker is simply unknown to the policies and this
 * function reverts to reading zero rows — degraded, but still closed.
 */
export async function withPlatformScope<T>(
  reason: string,
  callback: (tx: Parameters<Parameters<ReturnType<typeof drizzleServerless<typeof schema>>["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!reason || reason.length < 10) {
    throw new Error("[SECURITY] withPlatformScope() requires a written justification.");
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[PLATFORM SCOPE] Reading across tenants: ${reason}`);
  }

  const { DATABASE_URL } = getServerEnv();
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const database = drizzleServerless(pool, { schema });

    return await database.transaction(async (tx) => {
      // Transaction-local, exactly as in `withTenant()` — so the marker is
      // discarded at COMMIT and cannot leak to the next borrower of a
      // pooled connection.
      await tx.execute(sql`SELECT set_config('app.platform_scope', 'on', true)`);
      return callback(tx);
    });
  } finally {
    await pool.end();
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
