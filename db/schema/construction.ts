/**
 * Ordence — ⭐ BOQ, Measurement & Running Account Bills (Phases 42–43)
 * Version: v0.42.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS: HOW CONSTRUCTION ACTUALLY INVOICES
 * ══════════════════════════════════════════════════════════════════════
 * Phase 22 sold the flat. Phase 38 collected from the buyer. Nothing so
 * far has PAID THE PEOPLE BUILDING IT, and that is where a developer's
 * money actually leaves: eighty per cent of project cost goes out through
 * running-account bills to contractors, twenty or thirty bills per
 * contract, over three to five years.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE DEFINING PROPERTY: A RUNNING ACCOUNT BILL IS CUMULATIVE
 * ══════════════════════════════════════════════════════════════════════
 * This is not an invoice. An invoice says "this month I did ₹17,00,000 of
 * work". A running account bill says:
 *
 *     Value of work done TO DATE          ₹62,00,000
 *     Less: paid on previous bills        ₹45,00,000
 *     Now due on this bill                ₹17,00,000
 *
 * Every figure on it — quantity, value, retention, advance recovery — is
 * a TO-DATE figure, and what is paid is the DIFFERENCE from the last
 * bill. The reason the trade works that way is that measurement is
 * cumulative: nobody re-measures last month's brickwork, they measure the
 * wall as it stands and subtract what was already certified.
 *
 * ⚠️ AND THAT IS EXACTLY WHY IT GOES WRONG. Treat one cumulative figure
 * as periodic and the contractor is paid ₹62,00,000 for ₹17,00,000 of
 * work. Treat one periodic figure as cumulative and they are underpaid by
 * the whole history. Neither errors. Both are found by a contractor who
 * has stopped work, or by an auditor two years later.
 *
 * So `ra_bill_items` carries `cumulative_*`, `previous_*` AND `this_*`
 * for both quantity and value, the database CHECKs that the third is the
 * difference of the first two, and SQL 0028 §6 refuses at commit any bill
 * whose `previous_gross_minor` is not the immediately preceding bill's
 * `cumulative_gross_minor`. The redundancy is the point: a number that
 * can only be derived is a number nobody can audit, and a number that is
 * stored without the derivation being checked is a number that drifts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE SECOND PROPERTY: CUMULATIVE QUANTITY IS MONOTONIC
 * ══════════════════════════════════════════════════════════════════════
 * Work done to date cannot go DOWN. If bill 3 certified 1,240 cum of
 * concrete and bill 4 says 1,180, then ₹2,73,000 already paid is now
 * unaccounted for — and nothing on bill 4 says so, because bill 4's own
 * arithmetic is internally consistent. It simply produces a negative
 * "now due" that somebody nets off against the next bill, and the
 * over-payment is never recovered.
 *
 * A decrease is sometimes RIGHT — a re-measurement found the earlier one
 * wrong, or scope was omitted. So it is not forbidden; it is made
 * IMPOSSIBLE TO DO SILENTLY. SQL 0028 §7 refuses any cumulative quantity
 * below what a certified bill already carried unless the line names an
 * APPROVED variation and gives a reason.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THIRD PROPERTY: A MEASUREMENT IS BOUNDED BY THE CONTRACT
 * ══════════════════════════════════════════════════════════════════════
 * A BOQ is a contract document. 1,200 cum of M25 at ₹6,450 is what was
 * agreed. Measuring 1,340 cum and billing it is not a measurement, it is
 * a variation nobody signed — and it is the single most common way a
 * contract sum is exceeded without anybody deciding to exceed it.
 *
 * SQL 0028 §8 refuses a measurement, and a cumulative bill quantity, that
 * exceeds the AUTHORISED quantity: the BOQ quantity plus the net effect
 * of APPROVED variations. Not submitted ones. Approved ones.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FOURTH PROPERTY: RETENTION RELEASED TWICE IS MONEY GONE
 * ══════════════════════════════════════════════════════════════════════
 * Five per cent of every bill is held back, for years, across twenty-odd
 * bills, and released in two tranches — half at practical completion,
 * half when the defect liability period expires. On a ₹40 crore contract
 * that is ₹2 crore sitting in a column nobody reconciles.
 *
 * ⚠️ IT IS RELEASED BY DIFFERENT PEOPLE AT DIFFERENT TIMES, YEARS APART,
 * and the person releasing the second tranche in 2029 has no way to see
 * that somebody released it in 2027 unless the system tells them. So
 * `retention_ledger` is a two-sided ledger — every rupee held is a row,
 * every rupee released is a row — with a unique index that makes a named
 * release stage happen exactly once and a trigger that refuses a release
 * that would take cumulative released above cumulative held.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ QUANTITIES ARE SCALED INTEGERS. NEVER FLOATS.
 * ══════════════════════════════════════════════════════════════════════
 * 12.345 cum × ₹4,567.89 must be exactly ₹56,390.60 — every time, on
 * every machine, in the database and in the browser. In IEEE-754 doubles
 * neither 12.345 nor 4567.89 is representable, and the product lands
 * either side of the paisa depending on the order of operations. A single
 * BOQ line is worth lakhs; a project has two thousand of them.
 *
 * So quantities are `bigint` MICRO-UNITS: six decimal places, fixed.
 * 12.345 cum is stored as `12345000`. Rates are `bigint` paise per unit.
 * The product is an exact integer multiplication divided by 10^6 with
 * half-up rounding, and it lives in exactly one place —
 * `lib/construction/quantities.ts` — so it cannot differ between the
 * abstract of a bill and the bill.
 *
 * ⚠️ AND THE VALUE OF A LINE IS ALWAYS COMPUTED FROM THE **CUMULATIVE**
 * QUANTITY, then reduced by the previously certified value. Rounding each
 * bill's incremental quantity and adding them up drifts by a paisa per
 * bill per line; on 2,000 lines over 25 bills that is ₹500 of unexplained
 * difference between the final bill and the contract account.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ A CONTRACTOR IS A VENDOR. There is no contractor table.
 * ══════════════════════════════════════════════════════════════════════
 * `vendors` from Phase 33 already carries the PAN that decides the 194C
 * rate, the MSME clock, the GSTIN and the bank details. A parallel
 * contractor table would mean a second PAN for the same person, and the
 * one used for the TDS deduction would be decided by which screen the
 * payment was raised from.
 *
 * Likewise the deduction itself: 194C is `lib/tds/` (Phase 36), the GST
 * on the bill is `lib/gst/` (Phase 32). Nothing here restates either.
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
import { projects } from "./sales";
import { vendors } from "./purchases";

/**
 * ⚠️ THE RA BILL LIVES IN `./contracting`, NOT HERE — READ THIS BEFORE
 * ADDING ONE BACK.
 *
 * ══════════════════════════════════════════════════════════════════════
 * This file once carried its own `ra_bills`, `ra_bill_items`,
 * `ra_bill_deductions` and `ra_bill_certifications`. So does
 * `./contracting`, which was written later, is smaller, is covered by
 * SQL-FILES/0031, has tests, and whose tables are the ones that actually
 * exist in the database.
 *
 * Two definitions of the same four tables cannot both be exported from
 * the schema barrel — Drizzle would see `ra_bills` declared twice and the
 * TypeScript names would shadow. That collision is precisely why this
 * file sat unregistered for months while its BOQ and measurement-book
 * work — which nothing else in the system provides — went unused.
 *
 * ⭐ SO THE SPLIT IS BY WHAT EACH SIDE OWNS, NOT BY WHICH FILE IS OLDER:
 *
 *   ./contracting  — the BILL. What is certified, what is deducted, what
 *                    is paid, and the EPF/ESI gate that blocks payment.
 *   ./construction — what the bill is ABOUT. The bill of quantities, the
 *                    measurement book the quantities are read from, the
 *                    rate analysis behind each rate, and the variations
 *                    that change the contract.
 *
 * A measurement entry and a retention-ledger row still POINT at a bill,
 * so they reference the one true `raBills` from `./contracting`.
 */
import { raBills } from "./contracting";

/* ------------------------------------------------------------------ */
/* ENUMS — THE BOQ SIDE                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE UNIT OF MEASUREMENT IS PART OF THE PRICE, NOT A LABEL.
 *
 * ₹6,450 per cum and ₹6,450 per sqm are different contracts. A rate
 * carried against the wrong unit is not a display bug — it is billed, and
 * on structural concrete the two differ by roughly the slab thickness.
 *
 * `ls` (lump sum) is here because a real BOQ has lines that are not
 * measured at all ("provide and commission the STP, complete"). Its
 * quantity is always 1 and its rate is the whole price; see the CHECK on
 * `boq_items`.
 */
export const uomCodeEnum = pgEnum("uom_code", [
  "cum", // cubic metre — concrete, earthwork
  "sqm", // square metre — plaster, tiling, formwork
  "sqft", // square foot — still quoted this way on finishing work in India
  "rmt", // running metre — skirting, pipes, kerb
  "kg", // kilogram — reinforcement, structural steel
  "mt", // metric tonne — bulk steel, cement in bulk
  "quintal", // 100 kg — still used by some suppliers
  "nos", // number — doors, fixtures, fittings
  "bag", // 50 kg cement bag
  "brass", // 100 cft — sand and aggregate, western India
  "ltr", // litre — admixture, paint
  "day", // day rate — labour, plant on hire
  "month", // monthly hire
  "ls", // lump sum — see above
]);

export const boqItemCategoryEnum = pgEnum("boq_item_category", [
  "earthwork",
  "piling_foundation",
  "concrete",
  "reinforcement",
  "formwork",
  "masonry",
  "plaster",
  "flooring",
  "waterproofing",
  "doors_windows",
  "painting",
  "plumbing",
  "electrical",
  "hvac",
  "fire_fighting",
  "lifts",
  "external_development",
  "preliminaries",
  "miscellaneous",
]);

/**
 * ⚠️ `issued` IS THE POINT OF NO RETURN AND `superseded` IS NOT
 * `cancelled`.
 *
 *   draft      — being priced. Anything may change.
 *   issued     — ⭐ CONTRACTUAL. It has gone to a contractor, been quoted
 *                against, and forms part of a work order. Frozen.
 *   superseded — a later version replaced it. Both stay in the record,
 *                because a bill raised under version 2 has to be readable
 *                against version 2 forever.
 *   closed     — the final bill has been paid; the contract account is
 *                shut.
 */
export const boqStatusEnum = pgEnum("boq_status", [
  "draft",
  "issued",
  "superseded",
  "closed",
]);

/**
 * ⭐ WHAT A VARIATION DOES TO THE CONTRACT.
 *
 * `omission` is the one people forget to model. A variation is not always
 * more money — scope taken out of a contract reduces the contract sum,
 * and a system that can only add is a system whose contract sum is
 * permanently overstated.
 *
 * `extra_item` is different from `addition`: an addition is more of an
 * existing BOQ line at the existing rate; an extra item is work with no
 * BOQ line at all, which needs a NEW rate — and a new rate needs a rate
 * analysis, which is why `rate_analyses` exists.
 */
export const variationKindEnum = pgEnum("variation_kind", [
  "addition",
  "omission",
  "rate_change",
  "substitution",
  "extra_item",
]);

/**
 * ⚠️ ONLY `approved` MOVES THE AUTHORISED QUANTITY. A submitted variation
 * is a request. Letting a submitted one raise the ceiling would mean a
 * contractor could bill against work nobody has agreed to pay for, which
 * is the ordinary way a contract sum is exceeded by accident.
 */
export const variationStatusEnum = pgEnum("variation_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
]);

/**
 * ⭐ THE FIVE THINGS A RATE IS BUILT FROM. A quoted rate that cannot be
 * broken down is a rate nobody can defend in a negotiation, and — more
 * practically — a rate nobody can re-derive when steel moves 18%.
 */
export const rateComponentKindEnum = pgEnum("rate_component_kind", [
  "material",
  "labour",
  "plant",
  "transport",
  "wastage",
  "overhead",
  "profit",
]);

/* ------------------------------------------------------------------ */
/* ENUMS — THE BILLING SIDE                                            */
/* ------------------------------------------------------------------ */

export const measurementStatusEnum = pgEnum("measurement_status", [
  "recorded",
  "checked",
  "billed",
  "rejected",
]);

/**
 * ⚠️ AN ADVANCE IS A LOAN AGAINST FUTURE WORK, NOT A PAYMENT.
 *
 * A mobilisation advance of 10% is given so the contractor can get on
 * site, and it is recovered pro-rata from bills — usually starting once
 * the work done crosses some percentage. It is secured by a bank
 * guarantee that must not be allowed to expire before the recovery is
 * complete, which is why `bank_guarantee_expires_on` is here.
 */
export const advanceKindEnum = pgEnum("contract_advance_kind", [
  "mobilisation",
  "material",
  "plant",
  "secured_advance",
]);

export const retentionEntryKindEnum = pgEnum("retention_entry_kind", [
  "held",
  "released",
]);

/**
 * ⭐ WHEN RETENTION COMES BACK. Each named stage happens EXACTLY ONCE per
 * contract — SQL 0028 §9 has the partial unique index that says so —
 * because the second half is released years after the first, by somebody
 * who was not there for the first.
 *
 * ⚠️ `ad_hoc` is excluded from that uniqueness deliberately: an
 * adjustment or a court-ordered part release can genuinely happen more
 * than once, and forcing it into a named stage would make somebody
 * mislabel the tranche that matters.
 */
export const retentionReleaseStageEnum = pgEnum("retention_release_stage", [
  "practical_completion",
  "defect_liability_expiry",
  "bank_guarantee_substitution",
  "ad_hoc",
]);

/* ------------------------------------------------------------------ */
/* ITEM MASTER                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ STANDARD ITEMS, WITH THEIR SPECIFICATION REFERENCE.
 *
 * ⚠️ `specification_ref` IS WHY THIS TABLE EXISTS RATHER THAN JUST FREE
 * TEXT ON A BOQ LINE. "M25 concrete" is not a specification; "M25 grade
 * concrete conforming to IS 456:2000, 20mm nominal aggregate, slump
 * 100-125mm, pump placed" is. When a cube test fails, the argument is
 * about which one was contracted, and a BOQ line that says only the first
 * is a line the developer loses on.
 *
 * The master is per tenant — every developer's standard descriptions are
 * their own, hard-won over years, and are commercially theirs.
 */
export const boqItemMaster = pgTable(
  "boq_item_master",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** "CON-M25-PUMP". Unique per workspace. */
    code: varchar("code", { length: 60 }).notNull(),
    category: boqItemCategoryEnum("category").default("miscellaneous").notNull(),

    /** The one-line description that appears on the BOQ. */
    shortDescription: varchar("short_description", { length: 500 }).notNull(),
    /** The full clause, which is what is actually contracted. */
    fullDescription: text("full_description"),

    /**
     * ⚠️ NOT DECORATION. "IS 456:2000 Cl. 8.2.2", "CPWD Specifications
     * 2019 Vol.1 Item 4.1.3", "NBC 2016 Part 6". It is the sentence that
     * decides a dispute about workmanship.
     */
    specificationRef: varchar("specification_ref", { length: 255 }),

    /** ⭐ Part of the price. See the enum comment. */
    uom: uomCodeEnum("uom").notNull(),

    /**
     * An indicative rate in paise per unit, for estimating only.
     * ⚠️ NEVER copied silently on to a BOQ — a two-year-old indicative
     * rate on a contract document is a loss nobody decided to take.
     */
    indicativeRateMinor: bigint("indicative_rate_minor", { mode: "bigint" }),
    indicativeRateOn: date("indicative_rate_on", { mode: "string" }),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("boq_item_master_id_tenant_key").on(t.id, t.tenantId),
    codePerTenant: uniqueIndex("boq_item_master_code_tenant_unique").on(
      t.tenantId,
      t.code,
    ),
    tenantIdx: index("boq_item_master_tenant_idx").on(t.tenantId, t.category),
    activeIdx: index("boq_item_master_active_idx").on(t.tenantId, t.isActive),
    rateNonNegative: check(
      "boq_item_master_rate_non_negative",
      sql`${t.indicativeRateMinor} IS NULL OR ${t.indicativeRateMinor} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* BILL OF QUANTITIES                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A BOQ IS A CONTRACT DOCUMENT, AND THAT IS THE WHOLE DESIGN.
 *
 * It is versioned per (project, work package). Version 1 goes out to
 * tender; version 2 is what was actually awarded; version 3 exists
 * because the client changed the finishing schedule. A bill raised under
 * version 2 must be readable against version 2 in five years' time, so
 * versions supersede rather than overwrite.
 *
 * ⚠️ ONCE `issued_at` IS SET, THE HEADER AND EVERY LINE ARE FROZEN
 * (SQL 0028 §5). The contractor quoted against those quantities and
 * rates. Changing them afterwards means our copy and theirs disagree, and
 * theirs is attached to the work order.
 */
export const boqs = pgTable(
  "boqs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    projectId: uuid("project_id").notNull(),

    /**
     * ⚠️ A PROJECT HAS MANY BOQs. "Tower A — civil", "Tower A — MEP",
     * "External development". One BOQ per project would mean one
     * contractor per project, which is not how anything above four floors
     * is built.
     */
    workPackage: varchar("work_package", { length: 200 }).notNull(),
    /** Human-facing: "AH/BOQ/TWR-A/CIVIL". */
    code: varchar("code", { length: 60 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),

    version: integer("version").default(1).notNull(),
    status: boqStatusEnum("status").default("draft").notNull(),

    /**
     * ⭐ THE CONTRACTOR IS A `vendors` ROW. See the file header. NULLABLE
     * because a BOQ is priced before it is awarded — at tender there is
     * no contractor yet.
     */
    contractorVendorId: uuid("contractor_vendor_id"),

    /** The work order / agreement this BOQ is annexed to. */
    contractRef: varchar("contract_ref", { length: 120 }),
    contractDate: date("contract_date", { mode: "string" }),

    /**
     * ⭐ THE REAL LINK TO THE WORKS CONTRACT — added v0.68.0 (SQL 0041).
     *
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ `contractRef` ABOVE IS FREE TEXT AND WAS THE ONLY LINK THERE WAS.
     * ══════════════════════════════════════════════════════════════════
     * This product had two complete halves of contracting that had never
     * been introduced: the measurement half (boqs → boq_items →
     * measurement_entries) and the payment half (works_contracts →
     * ra_bills → ra_bill_lines). Between them sat two varchars —
     * `contract_ref` here and `boq_code` on the bill line.
     *
     * Nothing joined, so nothing could be CHECKED. In particular nothing
     * could stop a subcontractor billing 1,100 m³ against a line
     * authorised for 1,000, spread across four bills none of which looks
     * wrong on its own. That is the most ordinary way money leaks out of
     * an Indian construction contract.
     *
     * With a real column, SQL 0041 §3 installs the guard that refuses it.
     *
     * ⚠️ NULLABLE, AND IT STAYS NULLABLE. A BOQ is routinely priced and
     * issued for tender before any contract exists — that is the normal
     * sequence, not an edge case. `contractRef` is kept alongside because
     * it is what the paper annexure actually says, and the two can
     * legitimately differ.
     *
     * ⚠️ NO `.references()` HERE. The real constraint is composite —
     * `(contract_id, tenant_id) → works_contracts (id, tenant_id)` — and
     * lives in SQL 0041, like every other FK in this schema. A single-
     * column Drizzle reference would permit a BOQ in one tenant to point
     * at a contract in another.
     */
    contractId: uuid("contract_id"),

    /* --- ⭐ THE CONTRACT SUM ---------------------------------------- */
    //
    // ⚠️ THREE NUMBERS, NOT ONE, AND THE DISTINCTION IS THE PHASE.
    //   original — the sum of the issued BOQ lines. Frozen at issue.
    //   variation — the net effect of APPROVED variations. Signed: an
    //               omission makes it negative.
    //   revised  — original + variation. What the contract is worth today.
    //
    // A single "contract sum" column that gets edited leaves nobody able
    // to answer "how much has this contract grown?", which is the first
    // question at every project review.
    originalSumMinor: bigint("original_sum_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    variationSumMinor: bigint("variation_sum_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    revisedSumMinor: bigint("revised_sum_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /* --- ⭐ THE COMMERCIAL TERMS THAT DRIVE EVERY BILL -------------- */
    //
    // ⚠️ STORED ON THE CONTRACT, NOT READ FROM A SETTING. A retention
    // percentage changed in a settings screen in year three must not
    // restate what bill 4 held in year one. Every bill also copies the
    // rate it used on to itself, for the same reason.
    /** Basis points withheld from every bill. 500 = 5%. */
    retentionRateBps: integer("retention_rate_bps").default(500).notNull(),
    /**
     * ⚠️ THE CAP, AND IT IS ALWAYS THERE IN A REAL CONTRACT. "5% of each
     * bill up to a maximum of 5% of the contract sum." Without it,
     * retention on a contract that doubled through variations quietly
     * doubles too, and the contractor is short by crores at handover.
     * NULL means uncapped, which should be rare and deliberate.
     */
    retentionCapMinor: bigint("retention_cap_minor", { mode: "bigint" }),

    /** Half at completion, half at DLP expiry, typically. Basis points. */
    retentionReleaseOnCompletionBps: integer("retention_release_completion_bps")
      .default(5000)
      .notNull(),
    /** Months after practical completion. 12 is the Indian norm. */
    defectLiabilityMonths: integer("defect_liability_months").default(12).notNull(),

    /**
     * ⭐ THE GST RATE ON THE CONTRACTOR'S SUPPLY. 18% for most works
     * contracts; 12% for some affordable-housing work. Copied on to each
     * bill, never recomputed for a historic one.
     */
    gstRateBps: integer("gst_rate_bps").default(1800).notNull(),
    /**
     * ⚠️ SECTION 51 CGST. 2%, and it applies only where the contract value
     * exceeds ₹2,50,000 and the deductor is notified. Stored per contract
     * because whether it applies is a fact about this contract.
     */
    gstTdsApplicable: boolean("gst_tds_applicable").default(false).notNull(),
    gstTdsRateBps: integer("gst_tds_rate_bps").default(200).notNull(),

    /**
     * ⭐ THE INCOME-TAX SECTION. Almost always 194C for a works contract.
     * ⚠️ THE RATE IS NOT STORED HERE — it depends on whether the payee is
     * an individual/HUF, whether they have a usable PAN, and whether a
     * Section 197 certificate applies. `lib/tds/` decides that per
     * payment; a rate frozen on the contract would survive the day the
     * contractor's PAN went inoperative.
     */
    tdsSection: varchar("tds_section", { length: 12 }).default("194C").notNull(),

    /* --- Lifecycle --------------------------------------------------- */
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issuedBy: uuid("issued_by"),
    /** The version that replaced this one. */
    supersededById: uuid("superseded_by_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("boqs_id_tenant_key").on(t.id, t.tenantId),
    codePerTenant: uniqueIndex("boqs_code_version_tenant_unique").on(
      t.tenantId,
      t.code,
      t.version,
    ),
    tenantIdx: index("boqs_tenant_idx").on(t.tenantId, t.status),
    projectIdx: index("boqs_project_idx").on(t.tenantId, t.projectId),
    contractorIdx: index("boqs_contractor_idx").on(t.tenantId, t.contractorVendorId),

    /**
     * ⭐ THE CONTRACT SUM MUST FOOT ON THE FACE OF THE RECORD. A revised
     * sum that is not original plus variations is a project review where
     * three people quote three different contract values.
     */
    sumBalances: check(
      "boqs_sum_balances",
      sql`${t.revisedSumMinor} = ${t.originalSumMinor} + ${t.variationSumMinor}`,
    ),
    ratesSane: check(
      "boqs_rates_sane",
      sql`${t.retentionRateBps} BETWEEN 0 AND 10000
          AND ${t.retentionReleaseOnCompletionBps} BETWEEN 0 AND 10000
          AND ${t.gstRateBps} BETWEEN 0 AND 10000
          AND ${t.gstTdsRateBps} BETWEEN 0 AND 10000
          AND ${t.defectLiabilityMonths} >= 0
          AND ${t.version} >= 1`,
    ),
    capNonNegative: check(
      "boqs_retention_cap_non_negative",
      sql`${t.retentionCapMinor} IS NULL OR ${t.retentionCapMinor} >= 0`,
    ),
  }),
);

/**
 * ⭐ ONE PRICED LINE OF THE CONTRACT.
 *
 * ⚠️ `quantity_scaled` AND `rate_minor` ARE THE CONTRACT. They are frozen
 * at issue. Everything a variation does lands in the two `varied_*`
 * columns, maintained by a trigger from APPROVED variations only
 * (SQL 0028 §4), so that the authorised position is
 *
 *     authorised quantity = quantity_scaled + varied_quantity_scaled
 *     effective rate      = COALESCE(varied_rate_minor, rate_minor)
 *
 * and the original is still legible beside it. Overwriting the original
 * would make "what did we agree, before all this?" unanswerable — which
 * is the question a claim turns on.
 */
export const boqItems = pgTable(
  "boq_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    boqId: uuid("boq_id").notNull(),
    /** Optional link to the master. NULL for a one-off item. */
    itemMasterId: uuid("item_master_id"),

    /** "3.4.1" — the numbering the contractor quotes in every letter. */
    itemCode: varchar("item_code", { length: 60 }).notNull(),
    /** Ordering within the BOQ. Not the same as `item_code`. */
    sequence: integer("sequence").notNull(),
    /** A heading row carries no quantity and no rate. */
    isHeading: boolean("is_heading").default(false).notNull(),

    category: boqItemCategoryEnum("category").default("miscellaneous").notNull(),
    description: text("description").notNull(),
    specificationRef: varchar("specification_ref", { length: 255 }),

    uom: uomCodeEnum("uom").notNull(),

    /**
     * ⭐ MICRO-UNITS. 12.345 cum is 12345000. See the file header for why
     * this is not a numeric or a double.
     */
    quantityScaled: bigint("quantity_scaled", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** Paise per ONE unit. ₹4,567.89 per cum is 456789. */
    rateMinor: bigint("rate_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** round_half_up(quantity_scaled × rate_minor / 1e6). Checked in SQL §3. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /* --- ⭐ THE VARIATION POSITION, DERIVED AND MAINTAINED ---------- */
    //
    // ⚠️ WRITTEN ONLY BY THE TRIGGER IN SQL 0028 §4, from variation lines
    // whose variation is APPROVED. Never by the application: a screen
    // that could set the authorised quantity directly is a screen that
    // can authorise work without an approval.
    variedQuantityScaled: bigint("varied_quantity_scaled", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    variedRateMinor: bigint("varied_rate_minor", { mode: "bigint" }),
    /** Signed. An omission is negative. */
    variedAmountMinor: bigint("varied_amount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** The rate analysis that justifies the rate, where one was built. */
    rateAnalysisId: uuid("rate_analysis_id"),

    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("boq_items_id_tenant_key").on(t.id, t.tenantId),
    codePerBoq: uniqueIndex("boq_items_code_boq_unique").on(t.boqId, t.itemCode),
    seqPerBoq: uniqueIndex("boq_items_sequence_boq_unique").on(t.boqId, t.sequence),
    tenantIdx: index("boq_items_tenant_idx").on(t.tenantId, t.boqId),
    masterIdx: index("boq_items_master_idx").on(t.tenantId, t.itemMasterId),

    /**
     * ⚠️ QUANTITIES AND RATES ARE NON-NEGATIVE ON THE BOQ ITSELF. A
     * negative line here would be an omission written as a price, which
     * is what `boq_variations` is for — and it would make the contract
     * sum a number nobody can reconcile to the priced document.
     */
    nonNegative: check(
      "boq_items_non_negative",
      sql`${t.quantityScaled} >= 0 AND ${t.rateMinor} >= 0 AND ${t.amountMinor} >= 0
          AND (${t.variedRateMinor} IS NULL OR ${t.variedRateMinor} >= 0)`,
    ),
    /**
     * ⭐ THE AUTHORISED QUANTITY MAY NOT GO NEGATIVE. An omission cannot
     * take out more than was there.
     */
    authorisedNonNegative: check(
      "boq_items_authorised_non_negative",
      sql`${t.quantityScaled} + ${t.variedQuantityScaled} >= 0`,
    ),
    /** A heading carries no money. */
    headingIsEmpty: check(
      "boq_items_heading_is_empty",
      sql`NOT ${t.isHeading}
          OR (${t.quantityScaled} = 0 AND ${t.rateMinor} = 0 AND ${t.amountMinor} = 0)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RATE ANALYSIS                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHY THE RATE IS THE RATE.
 *
 * A rate analysis builds ₹6,450 per cum of M25 up from cement, sand,
 * aggregate, admixture, mixer hire, labour, wastage, overhead and profit.
 * Two things make it worth storing rather than doing in a spreadsheet:
 *
 *   1. ⭐ IT IS THE ONLY DEFENSIBLE ANSWER TO "WHY IS IT THAT MUCH?" —
 *      from a client, from an auditor, and from the contractor arguing
 *      the extra item rate is too low.
 *   2. ⭐ WHEN STEEL MOVES 18%, EVERY RATE THAT CONTAINS STEEL MOVES. A
 *      rate with no analysis behind it has to be re-guessed.
 *
 * ⚠️ THE ANALYSIS IS FOR A STATED OUTPUT QUANTITY, not for one unit.
 * Concrete is analysed per 10 cum because that is how the coefficients
 * are published; the per-unit rate is the total divided by the output.
 * Recording the output makes the division auditable instead of implied.
 */
export const rateAnalyses = pgTable(
  "rate_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 60 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    itemMasterId: uuid("item_master_id"),

    uom: uomCodeEnum("uom").notNull(),
    /** ⭐ Micro-units. "Per 10 cum" is 10000000. Never zero — see CHECK. */
    outputQuantityScaled: bigint("output_quantity_scaled", { mode: "bigint" }).notNull(),

    /** The day the input prices were true. A rate is a dated thing. */
    pricedOn: date("priced_on", { mode: "string" }).notNull(),

    /* --- The build-up, stored so the total is auditable ------------- */
    materialMinor: bigint("material_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    labourMinor: bigint("labour_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    plantMinor: bigint("plant_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    transportMinor: bigint("transport_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    wastageMinor: bigint("wastage_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    overheadMinor: bigint("overhead_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    profitMinor: bigint("profit_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** Sum of the seven. Checked. */
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** total ÷ output, in paise per unit. Half-up. */
    derivedRateMinor: bigint("derived_rate_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Percentages applied on the prime cost, recorded for re-derivation. */
    overheadRateBps: integer("overhead_rate_bps").default(0).notNull(),
    profitRateBps: integer("profit_rate_bps").default(0).notNull(),
    wastageRateBps: integer("wastage_rate_bps").default(0).notNull(),

    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("rate_analyses_id_tenant_key").on(t.id, t.tenantId),
    codePerTenant: uniqueIndex("rate_analyses_code_tenant_unique").on(t.tenantId, t.code),
    tenantIdx: index("rate_analyses_tenant_idx").on(t.tenantId),

    /** ⚠️ Dividing by the output means the output cannot be zero. */
    outputPositive: check(
      "rate_analyses_output_positive",
      sql`${t.outputQuantityScaled} > 0`,
    ),
    totalBalances: check(
      "rate_analyses_total_balances",
      sql`${t.totalMinor} = ${t.materialMinor} + ${t.labourMinor} + ${t.plantMinor}
                          + ${t.transportMinor} + ${t.wastageMinor}
                          + ${t.overheadMinor} + ${t.profitMinor}`,
    ),
    nonNegative: check(
      "rate_analyses_non_negative",
      sql`${t.materialMinor} >= 0 AND ${t.labourMinor} >= 0 AND ${t.plantMinor} >= 0
          AND ${t.transportMinor} >= 0 AND ${t.wastageMinor} >= 0
          AND ${t.overheadMinor} >= 0 AND ${t.profitMinor} >= 0
          AND ${t.derivedRateMinor} >= 0`,
    ),
  }),
);

/**
 * One line of the build-up. Quantity × rate, in the same exact arithmetic
 * as everything else — a rate analysis that rounds differently from the
 * BOQ it feeds is a rate analysis that does not reconcile to its own
 * conclusion.
 */
export const rateAnalysisComponents = pgTable(
  "rate_analysis_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    rateAnalysisId: uuid("rate_analysis_id").notNull(),
    sequence: integer("sequence").notNull(),
    kind: rateComponentKindEnum("kind").notNull(),

    description: varchar("description", { length: 500 }).notNull(),
    uom: uomCodeEnum("uom").notNull(),
    /** ⭐ Micro-units. Coefficients are the point: 0.45 bags per cum. */
    quantityScaled: bigint("quantity_scaled", { mode: "bigint" }).default(sql`0`).notNull(),
    rateMinor: bigint("rate_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("rate_analysis_components_id_tenant_key").on(t.id, t.tenantId),
    seqUnique: uniqueIndex("rate_analysis_components_seq_unique").on(
      t.rateAnalysisId,
      t.sequence,
    ),
    tenantIdx: index("rate_analysis_components_tenant_idx").on(
      t.tenantId,
      t.rateAnalysisId,
    ),
    nonNegative: check(
      "rate_analysis_components_non_negative",
      sql`${t.quantityScaled} >= 0 AND ${t.rateMinor} >= 0 AND ${t.amountMinor} >= 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* VARIATIONS / CHANGE ORDERS                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ONLY LAWFUL WAY THE CONTRACT CHANGES.
 *
 * ⚠️ AND THE ONLY WAY A MEASUREMENT MAY EXCEED THE BOQ. SQL 0028 §8
 * bounds every measurement and every cumulative bill quantity by the
 * AUTHORISED quantity, which moves only when a variation reaches
 * `approved`. That is what stops a contract sum growing without anybody
 * deciding it should.
 *
 * ⚠️ `approved_by` IS NOT `created_by`, AND THE DATABASE SAYS SO
 * (SQL 0028 §4). Somebody raising a variation and approving it themselves
 * is a person who can award themselves work.
 */
export const boqVariations = pgTable(
  "boq_variations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    boqId: uuid("boq_id").notNull(),
    /** "VO-07". Unique per BOQ. */
    variationNumber: varchar("variation_number", { length: 40 }).notNull(),
    sequence: integer("sequence").notNull(),

    kind: variationKindEnum("kind").notNull(),
    status: variationStatusEnum("status").default("draft").notNull(),

    title: varchar("title", { length: 255 }).notNull(),
    /**
     * ⚠️ NOT NULL. "Why" is the whole document. A variation whose reason
     * is blank is one nobody can defend at a project review, and the
     * reason is what distinguishes a design change the developer must pay
     * for from a contractor's own rework that they must not.
     */
    reason: text("reason").notNull(),

    /** Instruction reference — the site instruction or client letter. */
    instructionRef: varchar("instruction_ref", { length: 120 }),
    instructedOn: date("instructed_on", { mode: "string" }),

    /**
     * ⭐ SIGNED. An omission is negative, and it must be, or the contract
     * sum only ever goes up.
     */
    effectMinor: bigint("effect_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("boq_variations_id_tenant_key").on(t.id, t.tenantId),
    numberPerBoq: uniqueIndex("boq_variations_number_boq_unique").on(
      t.boqId,
      t.variationNumber,
    ),
    tenantIdx: index("boq_variations_tenant_idx").on(t.tenantId, t.status),
    boqIdx: index("boq_variations_boq_idx").on(t.tenantId, t.boqId),

    /**
     * ⭐ AN APPROVED VARIATION HAS A NAMED APPROVER AND A DATE. "The
     * system approved it" is not an answer at a project review, and an
     * approval with no date cannot be placed against the bill that
     * relied on it.
     */
    approvalComplete: check(
      "boq_variations_approval_complete",
      sql`${t.status} <> 'approved'
          OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
    rejectionExplained: check(
      "boq_variations_rejection_explained",
      sql`${t.status} <> 'rejected'
          OR (${t.rejectedAt} IS NOT NULL AND ${t.rejectionReason} IS NOT NULL)`,
    ),
    /**
     * ⚠️ AN OMISSION MUST REDUCE AND AN ADDITION MUST NOT. A row typed the
     * wrong way round is a contract sum that moves the wrong way and a
     * variation register that reads as nonsense.
     */
    signMatchesKind: check(
      "boq_variations_sign_matches_kind",
      sql`(${t.kind} <> 'omission' OR ${t.effectMinor} <= 0)
          AND (${t.kind} <> 'addition' OR ${t.effectMinor} >= 0)`,
    ),
  }),
);

/**
 * ⭐ WHAT A VARIATION DOES TO ONE LINE.
 *
 * `boq_item_id` is NULL for an EXTRA ITEM — work with no BOQ line at all,
 * which is why `description`, `uom` and `rate_minor` are carried here
 * too. An extra item at a rate with no analysis behind it is the most
 * expensive kind of paperwork on a site.
 */
export const boqVariationItems = pgTable(
  "boq_variation_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    variationId: uuid("variation_id").notNull(),
    /** NULL for an extra item that has no BOQ line. */
    boqItemId: uuid("boq_item_id"),
    sequence: integer("sequence").notNull(),

    description: text("description").notNull(),
    uom: uomCodeEnum("uom").notNull(),

    /** ⭐ SIGNED micro-units. An omission of 40 cum is -40000000. */
    quantityDeltaScaled: bigint("quantity_delta_scaled", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /**
     * The rate this line is valued at. For a `rate_change` variation it is
     * the NEW rate and it replaces the BOQ rate on the item.
     */
    rateMinor: bigint("rate_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** ⚠️ TRUE only on a rate_change/substitution. Drives the trigger in §4. */
    replacesRate: boolean("replaces_rate").default(false).notNull(),

    /** Signed. Negative for an omission. */
    amountDeltaMinor: bigint("amount_delta_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    rateAnalysisId: uuid("rate_analysis_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("boq_variation_items_id_tenant_key").on(t.id, t.tenantId),
    seqUnique: uniqueIndex("boq_variation_items_seq_unique").on(
      t.variationId,
      t.sequence,
    ),
    tenantIdx: index("boq_variation_items_tenant_idx").on(t.tenantId, t.variationId),
    itemIdx: index("boq_variation_items_item_idx").on(t.tenantId, t.boqItemId),

    rateNonNegative: check(
      "boq_variation_items_rate_non_negative",
      sql`${t.rateMinor} >= 0`,
    ),
    /**
     * ⚠️ A RATE CHANGE MUST NAME THE LINE IT CHANGES. Replacing the rate of
     * nothing is a row that silently does nothing at all.
     */
    rateChangeHasItem: check(
      "boq_variation_items_rate_change_has_item",
      sql`NOT ${t.replacesRate} OR ${t.boqItemId} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ MEASUREMENT BOOK                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE MEASUREMENT BOOK IS THE PRIMARY RECORD, AND IT IS A LEGAL ONE.
 *
 * In public works it is a numbered, bound, page-controlled register that
 * is produced in arbitration and in audit. Everything a contractor is
 * paid traces back to a page of it. Its digital equivalent has to keep
 * the same three properties:
 *
 *   • ⭐ WHO MEASURED, BY NAME. `measured_by` is NOT NULL. An anonymous
 *     measurement is worthless as evidence and impossible to segregate
 *     from certification.
 *   • ⭐ WHERE. `location_ref` and `level_ref` — "Tower A, Grid C4-C6,
 *     3rd floor slab". A quantity with no location cannot be checked
 *     against the building, which is what checking IS.
 *   • ⭐ CUMULATIVE, NOT PERIODIC. Entries accumulate across bills; a
 *     bill takes the running total and subtracts what the last bill took.
 */
export const measurementBooks = pgTable(
  "measurement_books",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    projectId: uuid("project_id").notNull(),
    boqId: uuid("boq_id").notNull(),

    /** "MB-014". The bound-book number, kept because auditors ask for it. */
    bookNumber: varchar("book_number", { length: 40 }).notNull(),
    title: varchar("title", { length: 255 }),

    openedOn: date("opened_on", { mode: "string" }).notNull(),
    closedOn: date("closed_on", { mode: "string" }),
    isClosed: boolean("is_closed").default(false).notNull(),

    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("measurement_books_id_tenant_key").on(t.id, t.tenantId),
    numberPerTenant: uniqueIndex("measurement_books_number_tenant_unique").on(
      t.tenantId,
      t.bookNumber,
    ),
    tenantIdx: index("measurement_books_tenant_idx").on(t.tenantId, t.boqId),
    projectIdx: index("measurement_books_project_idx").on(t.tenantId, t.projectId),
    closedIsDated: check(
      "measurement_books_closed_is_dated",
      sql`NOT ${t.isClosed} OR ${t.closedOn} IS NOT NULL`,
    ),
  }),
);

/**
 * ⭐ ONE MEASURED QUANTITY, WITH ITS DIMENSIONS SHOWN.
 *
 * ⚠️ THE DIMENSIONS ARE STORED SEPARATELY FROM THE RESULT ON PURPOSE.
 * "12 × 4.500 × 0.230 × 3.000 = 37.260 cum" is checkable by somebody
 * standing at the wall with a tape. "37.260" is not. The whole practice
 * of checking measurement depends on the working being visible, and a
 * system that stored only the answer would quietly end that practice.
 *
 * ⚠️ `is_deduction` IS NOT A NEGATIVE QUANTITY. Openings — doors, windows,
 * ducts — are measured POSITIVE and deducted, because that is how the
 * standard method of measurement reads and how a checker verifies it. A
 * signed quantity would let a deduction be typed as an addition with no
 * visible difference.
 */
export const measurementEntries = pgTable(
  "measurement_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    measurementBookId: uuid("measurement_book_id").notNull(),
    boqItemId: uuid("boq_item_id").notNull(),
    /** Set when a bill consumes this entry. NULL until then. */
    raBillId: uuid("ra_bill_id"),

    /** Page and item within the book. Auditors cite these. */
    pageRef: varchar("page_ref", { length: 40 }),
    sequence: integer("sequence").notNull(),

    /** ⭐ "Tower A, Grid C4-C6". NOT NULL — see the table comment. */
    locationRef: varchar("location_ref", { length: 255 }).notNull(),
    /** "3rd floor slab", "+9.600m". */
    levelRef: varchar("level_ref", { length: 120 }),
    description: text("description"),

    /* --- The working, in micro-units -------------------------------- */
    nosScaled: bigint("nos_scaled", { mode: "bigint" }),
    lengthScaled: bigint("length_scaled", { mode: "bigint" }),
    breadthScaled: bigint("breadth_scaled", { mode: "bigint" }),
    depthScaled: bigint("depth_scaled", { mode: "bigint" }),

    /** ⭐ The answer, in micro-units. Always POSITIVE — see `isDeduction`. */
    quantityScaled: bigint("quantity_scaled", { mode: "bigint" }).notNull(),
    isDeduction: boolean("is_deduction").default(false).notNull(),

    measuredOn: date("measured_on", { mode: "string" }).notNull(),
    /** ⭐ NOT NULL. See the table comment. */
    measuredBy: uuid("measured_by").notNull(),

    status: measurementStatusEnum("status").default("recorded").notNull(),
    checkedBy: uuid("checked_by"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("measurement_entries_id_tenant_key").on(t.id, t.tenantId),
    seqPerBook: uniqueIndex("measurement_entries_seq_unique").on(
      t.measurementBookId,
      t.sequence,
    ),
    tenantIdx: index("measurement_entries_tenant_idx").on(t.tenantId, t.boqItemId),
    bookIdx: index("measurement_entries_book_idx").on(t.tenantId, t.measurementBookId),
    billIdx: index("measurement_entries_bill_idx").on(t.tenantId, t.raBillId),

    quantityPositive: check(
      "measurement_entries_quantity_positive",
      sql`${t.quantityScaled} >= 0`,
    ),
    dimensionsNonNegative: check(
      "measurement_entries_dimensions_non_negative",
      sql`(${t.nosScaled}     IS NULL OR ${t.nosScaled}     >= 0)
          AND (${t.lengthScaled}  IS NULL OR ${t.lengthScaled}  >= 0)
          AND (${t.breadthScaled} IS NULL OR ${t.breadthScaled} >= 0)
          AND (${t.depthScaled}   IS NULL OR ${t.depthScaled}   >= 0)`,
    ),
    /**
     * ⚠️ A CHECKED ENTRY HAS A NAMED CHECKER. The check is the control;
     * an unattributed one is not a control.
     */
    checkIsAttributed: check(
      "measurement_entries_check_attributed",
      sql`${t.status} <> 'checked'
          OR (${t.checkedBy} IS NOT NULL AND ${t.checkedAt} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ ADVANCES AND RETENTION                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ MONEY PAID BEFORE THE WORK, RECOVERED FROM THE BILLS.
 *
 * ⚠️ `recovered_minor` MAY NEVER EXCEED `granted_minor`. Over-recovering
 * an advance takes money that was never lent, and it is invisible: the
 * bill's own arithmetic is consistent and the contractor only notices at
 * the final account, by which time three RA bills have been paid on the
 * wrong basis.
 *
 * ⚠️ AND THE GUARANTEE EXPIRY IS HERE BECAUSE IT IS THE REAL RISK. A
 * mobilisation advance of ₹2 crore secured by a bank guarantee that
 * lapsed while ₹80 lakh was still outstanding is an unsecured loan to a
 * contractor who may not finish.
 */
export const contractAdvances = pgTable(
  "contract_advances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    boqId: uuid("boq_id").notNull(),
    contractorVendorId: uuid("contractor_vendor_id").notNull(),

    kind: advanceKindEnum("kind").notNull(),
    reference: varchar("reference", { length: 80 }).notNull(),

    grantedMinor: bigint("granted_minor", { mode: "bigint" }).notNull(),
    grantedOn: date("granted_on", { mode: "string" }).notNull(),

    /**
     * ⭐ HOW IT COMES BACK. Basis points of each bill's gross value.
     * ⚠️ Recovery usually STARTS once work done crosses a threshold and
     * must FINISH by another — a contract that recovers 10% of each bill
     * from bill 1 and a contract that recovers nothing until 20% complete
     * are different cash positions, and both are written into real
     * agreements.
     */
    recoveryRateBps: integer("recovery_rate_bps").default(0).notNull(),
    recoveryStartsAtProgressBps: integer("recovery_starts_progress_bps")
      .default(0)
      .notNull(),
    recoveryCompleteByProgressBps: integer("recovery_complete_progress_bps")
      .default(10000)
      .notNull(),

    /** Maintained as bills recover it. Never above `granted_minor`. */
    recoveredMinor: bigint("recovered_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    bankGuaranteeRef: varchar("bank_guarantee_ref", { length: 120 }),
    bankGuaranteeExpiresOn: date("bank_guarantee_expires_on", { mode: "string" }),
    interestRateBps: integer("interest_rate_bps").default(0).notNull(),

    isClosed: boolean("is_closed").default(false).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("contract_advances_id_tenant_key").on(t.id, t.tenantId),
    refPerBoq: uniqueIndex("contract_advances_ref_boq_unique").on(t.boqId, t.reference),
    tenantIdx: index("contract_advances_tenant_idx").on(t.tenantId, t.boqId),
    vendorIdx: index("contract_advances_vendor_idx").on(t.tenantId, t.contractorVendorId),

    /** ⭐⭐ The one that stops money being taken that was never lent. */
    recoveryWithinGrant: check(
      "contract_advances_recovery_within_grant",
      sql`${t.grantedMinor} > 0
          AND ${t.recoveredMinor} >= 0
          AND ${t.recoveredMinor} <= ${t.grantedMinor}`,
    ),
    ratesSane: check(
      "contract_advances_rates_sane",
      sql`${t.recoveryRateBps} BETWEEN 0 AND 10000
          AND ${t.recoveryStartsAtProgressBps} BETWEEN 0 AND 10000
          AND ${t.recoveryCompleteByProgressBps} BETWEEN 0 AND 10000
          AND ${t.interestRateBps} BETWEEN 0 AND 10000`,
    ),
  }),
);

/**
 * ⭐⭐ RETENTION, AS A TWO-SIDED LEDGER.
 *
 * ⚠️ A SINGLE `retention_balance` COLUMN IS THE DEFECT THIS TABLE EXISTS
 * TO PREVENT. Held over twenty bills across three years and released in
 * two tranches two years apart, a balance column is edited by four
 * different people and reconciles to nothing. The question that has to be
 * answerable in 2029 is "was the first tranche released, and by whom?" —
 * and a balance cannot answer it.
 *
 * So: every rupee held is a row against the bill that held it, every
 * rupee released is a row against the stage that released it,
 * `retention_ledger_stage_once` makes a named stage happen exactly once,
 * and SQL 0028 §9 refuses a release that would take cumulative released
 * above cumulative held.
 */
export const retentionLedger = pgTable(
  "retention_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    boqId: uuid("boq_id").notNull(),
    contractorVendorId: uuid("contractor_vendor_id").notNull(),

    entryKind: retentionEntryKindEnum("entry_kind").notNull(),
    /** The bill that held it. NULL on a release. */
    raBillId: uuid("ra_bill_id"),
    /** ⭐ Which release this is. NULL on a hold. */
    releaseStage: retentionReleaseStageEnum("release_stage"),

    /** ⚠️ ALWAYS POSITIVE. The direction is `entry_kind`, not the sign. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),

    /**
     * ⚠️ NOT NULL ON A RELEASE. "Released per clause 12.3 on expiry of the
     * defect liability period, certificate dated 14 Mar 2029" is what
     * somebody has to be able to read in five years.
     */
    reason: text("reason"),
    reference: varchar("reference", { length: 120 }),

    actorId: uuid("actor_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ REQUIRED AS A COMPOSITE FOREIGN KEY TARGET.
     *
     * A plain FK on the child id alone lets a row in tenant A point at a
     * parent in tenant B. RLS then hides the parent and shows the child,
     * and you get a measurement against a BOQ line the reader cannot see.
     * (id, tenant_id) makes that reference unrepresentable rather than
     * merely unlikely — see SQL-FILES/0038.
     */
    tenantScoped: uniqueIndex("retention_ledger_id_tenant_key").on(t.id, t.tenantId),
    tenantIdx: index("retention_ledger_tenant_idx").on(t.tenantId, t.boqId),
    billIdx: index("retention_ledger_bill_idx").on(t.tenantId, t.raBillId),
    kindIdx: index("retention_ledger_kind_idx").on(t.tenantId, t.boqId, t.entryKind),

    /**
     * ⭐ A BILL HOLDS RETENTION ONCE. Two hold rows for one bill is
     * retention counted twice against a contractor who was only deducted
     * once.
     */
    holdOncePerBill: uniqueIndex("retention_ledger_hold_once_per_bill")
      .on(t.raBillId)
      .where(sql`entry_kind = 'held'`),

    amountPositive: check(
      "retention_ledger_amount_positive",
      sql`${t.amountMinor} > 0`,
    ),
    /**
     * ⭐⭐ A RELEASE NAMES ITS STAGE AND ITS REASON; A HOLD NAMES ITS BILL.
     * A release row with neither is money leaving a retention account
     * with nothing on it saying why.
     */
    shapeMatchesKind: check(
      "retention_ledger_shape_matches_kind",
      sql`(${t.entryKind} = 'held'
             AND ${t.raBillId} IS NOT NULL AND ${t.releaseStage} IS NULL)
          OR (${t.entryKind} = 'released'
             AND ${t.releaseStage} IS NOT NULL AND ${t.reason} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const boqItemMasterRelations = relations(boqItemMaster, ({ one, many }) => ({
  tenant: one(tenants, { fields: [boqItemMaster.tenantId], references: [tenants.id] }),
  items: many(boqItems),
}));

export const boqsRelations = relations(boqs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [boqs.tenantId], references: [tenants.id] }),
  project: one(projects, { fields: [boqs.projectId], references: [projects.id] }),
  contractor: one(vendors, {
    fields: [boqs.contractorVendorId],
    references: [vendors.id],
  }),
  issuer: one(users, { fields: [boqs.issuedBy], references: [users.id] }),
  items: many(boqItems),
  variations: many(boqVariations),
  advances: many(contractAdvances),
  retention: many(retentionLedger),
}));

export const boqItemsRelations = relations(boqItems, ({ one, many }) => ({
  tenant: one(tenants, { fields: [boqItems.tenantId], references: [tenants.id] }),
  boq: one(boqs, { fields: [boqItems.boqId], references: [boqs.id] }),
  master: one(boqItemMaster, {
    fields: [boqItems.itemMasterId],
    references: [boqItemMaster.id],
  }),
  rateAnalysis: one(rateAnalyses, {
    fields: [boqItems.rateAnalysisId],
    references: [rateAnalyses.id],
  }),
  measurements: many(measurementEntries),
}));

export const rateAnalysesRelations = relations(rateAnalyses, ({ one, many }) => ({
  tenant: one(tenants, { fields: [rateAnalyses.tenantId], references: [tenants.id] }),
  master: one(boqItemMaster, {
    fields: [rateAnalyses.itemMasterId],
    references: [boqItemMaster.id],
  }),
  components: many(rateAnalysisComponents),
}));

export const rateAnalysisComponentsRelations = relations(
  rateAnalysisComponents,
  ({ one }) => ({
    analysis: one(rateAnalyses, {
      fields: [rateAnalysisComponents.rateAnalysisId],
      references: [rateAnalyses.id],
    }),
  }),
);

export const boqVariationsRelations = relations(boqVariations, ({ one, many }) => ({
  tenant: one(tenants, { fields: [boqVariations.tenantId], references: [tenants.id] }),
  boq: one(boqs, { fields: [boqVariations.boqId], references: [boqs.id] }),
  approver: one(users, { fields: [boqVariations.approvedBy], references: [users.id] }),
  items: many(boqVariationItems),
}));

export const boqVariationItemsRelations = relations(boqVariationItems, ({ one }) => ({
  variation: one(boqVariations, {
    fields: [boqVariationItems.variationId],
    references: [boqVariations.id],
  }),
  boqItem: one(boqItems, {
    fields: [boqVariationItems.boqItemId],
    references: [boqItems.id],
  }),
}));

export const measurementBooksRelations = relations(measurementBooks, ({ one, many }) => ({
  tenant: one(tenants, { fields: [measurementBooks.tenantId], references: [tenants.id] }),
  project: one(projects, {
    fields: [measurementBooks.projectId],
    references: [projects.id],
  }),
  boq: one(boqs, { fields: [measurementBooks.boqId], references: [boqs.id] }),
  entries: many(measurementEntries),
}));

export const measurementEntriesRelations = relations(measurementEntries, ({ one }) => ({
  book: one(measurementBooks, {
    fields: [measurementEntries.measurementBookId],
    references: [measurementBooks.id],
  }),
  boqItem: one(boqItems, {
    fields: [measurementEntries.boqItemId],
    references: [boqItems.id],
  }),
  bill: one(raBills, { fields: [measurementEntries.raBillId], references: [raBills.id] }),
  measurer: one(users, {
    fields: [measurementEntries.measuredBy],
    references: [users.id],
  }),
}));

export const contractAdvancesRelations = relations(contractAdvances, ({ one }) => ({
  tenant: one(tenants, { fields: [contractAdvances.tenantId], references: [tenants.id] }),
  boq: one(boqs, { fields: [contractAdvances.boqId], references: [boqs.id] }),
  contractor: one(vendors, {
    fields: [contractAdvances.contractorVendorId],
    references: [vendors.id],
  }),
}));

export const retentionLedgerRelations = relations(retentionLedger, ({ one }) => ({
  tenant: one(tenants, { fields: [retentionLedger.tenantId], references: [tenants.id] }),
  boq: one(boqs, { fields: [retentionLedger.boqId], references: [boqs.id] }),
  bill: one(raBills, { fields: [retentionLedger.raBillId], references: [raBills.id] }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type BoqItemMaster = typeof boqItemMaster.$inferSelect;
export type NewBoqItemMaster = typeof boqItemMaster.$inferInsert;
export type Boq = typeof boqs.$inferSelect;
export type NewBoq = typeof boqs.$inferInsert;
export type BoqItem = typeof boqItems.$inferSelect;
export type NewBoqItem = typeof boqItems.$inferInsert;
export type RateAnalysis = typeof rateAnalyses.$inferSelect;
export type NewRateAnalysis = typeof rateAnalyses.$inferInsert;
export type RateAnalysisComponent = typeof rateAnalysisComponents.$inferSelect;
export type NewRateAnalysisComponent = typeof rateAnalysisComponents.$inferInsert;
export type BoqVariation = typeof boqVariations.$inferSelect;
export type NewBoqVariation = typeof boqVariations.$inferInsert;
export type BoqVariationItem = typeof boqVariationItems.$inferSelect;
export type NewBoqVariationItem = typeof boqVariationItems.$inferInsert;
export type MeasurementBook = typeof measurementBooks.$inferSelect;
export type NewMeasurementBook = typeof measurementBooks.$inferInsert;
export type MeasurementEntry = typeof measurementEntries.$inferSelect;
export type NewMeasurementEntry = typeof measurementEntries.$inferInsert;
export type ContractAdvance = typeof contractAdvances.$inferSelect;
export type NewContractAdvance = typeof contractAdvances.$inferInsert;
export type RetentionLedgerEntry = typeof retentionLedger.$inferSelect;
export type NewRetentionLedgerEntry = typeof retentionLedger.$inferInsert;

export type UomCode = (typeof uomCodeEnum.enumValues)[number];
export type BoqItemCategory = (typeof boqItemCategoryEnum.enumValues)[number];
export type BoqStatus = (typeof boqStatusEnum.enumValues)[number];
export type VariationKind = (typeof variationKindEnum.enumValues)[number];
export type VariationStatus = (typeof variationStatusEnum.enumValues)[number];
export type RateComponentKind = (typeof rateComponentKindEnum.enumValues)[number];
export type MeasurementStatus = (typeof measurementStatusEnum.enumValues)[number];
export type ContractAdvanceKind = (typeof advanceKindEnum.enumValues)[number];
export type RetentionEntryKind = (typeof retentionEntryKindEnum.enumValues)[number];
export type RetentionReleaseStage = (typeof retentionReleaseStageEnum.enumValues)[number];
