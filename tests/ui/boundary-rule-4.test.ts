/**
 * ⭐ Does the tenant-parameter rule actually fire?
 *
 * ⚠️ A CHECK NOBODY HAS SEEN FAIL IS A CHECK NOBODY SHOULD TRUST. Rule 4
 * exists because v005 shipped a browser-reachable cross-tenant write
 * endpoint that passed every other gate. Asserting the rule's SOURCE
 * contains the right regex proves nothing — the first draft of that
 * regex ran past the function it was naming and blamed an innocent file.
 *
 * So this writes a real violating file, runs the real checker, and reads
 * the real exit code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = join(process.cwd(), "server", "__boundary_fixture__");

function runChecker(): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/check-server-boundaries.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function write(name: string, body: string) {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, name), body, "utf8");
}

afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("🔴 rule 4 — no action may accept a tenant", () => {
  it("the tree passes as it stands", () => {
    expect(runChecker().code).toBe(0);
  });

  /** The v005 shape, verbatim in structure. */
  it("FAILS on an action that takes tenantId inline", () => {
    write(
      "bad.ts",
      `"use server";\n\nexport async function createThing(input: {\n  tenantId: string;\n  title: string;\n}): Promise<void> {\n  void input;\n}\n`,
    );
    const { code, output } = runChecker();
    expect(code).toBe(1);
    expect(output).toContain("createThing");
    expect(output).toContain("tenantId");
  });

  it("FAILS on a destructured tenantId too", () => {
    write(
      "bad2.ts",
      `"use server";\n\nexport async function doThing({ tenantId }: { tenantId: string }) {\n  void tenantId;\n}\n`,
    );
    expect(runChecker().code).toBe(1);
  });

  /**
   * The regression that made the first draft blame the wrong file: an
   * action with no return type annotation gave the lazy matcher nothing
   * to stop at, so it ran forward and reported a later function's fault
   * against this one's name.
   */
  it("does NOT fire on an innocent action written without a return type", () => {
    write(
      "good.ts",
      `"use server";\n\nexport async function listThings(input: unknown) {\n  void input;\n}\n\nexport async function otherThing(input: unknown) {\n  void input;\n}\n`,
    );
    const { code, output } = runChecker();
    expect(code).toBe(0);
    expect(output).not.toContain("listThings");
  });

  it("does NOT fire on a server-only module that takes a tenantId", () => {
    // This is the CORRECT home for such a function — rule 4's whole point.
    write(
      "internal.ts",
      `import "server-only";\n\nexport async function writeThing(tenantId: string) {\n  void tenantId;\n}\n`,
    );
    expect(runChecker().code).toBe(0);
  });
});
