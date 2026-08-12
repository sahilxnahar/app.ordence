/**
 * Ordence — Sales invoice validators
 * Version: v0.90.0-alpha
 *
 * ⚠️ MONEY AND QUANTITY BOTH CROSS THE WIRE AS STRINGS, for the two
 * reasons `lib/validators/orders.ts` already states: a JSON number
 * cannot hold a crore in paise without losing the paise, and
 * `0.1 + 0.2 !== 0.3` is a tonnage dispute on a delivery challan.
 *
 * ⚠️ AND NO SCHEMA HERE CARRIES A `tenantId`. Every one of these is
 * parsed inside a `"use server"` action, and an action whose input type
 * contains the tenant to operate on is the single route past row-level
 * security — the exact shape of the v005 bug.
 */

import { z } from "zod";

/** Non-negative whole paise, as digits. 19 digits is the bigint range. */
const minorAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.");

/**
 * Up to three decimals, matching `numeric(18,3)`.
 *
 * ⚠️ KEPT AS A STRING ALL THE WAY TO POSTGRES. Parsing it to a number to
 * "validate" it would introduce the exact rounding the type exists to
 * avoid.
 */
const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,3})?$/, "Enter a quantity with up to three decimal places.");

const uuidSchema = z.string().uuid("That reference is not valid.");

/** `YYYY-MM-DD`. A civil day, never a timestamp — an invoice has a date. */
const civilDaySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD form.");

/* ------------------------------------------------------------------ */
/* RAISE                                                               */
/* ------------------------------------------------------------------ */

/**
 * Raise a DRAFT invoice from a confirmed order.
 *
 * ⚠️ A DRAFT, NEVER AN ISSUED DOCUMENT. Raising and issuing are two
 * actions because issuing is irreversible under Rule 53 — once the
 * customer holds it, the only lawful correction is a credit note. A
 * single "create invoice" button would make that irreversible step the
 * default outcome of a mis-click.
 */
export const raiseInvoiceFromOrderSchema = z.object({
  orderId: uuidSchema,
  invoiceDate: civilDaySchema,
  dueDate: civilDaySchema.optional(),
  /**
   * Which lines, and how much of each. Omit `quantity` to bill everything
   * still outstanding on that line.
   *
   * ⚠️ AN EMPTY LIST IS REFUSED RATHER THAN TREATED AS "ALL". "Bill
   * nothing" and "bill everything" are too far apart to be one default,
   * and a form that fails to send its rows would silently invoice the
   * whole order.
   */
  lines: z
    .array(
      z.object({
        orderLineId: uuidSchema,
        quantity: quantitySchema.optional(),
      }),
    )
    .min(1, "Choose at least one line to invoice."),
  notes: z.string().trim().max(2000).optional(),
  terms: z.string().trim().max(2000).optional(),
  /** ⚠️ Off by default — Section 170 rounds the tax, not the total. */
  roundToRupee: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* ISSUE                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE IRREVERSIBLE STEP.
 *
 * ⚠️ THERE IS NO `invoiceNumber` FIELD AND THERE NEVER WILL BE. The
 * number is derived inside the transaction that issues the document. A
 * caller who can choose it can collide with a document already in a
 * customer's file, and Rule 46(b) requires the series to be consecutive
 * — a caller-supplied number cannot be.
 */
export const issueInvoiceSchema = z.object({
  invoiceId: uuidSchema,
});

export const cancelInvoiceSchema = z.object({
  invoiceId: uuidSchema,
  /**
   * ⚠️ REQUIRED. Cancelling a tax invoice is a fact somebody will have to
   * explain to an officer, possibly years later, and "cancelled" with no
   * sentence attached is indistinguishable from a mistake being hidden.
   */
  reason: z
    .string()
    .trim()
    .min(4, "Say why this invoice is being cancelled. It will be read back at an audit.")
    .max(1000),
});

/* ------------------------------------------------------------------ */
/* MONEY IN                                                            */
/* ------------------------------------------------------------------ */

export const recordReceiptSchema = z.object({
  companyId: uuidSchema,
  receivedOn: civilDaySchema,
  amountMinor: minorAmountSchema,
  /**
   * ⭐ Tax the CUSTOMER withheld under Section 194-Q and friends.
   *
   * ⚠️ IT SETTLES THE INVOICE AS SURELY AS CASH. A customer who deducts
   * TDS has paid that money — to the Government, on our behalf. Recording
   * it as a shortfall is how a fully-settled account shows as overdue and
   * a dunning letter goes to somebody who paid in full.
   */
  tdsCreditMinor: minorAmountSchema.optional(),
  method: z.enum(["cash", "cheque", "neft", "rtgs", "imps", "upi", "card", "adjustment"]),
  instrumentRef: z.string().trim().max(120).optional(),
  bankRef: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * Apply a receipt to one or more invoices.
 *
 * ⚠️ THE ALLOCATION IS EXPLICIT AND IS NOT INFERRED. An automatic
 * oldest-first rule is right often enough to be dangerous: a customer who
 * pays a specific disputed invoice, and watches the money land on a
 * different one, has been told their instruction does not matter.
 */
export const allocateReceiptSchema = z.object({
  receiptId: uuidSchema,
  allocations: z
    .array(
      z.object({
        invoiceId: uuidSchema,
        amountMinor: minorAmountSchema,
      }),
    )
    .min(1, "Choose at least one invoice to apply this receipt to."),
});

export const bounceReceiptSchema = z.object({
  receiptId: uuidSchema,
  bouncedOn: civilDaySchema,
  reason: z
    .string()
    .trim()
    .min(4, "Record why the payment failed. The customer will ask.")
    .max(500),
});

export type RaiseInvoiceInput = z.infer<typeof raiseInvoiceFromOrderSchema>;
export type RecordReceiptInput = z.infer<typeof recordReceiptSchema>;
export type AllocateReceiptInput = z.infer<typeof allocateReceiptSchema>;

/**
 * A statement of account, as at a date.
 *
 * ⚠️ `asOf` IS REQUIRED AND IS NOT DEFAULTED TO TODAY ON THE SERVER.
 * Ageing is a function of a date, and a statement whose date came from
 * the server's clock cannot be reproduced by the person who printed it —
 * they ask "why does it say 31–60 now when it said 1–30 this morning",
 * and the answer is a timezone.
 */
export const statementSchema = z.object({
  companyId: uuidSchema,
  asOf: civilDaySchema,
});

/* ------------------------------------------------------------------ */
/* CREDIT NOTES                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE GROUNDS ARE A CLOSED LIST BECAUSE SECTION 34(1) IS A CLOSED
 *    LIST. A credit note may be issued where the taxable value or tax
 *    charged exceeds what is payable, where goods are returned, or where
 *    the supply is found deficient. "Because the customer asked" is not
 *    a ground, and a free-text field would let it become one — which is
 *    the credit note an officer disallows.
 */
export const CREDIT_NOTE_REASONS = [
  "sales_return",
  "rate_revision",
  "deficiency",
  "post_sale_discount",
  "other",
] as const;

export const raiseCreditNoteSchema = z.object({
  invoiceId: uuidSchema,
  noteDate: civilDaySchema,
  reasonCode: z.enum(CREDIT_NOTE_REASONS),
  reason: z
    .string()
    .trim()
    .min(4, "Say what is being credited and why. It is read back at an audit.")
    .max(1000),
  lines: z
    .array(
      z.object({
        invoiceLineId: uuidSchema.optional(),
        description: z.string().trim().min(1).max(500),
        quantity: quantitySchema,
        unitPriceMinor: minorAmountSchema,
        taxRateBps: z.number().int().min(0).max(10000),
        hsnSacCode: z.string().trim().max(10).optional(),
      }),
    )
    .min(1, "A credit note needs at least one line."),
});

export const issueCreditNoteSchema = z.object({
  creditNoteId: uuidSchema,
});

/**
 * A GSTR-1 period.
 *
 * ⚠️ A MONTH, NOT AN ARBITRARY RANGE. GSTR-1 is filed for a calendar
 * month (or a quarter under QRMP, which is three of these). Letting a
 * caller pass any two dates would produce a document that looks like a
 * return and reconciles to nothing the portal expects.
 */
export const gstr1PeriodSchema = z.object({
  /** `YYYY-MM`. */
  period: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month in YYYY-MM form, e.g. 2026-04."),
});
