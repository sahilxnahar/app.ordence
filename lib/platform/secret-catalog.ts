/**
 * Ordence — ⭐⭐⭐ EVERY SETTING THIS PRODUCT READS, ASSEMBLED NOT TYPED
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE NAMES ARE IMPORTED. THERE IS NO HAND-TYPED LIST IN THIS FILE.
 * ══════════════════════════════════════════════════════════════════════
 * Three existing lists already answer "what does Ordence read", each for
 * its own reason:
 *
 *   • `BOOT_REQUIRED`  (lib/env-boot.ts)      — absence refuses the boot
 *   • `BOOT_ADVISORY`  (lib/env-boot.ts)      — absence changes the
 *                                               security posture, and
 *                                               each entry already
 *                                               carries the CONSEQUENCE
 *                                               sentence this board shows
 *   • `ENV_CATEGORIES` (lib/platform/env-catalog.ts) — the diagnostic's
 *                                               category table, moved out
 *                                               of `app/api/diag/route.ts`
 *
 * ⚠️ A FOURTH LIST WOULD BE THE DEFECT, NOT THE FEATURE. Migration 0091
 * exists because two reserved-slug lists in this repository were kept in
 * sync by discipline and drifted by eight names in each direction before
 * anybody noticed. A rotation board that quietly omits a key is a key
 * nobody ever rotates. So the union below is computed, and
 * `tests/ui/secret-rotation-board.test.ts` asserts set equality against
 * the three sources — the two can never disagree without going red.
 *
 * ⚠️ SERVER SIDE ONLY IN PRACTICE, because `lib/env-boot.ts` is
 * `server-only`. The client half of the board imports
 * `lib/platform/secret-board.ts` instead, which is pure.
 *
 * 🔴 THIS FILE READS ENVIRONMENT VALUES AND KEEPS NONE OF THEM. See
 * `isPresent()` — the string is compared and dropped inside one
 * expression. Nothing downstream is handed the value, its length, or any
 * function of it.
 */

import { BOOT_ADVISORY, BOOT_REQUIRED } from "@/lib/env-boot";
import { ENV_CATEGORIES } from "@/lib/platform/env-catalog";
import {
  bandForDays,
  wholeDaysBetween,
  type SecretBootRole,
  type SecretBoardRow,
} from "@/lib/platform/secret-board";

/** One catalogued name, before anything about the live process is known. */
export type CatalogEntry = {
  readonly name: string;
  readonly category: string;
  readonly categoryDescription: string;
  readonly bootRole: SecretBootRole;
  readonly consequence: string | null;
};

const UNCATEGORISED = "Uncategorised";
const UNCATEGORISED_NOTE =
  "Named in the boot assertion but in none of the diagnostic's categories.";

/**
 * ⭐ THE UNION, BUILT ONCE AT MODULE LOAD.
 *
 * Order follows `ENV_CATEGORIES` so the board reads like the diagnostic
 * an operator may already have open, and anything named only by the boot
 * assertion is appended rather than dropped.
 *
 * ⚠️ DE-DUPLICATED BY NAME. `ENV_CATEGORIES` lists "Object Storage (R2)"
 * twice — a real duplicate, left in place there so this refactor could
 * not change what `/api/diag` answers. First mention wins here; a name
 * appearing twice on a rotation board is a second row somebody will
 * rotate against and a first row that then looks overdue forever.
 */
export const SECRET_CATALOG: readonly CatalogEntry[] = buildCatalog();

function buildCatalog(): readonly CatalogEntry[] {
  const consequenceByName = new Map<string, string>(
    BOOT_ADVISORY.map((a) => [a.name, a.consequence]),
  );
  const required = new Set<string>(BOOT_REQUIRED);

  const out: CatalogEntry[] = [];
  const seen = new Set<string>();

  const push = (name: string, category: string, description: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const consequence = consequenceByName.get(name) ?? null;
    // ⚠️ REQUIRED WINS OVER ADVISORY when a name is on both lists. It is
    // the harsher and truer statement: the process will not start.
    const bootRole: SecretBootRole = required.has(name)
      ? "required"
      : consequence !== null
        ? "advisory"
        : "optional";
    out.push({ name, category, categoryDescription: description, bootRole, consequence });
  };

  for (const cat of ENV_CATEGORIES) {
    for (const name of cat.required) push(name, cat.name, cat.description);
    for (const name of cat.optional) push(name, cat.name, cat.description);
  }
  // Anything the boot assertion knows about that no category mentions.
  // Today this is empty; the day somebody adds a required name without
  // touching the diagnostic, it stops being empty instead of vanishing.
  for (const name of BOOT_REQUIRED) push(name, UNCATEGORISED, UNCATEGORISED_NOTE);
  for (const advisory of BOOT_ADVISORY) push(advisory.name, UNCATEGORISED, UNCATEGORISED_NOTE);

  return Object.freeze(out);
}

/** Every catalogued name, for validating what a form asks to record. */
export const SECRET_NAMES: readonly string[] = SECRET_CATALOG.map((e) => e.name);

export function isCataloguedSecret(name: string): boolean {
  return SECRET_CATALOG.some((e) => e.name === name);
}

/** A rotation as the action register recorded it. Never a value. */
export type RecordedRotation = {
  /** ISO instant the rotation is stated to have happened. */
  readonly at: string;
  /** The platform staff email that recorded it. */
  readonly by: string | null;
  /** The written reason. Mandatory at write time; may be absent in old rows. */
  readonly reason: string | null;
};

export type BuildSecretBoardInput = {
  /**
   * 🔴 THE PROCESS ENVIRONMENT, PASSED IN RATHER THAN READ HERE, so a
   * test can hand this function an environment where every secret is a
   * known sentinel string and then assert that no sentinel — and no
   * function of its length — appears anywhere in the output. That test is
   * the enforcement of the rule at the top of `secret-board.ts`; a
   * function that read `process.env` directly could not be subjected to
   * it.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** What the action register knows, keyed by secret name. */
  readonly rotations: Readonly<Record<string, RecordedRotation | undefined>>;
  readonly now: Date;
};

/**
 * ⚠️ PRESENCE IS THE SAME QUESTION `/api/diag` AND `lib/env-boot.ts` ASK:
 * is this set to a non-empty string. Not "is it well-formed", not "how
 * long is it". The value enters this expression and leaves as a boolean.
 */
function isPresent(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * ⭐ THE VIEW MODEL. Pure: same inputs, same rows, no clock of its own
 * and no environment of its own.
 */
export function buildSecretBoard(input: BuildSecretBoardInput): SecretBoardRow[] {
  return SECRET_CATALOG.map((entry) => {
    const rotation = input.rotations[entry.name];
    const rotatedAt = rotation ? new Date(rotation.at) : null;
    // ⚠️ An unparseable stored date is treated as NOTHING RECORDED, not
    // as day zero. NaN would sort to the top of a "worst first" board and
    // send somebody to rotate a key on the strength of a corrupt row.
    const usable = rotatedAt !== null && Number.isFinite(rotatedAt.getTime()) ? rotatedAt : null;
    const days = usable === null ? null : wholeDaysBetween(usable, input.now);

    return {
      name: entry.name,
      category: entry.category,
      categoryDescription: entry.categoryDescription,
      bootRole: entry.bootRole,
      present: isPresent(input.env, entry.name),
      consequence: entry.consequence,
      lastRotatedAt: usable === null ? null : usable.toISOString(),
      daysSinceRotation: days,
      bandKey: bandForDays(days).key,
      rotatedBy: usable === null ? null : (rotation?.by ?? null),
      rotationReason: usable === null ? null : (rotation?.reason ?? null),
    };
  });
}
