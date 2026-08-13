/**
 * Ordence — Double-Entry Trust Accounting
 * Version: v0.4.0-alpha
 *
 * THE ONE RULE: every transaction's debits must equal its credits. Always.
 *
 * This is not a stylistic preference — for a TRUST ledger it is a legal
 * obligation. Client money held in trust (booking advances, escrow deposits,
 * retention held on behalf of contractors) must be reconcilable to the rupee, and
 * an unbalanced entry means money has been invented or destroyed on paper.
 *
 * HOW IT IS ENFORCED — three independent layers:
 *
 *   1. `transaction_id` groups the legs of one economic event. A transfer is not
 *      two rows; it is one transaction containing two rows.
 *
 *   2. A DEFERRED CONSTRAINT TRIGGER validates SUM(debits) = SUM(credits) per
 *      transaction at COMMIT time — not per row. This is essential: you must be
 *      able to insert the debit leg and the credit leg as separate statements
 *      within one transaction. A row-level trigger would reject the first leg
 *      before the second arrived.
 *
 *   3. Journal entries are APPEND-ONLY. UPDATE and DELETE are blocked by trigger.
 *      Corrections are made by posting a reversing entry, exactly as in real
 *      bookkeeping — the original mistake stays visible in the record.
 *
 * WHY NUMERIC(18,2) AND NEVER A FLOAT:
 *   0.1 + 0.2 !== 0.3 in binary floating point. Accumulated over a few thousand
 *   entries, a float-based ledger silently drifts out of balance. NUMERIC is exact
 *   decimal arithmetic. This is non-negotiable in financial code.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  numeric,
  integer,
  boolean,
  date,
  index,
  uniqueIndex,
  bigint,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

export const ledgerTypeEnum = pgEnum("ledger_type", [
  /** The firm's own money. */
  "operating",
  /**
   * Client money held on trust. Legally NOT the firm's asset — commingling with
   * operating funds is a regulatory breach in most jurisdictions.
   */
  "trust",
  /** Funds held against a specific obligation until a condition is met. */
  "escrow",
  /** Amounts retained from contractor payments, released after defect liability. */
  "retention",
  /** Suspense — unidentified receipts pending allocation. Must clear to zero. */
  "suspense",
]);

/** Standard accounting classification. Determines normal balance side. */
export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);

export const entryTypeEnum = pgEnum("entry_type", ["debit", "credit"]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "posted",
  "reversed",
  "void",
]);

/** What a transaction refers to. Polymorphic by design — a ledger references
 *  many kinds of business object without a foreign key per type. */
export const periodStatusEnum = pgEnum("period_status", [
  /** Entries may be posted freely. */
  "open",
  /** Under review — entries blocked, but the period can still be reopened. */
  "pending_close",
  /** Locked. No entry may be posted, edited or removed with a date inside it. */
  "closed",
  /** Closed and archived. Reopening requires a platform-level override. */
  "locked",
]);

export const referenceTypeEnum = pgEnum("reference_type", [
  "contract",
  "deal",
  "asset",
  "invoice",
  "payment",
  "receipt",
  "journal",
  "adjustment",
  "opening_balance",
]);

/* ------------------------------------------------------------------ */
/* LEDGERS                                                             */
/* ------------------------------------------------------------------ */

export const ledgers = pgTable(
  "ledgers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 200 }).notNull(),
    /** Chart-of-accounts code, e.g. "1100" for Bank — Trust. */
    code: varchar("code", { length: 40 }).notNull(),
    description: text("description"),

    type: ledgerTypeEnum("type").default("operating").notNull(),
    accountType: accountTypeEnum("account_type").notNull(),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /**
     * Cached balance, maintained by trigger on every posting.
     * Authoritative balance is always SUM(journal_entries) — this column exists
     * so a dashboard does not have to aggregate the full journal on every load.
     * The reconciliation query at the bottom of the migration verifies the two agree.
     */
    currentBalance: numeric("current_balance", { precision: 18, scale: 2 })
      .default("0.00")
      .notNull(),

    /** Optional hierarchy for sub-ledgers (e.g. Trust → Trust: Project A). */
    parentLedgerId: uuid("parent_ledger_id"),

    /** Bank details, when this ledger maps to a real account. */
    bankDetails: jsonb("bank_details")
      .$type<{
        bankName?: string;
        accountNumber?: string;
        ifsc?: string;
        branch?: string;
        accountHolder?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    /** System ledgers cannot be deleted by tenant admins. */
    isSystem: boolean("is_system").default(false).notNull(),

    /** Trust ledgers require reconciliation at a defined cadence. */
    requiresReconciliation: boolean("requires_reconciliation").default(false).notNull(),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantCodeUnique: uniqueIndex("ledgers_tenant_code_unique")
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    tenantIdx: index("ledgers_tenant_idx").on(t.tenantId),
    tenantTypeIdx: index("ledgers_tenant_type_idx").on(t.tenantId, t.type),
    parentIdx: index("ledgers_parent_idx").on(t.tenantId, t.parentLedgerId),
  }),
);

/* ------------------------------------------------------------------ */
/* TRANSACTIONS  (the balance boundary)                                */
/* ------------------------------------------------------------------ */

/**
 * One economic event. Every journal entry belongs to exactly one transaction,
 * and the deferred trigger checks balance PER TRANSACTION at commit.
 *
 * This table is what makes the double-entry guarantee expressible: without it,
 * "balanced" has no scope.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Human-readable reference, e.g. "JV/2026/00184". */
    transactionNumber: varchar("transaction_number", { length: 60 }),

    description: text("description").notNull(),
    transactionDate: date("transaction_date").notNull(),

    status: transactionStatusEnum("status").default("posted").notNull(),

    /** Polymorphic link to the business object that caused this transaction. */
    referenceType: referenceTypeEnum("reference_type").default("journal").notNull(),
    referenceId: uuid("reference_id"),

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /**
     * Total of the debit side. Equals the credit side by construction — stored
     * for reporting so a "transaction value" does not require an aggregate.
     */
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 })
      .default("0.00")
      .notNull(),

    /** Set when this transaction reverses an earlier one. */
    reversesTransactionId: uuid("reverses_transaction_id"),
    reversedByTransactionId: uuid("reversed_by_transaction_id"),
    reversalReason: text("reversal_reason"),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("transactions_tenant_idx").on(t.tenantId),
    tenantDateIdx: index("transactions_tenant_date_idx").on(t.tenantId, t.transactionDate),
    referenceIdx: index("transactions_reference_idx").on(t.tenantId, t.referenceType, t.referenceId),
    numberUnique: uniqueIndex("transactions_tenant_number_unique")
      .on(t.tenantId, t.transactionNumber)
      .where(sql`${t.transactionNumber} IS NOT NULL`),
    statusIdx: index("transactions_status_idx").on(t.tenantId, t.status),
  }),
);

/* ------------------------------------------------------------------ */
/* JOURNAL ENTRIES  (append-only, balance-enforced)                    */
/* ------------------------------------------------------------------ */

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The balance boundary. Non-nullable — an orphan leg cannot be validated. */
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),

    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),

    entryType: entryTypeEnum("entry_type").notNull(),

    /**
     * Always POSITIVE. Direction is carried by `entryType`, never by sign.
     * A negative amount plus a debit/credit flag gives two ways to express the
     * same thing — and two ways to get it wrong. A CHECK constraint enforces > 0.
     */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),

    description: text("description"),

    /** Polymorphic reference, mirrored from the parent transaction for querying. */
    referenceType: referenceTypeEnum("reference_type").default("journal").notNull(),
    referenceId: uuid("reference_id"),

    /** Party this leg relates to, for statements of account. */
    counterpartyType: varchar("counterparty_type", { length: 40 }),
    counterpartyId: uuid("counterparty_id"),
    counterpartyName: varchar("counterparty_name", { length: 300 }),

    /** Running balance of the ledger immediately after this entry was posted. */
    balanceAfter: numeric("balance_after", { precision: 18, scale: 2 }),

    /** Bank reconciliation state. */
    isReconciled: boolean("is_reconciled").default(false).notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    bankReference: varchar("bank_reference", { length: 200 }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    // NOTE: deliberately NO updatedAt / deletedAt — this table is append-only.
  },
  (t) => ({
    tenantIdx: index("journal_entries_tenant_idx").on(t.tenantId),
    transactionIdx: index("journal_entries_transaction_idx").on(t.transactionId),
    // The statement-of-account query.
    ledgerIdx: index("journal_entries_ledger_idx").on(t.tenantId, t.ledgerId, t.createdAt),
    referenceIdx: index("journal_entries_reference_idx").on(t.tenantId, t.referenceType, t.referenceId),
    counterpartyIdx: index("journal_entries_counterparty_idx").on(t.tenantId, t.counterpartyId),
    reconciledIdx: index("journal_entries_reconciled_idx").on(t.tenantId, t.isReconciled),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const ledgersRelations = relations(ledgers, ({ one, many }) => ({
  tenant: one(tenants, { fields: [ledgers.tenantId], references: [tenants.id] }),
  entries: many(journalEntries),
}));

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [transactions.tenantId], references: [tenants.id] }),
  entries: many(journalEntries),
  creator: one(users, { fields: [transactions.createdBy], references: [users.id] }),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one }) => ({
  tenant: one(tenants, { fields: [journalEntries.tenantId], references: [tenants.id] }),
  transaction: one(transactions, {
    fields: [journalEntries.transactionId],
    references: [transactions.id],
  }),
  ledger: one(ledgers, { fields: [journalEntries.ledgerId], references: [ledgers.id] }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type Ledger = typeof ledgers.$inferSelect;
export type NewLedger = typeof ledgers.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type LedgerType = (typeof ledgerTypeEnum.enumValues)[number];
export type AccountType = (typeof accountTypeEnum.enumValues)[number];
export type EntryType = (typeof entryTypeEnum.enumValues)[number];
export type ReferenceType = (typeof referenceTypeEnum.enumValues)[number];

/** One leg of a transaction, as supplied by application code. */
export type JournalLeg = {
  ledgerId: string;
  entryType: EntryType;
  /** Positive decimal string, e.g. "150000.00". */
  amount: string;
  description?: string;
  counterpartyType?: string;
  counterpartyId?: string;
  counterpartyName?: string;
};

/* ------------------------------------------------------------------ */
/* FINANCIAL PERIODS  (SEC-012)                                        */
/* ------------------------------------------------------------------ */

/**
 * An accounting period — typically a month or a quarter.
 *
 * THE PROBLEM THIS SOLVES (SEC-012, raised in Phase 4):
 * Until now nothing stopped someone posting a back-dated entry into a month
 * that had already been reported to a bank, an auditor, or the tax authority.
 * The books would silently disagree with the filing.
 *
 * Closing a period makes that impossible at the DATABASE level: a trigger
 * rejects any INSERT, UPDATE or DELETE on `journal_entries` whose transaction
 * date falls inside a closed period. No application bug, no raw SQL, and no
 * future service can get around it.
 *
 * WHY PERIODS MUST NOT OVERLAP:
 * If two periods covered the same day, one open and one closed, the rule
 * "is this date locked?" would have two answers. An exclusion constraint in the
 * migration makes overlap impossible per tenant.
 */
export const financialPeriods = pgTable(
  "financial_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Display label, e.g. "Q1 FY2026" or "April 2026". */
    name: varchar("name", { length: 120 }).notNull(),

    /** Inclusive on both ends. A single day is start = end. */
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),

    status: periodStatusEnum("status").default("open").notNull(),

    /** Fiscal metadata for reporting. Indian FY runs April–March. */
    fiscalYear: varchar("fiscal_year", { length: 12 }),
    periodNumber: integer("period_number"),

    /* --- Close audit trail -------------------------------------- */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closingNotes: text("closing_notes"),

    /**
     * Snapshot of the trial balance at the moment of close.
     * This is the evidence that the books balanced when they were locked — if
     * a later reconciliation disagrees, this is what you compare against.
     */
    closingBalances: jsonb("closing_balances")
      .$type<{
        totalDebits?: string;
        totalCredits?: string;
        entryCount?: number;
        ledgerBalances?: Array<{ ledgerId: string; code: string; balance: string }>;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Reopening is an exceptional act and must be justified. */
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: uuid("reopened_by").references(() => users.id, { onDelete: "set null" }),
    reopenReason: text("reopen_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("financial_periods_tenant_idx").on(t.tenantId),
    // The hot path: "is this date inside a closed period?"
    tenantRangeIdx: index("financial_periods_range_idx").on(t.tenantId, t.startDate, t.endDate),
    tenantStatusIdx: index("financial_periods_status_idx").on(t.tenantId, t.status),
    nameUnique: uniqueIndex("financial_periods_tenant_name_unique").on(t.tenantId, t.name),
  }),
);

export const financialPeriodsRelations = relations(financialPeriods, ({ one }) => ({
  tenant: one(tenants, { fields: [financialPeriods.tenantId], references: [tenants.id] }),
  closer: one(users, { fields: [financialPeriods.closedBy], references: [users.id] }),
}));

export type FinancialPeriod = typeof financialPeriods.$inferSelect;
export type NewFinancialPeriod = typeof financialPeriods.$inferInsert;
export type PeriodStatus = (typeof periodStatusEnum.enumValues)[number];

/* ------------------------------------------------------------------ */
/* ⭐ WHICH LEDGER EACH PART OF A SALES DOCUMENT POSTS TO — Phase 58    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ A LEDGER CANNOT BE GUESSED FROM ITS NAME OR ITS CODE. Every tenant
 * builds their own chart of accounts — "4000" is revenue in one and a
 * bank account in another. Inferring the mapping would post a customer's
 * turnover into whatever ledger happened to match a string, and a
 * posting that BALANCES is not the same as a posting that is RIGHT.
 *
 * So the mapping is data, declared once per tenant, and posting refuses
 * when a role is unmapped rather than choosing on their behalf.
 */
export const salesPostingAccounts = pgTable(
  "sales_posting_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⚠️ varchar, not an enum — a new role is a row and a code change. */
    role: varchar("role", { length: 40 }).notNull(),

    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /** ⭐ One ledger per role per tenant — otherwise posting is non-deterministic. */
    roleUnique: uniqueIndex("sales_posting_accounts_role_key").on(t.tenantId, t.role),
    ledgerIdx: index("sales_posting_accounts_ledger_idx").on(t.tenantId, t.ledgerId),
  }),
);

export type SalesPostingAccount = typeof salesPostingAccounts.$inferSelect;

/* ------------------------------------------------------------------ */
/* ⭐ TIME & BILLING — Phase 63                                         */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EFFECTIVE-DATED AND NEVER OVERWRITTEN. Work done in March bills at
 * March's rate even when the invoice is raised in September. Updating a
 * rate in place silently re-prices every unbilled hour ever worked.
 */
export const billingRates = pgTable(
  "billing_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** NULL means "any". Most specific wins — see `lib/billing/time.ts`. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    roleName: varchar("role_name", { length: 60 }),
    companyId: uuid("company_id"),

    rateMinor: bigint("rate_minor", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).default("INR").notNull(),

    /** ⚠️ Half-open: [from, to). */
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),

    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    lookupIdx: index("billing_rates_lookup_idx").on(t.tenantId, t.effectiveFrom),
    userIdx: index("billing_rates_user_idx").on(t.tenantId, t.userId),
    companyIdx: index("billing_rates_company_idx").on(t.tenantId, t.companyId),
  }),
);

/**
 * 🔴 DURATION IS WHOLE MINUTES, AS AN INTEGER. Never hours as a decimal —
 * a timesheet is hundreds of additions and `0.1 + 0.1 + 0.1` is not 0.3.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    companyId: uuid("company_id"),

    /**
     * ⭐ One column for what a law firm calls a matter, a CA calls an
     * engagement and a consultancy calls a project. One concept, three
     * words.
     */
    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),
    subjectLabel: varchar("subject_label", { length: 255 }),

    entryDate: date("entry_date", { mode: "string" }).notNull(),
    minutes: integer("minutes").notNull(),
    /** The rounded, billable figure. Stored, not derived. */
    billableMinutes: integer("billable_minutes").default(0).notNull(),
    isBillable: boolean("is_billable").default(true).notNull(),

    /** ⚠️ Copied onto the entry so the hour carries its own price. */
    rateMinor: bigint("rate_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    valueMinor: bigint("value_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** 🔴 The client reads this line on the bill. */
    narrative: text("narrative"),

    status: varchar("status", { length: 20 }).default("draft").notNull(),
    invoiceId: uuid("invoice_id"),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    unbilledIdx: index("time_entries_unbilled_idx").on(t.tenantId, t.companyId, t.status),
    userIdx: index("time_entries_user_idx").on(t.tenantId, t.userId, t.entryDate),
    subjectIdx: index("time_entries_subject_idx").on(t.tenantId, t.subjectType, t.subjectId),
    invoiceIdx: index("time_entries_invoice_idx").on(t.tenantId, t.invoiceId),
  }),
);

export type BillingRate = typeof billingRates.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
