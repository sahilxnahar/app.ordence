/**
 * Ordence — ⭐ Sales Orders, Order Lines and Fulfilment
 * Version: v0.39.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT PHASE 39 IS: THE MISSING NOUN
 * ══════════════════════════════════════════════════════════════════════
 * Until this file existed, Ordence could describe an OPPORTUNITY (a deal),
 * a UNIT SALE (a booking) and a TAX DOCUMENT (an invoice) — and nothing in
 * between. That gap is why roughly twenty catalogued features could not be
 * built: there was no row to hang them on.
 *
 * An ORDER is the thing a customer has agreed to buy that has not yet been
 * delivered. It is not a deal, because a deal is a probability and an order
 * is a commitment. It is not an invoice, because an invoice is a demand for
 * money and an order is a promise of goods. And it is emphatically not a
 * booking, because a booking sells one identified immovable unit that
 * cannot be shipped, back-ordered, part-delivered or restocked.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE INVARIANT THIS PHASE EXISTS TO PROTECT
 * ══════════════════════════════════════════════════════════════════════
 *
 *        A CONFIRMED ORDER LINE'S PRICE AND QUANTITY DO NOT MOVE.
 *
 * Every downstream number is derived from the line: what may be dispatched,
 * what may be invoiced, what revenue may be recognised, what commission is
 * owed, what the customer may dispute. If the line can be edited after
 * confirmation, then a part-delivered order can be silently re-priced,
 * every one of those derived figures changes retroactively, and NOTHING
 * anywhere records that it happened. The delivery note printed last Tuesday
 * and the order it came from stop agreeing, and the first person to notice
 * is a customer holding a piece of paper.
 *
 * So confirmation freezes the line. A change after that is an amendment: a
 * new revision, recorded, attributed and visible — enforced by a trigger in
 * `SQL-FILES/0028_phase39_orders.sql`, not by this file and not by the
 * server actions, because a back-fill and a psql prompt are also write
 * paths and a rule enforced in one place is a rule the others bypass.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ QUANTITY IS THREE SEPARATE FACTS, NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * `quantity` is what was ordered. `qtyFulfilled` is what has left the
 * building. `qtyCancelled` is what never will. A single "remaining" column
 * cannot distinguish "not shipped yet" from "short-shipped and closed",
 * and those two states owe the customer opposite things — one owes goods,
 * the other owes a credit note. The database checks
 * `qty_fulfilled + qty_cancelled <= quantity`; it does not compute the
 * remainder, because the remainder is a question and not a fact.
 *
 * ⚠️ `qtyInvoiced` IS TRACKED SEPARATELY FROM `qtyFulfilled` AND THEY DO
 * NOT HAVE TO MATCH. Advance-billed goods are invoiced before dispatch;
 * goods sent on approval are dispatched before invoice. Forcing them equal
 * is the most common way an ERP makes an honest business look fraudulent
 * to its own auditor.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TAX IS PINNED, NOT LOOKED UP
 * ══════════════════════════════════════════════════════════════════════
 * The line stores `hsnSacRateId` — the DATED rate row that was in force on
 * the order date — exactly as sales and purchase invoices do since Phase
 * 32/33, with ON DELETE RESTRICT. A rate change next quarter must not
 * silently restate an order confirmed this quarter. The tax AMOUNTS are
 * likewise stored, computed once by `computeInvoiceTax` and never
 * recomputed on read.
 *
 * Money is `bigint` paise. Rates are integer basis points. Quantities are
 * `numeric(18,3)` because half a tonne of cement is a real quantity and a
 * float would round it.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  jsonb,
  boolean,
  integer,
  bigint,
  numeric,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { companies, contacts, deals } from "./crm";
import { assets } from "./assets";
import { projects, bookings, channelPartners } from "./sales";
import { gstParties, gstRegistrations, hsnSacCodes, hsnSacRates } from "./gst";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * Where the order came from.
 *
 * ⚠️ NOT COSMETIC. An order created through the public REST API by a
 * customer's own procurement system has had no human read it, and the
 * confirmation rules for it are different from an order a salesperson
 * typed. Recording the origin is what lets a later phase apply that
 * difference without guessing.
 */
export const orderSourceEnum = pgEnum("sales_order_source", [
  "manual",
  "quote",
  "portal",
  "api",
  "import",
  "recurring",
]);

/**
 * ⭐ THE ORDER LIFECYCLE.
 *
 * `draft` is the only editable state. Everything after it is frozen at the
 * line level. The two terminal states differ in meaning and must not be
 * merged: `closed` is an order that finished — delivered, invoiced, done —
 * and `cancelled` is an order that stopped. Reporting "orders completed"
 * over a merged status is a number that overstates delivery, and it is the
 * number a board deck uses.
 *
 * `partially_fulfilled` exists because it is the state most orders spend
 * most of their life in, and an ERP that cannot name it forces the operator
 * to choose between two lies.
 */
export const orderStatusEnum = pgEnum("sales_order_status", [
  "draft",
  "pending_approval",
  "confirmed",
  "partially_fulfilled",
  "fulfilled",
  "closed",
  "cancelled",
  "on_hold",
]);

/** What a fulfilment event physically is. */
export const fulfillmentStatusEnum = pgEnum("sales_fulfillment_status", [
  "planned",
  "picked",
  "dispatched",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
]);

/**
 * How a line is priced.
 *
 * ⚠️ `service` and `goods` are separated because they attract different
 * TDS sections, different place-of-supply rules and different revenue
 * recognition timing. A line that cannot say which it is cannot be taxed
 * correctly, and the mistake surfaces at a return, not at entry.
 */
export const orderLineKindEnum = pgEnum("sales_order_line_kind", [
  "goods",
  "service",
  "works_contract",
  "freight",
  "discount",
  "other_charge",
]);

/* ------------------------------------------------------------------ */
/* SALES ORDERS                                                        */
/* ------------------------------------------------------------------ */

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠️ HUMAN-FACING AND UNIQUE PER TENANT. Quoted on every delivery
     * note, every invoice and every phone call about this order. Generated
     * server-side from a per-tenant sequence — never accepted from a form,
     * because a caller who can choose the number can collide with a
     * document already in a customer's file.
     */
    orderNo: varchar("order_no", { length: 60 }).notNull(),

    /** Customer's own PO reference. Free text: it is their format, not ours. */
    customerReference: varchar("customer_reference", { length: 120 }),

    status: orderStatusEnum("status").default("draft").notNull(),
    source: orderSourceEnum("source").default("manual").notNull(),

    /**
     * ⭐ THE REVISION COUNTER. Increments on every accepted amendment
     * after confirmation. A delivery note prints it, so a warehouse
     * holding revision 2 of a paper order can tell it is stale.
     */
    revision: integer("revision").default(0).notNull(),

    orderDate: date("order_date").notNull(),
    /** Date the customer has been promised. Not the date we intend to ship. */
    promisedDate: date("promised_date"),
    expectedDispatchDate: date("expected_dispatch_date"),

    /* --- Counterparty ---------------------------------------------- */
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    /** The GSTIN the order is billed to. Decides the tax split. */
    gstPartyId: uuid("gst_party_id").references(() => gstParties.id, {
      onDelete: "restrict",
    }),
    /** Which of OUR registrations supplies it. Decides the same. */
    sellerRegistrationId: uuid("seller_registration_id").references(
      () => gstRegistrations.id,
      { onDelete: "restrict" },
    ),

    /**
     * ⚠️ PLACE OF SUPPLY IS STORED, NOT DERIVED ON READ. It is a legal
     * determination made against the facts on the order date, and the
     * facts change — a customer moves a delivery address, and every
     * historical order would silently re-split CGST/SGST into IGST.
     */
    placeOfSupplyCode: varchar("place_of_supply_code", { length: 2 }),
    isInterState: boolean("is_inter_state"),

    /* --- Provenance ------------------------------------------------- */
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    /** Set only when this order is the goods half of a unit booking. */
    bookingId: uuid("booking_id").references(() => bookings.id, {
      onDelete: "set null",
    }),
    channelPartnerId: uuid("channel_partner_id").references(
      () => channelPartners.id,
      { onDelete: "set null" },
    ),

    /* --- Money — every figure integer paise ------------------------- */
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** Freight, insurance, packing — taxable, but not a product line. */
    otherChargesMinor: bigint("other_charges_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    roundOffMinor: bigint("round_off_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /**
     * ⭐ THE THREE PROGRESS FIGURES, MAINTAINED BY TRIGGER FROM THE LINES.
     *
     * ⚠️ They are DENORMALISED ON PURPOSE and they are NOT written by the
     * application. An order list that had to sum every line of every order
     * to show a fulfilment column would be the slowest screen in the
     * product; an application that maintained them would drift the first
     * time a line was touched outside a server action. The trigger in
     * SQL 0028 §4 recomputes them from the lines on every line write.
     */
    fulfilledValueMinor: bigint("fulfilled_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    invoicedValueMinor: bigint("invoiced_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    receivedValueMinor: bigint("received_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /* --- Terms ------------------------------------------------------ */
    paymentTermsDays: integer("payment_terms_days"),
    paymentTermsNote: varchar("payment_terms_note", { length: 300 }),
    incoterm: varchar("incoterm", { length: 20 }),

    /* --- Where it goes ---------------------------------------------- */
    shippingName: varchar("shipping_name", { length: 200 }),
    shippingLine1: varchar("shipping_line1", { length: 255 }),
    shippingLine2: varchar("shipping_line2", { length: 255 }),
    shippingCity: varchar("shipping_city", { length: 120 }),
    shippingState: varchar("shipping_state", { length: 120 }),
    shippingPostalCode: varchar("shipping_postal_code", { length: 20 }),
    shippingCountry: varchar("shipping_country", { length: 2 }).default("IN"),
    shippingPhone: varchar("shipping_phone", { length: 40 }),

    /* --- Approval --------------------------------------------------- */
    requiresApproval: boolean("requires_approval").default(false).notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    /**
     * ⚠️ A CANCELLATION CARRIES A NAMED HUMAN AND A REASON, OR IT DOES NOT
     * HAPPEN. Cancelling a confirmed order destroys a commitment somebody
     * made to a customer. The database refuses `cancelled` without both
     * (SQL 0028 §6).
     */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, {
      onDelete: "set null",
    }),
    cancellationReason: text("cancellation_reason"),

    holdReason: text("hold_reason"),

    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    notes: text("notes"),
    /** Printed on the customer's copy. Distinct from internal `notes`. */
    customerNotes: text("customer_notes"),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("sales_orders_tenant_idx").on(t.tenantId),
    tenantStatusIdx: index("sales_orders_tenant_status_idx").on(t.tenantId, t.status),
    tenantDateIdx: index("sales_orders_tenant_date_idx").on(t.tenantId, t.orderDate),
    tenantCompanyIdx: index("sales_orders_tenant_company_idx").on(
      t.tenantId,
      t.companyId,
    ),
    tenantOwnerIdx: index("sales_orders_tenant_owner_idx").on(t.tenantId, t.ownerUserId),
    tenantProjectIdx: index("sales_orders_tenant_project_idx").on(
      t.tenantId,
      t.projectId,
    ),
    /** The order number is the customer-facing key. One per tenant, always. */
    tenantOrderNoUnique: uniqueIndex("sales_orders_tenant_order_no_unique")
      .on(t.tenantId, t.orderNo)
      .where(sql`${t.deletedAt} IS NULL`),
    /** ⭐ Required by the composite foreign keys on every child table. */
    tenantIdUnique: uniqueIndex("sales_orders_id_tenant_unique").on(t.id, t.tenantId),
    promisedIdx: index("sales_orders_promised_idx")
      .on(t.tenantId, t.promisedDate)
      .where(sql`${t.status} IN ('confirmed','partially_fulfilled')`),

    nonNegativeTotal: check(
      "sales_orders_total_non_negative",
      sql`${t.totalMinor} >= 0`,
    ),
    /** Progress can never exceed the order. Cheap, and catches trigger bugs. */
    fulfilledWithinTotal: check(
      "sales_orders_fulfilled_within_total",
      sql`${t.fulfilledValueMinor} <= ${t.totalMinor}`,
    ),
    invoicedWithinTotal: check(
      "sales_orders_invoiced_within_total",
      sql`${t.invoicedValueMinor} <= ${t.totalMinor}`,
    ),
    revisionNonNegative: check(
      "sales_orders_revision_non_negative",
      sql`${t.revision} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ORDER LINES                                                         */
/* ------------------------------------------------------------------ */

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").notNull(),

    /** Printed position. Stable across amendments so paperwork agrees. */
    lineNo: integer("line_no").notNull(),
    kind: orderLineKindEnum("kind").default("goods").notNull(),

    /**
     * What is being sold. `assetId` points at the catalog item where one
     * exists; `description` is always present, because it is what prints
     * and a catalog rename must not rewrite last year's paperwork.
     */
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "restrict" }),
    sku: varchar("sku", { length: 100 }),
    description: text("description").notNull(),

    /* --- Classification and the PINNED rate ------------------------- */
    hsnSacCodeId: uuid("hsn_sac_code_id").references(() => hsnSacCodes.id, {
      onDelete: "restrict",
    }),
    /**
     * ⭐ THE DATED RATE ROW IN FORCE ON THE ORDER DATE. ON DELETE RESTRICT
     * for the same reason a sales invoice pins it: a rate row that can be
     * deleted is a historical document that can silently change its tax.
     */
    hsnSacRateId: uuid("hsn_sac_rate_id").references(() => hsnSacRates.id, {
      onDelete: "restrict",
    }),
    /** Basis points. 1800 = 18%. Copied from the pinned rate at confirmation. */
    taxRateBps: integer("tax_rate_bps"),
    cessRateBps: integer("cess_rate_bps"),

    /* --- Quantity: three facts, never one --------------------------- */
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    uom: varchar("uom", { length: 20 }).default("nos").notNull(),
    qtyFulfilled: numeric("qty_fulfilled", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    qtyInvoiced: numeric("qty_invoiced", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    qtyCancelled: numeric("qty_cancelled", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    qtyReturned: numeric("qty_returned", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),

    /* --- Money — integer paise -------------------------------------- */
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * Warehouse this line ships from. Nullable until inventory exists as
     * its own phase; recorded here now so that phase does not have to
     * rewrite confirmed orders to acquire it.
     */
    warehouseCode: varchar("warehouse_code", { length: 60 }),

    requestedDate: date("requested_date"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("sales_order_lines_tenant_idx").on(t.tenantId),
    orderIdx: index("sales_order_lines_order_idx").on(t.tenantId, t.orderId),
    assetIdx: index("sales_order_lines_asset_idx").on(t.tenantId, t.assetId),
    lineNoUnique: uniqueIndex("sales_order_lines_order_line_no_unique").on(
      t.orderId,
      t.lineNo,
    ),
    tenantIdUnique: uniqueIndex("sales_order_lines_id_tenant_unique").on(
      t.id,
      t.tenantId,
    ),

    positiveQuantity: check(
      "sales_order_lines_quantity_positive",
      sql`${t.quantity} > 0`,
    ),
    /**
     * ⭐ THE CENTRAL QUANTITY INVARIANT. Shipped plus written-off can never
     * exceed ordered. Without it, a double-clicked dispatch button ships
     * goods the customer never ordered and the order still looks correct.
     */
    fulfilmentWithinOrder: check(
      "sales_order_lines_fulfilment_within_order",
      sql`${t.qtyFulfilled} + ${t.qtyCancelled} <= ${t.quantity}`,
    ),
    invoicedWithinOrder: check(
      "sales_order_lines_invoiced_within_order",
      sql`${t.qtyInvoiced} <= ${t.quantity}`,
    ),
    returnedWithinFulfilled: check(
      "sales_order_lines_returned_within_fulfilled",
      sql`${t.qtyReturned} <= ${t.qtyFulfilled}`,
    ),
    nonNegativeProgress: check(
      "sales_order_lines_progress_non_negative",
      sql`${t.qtyFulfilled} >= 0 AND ${t.qtyInvoiced} >= 0 AND ${t.qtyCancelled} >= 0 AND ${t.qtyReturned} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* FULFILMENTS  (the dispatch event)                                   */
/* ------------------------------------------------------------------ */

export const salesOrderFulfillments = pgTable(
  "sales_order_fulfillments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").notNull(),

    /** Printed on the delivery challan. Unique per tenant. */
    fulfillmentNo: varchar("fulfillment_no", { length: 60 }).notNull(),
    status: fulfillmentStatusEnum("status").default("planned").notNull(),

    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),

    carrierName: varchar("carrier_name", { length: 150 }),
    trackingNumber: varchar("tracking_number", { length: 120 }),
    vehicleNumber: varchar("vehicle_number", { length: 40 }),
    driverName: varchar("driver_name", { length: 150 }),
    driverPhone: varchar("driver_phone", { length: 40 }),

    /**
     * ⚠️ THE E-WAY BILL NUMBER, WHERE ONE IS REQUIRED. A consignment above
     * the threshold moving without it is detained, and the fine is on the
     * consignor. Stored, not derived, because whether one was required is
     * a fact about the day the lorry left.
     */
    ewayBillNo: varchar("eway_bill_no", { length: 30 }),
    ewayBillDate: date("eway_bill_date"),

    /** Who signed for it. The only evidence delivery happened. */
    receivedBy: varchar("received_by", { length: 200 }),
    proofDocumentId: uuid("proof_document_id"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("sales_order_fulfillments_tenant_idx").on(t.tenantId),
    orderIdx: index("sales_order_fulfillments_order_idx").on(t.tenantId, t.orderId),
    statusIdx: index("sales_order_fulfillments_status_idx").on(t.tenantId, t.status),
    noUnique: uniqueIndex("sales_order_fulfillments_no_unique").on(
      t.tenantId,
      t.fulfillmentNo,
    ),
    tenantIdUnique: uniqueIndex("sales_order_fulfillments_id_tenant_unique").on(
      t.id,
      t.tenantId,
    ),
  }),
);

export const salesOrderFulfillmentLines = pgTable(
  "sales_order_fulfillment_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fulfillmentId: uuid("fulfillment_id").notNull(),
    orderLineId: uuid("order_line_id").notNull(),

    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    /** Batch / lot / serial, when the goods carry one. */
    batchNo: varchar("batch_no", { length: 100 }),
    serialNumbers: jsonb("serial_numbers")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("sales_order_fulfillment_lines_tenant_idx").on(t.tenantId),
    fulfillmentIdx: index("sales_order_fulfillment_lines_fulfillment_idx").on(
      t.tenantId,
      t.fulfillmentId,
    ),
    orderLineIdx: index("sales_order_fulfillment_lines_order_line_idx").on(
      t.tenantId,
      t.orderLineId,
    ),
    onePerLine: uniqueIndex("sales_order_fulfillment_lines_unique").on(
      t.fulfillmentId,
      t.orderLineId,
    ),
    positiveQuantity: check(
      "sales_order_fulfillment_lines_quantity_positive",
      sql`${t.quantity} > 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ORDER EVENTS  (the amendment and transition record)                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHY THIS TABLE IS NOT THE AUDIT LOG.
 *
 * `audit_logs` records that a row changed, for our forensics. This records
 * what happened to the ORDER, for the customer's — it is what a service
 * agent reads aloud on the phone, and what prints on an order history
 * page. They have different readers, different retention and different
 * languages, and collapsing them means either an audit trail full of
 * customer prose or a customer history full of column names.
 */
export const salesOrderEvents = pgTable(
  "sales_order_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").notNull(),

    /** e.g. "confirmed", "amended", "dispatched", "cancelled". */
    eventType: varchar("event_type", { length: 60 }).notNull(),
    fromStatus: orderStatusEnum("from_status"),
    toStatus: orderStatusEnum("to_status"),
    /** The revision this event produced, where it produced one. */
    revision: integer("revision"),

    /** One sentence a customer could be read over the phone. */
    summary: text("summary").notNull(),
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Set when the event was produced under an impersonated session. */
    impersonationId: uuid("impersonation_id"),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("sales_order_events_tenant_idx").on(t.tenantId),
    orderIdx: index("sales_order_events_order_idx").on(t.tenantId, t.orderId, t.occurredAt),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const salesOrdersRelations = relations(salesOrders, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [salesOrders.tenantId],
    references: [tenants.id],
  }),
  company: one(companies, {
    fields: [salesOrders.companyId],
    references: [companies.id],
  }),
  contact: one(contacts, {
    fields: [salesOrders.contactId],
    references: [contacts.id],
  }),
  deal: one(deals, { fields: [salesOrders.dealId], references: [deals.id] }),
  project: one(projects, {
    fields: [salesOrders.projectId],
    references: [projects.id],
  }),
  lines: many(salesOrderLines),
  fulfillments: many(salesOrderFulfillments),
  events: many(salesOrderEvents),
}));

export const salesOrderLinesRelations = relations(
  salesOrderLines,
  ({ one, many }) => ({
    order: one(salesOrders, {
      fields: [salesOrderLines.orderId],
      references: [salesOrders.id],
    }),
    asset: one(assets, {
      fields: [salesOrderLines.assetId],
      references: [assets.id],
    }),
    fulfillmentLines: many(salesOrderFulfillmentLines),
  }),
);

export const salesOrderFulfillmentsRelations = relations(
  salesOrderFulfillments,
  ({ one, many }) => ({
    order: one(salesOrders, {
      fields: [salesOrderFulfillments.orderId],
      references: [salesOrders.id],
    }),
    lines: many(salesOrderFulfillmentLines),
  }),
);

export const salesOrderFulfillmentLinesRelations = relations(
  salesOrderFulfillmentLines,
  ({ one }) => ({
    fulfillment: one(salesOrderFulfillments, {
      fields: [salesOrderFulfillmentLines.fulfillmentId],
      references: [salesOrderFulfillments.id],
    }),
    orderLine: one(salesOrderLines, {
      fields: [salesOrderFulfillmentLines.orderLineId],
      references: [salesOrderLines.id],
    }),
  }),
);

export const salesOrderEventsRelations = relations(salesOrderEvents, ({ one }) => ({
  order: one(salesOrders, {
    fields: [salesOrderEvents.orderId],
    references: [salesOrders.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type SalesOrder = typeof salesOrders.$inferSelect;
export type NewSalesOrder = typeof salesOrders.$inferInsert;
export type SalesOrderLine = typeof salesOrderLines.$inferSelect;
export type NewSalesOrderLine = typeof salesOrderLines.$inferInsert;
export type SalesOrderFulfillment = typeof salesOrderFulfillments.$inferSelect;
export type NewSalesOrderFulfillment = typeof salesOrderFulfillments.$inferInsert;
export type SalesOrderFulfillmentLine =
  typeof salesOrderFulfillmentLines.$inferSelect;
export type SalesOrderEvent = typeof salesOrderEvents.$inferSelect;

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type OrderSource = (typeof orderSourceEnum.enumValues)[number];
export type FulfillmentStatus = (typeof fulfillmentStatusEnum.enumValues)[number];
export type OrderLineKind = (typeof orderLineKindEnum.enumValues)[number];

/**
 * ⭐ THE LEGAL TRANSITIONS. Exported so the server action, the SQL trigger
 * comment and the UI all quote ONE list rather than three that drift.
 *
 * ⚠️ `cancelled` is reachable from every live state and from none of the
 * terminal ones. `closed` is reachable only from a fulfilled or partially
 * fulfilled order — closing a confirmed order that shipped nothing is a
 * cancellation wearing a friendlier word, and it is how delivery figures
 * get overstated.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["pending_approval", "confirmed", "cancelled"],
  pending_approval: ["confirmed", "draft", "cancelled"],
  confirmed: ["partially_fulfilled", "fulfilled", "on_hold", "cancelled"],
  partially_fulfilled: ["fulfilled", "on_hold", "closed", "cancelled"],
  fulfilled: ["closed", "partially_fulfilled"],
  on_hold: ["confirmed", "partially_fulfilled", "cancelled"],
  closed: [],
  cancelled: [],
} as const;

/** States in which a line may still be edited without an amendment. */
export const EDITABLE_STATUSES: readonly OrderStatus[] = ["draft", "pending_approval"];
