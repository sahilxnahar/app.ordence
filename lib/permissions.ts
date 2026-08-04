/**
 * Ordence — Permission Checking
 * Version: v0.5.0-alpha
 *
 * Pure functions only — no database, no Node APIs — so this module runs in Edge
 * middleware, server components, server actions and client components alike.
 *
 * THE MODEL:
 *   effective permissions = role template  +  per-user grants  −  per-user revokes
 *
 * Revokes win. If a permission is both granted and revoked for a user, it is
 * denied. Any other precedence would mean a revocation could be silently
 * undone by an unrelated grant — the wrong default for a security control.
 */

import {
  PERMISSION_CATALOG,
  DANGEROUS_PERMISSIONS,
  permissionsForRole,
  type PermissionKey,
} from "@/db/schema/auth";
import type { SystemRole } from "@/db/schema";

export type { PermissionKey };

/** Everything needed to decide, with no I/O. */
export type PermissionSubject = {
  role: SystemRole;
  /** Per-user overrides: `{ "periods:close": true, "contacts:delete": false }` */
  overrides?: Record<string, boolean> | null;
};

export type PermissionDecision = {
  allowed: boolean;
  permission: PermissionKey;
  /** Why the decision came out this way — useful in logs and error messages. */
  reason: "role_grant" | "explicit_grant" | "explicit_revoke" | "not_in_role" | "unknown_permission";
  isDangerous: boolean;
};

/** Type guard for values arriving from config or the database. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && value in PERMISSION_CATALOG;
}

/**
 * Decide whether a subject holds a permission.
 *
 * Fails CLOSED on an unrecognised permission string. A typo in a call site must
 * deny access, never grant it — the opposite default would turn every typo into
 * a silent security hole.
 */
export function evaluatePermission(
  subject: PermissionSubject,
  permission: string,
): PermissionDecision {
  if (!isPermissionKey(permission)) {
    return {
      allowed: false,
      permission: permission as PermissionKey,
      reason: "unknown_permission",
      isDangerous: false,
    };
  }

  const isDangerous = DANGEROUS_PERMISSIONS.includes(permission);
  const overrides = subject.overrides ?? {};

  // Explicit revoke beats everything.
  if (overrides[permission] === false) {
    return { allowed: false, permission, reason: "explicit_revoke", isDangerous };
  }

  // Explicit grant beats the role template.
  if (overrides[permission] === true) {
    return { allowed: true, permission, reason: "explicit_grant", isDangerous };
  }

  const rolePermissions = permissionsForRole(subject.role);
  if (rolePermissions.includes(permission)) {
    return { allowed: true, permission, reason: "role_grant", isDangerous };
  }

  return { allowed: false, permission, reason: "not_in_role", isDangerous };
}

/** Boolean shorthand. */
export function can(subject: PermissionSubject, permission: string): boolean {
  return evaluatePermission(subject, permission).allowed;
}

/** True only if the subject holds EVERY listed permission. */
export function canAll(subject: PermissionSubject, permissions: string[]): boolean {
  return permissions.every((p) => can(subject, p));
}

/** True if the subject holds AT LEAST ONE of the listed permissions. */
export function canAny(subject: PermissionSubject, permissions: string[]): boolean {
  return permissions.some((p) => can(subject, p));
}

/** The subject's complete effective permission set — useful for the UI. */
export function effectivePermissions(subject: PermissionSubject): PermissionKey[] {
  const base = new Set<PermissionKey>(permissionsForRole(subject.role));
  for (const [key, value] of Object.entries(subject.overrides ?? {})) {
    if (!isPermissionKey(key)) continue;
    if (value === true) base.add(key);
    if (value === false) base.delete(key);
  }
  return [...base].sort();
}

/** Human-readable label for a permission, for UI and error messages. */
export function describePermission(permission: string): string {
  return isPermissionKey(permission) ? PERMISSION_CATALOG[permission] : permission;
}

/** Thrown by `requirePermission()` in server actions. */
export class PermissionDeniedError extends Error {
  readonly permission: string;
  readonly reason: PermissionDecision["reason"];
  readonly isDangerous: boolean;

  constructor(decision: PermissionDecision) {
    super(
      decision.reason === "unknown_permission"
        ? `Unknown permission "${decision.permission}".`
        : `You do not have permission to ${describePermission(decision.permission).toLowerCase()}.`,
    );
    this.name = "PermissionDeniedError";
    this.permission = decision.permission;
    this.reason = decision.reason;
    this.isDangerous = decision.isDangerous;
  }
}
