/**
 * Ordence — ⭐ Sales invoices, customer receipts and allocation
 * Version: v0.90.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT `invoices` IN `./billing`, AND THEY MUST NEVER MERGE
 * ══════════════════════════════════════════════════════════════════════
 * `billing.invoices` is ORDENCE billing its own tenants —
 * `server/billing/invoice-generator.ts` sets `customerLegalName` from the
 * TENANT, and the row carries `subscriptionId`, `providerInvoiceId` and
 * `hostedInvoiceUrl`. Its customer is the workspace.
 *
 * THIS table's customer is the workspace's customer. Same shape, opposite
 * direction. Merging them would put Ordence's own revenue into its
 * tenants' GSTR-1, and the mistake would only surface at a return.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THIS IS THE TABLE THAT MAKES THE 0048 CREDIT LIMITS WORK
 * ══════════════════════════════════════════════════════════════════════
 * `sales_orders.received_value_minor` had no writer anywhere in the
 * codebase, so credit exposure could never come down and a customer who
 * hit their ceiling stayed there. §3 of `0049_sales_invoices.sql` is that
 * writer, and it is driven from these rows.
 *
 * ⚠️ THE GUARANTEES ARE IN THE SQL, NOT HERE. An issued invoice is frozen
 * by a trigger; settlement rolls up from the allocations by a trigger;
 * the number series is held unique by an index. This file describes the
 * shape so TypeScript and `drizzle-kit` agree with the database — it does
 * not restate the rules, because a second statement of a rule is a second
 * thing to forget to change.
 */

import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { companies, contacts } from "./crm";
import { salesOrders, salesOrderLines } from "./orders";
import { gstRegistrations, gstParties, hsnSacCodes, hsnSacRates } from "./gst";
import { assets } from "./assets";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THERE IS NO `void` AND NO `deleted`.
 *
 * Under Rule 53 an issued tax invoice is reduced or reversed by a CREDIT
 * NOTE — its own document, its own number, its own GSTR-1 line. A `void`
 * status would look like the easy way to fix a mistake and would leave
 * the customer holding a document our books say never existed.
 *
 * `cancelled` exists only for the narrow lawful case: a draft abandoned,
 * or a document cancelled on the portal within the window the portal
 * allows.
 */
export const salesInvoiceStatusEnum = pgEnum("sales_invoice_status", [
  "draft",
  "issued",
  "part_paid",
  "paid",
  "cancelled",
]);

export const customerReceiptMethodEnum = pgEnum("customer_receipt_method", [
  "cash",
  "cheque",
  "neft",
  "rtgs",
  "imps",
  "upi",
  "card",
  /** A journal adjustment — a credit note applied, a write-off, a set-off. */
  "adjustment",
]);

export const customerReceiptStatusEnum = pgEnum("customer_receipt_status", [
  "pending",
  "cleared",
  "bounced",
  "cancelled",
]);

/* ------------------------------------------------------------------ */
/* SALES INVOICES                                                      */
/* ------------------------------------------------------------------ */

export const salesInvoices = pgTable(
  "sales_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⭐ HUMAN-FACING AND NEVER ACCEPTED FROM A FORM. Rule 46(b) requires
     * a consecutive serial unique for a financial year. Derived inside
     * the transaction that writes the row; the unique index is the actual
     * guarantee, because two concurrent issues can read one maximum.
     */
    invoiceNumber: varchar("invoice_number", { length: 60 }).notNull(),
    /**
     * Stored beside the number rather than parsed out of it. A check that
     * parsed "AH/2026-27/000148" breaks the first time a workspace
     * changes its prefix — and they do, every April.
     */
    financialYear: varchar("financial_year", { length: 9 }).notNull(),

    status: salesInvoiceStatusEnum("status").default("draft").notNull(),

    /**
     * ⭐ THE COLUMN `billing.invoices` CANNOT HAVE, AND THE REASON THIS
     * TABLE EXISTS. Without a customer key there is no customer ledger,
     * because there is nothing to group a customer's documents by.
     *
     * RESTRICT: a company with an issued tax invoice against it cannot be
     * deleted. The document has to keep naming somebody.
     */
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),

    /**
     * ⚠️ NULLABLE ON PURPOSE. A service invoice or a counter sale has no
     * order behind it, and refusing those would send the workspace back
     * to Tally for exactly the documents this table exists to hold.
     */
    orderId: uuid("order_id").references(() => salesOrders.id, { onDelete: "restrict" }),

    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }),

    /**
     * ⚠️ CAPTURED AT ISSUE, NEVER JOINED AT READ TIME — Rule 46(d)–(f).
     * A customer who changes their registered name next year must not
     * restate the document we gave them this year.
     */
    customerLegalName: varchar("customer_legal_name", { length: 255 }),
    customerGstin: varchar("customer_gstin", { length: 15 }),
    customerAddress: jsonb("customer_address")
      .$type<{
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Rule 46(a) — ours, as it stood on the invoice date. */
    supplierRegistrationId: uuid("supplier_registration_id").references(
      () => gstRegistrations.id,
      { onDelete: "restrict" },
    ),
    supplierGstin: varchar("supplier_gstin", { length: 15 }),
    supplierStateCode: varchar("supplier_state_code", { length: 2 }),

    gstPartyId: uuid("gst_party_id").references(() => gstParties.id, {
      onDelete: "restrict",
    }),

    /**
     * ⚠️ STORED, NOT DERIVED ON READ. A legal determination made against
     * the facts on the invoice date. Derive it later and every historical
     * document silently re-splits CGST/SGST into IGST the day a delivery
     * address moves.
     */
    placeOfSupplyCode: varchar("place_of_supply_code", { length: 2 }),
    /** Which rule produced it. Shown in the working papers. */
    placeOfSupplyBasis: varchar("place_of_supply_basis", { length: 40 }),
    isInterState: boolean("is_inter_state").default(false).notNull(),
    /** Intra-UT supplies are CGST + UTGST and report in a different box. */
    isUnionTerritory: boolean("is_union_territory").default(false).notNull(),
    supplyType: varchar("supply_type", { length: 20 }).default("goods").notNull(),
    /** ⭐ Section 12(3): for immovable property the property decides. */
    propertyStateCode: varchar("property_state_code", { length: 2 }),

    /**
     * ⚠️ ON A SALES INVOICE, REVERSE-CHARGE TAX IS SHOWN AND NOT
     * COLLECTED — the recipient pays it to the Government. Charging it is
     * the error, and it stays invisible until the customer refuses to pay
     * the tax line. (On a PURCHASE it inverts: see `purchases.ts`.)
     */
    isReverseCharge: boolean("is_reverse_charge").default(false).notNull(),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /* --- Money — integer paise, computed by lib/gst/tax.ts ---------- */
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    otherChargesMinor: bigint("other_charges_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    roundOffMinor: bigint("round_off_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /**
     * ⭐ MAINTAINED BY TRIGGER FROM THE ALLOCATIONS, NEVER BY THE
     * APPLICATION. §2 of 0049 is the single writer.
     *
     * ⚠️ THE 0048 LESSON IS WRITTEN INTO THIS COLUMN. Its equivalent on
     * `sales_orders` had no writer at all, which made an entire credit
     * control feature inert without one line of code being wrong. Naming
     * the single writer is the fix; adding one is not.
     */
    receivedMinor: bigint("received_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /**
     * e-invoicing. Nullable: below the turnover threshold an IRN is not
     * required, and NOT NULL here would make the table unusable for every
     * small workspace. Assigned by the portal AFTER issue, which is why
     * the freeze trigger lets these move and nothing else.
     */
    irn: varchar("irn", { length: 64 }),
    irnGeneratedAt: timestamp("irn_generated_at", { withTimezone: true }),
    ackNo: varchar("ack_no", { length: 30 }),
    signedQrCode: text("signed_qr_code"),
    ewayBillNo: varchar("eway_bill_no", { length: 30 }),
    ewayBillDate: date("eway_bill_date", { mode: "string" }),

    /** ⚠️ ONE-WAY. Set when the document becomes a tax invoice. */
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),

    notes: text("notes"),
    terms: text("terms"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /** Names match the constraints 0049 creates. A diff between them is a lie. */
    numberPerTenant: uniqueIndex("sales_invoices_number_tenant_key").on(
      t.tenantId,
      t.invoiceNumber,
    ),
    /** Lets a child row carry a composite FK and never cross a tenant. */
    idTenantUnique: uniqueIndex("sales_invoices_id_tenant_key").on(t.id, t.tenantId),

    tenantIdx: index("sales_invoices_tenant_idx").on(t.tenantId, t.invoiceDate),
    /** ⭐ The customer-ledger index. The credit check reads it on every confirm. */
    companyIdx: index("sales_invoices_company_idx").on(t.tenantId, t.companyId, t.status),
    orderIdx: index("sales_invoices_order_idx").on(t.tenantId, t.orderId),
    statusIdx: index("sales_invoices_status_idx").on(t.tenantId, t.status, t.dueDate),
    fyIdx: index("sales_invoices_fy_idx").on(t.tenantId, t.financialYear),

    amountsNonNegative: check(
      "sales_invoices_amounts_non_negative",
      sql`${t.subtotalMinor} >= 0 AND ${t.taxableValueMinor} >= 0 AND ${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0 AND ${t.igstMinor} >= 0 AND ${t.cessMinor} >= 0 AND ${t.totalMinor} >= 0 AND ${t.receivedMinor} >= 0`,
    ),
    /**
     * ⚠️ IGST IS MUTUALLY EXCLUSIVE WITH CGST/SGST. A document carrying
     * both is a place-of-supply bug, not a rounding error, and it reaches
     * GSTR-1 as a mismatch the officer sees before we do.
     */
    gstMutuallyExclusive: check(
      "sales_invoices_gst_mutually_exclusive",
      sql`(${t.igstMinor} = 0) OR (${t.cgstMinor} = 0 AND ${t.sgstMinor} = 0)`,
    ),
    receivedWithinTotal: check(
      "sales_invoices_received_within_total",
      sql`${t.receivedMinor} <= ${t.totalMinor}`,
    ),
    issuedHasStamp: check(
      "sales_invoices_issued_has_stamp",
      sql`${t.status} = 'draft' OR ${t.status} = 'cancelled' OR (${t.issuedAt} IS NOT NULL)`,
    ),
    cancelHasReason: check(
      "sales_invoices_cancel_has_reason",
      sql`${t.status} <> 'cancelled' OR (${t.cancelledAt} IS NOT NULL AND ${t.cancelReason} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* SALES INVOICE LINES                                                 */
/* ------------------------------------------------------------------ */

export const salesInvoiceLines = pgTable(
  "sales_invoice_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").notNull(),

    lineNo: integer("line_no").notNull(),

    /**
     * ⭐ WHICH ORDER LINE THIS BILLS. What makes partial invoicing
     * possible, and what `qty_invoiced` on the order line is computed
     * from. Nullable for invoices raised without an order.
     */
    orderLineId: uuid("order_line_id"),

    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "restrict" }),
    sku: varchar("sku", { length: 100 }),
    /** ⚠️ COPIED, NEVER JOINED. A catalogue rename must not rewrite paperwork. */
    description: text("description").notNull(),

    hsnSacCodeId: uuid("hsn_sac_code_id").references(() => hsnSacCodes.id, {
      onDelete: "restrict",
    }),
    hsnSacRateId: uuid("hsn_sac_rate_id").references(() => hsnSacRates.id, {
      onDelete: "restrict",
    }),
    /**
     * Rule 46(g) prints the CODE. Held as text as well as by id, because
     * a rate row can be superseded and the document must still render.
     */
    hsnSacCode: varchar("hsn_sac_code", { length: 10 }),
    /** Basis points. 1800 = 18%. Pinned from the rate in force. */
    taxRateBps: integer("tax_rate_bps"),
    cessRateBps: integer("cess_rate_bps"),

    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    uom: varchar("uom", { length: 20 }).default("nos").notNull(),

    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineNoUnique: uniqueIndex("sales_invoice_lines_line_no_key").on(t.invoiceId, t.lineNo),
    invoiceIdx: index("sales_invoice_lines_invoice_idx").on(t.tenantId, t.invoiceId),
    orderLineIdx: index("sales_invoice_lines_order_line_idx").on(t.tenantId, t.orderLineId),
    positiveQuantity: check(
      "sales_invoice_lines_quantity_positive",
      sql`${t.quantity} > 0`,
    ),
    gstMutuallyExclusive: check(
      "sales_invoice_lines_gst_mutually_exclusive",
      sql`(${t.igstMinor} = 0) OR (${t.cgstMinor} = 0 AND ${t.sgstMinor} = 0)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CUSTOMER RECEIPTS                                                   */
/* ------------------------------------------------------------------ */

/**
 * Money in, from a company customer.
 *
 * ⚠️ NAMED `customerReceipts`, NOT `receipts`. `receipts` in
 * `./receivables` is keyed on `booking_id` — the real-estate side, where
 * the counterparty is a flat buyer and the money answers a RERA milestone
 * demand. This one is keyed on `company_id`. Two ledgers, two
 * counterparties; merging them would let one payment settle the wrong
 * kind of debt.
 */
export const customerReceipts = pgTable(
  "customer_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    receiptNumber: varchar("receipt_number", { length: 40 }).notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),

    receivedOn: date("received_on", { mode: "string" }).notNull(),
    /** What actually arrived. Paise. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /**
     * ⭐ TAX THE CUSTOMER WITHHELD — Section 194-Q, 194-C and friends.
     *
     * ⚠️ IT SETTLES THE INVOICE AS SURELY AS CASH DOES. A customer who
     * deducts TDS has paid that money — to the Government, on our behalf.
     * Treating it as a shortfall is how a fully-settled account shows as
     * overdue and a dunning letter goes to a customer who paid in full.
     */
    tdsCreditMinor: bigint("tds_credit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Sum of the allocation rows. Held in step by the trigger in 0049 §2. */
    allocatedMinor: bigint("allocated_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    method: customerReceiptMethodEnum("method").notNull(),
    status: customerReceiptStatusEnum("status").default("cleared").notNull(),

    /** Cheque number, UTR, UPI reference — what the customer will quote. */
    instrumentRef: varchar("instrument_ref", { length: 120 }),
    bankRef: varchar("bank_ref", { length: 120 }),
    clearedOn: date("cleared_on", { mode: "string" }),
    bouncedOn: date("bounced_on", { mode: "string" }),
    bounceReason: text("bounce_reason"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    numberPerTenant: uniqueIndex("customer_receipts_number_tenant_key").on(
      t.tenantId,
      t.receiptNumber,
    ),
    idTenantUnique: uniqueIndex("customer_receipts_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("customer_receipts_tenant_idx").on(t.tenantId, t.receivedOn),
    companyIdx: index("customer_receipts_company_idx").on(t.tenantId, t.companyId, t.status),
    /**
     * ⭐ Finds unapplied money — cash on a customer's account with no
     * invoice to answer. `allocatedMinor` is in the index so the question
     * is answered from it rather than by reading every receipt ever taken.
     */
    unappliedIdx: index("customer_receipts_unapplied_idx").on(
      t.tenantId,
      t.companyId,
      t.allocatedMinor,
      t.amountMinor,
    ),
    amountPositive: check("customer_receipts_amount_positive", sql`${t.amountMinor} > 0`),
    tdsNonNegative: check(
      "customer_receipts_tds_non_negative",
      sql`${t.tdsCreditMinor} >= 0`,
    ),
    /**
     * ⭐ YOU CANNOT ALLOCATE MORE THAN ARRIVED. Cash plus withheld tax is
     * the total settling power of this receipt.
     */
    allocatedWithinAmount: check(
      "customer_receipts_allocated_within_amount",
      sql`${t.allocatedMinor} <= ${t.amountMinor} + ${t.tdsCreditMinor}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ALLOCATION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which receipt settled which invoice, and by how much.
 *
 * ⚠️ ONE ROW PER (receipt, invoice). A second row for the same pair is an
 * amendment, and an amendment that ADDS rather than REPLACES is how a
 * ledger quietly double-counts a payment.
 */
export const customerReceiptAllocations = pgTable(
  "customer_receipt_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    receiptId: uuid("receipt_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),

    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    allocatedOn: date("allocated_on", { mode: "string" }).notNull(),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    pairUnique: uniqueIndex("customer_receipt_allocations_pair_key").on(
      t.receiptId,
      t.invoiceId,
    ),
    receiptIdx: index("customer_receipt_allocations_receipt_idx").on(t.tenantId, t.receiptId),
    invoiceIdx: index("customer_receipt_allocations_invoice_idx").on(t.tenantId, t.invoiceId),
    amountPositive: check(
      "customer_receipt_allocations_amount_positive",
      sql`${t.amountMinor} > 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const salesInvoicesRelations = relations(salesInvoices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [salesInvoices.tenantId], references: [tenants.id] }),
  company: one(companies, { fields: [salesInvoices.companyId], references: [companies.id] }),
  order: one(salesOrders, { fields: [salesInvoices.orderId], references: [salesOrders.id] }),
  lines: many(salesInvoiceLines),
  allocations: many(customerReceiptAllocations),
}));

export const salesInvoiceLinesRelations = relations(salesInvoiceLines, ({ one }) => ({
  invoice: one(salesInvoices, {
    fields: [salesInvoiceLines.invoiceId],
    references: [salesInvoices.id],
  }),
  orderLine: one(salesOrderLines, {
    fields: [salesInvoiceLines.orderLineId],
    references: [salesOrderLines.id],
  }),
}));

export const customerReceiptsRelations = relations(customerReceipts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [customerReceipts.tenantId], references: [tenants.id] }),
  company: one(companies, {
    fields: [customerReceipts.companyId],
    references: [companies.id],
  }),
  allocations: many(customerReceiptAllocations),
}));

export const customerReceiptAllocationsRelations = relations(
  customerReceiptAllocations,
  ({ one }) => ({
    receipt: one(customerReceipts, {
      fields: [customerReceiptAllocations.receiptId],
      references: [customerReceipts.id],
    }),
    invoice: one(salesInvoices, {
      fields: [customerReceiptAllocations.invoiceId],
      references: [salesInvoices.id],
    }),
  }),
);

export type SalesInvoice = typeof salesInvoices.$inferSelect;
export type SalesInvoiceLine = typeof salesInvoiceLines.$inferSelect;
export type CustomerReceipt = typeof customerReceipts.$inferSelect;
export type CustomerReceiptAllocation = typeof customerReceiptAllocations.$inferSelect;
export type SalesInvoiceStatus = (typeof salesInvoiceStatusEnum.enumValues)[number];

/* ------------------------------------------------------------------ */
/* ⭐ CREDIT NOTES — Phase 52                                           */
/* ------------------------------------------------------------------ */

/**
 * The only lawful way to reduce an issued tax invoice (Section 34(1)).
 *
 * ⚠️ A CREDIT NOTE IS NOT AN EDIT AND MUST NEVER BECOME ONE. Both
 * documents keep existing: the customer holds the original invoice and
 * may already have claimed input credit on it, and the pair has to
 * reconcile in their books and ours.
 *
 * ⚠️ THERE IS NO DEBIT NOTE HERE. A debit note INCREASES what is owed and
 * under Section 34(3) that is a supply — it needs its own tax
 * determination, not a mirror of this table with a sign column. A sign
 * column is how a refund eventually gets recorded as a charge.
 */
export const salesCreditNotes = pgTable(
  "sales_credit_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    creditNoteNumber: varchar("credit_note_number", { length: 60 }).notNull(),
    financialYear: varchar("financial_year", { length: 9 }).notNull(),
    /** Shares the invoice status enum — the lifecycle is the same shape. */
    status: salesInvoiceStatusEnum("status").default("draft").notNull(),

    /**
     * ⭐ ALWAYS AGAINST AN INVOICE, AND NOT NULL.
     *
     * ⚠️ A FREE-FLOATING CREDIT NOTE IS UNRECONCILABLE. GSTR-1 reports it
     * against the original document and the customer matches it against
     * the invoice in their books. One that names no invoice is a
     * reduction nobody can tie to a supply — the first thing an officer
     * asks about.
     */
    invoiceId: uuid("invoice_id").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),

    noteDate: date("note_date", { mode: "string" }).notNull(),

    /** Section 34(1) grounds. varchar so a new ground is a row, not a migration. */
    reasonCode: varchar("reason_code", { length: 40 }).notNull(),
    /** ⚠️ Free text and required — it is read aloud to a customer. */
    reason: text("reason").notNull(),

    customerLegalName: varchar("customer_legal_name", { length: 255 }),
    customerGstin: varchar("customer_gstin", { length: 15 }),
    supplierGstin: varchar("supplier_gstin", { length: 15 }),
    placeOfSupplyCode: varchar("place_of_supply_code", { length: 2 }),
    isInterState: boolean("is_inter_state").default(false).notNull(),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    roundOffMinor: bigint("round_off_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    numberPerTenant: uniqueIndex("sales_credit_notes_number_tenant_key").on(
      t.tenantId,
      t.creditNoteNumber,
    ),
    idTenantUnique: uniqueIndex("sales_credit_notes_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("sales_credit_notes_tenant_idx").on(t.tenantId, t.noteDate),
    invoiceIdx: index("sales_credit_notes_invoice_idx").on(t.tenantId, t.invoiceId),
    companyIdx: index("sales_credit_notes_company_idx").on(t.tenantId, t.companyId, t.status),
    gstMutuallyExclusive: check(
      "sales_credit_notes_gst_mutually_exclusive",
      sql`(${t.igstMinor} = 0) OR (${t.cgstMinor} = 0 AND ${t.sgstMinor} = 0)`,
    ),
  }),
);

export const salesCreditNoteLines = pgTable(
  "sales_credit_note_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    creditNoteId: uuid("credit_note_id").notNull(),
    lineNo: integer("line_no").notNull(),
    /** Which invoice line is reduced. Null only for a whole-document adjustment. */
    invoiceLineId: uuid("invoice_line_id"),

    description: text("description").notNull(),
    hsnSacCode: varchar("hsn_sac_code", { length: 10 }),
    taxRateBps: integer("tax_rate_bps"),
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    uom: varchar("uom", { length: 20 }).default("nos").notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineNoUnique: uniqueIndex("sales_credit_note_lines_line_no_key").on(
      t.creditNoteId,
      t.lineNo,
    ),
    parentIdx: index("sales_credit_note_lines_parent_idx").on(t.tenantId, t.creditNoteId),
    positiveQuantity: check(
      "sales_credit_note_lines_quantity_positive",
      sql`${t.quantity} > 0`,
    ),
  }),
);

export const salesCreditNotesRelations = relations(salesCreditNotes, ({ one, many }) => ({
  invoice: one(salesInvoices, {
    fields: [salesCreditNotes.invoiceId],
    references: [salesInvoices.id],
  }),
  company: one(companies, {
    fields: [salesCreditNotes.companyId],
    references: [companies.id],
  }),
  lines: many(salesCreditNoteLines),
}));

export type SalesCreditNote = typeof salesCreditNotes.$inferSelect;
export type SalesCreditNoteLine = typeof salesCreditNoteLines.$inferSelect;
