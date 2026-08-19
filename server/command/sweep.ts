import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE MORNING SWEEP
 * Version: v1.26.0-alpha · Batch 18
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE COMPUTES NOTHING. THAT IS THE WHOLE DESIGN.
 * ══════════════════════════════════════════════════════════════════════
 * Every figure below already exists somewhere in Ordence and is already
 * correct. The statutory due dates come from `lib/compliance/
 * statutory-due.ts`, the unposted backlogs from the same status columns
 * the module screens read, the ledger balances from the same roles the
 * GSTR-3B is assembled from.
 *
 * ⚠️ THE MOMENT A SUMMARY PAGE STARTS DOING ITS OWN ARITHMETIC IT
 * BECOMES A SECOND SOURCE OF TRUTH, and the two disagree within a
 * month. Not because either is wrong — because one gets a fix the other
 * does not, and the one people quote is whichever they opened last.
 *
 * ⭐ SO THIS IS A READER AND A RANKER. If a number here is wrong, the
 * bug is in the module that owns it, and fixing it there fixes it in
 * both places.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND EVERY SIGNAL CARRIES A CONSEQUENCE AND A DESTINATION
 * ══════════════════════════════════════════════════════════════════════
 * `lib/command/exceptions.ts` requires both. A line that says what is
 * wrong without saying what it costs is a line people learn to scroll
 * past, and a line with nowhere to go is a report rather than a
 * worklist.
 */

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  bookings,
  channelPartnerCommissions,
  payrollRuns,
  gstReturns,
  journalEntries,
  transactions,
  salesPostingAccounts,
} from "@/db/schema";
import { buildDueList } from "@/lib/compliance/statutory-due";
import { stateFor, type ExceptionSignal } from "@/lib/command/exceptions";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⚠️ THE PERIOD END IS THE MONTH THAT HAS FINISHED, NOT THIS ONE.
 *
 * Every statutory obligation in India is "the month just gone, by the
 * Nth of this one". Computing due dates against the CURRENT month would
 * report July's PF as due on 15 August while it is still July — a
 * warning about a liability that has not finished accruing.
 */
export function lastCompletedMonthEnd(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const endOfPrev = new Date(Date.UTC(year, month - 1, 0));
  return endOfPrev.toISOString().slice(0, 10);
}

export function taxPeriodOf(monthEnd: string): string {
  return monthEnd.slice(0, 7);
}

/* ------------------------------------------------------------------ */

export async function sweepExceptions(
  tenantId: string,
  today: string,
): Promise<ExceptionSignal[]> {
  const periodEnd = lastCompletedMonthEnd(today);
  const taxPeriod = taxPeriodOf(periodEnd);

  return withTenant(tenantId, async (tx) => {
    const signals: ExceptionSignal[] = [];

    for (const gather of [
      () => statutorySignals(tx, tenantId, periodEnd, taxPeriod, today),
      () => cancellationSignals(tx, tenantId, today),
      () => brokerageSignals(tx, tenantId, today),
      () => payrollSignals(tx, tenantId, today),
      () => returnSignals(tx, tenantId, today),
    ]) {
      /**
       * 🔴 ONE FAILING SOURCE MUST NOT EMPTY THE PAGE.
       *
       * ⚠️ A morning summary that renders nothing because one query
       * failed is worse than one that renders eleven of twelve sections,
       * because the failure looks identical to "nothing needs
       * attention" — which is the single most dangerous thing this page
       * can say untruthfully.
       *
       * So a broken source becomes a VISIBLE signal saying it is broken,
       * rather than a silent absence.
       */
      try {
        signals.push(...(await gather()));
      } catch (error) {
        signals.push({
          key: `sweep-failed:${signals.length}`,
          kind: "sweep_error",
          headline: "Part of this page could not be built",
          amountMinor: null,
          deadline: null,
          state: "overdue",
          compounds: false,
          consequence:
            "One of the checks behind this summary failed, so something that needs " +
            "attention may be missing from it. Treat this page as incomplete until it clears.",
          where: "/command",
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return signals;
  });
}

/* ------------------------------------------------------------------ */
/* ① WHAT IS OWED TO A GOVERNMENT                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE HIGHEST-CONSEQUENCE SECTION, AND THE ONE WITH THE SMALLEST
 *   NUMBERS ON IT.
 *
 * ⚠️ PROVIDENT FUND IS THE ONE TO UNDERSTAND. Late payment attracts
 * interest under section 7Q AND damages under 14B, and the damages can
 * reach the contribution itself. A ₹4,000 PF payment one day late is a
 * worse morning than a ₹40 lakh invoice nine days late, which is
 * precisely the ordering a dashboard sorted by amount gets wrong.
 */
async function statutorySignals(
  tx: Tx,
  tenantId: string,
  periodEnd: string,
  taxPeriod: string,
  today: string,
): Promise<ExceptionSignal[]> {
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
        sql`${transactions.transactionDate} <= ${periodEnd}::date`,
        eq(transactions.status, "posted"),
      ),
    )
    .groupBy(salesPostingAccounts.role);

  const balances: Record<string, bigint> = {};
  for (const r of rows) {
    // ⚠️ Liabilities: credits less debits, clamped at zero rather than
    // shown as a government owing money back.
    if (r.unscaledLegs > 0) {
      throw new Error(
        `${r.unscaledLegs} journal line(s) have no amount in minor units, so this total ` +
          `cannot be trusted. Run the census in SQL-FILES/0108 to see which currency is ` +
          `unscaled. Nothing has been computed.`,
      );
    }
    const net = BigInt(r.creditMinor) - BigInt(r.debitMinor);
    balances[r.role] = net > 0n ? net : 0n;
  }

  const [prepared] = await tx
    .select({ totalCashMinor: gstReturns.totalCashMinor })
    .from(gstReturns)
    .where(
      and(
        eq(gstReturns.tenantId, tenantId),
        eq(gstReturns.taxPeriod, taxPeriod),
        sql`${gstReturns.status} <> 'superseded'`,
      ),
    )
    .limit(1);

  const items = buildDueList({
    periodEnd,
    balances,
    gstCashPayableMinor: prepared ? BigInt(prepared.totalCashMinor) : null,
    today,
  });

  return items
    /**
     * ⚠️ NOTHING OWED IS NOT AN EXCEPTION. An obligation with a nil
     * balance is a line on the compliance page, not something anybody
     * has to do this morning.
     *
     * ══════════════════════════════════════════════════════════════
     * 🔴 AND THE `amountMinor > 0n` CLAUSE THAT USED TO BE HERE HID
     *    GSTR-1 COMPLETELY — v1.30.0-alpha
     * ══════════════════════════════════════════════════════════════
     * `buildDueList` goes out of its way to keep `gst_1` OUT of the
     * "nothing owed" shortcut, with a comment saying why: it is a
     * STATEMENT, not a payment, so its amount is always zero and zero is
     * correct. It still has the earliest statutory date in the month —
     * the 11th — a late fee for every day, and the expensive
     * consequence that customers cannot see the invoice in their 2B and
     * chase for credit they cannot take.
     *
     * ⚠️ THIS FILTER THREW IT AWAY ON THE AMOUNT. The library made the
     * distinction carefully and the consumer undid it, so the one page
     * whose entire job is "what stops being fixable soonest" never once
     * mentioned the deadline that comes first.
     *
     * 🔴 IT WAS FOUND BY RUNNING THE SWEEP AGAINST A DATABASE, not by
     * reading it. Every test of this file read the source as text.
     *
     * ⭐ `state !== "nothing_owed"` IS ALREADY THE EXACT TEST. The
     *   library guarantees that state means "a money obligation with a
     *   nil balance", so the amount clause was never adding anything
     *   except this defect.
     */
    .filter((i) => i.state !== "nothing_owed")
    .map((i) => ({
      key: `statutory:${i.kind}:${taxPeriod}`,
      kind: "statutory",
      headline: `${i.label} for ${taxPeriod} is ${describeDue(i.state, i.daysUntil)}`,
      amountMinor: i.amountMinor,
      deadline: i.dueOn,
      state: stateFor({ deadline: i.dueOn, today }),
      /**
       * 🔴 EVERY STATUTORY LIABILITY COMPOUNDS. Interest at 1 to 1.5% a
       * month counted in WHOLE months — so a payment one day late costs
       * a full month of interest — plus per-day late fees on GST and
       * damages on provident fund.
       */
      compounds: true,
      consequence: i.ifLate,
      where: "/compliance/due",
      detail: `${i.authority} · due ${i.dueOn}`,
    }));
}

function describeDue(state: string, daysUntil: number): string {
  if (state === "overdue") {
    const d = Math.abs(daysUntil);
    return `${d} day${d === 1 ? "" : "s"} late`;
  }
  if (state === "due_today") return "due today";
  return `due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* ② CANCELLED BOOKINGS AND THE MONEY OWED BACK                        */
/* ------------------------------------------------------------------ */

async function cancellationSignals(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<ExceptionSignal[]> {
  const [unposted] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`MIN(${bookings.cancelledAt})::date::text`,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.status, "cancelled"),
        isNull(bookings.cancellationPostedAt),
      ),
    );

  const [owing] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(SUM(${bookings.refundAmountMinor}), 0)::text`,
      oldest: sql<string | null>`MIN(${bookings.cancellationPostedAt})::date::text`,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.status, "cancelled"),
        isNotNull(bookings.cancellationPostedAt),
        isNull(bookings.refundPaidAt),
        sql`COALESCE(${bookings.refundAmountMinor}, 0) > 0`,
      ),
    );

  const out: ExceptionSignal[] = [];

  if ((unposted?.count ?? 0) > 0) {
    out.push({
      key: "cancellations:unposted",
      kind: "unposted",
      headline: `${unposted!.count} cancelled booking${unposted!.count === 1 ? " has" : "s have"} never reached the ledger`,
      amountMinor: null,
      deadline: null,
      /**
       * ⚠️ `watch`, NOT `overdue`, AND THAT IS A JUDGEMENT. There is no
       * date on it — nobody fines you for an unposted cancellation. What
       * it does is leave the advance, the unpaid demands and the output
       * tax standing against a buyer who has gone, so every statement
       * printed until it is posted is wrong by that amount.
       */
      state: "watch",
      compounds: false,
      consequence:
        "Until these are posted, the buyer's advance, their unpaid demands and the " +
        "output tax on a sale that did not happen are all still in the ledger — so " +
        "the trial balance, the GSTR-3B and any statement you send are wrong by that much.",
      where: "/sales/cancellations",
      detail: unposted!.oldest ? `oldest cancelled ${unposted!.oldest}` : null,
    });
  }

  if ((owing?.count ?? 0) > 0) {
    /**
     * 🔴 THE ONE THAT ENDS UP IN FRONT OF A CONSUMER FORUM.
     *
     * ⚠️ THE DEADLINE IS NOT A STATUTORY DATE, so this uses ageing
     * rather than a due date. What a forum asks is how long the buyer
     * waited, and the answer stops being defensible somewhere around a
     * month.
     */
    const days = owing!.oldest ? daysSince(owing!.oldest, today) : 0;
    out.push({
      key: "cancellations:refunds_owed",
      kind: "refund",
      headline: `${owing!.count} cancelled buyer${owing!.count === 1 ? " is" : "s are"} still waiting for a refund`,
      amountMinor: BigInt(owing!.total || "0"),
      deadline: null,
      state: days > 30 ? "overdue" : "due_soon",
      compounds: false,
      consequence:
        "A buyer who cancelled and has not been paid back is the commonest consumer " +
        "complaint a developer faces, and the usual order is the refund plus interest " +
        "and costs. How long they waited is the question the forum asks in those words.",
      where: "/sales/cancellations",
      detail: owing!.oldest ? `oldest posted ${owing!.oldest}, ${days} days ago` : null,
    });
  }

  return out;
}

function daysSince(day: string, today: string): number {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/* ------------------------------------------------------------------ */
/* ③ BROKERAGE                                                         */
/* ------------------------------------------------------------------ */

async function brokerageSignals(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<ExceptionSignal[]> {
  const rows = await tx
    .select({
      status: channelPartnerCommissions.status,
      count: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(SUM(${channelPartnerCommissions.netPayableMinor}), 0)::text`,
      tds: sql<string>`COALESCE(SUM(${channelPartnerCommissions.tdsMinor}), 0)::text`,
      oldest: sql<string | null>`MIN(${channelPartnerCommissions.creditedOn})::text`,
    })
    .from(channelPartnerCommissions)
    .where(
      and(
        eq(channelPartnerCommissions.tenantId, tenantId),
        sql`${channelPartnerCommissions.status} IN ('approved', 'posted')`,
      ),
    )
    .groupBy(channelPartnerCommissions.status);

  const out: ExceptionSignal[] = [];

  for (const r of rows) {
    if (r.status === "approved" && r.count > 0) {
      out.push({
        key: "brokerage:approved_unposted",
        kind: "unposted",
        headline: `${r.count} approved brokerage bill${r.count === 1 ? "" : "s"} not in the ledger`,
        amountMinor: BigInt(r.total || "0"),
        deadline: null,
        state: "watch",
        compounds: false,
        consequence:
          "The expense is missing from the profit and loss account and the TDS on it has " +
          "not been recognised, so the 194H liability the quarterly return is built from " +
          "is understated by that much.",
        where: "/sales/brokerage",
        detail: r.oldest ? `oldest credited ${r.oldest}` : null,
      });
    }

    if (r.status === "posted" && r.count > 0) {
      out.push({
        key: "brokerage:posted_unpaid",
        kind: "payable",
        headline: `${formatMinor(BigInt(r.total || "0"))} owed to channel partners`,
        amountMinor: BigInt(r.total || "0"),
        deadline: null,
        state: "watch",
        compounds: false,
        consequence:
          "Brokers chase this, and an unpaid broker stops bringing buyers long before " +
          "they stop asking. The tax withheld from them is a separate liability that a " +
          "challan clears, not this payment.",
        where: "/sales/brokerage",
        detail: `${r.count} bill${r.count === 1 ? "" : "s"}`,
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* ④ PAYROLL                                                           */
/* ------------------------------------------------------------------ */

async function payrollSignals(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<ExceptionSignal[]> {
  const rows = await tx
    .select({
      id: payrollRuns.id,
      status: payrollRuns.status,
      periodStart: payrollRuns.periodStart,
    })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        sql`${payrollRuns.status} IN ('computed', 'approved')`,
      ),
    )
    .limit(50);

  if (rows.length === 0) return [];

  const approved = rows.filter((r) => r.status === "approved").length;
  const computed = rows.filter((r) => r.status === "computed").length;

  const out: ExceptionSignal[] = [];

  if (approved > 0) {
    out.push({
      key: "payroll:approved_unposted",
      kind: "unposted",
      headline: `${approved} approved payroll run${approved === 1 ? "" : "s"} not in the ledger`,
      amountMinor: null,
      deadline: null,
      /**
       * ⚠️ THIS ONE IS `due_soon` RATHER THAN `watch`, and the reason is
       * the statutory chain hanging off it. PF, ESI, professional tax and
       * salary TDS are all recognised BY the payroll journal — so an
       * unposted run means the statutory section above this one is
       * reading a liability of zero for money that is genuinely owed by
       * the fifteenth.
       */
      state: "due_soon",
      compounds: false,
      consequence:
        "PF, ESI, professional tax and salary TDS are all created by the payroll " +
        "journal. Until it posts, the amounts due to those authorities read as nil on " +
        "this page and on the compliance page — which is the one way this summary can " +
        "be quietly wrong about something with damages attached.",
      where: "/payroll",
      detail: rows.find((r) => r.status === "approved")?.periodStart ?? null,
    });
  }

  if (computed > 0) {
    out.push({
      key: "payroll:computed_unapproved",
      kind: "approval",
      headline: `${computed} payroll run${computed === 1 ? " is" : "s are"} computed and waiting for approval`,
      amountMinor: null,
      deadline: null,
      state: "watch",
      compounds: false,
      consequence:
        "Nobody is paid from a computed run. It is a calculation until somebody signs it.",
      where: "/payroll",
      detail: null,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* ⑤ RETURNS                                                           */
/* ------------------------------------------------------------------ */

async function returnSignals(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<ExceptionSignal[]> {
  const rows = await tx
    .select({
      taxPeriod: gstReturns.taxPeriod,
      status: gstReturns.status,
      dueOn: gstReturns.dueOn,
      totalCashMinor: gstReturns.totalCashMinor,
      transactionId: gstReturns.transactionId,
    })
    .from(gstReturns)
    .where(
      and(
        eq(gstReturns.tenantId, tenantId),
        sql`${gstReturns.status} IN ('draft', 'finalised', 'filed')`,
      ),
    )
    .limit(60);

  const out: ExceptionSignal[] = [];

  for (const r of rows) {
    if (r.status === "filed") {
      /**
       * ⭐ FILED AND NOT POSTED — the reclassification journal almost
       * nobody remembers. It is not late, it is not fined, and left
       * undone forever it produces a balance sheet showing ₹40 lakh of
       * output tax owed against ₹38 lakh receivable when the business
       * owes ₹2 lakh.
       */
      if (!r.transactionId) {
        out.push({
          key: `return:unposted:${r.taxPeriod}`,
          kind: "unposted",
          headline: `The ${r.taxPeriod} return is filed and its journal is not posted`,
          amountMinor: BigInt(r.totalCashMinor ?? "0"),
          deadline: null,
          state: "watch",
          compounds: false,
          consequence:
            "Output and input tax both keep growing until the set-off is posted. The " +
            "balance sheet then shows a large tax liability and a large tax receivable " +
            "where the business owes the difference — it balances, and a lender reads it " +
            "as a company with a tax problem.",
          where: "/gst/gstr3b",
          detail: null,
        });
      }
      continue;
    }

    const dueOn = r.dueOn ? String(r.dueOn).slice(0, 10) : null;
    out.push({
      key: `return:unfiled:${r.taxPeriod}`,
      kind: "return",
      headline:
        r.status === "finalised"
          ? `The ${r.taxPeriod} GSTR-3B is finalised and not filed`
          : `The ${r.taxPeriod} GSTR-3B is still a draft`,
      amountMinor: BigInt(r.totalCashMinor ?? "0"),
      deadline: dueOn,
      state: stateFor({ deadline: dueOn, today }),
      /** 🔴 Late fee per day plus interest at 18% a year. */
      compounds: true,
      consequence:
        "A late 3B carries a late fee for every day it is late and interest at 18% a " +
        "year on the cash payable, and neither is waived for a return that was ready " +
        "and simply not filed.",
      where: "/gst/gstr3b",
      detail: dueOn ? `due ${dueOn}` : null,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */

function formatMinor(minor: bigint): string {
  const abs = minor < 0n ? -minor : minor;
  return `₹${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
