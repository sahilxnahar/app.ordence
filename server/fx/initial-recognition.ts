import "server-only";

/**
 * Ordence — ⭐⭐⭐ ① INITIAL RECOGNITION — AS 11 ¶9 / Ind AS 21 ¶21
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * When a foreign-currency invoice is ISSUED, two things must happen that
 * did not happen before this batch:
 *
 *   ① the document records what it is worth in the FUNCTIONAL currency,
 *      at the rate on ITS OWN DATE, frozen for ever
 *   ② the LEDGER receives that functional figure, not the foreign one
 *
 * 🔴 ② IS THE ONE THAT WAS SILENTLY WRONG. `server/accounting/post-sales.ts`
 * hardcodes `currency: "INR"` on every transaction it writes and formats
 * every leg with `formatMoneyPlain(x, "INR")`. A USD 10,000 invoice would
 * have posted 10,000 to a rupee receivables ledger — a hundred-fold
 * understatement that balances perfectly and appears on the balance sheet
 * as fact.
 *
 * ⚠️ THIS FUNCTION REFUSES RATHER THAN GUESSING. No rate for the invoice
 * date means the invoice is not issued. That is a harder failure than the
 * product's usual "post later from the backlog", and it is the right one:
 * an unposted invoice is visible in a backlog screen, whereas an invoice
 * posted at the wrong figure is invisible for ever.
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { normaliseCurrencyCode } from "@/lib/fx/currency";
import { EXACT_DATE } from "@/lib/fx/convert";
import { formatRateScaled } from "@/lib/fx/rates";
import {
  translatePurchaseDocument,
  translateTaxTotals,
  totalsAddUp,
  type ItcTaxHeads,
  type TaxTotals,
} from "@/lib/fx/translate";
import type { PurchaseLineFacts } from "@/lib/accounting/sales-posting";
import { purchaseInvoices } from "@/db/schema/purchases";
import { requireQuote } from "./rate-service";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export type RecognisedInvoice = {
  /**
   * ⭐ WHAT POSTS. Equal to the input when the invoice is already in the
   * functional currency, which is every invoice in the product today.
   */
  functionalTotals: TaxTotals;
  functionalCurrency: string;
  /** Null when no translation was needed. */
  rate: string | null;
  rateDate: string | null;
  rateSource: string | null;
};

/**
 * ⭐⭐⭐ RECOGNISE A SALES INVOICE AT ITS TRANSACTION-DATE RATE.
 *
 * ⚠️ THE RATE POLICY IS `EXACT_DATE` AND NOT THE CLOSING WINDOW. A
 * closing rate may reach back across a market holiday because a reporting
 * date is a fixed calendar date that the market may not have traded on.
 * An invoice date is chosen by the person raising it, so "there is no
 * rate for that day" is answerable by entering one — and reaching back
 * silently would measure a Monday invoice at Friday's rate with nothing
 * saying so.
 *
 * 🔴 IT IS A NO-OP FOR A FUNCTIONAL-CURRENCY INVOICE, and that is what
 * makes this batch safe to ship: every workspace today invoices in the
 * currency its books are kept in, so this returns the input unchanged and
 * touches no rate table.
 */
export async function recogniseSalesInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    invoiceCurrency: string;
    functionalCurrency: string;
    totals: TaxTotals;
  },
): Promise<RecognisedInvoice> {
  const invoiceCurrency = normaliseCurrencyCode(args.invoiceCurrency);
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);

  if (invoiceCurrency === functionalCurrency) {
    /**
     * ⚠️ THE COLUMNS ARE STILL WRITTEN. `functional_currency` and
     * `functional_total_minor` are populated even when no translation
     * happened, so a later reader never has to guess whether a NULL means
     * "same currency" or "nobody computed it". The CHECK in SQL 0101
     * depends on this being consistent.
     */
    await tx
      .update(salesInvoices)
      .set({
        functionalCurrency,
        functionalTotalMinor: args.totals.totalMinor,
        fxCarriedFunctionalMinor: args.totals.totalMinor,
      })
      .where(
        and(eq(salesInvoices.tenantId, args.tenantId), eq(salesInvoices.id, args.invoiceId)),
      );

    return {
      functionalTotals: args.totals,
      functionalCurrency,
      rate: null,
      rateDate: null,
      rateSource: null,
    };
  }

  const quote = await requireQuote(tx, {
    tenantId: args.tenantId,
    from: invoiceCurrency,
    to: functionalCurrency,
    on: args.invoiceDate,
    policy: EXACT_DATE,
  });

  const translated = translateTaxTotals({
    totals: args.totals,
    from: invoiceCurrency,
    to: functionalCurrency,
    quote,
    on: args.invoiceDate,
    policy: EXACT_DATE,
  });

  /**
   * 🔴 THE INVARIANT IS CHECKED HERE AND NOT ASSUMED. If the six
   * components ever stopped adding to the seventh, the journal would fail
   * `assertBalances` further down with a message about debits and credits
   * that says nothing about currency, and somebody would spend an
   * afternoon on it.
   */
  if (!totalsAddUp(translated.totals)) {
    throw new Error(
      `Translating ${args.invoiceNumber} from ${invoiceCurrency} to ${functionalCurrency} at ` +
        `${formatRateScaled(quote.rateScaled)} produced components that do not add to the total. ` +
        `The invoice has NOT been issued and nothing has changed.`,
    );
  }

  await tx
    .update(salesInvoices)
    .set({
      functionalCurrency,
      functionalTotalMinor: translated.totals.totalMinor,
      fxCarriedFunctionalMinor: translated.totals.totalMinor,
      fxRate: formatRateScaled(quote.rateScaled),
      fxRateDate: quote.rateDate,
      fxRateSource: quote.source,
    })
    .where(and(eq(salesInvoices.tenantId, args.tenantId), eq(salesInvoices.id, args.invoiceId)));

  return {
    functionalTotals: translated.totals,
    functionalCurrency,
    rate: formatRateScaled(quote.rateScaled),
    rateDate: quote.rateDate,
    rateSource: quote.source,
  };
}

/* ================================================================== */
/* ⭐⭐⭐ THE PAYABLES SIDE — over `0101`'s columns                       */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT 0101 LEFT OPEN, IN ITS OWN WORDS
 * ══════════════════════════════════════════════════════════════════════
 * "Purchase-invoice initial recognition is NOT wired, only sales. The
 * revaluation service reads `purchase_invoices.functional_total_minor`,
 * so payables raised before a purchase-side recognition path exists will
 * fall back to `0n` carrying and produce a full-value first restatement."
 *
 * That is not a missing feature. `openPurchaseInvoices()` in
 * `revaluation-service.ts` reads
 *
 *     r.carried ?? r.functionalTotalMinor ?? 0n
 *
 * and both were NULL for every payable ever recorded, so the first
 * reporting-date run restated a bill from NIL to its whole functional
 * value and took the ENTIRE invoice to the profit and loss account as an
 * exchange loss. The journal balances, the trial balance foots, and the
 * P&L is wrong by the value of the payables book.
 *
 * ⚠️ THIS IS THE SAME FUNCTION AS `recogniseSalesInvoice` WITH ONE
 * ADDITION, and the addition is the only thing the two sides do not
 * share: a sales invoice posts one set of totals, whereas a vendor bill
 * posts its tax split into the part that is an ASSET (eligible input tax)
 * and the part that is COST (blocked under Section 17(5)). The split is
 * apportioned from the translated head rather than translated again —
 * see `translatePurchaseDocument`.
 */
export type RecognisedPurchaseInvoice = {
  /** ⭐ WHAT POSTS. The header seven, functional currency. */
  functionalTotals: TaxTotals;
  /**
   * ⭐ THE TWO SYNTHETIC LINES `buildPurchasePosting` FOLDS OVER — one
   * carrying the whole taxable value and the eligible tax, one carrying
   * the blocked tax that becomes cost. It sums by `itcBlocked` and
   * nothing else, so two groups produce exactly the legs the individual
   * lines would have, at the functional figures.
   */
  functionalLines: readonly PurchaseLineFacts[];
  /** Reverse-charge tax in the functional currency, its own journal. */
  functionalRcmTaxMinor: bigint;
  functionalCurrency: string;
  rate: string | null;
  rateDate: string | null;
  rateSource: string | null;
};

function purchaseLineFacts(args: {
  totals: TaxTotals;
  eligibleTax: ItcTaxHeads;
  blockedTax: ItcTaxHeads;
}): readonly PurchaseLineFacts[] {
  return [
    {
      taxableValueMinor: args.totals.taxableValueMinor,
      cgstMinor: args.eligibleTax.cgstMinor,
      sgstMinor: args.eligibleTax.sgstMinor,
      igstMinor: args.eligibleTax.igstMinor,
      cessMinor: args.eligibleTax.cessMinor,
      itcBlocked: false,
    },
    {
      /**
       * ⚠️ NIL TAXABLE VALUE ON THE BLOCKED GROUP AND IT IS NOT AN
       * OVERSIGHT. `buildPurchasePosting` adds every line's taxable value
       * to expense whatever its eligibility, so carrying it on the first
       * group is the whole of it. Splitting it here as well would debit
       * the expense twice.
       */
      taxableValueMinor: 0n,
      cgstMinor: args.blockedTax.cgstMinor,
      sgstMinor: args.blockedTax.sgstMinor,
      igstMinor: args.blockedTax.igstMinor,
      cessMinor: args.blockedTax.cessMinor,
      itcBlocked: true,
    },
  ];
}

/**
 * ⭐⭐⭐ RECOGNISE A PURCHASE INVOICE AT ITS TRANSACTION-DATE RATE.
 *
 * ⚠️ `EXACT_DATE`, FOR THE REASON GIVEN ON THE SALES FUNCTION ABOVE. A
 * bill date is a fact on a document somebody is holding, so "no rate for
 * that day" is answerable by entering one, and reaching back silently
 * would measure a Monday bill at Friday's rate with nothing saying so.
 *
 * 🔴 IT REFUSES RATHER THAN GUESSING, and on this side refusing costs
 * more than it does on the sales side: the bill is not recorded at all,
 * so no input tax credit is claimed either. That is still the right way
 * round. A bill nobody could enter is a bill somebody chases; a bill
 * entered at a guessed rate is a wrong figure in the payables ledger, in
 * the P&L when it is revalued, and in the realised difference when it is
 * settled — and nothing anywhere says so.
 *
 * 🔴 IT IS A NO-OP FOR A BILL ALREADY IN THE FUNCTIONAL CURRENCY, which
 * is every bill in the product today: `recordPurchaseInvoice` never sets
 * `currency`, so the column takes its `INR` default. It still WRITES the
 * functional columns, which is the entire fix — a workspace whose books
 * are kept in anything but rupees has been raising rupee payables that
 * `openPurchaseInvoices` correctly treats as foreign and carried at nil.
 */
export async function recognisePurchaseInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    invoiceCurrency: string;
    functionalCurrency: string;
    totals: TaxTotals;
    /** Summed from the LINES, document currency. Section 17(5) only. */
    blockedTax: ItcTaxHeads;
    rcmTaxMinor: bigint;
  },
): Promise<RecognisedPurchaseInvoice> {
  const invoiceCurrency = normaliseCurrencyCode(args.invoiceCurrency);
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);

  const eligibleOf = (t: TaxTotals, blocked: ItcTaxHeads): ItcTaxHeads => ({
    cgstMinor: t.cgstMinor - blocked.cgstMinor,
    sgstMinor: t.sgstMinor - blocked.sgstMinor,
    igstMinor: t.igstMinor - blocked.igstMinor,
    cessMinor: t.cessMinor - blocked.cessMinor,
  });

  if (invoiceCurrency === functionalCurrency) {
    /**
     * ⚠️ THE COLUMNS ARE WRITTEN EVEN THOUGH NOTHING WAS TRANSLATED —
     * see the same branch on the sales function. `fx_carried_functional_
     * minor` is what AS 11 ¶13 measures a settlement against and what the
     * restatement moves; leaving it NULL is what produced the full-value
     * first restatement this batch exists to end.
     */
    await tx
      .update(purchaseInvoices)
      .set({
        functionalCurrency,
        functionalTotalMinor: args.totals.totalMinor,
        fxCarriedFunctionalMinor: args.totals.totalMinor,
      })
      .where(
        and(
          eq(purchaseInvoices.tenantId, args.tenantId),
          eq(purchaseInvoices.id, args.invoiceId),
        ),
      );

    return {
      functionalTotals: args.totals,
      functionalLines: purchaseLineFacts({
        totals: args.totals,
        eligibleTax: eligibleOf(args.totals, args.blockedTax),
        blockedTax: args.blockedTax,
      }),
      functionalRcmTaxMinor: args.rcmTaxMinor,
      functionalCurrency,
      rate: null,
      rateDate: null,
      rateSource: null,
    };
  }

  const quote = await requireQuote(tx, {
    tenantId: args.tenantId,
    from: invoiceCurrency,
    to: functionalCurrency,
    on: args.invoiceDate,
    policy: EXACT_DATE,
  });

  const translated = translatePurchaseDocument({
    totals: args.totals,
    blockedTax: args.blockedTax,
    rcmTaxMinor: args.rcmTaxMinor,
    from: invoiceCurrency,
    to: functionalCurrency,
    quote,
    on: args.invoiceDate,
    policy: EXACT_DATE,
  });

  /**
   * 🔴 CHECKED HERE AND NOT ASSUMED, exactly as on the sales side. If the
   * six components stopped adding to the seventh, `assertPurchaseBalances`
   * would refuse the journal with a message about debits and credits that
   * says nothing about currency.
   */
  if (!totalsAddUp(translated.totals)) {
    throw new Error(
      `Translating ${args.invoiceNumber} from ${invoiceCurrency} to ${functionalCurrency} at ` +
        `${formatRateScaled(quote.rateScaled)} produced components that do not add to the total. ` +
        `The bill has NOT been recorded and nothing has changed.`,
    );
  }

  await tx
    .update(purchaseInvoices)
    .set({
      functionalCurrency,
      functionalTotalMinor: translated.totals.totalMinor,
      fxCarriedFunctionalMinor: translated.totals.totalMinor,
      fxRate: formatRateScaled(quote.rateScaled),
      fxRateDate: quote.rateDate,
      fxRateSource: quote.source,
    })
    .where(
      and(eq(purchaseInvoices.tenantId, args.tenantId), eq(purchaseInvoices.id, args.invoiceId)),
    );

  return {
    functionalTotals: translated.totals,
    functionalLines: purchaseLineFacts({
      totals: translated.totals,
      eligibleTax: translated.eligibleTax,
      blockedTax: translated.blockedTax,
    }),
    functionalRcmTaxMinor: translated.rcmTaxMinor,
    functionalCurrency,
    rate: formatRateScaled(quote.rateScaled),
    rateDate: quote.rateDate,
    rateSource: quote.source,
  };
}
