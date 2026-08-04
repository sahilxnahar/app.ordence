/**
 * Ordence — ⭐⭐ Running Account Bills
 * Version: v0.43.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE DEFINING PROPERTY
 * ══════════════════════════════════════════════════════════════════════
 * A running account bill is CUMULATIVE-TO-DATE, and what is paid is the
 * DIFFERENCE from the previous bill.
 *
 *     Value of work done to date          ₹62,00,000
 *     Less: certified on previous bills   ₹45,00,000
 *     Now due on this bill                ₹17,00,000
 *
 * ⚠️ GETTING THIS WRONG EITHER DOUBLE-PAYS A CONTRACTOR OR UNDERPAYS
 * THEM, AND NEITHER ERRORS.
 *
 *   • Treat the cumulative figure as periodic → pay ₹62,00,000 for
 *     ₹17,00,000 of work. On a large contract that is a cheque that
 *     cannot be recovered, because the contractor has already paid their
 *     subcontractors out of it.
 *
 *   • Treat a periodic figure as cumulative → the contractor is short by
 *     the entire history, stops work, and the project loses three months
 *     while it is argued about.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE FOUR INVARIANTS THIS MODULE ENFORCES
 * ══════════════════════════════════════════════════════════════════════
 * 1. THE ARITHMETIC FOOTS, EXACTLY.
 *      this = cumulative − previous, on every line and on the header, in
 *      integers, with no rounding anywhere in the subtraction.
 *
 * 2. ⭐ VALUE IS TAKEN FROM THE CUMULATIVE QUANTITY, THEN REDUCED.
 *      `amountFor(cumulativeQty, rate) − previousAmount`, never
 *      `amountFor(thisQty, rate)`. Rounding the increment on every bill
 *      drifts by up to a paisa per line per bill; on 2,000 lines over 25
 *      bills that is ₹500 of difference between the final bill and the
 *      contract account, and it is unexplainable because each individual
 *      bill is correct.
 *
 * 3. ⭐⭐ CUMULATIVE QUANTITY IS MONOTONIC ABOVE WHAT IS CERTIFIED.
 *      A decrease below a certified quantity needs an approved variation
 *      and a reason. Silently, it means money already paid is now
 *      unaccounted for.
 *
 * 4. ⭐ THE PREVIOUS FIGURE IS THE PREDECESSOR'S CUMULATIVE FIGURE.
 *      Not "roughly". `assertContinuity` refuses a bill whose stated
 *      previous does not equal the last bill's cumulative, because that
 *      gap is exactly the amount that gets paid twice or never.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ON THE FINAL BILL
 * ══════════════════════════════════════════════════════════════════════
 * The final bill closes the contract: it forces every advance to full
 * recovery, releases the first retention tranche per the contract, and
 * after it no further RA bill may be raised. The second retention tranche
 * is NOT released here — it is released when the defect liability period
 * expires, months or years later, through `lib/construction/retention.ts`,
 * by a named person, once.
 */

import { amountFor, applyBps, sumMinor } from "./quantities";
import { checkAgainstBoq } from "./boq";
import {
  buildWaterfall,
  computeAdvanceRecovery,
  computeRetention,
  type AdvanceInput,
  type AdvanceRecovery,
  type DeductionLine,
  type OtherDeductionInput,
  type StatutoryInput,
} from "./deductions";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export class RaBillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaBillError";
  }
}

export type ContractTerms = {
  /** Revised contract sum — original plus approved variations. */
  revisedSumMinor: bigint;
  retentionRateBps: number;
  retentionCapMinor: bigint | null;
  gstRateBps: number;
  /** ⚠️ Decides CGST+SGST versus IGST. A fact about the place of supply. */
  isInterState: boolean;
  gstTdsApplicable: boolean;
  gstTdsRateBps: number;
};

/** What the previous bill left behind, per BOQ item. */
export type PreviousLinePosition = {
  quantityScaled: bigint;
  amountMinor: bigint;
};

export type PreviousBillPosition = {
  billId: string | null;
  sequence: number;
  cumulativeGrossMinor: bigint;
  cumulativeDeductionsMinor: bigint;
  retentionCumulativeMinor: bigint;
  /** Keyed by BOQ item id. Absent means the item was not on any prior bill. */
  byItem: ReadonlyMap<string, PreviousLinePosition>;
};

/** The empty position, for bill 1. */
export const FIRST_BILL_POSITION: PreviousBillPosition = {
  billId: null,
  sequence: 0,
  cumulativeGrossMinor: 0n,
  cumulativeDeductionsMinor: 0n,
  retentionCumulativeMinor: 0n,
  byItem: new Map(),
};

export type RaBillLineInput = {
  boqItemId: string;
  itemCode: string;
  sequence: number;
  uom: string;
  /** ⚠️ The EFFECTIVE rate — BOQ rate, or the rate an approved variation set. */
  rateMinor: bigint;
  /** BOQ quantity plus approved variations. The ceiling. */
  authorisedQuantityScaled: bigint;
  /** ⭐ Work done TO DATE, from the measurement book. */
  cumulativeQuantityScaled: bigint;
  /**
   * The highest quantity any CERTIFIED bill has carried for this item.
   * ⚠️ Not the previous bill's — a bill that was raised and rejected
   * never certified anything, and using it would block a legitimate
   * correction.
   */
  certifiedQuantityScaled: bigint;
  /** Required when the cumulative quantity falls below `certified`. */
  variationId?: string | null;
  decreaseReason?: string | null;
};

export type RaBillLine = RaBillLineInput & {
  previousQuantityScaled: bigint;
  thisQuantityScaled: bigint;
  cumulativeAmountMinor: bigint;
  previousAmountMinor: bigint;
  thisAmountMinor: bigint;
};

export type RaBillComputation = {
  sequence: number;
  isFinal: boolean;
  lines: RaBillLine[];

  cumulativeGrossMinor: bigint;
  previousGrossMinor: bigint;
  thisGrossMinor: bigint;

  gstRateBps: number;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  taxMinor: bigint;

  deductions: DeductionLine[];
  cumulativeDeductionsMinor: bigint;
  previousDeductionsMinor: bigint;
  thisDeductionsMinor: bigint;

  retentionThisMinor: bigint;
  retentionCumulativeMinor: bigint;
  retentionRateBps: number;

  tds194cMinor: bigint;
  tds194cRateBps: number;
  gstTdsMinor: bigint;

  advances: AdvanceRecovery[];

  netPayableMinor: bigint;
  /** Sentences a person should read before certifying. Never fatal. */
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* ⭐ CONTINUITY                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE STATED PREVIOUS FIGURE MUST BE THE PREDECESSOR'S CUMULATIVE
 * FIGURE.
 *
 * ⚠️ THE GAP IS EXACTLY WHAT GETS PAID TWICE OR NEVER. If bill 4 says
 * "less previously paid ₹45,00,000" and bill 3's cumulative was
 * ₹46,20,000, then ₹1,20,000 is paid a second time — and every subsequent
 * bill inherits the error, because bill 5 subtracts bill 4's cumulative,
 * which was right. One bill is wrong; the money is gone; nothing on any
 * document shows it.
 *
 * The usual cause is not fraud. It is a bill raised, revised after
 * certification, and the next one prepared from a printout.
 */
export function assertContinuity(args: {
  sequence: number;
  previous: PreviousBillPosition;
  statedPreviousGrossMinor: bigint;
}): void {
  if (args.sequence < 1) {
    throw new RaBillError(
      `Bill sequence ${args.sequence} is not valid. Running account bills are ` +
        `numbered from 1, and the sequence is the only thing that decides which ` +
        `bill is "previous".`,
    );
  }

  if (args.sequence === 1) {
    if (args.statedPreviousGrossMinor !== 0n || args.previous.billId !== null) {
      throw new RaBillError(
        `This is the first bill on the contract but it states ` +
          `${args.statedPreviousGrossMinor} paise already certified. ⚠️ REFUSED: ` +
          `bill 1 nets off a history that does not exist, so the contractor is ` +
          `short by that amount from the very first payment.`,
      );
    }
    return;
  }

  if (args.previous.sequence !== args.sequence - 1) {
    throw new RaBillError(
      `Bill ${args.sequence} is being raised against bill ${args.previous.sequence}. ` +
        `⚠️ REFUSED: a running account has no gaps. The bill in between either ` +
        `exists — in which case this one nets off the wrong baseline and the ` +
        `difference is paid twice — or it does not, in which case the sequence ` +
        `numbering is wrong and every later bill inherits it.`,
    );
  }

  if (args.statedPreviousGrossMinor !== args.previous.cumulativeGrossMinor) {
    const gap = args.statedPreviousGrossMinor - args.previous.cumulativeGrossMinor;
    throw new RaBillError(
      `This bill states ${args.statedPreviousGrossMinor} paise certified on ` +
        `previous bills; bill ${args.previous.sequence} certified ` +
        `${args.previous.cumulativeGrossMinor}. ⚠️ REFUSED: the difference of ` +
        `${gap} paise is exactly the amount that gets ` +
        `${gap > 0n ? "never paid at all" : "paid a SECOND time"}. Every ` +
        `subsequent bill would inherit it silently, because bill ` +
        `${args.sequence + 1} subtracts THIS bill's cumulative figure — which is ` +
        `right. One bill is wrong, the money is gone, and no document shows it.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE COMPUTATION                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ BUILD A RUNNING ACCOUNT BILL.
 *
 * Everything about the shape of this function follows from the header
 * comment. Read that first; the code is deliberately unsurprising once
 * the invariants are clear.
 */
export function computeRaBill(args: {
  sequence: number;
  isFinal: boolean;
  contract: ContractTerms;
  previous: PreviousBillPosition;
  lines: readonly RaBillLineInput[];
  advances?: readonly AdvanceInput[];
  otherDeductions?: readonly OtherDeductionInput[];
  statutory: StatutoryInput;
}): RaBillComputation {
  const warnings: string[] = [];

  /* --- ⭐ THE LINES ------------------------------------------------ */

  const lines: RaBillLine[] = args.lines.map((input) => {
    // ⭐ 1. THE CONTRACT CEILING.
    const ceiling = checkAgainstBoq({
      itemCode: input.itemCode,
      uom: input.uom,
      authorisedQuantityScaled: input.authorisedQuantityScaled,
      proposedCumulativeScaled: input.cumulativeQuantityScaled,
    });
    if (!ceiling.ok) throw new RaBillError(ceiling.reason);

    // ⭐⭐ 2. MONOTONICITY ABOVE WHAT IS CERTIFIED.
    if (input.cumulativeQuantityScaled < input.certifiedQuantityScaled) {
      const explained =
        Boolean(input.variationId) && Boolean(input.decreaseReason?.trim());
      if (!explained) {
        throw new RaBillError(
          `Item ${input.itemCode}: this bill shows ` +
            `${input.cumulativeQuantityScaled} micro-units of work to date, below ` +
            `the ${input.certifiedQuantityScaled} already CERTIFIED on an earlier ` +
            `bill and paid for. ⚠️ REFUSED WITHOUT AN APPROVED VARIATION AND A ` +
            `REASON. A silent decrease means money already paid is now ` +
            `unaccounted for — and it does not error, because this bill's own ` +
            `arithmetic stays consistent while producing a negative "now due" ` +
            `that somebody nets off against the next one. A re-measurement that ` +
            `finds an earlier measurement wrong is legitimate and common; doing ` +
            `it without saying so is what this refuses.`,
        );
      }
      warnings.push(
        `Item ${input.itemCode}: the quantity to date has been REDUCED below what ` +
          `was previously certified, under variation ${input.variationId}. ` +
          `⚠️ Money already paid against the difference is being recovered on ` +
          `this bill — check that the contractor has been told.`,
      );
    }

    if (input.cumulativeQuantityScaled < 0n) {
      throw new RaBillError(
        `Item ${input.itemCode} has a negative cumulative quantity. Work done to ` +
          `date cannot be less than nothing.`,
      );
    }
    if (input.rateMinor < 0n) {
      throw new RaBillError(
        `Item ${input.itemCode} carries a negative rate. A credit belongs in a ` +
          `variation, where somebody approves it.`,
      );
    }

    const prior = args.previous.byItem.get(input.boqItemId);
    const previousQuantityScaled = prior?.quantityScaled ?? 0n;
    const previousAmountMinor = prior?.amountMinor ?? 0n;

    // ⭐ 3. VALUE FROM THE CUMULATIVE QUANTITY, THEN REDUCE. See the header.
    const cumulativeAmountMinor = amountFor(input.cumulativeQuantityScaled, input.rateMinor);

    return {
      ...input,
      previousQuantityScaled,
      thisQuantityScaled: input.cumulativeQuantityScaled - previousQuantityScaled,
      cumulativeAmountMinor,
      previousAmountMinor,
      thisAmountMinor: cumulativeAmountMinor - previousAmountMinor,
    };
  });

  /* --- ⭐ THE HEADER ----------------------------------------------- */

  const cumulativeGrossMinor = sumMinor(lines.map((line) => line.cumulativeAmountMinor));
  const previousGrossMinor = args.previous.cumulativeGrossMinor;

  assertContinuity({
    sequence: args.sequence,
    previous: args.previous,
    statedPreviousGrossMinor: previousGrossMinor,
  });

  // ⚠️ THE LINES' PREVIOUS FIGURES MUST FOOT TO THE HEADER'S. If they do
  // not, an item was on the last bill and is missing from this one — and
  // its value would be paid a second time on the next bill that includes
  // it, because this bill's cumulative total silently dropped.
  const linePreviousTotal = sumMinor(lines.map((line) => line.previousAmountMinor));
  if (linePreviousTotal !== previousGrossMinor) {
    const missing = previousGrossMinor - linePreviousTotal;
    throw new RaBillError(
      `The lines on this bill account for ${linePreviousTotal} paise certified ` +
        `previously, but bill ${args.previous.sequence} certified ` +
        `${previousGrossMinor}. ⚠️ REFUSED: ${missing} paise belongs to an item ` +
        `that was billed before and is absent from this bill. Its cumulative ` +
        `value has silently dropped out of the running total, so it will be ` +
        `certified — and paid — a second time on whichever later bill includes ` +
        `it again. Every item ever measured stays on every subsequent bill, even ` +
        `at an unchanged quantity; that is what makes the account "running".`,
    );
  }

  const thisGrossMinor = cumulativeGrossMinor - previousGrossMinor;

  if (thisGrossMinor < 0n) {
    warnings.push(
      `⚠️ THIS BILL IS NEGATIVE: the value of work to date has fallen by ` +
        `${-thisGrossMinor} paise since the last bill. That is a RECOVERY from ` +
        `the contractor, not a payment, and it needs to be agreed with them ` +
        `before it is certified rather than discovered by them afterwards.`,
    );
  }

  /* --- ⭐ TAX. On the value of work this bill, not on the cumulative. */

  const taxMinor = applyBps(thisGrossMinor, args.contract.gstRateBps);
  let cgstMinor = 0n;
  let sgstMinor = 0n;
  let igstMinor = 0n;

  if (args.contract.isInterState) {
    igstMinor = taxMinor;
  } else {
    // ⚠️ HALF EACH, WITH THE ODD PAISA TO CGST. Splitting by applying half
    // the rate twice loses a paisa on odd amounts and the invoice stops
    // footing — which an officer checks first.
    cgstMinor = (taxMinor + 1n) / 2n;
    sgstMinor = taxMinor - cgstMinor;
  }

  /* --- ⭐ DEDUCTIONS ----------------------------------------------- */

  const retention = computeRetention({
    cumulativeGrossMinor,
    previouslyHeldMinor: args.previous.retentionCumulativeMinor,
    rateBps: args.contract.retentionRateBps,
    capMinor: args.contract.retentionCapMinor,
  });

  const advances = (args.advances ?? []).map((advance) =>
    computeAdvanceRecovery({
      advance,
      cumulativeGrossMinor,
      contractSumMinor: args.contract.revisedSumMinor,
      isFinalBill: args.isFinal,
    }),
  );

  const waterfall = buildWaterfall({
    thisGrossMinor,
    retention,
    advances,
    others: args.otherDeductions ?? [],
    statutory: args.statutory,
  });

  const netPayableMinor = thisGrossMinor + taxMinor - waterfall.thisTotalMinor;

  if (netPayableMinor < 0n) {
    warnings.push(
      `⚠️ NET PAYABLE IS NEGATIVE (${netPayableMinor} paise). The deductions on ` +
        `this bill exceed the work certified on it. That is lawful — liquidated ` +
        `damages and advance recovery can do it — but it means the contractor is ` +
        `being asked for money rather than paid, and nobody should discover that ` +
        `from a bank statement.`,
    );
  }

  if (
    args.contract.revisedSumMinor > 0n &&
    cumulativeGrossMinor > args.contract.revisedSumMinor
  ) {
    warnings.push(
      `⚠️ WORK CERTIFIED TO DATE (${cumulativeGrossMinor} paise) EXCEEDS THE ` +
        `REVISED CONTRACT SUM (${args.contract.revisedSumMinor}). Every quantity ` +
        `is individually within its BOQ ceiling, so nothing has been refused — ` +
        `but the contract as a whole is over-run, and that is a decision somebody ` +
        `should take knowingly rather than find in the final account.`,
    );
  }

  if (args.isFinal) {
    const unrecovered = advances.filter((advance) => advance.outstandingMinor > 0n);
    if (unrecovered.length > 0) {
      throw new RaBillError(
        `The final bill leaves ${unrecovered.length} advance(s) outstanding. ` +
          `⚠️ REFUSED: an advance still unrecovered when a contract closes is an ` +
          `unsecured loan to a contractor who is leaving site, and the bank ` +
          `guarantee behind it is usually the thing that has already expired.`,
      );
    }
  }

  return {
    sequence: args.sequence,
    isFinal: args.isFinal,
    lines,
    cumulativeGrossMinor,
    previousGrossMinor,
    thisGrossMinor,
    gstRateBps: args.contract.gstRateBps,
    cgstMinor,
    sgstMinor,
    igstMinor,
    taxMinor,
    deductions: waterfall.lines,
    cumulativeDeductionsMinor: waterfall.cumulativeTotalMinor,
    previousDeductionsMinor: waterfall.previousTotalMinor,
    thisDeductionsMinor: waterfall.thisTotalMinor,
    retentionThisMinor: retention.thisMinor,
    retentionCumulativeMinor: retention.cumulativeMinor,
    retentionRateBps: args.contract.retentionRateBps,
    tds194cMinor: args.statutory.tds194cMinor,
    tds194cRateBps: args.statutory.tds194cRateBps,
    gstTdsMinor: sumMinor(
      waterfall.lines.filter((line) => line.kind === "gst_tds").map((line) => line.thisMinor),
    ),
    advances,
    netPayableMinor,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ CARRYING FORWARD                                                 */
/* ------------------------------------------------------------------ */

/**
 * The position this bill leaves for the next one.
 *
 * ⚠️ IT IS DERIVED FROM THE BILL, NOT RE-READ FROM MEASUREMENTS. The next
 * bill nets off what was CERTIFIED, and what was certified is what this
 * bill says — measurements taken after it was certified belong to the
 * next bill, which is the whole point of the cut-off.
 */
export function positionAfter(
  bill: RaBillComputation,
  billId: string,
): PreviousBillPosition {
  const byItem = new Map<string, PreviousLinePosition>();
  for (const line of bill.lines) {
    byItem.set(line.boqItemId, {
      quantityScaled: line.cumulativeQuantityScaled,
      amountMinor: line.cumulativeAmountMinor,
    });
  }

  return {
    billId,
    sequence: bill.sequence,
    cumulativeGrossMinor: bill.cumulativeGrossMinor,
    cumulativeDeductionsMinor: bill.cumulativeDeductionsMinor,
    retentionCumulativeMinor: bill.retentionCumulativeMinor,
    byItem,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE RECONCILIATION                                             */
/* ------------------------------------------------------------------ */

export type RunningAccountAudit = {
  ok: boolean;
  billCount: number;
  /** Σ of every bill's "now due" gross. */
  sumOfThisGrossMinor: bigint;
  /** The last bill's cumulative gross. */
  finalCumulativeGrossMinor: bigint;
  differenceMinor: bigint;
  problems: string[];
};

/**
 * ⭐⭐ THE ONE CHECK THAT PROVES A RUNNING ACCOUNT IS A RUNNING ACCOUNT.
 *
 *     Σ (value paid on each bill) = value of work done to date
 *
 * Any error of the class this phase exists to prevent breaks it:
 * a double-paid increment makes the sum exceed the cumulative; a missing
 * item makes it fall short; a broken continuity makes it differ by
 * exactly the gap.
 *
 * ⚠️ IT IS AN EQUALITY, NOT A TOLERANCE. Everything is integer paise, so
 * "within a rupee" would only ever hide a defect.
 */
export function auditRunningAccount(
  bills: readonly Pick<
    RaBillComputation,
    "sequence" | "cumulativeGrossMinor" | "previousGrossMinor" | "thisGrossMinor"
  >[],
): RunningAccountAudit {
  const problems: string[] = [];

  if (bills.length === 0) {
    return {
      ok: true,
      billCount: 0,
      sumOfThisGrossMinor: 0n,
      finalCumulativeGrossMinor: 0n,
      differenceMinor: 0n,
      problems,
    };
  }

  const ordered = [...bills].sort((a, b) => a.sequence - b.sequence);

  ordered.forEach((bill, index) => {
    if (bill.sequence !== index + 1) {
      problems.push(
        `Bill at position ${index + 1} carries sequence ${bill.sequence}. A running ` +
          `account is numbered without gaps; a gap means a bill is missing from ` +
          `this reconciliation and its value is unaccounted for.`,
      );
    }

    if (bill.thisGrossMinor !== bill.cumulativeGrossMinor - bill.previousGrossMinor) {
      problems.push(
        `Bill ${bill.sequence}: "now due" of ${bill.thisGrossMinor} is not ` +
          `${bill.cumulativeGrossMinor} − ${bill.previousGrossMinor}. ⚠️ The face of ` +
          `the bill does not agree with its own subtraction.`,
      );
    }

    const expectedPrevious =
      index === 0 ? 0n : (ordered[index - 1]?.cumulativeGrossMinor ?? 0n);
    if (bill.previousGrossMinor !== expectedPrevious) {
      problems.push(
        `Bill ${bill.sequence} nets off ${bill.previousGrossMinor} but bill ` +
          `${bill.sequence - 1} certified ${expectedPrevious}. ⚠️ The difference of ` +
          `${bill.previousGrossMinor - expectedPrevious} paise is paid twice or ` +
          `never paid at all.`,
      );
    }
  });

  const sumOfThisGrossMinor = sumMinor(ordered.map((bill) => bill.thisGrossMinor));
  const finalCumulativeGrossMinor =
    ordered[ordered.length - 1]?.cumulativeGrossMinor ?? 0n;
  const differenceMinor = sumOfThisGrossMinor - finalCumulativeGrossMinor;

  if (differenceMinor !== 0n) {
    problems.push(
      `The bills pay ${sumOfThisGrossMinor} paise in total and the last bill says ` +
        `${finalCumulativeGrossMinor} of work has been done — a difference of ` +
        `${differenceMinor}. ⚠️ In a running account these are the same number by ` +
        `construction. They differ only when an increment has been paid twice, ` +
        `an item has dropped out of the running total, or a bill nets off the ` +
        `wrong baseline.`,
    );
  }

  return {
    ok: problems.length === 0,
    billCount: ordered.length,
    sumOfThisGrossMinor,
    finalCumulativeGrossMinor,
    differenceMinor,
    problems,
  };
}
