/**
 * Ordence — ⭐⭐⭐ WHAT THE RECEIVABLES REPORTS MUST EQUAL
 * Version: v1.46.0-alpha (Batch 49)
 *
 * Pure. Takes two already-loaded totals and decides whether the report
 * may be shown. The queries live in `server/actions/receivables.ts`;
 * every rupee of judgement lives here, where it can be exercised without
 * standing up Postgres — the same split `lib/accounting/cash-flow.ts`
 * uses, and for the same reason.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE IDENTITY BEING CHECKED, DERIVED FROM THE POSTING RULES
 * ══════════════════════════════════════════════════════════════════════
 * `lib/accounting/sales-posting.ts` defines exactly three entries that
 * ever touch the `booking_receivable` ledger, and the identity falls out
 * of them rather than being asserted:
 *
 *   DEMAND SERVED      Dr Booking receivable   total (principal + tax)
 *   RECEIPT            Cr Booking receivable   cash + TDS
 *   CANCELLATION       Cr Booking receivable   demands raised, never paid
 *
 * So the DEBIT-POSITIVE balance of that one ledger is, by construction:
 *
 *   🔴  Σ(served demand totals) − Σ(receipts applied) − Σ(cancelled)
 *
 * And the ageing report computes, from an entirely different table:
 *
 *   🔴  Σ over live demands of (total − allocated)
 *
 * Those are the same quantity reached from two directions that share no
 * row, no table and no query. `demand_notices` knows nothing about
 * `journal_entries` and vice versa — the only thing tying them together
 * is that `serveDemand` and `recordPayment` happen to write both, in one
 * transaction, on the way past. That is precisely why the check is worth
 * running: the tie is a convention, and conventions rot.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE THREE WAYS THEY COME APART TODAY, ALL OF THEM REAL
 * ══════════════════════════════════════════════════════════════════════
 * These are not hypotheticals. Each one is reachable from the UI right
 * now, and each one moves the ageing total without moving the ledger:
 *
 *   ① `withdrawDemand` cancels a served demand. The demand drops out of
 *      `ageingRows` (it filters on status `issued`/`part_paid`) and NO
 *      reversing journal is posted. The books still carry the debit, for
 *      ever. Ageing goes DOWN, the control account does not.
 *
 *   ② `replaceDemand` supersedes one demand with another. Same shape:
 *      the superseded demand leaves the ageing report, its debit stays.
 *      If the replacement was also served, the ledger now carries BOTH.
 *
 *   ③ `markReceiptBounced` releases a receipt's allocations. Outstanding
 *      on the demands goes back UP and no reversing journal is posted,
 *      so the ledger still shows the money as collected. Ageing goes UP,
 *      the control account does not.
 *
 * ⭐ THE GATE DOES NOT FIX ANY OF THEM, and it is not supposed to. It
 * makes them VISIBLE the first time somebody opens the screen, with the
 * gap in rupees, instead of at an audit a year later. The fix is a
 * reversing entry on each of those three paths, which is a change to
 * write paths that are out of this batch's scope.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THE TOLERANCE IS ZERO, STATED RATHER THAN ASSUMED
 * ══════════════════════════════════════════════════════════════════════
 * Both sides are sums of `bigint` paise and NOTHING between the source
 * row and the compared total performs a division:
 *
 *   • `demand_notices.total_minor` and `.allocated_minor` are `bigint`
 *     minor-unit columns with a database check constraining
 *     `total = principal + tax`. `ageReceivables` only adds them.
 *   • the journal side is `numeric(18,2)` summed by Postgres and
 *     converted with `toMinorUnits`, which is exact on a 2-decimal
 *     string — the float round trip was deliberately removed from
 *     `ledgerBalances` for this reason.
 *
 * `demandPosition` DOES divide — `outstandingTax` is a pro-rata split —
 * but that figure is not on either side of this comparison. So the
 * correct tolerance is `EXACT`, and a non-zero band here would buy
 * nothing and hide up to its own width of a real gap.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE INTEREST COLUMN HAS NO LEDGER COUNTERPART AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `delay_interest_income` is declared as a posting role and NOTHING in
 * the product ever posts to it: accrued delay interest is computed at
 * read time by `accrueInterest` and never enters the books. So the
 * "Interest accrued" figure on the ageing screen is not wrong, it is
 * UNCHECKABLE — there is no second source in existence to compare it to.
 *
 * 🔴 IT IS THEREFORE DECLARED AS A NOTE RATHER THAN CHECKED, and the
 * note is shown even when everything else reconciles. Quietly letting an
 * unverifiable figure sit inside a card headed "reconciled" is the exact
 * laundering this batch exists to stop — the tick was earned by the two
 * figures beside it, and it does not transfer.
 */

import {
  EXACT,
  reconcile,
  type Reconciliation,
} from "./gate";

/**
 * ⚠️ THE POSTING ROLE, NOT A LEDGER NAME OR CODE. `db/schema/
 * accounting.ts` is explicit that "a ledger cannot be guessed from its
 * name or its code — every tenant builds their own chart of accounts",
 * and a control account found by matching `%receivable%` would silently
 * reconcile against the wrong ledger for any tenant who called theirs
 * "Sundry debtors" or "Flat buyers". `sales_posting_accounts` is the
 * tenant's own declaration of which ledger plays this part, it is unique
 * per role per tenant, and it is the only structural answer available.
 */
export const RECEIVABLE_CONTROL_ROLE = "booking_receivable" as const;

/** Roles whose DEBITS are money that actually arrived. See below. */
export const COLLECTION_ROLES = ["bank", "tds_receivable"] as const;

/**
 * 🔴 WHICH TRANSACTIONS COUNT AS "IN THE BOOKS" — `posted` AND
 * `reversed`, AND NOTHING ELSE.
 *
 * ⚠️ THIS RESTATES `STATEMENT_TRANSACTION_STATUSES` IN
 * `server/actions/accounting.ts`, WHICH IS NOT EXPORTED — it is a
 * private constant inside a `"use server"` module, and importing across
 * two action files to share it would publish the wrong thing and couple
 * two RPC surfaces. The duplication is forced; what matters is that the
 * two never drift, so the reason is restated in full rather than
 * referenced:
 *
 * `reverseTransaction` writes the mirror entry as a NEW `posted`
 * transaction and marks the ORIGINAL `reversed`. A reversal pair is one
 * `reversed` row and one `posted` row, and both sets of legs are real.
 * Filter to `posted` alone and you keep every correction and drop
 * everything corrected — the control account then sits BELOW the ageing
 * total by the value of every reversal, and this gate would report a
 * breach on a set of books that is perfectly sound. `void` and `pending`
 * are out: one is a transaction the business says never happened, the
 * other is a draft.
 *
 * 🔴 IF THE STATEMENTS EVER CHANGE THEIR STATUS SET, THIS MUST CHANGE
 * WITH THEM. A gate that defines "in the books" differently from the
 * trial balance is a gate that fires on healthy data, and a gate that
 * fires on healthy data gets switched off.
 */
export const LEDGER_TRANSACTION_STATUSES = ["posted", "reversed"] as const;

/** What the caller loaded from the ledger side. */
export type ControlAccountFacts = {
  /**
   * 🔴 STRUCTURAL, NOT AN AMOUNT. True only when the tenant has mapped
   * the role to a live ledger. A zero balance on a mapped ledger is a
   * checked zero; a zero from an unmapped role is not a figure at all.
   */
  configured: boolean;
  /** "Sundry debtors — flats (1210)", for the breach sentence. */
  label: string;
  /** Debit-positive, in paise, since inception to the report's date. */
  balanceMinor: bigint;
};

const AGEING_SUBJECT = "Receivables ageing";
const STATEMENT_SUBJECT = "Statement of account";

const NOT_CONFIGURED_NOTE =
  "No receivables control account is mapped in this workspace, so the figures " +
  "below have not been checked against the books. Map the Booking receivable " +
  "posting role under Settings → Accounting and this report will reconcile " +
  "itself every time it is opened. Until then the totals come from the demand " +
  "notices alone and nothing has confirmed them.";

const INTEREST_NOTE =
  "Interest accrued is computed at read time from the terms frozen on each " +
  "demand and is never posted to the ledger, so it has no counterpart in the " +
  "books and is not covered by the check above.";

/**
 * ⚠️ THE CAUSES ARE LISTED WITH THE BREACH, NOT BURIED IN A RUNBOOK.
 * "Your books are out by ₹14,500" plus three named things that cause
 * exactly this is a twenty-minute investigation. The same figure with no
 * causes is a support ticket, and the answer that comes back is these
 * three sentences typed out again by somebody who had to go and read
 * this file.
 */
export const AGEING_BREACH_CAUSES: readonly string[] = Object.freeze([
  "A demand notice was withdrawn or superseded after it had been served. That " +
    "removes it from this report but posts no reversing entry, so the books still " +
    "carry the debit.",
  "A receipt was marked bounced. That releases its allocation and puts the " +
    "outstanding back on this report, but posts no reversing entry, so the books " +
    "still show the money as collected.",
  "A demand or receipt was written while the accounts were unmapped or the " +
    "period was closed, so the document exists and the journal behind it does not. " +
    "The unposted backlog under Accounting lists these.",
  "The Booking receivable role was re-pointed at a different ledger after entries " +
    "had already been posted to the old one.",
]);

/* ------------------------------------------------------------------ */
/* THE AGEING REPORT                                                   */
/* ------------------------------------------------------------------ */

export type AgeingReconciliationInput = {
  /**
   * `AgeingReport.totalMinor` — everything raised and unpaid, due or not.
   *
   * 🔴 IT IS THE **UNFILTERED**, WORKSPACE-WIDE TOTAL, even when the
   * screen is showing one project. The control account is a single
   * ledger for the whole tenant and `journal_entries` carries the
   * BOOKING as its counterparty, not the project — so a per-project
   * slice of the ledger cannot be taken at all. Reconciling the whole
   * set and then displaying a slice of it is the honest option: you
   * cannot publish an extract of a book that does not foot, and the
   * alternative (checking nothing whenever a filter is applied) makes
   * the gate disappear exactly when somebody is drilling into a number
   * they already distrust.
   */
  ageingTotalMinor: bigint;
  control: ControlAccountFacts;
  /** True when the interest column is on screen. Adds the note. */
  showsInterest: boolean;
  /**
   * The report's as-at date and the day it is being run. When they
   * differ the report is not reconcilable — see below.
   */
  asOf: string;
  today: string;
};

/**
 * ⭐⭐⭐ MAY THE AGEING REPORT BE SHOWN?
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE BACK-DATED CASE, WHICH IS A REPORTING BUG THIS GATE FOUND
 * ══════════════════════════════════════════════════════════════════════
 * `ageingRows` selects demands by their CURRENT status and computes
 * `outstanding = total − allocated` from the demand row as it stands
 * NOW. `asOf` is used only to bucket by age and to accrue interest. So
 * an ageing report run "as at 31 March" shows TODAY'S outstanding
 * amounts, arranged into the buckets they would have been in on 31
 * March. That is not the receivables position on 31 March, and it is
 * labelled as though it were.
 *
 * ⚠️ THE LEDGER SIDE HAS NO SUCH AMBIGUITY — `transaction_date <= asOf`
 * gives the genuine position on that day. So the two agree when `asOf`
 * is today and disagree by every demand served and every rupee collected
 * since, whenever it is not.
 *
 * 🔴 THAT IS DECLARED AS A BREACH, NOT SMOOTHED OVER. The alternative —
 * quietly reconciling the back-dated report against today's ledger — is
 * the worst of every option: the figures would tie, the tick would
 * appear, and the reader would take a report headed "as at 31 March" as
 * verified when it is a mixture of two dates. A report that cannot be
 * checked as at the date printed on it must not print figures under that
 * date.
 */
export function reconcileAgeingReport(
  input: AgeingReconciliationInput,
): Reconciliation {
  const notes: string[] = [];
  if (!input.control.configured) notes.push(NOT_CONFIGURED_NOTE);
  if (input.showsInterest) notes.push(INTEREST_NOTE);

  /**
   * ⚠️ THE BACK-DATED CASE IS MODELLED AS A FAILED CHECK RATHER THAN AS
   * A SEPARATE FLAG, so it travels through the same banner, in the same
   * words, with the same refusal to print a figure. A second refusal
   * mechanism is a second place the rule can be relaxed.
   *
   * 🔴 AND IT IS TESTED **BEFORE** THE CONFIGURATION TEST BELOW. A
   * back-dated report on an unmapped workspace is still a report that
   * cannot be checked as at the date printed on it — returning
   * "unconfigured, here are your figures" would print it anyway.
   */
  if (input.asOf !== input.today) {
    return reconcile({
      subject: AGEING_SUBJECT,
      ledgerConfigured: input.control.configured,
      notes,
      checks: [
        {
          id: "ageing-as-at",
          claim: `This report is headed "as at ${input.asOf}".`,
          toleranceMinor: EXACT,
          /**
           * 🔴 UNCONDITIONALLY UNRENDERABLE, EVEN IF THE TWO FIGURES
           * HAPPEN TO BE EQUAL — which they will be whenever nothing has
           * been demanded or collected since `asOf`. Passing on that
           * coincidence would put a verified tick over a report that
           * mixes two dates, on the days it happens to be harmless, and
           * remove it on the days it is not. A check that is right by
           * luck is a check nobody can rely on.
           */
          notComparable:
            `Its outstanding amounts are the balances as they stand today, not as ` +
            `they stood on ${input.asOf} — only the ageing buckets and the interest ` +
            `use the chosen date. The books can say what was outstanding on ` +
            `${input.asOf}; this report cannot, so the two are not comparable and no ` +
            `figures are shown under that heading. Run it as at today, or take the ` +
            `position on ${input.asOf} from the trial balance.`,
          report: {
            label: `AR ageing as at ${input.asOf}`,
            source: "demand_notices (current balances, aged to the chosen date)",
            amountMinor: input.ageingTotalMinor,
          },
          ledger: {
            label: `the receivables control account at ${input.asOf}`,
            source: `journal_entries via ${RECEIVABLE_CONTROL_ROLE} (position on the chosen date)`,
            amountMinor: input.control.balanceMinor,
          },
        },
      ],
    });
  }

  return reconcile({
    subject: AGEING_SUBJECT,
    ledgerConfigured: input.control.configured,
    notes,
    /**
     * 🔴 NO CHECK AT ALL WHEN THE ROLE IS UNMAPPED — NOT A CHECK AGAINST
     * ZERO.
     *
     * ⚠️ THIS IS THE SUBTLE HALF OF DESIGN POINT ④ AND IT IS EASY TO GET
     * BACKWARDS. An unmapped posting role does not produce a balance of
     * zero; it produces NO FIGURE. Comparing the report against the zero
     * that a missing row happens to sum to would fail every workspace
     * that has receivables and has not configured accounting — a red
     * screen accusing them of a discrepancy whose real cause is that
     * nobody has told us which ledger to look at. The state for that is
     * `unconfigured`, which `reconcile` returns from `ledgerConfigured`
     * once there are no breaches to outrank it.
     */
    checks: input.control.configured
      ? [
          {
            id: "ageing-total-vs-control",
            claim:
              "Everything raised and unpaid must equal the balance of the receivables " +
              "control account in the books.",
            // See the file header for why this is exact and not a band.
            toleranceMinor: EXACT,
            report: {
              label: "AR ageing",
              source: "demand_notices",
              amountMinor: input.ageingTotalMinor,
            },
            ledger: {
              label: `the receivables control account (${input.control.label})`,
              source: `journal_entries via the ${RECEIVABLE_CONTROL_ROLE} posting role`,
              amountMinor: input.control.balanceMinor,
            },
          },
        ]
      : [],
  });
}

/* ------------------------------------------------------------------ */
/* THE STATEMENT OF ACCOUNT                                            */
/* ------------------------------------------------------------------ */

export const STATEMENT_BREACH_CAUSES: readonly string[] = Object.freeze([
  "A receipt against this booking was marked bounced. The statement no longer " +
    "counts it; the books still do, because no reversing entry is posted.",
  "A demand against this booking was withdrawn or superseded after being served. " +
    "It has left the statement and its debit is still in the books.",
  "A receipt or demand for this booking was recorded while the accounts were " +
    "unmapped or its period was closed, so no journal was written for it.",
]);

export type StatementReconciliationInput = {
  /** `StatementTotals.outstandingMinor` — demanded less applied. */
  outstandingMinor: bigint;
  /** `receivedMinor` — cash counted, excluding bounced and cancelled. */
  receivedMinor: bigint;
  /** `tdsCreditMinor` — section 194-IA tax the buyer paid on our behalf. */
  tdsCreditMinor: bigint;
  control: ControlAccountFacts;
  /**
   * Total DEBITS to the bank and TDS-receivable ledgers carried against
   * this booking.
   *
   * 🔴 DEBITS ONLY, NOT THE NET MOVEMENT, AND THE DIFFERENCE IS A REAL
   * ONE. A cancellation refund CREDITS the bank against the same booking
   * counterparty (`buildRefundPaymentPosting`). Netting it off would
   * reduce "collected" by money that genuinely was collected and then
   * returned — a separate fact, on a separate date, that the statement
   * reports separately. Using the net figure here would make a refunded
   * booking look like one that never paid.
   */
  collectionDebitsMinor: bigint;
  collectionsConfigured: boolean;
  collectionsLabel: string;
};

/**
 * ⭐⭐⭐ MAY A BUYER'S STATEMENT OF ACCOUNT BE SHOWN?
 *
 * ⚠️ THIS IS THE DOCUMENT WITH THE HIGHEST COST OF BEING WRONG in the
 * whole receivables stack, and it is the one people assume is safest
 * because `buildStatement` already refuses to produce a statement that
 * does not foot. That check is internal: it proves the statement is
 * consistent WITH ITSELF. A statement can foot perfectly and still
 * disagree with the books by the value of one bounced cheque — and it is
 * handed to a buyer, who keeps it, and who produces it in a consumer
 * forum when the developer's own ledger says something else.
 *
 * ⚠️ TWO CHECKS, NOT ONE COMBINED FIGURE. What a buyer still owes and
 * what a buyer has paid fail for different reasons and are fixed by
 * different people. A single "the statement disagrees by ₹X" would be
 * satisfied by an error in one direction on each side cancelling out —
 * the one combination that means both halves are wrong.
 */
export function reconcileStatement(
  input: StatementReconciliationInput,
): Reconciliation {
  const notes: string[] = [];
  if (!input.control.configured) notes.push(NOT_CONFIGURED_NOTE);
  if (!input.collectionsConfigured) {
    notes.push(
      "The Bank / Cash or TDS receivable posting roles are not mapped, so what " +
        "this buyer has paid has not been checked against the books.",
    );
  }

  /**
   * 🔴 EACH CHECK IS EMITTED ONLY IF ITS OWN LEDGER SIDE EXISTS. An
   * unmapped posting role produces no figure, not a zero — see the same
   * note on the ageing report. A workspace that has mapped the control
   * account but not the bank still gets the check it CAN have, and is
   * told in words that the other half is unverified; it does not get a
   * fabricated "you have collected ₹0.00" breach.
   */
  const checks = [];

  if (input.control.configured) {
    checks.push({
      id: "statement-outstanding-vs-control",
      claim:
        "What this buyer still owes must equal their balance on the receivables " +
        "control account.",
      toleranceMinor: EXACT,
      report: {
        label: "the statement",
        source: "demand_notices and receipt_allocations for this booking",
        amountMinor: input.outstandingMinor,
      },
      ledger: {
        label: `the receivables control account (${input.control.label})`,
        source: `journal_entries against this booking via ${RECEIVABLE_CONTROL_ROLE}`,
        amountMinor: input.control.balanceMinor,
      },
    });
  }

  if (input.collectionsConfigured) {
    checks.push({
      id: "statement-collected-vs-cash",
      claim:
        "What this buyer has paid — cash plus the tax they deducted at source — " +
        "must equal the money the books show arriving from them.",
      toleranceMinor: EXACT,
      report: {
        label: "the statement",
        source: "receipts for this booking",
        amountMinor: input.receivedMinor + input.tdsCreditMinor,
      },
      ledger: {
        label: `bank and TDS receivable (${input.collectionsLabel})`,
        source: "journal_entries against this booking via the bank and TDS roles",
        amountMinor: input.collectionDebitsMinor,
      },
    });
  }

  return reconcile({
    subject: STATEMENT_SUBJECT,
    // 🔴 BOTH must be mapped before this document counts as verified.
    // Checking half of a two-sided document and calling it reconciled is
    // how the unchecked half gets read as checked.
    ledgerConfigured: input.control.configured && input.collectionsConfigured,
    notes,
    checks,
  });
}
