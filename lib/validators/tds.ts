/**
 * Ordence — TDS Validation Schemas
 * Version: v0.36.0-alpha
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
 * ⚠️ THE SHARED PRIMITIVES ARE IMPORTED, NOT RESTATED. `panSchema` and
 * `civilDaySchema` come from `lib/validators/gst.ts`. A second PAN rule
 * that disagrees with the first by one character is worse than no second
 * rule — and PAN is the identity the whole of this phase is keyed on.
 */

import { z } from "zod";
import { civilDaySchema, panSchema } from "./gst";
import { TDS_SECTION_CODES } from "@/lib/tds/sections";

const uuid = z.string().uuid("Not a valid identifier.");

/**
 * Money crosses the boundary as a STRING and is parsed with `parseMoney`
 * on the far side.
 *
 * ⚠️ `JSON.stringify` THROWS ON A BIGINT, and a `number` would silently
 * lose the last digits above 2^53 paise. A developer's land purchase does
 * not reach ₹90,000 crore, and the one that finally does would round
 * rather than fail — which is the wrong failure for the one figure in the
 * product where 1% of it is being handed to the government.
 */
const moneyString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 125000.00.");

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A TAN, NOT A PAN AND NOT A GSTIN. Four letters, five digits, one
 * letter — RTKA12345B. It is the identity a TDS return is filed under,
 * and it is the field people paste a PAN into because both are ten
 * characters.
 */
export const tanSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z]{4}[0-9]{5}[A-Z]$/,
    "That is not a TAN. A Tax Deduction Account Number is four letters, five " +
      "digits and one letter — RTKA12345B. ⚠️ A PAN is five letters, four digits " +
      "and one letter, and the two are not interchangeable.",
  );

/**
 * ⭐ SEVEN DIGITS, INCLUDING LEADING ZEROS.
 *
 * ⚠️ `0001234` IS NOT `1234`. A BSR code pasted out of a spreadsheet has
 * had its leading zeros stripped by the spreadsheet, and the resulting
 * challan matches nothing in OLTAS — so the return is accepted, the
 * challan is unmatched, and every deductee attached to it gets no credit.
 */
export const bsrCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9]{7}$/,
    "A BSR code is exactly seven digits, INCLUDING any leading zeros. ⚠️ A " +
      "spreadsheet strips them — 0001234 arrives as 1234, and a challan quoted " +
      "with the wrong BSR matches nothing in OLTAS.",
  );

export const challanSerialSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9]{5}$/,
    "A challan serial number is exactly five digits, including leading zeros.",
  );

/** "2024-25". */
export const financialYearSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, "Use a financial year like 2024-25.");

export const tdsQuarterSchema = z.enum(["Q1", "Q2", "Q3", "Q4"]);

export const tdsSectionSchema = z.enum(
  TDS_SECTION_CODES as [string, ...string[]],
) as z.ZodEnum<[string, ...string[]]>;

export const tdsDeducteeTypeSchema = z.enum([
  "individual",
  "huf",
  "company",
  "firm",
  "association_of_persons",
  "body_of_individuals",
  "local_authority",
  "trust",
  "artificial_juridical_person",
  "government",
]);

export const tdsPanStatusSchema = z.enum([
  "valid",
  "not_furnished",
  "invalid",
  "inoperative",
  "applied_for",
]);

export const tdsDeductionOutcomeSchema = z.enum([
  "deducted",
  "below_threshold",
  "nil_certificate",
  "exempt",
]);

export const tdsReturnFormSchema = z.enum(["24Q", "26Q", "27Q", "27EQ"]);

export const tdsCertificateFormSchema = z.enum(["16", "16A", "16B", "27D"]);

/** Basis points. 200 = 2%. Never a float, never a percentage. */
const rateBpsSchema = z
  .number()
  .int("A rate is an integer number of basis points — 200 is 2%.")
  .min(0)
  .max(10_000, "A rate above 100% is not a rate.");

/* ------------------------------------------------------------------ */
/* DEDUCTEES                                                           */
/* ------------------------------------------------------------------ */

export const upsertDeducteeSchema = z
  .object({
    id: uuid.optional(),
    code: z.string().trim().min(1, "A code is required.").max(40),
    legalName: z.string().trim().min(1, "A name is required.").max(255),

    panNumber: panSchema.nullish(),
    panStatus: tdsPanStatusSchema.default("not_furnished"),
    panVerifiedOn: civilDaySchema.nullish(),

    deducteeType: tdsDeducteeTypeSchema.default("company"),
    isNonResident: z.boolean().default(false),

    isSpecifiedPerson206ab: z.boolean().default(false),
    specifiedPersonCheckedOn: civilDaySchema.nullish(),
    specifiedPersonReference: z.string().trim().max(64).nullish(),

    vendorId: uuid.nullish(),
    channelPartnerId: uuid.nullish(),

    email: z.string().trim().email("That is not an email address.").max(320).nullish(),
    phone: z.string().trim().max(32).nullish(),
    notes: z.string().trim().max(4000).nullish(),
  })
  /**
   * ⭐ A `valid` PAN STATUS WITH NO PAN IS THE 20% BUG.
   *
   * `lib/tds/rates.ts` asks `panStatus === "valid"` and would answer "the
   * ordinary rate" for a deductee who has furnished nothing at all. Every
   * payment to them for the year is then short by the difference between
   * 1% and 20%, and Section 201(1) makes us pay it — after the
   * subcontractor has left the site.
   */
  .refine((v) => v.panStatus !== "valid" || !!v.panNumber, {
    path: ["panNumber"],
    message:
      "A PAN status of 'valid' needs a PAN. ⚠️ Without one the rate engine would " +
      "apply the ordinary rate to a deductee who has furnished nothing, and " +
      "Section 206AA requires 20%. The shortfall is recoverable from US, not " +
      "from them.",
  })
  /**
   * ⭐ A 206AB FLAG IS A COPY OF THE DEPARTMENT'S DETERMINATION, AND A
   * COPY WITH NO DATE IS A GUESS. The answer comes from the Compliance
   * Check utility against the PAN on a day; ours goes stale, and a stale
   * "no" on a large vendor is the exposure.
   */
  .refine((v) => !v.isSpecifiedPerson206ab || !!v.specifiedPersonCheckedOn, {
    path: ["specifiedPersonCheckedOn"],
    message:
      "Record the date the Compliance Check utility was run. The determination " +
      "under Section 206AB belongs to the Department, not to us, and an undated " +
      "copy of it cannot be relied on at an assessment.",
  })
  /**
   * ⭐ THE PAN'S FOURTH CHARACTER **IS** THE CONSTITUTION, and disagreeing
   * with it is two errors at once: the quarterly return is rejected
   * wholesale by the File Validation Utility, and — because Section
   * 194C(2) charges 1% to an individual or HUF and 2% to everyone else —
   * every deduction from this vendor has been at the wrong rate.
   */
  .refine(
    (v) => {
      if (!v.panNumber || v.panNumber.length !== 10) return true;
      const expected: Record<string, string> = {
        individual: "P",
        huf: "H",
        company: "C",
        firm: "F",
        association_of_persons: "A",
        body_of_individuals: "B",
        local_authority: "L",
        trust: "T",
        artificial_juridical_person: "J",
        government: "G",
      };
      return v.panNumber[3] === expected[v.deducteeType];
    },
    {
      path: ["deducteeType"],
      message:
        "⭐ The fourth character of the PAN does not match the constitution " +
        "recorded here. That character IS the holder's constitution — P for an " +
        "individual, C for a company, H for a HUF, F for a firm — and the File " +
        "Validation Utility rejects the WHOLE quarterly statement on the " +
        "mismatch. ⚠️ It is also a rate error: Section 194C charges 1% to an " +
        "individual or HUF and 2% to everybody else.",
    },
  );

export type UpsertDeducteeInput = z.infer<typeof upsertDeducteeSchema>;

/* ------------------------------------------------------------------ */
/* ⭐ SECTION 197 CERTIFICATES                                          */
/* ------------------------------------------------------------------ */

export const upsertLowerDeductionCertificateSchema = z
  .object({
    id: uuid.optional(),
    deducteeId: uuid,
    certificateNumber: z
      .string()
      .trim()
      .toUpperCase()
      .min(1, "The certificate number is required.")
      .max(24),
    section: tdsSectionSchema,
    rateBps: rateBpsSchema,
    validFrom: civilDaySchema,
    validTo: civilDaySchema,
    capBaseMinor: moneyString.nullish(),
    financialYear: financialYearSchema,
    isActive: z.boolean().default(true),
    notes: z.string().trim().max(4000).nullish(),
  })
  .refine((v) => v.validTo >= v.validFrom, {
    path: ["validTo"],
    message: "The certificate cannot expire before it takes effect.",
  })
  /**
   * ⭐ A CERTIFICATE CANNOT OUTLIVE ITS FINANCIAL YEAR. Section 197
   * certificates are issued for a year and expire on 31 March at the
   * latest. A window running into the next year is a typo, and it is the
   * typo that keeps a lapsed certificate being applied all summer — every
   * payment short by the difference, with Section 201(1) making the
   * shortfall ours.
   */
  .refine(
    (v) => {
      const startYear = Number(v.financialYear.slice(0, 4));
      return v.validFrom >= `${startYear}-04-01` && v.validTo <= `${startYear + 1}-03-31`;
    },
    {
      path: ["validTo"],
      message:
        "⭐ The window must fall inside the financial year on the certificate " +
        "(1 April to 31 March). A certificate under Section 197 expires on " +
        "31 March at the latest. ⚠️ A window running past it is how a lapsed " +
        "certificate keeps being applied months later — the commonest way one " +
        "turns into a demand.",
    },
  );

export type UpsertLowerDeductionCertificateInput = z.infer<
  typeof upsertLowerDeductionCertificateSchema
>;

/* ------------------------------------------------------------------ */
/* ⭐ THE DEDUCTION                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ask the engine what to deduct. ⚠️ NOT what to record — the caller does
 * not supply a rate, a threshold verdict or a catch-up. Those are
 * computed from the register, because a caller who could supply them
 * could supply the wrong ones and nothing downstream would know.
 */
/**
 * ⭐⭐ A PAYMENT MADE IN A CURRENCY THAT IS NOT THE RUPEE — RULE 26.
 *
 * ⚠️ THE AMOUNT CROSSES AS MINOR UNITS OF ITS OWN CURRENCY, NOT AS
 * "125000.00". `moneyString` above encodes the two-decimal assumption
 * that `lib/fx/currency.ts` exists to destroy: JPY has no minor unit at
 * all and KWD has three, so "1.234" is a valid dinar amount that
 * `moneyString` rejects and "1234" JPY is 1,234 yen and not 12.34.
 * Minor units are exact, exponent-free at the boundary, and are scaled
 * by the currency's own exponent inside `convertMinor`.
 *
 * ⚠️ AND IT CARRIES BOTH DATES RATHER THAN A DEDUCTION DATE. Which of
 * them fixes the deduction is a statutory question — s.195(1)'s
 * "whichever is earlier" — answered by
 * `lib/tds/foreign-payments.ts#deductionDateFor` on the server. A form
 * that posted the answer could post the payment date, which is the
 * commonest wrong one.
 */
export const foreignPaymentSchema = z
  .object({
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "A currency is a three-letter ISO-4217 code, like USD."),
    /** Minor units of `currency`. Digits only. */
    amountMinor: z
      .string()
      .trim()
      .regex(/^\d+$/, "Enter the amount in the currency's own minor units, digits only."),
    /** When the sum was credited to the payee's account in our books. */
    creditDate: civilDaySchema.nullish(),
    /** When the money left the bank. */
    paymentDate: civilDaySchema.nullish(),
  })
  .refine((v) => Boolean(v.creditDate) || Boolean(v.paymentDate), {
    message:
      "Record the date the sum was credited to the payee's account, or the date it was " +
      "paid. s.195(1) charges the deduction on the earlier of the two, and under Rule 26 " +
      "that same date fixes the telegraphic transfer buying rate the payment is measured " +
      "at — so with neither date there is no deduction date and no rate.",
  });

/**
 * ⚠️ THE SHAPE, WITHOUT THE CROSS-FIELD RULE. Both schemas below apply
 * `exactlyOneBase` to it — restating the rule twice is how two forms end
 * up disagreeing about which of them is authoritative.
 */
const deductionInputShape = z.object({
  deducteeId: uuid,
  section: tdsSectionSchema,
  /**
   * ⚠️ EXCLUDING GST. CBDT Circular 23/2017: where the tax is shown
   * separately on the invoice, income-tax TDS is deducted on the value
   * alone. Phase 33 already computed this as
   * `purchase_invoices.tds_base_minor`.
   */
  paymentBaseMinor: moneyString.nullish(),
  /**
   * ⭐⭐ RULE 26. Present INSTEAD OF `paymentBaseMinor` when the payment
   * was made in a currency other than the rupee: the rupee base is then
   * COMPUTED from this at the telegraphic transfer buying rate on the
   * deduction date, and a caller-supplied rupee figure is refused rather
   * than accepted alongside it. A figure somebody typed and a figure the
   * rule produces are two different numbers, and accepting both would
   * mean silently choosing one.
   */
  foreignPayment: foreignPaymentSchema.nullish(),
  /**
   * Date of credit or of payment, WHICHEVER IS EARLIER.
   *
   * ⚠️ ON A FOREIGN-CURRENCY PAYMENT THIS IS CHECKED, NOT TRUSTED. The
   * server derives the date from `foreignPayment`'s two dates and refuses
   * a row where the two disagree — see `server/actions/tds.ts`.
   */
  deductionDate: civilDaySchema,
  purchaseInvoiceId: uuid.nullish(),
  vendorId: uuid.nullish(),
  projectId: uuid.nullish(),
  channelPartnerId: uuid.nullish(),
  referenceNumber: z.string().trim().max(80).nullish(),
  description: z.string().trim().max(4000).nullish(),
});

/**
 * 🔴 EXACTLY ONE BASE. A rupee figure supplied alongside a foreign amount
 * is a second answer to the same question, and the one that would be
 * discarded is the one Rule 26 computes.
 */
const EXACTLY_ONE_BASE = {
  message:
    "Give either a rupee payment base or a foreign-currency payment, and not both. " +
    "Where the payment is in foreign currency the rupee base is not typed — it is the " +
    "amount converted at the telegraphic transfer buying rate on the date the tax is " +
    "required to be deducted, as Rule 26 of the Income-tax Rules 1962 requires.",
} as const;

const exactlyOneBase = (v: {
  paymentBaseMinor?: string | null;
  foreignPayment?: unknown;
}): boolean => Boolean(v.paymentBaseMinor) !== Boolean(v.foreignPayment);

export const assessDeductionSchema = deductionInputShape.refine(
  exactlyOneBase,
  EXACTLY_ONE_BASE,
);

export type AssessDeductionInput = z.infer<typeof assessDeductionSchema>;

/**
 * Write the deduction the engine produced.
 *
 * ⚠️ IT CARRIES NO RATE AND NO AMOUNTS EITHER, for the same reason. The
 * server re-runs the assessment against the register at write time. A
 * form that posted a rate would let a person change one — and a 0.5%
 * deduction under a 2% section, posted from a browser, is
 * indistinguishable in the register from a lawful Section 197 one.
 */
const recordDeductionShape = deductionInputShape.extend({
  /**
   * ⚠️ 192 AND 195 ONLY. The engine refuses to invent those rates, so a
   * person supplies one with their working — and the row records that a
   * person did, via `rate_basis = 'manually_determined'`.
   */
  manualRateBps: rateBpsSchema.nullish(),
  manualRateReason: z.string().trim().max(2000).nullish(),
  surchargeMinor: moneyString.nullish(),
  cessMinor: moneyString.nullish(),
});

export const recordDeductionSchema = recordDeductionShape.refine(
  exactlyOneBase,
  EXACTLY_ONE_BASE,
);

export type RecordDeductionInput = z.infer<typeof recordDeductionSchema>;

/* ------------------------------------------------------------------ */
/* CHALLANS                                                            */
/* ------------------------------------------------------------------ */

export const recordChallanSchema = z.object({
  id: uuid.optional(),
  tan: tanSchema,
  bsrCode: bsrCodeSchema,
  challanSerial: challanSerialSchema,
  depositDate: civilDaySchema,
  financialYear: financialYearSchema,
  quarter: tdsQuarterSchema,
  section: tdsSectionSchema.nullish(),
  taxMinor: moneyString.default("0"),
  surchargeMinor: moneyString.default("0"),
  cessMinor: moneyString.default("0"),
  /** ⭐ Section 201(1A). Deposited with the tax, reported separately. */
  interestMinor: moneyString.default("0"),
  /** ⭐ Section 234E. */
  feeMinor: moneyString.default("0"),
  status: z.enum(["pending", "deposited", "verified", "failed"]).default("deposited"),
  bankReference: z.string().trim().max(64).nullish(),
  notes: z.string().trim().max(4000).nullish(),
});

export type RecordChallanInput = z.infer<typeof recordChallanSchema>;

/**
 * Attach deductions to a challan.
 *
 * ⚠️ THE SERVER REFUSES AN OVER-UTILISATION AND SO DOES THE DATABASE
 * (SQL 0025 §7). Mapping more tax to a challan than was deposited into it
 * produces a return that is ACCEPTED while some deductees silently get no
 * credit — chosen by the order the Department processes records in.
 */
export const mapDeductionsToChallanSchema = z.object({
  challanId: uuid,
  deductionIds: z
    .array(uuid)
    .min(1, "Select at least one deduction.")
    .max(2000, "Map at most 2,000 deductions at a time."),
});

export type MapDeductionsToChallanInput = z.infer<typeof mapDeductionsToChallanSchema>;

/* ------------------------------------------------------------------ */
/* RETURNS AND CERTIFICATES                                            */
/* ------------------------------------------------------------------ */

export const buildReturnSchema = z.object({
  tan: tanSchema,
  formType: tdsReturnFormSchema,
  financialYear: financialYearSchema,
  quarter: tdsQuarterSchema,
});

export type BuildReturnInput = z.infer<typeof buildReturnSchema>;

export const fileReturnSchema = buildReturnSchema.extend({
  returnId: uuid,
  filedOn: civilDaySchema,
  acknowledgementNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "The provisional receipt number is required.")
    .max(20),
});

export type FileReturnInput = z.infer<typeof fileReturnSchema>;

export const buildCertificatesSchema = z.object({
  tan: tanSchema,
  financialYear: financialYearSchema,
  quarter: tdsQuarterSchema,
  deducteeId: uuid.nullish(),
  formType: tdsCertificateFormSchema.default("16A"),
});

export type BuildCertificatesInput = z.infer<typeof buildCertificatesSchema>;

/* ------------------------------------------------------------------ */
/* QUERIES                                                             */
/* ------------------------------------------------------------------ */

export const registerQuerySchema = z.object({
  financialYear: financialYearSchema,
  quarter: tdsQuarterSchema.nullish(),
  deducteeId: uuid.nullish(),
  section: tdsSectionSchema.nullish(),
});

export type RegisterQueryInput = z.infer<typeof registerQuerySchema>;

export const interestExposureQuerySchema = z.object({
  financialYear: financialYearSchema,
  asOf: civilDaySchema,
});

export type InterestExposureQueryInput = z.infer<typeof interestExposureQuerySchema>;

/**
 * ⭐ THE SHORTFALL SWEEP. Who has crossed an annual threshold and not
 * been caught up? Every workspace arrives with a year of history entered
 * by somebody who tested each payment on its own, and this is the query
 * that finds it before an assessment does.
 */
export const thresholdSweepSchema = z.object({
  financialYear: financialYearSchema,
});

export type ThresholdSweepInput = z.infer<typeof thresholdSweepSchema>;
