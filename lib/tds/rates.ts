/**
 * Ordence — ⭐ Rate Resolution: 206AA, 206AB and Section 197
 * Version: v0.36.0-alpha
 *
 * Pure. Integer basis points, `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FOUR RULES, AND THEY DO NOT COMPOSE THE WAY THEY LOOK LIKE THEY DO
 * ══════════════════════════════════════════════════════════════════════
 *   THE SECTION      — 1% or 2% under 194C, 10% under 194J(a), and so on.
 *   ⭐ SECTION 206AA — no usable PAN: the HIGHER of the section's rate
 *                      and 20%.
 *   ⭐ SECTION 206AB — a "specified person" who has not filed: the HIGHER
 *                      of TWICE the section's rate and 5%.
 *   ⭐ SECTION 197   — a certificate from the Assessing Officer at a
 *                      lower rate, valid for a window and up to a cap.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THREE MISTAKES THIS FILE IS BUILT AROUND
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. READING 206AA AS "THE RATE IS 20%".
 *    It is the HIGHER of three things. On a section already above 20% the
 *    section's rate stands. Substituting 20% under-deducts on exactly the
 *    payments where the deduction is largest.
 *
 * 2. ⭐⭐ APPLYING 206AA **OR** 206AB WHEN BOTH BITE.
 *    A vendor with no PAN who is also a specified person is not a 20%
 *    deduction and not a 4% one. Section 206AB(2) is explicit: where both
 *    apply, tax is deducted at the HIGHER of the two rates. On a 194J
 *    professional fee that is max(20%, 20%) = 20%; on a 194C payment to a
 *    company it is max(20%, 4%) = 20%; on a 195 payment at 30% it is
 *    max(30%, 60%) = 60%. Picking one section and applying it alone is
 *    the error, and it is the one an assessment finds first because the
 *    Department's own utility computes both.
 *
 * 3. ⭐ APPLYING A SECTION 197 CERTIFICATE OUTSIDE ITS WINDOW.
 *    The subcontractor sends the certificate in June, accounts files it,
 *    and it is still being applied the following August to a certificate
 *    that expired on 31 March. Every payment in between is short by the
 *    difference between 0.5% and 2%, Section 201(1) makes the shortfall
 *    ours, and the certificate — which is a real document, correctly
 *    issued — is no defence at all for the period after it lapsed.
 *
 * ⚠️ NOTHING HERE IS DECIDED BY A DEFAULT. Every branch names its
 * section, returns the component rates it compared, and writes the
 * sentence that is stored on the deduction row. A rate with no recorded
 * reason is indistinguishable from a typo two years later.
 */

import {
  SECTION_206AA_BPS,
  SECTION_206AB_FLOOR_BPS,
  SECTION_206AB_MULTIPLIER,
  SECTIONS_OUTSIDE_206AB,
  deducteeClassOf,
  formatBps,
  formatPaise,
  normalRateBps,
  sectionRule,
  tdsOn,
  type SectionRule,
} from "./sections";
import type {
  TdsDeducteeType,
  TdsPanStatus,
  TdsRateBasis,
  TdsSectionCode,
} from "@/db/schema/tds";

/* ------------------------------------------------------------------ */
/* INPUTS                                                              */
/* ------------------------------------------------------------------ */

/** Everything about the payee that changes the rate. */
export type DeducteeFacts = {
  deducteeType: TdsDeducteeType;
  panNumber: string | null;
  panStatus: TdsPanStatus;
  /** ⭐ The Compliance Check utility's answer. Not our own judgement. */
  isSpecifiedPerson206ab: boolean;
  isNonResident?: boolean;
};

/** A Section 197 certificate, as recorded. */
export type LowerDeductionCertificateFacts = {
  id: string;
  certificateNumber: string;
  section: TdsSectionCode;
  rateBps: number;
  /** Inclusive, both ends. */
  validFrom: string;
  validTo: string;
  /** NULL = uncapped. */
  capBaseMinor: bigint | null;
  isActive: boolean;
};

export type RateResolution = {
  /** The rate to deduct at. `null` when the engine refuses to decide. */
  rateBps: number | null;
  basis: TdsRateBasis;
  statutoryRef: string;
  explanation: string;

  /** Every rate that was compared. The working, kept. */
  components: {
    normalBps: number | null;
    section206aaBps: number | null;
    section206abBps: number | null;
    certificateBps: number | null;
  };

  /** Set when a certificate was applied. Goes on the deduction row. */
  certificateId: string | null;

  /**
   * ⚠️ POPULATED WHEN THE ENGINE WILL NOT DECIDE — 192 and 195, or a
   * certificate that cannot be relied on. A rate of `null` with no
   * `problem` would be a silent zero deduction.
   */
  problem: string | null;

  /**
   * Warnings that do not change the rate but change what somebody should
   * do next: a stale 206AB check, a certificate about to expire, a
   * certificate whose cap this payment exhausts.
   */
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/* ⭐ THE PAN QUESTION                                                  */
/* ------------------------------------------------------------------ */

/**
 * Does this deductee have a PAN that Section 206AA will accept?
 *
 * ⚠️ `inoperative` IS THE ANSWER PEOPLE GET WRONG. A PAN that is not
 * linked to Aadhaar became inoperative under Rule 114AAA, and CBDT
 * Circular 3/2023 treats a deduction against one as a deduction against
 * no PAN — 20%, with the shortfall recoverable from the DEDUCTOR. The
 * number is on file, it passes every structure check, and it is worth
 * nothing. A workspace discovers this when TRACES raises a short-deduction
 * demand for a year of 1% deductions that should have been 20%.
 */
export function hasUsablePan(facts: DeducteeFacts): boolean {
  return facts.panStatus === "valid" && !!facts.panNumber;
}

/* ------------------------------------------------------------------ */
/* ⭐ SECTION 197 — IS THE CERTIFICATE GOOD TODAY?                      */
/* ------------------------------------------------------------------ */

export type CertificateVerdict =
  | { usable: true; certificate: LowerDeductionCertificateFacts; note: string }
  | { usable: false; reason: string };

/**
 * ⭐ MAY THIS CERTIFICATE BE APPLIED TO A PAYMENT ON `day`?
 *
 * Five ways it cannot be, and every one of them happens:
 *
 *   • THE WINDOW HAS NOT OPENED. Certificates are commonly issued from
 *     the date of application, not from 1 April, and payments made before
 *     that date are at the ordinary rate — including ones made while the
 *     application was pending.
 *   • ⭐ THE WINDOW HAS CLOSED. The expensive one. A certificate expires
 *     on 31 March at the latest and is routinely still being applied in
 *     August because nobody re-read the dates.
 *   • THE CAP IS EXHAUSTED. Most certificates name an amount of payment;
 *     beyond it the normal rate returns, on the excess.
 *   • IT IS FOR ANOTHER SECTION. A 194C certificate does not cover a
 *     194J fee to the same firm.
 *   • ⚠️ THERE IS NO PAN. Section 206AA(4) forbids the Assessing Officer
 *     from granting a certificate where no PAN is quoted, so a
 *     certificate against a PAN-less deductee is a document that cannot
 *     exist. Applying one means either the PAN record is wrong or the
 *     certificate is — and either way the deduction is at 20%.
 */
export function assessCertificate(args: {
  certificate: LowerDeductionCertificateFacts | null | undefined;
  section: TdsSectionCode;
  day: string;
  hasPan: boolean;
  /** Base already paid under this certificate this year. */
  consumedBaseMinor?: bigint;
  /** The base about to be charged. */
  chargeableBaseMinor?: bigint;
}): CertificateVerdict {
  const cert = args.certificate;
  if (!cert) return { usable: false, reason: "No lower-deduction certificate on file." };

  if (!cert.isActive) {
    return {
      usable: false,
      reason: `Certificate ${cert.certificateNumber} has been withdrawn.`,
    };
  }

  if (cert.section !== args.section) {
    return {
      usable: false,
      reason:
        `Certificate ${cert.certificateNumber} was issued for Section ` +
        `${cert.section} and this payment is under Section ${args.section}. ⚠️ A ` +
        `certificate covers one section — a 194C certificate does not reduce a ` +
        `194J fee to the same firm.`,
    };
  }

  // ⚠️ 206AA(4). See the doc comment.
  if (!args.hasPan) {
    return {
      usable: false,
      reason:
        `Certificate ${cert.certificateNumber} cannot be relied on: there is no ` +
        `usable PAN for this deductee, and Section 206AA(4) forbids the Assessing ` +
        `Officer from granting a certificate under Section 197 unless a PAN is ` +
        `quoted. Either the PAN record is wrong or the certificate is. Until that ` +
        `is settled the deduction is at 20%.`,
    };
  }

  if (args.day < cert.validFrom) {
    return {
      usable: false,
      reason:
        `Certificate ${cert.certificateNumber} is valid from ${cert.validFrom} and ` +
        `this payment is dated ${args.day}. ⚠️ A certificate does not reach back ` +
        `to payments made while the application was pending — those are at the ` +
        `ordinary rate.`,
    };
  }

  // ⭐ THE EXPENSIVE ONE.
  if (args.day > cert.validTo) {
    return {
      usable: false,
      reason:
        `⭐ Certificate ${cert.certificateNumber} EXPIRED on ${cert.validTo} and ` +
        `this payment is dated ${args.day}. The ordinary rate applies. ⚠️ This is ` +
        `the commonest way a lower-deduction certificate turns into a demand: it ` +
        `is a real, correctly issued document, and it stops being a defence the ` +
        `day after its window closes. Ask the deductee for the renewal — they have ` +
        `to apply for it, we cannot.`,
    };
  }

  if (cert.capBaseMinor !== null && cert.capBaseMinor !== undefined) {
    const consumed = args.consumedBaseMinor ?? 0n;
    if (consumed >= cert.capBaseMinor) {
      return {
        usable: false,
        reason:
          `Certificate ${cert.certificateNumber} is capped at ` +
          `${formatPaise(cert.capBaseMinor)} and ${formatPaise(consumed)} has ` +
          `already been paid under it. Beyond the cap the ordinary rate returns.`,
      };
    }
  }

  return {
    usable: true,
    certificate: cert,
    note:
      `Certificate ${cert.certificateNumber} at ${formatBps(cert.rateBps)}, valid ` +
      `${cert.validFrom} to ${cert.validTo}.`,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE RATE                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⭐ RESOLVE THE RATE FOR ONE PAYMENT.
 *
 * ⚠️ THE THRESHOLD IS SETTLED BEFORE THIS IS CALLED, AND THE ORDER
 * MATTERS. Section 206AA raises the rate "where tax is required to be
 * deducted" — below the threshold no tax is required, so 20% does not
 * apply to a ₹5,000 payment to a PAN-less contractor. Resolving the rate
 * first and the threshold second would deduct ₹1,000 from a payment that
 * attracts nothing, which the deductee can only recover a year later on
 * their own return.
 *
 * ⚠️ IT NEVER THROWS. A screen listing this week's payment run must not
 * blank out because one payee is a non-resident. Those cases come back
 * with `rateBps: null` and a `problem` naming what a person has to
 * decide.
 */
export function resolveTdsRate(args: {
  section: TdsSectionCode;
  deductee: DeducteeFacts;
  /** `YYYY-MM-DD`. Date of credit or of payment, whichever is earlier. */
  day: string;
  certificate?: LowerDeductionCertificateFacts | null;
  consumedCertificateBaseMinor?: bigint;
  chargeableBaseMinor?: bigint;
  /** When the 206AB compliance check was last run for this deductee. */
  specifiedPersonCheckedOn?: string | null;
}): RateResolution {
  const rule: SectionRule = sectionRule(args.section);
  const deducteeClass = deducteeClassOf(args.deductee.deducteeType);
  const warnings: string[] = [];

  const normal = normalRateBps(args.section, deducteeClass);
  const hasPan = hasUsablePan(args.deductee);

  const empty = {
    normalBps: normal,
    section206aaBps: null as number | null,
    section206abBps: null as number | null,
    certificateBps: null as number | null,
  };

  /* --- 192 and 195: the engine refuses to invent a rate ----------- */
  if (!rule.rateResolvable || normal === null) {
    return {
      rateBps: null,
      basis: "manually_determined",
      statutoryRef: rule.statutoryRef,
      explanation: rule.note,
      components: empty,
      certificateId: null,
      problem:
        `The rate under Section ${rule.code} cannot be resolved from the section. ` +
        rule.note +
        ` ⚠️ Record the rate somebody has computed, with the working — a zero ` +
        `deduction here is the largest silent default available in Chapter XVII-B.`,
      warnings,
    };
  }

  /* --- ⭐ SECTION 197 --------------------------------------------- */

  const certVerdict = assessCertificate({
    certificate: args.certificate,
    section: args.section,
    day: args.day,
    hasPan,
    consumedBaseMinor: args.consumedCertificateBaseMinor,
    chargeableBaseMinor: args.chargeableBaseMinor,
  });

  /* --- ⭐ SECTION 206AA ------------------------------------------- */

  let section206aaBps: number | null = null;
  if (!hasPan) {
    // ⚠️ THE **HIGHER** OF THE SECTION'S RATE AND 20% (or 5% for 194Q).
    // Not "20% instead of".
    section206aaBps = Math.max(normal, rule.noPanRateBps);
  }

  /* --- ⭐ SECTION 206AB ------------------------------------------- */

  let section206abBps: number | null = null;
  if (args.deductee.isSpecifiedPerson206ab) {
    if (SECTIONS_OUTSIDE_206AB.has(args.section)) {
      // ⚠️ 194-IA and 192 are outside 206AB(2). Doubling 1% on a ₹5 crore
      // land purchase would over-deduct ₹5 lakh at the registrar's office.
      warnings.push(
        `This deductee is a specified person under Section 206AB, but Section ` +
          `${rule.code} is expressly OUTSIDE it — 206AB(2) excludes it. The ` +
          `ordinary rate applies and the doubling does not.`,
      );
    } else {
      // The HIGHER of twice the SECTION's rate and 5%. ⚠️ Twice the
      // section's rate, not twice whatever rate we were about to use.
      section206abBps = Math.max(normal * SECTION_206AB_MULTIPLIER, SECTION_206AB_FLOOR_BPS);
      if (!args.specifiedPersonCheckedOn) {
        warnings.push(
          "The 206AB flag on this deductee has no check date. The determination " +
            "belongs to the Department's Compliance Check utility, not to us, and " +
            "an undated copy of it is indistinguishable from a guess.",
        );
      }
    }
  }

  /* --- ⭐⭐ COMBINE. 206AB(2): WHERE BOTH APPLY, THE HIGHER. ------ */

  if (section206aaBps !== null || section206abBps !== null) {
    const aa = section206aaBps ?? 0;
    const ab = section206abBps ?? 0;
    const chosen = Math.max(normal, aa, ab);

    let basis: TdsRateBasis;
    let statutoryRef: string;
    let explanation: string;

    if (section206aaBps !== null && section206abBps !== null) {
      // ⭐ THE CASE THE TESTS PIN DOWN.
      basis = "section_206aa_and_206ab";
      statutoryRef = "206AA/206AB";
      explanation =
        `⭐ BOTH Section 206AA and Section 206AB apply to this deductee, and ` +
        `Section 206AB(2) requires the HIGHER of the two. ` +
        `Section ${rule.code} would be ${formatBps(normal)}; Section 206AA — no ` +
        `usable PAN — gives ${formatBps(aa)}; Section 206AB — a specified person ` +
        `who has not filed — gives ${formatBps(ab)}. Deducting at ` +
        `${formatBps(chosen)}. ⚠️ Applying only one of the two is the classic ` +
        `error here: the Department's own utility computes both and compares them.` +
        (certVerdict.usable
          ? ` ⚠️ A Section 197 certificate is on file and CANNOT reduce this — ` +
            `206AB(1) opens "notwithstanding anything contained in any other ` +
            `provisions of this Act".`
          : "");
    } else if (section206aaBps !== null) {
      basis = "section_206aa_no_pan";
      statutoryRef = "206AA(1)";
      explanation =
        `⭐ No usable PAN for this deductee (${panStatusPhrase(args.deductee)}), ` +
        `so Section 206AA requires the HIGHER of the Section ${rule.code} rate ` +
        `(${formatBps(normal)}) and ${formatBps(rule.noPanRateBps)}. Deducting at ` +
        `${formatBps(chosen)}. ⚠️ Obtaining the PAN reduces this to ` +
        `${formatBps(normal)} for FUTURE payments only — Section 205 bars us from ` +
        `refunding what has already been deposited, so the deductee can only ` +
        `recover it on their own return.` +
        (rule.code === "194Q"
          ? ` ⚠️ Note the exception: the second proviso to 206AA(1) caps the ` +
            `no-PAN rate at 5% for Section 194Q, not 20%.`
          : "");
    } else {
      basis = "section_206ab_non_filer";
      statutoryRef = "206AB(1)";
      explanation =
        `⭐ This deductee is a specified person under Section 206AB — they have ` +
        `not furnished their return for the relevant previous year and ₹50,000 or ` +
        `more was deducted from them in it. Tax is at the HIGHER of twice the ` +
        `Section ${rule.code} rate (${formatBps(normal * SECTION_206AB_MULTIPLIER)}) ` +
        `and ${formatBps(SECTION_206AB_FLOOR_BPS)}. Deducting at ` +
        `${formatBps(chosen)}, against an ordinary ${formatBps(normal)}.` +
        (certVerdict.usable
          ? ` ⚠️ A Section 197 certificate is on file and does NOT reduce this: ` +
            `206AB(1) opens "notwithstanding anything contained in any other ` +
            `provisions of this Act", and the doubling is of the SECTION's rate, ` +
            `not of the certificate's.`
          : "");
    }

    return {
      rateBps: chosen,
      basis,
      statutoryRef,
      explanation,
      components: {
        normalBps: normal,
        section206aaBps,
        section206abBps,
        certificateBps: certVerdict.usable ? certVerdict.certificate.rateBps : null,
      },
      certificateId: null,
      problem: null,
      warnings,
    };
  }

  /* --- ⭐ The certificate, where nothing overrides it ------------- */

  if (certVerdict.usable) {
    const cert = certVerdict.certificate;
    if (cert.capBaseMinor !== null && cert.capBaseMinor !== undefined) {
      const consumed = args.consumedCertificateBaseMinor ?? 0n;
      const remaining = cert.capBaseMinor - consumed;
      const about = args.chargeableBaseMinor ?? 0n;
      if (about > remaining) {
        warnings.push(
          `⚠️ This payment exhausts certificate ${cert.certificateNumber}. Its cap ` +
            `is ${formatPaise(cert.capBaseMinor)}, ${formatPaise(consumed)} has ` +
            `been paid under it, and this payment is ${formatPaise(about)}. Only ` +
            `${formatPaise(remaining)} is covered — the excess is at the ordinary ` +
            `${formatBps(normal)}, and a single rate applied to the whole payment ` +
            `under-deducts on the part above the cap.`,
        );
      }
    }

    return {
      rateBps: cert.rateBps,
      basis: "section_197_certificate",
      statutoryRef: "197",
      explanation:
        `Certificate ${cert.certificateNumber} under Section 197 authorises ` +
        `${formatBps(cert.rateBps)} against the ordinary ${formatBps(normal)} for ` +
        `Section ${rule.code}, for payments from ${cert.validFrom} to ` +
        `${cert.validTo}` +
        (cert.capBaseMinor
          ? ` and up to ${formatPaise(cert.capBaseMinor)}`
          : " with no cap") +
        `. ⚠️ The certificate number goes on the quarterly return — a reduced rate ` +
        `without it is treated as a short deduction, and the certificate in the ` +
        `drawer is no help because it was never quoted.`,
      components: {
        normalBps: normal,
        section206aaBps: null,
        section206abBps: null,
        certificateBps: cert.rateBps,
      },
      certificateId: cert.id,
      problem: null,
      warnings,
    };
  }

  // A certificate that exists but cannot be used is worth saying out loud
  // — it is why the rate is not the one the vendor is expecting.
  if (args.certificate) warnings.push(certVerdict.reason);

  /* --- The ordinary rate ------------------------------------------ */

  return {
    rateBps: normal,
    basis: "normal",
    statutoryRef: rule.statutoryRef,
    explanation:
      `${formatBps(normal)} under Section ${rule.code} — ${rule.label.toLowerCase()}` +
      (rule.rateBpsIndividualHuf !== rule.rateBpsOther
        ? `, at the ${deducteeClass === "individual_huf" ? "individual/HUF" : "non-individual"} ` +
          `rate. ⚠️ Section 194C(2) charges 1% to an individual or HUF and 2% to ` +
          `everyone else, and nothing on the invoice says which — the PAN's fourth ` +
          `character does.`
        : "."),
    components: {
      normalBps: normal,
      section206aaBps: null,
      section206abBps: null,
      certificateBps: null,
    },
    certificateId: null,
    problem: null,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* THE WHOLE COMPUTATION                                               */
/* ------------------------------------------------------------------ */

export type DeductionComputation = {
  rateBps: number;
  basis: TdsRateBasis;
  statutoryRef: string;
  explanation: string;
  chargeableBaseMinor: bigint;
  tdsMinor: bigint;
  /** What the payee actually receives, on this payment. */
  netPayableMinor: bigint;
  certificateId: string | null;
  warnings: string[];
  problem: string | null;
};

/**
 * Rate × base, with the net.
 *
 * ⚠️ THE NET IS THE PAYMENT LESS THE **WHOLE** TAX, INCLUDING THE
 * CATCH-UP. When the annual threshold is crossed on a ₹25,000 payment,
 * the tax is ₹1,000 on ₹1,00,000 — so the contractor receives ₹24,000,
 * not ₹24,750. That is a conversation, and it is a much shorter one had
 * before the transfer than after it.
 */
export function computeDeduction(args: {
  paymentBaseMinor: bigint;
  chargeableBaseMinor: bigint;
  resolution: RateResolution;
}): DeductionComputation {
  const { resolution } = args;

  if (resolution.rateBps === null) {
    return {
      rateBps: 0,
      basis: resolution.basis,
      statutoryRef: resolution.statutoryRef,
      explanation: resolution.explanation,
      chargeableBaseMinor: args.chargeableBaseMinor,
      tdsMinor: 0n,
      netPayableMinor: args.paymentBaseMinor,
      certificateId: resolution.certificateId,
      warnings: resolution.warnings,
      problem: resolution.problem,
    };
  }

  const tdsMinor = tdsOn(args.chargeableBaseMinor, resolution.rateBps);

  return {
    rateBps: resolution.rateBps,
    basis: resolution.basis,
    statutoryRef: resolution.statutoryRef,
    explanation: resolution.explanation,
    chargeableBaseMinor: args.chargeableBaseMinor,
    tdsMinor,
    netPayableMinor: args.paymentBaseMinor - tdsMinor,
    certificateId: resolution.certificateId,
    warnings: resolution.warnings,
    problem: resolution.problem,
  };
}

/* ------------------------------------------------------------------ */

function panStatusPhrase(facts: DeducteeFacts): string {
  switch (facts.panStatus) {
    case "not_furnished":
      return "no PAN has been furnished";
    case "invalid":
      return "the PAN on file fails validation";
    case "inoperative":
      return (
        "the PAN is INOPERATIVE — not linked to Aadhaar under Rule 114AAA, which " +
        "CBDT Circular 3/2023 treats exactly as no PAN at all, and which passes " +
        "every structure check while being worth nothing"
      );
    case "applied_for":
      return (
        "a PAN has been applied for but not issued — which is reportable as " +
        "PANAPPLIED and still attracts 206AA"
      );
    case "valid":
      return "the PAN is valid";
  }
}
