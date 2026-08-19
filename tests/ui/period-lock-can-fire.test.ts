/**
 * Ordence — 🔴🔴🔴 THE PERIOD LOCK COULD NEVER FIRE
 * Version: v1.70.0-alpha (wave two)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT, AND IT IS NOT A BUG
 * ══════════════════════════════════════════════════════════════════════
 * `createFinancialPeriod` is the only insert into `financial_periods`
 * anywhere in this product. Nothing called it. Meanwhile three screens
 * call `closeFinancialPeriod`, one calls `reopenFinancialPeriod`, and two
 * list periods.
 *
 * `closedPeriodFor()` in `server/accounting/post-sales.ts` runs
 *
 *     SELECT name FROM financial_periods
 *      WHERE tenant_id = $1 AND $2::date BETWEEN start_date AND end_date
 *        AND status IN ('closed', 'locked')
 *
 * on EVERY posting. Against an empty table it always returns null.
 *
 * 🔴 SO EVERY PERIOD-LOCK GUARANTEE IN THIS CODEBASE WAS VACUOUS: the
 * `period_closed` outcome in `writePosting` since v1.21.0, `0073`'s
 * database lock, `0100`'s depreciation lock, `0102`'s reconciliation
 * lock, Brief D's `journal_entries_period_lock` trigger in `0108`, and
 * the refusal `0112` prints telling an operator to reopen a period.
 *
 * ⭐ NONE OF THAT CODE IS WRONG. Every line of it is correct code reading
 * a table that one missing form kept empty. No test could catch it,
 * because every test that needed a closed period created one in a
 * fixture. The product could not.
 *
 * ⚠️ THESE TESTS ARE THEREFORE ABOUT THE ROUTE, NOT THE LOCK. The lock is
 * tested elsewhere and has always passed.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { monthPreset } from "@/components/accounting/create-period-form";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ================================================================== */
describe("🔴🔴🔴 a period can now be created by a human being", () => {
  it("⭐ a screen calls createFinancialPeriod, the only insert into the table", () => {
    expect(read("app/(crm)/accounting/page.tsx")).toContain("createFinancialPeriod");
  });

  it("🔴 and it is a real call, not a mention in a comment", () => {
    /**
     * ⚠️ THE DISTINCTION THIS FILE EXISTS FOR. The first version of
     * `check:action-reachability` counted a doc comment as a caller and
     * reported this very action as reached while nothing called it.
     */
    const page = read("app/(crm)/accounting/page.tsx");
    expect(page).toMatch(/createAction=\{createFinancialPeriod\}/);
    expect(page).toContain('from "@/server/actions/periods"');
  });

  it("⚠️ the empty state now says what an empty table means", () => {
    const page = read("app/(crm)/accounting/page.tsx");
    expect(page).toMatch(/period lock reads this table/i);
  });

  it("the form component exists and is a client component", () => {
    const p = "components/accounting/create-period-form.tsx";
    expect(existsSync(join(ROOT, p))).toBe(true);
    expect(read(p).startsWith('"use client"')).toBe(true);
  });
});

/* ================================================================== */
describe("⭐⭐ the month preset, where an off-by-one becomes a hole in the lock", () => {
  /**
   * 🔴 THE LOCK READS `BETWEEN start_date AND end_date`, WHICH IS
   * INCLUSIVE AT BOTH ENDS. A period that ends on the 30th of a 31-day
   * month leaves the 31st outside every period there is — and a posting
   * dated the 31st is then PERMITTED into a month everybody believes is
   * shut. Hard-coding 30 or 31 is the classic way to produce that hole.
   */
  it("🔴 ends a 31-day month on the 31st", () => {
    expect(monthPreset("2027-03")?.endDate).toBe("2027-03-31");
    expect(monthPreset("2027-12")?.endDate).toBe("2027-12-31");
  });

  it("🔴 ends a 30-day month on the 30th", () => {
    expect(monthPreset("2027-04")?.endDate).toBe("2027-04-30");
    expect(monthPreset("2027-11")?.endDate).toBe("2027-11-30");
  });

  it("🔴 February: 28 in a common year, 29 in a leap year", () => {
    expect(monthPreset("2027-02")?.endDate).toBe("2027-02-28");
    expect(monthPreset("2028-02")?.endDate).toBe("2028-02-29");
    /** ⚠️ 2100 is NOT a leap year. The century rule, asserted. */
    expect(monthPreset("2100-02")?.endDate).toBe("2100-02-28");
    expect(monthPreset("2000-02")?.endDate).toBe("2000-02-29");
  });

  it("⭐ every month of a leap year and a common year starts on the 1st", () => {
    for (const y of [2027, 2028]) {
      for (let m = 1; m <= 12; m += 1) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        expect(monthPreset(key)?.startDate, key).toBe(`${key}-01`);
      }
    }
  });

  /**
   * 🔴 CONSECUTIVE MONTHS MUST NOT OVERLAP AND MUST NOT LEAVE A GAP.
   * An overlap is refused by the server and by an exclusion constraint;
   * a GAP is refused by nothing, and a day in a gap belongs to no period
   * and can always be posted into.
   */
  it("🔴 consecutive months abut exactly: no gap, no overlap, over three years", () => {
    let prevEnd: string | null = null;
    for (let y = 2026; y <= 2028; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const p = monthPreset(`${y}-${String(m).padStart(2, "0")}`)!;
        if (prevEnd !== null) {
          const nextDay = new Date(`${prevEnd}T00:00:00Z`);
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          expect(p.startDate, `gap or overlap before ${p.name}`).toBe(
            nextDay.toISOString().slice(0, 10),
          );
        }
        prevEnd = p.endDate;
      }
    }
  });
});

/* ================================================================== */
describe("⚠️ the Indian financial year, which turns over in April", () => {
  it("March belongs to the year that started the previous April", () => {
    expect(monthPreset("2027-03")?.fiscalYear).toBe("2026-27");
    expect(monthPreset("2027-03")?.periodNumber).toBe("12");
  });

  it("April starts the next one", () => {
    expect(monthPreset("2027-04")?.fiscalYear).toBe("2027-28");
    expect(monthPreset("2027-04")?.periodNumber).toBe("1");
  });

  it("⚠️ the label rolls the century correctly", () => {
    expect(monthPreset("2099-04")?.fiscalYear).toBe("2099-00");
    expect(monthPreset("2100-04")?.fiscalYear).toBe("2100-01");
  });

  it("period numbers run 1..12 from April with no repeats", () => {
    const seen = new Set<string>();
    for (let m = 4; m <= 12; m += 1)
      seen.add(monthPreset(`2027-${String(m).padStart(2, "0")}`)!.periodNumber);
    for (let m = 1; m <= 3; m += 1)
      seen.add(monthPreset(`2028-${String(m).padStart(2, "0")}`)!.periodNumber);
    expect(seen.size).toBe(12);
  });

  it("refuses input that is not a month", () => {
    expect(monthPreset("")).toBeNull();
    expect(monthPreset("2027-13")).toBeNull();
    expect(monthPreset("2027-00")).toBeNull();
    expect(monthPreset("not-a-month")).toBeNull();
  });
});

/* ================================================================== */
describe("🔴 the lock the empty table was defeating", () => {
  it("closedPeriodFor still reads financial_periods, or this whole fix is aimed at nothing", () => {
    const src = read("server/accounting/post-sales.ts");
    expect(src).toContain("FROM financial_periods");
    expect(src).toMatch(/status IN \('closed', 'locked'\)/);
    /** ⚠️ Inclusive at both ends. The preset tests above depend on it. */
    expect(src).toContain("BETWEEN start_date AND end_date");
  });
});
