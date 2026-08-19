/**
 * Ordence — gate 26 exists, is wired, and can actually fail
 * Version: v1.81.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEPLOY THIS GATE WAS WRITTEN THE HOUR AFTER
 * ══════════════════════════════════════════════════════════════════════
 * A release archive was extracted into `components/` rather than at the
 * repository root. Every path landed one level too deep, and the 213
 * real files in `components/` were lost in the same operation. The
 * commit was pushed and the Railway build failed with:
 *
 *     Module not found: Can't resolve '@/components/budgets/budget-editor'
 *
 * ⚠️ WEBPACK NAMED FIVE. THERE WERE 305. It stops early, so the first
 * error understates the damage by two orders of magnitude , and fixing
 * the five named files would just have bought another failed build.
 *
 * Nothing else here would have caught it: `tsc` reads the tree on disk,
 * the other 23 gates ask specific questions of specific files, and the
 * suites only see modules something under test imports.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("check:unresolved-imports", () => {
  it("passes on this repository", () => {
    const out = execFileSync("node", [join(ROOT, "scripts/check-unresolved-imports.mjs")], {
      encoding: "utf8",
    });
    expect(out).toContain("every @/ import resolves");
  });

  it("🔴 FAILS on a tree with a broken import , the half that matters", () => {
    // ⚠️ A gate that has only ever been seen to pass is a gate nobody has
    // watched fail. This builds the exact shape of the outage: a page
    // importing a component that is not there.
    const dir = mkdtempSync(join(tmpdir(), "ordence-import-gate-"));
    try {
      mkdirSync(join(dir, "app"), { recursive: true });
      mkdirSync(join(dir, "components"), { recursive: true });
      writeFileSync(
        join(dir, "app", "page.tsx"),
        'import { Budget } from "@/components/budgets/budget-editor";\nexport default function P() { return <Budget />; }\n',
      );
      let failed = false;
      let output = "";
      try {
        execFileSync("node", [join(ROOT, "scripts/check-unresolved-imports.mjs"), dir], {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (err) {
        failed = true;
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      expect(failed, "the gate accepted a tree with a missing module").toBe(true);
      expect(output).toContain("@/components/budgets/budget-editor");
      expect(output).toContain("unresolved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a directory index, not just a file", () => {
    // `@/components/x` where the real file is `components/x/index.tsx`
    // is legal and must not be reported. A resolver that misses this
    // produces false failures, and a gate that cries wolf gets disabled.
    const dir = mkdtempSync(join(tmpdir(), "ordence-import-idx-"));
    try {
      mkdirSync(join(dir, "app"), { recursive: true });
      mkdirSync(join(dir, "lib", "thing"), { recursive: true });
      writeFileSync(join(dir, "lib", "thing", "index.ts"), "export const a = 1;\n");
      writeFileSync(join(dir, "app", "p.tsx"), 'import { a } from "@/lib/thing";\nexport default a;\n');
      const out = execFileSync(
        "node",
        [join(ROOT, "scripts/check-unresolved-imports.mjs"), dir],
        { encoding: "utf8" },
      );
      expect(out).toContain("every @/ import resolves");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is in the gate manifest, so preflight and CI both run it", async () => {
    const { GATES } = await import("../../scripts/gates.mjs");
    const g = GATES.find((x: { id: string }) => x.id === "unresolved-imports");
    expect(g, "the gate is not in scripts/gates.mjs, so nothing runs it").toBeDefined();
    expect(g!.tier).toBe("static");
    expect(read("package.json")).toContain('"check:unresolved-imports"');
  });
});
