/**
 * Ordence — ⭐ Customer Ledger, Ageing and the Statement
 * Version: v0.91.0-alpha
 *
 * Pure. `bigint` paise, `YYYY-MM-DD` civil days, no clock and no
 * database. `toCivilDay` comes from `lib/gst/constants.ts` and is NOT
 * restated — a second date normaliser that disagrees by a timezone is
 * how an invoice lands in the wrong ageing bucket on the last day of a
 * month.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SIGN CONVENTION, STATED ONCE SO IT IS NEVER GUESSED
 * ══════════════════════════════════════════════════════════════════════
 * A customer account is a RECEIVABLE.
 *
 *     debit   → they owe MORE  (an invoice, a debit note)
 *     credit  → they owe LESS  (a receipt, a credit note, TDS withheld)
 *     balance  = debits − credits
 *
 * A POSITIVE balance means money is owed TO US.
 *
 * ⚠️ THIS IS THE EXACT MIRROR OF `lib/purchases/vendor-ledger.ts`, which
 * states the opposite because a vendor account is a PAYABLE. Copying
 * either file's convention into the other by analogy produces a report on
 * which every counterparty is in credit — which looks like a data problem
 * and gets debugged in the wrong place for a day.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE BALANCE IS COMPUTED AND NEVER STORED
 * ══════════════════════════════════════════════════════════════════════
 * A stored running balance is correct until the first BACKDATED entry —
 * and a receipt dated the day the cheque was written, entered the day it
 * cleared, is backdated every single time. The moment one lands, every
 * stored balance after that date is wrong, with no error, no log line and
 * no screen that looks different. The report simply stops agreeing with
 * the sum of its own rows.
 */

import { toCivilDay } from "@/lib/gst/constants";

/* ------------------------------------------------------------------ */
/* ENTRIES                                                             */
/* ------------------------------------------------------------------ */

export type CustomerLedgerEntryType =
  | "invoice"
  | "receipt"
  | "credit_note"
  | "debit_note"
  | "tds_withheld"
  | "write_off"
  | "opening_balance";

export type CustomerLedgerEntry = {
  id: string;
  entryDate: string;
  entryType: CustomerLedgerEntryType;
  reference: string;
  description?: string | null;
  /** They owe more. Paise, non-negative. */
  debitMinor: bigint;
  /** They owe less. Paise, non-negative. */
  creditMinor: bigint;
  /** Only an invoice has one. Drives the ageing. */
  dueDate?: string | null;
};

export type CustomerLedgerRow = CustomerLedgerEntry & {
  /** Cumulative debits − credits up to and including this row. */
  balanceMinor: bigint;
};

/**
 * The account, in date order, with the balance carried down.
 *
 * ⚠️ THE TIE-BREAK ON `id` IS NOT COSMETIC. Entries share a date
 * constantly — an invoice and the TDS withheld on it are both dated the
 * day the invoice is raised. Without a deterministic second key the order
 * is whatever the sort happened to produce, the balance column differs
 * between two renders of the same data, and a customer comparing our
 * statement with theirs sees two different documents from us.
 *
 * ⚠️ AND AN INVOICE SORTS BEFORE A RECEIPT ON THE SAME DAY. A payment
 * settling an invoice raised that morning must not appear above it, or
 * the statement shows the account in credit for one line and a customer
 * queries it.
 */
const TYPE_ORDER: Record<CustomerLedgerEntryType, number> = {
  opening_balance: 0,
  invoice: 1,
  debit_note: 2,
  credit_note: 3,
  tds_withheld: 4,
  receipt: 5,
  write_off: 6,
};

export function runningBalance(entries: readonly CustomerLedgerEntry[]): CustomerLedgerRow[] {
  const ordered = [...entries].sort((a, b) => {
    const dayA = toCivilDay(a.entryDate);
    const dayB = toCivilDay(b.entryDate);
    if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    const rankA = TYPE_ORDER[a.entryType];
    const rankB = TYPE_ORDER[b.entryType];
    if (rankA !== rankB) return rankA - rankB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let balance = 0n;
  return ordered.map((entry) => {
    balance += entry.debitMinor - entry.creditMinor;
    return { ...entry, balanceMinor: balance };
  });
}

/** Closing balance alone. Positive means the customer owes us. */
export function closingBalance(entries: readonly CustomerLedgerEntry[]): bigint {
  let balance = 0n;
  for (const e of entries) balance += e.debitMinor - e.creditMinor;
  return balance;
}

/* ------------------------------------------------------------------ */
/* AGEING                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE BUCKETS ARE MEASURED FROM THE DUE DATE, NOT THE INVOICE DATE.
 *
 * Ageing on the invoice date answers "how old is this bill", which nobody
 * needs. The question a collections call asks is "how late are they", and
 * an invoice on 60-day terms raised 45 days ago is not late at all.
 * Ageing it from the invoice date puts it in the 31–60 bucket, somebody
 * rings a customer who is not overdue, and the one relationship-damaging
 * call in the process is the one that should never have happened.
 *
 * Where no due date is recorded the invoice date is used — the
 * conservative reading: a bill with no agreed term is payable on
 * presentation.
 */
export const AGEING_BUCKET_DAYS: readonly number[] = Object.freeze([30, 60, 90, 180]);

export type AgeingBucket = {
  label: string;
  fromDays: number;
  toDays: number | null;
  amountMinor: bigint;
  documentCount: number;
};

export type CustomerAgeing = {
  asOf: string;
  /** Total outstanding, including anything not yet due. */
  outstandingMinor: bigint;
  /** Not yet due. Deliberately NOT bucket zero — see below. */
  notYetDueMinor: bigint;
  buckets: AgeingBucket[];
  oldestDocumentDays: number;
};

/** One open invoice, reduced to what ageing needs. */
export type OpenDocument = {
  id: string;
  reference: string;
  documentDate: string;
  dueDate?: string | null;
  outstandingMinor: bigint;
};

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${toCivilDay(from)}T00:00:00Z`);
  const b = Date.parse(`${toCivilDay(to)}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

/**
 * ⚠️ "NOT YET DUE" IS ITS OWN FIGURE AND IS NOT BUCKET ZERO.
 *
 * Folding it into a `0–30 days` bucket makes a healthy account look
 * indistinguishable from one that is a month late, and the two demand
 * opposite actions. Every ageing report a lender or a director reads
 * assumes the first bucket means OVERDUE.
 */
export function ageCustomerAccount(
  documents: readonly OpenDocument[],
  asOf: string,
): CustomerAgeing {
  const day = toCivilDay(asOf);

  const buckets: AgeingBucket[] = [];
  let previous = 0;
  for (const upper of AGEING_BUCKET_DAYS) {
    buckets.push({
      label: `${previous + 1}–${upper} days`,
      fromDays: previous + 1,
      toDays: upper,
      amountMinor: 0n,
      documentCount: 0,
    });
    previous = upper;
  }
  buckets.push({
    label: `${previous + 1}+ days`,
    fromDays: previous + 1,
    toDays: null,
    amountMinor: 0n,
    documentCount: 0,
  });

  let outstandingMinor = 0n;
  let notYetDueMinor = 0n;
  let oldestDocumentDays = 0;

  for (const doc of documents) {
    if (doc.outstandingMinor <= 0n) continue;
    outstandingMinor += doc.outstandingMinor;

    const due = toCivilDay(doc.dueDate ?? doc.documentDate);
    const overdue = daysBetween(due, day);

    if (overdue > oldestDocumentDays) oldestDocumentDays = overdue;

    if (overdue <= 0) {
      notYetDueMinor += doc.outstandingMinor;
      continue;
    }

    const bucket =
      buckets.find((b) => overdue >= b.fromDays && (b.toDays === null || overdue <= b.toDays)) ??
      buckets[buckets.length - 1];

    if (bucket) {
      bucket.amountMinor += doc.outstandingMinor;
      bucket.documentCount += 1;
    }
  }

  return { asOf: day, outstandingMinor, notYetDueMinor, buckets, oldestDocumentDays };
}

/* ------------------------------------------------------------------ */
/* THE NUMBER THAT MATTERS                                             */
/* ------------------------------------------------------------------ */

export type CustomerPosition = {
  /** debits − credits across the whole account. */
  balanceMinor: bigint;
  /** Money received with no document to answer. Always non-negative. */
  unappliedCreditMinor: bigint;
  ageing: CustomerAgeing;
};

/**
 * ⭐ WHAT A CUSTOMER ACTUALLY OWES — the figure a credit limit should
 *    eventually consult instead of the order book.
 *
 * ⚠️ UNAPPLIED CREDIT IS REPORTED SEPARATELY AND NEVER NETTED OFF
 *    SILENTLY. A customer sitting on ₹2,00,000 of unapplied money and
 *    ₹2,00,000 of overdue invoices has a filing problem, not a payment
 *    problem, and the two need different phone calls. Netting them to
 *    zero hides both.
 */
export function customerPosition(args: {
  entries: readonly CustomerLedgerEntry[];
  openDocuments: readonly OpenDocument[];
  unappliedCreditMinor: bigint;
  asOf: string;
}): CustomerPosition {
  return {
    balanceMinor: closingBalance(args.entries),
    unappliedCreditMinor:
      args.unappliedCreditMinor > 0n ? args.unappliedCreditMinor : 0n,
    ageing: ageCustomerAccount(args.openDocuments, args.asOf),
  };
}
