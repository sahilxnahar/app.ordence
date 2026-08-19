/**
 * Ordence — ⭐⭐⭐ ONE RECEIPT AGAINST THREE INVOICES
 * Version: v1.67.0-alpha (Batch 0110)
 *
 * Pure. No clock, no network, no database. Every figure is an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT 0070 GOT WRONG, AND WHY DROPPING ITS INDEXES ALONE WOULD BE
 *    WORSE THAN LEAVING THEM
 * ══════════════════════════════════════════════════════════════════════
 * `bank_line_matches_one_per_line` and `bank_line_matches_one_per_document`
 * made matching strictly 1:1. That is wrong for the ordinary case: a
 * customer pays three invoices with one NEFT, a cheque covers two bills,
 * a supplier nets a credit note against a payment.
 *
 * ⚠️ BUT 0070'S COMMENT IS ALSO RIGHT ABOUT WHAT THE INDEXES WERE FOR.
 * Without an amount on each match row, dropping them lets one receipt
 * explain two statement lines and the residue still comes out to zero,
 * because the same rupees were counted on both sides. That is a
 * reconciliation which balances and is false, and a false balance is
 * worse than a refusal because nothing anywhere reports it.
 *
 * ⭐⭐ SO THE UNIT OF MATCHING IS NO LONGER THE PAIR. IT IS THE AMOUNT.
 * Every match row carries `allocated_minor`, and two sums bound it:
 *
 *     |Σ allocations against one statement line| ≤ |line amount|
 *     |Σ allocations against one document|       ≤ |document amount|
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THOSE ARE `≤` AND NOT `=`, WHICH IS THE ONE DESIGN DECISION IN
 *    THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * A brief for this work asked for a constraint that the allocations
 * against one line SUM TO that line's amount. It cannot be that, and the
 * reason is not a limitation of Postgres:
 *
 *   ⚠️ Matching one receipt to three invoices is three separate acts by
 *      a person. After the first, the line is one-third explained. An
 *      equality constraint would refuse that first insert, so the only
 *      way to record three allocations would be to record all three in
 *      one statement — and a screen that makes you get a whole month
 *      right in one submission is a screen where somebody guesses the
 *      third figure to make the form submit.
 *
 * ⭐ SO EQUALITY IS NOT A CONSTRAINT. IT IS A PROPERTY, `fullyAllocated`,
 *    AND THE BANK RECONCILIATION STATEMENT READS IT. A line that is
 *    partly explained is not "matched": its UNEXPLAINED RESIDUE is an
 *    outstanding item on the BRS, by name, with its own amount.
 *
 * 🔴 THAT IS THE HALF THAT MAKES THE FALSE BALANCE IMPOSSIBLE. `≤` alone
 *    would let a ₹10,000 line carry ₹6,000 of allocations and vanish off
 *    the outstanding list, and the missing ₹4,000 would surface as an
 *    "unexplained difference" with nothing saying which line it came
 *    from. Carrying the residue as a named item means every paisa of
 *    every line is either allocated to a document or printed on the
 *    statement as outstanding. There is no third place for money to go.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE SIGN
 * ══════════════════════════════════════════════════════════════════════
 * Positive is money IN, as everywhere else in this module. An allocation
 * carries the SAME sign as the thing it explains. A negative allocation
 * against a positive receipt would let two rows cancel to nothing while
 * both claiming to explain money, which is the arithmetic version of the
 * same false balance.
 */

import type { Minor } from "./match";

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/**
 * One row of `bank_line_matches`, reduced to what the arithmetic needs.
 *
 * ⚠️ `id` is nullable because the row being VALIDATED does not have one
 * yet. A proposed allocation and a stored one have to go through the
 * same function or the check that runs on save is not the check that ran
 * on screen.
 */
export interface AllocationRow {
  readonly id: string | null;
  readonly statementLineId: string;
  readonly matchedKind: string;
  readonly matchedId: string;
  /** 🔴 SIGNED, same sign as the line and the document it joins. */
  readonly allocatedMinor: Minor;
}

/** What a statement line or a ledger document is worth, signed. */
export interface AllocationTarget {
  readonly id: string;
  readonly amountMinor: Minor;
  /** For the refusal sentence: "this bank line" / "receipt RC-0012". */
  readonly label: string;
}

export type AllocationSide = "line" | "document";

/* ------------------------------------------------------------------ */
/* ARITHMETIC                                                          */
/* ------------------------------------------------------------------ */

/** ⚠️ `-x` on a bigint is exact. `Math.abs` must never touch money. */
export function magnitude(value: Minor): Minor {
  return value < 0n ? -value : value;
}

export function sumAllocated(rows: readonly AllocationRow[]): Minor {
  let total = 0n;
  for (const r of rows) total += r.allocatedMinor;
  return total;
}

/**
 * ⭐⭐⭐ THE UNEXPLAINED RESIDUE OF ONE TARGET, SIGNED.
 *
 * 🔴 THIS IS THE NUMBER THE BANK RECONCILIATION STATEMENT NEEDS. Zero
 * means the target is fully explained and does not appear as an
 * outstanding item. Anything else is money that has to be printed.
 *
 * ⚠️ IT IS `amount − allocated`, NOT `|amount| − |allocated|`. Those
 * differ the moment an allocation has the wrong sign, and the signed
 * form is the one that keeps the BRS identity true: a wrongly signed
 * allocation makes the residue LARGER than the line, which shows up on
 * the statement rather than quietly halving it.
 */
export function residueOf(target: AllocationTarget, rows: readonly AllocationRow[]): Minor {
  return target.amountMinor - sumAllocated(rows);
}

export function isFullyAllocated(
  target: AllocationTarget,
  rows: readonly AllocationRow[],
): boolean {
  return residueOf(target, rows) === 0n;
}

/**
 * ⭐ HOW MUCH OF THIS TARGET IS STILL AVAILABLE TO ALLOCATE, SIGNED.
 * The screen offers this as the default so the ordinary case — one line,
 * one document, whole amount — stays one click.
 */
export function remainingOf(
  target: AllocationTarget,
  rows: readonly AllocationRow[],
): Minor {
  const residue = residueOf(target, rows);
  // ⚠️ Over-allocation is already refused, so a residue of the opposite
  // sign to the target can only arise from data written around this
  // module. Reporting zero rather than a negative "remaining" stops a
  // screen offering to allocate money in the wrong direction.
  if (target.amountMinor > 0n && residue < 0n) return 0n;
  if (target.amountMinor < 0n && residue > 0n) return 0n;
  return residue;
}

/* ------------------------------------------------------------------ */
/* 🔴 THE REFUSALS                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ ONE FUNCTION, CALLED BY THE SERVER AND MIRRORED BY THE TRIGGER.
 *
 * ⚠️ RETURNS A SENTENCE OR NULL RATHER THAN THROWING. A validator that
 * throws inside a list renderer turns "one allocation is too big" into a
 * blank screen, and the operator then has no idea which one.
 *
 * 🔴 `existing` MUST EXCLUDE THE ROW BEING EDITED. Passing a row's own
 * stored allocation in `existing` while also passing it as `proposed`
 * counts it twice and refuses a change that shrinks it — which is the
 * one change somebody makes after getting it wrong.
 */
export function allocationRefusal(args: {
  side: AllocationSide;
  target: AllocationTarget;
  /** Allocations already recorded against this target, excluding the one under test. */
  existing: readonly AllocationRow[];
  /** The allocation being added or changed. */
  proposedMinor: Minor;
}): string | null {
  const { side, target, existing, proposedMinor } = args;

  if (proposedMinor === 0n) {
    return "An allocation of zero explains nothing. Unmatch the row instead of setting it to zero: a match row that accounts for no money looks like an explanation on every screen that counts rows.";
  }

  if (target.amountMinor === 0n) {
    // ⚠️ `bank_statement_lines` has a CHECK forbidding this, so it can
    // only arrive from a document. Refused rather than divided by.
    return `${target.label} is for nothing, so there is nothing to allocate against it.`;
  }

  const sameSign =
    (proposedMinor > 0n && target.amountMinor > 0n) ||
    (proposedMinor < 0n && target.amountMinor < 0n);

  if (!sameSign) {
    return (
      `${target.label} ${target.amountMinor > 0n ? "brought money in" : "took money out"}, ` +
      `so an allocation against it has to do the same. An allocation pointing the other way lets two rows cancel to nothing while both claim to explain money that moved.`
    );
  }

  const already = sumAllocated(existing);
  const after = already + proposedMinor;

  if (magnitude(after) > magnitude(target.amountMinor)) {
    const room = magnitude(target.amountMinor) - magnitude(already);
    return (
      `${target.label} is ${paise(target.amountMinor)} and ${paise(already)} of it ${
        already === 0n ? "is" : "has already been"
      } allocated, so there ${room === 1n ? "is" : "are"} ${paise(room)} left. ` +
      `Allocating ${paise(proposedMinor)} would explain more money than actually moved. ` +
      (side === "line"
        ? "A statement line that is over-explained makes the reconciliation balance while being false, because the same rupees are counted on both sides."
        : "A document that is over-allocated has been paid more than once as far as the books are concerned, and the second payment has nowhere to sit.")
    );
  }

  return null;
}

/**
 * ⚠️ PAISE, NOT RUPEES, AND DELIBERATELY. This string goes into a
 * refusal an operator reads next to a figure they typed in paise. A
 * rupee conversion here would need the currency exponent, which this
 * pure module does not have and must not guess — `lib/fx/currency.ts`
 * carries it per currency and JPY has none while KWD has three.
 */
function paise(value: Minor): string {
  return `${magnitude(value).toString()} paise`;
}

/* ------------------------------------------------------------------ */
/* ⭐ THE JOURNAL SPECIAL CASE                                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 A BANK CHARGE WRITTEN UP FROM THE STATEMENT EXPLAINS ITS LINE
 *    EXACTLY, ALWAYS, AND MUST BE THE ONLY THING ON IT.
 *
 * `postBankLineAdjustment` posts a journal for the whole line and matches
 * it in the same transaction. Splitting that across two documents is not
 * a case that exists: the journal was created FROM the line and is for
 * the line's amount by construction.
 *
 * ⚠️ SAID HERE AS WELL AS IN THE TRIGGER because a partial allocation
 * against a journal would leave a residue on the BRS that no document
 * can ever close — the journal cannot be topped up, only reversed.
 */
export function journalAllocationRefusal(args: {
  matchedKind: string;
  lineAmountMinor: Minor;
  proposedMinor: Minor;
  existingRowCount: number;
}): string | null {
  if (args.matchedKind !== "journal_entry") return null;

  if (args.proposedMinor !== args.lineAmountMinor) {
    return "A journal written up from this statement line is for the whole line by construction, so it cannot be allocated in part. If only part of this line is a bank charge, the rest is a document somewhere else and belongs matched to that document.";
  }

  if (args.existingRowCount > 0) {
    return "This line already has an explanation. A journal written up from it accounts for all of it, so a second row would explain the same movement of money twice.";
  }

  return null;
}
