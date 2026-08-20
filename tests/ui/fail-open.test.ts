import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Gate 28. The only test that matters is the one that PROVES IT REFUSES.
 * `check:sql-executes` passed for its entire life because its skip path
 * exited 0 and nothing ever asserted it could fail.
 */
const SCRIPT = path.join(process.cwd(), "scripts/check-fail-open.mjs");
const PROBE = path.join(process.cwd(), "lib/security/__gate_probe_failopen.ts");

const run = () => spawnSync("node", [SCRIPT], { encoding: "utf8" });

afterEach(() => {
  if (fs.existsSync(PROBE)) fs.unlinkSync(PROBE);
});

describe("check:fail-open", () => {
  it("passes on the repository as it stands", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
  });

  it("REFUSES a new catch block that returns true on failure", () => {
    fs.writeFileSync(PROBE, "export async function ok(){ try { return await x(); } catch (e) { return true; } }\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/permissive/);
  });

  it("REFUSES a new catch block that swallows silently", () => {
    fs.writeFileSync(PROBE, "export async function go(){ try { await x(); } catch {} }\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/swallowed/);
  });

  it("accepts the same block once the decision is declared", () => {
    fs.writeFileSync(PROBE, "export async function go(){ try { await x(); } catch { /* FAIL OPEN: probe */ } }\n");
    expect(run().status).toBe(0);
  });

  it("does not flag a catch that rethrows", () => {
    fs.writeFileSync(PROBE, "export async function go(){ try { await x(); } catch (e) { throw new Error('wrapped'); } }\n");
    expect(run().status).toBe(0);
  });

  it("keeps the baseline visible in its own output", () => {
    const r = run();
    expect(r.stdout).toMatch(/declared in fail-open-registry\.json/);
  });
});
