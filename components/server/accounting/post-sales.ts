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
import { tenants } from "@/db/schema/core";
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
  buildBankAdjustmentPosting,
  buildBankChargeItcPosting,
  type BankAdjustmentKind,
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
  buildDepreciationPosting,
  buildDisposalPosting,
  fixedAssetRolesUsed,
  type FixedAssetLeg,
  type FixedAssetPostingRole,
  fxRolesUsed,
  type FxLeg,
  type FxPostingRole,
} from "@/lib/accounting/sales-posting";
import { formatMinorPlain, functionalCurrencyFromSettings } from "@/lib/fx/currency";

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
  | "meter_period"
  /**
   * ⭐ v1.64.0-alpha (0102) — a bank charge or a credit of interest
   * discovered on a bank statement and written up from there.
   *
   * ⚠️ KEYED ON THE STATEMENT LINE, NOT ON THE RECONCILIATION. The line
   * is the thing that can only be posted once; a reconciliation covers
   * many lines and could be signed, reopened and re-signed, and a key
   * per reconciliation would let the same charge post twice.
   */
  | "bank_adjustment"
  /**
   * ⭐ v1.53.0-alpha (0100) — the Companies Act, Schedule II depreciation
   * run.
   *
   * ⚠️ ONE KEY PER RUN, NOT PER ASSET. The journal is one balanced entry
   * for the whole period's charge; four hundred assets producing four
   * hundred transactions a month would make the trial balance unreadable
   * and would say nothing `depreciation_lines` does not already hold.
   *
   * 🔴 AND THERE IS DELIBERATELY NO INCOME-TAX EQUIVALENT. The section 32
   * allowance is a computation for the return, not an accounting entry.
   */
  | "depreciation"
  /** ⭐ v1.53.0-alpha (0100) — a fixed asset leaving the gross block. */
  | "asset_disposal"
  /**
   * ⭐⭐ v1.64.0-alpha (0101) — the reporting-date restatement of foreign
   * currency monetary items, AS 11 ¶11 / Ind AS 21 ¶23.
   *
   * ⚠️ ONE KEY PER RUN AND KEYED ON THE RUN, NOT ON THE DATE. A 31 March
   * revaluation that is voided and redone is a SECOND run with a second
   * uuid, and it must be able to post; keying on the reporting date would
   * make the correction look already-posted and silently do nothing.
   */
  | "fx_revaluation"
  /**
   * ⭐⭐ v1.64.0-alpha (0101) — the realised exchange difference when a
   * foreign-currency invoice is settled, AS 11 ¶13 / Ind AS 21 ¶28.
   *
   * ⚠️ KEYED ON THE SETTLEMENT, NOT THE INVOICE. An invoice paid in three
   * instalments produces three realised differences at three rates, and
   * one key per invoice would post the first and swallow the other two.
   */
  | "fx_settlement"
  /**
   * ⭐⭐ 0112 — the input credit on a bank charge, moved out of the
   * expense once the bank's own tax invoice is in hand.
   *
   * 🔴 KEYED ON THE DEFERRAL, NOT ON THE STATEMENT LINE. The line already
   * carries `bank_adjustment`, which is the GROSS posting. This is a
   * second, later journal against the same charge, and the two must be
   * separately idempotent: a key shared with the gross posting would make
   * this one look already-posted and silently do nothing, which is
   * exactly the failure mode the register was built to end.
   */
  | "bank_charge_itc";

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
  bank_adjustment: "BADJ",
  depreciation: "DEP",
  asset_disposal: "ADS",
  /** ⭐ 0101. "FXR" — the unrealised restatement at a reporting date. */
  fx_revaluation: "FXR",
  /** ⭐ 0101. "FXS" — the realised difference when the money actually moved. */
  fx_settlement: "FXS",
  /** ⭐ 0112. "BITC" — distinct from "BADJ", which is the gross charge. */
  bank_charge_itc: "BITC",
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
/* ================================================================== */
/* ⭐⭐⭐ THE BOOKS' OWN CURRENCY — Batch 0108                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY WRITER IN THIS FILE USED TO STAMP THE LITERAL "INR"
 * ══════════════════════════════════════════════════════════════════════
 * Nine call sites wrote `currency: "INR"` on the transaction and formatted
 * every leg with `formatMoneyPlain(x, "INR")`. Only `writeFxPosting`,
 * added in 0101, asked what the books were actually kept in.
 *
 * So a workspace whose functional currency is AED had its transactions
 * STAMPED "INR" WHILE CARRYING DIRHAM AMOUNTS. 1.66.0 then regrouped
 * `v_ledger_daily` by `transactions.currency`, which means the dashboard
 * now faithfully groups by a column the writer filled in wrongly. A view
 * can only group by what the column says; it cannot repair what the
 * writer put there.
 *
 * ⭐ THE ANSWER COMES FROM THE TENANT, READ INSIDE THE CALLER'S `tx`.
 *
 * ⚠️ AND IT IS DELIBERATELY *NOT* A NEW PARAMETER ON THE TWENTY EXPORTED
 * `post*` FUNCTIONS. Threading a `functionalCurrency` argument through
 * them would change twenty exported signatures and force edits into
 * `server/actions/receivables.ts` and `server/actions/banking.ts`, which
 * belong to other streams in this wave. More importantly it would put the
 * answer in the hands of every caller, and a caller that forgot would
 * silently get the old behaviour back — which is precisely how the
 * literal "INR" survived two multi-currency batches. Reading it here
 * means there is ONE place that can be wrong, and it has no default.
 *
 * ⚠️ `tenants` IS READABLE INSIDE `withTenant`. Its policy is
 * `id = app_current_tenant_id() OR app_platform_scope()`, so this SELECT
 * returns exactly one row — the caller's own workspace — and returns
 * nothing at all if the tenant context was never pinned. That is the
 * right failure: a posting with no tenant context must not invent a
 * currency.
 *
 * ⚠️ AN UNKNOWN CODE IN THE SETTINGS BLOB THROWS rather than falling back.
 * `functionalCurrencyFromSettings` refuses a code it does not recognise,
 * and this function does not catch it. A workspace whose currency reads
 * "Rs" must not quietly become INR: the functional currency is what every
 * figure in the ledger is denominated in, and guessing it is how a wrong
 * answer gets produced confidently.
 */
async function functionalCurrencyFor(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!row) {
    throw new Error(
      "The workspace this posting belongs to could not be read, so the currency its " +
        "books are kept in is unknown. Nothing has been posted.",
    );
  }

  return functionalCurrencyFromSettings(row.settings).code;
}

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
    /**
     * ⭐⭐ A ROLE PINNED TO ONE LEDGER FOR THIS POSTING ONLY — added in
     * v1.63.0 for the bank reconciliation, and used by nothing else.
     *
     * 🔴 `sales_posting_accounts` IS ONE MAP PER TENANT, so the `bank`
     * role names a single ledger. A tenant with three bank accounts
     * reconciles three ledgers, and posting an HDFC charge through the
     * tenant-wide `bank` role would credit whichever account happens to
     * be mapped — leaving the account the charge came from short and
     * permanently unreconcilable, and the other one long.
     *
     * ⚠️ AN OVERRIDDEN ROLE IS NOT "MISSING". It is checked against the
     * override map first, so a tenant who has never mapped `bank` can
     * still post a bank charge against an account whose own ledger is
     * known — which is the common case, because `createBankAccount`
     * creates that ledger and the mapping screen is elsewhere.
     */
    ledgerOverrides?: Partial<Record<PostingRole, string>>;
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
  const overrides = args.ledgerOverrides ?? {};
  const ledgerFor = (role: PostingRole): string | undefined =>
    overrides[role] ?? roleMap.get(role);

  const missing = rolesUsed(args.legs).filter((r) => ledgerFor(r) === undefined);
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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The journal entry could not be created.");

  await tx.insert(journalEntries).values(
    args.legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: ledgerFor(l.role) as string,
      entryType: l.entryType,
      /**
       * ⚠️ `numeric(18,2)` FROM `bigint` PAISE BY STRING, never by
       * dividing. `Number(118000) / 100` is fine and `Number(n) / 100`
       * for a large n is not, and the failure is a rounded rupee in a
       * ledger that is supposed to balance to the paisa.
       */
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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

    /**
     * ⭐ Resolved once, from the tenant, inside the caller's transaction.
     * Batch 0108. See `functionalCurrencyFor`.
     */
    const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
        currency: functionalCurrency,
        totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
        /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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
/* ⭐⭐ THE BANK RECONCILIATION ADJUSTMENT — v1.64.0-alpha (0102)       */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE CHARGE IS DISCOVERED ON THE RECONCILIATION SCREEN, SO IT IS
 *    POSTED FROM THE RECONCILIATION SCREEN.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT HAPPENED BEFORE THIS EXISTED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/banking/match.ts` has said since v1.18.0 that "bank charges,
 * interest and direct debits usually live in this list" and that
 * "somebody has to write it up". Nothing in the banking module could
 * write anything up. The operator was shown a list of entries the books
 * were missing and given no way to add them, so the list stayed the same
 * length every month and the account never reconciled.
 *
 * ⚠️ THE DATE IS THE BANK'S VALUE DATE, NEVER TODAY. A charge taken on
 * 31 March belongs in March. Posting it on the day it was noticed moves
 * it into April, understates March's costs, and — because the March
 * reconciliation is what discovered it — leaves March permanently out by
 * the charge. That is also why the period lock in `writePosting` can
 * refuse this: a charge found in a month already closed is a real
 * problem with a real remedy, not something to date around.
 *
 * ⭐ AND IT GOES THROUGH `writePosting` LIKE EVERYTHING ELSE. Same
 * idempotency key check, same closed-period refusal, same role map, same
 * balanced legs. A second posting path for the banking module would be a
 * second place for the period lock to be forgotten.
 */
export async function postBankAdjustment(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    /** 🔴 The idempotency subject: one posting per statement line, ever. */
    statementLineId: string;
    kind: BankAdjustmentKind;
    /** Positive magnitude in paise. */
    amountMinor: bigint;
    /** ⚠️ The BANK's value date. See above. */
    valueDate: string;
    narration: string;
    /**
     * ⭐ THE BANK ACCOUNT'S OWN LEDGER, resolved by the caller from
     * `bank_accounts.ledger_id`. See `ledgerOverrides` on `writePosting`.
     */
    bankLedgerId: string;
  },
): Promise<PostOutcome> {
  const legs = buildBankAdjustmentPosting({
    kind: args.kind,
    amountMinor: args.amountMinor,
    narration: args.narration,
  });

  return writePosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs,
    key: salesTransactionKey("bank_adjustment", args.statementLineId),
    description:
      args.kind === "bank_charge"
        ? `Bank charge: ${args.narration.slice(0, 160)}`
        : `Interest credited: ${args.narration.slice(0, 160)}`,
    transactionDate: args.valueDate,
    referenceType: "adjustment",
    referenceId: args.statementLineId,
    counterpartyId: null,
    counterpartyName: null,
    ledgerOverrides: { bank: args.bankLedgerId },
  });
}

/* ================================================================== */
/* ⭐⭐⭐ THE INPUT CREDIT ON A BANK CHARGE — 0112                       */
/* ================================================================== */

/**
 * ⭐⭐⭐ THE JOURNAL BRIEF F ASKED FOR AND COULD NOT WRITE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY IT DID NOT EXIST, WHICH IS WORTH KEEPING
 * ══════════════════════════════════════════════════════════════════════
 * `0110` built the register, the refusals and the screen. It then wrote,
 * in its own report:
 *
 *     "Every posting builder in this product lives in
 *      `lib/accounting/sales-posting.ts`, which Brief D owns and I did
 *      not touch. `writePosting` is not exported from
 *      `server/accounting/post-sales.ts`, so there is no legitimate route
 *      from the banking module."
 *
 * ⭐ THAT WAS THE RIGHT CALL AND IT IS WHY THIS FUNCTION IS HERE RATHER
 *    THAN IN `server/banking/`. `0110` could have exported `writePosting`
 *    or opened a second posting path inside the banking module, and gave
 *    the reason it did neither: a second posting path is how the period
 *    lock came to be forgotten once already.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DATE IS THE BANK'S INVOICE DATE, NOT THE CHARGE'S VALUE DATE
 * ══════════════════════════════════════════════════════════════════════
 * The gross charge was posted on the value date, because that is when the
 * money left. The CREDIT arises when the invoice exists — s.16(2)(a) CGST
 * Act — and the invoice usually arrives in a later month, consolidated.
 * Dating this journal back to the charge would claim a credit in a return
 * period in which the taxpayer was not entitled to it, which is the
 * shape a Rule 36(4) mismatch notice is written about.
 *
 * 🔴 AND THAT MEANS THE PERIOD LOCK CAN REFUSE THIS, correctly. A March
 *    invoice recorded in July, against a closed March, is a real problem
 *    with a real remedy. `writePosting` returns `period_closed` and the
 *    caller says so rather than dating around it.
 *
 * ⭐ IT GOES THROUGH `writePosting` LIKE EVERYTHING ELSE — same
 *    idempotency check, same closed-period refusal, same role map, same
 *    balanced legs.
 */
export async function postBankChargeItc(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    /** 🔴 THE IDEMPOTENCY SUBJECT: one credit posting per deferral, ever. */
    deferralId: string;
    cgstMinor: bigint;
    sgstMinor: bigint;
    igstMinor: bigint;
    cessMinor: bigint;
    /** ⚠️ THE BANK'S INVOICE DATE. See above. */
    invoiceDate: string;
    invoiceNo: string;
    supplierGstin: string;
  },
): Promise<PostOutcome> {
  const narration =
    `Input credit on bank charges — ${args.invoiceNo} (${args.supplierGstin})`;

  const legs = buildBankChargeItcPosting({
    cgstMinor: args.cgstMinor,
    sgstMinor: args.sgstMinor,
    igstMinor: args.igstMinor,
    cessMinor: args.cessMinor,
    narration,
  });

  return writePosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    /**
     * ⚠️ THE CAST IS NARROW AND IT IS SOUND, WHICH IS NOT THE SAME AS
     * SAFE-LOOKING. `PurchaseLeg` and `PostingLeg` differ only in the
     * union their `role` is drawn from, and BOTH ROLE MAPS READ THE SAME
     * TABLE: `loadRoleMap` and `loadPurchaseRoleMap` are the same query
     * against `sales_posting_accounts` with two different type
     * annotations. `sales-posting.ts` declares `bank_charges` in both
     * families precisely so this posting's five roles all resolve.
     *
     * ⚠️ THE SAME CAST APPEARS EIGHT TIMES IN THIS FILE ALREADY, as
     * `missing as unknown as PostingRole[]`, for the same reason. The
     * honest fix is one role union, and that is a refactor of nine meta
     * objects rather than a line in a bank-charge posting.
     */
    legs: legs as unknown as PostingLeg[],
    key: salesTransactionKey("bank_charge_itc", args.deferralId),
    description: `Input credit on bank charges: ${args.invoiceNo}`.slice(0, 200),
    transactionDate: args.invoiceDate,
    /**
     * ⚠️ 'adjustment' AND NOT 'invoice'. `classifyVoucherType()` reads the
     * legs: an adjustment with no debtor and no creditor leg is a JOURNAL
     * voucher in Tally, which is what this is. Calling it an invoice
     * would make it a purchase voucher naming a supplier who is not a
     * party to it — the bank already invoiced us and was already paid.
     */
    referenceType: "adjustment",
    referenceId: args.deferralId,
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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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
/** ⭐ Re-exported so the banking action can name the kind without reaching into lib. */
export type { BankAdjustmentKind };

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

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

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
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
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
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
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

/* ================================================================== */
/* ⭐⭐⭐ DEPRECIATION AND DISPOSAL — Batch 100, v1.53.0-alpha (0100)   */
/* ================================================================== */

/**
 * ⚠️ THE SAME MAP TABLE AGAIN. `sales_posting_accounts` is keyed by an
 * opaque `role` varchar precisely so a new family of roles is rows rather
 * than a second table with a second RLS policy to keep in step.
 */
async function loadFixedAssetRoleMap(
  tx: Tx,
  tenantId: string,
): Promise<Map<FixedAssetPostingRole, string>> {
  const rows = await tx
    .select({ role: salesPostingAccounts.role, ledgerId: salesPostingAccounts.ledgerId })
    .from(salesPostingAccounts)
    .where(eq(salesPostingAccounts.tenantId, tenantId));
  return new Map(rows.map((r) => [r.role as FixedAssetPostingRole, r.ledgerId]));
}

/**
 * The shared tail of both fixed-asset postings: idempotency by key, the
 * period lock, the role map, then one balanced transaction.
 *
 * ⚠️ IT IS A LOCAL COPY OF `writePosting`'s BODY RATHER THAN A CALL TO
 * IT, for the same reason `postPayrollRun` has one: `writePosting` is
 * typed to `PostingLeg`/`PostingRole`, and widening that union to every
 * role family in the product would remove the compiler's ability to tell
 * a payroll leg from a sales leg — which is the only thing stopping a
 * brokerage entry being posted to an ESI account.
 */
async function writeFixedAssetPosting(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    legs: readonly FixedAssetLeg[];
    key: string;
    description: string;
    transactionDate: string;
    referenceId: string;
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
   * 🔴 THE PERIOD LOCK. Depreciation for a closed month must not be
   * recomputable, and this is the last of three places that says so: the
   * service refuses to compute into a closed period, `depreciation_runs`
   * has a unique index per basis and period, and this refuses the
   * posting. 0073's trigger is what makes it true for the import and the
   * support fix that have not been written yet.
   */
  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.transactionDate);
  if (lockedIn) return { posted: false, reason: "period_closed", period: lockedIn };

  const roleMap = await loadFixedAssetRoleMap(tx, args.tenantId);
  const missing = fixedAssetRolesUsed(args.legs).filter((r) => !roleMap.has(r));
  if (missing.length > 0) {
    // 🔴 THE WHOLE POSTING IS REFUSED, NEVER A PARTIAL ONE. A disposal
    // journal missing its accumulated depreciation leg does not balance,
    // and a half-posted disposal looks done.
    return {
      posted: false,
      reason: "unmapped_roles",
      missing: missing as unknown as PostingRole[],
    };
  }

  const debitTotal = args.legs
    .filter((l) => l.entryType === "debit")
    .reduce((sum, l) => sum + l.amountMinor, 0n);

  /**
   * ⭐ Resolved once, from the tenant, inside the caller's transaction.
   * Batch 0108. See `functionalCurrencyFor`.
   */
  const functionalCurrency = await functionalCurrencyFor(tx, args.tenantId);

  const [txn] = await tx
    .insert(transactions)
    .values({
      tenantId: args.tenantId,
      transactionNumber: args.key,
      description: args.description,
      transactionDate: args.transactionDate,
      status: "posted",
      // ⚠️ `adjustment`, reusing the existing enum. Depreciation is not a
      // sale, a purchase or a receipt, and `classifyVoucherType()` already
      // maps an adjustment with no debtor leg to a Tally JOURNAL — which
      // is exactly what this is.
      referenceType: "adjustment",
      referenceId: args.referenceId,
      // ⭐ THE BOOKS' OWN CURRENCY. Never the literal "INR". See
      // `functionalCurrencyFor` above for why this is read here rather
      // than passed in by twenty callers.
      currency: functionalCurrency,
      // ⭐ AND THE EXPONENT COMES FROM THAT CURRENCY. `formatMinorPlain`
      // gives "1234" for JPY and "1.234" for KWD; `formatMoneyPlain`
      // gave "12.34" for both.
      totalAmount: formatMinorPlain(debitTotal, functionalCurrency),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The fixed asset journal could not be created.");

  await tx.insert(journalEntries).values(
    args.legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: roleMap.get(l.role) as string,
      entryType: l.entryType,
      /**
       * ⭐ THE INTEGER, WRITTEN AS AN INTEGER. Batch 0108.
       *
       * ⚠️ THIS USED TO BE `amount: formatMoneyPlain(l.amountMinor, "INR")`
       * — a bigint of paise turned into a two-decimal string on the way
       * into a `numeric(18,2)` column. That was correct for rupees and
       * silently destroyed the third digit of every dinar. The column
       * `amount` is now filled by trigger from this one; nothing in this
       * file writes it.
       */
      amountMinor: l.amountMinor,
      description: l.description,
      referenceType: "adjustment" as const,
      referenceId: args.referenceId,
      // ⚠️ NO COUNTERPARTY ON A DEPRECIATION RUN. Depreciation is an
      // internal allocation; there is nobody on the other side of it.
      counterpartyType: null,
      counterpartyId: null,
      counterpartyName: null,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

/**
 * ⭐⭐⭐ THE PERIOD'S DEPRECIATION REACHES THE LEDGER.
 *
 * ⚠️ DATED THE LAST DAY OF THE PERIOD, NEVER TODAY. March depreciation
 * computed on 12 April belongs in March, which is both correct and the
 * thing that makes the period lock mean something.
 *
 * 🔴 THIS FUNCTION REFUSES AN INCOME-TAX RUN AND THAT IS THE POINT OF
 * THE `basis` ARGUMENT. The caller has one in hand; making it pass the
 * basis in means the refusal happens here, at the ledger boundary, rather
 * than relying on every caller to have remembered.
 */
export async function postDepreciationRun(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    runId: string;
    basis: string;
    /** ⚠️ The last day of the period. Not the day the run was computed. */
    periodEnd: string;
    periodLabel: string;
    totalChargeMinor: bigint;
    assetCount: number;
  },
): Promise<PostOutcome> {
  if (args.basis !== "companies_act") {
    throw new Error(
      "Only the Companies Act, Schedule II charge is posted to the ledger. The section 32 " +
        "allowance is a computation for the income-tax return — posting it would put the " +
        "Income-tax Act's figure into a Companies Act balance sheet and overstate accumulated " +
        "depreciation by the whole timing difference.",
    );
  }
  if (args.totalChargeMinor <= 0n) {
    // ⚠️ A run that charged nothing is a SUCCESSFUL run with nothing to
    // post — a month in which every asset was already at its residual
    // value. Reporting it as already posted would be untrue.
    return { posted: false, reason: "nothing_to_post" };
  }

  return writeFixedAssetPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildDepreciationPosting({
      totalChargeMinor: args.totalChargeMinor,
      periodLabel: args.periodLabel,
      assetCount: args.assetCount,
    }),
    key: salesTransactionKey("depreciation", args.runId),
    description: `Depreciation — ${args.periodLabel}`,
    transactionDate: args.periodEnd,
    referenceId: args.runId,
  });
}

/**
 * ⭐⭐ A FIXED ASSET LEAVES THE GROSS BLOCK.
 *
 * ⚠️ DEPRECIATION UP TO THE DATE OF DISPOSAL MUST ALREADY HAVE BEEN
 * POSTED — `disposeFixedAsset` in `server/actions/fixed-assets.ts` checks
 * that and refuses otherwise. Posting a disposal against a stale
 * accumulated figure moves the missing months of depreciation into the
 * profit or loss on sale, which is a different line of the P&L and a
 * different disclosure.
 */
export async function postAssetDisposal(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    assetId: string;
    assetNo: string;
    disposedOn: string;
    costMinor: bigint;
    accumulatedMinor: bigint;
    considerationMinor: bigint;
  },
): Promise<PostOutcome> {
  return writeFixedAssetPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: buildDisposalPosting({
      assetNo: args.assetNo,
      costMinor: args.costMinor,
      accumulatedMinor: args.accumulatedMinor,
      considerationMinor: args.considerationMinor,
      disposedOn: args.disposedOn,
    }),
    key: salesTransactionKey("asset_disposal", args.assetId),
    description: `Disposal of fixed asset ${args.assetNo}`,
    transactionDate: args.disposedOn,
    referenceId: args.assetId,
  });
}

/* ================================================================== */
/* ⭐⭐⭐ EXCHANGE DIFFERENCES REACH THE LEDGER — Batch 0101            */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE FUNCTION THAT MAKES THE `currency` COLUMNS REAL
 * ══════════════════════════════════════════════════════════════════════
 * Every other writer in this file hardcodes `currency: "INR"` on the
 * transaction and formats every leg with `formatMoneyPlain(x, "INR")`.
 * That was harmless while nothing could produce a non-INR figure and it
 * is not harmless now: a revaluation of a dollar receivable produces a
 * number in the tenant's FUNCTIONAL currency, whatever that is, and
 * stamping "INR" on it would label a figure with a currency it is not in.
 *
 * ⭐ SO THIS WRITER TAKES THE FUNCTIONAL CURRENCY AND USES IT IN BOTH
 * PLACES — the transaction's `currency` column and the per-leg
 * `formatMinorPlain`, which reads the exponent PER CURRENCY. A functional
 * currency of JPY produces "1234", not "12.34", and the ledger foots.
 *
 * ⚠️ STATED GAP, AND IT IS THE HONEST HALF OF THE SAME SENTENCE. The
 * OTHER writers in this file are still INR-only. Converting each of them
 * is a much larger change — every sales, purchase, payroll and property
 * posting path, plus the `numeric(18,2)` scale on `journal_entries.amount`
 * which cannot represent a three-decimal dinar at all. See the batch
 * report; it is listed, not hidden.
 */

async function loadFxRoleMap(
  tx: Tx,
  tenantId: string,
): Promise<Map<FxPostingRole, string>> {
  const rows = await tx
    .select({ role: salesPostingAccounts.role, ledgerId: salesPostingAccounts.ledgerId })
    .from(salesPostingAccounts)
    .where(eq(salesPostingAccounts.tenantId, tenantId));
  return new Map(rows.map((r) => [r.role as FxPostingRole, r.ledgerId]));
}

/**
 * The shared tail for both exchange-difference postings.
 *
 * ⚠️ A LOCAL COPY OF `writePosting`'s BODY, for the reason
 * `writeFixedAssetPosting` gives: widening `PostingLeg` to cover every
 * role family would remove the compiler's ability to tell an FX leg from
 * a payroll one.
 *
 * ⭐ AND IT HONOURS `ledgerIdOverride`. The contra side of a restatement
 * is the item's OWN control ledger — the debtors account the invoice sits
 * in, the bank account the balance sits in — resolved by the caller. The
 * role map is the fallback, and a leg with an override needs no role
 * mapped at all, which is why `fxRolesUsed` filters them out.
 */
async function writeFxPosting(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    legs: readonly FxLeg[];
    key: string;
    description: string;
    transactionDate: string;
    referenceId: string;
    /** 🔴 The books' own currency. Never assumed to be INR. */
    functionalCurrency: string;
  },
): Promise<PostOutcome> {
  if (args.legs.length === 0) return { posted: false, reason: "nothing_to_post" };

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
   * 🔴 THE PERIOD LOCK. A revaluation is dated the reporting date, which
   * is precisely the date a close is about to lock. Restating a closed
   * March in July would move a figure the customer has already filed
   * against.
   */
  const lockedIn = await closedPeriodFor(tx, args.tenantId, args.transactionDate);
  if (lockedIn) return { posted: false, reason: "period_closed", period: lockedIn };

  const roleMap = await loadFxRoleMap(tx, args.tenantId);
  const missing = fxRolesUsed(args.legs).filter((r) => !roleMap.has(r));
  if (missing.length > 0) {
    // 🔴 THE WHOLE JOURNAL IS REFUSED. Posting the gains and skipping the
    // losses because only one ledger was mapped would not balance, and a
    // half-posted revaluation looks finished.
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
      referenceType: "adjustment",
      referenceId: args.referenceId,
      // ⭐ THE READ THAT MATTERS. Not "INR".
      currency: args.functionalCurrency,
      totalAmount: formatMinorPlain(debitTotal, args.functionalCurrency),
      createdBy: args.userId,
      postedAt: new Date(),
    })
    .returning({ id: transactions.id });

  if (!txn) throw new Error("The exchange-difference journal could not be created.");

  await tx.insert(journalEntries).values(
    args.legs.map((l) => ({
      tenantId: args.tenantId,
      transactionId: txn.id,
      ledgerId: (l.ledgerIdOverride ?? roleMap.get(l.role)) as string,
      entryType: l.entryType,
      // ⭐ AND AGAIN HERE — now as the integer itself. Batch 0108 removed
      // the numeric round-trip that made this the only currency-correct
      // writer in the file and still could not hold a dinar.
      amountMinor: l.amountMinor,
      description: l.description,
      referenceType: "adjustment" as const,
      referenceId: args.referenceId,
      // ⚠️ NO COUNTERPARTY. A restatement is a measurement, not a dealing
      // with anybody; the counterparty is on the invoice being restated.
      counterpartyType: null,
      counterpartyId: null,
      counterpartyName: null,
    })),
  );

  return { posted: true, transactionId: txn.id };
}

/**
 * ⭐⭐⭐ THE REPORTING-DATE RESTATEMENT REACHES THE LEDGER.
 *
 * ⚠️ DATED THE REPORTING DATE, NEVER TODAY. A 31 March restatement
 * computed on 20 May belongs in March — that is the whole point of a
 * closing rate — and dating it today would put the exchange difference in
 * the wrong financial year, which is the one date error that changes a
 * tax computation.
 */
export async function postFxRevaluation(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    revaluationId: string;
    asOfDate: string;
    functionalCurrency: string;
    legs: readonly FxLeg[];
  },
): Promise<PostOutcome> {
  return writeFxPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: args.legs,
    key: salesTransactionKey("fx_revaluation", args.revaluationId),
    description: `Exchange differences on restatement at ${args.asOfDate}`,
    transactionDate: args.asOfDate,
    referenceId: args.revaluationId,
    functionalCurrency: args.functionalCurrency,
  });
}

/**
 * ⭐ THE REALISED DIFFERENCE ON A SETTLEMENT REACHES THE LEDGER.
 *
 * ⚠️ DATED THE SETTLEMENT DATE. The gain crystallised when the money
 * moved, not when somebody got round to entering it.
 */
export async function postFxSettlement(
  tx: Tx,
  args: {
    tenantId: string;
    userId: string;
    /** The receipt or payment whose settlement produced the difference. */
    settlementId: string;
    settlementDate: string;
    documentReference: string;
    functionalCurrency: string;
    legs: readonly FxLeg[];
  },
): Promise<PostOutcome> {
  return writeFxPosting(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    legs: args.legs,
    key: salesTransactionKey("fx_settlement", args.settlementId),
    description: `Realised exchange difference — ${args.documentReference}`,
    transactionDate: args.settlementDate,
    referenceId: args.settlementId,
    functionalCurrency: args.functionalCurrency,
  });
}
