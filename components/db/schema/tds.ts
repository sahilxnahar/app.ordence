/**
 * Ordence — ⭐ Tax Deducted at Source (Chapter XVII-B)
 * Version: v0.36.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT PHASE 36 IS: THE TAX YOU OWE ON SOMEBODY ELSE'S INCOME
 * ══════════════════════════════════════════════════════════════════════
 * GST (Phases 32–34) is a tax on OUR supply. TDS is not a tax on us at
 * all — it is the government making us its collection agent on payments
 * we make to other people. That single difference produces every hazard
 * in this phase, because the money that goes wrong is never ours:
 *
 *   • UNDER-DEDUCT and the deductee keeps a rupee they were never
 *     entitled to keep. We pay it — Section 201(1) makes the deductor
 *     "an assessee in default" for the WHOLE amount not deducted, plus
 *     interest under 201(1A), plus 30% of the expenditure is disallowed
 *     under Section 40(a)(ia). The vendor has been paid and has left the
 *     site. Recovering it is a commercial conversation, not a legal one.
 *
 *   • OVER-DEDUCT and the vendor is short. They cannot claim it back
 *     from us — Section 205 bars us from paying it to them once it is
 *     deposited — so their only remedy is a refund on their own return,
 *     a year later. On a subcontractor's working capital that is real.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ERROR THIS PHASE EXISTS TO PREVENT
 * ══════════════════════════════════════════════════════════════════════
 * A labour contractor is paid ₹25,000 in April, ₹25,000 in June,
 * ₹25,000 in September and ₹25,000 in December.
 *
 * Every one of those payments is below Section 194C's ₹30,000
 * single-payment threshold. Whoever entered them looked at each one, saw
 * it was under the limit, and deducted nothing. Four times.
 *
 * ⚠️ THE THRESHOLD IS NOT ON THE PAYMENT. IT IS ON THE YEAR.
 *
 * Section 194C(5) has TWO limbs and the second one is annual: once the
 * aggregate for the financial year reaches ₹1,00,000, tax is deductible
 * — and it is deductible on the WHOLE ₹1,00,000, not on the last
 * ₹25,000. The three earlier payments are brought into charge
 * retrospectively, at the December payment, and that catch-up is what
 * `catch_up_base_minor` on `tds_deductions` records.
 *
 * Testing each payment in isolation is the classic and expensive error.
 * It is also completely invisible: four correct-looking payment vouchers,
 * four correct-looking bank transfers, nothing on any screen that says
 * anything is wrong. It surfaces at a TDS assessment, by which time it
 * is our money.
 *
 * That is why `aggregate_before_minor` and `aggregate_after_minor` are
 * STORED on every deduction rather than derived at report time, why SQL
 * 0025 §5 refuses a chain whose running total does not add up, and why
 * §6 refuses a whole-aggregate section that has deducted on PART of its
 * own aggregate.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not restate Phase 33. The TDS BASE comes from
 * `purchase_invoices.tds_base_minor`, which already excludes GST per CBDT
 * Circular 23/2017; the vendor, the project and the bill all live there.
 * It does not restate the 194H brokerage rate either — `TDS_194H_BPS`,
 * `TDS_NO_PAN_BPS` and `TDS_194H_THRESHOLD_MINOR` are defined once, in
 * `lib/sales/commission.ts`, and `lib/tds/sections.ts` imports them.
 *
 * It does not compute anything. Every rule — the section catalogue, the
 * cumulative threshold, 206AA, 206AB, Section 197, the interest — lives
 * in `lib/tds/`, which has no database import.
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
import { vendors, purchaseInvoices } from "./purchases";
import { channelPartners, projects } from "./sales";

/* ------------------------------------------------------------------ */
/* ENUMS — THE SECTION                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE SECTIONS A CONSTRUCTION AND REAL-ESTATE BUSINESS ACTUALLY HITS.
 *
 * Not a transcription of Chapter XVII-B — that runs to more than sixty
 * sections and a developer touches nine of them. Each value below is one
 * a site office will meet in its first month:
 *
 *   192      — salary. ⚠️ HOOK ONLY. Salary TDS is the employee's whole
 *              projected annual liability spread over twelve months, net
 *              of their declared investments and their chosen regime. It
 *              is not a rate on a payment and this engine will not
 *              pretend it is; `rateResolvable` is false and the deduction
 *              must carry a rate somebody computed. 24Q assembly works.
 *   194A     — interest other than on securities. The loan from a
 *              director, the NBFC facility, the late-payment interest to
 *              a supplier.
 *   194C     — ⭐ THE BIG ONE. Payments to contractors and
 *              sub-contractors. This is most of what a developer pays.
 *   194H     — commission or brokerage. The channel partner. Rate and
 *              threshold come from `lib/sales/commission.ts` (Phase 22),
 *              which already deducts it on payouts.
 *   194I_a   — rent of PLANT, MACHINERY OR EQUIPMENT. 2%. The crane, the
 *              batching plant, the shuttering.
 *   194I_b   — rent of LAND, BUILDING, FURNITURE OR FITTINGS. 10%. The
 *              site office, the sales gallery, the guest house.
 *              ⚠️ THE SPLIT IS FIVE TIMES THE MONEY. One `194I` value
 *              would force the engine to guess which limb, and the guess
 *              is wrong 2% or 10% of a year's rent at a time.
 *   194IA    — ⭐ purchase of immovable property for ₹50 lakh or more.
 *              1%, deducted BY THE BUYER. A developer buying land hits
 *              this on the largest cheque it will write all year, and it
 *              is the section most often discovered afterwards, because
 *              nobody thinks of a land purchase as a "payment attracting
 *              TDS" — it feels like a conveyance, not a bill.
 *   194J_a   — fees for TECHNICAL services / call centre / film royalty.
 *              2%.
 *   194J_b   — fees for PROFESSIONAL services, royalty, non-compete.
 *              10%. The architect, the structural consultant, the
 *              lawyer, the auditor.
 *              ⚠️ SAME FIVEFOLD SPLIT AS 194I, and the boundary is
 *              genuinely argued: a structural engineer's design fee is
 *              professional; the same firm's site supervision is
 *              frequently technical. It is recorded, not inferred.
 *   194Q     — purchase of GOODS above ₹50 lakh from one seller. 0.1%.
 *              ⚠️ AND IT IS CHARGED ON THE EXCESS ONLY — see
 *              `THRESHOLD_MODE` in `lib/tds/sections.ts`. Cement and
 *              steel take a developer past ₹50 lakh with one supplier
 *              well inside a year.
 *   195      — payments to a NON-RESIDENT. ⚠️ HOOK ONLY, like 192. The
 *              rate is whichever is more beneficial of the Act and the
 *              applicable DTAA, which depends on a treaty, a tax
 *              residency certificate and Form 10F. An engine that
 *              returned a number here would be inventing one.
 */
export const tdsSectionEnum = pgEnum("tds_section", [
  "192",
  "194A",
  "194C",
  "194H",
  "194I_a",
  "194I_b",
  "194IA",
  "194J_a",
  "194J_b",
  "194Q",
  "195",
]);

/**
 * ⭐ WHAT THE PAYEE IS, BECAUSE SECTION 194C PAYS 1% OR 2% ON IT.
 *
 * 194C(2): one per cent where the payee is an individual or a Hindu
 * undivided family, two per cent otherwise. Nothing on the invoice says
 * which — a proprietorship and a private limited company both send a bill
 * on a letterhead — and getting it wrong halves or doubles the deduction
 * on every payment to that vendor for the year.
 *
 * ⚠️ IT IS ALSO THE FOURTH CHARACTER OF THEIR PAN, WHICH IS WHY THE TWO
 * ARE CROSS-CHECKED. `AAAPA1234A` is an individual; `AAACA1234A` is a
 * company. A vendor recorded as a company whose PAN says P is a vendor
 * somebody typed the wrong PAN for — and the return will be rejected by
 * the file validation utility for exactly that mismatch, in bulk, three
 * weeks after the payments went out. `lib/tds/returns.ts` checks it.
 */
export const tdsDeducteeTypeEnum = pgEnum("tds_deductee_type", [
  /** PAN 4th char `P`. 194C at 1%. */
  "individual",
  /** PAN 4th char `H`. 194C at 1%. */
  "huf",
  /** PAN 4th char `C`. */
  "company",
  /** PAN 4th char `F`. A partnership or LLP. */
  "firm",
  /** PAN 4th char `A`. */
  "association_of_persons",
  /** PAN 4th char `B`. */
  "body_of_individuals",
  /** PAN 4th char `L`. */
  "local_authority",
  /** PAN 4th char `T`. A trust. */
  "trust",
  /** PAN 4th char `J`. */
  "artificial_juridical_person",
  /** PAN 4th char `G`. */
  "government",
]);

/**
 * ⭐ THE FACT THAT COSTS 20%.
 *
 * Section 206AA: where the deductee has not furnished a PAN, tax is
 * deducted at the HIGHER of the rate in the relevant provision, the rate
 * in force, or twenty per cent.
 *
 * ⚠️ `inoperative` IS NOT A PEDANTIC EXTRA VALUE. A PAN not linked to
 * Aadhaar became inoperative under Rule 114AAA, and CBDT Circular 3/2023
 * treats a deduction against an inoperative PAN as a deduction against no
 * PAN at all — 20%, with the shortfall recoverable from the deductor. The
 * PAN is on file, it looks right, it passes the structure check, and it
 * is worth nothing. Modelling it as `valid` is how a workspace discovers
 * a year of 1% deductions should have been 20%.
 *
 * ⚠️ `applied_for` IS ALSO NOT `valid`. "PANAPPLIED" is a legitimate
 * value in a quarterly return and it still attracts 206AA — the relief is
 * that the return will be accepted, not that the rate is normal.
 */
export const tdsPanStatusEnum = pgEnum("tds_pan_status", [
  "valid",
  /** Never given to us. 206AA at 20%. */
  "not_furnished",
  /** Given, but fails structure or the TRACES/portal check. 206AA. */
  "invalid",
  /** ⭐ Structurally fine, not Aadhaar-linked. Rule 114AAA. 206AA. */
  "inoperative",
  /** Form 49A filed, number not yet issued. 206AA. */
  "applied_for",
]);

/**
 * WHICH RULE PRODUCED THE RATE ON A DEDUCTION.
 *
 * ⚠️ STORED, NOT DERIVED, AND THAT IS THE POINT. Two years later the
 * question at an assessment is never "what rate did you use" — the
 * challan answers that — it is "why". A 20% deduction with no recorded
 * reason looks like an error; a 20% deduction stamped
 * `section_206aa_no_pan` is a defence. Equally, a 0.5% deduction stamped
 * `section_197_certificate` names the certificate that authorised it, and
 * one that cannot is an under-deduction whoever signed it.
 */
export const tdsRateBasisEnum = pgEnum("tds_rate_basis", [
  /** The ordinary rate for the section and the deductee class. */
  "normal",
  /** ⭐ 206AA — no usable PAN. The higher of the normal rate and 20%. */
  "section_206aa_no_pan",
  /** ⭐ 206AB — a specified person. Twice the normal rate, or 5%. */
  "section_206ab_non_filer",
  /** ⭐ BOTH bite. 206AB(2): whichever of the two is higher. */
  "section_206aa_and_206ab",
  /** ⭐ 197 — a lower- or nil-deduction certificate, within its window. */
  "section_197_certificate",
  /**
   * ⚠️ 192 and 195. The rate came from a person, not from this engine,
   * and the row says so rather than implying an authority it does not
   * have.
   */
  "manually_determined",
]);

/**
 * WHAT HAPPENED ON THIS ROW.
 *
 * ⚠️ `below_threshold` ROWS ARE NOT NOISE — THEY ARE THE WHOLE MECHANISM.
 *
 * A register that only records DEDUCTIONS cannot answer "what is the
 * running total for this vendor this year", and without that number the
 * annual threshold can never be applied. Each of the first three ₹25,000
 * payments to the labour contractor writes a row with `tds_minor = 0` and
 * this outcome, and it is those three rows that make the fourth payment
 * know it has crossed ₹1,00,000.
 *
 * Recording only the deductions is how the cumulative rule gets lost.
 */
export const tdsDeductionOutcomeEnum = pgEnum("tds_deduction_outcome", [
  /** Tax was deducted. */
  "deducted",
  /** ⭐ Assessable, counted toward the year, nothing deducted yet. */
  "below_threshold",
  /** A Section 197 certificate at NIL. Recorded, reported, zero. */
  "nil_certificate",
  /**
   * The payee is outside this section entirely — a government body, a
   * payment covered by a specific exemption. Recorded so the decision is
   * visible rather than absent.
   */
  "exempt",
]);

/* ------------------------------------------------------------------ */
/* ENUMS — DEPOSIT, RETURN, CERTIFICATE                                */
/* ------------------------------------------------------------------ */

/** The Indian financial year has four TDS quarters, and they are its own. */
export const tdsQuarterEnum = pgEnum("tds_quarter", ["Q1", "Q2", "Q3", "Q4"]);

/**
 * ⚠️ `pending` IS A REAL STATE AND IT IS THE EXPENSIVE ONE. Tax deducted
 * and not yet deposited is money we are holding that is not ours, accruing
 * interest at 1.5% per month from the DATE OF DEDUCTION — not from the due
 * date. See `lib/tds/interest.ts`.
 */
export const tdsChallanStatusEnum = pgEnum("tds_challan_status", [
  "pending",
  "deposited",
  /** Matched against the OLTAS/TRACES challan status enquiry. */
  "verified",
  /** Rejected by the bank or reversed. Stays, stops counting. */
  "failed",
]);

/**
 * ⚠️ `27D` IS A TCS CERTIFICATE, NOT A TDS ONE, AND IT IS HERE ON
 * PURPOSE. Section 206C(1H) — tax COLLECTED at source on a sale of goods
 * above ₹50 lakh — is the exact mirror of 194Q, and the two are decided
 * TOGETHER because they overlap: where the buyer is liable to deduct
 * under 194Q, the seller must not collect under 206C(1H). A developer
 * selling scrap steel or bulk material meets both sides of that rule in
 * the same ledger, and splitting the certificate types across two phases
 * would put the two halves of one decision in two places.
 */
export const tdsCertificateFormEnum = pgEnum("tds_certificate_form", [
  /** Salary. Annual, Part A from TRACES and Part B from us. */
  "16",
  /** ⭐ Non-salary TDS. Quarterly. The one a vendor chases us for. */
  "16A",
  /** Section 194IA. Issued off the Form 26QB challan-cum-statement. */
  "16B",
  /** TCS under 206C. Quarterly. */
  "27D",
]);

export const tdsCertificateStatusEnum = pgEnum("tds_certificate_status", [
  "draft",
  /** Requested from TRACES; the number is theirs, not ours. */
  "requested",
  "issued",
  /** Superseded by a revised return. The old one stays. */
  "revised",
]);

/**
 * ⚠️ THE FORM IS DECIDED BY THE PAYEE, NOT BY THE PAYMENT.
 *
 *   24Q  — salary (192).
 *   26Q  — every other payment to a RESIDENT.
 *   27Q  — every payment to a NON-RESIDENT, whatever the section.
 *   27EQ — tax COLLECTED at source (206C).
 *
 * A 194C payment to a non-resident contractor does not belong in 26Q, and
 * a return filed on the wrong form is rejected wholesale rather than
 * line by line — which means one misclassified deductee holds up the
 * certificates for every other deductee in the quarter.
 */
export const tdsReturnFormEnum = pgEnum("tds_return_form", [
  "24Q",
  "26Q",
  "27Q",
  "27EQ",
]);

/**
 * ⚠️ `validated` SITS BETWEEN `draft` AND `filed` BECAUSE THE VALIDATION
 * PASS IS THE POINT. A quarterly return is not accepted or rejected line
 * by line: the file validation utility refuses the WHOLE file on the
 * first structural defect, and the fee under Section 234E — ₹200 a day —
 * runs from the original due date while somebody finds it.
 */
export const tdsReturnStatusEnum = pgEnum("tds_return_status", [
  "draft",
  "validated",
  "filed",
  /** A correction statement against an already-accepted return. */
  "revised",
]);

/* ------------------------------------------------------------------ */
/* DEDUCTEES                                                           */
/* ------------------------------------------------------------------ */

/**
 * The person tax is deducted FROM.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS IS NOT `vendors`, AND WHY THAT IS NOT A DUPLICATION
 * ══════════════════════════════════════════════════════════════════════
 * The statutory unit of account for TDS is the PAN, and it does not line
 * up with a vendor row in either direction:
 *
 *   • ONE PERSON, SEVERAL RELATIONSHIPS. The same firm supplies material
 *     (a vendor), brokers a flat (a channel partner in Phase 22) and
 *     rents us a crane. Three rows in three tables, ONE PAN. Section
 *     194C's ₹1,00,000 annual threshold is on the PAN, so tracking it per
 *     vendor row under-deducts by construction — and it under-deducts
 *     invisibly, because each individual ledger looks correct.
 *
 *   • ONE PAYEE, NO VENDOR ROW AT ALL. The landowner we bought the site
 *     from is a 194IA deductee and will never be a vendor. So is an
 *     employee, under 192.
 *
 * So the deductee is its own record, keyed on PAN, pointing OPTIONALLY at
 * a vendor and at a channel partner. The pointers are for navigation. The
 * PAN is the identity.
 */
export const tdsDeductees = pgTable(
  "tds_deductees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Human-facing identifier: "D-0042". Unique per workspace. */
    code: varchar("code", { length: 40 }).notNull(),

    legalName: varchar("legal_name", { length: 255 }).notNull(),

    /**
     * ⭐ THE IDENTITY. Nullable, and the nullability is the hazard, not an
     * oversight: a labour contractor who has not given us a PAN is a
     * lawful deductee at 20% under Section 206AA, and refusing to record
     * them would push somebody into inventing a number.
     */
    panNumber: varchar("pan_number", { length: 10 }),
    panStatus: tdsPanStatusEnum("pan_status").default("not_furnished").notNull(),
    /** When the PAN was last checked against the portal. Rule 114AAA drifts. */
    panVerifiedOn: date("pan_verified_on", { mode: "string" }),

    /** ⭐ Decides 194C at 1% or 2%. Cross-checked against the PAN's 4th char. */
    deducteeType: tdsDeducteeTypeEnum("deductee_type").default("company").notNull(),

    /**
     * ⚠️ A NON-RESIDENT IS A DIFFERENT RETURN AND A DIFFERENT SECTION.
     * Every payment to them is Section 195 and belongs in 27Q, whatever
     * the nature of the payment. Recorded here because it is a fact about
     * the PERSON and would otherwise have to be re-decided per payment.
     */
    isNonResident: boolean("is_non_resident").default(false).notNull(),

    /* --- ⭐ SECTION 206AB ------------------------------------------ */

    /**
     * ⭐ A "SPECIFIED PERSON" UNDER SECTION 206AB — DOUBLE RATE, OR 5%.
     *
     * A deductee who has not furnished their income-tax return for the
     * relevant previous year, and from whom tax of ₹50,000 or more was
     * deducted and collected in that year. Tax on them is deducted at the
     * higher of twice the specified rate and five per cent.
     *
     * ⚠️ THIS IS NOT A JUDGEMENT WE MAY MAKE FROM OUR OWN RECORDS. It is
     * answered by the Income-tax Department's Compliance Check utility
     * against the PAN, and a wrong "no" is our liability. So the flag is
     * accompanied by the DATE it was checked — a stale check on a large
     * vendor is the exposure, and a flag with no date is a flag nobody
     * can defend.
     *
     * ⚠️ SECTION 206AB WAS OMITTED BY THE FINANCE (No. 2) ACT, 2024, WITH
     * EFFECT FROM 1 OCTOBER 2024. It is implemented here in full anyway,
     * and that is deliberate: deductions for periods before that date are
     * still being assessed, corrected and re-filed years afterwards, and a
     * correction statement for FY 2023-24 has to reproduce the rate that
     * was correct THEN. An engine that only knows today's law cannot
     * restate yesterday's return.
     */
    isSpecifiedPerson206ab: boolean("is_specified_person_206ab")
      .default(false)
      .notNull(),
    specifiedPersonCheckedOn: date("specified_person_checked_on", { mode: "string" }),
    /** The Compliance Check utility's response id. Evidence, not decoration. */
    specifiedPersonReference: varchar("specified_person_reference", { length: 64 }),

    /* --- Navigation. Composite FKs in SQL §4. ---------------------- */

    /** Optional link to the Phase 33 vendor. */
    vendorId: uuid("vendor_id"),
    /** Optional link to the Phase 22 channel partner (194H). */
    channelPartnerId: uuid("channel_partner_id"),

    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 32 }),
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

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codePerTenant: uniqueIndex("tds_deductees_code_tenant_unique").on(t.tenantId, t.code),
    /**
     * ⭐ ONE ROW PER PAN PER WORKSPACE, AND THIS IS THE INDEX THAT MAKES
     * THE ANNUAL THRESHOLD MEAN ANYTHING.
     *
     * Two deductee rows for one PAN — one created by the site office for
     * the labour contract, one by accounts for the crane hire — split the
     * running total in two, and each half sits comfortably under
     * ₹1,00,000 while the person is over it. Nothing looks wrong on
     * either row.
     *
     * ⚠️ PARTIAL, because a NULL PAN is a legitimate state and several
     * PAN-less deductees must be allowed to coexist. Their exposure is
     * 20% under 206AA, which is a rate problem, not a duplication one.
     */
    panPerTenant: uniqueIndex("tds_deductees_pan_tenant_unique")
      .on(t.tenantId, t.panNumber)
      .where(sql`${t.panNumber} IS NOT NULL`),
    tenantIdx: index("tds_deductees_tenant_idx").on(t.tenantId, t.isActive),
    vendorIdx: index("tds_deductees_vendor_idx").on(t.tenantId, t.vendorId),
    partnerIdx: index("tds_deductees_partner_idx").on(t.tenantId, t.channelPartnerId),
    /** The 206AB review list: who is a specified person and how stale. */
    specifiedIdx: index("tds_deductees_specified_idx")
      .on(t.tenantId, t.specifiedPersonCheckedOn)
      .where(sql`${t.isSpecifiedPerson206ab}`),

    panShape: check(
      "tds_deductees_pan_shape",
      sql`${t.panNumber} IS NULL OR ${t.panNumber} ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`,
    ),
    /**
     * ⚠️ A PAN STATUS OF `valid` WITH NO PAN IS THE 20% BUG, WRITTEN DOWN.
     *
     * It is the single most consequential inconsistency available on this
     * table: the rate engine asks `panStatus === "valid"` and would answer
     * "normal rate" for a deductee who has furnished nothing. Every
     * payment to them for the year is then short by the difference between
     * 1% and 20%, and Section 201(1) makes us pay it.
     */
    panStatusConsistent: check(
      "tds_deductees_pan_status_consistent",
      sql`${t.panStatus} <> 'valid' OR ${t.panNumber} IS NOT NULL`,
    ),
    /**
     * ⭐ A 206AB FLAG WITHOUT A CHECK DATE IS AN ASSERTION NOBODY CAN
     * DEFEND. The determination is the Department's, made through the
     * Compliance Check utility against a PAN on a date. Ours is a copy of
     * it, and a copy with no date is indistinguishable from a guess.
     */
    specifiedPersonEvidenced: check(
      "tds_deductees_specified_person_evidenced",
      sql`(NOT ${t.isSpecifiedPerson206ab})
          OR ${t.specifiedPersonCheckedOn} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ SECTION 197 — LOWER-DEDUCTION CERTIFICATES                        */
/* ------------------------------------------------------------------ */

/**
 * A certificate from the Assessing Officer authorising deduction at a
 * lower rate, or at nil.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THREE FACTS, AND EVERY ONE OF THEM LIMITS THE CERTIFICATE
 * ══════════════════════════════════════════════════════════════════════
 *   1. A RATE — often 0.5% where 194C would be 2%, or nil.
 *   2. A WINDOW — issued for part of a financial year, commonly from the
 *      date of application, and it EXPIRES on 31 March at the latest.
 *   3. ⭐ A CAP — an amount of payment up to which the lower rate applies.
 *      Beyond the cap the normal rate returns.
 *
 * All three are on the certificate and all three are routinely ignored.
 * The one that costs money is the window: a subcontractor sends the
 * certificate in June, accounts files it, and it is still being applied
 * the following August to a certificate that expired on 31 March. Every
 * payment in between is short by the difference, and Section 201(1) makes
 * that shortfall ours — with interest, and with 30% of the expenditure
 * disallowed under 40(a)(ia).
 *
 * ⚠️ WHICH IS WHY THE WINDOW IS ENFORCED BY A TRIGGER (SQL 0025 §5) AND
 * NOT ONLY BY THE ENGINE. The engine is one of several write paths; the
 * import of a year of historical payments is another, and an import is
 * exactly where a certificate gets applied to twelve months because it
 * was applied to the first one.
 *
 * ⚠️ AND A CERTIFICATE IMPLIES A PAN. Section 206AA(4) forbids the
 * Assessing Officer from granting one where no PAN is quoted, so a
 * certificate against a PAN-less deductee is a document that cannot
 * exist — checked in `lib/tds/rates.ts` and refused there.
 */
export const tdsLowerDeductionCertificates = pgTable(
  "tds_lower_deduction_certificates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tds_deductees (id, tenant_id). RESTRICT. */
    deducteeId: uuid("deductee_id").notNull(),

    /** As issued by TRACES. Ten characters, and it goes on the return. */
    certificateNumber: varchar("certificate_number", { length: 24 }).notNull(),
    /** ⚠️ ONE SECTION PER CERTIFICATE. A 194C certificate is not a 194J one. */
    section: tdsSectionEnum("section").notNull(),

    /** ⭐ The authorised rate, in basis points. 50 = 0.5%. Nil is 0. */
    rateBps: integer("rate_bps").notNull(),

    /** ⚠️ INCLUSIVE, BOTH ENDS. The certificate names two calendar days. */
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }).notNull(),

    /**
     * ⭐ The amount of payment the certificate covers, in paise. NULL
     * means uncapped, which does happen but is rarer than people assume —
     * most certificates name a figure, and paying beyond it at the
     * certificate rate is an under-deduction of exactly the difference.
     */
    capBaseMinor: bigint("cap_base_minor", { mode: "bigint" }),

    /** The financial year the certificate belongs to. "2024-25". */
    financialYear: varchar("financial_year", { length: 7 }).notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    numberPerTenant: uniqueIndex("tds_ldc_number_tenant_unique").on(
      t.tenantId,
      t.certificateNumber,
      t.section,
    ),
    deducteeIdx: index("tds_ldc_deductee_idx").on(
      t.tenantId,
      t.deducteeId,
      t.section,
      t.validFrom,
    ),

    rateSane: check(
      "tds_ldc_rate_sane",
      sql`${t.rateBps} >= 0 AND ${t.rateBps} <= 10000`,
    ),
    windowSane: check("tds_ldc_window_sane", sql`${t.validTo} >= ${t.validFrom}`),
    capSane: check(
      "tds_ldc_cap_sane",
      sql`${t.capBaseMinor} IS NULL OR ${t.capBaseMinor} > 0`,
    ),
    fyShape: check(
      "tds_ldc_fy_shape",
      sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CHALLANS — THE DEPOSIT                                              */
/* ------------------------------------------------------------------ */

/**
 * Proof that the tax we deducted actually reached the government.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE BSR CODE AND THE SERIAL ARE NOT OPTIONAL METADATA
 * ══════════════════════════════════════════════════════════════════════
 * The triple (BSR code, date of deposit, challan serial number) IS the
 * challan's identity in the government's own system. It is what the
 * quarterly return quotes, what OLTAS matches on, and what puts the
 * credit into the deductee's Form 26AS. Get one digit wrong and:
 *
 *   • the return is accepted,
 *   • the challan does not match,
 *   • the deductee's 26AS shows nothing,
 *   • and they ring up asking why their money has disappeared —
 *     which it has, into an unmatched challan that no one is looking at.
 *
 * ⚠️ BSR IS SEVEN DIGITS AND THE SERIAL IS FIVE. Both are commonly typed
 * with leading zeros stripped by a spreadsheet, which is why they are
 * `varchar` with a shape CHECK and not integers. `0001234` is not `1234`.
 *
 * ⚠️ THE AMOUNT IS SPLIT BY HEAD BECAUSE THE CHALLAN IS. Tax, surcharge,
 * cess, INTEREST and FEE are five separate boxes on ITNS 281, and the
 * return reports them separately. A single total cannot be split back
 * out, and interest deposited in the tax box does not discharge the tax.
 */
export const tdsChallans = pgTable(
  "tds_challans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /**
     * ⚠️ THE TAN, NOT THE PAN AND NOT THE GSTIN. Tax Deduction Account
     * Number: four letters, five digits, one letter. It is the identity a
     * TDS return is filed under, and a workspace with two TANs files two
     * returns that never mix — exactly like two GSTINs in Phase 33.
     */
    tan: varchar("tan", { length: 10 }).notNull(),

    /** Seven digits. The bank branch that took the money. */
    bsrCode: varchar("bsr_code", { length: 7 }).notNull(),
    /** Five digits, allotted by the bank on the day. */
    challanSerial: varchar("challan_serial", { length: 5 }).notNull(),
    /** ⚠️ The date the BANK took it, not the date we initiated it. */
    depositDate: date("deposit_date", { mode: "string" }).notNull(),

    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    /** The assessment year printed on the challan. FY + 1. */
    assessmentYear: varchar("assessment_year", { length: 7 }).notNull(),
    quarter: tdsQuarterEnum("quarter").notNull(),

    /**
     * ⚠️ NULLABLE, AND NOT BECAUSE IT DOES NOT MATTER. ITNS 281 carries a
     * "nature of payment" code, and one challan properly covers one
     * section — but a great many workspaces deposit a month's whole
     * liability on one challan, and the return then apportions it across
     * sections. Refusing that shape would push people into recording a
     * challan that does not match the one the bank issued.
     */
    section: tdsSectionEnum("section"),

    /** The five boxes on the challan. Paise. */
    taxMinor: bigint("tax_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    surchargeMinor: bigint("surcharge_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** ⭐ Section 201(1A). Deposited with the tax, reported separately. */
    interestMinor: bigint("interest_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** ⭐ Section 234E late-filing fee. ₹200 a day. */
    feeMinor: bigint("fee_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /** The sum of the five. Held by a CHECK, not by hope. */
    totalMinor: bigint("total_minor", { mode: "bigint" }).default(sql`0`).notNull(),

    status: tdsChallanStatusEnum("status").default("deposited").notNull(),

    /** The bank's own reference. Useful when OLTAS disagrees. */
    bankReference: varchar("bank_reference", { length: 64 }),
    /** When the challan was confirmed against the OLTAS status enquiry. */
    verifiedOn: date("verified_on", { mode: "string" }),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⭐ THE GOVERNMENT'S OWN KEY, AND THEREFORE OURS.
     *
     * (BSR, deposit date, serial) is unique in OLTAS. Recording the same
     * challan twice would let a month's deductions be mapped across two
     * copies of one payment, so the register would reconcile to the
     * challans perfectly while only half the money had actually moved.
     */
    oltasKey: uniqueIndex("tds_challans_oltas_key").on(
      t.tenantId,
      t.bsrCode,
      t.depositDate,
      t.challanSerial,
    ),
    periodIdx: index("tds_challans_period_idx").on(
      t.tenantId,
      t.financialYear,
      t.quarter,
    ),
    tanIdx: index("tds_challans_tan_idx").on(t.tenantId, t.tan, t.depositDate),

    tanShape: check(
      "tds_challans_tan_shape",
      sql`${t.tan} ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'`,
    ),
    /** ⚠️ Seven digits INCLUDING leading zeros. `1234` is not a BSR code. */
    bsrShape: check("tds_challans_bsr_shape", sql`${t.bsrCode} ~ '^[0-9]{7}$'`),
    serialShape: check(
      "tds_challans_serial_shape",
      sql`${t.challanSerial} ~ '^[0-9]{5}$'`,
    ),
    nonNegative: check(
      "tds_challans_non_negative",
      sql`${t.taxMinor} >= 0 AND ${t.surchargeMinor} >= 0 AND ${t.cessMinor} >= 0
          AND ${t.interestMinor} >= 0 AND ${t.feeMinor} >= 0`,
    ),
    /**
     * ⚠️ THE FIVE BOXES MUST ADD UP TO THE TOTAL. A challan whose total is
     * not its parts cannot be reported: the return quotes each box, and
     * the sum of the boxes is what OLTAS matched. A stored total that
     * disagrees is a reconciliation that passes against a number the
     * government never saw.
     */
    totalBalances: check(
      "tds_challans_total_balances",
      sql`${t.totalMinor} = ${t.taxMinor} + ${t.surchargeMinor} + ${t.cessMinor}
          + ${t.interestMinor} + ${t.feeMinor}`,
    ),
    fyShape: check(
      "tds_challans_fy_shape",
      sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'
          AND ${t.assessmentYear} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* QUARTERLY RETURNS                                                   */
/* ------------------------------------------------------------------ */

/**
 * The statement filed with the Department each quarter.
 *
 * ⚠️ THE RETURN IS NOT A REPORT. It is the document that puts the credit
 * into the deductee's Form 26AS. Until it is filed and accepted, the
 * vendor's money is with the government under our TAN and against nobody
 * — deducted, deposited, and invisible to the person it was taken from.
 * That is the call the accounts department gets.
 *
 * ⭐ `validation_report` IS THE COLUMN THAT EARNS ITS KEEP. The file
 * validation utility refuses the WHOLE file on the first structural
 * defect and names it by record number, not by vendor. Storing the
 * findings from our own pass — in `lib/tds/returns.ts` — is what turns
 * "record 47 field 12" into "Sahyadri Cement has no PAN".
 */
export const tdsReturns = pgTable(
  "tds_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    tan: varchar("tan", { length: 10 }).notNull(),
    formType: tdsReturnFormEnum("form_type").notNull(),
    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    quarter: tdsQuarterEnum("quarter").notNull(),

    status: tdsReturnStatusEnum("status").default("draft").notNull(),

    /** Roll-ups, proved against the deductions by the deferred trigger. */
    deducteeCount: integer("deductee_count").default(0).notNull(),
    deductionCount: integer("deduction_count").default(0).notNull(),
    totalBaseMinor: bigint("total_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalTdsMinor: bigint("total_tds_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalDepositedMinor: bigint("total_deposited_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalInterestMinor: bigint("total_interest_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** ⭐ Section 234E. ₹200 per day, capped at the tax deducted. */
    lateFilingFeeMinor: bigint("late_filing_fee_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** The statutory due date for this form and quarter. Stored, not guessed. */
    dueDate: date("due_date", { mode: "string" }),
    filedOn: date("filed_on", { mode: "string" }),
    /** The 15-character provisional receipt / token number from the TIN-FC. */
    acknowledgementNumber: varchar("acknowledgement_number", { length: 20 }),

    /**
     * What our own validation pass found. `TdsReturnFinding[]` from
     * `lib/tds/returns.ts` — each with a severity, a field and a sentence.
     */
    validationReport: jsonb("validation_report")
      .$type<
        Array<{
          severity: "reject" | "warn";
          code: string;
          deducteeId?: string;
          deductionId?: string;
          field?: string;
          message: string;
        }>
      >()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ ONE ORIGINAL RETURN PER TAN, FORM, YEAR AND QUARTER. A second
     * one is a CORRECTION statement, which is a different document with a
     * different acknowledgement, and filing two originals produces two
     * sets of credit in the deductees' 26AS — which the Department
     * resolves by rejecting one of them, chosen by nothing we control.
     */
    periodKey: uniqueIndex("tds_returns_period_key")
      .on(t.tenantId, t.tan, t.formType, t.financialYear, t.quarter)
      .where(sql`${t.status} <> 'revised'`),
    statusIdx: index("tds_returns_status_idx").on(
      t.tenantId,
      t.status,
      t.financialYear,
    ),

    tanShape: check(
      "tds_returns_tan_shape",
      sql`${t.tan} ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'`,
    ),
    fyShape: check("tds_returns_fy_shape", sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
    nonNegative: check(
      "tds_returns_non_negative",
      sql`${t.totalBaseMinor} >= 0 AND ${t.totalTdsMinor} >= 0
          AND ${t.totalDepositedMinor} >= 0 AND ${t.totalInterestMinor} >= 0
          AND ${t.lateFilingFeeMinor} >= 0
          AND ${t.deducteeCount} >= 0 AND ${t.deductionCount} >= 0`,
    ),
    /**
     * ⚠️ A FILED RETURN HAS AN ACKNOWLEDGEMENT. Without it there is no
     * evidence the file was accepted, and "we filed it" is a claim rather
     * than a fact — which matters, because the 234E fee runs until the
     * Department says it has the statement.
     */
    filedIsEvidenced: check(
      "tds_returns_filed_is_evidenced",
      sql`${t.status} <> 'filed'
          OR (${t.filedOn} IS NOT NULL AND ${t.acknowledgementNumber} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ THE DEDUCTION REGISTER                                            */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE CENTRE OF THE PHASE. One row per assessable payment.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ A ROW IS WRITTEN EVEN WHEN NOTHING IS DEDUCTED, AND THAT IS THE
 * DESIGN — NOT AN OVERSIGHT AND NOT NOISE
 * ══════════════════════════════════════════════════════════════════════
 * Section 194C's annual limb needs a running total per deductee per
 * section per financial year. A register containing only DEDUCTIONS
 * cannot produce that total: the first three ₹25,000 payments to the
 * labour contractor deducted nothing, so they would not be in it, so the
 * fourth payment would see an aggregate of ₹25,000 and conclude —
 * correctly, from the data it had — that the threshold was miles away.
 *
 * So a below-threshold payment writes a row with `outcome =
 * 'below_threshold'` and `tds_minor = 0`. The row exists to be counted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FOUR MONEY COLUMNS, AND WHY THERE ARE FOUR
 * ══════════════════════════════════════════════════════════════════════
 *   `payment_base_minor`     — what THIS payment is, net of GST.
 *   `catch_up_base_minor`    — ⭐ earlier payments in the same year that
 *                              become chargeable NOW because the annual
 *                              threshold has just been crossed. ₹75,000
 *                              on the labour contractor's fourth payment.
 *   `chargeable_base_minor`  — the two added. What the rate is applied to.
 *   `aggregate_before_minor` — the running total for this deductee, this
 *                              section, this financial year, BEFORE this
 *                              payment.
 *
 * One `amount` column would collapse all four, and the collapse is
 * exactly where the money is lost: the fourth payment's TDS is ₹1,000 on
 * a base of ₹1,00,000, and a register showing "₹1,000 on ₹25,000" is a 4%
 * deduction under a 1% section that nobody can explain and every reviewer
 * will query.
 *
 * ⚠️ AND THE AGGREGATE IS STORED, NOT DERIVED AT REPORT TIME. Derived, it
 * changes when somebody enters a backdated April invoice in December —
 * silently restating every deduction after it, including ones already
 * deposited, reported and certified. Stored, it is what the deduction was
 * actually MADE on, and SQL 0025 §5 refuses a chain that stops adding up.
 */
export const tdsDeductions = pgTable(
  "tds_deductions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tds_deductees (id, tenant_id). RESTRICT. */
    deducteeId: uuid("deductee_id").notNull(),

    section: tdsSectionEnum("section").notNull(),
    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    quarter: tdsQuarterEnum("quarter").notNull(),

    /**
     * ⭐ THE DATE OF CREDIT OR OF PAYMENT, WHICHEVER IS EARLIER.
     *
     * ⚠️ NOT THE PAYMENT DATE, AND THIS IS THE COMMONEST TIMING ERROR IN
     * THE WHOLE OF CHAPTER XVII-B. Section 194C(1) says "at the time of
     * credit of such sum to the account of the contractor OR at the time
     * of payment, whichever is earlier". A March bill booked in March and
     * paid in June was deductible in MARCH — it belongs to Q4, the
     * deposit was due on 30 April, and treating it as a June payment
     * under-reports the quarter and starts interest running without
     * anybody noticing.
     *
     * ⚠️ IT IS ALSO WHAT `quarter` AND THE 1.5%-PER-MONTH INTEREST CLOCK
     * ARE MEASURED FROM. See `lib/tds/interest.ts`: Section 201(1A)(ii)
     * runs from the date of DEDUCTION, not from the due date.
     */
    deductionDate: date("deduction_date", { mode: "string" }).notNull(),
    /** When the net actually left the bank. For the audit trail only. */
    paymentDate: date("payment_date", { mode: "string" }),
    /**
     * ⭐⭐ THE OTHER HALF OF "WHICHEVER IS EARLIER" — SQL 0106.
     *
     * 🔴 BEFORE THIS COLUMN, `deduction_date` WAS AN ASSERTION AND NOT A
     * DERIVATION. Its comment above says it is the earlier of credit and
     * payment; the schema held only ONE of the two dates, so nothing could
     * check the claim and a caller that passed the payment date got a row
     * that looked identical to a correct one. That is tolerable while a
     * wrong deduction date only mis-files a quarter. It stops being
     * tolerable under Rule 26, where the deduction date IS the rate date:
     * a March credit paid in June, dated June, is translated at June's
     * dollar and the chargeable base itself is wrong.
     *
     * ⚠️ THE DATE THE SUM IS CREDITED TO THE PAYEE'S ACCOUNT IN OUR BOOKS
     * — the day the expense and the creditor are recognised, not the
     * invoice date. An invoice dated 28 March and booked on 4 April was
     * credited on 4 April. `lib/tds/foreign-payments.ts#deductionDateFor`
     * is the only thing that turns the pair into a deduction date, and the
     * CHECK below refuses a row whose date disagrees with its own inputs.
     *
     * ⚠️ NULL ON EVERY PRE-0106 ROW and null is honest: nobody was ever
     * asked. The CHECK binds only where it is known.
     */
    creditDate: date("credit_date", { mode: "string" }),

    /* --- ⭐⭐ RULE 26 · THE FOREIGN-CURRENCY MEASUREMENT ------------ */

    /**
     * ⭐ THE CURRENCY THE PAYMENT WAS MADE IN. NULL means the payment was
     * in rupees and no translation happened — which is every row written
     * before 0106 and every domestic payment after it.
     *
     * 🔴 THE COLUMNS BELOW ARE THE WORKING FOR `chargeable_base_minor`
     * WHEN THIS IS SET. Before 0106 the rupee base of a s.195 payment was
     * whatever figure somebody typed, translated at a rate nobody
     * recorded, and "which rate did this deduction use" had no answer —
     * which is precisely the question a s.201 proceeding opens with.
     */
    paymentCurrency: varchar("payment_currency", { length: 3 }),
    /**
     * The amount as it was actually paid, in that currency's OWN minor
     * units. ⚠️ NOT ALWAYS HUNDREDTHS — JPY has none and KWD has three.
     * `lib/fx/currency.ts` carries the exponent; nothing here assumes one.
     */
    foreignPaymentBaseMinor: bigint("foreign_payment_base_minor", { mode: "bigint" }),
    /** The rate applied, at the same twelve decimals `fx_rates` stores. */
    fxRate: numeric("fx_rate", { precision: 30, scale: 12 }),
    /**
     * 🔴 THE DATE THE RATE IS FOR, AND THE CHECK BELOW FORCES IT TO EQUAL
     * `deduction_date`. That equality IS Rule 26 — "as on the date on
     * which the tax is required to be deducted" — expressed where it
     * cannot be forgotten.
     */
    fxRateDate: date("fx_rate_date", { mode: "string" }),
    /** ⭐ 'tt_buying', and the CHECK below permits nothing else. */
    fxRateType: varchar("fx_rate_type", { length: 12 }),
    /** 'rbi_reference' | 'provider' | 'manual' — WHO published it. */
    fxRateSource: varchar("fx_rate_source", { length: 20 }),
    /**
     * The `fx_rates` or `fx_reference_rates` row it came from.
     * ⚠️ NO FOREIGN KEY: the two rate tables are different scopes (one
     * tenant, one platform) so no single FK can name both, and a rate row
     * deleted years later must not delete or null a filed deduction's
     * evidence. The rate itself is copied onto this row for that reason.
     */
    fxRateId: uuid("fx_rate_id"),
    /** "Rule 26, Income-tax Rules 1962". The rule, so the figure can be defended. */
    fxStatutoryRef: varchar("fx_statutory_ref", { length: 60 }),

    /* --- ⭐ THE CUMULATIVE ARITHMETIC ------------------------------ */

    /**
     * This payment, EXCLUDING GST.
     *
     * ⚠️ CBDT CIRCULAR 23/2017. Where the GST is shown separately on the
     * invoice, income-tax TDS is deducted on the value alone. Phase 33
     * already stores this as `purchase_invoices.tds_base_minor`, computed
     * once at bill entry, and this column is copied from it rather than
     * re-derived — because re-deriving it is where somebody deducts on
     * the gross and over-deducts by the GST rate.
     */
    paymentBaseMinor: bigint("payment_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** ⭐ Earlier payments brought into charge by crossing the threshold. */
    catchUpBaseMinor: bigint("catch_up_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** What the rate is applied to. = payment + catch-up. */
    chargeableBaseMinor: bigint("chargeable_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** ⭐ The running FY total for this deductee and section, before this row. */
    aggregateBeforeMinor: bigint("aggregate_before_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** = before + payment. The evidence that the threshold test was right. */
    aggregateAfterMinor: bigint("aggregate_after_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /* --- The rate, and why it is that rate ------------------------ */

    rateBps: integer("rate_bps").default(0).notNull(),
    rateBasis: tdsRateBasisEnum("rate_basis").default("normal").notNull(),
    /** Composite FK → tds_lower_deduction_certificates. */
    lowerDeductionCertificateId: uuid("lower_deduction_certificate_id"),
    /** "194C(1)", "206AA(1)", "197". Named, so a rate can be defended. */
    statutoryRef: varchar("statutory_ref", { length: 32 }),
    /**
     * ⭐ THE SENTENCE. Written by `lib/tds/rates.ts`, stored on the row.
     *
     * "Two per cent under Section 194C, doubled to four per cent because
     * the deductee is a specified person under Section 206AB." Nobody
     * reconstructs that from a rate and a flag two years later, and the
     * reconstruction is what an assessment asks for.
     */
    explanation: text("explanation"),

    /* --- The money deducted --------------------------------------- */

    tdsMinor: bigint("tds_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    /**
     * ⚠️ SURCHARGE AND CESS ARE ZERO FOR A RESIDENT AND ARE NOT ZERO FOR
     * EVERYONE. Under Section 195 a non-resident's deduction carries
     * surcharge and health-and-education cess on top of the base rate, and
     * a single `tds_minor` would force them into it — after which the
     * challan's five boxes cannot be filled from our own register.
     */
    surchargeMinor: bigint("surcharge_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    cessMinor: bigint("cess_minor", { mode: "bigint" }).default(sql`0`).notNull(),
    totalDeductedMinor: bigint("total_deducted_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    outcome: tdsDeductionOutcomeEnum("outcome").notNull(),

    /* --- Where it came from. Composite FKs, SQL §4. --------------- */

    purchaseInvoiceId: uuid("purchase_invoice_id"),
    vendorId: uuid("vendor_id"),
    projectId: uuid("project_id"),
    channelPartnerId: uuid("channel_partner_id"),
    /** A voucher number, a UTR, a payment run id. Free reference. */
    referenceNumber: varchar("reference_number", { length: 80 }),
    description: text("description"),

    /* --- Where it went. Composite FKs, SQL §4. -------------------- */

    /** ⭐ The deposit. NULL until the challan is recorded. */
    challanId: uuid("challan_id"),
    /** The quarterly statement that reported it. */
    tdsReturnId: uuid("tds_return_id"),

    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⭐ THE INDEX THE THRESHOLD ENGINE LIVES ON. Everything about the
     * cumulative rule is a scan of exactly this: one deductee, one
     * section, one financial year, in date order.
     */
    accumulationIdx: index("tds_deductions_accumulation_idx").on(
      t.tenantId,
      t.deducteeId,
      t.section,
      t.financialYear,
      t.deductionDate,
    ),
    quarterIdx: index("tds_deductions_quarter_idx").on(
      t.tenantId,
      t.financialYear,
      t.quarter,
      t.section,
    ),
    challanIdx: index("tds_deductions_challan_idx").on(t.tenantId, t.challanId),
    returnIdx: index("tds_deductions_return_idx").on(t.tenantId, t.tdsReturnId),
    invoiceIdx: index("tds_deductions_invoice_idx").on(t.tenantId, t.purchaseInvoiceId),
    /** The "deducted but not deposited" worklist — the 1.5%-a-month one. */
    undepositedIdx: index("tds_deductions_undeposited_idx")
      .on(t.tenantId, t.deductionDate)
      .where(sql`${t.challanId} IS NULL`),

    fyShape: check(
      "tds_deductions_fy_shape",
      sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
    rateSane: check(
      "tds_deductions_rate_sane",
      sql`${t.rateBps} >= 0 AND ${t.rateBps} <= 10000`,
    ),
    nonNegative: check(
      "tds_deductions_non_negative",
      sql`${t.paymentBaseMinor} >= 0 AND ${t.catchUpBaseMinor} >= 0
          AND ${t.chargeableBaseMinor} >= 0 AND ${t.aggregateBeforeMinor} >= 0
          AND ${t.aggregateAfterMinor} >= 0 AND ${t.tdsMinor} >= 0
          AND ${t.surchargeMinor} >= 0 AND ${t.cessMinor} >= 0`,
    ),
    /**
     * ⭐ THE CHARGEABLE BASE IS SOME OF THIS PAYMENT PLUS THE CATCH-UP.
     *
     * Two halves, and both are needed because the three threshold modes
     * behave differently:
     *
     *   • `chargeable >= catch_up` — the catch-up is PART of the
     *     chargeable base, not something added on top of it.
     *   • `chargeable - catch_up <= payment` — the part of the chargeable
     *     base attributable to THIS payment cannot exceed the payment.
     *
     * ⚠️ IT IS NOT AN EQUALITY, AND WRITING IT AS ONE WAS THE FIRST
     * DRAFT. `chargeable = payment + catch_up` is true for 194C and false
     * for the other two modes:
     *
     *   • A `below_threshold` row has a real payment and nothing
     *     chargeable — that is the entire point of recording it.
     *   • ⭐ Under 194Q the tax is on the EXCESS over ₹50 lakh, so the
     *     payment that crosses the line is only PARTLY chargeable. An
     *     equality would force the whole payment into charge and
     *     over-deduct on a cement account by a factor of several.
     */
    chargeableWithinPayment: check(
      "tds_deductions_chargeable_within_payment",
      sql`${t.chargeableBaseMinor} >= ${t.catchUpBaseMinor}
          AND ${t.chargeableBaseMinor} - ${t.catchUpBaseMinor} <= ${t.paymentBaseMinor}`,
    ),
    /** The running total must actually run. */
    aggregateBalances: check(
      "tds_deductions_aggregate_balances",
      sql`${t.aggregateAfterMinor} = ${t.aggregateBeforeMinor} + ${t.paymentBaseMinor}`,
    ),
    totalBalances: check(
      "tds_deductions_total_balances",
      sql`${t.totalDeductedMinor} = ${t.tdsMinor} + ${t.surchargeMinor} + ${t.cessMinor}`,
    ),
    /**
     * ⚠️ A CATCH-UP CANNOT EXCEED WHAT CAME BEFORE. Bringing ₹75,000 of
     * earlier payments into charge when only ₹50,000 was ever paid is
     * arithmetic that cannot be defended and would over-deduct — which
     * the deductee cannot recover from us, only from their own return.
     */
    catchUpBounded: check(
      "tds_deductions_catch_up_bounded",
      sql`${t.catchUpBaseMinor} <= ${t.aggregateBeforeMinor}`,
    ),
    /**
     * ⭐ AN OUTCOME OF `below_threshold` MEANS NOTHING WAS CHARGED.
     *
     * A row that says "below the threshold" and carries tax is one of two
     * mistakes, and both matter: either the threshold test was wrong, or
     * the outcome was copied from the previous row. A row that says
     * `deducted` and carries none is the under-deduction.
     */
    outcomeMatchesMoney: check(
      "tds_deductions_outcome_matches_money",
      sql`(${t.outcome} = 'deducted'
             AND ${t.tdsMinor} > 0 AND ${t.chargeableBaseMinor} > 0)
          OR (${t.outcome} = 'below_threshold'
             AND ${t.tdsMinor} = 0 AND ${t.chargeableBaseMinor} = 0
             AND ${t.catchUpBaseMinor} = 0)
          OR (${t.outcome} = 'nil_certificate'
             AND ${t.tdsMinor} = 0 AND ${t.surchargeMinor} = 0 AND ${t.cessMinor} = 0)
          OR (${t.outcome} = 'exempt'
             AND ${t.tdsMinor} = 0 AND ${t.chargeableBaseMinor} = 0)`,
    ),
    /**
     * ⭐⭐ THE DEDUCTION DATE IS DERIVED FROM ITS OWN INPUTS, NOT ASSERTED.
     *
     * Binds only where `credit_date` is known, which is every row written
     * through the 0106 path and no row written before it. Where both dates
     * are known the deduction date is the earlier; where only the credit
     * is known it is the credit date.
     *
     * ⚠️ IT DELIBERATELY DOES NOT BIND ON `payment_date` ALONE. A March
     * bill credited in March and paid in June is a correct row with
     * `deduction_date` in March and `payment_date` in June — the shape the
     * column's own comment describes — and a check that forced them equal
     * would refuse the very case Chapter XVII-B is most often got wrong.
     */
    deductionDateIsEarlier: check(
      "tds_deductions_deduction_date_is_earlier",
      sql`${t.creditDate} IS NULL
          OR ${t.deductionDate} = LEAST(${t.creditDate}, COALESCE(${t.paymentDate}, ${t.creditDate}))`,
    ),
    /**
     * ⭐⭐⭐ RULE 26, IN THE DATABASE.
     *
     * A payment in a currency other than the rupee carries its whole
     * working or it does not exist: the foreign amount, the rate, the
     * rate's date, its type and its publisher. And two of those are
     * pinned rather than merely recorded —
     *
     *   • `fx_rate_type = 'tt_buying'`. The rule names the telegraphic
     *     transfer buying rate. A mid rate is a different number and using
     *     it under-deducts or over-deducts; s.201(1) makes the deductor
     *     personally liable for a shortfall.
     *   • `fx_rate_date = deduction_date`. The rule fixes the date at the
     *     date the tax is required to be deducted. The invoice date is not
     *     it, and the payment date is not it either whenever the credit
     *     came first.
     *
     * ⚠️ IT IS A CHECK AND NOT A CONVENTION BECAUSE THE APPLICATION IS NOT
     * THE ONLY WRITER. A backfill, a support fix or a future import path
     * that never read `lib/tds/foreign-payments.ts` is refused here.
     */
    rule26Complete: check(
      "tds_deductions_rule_26_complete",
      sql`${t.paymentCurrency} IS NULL
          OR ${t.paymentCurrency} = 'INR'
          OR (${t.foreignPaymentBaseMinor} IS NOT NULL
              AND ${t.foreignPaymentBaseMinor} >= 0
              AND ${t.fxRate} IS NOT NULL AND ${t.fxRate} > 0
              AND ${t.fxRateDate} IS NOT NULL
              AND ${t.fxRateDate} = ${t.deductionDate}
              AND ${t.fxRateType} = 'tt_buying'
              AND ${t.fxRateSource} IS NOT NULL
              AND ${t.fxStatutoryRef} IS NOT NULL)`,
    ),
    /** A rupee payment carries no translation, so it must carry no rate. */
    domesticCarriesNoRate: check(
      "tds_deductions_domestic_carries_no_rate",
      sql`${t.paymentCurrency} IS NOT NULL AND ${t.paymentCurrency} <> 'INR'
          OR (${t.fxRate} IS NULL AND ${t.fxRateDate} IS NULL
              AND ${t.fxRateType} IS NULL AND ${t.foreignPaymentBaseMinor} IS NULL)`,
    ),
    currencyShape: check(
      "tds_deductions_payment_currency_shape",
      sql`${t.paymentCurrency} IS NULL OR ${t.paymentCurrency} ~ '^[A-Z]{3}$'`,
    ),
    /**
     * ⭐⭐ A REDUCED RATE MUST NAME THE CERTIFICATE THAT AUTHORISED IT.
     *
     * This is the one an assessment goes to first. A deduction at 0.5%
     * under a 2% section is either a Section 197 certificate or an
     * under-deduction, and there is no third possibility. If the
     * certificate number is not on the row it is not on the return
     * either, and the Department treats the difference as a default —
     * with interest, and with the certificate sitting in a drawer
     * somewhere being no help at all because it was never quoted.
     */
    certificateRateIsEvidenced: check(
      "tds_deductions_certificate_rate_is_evidenced",
      sql`(${t.rateBasis} <> 'section_197_certificate'
           AND ${t.outcome} <> 'nil_certificate')
          OR ${t.lowerDeductionCertificateId} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CERTIFICATES — FORM 16A / 27D                                       */
/* ------------------------------------------------------------------ */

/**
 * What we hand the deductee.
 *
 * ⚠️ THE CERTIFICATE IS NOT OURS TO WRITE, AND THAT SHAPES THE TABLE.
 * Rule 31(3) requires Form 16A to be DOWNLOADED FROM TRACES, generated by
 * the Department from the return we filed and the challans that matched.
 * A certificate typed by the deductor is not a valid certificate.
 *
 * So this table holds the ASSEMBLY — the figures per deductee per
 * quarter, in the shape the certificate will take — plus the TRACES
 * request and the resulting number. Its job is to answer, before the
 * request goes out, "will this certificate say what our books say?" and
 * to make the gap visible when it will not.
 *
 * ⭐ `deposited_tds_minor` IS SEPARATE FROM `total_tds_minor` FOR EXACTLY
 * THAT REASON. TRACES certifies what was DEPOSITED AND MATCHED, not what
 * was deducted. Tax deducted in March and deposited in July appears on no
 * certificate the vendor can use for that year, and the difference
 * between the two columns is the number that starts the phone call.
 */
export const tdsCertificates = pgTable(
  "tds_certificates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tds_deductees (id, tenant_id). RESTRICT. */
    deducteeId: uuid("deductee_id").notNull(),
    /** Composite FK → tds_returns. The statement it is generated from. */
    tdsReturnId: uuid("tds_return_id"),

    formType: tdsCertificateFormEnum("form_type").notNull(),
    financialYear: varchar("financial_year", { length: 7 }).notNull(),
    quarter: tdsQuarterEnum("quarter").notNull(),
    tan: varchar("tan", { length: 10 }).notNull(),

    /** ⚠️ TRACES allots this. Ours until then is a draft with no number. */
    certificateNumber: varchar("certificate_number", { length: 24 }),

    /** The figures, as assembled by `lib/tds/certificates.ts`. */
    totalBaseMinor: bigint("total_base_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalTdsMinor: bigint("total_tds_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    /** ⭐ What actually reached a challan. What TRACES will certify. */
    depositedTdsMinor: bigint("deposited_tds_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * The per-deduction detail the certificate prints: date, base, rate,
     * tax, and the challan's OLTAS triple.
     */
    lineDetail: jsonb("line_detail")
      .$type<
        Array<{
          deductionId: string;
          section: string;
          deductionDate: string;
          baseMinor: string;
          rateBps: number;
          tdsMinor: string;
          bsrCode?: string;
          challanSerial?: string;
          depositDate?: string;
        }>
      >()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    status: tdsCertificateStatusEnum("status").default("draft").notNull(),
    /** The TRACES request number, for chasing a download that has not arrived. */
    tracesRequestNumber: varchar("traces_request_number", { length: 40 }),
    issuedOn: date("issued_on", { mode: "string" }),
    /** Rule 31(3): fifteen days after the return's due date. */
    dueDate: date("due_date", { mode: "string" }),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⚠️ ONE CERTIFICATE PER DEDUCTEE PER FORM PER QUARTER PER TAN. Two
     * would mean the vendor holds two documents for one quarter, and
     * whichever they attach to their return is the one their assessment
     * is decided on — while the other says something different.
     */
    quarterKey: uniqueIndex("tds_certificates_quarter_key")
      .on(t.tenantId, t.tan, t.deducteeId, t.formType, t.financialYear, t.quarter)
      .where(sql`${t.status} <> 'revised'`),
    deducteeIdx: index("tds_certificates_deductee_idx").on(
      t.tenantId,
      t.deducteeId,
      t.financialYear,
    ),
    returnIdx: index("tds_certificates_return_idx").on(t.tenantId, t.tdsReturnId),

    tanShape: check(
      "tds_certificates_tan_shape",
      sql`${t.tan} ~ '^[A-Z]{4}[0-9]{5}[A-Z]$'`,
    ),
    fyShape: check(
      "tds_certificates_fy_shape",
      sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
    nonNegative: check(
      "tds_certificates_non_negative",
      sql`${t.totalBaseMinor} >= 0 AND ${t.totalTdsMinor} >= 0
          AND ${t.depositedTdsMinor} >= 0`,
    ),
    /**
     * ⭐ A CERTIFICATE MAY NOT CERTIFY MORE THAN WAS DEDUCTED. Certifying
     * ₹10,000 against ₹8,000 deducted hands the deductee a credit they
     * will claim and the Department will disallow — from THEM, months
     * later, on our paper.
     */
    depositedBounded: check(
      "tds_certificates_deposited_bounded",
      sql`${t.depositedTdsMinor} <= ${t.totalTdsMinor}`,
    ),
    /** An issued certificate has a number. Without one it is a draft. */
    issuedIsNumbered: check(
      "tds_certificates_issued_is_numbered",
      sql`${t.status} <> 'issued'
          OR (${t.certificateNumber} IS NOT NULL AND ${t.issuedOn} IS NOT NULL)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const tdsDeducteesRelations = relations(tdsDeductees, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [tdsDeductees.tenantId],
    references: [tenants.id],
  }),
  vendor: one(vendors, {
    fields: [tdsDeductees.vendorId],
    references: [vendors.id],
  }),
  channelPartner: one(channelPartners, {
    fields: [tdsDeductees.channelPartnerId],
    references: [channelPartners.id],
  }),
  creator: one(users, {
    fields: [tdsDeductees.createdBy],
    references: [users.id],
  }),
  deductions: many(tdsDeductions),
  certificates: many(tdsCertificates),
  lowerDeductionCertificates: many(tdsLowerDeductionCertificates),
}));

export const tdsLowerDeductionCertificatesRelations = relations(
  tdsLowerDeductionCertificates,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [tdsLowerDeductionCertificates.tenantId],
      references: [tenants.id],
    }),
    deductee: one(tdsDeductees, {
      fields: [tdsLowerDeductionCertificates.deducteeId],
      references: [tdsDeductees.id],
    }),
    deductions: many(tdsDeductions),
  }),
);

export const tdsChallansRelations = relations(tdsChallans, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [tdsChallans.tenantId],
    references: [tenants.id],
  }),
  deductions: many(tdsDeductions),
}));

export const tdsReturnsRelations = relations(tdsReturns, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [tdsReturns.tenantId],
    references: [tenants.id],
  }),
  deductions: many(tdsDeductions),
  certificates: many(tdsCertificates),
}));

export const tdsDeductionsRelations = relations(tdsDeductions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tdsDeductions.tenantId],
    references: [tenants.id],
  }),
  deductee: one(tdsDeductees, {
    fields: [tdsDeductions.deducteeId],
    references: [tdsDeductees.id],
  }),
  challan: one(tdsChallans, {
    fields: [tdsDeductions.challanId],
    references: [tdsChallans.id],
  }),
  tdsReturn: one(tdsReturns, {
    fields: [tdsDeductions.tdsReturnId],
    references: [tdsReturns.id],
  }),
  lowerDeductionCertificate: one(tdsLowerDeductionCertificates, {
    fields: [tdsDeductions.lowerDeductionCertificateId],
    references: [tdsLowerDeductionCertificates.id],
  }),
  purchaseInvoice: one(purchaseInvoices, {
    fields: [tdsDeductions.purchaseInvoiceId],
    references: [purchaseInvoices.id],
  }),
  vendor: one(vendors, {
    fields: [tdsDeductions.vendorId],
    references: [vendors.id],
  }),
  project: one(projects, {
    fields: [tdsDeductions.projectId],
    references: [projects.id],
  }),
  channelPartner: one(channelPartners, {
    fields: [tdsDeductions.channelPartnerId],
    references: [channelPartners.id],
  }),
}));

export const tdsCertificatesRelations = relations(tdsCertificates, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tdsCertificates.tenantId],
    references: [tenants.id],
  }),
  deductee: one(tdsDeductees, {
    fields: [tdsCertificates.deducteeId],
    references: [tdsDeductees.id],
  }),
  tdsReturn: one(tdsReturns, {
    fields: [tdsCertificates.tdsReturnId],
    references: [tdsReturns.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type TdsDeductee = typeof tdsDeductees.$inferSelect;
export type NewTdsDeductee = typeof tdsDeductees.$inferInsert;
export type TdsLowerDeductionCertificate =
  typeof tdsLowerDeductionCertificates.$inferSelect;
export type NewTdsLowerDeductionCertificate =
  typeof tdsLowerDeductionCertificates.$inferInsert;
export type TdsChallan = typeof tdsChallans.$inferSelect;
export type NewTdsChallan = typeof tdsChallans.$inferInsert;
export type TdsReturn = typeof tdsReturns.$inferSelect;
export type NewTdsReturn = typeof tdsReturns.$inferInsert;
export type TdsDeduction = typeof tdsDeductions.$inferSelect;
export type NewTdsDeduction = typeof tdsDeductions.$inferInsert;
export type TdsCertificate = typeof tdsCertificates.$inferSelect;
export type NewTdsCertificate = typeof tdsCertificates.$inferInsert;

export type TdsSectionCode = (typeof tdsSectionEnum.enumValues)[number];
export type TdsDeducteeType = (typeof tdsDeducteeTypeEnum.enumValues)[number];
export type TdsPanStatus = (typeof tdsPanStatusEnum.enumValues)[number];
export type TdsRateBasis = (typeof tdsRateBasisEnum.enumValues)[number];
export type TdsDeductionOutcome = (typeof tdsDeductionOutcomeEnum.enumValues)[number];
export type TdsQuarter = (typeof tdsQuarterEnum.enumValues)[number];
export type TdsChallanStatus = (typeof tdsChallanStatusEnum.enumValues)[number];
export type TdsCertificateForm = (typeof tdsCertificateFormEnum.enumValues)[number];
export type TdsCertificateStatus = (typeof tdsCertificateStatusEnum.enumValues)[number];
export type TdsReturnForm = (typeof tdsReturnFormEnum.enumValues)[number];
export type TdsReturnStatus = (typeof tdsReturnStatusEnum.enumValues)[number];
