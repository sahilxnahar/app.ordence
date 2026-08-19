/**
 * Ordence — ⭐⭐⭐ THE ROTATION BOARD'S VOCABULARY (PURE, CLIENT-SAFE)
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONE RULE THIS WHOLE FEATURE EXISTS UNDER
 * ══════════════════════════════════════════════════════════════════════
 * METADATA ONLY. NEVER A VALUE, NEVER A PREFIX, NEVER A SUFFIX, NEVER A
 * MASKED VALUE WITH THE LAST FOUR SHOWING, AND NEVER A CHARACTER COUNT.
 *
 * `/api/diag` used to answer `{ present, length }` for forty-seven names
 * including `CLERK_SECRET_KEY` and `S3_SECRET_ACCESS_KEY`, and its own
 * header defended that by saying it never returns the VALUE of anything.
 * That sentence was true and beside the point. An exact character count
 * is a truncated-paste oracle — it tells you whether the key you pasted
 * is the whole key — and it fingerprints WHICH key format is in use,
 * because issuers have characteristic lengths. It was handed to anybody
 * who asked, unauthenticated.
 *
 * ⚠️ "BUT THIS SCREEN IS OPERATORS ONLY" IS NOT A DEFENCE. The console
 * is one XSS away from being anybody, and the row type below is what an
 * injected script would read. So the number simply is not in it: there
 * is no `length`, no `prefix`, no `masked` field here to leak, and
 * `tests/ui/secret-rotation-board.test.ts` asserts that as a property
 * over the entire serialised model rather than field by field.
 *
 * ⚠️ THIS FILE IS PURE ON PURPOSE. No `server-only`, no `process.env`,
 * no database. `components/platform/secret-rotation-board.tsx` is a
 * `"use client"` file and imports the band helpers straight from here;
 * pulling in `lib/env-boot.ts` (which is `server-only`) would fail
 * `check-server-boundaries`. The catalogue half lives next door in
 * `lib/platform/secret-catalog.ts`, which the server alone imports.
 */

/**
 * ⭐ THE BAND IS A WORD FIRST AND A COLOUR SECOND.
 *
 * Roughly one in twelve Indian men is colour-blind, so an amber pill and
 * a red pill are two grey pills to a meaningful slice of the people this
 * console is built for. The colour is decoration on top of the word; the
 * word is the datum. Every place a band is rendered prints `word`.
 */
export type SecretBandKey = "fresh" | "ageing" | "overdue" | "never-recorded";

export type SecretBand = {
  readonly key: SecretBandKey;
  /** Printed. Always. */
  readonly word: string;
  /** Decoration. Never the only carrier of the meaning. */
  readonly tone: string;
  /** What the word means, in the operator's terms. */
  readonly meaning: string;
};

/** Under this many days since the last recorded rotation: fresh. */
export const FRESH_MAX_DAYS = 90;
/** Under this many: ageing. At or over it: overdue. */
export const AGEING_MAX_DAYS = 180;

export const SECRET_BANDS: Readonly<Record<SecretBandKey, SecretBand>> = Object.freeze({
  fresh: {
    key: "fresh",
    word: "fresh",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    meaning: `rotated within the last ${FRESH_MAX_DAYS} days`,
  },
  ageing: {
    key: "ageing",
    word: "ageing",
    tone: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    meaning: `last rotation is between ${FRESH_MAX_DAYS} and ${AGEING_MAX_DAYS} days old`,
  },
  overdue: {
    key: "overdue",
    word: "overdue",
    tone: "border-destructive/50 bg-destructive/10 text-destructive",
    meaning: `last rotation is ${AGEING_MAX_DAYS} days old or more`,
  },
  /**
   * 🔴 "NEVER RECORDED", NOT "NEVER ROTATED", AND THE DIFFERENCE IS THE
   * WHOLE HONESTY OF THIS SCREEN.
   *
   * The values live in Railway and are changed by a human there. Nothing
   * in this product observes that happening. All this board can ever
   * know is whether somebody wrote a rotation down in the action
   * register — so "never rotated" would be a claim we cannot support,
   * and an operator who read it would go and rotate a key that was
   * rotated last week, or worse, trust the green tick on one that was
   * not.
   *
   * ⚠️ It is deliberately NOT grey. Grey reads as "nothing to see", and
   * unknown age is the state most likely to be talked out of.
   */
  "never-recorded": {
    key: "never-recorded",
    word: "never recorded",
    tone: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    meaning:
      "no rotation has ever been written down here — which is not the same as never rotated",
  },
});

/**
 * ⚠️ `null` DAYS MEANS "NOTHING IS RECORDED" AND NEVER "ZERO DAYS". A
 * board that folded the unknown case into the freshest band would report
 * every unrecorded secret as newly rotated, which is the exact lie this
 * screen exists to not tell.
 */
export function bandForDays(days: number | null): SecretBand {
  if (days === null) return SECRET_BANDS["never-recorded"];
  if (days < FRESH_MAX_DAYS) return SECRET_BANDS.fresh;
  if (days < AGEING_MAX_DAYS) return SECRET_BANDS.ageing;
  return SECRET_BANDS.overdue;
}

/**
 * Sort weight, worst first. Unknown outranks fresh and ageing because an
 * unmeasured secret is a worse position than a measured old one: you
 * cannot decide about what you cannot see.
 */
export function bandSeverity(key: SecretBandKey): number {
  switch (key) {
    case "overdue":
      return 3;
    case "never-recorded":
      return 2;
    case "ageing":
      return 1;
    case "fresh":
      return 0;
  }
}

/** Which boot list a name came from, and therefore how bad absence is. */
export type SecretBootRole = "required" | "advisory" | "optional";

/**
 * ⭐ THE ROW. LOOK AT WHAT IS NOT IN IT.
 *
 * No `value`, no `length`, no `prefix`, no `suffix`, no `masked`, no
 * `sha`. `present` is a boolean and it is the entire extent of what this
 * product will say about a secret's contents.
 */
export type SecretBoardRow = {
  readonly name: string;
  readonly category: string;
  readonly categoryDescription: string;
  readonly bootRole: SecretBootRole;
  /** Visible to the running process. A boolean, and only ever a boolean. */
  readonly present: boolean;
  /**
   * What breaks when this is absent, in the words `BOOT_ADVISORY` already
   * uses. Null when no list says — the screen then says so rather than
   * inventing a consequence.
   */
  readonly consequence: string | null;
  /** ISO instant of the last rotation SOMEBODY RECORDED, or null. */
  readonly lastRotatedAt: string | null;
  /** Whole days since that, floored. Null when nothing is recorded. */
  readonly daysSinceRotation: number | null;
  readonly bandKey: SecretBandKey;
  /** The staff email from the register. Ours, never a customer's. */
  readonly rotatedBy: string | null;
  /** The reason they gave. Also from the register. */
  readonly rotationReason: string | null;
};

/** Whole days between two instants, floored, never negative. */
export function wholeDaysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}
