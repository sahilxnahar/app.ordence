/**
 * Ordence — Purchase & ITC Validation Schemas
 * Version: v0.33.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVER ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A file marked `"use server"` may ONLY export async functions. Every
 * other export in such a file is compiled into a callable RPC endpoint
 * reachable by anyone on the internet. Schemas are pure values, so they
 * live here and are imported by the action AND by the form — which is
 * also the only way to stop a form accepting input the action rejects.
 *
 * ⚠️ THE GST PRIMITIVES ARE IMPORTED, NOT RESTATED. `gstinSchema`,
 * `stateCodeSchema`, `placeOfSupplySchema`, `panSchema`, `civilDaySchema`
 * and `supplyTypeSchema` all come from `lib/validators/gst.ts`. A second
 * GSTIN rule that disagrees with the first by one character is worse than
 * no second rule.
 */

import { z } from "zod";
import {
  civilDaySchema,
  gstinSchema,
  panSchema,
  placeOfSupplySchema,
  supplyTypeSchema,
} from "./gst";
import { isValidUdyamNumber, describeUdyamProblem } from "@/lib/purchases/vendor-ledger";
import { MSME_STATUTORY_MAX_DAYS } from "@/lib/purchases/vendor-ledger";

const uuid = z.string().uuid("Not a valid identifier.");

/**
 * Money crosses the boundary as a STRING and is parsed with `parseMoney`
 * on the far side.
 *
 * ⚠️ `JSON.stringify` THROWS ON A BIGINT. A number would work up to
 * 2^53 paise — about ₹90,000 crore — and would then start losing the last
 * digits of a figure silently. A construction company's annual purchase
 * volume does not reach that, and the invoice that finally does would
 * round rather than fail, which is the wrong failure.
 */
const moneyString = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,2})?$/, "Enter an amount like 1234.56.");

const nonNegativeMoney = moneyString.refine(
  (v) => !v.startsWith("-"),
  "An amount on a purchase invoice cannot be negative. A reduction is a credit note.",
);

/** `YYYY-MM`. The GSTR-3B period a credit is reported in. */
export const taxPeriodSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a tax period like 2024-07.");

/* ------------------------------------------------------------------ */
/* ENUM MIRRORS                                                        */
/* ------------------------------------------------------------------ */

export const vendorTypeSchema = z.enum([
  "material_supplier",
  "contractor",
  "professional",
  "transporter",
  "landlord",
  "utility",
  "government",
  "other",
]);

export const msmeCategorySchema = z.enum(["micro", "small", "medium"]);

export const itcPurposeSchema = z.enum([
  "taxable_supply",
  "sold_before_completion",
  "own_account_construction",
  "further_supply_works_contract",
  "plant_and_machinery",
  "exempt_supply",
  "common",
  "non_business",
]);

export const expenditureNatureSchema = z.enum([
  "goods",
  "input_service",
  "capital_goods",
  "motor_vehicle",
  "vessel_or_aircraft",
  "motor_vehicle_related_service",
  "food_and_beverage",
  "outdoor_catering",
  "beauty_or_health_service",
  "club_or_fitness_membership",
  "employee_travel_benefit",
  "life_or_health_insurance",
  "works_contract_service",
  "construction_material",
  "rent_a_cab",
]);

export const itcRegisterStatusSchema = z.enum([
  "claimed",
  "blocked",
  "deferred",
  "reversed",
]);

export const itcMovementReasonSchema = z.enum([
  "invoice_claim",
  "rcm_self_assessed",
  "section_17_5_blocked",
  "rule_42_common_reversal",
  "rule_43_capital_reversal",
  "rule_37_non_payment_180_days",
  "credit_note_received",
  "goods_not_received",
  "supplier_not_filed",
  "reclaim_after_payment",
  "annual_true_up",
]);

export const vendorLedgerEntryTypeSchema = z.enum([
  "purchase_invoice",
  "debit_note",
  "credit_note",
  "payment",
  "advance",
  "tds_deducted",
  "retention_held",
  "retention_released",
  "adjustment",
]);

/* ------------------------------------------------------------------ */
/* VENDORS                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE UDYAM NUMBER IS VALIDATED HERE, NOT ONLY SHAPED IN SQL.
 *
 * The CHECK constraint refuses a wrong shape. This refuses it with the
 * one sentence that actually helps: half the numbers vendors send are
 * twelve-digit Udyog Aadhaar numbers, which were replaced in July 2020
 * and are no longer verifiable. `UDYAM-MH-01-0001234` is what to ask for,
 * and saying so is the difference between a fixed record and a support
 * ticket.
 */
export const udyamNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .superRefine((value, ctx) => {
    if (isValidUdyamNumber(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: describeUdyamProblem(value) ?? "That is not a Udyam Registration Number.",
    });
  });

export const upsertVendorSchema = z
  .object({
    id: uuid.optional(),
    code: z.string().trim().min(1, "Give the vendor a code.").max(40),
    legalName: z.string().trim().min(1, "Enter the vendor's legal name.").max(255),
    tradeName: z.string().trim().max(255).optional().nullable(),
    vendorType: vendorTypeSchema.default("other"),

    /** The Phase 32 party row. Absent for an unregistered vendor. */
    gstPartyId: uuid.optional().nullable(),
    gstin: gstinSchema.optional().nullable(),
    companyId: uuid.optional().nullable(),
    panNumber: panSchema.optional().nullable(),

    msmeRegistered: z.boolean().default(false),
    udyamNumber: udyamNumberSchema.optional().nullable(),
    msmeCategory: msmeCategorySchema.optional().nullable(),
    msmeRegisteredOn: civilDaySchema.optional().nullable(),

    paymentTermsDays: z
      .number()
      .int()
      .min(0, "Payment terms cannot be negative.")
      .max(365, "Payment terms beyond a year are not a term, they are a dispute.")
      .default(30),

    tdsApplicable: z.boolean().default(false),
    defaultTdsSection: z.string().trim().max(12).optional().nullable(),

    address: z
      .object({
        line1: z.string().trim().max(255).optional(),
        line2: z.string().trim().max(255).optional(),
        city: z.string().trim().max(120).optional(),
        state: z.string().trim().max(120).optional(),
        postalCode: z.string().trim().max(20).optional(),
        country: z.string().trim().max(60).optional(),
      })
      .optional(),

    bankDetails: z
      .object({
        accountName: z.string().trim().max(160).optional(),
        accountNumberLast4: z.string().trim().max(4).optional(),
        ifsc: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "That is not a valid IFSC.")
          .optional(),
        bankName: z.string().trim().max(160).optional(),
      })
      .optional(),

    notes: z.string().trim().max(4000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.msmeRegistered && !value.udyamNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["udyamNumber"],
        message:
          "An MSME claim needs the Udyam Registration Number. Section 43B(h) only " +
          "bites for an enterprise REGISTERED under the MSMED Act — without the " +
          "number there is no registration to rely on, and the disallowance cannot " +
          "be defended if it is challenged.",
      });
    }
    if (value.msmeRegistered && !value.msmeCategory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["msmeCategory"],
        message:
          "Say whether this is a micro, small or medium enterprise. Section 43B(h) " +
          "applies to micro and small only, and treating a medium vendor the same " +
          "raises a false alarm on every one of them.",
      });
    }
    /**
     * ⭐ THE 45-DAY CAP IS NOT NEGOTIABLE BY CONTRACT.
     *
     * Section 15 of the MSMED Act caps the agreed period at 45 days and
     * Section 32 voids any agreement to the contrary. A 90-day purchase
     * order against a micro vendor is not a commercial choice; it is a
     * disallowance under Section 43B(h) that arrives at assessment.
     */
    if (
      value.msmeRegistered &&
      value.msmeCategory !== "medium" &&
      value.paymentTermsDays > MSME_STATUTORY_MAX_DAYS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentTermsDays"],
        message:
          `Payment to a registered micro or small enterprise must be within ${MSME_STATUTORY_MAX_DAYS} ` +
          `days (Section 15, MSMED Act), and Section 32 voids any longer agreement. ` +
          `Section 43B(h) of the Income-tax Act then disallows the whole expenditure ` +
          `if payment is late.`,
      });
    }
  });

export const blockVendorSchema = z.object({
  id: uuid,
  isActive: z.boolean(),
  blockedReason: z.string().trim().max(1000).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* PURCHASE INVOICES                                                   */
/* ------------------------------------------------------------------ */

/**
 * One line of a vendor's bill, with the facts the ITC determination
 * needs.
 *
 * ⚠️ `itcPurpose` HAS NO DEFAULT HERE, DELIBERATELY, EVEN THOUGH THE
 * COLUMN HAS ONE.
 *
 * The column defaults to `taxable_supply` so that an import of historical
 * bills does not fail. The FORM must not: defaulting the answer to the
 * eligible one means a person entering a cement bill for the company's
 * own head office claims the credit by pressing Enter, and Section
 * 17(5)(d) is the single most expensive mistake in this product.
 */
export const purchaseLineSchema = z.object({
  lineNumber: z.number().int().min(1),
  description: z.string().trim().min(1, "Describe the line.").max(2000),

  hsnSacCode: z.string().trim().max(8).optional().nullable(),
  quantity: z.string().trim().max(24).optional().nullable(),
  uqc: z.string().trim().max(10).optional().nullable(),

  amount: nonNegativeMoney,
  discount: nonNegativeMoney.optional(),

  /**
   * ⚠️ THE RATE IS THE SUPPLIER'S, RECORDED AS CHARGED — NOT RESOLVED
   * FROM OUR MASTER AND SUBSTITUTED.
   *
   * On the outward side the rate comes from the dated master because we
   * decide it. Here the supplier decided it, and what we owe them is what
   * they billed. The master is used to CHECK the charge, not to replace
   * it: a supplier billing 18% on a classification notified at 12% has
   * overcharged, and credit is available only on tax "charged in respect
   * of such supply" — which the excess is not.
   */
  rateBps: z.number().int().min(0).max(10_000),
  cessRateBps: z.number().int().min(0).max(100_000).default(0),

  cgst: nonNegativeMoney.default("0"),
  sgst: nonNegativeMoney.default("0"),
  igst: nonNegativeMoney.default("0"),
  cess: nonNegativeMoney.default("0"),

  isReverseCharge: z.boolean().default(false),

  /* --- ⭐ THE ITC FACTS ----------------------------------------- */
  itcPurpose: itcPurposeSchema,
  expenditureNature: expenditureNatureSchema.default("goods"),
  projectId: uuid.optional().nullable(),
  isCapitalGoods: z.boolean().default(false),

  /** The statutory exceptions. See `lib/purchases/itc.ts`. */
  vehicleUsedForTaxableOnwardSupply: z.boolean().optional(),
  statutoryObligationToEmployees: z.boolean().optional(),
  usedForSameCategoryOutwardSupply: z.boolean().optional(),
  /** ⭐ Does the OUTWARD rate on this project permit credit at all? */
  outwardRateAllowsItc: z.boolean().optional(),
});

export const recordPurchaseInvoiceSchema = z
  .object({
    vendorId: uuid,
    gstPartyId: uuid.optional().nullable(),

    /** ⭐ Whose electronic credit ledger this lands in. */
    recipientRegistrationId: uuid.optional().nullable(),

    invoiceNumber: z
      .string()
      .trim()
      .min(1, "Enter the vendor's invoice number, exactly as printed.")
      .max(64),
    invoiceDate: civilDaySchema,
    receivedDate: civilDaySchema.optional().nullable(),
    goodsReceivedDate: civilDaySchema.optional().nullable(),

    isBillOfSupply: z.boolean().default(false),

    supplyType: supplyTypeSchema.default("goods"),
    placeOfSupplyCode: placeOfSupplySchema.optional().nullable(),
    propertyStateCode: placeOfSupplySchema.optional().nullable(),

    projectId: uuid.optional().nullable(),

    isReverseCharge: z.boolean().default(false),
    rcmSection: z.string().trim().max(16).optional().nullable(),

    taxPeriod: taxPeriodSchema.optional().nullable(),

    isTdsDeductible: z.boolean().default(false),
    tdsSection: z.string().trim().max(12).optional().nullable(),

    roundOff: moneyString.default("0"),
    notes: z.string().trim().max(4000).optional().nullable(),

    lines: z
      .array(purchaseLineSchema)
      .min(1, "A purchase invoice needs at least one line."),
  })
  .superRefine((value, ctx) => {
    /**
     * ⭐ SECTION 12(3), ON THE INWARD SIDE TOO.
     *
     * A contractor's bill for building a tower is a supply relating to
     * immovable property and its place of supply is the PROPERTY's state
     * — not the contractor's, and not ours. Getting it wrong here does
     * not merely misclassify: it decides whether the credit arrives as
     * IGST or as CGST+SGST, and a credit that lands in the wrong state's
     * ledger cannot be used against that state's liability.
     */
    if (value.supplyType === "immovable_property") {
      if (!value.propertyStateCode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["propertyStateCode"],
          message:
            "This supply relates to immovable property, so under Section 12(3) of " +
            "the IGST Act the place of supply is the LOCATION OF THE PROPERTY. Set " +
            "the project's state.",
        });
      } else if (value.placeOfSupplyCode !== value.propertyStateCode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["placeOfSupplyCode"],
          message:
            "For immovable property the place of supply must EQUAL the property's " +
            "state. A credit taxed to the wrong state lands in a ledger with " +
            "nothing to set it against.",
        });
      }
    }

    if (value.isReverseCharge && !value.rcmSection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rcmSection"],
        message:
          "Say which provision puts this on reverse charge — 9(3), 9(4) or 5(3) of " +
          "the IGST Act. A self-invoice under Rule 46(p) has to cite it, and the " +
          "tax is payable in cash rather than out of the credit ledger.",
      });
    }

    /**
     * ⚠️ A BILL OF SUPPLY CARRIES NO TAX AND SO NO CREDIT. A composition
     * dealer and an exempt supplier both issue one. Tax typed against it
     * is credit claimed on tax nobody paid — Section 17(5)(e).
     */
    if (value.isBillOfSupply) {
      const hasTax = value.lines.some(
        (line) =>
          line.cgst !== "0" || line.sgst !== "0" || line.igst !== "0" || line.cess !== "0",
      );
      if (hasTax) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["isBillOfSupply"],
          message:
            "A bill of supply carries no GST, so no credit can arise from it. If " +
            "the document shows tax it is a tax invoice; if it does not, remove the " +
            "tax from the lines.",
        });
      }
    }

    /**
     * ⭐ THE CHEAPEST PLACE TO CATCH THE MOST EXPENSIVE MISTAKE.
     *
     * A line booked to `own_account_construction` will be blocked by the
     * engine and refused by the database if anybody tries to claim it.
     * Saying so HERE, on the form, while the person still has the bill in
     * front of them, is what turns a silent capitalisation into a
     * conversation about which building the cement went to.
     */
    value.lines.forEach((line, index) => {
      if (
        line.itcPurpose === "own_account_construction" &&
        line.isCapitalGoods === false &&
        line.expenditureNature === "capital_goods"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", index, "isCapitalGoods"],
          message:
            "Goods of a capital nature going into our own building are capitalised " +
            "with their blocked GST. Mark the line as capital goods so the cost " +
            "carries the tax.",
        });
      }
    });
  });

export const determineItcSchema = z.object({
  itcPurpose: itcPurposeSchema,
  expenditureNature: expenditureNatureSchema,
  outwardRateAllowsItc: z.boolean().optional(),
  vehicleUsedForTaxableOnwardSupply: z.boolean().optional(),
  statutoryObligationToEmployees: z.boolean().optional(),
  usedForSameCategoryOutwardSupply: z.boolean().optional(),
  supplierIsComposition: z.boolean().optional(),
  supplierIsNonResident: z.boolean().optional(),
  goodsLostStolenDestroyedOrGifted: z.boolean().optional(),
  hasValidTaxInvoice: z.boolean().optional(),
});

export const setInvoiceStatusSchema = z.object({
  id: uuid,
  status: z.enum(["draft", "recorded", "approved", "paid", "cancelled"]),
  reason: z.string().trim().max(1000).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* THE ITC REGISTER                                                    */
/* ------------------------------------------------------------------ */

/**
 * Post the credits for a tax period into the register.
 *
 * ⚠️ THE PERIOD IS AN EXPLICIT INPUT, NEVER `new Date()`. A credit is
 * claimed in the return for a period, and the return for July is filed in
 * August. Reading the clock would post July's credits into August's
 * register whenever somebody ran it a day late — which is every month.
 */
export const buildItcPeriodSchema = z.object({
  taxPeriod: taxPeriodSchema,
  registrationId: uuid.optional().nullable(),
});

export const recordItcMovementSchema = z.object({
  taxPeriod: taxPeriodSchema,
  registrationId: uuid.optional().nullable(),
  purchaseInvoiceId: uuid.optional().nullable(),
  purchaseInvoiceLineId: uuid.optional().nullable(),
  vendorId: uuid.optional().nullable(),
  projectId: uuid.optional().nullable(),
  status: itcRegisterStatusSchema,
  reason: itcMovementReasonSchema,
  statutoryRef: z.string().trim().max(24).optional().nullable(),
  note: z.string().trim().max(2000).optional().nullable(),
  cgst: nonNegativeMoney.default("0"),
  sgst: nonNegativeMoney.default("0"),
  igst: nonNegativeMoney.default("0"),
  cess: nonNegativeMoney.default("0"),
});

/**
 * ⭐ Run Rule 42 for a period.
 *
 * ⚠️ THE TURNOVER FIGURES ARE INPUTS, NOT DERIVED FROM `invoices`.
 *
 * The Explanation to Rule 42 pulls into "exempt turnover" things that are
 * not invoices at all: the value of land sold, and the value of completed
 * buildings sold — a sale after the completion certificate is neither a
 * supply of goods nor of services (Schedule III para 5) and therefore
 * raises no tax invoice. Deriving E and F from the invoice table would
 * silently omit exactly the largest exempt figure a developer has, which
 * understates the reversal and overstates the credit.
 */
export const runRule42Schema = z.object({
  taxPeriod: taxPeriodSchema,
  registrationId: uuid.optional().nullable(),
  exemptTurnover: nonNegativeMoney,
  totalTurnover: nonNegativeMoney,
  /** Rule 42(1)(l) fixes this at 5%. Overridable only for a what-if. */
  deemedNonBusinessRateBps: z.number().int().min(0).max(10_000).optional(),
});

/* ------------------------------------------------------------------ */
/* THE VENDOR LEDGER                                                   */
/* ------------------------------------------------------------------ */

export const addVendorLedgerEntrySchema = z
  .object({
    vendorId: uuid,
    entryDate: civilDaySchema,
    entryType: vendorLedgerEntryTypeSchema,
    purchaseInvoiceId: uuid.optional().nullable(),
    referenceNumber: z.string().trim().max(80).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
    debit: nonNegativeMoney.default("0"),
    credit: nonNegativeMoney.default("0"),
    dueDate: civilDaySchema.optional().nullable(),
    excludeFromAgeing: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const debit = Number(value.debit);
    const credit = Number(value.credit);
    /**
     * ⚠️ EXACTLY ONE SIDE. An entry carrying both is a net figure worked
     * out by hand, and the working is gone. The gross movements are what
     * a vendor reconciles their own ledger against; a net is what starts
     * the argument.
     */
    if ((debit > 0) === (credit > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["debit"],
        message:
          "An entry is either a debit or a credit, never both and never neither. " +
          "A bill credits the account (we owe more); a payment debits it.",
      });
    }
  });

export const vendorAgeingQuerySchema = z.object({
  vendorId: uuid.optional().nullable(),
  asOf: civilDaySchema,
});

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type UpsertVendorInput = z.infer<typeof upsertVendorSchema>;
export type RecordPurchaseInvoiceInput = z.infer<typeof recordPurchaseInvoiceSchema>;
export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;
export type DetermineItcInput = z.infer<typeof determineItcSchema>;
export type RecordItcMovementInput = z.infer<typeof recordItcMovementSchema>;
export type RunRule42Input = z.infer<typeof runRule42Schema>;
export type AddVendorLedgerEntryInput = z.infer<typeof addVendorLedgerEntrySchema>;
