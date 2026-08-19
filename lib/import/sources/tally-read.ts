/**
 * Ordence — ⭐⭐ A TALLY XML EXPORT INTO THE SAME ROW STREAM
 * Version: v1.74.0-alpha · Wave 6
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS A MIGRATION FRONT-END AND NOT PART OF THE INTEGRATION
 * ══════════════════════════════════════════════════════════════════════
 * `lib/tally/parse.ts` and `server/tally/*` are the LIVE INTEGRATION:
 * two systems both holding the books, reconciled against each other,
 * matched by remote id. That is an ongoing relationship.
 *
 * This is a MIGRATION: a workspace leaving Tally, once, whose accountant
 * has a `Daybook.xml` on their desktop. They do not want a reconciliation,
 * they want their masters and their opening figures in Ordence, and then
 * they want to never open Tally again.
 *
 * ⚠️ So this file reuses `parseTallyExport` — one XML reader, not two —
 * and turns the result into rows the ordinary import framework maps,
 * previews and commits, with the same natural keys, the same dry run and
 * the same partial-success report as a CSV.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT IT DOES NOT DO, AND THIS IS THE IMPORTANT PART
 * ══════════════════════════════════════════════════════════════════════
 * It does NOT post the vouchers into the ledger. It flattens them to rows.
 *
 * A Tally day-book export is thousands of vouchers across years, and
 * replaying them as journal entries would mean reproducing another
 * system's posting decisions — its rounding, its tax heads, its
 * cancellations, its period locks — inside ours, and any disagreement
 * shows up as a trial balance that does not tie and no way to tell which
 * system is right.
 *
 * ⭐ THE CORRECT MIGRATION IS THE ONE `lib/import/opening.ts` ALREADY
 * IMPLEMENTS: bring the MASTERS across, then ONE opening trial balance
 * as at a stated date, which has to balance before it is allowed to
 * commit. History stays in Tally, where it is already audited.
 *
 * ⚠️ AND THE FILE SAYS SO. `readTally` returns that sentence as a note on
 * every voucher extraction, because a customer who believes their four
 * years of history came across and finds later that it did not is a
 * customer who cannot trust any figure in the product.
 */

import { parseTallyExport } from "@/lib/tally/parse";
import { formatMinorPlain } from "@/lib/fx/currency";
import type { CsvRecord } from "../csv";

export class TallyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TallyReadError";
  }
}

export type TallyView = "ledger-masters" | "voucher-summary";

export type TallyDocument = {
  readonly view: TallyView;
  readonly headers: string[];
  readonly records: CsvRecord[];
  readonly notes: readonly string[];
  readonly companyName: string | null;
};

const MASTER_HEADERS = [
  "Ledger name",
  "Appears as",
  "Vouchers",
  "Total debit",
  "Total credit",
  "Net",
  "Currency",
] as const;

const VOUCHER_HEADERS = [
  "Voucher date",
  "Voucher type",
  "Voucher number",
  "Party",
  "Narration",
  "Total debit",
  "Total credit",
  "Currency",
  "Cancelled",
] as const;

/**
 * ⭐⭐ THE LEDGER MASTERS, DERIVED FROM THE VOUCHERS THEMSELVES.
 *
 * ⚠️ NOT FROM A `<LEDGER>` MASTER LIST, WHICH A DAY-BOOK EXPORT DOES NOT
 * CONTAIN. Every ledger a voucher touches is a ledger the workspace uses,
 * and deriving them this way has a property a master list does not: it
 * cannot include four hundred ledgers created once in 2019 and never used
 * again, which is what makes a Tally chart of accounts unusable after a
 * decade.
 *
 * 🔴 AND `Appears as` IS NOT DECORATION. Tally matches ledger names
 * case-insensitively and does not merge, so "Acme Ltd" and "ACME LTD" are
 * one ledger there and would be two here. This column shows every
 * spelling seen so the person can see the collision before it becomes two
 * customers in Ordence.
 */
function ledgerMasters(
  vouchers: ReturnType<typeof parseTallyExport>["vouchers"],
): { records: CsvRecord[]; collisions: number } {
  type Accumulated = {
    display: string;
    spellings: Set<string>;
    vouchers: number;
    debit: bigint;
    credit: bigint;
  };
  const byFold = new Map<string, Accumulated>();

  for (const voucher of vouchers) {
    for (const leg of voucher.legs) {
      const name = leg.ledgerName.trim();
      if (name === "") continue;
      const fold = name.toLowerCase();
      const found = byFold.get(fold) ?? {
        display: name,
        spellings: new Set<string>(),
        vouchers: 0,
        debit: 0n,
        credit: 0n,
      };
      found.spellings.add(name);
      found.vouchers += 1;
      if (leg.isDebit) found.debit += leg.amountMinor;
      else found.credit += leg.amountMinor;
      byFold.set(fold, found);
    }
  }

  const rows = [...byFold.values()].sort((a, b) => a.display.localeCompare(b.display));
  const collisions = rows.filter((r) => r.spellings.size > 1).length;

  const records: CsvRecord[] = [{ recordNumber: 1, cells: [...MASTER_HEADERS] }];
  rows.forEach((row, index) => {
    const net = row.debit - row.credit;
    records.push({
      recordNumber: index + 2,
      cells: [
        row.display,
        row.spellings.size > 1 ? [...row.spellings].join(" | ") : "",
        String(row.vouchers),
        formatMinorPlain(row.debit, "INR"),
        formatMinorPlain(row.credit, "INR"),
        formatMinorPlain(net, "INR"),
        "INR",
      ],
    });
  });

  return { records, collisions };
}

export function readTally(source: string, view: TallyView = "ledger-masters"): TallyDocument {
  const parsed = parseTallyExport(source);

  if (parsed.vouchers.length === 0) {
    throw new TallyReadError(
      "That file is XML and Ordence found no vouchers in it. A Tally export for migration is " +
        "taken from Gateway of Tally → Display → Day Book, with the period set, then Alt+E to " +
        "export as XML. An export of a report other than the day book has a different shape and " +
        "cannot be read.",
    );
  }

  const notes: string[] = [
    /**
     * 🔴 THE SENTENCE THAT MUST APPEAR EVERY TIME. See the header.
     */
    "Ordence reads this file to bring your ledgers and your opening position across. It does not " +
      "replay four years of vouchers into the ledger — reproducing another system's posting " +
      "decisions produces a trial balance that does not tie, with no way to tell which system is " +
      "right. Import the masters here, then enter one opening trial balance as at your cut-over " +
      "date. Your history stays in Tally, where it is already audited.",
  ];

  if (parsed.companyName) {
    notes.push(`This export is from the Tally company "${parsed.companyName}".`);
  }
  if (parsed.warnings.length > 0) {
    /**
     * ⚠️ THE WARNINGS ARE CARRIED THROUGH, NOT SWALLOWED.
     * `parseTallyExport` deliberately turns an unreadable voucher into a
     * warning rather than an exception so that 1,999 of 2,000 still read.
     * A front-end that then drops the warnings converts that careful
     * behaviour into silent data loss.
     */
    notes.push(
      `${parsed.warnings.length} entr${parsed.warnings.length === 1 ? "y" : "ies"} in that file ` +
        `could not be read and ${parsed.warnings.length === 1 ? "was" : "were"} left out: ` +
        `${parsed.warnings.slice(0, 3).map((w) => w.message).join(" · ")}` +
        `${parsed.warnings.length > 3 ? " …" : ""}`,
    );
  }

  if (view === "ledger-masters") {
    const { records, collisions } = ledgerMasters(parsed.vouchers);
    if (collisions > 0) {
      notes.push(
        `${collisions} ledger${collisions === 1 ? "" : "s"} appear${collisions === 1 ? "s" : ""} ` +
          `under more than one spelling in that file — Tally treats them as one ledger and ` +
          `Ordence would create two. The "Appears as" column shows every spelling. Decide on one ` +
          `before you commit.`,
      );
    }
    return {
      view,
      headers: [...MASTER_HEADERS],
      records,
      notes,
      companyName: parsed.companyName,
    };
  }

  const records: CsvRecord[] = [{ recordNumber: 1, cells: [...VOUCHER_HEADERS] }];
  parsed.vouchers.forEach((voucher, index) => {
    records.push({
      recordNumber: index + 2,
      cells: [
        voucher.voucherDate ?? "",
        voucher.voucherType,
        voucher.voucherNumber ?? "",
        voucher.partyLedgerName ?? "",
        voucher.narration ?? "",
        formatMinorPlain(voucher.totalDebitMinor, "INR"),
        formatMinorPlain(voucher.totalCreditMinor, "INR"),
        "INR",
        voucher.isCancelled ? "true" : "false",
      ],
    });
  });

  notes.push(
    "This is a summary, one row per voucher, for checking that the period and the totals are the " +
      "ones you expect. The individual ledger legs are not in it.",
  );

  return { view, headers: [...VOUCHER_HEADERS], records, notes, companyName: parsed.companyName };
}
