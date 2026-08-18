import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE REPORTING-DATE RESTATEMENT — AS 11 ¶11 / Ind AS 21 ¶23
 * Batch 0101 · Multi-currency and FX
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES, IN ONE PARAGRAPH
 * ══════════════════════════════════════════════════════════════════════
 * At a reporting date it finds every MONETARY item the workspace holds in
 * a currency other than its functional currency, restates each at the
 * CLOSING RATE, records the difference on `fx_revaluation_lines`, moves
 * the item's carrying amount, and posts the aggregate gain and loss to the
 * profit and loss account.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IT DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not touch a single non-monetary item, and the two candidates
 * that look monetary and are not — advances paid to suppliers and advances
 * received from customers — are recorded on the run as SKIPPED WITH A
 * REASON rather than left out of the query. A run that silently omits them
 * is indistinguishable from a run whose join is broken; a line saying
 * "not restated, AS 11 ¶11(b), non-monetary" is a policy an auditor can
 * read.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ IT REPLAYS FROM THE DOCUMENTS. There is no running "unrealised gain"
 * counter anywhere in this schema and there must never be one — the same
 * argument `employee_advances` makes about a balance column in 0096. Each
 * run reads what the documents are carried at now, computes what they
 * should be carried at, and writes the difference. Re-running against the
 * same reporting date is refused by a unique index rather than absorbed,
 * because the second run would correctly find a difference of nil and the
 * P&L would be short by whatever the first run took.
 */

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { fxRevaluations, fxRevaluationLines } from "@/db/schema/fx";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { purchaseInvoices } from "@/db/schema/purchases";
import { ledgers } from "@/db/schema/accounting";
import {
  assertKnownCurrency,
  formatMinorPlain,
  normaliseCurrencyCode,
} from "@/lib/fx/currency";
import { CLOSING_RATE_WINDOW } from "@/lib/fx/convert";
import { formatRateScaled, type FxQuote } from "@/lib/fx/rates";
import {
  exchangeDifferenceForPl,
  restateAtClosingRate,
  settlementDifference,
  carriedForPart,
  type FxItemKind,
  type Restatement,
} from "@/lib/fx/restatement";
import {
  buildFxRevaluationPosting,
  buildFxSettlementPosting,
  type FxLeg,
} from "@/lib/accounting/sales-posting";
import { postFxRevaluation, postFxSettlement } from "@/server/accounting/post-sales";
import { resolveQuote } from "./rate-service";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** One thing the run considered. */
export type RevaluationCandidate = {
  kind: FxItemKind;
  sourceTable: string;
  sourceId: string;
  sourceReference: string;
  currency: string;
  /** Outstanding amount in the document's own currency. */
  foreignAmountMinor: bigint;
  /** What the books carry that outstanding amount at, functional currency. */
  carryingFunctionalMinor: bigint;
  /** The item's own control ledger, when one is known. */
  contraLedgerId: string | null;
  /**
   * ⭐⭐ THE DATE THIS ITEM WAS LAST RESTATED AT, OR NULL.
   *
   * 🔴 READ BY `runRevaluation` AND IT IS A REAL CONTROL. The unique index
   * on (tenant, as_of_date) stops the SAME reporting date being run twice.
   * It does not stop somebody running 31 March AFTER running 30 June —
   * and that second run would restate the item BACKWARDS from its June
   * carrying amount to a March rate, book the reversal as a March gain,
   * and leave the item carried at a figure that belongs to neither date.
   */
  lastRevaluedOn: string | null;
};

export type RevaluationOutcome = {
  revaluationId: string;
  asOfDate: string;
  functionalCurrency: string;
  gainMinor: bigint;
  lossMinor: bigint;
  restatedCount: number;
  skippedCount: number;
  posted: boolean;
  unpostedReason: string | null;
  /** Currencies with exposure but no closing rate on file. */
  missingRates: string[];
};

/* ================================================================== */
/* GATHERING                                                           */
/* ================================================================== */

/**
 * ⭐ EVERY OPEN SALES INVOICE THAT IS NOT IN THE FUNCTIONAL CURRENCY.
 *
 * ⚠️ THE EXPOSURE IS THE UNPAID BALANCE, NOT THE INVOICE TOTAL. An
 * invoice half settled has half the currency risk left; restating the
 * whole would book an exchange difference on money that has already
 * arrived and whose rate was fixed the day it did.
 *
 * ⚠️ CANCELLED AND DRAFT INVOICES ARE OUT. A draft is not a receivable and
 * a cancelled one is not owed.
 */
async function openSalesInvoices(
  tx: Tx,
  tenantId: string,
  functionalCurrency: string,
  asOfDate: string,
): Promise<RevaluationCandidate[]> {
  const rows = await tx
    .select({
      id: salesInvoices.id,
      invoiceNumber: salesInvoices.invoiceNumber,
      currency: salesInvoices.currency,
      totalMinor: salesInvoices.totalMinor,
      receivedMinor: salesInvoices.receivedMinor,
      functionalTotalMinor: salesInvoices.functionalTotalMinor,
      carried: salesInvoices.fxCarriedFunctionalMinor,
      lastRevaluedOn: salesInvoices.fxLastRevaluedOn,
      invoiceDate: salesInvoices.invoiceDate,
    })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.tenantId, tenantId),
        ne(salesInvoices.currency, functionalCurrency),
        inArray(salesInvoices.status, ["issued", "part_paid"]),
        sql`${salesInvoices.invoiceDate} <= ${asOfDate}`,
      ),
    );

  const out: RevaluationCandidate[] = [];
  for (const r of rows) {
    const outstandingForeign = r.totalMinor - r.receivedMinor;
    if (outstandingForeign <= 0n) continue;
    /**
     * ⚠️ THE CARRYING AMOUNT OF THE OUTSTANDING PART, PRO-RATED. Passing
     * the carrying amount of the WHOLE invoice against a part balance
     * would restate money already collected.
     */
    const wholeCarried = r.carried ?? r.functionalTotalMinor ?? 0n;
    out.push({
      kind: "trade_receivable",
      sourceTable: "sales_invoices",
      sourceId: r.id,
      sourceReference: r.invoiceNumber,
      currency: normaliseCurrencyCode(r.currency),
      foreignAmountMinor: outstandingForeign,
      carryingFunctionalMinor: carriedForPart({
        carriedFunctionalMinor: wholeCarried,
        foreignTotalMinor: r.totalMinor,
        foreignPartMinor: outstandingForeign,
      }),
      contraLedgerId: null,
      lastRevaluedOn: r.lastRevaluedOn,
    });
  }
  return out;
}

/** The same, on the payables side. */
async function openPurchaseInvoices(
  tx: Tx,
  tenantId: string,
  functionalCurrency: string,
  asOfDate: string,
): Promise<RevaluationCandidate[]> {
  const rows = await tx
    .select({
      id: purchaseInvoices.id,
      invoiceNumber: purchaseInvoices.invoiceNumber,
      currency: purchaseInvoices.currency,
      totalMinor: purchaseInvoices.totalMinor,
      paidMinor: purchaseInvoices.amountPaidMinor,
      functionalTotalMinor: purchaseInvoices.functionalTotalMinor,
      carried: purchaseInvoices.fxCarriedFunctionalMinor,
      lastRevaluedOn: purchaseInvoices.fxLastRevaluedOn,
    })
    .from(purchaseInvoices)
    .where(
      and(
        eq(purchaseInvoices.tenantId, tenantId),
        ne(purchaseInvoices.currency, functionalCurrency),
        inArray(purchaseInvoices.status, ["recorded", "approved"]),
        sql`${purchaseInvoices.invoiceDate} <= ${asOfDate}`,
      ),
    );

  const out: RevaluationCandidate[] = [];
  for (const r of rows) {
    const outstandingForeign = r.totalMinor - r.paidMinor;
    if (outstandingForeign <= 0n) continue;
    const wholeCarried = r.carried ?? r.functionalTotalMinor ?? 0n;
    out.push({
      kind: "trade_payable",
      sourceTable: "purchase_invoices",
      sourceId: r.id,
      sourceReference: r.invoiceNumber,
      currency: normaliseCurrencyCode(r.currency),
      foreignAmountMinor: outstandingForeign,
      carryingFunctionalMinor: carriedForPart({
        carriedFunctionalMinor: wholeCarried,
        foreignTotalMinor: r.totalMinor,
        foreignPartMinor: outstandingForeign,
      }),
      contraLedgerId: null,
      lastRevaluedOn: r.lastRevaluedOn,
    });
  }
  return out;
}

/**
 * ⭐⭐ FOREIGN-CURRENCY BANK LEDGERS — the third monetary item, and the
 * one that finally makes `ledgers.currency` a column that is read.
 *
 * 🔴 STATED GAP AND IT IS NOT SMALL. `ledgers.current_balance` is a
 * `numeric(18,2)` maintained by trigger in the FUNCTIONAL currency, and
 * there is no column anywhere holding the FOREIGN-currency balance of a
 * foreign bank account. Ordence therefore knows a ledger is denominated in
 * USD and does not know how many dollars are in it.
 *
 * ⚠️ SO THESE LEDGERS ARE LISTED AND NOT RESTATED, WITH THE REASON ON THE
 * ROW. Restating them would require inferring the dollar balance by
 * dividing the rupee balance by some rate — which rate? the invoice
 * rates that produced it, which are not recorded per leg — and the answer
 * would be a plausible number with no evidence behind it. A visible skip
 * with a sentence beats a confident restatement of a balance nobody
 * measured.
 */
async function foreignCurrencyLedgers(
  tx: Tx,
  tenantId: string,
  functionalCurrency: string,
): Promise<RevaluationCandidate[]> {
  const rows = await tx
    .select({
      id: ledgers.id,
      code: ledgers.code,
      name: ledgers.name,
      currency: ledgers.currency,
      accountType: ledgers.accountType,
    })
    .from(ledgers)
    .where(
      and(
        eq(ledgers.tenantId, tenantId),
        ne(ledgers.currency, functionalCurrency),
        isNull(ledgers.deletedAt),
        eq(ledgers.isActive, true),
      ),
    );

  return rows.map((r) => ({
    kind: "foreign_bank_balance" as const,
    sourceTable: "ledgers",
    sourceId: r.id,
    sourceReference: `${r.code} ${r.name}`,
    currency: normaliseCurrencyCode(r.currency),
    // 🔴 ZERO, AND THE SKIP REASON SAYS WHY. See the header above.
    foreignAmountMinor: 0n,
    carryingFunctionalMinor: 0n,
    contraLedgerId: r.id,
    lastRevaluedOn: null,
  }));
}

/** Everything the run will look at, in one list. */
export async function gatherCandidates(
  tx: Tx,
  args: { tenantId: string; functionalCurrency: string; asOfDate: string },
): Promise<RevaluationCandidate[]> {
  const [receivables, payables, banks] = await Promise.all([
    openSalesInvoices(tx, args.tenantId, args.functionalCurrency, args.asOfDate),
    openPurchaseInvoices(tx, args.tenantId, args.functionalCurrency, args.asOfDate),
    foreignCurrencyLedgers(tx, args.tenantId, args.functionalCurrency),
  ]);
  return [...receivables, ...payables, ...banks];
}

/* ================================================================== */
/* THE RUN                                                             */
/* ================================================================== */

/**
 * ⭐⭐⭐ RUN THE RESTATEMENT.
 *
 * ⚠️ ONE TRANSACTION. The lines, the moved carrying amounts and the
 * journal commit together or not at all. A run whose lines landed and
 * whose journal did not would leave the invoices carried at a value the
 * ledger has never heard of.
 */
export async function runRevaluation(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    asOfDate: string;
    functionalCurrency: string;
    note?: string | null;
  },
): Promise<RevaluationOutcome> {
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);
  assertKnownCurrency(functionalCurrency);

  const candidates = await gatherCandidates(tx, {
    tenantId: args.tenantId,
    functionalCurrency,
    asOfDate: args.asOfDate,
  });

  /**
   * ⭐ ONE RATE LOOKUP PER CURRENCY, NOT PER DOCUMENT. Four hundred
   * dollar invoices need one closing rate between them, and resolving it
   * four hundred times would let two of them differ if a rate were
   * corrected mid-run.
   */
  const currencies = [...new Set(candidates.map((c) => c.currency))].filter(
    (c) => c !== functionalCurrency,
  );
  const quotes = new Map<string, FxQuote>();
  const missingRates: string[] = [];
  for (const currency of currencies) {
    const quote = await resolveQuote(tx, {
      tenantId: args.tenantId,
      from: currency,
      to: functionalCurrency,
      on: args.asOfDate,
      // ⚠️ The closing-rate window: back across a long weekend, no further.
      policy: CLOSING_RATE_WINDOW,
    });
    if (quote) quotes.set(currency, quote);
    else missingRates.push(currency);
  }

  const [run] = await tx
    .insert(fxRevaluations)
    .values({
      tenantId: args.tenantId,
      asOfDate: args.asOfDate,
      functionalCurrency,
      status: "draft",
      note: args.note ?? null,
      createdBy: args.userId,
    })
    .returning({ id: fxRevaluations.id });
  if (!run) throw new Error("The revaluation could not be started. Nothing has been restated.");

  let gainMinor = 0n;
  let lossMinor = 0n;
  let restatedCount = 0;
  let skippedCount = 0;

  const postingItems: {
    kind: string;
    plEffectMinor: bigint;
    contraLedgerId: string | null;
    description: string;
  }[] = [];

  for (const candidate of candidates) {
    const quote = quotes.get(candidate.currency);

    /**
     * 🔴 NO RATE MEANS NOT RESTATED, WITH THE REASON ON THE ROW. It does
     * NOT mean restated at 1:1, and it does not mean skipped silently.
     */
    let restatement: Restatement;
    /**
     * 🔴 REFUSE TO RESTATE BACKWARDS. See the comment on
     * `RevaluationCandidate.lastRevaluedOn`: an item already carried at a
     * LATER reporting date's closing rate must not be dragged back to an
     * earlier one, because the reversal would be booked as this period's
     * exchange difference and the item would end up carried at a figure
     * belonging to neither date.
     */
    if (candidate.lastRevaluedOn !== null && candidate.lastRevaluedOn > args.asOfDate) {
      restatement = {
        kind: candidate.kind,
        monetary: true,
        restated: false,
        foreignAmountMinor: candidate.foreignAmountMinor,
        foreignCurrency: candidate.currency,
        functionalCurrency,
        carriedFunctionalMinor: candidate.carryingFunctionalMinor,
        restatedFunctionalMinor: candidate.carryingFunctionalMinor,
        differenceMinor: 0n,
        conversion: null,
        reason:
          `${candidate.sourceReference} is already carried at the closing rate for ` +
          `${candidate.lastRevaluedOn}, which is LATER than ${args.asOfDate}. Restating it ` +
          `backwards would book the reversal of a later period's difference into this one and ` +
          `leave the item carried at a figure belonging to neither date. Not restated.`,
      };
    } else if (!quote) {
      restatement = {
        kind: candidate.kind,
        monetary: true,
        restated: false,
        foreignAmountMinor: candidate.foreignAmountMinor,
        foreignCurrency: candidate.currency,
        functionalCurrency,
        carriedFunctionalMinor: candidate.carryingFunctionalMinor,
        restatedFunctionalMinor: candidate.carryingFunctionalMinor,
        differenceMinor: 0n,
        conversion: null,
        reason:
          `No closing rate is on file to convert ${candidate.currency} to ${functionalCurrency} ` +
          `on or shortly before ${args.asOfDate}, so this item has NOT been restated and its ` +
          `carrying amount is unchanged. Enter the rate and re-run.`,
      };
    } else if (candidate.sourceTable === "ledgers") {
      restatement = {
        kind: candidate.kind,
        monetary: true,
        restated: false,
        foreignAmountMinor: 0n,
        foreignCurrency: candidate.currency,
        functionalCurrency,
        carriedFunctionalMinor: 0n,
        restatedFunctionalMinor: 0n,
        differenceMinor: 0n,
        conversion: null,
        reason:
          `${candidate.sourceReference} is denominated in ${candidate.currency} and IS a monetary ` +
          `item that AS 11 ¶11(a) restates at the closing rate — but Ordence holds only its ` +
          `${functionalCurrency} balance and no ${candidate.currency} balance, so the foreign ` +
          `amount to restate is not recorded anywhere. Listed rather than restated: a number ` +
          `derived by dividing the ${functionalCurrency} balance by a rate nobody chose would be ` +
          `plausible and unevidenced.`,
      };
    } else {
      restatement = restateAtClosingRate({
        kind: candidate.kind,
        foreignAmountMinor: candidate.foreignAmountMinor,
        foreignCurrency: candidate.currency,
        functionalCurrency,
        carriedFunctionalMinor: candidate.carryingFunctionalMinor,
        closingQuote: quote,
        reportingDate: args.asOfDate,
        policy: CLOSING_RATE_WINDOW,
      });
    }

    const plEffect = exchangeDifferenceForPl(restatement);
    if (restatement.restated) {
      restatedCount += 1;
      if (plEffect > 0n) gainMinor += plEffect;
      else if (plEffect < 0n) lossMinor += -plEffect;
      if (plEffect !== 0n) {
        postingItems.push({
          kind: candidate.kind,
          plEffectMinor: plEffect,
          contraLedgerId: candidate.contraLedgerId,
          description:
            `${candidate.sourceReference}: ${candidate.currency} ` +
            `${formatMinorPlain(candidate.foreignAmountMinor, candidate.currency)} restated at ` +
            `${formatRateScaled(restatement.conversion?.quote.rateScaled ?? 0n)}`,
        });
      }
    } else {
      skippedCount += 1;
    }

    await tx.insert(fxRevaluationLines).values({
      tenantId: args.tenantId,
      revaluationId: run.id,
      itemKind: candidate.kind,
      isMonetaryItem: restatement.monetary,
      sourceTable: candidate.sourceTable,
      sourceId: candidate.sourceId,
      sourceReference: candidate.sourceReference,
      foreignCurrency: candidate.currency,
      foreignAmountMinor: candidate.foreignAmountMinor,
      carryingFunctionalMinor: restatement.carriedFunctionalMinor,
      restatedFunctionalMinor: restatement.restatedFunctionalMinor,
      differenceMinor: restatement.differenceMinor,
      plEffectMinor: plEffect,
      rate: restatement.conversion
        ? formatRateScaled(restatement.conversion.quote.rateScaled)
        : null,
      rateDate: restatement.conversion?.quote.rateDate ?? null,
      rateSource: restatement.conversion?.quote.source ?? null,
      rateDerived: restatement.conversion?.quote.derived ?? false,
      restated: restatement.restated,
      skipReason: restatement.reason,
    });

    /**
     * ⭐⭐ THE CARRYING AMOUNT MOVES. This is what makes the SETTLEMENT
     * moment correct three months later — see the column comment on
     * `fx_carried_functional_minor`.
     *
     * ⚠️ THE WHOLE INVOICE'S CARRYING AMOUNT IS RESTORED FROM THE PART,
     * so a half-settled invoice ends up carrying the restated balance plus
     * the settled portion at its own historical rate.
     */
    if (restatement.restated && candidate.sourceTable === "sales_invoices") {
      const delta = restatement.restatedFunctionalMinor - restatement.carriedFunctionalMinor;
      await tx
        .update(salesInvoices)
        .set({
          fxCarriedFunctionalMinor: sql`coalesce(${salesInvoices.fxCarriedFunctionalMinor}, ${salesInvoices.functionalTotalMinor}, 0) + ${delta.toString()}`,
          fxLastRevaluedOn: args.asOfDate,
        })
        .where(
          and(
            eq(salesInvoices.tenantId, args.tenantId),
            eq(salesInvoices.id, candidate.sourceId),
          ),
        );
    }
    if (restatement.restated && candidate.sourceTable === "purchase_invoices") {
      const delta = restatement.restatedFunctionalMinor - restatement.carriedFunctionalMinor;
      await tx
        .update(purchaseInvoices)
        .set({
          fxCarriedFunctionalMinor: sql`coalesce(${purchaseInvoices.fxCarriedFunctionalMinor}, ${purchaseInvoices.functionalTotalMinor}, 0) + ${delta.toString()}`,
          fxLastRevaluedOn: args.asOfDate,
        })
        .where(
          and(
            eq(purchaseInvoices.tenantId, args.tenantId),
            eq(purchaseInvoices.id, candidate.sourceId),
          ),
        );
    }
  }

  /* ── THE JOURNAL ─────────────────────────────────────────────── */

  let posted = false;
  let unpostedReason: string | null = null;
  let transactionId: string | null = null;

  if (postingItems.length === 0) {
    unpostedReason =
      "Nothing to post: no monetary item's closing rate differed from the rate it was carried at.";
  } else {
    const legs: FxLeg[] = buildFxRevaluationPosting({
      items: postingItems,
      asOfDate: args.asOfDate,
    });
    const outcome = await postFxRevaluation(tx, {
      tenantId: args.tenantId,
      userId: args.userId,
      revaluationId: run.id,
      asOfDate: args.asOfDate,
      functionalCurrency,
      legs,
    });
    if (outcome.posted) {
      posted = true;
      transactionId = outcome.transactionId;
    } else {
      /**
       * ⚠️ THE SAME MIDDLE PATH `post-sales.ts` TAKES EVERYWHERE. An
       * unmapped chart of accounts does not stop the restatement being
       * COMPUTED and recorded; it stops it reaching the ledger, visibly,
       * with the reason on the run.
       */
      unpostedReason =
        outcome.reason === "unmapped_roles"
          ? `The exchange difference has been computed but NOT posted: no ledger is mapped for ${outcome.missing.join(", ")}. Map them on the posting-accounts screen and post the run.`
          : outcome.reason === "period_closed"
            ? `The exchange difference has been computed but NOT posted: ${args.asOfDate} falls in ${outcome.period}, which is closed.`
            : outcome.reason === "already_posted"
              ? "A journal already exists for this revaluation."
              : "Nothing to post.";
    }
  }

  await tx
    .update(fxRevaluations)
    .set({
      status: posted ? "posted" : "draft",
      gainMinor,
      lossMinor,
      restatedCount,
      skippedCount,
      transactionId,
      unpostedReason,
      postedAt: posted ? new Date() : null,
    })
    .where(and(eq(fxRevaluations.tenantId, args.tenantId), eq(fxRevaluations.id, run.id)));

  return {
    revaluationId: run.id,
    asOfDate: args.asOfDate,
    functionalCurrency,
    gainMinor,
    lossMinor,
    restatedCount,
    skippedCount,
    posted,
    unpostedReason,
    missingRates,
  };
}

/* ================================================================== */
/* ③ SETTLEMENT                                                        */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE REALISED DIFFERENCE WHEN A FOREIGN-CURRENCY SALES INVOICE IS
 * SETTLED.
 *
 * 🔴 MEASURED AGAINST THE CARRYING AMOUNT. The invoice's
 * `fx_carried_functional_minor` is what the outstanding balance is worth
 * in the books the instant before the money arrives — the initial
 * recognition figure if nothing has restated it, and the restated figure
 * if a revaluation has. Measuring against the invoice rate instead would
 * re-book a gain the previous year's P&L already took.
 *
 * ⚠️ RETURNS `null` WHEN THERE IS NOTHING TO DO — an invoice already in
 * the functional currency has no exchange difference and posting a nil
 * journal against it would clutter the ledger.
 */
export async function settleForeignSalesInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    /** The receipt that settled it. Used as the idempotency key. */
    settlementId: string;
    settlementDate: string;
    /** How much of the invoice's own currency was settled. */
    foreignSettledMinor: bigint;
    functionalCurrency: string;
  },
): Promise<{ realisedMinor: bigint; posted: boolean; reason: string | null } | null> {
  const functionalCurrency = normaliseCurrencyCode(args.functionalCurrency);

  const [invoice] = await tx
    .select({
      id: salesInvoices.id,
      invoiceNumber: salesInvoices.invoiceNumber,
      currency: salesInvoices.currency,
      totalMinor: salesInvoices.totalMinor,
      functionalTotalMinor: salesInvoices.functionalTotalMinor,
      carried: salesInvoices.fxCarriedFunctionalMinor,
    })
    .from(salesInvoices)
    .where(
      and(eq(salesInvoices.tenantId, args.tenantId), eq(salesInvoices.id, args.invoiceId)),
    )
    .limit(1);

  if (!invoice) return null;
  if (normaliseCurrencyCode(invoice.currency) === functionalCurrency) return null;

  const wholeCarried = invoice.carried ?? invoice.functionalTotalMinor;
  if (wholeCarried === null || wholeCarried === undefined) {
    /**
     * ⚠️ AN INVOICE WITH NO FUNCTIONAL FIGURE PREDATES THIS BATCH. There
     * is no honest carrying amount to measure against, so no realised
     * difference is invented. Said out loud rather than defaulted to zero,
     * which would look like "there was no gain".
     */
    return {
      realisedMinor: 0n,
      posted: false,
      reason:
        `${invoice.invoiceNumber} is in ${invoice.currency} but carries no ` +
        `${functionalCurrency} equivalent, so it predates multi-currency support. No realised ` +
        `exchange difference has been computed — there is nothing to measure the settlement ` +
        `rate against.`,
    };
  }

  const carriedForSettled = carriedForPart({
    carriedFunctionalMinor: wholeCarried,
    foreignTotalMinor: invoice.totalMinor,
    foreignPartMinor: args.foreignSettledMinor,
  });

  const quote = await resolveQuote(tx, {
    tenantId: args.tenantId,
    from: invoice.currency,
    to: functionalCurrency,
    on: args.settlementDate,
    policy: CLOSING_RATE_WINDOW,
  });
  if (!quote) {
    return {
      realisedMinor: 0n,
      posted: false,
      reason:
        `No exchange rate is on file for ${invoice.currency} to ${functionalCurrency} on ` +
        `${args.settlementDate}, so the realised exchange difference on ` +
        `${invoice.invoiceNumber} has NOT been computed or posted.`,
    };
  }

  const difference = settlementDifference({
    foreignSettledMinor: args.foreignSettledMinor,
    foreignCurrency: invoice.currency,
    functionalCurrency,
    carriedFunctionalMinor: carriedForSettled,
    settlementQuote: quote,
    settlementDate: args.settlementDate,
    policy: CLOSING_RATE_WINDOW,
  });

  if (difference.realisedDifferenceMinor === 0n) {
    return { realisedMinor: 0n, posted: false, reason: null };
  }

  const legs = buildFxSettlementPosting({
    kind: "trade_receivable",
    realisedDifferenceMinor: difference.realisedDifferenceMinor,
    contraLedgerId: null,
    documentReference: invoice.invoiceNumber,
    settlementDate: args.settlementDate,
  });

  const outcome = await postFxSettlement(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    settlementId: args.settlementId,
    settlementDate: args.settlementDate,
    documentReference: invoice.invoiceNumber,
    functionalCurrency,
    legs,
  });

  /**
   * ⭐ THE CARRYING AMOUNT FALLS BY WHAT WAS SETTLED. The remaining
   * balance stays carried at its own restated rate, which is what the next
   * revaluation and the next settlement both measure against.
   */
  await tx
    .update(salesInvoices)
    .set({
      fxCarriedFunctionalMinor: sql`coalesce(${salesInvoices.fxCarriedFunctionalMinor}, ${salesInvoices.functionalTotalMinor}, 0) - ${carriedForSettled.toString()}`,
    })
    .where(and(eq(salesInvoices.tenantId, args.tenantId), eq(salesInvoices.id, args.invoiceId)));

  return {
    realisedMinor: difference.realisedDifferenceMinor,
    posted: outcome.posted,
    reason: outcome.posted
      ? null
      : outcome.reason === "unmapped_roles"
        ? `The realised exchange difference has been computed but NOT posted: no ledger is mapped for ${outcome.missing.join(", ")}.`
        : outcome.reason === "period_closed"
          ? `Not posted: ${args.settlementDate} falls in ${outcome.period}, which is closed.`
          : "Not posted.",
  };
}

/** The three places a monetary item can live today. Used by the UI filter. */
export const REVALUATION_ITEM_TABLES = ["sales_invoices", "purchase_invoices", "ledgers"] as const;
