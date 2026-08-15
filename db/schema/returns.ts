/**
 * Ordence — ⭐⭐⭐ THE MONTHLY RETURN
 * Version: v1.24.0-alpha · Batch 16
 *
 * Mirrors `SQL-FILES/0077_monthly_return.sql`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A FILED RETURN IS EVIDENCE, NOT A DRAFT
 * ══════════════════════════════════════════════════════════════════════
 * Once a 3B carries an acknowledgement number it has been submitted to
 * the Government and the figures in it are what was declared. Editing
 * one afterwards produces a record that disagrees with what the
 * department holds, and the department's copy is the one that counts.
 *
 * ⚠️ SO A FILED RETURN IS FROZEN BY A TRIGGER, and the remedy for a
 * mistake is the remedy the law provides: correct it in a LATER period.
 * That is genuinely how GST works — there is no amendment of a filed 3B,
 * only an adjustment in the next one — and a system that lets somebody
 * edit history teaches them a workflow that does not exist.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { transactions } from "./accounting";

export const returnStatusEnum = pgEnum("gst_return_status", [
  /** Assembled from the ledger. Recomputable. */
  "draft",
  /** ⭐ Signed off internally. Figures frozen, ready to key into the portal. */
  "finalised",
  /** Acknowledged by the portal. Terminal, and evidence. */
  "filed",
  /** Abandoned with a reason. Never deleted. */
  "superseded",
]);

/**
 * ⚠️ ONE ROW PER GSTIN PER PERIOD PER RETURN TYPE.
 *
 * 🔴 PER GSTIN, NOT PER TENANT. A business registered in three States
 * files three separate 3Bs with three separate set-offs, and credit does
 * not move between them. Keying this on the tenant alone would merge
 * three returns into one and produce a set-off that is illegal in all
 * three States.
 */
export const gstReturns = pgTable(
  "gst_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** "GSTR3B" for now. The column exists so 3B is not the only one. */
    returnType: varchar("return_type", { length: 12 }).default("GSTR3B").notNull(),
    gstin: varchar("gstin", { length: 15 }).notNull(),
    /** YYYY-MM. */
    taxPeriod: varchar("tax_period", { length: 7 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    status: returnStatusEnum("status").default("draft").notNull(),

    /* ---- What was declared, frozen at finalisation --------------- */
    outwardTaxableValueMinor: numeric("outward_taxable_value_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    outputIgstMinor: numeric("output_igst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    outputCgstMinor: numeric("output_cgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    outputSgstMinor: numeric("output_sgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    outputCessMinor: numeric("output_cess_minor", { precision: 18, scale: 0 }).default("0").notNull(),

    rcmIgstMinor: numeric("rcm_igst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    rcmCgstMinor: numeric("rcm_cgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    rcmSgstMinor: numeric("rcm_sgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    rcmCessMinor: numeric("rcm_cess_minor", { precision: 18, scale: 0 }).default("0").notNull(),

    itcIgstMinor: numeric("itc_igst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    itcCgstMinor: numeric("itc_cgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    itcSgstMinor: numeric("itc_sgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    itcCessMinor: numeric("itc_cess_minor", { precision: 18, scale: 0 }).default("0").notNull(),

    itcReversedIgstMinor: numeric("itc_reversed_igst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    itcReversedCgstMinor: numeric("itc_reversed_cgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    itcReversedSgstMinor: numeric("itc_reversed_sgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    itcReversedCessMinor: numeric("itc_reversed_cess_minor", { precision: 18, scale: 0 }).default("0").notNull(),

    /* ---- The answer --------------------------------------------- */
    cashIgstMinor: numeric("cash_igst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    cashCgstMinor: numeric("cash_cgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    cashSgstMinor: numeric("cash_sgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    cashCessMinor: numeric("cash_cess_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    interestMinor: numeric("interest_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    lateFeeMinor: numeric("late_fee_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    totalCashMinor: numeric("total_cash_minor", { precision: 18, scale: 0 }).default("0").notNull(),

    /** Credit left after the set-off, carried into next month. */
    carriedIgstMinor: numeric("carried_igst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    carriedCgstMinor: numeric("carried_cgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    carriedSgstMinor: numeric("carried_sgst_minor", { precision: 18, scale: 0 }).default("0").notNull(),
    carriedCessMinor: numeric("carried_cess_minor", { precision: 18, scale: 0 }).default("0").notNull(),

    /** ⭐ The set-off, move by move, with the rule that permitted each. */
    setoffMoves: jsonb("setoff_moves").$type<unknown[]>().default([]).notNull(),
    notes: jsonb("notes").$type<string[]>().default([]).notNull(),
    problems: jsonb("problems").$type<string[]>().default([]).notNull(),

    dueOn: date("due_on"),

    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    finalisedBy: uuid("finalised_by").references(() => users.id, { onDelete: "set null" }),

    /** ⚠️ The portal's acknowledgement. Its presence is what "filed" means. */
    arn: varchar("arn", { length: 40 }),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    filedBy: uuid("filed_by").references(() => users.id, { onDelete: "set null" }),

    /** ⭐ The reclassification journal. */
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "restrict",
    }),

    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersedeReason: text("supersede_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantScoped: uniqueIndex("gst_returns_id_tenant_key").on(t.id, t.tenantId),
    /**
     * 🔴 ONE LIVE RETURN PER GSTIN PER PERIOD PER TYPE. Two 3Bs for one
     * July would post the reclassification twice and clear the input tax
     * account by double what was actually utilised.
     */
    onePerPeriod: uniqueIndex("gst_returns_one_live_per_period")
      .on(t.tenantId, t.gstin, t.returnType, t.taxPeriod)
      .where(sql`status <> 'superseded'`),
    statusIdx: index("gst_returns_status_idx").on(t.tenantId, t.status, t.taxPeriod),
    periodOrdered: check("gst_returns_period_ordered", sql`${t.periodEnd} >= ${t.periodStart}`),
  }),
);

export type GstReturn = typeof gstReturns.$inferSelect;
