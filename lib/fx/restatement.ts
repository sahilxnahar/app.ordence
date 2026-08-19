/**
 * Ordence — ⭐⭐⭐ THE THREE FX MOMENTS OF AS 11 / Ind AS 21
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE MOMENTS, ROUTINELY CONFLATED INTO ONE
 * ══════════════════════════════════════════════════════════════════════
 * Accounting Standard 11 (Companies (Accounting Standards) Rules) and
 * Ind AS 21 (Companies (Indian Accounting Standards) Rules) both describe
 * three separate events, and every one of them uses a DIFFERENT rate.
 * Software gets this wrong by using the invoice rate for all three, which
 * produces books that balance and a P&L that is missing the exchange
 * difference entirely.
 *
 * ① INITIAL RECOGNITION — AS 11 ¶9, Ind AS 21 ¶21.
 *    The transaction is recorded at the exchange rate at the DATE OF THE
 *    TRANSACTION. Not the date of entry, not the month-end rate. This
 *    figure is what posts to the ledger, and it never moves again.
 *
 * ② REPORTING-DATE RESTATEMENT — AS 11 ¶11, Ind AS 21 ¶23.
 *    🔴🔴 AND THIS IS THE ONE THAT IS GOT BACKWARDS.
 *
 *      • MONETARY items — a right to receive or an obligation to deliver
 *        a FIXED OR DETERMINABLE NUMBER OF CURRENCY UNITS — are restated
 *        at the CLOSING RATE. Receivables, payables, loans, foreign-
 *        currency bank balances. The difference goes to the profit and
 *        loss account (AS 11 ¶13).
 *
 *      • NON-MONETARY items carried at HISTORICAL COST are NOT restated.
 *        They stay at the rate on the date of the transaction, for ever.
 *        Fixed assets bought in dollars, inventory, prepaid expenses,
 *        advances paid for goods not yet received, equity.
 *
 *    ⚠️ RESTATING A NON-MONETARY ITEM IS THE CLASSIC ERROR AND IT IS
 *    SILENT. Revaluing a machine bought for USD 100,000 in 2019 at
 *    today's rate quietly writes up a fixed asset and puts a fictitious
 *    gain in the P&L — and both the balance sheet and the trial balance
 *    still foot perfectly. Nothing complains. `isMonetary()` below is
 *    what stands between this product and that entry, and
 *    `restateAtClosingRate()` REFUSES to produce a difference for a
 *    non-monetary item rather than returning zero, because zero looks
 *    like a computation that ran.
 *
 * ③ SETTLEMENT — AS 11 ¶13, Ind AS 21 ¶28.
 *    🔴 THE REALISED DIFFERENCE IS MEASURED AGAINST THE RATE THE ITEM WAS
 *    LAST CARRIED AT, NOT AGAINST THE ORIGINAL INVOICE RATE.
 *
 *    An invoice raised in December at 82, restated at 31 March to 83, and
 *    settled in May at 85 produces a gain of 1 in the year of the
 *    restatement and a gain of 2 in the year of settlement. Measuring
 *    settlement against the December rate books the whole 3 in the second
 *    year and DOUBLE-COUNTS the 1 that was already taken to the P&L of the
 *    first — overstating this year's profit and leaving last year's
 *    restatement stranded on the balance sheet with nothing to reverse it.
 *
 *    So `settlementDifference()` takes `carriedFunctionalMinor` and there
 *    is deliberately no argument for the original invoice rate.
 *
 * ⚠️ PURE. No database, no clock.
 */

import { assertKnownCurrency, normaliseCurrencyCode } from "./currency";
import {
  convertMinor,
  EXACT_DATE,
  type FxConversion,
  type RoundingMode,
  type StalenessPolicy,
} from "./convert";
import { FxRateError, type FxQuote } from "./rates";

/* ================================================================== */
/* MONETARY vs NON-MONETARY                                            */
/* ================================================================== */

/**
 * 🔴 THE CLASSIFICATION IS A CLOSED LIST AND IT IS DELIBERATELY NOT A
 * BOOLEAN ON A ROW. A boolean somebody sets per record is a boolean
 * somebody sets wrongly, and the consequence is invisible. The kind of
 * thing an item IS decides the treatment, so the kind is what is carried.
 */
export const MONETARY_ITEM_KINDS = [
  /** A customer owes us a fixed number of foreign currency units. */
  "trade_receivable",
  /** We owe a vendor a fixed number of foreign currency units. */
  "trade_payable",
  /** A bank account denominated in a foreign currency. */
  "foreign_bank_balance",
  /** Cash in hand in a foreign currency. */
  "foreign_cash",
  /** Money lent or borrowed, repayable in a fixed number of units. */
  "loan_receivable",
  "loan_payable",
  /** Accrued interest, statutory dues payable in foreign currency. */
  "other_monetary_asset",
  "other_monetary_liability",
] as const;

/**
 * ⚠️ EVERY ONE OF THESE STAYS AT ITS HISTORICAL RATE FOR EVER.
 *
 * ⭐ `advance_to_supplier` AND `advance_from_customer` ARE HERE ON
 * PURPOSE AND THEY ARE THE ONES PEOPLE ARGUE ABOUT. An advance paid for
 * goods not yet received is not a right to receive CURRENCY, it is a
 * right to receive GOODS — Ind AS 21 ¶16 is explicit that the essential
 * feature of a monetary item is a right to receive a fixed or
 * determinable number of units of currency. The advance will be consumed
 * by a delivery, never repaid in cash, so restating it invents a gain on
 * a machine that has not arrived. (If the contract makes the advance
 * REFUNDABLE IN CASH, it has become a receivable and should be recorded
 * as one; that is a change of fact, not a change of policy.)
 */
export const NON_MONETARY_ITEM_KINDS = [
  "fixed_asset",
  "inventory",
  "prepaid_expense",
  "advance_to_supplier",
  "advance_from_customer",
  "equity_investment",
  "share_capital",
  "goodwill",
] as const;

export type MonetaryItemKind = (typeof MONETARY_ITEM_KINDS)[number];
export type NonMonetaryItemKind = (typeof NON_MONETARY_ITEM_KINDS)[number];
export type FxItemKind = MonetaryItemKind | NonMonetaryItemKind;

export const FX_ITEM_KINDS: readonly FxItemKind[] = [
  ...MONETARY_ITEM_KINDS,
  ...NON_MONETARY_ITEM_KINDS,
];

export class FxClassificationError extends Error {}

/**
 * 🔴 REFUSES BY NAME. An item kind this engine has never heard of must
 * not fall through to "monetary" (which would restate a building) or to
 * "non-monetary" (which would leave a receivable un-restated and the
 * exchange difference out of the P&L). It says which kind it does not
 * know, and nothing is restated.
 */
export function isMonetary(kind: string): boolean {
  if ((MONETARY_ITEM_KINDS as readonly string[]).includes(kind)) return true;
  if ((NON_MONETARY_ITEM_KINDS as readonly string[]).includes(kind)) return false;
  throw new FxClassificationError(
    `"${kind}" is not an item kind this engine classifies, so it cannot be told whether ` +
      `AS 11 ¶11 restates it at the closing rate or leaves it at historical cost. Nothing has ` +
      `been restated. Add it to MONETARY_ITEM_KINDS or NON_MONETARY_ITEM_KINDS with a reason.`,
  );
}

/* ================================================================== */
/* ① INITIAL RECOGNITION                                               */
/* ================================================================== */

export type InitialRecognition = {
  readonly foreignAmountMinor: bigint;
  readonly foreignCurrency: string;
  readonly functionalAmountMinor: bigint;
  readonly functionalCurrency: string;
  readonly conversion: FxConversion;
  /**
   * ⭐ WHAT THE ITEM IS NOW CARRIED AT. On day one this equals the
   * functional amount; after a restatement it is the restated figure.
   * Settlement measures against THIS, never against the invoice.
   */
  readonly carriedFunctionalMinor: bigint;
};

/**
 * ⭐ AS 11 ¶9 / Ind AS 21 ¶21 — the transaction, at the transaction-date
 * rate. `transactionDate` is required and the policy defaults to exact,
 * so an invoice cannot be recognised at last week's rate by omission.
 */
export function initialRecognition(args: {
  foreignAmountMinor: bigint;
  foreignCurrency: string;
  functionalCurrency: string;
  quote: FxQuote;
  transactionDate: string;
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): InitialRecognition {
  const foreignCurrency = normaliseCurrencyCode(args.foreignCurrency);
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);
  assertKnownCurrency(foreignCurrency);
  assertKnownCurrency(functionalCurrency);

  const conversion = convertMinor({
    amountMinor: args.foreignAmountMinor,
    from: foreignCurrency,
    to: functionalCurrency,
    quote: args.quote,
    on: args.transactionDate,
    policy: args.policy ?? EXACT_DATE,
    rounding: args.rounding,
  });

  return {
    foreignAmountMinor: args.foreignAmountMinor,
    foreignCurrency,
    functionalAmountMinor: conversion.amountMinor,
    functionalCurrency,
    conversion,
    carriedFunctionalMinor: conversion.amountMinor,
  };
}

/* ================================================================== */
/* ② REPORTING-DATE RESTATEMENT                                        */
/* ================================================================== */

export type Restatement = {
  readonly kind: FxItemKind;
  readonly monetary: boolean;
  /** True only when the closing rate was actually applied. */
  readonly restated: boolean;
  readonly foreignAmountMinor: bigint;
  readonly foreignCurrency: string;
  readonly functionalCurrency: string;
  /** What it was carried at before this run. */
  readonly carriedFunctionalMinor: bigint;
  /** What it is carried at after. Unchanged for a non-monetary item. */
  readonly restatedFunctionalMinor: bigint;
  /**
   * ⭐ POSITIVE IS A GAIN IN THE READER'S SIGN FOR AN ASSET. See
   * `exchangeDifferenceForPl` below for the sign on a liability.
   */
  readonly differenceMinor: bigint;
  readonly conversion: FxConversion | null;
  /** Why nothing happened, when nothing happened. Never null on a skip. */
  readonly reason: string | null;
};

/**
 * ⭐⭐⭐ AS 11 ¶11 / Ind AS 21 ¶23 — THE RESTATEMENT.
 *
 * 🔴 A NON-MONETARY ITEM COMES BACK WITH `restated: false`, THE CARRYING
 * AMOUNT UNTOUCHED, A ZERO DIFFERENCE **AND A REASON**. The reason is the
 * point: a caller that receives zero cannot tell "we computed the
 * difference and it was nil" from "this must not be revalued", and those
 * two are opposite instructions to whoever writes the next feature.
 */
export function restateAtClosingRate(args: {
  kind: FxItemKind;
  foreignAmountMinor: bigint;
  foreignCurrency: string;
  functionalCurrency: string;
  /** What the books currently carry this at, in functional currency. */
  carriedFunctionalMinor: bigint;
  closingQuote: FxQuote;
  reportingDate: string;
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): Restatement {
  const foreignCurrency = normaliseCurrencyCode(args.foreignCurrency);
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);
  const monetary = isMonetary(args.kind);

  const base = {
    kind: args.kind,
    monetary,
    foreignAmountMinor: args.foreignAmountMinor,
    foreignCurrency,
    functionalCurrency,
    carriedFunctionalMinor: args.carriedFunctionalMinor,
  } as const;

  if (!monetary) {
    return {
      ...base,
      restated: false,
      restatedFunctionalMinor: args.carriedFunctionalMinor,
      differenceMinor: 0n,
      conversion: null,
      reason:
        `A ${args.kind} is a NON-MONETARY item carried at historical cost. AS 11 ¶11(b) leaves ` +
        `it at the exchange rate on the date of the transaction and does NOT restate it at the ` +
        `closing rate. Restating it would write the asset up and put an unrealised gain in the ` +
        `P&L that no cash will ever follow.`,
    };
  }

  /**
   * ⚠️ SAME CURRENCY IS NOT A CONVERSION, IT IS AN IDENTITY. A monetary
   * item already in the functional currency has no exchange difference —
   * running it through a rate would be the surest way to invent one.
   */
  if (foreignCurrency === functionalCurrency) {
    return {
      ...base,
      restated: false,
      restatedFunctionalMinor: args.carriedFunctionalMinor,
      differenceMinor: 0n,
      conversion: null,
      reason:
        `Already denominated in the functional currency (${functionalCurrency}), so there is no ` +
        `foreign currency to restate.`,
    };
  }

  const conversion = convertMinor({
    amountMinor: args.foreignAmountMinor,
    from: foreignCurrency,
    to: functionalCurrency,
    quote: args.closingQuote,
    on: args.reportingDate,
    policy: args.policy ?? EXACT_DATE,
    rounding: args.rounding,
  });

  return {
    ...base,
    restated: true,
    restatedFunctionalMinor: conversion.amountMinor,
    differenceMinor: conversion.amountMinor - args.carriedFunctionalMinor,
    conversion,
    reason: null,
  };
}

/**
 * ⭐ THE SIGN, ONCE, WHERE IT BELONGS.
 *
 * A restatement difference is computed on the CARRYING AMOUNT, so the same
 * arithmetic means opposite things on the two sides of the balance sheet:
 *
 *   • an ASSET (receivable, bank) worth MORE in functional terms is a GAIN
 *   • a LIABILITY (payable, loan) worth MORE in functional terms is a LOSS,
 *     because we now owe more of our own money than we did
 *
 * ⚠️ GETTING THIS WRONG DOES NOT UNBALANCE ANYTHING. The journal still
 * foots; the P&L is simply the wrong way up on the payables. Hence one
 * function, used by the posting builder and nothing else deciding for
 * itself.
 */
const LIABILITY_KINDS: ReadonlySet<string> = new Set([
  "trade_payable",
  "loan_payable",
  "other_monetary_liability",
  "advance_from_customer",
  "share_capital",
]);

export function isLiabilityKind(kind: FxItemKind): boolean {
  return LIABILITY_KINDS.has(kind);
}

/**
 * The amount that reaches the profit and loss account, positive for a
 * gain and negative for a loss, from a restatement of any kind of item.
 */
export function exchangeDifferenceForPl(r: Restatement): bigint {
  if (!r.restated) return 0n;
  return isLiabilityKind(r.kind) ? -r.differenceMinor : r.differenceMinor;
}

/* ================================================================== */
/* ③ SETTLEMENT                                                        */
/* ================================================================== */

export type SettlementDifference = {
  readonly foreignSettledMinor: bigint;
  readonly foreignCurrency: string;
  readonly functionalCurrency: string;
  /** What the settled portion was carried at before the cash moved. */
  readonly carriedFunctionalMinor: bigint;
  /** What it turned into at the settlement-date rate. */
  readonly settledFunctionalMinor: bigint;
  /** Settlement rate less carrying rate, on the carrying amount. */
  readonly realisedDifferenceMinor: bigint;
  readonly conversion: FxConversion;
};

/**
 * ⭐⭐⭐ AS 11 ¶13 / Ind AS 21 ¶28 — THE REALISED DIFFERENCE.
 *
 * 🔴 THERE IS NO ARGUMENT HERE FOR THE ORIGINAL INVOICE RATE, AND THAT IS
 * THE WHOLE DESIGN. `carriedFunctionalMinor` is what the books say the
 * settled portion is worth THE MOMENT BEFORE the cash moves — the initial
 * recognition figure if the item has never been restated, and the restated
 * figure if it has. Handing this function an invoice rate instead would
 * re-book a difference that last year's P&L already took.
 *
 * ⚠️ ON A PARTIAL SETTLEMENT the caller passes the carrying amount OF THE
 * PART BEING SETTLED, pro-rated from the whole. Passing the carrying
 * amount of the entire invoice against a part payment books the whole
 * exchange difference on the first instalment.
 */
export function settlementDifference(args: {
  foreignSettledMinor: bigint;
  foreignCurrency: string;
  functionalCurrency: string;
  carriedFunctionalMinor: bigint;
  settlementQuote: FxQuote;
  settlementDate: string;
  policy?: StalenessPolicy;
  rounding?: RoundingMode;
}): SettlementDifference {
  const foreignCurrency = normaliseCurrencyCode(args.foreignCurrency);
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);

  if (args.foreignSettledMinor < 0n) {
    throw new FxRateError(
      "A settlement of a negative amount is a refund and belongs on the other side of the " +
        "transaction. Direction is carried by which document is being settled, never by the sign.",
    );
  }

  const conversion = convertMinor({
    amountMinor: args.foreignSettledMinor,
    from: foreignCurrency,
    to: functionalCurrency,
    quote: args.settlementQuote,
    on: args.settlementDate,
    policy: args.policy ?? EXACT_DATE,
    rounding: args.rounding,
  });

  return {
    foreignSettledMinor: args.foreignSettledMinor,
    foreignCurrency,
    functionalCurrency,
    carriedFunctionalMinor: args.carriedFunctionalMinor,
    settledFunctionalMinor: conversion.amountMinor,
    realisedDifferenceMinor: conversion.amountMinor - args.carriedFunctionalMinor,
    conversion,
  };
}

/**
 * ⭐ THE CARRYING AMOUNT OF A PART, PRO-RATED WITHOUT LOSING A PAISA.
 *
 * ⚠️ DIVIDED ONCE, AND THE FLOOR'S REMAINDER STAYS WITH THE UNSETTLED
 * BALANCE — the same rule `lib/inventory/valuation.ts` applies to a stock
 * layer, for the same reason. Settling an invoice in full through a series
 * of parts therefore releases exactly the carrying amount and no more.
 */
export function carriedForPart(args: {
  carriedFunctionalMinor: bigint;
  foreignTotalMinor: bigint;
  foreignPartMinor: bigint;
}): bigint {
  if (args.foreignTotalMinor === 0n) return 0n;
  if (args.foreignPartMinor === args.foreignTotalMinor) return args.carriedFunctionalMinor;
  const negative = args.carriedFunctionalMinor < 0n;
  const abs = negative ? -args.carriedFunctionalMinor : args.carriedFunctionalMinor;
  const magnitude = (abs * args.foreignPartMinor) / args.foreignTotalMinor;
  return negative ? -magnitude : magnitude;
}
