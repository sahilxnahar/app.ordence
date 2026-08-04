/**
 * Ordence — Construction-Linked Payment Plans
 * Version: v0.22.0-alpha
 *
 * Pure and isomorphic. Every amount is `bigint` paise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT A PAYMENT PLAN IS, AND WHY THE ARITHMETIC MUST BE EXACT
 * ══════════════════════════════════════════════════════════════════════
 * An Indian residential buyer does not pay on a date. They pay on an
 * EVENT — "on completion of the third slab", "on commencement of
 * flooring" — because RERA ties collection to construction progress for
 * escrowed projects. That is why milestones carry a `sequence` and a
 * label rather than only a due date.
 *
 * The arithmetic matters more than it looks. The milestones must sum to
 * the agreement value EXACTLY:
 *
 *   • Short by ₹1 and the final demand under-collects, the account never
 *     closes, and somebody chases a rupee for a year.
 *   • Over by ₹1 and you have demanded more than the agreement — which
 *     is a consumer-forum complaint, not a rounding note.
 *
 * Percentages of a crore do not divide evenly. So the split is done in
 * bigint and the remainder is placed deliberately (see `buildPlan`),
 * never left to accumulate.
 */

import type { SalesPaymentStatus } from "@/db/schema/sales";

/* ------------------------------------------------------------------ */
/* TEMPLATES                                                           */
/* ------------------------------------------------------------------ */

export type PlanStageTemplate = {
  label: string;
  /** Basis points of the agreement value. 1000 = 10%. */
  shareBps: number;
};

export type PlanTemplate = {
  key: string;
  name: string;
  description: string;
  stages: readonly PlanStageTemplate[];
};

/**
 * ⚠️ THESE ARE STARTING POINTS, NOT PRODUCT RULES.
 *
 * The user asked for a highly customisable platform, and a payment plan
 * is the clearest case: every developer has their own, negotiated per
 * project and sometimes per buyer. Hard-coding one would make the
 * product unusable for anyone whose plan differs by a single stage.
 *
 * So templates are DATA. A tenant can define their own, and these three
 * exist so a new workspace is not staring at an empty form. They are the
 * three shapes that cover most of the Indian market.
 */
export const PLAN_TEMPLATES: readonly PlanTemplate[] = Object.freeze([
  {
    key: "construction_linked",
    name: "Construction-linked (CLP)",
    description:
      "Collection tied to build progress. The standard for under-construction " +
      "residential projects and what RERA escrow assumes.",
    stages: Object.freeze([
      { label: "On booking", shareBps: 1000 },
      { label: "On agreement execution", shareBps: 1500 },
      { label: "On completion of foundation", shareBps: 1000 },
      { label: "On completion of 3rd slab", shareBps: 1000 },
      { label: "On completion of 7th slab", shareBps: 1000 },
      { label: "On completion of structure", shareBps: 1500 },
      { label: "On commencement of flooring", shareBps: 1000 },
      { label: "On completion of internal finishes", shareBps: 1000 },
      { label: "On offer of possession", shareBps: 1000 },
    ]),
  },
  {
    key: "down_payment",
    name: "Down payment",
    description:
      "Most of the money up front in exchange for a discount. Common with " +
      "investors and NRI buyers.",
    stages: Object.freeze([
      { label: "On booking", shareBps: 1000 },
      { label: "Within 30 days of booking", shareBps: 8500 },
      { label: "On offer of possession", shareBps: 500 },
    ]),
  },
  {
    key: "possession_linked",
    name: "Possession-linked (20:80)",
    description:
      "A fifth now, the balance on possession. Usually paired with a " +
      "subvention arrangement with the lender.",
    stages: Object.freeze([
      { label: "On booking", shareBps: 2000 },
      { label: "On offer of possession", shareBps: 8000 },
    ]),
  },
]);

export function templateFor(key: string): PlanTemplate | null {
  return PLAN_TEMPLATES.find((t) => t.key === key) ?? null;
}

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

export const FULL_BPS = 10_000;

export type TemplateProblem = {
  message: string;
  remedy: string;
};

/**
 * ⚠️ Checked as INTEGER BASIS POINTS, never as summed percentages.
 *
 * `10 + 15 + 10 + 10 + 10 + 15 + 10 + 10 + 10` in floating point is
 * 99.99999999999999. A validator written the obvious way rejects a plan
 * that is arithmetically perfect, and the developer who wrote it spends
 * an hour convinced they cannot count.
 */
export function validateTemplate(
  stages: readonly PlanStageTemplate[],
): TemplateProblem | null {
  if (stages.length === 0) {
    return {
      message: "A payment plan needs at least one stage.",
      remedy: "Add a stage, or use one of the built-in templates.",
    };
  }

  for (const stage of stages) {
    if (!stage.label.trim()) {
      return {
        message: "Every stage needs a label.",
        remedy:
          "Name what triggers the payment — buyers and site engineers both " +
          "read these.",
      };
    }
    if (!Number.isInteger(stage.shareBps) || stage.shareBps <= 0) {
      return {
        message: `Stage “${stage.label}” has an invalid share.`,
        remedy: "Each stage must be a positive whole percentage.",
      };
    }
  }

  const total = stages.reduce((sum, s) => sum + s.shareBps, 0);
  if (total !== FULL_BPS) {
    const pct = (total / 100).toFixed(2);
    return {
      message: `The stages add up to ${pct}%, not 100%.`,
      remedy:
        total < FULL_BPS
          ? `Add ${((FULL_BPS - total) / 100).toFixed(2)}% somewhere, or the ` +
            `final demand will under-collect and the account will never close.`
          : `Remove ${((total - FULL_BPS) / 100).toFixed(2)}% — demanding more ` +
            `than the agreement value is a consumer-forum complaint waiting ` +
            `to happen.`,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* BUILDING A PLAN                                                     */
/* ------------------------------------------------------------------ */

export type PlannedMilestone = {
  sequence: number;
  label: string;
  amountMinor: bigint;
  shareBps: number;
};

export type PlanBuildResult =
  | { ok: true; milestones: PlannedMilestone[]; totalMinor: bigint }
  | { ok: false; problem: TemplateProblem };

/**
 * Turn a template and an agreement value into exact milestone amounts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHERE THE REMAINDER GOES, AND WHY IT IS THE LAST STAGE
 * ══════════════════════════════════════════════════════════════════════
 * 10% of ₹87,45,633 is not a whole number of paise. Nine such stages
 * leave a remainder of a few paise, and it has to land somewhere.
 *
 * It goes on the LAST stage, deliberately:
 *
 *   • Putting it FIRST inflates the booking demand — the very first
 *     number the buyer sees would not match the percentage in their
 *     agreement, and that conversation happens on day one.
 *   • Spreading it makes every stage a fraction off its stated
 *     percentage, so none of them reconcile.
 *   • On the LAST stage it lands on the possession demand, which is
 *     already reconciled against the final account and is where a small
 *     adjustment is expected and explicable.
 *
 * The invariant this preserves is the one that actually matters:
 * **sum(milestones) === agreementValue, exactly, always.**
 */
export function buildPlan(args: {
  agreementValueMinor: bigint;
  stages: readonly PlanStageTemplate[];
}): PlanBuildResult {
  const { agreementValueMinor, stages } = args;

  if (agreementValueMinor <= 0n) {
    return {
      ok: false,
      problem: {
        message: "The booking has no agreement value.",
        remedy: "Record the agreed sale value before generating a payment plan.",
      },
    };
  }

  const problem = validateTemplate(stages);
  if (problem) return { ok: false, problem };

  const milestones: PlannedMilestone[] = [];
  let allocated = 0n;

  stages.forEach((stage, index) => {
    const isLast = index === stages.length - 1;
    // Integer arithmetic end to end. `* BigInt(shareBps) / 10000n`
    // truncates, which is what we want — the shortfall is collected and
    // handed to the final stage rather than being rounded away here.
    const amount = isLast
      ? agreementValueMinor - allocated
      : (agreementValueMinor * BigInt(stage.shareBps)) / BigInt(FULL_BPS);

    allocated += amount;
    milestones.push({
      sequence: index + 1,
      label: stage.label,
      amountMinor: amount,
      shareBps: stage.shareBps,
    });
  });

  // Belt and braces. If this ever fires, the loop above is wrong and a
  // silent ₹1 discrepancy is heading for a buyer's statement.
  const total = milestones.reduce((sum, m) => sum + m.amountMinor, 0n);
  if (total !== agreementValueMinor) {
    return {
      ok: false,
      problem: {
        message: "The generated milestones do not sum to the agreement value.",
        remedy:
          "This is a defect, not a data problem. Do not issue demands from " +
          "this plan — report it.",
      },
    };
  }

  return { ok: true, milestones, totalMinor: total };
}

/* ------------------------------------------------------------------ */
/* STATUS                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ DERIVED, NOT STORED-AND-TRUSTED.
 *
 * `payment_milestones.status` exists as a column, and it is the column a
 * background job or a careless UPDATE gets wrong. The board computes
 * from the two numbers that cannot lie — what was demanded and what was
 * received — so a stale status column shows up as a discrepancy instead
 * of quietly becoming the truth.
 */
export function deriveMilestoneStatus(args: {
  amountMinor: bigint;
  amountPaidMinor: bigint;
  dueDate: Date | null;
  now: Date;
}): SalesPaymentStatus {
  const { amountMinor, amountPaidMinor, dueDate, now } = args;

  if (amountPaidMinor >= amountMinor && amountMinor > 0n) return "paid";

  const overdue = dueDate !== null && dueDate.getTime() < now.getTime();
  if (overdue) return "overdue";

  return amountPaidMinor > 0n ? "partial" : "pending";
}

export type PlanSummary = {
  totalMinor: bigint;
  collectedMinor: bigint;
  outstandingMinor: bigint;
  overdueMinor: bigint;
  collectedPct: number;
  nextDue: { label: string; amountMinor: bigint; dueDate: Date | null } | null;
};

export function summarisePlan(
  milestones: readonly {
    label: string;
    sequence: number;
    amountMinor: bigint;
    amountPaidMinor: bigint;
    dueDate: Date | null;
  }[],
  now: Date,
): PlanSummary {
  let total = 0n;
  let collected = 0n;
  let overdue = 0n;
  let next: PlanSummary["nextDue"] = null;

  const ordered = [...milestones].sort((a, b) => a.sequence - b.sequence);

  for (const m of ordered) {
    total += m.amountMinor;
    // ⚠️ Clamped. An over-payment on one milestone must not make the
    // whole plan look further collected than it is — the excess is a
    // credit, and it belongs in the ledger, not in this percentage.
    const paid = m.amountPaidMinor > m.amountMinor ? m.amountMinor : m.amountPaidMinor;
    collected += paid;

    const outstanding = m.amountMinor - paid;
    if (outstanding > 0n) {
      if (m.dueDate && m.dueDate.getTime() < now.getTime()) {
        overdue += outstanding;
      }
      if (!next) {
        next = { label: m.label, amountMinor: outstanding, dueDate: m.dueDate };
      }
    }
  }

  return {
    totalMinor: total,
    collectedMinor: collected,
    outstandingMinor: total - collected,
    overdueMinor: overdue,
    collectedPct:
      total === 0n
        ? 0
        : Math.round((Number((collected * 1000n) / total) / 1000) * 1000) / 10,
    nextDue: next,
  };
}
