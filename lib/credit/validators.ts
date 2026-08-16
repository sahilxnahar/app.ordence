/**
 * Ordence — Credit control validators (Batch 40)
 * Version: v1.46.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THESE ARE HERE AND NOT IN `lib/validators/credit.ts`
 * ══════════════════════════════════════════════════════════════════════
 * That file owns the v0.89.0 surface — limits, terms, approval ladders,
 * and the `setCreditHoldSchema` that writes 0048's boolean. It is
 * imported by `server/credit/position.ts` and by `server/actions/
 * orders.ts`, both of which are load-bearing for the order path.
 *
 * These are the Batch 40 additions, kept beside the engine they
 * validate. `setCreditHoldSchema` there and `placeCreditHoldSchema` here
 * are NOT duplicates: the old one flips a column, the new one writes an
 * event row, and the two will coexist until every caller of the first
 * has moved. Deleting the old one in the same batch that introduced the
 * refusal would have broken two screens in the deploy that made the
 * product safer, which is how a safety feature gets reverted in week
 * one.
 */

import { z } from "zod";

const uuidSchema = z.string().uuid("That reference is not valid.");

/**
 * ⚠️ FOUR CHARACTERS, AND THE DATABASE SAYS IT AGAIN.
 *
 * Zod is not the boundary. `psql`, a migration script and a support
 * session all reach `credit_hold_events` without passing through this
 * file, which is why 0083 carries the same rule as a CHECK constraint.
 * Two mechanisms for one rule, because this one produces a sentence a
 * salesperson can read and the constraint holds when nothing does.
 */
const holdReasonSchema = z
  .string()
  .trim()
  .min(4, "Say why the account is going on hold. Whoever takes the customer's call will need it.")
  .max(500);

export const placeCreditHoldSchema = z.object({
  companyId: uuidSchema,
  reason: holdReasonSchema,
});

/**
 * ⚠️ LIFTING A HOLD DOES NOT REQUIRE A REASON, AND THE ASYMMETRY IS
 * DELIBERATE — the same argument `lib/validators/credit.ts` makes. A
 * hold stops a customer trading and the person who has to explain it is
 * rarely the person who placed it. Lifting one restores the normal
 * state, which needs no defence.
 *
 * ⭐ THE HOLD ID IS REQUIRED, NOT JUST THE COMPANY. Two people looking at
 * the same stale screen would otherwise both "lift the hold" and the
 * second would silently lift a DIFFERENT hold placed in between — for a
 * different reason, by somebody else, thirty seconds ago.
 */
export const releaseCreditHoldSchema = z.object({
  holdId: uuidSchema,
  reason: z.string().trim().max(500).optional(),
});

/**
 * 🔴 THE OVERRIDE. EIGHT CHARACTERS, NOT FOUR.
 *
 * A hold reason is written by the person imposing a restriction and read
 * by their colleagues. An override reason is written by the person
 * REMOVING one and read back in a bad-debt review by somebody deciding
 * whether it was judgement or negligence. "ok" and "approved" are not
 * answers to that question, and the extra four characters are the
 * cheapest possible way to make somebody type one.
 *
 * ⚠️ THERE IS NO `actorUserId` FIELD AND THERE NEVER WILL BE. The actor
 * is the session. A field naming the actor is a field an attacker fills
 * in with somebody senior, and the record then carries a signature that
 * person never gave — the same rule `approveOrderCreditSchema` states.
 */
export const recordCreditHoldOverrideSchema = z.object({
  orderId: uuidSchema,
  reason: z
    .string()
    .trim()
    .min(
      8,
      "Say why this order goes out even though the account is on hold. It will be read back if the debt goes bad.",
    )
    .max(1000),
});

/**
 * Run the dunning sweep.
 *
 * ⚠️ `asOf` IS ACCEPTED AND BOUNDED RATHER THAN REFUSED. Re-running a
 * missed day is a real operational need — the container was down, the
 * ladder was mis-configured — and the alternative is somebody editing
 * `due_date` to make the sweep fire, which corrupts the invoice to fix
 * the job.
 *
 * 🔴 IT IS BOUNDED TO THE PAST. A future `asOf` would age every invoice
 * forward and fire the whole ladder at once, on a schedule that has not
 * happened. The action clamps it against `todayInIndia()`; this schema
 * only checks the shape.
 */
export const runDunningSweepSchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD form.")
    .optional(),
  ladderId: uuidSchema.optional(),
  /**
   * ⭐ A DRY RUN WRITES NOTHING AND RETURNS THE SAME PLAN. The first
   * time a workspace configures a ladder they are about to write to
   * every overdue customer they have, and being able to look at the list
   * first is the difference between adoption and an incident.
   */
  preview: z.boolean().optional(),
});

export const creditBoardSchema = z.object({
  /** Only customers whose position is worth a second look. Default true. */
  onlyOfInterest: z.boolean().optional(),
});

export type PlaceCreditHoldInput = z.infer<typeof placeCreditHoldSchema>;
export type ReleaseCreditHoldInput = z.infer<typeof releaseCreditHoldSchema>;
export type RecordCreditHoldOverrideInput = z.infer<typeof recordCreditHoldOverrideSchema>;
export type RunDunningSweepInput = z.infer<typeof runDunningSweepSchema>;
