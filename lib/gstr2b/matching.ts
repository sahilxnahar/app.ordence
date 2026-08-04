/**
 * Ordence — ⭐⭐ THE GSTR-2B MATCHING ENGINE
 * Version: v0.34.0-alpha
 *
 * Pure. `bigint` paise, no database, no clock, no randomness.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ TWO PROPERTIES, AND EVERYTHING ELSE IS SUBORDINATE TO THEM
 * ══════════════════════════════════════════════════════════════════════
 *
 *   1. DETERMINISTIC. The same inputs give the same matches, in the same
 *      order, every time. Not "usually" — always. A finance manager who
 *      re-runs the reconciliation and gets a different answer has no
 *      reconciliation at all, because the thing they showed their
 *      auditor last week no longer exists.
 *
 *      ⚠️ The threat to determinism is not randomness, it is INPUT
 *      ORDER. A `SELECT` without `ORDER BY` returns rows in whatever
 *      order the planner chose today, and a greedy matcher walking them
 *      pairs a 2B row with whichever of two identical candidates it saw
 *      first. So this function SORTS BOTH SIDES ITSELF, on a total order,
 *      before it looks at anything. It does not trust its caller.
 *
 *   2. EXPLAINABLE. Every match carries the fields that agreed, WITH
 *      BOTH VALUES; the fields that differed, with the delta in paise;
 *      and a sentence. The question at an assessment is never "did your
 *      software match these" — it is "on what basis did you treat a
 *      document numbered INV/001 in your books as the document numbered
 *      INV-001 in the portal's records", and the answer has to be a
 *      record made at the time, not a re-run.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND ONE PROHIBITION
 * ══════════════════════════════════════════════════════════════════════
 * NOTHING BELOW `exact` IS EVER AUTO-ACCEPTED. The engine sets
 * `autoAcceptable` on exact matches and on nothing else, and the database
 * refuses an accepted match below exact with nobody named against it
 * (`gstr2b_matches_no_silent_auto_accept`).
 *
 * The pressure to relax this is constant and it is always framed as
 * efficiency: "accept everything above 90%". What it buys is a year of
 * matches nobody looked at, discovered at the one assessment where it
 * matters, when the answer to "who decided this" is "nobody did".
 */

import {
  canonicaliseInvoiceNumber,
  describeNumberDifference,
  normaliseInvoiceNumber,
} from "./invoice-number";
import {
  DEFAULT_MATCH_TOLERANCE,
  absDiff,
  civilDaysApart,
  type MatchTolerance,
} from "./tolerance";
import type {
  Gstr2bMatchCategory,
  Gstr2bMatchConfidence,
  Gstr2bSection,
} from "@/db/schema/gstr2b";

/**
 * ⭐ The engine's version stamp, written onto every match it produces.
 *
 * ⚠️ BUMP IT WHENEVER A RULE OR A TOLERANCE CHANGES. Determinism is only
 * meaningful for a FIXED set of rules; a widened tolerance changes
 * yesterday's answers, and the only defence against "but the system used
 * to say these matched" is a stamp naming which rules were in force when
 * it said so.
 */
export const MATCH_ENGINE_VERSION = "1";

/* ------------------------------------------------------------------ */
/* INPUTS                                                              */
/* ------------------------------------------------------------------ */

/** A purchase invoice as the engine needs to see it. Phase 33 owns it. */
export type BookInvoiceFacts = {
  id: string;
  supplierGstin: string | null;
  /** ⭐ As entered from the supplier's paper. Never rewritten. */
  invoiceNumber: string;
  invoiceDate: string;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  /**
   * ⭐ Phase 33's Section 17(5) determination — the credit we believe we
   * may take. This, and NOT the tax on the document, is what a supplier's
   * failure to file puts at risk.
   */
  itcEligibleTaxMinor: bigint;
  vendorId?: string | null;
  vendorName?: string | null;
};

/** A parsed 2B row as the engine needs to see it. */
export type TwoBRowFacts = {
  id: string;
  section: Gstr2bSection;
  supplierGstin: string | null;
  supplierName?: string | null;
  /** ⭐ As the supplier FILED it. Never rewritten. */
  invoiceNumber: string;
  invoiceDate: string;
  taxableValueMinor: bigint;
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
  itcAvailable?: "available" | "not_available";
  isAmendment?: boolean;
  isCancelled?: boolean;
  originalInvoiceNumber?: string | null;
  originalInvoiceDate?: string | null;
};

/* ------------------------------------------------------------------ */
/* OUTPUT                                                              */
/* ------------------------------------------------------------------ */

export type FieldComparison = {
  field: string;
  twoB: string | null;
  books: string | null;
  agrees: boolean;
  /** Present on money fields. 2B minus books, so positive = they declared more. */
  deltaMinor?: string;
};

export type MatchResult = {
  category: Gstr2bMatchCategory;
  confidence: Gstr2bMatchConfidence;
  /** 0–100. Sorts the worklist; never decides anything on its own. */
  score: number;

  twoBRowId: string | null;
  bookInvoiceId: string | null;
  supplierGstin: string | null;
  vendorId: string | null;

  /** ⭐ Every field compared, with both values. The audit answer. */
  matchedOn: FieldComparison[];
  /** ⭐ The subset that did NOT agree. Empty on an exact match. */
  differences: FieldComparison[];

  /** Signed, 2B minus books. */
  taxableDeltaMinor: bigint;
  taxDeltaMinor: bigint;

  /** ⭐ Eligible credit this exception puts at risk. Never the gross tax. */
  itcAtRiskMinor: bigint;

  /** How many equally good candidates the engine had to choose between. */
  ambiguousCandidates: number;

  /** ⭐ TRUE ONLY FOR `exact`. */
  autoAcceptable: boolean;

  explanation: string;
  engineVersion: string;
};

/* ------------------------------------------------------------------ */
/* THE ENGINE                                                          */
/* ------------------------------------------------------------------ */

type Indexed<T> = { facts: T; sortKey: string; used: boolean };

/**
 * ⭐ Reconcile a period's 2B rows against a period's purchase invoices.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PASSES, IN ORDER, AND WHY THE ORDER IS THE ALGORITHM
 * ══════════════════════════════════════════════════════════════════════
 * Each pass consumes rows from both sides. A row consumed by an earlier
 * pass is invisible to every later one, so a STRONGER claim on an invoice
 * always beats a weaker one — which is the only way a greedy matcher can
 * be defended.
 *
 *   0. CANCELLED    — the supplier withdrew the document. Whatever else
 *                     it might have matched, it is cancelled, and a
 *                     credit taken on it must come back out. Runs first
 *                     precisely so it cannot be masked by a value match.
 *
 *   1. AMENDED      — a `b2ba`/`cdnra`/`isda` row. ⚠️ BEFORE the ordinary
 *                     passes, because an amendment carries the corrected
 *                     figures and would otherwise be matched as if it
 *                     were a second, separate invoice — double-counting
 *                     the whole document. It ties to our books by its own
 *                     number first and by the ORIGINAL number second,
 *                     because a bill amended after we entered it still
 *                     sits in our books under the number we typed.
 *
 *   2. EXACT        — GSTIN, canonical number, date, taxable value and
 *                     every tax head agree. Nothing left to judge.
 *
 *   3. PROBABLE     — GSTIN and canonical number agree. It IS the same
 *                     document; the values disagree. ⚠️ Including when
 *                     they disagree by a lot — see below.
 *
 *   4. NUMBER       — GSTIN agrees, the numbers agree only after
 *      MISMATCH      normalisation, AND the date and taxable value agree.
 *                     ⚠️ THE CORROBORATION IS NOT OPTIONAL: normalisation
 *                     can collide (`A-1-2` and `A-12`), so an agreement
 *                     there is a candidate and never a conclusion.
 *
 *   5. LEFTOVERS    — everything untouched. A 2B row nobody claimed is
 *                     `in_2b_not_in_books`; a purchase invoice nobody
 *                     claimed is ⭐ `in_books_not_in_2b`, and its
 *                     eligible credit is at risk under Section 16(2)(aa).
 *
 * ⚠️ WHY A LARGE VALUE DIFFERENCE IS STILL `probable` AND NOT A
 * NON-MATCH. If the same supplier files the same invoice number for the
 * same month and the value differs by ₹40,000, that is one invoice with a
 * ₹40,000 discrepancy — the most serious thing on the worklist. Refusing
 * to pair them reports it as TWO exceptions in opposite directions: a
 * supplier who did not file, and a supply we never recorded. The netting
 * makes the period totals look almost right and the actual problem
 * disappears into a list of hundreds.
 */
export function reconcileGstr2b(args: {
  twoBRows: readonly TwoBRowFacts[];
  bookInvoices: readonly BookInvoiceFacts[];
  tolerance?: MatchTolerance;
}): MatchResult[] {
  const tolerance = args.tolerance ?? DEFAULT_MATCH_TOLERANCE;

  /* --- ⚠️ SORT FIRST. Determinism starts here, not later. -------- */
  //
  // The sort key ends in the row id, which makes it a TOTAL order: two
  // rows that agree on every business field still have a defined
  // position, so the engine's choice between two identical candidates is
  // fixed rather than incidental.
  const twoB: Indexed<TwoBRowFacts>[] = [...args.twoBRows]
    .map((facts) => ({
      facts,
      sortKey: [
        facts.supplierGstin ?? "",
        canonicaliseInvoiceNumber(facts.invoiceNumber),
        facts.invoiceDate,
        facts.id,
      ].join(" "),
      used: false,
    }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const books: Indexed<BookInvoiceFacts>[] = [...args.bookInvoices]
    .map((facts) => ({
      facts,
      sortKey: [
        facts.supplierGstin ?? "",
        canonicaliseInvoiceNumber(facts.invoiceNumber),
        facts.invoiceDate,
        facts.id,
      ].join(" "),
      used: false,
    }))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  /* --- Candidate indexes, built once over the sorted arrays ------ */
  //
  // Insertion order into each bucket is the sorted order, so "the first
  // free candidate" is a stable, documented choice rather than a
  // hash-table accident.
  const byCanonical = new Map<string, Indexed<BookInvoiceFacts>[]>();
  const byNormalised = new Map<string, Indexed<BookInvoiceFacts>[]>();

  for (const entry of books) {
    const gstin = entry.facts.supplierGstin ?? "";
    pushInto(
      byCanonical,
      `${gstin}|${canonicaliseInvoiceNumber(entry.facts.invoiceNumber)}`,
      entry,
    );
    pushInto(
      byNormalised,
      `${gstin}|${normaliseInvoiceNumber(entry.facts.invoiceNumber)}`,
      entry,
    );
  }

  const results: MatchResult[] = [];

  /* --- PASS 0 — CANCELLED ---------------------------------------- */

  for (const row of twoB) {
    if (row.used || row.facts.isCancelled !== true) continue;

    const candidates = freeCandidates(byCanonical, row.facts, canonicaliseInvoiceNumber);
    const chosen = candidates[0];

    if (!chosen) {
      // Cancelled, and we never recorded it. Nothing is at risk and
      // nothing needs chasing — but it stays on the 2B side of the
      // summary so the arithmetic still balances.
      row.used = true;
      results.push(
        buildResult({
          category: "in_2b_not_in_books",
          twoBRow: row.facts,
          bookInvoice: null,
          tolerance,
          score: 0,
          explanation:
            `The supplier filed and then CANCELLED document "${row.facts.invoiceNumber}". ` +
            `Nothing matching it is in the purchase register, so no credit was taken ` +
            `and nothing needs to be reversed. Recorded so the period's 2B total ` +
            `still adds up.`,
        }),
      );
      continue;
    }

    row.used = true;
    chosen.used = true;
    results.push(
      buildResult({
        category: "cancelled",
        twoBRow: row.facts,
        bookInvoice: chosen.facts,
        tolerance,
        score: 50,
        ambiguousCandidates: candidates.length,
        explanation:
          `⚠️ The supplier has CANCELLED document "${row.facts.invoiceNumber}". We hold ` +
          `a bill for this supply and it is in the purchase register. Any input tax ` +
          `credit taken on it must be reversed — Section 16(2)(aa) gives credit only ` +
          `for a document the supplier has furnished, and this one has been withdrawn.`,
      }),
    );
  }

  /* --- PASS 1 — AMENDMENTS --------------------------------------- */

  for (const row of twoB) {
    if (row.used || row.facts.isAmendment !== true) continue;

    // Their own number first: an amendment we already knew about will
    // have been corrected in our books. The original second: a bill
    // amended after we entered it still sits under the number we typed.
    let candidates = freeCandidates(byCanonical, row.facts, canonicaliseInvoiceNumber);
    let via = "the amended number";

    if (candidates.length === 0 && row.facts.originalInvoiceNumber) {
      candidates = freeCandidatesFor(
        byCanonical,
        row.facts.supplierGstin,
        canonicaliseInvoiceNumber(row.facts.originalInvoiceNumber),
      );
      via = `the ORIGINAL number "${row.facts.originalInvoiceNumber}"`;
    }
    if (candidates.length === 0) {
      candidates = freeCandidates(byNormalised, row.facts, normaliseInvoiceNumber);
      via = "the amended number, ignoring punctuation";
    }
    if (candidates.length === 0 && row.facts.originalInvoiceNumber) {
      candidates = freeCandidatesFor(
        byNormalised,
        row.facts.supplierGstin,
        normaliseInvoiceNumber(row.facts.originalInvoiceNumber),
      );
      via = `the ORIGINAL number "${row.facts.originalInvoiceNumber}", ignoring punctuation`;
    }

    const chosen = candidates[0];
    if (!chosen) continue; // Falls through to the leftovers pass.

    row.used = true;
    chosen.used = true;
    results.push(
      buildResult({
        category: "amended",
        twoBRow: row.facts,
        bookInvoice: chosen.facts,
        tolerance,
        score: 65,
        ambiguousCandidates: candidates.length,
        explanation:
          `⭐ The supplier AMENDED this document in a later return and it has been ` +
          `tied to the purchase register by ${via}. The amended figures SUPERSEDE ` +
          `the original — they are not additional to it — so the credit available is ` +
          `what is shown here, and any difference against what was already claimed ` +
          `must be adjusted in this period.`,
      }),
    );
  }

  /* --- PASS 2 — EXACT -------------------------------------------- */

  for (const row of twoB) {
    if (row.used) continue;

    const candidates = freeCandidates(
      byCanonical,
      row.facts,
      canonicaliseInvoiceNumber,
    ).filter((candidate) => isExact(row.facts, candidate.facts));

    const chosen = candidates[0];
    if (!chosen) continue;

    row.used = true;
    chosen.used = true;
    results.push(
      buildResult({
        category: "exact",
        twoBRow: row.facts,
        bookInvoice: chosen.facts,
        tolerance,
        score: 100,
        ambiguousCandidates: candidates.length,
        explanation:
          `The supplier's GSTIN, the invoice number, the invoice date, the taxable ` +
          `value and every tax head agree exactly. There is nothing left to judge.`,
      }),
    );
  }

  /* --- PASS 3 — PROBABLE ----------------------------------------- */

  for (const row of twoB) {
    if (row.used) continue;

    const candidates = freeCandidates(byCanonical, row.facts, canonicaliseInvoiceNumber);
    const chosen = candidates[0];
    if (!chosen) continue;

    row.used = true;
    chosen.used = true;

    const comparison = compare(row.facts, chosen.facts, tolerance);
    const withinAll =
      comparison.taxableWithinTolerance &&
      comparison.taxWithinTolerance &&
      comparison.dateWithinTolerance;

    results.push(
      buildResult({
        category: "probable",
        twoBRow: row.facts,
        bookInvoice: chosen.facts,
        tolerance,
        score: probableScore(comparison),
        ambiguousCandidates: candidates.length,
        explanation: withinAll
          ? `Same supplier, same invoice number. The figures differ by less than the ` +
            `round-off tolerance — the supplier foots the invoice, we foot the lines, ` +
            `and Section 170 lets either of them round to the rupee. Check the delta ` +
            `and accept.`
          : `⚠️ Same supplier, same invoice number — so this IS the same document — ` +
            `but the figures do not agree within the round-off tolerance. Taxable ` +
            `value differs by ${format(comparison.taxableDelta)} paise and tax by ` +
            `${format(comparison.taxDelta)} paise. One of the two records is wrong, ` +
            `and only ${comparison.taxDelta > 0n ? "the supplier's" : "our"} figure ` +
            `can be corrected by ${comparison.taxDelta > 0n ? "them" : "us"}.`,
      }),
    );
  }

  /* --- PASS 4 — NUMBER MISMATCH ---------------------------------- */
  //
  // ⚠️ THE THREE CORROBORATING FACTS ARE THE WHOLE SAFETY OF THIS PASS.
  // Normalisation alone collides. Same supplier AND same date AND the
  // same taxable value within tolerance is a coincidence a genuine
  // collision will not also produce.

  for (const row of twoB) {
    if (row.used) continue;

    const candidates = freeCandidates(byNormalised, row.facts, normaliseInvoiceNumber)
      .filter((candidate) => {
        const c = compare(row.facts, candidate.facts, tolerance);
        return c.dateWithinTolerance && c.taxableWithinTolerance;
      });

    const chosen = candidates[0];
    if (!chosen) continue;

    row.used = true;
    chosen.used = true;

    const comparison = compare(row.facts, chosen.facts, tolerance);
    results.push(
      buildResult({
        category: "number_mismatch",
        twoBRow: row.facts,
        bookInvoice: chosen.facts,
        tolerance,
        score: comparison.taxWithinTolerance ? 75 : 60,
        ambiguousCandidates: candidates.length,
        explanation:
          `${describeNumberDifference(row.facts.invoiceNumber, chosen.facts.invoiceNumber) ?? ""} ` +
          `The supplier's GSTIN, the invoice date and the taxable value all agree, ` +
          `which is why these have been proposed as one document. ⚠️ Normalisation ` +
          `alone is not proof — two genuinely different numbers can normalise the ` +
          `same — so this needs a person before it is accepted.`.trim(),
      }),
    );
  }

  /* --- PASS 5 — LEFTOVERS ---------------------------------------- */

  for (const row of twoB) {
    if (row.used) continue;
    row.used = true;
    results.push(
      buildResult({
        category: "in_2b_not_in_books",
        twoBRow: row.facts,
        bookInvoice: null,
        tolerance,
        score: 0,
        explanation:
          `⚠️ ${row.facts.supplierName ?? "A supplier"} has filed document ` +
          `"${row.facts.invoiceNumber}" dated ${row.facts.invoiceDate} against our ` +
          `GSTIN and nothing matching it is in the purchase register. Either the ` +
          `bill never reached us — in which case there is credit to claim once it is ` +
          `recorded — or an invoice has been raised against our GSTIN by somebody we ` +
          `do not deal with. The two look identical from here and only one of them ` +
          `is a happy discovery.`,
      }),
    );
  }

  for (const entry of books) {
    if (entry.used) continue;
    entry.used = true;
    results.push(
      buildResult({
        category: "in_books_not_in_2b",
        twoBRow: null,
        bookInvoice: entry.facts,
        tolerance,
        score: 0,
        explanation:
          `⭐ We hold invoice "${entry.facts.invoiceNumber}" from ` +
          `${entry.facts.vendorName ?? "this vendor"} and the supplier has NOT filed ` +
          `it. Section 16(2)(aa) makes the supplier's filing a precondition of the ` +
          `credit, and Rule 36(4) has allowed no cushion at all since January 2022 — ` +
          `so the credit is not available until they file. Chase them: after the ` +
          `Section 16(4) deadline it is gone permanently, whatever they do later.`,
      }),
    );
  }

  /* --- A stable output order ------------------------------------- */
  //
  // ⚠️ WORST FIRST, THEN BY SUPPLIER. The worklist is read top-down and
  // abandoned part-way; whatever is at the bottom is what nobody looks
  // at, so what is at the bottom must be what costs least to ignore.
  return results.sort((a, b) => {
    const rank = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
    if (rank !== 0) return rank;
    if (a.itcAtRiskMinor !== b.itcAtRiskMinor) {
      return a.itcAtRiskMinor > b.itcAtRiskMinor ? -1 : 1;
    }
    const left = `${a.supplierGstin ?? ""}|${a.twoBRowId ?? ""}|${a.bookInvoiceId ?? ""}`;
    const right = `${b.supplierGstin ?? ""}|${b.twoBRowId ?? ""}|${b.bookInvoiceId ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * ⚠️ THE EXPENSIVE EXCEPTIONS FIRST AND THE SETTLED ONES LAST. A
 * reconciliation worklist is read until somebody runs out of afternoon,
 * so the ordering IS the prioritisation.
 */
const CATEGORY_RANK: Readonly<Record<Gstr2bMatchCategory, number>> = Object.freeze({
  in_books_not_in_2b: 0, // ⭐ our credit, at risk
  cancelled: 1, // credit already taken that must come back
  in_2b_not_in_books: 2, // a missed bill, or somebody else's invoice
  number_mismatch: 3,
  probable: 4,
  amended: 5,
  exact: 6, // nothing to do
});

/* ------------------------------------------------------------------ */
/* COMPARISON                                                          */
/* ------------------------------------------------------------------ */

type Comparison = {
  taxableDelta: bigint;
  taxDelta: bigint;
  headDeltas: { cgst: bigint; sgst: bigint; igst: bigint; cess: bigint };
  dateAgrees: boolean;
  dateWithinTolerance: boolean;
  taxableWithinTolerance: boolean;
  taxWithinTolerance: boolean;
  headsWithinTolerance: boolean;
};

function totalTax(facts: {
  cgstMinor: bigint;
  sgstMinor: bigint;
  igstMinor: bigint;
  cessMinor: bigint;
}): bigint {
  return facts.cgstMinor + facts.sgstMinor + facts.igstMinor + facts.cessMinor;
}

function compare(
  row: TwoBRowFacts,
  book: BookInvoiceFacts,
  tolerance: MatchTolerance,
): Comparison {
  const taxableDelta = row.taxableValueMinor - book.taxableValueMinor;
  const taxDelta = totalTax(row) - totalTax(book);
  const headDeltas = {
    cgst: row.cgstMinor - book.cgstMinor,
    sgst: row.sgstMinor - book.sgstMinor,
    igst: row.igstMinor - book.igstMinor,
    cess: row.cessMinor - book.cessMinor,
  };

  const daysApart = civilDaysApart(row.invoiceDate, book.invoiceDate);

  return {
    taxableDelta,
    taxDelta,
    headDeltas,
    dateAgrees: row.invoiceDate === book.invoiceDate,
    dateWithinTolerance: daysApart <= tolerance.invoiceDateDays,
    taxableWithinTolerance: absDiff(row.taxableValueMinor, book.taxableValueMinor) <=
      tolerance.taxableValueMinor,
    taxWithinTolerance: absDiff(totalTax(row), totalTax(book)) <= tolerance.totalTaxMinor,
    headsWithinTolerance:
      absDiff(row.cgstMinor, book.cgstMinor) <= tolerance.headMinor &&
      absDiff(row.sgstMinor, book.sgstMinor) <= tolerance.headMinor &&
      absDiff(row.igstMinor, book.igstMinor) <= tolerance.headMinor &&
      absDiff(row.cessMinor, book.cessMinor) <= tolerance.headMinor,
  };
}

/**
 * ⚠️ EXACT MEANS EXACT — ZERO TOLERANCE, EVERY HEAD SEPARATELY.
 *
 * The head-by-head test is the part that would be tempting to drop, and
 * it is the part that catches a real and expensive error: a supplier who
 * charged IGST on a supply that was intra-state, or CGST+SGST on one that
 * was inter-state. The four heads then sum to the same total while the
 * credit lands in the wrong ledger entirely, and a comparison on the
 * total alone would call that an exact match and auto-accept it.
 */
function isExact(row: TwoBRowFacts, book: BookInvoiceFacts): boolean {
  return (
    row.invoiceDate === book.invoiceDate &&
    row.taxableValueMinor === book.taxableValueMinor &&
    row.cgstMinor === book.cgstMinor &&
    row.sgstMinor === book.sgstMinor &&
    row.igstMinor === book.igstMinor &&
    row.cessMinor === book.cessMinor
  );
}

function probableScore(c: Comparison): number {
  let score = 95;
  if (!c.dateAgrees) score -= 10;
  if (!c.taxableWithinTolerance) score -= 20;
  if (!c.taxWithinTolerance) score -= 20;
  if (!c.headsWithinTolerance) score -= 10;
  return Math.max(30, score);
}

function confidenceFor(category: Gstr2bMatchCategory, score: number): Gstr2bMatchConfidence {
  if (category === "exact") return "exact";
  if (category === "in_2b_not_in_books" || category === "in_books_not_in_2b") {
    return "none";
  }
  if (score >= 85) return "high";
  if (score >= 60) return "medium";
  return "low";
}

/* ------------------------------------------------------------------ */
/* RESULT CONSTRUCTION                                                 */
/* ------------------------------------------------------------------ */

function buildResult(args: {
  category: Gstr2bMatchCategory;
  twoBRow: TwoBRowFacts | null;
  bookInvoice: BookInvoiceFacts | null;
  tolerance: MatchTolerance;
  score: number;
  ambiguousCandidates?: number;
  explanation: string;
}): MatchResult {
  const { twoBRow, bookInvoice, category } = args;

  const matchedOn: FieldComparison[] = [];

  const field = (
    name: string,
    twoBValue: string | null,
    bookValue: string | null,
    deltaMinor?: bigint,
  ) => {
    matchedOn.push({
      field: name,
      twoB: twoBValue,
      books: bookValue,
      // ⚠️ A one-sided exception has nothing to agree WITH. Recording it
      // as "agrees: false" would make the workbench show four red
      // differences on an invoice whose only problem is that the supplier
      // has not filed.
      agrees:
        twoBRow === null || bookInvoice === null
          ? false
          : deltaMinor !== undefined
            ? deltaMinor === 0n
            : twoBValue === bookValue,
      ...(deltaMinor === undefined ? {} : { deltaMinor: deltaMinor.toString() }),
    });
  };

  const comparison =
    twoBRow && bookInvoice ? compare(twoBRow, bookInvoice, args.tolerance) : null;

  field(
    "supplier GSTIN",
    twoBRow?.supplierGstin ?? null,
    bookInvoice?.supplierGstin ?? null,
  );
  field("invoice number", twoBRow?.invoiceNumber ?? null, bookInvoice?.invoiceNumber ?? null);
  field("invoice date", twoBRow?.invoiceDate ?? null, bookInvoice?.invoiceDate ?? null);
  field(
    "taxable value",
    twoBRow ? twoBRow.taxableValueMinor.toString() : null,
    bookInvoice ? bookInvoice.taxableValueMinor.toString() : null,
    comparison?.taxableDelta,
  );
  field(
    "CGST",
    twoBRow ? twoBRow.cgstMinor.toString() : null,
    bookInvoice ? bookInvoice.cgstMinor.toString() : null,
    comparison?.headDeltas.cgst,
  );
  field(
    "SGST/UTGST",
    twoBRow ? twoBRow.sgstMinor.toString() : null,
    bookInvoice ? bookInvoice.sgstMinor.toString() : null,
    comparison?.headDeltas.sgst,
  );
  field(
    "IGST",
    twoBRow ? twoBRow.igstMinor.toString() : null,
    bookInvoice ? bookInvoice.igstMinor.toString() : null,
    comparison?.headDeltas.igst,
  );
  field(
    "cess",
    twoBRow ? twoBRow.cessMinor.toString() : null,
    bookInvoice ? bookInvoice.cessMinor.toString() : null,
    comparison?.headDeltas.cess,
  );

  const differences = matchedOn.filter((c) => !c.agrees);

  /* --- ⭐ WHAT IS AT RISK -------------------------------------- */
  //
  // ⚠️ THE ELIGIBLE CREDIT, NOT THE TAX ON THE DOCUMENT. A bill for
  // construction on our own account carries tax that Section 17(5)(d)
  // blocked — it was never claimable, so a supplier who failed to file it
  // has cost us nothing. Reporting the gross would put the biggest
  // numbers on the chase list against the vendors it is pointless to
  // chase, and a chase list nobody can act on is a chase list nobody
  // opens.
  let itcAtRisk = 0n;
  if (category === "in_books_not_in_2b" && bookInvoice) {
    itcAtRisk = bookInvoice.itcEligibleTaxMinor;
  } else if (category === "cancelled" && bookInvoice) {
    // Already claimed, and now unsupported. The whole eligible credit
    // has to come back out.
    itcAtRisk = bookInvoice.itcEligibleTaxMinor;
  } else if (comparison && bookInvoice) {
    // A shortfall in what the supplier declared caps what we may claim.
    // An excess does not put anything at risk — it is their problem.
    const shortfall = -comparison.taxDelta;
    if (shortfall > 0n) {
      itcAtRisk = shortfall > bookInvoice.itcEligibleTaxMinor
        ? bookInvoice.itcEligibleTaxMinor
        : shortfall;
    }
  }

  return {
    category,
    confidence: confidenceFor(category, args.score),
    score: args.score,
    twoBRowId: twoBRow?.id ?? null,
    bookInvoiceId: bookInvoice?.id ?? null,
    supplierGstin: twoBRow?.supplierGstin ?? bookInvoice?.supplierGstin ?? null,
    vendorId: bookInvoice?.vendorId ?? null,
    matchedOn,
    differences,
    taxableDeltaMinor: comparison?.taxableDelta ?? 0n,
    taxDeltaMinor: comparison?.taxDelta ?? 0n,
    itcAtRiskMinor: itcAtRisk,
    ambiguousCandidates: args.ambiguousCandidates ?? 0,
    // ⭐ THE PROHIBITION, IN ONE LINE.
    autoAcceptable: category === "exact",
    explanation: args.explanation,
    engineVersion: MATCH_ENGINE_VERSION,
  };
}

/* ------------------------------------------------------------------ */
/* SMALL HELPERS                                                       */
/* ------------------------------------------------------------------ */

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function freeCandidates(
  index: Map<string, Indexed<BookInvoiceFacts>[]>,
  row: TwoBRowFacts,
  keyOf: (value: string) => string,
): Indexed<BookInvoiceFacts>[] {
  return freeCandidatesFor(index, row.supplierGstin, keyOf(row.invoiceNumber));
}

function freeCandidatesFor(
  index: Map<string, Indexed<BookInvoiceFacts>[]>,
  gstin: string | null | undefined,
  numberKey: string,
): Indexed<BookInvoiceFacts>[] {
  // ⚠️ AN EMPTY NUMBER KEY MATCHES NOTHING, DELIBERATELY. A 2B row whose
  // number normalised to "" (all punctuation) would otherwise collide
  // with every book invoice whose number did the same, and the engine
  // would confidently pair two documents that have nothing in common.
  if (numberKey === "") return [];
  return (index.get(`${gstin ?? ""}|${numberKey}`) ?? []).filter((c) => !c.used);
}

function format(value: bigint): string {
  return (value < 0n ? -value : value).toString();
}
