/**
 * Ordence — ⭐⭐⭐ THE PAYABLES HALF OF MULTI-CURRENCY (over 0101)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Batch 0101 wired initial recognition for SALES ONLY and wrote the gap
 * down: `server/fx/revaluation-service.ts` reads
 * `purchase_invoices.functional_total_minor`, nothing wrote it, and
 * `r.carried ?? r.functionalTotalMinor ?? 0n` therefore carried every
 * payable at NIL. The first reporting-date restatement then moved it from
 * nil to its whole functional value and took THE ENTIRE BILL to the
 * profit and loss account as an exchange difference.
 *
 * That is a wrong number in the P&L that balances, foots, and is invisible
 * to the person it costs — so the headline test below asserts the
 * RELATION that separates the two worlds:
 *
 *   an unrecognised payable's first restatement EQUALS the whole bill
 *   a recognised   payable's first restatement is the MOVEMENT IN THE RATE
 *
 * Nothing here pins a count, an id or a total. Every assertion is a
 * property of, or a relation between, two runs that differ in exactly one
 * thing — the rate, the kind, the carrying amount, or the currency's
 * exponent.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeQuote, parseRateToScaled } from "@/lib/fx/rates";
import { convertMinor } from "@/lib/fx/convert";
import {
  carriedForPart,
  exchangeDifferenceForPl,
  restateAtClosingRate,
  settlementDifference,
} from "@/lib/fx/restatement";
import {
  apportionTranslatedMinor,
  totalsAddUp,
  translatePurchaseDocument,
  type ItcTaxHeads,
  type TaxTotals,
} from "@/lib/fx/translate";
import { buildPurchasePosting, type PurchaseLineFacts } from "@/lib/accounting/sales-posting";
import { formatMinorPlain, minorUnitExponent, parseMajorToMinor } from "@/lib/fx/currency";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

const BILL_DATE = "2025-12-14";
const REPORTING_DATE = "2026-03-31";
const PAYMENT_DATE = "2026-05-20";

function quote(base: string, counter: string, rate: string, on: string) {
  return makeQuote({
    baseCurrency: base,
    quoteCurrency: counter,
    rateScaled: parseRateToScaled(rate),
    rateDate: on,
    source: "rbi_reference",
    sourceReference: "test fixture",
  });
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** A vendor bill in dollars: taxable value, IGST on an import, no cess. */
const usdBill: TaxTotals = {
  taxableValueMinor: 12_345_67n,
  cgstMinor: 0n,
  sgstMinor: 0n,
  igstMinor: 2_222_22n,
  cessMinor: 0n,
  roundOffMinor: 11n,
  totalMinor: 12_345_67n + 2_222_22n + 11n,
};

const noBlockedTax: ItcTaxHeads = {
  cgstMinor: 0n,
  sgstMinor: 0n,
  igstMinor: 0n,
  cessMinor: 0n,
};

function recogniseUsdBill(rate: string) {
  return translatePurchaseDocument({
    totals: usdBill,
    blockedTax: noBlockedTax,
    rcmTaxMinor: 0n,
    from: "USD",
    to: "INR",
    quote: quote("USD", "INR", rate, BILL_DATE),
    on: BILL_DATE,
  });
}

/* ================================================================== */
/* ⭐⭐⭐ THE HEADLINE                                                   */
/* ================================================================== */

describe("🔴🔴🔴 a payable raised today no longer produces a full-value first restatement", () => {
  const recognised = recogniseUsdBill("82.00");

  const restatement = (carriedFunctionalMinor: bigint) =>
    restateAtClosingRate({
      kind: "trade_payable",
      foreignAmountMinor: usdBill.totalMinor,
      foreignCurrency: "USD",
      functionalCurrency: "INR",
      carriedFunctionalMinor,
      closingQuote: quote("USD", "INR", "83.00", REPORTING_DATE),
      reportingDate: REPORTING_DATE,
    });

  it("carried at nil — what 0101 left — the first restatement IS the whole bill", () => {
    /**
     * 🔴 THE DEFECT, STATED AS AN EQUALITY. `?? 0n` is not a small
     * inaccuracy: the difference the run books is, to the paisa, the
     * restated value of the entire invoice.
     */
    const unrecognised = restatement(0n);
    expect(unrecognised.restated).toBe(true);
    expect(unrecognised.differenceMinor).toBe(unrecognised.restatedFunctionalMinor);
  });

  it("recognised at its own date, the first restatement is the MOVEMENT IN THE RATE", () => {
    const carried = restatement(recognised.totals.totalMinor);

    // ⭐ THE RELATION. Same item, same closing rate, one argument
    // different — and the difference is no longer the invoice.
    expect(carried.differenceMinor).not.toBe(carried.restatedFunctionalMinor);
    expect(carried.differenceMinor).toBe(
      carried.restatedFunctionalMinor - recognised.totals.totalMinor,
    );

    /**
     * ⭐ AND IT IS BOUNDED BY THE RATE MOVEMENT, not by the size of the
     * bill. A rate that moved by about one part in eighty cannot produce
     * a difference worth a tenth of the payable.
     */
    expect(abs(carried.differenceMinor) * 10n).toBeLessThan(abs(carried.restatedFunctionalMinor));
  });

  it("and a payable worth more of our own money is a LOSS, not a gain", () => {
    const carried = restatement(recognised.totals.totalMinor);
    // The rate rose, so the rupee cost of the same dollars rose.
    expect(carried.differenceMinor > 0n).toBe(true);
    // 🔴 THE FOLD HAPPENS ONCE. On a liability the P&L takes the opposite
    // sign of the carrying movement — and getting this wrong unbalances
    // nothing, which is why it is asserted rather than eyeballed.
    expect(exchangeDifferenceForPl(carried) < 0n).toBe(true);
  });

  it("recognition is the ONLY thing that changed — the same bill at a different rate carries differently", () => {
    const atEighty = recogniseUsdBill("80.00");
    const atNinety = recogniseUsdBill("90.00");
    // ⭐ If the rate were stored and ignored, these would be equal.
    expect(atNinety.totals.totalMinor).toBeGreaterThan(atEighty.totals.totalMinor);
  });
});

/* ================================================================== */
/* ② MONETARY vs NON-MONETARY, ON THE PAYABLES SIDE                    */
/* ================================================================== */

describe("🔴🔴 AS 11 ¶11 — the payable restates, the machine it bought does not", () => {
  const common = {
    foreignAmountMinor: usdBill.totalMinor,
    foreignCurrency: "USD",
    functionalCurrency: "INR",
    carriedFunctionalMinor: recogniseUsdBill("82.00").totals.totalMinor,
    closingQuote: quote("USD", "INR", "83.00", REPORTING_DATE),
    reportingDate: REPORTING_DATE,
  };

  it("differs in exactly one argument, and only one of them moves", () => {
    const payable = restateAtClosingRate({ ...common, kind: "trade_payable" });
    const machine = restateAtClosingRate({ ...common, kind: "fixed_asset" });

    expect(payable.restated).toBe(true);
    expect(machine.restated).toBe(false);

    expect(payable.restatedFunctionalMinor).not.toBe(common.carriedFunctionalMinor);
    expect(machine.restatedFunctionalMinor).toBe(common.carriedFunctionalMinor);
    expect(machine.differenceMinor).toBe(0n);
  });

  it("the untouched item carries a REASON and the restated one does not", () => {
    // A caller receiving zero cannot tell "computed, and it was nil" from
    // "this must never be revalued". Those are opposite instructions.
    expect(restateAtClosingRate({ ...common, kind: "fixed_asset" }).reason).toBeTruthy();
    expect(restateAtClosingRate({ ...common, kind: "trade_payable" }).reason).toBeNull();
  });

  it("an advance PAID to the supplier is not restated either", () => {
    const advance = restateAtClosingRate({ ...common, kind: "advance_to_supplier" });
    expect(advance.restated).toBe(false);
    expect(advance.differenceMinor).toBe(0n);
  });
});

/* ================================================================== */
/* ③ SETTLEMENT MEASURES AGAINST THE CARRIED FIGURE                    */
/* ================================================================== */

describe("🔴🔴 AS 11 ¶13 — paying the vendor is measured against the CARRYING amount", () => {
  const recognised = recogniseUsdBill("82.00");
  const restated = restateAtClosingRate({
    kind: "trade_payable",
    foreignAmountMinor: usdBill.totalMinor,
    foreignCurrency: "USD",
    functionalCurrency: "INR",
    carriedFunctionalMinor: recognised.totals.totalMinor,
    closingQuote: quote("USD", "INR", "83.00", REPORTING_DATE),
    reportingDate: REPORTING_DATE,
  });

  const settleAgainst = (carriedFunctionalMinor: bigint) =>
    settlementDifference({
      foreignSettledMinor: usdBill.totalMinor,
      foreignCurrency: "USD",
      functionalCurrency: "INR",
      carriedFunctionalMinor,
      settlementQuote: quote("USD", "INR", "85.00", PAYMENT_DATE),
      settlementDate: PAYMENT_DATE,
    });

  /** The whole movement, computed rather than asserted as a figure. */
  const wholeMovement =
    convertMinor({
      amountMinor: usdBill.totalMinor,
      from: "USD",
      to: "INR",
      quote: quote("USD", "INR", "85.00", PAYMENT_DATE),
      on: PAYMENT_DATE,
    }).amountMinor - recognised.totals.totalMinor;

  it("the two periods together equal the whole movement — nothing doubled, nothing lost", () => {
    const correct = settleAgainst(restated.restatedFunctionalMinor);
    expect(restated.differenceMinor + correct.realisedDifferenceMinor).toBe(wholeMovement);
  });

  it("measuring against the ORIGINAL bill rate re-books the year already taken", () => {
    const wrong = settleAgainst(recognised.totals.totalMinor);
    const correct = settleAgainst(restated.restatedFunctionalMinor);

    // 🔴 THE WRONG ONE SWALLOWS THE WHOLE MOVEMENT IN THE SECOND PERIOD…
    expect(wrong.realisedDifferenceMinor).toBe(wholeMovement);
    expect(wrong.realisedDifferenceMinor).not.toBe(correct.realisedDifferenceMinor);
    // …so the two periods would total MORE than ever happened, by exactly
    // the restatement the first period already took.
    expect(restated.differenceMinor + wrong.realisedDifferenceMinor).toBe(
      wholeMovement + restated.differenceMinor,
    );
  });

  it("a part payment releases only its share of the carrying amount", () => {
    const part = usdBill.totalMinor / 3n;
    const forPart = carriedForPart({
      carriedFunctionalMinor: restated.restatedFunctionalMinor,
      foreignTotalMinor: usdBill.totalMinor,
      foreignPartMinor: part,
    });
    // ⭐ A RELATION, NOT A FIGURE: a third of the bill cannot release the
    // carrying amount of the whole one.
    expect(forPart).toBeLessThan(restated.restatedFunctionalMinor);
    expect(forPart * 3n).toBeLessThanOrEqual(restated.restatedFunctionalMinor);
  });
});

/* ================================================================== */
/* THE TRANSLATED BILL STILL ADDS UP AND STILL POSTS                   */
/* ================================================================== */

describe("⭐⭐ translating a vendor bill leaves a journal that still balances", () => {
  const blocked: ItcTaxHeads = {
    cgstMinor: 0n,
    sgstMinor: 0n,
    // A motor car on the same bill — Section 17(5)(a), credit blocked.
    igstMinor: 777_77n,
    cessMinor: 0n,
  };

  const translated = translatePurchaseDocument({
    totals: usdBill,
    blockedTax: blocked,
    rcmTaxMinor: 0n,
    from: "USD",
    to: "INR",
    quote: quote("USD", "INR", "83.215", BILL_DATE),
    on: BILL_DATE,
  });

  const facts: readonly PurchaseLineFacts[] = [
    {
      taxableValueMinor: translated.totals.taxableValueMinor,
      ...translated.eligibleTax,
      itcBlocked: false,
    },
    { taxableValueMinor: 0n, ...translated.blockedTax, itcBlocked: true },
  ];

  it("keeps the six adding to the seventh after translation", () => {
    expect(totalsAddUp(usdBill)).toBe(true);
    expect(totalsAddUp(translated.totals)).toBe(true);
  });

  it("splits every tax head without inventing or losing a single minor unit", () => {
    // ⭐ THE SPLIT IS APPORTIONED, NOT RE-CONVERTED, so the two parts can
    // only ever add back to the head they came from.
    expect(translated.eligibleTax.igstMinor + translated.blockedTax.igstMinor).toBe(
      translated.totals.igstMinor,
    );
    expect(translated.eligibleTax.cgstMinor + translated.blockedTax.cgstMinor).toBe(
      translated.totals.cgstMinor,
    );
  });

  it("never rounds the odd minor unit into the input-tax CREDIT", () => {
    /**
     * 🔴 THE DIRECTION IS THE POINT. Overstating a credit is a claim on
     * the Government; overstating an expense is not. So the eligible
     * share is floored: its share of the translated head never exceeds
     * its share of the head it came from.
     */
    const eligibleDoc = usdBill.igstMinor - blocked.igstMinor;
    expect(translated.eligibleTax.igstMinor * usdBill.igstMinor).toBeLessThanOrEqual(
      eligibleDoc * translated.totals.igstMinor,
    );
  });

  it("builds a journal whose debits equal its credits at the functional figures", () => {
    // `buildPurchasePosting` throws when it does not balance; this also
    // asserts the relation rather than trusting the throw.
    const legs = buildPurchasePosting({
      lines: facts,
      roundOffMinor: translated.totals.roundOffMinor,
      totalMinor: translated.totals.totalMinor,
      invoiceNumber: "BILL/TEST",
      vendorName: null,
    });
    const debit = legs
      .filter((l) => l.entryType === "debit")
      .reduce((sum, l) => sum + l.amountMinor, 0n);
    const credit = legs
      .filter((l) => l.entryType === "credit")
      .reduce((sum, l) => sum + l.amountMinor, 0n);
    expect(debit).toBe(credit);

    // ⭐ AND THE VENDOR IS CREDITED THE FUNCTIONAL TOTAL, which is the
    // hundred-fold understatement 0101 named on the sales side.
    const payable = legs.find((l) => l.role === "payable");
    expect(payable?.amountMinor).toBe(translated.totals.totalMinor);
    expect(payable?.amountMinor).not.toBe(usdBill.totalMinor);
  });

  it("apportions a part of an already-translated figure without re-converting it", () => {
    for (const whole of [1n, 7n, 999n, 1_00_000n]) {
      for (const part of [0n, 1n, whole / 2n, whole]) {
        const got = apportionTranslatedMinor({
          translatedWholeMinor: whole * 83n,
          partMinor: part,
          wholeMinor: whole,
        });
        expect(got).toBeLessThanOrEqual(whole * 83n);
        expect(got).toBeGreaterThanOrEqual(0n);
      }
    }
  });
});

/* ================================================================== */
/* A ZERO-DECIMAL CURRENCY GAINS NO PHANTOM MINOR UNITS                */
/* ================================================================== */

describe("⭐ a payable in books kept in a zero-decimal currency gains no phantom minor units", () => {
  /** Books in yen, bill in rupees. JPY has no minor unit at all. */
  const inrBill: TaxTotals = {
    taxableValueMinor: 4_56_789n,
    cgstMinor: 41_111n,
    sgstMinor: 41_111n,
    igstMinor: 0n,
    cessMinor: 0n,
    roundOffMinor: -11n,
    totalMinor: 4_56_789n + 41_111n + 41_111n - 11n,
  };

  const translated = translatePurchaseDocument({
    totals: inrBill,
    blockedTax: { cgstMinor: 11_111n, sgstMinor: 11_111n, igstMinor: 0n, cessMinor: 0n },
    rcmTaxMinor: 5_000n,
    from: "INR",
    to: "JPY",
    quote: quote("INR", "JPY", "1.7500", BILL_DATE),
    on: BILL_DATE,
  });

  it("still adds up in a currency with a different exponent", () => {
    expect(minorUnitExponent("JPY")).toBe(0);
    expect(minorUnitExponent("INR")).toBe(2);
    expect(totalsAddUp(translated.totals)).toBe(true);
  });

  it("formats and re-parses without acquiring a fractional part", () => {
    const shown = formatMinorPlain(translated.totals.totalMinor, "JPY");
    expect(shown).not.toContain(".");
    // ⭐ THROUGH THE FORMAT **AND** THE PARSE — this is the bug that is
    // right in the arithmetic and wrong on the screen.
    expect(parseMajorToMinor(shown, "JPY")).toBe(translated.totals.totalMinor);
  });

  it("splits the tax heads in the zero-decimal currency without a remainder", () => {
    expect(translated.eligibleTax.cgstMinor + translated.blockedTax.cgstMinor).toBe(
      translated.totals.cgstMinor,
    );
    expect(translated.eligibleTax.sgstMinor + translated.blockedTax.sgstMinor).toBe(
      translated.totals.sgstMinor,
    );
  });

  it("translates reverse-charge tax too, and keeps it out of the total", () => {
    // ⚠️ The vendor never charged it, so it is not part of what they are
    // owed — but it is still a rupee figure that must reach the yen books
    // as yen.
    expect(translated.rcmTaxMinor).not.toBe(0n);
    expect(translated.totals.totalMinor).toBe(
      translated.totals.taxableValueMinor +
        translated.totals.cgstMinor +
        translated.totals.sgstMinor +
        translated.totals.igstMinor +
        translated.totals.cessMinor +
        translated.totals.roundOffMinor,
    );
  });
});

/* ================================================================== */
/* 🔴 THE WIRING — THE HALF 0101 LEFT OPEN                             */
/* ================================================================== */

describe("🔴 recording a vendor bill recognises it BEFORE it reaches the ledger", () => {
  const source = readFileSync(join(process.cwd(), "server/actions/purchases.ts"), "utf8");

  it("recognises the bill, and does so before the posting", () => {
    const recognise = source.indexOf("recognisePurchaseInvoice(tx");
    const post = source.indexOf("postPurchaseInvoice(tx");
    // ⭐ BOTH PRESENT, AND IN THAT ORDER. Recognition after posting would
    // fill the columns and still post the foreign figure.
    expect(recognise).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(recognise);
  });

  it("hands the LEDGER the recognised figures and not the document ones", () => {
    const post = source.indexOf("postPurchaseInvoice(tx");
    const call = source.slice(post, source.indexOf("});", post));
    /**
     * 🔴 THE READ IS THE WHOLE POINT. A recognition that writes the
     * columns and posts `p.totalMinor` anyway is the defect 0101 named on
     * the sales side: a foreign bill posted at its foreign figure into a
     * functional-currency ledger.
     */
    expect(call).toMatch(/recognised\.functionalTotals\.totalMinor/);
    expect(call).toMatch(/recognised\.functionalLines/);
    expect(call).not.toMatch(/totalMinor: p\.totalMinor/);
  });

  it("the revaluation reader and the recognition writer name the same columns", () => {
    const recognition = readFileSync(
      join(process.cwd(), "server/fx/initial-recognition.ts"),
      "utf8",
    );
    const revaluation = readFileSync(
      join(process.cwd(), "server/fx/revaluation-service.ts"),
      "utf8",
    );
    // ⭐ THE GAP, AS A TEST: the consumer read these two columns from
    // `purchase_invoices` and nothing wrote them.
    for (const column of ["functionalTotalMinor", "fxCarriedFunctionalMinor"]) {
      expect(revaluation).toContain(`purchaseInvoices.${column}`);
      expect(recognition).toContain(column);
    }
    expect(recognition).toContain("purchaseInvoices");
  });
});
