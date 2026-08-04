/**
 * Ordence — ⭐ The TDS Section Catalogue
 * Version: v0.36.0-alpha
 *
 * Pure and isomorphic. `bigint` paise, integer basis points, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE TABLE, BECAUSE THE ALTERNATIVE IS A SWITCH IN EVERY FILE
 * ══════════════════════════════════════════════════════════════════════
 * A rate, two thresholds, a threshold MODE, a deductee split, a return
 * form and a certificate form. Six facts per section, needed by the rate
 * engine, the threshold engine, the return assembler and the certificate
 * assembler. Written once here.
 *
 * Spread across those four files instead, they drift — and the drift is
 * silent, because each file's own tests pass. The one that actually
 * happens is the return assembler thinking 194J is one section while the
 * rate engine knows it is two at 2% and 10%.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THESE ARE THE RATES AND THRESHOLDS FOR FY 2024-25, AND THEY MOVE
 * ══════════════════════════════════════════════════════════════════════
 * Every Finance Act changes some of them. Two recent examples that are
 * exactly the trap this comment exists for:
 *
 *   • 194H fell from 5% to 2% with effect from 1 October 2024 — MID-YEAR.
 *     A workspace deducting 5% in November is over-deducting; one
 *     deducting 2% in August is under-deducting. Both look consistent.
 *   • The Finance Act 2025 raised most thresholds with effect from
 *     1 April 2025 — 194C's single-payment limit and 194I's annual limit
 *     among them.
 *
 * ⚠️ SO A DEDUCTION KEEPS THE RATE IT WAS COMPUTED WITH. `tds_deductions`
 * stores `rate_bps`, `rate_basis`, `statutory_ref` and the `explanation`
 * on the row. Changing a constant here restates NOTHING that has already
 * happened, which is the only safe way for a table like this to be
 * mutable at all. A correction statement for FY 2023-24 has to reproduce
 * the rate that was right then.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 194H IS IMPORTED, NOT RESTATED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/sales/commission.ts` has deducted 194H on channel-partner payouts
 * since Phase 22, and its constants are the ones a partner statement is
 * already rendered from. Restating them here would give the product two
 * brokerage rates that agree until one of them is edited — at which point
 * the payout statement and the TDS register disagree about the same
 * payment, and the broker is the one who notices.
 */

import { applyRateBps } from "@/lib/billing/money";
import {
  TDS_194H_BPS,
  TDS_NO_PAN_BPS,
  TDS_194H_THRESHOLD_MINOR,
} from "@/lib/sales/commission";
import type {
  TdsSectionCode,
  TdsDeducteeType,
  TdsReturnForm,
  TdsCertificateForm,
} from "@/db/schema/tds";

export type { TdsSectionCode, TdsDeducteeType };

/* ------------------------------------------------------------------ */
/* THRESHOLD MODES                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐ HOW A THRESHOLD BEHAVES ONCE IT IS CROSSED. Three answers, and
 * confusing any two of them is a real, expensive, silent error.
 *
 *   `aggregate_whole`
 *       The threshold is on the AGGREGATE for the financial year, and
 *       once crossed the tax is on ALL of it — including the payments
 *       already made below it. 194C, 194A, 194H, 194I, 194J.
 *       ⭐ This is the one everybody gets wrong. Four ₹25,000 payments
 *       under 194C are ₹1,00,000 of chargeable base, not ₹25,000.
 *
 *   `aggregate_excess`
 *       The threshold is on the aggregate, and the tax is on the EXCESS
 *       over it only. 194Q, and only 194Q among these.
 *       ⚠️ ₹60 lakh of cement from one supplier is 0.1% of ₹10 lakh —
 *       ₹1,000 — not 0.1% of ₹60 lakh. Applying the `aggregate_whole`
 *       rule here over-deducts sixfold, and the supplier cannot get it
 *       back from us.
 *
 *   `per_transaction_whole`
 *       No aggregation across the year at all. Each transaction is tested
 *       on its own, and if it reaches the limit the tax is on the whole
 *       of it. 194IA — a ₹2 crore land purchase is 1% of ₹2 crore; a
 *       ₹40 lakh one is nothing, and buying two ₹40 lakh plots from
 *       different sellers aggregates neither.
 *       ⚠️ It DOES aggregate across joint buyers and joint sellers of the
 *       SAME property (Finance Act 2024, w.e.f. 1 October 2024) — four
 *       co-buyers paying ₹15 lakh each for one ₹60 lakh flat are all
 *       liable. That aggregation is a fact about the TRANSACTION and is
 *       recorded by passing the property's whole consideration as the
 *       payment base, which is why `consideration` and `payment` are the
 *       same number for this section.
 *
 *   `none`
 *       192 and 195. No threshold this engine can apply.
 */
export type ThresholdMode =
  | "aggregate_whole"
  | "aggregate_excess"
  | "per_transaction_whole"
  | "none";

/**
 * ⭐ 1% OR 2% UNDER 194C — THE ONLY PLACE THE PAYEE'S CONSTITUTION
 * CHANGES THE RATE.
 */
export type DeducteeClass = "individual_huf" | "other";

export function deducteeClassOf(type: TdsDeducteeType): DeducteeClass {
  return type === "individual" || type === "huf" ? "individual_huf" : "other";
}

/**
 * ⭐ THE FOURTH CHARACTER OF A PAN IS THE HOLDER'S CONSTITUTION.
 *
 * `AAAPA1234A` — the `P` — is an individual. `AAACA1234A` is a company.
 * This is not folklore; it is the structure the Department allots on, and
 * the file validation utility rejects a return whose deductee type
 * disagrees with it.
 *
 * ⚠️ WHY IT IS WORTH CHECKING RATHER THAN INFERRING. We could simply
 * derive the type from the PAN and never store it — but then a deductee
 * with no PAN has no type, and 194C's 1%/2% split has no answer for
 * exactly the deductee most likely to be an individual. So the type is
 * recorded and the PAN is used to CONTRADICT it, which catches the real
 * error: a labour contractor typed as a company, deducted at 2%, whose
 * PAN says `P`.
 */
export const PAN_FOURTH_CHARACTER: Readonly<Record<TdsDeducteeType, string>> =
  Object.freeze({
    individual: "P",
    huf: "H",
    company: "C",
    firm: "F",
    association_of_persons: "A",
    body_of_individuals: "B",
    local_authority: "L",
    trust: "T",
    artificial_juridical_person: "J",
    government: "G",
  });

/* ------------------------------------------------------------------ */
/* ⭐ 206AA AND 206AB — THE TWO PENALTY RATES                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ SECTION 206AA — NO PAN MEANS 20%.
 *
 * "the higher of — (i) at the rate specified in the relevant provision of
 * this Act; or (ii) at the rate or rates in force; or (iii) at the rate
 * of twenty per cent."
 *
 * ⚠️ HIGHER, NOT INSTEAD OF. On a section whose ordinary rate already
 * exceeds 20% — there are none among a developer's sections, but there
 * are under 195 — the ordinary rate stands. Reading 206AA as "the rate is
 * 20%" is the reading that under-deducts on the one case it matters.
 *
 * ⚠️ IMPORTED FROM `lib/sales/commission.ts`, which has applied it to
 * broker payouts since Phase 22.
 */
export const SECTION_206AA_BPS = TDS_NO_PAN_BPS; // 20%

/**
 * ⭐ THE 194Q / 206AA EXCEPTION THAT IS ALWAYS MISSED.
 *
 * The second proviso to Section 206AA(1) caps the no-PAN rate at FIVE per
 * cent for Section 194Q (and 194-O, and 206CC for 206C(1H)). Applying the
 * general 20% to a ₹60 lakh cement account instead of 5% of the excess is
 * a deduction of ₹12 lakh where ₹50,000 was due — from a supplier who
 * will stop supplying.
 */
export const SECTION_206AA_194Q_BPS = 500; // 5%

/**
 * ⭐ SECTION 206AB — A NON-FILER PAYS DOUBLE, OR 5%.
 *
 * "the higher of — (i) at twice the rate specified in the relevant
 * provision; or (ii) at twice the rate or rates in force; or (iii) at the
 * rate of five per cent."
 *
 * ⚠️ NOTE WHAT `twice` APPLIES TO: the rate in the SECTION, not the rate
 * we happen to be using. A deductee with a 197 certificate at 0.5% who is
 * also a specified person is not deducted at 1% — the doubling is of the
 * section's 2%, giving 4%.
 *
 * ⚠️ OMITTED BY THE FINANCE (No. 2) ACT, 2024, W.E.F. 1 OCTOBER 2024. It
 * is implemented anyway. Corrections and assessments for earlier years
 * run for years afterwards and have to reproduce the rate that was right
 * at the time — an engine that only knows current law cannot restate an
 * old return, and restating an old return is most of what a TDS
 * department does.
 */
export const SECTION_206AB_FLOOR_BPS = 500; // 5%
export const SECTION_206AB_MULTIPLIER = 2;

/**
 * ⭐ SECTIONS 206AB DOES **NOT** REACH.
 *
 * Section 206AB(2) excludes 192, 192A, 194B, 194BB, 194-IA, 194-IB, 194M
 * and 194N (and 194S for a specified person). Of the sections a developer
 * meets, that is 192 and ⭐ 194-IA.
 *
 * ⚠️ 194-IA IS THE ONE THAT MATTERS AND IT IS COUNTER-INTUITIVE. A land
 * purchase is the largest single payment a developer makes, the seller is
 * frequently an individual with a patchy filing history, and the instinct
 * is that the doubling must apply there most of all. It does not. Doubling
 * 1% to 2% on ₹5 crore is ₹5 lakh over-deducted from a seller who will
 * refuse to complete until it is corrected — at the registrar's office,
 * on the day.
 */
export const SECTIONS_OUTSIDE_206AB: ReadonlySet<TdsSectionCode> = new Set([
  "192",
  "194IA",
]);

/* ------------------------------------------------------------------ */
/* THE CATALOGUE                                                       */
/* ------------------------------------------------------------------ */

export type SectionRule = {
  code: TdsSectionCode;
  /** What it is called on a challan and on a return. */
  label: string;
  /** The clause, for the `statutory_ref` column. */
  statutoryRef: string;

  /**
   * ⭐ A SINGLE PAYMENT AT OR ABOVE THIS ATTRACTS TAX ON ITS OWN,
   * whatever the year's total is. Only 194C has one.
   */
  singleThresholdMinor: bigint | null;
  /** The annual aggregate limb. */
  annualThresholdMinor: bigint | null;
  thresholdMode: ThresholdMode;

  /** 194C's 1%. NULL where the section does not split. */
  rateBpsIndividualHuf: number | null;
  /** The ordinary rate for everyone else. */
  rateBpsOther: number | null;

  /**
   * ⚠️ FALSE FOR 192 AND 195. The rate cannot be resolved from the
   * section: salary is the employee's projected annual liability under
   * their chosen regime, and a non-resident's rate is whichever of the
   * Act and the applicable DTAA is more beneficial, which needs a treaty,
   * a tax residency certificate and a Form 10F. Returning a number would
   * be inventing an authority. The engine refuses and says why.
   */
  rateResolvable: boolean;

  /** ⭐ 20%, or 5% for 194Q. Section 206AA. */
  noPanRateBps: number;

  returnForm: TdsReturnForm;
  certificateForm: TdsCertificateForm;
  /** The nature-of-payment code the quarterly return quotes. */
  natureOfPaymentCode: string;

  /** One sentence, shown next to the determination. */
  note: string;
};

const RUPEE = 100n;
function rupees(n: bigint): bigint {
  return n * RUPEE;
}

export const TDS_SECTIONS: Readonly<Record<TdsSectionCode, SectionRule>> =
  Object.freeze({
    "192": {
      code: "192",
      label: "Salary",
      statutoryRef: "192(1)",
      singleThresholdMinor: null,
      annualThresholdMinor: null,
      thresholdMode: "none",
      rateBpsIndividualHuf: null,
      rateBpsOther: null,
      // ⚠️ HOOK ONLY. See `rateResolvable` above.
      rateResolvable: false,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "24Q",
      certificateForm: "16",
      natureOfPaymentCode: "92B",
      note:
        "Salary TDS is the employee's whole projected annual liability for the " +
        "year, net of their declared investments and their chosen regime, spread " +
        "over the remaining months. It is not a rate on a payment, so this engine " +
        "records the deduction and will not compute it.",
    },

    "194A": {
      code: "194A",
      label: "Interest other than interest on securities",
      statutoryRef: "194A(1)",
      singleThresholdMinor: null,
      // ⚠️ ₹5,000 for a payer who is not a bank, co-operative society or
      // post office. Those pay at ₹40,000 (₹50,000 for a senior citizen).
      // A developer is not one of them.
      annualThresholdMinor: rupees(5_000n),
      thresholdMode: "aggregate_whole",
      rateBpsIndividualHuf: 1000,
      rateBpsOther: 1000,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94A",
      note:
        "Interest on a loan from a director, an NBFC facility, or late-payment " +
        "interest charged by a supplier. 10%, on the year's aggregate once it " +
        "passes ₹5,000.",
    },

    "194C": {
      code: "194C",
      label: "Payments to contractors and sub-contractors",
      statutoryRef: "194C(1)",
      // ⭐ 194C(5), FIRST LIMB. A single payment at this level attracts
      // tax on its own even if the year's total never approaches the
      // annual figure.
      singleThresholdMinor: rupees(30_000n),
      // ⭐ 194C(5), SECOND LIMB. THE ONE THAT IS MISSED.
      annualThresholdMinor: rupees(100_000n),
      thresholdMode: "aggregate_whole",
      // ⭐ 194C(2): one per cent for an individual or HUF, two otherwise.
      rateBpsIndividualHuf: 100,
      rateBpsOther: 200,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94C",
      note:
        "⭐ Most of what a developer pays. Two thresholds: ₹30,000 on a single " +
        "payment, and ₹1,00,000 across the financial year — and once the annual " +
        "one is reached, tax is due on the WHOLE aggregate, including the " +
        "payments already made below it.",
    },

    "194H": {
      code: "194H",
      label: "Commission or brokerage",
      statutoryRef: "194H",
      singleThresholdMinor: null,
      // ⚠️ IMPORTED FROM `lib/sales/commission.ts`. See the file header.
      annualThresholdMinor: TDS_194H_THRESHOLD_MINOR,
      thresholdMode: "aggregate_whole",
      rateBpsIndividualHuf: TDS_194H_BPS,
      rateBpsOther: TDS_194H_BPS,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94H",
      note:
        "The channel partner's brokerage. The rate and the threshold are the ones " +
        "`lib/sales/commission.ts` already deducts on payouts — one definition, so " +
        "the partner statement and the TDS register cannot disagree.",
    },

    "194I_a": {
      code: "194I_a",
      label: "Rent — plant, machinery or equipment",
      statutoryRef: "194I(a)",
      singleThresholdMinor: null,
      annualThresholdMinor: rupees(240_000n),
      thresholdMode: "aggregate_whole",
      rateBpsIndividualHuf: 200,
      rateBpsOther: 200,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94I",
      note:
        "The crane, the batching plant, the shuttering, the site vehicles. 2% — " +
        "one fifth of the rate on land and buildings, and the two are told apart " +
        "by what is hired, not by who hires it out.",
    },

    "194I_b": {
      code: "194I_b",
      label: "Rent — land, building, furniture or fittings",
      statutoryRef: "194I(b)",
      singleThresholdMinor: null,
      annualThresholdMinor: rupees(240_000n),
      thresholdMode: "aggregate_whole",
      rateBpsIndividualHuf: 1000,
      rateBpsOther: 1000,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94I",
      note:
        "The site office, the sales gallery, the guest house, the plot leased for " +
        "a labour camp. 10%. ⚠️ The threshold is on the aggregate of ALL such rent " +
        "to one landlord for the year, not per property.",
    },

    "194IA": {
      code: "194IA",
      label: "Transfer of immovable property",
      statutoryRef: "194-IA(1)",
      // ⭐ The cliff. Not an aggregate — see `per_transaction_whole`.
      singleThresholdMinor: rupees(5_000_000n), // ₹50,00,000
      annualThresholdMinor: null,
      thresholdMode: "per_transaction_whole",
      rateBpsIndividualHuf: 100,
      rateBpsOther: 100,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      // ⚠️ NOT 26Q. Section 194-IA is discharged by Form 26QB, a
      // challan-cum-statement filed per transaction within 30 days of the
      // end of the month — and it needs NO TAN, which is why a developer
      // who has never filed a TDS return still has to file this one.
      returnForm: "26Q",
      certificateForm: "16B",
      natureOfPaymentCode: "4IA",
      note:
        "⭐ A developer buying land. 1% of the WHOLE consideration where it is " +
        "₹50 lakh or more — a cliff, not a slab: ₹49,99,000 attracts nothing and " +
        "₹50,00,000 attracts ₹50,000. Deducted by the BUYER, paid on Form 26QB, " +
        "no TAN required. ⚠️ Compare against the stamp duty value too: the higher " +
        "of consideration and stamp duty value decides both the threshold and the " +
        "base.",
    },

    "194J_a": {
      code: "194J_a",
      label: "Fees for technical services",
      statutoryRef: "194J(1)(ba)",
      singleThresholdMinor: null,
      annualThresholdMinor: rupees(30_000n),
      thresholdMode: "aggregate_whole",
      rateBpsIndividualHuf: 200,
      rateBpsOther: 200,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94J",
      note:
        "2%. Site supervision, testing, soil investigation, a call centre. ⚠️ The " +
        "boundary with professional fees is genuinely argued and the same firm can " +
        "be on both sides of it — a structural engineer's DESIGN is professional " +
        "and their SUPERVISION is often technical.",
    },

    "194J_b": {
      code: "194J_b",
      label: "Fees for professional services",
      statutoryRef: "194J(1)(a)",
      singleThresholdMinor: null,
      // ⚠️ THE ₹30,000 IS PER NATURE OF PAYMENT, NOT PER PAYEE. A firm
      // paid ₹25,000 of professional fees and ₹25,000 of technical fees
      // has crossed neither. Which is why 194J is two sections here.
      annualThresholdMinor: rupees(30_000n),
      thresholdMode: "aggregate_whole",
      rateBpsIndividualHuf: 1000,
      rateBpsOther: 1000,
      rateResolvable: true,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94J",
      note:
        "10%. The architect, the structural consultant, the RERA lawyer, the " +
        "auditor, the valuer. Five times the technical-services rate, on a " +
        "distinction nothing on the invoice states.",
    },

    "194Q": {
      code: "194Q",
      label: "Purchase of goods",
      statutoryRef: "194Q(1)",
      singleThresholdMinor: null,
      annualThresholdMinor: rupees(5_000_000n), // ₹50,00,000
      // ⭐ THE EXCESS, NOT THE WHOLE. See `ThresholdMode`.
      thresholdMode: "aggregate_excess",
      rateBpsIndividualHuf: 10, // 0.1%
      rateBpsOther: 10,
      rateResolvable: true,
      // ⭐ 5%, not 20% — second proviso to 206AA(1).
      noPanRateBps: SECTION_206AA_194Q_BPS,
      returnForm: "26Q",
      certificateForm: "16A",
      natureOfPaymentCode: "94Q",
      note:
        "Cement, steel, tiles, sand — a developer passes ₹50 lakh with one " +
        "supplier well inside a year. ⭐ 0.1% ON THE EXCESS OVER ₹50 LAKH ONLY, " +
        "not on the whole. ⚠️ Applies only where OUR turnover exceeded ₹10 crore " +
        "in the preceding year, and it overrides the seller's 206C(1H) collection.",
    },

    "195": {
      code: "195",
      label: "Payments to a non-resident",
      statutoryRef: "195(1)",
      singleThresholdMinor: null,
      annualThresholdMinor: null,
      thresholdMode: "none",
      rateBpsIndividualHuf: null,
      rateBpsOther: null,
      // ⚠️ HOOK ONLY. See `rateResolvable`.
      rateResolvable: false,
      noPanRateBps: SECTION_206AA_BPS,
      returnForm: "27Q",
      certificateForm: "16A",
      natureOfPaymentCode: "195",
      note:
        "There is no threshold and no single rate. The charge is at 'the rates in " +
        "force', which means whichever of the Act and the applicable double " +
        "taxation avoidance agreement is more beneficial — decided on a treaty, a " +
        "tax residency certificate and a Form 10F, plus surcharge and cess. This " +
        "engine records the deduction and refuses to invent the rate.",
    },
  } satisfies Record<TdsSectionCode, SectionRule>);

export const TDS_SECTION_CODES = Object.keys(TDS_SECTIONS) as TdsSectionCode[];

export function sectionRule(code: TdsSectionCode): SectionRule {
  return TDS_SECTIONS[code];
}

/**
 * The sections whose threshold, once crossed, brings the WHOLE aggregate
 * into charge.
 *
 * ⚠️ SQL 0025 §6 RESTATES THIS LIST IN A TRIGGER, AND
 * `tests/security/tds.test.ts` ASSERTS THE TWO AGREE. The database has to
 * know it in order to refuse a section that deducted on part of its own
 * aggregate, and a database that cannot call TypeScript has to be told.
 * The test is what stops the two drifting.
 */
export function sectionsWithMode(mode: ThresholdMode): TdsSectionCode[] {
  return TDS_SECTION_CODES.filter((code) => TDS_SECTIONS[code].thresholdMode === mode);
}

/**
 * The ordinary rate for a section and a payee class.
 *
 * Returns `null` where the section's rate is not resolvable from the
 * section — 192 and 195. ⚠️ A caller treating `null` as zero deducts
 * nothing from an employee and nothing from a non-resident, which are the
 * two deductions with the largest penalty attached.
 */
export function normalRateBps(
  code: TdsSectionCode,
  deducteeClass: DeducteeClass,
): number | null {
  const rule = TDS_SECTIONS[code];
  if (!rule.rateResolvable) return null;
  return deducteeClass === "individual_huf"
    ? rule.rateBpsIndividualHuf
    : rule.rateBpsOther;
}

/**
 * The tax on a base at a rate.
 *
 * ⚠️ `applyRateBps` FROM `lib/billing/money.ts`, NOT A SECOND ROUNDING.
 * The whole product rounds half-up in exact integer arithmetic in one
 * place, and a TDS figure that differs by a paisa from the same
 * calculation done on the payout statement is a discrepancy nobody can
 * explain to the vendor holding both documents.
 */
export function tdsOn(baseMinor: bigint, rateBps: number): bigint {
  return applyRateBps(baseMinor, rateBps);
}

/**
 * Does the deductee's PAN agree with the constitution recorded for them?
 *
 * ⭐ THE CHECK THE FILE VALIDATION UTILITY RUNS, RUN EARLY. A mismatch
 * rejects the whole quarterly return, not the one record — so it is found
 * three weeks after the payments went out, when the fee under Section
 * 234E is already accruing at ₹200 a day.
 *
 * Returns `null` when there is nothing to check.
 */
export function panAgreesWithDeducteeType(
  pan: string | null | undefined,
  type: TdsDeducteeType,
): boolean | null {
  if (!pan || pan.length !== 10) return null;
  return pan[3] === PAN_FOURTH_CHARACTER[type];
}

/** Format basis points for a sentence: 200 → "2.00%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Format paise for a sentence: 100000n → "₹1,000.00". */
export function formatPaise(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;
  // ⚠️ The Indian grouping is 2,2,3 from the right — 1,00,000 not 100,000.
  // A lakh printed as "100,000" is read as a hundred thousand by nobody in
  // the office it is printed for.
  const digits = rupees.toString();
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }
  return `${negative ? "-" : ""}₹${grouped}.${paise.toString().padStart(2, "0")}`;
}
