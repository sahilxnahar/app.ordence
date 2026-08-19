/**
 * Ordence — The Deduction Register
 * Version: v0.36.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * The register is the answer to four questions, and every one of them is
 * asked by somebody different:
 *
 *   • THE VENDOR — "what did you deduct from me this year, and against
 *     which challan?"
 *   • THE ACCOUNTANT — "what do I owe the government on the 7th?"
 *   • ⭐ THE REVIEWER — "does what we deducted equal what we deposited,
 *     exactly?"
 *   • THE ASSESSING OFFICER — "why this rate?"
 *
 * ⚠️ THE FOURTH IS THE ONE A SUMMARY CANNOT ANSWER, which is why every
 * row carries its `rate_basis`, its `statutory_ref` and the sentence that
 * produced it, and why this file rolls up without discarding them.
 */

import { formatPaise, sectionRule } from "./sections";
import { reconcileChallans, type ChallanFacts, type MappedDeduction } from "./challans";
import type { TdsQuarter, TdsSectionCode, TdsRateBasis } from "@/db/schema/tds";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type RegisterEntry = {
  id: string;
  deducteeId: string;
  deducteeName?: string;
  section: TdsSectionCode;
  financialYear: string;
  quarter: TdsQuarter;
  deductionDate: string;

  paymentBaseMinor: bigint;
  catchUpBaseMinor: bigint;
  chargeableBaseMinor: bigint;
  aggregateBeforeMinor: bigint;
  aggregateAfterMinor: bigint;

  rateBps: number;
  rateBasis: TdsRateBasis;
  statutoryRef: string | null;
  tdsMinor: bigint;
  surchargeMinor: bigint;
  cessMinor: bigint;
  outcome: string;

  challanId: string | null;
  purchaseInvoiceId?: string | null;
  referenceNumber?: string | null;
};

export type SectionTotals = {
  section: TdsSectionCode;
  label: string;
  /** Everything paid under this section, chargeable or not. */
  paidBaseMinor: bigint;
  /** What tax was actually computed on. */
  chargeableBaseMinor: bigint;
  tdsMinor: bigint;
  depositedMinor: bigint;
  undepositedMinor: bigint;
  deductionCount: number;
  belowThresholdCount: number;
};

export type RegisterSummary = {
  financialYear: string;
  quarter: TdsQuarter | "ALL";

  totalPaidBaseMinor: bigint;
  totalChargeableBaseMinor: bigint;
  totalTdsMinor: bigint;
  totalDepositedMinor: bigint;
  /** ⭐ Deducted and still held. Accruing 1.5% a month. */
  totalUndepositedMinor: bigint;
  /** ⭐ Earlier payments brought into charge by a threshold crossing. */
  totalCatchUpBaseMinor: bigint;

  bySection: SectionTotals[];
  byRateBasis: Partial<Record<TdsRateBasis, { count: number; tdsMinor: bigint }>>;

  deducteeCount: number;
  deductionCount: number;
};

/* ------------------------------------------------------------------ */
/* SUMMARY                                                             */
/* ------------------------------------------------------------------ */

/**
 * Roll a register up.
 *
 * ⚠️ `byRateBasis` IS NOT A CURIOSITY. It is the single most useful
 * management number in the phase: "₹3,40,000 of tax this year was
 * deducted at 20% because we do not hold the vendor's PAN". That is a
 * cost of ₹3,00,000 of unnecessary deduction, borne by subcontractors who
 * will ask for it back and cannot get it, and the fix is four phone calls.
 * It never appears on any total.
 */
export function summariseRegister(
  entries: readonly RegisterEntry[],
  options?: { financialYear?: string; quarter?: TdsQuarter },
): RegisterSummary {
  const bySection = new Map<TdsSectionCode, SectionTotals>();
  const byRateBasis: RegisterSummary["byRateBasis"] = {};
  const deductees = new Set<string>();

  let totalPaidBaseMinor = 0n;
  let totalChargeableBaseMinor = 0n;
  let totalTdsMinor = 0n;
  let totalDepositedMinor = 0n;
  let totalCatchUpBaseMinor = 0n;
  let deductionCount = 0;

  for (const e of entries) {
    if (options?.financialYear && e.financialYear !== options.financialYear) continue;
    if (options?.quarter && e.quarter !== options.quarter) continue;

    deductees.add(e.deducteeId);
    deductionCount += 1;

    const tax = e.tdsMinor + e.surchargeMinor + e.cessMinor;
    totalPaidBaseMinor += e.paymentBaseMinor;
    totalChargeableBaseMinor += e.chargeableBaseMinor;
    totalTdsMinor += tax;
    totalCatchUpBaseMinor += e.catchUpBaseMinor;
    if (e.challanId) totalDepositedMinor += tax;

    const bucket =
      bySection.get(e.section) ??
      ({
        section: e.section,
        label: sectionRule(e.section).label,
        paidBaseMinor: 0n,
        chargeableBaseMinor: 0n,
        tdsMinor: 0n,
        depositedMinor: 0n,
        undepositedMinor: 0n,
        deductionCount: 0,
        belowThresholdCount: 0,
      } satisfies SectionTotals);

    bucket.paidBaseMinor += e.paymentBaseMinor;
    bucket.chargeableBaseMinor += e.chargeableBaseMinor;
    bucket.tdsMinor += tax;
    bucket.deductionCount += 1;
    if (e.outcome === "below_threshold") bucket.belowThresholdCount += 1;
    if (e.challanId) bucket.depositedMinor += tax;
    else bucket.undepositedMinor += tax;
    bySection.set(e.section, bucket);

    if (tax > 0n) {
      const rb = byRateBasis[e.rateBasis] ?? { count: 0, tdsMinor: 0n };
      rb.count += 1;
      rb.tdsMinor += tax;
      byRateBasis[e.rateBasis] = rb;
    }
  }

  return {
    financialYear: options?.financialYear ?? "",
    quarter: options?.quarter ?? "ALL",
    totalPaidBaseMinor,
    totalChargeableBaseMinor,
    totalTdsMinor,
    totalDepositedMinor,
    totalUndepositedMinor: totalTdsMinor - totalDepositedMinor,
    totalCatchUpBaseMinor,
    bySection: [...bySection.values()].sort((a, b) =>
      a.section.localeCompare(b.section),
    ),
    byRateBasis,
    deducteeCount: deductees.size,
    deductionCount,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ RECONCILIATION                                                    */
/* ------------------------------------------------------------------ */

export type RegisterReconciliation = {
  /** ⭐ Register total === challan total, to the paisa. */
  reconciles: boolean;
  registerTdsMinor: bigint;
  challanTaxCapacityMinor: bigint;
  differenceMinor: bigint;
  unmappedMinor: bigint;
  overUtilisedMinor: bigint;
  unutilisedMinor: bigint;
  problems: string[];
  message: string;
};

/**
 * ⭐ DOES THE DEDUCTION REGISTER RECONCILE TO THE CHALLANS, EXACTLY?
 *
 * ⚠️ EXACTLY MEANS EXACTLY. Every figure in this phase is integer paise
 * produced by `applyRateBps`, so a difference is never rounding — it is a
 * deduction with no deposit, a deposit with no deduction, or a challan
 * carrying more than was paid into it. A tolerance of "within a rupee"
 * would swallow precisely the rows worth finding, and a rupee of
 * tolerance across four hundred deductions is four hundred rupees of
 * somebody's credit.
 *
 * ⚠️ AND THE COMPARISON IS AGAINST THE CHALLAN'S **TAX** CAPACITY, NOT
 * ITS TOTAL. Interest under 201(1A) and the fee under 234E are deposited
 * on the same challan and cannot discharge anybody's tax — OLTAS keeps
 * the boxes separate. Reconciling against the total makes the books
 * balance while some deductee's credit does not exist.
 */
export function reconcileRegisterToChallans(args: {
  entries: readonly RegisterEntry[];
  challans: readonly ChallanFacts[];
}): RegisterReconciliation {
  const mapped: MappedDeduction[] = args.entries.map((e) => ({
    id: e.id,
    challanId: e.challanId,
    tdsMinor: e.tdsMinor,
    surchargeMinor: e.surchargeMinor,
    cessMinor: e.cessMinor,
  }));

  const result = reconcileChallans({ challans: args.challans, deductions: mapped });
  const difference = result.totalDeductedMinor - result.totalChallanCapacityMinor;

  return {
    reconciles: result.reconciles,
    registerTdsMinor: result.totalDeductedMinor,
    challanTaxCapacityMinor: result.totalChallanCapacityMinor,
    differenceMinor: difference,
    unmappedMinor: result.unmappedMinor,
    overUtilisedMinor: result.totalOverUtilisedMinor,
    unutilisedMinor: result.totalUnutilisedMinor,
    problems: result.problems,
    message: result.reconciles
      ? `⭐ The register reconciles to the challans exactly: ` +
        `${formatPaise(result.totalDeductedMinor)} deducted, the same deposited, ` +
        `every deduction attached to a challan and every challan fully utilised.`
      : `⭐ The register does NOT reconcile. ` +
        `${formatPaise(result.totalDeductedMinor)} deducted against ` +
        `${formatPaise(result.totalChallanCapacityMinor)} of challan tax capacity ` +
        `— a difference of ${formatPaise(difference)}. ` +
        `${formatPaise(result.unmappedMinor)} is attached to no challan, ` +
        `${formatPaise(result.totalOverUtilisedMinor)} is mapped to challans that ` +
        `never held it, and ${formatPaise(result.totalUnutilisedMinor)} was ` +
        `deposited against nothing. ⚠️ Each of those is a different deductee not ` +
        `getting credit, and none of them shows up on a total.`,
  };
}

/* ------------------------------------------------------------------ */
/* THE CHAIN                                                           */
/* ------------------------------------------------------------------ */

export type ChainProblem = {
  entryId: string;
  expectedMinor: bigint;
  actualMinor: bigint;
  message: string;
};

/**
 * ⭐ DOES THE RUNNING TOTAL ACTUALLY RUN?
 *
 * `aggregate_before_minor` on each row must equal the sum of
 * `payment_base_minor` on every earlier row in the same (deductee,
 * section, financial year) group, in date order.
 *
 * ⚠️ THIS IS THE MIRROR OF THE DEFERRED TRIGGER IN SQL 0025 §5, and it is
 * not a duplicate of it. The trigger is the GUARANTEE — it holds for the
 * import script and the psql session too. This function exists to produce
 * a SENTENCE naming which row broke the chain and by how much, for
 * somebody looking at a register that has already gone wrong.
 *
 * ⚠️ A BROKEN CHAIN IS ALWAYS AN UNDER-DEDUCTION OR AN OVER-DEDUCTION,
 * never a cosmetic problem. The aggregate is what the annual threshold
 * was tested against; if it is wrong, the test was wrong.
 *
 * The usual cause is a BACKDATED entry — the contractor's March invoice
 * arriving in May — which is ordinary work and which invalidates the
 * chain from that date onwards. It is not refused; it is reported, so
 * the affected rows can be recomputed.
 */
export function verifyAccumulationChain(
  entries: readonly RegisterEntry[],
): ChainProblem[] {
  const groups = new Map<string, RegisterEntry[]>();
  for (const e of entries) {
    const key = `${e.deducteeId}|${e.section}|${e.financialYear}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(e);
    groups.set(key, bucket);
  }

  const problems: ChainProblem[] = [];

  for (const [, bucket] of groups) {
    const ordered = [...bucket].sort((a, b) =>
      a.deductionDate === b.deductionDate
        ? a.id.localeCompare(b.id)
        : a.deductionDate.localeCompare(b.deductionDate),
    );

    let running = 0n;
    for (const e of ordered) {
      if (e.aggregateBeforeMinor !== running) {
        problems.push({
          entryId: e.id,
          expectedMinor: running,
          actualMinor: e.aggregateBeforeMinor,
          message:
            `⭐ The running total for ${e.deducteeName ?? e.deducteeId} under ` +
            `Section ${e.section} in ${e.financialYear} breaks at the deduction ` +
            `dated ${e.deductionDate}: the earlier rows total ` +
            `${formatPaise(running)} and this row was computed against ` +
            `${formatPaise(e.aggregateBeforeMinor)}. ⚠️ The aggregate is what the ` +
            `annual threshold was tested against, so this deduction — and every ` +
            `one after it — was decided on the wrong number. The usual cause is a ` +
            `BACKDATED payment entered after the fact, which is ordinary work and ` +
            `which means these rows need recomputing rather than correcting by ` +
            `hand.`,
        });
      }
      running += e.paymentBaseMinor;
    }
  }

  return problems;
}
