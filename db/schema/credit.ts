/**
 * Ordence — Credit limits and approval limits
 * Version: v0.89.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NULL IS NOT ZERO, AND THE DIFFERENCE IS A CUSTOMER'S ENTIRE TRADE
 * ══════════════════════════════════════════════════════════════════════
 * `creditLimitMinor` NULL  = no limit has been set. Blocks nothing. This
 *                            is the default state for every customer.
 * `creditLimitMinor` 0     = blocked. Every order routes to approval,
 *                            whatever the amount.
 *
 * The same rule governs `maxValueMinor` on approval limits: NULL means
 * unlimited for that scope, not "may approve nothing".
 *
 * A migration or a query that treats NULL as zero stops a customer
 * ordering overnight, and nobody will look at the credit table first
 * because nobody set a limit there.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { SystemRole } from "./core";
import { companies } from "./crm";
import { tenants, users } from "./core";

/**
 * What a customer may owe before an order needs a human.
 *
 * One row per (tenant, company). The absence of a row means the same as a
 * row with a NULL limit — no ceiling — so nothing has to be seeded for
 * existing customers.
 */
export const customerCreditProfiles = pgTable(
  "customer_credit_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    /**
     * ⚠️ NULL = unlimited. 0 = blocked. See the file header.
     *
     * `mode: "bigint"` matches all 251 other money columns in this schema.
     * A money column in `mode: "number"` cannot be compared or added to one
     * in `mode: "bigint"` without a cast, and the first thing this column
     * does is get compared against invoice and order totals.
     */
    creditLimitMinor: bigint("credit_limit_minor", { mode: "bigint" }),

    /** Net terms. NULL = whatever the tenant's default policy says. */
    paymentTermsDays: integer("payment_terms_days"),

    /**
     * ⚠️ A HOLD IS NOT A ZERO LIMIT.
     *
     * Zero is a credit decision. A hold is an operational one — a cheque
     * bounced, a dispute is open — and it is meant to be lifted. Keeping
     * them separate means lifting a hold does not require remembering
     * what the limit used to be.
     */
    onHold: boolean("on_hold").notNull().default(false),
    holdReason: text("hold_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /** Names match the constraint 0048 creates. A diff between the two is a lie. */
    tenantCompanyUnique: uniqueIndex("customer_credit_profiles_tenant_company_key").on(
      t.tenantId,
      t.companyId,
    ),
    tenantIdx: index("customer_credit_profiles_tenant_idx").on(t.tenantId),
  }),
);

/**
 * What a role may approve, and up to what value.
 *
 * ⚠️ SCOPE IS A varchar, NOT AN ENUM, ON PURPOSE.
 *
 * Adding a scope to an enum is a type migration and a deploy. Adding one
 * here is a row. The set of things a business wants an approval ladder for
 * grows with the business, and it should not need us.
 *
 * Current scopes: 'sales_order' | 'discount_pct' | 'purchase_order' | 'write_off'
 */
export const approvalLimits = pgTable(
  "approval_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * 🔴 THE SystemRole ENUM VALUE AS TEXT — "billing_admin", "manager".
     *    NOT a foreign key to the `roles` table.
     *
     * The `roles` table exists in the schema and nothing in this codebase
     * reads it. Permissions resolve from `users.role`, which is the
     * `system_role` enum, through ROLE_TEMPLATES in `./auth`. A limit
     * keyed on `roles.id` could never be matched to a live session — it
     * would grant nobody anything while the settings screen showed a
     * fully configured approval ladder, which is worse than no ladder.
     *
     * ⚠️ AND NOT THE ENUM TYPE, for the same reason `scope` is a varchar:
     * adding a role would become a type migration. `permissionDenials
     * .actorRole` already stores a role this way.
     */
    role: varchar("role", { length: 60 }).$type<SystemRole>().notNull(),

    scope: varchar("scope", { length: 40 }).notNull(),

    /** ⚠️ NULL = unlimited for this scope. Not "may approve nothing". */
    maxValueMinor: bigint("max_value_minor", { mode: "bigint" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantRoleScopeUnique: uniqueIndex("approval_limits_tenant_role_scope_key").on(
      t.tenantId,
      t.role,
      t.scope,
    ),
    tenantRoleIdx: index("approval_limits_tenant_role_idx").on(t.tenantId, t.role),
  }),
);

export type CustomerCreditProfile = typeof customerCreditProfiles.$inferSelect;
export type ApprovalLimit = typeof approvalLimits.$inferSelect;
