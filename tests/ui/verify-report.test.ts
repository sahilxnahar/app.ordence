import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERIFY = path.join(process.cwd(), "scripts/verify-report.mjs");
const COLLECT = path.join(process.cwd(), "scripts/collect-patch-requests.mjs");
let dir: string;

function makeZip(name: string, files: Record<string, string>) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(stage, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), body);
  }
  const out = path.join(dir, name);
  spawnSync("zip", ["-qr", out, "."], { cwd: stage });
  return out;
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-")); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("verify-report", () => {
  it("REFUSES a report that names a file the zip does not contain", () => {
    const zip = makeZip("ordence-track-A.zip", {
      "server/scheduler/runner.ts": "export const x = 1;\n",
      "TRACK-REPORT.md":
        "# report\nAdded `server/scheduler/runner.ts` and `server/scheduler/ghost.ts`.\n" +
        "Ran `npm run gates:static`, `node scripts/x.mjs` and `npx vitest run`.\n" +
        "```\n26/26 passed\n```\nIt refused when removed; without it the check would fail.\n",
    });
    const r = spawnSync("node", [VERIFY, "--zip", zip], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/does not contain them/);
    expect(r.stdout).toMatch(/ghost\.ts/);
  });

  it("REFUSES a report with no evidence at all", () => {
    const zip = makeZip("ordence-track-B.zip", {
      "lib/telemetry/x.ts": "export const x = 1;\n",
      "TRACK-REPORT.md": "# report\nI added `lib/telemetry/x.ts`. It works well.\n",
    });
    const r = spawnSync("node", [VERIFY, "--zip", zip], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/asserts without showing working/);
  });

  it("REFUSES a zip with no report rather than passing it", () => {
    const zip = makeZip("ordence-track-C.zip", { "lib/x.ts": "export const x = 1;\n" });
    const r = spawnSync("node", [VERIFY, "--zip", zip], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no TRACK-REPORT/);
  });

  it("says plainly that a clean result is not acceptance", () => {
    const zip = makeZip("ordence-track-D.zip", {
      "lib/security/x.ts": "export const x = 1;\n",
      "TRACK-REPORT.md":
        "# report\nAdded `lib/security/x.ts`.\nRan `npm run gates:static` and `npx vitest run`;\n" +
        "also `node scripts/check-fail-open.mjs`.\n```\n26/26 passed\n```\n" +
        "Removed it and the check failed, which is what would have differed without it.\n",
    });
    const r = spawnSync("node", [VERIFY, "--zip", zip], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/NOT ACCEPTANCE/);
  });
});

describe("collect-patch-requests", () => {
  it("flags two tracks requesting a change to the same shared file", () => {
    makeZip("ordence-track-E.zip", {
      "TRACK-REPORT.md": "# r\n",
      "PATCH-REQUEST-E.md": 'Add to package.json: `"check:e": "node scripts/e.mjs"`\n',
    });
    makeZip("ordence-track-F.zip", {
      "TRACK-REPORT.md": "# r\n",
      "PATCH-REQUEST-F.md": 'Add to package.json: `"check:f": "node scripts/f.mjs"`\n',
    });
    const r = spawnSync("node", [COLLECT, "--order", "E,F", "--dir", dir], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/contested file/);
    expect(r.stdout).toMatch(/package\.json/);
  });

  it("--check reports an unapplied request as outstanding", () => {
    const r = spawnSync("node", [COLLECT, "--order", "E,F", "--dir", dir, "--check"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/still to apply/);
  });

  it("reports nothing to do when no track asked for one", () => {
    makeZip("ordence-track-G.zip", { "TRACK-REPORT.md": "# r\n" });
    const r = spawnSync("node", [COLLECT, "--order", "G", "--dir", dir], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Nothing to apply/);
  });
});
