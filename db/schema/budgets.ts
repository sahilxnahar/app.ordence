/**
 * Ordence — ⭐⭐⭐ COST CENTRES AND BUDGETS
 * Version: v1.47.0-alpha · Batch 68
 *
 * Mirrors `SQL-FILES/0084_cost_centres_and_budgets.sql`. The reasoning is
 * written out in both, because the two files are read by different people
 * at different moments — one by whoever is about to run a migration
 * against a customer's database at 2am, one by whoever is about to add a
 * column — and a decision recorded in only one of them is a decision the
 * other reader gets to re-take without knowing they are re-taking it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 ① THE COST CENTRE HANGS OFF THE JOURNAL **LINE**, NEVER THE
 *          TRANSACTION HEADER
 * ══════════════════════════════════════════════════════════════════════
 * This is the decision the whole batch is built on and it is the one
 * that cannot be changed later, so it is stated first and at length.
 *
 * A header dimension — `transactions.cost_centre_id` — is smaller, it is
 * one column instead of a join, and it is what almost every first
 * attempt at this feature does. It cannot represent the ordinary case:
 *
 *   One electricity bill of ₹1,20,000. ₹80,000 belongs to Production
 *   and ₹40,000 belongs to the Head Office. That is ONE invoice, ONE
 *   supplier, ONE payable, and TWO cost centres. The credit leg (the
 *   vendor) belongs to neither.
 *
 * With a header dimension the only ways to record that are to split the
 * bill into two transactions — which invents a document the supplier
 * never issued, and gives the payables ledger two open items for one
 * invoice that will be paid with one cheque — or to code the whole
 * ₹1,20,000 to one department and accept that the department accounts
 * are wrong. Both are worse than having no cost centres at all, because
 * both produce a departmental P&L that looks complete.
 *
 * ⚠️ AND THE COST OF GETTING THIS WRONG IS NOT "ADD A COLUMN LATER".
 * A header dimension that has been in use for a year has coded a year of
 * history at the wrong grain. Moving to line level means every existing
 * transaction has to be re-coded by hand — by somebody who was not there
 * when the invoices were entered — or the first year of departmental
 * reporting is abandoned. `journal_entries` is append-only (0005 §4), so
 * "re-coded by hand" is not even available: the fix would be a reversal
 * and a re-post of every affected transaction.
 *
 * ⭐ THE CREDIT LEG IS DELIBERATELY ALLOWED TO CARRY NOTHING. A payable,
 * a bank balance and a share of capital do not belong to a department;
 * only income and expenditure do. A schema that demanded a cost centre
 * on every leg would force somebody to invent one for the vendor.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 ② THE UN-COSTED BUCKET IS A FIRST-CLASS ROW, NOT AN OMISSION
 * ══════════════════════════════════════════════════════════════════════
 * `journal_entries.cost_centre_id` is NULLABLE, and NULL is not "missing
 * data to be tidied up". It is a bucket with a name — `lib/accounting/
 * cost-centre.ts#UNCOSTED_KEY` — that appears on every screen that groups
 * by cost centre, with its own subtotal, whether or not anybody wants to
 * look at it.
 *
 * ⚠️ THE TWO WAYS THIS GOES WRONG, BOTH OF THEM SILENT:
 *
 *   • DROP the NULLs (an inner join to `cost_centres`, which is what an
 *     ORM writes by default). The departmental P&L now sums to less than
 *     the P&L, and nothing on the page says by how much. Every number on
 *     it is individually right.
 *   • LUMP the NULLs into the first cost centre, or into a "General"
 *     default. Now the total is right and one department is carrying
 *     everybody else's uncoded costs. The manager of that department
 *     disputes their own numbers and is correct to.
 *
 * 🔴 A VARIANCE REPORT WHOSE ACTUALS DO NOT SUM TO THE P&L IS A REPORT
 * NOBODY CAN DEFEND — not to a board, not to a bank, and not to the
 * department head whose bonus depends on it. So the bucket is visible,
 * and `lib/accounting/budget.ts` reconciles the sum of the buckets
 * against the P&L by an independent route before a single figure is
 * rendered.
 *
 * ⭐ AND ON DAY ONE EVERY RUPEE IS IN THAT BUCKET. Nothing in the
 * product writes `cost_centre_id` yet — see the note on the column in
 * `db/schema/accounting.ts`. A design that treated the un-costed bucket
 * as an edge case would ship a screen that is empty and reconciles to
 * nothing on the first day of use.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ③ A BUDGET PERIOD IS A `financial_periods` ROW. THERE IS NO SECOND
 *      CALENDAR IN THIS FILE.
 * ══════════════════════════════════════════════════════════════════════
 * The obvious thing is a `budget_periods` table with a start and an end.
 * It is wrong for two reasons that both cost money:
 *
 *   • BUDGET VERSUS ACTUAL WOULD BE COMPARING TWO DIFFERENT WINDOWS.
 *     A budget for "April" that runs 1–30 April against actuals for a
 *     financial period that runs 1 April–2 May (because the workspace
 *     closes on the first working day of the month) is a variance made
 *     of the calendar. Sharing the row makes the two windows the same
 *     window by construction rather than by discipline.
 *
 *   • 🔴 A CLOSED PERIOD MUST NOT BE SILENTLY EDITABLE, AND
 *     `financial_periods.status` IS ALREADY THE ANSWER TO THAT QUESTION
 *     for the ledger. A second calendar would need its own idea of
 *     "closed", which would drift from the first one, and the drift is
 *     invisible: a budget quietly edited after the month was reported is
 *     a variance that changed after somebody explained it.
 *
 * The refusal is enforced in three places on purpose — a `check`
 * constraint cannot see another table, so the database enforces it with
 * a TRIGGER (0084 §5), the action refuses before the write with a
 * sentence a human can act on, and the UI does not render the field.
 * The trigger is the one that survives a future service written by
 * somebody who never read this file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ④ A BUDGET LINE IS PER LEDGER **AND** PER COST CENTRE, NOT PER COST
 *      CENTRE ALONE
 * ══════════════════════════════════════════════════════════════════════
 * "Budget ₹40,00,000 for Production this quarter" is not a budget you
 * can report a variance against, because Production has revenue as well
 * as costs and the two move in opposite directions. Netting them gives a
 * department that is on budget while its costs are 30% over and its
 * revenue is 30% over too — which is not the same business at all.
 *
 * So the grain is (period, ledger, cost centre) and the ledger carries
 * the account type, which is what decides the sign. See
 * `lib/accounting/budget.ts` for the sign convention, stated once.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT HAVE
 * ══════════════════════════════════════════════════════════════════════
 * NO HIERARCHY. `cost_centres` is a flat list with no `parent_id`. A tree
 * needs a roll-up rule, a cycle check, and an answer to "is a budget on a
 * parent the sum of its children or a cap over them" — and the two
 * answers give different variances for the same data. A flat list with
 * codes people can group by eye is honest about what it is; a half-built
 * tree reports a total nobody can trace.
 *
 * NO BUDGET VERSIONS. There is no "original" and "revised" budget. A
 * revision overwrites, and the previous figure survives in `audit_logs`
 * via `writeAudit`. Versioning is a real requirement and the version of
 * it that gets bolted on — a `version` column with no rule about which
 * one a report reads — silently gives two people two different variances
 * for the same month.
 *
 * NO CASH-FLOW OR BALANCE-SHEET BUDGETING. Only revenue and expense
 * ledgers may be budgeted, enforced by the action rather than the schema
 * because `ledgers.account_type` lives in another table. Budgeting a
 * bank balance is a forecast, not a budget, and it does not belong in a
 * variance report that claims to reconcile to the P&L.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  bigint,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { ledgers, financialPeriods } from "./accounting";

/* ------------------------------------------------------------------ */
/* ① COST CENTRES — THE DIMENSION                                      */
/* ------------------------------------------------------------------ */

/**
 * A department, a branch, a project, a product line — whatever the
 * business actually manages costs by. Ordence does not decide which; it
 * decides that there is exactly one such list and that a journal line
 * may point at one row of it.
 *
 * ⚠️ THIS IS NOT `projects`. A construction project is a thing with a
 * contract, a BOQ, a site and a completion date, and `cost-control.ts`
 * already reports against it. A cost centre is a REPORTING dimension
 * that may or may not correspond to anything physical — "Head Office",
 * "South Region", "Legacy Products" — and a business commonly wants both
 * at once. Forcing one to be the other means a business with three
 * projects and two departments can report on one of those facts.
 */
export const costCentres = pgTable(
  "cost_centres",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * The short handle people type and sort by — "PROD", "HO", "SOUTH".
     * ⚠️ UNIQUE PER TENANT, CASE-INSENSITIVELY. "prod" and "PROD" as two
     * cost centres is two departments with one name, and every report
     * that groups by code shows the split without saying it split.
     */
    code: varchar("code", { length: 40 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),

    /**
     * 🔴 ARCHIVED, NOT DELETED, AND THERE IS NO `deleted_at` HERE.
     *
     * A cost centre that has been used is referenced by journal lines
     * that are append-only and can never be re-coded. Deleting the row —
     * even softly — turns every one of those lines into a bucket with no
     * name, and last year's departmental P&L becomes a column headed by
     * a UUID. The database refuses the delete outright (ON DELETE
     * RESTRICT on the journal column) and this flag is what "we do not
     * use that department any more" actually means: it disappears from
     * the picker and stays on the reports.
     */
    isActive: boolean("is_active").default(true).notNull(),

    /** Sort order on the picker and on the reports. Ties break by code. */
    displayOrder: bigint("display_order", { mode: "number" }).default(100).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("cost_centres_tenant_idx").on(t.tenantId),
    /**
     * ⭐ THE COMPOSITE KEY EXISTS SO ANOTHER TABLE CAN POINT AT
     * (id, tenant_id) TOGETHER. A plain FK on `id` alone lets one
     * tenant's journal line reference another tenant's cost centre — RLS
     * hides the row on read and does nothing whatsoever about the write,
     * because the FK check runs as the system. See 0084 §2.
     */
    idTenantUnique: uniqueIndex("cost_centres_id_tenant_key").on(t.id, t.tenantId),
    codeUnique: uniqueIndex("cost_centres_code_key").on(t.tenantId, sql`upper(${t.code})`),
    activeIdx: index("cost_centres_active_idx").on(t.tenantId, t.isActive, t.displayOrder),

    /** A blank code sorts and groups as a distinct, invisible bucket. */
    codeNotBlank: check("cost_centres_code_not_blank", sql`length(btrim(${t.code})) > 0`),
    nameNotBlank: check("cost_centres_name_not_blank", sql`length(btrim(${t.name})) > 0`),
  }),
);

/* ------------------------------------------------------------------ */
/* ② BUDGET LINES — ONE NUMBER PER PERIOD PER LEDGER PER COST CENTRE   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE GRAIN IS (period, ledger, cost centre) AND THE UNIQUE INDEX
 * SAYS SO WITH `NULLS NOT DISTINCT`.
 *
 * 🔴 `cost_centre_id` IS NULLABLE HERE AND IT MEANS EXACTLY WHAT IT
 * MEANS ON THE JOURNAL LINE: the un-costed bucket. It does NOT mean "all
 * cost centres" and it does NOT mean "unallocated headroom".
 *
 * ⚠️ THIS IS THE SINGLE MOST IMPORTANT SENTENCE IN THIS TABLE. If NULL
 * meant "the whole company" on the budget side and "no department" on
 * the actual side, then budget and actual would be answering different
 * questions in the one row where they are subtracted from each other,
 * and the variance would be a number with no meaning that still prints
 * in bold. Because NULL means the same thing on both sides, the buckets
 * line up one-for-one and the totals reconcile by construction.
 *
 * ⚠️ AND THE UNIQUENESS OF THE UN-COSTED ROW IS LOAD-BEARING. Postgres
 * treats NULLs as distinct in a unique index by default, so a single
 * four-column unique index would let a workspace hold five separate
 * un-costed budget rows for the same ledger and period, all of them
 * legal, and the report would show whichever one the query reached
 * first — a budget that changes when the planner does.
 *
 * ⭐ TWO PARTIAL UNIQUE INDEXES RATHER THAN ONE `NULLS NOT DISTINCT`.
 * They are exactly equivalent, and `NULLS NOT DISTINCT` cannot be
 * expressed by Drizzle at the version this repo pins. A constraint that
 * exists only in the SQL file is a constraint that `drizzle-kit push`
 * does not know about and can drop; two partial indexes are written the
 * same way in both files and stay the same thing.
 */
export const budgetLines = pgTable(
  "budget_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * 🔴 THE SAME PERIOD ROW THE LEDGER LOCK USES. See ③ in the header.
     * ON DELETE RESTRICT: deleting a period that has a budget against it
     * would leave a figure nobody can date.
     */
    periodId: uuid("period_id")
      .notNull()
      .references(() => financialPeriods.id, { onDelete: "restrict" }),

    /**
     * Revenue or expense only. The restriction is enforced by
     * `server/actions/budgets.ts` and re-checked by 0084's trigger,
     * because `account_type` lives on `ledgers` and a CHECK constraint
     * cannot read another table.
     */
    ledgerId: uuid("ledger_id")
      .notNull()
      .references(() => ledgers.id, { onDelete: "restrict" }),

    /** NULL is the un-costed bucket. Read the block comment above. */
    costCentreId: uuid("cost_centre_id").references(() => costCentres.id, {
      onDelete: "restrict",
    }),

    /**
     * 🔴 BIGINT PAISE. NOT `numeric`, NOT a float, and never a
     * JavaScript `number` on the way in or out.
     *
     * ⚠️ AND IT IS `mode: "bigint"`, WHICH IS THE WHOLE POINT. Drizzle's
     * default for a bigint column is `mode: "number"`, which hands the
     * application a double: exact to ₹90,07,19,92,54,740.99 and silently
     * wrong above it. That ceiling is inside the range of a real estate
     * developer's annual revenue budget stated in paise.
     *
     * ⭐ ALWAYS POSITIVE, LIKE `journal_entries.amount`. A budgeted
     * expense of ₹5,00,000 is `50000000`, and a budgeted revenue of
     * ₹5,00,000 is also `50000000`. The direction comes from the
     * ledger's account type, never from a sign — one way to express a
     * thing is one way to get it wrong.
     */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),

    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("budget_lines_tenant_idx").on(t.tenantId),
    /** The report's own query: one period, every line, in ledger order. */
    periodIdx: index("budget_lines_period_idx").on(t.tenantId, t.periodId, t.ledgerId),
    costCentreIdx: index("budget_lines_cost_centre_idx").on(t.tenantId, t.costCentreId),

    /**
     * ⚠️ TWO PARTIAL INDEXES, ONE GRAIN — see the block comment above.
     * The pair is equivalent to a single `NULLS NOT DISTINCT` index and,
     * unlike it, is expressible in both this file and the migration.
     */
    grainUnique: uniqueIndex("budget_lines_grain_key")
      .on(t.tenantId, t.periodId, t.ledgerId, t.costCentreId)
      .where(sql`${t.costCentreId} IS NOT NULL`),
    grainUncostedUnique: uniqueIndex("budget_lines_grain_uncosted_key")
      .on(t.tenantId, t.periodId, t.ledgerId)
      .where(sql`${t.costCentreId} IS NULL`),

    /**
     * 🔴 NON-NEGATIVE, AND ZERO IS LEGAL AND MEANINGFUL. "We budgeted
     * nothing for entertainment this quarter" is a decision somebody
     * made, and it is different from the absence of a row, which means
     * nobody has looked. `lib/accounting/budget.ts` reports the two
     * differently and neither is rendered as the other.
     */
    amountNonNegative: check("budget_lines_amount_non_negative", sql`${t.amountMinor} >= 0`),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const costCentresRelations = relations(costCentres, ({ one, many }) => ({
  tenant: one(tenants, { fields: [costCentres.tenantId], references: [tenants.id] }),
  budgetLines: many(budgetLines),
}));

export const budgetLinesRelations = relations(budgetLines, ({ one }) => ({
  tenant: one(tenants, { fields: [budgetLines.tenantId], references: [tenants.id] }),
  period: one(financialPeriods, {
    fields: [budgetLines.periodId],
    references: [financialPeriods.id],
  }),
  ledger: one(ledgers, { fields: [budgetLines.ledgerId], references: [ledgers.id] }),
  costCentre: one(costCentres, {
    fields: [budgetLines.costCentreId],
    references: [costCentres.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type CostCentre = typeof costCentres.$inferSelect;
export type NewCostCentre = typeof costCentres.$inferInsert;
export type BudgetLine = typeof budgetLines.$inferSelect;
export type NewBudgetLine = typeof budgetLines.$inferInsert;
