/**
 * Ordence — Booking Cancellation: the arithmetic and the law
 * Version: v1.25.0-alpha
 *
 * Pure and isomorphic. Money is `bigint` paise throughout.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A CANCELLATION IS THE HARDEST POSTING IN THE PROPERTY MODULE
 * ══════════════════════════════════════════════════════════════════════
 * Every other property event adds something. A cancellation has to take
 * a booking that has been accumulating entries for two years and return
 * every one of its balances to zero — the advance, the receivable, and
 * the output tax — while disposing of real money in two directions.
 *
 * ⚠️ AND THE WRONG VERSION BALANCES PERFECTLY. `Dr Advance / Cr
 * Forfeiture Income` for the amount kept is a valid, balanced journal.
 * It also leaves the refund unrecorded, the unpaid demands sitting as a
 * receivable against a buyer who no longer exists, and the output tax
 * still owed on a sale that did not happen. The trial balance agrees
 * with itself and disagrees with reality.
 *
 * So this file exists to REFUSE, not to compute. The arithmetic is four
 * lines; the eight refusals around it are the product.
 */

/* ------------------------------------------------------------------ */
/* THE FACTS A CANCELLATION NEEDS                                      */
/* ------------------------------------------------------------------ */

export type CancellationFacts = {
  /** Credit balance standing in Advance from Customers for this booking. */
  advanceMinor: bigint;
  /** Debit balance standing in Booking Receivable — demands raised, never paid. */
  receivableMinor: bigint;
  /** Output CGST + SGST + IGST charged on this booking's demands, to date. */
  outputTaxMinor: bigint;
  /** What the buyer actually paid — bank plus any TDS they withheld. */
  cashPaidMinor: bigint;

  /** What is being kept. */
  forfeitMinor: bigint;
  /** What is going back. */
  refundMinor: bigint;

  /** Reversed by a section 34 credit note. Zero when the window has closed. */
  reversedCgstMinor: bigint;
  reversedSgstMinor: bigint;
  reversedIgstMinor: bigint;
};

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE FORFEITURE CAP                                            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 HOW MUCH MAY ACTUALLY BE FORFEITED — AND WHY THIS WARNS RATHER
 *    THAN REFUSES
 * ══════════════════════════════════════════════════════════════════════
 * A forfeiture clause in a builder-buyer agreement is not self-executing.
 * Section 74 of the Contract Act allows only REASONABLE COMPENSATION for
 * a breach, and the Supreme Court in Maula Bux held that a sum stipulated
 * as forfeit is not automatically recoverable — actual loss has to be
 * shown unless the sum is genuine earnest money. Consumer forums have
 * treated forfeiture beyond roughly ten percent of the total
 * consideration as an unfair trade practice for years, and several State
 * RERA rules now say ten percent in terms.
 *
 * ⚠️ SO THIS IS A LEGAL RISK, NOT AN ARITHMETIC ERROR. Forfeiting 30% is
 * a perfectly valid journal entry; it is the ORDER TO REFUND THE
 * DIFFERENCE, two years later, with interest and costs, that is
 * expensive. A hard refusal here would be the product overruling a
 * decision that is the developer's to make — sometimes correctly, if the
 * agreement predates the rules or the loss is genuinely demonstrable.
 *
 * ⭐ WHAT IT DOES INSTEAD IS SAY SO, ON THE SCREEN, BEFORE THE ENTRY IS
 *   POSTED — which is the only moment at which saying it changes
 *   anything.
 *
 * ⚠️ TEN PERCENT IS A DEFAULT AND IT IS PER STATE. It is a number here
 * rather than a constant buried in a comparison so that a tenant whose
 * State says otherwise can carry their own figure.
 */
export const FORFEITURE_GUIDANCE = {
  capBps: 1000, // 10%
  basis: "the total consideration for the unit, not the amount collected",
  authority:
    "Section 74 of the Indian Contract Act, Maula Bux v. Union of India, and the " +
    "forfeiture limits in several State RERA rules.",
} as const;

/**
 * ⚠️ THE CAP IS ON THE CONSIDERATION, NOT ON WHAT WAS COLLECTED, and
 * that distinction is the whole point of the warning.
 *
 * A buyer who has paid ₹4,00,000 of a ₹80,00,000 flat and walks away has
 * a cap of ₹8,00,000 — which is more than they have paid, so the whole
 * ₹4,00,000 may be kept. A buyer who has paid ₹40,00,000 of the same
 * flat has the same ₹8,00,000 cap, and forfeiting their whole payment is
 * five times what may be defended. Reading the cap against collections
 * instead of consideration gets the second case exactly backwards, and
 * the second case is the one that ends up in front of a forum.
 */
export function forfeitureWarning(args: {
  forfeitMinor: bigint;
  considerationMinor: bigint | null;
  capBps?: number;
}): string | null {
  const capBps = args.capBps ?? FORFEITURE_GUIDANCE.capBps;

  if (args.considerationMinor == null || args.considerationMinor <= 0n) {
    return args.forfeitMinor > 0n
      ? "This booking has no agreement value recorded, so the forfeiture cannot be " +
          "checked against the usual ten percent limit. Record the agreement value " +
          "before relying on this figure."
      : null;
  }

  const cap = (args.considerationMinor * BigInt(capBps)) / 10_000n;
  if (args.forfeitMinor <= cap) return null;

  return (
    `This forfeits ${rupees(args.forfeitMinor)}, which is more than ` +
    `${(capBps / 100).toFixed(0)}% of the ${rupees(args.considerationMinor)} ` +
    `agreement value (${rupees(cap)}). Forfeiture beyond that has repeatedly been ` +
    `held to be an unfair trade practice, and the usual outcome is an order to ` +
    `refund the excess with interest. ${FORFEITURE_GUIDANCE.authority} ` +
    `Ordence will post whatever you decide — this is a flag, not a block.`
  );
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE SECTION 34 CREDIT-NOTE WINDOW                               */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHEN THE OUTPUT TAX CAN STILL BE TAKEN BACK, AND WHEN IT CANNOT
 * ══════════════════════════════════════════════════════════════════════
 * GST was charged and paid on every demand note this booking raised. The
 * flat is not being sold, so that tax should come back — by a credit
 * note under section 34.
 *
 * 🔴 BUT SECTION 34(2) PUTS A HARD DEADLINE ON IT. A credit note may be
 * declared no later than 30 November following the end of the financial
 * year in which the supply was made (or the date the annual return is
 * filed, if that is earlier). After that, the tax stays paid. Forever.
 *
 * ⚠️ AND A DEVELOPER'S BOOKINGS ARE EXACTLY THE CASE WHERE THIS BITES.
 * Demands run for three years; a cancellation in year three cannot
 * reverse the tax charged in year one. Half the tax comes back and half
 * of it is simply a cost — which is why the posting has a leg for it.
 */
export function creditNoteWindowCloses(supplyDate: string): string {
  const year = Number(supplyDate.slice(0, 4));
  const month = Number(supplyDate.slice(5, 7));
  // The Indian financial year runs 1 April to 31 March.
  const fyEndYear = month >= 4 ? year + 1 : year;
  return `${fyEndYear}-11-30`;
}

export function creditNoteWindowClosed(supplyDate: string, onDate: string): boolean {
  return onDate > creditNoteWindowCloses(supplyDate);
}

/* ------------------------------------------------------------------ */
/* 🔴 THE REFUSALS                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ RETURNS A SENTENCE OR NULL. It never throws, and it never returns a
 * code the caller has to look up. Every one of these lands in front of
 * somebody cancelling a flat sale, and "CANCEL_IMBALANCE" tells them
 * nothing they can act on.
 */
export function cancellationProblem(f: CancellationFacts): string | null {
  const negatives: [string, bigint][] = [
    ["the advance standing", f.advanceMinor],
    ["the receivable standing", f.receivableMinor],
    ["the output tax charged", f.outputTaxMinor],
    ["the cash the buyer paid", f.cashPaidMinor],
    ["the amount forfeited", f.forfeitMinor],
    ["the amount refunded", f.refundMinor],
    ["the CGST reversed", f.reversedCgstMinor],
    ["the SGST reversed", f.reversedSgstMinor],
    ["the IGST reversed", f.reversedIgstMinor],
  ];
  for (const [label, value] of negatives) {
    if (value < 0n) return `${capitalise(label)} is negative.`;
  }

  const reversed = f.reversedCgstMinor + f.reversedSgstMinor + f.reversedIgstMinor;
  if (reversed > f.outputTaxMinor) {
    return (
      `The credit note reverses ${rupees(reversed)} of tax, but only ` +
      `${rupees(f.outputTaxMinor)} was ever charged on this booking. A credit note ` +
      `cannot take back more than the invoice put out.`
    );
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 THE RULE THAT UPGRADED FROM `<=` TO `=` IN v1.25.0-alpha
   * ══════════════════════════════════════════════════════════════════
   * `cancelBooking` has always refused a forfeit-plus-refund LARGER than
   * what the buyer paid. That stopped the obvious fraud and allowed the
   * quiet one: a smaller total, where some of the buyer's money is
   * neither kept nor returned.
   *
   * ⚠️ THERE IS NO SUCH STATE. Money the buyer handed over is either the
   * developer's or the buyer's; there is no third place for it to be.
   * Recording ₹3,00,000 kept and ₹1,00,000 refunded against ₹5,00,000
   * collected leaves ₹1,00,000 unaccounted for, and the entry balances
   * anyway because the difference silently lands wherever the plug goes.
   *
   * ⭐ AND THE REFUSAL IS ALSO THE MOST USEFUL DIAGNOSTIC IN THIS FILE,
   *   because it is how a mistyped refund is caught before it is paid.
   */
  const disposed = f.forfeitMinor + f.refundMinor;
  if (disposed !== f.cashPaidMinor) {
    const short = f.cashPaidMinor - disposed;
    return short > 0n
      ? `The buyer paid ${rupees(f.cashPaidMinor)}, and this keeps ${rupees(f.forfeitMinor)} ` +
          `and refunds ${rupees(f.refundMinor)} — leaving ${rupees(short)} unaccounted for. ` +
          `Every rupee they paid has to be either kept or returned.`
      : `This keeps ${rupees(f.forfeitMinor)} and refunds ${rupees(f.refundMinor)}, which is ` +
          `${rupees(-short)} more than the ${rupees(f.cashPaidMinor)} the buyer actually paid.`;
  }

  /**
   * ⭐ THE LEDGER IDENTITY, CHECKED RATHER THAN ASSUMED.
   *
   * Demands raised debit the receivable with principal plus tax and
   * credit the advance with the principal. Receipts clear the receivable.
   * So advance + tax - receivable IS the cash collected, necessarily —
   * unless something was posted by hand, a demand was raised outside the
   * module, or a receipt landed against the wrong booking.
   *
   * ⚠️ AND THAT IS WORTH CATCHING HERE RATHER THAN LETTING THE PLUG
   * ABSORB IT. Without this check a ₹2,00,000 stray receipt would post
   * as ₹2,00,000 of "irrecoverable tax" — a plausible-looking expense
   * that nobody would ever question.
   */
  const impliedCash = f.advanceMinor + f.outputTaxMinor - f.receivableMinor;
  if (impliedCash !== f.cashPaidMinor) {
    return (
      `This booking's ledger does not agree with its receipts. The advance of ` +
      `${rupees(f.advanceMinor)} plus ${rupees(f.outputTaxMinor)} of output tax, less ` +
      `${rupees(f.receivableMinor)} of demands still unpaid, comes to ` +
      `${rupees(impliedCash)} — but ${rupees(f.cashPaidMinor)} has been collected. ` +
      `Something has been posted against this booking from outside the module, or a ` +
      `receipt has landed on the wrong one. Reconcile it before cancelling: a ` +
      `cancellation clears every balance, so it would bury the difference.`
    );
  }

  return null;
}

/**
 * ⭐ WHAT THE DEVELOPER EATS.
 *
 * The output tax that could not be reversed, because the section 34
 * window closed. It is a real cost of a cancelled sale and belongs in
 * the profit and loss account under its own name — not netted into
 * forfeiture income, where it would overstate the income the developer
 * actually kept and understate what cancellations cost them.
 */
export function irrecoverableTaxMinor(f: CancellationFacts): bigint {
  return (
    f.outputTaxMinor - (f.reversedCgstMinor + f.reversedSgstMinor + f.reversedIgstMinor)
  );
}

/* ------------------------------------------------------------------ */
/* FORMATTING                                                          */
/* ------------------------------------------------------------------ */

function rupees(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${groupIndian(whole)}.${paise}`;
}

/**
 * ⚠️ INDIAN GROUPING, NOT THOUSANDS. ₹1,00,000 and ₹100,000 are the same
 * number and only one of them reads as a lakh to the person cancelling
 * the booking. `toLocaleString("en-IN")` would do it, but this file is
 * pure and is also rendered on the server, where the ICU data behind
 * that locale is not guaranteed to be present.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
