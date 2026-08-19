/**
 * Ordence — ⭐ Order Line Pricing and Tax
 * Version: v0.39.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * INTEGER PAISE, START TO FINISH. NO FLOAT TOUCHES A LINE.
 * ══════════════════════════════════════════════════════════════════════
 * Quantities arrive as decimal strings with up to three places, because a
 * lorry carries 12.500 tonnes. The obvious implementation multiplies a
 * float quantity by an integer price and rounds. That is wrong twice:
 * `0.1 * 3` is `0.30000000000000004`, and the rounding direction is
 * unstated, so two systems computing the same line disagree by a paisa
 * and an invoice fails reconciliation for a reason nobody can find.
 *
 * So the quantity is scaled to an integer of THOUSANDTHS, multiplied in
 * `bigint`, and divided back down with an EXPLICIT rounding rule.
 *
 * ⚠️ THE ROUNDING RULE IS HALF-UP, AND IT IS STATED HERE BECAUSE IT IS A
 * COMMERCIAL DECISION, NOT A TECHNICAL ONE. Half-up favours the seller by
 * a fraction of a paisa per line. Banker's rounding would be more
 * statistically neutral and would disagree with every Indian accounting
 * package a customer might reconcile against, including Tally. We match
 * the ecosystem rather than the textbook, on purpose.
 *
 * ⚠️ TAX IS COMPUTED ON THE LINE, NOT ON THE ORDER TOTAL. Rule 34-style
 * per-line computation is what the GST portal expects and what a customer
 * checks against. Computing on the total and apportioning back produces a
 * different number in the last paisa on most multi-rate orders.
 */

const SCALE = 1000n;

/** Parse "12.500" → 12500n (thousandths). Rejects anything else. */
export function quantityToThousandths(value: string): bigint {
  const trimmed = value.trim();
  const match = /^(\d{1,15})(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!match) {
    throw new OrderPricingError(
      `"${value}" is not a quantity. Use digits with up to three decimal places.`,
    );
  }
  const whole = BigInt(match[1] ?? "0");
  const frac = (match[2] ?? "").padEnd(3, "0");
  return whole * SCALE + BigInt(frac);
}

export class OrderPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderPricingError";
  }
}

/**
 * Divide `numerator` by `denominator`, rounding half away from zero.
 *
 * ⚠️ Written out rather than using a library so the rule is readable at
 * the site where money is decided.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new OrderPricingError("Division by zero while pricing a line.");
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export type LinePricingInput = {
  quantity: string;
  unitPriceMinor: bigint;
  discountMinor?: bigint;
  taxRateBps?: number | null;
  cessRateBps?: number | null;
  /**
   * ⭐ THE SPLIT IS DECIDED BY PLACE OF SUPPLY, NOT BY THE PRODUCT.
   * Intra-state supply splits the same total rate into CGST + SGST;
   * inter-state charges the whole rate as IGST. The TOTAL tax is
   * identical, which is exactly why getting it wrong is so easy to miss
   * and so expensive at a return — the money is right and the return is
   * wrong.
   */
  isInterState: boolean;
};

export type LinePricing = {
  grossMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  lineTotalMinor: bigint;
};

export function priceLine(input: LinePricingInput): LinePricing {
  const qtyThousandths = quantityToThousandths(input.quantity);
  if (qtyThousandths <= 0n) {
    throw new OrderPricingError("A line quantity must be greater than zero.");
  }
  if (input.unitPriceMinor < 0n) {
    throw new OrderPricingError("A unit price cannot be negative.");
  }

  const grossMinor = divideRoundHalfUp(qtyThousandths * input.unitPriceMinor, SCALE);
  const discountMinor = input.discountMinor ?? 0n;

  if (discountMinor < 0n) {
    throw new OrderPricingError("A discount cannot be negative — reduce the price instead.");
  }
  if (discountMinor > grossMinor) {
    throw new OrderPricingError(
      "The discount is larger than the line value. A negative taxable value is not a discount; it is a credit note, and it is a different document.",
    );
  }

  const taxableValueMinor = grossMinor - discountMinor;

  const rateBps = BigInt(Math.max(0, Math.trunc(input.taxRateBps ?? 0)));
  const cessBps = BigInt(Math.max(0, Math.trunc(input.cessRateBps ?? 0)));

  const totalTax = divideRoundHalfUp(taxableValueMinor * rateBps, 10000n);
  const cessMinor = divideRoundHalfUp(taxableValueMinor * cessBps, 10000n);

  let cgstMinor = 0n;
  let sgstMinor = 0n;
  let igstMinor = 0n;

  if (input.isInterState) {
    igstMinor = totalTax;
  } else {
    // ⚠️ The halves must SUM to the total. Computing each half
    // independently at half the rate loses a paisa on odd totals, and
    // that paisa is the one that makes CGST + SGST ≠ IGST on an
    // otherwise identical invoice.
    cgstMinor = divideRoundHalfUp(totalTax, 2n);
    sgstMinor = totalTax - cgstMinor;
  }

  const lineTotalMinor = taxableValueMinor + cgstMinor + sgstMinor + igstMinor + cessMinor;

  return {
    grossMinor,
    discountMinor,
    taxableValueMinor,
    cgstMinor,
    sgstMinor,
    igstMinor,
    cessMinor,
    lineTotalMinor,
  };
}

/** Sum of a set of priced lines, for the order header. */
export function summarise(lines: LinePricing[]): LinePricing {
  return lines.reduce<LinePricing>(
    (acc, l) => ({
      grossMinor: acc.grossMinor + l.grossMinor,
      discountMinor: acc.discountMinor + l.discountMinor,
      taxableValueMinor: acc.taxableValueMinor + l.taxableValueMinor,
      cgstMinor: acc.cgstMinor + l.cgstMinor,
      sgstMinor: acc.sgstMinor + l.sgstMinor,
      igstMinor: acc.igstMinor + l.igstMinor,
      cessMinor: acc.cessMinor + l.cessMinor,
      lineTotalMinor: acc.lineTotalMinor + l.lineTotalMinor,
    }),
    {
      grossMinor: 0n,
      discountMinor: 0n,
      taxableValueMinor: 0n,
      cgstMinor: 0n,
      sgstMinor: 0n,
      igstMinor: 0n,
      cessMinor: 0n,
      lineTotalMinor: 0n,
    },
  );
}

/**
 * ⭐ WHAT IS STILL OUTSTANDING ON A LINE.
 *
 * ⚠️ RETURNS THOUSANDTHS AS A STRING, not a number. The caller renders
 * it; nothing downstream does arithmetic on a float derived from here.
 */
export function outstandingQuantity(line: {
  quantity: string;
  qtyFulfilled: string;
  qtyCancelled: string;
}): string {
  const remaining =
    quantityToThousandths(line.quantity) -
    quantityToThousandths(line.qtyFulfilled || "0") -
    quantityToThousandths(line.qtyCancelled || "0");
  return formatThousandths(remaining < 0n ? 0n : remaining);
}

export function formatThousandths(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Value-weighted completion, 0–100, as an integer percentage.
 *
 * ⚠️ VALUE-WEIGHTED, NEVER LINE-COUNTED. An order with a ₹50 line
 * dispatched and a ₹50,00,000 line outstanding is not half done, and a
 * screen that says 50% is how an operations meeting concludes an order is
 * nearly finished.
 */
export function completionPercent(fulfilledMinor: bigint, totalMinor: bigint): number {
  if (totalMinor <= 0n) return 0;
  const pct = (fulfilledMinor * 100n) / totalMinor;
  const clamped = pct < 0n ? 0n : pct > 100n ? 100n : pct;
  return Number(clamped);
}
