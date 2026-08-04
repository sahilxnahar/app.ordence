/**
 * Ordence — ⭐ Building a Demand
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. Money is `bigint` paise; rates are basis points.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT A DEMAND IS BUILT FROM, AND WHAT IT MAY NOT BE BUILT WITHOUT
 * ══════════════════════════════════════════════════════════════════════
 * A demand takes a `payment_milestones` row from Phase 22 — the agreed
 * instalment — and turns it into a document that can be served:
 *
 *   milestone amount              → the principal
 *   + GST (`lib/gst/tax.ts`)      → the tax, computed per line and summed
 *   + the construction event      → ⭐ what triggered it, and when
 *   + the agreement's rate        → the interest terms, frozen on
 *   = a legal document under RERA
 *
 * ⚠️ THE TRIGGER IS NOT OPTIONAL AND IS NOT DECORATION. A demand under a
 * construction-linked plan derives its whole force from the event having
 * happened. "The third slab was not cast when you demanded for it" is the
 * buyer's complete answer at the Authority, and a demand that does not
 * state the event and the date it was achieved cannot answer it. So
 * `buildDemand` REFUSES to produce one — the refusal is at the point the
 * demand is created, where somebody can still go and ask the site
 * engineer, rather than months later when it is needed.
 *
 * ⚠️ AND `computeInvoiceTax` IS IMPORTED, NEVER RESTATED. A second GST
 * computation that differs by a paisa from the one the tax invoice uses
 * is a difference between the demand and the invoice raised against it —
 * two documents about the same money, in the same buyer's file,
 * disagreeing.
 */

import { computeInvoiceTax } from "@/lib/gst/tax";
import type { GstTaxKind } from "@/lib/gst/place-of-supply";
import { halfRateBps } from "@/lib/gst/constants";
import type {
  DemandStatus,
  DemandTriggerKind,
  InterestCompounding,
  InterestDayCount,
} from "@/db/schema/receivables";
import {
  accrueInterest,
  assessInterestRate,
  addDays,
  describeInterestBasis,
  toCivilDay,
  type InterestAccrual,
  type InterestTerms,
  type RateVerdict,
} from "./interest";
import { daysOverdue } from "./ageing";
import { formatPaise } from "./numbers";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

export type DemandTrigger = {
  kind: DemandTriggerKind;
  /** "On completion of the 3rd slab" — the milestone's own words. */
  label: string;
  /** ⭐ The civil day the event happened. Never the day it was billed. */
  achievedOn: string;
  /** The engineer's certificate, the RERA quarterly update, a photo ref. */
  evidence?: string | null;
};

export type DemandPolicyTerms = {
  /** Days from the notice date to the due date. */
  demandDueDays: number;
  /** GST on the construction service. 500 = 5%. */
  gstRateBps: number;
  interestRateBps: number;
  referenceRateBps: number;
  compounding: InterestCompounding;
  dayCount: InterestDayCount;
  graceDays: number;
  graceForgivesElapsedDays?: boolean;
};

export type DemandMilestone = {
  id: string;
  label: string;
  sequence: number;
  amountMinor: bigint;
  amountPaidMinor: bigint;
};

export type BuildDemandInput = {
  milestone: DemandMilestone;
  trigger: DemandTrigger;
  noticeDate: string;
  policy: DemandPolicyTerms;
  /**
   * ⚠️ THE PLACE OF SUPPLY FOR A FLAT IS THE FLAT'S STATE, NOT THE
   * BUYER'S. Section 12(3) of the IGST Act: a supply relating to
   * immovable property is supplied where the property is. An NRI buyer in
   * Dubai buying in Bengaluru is a KARNATAKA supply — CGST + SGST — and
   * taxing it as IGST because the buyer's address is abroad puts the tax
   * in the wrong government's hands. Phase 32 enforces this on the
   * invoice; the demand has to agree with the invoice.
   */
  taxKind: GstTaxKind;
  placeOfSupplyCode: string;
  /** Charge only part of the milestone. Defaults to the whole balance. */
  principalOverrideMinor?: bigint;
  hsnSacCode?: string | null;
};

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type DemandAmounts = {
  principalMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  gstRateBps: number;
};

export type BuiltDemand = {
  amounts: DemandAmounts;
  noticeDate: string;
  dueDate: string;
  trigger: DemandTrigger;
  interestTerms: InterestTerms;
  /** ⭐ The sentence that goes on the notice, and into the column. */
  interestBasisNote: string;
  /** ⭐ Whether the agreement's rate exceeds the RERA reference rate. */
  rateVerdict: RateVerdict;
  milestone: DemandMilestone;
};

export type DemandProblem = { message: string; remedy: string };

export type BuildDemandResult =
  | { ok: true; demand: BuiltDemand }
  | { ok: false; problem: DemandProblem };

/* ------------------------------------------------------------------ */
/* THE BUILD                                                           */
/* ------------------------------------------------------------------ */

export function buildDemand(input: BuildDemandInput): BuildDemandResult {
  const { milestone, trigger, policy } = input;
  const noticeDate = toCivilDay(input.noticeDate);

  /* --- ⭐ THE TRIGGER, FIRST, BECAUSE IT IS THE DOCUMENT. -------- */
  if (!trigger.label || trigger.label.trim() === "") {
    return {
      ok: false,
      problem: {
        message: "This demand does not say what fell due.",
        remedy:
          "Name the event — \"on completion of the 3rd slab\". ⚠️ A demand under " +
          "RERA derives its force from the event having happened, and a document " +
          "that does not state it cannot answer the buyer who says it had not.",
      },
    };
  }

  if (!trigger.achievedOn) {
    return {
      ok: false,
      problem: {
        message: "This demand does not say WHEN the event that triggered it happened.",
        remedy:
          "Record the date from the engineer's certificate or the RERA quarterly " +
          "update. Without it there is nothing on the document to answer \"the slab " +
          "was not cast when you demanded for it\".",
      },
    };
  }

  const achievedOn = toCivilDay(trigger.achievedOn);

  // ⚠️ A DEMAND DATED BEFORE ITS OWN TRIGGER IS THE COMPLAINT WRITING
  // ITSELF. It happens when somebody back-dates a notice to start the
  // interest clock earlier, and it is visible on the face of the document
  // to anybody who reads the two dates.
  if (daysOverdue(achievedOn, noticeDate) < 0) {
    return {
      ok: false,
      problem: {
        message:
          `This notice is dated ${noticeDate} but says the event that triggered it ` +
          `happened on ${achievedOn} — after the demand.`,
        remedy:
          "Correct one of the dates. A demand dated before the event it relies on " +
          "is the buyer's complaint written by the developer, on the face of the " +
          "document.",
      },
    };
  }

  /* --- The principal. -------------------------------------------- */
  const balance = milestone.amountMinor - milestone.amountPaidMinor;
  const principal = input.principalOverrideMinor ?? balance;

  if (principal <= 0n) {
    return {
      ok: false,
      problem: {
        message: `Nothing is outstanding on the milestone "${milestone.label}".`,
        remedy:
          "It has already been collected. Raising a demand for it would put a " +
          "second document in the buyer's hands for money they have paid.",
      },
    };
  }

  if (principal > balance) {
    return {
      ok: false,
      problem: {
        message:
          `₹${formatPaise(principal)} was entered against a milestone with only ` +
          `₹${formatPaise(balance)} left on it.`,
        remedy:
          "Reduce it. Demanding more than the payment plan provides for is not a " +
          "rounding argument — it is a consumer-forum complaint, and the plan is " +
          "an annexure to the agreement the buyer signed.",
      },
    };
  }

  /* --- ⭐ TAX, THROUGH PHASE 32'S ENGINE. ------------------------ */
  //
  // ⚠️ ONE LINE, NOT A TOTAL. `computeInvoiceTax` rounds per line and then
  // sums, so the tax column on the invoice raised against this demand adds
  // up to its own total by construction. Handing it a pre-summed figure
  // would produce a demand whose tax differs from that invoice by a rupee.
  const tax = computeInvoiceTax({
    taxKind: input.taxKind,
    placeOfSupplyCode: input.placeOfSupplyCode,
    lines: [
      {
        key: milestone.id,
        description: milestone.label,
        hsnSacCode: input.hsnSacCode ?? null,
        grossMinor: principal,
        rateBps: policy.gstRateBps,
      },
    ],
  });

  const amounts: DemandAmounts = {
    principalMinor: principal,
    cgstMinor: tax.cgstMinor,
    sgstMinor: tax.sgstMinor,
    igstMinor: tax.igstMinor,
    cessMinor: tax.cessMinor,
    taxMinor: tax.totalTaxMinor,
    totalMinor: principal + tax.totalTaxMinor,
    gstRateBps: policy.gstRateBps,
  };

  /* --- ⭐ INTEREST TERMS, FROZEN ON TO THE DOCUMENT. ------------- */
  const dueDate = addDays(noticeDate, Math.max(0, policy.demandDueDays));

  const interestTerms: InterestTerms = {
    rateBps: policy.interestRateBps,
    compounding: policy.compounding,
    dayCount: policy.dayCount,
    graceDays: policy.graceDays,
    graceForgivesElapsedDays: policy.graceForgivesElapsedDays ?? false,
  };

  return {
    ok: true,
    demand: {
      amounts,
      noticeDate,
      dueDate,
      trigger: { ...trigger, achievedOn },
      interestTerms,
      interestBasisNote: describeInterestBasis({ terms: interestTerms, dueDate }),
      rateVerdict: assessInterestRate({
        rateBps: policy.interestRateBps,
        referenceRateBps: policy.referenceRateBps,
      }),
      milestone,
    },
  };
}

/* ------------------------------------------------------------------ */
/* THE STATE OF AN ISSUED DEMAND                                       */
/* ------------------------------------------------------------------ */

export type DemandFacts = {
  status: DemandStatus;
  dueDate: string;
  totalMinor: bigint;
  principalMinor: bigint;
  taxMinor: bigint;
  allocatedMinor: bigint;
  interestPaidMinor: bigint;
  interestTerms: InterestTerms;
};

export type DemandPosition = {
  status: DemandStatus;
  outstandingMinor: bigint;
  /**
   * ⚠️ SPLIT PRO-RATA, THE SAME WAY `allocation.ts` SPLITS A RECEIPT. If
   * the two disagreed, the outstanding principal shown on a statement
   * would not be the figure the next receipt is applied against.
   */
  outstandingPrincipalMinor: bigint;
  outstandingTaxMinor: bigint;
  daysOverdue: number;
  interest: InterestAccrual;
  outstandingInterestMinor: bigint;
  /** principal + tax + interest. What clears the demand today. */
  payableTodayMinor: bigint;
};

/**
 * ⭐ WHAT IS ACTUALLY OWED ON A DEMAND TODAY.
 *
 * ⚠️ DERIVED, NOT READ FROM `status`. `demand_notices.status` is a column,
 * and a column is what a background job or a careless UPDATE gets wrong.
 * The two numbers that cannot lie are the total and what has been applied
 * against it — the same reasoning as `deriveMilestoneStatus` in
 * `lib/sales/payment-plan.ts`, and for the same reason: a stale status
 * shows up as a discrepancy instead of quietly becoming the truth.
 */
export function demandPosition(facts: DemandFacts, asOf: string): DemandPosition {
  const outstanding = facts.totalMinor - facts.allocatedMinor;
  const late = daysOverdue(facts.dueDate, asOf);

  // Pro-rata, remainder to principal — identical to `splitAcrossLegs`.
  const body = facts.principalMinor + facts.taxMinor;
  const outstandingTax =
    body > 0n && outstanding > 0n ? (outstanding * facts.taxMinor) / body : 0n;
  const outstandingPrincipal = outstanding > 0n ? outstanding - outstandingTax : 0n;

  // ⚠️ INTEREST IS ON THE OUTSTANDING PRINCIPAL, NOT ON THE TOTAL. The
  // GST element was collected for the Government; charging delay interest
  // on it turns a compliance amount into a revenue line, and it is the
  // first thing a buyer's accountant spots.
  const interest = accrueInterest({
    principalMinor: outstandingPrincipal,
    dueDate: facts.dueDate,
    asOf,
    terms: facts.interestTerms,
  });

  const outstandingInterest =
    interest.interestMinor - facts.interestPaidMinor > 0n
      ? interest.interestMinor - facts.interestPaidMinor
      : 0n;

  return {
    status: deriveDemandStatus(facts, asOf),
    outstandingMinor: outstanding > 0n ? outstanding : 0n,
    outstandingPrincipalMinor: outstandingPrincipal,
    outstandingTaxMinor: outstandingTax,
    daysOverdue: late,
    interest,
    outstandingInterestMinor: outstandingInterest,
    payableTodayMinor: (outstanding > 0n ? outstanding : 0n) + outstandingInterest,
  };
}

/**
 * The status the money implies.
 *
 * ⚠️ `cancelled` AND `superseded` ARE NOT DERIVED — they are decisions
 * somebody made, and no amount of arithmetic can discover them. They pass
 * through untouched, which is what keeps this function safe to call on
 * every row of a list.
 */
export function deriveDemandStatus(facts: DemandFacts, asOf: string): DemandStatus {
  if (facts.status === "cancelled" || facts.status === "superseded") return facts.status;
  if (facts.status === "draft") return "draft";

  if (facts.allocatedMinor >= facts.totalMinor && facts.totalMinor > 0n) return "paid";
  if (facts.allocatedMinor > 0n) return "part_paid";

  // ⚠️ THERE IS NO `overdue` STATUS ON A DEMAND, DELIBERATELY, AND
  // `sales_payment_status` ON A MILESTONE HAS ONE. A milestone is a plan
  // and "overdue" is news about it; a demand is a document, and being
  // late is a fact about the calendar rather than a change in what the
  // document is. Lateness is `daysOverdue` and the ageing bucket — both
  // computed from the same due date, both moving on their own.
  void asOf;
  return "issued";
}

/**
 * Which GST heads a rate splits into, for display beside a demand.
 * ⚠️ `halfRateBps` comes from Phase 32 — 5% intra-state is 2.5% + 2.5%
 * and an odd basis-point rate must not be halved twice differently.
 */
export function describeGstSplit(
  gstRateBps: number,
  taxKind: GstTaxKind,
): { heads: Array<{ label: string; rateBps: number }> } {
  if (taxKind === "igst") {
    return { heads: [{ label: "IGST", rateBps: gstRateBps }] };
  }
  const half = halfRateBps(gstRateBps);
  return {
    heads: [
      { label: "CGST", rateBps: half },
      { label: taxKind === "cgst_utgst" ? "UTGST" : "SGST", rateBps: gstRateBps - half },
    ],
  };
}
