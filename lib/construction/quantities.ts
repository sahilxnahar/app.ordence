/**
 * Ordence — ⭐⭐ Exact Quantity Arithmetic
 * Version: v0.42.0-alpha
 *
 * Pure and isomorphic. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHY THIS FILE EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * A running-account bill is thousands of `quantity × rate` products, each
 * worth lakhs, each recomputed on every one of twenty-five bills, and
 * each of which somebody will re-derive by hand in an arbitration.
 *
 * 12.345 cum × ₹4,567.89 must be ₹56,390.60. Exactly that, every time.
 *
 * ⚠️ IN IEEE-754 DOUBLES IT IS NOT.
 *
 *     12.345          → 12.3450000000000006394884621840...
 *     4567.89         → 4567.8899999999998726914...
 *     12.345 * 4567.89 → 56390.602049999995   (JS)
 *     …and × 100       → 5639060.204999999   → floor 5639059
 *
 * One paisa. On one line. The direction of the error depends on the
 * particular decimals, so it does not even cancel across a bill. It is
 * silent, it is different in the browser and in Postgres if either uses
 * floating point, and it turns up as "the abstract does not agree with
 * the bill" on a document a contractor is refusing to sign.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE REPRESENTATION
 * ══════════════════════════════════════════════════════════════════════
 *   QUANTITY  `bigint` micro-units — six decimal places, fixed.
 *             12.345 cum → 12_345_000n
 *   RATE      `bigint` paise per ONE unit.
 *             ₹4,567.89 per cum → 456_789n
 *   AMOUNT    `bigint` paise.
 *
 *   amount = round_half_up(quantity_micro × rate_paise / 1_000_000)
 *
 * The multiplication is exact (arbitrary-precision integers); the single
 * division is the only place a fraction can appear, and it is rounded
 * once, half-up, the way an auditor recomputing by hand would.
 *
 * ⚠️ SIX DECIMAL PLACES, NOT THREE. Three would cover every quantity a
 * BOQ ever states — but not a rate-analysis COEFFICIENT. 0.144 bags of
 * cement per cum of mortar is three; 6.336 kg of binding wire per tonne
 * of steel divided by an output of 10 is four; and once a coefficient is
 * derived from another coefficient the places multiply. Six is cheap in a
 * bigint and removes the question.
 *
 * ⚠️ AND NOTHING HERE ROUNDS A QUANTITY. Rounding a quantity to two
 * decimals to "tidy" a bill is how a contractor loses 0.004 cum on every
 * line of every bill for four years.
 */

/* ------------------------------------------------------------------ */
/* THE SCALE                                                           */
/* ------------------------------------------------------------------ */

/** ⭐ Six decimal places. 1 unit = 1_000_000 micro-units. */
export const QUANTITY_SCALE = 1_000_000n;
export const QUANTITY_DECIMALS = 6;

/** Basis points denominator, restated so this module has no imports. */
const BPS = 10_000n;

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

export class QuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuantityError";
  }
}

/* ------------------------------------------------------------------ */
/* PARSING AND FORMATTING                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse a human-typed quantity into micro-units.
 *
 * ⚠️ IT REFUSES MORE THAN SIX DECIMAL PLACES RATHER THAN TRUNCATING.
 * Truncating "12.3456789" to "12.345678" loses work the site engineer
 * measured and says nothing about it. Refusing puts the decision in front
 * of the person who typed it, while it is still free.
 *
 * ⚠️ AND IT TAKES A STRING, NOT A NUMBER. Accepting a `number` would mean
 * the value had already been through a double before this function ever
 * saw it, which is precisely the loss this module exists to prevent.
 */
export function parseQuantity(value: string): bigint {
  const raw = value.trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new QuantityError(
      `"${value}" is not a quantity. Quantities are plain decimal numbers — ` +
        `"12.345", not "12.345 cum" and not "12,345".`,
    );
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");

  if (fraction.length > QUANTITY_DECIMALS) {
    throw new QuantityError(
      `"${value}" has ${fraction.length} decimal places and quantities carry ` +
        `${QUANTITY_DECIMALS}. ⚠️ REFUSED rather than rounded: a quantity quietly ` +
        `shortened is work that was measured and not paid for, on every line of ` +
        `every bill, and nothing on the document would show it happened.`,
    );
  }

  const padded = fraction.padEnd(QUANTITY_DECIMALS, "0");
  const scaled = BigInt(whole ?? "0") * QUANTITY_SCALE + BigInt(padded || "0");
  return negative ? -scaled : scaled;
}

/**
 * Micro-units back to a decimal string.
 *
 * `decimals` trims trailing zeroes for display only — 3 gives "12.345".
 * ⚠️ IT IS A DISPLAY FUNCTION. It never feeds arithmetic, because a
 * displayed quantity has already lost whatever the trim removed.
 */
export function formatQuantity(scaled: bigint, decimals = 3): string {
  if (decimals < 0 || decimals > QUANTITY_DECIMALS) {
    throw new QuantityError(
      `Cannot format to ${decimals} decimal places; quantities carry ` +
        `${QUANTITY_DECIMALS}.`,
    );
  }
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;

  const whole = abs / QUANTITY_SCALE;
  const fraction = (abs % QUANTITY_SCALE).toString().padStart(QUANTITY_DECIMALS, "0");
  const shown = decimals === 0 ? "" : `.${fraction.slice(0, decimals)}`;

  return `${negative ? "-" : ""}${whole.toString()}${shown}`;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE PRODUCT                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ QUANTITY × RATE, EXACTLY, IN PAISE.
 *
 * The single most important function in Phases 42–43. Everything that
 * values a BOQ line, a variation, a rate-analysis component or a running
 * account bill goes through here, so no two of them can round
 * differently.
 *
 * Half-up, away from zero, matching what a person recomputing on paper
 * does and matching `applyRateBps` in `lib/billing/money.ts`.
 */
export function amountFor(quantityScaled: bigint, rateMinor: bigint): bigint {
  const negative = quantityScaled < 0n !== rateMinor < 0n;
  const absQty = quantityScaled < 0n ? -quantityScaled : quantityScaled;
  const absRate = rateMinor < 0n ? -rateMinor : rateMinor;

  // ⚠️ EXACT. bigint multiplication cannot overflow and cannot round.
  const product = absQty * absRate;
  // +half before the single division is half-up in integer arithmetic.
  const rounded = (product + QUANTITY_SCALE / 2n) / QUANTITY_SCALE;

  return negative ? -rounded : rounded;
}

/**
 * The fraction of a paisa that `amountFor` rounded away, in millionths.
 *
 * ⭐ EXPOSED DELIBERATELY. "12.345 × ₹4,567.89 = ₹56,390.60 (rounded from
 * ₹56,390.602050)" is a sentence that ends an argument. A system that
 * cannot show the residue is a system that cannot explain its own
 * rounding to the person disputing it.
 */
export function amountResidue(quantityScaled: bigint, rateMinor: bigint): bigint {
  const absQty = quantityScaled < 0n ? -quantityScaled : quantityScaled;
  const absRate = rateMinor < 0n ? -rateMinor : rateMinor;
  return (absQty * absRate) % QUANTITY_SCALE;
}

/**
 * The exact, unrounded product as a decimal string of paise.
 * Used on the abstract of measurements, where the working is shown.
 */
export function exactAmountString(quantityScaled: bigint, rateMinor: bigint): string {
  const negative = quantityScaled < 0n !== rateMinor < 0n;
  const absQty = quantityScaled < 0n ? -quantityScaled : quantityScaled;
  const absRate = rateMinor < 0n ? -rateMinor : rateMinor;

  const product = absQty * absRate;
  const whole = product / QUANTITY_SCALE;
  const fraction = (product % QUANTITY_SCALE).toString().padStart(QUANTITY_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/* ------------------------------------------------------------------ */
/* DIMENSIONAL WORKING                                                 */
/* ------------------------------------------------------------------ */

export type Dimensions = {
  /** Number of identical items. Micro-units, so 1.5 nos of a bay is legal. */
  nosScaled?: bigint | null;
  lengthScaled?: bigint | null;
  breadthScaled?: bigint | null;
  depthScaled?: bigint | null;
};

/**
 * ⭐ nos × L × B × D, the way a measurement book shows it.
 *
 * ⚠️ THE INTERMEDIATE PRODUCTS ARE NOT ROUNDED. Rounding after each
 * multiplication of a four-term product loses up to four times as much as
 * rounding once, and on a repeated element (250 identical columns) that
 * error is multiplied by 250. So the whole product is formed at full
 * precision — micro^n — and scaled back down exactly once, half-up.
 *
 * A missing dimension is treated as absent, not as zero: "12 nos × 4.5 ×
 * 0.23" is an area measurement with no depth and is 12.42 sqm, whereas
 * treating depth as 0 would make it nothing at all.
 */
export function quantityFromDimensions(dims: Dimensions): bigint {
  const factors: bigint[] = [];
  for (const value of [dims.nosScaled, dims.lengthScaled, dims.breadthScaled, dims.depthScaled]) {
    if (value === null || value === undefined) continue;
    if (value < 0n) {
      throw new QuantityError(
        "A dimension cannot be negative. An opening or a void is measured " +
          "POSITIVE and marked as a deduction — that is how the standard method " +
          "of measurement reads, and it is how a checker verifies it against the " +
          "building.",
      );
    }
    factors.push(value);
  }

  if (factors.length === 0) {
    throw new QuantityError(
      "A measurement needs at least one dimension. An entry with none is a " +
        "number somebody typed with no working behind it, which is exactly what " +
        "a measurement book exists to prevent.",
    );
  }

  // ⚠️ Full-precision product first. `factors.length - 1` scale divisions
  // are then applied in ONE step, so the rounding happens once.
  let product = 1n;
  for (const factor of factors) {
    product *= factor;
  }

  let divisor = 1n;
  for (let i = 1; i < factors.length; i += 1) {
    divisor *= QUANTITY_SCALE;
  }

  return (product + divisor / 2n) / divisor;
}

/* ------------------------------------------------------------------ */
/* SMALL HELPERS                                                       */
/* ------------------------------------------------------------------ */

/** Basis points of a paise amount, half-up, symmetric about zero. */
export function applyBps(amountMinor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps)) {
    throw new QuantityError(`Rates are whole basis points. Got ${bps}.`);
  }
  const negative = amountMinor < 0n !== bps < 0;
  const abs = amountMinor < 0n ? -amountMinor : amountMinor;
  const absBps = BigInt(Math.abs(bps));

  const rounded = (abs * absBps + BPS / 2n) / BPS;
  return negative ? -rounded : rounded;
}

/**
 * total ÷ output, in paise per unit — the last step of a rate analysis.
 * Half-up. ⚠️ Output is a QUANTITY (micro-units), so the scale comes back.
 */
export function rateFromTotal(totalMinor: bigint, outputQuantityScaled: bigint): bigint {
  if (outputQuantityScaled <= 0n) {
    throw new QuantityError(
      "A rate analysis divides its total by the output quantity, so the output " +
        "cannot be zero. An analysis 'per 10 cum' has an output of 10.",
    );
  }
  const negative = totalMinor < 0n;
  const abs = negative ? -totalMinor : totalMinor;

  const scaled = abs * QUANTITY_SCALE;
  const rounded = (scaled + outputQuantityScaled / 2n) / outputQuantityScaled;
  return negative ? -rounded : rounded;
}

/** Sum, with a name, because `reduce` over bigints reads badly inline. */
export function sumMinor(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/* ------------------------------------------------------------------ */
/* UNITS OF MEASUREMENT                                                */
/* ------------------------------------------------------------------ */

export type UomKind = "length" | "area" | "volume" | "mass" | "count" | "time" | "lump";

export type UomDefinition = {
  code: string;
  label: string;
  kind: UomKind;
  /** How many dimensions a measurement of this unit normally carries. */
  dimensionality: 0 | 1 | 2 | 3;
  note: string;
};

/**
 * ⭐ THE UNIT IS PART OF THE PRICE.
 *
 * `dimensionality` is not decoration: it is what lets a screen warn that
 * a `cum` line was measured with only length and breadth, which is a
 * volume measured as an area and is wrong by the thickness — the single
 * most common measurement-book error there is.
 */
export const UOM_CATALOG: Readonly<Record<string, UomDefinition>> = Object.freeze({
  cum: { code: "cum", label: "Cubic metre", kind: "volume", dimensionality: 3,
    note: "Concrete, earthwork, masonry in volume." },
  sqm: { code: "sqm", label: "Square metre", kind: "area", dimensionality: 2,
    note: "Plaster, tiling, formwork, painting." },
  sqft: { code: "sqft", label: "Square foot", kind: "area", dimensionality: 2,
    note: "⚠️ Still quoted on finishing work in India. 1 sqm = 10.7639 sqft — " +
      "a BOQ that mixes the two without saying so is out by a factor of ten." },
  rmt: { code: "rmt", label: "Running metre", kind: "length", dimensionality: 1,
    note: "Skirting, kerb, pipes, railing." },
  kg: { code: "kg", label: "Kilogram", kind: "mass", dimensionality: 0,
    note: "Reinforcement, structural steel." },
  mt: { code: "mt", label: "Metric tonne", kind: "mass", dimensionality: 0,
    note: "⚠️ 1 MT = 1000 kg. Steel quoted per MT and measured in kg is the " +
      "classic thousand-fold billing error." },
  quintal: { code: "quintal", label: "Quintal (100 kg)", kind: "mass", dimensionality: 0,
    note: "Still used by some suppliers." },
  nos: { code: "nos", label: "Number", kind: "count", dimensionality: 0,
    note: "Doors, fixtures, fittings." },
  bag: { code: "bag", label: "Bag (50 kg cement)", kind: "count", dimensionality: 0,
    note: "Cement, in rate analysis coefficients." },
  brass: { code: "brass", label: "Brass (100 cft)", kind: "volume", dimensionality: 3,
    note: "Sand and aggregate in western India. 1 brass = 2.8317 cum." },
  ltr: { code: "ltr", label: "Litre", kind: "volume", dimensionality: 0,
    note: "Admixture, paint, curing compound." },
  day: { code: "day", label: "Day", kind: "time", dimensionality: 0,
    note: "Day-rate labour and plant on hire." },
  month: { code: "month", label: "Month", kind: "time", dimensionality: 0,
    note: "Monthly plant hire, site establishment." },
  ls: { code: "ls", label: "Lump sum", kind: "lump", dimensionality: 0,
    note: "⚠️ Quantity is always 1 and the rate is the whole price. A lump-sum " +
      "line billed on a percentage is a line whose quantity is a fiction." },
});

export const UOM_CODES = Object.keys(UOM_CATALOG);

export function uomDefinition(code: string): UomDefinition {
  const found = UOM_CATALOG[code];
  if (!found) throw new QuantityError(`Unknown unit of measurement: "${code}".`);
  return found;
}

/**
 * ⭐ Does the working match the unit?
 *
 * Returns a warning sentence, or null. ⚠️ IT WARNS RATHER THAN REFUSING.
 * A volume genuinely can be measured as an area times a stated thickness
 * on a separate line, and a rule that refused it would push somebody into
 * mislabelling the unit — which is worse, because then nothing shows.
 */
export function dimensionWarning(
  uom: string,
  dims: Dimensions,
): string | null {
  const def = UOM_CATALOG[uom];
  if (!def || def.dimensionality === 0) return null;

  const given = [dims.lengthScaled, dims.breadthScaled, dims.depthScaled].filter(
    (value) => value !== null && value !== undefined,
  ).length;

  if (given === 0) return null;
  if (given >= def.dimensionality) return null;

  return (
    `This line is in ${def.label.toLowerCase()} (${uom}) but the working gives ` +
    `${given} dimension${given === 1 ? "" : "s"} where ${def.dimensionality} would ` +
    `be expected. ⚠️ A volume measured as an area is wrong by the thickness, and ` +
    `it is the most common measurement-book error there is — check it before it ` +
    `is certified.`
  );
}
