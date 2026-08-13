/**
 * Ordence — GST Foundation
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS PHASE IS, AND WHY IT COMES BEFORE THE FEATURES THAT NEED IT
 * ══════════════════════════════════════════════════════════════════════
 * Phase 11 gave invoices three tax columns and a state code. That was
 * enough to bill a SaaS subscription. It is nowhere near enough to bill a
 * flat, and the gap is not "more columns" — it is three facts that the
 * earlier design has no way to represent:
 *
 *   1. WE ARE REGISTERED IN MORE THAN ONE STATE. A developer with towers
 *      in Pune and Bengaluru holds two GSTINs and issues from whichever
 *      one the supply belongs to. "Our state code" is not a setting; it
 *      is a per-document decision.
 *
 *   2. ⭐ A RATE IS A FACT ABOUT A DATE, NOT ABOUT A CODE. GST rates
 *      change by notification — 5% on under-construction residential
 *      from 1 April 2019, 12% before it; 18% on works contracts, 12% for
 *      some; cess arriving and leaving on particular days. An invoice
 *      raised in March 2019 is FOREVER a 12% invoice. If the rate master
 *      holds one number and the renderer reads it, then the day somebody
 *      updates the master, every historical invoice in the system
 *      silently restates itself and no longer matches the return that was
 *      filed against it. That is the single most important design point
 *      in this phase and `hsn_sac_rates` exists for it alone.
 *
 *   3. ⭐ FOR IMMOVABLE PROPERTY THE PLACE OF SUPPLY IS THE PROPERTY.
 *      Section 12(3) of the IGST Act. Not the buyer's address, not the
 *      buyer's GSTIN state, not where the agreement was signed. A Dubai
 *      NRI buying a flat in Pune is an INTRA-STATE supply for a supplier
 *      registered in Maharashtra — CGST + SGST — and every generic
 *      billing engine gets that wrong because every generic billing
 *      engine keys place of supply off the customer record.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not create a second invoice. `invoices` and `invoice_lines`
 * from Phase 11/16 are EXTENDED in `SQL-FILES/0021_phase32_gst.sql` and
 * in `db/schema/billing.ts` — new nullable columns, one widened check.
 * A parallel `tax_invoices` table would mean two answers to "what did we
 * bill them", which is the failure mode this phase is supposed to close.
 *
 * Money is `bigint` paise throughout. Rates are integer basis points:
 * 1800 is 18%, 0.18 is a bug waiting for a multiplication.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  jsonb,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * How a party is registered under GST. Five values, and each one changes
 * the arithmetic rather than the label:
 *
 *   regular      — ordinary registered dealer. Charge tax, they claim it.
 *   composition  — pays a flat turnover levy and CANNOT claim input
 *                  credit. ⚠️ A composition dealer may not charge GST on
 *                  its own outward supply and must issue a bill of supply,
 *                  not a tax invoice. Recording this is what lets a later
 *                  phase refuse to raise the wrong document.
 *   unregistered — B2C. No GSTIN exists, so nothing may be validated
 *                  against one, and above ₹50,000 Rule 46(f) still wants
 *                  the recipient's address and state on the face of the
 *                  invoice.
 *   sez          — ⭐ a zero-rated supply. Section 7(5)(b) of the IGST Act
 *                  deems a supply to an SEZ unit or developer INTER-STATE
 *                  even when the SEZ is on the other side of the same
 *                  city. Treating it as intra-state because the two state
 *                  codes match is the classic SEZ error.
 *   overseas     — export. Zero-rated, place of supply outside India.
 */
export const gstRegistrationTypeEnum = pgEnum("gst_registration_type", [
  "regular",
  "composition",
  "unregistered",
  "sez",
  "overseas",
]);

/**
 * ⭐ THE ENUM THE PLACE-OF-SUPPLY ENGINE BRANCHES ON.
 *
 * `immovable_property` is not a cosmetic third option. It selects an
 * entirely different section of the IGST Act — 12(3) instead of 12(2) —
 * and it is the one a real-estate company uses for almost every rupee it
 * bills. Splitting it out of `services` (which is what it technically is,
 * a construction service) is what makes the wrong answer impossible to
 * reach by accident.
 */
export const gstSupplyTypeEnum = pgEnum("gst_supply_type", [
  "goods",
  "services",
  "immovable_property",
]);

/** HSN classifies goods; SAC classifies services. Same master, one flag. */
export const hsnSacKindEnum = pgEnum("hsn_sac_kind", ["hsn", "sac"]);

/** Customer-side or vendor-side. Determines which direction credit flows. */
export const gstPartyTypeEnum = pgEnum("gst_party_type", ["customer", "vendor"]);

/* ------------------------------------------------------------------ */
/* OUR OWN REGISTRATIONS                                               */
/* ------------------------------------------------------------------ */

/**
 * The GSTINs this workspace holds. Plural, deliberately.
 *
 * ⚠️ A DEVELOPER IS REGISTERED PER STATE, NOT PER COMPANY. One legal
 * entity with projects in three states holds three GSTINs against one
 * PAN, files three sets of returns, and issues each invoice from the
 * registration whose state the supply belongs to. A single
 * `settings.gstin` column — which is what Phase 11 effectively had —
 * makes the second state unrepresentable and the third one a support
 * ticket.
 *
 * ⚠️ NO UNIQUE INDEX ON (tenant_id, state_code), AND THAT IS NOT AN
 * OVERSIGHT. Section 25(2) lets a person take more than one registration
 * in the same state for separate business verticals, and some developers
 * do exactly that to ring-fence a joint-development project. A unique
 * index would refuse something the law allows. The uniqueness that IS
 * real is on the GSTIN itself, and on there being one primary.
 */
export const gstRegistrations = pgTable(
  "gst_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    gstin: varchar("gstin", { length: 15 }).notNull(),

    /**
     * Denormalised from the first two characters of the GSTIN, and held
     * consistent by a CHECK rather than by a trigger.
     *
     * It is denormalised because every tax decision in the product reads
     * it and `substring(gstin, 1, 2)` in a WHERE clause is an index nobody
     * remembers to create. The CHECK is what stops it drifting.
     */
    stateCode: varchar("state_code", { length: 2 }).notNull(),

    /** As it appears on the registration certificate. Goes on the invoice. */
    legalName: varchar("legal_name", { length: 255 }).notNull(),
    tradeName: varchar("trade_name", { length: 255 }),

    registrationType: gstRegistrationTypeEnum("registration_type")
      .default("regular")
      .notNull(),

    /** Principal place of business for this registration. Rule 46(a). */
    address: jsonb("address")
      .$type<{
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /**
     * ⚠️ A REGISTRATION HAS A LIFETIME AND INVOICES OUTLIVE IT.
     *
     * Registrations get surrendered, cancelled and migrated. An invoice
     * raised in 2024 against a GSTIN cancelled in 2025 is still a valid
     * document and must still render the GSTIN it was issued under — which
     * is why the row is closed with `effective_to` and never deleted, and
     * why `invoices.supplier_registration_id` is ON DELETE RESTRICT.
     */
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),

    /** The one used when nothing else determines it. Exactly one may be set. */
    isPrimary: boolean("is_primary").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    gstinPerTenant: uniqueIndex("gst_registrations_gstin_tenant_unique").on(
      t.tenantId,
      t.gstin,
    ),
    // ⭐ At most one primary. Two would mean "which GSTIN do we issue
    // from by default" has two answers, and the one that wins would be
    // whichever the ORDER BY happened to put first.
    onePrimary: uniqueIndex("gst_registrations_one_primary")
      .on(t.tenantId)
      .where(sql`${t.isPrimary} AND ${t.isActive}`),
    tenantIdx: index("gst_registrations_tenant_idx").on(t.tenantId),
    stateIdx: index("gst_registrations_state_idx").on(t.tenantId, t.stateCode),

    /**
     * ⚠️ SHAPE ONLY HERE. The mod-36 CHECKSUM is enforced by a second
     * constraint added in `0021_phase32_gst.sql`, because it needs a
     * plpgsql function and Drizzle cannot express one. Both constraints
     * exist; this file can only describe half of the pair.
     */
    gstinShape: check(
      "gst_registrations_gstin_shape",
      sql`${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
    stateMatchesGstin: check(
      "gst_registrations_state_matches_gstin",
      sql`${t.stateCode} = substring(${t.gstin} from 1 for 2)`,
    ),
    periodSane: check(
      "gst_registrations_period_sane",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* COUNTERPARTY GSTINs                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every GSTIN that is not ours: buyers, brokers, contractors, vendors.
 *
 * ⚠️ WHY THIS IS NOT A COLUMN ON `leads` AND ON `channel_partners`.
 *
 * `channel_partners.gstin` already exists (Phase 22) and stays — it is
 * the broker's own identifier on their own record. This table answers a
 * different question: "what tax identity do we bill or get billed under,
 * and was it valid on the date of the document?"
 *
 * The same buyer can be unregistered at booking and registered by
 * possession, three years later. One column can only hold the second
 * answer, and the first invoice would then re-render as B2B. Dated rows
 * are the only representation that survives time.
 *
 * The pointers are all optional and all composite — a party may be a
 * lead, a channel partner, a company, or none of those (a one-off
 * vendor typed in by accounts).
 */
export const gstParties = pgTable(
  "gst_parties",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    partyType: gstPartyTypeEnum("party_type").notNull(),

    /**
     * ⚠️ COMPOSITE FOREIGN KEYS, ADDED IN SQL.
     *
     * Declared here as bare uuids with no `.references()` on purpose: a
     * single-column FK to `leads(id)` is checked by PostgreSQL AS THE
     * SYSTEM, which ignores row-level security. Tenant A could point a
     * party row at tenant B's lead and the constraint would be satisfied.
     * The real edges are `(lead_id, tenant_id) → leads (id, tenant_id)`
     * and they live in Section 3 of the SQL file.
     */
    leadId: uuid("lead_id"),
    channelPartnerId: uuid("channel_partner_id"),
    companyId: uuid("company_id"),

    /** Rule 46(e): the recipient's name as registered. */
    legalName: varchar("legal_name", { length: 255 }).notNull(),
    tradeName: varchar("trade_name", { length: 255 }),

    /** NULL for unregistered and overseas parties. See the check below. */
    gstin: varchar("gstin", { length: 15 }),
    panNumber: varchar("pan_number", { length: 10 }),

    registrationType: gstRegistrationTypeEnum("registration_type")
      .default("unregistered")
      .notNull(),

    /**
     * For a registered party this is the GSTIN prefix. For an
     * unregistered one it is the state on the address, which Rule 46(f)
     * requires on the invoice above ₹50,000 and which is also what the
     * place-of-supply engine falls back to.
     */
    stateCode: varchar("state_code", { length: 2 }),

    address: jsonb("address")
      .$type<{
        line1?: string;
        line2?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    isActive: boolean("is_active").default(true).notNull(),

    /**
     * When the GSTIN was last confirmed against the GSTN portal, and what
     * came back. Phase 34 will populate it; the columns exist now so the
     * record of a verification is not bolted on later as a side table.
     */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verificationSource: varchar("verification_source", { length: 60 }),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One live row per GSTIN per direction. The same firm can legitimately
    // be both a customer and a vendor, which is why `party_type` is in the
    // key — a builder buys cement from a company it also sells a shop to.
    gstinPerType: uniqueIndex("gst_parties_gstin_type_unique")
      .on(t.tenantId, t.partyType, t.gstin)
      .where(sql`${t.gstin} IS NOT NULL AND ${t.isActive}`),
    tenantIdx: index("gst_parties_tenant_idx").on(t.tenantId, t.partyType),
    leadIdx: index("gst_parties_lead_idx").on(t.tenantId, t.leadId),
    partnerIdx: index("gst_parties_partner_idx").on(t.tenantId, t.channelPartnerId),
    gstinIdx: index("gst_parties_gstin_idx").on(t.tenantId, t.gstin),

    gstinShape: check(
      "gst_parties_gstin_shape",
      sql`${t.gstin} IS NULL
          OR ${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
    /**
     * ⚠️ THE REGISTRATION TYPE AND THE GSTIN MUST AGREE.
     *
     * An "unregistered" party carrying a GSTIN is a B2C invoice that
     * should have been B2B — the buyer loses input credit they were
     * entitled to and only notices at their own year end. A "regular"
     * party with no GSTIN is the reverse: a B2B invoice with nothing to
     * report it against, which fails at GSTR-1 upload weeks later.
     *
     * Overseas parties have no Indian registration by definition, so they
     * are grouped with unregistered here.
     */
    typeMatchesGstin: check(
      "gst_parties_type_matches_gstin",
      sql`(${t.registrationType} IN ('unregistered','overseas') AND ${t.gstin} IS NULL)
          OR (${t.registrationType} NOT IN ('unregistered','overseas') AND ${t.gstin} IS NOT NULL)`,
    ),
    stateMatchesGstin: check(
      "gst_parties_state_matches_gstin",
      sql`${t.gstin} IS NULL
          OR ${t.stateCode} IS NULL
          OR ${t.stateCode} = substring(${t.gstin} from 1 for 2)`,
    ),
    periodSane: check(
      "gst_parties_period_sane",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* HSN / SAC MASTER                                                    */
/* ------------------------------------------------------------------ */

/**
 * The classification code. Note what is NOT on this table: a rate.
 *
 * ⚠️ THE SEPARATION IS THE POINT. A `default_rate_bps` column here would
 * be read by the invoice renderer, and the day somebody corrects it every
 * historical invoice would silently restate. Rates live in
 * `hsn_sac_rates`, one row per notification period, and nothing may read
 * a rate without saying which DATE it wants it for.
 */
export const hsnSacCodes = pgTable(
  "hsn_sac_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 8 }).notNull(),
    kind: hsnSacKindEnum("kind").notNull(),
    description: text("description").notNull(),

    /**
     * Unit Quantity Code — "SQM", "NOS", "MTR". Rule 46(g) requires the
     * quantity AND its unit for goods, and GSTR-1 rejects a free-text
     * unit. Nullable because services have no quantity in that sense.
     */
    uqc: varchar("uqc", { length: 10 }),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codePerTenant: uniqueIndex("hsn_sac_codes_code_tenant_unique").on(t.tenantId, t.code),
    tenantIdx: index("hsn_sac_codes_tenant_idx").on(t.tenantId, t.kind),

    /**
     * ⚠️ HSN IS 2, 4, 6 OR 8 DIGITS AND THE LENGTH IS NOT COSMETIC — the
     * number of digits you must quote depends on turnover (4 below ₹5
     * crore, 6 above, 8 for exports). SAC is always six digits beginning
     * 99. A code of the wrong shape passes every screen in the product
     * and is rejected by the GSTN portal at filing.
     */
    codeShape: check(
      "hsn_sac_codes_shape",
      sql`(${t.kind} = 'hsn' AND ${t.code} ~ '^[0-9]{2}([0-9]{2}([0-9]{2}([0-9]{2})?)?)?$')
          OR (${t.kind} = 'sac' AND ${t.code} ~ '^99[0-9]{4}$')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ DATED RATES — THE HEART OF THE PHASE                             */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A RATE IS A FACT ABOUT A PERIOD. READ IT WITH A DATE OR NOT AT ALL.
 * ══════════════════════════════════════════════════════════════════════
 * Under-construction residential property was taxed at 12% with input
 * credit until 31 March 2019 and at 5% without credit from 1 April 2019.
 * Affordable housing went 8% → 1% on the same day. Works contracts have
 * moved twice. Compensation cess appears on some goods and not others and
 * has changed rate mid-year.
 *
 * So an invoice dated 15 March 2019 is a 12% invoice for ever. The return
 * filed for that month says 12%. The buyer's input credit says 12%. If
 * this system stores the rate on the CODE and the code is later updated
 * to 5%, then:
 *
 *   • every 2019 invoice re-renders at 5%;
 *   • the PDF a buyer downloads no longer matches the one they were sent;
 *   • the reconciliation against GSTR-1 fails for a whole quarter;
 *   • and NOTHING ERRORS. There is no exception, no log line, no failing
 *     test. Somebody notices during an assessment, two years later.
 *
 * The defences, in order of how much they are trusted:
 *
 *   1. This table. A rate exists only inside a dated window.
 *   2. An EXCLUDE constraint (SQL Section 4) forbidding overlapping
 *      windows for one code — because two rates valid on one date means
 *      the resolver picks by ORDER BY and the answer is arbitrary.
 *   3. `invoice_lines.gst_rate_id` pins the exact row used, ON DELETE
 *      RESTRICT, so history cannot be unmade.
 *   4. A trigger (SQL Section 5) refusing to edit the rate on a row that
 *      an invoice has already used.
 *
 * Four defences for one rule, which is the correct number for a rule
 * whose violation is completely silent.
 */
export const hsnSacRates = pgTable(
  "hsn_sac_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK to hsn_sac_codes (id, tenant_id) — added in SQL. */
    hsnSacId: uuid("hsn_sac_id").notNull(),

    /** Total GST in basis points. 500 = 5%, 1800 = 18%. */
    rateBps: integer("rate_bps").notNull(),

    /**
     * Compensation cess, ad valorem, in basis points.
     *
     * ⚠️ NOT BOUNDED BY 10000. Cess on pan masala and some tobacco runs
     * past 200%, and a `<= 10000` check written by analogy with the GST
     * rate would refuse a legitimate rate. Bounded generously instead.
     */
    cessRateBps: integer("cess_rate_bps").default(0).notNull(),

    /**
     * Specific cess — a fixed amount per unit of quantity, in paise.
     * Coal is ₹400 per tonne regardless of value. A purely ad-valorem
     * model cannot express it, and a builder buying coal for a captive
     * plant will meet it.
     */
    cessPerUnitMinor: bigint("cess_per_unit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⚠️ A DATE, NOT A TIMESTAMP, AND THE DIFFERENCE MATTERS.
     *
     * A notification takes effect on a calendar day in India. Stored as a
     * timestamptz, "1 April 2019" becomes 2019-03-31T18:30:00Z and an
     * invoice raised at 9am IST on 1 April compares as belonging to the
     * previous period on a server running in UTC. A `date` has no such
     * failure mode: the comparison is between two civil days.
     */
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    /** NULL means "still current". Exactly one open row per code. */
    effectiveTo: date("effective_to", { mode: "string" }),

    /** e.g. "Notification No. 03/2019-Central Tax (Rate)". Evidence. */
    notificationRef: varchar("notification_ref", { length: 160 }),

    /**
     * Whether input tax credit may be claimed against supplies at this
     * rate. The 1%/5% residential rates are explicitly WITHOUT credit,
     * and a developer who claims it anyway repays it with interest.
     */
    itcEligible: boolean("itc_eligible").default(true).notNull(),

    /**
     * Whether this classification is normally taxed in the recipient's
     * hands. Goods transport agency, legal services, security services,
     * and — the one every developer meets — purchases from unregistered
     * suppliers of cement and of the 80% shortfall under the 2019 scheme.
     */
    reverseCharge: boolean("reverse_charge").default(false).notNull(),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeIdx: index("hsn_sac_rates_code_idx").on(t.hsnSacId, t.effectiveFrom),
    tenantIdx: index("hsn_sac_rates_tenant_idx").on(t.tenantId),
    // The lookup the resolver actually performs: this code, on this day.
    resolveIdx: index("hsn_sac_rates_resolve_idx").on(
      t.tenantId,
      t.hsnSacId,
      t.effectiveFrom,
      t.effectiveTo,
    ),

    rateSane: check(
      "hsn_sac_rates_rate_sane",
      sql`${t.rateBps} >= 0 AND ${t.rateBps} <= 10000`,
    ),
    cessSane: check(
      "hsn_sac_rates_cess_sane",
      sql`${t.cessRateBps} >= 0 AND ${t.cessRateBps} <= 100000
          AND ${t.cessPerUnitMinor} >= 0`,
    ),
    /**
     * ⚠️ STRICTLY GREATER, NOT `>=`. A window that opens and closes on
     * the same day is a rate that applied for zero days, which is always
     * a data-entry slip — and it would sit invisibly in the middle of an
     * otherwise correct history, matching nothing.
     */
    periodSane: check(
      "hsn_sac_rates_period_sane",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const gstRegistrationsRelations = relations(gstRegistrations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [gstRegistrations.tenantId],
    references: [tenants.id],
  }),
  creator: one(users, {
    fields: [gstRegistrations.createdBy],
    references: [users.id],
  }),
}));

export const gstPartiesRelations = relations(gstParties, ({ one }) => ({
  tenant: one(tenants, { fields: [gstParties.tenantId], references: [tenants.id] }),
}));

export const hsnSacCodesRelations = relations(hsnSacCodes, ({ one, many }) => ({
  tenant: one(tenants, { fields: [hsnSacCodes.tenantId], references: [tenants.id] }),
  rates: many(hsnSacRates),
}));

export const hsnSacRatesRelations = relations(hsnSacRates, ({ one }) => ({
  tenant: one(tenants, { fields: [hsnSacRates.tenantId], references: [tenants.id] }),
  code: one(hsnSacCodes, {
    fields: [hsnSacRates.hsnSacId],
    references: [hsnSacCodes.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type GstRegistration = typeof gstRegistrations.$inferSelect;
export type NewGstRegistration = typeof gstRegistrations.$inferInsert;
export type GstParty = typeof gstParties.$inferSelect;
export type NewGstParty = typeof gstParties.$inferInsert;
export type HsnSacCode = typeof hsnSacCodes.$inferSelect;
export type NewHsnSacCode = typeof hsnSacCodes.$inferInsert;
export type HsnSacRate = typeof hsnSacRates.$inferSelect;
export type NewHsnSacRate = typeof hsnSacRates.$inferInsert;

export type GstRegistrationType = (typeof gstRegistrationTypeEnum.enumValues)[number];
export type GstSupplyType = (typeof gstSupplyTypeEnum.enumValues)[number];
export type HsnSacKind = (typeof hsnSacKindEnum.enumValues)[number];
export type GstPartyType = (typeof gstPartyTypeEnum.enumValues)[number];

/* ------------------------------------------------------------------ */
/* ⭐⭐ E-WAY BILL — Rule 138 · SQL 0054 · v1.3.0-alpha                 */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ORDENCE PREPARES AN E-WAY BILL. IT DOES NOT GENERATE ONE.
 * ══════════════════════════════════════════════════════════════════════
 * There are no GSP credentials — the same block that stops GSTR-1
 * filing. So `status = 'prepared'` is never rendered as anything that
 * looks like coverage, and `ewb_no` is the number a human brings back
 * from the portal.
 *
 * ⚠️ Inventing an integration that cannot be tested would produce a
 * screen that LOOKS like it raised an e-way bill and did not — and
 * somebody would dispatch on the strength of it.
 */
export const ewayBills = pgTable(
  "eway_bills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    documentType: varchar("document_type", { length: 20 }).notNull(),
    documentNo: varchar("document_no", { length: 40 }).notNull(),
    documentDate: date("document_date", { mode: "string" }).notNull(),
    invoiceId: uuid("invoice_id"),

    supplierGstin: varchar("supplier_gstin", { length: 15 }),
    supplierLegalName: varchar("supplier_legal_name", { length: 255 }),
    fromStateCode: varchar("from_state_code", { length: 2 }).notNull(),
    fromPlace: varchar("from_place", { length: 255 }),
    fromPincode: varchar("from_pincode", { length: 6 }).notNull(),

    recipientGstin: varchar("recipient_gstin", { length: 15 }),
    recipientLegalName: varchar("recipient_legal_name", { length: 255 }),
    toStateCode: varchar("to_state_code", { length: 2 }).notNull(),
    toPlace: varchar("to_place", { length: 255 }),
    toPincode: varchar("to_pincode", { length: 6 }).notNull(),

    transactionType: varchar("transaction_type", { length: 30 })
      .notNull()
      .default("regular"),
    supplyType: varchar("supply_type", { length: 10 }).notNull().default("outward"),
    subSupplyType: varchar("sub_supply_type", { length: 30 })
      .notNull()
      .default("supply"),

    /**
     * 🔴 THE THRESHOLD FIGURE, AND IT IS NOT THE INVOICE TOTAL.
     * Explanation 2 to Rule 138(1) — includes tax, excludes exempt
     * supply on a mixed document. Computed by `lib/gst/eway.ts` and
     * stored, because what was declared must not change when somebody
     * later edits the invoice.
     */
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .notNull()
      .default(0n),
    taxValueMinor: bigint("tax_value_minor", { mode: "bigint" }).notNull().default(0n),
    exemptValueMinor: bigint("exempt_value_minor", { mode: "bigint" })
      .notNull()
      .default(0n),
    consignmentValueMinor: bigint("consignment_value_minor", { mode: "bigint" })
      .notNull()
      .default(0n),

    transportMode: varchar("transport_mode", { length: 10 }),
    transporterGstin: varchar("transporter_gstin", { length: 15 }),
    transporterName: varchar("transporter_name", { length: 255 }),
    transporterDocNo: varchar("transporter_doc_no", { length: 40 }),
    transporterDocDate: date("transporter_doc_date", { mode: "string" }),
    /** ⚠️ A CACHE OF THE LATEST LEG. The record is `eway_bill_vehicles`. */
    vehicleNo: varchar("vehicle_no", { length: 20 }),
    vehicleType: varchar("vehicle_type", { length: 10 }).notNull().default("regular"),

    distanceKm: integer("distance_km").notNull().default(0),

    ewbNo: varchar("ewb_no", { length: 20 }),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /** 🔴 Counted from the FIRST Part B entry, never from Part A. */
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),

    /**
     * ⚠️ `generatedAt` SURVIVES EVERY EXTENSION. The 360-day ceiling runs
     * from original generation; overwriting it would let the ceiling
     * slide forward forever.
     */
    extensionCount: integer("extension_count").notNull().default(0),
    lastExtendedAt: timestamp("last_extended_at", { withTimezone: true }),

    status: varchar("status", { length: 20 }).notNull().default("prepared"),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, {
      onDelete: "set null",
    }),
    cancelReason: text("cancel_reason"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    /** 🔴 One portal number, one row. Two rows sharing it means two
     *  consignments each believe they are covered and one is not. */
    numberUnique: uniqueIndex("eway_bills_number_unique")
      .on(t.tenantId, t.ewbNo)
      .where(sql`${t.ewbNo} IS NOT NULL`),
    /** 🔴 One LIVE e-way bill per source document. */
    oneLivePerDocument: uniqueIndex("eway_bills_one_live_per_document")
      .on(t.tenantId, t.documentType, t.documentNo)
      .where(sql`${t.status} IN ('prepared', 'active')`),
    expiryIdx: index("eway_bills_expiry_idx")
      .on(t.tenantId, t.validUntil)
      .where(sql`${t.status} = 'active'`),
    invoiceIdx: index("eway_bills_invoice_idx")
      .on(t.tenantId, t.invoiceId)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    statusIdx: index("eway_bills_status_idx").on(t.tenantId, t.status, t.documentDate),
  }),
);

/**
 * 🔴 EVERY VEHICLE THE GOODS EVER SAT IN, NOT JUST THE CURRENT ONE.
 *
 * Transshipment is normal. If `vehicle_no` were simply UPDATEd, then at
 * a check two states later the record says the goods were always on the
 * second lorry — and the first leg, which actually happened, has no
 * record at all. An officer's question is "where has this been".
 */
export const ewayBillVehicles = pgTable(
  "eway_bill_vehicles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ewayBillId: uuid("eway_bill_id")
      .notNull()
      .references(() => ewayBills.id, { onDelete: "cascade" }),

    legNo: integer("leg_no").notNull(),
    transportMode: varchar("transport_mode", { length: 10 }).notNull(),
    vehicleNo: varchar("vehicle_no", { length: 20 }),
    transporterDocNo: varchar("transporter_doc_no", { length: 40 }),
    transporterDocDate: date("transporter_doc_date", { mode: "string" }),

    fromPlace: varchar("from_place", { length: 255 }),
    fromStateCode: varchar("from_state_code", { length: 2 }),

    /** ⭐ On leg 1, this is the instant that starts the validity clock. */
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    reasonCode: varchar("reason_code", { length: 20 }),
    reasonNote: text("reason_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    legUnique: uniqueIndex("eway_vehicles_leg_unique").on(
      t.tenantId,
      t.ewayBillId,
      t.legNo,
    ),
    billIdx: index("eway_vehicles_bill_idx").on(t.tenantId, t.ewayBillId, t.legNo),
  }),
);

/**
 * ⚠️ COPIED FROM THE DOCUMENT, NOT JOINED TO IT AT READ TIME — the same
 * rule Rule 46 already forces on the tax invoice. What was declared to
 * the Government on the day of movement must not change because somebody
 * later corrected an HSN code on a stock item.
 */
export const ewayBillItems = pgTable(
  "eway_bill_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ewayBillId: uuid("eway_bill_id")
      .notNull()
      .references(() => ewayBills.id, { onDelete: "cascade" }),

    lineNo: integer("line_no").notNull(),
    productName: varchar("product_name", { length: 255 }).notNull(),
    description: text("description"),
    hsnCode: varchar("hsn_code", { length: 10 }).notNull(),
    quantity: varchar("quantity", { length: 24 }).notNull().default("0"),
    uqc: varchar("uqc", { length: 10 }).notNull().default("NOS"),

    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .notNull()
      .default(0n),
    cgstRateBps: integer("cgst_rate_bps").notNull().default(0),
    sgstRateBps: integer("sgst_rate_bps").notNull().default(0),
    igstRateBps: integer("igst_rate_bps").notNull().default(0),
    cessRateBps: integer("cess_rate_bps").notNull().default(0),

    /** ⚠️ An exempt line still travels; it just does not count to ₹50,000. */
    isExempt: boolean("is_exempt").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lineUnique: uniqueIndex("eway_items_line_unique").on(
      t.tenantId,
      t.ewayBillId,
      t.lineNo,
    ),
  }),
);

export const ewayBillsRelations = relations(ewayBills, ({ one, many }) => ({
  tenant: one(tenants, { fields: [ewayBills.tenantId], references: [tenants.id] }),
  vehicles: many(ewayBillVehicles),
  items: many(ewayBillItems),
}));

export const ewayBillVehiclesRelations = relations(ewayBillVehicles, ({ one }) => ({
  bill: one(ewayBills, {
    fields: [ewayBillVehicles.ewayBillId],
    references: [ewayBills.id],
  }),
}));

export const ewayBillItemsRelations = relations(ewayBillItems, ({ one }) => ({
  bill: one(ewayBills, {
    fields: [ewayBillItems.ewayBillId],
    references: [ewayBills.id],
  }),
}));

export type EwayBillRow = typeof ewayBills.$inferSelect;
export type NewEwayBillRow = typeof ewayBills.$inferInsert;
export type EwayBillVehicleRow = typeof ewayBillVehicles.$inferSelect;
export type EwayBillItemRow = typeof ewayBillItems.$inferSelect;
