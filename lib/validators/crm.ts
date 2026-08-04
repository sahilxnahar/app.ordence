/**
 * Ordence — CRM Validation Schemas
 * Version: v0.2.0-alpha
 *
 * WHY THIS FILE EXISTS:
 * A file marked `"use server"` may ONLY export async functions — Next.js turns
 * every export into a callable server endpoint, so exporting a plain object
 * (a Zod schema) is a build error. Schemas, types and pure helpers therefore
 * live here, outside the server-action boundary.
 *
 * Bonus: client components can import these schemas for form validation without
 * dragging the server actions (and their database imports) into the bundle.
 */

import { z } from "zod";
import type { CustomFieldDefinition, CustomFieldType } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* SHARED                                                              */
/* ------------------------------------------------------------------ */

export const uuidSchema = z.string().uuid("Invalid identifier.");

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers and hyphens.");

/** Result envelope returned by every server action. */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/* ------------------------------------------------------------------ */
/* CONTACTS                                                            */
/* ------------------------------------------------------------------ */

const contactBaseSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(100),
  lastName: z.string().trim().max(100).optional().nullable(),
  email: z
    .union([z.string().trim().email("Enter a valid email address.").max(320), z.literal("")])
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  phone: z.string().trim().max(40).optional().nullable(),
  mobile: z.string().trim().max(40).optional().nullable(),
  jobTitle: z.string().trim().max(150).optional().nullable(),
  department: z.string().trim().max(120).optional().nullable(),
  linkedinUrl: z
    .union([z.string().trim().url("Enter a valid URL.").max(512), z.literal("")])
    .optional()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  companyId: uuidSchema.optional().nullable(),
  notes: z.string().trim().max(10_000).optional().nullable(),
  customFields: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
});

export const createContactSchema = contactBaseSchema;
export const updateContactSchema = contactBaseSchema.partial().extend({ id: uuidSchema });

export const listContactsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  companyId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z
    .enum(["firstName", "lastName", "email", "createdAt", "updatedAt"])
    .default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateContactInput = z.input<typeof createContactSchema>;
export type UpdateContactInput = z.input<typeof updateContactSchema>;
export type ListContactsInput = z.input<typeof listContactsSchema>;

/* ------------------------------------------------------------------ */
/* CUSTOM OBJECTS                                                      */
/* ------------------------------------------------------------------ */

/** Field names become JSONB keys — restrict to a safe identifier shape. */
export const fieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use lowercase letters, numbers and underscores; start with a letter.",
  );

export const selectOptionSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(120),
  color: z.string().trim().max(20).optional(),
});

export const fieldDefinitionSchema = z.object({
  fieldName: fieldNameSchema,
  label: z.string().trim().min(1).max(150),
  fieldType: z.enum([
    "text", "textarea", "number", "currency", "date", "datetime",
    "select", "multiselect", "boolean", "email", "phone", "url",
  ]),
  isRequired: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  showInGrid: z.boolean().default(true),
  helpText: z.string().trim().max(500).optional(),
  placeholder: z.string().trim().max(200).optional(),
  options: z.array(selectOptionSchema).default([]),
  validation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(1).optional(),
      pattern: z.string().max(200).optional(),
      currencyCode: z.string().length(3).optional(),
      precision: z.number().int().min(0).max(6).optional(),
    })
    .default({}),
  defaultValue: z.string().max(500).optional(),
  sortOrder: z.number().int().default(0),
});

export const defineCustomObjectSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(100),
    pluralName: z.string().trim().min(1).max(100).optional(),
    slug: slugSchema.optional(),
    icon: z.string().trim().max(60).default("box"),
    color: z.string().trim().max(20).default("#B08D3C"),
    description: z.string().trim().max(1000).optional(),
    industryTemplate: z.string().trim().max(60).optional(),
    fields: z.array(fieldDefinitionSchema).min(1, "Define at least one field.").max(100),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    val.fields.forEach((f, i) => {
      // Duplicate field names would collide as JSONB keys.
      if (seen.has(f.fieldName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "fieldName"],
          message: `Duplicate field name "${f.fieldName}".`,
        });
      }
      seen.add(f.fieldName);

      // select/multiselect are meaningless without choices.
      if ((f.fieldType === "select" || f.fieldType === "multiselect") && f.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "options"],
          message: `"${f.label}" is a ${f.fieldType} field and needs at least one option.`,
        });
      }
    });
  });

export const createCustomRecordSchema = z.object({
  definitionId: uuidSchema,
  data: z.record(z.unknown()),
  relatedCompanyId: uuidSchema.optional().nullable(),
  relatedContactId: uuidSchema.optional().nullable(),
  relatedDealId: uuidSchema.optional().nullable(),
});

export const listCustomRecordsSchema = z.object({
  definitionId: uuidSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
});

export type DefineCustomObjectInput = z.input<typeof defineCustomObjectSchema>;
export type CreateCustomRecordInput = z.input<typeof createCustomRecordSchema>;
export type ListCustomRecordsInput = z.input<typeof listCustomRecordsSchema>;

/* ------------------------------------------------------------------ */
/* DYNAMIC JSONB VALIDATION                                            */
/* ------------------------------------------------------------------ */

export type ValidationOutcome =
  | { ok: true; cleaned: Record<string, unknown> }
  | { ok: false; fieldErrors: Record<string, string[]> };

/**
 * Validate a JSONB payload against its field definitions.
 *
 * Unknown keys are REJECTED, not ignored. Silently dropping them hides bugs;
 * silently storing them lets a caller write arbitrary data into our rows.
 */
export function validateRecordData(
  raw: Record<string, unknown>,
  fields: CustomFieldDefinition[],
): ValidationOutcome {
  const errors: Record<string, string[]> = {};
  const cleaned: Record<string, unknown> = {};
  const known = new Set(fields.map((f) => f.fieldName));

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      errors[key] = [`Unknown field "${key}".`];
    }
  }

  for (const field of fields) {
    const value = raw[field.fieldName];
    const isEmpty = value === undefined || value === null || value === "";

    if (isEmpty) {
      if (field.isRequired) {
        errors[field.fieldName] = [`${field.label} is required.`];
      } else {
        cleaned[field.fieldName] = null;
      }
      continue;
    }

    const result = coerceFieldValue(value, field);
    if (result.error) {
      errors[field.fieldName] = [result.error];
    } else {
      cleaned[field.fieldName] = result.value;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, cleaned };
}

function coerceFieldValue(
  value: unknown,
  field: CustomFieldDefinition,
): { value?: unknown; error?: string } {
  const v = field.validation ?? {};
  const type = field.fieldType as CustomFieldType;

  switch (type) {
    case "text":
    case "textarea": {
      const s = String(value);
      if (v.minLength != null && s.length < v.minLength)
        return { error: `${field.label} must be at least ${v.minLength} characters.` };
      if (v.maxLength != null && s.length > v.maxLength)
        return { error: `${field.label} must be at most ${v.maxLength} characters.` };
      if (v.pattern) {
        try {
          if (!new RegExp(v.pattern).test(s))
            return { error: `${field.label} is not in the expected format.` };
        } catch {
          /* An invalid stored pattern must not break the write path. */
        }
      }
      return { value: s };
    }

    case "number":
    case "currency": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number.` };
      if (v.min != null && n < v.min) return { error: `${field.label} must be at least ${v.min}.` };
      if (v.max != null && n > v.max) return { error: `${field.label} must be at most ${v.max}.` };
      const precision = v.precision ?? (type === "currency" ? 2 : undefined);
      return { value: precision != null ? Number(n.toFixed(precision)) : n };
    }

    case "boolean":
      if (typeof value === "boolean") return { value };
      if (value === "true" || value === "1") return { value: true };
      if (value === "false" || value === "0") return { value: false };
      return { error: `${field.label} must be true or false.` };

    case "date":
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return { error: `${field.label} must be a valid date.` };
      return { value: type === "date" ? d.toISOString().slice(0, 10) : d.toISOString() };
    }

    case "select": {
      const s = String(value);
      const allowed = field.options.map((o) => o.value);
      if (!allowed.includes(s))
        return { error: `${field.label} must be one of: ${allowed.join(", ")}.` };
      return { value: s };
    }

    case "multiselect": {
      if (!Array.isArray(value)) return { error: `${field.label} must be a list.` };
      const allowed = new Set(field.options.map((o) => o.value));
      const chosen = value.map(String);
      const invalid = chosen.filter((c) => !allowed.has(c));
      if (invalid.length > 0)
        return { error: `${field.label} has invalid options: ${invalid.join(", ")}.` };
      return { value: chosen };
    }

    case "email": {
      const s = String(value).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))
        return { error: `${field.label} must be a valid email address.` };
      return { value: s.toLowerCase() };
    }

    case "url": {
      const s = String(value).trim();
      try {
        const url = new URL(s);
        // Block javascript: and data: — these become stored XSS if rendered as links.
        if (url.protocol !== "http:" && url.protocol !== "https:")
          return { error: `${field.label} must be an http or https URL.` };
        return { value: s };
      } catch {
        return { error: `${field.label} must be a valid URL.` };
      }
    }

    case "phone": {
      const s = String(value).trim();
      if (!/^[+()\-\s\d]{6,30}$/.test(s))
        return { error: `${field.label} must be a valid phone number.` };
      return { value: s };
    }

    default:
      return { value: String(value) };
  }
}

/** Turn a display name into a URL-safe slug. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63) || "object"
  );
}

/** Drop `undefined` keys so a partial update never nulls untouched columns. */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/* ------------------------------------------------------------------ */
/* COMPANIES                                                           */
/* ------------------------------------------------------------------ */

export const COMPANY_SIZES = [
  "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+",
] as const;

/**
 * An empty <input> submits "" — not undefined. Every optional text field
 * therefore has to fold "" back to null, otherwise the database ends up
 * storing empty strings that are neither absent nor meaningful, and
 * `IS NULL` filters quietly stop matching them.
 */
const emptyToNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined ? null : v));

const companyBaseSchema = z.object({
  name: z.string().trim().min(1, "Company name is required.").max(255),
  domain: z
    .union([
      z
        .string()
        .trim()
        .max(253)
        .regex(
          /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i,
          "Enter a bare domain such as ordence.com — no https:// and no path.",
        ),
      z.literal(""),
    ])
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  industry: emptyToNull(120),
  employeeCount: z
    .union([z.coerce.number().int().min(0).max(10_000_000), z.literal("")])
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  companySize: z
    .union([z.enum(COMPANY_SIZES), z.literal("")])
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  website: z
    .union([z.string().trim().url("Enter a valid URL.").max(512), z.literal("")])
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  phone: emptyToNull(40),
  addressLine1: emptyToNull(255),
  addressLine2: emptyToNull(255),
  city: emptyToNull(120),
  state: emptyToNull(120),
  postalCode: emptyToNull(20),
  country: z
    .union([z.string().trim().length(2, "Use the 2-letter country code, e.g. IN."), z.literal("")])
    .optional()
    .nullable()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  notes: emptyToNull(10_000),
  customFields: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
});

export const createCompanySchema = companyBaseSchema;
export const updateCompanySchema = companyBaseSchema.partial().extend({ id: uuidSchema });

export const listCompaniesSchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(["name", "industry", "createdAt", "updatedAt"]).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateCompanyInput = z.input<typeof createCompanySchema>;
export type UpdateCompanyInput = z.input<typeof updateCompanySchema>;
export type ListCompaniesInput = z.input<typeof listCompaniesSchema>;
