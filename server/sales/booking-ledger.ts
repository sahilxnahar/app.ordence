import "server-only";

/**
 * Ordence — What a booking actually carries in the ledger
 * Version: v1.25.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FACTS COME FROM THE LEDGER, NOT FROM THE BOOKING ROW
 * ══════════════════════════════════════════════════════════════════════
 * A cancellation has to clear this booking's advance, its receivable and
 * its output tax. Where those balances came from is a question with two
 * answers, and only one of them is safe.
 *
 * The easy answer is the booking's own columns and its milestone rows —
 * agreement value, amounts paid, a tax rate applied on the way past. It
 * is one query and it is wrong the moment anything has been posted by
 * hand, which for a developer is the moment an accountant corrects a
 * demand note.
 *
 * ⭐ THE RIGHT ANSWER IS WHAT THE JOURNAL SAYS. `journal_entries` carries
 * `counterparty_type = 'booking'` and `counterparty_id`, so every entry
 * this booking has ever produced can be summed by role. That figure IS
 * the balance the cancellation has to clear, by definition, because it
 * is the same number the trial balance is built from.
 *
 * ⚠️ AND THE TWO ANSWERS DISAGREEING IS ITSELF THE SIGNAL. That is why
 * `cancellationProblem()` checks the ledger identity against the cash
 * collected: when a demand was raised outside the module or a receipt
 * landed on the wrong booking, the difference shows up there rather than
 * being quietly absorbed by the posting.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { journalEntries, transactions, salesPostingAccounts } from "@/db/schema";

/**
 * ⚠️ DERIVED FROM `withTenant`, NOT IMPORTED. The transaction type is
 * whatever Drizzle hands the callback, and writing it out by hand is how
 * a schema change starts type-checking against a shape that no longer
 * exists.
 */
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export type BookingLedgerFacts = {
  /** Credit balance on Advance from Customers. */
  advanceMinor: bigint;
  /** Debit balance on Booking Receivable — demands raised, never paid. */
  receivableMinor: bigint;
  /** Output CGST + SGST + IGST credited against this booking. */
  outputTaxMinor: bigint;
  outputCgstMinor: bigint;
  outputSgstMinor: bigint;
  outputIgstMinor: bigint;
  /** Bank plus TDS the buyer withheld — what the buyer actually paid. */
  cashPaidMinor: bigint;
  /** Has anything at all been posted against this booking? */
  hasPostings: boolean;
  /** The earliest posted transaction date — the first supply, for s.34. */
  firstSupplyDate: string | null;
};

const ROLES = {
  advance: "customer_advance",
  receivable: "booking_receivable",
  cgst: "output_cgst",
  sgst: "output_sgst",
  igst: "output_igst",
  bank: "bank",
  tdsReceivable: "tds_receivable",
} as const;

export async function bookingLedgerFacts(
  tx: Tx,
  tenantId: string,
  bookingId: string,
): Promise<BookingLedgerFacts> {
  const rows = await tx
    .select({
      role: salesPostingAccounts.role,
      /**
       * ⭐ SUMMED IN MINOR UNITS. Batch 0108.
       *
       * ⚠️ THIS USED TO SUM `journal_entries.amount`, a numeric(18,2), and
       * hand the decimal string to `rupeeStringToMinor()`, whose last line
       * was `BigInt(whole) * 100n + ...`. Two hardcoded hundreds between
       * the ledger and this total, both wrong for a dinar and both wrong
       * by a different factor for a yen. The ledger now stores the integer
       * these totals were always trying to reach.
       */
      debitMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
      creditMinor: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amountMinor} ELSE 0 END), 0)::text`,
      /**
       * ⚠️ COUNTED, NOT IGNORED. `SUM()` SKIPS NULLS, so a leg 0108 could
       * not scale would quietly reduce this total instead of failing it.
       * The balance trigger refuses any transaction containing one, so
       * this can only be pre-0108 history — and a trial balance that is
       * short by a real amount and foots anyway is the worst possible
       * output. See the census in SQL-FILES/0108.
       */
      unscaledLegs: sql<number>`COUNT(*) FILTER (WHERE ${journalEntries.amountMinor} IS NULL)::int`,
      earliest: sql<string | null>`MIN(${transactions.transactionDate})`,
    })
    .from(journalEntries)
    .innerJoin(
      salesPostingAccounts,
      and(
        eq(salesPostingAccounts.ledgerId, journalEntries.ledgerId),
        eq(salesPostingAccounts.tenantId, journalEntries.tenantId),
      ),
    )
    .innerJoin(transactions, eq(transactions.id, journalEntries.transactionId))
    .where(
      and(
        eq(journalEntries.tenantId, tenantId),
        /**
         * ⚠️ BOTH HALVES OF THE COUNTERPARTY, NOT JUST THE ID. `counterparty_id`
         * is a bare uuid column with no foreign key — it has to be, because it
         * points at whichever table `counterparty_type` names. Matching on the
         * id alone would pick up a channel partner or a company that happens to
         * share the value, which is vanishingly unlikely and catastrophic.
         */
        eq(journalEntries.counterpartyType, "booking"),
        eq(journalEntries.counterpartyId, bookingId),
        eq(transactions.status, "posted"),
      ),
    )
    .groupBy(salesPostingAccounts.role);

  const debit = new Map<string, bigint>();
  const credit = new Map<string, bigint>();
  let firstSupplyDate: string | null = null;

  for (const r of rows) {
    if (r.unscaledLegs > 0) {
      throw new Error(
        `${r.unscaledLegs} journal line(s) have no amount in minor units, so this total ` +
          `cannot be trusted. Run the census in SQL-FILES/0108 to see which currency is ` +
          `unscaled. Nothing has been computed.`,
      );
    }
    debit.set(r.role, BigInt(r.debitMinor));
    credit.set(r.role, BigInt(r.creditMinor));
    if (r.earliest && (firstSupplyDate === null || r.earliest < firstSupplyDate)) {
      firstSupplyDate = r.earliest;
    }
  }

  const d = (role: string) => debit.get(role) ?? 0n;
  const c = (role: string) => credit.get(role) ?? 0n;

  /**
   * ⚠️ NET, NOT GROSS, AND IN THE ACCOUNT'S NATURAL DIRECTION.
   *
   * The advance is a liability, so its balance is credits less debits —
   * and it can already have debits against it if part of the booking
   * reached possession, or if an earlier partial cancellation was
   * posted. Reading the credit column alone would clear a balance that
   * is no longer there and post the difference into forfeiture income.
   */
  const advanceMinor = c(ROLES.advance) - d(ROLES.advance);
  const receivableMinor = d(ROLES.receivable) - c(ROLES.receivable);

  const outputCgstMinor = c(ROLES.cgst) - d(ROLES.cgst);
  const outputSgstMinor = c(ROLES.sgst) - d(ROLES.sgst);
  const outputIgstMinor = c(ROLES.igst) - d(ROLES.igst);

  /**
   * ⚠️ THE TDS THE BUYER WITHHELD COUNTS AS PAID. Section 194-IA has the
   * buyer deduct 1% on a property above ₹50 lakh and pay it to the
   * Government on the developer's behalf. It never touches the
   * developer's bank and it is unquestionably the buyer's money —
   * omitting it would make every such refund 1% short and hand the buyer
   * a real grievance.
   */
  const cashPaidMinor =
    d(ROLES.bank) - c(ROLES.bank) + (d(ROLES.tdsReceivable) - c(ROLES.tdsReceivable));

  return {
    advanceMinor,
    receivableMinor,
    outputTaxMinor: outputCgstMinor + outputSgstMinor + outputIgstMinor,
    outputCgstMinor,
    outputSgstMinor,
    outputIgstMinor,
    cashPaidMinor,
    hasPostings: rows.length > 0,
    firstSupplyDate,
  };
}
