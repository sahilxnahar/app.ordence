/**
 * Ordence — ⭐⭐ The Deduction Waterfall
 * Version: v0.43.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ EVERY DEDUCTION ON A RUNNING ACCOUNT BILL IS CUMULATIVE TOO
 * ══════════════════════════════════════════════════════════════════════
 * This is the part everybody gets wrong, and it is wrong in the same
 * direction as the bill itself.
 *
 *     Retention on bill 4 is
 *         5% of ₹62,00,000 to date          = ₹3,10,000
 *         less retention already held        = ₹2,25,000
 *         held on this bill                  = ₹  85,000
 *
 *     NOT 5% of this bill's ₹17,00,000.
 *
 * On a contract that never revises a quantity the two agree, which is
 * exactly why the mistake survives. The moment a cumulative quantity is
 * revised — a re-measurement, an omission — the incremental method holds
 * the wrong retention for the rest of the contract and never reconciles
 * at handover, when ₹2 crore is supposed to come back.
 *
 * ⚠️ THE STATUTORY DEDUCTIONS ARE THE EXCEPTION, AND THEY ARE PERIODIC.
 * TDS is deducted on the payment being made, deposited against a challan
 * by the 7th of the next month and reported on a quarterly return.
 * Restating a cumulative TDS figure on every bill would re-deduct tax
 * already deposited — so for those, previous = 0 and this = cumulative.
 * The shape of the row is identical; only the basis differs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ORDER IS NOT COSMETIC
 * ══════════════════════════════════════════════════════════════════════
 * Retention and recoveries come off the WORK VALUE. GST is added on the
 * work value. TDS under 194C is computed on the value EXCLUSIVE of GST
 * (CBDT Circular 23/2017), and GST TDS under Section 51 is 2% of the
 * taxable value — also exclusive of the tax. Getting the base wrong by
 * including GST over-deducts by 18% of the deduction, on every bill, and
 * it is the contractor who has to claim it back a year later.
 *
 * ⚠️ NOTHING HERE COMPUTES THE 194C RATE. That is `lib/tds/` — it depends
 * on the payee's constitution, PAN status, Section 206AA, 206AB and any
 * Section 197 certificate, none of which is a fact about this bill.
 */

import { applyBps, sumMinor } from "./quantities";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type DeductionKindLike =
  | "retention"
  | "security_deposit"
  | "mobilisation_advance_recovery"
  | "material_advance_recovery"
  | "plant_advance_recovery"
  | "liquidated_damages"
  | "penalty"
  | "material_issued"
  | "water_electricity"
  | "labour_cess"
  | "tds_194c"
  | "gst_tds"
  | "income_tax_other"
  | "other_recovery";

export type DeductionLine = {
  kind: DeductionKindLike;
  sequence: number;
  label: string;
  rateBps: number | null;
  cumulativeMinor: bigint;
  previousMinor: bigint;
  thisMinor: bigint;
  advanceId?: string | null;
  /** Why this line is what it is, in a sentence a contractor can read. */
  basis: string;
};

export class DeductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeductionError";
  }
}

/**
 * ⭐ THE ORDER THEY APPEAR ON THE BILL, and the order the waterfall runs.
 * Contractual recoveries first, then damages, then statutory — because
 * the statutory ones are computed on the work value and must not be
 * affected by what has been recovered from it.
 */
export const DEDUCTION_ORDER: readonly DeductionKindLike[] = [
  "retention",
  "security_deposit",
  "mobilisation_advance_recovery",
  "material_advance_recovery",
  "plant_advance_recovery",
  "material_issued",
  "water_electricity",
  "liquidated_damages",
  "penalty",
  "other_recovery",
  "labour_cess",
  "tds_194c",
  "gst_tds",
  "income_tax_other",
];

/* ------------------------------------------------------------------ */
/* ⭐ RETENTION                                                        */
/* ------------------------------------------------------------------ */

export type RetentionInput = {
  /** Value of work done to date. */
  cumulativeGrossMinor: bigint;
  /** Retention already held on earlier bills. */
  previouslyHeldMinor: bigint;
  rateBps: number;
  /** "5% of each bill up to 5% of the contract sum". NULL = uncapped. */
  capMinor: bigint | null;
};

export type RetentionComputation = {
  cumulativeMinor: bigint;
  previousMinor: bigint;
  thisMinor: bigint;
  cappedAt: bigint | null;
  basis: string;
};

/**
 * ⭐ RETENTION, ON THE CUMULATIVE BASIS, WITH THE CAP APPLIED.
 *
 * ⚠️ IT REFUSES TO GO BACKWARDS. If the cumulative work value falls — a
 * re-measurement, an omission — the arithmetic would produce a NEGATIVE
 * amount held this bill, which is a release of retention. Retention comes
 * back through the retention ledger, by a named person, at a named stage,
 * exactly once. Letting a bill release it silently is precisely how it
 * gets released twice: once by the bill nobody noticed, and once properly
 * two years later.
 */
export function computeRetention(input: RetentionInput): RetentionComputation {
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10_000) {
    throw new DeductionError(
      `Retention is ${input.rateBps} basis points. It is a percentage between 0 ` +
        `and 100 — 500 is 5%.`,
    );
  }

  const uncapped = applyBps(input.cumulativeGrossMinor, input.rateBps);
  const cumulative =
    input.capMinor !== null && uncapped > input.capMinor ? input.capMinor : uncapped;

  const thisMinor = cumulative - input.previouslyHeldMinor;

  if (thisMinor < 0n) {
    throw new DeductionError(
      `Retention to date works out at ${cumulative} paise and ${input.previouslyHeldMinor} ` +
        `has already been held, so this bill would RELEASE ${-thisMinor} paise. ` +
        `⚠️ REFUSED: retention comes back through the retention ledger — by a ` +
        `named person, at a named stage, exactly once. A bill that releases it as ` +
        `a side effect of a falling cumulative value is how it gets released ` +
        `TWICE: once here, invisibly, and once properly two years later when ` +
        `somebody works through the contract account at handover. Record the ` +
        `release explicitly, or correct the quantities that fell.`,
    );
  }

  const pct = (input.rateBps / 100).toFixed(2).replace(/\.00$/, "");
  const capNote =
    input.capMinor !== null && uncapped > input.capMinor
      ? ` (capped at the contractual maximum of ${input.capMinor} paise)`
      : "";

  return {
    cumulativeMinor: cumulative,
    previousMinor: input.previouslyHeldMinor,
    thisMinor,
    cappedAt: input.capMinor !== null && uncapped > input.capMinor ? input.capMinor : null,
    basis:
      `${pct}% of the value of work done to date${capNote}, less retention already ` +
      `held on previous bills.`,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ ADVANCE RECOVERY                                                 */
/* ------------------------------------------------------------------ */

export type AdvanceInput = {
  id: string;
  kind: "mobilisation" | "material" | "plant" | "secured_advance";
  reference: string;
  grantedMinor: bigint;
  /** Recovered on earlier bills. */
  recoveredMinor: bigint;
  /** Basis points of cumulative work value recovered per bill. */
  recoveryRateBps: number;
  /** Recovery does not start until work done reaches this share. */
  startsAtProgressBps: number;
  /** Recovery must be complete by this share of the contract. */
  completeByProgressBps: number;
};

export type AdvanceRecovery = {
  advanceId: string;
  kind: AdvanceInput["kind"];
  cumulativeMinor: bigint;
  previousMinor: bigint;
  thisMinor: bigint;
  outstandingMinor: bigint;
  basis: string;
};

const ADVANCE_DEDUCTION_KIND: Readonly<Record<AdvanceInput["kind"], DeductionKindLike>> =
  Object.freeze({
    mobilisation: "mobilisation_advance_recovery",
    material: "material_advance_recovery",
    plant: "plant_advance_recovery",
    secured_advance: "other_recovery",
  });

/**
 * ⭐ RECOVER AN ADVANCE, ON THE CUMULATIVE BASIS, AND NEVER MORE THAN WAS
 * LENT.
 *
 * ⚠️ THE CAP IS THE POINT. Over-recovering an advance takes money that
 * was never lent, and it is invisible: the bill's arithmetic is
 * internally consistent, the contractor's ledger and ours differ by the
 * excess, and it surfaces at the final account after three more bills
 * have been paid on the same wrong basis.
 *
 * ⚠️ AND RECOVERY IS FORCED TO COMPLETION at the contractual progress
 * point (and on the final bill). A mobilisation advance still outstanding
 * when the contract finishes is an unsecured loan to somebody who is
 * leaving site — which is what the bank guarantee was for, and the
 * guarantee is usually the thing that expired.
 */
export function computeAdvanceRecovery(args: {
  advance: AdvanceInput;
  cumulativeGrossMinor: bigint;
  /** Revised contract sum, for the progress test. */
  contractSumMinor: bigint;
  isFinalBill: boolean;
}): AdvanceRecovery {
  const { advance } = args;

  if (advance.grantedMinor <= 0n) {
    throw new DeductionError(
      `Advance ${advance.reference} was granted ${advance.grantedMinor} paise. An ` +
        `advance of nothing is a row that will nevertheless be recovered against.`,
    );
  }
  if (advance.recoveredMinor > advance.grantedMinor) {
    throw new DeductionError(
      `Advance ${advance.reference} shows ${advance.recoveredMinor} paise recovered ` +
        `against ${advance.grantedMinor} granted. ⚠️ Money has already been taken ` +
        `that was never lent, and every bill from here will compound it.`,
    );
  }

  const progressBps =
    args.contractSumMinor > 0n
      ? Number((args.cumulativeGrossMinor * 10_000n) / args.contractSumMinor)
      : 0;

  let cumulative: bigint;
  let basis: string;

  if (args.isFinalBill || progressBps >= advance.completeByProgressBps) {
    // ⭐ FORCED TO FULL. See the comment above.
    cumulative = advance.grantedMinor;
    basis = args.isFinalBill
      ? `Recovered in full on the final bill. ⚠️ An advance still outstanding when ` +
        `a contract closes is an unsecured loan to a contractor who is leaving site.`
      : `Recovered in full: work done has reached ${(progressBps / 100).toFixed(1)}% of ` +
        `the contract sum, and recovery was contracted to complete by ` +
        `${(advance.completeByProgressBps / 100).toFixed(1)}%.`;
  } else if (progressBps < advance.startsAtProgressBps) {
    cumulative = advance.recoveredMinor;
    basis =
      `No recovery this bill: work done is ${(progressBps / 100).toFixed(1)}% of the ` +
      `contract sum and recovery begins at ` +
      `${(advance.startsAtProgressBps / 100).toFixed(1)}%.`;
  } else {
    const proportional = applyBps(args.cumulativeGrossMinor, advance.recoveryRateBps);
    cumulative =
      proportional > advance.grantedMinor ? advance.grantedMinor : proportional;
    const capped = proportional > advance.grantedMinor;
    basis =
      `${(advance.recoveryRateBps / 100).toFixed(2).replace(/\.00$/, "")}% of the value ` +
      `of work done to date, less what has already been recovered` +
      (capped ? `, capped at the amount advanced` : "") +
      `.`;
  }

  // ⚠️ NEVER BACKWARDS. A recovery that reduces is the contractor being
  // re-advanced money, which is a decision, not a rounding.
  if (cumulative < advance.recoveredMinor) {
    cumulative = advance.recoveredMinor;
  }

  return {
    advanceId: advance.id,
    kind: advance.kind,
    cumulativeMinor: cumulative,
    previousMinor: advance.recoveredMinor,
    thisMinor: cumulative - advance.recoveredMinor,
    outstandingMinor: advance.grantedMinor - cumulative,
    basis,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE WATERFALL                                                  */
/* ------------------------------------------------------------------ */

export type StatutoryInput = {
  /**
   * ⭐ SUPPLIED BY `lib/tds/`, NOT COMPUTED HERE. See the file header.
   */
  tds194cMinor: bigint;
  tds194cRateBps: number;
  /** Section 51 CGST. Applies only where the contract is notified. */
  gstTdsApplicable: boolean;
  gstTdsRateBps: number;
};

export type OtherDeductionInput = {
  kind: DeductionKindLike;
  label: string;
  /** ⚠️ Cumulative to date, like everything else on the bill. */
  cumulativeMinor: bigint;
  previousMinor: bigint;
  rateBps?: number | null;
  basis: string;
};

export type WaterfallResult = {
  lines: DeductionLine[];
  /** Deducted on this bill. */
  thisTotalMinor: bigint;
  /** Deducted to date. */
  cumulativeTotalMinor: bigint;
  previousTotalMinor: bigint;
  /** Everything that is not TDS or GST TDS — the contractual side. */
  contractualThisMinor: bigint;
  statutoryThisMinor: bigint;
};

/**
 * ⭐⭐ ASSEMBLE EVERY DEDUCTION ON THE BILL, IN ORDER.
 *
 * ⚠️ THE STATUTORY BASE IS THE WORK VALUE EXCLUSIVE OF GST, and it is
 * `thisGrossMinor` — not the net after recoveries. Deducting TDS on the
 * net would under-deduct by 194C on the retention, which makes the
 * developer the assessee in default for the shortfall plus interest under
 * Section 201(1A), on every bill, for years.
 */
export function buildWaterfall(args: {
  thisGrossMinor: bigint;
  retention: RetentionComputation | null;
  advances: readonly AdvanceRecovery[];
  others: readonly OtherDeductionInput[];
  statutory: StatutoryInput;
}): WaterfallResult {
  const lines: DeductionLine[] = [];
  let sequence = 0;

  const push = (line: Omit<DeductionLine, "sequence">): void => {
    sequence += 1;
    lines.push({ ...line, sequence });
  };

  if (args.retention && args.retention.cumulativeMinor > 0n) {
    push({
      kind: "retention",
      label: "Retention / security deposit withheld",
      rateBps: null,
      cumulativeMinor: args.retention.cumulativeMinor,
      previousMinor: args.retention.previousMinor,
      thisMinor: args.retention.thisMinor,
      basis: args.retention.basis,
    });
  }

  for (const recovery of args.advances) {
    if (recovery.cumulativeMinor === 0n) continue;
    push({
      kind: ADVANCE_DEDUCTION_KIND[recovery.kind],
      label: `Recovery of ${recovery.kind.replace(/_/g, " ")} advance`,
      rateBps: null,
      cumulativeMinor: recovery.cumulativeMinor,
      previousMinor: recovery.previousMinor,
      thisMinor: recovery.thisMinor,
      advanceId: recovery.advanceId,
      basis: recovery.basis,
    });
  }

  for (const other of args.others) {
    if (other.cumulativeMinor < other.previousMinor) {
      throw new DeductionError(
        `"${other.label}" shows ${other.cumulativeMinor} paise deducted to date ` +
          `against ${other.previousMinor} already deducted. ⚠️ A cumulative ` +
          `deduction cannot go backwards — recovering less than has already been ` +
          `recovered is paying it back, and a bill is not the place that decision ` +
          `gets made silently.`,
      );
    }
    push({
      kind: other.kind,
      label: other.label,
      rateBps: other.rateBps ?? null,
      cumulativeMinor: other.cumulativeMinor,
      previousMinor: other.previousMinor,
      thisMinor: other.cumulativeMinor - other.previousMinor,
      basis: other.basis,
    });
  }

  /* --- ⭐ STATUTORY: PERIODIC, NOT CUMULATIVE ---------------------- */

  if (args.statutory.tds194cMinor > 0n) {
    push({
      kind: "tds_194c",
      label: "Income tax deducted at source — Section 194C",
      rateBps: args.statutory.tds194cRateBps,
      // ⚠️ previous = 0. TDS already deducted has been deposited against a
      // challan and reported; restating it cumulatively would deduct it twice.
      cumulativeMinor: args.statutory.tds194cMinor,
      previousMinor: 0n,
      thisMinor: args.statutory.tds194cMinor,
      basis:
        `Deducted at ${(args.statutory.tds194cRateBps / 100).toFixed(2).replace(/\.00$/, "")}% ` +
        `on the value of work billed, exclusive of GST (CBDT Circular 23/2017). ` +
        `The rate is resolved per payment from the payee's constitution and PAN ` +
        `status, not from this contract.`,
    });
  }

  if (args.statutory.gstTdsApplicable) {
    const gstTds = applyBps(args.thisGrossMinor, args.statutory.gstTdsRateBps);
    if (gstTds > 0n) {
      push({
        kind: "gst_tds",
        label: "GST TDS — Section 51, CGST Act",
        rateBps: args.statutory.gstTdsRateBps,
        cumulativeMinor: gstTds,
        previousMinor: 0n,
        thisMinor: gstTds,
        basis:
          `${(args.statutory.gstTdsRateBps / 100).toFixed(2).replace(/\.00$/, "")}% of the ` +
          `taxable value of this bill — ⚠️ of the value, not of the tax. Deposited ` +
          `by the 10th and reported in GSTR-7; the contractor claims it in their ` +
          `electronic cash ledger.`,
      });
    }
  }

  const statutoryKinds: readonly DeductionKindLike[] = [
    "tds_194c",
    "gst_tds",
    "income_tax_other",
  ];

  const statutoryThisMinor = sumMinor(
    lines.filter((line) => statutoryKinds.includes(line.kind)).map((line) => line.thisMinor),
  );
  const thisTotalMinor = sumMinor(lines.map((line) => line.thisMinor));

  return {
    lines,
    thisTotalMinor,
    cumulativeTotalMinor: sumMinor(lines.map((line) => line.cumulativeMinor)),
    previousTotalMinor: sumMinor(lines.map((line) => line.previousMinor)),
    contractualThisMinor: thisTotalMinor - statutoryThisMinor,
    statutoryThisMinor,
  };
}
