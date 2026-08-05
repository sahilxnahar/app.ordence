/**
 * Ordence — MCP access (Batch 5)
 * Version: v0.74.0-alpha
 *
 * Mirrors `SQL-FILES/0042_mcp_access.sql`. The guarantees are THERE, not
 * here: the append-only call log, the refusal to un-revoke a token, the
 * SHA-256 format check and the tenant isolation are all triggers,
 * constraints and policies in the database, because this file is one
 * write path of several.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  char,
  timestamp,
  bigint,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * ⚠️ `read_only` IS THE DEFAULT, DELIBERATELY.
 *
 * An assistant that can only read is useful and cannot damage anything.
 * Defaulting to `read_write` would make the safe choice require an
 * action and the dangerous choice require nothing.
 */
export const mcpScopeEnum = pgEnum("mcp_scope", ["read_only", "read_write"]);

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    label: varchar("label", { length: 120 }).notNull(),

    /** ⚠️ SHA-256 hex digest. The token itself is never stored. */
    tokenHash: char("token_hash", { length: 64 }).notNull(),

    /** First characters of the token, for identification in a list. */
    tokenPrefix: varchar("token_prefix", { length: 12 }).notNull(),

    scope: mcpScopeEnum("scope").default("read_only").notNull(),

    /**
     * ⭐ The real person every call by this token is attributed to.
     * NOT NULLABLE: "the AI did it" names nobody.
     */
    actingUserId: uuid("acting_user_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    callCount: bigint("call_count", { mode: "bigint" }).default(sql`0`).notNull(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("mcp_tokens_id_tenant_key").on(t.id, t.tenantId),
    hashUnique: uniqueIndex("mcp_tokens_hash_unique").on(t.tokenHash),
    tenantIdx: index("mcp_tokens_tenant_idx").on(t.tenantId, t.revokedAt),
    hashIdx: index("mcp_tokens_hash_idx").on(t.tokenHash),
  }),
);

/**
 * ⭐ EVERY CALL, INCLUDING THE REFUSED ONES.
 *
 * ⚠️ Argument KEYS only, never argument VALUES. A tool argument can be a
 * customer's name or a contract value; storing values would make this
 * diagnostic log a second, unprotected copy of the tenant's data.
 */
export const mcpCallLog = pgTable(
  "mcp_call_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    tokenId: uuid("token_id"),
    toolName: varchar("tool_name", { length: 120 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    durationMs: integer("duration_ms"),
    /** `ok` · `refused` · `error` */
    outcome: varchar("outcome", { length: 20 }).notNull(),
    refusalReason: text("refusal_reason"),
    argumentKeys: text("argument_keys").array(),
  },
  (t) => ({
    tenantScoped: uniqueIndex("mcp_call_log_id_tenant_key").on(t.id, t.tenantId),
    tenantTimeIdx: index("mcp_call_log_tenant_time_idx").on(t.tenantId, t.occurredAt),
    outcomeIdx: index("mcp_call_log_outcome_idx").on(t.tenantId, t.outcome, t.occurredAt),
  }),
);
