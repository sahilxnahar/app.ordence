#!/usr/bin/env node
/**
 * Ordence — Track F · PROVE OR REJECT EVERY INDEX CANDIDATE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCRIPT EXISTS TO REJECT MY OWN WORK
 * ══════════════════════════════════════════════════════════════════════
 * The failure mode this repository keeps producing is a thing that was
 * built, looked right, and was never reached. An index is unusually good
 * at that failure: it appears in `pg_indexes`, it appears in the
 * migration, `check:migrations` goes green — and the planner never picks
 * it, so it is a permanent write tax that buys nothing. Nothing in the
 * existing gates would notice.
 *
 * For each candidate in `db/indexes/candidates.mjs` this:
 *
 *   1. measures the claimed queries WITHOUT it,
 *   2. creates it, ANALYZEs, and measures again,
 *   3. reads the resulting plan and checks THE INDEX NAME APPEARS IN IT,
 *   4. drops it, restoring the database exactly,
 *   5. accepts it only if it was used AND removed at least
 *      `minImprovement` of the median time.
 *
 * Step 3 is the one that matters. A candidate that makes the query
 * faster by accident, without the planner touching it, is not evidence.
 *
 * Everything runs as `ordence_app` with the tenant pinned, so the plans
 * are the plans the application gets — see `scripts/perf/measure.mjs`
 * for why measuring as a superuser would be measuring a different query.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT WORKS ON A DATABASE THAT ALREADY HAS THE MIGRATIONS APPLIED,
 *    AND THE FIRST VERSION DID NOT.
 * ══════════════════════════════════════════════════════════════════════
 * The first version assumed a virgin database. Run against the assembled
 * wave-16 tree — where 0151–0154 are already applied — it did two wrong
 * things and reported neither:
 *
 *   ① `CREATE INDEX IF NOT EXISTS` was a no-op, so the "before"
 *      measurement was taken WITH the index present. Before and after
 *      were the same plan, the candidate looked useless, and the verdict
 *      was garbage.
 *   ② It then ran `DROP INDEX`, DELETING A SHIPPED INDEX from a
 *      database that had it legitimately. Observed: `sales_invoices_tenant_due_idx`
 *      count 1 before the run, 0 after.
 *
 * And the leftover assertion could not tell the difference either: it
 * flagged the three OTHER accepted indexes as "left behind by this run"
 * when they were simply applied by their migrations.
 *
 * ⭐ SO STATE IS RECORDED, NOT ASSUMED. For each candidate the harness
 * records whether the index already existed, drops it before the
 * "before" measurement if so, and RESTORES exactly what it found at the
 * end. The final assertion compares against that recorded state rather
 * than against "absent".
 *
 * Usage:
 *   node scripts/perf/prove-indexes.mjs
 *   node scripts/perf/prove-indexes.mjs --only=sales_invoices_tenant_due_idx
 */

import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { QUERIES, EXTRA_PARAMS, BIG_TENANT_SLUG } from "./queries.mjs";
import { CANDIDATES } from "../../db/indexes/candidates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7);
const RUNS = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 9);

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = process.env.PGPORT ?? "5432";
const DB = process.env.TEST_DB_NAME ?? "ordence_test";
const APP_PASS = process.env.TEST_APP_PASSWORD ?? "test_only_not_a_secret";

if (!["localhost", "127.0.0.1", "::1"].includes(HOST) || !/test/i.test(DB)) {
  console.error(`\n🔴 REFUSING: ${HOST}/${DB} is not obviously a throwaway database.\n`);
  console.error(`   This script CREATES AND DROPS INDEXES. Never point it at Neon.\n`);
  process.exit(2);
}

const admin = new pg.Client({
  connectionString: `postgresql://${process.env.PGUSER ?? "postgres"}@${HOST}:${PORT}/${DB}`,
});
const app = new pg.Client({
  connectionString: `postgresql://ordence_app:${APP_PASS}@${HOST}:${PORT}/${DB}`,
});
await admin.connect();
await app.connect();

const tenantId = (await admin.query(`SELECT id FROM tenants WHERE slug = $1`, [BIG_TENANT_SLUG]))
  .rows[0]?.id;
if (!tenantId) {
  console.error(`\n🔴 No "${BIG_TENANT_SLUG}" tenant. Run scripts/perf/seed-load.mjs first.\n`);
  process.exit(1);
}

const ctx = {
  ledgerId: (
    await admin.query(
      `SELECT ledger_id FROM journal_entries WHERE tenant_id=$1 GROUP BY ledger_id ORDER BY count(*) DESC LIMIT 1`,
      [tenantId],
    )
  ).rows[0]?.ledger_id,
  transactionId: (await admin.query(`SELECT id FROM transactions WHERE tenant_id=$1 LIMIT 1`, [tenantId]))
    .rows[0]?.id,
  invoiceId: (await admin.query(`SELECT id FROM sales_invoices WHERE tenant_id=$1 LIMIT 1`, [tenantId]))
    .rows[0]?.id,
};

const byId = new Map(QUERIES.map((q) => [q.id, q]));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function timed(q, { forceIndex = false } = {}) {
  const params = [tenantId, ...(EXTRA_PARAMS[q.id] ? EXTRA_PARAMS[q.id](ctx) : [])];
  const samples = [];
  for (let i = 0; i <= RUNS; i++) {
    await app.query("BEGIN");
    await app.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    if (forceIndex) await app.query("SET LOCAL enable_seqscan = off");
    const t = process.hrtime.bigint();
    await app.query(q.sql, params);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    await app.query("ROLLBACK");
    if (i > 0) samples.push(ms); // discard the warm-up
  }
  await app.query("BEGIN");
  await app.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
  if (forceIndex) await app.query("SET LOCAL enable_seqscan = off");
  const plan = (
    await app.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, params)
  ).rows[0]["QUERY PLAN"][0];
  await app.query("ROLLBACK");
  return { ms: median(samples), plan, planText: JSON.stringify(plan) };
}

/**
 * ⚠️ The buffer count, not just the clock. On Neon, pages come over a
 * network; a plan that touches 6,861 buffers instead of 1,971 costs far
 * more in production than the local millisecond difference suggests.
 * An index rejected on wall-clock alone might still be the right call —
 * so both numbers are reported and the reasoning is written down.
 */
function buffers(plan) {
  let total = 0;
  (function walk(n) {
    total += Number(n["Shared Hit Blocks"] ?? 0) + Number(n["Shared Read Blocks"] ?? 0);
    for (const c of n["Plans"] ?? []) walk(c);
  })(plan["Plan"]);
  return total;
}

/**
 * ⚠️ THE STATE THIS RUN MUST HAND BACK. Captured before anything is
 * touched, and asserted against at the end. `defOf` keeps the real
 * definition so a pre-existing index can be recreated exactly as it was
 * — including a partial predicate or a DESC column, neither of which the
 * candidate's own DDL is guaranteed to reproduce.
 */
const preExisting = new Map();
for (const cand of CANDIDATES) {
  const row = (
    await admin.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [cand.id],
    )
  ).rows[0];
  preExisting.set(cand.id, row?.indexdef ?? null);
}
const alreadyThere = [...preExisting.entries()].filter(([, def]) => def !== null);
if (alreadyThere.length > 0) {
  console.log(
    `\n⚠️  ${alreadyThere.length} candidate index(es) are ALREADY APPLIED on this database:\n` +
      alreadyThere.map(([id]) => `      ${id}`).join("\n") +
      `\n   Each is dropped before its "before" measurement and restored afterwards.\n` +
      `   Without that the before/after comparison would be the same plan twice.`,
  );
}

const report = [];
console.log(`\nProving ${CANDIDATES.length} index candidates against tenant ${BIG_TENANT_SLUG}\n`);

for (const cand of CANDIDATES) {
  if (ONLY && cand.id !== ONLY) continue;

  const claimed = cand.claims.map((id) => byId.get(id)).filter(Boolean);
  if (claimed.length === 0) {
    console.log(`  ⚠️  ${cand.id} — claims no query in the catalogue. Rejected.`);
    report.push({ ...cand, verdict: "rejected", reason: "claims no catalogued query" });
    continue;
  }

  /*
   * 🔴 THE FIX. If the index is already applied, the "before" state is
   * not "the database as found" — it is "the database without this
   * index", which is the only thing the comparison can mean.
   */
  if (preExisting.get(cand.id)) {
    await admin.query(`DROP INDEX IF EXISTS ${cand.id}`);
    await admin.query(`ANALYZE ${cand.table}`);
  }

  const before = {};
  for (const q of claimed) before[q.id] = await timed(q);

  /**
   * ⚠️ NOT `CONCURRENTLY` HERE, ON PURPOSE. This is a throwaway database
   * and a plain CREATE INDEX is faster and transactional. The MIGRATION
   * that ships uses `CONCURRENTLY`, because on Neon a plain CREATE INDEX
   * takes an ACCESS EXCLUSIVE lock and every write to that table blocks
   * for the duration.
   */
  await admin.query(cand.ddl);
  await admin.query(`ANALYZE ${cand.table}`);

  const after = {};
  for (const q of claimed) after[q.id] = await timed(q);

  const used = claimed.some((q) => after[q.id].planText.includes(cand.id));

  /**
   * ⭐ WHEN THE PLANNER DECLINES, ASK WHAT IT WAS DECLINING.
   *
   * `enable_seqscan = off` is not a proposal — never ship a planner
   * override. It is a question: "if you HAD used this index, what would
   * it have cost?" The answer separates two very different rejections:
   * an index that is genuinely useless, and an index that is useful but
   * loses to a cost model calibrated for local disk. On Neon, where
   * every page miss is a network round trip, `random_page_cost = 4` is
   * very likely the wrong number — and that is a finding, not a fix.
   */
  let forced = null;
  if (!used) {
    forced = {};
    for (const q of claimed) forced[q.id] = await timed(q, { forceIndex: true });
  }

  const improvements = claimed.map((q) => {
    const b = before[q.id].ms;
    const a = after[q.id].ms;
    return b > 0 ? (b - a) / b : 0;
  });
  const bufferImprovements = claimed.map((q) => {
    const b = buffers(before[q.id].plan);
    const a = buffers(after[q.id].plan);
    return b > 0 ? (b - a) / b : 0;
  });
  const best = Math.max(...improvements);
  const bestBuffers = Math.max(...bufferImprovements);

  /*
   * ⚠️ RESTORE WHAT WAS FOUND, not what is convenient. An index that was
   * applied by a migration goes back exactly as its `pg_indexes`
   * definition described it; one that was not stays dropped.
   */
  const original = preExisting.get(cand.id);
  await admin.query(`DROP INDEX IF EXISTS ${cand.id}`);
  if (original) await admin.query(original);
  await admin.query(`ANALYZE ${cand.table}`);

  /**
   * ⚠️ TWO CURRENCIES, AND THE SECOND ONE IS THE ONE THAT MATTERS IN
   * PRODUCTION. Wall-clock here is measured against a local SSD with
   * everything in shared buffers. Ordence runs on Neon: pages that miss
   * shared buffers are fetched over a network from a page server. So a
   * candidate that removes most of the buffer traffic is worth taking
   * even when the local clock barely moves — and the report says which
   * criterion carried it, so nobody has to guess later.
   */
  let verdict, reason;
  if (!used) {
    verdict = "rejected";
    reason =
      "the planner did not choose it — an index that never appears in a plan is write cost only";
  } else if (best >= cand.minImprovement) {
    verdict = "accepted";
    reason = `used by the planner and removed ${(best * 100).toFixed(0)}% of median time`;
  } else if (cand.minBufferImprovement && bestBuffers >= cand.minBufferImprovement) {
    verdict = "accepted";
    reason =
      `used by the planner; time moved only ${(best * 100).toFixed(0)}% on local SSD but ` +
      `buffer traffic fell ${(bestBuffers * 100).toFixed(0)}%, and on Neon buffers are the cost`;
  } else {
    verdict = "rejected";
    reason = `used, but removed only ${(best * 100).toFixed(0)}% of median time and ${(bestBuffers * 100).toFixed(0)}% of buffers`;
  }

  console.log(`  ${verdict === "accepted" ? "✅" : "🔴"} ${cand.id}`);
  for (const q of claimed) {
    const b = before[q.id];
    const a = after[q.id];
    console.log(
      `       ${q.id.padEnd(22)} ${b.ms.toFixed(3).padStart(9)} ms → ${a.ms.toFixed(3).padStart(9)} ms` +
        `   buffers ${String(buffers(b.plan)).padStart(6)} → ${String(buffers(a.plan)).padStart(6)}`,
    );
  }
  console.log(`       ${reason}\n`);

  report.push({
    id: cand.id,
    table: cand.table,
    ddl: cand.ddl.replace(/\s+/g, " ").trim(),
    why: cand.why,
    claims: cand.claims,
    verdict,
    reason,
    plannerUsedIt: used,
    measurements: claimed.map((q) => ({
      query: q.id,
      beforeMs: Number(before[q.id].ms.toFixed(3)),
      afterMs: Number(after[q.id].ms.toFixed(3)),
      beforeBuffers: buffers(before[q.id].plan),
      afterBuffers: buffers(after[q.id].plan),
      afterPlanTop: after[q.id].plan["Plan"]["Node Type"],
      // Only present when the planner declined: what it would have cost.
      forcedMs: forced ? Number(forced[q.id].ms.toFixed(3)) : null,
      forcedBuffers: forced ? buffers(forced[q.id].plan) : null,
      forcedUsedIt: forced ? forced[q.id].planText.includes(cand.id) : null,
    })),
  });
}

/**
 * ⚠️ RESTORED STATE IS ASSERTED, NOT ASSUMED — and it is asserted against
 * WHAT WAS FOUND, not against "absent". The earlier version compared
 * against absent and therefore reported three legitimately-applied
 * migration indexes as leftovers, while saying nothing about the one it
 * had actually deleted.
 */
const nowPresent = new Set(
  (
    await admin.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1)`,
      [CANDIDATES.map((c) => c.id)],
    )
  ).rows.map((r) => r.indexname),
);

const drift = [];
for (const [id, def] of preExisting) {
  const wasThere = def !== null;
  const isThere = nowPresent.has(id);
  if (wasThere && !isThere) drift.push(`${id} was applied before this run and is now MISSING`);
  if (!wasThere && isThere) drift.push(`${id} did not exist before this run and was left behind`);
}
if (drift.length > 0) {
  console.error(
    `\n🔴 THIS RUN CHANGED THE DATABASE:\n` +
      drift.map((d) => `   • ${d}`).join("\n") +
      `\n   Re-apply the affected migration before trusting any further measurement.\n`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `  ✅ database handed back unchanged — ` +
      `${alreadyThere.length} pre-existing candidate index(es) restored.`,
  );
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, "index-verdicts.json"), JSON.stringify(report, null, 2) + "\n");

const accepted = report.filter((r) => r.verdict === "accepted");
console.log(`  ${accepted.length} accepted, ${report.length - accepted.length} rejected.`);
console.log(`  Wrote scripts/perf/results/index-verdicts.json\n`);

await app.end();
await admin.end();
