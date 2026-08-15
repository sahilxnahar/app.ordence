/**
 * Ordence — ⭐⭐ Opening Balances: the pure arithmetic
 * Version: v1.58.0-alpha (Batch 58)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A BUSINESS THAT MOVES TO ORDENCE MID-YEAR ARRIVES CARRYING A
 *    POSITION, AND UNTIL THIS EXISTED THERE WAS NOWHERE TO PUT IT
 * ══════════════════════════════════════════════════════════════════════
 * They have a trial balance, a list of invoices customers have not paid,
 * a list of bills they have not paid, and stock on the shelf. Every one
 * of those is a fact about the day they switch over. With no way to enter
 * them, the first balance sheet Ordence produces says the company has no
 * bank balance, no debtors, no creditors and no capital — and it says so
 * for the rest of the company's life, because an opening position that
 * was never entered is not a number that can be corrected later without
 * restating every report in between.
 *
 * ⚠️ EVERYTHING IN THIS FILE IS PURE. No database, no clock, no `node:`
 * import — the same rule the rest of `lib/import/` lives by, and for the
 * same reason: the dry run and the real run must reach the same answer,
 * and the only way to be sure of that is for the answer to be computed by
 * code that cannot tell which one it is in.
 *
 * ⚠️ AND MONEY IS `bigint` MINOR UNITS THROUGHOUT, arriving here as
 * DECIMAL STRINGS of paise because that is what `coerceMoneyMinor`
 * produces (a bigint cannot cross a server-action boundary —
 * `JSON.stringify` throws on one). The conversion to `BigInt` happens
 * here, once, and never back to `Number`.
 */

import { coerceMoneyMinor, type CoercionResult } from "./values";
import type { ImportRowPlan } from "./types";

/* ------------------------------------------------------------------ */
/* THE KEY                                                             */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE IDEMPOTENCY KEY. ENTERING OPENING BALANCES TWICE MUST NOT
 *      DOUBLE THE BOOKS.
 * ══════════════════════════════════════════════════════════════════════
 * This is not a hypothetical. The normal second action after an import is
 * to fix a couple of rows and upload THE WHOLE FILE AGAIN, because the
 * whole file is what is on the customer's desktop. If nothing keys the
 * run, that second upload posts the entire opening position a second
 * time: every asset doubled, every liability doubled, and a trial balance
 * that still balances — so nothing anywhere reports an error. It is found
 * months later, by an accountant, in a year-end that will not tie.
 *
 * ⭐ SO THE KEY IS `OPENING:TB:<as-at date>` IN
 * `transactions.transaction_number`, which carries
 * `transactions_tenant_number_unique` — a UNIQUE INDEX, per tenant. The
 * application check produces a readable outcome ("this opening entry is
 * already posted"); the index is what makes two people pressing the
 * button at the same moment safe, and it cannot be bypassed by any
 * future caller that forgets to check.
 *
 * ⚠️ THE DATE IS PART OF THE KEY AND THE PREFIX IS NOT `SALES:`. Two
 * different as-at dates are two different opening positions and both are
 * legitimate. And a reader of the trial balance who sees `OPENING:TB:` in
 * the transaction number knows immediately that the entry is a migration
 * artefact rather than a trade — which `SALES:INV:` would have told them
 * the opposite of.
 */
export const OPENING_KEY_PREFIX = "OPENING";

export type OpeningKeyKind = "trial_balance" | "stock";

const OPENING_KEY_TAGS: Record<OpeningKeyKind, string> = {
  trial_balance: "TB",
  /**
   * ⚠️ ITS OWN TAG RATHER THAN SHARING THE TRIAL BALANCE'S. The stock
   * file and the trial-balance file are posted on separate presses of
   * separate buttons; one key covering both would mean importing the
   * ledger silently swallowed the stock, or the other way round,
   * depending on which was uploaded first.
   */
  stock: "STK",
};

export function openingBatchKey(kind: OpeningKeyKind, asAt: string): string {
  return `${OPENING_KEY_PREFIX}:${OPENING_KEY_TAGS[kind]}:${asAt}`;
}

/* ------------------------------------------------------------------ */
/* QUANTITIES                                                          */
/* ------------------------------------------------------------------ */

/**
 * A physical quantity as integer THOUSANDTHS, given as a decimal string.
 *
 * ⚠️ IT DELEGATES TO `coerceMoneyMinor` WITH AN EXPONENT OF 3 RATHER THAN
 * REIMPLEMENTING THE PARSE. That function already splits the string on
 * the decimal point and does the scaling in `BigInt`, which is the whole
 * point — `Math.round(Number("1.0005") * 1000)` is 1000 and not 1001, for
 * exactly the reason the money version documents at length. A second
 * parser here would be a second chance to get that wrong, and the two
 * would drift.
 *
 * ⚠️ WHAT IS NOT SHARED IS THE MESSAGE. `coerceMoneyMinor` says "write it
 * as rupees", which is a confusing thing to be told about a quantity of
 * cement, so the failure is re-worded and only the failure.
 */
export function coerceQuantityThousandths(raw: string): CoercionResult {
  const result = coerceMoneyMinor(raw, 3);
  if (result.ok) return result;
  return {
    ok: false,
    message:
      `"${raw.trim()}" is not a quantity. Write it as a plain number with up to ` +
      `three decimal places, for example 12.5 or 1250. Units belong in the ` +
      `item's record, not in this cell.`,
  };
}

/* ------------------------------------------------------------------ */
/* THE BALANCE RULE                                                    */
/* ------------------------------------------------------------------ */

/** Minor units held as a decimal string, as the coercion layer produces them. */
function minorOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || value.trim() === "") return 0n;
  /*
   * ⚠️ NEVER `Number(value)`. These strings are paise and routinely run
   * past 2^53 for a company of any size — a crore of rupees is 10^9
   * paise and a balance sheet total can be a hundred times that. `BigInt`
   * of a digit string cannot lose a digit it never converted.
   */
  return BigInt(value);
}

export type TrialBalanceTotals = {
  debitMinor: bigint;
  creditMinor: bigint;
  differenceMinor: bigint;
  /** Which column is SHORT — the side that needs adding to. */
  shortSide: "debit" | "credit" | null;
  balances: boolean;
};

/**
 * Add up a planned trial balance.
 *
 * ⚠️ ONLY ROWS THAT READ CLEANLY ARE COUNTED, and the caller must not use
 * the answer when there are rows that did not. See `fileRule` in
 * `types.ts`: arithmetic over a file with an unreadable amount in it
 * produces a difference that is an artefact of the unreadable cell, and
 * sends the customer hunting for an error that is not there.
 */
export function totalTrialBalance(
  rows: readonly ImportRowPlan[],
): TrialBalanceTotals {
  let debitMinor = 0n;
  let creditMinor = 0n;

  for (const row of rows) {
    if (row.errors.length > 0 || !row.payload) continue;
    debitMinor += minorOf(row.payload.debitMinor);
    creditMinor += minorOf(row.payload.creditMinor);
  }

  const differenceMinor =
    debitMinor > creditMinor ? debitMinor - creditMinor : creditMinor - debitMinor;

  return {
    debitMinor,
    creditMinor,
    differenceMinor,
    shortSide:
      differenceMinor === 0n ? null : debitMinor > creditMinor ? "credit" : "debit",
    balances: differenceMinor === 0n,
  };
}

/**
 * Rupees from paise, for a message. Integer arithmetic, never a division
 * of a `Number`.
 *
 * ⚠️ `Number(paise) / 100` IS FINE FOR SMALL NUMBERS AND SILENTLY WRONG
 * FOR LARGE ONES, and the numbers on a balance sheet are the large ones.
 * The string is assembled from the quotient and the remainder instead.
 */
export function rupeesOf(minor: bigint): string {
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / 100n;
  const paise = magnitude % 100n;
  return `${negative ? "-" : ""}₹${whole.toString()}.${paise.toString().padStart(2, "0")}`;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 AN OPENING TRIAL BALANCE THAT DOES NOT BALANCE IS REFUSED.
 *        THERE IS NO SUSPENSE PLUG, AND THAT IS THE DECISION.
 * ══════════════════════════════════════════════════════════════════════
 * The tempting implementation posts the difference to a "Suspense"
 * account so the import always succeeds. It is tempting because it is
 * kind: the customer gets their data in and can sort the difference out
 * later. It is wrong for two reasons that cost real money.
 *
 * FIRST, "later" does not come. A suspense balance created silently by an
 * importer has no owner and no due date. It sits on the balance sheet
 * under a name nobody recognises until an auditor asks what it is, by
 * which time the person who did the migration has left and the source
 * spreadsheet is gone. The one moment the difference can actually be
 * FOUND is the moment it appears — the customer still has the file open,
 * still remembers which account they were unsure about, and can look.
 *
 * SECOND, a difference in an opening trial balance is not noise. It means
 * one of the numbers is wrong, and the number that is wrong is a real
 * balance — a bank account, a loan, a director's current account. Booking
 * the difference to suspense does not make the wrong number right; it
 * makes it invisible, and every report built on it is wrong by exactly
 * that amount with nothing on screen to say so.
 *
 * ⚠️ IF A WORKSPACE GENUINELY NEEDS A SUSPENSE ACCOUNT — and some do,
 * because the old system's own trial balance did not tie — THEY ADD THE
 * LINE THEMSELVES. `ledger_type` already has a `suspense` member whose
 * schema comment says "must clear to zero", the account appears on the
 * balance sheet under the name they gave it, and the entry that put it
 * there is a line in a file they wrote. That is a named, deliberate,
 * visible decision. What this refuses to do is make it for them.
 *
 * ⭐ AND THE MESSAGE CARRIES THE ARITHMETIC. "Does not balance" is a
 * refusal the customer cannot act on. The difference, in rupees, and
 * WHICH SIDE IS SHORT, is the whole of what they need to find it.
 */
export function describeImbalance(totals: TrialBalanceTotals): string {
  return (
    `This trial balance does not balance and has not been imported. ` +
    `Debits total ${rupeesOf(totals.debitMinor)} and credits total ` +
    `${rupeesOf(totals.creditMinor)} — the ${totals.shortSide} column is short by ` +
    `${rupeesOf(totals.differenceMinor)}. ` +
    `Nothing has been posted, deliberately: an opening position is a single ` +
    `journal entry, and a difference means one of these balances is wrong rather ` +
    `than that the file needs a plug. Find it while you still have the file open. ` +
    `If your old system's own trial balance genuinely did not tie, add a line for ` +
    `a suspense account you have created and named yourself — it will then show on ` +
    `your balance sheet, which is where a difference belongs.`
  );
}

/**
 * The other whole-file rule: every line of one trial balance must be as
 * at the same day.
 *
 * 🔴 THE OPENING DATE IS ENTERED, NEVER ASSUMED TO BE THE DAY OF THE
 * UPLOAD. A workspace going live in July is entering a position as at
 * 31 March, and defaulting to "today" would date three months of trading
 * into the opening entry — which moves revenue across a financial year,
 * the one date error that changes a tax computation.
 *
 * ⚠️ AND IT IS A COLUMN RATHER THAN A FIELD ON THE UPLOAD SCREEN, so it
 * travels WITH the file. The same file re-uploaded next week produces the
 * same key and the same entry; a date picked on the screen would produce
 * a different key each time somebody forgot to change it back, and the
 * second run would post a second opening position rather than being
 * recognised as a repeat.
 */
export function disagreeingAsAtDates(rows: readonly ImportRowPlan[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.errors.length > 0 || !row.payload) continue;
    const asAt = row.payload.asAt;
    if (typeof asAt === "string") seen.add(asAt);
  }
  return Array.from(seen).sort();
}

export function describeDisagreeingDates(dates: readonly string[]): string {
  return (
    `The rows in this file are as at ${dates.length} different dates ` +
    `(${dates.join(", ")}), and an opening position is as at one day. ` +
    `Nothing has been imported. Split the file so each one carries a single ` +
    `"As at" date, or correct the rows that are wrong — the date decides which ` +
    `financial year the entry lands in, so it is not a formality.`
  );
}

/**
 * The sentence attached to every otherwise-valid row when an atomic file
 * is refused because some of its rows are not.
 *
 * ⚠️ IT SAYS WHAT HAPPENED TO *THIS* ROW, because it is read in a CSV
 * next to a row that has nothing wrong with it. "Nothing was imported"
 * without "including this row, which is fine" reads as a bug.
 */
export function describeAtomicRefusal(
  nounMany: string,
  badRows: number,
  totalRows: number,
): string {
  return (
    `Nothing in this file has been imported, including this row, which is fine. ` +
    `${badRows} of ${totalRows} rows could not be read, and ${nounMany} are posted ` +
    `as a single entry — importing the rest would leave a ledger that does not ` +
    `balance. Fix the rows that name a reason and upload the whole file again; ` +
    `re-running it is safe.`
  );
}
