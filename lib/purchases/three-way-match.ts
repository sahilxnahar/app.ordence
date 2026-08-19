/**
 * Ordence — ⭐⭐⭐ NO BILL PASSES FOR GOODS THAT NEVER ARRIVED
 * Version: v1.11.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE CONTROL THAT MAKES A PAYMENT RUN SAFE
 * ══════════════════════════════════════════════════════════════════════
 * A payment run over unmatched bills just pays the wrong things faster.
 * That is why this ships in the same session as the payments and not
 * after them.
 *
 * Three documents have to agree:
 *
 *   **What was ordered**   the purchase order
 *   **What arrived**       the goods receipt
 *   **What was billed**    the vendor's invoice
 *
 * ⚠️ THE CLASSIC FRAUD IS NOT A FAKE INVOICE. It is a real vendor
 * billing for eleven when ten arrived, every month, for years. Nobody
 * checks because the vendor is real, the goods are real, and the
 * difference each time is small.
 *
 * ⭐ AND THE CLASSIC HONEST ERROR IS THE SAME SHAPE: a short delivery
 * nobody recorded, or a price on the invoice that is not the price that
 * was agreed on the order.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TOLERANCES EXIST, AND THEY ARE THE TENANT'S
 * ══════════════════════════════════════════════════════════════════════
 * A match that fails on one paisa stops the business, and a business
 * that is stopped starts approving everything by exception, which is the
 * same as no control at all. So there are tolerances, they are the
 * tenant's to set, and every tolerance used is REPORTED rather than
 * silently swallowed.
 */

export class MatchError extends Error {}

/* ------------------------------------------------------------------ */

export type MatchLine = {
  /** The order line this concerns. */
  key: string;
  description: string;
  /** ⭐ Quantities in thousandths, the same convention as the stock ledger. */
  orderedQty: bigint;
  receivedQty: bigint;
  billedQty: bigint;
  /** Rate per unit, minor units. */
  orderedRateMinor: bigint;
  billedRateMinor: bigint;
};

export type MatchTolerance = {
  /** Quantity tolerance in basis points of the ordered quantity. */
  qtyBps: number;
  /** Price tolerance in basis points of the ordered rate. */
  priceBps: number;
  /** ⭐ An absolute floor, so tiny lines are not blocked by rounding. */
  absoluteMinor: bigint;
};

export const DEFAULT_TOLERANCE: MatchTolerance = {
  /** 0%. ⚠️ Deliberately zero: a tolerance nobody chose is a tolerance nobody owns. */
  qtyBps: 0,
  priceBps: 0,
  absoluteMinor: 100n,
};

export type LineProblem = {
  key: string;
  kind:
    | "billed_more_than_received"
    | "billed_more_than_ordered"
    | "received_more_than_ordered"
    | "price_above_order"
    | "nothing_received";
  /** How much money the discrepancy is worth. */
  exposureMinor: bigint;
  message: string;
  /** ⭐ True where it fell inside the tolerance and is reported anyway. */
  withinTolerance: boolean;
};

export type MatchVerdict = {
  /** 🔴 Whether the bill may be approved for payment. */
  passed: boolean;
  problems: readonly LineProblem[];
  /** Total money exposed by the hard failures. */
  exposureMinor: bigint;
  /** ⭐ Discrepancies that passed only because of a tolerance. */
  tolerated: readonly LineProblem[];
  summary: string;
};

/** Absolute value for bigint. */
function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * ⭐⭐ THE MATCH.
 *
 * 🔴 THE ORDER OF THE CHECKS IS THE ORDER OF THE RISK.
 *
 *   1. Billed for more than arrived. This is the one that costs money
 *      and it is the one that repeats.
 *   2. Billed for more than was ordered. Somebody's authority was
 *      exceeded even if the goods did arrive.
 *   3. Received more than ordered. Not a payment problem yet, but it
 *      becomes one on the next invoice.
 *   4. Billed at a higher rate than the order. The quantities can match
 *      perfectly and the money still be wrong.
 *
 * ⚠️ A LOWER BILLED RATE IS NOT A PROBLEM and is not reported as one.
 * Products that flag any variance train people to click through
 * everything.
 */
export function threeWayMatch(args: {
  lines: readonly MatchLine[];
  tolerance?: MatchTolerance;
}): MatchVerdict {
  const tol = args.tolerance ?? DEFAULT_TOLERANCE;
  if (
    !Number.isInteger(tol.qtyBps) ||
    tol.qtyBps < 0 ||
    !Number.isInteger(tol.priceBps) ||
    tol.priceBps < 0 ||
    tol.absoluteMinor < 0n
  ) {
    throw new MatchError("A tolerance cannot be negative.");
  }

  const hard: LineProblem[] = [];
  const soft: LineProblem[] = [];

  for (const l of args.lines) {
    if (l.orderedQty < 0n || l.receivedQty < 0n || l.billedQty < 0n) {
      throw new MatchError(`Quantities cannot be negative on "${l.description}".`);
    }

    const qtyAllowance = (l.orderedQty * BigInt(tol.qtyBps)) / 10_000n;

    /* ① Billed for more than arrived. */
    const overBilled = l.billedQty - l.receivedQty;
    if (overBilled > 0n) {
      const exposure = (overBilled * l.billedRateMinor) / 1000n;
      const within = overBilled <= qtyAllowance || exposure <= tol.absoluteMinor;
      const p: LineProblem = {
        key: l.key,
        kind: l.receivedQty === 0n ? "nothing_received" : "billed_more_than_received",
        exposureMinor: exposure,
        withinTolerance: within,
        message:
          l.receivedQty === 0n
            ? `"${l.description}": billed for ${qty(l.billedQty)} and nothing has been recorded as received. Either the goods receipt was never entered or the goods never came.`
            : `"${l.description}": billed for ${qty(l.billedQty)}, received ${qty(l.receivedQty)}. The bill is ahead of the delivery by ${qty(overBilled)}.`,
      };
      (within ? soft : hard).push(p);
    }

    /* ② Billed for more than was ordered. */
    const overOrdered = l.billedQty - l.orderedQty;
    if (overOrdered > 0n) {
      const exposure = (overOrdered * l.billedRateMinor) / 1000n;
      const within = overOrdered <= qtyAllowance || exposure <= tol.absoluteMinor;
      const p: LineProblem = {
        key: l.key,
        kind: "billed_more_than_ordered",
        exposureMinor: exposure,
        withinTolerance: within,
        message: `"${l.description}": billed for ${qty(l.billedQty)} against an order for ${qty(l.orderedQty)}. Somebody's authority was exceeded, whether or not the goods arrived.`,
      };
      (within ? soft : hard).push(p);
    }

    /* ③ Received more than ordered. */
    const overReceived = l.receivedQty - l.orderedQty;
    if (overReceived > 0n) {
      const exposure = (overReceived * l.orderedRateMinor) / 1000n;
      const within = overReceived <= qtyAllowance || exposure <= tol.absoluteMinor;
      const p: LineProblem = {
        key: l.key,
        kind: "received_more_than_ordered",
        exposureMinor: exposure,
        withinTolerance: within,
        message: `"${l.description}": ${qty(l.receivedQty)} arrived against an order for ${qty(l.orderedQty)}. Not a payment problem yet — it becomes one on the next invoice.`,
      };
      (within ? soft : hard).push(p);
    }

    /* ④ Billed above the ordered rate. */
    const overRate = l.billedRateMinor - l.orderedRateMinor;
    if (overRate > 0n) {
      const allowance =
        (l.orderedRateMinor * BigInt(tol.priceBps)) / 10_000n;
      const exposure = (overRate * l.billedQty) / 1000n;
      const within = overRate <= allowance || exposure <= tol.absoluteMinor;
      const p: LineProblem = {
        key: l.key,
        kind: "price_above_order",
        exposureMinor: exposure,
        withinTolerance: within,
        message: `"${l.description}": billed at ${money(l.billedRateMinor)} against an agreed ${money(l.orderedRateMinor)}. The quantities can match perfectly and the money still be wrong.`,
      };
      (within ? soft : hard).push(p);
    }
  }

  const exposure = hard.reduce((s, p) => s + abs(p.exposureMinor), 0n);
  const passed = hard.length === 0;

  return {
    passed,
    problems: hard,
    tolerated: soft,
    exposureMinor: exposure,
    summary: passed
      ? soft.length === 0
        ? "The order, the delivery and the bill agree."
        : `They agree within tolerance. ${soft.length} difference${soft.length === 1 ? "" : "s"} passed on a tolerance somebody set, and ${soft.length === 1 ? "it is" : "they are"} listed rather than swallowed.`
      : `${hard.length} discrepanc${hard.length === 1 ? "y" : "ies"} worth ${money(exposure)}. This bill cannot be approved for payment until they are resolved or the receipt is corrected.`,
  };
}

/* ------------------------------------------------------------------ */

/** Quantities are thousandths, like the stock ledger. */
function qty(thousandths: bigint): string {
  const whole = thousandths / 1000n;
  const frac = abs(thousandths % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

function money(minor: bigint): string {
  const negative = minor < 0n;
  const digits = abs(minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}
