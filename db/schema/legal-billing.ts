/**
 * Ordence — ⭐⭐ LEGAL · COURT FEES, DISBURSEMENTS AND WHO PAYS THE GST
 * Version: v1.8.0-alpha  ·  SQL 0059
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 TWO FACTS MAKE A LAWYER'S BILL DIFFERENT FROM EVERY OTHER BILL
 *      IN THIS PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① **The firm usually charges no GST.** Legal services by an advocate
 *    or a firm of advocates are exempt (Notification 12/2017 Sr. No. 45)
 *    or on reverse charge (Notification 13/2017 Sr. No. 2, the client
 *    pays). `raiseInvoiceFromTime` has charged 18% forward on every
 *    invoice since v1.2.0 — which for a law firm is wrong nearly every
 *    time, and wrong in the expensive direction: s.76 makes every rupee
 *    collected as tax payable to the Government whether it was due or
 *    not, and the client cannot claim credit for it either.
 *
 * ② **The court fee is not part of the bill's value at all.** Rule 33 of
 *    the CGST Rules takes a pure agent's recovery out of the value of
 *    supply — provided it is recovered at *exactly* what was paid.
 *
 *    🔴 A ₹500 markup on a ₹50,000 court fee does not cost ₹90 of GST.
 *       It costs ₹9,090, because the whole ₹50,500 falls into value.
 *       `matter_disbursements_pure_agent_is_at_actual` refuses the row.
 *
 * ⭐ AND NO COURT FEE RATES ARE SHIPPED. Court fees are a State subject —
 * the 1870 Act, the Bombay Court Fees Act 1959, and a dozen more, each
 * amended on its own State budget cycle. A stale slab is worse than an
 * empty table: a plaint returned for deficit court fee loses its filing
 * date, and that can lose the limitation.
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
import { salesInvoices } from "./sales-invoices";
import { legalMatters, clientAccountEntries } from "./legal";

/* ------------------------------------------------------------------ */
/* THE SCHEDULE — SHAPE ONLY                                           */
/* ------------------------------------------------------------------ */

export const courtFeeSchedules = pgTable(
  "court_fee_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 200 }).notNull(),
    /** ⭐ The tenant's own citation. Ordence does not supply one. */
    statuteRef: varchar("statute_ref", { length: 300 }).notNull(),
    stateCode: varchar("state_code", { length: 2 }),
    courtTier: varchar("court_tier", { length: 40 }),

    /** fixed | ad_valorem | manual */
    basis: varchar("basis", { length: 20 }).default("ad_valorem").notNull(),

    fixedMinor: bigint("fixed_minor", { mode: "bigint" }),
    /** 🔴 Most State Acts cap the fee, and the cap bites on large suits. */
    maximumMinor: bigint("maximum_minor", { mode: "bigint" }),
    minimumMinor: bigint("minimum_minor", { mode: "bigint" }),
    /** Rounded up to the next ₹10 in several States. 1000 = ₹10. */
    roundUpToMinor: bigint("round_up_to_minor", { mode: "bigint" }),

    effectiveFrom: date("effective_from", { mode: "string" }),
    effectiveTo: date("effective_to", { mode: "string" }),
    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    pickIdx: index("court_fee_schedules_pick_idx")
      .on(t.tenantId, t.stateCode, t.courtTier)
      .where(sql`${t.isActive}`),
  }),
);

export const courtFeeSlabs = pgTable(
  "court_fee_slabs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => courtFeeSchedules.id, { onDelete: "cascade" }),

    /** ⭐ Half-open: from inclusive, upto exclusive, top band NULL. */
    fromMinor: bigint("from_minor", { mode: "bigint" }).notNull(),
    uptoMinor: bigint("upto_minor", { mode: "bigint" }),
    rateBps: integer("rate_bps").default(0).notNull(),
    addMinor: bigint("add_minor", { mode: "bigint" }).default(0n).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scheduleIdx: index("court_fee_slabs_schedule_idx").on(
      t.tenantId,
      t.scheduleId,
      t.fromMinor,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* WHAT WAS PAID OUT ON THE CLIENT'S BEHALF                            */
/* ------------------------------------------------------------------ */

export const matterDisbursements = pgTable(
  "matter_disbursements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    matterId: uuid("matter_id")
      .notNull()
      .references(() => legalMatters.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),

    disbursementDate: date("disbursement_date", { mode: "string" }).notNull(),
    kind: varchar("kind", { length: 30 }).notNull(),
    description: text("description").notNull(),
    referenceNo: varchar("reference_no", { length: 120 }),
    paidTo: varchar("paid_to", { length: 255 }),

    paidAmountMinor: bigint("paid_amount_minor", { mode: "bigint" }).notNull(),
    recoveredAmountMinor: bigint("recovered_amount_minor", { mode: "bigint" }).notNull(),

    /**
     * 🔴 THE FLAG THE WHOLE TABLE TURNS ON. True → outside the value of
     * supply under Rule 33, and the database will not let it be true
     * unless the recovery equals the payment to the paisa.
     */
    isPureAgent: boolean("is_pure_agent").default(true).notNull(),
    /** Rule 33(i) and Explanation (a) — the client authorised it. */
    clientAuthorised: boolean("client_authorised").default(false).notNull(),

    clientAccountEntryId: uuid("client_account_entry_id").references(
      () => clientAccountEntries.id,
      { onDelete: "set null" },
    ),
    /** The fee note it was recovered on. NULL until billed. */
    invoiceId: uuid("invoice_id").references(() => salesInvoices.id, {
      onDelete: "restrict",
    }),
    courtFeeScheduleId: uuid("court_fee_schedule_id").references(
      () => courtFeeSchedules.id,
      { onDelete: "set null" },
    ),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    matterIdx: index("matter_disbursements_matter_idx").on(
      t.tenantId,
      t.matterId,
      t.disbursementDate,
    ),
    unbilledIdx: index("matter_disbursements_unbilled_idx")
      .on(t.tenantId, t.companyId, t.disbursementDate)
      .where(sql`${t.invoiceId} IS NULL`),
  }),
);

/* ------------------------------------------------------------------ */
/* GETTING THE COURT FEE BACK                                          */
/* ------------------------------------------------------------------ */

export const courtFeeRefundClaims = pgTable(
  "court_fee_refund_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    matterId: uuid("matter_id")
      .notNull()
      .references(() => legalMatters.id, { onDelete: "restrict" }),
    disbursementId: uuid("disbursement_id").references(() => matterDisbursements.id, {
      onDelete: "set null",
    }),

    /**
     * 🔴 HOW THE CASE ENDED DECIDES THE ANSWER, NOT HOW MUCH WAS PAID.
     * Sanjeevkumar Harakchand Kankariya v. Union of India (2024) INSC
     * 1004 — a Lok Adalat award and a mediated settlement are not the
     * same thing.
     */
    settlementRoute: varchar("settlement_route", { length: 40 }).notNull(),
    settledOn: date("settled_on", { mode: "string" }).notNull(),
    statuteRef: varchar("statute_ref", { length: 300 }),

    claimedMinor: bigint("claimed_minor", { mode: "bigint" }).notNull(),
    claimFiledOn: date("claim_filed_on", { mode: "string" }),
    receivedMinor: bigint("received_minor", { mode: "bigint" }).default(0n).notNull(),
    receivedOn: date("received_on", { mode: "string" }),
    passedToClientOn: date("passed_to_client_on", { mode: "string" }),

    status: varchar("status", { length: 20 }).default("identified").notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    openIdx: index("court_fee_refund_claims_open_idx")
      .on(t.tenantId, t.status, t.settledOn)
      .where(sql`${t.status} IN ('identified', 'filed')`),
  }),
);

/* ------------------------------------------------------------------ */
/* HOW THIS FIRM IS TAXED                                              */
/* ------------------------------------------------------------------ */

export const legalPracticeProfile = pgTable("legal_practice_profile", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),

  supplierKind: varchar("supplier_kind", { length: 30 })
    .default("firm_of_advocates")
    .notNull(),
  /**
   * ⚠️ ONE FORWARD-CHARGE SUPPLY KILLS THE s.23(2) RELIEF. Notification
   * 5/2017-Central Tax only ever applied to a person the whole of whose
   * outward tax is paid by recipients. A single seminar fee ends it.
   */
  hasForwardChargeSupplies: boolean("has_forward_charge_supplies")
    .default(false)
    .notNull(),
  /** The firm's own view on the one question Ordence will not decide. */
  seniorToAdvocatePosition: varchar("senior_to_advocate_position", { length: 20 }),
  seniorToAdvocateNote: text("senior_to_advocate_note"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});

export const legalClientTaxStatus = pgTable(
  "legal_client_tax_status",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    recipientKind: varchar("recipient_kind", { length: 30 })
      .default("business_entity")
      .notNull(),
    /** 🔴 The threshold that applies is the one in the CLIENT's State. */
    stateCode: varchar("state_code", { length: 2 }),
    recipientOutsideIndia: boolean("recipient_outside_india").default(false).notNull(),

    /** ⚠️ Which FY. The exemption is decided on the PRECEDING one. */
    turnoverFy: varchar("turnover_fy", { length: 9 }),
    turnoverMinor: bigint("turnover_minor", { mode: "bigint" }),
    thresholdOverrideMinor: bigint("threshold_override_minor", { mode: "bigint" }),

    confirmedOn: date("confirmed_on", { mode: "string" }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("legal_client_tax_status_unique").on(t.tenantId, t.companyId),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const courtFeeSchedulesRelations = relations(courtFeeSchedules, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [courtFeeSchedules.tenantId],
    references: [tenants.id],
  }),
  slabs: many(courtFeeSlabs),
}));

export const courtFeeSlabsRelations = relations(courtFeeSlabs, ({ one }) => ({
  schedule: one(courtFeeSchedules, {
    fields: [courtFeeSlabs.scheduleId],
    references: [courtFeeSchedules.id],
  }),
}));

export const matterDisbursementsRelations = relations(
  matterDisbursements,
  ({ one, many }) => ({
    matter: one(legalMatters, {
      fields: [matterDisbursements.matterId],
      references: [legalMatters.id],
    }),
    client: one(companies, {
      fields: [matterDisbursements.companyId],
      references: [companies.id],
    }),
    invoice: one(salesInvoices, {
      fields: [matterDisbursements.invoiceId],
      references: [salesInvoices.id],
    }),
    refundClaims: many(courtFeeRefundClaims),
  }),
);

export const courtFeeRefundClaimsRelations = relations(courtFeeRefundClaims, ({ one }) => ({
  matter: one(legalMatters, {
    fields: [courtFeeRefundClaims.matterId],
    references: [legalMatters.id],
  }),
  disbursement: one(matterDisbursements, {
    fields: [courtFeeRefundClaims.disbursementId],
    references: [matterDisbursements.id],
  }),
}));

export const legalClientTaxStatusRelations = relations(legalClientTaxStatus, ({ one }) => ({
  client: one(companies, {
    fields: [legalClientTaxStatus.companyId],
    references: [companies.id],
  }),
}));
