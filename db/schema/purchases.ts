/**
 * Ordence — Purchases, Vendor Invoices and ⭐ Input Tax Credit
 * Version: v0.33.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT PHASE 33 IS: THE OTHER HALF OF THE TAX
 * ══════════════════════════════════════════════════════════════════════
 * Phase 32 built the OUTWARD side — what we charge. This phase builds the
 * INWARD side — what we are charged, and how much of that tax we are
 * allowed to keep.
 *
 * The two are not symmetrical, and the asymmetry is the whole phase. On
 * the outward side the question is arithmetic: which tax, at what rate,
 * on what value. Get it wrong and the document is wrong, which somebody
 * eventually notices. On the inward side the arithmetic is the SUPPLIER'S
 * problem — it arrives on their invoice, already computed. Our question
 * is a legal one that nothing on the document answers:
 *
 *              MAY WE CLAIM THIS TAX AS A CREDIT?
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS IS THE MOST EXPENSIVE QUESTION A DEVELOPER ASKS
 * ══════════════════════════════════════════════════════════════════════
 * Section 17(5) of the CGST Act blocks credit on a list of things. Two of
 * the entries on that list are aimed directly at property developers, and
 * they look nearly identical on a purchase invoice:
 *
 *   17(5)(c) — works contract services for construction of an immovable
 *              property, EXCEPT plant and machinery, and EXCEPT where the
 *              service is an input for the FURTHER SUPPLY of works
 *              contract service.
 *   17(5)(d) — goods or services received for construction of an
 *              immovable property ON HIS OWN ACCOUNT, including when used
 *              in the course or furtherance of business.
 *
 * So: a lorry of cement, one HSN code, one rate, one vendor.
 *
 *   • Delivered to a tower whose flats are being SOLD BEFORE the
 *     completion certificate — that construction is a taxable OUTWARD
 *     SUPPLY of service (Schedule II, para 5(b)), not construction on our
 *     own account. ⭐ THE CREDIT IS ELIGIBLE.
 *   • Delivered to the head office we are building for ourselves, or to a
 *     tower we intend to LEASE rather than sell, or to flats sold AFTER
 *     the completion certificate — that is construction on our own
 *     account and the building is a capital asset. ⭐ THE CREDIT IS
 *     BLOCKED, and it is capitalised into the cost of the building.
 *
 * Same cement. Same invoice. Opposite answers, decided by a fact that
 * exists nowhere on the document — what the building is FOR.
 *
 * Getting it wrong in the eligible direction costs the tax, plus interest
 * at 18% from the date of the wrong claim, plus a penalty. On a mid-size
 * tower the blocked credit runs to crores. It is the single most
 * expensive GST error available to a developer, and it is invisible:
 * nothing errors, nothing looks wrong, the return files cleanly, and it
 * surfaces at an audit years later.
 *
 * That is why `itc_purpose` is a NOT NULL enum on every line, why the
 * database refuses `own_account_construction` with an eligible credit
 * outright (SQL 0023 §5), and why `lib/purchases/itc.ts` returns the
 * statutory clause and a sentence with every determination.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not restate one line of Phase 32. GSTINs come from
 * `gst_parties`, classifications from `hsn_sac_codes`, the rate from the
 * DATED `hsn_sac_rates` row (pinned per line, ON DELETE RESTRICT, for the
 * same reason a sales invoice pins it), place of supply from
 * `lib/gst/place-of-supply.ts`, and every paisa of tax from
 * `computeInvoiceTax` in `lib/gst/tax.ts`.
 *
 * It does not compute TDS. `is_tds_deductible`, `tds_section` and
 * `tds_base_minor` are RECORDED here because the decision is made when
 * the bill is entered; the deduction, the challan and the certificate are
 * a separate phase. ⚠️ `tds_base_minor` EXCLUDES GST — CBDT Circular
 * 23/2017 — and it is stored rather than derived so that a later phase
 * cannot quietly deduct on the gross.
 *
 * Money is `bigint` paise. Rates are integer basis points.
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
  numeric,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { gstParties, gstRegistrations, gstSupplyTypeEnum } from "./gst";

/* ------------------------------------------------------------------ */
/* ENUMS — VENDORS                                                     */
/* ------------------------------------------------------------------ */

/**
 * What kind of counterparty this is.
 *
 * ⚠️ NOT COSMETIC. The category is the first hint at the TDS section
 * (194C for a contractor, 194J for an architect, 194I for a landlord) and
 * at the reverse-charge position (a goods transport agency is Section
 * 9(3) reverse charge whatever the invoice says). Neither is DECIDED by
 * this column — both are recorded explicitly — but a vendor typed as
 * "other" is a vendor nobody screened.
 */
export const vendorTypeEnum = pgEnum("vendor_type", [
  "material_supplier",
  "contractor",
  "professional",
  "transporter",
  "landlord",
  "utility",
  "government",
  "other",
]);

/**
 * MSME classification under the MSMED Act, 2006, as revised in 2020.
 *
 * ⚠️ THE CATEGORY IS NOT TRIVIA — IT STARTS A CLOCK. Section 15 of the
 * MSMED Act requires payment to a registered micro or small enterprise
 * within the agreed period, capped at 45 days. Section 43B(h) of the
 * Income-tax Act, from AY 2024-25, DISALLOWS the expenditure entirely in
 * the year it was incurred if the payment is late — the deduction moves
 * to the year of actual payment, and the tax on the difference is paid
 * now. A construction company that pays its small subcontractors on
 * 90-day terms discovers this at assessment.
 *
 * ⚠️ MEDIUM ENTERPRISES ARE ON THIS LIST BUT ARE **NOT** COVERED BY
 * SECTION 43B(h). The disallowance applies to micro and small only.
 * Treating all three the same is the obvious simplification and it would
 * raise a false alarm on every medium vendor, which is how a real alarm
 * gets ignored.
 */
export const msmeCategoryEnum = pgEnum("msme_category", [
  "micro",
  "small",
  "medium",
]);

/* ------------------------------------------------------------------ */
/* ENUMS — THE PURCHASE DOCUMENT                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `cancelled` IS A STATE, NOT A DELETE. A purchase invoice that has
 * been recorded has already fed a return; the row stays and stops
 * counting. Deleting it would make the ITC register disagree with the
 * GSTR-3B already filed, and nothing would say why.
 */
export const purchaseInvoiceStatusEnum = pgEnum("purchase_invoice_status", [
  "draft",
  "recorded",
  "approved",
  "paid",
  "cancelled",
]);

/**
 * ⭐ THE COLUMN THE WHOLE PHASE TURNS ON.
 *
 * What is this expenditure FOR? Not what it IS — that is the HSN code and
 * it cannot answer the question. A bag of cement has one HSN whether it
 * goes into a tower we are selling or into the office we are building for
 * ourselves, and Section 17(5)(d) gives opposite answers to those two.
 *
 *   taxable_supply               — an ordinary business input feeding a
 *                                  taxable outward supply. Eligible.
 *   sold_before_completion       — ⭐ construction of units being sold
 *                                  BEFORE the completion certificate.
 *                                  That is a taxable supply of service
 *                                  under Schedule II para 5(b), so the
 *                                  spend is NOT "on own account".
 *                                  ELIGIBLE — subject to the rate
 *                                  notification, see below.
 *   own_account_construction     — ⭐ our own building: head office, a
 *                                  tower we will lease, or flats sold
 *                                  after the completion certificate.
 *                                  BLOCKED under 17(5)(d).
 *   further_supply_works_contract— a subcontract bill feeding an onward
 *                                  works contract we ourselves supply.
 *                                  The express exception in 17(5)(c);
 *                                  this is how a main contractor stays
 *                                  whole.
 *   plant_and_machinery          — the statutory exception to BOTH (c)
 *                                  and (d). ⚠️ The Explanation to
 *                                  Section 17 excludes land, buildings
 *                                  and other civil structures from
 *                                  "plant and machinery" — a lift or a
 *                                  chiller qualifies, the shaft it sits
 *                                  in does not.
 *   exempt_supply                — feeds a wholly exempt outward supply.
 *                                  Section 17(2): no credit.
 *   common                       — feeds taxable AND exempt supplies.
 *                                  Rule 42/43 apportionment.
 *   non_business                 — personal or non-business use.
 *                                  17(5)(g), and T1 in the Rule 42
 *                                  formula.
 */
export const itcPurposeEnum = pgEnum("itc_purpose", [
  "taxable_supply",
  "sold_before_completion",
  "own_account_construction",
  "further_supply_works_contract",
  "plant_and_machinery",
  "exempt_supply",
  "common",
  "non_business",
]);

/**
 * What the expenditure IS, where the statute cares.
 *
 * ⚠️ SEPARATE FROM `itc_purpose`, AND BOTH ARE NEEDED. Purpose answers
 * "what is it for"; nature answers "what is it". Section 17(5)(a) blocks
 * a motor car no matter how business-critical it is, and 17(5)(d) blocks
 * cement no matter how ordinary it is — the two clauses key off different
 * facts and a single column would have to pick one of them to get wrong.
 */
export const expenditureNatureEnum = pgEnum("expenditure_nature", [
  /** Ordinary inputs. No clause of 17(5) is triggered by nature alone. */
  "goods",
  "input_service",
  "capital_goods",
  /** ⚠️ Passenger vehicle with approved seating ≤ 13 including driver. */
  "motor_vehicle",
  "vessel_or_aircraft",
  /** Servicing, insurance and repair of the above — 17(5)(ab). */
  "motor_vehicle_related_service",
  "food_and_beverage",
  "outdoor_catering",
  "beauty_or_health_service",
  "club_or_fitness_membership",
  "employee_travel_benefit",
  "life_or_health_insurance",
  /** ⭐ 17(5)(c). The contractor's bill for building the building. */
  "works_contract_service",
  /** ⭐ 17(5)(d). Cement, steel, sand, tiles — the material itself. */
  "construction_material",
  "rent_a_cab",
]);

/**
 * The determination. Three values, because a fourth ("deferred") belongs
 * to a PERIOD and not to a line — see `itcRegisterStatusEnum`.
 *
 * ⚠️ `proportionate` DOES NOT MEAN "PART OF THIS TAX IS BLOCKED". Under
 * Rule 42 the whole common credit enters the electronic credit ledger and
 * the ineligible portion is REVERSED — added back to output tax — in the
 * same return. That is why a `proportionate` line carries its full tax in
 * `itc_eligible_tax_minor` and the reversal appears as a separate,
 * period-level row in the register. Modelling it as a partial block would
 * disagree with GSTR-3B Table 4, where availment (4A) and reversal (4B)
 * are different boxes and both are reported.
 */
export const itcEligibilityEnum = pgEnum("itc_eligibility", [
  "eligible",
  "blocked",
  "proportionate",
]);

/**
 * WHY a credit is blocked. Every value names a clause, because "blocked"
 * without a clause is an assertion nobody can defend at an assessment —
 * and because the two construction clauses are the ones that will be
 * argued about.
 */
export const itcBlockReasonEnum = pgEnum("itc_block_reason", [
  "motor_vehicle", // 17(5)(a)
  "vessel_or_aircraft", // 17(5)(aa)
  "vehicle_related_service", // 17(5)(ab)
  "food_beverage_catering", // 17(5)(b)(i)
  "beauty_or_health_service", // 17(5)(b)(i)
  "life_or_health_insurance", // 17(5)(b)(i)
  "club_membership", // 17(5)(b)(ii)
  "employee_travel_benefit", // 17(5)(b)(iii)
  "works_contract_immovable", // ⭐ 17(5)(c)
  "construction_own_account", // ⭐ 17(5)(d)
  "composition_supplier", // 17(5)(e)
  "non_resident_supplier", // 17(5)(f)
  "personal_consumption", // 17(5)(g)
  "lost_stolen_destroyed_gifted", // 17(5)(h)
  "confiscated_or_seized", // 17(5)(i)
  "exempt_supply", // s.17(2)
  /** ⭐ Notification 03/2019-CT(R): the 1% / 5% residential scheme is
   *  expressly WITHOUT input tax credit. A developer who opted into it
   *  has no credit on that project at all, whatever 17(5) says. */
  "notified_rate_without_itc",
  /** No tax invoice, or a supplier who never filed. Section 16(2)(a)/(aa). */
  "no_valid_tax_invoice",
]);

/**
 * ⭐ THE RULE 42 BUCKETS, NAMED AS THE RULE NAMES THEM.
 *
 * The formula in Rule 42(1) is written in terms of T1, T2, T3, T4, C1,
 * C2, C3, D1 and D2. Storing the bucket under our own vocabulary and
 * translating at report time is how the reversal stops being checkable
 * against the rule — so the enum values map one-to-one onto the letters,
 * and `lib/purchases/apportionment.ts` returns them under the same names.
 */
export const rule42AttributionEnum = pgEnum("rule42_attribution", [
  "exclusively_non_business", // T1
  "exclusively_exempt", // T2
  "blocked", // T3
  "exclusively_taxable", // T4
  "common", // feeds C3
]);

/* ------------------------------------------------------------------ */
/* ENUMS — THE ITC REGISTER                                            */
/* ------------------------------------------------------------------ */

/**
 * What happened to a credit in a tax period.
 *
 * ⚠️ THERE IS NO `reclaimed`, DELIBERATELY. When a credit reversed under
 * Rule 37 (payment not made within 180 days) is re-availed after the
 * supplier is paid, GSTR-3B puts it back in Table 4(A)(5) — the SAME box
 * as an ordinary availment. So a re-claim is a `claimed` row in the later
 * period, with reason `reclaim_after_payment`. A fifth status would mean
 * the register and the return disagreed about what a re-claim is.
 *
 * `deferred` is the one that has no equivalent on the outward side: the
 * credit is eligible in principle but Section 16(2) is not yet satisfied
 * — goods in transit, the last instalment of a capital item not received,
 * or the supplier's GSTR-1 not filed so nothing appears in our GSTR-2B.
 * A deferred credit is NOT claimed and NOT blocked, and conflating it
 * with either is how a legitimate credit is lost to the Section 16(4)
 * time limit.
 */
export const itcRegisterStatusEnum = pgEnum("itc_register_status", [
  "claimed",
  "blocked",
  "deferred",
  "reversed",
]);

/** WHY a movement happened. Free text would not aggregate. */
export const itcMovementReasonEnum = pgEnum("itc_movement_reason", [
  "invoice_claim",
  "rcm_self_assessed",
  "section_17_5_blocked",
  "rule_42_common_reversal",
  "rule_43_capital_reversal",
  "rule_37_non_payment_180_days",
  "credit_note_received",
  "goods_not_received",
  "supplier_not_filed",
  "reclaim_after_payment",
  "annual_true_up",
]);

/* ------------------------------------------------------------------ */
/* ENUMS — THE VENDOR LEDGER                                           */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `retention_held` AND `retention_released` ARE NOT PADDING. A
 * construction company withholds 5–10% of every contractor bill as
 * retention money against defects, released after the defect liability
 * period. It is a real, large, long-lived payable that is NOT overdue —
 * and an ageing report that treats it as an unpaid invoice puts the
 * biggest number on the page in the 180+ bucket and makes the report
 * useless.
 */
export const vendorLedgerEntryTypeEnum = pgEnum("vendor_ledger_entry_type", [
  "purchase_invoice",
  "debit_note",
  "credit_note",
  "payment",
  "advance",
  "tds_deducted",
  "retention_held",
  "retention_released",
  "adjustment",
]);

/* ------------------------------------------------------------------ */
/* VENDORS                                                             */
/* ------------------------------------------------------------------ */

/**
 * The payee. One row per commercial relationship, NOT one per GSTIN.
 *
 * ⚠️ WHY THIS IS NOT JUST `gst_parties` WITH `party_type = 'vendor'`.
 *
 * `gst_parties` answers "what tax identity did we transact under, and was
 * it valid on the date of this document" — it is DATED, and the same firm
 * legitimately has several rows as its registration changes. A vendor is
 * a single continuing relationship with payment terms, a bank account, an
 * MSME status and a running balance, and it must survive its
 * counterparty's re-registration without the balance splitting in two.
 *
 * So: one vendor, pointing at the CURRENT `gst_parties` row. Documents
 * pin their own party row; the vendor carries the relationship.
 */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Human-facing identifier: "V-0042". Unique per workspace. */
    code: varchar("code", { length: 40 }).notNull(),

    /**
     * ⭐ The Phase 32 GSTIN registry row. Composite FK in SQL §4.
     *
     * NULLABLE, and that is not laziness: a great many vendors on a
     * construction site are genuinely unregistered — the sand supplier,
     * the local labour contractor — and a purchase from them is a
     * Section 9(4) reverse-charge liability rather than a missing GSTIN.
     * Forcing a party row would push somebody into inventing one.
     */
    gstPartyId: uuid("gst_party_id"),

    /** Optional link to the CRM company record. Composite FK in SQL §4. */
    companyId: uuid("company_id"),

    legalName: varchar("legal_name", { length: 255 }).notNull(),
    tradeName: varchar("trade_name", { length: 255 }),
    vendorType: vendorTypeEnum("vendor_type").default("other").notNull(),

    /**
     * ⚠️ PAN IS STORED ON THE VENDOR AS WELL AS IN THE GSTIN.
     *
     * Characters 3–12 of a GSTIN are the PAN, so for a registered vendor
     * this is derivable. For an UNREGISTERED one it is not, and it is the
     * fact that decides the TDS rate: Section 206AA requires deduction at
     * 20% (or twice the normal rate, whichever is higher) where the payee
     * has not furnished a PAN. A missing PAN is a 20% deduction, and
     * discovering that after the payment has gone out means recovering it
     * from a subcontractor who has already left the site.
     */
    panNumber: varchar("pan_number", { length: 10 }),

    /* --- MSME (Phase 40 reads these) ------------------------------ */

    msmeRegistered: boolean("msme_registered").default(false).notNull(),

    /**
     * The Udyam Registration Number: `UDYAM-XX-00-0000000`.
     *
     * ⚠️ EXACTLY 19 CHARACTERS AND A FIXED SHAPE. Two-letter state, two
     * digits, seven digits. It replaced the old Udyog Aadhaar (a 12-digit
     * number) in 2020 and vendors still send the old one; accepting it
     * would put a number in this column that no verification portal
     * recognises. The shape CHECK lives in SQL §1.
     */
    udyamNumber: varchar("udyam_number", { length: 19 }),
    msmeCategory: msmeCategoryEnum("msme_category"),
    msmeRegisteredOn: date("msme_registered_on", { mode: "string" }),

    /**
     * ⭐ The statutory clock, in days. NOT a free-text term.
     *
     * Section 15 of the MSMED Act: the agreed period, and in no case more
     * than 45 days from acceptance. Section 43B(h) of the Income-tax Act
     * disallows the expenditure if payment is later than that. Stored per
     * vendor because the AGREED period may be shorter (30 days is common)
     * and the disallowance bites at whichever is earlier.
     */
    paymentTermsDays: integer("payment_terms_days").default(30).notNull(),

    /* --- TDS position, recorded not computed ---------------------- */

    /**
     * ⚠️ RECORDED HERE, DEDUCTED ELSEWHERE. The decision that a vendor is
     * within TDS is made once, when the vendor is set up, by whoever
     * knows what they do. The deduction, the challan and the certificate
     * are a separate phase and must not be inferred from this flag alone.
     */
    tdsApplicable: boolean("tds_applicable").default(false).notNull(),
    /** "194C", "194J", "194I", "194Q". Free-form: sections get added. */
    defaultTdsSection: varchar("default_tds_section", { length: 12 }),

    /** Where the money goes. Never rendered in full on a screen. */
    bankDetails: jsonb("bank_details")
      .$type<{
        accountName?: string;
        accountNumberLast4?: string;
        ifsc?: string;
        bankName?: string;
      }>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

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
     * ⚠️ A BLOCKED VENDOR IS NOT A DELETED ONE. Blocking stops new bills
     * being entered; the history, the balance and the credits already
     * claimed all stay. A vendor with a filed return behind them can
     * never be removed.
     */
    isActive: boolean("is_active").default(true).notNull(),
    blockedReason: text("blocked_reason"),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codePerTenant: uniqueIndex("vendors_code_tenant_unique").on(t.tenantId, t.code),
    tenantIdx: index("vendors_tenant_idx").on(t.tenantId, t.isActive),
    partyIdx: index("vendors_party_idx").on(t.tenantId, t.gstPartyId),
    companyIdx: index("vendors_company_idx").on(t.tenantId, t.companyId),
    /** The Phase 40 query: who are the micro/small vendors with a clock. */
    msmeIdx: index("vendors_msme_idx")
      .on(t.tenantId, t.msmeCategory)
      .where(sql`${t.msmeRegistered}`),

    /**
     * ⚠️ AN MSME CLAIM WITHOUT A UDYAM NUMBER IS NOT AN MSME CLAIM.
     *
     * Section 43B(h) only bites for an enterprise REGISTERED under the
     * MSMED Act. A vendor who says they are small but holds no
     * registration is outside it entirely. Letting the flag be set alone
     * would put every such vendor on the 45-day alarm and train people to
     * ignore it.
     */
    msmeComplete: check(
      "vendors_msme_complete",
      sql`(NOT ${t.msmeRegistered})
          OR (${t.udyamNumber} IS NOT NULL AND ${t.msmeCategory} IS NOT NULL)`,
    ),
    udyamShape: check(
      "vendors_udyam_shape",
      sql`${t.udyamNumber} IS NULL
          OR ${t.udyamNumber} ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'`,
    ),
    panShape: check(
      "vendors_pan_shape",
      sql`${t.panNumber} IS NULL OR ${t.panNumber} ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
    ),
    /**
     * ⚠️ CAPPED AT 45. Section 15 of the MSMED Act caps the agreed period
     * at 45 days and the cap is not waivable by contract — Section 32
     * voids any agreement to the contrary. A 90-day term typed against a
     * micro vendor is not a commercial choice, it is a disallowance.
     */
    termsSane: check(
      "vendors_terms_sane",
      sql`${t.paymentTermsDays} >= 0
          AND (NOT ${t.msmeRegistered}
               OR ${t.msmeCategory} = 'medium'
               OR ${t.paymentTermsDays} <= 45)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* PURCHASE INVOICES — HEADER                                          */
/* ------------------------------------------------------------------ */

/**
 * A bill received from a vendor.
 *
 * ⚠️ THE NUMBER AND DATE ARE THE **SUPPLIER'S**, NOT OURS. That is the
 * whole difference from `invoices`. We do not allocate the serial, we do
 * not control the format, and the pair (supplier, their number, their
 * financial year) is what GSTR-2B will be matched on in Phase 34. An
 * internal voucher number would match nothing.
 *
 * ⭐ AND IT IS WHY THE DUPLICATE INDEX IN SQL §2 IS THE MOST VALUABLE
 * CONSTRAINT ON THIS TABLE. The same vendor bill entered twice — once by
 * the site office from the delivery copy, once by accounts from the
 * emailed PDF — claims the credit twice. Nothing about the second entry
 * looks wrong. It is found when GSTR-2B shows one invoice and our books
 * show two, by which time the excess has been utilised.
 */
export const purchaseInvoices = pgTable(
  "purchase_invoices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → vendors (id, tenant_id). ON DELETE RESTRICT. */
    vendorId: uuid("vendor_id").notNull(),

    /**
     * ⭐ The dated `gst_parties` row as it stood on the invoice date.
     * Pinned, so a vendor who re-registers later does not restate what
     * this document was received under. Composite FK, SQL §4.
     */
    gstPartyId: uuid("gst_party_id"),

    /**
     * ⭐ WHICH OF **OUR** REGISTRATIONS RECEIVED THIS SUPPLY.
     *
     * Not decoration. Input credit lands in the electronic credit ledger
     * OF A GSTIN. A developer registered in Maharashtra and Karnataka has
     * two ledgers, and a Pune cement bill addressed to the Bengaluru
     * GSTIN cannot be claimed in Maharashtra — Section 16(1) gives the
     * credit to the "registered person" who received the supply. Getting
     * this wrong strands the credit in a state with nothing to set it
     * against.
     */
    recipientRegistrationId: uuid("recipient_registration_id"),
    recipientGstin: varchar("recipient_gstin", { length: 15 }),
    recipientStateCode: varchar("recipient_state_code", { length: 2 }),

    /** Denormalised from the party, for the GSTR-2B match key. */
    supplierGstin: varchar("supplier_gstin", { length: 15 }),
    supplierStateCode: varchar("supplier_state_code", { length: 2 }),

    /** As printed on the vendor's document. Never re-formatted. */
    invoiceNumber: varchar("invoice_number", { length: 64 }).notNull(),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    /** When it reached us. Drives the Section 16(4) clock, not the rate. */
    receivedDate: date("received_date", { mode: "string" }),
    /** When the goods/services were actually received — Section 16(2)(b). */
    goodsReceivedDate: date("goods_received_date", { mode: "string" }),

    /** Supplier's own document type, where it is not a tax invoice. */
    isBillOfSupply: boolean("is_bill_of_supply").default(false).notNull(),

    supplyType: gstSupplyTypeEnum("supply_type").default("goods").notNull(),
    placeOfSupplyCode: varchar("place_of_supply_code", { length: 2 }),
    /** ⭐ Section 12(3): for immovable property the property decides. */
    propertyStateCode: varchar("property_state_code", { length: 2 }),
    isInterState: boolean("is_inter_state").default(false).notNull(),

    /**
     * ⭐ WHICH BUILDING. Composite FK → projects (id, tenant_id).
     *
     * ⚠️ THIS IS EVIDENCE, NOT A REPORTING DIMENSION. When an officer
     * asks why the credit on ₹4 crore of steel was claimed, the answer is
     * "it went into Tower B, whose flats were sold under agreements dated
     * before the completion certificate" — and that answer has to be
     * traceable from the invoice line to a project. A cost centre chosen
     * from a free-text list is not.
     */
    projectId: uuid("project_id"),

    /* --- Money. Every figure the vendor's document shows. --------- */

    currency: varchar("currency", { length: 3 }).default("INR").notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    roundOffMinor: bigint("round_off_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /* --- ⭐ Reverse charge ---------------------------------------- */

    /**
     * ⚠️ ON A PURCHASE, REVERSE CHARGE INVERTS THE CASH FLOW.
     *
     * On a sales invoice (Phase 32) reverse-charge tax is SHOWN AND NOT
     * COLLECTED. Here it is the opposite: the supplier does not charge
     * it, WE pay it to the Government in cash — it cannot be paid out of
     * the credit ledger, Section 49(4) — and only then may we claim it
     * back as input credit in the same return.
     *
     * So an RCM purchase is cash out AND credit in, and both legs must be
     * recorded. Booking only the credit is the common error: the return
     * shows a credit with no corresponding liability, which is exactly
     * the pattern GSTR-2B reconciliation surfaces.
     */
    isReverseCharge: boolean("is_reverse_charge").default(false).notNull(),
    /** Tax we self-assess and pay in cash. NOT part of `total_minor`. */
    rcmTaxMinor: bigint("rcm_tax_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** "9(3)", "9(4)", "5(3) IGST". Evidence for the self-invoice. */
    rcmSection: varchar("rcm_section", { length: 16 }),

    /* --- ⭐ ITC roll-up (proved against the lines by trigger) ------ */

    itcEligibleTaxMinor: bigint("itc_eligible_tax_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    itcBlockedTaxMinor: bigint("itc_blocked_tax_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * The period whose GSTR-3B this credit belongs to, `YYYY-MM`.
     *
     * ⚠️ IT IS NOT ALWAYS THE INVOICE MONTH, AND THAT IS THE POINT OF
     * HAVING THE COLUMN. A March invoice received in May is claimed in
     * May. Section 16(4) caps how late: 30 November following the end of
     * the financial year, or the annual return, whichever is earlier.
     * Deriving the period from `invoice_date` would silently claim credit
     * in a return that was filed months ago.
     */
    taxPeriod: varchar("tax_period", { length: 7 }),

    /* --- TDS: recorded, not computed ------------------------------ */

    isTdsDeductible: boolean("is_tds_deductible").default(false).notNull(),
    tdsSection: varchar("tds_section", { length: 12 }),
    /**
     * ⚠️ EXCLUDES GST. CBDT Circular 23/2017: where the tax is shown
     * separately on the invoice, income-tax TDS is deducted on the value
     * alone. Deducting on the gross over-deducts by the GST rate, and the
     * excess is only recoverable on the deductee's own return, a year
     * later. Stored rather than derived so a later phase cannot get it
     * wrong quietly.
     */
    tdsBaseMinor: bigint("tds_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⭐⭐ ADDED IN v1.11.0 (SQL 0063). The bill is now tied to what was
     * ordered and what actually arrived, and the three-way match result
     * is stored at approval so the REASON a bill was passed survives the
     * tolerance being changed later.
     */
    poId: uuid("po_id"),
    grnId: uuid("grn_id"),
    /**
     * 🔴 THE DATE THE MSME CLOCK RUNS FROM. s.15 MSMED runs from
     * acceptance, not from the invoice date the vendor chose to print.
     */
    acceptedOn: date("accepted_on", { mode: "string" }),
    amountPaidMinor: bigint("amount_paid_minor", { mode: "bigint" })
      .default(0n)
      .notNull(),
    matchState: varchar("match_state", { length: 20 }),
    matchNote: text("match_note"),
    /**
     * 🔴 THERE WAS NO DUE DATE ON A PAYABLE, so nothing could be aged.
     * Ageing runs from the due date and never the bill date — these are
     * different numbers and only one of them is true. The receivables
     * side has worked this way since 0027 and the payables side has to
     * agree, or the two reports describe different worlds.
     */
    dueDate: date("due_date", { mode: "string" }),
    status: purchaseInvoiceStatusEnum("status").default("draft").notNull(),

    /**
     * Opt-in to the reconciliation trigger, exactly as
     * `invoices.gst_computed` does. A bill imported from a legacy system
     * with only header totals is not refused; a bill that claims the
     * Phase 33 engine produced it must add up.
     */
    gstComputed: boolean("gst_computed").default(false).notNull(),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("purchase_invoices_tenant_idx").on(t.tenantId, t.status),
    vendorIdx: index("purchase_invoices_vendor_idx").on(
      t.tenantId,
      t.vendorId,
      t.invoiceDate,
    ),
    periodIdx: index("purchase_invoices_period_idx").on(t.tenantId, t.taxPeriod),
    projectIdx: index("purchase_invoices_project_idx").on(t.tenantId, t.projectId),
    /** The GSTR-2B match key Phase 34 will join on. */
    matchIdx: index("purchase_invoices_match_idx").on(
      t.tenantId,
      t.supplierGstin,
      t.invoiceNumber,
      t.invoiceDate,
    ),

    /**
     * ⚠️ THE HEADER MUST BE INTERNALLY CONSISTENT. Whether it agrees with
     * its LINES is a different question, answered by the deferred trigger
     * in SQL §6 — a header written by one statement and lines by another
     * can balance perfectly and still charge tax no line accounts for.
     */
    totalsBalance: check(
      "purchase_invoices_totals_balance",
      sql`${t.taxableValueMinor} = ${t.subtotalMinor} - ${t.discountMinor}
          AND ${t.totalMinor} = ${t.taxableValueMinor}
              + ${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor} + ${t.cessMinor}
              + ${t.roundOffMinor}`,
    ),
    /**
     * ⭐ EVERY PAISA OF TAX IS EITHER CLAIMABLE OR BLOCKED. There is no
     * third bucket and no rounding slack. A gap here is credit that
     * belongs to nobody — it neither reaches the return nor is
     * capitalised into the cost of the building, so the books and the
     * ledger diverge by exactly that amount and nothing says so.
     */
    itcSplitsExactly: check(
      "purchase_invoices_itc_splits_exactly",
      sql`${t.itcEligibleTaxMinor} + ${t.itcBlockedTaxMinor}
          = ${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor} + ${t.cessMinor}`,
    ),
    nonNegative: check(
      "purchase_invoices_non_negative",
      sql`${t.subtotalMinor} >= 0 AND ${t.discountMinor} >= 0
          AND ${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0
          AND ${t.igstMinor} >= 0 AND ${t.cessMinor} >= 0
          AND ${t.rcmTaxMinor} >= 0 AND ${t.tdsBaseMinor} >= 0
          AND ${t.itcEligibleTaxMinor} >= 0 AND ${t.itcBlockedTaxMinor} >= 0`,
    ),
    /**
     * ⚠️ IGST AND THE CGST/SGST PAIR CANNOT BOTH APPEAR. A supplier who
     * charged both got the place of supply wrong, and entering it as
     * received doubles the credit claimed on one supply.
     */
    headsExclusive: check(
      "purchase_invoices_heads_exclusive",
      sql`NOT (${t.igstMinor} > 0 AND (${t.cgstMinor} > 0 OR ${t.sgstMinor} > 0))`,
    ),
    /** A tax period is `YYYY-MM` with a real month. */
    periodShape: check(
      "purchase_invoices_period_shape",
      sql`${t.taxPeriod} IS NULL OR ${t.taxPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    /** ⭐ Section 12(3), the same rule as the outward side. */
    immovablePropertyPos: check(
      "purchase_invoices_immovable_property_pos",
      sql`${t.supplyType} <> 'immovable_property'
          OR (${t.propertyStateCode} IS NOT NULL
              AND ${t.placeOfSupplyCode} IS NOT NULL
              AND ${t.placeOfSupplyCode} = ${t.propertyStateCode})`,
    ),
    /**
     * ⚠️ A BILL OF SUPPLY CARRIES NO TAX AND THEREFORE NO CREDIT. A
     * composition dealer and an exempt supplier both issue one, and a
     * "tax" figure typed against it is a credit claimed on tax nobody
     * paid — Section 17(5)(e). Refused outright.
     */
    billOfSupplyHasNoTax: check(
      "purchase_invoices_bill_of_supply_no_tax",
      sql`NOT ${t.isBillOfSupply}
          OR (${t.cgstMinor} = 0 AND ${t.sgstMinor} = 0
              AND ${t.igstMinor} = 0 AND ${t.cessMinor} = 0)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ PURCHASE INVOICE LINES — WHERE THE ITC DECISION LIVES            */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE DETERMINATION PER LINE, NEVER PER INVOICE
 * ══════════════════════════════════════════════════════════════════════
 * The temptation is to put `itc_eligibility` on the header: one bill, one
 * answer, one screen. It is wrong on the first real invoice a developer
 * receives.
 *
 *     A contractor's running account bill for the month:
 *       • civil works on Tower B (flats sold pre-completion)  ELIGIBLE
 *       • civil works on the sample flat we will keep         BLOCKED 17(5)(d)
 *       • the lift installed in Tower B                       ELIGIBLE (plant)
 *       • tea and snacks recharged at cost                    BLOCKED 17(5)(b)
 *
 * Four answers, four clauses, one document. A header-level flag forces
 * the person entering it to pick one, and whichever they pick, some of
 * the credit is wrong. So the determination is a line-level fact, the
 * header carries only the sum, and SQL §6 proves the two agree.
 */
export const purchaseInvoiceLines = pgTable(
  "purchase_invoice_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → purchase_invoices (id, tenant_id). CASCADE. */
    purchaseInvoiceId: uuid("purchase_invoice_id").notNull(),

    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),

    /** Composite FK → hsn_sac_codes (id, tenant_id). */
    hsnSacId: uuid("hsn_sac_id"),
    /** Denormalised for the GSTR-2 HSN summary and for reading a row. */
    hsnSacCode: varchar("hsn_sac_code", { length: 8 }),

    /**
     * ⭐ The exact `hsn_sac_rates` period this line was checked against.
     * ON DELETE RESTRICT, exactly as on the outward side.
     *
     * ⚠️ ON A PURCHASE THIS IS NOT WHAT SETS THE TAX — the supplier set
     * that, and we record what they charged. It is what lets us say the
     * charge was WRONG: a supplier billing 18% on a classification
     * notified at 12% has overcharged, and a credit claimed on the excess
     * is not available (Section 16(2) allows credit of tax "charged in
     * respect of such supply", which excess is not).
     */
    gstRateId: uuid("gst_rate_id"),

    /** Tonnes of cement, not integers. Three decimals. */
    quantity: numeric("quantity", { precision: 18, scale: 3 }),
    uqc: varchar("uqc", { length: 10 }),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }),

    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    taxableValueMinor: bigint("taxable_value_minor", { mode: "bigint" }).notNull(),

    rateBps: integer("rate_bps").default(0).notNull(),
    cessRateBps: integer("cess_rate_bps").default(0).notNull(),

    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    isReverseCharge: boolean("is_reverse_charge").default(false).notNull(),

    /* --- ⭐⭐ THE ITC DETERMINATION ------------------------------- */

    /** WHAT it is — the fact 17(5)(a),(b),(c) key off. */
    expenditureNature: expenditureNatureEnum("expenditure_nature")
      .default("goods")
      .notNull(),

    /** ⭐ WHAT IT IS FOR — the fact 17(5)(d) keys off. THE column. */
    itcPurpose: itcPurposeEnum("itc_purpose").default("taxable_supply").notNull(),

    /** Which project, when the purpose is a construction one. */
    projectId: uuid("project_id"),

    itcEligibility: itcEligibilityEnum("itc_eligibility").default("eligible").notNull(),
    itcBlockReason: itcBlockReasonEnum("itc_block_reason"),
    /** "17(5)(d)". The clause, printed, so the answer is checkable. */
    itcStatutoryRef: varchar("itc_statutory_ref", { length: 24 }),

    /**
     * ⚠️ FOR A `proportionate` LINE THIS IS THE **FULL** TAX. See the
     * note on `itcEligibilityEnum`: Rule 42 takes the whole common credit
     * into the ledger and reverses the ineligible share separately, in
     * the same return. Splitting it here would double-count the reversal.
     */
    itcEligibleTaxMinor: bigint("itc_eligible_tax_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    itcBlockedTaxMinor: bigint("itc_blocked_tax_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** ⭐ Which letter of the Rule 42 formula this line feeds. */
    rule42Attribution: rule42AttributionEnum("rule42_attribution")
      .default("exclusively_taxable")
      .notNull(),

    /**
     * ⚠️ CAPITAL GOODS GO TO RULE **43**, NOT RULE 42, AND THE DIFFERENCE
     * IS SIXTY MONTHS. Rule 42 apportions the period's common credit
     * against the period's turnover, once. Rule 43 spreads a capital
     * item's common credit over sixty months and reverses a slice each
     * month for five years. Putting a chiller through Rule 42 claims in
     * one month what the law spreads over five years.
     */
    isCapitalGoods: boolean("is_capital_goods").default(false).notNull(),

    /** The sentence a human reads next to the determination. */
    itcNote: text("itc_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    invoiceIdx: index("purchase_invoice_lines_invoice_idx").on(
      t.tenantId,
      t.purchaseInvoiceId,
    ),
    linePerInvoice: uniqueIndex("purchase_invoice_lines_number_unique").on(
      t.purchaseInvoiceId,
      t.lineNumber,
    ),
    /** The ITC register build: every line of a determination, per project. */
    itcIdx: index("purchase_invoice_lines_itc_idx").on(
      t.tenantId,
      t.itcEligibility,
      t.itcPurpose,
    ),
    projectIdx: index("purchase_invoice_lines_project_idx").on(t.tenantId, t.projectId),
    rateIdx: index("purchase_invoice_lines_rate_idx").on(t.tenantId, t.gstRateId),

    taxableConsistent: check(
      "purchase_invoice_lines_taxable_consistent",
      sql`${t.taxableValueMinor} = ${t.amountMinor} - ${t.discountMinor}`,
    ),
    nonNegative: check(
      "purchase_invoice_lines_non_negative",
      sql`${t.amountMinor} >= 0 AND ${t.discountMinor} >= 0
          AND ${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0
          AND ${t.igstMinor} >= 0 AND ${t.cessMinor} >= 0
          AND ${t.rateBps} >= 0 AND ${t.cessRateBps} >= 0
          AND ${t.itcEligibleTaxMinor} >= 0 AND ${t.itcBlockedTaxMinor} >= 0`,
    ),
    headsExclusive: check(
      "purchase_invoice_lines_heads_exclusive",
      sql`NOT (${t.igstMinor} > 0 AND (${t.cgstMinor} > 0 OR ${t.sgstMinor} > 0))`,
    ),

    /**
     * ⭐⭐ THE CONSTRAINT THIS PHASE EXISTS FOR.
     *
     * A line whose purpose is construction on our OWN ACCOUNT may never
     * carry an eligible credit. Section 17(5)(d) admits no exception
     * other than plant and machinery — and plant and machinery is a
     * DIFFERENT value of `itc_purpose`, so it is unreachable from here.
     *
     * ⚠️ THE DATABASE ENFORCES IT BECAUSE THE ENGINE IS ONE WRITE PATH OF
     * FOUR. An import of a year of historical purchase bills, a
     * correction at a psql prompt and a future API route are the others,
     * and every one of them will be written by somebody who has the
     * eligible answer in their head from the previous invoice.
     */
    ownAccountIsBlocked: check(
      "purchase_invoice_lines_own_account_blocked",
      sql`${t.itcPurpose} <> 'own_account_construction'
          OR (${t.itcEligibility} = 'blocked'
              AND ${t.itcBlockReason} = 'construction_own_account')`,
    ),

    /**
     * ⚠️ "BLOCKED" WITHOUT A CLAUSE IS AN ASSERTION, NOT A DETERMINATION.
     * At an assessment the question is never "is it blocked" but "under
     * which clause", and a register that cannot answer costs the credit
     * by default.
     */
    blockReasonPresence: check(
      "purchase_invoice_lines_block_reason_presence",
      sql`(${t.itcEligibility} = 'blocked' AND ${t.itcBlockReason} IS NOT NULL)
          OR (${t.itcEligibility} <> 'blocked' AND ${t.itcBlockReason} IS NULL)`,
    ),

    /** Every paisa is claimable or blocked. No third bucket. */
    itcSplitsExactly: check(
      "purchase_invoice_lines_itc_splits_exactly",
      sql`${t.itcEligibleTaxMinor} + ${t.itcBlockedTaxMinor}
          = ${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor} + ${t.cessMinor}`,
    ),
    itcSplitMatchesVerdict: check(
      "purchase_invoice_lines_itc_split_matches_verdict",
      sql`(${t.itcEligibility} = 'blocked' AND ${t.itcEligibleTaxMinor} = 0)
          OR (${t.itcEligibility} <> 'blocked' AND ${t.itcBlockedTaxMinor} = 0)`,
    ),

    /**
     * ⚠️ A `common` ATTRIBUTION AND A NON-`proportionate` VERDICT CANNOT
     * BOTH BE TRUE. If a line feeds both taxable and exempt supplies then
     * Rule 42 applies to it; calling it fully eligible claims credit the
     * rule requires to be partly reversed, and it is the reversal — not
     * the claim — that an audit reconstructs.
     */
    commonImpliesProportionate: check(
      "purchase_invoice_lines_common_implies_proportionate",
      sql`(${t.rule42Attribution} = 'common') = (${t.itcEligibility} = 'proportionate')`,
    ),
    /**
     * ⚠️ THE VERDICT AND THE RULE 42 LETTER MUST AGREE — BUT "BLOCKED"
     * MAPS TO **THREE** LETTERS, NOT ONE, AND THAT IS THE SUBTLE PART.
     *
     * Rule 42 deducts three things from total credit before apportioning:
     * T1 (exclusively non-business), T2 (exclusively exempt) and T3
     * (blocked under Section 17(5)). All three are "no credit" to a user
     * and three different lines of the officer's working. A check written
     * as `attribution = 'blocked' ⇔ eligibility = 'blocked'` — which is
     * the obvious one — would refuse every 17(5)(g) and every Section
     * 17(2) line in the system.
     */
    verdictMatchesAttribution: check(
      "purchase_invoice_lines_verdict_matches_attribution",
      sql`(${t.itcEligibility} = 'blocked')
          = (${t.rule42Attribution} IN ('blocked','exclusively_non_business','exclusively_exempt'))`,
    ),
    eligibleAttribution: check(
      "purchase_invoice_lines_eligible_attribution",
      sql`(${t.itcEligibility} = 'eligible')
          = (${t.rule42Attribution} = 'exclusively_taxable')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ THE ITC REGISTER                                                 */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT MOVED IN THE ELECTRONIC CREDIT LEDGER, AND WHY
 * ══════════════════════════════════════════════════════════════════════
 * `purchase_invoice_lines` records a DETERMINATION — what the law says
 * about this expenditure. This table records a MOVEMENT — what we
 * actually put in a return, in which period, and why.
 *
 * They are not the same thing and must not share a table:
 *
 *   • A determination is made once and is a fact about the invoice.
 *   • A movement happens repeatedly. The same line can be deferred in
 *     April (supplier had not filed), claimed in June (they did),
 *     reversed in December (we still had not paid them, Rule 37), and
 *     claimed again in February (we paid). Four rows, four periods, one
 *     line, and the register is the only place that history exists.
 *
 * ⚠️ APPEND-ONLY IN SPIRIT AND BY GRANT (SQL §10 withholds DELETE). A
 * return, once filed, cannot be unfiled. A register that could be tidied
 * would let this month's figures stop agreeing with the GSTR-3B already
 * submitted, and the disagreement would be invisible.
 *
 * ⚠️ AMOUNTS ARE NON-NEGATIVE AND THE **STATUS** CARRIES THE DIRECTION.
 * Signed amounts are the obvious alternative and they lose the shape of
 * the return: GSTR-3B Table 4 reports availment (4A) and reversal (4B) in
 * separate boxes, both as positive numbers, and the net is derived. A
 * register of signed amounts can produce the net but can no longer
 * produce either box.
 */
export const itcRegister = pgTable(
  "itc_register",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⭐ Whose credit ledger. Composite FK → gst_registrations.
     * A workspace with two GSTINs has two ledgers that never mix.
     */
    registrationId: uuid("registration_id"),

    /** `YYYY-MM`. The GSTR-3B this movement is reported in. */
    taxPeriod: varchar("tax_period", { length: 7 }).notNull(),

    /** Composite FKs. NULL on a period-level movement — see below. */
    purchaseInvoiceId: uuid("purchase_invoice_id"),
    purchaseInvoiceLineId: uuid("purchase_invoice_line_id"),
    vendorId: uuid("vendor_id"),
    projectId: uuid("project_id"),

    status: itcRegisterStatusEnum("status").notNull(),
    reason: itcMovementReasonEnum("reason").notNull(),
    /** The clause or rule: "17(5)(d)", "Rule 42(1)(m)", "Rule 37". */
    statutoryRef: varchar("statutory_ref", { length: 24 }),
    note: text("note"),

    cgstMinor: bigint("cgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    sgstMinor: bigint("sgst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    igstMinor: bigint("igst_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /** When it was actually reported. NULL until the return is filed. */
    filedAt: timestamp("filed_at", { withTimezone: true }),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    periodIdx: index("itc_register_period_idx").on(t.tenantId, t.taxPeriod, t.status),
    lineIdx: index("itc_register_line_idx").on(t.tenantId, t.purchaseInvoiceLineId),
    invoiceIdx: index("itc_register_invoice_idx").on(t.tenantId, t.purchaseInvoiceId),
    vendorIdx: index("itc_register_vendor_idx").on(t.tenantId, t.vendorId),
    registrationIdx: index("itc_register_registration_idx").on(
      t.tenantId,
      t.registrationId,
      t.taxPeriod,
    ),

    /**
     * ⭐ ONE MOVEMENT OF EACH KIND PER LINE PER PERIOD.
     *
     * ⚠️ THIS IS NOT THE DOUBLE-CLAIM DEFENCE, AND IT MUST NOT BE
     * MISTAKEN FOR ONE. It stops the same line being claimed twice IN ONE
     * MONTH — a re-run of the period build, a double-submitted form. The
     * far more expensive case, the same line claimed in two DIFFERENT
     * months, passes this index cleanly and is refused by the cumulative
     * trigger in SQL §7.
     */
    oneMovementPerPeriod: uniqueIndex("itc_register_one_movement_per_period")
      .on(t.tenantId, t.purchaseInvoiceLineId, t.taxPeriod, t.status, t.reason)
      .where(sql`${t.purchaseInvoiceLineId} IS NOT NULL`),

    periodShape: check(
      "itc_register_period_shape",
      sql`${t.taxPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    nonNegative: check(
      "itc_register_non_negative",
      sql`${t.cgstMinor} >= 0 AND ${t.sgstMinor} >= 0
          AND ${t.igstMinor} >= 0 AND ${t.cessMinor} >= 0`,
    ),
    /**
     * ⚠️ A ZERO MOVEMENT IS NOISE THAT HIDES SIGNAL. A register full of
     * nil rows makes "was this credit ever claimed?" a question about
     * reading amounts rather than about finding a row.
     */
    notEmpty: check(
      "itc_register_not_empty",
      sql`${t.cgstMinor} + ${t.sgstMinor} + ${t.igstMinor} + ${t.cessMinor} > 0`,
    ),
    /**
     * ⚠️ A LINE-LEVEL MOVEMENT MUST NAME ITS INVOICE. Rule 42 and Rule 43
     * reversals are computed on a whole period and legitimately have
     * neither — but a movement that names a line and not the document it
     * came from cannot be traced back to a vendor at an assessment.
     */
    lineImpliesInvoice: check(
      "itc_register_line_implies_invoice",
      sql`${t.purchaseInvoiceLineId} IS NULL OR ${t.purchaseInvoiceId} IS NOT NULL`,
    ),
    /** Rule 42/43 reversals are the only period-level movements. */
    periodLevelIsReversal: check(
      "itc_register_period_level_is_reversal",
      sql`${t.purchaseInvoiceLineId} IS NOT NULL
          OR ${t.reason} IN ('rule_42_common_reversal','rule_43_capital_reversal',
                             'annual_true_up')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* VENDOR LEDGER                                                       */
/* ------------------------------------------------------------------ */

/**
 * The running account with a vendor.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO `balance_minor` COLUMN, AND ITS ABSENCE IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * A stored running balance is correct exactly until somebody enters a
 * BACKDATED bill — which happens on every construction site, because the
 * contractor's March invoice arrives in May. The moment one does, every
 * stored balance after that date is wrong, and there is no error, no log
 * line and no screen that looks different. The report simply stops
 * agreeing with the sum of its own rows.
 *
 * So the balance is computed: `SUM(...) OVER (ORDER BY entry_date, id)`
 * in the read, `runningBalance()` in `lib/purchases/vendor-ledger.ts` for
 * the pure case. It is a window function over an indexed range, and the
 * cost of that is far below the cost of a number nobody can reconcile.
 *
 * ⚠️ SIGN CONVENTION, STATED ONCE SO IT IS NEVER GUESSED: a vendor is a
 * PAYABLE. A bill CREDITS the account (we owe more); a payment DEBITS it
 * (we owe less). Balance = credits − debits, and a positive balance means
 * money is owed TO the vendor. This is the opposite of the customer-side
 * convention, and getting it backwards produces an ageing report where
 * everybody is in credit.
 */
export const vendorLedgerEntries = pgTable(
  "vendor_ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → vendors (id, tenant_id). RESTRICT. */
    vendorId: uuid("vendor_id").notNull(),

    entryDate: date("entry_date", { mode: "string" }).notNull(),
    entryType: vendorLedgerEntryTypeEnum("entry_type").notNull(),

    /** Composite FK → purchase_invoices, when the entry came from one. */
    purchaseInvoiceId: uuid("purchase_invoice_id"),
    /** Free reference for a payment: UTR, cheque number, voucher. */
    referenceNumber: varchar("reference_number", { length: 80 }),

    description: text("description"),

    /** Reduces what we owe: a payment, an advance, TDS withheld. */
    debitMinor: bigint("debit_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** Increases what we owe: a bill, a debit note, retention released. */
    creditMinor: bigint("credit_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    /**
     * ⭐ WHEN IT FALLS DUE. Not derived, stored.
     *
     * ⚠️ FOR AN MSME VENDOR THIS IS A STATUTORY DATE, NOT A COMMERCIAL
     * ONE. Section 15 of the MSMED Act caps it at 45 days from acceptance
     * of the goods, and Section 43B(h) of the Income-tax Act disallows the
     * whole expenditure if payment is later. Storing it means the ageing
     * report and the 43B(h) exposure are the same query rather than two
     * that can drift apart.
     */
    dueDate: date("due_date", { mode: "string" }),

    /**
     * ⚠️ RETENTION IS NOT OVERDUE. Money withheld under the contract until
     * the defect liability period ends is a payable that is not yet
     * payable, and an ageing bucket that counts it puts the largest
     * number on the page in the oldest column. Excluded from ageing by
     * `lib/purchases/vendor-ledger.ts`, and this flag is how.
     */
    excludeFromAgeing: boolean("exclude_from_ageing").default(false).notNull(),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** The running-balance scan: one vendor, in date order. */
    vendorDateIdx: index("vendor_ledger_vendor_date_idx").on(
      t.tenantId,
      t.vendorId,
      t.entryDate,
    ),
    invoiceIdx: index("vendor_ledger_invoice_idx").on(t.tenantId, t.purchaseInvoiceId),
    dueIdx: index("vendor_ledger_due_idx").on(t.tenantId, t.dueDate),

    nonNegative: check(
      "vendor_ledger_entries_non_negative",
      sql`${t.debitMinor} >= 0 AND ${t.creditMinor} >= 0`,
    ),
    /**
     * ⚠️ EXACTLY ONE SIDE. An entry carrying both a debit and a credit is
     * a net figure somebody worked out by hand, and the working is gone.
     * The gross movements are what a vendor reconciles their own ledger
     * against; a net is what starts the argument.
     */
    exactlyOneSide: check(
      "vendor_ledger_entries_exactly_one_side",
      sql`(${t.debitMinor} > 0) <> (${t.creditMinor} > 0)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  tenant: one(tenants, { fields: [vendors.tenantId], references: [tenants.id] }),
  gstParty: one(gstParties, {
    fields: [vendors.gstPartyId],
    references: [gstParties.id],
  }),
  creator: one(users, { fields: [vendors.createdBy], references: [users.id] }),
  invoices: many(purchaseInvoices),
  ledgerEntries: many(vendorLedgerEntries),
}));

export const purchaseInvoicesRelations = relations(purchaseInvoices, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [purchaseInvoices.tenantId],
    references: [tenants.id],
  }),
  vendor: one(vendors, {
    fields: [purchaseInvoices.vendorId],
    references: [vendors.id],
  }),
  recipientRegistration: one(gstRegistrations, {
    fields: [purchaseInvoices.recipientRegistrationId],
    references: [gstRegistrations.id],
  }),
  lines: many(purchaseInvoiceLines),
}));

export const purchaseInvoiceLinesRelations = relations(purchaseInvoiceLines, ({ one }) => ({
  tenant: one(tenants, {
    fields: [purchaseInvoiceLines.tenantId],
    references: [tenants.id],
  }),
  invoice: one(purchaseInvoices, {
    fields: [purchaseInvoiceLines.purchaseInvoiceId],
    references: [purchaseInvoices.id],
  }),
}));

export const itcRegisterRelations = relations(itcRegister, ({ one }) => ({
  tenant: one(tenants, { fields: [itcRegister.tenantId], references: [tenants.id] }),
  invoice: one(purchaseInvoices, {
    fields: [itcRegister.purchaseInvoiceId],
    references: [purchaseInvoices.id],
  }),
  line: one(purchaseInvoiceLines, {
    fields: [itcRegister.purchaseInvoiceLineId],
    references: [purchaseInvoiceLines.id],
  }),
  vendor: one(vendors, { fields: [itcRegister.vendorId], references: [vendors.id] }),
}));

export const vendorLedgerEntriesRelations = relations(vendorLedgerEntries, ({ one }) => ({
  tenant: one(tenants, {
    fields: [vendorLedgerEntries.tenantId],
    references: [tenants.id],
  }),
  vendor: one(vendors, {
    fields: [vendorLedgerEntries.vendorId],
    references: [vendors.id],
  }),
  invoice: one(purchaseInvoices, {
    fields: [vendorLedgerEntries.purchaseInvoiceId],
    references: [purchaseInvoices.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;
export type PurchaseInvoice = typeof purchaseInvoices.$inferSelect;
export type NewPurchaseInvoice = typeof purchaseInvoices.$inferInsert;
export type PurchaseInvoiceLine = typeof purchaseInvoiceLines.$inferSelect;
export type NewPurchaseInvoiceLine = typeof purchaseInvoiceLines.$inferInsert;
export type ItcRegisterEntry = typeof itcRegister.$inferSelect;
export type NewItcRegisterEntry = typeof itcRegister.$inferInsert;
export type VendorLedgerEntry = typeof vendorLedgerEntries.$inferSelect;
export type NewVendorLedgerEntry = typeof vendorLedgerEntries.$inferInsert;

export type VendorType = (typeof vendorTypeEnum.enumValues)[number];
export type MsmeCategory = (typeof msmeCategoryEnum.enumValues)[number];
export type PurchaseInvoiceStatus = (typeof purchaseInvoiceStatusEnum.enumValues)[number];
export type ItcPurpose = (typeof itcPurposeEnum.enumValues)[number];
export type ExpenditureNature = (typeof expenditureNatureEnum.enumValues)[number];
export type ItcEligibility = (typeof itcEligibilityEnum.enumValues)[number];
export type ItcBlockReason = (typeof itcBlockReasonEnum.enumValues)[number];
export type Rule42Attribution = (typeof rule42AttributionEnum.enumValues)[number];
export type ItcRegisterStatus = (typeof itcRegisterStatusEnum.enumValues)[number];
export type ItcMovementReason = (typeof itcMovementReasonEnum.enumValues)[number];
export type VendorLedgerEntryType = (typeof vendorLedgerEntryTypeEnum.enumValues)[number];
