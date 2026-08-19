/**
 * Ordence — Analytics Views
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * VIEWS, NOT TABLES — AND DEFINITELY NOT MATERIALIZED VIEWS
 * ══════════════════════════════════════════════════════════════════════
 * These are ordinary SQL views: stored queries that run at read time.
 * Three alternatives were considered and rejected.
 *
 * SUMMARY TABLES kept up to date by triggers would be fastest to read and
 * would introduce a second source of truth for money. When the ledger and
 * the summary disagree — and eventually they do — you have two numbers and
 * no way to tell which is wrong. Not a trade worth making for a dashboard.
 *
 * MATERIALIZED VIEWS are the obvious middle ground and are wrong HERE for a
 * specific reason: a materialized view stores its rows, and RLS cannot be
 * applied to stored aggregate rows the way `security_invoker` applies to a
 * live query. You would end up with one physical copy containing every
 * tenant's data and a filter in front of it — which is precisely the shape
 * of the leak this phase exists to avoid. They also need refreshing, and
 * `REFRESH MATERIALIZED VIEW` needs a scheduler this Hobby-tier stack does
 * not have.
 *
 * PLAIN VIEWS re-run their aggregate on every read. For the row counts a
 * single tenant produces — thousands of journal entries, not billions —
 * that is a few milliseconds against indexed columns, and it is always
 * correct. If a tenant ever outgrows this, the upgrade path is a
 * materialized view PER TENANT or a summary table with a reconciliation
 * job, and both are a real project rather than a config change.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ EVERY VIEW BELOW IS CREATED WITH `security_invoker = true`
 * ══════════════════════════════════════════════════════════════════════
 * PostgreSQL views do NOT inherit Row-Level Security by default. A view
 * runs as its OWNER, so a view over `journal_entries` owned by the table
 * owner returns EVERY tenant's entries to anyone who can select from it.
 *
 * Verified on PostgreSQL 16 before these were written: a session pinned to
 * one tenant saw 6 tenants through a naive view and 1 through a
 * `security_invoker` view.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND SINCE 0104, EVERY VIEW CARRIES THE CURRENCY IT SUMMED
 * ══════════════════════════════════════════════════════════════════════
 * `assets`, `contracts` and `transactions` all carry a `currency` column and
 * all three views ignored it until `0104_analytics_views_carry_currency.sql`.
 * A `sum()` over a mixed-currency set is not a wrong ROW anybody notices — it
 * is a plausible number in the units of nothing. The `currency` column added
 * to each view below is a GROUPING KEY: the consumer reports one labelled
 * figure per currency and never adds across them.
 *
 * The definitions live in `SQL-FILES/0008_phase10_analytics.sql`, as amended
 * by `SQL-FILES/0104_analytics_views_carry_currency.sql`, because
 * `pgView(...).existing()` below only DESCRIBES the shape for Drizzle's
 * type system — it does not create anything, and it cannot express the
 * `security_invoker` option. Declaring the views here with `.as(...)` would
 * let `drizzle-kit push` create them WITHOUT that option, which is exactly
 * the leak. The SQL file is the single source of truth for their
 * definition; this file is the source of truth for their TYPES.
 */

import { pgView, uuid, varchar, integer, numeric, date, bigint } from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* ASSET PORTFOLIO                                                     */
/* ------------------------------------------------------------------ */

/**
 * One row per (tenant, asset type, status).
 *
 * `.existing()` tells Drizzle "this object already exists; describe it,
 * do not attempt to create it". That is deliberate — see the header.
 */
export const vAssetPortfolio = pgView("v_asset_portfolio", {
  tenantId: uuid("tenant_id").notNull(),
  assetType: varchar("asset_type", { length: 50 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  assetCount: integer("asset_count").notNull(),
  /**
   * NUMERIC, surfaced to TypeScript as a string.
   *
   * Drizzle maps `numeric` to `string` and that is correct rather than
   * inconvenient: `9007199254740993` and a rupee value with two decimals
   * both survive a string round-trip exactly, and neither survives a
   * JavaScript `number`. The application formats it for display without
   * ever parsing it to a float.
   */
  totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull(),
  totalArea: numeric("total_area", { precision: 20, scale: 2 }).notNull(),
  totalQuantity: bigint("total_quantity", { mode: "number" }).notNull(),
  /**
   * ⭐ ADDED BY `0104_analytics_views_carry_currency.sql`, AND IT IS A
   * GROUPING KEY, NOT A DECORATION.
   *
   * `assets.currency` has existed since the table did. The view ignored it
   * until 0104, so `total_value` was `sum(value_amount)` over rupee land and
   * dollar plant together — a number in the units of nothing, printed on a
   * dashboard tile as though it were money.
   *
   * ⚠️ NEVER ADD `totalValue` ACROSS ROWS THAT DIFFER HERE. The counts and
   * the area may be added; the value may not.
   */
  currency: varchar("currency", { length: 3 }).notNull(),
}).existing();

/* ------------------------------------------------------------------ */
/* DAILY LEDGER                                                        */
/* ------------------------------------------------------------------ */

/**
 * Exactly 30 rows per tenant — one per day, including days with no
 * activity.
 *
 * The zero-days matter. A `GROUP BY date` returns rows only where something
 * happened, and a bar chart drawn from that renders three transactions in a
 * fortnight as three adjacent bars, which reads as three consecutive
 * trading days. The view generates the full date spine so a quiet day is an
 * explicit zero.
 */
export const vLedgerDaily = pgView("v_ledger_daily", {
  tenantId: uuid("tenant_id").notNull(),
  day: date("day").notNull(),
  debits: numeric("debits", { precision: 20, scale: 2 }).notNull(),
  credits: numeric("credits", { precision: 20, scale: 2 }).notNull(),
  /** Signed: debits − credits. Computed in SQL so rounding happens once. */
  netMovement: numeric("net_movement", { precision: 20, scale: 2 }).notNull(),
  transactionCount: integer("transaction_count").notNull(),
  /**
   * ⭐ ADDED BY `0104_analytics_views_carry_currency.sql`.
   *
   * 🔴 IT COMES FROM `transactions.currency`, NOT FROM THE JOURNAL LINE.
   * `journal_entries` has no currency column of its own; every entry belongs
   * to exactly one transaction and inherits that transaction's currency.
   *
   * ⚠️ SO THE SPINE IS 30 ROWS PER (TENANT, CURRENCY), not 30 per tenant. A
   * consumer that expects exactly 30 rows is making an assumption that holds
   * only for a single-currency workspace.
   */
  currency: varchar("currency", { length: 3 }).notNull(),
}).existing();

/* ------------------------------------------------------------------ */
/* CONTRACT PIPELINE                                                   */
/* ------------------------------------------------------------------ */

/** One row per (tenant, contract status). */
export const vContractPipeline = pgView("v_contract_pipeline", {
  tenantId: uuid("tenant_id").notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  contractCount: integer("contract_count").notNull(),
  totalValue: numeric("total_value", { precision: 20, scale: 2 }).notNull(),
  signedCount: integer("signed_count").notNull(),
  onHoldCount: integer("on_hold_count").notNull(),
  /** Expiring within 30 days — the number that should prompt an action. */
  expiringSoonCount: integer("expiring_soon_count").notNull(),
  /**
   * ⭐ ADDED BY `0104_analytics_views_carry_currency.sql`. `contracts.currency`
   * was always there and the pipeline total always ignored it.
   *
   * ⚠️ The COUNTS may be summed across currency groups — "17 contracts, 3
   * expiring" is true in any currency. `totalValue` may not.
   */
  currency: varchar("currency", { length: 3 }).notNull(),
}).existing();

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type AssetPortfolioRow = typeof vAssetPortfolio.$inferSelect;
export type LedgerDailyRow = typeof vLedgerDaily.$inferSelect;
export type ContractPipelineRow = typeof vContractPipeline.$inferSelect;

/** The three view names, for the verification query in the security suite. */
export const ANALYTICS_VIEW_NAMES = [
  "v_asset_portfolio",
  "v_ledger_daily",
  "v_contract_pipeline",
] as const;
