/**
 * Ordence — Track F · PROVE THE CACHE CANNOT CROSS TENANTS
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS RUNS AGAINST A FAKE REDIS AND WHY THAT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/cache/**` claims three independent defences against serving one
 * tenant another tenant's rows. Two of them — the branded key type and
 * the uuid validation — are only as good as the code that calls them.
 * The third, the read-time envelope check, exists precisely FOR THE CASE
 * WHERE THE OTHER TWO FAILED.
 *
 * That case cannot be produced by calling the API correctly. It has to
 * be produced by POISONING THE STORE: writing tenant B's value under
 * tenant A's key, the way a shared Redis instance, a manual `SET` or a
 * future edit to `keys.ts` would.
 *
 * So: an in-memory stand-in for Upstash, injected by pointing
 * `UPSTASH_REDIS_REST_URL` at nothing and monkey-patching the client.
 * A real Redis would prove less, not more — the interesting values are
 * ones no correct caller would ever write.
 *
 * ⚠️ EVERY ASSERTION BELOW STATES WHAT WOULD HAVE HAPPENED WITHOUT THE
 * DEFENCE, because "it passed" is not evidence that anything was tested.
 *
 *   npx tsx scripts/perf/prove-cache-isolation.ts
 *
 * Exit 0 all proofs held · 1 any proof failed.
 */

/*
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `server-only` HAS TO BE NEUTRALISED BEFORE ANYTHING IS IMPORTED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/cache/*.ts` begins with `import "server-only"`, whose whole
 * purpose is to make the BUILD fail when a client component imports a
 * server module. Outside Next.js it resolves to a file that throws on
 * sight, so a plain `tsx` run cannot load the module it is meant to
 * prove.
 *
 * `vitest.config.ts:71` solves this by aliasing the package to its own
 * `empty.js`, and its comment at line 54 calls it "a landmine, not a
 * library" for exactly this reason. This is the same alias, applied to
 * the CommonJS resolver that `tsx` uses.
 *
 * ⚠️ It must run BEFORE the dynamic imports below, which is why they are
 * `await import(...)` rather than static imports — a static import would
 * be hoisted above this and the patch would come too late.
 */
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * ⚠️ AN ABSOLUTE PATH, NOT `require.resolve("server-only/empty.js")`.
 * The package's `exports` map does not publish the subpath, so resolving
 * it by name fails with ERR_PACKAGE_PATH_NOT_EXPORTED. `vitest.config.ts:71`
 * points at the file directly for the same reason.
 */
const EMPTY_SERVER_ONLY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  "server-only",
  "empty.js",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolver = (Module as any)._resolveFilename;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return EMPTY_SERVER_ONLY;
  return resolver.call(this, request, ...rest);
};

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

/* ------------------------------------------------------------------ */
/* A stand-in for Upstash with exactly the four methods lib/cache uses */
/* ------------------------------------------------------------------ */

const store = new Map<string, unknown>();

const fakeRedis = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: async <T,>(k: string): Promise<T | null> => (store.has(k) ? (store.get(k) as T) : null),
  set: async (k: string, v: unknown) => {
    store.set(k, v);
    return "OK";
  },
  del: async (...keys: string[]) => {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n++;
    return n;
  },
  scan: async (cursor: string, opts: { match: string; count: number }) => {
    const re = new RegExp("^" + opts.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") + "$");
    const keys = [...store.keys()].filter((k) => re.test(k));
    return [0, keys] as [number, string[]];
  },
};

/*
 * ⚠️ THE SEAM IS `lib/cache/client.ts`, NOT A MONKEY-PATCH.
 *
 * The first draft of this file tried `Object.defineProperty` on the
 * `lib/redis` module namespace and failed: ES module namespaces are
 * FROZEN, so `getRedis` cannot be redefined from outside. That is not a
 * quirk to work around — it means the most important guarantee in
 * `lib/cache` would have been untestable, and an untested guarantee in
 * this repository has twenty-three times turned out not to hold.
 *
 * `setCacheClientForTests()` is the owned, named, production-guarded
 * alternative. See lib/cache/client.ts for why it throws in production.
 */
const cache = await import("../../lib/cache/index");
const keys = await import("../../lib/cache/keys");

cache.setCacheClientForTests(fakeRedis);

/* ------------------------------------------------------------------ */

let failed = 0;
function proof(name: string, ok: boolean, withoutIt: string) {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`::error::PROOF FAILED — ${name}`);
    console.error(`     Without the defence this test exists for: ${withoutIt}`);
  }
}

console.log("\nProving lib/cache tenant isolation\n");

/* --- ① a key cannot be built without a well-formed tenant uuid ------ */

for (const bad of ["", "undefined", "null", "00000000-0000-0000-0000-000000000000", "abc"]) {
  let threw = false;
  try {
    keys.tenantCacheKey(bad, "ledger-list");
  } catch {
    threw = true;
  }
  proof(
    `tenantCacheKey() refuses tenant id ${JSON.stringify(bad)}`,
    threw,
    `every caller passing ${JSON.stringify(bad)} would share one cache key, so the first ` +
      `tenant to populate it would serve every other tenant.`,
  );
}

/* --- ② a key part cannot forge another tenant's prefix -------------- */

let forgeThrew = false;
try {
  keys.tenantCacheKey(TENANT_A, "ledger-list", `x:t:${TENANT_B}`);
} catch {
  forgeThrew = true;
}
proof(
  "a key part containing ':' is refused",
  forgeThrew,
  `the part would have produced a key that READS as tenant B's, and invalidateTenant() ` +
    `deletes by prefix — so tenant A could clear tenant B's cache.`,
);

/* --- ③ ordinary use round-trips ------------------------------------- */

store.clear();
cache.resetCacheStats();

let loads = 0;
const loader = async () => {
  loads++;
  return { rows: ["A-only"] };
};

const first = await cache.cached(TENANT_A, "ledger-list", [], loader);
const second = await cache.cached(TENANT_A, "ledger-list", [], loader);

proof(
  "a second read is served from cache, not the loader",
  loads === 1 && JSON.stringify(first) === JSON.stringify(second),
  `the cache would be storing nothing and every claim about it would be false ` +
    `(loads=${loads}).`,
);

/* --- ④ two tenants never collide in ordinary use -------------------- */

const bFirst = await cache.cached(TENANT_B, "ledger-list", [], async () => ({ rows: ["B-only"] }));
proof(
  "tenant B gets tenant B's value, not tenant A's",
  JSON.stringify(bFirst) === JSON.stringify({ rows: ["B-only"] }),
  `tenant B would have received ${JSON.stringify(first)} — tenant A's ledger list.`,
);

/* --- ⑤ 🔴 THE ONE THAT MATTERS: A POISONED KEY IS REFUSED ----------- */

store.clear();
cache.resetCacheStats();

const aKey = keys.tenantCacheKey(TENANT_A, "ledger-list");

/*
 * The store is written directly, bypassing every key-construction
 * defence, with tenant B's data under tenant A's key. This is what a
 * shared Redis database, a stray `SET`, or a regression in keys.ts
 * produces. No correct call can create it — which is exactly why the
 * defence has to be at READ time.
 */
store.set(aKey, { t: TENANT_B, v: { rows: ["B-SECRET"] }, w: Date.now() });

let poisonedLoads = 0;
const afterPoison = await cache.cached(TENANT_A, "ledger-list", [], async () => {
  poisonedLoads++;
  return { rows: ["A-correct"] };
});

const stats = cache.cacheStats();

proof(
  "a value whose envelope names another tenant is refused",
  JSON.stringify(afterPoison) === JSON.stringify({ rows: ["A-correct"] }) &&
    poisonedLoads === 1 &&
    stats.refusedCrossTenant === 1,
  `tenant A would have been served ${JSON.stringify({ rows: ["B-SECRET"] })} — tenant B's ` +
    `data, with no error, no log line and no way to notice. ` +
    `(got refusedCrossTenant=${stats.refusedCrossTenant}, loaderRuns=${poisonedLoads})`,
);

proof(
  "the poisoned entry is deleted, not merely ignored",
  !store.has(aKey) || (store.get(aKey) as { t: string }).t === TENANT_A,
  `the next read would repeat the refusal forever and the counter would climb, making ` +
    `one incident indistinguishable from a thousand.`,
);

/* --- ⑥ the environment tag keeps two deployments apart -------------- */

/*
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE WAVE-17 ADDITION, AND WHY IT NEEDS A SUBPROCESS TO PROVE
 * ══════════════════════════════════════════════════════════════════════
 * The environment audit confirmed Upstash is configured on production,
 * and Ordence has exactly ONE pair of Upstash credentials. Two
 * deployments pointed at one Upstash database would previously have
 * produced byte-identical keys for the same tenant — and the read-time
 * envelope check CANNOT catch that, because the tenant id matches. It is
 * the right tenant and the wrong universe.
 *
 * The tag is frozen at module load, deliberately, so it cannot be varied
 * inside this process. Proving it therefore means running a second
 * process with a different `NEXT_PUBLIC_ROOT_DOMAIN` and comparing the
 * key it emits. Anything less would be asserting the code I just read.
 */
const tag = keys.cacheEnvironmentTag();
proof(
  `the key carries an environment tag (${JSON.stringify(tag)})`,
  typeof tag === "string" && tag.length > 0 &&
    keys.tenantCacheKey(TENANT_A, "ledger-list").includes(`:${tag}:`),
  `two deployments sharing one Upstash database would write byte-identical keys ` +
    `for the same tenant, and the envelope check cannot see it because the tenant ` +
    `id is correct in both.`,
);

proof(
  "the tenant id is still recoverable from the longer key",
  keys.tenantIdFromKey(keys.tenantCacheKey(TENANT_A, "ledger-list", "x")) === TENANT_A,
  `the read-time check parses the tenant out of the key; moving its position without ` +
    `updating the parser would silently disable defence ③.`,
);

{
  const { execFileSync } = await import("node:child_process");
  const emit = (domain: string) =>
    execFileSync(
      process.execPath,
      // ⚠️ `--import tsx` as real argv, not `execArgv`. `execFileSync`
      // ignores `execArgv` — that option belongs to `fork()` — and the
      // child then runs under plain node, which cannot resolve a `.ts`
      // import and fails with ERR_MODULE_NOT_FOUND. Found by running it.
      ["--import", "tsx", fileURLToPath(new URL("./_emit-cache-key.mts", import.meta.url))],
      {
        env: { ...process.env, NEXT_PUBLIC_ROOT_DOMAIN: domain, NODE_ENV: "production" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

  let prod = "", staging = "";
  let ran = false;
  try {
    prod = emit("app.ordence.com");
    staging = emit("staging.ordence.com");
    ran = true;
  } catch (err) {
    console.error(`     (subprocess check could not run: ${(err as Error).message})`);
  }

  proof(
    "the same tenant in two deployments produces two different keys",
    ran && prod.length > 0 && staging.length > 0 && prod !== staging,
    `production and staging pointed at one Upstash database would share every key. ` +
      `(prod=${JSON.stringify(prod)} staging=${JSON.stringify(staging)})`,
  );
}

/* --- ⑦ the namespace registry is complete and sane ------------------ */

/*
 * ⚠️ THIS IS ALSO THE ONLY CONSUMER OF `CACHE_NAMESPACE_IDS`, AND THAT
 * IS DELIBERATE. An exported constant nothing reads is decoration; an
 * exported constant a check reads is a contract. Every namespace must
 * carry a TTL that is a positive number of seconds and a `why` long
 * enough to be an argument rather than a label — otherwise "how stale
 * may this screen be" has no answer and the registry is a list of
 * strings.
 */
for (const ns of cache.CACHE_NAMESPACE_IDS) {
  const entry = cache.CACHE_NAMESPACES[ns];
  proof(
    `namespace "${ns}" declares a TTL and a reason`,
    Number.isFinite(entry.ttlSeconds) &&
      entry.ttlSeconds > 0 &&
      entry.ttlSeconds <= 86_400 &&
      typeof entry.why === "string" &&
      entry.why.length >= 20,
    `a namespace with no TTL caches forever, and one with no written reason is a ` +
      `staleness promise nobody agreed to. (ttl=${entry.ttlSeconds}, why=${JSON.stringify(entry.why)})`,
  );
}

/* --- ⑧ degradation is counted, never thrown ------------------------- */

cache.setCacheClientForTests(null);
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
cache.resetCacheStats();

let degradedLoads = 0;
const noRedis = await cache.cached(TENANT_A, "ledger-list", [], async () => {
  degradedLoads++;
  return { rows: ["from-loader"] };
});
const degradedStats = cache.cacheStats();

proof(
  "with Upstash absent, the loader still answers and the miss is counted",
  JSON.stringify(noRedis) === JSON.stringify({ rows: ["from-loader"] }) &&
    degradedLoads === 1 &&
    degradedStats.degraded > 0 &&
    degradedStats.configured === false,
  `a missing optional environment variable — UPSTASH_REDIS_REST_URL is \`.optional()\` at ` +
    `lib/env.ts:70 — would have become a thrown error on every cached read, i.e. a total ` +
    `outage in local development and CI.`,
);

/* ------------------------------------------------------------------ */

if (failed > 0) {
  console.error(`\n🔴 ${failed} cache isolation proof(s) FAILED.\n`);
  process.exit(1);
}
console.log(`\n✅ All cache isolation proofs held.\n`);
