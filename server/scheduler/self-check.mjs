#!/usr/bin/env node
/**
 * Ordence — ⭐⭐⭐ THE SCHEDULER'S OWN GATE
 * Version: v1.82.0-alpha (Wave 14, Track A)
 *
 *     node server/scheduler/self-check.mjs
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS A SCRIPT AND NOT A TEST FILE
 * ══════════════════════════════════════════════════════════════════════
 * Track A's ownership block does not include `tests/**`, so this track
 * cannot add a vitest suite. The house rule this repository has learned
 * the hard way is that a property nothing executes is a property that
 * decays, and the brief says so plainly: "write the proof before the fix
 * where you can. A failing check that demonstrates the defect is worth
 * more than the fix, because it is what stops the defect coming back."
 *
 * So the proofs live here, in a file this track does own, runnable by one
 * command with no database and no network. `PATCH-REQUEST-A.md` asks for
 * one line in `scripts/run-gates.mjs` so it runs in CI; until that lands
 * it is run by hand and its output is quoted in `TRACK-REPORT.md`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT CHECKS, AND IN WHICH OF THE TWO WAYS
 * ══════════════════════════════════════════════════════════════════════
 * ① BY EXECUTION — the cron parser and the maintenance lane are imported
 *    and run. `cron.ts` is loaded through Node's built-in type stripping,
 *    with a resolve hook mapping `server-only` to an empty module exactly
 *    as `vitest.config.ts` already does for the security suite.
 *
 * ② BY READING THE SOURCE — for the parts that cannot run without a
 *    database. This is the same technique `tests/ui/scheduled-jobs.test.ts`
 *    uses and it is worth restating why it is not cargo cult: the
 *    properties asserted below are one-phrase properties whose absence has
 *    NO SYMPTOM. `NULLS NOT DISTINCT` missing from one index means every
 *    platform-scoped job can double-run, and nothing anywhere gets slower,
 *    louder or redder. A grep is a weak test in general and a strong one
 *    for exactly this.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/**
 * ⚠️ COMMENTS STRIPPED, for the same reason `tests/ui/scheduled-jobs.test.ts`
 * strips them: this repository documents its reasoning in prose next to the
 * code, so an assertion that something is ABSENT will match the paragraph
 * explaining why it is absent. Matching raw source would force somebody to
 * delete the explanation to make the check pass, which is how reasoning
 * leaves a codebase.
 */
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

let failures = 0;
let checks = 0;

function ok(what) {
  checks += 1;
  console.log(`  ✅ ${what}`);
}

function bad(what, detail) {
  checks += 1;
  failures += 1;
  console.error(`  ❌ ${what}`);
  if (detail) console.error(`     ${detail}`);
}

function assert(condition, what, detail) {
  if (condition) ok(what);
  else bad(what, detail);
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * ⚠️ `import "server-only"` IS A LANDMINE, NOT A LIBRARY — the package's
 * default export is one `throw`. Next.js resolves the `react-server`
 * condition to an empty file; plain Node has no such condition.
 * `vitest.config.ts` solves this with an alias and says so at length;
 * this is the same fix with the API a plain script has.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const cron = await import("./cron.ts");
const maintenance = await import("./maintenance.mjs");

/* ================================================================== */
/* ① THE CRON PARSER, BY EXECUTION                                     */
/* ================================================================== */

section("① Cron parsing and slot computation (executed)");

{
  const p = cron.parseCron("30 19 * * *");
  assert(
    p.minute.values.join() === "30" && p.hour.values.join() === "19",
    "`30 19 * * *` — dunning_sweep's real schedule — parses to 19:30",
  );

  const next = cron.nextSlotAfter(p, new Date("2026-06-01T00:00:00Z"));
  assert(
    next?.toISOString() === "2026-06-01T19:30:00.000Z",
    "the next slot after midnight UTC is 19:30 the same day",
    `got ${next?.toISOString()}`,
  );
}

{
  const p = cron.parseCron("*/15 * * * *");
  assert(
    p.minute.values.join() === "0,15,30,45",
    "a step expression expands to four slots an hour",
  );
}

{
  /**
   * 🔴 THE OR RULE. When both day-of-month and day-of-week are restricted
   * they are OR-ed, not AND-ed. Every hand-rolled parser gets this
   * backwards and none of the eight registered jobs would reveal it,
   * because none restricts both fields — so an AND implementation would
   * be indistinguishable from a correct one today and silently wrong for
   * the first job that does.
   */
  const p = cron.parseCron("0 0 1 * 1");
  // 2026-06-01 is a Monday AND the 1st: matches either way.
  // 2026-06-08 is a Monday and not the 1st: matches only under OR.
  // 2026-07-01 is a Wednesday and the 1st: matches only under OR.
  assert(
    cron.matchesAt(p, new Date("2026-06-08T00:00:00Z")),
    "`0 0 1 * 1` fires on a Monday that is not the 1st (the Vixie OR rule)",
  );
  assert(
    cron.matchesAt(p, new Date("2026-07-01T00:00:00Z")),
    "`0 0 1 * 1` fires on the 1st that is not a Monday (the Vixie OR rule)",
  );
  assert(
    !cron.matchesAt(p, new Date("2026-06-09T00:00:00Z")),
    "`0 0 1 * 1` does not fire on a Tuesday that is not the 1st",
  );
}

{
  const p = cron.parseCron("0 0 * * 7");
  assert(
    cron.matchesAt(p, new Date("2026-06-07T00:00:00Z")),
    "day-of-week 7 means Sunday, as does 0 — a `7` that matched nothing would be a job that never fires",
  );
}

{
  /**
   * 🔴 THE WORST-GAP MEASUREMENT, WHICH IS WHAT THE WATCHDOG WINDOW IS
   * BUILT FROM. `rera_dunning_plan` is `0 3 * * 1-5`: 24 hours from
   * Monday to Tuesday and 72 hours from Friday to Monday. A window built
   * from the typical gap alarms every single weekend, and an alarm that
   * cries wolf every Saturday is one somebody mutes on the third
   * Saturday.
   */
  const p = cron.parseCron("0 3 * * 1-5");
  const typical = cron.cadenceSeconds(p, new Date("2026-06-01T00:00:00Z"));
  const worst = cron.worstGapSeconds(p, new Date("2026-06-01T00:00:00Z"));
  assert(typical === 86_400, "the typical gap of a weekday job is 24h", `got ${typical}`);
  assert(worst === 259_200, "the WORST gap of a weekday job is 72h (Fri→Mon)", `got ${worst}`);
}

{
  /**
   * ⚠️ TIMEZONES. `0 9 * * *` in Asia/Kolkata is 03:30 UTC. A per-
   * workspace schedule declares an IANA zone (0130) and a fixed-offset
   * implementation would be wrong by an hour, twice a year, in any zone
   * with daylight saving.
   */
  const p = cron.parseCron("0 9 * * *");
  const slots = cron.slotsBetween(
    p,
    new Date("2026-06-01T00:00:00Z"),
    new Date("2026-06-02T00:00:00Z"),
    "Asia/Kolkata",
  );
  assert(
    slots.length === 1 && slots[0]?.toISOString() === "2026-06-01T03:30:00.000Z",
    "09:00 in Asia/Kolkata resolves to 03:30 UTC",
    `got ${slots.map((s) => s.toISOString()).join(", ")}`,
  );
}

{
  /**
   * ⚠️ EXCLUSIVE AT THE START. The caller passes the last slot it already
   * handled; an inclusive start would re-offer it on every tick. The
   * ledger would refuse the duplicate claim, so the bug would be
   * invisible — a tick making N redundant claim attempts a minute,
   * forever.
   */
  const p = cron.parseCron("0 * * * *");
  const slots = cron.slotsBetween(
    p,
    new Date("2026-06-01T10:00:00Z"),
    new Date("2026-06-01T12:00:00Z"),
  );
  assert(
    slots.length === 2 &&
      slots[0]?.toISOString() === "2026-06-01T11:00:00.000Z" &&
      slots[1]?.toISOString() === "2026-06-01T12:00:00.000Z",
    "slotsBetween is exclusive at the start and inclusive at the end",
    `got ${slots.map((s) => s.toISOString()).join(", ")}`,
  );
}

{
  let threw = false;
  try {
    cron.slotsBetween(
      cron.parseCron("* * * * *"),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z"),
    );
  } catch {
    threw = true;
  }
  assert(
    threw,
    "a scan window past the 40-day limit THROWS rather than silently truncating",
    "a backfill list that quietly began 40 days ago would report success on a job still months behind",
  );
}

{
  const bads = [
    ["0 0 * *", "four fields"],
    ["0 0 * * * *", "six fields, a seconds column"],
    ["0 0 L * *", "the `L` extension"],
    ["61 * * * *", "a minute out of range"],
    ["0 0 * * 8", "a day-of-week out of range"],
    ["0 0 5-1 * *", "an inverted range"],
  ];
  let allRefused = true;
  const accepted = [];
  for (const [expr, why] of bads) {
    try {
      cron.parseCron(expr);
      allRefused = false;
      accepted.push(`${expr} (${why})`);
    } catch {
      /* expected */
    }
  }
  assert(
    allRefused,
    "malformed and unsupported expressions are REFUSED, never partially honoured",
    accepted.length ? `accepted: ${accepted.join("; ")}` : undefined,
  );
}

{
  /**
   * A valid expression that can never fire. `describeCron` and
   * `nextSlotAfter` must say so rather than render a blank cell.
   */
  const next = cron.nextSlotAfter(cron.parseCron("0 0 30 2 *"), new Date("2026-01-01T00:00:00Z"));
  assert(next === null, "the 30th of February has no next run, and that is reported as null");
}

/* ================================================================== */
/* ② THE MAINTENANCE LANE, BY EXECUTION AGAINST A FAKE CLIENT          */
/* ================================================================== */

section("② The maintenance lane (executed against a fake client)");

function fakeClient() {
  const statements = [];
  const client = {
    query(sql, params) {
      return { sql, params };
    },
    async transaction(queries) {
      statements.push(queries.map((q) => q.sql));
      return queries.map(() => []);
    },
  };
  return { client, statements };
}

{
  const { client, statements } = fakeClient();
  const result = await maintenance.runMaintenanceHandoffs({
    client,
    handoffs: [
      {
        runId: "11111111-1111-1111-1111-111111111111",
        jobId: "prune_change_log",
        sqlCall: "SELECT * FROM public.prune_change_log(180, false)",
      },
    ],
  });

  assert(result.ok === true, "a well-formed prune call is executed and reported as succeeded");

  /**
   * 🔴 THE PLATFORM MARKER MUST SHARE A TRANSACTION WITH THE STATEMENT IT
   * PROTECTS, AND MUST COME FIRST.
   *
   * The first draft of maintenance.mjs set it in the SELECT LIST of the
   * same statement:
   *
   *     SELECT set_config('app.platform_scope','on',false), x
   *       FROM (SELECT * FROM public.prune_change_log(180,false)) AS x
   *
   * Postgres evaluates the FROM clause before the select list, so the
   * prune would have run with NO platform marker — matching zero rows per
   * workspace under FORCE ROW LEVEL SECURITY and returning success. That
   * is `count(*) >= 10 THEN 'PASS'` in a different costume, and this
   * assertion is the thing that would have caught it.
   */
  const everyTransactionScopedFirst = statements.every((group) =>
    (group[0] ?? "").includes("app.platform_scope"),
  );
  assert(
    statements.length > 0 && everyTransactionScopedFirst,
    "every transaction sets app.platform_scope as its FIRST statement",
    `statements: ${JSON.stringify(statements)}`,
  );

  const ran = statements.some((group) =>
    group.some((s) => s.includes("prune_change_log(180, false)")),
  );
  assert(ran, "the prune call itself was executed");

  const finished = statements.some((group) =>
    group.some((s) => s.includes("state = $2") && s.includes("finished_at = now()")),
  );
  assert(finished, "the ledger row is finished after a successful run");
}

{
  const { client, statements } = fakeClient();
  const result = await maintenance.runMaintenanceHandoffs({
    client,
    handoffs: [
      {
        runId: "22222222-2222-2222-2222-222222222222",
        jobId: "evil",
        sqlCall: "SELECT * FROM public.prune_change_log(180,false); DROP TABLE tenants",
      },
    ],
    error: () => {},
  });

  assert(result.ok === false, "SQL carrying a second statement is REFUSED");
  const executed = statements.some((group) => group.some((s) => s.includes("DROP TABLE")));
  assert(!executed, "the refused SQL is never sent to the database");

  /**
   * ⭐ AND THE REFUSAL IS STILL WRITTEN TO THE LEDGER. The slot is already
   * claimed by the application; abandoning it would leave a row in
   * `claimed` that the watchdog reclaims half an hour later, and in the
   * meantime the `skip` overrun policy suppresses the next slot. A
   * refusal invisible for thirty minutes is worse than a failure visible
   * now.
   */
  const recorded = statements.some((group) =>
    group.some((s) => s.includes("finished_at = now()")),
  );
  assert(recorded, "a refused handoff still finishes its ledger row rather than abandoning it");
}

{
  const cases = [
    ["SELECT * FROM public.prune_change_log(180, false)", true],
    ["SELECT public.prune_usage_counters('25 months')", true],
    ["SELECT * FROM public.prune_scheduler_runs(90, true)", true],
    ["SELECT * FROM public.prune_change_log(180,false); DROP TABLE tenants", false],
    ["DELETE FROM tenants", false],
    ["SELECT * FROM public.drop_everything()", false],
    ["SELECT * FROM prune_change_log(180, false)", false], // unqualified
    ["SELECT * FROM public.prune_x((SELECT 1))", false], // nested parens
  ];
  let allRight = true;
  const wrong = [];
  for (const [sql, expected] of cases) {
    if (maintenance.ALLOWED_SQL.test(sql) !== expected) {
      allRight = false;
      wrong.push(sql);
    }
  }
  assert(allRight, "ALLOWED_SQL accepts the four prune calls and refuses everything else", wrong.join(" | "));
}

/* ================================================================== */
/* ③ ONE-PHRASE PROPERTIES WITH NO SYMPTOM, READ FROM THE SOURCE       */
/* ================================================================== */

section("③ Load-bearing phrases whose absence has no symptom (source)");

{
  const sql0129 = read("SQL-FILES/0129_scheduler_run_ledger.sql");

  assert(
    /CREATE UNIQUE INDEX[^;]*scheduler_runs_slot_uq[^;]*NULLS NOT DISTINCT/s.test(sql0129),
    "0129's claim index carries NULLS NOT DISTINCT",
    "without it two platform-scoped runs (subject_tenant_id NULL) both claim the same slot, " +
      "because two NULLs are not equal — so rate_limit_sweep and anomaly_detection can double-run",
  );

  assert(
    /WHERE slot_at IS NOT NULL/.test(sql0129),
    "0129's claim index excludes manual runs",
    "without the predicate, a second `Run now` would be silently refused and look like a UI bug",
  );

  assert(
    /FORCE ROW LEVEL SECURITY/.test(sql0129),
    "0129 uses FORCE, not merely ENABLE",
    "plain ENABLE exempts the table OWNER, and on Neon the owner is the role that applies " +
      "migrations — a control the running application is exempt from is not a control",
  );

  /**
   * ⚠️ STATEMENT BY STATEMENT, WITH COMMENTS STRIPPED, AND THE FIRST DRAFT
   * OF THIS CHECK IS THE REASON WHY. It was one regex over the whole file
   * — `GRANT[^;]*DELETE[^;]*scheduler_runs[^;]*ordence_app` — and it went
   * red against a file that is correct, because Section 4's prose contains
   * the words GRANT, DELETE, scheduler_runs and ordence_app across several
   * comment lines with no semicolon between them. A check that reads prose
   * as if it were code fails on the explanation of the rule it is
   * enforcing, which teaches people to delete explanations.
   */
  const statementsOf = (sql) =>
    sql
      .replace(/--[^\n]*/g, " ")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);

  const appDelete = statementsOf(sql0129).filter(
    (st) =>
      /^GRANT\b/i.test(st) &&
      /\bDELETE\b/i.test(st) &&
      /scheduler_runs/i.test(st) &&
      /\bTO ordence_app\b/i.test(st),
  );
  assert(
    appDelete.length === 0,
    "0129 never grants the application DELETE on the run ledger",
    appDelete.join(" | "),
  );
}

{
  const sql0131 = read("SQL-FILES/0131_scheduler_watchdog.sql");

  assert(
    /COALESCE\(s\.at, e\.declared_at\) < p_as_of - make_interval/.test(sql0131),
    "0131's overdue predicate COALESCEs a never-run job onto its declared_at",
    "the natural form `WHERE s.at < …` drops every job that has NEVER succeeded, because NULL " +
      "fails the comparison — so a job that has never run once reads healthy forever, which is " +
      "the state this whole product was in",
  );

  assert(
    /WHERE r\.state = 'succeeded'/.test(sql0131),
    "0131 measures the last SUCCESS, not the last run",
    "measuring the last run means a job failing every single night looks perfectly punctual",
  );

  assert(
    /9223372036854775807/.test(sql0131),
    "0131 maps a missing heartbeat to an infinitely stale value, never to NULL",
    "`overdue = 0 AND (NULL <= 900)` is NULL in SQL, and a body carrying ok: null reads as " +
      "'not false' to every monitor that tests for false",
  );
}

{
  const sql0132 = read("SQL-FILES/0132_scheduler_retention_and_seal.sql");
  assert(
    /has_function_privilege\('ordence_app',\s*\n?\s*'public\.prune_security_events/.test(sql0132),
    "0132 re-checks that the application still cannot execute prune_security_events()",
    "0087 granted it back once by copying a signature without reading the role",
  );
  assert(
    /indnullsnotdistinct/.test(sql0132),
    "0132 reads indnullsnotdistinct from the catalog as a standing check",
    "0129 proves the behaviour when it runs; this catches an index rebuilt by hand months later",
  );
}

{
  const ledger = read("server/scheduler/ledger.ts");
  assert(
    /ON CONFLICT DO NOTHING\s*\n\s*RETURNING id::text AS id/.test(ledger),
    "claimSlot uses ON CONFLICT DO NOTHING ... RETURNING, so a losing claim gets no row",
    "`ON CONFLICT DO UPDATE SET id = id RETURNING id` returns a row to BOTH callers and both run",
  );
  assert(
    !/SELECT[^;]*FROM scheduler_runs[^;]*\n[^;]*INSERT INTO scheduler_runs/s.test(ledger),
    "there is no select-then-insert claim anywhere in the ledger",
  );
}

{
  const runner = read("server/scheduler/runner.ts");
  const route = read("app/api/workers/route.ts");

  /**
   * ⭐ WAVE 17 — THE RUNNER NO LONGER GOES THROUGH `runScheduledJob`, AND
   * THESE ARE THE THREE PROPERTIES THAT HAD TO SURVIVE THE MOVE.
   *
   * The old path re-listed the workspace table once per workspace per job
   * per slot (PATCH-REQUEST-A item 3). Calling `job.runForTenant`
   * directly removes that — and removes, with it, the entitlement gate,
   * the said-out-loud skip and the error isolation that
   * `runScheduledJob` was providing for free. Each is re-established
   * here, so a later edit cannot drop one silently.
   */
  assert(
    /tenantAllowsFeature\(/.test(runner) &&
      /from "@\/server\/scheduling\/entitlement"/.test(runner),
    "the runner applies the registry's own entitlement function, not a copy of its rules",
    "a second implementation of 'is this workspace entitled' drifts, and the drift is " +
      "invisible: the wrong workspaces quietly get a paid capability, or quietly stop " +
      "getting one",
  );

  assert(
    /if \(!entitled\.allowed\) return \{ skipped: entitled\.reason/.test(runner),
    "an unentitled workspace is SKIPPED WITH ITS REASON, never silently treated as done",
  );

  assert(
    /state: "skipped_paused",\s*\n\s*outcome: \{ skipReason: outcome\.skipped/.test(runner),
    "the entitlement skip lands in the ledger, so the calendar shows a skip and not a gap",
  );

  assert(
    !/runScheduledJob/.test(codeOnly(runner)),
    "the runner does not call runScheduledJob, so there is no per-workspace tenant re-read",
    "PATCH-REQUEST-A item 3: runScheduledJob({onlyTenantId}) selects up to 501 workspace " +
      "rows and filters to one, once per workspace per job per slot",
  );

  assert(
    /runScheduledJob\(/.test(route),
    "the documented {\"mode\":\"scheduled\"} path still goes through runScheduledJob, unchanged",
    "tests/ui/scheduled-jobs.test.ts asserts on that literal",
  );
}

{
  const route = read("app/api/workers/route.ts");
  assert(
    /status: report\.ok \? 200 : 500/.test(route),
    "the tick's HTTP status is the alert: non-ok is 500",
  );
  assert(
    /status: run\.ok \? 200 : 500/.test(route),
    "the pre-existing scheduled-job path still turns a failed run into a 500",
    "tests/ui/scheduled-jobs.test.ts asserts on this literal",
  );
  assert(
    /status: report\.ok \? 200 : 503/.test(route),
    "the watchdog endpoint answers 503 when a job is overdue or the clock is silent",
  );
  assert(
    /searchParams\.get\("watchdog"\)/.test(route),
    "the watchdog lives behind a query parameter, so a bare GET /api/workers is unchanged",
    "docs/current/CRON-RUNBOOK.md documents the bare GET and a UI test compares that document " +
      "against its generator",
  );
}

{
  const layout = read("app/(platform)/jobs/layout.tsx");
  assert(
    /getPlatformOperator/.test(layout) && /notFound\(\)/.test(layout),
    "the jobs console gates itself, because middleware does not match its path",
    "middleware.ts:259 matches `/platform(.*)`; a (platform) route group is stripped from the " +
      "URL, so this page serves at /jobs and would otherwise be an ordinary " +
      "authenticated route reachable by every user of every workspace",
  );
  /**
   * 🔴 THE BRIEF'S LITERAL PATH WOULD HAVE TURNED A SECURITY TEST RED.
   * `tests/security/route-audit.test.ts:50` forbids the URL segments
   * "admin", "debug", "console" and "test" anywhere under `app/`, with a
   * written rationale: no default admin route should exist to be probed.
   * A route group in parentheses is invisible to that walk; a literal
   * directory named `admin` is not. This asserts the console did not
   * re-acquire one.
   */
  const forbidden = new Set(["admin", "debug", "console", "test"]);
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("[")) continue;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("(")) out.push(entry.name);
        walk(join(dir, entry.name), out);
      }
    }
    return out;
  };
  const offending = walk(join(ROOT, "app")).filter((s) => forbidden.has(s));
  assert(
    offending.length === 0,
    "the scheduler console created no forbidden URL segment under app/",
    `found: ${offending.join(", ")} — tests/security/route-audit.test.ts will fail`,
  );

  const actions = read("app/(platform)/jobs/actions.ts");
  const exportCount = (actions.match(/^export async function /gm) ?? []).length;
  const anyExport = (actions.match(/^export (?!async function)/gm) ?? []).length;
  assert(
    exportCount > 0 && anyExport === 0,
    "every export of the `use server` module is an async function",
    "each export becomes a browser-reachable RPC endpoint",
  );
  assert(
    (actions.match(/requireCapability\("flags:write"\)/g) ?? []).length === exportCount,
    "every operator action checks flags:write before doing anything",
  );
  assert(
    (actions.match(/recordPlatformAudit\(/g) ?? []).length === exportCount,
    "every operator action writes a platform audit row carrying the justification",
  );
}

/* ================================================================== */
/* ③b EVERY CROSS-TENANT READ SAYS WHY, INCLUDING THE ONES TRACK D'S   */
/*     MEASUREMENT CANNOT SEE                                          */
/* ================================================================== */

section("③b Platform-scope justifications (executed against Track D's validator)");

{
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 WHY THIS EXISTS HERE AS WELL AS IN TRACK D'S SUITE
   * ══════════════════════════════════════════════════════════════════
   * `tests/security/platform-scope-justification.test.ts` counts
   * label-shaped reasons and pins the number so it can only shrink.
   * Track A took it from 15 to 17 in wave 14 and integration had to
   * repair two reasons by hand.
   *
   * ⚠️ IT REPAIRED TWO. THERE WERE FOUR. Track D's extraction is
   *
   *     /withPlatformScope\(\s*\n?\s*"([^"]{10,})"/g
   *
   * — a DOUBLE-QUOTED first argument. Most of this track's call sites
   * interpolate a job id or a run id, so they are written as template
   * literals in backticks, and the regex does not match them at all.
   * Two refusable reasons were therefore invisible to the pin:
   *
   *     `Scheduler: finish run ${args.runId}`
   *     `Scheduler: lift pause ${args.pauseId}`
   *
   * The pin is not wrong; it is blind in a direction nobody had reason
   * to look. So this check reads BOTH quoting styles, substitutes a
   * plausible value for each `${…}`, and runs Track D's own
   * `validateJustification` over the result. Reimplementing the rule
   * would be a second copy of it, which is the defect the rule exists
   * to prevent.
   *
   * Reported to Track D in TRACK-REPORT-WAVE-17.md §1.
   */
  const files = [
    "server/scheduler/ledger.ts",
    "server/scheduler/catalog.ts",
    "server/scheduler/watchdog.ts",
    "app/api/workers/route.ts",
    "app/api/workers/ai-monitors/route.ts",
  ].filter((f) => existsSync(join(ROOT, f)));

  const validatorPath = join(ROOT, "lib", "security", "platform-scope.ts");

  if (!existsSync(validatorPath)) {
    /**
     * ⚠️ NOT SILENTLY SKIPPED. Track D's module is what defines "a
     * justification"; without it this check cannot run, and a check that
     * quietly passes when its own dependency is missing is exactly the
     * shape this file exists to catch.
     */
    bad(
      "Track D's lib/security/platform-scope.ts is present, so justifications can be validated",
      "the file is absent — this check could not run and must not be read as a pass",
    );
  } else {
    /**
     * The validator is extracted rather than imported: the module it
     * lives in uses a TypeScript constructor parameter property, which
     * Node's strip-only type removal refuses, and it pulls in the
     * database layer besides. What is extracted is the function and the
     * three constants it reads — no rules are re-stated here.
     */
    const src = readFileSync(validatorPath, "utf8");
    const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
    const fnStart = src.indexOf("export function validateJustification");
    const probe =
      slice("export const MIN_JUSTIFICATION_CHARS", "export const MIN_JUSTIFICATION_WORDS") +
      slice("export const MIN_JUSTIFICATION_WORDS", "const PLACEHOLDER_JUSTIFICATIONS") +
      slice("const PLACEHOLDER_JUSTIFICATIONS", "export function validateJustification") +
      src.slice(fnStart, src.indexOf("\n}\n", fnStart) + 3);

    /**
     * ⚠️ WRITTEN TO A REAL `.ts` FILE IN THE TEMP DIRECTORY, because
     * Node's built-in type stripping applies to `file:` URLs and refuses
     * a `data:text/typescript` one outright. The file is removed
     * afterwards; nothing is written inside the repository.
     */
    const probePath = join(tmpdir(), `ordence-justification-probe-${process.pid}.ts`);
    writeFileSync(probePath, probe, "utf8");
    let validateJustification;
    try {
      ({ validateJustification } = await import(pathToFileURL(probePath).href));
    } finally {
      rmSync(probePath, { force: true });
    }

    const re =
      /withPlatformScope\(\s*\n?\s*(?:`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)")/g;

    const refused = [];
    let seen = 0;
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(re)) {
        const reason = m[1] !== undefined ? m[1] : m[2];
        if (reason === undefined) continue;
        seen += 1;
        const line = text.slice(0, m.index).split("\n").length;
        /* `${…}` becomes a plausible value; the words around it are what
           is being judged, and an unsubstituted `${x}` would be counted
           as one meaningless word and skew the result toward passing. */
        const probeText = reason.replace(/\$\{[^}]*\}/g, "dunning_sweep");
        if (!validateJustification(probeText).ok) {
          refused.push(`${file}:${line} ${JSON.stringify(reason)}`);
        }
      }
    }

    assert(
      seen > 20,
      `the extraction found ${seen} justifications, so this check is not vacuous`,
    );
    assert(
      refused.length === 0,
      "every cross-tenant read in Track A says WHY it must read across tenants",
      refused.join("\n     "),
    );
  }
}

/* ================================================================== */
/* ③c A REWRITTEN JUSTIFICATION MUST NOT BREAK A TEST THAT PINS IT     */
/* ================================================================== */

section("③c Pinned justification wording (source)");

{
  /**
   * 🔴 WHY THIS EXISTS. §3b pushes every reason toward saying WHY. Two
   * of the reasons in this track's ownership block were already in the
   * repository before wave 14, and `tests/ui/rls-writes.test.ts`
   * identifies those two call sites BY THEIR WORDING — it is asserting
   * that the nightly sweeps are platform-scoped rather than unscoped,
   * and the reason string is the only stable handle it has.
   *
   * Wave 17 improved both and broke the test. The fix was to keep the
   * pinned phrase and answer the question after it; the fix was NOT to
   * edit the assertion. This check makes the next attempt fail here,
   * in two seconds, instead of in a 240-second UI suite.
   *
   * ⚠️ THE PHRASE IS READ OUT OF THE TEST, NOT RESTATED HERE. A copy of
   * the expected wording in this file would drift from the test that
   * actually enforces it, which is the same defect §3b avoids by
   * extracting Track D's validator instead of reimplementing it.
   */
  const pinFile = join(ROOT, "tests", "ui", "rls-writes.test.ts");

  if (!existsSync(pinFile)) {
    /* Not a pass. The tree this runs against is supposed to have it. */
    bad(
      "tests/ui/rls-writes.test.ts is present, so its pinned wording can be checked",
      "the file is absent — this check could not run and must not be read as a pass",
    );
  } else {
    const test = readFileSync(pinFile, "utf8");

    /**
     * The block is `for (const file of [...]) { … toContain("…") … }`.
     * Every `toContain` string literal inside the cron-sweep test, paired
     * with every file path that test iterates, is what must hold.
     */
    const blockStart = test.indexOf('it("scopes both cron sweeps to the platform"');
    assert(
      blockStart !== -1,
      'tests/ui/rls-writes.test.ts still has the "scopes both cron sweeps" case',
      "the case was renamed or removed — re-derive what it pins before trusting this check",
    );

    if (blockStart !== -1) {
      const block = test.slice(blockStart, test.indexOf("\n  });", blockStart));
      const paths = [...block.matchAll(/"((?:app|server|lib)\/[^"]+\.tsx?)"/g)].map((m) => m[1]);
      const phrases = [...block.matchAll(/\.toContain\("([^"]{10,})"\)/g)].map((m) => m[1]);

      assert(
        paths.length >= 2 && phrases.length >= 1,
        `the extraction found ${paths.length} file(s) and ${phrases.length} phrase(s), so this check is not vacuous`,
      );

      const missing = [];
      for (const rel of paths) {
        const abs = join(ROOT, rel);
        if (!existsSync(abs)) continue;
        const src = readFileSync(abs, "utf8");
        for (const phrase of phrases) {
          if (!src.includes(phrase)) missing.push(`${rel} no longer contains ${JSON.stringify(phrase)}`);
        }
      }

      assert(
        missing.length === 0,
        "every phrase tests/ui/rls-writes.test.ts pins is still present in the file it pins it in",
        missing.join("\n     ") +
          "\n     Keep the pinned phrase and say WHY after it. Do not edit the test.",
      );
    }
  }
}

/* ================================================================== */
/* ④ THE CATALOG AND THE POLICY TABLE AGREE                            */
/* ================================================================== */

section("④ Catalog and policy coherence (source)");

{
  const policy = read("server/scheduler/policy.ts");
  const catalog = read("server/scheduler/catalog.ts");
  const registry = read("server/scheduling/registry.ts");

  const policyIds = [...policy.matchAll(/jobId:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const registryIds = [...registry.matchAll(/^\s{4}id:\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1]);
  const extraIds = [...catalog.matchAll(/^\s{4}id:\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1]);

  assert(
    registryIds.length >= 8,
    `the registry parse found ${registryIds.length} jobs, so this check is not vacuous`,
  );

  const missing = registryIds.filter((id) => !policyIds.includes(id));
  assert(
    missing.length === 0,
    "every job in server/scheduling/registry.ts has a policy",
    `missing: ${missing.join(", ")}`,
  );

  const orphans = policyIds.filter(
    (id) => !registryIds.includes(id) && !extraIds.includes(id),
  );
  assert(
    orphans.length === 0,
    "no policy names a job that does not exist",
    `orphans: ${orphans.join(", ")}`,
  );

  /**
   * ⭐ THE CHECK THE WHOLE CATALOG FILE EXISTS FOR. There are TWO job
   * registries in this repository and nothing related them: the six AI
   * background workers at /api/workers/ai-monitors are in no document,
   * have no entitlement gate, and have their own separate 100-workspace
   * cap. A control plane that covered one and not the other would make
   * the invisible one permanently invisible.
   */
  assert(
    /ai_background_workers/.test(catalog),
    "the six AI background workers are accounted for in the catalog",
    "grep `ai-monitors` in docs/current/CRON-RUNBOOK.md returns nothing — they are in no document",
  );
  assert(
    /BACKGROUND_WORKERS/.test(catalog),
    "the catalog imports the AI worker registry, so its size is checked at run time rather than " +
      "assumed",
  );
}

/* ================================================================== */

console.log(
  `\n${failures === 0 ? "✅" : "❌"} scheduler self-check: ${checks - failures}/${checks} passed.`,
);

if (failures > 0) {
  console.error(
    `\n${failures} check(s) failed. Every one of them is a property whose absence has no ` +
      `symptom — nothing gets slower, louder or redder. Fix before shipping.\n`,
  );
  process.exit(1);
}
