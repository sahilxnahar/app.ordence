/**
 * Ordence , Budget and Cost-Centre Validation Schemas
 * Version: v1.87.0-alpha · Phase 8
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS A MOVE RATHER THAN A NEW RULE
 * ══════════════════════════════════════════════════════════════════════
 * `costCentreInput` was declared at `server/actions/budgets.ts`, unexported,
 * and could not have been exported: that file is `"use server"`, and such a
 * file may only export async functions. A schema left in a server-action
 * file is a rule with exactly one caller, and the second caller writes a
 * second copy.
 *
 * ⚠️ THE SECOND CALLER ARRIVED. The cost-centre importer must validate
 * through the object `createCostCentre` parses, because
 * `lib/import/types.ts` refuses an "import variant" of a schema by name: a
 * bulk path that validated more loosely than the form is a way to create
 * records the form would have refused, a thousand at a time.
 *
 * 🔴 NOTHING ABOUT THE RULES CHANGED IN THE MOVE. The four members, their
 *    bounds and their default are the ones that were there. The only
 *    additions are the two messages, because a `min(1)` with no message
 *    lands in the failed-rows CSV as "String must contain at least 1
 *    character(s)", which is not a sentence a bookkeeper can act on.
 *
 * ⚠️ THE CODE'S REAL RULE IS NOT HERE, AND THAT IS DELIBERATE.
 * `validateCostCentreCode` in `lib/accounting/cost-centre.ts` is the pure
 * function that decides whether a code is usable, and `createCostCentre`
 * calls it AFTER this parse. Restating it here would be the two-copies
 * problem one level down.
 */

import { z } from "zod";

export const costCentreSchema = z.object({
  code: z
    .string({
      /*
       * ⚠️ A BLANK CELL ARRIVES AS `null`, not as "". `lib/import/values.ts`
       * makes that distinction on purpose , absent and empty mean different
       * things to an update , and Zod's default message for a null here is
       * "Expected string, received null", which is what the customer would
       * read in the "what was wrong" column of the CSV they downloaded.
       */
      required_error: "Every cost centre needs a short code, such as PROD or HO.",
      invalid_type_error: "Every cost centre needs a short code, such as PROD or HO.",
    })
    .trim()
    .min(1, "Every cost centre needs a short code, such as PROD or HO.")
    .max(40),
  name: z
    .string({
      required_error: "Every cost centre needs a name.",
      invalid_type_error: "Every cost centre needs a name.",
    })
    .trim()
    .min(1, "Every cost centre needs a name.")
    .max(200),
  description: z.string().trim().max(1_000).optional(),
  displayOrder: z.number().int().min(0).max(100_000).default(100),
});

export type CostCentreInput = z.input<typeof costCentreSchema>;
