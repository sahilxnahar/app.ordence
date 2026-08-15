/**
 * Ordence — ⭐⭐⭐ WHAT THE SUBSCRIPTION BILLING SCREEN MUST EQUAL
 * Version: v1.46.0-alpha (Batch 49)
 *
 * Pure. Takes two already-loaded totals and decides whether the invoice
 * history may show what it has collected.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THERE IS NO DOUBLE-ENTRY LEDGER BEHIND PLATFORM BILLING, AND THAT
 *    IS NOT A REASON TO SKIP THE CHECK
 * ══════════════════════════════════════════════════════════════════════
 * The receivables reports reconcile to `journal_entries` because their
 * subject matter — money a buyer owes a developer — is posted into the
 * tenant's own books. Subscription billing is different in kind: these
 * are OUR invoices to the customer, and nothing posts them to a ledger
 * anywhere in this product.
 *
 * ⚠️ THE HONEST CONCLUSION IS NOT "SO IT CANNOT BE RECONCILED". Every
 * report has a second source if you look for the thing it is a summary
 * OF, and here that source is unusually good:
 *
 *   SIDE A — `invoices.amount_paid_minor`. Our DERIVED position. It is a
 *            mutable column on a mutable row; it says how much of each
 *            invoice we believe has been settled, and it is what the
 *            "Received" column on the billing screen prints.
 *
 *   SIDE B — `payment_events`. The APPEND-ONLY log of money movements,
 *            each row carrying a provider-issued idempotency key, a
 *            verified payload, and a unique index that makes a duplicate
 *            physically impossible. `server/billing/reconcile.ts` calls
 *            it "the evidence row".
 *
 * A mutable summary checked against an append-only log is exactly the
 * shape a bank reconciliation has, and it fails in exactly the same way:
 * the summary silently stops tracking the log, and nobody finds out
 * until somebody counts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND ON THIS CODEBASE, TODAY, IT DOES NOT TRACK IT
 * ══════════════════════════════════════════════════════════════════════
 * `invoices.amount_paid_minor` is written in exactly ONE place —
 * `recordManualPayment` in `server/actions/billing.ts`. The webhook path
 * in `server/billing/reconcile.ts` imports `invoices` and never updates
 * it: a `payment_succeeded` event advances the subscription's period and
 * writes its evidence row, and the invoice it settled keeps
 * `amount_paid_minor = 0` and status `open` for ever.
 *
 * ⚠️ SO THE BILLING SCREEN'S OWN COPY SAYS "An invoice is marked paid by
 * a verified provider webhook, never from a screen — so anything sitting
 * here has genuinely not been collected", and on a workspace paying by
 * card the opposite is true: everything sits there, and all of it has
 * been collected. That sentence is the most confident thing on the page.
 *
 * 🔴 THIS GATE DOES NOT FIX THAT — applying events to invoices is a
 * change to the webhook write path, which is outside this batch. It
 * makes it VISIBLE, with both figures and the gap in rupees, the first
 * time anybody opens the screen, instead of at a dunning escalation
 * against a customer who has paid every rupee.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHICH EVENTS COUNT, AND WHY THE SET IS NARROW
 * ══════════════════════════════════════════════════════════════════════
 * Only events that NAME AN INVOICE, carry an amount, and were actually
 * applied:
 *
 *   • `invoice_id IS NOT NULL` — a subscription-level charge with no
 *     invoice row is money that arrived and that no invoice claims. It
 *     is a real thing and it is not a discrepancy in the invoice
 *     register, so including it would manufacture a permanent false
 *     breach on every workspace.
 *   • `status = 'processed'` — `received`, `ignored_duplicate`,
 *     `ignored_unknown_tenant` and `failed` are recorded precisely
 *     BECAUSE they were not applied. Counting a duplicate would double
 *     a payment; counting a failure would invent one.
 *   • `payment_succeeded` and `invoice_paid` add; `payment_refunded`
 *     subtracts. A refund that is not netted off leaves the log
 *     permanently above the register by the refunded amount, which would
 *     read as an unapplied payment and send somebody looking for money
 *     that was given back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TOLERANCE IS ZERO, AND HERE IS WHY THAT IS SAFE
 * ══════════════════════════════════════════════════════════════════════
 * `invoices.amount_paid_minor` and `payment_events.amount_minor` are
 * both `bigint` minor-unit columns. Nothing divides between the row and
 * the total — the GST split that DOES divide happens when the invoice is
 * generated and lands in its own columns, none of which are on either
 * side of this comparison. A band would buy nothing and would hide up to
 * its own width of a genuinely unapplied payment.
 */

import { EXACT, reconcile, type Reconciliation } from "./gate";

/** Event kinds that MOVED money onto an invoice. */
export const SETTLING_EVENT_TYPES = ["payment_succeeded", "invoice_paid"] as const;
/** Event kinds that moved money back off one. */
export const REVERSING_EVENT_TYPES = ["payment_refunded"] as const;
/** The only status that means "this was applied". */
export const APPLIED_EVENT_STATUS = "processed" as const;

export const BILLING_BREACH_CAUSES: readonly string[] = Object.freeze([
  "A payment confirmed by the provider has not been applied to the invoice it " +
    "settled. The money reached us; the invoice register does not know it. Anything " +
    "shown as owing may already have been paid.",
  "An invoice was settled outside the provider — a bank transfer entered by hand " +
    "without its reference, so no evidence row was written to sit behind it.",
  "A refund was issued at the provider and the invoice it came off was not " +
    "reduced, or was reduced twice.",
]);

export type BillingReconciliationInput = {
  /** Σ `invoices.amount_paid_minor` across every invoice in the workspace. */
  registerPaidMinor: bigint;
  /** Σ applied money events naming an invoice, refunds netted off. */
  eventLogPaidMinor: bigint;
  /**
   * 🔴 STRUCTURAL, NOT AN AMOUNT. False when this workspace has never
   * been invoiced and has no payment events at all — a trial that has
   * not converted, which is most new workspaces. Both sides are then
   * zero, and zero equals zero is not a passing reconciliation. See
   * design point ④ in `./gate.ts`.
   *
   * ⚠️ AN INVOICE WITH NO EVENTS IS **CONFIGURED**, NOT UNCONFIGURED. An
   * issued and unpaid invoice is a real, checkable state: the register
   * says nothing has been received and the log agrees, and that
   * agreement is worth something. Only the total absence of both is a
   * workspace with nothing to check.
   */
  hasBillingHistory: boolean;
};

/**
 * ⭐⭐⭐ MAY THE INVOICE HISTORY SHOW WHAT IT HAS COLLECTED?
 *
 * ⚠️ IT GATES THE MONEY COLUMNS, NOT THE INVOICE LIST. The invoice
 * numbers, dates and totals are the documents themselves — each one is a
 * GST tax invoice the customer's own auditor asks for, and withholding
 * them would be withholding a legal document over a discrepancy in a
 * derived column. What is withheld is every figure that ASSERTS
 * SETTLEMENT: the received amounts, and the "still owing" list which is
 * nothing but a subtraction of them.
 *
 * 🔴 THAT DISTINCTION IS NOT A SOFTENING OF THE RULE, IT IS THE RULE
 * APPLIED PRECISELY. The doctrine withholds figures that have failed
 * their check. An invoice total has not failed any check — nothing
 * disagrees with it, and it is a fact about a document rather than a
 * claim about money that moved. The amount received is the claim, and
 * that is what goes dark.
 */
export function reconcileBillingHistory(
  input: BillingReconciliationInput,
): Reconciliation {
  return reconcile({
    subject: "Invoice settlement",
    ledgerConfigured: input.hasBillingHistory,
    notes: input.hasBillingHistory
      ? []
      : [
          "This workspace has never been invoiced and has no recorded payments, so " +
            "there is nothing to reconcile yet. Invoices appear the first time a " +
            "billing period closes.",
        ],
    checks: [
      {
        id: "invoice-paid-vs-event-log",
        claim:
          "What the invoices say has been received must equal the money the " +
          "payment log records arriving against them.",
        // See the file header for why this is exact and not a band.
        toleranceMinor: EXACT,
        report: {
          label: "the invoice register",
          source: "invoices.amount_paid_minor",
          amountMinor: input.registerPaidMinor,
        },
        ledger: {
          label: "the payment event log",
          source: "payment_events (append-only, provider-verified)",
          amountMinor: input.eventLogPaidMinor,
        },
      },
    ],
  });
}
