/**
 * Ordence — ⭐ Running-Account Bills and Contractor Compliance
 * Version: v0.44.0-alpha  ·  PORT WAVE B
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DENSEST MONEY DOCUMENT A DEVELOPER SIGNS
 * ══════════════════════════════════════════════════════════════════════
 * A running-account bill is how a contractor gets paid for work in
 * progress. RA-1, RA-2, RA-3 — each one certifies the CUMULATIVE work
 * done to date, subtracts everything already paid, and settles the
 * difference. Four separate statutory and contractual deductions land on
 * that difference, and every one of them is somebody else's money:
 *
 *   gross certified this bill
 *   − everything paid on earlier RA bills      ← cumulative, not per-bill
 *   − 1% BOCW labour welfare cess              ← a statutory levy
 *   − 5% retention                             ← held until defects expire
 *   − TDS under s.194C                         ← deposited with the govt
 *   − ad-hoc deductions (advances, penalties)
 *   = net payable to the contractor
 *
 * ⚠️ THE ORDER MATTERS AND IT IS NOT OBVIOUS. Cess and TDS are computed
 * on the value of work, retention on the same base — but the deduction of
 * PREVIOUS PAYMENTS happens on the cumulative figure, not the current
 * one. Get the sequence wrong and each bill is individually plausible
 * while the running total drifts, which is why RA-bill disputes are
 * always discovered at the final bill and never before.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE RULE THIS PHASE EXISTS TO ENCODE
 * ══════════════════════════════════════════════════════════════════════
 *
 *   A CONTRACTOR WITH NO VERIFIED EPF/ESI CHALLAN FOR THE PERIOD
 *   DOES NOT GET PAID FOR THAT PERIOD.
 *
 * This is not a preference. Under the EPF and ESI Acts the PRINCIPAL
 * EMPLOYER — the developer — is liable for a contractor's unpaid employee
 * provident fund and insurance contributions. Paying a contractor who has
 * not deposited them means paying twice: once to him, and again to the
 * authority when it comes looking, with damages and interest on top.
 *
 * The source system encoded this as a document gate. It is ported here as
 * a database trigger, because a rule that lives in a screen is a rule the
 * back-fill and the support fix walk straight past — and the payment run
 * at month end is exactly where somebody is in a hurry.
 *
 * Money is `bigint` paise. Percentages are integer basis points.
 * Quantities are `numeric(18,3)`.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  boolean,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { projects } from "./sales";
import { vendors } from "./purchases";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE RA-BILL LIFECYCLE.
 *
 * ⚠️ `certified` IS A SEPARATE STATE FROM `approved`, and merging them
 * would collapse two different people's responsibility into one.
 * Certification is an ENGINEER saying the work was done to specification.
 * Approval is a FINANCE decision that it may be paid. The engineer does
 * not control the bank account and the accountant did not visit the site.
 */
export const raBillStatusEnum = pgEnum("ra_bill_status", [
  "draft",
  "submitted",
  "certified",
  "approved",
  "paid",
  "rejected",
  "cancelled",
]);

export const complianceDocKindEnum = pgEnum("compliance_doc_kind", [
  "epf",
  "esi",
  "professional_tax",
  "labour_licence",
  "wc_policy",
  "gst_return",
  "other",
]);

export const complianceDocStatusEnum = pgEnum("compliance_doc_status", [
  "pending",
  "uploaded",
  "verified",
  "rejected",
  "expired",
]);

export const worksContractStatusEnum = pgEnum("works_contract_status", [
  "draft",
  "active",
  "suspended",
  "completed",
  "terminated",
]);

/* ------------------------------------------------------------------ */
/* WORKS CONTRACTS                                                     */
/* ------------------------------------------------------------------ */

export const worksContracts = pgTable(
  "works_contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    contractNo: varchar("contract_no", { length: 100 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),

    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),

    status: worksContractStatusEnum("status").default("draft").notNull(),
    contractValueMinor: bigint("contract_value_minor", { mode: "bigint" }),

    startOn: date("start_on"),
    endOn: date("end_on"),

    /**
     * ⭐ THE DEFECT LIABILITY PERIOD, AND WHY RETENTION EXISTS.
     *
     * Retention is money held back from every bill and released only once
     * the contractor has fixed anything that failed within this window.
     * Releasing it early is the single easiest way to lose all leverage
     * over a contractor who has already left the site.
     */
    defectLiabilityEndsOn: date("defect_liability_ends_on"),
    liabilityClause: text("liability_clause"),

    /* --- The default deduction terms for bills under this contract -- */
    /** ⭐ BOCW cess: 1% of the cost of construction. 100 bps. */
    cessRateBps: integer("cess_rate_bps").default(100).notNull(),
    /** Retention, commonly 5%. */
    retentionRateBps: integer("retention_rate_bps").default(500).notNull(),
    /** Usually 194C for a works contract. */
    tdsSection: varchar("tds_section", { length: 10 }).default("194C"),
    /** 1% for an individual/HUF contractor, 2% otherwise. */
    tdsRateBps: integer("tds_rate_bps").default(200),

    /**
     * ⚠️ WHEN TRUE, NO BILL UNDER THIS CONTRACT MAY BE PAID FOR A PERIOD
     * WITHOUT A VERIFIED EPF/ESI CHALLAN FOR THAT PERIOD. Default TRUE,
     * because the principal-employer liability applies whether or not
     * anybody remembered to switch it on.
     */
    requiresLabourCompliance: boolean("requires_labour_compliance")
      .default(true)
      .notNull(),
    /** Some contracts additionally require an engineer's certificate. */
    requiresEngineerCertificate: boolean("requires_engineer_certificate")
      .default(true)
      .notNull(),
    dailyReportRequired: boolean("daily_report_required").default(true).notNull(),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("works_contracts_tenant_idx").on(t.tenantId),
    contractNoUnique: uniqueIndex("works_contracts_no_unique").on(
      t.tenantId,
      t.contractNo,
    ),
    tenantIdUnique: uniqueIndex("works_contracts_id_tenant_unique").on(t.id, t.tenantId),
    vendorIdx: index("works_contracts_vendor_idx").on(t.tenantId, t.vendorId),
    projectIdx: index("works_contracts_project_idx").on(t.tenantId, t.projectId),
    /** The report nobody runs until it is too late: retention due for release. */
    dlpIdx: index("works_contracts_dlp_idx").on(t.tenantId, t.defectLiabilityEndsOn),

    saneRates: check(
      "works_contracts_rates_sane",
      sql`${t.cessRateBps} >= 0 AND ${t.cessRateBps} <= 10000
          AND ${t.retentionRateBps} >= 0 AND ${t.retentionRateBps} <= 10000
          AND (${t.tdsRateBps} IS NULL OR (${t.tdsRateBps} >= 0 AND ${t.tdsRateBps} <= 10000))`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ CONTRACTOR COMPLIANCE DOCUMENTS — THE PAYMENT GATE                */
/* ------------------------------------------------------------------ */

export const complianceDocs = pgTable(
  "compliance_docs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    vendorId: uuid("vendor_id").notNull(),
    kind: complianceDocKindEnum("kind").notNull(),

    /**
     * ⭐ THE PERIOD THIS CHALLAN COVERS, AS `YYYY-MM`.
     *
     * ⚠️ A STRING, NOT A DATE, AND DELIBERATELY SO. EPF and ESI are filed
     * per calendar month, and a date column invites somebody to store the
     * day the challan was paid — which is in the FOLLOWING month, and
     * would silently gate the wrong period.
     */
    periodMonth: varchar("period_month", { length: 7 }).notNull(),

    challanNo: varchar("challan_no", { length: 100 }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    paidOn: date("paid_on"),

    status: complianceDocStatusEnum("status").default("pending").notNull(),
    documentId: uuid("document_id"),

    /**
     * ⚠️ VERIFICATION IS A PERSON, NOT A FLAG. "Verified" means somebody
     * opened the challan and checked the establishment code and the
     * amount. A boolean with nobody behind it is a tick nobody owns.
     */
    verifiedBy: uuid("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    uploadedBy: uuid("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("compliance_docs_tenant_idx").on(t.tenantId),
    /** One challan per vendor, per kind, per month. */
    slotUnique: uniqueIndex("compliance_docs_slot_unique").on(
      t.tenantId,
      t.vendorId,
      t.kind,
      t.periodMonth,
    ),
    vendorIdx: index("compliance_docs_vendor_idx").on(t.tenantId, t.vendorId),
    statusIdx: index("compliance_docs_status_idx").on(t.tenantId, t.status),

    /** `YYYY-MM`, and nothing else. */
    periodShape: check(
      "compliance_docs_period_shape",
      sql`${t.periodMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ENGINEER CERTIFICATION                                              */
/* ------------------------------------------------------------------ */

export const engineerCertifications = pgTable(
  "engineer_certifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull(),
    vendorId: uuid("vendor_id").notNull(),

    /** `YYYY-MM`, or an RA-bill stage key. */
    period: varchar("period", { length: 30 }).notNull(),

    /**
     * ⚠️ FALSE MEANS PAYMENT IS BLOCKED FOR THIS PERIOD. The engineer has
     * looked and is not satisfied. That is a finding, not an oversight,
     * and it must outrank a finance team's month-end schedule.
     */
    isCleared: boolean("is_cleared").default(false).notNull(),

    certifiedBy: uuid("certified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    certifiedByName: varchar("certified_by_name", { length: 200 }),
    certifiedAt: timestamp("certified_at", { withTimezone: true }),
    remarks: text("remarks"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("engineer_certifications_tenant_idx").on(t.tenantId),
    slotUnique: uniqueIndex("engineer_certifications_slot_unique").on(
      t.contractId,
      t.period,
    ),
    clearedIdx: index("engineer_certifications_cleared_idx").on(
      t.tenantId,
      t.isCleared,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ RUNNING-ACCOUNT BILLS                                             */
/* ------------------------------------------------------------------ */

export const raBills = pgTable(
  "ra_bills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Human-facing: RA-2026-0007. Unique per tenant. */
    billNo: varchar("bill_no", { length: 60 }).notNull(),

    /**
     * ⭐ THE RUNNING-ACCOUNT SEQUENCE WITHIN ONE CONTRACT: RA-1, RA-2…
     *
     * ⚠️ SEPARATE FROM `billNo` AND UNIQUE PER CONTRACT. The whole point
     * of a running account is that bill N supersedes bill N−1's
     * cumulative position. Two bills claiming to be RA-3 on one contract
     * means one of them is measuring against the wrong previous total.
     */
    sequence: integer("sequence").notNull(),

    contractId: uuid("contract_id").notNull(),
    vendorId: uuid("vendor_id").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    periodFrom: date("period_from"),
    periodTo: date("period_to"),
    /** ⭐ `YYYY-MM` — the month whose EPF/ESI challan gates this bill. */
    complianceMonth: varchar("compliance_month", { length: 7 }),

    /* --- The arithmetic, every figure in paise -------------------- */

    /** Value of work certified in THIS bill. */
    grossValueMinor: bigint("gross_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⭐ CUMULATIVE PAID ON EARLIER RA BILLS UNDER THIS CONTRACT.
     *
     * ⚠️ DERIVED BY TRIGGER FROM THE EARLIER BILLS, NEVER TYPED. This is
     * the field RA-bill disputes are made of: a figure that can be keyed
     * by hand is a figure that drifts one bill at a time, plausibly, and
     * is only ever discovered at the final bill when the totals do not
     * reconcile and the contractor has already left.
     */
    previousPaidMinor: bigint("previous_paid_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /* --- Deductions. Rates copied from the contract at creation. --- */
    cessRateBps: integer("cess_rate_bps").default(100).notNull(),
    cessAmountMinor: bigint("cess_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    retentionRateBps: integer("retention_rate_bps").default(500).notNull(),
    retentionAmountMinor: bigint("retention_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    tdsSection: varchar("tds_section", { length: 10 }),
    tdsRateBps: integer("tds_rate_bps"),
    tdsAmountMinor: bigint("tds_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Advances recovered, penalties, price adjustments. */
    otherDeductionsMinor: bigint("other_deductions_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    otherDeductionsNote: text("other_deductions_note"),

    /**
     * ⭐ WHAT THE CONTRACTOR ACTUALLY RECEIVES.
     * ⚠️ DERIVED BY TRIGGER. Never accepted from a form.
     */
    netPayableMinor: bigint("net_payable_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    status: raBillStatusEnum("status").default("draft").notNull(),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    /** The ENGINEER — the work was done. */
    certifiedBy: uuid("certified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    certifiedAt: timestamp("certified_at", { withTimezone: true }),

    /** FINANCE — it may be paid. A different person, deliberately. */
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** UTR of the transfer. The only proof the money moved. */
    paymentUtr: varchar("payment_utr", { length: 60 }),

    rejectionReason: text("rejection_reason"),
    narration: text("narration"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("ra_bills_tenant_idx").on(t.tenantId),
    billNoUnique: uniqueIndex("ra_bills_no_unique").on(t.tenantId, t.billNo),
    /** ⭐ One RA-N per contract. See the note on `sequence`. */
    sequenceUnique: uniqueIndex("ra_bills_sequence_unique").on(t.contractId, t.sequence),
    tenantIdUnique: uniqueIndex("ra_bills_id_tenant_unique").on(t.id, t.tenantId),
    vendorIdx: index("ra_bills_vendor_idx").on(t.tenantId, t.vendorId),
    statusIdx: index("ra_bills_status_idx").on(t.tenantId, t.status),
    contractIdx: index("ra_bills_contract_idx").on(t.tenantId, t.contractId, t.sequence),

    positiveSequence: check("ra_bills_sequence_positive", sql`${t.sequence} >= 1`),
    nonNegativeGross: check(
      "ra_bills_gross_non_negative",
      sql`${t.grossValueMinor} >= 0`,
    ),
    /**
     * ⚠️ A NEGATIVE NET PAYABLE IS NOT AN ERROR — it happens when
     * recovered advances exceed the work certified in a lean month, and
     * the contractor owes US. Blocking it would force somebody to fudge
     * the deductions to get the bill through.
     */
    saneRates: check(
      "ra_bills_rates_sane",
      sql`${t.cessRateBps} >= 0 AND ${t.retentionRateBps} >= 0
          AND (${t.tdsRateBps} IS NULL OR ${t.tdsRateBps} >= 0)`,
    ),
  }),
);

export const raBillLines = pgTable(
  "ra_bill_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    raBillId: uuid("ra_bill_id").notNull(),

    lineNo: integer("line_no").notNull(),
    /** Bill-of-quantities item code, where the contract has a BoQ. */
    boqCode: varchar("boq_code", { length: 60 }),

    /**
     * ⭐ WHICH BOQ LINE THIS CLAIM IS AGAINST — added v0.68.0 (SQL 0041).
     *
     * ⚠️ `boqCode` ABOVE IS A STRING SOMEBODY TYPED. It can be mistyped,
     * reused across two BOQs on the same project, or left blank, so no
     * check can be built on it. This column is the actual identity, and
     * it is what lets SQL 0041 §3 refuse a cumulative claim that exceeds
     * the authorised quantity.
     *
     * ⚠️ NULLABLE ON PURPOSE, AND THE NULL CASE IS NOT AN OVERSIGHT.
     * Day-work, provisional sums and materials-at-site are legitimate
     * bill lines with no BOQ item behind them. The guard skips those
     * rather than refusing them — which means a line with a null here is
     * UNCHECKED, and that is worth knowing when reviewing a bill.
     *
     * ⚠️ THE FK IS `ON DELETE SET NULL`, NEVER CASCADE. Deleting a BOQ
     * line must not delete a line of an issued bill: the bill records
     * what was claimed, the BOQ is an estimate that gets revised.
     * Cascading from the estimate to the record would erase history in
     * order to tidy a plan.
     */
    boqItemId: uuid("boq_item_id"),
    description: text("description").notNull(),

    /**
     * ⚠️ CONSTRUCTION UNITS, NOT RETAIL ONES: cum, sqm, sqft, MT, RMT,
     * nos. A quantity with no unit on an RA bill is the start of an
     * argument about whether 340 means cubic metres or square metres,
     * and those two differ by a factor nobody can settle afterwards.
     */
    unit: varchar("unit", { length: 20 }).notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
    rateMinor: bigint("rate_minor", { mode: "bigint" }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⭐ CUMULATIVE QUANTITY EXECUTED TO DATE under this BoQ item, across
     * every RA bill. Recorded so the next bill's measurement can be
     * checked against the BoQ provision without re-reading every earlier
     * bill — over-execution against a BoQ item is a variation order, not
     * a measurement.
     */
    cumulativeQuantity: numeric("cumulative_quantity", { precision: 18, scale: 3 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("ra_bill_lines_tenant_idx").on(t.tenantId),
    billIdx: index("ra_bill_lines_bill_idx").on(t.tenantId, t.raBillId),
    lineNoUnique: uniqueIndex("ra_bill_lines_no_unique").on(t.raBillId, t.lineNo),

    positiveQuantity: check("ra_bill_lines_quantity_positive", sql`${t.quantity} > 0`),
    nonNegativeRate: check("ra_bill_lines_rate_non_negative", sql`${t.rateMinor} >= 0`),
  }),
);

/* ------------------------------------------------------------------ */
/* RETENTION RELEASES                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ RETENTION IS HELD, THEN RELEASED. BOTH ARE EVENTS.
 *
 * ⚠️ A SEPARATE TABLE, NOT A FLAG ON THE BILL. Retention is withheld
 * across many bills and released in one or two tranches — commonly half
 * at practical completion and half at the end of the defect liability
 * period. A boolean on each bill could not express a half release, and a
 * running total on the contract could not say when or by whom.
 */
export const retentionReleases = pgTable(
  "retention_releases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id").notNull(),
    vendorId: uuid("vendor_id").notNull(),

    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    releasedOn: date("released_on"),

    /**
     * ⚠️ REQUIRED. Releasing retention before the defect liability period
     * ends is a commercial decision that gives up the only leverage left
     * over a contractor who has finished and gone. It may be right; it
     * must be attributable.
     */
    reason: text("reason").notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    paymentUtr: varchar("payment_utr", { length: 60 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("retention_releases_tenant_idx").on(t.tenantId),
    contractIdx: index("retention_releases_contract_idx").on(t.tenantId, t.contractId),
    positiveAmount: check("retention_releases_amount_positive", sql`${t.amountMinor} > 0`),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS & TYPES                                                   */
/* ------------------------------------------------------------------ */

export const worksContractsRelations = relations(worksContracts, ({ one, many }) => ({
  project: one(projects, {
    fields: [worksContracts.projectId],
    references: [projects.id],
  }),
  vendor: one(vendors, {
    fields: [worksContracts.vendorId],
    references: [vendors.id],
  }),
  bills: many(raBills),
  certifications: many(engineerCertifications),
}));

export const raBillsRelations = relations(raBills, ({ one, many }) => ({
  contract: one(worksContracts, {
    fields: [raBills.contractId],
    references: [worksContracts.id],
  }),
  lines: many(raBillLines),
}));

export const raBillLinesRelations = relations(raBillLines, ({ one }) => ({
  bill: one(raBills, { fields: [raBillLines.raBillId], references: [raBills.id] }),
}));

export type WorksContract = typeof worksContracts.$inferSelect;
export type ComplianceDoc = typeof complianceDocs.$inferSelect;
export type EngineerCertification = typeof engineerCertifications.$inferSelect;
export type RaBill = typeof raBills.$inferSelect;
export type NewRaBill = typeof raBills.$inferInsert;
export type RaBillLine = typeof raBillLines.$inferSelect;
export type RetentionRelease = typeof retentionReleases.$inferSelect;
export type RaBillStatus = (typeof raBillStatusEnum.enumValues)[number];

/**
 * ⭐ THE DOCUMENTS THAT GATE A PAYMENT.
 *
 * ⚠️ EPF AND ESI ONLY. The other kinds in the catalogue are tracked but
 * do not block money — a lapsed labour licence is a serious problem and
 * it is not one the principal employer pays twice for. Widening this list
 * without understanding which liabilities actually flow upward would stop
 * legitimate payments for the wrong reason.
 */
export const PAYMENT_GATING_DOCS = ["epf", "esi"] as const;

/** Statuses in which an RA bill's figures may still change. */
export const RA_BILL_EDITABLE: readonly RaBillStatus[] = ["draft", "submitted"];
