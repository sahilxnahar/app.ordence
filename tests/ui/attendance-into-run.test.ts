/**
 * Ordence — ⭐⭐⭐ BATCH 50: ATTENDANCE INTO THE PAYROLL RUN
 * Version: v1.47.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEFECT THIS SUITE EXISTS TO KEEP FIXED
 * ══════════════════════════════════════════════════════════════════════
 * `components/payroll/payroll-run-board.tsx` passed `attendance: []` to
 * the payroll compute. It was hardcoded, so loss of pay could never be
 * entered and every run paid every salaried person a full month.
 *
 * Five things have to stay true, and each has a section here:
 *
 *   ① THE EMPTY ARRAY IS GONE, and it is gone from the SERVER side too —
 *      the compute endpoint no longer accepts attendance from a browser
 *      at all.
 *   ② PAID LEAVE AND UNPAID LEAVE ARE NOT THE SAME THING, and neither is
 *      an unexplained absence. Three sources, never collapsed.
 *   ③ AN EMPLOYEE WITH NO RECORD IS NEITHER A FULL MONTH OF LOSS OF PAY
 *      NOR A SILENT FULL MONTH OF PAY. The assumption is named.
 *   ④ AN APPROVED OR POSTED RUN IS NOT RE-READ UNDERNEATH ITSELF.
 *   ⑤ NO LOSS-OF-PAY FIGURE GOES THROUGH A FLOAT.
 *
 * ⚠️ THE ABSENCE ASSERTIONS READ COMMENT-STRIPPED SOURCE. Every file in
 * this batch argues at length about the thing it no longer does, so a
 * naive `toContain` would match the argument and pass for the wrong
 * reason. This repository has been fooled that way before; `codeOnly` is
 * the same helper `tests/ui/leave.test.ts` uses.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_WEEKLY_OFF_DAYS,
  expandApprovedLeave,
  foldRunLop,
  splitLopForPayslip,
  describeAssumption,
  type ApprovedLeaveFacts,
  type RegisterDayFacts,
} from "@/server/payroll/attendance-bridge";
import { summariseAttendance } from "@/lib/leave/attendance";
import { formatDays } from "@/lib/leave/days";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const BOARD = read("components/payroll/payroll-run-board.tsx");
const PANEL = read("components/payroll/lop-position.tsx");
const BRIDGE = read("server/payroll/attendance-bridge.ts");
const RUN = read("server/payroll/run.ts");
const ACTIONS = read("server/actions/payroll.ts");

const PERIOD = { start: "2025-12-01", end: "2025-12-31" } as const;

/** Everybody in these fixtures is on the rolls for the whole of December. */
const wholeMonth = (...ids: string[]) => new Map(ids.map((id) => [id, 31]));

/* ================================================================== */
/* ① THE HARDCODED EMPTY ARRAY IS GONE, ON BOTH SIDES                  */
/* ================================================================== */

describe("the hardcoded attendance: [] is gone", () => {
  /**
   * 🔴 THE ASSERTION IS OVER COMMENT-STRIPPED SOURCE. Both files quote
   * the literal in their headers to explain what they used to do, and a
   * plain search would match the explanation.
   */
  it("no longer appears anywhere in the run board's code", () => {
    const code = codeOnly(BOARD);
    expect(code).not.toMatch(/attendance:\s*\[\s*\]/);
    expect(code).not.toContain("attendance");
    /* And the header still explains it, so nobody re-adds it innocently. */
    expect(BOARD).toContain("attendance: []");
  });

  /**
   * ⚠️ AND THE FIX IS NOT "SEND THE RIGHT ARRAY INSTEAD". A `"use server"`
   * export is a public endpoint; a browser-supplied array of
   * `{employeeId, lopDays}` is a browser deciding what everybody is paid.
   * The compute endpoint takes a run id and nothing else.
   */
  it("is not replaced by a browser-supplied array", () => {
    const code = codeOnly(ACTIONS);
    const schema = code.slice(
      code.indexOf("const computeSchema"),
      code.indexOf("export async function computePayrollRun"),
    );
    expect(schema.length).toBeGreaterThan(0);
    expect(schema).not.toContain("attendance");
    expect(schema).not.toContain("lopDays");

    /* The board's own prop no longer carries it either. */
    expect(codeOnly(BOARD)).toMatch(/onCompute:\s*\(input:\s*\{\s*runId:\s*string\s*\}\)/);
  });

  it("is replaced by a read of the register inside the compute", () => {
    const code = codeOnly(RUN);
    expect(code).toContain("loadRunAttendance");
    /* 🔴 Inside `computeRun`, so it shares the payslip write's transaction. */
    const compute = code.slice(code.indexOf("export async function computeRun"));
    expect(compute.indexOf("loadRunAttendance")).toBeGreaterThan(-1);
    expect(compute).toContain("await loadRunAttendance(tx, {");
  });

  it("reads the staff register and the approved leave register, not the punch clock", () => {
    const code = codeOnly(BRIDGE);
    expect(code).toContain("staffAttendance");
    expect(code).toContain("leaveRequests");
    /* ⚠️ `site_attendance` is construction labour, paid on an RA bill. */
    expect(code).not.toContain("siteAttendance");
  });
});

/* ================================================================== */
/* ② PAID, UNPAID AND UNEXPLAINED ARE THREE DIFFERENT THINGS           */
/* ================================================================== */

describe("approved leave reaches the payslip according to whether it is paid", () => {
  const leaveRequest = (over: Partial<ApprovedLeaveFacts>): ApprovedLeaveFacts => ({
    employeeId: "a",
    fromOn: "2025-12-08",
    toOn: "2025-12-10",
    halfDayStart: false,
    halfDayEnd: false,
    isPaid: true,
    countsHolidaysAndOffs: true,
    typeCode: "EL",
    ...over,
  });

  const foldLeave = (requests: ApprovedLeaveFacts[], register: RegisterDayFacts[] = []) =>
    foldRunLop({
      payableDaysByEmployee: wholeMonth("a"),
      register,
      leaveDays: expandApprovedLeave({
        requests,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        holidays: [],
        workStateByEmployee: new Map(),
      }),
    });

  /**
   * 🔴 APPROVED PAID LEAVE COSTS NOTHING. Deducting it would charge an
   * employee for the leave they earned, which is the deduction that ends
   * up in front of a labour commissioner.
   */
  it("charges nothing for approved PAID leave", () => {
    const out = foldLeave([leaveRequest({ isPaid: true })]);
    expect(out.totalLopCentidays).toBe(0);
    expect(out.forCompute).toEqual([]);
    /* ⭐ But it is still SHOWN, so a short payslip is not blamed on it. */
    expect(out.rows[0]?.approvedPaidCentidays).toBe(300);
  });

  /**
   * 🔴 APPROVED UNPAID LEAVE MUST PRODUCE LOSS OF PAY EVEN WHERE NOBODY
   * ALSO TICKED AN ATTENDANCE GRID. Approving leave against a type whose
   * `is_paid` is false IS the decision that those days are not paid.
   */
  it("charges approved UNPAID leave that the register has no entry for", () => {
    const out = foldLeave([leaveRequest({ isPaid: false })]);
    expect(out.totalLopCentidays).toBe(300);
    expect(out.rows[0]?.approvedUnpaidCentidays).toBe(300);
    expect(out.rows[0]?.registerCentidays).toBe(0);
    expect(out.forCompute).toEqual([{ employeeId: "a", payableDays: 31, lopDays: 3 }]);
  });

  /**
   * ⭐ THE REGISTER IS THE VERDICT, AND THE PRECEDENCE IS PER DAY.
   *
   * ⚠️ AN EMPLOYEE-LEVEL RULE WOULD BE WRONG: a company that marks
   * attendance for the first week and then stops would have every
   * approved unpaid day afterwards silently paid in full.
   */
  it("does not charge a day twice when both sources describe it", () => {
    const out = foldLeave(
      [leaveRequest({ isPaid: false })],
      [
        {
          employeeId: "a",
          onDate: "2025-12-08",
          status: "unpaid_leave",
          lopFraction: "1.00",
          leaveTypeId: "lop-type",
        },
      ],
    );
    /* Three days applied for, one already ruled on: 1 + 2, never 3 + 3. */
    expect(out.totalLopCentidays).toBe(300);
    expect(out.rows[0]?.registerCentidays).toBe(100);
    expect(out.rows[0]?.approvedUnpaidCentidays).toBe(200);
    expect(out.rows[0]?.source).toBe("both");
  });

  /**
   * 🔴 AN UNEXPLAINED ABSENCE IS A FOURTH CASE AND IS NOT COLLAPSED INTO
   * APPROVED UNPAID LEAVE. Identical money, entirely different meaning:
   * one is a decision somebody made and the other is a person nobody has
   * heard from.
   */
  it("keeps an unexplained absence separate from an approved unpaid day", () => {
    const out = foldLeave(
      [leaveRequest({ isPaid: false, fromOn: "2025-12-15", toOn: "2025-12-15" })],
      [
        {
          employeeId: "a",
          onDate: "2025-12-08",
          status: "absent",
          lopFraction: "1.00",
          leaveTypeId: null,
        },
      ],
    );
    expect(out.rows[0]?.unregularisedCentidays).toBe(100);
    expect(out.rows[0]?.approvedUnpaidCentidays).toBe(100);
    expect(out.unregularisedEmployeeIds).toEqual(["a"]);
    /* Both cost money; the total is the sum and the reasons are not. */
    expect(out.totalLopCentidays).toBe(200);
  });

  /**
   * ⚠️ `absent` WITH A LEAVE TYPE AGAINST IT HAS BEEN REGULARISED. It
   * still costs the money; it is no longer a question.
   */
  it("does not call an absence unexplained once a leave type is on it", () => {
    const out = foldLeave(
      [],
      [
        {
          employeeId: "a",
          onDate: "2025-12-08",
          status: "absent",
          lopFraction: "1.00",
          leaveTypeId: "lop-type",
        },
      ],
    );
    expect(out.rows[0]?.unregularisedCentidays).toBe(0);
    expect(out.totalLopCentidays).toBe(100);
  });

  /**
   * ⚠️ ONLY `approved`. A `submitted` application has been decided by
   * nobody — charging it would let an employee dock their own pay by
   * applying — and `rejected` and `cancelled` never happened.
   */
  it("reads only approved applications", () => {
    const code = codeOnly(BRIDGE);
    expect(code).toContain('eq(leaveRequests.status, "approved")');
    expect(code).not.toContain('"submitted"');
    expect(code).not.toContain('"rejected"');
  });
});

/* ================================================================== */
/* ③ THE DAY COUNT FOLLOWS THE LEAVE TYPE'S OWN POLICY                 */
/* ================================================================== */

describe("expanding an application into days", () => {
  const base: ApprovedLeaveFacts = {
    employeeId: "a",
    /* 5 Dec 2025 is a Friday; 7 Dec is a Sunday. */
    fromOn: "2025-12-05",
    toOn: "2025-12-09",
    halfDayStart: false,
    halfDayEnd: false,
    isPaid: false,
    countsHolidaysAndOffs: false,
    typeCode: "CL",
    ...{},
  };

  const expand = (over: Partial<ApprovedLeaveFacts>, holidays: string[] = []) =>
    expandApprovedLeave({
      requests: [{ ...base, ...over }],
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      holidays: holidays.map((onDate) => ({ onDate, workStateCode: null })),
      workStateByEmployee: new Map(),
    });

  /**
   * 🔴 GETTING `counts_holidays_and_offs` BACKWARDS COSTS EVERY EMPLOYEE
   * WHO TAKES A LONG BLOCK EXACTLY TWO DAYS A WEEK, and the number looks
   * plausible the whole time. Loss of pay follows the same flag that
   * debited the balance, or the payroll figure and the leave register
   * stop agreeing.
   */
  it("skips a weekly off for a type that does not count them", () => {
    const days = expand({ countsHolidaysAndOffs: false });
    expect(days.map((d) => d.onDate)).toEqual([
      "2025-12-05",
      "2025-12-06",
      "2025-12-08",
      "2025-12-09",
    ]);
  });

  it("charges the whole block for a type that does count them", () => {
    expect(expand({ countsHolidaysAndOffs: true })).toHaveLength(5);
  });

  it("skips a declared holiday for a type that does not count them", () => {
    const days = expand({ countsHolidaysAndOffs: false }, ["2025-12-08"]);
    expect(days.map((d) => d.onDate)).not.toContain("2025-12-08");
  });

  /** ⭐ Sunday off is the default because the six-day week is normal here. */
  it("defaults the weekly off to Sunday alone", () => {
    expect([...DEFAULT_WEEKLY_OFF_DAYS]).toEqual([0]);
    /* ⚠️ And the duplicate in server/actions/leave.ts still agrees. */
    expect(codeOnly(read("server/actions/leave.ts"))).toContain(
      "const DEFAULT_WEEKLY_OFF_DAYS = [0] as const",
    );
  });

  it("takes a half day off the first chargeable day", () => {
    const days = expand({ halfDayStart: true, countsHolidaysAndOffs: true });
    expect(days[0]?.centidays).toBe(50);
    expect(days[1]?.centidays).toBe(100);
  });

  /**
   * ⚠️ A LEAVE THAT STRADDLES TWO MONTHS IS CHARGED TO THE MONTH THE DAYS
   * FALL IN, and its opening half day belongs to the month it started in.
   */
  it("clips an application to the period being run", () => {
    const days = expandApprovedLeave({
      requests: [
        {
          ...base,
          fromOn: "2025-11-28",
          toOn: "2025-12-02",
          halfDayStart: true,
          countsHolidaysAndOffs: true,
        },
      ],
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
      holidays: [],
      workStateByEmployee: new Map(),
    });
    expect(days.map((d) => d.onDate)).toEqual(["2025-12-01", "2025-12-02"]);
    /* The half day was in November; December gets two whole days. */
    expect(days.every((d) => d.centidays === 100)).toBe(true);
  });
});

/* ================================================================== */
/* ④ NO RECORD AT ALL — THE ASSUMPTION IS NAMED                        */
/* ================================================================== */

describe("an employee with nothing recorded", () => {
  const emptyMonth = foldRunLop({
    payableDaysByEmployee: wholeMonth("a", "b", "c"),
    register: [],
    leaveDays: [],
  });

  /**
   * 🔴 NOT A FULL MONTH OF LOSS OF PAY. Most salaried staff are never
   * marked present at all, and a blank register is a normal month — the
   * other default would pay nobody in a company that has not started
   * recording.
   */
  it("is not silently docked", () => {
    expect(emptyMonth.totalLopCentidays).toBe(0);
    expect(emptyMonth.forCompute).toEqual([]);
  });

  /**
   * 🔴 AND NOT A SILENT FULL MONTH OF PAY EITHER. Both defaults are
   * defensible; being unable to tell which one you got is not.
   */
  it("is counted, and the assumption is stated in words", () => {
    expect(emptyMonth.employeesAssumedFullMonth).toEqual(["a", "b", "c"]);
    expect(emptyMonth.assumption).toMatch(/assumption/i);
    expect(emptyMonth.assumption).toMatch(/full month/i);
  });

  it("says which people are covered when only some are", () => {
    const partial = foldRunLop({
      payableDaysByEmployee: wholeMonth("a", "b"),
      register: [
        {
          employeeId: "a",
          onDate: "2025-12-02",
          status: "present",
          lopFraction: "0.00",
          leaveTypeId: null,
        },
      ],
      leaveDays: [],
    });
    expect(partial.employeesAssumedFullMonth).toEqual(["b"]);
    expect(partial.assumption).toContain("1 of 2");
  });

  /** ⚠️ The sentence has to survive a run with nobody in it. */
  it("says something sensible for an empty run", () => {
    expect(
      describeAssumption({
        employeesInRun: 0,
        withRegister: 0,
        assumedFullMonth: 0,
        totalLopCentidays: 0,
      }),
    ).toMatch(/nobody/i);
  });

  /** ⭐ The assumption reaches the payslip too, not only the screen. */
  it("is written onto the payslip by computeRun", () => {
    const code = codeOnly(RUN);
    expect(code).toContain("withAttendanceStory");
    expect(RUN).toContain("on the assumption that nothing happened");
  });

  /**
   * ⭐ AN EMPLOYEE THE RUN DOES NOT COVER IS DROPPED, NOT GUESSED AT. It
   * means they left before the period or joined after it, and inventing a
   * `payableDays` for them would put a payslip in a run that `computeRun`
   * deliberately excluded.
   */
  it("drops attendance for somebody the run has no payslip for", () => {
    const out = foldRunLop({
      payableDaysByEmployee: new Map(),
      register: [
        {
          employeeId: "ghost",
          onDate: "2025-12-02",
          status: "absent",
          lopFraction: "1.00",
          leaveTypeId: null,
        },
      ],
      leaveDays: [],
    });
    expect(out.rows).toEqual([]);
    expect(out.totalLopCentidays).toBe(0);
  });
});

/* ================================================================== */
/* ⑤ NO FLOAT TOUCHES A LOSS-OF-PAY FIGURE                             */
/* ================================================================== */

describe("loss of pay is counted in centidays", () => {
  /**
   * ⚠️ 0.1 + 0.2 IS NOT 0.3. Three half days added as fractions of a day
   * produce a number nobody can read out to the person whose salary it
   * is; added as centidays they produce 150.
   */
  it("adds half days exactly", () => {
    const out = foldRunLop({
      payableDaysByEmployee: wholeMonth("a"),
      register: [10, 11, 12].map((d) => ({
        employeeId: "a",
        onDate: `2025-12-${d}`,
        status: "paid_leave",
        lopFraction: "0.50",
        leaveTypeId: "el",
      })),
      leaveDays: [],
    });
    expect(out.totalLopCentidays).toBe(150);
    expect(formatDays(out.totalLopCentidays)).toBe("1.50");
  });

  /**
   * 🔴🔴 THE PAYSLIP ENGINE CANNOT PRO-RATE A PART DAY — IT THROWS.
   * `lib/payroll/payslip.ts` does `BigInt(payableDays - lopDays)`, and
   * `BigInt(30.5)` is a `RangeError`, not a rounding. So the whole-day
   * part is charged and the remainder becomes a stated PROBLEM that
   * blocks approval, rather than being rounded into somebody's salary.
   */
  it("charges only whole days and never rounds the remainder away", () => {
    expect(splitLopForPayslip(150)).toEqual({ wholeDays: 1, remainderCentidays: 50 });
    expect(splitLopForPayslip(100)).toEqual({ wholeDays: 1, remainderCentidays: 0 });
    expect(splitLopForPayslip(25)).toEqual({ wholeDays: 0, remainderCentidays: 25 });
    expect(splitLopForPayslip(0)).toEqual({ wholeDays: 0, remainderCentidays: 0 });
    /* ⚠️ A negative can only be a bug upstream; it must not become a credit. */
    expect(splitLopForPayslip(-100)).toEqual({ wholeDays: 0, remainderCentidays: 0 });
  });

  it("hands the payslip engine an integer, always", () => {
    for (const centidays of [0, 25, 50, 99, 100, 150, 3100, 3199]) {
      expect(Number.isInteger(splitLopForPayslip(centidays).wholeDays)).toBe(true);
    }
  });

  it("reports the part day it could not charge, per person", () => {
    const out = foldRunLop({
      payableDaysByEmployee: wholeMonth("a"),
      register: [
        {
          employeeId: "a",
          onDate: "2025-12-10",
          status: "paid_leave",
          lopFraction: "0.50",
          leaveTypeId: "el",
        },
      ],
      leaveDays: [],
    });
    expect(out.fractionalEmployeeIds).toEqual(["a"]);
    expect(out.rows[0]?.unrepresentableCentidays).toBe(50);
    expect(out.rows[0]?.chargedLopDays).toBe(0);
    /* Nothing chargeable, so nothing is sent to the compute. */
    expect(out.forCompute).toEqual([]);
  });

  /** ⭐ And that difference is a PROBLEM on the payslip, which blocks approval. */
  it("turns the uncharged part day into a payslip problem, not a note", () => {
    const code = codeOnly(RUN);
    const story = code.slice(code.indexOf("function withAttendanceStory"));
    expect(story).toContain("problems.push(");
    expect(story).toMatch(/unrepresentableCentidays\s*>\s*0[\s\S]{0,80}problems\.push/);
    /*
     * 🔴 The totals are struck AFTER the story is added, or the problem
     * would print on the payslip and not block the approve button.
     */
    expect(code).toMatch(/withAttendanceStory[\s\S]{0,400}totalRun\(/);
  });

  /** ⚠️ No float parsing anywhere near a day figure in the bridge. */
  it("never parses a day figure as a float", () => {
    const code = codeOnly(BRIDGE);
    expect(code).not.toContain("parseFloat");
    expect(code).not.toMatch(/Number\(\s*\w*[lL]op/);
    /*
     * ⚠️ A CEILING, NOT A COUNT. One division by a hundred is the single
     * conversion out of centidays; fewer would be better and more is a
     * regression.
     */
    const divisions = code.match(/\/\s*CENTIDAYS_PER_DAY|\/\s*100\b/g) ?? [];
    expect(divisions.length).toBeLessThanOrEqual(1);
  });

  /**
   * ⭐ AND THE TWO FOLDS AGREE. `lib/leave/attendance.ts` computes the
   * register half for the leave module's own screen; this bridge computes
   * it in centidays for payroll. A drift between them is a payslip and a
   * leave register that disagree about the same month.
   */
  it("agrees with summariseAttendance on the register alone", () => {
    const register: RegisterDayFacts[] = [
      { employeeId: "a", onDate: "2025-12-15", status: "paid_leave", lopFraction: "0.50", leaveTypeId: "el" },
      { employeeId: "a", onDate: "2025-12-16", status: "absent", lopFraction: "1.00", leaveTypeId: null },
      { employeeId: "b", onDate: "2025-12-16", status: "present", lopFraction: "0.00", leaveTypeId: null },
    ];
    const mine = foldRunLop({
      payableDaysByEmployee: wholeMonth("a", "b"),
      register,
      leaveDays: [],
    });
    const theirs = summariseAttendance({
      days: register,
      payableDaysByEmployee: wholeMonth("a", "b"),
    });

    expect(mine.rows.map((r) => r.employeeId)).toEqual(theirs.rows.map((r) => r.employeeId));
    for (const row of theirs.rows) {
      const ours = mine.byEmployee.get(row.employeeId);
      expect(formatDays(ours?.totalLopCentidays ?? 0)).toBe(row.lopDays.toFixed(2));
    }
    expect(formatDays(mine.totalLopCentidays)).toBe(formatDays(theirs.totalLopCentidays));
  });
});

/* ================================================================== */
/* ⑥ NOBODY LOSES MORE PAY THAN THEY WERE OWED                         */
/* ================================================================== */

describe("the cap", () => {
  /**
   * ⚠️ OTHERWISE `paidDays()` CLAMPS A NEGATIVE TO ZERO and the payslip
   * says "0 of 31 days" with no explanation of where the extra came from.
   * A joiner on the 20th cannot lose 31 days.
   */
  it("caps loss of pay at the days the person was on the rolls", () => {
    const out = foldRunLop({
      payableDaysByEmployee: new Map([["a", 12]]),
      register: Array.from({ length: 20 }, (_, i) => ({
        employeeId: "a",
        onDate: `2025-12-${String(i + 1).padStart(2, "0")}`,
        status: "absent" as const,
        lopFraction: "1.00",
        leaveTypeId: null,
      })),
      leaveDays: [],
    });
    expect(out.rows[0]?.totalLopCentidays).toBe(1200);
    expect(out.rows[0]?.cappedAtPayableDays).toBe(true);
    expect(out.forCompute[0]?.lopDays).toBe(12);
  });

  /**
   * ⚠️ A FRACTION OUTSIDE 0..1 IS CLAMPED, NOT TRUSTED. The CHECK keeps
   * the column honest; this fold is also reached from a CSV import. A
   * fraction of 8 would dock somebody eight days for one Tuesday.
   */
  it("clamps a nonsense fraction on a single day", () => {
    const out = foldRunLop({
      payableDaysByEmployee: wholeMonth("a"),
      register: [
        {
          employeeId: "a",
          onDate: "2025-12-02",
          status: "absent",
          lopFraction: "8",
          leaveTypeId: null,
        },
      ],
      leaveDays: [],
    });
    expect(out.rows[0]?.totalLopCentidays).toBe(100);
  });
});

/* ================================================================== */
/* ⑦ AN APPROVED RUN IS NOT RE-READ UNDERNEATH ITSELF                  */
/* ================================================================== */

describe("a run that has been signed", () => {
  /**
   * 🔴 APPROVAL FREEZES THE PAYSLIPS — the database refuses a change to
   * any of them. A screen that went back to `staff_attendance` afterwards
   * would show the CURRENT register beside a FROZEN wage bill, and
   * somebody reconciling a payslip would be reading a figure nobody was
   * ever paid.
   */
  it("shows what it charged, read from its own payslips", () => {
    const code = codeOnly(ACTIONS);
    const fn = code.slice(
      code.indexOf("export async function getPayrollLopPosition"),
      code.indexOf("const approveSchema"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/const live =\s*status === "draft" \|\| status === "computed"/);
    /* The frozen branch reads payslips and returns before any register read. */
    const frozen = fn.slice(fn.indexOf("if (!live)"), fn.indexOf("loadRunAttendance"));
    expect(frozen).toContain(".from(payslips)");
    expect(frozen).not.toContain("loadRunAttendance");
  });

  /** ⚠️ And the compute itself still refuses to touch an approved run. */
  it("cannot be recomputed", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toMatch(
      /run\.status !== "draft" && run\.status !== "computed"/,
    );
    expect(ACTIONS).toContain("This run has been approved");
  });

  /** ⭐ The panel says which of the two numbers the reader is looking at. */
  it("is labelled on the screen so the reader knows which number it is", () => {
    expect(PANEL).toContain("as charged");
    expect(PANEL).toContain("from the register now");
  });
});

/* ================================================================== */
/* ⑧ THE POSITION IS VISIBLE BEFORE THE SIGNATURE                      */
/* ================================================================== */

describe("the loss-of-pay review", () => {
  /**
   * 🔴 A DEDUCTION FOUND ON A PAYSLIP HAS ALREADY BEEN PAID. The whole
   * point of this panel is that it sits above the approve button.
   */
  it("is rendered by the run board", () => {
    const code = codeOnly(BOARD);
    expect(code).toContain("LopPositionPanel");
    expect(code).toContain('from "@/components/payroll/lop-position"');
  });

  /**
   * ⚠️ UNCONDITIONALLY. A panel that appears only when there is something
   * to see teaches the reader that its absence means nothing happened —
   * and the state this batch exists to make visible is exactly the one
   * where nothing was recorded and everybody was quietly paid in full.
   */
  it("is rendered whether or not anybody is losing pay", () => {
    const code = codeOnly(BOARD);
    expect(code).toMatch(/<LopPositionPanel\s+runId=\{run\.id\}/);
    expect(code).not.toMatch(/\?\s*<LopPositionPanel/);
    expect(code).not.toMatch(/&&\s*<LopPositionPanel/);
  });

  /** ⭐ It appears before the money, like the problems above it. */
  it("comes before the totals", () => {
    const code = codeOnly(BOARD);
    expect(code.indexOf("<LopPositionPanel")).toBeLessThan(code.indexOf("Gross earnings"));
  });

  /** ⭐ And there is something to DO about it, not only something to read. */
  it("points at the register that has to be corrected", () => {
    expect(PANEL).toContain('href="/payroll/leave"');
    expect(PANEL).toContain("recompute");
  });

  /**
   * ⚠️ THE ACTION IT CALLS IS GUARDED IN ONE HOP, like every other export
   * of a `"use server"` module.
   */
  it("is served by a guarded action", () => {
    const code = codeOnly(ACTIONS);
    expect(code).toMatch(
      /export async function getPayrollLopPosition[\s\S]{0,1500}?requirePermission\(READ\)/,
    );
  });

  /** ⭐ Every source is named separately; they are never summed into one word. */
  it("names where each person's loss of pay came from", () => {
    expect(PANEL).toContain("from the attendance register");
    expect(PANEL).toContain("from approved unpaid leave");
    expect(PANEL).toContain("marked absent with no reason given");
    expect(PANEL).toContain("approved PAID leave, which costs nothing");
  });
});
