"use server";

/**
 * Ordence — ⭐⭐⭐ ADVANCES, LOANS AND REIMBURSEMENTS
 * Version: v1.52.0-alpha
 *
 * ⚠️ EVERY EXPORT IS A BROWSER-REACHABLE ENDPOINT whether or not a screen
 * renders a button for it, so the guard is the FIRST statement of each
 * one. `"use server"` publishes the module, not the page.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PERMISSIONS ARE THE EXISTING PAYROLL ONES, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * Granting somebody an advance is setting a deduction against their
 * future wages, which is the same authority as setting their salary.
 * `payroll.manage` already carries it and inventing a fifth key would
 * mean a permission nobody has been granted and a screen nobody can use.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS MODULE WILL NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO ACTION THAT DEDUCTS AN ARBITRARY AMOUNT. Recovery goes
 * through `recoverInstalment`, which takes the SEQUENCE NUMBER of an
 * agreed instalment and never an amount. s.12 of the Payment of Wages
 * Act, 1936 requires the rules of recovery to be prescribed; an endpoint
 * taking a figure would be the ad-hoc deduction the Act does not permit,
 * and it would be reachable from a browser.
 *
 * 🔴 AND THERE IS NO ACTION THAT SETS A TREATMENT ON A REIMBURSEMENT.
 * `assessReimbursement` derives it from the documents. A `treatment`
 * field on the input would be the tickbox that makes tax disappear.
 *
 * ⚠️ STATED GAP: NOTHING HERE POSTS TO THE LEDGER. An advance is a
 * receivable and belongs on the balance sheet; `advanceLedgerIntent()`
 * names the legs and the account type, and there is no advances posting
 * role configured to write them to. Said out loud rather than half-done.
 */

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  employeeAdvanceInstalments,
  employeeAdvanceRecoveries,
  employeeAdvances,
  employeeReimbursementClaims,
} from "@/db/schema/payroll";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import {
  advanceLedgerIntent,
  advanceStatus,
  buildInstalmentSchedule,
  decidePeriodRecovery,
  deferInstalment,
  type AdvanceAgreement,
  type AdvanceKind,
  type RecoveryLedgerEntry,
  type ScheduledInstalment,
} from "@/lib/payroll/advances";
import {
  EVIDENCE_POLICY_DEFAULT,
  assessReimbursement,
  reimbursementSnapshot,
  type ReimbursementClaim,
} from "@/lib/payroll/reimbursements";
import type { Recovery } from "@/lib/payroll/settlement";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "payroll.read" as const;
const MANAGE = "payroll.manage" as const;

/** ⚠️ Paise as a decimal string. A float never reaches the boundary. */
const minorString = z
  .string()
  .trim()
  .regex(/^\d{1,18}$/, "An amount is a whole number of paise, never a decimal.");

const wagePeriod = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A wage period is YYYY-MM.");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ================================================================== */
/* ① GRANTING AN ADVANCE — THE AGREEMENT AND THE SCHEDULE              */
/* ================================================================== */

const advanceSchema = z.object({
  employeeId: z.string().uuid(),
  advanceNo: z.string().trim().min(1).max(30),
  kind: z.enum(["salary_advance", "welfare_loan", "house_building_loan"]),
  principalMinor: minorString,
  disbursedOn: isoDate,
  instalmentCount: z.number().int().min(1).max(240),
  firstRecoveryPeriod: wagePeriod,
  /** 🔴 s.12 — the rules of recovery must be prescribed. Not optional. */
  agreementReference: z.string().trim().min(1).max(400),
  employeeConsentedOn: isoDate,
  interestRateBp: z.number().int().min(0).max(10_000).default(0),
});

/**
 * ⭐⭐ THE SCHEDULE IS BUILT HERE AND STORED, NOT RECOMPUTED LATER.
 *
 * 🔴 IF THE INSTALMENTS DO NOT SUM TO THE PRINCIPAL, NOTHING IS WRITTEN.
 * `buildInstalmentSchedule` makes the last one absorb the remainder and
 * refuses if the sum still disagrees. A schedule that is a paise out
 * either never closes the advance or takes a paise nobody authorised,
 * and s.7(1) authorises no deduction it does not name.
 */
export async function grantAdvance(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = advanceSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;

    const agreement: AdvanceAgreement = {
      kind: d.kind as AdvanceKind,
      principalMinor: d.principalMinor,
      instalmentCount: d.instalmentCount,
      firstRecoveryPeriod: d.firstRecoveryPeriod,
      agreementReference: d.agreementReference,
      employeeConsentedOn: d.employeeConsentedOn,
      interestRateBp: d.interestRateBp,
      limits: null,
    };

    const schedule = buildInstalmentSchedule(agreement);
    if (schedule.problems.length > 0 || schedule.instalments.length === 0) {
      // 🔴 A REFUSAL CARRIES ITS WORKING. The employer has to know which
      // limb failed in order to fix it.
      return { ok: false, error: schedule.problems.join(" ") || "The schedule could not be built." };
    }

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(employeeAdvances)
        .values({
          tenantId: ctx.tenant.id,
          employeeId: d.employeeId,
          advanceNo: d.advanceNo,
          kind: d.kind,
          principalMinor: d.principalMinor,
          disbursedOn: d.disbursedOn,
          agreementReference: d.agreementReference,
          employeeConsentedOn: d.employeeConsentedOn,
          instalmentCount: d.instalmentCount,
          firstRecoveryPeriod: d.firstRecoveryPeriod,
          interestRateBp: d.interestRateBp,
          createdBy: ctx.user.id,
        })
        .returning({ id: employeeAdvances.id });

      // 🔴 `noUncheckedIndexedAccess` IS ON, AND THIS IS WHY. An empty
      // `returning()` is a write that did NOT happen — a policy refused
      // it — and writing the schedule against "" would orphan it.
      const advanceId = row?.id;
      if (advanceId === undefined) return "";

      await tx.insert(employeeAdvanceInstalments).values(
        schedule.instalments.map((i) => ({
          tenantId: ctx.tenant.id,
          advanceId,
          seq: i.seq,
          period: i.period,
          amountMinor: i.amountMinor.toString(),
        })),
      );
      return advanceId;
    });

    if (id === "") {
      return { ok: false, error: "The advance was not written. Nothing has been scheduled." };
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "employee_advance",
      resourceId: id,
      // ⚠️ NO PRINCIPAL IN THE AUDIT REASON. The audit log is read by
      // more people than the payroll screen, and a figure there would
      // publish through the back door what the permission keeps out.
      newValue: { advanceNo: d.advanceNo, kind: d.kind },
    });

    revalidatePath("/payroll/advances");
    return { ok: true, data: { id } };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* ② THE BALANCE — FOLDED FROM THE LEDGER, EVERY TIME                  */
/* ================================================================== */

/**
 * 🔴 THERE IS NO COUNTER TO READ. The outstanding figure is folded from
 * `employee_advance_recoveries` on every call. See `advanceStatus`.
 */
export async function getAdvanceStatus(
  input: unknown,
): Promise<ActionResult<{ status: Record<string, unknown>; ledgerIntent: unknown }>> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = z.object({ advanceId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: "Which advance?" };

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const [advance] = await tx
        .select()
        .from(employeeAdvances)
        .where(
          and(
            eq(employeeAdvances.tenantId, ctx.tenant.id),
            eq(employeeAdvances.id, parsed.data.advanceId),
          ),
        )
        .limit(1);
      if (advance === undefined) return null;

      const ledger = await tx
        .select()
        .from(employeeAdvanceRecoveries)
        .where(
          and(
            eq(employeeAdvanceRecoveries.tenantId, ctx.tenant.id),
            eq(employeeAdvanceRecoveries.advanceId, advance.id),
          ),
        )
        .orderBy(asc(employeeAdvanceRecoveries.period));

      return { advance, ledger };
    });

    if (data === null) return { ok: false, error: "No such advance." };

    const entries: readonly RecoveryLedgerEntry[] = data.ledger.map((r) => ({
      period: r.period,
      amountMinor: r.amountMinor,
      payslipReference: r.payslipId ?? "",
    }));

    const status = advanceStatus(
      {
        kind: data.advance.kind as AdvanceKind,
        principalMinor: data.advance.principalMinor,
        instalmentCount: data.advance.instalmentCount,
        firstRecoveryPeriod: data.advance.firstRecoveryPeriod,
        agreementReference: data.advance.agreementReference,
        employeeConsentedOn: data.advance.employeeConsentedOn,
        interestRateBp: data.advance.interestRateBp,
        limits: null,
      },
      entries,
      data.advance.writtenOffMinor,
    );

    return {
      ok: true,
      data: {
        status: {
          principalMinor: status.principalMinor.toString(),
          recoveredMinor: status.recoveredMinor.toString(),
          writtenOffMinor: status.writtenOffMinor.toString(),
          outstandingMinor: status.outstandingMinor.toString(),
          overRecoveredMinor: status.overRecoveredMinor.toString(),
          maximumOutstandingMinor: status.maximumOutstandingMinor.toString(),
          perquisiteValuation: status.perquisiteValuation,
          notes: status.notes,
        },
        ledgerIntent: advanceLedgerIntent(data.advance.principalMinor),
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* ③ RECOVERING ONE AGREED INSTALMENT — THE s.7(3) GATE                */
/* ================================================================== */

const recoverSchema = z.object({
  advanceId: z.string().uuid(),
  /** ⭐ A SEQUENCE NUMBER, NOT AN AMOUNT. See the module header. */
  instalmentSeq: z.number().int().min(1),
  period: wagePeriod,
  recoveredOn: isoDate,
  /** The wages of that wage period — the base s.7(3) bites on. */
  wagesForPeriodMinor: minorString,
  /** Every other deduction of the same wage period, as its own head. */
  otherDeductions: z
    .array(
      z.object({
        kind: z.enum([
          "advance_or_overpayment",
          "loan",
          "damage_or_loss",
          "unreturned_asset",
          "co_operative_society",
          "income_tax",
          "provident_fund",
          "notice_shortfall",
        ]),
        description: z.string().trim().max(200),
        amountMinor: minorString,
        reference: z.string().trim().max(200),
      }),
    )
    .default([]),
  payslipId: z.string().uuid().nullish(),
});

/**
 * ⭐⭐ THE ONE CALL A PAYROLL RUN MAKES PER LIVE ADVANCE.
 *
 * 🔴🔴 A RECOVERY THAT WOULD BREACH s.7(3) REFUSES. Nothing is written
 * to the ledger, the instalment is DEFERRED to the far end of the
 * schedule, and the caller is told why. It is not clamped to the
 * headroom: a part-instalment leaves the employer believing the schedule
 * is on track and silently changes figures the employee consented to.
 */
export async function recoverInstalment(
  input: unknown,
): Promise<ActionResult<{ recoveredMinor: string; refused: boolean; problems: readonly string[] }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = recoverSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;

    const outcome = await withTenant(ctx.tenant.id, async (tx) => {
      const [advance] = await tx
        .select()
        .from(employeeAdvances)
        .where(
          and(eq(employeeAdvances.tenantId, ctx.tenant.id), eq(employeeAdvances.id, d.advanceId)),
        )
        .limit(1);
      if (advance === undefined) return null;

      const rows = await tx
        .select()
        .from(employeeAdvanceInstalments)
        .where(
          and(
            eq(employeeAdvanceInstalments.tenantId, ctx.tenant.id),
            eq(employeeAdvanceInstalments.advanceId, d.advanceId),
          ),
        )
        .orderBy(asc(employeeAdvanceInstalments.seq));

      const scheduled: readonly ScheduledInstalment[] = rows.map((r) => ({
        seq: r.seq,
        period: r.period,
        amountMinor: BigInt(r.amountMinor),
      }));
      const target = scheduled.find((s) => s.seq === d.instalmentSeq);
      if (target === undefined) return null;

      const ledger = await tx
        .select()
        .from(employeeAdvanceRecoveries)
        .where(
          and(
            eq(employeeAdvanceRecoveries.tenantId, ctx.tenant.id),
            eq(employeeAdvanceRecoveries.advanceId, d.advanceId),
          ),
        );

      const entries: readonly RecoveryLedgerEntry[] = ledger.map((r) => ({
        period: r.period,
        amountMinor: r.amountMinor,
        payslipReference: r.payslipId ?? "",
      }));

      const status = advanceStatus(
        {
          kind: advance.kind as AdvanceKind,
          principalMinor: advance.principalMinor,
          instalmentCount: advance.instalmentCount,
          firstRecoveryPeriod: advance.firstRecoveryPeriod,
          agreementReference: advance.agreementReference,
          employeeConsentedOn: advance.employeeConsentedOn,
          interestRateBp: advance.interestRateBp,
          limits: null,
        },
        entries,
        advance.writtenOffMinor,
      );

      const others: readonly Recovery[] = d.otherDeductions.map((o) => ({
        kind: o.kind,
        description: o.description,
        amountMinor: o.amountMinor,
        reference: o.reference,
      }));

      /* ---- 🔴 THE CAP, FROM lib/payroll/settlement.ts VIA advances.ts */
      const decision = decidePeriodRecovery({
        period: d.period,
        wagesForPeriodMinor: d.wagesForPeriodMinor,
        otherDeductions: others,
        instalment: target,
        kind: advance.kind as AdvanceKind,
        agreementReference: advance.agreementReference,
        outstandingMinor: status.outstandingMinor,
      });

      if (decision.refused) {
        // ⭐ THE SCHEDULE EXTENDS; THE INSTALMENT DOES NOT SHRINK.
        const deferred = deferInstalment(scheduled, d.instalmentSeq);
        const moved = deferred.find((i) => i.seq === d.instalmentSeq);
        if (moved !== undefined) {
          await tx
            .update(employeeAdvanceInstalments)
            .set({ period: moved.period, deferrals: (rows.find((r) => r.seq === d.instalmentSeq)?.deferrals ?? 0) + 1 })
            .where(
              and(
                eq(employeeAdvanceInstalments.tenantId, ctx.tenant.id),
                eq(employeeAdvanceInstalments.advanceId, d.advanceId),
                eq(employeeAdvanceInstalments.seq, d.instalmentSeq),
              ),
            );
        }
        // 🔴 NO LEDGER ROW. Nothing was taken, so nothing is recorded as
        // taken. The ledger is evidence, not a plan.
        return { decision, written: true };
      }

      if (decision.recoverMinor <= 0n) {
        return { decision, written: true };
      }

      const [inserted] = await tx
        .insert(employeeAdvanceRecoveries)
        .values({
          tenantId: ctx.tenant.id,
          advanceId: d.advanceId,
          payslipId: d.payslipId ?? null,
          period: d.period,
          amountMinor: decision.recoverMinor.toString(),
          instalmentSeq: d.instalmentSeq,
          capBaseMinor: decision.capBaseMinor.toString(),
          capBp: decision.capBp,
          otherDeductionsMinor: decision.otherDeductionsMinor.toString(),
          recoveredOn: d.recoveredOn,
          createdBy: ctx.user.id,
        })
        .returning({ id: employeeAdvanceRecoveries.id });

      // 🔴 An empty `returning()` is a write that did NOT happen.
      return { decision, written: inserted?.id !== undefined };
    });

    if (outcome === null) return { ok: false, error: "No such advance or instalment." };
    if (!outcome.written) {
      return { ok: false, error: "The recovery was not recorded. Nothing has been deducted." };
    }

    await writeAudit(ctx, {
      action: outcome.decision.refused ? "update" : "create",
      resourceType: "employee_advance_recovery",
      resourceId: d.advanceId,
      newValue: { period: d.period, seq: d.instalmentSeq, refused: outcome.decision.refused },
    });

    revalidatePath("/payroll/advances");
    return {
      ok: true,
      data: {
        recoveredMinor: outcome.decision.recoverMinor.toString(),
        refused: outcome.decision.refused,
        problems: outcome.decision.problems,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}

/* ================================================================== */
/* ④ REIMBURSEMENTS — THE EVIDENCE DECIDES THE TAX                     */
/* ================================================================== */

const claimSchema = z.object({
  employeeId: z.string().uuid(),
  claimNo: z.string().trim().min(1).max(30),
  category: z.enum([
    "travel",
    "conveyance",
    "telephone_or_internet",
    "medical",
    "books_and_periodicals",
    "relocation",
    "professional_development",
    "other",
  ]),
  description: z.string().trim().min(1).max(500),
  claimedMinor: minorString,
  incurredOn: isoDate,
  /**
   * 🔴 THE DOCUMENTS ARE THE INPUT. There is deliberately no `treatment`
   * field: a user cannot tick "reimbursement" and make tax go away.
   */
  evidence: z
    .array(
      z.object({
        kind: z.enum([
          "bill",
          "invoice",
          "receipt",
          "boarding_pass",
          "bank_statement",
          "self_declaration",
        ]),
        reference: z.string().trim().min(1).max(200),
        documentDate: isoDate,
        amountMinor: minorString,
      }),
    )
    .default([]),
  incurredForEmployer: z.boolean(),
  recoveredElsewhereMinor: minorString.nullish(),
});

/**
 * ⭐⭐ THE TREATMENT IS DERIVED AND THEN STORED. It is never accepted.
 *
 * ⚠️ A claim with no acceptable document is still PAID — it is
 * reclassified as a taxable allowance, not refused. Refusing would push
 * the employer into paying it outside the payroll, where no tax is
 * deducted at all, which is the worse outcome.
 */
export async function submitReimbursementClaim(
  input: unknown,
): Promise<ActionResult<{ id: string; treatment: string; taxableAllowanceMinor: string }>> {
  try {
    const ctx = await requirePermission(MANAGE);
    const parsed = claimSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Check the form.",
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const d = parsed.data;

    const claim: ReimbursementClaim = {
      category: d.category,
      description: d.description,
      claimedMinor: d.claimedMinor,
      incurredOn: d.incurredOn,
      evidence: d.evidence,
      incurredForEmployer: d.incurredForEmployer,
      recoveredElsewhereMinor: d.recoveredElsewhereMinor ?? null,
    };

    const assessment = assessReimbursement(claim, EVIDENCE_POLICY_DEFAULT);
    if (assessment.problems.length > 0) {
      return { ok: false, error: assessment.problems.join(" ") };
    }
    const snapshot = reimbursementSnapshot(claim, EVIDENCE_POLICY_DEFAULT, assessment);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(employeeReimbursementClaims)
        .values({
          tenantId: ctx.tenant.id,
          employeeId: d.employeeId,
          claimNo: d.claimNo,
          category: d.category,
          description: d.description,
          incurredOn: d.incurredOn,
          claimedMinor: assessment.claimedMinor.toString(),
          evidencedMinor: assessment.evidencedMinor.toString(),
          notWagesMinor: assessment.notWagesMinor.toString(),
          taxableAllowanceMinor: assessment.taxableAllowanceMinor.toString(),
          treatment: assessment.treatment,
          pfOnAllowance: assessment.pfOnAllowance,
          esiOnAllowance: assessment.esiOnAllowance,
          evidence: d.evidence,
          assessment: snapshot,
          incurredForEmployer: d.incurredForEmployer,
          createdBy: ctx.user.id,
        })
        .returning({ id: employeeReimbursementClaims.id });
      return row?.id ?? "";
    });

    if (id === "") {
      return { ok: false, error: "The claim was not written. Nothing has been assessed." };
    }

    await writeAudit(ctx, {
      action: "create",
      resourceType: "employee_reimbursement_claim",
      resourceId: id,
      newValue: { claimNo: d.claimNo, treatment: assessment.treatment },
    });

    revalidatePath("/payroll/reimbursements");
    return {
      ok: true,
      data: {
        id,
        treatment: assessment.treatment,
        taxableAllowanceMinor: assessment.taxableAllowanceMinor.toString(),
      },
    };
  } catch (error) {
    return toSalesActionError(error, "payroll");
  }
}
