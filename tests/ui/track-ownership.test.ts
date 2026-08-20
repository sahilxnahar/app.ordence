import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Gate 27 , the ownership gate for the parallel waves.
 *
 * The test that matters is the LAST one: a gate that cannot fail is the
 * defect this repo has shipped 23 times. `check:sql-executes` passed for
 * its entire life because its skip path exited 0 and the runner tested
 * only `exit === 0`. So each case here asserts an exit code, and one
 * case proves the gate refuses something it should refuse.
 */
const SCRIPT = path.join(process.cwd(), "scripts/check-track-ownership.mjs");

function run(args: string[]) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

function listing(lines: string[]) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "own-")), "l.txt");
  fs.writeFileSync(f, lines.join("\n"));
  return f;
}

describe("check:track-ownership", () => {
  it("the ownership map itself is self-consistent", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/ownership map consistent/);
  });

  it("every migration on disk sits in an allocated block", () => {
    const r = run(["--tree"]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("accepts a delivery that stays inside its block", () => {
    const f = listing([
      "server/scheduler/runner.ts",
      "app/api/workers/route.ts",
      "SQL-FILES/0130_run_ledger.sql",
      "TRACK-REPORT.md",
    ]);
    const r = run(["--track", "A", "--files", f]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("REFUSES a file outside the track's paths", () => {
    const f = listing(["lib/security/csrf.ts", "TRACK-REPORT.md"]);
    const r = run(["--track", "A", "--files", f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/outside its ownership/);
  });

  it("REFUSES a migration from another track's number block", () => {
    const f = listing(["SQL-FILES/0140_not_mine.sql", "TRACK-REPORT.md"]);
    const r = run(["--track", "A", "--files", f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/outside its block/);
  });

  it("REFUSES a shared file no track may write", () => {
    const f = listing(["package.json", "TRACK-REPORT.md"]);
    const r = run(["--track", "H", "--files", f]);
    // H owns the shared files deliberately; every other track must not.
    expect(run(["--track", "A", "--files", f]).status).toBe(1);
    expect(r.status).toBe(0);
  });

  it("an unknown track is a configuration error, not a pass", () => {
    const f = listing(["TRACK-REPORT.md"]);
    const r = run(["--track", "Z", "--files", f]);
    expect(r.status).toBe(78);
  });
});
