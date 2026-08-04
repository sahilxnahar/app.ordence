/**
 * Ordence — Billing Validation Schemas & Plan Catalogue
 * Version: v0.11.0-alpha
 *
 * Lives here, not in `server/actions/billing.ts`, because a file marked
 * `"use server"` may only export async functions — every other export
 * becomes a publicly callable RPC endpoint and fails the build. This was
 * learned the hard way in Phase 7, where six Zod schemas had to be
 * extracted after a build failure.
 *
 * Isomorphic on purpose: the pricing page, the upgrade dialog and the
 * server action all validate against exactly these rules.
 */

import { z } from "zod";
import { isValidGstin, GST_STATE_CODES } from "@/lib/billing/money";
import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

const uuidSchema = z.string().uuid("Invalid identifier.");

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, "That is not a valid GSTIN. Check the 15 characters.");

export const stateCodeSchema = z
  .string()
  .trim()
  .refine((v) => v in GST_STATE_CODES, "Select a valid Indian state.");

/* ------------------------------------------------------------------ */
/* THE PLAN CATALOGUE                                                  */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * PRICES ARE IN PAISE, AS INTEGERS, IN SOURCE CONTROL
 * ══════════════════════════════════════════════════════════════════════
 * `499900` is ₹4,999.00. Writing `4999.00` here and multiplying by 100
 * at seed time would reintroduce a float into the one place where the
 * canonical price is defined.
 *
 * This catalogue is SEED DATA, not the runtime source of truth. Once
 * seeded, `plans` rows are what the system reads — so changing a price
 * here does not silently reprice existing customers (their price is
 * copied onto the subscription at purchase; see the schema note).
 *
 * ══════════════════════════════════════════════════════════════════════
 * A NOTE ON THESE NUMBERS
 * ══════════════════════════════════════════════════════════════════════
 * They are placeholders that are internally consistent — the tier ladder,
 * the seat counts and the quotas all line up, and the annual plans are
 * priced at ten months for twelve, which is the usual convention. They
 * are NOT market research. Pricing a B2B CRM in India depends on who you
 * are selling to and what they currently pay, and neither of us knows
 * that yet. Change these before you charge anyone; the schema does not
 * care what the numbers are.
 */
export const PLAN_CATALOGUE = [
  {
    code: "trial",
    name: "Trial",
    description: "Fourteen days, every Basic feature, no card required.",
    tier: "trial" as PlanTier,
    interval: "monthly" as const,
    currency: "INR",
    amountMinor: "0",
    includedSeats: 3,
    perSeatAmountMinor: "0",
    storageLimitMb: 256,
    emailsPerMonth: 100,
    apiCallsPerMonth: 1_000,
    trialDays: 14,
    isPublic: false,
    sortOrder: 0,
    highlights: ["3 users", "256 MB storage", "14 days"],
  },
  {
    code: "basic_monthly_inr",
    name: "Basic",
    description: "Contacts, companies, deals and documents for a small team.",
    tier: "basic" as PlanTier,
    interval: "monthly" as const,
    currency: "INR",
    amountMinor: "199900", // ₹1,999.00
    includedSeats: 5,
    perSeatAmountMinor: "39900", // ₹399.00
    storageLimitMb: 5_120,
    emailsPerMonth: 1_000,
    apiCallsPerMonth: 25_000,
    trialDays: 14,
    isPublic: true,
    sortOrder: 10,
    highlights: [
      "5 users included",
      "5 GB storage",
      "Contacts, companies & deals",
      "Client portal",
    ],
  },
  {
    code: "advanced_monthly_inr",
    name: "Advanced",
    description: "Adds trust accounting, contract lifecycle and analytics.",
    tier: "advanced" as PlanTier,
    interval: "monthly" as const,
    currency: "INR",
    amountMinor: "499900", // ₹4,999.00
    includedSeats: 15,
    perSeatAmountMinor: "34900", // ₹349.00
    storageLimitMb: 51_200,
    emailsPerMonth: 10_000,
    apiCallsPerMonth: 250_000,
    trialDays: 14,
    isPublic: true,
    sortOrder: 20,
    highlights: [
      "15 users included",
      "50 GB storage",
      "Double-entry trust accounting",
      "Contract lifecycle & e-signature",
      "Executive dashboards",
    ],
  },
  {
    code: "advanced_annual_inr",
    name: "Advanced (annual)",
    description: "Advanced, billed yearly. Two months free.",
    tier: "advanced" as PlanTier,
    interval: "annual" as const,
    currency: "INR",
    amountMinor: "4999000", // ₹49,990.00 — ten months for twelve
    includedSeats: 15,
    perSeatAmountMinor: "349000",
    storageLimitMb: 51_200,
    emailsPerMonth: 10_000,
    apiCallsPerMonth: 250_000,
    trialDays: 14,
    isPublic: true,
    sortOrder: 25,
    highlights: ["Everything in Advanced", "Two months free", "Annual invoice"],
  },
  {
    code: "enterprise_annual_inr",
    name: "Enterprise",
    description: "Custom terms, SSO, data residency and a named contact.",
    tier: "enterprise" as PlanTier,
    interval: "annual" as const,
    currency: "INR",
    amountMinor: "24999000", // ₹2,49,990.00
    includedSeats: 100,
    perSeatAmountMinor: "199000",
    storageLimitMb: 512_000,
    emailsPerMonth: 100_000,
    apiCallsPerMonth: 5_000_000,
    trialDays: 30,
    isPublic: false, // Sold, not self-served.
    sortOrder: 40,
    highlights: [
      "100 users included",
      "500 GB storage",
      "Custom contract & invoicing",
      "Priority support",
    ],
  },
] as const;

export type PlanCatalogueEntry = (typeof PLAN_CATALOGUE)[number];
export type PlanCode = PlanCatalogueEntry["code"];

export const PLAN_CODES = PLAN_CATALOGUE.map((p) => p.code) as readonly PlanCode[];

/**
 * Tier ordering, for deciding whether a plan change is an upgrade or a
 * downgrade. Phase 14 prices those differently — an upgrade charges the
 * proration immediately, a downgrade takes effect at period end — so the
 * comparison has to be explicit rather than alphabetical.
 */
export const TIER_RANK: Readonly<Record<PlanTier, number>> = Object.freeze({
  trial: 0,
  basic: 1,
  advanced: 2,
  ai: 3,
  enterprise: 4,
});

export function isUpgrade(from: PlanTier, to: PlanTier): boolean {
  return TIER_RANK[to] > TIER_RANK[from];
}

/* ------------------------------------------------------------------ */
/* GST                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Our own registration state. GST on a SaaS subscription is intra-state
 * (CGST + SGST) when the customer is in the same state as the supplier,
 * inter-state (IGST) otherwise.
 *
 * Read from the environment rather than hard-coded, because it is a fact
 * about the BUSINESS, not about the software — and getting it wrong
 * misclassifies every invoice you issue. Defaults to Karnataka (29)
 * because that is where Ordence is registered; override with
 * `PLATFORM_GST_STATE_CODE` if that changes.
 */
export const DEFAULT_SUPPLIER_STATE_CODE = "29";

/** Standard GST rate for SaaS in India: 18%, as basis points. */
export const SAAS_GST_RATE_BPS = 1800;

/** SAC code for hosted software services. Appears on every invoice. */
export const SAAS_SAC_CODE = "998314";

/* ------------------------------------------------------------------ */
/* BILLING PROFILE                                                     */
/* ------------------------------------------------------------------ */

/**
 * The tax identity captured before a customer's first invoice.
 *
 * GSTIN is OPTIONAL — an unregistered small business or an individual
 * legitimately has none, and demanding one would block a sale. When it is
 * absent the place of supply must still be supplied, because it decides
 * IGST versus CGST/SGST regardless of registration.
 */
export const billingProfileSchema = z
  .object({
    legalName: z
      .string()
      .trim()
      .min(2, "Enter the registered legal name.")
      .max(255),
    gstin: gstinSchema.optional().or(z.literal("")),
    placeOfSupplyCode: stateCodeSchema,
    addressLine1: z.string().trim().min(1, "Address is required.").max(255),
    addressLine2: z.string().trim().max(255).optional().or(z.literal("")),
    city: z.string().trim().min(1, "City is required.").max(120),
    state: z.string().trim().min(1, "State is required.").max(120),
    postalCode: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]{5}$/, "Enter a valid 6-digit PIN code."),
    country: z.string().trim().length(2).default("IN"),
    billingEmail: z.string().trim().email("Enter a valid email address.").max(320),
  })
  .superRefine((value, ctx) => {
    /**
     * If a GSTIN IS given, its first two digits are the registration
     * state and must agree with the declared place of supply. A mismatch
     * produces an invoice that the customer cannot claim input credit
     * against — they will notice, weeks later, and ask for a revision.
     */
    if (value.gstin && value.gstin.length === 15) {
      const gstinState = value.gstin.slice(0, 2);
      if (gstinState !== value.placeOfSupplyCode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["placeOfSupplyCode"],
          message:
            `The GSTIN is registered in ${GST_STATE_CODES[gstinState] ?? "another state"} ` +
            `(code ${gstinState}) but the place of supply says ${value.placeOfSupplyCode}. ` +
            `These must match.`,
        });
      }
    }
  });

export type BillingProfileInput = z.infer<typeof billingProfileSchema>;

/* ------------------------------------------------------------------ */
/* CHECKOUT & PLAN CHANGES                                             */
/* ------------------------------------------------------------------ */

export const startCheckoutSchema = z.object({
  planId: uuidSchema,
  /**
   * Seats requested. Capped at 500 — beyond that it is an enterprise
   * conversation, not a self-serve checkout, and an unbounded integer
   * here would let someone create a ₹2 crore subscription by typing a
   * long number into a form field.
   */
  seats: z.coerce.number().int().min(1, "At least one seat.").max(500),
  /** Where to return after payment. Validated as a PATH, never a URL. */
  returnPath: z
    .string()
    .trim()
    .regex(
      /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/,
      "Return path must be a relative path.",
    )
    .max(512)
    .default("/settings/billing"),
});

export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;

export const changePlanSchema = z.object({
  planId: uuidSchema,
  seats: z.coerce.number().int().min(1).max(500).optional(),
});

export const cancelSubscriptionSchema = z.object({
  /**
   * `atPeriodEnd` defaults to TRUE. Cancelling should not forfeit time
   * the customer has already paid for, and a default of `false` would
   * make the destructive option the easy one.
   */
  atPeriodEnd: z.boolean().default(true),
  reason: z.string().trim().max(1_000).optional(),
});

/* ------------------------------------------------------------------ */
/* MANUAL / OFFLINE PAYMENTS                                           */
/* ------------------------------------------------------------------ */

/**
 * Recording a NEFT/RTGS settlement by hand.
 *
 * `reference` is required and has a minimum length because "paid" with
 * no bank reference is an assertion, not a record. If the payment is ever
 * questioned, the UTR number is the only thing that resolves it.
 */
export const recordManualPaymentSchema = z.object({
  invoiceId: uuidSchema,
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,13}(\.\d{1,2})?$/, "Enter an amount like 49990.00."),
  /** UTR / cheque number / transaction reference. */
  reference: z
    .string()
    .trim()
    .min(4, "Enter the bank reference (UTR) for this payment.")
    .max(120),
  receivedAt: z.string().date("Enter the date the money arrived."),
  note: z.string().trim().max(1_000).optional(),
});

export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;

/* ------------------------------------------------------------------ */
/* DISPLAY HELPERS                                                     */
/* ------------------------------------------------------------------ */

export const SUBSCRIPTION_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  trialing: "Trial",
  active: "Active",
  past_due: "Payment failed",
  unpaid: "Unpaid",
  paused: "Paused",
  cancelled: "Cancelling",
  expired: "Expired",
});

/**
 * Plain-language explanation of each status, shown to the customer.
 *
 * Written to say what happens NEXT, not just what the state is called.
 * "Payment failed" tells someone nothing about whether they still have
 * access; "we'll retry, nothing changes yet" tells them whether to panic.
 */
export const SUBSCRIPTION_STATUS_HELP: Readonly<Record<string, string>> = Object.freeze({
  trialing: "Your trial is running. No card has been charged.",
  active: "Everything is up to date.",
  past_due:
    "The last payment did not go through. We will try again — nothing has changed about your access yet.",
  unpaid:
    "We were unable to collect payment after several attempts. Update your payment method to restore full access.",
  paused: "Billing is paused. Contact us to resume.",
  cancelled: "Cancelled. You keep full access until the end of the period you have paid for.",
  expired: "This subscription has ended.",
});

export const INVOICE_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: "Draft",
  open: "Due",
  paid: "Paid",
  partially_paid: "Part paid",
  void: "Void",
  uncollectible: "Written off",
  refunded: "Refunded",
});
