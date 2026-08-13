/**
 * Ordence — ⭐⭐⭐ THE THREE-WAY MATCH
 * Version: v1.19.0-alpha
 *
 * Pure. No clock, no network, no database. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A CORRECTION TO WHAT v1.11.0 CLAIMED
 * ══════════════════════════════════════════════════════════════════════
 * That session shipped 0063 and said it delivered "purchase orders,
 * goods receipts, three-way match, vendor payments and the payment run".
 * The vendor payments half is real and works. The other half was tables
 * and nothing else: `purchase_orders`, `purchase_order_lines` and
 * `goods_receipt_lines` were never referenced by any code, and
 * `goodsReceipts` appears in `server/actions/vendor-payments.ts` as an
 * import that is never used.
 *
 * ⚠️ SO `purchase_invoices.match_state` HAS EXISTED SINCE 0063 AND
 * NOTHING HAS EVER SET IT. The payment run reads it, displays it, and
 * has only ever seen null.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHAT A THREE-WAY MATCH IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Three documents describe one purchase. The ORDER says what was agreed.
 * The RECEIPT says what arrived. The INVOICE says what is being charged.
 * A business pays the invoice, and the only defence against paying for
 * something that was never ordered or never arrived is that the three
 * agree.
 *
 * 🔴 THE RESULT NAMES WHICH OF THE THREE DISAGREES. A match that returns
 * a boolean tells a person their bill failed and nothing about which
 * document to go and look at, so they approve it anyway. Half the value
 * of this file is in the sentences.
 */

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ QUANTITIES ARE STRINGS AND MONEY IS `bigint` MINOR UNITS, as
 * everywhere else. `numeric(18,3)` does not fit in a double, and a
 * purchase ledger that drifts by a thousandth per line accumulates into
 * a permanent unexplained difference.
 */
export type Quantity = string;

export function toThousandths(q: Quantity): bigint {
  const t = q.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(t)) {
    throw new Error(`A quantity must have at most three decimal places. Got "${q}".`);
  }
  const negative = t.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? t.slice(1) : t).split(".");
  const v = BigInt(whole) * 1000n + BigInt((frac + "000").slice(0, 3));
  return negative ? -v : v;
}

export function fromThousandths(v: bigint): Quantity {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  return `${negative ? "-" : ""}${abs / 1000n}.${(abs % 1000n).toString().padStart(3, "0")}`;
}

/** One line, seen from all three documents. */
export interface MatchLine {
  readonly lineKey: string;
  readonly description: string;
  /** Null where the invoice line has no order line behind it. */
  readonly orderedQty: Quantity | null;
  readonly orderedUnitPriceMinor: bigint | null;
  /** Null where nothing has been received against this line. */
  readonly receivedQty: Quantity | null;
  /** ⭐ Rejected on the dock. Received is not the same as accepted. */
  readonly rejectedQty: Quantity | null;
  readonly invoicedQty: Quantity;
  readonly invoicedUnitPriceMinor: bigint;
}

/* ------------------------------------------------------------------ */
/* TOLERANCE                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ TOLERANCE IS TWO NUMBERS AND THE SMALLER WINS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A PERCENTAGE ALONE IS WRONG AT BOTH ENDS
 * ══════════════════════════════════════════════════════════════════════
 * 2% of a ₹40 lakh order is ₹80,000, which is not a rounding difference,
 * it is a car. And 2% of a ₹300 line is ₹6, so a genuine ₹7 keying error
 * blocks a bill nobody should be looking at.
 *
 * 🔴 SO BOTH ARE APPLIED AND THE TIGHTER ONE DECIDES. The absolute cap
 * stops a percentage becoming enormous on a large line; the percentage
 * stops the absolute becoming a large proportion of a small one.
 */
export interface Tolerance {
  /** Basis points. 100 = 1%. */
  readonly priceBps: number;
  /** Hard ceiling in minor units, whatever the percentage says. */
  readonly priceCapMinor: bigint;
  /** Basis points on quantity. */
  readonly quantityBps: number;
}

/**
 * ⚠️ ORDENCE'S OPENING DEFAULTS, NOT A LAW. A jeweller and a sand
 * supplier need different numbers, and when somebody asks this becomes a
 * column on the vendor rather than a bigger `if`.
 *
 * ⭐ THE QUANTITY TOLERANCE IS DELIBERATELY TIGHTER THAN THE PRICE ONE.
 * Short delivery is a thing a person can go and look at on the shelf. A
 * price difference is an argument about a document, and the loose one
 * should be the one that can be settled by looking.
 */
export const DEFAULT_TOLERANCE: Tolerance = Object.freeze({
  priceBps: 200,
  priceCapMinor: 50_000n,
  quantityBps: 50,
});

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

/** ⚠️ These four are `purchase_invoices_match_state_known` in 0063. */
export type MatchState =
  | "matched"
  | "matched_within_tolerance"
  | "unmatched"
  | "no_order";

/**
 * 🔴 WHICH DOCUMENT IS THE ODD ONE OUT. The point of the whole file.
 */
export type Discrepancy =
  /** Invoiced for more than was ever ordered. */
  | "over_ordered"
  /** Invoiced for more than arrived. The expensive one. */
  | "over_received"
  /** Arrived but not invoiced yet. Usually fine, sometimes a missing bill. */
  | "under_invoiced"
  /** Nothing has been received against this line at all. */
  | "not_received"
  /** The unit price on the bill is not the price agreed. */
  | "price_differs"
  /** Goods arrived and were rejected, and the bill charges for them. */
  | "rejected_but_invoiced"
  /** The line is on the bill and on no order. */
  | "no_order_line";

export interface LineFinding {
  readonly lineKey: string;
  readonly description: string;
  readonly discrepancy: Discrepancy;
  /** ⚠️ Signed, in minor units. Positive means the bill is HIGH. */
  readonly valueImpactMinor: bigint;
  readonly withinTolerance: boolean;
  /** One sentence, naming the document to look at. */
  readonly explanation: string;
}

export interface MatchResult {
  readonly state: MatchState;
  readonly findings: readonly LineFinding[];
  /** ⚠️ Positive means the bill charges more than the order and receipt support. */
  readonly netImpactMinor: bigint;
  /** 🔴 Required by 0063 when the state is matched_within_tolerance. */
  readonly note: string | null;
  readonly headline: string;
}

/**
 * ⭐⭐⭐ MATCH.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 IT COMPARES LINE BY LINE AND NEVER TOTAL TO TOTAL
 * ══════════════════════════════════════════════════════════════════════
 * Matching on totals is the single most common way this control is
 * implemented and it is worthless. Two lines that are wrong in opposite
 * directions net to a correct total: the bill is passed, one item was
 * over-charged, another under-delivered, and the invoice reconciles
 * perfectly to the order.
 *
 * ⚠️ THE TOTAL IS REPORTED. IT IS NEVER THE TEST.
 */
export function matchThreeWay(
  lines: readonly MatchLine[],
  tolerance: Tolerance,
  now: Date,
): MatchResult {
  void now;

  const findings: LineFinding[] = [];
  let net = 0n;

  for (const line of lines) {
    for (const finding of findingsFor(line, tolerance)) {
      findings.push(finding);
      net += finding.valueImpactMinor;
    }
  }

  // ⭐ A bill with no order behind it at all is a state of its own, not a
  // failure. Petty cash, a utility bill, a professional fee: none of them
  // start with a purchase order, and reporting them as unmatched would
  // train people to ignore the word.
  const everyLineOrderless = lines.length > 0 && lines.every((l) => l.orderedQty === null);
  if (everyLineOrderless) {
    return {
      state: "no_order",
      findings: [],
      netImpactMinor: 0n,
      note: null,
      headline:
        "There is no purchase order behind this bill. That is normal for utilities, rent and professional fees, and it means the three-way match has nothing to compare. Somebody still has to approve it on its own merits.",
    };
  }

  if (findings.length === 0) {
    return {
      state: "matched",
      findings: [],
      netImpactMinor: 0n,
      note: null,
      headline: "The order, the receipt and the bill agree on every line.",
    };
  }

  const outside = findings.filter((f) => !f.withinTolerance);

  if (outside.length === 0) {
    /**
     * 🔴 THE NOTE IS BUILT HERE AND IS NOT OPTIONAL. 0063 carries a CHECK
     * refusing `matched_within_tolerance` without one, because "matched"
     * with no explanation is the audit trail saying nothing at the exact
     * point somebody will ask what the tolerance let through.
     */
    const worst = [...findings].sort(byAbsImpact)[0]!;
    return {
      state: "matched_within_tolerance",
      findings,
      netImpactMinor: net,
      note: `Passed on tolerance. ${findings.length} line${findings.length === 1 ? "" : "s"} differ, the largest by ${describeMinor(worst.valueImpactMinor)} on "${worst.description}". Net effect on the bill: ${describeMinor(net)}.`,
      headline: `Within tolerance, but ${findings.length} line${findings.length === 1 ? " does" : "s do"} not agree exactly.`,
    };
  }

  const worst = [...outside].sort(byAbsImpact)[0]!;
  return {
    state: "unmatched",
    findings,
    netImpactMinor: net,
    note: null,
    headline: `${outside.length} line${outside.length === 1 ? "" : "s"} fall outside tolerance. The largest: ${worst.explanation}`,
  };
}

/* ------------------------------------------------------------------ */
/* PER LINE                                                            */
/* ------------------------------------------------------------------ */

function findingsFor(line: MatchLine, tol: Tolerance): LineFinding[] {
  const out: LineFinding[] = [];

  const invoiced = toThousandths(line.invoicedQty);
  const ordered = line.orderedQty === null ? null : toThousandths(line.orderedQty);
  const received = line.receivedQty === null ? null : toThousandths(line.receivedQty);
  const rejected = line.rejectedQty === null ? 0n : toThousandths(line.rejectedQty);

  // ① A line on the bill with no order line behind it.
  if (ordered === null) {
    out.push({
      lineKey: line.lineKey,
      description: line.description,
      discrepancy: "no_order_line",
      valueImpactMinor: (invoiced * line.invoicedUnitPriceMinor) / 1000n,
      // ⚠️ NEVER within tolerance. A line nobody ordered is not a small
      // difference, it is a different transaction.
      withinTolerance: false,
      explanation: `"${line.description}" is on the bill and on no purchase order. Check the order before paying it.`,
    });
    return out;
  }

  // ② Nothing received at all.
  if (received === null || received === 0n) {
    out.push({
      lineKey: line.lineKey,
      description: line.description,
      discrepancy: "not_received",
      valueImpactMinor: (invoiced * line.invoicedUnitPriceMinor) / 1000n,
      withinTolerance: false,
      explanation: `"${line.description}" is being charged for and nothing has been booked in against it. Either the goods receipt was never entered or the goods never came.`,
    });
    return out;
  }

  const accepted = received - rejected;

  // ③ 🔴 REJECTED GOODS ON THE BILL. The one that costs real money
  // quietly: the dock refused them, the paperwork did not follow, and
  // the bill charges for them anyway.
  if (rejected > 0n && invoiced > accepted) {
    const excess = min(invoiced - accepted, rejected);
    out.push({
      lineKey: line.lineKey,
      description: line.description,
      discrepancy: "rejected_but_invoiced",
      valueImpactMinor: (excess * line.invoicedUnitPriceMinor) / 1000n,
      withinTolerance: false,
      explanation: `${fromThousandths(rejected)} of "${line.description}" was rejected on arrival and the bill still charges for it. This needs a credit note, not an approval.`,
    });
  }

  // ④ Invoiced beyond what arrived.
  if (invoiced > accepted) {
    const excess = invoiced - accepted;
    const impact = (excess * line.invoicedUnitPriceMinor) / 1000n;
    const within = withinQuantityTolerance(excess, accepted, tol);
    out.push({
      lineKey: line.lineKey,
      description: line.description,
      discrepancy: "over_received",
      valueImpactMinor: impact,
      withinTolerance: within,
      explanation: `The bill charges for ${fromThousandths(invoiced)} of "${line.description}" and ${fromThousandths(accepted)} was accepted. ${describeMinor(impact)} more than the receipt supports.`,
    });
  }

  // ⑤ Invoiced beyond what was ordered, which is a different fault from
  // ④ even when both fire: one is the warehouse, the other is the order.
  if (invoiced > ordered) {
    const excess = invoiced - ordered;
    const impact = (excess * line.invoicedUnitPriceMinor) / 1000n;
    out.push({
      lineKey: line.lineKey,
      description: line.description,
      discrepancy: "over_ordered",
      valueImpactMinor: 0n, // ⚠️ Counted once, in ④. See below.
      withinTolerance: withinQuantityTolerance(excess, ordered, tol),
      explanation: `${fromThousandths(invoiced)} of "${line.description}" is being charged and only ${fromThousandths(ordered)} was ordered. Somebody has to say who authorised the extra.`,
    });
  }

  // ⑥ Received and not fully invoiced. Usually fine.
  if (accepted > invoiced) {
    out.push({
      lineKey: line.lineKey,
      description: line.description,
      discrepancy: "under_invoiced",
      // ⭐ NEGATIVE: the bill is LOW. Reported, not blocked. A vendor
      // under-charging is not a reason to refuse to pay them.
      valueImpactMinor: -(((accepted - invoiced) * line.invoicedUnitPriceMinor) / 1000n),
      withinTolerance: true,
      explanation: `${fromThousandths(accepted - invoiced)} of "${line.description}" arrived and has not been billed yet. Expect another invoice.`,
    });
  }

  // ⑦ 🔴 THE PRICE. The one that gets through.
  //
  // ⚠️ A short delivery is noticed on the dock by somebody counting
  // boxes. A unit price two rupees above the agreed rate is noticed by
  // nobody, on every line, every month, for years.
  if (line.orderedUnitPriceMinor !== null) {
    const diff = line.invoicedUnitPriceMinor - line.orderedUnitPriceMinor;
    if (diff !== 0n) {
      const impact = (invoiced * diff) / 1000n;
      out.push({
        lineKey: line.lineKey,
        description: line.description,
        discrepancy: "price_differs",
        valueImpactMinor: impact,
        withinTolerance: withinPriceTolerance(
          line.orderedUnitPriceMinor,
          line.invoicedUnitPriceMinor,
          tol,
        ),
        explanation: `"${line.description}" was ordered at ${describeMinor(line.orderedUnitPriceMinor)} a unit and billed at ${describeMinor(line.invoicedUnitPriceMinor)}. Over ${fromThousandths(invoiced)} units that is ${describeMinor(impact)}.`,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* TOLERANCE ARITHMETIC                                                */
/* ------------------------------------------------------------------ */

export function withinPriceTolerance(
  agreedMinor: bigint,
  billedMinor: bigint,
  tol: Tolerance,
): boolean {
  const diff = abs(billedMinor - agreedMinor);
  const byPercent = (abs(agreedMinor) * BigInt(tol.priceBps)) / 10_000n;
  // 🔴 THE TIGHTER OF THE TWO WINS. See the note on `Tolerance`.
  return diff <= min(byPercent, tol.priceCapMinor);
}

export function withinQuantityTolerance(
  excessThousandths: bigint,
  baseThousandths: bigint,
  tol: Tolerance,
): boolean {
  if (baseThousandths === 0n) return false;
  const allowed = (abs(baseThousandths) * BigInt(tol.quantityBps)) / 10_000n;
  return abs(excessThousandths) <= allowed;
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function byAbsImpact(a: LineFinding, b: LineFinding): number {
  const av = abs(a.valueImpactMinor);
  const bv = abs(b.valueImpactMinor);
  return bv > av ? 1 : bv < av ? -1 : 0;
}

/**
 * ⚠️ Rupees for a person to read. The sign is spelled out rather than
 * shown as a minus, because a leading `-` in a sentence about money is
 * read as a dash about half the time.
 */
export function describeMinor(minor: bigint): string {
  const negative = minor < 0n;
  const a = negative ? -minor : minor;
  const body = `₹${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
  return negative ? `${body} in your favour` : body;
}
