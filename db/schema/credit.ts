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
  date,
  index,
  integer,
  pgEnum,
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
import { salesOrders } from "./orders";
import { salesInvoices } from "./sales-invoices";

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

    /**
     * 🔴 v1.46.0 (0083) — READ-ONLY FROM THE APPLICATION'S POINT OF VIEW.
     *
     * `onHold` and `holdReason` above are now a MIRROR of
     * `creditHoldEvents`, maintained by the `credit_hold_events_mirror`
     * trigger in 0083. They are kept because every screen, export and
     * query written before 0083 reads them, and dropping them would have
     * broken `assessCredit()` and two screens in the same deploy that
     * introduced the refusal — which is how a safety feature gets
     * reverted in week one.
     *
     * ⚠️ NOTHING MAY WRITE THEM DIRECTLY ANY MORE. Place a hold by
     * inserting a `creditHoldEvents` row; lift one by setting its
     * `releasedAt`. A direct write here is silently reverted by the next
     * hold event on that customer, which is the worst possible failure
     * mode: it works in testing and drifts in production.
     */

    /**
     * ⭐ MAY THE SWEEP PLACE AN AUTOMATIC HOLD ON THIS CUSTOMER?
     *
     * Off by default, and that is a decision rather than caution — see
     * the column comment in 0083. Turning it on for every existing
     * customer at migration time would stop trading with everybody who
     * is over an aspirational limit somebody typed eighteen months ago,
     * and the workspace would experience the upgrade as an outage.
     */
    autoHoldEnabled: boolean("auto_hold_enabled").notNull().default(false),

    /**
     * Which dunning ladder chases this customer's overdue invoices.
     * NULL = the tenant's default ladder, and if there is no default,
     * this customer is not dunned. Not "dunned on some built-in
     * schedule" — see the tail of 0083.
     */
    dunningLadderId: uuid("dunning_ladder_id"),

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

/* ================================================================== */
/* 🔴 BATCH 40 (0083) — THE HOLD AS AN EVENT, AND THE DUNNING LADDER    */
/* ================================================================== */

/**
 * ⭐ HOW A HOLD CAME TO EXIST. One table, two sources.
 *
 * ⚠️ `automatic` HOLDS ARE PLACED BY THE SWEEP AND LIFTED ONLY BY A
 * HUMAN. A hold that lifts itself the moment a receipt lands is a hold
 * nobody ever has to look at, and the reason it was placed — a bounced
 * cheque, a customer who pays only when chased — outlives the arithmetic
 * that noticed it. `lib/credit/hold.ts` states this as a constant and
 * the tests assert it.
 */
export const creditHoldSourceEnum = pgEnum("credit_hold_source", [
  "manual",
  "automatic",
]);

/**
 * 🔴 WHERE A QUEUED REMINDER GOT TO. Every row in this batch is written
 * `queued` and NOTHING IN THIS BATCH MOVES IT TO `sent` — there is no
 * SMTP call, no Resend call, no webhook. See the header of
 * `lib/credit/dunning.ts`.
 *
 * `suppressed` is not a failure. It is "we decided not to send this
 * one", which a collections team needs to be able to say without
 * deleting the row and losing the reason.
 */
export const creditDunningDeliveryEnum = pgEnum("credit_dunning_delivery", [
  "queued",
  "sent",
  "failed",
  "suppressed",
]);

/**
 * ⚠️ A SEPARATE TYPE FROM 0038'S `dunning_channel`, ON PURPOSE. That
 * ladder chases a RERA milestone demand raised against a unit booking,
 * whose counterparty is a lead; this one chases a tax invoice, whose
 * counterparty is a company. The two must be free to diverge — and
 * `visit` is here because an Indian collections ladder ends in a person.
 */
export const creditDunningChannelEnum = pgEnum("credit_dunning_channel", [
  "email",
  "sms",
  "whatsapp",
  "call",
  "letter",
  "visit",
]);

/**
 * One row per hold. Not one row per customer.
 *
 * 🔴 `releasedAt IS NULL` IS THE DEFINITION OF "ON HOLD". There is
 * deliberately no `isActive` boolean: a boolean and a timestamp that
 * must always agree is two facts where there is one, and the day they
 * disagree the customer is both held and not held depending on which
 * query ran.
 *
 * ⚠️ AT MOST ONE UNRELEASED ROW PER CUSTOMER, enforced by a PARTIAL
 * unique index in 0083 that Drizzle cannot express. It is not decoration
 * — it is the whole of the idempotency guarantee for the automatic
 * sweep. `INSERT ... ON CONFLICT DO NOTHING` against it is a no-op on
 * the second run and on the two-hundredth. A TypeScript `if (!existing)`
 * cannot make that promise across two containers.
 */
export const creditHoldEvents = pgTable(
  "credit_hold_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    source: creditHoldSourceEnum("source").notNull(),

    /**
     * 🔴 NOT NULL, minimum four characters, checked by a CHECK constraint
     * in 0083 and not only by Zod. An unexplained hold becomes a phone
     * call to somebody who does not know the answer. The automatic sweep
     * writes a sentence too — it has the figures, so it can say
     * "exposure ₹8,40,000 against a limit of ₹5,00,000".
     */
    reason: text("reason").notNull(),

    placedAt: timestamp("placed_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ⚠️ NULLABLE, AND ONLY FOR `automatic`. A CHECK constraint makes a
     * manual hold with no actor impossible. The sweep has no user, and
     * inventing one — "system", the tenant owner, whoever last logged in
     * — would put a real person's name on a decision they did not make.
     * That is exactly the `approvedBy` bug `confirmOrder` shipped in
     * Phase 47 and had to be fixed for in v0.89.0.
     */
    placedBy: uuid("placed_by").references(() => users.id, { onDelete: "set null" }),

    /**
     * ⭐ THE FIGURES AS THEY STOOD, IN PAISE. Recomputing them at read
     * time answers a different question — what the customer owes TODAY —
     * and "why was this hold placed" is not answerable from today.
     */
    exposureAtHoldMinor: bigint("exposure_at_hold_minor", { mode: "bigint" }),
    limitAtHoldMinor: bigint("limit_at_hold_minor", { mode: "bigint" }),

    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
    releaseReason: text("release_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantKey: uniqueIndex("credit_hold_events_id_tenant_key").on(t.id, t.tenantId),
    companyIdx: index("credit_hold_events_company_idx").on(
      t.tenantId,
      t.companyId,
      t.placedAt,
    ),
  }),
);

/**
 * Why ONE order went out past a hold.
 *
 * 🔴 AN OVERRIDE IS A DOCUMENT, NOT A BOOLEAN. Without this table the
 * only way past a hold is to lift it, confirm, and put it back — three
 * writes that leave a record saying the customer was not on hold at the
 * moment the order went out, which is false, and which is what everybody
 * actually does when there is no override.
 *
 * ⚠️ APPEND-ONLY BY TRIGGER except `consumedAt`, and `consumedAt` may
 * only go from NULL to a value. An override whose `reason` can be edited
 * afterwards is an override whose reason is whatever it needed to be by
 * the time anybody looked, and the edit leaves no trace.
 */
export const creditHoldOverrides = pgTable(
  "credit_hold_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    /**
     * 🔴 ONE ORDER. NOT NULL. Unique per (tenant, order) in 0083, so one
     * signature can never release a second order. A blanket override is
     * a lifted hold wearing a different name, and lifting a hold is a
     * different act with a different permission and audit severity.
     */
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),

    holdEventId: uuid("hold_event_id").references(() => creditHoldEvents.id, {
      onDelete: "set null",
    }),

    /**
     * 🔴 NOT NULL, ON DELETE RESTRICT, AND THE RESTRICT IS THE POINT.
     * Everywhere else in this schema an actor column is `set null`,
     * because losing the name of whoever edited a note is acceptable. An
     * override with no actor is exactly the boolean flip this table
     * exists to replace: it says an order went out past a hold and
     * nobody did it.
     */
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /**
     * 🔴 IN THE ACTOR'S OWN WORDS, minimum eight characters, enforced in
     * the database. A dropdown of reason codes would be tidier and would
     * lose "Mr Shah has confirmed the RTGS, UTR quoted, releasing
     * against it" — the sentence that decides whether this was judgement
     * or negligence when it is read back.
     */
    reason: text("reason").notNull(),

    exposureAtOverrideMinor: bigint("exposure_at_override_minor", { mode: "bigint" }),
    limitAtOverrideMinor: bigint("limit_at_override_minor", { mode: "bigint" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /** Set once, by the confirmation that used it. Never back to NULL. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("credit_hold_overrides_id_tenant_key").on(t.id, t.tenantId),
    onePerOrderKey: uniqueIndex("credit_hold_overrides_one_per_order_key").on(
      t.tenantId,
      t.orderId,
    ),
    companyIdx: index("credit_hold_overrides_company_idx").on(
      t.tenantId,
      t.companyId,
      t.createdAt,
    ),
  }),
);

/**
 * ⭐ A LADDER IS A ROW, NOT A CONSTANT. Seven days for a distributor on
 * 30-day terms and forty-five for a government department are both
 * correct, and a constant in code means the only workspaces the product
 * fits are the ones that guessed the way we did.
 */
export const creditDunningLadders = pgTable(
  "credit_dunning_ladders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 80 }).notNull(),
    description: text("description"),

    /**
     * ⚠️ INACTIVE, NOT DELETED. A ladder that has chased somebody is
     * referenced by every log row it produced; deleting it would either
     * cascade those away or leave them pointing at nothing, and both
     * destroy the answer to "what did we send them".
     */
    isActive: boolean("is_active").notNull().default(true),
    /** At most one per tenant while active — a partial unique index in 0083. */
    isDefault: boolean("is_default").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("credit_dunning_ladders_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("credit_dunning_ladders_tenant_idx").on(t.tenantId, t.isActive),
  }),
);

/**
 * One rung.
 *
 * 🔴 `daysPastDue` IS AGE PAST THE DUE DATE, NOT AGE OF THE INVOICE. An
 * invoice dated the 1st on 30-day terms is not one day overdue on the
 * 2nd. Counting from the invoice date sends a first reminder to somebody
 * inside their agreed terms, which is the fastest way to make a good
 * payer stop answering the phone.
 */
export const creditDunningStages = pgTable(
  "credit_dunning_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ladderId: uuid("ladder_id")
      .notNull()
      .references(() => creditDunningLadders.id, { onDelete: "cascade" }),

    stageNo: integer("stage_no").notNull(),
    label: varchar("label", { length: 80 }).notNull(),

    daysPastDue: integer("days_past_due").notNull(),
    channel: creditDunningChannelEnum("channel").notNull().default("email"),

    /** ⚠️ A TEMPLATE KEY, NOT A BODY. See the header of 0083. */
    templateKey: varchar("template_key", { length: 80 }),

    /**
     * ⭐ THE RUNG AT WHICH THE LADDER STOPS ASKING AND STARTS REFUSING.
     * Reaching it places an `automatic` hold — the only automatic hold
     * in the product that is not about the arithmetic of a limit. A
     * customer 90 days past due on ₹10,000 may be nowhere near their
     * limit and is still not somebody to ship to.
     */
    placesHold: boolean("places_hold").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantKey: uniqueIndex("credit_dunning_stages_id_tenant_key").on(t.id, t.tenantId),
    stageNoKey: uniqueIndex("credit_dunning_stages_no_key").on(
      t.tenantId,
      t.ladderId,
      t.stageNo,
    ),
    ageKey: uniqueIndex("credit_dunning_stages_age_key").on(
      t.tenantId,
      t.ladderId,
      t.daysPastDue,
    ),
  }),
);

/**
 * 🔴 A QUEUE AND A RECORD AT THE SAME TIME.
 *
 * ⚠️ NOTHING IN THIS BATCH SENDS ANYTHING. Rows are written with
 * `delivery = "queued"` and stay there; whatever eventually delivers
 * them writes `sent` / `failed` back. Logging `sent` at queue time would
 * produce a customer record saying a reminder went out on the 14th, a
 * customer who never received it, and a collections call that opens with
 * "we wrote to you three times" against somebody who can prove
 * otherwise.
 *
 * ⚠️ ONE ROW PER (invoice, stage), FOREVER — `credit_dunning_log_once_
 * per_stage_key` in 0083. That unique index, not a TypeScript check, is
 * what makes the sweep safe to re-run, safe to run from two containers,
 * and safe to resume after a crash.
 */
export const creditDunningLog = pgTable(
  "credit_dunning_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    /**
     * 🔴 RESTRICT, NOT CASCADE. An invoice that has been chased cannot be
     * deleted out from under its own chase record. A cancelled invoice
     * is `status = "cancelled"`, not a missing row.
     */
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => salesInvoices.id, { onDelete: "restrict" }),

    ladderId: uuid("ladder_id").references(() => creditDunningLadders.id, {
      onDelete: "set null",
    }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => creditDunningStages.id, { onDelete: "restrict" }),

    /**
     * ⭐ COPIED FROM THE STAGE AT QUEUE TIME, NOT JOINED AT READ TIME.
     * Somebody will re-tune the ladder — everybody does, once — and a
     * record that said "stage 2, 30 days" must not silently become
     * "stage 2, 45 days" for every letter ever sent under the old one.
     */
    stageNo: integer("stage_no").notNull(),
    daysPastDue: integer("days_past_due").notNull(),
    channel: creditDunningChannelEnum("channel").notNull(),
    templateKey: varchar("template_key", { length: 80 }),

    /**
     * 🔴 WHO IT WENT TO, CAPTURED. Same rule as `customerLegalName` on a
     * tax invoice: a contact who changes jobs next year must not restate
     * who we chased this year.
     */
    recipientName: varchar("recipient_name", { length: 160 }),
    recipientEmail: varchar("recipient_email", { length: 255 }),
    recipientPhone: varchar("recipient_phone", { length: 40 }),

    /** What was outstanding when the stage fired. Paise. */
    amountDueMinor: bigint("amount_due_minor", { mode: "bigint" }).notNull(),

    delivery: creditDunningDeliveryEnum("delivery").notNull().default("queued"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failureReason: text("failure_reason"),

    /**
     * 🔴 THE DATE THE NEXT STAGE BECOMES DUE, computed from the invoice's
     * due date and the next rung's age — NOT "today plus seven".
     * Deriving it at read time would make it move every time somebody
     * edited the ladder, and a collections diary that reshuffles itself
     * is a diary nobody works from. NULL means this was the last rung and
     * the next action is a human decision.
     */
    nextActionOn: date("next_action_on", { mode: "string" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idTenantKey: uniqueIndex("credit_dunning_log_id_tenant_key").on(t.id, t.tenantId),
    oncePerStageKey: uniqueIndex("credit_dunning_log_once_per_stage_key").on(
      t.tenantId,
      t.invoiceId,
      t.stageId,
    ),
    companyIdx: index("credit_dunning_log_company_idx").on(
      t.tenantId,
      t.companyId,
      t.queuedAt,
    ),
    nextActionIdx: index("credit_dunning_log_next_action_idx").on(
      t.tenantId,
      t.nextActionOn,
    ),
  }),
);

export type CustomerCreditProfile = typeof customerCreditProfiles.$inferSelect;
export type ApprovalLimit = typeof approvalLimits.$inferSelect;
export type CreditHoldEvent = typeof creditHoldEvents.$inferSelect;
export type CreditHoldOverride = typeof creditHoldOverrides.$inferSelect;
export type CreditDunningLadder = typeof creditDunningLadders.$inferSelect;
export type CreditDunningStage = typeof creditDunningStages.$inferSelect;
export type CreditDunningLogRow = typeof creditDunningLog.$inferSelect;
