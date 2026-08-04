/**
 * Ordence — ⭐ Variations / Change Orders
 * Version: v0.42.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A VARIATION IS THE ONLY LAWFUL WAY THE CONTRACT CHANGES
 * ══════════════════════════════════════════════════════════════════════
 * It is also the ONLY thing that moves the measurement ceiling. The BOQ
 * says 1,200 cum; nothing may be measured past 1,200 cum until somebody
 * with authority has said, on a document, that the extra is agreed and
 * at what rate.
 *
 * ⚠️ ONLY `approved` COUNTS. A submitted variation is a request, and
 * treating a request as an authority is exactly the failure the ceiling
 * exists to prevent — it just moves the unauthorised work from "billed
 * without a variation" to "billed against a variation nobody approved",
 * which is harder to find.
 *
 * ⚠️ AND AN OMISSION MUST REDUCE. A variation register that can only add
 * is a contract sum that only goes up, and the scope taken out of the
 * contract in month four is still sitting in the forecast in month forty.
 */

import { amountFor, sumMinor } from "./quantities";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type VariationKindLike =
  | "addition"
  | "omission"
  | "rate_change"
  | "substitution"
  | "extra_item";

export type VariationStatusLike =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "withdrawn";

export type VariationLineInput = {
  sequence: number;
  /** NULL for an extra item with no BOQ line. */
  boqItemId: string | null;
  description: string;
  uom: string;
  /** ⭐ SIGNED micro-units. An omission of 40 cum is -40_000_000. */
  quantityDeltaScaled: bigint;
  rateMinor: bigint;
  /** TRUE only on a rate change or substitution. */
  replacesRate: boolean;
  /** Needed for a rate change: what the line carried before. */
  existingQuantityScaled?: bigint;
  existingRateMinor?: bigint;
};

export type PricedVariationLine = VariationLineInput & {
  /** Signed. Negative for an omission. */
  amountDeltaMinor: bigint;
};

export type VariationEffect = {
  lines: PricedVariationLine[];
  /** ⭐ SIGNED. The change to the contract sum. */
  effectMinor: bigint;
  additionsMinor: bigint;
  omissionsMinor: bigint;
  extraItemCount: number;
};

export class VariationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariationError";
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE EFFECT ON THE CONTRACT SUM                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ VALUE A VARIATION.
 *
 * Three shapes, and they price differently:
 *
 *   • ADDITION / OMISSION / EXTRA ITEM — the delta quantity at the
 *     variation's rate. An omission carries a negative quantity, so the
 *     amount comes out negative on its own.
 *
 *   • RATE CHANGE — ⚠️ THE ONE PEOPLE GET WRONG. The effect is not the
 *     new rate times anything; it is the DIFFERENCE between the new and
 *     old rates applied to the quantity affected, plus any quantity
 *     delta at the new rate. Valuing a rate change at the full new rate
 *     would double the line into the contract sum.
 *
 *   • SUBSTITUTION — an omission at the old rate and an addition at the
 *     new, which is a rate change on the whole quantity.
 */
export function priceVariation(args: {
  kind: VariationKindLike;
  lines: readonly VariationLineInput[];
}): VariationEffect {
  const lines: PricedVariationLine[] = args.lines.map((line) => {
    if (line.replacesRate) {
      if (!line.boqItemId) {
        throw new VariationError(
          `Line ${line.sequence} changes a rate but names no BOQ item. Replacing ` +
            `the rate of nothing is a row that silently does nothing at all — and ` +
            `it will be approved, because it looks like every other line.`,
        );
      }
      if (
        line.existingQuantityScaled === undefined ||
        line.existingRateMinor === undefined
      ) {
        throw new VariationError(
          `Line ${line.sequence} changes the rate of BOQ item ${line.boqItemId} but ` +
            `the existing quantity and rate were not supplied. ⚠️ A rate change is ` +
            `valued at the DIFFERENCE between the rates on the quantity affected. ` +
            `Valuing it at the full new rate would add the whole line into the ` +
            `contract sum a second time.`,
        );
      }

      // ⭐ (new − old) on the quantity that stays, plus the delta at the new rate.
      const onExisting =
        amountFor(line.existingQuantityScaled, line.rateMinor) -
        amountFor(line.existingQuantityScaled, line.existingRateMinor);
      const onDelta = amountFor(line.quantityDeltaScaled, line.rateMinor);

      return { ...line, amountDeltaMinor: onExisting + onDelta };
    }

    if (line.rateMinor < 0n) {
      throw new VariationError(
        `Line ${line.sequence} carries a negative rate. An omission is a negative ` +
          `QUANTITY at a positive rate — that is how it reads on the document and ` +
          `how it reconciles against the BOQ line it reduces.`,
      );
    }

    return {
      ...line,
      amountDeltaMinor: amountFor(line.quantityDeltaScaled, line.rateMinor),
    };
  });

  const effectMinor = sumMinor(lines.map((line) => line.amountDeltaMinor));

  // ⚠️ THE SIGN MUST MATCH THE KIND. A row typed the wrong way round moves
  // the contract sum in the wrong direction and reads as nonsense in the
  // variation register — where it is copied into a forecast.
  if (args.kind === "omission" && effectMinor > 0n) {
    throw new VariationError(
      `This variation is an OMISSION but its net effect is +${effectMinor} paise. ` +
        `⚠️ Scope taken out of a contract reduces the contract sum. An omission ` +
        `that increases it is either the quantities typed positive when they ` +
        `should be negative, or a variation that is not an omission at all.`,
    );
  }
  if (args.kind === "addition" && effectMinor < 0n) {
    throw new VariationError(
      `This variation is an ADDITION but its net effect is ${effectMinor} paise. ` +
        `Additional scope increases the contract sum; if this really reduces it, ` +
        `it is an omission and should say so.`,
    );
  }

  const additions = lines.filter((line) => line.amountDeltaMinor > 0n);
  const omissions = lines.filter((line) => line.amountDeltaMinor < 0n);

  return {
    lines,
    effectMinor,
    additionsMinor: sumMinor(additions.map((line) => line.amountDeltaMinor)),
    omissionsMinor: sumMinor(omissions.map((line) => line.amountDeltaMinor)),
    extraItemCount: lines.filter((line) => line.boqItemId === null).length,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ THE APPROVAL STATE MACHINE                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `approved` HAS NO WAY BACK. Not because reversing a decision is
 * impossible, but because a variation that has been approved has already
 * moved the measurement ceiling — and quantities may already have been
 * measured and certified against it. Un-approving it would leave
 * certified work above a ceiling that no longer permits it, and the money
 * already paid unaccounted for.
 *
 * The correction path is a FURTHER variation reversing the first. Both
 * stay in the register, which is what a register is for.
 */
export const VARIATION_TRANSITIONS: Readonly<
  Record<VariationStatusLike, readonly VariationStatusLike[]>
> = Object.freeze({
  draft: ["submitted", "withdrawn"],
  submitted: ["approved", "rejected", "withdrawn"],
  approved: [],
  rejected: ["draft", "withdrawn"],
  withdrawn: [],
});

export function canTransitionVariation(
  from: VariationStatusLike,
  to: VariationStatusLike,
): boolean {
  return VARIATION_TRANSITIONS[from].includes(to);
}

export type VariationTransitionInput = {
  from: VariationStatusLike;
  to: VariationStatusLike;
  actorId: string;
  /** Who raised it. ⚠️ May not be the approver. */
  createdBy: string | null;
  reason?: string | null;
};

/**
 * ⭐ THE TRANSITION, WITH THE SEGREGATION.
 *
 * ⚠️ THE PERSON WHO RAISED A VARIATION MAY NOT APPROVE IT. Somebody who
 * can do both can award themselves work: raise a variation for an extra
 * item, set the rate, approve it, and the measurement ceiling moves with
 * no second person ever seeing the number. It is the same control as
 * measure-versus-certify on a bill and it fails the same way.
 */
export function applyVariationTransition(input: VariationTransitionInput): void {
  if (!canTransitionVariation(input.from, input.to)) {
    throw new VariationError(
      `A variation cannot go from ${input.from} to ${input.to}.` +
        (input.from === "approved"
          ? " ⚠️ An APPROVED variation has already moved the measurement ceiling, " +
            "and quantities may already have been measured and certified against " +
            "it. Un-approving it would leave certified work above a ceiling that " +
            "no longer permits it, and money already paid unaccounted for. Raise a " +
            "FURTHER variation reversing this one; both then stay in the register."
          : ""),
    );
  }

  if (input.to === "approved" && input.createdBy && input.createdBy === input.actorId) {
    throw new VariationError(
      "⚠️ REFUSED: the person who raised this variation cannot approve it. " +
        "Somebody who can do both can award themselves work — raise an extra " +
        "item, set its rate, approve it, and the measurement ceiling moves with " +
        "no second person having seen the number. It is the same control as " +
        "measure-versus-certify on a running account bill, and it fails the same " +
        "way: silently, and only in favour of whoever set it up.",
    );
  }

  if (input.to === "rejected" && !input.reason?.trim()) {
    throw new VariationError(
      "A rejected variation needs a reason. The contractor will ask, and " +
        "'rejected' with nothing beside it is how a claim starts.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE AUTHORISED POSITION                                          */
/* ------------------------------------------------------------------ */

export type ApprovedVariationLine = {
  boqItemId: string | null;
  quantityDeltaScaled: bigint;
  rateMinor: bigint;
  replacesRate: boolean;
  amountDeltaMinor: bigint;
};

export type AuthorisedPosition = {
  /** Net approved quantity delta, per BOQ item. */
  quantityDeltaByItem: Map<string, bigint>;
  /** Replacement rate, per BOQ item, where one was approved. */
  rateByItem: Map<string, bigint>;
  /** Net approved amount delta, per BOQ item. */
  amountDeltaByItem: Map<string, bigint>;
  /** The whole contract's variation sum, including extra items. */
  totalEffectMinor: bigint;
};

/**
 * ⭐ FOLD APPROVED VARIATIONS INTO THE AUTHORISED POSITION.
 *
 * ⚠️ ONLY APPROVED LINES REACH THIS FUNCTION — the caller filters, and
 * SQL 0028 §4 does the same fold in the database from `boq_variations`
 * whose status is `approved`. Two implementations of the same fold is
 * deliberate: the database one is what the measurement ceiling is checked
 * against and must hold whatever writes it; this one is what a screen
 * shows before anything is written, so a person can see the ceiling move
 * before they approve.
 *
 * ⚠️ THE LAST APPROVED RATE CHANGE WINS, and the caller must pass lines in
 * approval order. Two rate changes on one line is unusual but legal
 * (steel moved twice); the current rate is the most recent approval, not
 * the largest and not the first.
 */
export function foldApprovedVariations(
  lines: readonly ApprovedVariationLine[],
): AuthorisedPosition {
  const quantityDeltaByItem = new Map<string, bigint>();
  const rateByItem = new Map<string, bigint>();
  const amountDeltaByItem = new Map<string, bigint>();
  let totalEffectMinor = 0n;

  for (const line of lines) {
    totalEffectMinor += line.amountDeltaMinor;

    if (!line.boqItemId) continue; // an extra item has no BOQ line to fold into

    quantityDeltaByItem.set(
      line.boqItemId,
      (quantityDeltaByItem.get(line.boqItemId) ?? 0n) + line.quantityDeltaScaled,
    );
    amountDeltaByItem.set(
      line.boqItemId,
      (amountDeltaByItem.get(line.boqItemId) ?? 0n) + line.amountDeltaMinor,
    );
    if (line.replacesRate) {
      rateByItem.set(line.boqItemId, line.rateMinor);
    }
  }

  return { quantityDeltaByItem, rateByItem, amountDeltaByItem, totalEffectMinor };
}

/**
 * ⚠️ THE TWO SIDES MUST AGREE. The variation register's total and the
 * fold into the BOQ lines are two routes to the same number, and a
 * project review where they differ is a review that stops.
 *
 * Returns null when they agree, or the sentence describing the gap.
 */
export function reconcileVariationEffect(args: {
  registerTotalMinor: bigint;
  foldedTotalMinor: bigint;
}): string | null {
  if (args.registerTotalMinor === args.foldedTotalMinor) return null;
  const gap = args.registerTotalMinor - args.foldedTotalMinor;
  return (
    `The variation register totals ${args.registerTotalMinor} paise and the ` +
    `approved lines folded into the BOQ total ${args.foldedTotalMinor} — a ` +
    `difference of ${gap}. ⚠️ These are two routes to the contract sum and they ` +
    `appear on different screens: the register drives the change report, the ` +
    `folded lines drive the measurement ceiling and every bill. When they ` +
    `disagree, one of them is authorising work at a value nobody has approved.`
  );
}
