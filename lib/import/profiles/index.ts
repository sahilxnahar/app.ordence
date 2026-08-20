/**
 * Ordence — Source profiles, one entry point
 * Version: v1.84.1-alpha · Phase 9
 *
 * ⚠️ THIS IS A BARREL AND NOT A SECOND REGISTRY. `SOURCE_PROFILES` in
 * `./registry.ts` is the one map; re-exporting it does not create another
 * definition of what a profile is, and nothing here may add a name that
 * is not in it.
 */

export type {
  CivilDateFormatKey,
  NegativeStyleKey,
  ProfileDestination,
  ProfileExport,
  ProfileHeader,
  ProfileValidation,
  SourceProfile,
} from "./types";
export { PROFILE_VALIDATION_KINDS } from "./types";

export {
  DETECTABLE_PROFILES,
  FALLBACK_PROFILE,
  isSourceProfileKey,
  profileFor,
  SOURCE_PROFILE_KEYS,
  SOURCE_PROFILES,
  type SourceProfileKey,
} from "./registry";

export {
  detectProfile,
  describeProfileDetection,
  MIN_SIGNATURE_HEADERS,
  MIN_SIGNATURE_SHARE,
  type ProfileDetection,
  type ProfileDetectionBasis,
  type ProfileMatch,
} from "./detect";

export {
  applyCivilDateFormat,
  CIVIL_DATE_FORMAT_LABELS,
  CIVIL_DATE_FORMATS,
  isCivilDateFormatKey,
  resolveCivilDateFormat,
  type DateParse,
  type DateResolution,
  type DateResolutionBasis,
} from "./dates";

export {
  applyNegativeStyle,
  isNegativeStyleKey,
  NEGATIVE_STYLE_LABELS,
  NEGATIVE_STYLES,
  resolveNegativeStyle,
  type AmountParse,
  type AmountResolution,
  type AmountResolutionBasis,
} from "./amounts";

export {
  describeColumnFormats,
  profileFormatPriors,
  profileHeaderPriors,
  PROFILE_HEADER_SCORE,
  resolveColumnFormats,
  type ColumnFormatFinding,
  type ProfileHeaderPrior,
} from "./priors";

export {
  checkSourceProfiles,
  type ProfileCheckOptions,
  type ProfileCheckResult,
  type ProfileProblem,
} from "./check";
