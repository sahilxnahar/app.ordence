/**
 * Ordence — ⭐⭐⭐ THE SQL EXECUTION HARNESS
 * Version: v1.29.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS TEST FILE IS ABOUT AN ADMISSION, SO IT IS WORTH BEING PLAIN
 * ══════════════════════════════════════════════════════════════════════
 * Three modules — `close-readiness.ts`, `sweep.ts` and
 * `booking-ledger.ts` — build SQL by string concatenation and, across
 * two sessions of work, were NEVER EXECUTED ONCE. They typechecked.
 * They had tests. Every one of those tests read the source as TEXT and
 * asserted that a call was written.
 *
 * ⚠️ `expect(src).toContain("closeReadiness(ctx.tenant.id")` proves the
 * line exists. It proves nothing about whether the query runs, and a
 * misspelt column name would have reached whoever opened the close
 * screen first.
 *
 * ⭐ THE HARNESS RUNS THE REAL QUERIES AGAINST A REAL POSTGRES. This
 *   file exists so the harness cannot quietly stop being wired in —
 *   which, being skip-capable, is exactly how it would fail.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the harness is wired in and cannot silently disappear", () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐ THE MANIFEST IS WHAT DECIDES WHETHER A GATE RUNS
   * ══════════════════════════════════════════════════════════════════
   * This used to grep `scripts/preflight.mjs` for the script filename
   * and a label. That was the honest assertion when preflight held a
   * hand-written list — and it broke, correctly, the moment infra wave
   * 12 replaced that list with `gatesInTier()` over
   * `scripts/gates.mjs`.
   *
   * ⚠️ THE FILENAME IS NO LONGER IN preflight.mjs AND THE GATE STILL
   * RUNS. Grepping the consumer was always a proxy for the real
   * question, which is: is this gate on the one list that preflight,
   * CI and `check:gate-coverage` all read? Ask that instead.
   */
  it("is a script, an npm target and an entry in the gate manifest", async () => {
    expect(read("package.json")).toContain('"check:sql-executes"');

    // preflight reads the manifest rather than naming gates itself.
    expect(read("scripts/preflight.mjs")).toContain("gatesInTier");

    const { GATES } = await import("../../scripts/gates.mjs");
    const gate = GATES.find((g: { id: string }) => g.id === "sql-executes");
    expect(
      gate,
      "check:sql-executes is not in scripts/gates.mjs, so preflight and CI both skip it",
    ).toBeDefined();
    expect(gate!.script).toBe("scripts/check-sql-executes.mjs");
  });

  it("ships the schema and seed it needs, so it is runnable from a clone", () => {
    expect(read("scripts/harness/schema.sql")).toContain("CREATE TABLE transactions");
    expect(read("scripts/harness/seed.sql")).toContain("SALES:RCP:bbbbbbbb");
  });

  /**
   * 🔴 THE SEEDED CASE THAT MATTERS MOST. A vendor payment posted under
   * the LEGACY `RCP` tag, before the v1.27.0 rename. If the legacy tag
   * were dropped from the probe, every close in a workspace older than
   * that version would be blocked — and the harness catches it as a
   * count of 2 where 1 was expected. Verified by deliberately breaking
   * it before this was written.
   */
  it("seeds a vendor payment posted under the legacy key", () => {
    const seed = read("scripts/harness/seed.sql");
    expect(seed).toContain("THE ONE THAT MATTERS");
    expect(seed).toMatch(/SALES:RCP:bbbbbbbb-0000-0000-0000-000000000001/);
    const readiness = read("server/accounting/close-readiness.ts");
    expect(readiness).toContain('tags: ["VPY", "RCP"]');
  });

  /**
   * ⚠️ EVERY PROBE NEEDS A SEEDED EXPECTATION. A new source added to
   * `SOURCES` with no case in the harness is an unchecked query, so the
   * harness fails on the count mismatch rather than checking five of six.
   */
  it("fails rather than shrinks when a probe has no expectation", () => {
    const gate = read("scripts/check-sql-executes.mjs");
    expect(gate).toContain("has no expectation in this harness");
    expect(gate).toContain("Add a seeded case for the new one");
  });

  /**
   * ⭐ THE SPECS ARE PARSED FROM THE SOURCE, not copied into the
   * harness. A second copy of the table names and tags would be a second
   * thing to keep in step, and the one that drifted would be the one
   * nobody ran.
   */
  it("reads the probe specs out of close-readiness.ts itself", () => {
    const gate = read("scripts/check-sql-executes.mjs");
    expect(gate).toContain('"close-readiness.ts"');
    expect(gate).toContain("No probe specs could be parsed");
  });

  /**
   * ⚠️ A SKIP MUST NAME WHAT WENT UNCHECKED. "Passed" and "did not run"
   * looking identical is the failure mode of every optional gate.
   */
  it("says what it did not check when it skips", () => {
    const gate = read("scripts/check-sql-executes.mjs");
    expect(gate).toContain("SKIPPED");
    expect(gate).toContain("NOT CHECKED");
  });

  /**
   * 🔴 THE IDENTITY EVERY CANCELLATION DEPENDS ON. If
   * `bookingLedgerFacts` netted a role the wrong way, every cancellation
   * would refuse with a message blaming the operator's data.
   */
  it("checks the booking ledger identity, not just the probes", () => {
    const gate = read("scripts/check-sql-executes.mjs");
    expect(gate).toContain("advance + tax - receivable !== cash");
    expect(gate).toContain("blame the data");
  });
});
