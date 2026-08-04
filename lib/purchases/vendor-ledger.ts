/**
 * Ordence — Vendor Ledger, Ageing and the MSME Clock
 * Version: v0.33.0-alpha
 *
 * Pure. `bigint` paise, `YYYY-MM-DD` civil days, no clock and no
 * database. `toCivilDay` comes from `lib/gst/constants.ts` and is NOT
 * restated — a second date normaliser that disagrees by a timezone is how
 * an invoice lands in the wrong ageing bucket on the last day of a month.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SIGN CONVENTION, STATED ONCE SO IT IS NEVER GUESSED
 * ══════════════════════════════════════════════════════════════════════
 * A vendor account is a PAYABLE.
 *
 *     credit  → we owe MORE  (a bill, a debit note, retention released)
 *     debit   → we owe LESS  (a payment, an advance, TDS withheld)
 *     balance  = credits − debits
 *
 * A POSITIVE balance means money is owed TO the vendor. This is the
 * mirror image of the customer-side convention, and taking the
 * customer-side one by analogy produces an ageing report on which every
 * vendor is in credit — which looks like a data problem rather than a
 * sign problem, and gets debugged in the wrong place.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE BALANCE IS COMPUTED AND NEVER STORED
 * ══════════════════════════════════════════════════════════════════════
 * A stored running balance is correct until the first BACKDATED entry —
 * and on a construction site the contractor's March bill arrives in May,
 * every month. The moment one lands, every stored balance after that date
 * is wrong, and there is no error, no log line and no screen that looks
 * different. The report simply stops agreeing with the sum of its own
 * rows, which is the hardest kind of wrong to notice.
 */

import { toCivilDay } from "@/lib/gst/constants";
import type { MsmeCategory, VendorLedgerEntryType } from "@/db/schema/purchases";

/* ------------------------------------------------------------------ */
/* RUNNING BALANCE                                                     */
/* ------------------------------------------------------------------ */

export type LedgerEntry = {
  id: string;
  entryDate: string;
  entryType: VendorLedgerEntryType;
  description?: string | null;
  referenceNumber?: string | null;
  purchaseInvoiceId?: string | null;
  debitMinor: bigint;
  creditMinor: bigint;
  dueDate?: string | null;
  excludeFromAgeing?: boolean;
};

export type LedgerRow = LedgerEntry & {
  /** Cumulative credits − debits up to and including this row. */
  balanceMinor: bigint;
};

/**
 * The account, in date order, with the balance carried down.
 *
 * ⚠️ THE TIE-BREAK ON `id` IS NOT COSMETIC. Several entries share a date
 * constantly — a bill and the TDS withheld on it are both dated the day
 * the bill is passed. Without a deterministic second key the order is
 * whatever the sort happened to produce, the balance column differs
 * between two renders of the same data, and a vendor comparing our
 * statement with theirs sees two different documents from us.
 */
export function runningBalance(entries: readonly LedgerEntry[]): LedgerRow[] {
  const ordered = [...entries].sort((a, b) => {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let balance = 0n;
  return ordered.map((entry) => {
    balance += entry.creditMinor - entry.debitMinor;
    return { ...entry, balanceMinor: balance };
  });
}

/** Closing balance alone. Positive means we owe the vendor. */
export function closingBalance(entries: readonly LedgerEntry[]): bigint {
  let balance = 0n;
  for (const entry of entries) balance += entry.creditMinor - entry.debitMinor;
  return balance;
}

/* ------------------------------------------------------------------ */
/* AGEING                                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE BUCKETS ARE MEASURED FROM THE DUE DATE, NOT THE INVOICE DATE.
 *
 * "Ageing" on the invoice date answers "how old is this bill", which
 * nobody needs. The question a payables run asks is "how late are we",
 * and a bill on 90-day terms raised 60 days ago is not late at all. An
 * ageing report keyed on the invoice date puts it in the 31–60 bucket and
 * somebody pays it early, which for a business funding a construction
 * programme out of collections is a real cost.
 *
 * Where no due date is recorded the entry date is used, which is the
 * conservative reading: a bill with no agreed term is payable on
 * presentation.
 */
export const AGEING_BUCKET_DAYS: readonly number[] = Object.freeze([30, 60, 90, 180]);

export type AgeingBucket = {
  label: string;
  /** Inclusive lower bound in days overdue. */
  fromDays: number;
  /** Exclusive upper bound, or null for the open-ended last bucket. */
  toDays: number | null;
  amountMinor: bigint;
  entryCount: number;
};

export type VendorAgeing = {
  asOf: string;
  /** Total outstanding, including anything not yet due. */
  outstandingMinor: bigint;
  /** Not yet due. Deliberately NOT bucket zero — see the note below. */
  notYetDueMinor: bigint;
  buckets: AgeingBucket[];
  /** Excluded by `excludeFromAgeing` — retention, mostly. */
  excludedMinor: bigint;
};

/**
 * Age a vendor's open items as at a day.
 *
 * ⚠️ "NOT YET DUE" IS ITS OWN FIGURE AND NOT THE FIRST BUCKET. Folding it
 * into "0–30 days" makes the first column of a payables report a mixture
 * of "we are a fortnight late" and "this is not due for another
 * fortnight", and the column is then useless for the only decision it
 * exists to support.
 *
 * ⚠️ AND IT IS AN OPEN-ITEM AGEING, NOT A BALANCE AGEING. Only entries
 * that INCREASE the payable are aged; payments reduce the total but
 * cannot be aged, because a payment has no age. The consequence is that
 * the buckets sum to the outstanding only when every payment has been
 * matched to a bill, and this function makes that visible rather than
 * hiding it by netting payments into the oldest bucket — which is the
 * usual shortcut and silently ages a paid bill.
 */
export function ageVendorLedger(args: {
  entries: readonly LedgerEntry[];
  asOf: Date | string;
  bucketDays?: readonly number[];
}): VendorAgeing {
  const asOf = toCivilDay(args.asOf);
  const bounds = args.bucketDays ?? AGEING_BUCKET_DAYS;

  const buckets: AgeingBucket[] = [];
  let previous = 0;
  for (const bound of bounds) {
    buckets.push({
      label: `${previous + 1}–${bound} days`,
      fromDays: previous + 1,
      toDays: bound,
      amountMinor: 0n,
      entryCount: 0,
    });
    previous = bound;
  }
  buckets.push({
    label: `${previous + 1}+ days`,
    fromDays: previous + 1,
    toDays: null,
    amountMinor: 0n,
    entryCount: 0,
  });

  let outstanding = 0n;
  let notYetDue = 0n;
  let excluded = 0n;

  for (const entry of args.entries) {
    outstanding += entry.creditMinor - entry.debitMinor;

    // Only payable-increasing entries have an age.
    if (entry.creditMinor <= 0n) continue;

    if (entry.excludeFromAgeing === true) {
      excluded += entry.creditMinor;
      continue;
    }

    const due = entry.dueDate ?? entry.entryDate;
    const overdue = daysBetween(due, asOf);

    if (overdue <= 0) {
      notYetDue += entry.creditMinor;
      continue;
    }

    const bucket =
      buckets.find((b) => overdue >= b.fromDays && (b.toDays === null || overdue <= b.toDays)) ??
      buckets[buckets.length - 1];

    if (bucket) {
      bucket.amountMinor += entry.creditMinor;
      bucket.entryCount += 1;
    }
  }

  return { asOf, outstandingMinor: outstanding, notYetDueMinor: notYetDue, buckets, excludedMinor: excluded };
}

/**
 * Whole days from `from` to `to`, both civil days.
 *
 * ⚠️ `Date.UTC` ON THE PARSED PARTS, NEVER `new Date(string)`. Parsing
 * `"2024-03-31"` with the local constructor makes it midnight LOCAL, and
 * a difference taken across a month boundary on a machine east of UTC
 * comes out one day short. Ageing is nothing but that difference.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/** Add whole days to a civil day, staying in civil-day space. */
export function addCivilDays(day: string, days: number): string {
  const base = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* ⭐ THE MSME CLOCK — Section 15 MSMED Act / Section 43B(h)           */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY A LATE PAYMENT TO A SMALL VENDOR IS AN INCOME-TAX PROBLEM
 * ══════════════════════════════════════════════════════════════════════
 * Section 15 of the MSMED Act, 2006 requires payment to a registered
 * MICRO or SMALL enterprise within the agreed period, and in no case more
 * than 45 days from acceptance. Section 32 voids any agreement to the
 * contrary, so a 90-day purchase order does not extend it.
 *
 * Section 43B(h) of the Income-tax Act, from AY 2024-25, then DISALLOWS
 * the expenditure entirely in the year it was incurred if payment is
 * late. The deduction moves to the year of actual payment, and tax at
 * roughly 25–30% on the whole invoice value — not on the delay, on the
 * VALUE — is payable now. On a construction company that runs hundreds of
 * small subcontractors on 60- or 90-day terms, that is a material
 * assessment finding, and it lands nine months after the year end when
 * nothing can be done about it.
 *
 * ⚠️ MEDIUM ENTERPRISES ARE NOT COVERED BY 43B(h). Only micro and small.
 * Treating all three the same is the obvious simplification and it raises
 * a false alarm on every medium vendor — which is how a real alarm gets
 * ignored.
 */
export const MSME_STATUTORY_MAX_DAYS = 45;

export type MsmeExposure = {
  applies: boolean;
  /** The earlier of the agreed term and the statutory 45 days. */
  effectiveTermDays: number;
  dueDate: string;
  daysOverdue: number;
  /** ⭐ True once 43B(h) would disallow the expenditure. */
  disallowanceRisk: boolean;
  message: string;
};

export function assessMsmeExposure(args: {
  msmeRegistered: boolean;
  msmeCategory: MsmeCategory | null | undefined;
  /** The agreed term. Capped at 45 for a micro/small vendor. */
  paymentTermsDays: number;
  /** Acceptance of the goods or services — the statutory trigger. */
  acceptedOn: string;
  asOf: Date | string;
  /** Whether the bill has since been paid, and when. */
  paidOn?: string | null;
}): MsmeExposure {
  const asOf = toCivilDay(args.asOf);

  const covered =
    args.msmeRegistered === true &&
    (args.msmeCategory === "micro" || args.msmeCategory === "small");

  // ⚠️ THE CAP APPLIES ONLY TO A COVERED VENDOR. Capping everybody at 45
  // days would misreport the due date of an ordinary 60-day supplier and
  // make the payables run chase money that is not owed yet.
  const effectiveTermDays = covered
    ? Math.min(args.paymentTermsDays, MSME_STATUTORY_MAX_DAYS)
    : args.paymentTermsDays;

  const dueDate = addCivilDays(toCivilDay(args.acceptedOn), effectiveTermDays);

  // ⚠️ MEASURED TO THE PAYMENT DATE WHERE THERE IS ONE. A bill paid late
  // and long ago is still disallowed — 43B(h) asks whether payment was
  // within the time, not whether it has happened by now. Measuring a paid
  // bill against today would grow its "overdue" figure forever and would
  // also, more dangerously, report a bill paid ON TIME as overdue once
  // enough time had passed.
  const measuredOn = args.paidOn ? toCivilDay(args.paidOn) : asOf;
  const daysOverdue = Math.max(0, daysBetween(dueDate, measuredOn));

  const disallowanceRisk = covered && daysOverdue > 0;

  return {
    applies: covered,
    effectiveTermDays,
    dueDate,
    daysOverdue,
    disallowanceRisk,
    message: !covered
      ? args.msmeRegistered
        ? "This vendor is a registered MEDIUM enterprise. Section 15 of the MSMED " +
          "Act still sets a 45-day limit for interest purposes, but Section 43B(h) " +
          "of the Income-tax Act does not disallow the expenditure — that applies " +
          "to micro and small enterprises only."
        : "This vendor is not registered under the MSMED Act, so the 45-day rule " +
          "and Section 43B(h) do not apply. Ordinary commercial terms govern."
      : disallowanceRisk
        ? `⚠️ ${daysOverdue} day(s) past the statutory limit. Section 43B(h) ` +
          `disallows this expenditure in the year it was incurred; the deduction ` +
          `moves to the year of payment and tax on the FULL invoice value falls ` +
          `due now. The limit is the earlier of the agreed ${args.paymentTermsDays} ` +
          `days and the statutory 45, and Section 32 of the MSMED Act makes any ` +
          `longer agreement void.`
        : `Within the statutory limit. Payable by ${dueDate} — the earlier of the ` +
          `agreed term and 45 days from acceptance.`,
  };
}

/* ------------------------------------------------------------------ */
/* UDYAM REGISTRATION NUMBERS                                          */
/* ------------------------------------------------------------------ */

/**
 * `UDYAM-XX-00-0000000` — nineteen characters, three groups.
 *
 * ⚠️ VENDORS STILL SEND THE OLD NUMBER. Udyog Aadhaar (a twelve-digit
 * number) was replaced by Udyam in July 2020 and the old memoranda ceased
 * to be valid. A twelve-digit number typed into this field is not
 * verifiable on the Udyam portal, so the MSME claim it supports cannot be
 * substantiated — and an unsubstantiated claim is worse than no claim,
 * because it puts the vendor on the 43B(h) list without the evidence to
 * defend the disallowance if it is challenged.
 */
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

export function isValidUdyamNumber(value: string | null | undefined): boolean {
  return typeof value === "string" && UDYAM_PATTERN.test(value.trim().toUpperCase());
}

export function describeUdyamProblem(value: string): string | null {
  const candidate = value.trim().toUpperCase();
  if (UDYAM_PATTERN.test(candidate)) return null;
  if (/^\d{12}$/.test(candidate)) {
    return (
      "That is a twelve-digit Udyog Aadhaar number. Udyog Aadhaar was replaced by " +
      "Udyam registration in July 2020 and the old memoranda are no longer valid. " +
      "Ask the vendor for their Udyam Registration Number — it looks like " +
      "UDYAM-MH-01-0001234."
    );
  }
  return (
    "A Udyam Registration Number is UDYAM, a two-letter state code, two digits and " +
    "seven digits: UDYAM-MH-01-0001234."
  );
}
