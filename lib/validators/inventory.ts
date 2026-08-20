/**
 * Ordence — Inventory validators
 * Version: v1.85.0-alpha · Phase 7 (inventory entities)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS NOT A NEW SET OF RULES
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/types.ts` requires that an entity validate through "THE
 * SAME SCHEMA THE SINGLE-RECORD SERVER ACTION PARSES. NOT A COPY, NOT AN
 * 'IMPORT VARIANT', NOT A LOOSER ONE."
 *
 * The warehouse and stock-item schemas already existed. They were
 * `const warehouseSchema` and `const stockItemSchema` in
 * `server/actions/inventory.ts` — and they could not be reached:
 *
 *   ① that file carries `"use server"`, and a `"use server"` module may
 *      export ONLY async functions. Exporting a Zod object from it
 *      publishes nothing and breaks the build; and
 *   ② `lib/import/` must not import from `server/` at all. Gate
 *      `check:boundaries` says so, and `lib/import/types.ts` gives the
 *      reason: the decision layer has to stay testable without Postgres
 *      and the client wizard has to be able to build a blank template
 *      from the column list.
 *
 * ⚠️ SO THE RULE COULD NOT BE OBEYED WITHOUT MOVING THE SCHEMAS, AND
 *    MOVING THEM IS THE WHOLE OF THE CHANGE. Every regex, every bound,
 *    every message below came out of `server/actions/inventory.ts`
 *    verbatim. `saveWarehouse` and `saveStockItem` now import them from
 *    here, so there is exactly ONE definition of what a warehouse is,
 *    and the importer and the form are the same rules rather than two
 *    sets that agree today. See `PATCH-REQUEST-PHASE-7.md`.
 *
 * 🔴 IF YOU ARE ABOUT TO WRITE A SECOND, LOOSER COPY OF ANY OF THESE
 *    BECAUSE AN IMPORT FILE WOULD NOT PASS — that is the failure this
 *    header is here to stop. A row the form would refuse is a row the
 *    import must refuse; ten thousand of them arriving at once is worse,
 *    not better.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* SHARED PIECES — MOVED VERBATIM                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A DECIMAL STRING, NOT A NUMBER AND NOT INTEGER THOUSANDTHS.
 *
 * `numeric(18,3)` does not survive a round trip through a JS float —
 * 12.5 tonnes becomes 12.499999999999998 — so quantities cross every
 * boundary in this product as strings. `server/actions/inventory.ts`
 * says so at the head of the file.
 *
 * 🔴 THE IMPORT COERCION LAYER PRODUCES INTEGER THOUSANDTHS ("12500"
 *    for 12.5), which this regex would happily accept as twelve
 *    thousand five hundred — a thousandfold error that validates
 *    cleanly. `lib/import/entities-inventory.ts` converts before it
 *    builds the payload and says why at the call site.
 */
export const quantityString = z
  .string()
  .trim()
  .regex(/^-?\d{1,15}(\.\d{1,3})?$/, "Enter a quantity with up to three decimals.");

export const positiveQuantity = quantityString.refine(
  (v) => Number(v) > 0,
  "Quantity must be greater than zero.",
);

/**
 * Money as a digit string of minor units, transformed to `bigint`.
 *
 * ⚠️ THE TRANSFORM IS PART OF THE CONTRACT. Callers receive a `bigint`
 * and write it into a `bigint` column; nothing calls `Number()` on an
 * amount anywhere along the path.
 */
export const minorAmount = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

/** A calendar day. Never a `Date` — see `lib/validators/gst.ts`. */
export const civilDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/* ------------------------------------------------------------------ */
/* WAREHOUSES — MOVED FROM server/actions/inventory.ts                 */
/* ------------------------------------------------------------------ */

export const warehouseSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(1, "Give the store a short code.").max(40),
  name: z.string().trim().min(1, "Give the store a name.").max(200),
  warehouseType: z
    .enum(["own", "site", "consignment", "transit", "third_party", "quarantine"])
    .default("own"),
  projectId: z.string().uuid().optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  stateCode: z.string().trim().length(2).optional().nullable(),
  gstin: z.string().trim().length(15).optional().nullable(),
  /**
   * ⚠️ SURFACED AS AN EXPLICIT CHOICE, NEVER A SILENT DEFAULT. Switching
   * this on means every valuation for this store depends on the
   * paperwork catching up with the lorry.
   */
  allowNegativeStock: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const WAREHOUSE_TYPES = [
  "own",
  "site",
  "consignment",
  "transit",
  "third_party",
  "quarantine",
] as const;

/* ------------------------------------------------------------------ */
/* STOCK ITEMS — MOVED FROM server/actions/inventory.ts                */
/* ------------------------------------------------------------------ */

export const stockItemSchema = z.object({
  id: z.string().uuid().optional(),
  assetId: z.string().uuid().optional().nullable(),
  sku: z.string().trim().min(1, "Every stock item needs an SKU.").max(100),
  name: z.string().trim().min(1).max(300),
  description: z.string().trim().max(2000).optional().nullable(),
  uom: z.string().trim().min(1).max(20).default("nos"),
  trackingMode: z.enum(["none", "batch", "serial"]).default("none"),
  valuationMethod: z
    .enum(["fifo", "weighted_average", "specific", "standard"])
    .default("weighted_average"),
  standardCostMinor: minorAmount.optional().nullable(),
  reorderLevel: quantityString.optional().nullable(),
  reorderQuantity: quantityString.optional().nullable(),
  leadTimeDays: z.number().int().min(0).max(3650).optional().nullable(),
  shelfLifeDays: z.number().int().min(0).max(36500).optional().nullable(),
  hsnSacCode: z.string().trim().max(20).optional().nullable(),
});

export const TRACKING_MODES = ["none", "batch", "serial"] as const;
export const VALUATION_METHODS = [
  "fifo",
  "weighted_average",
  "specific",
  "standard",
] as const;

/* ------------------------------------------------------------------ */
/* ⭐ STOCK BATCHES — WRITTEN HERE FIRST, LIKE THE OPENING SCHEMAS      */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS ONE HAD NO ORIGINAL TO MOVE, AND THAT IS A FACT ABOUT THE
 *    PRODUCT RATHER THAN AN OVERSIGHT
 * ══════════════════════════════════════════════════════════════════════
 * There is no "new batch" form and there never was. A batch row is born
 * inside `ordence_stock_movement_batch()` (SQL 0055) the first time a
 * receipt names a lot number, and the only single-record write path that
 * touches one afterwards is `updateBatch` — a CORRECTION, keyed on
 * `batchId`, carrying a mandatory written reason because moving an
 * expiry moves stock between saleable and not.
 *
 * 🔴 SO `batchUpdateSchema` IN `server/actions/batches.ts` IS NOT THE
 *    SCHEMA THIS IS A COPY OF. That one validates a COMMAND — "change
 *    batch X, and here is why". This validates a BATCH. They share three
 *    fields and no purpose, and collapsing them would mean either an
 *    importer that demands a ten-character justification on every row of
 *    a thousand-row file, or a correction path that no longer demands
 *    one. Both are worse than two small schemas with this paragraph
 *    between them.
 *
 * ⭐ AND THE RULE POINTS FORWARD, exactly as `lib/import/opening-schemas.ts`
 * argues for the opening balances: when somebody builds a screen for
 * recording a batch by hand, it must import THIS. A second set of rules
 * written next to that form is the same defect arriving from the
 * direction nobody watches.
 */
export const stockBatchSchema = z
  .object({
    /**
     * ⚠️ THE SKU, NOT THE ITEM ID. Nobody's export carries our uuids.
     * The importer resolves it to `stockItemId` in the preview.
     */
    sku: z.string().trim().min(1, "Every batch belongs to an item.").max(100),
    batchNo: z
      .string({
        required_error: "This batch has no number, so there is nothing to identify the lot by.",
        invalid_type_error:
          "This batch has no number, so there is nothing to identify the lot by.",
      })
      .trim()
      .min(1, "This batch has no number, so there is nothing to identify the lot by.")
      .max(100),
    supplierBatchNo: z.string().trim().max(100).nullish(),
    manufactureDate: civilDay.nullish(),
    expiryDate: civilDay.nullish(),
    /**
     * ⚠️ THE SAME FIVE THE DATABASE ALLOWS, AND NO OTHERS.
     * `stock_batches_status_known` is a CHECK constraint; a sixth word
     * here would be a row the importer accepts and the database refuses,
     * which is a failure in the commit rather than in the preview.
     */
    status: z
      .enum(["active", "quarantined", "expired", "recalled", "written_off"])
      .default("active"),
    statusNote: z.string().trim().max(2000).nullish(),
  })
  /**
   * 🔴 THE SAME REFUSAL THE DATABASE MAKES, MADE IN THE PREVIEW.
   * `stock_batches_expiry_after_manufacture` refuses goods that expire
   * before they are made. Left to the CHECK constraint it would surface
   * as a failed row DURING the commit, after the preview had promised
   * the row would land. `server/actions/batches.ts` makes the same call
   * for the same reason and even names the cause: "that is almost always
   * the year, typed once".
   */
  .superRefine((value, ctx) => {
    if (
      value.expiryDate &&
      value.manufactureDate &&
      value.expiryDate <= value.manufactureDate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiryDate"],
        message:
          "The expiry is on or before the manufacture date. That is almost always the year, typed once.",
      });
    }
  });
