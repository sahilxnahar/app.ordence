/**
 * Ordence — The slug contract, as a Zod schema
 * Version: v1.56.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS A SEPARATE FILE FROM `lib/slug.ts`
 * ══════════════════════════════════════════════════════════════════════
 * `lib/slug.ts` is imported by `lib/tenant.ts`, which is imported by
 * `middleware.ts`, which runs in the Edge Runtime on EVERY request. Zod is
 * Edge-compatible but it is not free, and a validation library has no
 * business in the hot path that decides which tenant a hostname belongs to.
 *
 * So the dependency arrow points ONE WAY: this file imports `lib/slug.ts`,
 * and `lib/slug.ts` imports nothing. That is the whole reason the two files
 * exist separately, and it is why nothing in the Edge bundle may ever import
 * this module.
 *
 * 🔴 DO NOT MERGE THIS BACK INTO `lib/slug.ts`, and do not import it from
 *    `lib/tenant.ts`, `middleware.ts` or anything either of them reaches.
 *    The merge type-checks, ships, and quietly adds zod to every request.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS FILE RE-IMPLEMENTS NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * There is exactly one `.superRefine()` and it delegates to
 * `checkSlugShape()`. No `.min()`, no `.max()`, no `.regex()`, no reserved
 * list — those are precisely the four things that drifted last time, when
 * `lib/tenant.ts` and `server/platform/provisioning.ts` each carried their
 * own copy and disagreed by eight reserved names and one character of
 * minimum length. A zod schema that restates a rule is a third copy waiting
 * to rot. If a message here reads oddly, fix `SLUG_REJECTIONS` in
 * `lib/slug.ts`; both schemas below inherit it.
 *
 * ⚠️ STILL NOT A BOUNDARY. Same as `lib/slug.ts`: this is a mistake guard
 *    that makes the form pleasant. Reserved, taken, too-similar and
 *    recently-released are decided by `0091_slug_authority.sql` at INSERT
 *    time; map the resulting SQLSTATE with `rejectionFromPgError()`.
 */

import { z } from "zod";

import { checkSlugShape } from "@/lib/slug";

/**
 * ⚠️ `.trim().toLowerCase()` BEFORE THE REFINEMENT, AND THE ORDER MATTERS.
 *    `checkSlugShape` trims and lowercases internally to decide, but zod
 *    hands the CALLER whatever value the pipeline produced — so without
 *    these two the schema would accept `" ACME "` and then pass the raw
 *    string with its spaces and capitals to an INSERT that the
 *    `tenants_slug_lowercase` CHECK refuses. Validate and normalise, or the
 *    thing you validated is not the thing you store.
 *
 * ⭐ Public form only: the messages are `publicMessage`, which never names a
 *    conflicting workspace. See the split documented in `lib/slug.ts` — a
 *    signup form that says "too similar to acmecorp" is a free lookup tool
 *    for which near-miss names exist.
 */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((value, ctx) => {
    const rejection = checkSlugShape(value);
    if (!rejection) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: rejection.publicMessage,
      // ⚠️ The machine-readable code rides along in `params` so a caller can
      // branch (offer `suggestSlugs()` on `reserved`, say) without parsing
      // the English sentence it just showed the user.
      params: { slugRejection: rejection.code },
    });
  });

/**
 * The same rules, addressed to Ordence staff.
 *
 * ⚠️ THE ONLY DIFFERENCE IS THE MESSAGE, AND IT MUST STAY THAT WAY. The
 *    console is allowed to say "below the 3-character minimum enforced by
 *    tenants_slug_shape" because the reader is staff with a database to
 *    look at; the public form is not. If the two schemas ever differ in
 *    what they ACCEPT rather than in what they SAY, an operator has been
 *    handed the power to provision a workspace the resolver will not serve
 *    — which is the original incident, rebuilt.
 */
export const operatorSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((value, ctx) => {
    const rejection = checkSlugShape(value);
    if (!rejection) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: rejection.operatorMessage,
      params: { slugRejection: rejection.code },
    });
  });
