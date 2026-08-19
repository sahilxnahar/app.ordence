/**
 * Ordence — Credit and Approval Limit Validators
 * Version: v0.89.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ MONEY ARRIVES AS A STRING OF MINOR UNITS, AND SO DOES "NO LIMIT"
 * ══════════════════════════════════════════════════════════════════════
 * `JSON` numbers cannot hold a crore in paise without eventually losing
 * the paise, so amounts cross the wire as digit strings and become
 * `bigint` here, once — the same rule as `lib/validators/orders.ts`.
 *
 * ⭐ AND THE HARD PART IS NULL.
 *
 * A credit limit has THREE meaningful states and a form has to be able
 * to express all three:
 *
 *     "500000"     set the limit to ₹5,000
 *     "0"          set the limit to zero — every order to approval
 *     null         CLEAR the limit — no ceiling at all
 *
 * ⚠️ AN OMITTED FIELD AND AN EXPLICIT `null` ARE NOT THE SAME THING and
 * this file refuses to let them collapse. `.optional()` alone would make
 * "the user cleared the limit" indistinguishable from "the form did not
 * include that field", and the two have opposite meanings: one removes
 * every ceiling on a customer, the other should change nothing.
 *
 * So the update schema is EXPLICIT-FIELD: a key that is absent is left
 * alone, a key present with `null` is cleared. `.nullish()` gives us
 * both, and the action layer distinguishes them with `in` rather than by
 * truthiness — because `0` is falsy and `0` is a real, deliberate limit.
 */

import { z } from "zod";
import { SYSTEM_ROLE_VALUES } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* PRIMITIVES                                                          */
/* ------------------------------------------------------------------ */

/**
 * A non-negative whole amount in paise, as digits.
 *
 * ⚠️ 19 DIGITS IS THE `bigint` COLUMN'S RANGE, NOT AN ARBITRARY CAP. A
 * longer string parses fine in JavaScript and then fails in Postgres
 * with `value out of range`, which reaches the user as a database error
 * instead of a form error.
 */
export const minorAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,19}$/, "Enter a whole amount in paise, digits only.")
  .transform((v) => BigInt(v));

/**
 * ⭐ The limit field. `null` means CLEAR IT.
 *
 * The empty string is accepted and treated as `null`, because that is
 * what an emptied text input actually sends and the alternative is
 * telling somebody who just deleted a number that their input is
 * malformed.
 */
export const creditLimitSchema = z
  .union([z.literal(""), z.null(), minorAmountSchema])
  .transform((v) => (v === "" ? null : v));

const uuidSchema = z.string().uuid("That customer reference is not valid.");

/* ------------------------------------------------------------------ */
/* CREDIT PROFILE                                                      */
/* ------------------------------------------------------------------ */

/**
 * Set or change a customer's credit terms.
 *
 * ⚠️ THE SHAPE IS "PRESENT MEANS CHANGE IT". Every mutable field is
 * `.nullish()` and the action checks presence with `in`, not truthiness.
 * A schema that dropped absent keys would turn a form which edits only
 * the payment terms into one that silently clears the credit limit.
 */
export const setCreditTermsSchema = z.object({
  companyId: uuidSchema,

  /** Present + value = set. Present + null = clear. Absent = unchanged. */
  creditLimitMinor: creditLimitSchema.nullish(),

  /**
   * Net terms in days. 0 is legitimate — cash on delivery — so the floor
   * is 0 and not 1. 3650 is ten years, which is not a payment term; it
   * is a typo with two extra zeroes, and catching it here is cheaper
   * than explaining an ageing report later.
   */
  paymentTermsDays: z.number().int().min(0).max(3650).nullish(),

  /**
   * ⚠️ A NOTE, NOT A REASON CODE. What goes here is read aloud to a
   * customer on the phone six weeks later. A dropdown would be tidier
   * and would lose "agreed with Mr Shah until the Diwali order clears".
   */
  note: z.string().trim().max(500).nullish(),
});

/**
 * ⚠️ PLACING A HOLD REQUIRES A REASON. LIFTING ONE DOES NOT.
 *
 * The asymmetry is deliberate. A hold stops a customer trading, and the
 * person who has to explain it to them is rarely the person who placed
 * it — an unexplained hold becomes a phone call to somebody who does not
 * know the answer. Lifting a hold restores the normal state, which needs
 * no defence.
 */
export const setCreditHoldSchema = z.discriminatedUnion("onHold", [
  z.object({
    companyId: uuidSchema,
    onHold: z.literal(true),
    reason: z
      .string()
      .trim()
      .min(4, "Say why the account is on hold. Whoever takes the customer's call will need it.")
      .max(500),
  }),
  z.object({
    companyId: uuidSchema,
    onHold: z.literal(false),
    reason: z.string().trim().max(500).optional(),
  }),
]);

/** Read one customer's credit position. */
export const creditPositionSchema = z.object({
  companyId: uuidSchema,
});

/* ------------------------------------------------------------------ */
/* APPROVAL LIMITS                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SCOPE LIST IS ENFORCED HERE AND NOWHERE ELSE.
 *
 * The column is `varchar(40)`, deliberately, so a new scope is a row
 * rather than a type migration. That choice puts the whole burden of
 * "is this a real scope" on this schema — a free-text scope means a
 * typo (`sales_orders`) creates a limit that silently matches nothing,
 * and the symptom is an approval ladder that appears configured and
 * grants nobody anything.
 *
 * Adding a scope: add it here, and to the union below. Still no
 * migration.
 */
export const APPROVAL_SCOPES = [
  "sales_order",
  "discount_pct",
  "purchase_order",
  "write_off",
  /**
   * 🔴 BATCH 48 — MONEY LEAVING, NOT MONEY EXTENDED.
   *
   * The four scopes above cap what a role may APPROVE. These two cap
   * what a role may DO: the value of one credit note, and everything one
   * person issues in an Indian civil day. `lib/sales/refund-cap.ts`
   * holds the reasoning and `server/sales/refund-cap.ts` enforces it
   * inside the transaction that writes the note.
   *
   * ⚠️ AND THEY DO NOT INHERIT THIS TABLE'S "NO ROW = NO AUTHORITY"
   * READING. A missing row falls back to a stated default figure, never
   * to zero and never to unlimited — see `DEFAULT_PER_NOTE_CAP_MINOR`.
   */
  "credit_note",
  "credit_note_daily",
] as const;

export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * 🔴 `role` IS THE SystemRole VALUE, NOT A `roles.id`.
 *
 * See the note in `db/schema/credit.ts`: nothing reads the `roles`
 * table, and a limit keyed on it would grant nobody anything while
 * looking configured. The list is imported rather than retyped so a new
 * role cannot be silently unrepresentable here.
 */
export const setApprovalLimitSchema = z.object({
  role: z.enum(SYSTEM_ROLE_VALUES),
  scope: z.enum(APPROVAL_SCOPES),
  /**
   * ⚠️ NULL = UNLIMITED IN THIS SCOPE. Not "may approve nothing".
   * Removing the row entirely is what removes the authority.
   */
  maxValueMinor: creditLimitSchema.nullish(),
});

export const removeApprovalLimitSchema = z.object({
  role: z.enum(SYSTEM_ROLE_VALUES),
  scope: z.enum(APPROVAL_SCOPES),
});

/* ------------------------------------------------------------------ */
/* APPROVING AN ORDER                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ APPROVE AN ORDER THAT CREDIT ROUTED TO A HUMAN.
 *
 * ⚠️ THERE IS NO `approvedBy` FIELD AND THERE NEVER WILL BE. The
 * approver is the session. A field naming the approver is a field an
 * attacker fills in with somebody senior, and the audit trail then
 * carries a signature that person never gave.
 */
export const approveOrderCreditSchema = z.object({
  orderId: uuidSchema,
  /**
   * What the approver is agreeing to, in their own words. Required,
   * because an approval that overrides a credit limit with no sentence
   * attached is indistinguishable from a mis-click when it is read back
   * in a bad-debt review.
   */
  note: z
    .string()
    .trim()
    .min(4, "Say why this is being approved. It will be read back if the debt goes bad.")
    .max(1000),
});

export type SetCreditTermsInput = z.infer<typeof setCreditTermsSchema>;
export type SetCreditHoldInput = z.infer<typeof setCreditHoldSchema>;
export type SetApprovalLimitInput = z.infer<typeof setApprovalLimitSchema>;
export type ApproveOrderCreditInput = z.infer<typeof approveOrderCreditSchema>;
