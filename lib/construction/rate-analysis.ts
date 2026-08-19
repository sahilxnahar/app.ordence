/**
 * Ordence — ⭐ Rate Analysis
 * Version: v0.42.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY A RATE HAS TO BE BUILT UP RATHER THAN QUOTED
 * ══════════════════════════════════════════════════════════════════════
 * "₹6,450 per cum of M25" is a number. Nobody can agree or disagree with
 * a number. Built up, it is an argument:
 *
 *     Cement       6.336 bag @ ₹  380.00  =  ₹ 2,407.68
 *     Sand         0.450 cum @ ₹1,650.00  =  ₹   742.50
 *     Aggregate    0.880 cum @ ₹1,420.00  =  ₹ 1,249.60
 *     Admixture    2.500 ltr @ ₹  110.00  =  ₹   275.00
 *     Mason        0.900 day @ ₹  850.00  =  ₹   765.00
 *     Mixer+vibr.  0.150 day @ ₹2,400.00  =  ₹   360.00
 *                                    Prime cost ₹ 5,799.78
 *     Wastage 2%                                ₹   116.00
 *     Overhead 8%                               ₹   473.26
 *     Profit 10%                                ₹   638.90
 *                                        TOTAL  ₹ 7,027.94
 *
 * Two things this buys, and only this buys:
 *
 *   1. ⭐ IT IS THE ONLY DEFENSIBLE ANSWER TO "WHY IS IT THAT MUCH?" —
 *      from the client, from an auditor, and above all from the
 *      contractor negotiating the rate for an extra item, where there is
 *      no tendered rate to fall back on and the alternative is whoever
 *      argues longest.
 *
 *   2. ⭐ WHEN STEEL MOVES 18%, EVERY RATE CONTAINING STEEL MOVES. With
 *      the coefficients recorded, that is arithmetic. Without them it is
 *      re-guessing two thousand rates.
 *
 * ⚠️ THE PERCENTAGES CASCADE, AND THE ORDER IS A COMMERCIAL DECISION.
 * Wastage on the prime cost, overhead on prime + wastage, profit on
 * everything before it — that is the ordinary Indian practice and it is
 * what `buildRate` does. Applying all three to the bare prime cost gives
 * a materially lower rate. Both are used; doing one while the document
 * implies the other is what is not defensible. `explanation` says which
 * was used, in words, on the analysis itself.
 */

import {
  amountFor,
  applyBps,
  rateFromTotal,
  sumMinor,
  QuantityError,
} from "./quantities";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type RateComponentKindLike =
  | "material"
  | "labour"
  | "plant"
  | "transport"
  | "wastage"
  | "overhead"
  | "profit";

export type RateComponentInput = {
  sequence: number;
  kind: RateComponentKindLike;
  description: string;
  uom: string;
  /** Micro-units. The coefficient — 6.336 bags per 10 cum. */
  quantityScaled: bigint;
  /** Paise per unit of the component. */
  rateMinor: bigint;
};

export type PricedRateComponent = RateComponentInput & {
  amountMinor: bigint;
};

/** ⚠️ These three are computed, never entered as components. */
export type RateUpliftBps = {
  wastageRateBps: number;
  overheadRateBps: number;
  profitRateBps: number;
};

export type RateAnalysisResult = {
  components: PricedRateComponent[];
  /** Material + labour + plant + transport, before any uplift. */
  primeCostMinor: bigint;
  materialMinor: bigint;
  labourMinor: bigint;
  plantMinor: bigint;
  transportMinor: bigint;
  wastageMinor: bigint;
  overheadMinor: bigint;
  profitMinor: bigint;
  totalMinor: bigint;
  /** total ÷ output quantity, paise per unit. */
  derivedRateMinor: bigint;
  outputQuantityScaled: bigint;
  /** The sentence that goes on the analysis. */
  explanation: string;
};

/* ------------------------------------------------------------------ */
/* THE BUILD-UP                                                        */
/* ------------------------------------------------------------------ */

const DIRECT_KINDS: readonly RateComponentKindLike[] = [
  "material",
  "labour",
  "plant",
  "transport",
];

/**
 * ⭐ BUILD A RATE FROM ITS PARTS.
 *
 * ⚠️ `wastage`, `overhead` AND `profit` COMPONENTS ARE REFUSED AS INPUTS.
 * They are percentages of what came before, and letting them also be
 * typed as lines means an analysis where overhead appears twice — once as
 * a line and once as a percentage — and totals that nobody can reconcile
 * to the percentages printed beside them.
 *
 * ⚠️ EVERY MULTIPLICATION GOES THROUGH `amountFor`, so a rate analysis
 * cannot round differently from the BOQ line it justifies. An analysis
 * that concludes ₹7,027.94 and a BOQ line priced at ₹7,027.93 is an
 * analysis that does not support its own conclusion.
 */
export function buildRate(args: {
  components: readonly RateComponentInput[];
  uplift: RateUpliftBps;
  /** Micro-units. "Per 10 cum" is 10_000_000. */
  outputQuantityScaled: bigint;
  outputUom: string;
}): RateAnalysisResult {
  if (args.outputQuantityScaled <= 0n) {
    throw new QuantityError(
      "A rate analysis is stated for an output quantity — 'per 10 cum', 'per " +
        "100 sqm' — and the rate is the total divided by it. An output of zero " +
        "has no rate.",
    );
  }

  for (const component of args.components) {
    if (!DIRECT_KINDS.includes(component.kind)) {
      throw new QuantityError(
        `Component ${component.sequence} ("${component.description}") is of kind ` +
          `"${component.kind}". ⚠️ REFUSED: wastage, overhead and profit are ` +
          `PERCENTAGES of the cost below them, not lines beside it. Entered as ` +
          `both, they appear twice — once in the line and once in the uplift — ` +
          `and the total stops agreeing with the percentages printed next to it.`,
      );
    }
    if (component.quantityScaled < 0n || component.rateMinor < 0n) {
      throw new QuantityError(
        `Component ${component.sequence} ("${component.description}") has a ` +
          `negative quantity or rate. A rate analysis builds a cost up; a credit ` +
          `in the middle of it is a discount that belongs in the rate that was ` +
          `negotiated, not in the derivation of the cost.`,
      );
    }
  }

  for (const [name, bps] of Object.entries(args.uplift)) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new QuantityError(
        `${name} is ${bps} basis points. Uplifts are whole basis points between ` +
          `0 and 10000 (100%).`,
      );
    }
  }

  const components: PricedRateComponent[] = args.components.map((component) => ({
    ...component,
    amountMinor: amountFor(component.quantityScaled, component.rateMinor),
  }));

  const byKind = (kind: RateComponentKindLike): bigint =>
    sumMinor(components.filter((c) => c.kind === kind).map((c) => c.amountMinor));

  const materialMinor = byKind("material");
  const labourMinor = byKind("labour");
  const plantMinor = byKind("plant");
  const transportMinor = byKind("transport");

  const primeCostMinor = materialMinor + labourMinor + plantMinor + transportMinor;

  // ⭐ THE CASCADE. Each uplift is on everything above it, which is the
  // ordinary Indian practice and is stated in `explanation` so nobody has
  // to guess which convention produced the number.
  const wastageMinor = applyBps(primeCostMinor, args.uplift.wastageRateBps);
  const afterWastage = primeCostMinor + wastageMinor;

  const overheadMinor = applyBps(afterWastage, args.uplift.overheadRateBps);
  const afterOverhead = afterWastage + overheadMinor;

  const profitMinor = applyBps(afterOverhead, args.uplift.profitRateBps);

  const totalMinor = afterOverhead + profitMinor;
  const derivedRateMinor = rateFromTotal(totalMinor, args.outputQuantityScaled);

  return {
    components,
    primeCostMinor,
    materialMinor,
    labourMinor,
    plantMinor,
    transportMinor,
    wastageMinor,
    overheadMinor,
    profitMinor,
    totalMinor,
    derivedRateMinor,
    outputQuantityScaled: args.outputQuantityScaled,
    explanation: describeBuildUp({
      uplift: args.uplift,
      outputQuantityScaled: args.outputQuantityScaled,
      outputUom: args.outputUom,
    }),
  };
}

/**
 * The sentence printed under the analysis.
 *
 * ⚠️ IT NAMES THE CASCADE. "Overhead at 8% on prime cost plus wastage"
 * and "overhead at 8% on prime cost" are different numbers, and an
 * analysis that does not say which it did cannot be checked by the person
 * it is shown to — which is the only reason to produce it.
 */
export function describeBuildUp(args: {
  uplift: RateUpliftBps;
  outputQuantityScaled: bigint;
  outputUom: string;
}): string {
  const pct = (bps: number): string => (bps / 100).toFixed(2).replace(/\.00$/, "");
  const output = (args.outputQuantityScaled / 1_000_000n).toString();

  return (
    `Built up per ${output} ${args.outputUom}. Wastage at ${pct(args.uplift.wastageRateBps)}% ` +
    `on the prime cost; overhead at ${pct(args.uplift.overheadRateBps)}% on prime cost ` +
    `plus wastage; profit at ${pct(args.uplift.profitRateBps)}% on everything above it. ` +
    `The rate is the total divided by the output.`
  );
}

/* ------------------------------------------------------------------ */
/* ⭐ RE-PRICING                                                       */
/* ------------------------------------------------------------------ */

export type PriceMove = {
  /** Matched on the component description, case-insensitively. */
  description: string;
  newRateMinor: bigint;
};

/**
 * ⭐ WHEN AN INPUT PRICE MOVES, WHAT HAPPENS TO THE RATE?
 *
 * This is the return on having recorded coefficients at all. Steel moves
 * from ₹62,000 to ₹73,000 a tonne and the question "what does that do to
 * our 340 reinforcement lines?" becomes arithmetic instead of a week.
 *
 * ⚠️ IT RETURNS A NEW ANALYSIS RATHER THAN MUTATING ONE. The old analysis
 * priced a contract that was signed; overwriting it would make the signed
 * rate unexplainable.
 */
export function reprice(args: {
  analysis: RateAnalysisResult;
  moves: readonly PriceMove[];
  uplift: RateUpliftBps;
  outputUom: string;
}): RateAnalysisResult & { deltaMinor: bigint; deltaBps: number } {
  const lookup = new Map(
    args.moves.map((move) => [move.description.trim().toLowerCase(), move.newRateMinor]),
  );

  const components = args.analysis.components.map((component) => {
    const moved = lookup.get(component.description.trim().toLowerCase());
    return moved === undefined ? component : { ...component, rateMinor: moved };
  });

  const next = buildRate({
    components,
    uplift: args.uplift,
    outputQuantityScaled: args.analysis.outputQuantityScaled,
    outputUom: args.outputUom,
  });

  const deltaMinor = next.derivedRateMinor - args.analysis.derivedRateMinor;
  const base = args.analysis.derivedRateMinor;
  const deltaBps =
    base === 0n ? 0 : Number((deltaMinor * 10_000n) / base);

  return { ...next, deltaMinor, deltaBps };
}
