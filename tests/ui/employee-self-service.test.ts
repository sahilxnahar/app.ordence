/**
 * Ordence — ⭐⭐⭐ BATCH 107: AN EMPLOYEE SEES THEIR OWN PAYSLIP, AND
 *                 NOBODY ELSE'S
 * Version: v1.43.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS SUITE IS MOSTLY ASSERTIONS ABOUT ABSENCE
 * ══════════════════════════════════════════════════════════════════════
 * The thing that can go wrong here does not throw, does not fail to
 * compile and does not look different on screen. If the employee
 * predicate is dropped from the query in `payroll-self.ts`, the page
 * renders — with everybody's salaries on it. If an `employeeId`
 * parameter is added "temporarily" so HR can use the same screen, the
 * endpoint becomes a URL that returns any colleague's net pay to anybody
 * who can sign in.
 *
 * ⚠️ AND RLS CANNOT CATCH EITHER OF THEM. Row-level security in Ordence
 * scopes by TENANT. Every colleague's payslip is in the same tenant, so
 * the policy is satisfied by the leaking query exactly as it is by the
 * correct one. The security suite — which proves RLS holds against a
 * real Postgres — would stay green through both faults.
 *
 * ⭐ SO THE INVARIANTS ARE ASSERTED AGAINST THE SOURCE, AND AGAINST
 * COMMENT-STRIPPED SOURCE WHERE THE CLAIM IS "THIS DOES NOT APPEAR".
 * The header of `payroll-self.ts` discusses `employeeId` at length,
 * precisely to explain why the code never takes one; a naive `.toContain`
 * would be satisfied by the warning about the mistake.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ACTION_PATH = "server/actions/payroll-self.ts";
const PAGE_PATH = "app/(crm)/payroll/me/page.tsx";
const BOARD_PATH = "components/payroll/my-payslips.tsx";
const CAVEATS_PATH = "components/payroll/payslip-caveats.tsx";

const ACTION = read(ACTION_PATH);
const PAGE = read(PAGE_PATH);
const BOARD = read(BOARD_PATH);
const CAVEATS = read(CAVEATS_PATH);

/** Blanks comments while preserving line count — see `order-create.test.ts`. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const ACTION_CODE = codeOnly(ACTION);
const PAGE_CODE = codeOnly(PAGE);
const BOARD_CODE = codeOnly(BOARD);

/* ================================================================== */
/* ① THE SCREEN EXISTS AND IS WIRED                                    */
/* ================================================================== */

describe("the employee self-service screen", () => {
  it("exists", () => {
    for (const p of [ACTION_PATH, PAGE_PATH, BOARD_PATH, CAVEATS_PATH]) {
      expect(existsSync(join(ROOT, p))).toBe(true);
    }
  });

  it("the page calls the self-service read and renders the board", () => {
    expect(PAGE_CODE).toContain("myPayslips");
    expect(PAGE_CODE).toContain("MyPayslips");
    expect(PAGE_CODE).toContain('from "@/server/actions/payroll-self"');
  });

  /**
   * ⚠️ THE PAGE TAKES NOTHING FROM THE REQUEST. `params` and
   * `searchParams` are both values the browser supplies, and on this
   * screen the only value that matters is who is asking.
   */
  it("the page reads no params and no searchParams", () => {
    expect(PAGE_CODE).not.toMatch(/\bsearchParams\b/);
    expect(PAGE_CODE).not.toMatch(/\bparams\b/);
  });
});

/* ================================================================== */
/* ② 🔴 THE SCOPE — THE POINT OF THE WHOLE BATCH                       */
/* ================================================================== */

describe("🔴 a payslip is scoped to its own employee, explicitly", () => {
  /**
   * 🔴 THE CENTRAL ASSERTION. The employee id is DERIVED from the
   * session's user, by asking which employee rows point at this user —
   * never by trusting an id the caller supplied.
   */
  it("derives the employee from the session user, not from an argument", () => {
    expect(ACTION_CODE).toContain("requireTenantContext");
    expect(ACTION_CODE).toContain("eq(employees.userId, ctx.user.id)");
  });

  /**
   * 🔴 NO EXPORT TAKES AN ARGUMENT AT ALL. Not an employee id, not a
   * payslip id, not a filter. A function with no parameter cannot be
   * handed somebody else's id by any edit that does not first change its
   * signature — which is a change a reviewer sees.
   */
  it("exports only zero-argument functions", () => {
    const exports = [...ACTION_CODE.matchAll(/^export async function (\w+)\(([^)]*)\)/gm)];
    expect(exports.length).toBeGreaterThan(0);
    for (const [, name, args] of exports) {
      expect(`${name}(${args.trim()})`).toBe(`${name}()`);
    }
  });

  /**
   * 🔴 AND THE IDENTIFIER NEVER APPEARS AS AN INPUT ANYWHERE IN THE
   * MODULE'S CODE. Asserted on comment-stripped source because the
   * header argues about `employeeId` at length in order to explain why
   * the code has none.
   */
  it("never accepts an employee id or a payslip id from the caller", () => {
    expect(ACTION_CODE).not.toMatch(/employeeId\s*[:?]\s*(string|z\.)/);
    expect(ACTION_CODE).not.toMatch(/payslipId/);
    expect(ACTION_CODE).not.toMatch(/\bz\.string\(\)\.uuid\(\)/);
    // ⚠️ Nothing is parsed from an `input` at all, because nothing is passed.
    expect(ACTION_CODE).not.toMatch(/\bsafeParse\b/);
  });

  /**
   * 🔴 THE PREDICATE IS IN THE QUERY, TWICE — once for the payslips
   * that are shown and once for the count of those that are not. Both
   * are scoped; a shared query builder that one branch mutates is how
   * the second one loses its filter.
   */
  it("scopes every payslip query by the derived employee ids", () => {
    const scoped = [...ACTION_CODE.matchAll(/inArray\(payslips\.employeeId, mine\)/g)];
    expect(scoped.length).toBe(2);
    // Both queries also keep the tenant predicate, as every other read does.
    expect([...ACTION_CODE.matchAll(/eq\(payslips\.tenantId, ctx\.tenant\.id\)/g)].length).toBe(2);
  });

  /**
   * ⚠️ RLS IS NOT THE CONTROL, AND THE FILE HAS TO SAY SO. A future
   * reader who assumes the tenant policy covers this will delete the
   * predicate above as redundant. The explanation is load-bearing, so
   * its absence is a test failure.
   */
  it("says in the source that row-level security does not scope this", () => {
    expect(ACTION).toMatch(/row-level security|RLS/i);
    expect(ACTION).toMatch(/tenant/i);
  });

  /**
   * ⚠️ THE ONE ENDPOINT DOES NOT WIDEN FOR A PRIVILEGED CALLER. It
   * REPORTS the privilege so the page can offer a link; it never
   * branches the query on it. A `payroll.read` branch inside this file
   * would put the narrow path one boolean away from the wide one.
   */
  it("reports the payroll permission without widening the query on it", () => {
    expect(ACTION_CODE).toContain("canSeeEveryone");
    expect(ACTION_CODE).toContain('"payroll.read"');
    // The permission is computed once, into a flag, and never tested.
    expect(ACTION_CODE).not.toMatch(/if\s*\([^)]*canSeeEveryone/);
    expect(ACTION_CODE).not.toMatch(/canSeeEveryone\s*\?/);
  });

  /**
   * 🔴 AND THE SCREEN OFFERS NO WAY TO ASK FOR SOMEBODY ELSE. No
   * picker, no search, no id in a link.
   */
  it("the board has no employee picker and no id-bearing navigation", () => {
    expect(BOARD_CODE).not.toMatch(/employeeId/);
    expect(BOARD_CODE).not.toMatch(/<select/i);
    expect(BOARD_CODE).not.toMatch(/href=\{/);
  });
});

/* ================================================================== */
/* ③ 🔴 ONLY A SIGNED-OFF RUN IS VISIBLE                               */
/* ================================================================== */

describe("🔴 draft and computed runs are not shown to the employee", () => {
  /**
   * ⚠️ A `computed` RUN IS SOMEBODY'S UNFINISHED ARITHMETIC. A
   * recompute replaces every payslip in it, and attendance corrections
   * and backdated raises are ordinary reasons to recompute. An employee
   * who sees a net pay that later changes has planned around a figure
   * that was never a promise.
   */
  it("the visible set is exactly approved and posted", () => {
    expect(ACTION_CODE).toMatch(
      /const VISIBLE_TO_EMPLOYEE = \["approved", "posted"\] as const/,
    );
    expect(ACTION_CODE).toContain("inArray(payrollRuns.status, [...VISIBLE_TO_EMPLOYEE])");
  });

  /**
   * ⚠️ THE ONLY OTHER PLACE A STATUS LITERAL APPEARS IS THE WITHHELD
   * LIST, WHICH IS COUNTED AND NEVER DETAILED. Asserting the literals
   * are not sprinkled through the queries is what stops a later "just
   * for testing" `"computed"` surviving into a release.
   */
  it("draft and computed appear only in the withheld list", () => {
    expect(ACTION_CODE).toMatch(
      /const WITHHELD_FROM_EMPLOYEE = \["draft", "computed"\] as const/,
    );
    expect([...ACTION_CODE.matchAll(/"draft"/g)].length).toBe(1);
    expect([...ACTION_CODE.matchAll(/"computed"/g)].length).toBe(1);
    expect([...ACTION_CODE.matchAll(/"cancelled"/g)].length).toBe(0);
  });

  /**
   * ⭐ THE WITHHELD RUN IS ANNOUNCED AS A COUNT WITH NO FIGURES.
   * Silence would read as "payroll forgot me", which produces exactly
   * the anxious message to HR this screen exists to prevent; a figure
   * would be a number somebody could plan around.
   */
  it("counts the withheld payslips without selecting any money from them", () => {
    const pending = ACTION_CODE.slice(
      ACTION_CODE.indexOf("WITHHELD_FROM_EMPLOYEE]"),
    );
    expect(ACTION_CODE).toContain("awaitingApproval");
    // The withheld query selects an id and nothing else.
    const selection = ACTION_CODE.slice(
      ACTION_CODE.lastIndexOf(".select({ id: payslips.id })"),
      ACTION_CODE.indexOf("WITHHELD_FROM_EMPLOYEE]"),
    );
    expect(selection).not.toMatch(/Minor/);
    expect(pending.length).toBeGreaterThan(0);
  });

  it("the board tells the employee a run is being prepared, without amounts", () => {
    expect(BOARD_CODE).toContain("view.awaitingApproval");
    expect(BOARD).toMatch(/being prepared/);
  });
});

/* ================================================================== */
/* ④ ⭐ THE CAVEATS REACH THE EMPLOYEE                                 */
/* ================================================================== */

describe("⭐ the payslip's caveats are shown, not swallowed", () => {
  /**
   * 🔴 `lib/payroll/statutory.ts` REFUSES TO GUESS AT SURCHARGE and
   * says so in words on the result. `buildPayslip` stores every caveat
   * on the row. A payslip that quietly understates tax without saying
   * why is worse than one that says "this excludes surcharge, ask your
   * accountant".
   */
  it("passes every note through with no filtering", () => {
    expect(ACTION_CODE).toContain("notes: Array.isArray(r.notes)");
    // ⚠️ No `.filter(` anywhere near the notes — the whole array or nothing.
    expect(ACTION_CODE).not.toMatch(/notes[^\n]*\.filter\(/);
    expect(ACTION_CODE).toContain("problems: Array.isArray(r.problems)");
  });

  it("renders them, and separates the tax caveats from the rest", () => {
    expect(BOARD_CODE).toContain("PayslipCaveats");
    expect(codeOnly(CAVEATS)).toContain("partitionNotes");
    expect(codeOnly(CAVEATS)).toContain("tax.map");
    expect(codeOnly(CAVEATS)).toContain("other.map");
    expect(codeOnly(CAVEATS)).toContain("problems.map");
  });

  /**
   * ⚠️ AN UNRECOGNISED NOTE IS STILL SHOWN. The "Income tax: " prefix is
   * a convention, not a schema. If it ever changes, every caveat sorts
   * into `other` — where it is still rendered, just less prominently.
   * A partition that dropped what it did not recognise would fail in the
   * one direction that matters.
   */
  it("a note with no recognised prefix falls into the shown-anyway bucket", () => {
    const src = codeOnly(CAVEATS);
    expect(src).toContain("else other.push(note)");
  });

  /**
   * ⚠️ THE PROJECTION IS NAMED IN THE HEADING, NOT LEFT TO THE CAVEAT
   * TEXT. Somebody reading their first payslip has no reason to know
   * that monthly TDS is one twelfth of a projection.
   */
  it("says the tax figure is an estimate and that an override is an override", () => {
    expect(CAVEATS).toContain("tdsIsProjection");
    expect(CAVEATS).toContain("tdsOverridden");
    expect(CAVEATS).toMatch(/estimate, not a settled amount/);
    expect(CAVEATS).toMatch(/accountant/);
  });
});

/* ================================================================== */
/* ⑤ THE HOUSE RULES                                                   */
/* ================================================================== */

describe("the house rules hold on this screen", () => {
  /**
   * 🔴 MONEY IS BIGINT MINOR UNITS, FORMATTED BY SPLITTING THE STRING.
   * `Number(x) / 100` is the fault this rule exists to prevent, and a
   * payslip is the one document a person checks with a calculator.
   */
  it("never divides a Number by a hundred", () => {
    for (const src of [ACTION_CODE, BOARD_CODE, codeOnly(CAVEATS), PAGE_CODE]) {
      expect(src).not.toMatch(/Number\([^)]*\)\s*\/\s*100/);
      expect(src).not.toMatch(/parseFloat/);
    }
    expect(BOARD_CODE).toContain("rupees(");
    // ⚠️ Reused from the run board rather than reimplemented — one place
    // the paise-to-rupees rule lives, one place to get it wrong.
    expect(BOARD_CODE).toContain('from "@/components/payroll/payroll-run-board"');
  });

  it("totals the year in bigint paise and hands it on as a string", () => {
    expect(ACTION_CODE).toMatch(/BigInt\(pick\(s\) \|\| "0"\)/);
    expect(ACTION_CODE).toContain(".toString()");
  });

  /**
   * ⭐ THE FINANCIAL YEAR COMES FROM THE RUN ENGINE, NOT FROM A SECOND
   * COPY OF THE APRIL RULE. `tdsDeductedThisFy()` uses `fyStartFor` to
   * decide what has already been withheld; a divergent copy here would
   * show the employee a year-to-date tax figure that does not agree with
   * what the engine believes it deducted.
   */
  it("reuses fyStartFor rather than reimplementing the Indian financial year", () => {
    expect(ACTION_CODE).toContain("fyStartFor");
    expect(ACTION_CODE).toContain('from "@/server/payroll/run"');
    expect(ACTION_CODE).not.toMatch(/getMonth\(\)/);
  });

  /**
   * ⚠️ IT IS A `"use server"` MODULE, SO EVERY EXPORT IS A URL. The
   * boundary checker enforces the shape; this asserts the directive is
   * the literal first line it looks for.
   */
  it("is a use-server module whose first line is the directive", () => {
    expect(ACTION.split("\n")[0]).toBe('"use server";');
  });

  /**
   * ⚠️ A PURE READ. No insert, no update, no `revalidatePath`, and no
   * `writeAudit` — which `check-action-guards.mjs` counts as a mutation
   * and which would file an audit row every time somebody glanced at
   * their own pay. Tier-1 identity is the right guard for a read and it
   * is only the right guard while this stays true.
   */
  it("mutates nothing", () => {
    expect(ACTION_CODE).not.toMatch(/\.insert\(/);
    expect(ACTION_CODE).not.toMatch(/\.update\(/);
    expect(ACTION_CODE).not.toMatch(/\.delete\(/);
    expect(ACTION_CODE).not.toMatch(/revalidatePath\(/);
    expect(ACTION_CODE).not.toMatch(/writeAudit\(/);
  });

  /**
   * 🔴 `requirePermission("payroll.read")` HERE WOULD DEFEAT THE WHOLE
   * FEATURE — it is precisely the key an employee does not hold, so the
   * screen would work only for the people who never needed it. The
   * authorisation is the WHERE clause, not a key.
   */
  it("does not gate the self read behind the payroll permission", () => {
    expect(ACTION_CODE).not.toMatch(/requirePermission\(/);
    expect(ACTION_CODE).not.toMatch(/checkPermission\(/);
  });

  /**
   * 🔴 `employees.notes` IS FREE TEXT WRITTEN ABOUT THIS PERSON BY
   * SOMEBODY WHO ASSUMED ONLY `payroll.read` HOLDERS WOULD READ IT — a
   * probation remark, a garnishee order, a reason for a withheld
   * increment. Publishing it to its subject through a helpful feature is
   * a data-protection incident.
   */
  it("never sends the HR notes field to the employee", () => {
    expect(ACTION_CODE).not.toMatch(/person\.notes/);
    expect(ACTION_CODE).not.toMatch(/employees\.notes/);
    const view = ACTION.slice(
      ACTION.indexOf("export type SelfEmployeeView"),
      ACTION.indexOf("export type SelfServiceView"),
    );
    expect(view.length).toBeGreaterThan(0);
    expect(codeOnly(view)).not.toMatch(/\bnotes\b/);
  });

  /**
   * ⚠️ THE PAYSLIP'S OWN FROZEN NAME AND CODE ARE WHAT IS SHOWN, NOT
   * TODAY'S FROM `employees`. A payslip reissued after a name change
   * must match the one the employee is holding.
   */
  it("shows the name frozen on the payslip row", () => {
    expect(ACTION_CODE).toContain("employeeName: payslips.employeeName");
    expect(BOARD_CODE).toContain("slip.employeeName");
  });

  /**
   * ⚠️ THE EMPLOYER'S OWN CONTRIBUTIONS ARE NOT A DEDUCTION AND NEVER
   * APPEAR ON A PAYSLIP. Showing them would invite the reading that the
   * deductions column is bigger than it is.
   */
  it("shows no employer-side cost", () => {
    for (const src of [ACTION_CODE, BOARD_CODE]) {
      expect(src).not.toMatch(/employerPfMinor/);
      expect(src).not.toMatch(/employerCostMinor/);
      expect(src).not.toMatch(/employerPensionMinor/);
      expect(src).not.toMatch(/edliMinor/);
    }
  });
});

/* ================================================================== */
/* ⑥ THE UNLINKED CASE IS EXPLAINED RATHER THAN EMPTY                  */
/* ================================================================== */

describe("a sign-in with no employee record", () => {
  /**
   * ⭐ `employees.userId` IS NULLABLE AND THE SCHEMA IS BLUNT ABOUT WHY:
   * most people on a payroll never sign in, and half the people who sign
   * in are not on the payroll. So the absence of a link is an ordinary
   * state, not an error.
   *
   * ⚠️ AND AN EMPTY LIST WOULD BE READ AS "PAYROLL LOST MY PAYSLIPS".
   * The distinction the reader needs is between "you have none" and "we
   * do not know which of these people is you" — only the second has an
   * action attached.
   */
  it("is a stated answer with a next step, not an empty list", () => {
    expect(ACTION_CODE).toContain("linked: false");
    expect(BOARD_CODE).toContain("if (!view.linked)");
    expect(BOARD).toMatch(/not linked to an employee record/i);
    expect(BOARD).toMatch(/Ask whoever runs payroll/);
  });

  it("returns no payslips at all in that case", () => {
    const branch = ACTION_CODE.slice(
      ACTION_CODE.indexOf("if (linkedRows.length === 0)"),
      ACTION_CODE.indexOf("const mine ="),
    );
    expect(branch).toContain("payslips: []");
    expect(branch).toContain("awaitingApproval: 0");
    expect(branch).toContain("employee: null");
  });
});
