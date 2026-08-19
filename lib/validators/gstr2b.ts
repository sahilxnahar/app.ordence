/**
 * Ordence — ⭐ GSTR-2B Validation Schemas
 * Version: v0.34.0-alpha
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
 * ⚠️ THE GST PRIMITIVES ARE IMPORTED, NOT RESTATED. `gstinSchema` and
 * `civilDaySchema` come from `lib/validators/gst.ts`; the tax period
 * shape comes from `lib/validators/purchases.ts`. A second GSTIN rule
 * that disagrees with the first by one character is worse than no second
 * rule — and here it would mean an import accepted against a GSTIN the
 * rest of the product will not recognise.
 */

import { z } from "zod";
import { civilDaySchema, gstinSchema } from "./gst";
import { taxPeriodSchema } from "./purchases";

const uuid = z.string().uuid("Not a valid identifier.");

/* ------------------------------------------------------------------ */
/* ENUM MIRRORS                                                        */
/* ------------------------------------------------------------------ */

export const gstr2bSectionSchema = z.enum([
  "b2b",
  "b2ba",
  "cdnr",
  "cdnra",
  "isd",
  "isda",
  "impg",
  "impgsez",
]);

export const gstr2bSourceFormatSchema = z.enum(["portal_json", "portal_excel", "csv"]);

export const gstr2bMatchCategorySchema = z.enum([
  "exact",
  "probable",
  "number_mismatch",
  "in_2b_not_in_books",
  "in_books_not_in_2b",
  "amended",
  "cancelled",
]);

export const gstr2bMatchActionSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "deferred",
]);

/* ------------------------------------------------------------------ */
/* ⭐ IMPORT                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE FILE ARRIVES AS **TEXT**, NOT AS A PARSED OBJECT.
 *
 * The obvious design is for the client to parse the JSON and post the
 * result. It destroys the evidence: `JSON.parse` followed by
 * `JSON.stringify` reorders nothing but normalises number formatting and
 * drops anything the client's parser did not understand, and the hash
 * then no longer matches the file the portal served. Since the whole
 * point of storing the raw document is to be able to say "this is the
 * file we were given", the bytes cross the boundary unaltered and are
 * parsed once, on the server.
 *
 * ⚠️ AND `content` IS NOT LENGTH-CAPPED HERE. A large developer's 2B
 * runs to several megabytes and a cap chosen for tidiness would refuse a
 * genuine statement at the worst possible moment — the 20th of the month.
 * The real limit is the platform's request body size, which fails with a
 * message about size rather than a message about validation.
 */
export const importGstr2bSchema = z.object({
  /** ⭐ Which of OUR registrations this statement belongs to. */
  registrationId: uuid.optional().nullable(),
  gstin: gstinSchema,
  returnPeriod: taxPeriodSchema,
  sourceFormat: gstr2bSourceFormatSchema,
  fileName: z.string().trim().max(255).optional().nullable(),
  content: z.string().min(1, "The file is empty."),

  /**
   * For a delimited file only, and only where the sheet does not say.
   * ⚠️ Defaulting to `b2b` is safe because that is where a mis-sectioned
   * row does least harm: it is matched normally rather than treated as an
   * amendment that supersedes something.
   */
  defaultSection: gstr2bSectionSchema.optional(),

  /**
   * ⚠️ THE DEFENCE AGAINST A TRANSPOSED DATE. `03-04-2024` is 3 April to
   * the GST portal and 4 March to a spreadsheet saved under a US locale,
   * and no parser can tell. Day-first is the default because it is what
   * the portal emits without exception; this exists so that somebody who
   * KNOWS their file has been through Excel can say so, rather than
   * discovering it as invoices in the wrong tax period.
   */
  dateOrder: z.enum(["day-first", "month-first"]).optional(),
});

export type ImportGstr2bInput = z.infer<typeof importGstr2bSchema>;

/* ------------------------------------------------------------------ */
/* ⭐ RUNNING THE ENGINE                                               */
/* ------------------------------------------------------------------ */

export const runReconciliationSchema = z.object({
  gstin: gstinSchema,
  taxPeriod: taxPeriodSchema,
  registrationId: uuid.optional().nullable(),
  documentId: uuid.optional().nullable(),

  /**
   * ⚠️ THE TOLERANCE IS AN INPUT AND IT IS RECORDED WITH THE RUN.
   *
   * A reconciliation produced under a ₹1 tolerance and one produced under
   * a ₹100 tolerance are different documents, and the difference is
   * invisible on the result. Capped at ₹100 (10,000 paise) because beyond
   * that the tolerance stops absorbing round-off and starts absorbing
   * real differences — at which point the engine is agreeing that two
   * materially different figures describe one invoice, which is a
   * judgement no default should make on somebody's behalf.
   */
  toleranceMinor: z
    .number()
    .int("A tolerance is a whole number of paise.")
    .min(0, "A tolerance cannot be negative.")
    .max(
      10_000,
      "A tolerance above ₹100 stops absorbing round-off and starts absorbing real " +
        "differences. Investigate the mismatch instead of widening the band.",
    )
    .optional(),
});

export type RunReconciliationInput = z.infer<typeof runReconciliationSchema>;

/* ------------------------------------------------------------------ */
/* ⭐ THE WORKBENCH                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `reason` IS REQUIRED FOR EVERYTHING BUT AN ACCEPT, AND THE ASYMMETRY
 * IS THE POINT.
 *
 * Accepting a match says "these are the same document", which the stored
 * `matched_on` evidence already explains field by field. Rejecting or
 * deferring one says "the engine is wrong" or "not this month", and
 * NOTHING in the data explains either. Three months later, "why is this
 * still open" has no answer, and the exception is re-investigated from
 * scratch every month until somebody accepts it to make it go away.
 */
export const decideMatchSchema = z
  .object({
    matchId: uuid,
    action: z.enum(["accepted", "rejected", "deferred"]),
    reason: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "accepted" && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message:
          value.action === "rejected"
            ? "Say why this is not a match. Without a reason the same pair is " +
              "re-investigated from scratch next month."
            : "Say what this is waiting for — usually a supplier who has promised to " +
              "file. A deferral with no reason is indistinguishable from neglect.",
      });
    }
  });

export type DecideMatchInput = z.infer<typeof decideMatchSchema>;

/**
 * ⭐ Bulk actions on the worklist.
 *
 * ⚠️ THE ONE THING THIS SCHEMA REFUSES IS THE ONE THING EVERY USER WILL
 * ASK FOR: bulk-accepting matches below `exact`. It is allowed here ONLY
 * with a reason, because a bulk accept of two hundred `probable` matches
 * with one sentence behind it is at least a decision somebody made and
 * can be shown to have made. What is NOT possible anywhere in the
 * product is an accept with nobody named against it — the database
 * refuses that outright (`gstr2b_matches_no_silent_auto_accept`).
 *
 * ⚠️ AND THE BATCH IS CAPPED AT 500. Not for performance: an
 * "accept all 4,000" button is not a review, and a cap is the only thing
 * that keeps the action a decision rather than a gesture.
 */
export const bulkDecideMatchesSchema = z
  .object({
    matchIds: z
      .array(uuid)
      .min(1, "Select at least one exception.")
      .max(
        500,
        "Accepting more than 500 exceptions in one action is not a review. Filter the " +
          "worklist and work through it.",
      ),
    action: z.enum(["accepted", "rejected", "deferred"]),
    reason: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "accepted" && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Say why. A bulk refusal with no reason explains nothing to anybody.",
      });
    }
  });

export type BulkDecideMatchesInput = z.infer<typeof bulkDecideMatchesSchema>;

export const worklistQuerySchema = z.object({
  gstin: gstinSchema,
  taxPeriod: taxPeriodSchema,
  category: gstr2bMatchCategorySchema.optional(),
  action: gstr2bMatchActionSchema.optional(),
  /**
   * ⚠️ THERE IS DELIBERATELY NO FREE-TEXT `search` FIELD YET. A filter
   * the schema accepts and the query ignores is worse than no filter: the
   * user types a supplier's name, sees the whole list, and concludes the
   * supplier is not there. On a worklist whose purpose is finding the
   * invoice a supplier has not filed, that is the exact wrong conclusion.
   * Add it here and in `listMatches` together, or not at all.
   */
  limit: z.number().int().min(1).max(500).optional(),
});

export type WorklistQueryInput = z.infer<typeof worklistQuerySchema>;

export const chaseQuerySchema = z.object({
  gstin: gstinSchema,
  taxPeriod: taxPeriodSchema,
  /**
   * ⚠️ SUPPLIED, NOT TAKEN FROM THE CLOCK, so the same report re-run in
   * December for a November review shows November's ageing rather than
   * silently re-ageing every invoice to today.
   */
  asOf: civilDaySchema.optional(),
});

export type ChaseQueryInput = z.infer<typeof chaseQuerySchema>;

/* ------------------------------------------------------------------ */
/* ⭐ FILING — THE ONE-WAY DOOR                                        */
/* ------------------------------------------------------------------ */

/**
 * Mark a period filed, and freeze it.
 *
 * ⚠️ `filedReference` IS REQUIRED. It is the GSTR-3B acknowledgement
 * number, and it is what makes the freeze mean something: "this
 * reconciliation supported ARN AA270724XXXXXXX" is a statement that can
 * be checked against the portal. "This reconciliation was frozen on
 * Tuesday" is not.
 *
 * ⚠️ AND THERE IS NO `unfileReconciliationSchema`, ANYWHERE. A return
 * that has been filed cannot be unfiled. A period that turns out to be
 * wrong is corrected in a LATER period — which is how the Government's
 * own ledger behaves, and the only way the books can continue to agree
 * with the returns already submitted.
 */
export const fileReconciliationSchema = z.object({
  gstin: gstinSchema,
  taxPeriod: taxPeriodSchema,
  filedReference: z
    .string()
    .trim()
    .min(1, "Enter the GSTR-3B acknowledgement number (ARN).")
    .max(64),
  /** From the Phase 33 ITC register: what actually went into the return. */
  itcClaimedMinor: z
    .string()
    .trim()
    .regex(/^\d+$/, "An amount in paise, digits only.")
    .optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

export type FileReconciliationInput = z.infer<typeof fileReconciliationSchema>;
