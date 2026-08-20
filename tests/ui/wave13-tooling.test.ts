/**
 * Ordence — Infra wave 13: the tooling that could not report its own failure
 * Version: v1.80.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE SHAPE, FIVE PLACES
 * ══════════════════════════════════════════════════════════════════════
 * A command runs, does nothing, and reports success. Wave 12 found it in
 * `drizzle-kit push`. This wave found it in four more:
 *
 *   • `npm run db:push` never got the wrapper, so the operator-facing
 *     script still called bare `drizzle-kit push`, without --force
 *   • `check:sql-executes` exited 0 on a skip and `run-gates.mjs` has one
 *     predicate: `status === 0`
 *   • the CI secret scan could not tell `git grep` "no match" from
 *     `git grep` "error"
 *   • `shopt -s nullglob` turned a wrong glob into a bare `ls`
 *
 * These assertions are source-level on purpose: each one pins the exact
 * line whose absence brought the defect back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ================================================================== */
/* 1. EVERY drizzle-kit ENTRY POINT GOES THROUGH THE WRAPPER           */
/* ================================================================== */

describe("no drizzle-kit invocation bypasses the silent-failure wrapper", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("🔴 no npm script calls drizzle-kit directly", () => {
    // `scripts/drizzle-kit.mjs` loads the BigInt serialiser into the child
    // and treats known silent-failure strings as failures regardless of the
    // exit code. A script that calls the binary directly gets neither, and
    // `db:push` did exactly that for a whole wave after CI was fixed: it
    // would create zero tables, exit 0, and then `&&` into an echo that
    // reads as confirmation of success.
    const offenders = Object.entries(pkg.scripts).filter(
      ([, cmd]) =>
        /(^|[^/])\bdrizzle-kit\b/.test(cmd) && !cmd.includes("scripts/drizzle-kit.mjs"),
    );
    expect(
      offenders.map(([name]) => name),
      "these npm scripts call drizzle-kit without the wrapper",
    ).toEqual([]);
  });

  it("db:generate and db:migrate go through it too, not just push", () => {
    // `generate` writes the schema snapshot — the exact operation the BigInt
    // serialiser exists to make survivable. Without the wrapper it exits 0
    // producing no migration file, and `migrate` then applies nothing, also
    // exiting 0.
    expect(pkg.scripts["db:generate"]).toContain("scripts/drizzle-kit.mjs");
    expect(pkg.scripts["db:migrate"]).toContain("scripts/drizzle-kit.mjs");
  });

  it("db:push keeps its production guard", () => {
    expect(pkg.scripts["db:push"]).toContain("NODE_ENV==='production'");
    expect(pkg.scripts["db:push"]).toContain("FORBIDDEN");
  });

  it("no workflow step calls drizzle-kit directly either", () => {
    const wf = read(".github/workflows/security-ci.yml");
    const direct = wf
      .split("\n")
      .filter(
        (l) =>
          /\bdrizzle-kit\b/.test(l) &&
          !l.includes("scripts/drizzle-kit.mjs") &&
          !l.trimStart().startsWith("#"),
      );
    expect(direct, "CI calls drizzle-kit without the wrapper").toEqual([]);
  });
});

/* ================================================================== */
/* 2. A SKIP IS NOT A PASS                                             */
/* ================================================================== */

describe("a gate that skips is reported as a skip", () => {
  it("🔴 check:sql-executes exits 78, not 0, when it cannot run", () => {
    const gate = read("scripts/check-sql-executes.mjs");
    expect(gate).toContain("process.exit(78)");
    // ⚠️ ANCHORED ON THE SKIP BLOCK, not on the file. The SUCCESS path at
    // the end of the gate exits 0 and must keep doing so; a naive search
    // for `process.exit(0)` anywhere finds that one and fails for the
    // wrong reason. Only the `if (!URL_ENV)` block is under test here.
    // ⚠️ AND COMMENTS ARE STRIPPED FIRST. The block's own explanation quotes
    // the line it replaced ("This used to `process.exit(0)`"), which is the
    // most useful sentence in the file and would fail a naive search. This is
    // the same trap `check-sealed-grants.mjs` had to solve: documentation of a
    // past defect reads exactly like the defect.
    const skipBlock = gate
      .slice(gate.indexOf("if (!URL_ENV)"), gate.indexOf("const { default: pg }"))
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("//");
      })
      .join("\n");
    expect(
      skipBlock.includes("process.exit(0)"),
      "the skip path still exits 0, which run-gates.mjs counts as a pass",
    ).toBe(false);
    expect(skipBlock).toContain("process.exit(78)");
  });

  it("the runner distinguishes three states, not two", () => {
    const runner = read("scripts/run-gates.mjs");
    expect(runner).toContain("SKIP_CODE = 78");
    expect(runner).toContain("skipped");
    // The old single predicate must be gone.
    expect(runner).not.toContain("results.push({ gate, ok: r.status === 0, code: r.status })");
  });

  it("🔴 and in CI a skip is a failure", () => {
    // Locally "I have no throwaway Postgres right now" is reasonable. In CI
    // the database is a service container, so a skip means the wiring broke.
    const runner = read("scripts/run-gates.mjs");
    expect(runner).toContain("SKIPS_ARE_FATAL");
    expect(runner).toContain('process.env.CI === "true"');
  });

  it("only a gate declared canSkip may skip", () => {
    const runner = read("scripts/run-gates.mjs");
    expect(runner).toContain("gate.canSkip === true");
  });

  it("⚠️ the manifest no longer claims check:rls can skip, because it cannot", () => {
    const gates = read("scripts/gates.mjs");
    const rlsEntry = gates.slice(gates.indexOf('id: "rls"'), gates.indexOf('id: "rls"') + 900);
    expect(rlsEntry).not.toMatch(/canSkip:\s*true/);
    // and the gate itself still refuses rather than skipping
    expect(read("scripts/check-rls-coverage.mjs")).toContain("not optional in CI");
  });

  it("CI builds the database the skippable gate needs", () => {
    const wf = read(".github/workflows/security-ci.yml");
    expect(wf).toContain("Build the SQL harness database");
    expect(wf).toContain("HARNESS_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/ordence_harness");
  });

  it("and so does the local bootstrap, so the gate stops skipping locally", () => {
    const boot = read("scripts/bootstrap-test-db.mjs");
    expect(boot).toContain("build the SQL harness database");
    expect(boot).toContain("HARNESS_DATABASE_URL");
  });
});

/* ================================================================== */
/* 3. CI STEPS THAT COULD NOT TELL "CLEAN" FROM "DID NOT RUN"          */
/* ================================================================== */

describe("every scanning CI step proves it scanned something", () => {
  const wf = read(".github/workflows/security-ci.yml");

  it("🔴 the secret scan self-tests before trusting a no-match", () => {
    // `git grep` exits 1 for "no match" and >=128 for an error, and
    // `2>/dev/null` discards the difference. Both landed in the else
    // branch and printed "✅ No live secret patterns found".
    expect(wf).toContain("scanner self-test passed");
    expect(wf).toContain("found no occurrence of a string that is certainly present");
  });

  it("the tracked-env-file check asserts the file list is non-empty", () => {
    expect(wf).toContain("git ls-files returned nothing");
  });

  it("🔴 nullglob is gone from the SQL apply step", () => {
    // `nullglob` removes an unmatched glob WORD, so `ls SQL-FILES/…` became
    // bare `ls` and listed the repo root. The `-z` guard written to catch a
    // wrong glob passed on the repo listing.
    // ⚠️ The string survives in the comment that explains why it was
    // removed, which is the point of the comment. Assert on executable
    // lines only: a `#`-prefixed line is documentation.
    const executable = wf
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(executable).not.toContain("shopt -s nullglob");
    expect(wf).toContain("-name '[0-9][0-9][0-9][0-9]_*.sql' -print0");
  });

  it("and it asserts a plausible file count rather than merely non-empty", () => {
    expect(wf).toContain("The checkout is partial");
  });
});

/* ================================================================== */
/* 4. THE THREE APPLICATION FIXES                                      */
/* ================================================================== */

describe("the fail-open paths that reported success", () => {
  it("🔴 CSRF: the unconfigured degradation is same-site, not any-site", () => {
    const csrf = read("lib/security/csrf.ts");
    // The old line accepted every candidate host.
    expect(csrf).not.toContain('if (allowed.includes("")) return true;');
    expect(csrf).toContain("return candidate === requestHost.toLowerCase();");
    // and it says so when it cannot even do that
    expect(csrf).toContain("accepting every origin");
  });

  it("every isAllowedHost call site passes the request host", () => {
    const csrf = read("lib/security/csrf.ts");
    // Only real call sites: skip the declaration and any bare mention in
    // prose, both of which appear as `isAllowedHost(` with nothing useful
    // after it.
    const calls = csrf.match(/isAllowedHost\([^)]+\)/g) ?? [];
    const uses = calls.filter(
      (c) => !c.includes("host: string") && !c.includes("evil.example"),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const c of uses) {
      expect(c, `${c} does not pass a request host, so it degrades to accept-all`).toMatch(
        /requestHost/,
      );
    }
  });

  it("🔴 nothing sends notification mail outside the outbox , superseded in wave 16", () => {
    /**
     * ⚠️ THIS REPLACES TWO ASSERTIONS THAT NO LONGER HAVE A SUBJECT.
     *
     * They pinned `lib/email/notifications.ts`'s `sendEmail`: that it read
     * the Resend result rather than returning `true` blindly, and that its
     * caller stopped filtering on a rejection that could not happen. Both
     * were real repairs and both are now moot, because Track G DELETED
     * that sender. Its one caller now writes outbox rows inside the
     * transaction instead of calling the provider after commit.
     *
     * ⭐ THE REPLACEMENT IS STRICTLY STRONGER. Checking a provider result
     * correctly is worth less than not talking to the provider at all from
     * this path: the outbox carries the suppression list, the attempt
     * ceiling, the delivery record and the idempotency key, and a direct
     * send bypasses all four at once. So rather than assert how a deleted
     * function behaved, assert the property that made deleting it right.
     */
    const create = read("server/notifications/create.ts");
    expect(create).not.toMatch(/sendEmail\(/);
    expect(create).toMatch(/outbox/i);

    /** And the sender really is gone, not merely unused. */
    let mailerStillHasSender = false;
    try {
      mailerStillHasSender = /export\s+(async\s+)?function\s+sendEmail/.test(
        read("lib/email/notifications.ts"),
      );
    } catch {
      /* FAIL OPEN: the whole module may have gone, which is also fine. */
    }
    expect(mailerStillHasSender).toBe(false);
  });

  it("🔴 the security alerting install has a failure path", () => {
    const alerting = read("server/security/alerting.ts");
    expect(alerting).toContain(".catch((err: unknown) =>");
    // and it resets the latch, because `installed = true` is set before the
    // await, so one transient failure at boot disabled alerting for the
    // life of the process.
    expect(alerting).toContain("installed = false;");
    expect(alerting).toContain("alerting.install_failed");
  });
});

/* ================================================================== */
/* 5. THE RLS GATE NOW CHECKS THE READ SIDE                            */
/* ================================================================== */

describe("platform read scope is a declared decision", () => {
  const gate = read("scripts/check-rls-coverage.mjs");

  it("🔴 the refusals from 0022 and 0014 are encoded, not just written in prose", () => {
    expect(gate).toContain("PLATFORM_READ_REFUSED");
    for (const t of [
      "usage_counters",
      "usage_levels",
      "audit_logs",
      "security_events",
      "contacts",
      "journal_entries",
      "transactions",
      "ledgers",
    ]) {
      expect(gate, `${t} is not on the refusal list`).toContain(`"${t}"`);
    }
  });

  it("the docstring that was false is corrected", () => {
    expect(gate).not.toContain("The read boundary is UNTOUCHED:");
  });

  it("⚠️ the one accepted widening records who depends on it", () => {
    expect(gate).toContain("accepted:");
    expect(gate).toContain("anomalies.ts");
  });

  it("the safe global-write idiom is recognised rather than reported", () => {
    // email_suppressions writes `(tenant_id IS NULL AND app_platform_scope())`,
    // which is a GLOBAL row, not a cross-tenant one.
    expect(gate).toContain("isGlobalWriteOnly");
    expect(gate).toContain("tenant_id is null and app_platform_scope");
  });
});

/* ================================================================== */
/* 6. THE psql SUBSET EXPANDER                                         */
/* ================================================================== */

describe("the harness seed expander refuses what it does not understand", () => {
  it("expands \\set and :'NAME'", async () => {
    const { expandPsqlVariables } = await import("../../scripts/lib/psql-variables.mjs");
    const out = expandPsqlVariables(`\\set T 'abc'\nSELECT :'T', 1;`);
    expect(out).toContain("SELECT 'abc', 1;");
    expect(out).not.toContain("\\set");
  });

  it("🔴 THROWS on any other meta-command rather than skipping it", async () => {
    // A silent skip means a seed that half-applies and a harness that then
    // reports confidently wrong counts — which is the failure this gate
    // exists to catch, reintroduced by the thing that sets it up.
    const { expandPsqlVariables } = await import("../../scripts/lib/psql-variables.mjs");
    expect(() => expandPsqlVariables(`\\copy t FROM 'x.csv'\nSELECT 1;`, "seed.sql")).toThrow(
      /does not support/,
    );
  });

  it("escapes a quote in the value rather than breaking out of the literal", async () => {
    const { expandPsqlVariables } = await import("../../scripts/lib/psql-variables.mjs");
    const out = expandPsqlVariables(`\\set N 'O''Brien'\nSELECT :'N';`);
    expect(out).toContain("SELECT 'O''Brien';");
  });
});
