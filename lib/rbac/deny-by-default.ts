/**
 * Ordence — ⭐⭐⭐ THE DENY-BY-DEFAULT LEDGER
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * Pure. Data plus two helpers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS, AND WHY IT IS DATA RATHER THAN A PARAGRAPH
 * ══════════════════════════════════════════════════════════════════════
 * Track D's brief says: "Deny by default. An unknown permission string
 * should refuse, not pass. Audit every permission check for the shape that
 * returns true on an unrecognised input."
 *
 * ⭐ THE AUDIT WAS RUN AND THE HEADLINE IS THAT THE BRIEF IS WRONG IN THE
 * REASSURING DIRECTION. Every authorisation EVALUATOR in this codebase
 * already refuses unknown input, and several say so in their own comments:
 *
 *     lib/permissions.ts#evaluatePermission        unknown_permission → allowed: false
 *     lib/platform/roles.ts#evaluatePlatformCapability
 *                                                  unknown_capability → allowed: false
 *     lib/platform/roles.ts#parseAdminAllowlist    unset env → matches nobody
 *     lib/entitlements/features.ts#evaluateFeature unknown_feature → allowed: false
 *     lib/mcp/registry.ts#scopePermits             unknown tool → false
 *     lib/platform/approvals.ts                    unknown kind → deny
 *     lib/hr/visibility.ts#canReadReview           default: return false
 *     lib/crm/consent.ts#mayContact                "silence is not consent"
 *     server/portal-context.ts                     every unknown path is a refusal
 *
 * ⚠️ SO THE HONEST FINDING IS NOT "FIXED IT". It is that the weakness is
 * one layer out — in `middleware.ts`, where the PERIMETER is assembled
 * from conditions that evaporate on absent input rather than refusing.
 * Those are recorded below and are NOT Track D's files; they are written
 * up in `TRACK-REPORT.md` §4 and left alone deliberately.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A LIST IS NOT AN ENFORCEMENT. THAT IS THIS REPOSITORY'S DEFECT #12.
 * ══════════════════════════════════════════════════════════════════════
 * A ledger of "these all fail closed" is worth nothing on its own — it is
 * a paragraph in a type annotation. What makes it worth something is
 * `tests/security/deny-by-default.test.ts`, which takes every entry marked
 * `callable` and ACTUALLY CALLS the evaluator with unknown input, then
 * asserts it refused. If someone loosens one of them, the assertion goes
 * red naming the file. The entries that are not callable from a pure test
 * are marked `evidence: "source"` and say so, rather than being asserted
 * by a grep that would pass on a comment.
 */

import { evaluatePermission, isPermissionKey, PermissionDeniedError } from "@/lib/permissions";
import type { PermissionKey } from "@/db/schema/auth";

export type DenyByDefaultVerdict =
  /** Called with unknown input in a test; it refused. */
  | "closed_proven"
  /** Refuses, but the proof is a reading of the source, not a call. */
  | "closed_by_reading"
  /** Permits on some absent/unknown input. Not Track D's to fix. */
  | "open_recorded";

export type DenyByDefaultEntry = {
  readonly where: string;
  readonly what: string;
  readonly verdict: DenyByDefaultVerdict;
  /** For `open_recorded`: exactly what input permits, and whether it is reachable. */
  readonly note: string;
  /** True when Track D owns the file and could have changed it. */
  readonly ownedByTrackD: boolean;
};

export const DENY_BY_DEFAULT_LEDGER: readonly DenyByDefaultEntry[] = [
  {
    where: "lib/permissions.ts#evaluatePermission",
    what: "the tenant permission evaluator",
    verdict: "closed_proven",
    note: "An unrecognised key returns reason 'unknown_permission' with allowed: false, before overrides are consulted.",
    ownedByTrackD: false,
  },
  {
    where: "lib/platform/roles.ts#evaluatePlatformCapability",
    what: "the platform console capability evaluator",
    verdict: "closed_proven",
    note: "Re-runs the access check first, then refuses an unknown capability with 'unknown_capability'.",
    ownedByTrackD: false,
  },
  {
    where: "lib/platform/roles.ts#parseAdminAllowlist",
    what: "PLATFORM_ADMIN_EMAILS parsing",
    verdict: "closed_proven",
    note: "An unset or empty value yields an empty set, and an empty set matches nobody. The failure mode of a missing variable is an unreachable console.",
    ownedByTrackD: false,
  },
  {
    where: "lib/entitlements/features.ts#evaluateFeature",
    what: "the plan entitlement evaluator",
    verdict: "closed_proven",
    note: "isFeatureKey uses Object.hasOwn, so an inherited property name cannot smuggle a truthy lookup through.",
    ownedByTrackD: false,
  },
  {
    where: "lib/mcp/registry.ts#scopePermits",
    what: "MCP token scope against a tool name",
    verdict: "closed_proven",
    note: "An unknown TOOL is refused. An unknown SCOPE still reaches read-only tools — the write half fails closed, and the scope value comes from our own mcp_tokens row, not from the request.",
    ownedByTrackD: false,
  },
  {
    where: "middleware.ts step 7 (cross-tenant host check)",
    what: "the host-says-one-tenant / session-says-another refusal",
    verdict: "open_recorded",
    note:
      "Guarded by `locator.kind === 'subdomain' && orgSlug && …`. A Clerk organisation with no slug, or a JWT template that does not project org_slug, skips the check entirely and silently. Not a data leak today — requireTenantContext resolves the tenant from auth().orgId, never from the host, and RLS pins it — but the documented perimeter is one falsy value from not existing.",
    ownedByTrackD: false,
  },
  {
    where: "middleware.ts public-route allowlist",
    what: "the `/legal(.*)` entry",
    verdict: "open_recorded",
    note:
      "`/legal(.*)` is a suffix wildcard, so it exempts app/(crm)/legal/** — an authenticated practice-management module — plus anything beginning `/legal`. The CRM layout and per-action requirePermission still refuse, so this is a lost layer rather than an open door.",
    ownedByTrackD: false,
  },
  {
    where: "lib/platform/roles.ts#requiresStepUp",
    what: "which capabilities need a fresh second factor",
    verdict: "open_recorded",
    note:
      "An allowlist, so a NEW capability added to PLATFORM_CAPABILITIES and forgotten here ships with no step-up. Not reachable via a widened string — requireCapability() denies unknown capabilities first — so the risk is maintenance-shaped, not input-shaped.",
    ownedByTrackD: false,
  },
  {
    where: "lib/security/lockout.ts#isLocked",
    what: "the lockout read on a database failure",
    verdict: "open_recorded",
    note:
      "Still degrades to 'not locked'; availability wins on the auth path and Clerk's own lockout is the real guard. Wave 15 added `degraded: true` and a critical event so the two answers are no longer identical. Deliberate, owned, and now visible.",
    ownedByTrackD: true,
  },
  {
    where: "server/billing/access.ts",
    what: "billing standing when the subscription lookup fails",
    verdict: "closed_proven",
    note:
      "Was the largest fail-open in the repository; reversed in wave 15 to `restricted` (read-only, still readable, still exportable, still payable, statutory writes still permitted).",
    ownedByTrackD: true,
  },
  {
    where: "server/security/record.ts#recordSecurityEvent",
    what: "a security event that cannot be written",
    verdict: "closed_by_reading",
    note:
      "Returns false rather than throwing, by design — a database hiccup must not turn a correctly-refused request into a 500. Never an authorisation decision.",
    ownedByTrackD: false,
  },
];

/**
 * ⭐ THE STRICT GATE FOR NEW CODE.
 *
 * `evaluatePermission()` already refuses unknown keys, so this adds no
 * security — what it adds is a REFUSAL AT THE TYPE BOUNDARY for code that
 * receives a permission name as data: a workflow definition, a saved view,
 * a config row, an MCP argument.
 *
 * ⚠️ THE DIFFERENCE MATTERS. `evaluatePermission("contats:read")` returns
 * `allowed: false`, which is safe and is also indistinguishable from "this
 * user does not have it". A typo in a config row would therefore present
 * as a permissions problem for one customer, forever, and the person
 * debugging it would look at the user's role. This one names the typo.
 */
export function assertKnownPermission(value: unknown): PermissionKey {
  if (!isPermissionKey(value)) {
    throw new UnknownPermissionError(String(value));
  }
  return value;
}

export class UnknownPermissionError extends Error {
  constructor(readonly permission: string) {
    super(
      `"${permission}" is not a permission in this deployment's catalogue. ` +
        `Nothing grants it and nothing checks it; a call site asking for it will ` +
        `always be refused, which is safe and is not what you meant.`,
    );
    this.name = "UnknownPermissionError";
  }
}

/**
 * Refuse unless the subject holds the permission — with the unknown-key
 * case separated from the not-granted case.
 *
 * ⚠️ PURE. It takes the subject rather than reading a session, so it is
 * usable from a worker, a test and a server action alike, and so this
 * module never becomes a second place that resolves identity.
 */
export function requireKnownPermission(
  subject: { role: Parameters<typeof evaluatePermission>[0]["role"]; overrides?: Record<string, boolean> | null },
  permission: unknown,
): PermissionKey {
  const key = assertKnownPermission(permission);
  const decision = evaluatePermission(subject, key);
  if (!decision.allowed) throw new PermissionDeniedError(decision);
  return key;
}
