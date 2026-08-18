/**
 * Ordence — ⭐⭐⭐ MULTI-CURRENCY AND FX — SCHEMA
 * Version: v1.64.0-alpha  (mirrors SQL-FILES/0101_multi_currency_and_fx.sql)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE GAP THIS CLOSES, STATED PLAINLY
 * ══════════════════════════════════════════════════════════════════════
 * Sixteen `currency` columns existed across `db/schema/` before this file.
 * `grep -rn "exchangeRate|exchange_rate|fxRate|fx_rate|conversionRate"`
 * over `db/`, `lib/` and `server/` returned NOTHING. There was no rate
 * table, no rate source and no conversion anywhere in the product, so a
 * currency was a label that was stored, displayed, and never honoured —
 * the largest instance in Ordence of the pattern that also produced
 * `valuationMethod` read by nothing and `requireMfa` checked by nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHY THERE ARE TWO RATE TABLES AND NOT ONE
 * ══════════════════════════════════════════════════════════════════════
 * This is the hardest design question in the batch and the answer is that
 * there are two DIFFERENT KINDS OF FACT wearing the same shape.
 *
 * ⭐ `fx_reference_rates` IS PLATFORM-SCOPED AND HAS NO `tenant_id`.
 *    The Reserve Bank's reference rate for 31 March 2026 is one published
 *    number. It is not Acme's opinion of the dollar and it is not
 *    Bharat Steel's — it is the same fact for every workspace, and it is
 *    public. Copying it per tenant would mean 4,000 rows saying the same
 *    thing, a platform write on every workspace every day, and the
 *    certainty that some of those copies would drift. It is readable by
 *    everybody and writable only under `app_platform_scope()`.
 *
 * ⭐ `fx_rates` IS TENANT-SCOPED WITH `tenant_id NOT NULL`.
 *    A rate somebody typed from their own bank's advice, or a forward
 *    contract rate they booked, is THEIR fact and evidence for THEIR
 *    books only. One workspace must never read another's, so this table
 *    carries the ordinary tenant policy with no escape hatch at all.
 *
 * 🔴 THE THIRD DESIGN — one table with a nullable `tenant_id` — WAS
 *    CONSIDERED AND REJECTED. It works, and it makes the isolation of the
 *    manual rate depend on a policy predicate reading
 *    `tenant_id IS NULL OR tenant_id = app_current_tenant_id()`. That
 *    predicate is correct until somebody adds an index hint, a materialised
 *    view or a `SECURITY DEFINER` helper over it, at which point one
 *    workspace's negotiated rate becomes another's. Two tables make the
 *    boundary structural instead of conditional: there is no query shape
 *    that can return a foreign tenant's manual rate, because such a row is
 *    not in the table being read.
 *
 * ⚠️ AND NEITHER CHOICE REQUIRES A PLATFORM WRITE ON A TENANT TRANSACTION.
 *    A tenant invoicing in dollars reads the published rate (no write) or
 *    writes its own row in its own table (tenant write). The platform
 *    writes only when a reference rate is published, once per pair per day
 *    for everybody.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ HOW A RATE IS STORED — see `lib/fx/rates.ts` for the full argument
 * ══════════════════════════════════════════════════════════════════════
 * `numeric(30,12)`, holding "how many QUOTE units per ONE BASE unit", with
 * the pair named explicitly and stored in the direction it was PUBLISHED.
 * Twelve decimals because four (what RBI publishes) cannot hold the
 * inverse: truncating 1/83.215 at four places is a 1.4 per cent error.
 */

import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { transactions } from "./accounting";

/* ------------------------------------------------------------------ */
/* CURRENCY UNITS — the exponent, as a fact the database also holds     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 PLATFORM-SCOPED REFERENCE DATA. No `tenant_id`: the number of
 * decimal places in the Kuwaiti dinar is not a property of a workspace.
 *
 * ⚠️ WHY IT EXISTS AT ALL WHEN `lib/fx/currency.ts` HOLDS THE SAME TABLE.
 * A reporting query written in SQL — a Neon console investigation, a
 * future materialised view — needs the exponent to scale a `bigint` minor
 * amount into something a human reads, and it cannot import TypeScript.
 * Two copies of a fact drift, so `server/fx/rate-service.ts#verifyCurrencyUnits()`
 * COMPARES THEM and reports every disagreement. A duplicate that is checked
 * is a cache; a duplicate that is not is a second source of truth.
 */
export const currencyUnits = pgTable(
  "currency_units",
  {
    /** ISO-4217 alphabetic code, upper case. */
    code: varchar("code", { length: 3 }).primaryKey(),
    /**
     * 🔴 NOT ALWAYS 2. JPY and the CFA francs are 0; BHD, IQD, JOD, KWD,
     * LYD, OMR and TND are 3; CLF and UYW are 4. A conversion routine that
     * hardcodes hundredths is wrong the first time somebody invoices in
     * yen and wrong by a factor of ten the first time somebody invoices in
     * dinars.
     */
    exponent: integer("exponent").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activeIdx: index("currency_units_active_idx").on(t.isActive),
  }),
);

export type CurrencyUnit = typeof currencyUnits.$inferSelect;

/* ------------------------------------------------------------------ */
/* PUBLISHED REFERENCE RATES — platform-scoped                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE PUBLISHED RATE. Same fact for every tenant, so stored once.
 *
 * ⚠️ `rate_date` IS THE DATE THE RATE IS FOR, NOT THE DATE IT WAS LOADED.
 * `published_at` is the loading timestamp and they are routinely different
 * — the RBI publishes the 31 March reference rate on 31 March at about
 * 13:30 IST, and an integration that backfills a week of history writes
 * seven rows with seven `rate_date`s and one `published_at`.
 */
export const fxReferenceRates = pgTable(
  "fx_reference_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** "How many `quote_currency` for one `base_currency`." */
    baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
    quoteCurrency: varchar("quote_currency", { length: 3 }).notNull(),

    /** Scaled to twelve decimals. See `lib/fx/rates.ts` RATE_EXPONENT. */
    rate: numeric("rate", { precision: 30, scale: 12 }).notNull(),

    rateDate: date("rate_date", { mode: "string" }).notNull(),

    /** 'rbi_reference' | 'provider'. Never 'manual' — that is tenant data. */
    source: varchar("source", { length: 20 }).notNull(),
    /** Circular number, provider tick id, the URL the number came from. */
    sourceReference: text("source_reference"),

    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ THE SOURCE IS PART OF THE KEY. RBI and a commercial provider may
     * both publish USD/INR for the same day and they will differ in the
     * fourth decimal. Collapsing them onto one row would make "which rate
     * did we use" unanswerable, which is the question an auditor asks.
     */
    pairDayUnique: uniqueIndex("fx_reference_rates_pair_day_key").on(
      t.baseCurrency,
      t.quoteCurrency,
      t.rateDate,
      t.source,
    ),
    lookupIdx: index("fx_reference_rates_lookup_idx").on(
      t.baseCurrency,
      t.quoteCurrency,
      t.rateDate,
    ),
  }),
);

export type FxReferenceRate = typeof fxReferenceRates.$inferSelect;

/* ------------------------------------------------------------------ */
/* TENANT RATES — the workspace's own                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A RATE THIS WORKSPACE ENTERED. Their bank's advice, their forward
 * cover, their auditor's instruction.
 *
 * 🔴 `entered_by` IS NOT DECORATION. A rate is a number that changes the
 * profit and loss account. AS 11 ¶13 sends every exchange difference to
 * the P&L, so a person who moves a rate by one paisa on a ₹10 crore
 * exposure moves the reported profit by ₹1 lakh. Who typed it, and when,
 * is part of the evidence.
 *
 * ⚠️ AND IT IS EFFECTIVE-DATED, NEVER OVERWRITTEN IN PLACE. `rate_date` is
 * the day the rate applies to. Correcting a rate means writing the
 * correction as a new row for the same day (the unique index below is on
 * the day, so the correction is a genuine UPDATE and audited as one) —
 * it does NOT mean editing the row a December invoice was measured at,
 * because that would silently restate a filed period.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
    quoteCurrency: varchar("quote_currency", { length: 3 }).notNull(),

    rate: numeric("rate", { precision: 30, scale: 12 }).notNull(),
    rateDate: date("rate_date", { mode: "string" }).notNull(),

    /** 'manual' | 'provider'. A tenant may load its own provider feed. */
    source: varchar("source", { length: 20 }).default("manual").notNull(),
    sourceReference: text("source_reference"),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** 🔴 Who is answerable for this number. */
    enteredBy: uuid("entered_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    tenantIdTenantKey: uniqueIndex("fx_rates_id_tenant_key").on(t.id, t.tenantId),
    /** One rate per pair per day per workspace. */
    pairDayUnique: uniqueIndex("fx_rates_pair_day_key").on(
      t.tenantId,
      t.baseCurrency,
      t.quoteCurrency,
      t.rateDate,
    ),
    lookupIdx: index("fx_rates_lookup_idx").on(
      t.tenantId,
      t.baseCurrency,
      t.quoteCurrency,
      t.rateDate,
    ),
  }),
);

export type FxRate = typeof fxRates.$inferSelect;

/* ------------------------------------------------------------------ */
/* REPORTING-DATE RESTATEMENT — AS 11 ¶11 / Ind AS 21 ¶23              */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ONE REVALUATION RUN, AT ONE REPORTING DATE.
 *
 * ⚠️ THE GAIN AND THE LOSS ARE HELD SEPARATELY AND ARE NOT NETTED INTO
 * ONE COLUMN. The same argument as `inventory_variance_gain` and
 * `inventory_variance_loss` in `lib/accounting/sales-posting.ts`: netting
 * them makes "how much did the rupee cost us this year" unanswerable, and
 * that is a question a board asks. The net is derivable; the two halves
 * are not derivable from the net.
 */
export const fxRevaluations = pgTable(
  "fx_revaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** The reporting date the closing rate is taken at. */
    asOfDate: date("as_of_date", { mode: "string" }).notNull(),

    /**
     * ⭐ FROZEN ON THE ROW. The tenant's functional currency lives in a
     * JSONB settings blob that anybody with `settings:update` can change.
     * A revaluation that read it live would silently re-base a historic
     * run the day somebody switched the workspace from INR to USD.
     */
    functionalCurrency: varchar("functional_currency", { length: 3 }).notNull(),

    /** 'draft' | 'posted' | 'void'. */
    status: varchar("status", { length: 20 }).default("draft").notNull(),

    /** Positive magnitudes, both. The net is `gain - loss`. */
    gainMinor: bigint("gain_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    lossMinor: bigint("loss_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** How many monetary items were restated, and how many were skipped. */
    restatedCount: integer("restated_count").default(0).notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),

    /**
     * ⚠️ NULL UNTIL POSTED, AND NULL IS AN HONEST ANSWER. A run whose
     * chart of accounts has no `fx_gain` / `fx_loss` ledger mapped
     * computes correctly and posts nothing, exactly as a sales invoice
     * does in `server/accounting/post-sales.ts`. `unposted_reason` says
     * which.
     */
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    unpostedReason: text("unposted_reason"),

    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdTenantKey: uniqueIndex("fx_revaluations_id_tenant_key").on(t.id, t.tenantId),
    /**
     * ⚠️ ONE LIVE RUN PER REPORTING DATE. Two revaluations of the same
     * 31 March would each restate from the last carrying amount and the
     * second would find a difference of nil — leaving the P&L short by
     * whichever run was voided. Voided runs are excluded so a mistake can
     * be redone.
     */
    dayUnique: uniqueIndex("fx_revaluations_as_of_key")
      .on(t.tenantId, t.asOfDate)
      .where(sql`status <> 'void'`),
    tenantIdx: index("fx_revaluations_tenant_idx").on(t.tenantId, t.asOfDate),
  }),
);

export type FxRevaluation = typeof fxRevaluations.$inferSelect;

/**
 * ⭐⭐ ONE ITEM CONSIDERED BY A RUN — INCLUDING THE ONES IT DID NOT TOUCH.
 *
 * 🔴 THE NON-MONETARY ITEMS ARE RECORDED WITH `restated = false` AND A
 * REASON, RATHER THAN OMITTED. A run that silently skips a fixed asset is
 * indistinguishable from a run that never saw it, and the difference
 * matters: the first is AS 11 ¶11(b) being applied correctly and the
 * second is a query with a missing join. The reason is on the row so an
 * auditor can read the policy rather than infer it.
 */
export const fxRevaluationLines = pgTable(
  "fx_revaluation_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    revaluationId: uuid("revaluation_id")
      .notNull()
      .references(() => fxRevaluations.id, { onDelete: "cascade" }),

    /** A member of `FX_ITEM_KINDS` in `lib/fx/restatement.ts`. */
    itemKind: varchar("item_kind", { length: 40 }).notNull(),
    /** 🔴 DERIVED FROM `item_kind` BY `isMonetary()`, never chosen. */
    isMonetaryItem: boolean("is_monetary_item").notNull(),

    /** Where the item lives: 'sales_invoices', 'purchase_invoices', 'ledgers'. */
    sourceTable: varchar("source_table", { length: 60 }).notNull(),
    sourceId: uuid("source_id"),
    /** Invoice number, ledger code — what a human recognises it by. */
    sourceReference: varchar("source_reference", { length: 120 }),

    foreignCurrency: varchar("foreign_currency", { length: 3 }).notNull(),
    foreignAmountMinor: bigint("foreign_amount_minor", { mode: "bigint" }).notNull(),

    carryingFunctionalMinor: bigint("carrying_functional_minor", { mode: "bigint" }).notNull(),
    restatedFunctionalMinor: bigint("restated_functional_minor", { mode: "bigint" }).notNull(),
    /** restated − carrying, in the carrying amount's own sign. */
    differenceMinor: bigint("difference_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /**
     * ⭐ THE SAME NUMBER WITH THE BALANCE-SHEET SIDE APPLIED: positive is a
     * gain in the P&L. A liability worth more in functional terms is a
     * LOSS, and that flip is `exchangeDifferenceForPl()` and nothing else.
     */
    plEffectMinor: bigint("pl_effect_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** The closing rate actually used. NULL when nothing was restated. */
    rate: numeric("rate", { precision: 30, scale: 12 }),
    rateDate: date("rate_date", { mode: "string" }),
    rateSource: varchar("rate_source", { length: 20 }),
    /** True when the rate was obtained by inverting a published pair. */
    rateDerived: boolean("rate_derived").default(false).notNull(),

    restated: boolean("restated").default(false).notNull(),
    /** 🔴 Never null when `restated` is false. The policy, in words. */
    skipReason: text("skip_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdTenantKey: uniqueIndex("fx_revaluation_lines_id_tenant_key").on(t.id, t.tenantId),
    runIdx: index("fx_revaluation_lines_run_idx").on(t.tenantId, t.revaluationId),
    /** One line per item per run — a re-run must not double-count. */
    itemUnique: uniqueIndex("fx_revaluation_lines_item_key").on(
      t.tenantId,
      t.revaluationId,
      t.sourceTable,
      t.sourceId,
    ),
  }),
);

export type FxRevaluationLine = typeof fxRevaluationLines.$inferSelect;
