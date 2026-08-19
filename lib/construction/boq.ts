/**
 * Ordence — ⭐ Bill of Quantities
 * Version: v0.42.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A BOQ IS A CONTRACT DOCUMENT, NOT A SPREADSHEET
 * ══════════════════════════════════════════════════════════════════════
 * The contractor priced these quantities at these rates and signed. Three
 * consequences run through this file:
 *
 *   1. ⭐ AN ISSUED BOQ IS IMMUTABLE. Not "should not be edited" —
 *      cannot. `assertBoqMutable` is the pure half of the rule; the
 *      enforcing half is a trigger in SQL 0028 §5, because the
 *      application is one of several write paths.
 *
 *   2. ⭐ THE AUTHORISED QUANTITY IS BOQ + APPROVED VARIATIONS. Nothing
 *      else moves it. A submitted variation is a request, and treating a
 *      request as an authority is how a contract sum grows without
 *      anybody agreeing that it should.
 *
 *   3. ⭐ THE CONTRACT SUM IS THREE NUMBERS. Original, variation, revised.
 *      A single edited "contract value" leaves nobody able to answer "how
 *      much has this grown?", which is the first question at every review.
 */

import { amountFor, sumMinor, QuantityError } from "./quantities";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type BoqLine = {
  id: string;
  itemCode: string;
  sequence: number;
  isHeading: boolean;
  description: string;
  uom: string;
  /** Micro-units, as contracted. */
  quantityScaled: bigint;
  /** Paise per unit, as contracted. */
  rateMinor: bigint;
  /** Net effect of APPROVED variations. Signed. */
  variedQuantityScaled?: bigint;
  /** Set by an approved rate-change variation. */
  variedRateMinor?: bigint | null;
  variedAmountMinor?: bigint;
};

export type PricedBoqLine = BoqLine & {
  /** round_half_up(quantity × rate). */
  amountMinor: bigint;
  /** quantity + varied. What may be measured against. */
  authorisedQuantityScaled: bigint;
  /** varied rate if one was approved, otherwise the contract rate. */
  effectiveRateMinor: bigint;
  /** authorised × effective rate. */
  authorisedAmountMinor: bigint;
};

export type BoqTotals = {
  originalSumMinor: bigint;
  variationSumMinor: bigint;
  revisedSumMinor: bigint;
  lineCount: number;
  headingCount: number;
};

export type BoqStatusLike =
  | "draft"
  | "issued"
  | "superseded"
  | "closed";

export class BoqFrozenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoqFrozenError";
  }
}

/* ------------------------------------------------------------------ */
/* PRICING                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Value one line, and state its authorised position.
 *
 * ⚠️ A HEADING IS VALUED AT ZERO AND ITS INPUTS ARE REFUSED IF THEY ARE
 * NOT. A heading row carrying a rate is a rate nobody sees, applied to a
 * quantity nobody measured, and it foots into the contract sum.
 */
export function priceLine(line: BoqLine): PricedBoqLine {
  if (line.isHeading) {
    if (line.quantityScaled !== 0n || line.rateMinor !== 0n) {
      throw new QuantityError(
        `BOQ item ${line.itemCode} is a heading but carries a quantity or a rate. ` +
          `⚠️ REFUSED: a heading is a caption. One that carries money adds to the ` +
          `contract sum without appearing on any measurement, so nobody ever ` +
          `reconciles it.`,
      );
    }
    return {
      ...line,
      amountMinor: 0n,
      authorisedQuantityScaled: 0n,
      effectiveRateMinor: 0n,
      authorisedAmountMinor: 0n,
    };
  }

  const varied = line.variedQuantityScaled ?? 0n;
  const authorised = line.quantityScaled + varied;

  if (authorised < 0n) {
    throw new QuantityError(
      `BOQ item ${line.itemCode} has ${authorised} micro-units authorised after ` +
        `variations. ⚠️ REFUSED: an omission cannot take out more than was there. ` +
        `A negative authorised quantity would make every downstream check — the ` +
        `measurement ceiling, the contract sum, the final account — read as ` +
        `nonsense.`,
    );
  }

  const effectiveRate = line.variedRateMinor ?? line.rateMinor;

  return {
    ...line,
    amountMinor: amountFor(line.quantityScaled, line.rateMinor),
    authorisedQuantityScaled: authorised,
    effectiveRateMinor: effectiveRate,
    authorisedAmountMinor: amountFor(authorised, effectiveRate),
  };
}

export function priceBoq(lines: readonly BoqLine[]): PricedBoqLine[] {
  return lines.map(priceLine);
}

/**
 * ⭐ THE CONTRACT SUM, AS THREE NUMBERS.
 *
 * ⚠️ `variationSumMinor` IS DERIVED FROM THE LINES, NOT ADDED UP FROM THE
 * VARIATION REGISTER. Both should agree, and the moment they do not, the
 * lines are the truth — because the lines are what a bill measures
 * against. `reconcileVariationEffect` below is what checks the two.
 */
export function boqTotals(lines: readonly PricedBoqLine[]): BoqTotals {
  const priced = lines.filter((line) => !line.isHeading);

  const originalSumMinor = sumMinor(priced.map((line) => line.amountMinor));
  const variationSumMinor = sumMinor(
    priced.map((line) => line.authorisedAmountMinor - line.amountMinor),
  );

  return {
    originalSumMinor,
    variationSumMinor,
    revisedSumMinor: originalSumMinor + variationSumMinor,
    lineCount: priced.length,
    headingCount: lines.length - priced.length,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ IMMUTABILITY                                                     */
/* ------------------------------------------------------------------ */

/** The statuses in which a BOQ's lines and terms may still be edited. */
export const MUTABLE_BOQ_STATUSES: readonly BoqStatusLike[] = ["draft"];

/**
 * ⭐ REFUSE AN EDIT TO AN ISSUED BOQ, WITH THE REASON.
 *
 * ⚠️ THE MESSAGE MATTERS AS MUCH AS THE REFUSAL. Somebody is looking at a
 * typed rate they know is wrong. Telling them "not allowed" leaves them
 * to edit it in the database; telling them the correction path is a
 * variation — which is also what the contract says — is the difference
 * between a rule that holds and a rule that gets worked around.
 */
export function assertBoqMutable(args: {
  status: BoqStatusLike;
  issuedAt: Date | string | null;
  code: string;
  what: string;
}): void {
  if (MUTABLE_BOQ_STATUSES.includes(args.status) && !args.issuedAt) return;

  throw new BoqFrozenError(
    `BOQ ${args.code} has been issued and ${args.what} cannot be changed. ` +
      `⚠️ REFUSED: the contractor priced these quantities and these rates, and ` +
      `their copy is annexed to the work order. Editing ours means the two ` +
      `documents disagree and theirs is the one that governs — while every ` +
      `screen here would show the new figure and nothing would show that the ` +
      `old one was ever contracted. The correction path is a VARIATION, which ` +
      `leaves both positions in the record and requires somebody to approve ` +
      `the change.`,
  );
}

/**
 * ⭐ CAN THIS BOQ BE ISSUED? Returns the reasons it cannot.
 *
 * ⚠️ AN EMPTY BOQ AND A ZERO-RATE LINE ARE BOTH REFUSED. Issuing an empty
 * BOQ creates a contract with no scope; a line at ₹0 is either an
 * unpriced item somebody forgot or a free-of-cost supply that should say
 * so — and it will be measured and billed at zero for four years before
 * anybody asks.
 */
export function issueBlockers(args: {
  lines: readonly PricedBoqLine[];
  contractorVendorId: string | null;
}): string[] {
  const problems: string[] = [];
  const priced = args.lines.filter((line) => !line.isHeading);

  if (priced.length === 0) {
    problems.push(
      "This BOQ has no priced items. Issuing it would create a contract with no " +
        "scope, and every bill against it would measure against nothing.",
    );
  }

  const unpriced = priced.filter((line) => line.rateMinor <= 0n);
  if (unpriced.length > 0) {
    problems.push(
      `${unpriced.length} item(s) carry no rate (${unpriced
        .slice(0, 5)
        .map((line) => line.itemCode)
        .join(", ")}${unpriced.length > 5 ? "…" : ""}). ⚠️ A line at ₹0 is either ` +
        `an item somebody forgot to price or a free-of-cost supply that should ` +
        `say so in its description — and it will be measured and billed at ` +
        `nothing for years before anybody asks.`,
    );
  }

  const zeroQuantity = priced.filter((line) => line.quantityScaled <= 0n);
  if (zeroQuantity.length > 0) {
    problems.push(
      `${zeroQuantity.length} item(s) carry no quantity. A priced line with a ` +
        `zero quantity has a ceiling of zero, so the first measurement against ` +
        `it will be refused as exceeding the BOQ.`,
    );
  }

  if (!args.contractorVendorId) {
    problems.push(
      "No contractor is attached. ⚠️ A running-account bill deducts TDS under " +
        "Section 194C at a rate that depends on the payee's constitution and PAN " +
        "status, and there is no payee here to resolve it against.",
    );
  }

  const duplicates = new Map<string, number>();
  for (const line of args.lines) {
    duplicates.set(line.itemCode, (duplicates.get(line.itemCode) ?? 0) + 1);
  }
  const repeated = [...duplicates.entries()].filter(([, count]) => count > 1);
  if (repeated.length > 0) {
    problems.push(
      `Item code(s) ${repeated.map(([code]) => code).join(", ")} appear more than ` +
        `once. ⚠️ The item code is what every letter, measurement and bill quotes; ` +
        `two lines sharing one is two different rates behind one reference.`,
    );
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE MEASUREMENT CEILING                                          */
/* ------------------------------------------------------------------ */

export type CeilingVerdict =
  | { ok: true; authorisedQuantityScaled: bigint; headroomScaled: bigint }
  | {
      ok: false;
      authorisedQuantityScaled: bigint;
      excessScaled: bigint;
      reason: string;
    };

/**
 * ⭐⭐ MAY THIS CUMULATIVE QUANTITY BE MEASURED AGAINST THIS LINE?
 *
 * ⚠️ THE SINGLE MOST COMMON WAY A CONTRACT SUM IS EXCEEDED WITHOUT
 * ANYBODY DECIDING TO EXCEED IT. The BOQ says 1,200 cum. The site
 * measures 1,340 because the excavation was deeper than the drawing. It
 * is billed, it is certified, it is paid — and the ₹9,03,000 of extra
 * concrete was never authorised by anybody, was never priced, and appears
 * in the final account as an unexplained overrun.
 *
 * A variation is not bureaucracy here. It is the act of somebody with
 * authority saying "yes, dig deeper, and yes, we will pay for it".
 */
export function checkAgainstBoq(args: {
  itemCode: string;
  uom: string;
  authorisedQuantityScaled: bigint;
  proposedCumulativeScaled: bigint;
}): CeilingVerdict {
  const headroom = args.authorisedQuantityScaled - args.proposedCumulativeScaled;

  if (headroom >= 0n) {
    return {
      ok: true,
      authorisedQuantityScaled: args.authorisedQuantityScaled,
      headroomScaled: headroom,
    };
  }

  return {
    ok: false,
    authorisedQuantityScaled: args.authorisedQuantityScaled,
    excessScaled: -headroom,
    reason:
      `Item ${args.itemCode} is authorised for ${formatScaled(args.authorisedQuantityScaled)} ` +
      `${args.uom} and this measurement takes the total to ` +
      `${formatScaled(args.proposedCumulativeScaled)} ${args.uom} — ` +
      `${formatScaled(-headroom)} ${args.uom} beyond the contract. ` +
      `⚠️ REFUSED WITHOUT AN APPROVED VARIATION. The quantity in the BOQ is what ` +
      `was priced and agreed. Measuring past it and billing it is not a ` +
      `measurement, it is a change to the contract that nobody signed — and it ` +
      `is the ordinary way a contract sum grows by crores without a single ` +
      `decision being taken. Raise a variation, have it approved, and the ` +
      `ceiling moves.`,
  };
}

/** Local, so this module does not depend on the formatter's default. */
function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, 3);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
