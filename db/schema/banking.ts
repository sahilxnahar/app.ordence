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

    /**
     * ⭐⭐ EVERYTHING ON OR BEFORE THIS DATE HAS BEEN EXPLAINED, AND AS
     * OF 0102 THAT IS ENFORCED RATHER THAN ASSERTED.
     *
     * 🔴 BEFORE 0102 THIS COLUMN WAS THE EIGHTH INSTANCE OF THIS
     * CODEBASE'S OLDEST DEFECT: declared, displayed, and read by nothing
     * that could refuse anything. `unmatch` deleted a confirmed match
     * under a signed-off date without a word, so a reconciled month
     * could change underneath a figure somebody had signed.
     *
     * ⚠️ IT IS NOW READ BY `confirmMatch`, by `unmatch`, by
     * `importStatement` and by the `ordence_guard_reconciled_bank_line`
     * trigger in 0102. Written ONLY by signing off a reconciliation,
     * and moved backwards only by reopening one with a reason.
     */
    reconciledTo: date("reconciled_to"),

    /**
     * 🔴🔴 THE ROUNDING TOLERANCE, AND IT IS ZERO UNLESS SOMEBODY SETS IT.
     *
     * ⚠️ A RECONCILIATION THAT BALANCES BECAUSE OF A TOLERANCE IS A
     * RECONCILIATION THAT DOES NOT BALANCE. This exists because a few
     * real accounts carry a permanent paise-level difference from a
     * historic conversion, and the alternative to a configured,
     * per-account, recorded allowance is somebody posting a fake journal
     * to make the screen go green.
     *
     * ⭐ SO IT IS PER ACCOUNT, IT DEFAULTS TO ZERO, `buildBrs` READS IT
     * AT THE COMPARISON, AND ANYTHING IT LETS THROUGH IS STORED ON THE
     * RECONCILIATION AS `differenceAbsorbedMinor` FOREVER. It decides
     * whether a person may sign, never whether the account reconciled.
     */
    reconciliationToleranceMinor: bigint("reconciliation_tolerance_minor", {
      mode: "bigint",
    })
      .default(0n)
      .notNull(),

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

    /**
     * ⭐⭐ THE WHOLE-FILE DUPLICATE GUARD, ADDED IN 0102.
     *
     * ⚠️ `bank_statement_lines.fingerprint` catches a LINE that looks
     * like another line, and it REPORTS rather than refuses because two
     * identical payments on one day are real. That was the only guard
     * there was, so re-importing January simply warned and then wrote
     * every January line a second time.
     *
     * 🔴 A WHOLE FILE IMPORTED TWICE IS A DIFFERENT CLAIM AND CAN BE
     * REFUSED OUTRIGHT. See `lib/banking/statement-digest.ts`.
     *
     * ⚠️ NULLABLE, because every statement imported before 0102 has no
     * digest and backfilling one would be inventing evidence about a
     * file nobody kept. Postgres treats NULLs as distinct in a unique
     * index, so the historic rows neither collide nor block.
     */
    importDigest: varchar("import_digest", { length: 64 }),
  },
  (t) => ({
    accountIdx: index("bank_statements_account_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.periodFrom,
    ),
    /** 🔴 THE SAME FILE CANNOT BE IMPORTED TWICE INTO ONE ACCOUNT. */
    digestUnique: uniqueIndex("bank_statements_import_digest_unique").on(
      t.tenantId,
      t.bankAccountId,
      t.importDigest,
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

/* ================================================================== */
/* ⭐⭐⭐ THE RECONCILIATION EVENT — 0102                                */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 MATCHING IS NOT RECONCILING, AND ONLY THE FIRST EXISTED
 * ══════════════════════════════════════════════════════════════════════
 * `bank_line_matches` is per-line and revocable. Nothing anywhere said
 * "this account was reconciled to this balance as at this date, by this
 * person" — so there was no artefact to hand an auditor, nothing to
 * reproduce a signed figure from, and nothing to stop a signed month
 * changing afterwards.
 *
 * ⭐ THIS ROW IS THE ARTEFACT. It is written once, at sign-off, with the
 * five figures frozen onto it. The reconciliation is NOT re-derived when
 * somebody opens it later: re-deriving it would mean the statement shown
 * in September for March is whatever March looks like in September, which
 * is the precise property a signature is supposed to remove.
 *
 * ⚠️ AND THE ITEMS ARE FROZEN TOO, in `bank_reconciliation_items`. A BRS
 * whose total is stored and whose lines are recomputed foots against
 * nothing.
 */
export const bankReconciliations = pgTable(
  "bank_reconciliations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    /**
     * ⚠️ CASCADE RATHER THAN RESTRICT, AND IT IS A COMPROMISE WORTH
     * NAMING. RESTRICT is what this relationship deserves — a statement
     * that has been reconciled should not be deletable — but the chain
     * from `tenants` is cascade all the way down, so a RESTRICT here
     * would make deleting a tenant impossible and the first person to
     * hit that would remove the constraint rather than the row. Nothing
     * in this tree deletes a statement; the protection that matters is
     * the trigger in 0102, which refuses the change rather than the row.
     */
    statementId: uuid("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),

    /** 🔴 THE LOCK BOUNDARY. Everything on or before this is sealed. */
    reconciledTo: date("reconciled_to").notNull(),

    /**
     * ⭐ WHAT `bank_accounts.reconciled_to` WAS BEFORE THIS SIGN-OFF, so
     * a reopen restores it exactly instead of guessing. Null where this
     * was the first reconciliation on the account.
     */
    previousReconciledTo: date("previous_reconciled_to"),

    bankBalanceMinor: bigint("bank_balance_minor", { mode: "bigint" }).notNull(),
    bookBalanceMinor: bigint("book_balance_minor", { mode: "bigint" }).notNull(),

    /** ⭐ Positive magnitudes. The direction lives in CATEGORY_META. */
    chequesNotPresentedMinor: bigint("cheques_not_presented_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
    depositsNotCreditedMinor: bigint("deposits_not_credited_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
    bankChargesMinor: bigint("bank_charges_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
    directCreditsMinor: bigint("direct_credits_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),

    /** 🔴 book − (bank ∓ the four categories). Zero on an exact statement. */
    differenceMinor: bigint("difference_minor", { mode: "bigint" }).default(0n).notNull(),

    /**
     * ⚠️ THE TOLERANCE AS IT STOOD AT SIGN-OFF, frozen. Reading today's
     * value when re-rendering a two-year-old reconciliation would show a
     * statement that was signed under different rules from the ones
     * printed on it.
     */
    toleranceMinor: bigint("tolerance_minor", { mode: "bigint" }).default(0n).notNull(),

    /**
     * 🔴🔴 WHAT THE TOLERANCE LET THROUGH, RECORDED SO IT IS NOT
     * SWALLOWED. Zero on a statement that footed exactly. Non-zero is an
     * account that did NOT reconcile and was signed anyway, deliberately,
     * and the amount stays on the row forever.
     */
    differenceAbsorbedMinor: bigint("difference_absorbed_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),

    /** signed_off · reopened */
    status: varchar("status", { length: 20 }).default("signed_off").notNull(),

    signedOffAt: timestamp("signed_off_at", { withTimezone: true }).defaultNow().notNull(),
    signedOffBy: uuid("signed_off_by").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),

    /** ⚠️ Reopening is an exceptional act and must be justified. */
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: uuid("reopened_by").references(() => users.id, { onDelete: "set null" }),
    reopenReason: text("reopen_reason"),
  },
  (t) => ({
    accountIdx: index("bank_reconciliations_account_idx").on(
      t.tenantId,
      t.bankAccountId,
      t.reconciledTo,
    ),
    /**
     * 🔴 ONE LIVE SIGN-OFF PER ACCOUNT PER DATE. Partial, so that
     * reopening a March reconciliation and signing a corrected one is
     * possible — which is the whole reason reopening exists.
     */
    liveUnique: uniqueIndex("bank_reconciliations_live_per_date")
      .on(t.tenantId, t.bankAccountId, t.reconciledTo)
      .where(sql`status = 'signed_off'`),
  }),
);

/**
 * ⭐⭐ THE LINES OF THE STATEMENT, FROZEN.
 *
 * 🔴 `source_id` IS NOT A FOREIGN KEY, deliberately. It points at a bank
 * statement line for a bank-side item and at a receipt or a payment for a
 * book-side item, and the whole point of freezing them is that the
 * evidence survives whatever happens to the document afterwards. A
 * cascade here would delete the reason a signed figure was what it was.
 */
export const bankReconciliationItems = pgTable(
  "bank_reconciliation_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    reconciliationId: uuid("reconciliation_id")
      .notNull()
      .references(() => bankReconciliations.id, { onDelete: "cascade" }),

    /** One of RECONCILIATION_CATEGORIES. Derived, never chosen. */
    category: varchar("category", { length: 40 }).notNull(),
    /** bank · books */
    side: varchar("side", { length: 10 }).notNull(),

    sourceId: uuid("source_id").notNull(),
    sourceKind: varchar("source_kind", { length: 30 }),

    occurredOn: date("occurred_on").notNull(),
    /** 🔴 SIGNED. Positive is money IN, as everywhere else here. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    description: text("description").notNull(),
  },
  (t) => ({
    reconciliationIdx: index("bank_reconciliation_items_parent_idx").on(
      t.tenantId,
      t.reconciliationId,
      t.category,
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

export const bankReconciliationsRelations = relations(
  bankReconciliations,
  ({ one, many }) => ({
    account: one(bankAccounts, {
      fields: [bankReconciliations.bankAccountId],
      references: [bankAccounts.id],
    }),
    statement: one(bankStatements, {
      fields: [bankReconciliations.statementId],
      references: [bankStatements.id],
    }),
    items: many(bankReconciliationItems),
  }),
);

export const bankReconciliationItemsRelations = relations(
  bankReconciliationItems,
  ({ one }) => ({
    reconciliation: one(bankReconciliations, {
      fields: [bankReconciliationItems.reconciliationId],
      references: [bankReconciliations.id],
    }),
  }),
);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankStatement = typeof bankStatements.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;
export type BankLineMatch = typeof bankLineMatches.$inferSelect;
export type BankReconciliation = typeof bankReconciliations.$inferSelect;
export type BankReconciliationItem = typeof bankReconciliationItems.$inferSelect;

/** ⚠️ Kept next to the table so the two cannot drift. */
export const MATCHED_KINDS = Object.freeze([
  "customer_receipt",
  "vendor_payment",
  "journal_entry",
] as const);

