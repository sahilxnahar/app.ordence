/**
 * Ordence — ⭐⭐⭐ THE CONTROL PLANE'S OWN CONTROLS
 * Version: v1.22.0-alpha
 *
 * Mirrors `SQL-FILES/0074_platform_control.sql`. The reasoning lives
 * there.
 *
 * 🔴 NO TENANT POLICY ON ANY OF THESE, and that is correct rather than
 * an omission. They are PLATFORM tables reached only through
 * `withPlatformScope`, which `requireCapability` already guards. A
 * tenant policy on a table with no tenant would be decoration.
 */

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants } from "./core";
import { platformStaff } from "./platform";

export const platformApprovalQueue = pgTable(
  "platform_approval_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    actionKind: varchar("action_kind", { length: 60 }).notNull(),
    targetType: varchar("target_type", { length: 40 }).notNull(),
    targetId: uuid("target_id"),
    /**
     * ⭐ Frozen at request time. A queue row saying "suspend 3f2a..." is
     * a row nobody can approve safely, and looking the name up later
     * shows today's name rather than the one the requester saw.
     */
    targetLabel: varchar("target_label", { length: 200 }).notNull(),

    proposedBefore: jsonb("proposed_before"),
    proposedAfter: jsonb("proposed_after").notNull().default({}),
    /** The validated arguments, replayed verbatim on approval. */
    payload: jsonb("payload").notNull().default({}),

    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => platformStaff.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /** 🔴 Twenty characters minimum, enforced in 0074. */
    justification: text("justification").notNull(),
    requiredGrade: varchar("required_grade", { length: 20 }).notNull(),

    status: varchar("status", { length: 20 }).default("pending").notNull(),
    approverId: uuid("approver_id").references(() => platformStaff.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),

    /** ⚠️ A queue with three-week-old items is a queue nobody reads. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    executedAt: timestamp("executed_at", { withTimezone: true }),
    executionError: varchar("execution_error", { length: 1000 }),

    /**
     * ⭐ Named rather than hidden. Permitted while Ordence has one
     * operator, costs a fifteen minute wait, and is flagged everywhere
     * so an auditor can count them.
     */
    selfApproved: boolean("self_approved").default(false).notNull(),
  },
  (t) => ({
    pendingIdx: index("platform_approval_pending_idx").on(t.status, t.requestedAt),
    targetIdx: index("platform_approval_target_idx").on(t.targetType, t.targetId),
  }),
);

export const platformEntitlementHistory = pgTable(
  "platform_entitlement_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    flagKey: varchar("flag_key", { length: 120 }).notNull(),
    /**
     * ⚠️ NULL WHERE THE FLAG DID NOT EXIST. That is different from
     * false, and collapsing them makes a revert create a row that was
     * never there.
     */
    beforeEnabled: boolean("before_enabled"),
    afterEnabled: boolean("after_enabled").notNull(),

    changedBy: uuid("changed_by").references(() => platformStaff.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    reason: text("reason"),

    /** ⭐ A revert is a new row, never a deletion. */
    revertsId: uuid("reverts_id"),

    /** 🔴 Written after a fresh read. See lib/platform/entitlement-diff.ts. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedOk: boolean("verified_ok"),
    verifyNote: varchar("verify_note", { length: 500 }),
  },
  (t) => ({
    tenantIdx: index("platform_entitlement_history_tenant_idx").on(
      t.tenantId,
      t.changedAt,
    ),
  }),
);

export const tenantHealthEvents = pgTable(
  "tenant_health_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    ruleKey: varchar("rule_key", { length: 60 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    headline: varchar("headline", { length: 300 }).notNull(),
    /** ⭐ Frozen at detection. The advice an operator was actually given. */
    whatToDo: text("what_to_do").notNull().default(""),

    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => platformStaff.id, { onDelete: "set null" }),
    /** ⚠️ Mandatory on resolve. 0074 enforces at least ten characters. */
    resolutionNote: text("resolution_note"),
  },
  (t) => ({
    /** ⭐ One open event per rule, or the dashboard becomes a wall. */
    onePerRule: uniqueIndex("tenant_health_one_open_per_rule").on(
      t.tenantId,
      t.ruleKey,
    ),
    openIdx: index("tenant_health_open_idx").on(t.severity, t.detectedAt),
  }),
);

export const platformIncidents = pgTable(
  "platform_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reference: varchar("reference", { length: 20 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull(),

    /** Null means every workspace. A filter, because the set changes. */
    affectedFilter: jsonb("affected_filter"),

    declaredBy: uuid("declared_by")
      .notNull()
      .references(() => platformStaff.id, { onDelete: "restrict" }),
    declaredAt: timestamp("declared_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => platformStaff.id, { onDelete: "set null" }),

    summary: text("summary"),
    /** ⭐ Assembled from the tagged actions rather than from memory. */
    postmortem: text("postmortem"),
  },
  (t) => ({
    referenceKey: uniqueIndex("platform_incidents_reference_key").on(t.reference),
    openIdx: index("platform_incidents_open_idx").on(t.declaredAt),
  }),
);

export const platformApprovalQueueRelations = relations(
  platformApprovalQueue,
  ({ one }) => ({
    requester: one(platformStaff, {
      fields: [platformApprovalQueue.requestedBy],
      references: [platformStaff.id],
    }),
  }),
);

export const tenantHealthEventsRelations = relations(tenantHealthEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tenantHealthEvents.tenantId],
    references: [tenants.id],
  }),
}));

export type PlatformApproval = typeof platformApprovalQueue.$inferSelect;
export type EntitlementHistoryRow = typeof platformEntitlementHistory.$inferSelect;
export type TenantHealthEvent = typeof tenantHealthEvents.$inferSelect;
export type PlatformIncident = typeof platformIncidents.$inferSelect;
