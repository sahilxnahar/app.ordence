"use server";

/**
 * Ordence — ⭐⭐⭐ THE MONTHLY STATUTORY RETURN FILES
 * Version: v1.52.0-alpha · Batch 78
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE COMPUTATION EXISTED. THE FILING DID NOT.
 * ══════════════════════════════════════════════════════════════════════
 * Every month an Indian employer must UPLOAD A FILE, not know a number.
 * This action reads the frozen payslips of a settled run and hands them
 * to `lib/payroll/returns/`, which decides the formats. Nothing is
 * computed here and nothing is written — like `server/actions/
 * registers.ts`, the read path is the whole file, both queries go
 * through `withTenant`, and RLS remains the only isolation.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ `"use server"` PUBLISHES EVERY EXPORT AS A URL
 * ══════════════════════════════════════════════════════════════════════
 * An ECR is every colleague's UAN and PF wages; an ESIC file is every
 * colleague's insurance number. So both exports guard on `payroll.read`
 * — the key that is deliberately kept out of the default role templates
 * for exactly this reason — and they guard BEFORE any query runs, so an
 * unauthorised caller cannot tell a workspace with payroll from one
 * without by timing the refusal.
 *
 * 🔴 WHAT I WANTED AND DO NOT HAVE: a `payroll.file` key, so that the
 * person who prepares statutory returns need not also be able to read
 * individual salaries. `requirePermission` is typed `PermissionKey` and
 * the catalogue lives in `db/schema/auth.ts`, which this batch must not
 * touch. `payroll.read` is the honest approximation and is no weaker.
 * Reported.
 */

import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/db";
import { employees, payrollRuns, payslips } from "@/db/schema/payroll";
import { requireAllPermissions } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import { loadRates } from "@/server/payroll/run";
import { centidaysFromNumeric, paiseFromNumeric } from "@/lib/registers/format";
import {
  buildEcr,
  buildEsicMonthly,
  buildPtReturn,
  contributionPeriodRange,
  returnDueInfo,
  type EcrMemberFacts,
  type EsicPersonFacts,
  type PtPersonFacts,
  type StatutoryReturnKind,
  type StatutoryReturnOutcome,
} from "@/lib/payroll/returns";

const PAYROLL_READ = "payroll.read" as const;

/* ================================================================== */
/* INPUT                                                               */
/* ================================================================== */

const returnInput = z.object({
  kind: z.enum(["epfo_ecr", "esic_monthly", "professional_tax"]),
  /** ⭐ A RUN, not a date range. A return files what was actually paid. */
  runNo: z.string().trim().min(1).max(30),
  /** 🔴 Required for professional tax and meaningless for the other two. */
  stateCode: z.string().trim().length(2).toUpperCase().optional(),
  /**
   * ⚠️ Last year's professional tax liability, in paise, as a string.
   * Some States decide monthly-versus-annual filing from it. Absent means
   * absent, and the builder refuses rather than assuming.
   */
  priorYearLiabilityMinor: z.string().trim().regex(/^\d+$/).max(18).optional(),
  /** EPFO establishment / ESIC employer code. File naming only. */
  registrationCode: z.string().trim().max(40).optional(),
});

export type StatutoryReturnInput = z.infer<typeof returnInput>;

/* ================================================================== */
/* ① WHAT CAN BE FILED                                                 */
/* ================================================================== */

export interface FilableRun {
  readonly runNo: string;
  readonly status: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employeeCount: number;
}

export interface StatutoryReturnCatalogue {
  readonly runs: readonly FilableRun[];
  readonly states: readonly string[];
  /** ⚠️ Every file's due date, from the compliance obligation table. */
  readonly kinds: readonly {
    readonly kind: StatutoryReturnKind;
    readonly label: string;
    readonly authority: string;
    readonly needsState: boolean;
  }[];
}

export async function listStatutoryReturns(): Promise<ActionResult<StatutoryReturnCatalogue>> {
  try {
    const ctx = await requireAllPermissions([PAYROLL_READ]);

    const { runs, states } = await withTenant(ctx.tenant.id, async (tx) => {
      const runRows = await tx
        .select({
          runNo: payrollRuns.runNo,
          status: payrollRuns.status,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
          employeeCount: payrollRuns.employeeCount,
        })
        .from(payrollRuns)
        .where(ne(payrollRuns.status, "cancelled"))
        .orderBy(asc(payrollRuns.periodStart))
        .limit(240);

      const stateRows = await tx
        .selectDistinct({ code: employees.workStateCode })
        .from(employees);

      return { runs: runRows, states: stateRows };
    });

    return {
      ok: true,
      data: {
        runs: runs.map((r) => ({
          runNo: r.runNo,
          status: r.status,
          periodStart: String(r.periodStart),
          periodEnd: String(r.periodEnd),
          employeeCount: r.employeeCount,
        })),
        states: [
          ...new Set(states.map((s) => (s.code ?? "").trim().toUpperCase()).filter((s) => s.length === 2)),
        ].sort(),
        kinds: [
          {
            kind: "epfo_ecr",
            label: "EPFO Electronic Challan cum Return",
            authority: "EPFO",
            needsState: false,
          },
          { kind: "esic_monthly", label: "ESIC monthly contribution", authority: "ESIC", needsState: false },
          {
            kind: "professional_tax",
            label: "Professional tax return",
            authority: "State government",
            needsState: true,
          },
        ],
      },
    };
  } catch (err) {
    return toSalesActionError(err, "statutory-returns");
  }
}

/* ================================================================== */
/* ② GENERATION                                                        */
/* ================================================================== */

/**
 * 🔴 ONE EXPORT FOR THREE FILES, AND THE GUARD IS STILL ONE HOP FROM THE
 * EXPORT — the same argument `generateRegister` makes. Three exports
 * would each need their own guard, and the fourth one added next year
 * would be the one that forgets it.
 *
 * ⭐ THE RESULT IS AN OUTCOME UNION, NOT A THROW. A refusal carries the
 * blocking findings and the name of every employee they belong to, which
 * an exception would lose on the way up. `ok: true` with
 * `generated: false` is the good outcome the batch is built around.
 */
export async function generateStatutoryReturn(
  input: StatutoryReturnInput,
): Promise<ActionResult<StatutoryReturnOutcome>> {
  try {
    const parsed = returnInput.parse(input);
    const ctx = await requireAllPermissions([PAYROLL_READ]);

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const runRows = await tx
        .select({
          id: payrollRuns.id,
          status: payrollRuns.status,
          periodStart: payrollRuns.periodStart,
          periodEnd: payrollRuns.periodEnd,
        })
        .from(payrollRuns)
        .where(eq(payrollRuns.runNo, parsed.runNo))
        .limit(1);

      const run = runRows[0];
      if (run === undefined) return null;

      const periodStart = String(run.periodStart);
      const periodEnd = String(run.periodEnd);

      const slips = await tx
        .select({
          employeeId: payslips.employeeId,
          employeeName: payslips.employeeName,
          employeeCode: payslips.employeeCode,
          daysInMonth: payslips.daysInMonth,
          payableDays: payslips.payableDays,
          lopDays: payslips.lopDays,
          grossMinor: payslips.grossMinor,
          pfWagesMinor: payslips.pfWagesMinor,
          employeePfMinor: payslips.employeePfMinor,
          employerPfMinor: payslips.employerPfMinor,
          employerPensionMinor: payslips.employerPensionMinor,
          employeeEsiMinor: payslips.employeeEsiMinor,
          employerEsiMinor: payslips.employerEsiMinor,
          professionalTaxMinor: payslips.professionalTaxMinor,
          uan: employees.uan,
          esicNumber: employees.esicNumber,
          pfExempt: employees.pfExempt,
          esiExempt: employees.esiExempt,
          workStateCode: employees.workStateCode,
          leftOn: employees.leftOn,
        })
        .from(payslips)
        .innerJoin(employees, eq(payslips.employeeId, employees.id))
        .where(eq(payslips.runId, run.id))
        .orderBy(asc(payslips.employeeCode));

      const rates = await loadRates(tx, ctx.tenant.id, periodEnd);

      /**
       * ⭐ THE ESI CONTRIBUTION-PERIOD HISTORY, WHICH IS THE ONLY REASON
       * THIS QUERY EXISTS.
       *
       * ⭐ v1.52.0 (Batch 79): `server/payroll/run.ts` NO LONGER passes
       * `esiCoveredAtPeriodStart: false`; it resolves coverage from the
       * same payslip history through `lib/payroll/esi-coverage.ts`. This
       * query stays anyway, and independently: a return filed against
       * the ESIC portal should not take the payslip's word for who is on
       * the register, or the check below becomes theatre.
       * This reads the EARLIEST payslip each person has in the current
       * contribution period BEFORE this run: if ESI was deducted then,
       * they were an insured person when the period began and remain one
       * until it ends, whatever they now earn.
       */
      const { from: periodFrom } = contributionPeriodRange(periodEnd);
      const history = await tx
        .select({
          employeeId: payslips.employeeId,
          periodEnd: payrollRuns.periodEnd,
          employeeEsiMinor: payslips.employeeEsiMinor,
          employerEsiMinor: payslips.employerEsiMinor,
        })
        .from(payslips)
        .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
        .where(
          and(
            gte(payrollRuns.periodEnd, periodFrom),
            lt(payrollRuns.periodEnd, periodStart),
            ne(payrollRuns.status, "cancelled"),
          ),
        )
        .orderBy(asc(payrollRuns.periodEnd));

      const coveredAtPeriodStart = new Map<string, boolean>();
      for (const h of history) {
        // ⚠️ FIRST ROW WINS, and the query is ordered by period. The
        // EARLIEST payslip in the period is the one that decides.
        if (coveredAtPeriodStart.has(h.employeeId)) continue;
        const ee = paiseFromNumeric(h.employeeEsiMinor) ?? 0n;
        const er = paiseFromNumeric(h.employerEsiMinor) ?? 0n;
        coveredAtPeriodStart.set(h.employeeId, ee > 0n || er > 0n);
      }

      const due = returnDueInfo(parsed.kind, periodEnd);
      if (due === null) return null;

      if (parsed.kind === "epfo_ecr") {
        const members: EcrMemberFacts[] = slips.map((s) => ({
          employeeId: s.employeeId,
          employeeCode: s.employeeCode,
          memberName: s.employeeName,
          uan: s.uan,
          daysInMonth: s.daysInMonth,
          lopCentidays: centidaysFromNumeric(s.lopDays) ?? 0,
          grossMinor: paiseFromNumeric(s.grossMinor) ?? 0n,
          pfWagesMinor: paiseFromNumeric(s.pfWagesMinor) ?? 0n,
          employeePfMinor: paiseFromNumeric(s.employeePfMinor) ?? 0n,
          employerPfMinor: paiseFromNumeric(s.employerPfMinor) ?? 0n,
          employerPensionMinor: paiseFromNumeric(s.employerPensionMinor) ?? 0n,
          // ⚠️ NOT MODELLED, AND SAID SO ON THE FILE rather than implied.
          refundOfAdvancesMinor: 0n,
          pfExempt: s.pfExempt,
        }));
        return buildEcr({
          members,
          pfRules: rates.pf,
          periodStart,
          periodEnd,
          dueOn: due.dueOn,
          dueAuthority: due.authority,
          ifLate: due.ifLate,
          establishmentCode: parsed.registrationCode ?? null,
        });
      }

      if (parsed.kind === "esic_monthly") {
        const people: EsicPersonFacts[] = slips.map((s) => {
          const payable = centidaysFromNumeric(s.payableDays) ?? 0;
          const leftOn = s.leftOn === null ? null : String(s.leftOn);
          /**
           * ⚠️ THE ZERO-DAY REASON CODE IS DERIVED FROM ONE FACT ONLY —
           * whether the person has left. Anything cleverer would be a
           * guess, and the wrong reason code is worse than a rejected
           * row: "left service" against somebody on unpaid leave takes
           * them off the ESI register.
           */
          const reason = payable > 0 ? null : leftOn !== null && leftOn <= periodEnd ? "2" : "1";
          return {
            employeeId: s.employeeId,
            employeeCode: s.employeeCode,
            ipName: s.employeeName,
            ipNumber: s.esicNumber,
            daysInMonth: s.daysInMonth,
            payableCentidays: payable,
            grossMinor: paiseFromNumeric(s.grossMinor) ?? 0n,
            employeeEsiMinor: paiseFromNumeric(s.employeeEsiMinor) ?? 0n,
            employerEsiMinor: paiseFromNumeric(s.employerEsiMinor) ?? 0n,
            coveredAtPeriodStart: coveredAtPeriodStart.get(s.employeeId) ?? false,
            esiExempt: s.esiExempt,
            zeroDayReasonCode: reason,
            lastWorkingDay: reason === "2" ? leftOn : null,
          };
        });
        return buildEsicMonthly({
          people,
          esiRules: rates.esi,
          periodStart,
          periodEnd,
          dueOn: due.dueOn,
          dueAuthority: due.authority,
          ifLate: due.ifLate,
          employerCode: parsed.registrationCode ?? null,
        });
      }

      const people: PtPersonFacts[] = slips.map((s) => ({
        employeeId: s.employeeId,
        employeeCode: s.employeeCode,
        employeeName: s.employeeName,
        workStateCode: s.workStateCode,
        grossMinor: paiseFromNumeric(s.grossMinor) ?? 0n,
        professionalTaxMinor: paiseFromNumeric(s.professionalTaxMinor) ?? 0n,
      }));
      return buildPtReturn({
        people,
        // 🔴 NO DEFAULT STATE. An unstated State is not "the first one we
        // find"; the builder refuses on an empty code, which is right.
        stateCode: parsed.stateCode ?? "",
        periodStart,
        periodEnd,
        dueOn: due.dueOn,
        dueAuthority: due.authority,
        ifLate: due.ifLate,
        priorYearLiabilityMinor:
          parsed.priorYearLiabilityMinor === undefined
            ? null
            : BigInt(parsed.priorYearLiabilityMinor),
      });
    });

    if (outcome === null) {
      return { ok: false, error: "That payroll run does not exist in this workspace." };
    }
    return { ok: true, data: outcome };
  } catch (err) {
    return toSalesActionError(err, "statutory-returns");
  }
}
