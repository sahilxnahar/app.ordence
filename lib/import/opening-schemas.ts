/**
 * Ordence — ⭐⭐ Opening Balances: the rules
 * Version: v1.58.0-alpha (Batch 58)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THESE SCHEMAS ARE DEFINED HERE AND NOT IMPORTED FROM
 *    `lib/validators/`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/types.ts` is emphatic that an entity must validate through
 * "THE SAME SCHEMA THE SINGLE-RECORD SERVER ACTION PARSES. NOT A COPY,
 * NOT AN 'IMPORT VARIANT', NOT A LOOSER ONE." That rule exists because
 * `createCompanySchema` and `upsertPartySchema` already existed and a
 * second, looser copy written for the importer would have been a way
 * around every rule in them.
 *
 * There is no single-record opening-balance form, because there is no
 * single-record way to enter an opening balance — that is the whole
 * defect Batch 58 exists to fix. So these schemas have no original to
 * copy, and this file IS the original.
 *
 * 🔴 WHICH MAKES THE RULE POINT FORWARDS INSTEAD OF BACKWARDS. When
 * somebody builds a screen for typing an opening balance in by hand, it
 * must import from here. A second set of rules written next to that form
 * is the same defect the original note warns about, arriving from the
 * other direction — and it is the direction nobody watches, because the
 * form feels like the primary path and the importer like the copy.
 *
 * ⚠️ MONEY ARRIVES AS A DECIMAL STRING OF MINOR UNITS. `coerceMoneyMinor`
 * produces `"125050"` for ₹1,250.50 and returns a STRING rather than a
 * `bigint` because a bigint cannot cross a server-action boundary —
 * `JSON.stringify` throws outright on one. These schemas therefore
 * validate digit strings, never numbers, and nothing here calls
 * `Number()` on an amount.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* SHARED PIECES                                                       */
/* ------------------------------------------------------------------ */

/**
 * A non-negative amount in minor units.
 *
 * 🔴 NEGATIVE AMOUNTS ARE REFUSED, AND THAT IS NOT PEDANTRY. In
 * double-entry the direction of a figure is carried by WHICH COLUMN it is
 * in, and `journal_entries` enforces exactly that — its `amount` column
 * carries a CHECK that it is positive and a comment saying "Direction is
 * carried by `entryType`, never by sign. A negative amount plus a
 * debit/credit flag gives two ways to express the same thing — and two
 * ways to get it wrong."
 *
 * A `-5,000` in the Debit column of a spreadsheet means a credit of
 * 5,000. Accepting it would mean the file has two vocabularies for the
 * same fact, the totals would still balance, and which one the customer
 * meant would be unknowable.
 */
const minorAmount = z
  .string({
    /*
     * ⚠️ THE `invalid_type_error` IS NOT DECORATION. A blank cell arrives
     * here as `null` (see `blankIsNull` in `values.ts`), and Zod's default
     * message for that is "Expected string, received null" — which lands
     * verbatim in the "what was wrong with this row" column of a CSV a
     * bookkeeper is trying to fix. Every required field in this file
     * therefore states what a blank means in words.
     */
    required_error: "This amount is missing.",
    invalid_type_error: "This amount is missing.",
  })
  .regex(/^\d{1,18}$/, "Enter the amount as a positive figure — put it in the other column if it is on the other side.");

const civilDay = z
  .string({
    required_error: "This date is missing. Write it as YYYY-MM-DD, for example 2026-03-31.",
    invalid_type_error: "This date is missing. Write it as YYYY-MM-DD, for example 2026-03-31.",
  })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as YYYY-MM-DD, for example 2026-03-31.");

const nullableText = (max: number) => z.string().trim().min(1).max(max).nullish();

/* ------------------------------------------------------------------ */
/* 1 — THE OPENING TRIAL BALANCE                                       */
/* ------------------------------------------------------------------ */

/**
 * One line of an opening trial balance: an account, a day, and an amount
 * in exactly one of two columns.
 */
export const openingLedgerLineSchema = z
  .object({
    accountCode: z
      .string({ required_error: "Every line needs the code of an account that already exists in your chart of accounts.", invalid_type_error: "Every line needs the code of an account that already exists in your chart of accounts." })
      .trim()
      .min(1, "Every line needs the code of an account that already exists in your chart of accounts.")
      .max(40),
    /**
     * ⚠️ CARRIED AND NEVER USED TO MATCH. A trial balance exported from
     * Tally has the account NAME beside the code, and asking the customer
     * to delete that column before uploading is a step they will get
     * wrong. It is read so the report can show a line they recognise; the
     * account is resolved on the CODE, which is what the workspace's own
     * unique index is on.
     */
    accountName: nullableText(200),
    asAt: civilDay,
    debitMinor: minorAmount.nullish(),
    creditMinor: minorAmount.nullish(),
  })
  .superRefine((line, ctx) => {
    const debit = line.debitMinor ? BigInt(line.debitMinor) : 0n;
    const credit = line.creditMinor ? BigInt(line.creditMinor) : 0n;

    /*
     * 🔴 EXACTLY ONE SIDE. A line carrying both a debit and a credit is a
     * net figure somebody worked out by hand, and the working is gone.
     * `vendor_ledger_entries` states the same rule as a CHECK constraint
     * and puts it better than I can: "The gross movements are what a
     * vendor reconciles their own ledger against; a net is what starts
     * the argument."
     */
    if (debit > 0n && credit > 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["debitMinor"],
        message:
          "This line has both a debit and a credit. Put the balance in one column " +
          "— a net of two figures is a sum somebody did by hand, and the two " +
          "original figures are what an auditor asks for.",
      });
      return;
    }

    /*
     * ⚠️ A LINE WORTH NOTHING IS NOT A LINE. Accepting it would post a
     * ₹0.00 journal leg, which clutters every statement of that account
     * forever and, worse, is indistinguishable from a balance somebody
     * meant to type and did not. An account with no opening balance is
     * an account with no row.
     */
    if (debit === 0n && credit === 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["debitMinor"],
        message:
          "This line has no amount on either side. An account with nothing brought " +
          "forward does not need a row — delete it rather than entering zero.",
      });
    }
  });

export type OpeningLedgerLine = z.infer<typeof openingLedgerLineSchema>;

/* ------------------------------------------------------------------ */
/* 2 — OUTSTANDING CUSTOMER INVOICES                                   */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE AMOUNT IS WHAT IS STILL OWED, NOT THE FACE VALUE OF THE INVOICE
 * ══════════════════════════════════════════════════════════════════════
 * A customer migrating mid-year has invoices that are partly paid. The
 * obvious column set is "invoice total" and "amount received" — and it
 * cannot be used, because `sales_invoices.received_minor` is maintained
 * by a database trigger from the receipt allocation rows and the schema
 * names that trigger as its single writer. Writing a received figure
 * directly would be a second writer of a column that has one, and the two
 * would disagree the first time a receipt was allocated.
 *
 * ⭐ SO WHAT IS IMPORTED IS THE BALANCE. The invoice number is the
 * customer's own, so their remittance advice and their statement still
 * match; the amount is what is outstanding on the day of the migration.
 * The part-payments that got it there belong in the system being left
 * behind, and re-creating them here would need receipts, bank dates and
 * allocations nobody has.
 *
 * ⚠️ THIS IS SAID ON THE SCREEN AS WELL AS HERE. A customer who assumes
 * the column is the face value will import invoices whose totals are too
 * high by whatever they have already been paid, and the ageing will be
 * wrong in the direction that makes them chase people who do not owe it.
 */
export const openingCustomerInvoiceSchema = z
  .object({
    customerName: z
      .string({ required_error: "Name the customer exactly as their company record is named in Ordence.", invalid_type_error: "Name the customer exactly as their company record is named in Ordence." })
      .trim()
      .min(1, "Name the customer exactly as their company record is named in Ordence.")
      .max(255),
    invoiceNumber: z
      .string({ required_error: "The invoice number as your customer knows it.", invalid_type_error: "The invoice number as your customer knows it." })
      .trim()
      .min(1, "The invoice number as your customer knows it.")
      .max(60),
    /**
     * 🔴 THE INVOICE'S OWN DATE, WHICH IS ITS AGE.
     *
     * This is the single most consequential column in the file. Every
     * ageing bucket, every dunning stage and every interest computation
     * downstream is measured from it. Defaulting it to the import date
     * would file a bill that has been outstanding for 140 days into the
     * 0–30 bucket, which means it is not chased, which means it ages
     * another month before anybody notices — and the customer's oldest,
     * most collectable-if-chased debt is precisely the one that
     * disappears.
     *
     * So it is a REQUIRED column with no default anywhere in the stack.
     */
    invoiceDate: civilDay,
    /**
     * ⚠️ OPTIONAL, AND NOT DERIVED FROM THE INVOICE DATE PLUS THE
     * CUSTOMER'S TERMS WHEN IT IS ABSENT. Terms in Ordence are today's
     * terms; the terms on a two-year-old invoice were whatever they were
     * then. Deriving would invent a due date that looks authoritative and
     * is a guess, and a demand notice quotes it.
     */
    dueDate: civilDay.nullish(),
    outstandingMinor: minorAmount.refine(
      (v) => BigInt(v) > 0n,
      "An invoice with nothing outstanding is not an open invoice — leave it out.",
    ),
    notes: nullableText(1000),
  })
  .superRefine((invoice, ctx) => {
    if (invoice.dueDate && invoice.dueDate < invoice.invoiceDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dueDate"],
        message:
          "The due date is before the invoice date. One of the two is wrong, and " +
          "which one changes how overdue this is.",
      });
    }
  });

export type OpeningCustomerInvoice = z.infer<typeof openingCustomerInvoiceSchema>;

/* ------------------------------------------------------------------ */
/* 3 — OUTSTANDING VENDOR BILLS                                        */
/* ------------------------------------------------------------------ */

/**
 * The mirror of the above, and deliberately NOT the same schema.
 *
 * ⚠️ A VENDOR IS IDENTIFIED BY ITS CODE, A CUSTOMER BY ITS NAME, AND THE
 * ASYMMETRY IS THE DATABASE'S. `vendors.code` is unique per workspace and
 * exists precisely to be quoted — "V-0042". `companies` has no such
 * column, so the customer side matches on the name, exactly as the
 * Batch 57 companies importer does, which means the same file that
 * created the companies still identifies them here.
 */
export const openingVendorBillSchema = z
  .object({
    vendorCode: z
      .string({ required_error: "The vendor's code in Ordence, such as V-0042.", invalid_type_error: "The vendor's code in Ordence, such as V-0042." })
      .trim()
      .min(1, "The vendor's code in Ordence, such as V-0042.")
      .max(40),
    billNumber: z
      .string({ required_error: "The vendor's own bill number. It is what they will quote back at you.", invalid_type_error: "The vendor's own bill number. It is what they will quote back at you." })
      .trim()
      .min(1, "The vendor's own bill number. It is what they will quote back at you.")
      .max(80),
    billDate: civilDay,
    /**
     * ⚠️ FOR AN MSME VENDOR THIS IS A STATUTORY DATE. Section 15 of the
     * MSMED Act caps it at 45 days and Section 43B(h) of the Income-tax
     * Act disallows the whole expenditure if payment is later — so a
     * missing due date on an opening MSME bill is not a cosmetic gap, it
     * is an exposure that will not appear in the 43B(h) report.
     * `vendor_ledger_entries.due_date` says the same thing at greater
     * length; it is optional here for the same reason it is nullable
     * there, and the screen says what it costs to leave it blank.
     */
    dueDate: civilDay.nullish(),
    outstandingMinor: minorAmount.refine(
      (v) => BigInt(v) > 0n,
      "A bill with nothing outstanding is not an open bill — leave it out.",
    ),
    notes: nullableText(1000),
  })
  .superRefine((bill, ctx) => {
    if (bill.dueDate && bill.dueDate < bill.billDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dueDate"],
        message: "The due date is before the bill date. One of the two is wrong.",
      });
    }
  });

export type OpeningVendorBill = z.infer<typeof openingVendorBillSchema>;

/* ------------------------------------------------------------------ */
/* 4 — STOCK ON HAND                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ QUANTITY IS INTEGER THOUSANDTHS, held as a decimal string of those
 * thousandths — `"12500"` is 12.5 units. `stock_movements.quantity` is
 * `numeric(18,3)`, so three places is the storage precision as well as
 * the arithmetic one, and `0.1 + 0.2 !== 0.3` is the reason it is never
 * a float on the way there.
 */
export const openingStockLineSchema = z
  .object({
    sku: z.string({ required_error: "The item's SKU as it is in Ordence.", invalid_type_error: "The item's SKU as it is in Ordence." }).trim().min(1, "The item's SKU as it is in Ordence.").max(100),
    warehouseCode: z
      .string({ required_error: "Which warehouse the stock is in. Its code, not its name.", invalid_type_error: "Which warehouse the stock is in. Its code, not its name." })
      .trim()
      .min(1, "Which warehouse the stock is in. Its code, not its name.")
      .max(40),
    asAt: civilDay,
    quantityThousandths: z
      .string({
        required_error: "This quantity is missing.",
        invalid_type_error: "This quantity is missing.",
      })
      .regex(/^\d{1,18}$/, "Enter a positive quantity. Stock that is not there is not opening stock.")
      .refine((v) => BigInt(v) > 0n, "A quantity of zero is not an opening balance — leave the row out."),
    /**
     * 🔴 REQUIRED, AND IT IS THE COLUMN PEOPLE WANT TO LEAVE OUT.
     *
     * `stock_movements.unit_cost_minor` is described in the schema as
     * "Required on inward movements", because the value of what is on the
     * shelf is what appears in the accounts — and the opening stock
     * figure in the trial balance has to agree with it. Importing
     * quantities without costs produces a stock ledger that says there
     * are 400 bags of cement worth nothing, and a balance sheet whose
     * inventory line cannot be reconciled to it.
     */
    unitCostMinor: minorAmount,
    batchNo: nullableText(100),
  });

export type OpeningStockLine = z.infer<typeof openingStockLineSchema>;
