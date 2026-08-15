/**
 * Ordence — ⭐ Sales Order Validators
 * Version: v0.39.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE SCHEMAS ARE FOR, AND WHAT THEY ARE NOT FOR
 * ══════════════════════════════════════════════════════════════════════
 * They reject input that is malformed. They do NOT enforce the order
 * rules — a frozen line, a legal transition, an over-dispatch — because
 * this file runs on one write path and the database runs on all of them.
 * A validator that duplicates a trigger is a validator that will
 * eventually disagree with it, and the disagreement always favours the
 * looser one.
 *
 * ⚠️ MONEY ARRIVES AS A STRING OF MINOR UNITS. A JSON number cannot hold
 * ₹1,00,00,000.05 in paise without losing the paise — `Number` runs out
 * of integer precision at 2^53, and a crore in paise is 10^9, which is
 * fine until somebody enters a total contract value and it is not. So
 * amounts cross the wire as digit strings and become `bigint` here, once.
 *
 * ⚠️ QUANTITY ARRIVES AS A STRING TOO, for the same reason in reverse:
 * `0.1 + 0.2` is not `0.3`, and a tonnage that fails to add up on a
 * delivery challan is a dispute with a customer.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

/** A non-negative integer amount in minor units, as digits. */
export const minorAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

/** Signed variant — round-off and adjustments may be negative. */
export const signedMinorAmountSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

/**
 * Up to three decimal places, matching `numeric(18,3)` in the database.
 *
 * ⚠️ KEPT AS A STRING all the way to Postgres. Parsing it to a JS number
 * to "validate" it would introduce the exact rounding this type exists to
 * avoid.
 */
export const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,3})?$/, "Enter a quantity with up to three decimals.")
  .refine((v) => Number(v) > 0, "Quantity must be greater than zero.");

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker (YYYY-MM-DD).");

const uuidSchema = z.string().uuid("That is not a valid record reference.");
const optionalUuid = uuidSchema.optional().nullable();

export const orderStatusValues = [
  "draft",
  "pending_approval",
  "confirmed",
  "partially_fulfilled",
  "fulfilled",
  "closed",
  "cancelled",
  "on_hold",
] as const;

export const orderLineKindValues = [
  "goods",
  "service",
  "works_contract",
  "freight",
  "discount",
  "other_charge",
] as const;

export const fulfillmentStatusValues = [
  "planned",
  "picked",
  "dispatched",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
] as const;

/* ------------------------------------------------------------------ */
/* LINES                                                               */
/* ------------------------------------------------------------------ */

export const orderLineInputSchema = z.object({
  /** Present when amending an existing line; absent when adding one. */
  id: optionalUuid,
  lineNo: z.number().int().min(1).max(9999),
  kind: z.enum(orderLineKindValues).default("goods"),
  assetId: optionalUuid,
  sku: z.string().trim().max(100).optional().nullable(),
  /**
   * ⚠️ REQUIRED EVEN WHEN `assetId` IS SET. The description is what
   * prints on the customer's paperwork, and a catalog rename two years
   * from now must not silently rewrite a document somebody signed.
   */
  description: z.string().trim().min(1, "Describe what is being supplied.").max(2000),
  hsnSacCodeId: optionalUuid,
  hsnSacRateId: optionalUuid,
  taxRateBps: z.number().int().min(0).max(10000).optional().nullable(),
  cessRateBps: z.number().int().min(0).max(10000).optional().nullable(),
  quantity: quantitySchema,
  uom: z.string().trim().min(1).max(20).default("nos"),
  unitPriceMinor: minorAmountSchema,
  discountMinor: minorAmountSchema.optional(),
  warehouseCode: z.string().trim().max(60).optional().nullable(),
  requestedDate: isoDateSchema.optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

/* ------------------------------------------------------------------ */
/* ORDERS                                                              */
/* ------------------------------------------------------------------ */

const orderBaseSchema = z.object({
  customerReference: z.string().trim().max(120).optional().nullable(),
  orderDate: isoDateSchema,
  promisedDate: isoDateSchema.optional().nullable(),
  expectedDispatchDate: isoDateSchema.optional().nullable(),

  companyId: optionalUuid,
  contactId: optionalUuid,
  gstPartyId: optionalUuid,
  sellerRegistrationId: optionalUuid,
  /**
   * ⚠️ v1.37.0: THIS IS NO LONGER AN INPUT, IT IS AN ASSERTION.
   *
   * `createOrder` determines the place of supply from the facts and
   * REFUSES if what the caller sent disagrees. It used to be taken at
   * face value, which meant a caller could choose their own tax
   * treatment — and since the total is identical either way, nothing on
   * the screen would have looked wrong.
   *
   * Left in the schema because the UI shows the determined value back and
   * round-trips it, and because a caller who sends a stale one deserves
   * the explicit disagreement rather than a silent overwrite.
   */
  placeOfSupplyCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/, "Place of supply is the two-digit state code.")
    .optional()
    .nullable(),

  /**
   * ⭐ WHICH SECTION OF THE ACT APPLIES. Not cosmetic: `immovable_property`
   * selects s.12(3) instead of s.12(2), and it is what a works contract
   * or an under-construction unit is, whatever the line kinds say.
   */
  supplyType: z.enum(["goods", "services", "immovable_property"]).default("services"),

  /**
   * ⭐ WHERE THE SITE IS, as a GST code. Falls back to the project's
   * `stateCode` when omitted. Under s.12(3) this IS the place of supply.
   */
  propertyStateCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/, "The property's state is a two-digit GST state code.")
    .optional()
    .nullable(),

  /**
   * ⚠️ DELIVERY STATE AS A CODE, SEPARATE FROM `shippingState`.
   *
   * `shippingState` is varchar(120) free text holding "Karnataka". For
   * goods, s.10(1)(a) puts the place of supply where the movement
   * terminates, and that comparison needs "29". Feeding prose to the
   * engine does not fail loudly — it fails the `isPlaceOfSupplyCode`
   * test and falls through to the supplier's own state, quietly making
   * every inter-state consignment intra-state.
   */
  deliveryStateCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/, "The delivery state is a two-digit GST state code.")
    .optional()
    .nullable(),

  dealId: optionalUuid,
  projectId: optionalUuid,
  bookingId: optionalUuid,
  channelPartnerId: optionalUuid,

  currency: z.string().trim().length(3).default("INR"),
  otherChargesMinor: minorAmountSchema.optional(),
  roundOffMinor: signedMinorAmountSchema.optional(),

  paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
  paymentTermsNote: z.string().trim().max(300).optional().nullable(),
  incoterm: z.string().trim().max(20).optional().nullable(),

  shippingName: z.string().trim().max(200).optional().nullable(),
  shippingLine1: z.string().trim().max(255).optional().nullable(),
  shippingLine2: z.string().trim().max(255).optional().nullable(),
  shippingCity: z.string().trim().max(120).optional().nullable(),
  shippingState: z.string().trim().max(120).optional().nullable(),
  shippingPostalCode: z.string().trim().max(20).optional().nullable(),
  shippingCountry: z.string().trim().length(2).default("IN"),
  shippingPhone: z.string().trim().max(40).optional().nullable(),

  ownerUserId: optionalUuid,
  notes: z.string().trim().max(5000).optional().nullable(),
  customerNotes: z.string().trim().max(5000).optional().nullable(),
});

export const createOrderSchema = orderBaseSchema.extend({
  lines: z
    .array(orderLineInputSchema)
    .min(1, "An order needs at least one line.")
    .max(500, "Split an order of more than 500 lines — no warehouse picks that as one job."),
});

export const updateOrderSchema = orderBaseSchema.partial().extend({
  id: uuidSchema,
});

/**
 * ⭐ AN AMENDMENT, NOT AN EDIT.
 *
 * ⚠️ `reason` IS REQUIRED AND IS NOT DECORATION. It prints on the revised
 * order the customer receives and on the warehouse's copy. An amendment
 * without one is a changed commitment that nobody can explain when the
 * customer rings about it, which is the call that always comes.
 */
export const amendOrderSchema = z.object({
  id: uuidSchema,
  reason: z
    .string()
    .trim()
    .min(10, "Say what changed and why, in a sentence the customer could be read.")
    .max(2000),
  lines: z.array(orderLineInputSchema).min(1).max(500),
});

export const confirmOrderSchema = z.object({
  id: uuidSchema,
  /** Skipped only where the workspace does not require approval at all. */
  approvalNote: z.string().trim().max(1000).optional().nullable(),
});

export const cancelOrderSchema = z.object({
  id: uuidSchema,
  reason: z
    .string()
    .trim()
    .min(10, "A cancellation needs a reason — the customer will ask for it.")
    .max(2000),
});

export const holdOrderSchema = z.object({
  id: uuidSchema,
  reason: z.string().trim().min(5).max(2000),
});

export const releaseOrderSchema = z.object({ id: uuidSchema });

export const closeOrderSchema = z.object({
  id: uuidSchema,
  note: z.string().trim().max(2000).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* FULFILMENT                                                          */
/* ------------------------------------------------------------------ */

export const recordFulfillmentSchema = z.object({
  orderId: uuidSchema,
  dispatchedAt: z.string().trim().min(1).optional().nullable(),
  carrierName: z.string().trim().max(150).optional().nullable(),
  trackingNumber: z.string().trim().max(120).optional().nullable(),
  vehicleNumber: z.string().trim().max(40).optional().nullable(),
  driverName: z.string().trim().max(150).optional().nullable(),
  driverPhone: z.string().trim().max(40).optional().nullable(),
  ewayBillNo: z.string().trim().max(30).optional().nullable(),
  ewayBillDate: isoDateSchema.optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  lines: z
    .array(
      z.object({
        orderLineId: uuidSchema,
        quantity: quantitySchema,
        batchNo: z.string().trim().max(100).optional().nullable(),
        serialNumbers: z.array(z.string().trim().max(120)).max(1000).optional(),
      }),
    )
    .min(1, "A dispatch needs at least one line — otherwise nothing left the building."),
});

export const markDeliveredSchema = z.object({
  fulfillmentId: uuidSchema,
  deliveredAt: z.string().trim().min(1).optional().nullable(),
  receivedBy: z
    .string()
    .trim()
    .min(2, "Record who signed for it — it is the only evidence of delivery.")
    .max(200),
});

export const orderQuerySchema = z.object({
  status: z.enum(orderStatusValues).optional(),
  companyId: optionalUuid,
  projectId: optionalUuid,
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type AmendOrderInput = z.infer<typeof amendOrderSchema>;
export type RecordFulfillmentInput = z.infer<typeof recordFulfillmentSchema>;
