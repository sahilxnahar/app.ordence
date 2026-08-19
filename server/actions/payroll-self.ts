"use server";

/**
 * Ordence — ⭐⭐⭐ EMPLOYEE SELF-SERVICE: MY OWN PAYSLIPS
 * Version: v1.43.0-alpha · Batch 107
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 PAYROLL IS A RESTRICTED CLASS, AND THIS FILE IS THE ONE PLACE
 *        IN THE PRODUCT THAT HANDS IT TO SOMEBODY WITHOUT `payroll.read`
 * ══════════════════════════════════════════════════════════════════════
 * Every other payroll read in Ordence — `listEmployees`, `getPayrollRun`,
 * `getEmployeeStructure` — sits behind `payroll.read`, a key that is
 * deliberately in no default role. `db/schema/auth.ts` says why in one
 * line worth repeating: salary is the one figure in an organisation that
 * people quit over knowing.
 *
 * This file exists because that key, correctly, also keeps an employee
 * out of their OWN payslip. So there has to be exactly one read that an
 * ordinary member may make, and it has to be narrow enough that the
 * narrowness is provable by reading it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 ROW-LEVEL SECURITY DOES NOTHING FOR US HERE. NOTHING AT ALL.
 * ══════════════════════════════════════════════════════════════════════
 * This is the single most important sentence in the file, and it is the
 * one most likely to be forgotten by whoever edits it next.
 *
 * RLS in Ordence scopes by TENANT. `withTenant()` sets
 * `app.current_tenant_id`, the policy on `payslips` compares
 * `tenant_id = app_current_tenant_id()`, and that is the whole of it.
 * EVERY COLLEAGUE'S PAYSLIP IS IN THE SAME TENANT. The database will
 * hand over the finance director's net pay to a junior's session as
 * cheerfully as it hands over the junior's own, because from the
 * policy's point of view they are the same row class.
 *
 * ⚠️ THE SHAPE OF THE MISTAKE IS SPECIFIC. Everywhere else in this
 * codebase a forgotten `eq(x.tenantId, ctx.tenant.id)` is caught by the
 * policy — belt and braces, and the braces hold. Here there is no
 * second layer. If the employee predicate below is dropped, weakened or
 * moved outside the `and(...)`, this endpoint publishes the whole
 * company's salaries to anybody who can sign in, it type checks, it
 * renders, and it looks exactly like a working screen to the person who
 * built it. Nothing fails. There is no test that a database can run
 * against itself to notice.
 *
 * 🔴 SO THE SCOPE IS EXPLICIT, IN THE QUERY, EVERY TIME:
 *
 *        inArray(payslips.employeeId, mine)
 *
 * where `mine` is derived below from `employees.userId = ctx.user.id`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE CALLER IS NEVER ASKED WHO THEY ARE
 * ══════════════════════════════════════════════════════════════════════
 * `myPayslips()` TAKES NO ARGUMENTS. Not an employee id, not a payslip
 * id, not a filter. That is not minimalism, it is the control.
 *
 * ⚠️ THE TEMPTING VERSION IS `myPayslips(employeeId)` WITH A CHECK. It
 * reads as safe — "we verify the id belongs to the caller" — and it is
 * one refactor away from unsafe forever. A `"use server"` export is a
 * URL; anybody who has loaded the app can POST any uuid to it. The
 * moment somebody adds an HR branch, or moves the check above a `try`,
 * or reuses the helper from a screen that already checked, the check
 * becomes decorative. A function with no parameter cannot be given
 * somebody else's id by any future edit that does not first change its
 * signature — which is a change a reviewer sees.
 *
 * ⭐ THE IDENTITY COMES FROM THE SESSION, FULL STOP. `ctx.user.id` is
 * resolved by `requireTenantContext()`, which re-reads the Clerk session
 * on the server and looks the user row up in the database. It is not a
 * header, not a prop, not a search param.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE GUARD IS TIER 1 ON PURPOSE, AND THAT NEEDS DEFENDING
 * ══════════════════════════════════════════════════════════════════════
 * `requireTenantContext()` answers "who are you and which workspace",
 * not "may you do this". `scripts/check-action-guards.mjs` accepts that
 * for a read and refuses it for a write, and this file is a pure read —
 * no insert, no update, no `revalidatePath`, and deliberately no
 * `writeAudit` (which the gate counts as a mutation, and which would
 * write an audit row every time somebody glanced at their own pay).
 *
 * 🔴 A PERMISSION KEY HERE WOULD DEFEAT THE FEATURE. `payroll.read` is
 * exactly the key an employee does not have; requiring it would mean
 * this screen only worked for the people who never needed it. The
 * authorisation is not "does this person hold a key" — it is "this
 * person is only ever shown the rows that ARE this person", enforced in
 * the WHERE clause. That is a real answer to "may you do this", it is
 * just not one a permission table can express.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ HR STILL SEES EVERYBODY — SOMEWHERE ELSE
 * ══════════════════════════════════════════════════════════════════════
 * A user holding `payroll.read` sees the whole payroll through
 * `server/actions/payroll.ts` and the screens under `/payroll`. They do
 * NOT see it through here, even though they could be trusted with it.
 *
 * ⚠️ ONE ENDPOINT THAT WIDENS FOR PRIVILEGED CALLERS IS THE BUG THIS
 * WHOLE FILE IS ARRANGED TO AVOID. Two code paths — "everything, if you
 * hold the key" and "only me, always" — in one function means the narrow
 * path is one boolean away from the wide one, and that boolean is
 * computed from a role that impersonation, a permission override or a
 * seeded test fixture can flip. Separate endpoints cannot leak into each
 * other. All this file does about the privilege is REPORT it, so the
 * page can offer HR a link to the screen that does show everyone.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db";
import { employees, payrollRuns, payslips } from "@/db/schema/payroll";
import { can } from "@/lib/permissions";
import { requireTenantContext } from "@/server/tenant-context";
import { toSalesActionError } from "@/server/sales/guards";
import { fyStartFor } from "@/server/payroll/run";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * 🔴🔴 THE ONLY TWO STATUSES AN EMPLOYEE MAY EVER SEE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A `draft` OR `computed` RUN IS SOMEBODY'S UNFINISHED ARITHMETIC
 * ══════════════════════════════════════════════════════════════════════
 * `computed` means payslips exist and are still editable — a recompute
 * replaces every one of them (`writeRun` deletes and reinserts), and a
 * recompute happens for ordinary reasons: an attendance correction, a
 * backdated raise, a component somebody had mistyped. The figure is
 * genuinely provisional.
 *
 * 🔴 AN EMPLOYEE WHO SEES A NET PAY THAT LATER CHANGES HAS BEEN TOLD
 * SOMETHING UNTRUE ABOUT THEIR OWN MONEY. They will have planned around
 * it, and the conversation that follows is not one anybody can win: the
 * payroll team has to explain that the number the product showed was
 * never a promise, which is not how anyone reads a payslip. It also
 * destroys the point of the approval step — approval is a signature, and
 * a signature on a figure people have already been shown is theatre.
 *
 * ⭐ IT IS ALSO EXACTLY THE RULE THE TAX ENGINE ALREADY USES.
 * `tdsDeductedThisFy()` in `server/payroll/run.ts` counts only approved
 * and posted runs when it works out what has already been withheld this
 * financial year, for the same reason: a figure that a colleague can
 * change by pressing Recompute must not be a figure anything else
 * depends on. The year-to-date totals below therefore agree with the
 * engine's own view, rather than being a second, larger number the
 * employee cannot reconcile with their Form 16.
 *
 * `cancelled` is absent because the money never moved.
 */
const VISIBLE_TO_EMPLOYEE = ["approved", "posted"] as const;

/** Statuses that exist but must not be shown. Counted, never detailed. */
const WITHHELD_FROM_EMPLOYEE = ["draft", "computed"] as const;

/* ------------------------------------------------------------------ */
/* THE SHAPES THE SCREEN RENDERS                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY MONEY FIELD IS A STRING OF PAISE AND STAYS ONE ALL THE WAY TO
 * THE DOM. `bigint` does not survive the server-to-client boundary, and
 * `Number(x) / 100` silently loses the last paise somewhere north of
 * ₹90,00,00,00,000 — which nobody's salary reaches, but the run totals
 * do. One rule, applied everywhere, beats a rule with an exemption.
 */
export type SelfPayslipView = {
  id: string;
  runNo: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  employeeName: string;
  employeeCode: string;
  daysInMonth: number;
  payableDays: string;
  lopDays: string;
  grossMinor: string;
  employeePfMinor: string;
  employeeEsiMinor: string;
  professionalTaxMinor: string;
  tdsMinor: string;
  otherDeductionsMinor: string;
  totalDeductionsMinor: string;
  netPayMinor: string;
  tdsIsProjection: boolean;
  tdsOverridden: boolean;
  /** ⭐ Including the tax caveats. See the note on `notes` below. */
  notes: string[];
  problems: string[];
  lines: Array<{
    label: string;
    kind: string;
    amountMinor: string;
    fullMonthMinor: string;
    workingNote: string;
  }>;
};

/**
 * ⚠️ WHAT AN EMPLOYEE IS SHOWN ABOUT THEMSELVES, AND WHAT THEY ARE NOT.
 *
 * 🔴 `employees.notes` IS DELIBERATELY ABSENT AND MUST STAY ABSENT. It
 * is a free-text field on the HR screen. Whatever is in it was written
 * ABOUT this person by somebody who assumed only `payroll.read` holders
 * would read it — a probation remark, a garnishee order, a reason for a
 * withheld increment. Publishing it here would be a data-protection
 * incident delivered by a helpful feature, and it would be discovered by
 * the subject.
 *
 * ⭐ PAN AND UAN ARE SHOWN IN FULL, WHICH IS THE DELIBERATE OPPOSITE.
 * They are the employee's own identifiers, and the single most common
 * self-service question in Indian payroll is "is the PAN you have for me
 * correct" — because a wrong one puts the TDS against nobody's 26AS and
 * is found in June, when Form 16 does not match. Masking them would make
 * the field decorative and the error undiscoverable until it is
 * expensive.
 */
export type SelfEmployeeView = {
  fullName: string;
  employeeCode: string;
  designation: string | null;
  department: string | null;
  workStateCode: string;
  joinedOn: string;
  leftOn: string | null;
  pan: string | null;
  uan: string | null;
  esicNumber: string | null;
  pfExempt: boolean;
  pfOnFullWages: boolean;
  esiExempt: boolean;
  taxRegime: string;
  declaredDeductionsMinor: string;
  /** ⭐ True when the accountant has fixed the TDS figure by hand. */
  tdsOverridden: boolean;
};

export type SelfServiceView = {
  /** False when no `employees` row points at this sign-in account. */
  linked: boolean;
  /**
   * ⚠️ More than one employee row linked to one sign-in account. Every
   * one of them is still this person by definition of the link, so
   * nothing is hidden — but it is a data-entry fault worth naming.
   */
  duplicateLink: boolean;
  employee: SelfEmployeeView | null;
  payslips: SelfPayslipView[];
  /**
   * ⭐ HOW MANY PAYSLIPS EXIST FOR THIS PERSON IN A RUN THAT IS STILL
   * BEING EDITED. A COUNT, NEVER A FIGURE.
   *
   * ⚠️ SAYING NOTHING WOULD BE WORSE THAN SAYING THIS. An employee whose
   * March payslip is sitting in a computed run sees an empty March, and
   * an empty March reads as "payroll forgot me" — which produces exactly
   * the anxious message to HR that this screen exists to prevent. The
   * honest answer is "it is being prepared", and existence is not a
   * figure anybody can plan around.
   */
  awaitingApproval: number;
  /** The financial year the totals below cover, e.g. "2025-26". */
  fyLabel: string | null;
  ytd: {
    grossMinor: string;
    employeePfMinor: string;
    employeeEsiMinor: string;
    professionalTaxMinor: string;
    tdsMinor: string;
    netPayMinor: string;
    months: number;
  } | null;
  /**
   * ⭐ TRUE WHEN THIS CALLER ALSO HOLDS `payroll.read`. Reported, not
   * acted on — see the header. The page uses it to offer a link to the
   * full payroll screens, so an HR user does not conclude that their own
   * two payslips are all Ordence has.
   */
  canSeeEveryone: boolean;
};

/* ------------------------------------------------------------------ */
/* THE READ                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ EVERYTHING THE SELF-SERVICE SCREEN NEEDS, IN ONE CALL, WITH NO
 * ARGUMENTS.
 *
 * ⚠️ ONE ENDPOINT RATHER THAN THREE IS A SECURITY DECISION BEFORE IT IS
 * A PERFORMANCE ONE. A `myPayslip(id)` companion would be the natural
 * second export and it would be the first place a parameter appeared;
 * the whole detail — every line, with its working — is returned here
 * instead and the component expands it in place. There is nothing to
 * fetch by id, so there is no id to tamper with.
 */
export async function myPayslips(): Promise<ActionResult<SelfServiceView>> {
  try {
    /**
     * 🔴 TIER 1, AND IT IS THE IDENTITY THAT DOES THE WORK. See the
     * header: a permission key here would lock out precisely the people
     * this endpoint is for. `requireTenantContext()` fails closed —
     * it throws rather than returning null — so a forgotten check is not
     * a silently unscoped query.
     */
    const ctx = await requireTenantContext();

    const view = await withTenant(ctx.tenant.id, async (tx) => {
      /**
       * ══════════════════════════════════════════════════════════════
       * 🔴 STEP ONE, AND THE ONLY STEP THAT MATTERS: WHICH EMPLOYEE
       *    ROW IS THIS SIGN-IN ACCOUNT?
       * ══════════════════════════════════════════════════════════════
       * `employees.userId` is a nullable FK to `users`, and the schema
       * is blunt about why it is nullable: most employees on a payroll
       * never sign in, and half the people who sign in are not on the
       * payroll. So the link genuinely may not exist, and its absence
       * is a normal state rather than an error — handled below.
       *
       * ⚠️ THE DIRECTION OF THIS QUERY IS THE WHOLE CONTROL. We ask
       * "which employee rows point at ME", never "is this employee row
       * mine". The first cannot return somebody else's row. The second
       * is a check, and checks can be bypassed by the caller choosing
       * what to check.
       */
      const linkedRows = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.tenantId, ctx.tenant.id), eq(employees.userId, ctx.user.id)));

      if (linkedRows.length === 0) {
        return {
          linked: false,
          duplicateLink: false,
          employee: null,
          payslips: [],
          awaitingApproval: 0,
          fyLabel: null,
          ytd: null,
        };
      }

      /**
       * ⚠️ ALL OF THEM, NOT THE FIRST. There is no unique index on
       * `employees.user_id`, so two rows may point here — a rehire
       * given a fresh employee code is the ordinary way it happens.
       * Both rows ARE this person, so showing both is correct; picking
       * one arbitrarily would hide half of somebody's own history and
       * would do it silently.
       */
      const mine = linkedRows.map((r) => r.id);

      /**
       * ══════════════════════════════════════════════════════════════
       * 🔴🔴 THE SCOPING. THIS `and(...)` IS THE FEATURE.
       * ══════════════════════════════════════════════════════════════
       * Three predicates, and losing any one of them is a different
       * disclosure:
       *
       *   tenantId    — belt to RLS's braces. Redundant here and kept
       *                 anyway, because every other read in the
       *                 codebase has it and an exception invites the
       *                 question "why not" at the wrong moment.
       *   employeeId  — 🔴 THE ONE RLS CANNOT DO. Without it this
       *                 returns every colleague's payslip, and nothing
       *                 anywhere reports a problem.
       *   run status  — approved or posted only. See VISIBLE_TO_EMPLOYEE.
       */
      const rows = await tx
        .select({
          id: payslips.id,
          employeeName: payslips.employeeName,
          employeeCode: payslips.employeeCode,
          daysInMonth: payslips.daysInMonth,
          payableDays: payslips.payableDays,
          lopDays: payslips.lopDays,
          grossMinor: payslips.grossMinor,
          employeePfMinor: payslips.employeePfMinor,
          employeeEsiMinor: payslips.employeeEsiMinor,
          professionalTaxMinor: payslips.professionalTaxMinor,
          tdsMinor: payslips.tdsMinor,
          otherDeductionsMinor: payslips.otherDeductionsMinor,
          totalDeductionsMinor: payslips.totalDeductionsMinor,
          netPayMinor: payslips.netPayMinor,
          tdsIsProjection: payslips.tdsIsProjection,
          tdsOverridden: payslips.tdsOverridden,
          notes: payslips.notes,
          problems: payslips.problems,
          lines: payslips.lines,
          runNo: payrollRuns.runNo,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
          status: payrollRuns.status,
        })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(
          and(
            eq(payslips.tenantId, ctx.tenant.id),
            inArray(payslips.employeeId, mine),
            inArray(payrollRuns.status, [...VISIBLE_TO_EMPLOYEE]),
          ),
        )
        .orderBy(desc(payrollRuns.periodStart))
        // ⚠️ Two years of history. Every payslip carries its own lines,
        // so an unbounded list is a large payload for a screen nobody
        // scrolls that far down.
        .limit(24);

      /**
       * ⭐ THE SAME SCOPE AGAIN, FOR THE RUNS BEING EDITED. Written out
       * rather than derived from the query above, because a shared
       * builder that one caller mutates is how the status filter goes
       * missing from the branch that shows figures.
       */
      const pending = await tx
        .select({ id: payslips.id })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payrollRuns.id, payslips.runId))
        .where(
          and(
            eq(payslips.tenantId, ctx.tenant.id),
            inArray(payslips.employeeId, mine),
            inArray(payrollRuns.status, [...WITHHELD_FROM_EMPLOYEE]),
          ),
        );

      const person = linkedRows[0]!;

      const slips: SelfPayslipView[] = rows.map((r) => ({
        id: String(r.id),
        runNo: String(r.runNo),
        periodStart: iso(r.periodStart),
        periodEnd: iso(r.periodEnd),
        status: String(r.status),
        employeeName: String(r.employeeName),
        employeeCode: String(r.employeeCode),
        daysInMonth: Number(r.daysInMonth ?? 0),
        payableDays: String(r.payableDays ?? "0"),
        lopDays: String(r.lopDays ?? "0"),
        grossMinor: String(r.grossMinor ?? "0"),
        employeePfMinor: String(r.employeePfMinor ?? "0"),
        employeeEsiMinor: String(r.employeeEsiMinor ?? "0"),
        professionalTaxMinor: String(r.professionalTaxMinor ?? "0"),
        tdsMinor: String(r.tdsMinor ?? "0"),
        otherDeductionsMinor: String(r.otherDeductionsMinor ?? "0"),
        totalDeductionsMinor: String(r.totalDeductionsMinor ?? "0"),
        netPayMinor: String(r.netPayMinor ?? "0"),
        tdsIsProjection: Boolean(r.tdsIsProjection),
        tdsOverridden: Boolean(r.tdsOverridden),
        /**
         * ⭐⭐⭐ THE NOTES ARE PASSED THROUGH WHOLE, AND THAT IS THE
         * POINT OF THE FEATURE.
         *
         * ══════════════════════════════════════════════════════════
         * 🔴 EVERY CAVEAT THE ENGINE PRODUCED IS IN HERE, AND NOT ONE
         *    OF THEM IS FILTERED OUT
         * ══════════════════════════════════════════════════════════
         * `lib/payroll/statutory.ts` refuses to guess at surcharge and
         * says so in words; `projectMonthlyTds` says out loud that the
         * monthly figure is an estimate to be trued up; it says when
         * the year's estimated tax has already been withheld; it says
         * when declared investments were ignored because the employee
         * is on the new regime. `buildPayslip` prefixes each with
         * "Income tax:" and stores them on the row.
         *
         * ⚠️ THE TEMPTATION IS TO TIDY THEM AWAY. They are long, they
         * are hedged, and they make a payslip look less authoritative
         * than a bare number does. A payslip that quietly understates
         * tax is far worse: the employee discovers it at assessment,
         * owes the difference with interest, and correctly asks why
         * the employer's system never mentioned it. "This figure
         * excludes surcharge, ask your accountant" is a sentence that
         * costs nothing to print and saves that conversation.
         */
        notes: Array.isArray(r.notes) ? (r.notes as string[]) : [],
        /**
         * ⚠️ PROBLEMS TOO, THOUGH ON AN APPROVED RUN THERE SHOULD BE
         * NONE — `approvePayrollRun` refuses while `problemCount > 0`.
         * Shown anyway, because the one that gets through is precisely
         * the one nobody expected, and hiding it would leave the
         * employee the only person able to spot it holding the only
         * copy that does not mention it.
         */
        problems: Array.isArray(r.problems) ? (r.problems as string[]) : [],
        lines: Array.isArray(r.lines)
          ? (r.lines as Array<Record<string, unknown>>).map((l) => ({
              label: String(l.label ?? ""),
              kind: String(l.kind ?? "earning"),
              amountMinor: String(l.amountMinor ?? "0"),
              fullMonthMinor: String(l.fullMonthMinor ?? "0"),
              workingNote: String(l.workingNote ?? ""),
            }))
          : [],
      }));

      return {
        linked: true,
        duplicateLink: linkedRows.length > 1,
        employee: {
          fullName: person.fullName,
          employeeCode: person.employeeCode,
          designation: person.designation,
          department: person.department,
          workStateCode: person.workStateCode,
          joinedOn: iso(person.joinedOn),
          leftOn: person.leftOn === null ? null : iso(person.leftOn),
          pan: person.pan,
          uan: person.uan,
          esicNumber: person.esicNumber,
          pfExempt: person.pfExempt,
          pfOnFullWages: person.pfOnFullWages,
          esiExempt: person.esiExempt,
          taxRegime: String(person.taxRegime),
          declaredDeductionsMinor: String(person.declaredDeductionsMinor ?? "0"),
          tdsOverridden: person.tdsOverrideMinor !== null,
        } satisfies SelfEmployeeView,
        payslips: slips,
        awaitingApproval: pending.length,
        ...yearToDate(slips),
      };
    });

    return {
      ok: true,
      data: {
        ...view,
        /**
         * ⭐ A PURE PREDICATE, NOT `checkPermission`. The throwing and
         * the recording forms both write a `permission_denials` row on
         * refusal — and on this screen a refusal is the NORMAL case.
         * Every ordinary employee loading their own payslips would
         * file a denial record, which fills the table an actual
         * intrusion would show up in with routine noise.
         */
        canSeeEveryone: can(
          { role: ctx.role, overrides: ctx.user.permissionOverrides },
          "payroll.read",
        ),
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS — not exported, because an export here is a URL              */
/* ------------------------------------------------------------------ */

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "");
}

/**
 * ⭐ YEAR TO DATE, OVER THE FINANCIAL YEAR OF THE MOST RECENT VISIBLE
 * PAYSLIP — NOT OVER "THIS FINANCIAL YEAR ACCORDING TO THE CLOCK".
 *
 * ⚠️ THE CLOCK VERSION IS WRONG IN A WAY THAT LOOKS RIGHT. Payroll runs
 * in arrears and approval lags: in April, and often well into May, the
 * newest approved payslip is March's and belongs to the year that just
 * ended. A clock-based total would show "2026-27: ₹0" beside a March
 * payslip and read as though eleven months of tax had been lost.
 *
 * ⭐ `fyStartFor` IS IMPORTED FROM THE RUN ENGINE RATHER THAN REWRITTEN.
 * The Indian financial year starts in April, and the one place that
 * decision is written down is the one the TDS true-up already uses. Two
 * copies would disagree the first time somebody "fixed" one of them, and
 * the employee would be shown a year-to-date tax figure that does not
 * match what the engine believes it has withheld.
 */
function yearToDate(slips: readonly SelfPayslipView[]): {
  fyLabel: string | null;
  ytd: SelfServiceView["ytd"];
} {
  if (slips.length === 0) return { fyLabel: null, ytd: null };

  const fyStart = fyStartFor(slips[0]!.periodStart);
  const inFy = slips.filter((s) => s.periodStart >= fyStart);
  if (inFy.length === 0) return { fyLabel: null, ytd: null };

  // ⚠️ Totals accumulate as bigint paise and are handed on as strings.
  // A running `Number` here would be the one place the whole money rule
  // is broken, and it would be invisible until somebody's arrears made
  // a total large enough to notice.
  const total = (pick: (s: SelfPayslipView) => string): string =>
    inFy.reduce((sum, s) => sum + BigInt(pick(s) || "0"), 0n).toString();

  const startYear = Number(fyStart.slice(0, 4));

  return {
    fyLabel: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    ytd: {
      grossMinor: total((s) => s.grossMinor),
      employeePfMinor: total((s) => s.employeePfMinor),
      employeeEsiMinor: total((s) => s.employeeEsiMinor),
      professionalTaxMinor: total((s) => s.professionalTaxMinor),
      tdsMinor: total((s) => s.tdsMinor),
      netPayMinor: total((s) => s.netPayMinor),
      months: inFy.length,
    },
  };
}
