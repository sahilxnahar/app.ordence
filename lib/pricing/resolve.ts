/**
 * Ordence — ⭐⭐ WHICH PRICE APPLIES TO THIS CUSTOMER, TODAY, AT THIS
 *              QUANTITY
 * Version: v1.6.0-alpha
 *
 * Pure. No database, no clock — every function that depends on "today"
 * takes it as an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS FILE CLOSES, AND IT IS NOT A MISSING TABLE
 * ══════════════════════════════════════════════════════════════════════
 * `rate_cards` and `rate_slabs` have existed since 0034 and are good:
 * customer, subject, priority, half-open validity, and — the hard part —
 * `slab_mode`, stating whether "first 100 at ₹4.50, next 200 at ₹6.20"
 * is read progressively or flat.
 *
 * **And `sales_order_lines.unit_price_minor` is typed in by hand.**
 * Nothing ever picked a card. The engine was read by metering and by a
 * rates screen, and by nothing that sells goods — so a distributor with
 * negotiated customer prices retyped them on every line, and the price
 * list was decoration.
 *
 * ⚠️ THE FIX IS A RESOLVER, NOT A SECOND PRICE LIST. A
 * `customer_price_lists` table would have been the obvious thing to
 * write and it would have been the mistake: two tables answering "what
 * does this cost this customer today" is two answers, and the wrong one
 * is whichever the invoice screen happens to read.
 */

import {
  priceFlat,
  priceProgressive,
  divideRoundHalfUp,
  RATE_SCOPE_PRIORITY,
  type RateScope,
  type Slab,
  type SlabMode,
} from "@/db/schema/pricing";

export class PricingError extends Error {}

/* ------------------------------------------------------------------ */
/* ① SLAB VALIDATION                                                   */
/* ------------------------------------------------------------------ */

export type SlabProblem = {
  sequence: number;
  problem: string;
};

/**
 * ⭐ BANDS THAT CANNOT OVERLAP OR LEAVE A GAP.
 *
 * 🔴 AN OVERLAP IS TWO PRICES FOR ONE QUANTITY. Which one wins depends
 *    on the order rows come back in, so the same quote prices
 *    differently on two runs and nobody can reproduce the argument.
 *
 * 🔴 A GAP IS QUIETER AND WORSE. `priceFlat` falls through to the last
 *    band, so a quantity matching nothing is charged at the TOP band
 *    rather than erroring — the customer is billed the wrong figure and
 *    the screen shows no sign of it.
 *
 * ⚠️ AND ONLY THE LAST BAND MAY BE OPEN-ENDED. Anything after "and
 * everything above" can never be reached, and whatever was priced into
 * it will never be charged.
 */
export function validateSlabs(slabs: readonly Slab[]): SlabProblem[] {
  const problems: SlabProblem[] = [];
  if (slabs.length === 0) return problems;

  const ordered = [...slabs].sort((a, b) => a.sequence - b.sequence);

  const openEnded = ordered.filter((s) => s.upToQuantity === null);
  if (openEnded.length > 1) {
    for (const s of openEnded.slice(1)) {
      problems.push({
        sequence: s.sequence,
        problem:
          'A second "and everything above" band can never be reached, so whatever is priced into it will never be charged.',
      });
    }
  }

  const openIndex = ordered.findIndex((s) => s.upToQuantity === null);
  if (openIndex >= 0 && openIndex !== ordered.length - 1) {
    for (const s of ordered.slice(openIndex + 1)) {
      problems.push({
        sequence: s.sequence,
        problem:
          'This band comes after the open-ended one, so it can never be reached.',
      });
    }
  }

  let prev: bigint | null = null;
  for (const s of ordered) {
    if (s.upToQuantity === null) continue;
    if (s.upToQuantity <= 0n) {
      problems.push({
        sequence: s.sequence,
        problem: "A band has to end above zero.",
      });
      continue;
    }
    if (prev !== null && s.upToQuantity <= prev) {
      problems.push({
        sequence: s.sequence,
        problem: `This band ends at ${s.upToQuantity} but the one before it already reached ${prev}. Two bands covering one quantity give two prices.`,
      });
    }
    prev = s.upToQuantity;
  }

  /**
   * ⚠️ NO OPEN-ENDED BAND AT ALL IS NOT AN ERROR — but it is worth
   * saying, because a quantity above the top band silently falls through
   * to it under flat pricing.
   */
  if (openEnded.length === 0) {
    const last = ordered[ordered.length - 1];
    if (last) {
      problems.push({
        sequence: last.sequence,
        problem: `Nothing prices a quantity above ${last.upToQuantity}. It will be charged at this band's rate, which may not be what was intended — add an open-ended band to say so deliberately.`,
      });
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* ② CARD SELECTION                                                    */
/* ------------------------------------------------------------------ */

export type CandidateCard = {
  id: string;
  code: string;
  name: string;
  scope: RateScope;
  slabMode: SlabMode;
  priority: number;
  customerCompanyId: string | null;
  appliesToKind: string | null;
  appliesToId: string | null;
  channel: string | null;
  validFrom: string | null;
  /** ⚠️ EXCLUSIVE. A card ending 31 March does not apply on 31 March. */
  validTo: string | null;
  /** "1111100" = Mon–Fri. Null = every day. */
  daysOfWeek: string | null;
  baseAmountMinor: bigint;
  taxRateBps: number;
  isTaxInclusive: boolean;
  floorPriceMinor: bigint | null;
  isActive: boolean;
};

export type CardSelection = {
  card: CandidateCard;
  /** Why this one and not another — shown on the screen. */
  reason: string;
  /** Every card that also applied, in the order they lost. */
  runnersUp: { code: string; scope: RateScope; reason: string }[];
};

/** Day of week for a civil date, 0 = Monday, in the tenant's own calendar. */
function dayIndex(iso: string): number {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new PricingError(`Not a date: ${iso}`);
  /** 1 Jan 1970 was a Thursday, which is index 3 with Monday = 0. */
  return (Math.floor(ms / 86_400_000) + 3) % 7;
}

function appliesOn(card: CandidateCard, onDate: string): boolean {
  if (!card.isActive) return false;
  if (card.validFrom && onDate < card.validFrom) return false;
  /** ⚠️ Half-open: `validTo` is EXCLUSIVE. */
  if (card.validTo && onDate >= card.validTo) return false;
  if (card.daysOfWeek && card.daysOfWeek.length === 7) {
    if (card.daysOfWeek[dayIndex(onDate)] !== "1") return false;
  }
  return true;
}

/**
 * ⭐⭐ PICK THE CARD.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SPECIFICITY BEATS PRIORITY BEATS RECENCY — IN THAT ORDER
 * ══════════════════════════════════════════════════════════════════════
 * ① **A card naming this customer always beats one that does not.**
 *    A rate negotiated in a supply agreement last year must never be
 *    overridden by a house list somebody published yesterday. Same
 *    discipline as the billing rates in v1.1.0, and it is the rule
 *    people are most surprised by until it protects them.
 *
 * ② Then a card naming this ITEM beats one that prices a whole
 *    category.
 *
 * ③ Then the stated `priority` / scope precedence — a commercial
 *    decision, and one somebody will have to explain to a customer
 *    holding a different invoice.
 *
 * ④ Then the one that started most recently.
 *
 * ⑤ ⚠️ Then the card CODE, so the result is deterministic. Without a
 *    final tie-break the same customer can be quoted differently on two
 *    runs, and a quote that changes between being given and being
 *    honoured is a quote nobody trusts.
 */
export function selectRateCard(args: {
  cards: readonly CandidateCard[];
  customerCompanyId: string | null;
  appliesToKind: string;
  appliesToId: string;
  onDate: string;
  channel?: string | null;
}): CardSelection | null {
  const applicable = args.cards.filter((c) => {
    if (!appliesOn(c, args.onDate)) return false;
    /** ⚠️ A card for ANOTHER customer never applies to this one. */
    if (c.customerCompanyId && c.customerCompanyId !== args.customerCompanyId) {
      return false;
    }
    if (c.channel && args.channel && c.channel !== args.channel) return false;
    if (c.appliesToKind && c.appliesToKind !== args.appliesToKind) return false;
    if (c.appliesToId && c.appliesToId !== args.appliesToId) return false;
    return true;
  });

  if (applicable.length === 0) return null;

  const score = (c: CandidateCard) => ({
    customer: c.customerCompanyId ? 1 : 0,
    item: c.appliesToId ? 1 : 0,
    priority: Math.max(c.priority, RATE_SCOPE_PRIORITY[c.scope] ?? 0),
    from: c.validFrom ?? "",
  });

  const ranked = [...applicable].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa.customer !== sb.customer) return sb.customer - sa.customer;
    if (sa.item !== sb.item) return sb.item - sa.item;
    if (sa.priority !== sb.priority) return sb.priority - sa.priority;
    if (sa.from !== sb.from) return sa.from < sb.from ? 1 : -1;
    /** ⑤ Deterministic. */
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  const winner = ranked[0];
  if (!winner) return null;

  const why = (c: CandidateCard): string => {
    const bits: string[] = [];
    if (c.customerCompanyId) bits.push("negotiated with this customer");
    else bits.push("a general list");
    if (c.appliesToId) bits.push("priced for this item");
    bits.push(`${c.scope} priority ${Math.max(c.priority, RATE_SCOPE_PRIORITY[c.scope] ?? 0)}`);
    return bits.join(" · ");
  };

  return {
    card: winner,
    reason: `Chosen because it is ${why(winner)}.${
      ranked.length > 1
        ? " A card naming this customer always beats a general list, however recently the list was published."
        : ""
    }`,
    runnersUp: ranked.slice(1, 6).map((c) => ({
      code: c.code,
      scope: c.scope,
      reason: why(c),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* ③ THE QUOTE                                                         */
/* ------------------------------------------------------------------ */

export type Quote = {
  cardCode: string;
  cardName: string;
  slabMode: SlabMode;
  /** The whole line, before tax, in paise. */
  lineAmountMinor: bigint;
  /** Derived — for display and for the order line. */
  unitPriceMinor: bigint;
  taxRateBps: number;
  isTaxInclusive: boolean;
  reason: string;
  warnings: string[];
};

/**
 * ⭐ PRICE A QUANTITY AGAINST A CARD.
 *
 * 🔴 THE SLAB MODE IS NOT GUESSED. "First 100 at ₹4.50, next 200 at
 *    ₹6.20" reads two ways and both are used: progressive (electricity,
 *    income tax) and flat (freight, and almost every volume discount).
 *    The difference is 27% on a common example. `slab_mode` is required
 *    on the card with no default, and this function honours it.
 *
 * ⚠️ THE LINE AMOUNT IS COMPUTED FIRST AND THE UNIT PRICE DERIVED FROM
 * IT — never the other way round. Under progressive pricing there is no
 * single unit price; deriving the line from a rounded unit figure would
 * lose paise on every quantity, always in the same direction.
 */
export function quoteQuantity(args: {
  card: CandidateCard;
  slabs: readonly Slab[];
  /** Whole units. The stock ledger's thousandths are converted at the edge. */
  quantity: bigint;
  landedUnitCostMinor?: bigint | null;
}): Quote {
  if (args.quantity <= 0n) {
    throw new PricingError("Quote a positive quantity.");
  }

  const warnings: string[] = [];
  const slabProblems = validateSlabs(args.slabs);
  for (const p of slabProblems) {
    warnings.push(`Band ${p.sequence}: ${p.problem}`);
  }

  let lineAmountMinor: bigint;
  if (args.slabs.length === 0 || args.card.slabMode === "none") {
    lineAmountMinor = args.quantity * args.card.baseAmountMinor;
  } else if (args.card.slabMode === "progressive") {
    lineAmountMinor = priceProgressive(args.quantity, args.slabs);
  } else {
    lineAmountMinor = priceFlat(args.quantity, args.slabs);
  }

  /** ⚠️ Derived, never the source. See the note above. */
  const unitPriceMinor = divideRoundHalfUp(lineAmountMinor, args.quantity);

  /**
   * 🔴 THE FLOOR IS CHECKED AGAINST THE UNIT PRICE, AND IT IS A WARNING
   *    RATHER THAN A REFUSAL. A trader genuinely does sell below list to
   *    clear stock — but never by accident, and never without somebody
   *    seeing the figure.
   */
  if (args.card.floorPriceMinor !== null && unitPriceMinor < args.card.floorPriceMinor) {
    warnings.push(
      `🔴 This works out at ${unitPriceMinor} paise a unit, below the floor of ${args.card.floorPriceMinor} set on this card.`,
    );
  }

  /**
   * 🔴 AND AGAINST THE **LANDED** COST, NOT THE INVOICE PRICE. A price
   *    set against what the supplier charged looks profitable; the
   *    freight and duty on top are what make it a loss. On 4–8% trading
   *    margins an 8% uplift is the whole margin.
   */
  if (args.landedUnitCostMinor !== null && args.landedUnitCostMinor !== undefined) {
    if (unitPriceMinor < args.landedUnitCostMinor) {
      warnings.push(
        `🔴 This sells below what the goods cost to land — ${args.landedUnitCostMinor} paise a unit including freight and duty. The invoice price alone would have looked profitable.`,
      );
    }
  }

  return {
    cardCode: args.card.code,
    cardName: args.card.name,
    slabMode: args.card.slabMode,
    lineAmountMinor,
    unitPriceMinor,
    taxRateBps: args.card.taxRateBps,
    isTaxInclusive: args.card.isTaxInclusive,
    reason:
      args.card.slabMode === "progressive"
        ? "Progressive — each band charged for the part of the quantity inside it."
        : args.card.slabMode === "flat"
          ? "Flat — the whole quantity charged at the band it lands in."
          : "A single rate, with no bands.",
    warnings,
  };
}

/**
 * ⚠️ TAX-INCLUSIVE PRICES ARE A REAL THING AND THEY ARE WHERE MONEY
 * GOES MISSING.
 *
 * A retail price of ₹118 at 18% is ₹100 taxable and ₹18 tax. Dividing
 * by 1.18 in floating point gives 99.99999999999999, and the invoice
 * then shows ₹99.99 + ₹18.00 = ₹117.99 against a shelf price of ₹118.
 * The customer notices; the accountant cannot explain it.
 */
export function stripTax(args: {
  inclusiveMinor: bigint;
  taxRateBps: number;
}): { taxableMinor: bigint; taxMinor: bigint } {
  if (args.taxRateBps < 0) throw new PricingError("A tax rate cannot be negative.");
  const taxableMinor = divideRoundHalfUp(
    args.inclusiveMinor * 10_000n,
    10_000n + BigInt(args.taxRateBps),
  );
  /** ⭐ The tax is the REMAINDER, so the two always add back exactly. */
  return { taxableMinor, taxMinor: args.inclusiveMinor - taxableMinor };
}
