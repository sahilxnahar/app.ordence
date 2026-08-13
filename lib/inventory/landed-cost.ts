/**
 * Ordence — ⭐⭐ WHAT THE GOODS ACTUALLY COST
 * Version: v1.5.0-alpha
 *
 * Pure. No database, no clock. Integer paise throughout.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ Ind AS 2 / AS 2: the cost of purchase is
 *
 *     "the purchase price, import duties and other taxes (OTHER THAN
 *      THOSE SUBSEQUENTLY RECOVERABLE BY THE ENTITY FROM THE TAXING
 *      AUTHORITIES), and transport, handling and other costs directly
 *      attributable to the acquisition"
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PARENTHESIS SPLITS TWO CHARGES ON ONE CUSTOMS DOCUMENT
 * ══════════════════════════════════════════════════════════════════════
 *     Basic Customs Duty  → NOT recoverable → part of inventory cost
 *     IGST on imports     → recoverable     → NOT part of it
 *
 * ⚠️ They arrive on the same bill of entry, in adjacent boxes, and
 * capitalising the IGST does two wrong things at once: it inflates
 * closing stock AND loses the input credit. The balance sheet still
 * balances, which is why nobody notices.
 */

/* ------------------------------------------------------------------ */
/* THE CHARGE TYPES                                                    */
/* ------------------------------------------------------------------ */

export class LandedCostError extends Error {}

export type ApportionBasis = "value" | "quantity" | "weight" | "volume" | "equal";

export type LandedCostType =
  | "freight_inward"
  | "insurance"
  | "customs_duty"
  | "customs_igst"
  | "clearing_forwarding"
  | "loading_unloading"
  | "inspection"
  | "octroi_entry_tax"
  | "other";

export const LANDED_COST_TYPES: Record<
  LandedCostType,
  {
    label: string;
    /** 🔴 Recoverable means it is a credit, not a cost. */
    recoverable: boolean;
    defaultBasis: ApportionBasis;
    note: string;
  }
> = {
  freight_inward: {
    label: "Inward freight",
    recoverable: false,
    /**
     * ⚠️ BY WEIGHT, NOT BY VALUE. A lorry charges for what it carries,
     * not for what it is worth — a container of feathers and lead
     * apportioned by value gives the lead almost no freight, which is
     * the exact opposite of what the lorry did.
     */
    defaultBasis: "weight",
    note: "Part of cost under Ind AS 2. Apportion by weight where you have it — a lorry charges for mass, not for value.",
  },
  insurance: {
    label: "Transit insurance",
    recoverable: false,
    /** ⭐ Insurance genuinely IS priced on value, so value is right here. */
    defaultBasis: "value",
    note: "Priced on the value insured, so value is the correct basis.",
  },
  customs_duty: {
    label: "Basic customs duty",
    recoverable: false,
    defaultBasis: "value",
    note: "🔴 NOT recoverable — BCD is a cost and belongs in inventory. This is the half of a bill of entry that gets capitalised.",
  },
  customs_igst: {
    label: "IGST on imports",
    /** 🔴 THE ONE EVERYBODY CAPITALISES BY ACCIDENT. */
    recoverable: true,
    defaultBasis: "value",
    note: "🔴 RECOVERABLE — this is an input tax credit, not a cost. It arrives on the same bill of entry as the duty above and must NOT go into inventory. Capitalising it inflates stock and loses the credit.",
  },
  clearing_forwarding: {
    label: "Clearing & forwarding",
    recoverable: false,
    defaultBasis: "value",
    note: "Directly attributable to acquisition, so it is part of cost.",
  },
  loading_unloading: {
    label: "Loading & unloading",
    recoverable: false,
    defaultBasis: "weight",
    note: "Handling cost. Part of cost under Ind AS 2.",
  },
  inspection: {
    label: "Inspection & testing",
    recoverable: false,
    defaultBasis: "quantity",
    note: "Part of cost where it is required to bring the goods to their present condition.",
  },
  octroi_entry_tax: {
    label: "Octroi / entry tax",
    recoverable: false,
    defaultBasis: "value",
    note: "Not recoverable, so it is a cost.",
  },
  other: {
    label: "Other",
    recoverable: false,
    defaultBasis: "value",
    note: "⚠️ Check it is directly attributable to acquisition. Storage after receipt, administrative overhead and anything to do with selling are NOT part of inventory cost — Ind AS 2 excludes all three by name.",
  },
};

/* ------------------------------------------------------------------ */
/* APPORTIONMENT                                                       */
/* ------------------------------------------------------------------ */

export type ApportionInput = {
  key: string;
  /** The figure this line contributes to the basis — value, kg, units. */
  basis: bigint;
};

export type ApportionOutput = {
  key: string;
  basis: bigint;
  allocatedMinor: bigint;
};

/**
 * ⭐⭐ SPREAD ONE CHARGE ACROSS SEVERAL LINES, EXACTLY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE LARGEST-REMAINDER METHOD, AND WHY IT IS NOT OPTIONAL
 * ══════════════════════════════════════════════════════════════════════
 * ₹10,000 of freight across three lines in the ratio 1:1:1 is
 * ₹3,333.33 each — which is ₹9,999.99. The missing paisa has to land
 * somewhere, and "somewhere" cannot be nowhere: the total capitalised
 * must equal the invoice that was paid, or the ledger does not balance
 * and the difference is a rounding error nobody can trace to a document.
 *
 * ⭐ So each line gets its floor, and the remaining paise go to the
 * lines with the largest fractional parts — one paisa each, biggest
 * first. The result **always sums to the total, exactly**, and it is
 * deterministic: the same input gives the same answer every run, which
 * matters because somebody will re-run this and compare.
 *
 * ⚠️ AND A ZERO BASIS IS NOT AN ERROR. A free sample line on a purchase
 * invoice has no value, and it should carry no freight — but it must not
 * make the whole apportionment fail.
 */
export function apportion(args: {
  totalMinor: bigint;
  lines: readonly ApportionInput[];
  basisName?: string;
}): ApportionOutput[] {
  if (args.totalMinor < 0n) {
    throw new LandedCostError("A charge to apportion cannot be negative.");
  }
  if (args.lines.length === 0) {
    throw new LandedCostError("There are no lines to apportion this charge across.");
  }
  for (const l of args.lines) {
    if (l.basis < 0n) {
      throw new LandedCostError(
        `Line ${l.key} has a negative ${args.basisName ?? "basis"}, which cannot be apportioned against.`,
      );
    }
  }

  const totalBasis = args.lines.reduce((s, l) => s + l.basis, 0n);

  /**
   * ⚠️ EVERY LINE AT ZERO MEANS THE BASIS IS UNUSABLE — nobody entered
   * weights. Splitting equally is the honest fallback and it is stated,
   * rather than dividing by zero or silently allocating nothing.
   */
  if (totalBasis === 0n) {
    const n = BigInt(args.lines.length);
    const base = args.totalMinor / n;
    let remainder = args.totalMinor - base * n;
    return args.lines.map((l) => {
      const extra = remainder > 0n ? 1n : 0n;
      remainder -= extra;
      return { key: l.key, basis: l.basis, allocatedMinor: base + extra };
    });
  }

  /** Floor each share, and keep the remainder for the tie-break. */
  const shares = args.lines.map((l) => {
    const numerator = args.totalMinor * l.basis;
    const floor = numerator / totalBasis;
    return {
      key: l.key,
      basis: l.basis,
      floor,
      remainder: numerator - floor * totalBasis,
    };
  });

  let allocated = shares.reduce((s, x) => s + x.floor, 0n);
  let leftover = args.totalMinor - allocated;

  /**
   * ⭐ SORTED BY REMAINDER, THEN BY KEY. The second sort key is what
   * makes it deterministic — without it two lines with identical
   * remainders can swap places between runs, and a re-run that produces
   * a different apportionment is a re-run nobody trusts.
   */
  const order = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const bonus = new Map<string, bigint>();
  for (const s of order) {
    if (leftover <= 0n) break;
    bonus.set(s.key, 1n);
    leftover -= 1n;
    allocated += 1n;
  }

  return shares.map((s) => ({
    key: s.key,
    basis: s.basis,
    allocatedMinor: s.floor + (bonus.get(s.key) ?? 0n),
  }));
}

/* ------------------------------------------------------------------ */
/* THE SPLIT BETWEEN STOCK AND COST OF SALES                           */
/* ------------------------------------------------------------------ */

export type CostSplit = {
  toInventoryMinor: bigint;
  toCogsMinor: bigint;
  soldFraction: string;
  explanation: string;
};

/**
 * ⭐⭐ THE FREIGHT BILL ARRIVES AFTER THE GOODS, AND SOME OF THEM ARE
 *      ALREADY SOLD.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ADDING ALL OF IT TO THE REMAINING STOCK IS WRONG TWICE
 * ══════════════════════════════════════════════════════════════════════
 * A consignment lands on the 1st. By the 15th half of it has been sold.
 * The freight invoice turns up on the 20th.
 *
 * Putting the whole charge onto what is left:
 *   • **overstates closing stock**, because half the freight belongs to
 *     goods that are no longer there; and
 *   • **overstates the margin already reported** on the half that was
 *     sold, because that sale never carried its share of the freight.
 *
 * ⚠️ Two errors, in opposite directions, and the TOTAL is right — so
 * nothing on any report looks odd. This is the failure this function
 * exists for.
 *
 * ⭐ The share belonging to sold goods goes straight to cost of sales in
 * the period the charge arrives. That is the standard treatment and it
 * is the only one that leaves both figures true.
 */
export function splitBetweenStockAndCogs(args: {
  allocatedMinor: bigint;
  /** Thousandths, as the stock ledger uses. */
  qtyReceivedMilli: bigint;
  qtyStillOnHandMilli: bigint;
}): CostSplit {
  if (args.allocatedMinor < 0n) {
    throw new LandedCostError("An allocated charge cannot be negative.");
  }
  if (args.qtyReceivedMilli < 0n || args.qtyStillOnHandMilli < 0n) {
    throw new LandedCostError("Quantities cannot be negative.");
  }
  if (args.qtyStillOnHandMilli > args.qtyReceivedMilli) {
    /**
     * ⚠️ MORE ON HAND THAN WAS RECEIVED means the on-hand figure includes
     * stock from another consignment. Splitting against it would push
     * cost onto goods this charge has nothing to do with.
     */
    throw new LandedCostError(
      "More of this item is on hand than this consignment brought in. The on-hand figure is picking up stock from another receipt, and apportioning against it would put this freight onto goods it never touched.",
    );
  }

  if (args.qtyReceivedMilli === 0n) {
    return {
      toInventoryMinor: 0n,
      toCogsMinor: args.allocatedMinor,
      soldFraction: "100%",
      explanation:
        "Nothing was received against this line, so there is no stock for the charge to attach to. It goes to cost of sales.",
    };
  }

  /**
   * ⚠️ THE INVENTORY SHARE IS COMPUTED AND COGS IS THE REMAINDER, never
   * the other way round and never both independently. Two roundings
   * that are supposed to add up to a total do not, and the paisa that
   * goes missing is in neither figure.
   */
  const toInventoryMinor =
    (args.allocatedMinor * args.qtyStillOnHandMilli) / args.qtyReceivedMilli;
  const toCogsMinor = args.allocatedMinor - toInventoryMinor;

  const soldMilli = args.qtyReceivedMilli - args.qtyStillOnHandMilli;
  const soldPercent = Number((soldMilli * 1000n) / args.qtyReceivedMilli) / 10;

  return {
    toInventoryMinor,
    toCogsMinor,
    soldFraction: `${soldPercent.toFixed(1)}%`,
    explanation:
      soldMilli === 0n
        ? "All of this consignment is still on hand, so the whole charge is capitalised into stock."
        : `${soldPercent.toFixed(1)}% of this consignment has already been sold. That share of the charge goes to cost of sales in this period — adding it to the remaining stock instead would overstate both the closing stock and the margin already reported.`,
  };
}

/* ------------------------------------------------------------------ */
/* THE LANDED UNIT COST                                                */
/* ------------------------------------------------------------------ */

export type LandedCostSummary = {
  purchaseMinor: bigint;
  capitalisedMinor: bigint;
  recoverableMinor: bigint;
  landedMinor: bigint;
  /** How much dearer the goods really are, in basis points. */
  upliftBps: number;
  explanation: string;
};

/**
 * ⭐ WHAT THE CONSIGNMENT REALLY COST, AND BY HOW MUCH THE INVOICE PRICE
 *    UNDERSTATED IT.
 *
 * ⚠️ THE UPLIFT IS THE FIGURE A TRADER ACTUALLY WANTS. "₹4,80,000 of
 * goods" is the invoice; "8.4% on top before it reached the shelf" is
 * the number that decides whether the selling price works — and it is
 * the number nobody has until the last freight bill lands.
 */
export function summariseLandedCost(args: {
  purchaseMinor: bigint;
  charges: readonly { amountMinor: bigint; recoverable: boolean }[];
}): LandedCostSummary {
  if (args.purchaseMinor < 0n) throw new LandedCostError("Purchase value cannot be negative.");

  let capitalisedMinor = 0n;
  let recoverableMinor = 0n;
  for (const c of args.charges) {
    if (c.amountMinor < 0n) throw new LandedCostError("A charge cannot be negative.");
    if (c.recoverable) recoverableMinor += c.amountMinor;
    else capitalisedMinor += c.amountMinor;
  }

  const landedMinor = args.purchaseMinor + capitalisedMinor;
  const upliftBps =
    args.purchaseMinor > 0n
      ? Number((capitalisedMinor * 10000n) / args.purchaseMinor)
      : 0;

  return {
    purchaseMinor: args.purchaseMinor,
    capitalisedMinor,
    recoverableMinor,
    landedMinor,
    upliftBps,
    explanation:
      recoverableMinor > 0n
        ? `${(upliftBps / 100).toFixed(2)}% has been added to the cost of these goods. A further amount is recoverable tax and has deliberately NOT been capitalised — it is an input credit, not a cost, and putting it into stock would inflate the balance sheet and lose the credit.`
        : `${(upliftBps / 100).toFixed(2)}% has been added to the cost of these goods before they reached the shelf.`,
  };
}

/**
 * ⚠️ THE MARGIN CHECK NOBODY RUNS UNTIL IT IS TOO LATE.
 *
 * A selling price set against the INVOICE price rather than the LANDED
 * price is a price that looks profitable and is not. On thin-margin
 * trading — 4% to 8% is normal — an 8% freight uplift turns every sale
 * into a loss, and the P&L only says so at the month end.
 */
export function marginAgainstLanded(args: {
  sellingPriceMinor: bigint;
  landedUnitCostMinor: bigint;
}): { marginMinor: bigint; marginBps: number; belowCost: boolean; detail: string } {
  const marginMinor = args.sellingPriceMinor - args.landedUnitCostMinor;
  const marginBps =
    args.sellingPriceMinor > 0n
      ? Number((marginMinor * 10000n) / args.sellingPriceMinor)
      : 0;

  if (marginMinor < 0n) {
    return {
      marginMinor,
      marginBps,
      belowCost: true,
      detail:
        "🔴 This sells below what the goods actually cost to land. The invoice price may look profitable; the freight and duty on top are what make it a loss.",
    };
  }
  return {
    marginMinor,
    marginBps,
    belowCost: false,
    detail: `${(marginBps / 100).toFixed(2)}% margin on the landed cost, not on the invoice price.`,
  };
}
