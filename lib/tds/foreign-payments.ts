/**
 * Ordence — ⭐⭐⭐ TDS ON A PAYMENT IN FOREIGN CURRENCY — RULE 26
 * Batch 0106
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP, AS TWO EARLIER BATCHES LEFT IT
 * ══════════════════════════════════════════════════════════════════════
 * `server/tds/registry.ts` says it in its own comments, twice:
 *
 *   "A payment to a non-resident is frequently made in foreign currency
 *    and the TDS is computed on the rupee equivalent at the Rule 26
 *    telegraphic-transfer buying rate on the date the tax was required to
 *    be deducted. Ordence applies Rule 26 nowhere, so
 *    `chargeable_base_minor` is whatever rupee figure somebody typed."
 *
 * A typed rupee figure is not a defect anybody can see. It foots, it
 * agrees with the voucher, and it is wrong by the difference between
 * whatever rate the person used — the invoice-day mid off a website, the
 * rate on the bank statement two weeks later — and the rate the rule
 * names. On a US$100,000 fee that difference is comfortably ₹50,000 of
 * chargeable base, and the tax on it is ours under s.201(1) with interest
 * under s.201(1A) at 1% or 1.5% a month.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE THREE THINGS THE RULE FIXES, AND WHERE EACH IS ENFORCED
 * ══════════════════════════════════════════════════════════════════════
 *   ① THE SIDE OF THE SPREAD — telegraphic transfer BUYING.
 *      `lib/fx/statutory.ts#assertStatutoryQuote`, and the rate type
 *      column added to both rate tables by 0106.
 *   ② THE DATE — the date the tax is REQUIRED to be deducted.
 *      `deductionDateFor` below, and the CHECK on `tds_deductions` that
 *      refuses a row whose `fx_rate_date` is not its `deduction_date`.
 *   ③ THE DIRECTION — the TT buying rate OF the foreign currency, which
 *      is quoted as rupees per unit of it, never inverted from an INR
 *      quote. `assertStatutoryQuote` again.
 *
 * ⚠️ PURE. No database and no clock, like the rest of `lib/tds/`. The
 * rate lookup is `server/tds/foreign-payment.ts`.
 */

import { convertUnderStatute, RULE_26_TT_BUYING } from "@/lib/fx/statutory";
import type { FxConversion } from "@/lib/fx/convert";
import { describeQuote, type FxQuote } from "@/lib/fx/rates";
import { normaliseCurrencyCode } from "@/lib/fx/currency";

/** The rupee is the currency a deduction is measured, deposited and reported in. */
export const TDS_FUNCTIONAL_CURRENCY = "INR";

export class ForeignPaymentTdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForeignPaymentTdsError";
  }
}

/**
 * ⭐ WHICH EVENT FIXED THE DATE. Stored in the explanation, because
 * "31 March" without "because that is when it was credited" is a date
 * somebody has to reconstruct from two other systems at assessment.
 */
export type DeductionDateBasis = "credit" | "payment" | "same_day";

export type DeductionDateVerdict = {
  readonly deductionDate: string;
  readonly basis: DeductionDateBasis;
  readonly creditDate: string | null;
  readonly paymentDate: string | null;
  readonly explanation: string;
};

/**
 * ⭐⭐⭐ THE DATE THE TAX IS REQUIRED TO BE DEDUCTED.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT IS THE EARLIER OF CREDIT AND PAYMENT, AND IT IS NEITHER OF THE
 *    TWO DATES A SCREEN NATURALLY HAS TO HAND
 * ══════════════════════════════════════════════════════════════════════
 * s.195(1), like s.194C(1) and the rest of Chapter XVII-B, charges the
 * deduction "at the time of credit of such sum to the account of the
 * payee or at the time of payment thereof … whichever is earlier".
 *
 *   ⚠️ NOT THE INVOICE DATE. A consultant's invoice dated 28 March that
 *      is booked on 4 April was credited on 4 April. The invoice date is
 *      a fact about the counterparty's stationery.
 *   ⚠️ AND NOT THE PAYMENT DATE AUTOMATICALLY, which is the error this
 *      function exists to make impossible. The overwhelmingly common
 *      shape is credit first, remittance weeks later; taking the payment
 *      date then translates at the wrong day's dollar AND files the
 *      deduction in the wrong quarter AND starts the s.201(1A) interest
 *      clock from a date that flatters us.
 *
 * ⭐ AN ADVANCE IS THE CASE THAT MAKES THE PAYMENT DATE RIGHT — money out
 *    before anything is credited — and it is why this takes both dates
 *    and compares them rather than preferring one by rule.
 *
 * 🔴 IT REFUSES WHEN IT HAS NEITHER. "Whichever is earlier" of nothing is
 *    not a date, and a default of "today" would be a rate date chosen by
 *    the clock the operator happened to be looking at.
 */
export function deductionDateFor(args: {
  creditDate: string | null;
  paymentDate: string | null;
}): DeductionDateVerdict {
  const credit = args.creditDate ?? null;
  const payment = args.paymentDate ?? null;

  if (!credit && !payment) {
    throw new ForeignPaymentTdsError(
      "Neither a credit date nor a payment date was supplied, so the date the tax is " +
        "required to be deducted cannot be determined and nothing has been computed. " +
        "s.195(1) charges the deduction at the time of credit of the sum to the payee's " +
        "account or at the time of payment, whichever is earlier — with neither date there " +
        "is no 'earlier', and under Rule 26 that date is also the date whose telegraphic " +
        "transfer buying rate measures the payment in rupees. Record when the sum was " +
        "credited to the payee's account, or when it was paid.",
    );
  }

  if (credit && payment) {
    if (credit === payment) {
      return {
        deductionDate: credit,
        basis: "same_day",
        creditDate: credit,
        paymentDate: payment,
        explanation:
          `Tax is required to be deducted on ${credit}: the sum was credited to the payee's ` +
          `account and paid on the same day (s.195(1), "whichever is earlier").`,
      };
    }
    const earlier = credit < payment ? credit : payment;
    const basis: DeductionDateBasis = earlier === credit ? "credit" : "payment";
    return {
      deductionDate: earlier,
      basis,
      creditDate: credit,
      paymentDate: payment,
      explanation:
        basis === "credit"
          ? `Tax is required to be deducted on ${credit}, the date the sum was credited to ` +
            `the payee's account, which is earlier than the payment on ${payment} ` +
            `(s.195(1), "whichever is earlier"). ⚠️ The payment date does not fix this ` +
            `deduction, its quarter or, under Rule 26, its exchange rate.`
          : `Tax is required to be deducted on ${payment}, the date of payment, which is ` +
            `earlier than the credit on ${credit} — an advance (s.195(1), "whichever is ` +
            `earlier").`,
    };
  }

  if (credit) {
    return {
      deductionDate: credit,
      basis: "credit",
      creditDate: credit,
      paymentDate: null,
      explanation:
        `Tax is required to be deducted on ${credit}, the date the sum was credited to the ` +
        `payee's account. Nothing has been paid yet, so the credit is the earlier event ` +
        `(s.195(1)).`,
    };
  }

  const paid = payment as string;
  return {
    deductionDate: paid,
    basis: "payment",
    creditDate: null,
    paymentDate: paid,
    explanation:
      `Tax is required to be deducted on ${paid}, the date of payment. No credit to the ` +
      `payee's account has been recorded, so the payment is the earlier event (s.195(1)). ` +
      `⚠️ If the sum was in fact credited earlier, record that date — it, and not this one, ` +
      `fixes the deduction and its Rule 26 exchange rate.`,
  };
}

export type ForeignPaymentBase = {
  /** The rupee figure the section's rate is applied to. */
  readonly chargeableBaseMinor: bigint;
  readonly foreignAmountMinor: bigint;
  readonly foreignCurrency: string;
  /** The date the rate is for, which IS the deduction date. */
  readonly deductionDate: string;
  readonly quote: FxQuote;
  readonly conversion: FxConversion;
  readonly statutoryRef: string;
  /** The sentence stored on the deduction row. */
  readonly explanation: string;
};

/**
 * ⭐⭐⭐ THE RUPEE VALUE OF A PAYMENT IN FOREIGN CURRENCY, FOR TDS.
 *
 * ⚠️ THE RATE DATE IS NOT AN ARGUMENT. It is `deductionDate`, always,
 * because Rule 26 says so — offering it separately would offer somebody
 * the chance to pass the invoice date, and a caller who can pass the
 * wrong date eventually does.
 *
 * ⚠️ ROUNDING IS HALF-UP AND STATED. `RULE_26_TT_BUYING.rounding` carries
 * the reason: every other TDS figure in this codebase comes through
 * `applyRateBps`, which is half-up in exact integer arithmetic, and a
 * base rounded the other way would disagree with the tax computed on it
 * by a paisa in the cases where the argument is finest.
 */
export function foreignPaymentBase(args: {
  foreignAmountMinor: bigint;
  foreignCurrency: string;
  /** From `deductionDateFor`. Never an invoice date. */
  deductionDate: string;
  /** From `server/fx/rate-service.ts#requireStatutoryQuote`. */
  quote: FxQuote;
}): ForeignPaymentBase {
  const foreignCurrency = normaliseCurrencyCode(args.foreignCurrency);

  if (args.foreignAmountMinor < 0n) {
    throw new ForeignPaymentTdsError(
      "A payment of a negative amount is not a payment and no tax can be deducted from it. " +
        "Nothing has been computed.",
    );
  }

  const conversion = convertUnderStatute({
    amountMinor: args.foreignAmountMinor,
    from: foreignCurrency,
    to: TDS_FUNCTIONAL_CURRENCY,
    quote: args.quote,
    on: args.deductionDate,
    conversion: RULE_26_TT_BUYING,
  });

  return {
    chargeableBaseMinor: conversion.amountMinor,
    foreignAmountMinor: args.foreignAmountMinor,
    foreignCurrency,
    deductionDate: args.deductionDate,
    quote: conversion.quote,
    conversion,
    statutoryRef: RULE_26_TT_BUYING.statutoryRef,
    explanation:
      `The payment of ${foreignCurrency} is measured in rupees at the telegraphic transfer ` +
      `buying rate for ${foreignCurrency}/${TDS_FUNCTIONAL_CURRENCY} on ${args.deductionDate}, ` +
      `the date the tax is required to be deducted, as ${RULE_26_TT_BUYING.statutoryRef} ` +
      `requires. Rate: ${describeQuote(conversion.quote)}. Rounding: ${conversion.rounding} — ` +
      `the convention every other TDS figure in this register is computed with.`,
  };
}
