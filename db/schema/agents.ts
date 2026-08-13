/**
 * Ordence — ⭐⭐⭐ AGENTS AS TENANT DATA
 * Version: v1.20.0-alpha
 *
 * Mirrors `SQL-FILES/0071_tenant_agents.sql`. The reasoning lives there.
 *
 * 🔴 THE ONE RULE TO CARRY IN YOUR HEAD: an agent with any tool is on the
 * confidential lane, and an agent that fires on a business event writes
 * text and never sends it.
 */

import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./core";

export const agentDefinitions = pgTable(
  "agent_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⭐ Which shelf item this was copied from. Null where hand-written. */
    catalogueKey: varchar("catalogue_key", { length: 80 }),

    name: varchar("name", { length: 160 }).notNull(),
    blurb: varchar("blurb", { length: 400 }),
    systemPrompt: text("system_prompt").notNull(),

    /**
     * 🔴 Names from `lib/mcp/registry.ts` and nowhere else. Validated in
     * the action at write time; the database records what was allowed
     * rather than deciding it, because it cannot read TypeScript.
     */
    tools: text("tools").array().notNull().default([]),

    /**
     * 🔴🔴 `open` may go to any free provider. `tenant` may not.
     *
     * ⚠️ 0071 carries a CHECK that any agent with a tool is `tenant`,
     * because the dangerous edit is adding a tool six months later to an
     * agent that has always been open. Nothing about that edit looks
     * alarming on screen and it starts exporting the customer list.
     */
    sensitivity: varchar("sensitivity", { length: 10 }).default("open").notNull(),

    isEnabled: boolean("is_enabled").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    catalogueOnce: uniqueIndex("agent_definitions_catalogue_once").on(
      t.tenantId,
      t.catalogueKey,
    ),
    enabledIdx: index("agent_definitions_enabled_idx").on(t.tenantId),
  }),
);

export const agentTriggers = pgTable(
  "agent_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: "cascade" }),

    /** ⚠️ The same four words as 0068's `automation_events`. */
    triggerType: varchar("trigger_type", { length: 30 }).notNull(),
    recordType: varchar("record_type", { length: 40 }).notNull(),

    isEnabled: boolean("is_enabled").default(true).notNull(),

    /**
     * ⭐ HOW MANY TIMES A DAY THIS BINDING MAY FIRE.
     *
     * 🔴 The cost is not zero even on a free provider. An agent bound to
     * `record_updated` on a busy table exhausts the day's rate limit
     * before lunch and takes every other agent down with it.
     */
    dailyCap: integer("daily_cap").default(50).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    unique: uniqueIndex("agent_triggers_unique").on(
      t.tenantId,
      t.agentId,
      t.triggerType,
      t.recordType,
    ),
    lookupIdx: index("agent_triggers_lookup_idx").on(
      t.tenantId,
      t.recordType,
      t.triggerType,
    ),
  }),
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: "cascade" }),

    /** person · event · schedule */
    startedBy: varchar("started_by", { length: 20 }).notNull(),
    /**
     * ⚠️ Null on an event run. Nobody was standing there, and writing a
     * name in would attribute something to a person who did not do it.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    eventId: uuid("event_id"),

    providerId: varchar("provider_id", { length: 40 }),
    sensitivity: varchar("sensitivity", { length: 10 }).notNull(),

    /** 🔴 A DRAFT. An event-triggered agent writes text and never sends. */
    output: text("output"),
    tokensUsed: integer("tokens_used"),
    errorMessage: varchar("error_message", { length: 500 }),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /** 🔴 DPDP: a run's output may quote somebody's data. */
    purgeAfter: date("purge_after").notNull(),
  },
  (t) => ({
    agentIdx: index("agent_runs_agent_idx").on(t.tenantId, t.agentId, t.startedAt),
    purgeIdx: index("agent_runs_purge_idx").on(t.purgeAfter),
  }),
);

export const agentDefinitionsRelations = relations(agentDefinitions, ({ many }) => ({
  triggers: many(agentTriggers),
  runs: many(agentRuns),
}));

export const agentTriggersRelations = relations(agentTriggers, ({ one }) => ({
  agent: one(agentDefinitions, {
    fields: [agentTriggers.agentId],
    references: [agentDefinitions.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  agent: one(agentDefinitions, {
    fields: [agentRuns.agentId],
    references: [agentDefinitions.id],
  }),
}));

export type AgentDefinition = typeof agentDefinitions.$inferSelect;
export type AgentTrigger = typeof agentTriggers.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
