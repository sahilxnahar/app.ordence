"use server";

/**
 * Ordence — ⭐ TDS Actions
 * Version: v0.36.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. Schemas live in
 * `lib/validators/tds.ts`, rules in `lib/tds/`. A `"use server"` file
 * that exports anything else publishes it as an RPC endpoint reachable by
 * anyone on the internet.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It asks the right questions before writing and turns a refusal into a
 * sentence somebody can act on.
 *
 * It does NOT make the guarantees. Those are constraints and triggers in
 * `SQL-FILES/0025_phase36_tds.sql`, because this file is one of four
 * write paths — an import of a year of historical payments, a support fix
 * at a psql prompt and a future payment-run API are the others — and a
 * rule enforced in one of four places is a rule the other three will
 * bypass. The import is where the volume is, and the import is exactly
 * where each payment gets tested in isolation.
 *
 * ⭐ AND IT NEVER TAKES A RATE FROM THE CALLER. `recordDeduction` re-runs
 * the whole assessment — the year's accumulation, the threshold, 206AA,
 * 206AB, the Section 197 window — against the register at write time. A
 * form that posted a rate would let a person change one, and a 0.5%
 * deduction under a 2% section posted from a browser is indistinguishable
 * in the register from a lawful certificate rate.
 *
 * ⚠️ MONEY CROSSES THE BOUNDARY AS A STRING. `JSON.stringify` throws on a
 * bigint, so every amount returned here goes through `serializeAmount`.
 */

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/db";
import {
  tdsDeductees,
  tdsLowerDeductionCertificates,
  tdsChallans,
  tdsReturns,
  tdsDeductions,
  tdsCertificates,
} from "@/db/schema/tds";
import { requirePermission, writeAudit } from "@/server/audit";
import { guardTdsWrite, tdsFail, toTdsActionError } from "@/server/tds/guards";
import {
  upsertDeducteeSchema,
  upsertLowerDeductionCertificateSchema,
  assessDeductionSchema,
  recordDeductionSchema,
  recordChallanSchema,
  mapDeductionsToChallanSchema,
  buildReturnSchema,
  fileReturnSchema,
  buildCertificatesSchema,
  registerQuerySchema,
  interestExposureQuerySchema,
  thresholdSweepSchema,
} from "@/lib/validators/tds";
import {
  findDeductee,
  findDeductions,
  listChallans,
  listDeductees,
  listDeductions,
  loadAccumulationGroups,
  toChallanFacts,
  toRegisterEntry,
} from "@/server/tds/registry";
import { assessDeduction as runAssessment } from "@/server/tds/engine";
import { measureForeignPayment } from "@/server/tds/foreign-payment";
import { RULE_26_TT_BUYING } from "@/lib/fx/statutory";
import { formatRateScaled } from "@/lib/fx/rates";
import {
  assembleQuarterCertificates,
  assembleReturn,
  assessInterestExposure,
  certificateDueDate,
  deducteeClassOf,
  findThresholdShortfalls,
  normalRateBps,
  reconcileRegisterToChallans,
  returnDueDate,
  summariseRegister,
  validateReturn,
  assessLateFiling,
  assessmentYearOf,
} from "@/lib/tds";
import { parseMoney, serializeAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";
import type { TdsQuarter, TdsSectionCode } from "@/db/schema/tds";
/**
 * ⭐ THE SECTION TABLE IS THE STATUTE. The form is built from it rather
 * than from a list somebody typed, so a section this product knows about
 * cannot be one the form has never heard of.
 */
import { TDS_SECTION_CODES, sectionRule } from "@/lib/tds/sections";

/* ------------------------------------------------------------------ */
/* SERIALISABLE SHAPES                                                 */
/* ------------------------------------------------------------------ */

export type DeducteeRow = {
  id: string;
  code: string;
  legalName: string;
  panNumber: string | null;
  panStatus: string;
  deducteeType: string;
  isNonResident: boolean;
  isSpecifiedPerson206ab: boolean;
  specifiedPersonCheckedOn: string | null;
  vendorId: string | null;
  channelPartnerId: string | null;
  isActive: boolean;
};

export type DeductionRow = {
  id: string;
  deducteeId: string;
  section: string;
  financialYear: string;
  quarter: string;
  deductionDate: string;
  paymentBaseMinor: string;
  catchUpBaseMinor: string;
  chargeableBaseMinor: string;
  aggregateBeforeMinor: string;
  aggregateAfterMinor: string;
  rateBps: number;
  rateBasis: string;
  statutoryRef: string | null;
  tdsMinor: string;
  totalDeductedMinor: string;
  outcome: string;
  challanId: string | null;
  explanation: string | null;
};

/* ------------------------------------------------------------------ */
/* DEDUCTEES                                                           */
/* ------------------------------------------------------------------ */

export async function getDeductees(
  includeInactive?: boolean,
): Promise<ActionResult<{ rows: DeducteeRow[] }>> {
  try {
    // ⚠️ READ: permission only. An entitlement gate here would refuse to
    // RENDER the page rather than refusing the button on it.
    const ctx = await requirePermission("tds:read");
    const rows = await listDeductees(ctx.tenant.id, {
      includeInactive: includeInactive === true,
    });
    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          code: r.code,
          legalName: r.legalName,
          panNumber: r.panNumber,
          panStatus: r.panStatus,
          deducteeType: r.deducteeType,
          isNonResident: r.isNonResident,
          isSpecifiedPerson206ab: r.isSpecifiedPerson206ab,
          specifiedPersonCheckedOn: r.specifiedPersonCheckedOn,
          vendorId: r.vendorId,
          channelPartnerId: r.channelPartnerId,
          isActive: r.isActive,
        })),
      },
    };
  } catch (err) {
    return toTdsActionError(err, "getDeductees");
  }
}

/**
 * ⭐⭐⭐ EVERYTHING THE DEDUCTION FORM NEEDS TO RENDER, IN ONE CALL.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 WHY THIS DID NOT EXIST, AND IT IS THE WORST INSTANCE YET
 * ══════════════════════════════════════════════════════════════════════
 * `recordDeduction` below is the ONLY INSERT INTO `tds_deductions`
 * anywhere in this product. `server/mcp/dispatch.ts` reads the table;
 * `server/actions/reports.ts` reads it; nothing else writes it.
 *
 * And until this batch, `recordDeduction` WAS CALLED BY NOTHING. No
 * screen, no route, no job. `/tds` imports `getDeductees`, `getRegister`
 * and `getInterestExposure` — three reads. So:
 *
 *   • the register could never receive a row;
 *   • `getInterestExposure` could only ever report zero;
 *   • `buildQuarterlyReturn` could only ever produce an empty 26Q;
 *   • `buildCertificates` could only ever produce an empty 16A;
 *   • and the Rule 26 foreign-payment engine added in 0106 sat behind
 *     all of it, with the `foreignPayment` argument reachable from
 *     nowhere.
 *
 * ⚠️ AND THE SCREEN LOOKED FINE. `/tds` renders "undeposited TDS" and
 * "interest exposure" panels which were correct, empty and reassuring.
 * A statutory module from 0025 onwards, with no way in, showing zeroes
 * that read as "nothing owed".
 *
 * ⭐ THIS IS THE THIRTEENTH TIME THIS PRODUCT HAS SHIPPED A CAPABILITY
 * NOTHING COULD REACH — approval policies, `requireMfa`, 34 of 71
 * entitlement keys, dunning letters that queued and never sent, RERA
 * notices recording their own service, ESI hardcoded, `valuationMethod`
 * read at zero computations, `bank_accounts.reconciled_to`, `0087`
 * citing a trigger that did not exist, `suggestSlugs` unused on the
 * workspace-creation path, `0100`'s depreciation engine unreachable for
 * four batches, `settings.clerkSlug` written and never reconciled, and
 * `/banking` in no navigation since v1.18.0. It is also the largest.
 *
 * ⚠️ `tds:read` ONLY. This is what the form needs to draw itself. The
 * write permission is checked by `recordDeduction`, where the write is.
 */
export async function getDeductionFormOptions(): Promise<
  ActionResult<{
    deductees: DeducteeRow[];
    sections: Array<{
      code: string;
      label: string;
      statutoryRef: string;
      /**
       * ⚠️ FALSE FOR 192 AND 195, and the form must say so BEFORE the
       * person fills it in. The engine refuses to invent those rates —
       * salary is a projected annual liability and a non-resident's rate
       * is whichever of the Act and the DTAA is more beneficial — so
       * those two need a rate and a written reason, and a form that
       * discovers this on submit has wasted somebody's afternoon.
       */
      rateResolvable: boolean;
      note: string;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("tds:read");
    const rows = await listDeductees(ctx.tenant.id, { includeInactive: false });

    return {
      ok: true,
      data: {
        deductees: rows.map((r) => ({
          id: r.id,
          code: r.code,
          legalName: r.legalName,
          panNumber: r.panNumber,
          panStatus: r.panStatus,
          deducteeType: r.deducteeType,
          isNonResident: r.isNonResident,
          isSpecifiedPerson206ab: r.isSpecifiedPerson206ab,
          specifiedPersonCheckedOn: r.specifiedPersonCheckedOn,
          vendorId: r.vendorId,
          channelPartnerId: r.channelPartnerId,
          isActive: r.isActive,
        })),
        /**
         * ⭐ BUILT FROM `TDS_SECTIONS`, NOT RETYPED. A hand-written list
         * here would be a second copy of the statute, and the drift
         * would be silent in the direction that matters: a section
         * missing from this list is a deduction nobody can record.
         */
        sections: TDS_SECTION_CODES.map((code) => {
          const rule = sectionRule(code);
          return {
            code: rule.code,
            label: rule.label,
            statutoryRef: rule.statutoryRef,
            rateResolvable: rule.rateResolvable,
            note: rule.note,
          };
        }),
      },
    };
  } catch (err) {
    return toTdsActionError(err, "getDeductionFormOptions");
  }
}

export async function upsertDeductee(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:manage_deductees",
      feature: "tds.deductions",
      permission: "tds:manage_deductees",
    });

    const data = upsertDeducteeSchema.parse(input);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        code: data.code,
        legalName: data.legalName,
        panNumber: data.panNumber ?? null,
        panStatus: data.panStatus,
        panVerifiedOn: data.panVerifiedOn ?? null,
        deducteeType: data.deducteeType,
        isNonResident: data.isNonResident,
        isSpecifiedPerson206ab: data.isSpecifiedPerson206ab,
        specifiedPersonCheckedOn: data.specifiedPersonCheckedOn ?? null,
        specifiedPersonReference: data.specifiedPersonReference ?? null,
        vendorId: data.vendorId ?? null,
        channelPartnerId: data.channelPartnerId ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(tdsDeductees)
          .set(values)
          .where(
            and(eq(tdsDeductees.tenantId, ctx.tenant.id), eq(tdsDeductees.id, data.id)),
          )
          .returning({ id: tdsDeductees.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tdsDeductees)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tdsDeductees.id });
      return row?.id ?? null;
    });

    if (!id) return tdsFail("That deductee no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "tds_deductee",
      resourceId: id,
      // ⚠️ THE PAN IS NOT LOGGED. It is a third party's government
      // identity number and the audit log is read far more widely than the
      // register is. `panStatus` answers the question a reviewer actually
      // has — "did this change what we deduct?" — without carrying the
      // number into another table.
      newValue: {
        code: data.code,
        panStatus: data.panStatus,
        deducteeType: data.deducteeType,
        isSpecifiedPerson206ab: data.isSpecifiedPerson206ab,
      },
    });

    revalidatePath("/tds/deductees");
    return { ok: true, data: { id } };
  } catch (err) {
    return toTdsActionError(err, "upsertDeductee");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ SECTION 197 CERTIFICATES                                          */
/* ------------------------------------------------------------------ */

export async function upsertLowerDeductionCertificate(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:manage_deductees",
      feature: "tds.deductions",
      permission: "tds:manage_deductees",
    });

    const data = upsertLowerDeductionCertificateSchema.parse(input);

    // ⚠️ 206AA(4): the Assessing Officer may not grant a certificate under
    // Section 197 unless a PAN is quoted. A certificate against a PAN-less
    // deductee is a document that cannot exist, and recording one would
    // put a 0.5% rate on a payee the law says is a 20% payee.
    const deductee = await findDeductee(ctx.tenant.id, data.deducteeId);
    if (!deductee) return tdsFail("That deductee does not exist in this workspace.");
    if (!deductee.panNumber || deductee.panStatus !== "valid") {
      return tdsFail(
        "That deductee has no usable PAN, so a Section 197 certificate cannot " +
          "apply to them. Section 206AA(4) forbids the Assessing Officer from " +
          "granting one unless a PAN is quoted — either the PAN record is wrong or " +
          "the certificate is, and until that is settled the deduction is at 20%.",
      );
    }

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        deducteeId: data.deducteeId,
        certificateNumber: data.certificateNumber,
        section: data.section as TdsSectionCode,
        rateBps: data.rateBps,
        validFrom: data.validFrom,
        validTo: data.validTo,
        capBaseMinor: data.capBaseMinor ? parseMoney(data.capBaseMinor) : null,
        financialYear: data.financialYear,
        isActive: data.isActive,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(tdsLowerDeductionCertificates)
          .set(values)
          .where(
            and(
              eq(tdsLowerDeductionCertificates.tenantId, ctx.tenant.id),
              eq(tdsLowerDeductionCertificates.id, data.id),
            ),
          )
          .returning({ id: tdsLowerDeductionCertificates.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tdsLowerDeductionCertificates)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tdsLowerDeductionCertificates.id });
      return row?.id ?? null;
    });

    if (!id) return tdsFail("That certificate no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "tds_lower_deduction_certificate",
      resourceId: id,
      newValue: {
        certificateNumber: data.certificateNumber,
        section: data.section,
        rateBps: data.rateBps,
        validFrom: data.validFrom,
        validTo: data.validTo,
      },
    });

    revalidatePath("/tds/certificates");
    return { ok: true, data: { id } };
  } catch (err) {
    return toTdsActionError(err, "upsertLowerDeductionCertificate");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE ASSESSMENT, BEFORE ANYTHING IS WRITTEN                      */
/* ------------------------------------------------------------------ */
/* ⭐⭐ RULE 26 · THE RUPEE BASE OF A PAYMENT IN FOREIGN CURRENCY       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE PLACE THAT TURNS A DEDUCTION INPUT INTO A RUPEE PAYMENT BASE.
 *
 * ⚠️ BOTH ACTIONS BELOW GO THROUGH IT, AND THAT IS THE POINT. `assess`
 * shows the operator a figure before the money moves and `record` writes
 * one; if they computed the base differently the screen would promise one
 * deduction and the register would hold another. The difference between
 * them is only that `record` keeps the working to store on the row.
 */
type ResolvedPaymentBase = {
  paymentBaseMinor: bigint;
  deductionDate: string;
  /** Null on a rupee payment. The Rule 26 working, for the row. */
  foreign: {
    currency: string;
    amountMinor: bigint;
    rateScaled: bigint;
    rateDate: string;
    rateType: string;
    rateSource: string;
    rateId: string | null;
    statutoryRef: string;
    creditDate: string | null;
    paymentDate: string | null;
    explanation: string;
  } | null;
};

async function resolvePaymentBase(
  tenantId: string,
  data: {
    paymentBaseMinor?: string | null;
    deductionDate: string;
    foreignPayment?: {
      currency: string;
      amountMinor: string;
      creditDate?: string | null;
      paymentDate?: string | null;
    } | null;
  },
): Promise<ResolvedPaymentBase> {
  if (!data.foreignPayment) {
    // The schema's `exactlyOneBase` has already refused the case where
    // neither is present, so this is a rupee payment with a rupee base.
    return {
      paymentBaseMinor: parseMoney(data.paymentBaseMinor ?? "0"),
      deductionDate: data.deductionDate,
      foreign: null,
    };
  }

  const measured = await measureForeignPayment(tenantId, {
    foreignAmountMinor: BigInt(data.foreignPayment.amountMinor),
    foreignCurrency: data.foreignPayment.currency,
    creditDate: data.foreignPayment.creditDate ?? null,
    paymentDate: data.foreignPayment.paymentDate ?? null,
  });

  /**
   * 🔴 THE DEDUCTION DATE IS DERIVED AND THEN CHECKED AGAINST THE ONE THE
   * CALLER SENT, AND A DISAGREEMENT IS REFUSED RATHER THAN RESOLVED.
   *
   * Silently preferring the derived date would be defensible arithmetic
   * and indefensible practice: the operator would see one date on the
   * screen and another in the register, and under Rule 26 the date is also
   * the rate — so the figure they approved would not be the figure that
   * was posted. Refusing puts the disagreement in front of the person who
   * can settle it.
   */
  if (measured.date.deductionDate !== data.deductionDate) {
    throw new Error(
      `The deduction date given is ${data.deductionDate}, but the tax on this payment is ` +
        `required to be deducted on ${measured.date.deductionDate}. ` +
        `${measured.date.explanation} Nothing has been recorded. Under Rule 26 that date is ` +
        `also the date whose telegraphic transfer buying rate measures the payment in ` +
        `rupees, so the two cannot differ.`,
    );
  }

  return {
    paymentBaseMinor: measured.base.chargeableBaseMinor,
    deductionDate: measured.date.deductionDate,
    foreign: {
      currency: measured.base.foreignCurrency,
      amountMinor: measured.base.foreignAmountMinor,
      rateScaled: measured.base.quote.rateScaled,
      rateDate: measured.base.quote.rateDate,
      rateType: measured.base.quote.rateType,
      rateSource: measured.base.quote.source,
      rateId: measured.base.quote.rateId,
      statutoryRef: measured.base.statutoryRef,
      creditDate: measured.date.creditDate,
      paymentDate: measured.date.paymentDate,
      explanation: `${measured.date.explanation} ${measured.base.explanation}`,
    },
  };
}

/* ------------------------------------------------------------------ */

/**
 * ⭐ "What comes off this payment?" — answered before the transfer.
 *
 * ⚠️ THIS EXISTS SO THE PAYMENT SCREEN CAN ASK FIRST. When the annual
 * threshold is crossed, the tax on a ₹25,000 payment is ₹1,000 and not
 * ₹250 — the contractor receives ₹24,000. That is a conversation, and it
 * is a much shorter one had before the money moves than after it.
 *
 * ⚠️ NO ENTITLEMENT GATE AND NO WRITE PERMISSION — `tds:read` only.
 * Telling somebody what the law requires them to withhold is not a paid
 * feature and is not a privileged act; refusing to tell them is how the
 * wrong number reaches a vendor.
 */
export async function assessDeduction(input: unknown): Promise<
  ActionResult<{
    section: string;
    outcome: string;
    chargeable: boolean;
    trigger: string;
    aggregateBeforeMinor: string;
    aggregateAfterMinor: string;
    paymentBaseMinor: string;
    catchUpBaseMinor: string;
    chargeableBaseMinor: string;
    rateBps: number;
    rateBasis: string;
    statutoryRef: string;
    tdsMinor: string;
    netPayableMinor: string;
    explanation: string;
    warnings: string[];
    problem: string | null;
  }>
> {
  try {
    const ctx = await requirePermission("tds:read");
    const data = assessDeductionSchema.parse(input);

    // ⭐ RULE 26 — a foreign payment's rupee base before anything is shown.
    const base = await resolvePaymentBase(ctx.tenant.id, data);

    const assessed = await runAssessment(ctx.tenant.id, {
      deducteeId: data.deducteeId,
      section: data.section as TdsSectionCode,
      paymentBaseMinor: base.paymentBaseMinor,
      deductionDate: base.deductionDate,
    });

    return {
      ok: true,
      data: {
        section: assessed.section,
        outcome: assessed.outcome,
        chargeable: assessed.threshold.chargeable,
        trigger: assessed.threshold.trigger,
        aggregateBeforeMinor: serializeAmount(assessed.row.aggregateBeforeMinor),
        aggregateAfterMinor: serializeAmount(assessed.row.aggregateAfterMinor),
        paymentBaseMinor: serializeAmount(assessed.row.paymentBaseMinor),
        catchUpBaseMinor: serializeAmount(assessed.row.catchUpBaseMinor),
        chargeableBaseMinor: serializeAmount(assessed.row.chargeableBaseMinor),
        rateBps: assessed.row.rateBps,
        rateBasis: assessed.resolution.basis,
        statutoryRef: assessed.resolution.statutoryRef,
        tdsMinor: serializeAmount(assessed.row.tdsMinor),
        netPayableMinor: serializeAmount(assessed.computation.netPayableMinor),
        explanation: base.foreign
          ? `${base.foreign.explanation} ${assessed.explanation}`
          : assessed.explanation,
        warnings: assessed.warnings,
        problem: assessed.problem,
      },
    };
  } catch (err) {
    return toTdsActionError(err, "assessDeduction");
  }
}

/**
 * ⭐ RECORD THE DEDUCTION.
 *
 * ⚠️ THE ASSESSMENT IS RE-RUN HERE. The caller's earlier `assessDeduction`
 * answer is not trusted and not reused: between the two calls another
 * payment to the same deductee may have crossed the threshold, and the
 * figure the screen showed would then be a ₹250 deduction on a payment
 * that owes ₹1,000. Re-running costs one indexed range scan.
 */
export async function recordDeduction(
  input: unknown,
): Promise<ActionResult<{ id: string; tdsMinor: string; explanation: string }>> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:deduct",
      feature: "tds.deductions",
      permission: "tds:deduct",
      impersonationOperation: "tds:deduct",
    });

    const data = recordDeductionSchema.parse(input);

    // ⭐ RULE 26 — recomputed here rather than carried from the assessment
    // screen, for the same reason the assessment itself is re-run: the rate
    // for the deduction date may have been corrected in between, and the
    // figure that is posted has to be the one on file now.
    const base = await resolvePaymentBase(ctx.tenant.id, data);

    const assessed = await runAssessment(ctx.tenant.id, {
      deducteeId: data.deducteeId,
      section: data.section as TdsSectionCode,
      paymentBaseMinor: base.paymentBaseMinor,
      deductionDate: base.deductionDate,
      manualRateBps: data.manualRateBps ?? null,
      manualRateReason: data.manualRateReason ?? null,
    });

    // ⚠️ 192 and 195 without a rate are refused rather than recorded at
    // zero. A zero deduction from an employee or a non-resident is the
    // largest silent default available in Chapter XVII-B.
    if (assessed.problem) return tdsFail(assessed.problem);

    const surcharge = data.surchargeMinor ? parseMoney(data.surchargeMinor) : 0n;
    const cess = data.cessMinor ? parseMoney(data.cessMinor) : 0n;

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const [row] = await tx
        .insert(tdsDeductions)
        .values({
          tenantId: ctx.tenant.id,
          deducteeId: data.deducteeId,
          section: assessed.section,
          financialYear: assessed.financialYear,
          quarter: assessed.quarter,
          deductionDate: base.deductionDate,
          /**
           * ⭐ THE RULE 26 WORKING, ON THE ROW. The CHECK
           * `tds_deductions_rule_26_complete` refuses the row unless the
           * rate type is 'tt_buying' and the rate date IS the deduction
           * date, so a future writer that skipped this file cannot post a
           * foreign-currency deduction measured at anything else.
           */
          creditDate: base.foreign?.creditDate ?? null,
          paymentDate: base.foreign?.paymentDate ?? null,
          paymentCurrency: base.foreign?.currency ?? null,
          foreignPaymentBaseMinor: base.foreign?.amountMinor ?? null,
          fxRate: base.foreign ? formatRateScaled(base.foreign.rateScaled) : null,
          fxRateDate: base.foreign?.rateDate ?? null,
          fxRateType: base.foreign?.rateType ?? null,
          fxRateSource: base.foreign?.rateSource ?? null,
          fxRateId: base.foreign?.rateId ?? null,
          fxStatutoryRef: base.foreign?.statutoryRef ?? null,
          paymentBaseMinor: assessed.row.paymentBaseMinor,
          catchUpBaseMinor: assessed.row.catchUpBaseMinor,
          chargeableBaseMinor: assessed.row.chargeableBaseMinor,
          aggregateBeforeMinor: assessed.row.aggregateBeforeMinor,
          aggregateAfterMinor: assessed.row.aggregateAfterMinor,
          rateBps: assessed.row.rateBps,
          rateBasis: assessed.resolution.basis,
          lowerDeductionCertificateId: assessed.row.lowerDeductionCertificateId,
          statutoryRef: assessed.resolution.statutoryRef,
          explanation: base.foreign
            ? `${base.foreign.explanation} ${assessed.explanation}`
            : assessed.explanation,
          tdsMinor: assessed.row.tdsMinor,
          surchargeMinor: assessed.outcome === "deducted" ? surcharge : 0n,
          cessMinor: assessed.outcome === "deducted" ? cess : 0n,
          totalDeductedMinor:
            assessed.outcome === "deducted"
              ? assessed.row.tdsMinor + surcharge + cess
              : assessed.row.tdsMinor,
          outcome: assessed.outcome,
          purchaseInvoiceId: data.purchaseInvoiceId ?? null,
          vendorId: data.vendorId ?? null,
          projectId: data.projectId ?? null,
          channelPartnerId: data.channelPartnerId ?? null,
          referenceNumber: data.referenceNumber ?? null,
          description: data.description ?? null,
          createdBy: ctx.user.id,
        })
        .returning({ id: tdsDeductions.id });
      return row?.id ?? null;
    });

    if (!id) return tdsFail("The deduction could not be recorded.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "tds_deduction",
      resourceId: id,
      newValue: {
        section: assessed.section,
        rateBps: assessed.row.rateBps,
        rateBasis: assessed.resolution.basis,
        chargeableBaseMinor: serializeAmount(assessed.row.chargeableBaseMinor),
        catchUpBaseMinor: serializeAmount(assessed.row.catchUpBaseMinor),
        tdsMinor: serializeAmount(assessed.row.tdsMinor),
        // ⭐ WHICH RATE MEASURED THIS BASE, IN THE AUDIT TRAIL. "Why is
        // the base ₹83,60,000" is the first question of a s.201 enquiry.
        ...(base.foreign
          ? {
              paymentCurrency: base.foreign.currency,
              foreignAmountMinor: base.foreign.amountMinor.toString(),
              fxRate: formatRateScaled(base.foreign.rateScaled),
              fxRateDate: base.foreign.rateDate,
              fxRateType: base.foreign.rateType,
              fxStatutoryRef: base.foreign.statutoryRef,
            }
          : {}),
      },
      reason: base.foreign
        ? `${base.foreign.explanation} ${assessed.explanation}`
        : assessed.explanation,
    });

    revalidatePath("/tds/register");
    return {
      ok: true,
      data: {
        id,
        tdsMinor: serializeAmount(assessed.row.tdsMinor),
        explanation: assessed.explanation,
      },
    };
  } catch (err) {
    return toTdsActionError(err, "recordDeduction");
  }
}

/* ------------------------------------------------------------------ */
/* THE REGISTER                                                        */
/* ------------------------------------------------------------------ */

export async function getRegister(input: unknown): Promise<
  ActionResult<{
    rows: DeductionRow[];
    summary: {
      totalPaidBaseMinor: string;
      totalChargeableBaseMinor: string;
      totalTdsMinor: string;
      totalDepositedMinor: string;
      totalUndepositedMinor: string;
      totalCatchUpBaseMinor: string;
      deducteeCount: number;
      deductionCount: number;
      bySection: Array<{
        section: string;
        label: string;
        paidBaseMinor: string;
        chargeableBaseMinor: string;
        tdsMinor: string;
        undepositedMinor: string;
        deductionCount: number;
        belowThresholdCount: number;
      }>;
      byRateBasis: Array<{ basis: string; count: number; tdsMinor: string }>;
    };
  }>
> {
  try {
    const ctx = await requirePermission("tds:read");
    const data = registerQuerySchema.parse(input);

    const rows = await listDeductions(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: (data.quarter as TdsQuarter | null) ?? null,
      deducteeId: data.deducteeId ?? null,
      section: (data.section as TdsSectionCode | null) ?? null,
    });

    const summary = summariseRegister(rows.map((r) => toRegisterEntry(r)), {
      financialYear: data.financialYear,
      ...(data.quarter ? { quarter: data.quarter as TdsQuarter } : {}),
    });

    return {
      ok: true,
      data: {
        rows: rows.map(toDeductionRow),
        summary: {
          totalPaidBaseMinor: serializeAmount(summary.totalPaidBaseMinor),
          totalChargeableBaseMinor: serializeAmount(summary.totalChargeableBaseMinor),
          totalTdsMinor: serializeAmount(summary.totalTdsMinor),
          totalDepositedMinor: serializeAmount(summary.totalDepositedMinor),
          totalUndepositedMinor: serializeAmount(summary.totalUndepositedMinor),
          totalCatchUpBaseMinor: serializeAmount(summary.totalCatchUpBaseMinor),
          deducteeCount: summary.deducteeCount,
          deductionCount: summary.deductionCount,
          bySection: summary.bySection.map((s) => ({
            section: s.section,
            label: s.label,
            paidBaseMinor: serializeAmount(s.paidBaseMinor),
            chargeableBaseMinor: serializeAmount(s.chargeableBaseMinor),
            tdsMinor: serializeAmount(s.tdsMinor),
            undepositedMinor: serializeAmount(s.undepositedMinor),
            deductionCount: s.deductionCount,
            belowThresholdCount: s.belowThresholdCount,
          })),
          byRateBasis: Object.entries(summary.byRateBasis).map(([basis, v]) => ({
            basis,
            count: v?.count ?? 0,
            tdsMinor: serializeAmount(v?.tdsMinor ?? 0n),
          })),
        },
      },
    };
  } catch (err) {
    return toTdsActionError(err, "getRegister");
  }
}

/**
 * ⭐ THE SHORTFALL SWEEP.
 *
 * Who has crossed an annual threshold and not been caught up? Every
 * workspace arrives with a year of history entered by somebody who tested
 * each payment on its own, and this is the query that finds it before an
 * assessment does — while the contractor is still on site and the
 * shortfall can still be recovered from the next running-account bill.
 */
export async function sweepThresholdShortfalls(input: unknown): Promise<
  ActionResult<{
    findings: Array<{
      deducteeId: string;
      deducteeName: string;
      section: string;
      aggregateMinor: string;
      chargedMinor: string;
      unchargedMinor: string;
      shortfallTaxMinor: string;
      message: string;
    }>;
    totalShortfallTaxMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission("tds:read");
    const data = thresholdSweepSchema.parse(input);

    const groups = await loadAccumulationGroups(ctx.tenant.id, data.financialYear);
    const deductees = await listDeductees(ctx.tenant.id, { includeInactive: true });
    const nameById = new Map(deductees.map((d) => [d.id, d]));

    const withRates = groups.map((g) => {
      const deductee = nameById.get(g.deducteeId);
      const rate =
        deductee &&
        normalRateBps(g.section, deducteeClassOf(deductee.deducteeType));
      return { ...g, rateBps: rate ?? 0 };
    });

    const findings = findThresholdShortfalls(withRates);
    let total = 0n;
    for (const f of findings) total += f.shortfallTaxMinor;

    return {
      ok: true,
      data: {
        findings: findings.map((f) => ({
          deducteeId: f.deducteeId,
          deducteeName: nameById.get(f.deducteeId)?.legalName ?? f.deducteeId,
          section: f.section,
          aggregateMinor: serializeAmount(f.aggregateMinor),
          chargedMinor: serializeAmount(f.chargedMinor),
          unchargedMinor: serializeAmount(f.uncharged),
          shortfallTaxMinor: serializeAmount(f.shortfallTaxMinor),
          message: f.message,
        })),
        totalShortfallTaxMinor: serializeAmount(total),
      },
    };
  } catch (err) {
    return toTdsActionError(err, "sweepThresholdShortfalls");
  }
}

/* ------------------------------------------------------------------ */
/* CHALLANS                                                            */
/* ------------------------------------------------------------------ */

export async function recordChallan(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:manage_challans",
      feature: "tds.deductions",
      permission: "tds:manage_challans",
      impersonationOperation: "tds:manage_challans",
    });

    const data = recordChallanSchema.parse(input);

    const tax = parseMoney(data.taxMinor);
    const surcharge = parseMoney(data.surchargeMinor);
    const cess = parseMoney(data.cessMinor);
    const interest = parseMoney(data.interestMinor);
    const fee = parseMoney(data.feeMinor);

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        tan: data.tan,
        bsrCode: data.bsrCode,
        challanSerial: data.challanSerial,
        depositDate: data.depositDate,
        financialYear: data.financialYear,
        assessmentYear: assessmentYearOf(data.financialYear),
        quarter: data.quarter,
        section: (data.section as TdsSectionCode | null) ?? null,
        taxMinor: tax,
        surchargeMinor: surcharge,
        cessMinor: cess,
        interestMinor: interest,
        feeMinor: fee,
        totalMinor: tax + surcharge + cess + interest + fee,
        status: data.status,
        bankReference: data.bankReference ?? null,
        notes: data.notes ?? null,
      };

      if (data.id) {
        const [row] = await tx
          .update(tdsChallans)
          .set(values)
          .where(
            and(eq(tdsChallans.tenantId, ctx.tenant.id), eq(tdsChallans.id, data.id)),
          )
          .returning({ id: tdsChallans.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tdsChallans)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tdsChallans.id });
      return row?.id ?? null;
    });

    if (!id) return tdsFail("That challan no longer exists.");

    await writeAudit(ctx, {
      action: data.id ? "update" : "create",
      resourceType: "tds_challan",
      resourceId: id,
      newValue: {
        bsrCode: data.bsrCode,
        challanSerial: data.challanSerial,
        depositDate: data.depositDate,
        totalMinor: serializeAmount(tax + surcharge + cess + interest + fee),
      },
    });

    revalidatePath("/tds/challans");
    return { ok: true, data: { id } };
  } catch (err) {
    return toTdsActionError(err, "recordChallan");
  }
}

/**
 * ⭐ ATTACH DEDUCTIONS TO A CHALLAN.
 *
 * ⚠️ THE OVER-UTILISATION IS REFUSED HERE **AND** BY THE DATABASE (SQL
 * 0025 §7). Here, so the person gets a sentence naming the shortfall;
 * there, because this is one write path of several and an import is where
 * a hundred deductions get attached to one challan.
 */
export async function mapDeductionsToChallan(
  input: unknown,
): Promise<ActionResult<{ mapped: number; utilisedMinor: string; capacityMinor: string }>> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:manage_challans",
      feature: "tds.deductions",
      permission: "tds:manage_challans",
      impersonationOperation: "tds:manage_challans",
    });

    const data = mapDeductionsToChallanSchema.parse(input);

    const result = await withTenant(ctx.tenant.id, async (tx) => {
      const updated = await tx
        .update(tdsDeductions)
        .set({ challanId: data.challanId })
        .where(
          and(
            eq(tdsDeductions.tenantId, ctx.tenant.id),
            inArray(tdsDeductions.id, data.deductionIds),
          ),
        )
        .returning({ id: tdsDeductions.id });
      return updated.length;
    });

    const [challan] = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(tdsChallans)
        .where(
          and(eq(tdsChallans.tenantId, ctx.tenant.id), eq(tdsChallans.id, data.challanId)),
        )
        .limit(1),
    );
    const attached = await findDeductions(ctx.tenant.id, data.deductionIds);
    let utilised = 0n;
    for (const d of attached) {
      utilised +=
        BigInt(d.tdsMinor) + BigInt(d.surchargeMinor) + BigInt(d.cessMinor);
    }
    const capacity = challan
      ? BigInt(challan.taxMinor) + BigInt(challan.surchargeMinor) + BigInt(challan.cessMinor)
      : 0n;

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tds_challan",
      resourceId: data.challanId,
      newValue: { mapped: result, utilisedMinor: serializeAmount(utilised) },
    });

    revalidatePath("/tds/challans");
    return {
      ok: true,
      data: {
        mapped: result,
        utilisedMinor: serializeAmount(utilised),
        capacityMinor: serializeAmount(capacity),
      },
    };
  } catch (err) {
    return toTdsActionError(err, "mapDeductionsToChallan");
  }
}

/**
 * ⭐ DOES THE REGISTER RECONCILE TO THE CHALLANS, EXACTLY?
 *
 * The check that has to pass before a return is filed. Three ways it does
 * not: a deduction with no challan (tax we are holding, at 1.5% a month),
 * a challan with more mapped to it than was deposited (a return the
 * Department accepts while some deductees get nothing), and a challan
 * with money nothing claims.
 */
export async function reconcileChallansForPeriod(input: unknown): Promise<
  ActionResult<{
    reconciles: boolean;
    registerTdsMinor: string;
    challanTaxCapacityMinor: string;
    differenceMinor: string;
    unmappedMinor: string;
    overUtilisedMinor: string;
    unutilisedMinor: string;
    problems: string[];
    message: string;
  }>
> {
  try {
    const ctx = await requirePermission("tds:read");
    const data = registerQuerySchema.parse(input);

    const deductions = await listDeductions(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: (data.quarter as TdsQuarter | null) ?? null,
    });
    const challans = await listChallans(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: (data.quarter as TdsQuarter | null) ?? null,
    });

    const result = reconcileRegisterToChallans({
      entries: deductions.map((d) => toRegisterEntry(d)),
      challans: challans.map(toChallanFacts),
    });

    return {
      ok: true,
      data: {
        reconciles: result.reconciles,
        registerTdsMinor: serializeAmount(result.registerTdsMinor),
        challanTaxCapacityMinor: serializeAmount(result.challanTaxCapacityMinor),
        differenceMinor: serializeAmount(result.differenceMinor),
        unmappedMinor: serializeAmount(result.unmappedMinor),
        overUtilisedMinor: serializeAmount(result.overUtilisedMinor),
        unutilisedMinor: serializeAmount(result.unutilisedMinor),
        problems: result.problems,
        message: result.message,
      },
    };
  } catch (err) {
    return toTdsActionError(err, "reconcileChallansForPeriod");
  }
}

/**
 * ⭐ THE 1.5%-A-MONTH EXPOSURE.
 *
 * ⚠️ MEASURED FROM THE DATE OF DEDUCTION, NOT FROM THE DUE DATE. Section
 * 201(1A)(ii) says so, TRACES computes it that way, and the difference on
 * a one-day-late deposit is a whole extra month.
 */
export async function getInterestExposure(input: unknown): Promise<
  ActionResult<{
    notDepositedCount: number;
    notDepositedTdsMinor: string;
    interestMinor: string;
    findings: Array<{
      deductionId: string;
      deductionDate: string;
      dueDate: string;
      tdsMinor: string;
      monthsCharged: number;
      interestMinor: string;
      message: string;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission("tds:read");
    const data = interestExposureQuerySchema.parse(input);

    const deductions = await listDeductions(ctx.tenant.id, {
      financialYear: data.financialYear,
    });
    const challans = await listChallans(ctx.tenant.id, {
      financialYear: data.financialYear,
    });
    const depositDateById = new Map(challans.map((c) => [c.id, c.depositDate]));

    const exposure = assessInterestExposure({
      deductions: deductions.map((d) => ({
        id: d.id,
        deductionDate: d.deductionDate,
        depositDate: d.challanId ? (depositDateById.get(d.challanId) ?? null) : null,
        tdsMinor: BigInt(d.tdsMinor),
        section: d.section,
      })),
      asOf: data.asOf,
    });

    return {
      ok: true,
      data: {
        notDepositedCount: exposure.notDepositedCount,
        notDepositedTdsMinor: serializeAmount(exposure.notDepositedTdsMinor),
        interestMinor: serializeAmount(exposure.interestMinor),
        findings: exposure.findings.map((f) => ({
          deductionId: f.deductionId,
          deductionDate: f.deductionDate,
          dueDate: f.dueDate,
          tdsMinor: serializeAmount(f.tdsMinor),
          monthsCharged: f.monthsCharged,
          interestMinor: serializeAmount(f.interestMinor),
          message: f.message,
        })),
      },
    };
  } catch (err) {
    return toTdsActionError(err, "getInterestExposure");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ QUARTERLY RETURNS                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ BUILD THE STATEMENT AND RUN THE VALIDATION PASS.
 *
 * ⚠️ RUN IT EARLY, NOT AT FILING TIME. The File Validation Utility
 * refuses the WHOLE file on the first structural defect and names it by
 * record number, so a return prepared on the 28th is rejected, spends two
 * days being translated into vendor names, and is filed on the 4th — with
 * Section 234E charging ₹200 a day since the 31st, a fee that cannot be
 * waived for reasonable cause and without which the statement is not even
 * accepted.
 *
 * This reports every defect at once, as sentences about vendors.
 */
export async function buildQuarterlyReturn(input: unknown): Promise<
  ActionResult<{
    id: string;
    formType: string;
    dueDate: string;
    deducteeCount: number;
    deductionCount: number;
    totalBaseMinor: string;
    totalTdsMinor: string;
    totalDepositedMinor: string;
    wouldBeAccepted: boolean;
    rejectCount: number;
    warnCount: number;
    lateFilingFeeMinor: string;
    summary: string;
    findings: Array<{
      severity: string;
      code: string;
      deducteeId?: string;
      deductionId?: string;
      field?: string;
      message: string;
    }>;
    excluded: Array<{ deductionId: string; reason: string }>;
  }>
> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:file_return",
      feature: "tds.deductions",
      permission: "tds:file_return",
      impersonationOperation: "tds:file_return",
    });

    const data = buildReturnSchema.parse(input);

    const deductees = await listDeductees(ctx.tenant.id, { includeInactive: true });
    const deductions = await listDeductions(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: data.quarter,
    });
    const challans = await listChallans(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: data.quarter,
    });

    const deducteeFacts = deductees.map((d) => ({
      id: d.id,
      legalName: d.legalName,
      panNumber: d.panNumber,
      panStatus: d.panStatus,
      deducteeType: d.deducteeType,
      isNonResident: d.isNonResident,
    }));
    const deductionFacts = deductions.map((d) => ({
      id: d.id,
      deducteeId: d.deducteeId,
      section: d.section,
      deductionDate: d.deductionDate,
      paymentBaseMinor: BigInt(d.paymentBaseMinor),
      chargeableBaseMinor: BigInt(d.chargeableBaseMinor),
      rateBps: d.rateBps,
      rateBasis: d.rateBasis,
      tdsMinor: BigInt(d.tdsMinor),
      surchargeMinor: BigInt(d.surchargeMinor),
      cessMinor: BigInt(d.cessMinor),
      challanId: d.challanId,
      outcome: d.outcome,
    }));

    const assembled = assembleReturn({
      formType: data.formType,
      financialYear: data.financialYear,
      quarter: data.quarter,
      tan: data.tan,
      deductees: deducteeFacts,
      deductions: deductionFacts,
    });

    const validation = validateReturn({
      assembled,
      deductees: deducteeFacts,
      deductions: deductionFacts,
      challans: challans.map(toChallanFacts),
      asOf: new Date().toISOString().slice(0, 10),
    });

    const id = await withTenant(ctx.tenant.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        tan: data.tan,
        formType: data.formType,
        financialYear: data.financialYear,
        quarter: data.quarter,
        // ⚠️ `validated` MEANS "OUR PASS FOUND NOTHING", NOT "ACCEPTED".
        // The Department has not seen it. Conflating the two is how a
        // dashboard reports a quarter as done while the file is still on
        // somebody's desk and 234E is running.
        status: validation.wouldBeAccepted ? ("validated" as const) : ("draft" as const),
        deducteeCount: assembled.deducteeCount,
        deductionCount: assembled.deductionCount,
        totalBaseMinor: assembled.totalBaseMinor,
        totalTdsMinor: assembled.totalTdsMinor,
        totalDepositedMinor: assembled.totalDepositedMinor,
        lateFilingFeeMinor: validation.lateFilingFeeMinor,
        dueDate: returnDueDate(data.financialYear, data.quarter),
        validationReport: validation.findings,
        validatedAt: new Date(),
      };

      const [existing] = await tx
        .select({ id: tdsReturns.id })
        .from(tdsReturns)
        .where(
          and(
            eq(tdsReturns.tenantId, ctx.tenant.id),
            eq(tdsReturns.tan, data.tan),
            eq(tdsReturns.formType, data.formType),
            eq(tdsReturns.financialYear, data.financialYear),
            eq(tdsReturns.quarter, data.quarter),
          ),
        )
        .limit(1);

      if (existing) {
        const [row] = await tx
          .update(tdsReturns)
          .set(values)
          .where(
            and(eq(tdsReturns.tenantId, ctx.tenant.id), eq(tdsReturns.id, existing.id)),
          )
          .returning({ id: tdsReturns.id });
        return row?.id ?? null;
      }

      const [row] = await tx
        .insert(tdsReturns)
        .values({ ...values, createdBy: ctx.user.id })
        .returning({ id: tdsReturns.id });
      return row?.id ?? null;
    });

    if (!id) return tdsFail("The return could not be prepared.");

    await writeAudit(ctx, {
      action: "create",
      resourceType: "tds_return",
      resourceId: id,
      newValue: {
        formType: data.formType,
        quarter: data.quarter,
        totalTdsMinor: serializeAmount(assembled.totalTdsMinor),
        wouldBeAccepted: validation.wouldBeAccepted,
        rejectCount: validation.rejectCount,
      },
    });

    revalidatePath("/tds/returns");
    return {
      ok: true,
      data: {
        id,
        formType: assembled.formType,
        dueDate: assembled.dueDate,
        deducteeCount: assembled.deducteeCount,
        deductionCount: assembled.deductionCount,
        totalBaseMinor: serializeAmount(assembled.totalBaseMinor),
        totalTdsMinor: serializeAmount(assembled.totalTdsMinor),
        totalDepositedMinor: serializeAmount(assembled.totalDepositedMinor),
        wouldBeAccepted: validation.wouldBeAccepted,
        rejectCount: validation.rejectCount,
        warnCount: validation.warnCount,
        lateFilingFeeMinor: serializeAmount(validation.lateFilingFeeMinor),
        summary: validation.summary,
        findings: validation.findings,
        excluded: assembled.excluded,
      },
    };
  } catch (err) {
    return toTdsActionError(err, "buildQuarterlyReturn");
  }
}

/**
 * Record that the statement was filed and accepted.
 *
 * ⚠️ THE ACKNOWLEDGEMENT NUMBER IS REQUIRED, and the database refuses a
 * `filed` row without one. "We filed it" is a claim; the provisional
 * receipt number is the fact — and the Section 234E fee runs until the
 * Department says it holds the statement.
 */
export async function fileQuarterlyReturn(
  input: unknown,
): Promise<ActionResult<{ id: string; lateFilingFeeMinor: string; note: string }>> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:file_return",
      feature: "tds.deductions",
      permission: "tds:file_return",
      impersonationOperation: "tds:file_return",
    });

    const data = fileReturnSchema.parse(input);

    const [existing] = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(tdsReturns)
        .where(and(eq(tdsReturns.tenantId, ctx.tenant.id), eq(tdsReturns.id, data.returnId)))
        .limit(1),
    );
    if (!existing) return tdsFail("That return no longer exists.");

    const fee = assessLateFiling({
      dueDate: existing.dueDate ?? returnDueDate(data.financialYear, data.quarter),
      filedOn: data.filedOn,
      totalTdsMinor: BigInt(existing.totalTdsMinor),
    });

    await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .update(tdsReturns)
        .set({
          status: "filed",
          filedOn: data.filedOn,
          acknowledgementNumber: data.acknowledgementNumber,
          lateFilingFeeMinor: fee.feeMinor,
        })
        .where(and(eq(tdsReturns.tenantId, ctx.tenant.id), eq(tdsReturns.id, data.returnId))),
    );

    await writeAudit(ctx, {
      action: "update",
      resourceType: "tds_return",
      resourceId: data.returnId,
      newValue: {
        status: "filed",
        filedOn: data.filedOn,
        acknowledgementNumber: data.acknowledgementNumber,
        lateFilingFeeMinor: serializeAmount(fee.feeMinor),
      },
      reason: fee.explanation,
    });

    revalidatePath("/tds/returns");
    return {
      ok: true,
      data: {
        id: data.returnId,
        lateFilingFeeMinor: serializeAmount(fee.feeMinor),
        note: fee.explanation,
      },
    };
  } catch (err) {
    return toTdsActionError(err, "fileQuarterlyReturn");
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ FORM 16A / 27D                                                    */
/* ------------------------------------------------------------------ */

/**
 * Assemble the quarter's certificates.
 *
 * ⚠️ WE DO NOT ISSUE THEM. Rule 31(3) requires Form 16A to be downloaded
 * from TRACES, generated by the Department from the return we filed and
 * the challans that matched. What this produces is the ASSEMBLY, and its
 * job is to answer — before the request goes out — whether the
 * certificate will say what our books say.
 *
 * ⭐ IT FREQUENTLY WILL NOT, for one reason: TRACES certifies what was
 * DEPOSITED, not what was deducted.
 */
export async function buildCertificates(input: unknown): Promise<
  ActionResult<{
    certificates: Array<{
      id: string;
      deducteeId: string;
      deducteeName: string;
      formType: string;
      totalBaseMinor: string;
      totalTdsMinor: string;
      depositedTdsMinor: string;
      undepositedTdsMinor: string;
      dueDate: string;
      problems: string[];
      warnings: string[];
    }>;
  }>
> {
  try {
    const ctx = await guardTdsWrite({
      operation: "tds:file_return",
      feature: "tds.deductions",
      permission: "tds:file_return",
      impersonationOperation: "tds:file_return",
    });

    const data = buildCertificatesSchema.parse(input);

    const deductees = (await listDeductees(ctx.tenant.id, { includeInactive: true }))
      .filter((d) => !data.deducteeId || d.id === data.deducteeId);
    const deductions = await listDeductions(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: data.quarter,
    });
    const challans = await listChallans(ctx.tenant.id, {
      financialYear: data.financialYear,
      quarter: data.quarter,
    });
    const challanById = new Map(challans.map((c) => [c.id, c]));

    const assembled = assembleQuarterCertificates({
      deductees: deductees.map((d) => ({
        id: d.id,
        legalName: d.legalName,
        panNumber: d.panNumber,
        isNonResident: d.isNonResident,
      })),
      deductions: deductions.map((d) => {
        const challan = d.challanId ? challanById.get(d.challanId) : undefined;
        return {
          id: d.id,
          deducteeId: d.deducteeId,
          section: d.section,
          deductionDate: d.deductionDate,
          chargeableBaseMinor: BigInt(d.chargeableBaseMinor),
          rateBps: d.rateBps,
          tdsMinor: BigInt(d.tdsMinor),
          surchargeMinor: BigInt(d.surchargeMinor),
          cessMinor: BigInt(d.cessMinor),
          challanId: d.challanId,
          bsrCode: challan?.bsrCode ?? null,
          challanSerial: challan?.challanSerial ?? null,
          depositDate: challan?.depositDate ?? null,
        };
      }),
      financialYear: data.financialYear,
      quarter: data.quarter,
      tan: data.tan,
    });

    const withRows = await withTenant(ctx.tenant.id, async (tx) => {
      const out: Array<{ id: string; index: number }> = [];
      for (const [index, cert] of assembled.entries()) {
        if (cert.lineDetail.length === 0) continue;
        const values = {
          tenantId: ctx.tenant.id,
          deducteeId: cert.deducteeId,
          formType: cert.formType,
          financialYear: cert.financialYear,
          quarter: cert.quarter,
          tan: cert.tan,
          totalBaseMinor: cert.totalBaseMinor,
          totalTdsMinor: cert.totalTdsMinor,
          depositedTdsMinor: cert.depositedTdsMinor,
          lineDetail: cert.lineDetail,
          dueDate: certificateDueDate(cert.financialYear, cert.quarter),
        };
        const [existing] = await tx
          .select({ id: tdsCertificates.id })
          .from(tdsCertificates)
          .where(
            and(
              eq(tdsCertificates.tenantId, ctx.tenant.id),
              eq(tdsCertificates.tan, cert.tan),
              eq(tdsCertificates.deducteeId, cert.deducteeId),
              eq(tdsCertificates.formType, cert.formType),
              eq(tdsCertificates.financialYear, cert.financialYear),
              eq(tdsCertificates.quarter, cert.quarter),
            ),
          )
          .limit(1);

        if (existing) {
          await tx
            .update(tdsCertificates)
            .set(values)
            .where(
              and(
                eq(tdsCertificates.tenantId, ctx.tenant.id),
                eq(tdsCertificates.id, existing.id),
              ),
            );
          out.push({ id: existing.id, index });
        } else {
          const [row] = await tx
            .insert(tdsCertificates)
            .values({ ...values, createdBy: ctx.user.id })
            .returning({ id: tdsCertificates.id });
          if (row) out.push({ id: row.id, index });
        }
      }
      return out;
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "tds_certificate",
      resourceId: `${data.tan}:${data.financialYear}:${data.quarter}`,
      newValue: { count: withRows.length },
    });

    revalidatePath("/tds/certificates");
    return {
      ok: true,
      data: {
        certificates: withRows.map(({ id, index }) => {
          const cert = assembled[index]!;
          return {
            id,
            deducteeId: cert.deducteeId,
            deducteeName: cert.deducteeName,
            formType: cert.formType,
            totalBaseMinor: serializeAmount(cert.totalBaseMinor),
            totalTdsMinor: serializeAmount(cert.totalTdsMinor),
            depositedTdsMinor: serializeAmount(cert.depositedTdsMinor),
            undepositedTdsMinor: serializeAmount(cert.undepositedTdsMinor),
            dueDate: cert.dueDate,
            problems: cert.problems,
            warnings: cert.warnings,
          };
        }),
      },
    };
  } catch (err) {
    return toTdsActionError(err, "buildCertificates");
  }
}

/* ------------------------------------------------------------------ */

function toDeductionRow(r: {
  id: string;
  deducteeId: string;
  section: string;
  financialYear: string;
  quarter: string;
  deductionDate: string;
  paymentBaseMinor: bigint;
  catchUpBaseMinor: bigint;
  chargeableBaseMinor: bigint;
  aggregateBeforeMinor: bigint;
  aggregateAfterMinor: bigint;
  rateBps: number;
  rateBasis: string;
  statutoryRef: string | null;
  tdsMinor: bigint;
  totalDeductedMinor: bigint;
  outcome: string;
  challanId: string | null;
  explanation: string | null;
}): DeductionRow {
  return {
    id: r.id,
    deducteeId: r.deducteeId,
    section: r.section,
    financialYear: r.financialYear,
    quarter: r.quarter,
    deductionDate: r.deductionDate,
    paymentBaseMinor: serializeAmount(r.paymentBaseMinor),
    catchUpBaseMinor: serializeAmount(r.catchUpBaseMinor),
    chargeableBaseMinor: serializeAmount(r.chargeableBaseMinor),
    aggregateBeforeMinor: serializeAmount(r.aggregateBeforeMinor),
    aggregateAfterMinor: serializeAmount(r.aggregateAfterMinor),
    rateBps: r.rateBps,
    rateBasis: r.rateBasis,
    statutoryRef: r.statutoryRef,
    tdsMinor: serializeAmount(r.tdsMinor),
    totalDeductedMinor: serializeAmount(r.totalDeductedMinor),
    outcome: r.outcome,
    challanId: r.challanId,
    explanation: r.explanation,
  };
}
