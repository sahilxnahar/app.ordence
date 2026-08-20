/**
 * Ordence — ⭐⭐⭐ THE PERMISSION SIMULATOR
 * Version: v1.82.0-alpha · Track D, wave 15
 *
 * Pure. No database, no Node APIs, no `server-only` — the console page,
 * the tests and (if it is ever wanted) a client-side preview all read the
 * same answer. A second implementation of "what can this role do" is how
 * a screen ends up promising something the server refuses.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TWO QUESTIONS, AND WHY NEITHER COULD BE ANSWERED BEFORE
 * ══════════════════════════════════════════════════════════════════════
 * Every enterprise security review opens with the same two:
 *
 *   ① "Show me everything role X can do."
 *   ② "Show me everyone who can do Y."
 *
 * ① was almost answerable — `permissionsForRole()` returns the list, and
 * `effectivePermissions()` in `lib/permissions.ts` folds per-user
 * overrides into it. What was missing is everything that makes the list
 * mean something: which entries are DANGEROUS, which are declared and
 * enforced by nothing (`lib/auth/permission-enforcement.ts` knows, and
 * nothing joined the two), and which came from the template versus from
 * an override.
 *
 * ② could not be answered at all, in either direction that matters:
 * "which ROLES hold `periods:close`" needed a loop nobody had written,
 * and "which PEOPLE hold it" needs per-user overrides, which live in the
 * database. This module answers the first from the templates and gives
 * the second the exact predicate to run against `users`, rather than
 * pretending a pure module can see rows.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * It is NOT a second authorisation path. Nothing here decides anything at
 * a call site; `evaluatePermission()` in `lib/permissions.ts` remains the
 * only decider, and this module CALLS it rather than reimplementing it —
 * so a simulator that disagreed with the enforcement would be a bug in
 * one line, not a slow divergence between two rule engines.
 *
 * That is deliberate to the point of being awkward: `roleHolds()` below
 * could be one `.includes()` and is instead a full `evaluatePermission()`
 * round trip. The awkward version is the one that cannot drift.
 */

import {
  PERMISSION_CATALOG,
  DANGEROUS_PERMISSIONS,
  ALL_PERMISSIONS,
  ROLE_TEMPLATES,
  permissionsForRole,
  type PermissionKey,
} from "@/db/schema/auth";
import { SYSTEM_ROLE_VALUES, type SystemRole } from "@/db/schema/core";
import { evaluatePermission, isPermissionKey } from "@/lib/permissions";
import { DECLARED_ONLY_KEYS, unenforcedReason } from "@/lib/auth/permission-enforcement";

export type PermissionOrigin = "role_template" | "explicit_grant";

/** One permission, with everything a reviewer needs beside it. */
export type SimulatedPermission = {
  readonly key: PermissionKey;
  readonly label: string;
  /** The `namespace` half of `namespace:verb`, for grouping in a UI. */
  readonly group: string;
  readonly dangerous: boolean;
  /**
   * ⭐ TRUE WHEN NOTHING IN THE PRODUCT CHECKS THIS KEY.
   *
   * ⚠️ THE MOST IMPORTANT COLUMN ON THIS SCREEN. A role page that lists
   * `leads:assign` as a capability is telling a customer a boundary
   * exists. `lib/auth/permission-enforcement.ts` records the ones where
   * it does not, and until now the two lived in different files and no
   * screen joined them — so the role page described a fence that is not
   * there.
   */
  readonly enforced: boolean;
  /** Why it is not enforced, verbatim from the enforcement ledger. */
  readonly unenforcedReason: string | null;
  readonly origin: PermissionOrigin;
};

export type RoleSimulation = {
  readonly role: SystemRole;
  readonly label: string;
  readonly description: string;
  /** True for `tenant_owner` and `platform_super_admin`, whose template is `"*"`. */
  readonly wildcard: boolean;
  readonly permissions: readonly SimulatedPermission[];
  readonly counts: {
    readonly total: number;
    readonly dangerous: number;
    readonly unenforced: number;
    readonly fromOverride: number;
  };
};

function groupOf(key: string): string {
  const colon = key.indexOf(":");
  if (colon > 0) return key.slice(0, colon);
  const dot = key.indexOf(".");
  return dot > 0 ? key.slice(0, dot) : key;
}

/**
 * ⭐ DIRECTION ①: everything this subject can do.
 *
 * `overrides` is the same `Record<string, boolean>` shape stored on
 * `users.permission_overrides`, so a caller can pass a real row straight
 * in. Revokes win, exactly as `evaluatePermission()` decides — this
 * function does not re-implement that precedence, it asks.
 */
export function simulateRole(
  role: SystemRole,
  overrides?: Record<string, boolean> | null,
): RoleSimulation {
  const template = ROLE_TEMPLATES[role];
  const wildcard = template.permissions === "*";
  const fromTemplate = new Set<string>(permissionsForRole(role));

  const permissions: SimulatedPermission[] = [];

  for (const key of ALL_PERMISSIONS) {
    /*
     * ⚠️ ASKED, NOT LOOKED UP. `evaluatePermission` is the function the
     * server actually enforces with. Anything else here would be a second
     * opinion, and the whole value of a simulator is that it is not one.
     */
    const decision = evaluatePermission({ role, overrides: overrides ?? null }, key);
    if (!decision.allowed) continue;

    permissions.push({
      key,
      label: PERMISSION_CATALOG[key],
      group: groupOf(key),
      dangerous: DANGEROUS_PERMISSIONS.includes(key),
      enforced: !DECLARED_ONLY_KEYS.includes(key),
      unenforcedReason: unenforcedReason(key),
      origin: fromTemplate.has(key) ? "role_template" : "explicit_grant",
    });
  }

  permissions.sort((a, b) => a.key.localeCompare(b.key));

  return {
    role,
    label: template.label,
    description: template.description,
    wildcard,
    permissions,
    counts: {
      total: permissions.length,
      dangerous: permissions.filter((p) => p.dangerous).length,
      unenforced: permissions.filter((p) => !p.enforced).length,
      fromOverride: permissions.filter((p) => p.origin === "explicit_grant").length,
    },
  };
}

/** Boolean form of direction ①, decided by the enforcement path. */
export function roleHolds(
  role: SystemRole,
  permission: string,
  overrides?: Record<string, boolean> | null,
): boolean {
  return evaluatePermission({ role, overrides: overrides ?? null }, permission).allowed;
}

/* ------------------------------------------------------------------ */
/* DIRECTION ②                                                          */
/* ------------------------------------------------------------------ */

export type HolderAnalysis = {
  readonly permission: string;
  /** False for a string that is not in the catalogue — which nobody holds. */
  readonly known: boolean;
  readonly label: string | null;
  readonly dangerous: boolean;
  readonly enforced: boolean;
  readonly unenforcedReason: string | null;
  /** Roles whose TEMPLATE grants it. */
  readonly rolesByTemplate: readonly SystemRole[];
  /** Of those, the ones whose template is `"*"` rather than an explicit list. */
  readonly rolesByWildcard: readonly SystemRole[];
  /**
   * ⭐ THE SQL THAT FINISHES THE ANSWER.
   *
   * ⚠️ A PURE MODULE CANNOT SEE `users.permission_overrides`, AND
   * PRETENDING OTHERWISE IS THE FAILURE THIS FIELD EXISTS TO AVOID. Roles
   * are half the answer; a user with an explicit grant holds a permission
   * their role does not, and a user with an explicit revoke does not hold
   * one their role does. Returning only the role list would be an answer
   * that is confidently wrong for exactly the users a reviewer is asking
   * about.
   *
   * So the caller gets the predicate to run inside `withTenant()`. The
   * console page does exactly that.
   */
  readonly overrideSql: string;
};

/**
 * ⭐ DIRECTION ②: who can do Y.
 *
 * ⚠️ AN UNKNOWN PERMISSION STRING RETURNS `known: false` AND AN EMPTY ROLE
 * LIST, not an error and not a wildcard. "Nobody holds a permission that
 * does not exist" is both true and the safe answer; throwing would make a
 * typo in a search box look like a system fault, and matching everything
 * would be the fail-open shape this whole track exists to remove.
 */
export function whoCanDo(permission: string): HolderAnalysis {
  const known = isPermissionKey(permission);

  const rolesByTemplate: SystemRole[] = [];
  const rolesByWildcard: SystemRole[] = [];

  if (known) {
    for (const role of SYSTEM_ROLE_VALUES) {
      if (!roleHolds(role, permission)) continue;
      rolesByTemplate.push(role);
      if (ROLE_TEMPLATES[role].permissions === "*") rolesByWildcard.push(role);
    }
  }

  /*
   * ⚠️ THE KEY IS INTERPOLATED INTO A JSONB PATH AND THEREFORE MUST BE A
   * CATALOGUE KEY, WHICH `known` HAS JUST PROVED. An unknown string never
   * reaches this line — the guard below returns the empty predicate — so
   * there is no path on which caller input is concatenated into SQL.
   */
  const overrideSql = known
    ? `SELECT id, email, role, permission_overrides->>'${permission}' AS override
         FROM users
        WHERE tenant_id = app_current_tenant_id()
          AND deleted_at IS NULL
          AND permission_overrides ? '${permission}'`
    : "-- unknown permission: no user can hold it";

  return {
    permission,
    known,
    label: known ? PERMISSION_CATALOG[permission as PermissionKey] : null,
    dangerous: known && DANGEROUS_PERMISSIONS.includes(permission as PermissionKey),
    enforced: known && !DECLARED_ONLY_KEYS.includes(permission),
    unenforcedReason: known ? unenforcedReason(permission) : null,
    rolesByTemplate,
    rolesByWildcard,
    overrideSql,
  };
}

/**
 * Every permission no non-wildcard role holds.
 *
 * ⚠️ THIS IS A DIFFERENT QUESTION FROM "UNENFORCED" AND THE TWO ARE
 * ROUTINELY CONFUSED. A key held only by `tenant_owner` and
 * `tenant_admin` (whose templates are `"*"` and "everything but billing")
 * is fine — it is an owner-only capability. A key that is CHECKED nowhere
 * is a different problem. A reviewer needs both lists and needs to be
 * told they are not the same list.
 */
export function ownerOnlyPermissions(): readonly PermissionKey[] {
  const explicit = SYSTEM_ROLE_VALUES.filter(
    (r) => ROLE_TEMPLATES[r].permissions !== "*",
  );

  return ALL_PERMISSIONS.filter(
    (key) => !explicit.some((role) => permissionsForRole(role).includes(key)),
  );
}

/**
 * A compact matrix for the console: one row per permission, one column
 * per role. Built once and rendered; the page does no logic of its own.
 */
export function permissionMatrix(): {
  readonly roles: readonly SystemRole[];
  readonly rows: readonly {
    readonly key: PermissionKey;
    readonly label: string;
    readonly group: string;
    readonly dangerous: boolean;
    readonly enforced: boolean;
    readonly held: readonly boolean[];
  }[];
} {
  const roles = [...SYSTEM_ROLE_VALUES];
  return {
    roles,
    rows: ALL_PERMISSIONS.map((key) => ({
      key,
      label: PERMISSION_CATALOG[key],
      group: groupOf(key),
      dangerous: DANGEROUS_PERMISSIONS.includes(key),
      enforced: !DECLARED_ONLY_KEYS.includes(key),
      held: roles.map((role) => roleHolds(role, key)),
    })),
  };
}
