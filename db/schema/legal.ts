/**
 * Ordence — ⭐⭐ LEGAL · MATTERS, LIMITATION, THE DIARY, CLIENT MONEY
 * Version: v1.7.0-alpha  ·  SQL 0058
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT A LAW FIRM HAD BEFORE THIS, AND IT WAS THREE WORDS
 * ══════════════════════════════════════════════════════════════════════
 *   matters  → /assets?type=matter   — an asset with a type field
 *   cases    → /assets?type=case     — the same asset register
 *   hearings → /calendar             — with feature: null
 *
 * ⚠️ An advocate got an ASSET CATALOGUE wearing the word "matter" and a
 * generic diary wearing the word "hearing". No limitation date anywhere,
 * no discipline about the next date, no client account. The label was
 * doing all of the work.
 *
 * 🔴 AND LIMITATION IS THE ONE DEADLINE SOFTWARE MUST NOT GET WRONG.
 * Section 3 of the Limitation Act, 1963: a suit filed after the period
 * **shall be dismissed**, "although limitation has not been set up as a
 * defence". The court raises it itself. Every other deadline in this
 * product costs money; this one costs a client their case.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { companies } from "./crm";

export const legalMatters = pgTable(
  "legal_matters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    matterNo: varchar("matter_no", { length: 40 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),

    matterType: varchar("matter_type", { length: 30 }).default("litigation").notNull(),
    ourSide: varchar("our_side", { length: 30 }),
    opposingParty: varchar("opposing_party", { length: 500 }),

    courtName: varchar("court_name", { length: 255 }),
    courtId: uuid("court_id"),
    jurisdiction: varchar("jurisdiction", { length: 120 }),
    caseNumber: varchar("case_number", { length: 120 }),
    filingDate: date("filing_date", { mode: "string" }),

    /**
     * 🔴 THE DATE LIMITATION RUNS FROM, AND IT IS NOT THE FILING DATE.
     * A contract broken on 3 April 2023 and a suit filed on 1 August
     * 2025 are two different facts, and only the first decides whether
     * the suit is competent.
     */
    causeOfActionDate: date("cause_of_action_date", { mode: "string" }),
    limitationArticle: varchar("limitation_article", { length: 40 }),
    limitationDays: integer("limitation_days"),
    /**
     * ⭐ COMPUTED AND STORED — after s.12 exclusion and s.4 roll-forward.
     * Stored because it is the figure somebody diarised and acted on.
     */
    limitationExpiresOn: date("limitation_expires_on", { mode: "string" }),
    limitationNote: text("limitation_note"),

    responsibleUserId: uuid("responsible_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 20 }).default("open").notNull(),
    closedOn: date("closed_on", { mode: "string" }),
    outcome: text("outcome"),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    noUnique: uniqueIndex("legal_matters_no_unique").on(t.tenantId, t.matterNo),
    /** ⭐ The query the whole table exists for: what expires soonest. */
    limitationIdx: index("legal_matters_limitation_idx")
      .on(t.tenantId, t.limitationExpiresOn)
      .where(
        sql`${t.limitationExpiresOn} IS NOT NULL AND ${t.status} IN ('open', 'filed')`,
      ),
    clientIdx: index("legal_matters_client_idx").on(t.tenantId, t.companyId, t.status),
    ownerIdx: index("legal_matters_owner_idx").on(
      t.tenantId,
      t.responsibleUserId,
      t.status,
    ),
  }),
);

/**
 * ⭐⭐ SECTIONS 18 AND 19 — a signed acknowledgement or a part payment
 * starts a FRESH period from the date it was made.
 *
 * 🔴 BUT ONLY IF MADE BEFORE THE PERIOD EXPIRED. An acknowledgement on
 * day 1,094 of three years gives three more; the same letter on day
 * 1,096 gives nothing, because the right was already dead and nothing in
 * the Act revives it. The two letters look identical on a file — so the
 * trigger in 0058, not the person typing, decides.
 */
export const legalMatterEvents = pgTable(
  "legal_matter_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    matterId: uuid("matter_id")
      .notNull()
      .references(() => legalMatters.id, { onDelete: "cascade" }),

    eventType: varchar("event_type", { length: 30 }).notNull(),
    eventDate: date("event_date", { mode: "string" }).notNull(),
    description: text("description").notNull(),
    documentRef: varchar("document_ref", { length: 255 }),

    amountMinor: bigint("amount_minor", { mode: "bigint" }),

    resetsLimitation: boolean("resets_limitation").default(false).notNull(),
    previousExpiry: date("previous_expiry", { mode: "string" }),
    newExpiry: date("new_expiry", { mode: "string" }),
    resetNote: text("reset_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    matterIdx: index("legal_matter_events_matter_idx").on(
      t.tenantId,
      t.matterId,
      t.eventDate,
    ),
  }),
);

/**
 * 🔴 A HEARING THAT HAPPENED AND HAS NO NEXT DATE IS A MATTER THAT HAS
 *    FALLEN OFF THE DIARY.
 *
 * ⚠️ That is how a suit is dismissed for default of appearance — not
 * because anybody decided to abandon it, but because the next date was
 * never written down and nobody was listed to attend. The CHECK in 0058
 * requiring either a next date or a disposal is the whole reason this is
 * a table rather than a calendar entry.
 */
export const legalHearings = pgTable(
  "legal_hearings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    matterId: uuid("matter_id")
      .notNull()
      .references(() => legalMatters.id, { onDelete: "cascade" }),

    hearingDate: date("hearing_date", { mode: "string" }).notNull(),
    purpose: varchar("purpose", { length: 255 }),
    beforeJudge: varchar("before_judge", { length: 255 }),
    courtHall: varchar("court_hall", { length: 60 }),
    causeListItem: varchar("cause_list_item", { length: 40 }),

    status: varchar("status", { length: 20 }).default("listed").notNull(),

    appearedBy: uuid("appeared_by").references(() => users.id, { onDelete: "set null" }),
    counselName: varchar("counsel_name", { length: 255 }),

    outcome: text("outcome"),
    adjournedReason: varchar("adjourned_reason", { length: 255 }),
    /** 🔴 The field that keeps the matter on the diary. */
    nextDate: date("next_date", { mode: "string" }),
    disposed: boolean("disposed").default(false).notNull(),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    matterIdx: index("legal_hearings_matter_idx").on(
      t.tenantId,
      t.matterId,
      t.hearingDate,
    ),
    /** ⭐ Tomorrow's list — the one thing a clerk opens the product for. */
    diaryIdx: index("legal_hearings_diary_idx")
      .on(t.tenantId, t.hearingDate)
      .where(sql`${t.status} = 'listed'`),
  }),
);

/**
 * ⭐ SECTION 4 — where the period expires on a day the court is closed,
 * the suit may be instituted on the day it reopens.
 *
 * ⚠️ Most software does not do this. It fails in the safe direction, and
 * it also makes the product unable to answer the question a client
 * actually asks: is there still time?
 */
export const courtHolidays = pgTable(
  "court_holidays",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    courtName: varchar("court_name", { length: 255 }).notNull(),
    holidayDate: date("holiday_date", { mode: "string" }).notNull(),
    description: varchar("description", { length: 255 }),
    blockName: varchar("block_name", { length: 120 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    holidayUnique: uniqueIndex("court_holidays_unique").on(
      t.tenantId,
      t.courtName,
      t.holidayDate,
    ),
    dateIdx: index("court_holidays_date_idx").on(t.tenantId, t.holidayDate),
  }),
);

/**
 * ⭐⭐ MONEY HELD FOR A CLIENT IS NOT THE FIRM'S MONEY.
 *
 * 🔴 THE CARDINAL RULE IS NOT "KEEP RECORDS". It is that **one client's
 *    money may never fund another client's disbursement** — not for an
 *    afternoon, not where it is repaid the same week.
 *
 * ⚠️ And the test for it is arithmetic, not intention: if any client's
 * ledger goes into debit, the firm paid out money it did not hold for
 * that client, which means it paid out somebody else's. The trigger in
 * 0058 is that entire control, in one comparison.
 *
 * ⭐ THIS ALSO CORRECTS SOMETHING v0.98.0 DECIDED. A retainer was
 * modelled as an unapplied customer receipt — still right commercially,
 * one pot, one balance. But an unapplied receipt sitting in the firm's
 * bank account IS client money in the firm's account, and nothing said
 * so. This is that missing half.
 */
export const clientAccountEntries = pgTable(
  "client_account_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    matterId: uuid("matter_id").references(() => legalMatters.id, {
      onDelete: "restrict",
    }),

    entryDate: date("entry_date", { mode: "string" }).notNull(),
    entryKind: varchar("entry_kind", { length: 30 }).notNull(),
    description: text("description").notNull(),
    referenceNo: varchar("reference_no", { length: 60 }),

    /**
     * ⭐ SIGNED, AND THERE IS NO DIRECTION COLUMN. Money in is positive,
     * money out is negative — the same rule the stock ledger has
     * followed since 0029. One signed number cannot disagree with itself.
     */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    /**
     * 🔴 A TRANSFER TO THE FIRM'S OWN ACCOUNT MUST NAME THE BILL. Fees
     * come out of client money only once billed; a transfer with no
     * invoice behind it is the firm helping itself to money it holds.
     */
    invoiceId: uuid("invoice_id"),
    bankReference: varchar("bank_reference", { length: 120 }),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    clientIdx: index("client_account_entries_client_idx").on(
      t.tenantId,
      t.companyId,
      t.entryDate,
    ),
    matterIdx: index("client_account_entries_matter_idx")
      .on(t.tenantId, t.matterId, t.entryDate)
      .where(sql`${t.matterId} IS NOT NULL`),
  }),
);

export const legalMattersRelations = relations(legalMatters, ({ one, many }) => ({
  tenant: one(tenants, { fields: [legalMatters.tenantId], references: [tenants.id] }),
  client: one(companies, {
    fields: [legalMatters.companyId],
    references: [companies.id],
  }),
  hearings: many(legalHearings),
  events: many(legalMatterEvents),
}));

export const legalHearingsRelations = relations(legalHearings, ({ one }) => ({
  matter: one(legalMatters, {
    fields: [legalHearings.matterId],
    references: [legalMatters.id],
  }),
}));

export const legalMatterEventsRelations = relations(legalMatterEvents, ({ one }) => ({
  matter: one(legalMatters, {
    fields: [legalMatterEvents.matterId],
    references: [legalMatters.id],
  }),
}));

export const clientAccountEntriesRelations = relations(
  clientAccountEntries,
  ({ one }) => ({
    client: one(companies, {
      fields: [clientAccountEntries.companyId],
      references: [companies.id],
    }),
    matter: one(legalMatters, {
      fields: [clientAccountEntries.matterId],
      references: [legalMatters.id],
    }),
  }),
);

export type LegalMatterRow = typeof legalMatters.$inferSelect;
export type LegalHearingRow = typeof legalHearings.$inferSelect;
export type LegalMatterEventRow = typeof legalMatterEvents.$inferSelect;
export type CourtHolidayRow = typeof courtHolidays.$inferSelect;
export type ClientAccountEntryRow = typeof clientAccountEntries.$inferSelect;
