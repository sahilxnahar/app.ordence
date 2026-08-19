import "server-only";

/**
 * Ordence — ⭐ TDS Engine (composition layer)
 * Version: v0.36.0-alpha
 *
 * The only place that puts the pure decisions together with the database:
 *
 *   1. WHO is the payee?            → `tds_deductees`, keyed on PAN
 *   2. ⭐ WHAT HAS THE YEAR TOTALLED SO FAR? → `loadPriorDeductions`
 *   3. ⭐ HAS THE THRESHOLD BEEN CROSSED, AND WHAT IS CHARGEABLE?
 *                                    → `lib/tds/thresholds.ts`
 *   4. ⭐ AT WHAT RATE — 206AA, 206AB, 197? → `lib/tds/rates.ts`
 *
 * ⚠️ IT DECIDES NOTHING ITSELF. Every rule lives in `lib/tds/`. This file
 * loads rows, calls the engines, and turns a refusal into a sentence. If
 * a tax rule ever appears in this file, it has been written twice.
 *
 * ⚠️ AND STEP 2 IS THE ONE THAT CANNOT BE SKIPPED FOR PERFORMANCE. It is
 * one indexed range scan per assessment, and without it the answer to
 * step 3 is the payment tested in isolation — which is the classic and
 * expensive under-deduction this whole phase exists to prevent.
 *
 * ⚠️ NOT `"use server"`. It exports types alongside async functions.
 */

import {
  accumulate,
  assessThreshold,
  type ThresholdVerdict,
} from "@/lib/tds/thresholds";
import {
  computeDeduction,
  resolveTdsRate,
  type DeductionComputation,
  type RateResolution,
} from "@/lib/tds/rates";
import { sectionRule, type SectionRule } from "@/lib/tds/sections";
import { financialYearOf, quarterOf } from "@/lib/tds/calendar";
import {
  certificateConsumedBaseMinor,
  findCertificateFor,
  findDeductee,
  loadPriorDeductions,
  toCertificateFacts,
  toDeducteeFacts,
} from "./registry";
import type { TdsDeductionOutcome, TdsQuarter, TdsSectionCode } from "@/db/schema/tds";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type AssessedDeduction = {
  deducteeId: string;
  deducteeName: string;
  section: TdsSectionCode;
  rule: SectionRule;
  financialYear: string;
  quarter: TdsQuarter;
  deductionDate: string;

  threshold: ThresholdVerdict;
  resolution: RateResolution;
  computation: DeductionComputation;

  /** What the register row will say. */
  outcome: TdsDeductionOutcome;

  /** Columns ready to be written. */
  row: {
    paymentBaseMinor: bigint;
    catchUpBaseMinor: bigint;
    chargeableBaseMinor: bigint;
    aggregateBeforeMinor: bigint;
    aggregateAfterMinor: bigint;
    rateBps: number;
    tdsMinor: bigint;
    lowerDeductionCertificateId: string | null;
  };

  /** ⭐ The sentence stored on the row and shown before the payment. */
  explanation: string;
  warnings: string[];
  problem: string | null;
};

/* ------------------------------------------------------------------ */
/* ⭐ THE ASSESSMENT                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT SHOULD BE DEDUCTED FROM THIS PAYMENT?
 *
 * ⚠️ THE ORDER OF STEPS 3 AND 4 IS LOAD-BEARING. Section 206AA raises the
 * rate "where tax is required to be deducted" — below the threshold no
 * tax is required, so 20% does not apply to a ₹5,000 payment to a
 * PAN-less contractor. Resolving the rate before the threshold would
 * deduct ₹1,000 from a payment that attracts nothing, and Section 205
 * bars us from giving it back once it is deposited.
 *
 * ⚠️ IT NEVER THROWS ON A TAX QUESTION. A payment run listing forty
 * vouchers must not blank out because one payee is a non-resident. Those
 * come back with `problem` set and a zero deduction that the caller has
 * to resolve, not a silent zero.
 */
export async function assessDeduction(
  tenantId: string,
  args: {
    deducteeId: string;
    section: TdsSectionCode;
    /** ⚠️ EXCLUDING GST — CBDT Circular 23/2017. Phase 33 computed this. */
    paymentBaseMinor: bigint;
    /** Date of credit or of payment, WHICHEVER IS EARLIER. */
    deductionDate: string;
    /** 192 and 195 only. See `SectionRule.rateResolvable`. */
    manualRateBps?: number | null;
    manualRateReason?: string | null;
    /** Exclude a row being recomputed from its own accumulation. */
    excludeDeductionId?: string;
  },
): Promise<AssessedDeduction> {
  const rule = sectionRule(args.section);
  const financialYear = financialYearOf(args.deductionDate);
  const quarter = quarterOf(args.deductionDate);

  const deductee = await findDeductee(tenantId, args.deducteeId);
  if (!deductee) {
    throw new Error(
      "That deductee does not exist in this workspace. A deduction with no payee " +
        "cannot be reported at all — the tax would sit under our TAN against " +
        "nobody, and no Form 26AS would ever show it.",
    );
  }

  /* --- 2. ⭐ THE YEAR SO FAR -------------------------------------- */
  const prior = await loadPriorDeductions(tenantId, {
    deducteeId: args.deducteeId,
    section: args.section,
    financialYear,
    ...(args.excludeDeductionId ? { excludeDeductionId: args.excludeDeductionId } : {}),
  });
  const accumulation = accumulate(prior);

  /* --- 3. ⭐ THE THRESHOLD ---------------------------------------- */
  const threshold = assessThreshold({
    rule,
    paymentBaseMinor: args.paymentBaseMinor,
    accumulation,
  });

  if (!threshold.chargeable) {
    // ⚠️ THE ROW IS STILL WRITTEN. It is what makes the NEXT payment know
    // where the year stands, and a register that holds only deductions
    // cannot apply an annual threshold at all.
    return {
      deducteeId: deductee.id,
      deducteeName: deductee.legalName,
      section: args.section,
      rule,
      financialYear,
      quarter,
      deductionDate: args.deductionDate,
      threshold,
      resolution: emptyResolution(rule.statutoryRef, threshold.explanation),
      computation: {
        rateBps: 0,
        basis: "normal",
        statutoryRef: rule.statutoryRef,
        explanation: threshold.explanation,
        chargeableBaseMinor: 0n,
        tdsMinor: 0n,
        netPayableMinor: args.paymentBaseMinor,
        certificateId: null,
        warnings: [],
        problem: null,
      },
      outcome: "below_threshold",
      row: {
        paymentBaseMinor: args.paymentBaseMinor,
        catchUpBaseMinor: 0n,
        chargeableBaseMinor: 0n,
        aggregateBeforeMinor: threshold.aggregateBeforeMinor,
        aggregateAfterMinor: threshold.aggregateAfterMinor,
        rateBps: 0,
        tdsMinor: 0n,
        lowerDeductionCertificateId: null,
      },
      explanation: threshold.explanation,
      warnings: [],
      problem: null,
    };
  }

  /* --- 4. ⭐ THE RATE --------------------------------------------- */
  const certRow = await findCertificateFor(tenantId, {
    deducteeId: args.deducteeId,
    section: args.section,
    day: args.deductionDate,
  });
  const certificate = certRow ? toCertificateFacts(certRow) : null;
  const consumed = certRow
    ? await certificateConsumedBaseMinor(tenantId, certRow.id)
    : 0n;

  const resolution = resolveTdsRate({
    section: args.section,
    deductee: toDeducteeFacts(deductee),
    day: args.deductionDate,
    certificate,
    consumedCertificateBaseMinor: consumed,
    chargeableBaseMinor: threshold.chargeableBaseMinor,
    specifiedPersonCheckedOn: deductee.specifiedPersonCheckedOn,
  });

  /* --- 192 and 195: a person supplies the rate, with their working - */
  const effective: RateResolution =
    resolution.rateBps === null && args.manualRateBps != null
      ? {
          ...resolution,
          rateBps: args.manualRateBps,
          basis: "manually_determined",
          problem: null,
          explanation:
            `Rate of ${(args.manualRateBps / 100).toFixed(2)}% recorded by hand ` +
            `for Section ${rule.code}. ` +
            (args.manualRateReason ?? "No working was recorded.") +
            ` ⚠️ This engine does not compute Section ${rule.code} — ` +
            rule.note,
        }
      : resolution;

  const computation = computeDeduction({
    paymentBaseMinor: args.paymentBaseMinor,
    chargeableBaseMinor: threshold.chargeableBaseMinor,
    resolution: effective,
  });

  // ⭐ A nil-rate Section 197 certificate is not "no deduction" — it is a
  // reportable event at zero, and it has to appear on the return so the
  // deductee's Form 26AS shows the payment.
  const outcome: TdsDeductionOutcome =
    computation.tdsMinor > 0n
      ? "deducted"
      : effective.basis === "section_197_certificate"
        ? "nil_certificate"
        : "below_threshold";

  return {
    deducteeId: deductee.id,
    deducteeName: deductee.legalName,
    section: args.section,
    rule,
    financialYear,
    quarter,
    deductionDate: args.deductionDate,
    threshold,
    resolution: effective,
    computation,
    outcome,
    row: {
      paymentBaseMinor: args.paymentBaseMinor,
      // ⚠️ A `below_threshold` outcome must carry nothing chargeable — the
      // CHECK in SQL 0025 §1 refuses the mixture, and the mixture is what a
      // rate of zero on a real base would produce.
      catchUpBaseMinor: outcome === "below_threshold" ? 0n : threshold.catchUpBaseMinor,
      chargeableBaseMinor:
        outcome === "below_threshold" ? 0n : threshold.chargeableBaseMinor,
      aggregateBeforeMinor: threshold.aggregateBeforeMinor,
      aggregateAfterMinor: threshold.aggregateAfterMinor,
      rateBps: effective.rateBps ?? 0,
      tdsMinor: computation.tdsMinor,
      lowerDeductionCertificateId: computation.certificateId,
    },
    // ⭐ BOTH SENTENCES, IN ORDER. The threshold explains why anything is
    // due; the rate explains why it is that much. Storing only the second
    // leaves "1% of ₹1,00,000 on a ₹25,000 payment" unexplained, and that
    // is the row every reviewer stops at.
    explanation: `${threshold.explanation} ${effective.explanation}`.trim(),
    warnings: computation.warnings,
    problem: computation.problem,
  };
}

function emptyResolution(statutoryRef: string, explanation: string): RateResolution {
  return {
    rateBps: 0,
    basis: "normal",
    statutoryRef,
    explanation,
    components: {
      normalBps: null,
      section206aaBps: null,
      section206abBps: null,
      certificateBps: null,
    },
    certificateId: null,
    problem: null,
    warnings: [],
  };
}
