/**
 * Ordence — ⭐⭐⭐ BATCH 153: THE TWO-LIVE-TENANT ISOLATION HARNESS
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR, AND WHAT IT CANNOT BE
 * ══════════════════════════════════════════════════════════════════════
 * `scripts/check-tenant-isolation.mjs` needs a Postgres. This suite does
 * not have one — vitest runs in CI with no database — so it CANNOT and
 * MUST NOT claim to verify that tenant B is refused tenant A's rows.
 * Only the harness proves that, and only when it runs.
 *
 * ⚠️ SO WHAT IS ASSERTED HERE IS THE DISCIPLINE, NOT THE RESULT. Every
 * property below is one whose removal would leave the harness still
 * running, still green, and no longer proving anything:
 *
 *   • the refusal on a privileged probe role
 *   • the positive controls
 *   • the mutation control that proves the probe can still fail
 *   • the loud skip
 *   • the countable coverage, including the endpoint gap
 *
 * ⭐ EACH OF THOSE IS EXACTLY ONE EDIT AWAY FROM BEING DELETED BY
 * SOMEBODY MAKING A RED RUN GO GREEN, which is the documented way this
 * class of control dies (`server/platform/canary.ts` sets the trap out
 * in full). A test that fails when the discipline is removed is the only
 * thing standing between "the harness passed" and "the harness was made
 * to pass".
 *
 * ⚠️ ABSENCE IS ASSERTED AGAINST COMMENT-STRIPPED SOURCE. Both files are
 * dense with prose that names the very things being forbidden — "a pass
 * with a warning", "FORCE ROW LEVEL SECURITY" — and a naive `toContain`
 * would match the warning about the mistake and read it as the mistake.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const HARNESS_PATH = "scripts/check-tenant-isolation.mjs";
const FIXTURE_PATH = "scripts/harness/tenant-isolation-fixture.sql";

const HARNESS = read(HARNESS_PATH);
const FIXTURE = read(FIXTURE_PATH);

/** Same shape as `tests/ui/order-create.test.ts`. Line numbers survive. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** SQL comments are `--` to end of line; the fixture is mostly comment. */
const sqlOnly = (s: string) => s.replace(/--[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const CODE = codeOnly(HARNESS);
const SQL = sqlOnly(FIXTURE);

/* ================================================================== */
/* ① IT EXISTS AND IT IS RUNNABLE                                      */
/* ================================================================== */

describe("the tenant isolation harness", () => {
  it("exists as an executable node script alongside the other gates", () => {
    expect(existsSync(join(ROOT, HARNESS_PATH))).toBe(true);
    expect(existsSync(join(ROOT, FIXTURE_PATH))).toBe(true);
    expect(HARNESS.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  /**
   * ⚠️ CONDITIONAL, AND DELIBERATELY SO. Registering the npm script is
   * the repository owner's edit, not this batch's — but if it IS
   * registered it must point at this file, because a `check:tenant-isolation`
   * script that runs something else is worse than one that does not exist.
   */
  it("is wired to the right file if the npm script is registered", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.["check:tenant-isolation"];
    if (script) expect(script).toContain(HARNESS_PATH);
  });
});

/* ================================================================== */
/* ② THE REFUSAL — RULE ①                                              */
/* ================================================================== */

describe("it refuses to report a pass it did not earn", () => {
  /**
   * 🔴 THE SINGLE MOST IMPORTANT PROPERTY. A probe role with BYPASSRLS
   * makes every assertion in the harness a statement about nothing, and
   * the harness must say INCONCLUSIVE rather than pass.
   */
  it("checks its own privileges before asserting anything", () => {
    expect(CODE).toContain("rolsuper");
    expect(CODE).toContain("rolbypassrls");
    expect(CODE).toContain("inconclusive = true");
    expect(CODE).toContain("INCONCLUSIVE");

    /**
     * ⚠️ AND THE RESULT MUST ACTUALLY GATE SOMETHING. Asserting only
     * that the two column names appear is a test that passes on the
     * QUERY while the `if` above it has been changed to `if (false)` —
     * verified by doing exactly that, which left all 28 assertions
     * green. The branch is what refuses; the query is just a lookup.
     */
    expect(CODE).toMatch(/if \([^)]*rolsuper[^)]*rolbypassrls[^)]*\)\s*\{/);
  });

  /**
   * ⚠️ THE PRIVILEGE CHECK MUST COME BEFORE THE PROBING, not after it.
   * A check that runs at the end would still print the leak lines from a
   * bypassing role first, and a reader who stops at the first ❌ has
   * already been told the wrong thing.
   */
  it("performs the privilege check before it probes a single table", () => {
    expect(CODE.indexOf("rolbypassrls")).toBeLessThan(CODE.indexOf("MUTATION CONTROL"));
  });

  /**
   * 🔴 AND AN INCONCLUSIVE RUN EXITS NON-ZERO. "Inconclusive but exit 0"
   * is a green tick in CI, which is precisely the false assurance the
   * refusal exists to prevent.
   */
  it("exits non-zero when it is inconclusive", () => {
    const tail = CODE.slice(CODE.indexOf("if (inconclusive)"));
    expect(tail).toContain("process.exit(1)");
  });

  /** ⭐ Exactly one place says "passed", and it is guarded by zero failures. */
  it("says passed in exactly one place, guarded by a zero failure count", () => {
    const passes = CODE.match(/check:tenant-isolation passed/g) ?? [];
    expect(passes).toHaveLength(1);
    expect(CODE).toContain("if (failures === 0) {");
    expect(CODE.indexOf("if (failures === 0) {")).toBeLessThan(
      CODE.indexOf("check:tenant-isolation passed"),
    );
  });

  /**
   * ⚠️ DRILL-CLASS REFUSALS, AND THERE ARE TWO OF THEM. The script
   * refuses a Neon host or a connection string equal to `DATABASE_URL`
   * before it opens a client; the fixture refuses on
   * `current_database()`, because a human at a psql prompt never goes
   * through the script.
   */
  it("refuses a connection string that looks like a real database", () => {
    /** ⚠️ Escaped, because in the source it is a regex alternative. */
    expect(CODE).toContain("neon\\.tech");
    expect(CODE).toContain("process.env.DATABASE_URL");
    expect(CODE).toContain("REFUSING TO RUN");
  });

  it("carries the drill guard in the fixture as well", () => {
    expect(SQL).toContain("current_database() LIKE '%neon%'");
    expect(SQL).toContain("RAISE EXCEPTION");
  });
});

/* ================================================================== */
/* ③ THE POSITIVE CONTROLS — RULE ②                                    */
/* ================================================================== */

describe("a zero from tenant B only counts when a one from tenant A precedes it", () => {
  /**
   * 🔴 ZERO ROWS FROM A BROKEN CONNECTION IS INDISTINGUISHABLE FROM ZERO
   * ROWS FROM WORKING ISOLATION. Both controls must be present: A reads
   * its own row, and B reads its own.
   */
  it("proves both tenants can read their own rows first", () => {
    /** ⚠️ Anchored on the bindings, not on the section comments — those
     *  are stripped by `codeOnly`, and a test that passes on a comment
     *  would keep passing after the code under it was deleted. */
    expect(CODE).toContain("let controlA");
    expect(CODE).toContain("const controlB");
    expect(CODE).toContain("cannot read its OWN row");
    expect(CODE).toContain("tenant B cannot read its OWN row");
  });

  /**
   * ⚠️ A FAILED CONTROL IS SUBTRACTED FROM COVERAGE, NEVER COUNTED AS A
   * PASS. Two real tables land here — their policy is
   * `app_platform_scope()` only — and "expected" is not "covered".
   */
  it("subtracts an inconclusive table from the coverage figure", () => {
    expect(CODE).toContain("inconclusiveTables.push");
    expect(CODE).toContain("ran.probed.length - ran.inconclusiveTables.length");
    expect(CODE).toContain("not counted as isolated");
  });

  /**
   * ⭐ THE SEED IS WRITTEN BY THE ADMIN CONNECTION. If the rows went in
   * through the mechanism under test, a policy that refused every write
   * would leave the tables empty and every "B saw zero rows" would pass
   * for the wrong reason.
   */
  it("seeds through the admin connection, not through the mechanism under test", () => {
    const insert = CODE.indexOf("INSERT INTO ${PROBE_SCHEMA}");
    expect(insert).toBeGreaterThan(0);
    expect(CODE.slice(insert - 200, insert)).toContain("admin.query(");
  });

  /**
   * ⭐ AND THE WRITE PROBES COMMIT. A rollback would make the aftermath
   * check — "A's row is still there" — vacuously true.
   */
  it("commits the write probes so the aftermath check means something", () => {
    expect(CODE).toContain('app.query("COMMIT")');
    expect(CODE).toContain("A's row did not survive B's writes intact");
  });
});

/* ================================================================== */
/* ④ TENANT B REALLY IS HANDED TENANT A'S IDENTIFIERS                  */
/* ================================================================== */

describe("what tenant B is made to attempt", () => {
  /**
   * ⚠️ SIX ATTEMPTS, NOT ONE. A harness that only SELECTs proves nothing
   * about UPDATE, DELETE, a forged INSERT, or the annexation attempt
   * that only `WITH CHECK` stops.
   */
  it("reads, counts, updates, deletes, forges and annexes with A's identifiers", () => {
    expect(CODE).toContain("read A's row BY A's ROW ID");
    expect(CODE).toContain("read A's rows BY A's TENANT ID");
    expect(CODE).toContain("an unfiltered read returned");
    expect(CODE).toContain("UPDATEd A's row");
    expect(CODE).toContain("DELETEd A's row");
    expect(CODE).toContain("INSERTed a row carrying A's tenant id");
    expect(CODE).toContain("MOVED its own row into tenant A");
  });

  /** ⭐ The refused writes must be refused with 42501, not with anything. */
  it("requires 42501 specifically, not merely an error", () => {
    expect(CODE).toContain('err.code === "42501"');
    expect(CODE).toContain("rather than 42501");
  });

  /**
   * 🔴 THE PROBE ROLE OWNS THE TABLES. That is the hardest configuration
   * to pass and the one the application actually runs in — an owner is
   * exempt from its own table's policies unless the table is FORCEd, so
   * a non-owner probe would pass on a table that leaks in production.
   */
  it("connects as a non-privileged role that OWNS the tables", () => {
    expect(CODE).toContain("NOSUPERUSER NOBYPASSRLS");
    expect(CODE).toContain("OWNER TO ${PROBE_ROLE}");
  });
});

/* ================================================================== */
/* ⑤ THE MUTATION CONTROL — PROOF IT CAN STILL FAIL                    */
/* ================================================================== */

describe("it proves on every run that it can still fail", () => {
  it("builds two tables that are broken on purpose", () => {
    expect(SQL).toContain("__broken_no_rls_at_all");
    expect(SQL).toContain("__broken_enabled_not_forced");
  });

  /**
   * 🔴🔴 THE ABSENCE THAT IS THE WHOLE CONTROL. If somebody ever adds
   * `FORCE ROW LEVEL SECURITY` to `__broken_enabled_not_forced` — the
   * obvious "fix" for a table that keeps being reported as leaking — the
   * mutation control stops detecting anything and every green run
   * afterwards is evidence of nothing.
   *
   * ⚠️ COMMENT-STRIPPED, because the surrounding prose says FORCE
   * repeatedly while explaining why it is missing.
   */
  it("never applies FORCE to the enabled-but-not-forced control", () => {
    expect(SQL).toContain("__broken_enabled_not_forced ENABLE ROW LEVEL SECURITY");
    expect(SQL).not.toContain("__broken_enabled_not_forced FORCE ROW LEVEL SECURITY");
  });

  /** ⚠️ And the no-RLS control must have no policy and no ENABLE either. */
  it("never gives the no-RLS control a policy", () => {
    expect(SQL).not.toContain("__broken_no_rls_at_all ENABLE ROW LEVEL SECURITY");
    expect(SQL).not.toContain("ON tenantprobe.__broken_no_rls_at_all");
  });

  /** ⭐ And a clean result from either one fails the run, loudly. */
  it("fails the whole run if either broken table comes back clean", () => {
    expect(CODE).toContain("THE HARNESS IS BROKEN");
    expect(CODE).toContain("evidence of nothing");
  });

  /**
   * ⭐ THE SABOTAGE SWITCH ONLY EVER MAKES THE RUN MORE LIKELY TO FAIL.
   * A sabotaged run that passes is itself a hard failure — otherwise the
   * switch would be a back door into the one control that proves tenants
   * cannot read each other.
   */
  it("treats a sabotaged run that passes as a failure", () => {
    expect(CODE).toContain("TENANT_ISOLATION_SABOTAGE");
    expect(CODE).toContain("SABOTAGE was set and the run PASSED");
  });
});

/* ================================================================== */
/* ⑥ THE LOUD SKIP — RULE ③                                            */
/* ================================================================== */

describe("without a database it skips loudly, never silently", () => {
  it("names what was not checked", () => {
    expect(CODE).toContain("EXECUTING HALF SKIPPED");
    expect(CODE).toContain("NOT CHECKED:");
    expect(CODE).toContain("TENANT_ISOLATION_REQUIRE_DB");
  });

  /**
   * ⚠️ THE STATIC HALF RUNS FIRST, SO THE SCRIPT IS NEVER A COMPLETE
   * NO-OP. Without a database it still reads the migrations and fails on
   * a tenant-scoped table nobody wrote a policy for — which is how the
   * six `leave.ts` tables were caught.
   */
  it("still runs the static half with no database at all", () => {
    expect(CODE.indexOf("are not protected by the migrations")).toBeLessThan(
      CODE.indexOf("EXECUTING HALF SKIPPED"),
    );
    expect(CODE).toContain("no CREATE POLICY anywhere");
    expect(CODE).toContain("no FORCE ROW LEVEL SECURITY");
  });
});

/* ================================================================== */
/* ⑦ COVERAGE IS COUNTED, INCLUDING THE PART THAT IS MISSING — RULE ④  */
/* ================================================================== */

describe("coverage is a number, not an impression", () => {
  it("states N of M tenant-scoped tables probed", () => {
    expect(CODE).toContain("tenant-scoped tables probed with two live tenants");
    expect(CODE).toContain("${TABLES.length}");
  });

  /**
   * 🔴 THE HONEST SENTENCE, AND IT IS THE ONE MOST LIKELY TO BE DELETED
   * AS "NOISE". The guideline this harness comes from asks for every
   * ENDPOINT called as tenant B with tenant A's identifiers. This proves
   * the DATABASE refuses; it calls no route handler and no server
   * action. Stating the number is the difference between a known gap and
   * an implied claim.
   */
  it("states plainly that zero endpoints are probed and counts them", () => {
    expect(CODE).toContain("0 of ${ENDPOINTS.total} endpoints probed");
    expect(CODE).toContain("ENDPOINTS ARE THE NEXT STEP");
    expect(CODE).toContain("function endpointCount()");
  });

  /** ⭐ A table that would not build is named, never silently dropped. */
  it("names every table it could not build rather than shrinking M", () => {
    expect(CODE).toContain("could not be built in the probe schema");
    expect(CODE).toContain("unbuilt.push");
  });
});

/* ================================================================== */
/* ⑧ IT DOES NOT INVENT THE THING IT IS TESTING                        */
/* ================================================================== */

describe("the policies under test come from the migrations", () => {
  /**
   * 🔴 A HAND-WRITTEN COPY OF 254 POLICIES WOULD DRIFT, AND THE COPY
   * THAT DRIFTED WOULD BE THE ONE BEING TESTED. The harness lifts the
   * predicates verbatim, so a policy this repository has never written
   * is one it cannot invent a passing version of.
   */
  it("parses SQL-FILES rather than restating the policies", () => {
    expect(CODE).toContain("function migrationFacts()");
    expect(CODE).toContain("CREATE POLICY");
    expect(CODE).toContain("ALL-IN-ONE-SETUP.sql");
    /** ⚠️ Both spellings — literal, and `format('CREATE POLICY %I ...')`. */
    expect(CODE).toContain("%\\d*\\$?I");
  });

  /**
   * 🔴 FORCE IS APPLIED ONLY WHERE THE MIGRATIONS APPLY IT. Applying it
   * unconditionally would be the harness quietly repairing the exact
   * defect it exists to find — the probe role owns these tables, so a
   * table the migrations forgot to FORCE genuinely leaks to it.
   */
  it("applies ENABLE and FORCE only where a migration declares them", () => {
    expect(CODE).toContain("if (r.enable) await admin.query(");
    expect(CODE).toContain("if (r.force) await admin.query(");
  });

  /**
   * ⭐ AND IT DOES NOT DUPLICATE THE CANARY. `server/platform/canary.ts`
   * is the production-side control and this is the source-side one; a
   * harness that imported it would be testing the canary's target list
   * rather than the schema.
   */
  it("does not reach into the runtime canary", () => {
    expect(CODE).not.toContain("server/platform/canary");
    expect(CODE).not.toContain("@/db");
  });
});
