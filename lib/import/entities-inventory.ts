/**
 * Ordence — ⭐⭐ IMPORTABLE INVENTORY MASTERS · PHASE 7
 * Version: v1.85.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PHASE IS ACTUALLY FOR
 * ══════════════════════════════════════════════════════════════════════
 * `opening-stock` has resolved `stock_item_by_sku` and
 * `warehouse_by_code` since Batch 58. Both lookups have `missing`
 * sentences already written — "There is no stock item with SKU … in this
 * workspace" — and until this phase there was NO WAY TO PUT ONE THERE
 * except typing it in one at a time. A customer's first migration
 * therefore failed on every line of their stock file, with a message
 * telling them to fix something the product would not let them fix in
 * bulk.
 *
 * These three entities are what make those two lookups resolve.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A SEPARATE FILE, AND ONE LINE IN `entities.ts`
 * ══════════════════════════════════════════════════════════════════════
 * Five phases add entities at once. Five phases each adding one spread
 * to `ALL_IMPORT_ENTITIES` is five clean merges; five phases each
 * rewriting `entities.ts` is five conflicts, and the conflict resolution
 * is done by whoever merges last, on entities they did not write. The
 * one line is in `PATCH-REQUEST-PHASE-7.md`.
 *
 * 🔴 AND IT IS STILL NOT A SECOND REGISTRY. This map is a fragment;
 *    nothing reads it but the spread. `ALL_IMPORT_ENTITIES` stays the
 *    single allowlist and `isImportEntityKey` stays membership in it,
 *    because the key arrives from a browser.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO OF THE FIVE ENTITIES THIS PHASE WAS ASKED FOR ARE NOT HERE
 * ══════════════════════════════════════════════════════════════════════
 * `units-of-measure` and `price-lists` were briefed with destinations
 * `units` and `price_list_items`. Neither destination is what the brief
 * assumed and one of them does not exist:
 *
 *   `units`             is REAL ESTATE. `db/schema/sales.ts` — flat
 *                       A-1203, RERA carpet area, a NOT NULL project.
 *                       A unit of measure is not a row in it; the
 *                       stocking unit is `stock_items.uom`, a
 *                       `varchar(20)` on the item, and there is no
 *                       unit-of-measure master anywhere in the 313
 *                       tables. An importer aimed at `units` would
 *                       insert flats.
 *
 *   `price_list_items`  does not exist, and SQL 0057 refuses to create
 *                       one BY NAME: "a `customer_price_lists` table
 *                       would have been the obvious thing to write, and
 *                       it would have been the mistake. Two tables
 *                       answering 'what does this cost this customer
 *                       today' is two answers, and the wrong one is
 *                       whichever the invoice screen happens to read."
 *                       Prices live in `rate_cards` / `rate_slabs`.
 *
 * ⭐ SO THEY ARE REPORTED RATHER THAN WRITTEN, which is what step 1 of
 * the phase brief asks for: "if there is no schema for this thing, the
 * entity is not ready and you should say so in your report rather than
 * writing one". `TRACK-REPORT.md` says it at length.
 */

import {
  stockBatchSchema,
  stockItemSchema,
  TRACKING_MODES,
  VALUATION_METHODS,
  warehouseSchema,
  WAREHOUSE_TYPES,
} from "@/lib/validators/inventory";
import type { ContractedImportEntity, ImportLookup } from "./types";

/* ------------------------------------------------------------------ */
/* SMALL SHARED PIECES                                                 */
/* ------------------------------------------------------------------ */

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** Lower-cased and whitespace-collapsed, for a natural key. */
const fold = (value: unknown): string => text(value).toLowerCase().replace(/\s+/g, " ");

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 INTEGER THOUSANDTHS BACK TO THE DECIMAL STRING THE SCHEMA WANTS
 * ══════════════════════════════════════════════════════════════════════
 * `kind: "quantity"` coerces "12.5" to the STRING "12500" — integer
 * thousandths, for the reason money is integer paise. `quantityString`
 * in `lib/validators/inventory.ts` — the schema the form uses — wants
 * the DECIMAL string "12.500", because `numeric(18,3)` is what the
 * column is.
 *
 * ⚠️ WITHOUT THIS, "12500" WOULD VALIDATE CLEANLY AS TWELVE THOUSAND
 *    FIVE HUNDRED. A reorder level a thousand times too high does not
 *    fail anything: it simply means the item is on the reorder report
 *    forever, and nobody can say why.
 *
 * ⚠️ AND IT IS BUILT FROM THE QUOTIENT AND THE REMAINDER, never
 * `Number(n) / 1000`. That division is exact for small numbers and
 * silently lossy for large ones. The same function exists in
 * `server/import/writers/shared.ts` for the write side; it is restated
 * here because `lib/import/` may not import from `server/` at all, and
 * the duplication is named in `PATCH-REQUEST-PHASE-7.md` with the fix.
 */
export function thousandthsToDecimal(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const magnitude = BigInt(digits);
  const whole = magnitude / 1000n;
  const fraction = magnitude % 1000n;
  return `${negative ? "-" : ""}${whole.toString()}.${fraction.toString().padStart(3, "0")}`;
}

/** A coerced quantity cell, as the decimal string the schema expects. */
const quantityCell = (
  value: string | number | boolean | null | undefined,
): string | null =>
  typeof value === "string" && value !== "" ? thousandthsToDecimal(value) : null;

/**
 * ⚠️ `null` AND `undefined` ARE NOT INTERCHANGEABLE HERE, AND THE
 *    DIFFERENCE IS A REFUSED ROW.
 *
 * A blank cell arrives as `null` (see `blankIsNull` in `values.ts`). A
 * Zod member written `.default("nos")` fires on `undefined` and REFUSES
 * `null` — "Expected string, received null" — so a customer who left the
 * unit column blank on a row would get that sentence in their
 * failed-rows CSV instead of the default the form would have given them.
 * Every member of these three schemas carrying a `.default()` is passed
 * through this.
 */
const orDefault = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value;

/* ================================================================== */
/* ① STOCK ITEMS — WAVE 0                                             */
/* ================================================================== */

/**
 * ⚠️ THE ITEM MASTER IS LOADED BEFORE ANYTHING ELSE IN INVENTORY AND
 *    AFTER NOTHING. It has no dependencies: `uom` is a string ON the
 *    item, not a foreign key into a unit table, and `assetId` is not
 *    offered as a column because nobody's export carries our uuids.
 */
const stockItemsEntity: ContractedImportEntity = {
  key: "stock-items",
  /**
   * ⭐ WAVE 2C. Amounts in this file are in the workspace's own
   * currency; there is no currency column. The exponent follows from
   * that code, so a Kuwaiti workspace reads 1.234 as 1234 fils.
   */
  money: { source: "workspace" },
  label: "Stock items",
  noun: { one: "stock item", many: "stock items" },
  description:
    "The catalogue of things you hold in stock. Load this before your opening stock, " +
    "your batches, or anything that names an SKU.",
  table: "stock_items",

  feature: "inventory.stock",
  createPermission: "inventory.items.manage",
  updatePermission: "inventory.items.manage",

  columns: [
    {
      field: "sku",
      header: "SKU",
      kind: "text",
      required: true,
      maxLength: 100,
      aliases: ["itemcode", "item", "productcode", "code", "partno", "partnumber", "materialcode"],
      help:
        "Your code for this item. This is what a re-import matches on, and what your " +
        "opening stock file must use.",
    },
    {
      field: "name",
      header: "Name",
      kind: "text",
      required: true,
      maxLength: 300,
      aliases: ["itemname", "productname", "material", "particulars", "product"],
      help: "What the item is called on a delivery note.",
    },
    {
      field: "description",
      header: "Description",
      kind: "text",
      required: false,
      maxLength: 2000,
      aliases: ["longdescription", "specification", "spec", "remarks"],
      help: "Free text. Optional.",
    },
    {
      /**
       * ⚠️ THE STOCKING UNIT, AND IT IS A WORD ON THE ITEM RATHER THAN A
       * ROW IN A UNITS TABLE. `db/schema/inventory.ts` is emphatic that
       * every quantity in the ledger is in this unit and that
       * conversions happen at the edges — "a ledger holding some rows in
       * bags and some in tonnes is a ledger whose sum is a number with
       * no meaning".
       */
      field: "uom",
      header: "Unit",
      kind: "text",
      required: false,
      maxLength: 20,
      aliases: ["unit", "unitofmeasure", "uom", "uqc", "stockingunit", "measure"],
      help:
        "The unit you count this item in — nos, kg, bag, m³. Every quantity you ever " +
        "import for it is in this unit. Left blank it is 'nos'.",
    },
    {
      field: "trackingMode",
      header: "Tracking",
      kind: "enum",
      required: false,
      enumValues: TRACKING_MODES,
      aliases: ["tracking", "trackingmode", "batchtracked", "lottracking"],
      help:
        `One of: ${TRACKING_MODES.join(", ")}. Choose 'batch' and every receipt of this ` +
        "item will require a lot number — which is what makes a recall possible.",
    },
    {
      field: "valuationMethod",
      header: "Valuation method",
      kind: "enum",
      required: false,
      enumValues: VALUATION_METHODS,
      aliases: ["valuation", "costingmethod", "costmethod", "valuationmethod"],
      help:
        `One of: ${VALUATION_METHODS.join(", ")}. Get this right before you load stock — ` +
        "it decides the cost of everything you sell afterwards. Left blank it is " +
        "weighted_average.",
    },
    {
      field: "standardCostMinor",
      header: "Standard cost",
      kind: "money",
      required: false,
      aliases: ["standardcost", "stdcost", "standardrate"],
      help:
        "Rupees per unit. Only used when the valuation method is 'standard'; leave it " +
        "blank otherwise.",
    },
    {
      field: "reorderLevel",
      header: "Reorder level",
      kind: "quantity",
      required: false,
      aliases: ["reorderpoint", "minimumstock", "minstock", "rol", "safetystock"],
      help:
        "When stock falls to this, the item appears on the reorder report. Up to three " +
        "decimals, in the item's own unit. Leave blank for anything you do not reorder.",
    },
    {
      field: "reorderQuantity",
      header: "Reorder quantity",
      kind: "quantity",
      required: false,
      aliases: ["reorderqty", "orderquantity", "eoq"],
      help: "How much to order when it does. Up to three decimals.",
    },
    {
      field: "leadTimeDays",
      header: "Lead time (days)",
      kind: "integer",
      required: false,
      bounds: { min: 0, max: 3650 },
      aliases: ["leadtime", "leaddays", "deliverydays"],
      help: "Whole days from placing an order to receiving it.",
    },
    {
      field: "shelfLifeDays",
      header: "Shelf life (days)",
      kind: "integer",
      required: false,
      bounds: { min: 0, max: 36500 },
      aliases: ["shelflife", "expirydays", "bestbeforedays"],
      help: "Whole days. Cement has one.",
    },
    {
      field: "hsnSacCode",
      header: "HSN/SAC",
      kind: "text",
      required: false,
      maxLength: 20,
      aliases: ["hsn", "sac", "hsncode", "saccode", "hsnsac"],
      help: "The tax classification code for this item, as digits.",
    },
  ],

  buildPayload: (values) => ({
    sku: values.sku,
    name: values.name,
    description: values.description,
    // See `orDefault` — a blank cell must become the schema's default,
    // not a refusal.
    uom: orDefault(values.uom),
    trackingMode: orDefault(values.trackingMode),
    valuationMethod: orDefault(values.valuationMethod),
    standardCostMinor: values.standardCostMinor,
    reorderLevel: quantityCell(values.reorderLevel),
    reorderQuantity: quantityCell(values.reorderQuantity),
    leadTimeDays: values.leadTimeDays,
    shelfLifeDays: values.shelfLifeDays,
    hsnSacCode: values.hsnSacCode,
  }),

  /**
   * 🔴 THE SCHEMA THE FORM USES. `saveStockItem` parses this same
   * object — see `lib/validators/inventory.ts` for why it had to move
   * out of the `"use server"` file before that sentence could be true.
   */
  schema: stockItemSchema,

  /**
   * ⚠️ ONE KEY, NO FALLBACK, AND IT IS A STRONG ONE.
   *
   * `stock_items_tenant_sku_unique` is the database's own answer to
   * "when are two rows the same item", so keying on anything else would
   * be a second opinion. There is no fallback to the name because two
   * grades of cement are both called "Cement".
   */
  naturalKey: (parsed) => {
    const sku = fold(parsed.sku);
    if (sku === "") return null;
    return { kind: "sku", value: sku, label: `SKU ${text(parsed.sku)}` };
  },

  rowLabel: (parsed) => {
    const name = text(parsed.name);
    return name === "" ? text(parsed.sku) : name;
  },

  duplicateModes: ["skip", "update", "fail"],
  duplicateRule:
    "Two rows are the same item when they have the same SKU, ignoring capitals.",

  contract: {
    /**
     * ⚠️ EMPTY, AND THAT CORRECTS THE PHASE BRIEF RATHER THAN OBEYING
     * IT. The brief said items depend on units of measure. They do not:
     * `uom` is a `varchar(20)` on this table and there is no unit
     * master to depend on. Declaring a dependency on an entity that does
     * not exist is refused by gate 29 — correctly, because it would put
     * a step in the customer's migration plan that they can never
     * complete.
     */
    dependsOn: [],

    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes:
        "An item that has had stock movements posted against it since the import cannot be removed — the ledger refers to it, and the database refuses (`stock_movements.stock_item_id` is ON DELETE RESTRICT). Those items stay, and the undo says which.",
      because:
        "`update` is offered, so a run can overwrite an item that pre-dates the migration and carries a valuation method, a reorder level and a history of movements priced against it. Deleting those on undo would destroy data the run never created.",
    },

    provenance: { targets: ["stock_items"], cardinality: "one-to-one" },

    /**
     * ⚠️ EMPTY, AND DELIBERATELY SO. An item is not a thing without an
     * SKU or a name — and both are refused by `stockItemSchema`, which
     * is the mechanism that actually runs on every row. Naming them here
     * as well would be a second copy of a rule, and the second copy is
     * the one that would still say `sku` after somebody renamed the
     * field. There are no lookups on this entity, which is the case
     * `structural` exists for.
     */
    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "An item's valuation method restates the cost of everything sold against it, so overwriting an item you already have is a bigger act than adding one. Start with skip; if what you are loading is genuinely a corrected master file, choose overwrite deliberately.",
    },
  },
};

/* ================================================================== */
/* ② WAREHOUSES — WAVE 0                                              */
/* ================================================================== */

const warehousesEntity: ContractedImportEntity = {
  key: "warehouses",
  /** ⭐ WAVE 2C. No money column on this entity. */
  money: { source: "none" },
  label: "Warehouses",
  noun: { one: "warehouse", many: "warehouses" },
  description:
    "The stores, godowns and site stores you hold stock in. Load these before your " +
    "opening stock, which names them by code.",
  table: "warehouses",

  feature: "inventory.stock",
  createPermission: "inventory.warehouses.manage",
  updatePermission: "inventory.warehouses.manage",

  columns: [
    {
      field: "code",
      header: "Code",
      kind: "text",
      required: true,
      maxLength: 40,
      aliases: ["warehousecode", "storecode", "godowncode", "locationcode", "site"],
      help:
        "Your short code for the place — MUM-01. This is what your opening stock file " +
        "must name, and what a re-import matches on.",
    },
    {
      field: "name",
      header: "Name",
      kind: "text",
      required: true,
      maxLength: 200,
      aliases: ["warehousename", "storename", "godown", "location", "store"],
      help: "What people call it.",
    },
    {
      field: "warehouseType",
      header: "Type",
      kind: "enum",
      required: false,
      enumValues: WAREHOUSE_TYPES,
      aliases: ["type", "storetype", "warehousetype", "category"],
      help: `One of: ${WAREHOUSE_TYPES.join(", ")}. Left blank it is 'own'.`,
    },
    {
      field: "city",
      header: "City",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["town", "district"],
      help: "Free text.",
    },
    {
      field: "state",
      header: "State",
      kind: "text",
      required: false,
      maxLength: 120,
      aliases: ["province", "region"],
      help: "Free text.",
    },
    {
      field: "stateCode",
      header: "State code",
      kind: "text",
      required: false,
      maxLength: 2,
      aliases: ["gststatecode", "statecode"],
      help:
        "The two-digit GST state code — 27 for Maharashtra, 29 for Karnataka. Exactly " +
        "two characters.",
    },
    {
      /**
       * ⚠️ THE GSTIN OF THE PLACE, WHICH IS NOT ALWAYS THE COMPANY'S.
       * A transfer between two of our own stores in different states is
       * a taxable supply under Schedule I — it needs a tax invoice and
       * an e-way bill though nothing was sold. A business that does not
       * record which GSTIN each store sits under cannot tell a transfer
       * from a supply, and finds out at an audit.
       */
      field: "gstin",
      header: "GSTIN",
      kind: "text",
      required: false,
      maxLength: 15,
      aliases: ["gst", "gstnumber", "gstno", "gstin"],
      help:
        "The GSTIN registered at this address, if it has its own. Exactly 15 characters. " +
        "Leave blank if the store sits under your main registration.",
    },
    {
      field: "allowNegativeStock",
      header: "Allow negative stock",
      kind: "boolean",
      required: false,
      aliases: ["allownegative", "negativestock", "permitnegative"],
      help:
        "yes/no. 'yes' lets this store issue goods it has not yet booked in — true of " +
        "some site stores, and it makes every valuation figure for the store " +
        "provisional. Left blank it is no.",
    },
    {
      field: "notes",
      header: "Notes",
      kind: "text",
      required: false,
      maxLength: 2000,
      aliases: ["remarks", "comments", "description"],
      help: "Free text.",
    },
  ],

  /**
   * ⚠️ NO `projectId` COLUMN, THOUGH THE SCHEMA HAS THE FIELD. A site
   * store belongs to a project, and a project is named by CODE in every
   * customer export we have seen — but there is no `project_by_code`
   * lookup kind, and inventing one means editing `ImportLookupKind` and
   * `resolveLookups`, neither of which this phase owns. Offering the
   * column with nothing behind it would put a heading in the blank
   * template that silently does nothing, which is the built-and-
   * unreachable shape this project keeps finding. Requested in
   * `PATCH-REQUEST-PHASE-7.md` instead.
   */
  buildPayload: (values) => ({
    code: values.code,
    name: values.name,
    warehouseType: orDefault(values.warehouseType),
    city: values.city,
    state: values.state,
    stateCode: values.stateCode,
    gstin: values.gstin,
    allowNegativeStock: orDefault(values.allowNegativeStock),
    notes: values.notes,
  }),

  schema: warehouseSchema,

  naturalKey: (parsed) => {
    const code = fold(parsed.code);
    if (code === "") return null;
    return { kind: "code", value: code, label: `code ${text(parsed.code)}` };
  },

  rowLabel: (parsed) => {
    const name = text(parsed.name);
    return name === "" ? text(parsed.code) : name;
  },

  duplicateModes: ["skip", "update", "fail"],
  duplicateRule:
    "Two rows are the same warehouse when they have the same code, ignoring capitals.",

  contract: {
    dependsOn: [],

    reversal: {
      kind: "restore-prior",
      capturePriorFields: ["*"],
      escapes:
        "A warehouse that has had stock movements posted into it since the import cannot be removed — the ledger refers to it and the database refuses. Those stay, and the undo says which.",
      because:
        "`update` is offered, so a run can overwrite a store record that pre-dates the migration and carries its own GSTIN and its negative-stock permission. Deleting those on undo would destroy data the run never created.",
    },

    provenance: { targets: ["warehouses"], cardinality: "one-to-one" },

    requiredness: { structural: [], messages: {} },

    duplicateDecision: {
      recommended: "skip",
      because:
        "Overwriting a store rewrites its GSTIN and whether it may go negative — two settings that change how tax and valuation are calculated for everything in it. Skip is the safe first answer; choose overwrite only when the file IS the corrected list.",
    },
  },
};

/* ================================================================== */
/* ③ BATCHES — WAVE 1                                                 */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 LOAD THESE BEFORE YOUR OPENING STOCK, NOT AFTER
 * ══════════════════════════════════════════════════════════════════════
 * `opening-stock` has a Batch column and no expiry column, and the
 * trigger in SQL 0055 creates a batch row for any lot it has not seen —
 * with a NULL expiry. Load the opening stock first and every lot in the
 * workspace has no printed date, on precisely the items that were marked
 * batch-tracked because their dates matter. Load the batches first and
 * the movement finds them.
 *
 * ⚠️ AND THE EXPIRY CANNOT BE FIXED AFTERWARDS BY RE-IMPORTING. This
 * entity offers no `update`: correcting a lot's expiry is `updateBatch`,
 * which requires a written reason, because the date decides what may be
 * sold. That refusal is the reason the ORDER matters rather than a
 * limitation somebody can work around.
 */
const batchesEntity: ContractedImportEntity = {
  key: "batches",
  /** ⭐ WAVE 2C. No money column on this entity. */
  money: { source: "none" },
  label: "Batches",
  noun: { one: "batch", many: "batches" },
  description:
    "The lots you already hold, with their manufacture and expiry dates. Load these " +
    "after your stock items and before your opening stock.",
  table: "stock_batches",

  feature: "inventory.traceability",
  createPermission: "inventory.movements.post",
  updatePermission: "inventory.movements.post",

  columns: [
    {
      field: "sku",
      header: "SKU",
      kind: "text",
      required: true,
      maxLength: 100,
      aliases: ["itemcode", "item", "productcode", "code", "partno", "materialcode"],
      help:
        "The item this lot is of, by its SKU in Ordence. Items are not created here — " +
        "load your stock items first.",
    },
    {
      field: "batchNo",
      header: "Batch",
      kind: "text",
      required: true,
      maxLength: 100,
      aliases: ["batchno", "lot", "lotno", "lotnumber", "batchnumber"],
      help: "Your lot number for it. One lot of one item is one row.",
    },
    {
      field: "supplierBatchNo",
      header: "Supplier batch",
      kind: "text",
      required: false,
      maxLength: 100,
      aliases: ["supplierbatch", "manufacturerbatch", "vendorlot", "supplierlot"],
      help: "The manufacturer's own lot code, when it differs from yours.",
    },
    {
      field: "manufactureDate",
      header: "Manufactured",
      kind: "date",
      required: false,
      aliases: ["mfgdate", "manufacturedate", "productiondate", "mfg"],
      help: "YYYY-MM-DD.",
    },
    {
      field: "expiryDate",
      header: "Expiry",
      kind: "date",
      required: false,
      aliases: ["expirydate", "expdate", "useby", "bestbefore", "shelflifeend"],
      help:
        "YYYY-MM-DD. One physical lot has one printed expiry, and this is the only " +
        "chance to load it in bulk — afterwards it can only be corrected one lot at a " +
        "time, with a written reason.",
    },
    {
      field: "status",
      header: "Status",
      kind: "enum",
      required: false,
      enumValues: ["active", "quarantined", "expired", "recalled", "written_off"],
      aliases: ["batchstatus", "condition", "hold"],
      help:
        "One of: active, quarantined, expired, recalled, written_off. Anything other " +
        "than 'active' stops the lot being picked. Left blank it is active.",
    },
    {
      field: "statusNote",
      header: "Status note",
      kind: "text",
      required: false,
      maxLength: 2000,
      aliases: ["statusreason", "holdreason", "quarantinereason", "note"],
      help: "Why it is on hold. Free text.",
    },
  ],

  buildPayload: (values) => ({
    sku: values.sku,
    batchNo: values.batchNo,
    supplierBatchNo: values.supplierBatchNo,
    manufactureDate: values.manufactureDate,
    expiryDate: values.expiryDate,
    status: orDefault(values.status),
    statusNote: values.statusNote,
  }),

  schema: stockBatchSchema,

  /**
   * ⚠️ THE KEY IS THE ITEM AND THE LOT TOGETHER, which is what
   * `stock_batches_item_batch_unique` says. Batch "01" of two different
   * items is two lots, and nothing but the item tells them apart — a key
   * on the batch number alone would collapse a customer's entire lot
   * register onto a handful of numbers.
   *
   * ⚠️ THE SKU IN THE KEY IS THE RAW TEXT, NOT THE RESOLVED ID.
   * `naturalKey` runs on the parsed payload, BEFORE lookups resolve;
   * reaching for `stockItemId` here would read a field that is not set
   * yet and key every row on `undefined`, collapsing the whole file onto
   * one match. The writer does the join instead.
   */
  naturalKey: (parsed) => {
    const sku = fold(parsed.sku);
    const batch = fold(parsed.batchNo);
    if (sku === "" || batch === "") return null;
    return {
      kind: "itemBatch",
      value: `${sku}|${batch}`,
      label: `batch ${text(parsed.batchNo)} of ${text(parsed.sku)}`,
    };
  },

  rowLabel: (parsed) => `${text(parsed.sku)} · ${text(parsed.batchNo)}`,

  /**
   * 🔴 ALWAYS EMITTED, because `stockBatchSchema` refuses a blank SKU —
   * so unlike the contacts example there is no row that quietly skips
   * the lookup. That is what makes `stockItemId` genuinely refused in
   * the PREVIEW rather than merely declared structural.
   */
  lookups: (parsed): readonly ImportLookup[] => {
    const sku = text(parsed.sku);
    if (sku === "") return [];
    return [
      {
        kind: "stock_item_by_sku",
        value: sku.toLowerCase(),
        into: "stockItemId",
        missing: `There is no active stock item with SKU "${sku}" in this workspace. Import your stock items first, or correct the code in this row.`,
      },
    ];
  },

  /**
   * 🔴 NO `update`, AND THE REASON IS THE ONE SQL 0055 GIVES.
   * "One physical lot has one printed expiry — one of these two is a
   * typing error, and correcting the batch is a deliberate act rather
   * than something a receipt should do quietly." An importer offering
   * overwrite would be the quiet path around that, five hundred lots at
   * a time.
   */
  duplicateModes: ["skip", "fail"],
  duplicateRule:
    "Two rows are the same lot when they name the same item and the same batch number.",

  contract: {
    dependsOn: [
      {
        entity: "stock-items",
        strength: "hard",
        because:
          "Every lot belongs to an item, named by SKU. Load your stock items first or every row here comes back saying the item was not found.",
      },
    ],

    /**
     * ⚠️ `delete` IS SAFE HERE ONLY BECAUSE `update` IS NOT OFFERED.
     * Every row this entity writes is a row it created; a lot that was
     * already in the workspace is skipped or refused, never overwritten.
     * Gate 29 refuses `update` + `delete` by name, and this is the other
     * side of that rule stated deliberately rather than by omission.
     */
    reversal: {
      kind: "delete",
      escapes:
        "A lot that has had a movement posted against it since the import cannot be removed — `stock_movements.batch_id` is ON DELETE RESTRICT, and the stock in it is real. Those lots stay, with the dates the import gave them.",
      because:
        "Rows this run wrote did not exist before it: `skip` and `fail` are the only duplicate modes, so nothing pre-existing is ever touched. Removing what the run created restores the prior state exactly.",
    },

    provenance: { targets: ["stock_batches"], cardinality: "one-to-one" },

    /**
     * ⚠️ STRUCTURAL, AND UNLIKE THE CONTACTS EXAMPLE IT IS ENFORCED BY
     * SOMETHING THAT RUNS. A lot belonging to no item is not a lot; the
     * lookup above is emitted for every row, so an SKU that matches
     * nothing is an ordinary reported row error in the preview, carrying
     * the sentence written there. This member states the judgement; the
     * lookup is what makes it happen. See `TRACK-REPORT.md` §4 for why
     * that distinction currently matters.
     */
    requiredness: {
      structural: ["stockItemId"],
      messages: {
        stockItemId:
          "No stock item in your workspace matched this SKU, so there is nothing for this lot to belong to. Import your stock items first, or correct the code in this row.",
      },
    },

    duplicateDecision: {
      recommended: "skip",
      because:
        "A lot that is already recorded already has an expiry date somebody put there on purpose, and this import will not overwrite it. Skip loads the lots you do not yet have and leaves the rest alone; choose 'tell me about it' if you expected the file to be entirely new.",
    },
  },
};

/* ================================================================== */
/* THE FRAGMENT                                                        */
/* ================================================================== */

/**
 * ⚠️ ONE MAP, SPREAD INTO `IMPORT_ENTITIES` BY A SINGLE LINE. See the
 * header: five phases, five one-line merges, no shared rewrite.
 *
 * ⭐ THE ORDER IS THE ORDER A CUSTOMER LOADS THEM IN, which is not
 * alphabetical and is not accidental: items and stores first because
 * everything else names them, lots after the items they are lots of.
 * `resolveImportOrder()` derives the same thing from `dependsOn` and
 * does not read this order — but a reader of this file should see it.
 */
export const INVENTORY_IMPORT_ENTITIES = {
  "stock-items": stockItemsEntity,
  warehouses: warehousesEntity,
  batches: batchesEntity,
} as const satisfies Record<string, ContractedImportEntity>;
