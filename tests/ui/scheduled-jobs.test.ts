/**
 * Ordence — ⭐⭐⭐ THE WORK THAT NOTHING RAN
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * Six functions existed, were correct, were covered by unit tests, and
 * were called by nothing. `runDunningSweep` had thirty assertions about
 * how it behaves and not one about whether anything invokes it — so the
 * collections ladder never advanced, no `credit_dunning_log` row was ever
 * written, and the outbox drain the previous batch built had nothing to
 * drain. Every one of those thirty assertions passed the whole time.
 *
 * ⚠️ SO THE FIRST BLOCK BELOW ASSERTS REACHABILITY, WHICH IS THE THING
 * THE EXISTING SUITE COULD NOT SEE. A function is reachable when some
 * path from an HTTP request arrives at it, and the test walks that path
 * rather than asserting the function exists.
 *
 * ⚠️ AND NOT ONE COUNT IS PINNED. `expect(jobs.length).toBe(7)` has
 * failed five correct changes in this codebase. Adding an eighth job must
 * not turn this file red; adding one WITHOUT a schedule, a consequence or
 * an idempotency argument must.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * ⚠️ COMMENTS STRIPPED. This repository documents its reasoning in prose
 * next to the code, so an assertion on raw source can pass on a sentence
 * describing the thing rather than on the thing. Where the LITERAL
 * matters, the raw source is read instead and the test says so.
 */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const REGISTRY = read("server/scheduling/registry.ts");
const ROUTE = read("app/api/workers/route.ts");
const RUNBOOK = read("docs/current/CRON-RUNBOOK.md");

/* ================================================================== */
/* ① EVERY DEAD FUNCTION NOW HAS A PATH FROM AN HTTP REQUEST           */
/* ================================================================== */

/**
 * The six, by the module the work actually lives in after Brief C moved
 * two of them out of their `"use server"` files.
 *
 * ⚠️ KEYED ON THE IMPORT, NOT ON A COUNT. A seventh entry here is a
 * seventh line, not a number to update in two places.
 */
const REACHED = [
  ["the dunning sweep", "@/server/credit/dunning-sweep", "sweepDunningForTenant"],
  ["the rhythm recompute", "@/server/patterns/rhythm-recompute", "recomputeRhythmsForTenant"],
  ["storage reconciliation", "@/server/metering/record", "reconcileStorageLevel"],
  ["anomaly detection", "@/server/security/anomalies", "runAnomalyDetection"],
  ["the workflow tick", "@/server/workflows/dispatch", "dispatchScheduled"],
  ["the RERA dunning plan", "@/server/receivables/dunning", "planDunningSweep"],
  ["the mail drain", "@/server/email/outbox", "dispatchTenantOutbox"],
] as const;

describe("🔴 the six functions nothing called are now reachable", () => {
  const registryCode = codeOnly(REGISTRY);

  for (const [what, module, fn] of REACHED) {
    it(`${what} is imported and invoked by the registry`, () => {
      expect(registryCode).toContain(module);
      expect(registryCode).toContain(fn);
      /*
       * ⚠️ AN IMPORT IS NOT A CALL. `import { x }` with no `x(` anywhere
       * is precisely the shape of a function that is "wired" and dead —
       * which is the family of defect this whole batch is about. So the
       * assertion is on the invocation.
       */
      expect(registryCode).toMatch(new RegExp(`${fn}\\s*\\(`));
    });
  }

  it("the route reaches the registry, so an HTTP request reaches the work", () => {
    const routeCode = codeOnly(ROUTE);
    expect(routeCode).toContain("@/server/scheduling/registry");
    expect(routeCode).toMatch(/runScheduledJob\s*\(/);
    expect(routeCode).toMatch(/findScheduledJob\s*\(/);
    /*
     * 🔴 THE DISPATCH BRANCH ITSELF. Importing the registry into a route
     * that never selects the "scheduled" mode would compile, pass every
     * other assertion here, and run nothing.
     */
    expect(routeCode).toMatch(/parsed\.mode === "scheduled"/);
  });

  it("the route path is one middleware already treats as public", () => {
    /*
     * 🔴 THE FAILURE THIS CATCHES IS THE ONE THIS REPOSITORY HAS SHIPPED
     * MOST OFTEN. `createRouteMatcher` matches paths EXACTLY — which is
     * why `/api/workers` and `/api/workers/ai-monitors` are two separate
     * entries in the public list. A scheduled endpoint at a new path
     * would be refused by Clerk on every single run: present, correct,
     * never executed, indistinguishable from working.
     *
     * ⚠️ READ FROM RAW SOURCE. The whole meaning is the literal.
     */
    const middleware = read("middleware.ts");
    expect(middleware).toContain('"/api/workers"');
  });
});

/* ================================================================== */
/* ② EVERY REGISTERED JOB SAYS ENOUGH TO BE OPERATED                   */
/* ================================================================== */

type ParsedJob = {
  id: string;
  block: string;
};

/**
 * ⚠️ PARSED FROM SOURCE RATHER THAN IMPORTED, because importing
 * `server/scheduling/registry.ts` pulls in the database client, the queue
 * bindings and the whole workflow engine — a UI test that needs Postgres
 * to run is a UI test nobody runs.
 */
function parsedJobs(): ParsedJob[] {
  const body = REGISTRY.slice(REGISTRY.indexOf("export const SCHEDULED_JOBS"));
  const marker = /\n    id:\s*"([a-z0-9_]+)",/g;
  const starts: Array<{ id: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(body)) !== null) starts.push({ id: m[1]!, at: m.index });
  return starts.map((s, i) => ({
    id: s.id,
    block: body.slice(s.at, starts[i + 1]?.at ?? body.length),
  }));
}

describe("every registered job can be operated", () => {
  const jobs = parsedJobs();

  it("there is at least one, so a broken parse cannot make this file vacuous", () => {
    /*
     * ⚠️ A LOWER BOUND, NOT A COUNT. Pinning the number would fail the
     * next correct change; asserting nothing at all would let a parse
     * that matched zero jobs pass every test below by iterating an empty
     * list, which is the shape of green that means nothing.
     */
    expect(jobs.length).toBeGreaterThan(0);
  });

  for (const job of parsedJobs()) {
    describe(job.id, () => {
      it("says what stops working when it stops running", () => {
        /*
         * A red tick with no consequence attached is a red tick nobody
         * gets out of bed for. The runbook prints this sentence.
         */
        expect(job.block).toMatch(/consequenceWhenStopped:\s*\n?\s*"[^"]{60,}"/);
      });

      it("carries a cron expression and the IST time it lands on", () => {
        expect(job.block).toMatch(/cronUtc:\s*"[-\d*,/ ]+"/);
        expect(job.block).toMatch(/cadenceInIst:\s*"[^"]{5,}"/);
      });

      it("argues why running it twice is safe", () => {
        /*
         * 🔴 IDEMPOTENCY IS THE WHOLE GAME. A cron that runs twice must
         * not dun twice, hold credit twice, or send twice. A job whose
         * author could not write the sentence has not thought about it.
         */
        expect(job.block).toMatch(/idempotency:\s*\n?\s*"[^"]{60,}"/);
      });

      it("is entitlement-gated, platform-scoped, or argues why not", () => {
        /*
         * 🔴 THIRTY FOUR OF SEVENTY ONE ENTITLEMENT KEYS HAVE BEEN GATED
         * BY NOTHING in this codebase. A nightly job delivering a paid
         * capability to a workspace that has not paid for it is that
         * defect with a clock attached, and it is invisible: no screen
         * shows what a cron did.
         *
         * ⚠️ AND THERE IS EXACTLY ONE LEGITIMATE UNGATED PER-TENANT JOB,
         * so the escape hatch is a SENTENCE rather than a boolean. The
         * mail drain finishes work an already-gated feature authorised;
         * refusing to drain a lapsed workspace's queue would strand
         * statutory notices rather than withhold a capability. Anybody
         * adding a second one has to write down why.
         */
        const platform = /scope:\s*"platform"/.test(job.block);
        const feature = /feature:\s*"[a-z]+\.[a-z_]+"/.test(job.block);
        if (platform) {
          expect(job.block).toMatch(/feature:\s*null/);
          return;
        }
        if (feature) return;
        expect(job.block, `${job.id} is per-tenant and ungated`).toMatch(
          /ungatedBecause:\s*\n?\s*"[^"]{60,}"/,
        );
      });

      it("has a runner matching its declared scope", () => {
        const platform = /scope:\s*"platform"/.test(job.block);
        expect(job.block).toContain(platform ? "runPlatform:" : "runForTenant:");
      });
    });
  }
});

/* ================================================================== */
/* ③ THE BOUND IS NOT A SILENT ONE                                     */
/* ================================================================== */

describe("🔴 a silent cap is a lie", () => {
  const code = codeOnly(REGISTRY);

  it("selects one more workspace than it will run, so the tail is countable", () => {
    /*
     * ⚠️ SELECTING EXACTLY THE BOUND CANNOT TELL "there were 500" FROM
     * "there were 6,000". `truncated: true` with no number was the shape
     * that made MAX_TENANTS_PER_SWEEP mean nothing to an operator.
     */
    expect(code).toMatch(/limit\(\s*bound \+ 1\s*\)/);
  });

  it("reports the dropped workspaces as a number", () => {
    expect(code).toContain("notReached");
    expect(code).toMatch(/notReached\s*=\s*.*Math\.max\(0, all\.length - bound\)/);
  });

  it("a dropped workspace makes the run fail, not merely annotate it", () => {
    /*
     * 🔴 THE PROPERTY THAT MATTERS. If `notReached` only appeared in the
     * body, the operator would read "swept" as "swept everything" and the
     * cap would never be raised.
     */
    expect(code).toMatch(/ok:\s*failed === 0 && notReached === 0/);
  });

  it("one workspace failing does not abort the others", () => {
    /*
     * Stopping at the first error means one broken workspace freezes the
     * collections ladder for every other one.
     */
    expect(code).toMatch(/catch\s*\(err\)/);
    expect(code).toMatch(/results\.push\(\{[^}]*ok: false/);
  });

  it("the route turns a failed run into a non-2xx", () => {
    /*
     * ⚠️ NOTHING DOWNSTREAM READS JSON. The status code is the alert.
     */
    expect(codeOnly(ROUTE)).toMatch(/status:\s*run\.ok \? 200 : 500/);
  });
});

/* ================================================================== */
/* ④ THE SCHEDULER HAS NO USER, AND SAYS SO                            */
/* ================================================================== */

describe("🔴 there is no service account", () => {
  const code = codeOnly(REGISTRY);

  it("writes a system audit row rather than borrowing a person's name", () => {
    expect(code).toContain("writeSystemAudit");
    expect(code).toContain('actorLabel: "scheduler"');
  });

  it("records a null author on every row the sweep creates", () => {
    /*
     * ⚠️ `created_by` IS NULLABLE and that is the honest value. A sweep
     * that borrowed a user id would put somebody's signature on a letter
     * they did not decide to send, and "who chased this customer" would
     * have a plausible wrong answer instead of a true one.
     */
    expect(code).toMatch(/actorUserId:\s*null/);
    expect(code).toMatch(/impersonationId:\s*null/);
  });

  it("lists workspaces under the platform marker, never unscoped", () => {
    /*
     * 🔴 CROSS-TENANT AND UNSCOPED ARE NOT THE SAME THING. With no
     * session variable set, the `tenants` policy matches nothing, so
     * under a role that does not bypass RLS an unscoped sweep processes
     * ZERO workspaces, silently, every night, forever.
     */
    expect(code).toContain("withPlatformScope");
  });

  it("keeps the tenant-taking work out of the `use server` modules", () => {
    /*
     * 🔴 EVERY EXPORT OF A `"use server"` MODULE IS A BROWSER-REACHABLE
     * RPC ENDPOINT, and one that accepts a tenant id is the single route
     * past row-level security. Phase 47 shipped exactly that bug.
     *
     * ⚠️ RAW SOURCE. The whole meaning is the literal directive.
     */
    for (const file of [
      "server/credit/dunning-sweep.ts",
      "server/patterns/rhythm-recompute.ts",
      "server/scheduling/registry.ts",
      "server/scheduling/entitlement.ts",
    ]) {
      const source = read(file);
      expect(source, file).toContain('import "server-only"');
      /*
       * ⚠️ STRIPPED, because these files QUOTE the rule in their headers
       * — the reason each of them exists is that a `"use server"` export
       * taking a tenant id is a way past row-level security. Matching the
       * raw source would have forced somebody to delete the explanation
       * to make the test pass, which is how the reasoning leaves a
       * codebase.
       */
      expect(codeOnly(source), file).not.toContain('"use server"');
    }
  });

  it("the action files still gate, and no longer do the work", () => {
    const credit = read("server/actions/credit.ts");
    expect(credit).toContain("guardSalesWrite");
    expect(credit).toContain("sweepDunningForTenant");
    /*
     * ⚠️ THE INSERT MOVED. If it were still here, there would be two
     * copies of the ladder and they would drift.
     */
    const sweep = credit.slice(
      credit.indexOf("export async function runDunningSweep"),
      credit.indexOf("THE BOARD"),
    );
    expect(sweep).not.toContain("creditDunningLog");
    expect(sweep).not.toContain("enqueueEmail");
  });
});

/* ================================================================== */
/* ⑤ THE SWEEP STILL QUEUES AND STILL DOES NOT LIE                     */
/* ================================================================== */

/**
 * ⚠️ THESE MOVED HERE FROM `email-outbox.test.ts` AND
 * `credit-control.test.ts`, WHICH READ THEM OUT OF
 * `server/actions/credit.ts`.
 *
 * They were assertions about the SWEEP, pinned to the FILE the sweep
 * happened to live in — the exact shape the house rule warns about. The
 * properties are unchanged; only the path they are read from is.
 */
describe("the dunning sweep, wherever it lives", () => {
  const SWEEP = read("server/credit/dunning-sweep.ts");
  const sweepCode = codeOnly(SWEEP);

  it("enqueues only the rungs this run actually recorded", () => {
    expect(sweepCode).toContain("onConflictDoNothing()");
    expect(sweepCode).toMatch(/const recorded = await tx/);
    expect(sweepCode).toMatch(/for \(const written of recorded\)/);
    expect(sweepCode).toContain("enqueueEmail(tx");
  });

  it("records the letter as queued, never as sent", () => {
    expect(SWEEP).not.toMatch(/delivery:\s*"sent"/);
    expect(sweepCode).not.toMatch(/sentAt:/);
  });

  it("only email rungs with an address earn a letter", () => {
    // ⚠️ RAW SOURCE: the guard's meaning is the literal it compares against.
    expect(SWEEP).toMatch(/action\.channel !== "email"/);
    expect(sweepCode).toMatch(/!action\.recipientEmail/);
  });

  it("⚠️ the date comes from Asia/Kolkata, never from toISOString", () => {
    /*
     * India is UTC+5:30, so between midnight and 05:30 IST a UTC date is
     * YESTERDAY — and the recommended cron fires at 19:30 UTC, which is
     * inside exactly that window.
     */
    expect(sweepCode).toMatch(/todayInIndia\(/);
    expect(sweepCode).not.toMatch(/toISOString/);
  });

  it("imports no mail transport", () => {
    expect(sweepCode).not.toMatch(/resend|nodemailer|sendMail|sendEmail/i);
  });

  it("the outbox key is derived from the row, not the clock", () => {
    /*
     * 🔴 THE IDEMPOTENCY PROOF FOR A DOUBLE RUN. A key containing a
     * timestamp would be different on the second pass and the unique
     * index would accept a second letter for a rung already chased.
     */
    expect(SWEEP).toContain("idempotencyKey: `dunning:${written.id}`");
    expect(sweepCode).not.toMatch(/idempotencyKey:.*Date\.now/);
  });
});

/* ================================================================== */
/* ⑥ THE RUNBOOK IS GENERATED, SO IT CANNOT DRIFT                      */
/* ================================================================== */

describe("the operator runbook", () => {
  it("matches what the generator would emit from the registry today", async () => {
    /*
     * 🔴 A RUNBOOK NAMING SIX JOBS WHILE THE CODE REGISTERS SEVEN IS A
     * GUARANTEE THAT THE SEVENTH NEVER RUNS. That is this batch's own
     * defect reproduced in a markdown file, and the only defence that
     * survives a tired evening is a comparison.
     */
    const { buildRunbook } = await import("@/scripts/generate-cron-runbook.mjs");
    expect(RUNBOOK).toBe(buildRunbook());
  });

  it("names every registered job", () => {
    for (const job of parsedJobs()) {
      expect(RUNBOOK, job.id).toContain(`"jobId":"${job.id}"`);
    }
  });

  it("uses curl -f, so a partial failure cannot report green", () => {
    const blocks = [...RUNBOOK.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("\n");
    expect(blocks).toContain("curl -fsS");
    expect(blocks).toContain("Authorization: Bearer $WORKER_API_SECRET");
  });

  it("keeps the canary on its own secret", () => {
    /*
     * ⚠️ The canary's response names real workspace ids. It should not be
     * reachable with the token a cron runner holds for everything else.
     */
    const canary = RUNBOOK.slice(RUNBOOK.indexOf("/api/cron/canary"));
    expect(canary).toContain("$CRON_SECRET");
  });

  it("says 503 is not green", () => {
    /*
     * 🔴 INCONCLUSIVE IS RED ON PURPOSE. A green tick from a connection
     * that bypasses row-level security is the worst outcome available.
     */
    expect(RUNBOOK).toMatch(/503[\s\S]{0,400}not green/i);
  });

  it("states the repo and whether SQL is required", () => {
    // House rule for owner-facing documents.
    expect(RUNBOOK).toContain("app.ordence");
    expect(RUNBOOK).toContain("No SQL");
  });

  it("has no em-dashes", () => {
    expect(RUNBOOK).not.toContain("—");
  });
});

/* ================================================================== */
/* ⑦ THE ENVIRONMENT CATALOGUE GATE                                    */
/* ================================================================== */

describe("the environment catalogue", () => {
  const CATALOGUE = read("lib/platform/env-catalog.ts");

  /**
   * ⚠️ NAMES, NOT A COUNT. Each of these was read by the running code and
   * absent from the catalogue at v1.65.0-alpha, so `/api/diag` reported
   * them as though they did not exist. The list may grow; it may not
   * silently lose a member.
   */
  const WAS_MISSING = [
    "RESEND_WEBHOOK_SECRET",
    "SENTRY_DSN",
    "NEXT_PUBLIC_SENTRY_DSN",
    "SENTRY_AUTH_TOKEN",
    "CORS_ALLOWED_ORIGINS",
    "APP_HOST",
    "ORDENCE_PLATFORM_HOST",
    "OPENROUTER_API_KEY",
    "EDGE_LIMIT_MODE",
    "EDGE_LIMIT_PLATFORM_FAIL_OPEN",
    "NEXT_PUBLIC_ORDENCE_TRIAL_NOTICE_DAYS",
    "NEXT_PUBLIC_ORDENCE_TRIAL_GRACE_DAYS",
    "NEXT_PUBLIC_ORDENCE_DUNNING_GRACE_DAYS",
    "CLERK_PUBLISHABLE_KEY",
  ];

  for (const name of WAS_MISSING) {
    it(`catalogues ${name}`, () => {
      expect(CATALOGUE).toContain(`"${name}"`);
    });
  }

  it("ships every catalogued name on the paste sheet", () => {
    /*
     * 🔴 THE PASTE SHEET OMITTED ALL FOUR S3_ NAMES AND EVERY AI KEY. An
     * operator following it verbatim got a deployment with no document
     * storage and no AI, and nothing said so.
     */
    const sheet = read("RAILWAY-VARIABLES-PASTE.txt");
    const body = CATALOGUE.slice(CATALOGUE.indexOf("export const ENV_CATEGORIES"));
    const names = new Set([...body.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!));
    expect(names.size).toBeGreaterThan(20);
    for (const name of names) {
      expect(sheet, name).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("still leaves PLATFORM_HOST blank", () => {
    /*
     * 🔴 SETTING IT TO THE APPLICATION'S OWN HOSTNAME MAKES THE CUSTOMER
     * APP UNREACHABLE: every request classifies as the platform host,
     * /dashboard and /sign-in rewrite into /platform/*, which 404, and
     * /api/health stays green throughout. The generator must not have
     * lost that.
     */
    const sheet = read("RAILWAY-VARIABLES-PASTE.txt");
    expect(sheet).toMatch(/^PLATFORM_HOST=$/m);
  });

  it("prints no value that looks like a credential", () => {
    /*
     * Three secrets were once committed as literals under "copy these
     * exactly", so anybody with repository read access held the worker
     * bearer token, the cron secret and the upload-ticket HMAC key.
     */
    const sheet = read("RAILWAY-VARIABLES-PASTE.txt");
    const allowed = new Set(["PASTE_HERE", "production", "true", "false"]);
    for (const line of sheet.split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(line.trim());
      if (!m) continue;
      const value = m[2]!.trim();
      if (allowed.has(value)) continue;
      expect(/^[A-Za-z0-9_-]{20,}$/.test(value), `${m[1]}=${value}`).toBe(false);
    }
  });

  it("the gate refuses to pass on a matcher that has stopped matching", () => {
    /*
     * ⚠️ A GATE THAT SILENTLY FINDS NOTHING PASSES EVERY RUN AND PROVES
     * NOTHING. The self-checks are the difference between this gate and a
     * `process.exit(0)`.
     */
    const gate = read("scripts/check-env-catalogue.mjs");
    expect(gate).toMatch(/found\.size < 20/);
    expect(gate).toMatch(/providerShapeHits === 0/);
    expect(gate).toMatch(/aliasShapeHits === 0/);
  });

  it("understands the alias shape the storage settings are read through", () => {
    /*
     * 🔴 WITHOUT THIS, ALL FOUR S3_ NAMES REPORT AS "catalogued and read
     * by nothing", and the obvious response to that report is to delete
     * the only settings that give this product document storage.
     */
    const s3 = read("lib/storage/s3.ts");
    expect(s3).toMatch(/=\s*process\.env as/);
    expect(s3).toContain("bag.S3_ENDPOINT");
  });
});

/* ================================================================== */
/* ⑧ THE AI MONITOR SWEEP NO LONGER REPORTS GREEN WHEN IT FAILED       */
/* ================================================================== */

describe("🔴 the AI monitor sweep hardcoded ok: true", () => {
  const code = codeOnly(read("app/api/workers/ai-monitors/route.ts"));

  it("derives ok from the error count and the cap", () => {
    /*
     * It counted `totalErrors` and then answered `{"ok":true}` with HTTP
     * 200 regardless. A sweep in which every worker failed for every
     * workspace reported green, with the number right there in the body.
     */
    expect(code).toMatch(/const ok = totalErrors === 0 && !truncated/);
  });

  it("turns that into a non-2xx", () => {
    expect(code).toMatch(/status:\s*ok \? 200 : 500/);
  });

  it("counts the workspaces the cap dropped instead of only flagging them", () => {
    /*
     * ⚠️ Selecting exactly the cap cannot tell "there were 100" from
     * "there were 6,000". One extra row answers it, and the extra row is
     * dropped rather than run.
     */
    expect(code).toMatch(/limit\(MAX_TENANTS_PER_SWEEP \+ 1\)/);
    expect(code).toMatch(/const notReached = activeTenants\.length - sweepTenants\.length/);
    expect(code).toMatch(/const truncated = notReached > 0/);
  });
});
