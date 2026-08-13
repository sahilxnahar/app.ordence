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

import { and, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db";
import { transactions, journalEntries, salesPostingAccounts } from "@/db/schema/accounting";
import { formatMoneyPlain } from "@/lib/billing/money";
import {
  buildDemandPosting,
  buildBookingReceiptPosting,
  buildPossessionPosting,
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
export function salesTransactionKey(
  kind:
    | "invoice"
    | "credit_note"
    | "receipt"
    | "purchase"
    | "ra_bill"
    | "demand"
    | "booking_receipt"
    | "possession"
    /** ⭐ v1.11.0 — the event tax is deducted on. */
    | "vendor_payment",
  documentId: string,
): string {
  const tag =
    kind === "invoice"
      ? "INV"
      : kind === "credit_note"
        ? "CN"
        : kind === "purchase"
          ? "PI"
          : kind === "ra_bill"
            ? "RAB"
            : kind === "demand"
              ? "DMD"
              : kind === "booking_receipt"
                ? "BRC"
                : kind === "possession"
                  ? "POS"
                  : "RCP";
  return `SALES:${tag}:${documentId}`;
}

export type PostOutcome =
  | { posted: true; transactionId: string }
  | { posted: false; reason: "already_posted" }
  | { posted: false; reason: "unmapped_roles"; missing: PostingRole[] };

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

  const [existing] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.tenantId, args.tenantId), eq(transactions.transactionNumber, key)),
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
      counterpartyType: BOOKING_COUNTERPARTY,
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
