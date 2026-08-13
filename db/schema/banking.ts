/**
 * Ordence — ⭐⭐⭐ BANK RECONCILIATION
 * Version: v1.18.0-alpha
 *
 * Mirrors `SQL-FILES/0070_bank_reconciliation.sql`. The reasoning lives
 * there; the shape lives here.
 *
 * 🔴 THE STATEMENT IS THE TRUTH ABOUT THE BANK. THE LEDGER IS THE TRUTH
 * ABOUT THE BUSINESS. RECONCILIATION EXPLAINS THE DIFFERENCE, IT DOES
 * NOT REMOVE IT. Nothing in this file gives anybody a way to edit a
 * statement line, and that is the point rather than an oversight.
 */

import { relations, sql } from "drizzle-orm";
import {
  bigint,
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
import { ledgers } from "./accounting";

/**
 * ⭐ A LEDGER IS NOT A BANK ACCOUNT. The chart of accounts has a ledger
 * called "HDFC current"; this is the fact that it corresponds to a real
 * account with a real statement that arrives monthly and disagrees.
 */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),

    label: varchar("label", { length: 160 }).notNull(),
    bankName: varchar("bank_name", { length: 160 }).notNull(),
    /**
     * ⚠️ LAST FOUR ONLY. A full account number in a table half the
     * office can read is a full account number in a screenshot.
     */
    accountLast4: varchar("account_last4", { length: 4 }),
    ifsc: varchar("ifsc", { length: 11 }),

    /** ⭐ Everything on or before this date has been explained. */
    reconciledTo: date("reconciled_to"),

    isActive: boolean("is_active").default(true).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /** 🔴 Two bank accounts on one ledger cannot be reconciled at all. */
    ledgerUnique: uniqueIndex("bank_accounts_one_per_ledger").on(t.tenantId, t.ledgerId),
    tenantIdx: index("bank_accounts_tenant_idx").on(t.tenantId),
  }),
);

export const bankStatements = pgTable(
  "bank_statements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),

    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),

    /**
     * ⭐ THE BANK'S OWN FIGURES, KEPT SO THE ARITHMETIC CAN BE CHECKED
     * RATHER THAN TRUSTED. If the lines do not add up to the closing
     * balance the import is incomplete, and that is worth knowing before
     * somebody spends a morning matching it.
     */
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "bigint" }).notNull(),
    closingBalanceMinor: bigint("closing_balance_minor", { mode: "bigint" }).notNull(),

    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
    importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
    sourceFilename: varchar("source_filename", { length: 400 }),

    lineCount: integer("line_count").default(0).notNull(),
  },
  (t) => ({
    accountIdx: index("bank_statements_account_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.periodFrom,
    ),
  }),
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),

    valueDate: date("value_date").notNull(),

    /**
     * 🔴 ONE SIGNED NUMBER. Positive is money IN.
     *
     * ⚠️ Indian banks export two columns, headed withdrawal and deposit,
     * and which is which varies by bank. The importer collapses that
     * into a sign before it reaches here, because a pair of nullable
     * columns means every query downstream has to get the same COALESCE
     * right forever.
     */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    narration: text("narration").notNull(),
    bankReference: varchar("bank_reference", { length: 200 }),

    /**
     * ⭐⭐ THE DUPLICATE GUARD. Date, exact amount and flattened
     * narration: what a bank cannot change between two exports of the
     * same line.
     *
     * 🔴 INDEXED, NOT UNIQUE. Two genuinely separate identical payments
     * on one day are possible, and refusing them would be wrong. The
     * screen reports what looks duplicated; a person decides.
     */
    fingerprint: varchar("fingerprint", { length: 400 }).notNull(),
  },
  (t) => ({
    statementIdx: index("bank_statement_lines_statement_idx").on(
      t.tenantId,
      t.statementId,
      t.valueDate,
    ),
    fingerprintIdx: index("bank_statement_lines_fingerprint_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.fingerprint,
    ),
  }),
);

/**
 * ⭐ THE MATCHER PROPOSES AND NEVER DECIDES, so every row here was made
 * by a person and records both what the matcher thought and who agreed.
 */
export const bankLineMatches = pgTable(
  "bank_line_matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    statementLineId: uuid("statement_line_id")
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: "cascade" }),

    /** customer_receipt · vendor_payment · journal_entry */
    matchedKind: varchar("matched_kind", { length: 30 }).notNull(),
    matchedId: uuid("matched_id").notNull(),

    proposedScore: integer("proposed_score"),
    wasAmbiguous: boolean("was_ambiguous").default(false).notNull(),

    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
  },
  (t) => ({
    /**
     * 🔴🔴 BOTH HALVES ARE REQUIRED. Matching one receipt to two
     * statement lines explains twice as much money as actually moved,
     * and the residue still comes out to zero because the same rupees
     * were counted on both sides.
     */
    onePerLine: uniqueIndex("bank_line_matches_one_per_line").on(t.statementLineId),
    onePerDocument: uniqueIndex("bank_line_matches_one_per_document").on(
      t.tenantId,
      t.matchedKind,
      t.matchedId,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const bankAccountsRelations = relations(bankAccounts, ({ one, many }) => ({
  ledger: one(ledgers, {
    fields: [bankAccounts.ledgerId],
    references: [ledgers.id],
  }),
  statements: many(bankStatements),
}));

export const bankStatementsRelations = relations(bankStatements, ({ one, many }) => ({
  account: one(bankAccounts, {
    fields: [bankStatements.bankAccountId],
    references: [bankAccounts.id],
  }),
  lines: many(bankStatementLines),
}));

export const bankStatementLinesRelations = relations(
  bankStatementLines,
  ({ one, many }) => ({
    statement: one(bankStatements, {
      fields: [bankStatementLines.statementId],
      references: [bankStatements.id],
    }),
    matches: many(bankLineMatches),
  }),
);

export const bankLineMatchesRelations = relations(bankLineMatches, ({ one }) => ({
  line: one(bankStatementLines, {
    fields: [bankLineMatches.statementLineId],
    references: [bankStatementLines.id],
  }),
}));

export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankStatement = typeof bankStatements.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;
export type BankLineMatch = typeof bankLineMatches.$inferSelect;

/** ⚠️ Kept next to the table so the two cannot drift. */
export const MATCHED_KINDS = Object.freeze([
  "customer_receipt",
  "vendor_payment",
  "journal_entry",
] as const);

void sql;
