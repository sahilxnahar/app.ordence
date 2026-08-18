/**
 * Ordence — ⭐⭐⭐ THE BANK RECONCILIATION STATEMENT ITSELF
 * Version: v1.64.0-alpha (Batch 0102)
 *
 * Pure. No clock, no network, no database. Every date is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MATCHING IS NOT RECONCILING, AND `lib/banking/match.ts` ONLY DOES
 *    THE FIRST
 * ══════════════════════════════════════════════════════════════════════
 * `reconcile()` in that file answers one question well: after both
 * unmatched lists are allowed for, is there anything left over? That is
 * the arithmetic CHECK on a reconciliation. It is not the reconciliation.
 *
 * ⚠️ WHAT AN AUDITOR ASKS FOR IS A DOCUMENT WITH NAMED LINES ON IT:
 *
 *     Balance as per bank statement                      12,45,000
 *     Less: cheques issued but not presented              (85,000)
 *     Add:  deposits made but not yet credited             40,000
 *     Add:  bank charges not yet in the books               1,180
 *     Less: interest / direct credits not in the books     (2,500)
 *     ───────────────────────────────────────────────────────────
 *     Balance as per books                              11,98,680
 *
 * 🔴 A SINGLE `unexplainedMinor` DOES NOT ANSWER THAT. It says the
 * arithmetic closes; it does not say WHICH cheques, for how much, issued
 * how long ago. A cheque outstanding for four months is a stale
 * instrument that should be written back, and it is invisible in a total.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE FOUR CATEGORIES ARE DERIVED, NOT CHOSEN
 * ══════════════════════════════════════════════════════════════════════
 * Which side an item is unmatched on, and the sign of its amount,
 * determine the category completely. There is no dropdown, because a
 * dropdown is a place for somebody to put a cheque in the wrong row and
 * still see a statement that foots.
 *
 *   unmatched IN THE BOOKS, money out  → cheque issued, not presented
 *   unmatched IN THE BOOKS, money in   → deposit made, not yet credited
 *   unmatched IN THE BANK,  money out  → bank charge / direct debit
 *   unmatched IN THE BANK,  money in   → interest / direct credit
 *
 * ⚠️ THE LAST TWO ARE THE ONES THE BOOKS ARE MISSING ENTRIES FOR. They
 * are the reason this screen has a "post this" button at all: the charge
 * was discovered here, so this is where it should be written up.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 TOLERANCE: A RECONCILIATION THAT "BALANCES" BECAUSE OF A ROUNDING
 *    ALLOWANCE IS A RECONCILIATION THAT DOES NOT BALANCE
 * ══════════════════════════════════════════════════════════════════════
 * `toleranceMinor` is therefore:
 *
 *   • an explicit per-account number, defaulting to ZERO, never a
 *     constant hidden in this file;
 *   • READ at the comparison — `withinTolerance` is computed from it and
 *     from nothing else;
 *   • and any difference it permits is RECORDED, on the statement and on
 *     the persisted row, as `differenceAbsorbedMinor`.
 *
 * ⚠️ `reconcilesExactly` NEVER LOOKS AT THE TOLERANCE. A reconciliation
 * that needed 40 paise of slack is a reconciliation with 40 paise
 * unexplained, and the artefact says so in both places forever. The
 * tolerance decides whether somebody may SIGN, not whether it balanced.
 */

import type { LedgerCandidate, Minor, StatementLine } from "./match";

/* ------------------------------------------------------------------ */
/* THE CATEGORIES                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THESE STRINGS ARE STORED IN `bank_reconciliation_items.category` and
 * are checked by a CHECK constraint in 0102. Renaming one here without
 * renaming it there produces rows the database refuses, which is the
 * right failure — but it is worth knowing that is what will happen.
 */
export const RECONCILIATION_CATEGORIES = Object.freeze([
  "cheque_not_presented",
  "deposit_not_credited",
  "bank_charge_not_in_books",
  "direct_credit_not_in_books",
] as const);

export type ReconciliationCategory = (typeof RECONCILIATION_CATEGORIES)[number];

/** Which list the item came off. Kept because the two mean opposite things. */
export type ItemSide = "bank" | "books";

export interface ReconciliationItem {
  readonly category: ReconciliationCategory;
  readonly side: ItemSide;
  /** `bank_statement_lines.id` for a bank item, the document id for a book item. */
  readonly sourceId: string;
  /** For a book item: which kind of document. Null for a bank line. */
  readonly sourceKind: string | null;
  readonly occurredOn: string;
  /**
   * 🔴 SIGNED, positive is money IN, exactly as everywhere else in this
   * module. The magnitude the printed statement shows is derived from
   * this; storing the magnitude instead would lose the direction and the
   * direction is what decides which side of the BRS it falls on.
   */
  readonly amountMinor: Minor;
  readonly description: string;
}

export const CATEGORY_META: Record<
  ReconciliationCategory,
  {
    label: string;
    /** How this line moves the bank balance towards the book balance. */
    effect: "add" | "subtract";
    help: string;
  }
> = {
  cheque_not_presented: {
    label: "Cheques issued but not presented",
    // Books have already paid it out; the bank has not. Bank reads high.
    effect: "subtract",
    help: "We wrote the cheque and reduced the books. The bank has not paid it yet, so the bank balance is higher than ours by this much. A cheque still outstanding after three months is stale and should be written back rather than carried.",
  },
  deposit_not_credited: {
    label: "Deposits made but not yet credited",
    // Books have taken it in; the bank has not. Bank reads low.
    effect: "add",
    help: "We banked it and increased the books. The bank has not credited it yet, so the bank balance is lower than ours by this much. If it is still here next month it did not clear, and that is a customer who has not actually paid.",
  },
  bank_charge_not_in_books: {
    label: "Bank charges and direct debits not in the books",
    // Bank has taken it; books have not. Bank reads low.
    effect: "add",
    help: "The bank took this and nobody has written it up. It is a real expense the books do not have — post it from this screen rather than remembering to do it somewhere else.",
  },
  direct_credit_not_in_books: {
    label: "Interest and direct credits not in the books",
    // Bank has given it; books have not. Bank reads high.
    effect: "subtract",
    help: "Money arrived that the books do not know about: interest credited, or a customer who paid straight in without telling anybody. Post it, or find the receipt it belongs to.",
  },
};

/**
 * ⭐ WHICH CATEGORY AN ITEM FALLS IN, FROM ITS SIDE AND ITS SIGN.
 *
 * ⚠️ A ZERO-AMOUNT ITEM CANNOT ARISE — `bank_statement_lines` has a
 * CHECK forbidding it and a ledger document of nothing is not a
 * document. It is treated as money-out here rather than thrown on,
 * because a pure function that throws inside a report generator turns a
 * data oddity into a blank page.
 */
export function categoryFor(side: ItemSide, amountMinor: Minor): ReconciliationCategory {
  if (side === "books") {
    return amountMinor > 0n ? "deposit_not_credited" : "cheque_not_presented";
  }
  return amountMinor > 0n ? "direct_credit_not_in_books" : "bank_charge_not_in_books";
}

/* ------------------------------------------------------------------ */
/* THE STATEMENT                                                       */
/* ------------------------------------------------------------------ */

export interface BrsInput {
  /** What the bank says the account holds at `asAt`. */
  readonly bankBalanceMinor: Minor;
  /** What the ledger says, at the same instant. */
  readonly bookBalanceMinor: Minor;
  readonly unmatchedInBank: readonly StatementLine[];
  readonly unmatchedInLedger: readonly LedgerCandidate[];
  /**
   * 🔴 EXPLICIT, PER-ACCOUNT, AND ZERO BY DEFAULT. See the header. A
   * negative value is treated as zero rather than refused, because this
   * arrives from a column and a report must not fail to render.
   */
  readonly toleranceMinor: Minor;
}

export interface BrsTotals {
  readonly chequesNotPresentedMinor: Minor;
  readonly depositsNotCreditedMinor: Minor;
  readonly bankChargesMinor: Minor;
  readonly directCreditsMinor: Minor;
}

export interface Brs {
  readonly bankBalanceMinor: Minor;
  readonly bookBalanceMinor: Minor;
  /**
   * ⭐ POSITIVE MAGNITUDES, because that is how the statement prints.
   * The direction lives in `CATEGORY_META[...].effect`, in one place,
   * rather than in a sign the renderer has to remember to interpret.
   */
  readonly totals: BrsTotals;
  /** The book balance the four categories imply, starting from the bank. */
  readonly derivedBookBalanceMinor: Minor;
  /**
   * 🔴 `bookBalance − derivedBookBalance`. Zero means the statement
   * reconciles. Positive means the books hold more than the bank plus
   * the outstanding items can account for.
   */
  readonly differenceMinor: Minor;
  /** ⚠️ Never consults the tolerance. See the header. */
  readonly reconcilesExactly: boolean;
  readonly toleranceMinor: Minor;
  readonly withinTolerance: boolean;
  /**
   * 🔴 WHAT THE TOLERANCE IS BEING ASKED TO SWALLOW, RECORDED SO IT IS
   * NOT SWALLOWED. Zero when the statement reconciles exactly, and zero
   * when the difference is too big for the tolerance to reach — in that
   * case nothing is absorbed because nothing may be signed.
   */
  readonly differenceAbsorbedMinor: Minor;
  /** ⭐ Whether a person is permitted to sign this off at all. */
  readonly signOffPermitted: boolean;
  readonly items: readonly ReconciliationItem[];
  readonly notes: readonly string[];
}

/**
 * ⭐⭐ THE STATEMENT, BUILT FROM THE BANK BALANCE DOWNWARDS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE IDENTITY THIS FUNCTION GUARANTEES, IN MINOR UNITS, EXACTLY
 * ══════════════════════════════════════════════════════════════════════
 *     bank
 *       − chequesNotPresented
 *       + depositsNotCredited
 *       + bankCharges
 *       − directCredits
 *       + difference
 *     = book
 *
 * It holds for every input, including nonsensical ones, because
 * `difference` is DEFINED as whatever makes it hold. That is the point:
 * a BRS that always foots is a BRS whose residue is always visible, and
 * the failure mode this replaces is a statement that quietly drops the
 * bit it could not explain.
 *
 * ⚠️ IT IS NOT AN ASSERTION AND MUST NOT BECOME ONE. A month-end
 * reconciliation that throws instead of printing tells the accountant
 * nothing about what is wrong.
 */
export function buildBrs(input: BrsInput): Brs {
  const tolerance = input.toleranceMinor > 0n ? input.toleranceMinor : 0n;

  const items: ReconciliationItem[] = [];

  for (const line of input.unmatchedInBank) {
    items.push({
      category: categoryFor("bank", line.amountMinor),
      side: "bank",
      sourceId: line.id,
      sourceKind: null,
      occurredOn: line.valueDate,
      amountMinor: line.amountMinor,
      description: line.narration.replace(/\s+/g, " ").trim().slice(0, 400),
    });
  }

  for (const candidate of input.unmatchedInLedger) {
    items.push({
      category: categoryFor("books", candidate.amountMinor),
      side: "books",
      sourceId: candidate.id,
      sourceKind: candidate.kind,
      occurredOn: candidate.occurredOn,
      amountMinor: candidate.amountMinor,
      description:
        candidate.documentNo ??
        candidate.reference ??
        candidate.counterpartyName ??
        candidate.kind,
    });
  }

  /**
   * ⚠️ MAGNITUDES. `-x` on a bigint is exact; there is no float here and
   * `Math.abs` must never be reached for money.
   */
  const magnitude = (category: ReconciliationCategory): Minor => {
    let total = 0n;
    for (const item of items) {
      if (item.category !== category) continue;
      total += item.amountMinor < 0n ? -item.amountMinor : item.amountMinor;
    }
    return total;
  };

  const totals: BrsTotals = {
    chequesNotPresentedMinor: magnitude("cheque_not_presented"),
    depositsNotCreditedMinor: magnitude("deposit_not_credited"),
    bankChargesMinor: magnitude("bank_charge_not_in_books"),
    directCreditsMinor: magnitude("direct_credit_not_in_books"),
  };

  const derivedBook =
    input.bankBalanceMinor -
    totals.chequesNotPresentedMinor +
    totals.depositsNotCreditedMinor +
    totals.bankChargesMinor -
    totals.directCreditsMinor;

  const difference = input.bookBalanceMinor - derivedBook;
  const reconcilesExactly = difference === 0n;

  const magnitudeOfDifference = difference < 0n ? -difference : difference;
  const withinTolerance = magnitudeOfDifference <= tolerance;

  /**
   * 🔴 ABSORBED ONLY WHERE THE TOLERANCE IS ACTUALLY DOING THE WORK.
   * A zero difference absorbs nothing (there is nothing to absorb) and a
   * difference beyond the tolerance absorbs nothing either (nothing may
   * be signed, so nothing is being let through).
   */
  const differenceAbsorbedMinor =
    !reconcilesExactly && withinTolerance ? difference : 0n;

  const notes: string[] = [];

  if (!reconcilesExactly && !withinTolerance) {
    notes.push(
      "This account does not reconcile. After allowing for every outstanding item on both sides there is still a difference, which means a confirmed match is wrong or something is missing from both lists. It is not a rounding error and it will not become one by being signed.",
    );
  }

  if (differenceAbsorbedMinor !== 0n) {
    notes.push(
      `This statement does not foot exactly: ${differenceAbsorbedMinor} paise is being allowed through by the tolerance of ${tolerance} paise configured on this account. The amount is recorded on the reconciliation and stays on it. A tolerance is permission to sign, not evidence that the account balanced.`,
    );
  }

  if (totals.bankChargesMinor > 0n || totals.directCreditsMinor > 0n) {
    notes.push(
      "Some of the items below are in the bank and not in the books: charges, interest, direct debits. These are real journal entries the books do not have yet, and they were discovered here, so post them from here.",
    );
  }

  if (totals.chequesNotPresentedMinor > 0n || totals.depositsNotCreditedMinor > 0n) {
    notes.push(
      "Some of the items below are in the books and not in the bank. A cheque written and not yet presented is normal. A deposit that has not been credited is normal for a day and is a customer who has not paid after a week, and the two look identical on this list until somebody checks the date.",
    );
  }

  return {
    bankBalanceMinor: input.bankBalanceMinor,
    bookBalanceMinor: input.bookBalanceMinor,
    totals,
    derivedBookBalanceMinor: derivedBook,
    differenceMinor: difference,
    reconcilesExactly,
    toleranceMinor: tolerance,
    withinTolerance,
    differenceAbsorbedMinor,
    /**
     * ⭐ EXACT, OR WITHIN A TOLERANCE SOMEBODY DELIBERATELY CONFIGURED.
     * With the default tolerance of zero these are the same thing, which
     * is the intended default.
     */
    signOffPermitted: reconcilesExactly || withinTolerance,
    items,
    notes,
  };
}

/**
 * ⭐ THE PRINTED STATEMENT, AS ORDERED LINES.
 *
 * ⚠️ THE RENDERER MUST NOT DECIDE THE ORDER OR THE SIGNS. Two screens
 * that lay the same BRS out differently is how one of them ends up
 * adding a line that should be subtracted, and it foots either way
 * because the reader is checking the total against the total.
 */
export interface BrsPrintLine {
  readonly label: string;
  readonly amountMinor: Minor;
  readonly effect: "opening" | "add" | "subtract" | "total";
}

export function printableBrs(brs: Brs): readonly BrsPrintLine[] {
  const lines: BrsPrintLine[] = [
    {
      label: "Balance as per bank statement",
      amountMinor: brs.bankBalanceMinor,
      effect: "opening",
    },
  ];

  const push = (category: ReconciliationCategory, amount: Minor) => {
    if (amount === 0n) return;
    lines.push({
      label: CATEGORY_META[category].label,
      amountMinor: amount,
      effect: CATEGORY_META[category].effect,
    });
  };

  push("cheque_not_presented", brs.totals.chequesNotPresentedMinor);
  push("deposit_not_credited", brs.totals.depositsNotCreditedMinor);
  push("bank_charge_not_in_books", brs.totals.bankChargesMinor);
  push("direct_credit_not_in_books", brs.totals.directCreditsMinor);

  /**
   * 🔴 THE RESIDUE IS A LINE ON THE STATEMENT, NOT A FOOTNOTE. A BRS
   * that reaches the book balance by omitting the bit it could not
   * explain is the exact artefact this module exists to prevent.
   */
  if (brs.differenceMinor !== 0n) {
    lines.push({
      label:
        brs.differenceAbsorbedMinor !== 0n
          ? "Difference allowed through by the configured tolerance"
          : "Unexplained difference",
      amountMinor: brs.differenceMinor,
      effect: "add",
    });
  }

  lines.push({
    label: "Balance as per books",
    amountMinor: brs.bookBalanceMinor,
    effect: "total",
  });

  return lines;
}

/* ------------------------------------------------------------------ */
/* THE LOCK                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE ONE PREDICATE THE LOCK IS MADE OF.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS PROJECT HAS SHIPPED SEVEN COLUMNS THAT NOTHING EVER READ
 * ══════════════════════════════════════════════════════════════════════
 * `bank_accounts.reconciled_to` was very nearly the eighth. It has
 * existed since 0070, it is displayed on the banking screen, and before
 * this batch the only thing that ever wrote it was `reconciledTo: null`
 * at account creation. Nothing consulted it. Every match under a
 * signed-off date could be added or removed freely, and the signed
 * figure would change underneath the signature with no record.
 *
 * ⚠️ SO THE PREDICATE LIVES IN ONE PURE FUNCTION, and every write path
 * that could move a reconciled figure calls THIS, not its own inline
 * comparison. Four inline comparisons is four chances for one of them to
 * be `<` where the others are `<=`.
 *
 * ⭐ `<=`, NOT `<`. "Reconciled to 31 March" includes 31 March. A lock
 * that excluded its own boundary date would leave the last day of every
 * reconciled month editable, which is the day the month-end entries are
 * on.
 */
export function isLockedByReconciliation(
  valueDate: string,
  reconciledTo: string | null,
): boolean {
  if (reconciledTo === null) return false;
  return valueDate <= reconciledTo;
}

/**
 * ⚠️ THE REFUSAL CARRIES ITS REMEDY, because the alternative is an
 * operator concluding the software is broken and asking somebody to fix
 * it in the database — which is precisely the act the lock exists to
 * prevent.
 */
export function reconciliationLockRefusal(
  what: string,
  valueDate: string,
  reconciledTo: string,
): string {
  return (
    `This bank line is dated ${valueDate}, and this account is reconciled to ${reconciledTo}. ` +
    `${what} would change a figure that has already been signed off, and the signed statement would no longer be reproducible from the data behind it. ` +
    `Reopen the reconciliation for this account with a reason if the signed figure is genuinely wrong; that is recorded, and changing it quietly is not.`
  );
}
