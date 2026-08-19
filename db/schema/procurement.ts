/**
 * Ordence — ⭐⭐⭐ ORDERS, RECEIPTS AND VENDOR PAYMENTS
 * Version: v1.11.0-alpha  ·  SQL 0063
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TDS ENGINE HAS EXISTED SINCE 0025 AND NOTHING REACHED IT
 * ══════════════════════════════════════════════════════════════════════
 * Sections, thresholds, catch-up bases, lower deduction certificates,
 * challans, quarterly returns and interest exposure are all built. The
 * posting gate has said why for twenty sessions: tax is deducted when
 * the money MOVES, and there were no payments.
 *
 * ⭐ Not a missing feature. A missing **event**. This is the event.
 *
 * ⚠️ AND A PAYMENT RUN OVER UNMATCHED BILLS PAYS THE WRONG THINGS
 * FASTER, which is why the order and the receipt are in the same
 * migration as the payment rather than a session earlier.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { vendors, purchaseInvoices } from "./purchases";

/* ------------------------------------------------------------------ */
/* WHAT WAS ORDERED                                                    */
/* ------------------------------------------------------------------ */

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),

    poNumber: varchar("po_number", { length: 40 }).notNull(),
    poDate: date("po_date", { mode: "string" }).notNull(),
    expectedOn: date("expected_on", { mode: "string" }),

    /**
     * ⭐ THE WRITTEN AGREEMENT ON CREDIT DAYS, AND IT MATTERS MORE THAN
     * PEOPLE THINK. s.15 MSMED allows fifteen days by default and
     * forty-five only where there is a written agreement. This IS that
     * agreement, and the payment run reads it. Capped at 45 by the
     * database, because no contract can lawfully exceed it.
     */
    agreedCreditDays: integer("agreed_credit_days"),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).default(0n).notNull(),
    taxMinor: bigint("tax_minor", { mode: "bigint" }).default(0n).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(0n).notNull(),

    status: varchar("status", { length: 20 }).default("draft").notNull(),
    /** 🔴 An approved order with no approver is a commitment nobody made. */
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    closedReason: varchar("closed_reason", { length: 300 }),

    notes: text("notes"),
    terms: text("terms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    numberUnique: uniqueIndex("purchase_orders_number_unique").on(t.tenantId, t.poNumber),
    openIdx: index("purchase_orders_open_idx")
      .on(t.tenantId, t.vendorId, t.poDate)
      .where(sql`${t.status} IN ('approved', 'part_received')`),
  }),
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    stockItemId: uuid("stock_item_id"),
    hsnSacCode: varchar("hsn_sac_code", { length: 10 }),
    uom: varchar("uom", { length: 20 }),

    /** ⭐ Thousandths, the same convention as the stock ledger. */
    orderedQty: bigint("ordered_qty", { mode: "bigint" }).notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    taxRateBps: integer("tax_rate_bps").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineUnique: uniqueIndex("purchase_order_lines_no_unique").on(t.poId, t.lineNo),
    poIdx: index("purchase_order_lines_po_idx").on(t.tenantId, t.poId),
  }),
);

/* ------------------------------------------------------------------ */
/* WHAT ARRIVED                                                        */
/* ------------------------------------------------------------------ */

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "restrict" }),

    grnNumber: varchar("grn_number", { length: 40 }).notNull(),
    /**
     * 🔴 NOT PAPERWORK. s.15 MSMED runs from ACCEPTANCE, and where
     * nobody objects in writing acceptance is deemed fifteen days after
     * delivery. The date on this row is the date the deduction clock
     * starts, not the date the vendor printed on the invoice.
     */
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    challanNo: varchar("challan_no", { length: 80 }),
    challanDate: date("challan_date", { mode: "string" }),
    warehouseId: uuid("warehouse_id"),
    receivedBy: uuid("received_by").references(() => users.id, { onDelete: "set null" }),

    status: varchar("status", { length: 20 }).default("received").notNull(),
    rejectionReason: varchar("rejection_reason", { length: 500 }),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    numberUnique: uniqueIndex("goods_receipts_number_unique").on(t.tenantId, t.grnNumber),
    poIdx: index("goods_receipts_po_idx")
      .on(t.tenantId, t.poId)
      .where(sql`${t.poId} IS NOT NULL`),
  }),
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    grnId: uuid("grn_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    poLineId: uuid("po_line_id").references(() => purchaseOrderLines.id, {
      onDelete: "restrict",
    }),

    lineNo: integer("line_no").notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    stockItemId: uuid("stock_item_id"),

    acceptedQty: bigint("accepted_qty", { mode: "bigint" }).default(0n).notNull(),
    /** ⭐ Kept apart. Rejected goods were delivered and are not payable. */
    rejectedQty: bigint("rejected_qty", { mode: "bigint" }).default(0n).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineUnique: uniqueIndex("goods_receipt_lines_no_unique").on(t.grnId, t.lineNo),
    poLineIdx: index("goods_receipt_lines_po_line_idx")
      .on(t.tenantId, t.poLineId)
      .where(sql`${t.poLineId} IS NOT NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* THE PAYMENT                                                         */
/* ------------------------------------------------------------------ */

export const vendorPayments = pgTable(
  "vendor_payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),

    paymentNumber: varchar("payment_number", { length: 40 }).notNull(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    method: varchar("method", { length: 20 }).default("bank_transfer").notNull(),
    bankReference: varchar("bank_reference", { length: 120 }),
    bankLedgerId: uuid("bank_ledger_id"),

    /**
     * 🔴 THREE AMOUNTS, AND THEY ARE NOT THE SAME NUMBER. A payments
     * table with one "amount" column cannot say which of the three it
     * holds, and every reconciliation afterwards is a guess.
     */
    grossMinor: bigint("gross_minor", { mode: "bigint" }).notNull(),
    tdsMinor: bigint("tds_minor", { mode: "bigint" }).default(0n).notNull(),
    /** ⭐ s.16 MSMED. Mandatory, compounding, never deductible. */
    msmeInterestMinor: bigint("msme_interest_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
    roundOffMinor: bigint("round_off_minor", { mode: "bigint" }).default(0n).notNull(),
    netMinor: bigint("net_minor", { mode: "bigint" }).notNull(),

    tdsSection: varchar("tds_section", { length: 12 }),
    /** The row the existing TDS engine wrote. */
    tdsDeductionId: uuid("tds_deduction_id"),

    status: varchar("status", { length: 20 }).default("draft").notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    voidReason: varchar("void_reason", { length: 300 }),

    /** ⭐ Payments approved together share a run. */
    runId: uuid("run_id"),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    numberUnique: uniqueIndex("vendor_payments_number_unique").on(
      t.tenantId,
      t.paymentNumber,
    ),
    vendorIdx: index("vendor_payments_vendor_idx").on(
      t.tenantId,
      t.vendorId,
      t.paymentDate,
    ),
    runIdx: index("vendor_payments_run_idx")
      .on(t.tenantId, t.runId)
      .where(sql`${t.runId} IS NOT NULL`),
  }),
);

export const vendorPaymentAllocations = pgTable(
  "vendor_payment_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => vendorPayments.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: "restrict" }),

    allocatedMinor: bigint("allocated_minor", { mode: "bigint" }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    unique: uniqueIndex("vendor_payment_allocations_unique").on(t.paymentId, t.invoiceId),
    invoiceIdx: index("vendor_payment_allocations_invoice_idx").on(
      t.tenantId,
      t.invoiceId,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const purchaseOrdersRelations = relations(purchaseOrders, ({ one, many }) => ({
  vendor: one(vendors, { fields: [purchaseOrders.vendorId], references: [vendors.id] }),
  lines: many(purchaseOrderLines),
  receipts: many(goodsReceipts),
}));

export const purchaseOrderLinesRelations = relations(purchaseOrderLines, ({ one }) => ({
  order: one(purchaseOrders, {
    fields: [purchaseOrderLines.poId],
    references: [purchaseOrders.id],
  }),
}));

export const goodsReceiptsRelations = relations(goodsReceipts, ({ one, many }) => ({
  vendor: one(vendors, { fields: [goodsReceipts.vendorId], references: [vendors.id] }),
  order: one(purchaseOrders, {
    fields: [goodsReceipts.poId],
    references: [purchaseOrders.id],
  }),
  lines: many(goodsReceiptLines),
}));

export const goodsReceiptLinesRelations = relations(goodsReceiptLines, ({ one }) => ({
  receipt: one(goodsReceipts, {
    fields: [goodsReceiptLines.grnId],
    references: [goodsReceipts.id],
  }),
  orderLine: one(purchaseOrderLines, {
    fields: [goodsReceiptLines.poLineId],
    references: [purchaseOrderLines.id],
  }),
}));

export const vendorPaymentsRelations = relations(vendorPayments, ({ one, many }) => ({
  vendor: one(vendors, { fields: [vendorPayments.vendorId], references: [vendors.id] }),
  allocations: many(vendorPaymentAllocations),
}));

export const vendorPaymentAllocationsRelations = relations(
  vendorPaymentAllocations,
  ({ one }) => ({
    payment: one(vendorPayments, {
      fields: [vendorPaymentAllocations.paymentId],
      references: [vendorPayments.id],
    }),
    invoice: one(purchaseInvoices, {
      fields: [vendorPaymentAllocations.invoiceId],
      references: [purchaseInvoices.id],
    }),
  }),
);
