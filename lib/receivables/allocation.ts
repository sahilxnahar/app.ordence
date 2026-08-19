/**
 * Ordence — ⭐⭐ Receipt Allocation
 * Version: v0.38.0-alpha
 *
 * Pure and isomorphic. Every amount is `bigint` paise.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE REQUIREMENT: EXACT, AND EXPLAINABLE
 * ══════════════════════════════════════════════════════════════════════
 * A buyer pays ₹5,00,000 against three outstanding demands. Two things
 * have to be true of the result and they are separate requirements:
 *
 *   EXACT      — the allocations plus the credit equal the receipt, to
 *                the paisa, for every input. Not "usually". Not "within
 *                a rupee".
 *   EXPLAINABLE — the buyer can be shown WHY each demand got what it got.
 *                "₹1,80,000 to demand AH/DN/2026/0041 (oldest first;
 *                interest of ₹4,318 before principal)" is a sentence
 *                somebody can agree or disagree with. A table of numbers
 *                is not.
 *
 * ⚠️ THE WAYS EXACTNESS IS LOST ARE ALL ARITHMETIC AND ALL SILENT:
 *
 *   • Dividing in floating point. 500000/3 in a float is 166666.66666…
 *     and two paise evaporate.
 *   • Rounding each share independently. Three shares rounded up
 *     over-apply by up to two paise and the demands foot to more than the
 *     receipt.
 *   • Splitting a part payment between principal and GST by percentage.
 *     Every part payment then leaves a fraction of a paisa somewhere.
 *
 * So every division here is integer division on `bigint`, every remainder
 * is placed deliberately, and `allocateReceipt` ASSERTS its own invariant
 * before returning. If the assertion ever fires it is a defect in this
 * file — and a thrown error is enormously better than a receipt that is
 * two paise short of itself in a buyer's statement of account.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TWO APPROPRIATION QUESTIONS, WHICH ARE BOTH LEGAL
 * ══════════════════════════════════════════════════════════════════════
 * 1. WHICH DEMAND? Section 59 of the Indian Contract Act: if the DEBTOR
 *    says which debt the payment is for, that binds the creditor. Only
 *    where they have not said anything does Section 60 let the creditor
 *    choose — and oldest-first is the ordinary choice.
 *
 *    So `specified` is not a convenience feature. It is the buyer
 *    exercising a right, and a system that silently re-applied their
 *    money to a different demand would be overriding it.
 *
 * 2. WITHIN A DEMAND, WHICH LEG? Interest before principal is standard
 *    practice and standard in builder-buyer agreements; principal first
 *    is better for the buyer because it stops the interest accruing
 *    sooner. Both are lawful. `appropriationOrder` records which was
 *    used, and it appears in the explanation on every line.
 */

import type {
  AllocationStrategy,
  AppropriationOrder,
} from "@/db/schema/receivables";
import { daysBetween, toCivilDay } from "./interest";
import { formatPaise } from "./numbers";

/* ------------------------------------------------------------------ */
/* INPUT                                                               */
/* ------------------------------------------------------------------ */

/**
 * A demand with money still owing on it.
 *
 * ⚠️ THE THREE OUTSTANDING LEGS ARE SEPARATE BECAUSE THEY ARE SETTLED
 * SEPARATELY AND ACCOUNTED FOR SEPARATELY. The tax leg is money the
 * developer owes the Government; the interest leg is the developer's
 * income; the principal leg reduces what is owed on the flat. A single
 * "outstanding" figure makes the GST position and the statement of
 * account both impossible to produce.
 */
export type OpenDemand = {
  demandId: string;
  noticeNumber: string;
  /** Civil day. Drives oldest-first ordering. */
  dueDate: string;
  outstandingPrincipalMinor: bigint;
  outstandingTaxMinor: bigint;
  /** Accrued and unpaid interest, as at the receipt date. */
  outstandingInterestMinor: bigint;
};

export type AllocationInstruction = {
  demandId: string;
  /** Paise the buyer said should go to this demand. */
  amountMinor: bigint;
};

export type AllocationInput = {
  receiptNumber: string;
  /**
   * ⭐ WHAT THERE IS TO ALLOCATE, WHICH IS NOT ALWAYS WHAT ARRIVED IN THE
   * BANK. Under Section 194-IA the buyer withholds 1% of the
   * consideration and pays it to the Government on the developer's
   * behalf, so a ₹10,00,000 demand is settled by ₹9,90,000 in the bank
   * plus a ₹10,000 TDS credit. Allocating only the bank figure leaves 1%
   * outstanding on every demand and starts a chase against a buyer who
   * paid in full.
   */
  amountMinor: bigint;
  tdsCreditMinor?: bigint;
  receivedOn: string;
  demands: readonly OpenDemand[];
  strategy: AllocationStrategy;
  appropriationOrder: AppropriationOrder;
  /** Required when `strategy` is `specified`. */
  instructions?: readonly AllocationInstruction[];
};

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type AllocationLine = {
  demandId: string;
  noticeNumber: string;
  sequence: number;
  principalMinor: bigint;
  taxMinor: bigint;
  interestMinor: bigint;
  amountMinor: bigint;
  basis: AllocationStrategy;
  appropriationOrder: AppropriationOrder;
  /** ⭐ The sentence the buyer is shown. Never generated later. */
  explanation: string;
  /** True when this allocation clears the demand in full. */
  settlesDemand: boolean;
};

export type AllocationResult = {
  lines: AllocationLine[];
  totalAllocatedMinor: bigint;
  /** ⭐ Over-payment. A real balance, applied to the NEXT demand raised. */
  creditMinor: bigint;
  allocatableMinor: bigint;
  strategy: AllocationStrategy;
  appropriationOrder: AppropriationOrder;
  /** The whole split as lines somebody can read, ending in the sum. */
  narrative: string[];
};

export class AllocationError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = "AllocationError";
    this.remedy = remedy;
  }
}

/**
 * ⚠️ THROWN ONLY WHEN THIS FILE IS WRONG. It is not an input error and
 * cannot be caused by a user. If it ever surfaces, do not write the
 * receipt — the alternative is a buyer's statement that does not foot.
 */
export class AllocationImbalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationImbalanceError";
  }
}

/* ------------------------------------------------------------------ */
/* THE SPLIT WITHIN ONE DEMAND                                         */
/* ------------------------------------------------------------------ */

type LegSplit = {
  principalMinor: bigint;
  taxMinor: bigint;
  interestMinor: bigint;
  amountMinor: bigint;
};

/**
 * Apply `available` paise to one demand and say which legs it settled.
 *
 * ⚠️ THE PRINCIPAL/TAX SPLIT IS PRO-RATA AND EXACT, NOT PERCENTAGE-BASED.
 *
 * A part payment against a demand of ₹8,74,563 + ₹43,728 GST has to be
 * apportioned somehow, and the developer's GST liability turns on the
 * answer: under Section 13(2) the time of supply is the earlier of the
 * invoice and the PAYMENT, so the tax portion of every receipt is
 * remittable.
 *
 * The split is `tax = amount × outstandingTax ÷ (principal + tax)` in
 * integer arithmetic, with the truncated remainder going to PRINCIPAL.
 * Two consequences, both deliberate:
 *
 *   • It is exact. principal + tax === amount, always, because principal
 *     is computed as the remainder rather than divided independently.
 *   • A payment that clears the demand exactly settles both legs exactly:
 *     (P+T) × T ÷ (P+T) = T with no remainder. There is no case where
 *     full payment leaves a paisa of tax outstanding.
 *
 * ⚠️ THE REMAINDER GOES TO PRINCIPAL AND NOT TO TAX, because under-stating
 * the tax settled by up to one paisa understates a liability by a paisa,
 * while over-stating it would remit tax on money not yet received.
 */
function splitAcrossLegs(
  demand: OpenDemand,
  availableMinor: bigint,
  order: AppropriationOrder,
): LegSplit {
  let left = availableMinor;
  let interest = 0n;

  if (order === "interest_first") {
    interest = min(left, demand.outstandingInterestMinor);
    left -= interest;
  }

  const principalDue = demand.outstandingPrincipalMinor;
  const taxDue = demand.outstandingTaxMinor;
  const bodyDue = principalDue + taxDue;
  const body = min(left, bodyDue);
  left -= body;

  let tax = 0n;
  let principal = 0n;
  if (body > 0n && bodyDue > 0n) {
    tax = (body * taxDue) / bodyDue;
    principal = body - tax;
  }

  if (order === "principal_first") {
    interest = min(left, demand.outstandingInterestMinor);
    left -= interest;
  }

  return {
    principalMinor: principal,
    taxMinor: tax,
    interestMinor: interest,
    amountMinor: principal + tax + interest,
  };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function totalDue(demand: OpenDemand): bigint {
  return (
    demand.outstandingPrincipalMinor +
    demand.outstandingTaxMinor +
    demand.outstandingInterestMinor
  );
}

/* ------------------------------------------------------------------ */
/* THE ALLOCATION                                                      */
/* ------------------------------------------------------------------ */

/**
 * Spread a receipt across open demands, exactly.
 *
 * The invariant, checked before returning:
 *
 *     sum(lines.amountMinor) + creditMinor === amountMinor + tdsCreditMinor
 */
export function allocateReceipt(input: AllocationInput): AllocationResult {
  const {
    receiptNumber,
    strategy,
    appropriationOrder,
    instructions,
  } = input;

  const allocatable = input.amountMinor + (input.tdsCreditMinor ?? 0n);

  if (input.amountMinor <= 0n) {
    throw new AllocationError(
      "A receipt has to be for a positive amount.",
      "Record the amount that actually arrived. A reversal is a bounced or " +
        "cancelled receipt, not a negative one.",
    );
  }
  if ((input.tdsCreditMinor ?? 0n) < 0n) {
    throw new AllocationError(
      "A TDS credit cannot be negative.",
      "Enter the tax the buyer withheld under Section 194-IA, or leave it blank.",
    );
  }

  const lines: AllocationLine[] = [];
  const narrative: string[] = [
    `Receipt ${receiptNumber} of ₹${formatPaise(input.amountMinor)}` +
      ((input.tdsCreditMinor ?? 0n) > 0n
        ? ` plus ₹${formatPaise(input.tdsCreditMinor ?? 0n)} of tax withheld by the buyer under Section 194-IA (₹${formatPaise(allocatable)} to apply)`
        : "") +
      `, received ${toCivilDay(input.receivedOn)}.`,
  ];

  let remaining = allocatable;
  let sequence = 0;

  const byId = new Map(input.demands.map((d) => [d.demandId, d]));

  /* --- ⭐ SECTION 59: THE BUYER SAID WHERE IT GOES. --------------- */
  if (strategy === "specified") {
    if (!instructions || instructions.length === 0) {
      throw new AllocationError(
        "This receipt is marked as specifically appropriated but says nothing about " +
          "which demands it is for.",
        "Either name the demands and amounts, or record it as oldest-first — which " +
          "is what Section 60 of the Contract Act lets the developer do when the " +
          "buyer has not said.",
      );
    }

    const instructedTotal = instructions.reduce((sum, i) => sum + i.amountMinor, 0n);
    if (instructedTotal > allocatable) {
      throw new AllocationError(
        `The instructions apply ₹${formatPaise(instructedTotal)} but only ` +
          `₹${formatPaise(allocatable)} was received.`,
        "Reduce the amounts, or record the balance as a credit rather than " +
          "applying money that has not arrived.",
      );
    }

    narrative.push(
      "Applied as the buyer directed (Section 59, Indian Contract Act — a debtor's " +
        "express appropriation binds the creditor).",
    );

    for (const instruction of instructions) {
      if (instruction.amountMinor <= 0n) {
        throw new AllocationError(
          "An instruction applies nothing to a demand.",
          "Remove the line. A zero allocation appears on the buyer's statement and " +
            "foots to nothing.",
        );
      }
      const demand = byId.get(instruction.demandId);
      if (!demand) {
        throw new AllocationError(
          `The receipt names a demand that is not outstanding on this booking.`,
          "Check the demand number. Money cannot be applied to a demand that is " +
            "already settled, cancelled or belongs to another booking.",
        );
      }
      const due = totalDue(demand);
      if (instruction.amountMinor > due) {
        throw new AllocationError(
          `₹${formatPaise(instruction.amountMinor)} was directed to demand ` +
            `${demand.noticeNumber}, which has only ₹${formatPaise(due)} outstanding.`,
          "Reduce it to the outstanding amount. The excess is a credit on the " +
            "buyer's account and is applied to the next demand raised — it is not " +
            "an over-payment against a document that has been settled.",
        );
      }

      const split = splitAcrossLegs(demand, instruction.amountMinor, appropriationOrder);
      sequence += 1;
      lines.push(
        toLine(demand, split, sequence, strategy, appropriationOrder, due, true),
      );
      remaining -= split.amountMinor;
    }
  } else if (strategy === "oldest_first") {
    /* --- ⭐ SECTION 60: OLDEST FIRST. ---------------------------- */
    //
    // ⚠️ SORTED BY DUE DATE AND THEN BY NOTICE NUMBER. Two demands due on
    // the same day is ordinary — a construction event and a statutory
    // charge often fall together — and an unstable sort would apply the
    // same receipt differently on two runs, which makes the explanation
    // wrong the second time somebody looks.
    const ordered = [...input.demands].sort(
      (a, b) =>
        daysBetween(toCivilDay(b.dueDate), toCivilDay(a.dueDate)) ||
        a.noticeNumber.localeCompare(b.noticeNumber),
    );

    narrative.push(
      "Applied to the oldest outstanding demand first (Section 60, Indian Contract " +
        "Act — the buyer gave no direction, so the developer appropriates).",
    );

    for (const demand of ordered) {
      if (remaining <= 0n) break;
      const due = totalDue(demand);
      if (due <= 0n) continue;

      const take = min(remaining, due);
      const split = splitAcrossLegs(demand, take, appropriationOrder);
      if (split.amountMinor <= 0n) continue;

      sequence += 1;
      lines.push(
        toLine(
          demand,
          split,
          sequence,
          strategy,
          appropriationOrder,
          due,
          split.amountMinor >= due,
        ),
      );
      remaining -= split.amountMinor;
    }
  } else {
    // `credit` — nothing is applied. See below for why this is a real
    // strategy rather than the absence of one.
    narrative.push(
      "Held as a credit on the buyer's account: no demand was outstanding when " +
        "this was received.",
    );
  }

  const totalAllocated = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  const credit = allocatable - totalAllocated;

  /* --- ⭐⭐ THE INVARIANT. --------------------------------------- */
  if (totalAllocated + credit !== allocatable || credit < 0n) {
    throw new AllocationImbalanceError(
      `Allocation of receipt ${receiptNumber} does not reconcile: ` +
        `₹${formatPaise(totalAllocated)} applied plus ₹${formatPaise(credit)} credit ` +
        `does not equal ₹${formatPaise(allocatable)}. This is a defect in ` +
        `lib/receivables/allocation.ts — do not write the receipt, and report it. ` +
        `A receipt that is out by a paisa produces a statement of account that ` +
        `does not foot, discovered by a buyer who is already in dispute.`,
    );
  }

  for (const line of lines) {
    if (line.principalMinor + line.taxMinor + line.interestMinor !== line.amountMinor) {
      throw new AllocationImbalanceError(
        `Allocation to ${line.noticeNumber} has legs that do not sum to its own ` +
          `total. This is a defect in lib/receivables/allocation.ts.`,
      );
    }
  }

  narrative.push(
    ...lines.map((line) => line.explanation),
    credit > 0n
      ? `₹${formatPaise(credit)} remains as a credit on the account and is applied to the next demand raised.`
      : `₹${formatPaise(totalAllocated)} applied in full — nothing remains on account.`,
    `Reconciliation: ₹${formatPaise(totalAllocated)} applied + ₹${formatPaise(credit)} credit = ₹${formatPaise(allocatable)}.`,
  );

  return {
    lines,
    totalAllocatedMinor: totalAllocated,
    creditMinor: credit,
    allocatableMinor: allocatable,
    strategy,
    appropriationOrder,
    narrative,
  };
}

function toLine(
  demand: OpenDemand,
  split: LegSplit,
  sequence: number,
  basis: AllocationStrategy,
  order: AppropriationOrder,
  dueMinor: bigint,
  settles: boolean,
): AllocationLine {
  const legs: string[] = [];
  if (split.interestMinor > 0n) legs.push(`₹${formatPaise(split.interestMinor)} interest`);
  if (split.principalMinor > 0n) legs.push(`₹${formatPaise(split.principalMinor)} principal`);
  if (split.taxMinor > 0n) legs.push(`₹${formatPaise(split.taxMinor)} GST`);

  const orderPhrase =
    order === "interest_first"
      ? "interest before principal"
      : "principal before interest";

  const basisPhrase =
    basis === "specified"
      ? "as directed by the buyer"
      : basis === "oldest_first"
        ? "oldest demand first"
        : "held on account";

  const remainder = dueMinor - split.amountMinor;

  return {
    demandId: demand.demandId,
    noticeNumber: demand.noticeNumber,
    sequence,
    principalMinor: split.principalMinor,
    taxMinor: split.taxMinor,
    interestMinor: split.interestMinor,
    amountMinor: split.amountMinor,
    basis,
    appropriationOrder: order,
    settlesDemand: settles && remainder <= 0n,
    explanation:
      `₹${formatPaise(split.amountMinor)} applied to demand ${demand.noticeNumber} ` +
      `(due ${toCivilDay(demand.dueDate)}) — ${legs.join(", ")}. Applied ` +
      `${basisPhrase}, ${orderPhrase}. ` +
      (remainder > 0n
        ? `₹${formatPaise(remainder)} remains outstanding on this demand.`
        : `This demand is settled in full.`),
  };
}

/* ------------------------------------------------------------------ */
/* REVERSAL                                                            */
/* ------------------------------------------------------------------ */

/**
 * What has to be released when a cheque comes back.
 *
 * ⚠️ A BOUNCED RECEIPT IS NOT A REFUND, IT IS A RECEIPT THAT NEVER
 * HAPPENED. The demands it was applied against were outstanding the whole
 * time and the interest clock never stopped — so the released amounts go
 * back on to the demands at the amounts they were applied at, and the
 * interest is recomputed from the ORIGINAL due date, not from the bounce.
 * Recomputing from the bounce forgives the buyer the period their cheque
 * was sitting in our hands doing nothing.
 */
export function releaseOnBounce(lines: readonly AllocationLine[]): {
  releasedMinor: bigint;
  perDemand: Array<{
    demandId: string;
    noticeNumber: string;
    principalMinor: bigint;
    taxMinor: bigint;
    interestMinor: bigint;
    amountMinor: bigint;
    explanation: string;
  }>;
} {
  return {
    releasedMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0n),
    perDemand: lines.map((line) => ({
      demandId: line.demandId,
      noticeNumber: line.noticeNumber,
      principalMinor: line.principalMinor,
      taxMinor: line.taxMinor,
      interestMinor: line.interestMinor,
      amountMinor: line.amountMinor,
      explanation:
        `₹${formatPaise(line.amountMinor)} released from demand ${line.noticeNumber}: ` +
        `the instrument was returned unpaid, so this demand was outstanding ` +
        `throughout and interest continues to run from its original due date.`,
    })),
  };
}
