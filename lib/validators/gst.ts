/**
 * Ordence — GST Validation Schemas
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVER ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A file marked `"use server"` may ONLY export async functions. Every
 * other export in such a file is compiled into a callable RPC endpoint
 * reachable by anyone on the internet. Six Zod schemas were found
 * exported from `"use server"` files in Phase 7 and had to be moved.
 *
 * Schemas are pure values — the server action and the client form import
 * the same ones, which is also the only way to stop a form accepting
 * input the action will reject.
 */

import { z } from "zod";
import { isValidGstin, GST_STATE_CODES } from "@/lib/billing/money";
import { isPlaceOfSupplyCode } from "@/lib/gst/constants";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

const uuid = z.string().uuid("Not a valid identifier.");

/**
 * ⚠️ THE CHECKSUM IS PART OF THE SCHEMA, NOT A LATER STEP.
 *
 * A shape-only rule accepts `27AAACR5055K1ZX` — right length, right
 * character classes, real state, wrong fifteenth character. That passes
 * every screen in the product and is rejected at GSTR-1 upload weeks
 * later, by which time the buyer has paid against a document that has to
 * be cancelled and reissued.
 *
 * Uppercased first: a GSTIN pasted from an email signature is as likely
 * to be lower case as not, and rejecting it for that would be absurd.
 */
export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(15, "A GSTIN is exactly 15 characters.")
  .refine(isValidGstin, "That is not a valid GSTIN — check it character by character.");

export const optionalGstin = gstinSchema.optional().nullable();

/** A two-digit state code that a GSTIN could legitimately begin with. */
export const stateCodeSchema = z
  .string()
  .trim()
  .length(2, "A state code is two digits.")
  .refine((v) => v in GST_STATE_CODES, "Select a valid Indian state or territory.");

/**
 * ⚠️ WIDER THAN `stateCodeSchema`, ON PURPOSE. A place of supply may be
 * "96 — Other Country" on an export, and there is no registration behind
 * it. A GSTIN may never begin with 96, which is why the two schemas are
 * not the same one.
 */
export const placeOfSupplySchema = z
  .string()
  .trim()
  .length(2, "A place-of-supply code is two digits.")
  .refine(isPlaceOfSupplyCode, "Select a valid place of supply.");

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "That is not a valid PAN.");

/**
 * ⚠️ A CALENDAR DAY, AS A STRING. Never a `Date`.
 *
 * A rate takes effect on a day in India. A `Date` carrying a time is one
 * timezone conversion away from landing on the wrong side of a rate
 * change — 2019-03-31T20:00:00Z is 1 April in Mumbai — and the
 * consequence is an invoice at 12% that should have been 5%.
 */
export const civilDaySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2019-04-01.");

const addressSchema = z
  .object({
    line1: z.string().trim().max(255).optional(),
    line2: z.string().trim().max(255).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(60).optional(),
  })
  .optional();

export const registrationTypeSchema = z.enum([
  "regular",
  "composition",
  "unregistered",
  "sez",
  "overseas",
]);

export const supplyTypeSchema = z.enum(["goods", "services", "immovable_property"]);

/* ------------------------------------------------------------------ */
/* OUR REGISTRATIONS                                                   */
/* ------------------------------------------------------------------ */

export const createRegistrationSchema = z
  .object({
    gstin: gstinSchema,
    legalName: z.string().trim().min(1, "Enter the legal name on the certificate.").max(255),
    tradeName: z.string().trim().max(255).optional().nullable(),
    registrationType: registrationTypeSchema.default("regular"),
    address: addressSchema,
    effectiveFrom: civilDaySchema,
    effectiveTo: civilDaySchema.optional().nullable(),
    isPrimary: z.boolean().default(false),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveTo"],
        message: "A registration cannot end before it starts.",
      });
    }
    // ⚠️ An "unregistered" own registration is a contradiction: the row
    // exists because a GSTIN exists.
    if (value.registrationType === "unregistered" || value.registrationType === "overseas") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationType"],
        message:
          "This is one of OUR registrations, so it cannot be unregistered or " +
          "overseas. Record a counterparty under Parties instead.",
      });
    }
  });

export const retireRegistrationSchema = z.object({
  id: uuid,
  /** The day the registration ceases. Invoices before it keep it. */
  effectiveTo: civilDaySchema,
  reason: z.string().trim().min(1, "Say why this registration is being retired.").max(500),
});

/* ------------------------------------------------------------------ */
/* COUNTERPARTIES                                                      */
/* ------------------------------------------------------------------ */

export const upsertPartySchema = z
  .object({
    id: uuid.optional(),
    partyType: z.enum(["customer", "vendor"]),
    leadId: uuid.optional().nullable(),
    channelPartnerId: uuid.optional().nullable(),
    companyId: uuid.optional().nullable(),
    legalName: z.string().trim().min(1, "Enter the party's legal name.").max(255),
    tradeName: z.string().trim().max(255).optional().nullable(),
    gstin: optionalGstin,
    panNumber: panSchema.optional().nullable(),
    registrationType: registrationTypeSchema,
    stateCode: stateCodeSchema.optional().nullable(),
    address: addressSchema,
    effectiveFrom: civilDaySchema,
    effectiveTo: civilDaySchema.optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    const expectsGstin =
      value.registrationType !== "unregistered" && value.registrationType !== "overseas";

    if (expectsGstin && !value.gstin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gstin"],
        message:
          `A ${value.registrationType} party must have a GSTIN. Without it the ` +
          `supply is reported as B2C and they lose the input credit.`,
      });
    }
    if (!expectsGstin && value.gstin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationType"],
        message:
          "This party has a GSTIN, so they are registered. Change the type to " +
          "regular or composition.",
      });
    }
    if (value.gstin && value.stateCode && value.stateCode !== value.gstin.slice(0, 2)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stateCode"],
        message:
          `The GSTIN is registered in ${GST_STATE_CODES[value.gstin.slice(0, 2)] ?? "another state"} ` +
          `(code ${value.gstin.slice(0, 2)}) but the state says ${value.stateCode}. ` +
          `A mismatch flips an invoice between IGST and CGST+SGST.`,
      });
    }
    if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveTo"],
        message: "The end date is before the start date.",
      });
    }
  });

/* ------------------------------------------------------------------ */
/* HSN / SAC                                                           */
/* ------------------------------------------------------------------ */

export const createHsnSacSchema = z
  .object({
    code: z.string().trim().min(2).max(8).regex(/^\d+$/, "HSN and SAC codes are digits only."),
    kind: z.enum(["hsn", "sac"]),
    description: z.string().trim().min(1, "Describe what this code covers.").max(500),
    uqc: z.string().trim().max(10).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "sac" && !/^99\d{4}$/.test(value.code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["code"],
        message: "A SAC is six digits beginning 99, e.g. 995411.",
      });
    }
    if (value.kind === "hsn" && ![2, 4, 6, 8].includes(value.code.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["code"],
        message:
          "An HSN is 2, 4, 6 or 8 digits. How many you must quote depends on " +
          "turnover — 4 below ₹5 crore, 6 above, 8 for exports.",
      });
    }
  });

/**
 * ⭐ A NEW RATE PERIOD.
 *
 * ⚠️ THERE IS NO `updateRateSchema`, AND THE ABSENCE IS THE DESIGN. A
 * rate is superseded by opening a new period, never by editing the old
 * one — the database refuses the edit (SQL 0021 §5) once any invoice has
 * used it, and offering an "edit rate" form would be offering an action
 * that fails for exactly the rows that matter.
 */
export const addRatePeriodSchema = z
  .object({
    hsnSacId: uuid,
    /** Basis points. 500 = 5%, 1800 = 18%. */
    rateBps: z
      .number()
      .int("Enter the rate in basis points: 5% is 500.")
      .min(0)
      .max(10_000, "A GST rate cannot exceed 100%."),
    cessRateBps: z.number().int().min(0).max(100_000).default(0),
    /** Paise per unit, as a decimal string. Money never crosses as a number. */
    cessPerUnit: z
      .string()
      .trim()
      .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use a plain amount like "400.00".')
      .optional()
      .nullable(),
    effectiveFrom: civilDaySchema,
    effectiveTo: civilDaySchema.optional().nullable(),
    notificationRef: z.string().trim().max(160).optional().nullable(),
    itcEligible: z.boolean().default(true),
    reverseCharge: z.boolean().default(false),
    notes: z.string().trim().max(2000).optional().nullable(),
    /**
     * ⚠️ THE CALLER MUST SAY WHETHER IT MEANS TO CLOSE THE OPEN PERIOD.
     *
     * Adding a rate from 1 April when an open-ended period already runs
     * would collide with the EXCLUDE constraint, and the useful thing to
     * do is close the old one on that day. That is what a notification
     * does — but it RESTATES nothing, so it must be asked for rather
     * than assumed. `false` gives the constraint error, which is the
     * right outcome when the user did not mean to supersede anything.
     */
    supersedeCurrent: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveTo"],
        message:
          "The end date is exclusive, so it must be after the start date. A " +
          "period that opens and closes on one day applied for no days at all.",
      });
    }
  });

/** Close an open rate period on the day its successor begins. */
export const closeRatePeriodSchema = z.object({
  id: uuid,
  effectiveTo: civilDaySchema,
});

/* ------------------------------------------------------------------ */
/* RESOLUTION & COMPUTATION                                            */
/* ------------------------------------------------------------------ */

export const resolveRateSchema = z.object({
  hsnSacCode: z.string().trim().min(2).max(8),
  /** ⭐ Required. There is no "current rate" question in this system. */
  on: civilDaySchema,
});

export const placeOfSupplyQuerySchema = z.object({
  supplierStateCode: stateCodeSchema,
  supplyType: supplyTypeSchema,
  recipientRegistration: registrationTypeSchema,
  recipientStateCode: placeOfSupplySchema.optional().nullable(),
  propertyStateCode: stateCodeSchema.optional().nullable(),
  deliveryStateCode: stateCodeSchema.optional().nullable(),
});

/** A line as it arrives from a form. Money is a decimal STRING. */
export const taxLineInputSchema = z.object({
  key: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  hsnSacCode: z.string().trim().min(2).max(8).optional().nullable(),
  quantity: z.number().int().min(1).default(1),
  uqc: z.string().trim().max(10).optional().nullable(),
  /**
   * ⚠️ A DECIMAL STRING, NEVER A NUMBER. `JSON.parse("87456330.55")` is
   * a float, and a float that has been through JSON is not the number
   * that was typed. Money crosses the wire as a string and becomes
   * bigint paise on arrival — the rule set in Phase 11 and unchanged.
   */
  amount: z.string().trim().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Use a plain amount like "4500000".'),
  discount: z
    .string()
    .trim()
    .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Use a plain amount like "50000".')
    .optional()
    .nullable(),
  reverseCharge: z.boolean().default(false),
});

export const computeTaxSchema = z.object({
  supplierRegistrationId: uuid,
  supplyType: supplyTypeSchema,
  recipientRegistration: registrationTypeSchema,
  recipientStateCode: placeOfSupplySchema.optional().nullable(),
  propertyStateCode: stateCodeSchema.optional().nullable(),
  deliveryStateCode: stateCodeSchema.optional().nullable(),
  /** ⭐ The date the rates are resolved on. Not "today". */
  taxPointDate: civilDaySchema,
  lines: z.array(taxLineInputSchema).min(1, "An invoice needs at least one line."),
  roundToRupee: z.boolean().default(false),
});

export type CreateRegistrationInput = z.infer<typeof createRegistrationSchema>;
export type UpsertPartyInput = z.infer<typeof upsertPartySchema>;
export type CreateHsnSacInput = z.infer<typeof createHsnSacSchema>;
export type AddRatePeriodInput = z.infer<typeof addRatePeriodSchema>;
export type ComputeTaxInput = z.infer<typeof computeTaxSchema>;
