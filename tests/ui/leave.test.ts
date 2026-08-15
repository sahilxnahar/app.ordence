/**
 * Ordence — ⭐⭐⭐ BATCH 59: LEAVE, ACCRUAL AND STAFF ATTENDANCE
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Four decisions, and each one has a section here that fails if it is
 * quietly reversed:
 *
 *   ① ACCRUAL IS EARNED, NOT GRANTED — a mid-year joiner must not hold a
 *      full year, and twelve rounded monthly accruals must add up to the
 *      annual entitlement exactly.
 *   ② A BALANCE IS DERIVED, NEVER STORED — asserted by ABSENCE, over
 *      comment-stripped source, because the stored-balance table is the
 *      obvious thing for somebody to add later under performance
 *      pressure.
 *   ③ CAPS ARE EXPLICIT — both are `NOT NULL` with no "unlimited"
 *      sentinel anywhere.
 *   ④ AN APPROVAL IS NOT AN ABSENCE — a commitment moves `available` and
 *      never `balance`, and the ledger CHECK refuses a `taken` entry that
 *      does not come from an attendance row.
 *
 * ⚠️ THE ABSENCE ASSERTIONS READ COMMENT-STRIPPED SOURCE. Every one of
 * these files argues at length about the thing it does not do, so a naive
 * `toContain` search would match the argument and pass for the wrong
 * reason — or fail on prose. `codeOnly` is the same helper
 * `tests/ui/order-create.test.ts` uses.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  accrueTo,
  daysOnRollsInPeriod,
  monthEndsIn,
  policyFromRow,
  type AccrualPolicy,
} from "@/lib/leave/accrual";
import {
  carryForward,
  encashable,
  encashmentValueMinor,
  foldLedger,
  type LedgerEntryFacts,
} from "@/lib/leave/balance";
import { formatDays, parseDays, roundToGranularity } from "@/lib/leave/days";
import { countRequestDays, checkRequestPolicy } from "@/lib/leave/request";
import { defaultLopFraction, summariseAttendance } from "@/lib/leave/attendance";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** SQL comments are `--` to end of line and `/* ... *\/` blocks. */
const sqlCodeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const SCHEMA = read("db/schema/leave.ts");
const SQL = read("SQL-FILES/0082_leave_and_attendance.sql");
const ACTIONS = read("server/actions/leave.ts");

const FY = { startsOn: "2025-04-01", endsOn: "2026-03-31" } as const;

const EARNED_MONTHLY: AccrualPolicy = {
  method: "monthly_earned",
  annualEntitlementCentidays: 1800, // 18.00 days
  roundToCentidays: 50, // half days
  probationDays: 0,
};

/* ================================================================== */
/* ① ACCRUAL IS EARNED, NOT GRANTED                                    */
/* ================================================================== */

describe("decision ① — leave is earned in proportion to service", () => {
  /**
   * 🔴 THE ASSERTION THE WHOLE BATCH EXISTS FOR.
   *
   * Ravi joins on 20 October in an April–March leave year. By 31 March he
   * has been on the rolls for 163 of 365 days and has earned
   * 18 × 163/365 = 8.04 days, which is 8.00 at half-day granularity.
   *
   * ⚠️ THE WRONG ANSWER IS 18. It is what a system that grants the
   * entitlement on 1 April produces, it is on his screen, he will take
   * it, and the employer discovers in March that ten days of paid absence
   * per head were never earned and cannot be recovered.
   */
  it("gives a mid-year joiner a part year, not a whole one", () => {
    const outcome = accrueTo({
      policy: EARNED_MONTHLY,
      employee: { joinedOn: "2025-10-20", leftOn: null },
      period: FY,
      asOf: "2026-03-31",
      alreadyAccruedCentidays: 0,
    });

    expect(outcome.eligibleDays).toBe(163);
    expect(outcome.periodDays).toBe(365);
    expect(outcome.targetCentidays).toBe(800);
    expect(formatDays(outcome.deltaCentidays)).toBe("8.00");
    expect(outcome.targetCentidays).toBeLessThan(1800);
  });

  /**
   * ⭐⭐ THE CUMULATIVE-TARGET TEST, WHICH IS THE NON-OBVIOUS HALF.
   *
   * 🔴 ROUNDING EACH MONTH INDEPENDENTLY IS WRONG BY A WHOLE MONTH'S
   * ACCRUAL A YEAR AND LOOKS RIGHT EVERY SINGLE MONTH. An entitlement of
   * 15 days at half-day granularity is 1.25 a month; rounded per month
   * that is 1.5, and twelve of those is 18 against an entitlement of 15.
   * Nobody notices in April. Everybody notices in March.
   */
  it("adds up to exactly the annual entitlement over twelve months, however it rounds", () => {
    for (const annual of [1800, 1500, 1200, 2100, 700]) {
      const policy: AccrualPolicy = { ...EARNED_MONTHLY, annualEntitlementCentidays: annual };
      let accrued = 0;
      for (const monthEnd of monthEndsIn(FY, FY.endsOn)) {
        const outcome = accrueTo({
          policy,
          employee: { joinedOn: "2020-06-01", leftOn: null },
          period: FY,
          asOf: monthEnd,
          alreadyAccruedCentidays: accrued,
        });
        accrued += outcome.deltaCentidays;
      }
      expect(accrued, `annual entitlement ${annual}`).toBe(annual);
    }
  });

  /**
   * ⭐ RUNNING THE ACCRUAL TWICE WRITES NOTHING. An accrual run is
   * exactly the kind of job that gets triggered twice — a cron that
   * retried, an admin who clicked again. The unique index refuses the
   * duplicate; the arithmetic makes the attempt a zero in the first
   * place, which is belt to those braces.
   */
  it("computes a delta of zero when the month has already been accrued", () => {
    const first = accrueTo({
      policy: EARNED_MONTHLY,
      employee: { joinedOn: "2020-06-01", leftOn: null },
      period: FY,
      asOf: "2025-04-30",
      alreadyAccruedCentidays: 0,
    });
    const second = accrueTo({
      policy: EARNED_MONTHLY,
      employee: { joinedOn: "2020-06-01", leftOn: null },
      period: FY,
      asOf: "2025-04-30",
      alreadyAccruedCentidays: first.deltaCentidays,
    });
    expect(first.deltaCentidays).toBeGreaterThan(0);
    expect(second.deltaCentidays).toBe(0);
  });

  /**
   * ⚠️ `annual_advance` CHANGES THE TIMING AND NOT THE ENTITLEMENT. The
   * whole of a part-year joiner's pro-rated entitlement is available on
   * day one; a full year is not, because granting one to somebody who
   * will be there for five months is the liability this batch is about.
   */
  it("pro-rates a part-year joiner even when leave is granted up front", () => {
    const advance: AccrualPolicy = { ...EARNED_MONTHLY, method: "annual_advance" };

    const joiner = accrueTo({
      policy: advance,
      employee: { joinedOn: "2025-10-20", leftOn: null },
      period: FY,
      asOf: "2025-10-31",
      alreadyAccruedCentidays: 0,
    });
    /* Available immediately — but 8 days, not 18. */
    expect(joiner.targetCentidays).toBe(800);

    const fullYear = accrueTo({
      policy: advance,
      employee: { joinedOn: "2020-06-01", leftOn: null },
      period: FY,
      asOf: "2025-04-30",
      alreadyAccruedCentidays: 0,
    });
    expect(fullYear.targetCentidays).toBe(1800);
  });

  /** A leaver stops earning, by exactly the same interval arithmetic. */
  it("stops a leaver accruing after their last day", () => {
    const outcome = accrueTo({
      policy: EARNED_MONTHLY,
      employee: { joinedOn: "2020-06-01", leftOn: "2025-09-30" },
      period: FY,
      asOf: "2026-03-31",
      alreadyAccruedCentidays: 0,
    });
    /* 1 April to 30 September inclusive is 183 days. */
    expect(outcome.eligibleDays).toBe(183);
    expect(outcome.targetCentidays).toBeLessThan(1800);
  });

  /**
   * 🔴 IT NEVER WRITES A NEGATIVE ACCRUAL. Somebody whose leaving date
   * was backdated after the accrual ran is over-accrued; taking days back
   * that they have already been told about — and may have taken — is a
   * decision with a name on it, not a background job.
   */
  it("reports an over-accrual rather than silently clawing it back", () => {
    const outcome = accrueTo({
      policy: EARNED_MONTHLY,
      employee: { joinedOn: "2020-06-01", leftOn: "2025-06-30" },
      period: FY,
      asOf: "2026-03-31",
      alreadyAccruedCentidays: 1800,
    });
    expect(outcome.deltaCentidays).toBe(0);
    expect(outcome.overAccruedCentidays).toBeGreaterThan(0);
    expect(outcome.workingNote).toContain("Nothing has been taken back");
  });

  /** Probation is counted from joining, never from the start of the year. */
  it("earns nothing for days inside probation", () => {
    const withProbation: AccrualPolicy = { ...EARNED_MONTHLY, probationDays: 30 };
    const outcome = accrueTo({
      policy: withProbation,
      employee: { joinedOn: "2025-10-20", leftOn: null },
      period: FY,
      asOf: "2026-03-31",
      alreadyAccruedCentidays: 0,
    });
    expect(outcome.eligibleDays).toBe(133);
    expect(outcome.targetCentidays).toBe(650);
  });

  it("earns nothing at all on a type that is never earned", () => {
    const none = policyFromRow({
      accrualMethod: "none",
      annualEntitlementDays: "0",
      accrualRoundToDays: "0.5",
      probationDays: 0,
    });
    const outcome = accrueTo({
      policy: none,
      employee: { joinedOn: "2020-06-01", leftOn: null },
      period: FY,
      asOf: "2026-03-31",
      alreadyAccruedCentidays: 0,
    });
    expect(outcome.deltaCentidays).toBe(0);
  });

  /**
   * ⚠️ THE LAST MONTH END IS THE PERIOD'S OWN END DATE EVEN WHEN IT IS
   * NOT A MONTH END. A leave year running 16 June – 15 June otherwise
   * loses its final fortnight of accrual every year, for everybody.
   */
  it("walks month ends and always finishes on the period's last day", () => {
    const standard = monthEndsIn(FY, FY.endsOn);
    expect(standard).toHaveLength(12);
    expect(standard[0]).toBe("2025-04-30");
    expect(standard[11]).toBe("2026-03-31");

    const odd = monthEndsIn({ startsOn: "2025-06-16", endsOn: "2026-06-15" }, "2026-06-15");
    expect(odd[odd.length - 1]).toBe("2026-06-15");
  });

  it("counts days on the rolls as an intersection, so joiners and leavers cannot drift apart", () => {
    expect(
      daysOnRollsInPeriod({ joinedOn: "2020-01-01", leftOn: null }, FY, "2026-03-31"),
    ).toBe(365);
    expect(
      daysOnRollsInPeriod({ joinedOn: "2027-01-01", leftOn: null }, FY, "2026-03-31"),
    ).toBe(0);
    expect(
      daysOnRollsInPeriod({ joinedOn: "2020-01-01", leftOn: "2024-01-01" }, FY, "2026-03-31"),
    ).toBe(0);
  });
});

/* ================================================================== */
/* ② A BALANCE IS DERIVED, NEVER STORED                                */
/* ================================================================== */

describe("decision ② — the balance is a fold over the ledger", () => {
  /**
   * 🔴 ASSERTED BY ABSENCE, OVER COMMENT-STRIPPED SOURCE. Both files
   * argue at length about the table they do not create, so a naive search
   * would match the argument.
   */
  it("creates no stored-balance table anywhere", () => {
    const schema = codeOnly(SCHEMA);
    const sql = sqlCodeOnly(SQL);

    expect(schema).not.toMatch(/pgTable\(\s*["'`]leave_balances["'`]/);
    expect(schema).not.toMatch(/balanceDays\s*:\s*numeric/);
    expect(sql).not.toMatch(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+leave_balances/i);
    expect(sql).not.toMatch(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+leave_entitlements/i);
  });

  /** ⚠️ And the ledger is append-only, which is what makes the fold safe. */
  it("blocks UPDATE and DELETE on the ledger", () => {
    const sql = sqlCodeOnly(SQL);
    expect(sql).toContain("leave_ledger_block_mutation");
    expect(sql).toMatch(/BEFORE UPDATE ON leave_ledger/);
    expect(sql).toMatch(/BEFORE DELETE ON leave_ledger/);
  });

  it("sums the entries into the same balance whatever order they arrive in", () => {
    const entries: LedgerEntryFacts[] = [
      { kind: "carry_forward_in", daysDelta: "10.00" },
      { kind: "accrual", daysDelta: "1.50" },
      { kind: "accrual", daysDelta: "1.50" },
      { kind: "taken", daysDelta: "-3.00" },
      { kind: "lapse", daysDelta: "-0.50" },
    ];
    const forwards = foldLedger(entries);
    const backwards = foldLedger([...entries].reverse());

    expect(forwards.balanceCentidays).toBe(950);
    expect(backwards.balanceCentidays).toBe(forwards.balanceCentidays);
    expect(forwards.takenCentidays).toBe(300);
    expect(forwards.lapsedCentidays).toBe(50);
  });

  /**
   * 🔴 HALF DAYS MUST NOT DRIFT. `0.1 + 0.2 !== 0.3` in binary floating
   * point, and a leave balance printed as `12.299999999999999` is a
   * support ticket nobody can answer. Days are integer hundredths.
   */
  it("adds a hundred half days without drifting", () => {
    const entries: LedgerEntryFacts[] = Array.from({ length: 100 }, () => ({
      kind: "adjustment" as const,
      daysDelta: "0.10",
    }));
    expect(foldLedger(entries).balanceCentidays).toBe(1000);
    expect(formatDays(foldLedger(entries).balanceCentidays)).toBe("10.00");
  });

  it("parses a numeric string without ever touching a float", () => {
    expect(parseDays("8.115")).toBe(811);
    expect(parseDays("0.07")).toBe(7);
    expect(parseDays(".5")).toBe(50);
    expect(parseDays("-2.5")).toBe(-250);
    expect(parseDays("18")).toBe(1800);
    expect(parseDays("not a number")).toBeNull();
    expect(parseDays(null)).toBeNull();
    expect(formatDays(-250)).toBe("-2.50");
    expect(formatDays(805)).toBe("8.05");
  });

  /**
   * ⚠️ ROUNDING IS AWAY FROM ZERO, NOT `Math.round`. On a signed ledger a
   * debit and a credit of the same size must round the same way, or a
   * balance that should net to zero does not.
   */
  it("rounds symmetrically about zero", () => {
    expect(roundToGranularity(125, 50)).toBe(150);
    expect(roundToGranularity(-125, 50)).toBe(-150);
    expect(roundToGranularity(124, 50)).toBe(100);
    expect(roundToGranularity(133, 0)).toBe(133);
  });
});

/* ================================================================== */
/* ③ CARRY-FORWARD AND ENCASHMENT ARE CAPPED, EXPLICITLY               */
/* ================================================================== */

describe("decision ③ — the caps exist and are not nullable", () => {
  /**
   * 🔴 NOT NULL AND NO SENTINEL. Uncapped carry-forward compounds into a
   * liability that appears on nobody's balance sheet: thirty people
   * leaving five days a year unused is 900 days after six years, payable
   * in cash the first time a team turns over.
   */
  it("declares both caps NOT NULL in the SQL", () => {
    const sql = sqlCodeOnly(SQL);
    expect(sql).toMatch(/carry_forward_cap_days\s+numeric\(7,2\)\s+NOT NULL/);
    expect(sql).toMatch(/encashment_cap_days\s+numeric\(7,2\)\s+NOT NULL/);
    /* ⚠️ And nothing in the schema makes either of them optional. */
    expect(codeOnly(SCHEMA)).toMatch(/carryForwardCapDays[\s\S]{0,200}?\.notNull\(\)/);
    expect(codeOnly(SCHEMA)).toMatch(/encashmentCapDays[\s\S]{0,200}?\.notNull\(\)/);
  });

  it("carries up to the cap and lapses the rest, with the reason on the entry", () => {
    const result = carryForward({ closingCentidays: 1300, capCentidays: 1000 });
    expect(result.carriedCentidays).toBe(1000);
    expect(result.lapsedCentidays).toBe(300);
    expect(result.workingNote).toContain("lapse");
  });

  it("lapses everything when the cap is zero — use it or lose it", () => {
    const result = carryForward({ closingCentidays: 1300, capCentidays: 0 });
    expect(result.carriedCentidays).toBe(0);
    expect(result.lapsedCentidays).toBe(1300);
  });

  /**
   * ⚠️ A NEGATIVE BALANCE CARRIES IN FULL AND NEVER LAPSES. A cap limits
   * what an employee may KEEP, not what they OWE — lapsing a debt would
   * write off an overdraft nobody decided to forgive.
   */
  it("carries a negative balance in full and lapses none of it", () => {
    const result = carryForward({ closingCentidays: -300, capCentidays: 0 });
    expect(result.carriedCentidays).toBe(-300);
    expect(result.lapsedCentidays).toBe(0);
  });

  it("limits an encashment by the cap, the balance and the minimum retained", () => {
    /* The annual cap binds. */
    expect(
      encashable({
        balanceCentidays: 2000,
        capCentidays: 500,
        minRetainCentidays: 0,
        alreadyEncashedCentidays: 0,
        requestedCentidays: 1000,
      }).allowedCentidays,
    ).toBe(500);

    /* What must remain binds. */
    const retained = encashable({
      balanceCentidays: 1000,
      capCentidays: 1000,
      minRetainCentidays: 500,
      alreadyEncashedCentidays: 0,
      requestedCentidays: 1000,
    });
    expect(retained.allowedCentidays).toBe(500);
    expect(retained.reason).toContain("must remain");

    /* And the cap is annual, so earlier encashments count against it. */
    expect(
      encashable({
        balanceCentidays: 2000,
        capCentidays: 500,
        minRetainCentidays: 0,
        alreadyEncashedCentidays: 500,
        requestedCentidays: 100,
      }).allowedCentidays,
    ).toBe(0);
  });

  /** 🔴 Money is bigint minor units, rounded to the rupee. */
  it("values an encashment in paise, multiplying before dividing", () => {
    /* Half a day at ₹1,000 a day is ₹500. */
    expect(encashmentValueMinor(50, 100_000n)).toBe(50_000n);
    /* 2.5 days at ₹1,234.56 a day, rounded to the rupee. */
    expect(encashmentValueMinor(250, 123_456n)).toBe(308_600n);
    expect(typeof encashmentValueMinor(100, 1n)).toBe("bigint");
  });
});

/* ================================================================== */
/* ④ AN APPROVAL IS NOT AN ABSENCE                                     */
/* ================================================================== */

describe("decision ④ — a commitment is not a spend", () => {
  /**
   * 🔴 THE CONSTRAINT, NOT THE CONVENTION. A rule that lives only in an
   * approval handler is a rule the next handler does not have.
   */
  it("refuses a `taken` entry that does not come from an attendance row", () => {
    const sql = sqlCodeOnly(SQL);
    expect(sql).toContain("leave_ledger_taken_from_attendance");
    expect(sql).toMatch(/kind <> 'taken' OR attendance_id IS NOT NULL/);
  });

  it("moves `available` and not `balance` when leave is approved", () => {
    const afterApproval = foldLedger([
      { kind: "accrual", daysDelta: "13.50" },
      { kind: "commitment", daysDelta: "-3.00" },
    ]);
    expect(afterApproval.balanceCentidays).toBe(1350);
    expect(afterApproval.committedCentidays).toBe(300);
    expect(afterApproval.availableCentidays).toBe(1050);
  });

  /**
   * ⭐ AND WHEN THE DAY IS ACTUALLY TAKEN, THE BALANCE MOVES AND
   * `available` DOES NOT. The day went from reserved to spent; the
   * employee's room to apply for more did not change when it did.
   */
  it("moves `balance` and leaves `available` alone when the day is recorded", () => {
    const afterAttendance = foldLedger([
      { kind: "accrual", daysDelta: "13.50" },
      { kind: "commitment", daysDelta: "-3.00" },
      { kind: "taken", daysDelta: "-1.00" },
      { kind: "commitment_release", daysDelta: "1.00" },
    ]);
    expect(afterAttendance.balanceCentidays).toBe(1250);
    expect(afterAttendance.committedCentidays).toBe(200);
    expect(afterAttendance.availableCentidays).toBe(1050);
  });

  /** Cancelling releases the reservation and never touches the balance. */
  it("returns the days on a cancellation without a reversal", () => {
    const cancelled = foldLedger([
      { kind: "accrual", daysDelta: "13.50" },
      { kind: "commitment", daysDelta: "-3.00" },
      { kind: "commitment_release", daysDelta: "3.00" },
    ]);
    expect(cancelled.balanceCentidays).toBe(1350);
    expect(cancelled.committedCentidays).toBe(0);
    expect(cancelled.availableCentidays).toBe(1350);
  });

  /**
   * ⚠️ THE APPROVAL HANDLER WRITES A `commitment` AND NOTHING ELSE, and
   * only `recordAttendance` writes a `taken`. Asserted over
   * comment-stripped source because both functions discuss the other's
   * job at length.
   */
  it("writes a commitment on approval and a taken only from attendance", () => {
    const code = codeOnly(ACTIONS);
    const decideAt = code.indexOf("export async function decideLeaveRequest");
    const cancelAt = code.indexOf("export async function cancelLeaveRequest");
    const recordAt = code.indexOf("export async function recordAttendance");

    expect(decideAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(-1);

    const decideBody = code.slice(decideAt, cancelAt);
    expect(decideBody).toContain('kind: "commitment"');
    expect(decideBody).not.toContain('kind: "taken"');

    const recordBody = code.slice(recordAt);
    expect(recordBody).toContain('kind: "taken"');
    expect(recordBody).toContain("attendanceId: saved.id");
  });

  it("refuses to let anybody approve their own leave", () => {
    expect(codeOnly(ACTIONS)).toContain("You cannot approve your own leave");
  });
});

/* ================================================================== */
/* ⑤ COUNTING A REQUEST                                                */
/* ================================================================== */

describe("counting the days in an application", () => {
  const base = {
    fromOn: "2025-12-22",
    toOn: "2025-12-26",
    halfDayStart: false,
    halfDayEnd: false,
    weeklyOffDays: [0],
    holidays: [] as string[],
  };

  it("charges only working days when the type does not count offs", () => {
    const out = countRequestDays({ ...base, countsHolidaysAndOffs: false });
    expect(out.chargeableCentidays).toBe(500);
    expect(out.problems).toEqual([]);
  });

  /**
   * 🔴 THE FLAG THAT COSTS EVERY EMPLOYEE TWO DAYS A WEEK WHEN IT IS
   * BACKWARDS, and looks plausible the whole time.
   */
  it("charges the whole block when the type does count offs", () => {
    const span = { ...base, fromOn: "2025-12-20", toOn: "2025-12-26" };
    expect(countRequestDays({ ...span, countsHolidaysAndOffs: true }).chargeableCentidays).toBe(
      700,
    );
    expect(countRequestDays({ ...span, countsHolidaysAndOffs: false }).chargeableCentidays).toBe(
      600,
    );
  });

  it("does not charge a declared holiday inside a casual-leave block", () => {
    const out = countRequestDays({
      ...base,
      countsHolidaysAndOffs: false,
      holidays: ["2025-12-25"],
    });
    expect(out.chargeableCentidays).toBe(400);
    expect(out.holidayDays).toBe(1);
  });

  /**
   * ⭐ THE HALF DAY COMES OFF THE FIRST CHARGEABLE DAY, not the first
   * calendar day. A half day on Friday afternoon through Monday is 1.5
   * days, and the Sunday in the middle has nothing to do with it.
   */
  it("takes half days off the chargeable ends only", () => {
    const out = countRequestDays({
      fromOn: "2025-12-19",
      toOn: "2025-12-22",
      halfDayStart: true,
      halfDayEnd: false,
      countsHolidaysAndOffs: false,
      weeklyOffDays: [0, 6],
      holidays: [],
    });
    /* Friday and Monday are chargeable; the Friday is a half day. */
    expect(out.chargeableCentidays).toBe(150);
  });

  it("refuses a one-day application that is a half day at both ends", () => {
    const out = countRequestDays({
      ...base,
      toOn: "2025-12-22",
      halfDayStart: true,
      halfDayEnd: true,
      countsHolidaysAndOffs: false,
    });
    expect(out.problems.join(" ")).toContain("half day at both ends");
  });

  it("refuses a range that is entirely weekly offs", () => {
    const out = countRequestDays({
      fromOn: "2025-12-21",
      toOn: "2025-12-21",
      halfDayStart: false,
      halfDayEnd: false,
      countsHolidaysAndOffs: false,
      weeklyOffDays: [0],
      holidays: [],
    });
    expect(out.problems.join(" ")).toContain("nothing to apply for");
  });

  /**
   * ⚠️ AN UNPAID TYPE HAS NO BALANCE TO EXCEED. Loss of pay is rationed
   * by the employer's willingness to approve it, not by a ledger.
   */
  it("does not check a balance on an unpaid leave type", () => {
    const problems = checkRequestPolicy({
      requestedCentidays: 500,
      availableCentidays: 0,
      allowNegativeBalance: false,
      maxNegativeCentidays: 0,
      maxConsecutiveCentidays: null,
      minNoticeDays: 0,
      allowHalfDay: true,
      usesHalfDay: false,
      noticeDays: 30,
      isPaid: false,
    });
    expect(problems).toEqual([]);
  });

  it("refuses more paid leave than is available and suggests the remedy", () => {
    const problems = checkRequestPolicy({
      requestedCentidays: 500,
      availableCentidays: 200,
      allowNegativeBalance: false,
      maxNegativeCentidays: 0,
      maxConsecutiveCentidays: null,
      minNoticeDays: 0,
      allowHalfDay: true,
      usesHalfDay: false,
      noticeDays: 30,
      isPaid: true,
    });
    expect(problems.join(" ")).toContain("unpaid leave");
  });
});

/* ================================================================== */
/* ⑥ THE HANDOVER TO PAYROLL — WHAT BATCH 50 NEEDS                     */
/* ================================================================== */

describe("attendance is what the payroll run reads", () => {
  /**
   * 🔴 THE SHAPE MUST MATCH `server/payroll/run.ts#AttendanceInput`
   * FIELD FOR FIELD. `lib/` may not import from `server/`, so the two
   * definitions are declared separately and this test is what keeps them
   * honest. A drift between them is a payroll that silently ignores loss
   * of pay, which is the defect this whole batch exists to make fixable.
   */
  it("produces exactly the shape the payroll compute already accepts", () => {
    /* ⚠️ Cut at the interface's own closing brace, not at a fixed number
       of characters — the next declaration's fields would otherwise be
       counted as this one's and the comparison would pass or fail for a
       reason that has nothing to do with either shape. */
    const bodyOf = (src: string, declaration: string) => {
      const at = src.indexOf(declaration);
      expect(at, declaration).toBeGreaterThan(-1);
      const end = src.indexOf("\n}", at);
      return src.slice(at, end).match(/readonly (\w+):/g);
    };

    const fields = bodyOf(codeOnly(read("server/payroll/run.ts")), "export interface AttendanceInput");
    expect(fields).toEqual([
      "readonly employeeId:",
      "readonly payableDays:",
      "readonly lopDays:",
    ]);

    const mine = bodyOf(
      codeOnly(read("lib/leave/attendance.ts")),
      "export interface PayrollAttendanceRow",
    );
    expect(mine).toEqual(fields);
  });

  it("sums loss of pay per employee across the period", () => {
    const summary = summariseAttendance({
      days: [
        { employeeId: "a", onDate: "2025-12-15", status: "paid_leave", lopFraction: "0.50" },
        { employeeId: "a", onDate: "2025-12-16", status: "absent", lopFraction: "1.00" },
        { employeeId: "b", onDate: "2025-12-16", status: "present", lopFraction: "0.00" },
      ],
      payableDaysByEmployee: new Map([
        ["a", 31],
        ["b", 31],
      ]),
    });

    expect(summary.rows).toEqual([
      { employeeId: "a", payableDays: 31, lopDays: 1.5 },
      { employeeId: "b", payableDays: 31, lopDays: 0 },
    ]);
    expect(summary.unexplainedAbsenceEmployeeIds).toEqual(["a"]);
  });

  /**
   * ⚠️ LOSS OF PAY CANNOT EXCEED THE DAYS ON THE ROLLS. Otherwise
   * `paidDays()` in lib/payroll/payslip.ts clamps a negative to zero and
   * the payslip says "0 of 31 days" with no explanation of where the
   * extra came from.
   */
  it("caps loss of pay at the days the person was on the rolls", () => {
    const summary = summariseAttendance({
      days: Array.from({ length: 20 }, (_, i) => ({
        employeeId: "a",
        onDate: `2025-12-${String(i + 1).padStart(2, "0")}`,
        status: "absent",
        lopFraction: "1.00",
      })),
      payableDaysByEmployee: new Map([["a", 12]]),
    });
    expect(summary.rows[0].lopDays).toBe(12);
  });

  /**
   * ⭐ AN EMPLOYEE THE RUN DOES NOT COVER IS DROPPED, NOT GUESSED AT.
   * Inventing a `payableDays` for them would put a payslip in a run that
   * `computeRun()` deliberately excluded.
   */
  it("drops attendance for somebody the run has no payslip for", () => {
    const summary = summariseAttendance({
      days: [{ employeeId: "ghost", onDate: "2025-12-01", status: "absent", lopFraction: "1.00" }],
      payableDaysByEmployee: new Map(),
    });
    expect(summary.rows).toEqual([]);
  });

  /**
   * 🔴 AN UNKNOWN STATUS PROPOSES NO LOSS OF PAY. The other default —
   * dock the day — would turn a future enum value somebody forgot to
   * handle into an unexplained deduction on everybody's payslip.
   */
  it("proposes no loss of pay for a status it does not recognise", () => {
    expect(defaultLopFraction("absent")).toBe(100);
    expect(defaultLopFraction("weekly_off")).toBe(0);
    expect(defaultLopFraction("something_new")).toBe(0);
  });

  it("exposes a guarded server action the payroll board can call", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("export async function getPayrollAttendance");
    /* ⚠️ Guarded on the payroll key, so the operator needs no second one. */
    expect(code).toMatch(
      /export async function getPayrollAttendance[\s\S]{0,600}?requirePermission\(PAYROLL_MANAGE\)/,
    );
    expect(existsSync(join(ROOT, "server/leave/attendance.ts"))).toBe(true);
    expect(codeOnly(read("server/leave/attendance.ts"))).toContain(
      "export async function loadPayrollAttendance",
    );
  });

  /**
   * ⚠️ AND IT IS NOT `site_attendance`. That table records check-in and
   * check-out punches for contract labour, who are paid through a
   * vendor's RA bill and are on nobody's payroll.
   */
  it("is a different table from the construction labour punch register", () => {
    const sql = sqlCodeOnly(SQL);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS staff_attendance/);
    expect(sql).not.toMatch(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+site_attendance/i);
    expect(codeOnly(SCHEMA)).toMatch(/pgTable\(\s*["'`]staff_attendance["'`]/);
  });
});

/* ================================================================== */
/* ⑦ THE MIGRATION AND THE TENANT BOUNDARY                             */
/* ================================================================== */

describe("0082 ships as three files and protects every table", () => {
  const TABLES = [
    "leave_periods",
    "holiday_calendar",
    "leave_types",
    "leave_ledger",
    "leave_requests",
    "staff_attendance",
  ];

  it("ships the migration, the verifier and the drill", () => {
    expect(existsSync(join(ROOT, "SQL-FILES/0082_leave_and_attendance.sql"))).toBe(true);
    expect(existsSync(join(ROOT, "SQL-FILES/VERIFY-0082-neon-safe.sql"))).toBe(true);
    expect(existsSync(join(ROOT, "SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0082.sql"))).toBe(true);
  });

  /** ⚠️ The verifier must be read-only — it is run against production. */
  it("keeps the verifier free of anything that writes", () => {
    const verify = sqlCodeOnly(read("SQL-FILES/VERIFY-0082-neon-safe.sql"));
    for (const forbidden of ["INSERT ", "UPDATE ", "DELETE ", "ALTER ", "DROP ", "CREATE "]) {
      expect(verify.toUpperCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("gives every new table a NOT NULL tenant_id", () => {
    const sql = sqlCodeOnly(SQL);
    for (const table of TABLES) {
      const at = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(at, table).toBeGreaterThan(-1);
      const body = sql.slice(at, at + 900);
      expect(body, table).toMatch(/tenant_id\s+uuid NOT NULL REFERENCES tenants\(id\)/);
    }
  });

  /**
   * 🔴 THREE SEPARATE THINGS, AND `check:sql` ASSERTS EACH ONE. ENABLE
   * without FORCE leaves the table owner bypassing every policy, and this
   * application connects as the owner.
   */
  it("enables, forces and creates a policy for all six", () => {
    const sql = sqlCodeOnly(SQL);
    expect(sql).toMatch(/EXECUTE format\('ALTER TABLE %I ENABLE ROW LEVEL SECURITY'/);
    expect(sql).toMatch(/EXECUTE format\('ALTER TABLE %I FORCE\s+ROW LEVEL SECURITY'/);
    expect(sql).toContain("CREATE POLICY %I ON %I ");
    for (const table of TABLES) {
      expect(sql, table).toContain(`'${table}'`);
    }
    /* ⭐ The house rule: platform scope in USING, never in WITH CHECK. */
    expect(sql).toContain(
      "'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '",
    );
    expect(sql).toContain("'WITH CHECK (tenant_id = app_current_tenant_id())'");
  });

  /** ⚠️ The schema is registered, or `drizzle-kit push` never sees it. */
  it("exports the schema from the barrel", () => {
    expect(codeOnly(read("db/schema/index.ts"))).toContain('export * from "./leave"');
  });
});

/* ================================================================== */
/* ⑧ THE GUARDS AND THE ROUTE                                          */
/* ================================================================== */

describe("every leave endpoint asks who is calling", () => {
  /**
   * 🔴 A `"use server"` EXPORT IS A URL. `check:guards` follows one hop;
   * this asserts the guard is visible at the export itself, which is what
   * a reviewer reads.
   */
  it("guards every export with a permission, at the export", () => {
    const code = codeOnly(ACTIONS);
    const exports = [...code.matchAll(/export async function (\w+)/g)];
    expect(exports.length).toBeGreaterThan(8);

    for (const match of exports) {
      const body = code.slice(match.index ?? 0, (match.index ?? 0) + 700);
      expect(body, match[1]).toMatch(/requirePermission\(/);
    }
  });

  /**
   * ⚠️ AND THE KEYS ARE THE LEAVE KEYS, NOT THE PAYROLL ONES. A line
   * manager approving three days off must not thereby be able to read
   * everybody's salary.
   */
  it("uses its own permission vocabulary", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain('const READ = "leave.read"');
    expect(code).toContain('const REQUEST = "leave.request"');
    expect(code).toContain('const APPROVE = "leave.approve"');
    expect(code).toContain('const MANAGE = "leave.manage"');
    expect(code).toContain('const RECORD = "attendance.record"');

    const catalogue = codeOnly(read("db/schema/auth.ts"));
    for (const key of [
      "leave.read",
      "leave.request",
      "leave.approve",
      "leave.manage",
      "attendance.record",
    ]) {
      expect(catalogue, key).toContain(`"${key}"`);
    }
  });

  /**
   * ⭐ THE SELF-SERVICE READ TAKES NO ARGUMENTS. A function with no
   * parameter cannot be given somebody else's id by any future edit that
   * does not first change its signature — a change a reviewer sees.
   */
  it("scopes an employee's own leave by the session and not by a parameter", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toContain("export async function myLeaveOverview(): Promise<");
    expect(code).not.toMatch(/myLeaveOverview\(\s*employeeId/);
    expect(code).toContain("eq(leaveRequests.employeeId, me.id)");
  });

  it("is reachable from the payroll screen", () => {
    expect(codeOnly(read("app/(crm)/payroll/page.tsx"))).toContain('href="/payroll/leave"');
    expect(existsSync(join(ROOT, "app/(crm)/payroll/leave/page.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "app/(crm)/payroll/leave/me/page.tsx"))).toBe(true);
  });
});
