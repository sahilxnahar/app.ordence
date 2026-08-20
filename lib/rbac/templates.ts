/**
 * Ordence — ⭐⭐⭐ ROLE TEMPLATE VERSIONING, AND THE DRIFT THAT IS REAL
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * Pure. No database, no Node APIs — the fingerprint is computed the same
 * way in a test, in the console page and in CI.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FIRST, A CORRECTION TO THE BRIEF THIS WAS WRITTEN FROM
 * ══════════════════════════════════════════════════════════════════════
 * Track D's brief asks for "role template versioning — roles change; tenants
 * provisioned last year have last year's roles. Version the templates and
 * make drift visible per tenant."
 *
 * ⚠️ THE SECOND HALF OF THAT SENTENCE IS NOT TRUE OF THIS CODEBASE, and
 * building for it would have produced a screen that always reads "no
 * drift" — a green dashboard over a question nobody was asking.
 *
 * Measured at 1.81.0:
 *
 *   • `ROLE_TEMPLATES` is a code constant. `permissionsForRole()` reads it
 *     at call time. Every tenant, provisioned yesterday or a year ago, is
 *     evaluated against the CURRENT deployment's templates the moment the
 *     code ships.
 *   • The Phase 1 tables that COULD have materialised a per-tenant copy —
 *     `roles`, `permissions`, `role_permissions`, `user_roles` — are
 *     written by nothing and read by nothing.
 *     `grep -rn "rolePermissions\|userRoles" app server lib components`
 *     outside `db/schema/` returns a local variable in `lib/permissions.ts`
 *     and nothing else. All four are empty after a full bootstrap and seed.
 *
 * So there is no per-tenant snapshot to drift FROM. A tenant cannot have
 * last year's roles, because nowhere stores last year's roles.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THE REAL RISKS ARE, AND WHAT THIS FILE THEREFORE DOES
 * ══════════════════════════════════════════════════════════════════════
 * ① A TEMPLATE CHANGES AND NOBODY DECIDED THAT IT SHOULD. Because the
 *    templates apply retroactively to every existing tenant on deploy,
 *    adding one key to `member` silently grants it to every team member of
 *    every customer, with no migration and no announcement. That is a
 *    LARGER hazard than the one the brief describes, not a smaller one.
 *
 *    → `ROLE_TEMPLATE_VERSIONS` pins a fingerprint per role.
 *      `templateDrift()` reports any role whose live content no longer
 *      matches its pinned fingerprint, and
 *      `tests/security/rbac-templates.test.ts` fails the build on it. The
 *      fix for a red build is one line — bump the version and record what
 *      changed — which is the correct amount of friction for editing what
 *      every customer's staff may do.
 *
 * ② PER-TENANT STATE THAT *DOES* EXIST AND *DOES* DRIFT. Authorisation
 *    that varies by tenant lives in exactly two columns: `users.role` and
 *    `users.permission_overrides`. Overrides are written once, during an
 *    incident or an onboarding, and never revisited — so they rot:
 *
 *      • a grant the template has since absorbed, still recorded as an
 *        exception, so the role screen understates what the template gives;
 *      • a revoke of a key the template no longer grants — inert, and it
 *        makes a boundary look enforced when the template is what enforces it;
 *      • an override on a key that has left the catalogue entirely, which
 *        `evaluatePermission()` ignores (`isPermissionKey` refuses it), so
 *        an administrator's deliberate revoke silently does nothing;
 *      • a grant of a DANGEROUS key to a role whose template withholds it.
 *
 *    → `analyseOverrides()` classifies all four, per user, per tenant. That
 *      is the drift a customer can actually have, and it is invisible today.
 */

import {
  PERMISSION_CATALOG,
  DANGEROUS_PERMISSIONS,
  ROLE_TEMPLATES,
  permissionsForRole,
  type PermissionKey,
} from "@/db/schema/auth";
import { SYSTEM_ROLE_VALUES, type SystemRole } from "@/db/schema/core";
import { isPermissionKey } from "@/lib/permissions";

/* ------------------------------------------------------------------ */
/* FINGERPRINT                                                         */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a, 32-bit, hex.
 *
 * ⚠️ NOT A CRYPTOGRAPHIC HASH AND NOT PRETENDING TO BE. Nothing here
 * resists an adversary — the input is our own source constant and the
 * threat is a careless edit, not a forged one. What it must be is PURE and
 * DEPENDENCY-FREE, because this module is imported by a React server
 * component and by tests, and `node:crypto` would put a Node built-in in
 * the browser bundle for no security benefit. Track D's hard constraint of
 * zero new npm dependencies applies here too.
 */
export function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The canonical, order-independent text of a role's grant.
 *
 * ⚠️ SORTED. The template lists are hand-grouped for readability and get
 * reordered whenever somebody tidies them. A fingerprint that changed on a
 * reorder would fire on every tidy-up and be silenced within a week.
 *
 * ⚠️ THE LABEL AND DESCRIPTION ARE **NOT** IN THE FINGERPRINT. Rewording
 * "Team Member" is not a change to what anybody may do, and a control that
 * fires on copy edits is a control people learn to bypass.
 */
export function fingerprintRole(role: SystemRole): string {
  const template = ROLE_TEMPLATES[role];
  const body =
    template.permissions === "*"
      ? "*"
      : [...template.permissions].sort().join(",");
  return fingerprint(`${role}|${body}`);
}

export type RoleTemplateVersion = {
  readonly role: SystemRole;
  /** Bumped by hand whenever the grant changes. */
  readonly version: number;
  /** `fingerprintRole(role)` as at that version. */
  readonly fingerprint: string;
  /** What changed, and why. Read by whoever is asked "when did this move?" */
  readonly note: string;
};

/**
 * ⭐ THE PINNED VERSIONS.
 *
 * ⚠️ EVERY FINGERPRINT BELOW WAS COMPUTED FROM THE 1.81.0-alpha SOURCE BY
 * RUNNING `fingerprintRole()`, NOT TYPED BY HAND. A hand-typed constant
 * would be wrong on the first attempt and would then be "fixed" by pasting
 * whatever the failing test printed — which is a test that asserts a
 * constant equals itself.
 *
 * ⚠️ AND THAT IS ALSO THE FAILURE MODE OF THIS WHOLE MECHANISM. When the
 * drift test goes red, pasting the new hash in makes it green and records
 * nothing. `note` is the field that makes the paste cost one sentence, and
 * `tests/security/rbac-templates.test.ts` asserts that the note for the
 * current version is non-empty and mentions the version number.
 */
export const ROLE_TEMPLATE_VERSIONS: Readonly<Record<SystemRole, RoleTemplateVersion>> =
  Object.freeze({
    platform_super_admin: {
      role: "platform_super_admin",
      version: 1,
      fingerprint: "cedcdaa4",
      note: "v1: baseline recorded at 1.81.0-alpha. Wildcard template ('*').",
    },
    tenant_owner: {
      role: "tenant_owner",
      version: 1,
      fingerprint: "2ef99867",
      note: "v1: baseline recorded at 1.81.0-alpha. Wildcard template ('*').",
    },
    tenant_admin: {
      role: "tenant_admin",
      version: 1,
      fingerprint: "3b9e8de2",
      note: "v1: baseline recorded at 1.81.0-alpha. Everything except billing:manage.",
    },
    security_admin: {
      role: "security_admin",
      version: 1,
      fingerprint: "743ebc4b",
      note: "v1: baseline recorded at 1.81.0-alpha.",
    },
    billing_admin: {
      role: "billing_admin",
      version: 1,
      fingerprint: "2c10450c",
      note: "v1: baseline recorded at 1.81.0-alpha.",
    },
    manager: {
      role: "manager",
      version: 1,
      fingerprint: "22ba7a5b",
      note:
        "v1: baseline recorded at 1.81.0-alpha. NOTE the label is 'Legal Counsel', " +
        "not a sales manager — see TRACK-REPORT.md on leads:assign.",
    },
    member: {
      role: "member",
      version: 1,
      fingerprint: "e9b730cc",
      note:
        "v1: baseline recorded at 1.81.0-alpha. Holds leads:assign, which no code " +
        "checks; the correction is proposed, not shipped.",
    },
    read_only: {
      role: "read_only",
      version: 1,
      fingerprint: "1a5e06a4",
      note: "v1: baseline recorded at 1.81.0-alpha.",
    },
    guest: {
      role: "guest",
      version: 1,
      fingerprint: "4b5cc89e",
      note: "v1: baseline recorded at 1.81.0-alpha.",
    },
  });

export type TemplateDrift = {
  readonly role: SystemRole;
  readonly pinnedVersion: number;
  readonly pinnedFingerprint: string;
  readonly liveFingerprint: string;
  readonly note: string;
};

/**
 * Roles whose grant no longer matches the version pinned above.
 *
 * An empty array means every template is exactly what was last reviewed.
 * A non-empty one names the role and both fingerprints, so the reviewer's
 * next question — "what changed?" — is answered by a diff of one constant.
 */
export function templateDrift(): readonly TemplateDrift[] {
  const out: TemplateDrift[] = [];
  for (const role of SYSTEM_ROLE_VALUES) {
    const pinned = ROLE_TEMPLATE_VERSIONS[role];
    const live = fingerprintRole(role);
    if (pinned.fingerprint === live) continue;
    out.push({
      role,
      pinnedVersion: pinned.version,
      pinnedFingerprint: pinned.fingerprint,
      liveFingerprint: live,
      note: pinned.note,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PER-TENANT DRIFT — the kind that actually exists                     */
/* ------------------------------------------------------------------ */

export type OverrideProblem =
  /** The key is not in `PERMISSION_CATALOG`. `evaluatePermission` ignores it. */
  | "unknown_key"
  /** Granted, and the role's template already grants it. Noise. */
  | "redundant_grant"
  /** Revoked, and the role's template never granted it. Inert. */
  | "redundant_revoke"
  /** Granted a DANGEROUS key the template withholds from this role. */
  | "dangerous_elevation";

export type OverrideFinding = {
  readonly userId: string;
  readonly email: string | null;
  readonly role: SystemRole;
  readonly key: string;
  readonly value: boolean;
  readonly problem: OverrideProblem;
  /** One sentence an administrator can act on. */
  readonly message: string;
};

export type OverrideSubject = {
  readonly userId: string;
  readonly email?: string | null;
  readonly role: SystemRole;
  readonly overrides: Record<string, boolean> | null | undefined;
};

/**
 * ⭐ CLASSIFY EVERY PER-USER OVERRIDE IN A TENANT.
 *
 * Pure, so the console page fetches rows and this decides — and so the
 * classification can be tested without a database, which is what makes it
 * cheap enough to be tested at all.
 *
 * ⚠️ `unknown_key` IS THE ONE THAT MATTERS AND IT IS THE ONE THAT LOOKS
 * HARMLESS. An administrator who revoked `contacts:export` before that key
 * was renamed still sees a revoke on the user's record. It has done
 * nothing since the rename, because `evaluatePermission()` refuses
 * unrecognised keys BEFORE it consults overrides — the deny-by-default
 * behaviour that is correct at the gate reads, here, as an administrative
 * decision that was silently discarded.
 */
export function analyseOverrides(
  subjects: readonly OverrideSubject[],
): readonly OverrideFinding[] {
  const findings: OverrideFinding[] = [];

  for (const subject of subjects) {
    const overrides = subject.overrides ?? {};
    const template = new Set<string>(permissionsForRole(subject.role));
    const wildcard = ROLE_TEMPLATES[subject.role].permissions === "*";

    for (const [key, value] of Object.entries(overrides)) {
      const base = {
        userId: subject.userId,
        email: subject.email ?? null,
        role: subject.role,
        key,
        value,
      };

      if (!isPermissionKey(key)) {
        findings.push({
          ...base,
          problem: "unknown_key",
          message:
            `"${key}" is not a permission this deployment knows. The ` +
            `${value ? "grant" : "revoke"} recorded against this user has no effect ` +
            `and has not had one since the key left the catalogue.`,
        });
        continue;
      }

      const inTemplate = template.has(key);

      if (value && inTemplate) {
        findings.push({
          ...base,
          problem: "redundant_grant",
          message:
            `The ${ROLE_TEMPLATES[subject.role].label} template already grants ` +
            `"${PERMISSION_CATALOG[key]}". This exception no longer does anything, ` +
            `and it makes the role screen understate what the template gives.`,
        });
        continue;
      }

      if (!value && !inTemplate) {
        findings.push({
          ...base,
          problem: "redundant_revoke",
          message:
            `The ${ROLE_TEMPLATES[subject.role].label} template does not grant ` +
            `"${PERMISSION_CATALOG[key]}", so this revoke is inert. If the boundary ` +
            `matters, it is the template that is enforcing it, not this row.`,
        });
        continue;
      }

      if (
        value &&
        !inTemplate &&
        !wildcard &&
        DANGEROUS_PERMISSIONS.includes(key as PermissionKey)
      ) {
        findings.push({
          ...base,
          problem: "dangerous_elevation",
          message:
            `This user holds "${PERMISSION_CATALOG[key]}" — a dangerous permission — ` +
            `by exception, not by role. Their ${ROLE_TEMPLATES[subject.role].label} ` +
            `template withholds it deliberately.`,
        });
      }
    }
  }

  return findings;
}
