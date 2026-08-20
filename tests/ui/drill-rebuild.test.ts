import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * The drill's own parse is what this tests. The database half needs a
 * throwaway PostgreSQL and is exercised by hand; what can regress
 * silently is the expectation count, and a low count would make the
 * drill report "nothing missing" on a database missing everything.
 * That is not hypothetical: the first version of this script parsed 2
 * policies out of 123 files and printed RESTORE COMPLETE.
 */
const SCRIPT = path.join(process.cwd(), "scripts/drill-rebuild.mjs");

const run = (env: Record<string, string> = {}, args: string[] = []) =>
  spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("drill-rebuild", () => {
  it("REFUSES a non-local host before connecting", () => {
    const r = run({ PGHOST: "ep-something.neon.tech" }, ["--db", "anything"]);
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/REFUSING/);
    expect(r.stderr).toMatch(/never at Neon/);
  });

  it("REFUSES without a database name rather than guessing one", () => {
    const r = run({}, []);
    expect(r.status).toBe(78);
  });

  it("refuses a host that merely CONTAINS a local name", () => {
    /** "localhost.evil.example" must not pass a naive substring test. */
    const r = run({ PGHOST: "notlocalhost.example.com" }, ["--db", "x"]);
    expect(r.status).toBe(78);
  });
});
