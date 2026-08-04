/**
 * Ordence — ⭐⭐ CUMULATIVE THRESHOLD ACCUMULATION
 * Version: v0.36.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE THING THIS FILE EXISTS TO GET RIGHT
 * ══════════════════════════════════════════════════════════════════════
 * A labour contractor is paid ₹25,000 in April, ₹25,000 in June,
 * ₹25,000 in September and ₹25,000 in December.
 *
 * Looked at one at a time, every payment is comfortably below Section
 * 194C's ₹30,000 single-payment limit, and nothing is deducted. Looked at
 * as a year, the aggregate has reached ₹1,00,000 — and the second limb of
 * Section 194C(5) makes tax deductible on ALL OF IT.
 *
 * So at the December payment:
 *
 *     payment base      ₹25,000
 *     catch-up base     ₹75,000   ← ⭐ the three earlier payments
 *     chargeable base   ₹1,00,000
 *     TDS at 1%         ₹1,000    ← not ₹250
 *
 * ⚠️ TESTING EACH PAYMENT IN ISOLATION IS THE CLASSIC AND EXPENSIVE
 * ERROR, and it is expensive in a particular way: the money has already
 * gone to the contractor, who has finished the work and left the site.
 * Section 201(1) makes the deductor an assessee in default for the whole
 * ₹1,000, interest under 201(1A) runs from the date each payment was
 * made, and 30% of the ₹1,00,000 expenditure is disallowed under Section
 * 40(a)(ia) — so the tax cost of a ₹1,000 mistake is several times
 * ₹1,000, arriving two years later.
 *
 * It is also completely silent. Four correct-looking vouchers, four
 * correct-looking transfers, no error anywhere.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE COMPARISON IS `>=`, AND THE STATUTE SAYS "DOES NOT EXCEED"
 * ══════════════════════════════════════════════════════════════════════
 * Read strictly, Section 194C(5) exempts a payment where the aggregate
 * "does not exceed one lakh rupees" — so the charge begins at ₹1,00,001
 * and an aggregate of exactly ₹1,00,000 attracts nothing.
 *
 * ⭐ THIS ENGINE DEDUCTS AT ₹1,00,000, AND THE CHOICE IS DELIBERATE.
 *
 * The two errors are not symmetrical. Deducting a rupee too early costs
 * the deductee ₹1,000 of working capital, recoverable in full on their
 * own return. Deducting a rupee too late makes US an assessee in default
 * for the whole ₹1,000 under Section 201(1), plus interest, plus a 30%
 * disallowance of the expenditure — and the trigger for it is a rounding
 * decision nobody documented. The asymmetry is roughly a hundred to one.
 *
 * It is a single flag, `thresholdIsInclusive`, so a workspace that wants
 * the strict reading changes one value rather than rewriting the engine —
 * and either way the register records which reading produced the row.
 */

import { tdsOn, sectionRule, formatPaise, type SectionRule } from "./sections";

/**
 * ⭐ SEE THE HEADER. `true` = deduct AT the threshold; `false` = deduct
 * only ABOVE it, which is the literal reading of "does not exceed".
 */
export const THRESHOLD_IS_INCLUSIVE = true;

/* ------------------------------------------------------------------ */
/* THE RUNNING TOTAL                                                   */
/* ------------------------------------------------------------------ */

/**
 * One earlier row in the same (deductee, section, financial year) group.
 *
 * ⚠️ BOTH FIGURES ARE NEEDED AND THEY ARE DIFFERENT. `baseMinor` is what
 * was PAID — it drives the threshold. `chargedBaseMinor` is what tax was
 * actually computed on. Before the threshold is crossed the second is
 * zero while the first is not, and the gap between them IS the catch-up
 * waiting to happen.
 */
export type PriorDeduction = {
  /** `YYYY-MM-DD`. Date of credit or of payment, whichever is earlier. */
  deductionDate: string;
  /** This payment, net of GST. */
  baseMinor: bigint;
  /** How much of the aggregate has already been brought into charge. */
  chargedBaseMinor: bigint;
};

export type Accumulation = {
  /** Everything paid under this section to this deductee this year. */
  aggregateMinor: bigint;
  /** How much of that has already had tax computed on it. */
  chargedMinor: bigint;
  /** The largest single payment so far — 194C's first limb needs it. */
  largestSingleMinor: bigint;
  count: number;
};

/**
 * Roll a deductee's history for one section and one financial year up.
 *
 * ⚠️ IT DOES NOT FILTER. Callers pass exactly the rows for one deductee,
 * one section and one financial year, because a filter written here and a
 * `WHERE` clause written in `server/tds/registry.ts` are two chances to
 * disagree about what "this year" means — and the one that disagrees is
 * always the one covering 1 April.
 */
export function accumulate(prior: readonly PriorDeduction[]): Accumulation {
  let aggregateMinor = 0n;
  let chargedMinor = 0n;
  let largestSingleMinor = 0n;

  for (const row of prior) {
    aggregateMinor += row.baseMinor;
    chargedMinor += row.chargedBaseMinor;
    if (row.baseMinor > largestSingleMinor) largestSingleMinor = row.baseMinor;
  }

  return { aggregateMinor, chargedMinor, largestSingleMinor, count: prior.length };
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export type ThresholdTrigger =
  /** ⭐ 194C's first limb: this one payment is large enough on its own. */
  | "single_payment"
  /** ⭐ The second limb: the year's aggregate has reached the annual limit. */
  | "annual_aggregate"
  /** 194IA: this transaction alone, with no aggregation across the year. */
  | "per_transaction"
  /** The threshold was already crossed by an earlier payment. */
  | "already_crossed"
  /** The section has no threshold this engine applies — 192, 195. */
  | "no_threshold"
  /** Nothing is chargeable yet. */
  | "below";

export type ThresholdVerdict = {
  chargeable: boolean;
  trigger: ThresholdTrigger;

  /** The running total BEFORE this payment. Stored on the deduction row. */
  aggregateBeforeMinor: bigint;
  /** After. = before + this payment. */
  aggregateAfterMinor: bigint;

  /** This payment, net of GST. */
  paymentBaseMinor: bigint;
  /** ⭐ Earlier payments brought into charge NOW. Zero except at crossing. */
  catchUpBaseMinor: bigint;
  /** What the rate is applied to. = payment + catch-up, less any excess rule. */
  chargeableBaseMinor: bigint;

  /** A sentence for the voucher and for the register. */
  explanation: string;
};

/**
 * ⭐ HAS THIS PAYMENT CROSSED THE LINE, AND WHAT IS CHARGEABLE?
 *
 * The whole cumulative rule, in one function, for every threshold mode.
 * Everything else in the phase reads its answer.
 *
 * ⚠️ IT NEVER THROWS. A payment-entry screen showing twenty vouchers must
 * not blank out because one of them names a section this engine cannot
 * rate. The unresolvable cases return `no_threshold` with an explanation,
 * and `lib/tds/rates.ts` refuses to invent a rate for them.
 */
export function assessThreshold(args: {
  rule: SectionRule;
  /** This payment, EXCLUDING GST. CBDT Circular 23/2017. */
  paymentBaseMinor: bigint;
  /** The group's history. `accumulate()` over the prior rows. */
  accumulation: Accumulation;
  /** Override the inclusive/exclusive reading. See the file header. */
  thresholdIsInclusive?: boolean;
}): ThresholdVerdict {
  const { rule, paymentBaseMinor, accumulation } = args;
  const inclusive = args.thresholdIsInclusive ?? THRESHOLD_IS_INCLUSIVE;

  const before = accumulation.aggregateMinor;
  const after = before + paymentBaseMinor;

  const nothing = (trigger: ThresholdTrigger, explanation: string): ThresholdVerdict => ({
    chargeable: false,
    trigger,
    aggregateBeforeMinor: before,
    aggregateAfterMinor: after,
    paymentBaseMinor,
    catchUpBaseMinor: 0n,
    chargeableBaseMinor: 0n,
    explanation,
  });

  if (paymentBaseMinor <= 0n) {
    return nothing("below", "Nothing to deduct on — the base is zero.");
  }

  /* --- 192 and 195: no threshold this engine can apply ------------ */
  if (rule.thresholdMode === "none") {
    return {
      chargeable: true,
      trigger: "no_threshold",
      aggregateBeforeMinor: before,
      aggregateAfterMinor: after,
      paymentBaseMinor,
      catchUpBaseMinor: 0n,
      chargeableBaseMinor: paymentBaseMinor,
      explanation:
        `Section ${rule.code} has no threshold this engine applies. ` + rule.note,
    };
  }

  /* --- ⭐ 194IA: a cliff, per transaction, no aggregation --------- */
  if (rule.thresholdMode === "per_transaction_whole") {
    const limit = rule.singleThresholdMinor ?? 0n;
    const reached = meets(paymentBaseMinor, limit, inclusive);
    if (!reached) {
      return nothing(
        "below",
        `This transfer is ${formatPaise(paymentBaseMinor)}, below the ` +
          `${formatPaise(limit)} at which Section ${rule.code} begins. ⚠️ It is a ` +
          `cliff, not a slab: nothing is deductible below it and the WHOLE ` +
          `consideration is deductible at or above it. Check the stamp duty ` +
          `value too — the higher of the two decides both.`,
      );
    }
    return {
      chargeable: true,
      trigger: "per_transaction",
      aggregateBeforeMinor: before,
      aggregateAfterMinor: after,
      paymentBaseMinor,
      catchUpBaseMinor: 0n,
      // ⭐ THE WHOLE CONSIDERATION, NOT THE EXCESS OVER ₹50 LAKH.
      chargeableBaseMinor: paymentBaseMinor,
      explanation:
        `⭐ ${formatPaise(paymentBaseMinor)} is at or above the ` +
        `${formatPaise(limit)} threshold in Section ${rule.code}, so tax is ` +
        `deductible on the WHOLE consideration — not on the excess. ⚠️ Deducted ` +
        `by the BUYER, paid on Form 26QB within 30 days of the end of the month, ` +
        `and no TAN is needed for it.`,
    };
  }

  /* --- ⭐ 194Q: aggregate threshold, tax on the EXCESS only ------- */
  if (rule.thresholdMode === "aggregate_excess") {
    const limit = rule.annualThresholdMinor ?? 0n;
    if (!meets(after, limit, inclusive)) {
      return nothing(
        "below",
        `${formatPaise(after)} bought from this seller so far this year, against ` +
          `the ${formatPaise(limit)} at which Section ${rule.code} begins. ` +
          `Nothing is deductible yet.`,
      );
    }

    // ⭐ Everything above the limit is chargeable; everything below it is
    // not, ever. `alreadyCharged` stops the excess being charged twice
    // across successive payments.
    const totalChargeable = after > limit ? after - limit : 0n;
    const alreadyCharged = accumulation.chargedMinor;
    const nowChargeable =
      totalChargeable > alreadyCharged ? totalChargeable - alreadyCharged : 0n;

    if (nowChargeable <= 0n) {
      return nothing(
        "already_crossed",
        `The excess over ${formatPaise(limit)} has already been charged in full.`,
      );
    }

    // The part of this payment that is a catch-up is whatever of it sits
    // on top of an aggregate that had already passed the limit.
    const fromThisPayment =
      nowChargeable > paymentBaseMinor ? paymentBaseMinor : nowChargeable;
    const catchUp = nowChargeable - fromThisPayment;

    return {
      chargeable: true,
      trigger: before >= limit ? "already_crossed" : "annual_aggregate",
      aggregateBeforeMinor: before,
      aggregateAfterMinor: after,
      paymentBaseMinor,
      catchUpBaseMinor: catchUp,
      chargeableBaseMinor: nowChargeable,
      explanation:
        `⭐ ${formatPaise(after)} bought from this seller this year, past the ` +
        `${formatPaise(limit)} threshold in Section ${rule.code}. Tax is on the ` +
        `EXCESS ONLY — ${formatPaise(nowChargeable)} — not on the whole purchase. ` +
        `⚠️ Charging the whole aggregate here would over-deduct by a factor of ` +
        `several, and the seller can only recover it on their own return.`,
    };
  }

  /* --- ⭐⭐ THE AGGREGATE-WHOLE SECTIONS. 194C AND FRIENDS. ------- */

  const annual = rule.annualThresholdMinor;
  const single = rule.singleThresholdMinor;

  const singleTriggered =
    single !== null && single !== undefined && meets(paymentBaseMinor, single, inclusive);
  const annualTriggered =
    annual !== null && annual !== undefined && meets(after, annual, inclusive);
  // The threshold was crossed by an EARLIER payment, so everything since
  // has been charged and this payment simply continues.
  const alreadyCrossed = accumulation.chargedMinor > 0n;

  if (!singleTriggered && !annualTriggered && !alreadyCrossed) {
    const parts: string[] = [];
    if (single !== null && single !== undefined) {
      parts.push(
        `${formatPaise(paymentBaseMinor)} is below the ${formatPaise(single)} ` +
          `single-payment limit`,
      );
    }
    if (annual !== null && annual !== undefined) {
      parts.push(
        `${formatPaise(after)} for the year is below the ${formatPaise(annual)} ` +
          `annual limit`,
      );
    }
    return nothing(
      "below",
      `No deduction yet under Section ${rule.code}: ${parts.join(", and ")}. ` +
        `⚠️ This payment still COUNTS toward the year — ${formatPaise(after)} of ` +
        `${formatPaise(annual ?? 0n)} — and when the aggregate reaches the limit, ` +
        `tax becomes due on all of it, including this one.`,
    );
  }

  const trigger: ThresholdTrigger = alreadyCrossed
    ? "already_crossed"
    : singleTriggered && !annualTriggered
      ? "single_payment"
      : "annual_aggregate";

  /* --- ⭐ THE CATCH-UP. THE WHOLE POINT OF THE FILE. -------------- */
  //
  // Everything paid this year, less whatever has already been brought
  // into charge. At the ANNUAL crossing that is the current payment PLUS
  // every earlier one; afterwards it is just the current payment.
  //
  // ⚠️ EXCEPT ON THE SINGLE-PAYMENT LIMB, WHICH CATCHES NOTHING UP AND IS
  // THE EASIEST PLACE TO OVER-DEDUCT. A ₹5,000 payment followed by a
  // ₹40,000 one under Section 194C: the second crosses the ₹30,000
  // single-payment limit, so tax is due ON IT — but the aggregate is
  // ₹45,000, nowhere near the ₹1,00,000 annual limb, so the earlier
  // ₹5,000 was never chargeable and does not become chargeable now.
  // Sweeping it in would take ₹50 the deductee can only recover on their
  // own return a year later.
  let chargeable: bigint;
  let catchUp: bigint;
  if (trigger === "single_payment") {
    chargeable = paymentBaseMinor;
    catchUp = 0n;
  } else {
    chargeable = after - accumulation.chargedMinor;
    catchUp = chargeable > paymentBaseMinor ? chargeable - paymentBaseMinor : 0n;
  }

  if (chargeable <= 0n) {
    return nothing(
      "already_crossed",
      "Every rupee paid to this deductee under this section has already been " +
        "brought into charge.",
    );
  }

  let explanation: string;
  if (trigger === "single_payment") {
    explanation =
      `${formatPaise(paymentBaseMinor)} is at or above the ` +
      `${formatPaise(single ?? 0n)} single-payment limit in Section ${rule.code}, ` +
      `so tax is deductible on this payment whatever the year's total is.`;
  } else if (trigger === "annual_aggregate" && catchUp > 0n) {
    explanation =
      `⭐ THE ANNUAL THRESHOLD HAS BEEN CROSSED. ${formatPaise(after)} has now ` +
      `been paid to this deductee under Section ${rule.code} this financial year, ` +
      `at or above the ${formatPaise(annual ?? 0n)} limit — so tax is deductible ` +
      `on the WHOLE aggregate, not on this payment alone. ` +
      `${formatPaise(catchUp)} of earlier payments is brought into charge now, ` +
      `giving a chargeable base of ${formatPaise(chargeable)} against a payment ` +
      `of ${formatPaise(paymentBaseMinor)}. ⚠️ Deducting on ` +
      `${formatPaise(paymentBaseMinor)} alone is the classic under-deduction: ` +
      `Section 201(1) makes the shortfall ours, with interest, and 30% of the ` +
      `expenditure is disallowed under Section 40(a)(ia).`;
  } else if (trigger === "annual_aggregate") {
    explanation =
      `${formatPaise(after)} for the year is at or above the ` +
      `${formatPaise(annual ?? 0n)} annual limit in Section ${rule.code}, so tax ` +
      `is deductible.`;
  } else {
    explanation =
      `The threshold under Section ${rule.code} was crossed earlier this year ` +
      `(${formatPaise(before)} already paid), so every payment since is ` +
      `chargeable in full.`;
  }

  return {
    chargeable: true,
    trigger,
    aggregateBeforeMinor: before,
    aggregateAfterMinor: after,
    paymentBaseMinor,
    catchUpBaseMinor: catchUp,
    chargeableBaseMinor: chargeable,
    explanation,
  };
}

/**
 * Convenience wrapper: the same question from a section code and the raw
 * prior rows.
 */
export function assessThresholdFor(args: {
  section: Parameters<typeof sectionRule>[0];
  paymentBaseMinor: bigint;
  prior: readonly PriorDeduction[];
  thresholdIsInclusive?: boolean;
}): ThresholdVerdict {
  return assessThreshold({
    rule: sectionRule(args.section),
    paymentBaseMinor: args.paymentBaseMinor,
    accumulation: accumulate(args.prior),
    thresholdIsInclusive: args.thresholdIsInclusive,
  });
}

/* ------------------------------------------------------------------ */
/* THE SHORTFALL REPORT                                                */
/* ------------------------------------------------------------------ */

export type ShortfallFinding = {
  deducteeId: string;
  section: string;
  financialYear: string;
  aggregateMinor: bigint;
  chargedMinor: bigint;
  /** ⭐ Base that should have been charged and was not. */
  uncharged: bigint;
  /** Tax on it, at the rate given. */
  shortfallTaxMinor: bigint;
  message: string;
};

/**
 * ⭐ WHO HAS CROSSED A THRESHOLD AND NOT BEEN CAUGHT UP?
 *
 * The report that finds the mistake this file exists to prevent, in a
 * ledger where it has ALREADY happened — which is most ledgers, because
 * every workspace arrives with a year of history entered by somebody who
 * tested each payment on its own.
 *
 * ⚠️ IT REPORTS THE TAX AS WELL AS THE BASE, and the tax is the number
 * that gets it acted on. "₹4,00,000 of contractor payments has not been
 * caught up" is an accounting observation. "₹4,000 is payable under
 * Section 201(1), plus interest, plus a ₹1,20,000 disallowance" is a
 * decision somebody makes this afternoon.
 */
export function findThresholdShortfalls(
  groups: readonly {
    deducteeId: string;
    section: Parameters<typeof sectionRule>[0];
    financialYear: string;
    prior: readonly PriorDeduction[];
    /** The rate that would have applied. From `lib/tds/rates.ts`. */
    rateBps: number;
  }[],
  options?: { thresholdIsInclusive?: boolean },
): ShortfallFinding[] {
  const inclusive = options?.thresholdIsInclusive ?? THRESHOLD_IS_INCLUSIVE;
  const findings: ShortfallFinding[] = [];

  for (const group of groups) {
    const rule = sectionRule(group.section);
    if (rule.thresholdMode !== "aggregate_whole") continue;

    const acc = accumulate(group.prior);
    const annual = rule.annualThresholdMinor;
    if (annual === null || annual === undefined) continue;
    if (!meets(acc.aggregateMinor, annual, inclusive)) continue;

    const uncharged = acc.aggregateMinor - acc.chargedMinor;
    if (uncharged <= 0n) continue;

    findings.push({
      deducteeId: group.deducteeId,
      section: group.section,
      financialYear: group.financialYear,
      aggregateMinor: acc.aggregateMinor,
      chargedMinor: acc.chargedMinor,
      uncharged,
      shortfallTaxMinor: tdsOn(uncharged, group.rateBps),
      message:
        `⭐ ${formatPaise(acc.aggregateMinor)} has been paid under Section ` +
        `${rule.code} this year, past the ${formatPaise(annual)} annual ` +
        `threshold, but tax has only been computed on ` +
        `${formatPaise(acc.chargedMinor)}. ${formatPaise(uncharged)} of base is ` +
        `uncharged — ${formatPaise(tdsOn(uncharged, group.rateBps))} of tax. ` +
        `⚠️ Section 201(1) makes that shortfall ours whether or not the deductee ` +
        `paid their own tax on it, interest under 201(1A) runs from the date each ` +
        `payment was made, and 30% of the expenditure is disallowed under Section ` +
        `40(a)(ia).`,
    });
  }

  return findings;
}

/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE ONE COMPARISON THE WHOLE FILE TURNS ON. See the header for why
 * `>=` is the default and what the flag costs either way.
 */
function meets(amount: bigint, threshold: bigint, inclusive: boolean): boolean {
  return inclusive ? amount >= threshold : amount > threshold;
}
