import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts/report-env-drift.mjs");

function namesFile(lines: string[]) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "envd-")), "have.txt");
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
const run = (f: string, extra: string[] = []) =>
  spawnSync("node", [SCRIPT, "--have", f, ...extra], { encoding: "utf8" });

describe("check:env-drift", () => {
  it("REFUSES a file that contains values, not just names", () => {
    const r = run(namesFile(["DATABASE_URL=postgres://u:p@h/db", "RESEND_API_KEY=re_abc"]));
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/takes names only/);
    /** It must not echo the value back while complaining about it. */
    expect(r.stderr).not.toMatch(/re_abc/);
    expect(r.stderr).not.toMatch(/postgres:\/\//);
  });

  it("REFUSES when a required name is absent", () => {
    const r = run(namesFile(["RESEND_API_KEY", "NODE_ENV"]));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REQUIRED AND NOT SET/);
  });

  it("passes when every required name is present", () => {
    const json = JSON.parse(run(namesFile(["X"]), ["--json"]).stdout || "{}");
    const required: string[] = json.requiredMissing ?? [];
    const r = run(namesFile([...required, "X"]), ["--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).requiredMissing).toEqual([]);
  });

  it("reports a name set but not catalogued rather than ignoring it", () => {
    const json = JSON.parse(run(namesFile(["X"]), ["--json"]).stdout || "{}");
    const required: string[] = json.requiredMissing ?? [];
    const r = run(namesFile([...required, "SOMETHING_NOBODY_DOCUMENTED"]), ["--json"]);
    expect(JSON.parse(r.stdout).uncatalogued).toContain("SOMETHING_NOBODY_DOCUMENTED");
  });

  it("REFUSES an empty file rather than reporting no drift", () => {
    const r = run(namesFile([]));
    expect(r.status).toBe(78);
  });
});
