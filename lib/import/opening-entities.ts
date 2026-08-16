/**
 * Ordence — ⭐⭐ What an Opening Position Is Made Of
 * Version: v1.58.0-alpha (Batch 58)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DAY-ONE PROBLEM, AND WHY IT IS FOUR FILES AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * A business switching to Ordence in July arrives with four separate
 * things, and they are separate because they answer different questions
 * and are produced by different people:
 *
 *   THE TRIAL BALANCE      one figure per account, as at one day. Comes
 *                          from the accountant. Must balance.
 *   UNPAID SALES INVOICES  one row per document, each with its own DATE,
 *                          because the date is the age and the age is
 *                          what decides who gets chased.
 *   UNPAID PURCHASE BILLS  the mirror, and for an MSME vendor the due
 *                          date is statutory rather than commercial.
 *   STOCK ON HAND          quantity and cost per item per warehouse.
 *
 * ⚠️ ONE COMBINED FILE WAS THE FIRST DESIGN AND IT IS WRONG. The four
 * are produced at different times by different people, they have
 * genuinely different columns, and — decisively — the trial balance is
 * ALL-OR-NOTHING while the invoice list is not. A single file would have
 * to be one or the other, and whichever was chosen would be wrong for
 * half its contents.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DOUBLE-COUNT DECISION, WHICH IS THE ONE THAT COSTS MONEY
 * ══════════════════════════════════════════════════════════════════════
 * Debtors appear TWICE in the material above: once as a control total in
 * the trial balance ("Sundry Debtors 5,00,000") and once as the sum of
 * the unpaid invoice list. If both posted to the ledger, the workspace
 * would open with ten lakh of debtors, a balance sheet that still
 * balances — because the contra doubles too — and no error anywhere.
 *
 * ⭐ SO EXACTLY ONE OF THEM POSTS, AND IT IS THE TRIAL BALANCE.
 *
 * The trial balance is the accountant's figure, it is the one that has
 * been agreed with the previous system, and it is the one that must tie.
 * The invoice and bill lists are SUB-LEDGER DETAIL: they create the
 * documents that make up that control total, so the ageing report,
 * the statement of account and the dunning ladder have something to
 * work with, and they post NOTHING to the general ledger.
 *
 * ⚠️ THAT IS ALSO WHY THE ORDER MATTERS AND IS STATED ON THE SCREEN.
 * Sub-ledger detail whose total disagrees with its control account is
 * the classic opening-balance failure: an ageing report that sums to
 * ₹5,02,000 beside a balance sheet that says ₹5,00,000, forever, with
 * nobody able to say which is right. The screen shows both totals so the
 * difference is visible on day one, which is the only day anybody can
 * still find it.
 *
 * ⚠️ AND THE INVOICES ARE NOT TAX INVOICES. See the note on `issuedAt` in
 * `server/actions/import.ts`: an opening document is a balance brought
 * forward whose supply and whose tax were reported by the system being
 * left behind. Its taxable value is zero here on purpose, because
 * anything else would report the same supply to the Government twice.
 *
 * ⚠️ PURE. No database import, no clock. Same rule as the rest of
 * `lib/import/`.
 */

import {
  openingCustomerInvoiceSchema,
  openingLedgerLineSchema,
  openingStockLineSchema,
  openingVendorBillSchema,
} from "./opening-schemas";
import {
  describeDisagreeingDates,
  describeImbalance,
  disagreeingAsAtDates,
  openingBatchKey,
  totalTrialBalance,
} from "./opening";
import type { ImportEntityDefinition, ImportLookup } from "./types";

/** Text from a parsed payload, or "" — the shape every key builder wants. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Case- and whitespace-insensitive, matching what the SQL side lowers. */
function fold(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

/* ================================================================== */
/* 1 — THE OPENING TRIAL BALANCE                                       */
/* ================================================================== */

const openingTrialBalanceEntity: ImportEntityDefinition = {
  key: "opening-trial-balance",
  label: "Opening trial balance",
  noun: { one: "opening balance", many: "opening balances" },
  description:
    "One figure per account, as at the day you switch over. Posted as a single " +
    "balanced journal entry. Leave out debtors and creditors detail — those come " +
    "from the invoice and bill files.",
  table: "transactions",

  feature: "accounting.ledger",
  /**
   * ⭐ `transactions:post` AND NOT A NEW KEY. This IS posting a journal
   * entry — the largest one the workspace will ever have — so the
   * permission that governs posting journal entries is the right one. A
   * new `opening_balances:import` key would be a second answer to a
   * question the permission table already answers, and the person who
   * should be allowed to do this is exactly the person allowed to post.
   */
  createPermission: "transactions:post",
  /**
   * ⚠️ UNREACHABLE BY CONSTRUCTION — `duplicateModes` below excludes
   * `update`, and the guard only asks for this in `update` mode. It is
   * still the honest value: if an opening entry ever COULD be replaced,
   * replacing one would be a reversal, and `transactions:reverse` is who
   * may do that.
   */
  updatePermission: "transactions:reverse",

  columns: [
    {
      field: "accountCode",
      header: "Account code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["code", "ledgercode", "glcode", "accountnumber", "accountno", "ledger"],
      help:
        "The code of an account that already exists in your chart of accounts. " +
        "Accounts are not created by this import — an unknown code is reported " +
        "rather than guessed at.",
    },
    {
      field: "accountName",
      header: "Account name",
      kind: "text",
      required: false,
      maxLength: 200,
      aliases: ["particulars", "ledgername", "account", "name", "description"],
      help:
        "Carried through so you recognise the line in the report. The account is " +
        "matched on the code, never on this.",
    },
    {
      field: "asAt",
      header: "As at",
      kind: "date",
      required: true,
      aliases: ["date", "asatdate", "openingdate", "balancedate", "ason", "asondate"],
      help:
        "YYYY-MM-DD, and the same on every row. The day before you start trading " +
        "in Ordence — usually 31 March. It decides which financial year the entry " +
        "falls in, so it is entered rather than assumed to be today.",
    },
    {
      field: "debitMinor",
      header: "Debit",
      kind: "money",
      required: false,
      aliases: ["dr", "debits", "debitamount", "debitbalance"],
      help:
        "Rupees. Assets and expenses. Leave blank if the balance is on the other " +
        "side — a minus sign here is refused rather than read as a credit.",
    },
    {
      field: "creditMinor",
      header: "Credit",
      kind: "money",
      required: false,
      aliases: ["cr", "credits", "creditamount", "creditbalance"],
      help: "Rupees. Liabilities, capital and income.",
    },
  ],

  buildPayload: (values) => ({
    accountCode: values.accountCode,
    accountName: values.accountName,
    asAt: values.asAt,
    debitMinor: values.debitMinor,
    creditMinor: values.creditMinor,
  }),

  schema: openingLedgerLineSchema,

  /**
   * ⚠️ THIS KEY IS FOR IN-FILE DUPLICATES ONLY — see `batchKey` for the
   * one that stops the whole position being posted twice. An account
   * appearing on two lines of one trial balance is a mistake with a
   * predictable consequence: whichever line is written second wins, and
   * which line that is depends on the order of rows in a spreadsheet.
   * The framework refuses the second and names the first.
   */
  naturalKey: (parsed) => {
    const code = text(parsed.accountCode);
    if (code === "") return null;
    return {
      kind: "account",
      value: code.toLowerCase(),
      label: `account code ${code}`,
    };
  },

  rowLabel: (parsed) => {
    const code = text(parsed.accountCode);
    const name = text(parsed.accountName);
    return name === "" ? code : `${code} · ${name}`;
  },

  lookups: (parsed): readonly ImportLookup[] => {
    const code = text(parsed.accountCode);
    if (code === "") return [];
    return [
      {
        kind: "ledger_by_code",
        value: code.toLowerCase(),
        into: "ledgerId",
        missing:
          `There is no account with code "${code}" in your chart of accounts. ` +
          `An opening balance cannot create one — an account carries a type that ` +
          `decides which side of the balance sheet it appears on, and guessing that ` +
          `from a trial balance line would put a loan under assets. Create it in ` +
          `Settings → Chart of accounts, then run this again.`,
      },
    ];
  },

  /**
   * 🔴 SEE THE LONG NOTE ON `atomic` IN `types.ts`. This file becomes ONE
   * journal entry. Eight-tenths of a journal entry is not eight-tenths of
   * an opening position; it is a ledger that does not balance, which the
   * database's deferred constraint trigger refuses anyway.
   */
  atomic: true,

  /**
   * 🔴 NO `update`. `journal_entries` is append-only — the schema says so
   * where `updatedAt` would have been. A posted opening entry is
   * corrected by reversing it and posting a new one, which is an
   * accounting act with a trail on it, not by an importer quietly
   * rewriting figures under a transaction somebody has reconciled
   * against.
   */
  duplicateModes: ["skip", "fail"],

  duplicateRule:
    "The whole file is one entry, keyed on the date it is as at. Uploading it " +
    "again is recognised as the same opening position and posts nothing — it " +
    "cannot double your books.",

  batchKey: (rows) => {
    const dates = disagreeingAsAtDates(rows);
    /*
     * ⚠️ NO KEY WHEN THE FILE DOES NOT AGREE ON A DATE. `fileRule` has
     * already refused such a file; returning a key built from an
     * arbitrary one of the dates would mean the refusal and the
     * idempotency check disagreed about what the file even is.
     */
    if (dates.length !== 1) return null;
    const asAt = dates[0] as string;
    const key = openingBatchKey("trial_balance", asAt);
    return {
      kind: "openingEntry",
      value: key,
      label: `the opening entry as at ${asAt} (${key})`,
    };
  },

  /**
   * 🔴🔴 THE BALANCE RULE. The reasoning is in `describeImbalance` and it
   * is the most important decision in this batch: a trial balance that
   * does not balance is REFUSED, not accepted with a suspense plug.
   */
  fileRule: (rows) => {
    const dates = disagreeingAsAtDates(rows);
    if (dates.length > 1) return describeDisagreeingDates(dates);

    const totals = totalTrialBalance(rows);
    if (!totals.balances) return describeImbalance(totals);

    /*
     * ⚠️ A FILE THAT ADDS UP TO NOTHING ON BOTH SIDES BALANCES, and it is
     * not an opening position. It is a file of zeroes, or a file whose
     * amount columns did not map. Both would post an empty journal entry
     * and report success.
     */
    if (totals.debitMinor === 0n) {
      return (
        "Every line in this file adds up to nothing. Check that your Debit and " +
        "Credit columns are named so this recognises them — the report above " +
        "lists any column it ignored."
      );
    }
    return null;
  },
};

/* ================================================================== */
/* 2 — OUTSTANDING CUSTOMER INVOICES                                   */
/* ================================================================== */

const openingCustomerInvoicesEntity: ImportEntityDefinition = {
  key: "opening-customer-invoices",
  label: "Unpaid customer invoices",
  noun: { one: "opening invoice", many: "opening invoices" },
  description:
    "What your customers still owe you, invoice by invoice, each with its own " +
    "date. The dates are the ages — every ageing bucket and every reminder is " +
    "measured from them.",
  table: "sales_invoices",

  feature: "sales.receivables",
  /**
   * ⭐ `sales.invoices.issue` RATHER THAN `sales.invoices.create`. What
   * this writes is not a draft — it is a document that appears
   * immediately on a customer's statement of account and can be chased.
   * The lighter key would let somebody who may only prepare drafts put
   * five hundred live receivables into the workspace.
   */
  createPermission: "sales.invoices.issue",
  updatePermission: "sales.invoices.cancel",

  columns: [
    {
      field: "customerName",
      header: "Customer",
      kind: "text",
      required: true,
      maxLength: 255,
      aliases: ["company", "customername", "party", "account", "buyer", "client", "name"],
      help:
        "Exactly as the company is named in Ordence. Companies are not created " +
        "here — import your companies first, and the same file that created them " +
        "will match here.",
    },
    {
      field: "invoiceNumber",
      header: "Invoice number",
      kind: "text",
      required: true,
      maxLength: 60,
      aliases: ["invoiceno", "invoice", "billno", "documentno", "reference", "number", "docno"],
      help:
        "Your own number, as your customer knows it — it is what they will quote " +
        "on a payment. It is also what stops a second upload of this file " +
        "creating the invoice twice.",
    },
    {
      field: "invoiceDate",
      header: "Invoice date",
      kind: "date",
      required: true,
      aliases: ["date", "documentdate", "billdate", "invoicedate", "issuedate"],
      help:
        "YYYY-MM-DD. The date on the original invoice, not the date you are " +
        "importing. This is the age of the debt: get it wrong and a bill 140 days " +
        "old lands in the 0–30 bucket and is never chased.",
    },
    {
      field: "dueDate",
      header: "Due date",
      kind: "date",
      required: false,
      aliases: ["duedate", "payby", "paymentdue", "dueon"],
      help:
        "YYYY-MM-DD, if you have it. Left blank it stays blank rather than being " +
        "guessed from today's payment terms — the terms on an old invoice were " +
        "whatever they were then.",
    },
    {
      field: "outstandingMinor",
      header: "Amount outstanding",
      kind: "money",
      required: true,
      aliases: ["outstanding", "balance", "amountdue", "amount", "balancedue", "pending", "due"],
      help:
        "Rupees STILL OWED, not the face value of the invoice. Part payments taken " +
        "before you switched over stay in your old system; this figure is what is " +
        "left. Include tax — it is what the customer has to pay.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 1000,
      aliases: ["remarks", "comments", "description", "narration"],
      help: "Free text. Anything the person chasing this should know.",
    },
  ],

  buildPayload: (values) => ({
    customerName: values.customerName,
    invoiceNumber: values.invoiceNumber,
    invoiceDate: values.invoiceDate,
    dueDate: values.dueDate,
    outstandingMinor: values.outstandingMinor,
    notes: values.notes,
  }),

  schema: openingCustomerInvoiceSchema,

  /**
   * ⭐ THE INVOICE NUMBER, AND IT IS THE DATABASE'S OWN KEY.
   * `sales_invoices_number_tenant_key` is `UNIQUE (tenant_id,
   * invoice_number)`. Keying on anything else would mean the framework's
   * idea of "the same invoice" and the database's idea disagree, and the
   * disagreement surfaces as a raw constraint violation halfway through a
   * run instead of as a planned skip.
   *
   * ⚠️ COMPARED EXACTLY, NOT LOWER-CASED, because that index is exact.
   * Folding the case here would report `AH/2026/0041` and `ah/2026/0041`
   * as the same invoice and then watch Postgres accept both.
   */
  naturalKey: (parsed) => {
    const number = text(parsed.invoiceNumber);
    if (number === "") return null;
    return { kind: "invoiceNumber", value: number, label: `invoice ${number}` };
  },

  rowLabel: (parsed) => {
    const number = text(parsed.invoiceNumber);
    const customer = text(parsed.customerName);
    return customer === "" ? number : `${number} · ${customer}`;
  },

  lookups: (parsed): readonly ImportLookup[] => {
    const name = text(parsed.customerName);
    if (name === "") return [];
    return [
      {
        kind: "company_by_name",
        value: fold(name),
        into: "companyId",
        missing:
          `There is no company called "${name}" in this workspace. An invoice has ` +
          `to name somebody — a receivable with no customer cannot be chased, ` +
          `statemented or aged. Import your companies first (Settings → Import), ` +
          `then run this again.`,
      },
    ];
  },

  /**
   * ⚠️ NOT ATOMIC, AND THE CONTRAST WITH THE TRIAL BALANCE IS THE POINT.
   * These are N independent documents, not one entry. 900 of 1000
   * invoices in is 900 customers who can be chased; refusing the lot
   * because two rows have an unreadable date would be the all-or-nothing
   * behaviour `lib/import/report.ts` argues at length against.
   */
  atomic: false,

  /**
   * ⚠️ NO `update`. An issued invoice is frozen — the sales-invoice
   * subsystem has a database trigger that says so. Overwriting one from a
   * spreadsheet would be rewriting a document a customer has already been
   * sent, which is a credit note in real life.
   */
  duplicateModes: ["skip", "fail"],

  duplicateRule:
    "Two rows are the same invoice when they have the same invoice number. " +
    "Uploading the file again skips what is already here rather than creating " +
    "it twice.",
};

/* ================================================================== */
/* 3 — OUTSTANDING VENDOR BILLS                                        */
/* ================================================================== */

const openingVendorBillsEntity: ImportEntityDefinition = {
  key: "opening-vendor-bills",
  label: "Unpaid vendor bills",
  noun: { one: "opening bill", many: "opening bills" },
  description:
    "What you still owe your suppliers, bill by bill. Lands in the vendor ledger " +
    "with its own date, so the payables ageing and the MSME 45-day clock are " +
    "right from day one.",
  table: "vendor_ledger_entries",

  feature: "purchases.vendor_ledger",
  createPermission: "purchases:record_invoice",
  updatePermission: "purchases:record_invoice",

  columns: [
    {
      field: "vendorCode",
      header: "Vendor code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["vendor", "supplier", "vendorcode", "suppliercode", "code", "party"],
      help:
        "The vendor's code in Ordence, such as V-0042 — not their name. Vendors " +
        "are not created here: a vendor carries payment terms, an MSME status and " +
        "a PAN that decide a TDS rate, and none of those are in this file.",
    },
    {
      field: "billNumber",
      header: "Bill number",
      kind: "text",
      required: true,
      maxLength: 80,
      aliases: ["billno", "invoiceno", "invoice", "documentno", "reference", "number"],
      help:
        "The vendor's own number. They will quote it back at you, and it is what " +
        "stops a second upload paying the same bill twice.",
    },
    {
      field: "billDate",
      header: "Bill date",
      kind: "date",
      required: true,
      aliases: ["date", "invoicedate", "documentdate", "billdate"],
      help: "YYYY-MM-DD. The date on the vendor's bill, which is the age of the debt.",
    },
    {
      field: "dueDate",
      header: "Due date",
      kind: "date",
      required: false,
      aliases: ["duedate", "payby", "paymentdue", "dueon"],
      help:
        "YYYY-MM-DD. For an MSME vendor this is statutory rather than commercial " +
        "— 45 days under s.15 of the MSMED Act, and s.43B(h) disallows the whole " +
        "expenditure if you pay later. Left blank, this bill will not appear in " +
        "that exposure report.",
    },
    {
      field: "outstandingMinor",
      header: "Amount outstanding",
      kind: "money",
      required: true,
      aliases: ["outstanding", "balance", "amountdue", "amount", "balancedue", "pending", "due"],
      help: "Rupees still unpaid, including tax. Not the face value of the bill.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 1000,
      aliases: ["remarks", "comments", "description", "narration"],
      help:
        "Free text. What the bill was for, or why it is still unpaid — it lands on " +
        "the vendor ledger line, where whoever schedules the payment will read it.",
    },
  ],

  buildPayload: (values) => ({
    vendorCode: values.vendorCode,
    billNumber: values.billNumber,
    billDate: values.billDate,
    dueDate: values.dueDate,
    outstandingMinor: values.outstandingMinor,
    notes: values.notes,
  }),

  schema: openingVendorBillSchema,

  /**
   * ⚠️ THE VENDOR IS IN THE KEY, AND THAT IS NOT BELT AND BRACES.
   * `vendor_ledger_entries` has no unique index on the reference number —
   * two different suppliers numbering their bills `001` is completely
   * ordinary, and keying on the number alone would silently skip the
   * second supplier's bill as a duplicate of the first.
   */
  naturalKey: (parsed) => {
    const vendor = fold(parsed.vendorCode);
    const bill = text(parsed.billNumber);
    if (vendor === "" || bill === "") return null;
    return {
      kind: "vendorBill",
      value: `${vendor}|${bill}`,
      label: `bill ${bill} from vendor ${text(parsed.vendorCode)}`,
    };
  },

  rowLabel: (parsed) => `${text(parsed.billNumber)} · ${text(parsed.vendorCode)}`,

  lookups: (parsed): readonly ImportLookup[] => {
    const code = text(parsed.vendorCode);
    if (code === "") return [];
    return [
      {
        kind: "vendor_by_code",
        value: code.toLowerCase(),
        into: "vendorId",
        missing:
          `There is no vendor with code "${code}" in this workspace. Create your ` +
          `vendors first — a vendor's MSME status and PAN decide a payment ` +
          `deadline and a TDS rate, and neither can be inferred from a bill.`,
      },
    ];
  },

  atomic: false,
  duplicateModes: ["skip", "fail"],
  duplicateRule:
    "Two rows are the same bill when they have the same bill number FROM THE " +
    "SAME VENDOR. Two suppliers both numbering a bill 001 are two bills.",
};

/* ================================================================== */
/* 4 — STOCK ON HAND                                                   */
/* ================================================================== */

const openingStockEntity: ImportEntityDefinition = {
  key: "opening-stock",
  label: "Stock on hand",
  noun: { one: "opening stock line", many: "opening stock lines" },
  description:
    "What is physically on the shelf on the day you switch over, per item per " +
    "warehouse, with the cost it is carried at.",
  table: "stock_movements",

  feature: "inventory.stock",
  createPermission: "inventory.movements.post",
  updatePermission: "inventory.movements.post",

  columns: [
    {
      field: "sku",
      header: "SKU",
      kind: "text",
      required: true,
      maxLength: 100,
      aliases: ["itemcode", "item", "productcode", "code", "partno", "partnumber"],
      help:
        "The item's SKU as it is in Ordence. Items are not created here — an item " +
        "carries a valuation method that restates the cost of everything sold if " +
        "it is wrong.",
    },
    {
      field: "warehouseCode",
      header: "Warehouse code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["warehouse", "location", "store", "godown", "warehousecode", "site"],
      help: "The warehouse's code, not its name.",
    },
    {
      field: "asAt",
      header: "As at",
      kind: "date",
      required: true,
      aliases: ["date", "asatdate", "openingdate", "ason", "countdate"],
      help:
        "YYYY-MM-DD. The day the stock was counted. Entered rather than assumed " +
        "to be today, because a count done on the 31st and imported on the 4th is " +
        "a count as at the 31st.",
    },
    {
      field: "quantityThousandths",
      header: "Quantity",
      kind: "quantity",
      required: true,
      aliases: ["qty", "quantityonhand", "onhand", "stock", "closingstock", "balance"],
      help:
        "How many, in the item's own stocking unit. Up to three decimal places. " +
        "Units belong on the item, not in this cell.",
    },
    {
      field: "unitCostMinor",
      header: "Unit cost",
      kind: "money",
      required: true,
      aliases: ["cost", "rate", "unitrate", "costperunit", "valuationrate", "price"],
      help:
        "Rupees PER UNIT, not the line total. Required: stock with no cost is " +
        "stock the balance sheet values at nothing, and the inventory figure in " +
        "your trial balance then cannot be reconciled to it.",
    },
    {
      field: "batchNo",
      header: "Batch",
      kind: "text",
      required: false,
      maxLength: 100,
      aliases: ["batch", "lot", "lotno", "batchnumber"],
      help: "Only for items tracked by batch. Leave blank otherwise.",
    },
  ],

  buildPayload: (values) => ({
    sku: values.sku,
    warehouseCode: values.warehouseCode,
    asAt: values.asAt,
    quantityThousandths: values.quantityThousandths,
    unitCostMinor: values.unitCostMinor,
    batchNo: values.batchNo,
  }),

  schema: openingStockLineSchema,

  /**
   * ⚠️ THE BATCH IS PART OF THE KEY. `stock_balances` is unique on
   * `(tenant, item, warehouse, batch_no)` — two batches of the same item
   * in the same warehouse are two balances, with different expiry dates
   * and different costs, and merging them would lose both.
   */
  naturalKey: (parsed) => {
    const sku = fold(parsed.sku);
    const warehouse = fold(parsed.warehouseCode);
    if (sku === "" || warehouse === "") return null;
    const batch = fold(parsed.batchNo);
    return {
      kind: "stockSlot",
      value: `${sku}|${warehouse}|${batch}`,
      label:
        `${text(parsed.sku)} in ${text(parsed.warehouseCode)}` +
        (batch === "" ? "" : ` (batch ${text(parsed.batchNo)})`),
    };
  },

  rowLabel: (parsed) => `${text(parsed.sku)} · ${text(parsed.warehouseCode)}`,

  lookups: (parsed): readonly ImportLookup[] => {
    const sku = text(parsed.sku);
    const warehouse = text(parsed.warehouseCode);
    const out: ImportLookup[] = [];
    if (sku !== "") {
      out.push({
        kind: "stock_item_by_sku",
        value: sku.toLowerCase(),
        into: "stockItemId",
        missing: `There is no stock item with SKU "${sku}" in this workspace.`,
      });
    }
    if (warehouse !== "") {
      out.push({
        kind: "warehouse_by_code",
        value: warehouse.toLowerCase(),
        into: "warehouseId",
        missing: `There is no warehouse with code "${warehouse}" in this workspace.`,
      });
    }
    return out;
  },

  /**
   * ⚠️ NOT ATOMIC AND NO WHOLE-FILE DATE RULE, UNLIKE THE TRIAL BALANCE.
   * A stock movement is its own document — the ledger it lands in is
   * `SUM(quantity)`, which is correct whatever subset arrives. And a
   * workspace that counted its Mumbai godown on the 30th and its Pune one
   * on the 31st has two dates and both are true, which is not something
   * the trial balance can say.
   */
  atomic: false,
  duplicateModes: ["skip", "fail"],
  duplicateRule:
    "Two rows are the same stock line when they name the same item, the same " +
    "warehouse and the same batch. Uploading again does not add the stock twice.",
};

/* ================================================================== */
/* THE REGISTRY                                                        */
/* ================================================================== */

/**
 * ⚠️ A SEPARATE REGISTRY FROM `IMPORT_ENTITIES`, AND IT IS A PRODUCT
 * DECISION RATHER THAN A FILING ONE.
 *
 * Merging these four into the general import picker would present them as
 * four more lists you can load, interchangeable with a contact list. They
 * are not. They are a one-time migration with an ORDER — companies and
 * vendors first, then the trial balance, then the detail that backs it —
 * and getting the order wrong produces an ageing report that disagrees
 * with the balance sheet. That sequence needs a screen of its own to
 * explain it, which is `app/(crm)/settings/opening-balances/`.
 *
 * The server resolves both registries through one allowlist
 * (`ALL_IMPORT_ENTITIES` in `entities.ts`), so nothing about the write
 * path is duplicated.
 */
export const OPENING_IMPORT_ENTITIES = {
  "opening-trial-balance": openingTrialBalanceEntity,
  "opening-customer-invoices": openingCustomerInvoicesEntity,
  "opening-vendor-bills": openingVendorBillsEntity,
  "opening-stock": openingStockEntity,
} as const satisfies Record<string, ImportEntityDefinition>;

export type OpeningImportEntityKey = keyof typeof OPENING_IMPORT_ENTITIES;

/**
 * ⭐ THE ORDER THE SCREEN PRESENTS THEM IN, AND IT IS NOT ALPHABETICAL.
 * The trial balance is first because it is the control total everything
 * else is measured against; the detail follows it.
 */
export const OPENING_IMPORT_ENTITY_KEYS = Object.keys(
  OPENING_IMPORT_ENTITIES,
) as OpeningImportEntityKey[];
