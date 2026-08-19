/**
 * Ordence — ⭐⭐⭐ THE FIXED ASSET REGISTER
 * Batch 100 · v1.53.0-alpha · SQL-FILES/0100
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NOT `assets`
 * ══════════════════════════════════════════════════════════════════════
 * `db/schema/assets.ts` already has a table called `assets` and it was
 * seriously considered for this. It was the wrong home, for reasons that
 * are worth writing down so nobody merges them later:
 *
 *   ① `assets` IS A CRM / REAL-ESTATE CATALOGUE. Its own header says
 *      "ONE TABLE, MANY INDUSTRIES" and its enum covers `property`,
 *      `unit`, `plot`, `case`, `matter`, `subscription_plan`. It carries
 *      `owner_company_id`, `primary_contact_id`, `linked_deal_id`,
 *      latitude and longitude. A flat in a project being SOLD is stock
 *      in trade; a lathe the company USES is a fixed asset. They are on
 *      opposite sides of the balance sheet and one row cannot be both.
 *
 *   ② ITS MONEY COLUMN IS THE WRONG TYPE AND THE WRONG THING.
 *      `value_amount numeric(18,2)` is a rupee figure, and this product's
 *      rule is `bigint` paise. Worse, it means "what is this worth",
 *      which is a valuation. Depreciation is computed on COST, and cost
 *      and value are different numbers that diverge on day one.
 *
 *   ③ COMPONENT ACCOUNTING NEEDS A SECOND HIERARCHY. Schedule II note 4
 *      makes a significant component with a different useful life its own
 *      depreciable item. `asset_relationships` could express that edge,
 *      but the carve-out rule — the parent's cost must EXCLUDE the
 *      component's — is a money invariant, and an edge table cannot hold
 *      one.
 *
 * ⭐ SO: A SEPARATE REGISTER, WITH A NULLABLE `crm_asset_id` LINK. A
 *   tenant who tracks a JCB in the CRM catalogue and capitalises the same
 *   JCB here can join the two, and neither table has to pretend to be the
 *   other.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NO COUNTER COLUMNS. ACCUMULATED DEPRECIATION IS FOLDED FROM THE
 *    POSTED LINES.
 * ══════════════════════════════════════════════════════════════════════
 * There is deliberately no `accumulated_depreciation_minor` on
 * `fixed_assets`, for the same reason `employee_advances` (0096) has no
 * `outstanding_minor`: every failure mode of a counter is real. A run
 * reversed and re-run decrements twice; a cancelled run leaves it high;
 * nothing complains, because a counter has no way of knowing it is wrong.
 * `depreciation_lines` of POSTED runs is the balance and nothing else is.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  integer,
  boolean,
  bigint,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { assets } from "./assets";
import { transactions } from "./accounting";

/* ================================================================== */
/* ① INCOME-TAX BLOCKS OF ASSETS — s.2(11)                             */
/* ================================================================== */

/**
 * ⭐ THE TAX POOL. Every asset of the same class attracting the same
 * prescribed rate is ONE block, and the written-down value belongs to the
 * block rather than to any asset inside it.
 *
 * ⚠️ `opening_wdv_minor` IS AN OPENING BALANCE, NOT A RUNNING TOTAL. It
 * is the block's WDV on the day the tenant started keeping the register
 * here — typed in from their last tax computation. Every later year's
 * WDV is COMPUTED by `incomeTaxBlockYear` from this one plus the
 * additions and disposals in between, so there is no stored figure to
 * drift.
 */
export const itAssetBlocks = pgTable(
  "it_asset_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 120 }).notNull(),

    /** `ItBlockClass` — building | furniture_fittings | plant_machinery | intangible. */
    blockClass: varchar("block_class", { length: 30 }).notNull(),

    /**
     * 🔴 WHOLE BASIS POINTS, READ AT THE COMPUTATION. 15% plant is 1500,
     * 40% is 4000. Appendix I to the Income-tax Rules, 1962 prescribes
     * it; Ordence does not guess it, because the rate for a block turns
     * on facts about the asset (a "computer" at 40% versus general plant
     * at 15%) that only the taxpayer knows.
     */
    rateBp: integer("rate_bp").notNull(),

    /** Paise. The WDV brought forward on `opening_wdv_as_at`. */
    openingWdvMinor: bigint("opening_wdv_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** ⚠️ The first day of the first financial year Ordence computes. */
    openingWdvAsAt: date("opening_wdv_as_at").notNull(),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdx: index("it_asset_blocks_tenant_idx").on(t.tenantId),
    nameUnique: uniqueIndex("it_asset_blocks_name_key").on(t.tenantId, t.name),
    idTenantKey: uniqueIndex("it_asset_blocks_id_tenant_key").on(t.id, t.tenantId),
  }),
);

/* ================================================================== */
/* ② THE REGISTER                                                      */
/* ================================================================== */

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    assetNo: varchar("asset_no", { length: 40 }).notNull(),
    description: text("description").notNull(),

    /** `ScheduleIIClass`. It decides the prescribed life AND whether
     * extra shift depreciation may apply at all (Part A note 6, NESD). */
    assetClass: varchar("asset_class", { length: 40 }).notNull(),

    /**
     * ⭐ COMPONENT ACCOUNTING — SCHEDULE II PART A NOTE 4. A significant
     * part with a different useful life is depreciated separately, so it
     * is its own row pointing at its parent.
     *
     * 🔴 THE PARENT'S COST EXCLUDES THE COMPONENT'S. `registerComponent`
     * carves the component's cost OUT of the parent in the same
     * transaction and refuses if the parent has already been depreciated,
     * because otherwise the two rows would together depreciate more than
     * the asset ever cost.
     */
    parentFixedAssetId: uuid("parent_fixed_asset_id"),

    /** ⚠️ COST, in paise. Not value, not the insured sum, not the WDV. */
    costMinor: bigint("cost_minor", { mode: "bigint" }).notNull(),

    /**
     * 🔴 SCHEDULE II PART A NOTE 5 — not more than 5% (500bp) of original
     * cost unless the company justifies and discloses otherwise. The
     * engine REFUSES to depreciate an asset above 500bp with no
     * justification recorded, which is why the next column exists.
     */
    residualBp: integer("residual_bp").default(500).notNull(),
    residualJustification: text("residual_justification"),

    usefulLifeMonths: integer("useful_life_months").notNull(),
    /**
     * Required whenever the life differs from Schedule II Part C for this
     * class. Read by `assertAssetIsDepreciable` — a life that departs from
     * the schedule with no justification stops the computation.
     */
    lifeJustification: text("life_justification"),

    /** `slm` | `wdv`. Read at every charge; an unknown value is refused. */
    depreciationMethod: varchar("depreciation_method", { length: 3 }).notNull(),

    /** `single` | `double` | `triple` — Schedule II Part A note 6. */
    shiftUsage: varchar("shift_usage", { length: 10 }).default("single").notNull(),

    acquiredOn: date("acquired_on").notNull(),
    /** 🔴 DEPRECIATION RUNS FROM USE, NOT FROM PURCHASE. */
    putToUseOn: date("put_to_use_on").notNull(),

    /** The tax pool this asset belongs to. Null until it is classified. */
    itBlockId: uuid("it_block_id").references(() => itAssetBlocks.id, {
      onDelete: "restrict",
    }),

    /** `in_use` | `disposed` | `written_off`. */
    status: varchar("status", { length: 20 }).default("in_use").notNull(),

    disposedOn: date("disposed_on"),
    /**
     * ⚠️ ONE FIGURE, TWO STATUTES. To the Companies Act it is the sale
     * consideration that produces a profit or loss against the carrying
     * amount; to s.43(6)(c)(i)(B) it is "moneys payable" that comes off
     * the block and produces no gain at all. Same number, different
     * treatment, and the two must not be reconciled.
     */
    disposalConsiderationMinor: bigint("disposal_consideration_minor", { mode: "bigint" }),
    disposalTransactionId: uuid("disposal_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),

    /** Optional link to the CRM catalogue row for the same physical thing. */
    crmAssetId: uuid("crm_asset_id").references(() => assets.id, { onDelete: "set null" }),

    /**
     * ⚠️ DESCRIPTIVE ONLY, AND SAID SO OUT LOUD. Nothing computes from
     * it — it is where somebody goes to physically verify the asset.
     *
     * 🔴 THERE IS DELIBERATELY NO `cost_centre` COLUMN. One was drafted
     * and removed: `lib/accounting/cost-centre.ts` exists, the
     * depreciation journal is ONE entry for the whole run, and a cost
     * centre stamped on an asset that no posting reads would say the
     * charge is allocated when it is not. That is precisely the
     * declared-and-enforced-by-nothing defect this batch was written to
     * avoid. It belongs with the batch that splits the journal by cost
     * centre, and not a release earlier.
     */
    location: varchar("location", { length: 160 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("fixed_assets_tenant_idx").on(t.tenantId),
    assetNoUnique: uniqueIndex("fixed_assets_no_key").on(t.tenantId, t.assetNo),
    idTenantKey: uniqueIndex("fixed_assets_id_tenant_key").on(t.id, t.tenantId),
    statusIdx: index("fixed_assets_status_idx").on(t.tenantId, t.status),
    blockIdx: index("fixed_assets_block_idx").on(t.tenantId, t.itBlockId),
    parentIdx: index("fixed_assets_parent_idx").on(t.tenantId, t.parentFixedAssetId),
  }),
);

/* ================================================================== */
/* ③ THE RUNS                                                          */
/* ================================================================== */

/**
 * ⭐ ONE RUN PER BASIS PER PERIOD, AND THE UNIQUE INDEX IS THE CONTROL.
 *
 * 🔴 `basis = 'income_tax'` NEVER CARRIES A `transaction_id`, and 0100
 * puts a CHECK constraint under that. The tax allowance is a computation
 * for the return; posting it to the ledger would put the Income-tax Act's
 * number into a Companies Act balance sheet, which is the single worst
 * thing this module could do. A constraint says it in a place an INSERT
 * cannot walk around.
 */
export const depreciationRuns = pgTable(
  "depreciation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** `companies_act` | `income_tax`. */
    basis: varchar("basis", { length: 20 }).notNull(),

    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    /** `computed` | `posted` | `cancelled`. */
    status: varchar("status", { length: 20 }).default("computed").notNull(),

    totalChargeMinor: bigint("total_charge_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** s.50(1) / s.50(2), income-tax runs only. Never posted. */
    shortTermCapitalGainMinor: bigint("short_term_capital_gain_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    shortTermCapitalLossMinor: bigint("short_term_capital_loss_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
    computedBy: uuid("computed_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),

    note: text("note"),
  },
  (t) => ({
    tenantIdx: index("depreciation_runs_tenant_idx").on(t.tenantId),
    periodUnique: uniqueIndex("depreciation_runs_period_key").on(
      t.tenantId,
      t.basis,
      t.periodStart,
      t.periodEnd,
    ),
    idTenantKey: uniqueIndex("depreciation_runs_id_tenant_key").on(t.id, t.tenantId),
    statusIdx: index("depreciation_runs_status_idx").on(t.tenantId, t.status, t.periodEnd),
  }),
);

/**
 * ⭐ THE WORKING, ONE ROW PER ASSET (book) OR PER BLOCK (tax).
 *
 * ⚠️ THE WORKING IS STORED, NOT JUST THE ANSWER. Days in use, the rate
 * applied, the shift factor and the half-rate flag are columns because an
 * auditor asking "why is this ₹1,23,456" is entitled to the arithmetic,
 * and re-deriving it from today's configuration proves nothing about what
 * was charged two years ago.
 */
export const depreciationLines = pgTable(
  "depreciation_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    runId: uuid("run_id")
      .notNull()
      .references(() => depreciationRuns.id, { onDelete: "cascade" }),

    /** Exactly one of these two is set — a CHECK in 0100 enforces it. */
    fixedAssetId: uuid("fixed_asset_id").references(() => fixedAssets.id, {
      onDelete: "restrict",
    }),
    itBlockId: uuid("it_block_id").references(() => itAssetBlocks.id, {
      onDelete: "restrict",
    }),

    openingMinor: bigint("opening_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    chargeMinor: bigint("charge_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    closingMinor: bigint("closing_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** `slm` | `wdv` for a book line; `block_wdv` for a tax line. */
    method: varchar("method", { length: 12 }).notNull(),
    /** Whole basis points. Null on SLM, which has no rate. */
    rateBp: integer("rate_bp"),
    /** 10000 | 15000 | 20000 — Schedule II Part A note 6. */
    shiftFactorBp: integer("shift_factor_bp").default(10000).notNull(),
    daysInUse: integer("days_in_use").default(0).notNull(),
    /** Income-tax lines: the second proviso to s.32(1) applied. */
    halfRate: boolean("half_rate").default(false).notNull(),

    /** The sentences the engine produced. Shown, not decoration. */
    working: jsonb("working")
      .$type<{ notes?: string[]; [key: string]: unknown }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("depreciation_lines_tenant_idx").on(t.tenantId),
    runIdx: index("depreciation_lines_run_idx").on(t.tenantId, t.runId),
    assetIdx: index("depreciation_lines_asset_idx").on(t.tenantId, t.fixedAssetId),
    assetUnique: uniqueIndex("depreciation_lines_run_asset_key")
      .on(t.runId, t.fixedAssetId)
      .where(sql`${t.fixedAssetId} IS NOT NULL`),
    blockUnique: uniqueIndex("depreciation_lines_run_block_key")
      .on(t.runId, t.itBlockId)
      .where(sql`${t.itBlockId} IS NOT NULL`),
  }),
);

/* ================================================================== */
/* RELATIONS                                                           */
/* ================================================================== */

export const fixedAssetsRelations = relations(fixedAssets, ({ one, many }) => ({
  tenant: one(tenants, { fields: [fixedAssets.tenantId], references: [tenants.id] }),
  itBlock: one(itAssetBlocks, {
    fields: [fixedAssets.itBlockId],
    references: [itAssetBlocks.id],
  }),
  crmAsset: one(assets, { fields: [fixedAssets.crmAssetId], references: [assets.id] }),
  depreciationLines: many(depreciationLines),
}));

export const itAssetBlocksRelations = relations(itAssetBlocks, ({ one, many }) => ({
  tenant: one(tenants, { fields: [itAssetBlocks.tenantId], references: [tenants.id] }),
  assets: many(fixedAssets),
}));

export const depreciationRunsRelations = relations(depreciationRuns, ({ one, many }) => ({
  tenant: one(tenants, { fields: [depreciationRuns.tenantId], references: [tenants.id] }),
  lines: many(depreciationLines),
}));

export const depreciationLinesRelations = relations(depreciationLines, ({ one }) => ({
  run: one(depreciationRuns, {
    fields: [depreciationLines.runId],
    references: [depreciationRuns.id],
  }),
  fixedAsset: one(fixedAssets, {
    fields: [depreciationLines.fixedAssetId],
    references: [fixedAssets.id],
  }),
  itBlock: one(itAssetBlocks, {
    fields: [depreciationLines.itBlockId],
    references: [itAssetBlocks.id],
  }),
}));

/* ================================================================== */
/* TYPES                                                               */
/* ================================================================== */

export type FixedAsset = typeof fixedAssets.$inferSelect;
export type NewFixedAsset = typeof fixedAssets.$inferInsert;
export type ItAssetBlock = typeof itAssetBlocks.$inferSelect;
export type NewItAssetBlock = typeof itAssetBlocks.$inferInsert;
export type DepreciationRun = typeof depreciationRuns.$inferSelect;
export type NewDepreciationRun = typeof depreciationRuns.$inferInsert;
export type DepreciationLine = typeof depreciationLines.$inferSelect;
export type NewDepreciationLine = typeof depreciationLines.$inferInsert;
