/**
 * Ordence — RBAC, the capability layer
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * ⚠️ THIS IS A BARREL AND NOT A SECOND RULE ENGINE. Every decision in here
 * is still taken by `lib/permissions.ts#evaluatePermission` and
 * `lib/platform/roles.ts#evaluatePlatformCapability`. What this directory
 * adds is the ability to ASK QUESTIONS about those decisions —
 * "everything role X can do", "everyone who can do Y", "has a template
 * changed", "which of this tenant's per-user exceptions have rotted" —
 * which nothing could do before.
 *
 * ⚠️ IT IS ALSO PURE THROUGHOUT. No `server-only`, no database, no
 * `next/headers`. The console page fetches rows and passes them in; the
 * tests pass literals in. A module that reached for a session here would
 * become a second place identity is resolved, and two places that resolve
 * identity is how a screen and a server disagree.
 */

export {
  simulateRole,
  roleHolds,
  whoCanDo,
  ownerOnlyPermissions,
  permissionMatrix,
  type SimulatedPermission,
  type RoleSimulation,
  type HolderAnalysis,
  type PermissionOrigin,
} from "./simulator";

export {
  fingerprint,
  fingerprintRole,
  templateDrift,
  analyseOverrides,
  ROLE_TEMPLATE_VERSIONS,
  type RoleTemplateVersion,
  type TemplateDrift,
  type OverrideFinding,
  type OverrideProblem,
  type OverrideSubject,
} from "./templates";

export {
  DENY_BY_DEFAULT_LEDGER,
  assertKnownPermission,
  requireKnownPermission,
  UnknownPermissionError,
  type DenyByDefaultEntry,
  type DenyByDefaultVerdict,
} from "./deny-by-default";
