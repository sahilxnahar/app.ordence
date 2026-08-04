/**
 * Ordence — Contract & Document Validation Schemas
 * Version: v0.7.0-alpha
 *
 * Extracted from `server/actions/documents.ts` because a `"use server"` file
 * may only export async functions — see the header of
 * `lib/validators/accounting.ts` for the full reasoning.
 */

import { z } from "zod";

const uuidSchema = z.string().uuid("Invalid identifier.");

export const partySchema = z.object({
  role: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(300),
  entityType: z.string().trim().max(100).optional(),
  address: z.string().trim().max(500).optional(),
  signatoryName: z.string().trim().max(200).optional(),
  signatoryDesignation: z.string().trim().max(150).optional(),
});

export const sectionSchema = z.object({
  id: z.string().trim().min(1).max(60),
  heading: z.string().trim().min(1).max(300),
  body: z.string().max(50_000),
  clauseId: uuidSchema.optional(),
  order: z.number().int().min(0).max(999),
});

export const CONTRACT_TYPES = [
  "sale_agreement",
  "lease_agreement",
  "construction_contract",
  "consultancy_agreement",
  "nda",
  "msa",
  "sow",
  "purchase_order",
  "joint_development",
  "loan_agreement",
  "employment",
  "vendor_agreement",
  "other",
] as const;

export const createContractSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(400),
  contractNumber: z.string().trim().max(120).optional(),
  contractType: z.enum(CONTRACT_TYPES).default("other"),
  assetId: uuidSchema.optional().nullable(),
  contactId: uuidSchema.optional().nullable(),
  companyId: uuidSchema.optional().nullable(),
  dealId: uuidSchema.optional().nullable(),
  value: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "Enter a valid amount.")
    .optional()
    .nullable(),
  currency: z.string().length(3).default("INR"),
  effectiveDate: z.string().date().optional().nullable(),
  expiryDate: z.string().date().optional().nullable(),
  governingLaw: z.string().trim().max(150).default("India"),
  jurisdiction: z.string().trim().max(150).optional(),
  parties: z.array(partySchema).max(10).default([]),
  sections: z.array(sectionSchema).max(200).default([]),
  /** Clause library ids to append, in order. */
  clauseIds: z.array(uuidSchema).max(100).default([]),
});

export const assembleDocumentSchema = z.object({
  contractId: uuidSchema,
  mergeSourceType: z.enum(["asset", "contact", "company"]).optional(),
  mergeSourceId: uuidSchema.optional(),
  /** Extra merge values supplied by the caller. */
  additionalFields: z
    .record(z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]))
    .default({}),
  /** Enqueue rendering after assembly. */
  generateDocument: z.boolean().default(true),
  watermark: z.string().trim().max(60).optional(),
});

export type CreateContractInput = z.input<typeof createContractSchema>;
export type AssembleDocumentInput = z.input<typeof assembleDocumentSchema>;
