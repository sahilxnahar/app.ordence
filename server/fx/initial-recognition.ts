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
import { translateTaxTotals, totalsAddUp, type TaxTotals } from "@/lib/fx/translate";
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
