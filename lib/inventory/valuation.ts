/**
 * Ordence — ⭐⭐⭐ INVENTORY VALUATION — THE LAYER MODEL
 * Batches 85–87 · v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `stock_items.valuation_method` has existed since SQL 0029. It has an
 * enum, a column, a Zod field, a form control, a settings page that
 * confirms the choice back to the user, and an audit entry recording the
 * change. Until this file it was READ BY NOTHING.
 *
 * That is worse than not offering the choice. A customer who picks FIFO
 * is told the system is on FIFO; the accounts are then produced on
 * whatever basis fell out of the code — which was "whatever unit cost
 * happened to be typed on the movement", i.e. no basis at all. COGS
 * drives gross profit, closing stock drives the balance sheet, and
 * s.145A of the Income-tax Act requires the method to be consistently
 * applied. A method nobody applies is a representation to the reader of
 * the accounts that is not true.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A VALUATION METHOD IS A LAYER MODEL, NOT A FORMULA
 * ══════════════════════════════════════════════════════════════════════
 * None of these can be computed from a closing balance. FIFO needs the
 * cost layers in receipt order and consumes them in that order. Weighted
 * average needs a running pool recomputed on every receipt — the average
 * at the moment of EACH issue, not the average at the year end. Standard
 * cost needs the variance separated at the point of receipt. All three
 * need the movement history, and `stock_movements` is where it lives.
 *
 * So the engine REPLAYS. Give it the movements and it produces the
 * layers, the cost of every issue, and the closing value. Give it the
 * same movements again and it produces exactly the same answer — which
 * is the property an auditor is actually testing when they ask you to
 * re-run it in front of them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MONEY RULES, WHICH ARE NOT NEGOTIABLE
 * ══════════════════════════════════════════════════════════════════════
 * Money is `bigint` paise. Quantity is `bigint` THOUSANDTHS of a
 * stocking unit (the ledger column is `numeric(18,3)`). There is not a
 * single `number` in the arithmetic below, because
 * `Math.round(Number("1.005") * 100)` is 100 and a stock ledger that is
 * one paisa out does not foot, and a ledger that does not foot is not
 * evidence of anything.
 *
 * ⭐ A LAYER HOLDS A TOTAL VALUE, NEVER A UNIT COST. A unit cost is a
 * ratio: 3 bags at ₹1,000 for two of them is 333.33 each and there is no
 * such coin. Rounding that ratio and multiplying it back is exactly how
 * a stock ledger stops footing. Instead every layer carries
 * (qtyRemaining, valueRemaining) and an issue of `q` from a layer of
 * `Q`/`V` costs `V*q/Q` — divided ONCE, at the point of use, with the
 * floor's remainder LEFT IN THE LAYER where it stays attached to the
 * units it belongs to. Consuming a layer completely therefore always
 * releases exactly `V`. Nothing evaporates and nothing is invented.
 *
 * ⚠️ THIS FILE IS PURE. No `server-only`, no database, no `Date.now()`.
 * The accounting lives here so it can be tested without a database, and
 * the I/O lives in `server/inventory/valuation-service.ts`.
 */

/* ------------------------------------------------------------------ */
/* THE METHODS                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ MIRRORS `valuationMethodEnum` IN `db/schema/inventory.ts` BY HAND.
 * Importing the schema would drag Drizzle into a pure module. The cost
 * of the duplication is one line; `assertKnownMethod` below refuses any
 * value it does not recognise BY NAME, so a fifth enum member added to
 * the database and not to this list fails loudly at the first movement
 * rather than silently valuing on some default.
 */
export const VALUATION_METHODS = [
  "fifo",
  "weighted_average",
  "specific",
  "standard",
] as const;

export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export class ValuationError extends Error {}

/**
 * 🔴 REFUSING BY NAME, WHICH IS THE WHOLE POINT OF THE BATCH. The defect
 * being closed here is a control that fell through to a default. An
 * unknown method must therefore never fall through to weighted average —
 * it must say which method it does not know.
 */
export function assertKnownMethod(method: string): asserts method is ValuationMethod {
  if (!(VALUATION_METHODS as readonly string[]).includes(method)) {
    throw new ValuationError(
      `"${method}" is not a valuation method this engine implements. It knows ${VALUATION_METHODS.join(", ")}. Nothing has been valued — fix the item's method rather than accepting a default.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* QUANTITY — STRINGS IN, BIGINT THOUSANDTHS INSIDE                    */
/* ------------------------------------------------------------------ */

/** Thousandths per stocking unit. `numeric(18,3)` and nothing else. */
export const QTY_SCALE = 1000n;

/**
 * ⚠️ PARSED AS TEXT, NOT VIA `Number`. "12.5" tonnes through a float and
 * back is 12.499999999999998, and a delivery challan that does not add
 * up is an argument with a customer that we lose on our own paperwork.
 */
export function parseQuantity(text: string): bigint {
  const m = /^\s*(-?)(\d{1,18})(?:\.(\d{0,3}))?\s*$/.exec(text);
  if (!m) {
    throw new ValuationError(
      `"${text}" is not a quantity this ledger can hold — up to three decimals, no exponent.`,
    );
  }
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = BigInt(m[2] ?? "0");
  const frac = BigInt((m[3] ?? "").padEnd(3, "0"));
  return sign * (whole * QTY_SCALE + frac);
}

/** Back to the `numeric(18,3)` text the database and the UI both expect. */
export function formatQuantity(qty: bigint): string {
  const neg = qty < 0n;
  const abs = neg ? -qty : qty;
  const frac = (abs % QTY_SCALE).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${abs / QTY_SCALE}.${frac}`;
}

/**
 * ⭐ `a * b / d` WITH THE SIGN HANDLED EXPLICITLY.
 *
 * ⚠️ BigInt division TRUNCATES TOWARD ZERO, so `-7n / 2n` is `-3n`, not
 * the `-4n` a floor gives. On a shortfall layer (negative quantity,
 * negative value) that difference changes which side of zero a paisa
 * lands on. Doing the arithmetic on magnitudes and re-applying the sign
 * makes the answer independent of the sign, which is what "the same
 * movements give the same answer" requires.
 *
 * Returns the quotient AND the remainder, because the remainder is never
 * discarded here — the caller decides where it goes and every caller
 * below leaves it in the layer.
 */
export function mulDiv(
  a: bigint,
  b: bigint,
  d: bigint,
): { quotient: bigint; remainder: bigint } {
  if (d === 0n) throw new ValuationError("A cost cannot be divided by a zero quantity.");
  const negative = a < 0n !== b < 0n !== d < 0n;
  const A = a < 0n ? -a : a;
  const B = b < 0n ? -b : b;
  const D = d < 0n ? -d : d;
  const q = (A * B) / D;
  const r = A * B - q * D;
  return { quotient: negative ? -q : q, remainder: r };
}

/* ------------------------------------------------------------------ */
/* INPUTS                                                              */
/* ------------------------------------------------------------------ */

/**
 * One row of `stock_movements`, reduced to what valuation cares about.
 *
 * ⚠️ `quantity` IS SIGNED — inward positive, outward negative — exactly
 * as the ledger stores it. There is no direction flag to disagree with
 * it.
 */
export type ValuationMovement = {
  id: string;
  /** ISO-8601. The primary sort key; `id` breaks ties. */
  movedAt: string;
  /** Signed, in thousandths. */
  quantity: bigint;
  /** Per whole unit, paise. Inward only; meaningless on an issue. */
  unitCostMinor: bigint | null;
  /**
   * ⭐ THE RECEIPT'S ACTUAL TOTAL, WHEN A DOCUMENT STATES IT. Preferred
   * over unitCost × quantity, because the purchase invoice line is the
   * fact and the unit rate on it is already a rounded quotient.
   */
  valueMinor?: bigint | null;
  reason: string;
  batchNo?: string | null;
};

/**
 * ⭐ A CHARGE THAT ARRIVES AFTER THE GOODS. Freight, clearing, insurance
 * — already apportioned to ONE receipt line by `lib/inventory/
 * landed-cost.ts`, and handed here to be attached to the layer that
 * receipt created.
 */
export type LandedCostAttachment = {
  id: string;
  /** The receipt movement whose layer this charge belongs to. */
  attachesToMovementId: string;
  /** Positive paise. This is the share for that one line, not the bill. */
  amountMinor: bigint;
  /** ISO-8601 date the charge is recognised. NOT the receipt's date. */
  atDate: string;
};

/**
 * ⭐ A PERIOD THAT HAS BEEN CLOSED. Replaying history through a closed
 * month is fine — reproducing a number is not changing it. Producing a
 * NEW posting dated inside one is not, and that is what this refuses.
 */
export type ClosedPeriod = { name: string; startDate: string; endDate: string };

export class PeriodClosedError extends ValuationError {}

/**
 * 🔴 THE GUARD. `ordence_guard_closed_period` and the
 * `transactions_period_lock` trigger stop a JOURNAL reaching a closed
 * month. They cannot stop a valuation run from CAPITALISING a freight
 * bill into March after March was filed, because that write goes to a
 * stock layer, not to `transactions`. So the same rule is restated here,
 * in the engine, where the decision is actually taken.
 */
export function assertPostable(
  onDate: string,
  closedPeriods: readonly ClosedPeriod[] | undefined,
  what: string,
): void {
  for (const p of closedPeriods ?? []) {
    if (onDate >= p.startDate && onDate <= p.endDate) {
      throw new PeriodClosedError(
        `${what} is dated ${onDate}, which falls in "${p.name}" — a closed period. Revaluing a closed month silently changes a P&L that has been signed and filed. Post it in the open period, or reopen "${p.name}" deliberately.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* WARNINGS — EVERY STATE CARRIES A WORD                               */
/* ------------------------------------------------------------------ */

export type ValuationWarningCode =
  /** Issued from stock that has not been received yet. Costed provisionally. */
  | "NEGATIVE_STOCK_PROVISIONAL"
  /** The receipt arrived; the provisional cost has been corrected. */
  | "NEGATIVE_STOCK_TRUE_UP"
  /** Issued before ANY receipt ever. There is no cost to guess from. */
  | "NO_COST_EVIDENCE"
  /** An inward movement carries no cost. Not back-computed. */
  | "MISSING_RECEIPT_COST"
  /** A movement older than the engine. Its layer is stated, not derived. */
  | "PREDATES_ENGINE"
  /** A landed cost arrived after the goods were sold. Split to COGS. */
  | "LANDED_COST_AFTER_CONSUMPTION"
  /** Standard cost method, and a receipt differed from standard. */
  | "PURCHASE_PRICE_VARIANCE";

export type ValuationWarning = {
  code: ValuationWarningCode;
  movementId: string | null;
  message: string;
  amountMinor?: bigint;
};

/* ------------------------------------------------------------------ */
/* THE LAYERS                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE AUDITOR'S WORKING, AND IT IS THE POINT OF THE WHOLE FILE. A
 * total nobody can take apart is a total nobody can check.
 *
 * ⚠️ `qtyRemaining` MAY BE NEGATIVE. That is a SHORTFALL layer: goods
 * issued before their receipt was entered. See `runValuation`.
 */
export type CostLayer = {
  /** The receipt movement that created it — the layer's evidence. */
  layerId: string;
  receivedAt: string;
  batchNo: string | null;
  qtyOriginal: bigint;
  valueOriginal: bigint;
  qtyRemaining: bigint;
  valueRemaining: bigint;
  /** Costed from evidence rather than from a document. Trued up later. */
  provisional: boolean;
  /** Landed cost added to this layer after it was received. */
  landedCostMinor: bigint;
};

/** Which layers one issue took, and what each contributed. */
export type LayerConsumption = {
  layerId: string;
  qty: bigint;
  valueMinor: bigint;
};

export type ValuedMovement = {
  movementId: string;
  movedAt: string;
  quantity: bigint;
  /**
   * ⭐ SIGNED THE SAME WAY THE QUANTITY IS: positive adds value to
   * stock, negative removes it. Closing value is then simply the sum,
   * with no CASE for anybody to get backwards.
   */
  valueMinor: bigint;
  /** COGS, positive, on an outward movement. Zero on a receipt. */
  cogsMinor: bigint;
  consumption: LayerConsumption[];
};

export type ValuationRun = {
  method: ValuationMethod;
  openingQuantity: bigint;
  openingValueMinor: bigint;
  receiptsValueMinor: bigint;
  /** Positive. The total charged out — COGS plus write-offs. */
  issuesValueMinor: bigint;
  closingQuantity: bigint;
  closingValueMinor: bigint;
  layers: CostLayer[];
  movements: ValuedMovement[];
  /**
   * ⭐ WHERE THE ROUNDING WENT, AND IT HAS A NAME. Sub-paise dropped
   * turning a unit rate into a layer value. It is not COGS and it is not
   * stock; it is the fraction of a paisa that a rate × quantity produced
   * and no coin can hold. Reported so that "the ledger foots and here is
   * the crumb" is a sentence somebody can say to an auditor.
   */
  subPaiseDiscardedMinor: bigint;
  /** Standard cost only: actual receipt cost less standard. */
  purchasePriceVarianceMinor: bigint;
  /** Correction of provisional costs once the real receipt arrived. */
  negativeStockTrueUpMinor: bigint;
  /** Landed cost that landed on goods already sold. */
  landedCostToCogsMinor: bigint;
  landedCostToStockMinor: bigint;
  warnings: ValuationWarning[];
  /**
   * 🔴 FALSE MEANS DO NOT PUT THIS NUMBER IN A STATEMENT WITHOUT READING
   * THE WARNINGS. Something was missing and the engine refused to invent
   * it rather than producing a confident wrong figure.
   */
  complete: boolean;
};

/* ------------------------------------------------------------------ */
/* THE ENGINE                                                          */
/* ------------------------------------------------------------------ */

export type ValuationInput = {
  method: string;
  movements: readonly ValuationMovement[];
  /**
   * ⭐ THE STATED OPENING LAYER. Movements older than the engine were
   * recorded without a cost, and back-computing a history that was never
   * kept is fabrication. So the caller may STATE the opening position —
   * from the audited balance sheet — and the engine treats it as one
   * layer of evidence with a date, rather than pretending to derive it.
   */
  opening?: { qty: bigint; valueMinor: bigint; asAt: string } | undefined;
  /** Required when `method` is "standard". Paise per whole unit. */
  standardCostMinor?: bigint | null | undefined;
  landedCosts?: readonly LandedCostAttachment[] | undefined;
  closedPeriods?: readonly ClosedPeriod[] | undefined;
};

/** Inward if the signed quantity says so. The reason is not consulted. */
const isInward = (m: ValuationMovement): boolean => m.quantity > 0n;

/**
 * ⭐⭐⭐ REPLAY THE LEDGER AND PRODUCE THE LAYERS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NEGATIVE STOCK, WHICH IS THE HARD CASE AND HAPPENS CONSTANTLY
 * ══════════════════════════════════════════════════════════════════════
 * The lorry is unloaded at the site on Monday, the bags are issued to
 * the slab on Tuesday, and the purchase invoice is entered the following
 * week. The system is asked to issue from a layer that does not exist
 * yet, and this is not a rare corner — in an Indian SMB it is the normal
 * shape of the month.
 *
 * ⚠️ REFUSING THE ISSUE IS THE WRONG ANSWER. The goods physically left.
 * A system that will not record what happened does not stop it
 * happening; it stops the record matching it, and then the stock ledger
 * and the site are two different stories.
 *
 * ⭐ SO THE ISSUE IS ACCEPTED AND A SHORTFALL LAYER IS OPENED: a layer
 * with a NEGATIVE quantity and a negative value, costed at the best
 * evidence available — the last cost this item was received at. It is
 * marked `provisional`, so nobody can mistake it for a document.
 *
 * ⭐ WHEN THE RECEIPT ARRIVES it fills the shortfall FIRST, at its real
 * cost, and the difference between the provisional cost charged out and
 * the real one is emitted as `NEGATIVE_STOCK_TRUE_UP` — a named, dated
 * correction in the period the invoice arrived, which is exactly where a
 * closed-period rule wants it. The provisional rounding therefore does
 * not survive; it is corrected in full by a later document.
 *
 * ⚠️ AND IF THERE IS NO EVIDENCE AT ALL — the item's first ever movement
 * is an issue — the engine does NOT guess. The issue is costed at zero,
 * `NO_COST_EVIDENCE` is raised naming the movement, and `complete` goes
 * false. A stated gap beats a confident wrong number. The true-up on the
 * eventual receipt still lands the whole cost, so the total is right by
 * the time there is a document to make it right with.
 */
export function runValuation(input: ValuationInput): ValuationRun {
  assertKnownMethod(input.method);
  const method: ValuationMethod = input.method;

  if (method === "standard" && (input.standardCostMinor ?? null) === null) {
    throw new ValuationError(
      'This item is on the "standard" valuation method but carries no standard cost. Standard costing values every issue at the standard and books the difference as a purchase price variance — with no standard there is no rate to value at and no variance to book. Set the standard cost, or move the item to FIFO or weighted average.',
    );
  }
  const standard = input.standardCostMinor ?? 0n;

  const warnings: ValuationWarning[] = [];
  const layers: CostLayer[] = [];
  const valued: ValuedMovement[] = [];

  let subPaise = 0n;
  let variance = 0n;
  let trueUp = 0n;
  let landedToCogs = 0n;
  let landedToStock = 0n;
  let receipts = 0n;
  let issues = 0n;
  let complete = true;

  /**
   * ⭐ THE OPENING LAYER IS STATED, NOT DERIVED. If it is present it
   * sorts before everything, because it IS everything that came before.
   */
  const openingQty = input.opening?.qty ?? 0n;
  const openingValue = input.opening?.valueMinor ?? 0n;
  if (input.opening && (openingQty !== 0n || openingValue !== 0n)) {
    layers.push({
      layerId: "opening",
      receivedAt: input.opening.asAt,
      batchNo: null,
      qtyOriginal: openingQty,
      valueOriginal: openingValue,
      qtyRemaining: openingQty,
      valueRemaining: openingValue,
      provisional: false,
      landedCostMinor: 0n,
    });
  }

  /**
   * 🔴 DETERMINISTIC ORDER OR IT IS NOT REPRODUCIBLE. Two receipts at
   * the same timestamp must consume in the same order every run, or FIFO
   * gives a different COGS on Tuesday than it gave on Monday from
   * identical data — and then no auditor can re-perform it.
   */
  const ordered = [...input.movements].sort((a, b) =>
    a.movedAt === b.movedAt
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.movedAt < b.movedAt
        ? -1
        : 1,
  );

  /** Landed costs are folded into the timeline at their OWN date. */
  const landed = [...(input.landedCosts ?? [])].sort((a, b) =>
    a.atDate === b.atDate ? (a.id < b.id ? -1 : 1) : a.atDate < b.atDate ? -1 : 1,
  );
  let landedCursor = 0;

  /**
   * ⭐ THE LAST COST WE HAVE SEEN, kept as a total-over-quantity pair
   * rather than a rounded rate, so that costing a shortfall from it does
   * not round twice.
   */
  let lastCostQty = openingQty > 0n ? openingQty : 0n;
  let lastCostValue = openingQty > 0n ? openingValue : 0n;

  const applyLandedUpTo = (boundary: string): void => {
    while (landedCursor < landed.length) {
      const lc = landed[landedCursor];
      if (!lc || lc.atDate > boundary) break;
      landedCursor += 1;
      applyLanded(lc);
    }
  };

  /**
   * ⭐⭐ A LANDED COST REVALUES THE LAYER IT ATTACHES TO, and only the
   * part of it still on hand.
   *
   * 🔴 Adding the whole charge to what is left overstates closing stock
   * AND overstates the margin already reported — two errors in opposite
   * directions whose total is right, so nothing looks odd on the face of
   * the accounts. The share belonging to units already sold is COGS of
   * the period the charge is recognised in, and it is reported
   * separately so somebody can post it.
   */
  function applyLanded(lc: LandedCostAttachment): void {
    assertPostable(lc.atDate, input.closedPeriods, `Landed cost ${lc.id}`);
    const layer = layers.find((l) => l.layerId === lc.attachesToMovementId);
    if (!layer) {
      throw new ValuationError(
        `Landed cost ${lc.id} attaches to receipt ${lc.attachesToMovementId}, which is not a layer in this valuation. A charge with nothing to capitalise into cannot be allocated — check the receipt is in the same item and warehouse.`,
      );
    }
    if (layer.qtyOriginal <= 0n) {
      throw new ValuationError(
        `Landed cost ${lc.id} attaches to ${layer.layerId}, which received no quantity. There is nothing to spread it over.`,
      );
    }
    /**
     * ⚠️ SPLIT BY QUANTITY, DIVIDED ONCE. The remainder paisa goes to
     * stock rather than to COGS — deliberately, and stated: it is
     * attached to units we still hold, so it stays with them, and it is
     * released when they are issued. The two shares always add back to
     * the charge, so the freight bill is fully accounted for.
     */
    const onHand = layer.qtyRemaining > 0n ? layer.qtyRemaining : 0n;
    const { quotient: toStock } = mulDiv(lc.amountMinor, onHand, layer.qtyOriginal);
    const toCogs = lc.amountMinor - toStock;
    layer.valueRemaining += toStock;
    layer.valueOriginal += lc.amountMinor;
    layer.landedCostMinor += lc.amountMinor;
    landedToStock += toStock;
    landedToCogs += toCogs;
    /**
     * ⚠️ THE WHOLE CHARGE IS A RECEIPT OF VALUE and the consumed share
     * is charged straight back out, rather than only the stock share
     * being recognised. Both halves then appear in the footing, which is
     * what lets somebody see freight in the movement of the ledger
     * instead of finding it only in the closing figure.
     */
    receipts += lc.amountMinor;
    if (toCogs > 0n) {
      issues += toCogs;
      warnings.push({
        code: "LANDED_COST_AFTER_CONSUMPTION",
        movementId: layer.layerId,
        amountMinor: toCogs,
        message: `${toCogs} paise of landed cost ${lc.id} belongs to units from receipt ${layer.layerId} that were already issued. It is cost of sales in the period dated ${lc.atDate}, not closing stock — post it there or gross profit already reported is overstated.`,
      });
    }
  }

  /* ---------------- LAYER SELECTION, PER METHOD ------------------- */

  /**
   * ⭐ THIS IS THE ONLY PLACE THE METHOD CHANGES THE ANSWER, and that is
   * the design: one replay, four consumption policies.
   *
   * - fifo             — oldest layer first.
   * - weighted_average — every receipt merges into ONE pool layer, so
   *                      "oldest first" over a single layer IS the
   *                      running average, recomputed at each receipt by
   *                      construction rather than by a separate formula.
   * - specific         — the layer whose batch the issue names, and no
   *                      other. An issue with no batch is refused.
   * - standard         — layers are held AT STANDARD; the difference on
   *                      receipt is variance, taken at receipt.
   */
  const POOL = "weighted-average-pool";

  function pickLayers(m: ValuationMovement): CostLayer[] {
    const live = layers.filter((l) => l.qtyRemaining > 0n);
    if (method === "specific") {
      const wanted = m.batchNo ?? null;
      if (!wanted) {
        throw new ValuationError(
          `Movement ${m.id} issues stock from an item valued by specific identification, but names no batch. Specific identification costs the exact unit that left; without the batch there is no way to know which cost went with it, and picking one would be inventing the answer. Record the batch on the issue.`,
        );
      }
      return live.filter((l) => l.batchNo === wanted);
    }
    if (method === "weighted_average") return live.filter((l) => l.layerId === POOL);
    /** FIFO and standard both consume oldest-first; `layers` is in order. */
    return live;
  }

  /** The pool layer for weighted average, created on first sight. */
  function poolLayer(at: string): CostLayer {
    let p = layers.find((l) => l.layerId === POOL);
    if (!p) {
      p = {
        layerId: POOL,
        receivedAt: at,
        batchNo: null,
        qtyOriginal: 0n,
        valueOriginal: 0n,
        qtyRemaining: 0n,
        valueRemaining: 0n,
        provisional: false,
        landedCostMinor: 0n,
      };
      layers.push(p);
    }
    return p;
  }

  /* ------------------------- THE REPLAY ---------------------------- */

  for (const m of ordered) {
    applyLandedUpTo(m.movedAt);

    if (isInward(m)) {
      /* ---------------- RECEIPT ---------------------------------- */
      let value: bigint;
      if (m.valueMinor !== undefined && m.valueMinor !== null) {
        value = m.valueMinor;
      } else if (m.unitCostMinor !== null) {
        const { quotient, remainder } = mulDiv(m.unitCostMinor, m.quantity, QTY_SCALE);
        value = quotient;
        subPaise += remainder;
      } else {
        /**
         * 🔴 NOT BACK-COMPUTED. A receipt with no cost is a receipt
         * whose cost was never recorded — usually a movement that
         * predates this engine. Deriving one from a later average would
         * put a number in the accounts that no document supports.
         */
        value = 0n;
        complete = false;
        warnings.push({
          code: "MISSING_RECEIPT_COST",
          movementId: m.id,
          message: `Receipt ${m.id} dated ${m.movedAt} carries no cost. It has been taken in at zero rather than valued from a later average — the closing stock is understated by whatever that receipt actually cost, and no figure here should be filed until it is entered.`,
        });
      }

      if (method === "standard") {
        /**
         * ⭐ STANDARD COSTING TAKES STOCK IN AT STANDARD AND BOOKS THE
         * DIFFERENCE IMMEDIATELY. That is the entire reason a business
         * chooses it: the variance is visible in the month it arose
         * instead of being buried in the closing valuation.
         */
        const { quotient: atStandard, remainder } = mulDiv(standard, m.quantity, QTY_SCALE);
        subPaise += remainder;
        const v = value - atStandard;
        if (v !== 0n) {
          variance += v;
          warnings.push({
            code: "PURCHASE_PRICE_VARIANCE",
            movementId: m.id,
            amountMinor: v,
            message: `Receipt ${m.id} cost ${value} paise against a standard of ${atStandard}. The ${v > 0n ? "excess" : "saving"} of ${v > 0n ? v : -v} paise is a purchase price variance of the period, not part of closing stock.`,
          });
        }
        value = atStandard;
      }

      receipts += value;
      lastCostQty = m.quantity;
      lastCostValue = value;

      let remainingQty = m.quantity;
      let remainingValue = value;

      /**
       * ⭐ THE RECEIPT FILLS ANY SHORTFALL FIRST, AND THIS IS THE TRUE-UP.
       * The shortfall layer holds the provisional cost that was already
       * charged to COGS. Replacing it with the real cost for the same
       * quantity produces a correction, dated at the receipt.
       */
      const shortfall = layers.find(
        (l) =>
          l.qtyRemaining < 0n &&
          (method === "weighted_average"
            ? l.layerId === POOL
            : method === "specific"
              ? l.batchNo === (m.batchNo ?? null)
              : true),
      );
      if (shortfall && remainingQty > 0n) {
        const owed = -shortfall.qtyRemaining;
        const fill = owed < remainingQty ? owed : remainingQty;
        /** What the shortfall had charged out for exactly this quantity. */
        const { quotient: provisionalPart } = mulDiv(
          shortfall.valueRemaining,
          fill,
          shortfall.qtyRemaining,
        );
        /** What it really cost, from the document that has now arrived. */
        const { quotient: actualPart } = mulDiv(remainingValue, fill, remainingQty);
        /**
         * ⚠️ SIGNS: the shortfall's quantity and value are both
         * negative, so their ratio is POSITIVE — `provisionalPart` is
         * the magnitude already charged to cost of sales. The correction
         * is what the goods really cost, less what was charged.
         */
        const correction = actualPart - provisionalPart;
        if (correction !== 0n) {
          trueUp += correction;
          issues += correction;
          warnings.push({
            code: "NEGATIVE_STOCK_TRUE_UP",
            movementId: m.id,
            amountMinor: correction,
            message: `Receipt ${m.id} settles ${formatQuantity(fill)} units that had already been issued at a provisional cost. Cost of sales moves by ${correction} paise, dated ${m.movedAt} — the period the invoice arrived in, because the period the goods left in may already be closed.`,
          });
        }
        shortfall.qtyRemaining += fill;
        shortfall.valueRemaining += provisionalPart;
        remainingQty -= fill;
        remainingValue -= actualPart;
        /**
         * ⭐ SETTLED IN FULL LANDS EXACTLY ON ZERO — `fill` equals the
         * whole owed quantity, so the ratio is exact and no paisa is
         * stranded in a layer that no longer holds any units.
         */
        if (shortfall.qtyRemaining === 0n) shortfall.provisional = false;
      }

      if (remainingQty > 0n) {
        if (method === "weighted_average") {
          const p = poolLayer(m.movedAt);
          p.qtyOriginal += remainingQty;
          p.valueOriginal += remainingValue;
          p.qtyRemaining += remainingQty;
          p.valueRemaining += remainingValue;
        } else {
          layers.push({
            layerId: m.id,
            receivedAt: m.movedAt,
            batchNo: m.batchNo ?? null,
            qtyOriginal: remainingQty,
            valueOriginal: remainingValue,
            qtyRemaining: remainingQty,
            valueRemaining: remainingValue,
            provisional: false,
            landedCostMinor: 0n,
          });
        }
      }

      valued.push({
        movementId: m.id,
        movedAt: m.movedAt,
        quantity: m.quantity,
        valueMinor: value,
        cogsMinor: 0n,
        consumption: [],
      });
      continue;
    }

    /* ------------------------- ISSUE ---------------------------- */
    let need = -m.quantity;
    let cost = 0n;
    const taken: LayerConsumption[] = [];

    /**
     * ⭐⭐ THE CUMULATIVE DIVISION, AND IT IS WHY A PER-LINE ROUNDING
     * CANNOT BREAK THE TOTAL UNDER STANDARD COSTING.
     *
     * ⚠️ Rounding `standard × take` for each layer separately and adding
     * the pieces gives a sum of floors, which is up to one paisa per
     * layer BELOW the floor of the sum. Three layers, three paise, and
     * the ledger no longer foots. Instead the running total is divided
     * once at each step and each layer gets the DIFFERENCE — so the
     * pieces always add to the single division of the whole.
     */
    let cumQty = 0n;
    let cumVal = 0n;
    const releaseAtStandard = (take: bigint): bigint => {
      cumQty += take;
      const { quotient } = mulDiv(standard, cumQty, QTY_SCALE);
      const rel = quotient - cumVal;
      cumVal = quotient;
      return rel;
    };

    if (method === "standard") {
      /** Every issue leaves at the standard. That is the method. */
      subPaise += mulDiv(standard, need, QTY_SCALE).remainder;
      for (const l of pickLayers(m)) {
        if (need <= 0n) break;
        const take = l.qtyRemaining < need ? l.qtyRemaining : need;
        const rel = releaseAtStandard(take);
        l.qtyRemaining -= take;
        l.valueRemaining -= rel;
        need -= take;
        cost += rel;
        taken.push({ layerId: l.layerId, qty: take, valueMinor: rel });
      }
    } else {
      for (const l of pickLayers(m)) {
        if (need <= 0n) break;
        const take = l.qtyRemaining < need ? l.qtyRemaining : need;
        /**
         * ⭐ DIVIDE ONCE, HERE. The floor's remainder stays in
         * `valueRemaining`, attached to the units it belongs to, so
         * consuming a layer to zero always releases exactly what it
         * came in at.
         */
        const { quotient: rel } = mulDiv(l.valueRemaining, take, l.qtyRemaining);
        const released = take === l.qtyRemaining ? l.valueRemaining : rel;
        l.qtyRemaining -= take;
        l.valueRemaining -= released;
        need -= take;
        cost += released;
        taken.push({ layerId: l.layerId, qty: take, valueMinor: released });
      }
    }

    if (need > 0n) {
      /* ------------- NEGATIVE STOCK ---------------------------- */
      const key =
        method === "weighted_average"
          ? POOL
          : method === "specific"
            ? `shortfall:${m.batchNo ?? ""}`
            : `shortfall:${m.id}`;
      let sl = layers.find((l) => l.layerId === key);
      if (!sl) {
        sl = {
          layerId: key,
          receivedAt: m.movedAt,
          batchNo: m.batchNo ?? null,
          qtyOriginal: 0n,
          valueOriginal: 0n,
          qtyRemaining: 0n,
          valueRemaining: 0n,
          provisional: true,
          landedCostMinor: 0n,
        };
        layers.push(sl);
      }
      sl.provisional = true;

      let provisional: bigint;
      if (method === "standard") {
        provisional = releaseAtStandard(need);
      } else if (lastCostQty > 0n) {
        const { quotient } = mulDiv(lastCostValue, need, lastCostQty);
        provisional = quotient;
        warnings.push({
          code: "NEGATIVE_STOCK_PROVISIONAL",
          movementId: m.id,
          amountMinor: provisional,
          message: `Movement ${m.id} issues ${formatQuantity(need)} units that have not been received yet. The goods left, so the issue stands; it is costed provisionally at the last cost seen and corrected in full when the purchase invoice is entered.`,
        });
      } else {
        /**
         * 🔴 NOTHING TO GO ON, SO NOTHING IS INVENTED. Zero is visibly
         * wrong, which is the intention — a plausible guess would not be.
         */
        provisional = 0n;
        complete = false;
        warnings.push({
          code: "NO_COST_EVIDENCE",
          movementId: m.id,
          message: `Movement ${m.id} issues ${formatQuantity(need)} units of an item that has never been received at a known cost. There is no evidence to value it from, so it is carried at nil and cost of sales is understated by that amount until the purchase is entered. Do not file a figure that includes this line.`,
        });
      }

      sl.qtyRemaining -= need;
      sl.valueRemaining -= provisional;
      cost += provisional;
      taken.push({ layerId: sl.layerId, qty: need, valueMinor: provisional });
      need = 0n;
    }

    issues += cost;
    valued.push({
      movementId: m.id,
      movedAt: m.movedAt,
      quantity: m.quantity,
      valueMinor: -cost,
      cogsMinor: cost,
      consumption: taken,
    });
  }

  /** Anything dated after the last movement still has to be applied. */
  applyLandedUpTo("9999-12-31");

  const closingQuantity = layers.reduce((s, l) => s + l.qtyRemaining, 0n);
  const closingValueMinor = layers.reduce((s, l) => s + l.valueRemaining, 0n);

  /**
   * 🔴 THE FOOTING CHECK, AND IT THROWS. Opening + receipts − issues =
   * closing, in exact paise. If this ever fails the engine has produced
   * a stock ledger that does not add up, and returning it would put that
   * figure into a balance sheet. Better a loud failure than a quiet one.
   *
   * ⚠️ The opening layer is inside `layers`, so it is already in
   * `closingValueMinor`; it is NOT in `receipts`. Hence it appears on
   * the left of the identity on its own.
   */
  const foots = openingValue + receipts - issues;
  if (foots !== closingValueMinor) {
    throw new ValuationError(
      `The stock ledger does not foot: opening ${openingValue} + receipts ${receipts} − issues ${issues} = ${foots}, but the layers hold ${closingValueMinor}. This is an engine defect, not a data problem, and no valuation has been returned.`,
    );
  }

  return {
    method,
    openingQuantity: openingQty,
    openingValueMinor: openingValue,
    receiptsValueMinor: receipts,
    issuesValueMinor: issues,
    closingQuantity,
    closingValueMinor,
    layers,
    movements: valued,
    subPaiseDiscardedMinor: subPaise,
    purchasePriceVarianceMinor: variance,
    negativeStockTrueUpMinor: trueUp,
    landedCostToCogsMinor: landedToCogs,
    landedCostToStockMinor: landedToStock,
    warnings,
    complete,
  };
}

/**
 * ⭐ WHAT ONE PROPOSED ISSUE WOULD COST, given everything before it.
 *
 * ⚠️ IT REPLAYS RATHER THAN CACHING. A cached running cost is a number
 * that drifts from the ledger the first time a movement is backdated or
 * reversed, and inventory corrections are backdated all the time. The
 * replay is the same code that produces the audit working, so the cost
 * written on a movement and the cost an auditor recomputes cannot differ.
 */
export function costProposedIssue(
  input: ValuationInput & { proposed: ValuationMovement },
): { valueMinor: bigint; cogsMinor: bigint; run: ValuationRun } {
  const run = runValuation({
    ...input,
    movements: [...input.movements, input.proposed],
  });
  const line = run.movements.find((v) => v.movementId === input.proposed.id);
  if (!line) {
    throw new ValuationError(
      "The proposed movement did not appear in the replay. Nothing has been costed.",
    );
  }
  return { valueMinor: line.valueMinor, cogsMinor: line.cogsMinor, run };
}
