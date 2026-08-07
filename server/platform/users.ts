import "server-only";

/**
 * Ordence — Platform User Management
 * Version: v0.80.0-alpha
 *
 * Platform-wide user management. Lists every user across every workspace,
 * grouped by Clerk identity. Write operations (status/role changes) use
 * `recordPlatformAudit` with the tenant id so the customer can see the
 * change in their own audit log.
 */

import { and, eq, desc, asc, sql, ilike, or, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users, tenants } from "@/db/schema";
import { requireCapability, recordPlatformAudit, type PlatformOperator } from "@/server/platform/guard";
import { withTenant } from "@/db";
import type { PlatformResult } from "@/lib/platform/schemas";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type PlatformUserSummary = {
  clerkUserId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  tenantCount: number;
  highestRole: string;
  lastSeenAt: string | null;
  status: string;
};

export type PlatformUserDetail = {
  clerkUserId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  memberships: Array<{
    userId: string;
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    role: string;
    status: string;
    department: string | null;
    jobTitle: string | null;
    lastSeenAt: string | null;
    createdAt: string;
  }>;
  totalTenants: number;
  activeTenants: number;
};

export type UserSortKey = "email" | "lastSeen" | "created" | "tenants";

/* ------------------------------------------------------------------ */
/* ROLE RANKING                                                        */
/* ------------------------------------------------------------------ */

const ROLE_RANK: Record<string, number> = {
  platform_super_admin: 100,
  tenant_owner: 90,
  tenant_admin: 80,
  security_admin: 70,
  billing_admin: 70,
  manager: 60,
  member: 40,
  read_only: 20,
  guest: 10,
};

function highestRole(roles: string[]): string {
  if (roles.length === 0) return "member";
  return roles.reduce((highest, role) =>
    (ROLE_RANK[role] ?? 0) > (ROLE_RANK[highest] ?? 0) ? role : highest,
  );
}

/* ------------------------------------------------------------------ */
/* LIST — all users across all tenants                                 */
/* ------------------------------------------------------------------ */

export async function listAllUsers(filters: {
  query?: string;
  status?: string;
  role?: string;
  tenantId?: string;
  sort?: UserSortKey;
  direction?: "asc" | "desc";
  offset?: number;
}): Promise<PlatformResult<{ rows: PlatformUserSummary[]; total: number }>> {
  try {
    await requireCapability("tenants:read");

    const conditions = [isNull(users.deletedAt)];

    if (filters.status && filters.status !== "all") {
      conditions.push(eq(users.status, filters.status as typeof users.status.enumValues[number]));
    }
    if (filters.role && filters.role !== "all") {
      conditions.push(eq(users.role, filters.role as typeof users.role.enumValues[number]));
    }
    if (filters.tenantId && filters.tenantId !== "all") {
      conditions.push(eq(users.tenantId, filters.tenantId));
    }
    if (filters.query) {
      const pattern = `%${filters.query}%`;
      conditions.push(
        or(
          ilike(users.email, pattern),
          ilike(users.firstName, pattern),
          ilike(users.lastName, pattern),
        )!,
      );
    }

    const sortColumn =
      filters.sort === "lastSeen"
        ? users.lastSeenAt
        : filters.sort === "created"
          ? users.createdAt
          : filters.sort === "tenants"
            ? users.tenantId
            : users.email;

    const direction = filters.direction === "asc" ? asc : desc;
    const offset = Math.min(filters.offset ?? 0, 10_000);
    const limit = 100;

    const rows = await db
      .select({
        clerkUserId: users.clerkUserId,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        status: users.status,
        lastSeenAt: users.lastSeenAt,
        createdAt: users.createdAt,
        tenantId: users.tenantId,
      })
      .from(users)
      .where(and(...conditions))
      .orderBy(direction(sortColumn))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(...conditions));
    const total = countResult[0]?.count ?? 0;

    // Group by clerkUserId to collapse multi-tenant memberships
    const byClerk = new Map<string, PlatformUserSummary>();

    for (const row of rows) {
      const existing = byClerk.get(row.clerkUserId);
      if (existing) {
        existing.tenantCount++;
        existing.highestRole = highestRole([existing.highestRole, row.role]);
        if (row.lastSeenAt) {
          if (!existing.lastSeenAt || new Date(row.lastSeenAt) > new Date(existing.lastSeenAt)) {
            existing.lastSeenAt = row.lastSeenAt.toISOString();
          }
        }
        if (row.status === "active") {
          existing.status = "active";
        }
      } else {
        byClerk.set(row.clerkUserId, {
          clerkUserId: row.clerkUserId,
          email: row.email,
          fullName: [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
          avatarUrl: row.avatarUrl,
          tenantCount: 1,
          highestRole: row.role,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          status: row.status,
        });
      }
    }

    return { ok: true, data: { rows: Array.from(byClerk.values()), total } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to list users.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* DETAIL — one user with all their tenant memberships                 */
/* ------------------------------------------------------------------ */

export async function getPlatformUserDetail(
  clerkUserId: string,
): Promise<PlatformResult<PlatformUserDetail>> {
  try {
    await requireCapability("tenants:read");

    const userRows = await db
      .select({
        userId: users.id,
        tenantId: users.tenantId,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        status: users.status,
        department: users.department,
        jobTitle: users.jobTitle,
        lastSeenAt: users.lastSeenAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.clerkUserId, clerkUserId), isNull(users.deletedAt)))
      .orderBy(desc(users.createdAt));

    if (userRows.length === 0) {
      return { ok: false, error: "No user found with that id." };
    }

    const tenantIds = userRows.map((u) => u.tenantId);
    const tenantRows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
      })
      .from(tenants)
      .where(sql`${tenants.id} = any(${tenantIds})`);

    const tenantMap = new Map(tenantRows.map((t) => [t.id, t]));

    const memberships = userRows.map((u) => {
      const tenant = tenantMap.get(u.tenantId);
      return {
        userId: u.userId,
        tenantId: u.tenantId,
        tenantName: tenant?.name ?? "Unknown",
        tenantSlug: tenant?.slug ?? "unknown",
        role: u.role,
        status: u.status,
        department: u.department,
        jobTitle: u.jobTitle,
        lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      };
    });

    const first = userRows[0]!;
    const activeTenants = memberships.filter((m) => m.status === "active").length;

    return {
      ok: true,
      data: {
        clerkUserId,
        email: first.email,
        fullName: [first.firstName, first.lastName].filter(Boolean).join(" ") || null,
        avatarUrl: first.avatarUrl,
        memberships,
        totalTenants: memberships.length,
        activeTenants,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to get user detail.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* UPDATE USER STATUS                                                  */
/* ------------------------------------------------------------------ */

const VALID_STATUSES = ["active", "suspended", "offboarded"] as const;

export async function updateUserStatus(input: {
  userId: string;
  tenantId: string;
  status: string;
}): Promise<PlatformResult<void>> {
  try {
    const operator = await requireCapability("tenants:suspend");

    if (!VALID_STATUSES.includes(input.status as (typeof VALID_STATUSES)[number])) {
      return { ok: false, error: "Invalid status. Use: active, suspended, or offboarded." };
    }

    const statusValue = input.status as (typeof VALID_STATUSES)[number];

    await withTenant(input.tenantId, async (tx) => {
      await tx
        .update(users)
        .set({
          status: statusValue as unknown as typeof users.status.enumValues[number],
          updatedAt: new Date(),
        })
        .where(eq(users.id, input.userId));
    });

    // ⚠️ Record in the platform audit log WITH the tenant id so the
    // customer can see the change in their own audit trail.
    await recordPlatformAudit({
      operator,
      tenantId: input.tenantId,
      action: "update",
      resourceType: "user",
      resourceId: input.userId,
      newValue: { status: input.status },
      reason: `Platform operator changed user status to ${input.status}`,
      severity: "notice",
    });

    return { ok: true, data: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update user status.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* UPDATE USER ROLE                                                    */
/* ------------------------------------------------------------------ */

const VALID_ROLES = [
  "tenant_owner",
  "tenant_admin",
  "security_admin",
  "billing_admin",
  "manager",
  "member",
  "read_only",
  "guest",
] as const;

export async function updateUserRole(input: {
  userId: string;
  tenantId: string;
  role: string;
}): Promise<PlatformResult<void>> {
  try {
    const operator = await requireCapability("tenants:configure");

    if (!VALID_ROLES.includes(input.role as (typeof VALID_ROLES)[number])) {
      return { ok: false, error: "Invalid role." };
    }

    const roleValue = input.role as (typeof VALID_ROLES)[number];

    await withTenant(input.tenantId, async (tx) => {
      await tx
        .update(users)
        .set({
          role: roleValue as unknown as typeof users.role.enumValues[number],
          updatedAt: new Date(),
        })
        .where(eq(users.id, input.userId));
    });

    await recordPlatformAudit({
      operator,
      tenantId: input.tenantId,
      action: "update",
      resourceType: "user",
      resourceId: input.userId,
      newValue: { role: input.role },
      reason: `Platform operator changed user role to ${input.role}`,
      severity: "notice",
    });

    return { ok: true, data: undefined };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update user role.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* LIST ALL TENANTS (for the filter dropdown)                          */
/* ------------------------------------------------------------------ */

export async function listAllTenantsForFilter(): Promise<
  PlatformResult<Array<{ id: string; name: string; slug: string }>>
> {
  try {
    await requireCapability("tenants:read");

    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
      })
      .from(tenants)
      .where(and(eq(tenants.status, "active"), isNull(tenants.deletedAt)))
      .orderBy(asc(tenants.name))
      .limit(500);

    return { ok: true, data: rows };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to list tenants.",
    };
  }
}
