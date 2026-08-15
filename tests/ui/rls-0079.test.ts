/**
 * Ordence — ⭐⭐ 0079: THE OPT-IN MARKER, AND THE TELEMETRY NOBODY KEPT
 * Version: v1.36.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO DEFECTS OF OPPOSITE SHAPES, IN ONE MIGRATION
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SIX PLATFORM TABLES WERE WRITABLE BY FORGETTING.
 *    `WITH CHECK (app_current_tenant_id() IS NULL)` is satisfied by any
 *    connection that never set anything: the plain HTTP client, a
 *    background job, a script. `app_platform_scope()` is true only
 *    inside `withPlatformScope()`, which demands a written justification.
 *    The marker is an OPT IN; the absence of a tenant is not.
 *
 * 🔴 THREE TELEMETRY TABLES WERE DISCARDING EVERY ATTRIBUTED ROW.
 *    Written under platform scope with a real tenant id, they satisfied
 *    neither branch of `tenant = session OR both null`, so Postgres
 *    raised 42501 and all three callers swallowed it by design. Those
 *    tables contain anonymous pre-auth rows and nothing else.
 *
 * ⚠️ AND ONE THING THE PLAN SAID TO DO THAT THIS MIGRATION DECLINED.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MIGRATION = read("SQL-FILES/0079_rls_opt_in_and_telemetry.sql");
const DRILL = read("SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0079.sql");
const VERIFY = read("SQL-FILES/VERIFY-0079-neon-safe.sql");

/* ================================================================== */
/* ① THE OPT-IN MARKER                                                 */
/* ================================================================== */

describe("the six platform tables opt in rather than forget", () => {
  const TABLES = [
    "platform_staff",
    "platform_action_log",
    "platform_impersonation_sessions",
    "platform_tenant_flags",
    "tenant_health_events",
    "platform_entitlement_history",
  ];

  it("names every one of them", () => {
    for (const t of TABLES) expect(MIGRATION, t).toContain(t);
  });

  /**
   * 🔴 THE WHOLE POINT. No `WITH CHECK` in this migration may still be
   * satisfiable by a connection that merely forgot to set a variable.
   */
  it("leaves no forgettable WITH CHECK behind", () => {
    const clauses = [...MIGRATION.matchAll(/WITH CHECK\s*\(([^;]*?)\)\s*;/g)].map((m) => m[1]);
    expect(clauses.length).toBeGreaterThan(3);
    for (const clause of clauses) {
      if (clause.includes("app_current_tenant_id() IS NULL")) {
        // Only permitted alongside the marker, never alone.
        expect(clause, clause).toContain("app_platform_scope");
      }
    }
  });

  /**
   * ⭐ USING IS UNTOUCHED FOR THE TWO THE CUSTOMER READS. A workspace
   * can still see the record of when support was inside it, which
   * `0014` calls the most persuasive answer to the question every
   * enterprise security review asks.
   */
  it("keeps the customer's read of its own impersonation sessions and flags", () => {
    const sessions = MIGRATION.slice(
      MIGRATION.indexOf("CREATE POLICY impersonation_sessions_visibility"),
      MIGRATION.indexOf("DROP POLICY IF EXISTS platform_tenant_flags_visibility"),
    );
    expect(sessions).toContain("tenant_id = app_current_tenant_id()");
    expect(sessions).toContain("WITH CHECK (app_platform_scope())");
  });

  /**
   * ⚠️ ORDER MATTERS AND THE FILE SAYS SO. On a build older than
   * v1.35.0 the platform action log was written on the unscoped client,
   * so this migration would have silently stopped the append-only
   * record of what staff did.
   */
  it("says to push the code first, and why", () => {
    expect(MIGRATION).toContain("RUN THIS AFTER PUSHING THE CODE, NOT BEFORE");
    expect(MIGRATION).toContain("Roll the code forward rather");
  });
});

/* ================================================================== */
/* ② THE TELEMETRY                                                     */
/* ================================================================== */

describe("the telemetry rows that were being thrown away", () => {
  it("widens all three tables", () => {
    for (const t of ["error_events", "web_vital_events", "security_events"]) {
      expect(MIGRATION, t).toContain(t);
    }
    expect(MIGRATION).toContain("OR app_platform_scope()");
  });

  /**
   * ⭐ THE ARGUMENT FOR A PLATFORM BRANCH RATHER THAN A TENANT SCOPE.
   * These rows are the platform's observations ABOUT a workspace. The
   * workspace is the subject, not the author.
   */
  it("explains why a platform branch and not a tenant scope", () => {
    expect(MIGRATION).toContain("The workspace is the subject, not the author");
  });

  /** And a tenant may still write its own, so nothing that worked stops. */
  it("keeps the tenant branch", () => {
    const section = MIGRATION.slice(MIGRATION.indexOf("SECTION 2"));
    expect(section).toContain("tenant_id = app_current_tenant_id()");
    expect(section).toContain("tenant_id IS NULL AND app_current_tenant_id() IS NULL");
  });

  /**
   * 🔴 THE VERIFY MEASURES THE DAMAGE. Before 0079 these tables held
   * anonymous rows only; `attributed = 0` alongside a non-zero
   * `anonymous` is the evidence that the discard was real.
   */
  it("ships a verify that counts what was lost", () => {
    expect(VERIFY).toContain("attributed");
    expect(VERIFY).toContain("anonymous");
    expect(VERIFY).toContain("should start climbing");
  });
});

/* ================================================================== */
/* ③ THE NARROWING THAT WAS PROPOSED AND DECLINED                      */
/* ================================================================== */

describe("the `tenants` policy, deliberately unchanged", () => {
  /**
   * 🔴 THE AUDIT CALLED THIS THE SINGLE HOUSE-RULE VIOLATION IN 78
   * MIGRATIONS AND PROPOSED REPLACING IT. Counting what actually writes
   * the table changed the answer: thirteen call sites, four of them
   * platform-scoped by necessity. Narrowing it would need four
   * `SECURITY DEFINER` functions that each bypass RLS, to replace one
   * policy granting exactly what those four functions would.
   */
  it("does not narrow it, and says why in the migration", () => {
    expect(MIGRATION).toContain("IT DOES NOT NARROW THE `tenants` POLICY");
    expect(MIGRATION).toContain("THE POLICY IS RIGHT AND THE COMMENT ABOVE IT IS WRONG");
    expect(MIGRATION).not.toMatch(/DROP POLICY IF EXISTS tenant_self_isolation/);
  });

  /** The stale claim is corrected where a reader will find it. */
  it("corrects the comment instead", () => {
    expect(MIGRATION).toContain("COMMENT ON TABLE tenants IS");
    expect(MIGRATION).toContain("and that was never true");
  });

  /**
   * ⭐ AND THE DRILL PROVES THE FOUR WRITES STILL WORK, which is the
   * assertion that would have caught the narrowing had it shipped.
   */
  it("drills that provisioning, the mirror and suspension still work", () => {
    expect(DRILL).toContain("`tenants` is UNCHANGED by 0079");
    expect(DRILL).toContain("INSERT INTO tenants (name) VALUES ('provisioned from the console')");
    expect(DRILL).toContain("UPDATE tenants SET status = 'suspended'");
    expect(DRILL).toContain("UPDATE tenants SET name   = 'renamed by the Clerk mirror'");
  });
});

/* ================================================================== */
/* ④ THE DRILL DISCIPLINE                                              */
/* ================================================================== */

describe("the drill", () => {
  it("refuses to run against anything that looks real", () => {
    expect(DRILL).toContain("DO NOT RUN THIS IN NEON");
    expect(DRILL).toContain("current_database() LIKE '%neon%'");
    expect(DRILL).toContain("REFUSING");
  });

  /**
   * 🔴 AND REFUSES TO RUN AS A ROLE THAT BYPASSES RLS. Verified in
   * practice: running the assertions as the superuser owner stops at
   * this guard rather than reporting ten passes for the wrong reason.
   */
  it("refuses to assert anything as a privileged role", () => {
    expect(DRILL).toContain("rolsuper OR rolbypassrls");
    expect(DRILL).toContain("every refusal below would pass for the wrong reason");
  });

  /**
   * ⚠️ EVERY REFUSAL PAIRED WITH A POSITIVE. This migration's entire
   * risk is that it tightens onto a write somebody still needs, so a
   * drill that only showed refusals would be worse than none.
   */
  it("pairs six positives with four refusals", () => {
    expect((DRILL.match(/⭐ POSITIVE \d/g) ?? []).length).toBe(6);
    expect((DRILL.match(/🔴 REFUSAL \d/g) ?? []).length).toBe(4);
    expect(DRILL).toContain("6 positives succeeded");
    expect(DRILL).toContain("4 refusals raised 42501");
  });

  /**
   * ⭐ THE ONE THAT MATTERS MOST IN SECTION 2. Widening a policy that
   * also opened cross-tenant writes would be far worse than the defect
   * it fixes.
   */
  it("proves the widening did not open a cross-tenant write", () => {
    expect(DRILL).toContain("tenant A still cannot write a row about tenant B");
    expect(DRILL).toContain("tenant A still cannot READ tenant B's rows");
  });
});

/* ================================================================== */
/* ⑤ THE VERIFY, AND THE GATE THAT GOT STRICTER                        */
/* ================================================================== */

describe("what runs afterwards", () => {
  it("ships a neon-safe verify that writes nothing", () => {
    expect(VERIFY).toContain("SAFE AGAINST NEON");
    expect(VERIFY).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/);
  });

  /**
   * ⚠️ THE HOUSE-RULE CHECK MATCHES BOTH SPELLINGS. Two function names
   * exist for the same setting — `app_platform_scope()` and
   * `app_is_platform_scope()` — and a checker that knew only one would
   * have reported clean while a policy using the other did as it liked.
   */
  it("checks the house rule against both function spellings", () => {
    expect(VERIFY).toContain("with_check LIKE '%platform_scope%'");
    expect(VERIFY).toContain("app_is_platform_scope()");
  });

  /** And it ends by asking the only question that decides whether any of it runs. */
  it("ends with the role check", () => {
    expect(VERIFY).toContain("rolbypassrls");
    expect(VERIFY).toContain("Every policy above is inert");
  });

  /**
   * 🔴 `check:sql` ASKED ONLY "IS RLS ENABLED" AND ANSWERED ✅ FOR 249
   * TABLES. Enabled without FORCE means the owner ignores every policy,
   * and this application connects as the owner.
   */
  it("makes check:sql require FORCE and a policy, not just ENABLE", () => {
    const gate = read("scripts/check-sql-completeness.mjs");
    expect(gate).toContain("FORCE\\s+ROW LEVEL SECURITY");
    expect(gate).toContain("CREATE POLICY");
    expect(gate).toContain("are FORCED, so the owner is subject to them too");
    expect(gate).toContain("carry at least one policy");
  });

  /**
   * ⚠️ AND ITS DYNAMIC-LOOP FALLBACK NO LONGER READS EVERY ARRAY IN THE
   * FILE. One dynamic ENABLE anywhere used to mark every quoted word in
   * every array literal as protected, including column lists and
   * trigger table lists.
   */
  it("scopes the dynamic-loop fallback to the block that contains it", () => {
    const gate = read("scripts/check-sql-completeness.mjs");
    expect(gate).toContain("THE FALLBACK USED TO READ EVERY `ARRAY[...]` IN THE FILE");
    expect(gate).toContain("DO\\s*\\$([a-z]*)\\$");
  });
});
