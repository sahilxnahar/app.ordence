import "server-only";

/**
 * Ordence — ⭐ Posting sales documents into the double-entry ledger
 * Version: v0.99.0-alpha
 *
 * ⚠️ `import "server-only"` AND EVERY FUNCTION TAKES A `tx`. Both follow
 * from the same rule: these are not actions. A function taking a
 * transaction cannot be a browser-reachable RPC endpoint, and the posting
 * MUST share the caller's transaction — an invoice that is issued and a
 * journal that records it have to commit or fail together, or the books
 * disagree with the documents at exactly the moment something crashes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 POSTING NEVER BLOCKS ISSUING, AND IS NEVER SILENT
 * ══════════════════════════════════════════════════════════════════════
 * A tenant who has not mapped their chart of accounts cannot be stopped
 * from invoicing — that would break the product for everyone the day this
 * shipped. But an invoice quietly missing from the books is the failure
 * this whole phase exists to end.
 *
 * So the middle path, which is what real accounting systems do:
 *
 *   • posting is ATTEMPTED at issue, inside the same transaction
 *   • if a role is unmapped it is SKIPPED, with the reason recorded
 *   • the document stays in an explicit, visible BACKLOG
 *   • posting it later is safe, because it is idempotent
 *
 * ⚠️ THE BACKLOG IS DERIVED, NOT STORED. "Issued, with no `SALES:`
 * transaction against it" is the definition — so it cannot drift out of
 * step with reality the way a status column does, and no migration is
 * needed to correct one.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { transactions, journalEntries, salesPostingAccounts } from "@/db/schema/accounting";
import { formatMoneyPlain } from "@/lib/billing/money";
import {
  buildDemandPosting,
  buildBookingReceiptPosting,
  buildPossessionPosting,
  buildCancellationPosting,
  buildRefundPaymentPosting,
  buildBrokeragePosting,
  buildPartnerPaymentPosting,
  buildMeteringPosting,
  meteringRolesUsed,
  propertyRolesUsed,
  type PropertyLeg,
  buildRaBillPosting,
  constructionRolesUsed,
  buildPurchasePosting,
  buildVendorPaymentPosting,
  buildRcmPosting,
  purchaseRolesUsed,
  type PurchaseLeg,
  type PurchaseLineFacts,
  type PurchasePostingRole,
  buildInvoicePosting,
  buildCreditNotePosting,
  buildReceiptPosting,
  rolesUsed,
  type PostingLeg,
  type PostingRole,
  type SalesTaxBreakdown,
  buildPayrollPosting,
  payrollRolesUsed,
  type PayrollLeg,
  type PayrollPostingFacts,
  type PayrollPostingRole,
  buildReturnSetoffPosting,
  returnRolesUsed,
  type ReturnLeg,
  type ReturnPostingFacts,
  type ReturnPostingRole,
} from "@/lib/accounting/sales-posting";

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * ⭐ THE IDEMPOTENCY KEY, AND IT IS ALSO READABLE.
 *
 * ⚠️ IT IS NOT A HASH. Somebody looking at a trial balance and asking
 * "where did this come from" can paste the uuid straight into a URL. A
 * digest would be equally unique and would answer nothing.
 *
 * The database enforces uniqueness on this prefix — see `0051`. The check
 * below is a courtesy that produces a clear outcome; the index is what
 * makes two people pressing "post the backlog" at once safe.
 */
export type SalesKeyKind =
    | "invoice"
    | "credit_note"
    | "receipt"
    | "purchase"
    | "ra_bill"
    | "demand"
    | "booking_receipt"
    | "possession"
    /** ⭐ v1.11.0 — the event tax is deducted on. */
    | "vendor_payment"
    /**
     * ⭐ v1.18.0 — the stock count.
     *
     * ⚠️ IT GETS ITS OWN TAG RATHER THAN FALLING THROUGH TO THE DEFAULT.
     * The chain below ends in `"RCP"`, so any unlisted kind silently
     * becomes a receipt key. Two different documents whose keys claim
     * to be the same kind is a trail that lies to whoever follows it.
     */
    | "stock_count"
    /**
     * ⭐ v1.23.0 — the payroll run.
     *
     * ⚠️ ONE KEY PER RUN, NOT PER PAYSLIP. The journal is one balanced
     * entry for the whole wage bill; five hundred payslips producing
     * five hundred transactions would make the trial balance unreadable
     * and would not tell anybody anything the run total does not.
     */
    | "payroll"
    /**
     * ⭐ v1.24.0 — the monthly return set-off.
     *
     * ⚠️ ONE KEY PER RETURN. The journal clears a month of output tax
     * against a month of credit; per-invoice keys would be a thousand
     * transactions saying the same thing.
     */
    | "gst_return"
    /**
     * ⭐ v1.25.0-alpha — the four real-estate events that close the
     * module. Each is its own kind rather than sharing `possession`'s,
     * because the key is what makes a posting idempotent: a cancellation
     * and the refund that follows it are separate decisions on separate
     * dates, and one key covering both would silently swallow the second.
     */
    | "cancellation"
    | "buyer_refund"
    | "brokerage"
    | "partner_payment"
  /** ⭐ v1.28.0-alpha — a finalised meter billing period. */
  | "meter_period";

export function salesTransactionKey(kind: SalesKeyKind, documentId: string): string {
  const tag = SALES_KEY_TAGS[kind];
  return `SALES:${tag}:${documentId}`;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A MAP, NOT A TERNARY CHAIN — AND THE CHANGE IS THE FIX
 * ══════════════════════════════════════════════════════════════════════
 * This was fifteen nested ternaries ending in `: "RCP"`. The comment on
 * `stock_count` above warned, in these words:
 *
 *     "IT GETS ITS OWN TAG RATHER THAN FALLING THROUGH TO THE DEFAULT.
 *      The chain below ends in `"RCP"`, so any unlisted kind silently
 *      becomes a receipt key. Two different documents whose keys claim
 *      to be the same kind is a trail that lies to whoever follows it."
 *
 * ⚠️ AND THEN IT HAPPENED. `vendor_payment` was added to the union in
 * v1.11.0 and never added to the chain, so every vendor payment posted
 * since has carried `SALES:RCP:<id>` — the CUSTOMER RECEIPT tag. Money
 * leaving the company, keyed as money arriving.
 *
 * Nothing was corrupted: the document id is a uuid, so a payment and a
 * receipt can never collide. What is wrong is the AUDIT TRAIL. Anybody
 * classifying entries by their transaction number — which is the only
 * thing the number is FOR — reads a vendor payment as a receipt, and the
 * close-readiness check built in this version reads it that way too.
 *
 * ⭐ SO THE STRUCTURE CHANGES, NOT JUST THE ENTRY. A `Record` keyed on
 *   the union makes TypeScript REFUSE TO COMPILE when a kind is added
 *   without a tag. The comment asked for that and could not enforce it;
 *   the compiler can, and now does.
 */
const SALES_KEY_TAGS: Record<SalesKeyKind, string> = {
  invoice: "INV",
  credit_note: "CN",
  receipt: "RCP",
  purchase: "PI",
  ra_bill: "RAB",
  demand: "DMD",
  booking_receipt: "BRC",
  possession: "POS",
  /** 🔴 Was silently "RCP" from v1.11.0 until v1.27.0-alpha. */
  vendor_payment: "VPY",
  stock_count: "SCNT",
  payroll: "PAY",
  gst_return: "R3B",
  cancellation: "CNL",
  buyer_refund: "RFD",
  brokerage: "BRK",
  partner_payment: "PPY",
  meter_period: "MTR",
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE KEY IS THE IDEMPOTENCY GUARD, SO CHANGING A TAG IS A
 *        DOUBLE-POSTING HAZARD
 * ══════════════════════════════════════════════════════════════════════
 * Every writer below asks "does a transaction with this key already
 * exist" before it posts. A vendor payment posted last month carries
 * `SALES:RCP:<id>`. The moment the tag becomes `VPY`, that check looks
 * for `SALES:VPY:<id>`, does not find it, and POSTS THE JOURNAL AGAIN.
 *
 * ⚠️ AND IT WOULD LOOK LIKE A SUCCESS. The second entry balances, the
 * bank is credited twice, and the only symptom is a reconciliation that
 * is out by exactly one payment — found weeks later, by hand.
 *
 * ⭐ SO THE CHECK ASKS FOR EVERY KEY THIS DOCUMENT COULD EVER HAVE HAD,
 *   and new writes use the current one. No backfill, no migration, and
 *   nothing to run in Neon: legacy keys simply age out as the documents
 *   they belong to stop being re-posted.
 *
 * ⚠️ AN ENTRY HERE IS PERMANENT. Removing one re-opens the hazard for
 * every document posted before the rename, however long ago.
 */
const LEGACY_KEY_TAGS: Partial<Record<SalesKeyKind, readonly string[]>> = {
  vendor_payment: ["RCP"],
};

/**
 * Every key a document of this kind could carry — current first.
 *
 * ⚠️ USED BY THE "ALREADY POSTED" CHECK, NEVER BY THE WRITE. A new
 * posting always gets the current key; only the LOOKUP is generous.
 */
export function salesTransactionKeyCandidates(
  kind: SalesKeyKind,
  documentId: string,
): string[] {
  const legacy = LEGACY_KEY_TAGS[kind] ?? [];
  return [
    `SALES:${SALES_KEY_TAGS[kind]}:${documentId}`,
    ...legacy.map((tag) => `SALES:${tag}:${documentId}`),
  ];
}

export type PostOutcome =
  | { posted: true; transactionId: string }
  | { posted: false; reason: "already_posted" }
  | { posted: false; reason: "unmapped_roles"; missing: PostingRole[] }
  /**
   * ⭐ ADDED IN v1.18.0 FOR THE STOCK COUNT.
   *
   * ⚠️ A count that found no difference is a SUCCESSFUL count, not a
   * failure, and it has nothing to post. Folding it into
   * `already_posted` would tell the person their clean count had been
   * done before, which is both untrue and alarming.
   */
  | { posted: false; reason: "nothing_to_post" }
  /**
   * ⭐ ADDED IN v1.21.0. The document belongs in a month that has been
   * closed. Reported as its own outcome rather than as a failure,
   * because it is a policy answer and not a fault: the remedy is to
   * reopen the period deliberately or to date the document correctly.
   */
  | { posted: false; reason: "period_closed"; period: string };

/** The tenant's role → ledger map. */
async function loadRoleMap(tx: Tx, tenantId: string): Promise<Map<PostingRole, string>> {
  const rows = await tx
    .select({ role: salesPostingAccounts.role, ledgerId: salesPostingAccounts.ledgerId })
    .from(salesPostingAccounts)
    .where(eq(salesPostingAccounts.tenantId, tenantId));

  return new Map(rows.map((r) => [r.role as PostingRole, r.ledgerId]));
}

/**
 * Write one balanced transaction, or explain why not.
 *
 * ⚠️ IT REFUSES THE WHOLE POSTING WHEN ANY ROLE IS UNMAPPED, never a
 * partial one. `server/tally/exporter.ts` refuses a whole batch for the
 * same reason and states it better than I can: a partial result means the
 * trial balance no longer matches, and finding out what was left out
 * means comparing two registers line by line.
 *
 * ⚠️ AND A HALF-POSTED TRANSACTION WOULD NOT SURVIVE COMMIT ANYWAY —
 * the deferred constraint trigger from Phase 4 refuses anything that does
 * not balance. Skipping cleanly is the difference between "not yet
 * posted" and "issuing the invoice failed for no stated reason".
 */
async function writePosting(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    legs: readonly PostingLeg[];
    key: string;
    description: string;
    transactionDate: string;
    /**
     * ⚠️ REUSES THE EXISTING ENUM ON PURPOSE. `classifyVoucherType()`
     * already maps 'invoice' + a debtor leg to a Tally SALES voucher,
     * 'receipt' to a receipt, and 'adjustment' with a credited debtor to
     * a CREDIT NOTE. Adding enum members to describe what the system
     * already describes correctly would be a migration in service of
     * nothing.
     */
    referenceType: "invoice" | "receipt" | "adjustment";
    referenceId: string;
    counterpartyId: string | null;
    counterpartyName: string | null;
  },
): Promise<PostOutcome> {
  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, args.tenantId),
        eq(transactions.transactionNumber, args.key),
      ),
    )
    .limit(1);

  if (existing) return { posted: false, reason: "already_posted" };

  /**
   * 🔴🔴 THE PERIOD LOCK, CHECKED HERE AND ENFORCED BY 0072'S TRIGGER.
   *
   * ⚠️ `isDateLocked` HAS EXISTED SINCE 0005 AND NOTHING HAS EVER CALLED
   * IT. A month could be closed on screen and postings kept landing in
   * it, silently, for as long as anybody kept posting. That is worse
   * than having no period close at all, because closing a period is a
   * statement made to an auditor that the numbers are final.
   *
   * ⭐ THIS CHECK PRODUCES A SENTENCE. The trigger is what makes it true
   * for the import, the support fix and the API route that have not been
   * written yet.
   */
  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.transactionDate);
  if (lockedIn) {
    return { posted: false, reason: "period_closed", period: lockedIn };
  }

  const roleMap = await loadRoleMap(tx, args.tenantId);
  const missing = rolesUsed(args.legs).filter((r) => !roleMap.has(r));
  if (missing.length > 0) return { posted: false, reason: "unmapped_roles", missing };

  /**
   * ⚠️ `totalAmount` IS THE DEBIT SIDE, NOT THE SUM OF EVERY LEG. Adding
   * both sides would report an invoice of ₹1,180 as ₹2,360 — a figure
   * that is exactly twice the truth and looks entirely plausible on a
   * list of transactions.
   */
  const debitTotal = args.legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: args.key,
      description: args.description,
      transactionDate: args.transactionDate,
      status: "posted",
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The journal entry could not be created.");

  await tx.insert(journalEntries).values(
    args.legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role) as string,
      entryType: l.entryType,
      /**
       * ⚠️ `numeric(18,2)` FROM `bigint` PAISE BY STRING, never by
       * dividing. `Number(118000) / 100` is fine and `Number(n) / 100`
       * for a large n is not, and the failure is a rounded rupee in a
       * ledger that is supposed to balance to the paisa.
       */
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      counterpartyType: args.counterpartyId ? ("company" as const) : null,
      counterpartyId: args.counterpartyId,
      counterpartyName: args.counterpartyName,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

/* ------------------------------------------------------------------ */

export async function postSalesInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    companyId: string | null;
    customerName: string | null;
    tax: SalesTaxBreakdown;
  },
): Promise<PostOutcome> {
  return writePosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildInvoicePosting({
      tax: args.tax,
      invoiceNumber: args.invoiceNumber,
      customerName: args.customerName,
    }),
    key: salesTransactionKey("invoice", args.invoiceId),
    description: `Sales invoice ${args.invoiceNumber}`,
    /**
     * ⚠️ THE DOCUMENT'S DATE, NOT TODAY. An invoice dated 31 March posted
     * on 2 April belongs in March — putting it in April moves revenue
     * across a financial year, which is the one date error that changes
     * a tax computation.
     */
    transactionDate: args.invoiceDate,
    referenceType: "invoice",
    referenceId: args.invoiceId,
    counterpartyId: args.companyId,
    counterpartyName: args.customerName,
  });
}

export async function postSalesCreditNote(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    creditNoteId: string;
    creditNoteNumber: string;
    noteDate: string;
    invoiceNumber: string;
    companyId: string | null;
    customerName: string | null;
    tax: SalesTaxBreakdown;
  },
): Promise<PostOutcome> {
  return writePosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildCreditNotePosting({
      tax: args.tax,
      creditNoteNumber: args.creditNoteNumber,
      invoiceNumber: args.invoiceNumber,
      customerName: args.customerName,
    }),
    key: salesTransactionKey("credit_note", args.creditNoteId),
    description: `Credit note ${args.creditNoteNumber} against ${args.invoiceNumber}`,
    transactionDate: args.noteDate,
    referenceType: "adjustment",
    referenceId: args.creditNoteId,
    counterpartyId: args.companyId,
    counterpartyName: args.customerName,
  });
}

export async function postCustomerReceipt(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    receiptId: string;
    receiptNumber: string;
    receivedOn: string;
    companyId: string | null;
    customerName: string | null;
    cashMinor: bigint;
    tdsMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildReceiptPosting({
      cashMinor: args.cashMinor,
      tdsMinor: args.tdsMinor,
      receiptNumber: args.receiptNumber,
      customerName: args.customerName,
    }),
    key: salesTransactionKey("receipt", args.receiptId),
    description: `Customer receipt ${args.receiptNumber}`,
    transactionDate: args.receivedOn,
    referenceType: "receipt",
    referenceId: args.receiptId,
    counterpartyId: args.companyId,
    counterpartyName: args.customerName,
  });
}

/**
 * Which of these documents already have a `SALES:` transaction.
 *
 * ⚠️ ONE QUERY FOR THE WHOLE SET, not one per document. The backlog
 * screen lists hundreds; asking per row is how a page that works on a
 * demo tenant times out on a real one.
 */
export async function postedKeys(
  tx: Tx,
  tenantId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx
    .select({ transactionNumber: transactions.transactionNumber })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, tenantId),
        inArray(transactions.transactionNumber, [...keys]),
      ),
    );
  return new Set(rows.map((r) => r.transactionNumber).filter((n): n is string => n !== null));
}

/* ================================================================== */
/* ⭐ THE PURCHASE SIDE — Phase 59                                      */
/* ================================================================== */

/**
 * ⚠️ THE SAME MAP TABLE, A DIFFERENT SET OF ROLES. `sales_posting_accounts`
 * is keyed by an opaque `role` varchar precisely so the purchase roles are
 * rows rather than a second table with a second RLS policy to keep in step.
 */
async function loadPurchaseRoleMap(
  tx: Tx,
  tenantId: string,
): Promise<Map<PurchasePostingRole, string>> {
  const rows = await tx
    .select({ role: salesPostingAccounts.role, ledgerId: salesPostingAccounts.ledgerId })
    .from(salesPostingAccounts)
    .where(eq(salesPostingAccounts.tenantId, tenantId));
  return new Map(rows.map((r) => [r.role as PurchasePostingRole, r.ledgerId]));
}

export type PurchasePostOutcome =
  | { posted: true; transactionIds: string[] }
  | { posted: false; reason: "already_posted" }
  | { posted: false; reason: "unmapped_roles"; missing: PurchasePostingRole[] };

/**
 * ⭐ A VENDOR BILL, AND — WHEN IT CARRIES REVERSE CHARGE — A SECOND
 *    TRANSACTION BESIDE IT.
 *
 * 🔴 TWO TRANSACTIONS, NOT ONE COMBINED ONE. The bill is between us and
 *    the vendor; the reverse-charge tax is between us and the Government
 *    and the vendor is not a party to it. Merging them produces a single
 *    voucher naming the vendor for money they will never receive, and it
 *    is the shape GSTR-2B reconciliation cannot match.
 *
 * ⚠️ THEY SHARE ONE TRANSACTION SCOPE. Either both land or neither does —
 * an RCM liability recorded without its bill, or a bill without its RCM
 * liability, is worse than nothing.
 */
export async function postPurchaseInvoice(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    invoiceNumber: string;
    invoiceDate: string;
    vendorId: string | null;
    vendorName: string | null;
    lines: readonly PurchaseLineFacts[];
    roundOffMinor: bigint;
    totalMinor: bigint;
    rcmTaxMinor: bigint;
    rcmSection: string | null;
  },
): Promise<PurchasePostOutcome> {
  const key = salesTransactionKey("purchase", args.invoiceId);
  const rcmKey = `${key}:RCM`;

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.tenantId, args.tenantId), eq(transactions.transactionNumber, key)),
    )
    .limit(1);

  if (existing) return { posted: false, reason: "already_posted" };

  const billLegs = buildPurchasePosting({
    lines: args.lines,
    roundOffMinor: args.roundOffMinor,
    totalMinor: args.totalMinor,
    invoiceNumber: args.invoiceNumber,
    vendorName: args.vendorName,
  });
  const rcmLegs = buildRcmPosting({
    rcmTaxMinor: args.rcmTaxMinor,
    invoiceNumber: args.invoiceNumber,
    rcmSection: args.rcmSection,
    vendorName: args.vendorName,
  });

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  /**
   * ⚠️ BOTH POSTINGS ARE CHECKED BEFORE EITHER IS WRITTEN. Writing the
   * bill and then discovering the RCM roles are unmapped would leave the
   * liability off the books with the bill already in them — and the
   * idempotency key would stop anyone ever retrying it.
   */
  const missing = [
    ...purchaseRolesUsed(billLegs),
    ...purchaseRolesUsed(rcmLegs),
  ].filter((r, i, all) => all.indexOf(r) === i && !roleMap.has(r));
  if (missing.length > 0) return { posted: false, reason: "unmapped_roles", missing };

  const written: string[] = [];

  for (const [legs, txKey, description] of [
    [billLegs, key, `Purchase invoice ${args.invoiceNumber}`],
    ...(rcmLegs.length > 0
      ? ([[rcmLegs, rcmKey, `Reverse charge on ${args.invoiceNumber}`]] as const)
      : []),
  ] as readonly [readonly PurchaseLeg[], string, string][]) {
    const debitTotal = legs
      .filter((l) => l.entryType === "debit")
      .reduce((sum, l) => sum + l.amountMinor, 0n);

    const [txn] = await tx
      .insert(transactions)
      .values({
        tenantId: args.tenantId,
        transactionNumber: txKey,
        description,
        /** ⚠️ The bill's date, never today — a March bill belongs in March. */
        transactionDate: args.invoiceDate,
        status: "posted",
        /**
         * ⚠️ 'invoice' + a CREDITOR leg is what `classifyVoucherType()`
         * turns into a Tally PURCHASE voucher. The same enum value serves
         * sales because the classifier looks at the legs, not the label.
         */
        referenceType: "invoice",
        referenceId: args.invoiceId,
        currency: "INR",
        totalAmount: formatMoneyPlain(debitTotal, "INR"),
        createdBy: args.userId,
        postedAt: new Date(),
      })
      .returning({ id: transactions.id });

    if (!txn) throw new Error("The journal entry could not be created.");

    await tx.insert(journalEntries).values(
      legs.map((l) => ({
        tenantId: args.tenantId,
        transactionId: txn.id,
        ledgerId: roleMap.get(l.role) as string,
        entryType: l.entryType,
        amount: formatMoneyPlain(l.amountMinor, "INR"),
        description: l.description,
        referenceType: "invoice" as const,
        referenceId: args.invoiceId,
        counterpartyType: args.vendorId ? ("company" as const) : null,
        counterpartyId: args.vendorId,
        counterpartyName: args.vendorName,
      })),
    );

    written.push(txn.id);
  }

  return { posted: true, transactionIds: written };
}

/* ================================================================== */
/* ⭐ CONSTRUCTION — Phase 60                                           */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE PAYMENT, WHICH IS THE EVENT THE TDS ENGINE HAS BEEN WAITING
 *      FOR SINCE 0025.
 *
 * 🔴 THE LIABILITY IS CLEARED IN FULL, NOT NET OF THE WITHHOLDING.
 *
 *     Dr  Sundry Creditors     gross
 *         Cr  Bank                       net
 *         Cr  TDS payable                withheld
 *
 * ⚠️ Debiting only the net is the common error, and it leaves the
 * withheld amount sitting on the vendor's ledger as if it were still
 * owed to them. On every bill. All year. Until somebody clears the
 * balance as a "reconciliation difference", which is the firm writing
 * off its own tax deposits.
 */
export async function postVendorPayment(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    paymentId: string;
    paymentNumber: string;
    paymentDate: string;
    vendorId: string | null;
    vendorName: string | null;
    grossMinor: bigint;
    tdsMinor: bigint;
    msmeInterestMinor: bigint;
    roundOffMinor: bigint;
    netMinor: bigint;
    tdsSection: string | null;
  },
): Promise<PurchasePostOutcome> {
  const key = salesTransactionKey("vendor_payment", args.paymentId);

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 EVERY KEY THIS PAYMENT COULD EVER HAVE HAD — v1.27.0-alpha
   * ══════════════════════════════════════════════════════════════════
   * The tag for a vendor payment changed from `RCP` to `VPY` in this
   * version, because it had been silently sharing the customer-receipt
   * tag since v1.11.0.
   *
   * ⚠️ AND A TAG IS AN IDEMPOTENCY KEY. Checking only the NEW key would
   * find nothing for every payment posted before the rename, post the
   * journal a second time, credit the bank twice and report success —
   * with the only symptom a reconciliation out by exactly one payment,
   * found weeks later by hand.
   *
   * The write below still uses the current key. Only the lookup is
   * generous, and it has to stay generous permanently.
   */
  const candidates = salesTransactionKeyCandidates("vendor_payment", args.paymentId);

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, args.tenantId),
        inArray(transactions.transactionNumber, candidates),
      ),
    )
    .limit(1);

  /**
   * ⭐ IDEMPOTENT. A payment run that fails halfway and is retried must
   * not post the same payment twice, and the transaction number is the
   * only thing that can guarantee it.
   */
  if (existing) return { posted: false, reason: "already_posted" };

  const legs = buildVendorPaymentPosting({
    grossMinor: args.grossMinor,
    tdsMinor: args.tdsMinor,
    msmeInterestMinor: args.msmeInterestMinor,
    roundOffMinor: args.roundOffMinor,
    netMinor: args.netMinor,
    paymentNumber: args.paymentNumber,
    vendorName: args.vendorName,
    tdsSection: args.tdsSection,
  });

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  const missing = purchaseRolesUsed(legs).filter((r) => !roleMap.has(r));
  /**
   * 🔴 CHECKED BEFORE ANYTHING IS WRITTEN. Posting the debit and then
   * finding the TDS role unmapped would clear the vendor's balance with
   * the withholding nowhere, and the idempotency key would stop anybody
   * ever retrying it.
   */
  if (missing.length > 0) return { posted: false, reason: "unmapped_roles", missing };

  const debitTotal = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: key,
      description: `Vendor payment ${args.paymentNumber}`,
      /** ⚠️ The payment's date, never today. */
      transactionDate: args.paymentDate,
      status: "posted",
      /**
       * ⚠️ `payment` and not a new enum value. Adding one would mean an
       * ALTER TYPE on a shared enum for no gain: the transaction number
       * already carries the kind and the reference id carries the row.
       */
      referenceType: "payment",
      referenceId: args.paymentId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The journal entry could not be created.");

  await tx.insert(journalEntries).values(
    legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role) as string,
      entryType: l.entryType,
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: "payment" as const,
      referenceId: args.paymentId,
      counterpartyType: args.vendorId ? ("company" as const) : null,
      counterpartyId: args.vendorId,
    })),
  );

  return { posted: true, transactionIds: [txn.id] };
}

export async function postRaBill(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    billId: string;
    billNumber: string;
    billDate: string;
    vendorId: string | null;
    contractorName: string | null;
    grossValueMinor: bigint;
    retentionAmountMinor: bigint;
    tdsAmountMinor: bigint;
    cessAmountMinor: bigint;
    otherDeductionsMinor: bigint;
    netPayableMinor: bigint;
  },
): Promise<PostOutcome> {
  const key = salesTransactionKey("ra_bill", args.billId);

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.tenantId, args.tenantId), eq(transactions.transactionNumber, key)),
    )
    .limit(1);
  if (existing) return { posted: false, reason: "already_posted" };

  const legs = buildRaBillPosting({
    grossValueMinor: args.grossValueMinor,
    retentionAmountMinor: args.retentionAmountMinor,
    tdsAmountMinor: args.tdsAmountMinor,
    cessAmountMinor: args.cessAmountMinor,
    otherDeductionsMinor: args.otherDeductionsMinor,
    netPayableMinor: args.netPayableMinor,
    billNumber: args.billNumber,
    contractorName: args.contractorName,
  });

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  const missing = constructionRolesUsed(legs).filter((r) => !roleMap.has(r as never));
  if (missing.length > 0) {
    return {
      posted: false,
      reason: "unmapped_roles",
      missing: missing as unknown as PostingRole[],
    };
  }

  const debitTotal = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: key,
      description: `RA bill ${args.billNumber}`,
      /** ⚠️ The certification date — when the work was proved to exist. */
      transactionDate: args.billDate,
      status: "posted",
      /**
       * ⚠️ 'invoice' + a CREDITOR leg is a Tally PURCHASE voucher. An RA
       * bill IS a purchase of work, and `classifyVoucherType()` reads the
       * legs rather than the label — so it lands correctly without a new
       * enum member.
       */
      referenceType: "invoice",
      referenceId: args.billId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The journal entry could not be created.");

  await tx.insert(journalEntries).values(
    legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role as never) as string,
      entryType: l.entryType,
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: "invoice" as const,
      referenceId: args.billId,
      counterpartyType: args.vendorId ? ("company" as const) : null,
      counterpartyId: args.vendorId,
      counterpartyName: args.contractorName,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

/* ================================================================== */
/* ⭐ REAL ESTATE — Phase 61                                            */
/* ================================================================== */

/**
 * ⭐ THE COUNTERPARTY IS THE **BOOKING**, NOT A COMPANY.
 *
 * ⚠️ THIS SETTLES A QUESTION LEFT OPEN SINCE SESSION 2. `bookings` has a
 * `lead_id` and a `unit_id` and no `company_id`; the credit and sales
 * ledgers are company-shaped. I refused to force that join then and I am
 * refusing it again — inventing a company for every home buyer would
 * create thousands of shell records whose only purpose is to satisfy a
 * foreign key, and each one would then appear in the CRM as a business
 * relationship that does not exist.
 *
 * `journal_entries.counterparty_type` is a free varchar precisely so a
 * ledger entry can name what it actually refers to. So it names the
 * booking, carries the buyer's name for Tally's party ledger, and the
 * join is never made because it was never true.
 */
const BOOKING_COUNTERPARTY = "booking" as const;

/**
 * ⭐ AND THE CHANNEL PARTNER IS ITS OWN COUNTERPARTY KIND — v1.25.0-alpha.
 *
 * ⚠️ FOR THE SAME REASON, IN REVERSE. A broker is not a booking: they
 * earn across many of them, and the question their statement answers is
 * "what does this firm have outstanding", which a booking-shaped
 * counterparty cannot group. They are also not a `company` — the sales
 * ledger is company-shaped and `channel_partners` is a separate table
 * with its own KYC, RERA number and commission agreement.
 */
const PARTNER_COUNTERPARTY = "channel_partner" as const;

async function writePropertyPosting(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    legs: readonly PropertyLeg[];
    key: string;
    description: string;
    transactionDate: string;
    referenceType: "invoice" | "receipt" | "adjustment";
    referenceId: string;
    bookingId: string;
    buyerName: string | null;
    /**
     * ⚠️ OVERRIDE FOR BROKERAGE, WHICH IS COUNTERPARTIED TO THE PARTNER.
     * Defaulted rather than required so every existing caller keeps the
     * booking counterparty it already had.
     */
    counterpartyType?: string;
  },
): Promise<PostOutcome> {
  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, args.tenantId),
        eq(transactions.transactionNumber, args.key),
      ),
    )
    .limit(1);
  if (existing) return { posted: false, reason: "already_posted" };

  /**
   * 🔴🔴 A GAP FOUND WHILE BUILDING PAYROLL, IN v1.23.0.
   *
   * ⚠️ v1.21.0 ADDED THE PERIOD LOCK TO `writePosting` AND NOT TO THIS
   * ONE. The DATA was never at risk — 0073's trigger sits on
   * `transactions` and refuses the insert whichever writer attempts it.
   * What was wrong is what the operator SEES: `writePosting` returns a
   * sentence naming the closed month, and this path threw a raw
   * database exception at whoever raised a demand notice dated in it.
   *
   * ⭐ A CORRECT REFUSAL DELIVERED AS AN UNHANDLED ERROR IS READ AS A
   * BUG, and the response to a bug is to look for a way around it.
   */
  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.transactionDate);
  if (lockedIn) return { posted: false, reason: "period_closed", period: lockedIn };

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  const missing = propertyRolesUsed(args.legs).filter((r) => !roleMap.has(r as never));
  if (missing.length > 0) {
    return {
      posted: false,
      reason: "unmapped_roles",
      missing: missing as unknown as PostingRole[],
    };
  }

  const debitTotal = args.legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: args.key,
      description: args.description,
      transactionDate: args.transactionDate,
      status: "posted",
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The journal entry could not be created.");

  await tx.insert(journalEntries).values(
    args.legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role as never) as string,
      entryType: l.entryType,
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      counterpartyType: args.counterpartyType ?? BOOKING_COUNTERPARTY,
      counterpartyId: args.bookingId,
      counterpartyName: args.buyerName,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

export async function postDemandNotice(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    demandId: string;
    demandNumber: string;
    /** ⚠️ The DUE date is not the document date. This is the served date. */
    servedOn: string;
    bookingId: string;
    bookingReference: string;
    buyerName: string | null;
    principalMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    totalMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildDemandPosting({
      principalMinor: args.principalMinor,
      cgstMinor: args.cgstMinor,
      sgstMinor: args.sgstMinor,
      igstMinor: args.igstMinor,
      cessMinor: args.cessMinor,
      totalMinor: args.totalMinor,
      demandNumber: args.demandNumber,
      bookingReference: args.bookingReference,
      buyerName: args.buyerName,
    }),
    key: salesTransactionKey("demand", args.demandId),
    description: `Demand notice ${args.demandNumber}`,
    transactionDate: args.servedOn,
    referenceType: "invoice",
    referenceId: args.demandId,
    bookingId: args.bookingId,
    buyerName: args.buyerName,
  });
}

export async function postBookingReceipt(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    receiptId: string;
    receiptNumber: string;
    receivedOn: string;
    bookingId: string;
    bookingReference: string;
    buyerName: string | null;
    cashMinor: bigint;
    tdsMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildBookingReceiptPosting({
      cashMinor: args.cashMinor,
      tdsMinor: args.tdsMinor,
      receiptNumber: args.receiptNumber,
      bookingReference: args.bookingReference,
      buyerName: args.buyerName,
    }),
    key: salesTransactionKey("booking_receipt", args.receiptId),
    description: `Booking receipt ${args.receiptNumber}`,
    transactionDate: args.receivedOn,
    referenceType: "receipt",
    referenceId: args.receiptId,
    bookingId: args.bookingId,
    buyerName: args.buyerName,
  });
}

/**
 * ⭐ POSSESSION — the only place property revenue is recognised.
 *
 * ⚠️ IT IS ITS OWN ACTION AND ITS OWN TRANSACTION, deliberately. Handing
 * over a flat is a decision somebody makes on a date, not a side effect
 * of a payment clearing — and burying it inside a receipt would recognise
 * a project's revenue on whichever instalment happened to arrive last.
 */
export async function postPossession(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    bookingId: string;
    bookingReference: string;
    possessionDate: string;
    unitLabel: string | null;
    buyerName: string | null;
    advanceMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildPossessionPosting({
      advanceMinor: args.advanceMinor,
      bookingReference: args.bookingReference,
      unitLabel: args.unitLabel,
      buyerName: args.buyerName,
    }),
    key: salesTransactionKey("possession", args.bookingId),
    description: `Possession — booking ${args.bookingReference}`,
    transactionDate: args.possessionDate,
    referenceType: "adjustment",
    referenceId: args.bookingId,
    bookingId: args.bookingId,
    buyerName: args.buyerName,
  });
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ CANCELLATION AND BROKERAGE — v1.25.0-alpha                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE CANCELLATION. Closes every balance the booking carries.
 *
 * ⚠️ THE CALLER MUST HAVE RUN `cancellationProblem()` FIRST. This
 * function trusts its facts; the builder's balance assertion would catch
 * an imbalance but would report it as a ledger fault rather than as the
 * mistyped refund it usually is.
 */
export async function postCancellation(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    bookingId: string;
    bookingReference: string;
    cancelledOn: string;
    unitLabel: string | null;
    buyerName: string | null;
    advanceMinor: bigint;
    receivableMinor: bigint;
    forfeitMinor: bigint;
    refundMinor: bigint;
    reversedCgstMinor: bigint;
    reversedSgstMinor: bigint;
    reversedIgstMinor: bigint;
    irrecoverableTaxMinor: bigint;
    creditNoteNumber: string | null;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildCancellationPosting({
      advanceMinor: args.advanceMinor,
      receivableMinor: args.receivableMinor,
      forfeitMinor: args.forfeitMinor,
      refundMinor: args.refundMinor,
      reversedCgstMinor: args.reversedCgstMinor,
      reversedSgstMinor: args.reversedSgstMinor,
      reversedIgstMinor: args.reversedIgstMinor,
      irrecoverableTaxMinor: args.irrecoverableTaxMinor,
      bookingReference: args.bookingReference,
      unitLabel: args.unitLabel,
      buyerName: args.buyerName,
      creditNoteNumber: args.creditNoteNumber,
    }),
    key: salesTransactionKey("cancellation", args.bookingId),
    description: `Cancellation — booking ${args.bookingReference}`,
    transactionDate: args.cancelledOn,
    referenceType: "adjustment",
    referenceId: args.bookingId,
    bookingId: args.bookingId,
    buyerName: args.buyerName,
  });
}

/**
 * ⭐ THE REFUND LEAVING. A different date, and often a much later one.
 *
 * ⚠️ KEYED ON THE PAYMENT REFERENCE AND NOT ON THE BOOKING. A refund is
 * sometimes paid in two transfers, and a booking-keyed idempotency check
 * would accept the first and silently discard the second — leaving the
 * payable overstated and the bank understated by the same amount, which
 * reconciles to nothing.
 */
export async function postBuyerRefund(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    bookingId: string;
    bookingReference: string;
    buyerName: string | null;
    paidOn: string;
    paymentReference: string;
    amountMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildRefundPaymentPosting({
      amountMinor: args.amountMinor,
      bookingReference: args.bookingReference,
      buyerName: args.buyerName,
      paymentReference: args.paymentReference,
    }),
    key: salesTransactionKey("buyer_refund", `${args.bookingId}:${args.paymentReference}`),
    description: `Refund ${args.paymentReference} — booking ${args.bookingReference}`,
    transactionDate: args.paidOn,
    referenceType: "receipt",
    referenceId: args.bookingId,
    bookingId: args.bookingId,
    buyerName: args.buyerName,
  });
}

/**
 * ⭐ THE BROKERAGE BILL.
 *
 * ⚠️ COUNTERPARTIED TO THE PARTNER, NOT THE BOOKING, even though it
 * usually has a booking. "What does this firm have outstanding" is the
 * question a broker asks and a booking-shaped counterparty cannot group.
 */
export async function postBrokerage(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    commissionId: string;
    reference: string;
    creditedOn: string;
    partnerId: string;
    partnerName: string;
    bookingReference: string | null;
    grossMinor: bigint;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    itcEligible: boolean;
    tdsMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildBrokeragePosting({
      grossMinor: args.grossMinor,
      cgstMinor: args.cgstMinor,
      sgstMinor: args.sgstMinor,
      igstMinor: args.igstMinor,
      itcEligible: args.itcEligible,
      tdsMinor: args.tdsMinor,
      reference: args.reference,
      partnerName: args.partnerName,
      bookingReference: args.bookingReference,
    }),
    key: salesTransactionKey("brokerage", args.commissionId),
    description: `Brokerage ${args.reference} — ${args.partnerName}`,
    transactionDate: args.creditedOn,
    referenceType: "invoice",
    referenceId: args.commissionId,
    bookingId: args.partnerId,
    buyerName: args.partnerName,
    counterpartyType: PARTNER_COUNTERPARTY,
  });
}

/** ⭐ Paying the partner. Clears the payable and touches nothing else. */
export async function postPartnerPayment(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    commissionId: string;
    reference: string;
    paidOn: string;
    partnerId: string;
    partnerName: string;
    paymentReference: string;
    amountMinor: bigint;
  },
): Promise<PostOutcome> {
  return writePropertyPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildPartnerPaymentPosting({
      amountMinor: args.amountMinor,
      reference: args.reference,
      partnerName: args.partnerName,
    }),
    key: salesTransactionKey(
      "partner_payment",
      `${args.commissionId}:${args.paymentReference}`,
    ),
    description: `Partner payment ${args.paymentReference} — ${args.partnerName}`,
    transactionDate: args.paidOn,
    referenceType: "receipt",
    referenceId: args.commissionId,
    bookingId: args.partnerId,
    buyerName: args.partnerName,
    counterpartyType: PARTNER_COUNTERPARTY,
  });
}

/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ THE METER BILLING PERIOD — v1.28.0-alpha                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE LAST MODULE ON THE POSTING DEBT LIST.
 *
 * ⚠️ THE COUNTERPARTY IS THE CONSUMER CONTACT, not the meter. A meter is
 * a device; the debt is owed by a person, and a statement has to group
 * by them across however many meters they have.
 */
export async function postMeterPeriod(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    periodId: string;
    meterLabel: string;
    periodLabel: string;
    /** ⚠️ The period END. A bill belongs to the month it measured. */
    billedOn: string;
    consumerContactId: string | null;
    consumerName: string | null;
    energyChargeMinor: bigint;
    fixedChargeMinor: bigint;
    dutyMinor: bigint;
    exportCreditMinor: bigint;
    totalMinor: bigint;
  },
): Promise<PostOutcome> {
  const key = salesTransactionKey("meter_period", args.periodId);

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.tenantId, args.tenantId), eq(transactions.transactionNumber, key)),
    )
    .limit(1);
  if (existing) return { posted: false, reason: "already_posted" };

  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.billedOn);
  if (lockedIn) return { posted: false, reason: "period_closed", period: lockedIn };

  const legs = buildMeteringPosting({
    facts: {
      energyChargeMinor: args.energyChargeMinor,
      fixedChargeMinor: args.fixedChargeMinor,
      dutyMinor: args.dutyMinor,
      exportCreditMinor: args.exportCreditMinor,
      totalMinor: args.totalMinor,
    },
    meterLabel: args.meterLabel,
    periodLabel: args.periodLabel,
    consumerName: args.consumerName,
  });

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  const missing = meteringRolesUsed(legs).filter((r) => !roleMap.has(r as never));
  if (missing.length > 0) {
    return {
      posted: false,
      reason: "unmapped_roles",
      missing: missing as unknown as PostingRole[],
    };
  }

  const debitTotal = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: key,
      description: `Utility bill — meter ${args.meterLabel}, ${args.periodLabel}`,
      transactionDate: args.billedOn,
      status: "posted",
      referenceType: "invoice",
      referenceId: args.periodId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The journal entry could not be created.");

  await tx.insert(journalEntries).values(
    legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role as never) as string,
      entryType: l.entryType,
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: "invoice" as const,
      referenceId: args.periodId,
      counterpartyType: args.consumerContactId ? ("contact" as const) : null,
      counterpartyId: args.consumerContactId,
      counterpartyName: args.consumerName,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE STOCK COUNT — v1.18.0                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ A COUNT VARIANCE IS AN ECONOMIC EVENT AND HAS TO REACH THE
 * LEDGER.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ALTERNATIVE IS A STOCK FIGURE THAT DISAGREES WITH THE ACCOUNTS
 * ══════════════════════════════════════════════════════════════════════
 * A count that adjusts quantities without touching the books leaves the
 * balance sheet carrying stock the warehouse does not have. Nothing
 * reports it, because each system is internally consistent; the two
 * simply describe different businesses. It surfaces at year end, when
 * somebody has to explain a stock figure that no longer ties, and by
 * then nobody remembers which counts were posted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE NET GOES TO THE LEDGER. THE HALVES GO TO DIFFERENT ACCOUNTS.
 * ══════════════════════════════════════════════════════════════════════
 * The stock asset moves by the net, because that is what the stock is
 * actually worth now. But the other side splits: what was found credits
 * `inventory_variance_gain` and what was missing debits
 * `inventory_variance_loss`, so a count that found ₹4 lakh missing and
 * ₹4 lakh extra does not present itself as a quiet month.
 *
 * 🔴 IDEMPOTENT BY THE SAME KEY MECHANISM AS EVERYTHING ELSE HERE. The
 * partial unique index in 0070 is the real guard; this is the courtesy
 * that returns a clear outcome instead of a constraint violation.
 */
export async function postStockCount(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    countId: string;
    countNo: string;
    /** ⚠️ The date counting happened, never today. See the note above. */
    countedOn: string;
    /** Positive minor units. Stock found that the books did not have. */
    gainMinor: bigint;
    /** Positive minor units. Stock the books had and the shelf did not. */
    lossMinor: bigint;
  },
): Promise<PostOutcome> {
  const net = args.gainMinor - args.lossMinor;

  // ⚠️ A COUNT THAT FOUND NOTHING POSTS NOTHING. A journal of zero legs
  // is a row that means nothing and has to be filtered out of every
  // statement written from then on.
  if (args.gainMinor === 0n && args.lossMinor === 0n) {
    return { posted: false, reason: "nothing_to_post" };
  }

  const legs: PostingLeg[] = [];

  // ① The stock asset moves by the net, in whichever direction.
  if (net > 0n) {
    legs.push({
      role: "inventory_asset",
      entryType: "debit",
      amountMinor: net,
      description: `Stock count ${args.countNo}: net increase`,
    });
  } else if (net < 0n) {
    legs.push({
      role: "inventory_asset",
      entryType: "credit",
      amountMinor: -net,
      description: `Stock count ${args.countNo}: net decrease`,
    });
  }

  // ② 🔴 AND THE TWO HALVES GO SEPARATELY, EVEN THOUGH THE ARITHMETIC
  // WOULD WORK WITH ONE ACCOUNT. See the header.
  if (args.gainMinor > 0n) {
    legs.push({
      role: "inventory_variance_gain",
      entryType: "credit",
      amountMinor: args.gainMinor,
      description: `Stock count ${args.countNo}: found on the shelf`,
    });
  }
  if (args.lossMinor > 0n) {
    legs.push({
      role: "inventory_variance_loss",
      entryType: "debit",
      amountMinor: args.lossMinor,
      description: `Stock count ${args.countNo}: missing from the shelf`,
    });
  }

  return writePosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs,
    key: salesTransactionKey("stock_count", args.countId),
    description: `Stock count ${args.countNo}`,
    transactionDate: args.countedOn,
    referenceType: "adjustment",
    referenceId: args.countId,
    counterpartyId: null,
    counterpartyName: null,
  });
}

/* ================================================================== */
/* ⭐⭐⭐ PAYROLL — Batch 15, v1.23.0-alpha                             */
/* ================================================================== */

/**
 * ⭐ ONE JOURNAL FOR THE WHOLE RUN, NOT ONE PER PAYSLIP.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ FIVE HUNDRED PAYSLIPS WOULD MAKE FIVE HUNDRED TRANSACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * Every one of them balanced, every one of them correct, and a trial
 * balance nobody can read. Worse, the PF challan is settled once for the
 * whole month against one payable balance — split across five hundred
 * entries, reconciling it means summing five hundred rows and hoping.
 *
 * 🔴 THE PER-EMPLOYEE DETAIL LIVES ON THE PAYSLIP, WHICH IS WHERE
 * SOMEBODY ACTUALLY LOOKS FOR IT. The ledger records what the business
 * owes and to whom; it is not a personnel record and should not become
 * one.
 *
 * ⚠️ AND THE POSTING DATE IS THE PERIOD END, NEVER TODAY. A March
 * payroll posted on the 7th of April belongs in March, which is both
 * correct accounting and the thing that makes the period lock mean
 * something.
 */
export async function postPayrollRun(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    runId: string;
    runNo: string;
    /** ⚠️ The last day of the period. Not the day the run was approved. */
    periodEnd: string;
    periodLabel: string;
    facts: PayrollPostingFacts;
  },
): Promise<PostOutcome> {
  // ⚠️ A RUN WITH NOTHING IN IT POSTS NOTHING, and says so rather than
  // writing an empty journal that every statement afterwards has to
  // filter out.
  if (args.facts.grossMinor === 0n) {
    return { posted: false, reason: "nothing_to_post" };
  }

  const legs: PayrollLeg[] = buildPayrollPosting({
    facts: args.facts,
    periodLabel: args.periodLabel,
  });

  const key = salesTransactionKey("payroll", args.runId);

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.tenantId, args.tenantId), eq(transactions.transactionNumber, key)),
    )
    .limit(1);
  if (existing) return { posted: false, reason: "already_posted" };

  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.periodEnd);
  if (lockedIn) return { posted: false, reason: "period_closed", period: lockedIn };

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  const missing = payrollRolesUsed(legs).filter((r) => !roleMap.has(r as never));
  if (missing.length > 0) {
    // 🔴 THE WHOLE POSTING IS REFUSED, NEVER A PARTIAL ONE. A payroll
    // journal missing its ESI payable leg does not balance, and a
    // half-posted wage bill is worse than an unposted one because it
    // looks done.
    return {
      posted: false,
      reason: "unmapped_roles",
      missing: missing as unknown as PostingRole[],
    };
  }

  const debitTotal = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: key,
      description: `Payroll ${args.runNo} — ${args.periodLabel}`,
      transactionDate: args.periodEnd,
      status: "posted",
      // ⚠️ `adjustment` RATHER THAN A NEW ENUM MEMBER. Payroll is not a
      // sale, not a purchase and not a receipt, and `classifyVoucherType`
      // already maps an adjustment with no debtor leg to a Tally JOURNAL,
      // which is exactly what this is.
      referenceType: "adjustment",
      referenceId: args.runId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The payroll journal could not be created.");

  await tx.insert(journalEntries).values(
    legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role as never) as string,
      entryType: l.entryType,
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: "adjustment" as const,
      referenceId: args.runId,
      // ⚠️ NO COUNTERPARTY. A wage bill has five hundred counterparties
      // and naming one of them would be a lie; naming all of them is what
      // the payslips are for.
      counterpartyType: null,
      counterpartyId: null,
      counterpartyName: null,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

export type { PayrollPostingFacts, PayrollPostingRole };

/* ================================================================== */
/* ⭐⭐⭐ THE MONTHLY RETURN SET-OFF — Batch 16, v1.24.0-alpha          */
/* ================================================================== */

/**
 * ⭐ ONE JOURNAL PER RETURN, DATED THE LAST DAY OF THE TAX PERIOD.
 *
 * ⚠️ NOT THE FILING DATE. A July return filed on 20 August belongs in
 * July, or the July balance sheet shows a liability that the July return
 * says was settled — and those two documents are exactly the pair an
 * assessment compares.
 *
 * 🔴 THE AMOUNTS COME FROM THE SET-OFF, NEVER FROM THE ACCOUNT BALANCES.
 * Clearing "whatever is in the account" would sweep up credit this
 * return did not claim and output tax from a period already filed.
 */
export async function postReturnSetoff(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    returnId: string;
    taxPeriod: string;
    /** ⚠️ The last day of the period. Not the day it was filed. */
    periodEnd: string;
    facts: ReturnPostingFacts;
  },
): Promise<PostOutcome> {
  const legs: ReturnLeg[] = buildReturnSetoffPosting({
    facts: args.facts,
    periodLabel: args.taxPeriod,
  });

  // ⚠️ A RETURN WITH NOTHING TO CLEAR POSTS NOTHING. A nil month is a
  // successful month, not a failure, and an empty journal is a row every
  // statement afterwards has to filter out.
  if (legs.length === 0) return { posted: false, reason: "nothing_to_post" };

  const key = salesTransactionKey("gst_return", args.returnId);

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.tenantId, args.tenantId), eq(transactions.transactionNumber, key)),
    )
    .limit(1);
  if (existing) return { posted: false, reason: "already_posted" };

  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.periodEnd);
  if (lockedIn) return { posted: false, reason: "period_closed", period: lockedIn };

  const roleMap = await loadPurchaseRoleMap(tx, args.tenantId);
  const missing = returnRolesUsed(legs).filter((r) => !roleMap.has(r as never));
  if (missing.length > 0) {
    return {
      posted: false,
      reason: "unmapped_roles",
      missing: missing as unknown as PostingRole[],
    };
  }

  const debitTotal = legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: key,
      description: `GSTR-3B set-off — ${args.taxPeriod}`,
      transactionDate: args.periodEnd,
      status: "posted",
      referenceType: "adjustment",
      referenceId: args.returnId,
      currency: "INR",
      totalAmount: formatMoneyPlain(debitTotal, "INR"),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The return journal could not be created.");

  await tx.insert(journalEntries).values(
    legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role as never) as string,
      entryType: l.entryType,
      amount: formatMoneyPlain(l.amountMinor, "INR"),
      description: l.description,
      referenceType: "adjustment" as const,
      referenceId: args.returnId,
      // ⚠️ THE COUNTERPARTY IS THE GOVERNMENT, WHICH IS NOT A COMPANY
      // ROW. Naming one would put a tax authority in the customer list.
      counterpartyType: null,
      counterpartyId: null,
      counterpartyName: null,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

export type { ReturnPostingFacts, ReturnPostingRole };

/**
 * ⚠️ RETURNS THE PERIOD'S NAME RATHER THAN A BOOLEAN, because "you
 * cannot post this" is useless and "March 2026 is closed" is actionable.
 *
 * ⭐ `closing` DELIBERATELY PERMITS POSTINGS. That is the state where
 * somebody is doing the month-end work and still needs to post the
 * adjustments that finish it. Locking at `closing` would make it
 * impossible to close a month at all, which is the kind of rule that
 * gets switched off rather than fixed.
 */
async function closedPeriodFor(
  tx: Tx,
  tenantId: string,
  onDate: string,
): Promise<string | null> {
  const rows = await tx.execute(sql`
    SELECT name FROM financial_periods
     WHERE tenant_id = ${tenantId}::uuid
       AND ${onDate}::date BETWEEN start_date AND end_date
       AND status IN ('closed', 'locked')
     LIMIT 1
  `);
  const first =
    (Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0]) ?? null;
  return first ? String((first as { name?: string }).name ?? "that period") : null;
}
