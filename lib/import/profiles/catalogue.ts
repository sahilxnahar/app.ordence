/**
 * Ordence — ⭐⭐⭐ THE SEVEN SOURCE SYSTEMS, AS DATA
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 READ `validation` ON EVERY PROFILE BELOW BEFORE BELIEVING ANY OF IT
 * ══════════════════════════════════════════════════════════════════════
 * One of these was checked against a file that came out of the system it
 * describes. The other five were written from those systems' published
 * export documentation and have never been shown a real export. That is
 * stated per profile, in a required member, and
 * `describeProfileDetection` puts the sentence on the customer's screen —
 * because "Zoho supported" and "Zoho profile written from published
 * documentation, not validated against a real export" are different
 * claims and only the second one is true today.
 *
 * ⚠️ THIS FILE CONTAINS NO FUNCTIONS AND MUST NOT ACQUIRE ANY. Everything
 * that runs is in `dates.ts`, `amounts.ts`, `detect.ts` and `priors.ts`,
 * is generic over every profile, and does not get larger when the eighth
 * system is added. See the header of `types.ts` for the argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT A PROFILE STILL CANNOT SAY, WRITTEN DOWN RATHER THAN WORKED
 *    AROUND
 * ══════════════════════════════════════════════════════════════════════
 * Busy and Marg both write the SIGN OF AN AMOUNT IN A SEPARATE COLUMN —
 * an `Opening Balance` of `12500.00` with a `Dr/Cr` column beside it
 * saying which. `NegativeStyleKey` is a per-cell fact and cannot express
 * that: the sign lives in a different cell of the same row, which is a
 * relationship between two columns and not a property of one.
 *
 * 🔴 THE TEMPTING FIX IS A `signColumn` MEMBER AND A SPECIAL CASE IN THE
 * COERCION PATH, AND IT IS THE THING THIS PHASE EXISTS NOT TO DO. It is
 * recorded as a finding in `PATCH-REQUEST-PHASE-9.md` §2 instead, because
 * the right home for it is the mapping layer that already knows about
 * more than one column at a time. Until then a Busy balance column
 * resolves as "no value in this column is negative", which is TRUE of
 * that column and is why the finding matters.
 */

import type { SourceProfile } from "./types";

/* ================================================================== */
/* TALLY                                                              */
/* ================================================================== */

/**
 * ⭐ THE ONE SYSTEM ORDENCE READS END TO END, AND THE ONLY PROFILE HERE
 * WITH EVIDENCE BEHIND IT.
 *
 * ⚠️ ITS XML PATH DOES NOT USE THE DATE PRIORS BELOW. `lib/tally/parse.ts`
 * reads `<DATE>20260401</DATE>` through `fromTallyDate` and hands
 * `lib/import/sources/tally-read.ts` an ISO string already. The priors
 * are for Tally's SPREADSHEET exports — Display → Trial Balance → Alt+E
 * as XLSX — which is the file an accountant is far more likely to send,
 * and which arrives with `1-Apr-2026` in it.
 */
export const TALLY_PROFILE: SourceProfile = {
  key: "tally",
  label: "Tally",
  vendor: "Tally Solutions",
  fallback: false,
  validation: {
    against: "independent-fixture",
    evidence:
      "The Tally envelope fixture in tests/ui/import-sources.test.ts, written at v1.74.0-alpha " +
      "for the reader and not for this profile, plus lib/tally/parse.ts, which is the parser the " +
      "live Tally integration uses against real installations.",
    notValidated:
      "No spreadsheet export taken from a Tally installation was available. The XLSX and CSV " +
      "header spellings below, and the 1-Apr-2026 date prior, come from Tally's documented " +
      "display exports and have not been checked against a real one.",
  },
  /**
   * ⚠️ `d-mon-yyyy` FIRST BECAUSE THAT IS WHAT THE DISPLAY EXPORTS
   * CARRY. `yyyymmdd` is second because a hand-made CSV out of the XML
   * keeps Tally's internal form.
   */
  dateFormats: ["d-mon-yyyy", "yyyymmdd", "dmy-dash", "dmy-slash"],
  /**
   * 🔴 `dr-cr-suffix` FIRST. A Tally trial balance names both sides, and
   * a reader that only knew `Cr` would take every `1,250.00 Dr` as an
   * unreadable cell — four thousand identical failures on a correct file.
   */
  negativeStyles: ["dr-cr-suffix", "cr-suffix", "leading-minus"],
  fileNameHints: ["tally", "daybook", "day book", "ledger", "trialbalance", "trial balance"],
  notes: [
    "Ordence reads a Tally day-book XML export directly — Gateway of Tally → Display → Day Book, " +
      "then Alt+E → XML. That path brings your ledgers across without any column mapping at all.",
    "Tally matches ledger names case-insensitively and does not merge them, so \"Acme Ltd\" and " +
      "\"ACME LTD\" are one ledger there and would be two here. The ledger-masters view names " +
      "every spelling it saw so you can decide before committing.",
  ],
  exports: [
    {
      id: "trial-balance",
      title: "Display → Trial Balance, exported as XLSX or CSV",
      destination: { kind: "entity", entity: "opening-trial-balance" },
      /**
       * ⚠️ `Particulars` IS THE DISCRIMINATING WORD. `Debit` and `Credit`
       * are in every accounting export ever written; `Particulars` next
       * to them is Tally's own vocabulary.
       */
      signature: ["Particulars", "Debit", "Credit"],
      headers: [
        { spelling: "Particulars", field: "accountName" },
        { spelling: "Ledger Name", field: "accountName" },
        { spelling: "Debit", field: "debitMinor" },
        { spelling: "Credit", field: "creditMinor" },
      ],
      fileNameHints: ["trialbalance", "trial balance", "tb"],
      /**
       * 🔴 BOTH OF THESE LIVE IN THE REPORT TITLE, NOT IN A COLUMN. A
       * Tally trial balance is three columns wide. The as-at date is the
       * period the accountant set before pressing Alt+E, and the account
       * code does not exist at all — Tally identifies a ledger by its
       * name. Neither can be recovered from the file.
       */
      missingRequired: ["accountCode", "asAt"],
    },
    {
      id: "bills-receivable",
      title: "Display → Statements of Accounts → Outstandings → Receivables",
      destination: { kind: "entity", entity: "opening-customer-invoices" },
      signature: ["Party's Name", "Pending Amount", "Ref. No."],
      headers: [
        { spelling: "Party's Name", field: "customerName" },
        { spelling: "Ref. No.", field: "invoiceNumber" },
        { spelling: "Bill No.", field: "invoiceNumber" },
        { spelling: "Date", field: "invoiceDate" },
        { spelling: "Due on", field: "dueDate" },
        { spelling: "Pending Amount", field: "outstandingMinor" },
      ],
      fileNameHints: ["receivable", "outstanding", "billsreceivable"],
      missingRequired: [],
    },
    {
      id: "bills-payable",
      title: "Display → Statements of Accounts → Outstandings → Payables",
      destination: { kind: "entity", entity: "opening-vendor-bills" },
      signature: ["Party's Name", "Pending Amount", "Due on"],
      /**
       * 🔴 `Party's Name` IS DELIBERATELY NOT MAPPED TO `vendorCode`.
       * That column's help says it in words: "The vendor's code in
       * Ordence, such as V-0042 — not their name." Mapping a name into it
       * would satisfy the header check and then write the customer's
       * vendor names into a code column. Left unmapped, the name is
       * reported as an unrecognised header and the run is refused for a
       * missing required column, which is the outcome that can be fixed.
       * See PATCH-REQUEST-PHASE-9.md §3: this is true of all four
       * vendor-bill exports here, from four different systems.
       */
      headers: [
        { spelling: "Ref. No.", field: "billNumber" },
        { spelling: "Bill No.", field: "billNumber" },
        { spelling: "Date", field: "billDate" },
        { spelling: "Due on", field: "dueDate" },
        { spelling: "Pending Amount", field: "outstandingMinor" },
      ],
      fileNameHints: ["payable", "billspayable"],
      missingRequired: ["vendorCode"],
    },
    {
      id: "stock-summary",
      title: "Display → Stock Summary, exported as XLSX",
      destination: { kind: "entity", entity: "opening-stock" },
      signature: ["Particulars", "Quantity", "Rate"],
      headers: [
        { spelling: "Particulars", field: "sku" },
        { spelling: "Item Name", field: "sku" },
        { spelling: "Godown", field: "warehouseCode" },
        { spelling: "Quantity", field: "quantityThousandths" },
        { spelling: "Rate", field: "unitCostMinor" },
        { spelling: "Batch", field: "batchNo" },
      ],
      fileNameHints: ["stock", "stocksummary", "godown"],
      /** As at the report's own date, which is not in the file. */
      missingRequired: ["asAt"],
    },
    {
      id: "gst-parties",
      title: "Display → Statutory Reports → GST → GSTR-1 party list",
      destination: { kind: "entity", entity: "gst-parties" },
      signature: ["GSTIN/UIN", "Party's Name", "Registration Type"],
      headers: [
        { spelling: "Party's Name", field: "legalName" },
        { spelling: "Mailing Name", field: "tradeName" },
        { spelling: "GSTIN/UIN", field: "gstin" },
        { spelling: "Registration Type", field: "registrationType" },
        { spelling: "PAN/IT No.", field: "panNumber" },
        { spelling: "State", field: "stateCode" },
      ],
      fileNameHints: ["gstr", "gstin", "partylist"],
      /**
       * A GSTR party list does not say whether a party is a customer or a
       * vendor — the return it came from already decided that — and it
       * carries no effective date, because Tally holds one GSTIN per
       * party rather than a dated series.
       */
      missingRequired: ["partyType", "effectiveFrom"],
    },
    {
      id: "ledger-masters",
      title: "The ledgers themselves, as accounts rather than as a balance",
      destination: {
        kind: "not-yet-importable",
        plannedEntity: "chart-of-accounts",
        because:
          "Ordence has no chart-of-accounts importer yet. Bring the ledgers across as an opening " +
          "trial balance instead, which carries the same names and their positions.",
      },
      signature: ["Ledger Name", "Under", "Opening Balance"],
      headers: [
        { spelling: "Ledger Name", field: "accountName" },
        { spelling: "Under", field: "parentAccount" },
        { spelling: "Opening Balance", field: "openingBalanceMinor" },
      ],
      fileNameHints: ["ledgermaster", "chartofaccounts", "masters"],
      missingRequired: [],
    },
  ],
};

/* ================================================================== */
/* BUSY                                                               */
/* ================================================================== */

/**
 * The second most common accounting package in Indian SMB after Tally,
 * and the one whose exports are hardest to tell apart from a generic
 * spreadsheet — its headings are ordinary English words.
 *
 * 🔴 SO ITS SIGNATURES LEAN ON `Dr/Cr` AND `Under Group`, which are the
 * two headings that are Busy's own rather than everybody's.
 */
export const BUSY_PROFILE: SourceProfile = {
  key: "busy",
  label: "Busy",
  vendor: "Busy Infotech",
  fallback: false,
  validation: {
    against: "published-documentation",
    evidence:
      "Busy's documented master and outstanding-analysis export layouts, and the column names " +
      "its standard reports print.",
    notValidated:
      "Busy profile written from published documentation, not validated against a real export. " +
      "Nothing here has been checked against a file that came out of a Busy installation.",
  },
  dateFormats: ["dmy-dash", "dmy-slash", "d-mon-yyyy"],
  negativeStyles: ["leading-minus", "cr-suffix", "dr-cr-suffix"],
  fileNameHints: ["busy", "busywin"],
  notes: [
    "Busy writes the side of a balance in a separate Dr/Cr column rather than as a sign on the " +
      "amount. Ordence reads the amount column on its own, so a Busy balance column comes " +
      "through with every figure positive. Check the Dr/Cr column yourself before committing an " +
      "opening balance from Busy.",
  ],
  exports: [
    {
      id: "account-master",
      title: "Administration → Data Export → Account Master",
      destination: { kind: "entity", entity: "companies" },
      signature: ["Under Group", "Alias", "Name"],
      headers: [
        { spelling: "Name", field: "name" },
        { spelling: "Address1", field: "addressLine1" },
        { spelling: "Address2", field: "addressLine2" },
        { spelling: "City", field: "city" },
        { spelling: "State", field: "state" },
        { spelling: "Pin Code", field: "postalCode" },
        { spelling: "Phone", field: "phone" },
        { spelling: "Web Site", field: "website" },
      ],
      fileNameHints: ["accountmaster", "master"],
      /**
       * ⚠️ `E-Mail` AND `Alias` ARE DELIBERATELY ABSENT. `companies` has
       * no email column, and the nearest place to put one would be
       * `notes` — which would take a mapping that reads as complete and
       * quietly file four thousand email addresses in a free-text field
       * nothing searches. Left out, `lib/import/mapping.ts` reports both
       * as unrecognised headers and the wizard shows that list, which is
       * the rule that file states: an ignored column is stated, never
       * just ignored.
       */
      missingRequired: [],
    },
    {
      id: "party-gst",
      title: "The GST columns of the same Account Master",
      destination: { kind: "entity", entity: "gst-parties" },
      signature: ["GSTIN No", "Party Type", "PAN No"],
      headers: [
        { spelling: "Name", field: "legalName" },
        { spelling: "Alias", field: "tradeName" },
        { spelling: "GSTIN No", field: "gstin" },
        { spelling: "PAN No", field: "panNumber" },
        { spelling: "Party Type", field: "partyType" },
        { spelling: "Tax Type", field: "registrationType" },
        { spelling: "State", field: "stateCode" },
      ],
      fileNameHints: ["gst", "partymaster"],
      /** Busy holds one GSTIN per party, not a dated series of them. */
      missingRequired: ["effectiveFrom"],
    },
    {
      id: "outstanding-analysis",
      title: "Display → Outstanding Analysis → Bill by Bill",
      destination: { kind: "entity", entity: "opening-customer-invoices" },
      signature: ["Bill No", "Bill Date", "Pending Amt"],
      headers: [
        { spelling: "Party Name", field: "customerName" },
        { spelling: "Bill No", field: "invoiceNumber" },
        { spelling: "Bill Date", field: "invoiceDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Pending Amt", field: "outstandingMinor" },
      ],
      fileNameHints: ["outstanding", "billbybill"],
      missingRequired: [],
    },
    {
      id: "trial-balance",
      title: "Display → Trial Balance",
      destination: { kind: "entity", entity: "opening-trial-balance" },
      signature: ["Account Name", "Dr/Cr", "Closing Balance"],
      headers: [
        { spelling: "Account Name", field: "accountName" },
        { spelling: "Account Code", field: "accountCode" },
        { spelling: "Debit", field: "debitMinor" },
        { spelling: "Credit", field: "creditMinor" },
      ],
      fileNameHints: ["trialbalance", "tb"],
      /** The as-at date is the report's period, printed above the table. */
      missingRequired: ["asAt"],
    },
  ],
};

/* ================================================================== */
/* MARG                                                               */
/* ================================================================== */

/**
 * Common in pharmaceutical distribution, which is why its stock export is
 * the interesting one: batch and expiry are first-class in Marg because
 * they are first-class in the trade, and `opening-stock` already has a
 * `batchNo` column to receive one.
 */
export const MARG_PROFILE: SourceProfile = {
  key: "marg",
  label: "Marg",
  vendor: "Marg ERP",
  fallback: false,
  validation: {
    against: "published-documentation",
    evidence:
      "Marg's documented ledger, outstanding and stock report layouts for its pharma and " +
      "distribution editions.",
    notValidated:
      "Marg profile written from published documentation, not validated against a real export. " +
      "In particular the batch and expiry column spellings differ between Marg's pharma and " +
      "general-trade editions and only the pharma spellings are recorded here.",
  },
  dateFormats: ["dmy-dash", "dmy-slash", "dmy-dot"],
  negativeStyles: ["leading-minus", "cr-suffix", "parentheses"],
  fileNameHints: ["marg", "margerp"],
  notes: [
    "Marg carries a drug licence number on a party and an expiry date on a stock line. Ordence " +
      "has nowhere to put either yet, so those columns are reported as unrecognised rather than " +
      "quietly dropped — an ignored column is stated, never just ignored.",
    "Marg writes the side of a balance in a separate Dr/Cr column, the same way Busy does. See " +
      "the note on the Busy profile.",
  ],
  exports: [
    {
      id: "ledger-master",
      title: "Master → Ledger → Export",
      destination: { kind: "entity", entity: "companies" },
      signature: ["Party Name", "Station", "Ledger Name"],
      headers: [
        { spelling: "Party Name", field: "name" },
        { spelling: "Ledger Name", field: "name" },
        { spelling: "Address", field: "addressLine1" },
        { spelling: "Station", field: "city" },
        { spelling: "State", field: "state" },
        { spelling: "Pin", field: "postalCode" },
        { spelling: "Mobile", field: "phone" },
        { spelling: "Phone No", field: "phone" },
      ],
      fileNameHints: ["ledgermaster", "partymaster"],
      missingRequired: [],
    },
    {
      id: "party-gst",
      title: "The statutory columns of the Ledger Master",
      destination: { kind: "entity", entity: "gst-parties" },
      signature: ["GST No", "Drug Lic No", "Party Name"],
      headers: [
        { spelling: "Party Name", field: "legalName" },
        { spelling: "GST No", field: "gstin" },
        { spelling: "PAN No", field: "panNumber" },
        { spelling: "State Code", field: "stateCode" },
      ],
      fileNameHints: ["gst", "partymaster"],
      /**
       * ⚠️ THREE OF THE FOUR THINGS `gst-parties` REQUIRES ARE NOT IN A
       * Marg ledger export. It is one row per party with one tax number;
       * whether that party sells or buys, which registration scheme they
       * are on, and from what date, are all decisions the customer will
       * have to make in Ordence.
       */
      missingRequired: ["partyType", "registrationType", "effectiveFrom"],
    },
    {
      id: "outstanding-bills",
      title: "Report → Outstanding → Bill Wise",
      destination: { kind: "entity", entity: "opening-customer-invoices" },
      signature: ["Bill No", "Bill Amt", "Party Name"],
      headers: [
        { spelling: "Party Name", field: "customerName" },
        { spelling: "Bill No", field: "invoiceNumber" },
        { spelling: "Bill Date", field: "invoiceDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Balance Amt", field: "outstandingMinor" },
      ],
      fileNameHints: ["outstanding", "billwise"],
      missingRequired: [],
    },
    {
      id: "stock-report",
      title: "Report → Stock → Batch Wise",
      destination: { kind: "entity", entity: "opening-stock" },
      signature: ["Item Name", "Batch", "Closing Qty"],
      headers: [
        { spelling: "Item Name", field: "sku" },
        { spelling: "Item Code", field: "sku" },
        { spelling: "Godown", field: "warehouseCode" },
        { spelling: "Batch", field: "batchNo" },
        { spelling: "Closing Qty", field: "quantityThousandths" },
        { spelling: "Purc Rate", field: "unitCostMinor" },
      ],
      fileNameHints: ["stock", "batchwise"],
      missingRequired: ["asAt"],
    },
  ],
};

/* ================================================================== */
/* ZOHO BOOKS                                                         */
/* ================================================================== */

/**
 * ⭐ THE MOST LIKELY SYSTEM A PROSPECT IS LEAVING, and the one whose
 * exports are the easiest to recognise: `Display Name` next to
 * `GST Treatment` is a Zoho Books contact export and nothing else.
 */
export const ZOHO_BOOKS_PROFILE: SourceProfile = {
  key: "zoho-books",
  label: "Zoho Books",
  vendor: "Zoho",
  fallback: false,
  validation: {
    against: "published-documentation",
    evidence:
      "Zoho Books' documented CSV import and export templates for contacts, invoices, bills and " +
      "the chart of accounts.",
    notValidated:
      "Zoho Books profile written from published documentation, not validated against a real " +
      "export. Zoho lets an organisation choose its own date format, so the yyyy-mm-dd prior " +
      "below is the default rather than a guarantee.",
  },
  dateFormats: ["iso", "dmy-slash", "mdy-slash"],
  negativeStyles: ["leading-minus", "parentheses"],
  fileNameHints: ["zoho", "contacts", "invoice", "bill", "chart_of_accounts"],
  notes: [
    "Zoho Books writes one contact export covering customers and vendors together, with " +
      "`Contact Type` saying which. Import it twice if you want them separated, once with each " +
      "value filtered in the file.",
  ],
  exports: [
    {
      id: "contacts",
      title: "Contacts → Export → Contacts.csv",
      destination: { kind: "entity", entity: "companies" },
      signature: ["Display Name", "Company Name", "GST Treatment"],
      headers: [
        { spelling: "Company Name", field: "name" },
        { spelling: "Display Name", field: "name" },
        { spelling: "Website", field: "website" },
        { spelling: "Phone", field: "phone" },
        { spelling: "MobilePhone", field: "phone" },
        { spelling: "Billing Address", field: "addressLine1" },
        { spelling: "Billing Street2", field: "addressLine2" },
        { spelling: "Billing City", field: "city" },
        { spelling: "Billing State", field: "state" },
        { spelling: "Billing Code", field: "postalCode" },
        { spelling: "Billing Country", field: "country" },
        { spelling: "Notes", field: "notes" },
      ],
      fileNameHints: ["contacts", "customers", "vendors"],
      missingRequired: [],
    },
    {
      id: "contacts-gst",
      title: "The GST columns of the same Contacts.csv",
      destination: { kind: "entity", entity: "gst-parties" },
      signature: ["GST Identification Number (GSTIN)", "GST Treatment", "Display Name"],
      headers: [
        { spelling: "Company Name", field: "legalName" },
        { spelling: "Display Name", field: "tradeName" },
        { spelling: "GST Identification Number (GSTIN)", field: "gstin" },
        { spelling: "GST Treatment", field: "registrationType" },
        { spelling: "PAN Number", field: "panNumber" },
        { spelling: "Contact Type", field: "partyType" },
        { spelling: "Place Of Contact", field: "stateCode" },
      ],
      fileNameHints: ["contacts"],
      /**
       * ⭐ THE CLOSEST FIT OF THE SIX. Zoho carries the party type and
       * the GST treatment, which is three of the four required fields.
       * It has no effective date because it holds one registration per
       * contact rather than a dated history.
       */
      missingRequired: ["effectiveFrom"],
    },
    {
      id: "customer-balances",
      title: "Reports → Customer Balances, or the unpaid rows of Invoice.csv",
      destination: { kind: "entity", entity: "opening-customer-invoices" },
      signature: ["Invoice Number", "Customer Name", "Balance"],
      headers: [
        { spelling: "Customer Name", field: "customerName" },
        { spelling: "Invoice Number", field: "invoiceNumber" },
        { spelling: "Invoice Date", field: "invoiceDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Balance", field: "outstandingMinor" },
      ],
      fileNameHints: ["invoice", "customerbalance", "receivable"],
      missingRequired: [],
    },
    {
      id: "vendor-balances",
      title: "Reports → Vendor Balances, or the unpaid rows of Bill.csv",
      destination: { kind: "entity", entity: "opening-vendor-bills" },
      signature: ["Bill Number", "Vendor Name", "Balance"],
      /** `Vendor Name` is not mapped. See the Tally payables export. */
      headers: [
        { spelling: "Bill Number", field: "billNumber" },
        { spelling: "Bill Date", field: "billDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Balance", field: "outstandingMinor" },
      ],
      fileNameHints: ["bill", "vendorbalance", "payable"],
      missingRequired: ["vendorCode"],
    },
    {
      id: "chart-of-accounts",
      title: "Accountant → Chart of Accounts → Export",
      destination: {
        kind: "not-yet-importable",
        plannedEntity: "chart-of-accounts",
        because:
          "Ordence has no chart-of-accounts importer yet. The account names and codes come " +
          "across on the opening trial balance instead.",
      },
      signature: ["Account Name", "Account Type", "Account Code"],
      headers: [
        { spelling: "Account Name", field: "accountName" },
        { spelling: "Account Code", field: "accountCode" },
        { spelling: "Account Type", field: "accountType" },
        { spelling: "Parent Account", field: "parentAccount" },
      ],
      fileNameHints: ["chart_of_accounts", "chartofaccounts", "accounts"],
      missingRequired: [],
    },
    {
      id: "items",
      title: "Items → Export",
      destination: {
        kind: "not-yet-importable",
        plannedEntity: "products",
        because:
          "Ordence has no product importer yet — that is a later phase. Opening stock can still " +
          "be brought in against SKUs that already exist.",
      },
      signature: ["Item Name", "SKU", "Rate"],
      headers: [
        { spelling: "Item Name", field: "name" },
        { spelling: "SKU", field: "sku" },
        { spelling: "Rate", field: "unitPriceMinor" },
        { spelling: "HSN/SAC", field: "hsnCode" },
      ],
      fileNameHints: ["item", "items", "products"],
      missingRequired: [],
    },
  ],
};

/* ================================================================== */
/* QUICKBOOKS                                                         */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DATE ORDER IS THE WHOLE PROBLEM WITH THIS ONE
 * ══════════════════════════════════════════════════════════════════════
 * QuickBooks writes dates in the company file's own locale. The US
 * edition writes `04/01/2026` for 1 April; the India edition writes
 * `01/04/2026` for the same day. The two are indistinguishable for the
 * first twelve days of every month, which is 40% of any real file's rows.
 *
 * ⭐ THE PRIOR BELOW IS `dmy-slash`, because a customer migrating to
 * Ordence is running the India edition — and `resolveCivilDateFormat`
 * throws that prior away the moment the column contains a day above 12,
 * which most columns of any length do. When it does not, the resolution
 * comes back `settledBy: "profile-prior"` with a caution, which is the
 * honest answer to a question the file does not answer.
 */
export const QUICKBOOKS_PROFILE: SourceProfile = {
  key: "quickbooks",
  label: "QuickBooks",
  vendor: "Intuit",
  fallback: false,
  validation: {
    against: "published-documentation",
    evidence:
      "QuickBooks Online's documented list-export and report-export layouts for customers, " +
      "suppliers, the trial balance and open invoices.",
    notValidated:
      "QuickBooks profile written from published documentation, not validated against a real " +
      "export. The date-order prior is a judgement about which edition Ordence's customers run, " +
      "not something QuickBooks states.",
  },
  dateFormats: ["dmy-slash", "mdy-slash", "iso"],
  /**
   * ⚠️ `parentheses` FIRST. QuickBooks reports bracket their negatives by
   * default, and a trial balance read with those as positives foots to a
   * number that is not the customer's.
   */
  negativeStyles: ["parentheses", "leading-minus"],
  fileNameHints: ["quickbooks", "qbo", "intuit"],
  notes: [
    "QuickBooks report exports put a blank row and a TOTAL row in the middle of the data. Delete " +
      "those before uploading — Ordence reports them as failed rows rather than adding them up, " +
      "but a report with forty section totals in it is forty failures to read past.",
  ],
  exports: [
    {
      id: "customers",
      title: "Sales → Customers → Export to Excel",
      destination: { kind: "entity", entity: "companies" },
      signature: ["Open balance", "Customer", "Billing Address"],
      headers: [
        { spelling: "Customer", field: "name" },
        { spelling: "Company", field: "name" },
        { spelling: "Full Name", field: "name" },
        { spelling: "Phone Numbers", field: "phone" },
        { spelling: "Billing Address", field: "addressLine1" },
        { spelling: "Notes", field: "notes" },
      ],
      fileNameHints: ["customer", "customers", "supplier", "vendors"],
      missingRequired: [],
    },
    {
      id: "trial-balance",
      title: "Reports → Trial Balance → Export to Excel",
      destination: { kind: "entity", entity: "opening-trial-balance" },
      signature: ["Account", "Debit", "Credit"],
      headers: [
        { spelling: "Account", field: "accountName" },
        { spelling: "Debit", field: "debitMinor" },
        { spelling: "Credit", field: "creditMinor" },
      ],
      fileNameHints: ["trialbalance", "trial_balance", "tb"],
      /**
       * ══════════════════════════════════════════════════════════════
       * 🔴 `Account #` IS NOT LISTED, AND THE REASON IS `normaliseHeader`
       * ══════════════════════════════════════════════════════════════
       * QuickBooks writes an `Account #` column when the company file has
       * account numbers turned on — off by default — alongside `Account`.
       * `lib/import/mapping.ts` strips everything that is not a letter or
       * a digit, so BOTH headings normalise to `account` and Ordence
       * cannot tell them apart. Declaring them as two fields produced a
       * real failure from `checkSourceProfiles`:
       *
       *     maps the heading "account" to accountName and accountCode
       *
       * Whichever was read first would win and the other would silently
       * never match. So the account code is declared missing, which is
       * true of what Ordence can READ even when the column is there.
       * `PATCH-REQUEST-PHASE-9.md` §4.
       */
      missingRequired: ["accountCode", "asAt"],
    },
    {
      id: "open-invoices",
      title: "Reports → Open Invoices → Export to Excel",
      destination: { kind: "entity", entity: "opening-customer-invoices" },
      signature: ["Open Balance", "Num", "Transaction Type"],
      headers: [
        { spelling: "Customer", field: "customerName" },
        { spelling: "Num", field: "invoiceNumber" },
        { spelling: "Date", field: "invoiceDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Open Balance", field: "outstandingMinor" },
      ],
      fileNameHints: ["openinvoices", "open_invoices", "ar"],
      missingRequired: [],
    },
    {
      id: "unpaid-bills",
      title: "Reports → Unpaid Bills → Export to Excel",
      destination: { kind: "entity", entity: "opening-vendor-bills" },
      signature: ["Open Balance", "Supplier", "Due Date"],
      /** `Supplier` is not mapped. See the Tally payables export. */
      headers: [
        { spelling: "Num", field: "billNumber" },
        { spelling: "Date", field: "billDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Open Balance", field: "outstandingMinor" },
      ],
      fileNameHints: ["unpaidbills", "ap"],
      missingRequired: ["vendorCode"],
    },
  ],
};

/* ================================================================== */
/* XERO                                                               */
/* ================================================================== */

/**
 * ⭐ THE ASTERISK IS THE GIVEAWAY. Xero marks its required columns
 * `*ContactName`, `*InvoiceNumber`, `*Code`. `normaliseHeader` in
 * `lib/import/mapping.ts` strips everything that is not a letter or a
 * digit, so those already match without any special handling here — but
 * a header row whose first cell starts with `*` is Xero and very little
 * else, which is what makes these signatures strong.
 */
export const XERO_PROFILE: SourceProfile = {
  key: "xero",
  label: "Xero",
  vendor: "Xero",
  fallback: false,
  validation: {
    against: "published-documentation",
    evidence:
      "Xero's published contact, chart-of-accounts and invoice CSV templates, which are stable " +
      "and versioned.",
    notValidated:
      "Xero profile written from published documentation, not validated against a real export. " +
      "Xero writes dates in the organisation's chosen format, so the day-first prior is a " +
      "default rather than a rule.",
  },
  dateFormats: ["dmy-slash", "iso", "d-mon-yyyy"],
  negativeStyles: ["leading-minus", "parentheses"],
  fileNameHints: ["xero", "contacts", "chartofaccounts"],
  notes: [
    "Xero prefixes its required columns with an asterisk — `*ContactName`. Ordence ignores " +
      "punctuation in headings, so those columns match without you editing anything.",
  ],
  exports: [
    {
      id: "contacts",
      title: "Contacts → Export",
      destination: { kind: "entity", entity: "companies" },
      signature: ["*ContactName", "POAddressLine1", "AccountNumber"],
      headers: [
        { spelling: "*ContactName", field: "name" },
        { spelling: "ContactName", field: "name" },
        { spelling: "Website", field: "website" },
        { spelling: "PhoneNumber", field: "phone" },
        { spelling: "POAddressLine1", field: "addressLine1" },
        { spelling: "POAddressLine2", field: "addressLine2" },
        { spelling: "POCity", field: "city" },
        { spelling: "PORegion", field: "state" },
        { spelling: "POZipCode", field: "postalCode" },
        { spelling: "POCountry", field: "country" },
      ],
      fileNameHints: ["contacts", "customers", "suppliers"],
      missingRequired: [],
    },
    {
      id: "contacts-tax",
      title: "The tax columns of the same Contacts export",
      destination: { kind: "entity", entity: "gst-parties" },
      signature: ["TaxNumber", "*ContactName", "AccountsReceivableTaxCodeName"],
      headers: [
        { spelling: "*ContactName", field: "legalName" },
        { spelling: "TaxNumber", field: "gstin" },
      ],
      fileNameHints: ["contacts"],
      /**
       * 🔴 `AccountsReceivableTaxCodeName` IS IN THE SIGNATURE AND NOT IN
       * THE HEADERS, AND THAT IS THE DISTINCTION THE WHOLE TYPE RESTS ON.
       * It identifies a Xero contact export — nothing else has a column
       * called that — and it holds a Xero tax RATE name such as "GST on
       * Income", which is not a GST registration type. Using it as
       * evidence of WHICH FILE THIS IS costs nothing. Using it as
       * evidence of WHAT A COLUMN MEANS would put "GST on Income" into
       * `gst_parties.registration_type`.
       */
      missingRequired: ["partyType", "registrationType", "effectiveFrom"],
    },
    {
      id: "aged-receivables",
      title: "Reports → Aged Receivables Detail → Export",
      destination: { kind: "entity", entity: "opening-customer-invoices" },
      signature: ["Invoice Number", "Contact", "Outstanding"],
      headers: [
        { spelling: "Contact", field: "customerName" },
        { spelling: "Invoice Number", field: "invoiceNumber" },
        { spelling: "Invoice Date", field: "invoiceDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Outstanding", field: "outstandingMinor" },
      ],
      fileNameHints: ["agedreceivables", "receivable"],
      missingRequired: [],
    },
    {
      id: "aged-payables",
      title: "Reports → Aged Payables Detail → Export",
      destination: { kind: "entity", entity: "opening-vendor-bills" },
      signature: ["Bill Number", "Contact", "Outstanding"],
      /** `Contact` is not mapped. See the Tally payables export. */
      headers: [
        { spelling: "Bill Number", field: "billNumber" },
        { spelling: "Bill Date", field: "billDate" },
        { spelling: "Due Date", field: "dueDate" },
        { spelling: "Outstanding", field: "outstandingMinor" },
      ],
      fileNameHints: ["agedpayables", "payable"],
      missingRequired: ["vendorCode"],
    },
    {
      id: "chart-of-accounts",
      title: "Accounting → Chart of Accounts → Export",
      destination: {
        kind: "not-yet-importable",
        plannedEntity: "chart-of-accounts",
        because:
          "Ordence has no chart-of-accounts importer yet. The codes and names come across on the " +
          "opening trial balance instead.",
      },
      signature: ["*Code", "*Name", "*Type"],
      headers: [
        { spelling: "*Code", field: "accountCode" },
        { spelling: "*Name", field: "accountName" },
        { spelling: "*Type", field: "accountType" },
        { spelling: "Description", field: "description" },
      ],
      fileNameHints: ["chartofaccounts", "accounts"],
      missingRequired: [],
    },
  ],
};

/* ================================================================== */
/* THE FALLBACK                                                       */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THAT MUST NEVER GET WORSE THAN IT IS TODAY
 * ══════════════════════════════════════════════════════════════════════
 * Every file that is not one of the six above is this, and that is the
 * majority of files: a spreadsheet somebody made, or an export from a
 * system nobody here has heard of. `lib/import/proposal.ts` already
 * handles it well — headers, aliases, tokens, and the value shapes that
 * make a file of `F1 F2 F3` importable at all.
 *
 * ⚠️ SO THIS PROFILE CARRIES NOTHING. No signature, no header spellings,
 * no date prior, no negative prior. Everything the generic path does
 * today it does through evidence from the values, and a prior added here
 * would fire on every file in the product — including the six above,
 * before their own profile was recognised.
 *
 * ⭐ IT EXISTS TO BE NAMED. `import_runs.source_profile = 'generic'` says
 * Ordence looked at this file and recognised no source system, which is a
 * different and more useful fact than a NULL that could equally mean
 * nothing ever looked.
 */
export const GENERIC_PROFILE: SourceProfile = {
  key: "generic",
  label: "A spreadsheet",
  vendor: "—",
  fallback: true,
  validation: {
    against: "independent-fixture",
    evidence:
      "tests/ui/import-mapping.test.ts and tests/ui/csv-import.test.ts, which predate this " +
      "phase and exercise the generic header and value-shape path directly.",
    notValidated:
      "There is nothing here to validate: the fallback carries no header spellings and no " +
      "format priors, deliberately. What is worth checking is that adding the six profiles did " +
      "not change what a generic file does, which is what the no-regression case in " +
      "tests/ui/import-profiles.test.ts measures.",
  },
  dateFormats: [],
  negativeStyles: [],
  fileNameHints: [],
  exports: [],
  notes: [
    "Ordence did not recognise a source system for this file, so it is being read on its column " +
      "headings and on what the values look like. That is the ordinary path and it works — the " +
      "difference is that nothing is being assumed about date order or about how a negative is " +
      "written.",
  ],
};
