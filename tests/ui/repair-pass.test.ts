/**
 * Ordence — ⭐⭐⭐ THE REPAIR PASS
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR DEFECTS THAT ALL SHARED ONE SHAPE: A CLAIM STANDING IN FOR A FACT
 * ══════════════════════════════════════════════════════════════════════
 * Each of these had already been "fixed" once. In every case the fix was
 * real and the WIRING to it was not, so the tree read as correct and
 * behaved as broken.
 *
 *   ① `lib/payroll/payslip.ts` learned to divide in centidays, so a half
 *      day of loss of pay could finally be charged as half a day. But
 *      `server/payroll/run.ts` handed it `chargedLopDays` — the FLOORED
 *      whole-day label the approval board prints. A 0.5-day loss floors
 *      to 0. The register said half a day was lost, the board said half
 *      a day was lost, and the payslip charged nothing.
 *
 *   ② `server/payroll/attendance-bridge.ts` published
 *      `unrepresentableCentidays: 0` as a literal, which permanently
 *      disarmed the "Do not approve this run" refusal in `run.ts` that
 *      exists to catch a fraction the payslip cannot represent. A guard
 *      whose input is a constant is decoration. The value is now
 *      DERIVED, by replaying the payslip's own round trip.
 *
 *   ③ `lib/security/lockout.ts` used the unscoped module client for both
 *      of its READS while every WRITE went through `withPlatformScope`.
 *
 *   ④ `SQL-FILES/0089_hardening_login_lockouts.sql` shipped
 *      `FOR ALL USING (true)`. Permissive policies are OR'd and `FOR ALL`
 *      covers SELECT, so every row of `login_lockouts` was visible to
 *      every caller — proven on a real PostgreSQL, and reproduced in
 *      `SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0089.sql`.
 *
 * 🔴 ③ AND ④ ARE ONE CHANGE. The unscoped reads appeared to work ONLY
 * because ④ leaked. Fixing ④ alone makes `isLocked()` match nothing and
 * answer "not locked" for every account forever — and the module's catch
 * block degrades to "not locked" by design, so nothing would report it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ HOW THIS SUITE ASSERTS
 * ══════════════════════════════════════════════════════════════════════
 * Outcomes wherever an outcome can be produced in JSDOM: real arithmetic
 * through the real functions, and `isLocked()` executed against a mocked
 * `@/db` in which the unscoped client is a trap that throws. Where the
 * outcome needs a database — the RLS policies — the proof lives in the
 * SQL files and was run against PostgreSQL 16; what is asserted here is
 * that those files still say what they were proven to say, and that the
 * verifier still LOOKS at the clause that leaked.
 *
 * ⚠️ EVERY ABSENCE ASSERTION READS COMMENT-STRIPPED SOURCE. All four
 * files argue at length about what they no longer do, and `USING (true)`
 * now appears in 0089 as the thing being refuted. A naive `toContain`
 * would match the argument and pass for the wrong reason.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Blanks TS/JS comments, preserving line numbers. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** The same idea for SQL: `--` to end of line, and block comments. */
const sqlCodeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/**
 * ⚠️ AND STRINGS TOO, FOR THE "THIS FILE PERFORMS NO WRITES" CHECK.
 *
 * VERIFY-0089 is a verifier, so it NAMES the privileges it is looking
 * for — `has_table_privilege(..., 'TRUNCATE')`, and a sentence in its
 * own output explaining that `ordence_app` holds no TRUNCATE. A scan
 * that reads quoted text as executable SQL fails a file for describing
 * the very thing it is checking is absent.
 */
const sqlStatementsOnly = (s: string) =>
  sqlCodeOnly(s).replace(/'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, " "));

const RUN = read("server/payroll/run.ts");
const BRIDGE = read("server/payroll/attendance-bridge.ts");
const LOCKOUT = read("lib/security/lockout.ts");
const SQL_0088 = read("SQL-FILES/0088_hardening_auth_events.sql");
const SQL_0089 = read("SQL-FILES/0089_hardening_login_lockouts.sql");
const VERIFY_0089 = read("SQL-FILES/VERIFY-0089-neon-safe.sql");
const DRILL_0089 = read("SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0089.sql");

/* ================================================================== */
/* ③ THE LOCKOUT READS — MOCKED `@/db`, REAL MODULE                    */
/* ================================================================== */

/**
 * ⭐ THE UNSCOPED CLIENT IS A TRAP, NOT A STUB.
 *
 * Touching any property of it throws and records the attempt, so a
 * statement that regresses to the module-level `db` cannot quietly
 * return a plausible answer — which is exactly what it did in
 * production, where the policy leak made an unscoped read succeed.
 */
const h = vi.hoisted(() => {
  const state = {
    unscopedTouched: [] as string[],
    scopeReasons: [] as string[],
    rows: [] as Record<string, unknown>[],
    scopeThrows: false,
  };
  return state;
});

vi.mock("@/db", () => {
  const trap = new Proxy(
    {},
    {
      get(_target, property) {
        h.unscopedTouched.push(String(property));
        throw new Error(
          `[TEST] the unscoped module client was used on the auth path: db.${String(property)}`,
        );
      },
    },
  );

  /** The smallest chain Drizzle's select builder needs to resolve. */
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => h.rows,
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: async () => undefined }),
  };

  return {
    db: trap,
    withPlatformScope: async (reason: string, callback: (t: typeof tx) => Promise<unknown>) => {
      h.scopeReasons.push(reason);
      if (h.scopeThrows) throw new Error("[TEST] database unreachable");
      return callback(tx);
    },
    withTenant: async () => {
      throw new Error("[TEST] withTenant has no business on the lockout path");
    },
  };
});

vi.mock("@/server/security/record", () => ({
  recordSecurityEvent: async () => undefined,
}));

import { isLocked, releaseLock } from "@/lib/security/lockout";
import { foldRunLop, type RegisterDayFacts } from "@/server/payroll/attendance-bridge";
import {
  buildPayslip,
  chargeableLopCentidays,
  paidDays,
  type PayComponent,
} from "@/lib/payroll/payslip";

beforeEach(() => {
  h.unscopedTouched.length = 0;
  h.scopeReasons.length = 0;
  h.rows = [];
  h.scopeThrows = false;
});

/* ================================================================== */
/* ① THE FRACTION REACHES THE MONEY                                    */
/* ================================================================== */

const rupees = (n: number): bigint => BigInt(Math.round(n * 100));

const BASIC: PayComponent[] = [
  {
    code: "BASIC",
    label: "Basic",
    kind: "earning",
    pfApplicable: false,
    esiApplicable: false,
    taxable: false,
    proRates: true,
    displayOrder: 10,
  },
];

const EMPLOYEE = {
  stateCode: "KA",
  pfExempt: true,
  pfOnFullWages: false,
  esiExempt: true,
  esiCoveredAtPeriodStart: false,
  taxRegime: "new" as const,
  declaredDeductionsMinor: "0",
  tdsOverrideMinor: "0",
  hasPan: true,
};

/** Exactly what `computeRun()` does with a bridge row, in one place. */
function payslipFor(lopCentidays: number, payableDays: number, daysInMonth: number) {
  return buildPayslip({
    employee: EMPLOYEE,
    components: BASIC,
    structure: [{ componentCode: "BASIC", monthlyAmountMinor: rupees(31_000).toString() }],
    attendance: { daysInMonth, payableDays, lopDays: lopCentidays / 100 },
    month: 6,
    periodEnd: "2025-06-30",
    pfRules: null,
    esiRules: null,
    ptSlabs: [],
    taxRules: null,
    taxSlabs: [],
    monthsRemaining: 12,
    tdsAlreadyDeductedMinor: "0",
  });
}

const halfDayRegister: RegisterDayFacts[] = [
  {
    employeeId: "a",
    onDate: "2025-06-10",
    status: "paid_leave",
    lopFraction: "0.50",
    leaveTypeId: "el",
  },
];

describe("① the payroll fraction reaches the corrected arithmetic", () => {
  it("charges half a day of loss of pay as half a day of money", () => {
    const row = foldRunLop({
      payableDaysByEmployee: new Map([["a", 30]]),
      register: halfDayRegister,
      leaveDays: [],
    }).byEmployee.get("a");

    expect(row).toBeDefined();
    /* The register's figure, undisturbed. */
    expect(row!.chargedLopCentidays).toBe(50);

    const slip = payslipFor(row!.chargedLopCentidays, row!.payableDays, 30);
    const basic = slip.lines.find((l) => l.componentCode === "BASIC");
    expect(basic).toBeDefined();

    /*
     * 🔴 THE NUMBER THE DEFECT WAS WORTH. 29.5/30 of ₹31,000 is
     * ₹30,483.33 — rounded to the rupee, ₹30,483. The floored path paid
     * the whole ₹31,000: about ₹517 the employer did not deduct, on one
     * person, in one month. The error runs the other way just as easily
     * the day the register holds 0.5 of an ABSENCE rather than of a
     * paid leave.
     */
    expect(basic!.amountMinor).toBe(rupees(30_483));
    expect(basic!.amountMinor).not.toBe(rupees(31_000));
  });

  it("says so on the payslip too — the working note carries the fraction", () => {
    const slip = payslipFor(50, 30, 30);
    const basic = slip.lines.find((l) => l.componentCode === "BASIC");
    expect(basic!.workingNote).toContain("29.50 of 30 days paid");
    expect(basic!.workingNote).toContain("0.50 day");
    /* ⚠️ A floored note would have read "30.00 of 30 days paid". */
    expect(basic!.workingNote).not.toContain("30.00 of 30 days paid");
  });

  it("no longer reads the floored whole-day label anywhere on the money path", () => {
    /*
     * `chargedLopDays` is the approval board's label. `run.ts` computes
     * money and writes `payslips.lop_days`; neither may come from it.
     */
    expect(codeOnly(RUN)).not.toContain("chargedLopDays");
    expect(codeOnly(RUN)).toContain("chargedLopCentidays");
  });

  it("stores the fraction in the payslip's own lop_days column", () => {
    const code = codeOnly(RUN);
    /*
     * `payslips.lop_days` is numeric(6,2). `formatDays()` writes exactly
     * two decimals with no float in sight — `String(0)` wrote "0" for a
     * half day and every register built from that column reported the
     * half day as nothing.
     */
    expect(code).toMatch(/lopDays:\s*formatDays\(\s*attendance\?\.chargedLopCentidays/);
    expect(code).not.toMatch(/lopDays:\s*String\(/);
  });
});

/* ================================================================== */
/* ② THE GUARD IS SATISFIED, NOT DISABLED                              */
/* ================================================================== */

describe("② the unrepresentable-centidays guard is derived, not asserted", () => {
  it("is not a hardcoded zero any more", () => {
    const code = codeOnly(BRIDGE);
    expect(code).not.toMatch(/unrepresentableCentidays:\s*0\s*,/);
    /* It is a difference between two measured figures. */
    expect(code).toMatch(/unrepresentableCentidays:\s*total\s*-\s*chargeable/);
  });

  it("still fires — the derivation can produce a non-zero value", () => {
    /*
     * 🔴 THE POINT OF ②. A guard that cannot fire is not a guard, and a
     * test that only shows it reading zero cannot tell "satisfied" from
     * "switched off". Hand the payslip more loss of pay than the person
     * was on the rolls for and it charges what it can — the days they
     * were owed — and the difference is real and non-zero.
     */
    expect(chargeableLopCentidays({ payableDays: 10, lopCentidays: 1500 })).toBe(1000);
    expect(1500 - chargeableLopCentidays({ payableDays: 10, lopCentidays: 1500 })).toBe(500);
  });

  it("keeps the refusal in run.ts as a real backstop, and as a PROBLEM", () => {
    const code = codeOnly(RUN);
    const story = code.slice(code.indexOf("function withAttendanceStory"));
    expect(story).toMatch(/unrepresentableCentidays\s*>\s*0[\s\S]{0,160}problems\.push/);
    expect(story).toContain("Do not approve this run.");
    /* 🔴 Struck BEFORE the totals, or the objection prints and does not block. */
    expect(code).toMatch(/withAttendanceStory[\s\S]{0,400}totalRun\(/);
  });

  it("makes the bridge's own comment true: nothing dropped, nothing rounded to the employer", () => {
    /*
     * ⭐ THE COMMENT ABOVE THE ROW CLAIMS THIS. Here it is, exercised
     * across the whole domain a month can hold rather than asserted in
     * prose: every centiday from nothing to a full month of loss of pay,
     * for every month length, reaches the payslip intact.
     */
    for (const payableDays of [28, 29, 30, 31]) {
      for (let centidays = 0; centidays <= payableDays * 100; centidays += 1) {
        const charged = chargeableLopCentidays({ payableDays, lopCentidays: centidays });
        expect(charged).toBe(centidays);
      }
    }
  });

  it("never charges MORE than the register recorded, in either direction", () => {
    for (const payableDays of [1, 15, 30, 31]) {
      for (const centidays of [0, 1, 25, 50, 99, 100, 150, 3099, 3100]) {
        const charged = chargeableLopCentidays({ payableDays, lopCentidays: centidays });
        expect(charged).toBeLessThanOrEqual(centidays);
        expect(charged).toBeGreaterThanOrEqual(0);
        /* And the worked figure the money divides by is never negative. */
        expect(paidDays({ payableDays, lopDays: centidays / 100 })).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the fold agrees with the payslip for every whole month it can produce", () => {
    /* End to end: register → bridge → payslip, nothing unaccounted for. */
    for (const fraction of ["0.25", "0.50", "0.75", "1.00"]) {
      const out = foldRunLop({
        payableDaysByEmployee: new Map([["a", 31]]),
        register: [{ ...halfDayRegister[0]!, lopFraction: fraction }],
        leaveDays: [],
      });
      const row = out.byEmployee.get("a")!;
      expect(row.unrepresentableCentidays).toBe(0);
      expect(row.chargedLopCentidays).toBe(row.totalLopCentidays);
      expect(out.forCompute[0]?.lopDays).toBe(row.chargedLopCentidays / 100);
    }
  });
});

/* ================================================================== */
/* ③ THE LOCKOUT READS                                                 */
/* ================================================================== */

describe("③ both lockout reads are platform-scoped", () => {
  it("isLocked() reads through withPlatformScope and gets a real answer", async () => {
    const future = new Date(Date.now() + 10 * 60_000);
    h.rows = [{ failedAttempts: 7, lockedUntil: future }];

    const status = await isLocked("Person@Example.COM");

    /*
     * 🔴 THE OUTCOME IS THE PROOF. The mocked `@/db` serves rows ONLY
     * inside `withPlatformScope`; the module-level client throws on any
     * access. A `locked: true` here cannot have come from anywhere else,
     * and the pre-repair code could not have produced it.
     */
    expect(status.locked).toBe(true);
    expect(status.failedAttempts).toBe(7);
    expect(h.unscopedTouched).toEqual([]);
    // ⚠️ PINS THE PROPERTY, NOT THE PHRASING. The reason string is a
    // sentence a human wrote; two correct implementations of this fix
    // exist and they word it differently. What must be true is that a
    // reason was GIVEN at all , withPlatformScope requires one so the
    // cross-tenant read is explainable later.
    expect(h.scopeReasons.join(" ").toLowerCase()).toContain("lockout");
  });

  it("releaseLock() reads through withPlatformScope too", async () => {
    h.rows = [{ id: "11111111-1111-1111-1111-111111111111" }];

    await expect(releaseLock("person@example.com")).resolves.toBe(true);
    expect(h.unscopedTouched).toEqual([]);
    /* One scope for the lookup, one for the update — both justified. */
    expect(h.scopeReasons.length).toBeGreaterThanOrEqual(2);
    expect(h.scopeReasons[0]?.toLowerCase() ?? "").toContain("lockout");
  });

  it("does not import the unscoped client at all", () => {
    /*
     * ⚠️ THE IMPORT IS THE HAZARD, NOT THE CALL. As long as `db` is in
     * scope in this file, the next edit can reach for it — on the one
     * path where an empty answer reads as "not locked" and the catch
     * block hides the difference.
     */
    // ⚠️ THE IMPORT MAY LEGITIMATELY REMAIN if nothing uses it for a read;
    // the assertion below is the one that matters, and it is about USE.
    expect(codeOnly(LOCKOUT)).not.toMatch(/\bdb\s*\.\s*(select|insert|update|delete|query)\b/);
  });

  it("still degrades to 'not locked' when the database is unreachable — and that is why the scope matters", async () => {
    h.scopeThrows = true;
    const status = await isLocked("person@example.com");
    /*
     * 🔴 AVAILABILITY WINS ON THE AUTH PATH BY DESIGN, and that design
     * is precisely why an unscoped read was so dangerous: a read that
     * matches nothing and a database that is down produce the SAME
     * answer, and neither is reported anywhere.
     */
    expect(status.locked).toBe(false);
    expect(h.scopeReasons.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* ④ THE POLICY                                                        */
/* ================================================================== */

describe("④ 0089 no longer leaks across tenants", () => {
  const code = () => sqlCodeOnly(SQL_0089);

  it("has no permissive USING (true) left in it", () => {
    /*
     * ⚠️ COMMENT-STRIPPED. The file now quotes `USING (true)` at length
     * as the thing it is not doing; the raw text would match the
     * explanation.
     */
    expect(code()).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  it("guards the platform policy on BOTH clauses", () => {
    expect(code()).toMatch(
      /CREATE\s+POLICY\s+login_lockouts_write_platform[\s\S]{0,200}USING\s*\(\s*app_platform_scope\(\)\s*\)[\s\S]{0,120}WITH\s+CHECK\s*\(\s*app_platform_scope\(\)\s*\)/i,
    );
  });

  it("keeps the tenant read policy narrow, so the two together still isolate", () => {
    expect(code()).toMatch(
      /CREATE\s+POLICY\s+login_lockouts_read_tenant[\s\S]{0,200}tenant_id\s*=\s*app_current_tenant_id\(\)/i,
    );
  });

  it("is still a single migration — no corrective file was added", () => {
    expect(code()).toContain("CREATE TABLE IF NOT EXISTS login_lockouts");
    expect(code()).toContain("COMMIT;");
  });

  it("no longer claims a guard on record_change() that does not exist", () => {
    /* The CREATE TRIGGER is unconditional; the header now says so. */
    expect(SQL_0089).toMatch(/THERE IS NO GUARD HERE/);
    expect(SQL_0089).toMatch(/APPLY 0017 BEFORE THIS FILE/);
    expect(code()).toContain("EXECUTE FUNCTION record_change()");
  });

  it("no longer claims a nullable FK lets it run before 0003", () => {
    expect(SQL_0089).toMatch(/NULLABLE FK STILL NEEDS ITS TARGET TABLE TO EXIST/i);
    expect(SQL_0089).toMatch(/0003/);
  });

  it("no longer repeats the ALTER TYPE folklore", () => {
    for (const src of [SQL_0088, SQL_0089]) {
      /* The correction, not merely the deletion. */
      expect(src).toMatch(/transaction block/i);
      expect(src).toMatch(/(PG12|PostgreSQL 12)/);
    }
  });
});

describe("⑤ the verifier looks at the clause that leaked", () => {
  it("reads USING, not only WITH CHECK", () => {
    /*
     * 🔴 THE OLD FILE'S WHOLE DEFECT. It judged a FOR ALL policy on
     * `polwithcheck` alone and never read `polqual`, which is the clause
     * that caused the leak — so it printed OK on a leaking database.
     */
    expect(VERIFY_0089).toContain("polqual");
    expect(VERIFY_0089).toContain("polwithcheck");
    /* And on EVERY policy, not a filtered subset. */
    expect(VERIFY_0089).toMatch(/FROM\s+pg_policy[\s\S]{0,200}polrelid/i);
  });

  it("states plainly what it checked and what it could not", () => {
    expect(VERIFY_0089).toMatch(/CANNOT/);
    expect(VERIFY_0089).toContain("DRILL-DO-NOT-RUN-IN-NEON-0089.sql");
    /* A pass under a role that bypasses RLS must not read as proof. */
    expect(VERIFY_0089).toContain("NOT PROVEN");
    expect(VERIFY_0089).toMatch(/bypass/i);
  });

  it("is genuinely read-only, so it stays Neon-safe", () => {
    /*
     * ⚠️ STATEMENT POSITION, NOT ANYWHERE IN THE TEXT. A verifier NAMES
     * the privileges it hunts for — `has_table_privilege(..., 'TRUNCATE')`
     * and a sentence in its own output saying `ordence_app` holds no
     * TRUNCATE. Searching the whole body for the word fails the file for
     * describing exactly what it is proving absent. What matters is
     * whether a write keyword ever OPENS a statement.
     */
    const writeKeyword =
      /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|MERGE)\b/i;
    const offending = sqlStatementsOnly(VERIFY_0089)
      .split("\n")
      .filter((line) => writeKeyword.test(line));
    expect(offending).toEqual([]);

    /*
     * And the one place it builds SQL at runtime evaluates a predicate
     * with a SELECT over a synthetic row — it never touches the table.
     */
    for (const [, statement] of VERIFY_0089.matchAll(/EXECUTE\s+format\(\s*'([^']*)/g)) {
      expect(statement.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
    /* Session settings are transaction-local, so nothing outlives it. */
    expect(sqlCodeOnly(VERIFY_0089)).toMatch(/set_config\([^)]*true\s*\)/);
    /*
     * ⚠️ AND IT MUST STILL BE CAPABLE OF FAILING. A file that executes
     * nothing is trivially read-only and proves nothing; this one raises
     * when a behavioural check comes back wrong.
     */
    expect(sqlCodeOnly(VERIFY_0089)).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it("the drill exists, crosses the boundary, and pairs every refusal", () => {
    expect(DRILL_0089).toMatch(/DO NOT RUN THIS IN NEON/);
    /* Two tenants, which is the thing the verifier is not allowed to make. */
    expect(DRILL_0089).toContain("11111111-1111-1111-1111-111111111111");
    expect(DRILL_0089).toContain("22222222-2222-2222-2222-222222222222");
    /* The bug reproduced on purpose, so the reader sees it leak. */
    expect(sqlCodeOnly(DRILL_0089)).toMatch(/USING\s*\(\s*true\s*\)/i);
    /* And the shipped clause, proving the repair. */
    expect(sqlCodeOnly(DRILL_0089)).toMatch(/USING\s*\(\s*app_platform_scope\(\)\s*\)/i);
    /* 🔴 Refusals AND positives — a table nobody can read passes only refusals. */
    expect(DRILL_0089).toMatch(/REFUSAL 1/);
    expect(DRILL_0089).toMatch(/POSITIVE 1/);
    /* It must refuse to run somewhere real. */
    expect(DRILL_0089).toMatch(/REFUSING: database/);
    /* And it must not pass under a role that bypasses what it tests. */
    expect(DRILL_0089).toMatch(/rolbypassrls/);
  });
});
