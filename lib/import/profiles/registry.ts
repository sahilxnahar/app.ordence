/**
 * Ordence — ⭐⭐ THE ONE PROFILE MAP
 * Version: v1.84.1-alpha · Phase 9
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ONE MAP, AND MEMBERSHIP IN IT IS THE ONLY DEFINITION OF "A PROFILE"
 * ══════════════════════════════════════════════════════════════════════
 * `lib/import/entities.ts` makes this argument about entities and it is
 * the same argument here, for the same reason: a profile key can arrive
 * from a browser — it is stored on `import_runs.source_profile` and will
 * be echoed back by a wizard — and a dynamic lookup on an unchecked
 * string is one prototype away from returning `Object.prototype.constructor`.
 *
 * ⭐ SO `isSourceProfileKey` IS `Object.hasOwn` ON THIS MAP AND NOTHING
 * ELSE. Not an array `includes`, not a `key in` test, and above all not a
 * second list of names kept beside the map — which is the shape this
 * repository has grown four times and been bitten by every time.
 *
 * 🔴 AND THE LIST IS DUPLICATED IN EXACTLY ONE OTHER PLACE ON PURPOSE:
 * the `import_runs_source_profile_known` CHECK constraint in
 * `SQL-FILES/0275_import_runs_source_profile.sql`. That duplication is
 * the same one `IMPORT_SOURCE_FORMATS` has, it exists for the same reason
 * (Postgres cannot import TypeScript), and it is guarded the same way —
 * see `checkSourceProfiles` in `./check.ts`, which compares them.
 */

import {
  BUSY_PROFILE,
  GENERIC_PROFILE,
  MARG_PROFILE,
  QUICKBOOKS_PROFILE,
  TALLY_PROFILE,
  XERO_PROFILE,
  ZOHO_BOOKS_PROFILE,
} from "./catalogue";
import type { SourceProfile } from "./types";

export const SOURCE_PROFILES = {
  tally: TALLY_PROFILE,
  busy: BUSY_PROFILE,
  marg: MARG_PROFILE,
  "zoho-books": ZOHO_BOOKS_PROFILE,
  quickbooks: QUICKBOOKS_PROFILE,
  xero: XERO_PROFILE,
  generic: GENERIC_PROFILE,
} as const satisfies Record<string, SourceProfile>;

export type SourceProfileKey = keyof typeof SOURCE_PROFILES;

export const SOURCE_PROFILE_KEYS = Object.keys(SOURCE_PROFILES) as readonly SourceProfileKey[];

/**
 * ⚠️ `Object.hasOwn`, NOT `in`. `"constructor" in SOURCE_PROFILES` is
 * `true`, and the guard exists precisely to stop a string off the wire
 * reaching a lookup.
 */
export function isSourceProfileKey(value: unknown): value is SourceProfileKey {
  return typeof value === "string" && Object.hasOwn(SOURCE_PROFILES, value);
}

/**
 * ⭐ THE FALLBACK IS NAMED ONCE, HERE, AND DERIVED FROM THE DATA RATHER
 * THAN WRITTEN AGAIN. `check.ts` refuses a registry with any number of
 * fallbacks other than one, so this cannot silently become the wrong
 * profile — or `undefined`, which would make every unrecognised file
 * throw at the point of description rather than read normally.
 */
export const FALLBACK_PROFILE: SourceProfile =
  SOURCE_PROFILE_KEYS.map((key) => SOURCE_PROFILES[key]).find((p) => p.fallback) ?? GENERIC_PROFILE;

export function profileFor(key: SourceProfileKey): SourceProfile {
  return SOURCE_PROFILES[key];
}

/** Every profile that can be DETECTED — the fallback is the answer, not a candidate. */
export const DETECTABLE_PROFILES: readonly SourceProfile[] = SOURCE_PROFILE_KEYS.map(
  (key) => SOURCE_PROFILES[key],
).filter((profile) => !profile.fallback);
