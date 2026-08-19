/**
 * Ordence — ⭐ Inventory: Warehouses, the Stock Ledger and Reservations
 * Version: v0.40.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ONE DECISION THIS WHOLE PHASE RESTS ON
 * ══════════════════════════════════════════════════════════════════════
 *
 *      STOCK ON HAND IS NOT A COLUMN. IT IS A SUM OF MOVEMENTS.
 *
 * Almost every inventory system ever written starts with a
 * `quantity_on_hand` integer that code adds to and subtracts from. It
 * works for about a year. Then a dispatch fails halfway, or two people
 * pick the same pallet in the same second, or somebody runs a fix at a
 * database prompt — and the number is wrong. Nothing errors. The screen
 * says 400 bags and the shed has 380, and there is no way to find out
 * which of the last nine thousand transactions did it, because the
 * history was never written down. The only remedy left is a physical
 * count, which is a day of somebody's life, and it fixes the number
 * without fixing the cause, so it happens again next quarter.
 *
 * So `stock_movements` is an APPEND-ONLY LEDGER — the same shape as the
 * double-entry ledger in Phase 4, for the same reason. Every receipt,
 * issue, transfer, return and adjustment is a row. A row is never
 * updated and never deleted; the database refuses both (SQL 0029 §3).
 * A mistake is corrected by a REVERSING movement that says what it
 * reverses, which means the error and the correction are both on the
 * record and both attributable.
 *
 * `stock_balances` exists purely so a screen does not have to sum a
 * million rows. ⚠️ IT IS MAINTAINED BY TRIGGER AND BY NOTHING ELSE, and
 * it is a CACHE — if it ever disagrees with the ledger, the ledger is
 * right and the cache is rebuilt from it. The rebuild is one query,
 * because the history was kept.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AVAILABLE ≠ ON HAND. THIS IS THE SECOND MOST EXPENSIVE MISTAKE.
 * ══════════════════════════════════════════════════════════════════════
 * Four hundred bags in the shed, three hundred already promised to a
 * confirmed order that ships Thursday. A salesperson looking at "400"
 * sells 350 of them today, and now two customers have been promised the
 * same cement. Nobody finds out until Thursday, and the one who finds
 * out is whichever customer is less important.
 *
 *      AVAILABLE = ON HAND − RESERVED
 *
 * `stock_reservations` is what makes that subtraction possible. A
 * confirmed order line reserves stock; the reservation is released when
 * the goods are dispatched or the line is cancelled. ⚠️ A reservation
 * that outlives its order is stock nobody can sell and nobody can find,
 * which is why every reservation carries the order line it belongs to
 * and dies with it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ VALUATION IS PER MOVEMENT, IN PAISE, AND IT IS NOT AN AVERAGE
 * ══════════════════════════════════════════════════════════════════════
 * Every inward movement carries the cost it came in at. Cost of goods
 * sold on an outward movement is computed FROM the inward layers, by the
 * method the item is configured for. Storing a single "current cost" per
 * item and using it for everything is how a business with rising steel
 * prices reports a profit it does not have — the stock is valued at
 * today's price and the sale is costed at today's price, so the gain
 * that actually came from holding cheap steel is booked as trading
 * margin, and the tax is paid on it.
 *
 * Quantities are `numeric(18,3)`. Money is `bigint` paise. No float.
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
import { assets } from "./assets";
import { projects } from "./sales";
import { salesOrders, salesOrderLines } from "./orders";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * What kind of place this is.
 *
 * ⚠️ `site` AND `consignment` ARE NOT DECORATION. Stock at a project
 * site is ours and is on our balance sheet; stock held on consignment at
 * a dealer is ours too but is somewhere we do not control; stock in
 * `transit` belongs to whoever bears the risk under the incoterm, and
 * that is a question with an answer, not a shrug. A single "warehouse"
 * type forces all three into one bucket and the balance sheet stops
 * meaning anything.
 */
export const warehouseTypeEnum = pgEnum("warehouse_type", [
  "own",
  "site",
  "consignment",
  "transit",
  "third_party",
  "quarantine",
]);

/**
 * ⭐ WHY A MOVEMENT HAPPENED. Not the same as its direction.
 *
 * ⚠️ THE REASON IS REQUIRED ON EVERY ROW, and `adjustment` is deliberately
 * NOT a catch-all — it is the one reason that requires a written note and
 * an approver (SQL 0029 §5). An adjustment is somebody saying "the
 * computer is wrong, trust me", which is occasionally true and is always
 * the entry point for shrinkage nobody investigated.
 */
export const movementReasonEnum = pgEnum("stock_movement_reason", [
  "purchase_receipt",
  "sales_dispatch",
  "sales_return",
  "purchase_return",
  "transfer_out",
  "transfer_in",
  "production_consume",
  "production_output",
  "adjustment",
  "opening_balance",
  "damage",
  "theft",
  "expiry",
  "reversal",
]);

/** How units of this item are told apart. */
export const trackingModeEnum = pgEnum("stock_tracking_mode", [
  "none",
  "batch",
  "serial",
]);

/**
 * ⚠️ THE METHOD IS PER ITEM AND IT IS STICKY. Changing an item's
 * valuation method mid-year restates the cost of everything already sold,
 * which is a disclosure in the accounts, not a dropdown. The database
 * records the change; a later phase blocks it inside an open period.
 */
export const valuationMethodEnum = pgEnum("stock_valuation_method", [
  "fifo",
  "weighted_average",
  "specific",
  "standard",
]);

export const reservationStatusEnum = pgEnum("stock_reservation_status", [
  "held",
  "picked",
  "released",
  "consumed",
  "expired",
]);

export const countStatusEnum = pgEnum("stock_count_status", [
  "draft",
  "counting",
  "review",
  "posted",
  "abandoned",
]);

/* ------------------------------------------------------------------ */
/* WAREHOUSES                                                          */
/* ------------------------------------------------------------------ */

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    warehouseType: warehouseTypeEnum("warehouse_type").default("own").notNull(),

    /** Site stores usually belong to one project. */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    postalCode: varchar("postal_code", { length: 20 }),
    country: varchar("country", { length: 2 }).default("IN"),

    /**
     * ⚠️ THE GSTIN OF THE PLACE, WHICH IS NOT ALWAYS THE COMPANY'S.
     * A stock transfer between two of our own warehouses in DIFFERENT
     * states is a taxable supply under Schedule I — it needs a tax
     * invoice and an e-way bill even though no money changes hands and
     * nothing was sold. A business that does not record which GSTIN each
     * store sits under cannot tell the difference between a transfer and
     * a supply, and finds out at an audit.
     */
    gstin: varchar("gstin", { length: 15 }),
    stateCode: varchar("state_code", { length: 2 }),

    managerUserId: uuid("manager_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * ⭐ MAY THIS PLACE GO NEGATIVE?
     *
     * ⚠️ DEFAULT FALSE, AND THAT IS THE IMPORTANT DEFAULT. Negative stock
     * means the system believes it issued goods it never received — the
     * paperwork is behind reality. Some site stores genuinely work that
     * way (the lorry arrives and is unloaded before anyone enters the
     * receipt) and blocking it stops real work. But it must be a decision
     * somebody made about a specific store, not the silent behaviour
     * everywhere, because negative stock also makes every valuation
     * figure derived from it meaningless.
     */
    allowNegativeStock: boolean("allow_negative_stock").default(false).notNull(),

    /**
     * ⭐ WHO THIS IS NORMALLY BOUGHT FROM. Added in 0072.
     *
     * ⚠️ A reorder list that says "order 200 bags" and not who from is a
     * list somebody has to research before acting on, which means a list
     * nobody acts on.
     */
    preferredVendorId: uuid("preferred_vendor_id"),
    /**
     * ⭐ THE BASELINE FOR AGEING. Added in 0072.
     *
     * ⚠️ An item that has NEVER moved has no rows in the movement table
     * at all, so "nothing has moved since" cannot be computed from
     * movements alone. It would either be invisible or look infinitely
     * old, and both are wrong.
     */
    firstStockedOn: date("first_stocked_on"),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("warehouses_tenant_idx").on(t.tenantId),
    codeUnique: uniqueIndex("warehouses_tenant_code_unique")
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdUnique: uniqueIndex("warehouses_id_tenant_unique").on(t.id, t.tenantId),
    projectIdx: index("warehouses_project_idx").on(t.tenantId, t.projectId),
  }),
);

/* ------------------------------------------------------------------ */
/* STOCK ITEMS                                                         */
/* ------------------------------------------------------------------ */

/**
 * The inventory-tracking facts about a catalog item.
 *
 * ⚠️ SEPARATE FROM `assets` ON PURPOSE. Most of what a developer sells is
 * not stock — a flat is not a stock item, it is a unique immovable thing
 * that cannot be reordered. Putting reorder levels and valuation methods
 * on `assets` would mean every flat carries columns that are meaningless
 * for it, and every report has to remember to exclude them.
 */
export const stockItems = pgTable(
  "stock_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "restrict" }),

    sku: varchar("sku", { length: 100 }).notNull(),
    name: varchar("name", { length: 300 }).notNull(),
    description: text("description"),

    /**
     * ⚠️ THE STOCKING UNIT, AND EVERY QUANTITY IN THE LEDGER IS IN IT.
     * A ledger holding some rows in bags and some in tonnes is a ledger
     * whose sum is a number with no meaning. Conversions happen at the
     * edges — on a purchase order, on a delivery note — and never inside.
     */
    uom: varchar("uom", { length: 20 }).default("nos").notNull(),

    trackingMode: trackingModeEnum("tracking_mode").default("none").notNull(),
    valuationMethod: valuationMethodEnum("valuation_method")
      .default("weighted_average")
      .notNull(),

    /** Standard cost, used only when `valuationMethod` is "standard". */
    standardCostMinor: bigint("standard_cost_minor", { mode: "bigint" }),

    /**
     * ⭐ THE REORDER POINT — the whole reason anybody looks at an
     * inventory screen. Nullable, because an item nobody reorders should
     * not appear on a reorder report as though it were at zero.
     */
    reorderLevel: numeric("reorder_level", { precision: 18, scale: 3 }),
    reorderQuantity: numeric("reorder_quantity", { precision: 18, scale: 3 }),
    /** Days from placing an order to receiving it. Drives the reorder date. */
    leadTimeDays: integer("lead_time_days"),

    /** Shelf life, for anything that expires. Cement does. */
    shelfLifeDays: integer("shelf_life_days"),

    hsnSacCode: varchar("hsn_sac_code", { length: 20 }),
    isActive: boolean("is_active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("stock_items_tenant_idx").on(t.tenantId),
    skuUnique: uniqueIndex("stock_items_tenant_sku_unique")
      .on(t.tenantId, t.sku)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdUnique: uniqueIndex("stock_items_id_tenant_unique").on(t.id, t.tenantId),
    assetIdx: index("stock_items_asset_idx").on(t.tenantId, t.assetId),
    reorderIdx: index("stock_items_reorder_idx")
      .on(t.tenantId, t.reorderLevel)
      .where(sql`${t.reorderLevel} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ THE STOCK LEDGER — APPEND ONLY                                    */
/* ------------------------------------------------------------------ */

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    stockItemId: uuid("stock_item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),

    /**
     * ⭐ SIGNED. IN is positive, OUT is negative, and there is no
     * `direction` column.
     *
     * ⚠️ A separate direction flag alongside an unsigned quantity is two
     * facts that can contradict each other, and summing the ledger then
     * requires a CASE that somebody will eventually get backwards. One
     * signed number cannot disagree with itself, and the balance is
     * `SUM(quantity)` with nothing to get wrong.
     */
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),

    reason: movementReasonEnum("reason").notNull(),
    movedAt: timestamp("moved_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ⚠️ THE COST THIS QUANTITY CAME IN AT, per stocking unit, in paise.
     * Required on inward movements and meaningless on outward ones, where
     * cost is derived from the layers being consumed. Recorded rather
     * than looked up, because the price of steel on the day the lorry
     * arrived is a fact, and a fact does not change when the price does.
     */
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }),
    /** Computed cost of this movement. On outward rows this is the COGS. */
    valueMinor: bigint("value_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    batchNo: varchar("batch_no", { length: 100 }),
    serialNo: varchar("serial_no", { length: 120 }),
    expiryDate: date("expiry_date"),

    /**
     * ⭐ ADDED IN 0055, FILLED BY TRIGGER — never by a call site.
     *
     * ⚠️ `batchNo` STAYS EXACTLY WHERE IT IS. Every existing query keeps
     * working, and `trg_link_stock_batch` populates this beside it. That
     * is the whole reason nothing had to be found and rewritten — and
     * therefore nothing could be missed being found and rewritten.
     */
    batchId: uuid("batch_id"),

    /* --- What caused it. At most one of these is set. --------------- */
    salesOrderId: uuid("sales_order_id").references(() => salesOrders.id, {
      onDelete: "set null",
    }),
    salesOrderLineId: uuid("sales_order_line_id").references(() => salesOrderLines.id, {
      onDelete: "set null",
    }),
    /** Free reference for causes that do not yet have a table. */
    referenceType: varchar("reference_type", { length: 60 }),
    referenceId: uuid("reference_id"),
    documentNo: varchar("document_no", { length: 80 }),

    /**
     * ⭐ SET ONLY ON A REVERSAL, POINTING AT WHAT IT REVERSES.
     *
     * ⚠️ THIS IS THE ENTIRE CORRECTION MECHANISM. There is no edit and no
     * delete. A wrong movement is answered by an equal and opposite one
     * that names it, so the ledger shows both the error and the fix,
     * dated, with a person against each. An inventory history that can be
     * edited is an inventory history nobody can rely on in a dispute —
     * and inventory disputes are with suppliers, over money.
     */
    reversesMovementId: uuid("reverses_movement_id"),

    /** Required when `reason` is 'adjustment'. Enforced in SQL 0029 §5. */
    adjustmentNote: text("adjustment_note"),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    impersonationId: uuid("impersonation_id"),
  },
  (t) => ({
    tenantIdx: index("stock_movements_tenant_idx").on(t.tenantId),
    /** The hot path: the balance of one item in one place. */
    balanceIdx: index("stock_movements_balance_idx").on(
      t.tenantId,
      t.stockItemId,
      t.warehouseId,
    ),
    movedAtIdx: index("stock_movements_moved_at_idx").on(t.tenantId, t.movedAt),
    batchIdx: index("stock_movements_batch_idx")
      .on(t.tenantId, t.stockItemId, t.batchNo)
      .where(sql`${t.batchNo} IS NOT NULL`),
    orderIdx: index("stock_movements_order_idx").on(t.tenantId, t.salesOrderId),
    reversalIdx: index("stock_movements_reversal_idx")
      .on(t.tenantId, t.reversesMovementId)
      .where(sql`${t.reversesMovementId} IS NOT NULL`),
    tenantIdUnique: uniqueIndex("stock_movements_id_tenant_unique").on(t.id, t.tenantId),

    /** A zero-quantity movement is a row that says nothing happened. */
    nonZero: check("stock_movements_quantity_non_zero", sql`${t.quantity} <> 0`),
    /** A serial number identifies exactly one physical thing. */
    serialIsOne: check(
      "stock_movements_serial_is_single_unit",
      sql`${t.serialNo} IS NULL OR abs(${t.quantity}) = 1`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* BALANCES — A CACHE OF THE LEDGER, NOTHING MORE                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ NOT A SOURCE OF TRUTH. Maintained by the trigger in SQL 0029 §4 and
 * writable by nothing else. If this table were dropped entirely, every
 * figure in it could be rebuilt from `stock_movements` with one query.
 * That property is the test of whether the design is right, and it is
 * worth protecting: the moment something writes here directly, the
 * ledger stops being authoritative and the whole phase is back to a
 * drifting integer.
 */
export const stockBalances = pgTable(
  "stock_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    stockItemId: uuid("stock_item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    /** Empty string rather than NULL so the unique index actually bites. */
    batchNo: varchar("batch_no", { length: 100 }).default("").notNull(),

    quantityOnHand: numeric("quantity_on_hand", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    /** Sum of live reservations. Maintained by the reservation trigger. */
    quantityReserved: numeric("quantity_reserved", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),

    /** Total value of what is on hand, in paise. */
    valueMinor: bigint("value_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    lastMovementAt: timestamp("last_movement_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("stock_balances_tenant_idx").on(t.tenantId),
    uniqueSlot: uniqueIndex("stock_balances_slot_unique").on(
      t.tenantId,
      t.stockItemId,
      t.warehouseId,
      t.batchNo,
    ),
    itemIdx: index("stock_balances_item_idx").on(t.tenantId, t.stockItemId),
    warehouseIdx: index("stock_balances_warehouse_idx").on(t.tenantId, t.warehouseId),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ RESERVATIONS — WHY AVAILABLE ≠ ON HAND                            */
/* ------------------------------------------------------------------ */

export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    stockItemId: uuid("stock_item_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    batchNo: varchar("batch_no", { length: 100 }),

    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    status: reservationStatusEnum("status").default("held").notNull(),

    /**
     * ⚠️ EVERY RESERVATION BELONGS TO AN ORDER LINE. A reservation with
     * no owner is stock that is invisible to sales and untraceable to
     * anything — it just quietly shrinks what the business can sell, and
     * the only way to find it is to notice the discrepancy and go
     * looking.
     */
    salesOrderId: uuid("sales_order_id").references(() => salesOrders.id, {
      onDelete: "cascade",
    }),
    salesOrderLineId: uuid("sales_order_line_id").references(
      () => salesOrderLines.id,
      { onDelete: "cascade" },
    ),

    /**
     * ⭐ RESERVATIONS EXPIRE. A held reservation against an order that
     * stalled will sit there forever otherwise. The sweep that releases
     * them is a job, not a trigger, because the right expiry is a
     * business policy and it must be visible and changeable.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("stock_reservations_tenant_idx").on(t.tenantId),
    slotIdx: index("stock_reservations_slot_idx").on(
      t.tenantId,
      t.stockItemId,
      t.warehouseId,
    ),
    orderLineIdx: index("stock_reservations_order_line_idx").on(
      t.tenantId,
      t.salesOrderLineId,
    ),
    liveIdx: index("stock_reservations_live_idx")
      .on(t.tenantId, t.status)
      .where(sql`${t.status} IN ('held','picked')`),
    expiryIdx: index("stock_reservations_expiry_idx")
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.status} = 'held' AND ${t.expiresAt} IS NOT NULL`),

    positiveQuantity: check(
      "stock_reservations_quantity_positive",
      sql`${t.quantity} > 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* PHYSICAL COUNTS                                                     */
/* ------------------------------------------------------------------ */

export const stockCounts = pgTable(
  "stock_counts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    countNo: varchar("count_no", { length: 60 }).notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    status: countStatusEnum("status").default("draft").notNull(),

    scheduledFor: date("scheduled_for"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => users.id, { onDelete: "set null" }),

    /**
     * ⚠️ POSTING A COUNT WRITES ADJUSTMENT MOVEMENTS. It does not
     * overwrite balances. The variance becomes rows in the ledger like
     * everything else, so next quarter somebody can ask what the last
     * count actually found and get an answer instead of a number.
     */
    varianceValueMinor: bigint("variance_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    notes: text("notes"),

    /**
     * ⭐⭐ THE JOURNAL THIS COUNT PRODUCED. Added in 0070.
     *
     * 🔴 ITS PRESENCE IS THE RECORD THAT THE COUNT HAS BEEN POSTED, so a
     * second posting has nowhere to write. A partial unique index in
     * 0070 enforces that at the database rather than by remembering.
     *
     * ⚠️ THE FAILURE THIS PREVENTS IS DOUBLE ADJUSTMENT. A count that
     * finds 40 units missing, posted twice, removes 80. The stock ledger
     * stays internally consistent, the balance is simply wrong, and the
     * next count finds 40 units appearing from nowhere.
     */
    journalEntryId: uuid("journal_entry_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("stock_counts_tenant_idx").on(t.tenantId),
    noUnique: uniqueIndex("stock_counts_no_unique").on(t.tenantId, t.countNo),
    tenantIdUnique: uniqueIndex("stock_counts_id_tenant_unique").on(t.id, t.tenantId),
    warehouseIdx: index("stock_counts_warehouse_idx").on(t.tenantId, t.warehouseId),
  }),
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    countId: uuid("count_id").notNull(),
    stockItemId: uuid("stock_item_id").notNull(),
    batchNo: varchar("batch_no", { length: 100 }),

    /**
     * ⭐ THE SYSTEM FIGURE, FROZEN AT THE MOMENT COUNTING STARTED.
     *
     * ⚠️ SNAPSHOTTED, NOT READ LIVE. If the expected quantity were read
     * from the balance at posting time, a movement made during the count
     * would silently change what the variance appears to be — and the
     * variance would then include stock that moved legitimately while
     * somebody was walking the aisles. The count is a comparison against
     * a stated moment.
     */
    expectedQuantity: numeric("expected_quantity", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    countedQuantity: numeric("counted_quantity", { precision: 18, scale: 3 }),

    countedBy: uuid("counted_by").references(() => users.id, { onDelete: "set null" }),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    /** Required when the variance is not zero. */
    varianceNote: text("variance_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("stock_count_lines_tenant_idx").on(t.tenantId),
    countIdx: index("stock_count_lines_count_idx").on(t.tenantId, t.countId),
    slotUnique: uniqueIndex("stock_count_lines_slot_unique").on(
      t.countId,
      t.stockItemId,
      t.batchNo,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const warehousesRelations = relations(warehouses, ({ one, many }) => ({
  tenant: one(tenants, { fields: [warehouses.tenantId], references: [tenants.id] }),
  project: one(projects, {
    fields: [warehouses.projectId],
    references: [projects.id],
  }),
  balances: many(stockBalances),
}));

export const stockItemsRelations = relations(stockItems, ({ one, many }) => ({
  asset: one(assets, { fields: [stockItems.assetId], references: [assets.id] }),
  balances: many(stockBalances),
  movements: many(stockMovements),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  item: one(stockItems, {
    fields: [stockMovements.stockItemId],
    references: [stockItems.id],
  }),
  warehouse: one(warehouses, {
    fields: [stockMovements.warehouseId],
    references: [warehouses.id],
  }),
}));

export const stockBalancesRelations = relations(stockBalances, ({ one }) => ({
  item: one(stockItems, {
    fields: [stockBalances.stockItemId],
    references: [stockItems.id],
  }),
  warehouse: one(warehouses, {
    fields: [stockBalances.warehouseId],
    references: [warehouses.id],
  }),
}));

export const stockReservationsRelations = relations(stockReservations, ({ one }) => ({
  item: one(stockItems, {
    fields: [stockReservations.stockItemId],
    references: [stockItems.id],
  }),
  orderLine: one(salesOrderLines, {
    fields: [stockReservations.salesOrderLineId],
    references: [salesOrderLines.id],
  }),
}));

export const stockCountsRelations = relations(stockCounts, ({ one, many }) => ({
  warehouse: one(warehouses, {
    fields: [stockCounts.warehouseId],
    references: [warehouses.id],
  }),
  lines: many(stockCountLines),
}));

export const stockCountLinesRelations = relations(stockCountLines, ({ one }) => ({
  count: one(stockCounts, {
    fields: [stockCountLines.countId],
    references: [stockCounts.id],
  }),
  item: one(stockItems, {
    fields: [stockCountLines.stockItemId],
    references: [stockItems.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type Warehouse = typeof warehouses.$inferSelect;
export type NewWarehouse = typeof warehouses.$inferInsert;
export type StockItem = typeof stockItems.$inferSelect;
export type NewStockItem = typeof stockItems.$inferInsert;
export type StockMovement = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
export type StockBalance = typeof stockBalances.$inferSelect;
export type StockReservation = typeof stockReservations.$inferSelect;
export type StockCount = typeof stockCounts.$inferSelect;
export type StockCountLine = typeof stockCountLines.$inferSelect;

export type MovementReason = (typeof movementReasonEnum.enumValues)[number];
export type TrackingMode = (typeof trackingModeEnum.enumValues)[number];
export type ValuationMethod = (typeof valuationMethodEnum.enumValues)[number];

/**
 * ⭐ REASONS THAT ADD STOCK. Exported so the SQL comment, the server
 * action and the UI quote ONE list instead of three that drift apart.
 *
 * ⚠️ THE SIGN IS ON THE QUANTITY, NOT DERIVED FROM THIS LIST. This is for
 * validating that a caller's sign matches their stated reason — a
 * `purchase_receipt` with a negative quantity is somebody's bug, and it
 * is better caught at entry than found in a valuation three months on.
 */
export const INWARD_REASONS: readonly MovementReason[] = [
  "purchase_receipt",
  "sales_return",
  "transfer_in",
  "production_output",
  "opening_balance",
];

export const OUTWARD_REASONS: readonly MovementReason[] = [
  "sales_dispatch",
  "purchase_return",
  "transfer_out",
  "production_consume",
  "damage",
  "theft",
  "expiry",
];

/** Either direction, legitimately: an adjustment or a reversal. */
export const BIDIRECTIONAL_REASONS: readonly MovementReason[] = [
  "adjustment",
  "reversal",
];

/* ------------------------------------------------------------------ */
/* ⭐⭐ BATCH · EXPIRY · SERIAL · RETURNS — SQL 0055 · v1.4.0-alpha     */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE MASTER THAT `batch_no` SHOULD ALWAYS HAVE POINTED AT
 * ══════════════════════════════════════════════════════════════════════
 * `stock_movements.batch_no` and `.expiry_date` have existed since 0029
 * as two free-text strings on a ledger row — which means the SAME BATCH
 * CAN CARRY TWO DIFFERENT EXPIRY DATES, typed by two people a week
 * apart, with nothing to refuse it.
 *
 * The unique key on (tenant, item, batch_no) is the fix. The expiry date
 * stops being a property of a movement and becomes a property of the
 * batch — which is what it always was on the carton.
 *
 * ⚠️ POPULATED BY THE TRIGGER IN 0055, not by rewriting call sites.
 * Every existing insert keeps working and silently acquires a real batch
 * row, so nothing had to be found and changed — which means nothing
 * could be MISSED being found and changed.
 */
export const stockBatches = pgTable(
  "stock_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    stockItemId: uuid("stock_item_id").notNull(),

    batchNo: varchar("batch_no", { length: 100 }).notNull(),
    supplierBatchNo: varchar("supplier_batch_no", { length: 100 }),

    manufactureDate: date("manufacture_date", { mode: "string" }),
    expiryDate: date("expiry_date", { mode: "string" }),

    /** ⚠️ The FIRST time we saw it. Ageing is measured from arrival. */
    firstReceivedAt: timestamp("first_received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * 🔴 CHECKED ON THE WAY OUT BY THE TRIGGER, not just shown on a
     * report. A flag a picker never reads is not a quarantine.
     */
    status: varchar("status", { length: 20 }).default("active").notNull(),
    statusNote: text("status_note"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedBy: uuid("status_changed_by").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /** 🔴 The key that makes one batch mean one thing. */
    itemBatchUnique: uniqueIndex("stock_batches_item_batch_unique").on(
      t.tenantId,
      t.stockItemId,
      t.batchNo,
    ),
    expiryIdx: index("stock_batches_expiry_idx")
      .on(t.tenantId, t.expiryDate)
      .where(sql`${t.expiryDate} IS NOT NULL AND ${t.status} IN ('active', 'quarantined')`),
    statusIdx: index("stock_batches_status_idx").on(t.tenantId, t.status),
  }),
);

/**
 * 🔴 ONE ROW PER PHYSICAL UNIT, AND IT ANSWERS "WHERE IS IT".
 *
 * A serial number on a movement says where a unit went once. This says
 * where it is now, who has it, when it shipped and when its warranty
 * ends — every question an installer standing in front of a dead
 * inverter is asked, and none of which a movement ledger can answer
 * without replaying itself.
 *
 * ⚠️ MAINTAINED FROM THE LEDGER BY TRIGGER, never written by hand — the
 * same discipline as `stock_balances`. Dropped entirely, it could be
 * rebuilt by replaying `stock_movements`.
 */
export const stockSerials = pgTable(
  "stock_serials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    stockItemId: uuid("stock_item_id").notNull(),

    serialNo: varchar("serial_no", { length: 120 }).notNull(),
    batchId: uuid("batch_id").references(() => stockBatches.id, {
      onDelete: "set null",
    }),

    status: varchar("status", { length: 20 }).default("in_stock").notNull(),

    warehouseId: uuid("warehouse_id").references(() => warehouses.id, {
      onDelete: "set null",
    }),
    companyId: uuid("company_id"),

    receivedAt: timestamp("received_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    /** ⚠️ Warranty runs from DISPATCH, not from receipt into our store. */
    warrantyMonths: integer("warranty_months"),
    warrantyUntil: date("warranty_until", { mode: "string" }),

    lastMovementId: uuid("last_movement_id"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** 🔴 One serial, one unit, once. */
    serialUnique: uniqueIndex("stock_serials_unique").on(
      t.tenantId,
      t.stockItemId,
      t.serialNo,
    ),
    statusIdx: index("stock_serials_status_idx").on(t.tenantId, t.status),
    companyIdx: index("stock_serials_company_idx")
      .on(t.tenantId, t.companyId)
      .where(sql`${t.companyId} IS NOT NULL`),
    warrantyIdx: index("stock_serials_warranty_idx")
      .on(t.tenantId, t.warrantyUntil)
      .where(sql`${t.warrantyUntil} IS NOT NULL`),
  }),
);

/**
 * ⭐ A SALES RETURN IS THREE SEPARATE FACTS, AND MOST SOFTWARE MERGES
 *    THEM INTO ONE.
 *
 *   1. Goods physically arrived back        → a stock movement
 *   2. The customer owes less               → a credit note, s.34
 *   3. Some of what came back is unsaleable → a different warehouse
 *
 * 🔴 MERGING (1) AND (3) IS THE EXPENSIVE ONE. Damaged goods put back
 *    into a selling warehouse are goods the next customer receives.
 */
export const goodsReturns = pgTable(
  "goods_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    returnNo: varchar("return_no", { length: 40 }).notNull(),
    returnDate: date("return_date", { mode: "string" }).notNull(),

    companyId: uuid("company_id"),
    /** Nullable — goods come back before anybody finds the paperwork. */
    invoiceId: uuid("invoice_id"),
    creditNoteId: uuid("credit_note_id"),

    reason: varchar("reason", { length: 40 }).default("other").notNull(),
    status: varchar("status", { length: 20 }).default("draft").notNull(),

    /**
     * ⭐ SECTION 34(2). After this date the credit note can still be
     * issued and the customer still owes less — but the GST on the
     * original sale is no longer recoverable. Stored so the screen can
     * count down to it rather than discover it afterwards.
     */
    taxAdjustmentDeadline: date("tax_adjustment_deadline", { mode: "string" }),

    inwardChallanNo: varchar("inward_challan_no", { length: 40 }),
    ewayBillNo: varchar("eway_bill_no", { length: 20 }),

    notes: text("notes"),

    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    noUnique: uniqueIndex("goods_returns_no_unique").on(t.tenantId, t.returnNo),
    invoiceIdx: index("goods_returns_invoice_idx")
      .on(t.tenantId, t.invoiceId)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    statusIdx: index("goods_returns_status_idx").on(t.tenantId, t.status, t.returnDate),
    deadlineIdx: index("goods_returns_deadline_idx")
      .on(t.tenantId, t.taxAdjustmentDeadline)
      .where(
        sql`${t.status} IN ('draft', 'received') AND ${t.taxAdjustmentDeadline} IS NOT NULL`,
      ),
  }),
);

export const goodsReturnLines = pgTable(
  "goods_return_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    goodsReturnId: uuid("goods_return_id")
      .notNull()
      .references(() => goodsReturns.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    stockItemId: uuid("stock_item_id"),
    description: text("description").notNull(),

    /**
     * 🔴 A RETURNED BATCH KEEPS ITS ORIGINAL EXPIRY. Whoever is at the
     * door will type today plus the shelf life, which resets the clock
     * on stock that has already spent nine months at a customer — and
     * the one-expiry-per-batch trigger is what refuses it.
     */
    batchNo: varchar("batch_no", { length: 100 }),
    serialNo: varchar("serial_no", { length: 120 }),

    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    uom: varchar("uom", { length: 20 }).default("nos").notNull(),

    /** ⭐ The field the whole table exists for. */
    condition: varchar("condition", { length: 20 }).default("saleable").notNull(),

    warehouseId: uuid("warehouse_id").references(() => warehouses.id, {
      onDelete: "restrict",
    }),
    movementId: uuid("movement_id"),

    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxRateBps: integer("tax_rate_bps").default(0).notNull(),
    taxValueMinor: bigint("tax_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** ⭐ s.17(5)(h) — what has to be given back if this is destroyed. */
    itcReversalMinor: bigint("itc_reversal_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineUnique: uniqueIndex("goods_return_lines_no_unique").on(
      t.tenantId,
      t.goodsReturnId,
      t.lineNo,
    ),
    itemIdx: index("goods_return_lines_item_idx").on(t.tenantId, t.stockItemId),
  }),
);

/**
 * 🔴 SECTION 17(5)(h): input tax credit is NOT available on goods
 *    "lost, stolen, destroyed, written off or disposed of by way of gift
 *    or free samples".
 *
 * ⚠️ SO A STOCK WRITE-OFF IS TWO ENTRIES, NOT ONE. The stock leaves,
 * AND the credit claimed when it was bought is reversed. Software that
 * does only the first produces books that balance and a GST position
 * that does not — found at an assessment, with interest.
 */
export const stockWriteOffs = pgTable(
  "stock_write_offs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    movementId: uuid("movement_id"),
    stockItemId: uuid("stock_item_id").notNull(),
    batchId: uuid("batch_id").references(() => stockBatches.id, {
      onDelete: "restrict",
    }),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id, {
      onDelete: "restrict",
    }),

    writeOffDate: date("write_off_date", { mode: "string" }).notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    reason: varchar("reason", { length: 20 }).notNull(),

    costMinor: bigint("cost_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    itcRateBps: integer("itc_rate_bps").default(0).notNull(),
    itcReversalMinor: bigint("itc_reversal_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** The GSTR-3B period the reversal is declared in — "2026-08". */
    reversalPeriod: varchar("reversal_period", { length: 7 }),

    /** 🔴 Required when the reversal is zero. A zero is either correct
     *  or it is the mistake this table exists to catch, and the row
     *  cannot tell you which without a sentence. */
    itcNote: text("itc_note"),

    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    periodIdx: index("stock_write_offs_period_idx").on(t.tenantId, t.reversalPeriod),
    itemIdx: index("stock_write_offs_item_idx").on(
      t.tenantId,
      t.stockItemId,
      t.writeOffDate,
    ),
  }),
);

export const stockBatchesRelations = relations(stockBatches, ({ one, many }) => ({
  tenant: one(tenants, { fields: [stockBatches.tenantId], references: [tenants.id] }),
  serials: many(stockSerials),
}));

export const stockSerialsRelations = relations(stockSerials, ({ one }) => ({
  batch: one(stockBatches, {
    fields: [stockSerials.batchId],
    references: [stockBatches.id],
  }),
  warehouse: one(warehouses, {
    fields: [stockSerials.warehouseId],
    references: [warehouses.id],
  }),
}));

export const goodsReturnsRelations = relations(goodsReturns, ({ one, many }) => ({
  tenant: one(tenants, { fields: [goodsReturns.tenantId], references: [tenants.id] }),
  lines: many(goodsReturnLines),
}));

export const goodsReturnLinesRelations = relations(goodsReturnLines, ({ one }) => ({
  goodsReturn: one(goodsReturns, {
    fields: [goodsReturnLines.goodsReturnId],
    references: [goodsReturns.id],
  }),
}));

export type StockBatchRow = typeof stockBatches.$inferSelect;
export type NewStockBatchRow = typeof stockBatches.$inferInsert;
export type StockSerialRow = typeof stockSerials.$inferSelect;
export type GoodsReturnRow = typeof goodsReturns.$inferSelect;
export type GoodsReturnLineRow = typeof goodsReturnLines.$inferSelect;
export type StockWriteOffRow = typeof stockWriteOffs.$inferSelect;

/* ------------------------------------------------------------------ */
/* ⭐⭐ TRANSFERS AND LANDED COST — SQL 0056 · v1.5.0-alpha             */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A TRANSFER WAS TWO INDEPENDENT MOVEMENTS AND NOTHING JOINED THEM
 * ══════════════════════════════════════════════════════════════════════
 * `transfer_out` and `transfer_in` have existed since 0029 and
 * `postMovement()` posts one at a time. So moving 100 bags meant two
 * unrelated rows — and either the stock existed at the destination
 * before the lorry did, or it vanished off the balance sheet for three
 * days. Both look fine.
 *
 * ⭐ `transitWarehouseId` IS THE COLUMN THIS TABLE EXISTS FOR. The
 * `transit` warehouse type has been in the enum since 0029 and nothing
 * ever used it.
 *
 * 🔴 AND `isTaxableSupply` IS DECIDED BY THE GSTINS, NOT THE STATES.
 * Section 25(4) makes each registration a distinct person; Schedule I
 * para 2 makes a supply between them taxable without consideration.
 */
export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    transferNo: varchar("transfer_no", { length: 40 }).notNull(),
    transferDate: date("transfer_date", { mode: "string" }).notNull(),

    fromWarehouseId: uuid("from_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    toWarehouseId: uuid("to_warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    /** ⭐ Where the goods live while they are on the lorry. */
    transitWarehouseId: uuid("transit_warehouse_id").references(() => warehouses.id, {
      onDelete: "restrict",
    }),

    /** 🔴 Captured at dispatch, never joined at read time. */
    fromGstin: varchar("from_gstin", { length: 15 }),
    toGstin: varchar("to_gstin", { length: 15 }),
    fromStateCode: varchar("from_state_code", { length: 2 }),
    toStateCode: varchar("to_state_code", { length: 2 }),

    isTaxableSupply: boolean("is_taxable_supply").default(false).notNull(),
    documentType: varchar("document_type", { length: 20 })
      .default("delivery_challan")
      .notNull(),
    documentNo: varchar("document_no", { length: 40 }),
    invoiceId: uuid("invoice_id"),

    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    ewayBillNo: varchar("eway_bill_no", { length: 20 }),
    transporterName: varchar("transporter_name", { length: 255 }),
    vehicleNo: varchar("vehicle_no", { length: 20 }),
    distanceKm: integer("distance_km"),

    status: varchar("status", { length: 20 }).default("draft").notNull(),

    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchedBy: uuid("dispatched_by").references(() => users.id, {
      onDelete: "set null",
    }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: uuid("received_by").references(() => users.id, { onDelete: "set null" }),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, {
      onDelete: "set null",
    }),
    cancelReason: text("cancel_reason"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    noUnique: uniqueIndex("stock_transfers_no_unique").on(t.tenantId, t.transferNo),
    /** ⭐ The Monday query: what left and never arrived. */
    inTransitIdx: index("stock_transfers_in_transit_idx")
      .on(t.tenantId, t.dispatchedAt)
      .where(sql`${t.status} = 'dispatched'`),
    routeIdx: index("stock_transfers_route_idx").on(
      t.tenantId,
      t.fromWarehouseId,
      t.toWarehouseId,
      t.transferDate,
    ),
  }),
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    stockItemId: uuid("stock_item_id").notNull(),
    batchNo: varchar("batch_no", { length: 100 }),
    serialNo: varchar("serial_no", { length: 120 }),

    qtyDispatched: numeric("qty_dispatched", { precision: 18, scale: 3 }).notNull(),
    /**
     * ⭐ NULL UNTIL SOMEBODY COUNTS IT AT THE OTHER END — deliberately
     * not defaulted to the dispatched quantity, because a default of
     * "however many we sent" is a receipt nobody performed.
     */
    qtyReceived: numeric("qty_received", { precision: 18, scale: 3 }),

    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxRateBps: integer("tax_rate_bps").default(0).notNull(),

    varianceMovementId: uuid("variance_movement_id"),
    varianceNote: text("variance_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lineUnique: uniqueIndex("stock_transfer_lines_no_unique").on(
      t.tenantId,
      t.transferId,
      t.lineNo,
    ),
    itemIdx: index("stock_transfer_lines_item_idx").on(t.tenantId, t.stockItemId),
    varianceIdx: index("stock_transfer_lines_variance_idx")
      .on(t.tenantId, t.transferId)
      .where(
        sql`${t.qtyReceived} IS NOT NULL AND ${t.qtyReceived} < ${t.qtyDispatched} AND ${t.varianceMovementId} IS NULL`,
      ),
  }),
);

/**
 * 🔴 Ind AS 2 — cost of purchase is the price plus duties and taxes
 *    "OTHER THAN THOSE SUBSEQUENTLY RECOVERABLE", plus transport and
 *    handling directly attributable to acquisition.
 *
 * ⚠️ `isRecoverable` splits two charges on ONE bill of entry: basic
 * customs duty is a cost, IGST on imports is a credit. Capitalising the
 * IGST inflates stock AND loses the credit, and the balance sheet still
 * balances.
 */
export const landedCosts = pgTable(
  "landed_costs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    purchaseInvoiceId: uuid("purchase_invoice_id"),
    referenceNo: varchar("reference_no", { length: 60 }),

    costType: varchar("cost_type", { length: 30 }).notNull(),
    description: text("description"),

    vendorId: uuid("vendor_id"),
    vendorInvoiceNo: varchar("vendor_invoice_no", { length: 60 }),
    costDate: date("cost_date", { mode: "string" }).notNull(),

    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /** 🔴 Recoverable means it is a credit, not a cost. */
    isRecoverable: boolean("is_recoverable").default(false).notNull(),

    /** ⚠️ Freight by weight; value is the default and it is wrong for freight. */
    apportionBasis: varchar("apportion_basis", { length: 20 })
      .default("value")
      .notNull(),

    status: varchar("status", { length: 20 }).default("draft").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedBy: uuid("applied_by").references(() => users.id, { onDelete: "set null" }),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    invoiceIdx: index("landed_costs_invoice_idx").on(t.tenantId, t.purchaseInvoiceId),
    statusIdx: index("landed_costs_status_idx").on(t.tenantId, t.status, t.costDate),
  }),
);

/**
 * ⭐ WHERE EACH RUPEE ENDED UP — and it is split between stock and cost
 *   of sales, because the freight bill arrives after the goods and some
 *   of them are already sold.
 *
 * 🔴 Adding the whole charge to what is left overstates closing stock
 *    AND overstates the margin already reported. Two errors in opposite
 *    directions, and the total is right, so nothing looks odd.
 */
export const landedCostAllocations = pgTable(
  "landed_cost_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    landedCostId: uuid("landed_cost_id")
      .notNull()
      .references(() => landedCosts.id, { onDelete: "cascade" }),

    purchaseLineId: uuid("purchase_line_id"),
    stockItemId: uuid("stock_item_id"),
    batchNo: varchar("batch_no", { length: 100 }),

    basisAmount: numeric("basis_amount", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    allocatedMinor: bigint("allocated_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** ⭐ These two always add up to `allocatedMinor` — enforced by CHECK. */
    toInventoryMinor: bigint("to_inventory_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    toCogsMinor: bigint("to_cogs_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    qtyReceived: numeric("qty_received", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),
    qtyStillOnHand: numeric("qty_still_on_hand", { precision: 18, scale: 3 })
      .default(sql`0`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    costIdx: index("landed_cost_allocations_cost_idx").on(t.tenantId, t.landedCostId),
    itemIdx: index("landed_cost_allocations_item_idx").on(t.tenantId, t.stockItemId),
  }),
);

export const stockTransfersRelations = relations(stockTransfers, ({ one, many }) => ({
  tenant: one(tenants, { fields: [stockTransfers.tenantId], references: [tenants.id] }),
  lines: many(stockTransferLines),
}));

export const stockTransferLinesRelations = relations(stockTransferLines, ({ one }) => ({
  transfer: one(stockTransfers, {
    fields: [stockTransferLines.transferId],
    references: [stockTransfers.id],
  }),
}));

export const landedCostsRelations = relations(landedCosts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [landedCosts.tenantId], references: [tenants.id] }),
  allocations: many(landedCostAllocations),
}));

export const landedCostAllocationsRelations = relations(
  landedCostAllocations,
  ({ one }) => ({
    cost: one(landedCosts, {
      fields: [landedCostAllocations.landedCostId],
      references: [landedCosts.id],
    }),
  }),
);

export type StockTransferRow = typeof stockTransfers.$inferSelect;
export type StockTransferLineRow = typeof stockTransferLines.$inferSelect;
export type LandedCostRow = typeof landedCosts.$inferSelect;
export type LandedCostAllocationRow = typeof landedCostAllocations.$inferSelect;
