/**
 * Ordence — ⭐⭐ BATCH 51: THE YEAR-TO-DATE TRUE-UP THAT NEVER HAPPENED
 * Version: v1.38.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ONE HARDCODED `"0"` MADE EVERY MONTH BEHAVE LIKE APRIL
 * ══════════════════════════════════════════════════════════════════════
 * `buildPayslip` implements the true-up correctly: project annual
 * income, compute the annual liability, subtract what has ALREADY been
 * deducted this financial year, spread the remainder over the months
 * that are left. Correct algorithm, fed a constant zero by
 * `server/payroll/run.ts:398`.
 *
 * ⚠️ AND IT FAILED IN THE DIRECTION THAT LOOKS FINE. Over-deduction is
 * refunded by the Income Tax Department when the employee files, so
 * nobody complains to the employer. The employer just quietly took far
 * too much tax from every salary and remitted it, and the employee
 * financed the government for a year.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fyStartFor, monthsRemainingInFy } from "@/server/payroll/run";

const ROOT = join(__dirname, "..", "..");
const RUN = readFileSync(join(ROOT, "server/payroll/run.ts"), "utf8");

const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ================================================================== */
/* ① THE FINANCIAL YEAR IS APRIL TO MARCH                              */
/* ================================================================== */

describe("fyStartFor", () => {
  /**
   * ⚠️ A CALENDAR YEAR WOULD RESET THE RUNNING TOTAL EVERY JANUARY,
   * under-deducting for three months and then over-deducting in the
   * fourth quarter when the error compounds into the projection.
   */
  it("starts the year in April, not January", () => {
    expect(fyStartFor("2026-04-01")).toBe("2026-04-01");
    expect(fyStartFor("2026-08-31")).toBe("2026-04-01");
    expect(fyStartFor("2026-12-31")).toBe("2026-04-01");
    // January to March belong to the PREVIOUS April's year.
    expect(fyStartFor("2027-01-31")).toBe("2026-04-01");
    expect(fyStartFor("2027-03-31")).toBe("2026-04-01");
    // And the day after is a new year.
    expect(fyStartFor("2027-04-01")).toBe("2027-04-01");
  });

  /** The two helpers must agree about where the year turns. */
  it("agrees with monthsRemainingInFy", () => {
    expect(monthsRemainingInFy("2026-04-30")).toBe(12);
    expect(monthsRemainingInFy("2027-03-31")).toBe(1);
    expect(fyStartFor("2026-04-30")).toBe(fyStartFor("2027-03-31"));
  });
});

/* ================================================================== */
/* ② THE ARITHMETIC THE ZERO BROKE                                     */
/* ================================================================== */

describe("what the hardcoded zero actually cost", () => {
  /**
   * 🔴 THE MARCH CASE IS THE ONE THAT WOULD HAVE BEEN NOTICED, and only
   * because it is enormous. With `monthsRemaining = 1`, the whole annual
   * liability is deducted in the final month on top of eleven months
   * already paid.
   *
   * Modelled here rather than asserted against a live run, because the
   * point is the size of the error, not the plumbing.
   */
  it("deducted the full annual liability again in March", () => {
    const annualLiability = 120_000n;

    const withHistory = (deductedSoFar: bigint, monthsLeft: bigint) =>
      (annualLiability - deductedSoFar) / monthsLeft;

    // Correct: eleven months of 10,000 paid, one month left.
    expect(withHistory(110_000n, 1n)).toBe(10_000n);

    // ⚠️ What shipped: history forced to zero.
    expect(withHistory(0n, 1n)).toBe(120_000n);

    // Twelve times the correct deduction, in one salary.
    expect(withHistory(0n, 1n) / withHistory(110_000n, 1n)).toBe(12n);
  });

  /** ⚠️ And the mid-year case, which nobody would have noticed at all. */
  it("roughly doubled the deduction by September", () => {
    const annual = 120_000n;
    const correct = (annual - 50_000n) / 7n; // five months paid, seven left
    const shipped = (annual - 0n) / 7n;
    expect(correct).toBe(10_000n);
    expect(shipped).toBe(17_142n);
    expect(shipped > correct).toBe(true);
  });
});

/* ================================================================== */
/* ③ AND A BRANCH THAT COULD NEVER FIRE                                */
/* ================================================================== */

describe("the caveat nobody could ever see", () => {
  /**
   * ⭐ THE HOUSE PATTERN AGAIN, ONE LAYER DOWN.
   *
   * `lib/payroll/statutory.ts` carries a caveat for the case where the
   * year's estimated tax has already been withheld in full:
   *
   *     if (outstanding <= 0n && liability > 0n) { caveats.push(...) }
   *
   * 🔴 `outstanding` is `liability - alreadyDeductedMinor`. With the
   * history forced to `"0"`, `outstanding` always EQUALLED `liability`,
   * so `outstanding <= 0n && liability > 0n` was unsatisfiable. The
   * branch was correct, tested by nothing, and unreachable.
   *
   * It is the same shape as the place-of-supply engine in Batch 33: a
   * right answer that no input could produce. This suite exists partly
   * to record that the shape recurs at every scale.
   */
  it("becomes reachable now that the history is real", () => {
    const statutory = readFileSync(
      join(ROOT, "lib/payroll/statutory.ts"),
      "utf8",
    );
    expect(statutory).toContain("outstanding <= 0n && liability > 0n");
    expect(statutory).toContain("already been withheld");

    // The condition, modelled: unsatisfiable at zero, satisfiable now.
    const outstandingFor = (liability: bigint, deducted: bigint) =>
      liability - deducted;
    expect(outstandingFor(120_000n, 0n) <= 0n).toBe(false);
    expect(outstandingFor(120_000n, 125_000n) <= 0n).toBe(true);
  });
});

/* ================================================================== */
/* ④ THE FIX                                                           */
/* ================================================================== */

describe("computeRun", () => {
  it("no longer hardcodes the deducted-so-far figure", () => {
    const code = codeOnly(RUN);
    expect(code).not.toContain('tdsAlreadyDeductedMinor: "0"');
    expect(code).toContain(
      "tdsAlreadyDeductedMinor: String(alreadyDeducted.get(person.id) ?? 0n)",
    );
  });

  /**
   * ⭐ ONLY APPROVED AND POSTED RUNS COUNT. A draft or a computed run is
   * a calculation somebody is still editing; counting it would make this
   * month's tax depend on a number that moves when a colleague
   * recomputes last month.
   */
  it("counts only runs whose money is settled", () => {
    const code = codeOnly(RUN);
    expect(code).toContain('inArray(payrollRuns.status, ["approved", "posted"])');
    expect(code).not.toMatch(/inArray\(payrollRuns\.status,\s*\[[^\]]*"draft"/);
    expect(code).not.toMatch(/inArray\(payrollRuns\.status,\s*\[[^\]]*"cancelled"/);
  });

  /**
   * 🔴 STRICTLY BEFORE THIS PERIOD. Without `lt`, recomputing the current
   * month would count its own previous payslips and deduct the tax again
   * on top of itself, every single time somebody pressed the button.
   */
  it("excludes the period being computed, so a recompute is idempotent", () => {
    const code = codeOnly(RUN);
    expect(code).toContain("lt(payrollRuns.periodStart, args.periodStart)");
    expect(code).toContain("gte(payrollRuns.periodStart, fyStartFor(args.periodStart))");
  });

  /**
   * ⚠️ ONE QUERY FOR THE RUN, NOT ONE PER EMPLOYEE. Four hundred round
   * trips inside a transaction is how a compute that took two seconds
   * starts timing out in month nine and gets "fixed" by hardcoding a
   * zero again.
   */
  it("reads the whole run's history in one query", () => {
    const code = codeOnly(RUN);
    expect(code).toContain("employeeIds: staff.map((p) => p.id)");
    // The call sits outside the per-person loop.
    const callAt = code.indexOf("await tdsDeductedThisFy(");
    const loopAt = code.indexOf("for (const person of staff)");
    expect(callAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(loopAt);
  });

  /** The reasoning is recorded where the next reader will be. */
  it("records why zero was never right after April", () => {
    expect(RUN).toContain("ZERO IS NEVER RIGHT AFTER APRIL");
    expect(RUN).toContain("FAILS IN THE DIRECTION THAT LOOKS FINE");
  });
});
