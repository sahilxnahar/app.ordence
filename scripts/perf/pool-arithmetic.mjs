#!/usr/bin/env node
/**
 * Ordence — Track F · CONNECTION POOL ARITHMETIC, COMPUTED NOT GUESSED
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE OUTAGE THIS IS ABOUT
 * ══════════════════════════════════════════════════════════════════════
 * `db/index.ts:257` creates the shared pool like this:
 *
 *     const pool = new Pool({ connectionString: DATABASE_URL });
 *
 * No `max`. No `connectionTimeoutMillis`. Both defaults are inherited
 * silently from node-postgres via `@neondatabase/serverless`, and
 * neither is written down anywhere in the repository.
 *
 *   max                     = 10      connections per Node process
 *   idleTimeoutMillis       = 10000
 *   connectionTimeoutMillis = undefined   ← 🔴 WAIT FOREVER
 *
 * The first number is the one that decides how many replicas Ordence can
 * run. The third is the one that decides what happens on the day it is
 * exceeded: with no timeout, a request that cannot get a connection does
 * not fail — it QUEUES, silently, until something upstream gives up. The
 * symptom is "the site is slow", the cause is invisible, and adding a
 * replica makes it worse.
 *
 * The comment above that line argues correctly that a shared pool is
 * right for Railway's long-lived process — and then does not say how big
 * it is or what happens when it is full. This script says both.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT DOES
 * ══════════════════════════════════════════════════════════════════════
 * ① Reads `db/index.ts` and asserts, from the source, that no `max` is
 *    configured — so this cannot go stale if somebody sets one.
 * ② Reads the real default out of `@neondatabase/serverless`, by
 *    constructing a pool, rather than quoting documentation.
 * ③ Asks the database for `max_connections` and the reserved slots.
 * ④ Computes the replica ceiling and prints the arithmetic.
 *
 * ⚠️ ③ IS THE ONE THAT NEEDS THE RIGHT DATABASE. Run against a local
 * Postgres it reports the local limit, which is not Neon's. It says so
 * in the output rather than pretending. Neon's limit is a function of
 * compute size; the only honest source is `SHOW max_connections` on the
 * production endpoint, and this script never asks for that connection
 * string.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const findings = [];

/* --- ① what the source configures ---------------------------------- */

const dbSrc = readFileSync(join(ROOT, "db", "index.ts"), "utf8");
const poolCall = dbSrc.match(/new Pool\(\{[^}]*\}\)/s)?.[0] ?? "";
const configuresMax = /\bmax\s*:/.test(poolCall);
const configuresConnTimeout = /connectionTimeoutMillis\s*:/.test(poolCall);

console.log(`\nConnection pool arithmetic\n`);
console.log(`  db/index.ts constructs:  ${poolCall.replace(/\s+/g, " ")}`);
console.log(`    max configured?                       ${configuresMax ? "yes" : "NO"}`);
console.log(`    connectionTimeoutMillis configured?   ${configuresConnTimeout ? "yes" : "NO"}`);

/* --- ② the real defaults, from the library ------------------------- */

const probe = new NeonPool({ connectionString: "postgresql://u:p@127.0.0.1:1/none" });
const MAX = probe.options.max ?? 10;
const IDLE = probe.options.idleTimeoutMillis;
const CONN_TIMEOUT = probe.options.connectionTimeoutMillis;
probe.end().catch(() => {});

console.log(`\n  Effective per-process pool (read from @neondatabase/serverless):`);
console.log(`    max                      ${MAX}`);
console.log(`    idleTimeoutMillis        ${IDLE}`);
console.log(
  `    connectionTimeoutMillis  ${CONN_TIMEOUT ?? "undefined  ← a full pool queues forever"}`,
);

if (!configuresConnTimeout && (CONN_TIMEOUT === undefined || CONN_TIMEOUT === 0)) {
  findings.push(
    "connectionTimeoutMillis is unset, so a request that cannot get a connection waits " +
      "indefinitely instead of failing. The pool filling up presents as latency with no " +
      "error anywhere, which is the hardest possible version of this incident to diagnose.",
  );
}
if (!configuresMax) {
  findings.push(
    `The pool size is an inherited default (${MAX}), not a decision. It is the number that ` +
      "caps how many Railway replicas Ordence can run, and it is written down nowhere.",
  );
}

/* --- ③ what the server allows -------------------------------------- */

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";

let maxConnections = null;
let reserved = 0;
let inUse = 0;

try {
  const c = new pg.Client({
    connectionString: `postgresql://${process.env.PGUSER ?? "postgres"}@${HOST}:${PORT}/${DB}`,
  });
  await c.connect();
  maxConnections = Number((await c.query("SHOW max_connections")).rows[0].max_connections);
  reserved = Number(
    (await c.query("SHOW superuser_reserved_connections")).rows[0].superuser_reserved_connections,
  );
  inUse = Number((await c.query("SELECT count(*)::int n FROM pg_stat_activity")).rows[0].n);
  await c.end();
} catch {
  /* reported below */
}

console.log(`\n  Server limits (measured against ${HOST}:${PORT}/${DB}):`);
if (maxConnections === null) {
  console.log(`    max_connections          UNKNOWN — no database reachable`);
} else {
  console.log(`    max_connections          ${maxConnections}`);
  console.log(`    superuser_reserved       ${reserved}`);
  console.log(`    currently in use         ${inUse}`);
}

/* --- ④ the arithmetic ---------------------------------------------- */

/**
 * ⚠️ HEADROOM IS NOT PADDING. It covers the connections nothing in the
 * application accounts for: `scripts/migrate.mjs` (one per statement),
 * the Neon console somebody has open, a `db:studio` session, the
 * readiness probe at `app/api/ready/route.ts`, and — the one that
 * actually bites — the OLD replica during a rolling deploy, which holds
 * its pool until it drains.
 */
const HEADROOM = 15;

console.log(`\n  The arithmetic\n`);
if (maxConnections === null) {
  console.log(`    replicas = (max_connections - superuser_reserved - headroom) / pool_max`);
  console.log(`             = (        ?      -          ?         -    ${HEADROOM}   ) / ${MAX}`);
  console.log(`\n    🔴 Run this on the production endpoint to fill in the blanks:`);
  console.log(`         SHOW max_connections;`);
  console.log(`         SHOW superuser_reserved_connections;`);
  console.log(`         SELECT count(*) FROM pg_stat_activity;`);
} else {
  const usable = maxConnections - reserved - HEADROOM;
  const replicas = Math.floor(usable / MAX);
  console.log(`    usable   = ${maxConnections} - ${reserved} reserved - ${HEADROOM} headroom = ${usable}`);
  console.log(`    replicas = floor(${usable} / ${MAX} per process) = ${replicas}`);
  console.log(`\n    At ${MAX} connections per process, Ordence can run ${replicas} replica(s)`);
  console.log(`    against a server with max_connections = ${maxConnections}.`);
  console.log(`\n    ⚠️ THIS IS THE LOCAL POSTGRES, NOT NEON. Neon's max_connections is a`);
  console.log(`       function of compute size and is typically far lower than a default`);
  console.log(`       local build. The formula is the deliverable; the number is not,`);
  console.log(`       until somebody runs SHOW max_connections on the real endpoint.`);
}

console.log(`\n  ⚠️ AND THE POOLED ENDPOINT CHANGES THE ANSWER ENTIRELY.`);
console.log(`     Neon publishes two hostnames: a direct one, and a "-pooler" one that`);
console.log(`     fronts PgBouncer in transaction mode and accepts thousands of client`);
console.log(`     connections. On the pooler the arithmetic above stops binding — and a`);
console.log(`     different constraint starts: transaction-mode pooling does not carry`);
console.log(`     session state, which is safe here ONLY because every setting Ordence`);
console.log(`     uses is written with set_config(..., is_local => true) inside an`);
console.log(`     explicit transaction (db/index.ts:311). Session-scoped settings on a`);
console.log(`     transaction pooler would be the cross-tenant leak that comment warns`);
console.log(`     about. Which endpoint DATABASE_URL points at is therefore a tenant`);
console.log(`     isolation decision as well as a capacity one, and this repository does`);
console.log(`     not record which one is in use.`);

if (findings.length > 0) {
  console.log(`\n  Findings\n`);
  for (const f of findings) console.log(`    🔴 ${f}\n`);
}
console.log("");
