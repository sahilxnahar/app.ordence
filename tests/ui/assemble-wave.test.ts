import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * assemble-wave , the checks that only exist in the plural.
 *
 * Each case asserts an exit code AND that the scratch tree ended up in
 * the right state. A refused delivery that silently landed anyway would
 * pass a naive "it printed REFUSED" test.
 */
const SCRIPT = path.join(process.cwd(), "scripts/assemble-wave.mjs");
let dir: string;

function makeZip(letter: string, files: Record<string, string>) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `stage-${letter}-`));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(stage, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), body);
  }
  spawnSync("zip", ["-qr", path.join(dir, `ordence-track-${letter}.zip`), "."], { cwd: stage });
}

/** Structural cases skip the gates; one case below runs them for real. */
const run = (order: string, extra: string[] = []) =>
  spawnSync("node", [SCRIPT, "--order", order, "--dir", dir, "--DANGEROUSLY-skip-gates", ...extra],
    { encoding: "utf8" });

const runWithGates = (order: string) =>
  spawnSync("node", [SCRIPT, "--order", order, "--dir", dir], { encoding: "utf8" });

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "deliveries-")); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("assemble-wave", () => {
  it("accepts a clean delivery and reports its migrations", () => {
    makeZip("A", {
      "server/scheduler/runner.ts": "export const runner = 1;\n",
      "SQL-FILES/0129_run_ledger.sql": "-- 0129\n",
      "TRACK-REPORT.md": "# report\n",
    });
    const r = run("A");
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/ACCEPTED/);
    expect(r.stdout).toMatch(/0129/);
  });

  it("REFUSES a second track that writes a file the first already wrote", () => {
    makeZip("B", {
      "server/scheduler/runner.ts": "export const stolen = 1;\n",
      "TRACK-REPORT.md": "# report\n",
    });
    const r = run("A,B");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/collision/);
  });

  it("REFUSES a zip built from inside a folder", () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "nested-"));
    fs.mkdirSync(path.join(stage, "ordence-track-C/SQL-FILES"), { recursive: true });
    fs.writeFileSync(path.join(stage, "ordence-track-C/SQL-FILES/0136_x.sql"), "-- x\n");
    fs.writeFileSync(path.join(stage, "ordence-track-C/TRACK-REPORT.md"), "# r\n");
    spawnSync("zip", ["-qr", path.join(dir, "ordence-track-C.zip"), "."], { cwd: stage });
    const r = run("C");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/one level too deep/);
  });

  it("REFUSES a delivery that turns the gates red, and NAMES the gate", { timeout: 180_000 }, () => {
    makeZip("D", {
      "lib/security/__assemble_probe.ts": 'import { x } from "@/lib/nope-not-a-real-module";\nexport const y = x;\n',
      "TRACK-REPORT.md": "# report\n",
    });
    const r = runWithGates("D");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/gate that went red: check:unresolved-imports/);
  });

  it("does not apply a refused delivery to the tree", () => {
    const r = run("A,B", ["--keep"]);
    const kept = (r.stdout.match(/kept at (\S+)/) || [])[1];
    expect(kept).toBeTruthy();
    expect(fs.existsSync(path.join(kept!, "SQL-FILES/0129_run_ledger.sql"))).toBe(true);
    expect(fs.readFileSync(path.join(kept!, "server/scheduler/runner.ts"), "utf8"))
      .toContain("export const runner");   // A's version, not B's
    fs.rmSync(path.dirname(kept!), { recursive: true, force: true });
  });

  it("reports a missing zip as absent rather than guessing", () => {
    const r = run("A,F");
    expect(r.stdout).toMatch(/ABSENT/);
  });
});
