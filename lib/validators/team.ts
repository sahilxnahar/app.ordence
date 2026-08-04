/**
 * Ordence — Role Constants
 * Version: v0.7.0-alpha
 *
 * Shared by `server/actions/team.ts` and the team settings UI. It lives here
 * rather than in the action file for two reasons:
 *
 *   1. A `"use server"` file may only export async functions. Exporting a
 *      constant from one fails the production build — and, worse, would
 *      publish it as a callable endpoint if it did not.
 *
 *   2. The client previously kept its own copy of this ranking. Two copies
 *      of a privilege ordering is precisely the kind of duplication that
 *      drifts: add a role to one list, forget the other, and the UI starts
 *      offering something the server will refuse — or, far worse, stops
 *      refusing something it should.
 */

/**
 * Roles a tenant administrator may assign.
 *
 * `platform_super_admin` is deliberately absent. It is a platform-operator
 * role that reaches across tenants, and no tenant administrator has any
 * business minting one.
 */
export const ASSIGNABLE_ROLES = [
  "tenant_owner",
  "tenant_admin",
  "security_admin",
  "billing_admin",
  "manager",
  "member",
  "read_only",
  "guest",
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * How powerful a role is, used only to stop someone granting upward.
 *
 * The real authority on what a role can do is the permission catalog; this
 * ordering exists purely to prevent privilege escalation through the role
 * assignment screen. Anyone may only assign at or beneath their own rank.
 */
export const ROLE_RANK: Record<string, number> = {
  guest: 0,
  read_only: 1,
  member: 2,
  manager: 3,
  billing_admin: 4,
  security_admin: 5,
  tenant_admin: 6,
  tenant_owner: 7,
  platform_super_admin: 8,
};

export const ROLE_LABELS: Record<string, string> = {
  platform_super_admin: "Platform super admin",
  tenant_owner: "Owner",
  tenant_admin: "Administrator",
  security_admin: "Security admin",
  billing_admin: "Billing admin",
  manager: "Manager",
  member: "Member",
  read_only: "Read only",
  guest: "Guest",
};

export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 0;
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
