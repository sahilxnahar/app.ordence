/**
 * Ordence — ⭐⭐ SECTION 15(3) — WHEN A DISCOUNT REDUCES THE TAX
 * Version: v1.6.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TRAP THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * A trading business gives a customer a **year-end volume rebate** and
 * agrees it in **December**, on the year's turnover. Every instinct says
 * raise a credit note and take the GST back.
 *
 * **The GST cannot be taken back.** Section 15(3)(b)(i) requires the
 * discount to be *"established in terms of an agreement entered into at
 * or before the time of such supply"*. April's sales were made when no
 * agreement existed. The credit note is perfectly legal — the customer
 * genuinely owes less — but it carries **no tax**, and the supplier eats
 * the GST already paid on a sale that has been reversed.
 *
 * ⚠️ Trading businesses give exactly those rebates, constantly, and
 * agree them at the end of the year they relate to.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND ONE THING THAT CHANGED RECENTLY, WHICH MOST SOFTWARE HAS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * Circular **212/6/2024-GST** (26 June 2024) required the supplier to
 * hold a certificate or undertaking from the recipient proving the input
 * tax credit had been reversed.
 *
 * 🔴 **That circular was WITHDRAWN by Circular 253/10/2025-GST with
 *    effect from 1 October 2025.** No separate evidentiary procedure is
 *    required any more.
 *
 * ⚠️ **THE SUBSTANTIVE CONDITION SURVIVED THE WITHDRAWAL.** The credit
 * still has to have been reversed by the recipient — s.15(3)(b)(ii) was
 * not amended. Only the paperwork requirement went. Software that reads
 * the withdrawal as "the condition is gone" is wrong in the direction
 * that loses an assessment.
 */

export class DiscountError extends Error {}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export type DiscountTiming =
  /** s.15(3)(a) — on the invoice itself. */
  | "in_invoice"
  /** s.15(3)(b) — after the supply, under a prior agreement. */
  | "post_supply_agreed"
  /** ⚠️ After the supply, with no prior agreement. A financial credit note. */
  | "post_supply_unagreed";

export type DiscountVerdict = {
  timing: DiscountTiming;
  /** 🔴 Whether the GST on the original supply can be reduced. */
  reducesTax: boolean;
  reason: string;
  authority: string;
  /** What still has to be true or done. */
  outstanding: string[];
};

/**
 * ⭐⭐ CAN THIS DISCOUNT REDUCE THE TAX?
 *
 * ⚠️ THE COMPARISON IS AGAINST THE EARLIEST SUPPLY IN THE PERIOD, NOT
 * THE LATEST. An agreement signed on 1 October covers October's sales
 * and does nothing for April's — so a rebate spanning the whole year
 * qualifies only for the part of it that came after the agreement.
 * Testing the latest invoice would pass the whole rebate.
 */
export function assessPostSupplyDiscount(args: {
  /** 🔴 The date the agreement was struck. Null = no agreement on file. */
  agreementDate: string | null;
  /** The earliest supply the rebate is measured on. */
  earliestSupplyDate: string;
  /** How many invoices the rebate has been apportioned across. */
  linkedInvoiceCount: number;
  /** s.15(3)(b)(ii) — has the recipient reversed the credit? */
  recipientReversalConfirmed: boolean;
}): DiscountVerdict {
  const authority =
    "Section 15(3)(b) — a post-supply discount reduces the taxable value only if it was established under an agreement made at or before the supply, is specifically linked to the relevant invoices, and the recipient has reversed the input tax credit on it.";

  const outstanding: string[] = [];

  if (!args.agreementDate) {
    return {
      timing: "post_supply_unagreed",
      reducesTax: false,
      reason:
        "🔴 There is no agreement on file. A discount given after the supply reduces the tax only if it was established under an agreement made at or before that supply — so this can be credited to the customer, and the GST on the original sales cannot be recovered.",
      authority,
      outstanding: [
        "Raise it as a financial credit note, with no tax on it.",
        "For next year: sign the rebate agreement BEFORE the period it covers, not after it.",
      ],
    };
  }

  /**
   * 🔴 THE COMPARISON THAT DECIDES EVERYTHING. "At or before" — an
   * agreement dated the same day as the supply qualifies.
   */
  if (args.agreementDate > args.earliestSupplyDate) {
    return {
      timing: "post_supply_unagreed",
      reducesTax: false,
      reason: `🔴 The agreement is dated ${args.agreementDate} and the earliest supply in this period was ${args.earliestSupplyDate}. Section 15(3)(b)(i) needs the agreement to have existed at or before the supply, so the tax on sales made before ${args.agreementDate} cannot be reduced. The customer can still be credited; the GST cannot be recovered.`,
      authority,
      outstanding: [
        `Consider splitting this rebate — supplies from ${args.agreementDate} onwards may still qualify.`,
        "Raise the rest as a financial credit note, with no tax.",
      ],
    };
  }

  /**
   * 🔴 "SPECIFICALLY LINKED TO RELEVANT INVOICES" IS NOT DECORATION. A
   *    rebate computed on a period's turnover and credited as one lump
   *    is exactly what the section refuses — and it is also the only way
   *    the recipient can work out how much credit to reverse.
   */
  if (args.linkedInvoiceCount === 0) {
    outstanding.push(
      "Link this rebate to the specific invoices it came from. A lump sum against a period's turnover is what s.15(3)(b)(i) refuses, and it is also the only way the customer can work out how much credit to reverse.",
    );
  }

  /**
   * ⚠️ THE CONDITION SURVIVED THE WITHDRAWAL OF CIRCULAR 212/6/2024.
   * Only the certificate requirement went, on 1 October 2025.
   */
  if (!args.recipientReversalConfirmed) {
    outstanding.push(
      "Confirm the customer has reversed the input tax credit on this discount. Circular 212/6/2024 used to require a certificate proving it; that circular was withdrawn by Circular 253/10/2025-GST on 1 October 2025 — but s.15(3)(b)(ii) itself was not amended, so the reversal still has to have happened. Only the paperwork requirement went.",
    );
  }

  const reducesTax = outstanding.length === 0;

  return {
    timing: "post_supply_agreed",
    reducesTax,
    reason: reducesTax
      ? `The agreement was in place on ${args.agreementDate}, before the earliest supply on ${args.earliestSupplyDate}, the rebate is linked to ${args.linkedInvoiceCount} specific invoices, and the customer's credit reversal is recorded. The GST on the original supplies can be reduced.`
      : `The agreement was in place in time, so this can qualify — but not yet. ${outstanding.length} condition${outstanding.length === 1 ? "" : "s"} of s.15(3)(b) remain unmet.`,
    authority,
    outstanding,
  };
}

/* ------------------------------------------------------------------ */
/* REBATE SLABS                                                        */
/* ------------------------------------------------------------------ */

export type RebateSlab = {
  /** Turnover at or above which this rate applies, in paise. */
  fromTurnoverMinor: bigint;
  /** The rebate, in basis points. 250 = 2.5%. */
  rateBps: number;
};

export type RebateResult = {
  rateBps: number;
  discountMinor: bigint;
  bandFromMinor: bigint;
  /** How much more turnover reaches the next band. Null at the top. */
  toNextBandMinor: bigint | null;
  nextRateBps: number | null;
};

/**
 * ⭐ WHAT A PERIOD'S TURNOVER HAS EARNED.
 *
 * ⚠️ THE WHOLE TURNOVER IS REBATED AT THE BAND IT REACHES — the flat
 * reading, not the progressive one. That is what a trading rebate
 * agreement almost always says ("achieve ₹1 crore and earn 2.5% on the
 * year"), and it is the opposite of how an electricity tariff works.
 *
 * 🔴 The distinction is the same one `slab_mode` exists for on a rate
 *    card, and it is worth stating rather than assuming: on ₹1.2 crore
 *    across bands of 2% and 2.5%, flat gives ₹3,00,000 and progressive
 *    gives ₹2,50,000. A quarter of the rebate.
 *
 * ⭐ AND IT REPORTS HOW FAR THE NEXT BAND IS. That figure is the reason
 * a salesperson opens this screen in the last week of March.
 */
export function rebateForTurnover(args: {
  turnoverMinor: bigint;
  slabs: readonly RebateSlab[];
}): RebateResult {
  if (args.turnoverMinor < 0n) {
    throw new DiscountError("Turnover cannot be negative.");
  }
  for (const s of args.slabs) {
    if (s.rateBps < 0 || !Number.isInteger(s.rateBps)) {
      throw new DiscountError("A rebate rate must be whole basis points.");
    }
    if (s.fromTurnoverMinor < 0n) {
      throw new DiscountError("A rebate band cannot start below zero.");
    }
  }

  const ordered = [...args.slabs].sort((a, b) =>
    a.fromTurnoverMinor < b.fromTurnoverMinor ? -1 : a.fromTurnoverMinor > b.fromTurnoverMinor ? 1 : 0,
  );

  let reached: RebateSlab | null = null;
  let next: RebateSlab | null = null;
  for (const s of ordered) {
    if (args.turnoverMinor >= s.fromTurnoverMinor) {
      reached = s;
    } else {
      next = next ?? s;
    }
  }

  if (!reached) {
    return {
      rateBps: 0,
      discountMinor: 0n,
      bandFromMinor: 0n,
      toNextBandMinor: next ? next.fromTurnoverMinor - args.turnoverMinor : null,
      nextRateBps: next?.rateBps ?? null,
    };
  }

  /** ⚠️ Rounded half up, once, in integer arithmetic. */
  const discountMinor =
    (args.turnoverMinor * BigInt(reached.rateBps) + 5000n) / 10000n;

  return {
    rateBps: reached.rateBps,
    discountMinor,
    bandFromMinor: reached.fromTurnoverMinor,
    toNextBandMinor: next ? next.fromTurnoverMinor - args.turnoverMinor : null,
    nextRateBps: next?.rateBps ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* APPORTIONING IT ACROSS THE INVOICES                                 */
/* ------------------------------------------------------------------ */

export type InvoiceShare = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  taxableMinor: bigint;
  taxRateBps: number;
};

export type AllocatedShare = InvoiceShare & {
  allocatedMinor: bigint;
  taxAllocatedMinor: bigint;
};

/**
 * ⭐⭐ SPREAD THE REBATE OVER THE INVOICES THAT EARNED IT.
 *
 * 🔴 THIS IS THE s.15(3)(b)(i) LINKAGE, AND IT IS ALSO THE ONLY WAY THE
 *    CUSTOMER CAN WORK OUT HOW MUCH CREDIT TO REVERSE. A rebate stored
 *    as one figure cannot produce it afterwards, because the
 *    apportionment was never done.
 *
 * ⚠️ LARGEST REMAINDER, so the shares sum to the rebate exactly. A
 * rebate that allocates to ₹99,999.98 of a ₹1,00,000 credit note leaves
 * two paise belonging to no invoice, and the credit note then does not
 * agree with its own detail.
 *
 * ⚠️ AND THE TAX IS COMPUTED PER INVOICE, AT THAT INVOICE'S RATE. A
 * rebate spanning goods at 5%, 12% and 18% has no single tax rate, and
 * applying an average would reclaim the wrong amount on every line.
 */
export function allocateRebate(args: {
  discountMinor: bigint;
  invoices: readonly InvoiceShare[];
}): { shares: AllocatedShare[]; taxTotalMinor: bigint } {
  if (args.discountMinor < 0n) {
    throw new DiscountError("A rebate cannot be negative.");
  }
  if (args.invoices.length === 0) {
    throw new DiscountError(
      "A rebate has to be linked to the invoices it came from — s.15(3)(b)(i) requires it, and without the linkage the customer cannot work out how much credit to reverse.",
    );
  }

  const totalBasis = args.invoices.reduce((s, i) => s + i.taxableMinor, 0n);
  if (totalBasis <= 0n) {
    throw new DiscountError("Those invoices carry no taxable value to apportion against.");
  }

  const floors = args.invoices.map((i) => {
    const numerator = args.discountMinor * i.taxableMinor;
    const floor = numerator / totalBasis;
    return { invoice: i, floor, remainder: numerator - floor * totalBasis };
  });

  let leftover = args.discountMinor - floors.reduce((s, f) => s + f.floor, 0n);

  /** ⚠️ Deterministic: remainder, then invoice number. */
  const order = [...floors].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.invoice.invoiceNumber < b.invoice.invoiceNumber ? -1 : 1;
  });

  const bonus = new Map<string, bigint>();
  for (const f of order) {
    if (leftover <= 0n) break;
    bonus.set(f.invoice.invoiceId, 1n);
    leftover -= 1n;
  }

  let taxTotalMinor = 0n;
  const shares: AllocatedShare[] = floors.map((f) => {
    const allocatedMinor = f.floor + (bonus.get(f.invoice.invoiceId) ?? 0n);
    /** ⭐ At THIS invoice's rate, not an average. */
    const taxAllocatedMinor =
      (allocatedMinor * BigInt(f.invoice.taxRateBps) + 5000n) / 10000n;
    taxTotalMinor += taxAllocatedMinor;
    return { ...f.invoice, allocatedMinor, taxAllocatedMinor };
  });

  return { shares, taxTotalMinor };
}

/**
 * ⚠️ THE EARLIEST SUPPLY IN A SET, which is what the agreement date is
 * tested against. Using the latest would pass a whole year's rebate on
 * an agreement signed in October.
 */
export function earliestSupplyDate(invoices: readonly InvoiceShare[]): string {
  if (invoices.length === 0) {
    throw new DiscountError("No invoices to take a date from.");
  }
  return invoices.reduce(
    (earliest, i) => (i.invoiceDate < earliest ? i.invoiceDate : earliest),
    invoices[0]!.invoiceDate,
  );
}
