/**
 * Ordence — Sales Validation Schemas
 * Version: v0.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVER ACTIONS
 * ══════════════════════════════════════════════════════════════════════
 * A file marked `"use server"` may ONLY export async functions. Every
 * other export in such a file is compiled into a callable RPC endpoint
 * reachable by anyone on the internet.
 *
 * This is not theoretical: six Zod schemas were found exported from
 * `"use server"` files in Phase 7 and had to be moved here. Schemas are
 * pure values — both the server action and the client form import the
 * same ones, which is also the only way to stop a form accepting input
 * the action will reject.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

const uuid = z.string().uuid("Not a valid identifier.");

/**
 * ⚠️ A decimal STRING, never a number.
 *
 * `JSON.parse("87456330.55")` is a float, and a float that has been
 * through JSON is not the number that was typed. Money crosses the wire
 * as a string and becomes bigint paise on arrival — the rule set in
 * Phase 11 and unchanged since.
 */
const moneyString = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,2})?$/, 'Use a plain amount like "4500000" or "4500000.50".');

const optionalMoney = moneyString.optional().nullable();

/**
 * Indian mobile numbers, generously.
 *
 * ⚠️ Deliberately permissive. A validator strict enough to be "correct"
 * rejects the landline a builder has used for twenty years, the number
 * with a country code, and the one with spaces in it — and the rep
 * responds by typing it into the notes field, where nothing can dial it.
 */
const phone = z
  .string()
  .trim()
  .min(6, "That is too short to be a phone number.")
  .max(32)
  .regex(/^[+()\d\s-]+$/, "A phone number should contain only digits and + ( ) -");

const email = z.string().trim().toLowerCase().email("That is not a valid email address.");

/** IANA timezone, e.g. "America/New_York". Checked against the runtime. */
const timezone = z
  .string()
  .trim()
  .max(64)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Not a timezone this system recognises." },
  );

/* ------------------------------------------------------------------ */
/* PROJECTS                                                            */
/* ------------------------------------------------------------------ */

export const createProjectSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "A project needs a short code.")
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, "Letters, digits, spaces, hyphens and underscores."),
  name: z.string().trim().min(1, "A project needs a name.").max(255),
  description: z.string().trim().max(4000).optional().nullable(),
  addressLine: z.string().trim().max(500).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  /**
   * ⚠️ Not `.min(1)`. Advertising without a RERA number is an offence,
   * but a project is created long before it is registered — refusing to
   * record one until the certificate arrives would mean the whole
   * pre-launch pipeline lives in a spreadsheet.
   */
  reraNumber: z.string().trim().max(60).optional().nullable(),
  startedAt: z.coerce.date().optional().nullable(),
  expectedCompletionAt: z.coerce.date().optional().nullable(),
});

export const updateProjectSchema = createProjectSchema.partial().extend({ id: uuid });

/* ------------------------------------------------------------------ */
/* UNITS                                                               */
/* ------------------------------------------------------------------ */

export const createUnitSchema = z.object({
  projectId: uuid,
  code: z.string().trim().min(1, "A unit needs a number, e.g. A-1203.").max(60),
  tower: z.string().trim().max(60).optional().nullable(),
  floor: z.number().int().min(-10).max(200).optional().nullable(),
  typology: z.string().trim().max(60).optional().nullable(),
  /** RERA requires carpet area to be the basis of sale. */
  carpetAreaSqft: z.number().int().positive().max(1_000_000).optional().nullable(),
  builtUpAreaSqft: z.number().int().positive().max(1_000_000).optional().nullable(),
  facing: z.string().trim().max(20).optional().nullable(),
  price: optionalMoney,
  customFields: z.record(z.unknown()).optional(),
});

export const updateUnitSchema = createUnitSchema.partial().extend({ id: uuid });

/**
 * ⚠️ Refuses a built-up area smaller than the carpet area.
 *
 * Physically impossible, and it is the shape of typo — two numbers in
 * adjacent fields — that gets caught by nobody and then prices a flat.
 */
export const unitAreaCoherent = (input: {
  carpetAreaSqft?: number | null;
  builtUpAreaSqft?: number | null;
}): string | null => {
  const { carpetAreaSqft: carpet, builtUpAreaSqft: built } = input;
  if (carpet == null || built == null) return null;
  if (built < carpet) {
    return "The built-up area cannot be smaller than the carpet area. Check the two figures.";
  }
  return null;
};

export const holdUnitSchema = z.object({
  unitId: uuid,
  leadId: uuid,
  /** Clamped against tenant policy server-side; this is the outer bound. */
  days: z.number().int().min(1).max(365).optional(),
  tokenAmount: optionalMoney,
  note: z.string().trim().max(1000).optional().nullable(),
});

export const releaseHoldSchema = z.object({
  unitId: uuid,
  reason: z.string().trim().max(500).optional().nullable(),
});

export const setUnitStatusSchema = z.object({
  unitId: uuid,
  status: z.enum(["available", "blocked"]),
  /**
   * ⚠️ Blocking requires a reason; unblocking does not.
   *
   * A blocked unit is inventory nobody can sell, and six months later
   * the only question anybody asks is "why is this one blocked?".
   */
  reason: z.string().trim().max(500).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* LEADS                                                               */
/* ------------------------------------------------------------------ */

export const createLeadSchema = z.object({
  name: z.string().trim().min(1, "A lead needs a name.").max(255),
  email: email.optional().nullable(),
  phone: phone.optional().nullable(),
  preferredLang: z.string().trim().max(8).optional().nullable(),
  source: z
    .enum(["website", "referral", "walk_in", "campaign", "portal", "nri_desk", "broker", "other"])
    .default("website"),
  temperature: z.enum(["hot", "warm", "cold"]).default("warm"),
  budgetMin: optionalMoney,
  budgetMax: optionalMoney,
  requirement: z.string().trim().max(4000).optional().nullable(),
  projectId: uuid.optional().nullable(),
  ownerId: uuid.optional().nullable(),
  isNri: z.boolean().default(false),
  country: z.string().trim().length(2).toUpperCase().optional().nullable(),
  timezone: timezone.optional().nullable(),
  locality: z.string().trim().max(160).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  /** DPDP evidence. See `lib/sales/pipeline.ts` on why it is not required. */
  consentSource: z.string().trim().max(120).optional().nullable(),
  channelPartnerId: uuid.optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
});

/**
 * ⚠️ A lead with neither a phone nor an email cannot be contacted, which
 * makes it a row rather than a lead. Checked as a refinement so the
 * message names both fields instead of blaming one.
 */
export const createLeadRefined = createLeadSchema.refine(
  (input) => Boolean(input.email?.trim() || input.phone?.trim()),
  {
    message: "Add a phone number or an email address — a lead you cannot reach is not a lead.",
    path: ["phone"],
  },
);

export const updateLeadSchema = createLeadSchema.partial().extend({ id: uuid });

export const transitionLeadSchema = z.object({
  id: uuid,
  status: z.enum([
    "new",
    "contacted",
    "qualified",
    "site_visit",
    "negotiation",
    "booked",
    "won",
    "lost",
  ]),
  /** Required by the database when moving to `lost`. */
  lostReason: z.string().trim().max(2000).optional().nullable(),
  nextFollowUpAt: z.coerce.date().optional().nullable(),
});

export const logActivitySchema = z.object({
  leadId: uuid,
  type: z.enum([
    "call",
    "email",
    "whatsapp",
    "meeting",
    "site_visit",
    "note",
    "status_change",
    "assignment",
  ]),
  subject: z.string().trim().max(255).optional().nullable(),
  notes: z.string().trim().max(8000).optional().nullable(),
  outcome: z.string().trim().max(160).optional().nullable(),
  scheduledAt: z.coerce.date().optional().nullable(),
  occurredAt: z.coerce.date().optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* CHANNEL PARTNERS                                                    */
/* ------------------------------------------------------------------ */

export const createChannelPartnerSchema = z.object({
  code: z.string().trim().min(1).max(40),
  firmName: z.string().trim().min(1, "The firm's name is required.").max(255),
  contactName: z.string().trim().min(1, "A contact person is required.").max(255),
  phone,
  email: email.optional().nullable(),
  reraNumber: z.string().trim().max(60).optional().nullable(),
  /**
   * ⚠️ Shape-checked, matching the database CHECK constraint exactly. A
   * mismatched PAN is rejected by the bank at payout time, months after
   * anybody remembers typing it.
   */
  panNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "A PAN looks like ABCDE1234F.")
    .optional()
    .nullable(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
      "That is not a valid GSTIN.",
    )
    .optional()
    .nullable(),
  commissionBasis: z
    .enum(["percent_of_sale", "months_of_rent", "flat_fee"])
    .default("percent_of_sale"),
  /** Basis points. 200 = 2%. */
  commissionRateBps: z.number().int().min(0).max(10_000).default(200),
  /** Months × 100. 150 = 1.5 months. */
  commissionMonthsCentis: z.number().int().min(0).max(120_00).optional().nullable(),
  commissionFlat: optionalMoney,
  notes: z.string().trim().max(4000).optional().nullable(),
});

export const updateChannelPartnerSchema = createChannelPartnerSchema
  .partial()
  .extend({ id: uuid });

export const setPartnerStatusSchema = z.object({
  id: uuid,
  status: z.enum(["pending", "active", "suspended", "terminated"]),
  reason: z.string().trim().max(1000).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* BOOKINGS                                                            */
/* ------------------------------------------------------------------ */

export const createBookingSchema = z.object({
  leadId: uuid,
  unitId: uuid,
  agreementValue: moneyString,
  salesRepId: uuid.optional().nullable(),
  channelPartnerId: uuid.optional().nullable(),
  /** Optionally generate the payment plan in the same transaction. */
  planTemplateKey: z.string().trim().max(60).optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
});

export const advanceBookingSchema = z.object({
  id: uuid,
  status: z.enum(["tentative", "confirmed", "agreement", "registered"]),
});

/**
 * ⚠️ A cancellation REQUIRES a reason, and the two money fields are
 * separate on purpose.
 *
 * What is kept and what is returned are negotiated separately, both hit
 * the ledger separately, and a single "refund" figure loses the
 * distinction that the buyer's lawyer will ask about first.
 */
export const cancelBookingSchema = z.object({
  id: uuid,
  reason: z
    .string()
    .trim()
    .min(1, "Say why this booking is being cancelled. It frees a unit and moves money.")
    .max(2000),
  forfeitAmount: optionalMoney,
  refundAmount: optionalMoney,
});

/* ------------------------------------------------------------------ */
/* PAYMENT PLANS                                                       */
/* ------------------------------------------------------------------ */

export const planStageSchema = z.object({
  label: z.string().trim().min(1, "Name what triggers this payment.").max(255),
  shareBps: z.number().int().positive().max(10_000),
});

export const generatePlanSchema = z.object({
  bookingId: uuid,
  templateKey: z.string().trim().max(60).optional().nullable(),
  /** A bespoke plan. Must sum to exactly 10000 bps. */
  stages: z.array(planStageSchema).max(40).optional(),
  /** Optional dates, one per stage, in the same order. */
  dueDates: z.array(z.coerce.date().nullable()).max(40).optional(),
});

export const recordMilestonePaymentSchema = z.object({
  milestoneId: uuid,
  amount: moneyString,
  paidAt: z.coerce.date().optional().nullable(),
  reference: z.string().trim().max(160).optional().nullable(),
});

/* ------------------------------------------------------------------ */
/* SAVED VIEWS — the customisability the user asked for                */
/* ------------------------------------------------------------------ */

/**
 * The pipeline board and the inventory grid are both filtered lists, and
 * every company wants a different default. Rather than shipping our
 * opinion, the filter is a value a user can name and save.
 *
 * ⚠️ `sortBy` is an ENUM, not a free string. A saved view is stored and
 * replayed, so an arbitrary column name here would be an ORDER BY
 * injection with a nice UI on top.
 */
export const leadFilterSchema = z.object({
  status: z
    .array(
      z.enum([
        "new",
        "contacted",
        "qualified",
        "site_visit",
        "negotiation",
        "booked",
        "won",
        "lost",
      ]),
    )
    .max(8)
    .optional(),
  source: z.array(z.string().trim().max(20)).max(8).optional(),
  temperature: z.array(z.enum(["hot", "warm", "cold"])).max(3).optional(),
  ownerId: uuid.optional().nullable(),
  projectId: uuid.optional().nullable(),
  channelPartnerId: uuid.optional().nullable(),
  isNri: z.boolean().optional(),
  overdueOnly: z.boolean().optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  search: z.string().trim().max(120).optional(),
  sortBy: z
    .enum(["created_at", "updated_at", "score", "next_follow_up_at", "name"])
    .default("updated_at"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const unitFilterSchema = z.object({
  projectId: uuid.optional().nullable(),
  status: z.array(z.enum(["available", "held", "booked", "sold", "blocked"])).max(5).optional(),
  tower: z.string().trim().max(60).optional(),
  typology: z.string().trim().max(60).optional(),
  facing: z.string().trim().max(20).optional(),
  minPrice: optionalMoney,
  maxPrice: optionalMoney,
  sortBy: z.enum(["code", "price_minor", "floor", "status"]).default("code"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export const saveViewSchema = z.object({
  name: z.string().trim().min(1, "Give the view a name.").max(80),
  scope: z.enum(["leads", "units", "bookings"]),
  /** Validated against the matching filter schema before storing. */
  filter: z.record(z.unknown()),
  isShared: z.boolean().default(false),
});

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type HoldUnitInput = z.infer<typeof holdUnitSchema>;
export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type TransitionLeadInput = z.infer<typeof transitionLeadSchema>;
export type LogActivityInput = z.infer<typeof logActivitySchema>;
export type CreateChannelPartnerInput = z.infer<typeof createChannelPartnerSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;
export type GeneratePlanInput = z.infer<typeof generatePlanSchema>;
export type LeadFilter = z.infer<typeof leadFilterSchema>;
export type UnitFilter = z.infer<typeof unitFilterSchema>;
