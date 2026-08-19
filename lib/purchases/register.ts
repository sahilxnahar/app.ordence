/**
 * Ordence — The ITC Register, and Reconciling a Purchase Invoice
 * Version: v0.33.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * Two jobs, both of which exist because a figure that does not add up on
 * the INPUT side is invisible in a way the output side never is: nobody
 * outside the company ever sees the ITC register, so nobody outside the
 * company ever adds it up until an officer does.
 *
 *   1. `summariseItcRegister` — what a period claimed, blocked, deferred
 *      and reversed, per head, in the shape GSTR-3B Table 4 wants.
 *   2. `reconcilePurchaseInvoice` — does a stored purchase invoice header
 *      agree with its own lines, in tax AND in the ITC split?
 */

import type { ItcMovementReason, ItcRegisterStatus } from "@/db/schema/purchases";
import { addHeads, sumHeads, ZERO_HEADS, type TaxHeads } from "./itc";

/* ------------------------------------------------------------------ */
/* SUMMARY                                                             */
/* ------------------------------------------------------------------ */

export type RegisterMovement = {
  taxPeriod: string;
  status: ItcRegisterStatus;
  reason: ItcMovementReason;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
};

export type ItcPeriodSummary = {
  taxPeriod: string;
  /** GSTR-3B Table 4(A) — ITC available. */
  claimed: TaxHeads;
  /** Determined blocked. Never enters the ledger; kept for the working. */
  blocked: TaxHeads;
  /** Eligible but not yet claimable — Section 16(2) not satisfied. */
  deferred: TaxHeads;
  /** GSTR-3B Table 4(B) — ITC reversed. */
  reversed: TaxHeads;
  /** ⭐ Table 4(C): net ITC available = 4(A) − 4(B). Per head. */
  net: TaxHeads;

  claimedTotalMinor: bigint;
  blockedTotalMinor: bigint;
  deferredTotalMinor: bigint;
  reversedTotalMinor: bigint;
  netTotalMinor: bigint;

  /** Reversals split by which rule produced them. For the working papers. */
  reversalsByReason: Partial<Record<ItcMovementReason, bigint>>;
};

/**
 * Roll a period's movements up.
 *
 * ⚠️ `net` CAN GO NEGATIVE AND IS NOT CLAMPED. A month in which a large
 * Rule 37 reversal lands on a month of small purchases produces a
 * negative net, and that is exactly what GSTR-3B shows — a net reversal,
 * payable in cash. Clamping at zero would silently absorb the excess and
 * under-report the liability, which is the direction that attracts
 * interest under Section 50.
 *
 * ⚠️ `blocked` IS TRACKED BUT IS **NOT** PART OF `net`. A blocked credit
 * never enters the electronic credit ledger, so it is neither availed nor
 * reversed — it is cost. It is summarised because "what did we NOT claim,
 * and under which clause" is the first question at an audit, and a
 * register that only records what was claimed cannot answer it.
 */
export function summariseItcRegister(
  movements: readonly RegisterMovement[],
): ItcPeriodSummary[] {
  const byPeriod = new Map<string, ItcPeriodSummary>();

  for (const movement of movements) {
    let summary = byPeriod.get(movement.taxPeriod);
    if (!summary) {
      summary = {
        taxPeriod: movement.taxPeriod,
        claimed: { ...ZERO_HEADS },
        blocked: { ...ZERO_HEADS },
        deferred: { ...ZERO_HEADS },
        reversed: { ...ZERO_HEADS },
        net: { ...ZERO_HEADS },
        claimedTotalMinor: 0n,
        blockedTotalMinor: 0n,
        deferredTotalMinor: 0n,
        reversedTotalMinor: 0n,
        netTotalMinor: 0n,
        reversalsByReason: {},
      };
      byPeriod.set(movement.taxPeriod, summary);
    }

    const heads: TaxHeads = {
      cgstMinor: movement.cgstMinor,
      sgstMinor: movement.sgstMinor,
      igstMinor: movement.igstMinor,
      cessMinor: movement.cessMinor,
    };

    switch (movement.status) {
      case "claimed":
        summary.claimed = addHeads(summary.claimed, heads);
        break;
      case "blocked":
        summary.blocked = addHeads(summary.blocked, heads);
        break;
      case "deferred":
        summary.deferred = addHeads(summary.deferred, heads);
        break;
      case "reversed": {
        summary.reversed = addHeads(summary.reversed, heads);
        const already = summary.reversalsByReason[movement.reason] ?? 0n;
        summary.reversalsByReason[movement.reason] = already + sumHeads(heads);
        break;
      }
    }
  }

  for (const summary of byPeriod.values()) {
    summary.net = {
      cgstMinor: summary.claimed.cgstMinor - summary.reversed.cgstMinor,
      sgstMinor: summary.claimed.sgstMinor - summary.reversed.sgstMinor,
      igstMinor: summary.claimed.igstMinor - summary.reversed.igstMinor,
      cessMinor: summary.claimed.cessMinor - summary.reversed.cessMinor,
    };
    summary.claimedTotalMinor = sumHeads(summary.claimed);
    summary.blockedTotalMinor = sumHeads(summary.blocked);
    summary.deferredTotalMinor = sumHeads(summary.deferred);
    summary.reversedTotalMinor = sumHeads(summary.reversed);
    summary.netTotalMinor = sumHeads(summary.net);
  }

  return [...byPeriod.values()].sort((a, b) =>
    a.taxPeriod < b.taxPeriod ? -1 : a.taxPeriod > b.taxPeriod ? 1 : 0,
  );
}

/* ------------------------------------------------------------------ */
/* RECONCILIATION                                                      */
/* ------------------------------------------------------------------ */

export type PurchaseProblem = {
  field: string;
  expectedMinor: bigint;
  actualMinor: bigint;
  message: string;
};

export type PurchaseHeaderFacts = {
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  roundOffMinor: bigint;
  totalMinor: bigint;
  itcEligibleTaxMinor: bigint;
  itcBlockedTaxMinor: bigint;
};

export type PurchaseLineFacts = {
  amountMinor: bigint;
  discountMinor: bigint;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  itcEligibleTaxMinor: bigint;
  itcBlockedTaxMinor: bigint;
};

/**
 * Does a stored purchase invoice agree with its own lines?
 *
 * ⚠️ THE DATABASE ASKS THE SAME QUESTION AT COMMIT (SQL 0023 §6), and
 * this is not a duplicate of it. The deferred constraint trigger is the
 * GUARANTEE — it holds for the import script and the psql session too.
 * This function exists to produce a SENTENCE naming which figure is off
 * and by how much, for the person looking at a document that has already
 * gone wrong.
 *
 * ⚠️ IT CHECKS THE ITC SPLIT AS WELL AS THE TAX, AND THAT SECOND CHECK IS
 * THE ONE WORTH HAVING. Tax that does not add up is caught by anyone who
 * reads the invoice. An ITC split that does not add up is caught by
 * nobody: the credit claimed goes into a return, the credit blocked goes
 * into the cost of a building, and if they do not together equal the tax
 * on the document then some tax has gone to neither — the return and the
 * books diverge by exactly that amount, permanently, with no error.
 */
export function reconcilePurchaseInvoice(args: {
  header: PurchaseHeaderFacts;
  lines: readonly PurchaseLineFacts[];
}): PurchaseProblem[] {
  const problems: PurchaseProblem[] = [];

  let amount = 0n;
  let discount = 0n;
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;
  let itcEligible = 0n;
  let itcBlocked = 0n;

  for (const line of args.lines) {
    amount += line.amountMinor;
    discount += line.discountMinor;
    taxable += line.taxableValueMinor;
    cgst += line.cgstMinor;
    sgst += line.sgstMinor;
    igst += line.igstMinor;
    cess += line.cessMinor;
    itcEligible += line.itcEligibleTaxMinor;
    itcBlocked += line.itcBlockedTaxMinor;
  }

  const checks: [string, bigint, bigint, string][] = [
    [
      "subtotal",
      amount,
      args.header.subtotalMinor,
      "The invoice subtotal disagrees with the sum of its lines.",
    ],
    [
      "discount",
      discount,
      args.header.discountMinor,
      "The invoice discount disagrees with the sum of the line discounts.",
    ],
    [
      "taxable value",
      taxable,
      args.header.taxableValueMinor,
      "The taxable value disagrees with the sum of its lines — which means the " +
        "figure a GSTR-2B reconciliation matches on is not the figure the lines " +
        "support.",
    ],
    ["CGST", cgst, args.header.cgstMinor, "The CGST disagrees with the lines."],
    ["SGST/UTGST", sgst, args.header.sgstMinor, "The SGST disagrees with the lines."],
    ["IGST", igst, args.header.igstMinor, "The IGST disagrees with the lines."],
    ["cess", cess, args.header.cessMinor, "The cess disagrees with the lines."],
    [
      "eligible ITC",
      itcEligible,
      args.header.itcEligibleTaxMinor,
      "⭐ The eligible input tax credit on the invoice disagrees with the sum of " +
        "the per-line determinations. The figure that reaches the return is not " +
        "the figure the determinations support, and no screen shows the gap.",
    ],
    [
      "blocked ITC",
      itcBlocked,
      args.header.itcBlockedTaxMinor,
      "⭐ The blocked input tax credit disagrees with the lines. Blocked tax is " +
        "capitalised into cost, so the gap lands in the books rather than in the " +
        "return — and the two then differ by an amount nobody is looking for.",
    ],
  ];

  for (const [field, expected, actual, note] of checks) {
    if (expected !== actual) {
      problems.push({
        field,
        expectedMinor: expected,
        actualMinor: actual,
        message: `${note} The lines total ${expected} paise; the invoice says ${actual} paise.`,
      });
    }
  }

  /* --- The two identities that must hold on the header alone ----- */

  const headerTax =
    args.header.cgstMinor +
    args.header.sgstMinor +
    args.header.igstMinor +
    args.header.cessMinor;
  const headerItc = args.header.itcEligibleTaxMinor + args.header.itcBlockedTaxMinor;

  if (headerItc !== headerTax) {
    problems.push({
      field: "ITC split",
      expectedMinor: headerTax,
      actualMinor: headerItc,
      message:
        `⭐ Every paisa of tax on a purchase is either claimable or blocked. This ` +
        `invoice carries ${headerTax} paise of tax and accounts for ${headerItc} ` +
        `paise of it. The difference belongs to neither the return nor the cost of ` +
        `the building, and nothing anywhere would report it.`,
    });
  }

  const expectedTotal =
    args.header.taxableValueMinor + headerTax + args.header.roundOffMinor;
  if (expectedTotal !== args.header.totalMinor) {
    problems.push({
      field: "total",
      expectedMinor: expectedTotal,
      actualMinor: args.header.totalMinor,
      message:
        `The invoice total should be taxable value plus tax plus round-off — ` +
        `${expectedTotal} paise — and it says ${args.header.totalMinor} paise.`,
    });
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* TAX PERIODS                                                         */
/* ------------------------------------------------------------------ */

/**
 * The `YYYY-MM` period a civil day belongs to.
 *
 * ⚠️ A STRING, NOT A DATE, AND SLICED RATHER THAN PARSED. `new Date(day)`
 * followed by `getMonth()` reads the month in the LOCAL zone, so a bill
 * dated the first of a month lands in the previous period on any machine
 * west of UTC — and a credit claimed in the wrong month is a credit
 * claimed in a return that has already been filed.
 */
export function taxPeriodOf(day: string): string {
  return day.slice(0, 7);
}

/**
 * ⭐ The last period in which a credit for `invoiceDate` may still be
 * claimed, under Section 16(4).
 *
 * The limit is 30 November following the end of the financial year in
 * which the invoice was issued, or the date of filing the annual return
 * for that year, whichever is EARLIER. This returns the November period,
 * which is the one a purchase-entry screen needs — the annual-return date
 * is not knowable in advance and only ever makes the deadline sooner.
 *
 * ⚠️ THE DEADLINE IS A CLIFF, NOT A TAPER. A credit claimed in the
 * December return for a March invoice two financial years earlier is not
 * reduced or penalised — it is simply not available, permanently, and the
 * money is gone. On a developer's purchase volume the invoices most
 * likely to be late are exactly the large ones, because a large bill is
 * the one that sits in a dispute for eight months.
 */
export function itcClaimDeadlinePeriod(invoiceDate: string): string {
  const year = Number(invoiceDate.slice(0, 4));
  const month = Number(invoiceDate.slice(5, 7));
  // The Indian financial year runs 1 April to 31 March.
  const fyStartYear = month >= 4 ? year : year - 1;
  return `${fyStartYear + 1}-11`;
}

export function isWithinItcDeadline(invoiceDate: string, claimPeriod: string): boolean {
  return claimPeriod <= itcClaimDeadlinePeriod(invoiceDate);
}
