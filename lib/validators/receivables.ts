/**
 * Ordence — Receivables Validation Schemas
 * Version: v0.38.0-alpha
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
 * ⚠️ THE SHARED PRIMITIVES ARE IMPORTED, NOT RESTATED. `civilDaySchema`
 * comes from `lib/validators/gst.ts`, the same way `lib/validators/tally.ts`
 * takes it. A second definition of "what a day looks like" that differs
 * by one character is worse than no second definition.
 *
 * ⚠️ MONEY CROSSES THE WIRE AS A STRING OF PAISE, NEVER AS A NUMBER.
 * `JSON.stringify` throws on a `bigint`, and `Number` silently loses
 * precision above 2^53 — which is ₹90,07,19,92,54,740.99, a figure a
 * single luxury project reaches in total value. `paiseSchema` parses to a
 * `bigint` at the boundary so nothing downstream ever holds a float.
 */

import { z } from "zod";
import { civilDaySchema } from "./gst";

const uuid = z.string().uuid("Not a valid identifier.");

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ PAISE, AS A STRING OF DIGITS, PARSED TO `bigint`.
 *
 * ⚠️ REFUSES A DECIMAL POINT DELIBERATELY. "50000.00" is a rupee figure
 * somebody sent by mistake, and accepting it as paise would demand ₹500
 * where ₹50,000 was meant. Refusing at the boundary is the only place
 * that error is still cheap.
 */
export const paiseSchema = z
  .string()
  .trim()
  .regex(/^-?\d+$/, "Amounts are whole paise — no decimal point, no commas.")
  .transform((value) => BigInt(value));

export const positivePaiseSchema = paiseSchema.refine((value) => value > 0n, {
  message: "This amount must be more than zero.",
});

export const nonNegativePaiseSchema = paiseSchema.refine((value) => value >= 0n, {
  message: "This amount cannot be negative.",
});

/**
 * ⚠️ CAPPED AT 100% PER ANNUM, MATCHING THE DATABASE CHECK. A rate above
 * that is a typed extra digit rather than a commercial position.
 *
 * ⚠️ AND IT DOES NOT CAP AT THE RERA REFERENCE RATE. Whether a pre-RERA
 * agreement's 24% survives Section 2(za) is a legal judgement about that
 * agreement; a validator that refused it would stop a developer recording
 * what their own signed contract says. `assessInterestRate` in
 * `lib/receivables/interest.ts` FLAGS it, on the demand and in the
 * register, which is what the developer is actually owed.
 */
export const rateBpsSchema = z
  .number()
  .int("Rates are whole basis points — 1800 is 18%.")
  .min(0, "A rate cannot be negative.")
  .max(10_000, "A rate above 100% per annum is a typing error, not a term.");

export const noticeLanguageSchema = z.enum(["en", "hi", "kn", "ta", "te", "mr"]);

export const interestCompoundingSchema = z.enum([
  "simple",
  "monthly",
  "quarterly",
  "annual",
]);

export const interestDayCountSchema = z.enum([
  "actual_365",
  "actual_360",
  "thirty_360",
]);

export const appropriationOrderSchema = z.enum(["interest_first", "principal_first"]);

export const allocationStrategySchema = z.enum(["oldest_first", "specified", "credit"]);

export const demandTriggerKindSchema = z.enum([
  "construction_event",
  "scheduled_date",
  "booking_event",
  "possession",
  "statutory",
]);

export const dunningStageSchema = z.enum([
  "reminder",
  "first_notice",
  "final_notice",
  "cancellation_warning",
]);

export const dunningChannelSchema = z.enum([
  "email",
  "whatsapp",
  "sms",
  "post",
  "courier",
  "hand_delivery",
  "portal",
]);

export const receiptMethodSchema = z.enum([
  "neft",
  "rtgs",
  "imps",
  "upi",
  "cheque",
  "demand_draft",
  "cash",
  "card",
  "netbanking",
  "home_loan_disbursement",
  "adjustment",
]);

export const gstTaxKindSchema = z.enum(["cgst_sgst", "cgst_utgst", "igst"]);

/* ------------------------------------------------------------------ */
/* POLICIES                                                            */
/* ------------------------------------------------------------------ */

export const upsertReceivablePolicySchema = z.object({
  id: uuid.optional(),
  projectId: uuid.nullable().optional(),
  name: z.string().trim().min(1, "Give this policy a name.").max(160),
  interestRateBps: rateBpsSchema,
  referenceRateBps: rateBpsSchema,
  compounding: interestCompoundingSchema,
  dayCount: interestDayCountSchema,
  graceDays: z.number().int().min(0).max(365),
  graceForgivesElapsedDays: z.boolean().default(false),
  demandDueDays: z.number().int().min(0).max(365),
  gstRateBps: rateBpsSchema,
  appropriationOrder: appropriationOrderSchema,
  defaultAllocationStrategy: z.enum(["oldest_first", "specified"]),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional().nullable(),
});

/**
 * ⚠️ THE STRICT ASCENT IS CHECKED HERE AS WELL AS BY A CHECK CONSTRAINT.
 * A form that lets somebody type 30 into "final notice" and 15 into
 * "cancellation warning" and only fails on save teaches them the rule by
 * losing their work.
 */
export const upsertDunningPolicySchema = z
  .object({
    id: uuid.optional(),
    projectId: uuid.nullable().optional(),
    name: z.string().trim().min(1, "Give this ladder a name.").max(160),
    reminderAfterDays: z.number().int().min(0).max(3650),
    firstNoticeAfterDays: z.number().int().min(0).max(3650),
    finalNoticeAfterDays: z.number().int().min(0).max(3650),
    cancellationWarningAfterDays: z.number().int().min(0).max(3650),
    minGapDays: z.number().int().min(0).max(365),
    preDueReminderDays: z.number().int().min(0).max(90).default(0),
    isActive: z.boolean().default(true),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine(
    (v) =>
      v.reminderAfterDays < v.firstNoticeAfterDays &&
      v.firstNoticeAfterDays < v.finalNoticeAfterDays &&
      v.finalNoticeAfterDays < v.cancellationWarningAfterDays,
    {
      message:
        "Each step must come strictly after the one before it. Otherwise the sweep " +
        "sends two letters on the same morning, which reads to the buyer as a " +
        "machine and to the Authority as a developer who never gave them a chance.",
      path: ["finalNoticeAfterDays"],
    },
  );

/* ------------------------------------------------------------------ */
/* DEMANDS                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE TRIGGER FIELDS ARE REQUIRED, AND THAT IS THE POINT OF THE FORM.
 *
 * A demand under a construction-linked plan derives its force from the
 * event having happened. "The third slab was not cast when you demanded
 * for it" is the buyer's complete answer at the Authority, and a document
 * that does not name the event and the date it was achieved cannot answer
 * it. The refusal belongs here — at the moment somebody can still walk
 * over and ask the site engineer — rather than months later.
 */
export const raiseDemandSchema = z.object({
  bookingId: uuid,
  milestoneId: uuid,
  triggerKind: demandTriggerKindSchema,
  triggerLabel: z
    .string()
    .trim()
    .min(1, "Name the event that fell due — \"on completion of the 3rd slab\".")
    .max(255),
  triggerAchievedOn: civilDaySchema,
  triggerEvidence: z.string().trim().max(2000).optional().nullable(),
  noticeDate: civilDaySchema,
  /** Overrides the policy's due-days. Optional. */
  dueDate: civilDaySchema.optional(),
  /** Charge only part of the milestone. Defaults to the whole balance. */
  principalMinor: positivePaiseSchema.optional(),
  language: noticeLanguageSchema.optional(),
  taxKind: gstTaxKindSchema,
  placeOfSupplyCode: z
    .string()
    .trim()
    .regex(/^\d{2}$/, "A place of supply is a two-digit state code."),
  hsnSacCode: z.string().trim().max(8).optional().nullable(),
  policyId: uuid.optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const issueDemandSchema = z.object({
  demandId: uuid,
  /** Render and store the notice in these languages as it is issued. */
  languages: z.array(noticeLanguageSchema).max(6).optional(),
});

export const cancelDemandSchema = z.object({
  demandId: uuid,
  reason: z
    .string()
    .trim()
    .min(
      5,
      "Say why. A demand that was served and then withdrawn without a recorded " +
        "reason is the hardest thing to explain later.",
    )
    .max(2000),
});

export const supersedeDemandSchema = z.object({
  demandId: uuid,
  replacementDemandId: uuid,
  reason: z.string().trim().min(5).max(2000),
});

export const renderDemandNoticeSchema = z.object({
  demandId: uuid,
  language: noticeLanguageSchema,
  asOf: civilDaySchema.optional(),
});

/* ------------------------------------------------------------------ */
/* RECEIPTS                                                            */
/* ------------------------------------------------------------------ */

export const allocationInstructionSchema = z.object({
  demandId: uuid,
  amountMinor: positivePaiseSchema,
});

/**
 * ⚠️ `tdsCreditMinor` IS PART OF THE RECEIPT AND NOT AN AFTERTHOUGHT.
 * Under Section 194-IA the buyer withholds 1% of the consideration on any
 * property over ₹50 lakh, so what arrives in the bank is 1% short of what
 * settles the demand. A receipt form without this field leaves 1%
 * outstanding on every demand, ages it into the buckets, and starts a
 * chase against a buyer who paid in full and did exactly what the law
 * told them to.
 */
export const recordReceiptSchema = z
  .object({
    bookingId: uuid,
    receivedOn: civilDaySchema,
    amountMinor: positivePaiseSchema,
    tdsCreditMinor: nonNegativePaiseSchema.optional(),
    method: receiptMethodSchema,
    instrumentRef: z.string().trim().max(120).optional().nullable(),
    bankRef: z.string().trim().max(120).optional().nullable(),
    clearedOn: civilDaySchema.optional().nullable(),
    strategy: allocationStrategySchema.default("oldest_first"),
    appropriationOrder: appropriationOrderSchema.optional(),
    instructions: z.array(allocationInstructionSchema).max(200).optional(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine(
    (v) => v.strategy !== "specified" || (v.instructions?.length ?? 0) > 0,
    {
      message:
        "A specifically appropriated receipt has to say which demands it is for. " +
        "Under Section 59 of the Contract Act the buyer's direction binds us, so " +
        "it has to be recorded — or record it as oldest-first instead.",
      path: ["instructions"],
    },
  );

/**
 * ⚠️ A BOUNCE IS NOT A DELETION. The receipt row stays, its allocations
 * are released, and the demands go back to being outstanding from their
 * ORIGINAL due dates — the interest clock never stopped while the cheque
 * was sitting with us.
 */
export const bounceReceiptSchema = z.object({
  receiptId: uuid,
  bouncedOn: civilDaySchema,
  reason: z.string().trim().min(3, "Record what the bank said.").max(500),
});

export const reallocateReceiptSchema = z
  .object({
    receiptId: uuid,
    strategy: allocationStrategySchema,
    appropriationOrder: appropriationOrderSchema.optional(),
    instructions: z.array(allocationInstructionSchema).max(200).optional(),
    reason: z
      .string()
      .trim()
      .min(
        5,
        "Say why the money is being moved. A re-allocation changes what the buyer " +
          "has been told about their own payment.",
      )
      .max(2000),
  })
  .refine((v) => v.strategy !== "specified" || (v.instructions?.length ?? 0) > 0, {
    message: "Name the demands and amounts.",
    path: ["instructions"],
  });

/* ------------------------------------------------------------------ */
/* DUNNING                                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE ESCALATION FORM, AND THE ONE FIELD THAT IS CONDITIONALLY
 * REQUIRED.
 *
 * `authorisedReason` is demanded for a cancellation warning and for
 * nothing else. Everything below that rung can be swept by a scheduled
 * job; the letter that precedes terminating an allotment and forfeiting
 * somebody's money may not be, ever — and "the system sent it
 * automatically" is not an answer anybody can give at a hearing.
 */
export const sendDunningSchema = z
  .object({
    demandId: uuid,
    stage: dunningStageSchema,
    channel: dunningChannelSchema,
    language: noticeLanguageSchema.optional(),
    recipient: z.string().trim().max(320).optional().nullable(),
    sentOn: civilDaySchema.optional(),
    authorisedReason: z.string().trim().max(2000).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .refine(
    (v) =>
      v.stage !== "cancellation_warning" ||
      (v.authorisedReason !== undefined &&
        v.authorisedReason !== null &&
        v.authorisedReason.trim().length >= 10),
    {
      message:
        "⚠️ A cancellation warning needs a named person and a stated reason. This " +
        "is the letter that precedes terminating the allotment and forfeiting what " +
        "the buyer has paid, and it is deliberately outside the automatic sweep.",
      path: ["authorisedReason"],
    },
  );

export const dunningSweepSchema = z.object({
  projectId: uuid.optional(),
  asOf: civilDaySchema.optional(),
  /** Cap the number of letters a single sweep may send. */
  limit: z.number().int().min(1).max(500).default(100),
  /** Report what WOULD be sent without sending it. */
  dryRun: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* REPORTS                                                             */
/* ------------------------------------------------------------------ */

export const ageingQuerySchema = z.object({
  projectId: uuid.optional(),
  bookingId: uuid.optional(),
  asOf: civilDaySchema.optional(),
});

export const statementQuerySchema = z.object({
  bookingId: uuid,
  asOf: civilDaySchema.optional(),
  language: noticeLanguageSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type UpsertReceivablePolicyInput = z.infer<typeof upsertReceivablePolicySchema>;
export type UpsertDunningPolicyInput = z.infer<typeof upsertDunningPolicySchema>;
export type RaiseDemandInput = z.infer<typeof raiseDemandSchema>;
export type IssueDemandInput = z.infer<typeof issueDemandSchema>;
export type RecordReceiptInput = z.infer<typeof recordReceiptSchema>;
export type BounceReceiptInput = z.infer<typeof bounceReceiptSchema>;
export type ReallocateReceiptInput = z.infer<typeof reallocateReceiptSchema>;
export type SendDunningInput = z.infer<typeof sendDunningSchema>;

/**
 * ⭐⭐ RECORDING SERVICE OF A POSTED OR HAND-DELIVERED NOTICE.
 *
 * 🔴 THE REFERENCE IS REQUIRED AND ITS FORMAT IS NOT CHECKED, ON PURPOSE.
 * India Post speed post numbers, RPAD receipts and courier AWBs have
 * three shapes and every courier invents a fourth, so a regex would
 * refuse real evidence. What is refused is an EMPTY one — because
 * "posted" with nothing anybody can look up is a tick box, and a tick box
 * that renders like a verified send is the whole defect being removed.
 *
 * ⚠️ THERE IS NO `channel` FIELD AND NO `dispatched` FIELD. The channel
 * is read from the row that already exists, and dispatch is not a thing
 * this form is allowed to talk about.
 */
export const recordPostalServiceSchema = z.object({
  eventId: z.string().uuid(),
  reference: z
    .string()
    .trim()
    .min(4, "Give the speed post, RPAD or courier reference.")
    .max(120),
  /** Civil day the delivery happened. Defaults to now when omitted. */
  servedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type RecordPostalServiceInput = z.infer<typeof recordPostalServiceSchema>;
export type DunningSweepInput = z.infer<typeof dunningSweepSchema>;
export type AgeingQueryInput = z.infer<typeof ageingQuerySchema>;
export type StatementQueryInput = z.infer<typeof statementQuerySchema>;
