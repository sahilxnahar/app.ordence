/**
 * Ordence — ⭐⭐⭐ THE WRITES THE DATABASE WOULD REFUSE
 * Version: v1.33.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FINDING, AND IT ONLY EXISTS BECAUSE SOMETHING WAS EXECUTED
 * ══════════════════════════════════════════════════════════════════════
 * Every deployment document in this repository says, in bold, as a STOP
 * gate, that `DATABASE_URL` must name `ordence_app` and NOT the Neon
 * owner role — because the owner carries BYPASSRLS, which overrides even
 * FORCE ROW LEVEL SECURITY.
 *
 * The application could not run as `ordence_app`.
 *
 * 51 write statements across 18 files were issued on the module-level
 * `db` client: a plain connection with no session variable set. Against
 * a policy of `tenant_id = app_current_tenant_id()` that evaluates NULL,
 * so Postgres raises 42501. Among them, every statement in
 * `app/api/webhooks/clerk/route.ts` — the only path that creates a
 * `tenants` row or a `users` row.
 *
 * ⚠️ THE READS WERE WORSE THAN THE WRITES. A read with no GUC does not
 * error; it returns NOTHING. So the webhook's `existing` lookup was
 * always undefined, the handler always took the INSERT branch, and
 * Svix's at-least-once delivery would collide with the unique index.
 * The idempotency that file is built around evaporates.
 *
 * ⭐ THE UNCOMFORTABLE HALF. It works today because the connection
 * bypasses RLS, which means the sole tenant isolation mechanism in this
 * product is not in effect on the deployment it was written for. Every
 * audit that read those policies and pronounced them correct, mine
 * included, was reading something that is not running.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
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

/* ================================================================== */
/* ① THE GATE IS WIRED AND CAN FAIL                                    */
/* ================================================================== */

describe("check:rls-writes is wired in", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐ THE MANIFEST IS WHAT DECIDES WHETHER A GATE RUNS
   * ══════════════════════════════════════════════════════════════════
   * This used to grep `scripts/preflight.mjs` for the script filename
   * and a label. That was the honest assertion when preflight held a
   * hand-written list — and it broke, correctly, the moment infra wave
   * 12 replaced that list with `gatesInTier()` over
   * `scripts/gates.mjs`.
   *
   * ⚠️ THE FILENAME IS NO LONGER IN preflight.mjs AND THE GATE STILL
   * RUNS. Grepping the consumer was always a proxy for the real
   * question, which is: is this gate on the one list that preflight,
   * CI and `check:gate-coverage` all read? Ask that instead.
   */
  it("is a script, an npm target and an entry in the gate manifest", async () => {
    expect(read("package.json")).toContain('"check:rls-writes"');

    // preflight reads the manifest rather than naming gates itself.
    expect(read("scripts/preflight.mjs")).toContain("gatesInTier");

    const { GATES } = await import("../../scripts/gates.mjs");
    const gate = GATES.find((g: { id: string }) => g.id === "rls-writes");
    expect(
      gate,
      "check:rls-writes is not in scripts/gates.mjs, so preflight and CI both skip it",
    ).toBeDefined();
    expect(gate!.script).toBe("scripts/check-rls-writes.mjs");
  });

  /**
   * ⚠️ A BUDGET, NOT AN ALLOWLIST. 51 written excuses is a document that
   * reads as a decision and is actually a backlog. One number that may
   * only go down is harder to argue with.
   */
  it("carries budgets that can only be lowered", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("const UNSCOPED_WRITE_BUDGET =");
    expect(gate).toContain("const UNSCOPED_READ_BUDGET =");
    // ⭐ The nag is generic across both budgets now, so it names the
    // constant it wants lowered rather than hard-coding one of them.
    expect(gate).toContain("Lower ${name} to ${found.length}");
    expect(gate).toContain("budget is ${budget}");
  });

  /**
   * 🔴 THE WRITE BUDGET IS ZERO, AND IT REACHED ZERO. Every write in the
   * product now names the scope it runs in, so the database role every
   * deployment document demands would accept all of them.
   */
  it("has driven the unscoped writes to zero", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("const UNSCOPED_WRITE_BUDGET = 0;");
  });

  /**
   * 🔴 THE READS REACHED ZERO TOO, AND GETTING THERE CORRECTED A CLAIM.
   *
   * v1.34.0 called nine of the remaining reads "correct as they are"
   * because they read across every workspace by design. That was wrong:
   * "cross-tenant" and "unscoped" are not the same thing. With no
   * session variable the policy matches NOTHING, so the nightly sweep
   * would have enqueued work for zero workspaces and the anomaly
   * detector would have found zero anomalies — quiet reading as safe.
   * All nine needed `withPlatformScope`.
   */
  it("has driven the unscoped reads to zero as well", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("const UNSCOPED_READ_BUDGET = 0;");
    expect(gate).toContain("THAT WAS WRONG");
    expect(gate).toContain('"Cross-tenant" and "unscoped" are not the same');
  });

  /**
   * ⭐ AND THE HARNESS PROVES THE DISTINCTION, rather than leaving it as
   * an intention in a comment: unscoped sees nothing however much it
   * means to, platform scope sees every workspace.
   */
  it("proves that platform scope is what widens the view", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("a cross-tenant read UNSCOPED sees nothing");
    expect(gate).toContain("the same read under withPlatformScope sees every workspace");
  });

  /**
   * ⭐ AND THE HARNESS PROVES THE READ SEMANTICS, which are the half
   * that does not error: an unscoped read returns nothing, the same
   * read under `withTenant` returns the row, and the other tenant still
   * sees none of it.
   */
  it("proves that an unscoped read returns nothing rather than failing", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("AND THE READS, WHICH DO NOT ERROR AT ALL");
    expect(gate).toContain("returns NOTHING and raises no error");
    expect(gate).toContain("and tenant B still sees none of it");
  });

  /**
   * 🔴 THE EXECUTING HALF MUST REFUSE TO RUN AS A PRIVILEGED ROLE.
   * Verified by mutation: granting BYPASSRLS to the probe role makes the
   * gate fail with that message rather than passing ten assertions for
   * the wrong reason.
   */
  it("refuses to assert anything as a role that bypasses RLS", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("rolsuper OR rolbypassrls");
    expect(gate).toContain("Every assertion below would pass for the wrong reason");
    expect(gate).toContain("NOSUPERUSER NOBYPASSRLS");
  });

  /**
   * ⚠️ EVERY REFUSAL IS PAIRED WITH THE POSITIVE CASE. A harness that
   * only shows things being refused cannot tell "correctly locked down"
   * from "broken", which is the house rule for the drills and applies
   * here for the same reason.
   */
  it("pairs each refusal with the write that must still work", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("THE SANCTIONED PATHS");
    expect(gate).toContain("THE PAIRED REFUSALS");
    expect(gate).toContain("withPlatformScope may INSERT a tenant");
    expect(gate).toContain("withTenant A may NOT write a row belonging to tenant B");
    expect(gate).toContain("withPlatformScope may NOT write a customer's user row");
  });

  /** And it says out loud what went unchecked when it skips. */
  it("names what it did not check when there is no database", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    expect(gate).toContain("NOT CHECKED");
    expect(gate).toContain("NEVER NEON");
  });
});

/* ================================================================== */
/* ② THE DAY-ONE PATH IS SCOPED                                        */
/* ================================================================== */

describe("the Clerk webhook writes inside a scope", () => {
  // ⚠️ READS `_webhook.ts`, NOT `route.ts`. The implementation moved out
  // of the route file because Next.js refuses any non-route export from a
  // `route.ts`, and the evidence handlers had to be importable. The route
  // file is now a three-line wrapper; the code this test is about is in
  // `_webhook.ts`.
  const hook = read("app/api/webhooks/clerk/_webhook.ts");

  /**
   * 🔴 THE ONE THAT MATTERS MOST. Without this, a correctly configured
   * database means nobody can ever get a workspace.
   */
  it("creates the tenant under platform scope", () => {
    expect(hook).toContain('import { db, withPlatformScope, withTenant } from "@/db"');
    expect(hook).toContain("return withPlatformScope(");
    expect(hook).toContain("(tx) => organizationUpsert(tx, org)");
  });

  /**
   * ⭐ `withTenant`, NOT `withPlatformScope`, for the user. The `users`
   * policy admits platform scope on USING and deliberately not on WITH
   * CHECK, so support can read a customer's people and never edit them.
   * A platform-scoped insert here is refused, and that refusal is right.
   */
  it("creates the user under the tenant's own scope", () => {
    expect(hook).toContain("return withTenant(tenantId, (tx) => upsertUserIn(tx, tenantId, membership))");
  });

  /** ⚠️ The reads too. An unscoped read returns nothing and never errors. */
  it("resolves the workspace under a scope rather than unscoped", () => {
    expect(hook).toContain("const lookup = (reason: string) =>");
    expect(hook).toContain("Clerk webhook: resolve the workspace for a membership event");
    expect(hook).not.toMatch(/const tenant = await db\.query\.tenants/);
  });

  it("writes the customer's audit row as that customer", () => {
    expect(hook).toContain("await withTenant(entry.tenantId, (tx) =>");
    expect(hook).toContain("tx.insert(auditLogs).values({");
  });

  /** No statement in the file may still be on the unscoped client. */
  it("has no unscoped write left anywhere in the file", () => {
    expect(hook).not.toMatch(/\bdb\s*\.\s*(insert|update|delete)\s*\(/);
    expect(hook).not.toMatch(/await db$/m);
  });
});

/* ================================================================== */
/* ③ THE REST OF THE DAY-ONE SURFACE                                   */
/* ================================================================== */

describe("the actions that a new workspace touches first", () => {
  const scoped = (file: string) => {
    const src = read(file);
    expect(src, `${file} still imports withTenant`).toContain("withTenant");
    expect(src, `${file} has an unscoped write`).not.toMatch(
      /\bdb\s*\.\s*(insert|update|delete)\s*\(/,
    );
    expect(src, `${file} has an unscoped chain`).not.toMatch(/await db$/m);
  };

  it("onboarding writes the tenant as the tenant", () => scoped("server/actions/onboarding.ts"));
  it("settings writes the tenant as the tenant", () => scoped("server/actions/settings.ts"));
  it("team writes users as the tenant", () => scoped("server/actions/team.ts"));
  it("contacts writes as the tenant", () => scoped("server/actions/contacts.ts"));

  /**
   * 🔴 THE PERMISSION DENIAL LOG. Refusing somebody and then failing to
   * record it is the worst of both: they are blocked and nobody can see
   * that anybody tried.
   */
  it("records a permission denial inside the tenant's scope", () => {
    const src = read("server/audit.ts");
    expect(src).toContain("await withTenant(ctx.tenant.id, (tx) =>");
    expect(src).toContain("tx.insert(permissionDenials).values({");
  });

  /**
   * 🔴 AND THE PLATFORM ACTION LOG. `platform_action_log` is
   * platform-only on both clauses, so a write with no GUC at all is
   * refused — meaning the append-only record of what staff did was
   * failing silently, on a path whose own `catch` only calls
   * `console.error`.
   */
  it("writes the platform action log under platform scope", () => {
    const src = read("server/platform/guard.ts");
    expect(src).toContain("await withPlatformScope(");
    expect(src).toContain("tx.insert(platformActionLog).values({");
  });
});

/* ================================================================== */
/* ④ THE DEBT IS A NUMBER, AND IT IS GOING DOWN                        */
/* ================================================================== */

describe("the remaining unscoped writes", () => {
  /**
   * ⚠️ THIS TEST IS THE DEBT LEDGER. It fails when the count goes up,
   * and it fails when the gate's budget and reality disagree — so the
   * number cannot drift away from the truth in either direction.
   */
  it("matches the budget the gate enforces", () => {
    const gate = read("scripts/check-rls-writes.mjs");
    const budget = Number(gate.match(/const UNSCOPED_WRITE_BUDGET = (\d+);/)?.[1]);
    expect(Number.isFinite(budget)).toBe(true);

    let count = 0;
    for (const file of [...walk("app"), ...walk("server"), ...walk("lib")]) {
      const src = read(file);
      if (!/import\s*{[^}]*\bdb\b[^}]*}\s*from\s*"@\/db"/.test(src)) continue;
      if (/\(\s*db\s*\)\s*=>|async\s*\(\s*db\s*\)/.test(src)) continue;
      count += [...src.matchAll(/\bdb\s*\.\s*(insert|update|delete)\s*\(/g)].length;
    }

    expect(count).toBe(budget);
    // ⭐ Writes: 51 in v1.33.0, zero in v1.34.0.
    expect(count).toBe(0);

    // ⭐ Reads: 114 in v1.33.0, 15 in v1.34.0, zero now.
    const readBudget = Number(gate.match(/const UNSCOPED_READ_BUDGET = (\d+);/)?.[1]);
    expect(readBudget).toBe(0);
  });
});

/* ================================================================== */
/* ⑤ CROSS-TENANT MEANS PLATFORM SCOPE, NOT NO SCOPE                   */
/* ================================================================== */

describe("the reads that legitimately cross workspaces", () => {
  /**
   * 🔴 A NIGHTLY SWEEP THAT SEES ZERO WORKSPACES NEVER COMPLAINS. It
   * finishes, reports success, and enqueues nothing.
   */
  it("scopes both cron sweeps to the platform", () => {
    for (const file of ["app/api/workers/route.ts", "app/api/workers/ai-monitors/route.ts"]) {
      const src = read(file);
      expect(src, file).toContain("await withPlatformScope(");
      expect(src, file).toContain("Scheduled sweep: list the workspaces");
      expect(src, file).not.toMatch(/const activeTenants = await db/);
    }
  });

  /**
   * 🔴 AND AN ANOMALY DETECTOR THAT SEES ZERO EVENTS NEVER ALERTS,
   * which is the most dangerous shape of broken there is.
   */
  it("scopes the perimeter sweep to the platform", () => {
    const src = read("server/security/anomalies.ts");
    expect(src).toContain("Security sweep: read the perimeter across every workspace");
    expect(src).toContain("Security sweep: read permission denials across every workspace");
    expect(src).not.toMatch(/await db$/m);
  });

  /**
   * ⭐ THE PLATFORM DIRECTORY GOT ITS SCOPE AND ITS AUDIT IN THE SAME
   * CHANGE, deliberately. It returned nothing before, so it failed
   * closed by accident; scoping it alone would have turned an empty
   * screen into an unaudited substring search across every customer's
   * people, which is a strict downgrade.
   */
  it("scopes AND audits the cross-workspace user directory together", () => {
    const src = read("server/platform/users.ts");
    expect(src).toContain("await withPlatformScope(");
    expect(src).toContain('resourceType: "platform_user_directory"');
    expect(src).toContain('resourceType: "platform_user_profile"');
    // ⚠️ The search TERM is what makes it a people search rather than a
    // page of a list, so it is what the row has to carry.
    expect(src).toContain("Searched every workspace's people for");
    expect(src).toContain("resultCount: rows.length");
  });

  /**
   * ⚠️ AND ONE THING DELIBERATELY NOT AUDITED, with the reason next to
   * it: a filter dropdown of workspace names carries no people, no
   * money and no configuration. Auditing every dropdown render buries
   * the rows that matter.
   */
  it("says why the filter dropdown is not audited", () => {
    const src = read("server/platform/users.ts");
    expect(src).toContain("NOT AUDITED, AND THAT IS A DELIBERATE LINE");
  });
});
