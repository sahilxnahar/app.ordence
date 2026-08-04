/**
 * Ordence — Asset Validation & Dynamic Field Specs
 * Version: v0.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE IDEA THIS FILE EXISTS TO SUPPORT
 * ══════════════════════════════════════════════════════════════════════
 * An asset in this system has two halves.
 *
 * The FIXED half — name, type, status, value, address — is the same for a
 * flat in Bengaluru, a lathe on a factory floor and a litigation matter.
 * It is real columns, indexed and sortable.
 *
 * The VARIABLE half lives in `dynamic_attributes` (JSONB) and is described
 * by rows in `custom_field_definitions`. A real-estate developer needs
 * carpet area, floor and facing. A law firm needs court, case number and
 * next hearing date. Neither should require a migration, and neither
 * should force the other to carry columns it will never use.
 *
 * So the form is not written by hand. It is GENERATED from field
 * definitions, and validated against those same definitions on the server.
 * `buildDynamicSchema()` below is the single function that turns
 * definitions into validation, and it is called by both sides. That is why
 * the UI cannot drift from what the server will accept — there is only one
 * source of truth, and it is data, not code.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THERE ARE BUILT-IN DEFAULTS
 * ══════════════════════════════════════════════════════════════════════
 * A brand-new tenant has zero field definitions. Without defaults the
 * "New asset" form would render the fixed half and nothing else, which
 * looks broken. The defaults give every industry a sensible starting set
 * that the tenant can then replace. They are a starting point, not a
 * constraint — once a tenant defines their own fields, theirs win.
 */

import { z } from "zod";
import type { DynamicFieldSpec } from "@/components/forms/form-fields";

/* ------------------------------------------------------------------ */
/* FIXED HALF                                                          */
/* ------------------------------------------------------------------ */

export const ASSET_TYPES = [
  "property", "building", "unit", "plot", "project", "site",
  "vehicle", "machinery", "equipment", "warehouse", "inventory_item",
  "product", "service", "subscription_plan", "license",
  "case", "matter", "contract", "policy",
  "custom",
] as const;

export const ASSET_STATUSES = [
  "draft", "planned", "in_progress", "available", "reserved",
  "under_offer", "occupied", "sold", "leased", "maintenance",
  "inactive", "archived",
] as const;

/** An optional field that arrives from an empty input as "" rather than undefined. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const optionalDecimal = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" || v === undefined ? undefined : v))
  .refine((v) => v === undefined || /^\d{1,15}(\.\d{1,2})?$/.test(v), {
    message: "Enter a valid amount, e.g. 4500000.00",
  });

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" || v === undefined ? undefined : v))
  .refine((v) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: "Enter a valid date.",
  });

export const createAssetSchema = z.object({
  name: z.string().trim().min(1, "Give the asset a name.").max(300),
  assetType: z.enum(ASSET_TYPES),
  assetSubtype: optionalText(100),
  code: optionalText(100),
  description: optionalText(5_000),
  status: z.enum(ASSET_STATUSES).default("draft"),

  valueAmount: optionalDecimal,
  currency: z.string().trim().length(3).default("INR"),

  areaValue: optionalDecimal,
  areaUnit: optionalText(20),

  quantity: z.coerce.number().int().min(0).max(1_000_000).default(1),

  addressLine1: optionalText(255),
  addressLine2: optionalText(255),
  locality: optionalText(150),
  city: optionalText(120),
  state: optionalText(120),
  postalCode: optionalText(20),

  acquiredDate: optionalDate,
  commissionedDate: optionalDate,

  /**
   * The variable half. Validated separately against the tenant's own field
   * definitions — a blanket `z.record(z.unknown())` here would accept
   * anything, so the server narrows it before writing.
   */
  dynamicAttributes: z.record(z.unknown()).default({}),
});

export type CreateAssetInput = z.input<typeof createAssetSchema>;

export const updateAssetSchema = createAssetSchema.partial().extend({
  id: z.string().uuid("Invalid identifier."),
});

export type UpdateAssetInput = z.input<typeof updateAssetSchema>;

/* ------------------------------------------------------------------ */
/* VARIABLE HALF — definitions to validation                           */
/* ------------------------------------------------------------------ */

/**
 * Build a Zod object schema from a tenant's field definitions.
 *
 * Called on the server before any write. The client renders inputs from the
 * same specs, so what the form collects and what the server accepts are
 * derived from one description rather than maintained in parallel.
 *
 * Empty strings are treated as "not provided" throughout — an untouched
 * text input submits `""`, and storing that as a value would make
 * "the user left it blank" indistinguishable from "the user typed nothing
 * on purpose", while also failing every `min` check for optional fields.
 */
export function buildDynamicSchema(specs: DynamicFieldSpec[]) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const spec of specs) {
    const required = spec.isRequired === true;
    const v = spec.validation ?? {};
    let field: z.ZodTypeAny;

    switch (spec.fieldType) {
      case "number":
      case "currency": {
        let n = z.coerce.number({ invalid_type_error: "Enter a number." });
        if (typeof v.min === "number") n = n.min(v.min, `Must be at least ${v.min}.`);
        if (typeof v.max === "number") n = n.max(v.max, `Must be at most ${v.max}.`);
        field = n;
        break;
      }

      case "boolean":
        // A checkbox that is never touched submits nothing at all, so an
        // absent value must mean false rather than "invalid".
        field = z.coerce.boolean().default(false);
        break;

      case "date":
        field = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
        break;

      case "datetime":
        field = z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "Enter a valid date and time.");
        break;

      case "email":
        // Deliberately an allowlist, not a "looks like an email" pattern.
        // A permissive regex once let `<script>@evil.com` through here.
        field = z
          .string()
          .trim()
          .max(320)
          .regex(
            /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/,
            "Enter a valid email address.",
          );
        break;

      case "url":
        field = z
          .string()
          .trim()
          .max(2_000)
          .regex(/^https?:\/\/[^\s<>"']+$/i, "Enter a URL starting with http:// or https://");
        break;

      case "phone":
        field = z
          .string()
          .trim()
          .max(30)
          .regex(/^[+0-9][0-9\s()-]{5,}$/, "Enter a valid phone number.");
        break;

      case "select": {
        const allowed = (spec.options ?? []).map((o) => o.value);
        field =
          allowed.length > 0
            ? z.string().refine((val) => allowed.includes(val), "Choose one of the listed options.")
            : z.string().trim().max(500);
        break;
      }

      case "multiselect": {
        const allowed = (spec.options ?? []).map((o) => o.value);
        const item =
          allowed.length > 0
            ? z.string().refine((val) => allowed.includes(val), "Unrecognised option.")
            : z.string().trim().max(500);
        field = z.array(item).max(100);
        break;
      }

      case "textarea":
        field = z.string().trim().max(v.maxLength ?? 20_000);
        break;

      case "text":
      default: {
        let s = z.string().trim().max(v.maxLength ?? 1_000);
        if (typeof v.minLength === "number") {
          s = s.min(v.minLength, `Must be at least ${v.minLength} characters.`);
        }
        field = s;
        break;
      }
    }

    if (required) {
      // For strings, "required" also has to mean "not empty" — `z.string()`
      // happily accepts "".
      if (
        spec.fieldType !== "boolean" &&
        spec.fieldType !== "number" &&
        spec.fieldType !== "currency" &&
        spec.fieldType !== "multiselect"
      ) {
        field = z
          .string()
          .trim()
          .min(1, `${spec.label} is required.`)
          .pipe(field as z.ZodType<unknown, z.ZodTypeDef, string>);
      }
      shape[spec.fieldName] = field;
    } else {
      shape[spec.fieldName] = z.preprocess(
        (val) => (val === "" || val === null ? undefined : val),
        field.optional(),
      );
    }
  }

  // `.strip()` — anything not described by a definition is discarded rather
  // than written. Without this, a crafted request could stuff arbitrary keys
  // into the JSONB column and they would be rendered back to other users.
  return z.object(shape).strip();
}

/* ------------------------------------------------------------------ */
/* BUILT-IN STARTING SETS                                              */
/* ------------------------------------------------------------------ */

const REAL_ESTATE_FIELDS: DynamicFieldSpec[] = [
  {
    fieldName: "carpetArea",
    label: "Carpet area (sq ft)",
    fieldType: "number",
    isRequired: false,
    helpText: "Usable floor area, excluding walls. RERA requires this to be disclosed.",
    validation: { min: 0, max: 1_000_000 },
  },
  {
    fieldName: "floorNumber",
    label: "Floor",
    fieldType: "number",
    validation: { min: -5, max: 200 },
    helpText: "Use negative numbers for basement levels.",
  },
  {
    fieldName: "facing",
    label: "Facing",
    fieldType: "select",
    options: [
      { label: "North", value: "north" },
      { label: "North-East", value: "north_east" },
      { label: "East", value: "east" },
      { label: "South-East", value: "south_east" },
      { label: "South", value: "south" },
      { label: "South-West", value: "south_west" },
      { label: "West", value: "west" },
      { label: "North-West", value: "north_west" },
    ],
  },
  {
    fieldName: "possessionDate",
    label: "Expected possession",
    fieldType: "date",
    helpText: "The date committed to the buyer, not the internal target.",
  },
  {
    fieldName: "reraRegistered",
    label: "RERA registered",
    fieldType: "boolean",
  },
  {
    fieldName: "reraNumber",
    label: "RERA registration number",
    fieldType: "text",
    placeholder: "PRM/KA/RERA/1251/446/PR/000000/000000",
    validation: { maxLength: 80 },
  },
  {
    fieldName: "notes",
    label: "Internal notes",
    fieldType: "textarea",
    helpText: "Not shown to buyers.",
  },
];

const LEGAL_FIELDS: DynamicFieldSpec[] = [
  {
    fieldName: "caseNumber",
    label: "Case number",
    fieldType: "text",
    isRequired: true,
    placeholder: "O.S. 1234/2026",
    validation: { maxLength: 80 },
  },
  {
    fieldName: "court",
    label: "Court",
    fieldType: "select",
    options: [
      { label: "Supreme Court of India", value: "supreme_court" },
      { label: "High Court", value: "high_court" },
      { label: "District Court", value: "district_court" },
      { label: "Tribunal", value: "tribunal" },
      { label: "Arbitration", value: "arbitration" },
    ],
  },
  {
    fieldName: "nextHearing",
    label: "Next hearing",
    fieldType: "date",
  },
  {
    fieldName: "claimValue",
    label: "Claim value",
    fieldType: "currency",
    validation: { min: 0, currencyCode: "INR" },
  },
  {
    fieldName: "opposingCounsel",
    label: "Opposing counsel",
    fieldType: "text",
    validation: { maxLength: 200 },
  },
  {
    fieldName: "urgent",
    label: "Flag as urgent",
    fieldType: "boolean",
  },
  {
    fieldName: "summary",
    label: "Matter summary",
    fieldType: "textarea",
  },
];

const GENERIC_FIELDS: DynamicFieldSpec[] = [
  {
    fieldName: "serialNumber",
    label: "Serial number",
    fieldType: "text",
    validation: { maxLength: 120 },
  },
  {
    fieldName: "purchaseCost",
    label: "Purchase cost",
    fieldType: "currency",
    validation: { min: 0, currencyCode: "INR" },
  },
  {
    fieldName: "warrantyExpiry",
    label: "Warranty expiry",
    fieldType: "date",
  },
  {
    fieldName: "condition",
    label: "Condition",
    fieldType: "select",
    options: [
      { label: "New", value: "new" },
      { label: "Good", value: "good" },
      { label: "Fair", value: "fair" },
      { label: "Needs repair", value: "needs_repair" },
    ],
  },
  {
    fieldName: "underAmc",
    label: "Under AMC",
    fieldType: "boolean",
    helpText: "Annual maintenance contract in force.",
  },
  {
    fieldName: "notes",
    label: "Notes",
    fieldType: "textarea",
  },
];

/**
 * The starting field set for an industry, used only when the tenant has not
 * defined their own. Every set here spans at least four distinct input types
 * so a new tenant sees a genuinely useful form on day one.
 */
export function defaultFieldsForIndustry(industry: string): DynamicFieldSpec[] {
  switch (industry) {
    case "real_estate_developer":
      return REAL_ESTATE_FIELDS;
    case "legal_advocate":
      return LEGAL_FIELDS;
    default:
      return GENERIC_FIELDS;
  }
}
