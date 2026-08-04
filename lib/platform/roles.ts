/**
 * Ordence — Who Counts As Platform Staff
 * Version: v0.14.0-alpha
 *
 * Pure. No database, no Node APIs, no `server-only` — the console UI, the
 * server gate and the tests all read the same matrix, and a second copy of
 * a privilege ordering is how "the page offered it and the server refused"
 * happens (or, far worse, the reverse).
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUESTION THIS FILE ANSWERS, AND WHY THE OBVIOUS ANSWERS ARE WRONG
 * ══════════════════════════════════════════════════════════════════════
 * Three candidate authorities already exist in this codebase. Each is
 * individually insufficient, and the failure of each is different, which
 * is precisely why combining them is worth something.
 *
 * ┌─ 1. `users.role = 'platform_super_admin'` ─────────────────────────┐
 * │ It is a row in `users` — a TENANT-SCOPED table, inside a customer's │
 * │ own workspace, written by tenant-facing code. Today no application  │
 * │ path can set it (`ASSIGNABLE_ROLES` in lib/validators/team.ts       │
 * │ excludes it and the Zod enum rejects it outright), but the column   │
 * │ is one `users:update` code path away from being writable, and the   │
 * │ moment it is, cross-tenant access becomes a property of a row       │
 * │ inside a customer's tenant.                                        │
 * │                                                                    │
 * │ It also already MEANS something else. `lib/billing/seats.ts` reads  │
 * │ it as "our staff member is sitting in this workspace and must not   │
 * │ consume a seat the customer paid for". That is a useful, narrow,    │
 * │ tenant-local meaning and this phase does not overload it.          │
 * │                                                                    │
 * │ ⭐ DECISION: `platform_super_admin` grants NOTHING in the console.  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 2. `PLATFORM_ADMIN_EMAILS` (lib/env.ts) ──────────────────────────┐
 * │ A deploy-time allowlist. Its strength is exactly that: changing it  │
 * │ requires a reviewed commit and production environment access, so a  │
 * │ database compromise cannot add a name to it.                       │
 * │                                                                    │
 * │ Its weaknesses are equally structural. It cannot be revoked without │
 * │ a deploy — at 03:00, during the incident where you have just learnt │
 * │ an operator's laptop was stolen, that is the wrong latency. It      │
 * │ cannot express an expiry, a capability level, or who granted it.    │
 * │ And it keys on an email address, which is a label, not an identity. │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ 3. The Clerk session claim used by `middleware.ts` ───────────────┐
 * │ `sessionClaims.metadata.platformAdmin === true` gates `/platform`.  │
 * │ That is a ROUTING decision and it is fine as one. It must never be  │
 * │ the authorisation decision, for a reason that is a live risk rather │
 * │ than a theoretical one: whether that claim is forgeable depends     │
 * │ entirely on the Clerk JWT template. `{{user.public_metadata}}` is   │
 * │ writable only with the backend secret key; `{{user.unsafe_metadata}}│
 * │ is writable by the signed-in user from the browser. If the template │
 * │ ever maps the latter, ANY authenticated user promotes themselves to │
 * │ the console route with one client-side API call.                   │
 * │                                                                    │
 * │ See INTEGRATION REQUIRED in docs/PHASE-17-18-NOTES.md — the         │
 * │ template must be verified. The gate below makes reaching the route  │
 * │ worth nothing regardless.                                          │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ANSWER: TWO INDEPENDENT KEYS, BOTH REQUIRED
 * ══════════════════════════════════════════════════════════════════════
 *   KEY 1 — the caller's Clerk-verified email is in `PLATFORM_ADMIN_EMAILS`
 *   KEY 2 — an ACTIVE, UNEXPIRED row in `platform_staff` for their Clerk id
 *
 * Becoming platform staff therefore needs a reviewed config deploy AND a
 * grant recorded by existing staff. Losing it needs either — which means
 * revocation is one UPDATE (fast, no deploy) while promotion is not.
 *
 * The asymmetry is the point: the cheap operation is the safe one.
 */

/* ------------------------------------------------------------------ */
/* GRADES                                                              */
/* ------------------------------------------------------------------ */

export const PLATFORM_GRADES = ["support", "engineer", "owner"] as const;
export type PlatformGrade = (typeof PLATFORM_GRADES)[number];

/**
 * Everything the console can do.
 *
 * Keys are STABLE IDENTIFIERS. A renamed key fails closed (every check
 * for the old name starts denying), which is the correct direction, but
 * it is still a silent capability outage — add keys, never rename them.
 */
export const PLATFORM_CAPABILITIES = {
  "tenants:list": "See the tenant directory with health and plan",
  "tenants:read": "Open a tenant's metadata, usage and billing state",
  "tenants:suspend": "Suspend or reactivate a workspace",
  "search:directory": "Search tenants, workspace users and billing records",
  "impersonate:consented": "Start an impersonation backed by tenant consent",
  "impersonate:breakglass": "Start a read-only impersonation with no consent",
  "flags:read": "See a tenant's feature flags",
  "flags:write": "Turn a tenant's feature flags on or off",
  "staff:read": "See who holds platform access",
  "staff:manage": "Grant or revoke platform access",
  "observatory:read": "See cross-tenant health, revenue and quota burn-down",
  "tenants:provision": "Create a workspace and put it live on a domain",

  /**
   * ⭐ THE TWO CAPABILITIES THAT REPLACE A DEPLOY — v0.53.0, Sections C–E.
   *
   * Before these, turning a module on for one customer meant editing
   * `lib/modules/registry.ts` or a plan matrix and shipping it. That has
   * two costs nobody counts: the customer waits for a release train, and
   * the change is invisible to everyone who is not reading the diff.
   *
   * ⚠️ THEY ARE SPLIT ON PURPOSE, AND THE SPLIT IS COMMERCIAL RATHER THAN
   * TECHNICAL. Both write one row. But `entitlements:override` moves one
   * capability for one workspace — a pilot, a migration, a promise made
   * in a sales call — and is the sort of thing an engineer does during an
   * incident. `tenants:configure` changes the PLAN, the seat ceiling, the
   * storage ceiling and the industry template: the shape of the invoice
   * and the shape of the customer's whole navigation. Merging them would
   * mean the grade that can unblock a support ticket at 03:00 is also the
   * grade that can put a customer on Enterprise.
   */
  "entitlements:override":
    "Turn one module on or off for one workspace, above or below its plan",
  "tenants:configure":
    "Change a workspace's plan tier, seat and storage limits, and industry template",
} as const;

export type PlatformCapability = keyof typeof PLATFORM_CAPABILITIES;

export const PLATFORM_CAPABILITY_KEYS = Object.keys(
  PLATFORM_CAPABILITIES,
) as PlatformCapability[];

/**
 * The matrix. Data, deliberately — adding a capability is one entry here
 * and one `requireCapability()` call at the boundary.
 *
 * ⚠️ NOTE WHAT `support` DOES NOT HAVE. The support rota is the largest
 * group, the most frequently phished, and the one whose credentials sit
 * in the most browsers. It cannot suspend a workspace, cannot break-glass
 * and cannot grant staff. A phished support account costs us a consented
 * read; a phished owner account costs us the platform.
 */
const GRADE_CAPABILITIES: Readonly<Record<PlatformGrade, readonly PlatformCapability[]>> =
  Object.freeze({
    support: [
      "tenants:list",
      "tenants:read",
      "search:directory",
      "impersonate:consented",
      "flags:read",
      "staff:read",
      // ⚠️ Support CAN see the observatory. It is aggregate health and
      // revenue with no record-level customer data in it, and the churn
      // siren is worthless if the people who answer the phone cannot see
      // which account went quiet.
      "observatory:read",
    ],
    engineer: [
      "tenants:list",
      "tenants:read",
      "search:directory",
      "impersonate:consented",
      "impersonate:breakglass",
      "flags:read",
      "flags:write",
      "staff:read",
      "observatory:read",
      // ⚠️ An engineer can move ONE module for ONE workspace, and cannot
      // change the plan that decides the rest. That is the same boundary
      // `flags:write` already draws — a temporary, expiring, reasoned
      // grant is support work; re-pricing a customer is not.
      "entitlements:override",
      // ⚠️ Provisioning is NOT here. Creating a workspace mints billing
      // identity and a public hostname; it belongs with the grade that
      // can already suspend one. An engineer who needs a tenant asks.
      //
      // ⚠️ Neither is `tenants:configure`. Changing `plan_tier` changes
      // what we will invoice; changing the industry template rearranges
      // every menu the customer sees the next time they load a page.
    ],
    owner: PLATFORM_CAPABILITY_KEYS,
  });

export function capabilitiesForGrade(grade: PlatformGrade): readonly PlatformCapability[] {
  return GRADE_CAPABILITIES[grade];
}

export const GRADE_LABELS: Readonly<Record<PlatformGrade, string>> = Object.freeze({
  support: "Support",
  engineer: "Engineer",
  owner: "Platform owner",
});

/* ------------------------------------------------------------------ */
/* THE SUBJECT                                                         */
/* ------------------------------------------------------------------ */

/** Everything needed to decide, with no I/O. */
export type PlatformSubject = {
  clerkUserId: string;
  email: string;
  grade: PlatformGrade;
  status: "active" | "suspended" | "revoked";
  expiresAt: Date | null;
  /** Whether KEY 1 — the env allowlist — matched. */
  allowlisted: boolean;
  now: Date;
};

export type PlatformDecision = {
  allowed: boolean;
  reason:
    | "ok"
    | "not_allowlisted"
    | "no_staff_record"
    | "staff_revoked"
    | "staff_suspended"
    | "staff_expired"
    | "capability_not_in_grade"
    | "unknown_capability";
  /** Safe to show an operator. Never leaks whether the OTHER key matched. */
  message: string;
};

export function isPlatformCapability(value: unknown): value is PlatformCapability {
  return typeof value === "string" && value in PLATFORM_CAPABILITIES;
}

/**
 * Is this person platform staff at all?
 *
 * Fails CLOSED on everything, including an unrecognised status. The
 * checks run in a fixed order so the reason is deterministic and the
 * error message is stable in tests.
 */
export function evaluatePlatformAccess(subject: PlatformSubject): PlatformDecision {
  if (!subject.allowlisted) {
    return {
      allowed: false,
      reason: "not_allowlisted",
      message: "This account is not platform staff.",
    };
  }
  if (subject.status === "revoked") {
    return {
      allowed: false,
      reason: "staff_revoked",
      message: "Platform access for this account has been revoked.",
    };
  }
  if (subject.status !== "active") {
    return {
      allowed: false,
      reason: "staff_suspended",
      message: "Platform access for this account is suspended.",
    };
  }
  if (subject.expiresAt && subject.expiresAt.getTime() <= subject.now.getTime()) {
    return {
      allowed: false,
      reason: "staff_expired",
      message: "Platform access for this account has expired.",
    };
  }
  return { allowed: true, reason: "ok", message: "" };
}

/**
 * Does this person hold a specific capability?
 *
 * ⚠️ ALWAYS re-runs `evaluatePlatformAccess` first. A capability check
 * that assumes the caller already passed the access check is one
 * refactor away from being the only check that runs.
 */
export function evaluatePlatformCapability(
  subject: PlatformSubject,
  capability: string,
): PlatformDecision {
  const base = evaluatePlatformAccess(subject);
  if (!base.allowed) return base;

  if (!isPlatformCapability(capability)) {
    // A typo must deny. The opposite default turns every typo into a hole.
    return {
      allowed: false,
      reason: "unknown_capability",
      message: `Unknown platform capability "${capability}".`,
    };
  }

  if (!capabilitiesForGrade(subject.grade).includes(capability)) {
    return {
      allowed: false,
      reason: "capability_not_in_grade",
      message: `${GRADE_LABELS[subject.grade]} cannot ${PLATFORM_CAPABILITIES[
        capability
      ].toLowerCase()}.`,
    };
  }

  return { allowed: true, reason: "ok", message: "" };
}

export function hasPlatformCapability(
  subject: PlatformSubject,
  capability: string,
): boolean {
  return evaluatePlatformCapability(subject, capability).allowed;
}

/* ------------------------------------------------------------------ */
/* THE ENV ALLOWLIST                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse `PLATFORM_ADMIN_EMAILS` into a normalised set.
 *
 * ⚠️ AN EMPTY OR UNSET VALUE YIELDS AN EMPTY SET, AND AN EMPTY SET
 * MATCHES NOBODY. That is deliberate and it is the single most important
 * line in this file: the failure mode of a missing environment variable
 * is "the console is unreachable", never "the console is open". A
 * deployment that forgot to set it loses an internal tool; the opposite
 * default loses every customer's data.
 */
export function parseAdminAllowlist(raw: string | undefined | null): ReadonlySet<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0 && entry.includes("@")),
  );
}

/** Case-insensitive membership. Emails are not case-sensitive in practice. */
export function isAllowlisted(
  email: string | null | undefined,
  allowlist: ReadonlySet<string>,
): boolean {
  if (!email) return false;
  return allowlist.has(email.trim().toLowerCase());
}

/* ------------------------------------------------------------------ */
/* STEP-UP FRESHNESS                                                   */
/* ------------------------------------------------------------------ */

/**
 * How recently a second factor must have been proved before a dangerous
 * operation is permitted.
 *
 * Fifteen minutes is chosen against the threat this exists for: a
 * session token lifted from a stolen laptop or an XSS payload. The
 * attacker holds the cookie but not the factor, so anything behind
 * step-up is out of reach for them — provided the window is short enough
 * that they did not simply inherit a fresh one. Fifteen minutes is long
 * enough to suspend three tenants in one incident without re-prompting,
 * short enough that a cookie stolen over lunch is already stale.
 */
export const STEP_UP_MAX_AGE_MINUTES = 15;

/** Operations that require a fresh second factor, not merely a session. */
export const STEP_UP_CAPABILITIES: readonly PlatformCapability[] = [
  "tenants:suspend",
  "impersonate:consented",
  "impersonate:breakglass",
  "staff:manage",
  "flags:write",
  // Both of the v0.53.0 configuration capabilities. An entitlement
  // override is a paid capability changing hands; a plan change is the
  // invoice changing. Neither should be reachable with a lifted cookie
  // and no second factor.
  "entitlements:override",
  "tenants:configure",
];

export function requiresStepUp(capability: PlatformCapability): boolean {
  return STEP_UP_CAPABILITIES.includes(capability);
}

export function isStepUpFresh(lastStepUpAt: Date | null, now: Date): boolean {
  if (!lastStepUpAt) return false;
  const ageMinutes = (now.getTime() - lastStepUpAt.getTime()) / 60_000;
  // A negative age means a clock skew or a forged future timestamp.
  // Refuse rather than treat "the future" as maximally fresh.
  return ageMinutes >= 0 && ageMinutes <= STEP_UP_MAX_AGE_MINUTES;
}
