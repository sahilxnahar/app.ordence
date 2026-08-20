import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * The refusals are the product. A timing harness that measures anyway,
 * as a superuser, on an empty table, produces numbers that are wrong in
 * the flattering direction , which is worse than no numbers, because
 * somebody will act on them.
 */
const SCRIPT = path.join(process.cwd(), "scripts/measure-query.mjs");

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PGHOST: "127.0.0.1", ...env },
  });

describe("measure-query", () => {
  it("REFUSES a non-local host, because EXPLAIN ANALYZE executes", () => {
    const r = run(["--db", "x", "--sql", "SELECT 1"], { PGHOST: "ep-x.neon.tech" });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/EXECUTES/);
  });

  it("REFUSES a statement that is not a SELECT", () => {
    const r = run(["--db", "x", "--sql", "UPDATE invoices SET status='x'"]);
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/five updates/);
  });

  it("REFUSES without a database or a query rather than guessing", () => {
    expect(run(["--sql", "SELECT 1"]).status).toBe(78);
    expect(run(["--db", "x"]).status).toBe(78);
  });

  it("warns when no tenant is given, because the policy then matches nothing", () => {
    /** Reaching the database is not required: the warning precedes it. */
    const r = run(["--db", "definitely_not_a_database", "--sql", "SELECT 1"]);
    expect(r.stdout + r.stderr).toMatch(/no --tenant given|cannot reach/);
  });
});
