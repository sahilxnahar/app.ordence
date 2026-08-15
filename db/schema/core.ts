/**
 * Ordence — Core Multi-Tenant Schema
 * Version: v0.1.0-alpha
 *
 * DESIGN PRINCIPLE (Blueprint: "Absolute Zero-Bleed Data Architecture"):
 * Every tenant-owned table carries a non-nullable `tenantId` and is protected by
 * PostgreSQL Row-Level Security. Tenant context is set per-transaction via
 * `set_config('app.current_tenant_id', ...)`. Application code must NEVER be the
 * only thing enforcing isolation — the database is the second, independent layer.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  primaryKey,
  inet,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const planTierEnum = pgEnum("plan_tier", [
  "trial",
  "basic",
  "advanced",
  "ai",
  "enterprise",
]);

export const tenantStatusEnum = pgEnum("tenant_status", [
  "pending",
  "active",
  "suspended",
  "archived",
  "pending_deletion",
]);

export const userStatusEnum = pgEnum("user_status", [
  "invited",
  "active",
  "suspended",
  "offboarded",
]);

export const systemRoleEnum = pgEnum("system_role", [
  "platform_super_admin",
  "tenant_owner",
  "tenant_admin",
  "security_admin",
  "billing_admin",
  "manager",
  "member",
  "read_only",
  "guest",
]);

export const auditActionEnum = pgEnum("audit_action", [
  "create",
  "read",
  "update",
  "delete",
  "login",
  "logout",
  "login_failed",
  "permission_change",
  "role_change",
  "export",
  "impersonate",
  "config_change",
  "security_event",
]);

/* ------------------------------------------------------------------ */
/* TENANTS  (the root of every isolation boundary)                     */
/* ------------------------------------------------------------------ */

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Clerk Organization ID — the external identity anchor. */
    clerkOrgId: varchar("clerk_org_id", { length: 255 }).notNull(),

    /** URL-safe identifier used for `slug.app.ordence.com` routing. */
    slug: varchar("slug", { length: 63 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    legalName: varchar("legal_name", { length: 255 }),

    /** Optional fully-qualified custom domain, e.g. crm.acme.com */
    customDomain: varchar("custom_domain", { length: 253 }),
    customDomainVerifiedAt: timestamp("custom_domain_verified_at", { withTimezone: true }),

    /** White-label branding. Shape validated by Zod at the edge (lib/validators). */
    branding: jsonb("branding")
      .$type<{
        logoUrl?: string;
        bannerUrl?: string;
        faviconUrl?: string;
        primaryColor?: string;
        accentColor?: string;
        fontFamily?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Free-form tenant configuration (timezone, currency, locale, feature prefs). */
    settings: jsonb("settings")
      .$type<{
        timezone?: string;
        currency?: string;
        country?: string;
        locale?: string;
        dateFormat?: string;
        requireMfa?: boolean;
        sessionIdleMinutes?: number;
        /** Which vertical template drives navigation and vocabulary. */
        industry?: string;
        fiscalYearStartMonth?: number;
        /**
         * Tax identity used on every invoice we issue to this tenant
         * (Phase 11). Held here rather than in a table of its own: it is
         * one small object per tenant, read on every invoice render, and
         * it is exactly what this column is for.
         *
         * ⚠️ Writers MUST merge into the existing settings object rather
         * than replacing it — several forms across Phases 7 and 11 write
         * to this one column, and a replace silently erases the others.
         */
        billingProfile?: {
          gstin?: string | null;
          placeOfSupplyCode?: string;
          addressLine1?: string;
          addressLine2?: string | null;
          city?: string;
          state?: string;
          postalCode?: string;
          country?: string;
          billingEmail?: string;
        };
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    planTier: planTierEnum("plan_tier").default("trial").notNull(),
    status: tenantStatusEnum("status").default("pending").notNull(),

    /** Hard capacity limits enforced by middleware before any write. */
    seatLimit: integer("seat_limit").default(5).notNull(),
    storageLimitMb: integer("storage_limit_mb").default(512).notNull(),

    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /** Soft-delete lifecycle (Blueprint: "Universal Soft Delete Framework"). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
    deleteReason: text("delete_reason"),
  },
  (t) => ({
    slugUnique: uniqueIndex("tenants_slug_unique").on(t.slug),
    clerkOrgUnique: uniqueIndex("tenants_clerk_org_unique").on(t.clerkOrgId),
    // Partial unique: two tenants may both have NULL domain, but never the same domain.
    customDomainUnique: uniqueIndex("tenants_custom_domain_unique")
      .on(t.customDomain)
      .where(sql`${t.customDomain} IS NOT NULL`),
    statusIdx: index("tenants_status_idx").on(t.status),
  }),
);

/* ------------------------------------------------------------------ */
/* USERS                                                               */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Clerk user ID — authentication is delegated, never stored locally. */
    clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull(),

    email: varchar("email", { length: 320 }).notNull(),
    firstName: varchar("first_name", { length: 100 }),
    lastName: varchar("last_name", { length: 100 }),
    avatarUrl: text("avatar_url"),

    role: systemRoleEnum("role").default("member").notNull(),
    department: varchar("department", { length: 120 }),
    jobTitle: varchar("job_title", { length: 120 }),

    status: userStatusEnum("status").default("invited").notNull(),

    /** Per-user overrides layered on top of role permissions. */
    permissionOverrides: jsonb("permission_overrides")
      .$type<Record<string, boolean>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    // A Clerk identity maps to at most one record PER TENANT (same human may
    // legitimately belong to several tenants).
    clerkPerTenantUnique: uniqueIndex("users_clerk_tenant_unique").on(t.clerkUserId, t.tenantId),
    emailPerTenantUnique: uniqueIndex("users_email_tenant_unique").on(t.email, t.tenantId),
    tenantIdx: index("users_tenant_idx").on(t.tenantId),
    tenantStatusIdx: index("users_tenant_status_idx").on(t.tenantId, t.status),
  }),
);

/* ------------------------------------------------------------------ */
/* RBAC — ROLES, PERMISSIONS, ASSIGNMENTS                              */
/* ------------------------------------------------------------------ */

/**
 * Permission catalogue. Global (not tenant-scoped) — it is a definition table,
 * contains no customer data, and is seeded by the platform.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Canonical form: "resource:action" e.g. "contacts:delete" */
    key: varchar("key", { length: 120 }).notNull(),
    resource: varchar("resource", { length: 60 }).notNull(),
    action: varchar("action", { length: 60 }).notNull(),
    description: text("description"),
    /** Minimum plan tier that unlocks this permission. */
    minPlanTier: planTierEnum("min_plan_tier").default("basic").notNull(),
    isDangerous: boolean("is_dangerous").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex("permissions_key_unique").on(t.key),
    resourceIdx: index("permissions_resource_idx").on(t.resource),
  }),
);

/**
 * Tenant-defined custom roles. System roles live in the `system_role` enum;
 * this table lets each tenant compose additional roles on top.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    /** Roles marked system cannot be edited or deleted by tenant admins. */
    isSystem: boolean("is_system").default(false).notNull(),
    /** Optional inheritance — this role absorbs its parent's permissions. */
    inheritsFromRoleId: uuid("inherits_from_role_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    namePerTenantUnique: uniqueIndex("roles_name_tenant_unique").on(t.tenantId, t.name),
    tenantIdx: index("roles_tenant_idx").on(t.tenantId),
  }),
);

/** Join table: which permissions a role grants. */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    /** Denormalised for RLS — lets the policy filter without a join. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    grantedBy: uuid("granted_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
    tenantIdx: index("role_permissions_tenant_idx").on(t.tenantId),
  }),
);

/** Join table: which roles a user holds. */
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Time-boxed elevation (Blueprint: "Temporary permissions"). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    assignedBy: uuid("assigned_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roleId] }),
    tenantIdx: index("user_roles_tenant_idx").on(t.tenantId),
    userIdx: index("user_roles_user_idx").on(t.userId),
  }),
);

/* ------------------------------------------------------------------ */
/* AUDIT LOGS  (append-only)                                           */
/* ------------------------------------------------------------------ */

/**
 * Immutable audit trail. A database trigger blocks UPDATE and DELETE outright
 * (see `0001_rls_and_audit.sql`) so the table is append-only at the engine level,
 * not merely by convention.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Nullable ONLY for platform-level events that precede tenant resolution. */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),

    actorUserId: uuid("actor_user_id"),
    actorClerkId: varchar("actor_clerk_id", { length: 255 }),
    actorEmail: varchar("actor_email", { length: 320 }),
    actorRole: varchar("actor_role", { length: 60 }),

    action: auditActionEnum("action").notNull(),
    resourceType: varchar("resource_type", { length: 100 }).notNull(),
    resourceId: varchar("resource_id", { length: 255 }),

    /** Before/after snapshots. Sensitive fields are redacted before write. */
    oldValue: jsonb("old_value").$type<Record<string, unknown> | null>(),
    newValue: jsonb("new_value").$type<Record<string, unknown> | null>(),

    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    country: varchar("country", { length: 2 }),
    sessionId: varchar("session_id", { length: 255 }),
    requestId: varchar("request_id", { length: 255 }),
    correlationId: varchar("correlation_id", { length: 255 }),

    reason: text("reason"),
    /** Set when the action was performed under support impersonation. */
    impersonationId: uuid("impersonation_id"),

    /**
     * Free-form structured context for the event (v0.5.0).
     * Kept separate from oldValue/newValue: those describe the RECORD that
     * changed; this describes the CIRCUMSTANCE — period id, contract version,
     * transaction total, permission checked, and so on.
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Event severity, so security review can filter noise from signal. */
    severity: varchar("severity", { length: 20 }).default("info").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /* ---------------------------------------------------------------- */
    /* THE HASH CHAIN — SQL-FILES/0081_audit_hash_chain.sql (Batch 44)   */
    /* ---------------------------------------------------------------- */
    /**
     * ⚠️ ALL FOUR ARE NULLABLE, AND THAT IS THE DESIGN, NOT AN OVERSIGHT.
     * Two populations carry NULLs and they mean different things:
     *
     *   • every row written BEFORE 0081. There is no honest hash to give
     *     them — see constraint 4 in `lib/audit/chain.ts`. They are not
     *     backfilled, and the verifier reports "chain starts at row X"
     *     rather than pretending the history is attested.
     *   • a row whose chaining DEGRADED at write time (repeated
     *     `23505` under contention, or a read of the head that failed).
     *     `server/audit.ts` writes the row anyway, unchained, because an
     *     audit row present but outside the chain beats no audit row.
     *
     * A CHECK constraint in 0081 makes "all four NULL" and "all four set,
     * bar `prevHash` at the genesis row" the ONLY permitted states, so a
     * half-hashed row means somebody wrote to this table outside the
     * application.
     */
    /** Dense, 1-based, per `tenantId`. UNIQUE with it. Never reused. */
    chainSeq: bigint("chain_seq", { mode: "number" }),
    /** `rowHash` of `chainSeq - 1` in the same tenant. NULL at genesis. */
    prevHash: text("prev_hash"),
    /** SHA-256 of this row's canonical content. Checkable only in TS. */
    contentHash: text("content_hash"),
    /** SHA-256 of (domain, scope, seq, prevHash, contentHash). Checkable in SQL. */
    rowHash: text("row_hash"),
  },
  (t) => ({
    tenantCreatedIdx: index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    actorIdx: index("audit_logs_actor_idx").on(t.actorUserId),
    resourceIdx: index("audit_logs_resource_idx").on(t.resourceType, t.resourceId),
    actionIdx: index("audit_logs_action_idx").on(t.action),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  roles: many(roles),
  auditLogs: many(auditLogs),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
  userRoles: many(userRoles),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  tenant: one(tenants, { fields: [roles.tenantId], references: [tenants.id] }),
  rolePermissions: many(rolePermissions),
  userRoles: many(userRoles),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  tenant: one(tenants, { fields: [auditLogs.tenantId], references: [tenants.id] }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type SystemRole = (typeof systemRoleEnum.enumValues)[number];

/**
 * The role values as a plain tuple, for Zod and anything else that needs
 * the list at runtime rather than at type level.
 *
 * ⚠️ DERIVED FROM THE ENUM, NEVER RETYPED. A hand-written copy diverges
 * the day a role is added, and the divergence presents as a validator
 * rejecting a role the database accepts — which reads as a bug in the
 * form rather than in the list.
 */
export const SYSTEM_ROLE_VALUES = systemRoleEnum.enumValues;
export type PlanTier = (typeof planTierEnum.enumValues)[number];
