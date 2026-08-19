/**
 * Ordence — Core CRM Entities
 * Version: v0.2.0-alpha
 *
 * ISOLATION CONTRACT: every table here carries a non-nullable `tenantId` with a
 * cascading FK to `tenants`. Composite indexes are deliberately led by `tenant_id`
 * so the planner can prune by tenant before doing anything else — this is both a
 * performance and a safety property.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  integer,
  numeric,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const dealStageEnum = pgEnum("deal_stage", [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
]);

export const companySizeEnum = pgEnum("company_size", [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5000+",
]);

/** Shape of the free-form `custom_fields` column on every CRM entity. */
export type CustomFieldValues = Record<string, string | number | boolean | null>;

/* ------------------------------------------------------------------ */
/* COMPANIES                                                           */
/* ------------------------------------------------------------------ */

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 255 }).notNull(),
    /** Primary web domain — also the natural dedupe key during imports. */
    domain: varchar("domain", { length: 253 }),
    industry: varchar("industry", { length: 120 }),
    employeeCount: integer("employee_count"),
    companySize: companySizeEnum("company_size"),

    website: varchar("website", { length: 512 }),
    phone: varchar("phone", { length: 40 }),
    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 120 }),
    postalCode: varchar("postal_code", { length: 20 }),
    country: varchar("country", { length: 2 }),

    /** Tenant-defined extra fields, validated against custom_field_definitions. */
    customFields: jsonb("custom_fields")
      .$type<CustomFieldValues>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("companies_tenant_idx").on(t.tenantId),
    tenantNameIdx: index("companies_tenant_name_idx").on(t.tenantId, t.name),
    // Same domain may exist across different tenants — uniqueness is per-tenant only.
    tenantDomainUnique: uniqueIndex("companies_tenant_domain_unique")
      .on(t.tenantId, t.domain)
      .where(sql`${t.domain} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    ownerIdx: index("companies_owner_idx").on(t.tenantId, t.ownerId),
    customFieldsIdx: index("companies_custom_fields_gin").using("gin", t.customFields),
  }),
);

/* ------------------------------------------------------------------ */
/* CONTACTS                                                            */
/* ------------------------------------------------------------------ */

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),

    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    mobile: varchar("mobile", { length: 40 }),
    jobTitle: varchar("job_title", { length: 150 }),
    department: varchar("department", { length: 120 }),

    linkedinUrl: varchar("linkedin_url", { length: 512 }),

    customFields: jsonb("custom_fields")
      .$type<CustomFieldValues>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("contacts_tenant_idx").on(t.tenantId),
    tenantCompanyIdx: index("contacts_tenant_company_idx").on(t.tenantId, t.companyId),
    tenantEmailUnique: uniqueIndex("contacts_tenant_email_unique")
      .on(t.tenantId, t.email)
      .where(sql`${t.email} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    tenantNameIdx: index("contacts_tenant_name_idx").on(t.tenantId, t.lastName, t.firstName),
    ownerIdx: index("contacts_owner_idx").on(t.tenantId, t.ownerId),
    customFieldsIdx: index("contacts_custom_fields_gin").using("gin", t.customFields),
  }),
);

/* ------------------------------------------------------------------ */
/* DEALS                                                               */
/* ------------------------------------------------------------------ */

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),

    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),

    /**
     * NUMERIC, not float. Money in binary floating point accumulates rounding
     * error — unacceptable in a system that will drive invoices.
     */
    amount: numeric("amount", { precision: 15, scale: 2 }),
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    stage: dealStageEnum("stage").default("lead").notNull(),
    probability: integer("probability").default(0).notNull(),

    expectedCloseDate: date("expected_close_date"),
    actualCloseDate: date("actual_close_date"),

    lostReason: text("lost_reason"),
    source: varchar("source", { length: 120 }),

    customFields: jsonb("custom_fields")
      .$type<CustomFieldValues>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => ({
    tenantIdx: index("deals_tenant_idx").on(t.tenantId),
    tenantStageIdx: index("deals_tenant_stage_idx").on(t.tenantId, t.stage),
    tenantContactIdx: index("deals_tenant_contact_idx").on(t.tenantId, t.contactId),
    tenantCompanyIdx: index("deals_tenant_company_idx").on(t.tenantId, t.companyId),
    closeDateIdx: index("deals_close_date_idx").on(t.tenantId, t.expectedCloseDate),
    ownerIdx: index("deals_owner_idx").on(t.tenantId, t.ownerId),
    customFieldsIdx: index("deals_custom_fields_gin").using("gin", t.customFields),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const companiesRelations = relations(companies, ({ one, many }) => ({
  tenant: one(tenants, { fields: [companies.tenantId], references: [tenants.id] }),
  owner: one(users, { fields: [companies.ownerId], references: [users.id] }),
  contacts: many(contacts),
  deals: many(deals),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  tenant: one(tenants, { fields: [contacts.tenantId], references: [tenants.id] }),
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  owner: one(users, { fields: [contacts.ownerId], references: [users.id] }),
  deals: many(deals),
}));

export const dealsRelations = relations(deals, ({ one }) => ({
  tenant: one(tenants, { fields: [deals.tenantId], references: [tenants.id] }),
  contact: one(contacts, { fields: [deals.contactId], references: [contacts.id] }),
  company: one(companies, { fields: [deals.companyId], references: [companies.id] }),
  owner: one(users, { fields: [deals.ownerId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
export type DealStage = (typeof dealStageEnum.enumValues)[number];
export type CompanySize = (typeof companySizeEnum.enumValues)[number];
