/**
 * Ordence — ⭐⭐ CREDIT EXPOSURE AND HEADROOM
 * Version: v1.46.0-alpha (Batch 40)
 *
 * Pure. `bigint` paise, no clock, no database, no imports from
 * `server/`. Everything this file needs is handed to it, and everything
 * it returns is a decision somebody can read out loud.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS EXISTS BESIDE `lib/credit/exposure.ts` RATHER THAN INSIDE IT
 * ══════════════════════════════════════════════════════════════════════
 * `exposure.ts` (v0.89.0) answers ONE question and answers it correctly:
 * what has the order book committed us to, less what has arrived. It is
 * wired into `confirmOrder` and into the customer panel, and both of
 * those keep using it unchanged.
 *
 * 🔴 WHAT IT CANNOT SEE IS AN INVOICE WITH NO ORDER BEHIND IT.
 * `sales_invoices.orderId` is nullable and the comment on it says why —
 * "a service invoice or a counter sale has no order behind it". Every
 * one of those is real, unpaid, legally enforceable debt that the
 * order-book exposure figure values at exactly zero. A customer whose
 * business with us is entirely service-invoiced has an exposure of ₹0
 * and unlimited headroom, forever, no matter what they owe.
 *
 * ⚠️ AND THE OBVIOUS FIX — "add invoices to the order sum" — DOUBLE
 * COUNTS. An order for ₹5,00,000 that has been invoiced in full is one
 * debt appearing in two tables. Adding the two totals values it at
 * ₹10,00,000 and refuses the customer's next order for a reason that
 * does not exist.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT COUNTS TOWARD EXPOSURE, STATED ONCE SO IT IS NEVER GUESSED
 * ══════════════════════════════════════════════════════════════════════
 *
 *     exposure  =  BILLED  +  UNBILLED
 *
 *     BILLED    = Σ over the customer's OPEN tax invoices of
 *                     max(0, totalMinor − receivedMinor)
 *
 *     UNBILLED  = Σ over the customer's LIVE orders of
 *                     max(0, totalMinor − billedAgainstThisOrderMinor)
 *
 * The two halves are disjoint by construction: the moment an order is
 * invoiced, the invoiced part leaves UNBILLED and appears in BILLED.
 * Nothing is counted twice, and nothing that has been committed to is
 * invisible.
 *
 * ⚠️ THREE SPECIFIC CHOICES INSIDE THAT, EACH ONE ARGUABLE:
 *
 * ① `UNBILLED` NETS OFF THE INVOICED VALUE, NOT THE ORDER'S RECEIPTS.
 *    `sales_orders.receivedValueMinor` is advance money against the
 *    whole order, and when the invoice is raised that advance is
 *    normally allocated to it and shows up again in the invoice's
 *    `receivedMinor`. Netting it off BOTH halves would relieve the same
 *    rupee twice and understate what the customer owes. Not netting it
 *    off the unbilled half overstates exposure slightly for customers
 *    who pay in advance — and for a credit ceiling, overstating is the
 *    direction that fails safe. A customer who has paid us up front and
 *    is refused an order gets a phone call. A customer who has not, and
 *    is not refused, gets the goods.
 *
 * ② DRAFT INVOICES DO NOT COUNT. A draft is not a demand for money and
 *    the customer has never seen it. Counting drafts would let anybody
 *    with invoice-create permission exhaust a customer's limit without
 *    issuing anything.
 *
 * ③ 🔴 REAL-ESTATE DEMAND NOTICES DO NOT COUNT, AND THIS IS THE ONE THE
 *    BRIEF EXPLICITLY ASKED ABOUT.
 *
 *    `demand_notices` is keyed on `booking_id` + `milestone_id`, both NOT
 *    NULL. `receipts` is keyed on `booking_id`. There is no `company_id`
 *    anywhere in `db/schema/receivables.ts` — the counterparty of a RERA
 *    milestone demand is a LEAD who has booked a flat, not a company
 *    with a trade account. The only bridge in the schema is
 *    `sales_orders.bookingId`, whose own comment says it is populated
 *    only "when this order is the goods half of a unit booking", which
 *    is nearly never.
 *
 *    Including demands would mean inventing a relationship the schema
 *    does not assert. The first flat buyer who is also a trade customer
 *    would have one debt counted under two counterparties, and the first
 *    one who is NOT would contribute nothing while appearing to have
 *    been considered. A figure that is sometimes right and never
 *    knowably so is worse than a figure with a stated boundary.
 *
 *    ⚠️ SO THE BOUNDARY IS STATED ON THE SCREEN, not just here:
 *    `EXPOSURE_SCOPE_NOTE` below is rendered by the credit board. A user
 *    who owns both a project and a trading arm needs to know that this
 *    number is about one of them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE RECONCILIATION DOCTRINE: DOES IT APPLY HERE? PARTLY. SAY WHICH.
 * ══════════════════════════════════════════════════════════════════════
 * `lib/reconciliation/gate.ts` and `lib/accounting/cash-flow.ts` say:
 * compute the answer twice by two routes that share no source, and when
 * the two disagree render NO figure. The temptation is to wave that at
 * this module and claim the whole exposure number is verified. It is
 * not, and claiming it would be the exact failure the doctrine exists to
 * prevent — a correct-looking number under a heading that says
 * "checked".
 *
 * ⭐ THE HALF IT APPLIES TO. `BILLED` depends on
 * `sales_invoices.received_minor`, which is a MAINTAINED COLUMN: a
 * trigger writes it when a receipt is allocated. The allocation rows
 * themselves — `customer_receipt_allocations` — are a completely
 * separate table, and summing them for cleared receipts gives the same
 * figure by a route that shares no source with the column.
 *
 * 🔴 AND THEY DRIFT IN A KNOWN WAY. `markReceiptBounced` moves a receipt
 * to `bounced` and releases its allocations. If the column is not
 * decremented in the same transaction, `received_minor` still says the
 * customer paid — exposure is understated by the bounced amount, and the
 * credit limit lets through exactly the order it exists to stop, for the
 * exact customer whose cheque just bounced. That is not a hypothetical;
 * it is the single most likely way this feature fails silently, and it is
 * why the check below is worth its cost.
 *
 * ⚠️ THE HALF IT DOES NOT APPLY TO. `UNBILLED` has no second source and
 * cannot have one. Nothing outside `sales_orders` records a commitment
 * that has not yet become a document — the general ledger has never
 * heard of it, because nothing has been recognised. Inventing a check
 * for it (summing the order's own lines, say) would compare a table to
 * itself, which `reconcile()` faults by design.
 *
 * ⭐ SO: the unbilled figure is included in exposure and is declared
 * UNVERIFIED, in a note, on the screen. And when the billed check
 * BREACHES, no headroom figure is produced at all —
 * `CreditHeadroom.headroomMinor` is structurally absent rather than
 * present behind a boolean, so a screen cannot print an unverified
 * ceiling by mistake.
 *
 * 🔴 A BREACH DOES NOT OPEN THE GATE. `confirmOrder` still refuses a
 * held customer, and still routes an over-limit order to approval on the
 * figures it has. "We cannot vouch for this number" is a reason to stop
 * SHOWING it, never a reason to stop ENFORCING on it — an attacker who
 * could induce a reconciliation breach would otherwise have found a way
 * to disable credit control for the whole workspace.
 */

import {
  EXACT,
  reconcile,
  type Reconciliation,
  type ReconciliationCheckInput,
} from "@/lib/reconciliation/gate";

/* ------------------------------------------------------------------ */
/* WHAT THE FIGURE IS ABOUT                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ RENDERED ON THE CREDIT BOARD, NOT JUST WRITTEN HERE. See ③ above.
 */
export const EXPOSURE_SCOPE_NOTE =
  "This is the trade account: tax invoices and sales orders for this company. " +
  "Real-estate milestone demands are raised against a unit booking and a lead, " +
  "not against a company, and are shown in Receivables instead — a workspace " +
  "that sells flats and goods to the same person has two positions, not one.";

/* ------------------------------------------------------------------ */
/* THE BILLED HALF                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `draft` AND `cancelled` ARE OUT; `paid` IS IN AND CONTRIBUTES ZERO.
 *
 * Keeping `paid` in the counted set rather than filtering it away is
 * deliberate: a `paid` invoice whose `totalMinor` exceeds its
 * `receivedMinor` is a status that has gone stale, and it contributes
 * its real shortfall rather than being silently valued at zero because
 * of what the status column says. The status is a summary; the two money
 * columns are the fact.
 */
export const INVOICE_EXCLUDED_STATUSES: readonly string[] = Object.freeze([
  "draft",
  "cancelled",
]);

/** One tax invoice, reduced to the facts exposure needs. */
export type InvoiceExposureFact = {
  id: string;
  invoiceNumber: string;
  status: string;
  /** NULL for a service invoice or counter sale. See the header. */
  orderId: string | null;
  /** ISO date. NULL where terms were never set — see `lib/credit/dunning.ts`. */
  dueDate: string | null;
  /** Paise. */
  totalMinor: bigint;
  /**
   * Paise, from the maintained column. 🔴 The figure the reconciliation
   * check below exists to second-guess.
   */
  receivedMinor: bigint;
  /**
   * Paise. Σ of `customer_receipt_allocations.amountMinor` for CLEARED
   * receipts against this invoice, loaded separately by the caller.
   *
   * ⚠️ NOT USED IN THE EXPOSURE ARITHMETIC — only in the check. If it
   * were used, both sides of the reconciliation would come from it and
   * the check would compare a number to itself.
   */
  allocatedMinor: bigint;
};

/** What one invoice contributes. Never negative. */
export function invoiceOutstanding(invoice: InvoiceExposureFact): bigint {
  if (INVOICE_EXCLUDED_STATUSES.includes(invoice.status)) return 0n;
  const unpaid = invoice.totalMinor - invoice.receivedMinor;
  return unpaid > 0n ? unpaid : 0n;
}

/* ------------------------------------------------------------------ */
/* THE UNBILLED HALF                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SAME EXCLUSION LIST AS `lib/credit/exposure.ts`, IMPORTED
 * RATHER THAN RETYPED IS NOT POSSIBLE HERE WITHOUT A CYCLE — so it is
 * asserted equal by `tests/ui/credit-control.test.ts` instead. Two
 * hand-written copies of the list of statuses that count is precisely
 * the drift a credit ceiling cannot survive: one screen counts `on_hold`
 * orders and the other does not, and the customer's exposure depends on
 * which page you opened.
 */
export const ORDER_EXCLUDED_STATUSES: readonly string[] = Object.freeze([
  "draft",
  "pending_approval",
  "cancelled",
]);

export type OrderCommitmentFact = {
  id: string;
  orderNo: string;
  status: string;
  /** Paise. Trigger-maintained by 0028 §4 on every line write. */
  totalMinor: bigint;
};

/**
 * The part of an order that has not yet become a tax invoice.
 *
 * ⚠️ `billedMinor` IS THE SUM OF THE ORDER'S NON-EXCLUDED INVOICES'
 * TOTALS, NOT THEIR OUTSTANDING AMOUNTS. Once a rupee has been invoiced
 * it is the invoice's problem — paid or not — and the unbilled half must
 * stop counting it or the paid-off portion of a part-invoiced order
 * would come back as fresh exposure.
 */
export function unbilledCommitment(
  order: OrderCommitmentFact,
  billedMinor: bigint,
): bigint {
  if (ORDER_EXCLUDED_STATUSES.includes(order.status)) return 0n;
  const remaining = order.totalMinor - billedMinor;
  return remaining > 0n ? remaining : 0n;
}

/* ------------------------------------------------------------------ */
/* THE WHOLE POSITION                                                  */
/* ------------------------------------------------------------------ */

export type CreditExposure = {
  /** Σ outstanding on open tax invoices. Paise. Reconciled. */
  billedMinor: bigint;
  /** Σ committed-but-not-yet-invoiced order value. Paise. UNVERIFIED. */
  unbilledMinor: bigint;
  /** billed + unbilled. Paise. */
  totalMinor: bigint;
  openInvoices: number;
  liveOrders: number;
};

export function creditExposure(args: {
  invoices: readonly InvoiceExposureFact[];
  orders: readonly OrderCommitmentFact[];
}): CreditExposure {
  const { invoices, orders } = args;

  /**
   * ⚠️ BUILT FROM THE SAME INVOICE LIST THE BILLED HALF USES. A second
   * query for "what has been invoiced against this order" would be a
   * second definition of the same set, and the two would drift the first
   * time somebody added a status to one filter and not the other.
   */
  const billedPerOrder = new Map<string, bigint>();
  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.includes(inv.status)) continue;
    if (!inv.orderId) continue;
    billedPerOrder.set(inv.orderId, (billedPerOrder.get(inv.orderId) ?? 0n) + inv.totalMinor);
  }

  let billedMinor = 0n;
  let openInvoices = 0;
  for (const inv of invoices) {
    const amount = invoiceOutstanding(inv);
    if (amount > 0n) {
      billedMinor += amount;
      openInvoices += 1;
    }
  }

  let unbilledMinor = 0n;
  let liveOrders = 0;
  for (const order of orders) {
    const amount = unbilledCommitment(order, billedPerOrder.get(order.id) ?? 0n);
    if (amount > 0n) {
      unbilledMinor += amount;
      liveOrders += 1;
    }
  }

  return {
    billedMinor,
    unbilledMinor,
    totalMinor: billedMinor + unbilledMinor,
    openInvoices,
    liveOrders,
  };
}

/* ------------------------------------------------------------------ */
/* THE CHECK                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ONE GENUINE TWO-SOURCE CHECK AVAILABLE HERE. See the header.
 *
 * Report side: what the credit board would print for the billed half,
 * built from `sales_invoices.received_minor`.
 * Ledger side: the same set of invoices with their receipts re-derived
 * from `customer_receipt_allocations`.
 *
 * Both sides subtract from the same `Σ totalMinor`, which is fine and is
 * not a shared-source fault: the invoice TOTAL is not the figure under
 * suspicion. What is under suspicion is whether the money we think has
 * arrived actually has, and the two sides answer that from two tables.
 *
 * ⚠️ `ledgerConfigured` IS FALSE WHEN THE CUSTOMER HAS NO OPEN INVOICE
 * AT ALL, and that is decided from the COUNT, never from the amount. A
 * gate that inferred "nothing to check" from `0n === 0n` would report a
 * green tick over a customer whose invoices all happen to net to zero.
 */
export function reconcileCreditPosition(args: {
  companyLabel: string;
  invoices: readonly InvoiceExposureFact[];
  exposure: CreditExposure;
}): Reconciliation {
  const { companyLabel, invoices, exposure } = args;

  let countedInvoices = 0;
  let totalMinor = 0n;
  let receivedFromColumn = 0n;
  let receivedFromAllocations = 0n;

  for (const inv of invoices) {
    if (INVOICE_EXCLUDED_STATUSES.includes(inv.status)) continue;
    countedInvoices += 1;
    totalMinor += inv.totalMinor;
    receivedFromColumn += inv.receivedMinor;
    receivedFromAllocations += inv.allocatedMinor;
  }

  const floorAtZero = (v: bigint) => (v > 0n ? v : 0n);

  const checks: ReconciliationCheckInput[] = [
    {
      id: "credit-billed-outstanding",
      claim:
        "What this customer still owes on issued tax invoices is the same whether " +
        "it is read off the invoices themselves or rebuilt from the receipts " +
        "allocated against them.",
      report: {
        label: "the credit board's billed exposure",
        source: "sales_invoices.received_minor",
        amountMinor: floorAtZero(totalMinor - receivedFromColumn),
      },
      ledger: {
        label: "receipts allocated to those invoices",
        source: "customer_receipt_allocations",
        amountMinor: floorAtZero(totalMinor - receivedFromAllocations),
      },
      /**
       * ⭐ EXACT, AND THE CLAIM IS DEFENSIBLE: both sides are sums of
       * `bigint` paise with no division anywhere between them. Nothing
       * here pro-rates, apportions or accrues.
       */
      toleranceMinor: EXACT,
    },
  ];

  const notes: string[] = [EXPOSURE_SCOPE_NOTE];

  /**
   * 🔴 THE UNVERIFIED HALF, SAID OUT LOUD EVERY TIME IT IS NON-ZERO.
   *
   * A reader who sees "reconciled" over a total that is 80% unbilled
   * commitment has been told something untrue by omission. The note is
   * emitted in the reconciled state as well as the breached one —
   * `reconcile()` carries notes through both — precisely because that is
   * the state in which it is most likely to be misread.
   */
  if (exposure.unbilledMinor > 0n) {
    notes.push(
      "The committed-but-not-yet-invoiced part of this exposure has no second " +
        "source to check it against: nothing outside the order book records an " +
        "order that has not become a document. It is included in the total and " +
        "it is not verified.",
    );
  }

  return reconcile({
    subject: `Credit position — ${companyLabel}`,
    ledgerConfigured: countedInvoices > 0,
    notes,
    checks,
  });
}

/* ------------------------------------------------------------------ */
/* HEADROOM                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ NULL = UNLIMITED. 0 = BLOCKED. The rule from 0048, restated because
 * this is a second place that has to get it right.
 */
export type CreditCeiling = {
  creditLimitMinor: bigint | null;
};

export type CreditHeadroom = {
  exposure: CreditExposure;
  reconciliation: Reconciliation;
  /**
   * 🔴 STRUCTURALLY ABSENT WHEN THE RECONCILIATION BREACHES, not present
   * behind a boolean. A screen that ignored the gate would fail to
   * compile rather than quietly print an unverified ceiling — the same
   * shape `getAgeingReport` uses, and chosen for the same reason: the
   * rule has to survive the screens nobody has written yet.
   */
  figures:
    | {
        limitMinor: bigint | null;
        /** limit − exposure. Negative = over. NULL when there is no limit. */
        headroomMinor: bigint | null;
        /** True when a ceiling exists and the customer is past it. */
        overLimit: boolean;
      }
    | null;
};

export function creditHeadroom(args: {
  companyLabel: string;
  ceiling: CreditCeiling;
  invoices: readonly InvoiceExposureFact[];
  orders: readonly OrderCommitmentFact[];
}): CreditHeadroom {
  const exposure = creditExposure({ invoices: args.invoices, orders: args.orders });
  const reconciliation = reconcileCreditPosition({
    companyLabel: args.companyLabel,
    invoices: args.invoices,
    exposure,
  });

  if (!reconciliation.renderable) {
    return { exposure, reconciliation, figures: null };
  }

  const limit = args.ceiling.creditLimitMinor;
  if (limit === null) {
    return {
      exposure,
      reconciliation,
      figures: { limitMinor: null, headroomMinor: null, overLimit: false },
    };
  }

  const headroomMinor = limit - exposure.totalMinor;
  return {
    exposure,
    reconciliation,
    figures: { limitMinor: limit, headroomMinor, overLimit: headroomMinor < 0n },
  };
}
