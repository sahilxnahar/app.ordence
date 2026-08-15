/**
 * Ordence — Financial Period Validation Schemas
 * Version: v0.7.0-alpha
 *
 * Extracted from `server/actions/periods.ts` because a `"use server"` file
 * may only export async functions — see the header of
 * `lib/validators/accounting.ts` for the full reasoning.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY REOPENING A PERIOD DEMANDS A WRITTEN REASON
 * ══════════════════════════════════════════════════════════════════════
 * Closing a period is a declaration that the numbers are final. Reopening
 * one un-declares it, which is exactly the move someone would make to alter
 * a figure after it was reported. The 15-character minimum is not
 * bureaucracy: it forces a sentence into the audit log that an auditor can
 * later read and judge. "fix" would pass a length-1 check and explain
 * nothing.
 */

import { z } from "zod";

const uuidSchema = z.string().uuid("Invalid identifier.");

export const createPeriodSchema = z
  .object({
    name: z.string().trim().min(1, "Give the period a name.").max(120),
    startDate: z.string().date("Enter a valid start date."),
    endDate: z.string().date("Enter a valid end date."),
    fiscalYear: z.string().trim().max(12).optional(),
    periodNumber: z.number().int().min(1).max(12).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "The end date cannot be before the start date.",
    path: ["endDate"],
  });

export const closePeriodSchema = z.object({
  periodId: uuidSchema,
  closingNotes: z.string().trim().max(2_000).optional(),
  /**
   * Close even though the trial balance does not agree.
   * Requires an explicit acknowledgement — this should almost never be used.
   */
  forceUnbalanced: z.boolean().default(false),
  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 CLOSE EVEN THOUGH DOCUMENTS FROM THIS PERIOD ARE NOT IN THE
   *    LEDGER — v1.27.0-alpha
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ IT NEEDS A WRITTEN REASON AND `forceUnbalanced` DOES NOT, and
   * the asymmetry is deliberate.
   *
   * An unbalanced period is VISIBLE. It shows on every trial balance
   * anybody runs, forever, and somebody will ask. A period sealed over
   * missing entries looks perfect: it balances, because the missing
   * entries are missing from both sides.
   *
   * 🔴 It is also the more destructive of the two. The period lock will
   * refuse those documents from that month permanently, so the override
   * does not defer a problem — it creates one that can only be undone
   * by reopening the month, which is itself a critical audit event.
   *
   * ⭐ So the harder-to-see mistake is the harder one to make.
   */
  strandDocumentsReason: z
    .string()
    .trim()
    .min(
      20,
      "Say why these documents are being left out of the month, in a sentence somebody reading the audit log in a year can understand.",
    )
    .max(2_000)
    .optional(),
});

export const reopenPeriodSchema = z.object({
  periodId: uuidSchema,
  reason: z
    .string()
    .trim()
    .min(15, "Explain why this period is being reopened (15+ characters).")
    .max(2_000),
});

export type CreatePeriodInput = z.input<typeof createPeriodSchema>;
export type ClosePeriodInput = z.input<typeof closePeriodSchema>;
export type ReopenPeriodInput = z.input<typeof reopenPeriodSchema>;
