/**
 * Ordence — ⭐ The Reconciliation Summary
 * Version: v0.34.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE TWO IDENTITIES, AND WHY THEY ARE THE WHOLE FILE
 * ══════════════════════════════════════════════════════════════════════
 *
 *     books tax = matched (books side) + in books, not in 2B
 *     2B tax    = matched (2B side)    + in 2B, not in books
 *
 * A reconciliation summary that does not satisfy both, EXACTLY, to the
 * paisa, is not a summary. It is a set of plausible numbers.
 *
 * ⚠️ AND THE FAILURE IT PREVENTS IS ONE-DIRECTIONAL AND EXPENSIVE. If an
 * invoice is dropped from the buckets — matched to two things, or to
 * nothing, by a re-run that appended instead of replacing — the totals
 * still look like totals. Every individual row on every screen is
 * correct. The only symptom is that "in books, not in 2B" is smaller than
 * it should be, which reads as GOOD NEWS: fewer suppliers to chase, more
 * credit available. So the credit is claimed, under Section 16(2)(aa),
 * on an invoice the supplier never filed.
 *
 * That is why the identity is checked here, checked again as a CHECK
 * constraint on `gstr2b_reconciliations` (SQL 0024 §1), and asserted in
 * `tests/security/gstr2b.test.ts`. Three times, because a summary that
 * silently absorbs a dropped invoice has no other symptom.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE THREE COLUMNS, AND WHY THREE
 * ══════════════════════════════════════════════════════════════════════
 *   ITC as per BOOKS   — Phase 33's Section 17(5) determination. What we
 *                        believe we are entitled to.
 *   ITC as per 2B      — ⭐ the Section 16(2)(aa) ceiling. What the
 *                        Government says is available, whatever we think.
 *   ITC CLAIMED        — what the ITC register actually put into the
 *                        GSTR-3B.
 *
 * ⚠️ TWO COLUMNS WOULD BE CHEAPER AND USELESS. The interesting figure is
 * a difference, and a difference between two numbers cannot say which of
 * them moved. Books above 2B is a supplier who has not filed. Claimed
 * above 2B is an excess claim with interest running under Section 50.
 * Claimed below books is credit we are entitled to and did not take, with
 * the Section 16(4) clock running on it. The three are different
 * emergencies handled by different people.
 */

import type { Gstr2bMatchCategory } from "@/db/schema/gstr2b";
import type { BookInvoiceFacts, MatchResult, TwoBRowFacts } from "./matching";

export type SideTotals = {
  count: number;
  taxableMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  totalTaxMinor: bigint;
};

export type BucketTotals = SideTotals & {
  /** ⭐ Eligible credit affected. Zero on the 2B-only side by definition. */
  itcAtRiskMinor: bigint;
};

export type ReconciliationSummary = {
  taxPeriod: string;

  /** Independently summed from the inputs. The ground truth. */
  books: SideTotals;
  twoB: SideTotals;

  matched: {
    count: number;
    booksTaxableMinor: bigint;
    booksTaxMinor: bigint;
    twoBTaxableMinor: bigint;
    twoBTaxMinor: bigint;
    /** Signed, 2B minus books, over every matched pair. */
    taxDeltaMinor: bigint;
  };

  inBooksNotIn2B: BucketTotals;
  in2BNotInBooks: BucketTotals;

  byCategory: Record<Gstr2bMatchCategory, { count: number; itcAtRiskMinor: bigint }>;

  /* --- ⭐ THE THREE COLUMNS --------------------------------------- */
  itcAsPerBooksMinor: bigint;
  itcAsPerTwoBMinor: bigint;
  itcClaimedMinor: bigint;

  /** books − 2B. Positive means suppliers have not filed. */
  booksVsTwoBMinor: bigint;
  /** claimed − 2B. ⚠️ Positive is an excess claim with interest running. */
  claimedVsTwoBMinor: bigint;
  /** claimed − books. Negative is credit we were entitled to and did not take. */
  claimedVsBooksMinor: bigint;

  /** ⭐ Both identities hold and every document is in exactly one bucket. */
  reconciles: boolean;
  /** Sentences naming exactly what failed. Empty when `reconciles`. */
  identityFailures: string[];
};

const ZERO_SIDE = (): SideTotals => ({
  count: 0,
  taxableMinor: 0n,
  cgstMinor: 0n,
  sgstMinor: 0n,
  igstMinor: 0n,
  cessMinor: 0n,
  totalTaxMinor: 0n,
});

const ZERO_BUCKET = (): BucketTotals => ({ ...ZERO_SIDE(), itcAtRiskMinor: 0n });

const CATEGORIES: Gstr2bMatchCategory[] = [
  "exact",
  "probable",
  "number_mismatch",
  "in_2b_not_in_books",
  "in_books_not_in_2b",
  "amended",
  "cancelled",
];

type TaxCarrier = {
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
};

function accumulate(into: SideTotals, from: TaxCarrier): void {
  into.count += 1;
  into.taxableMinor += from.taxableValueMinor;
  into.cgstMinor += from.cgstMinor;
  into.sgstMinor += from.sgstMinor;
  into.igstMinor += from.igstMinor;
  into.cessMinor += from.cessMinor;
  into.totalTaxMinor +=
    from.cgstMinor + from.sgstMinor + from.igstMinor + from.cessMinor;
}

/**
 * ⭐ Roll a period up, and prove it adds.
 *
 * ⚠️ THE BUCKETS ARE DECIDED BY THE **POINTERS**, NOT BY THE CATEGORY,
 * AND THAT IS DELIBERATE.
 *
 * A match with both a 2B row and a purchase invoice is matched; a match
 * with only one is that side's exception. It does not matter whether the
 * category is `exact`, `probable`, `amended` or `cancelled` — those
 * explain WHY, and a summary keyed on them would need a new arm every
 * time a category is added, and would silently drop anything it did not
 * recognise. Keyed on the pointers, the identity holds by construction
 * and a new category cannot break it.
 *
 * The categories are still reported, in `byCategory`, because "how much
 * is at risk and for what reason" is the actual question.
 */
export function summariseReconciliation(args: {
  taxPeriod: string;
  matches: readonly MatchResult[];
  bookInvoices: readonly BookInvoiceFacts[];
  twoBRows: readonly TwoBRowFacts[];
  /** From the Phase 33 ITC register. What actually went into the return. */
  itcClaimedMinor?: bigint;
}): ReconciliationSummary {
  const bookById = new Map(args.bookInvoices.map((b) => [b.id, b]));
  const rowById = new Map(args.twoBRows.map((r) => [r.id, r]));

  /* --- Ground truth, summed straight from the inputs ------------- */

  const books = ZERO_SIDE();
  for (const invoice of args.bookInvoices) accumulate(books, invoice);

  const twoB = ZERO_SIDE();
  for (const row of args.twoBRows) accumulate(twoB, row);

  /* --- The buckets, from the matches ----------------------------- */

  const matched = {
    count: 0,
    booksTaxableMinor: 0n,
    booksTaxMinor: 0n,
    twoBTaxableMinor: 0n,
    twoBTaxMinor: 0n,
    taxDeltaMinor: 0n,
  };
  const inBooksNotIn2B = ZERO_BUCKET();
  const in2BNotInBooks = ZERO_BUCKET();

  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => [c, { count: 0, itcAtRiskMinor: 0n }]),
  ) as Record<Gstr2bMatchCategory, { count: number; itcAtRiskMinor: bigint }>;

  const identityFailures: string[] = [];
  const seenBooks = new Map<string, number>();
  const seenRows = new Map<string, number>();

  for (const match of args.matches) {
    const bucket = byCategory[match.category];
    bucket.count += 1;
    bucket.itcAtRiskMinor += match.itcAtRiskMinor;

    const book = match.bookInvoiceId ? bookById.get(match.bookInvoiceId) : undefined;
    const row = match.twoBRowId ? rowById.get(match.twoBRowId) : undefined;

    if (match.bookInvoiceId) {
      seenBooks.set(match.bookInvoiceId, (seenBooks.get(match.bookInvoiceId) ?? 0) + 1);
      if (!book) {
        identityFailures.push(
          `A match points at purchase invoice ${match.bookInvoiceId}, which is not in ` +
            `the period being reconciled. Its tax is therefore in the matched total ` +
            `and not in the books total, and the two cannot agree.`,
        );
      }
    }
    if (match.twoBRowId) {
      seenRows.set(match.twoBRowId, (seenRows.get(match.twoBRowId) ?? 0) + 1);
      if (!row) {
        identityFailures.push(
          `A match points at GSTR-2B row ${match.twoBRowId}, which is not in the ` +
            `statement being reconciled.`,
        );
      }
    }

    if (book && row) {
      matched.count += 1;
      matched.booksTaxableMinor += book.taxableValueMinor;
      matched.booksTaxMinor += taxOf(book);
      matched.twoBTaxableMinor += row.taxableValueMinor;
      matched.twoBTaxMinor += taxOf(row);
      matched.taxDeltaMinor += taxOf(row) - taxOf(book);
      continue;
    }

    if (book && !row) {
      accumulate(inBooksNotIn2B, book);
      inBooksNotIn2B.itcAtRiskMinor += match.itcAtRiskMinor;
      continue;
    }

    if (row && !book) {
      accumulate(in2BNotInBooks, row);
      continue;
    }
  }

  /* --- ⭐ EVERY DOCUMENT IN EXACTLY ONE BUCKET -------------------- */

  for (const invoice of args.bookInvoices) {
    const times = seenBooks.get(invoice.id) ?? 0;
    if (times === 0) {
      identityFailures.push(
        `Purchase invoice "${invoice.invoiceNumber}" is in the period but appears in ` +
          `no match at all. It is therefore in the books total and in no bucket — ` +
          `and an invoice missing from "in books, not in 2B" reads as a supplier who ` +
          `HAS filed, which is exactly the credit Section 16(2)(aa) refuses.`,
      );
    } else if (times > 1) {
      identityFailures.push(
        `Purchase invoice "${invoice.invoiceNumber}" appears in ${times} matches. Its ` +
          `tax is counted ${times} times against a books total that counts it once.`,
      );
    }
  }
  for (const row of args.twoBRows) {
    const times = seenRows.get(row.id) ?? 0;
    if (times === 0) {
      identityFailures.push(
        `GSTR-2B row "${row.invoiceNumber}" is in the statement but appears in no ` +
          `match. The supplier filed it and the reconciliation does not account for it.`,
      );
    } else if (times > 1) {
      identityFailures.push(
        `GSTR-2B row "${row.invoiceNumber}" appears in ${times} matches.`,
      );
    }
  }

  /* --- ⭐⭐ THE IDENTITIES ---------------------------------------- */

  const booksLeft = books.totalTaxMinor;
  const booksRight = matched.booksTaxMinor + inBooksNotIn2B.totalTaxMinor;
  if (booksLeft !== booksRight) {
    identityFailures.push(
      `The books do not reconcile: ${booksLeft} paise of tax on the purchase ` +
        `invoices, but ${matched.booksTaxMinor} matched plus ` +
        `${inBooksNotIn2B.totalTaxMinor} unmatched = ${booksRight}. The difference of ` +
        `${booksLeft - booksRight} paise is tax that is in the register and in no ` +
        `bucket of the reconciliation.`,
    );
  }

  const twoBLeft = twoB.totalTaxMinor;
  const twoBRight = matched.twoBTaxMinor + in2BNotInBooks.totalTaxMinor;
  if (twoBLeft !== twoBRight) {
    identityFailures.push(
      `GSTR-2B does not reconcile: ${twoBLeft} paise of tax in the statement, but ` +
        `${matched.twoBTaxMinor} matched plus ${in2BNotInBooks.totalTaxMinor} missing ` +
        `from the books = ${twoBRight}. The difference of ${twoBLeft - twoBRight} ` +
        `paise is credit the Government has told us about and the reconciliation has ` +
        `lost.`,
    );
  }

  /* --- ⭐ THE THREE COLUMNS ------------------------------------- */

  let itcAsPerBooks = 0n;
  for (const invoice of args.bookInvoices) itcAsPerBooks += invoice.itcEligibleTaxMinor;

  // ⚠️ ONLY THE ROWS THE PORTAL MARKS AVAILABLE. A row flagged
  // `itcavl = 'N'` is in the statement and is NOT credit — the supplier
  // filed after the Section 16(4) deadline, or the place of supply puts
  // the credit in another state. Summing every row would overstate the
  // ceiling by exactly the amount that is hardest to notice.
  let itcAsPerTwoB = 0n;
  for (const row of args.twoBRows) {
    if ((row.itcAvailable ?? "available") === "available") itcAsPerTwoB += taxOf(row);
  }

  const itcClaimed = args.itcClaimedMinor ?? 0n;

  return {
    taxPeriod: args.taxPeriod,
    books,
    twoB,
    matched,
    inBooksNotIn2B,
    in2BNotInBooks,
    byCategory,
    itcAsPerBooksMinor: itcAsPerBooks,
    itcAsPerTwoBMinor: itcAsPerTwoB,
    itcClaimedMinor: itcClaimed,
    booksVsTwoBMinor: itcAsPerBooks - itcAsPerTwoB,
    claimedVsTwoBMinor: itcClaimed - itcAsPerTwoB,
    claimedVsBooksMinor: itcClaimed - itcAsPerBooks,
    reconciles: identityFailures.length === 0,
    identityFailures,
  };
}

function taxOf(facts: TaxCarrier): bigint {
  return facts.cgstMinor + facts.sgstMinor + facts.igstMinor + facts.cessMinor;
}

/**
 * The sentences a person reads at the top of the summary screen.
 *
 * ⚠️ WRITTEN HERE RATHER THAN IN THE COMPONENT because each of the three
 * differences means a different thing to a different person, and a
 * template in a React file is where that distinction gets flattened into
 * "₹X difference".
 */
export function describeSummary(summary: ReconciliationSummary): string[] {
  const lines: string[] = [];

  if (summary.booksVsTwoBMinor > 0n) {
    lines.push(
      `⭐ ${summary.booksVsTwoBMinor} paise of credit is in our books and NOT in ` +
        `GSTR-2B. Section 16(2)(aa) makes the supplier's filing a precondition, so ` +
        `this is not claimable until they file — and after the Section 16(4) ` +
        `deadline it is not claimable at all. ` +
        `${summary.inBooksNotIn2B.count} invoice(s) to chase.`,
    );
  } else if (summary.booksVsTwoBMinor < 0n) {
    lines.push(
      `GSTR-2B shows ${-summary.booksVsTwoBMinor} paise more credit than our books. ` +
        `${summary.in2BNotInBooks.count} document(s) were filed against our GSTIN and ` +
        `are not in the purchase register — either bills that never reached us, or ` +
        `invoices raised against our GSTIN by somebody we do not deal with.`,
    );
  }

  if (summary.claimedVsTwoBMinor > 0n) {
    lines.push(
      `⚠️ ${summary.claimedVsTwoBMinor} paise MORE credit has been claimed than ` +
        `GSTR-2B supports. Rule 36(4) has allowed no cushion at all since January ` +
        `2022; the excess is recoverable with interest under Section 50 running from ` +
        `the date of the claim.`,
    );
  }

  if (summary.claimedVsBooksMinor < 0n) {
    lines.push(
      `${-summary.claimedVsBooksMinor} paise of credit our own determination found ` +
        `eligible has not been claimed. That is not an error today and becomes ` +
        `permanent at the Section 16(4) deadline.`,
    );
  }

  if (!summary.reconciles) {
    lines.push(
      `⚠️ THIS SUMMARY DOES NOT ADD UP AND MUST NOT BE FILED FROM. ` +
        summary.identityFailures.join(" "),
    );
  }

  return lines;
}
