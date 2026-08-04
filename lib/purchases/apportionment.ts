/**
 * Ordence — ⭐ RULE 42 AND RULE 43 APPORTIONMENT
 * Version: v0.33.0-alpha
 *
 * Pure. Every amount is `bigint` paise. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THE RULES ACTUALLY SAY
 * ══════════════════════════════════════════════════════════════════════
 * Section 17(2) of the CGST Act: where inputs are used partly for taxable
 * supplies and partly for exempt ones, credit is restricted to the
 * taxable portion. Rule 42 turns that sentence into arithmetic for inputs
 * and input services; Rule 43 does the same for capital goods, over sixty
 * months.
 *
 * Rule 42(1), in the rule's own letters:
 *
 *     C1 = total input tax on inputs and input services in the period
 *     T1 = credit attributable exclusively to NON-BUSINESS use
 *     T2 = credit attributable exclusively to EXEMPT supplies
 *     T3 = credit BLOCKED under Section 17(5)
 *     C2 = C1 − (T1 + T2 + T3)          ← what enters the credit ledger
 *     T4 = credit attributable exclusively to TAXABLE (incl. zero-rated)
 *     C3 = C2 − T4                      ← the COMMON credit
 *     D1 = C3 × (E ÷ F)                 ← exempt share, reversed
 *     D2 = 5% of C3                     ← deemed non-business, reversed
 *     eligible common credit = C3 − D1 − D2
 *
 *     E = exempt turnover in the period, F = total turnover.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE LAST LINE IS A SUBTRACTION AND NOT A THIRD MULTIPLICATION
 * ══════════════════════════════════════════════════════════════════════
 * The tempting implementation of the last line is
 * `C3 × (1 − E/F) − D2`, computed independently. It is wrong by a paisa
 * or two, and the paisa matters more here than almost anywhere else in
 * the product.
 *
 * D1 and D2 are ADDED BACK TO OUTPUT TAX in GSTR-3B. The eligible common
 * credit is AVAILED. If the three do not add back to C3 exactly, then the
 * credit ledger and the reversal disagree by the difference, and the
 * difference is unexplainable: it is not an error anybody made, it is
 * two roundings that did not meet. An officer recomputing the working
 * gets a different number from the return and asks why.
 *
 * So the eligible common credit is the RESIDUAL. C3 − D1 − D2, computed
 * by subtraction, which makes
 *
 *     T1 + T2 + T3 + T4 + D1 + D2 + eligibleCommon = C1
 *
 * true by construction, for every input, for every ratio, forever. The
 * assertion at the end of `apportionRule42` is not decoration — it is the
 * guard that fires if somebody later "simplifies" the subtraction into a
 * multiplication.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ HEAD-WISE, NOT ON A TOTAL
 * ══════════════════════════════════════════════════════════════════════
 * GSTR-3B Table 4(B) reports the reversal separately for IGST, CGST, SGST
 * and cess. A single reversal figure computed on the summed credit cannot
 * be split back into four heads without inventing a ratio — and the four
 * heads are not in the same ratio as the credit, because IGST inputs and
 * intra-state inputs arrive in whatever mix the month happened to bring.
 *
 * So `apportionRule42` operates on ONE head, exactly, and
 * `apportionRule42ByHead` runs it four times. That also keeps the
 * exactness proof one-dimensional, which is why it is provable at all.
 */

import { applyRateBps } from "@/lib/billing/money";
import type { TaxHeads } from "./itc";

/* ------------------------------------------------------------------ */
/* RULE 42                                                             */
/* ------------------------------------------------------------------ */

export type Rule42Input = {
  /** C1 — total input tax for the period, for ONE head, in paise. */
  totalCreditMinor: bigint;
  /** T1 — exclusively non-business. */
  nonBusinessMinor: bigint;
  /** T2 — exclusively exempt. */
  exemptMinor: bigint;
  /** T3 — blocked under Section 17(5). */
  blockedMinor: bigint;
  /** T4 — exclusively taxable, including zero-rated. */
  taxableMinor: bigint;
  /**
   * E — the value of EXEMPT supplies in the period, in paise.
   *
   * ⚠️ FOR A DEVELOPER "EXEMPT" IS WIDER THAN IT SOUNDS. The Explanation
   * to Rule 42 pulls into E the value of land and of completed buildings
   * sold — a sale after the completion certificate is neither a supply of
   * goods nor of services (Schedule III para 5), and the rule
   * nevertheless makes it part of the exempt turnover for this formula.
   * Omitting it understates E, understates the reversal, and overstates
   * the credit — which is the direction that attracts interest.
   */
  exemptTurnoverMinor: bigint;
  /** F — total turnover in the period, in paise. */
  totalTurnoverMinor: bigint;
  /**
   * The deemed non-business share of common credit. 500 bps = 5%, which
   * is what Rule 42(1)(l) prescribes.
   *
   * ⚠️ PARAMETERISED BUT DEFAULTED, NOT HARD-CODED AND NOT LEFT TO THE
   * CALLER. It is a fixed percentage in the rule today; a caller who had
   * to supply it would eventually supply the wrong one, and a literal in
   * the body would make the day it changes a code search.
   */
  deemedNonBusinessRateBps?: number;
};

export type Rule42Result = {
  /** The letters, as the rule names them. */
  c1: bigint;
  t1: bigint;
  t2: bigint;
  t3: bigint;
  /** C2 = C1 − (T1+T2+T3). What actually enters the credit ledger. */
  c2: bigint;
  t4: bigint;
  /** C3 = C2 − T4. The common credit. */
  c3: bigint;
  /** D1 = C3 × E/F. Reversed as attributable to exempt supplies. */
  d1: bigint;
  /** D2 = 5% of C3. Reversed as deemed non-business. */
  d2: bigint;
  /** ⭐ C3 − D1 − D2, by SUBTRACTION. Never recomputed. */
  eligibleCommonMinor: bigint;

  /** What GSTR-3B Table 4(A) shows: T4 + eligible common. */
  netEligibleMinor: bigint;
  /** What GSTR-3B Table 4(B)(1) shows: D1 + D2. */
  totalReversalMinor: bigint;
  /** The exempt ratio actually applied, in basis points. For the working. */
  exemptRatioBps: number;
};

export function apportionRule42(input: Rule42Input): Rule42Result {
  const c1 = input.totalCreditMinor;
  const t1 = input.nonBusinessMinor;
  const t2 = input.exemptMinor;
  const t3 = input.blockedMinor;
  const t4 = input.taxableMinor;

  if (c1 < 0n || t1 < 0n || t2 < 0n || t3 < 0n || t4 < 0n) {
    throw new Error(
      "Rule 42 was given a negative credit figure. A negative bucket is a data " +
        "error, and apportioning it produces a reversal that increases the credit.",
    );
  }

  const attributed = t1 + t2 + t3 + t4;
  if (attributed > c1) {
    // ⚠️ NOT CLAMPED. Clamping would produce a plausible-looking working
    // that does not reconcile to any return, and the person reading it
    // would have no way to tell. The buckets are a PARTITION of the
    // period's credit; if they exceed it, a line has been counted twice
    // and the fix is upstream.
    throw new Error(
      `Rule 42 buckets total ${attributed} paise but the period's input tax is ` +
        `${c1} paise. T1+T2+T3+T4 must be a partition of C1 — a line has been ` +
        `attributed twice, or a bucket includes credit from another period.`,
    );
  }

  const c2 = c1 - (t1 + t2 + t3);
  const c3 = c2 - t4;

  /* --- D1: the exempt share ------------------------------------- */
  //
  // ⚠️ ZERO TURNOVER IS A REAL MONTH, NOT AN ERROR. A developer's first
  // months on a project have crores of purchases and no sales at all, and
  // E/F is 0/0. Rule 42(1)(g) says to use the values for the LAST tax
  // period for which they are available; where there is no such period,
  // there is nothing to apportion against and D1 is nil. Dividing anyway
  // would be a division by zero; defaulting the ratio to 1 would reverse
  // the entire common credit of a month with no exempt supply at all.
  const f = input.totalTurnoverMinor;
  const e = input.exemptTurnoverMinor;

  if (f < 0n || e < 0n) {
    throw new Error("Rule 42 was given a negative turnover.");
  }
  if (e > f) {
    throw new Error(
      `Exempt turnover (${e} paise) exceeds total turnover (${f} paise). E is a ` +
        `subset of F — an exempt supply that is not part of total turnover means ` +
        `one of the two figures is measured over a different period.`,
    );
  }

  let d1: bigint;
  let exemptRatioBps: number;

  if (f === 0n || c3 <= 0n) {
    d1 = 0n;
    exemptRatioBps = 0;
  } else {
    // ⚠️ MULTIPLY BEFORE DIVIDING, IN BIGINT. `c3 * e / f` keeps full
    // precision to the last step; `c3 * (e / f)` truncates the ratio to
    // zero for every ratio below 1 and reverses nothing at all.
    //
    // Half-up on the final division, matching `applyRateBps` and matching
    // what a person recomputing D1 by hand will do.
    const numerator = c3 * e;
    const quotient = numerator / f;
    const remainder = numerator % f;
    d1 = remainder * 2n >= f ? quotient + 1n : quotient;

    // Reported for the working only. Derived from the money, not used to
    // compute it — a bps-rounded ratio applied to C3 would not agree with
    // D1 above, and the working would contradict the figure it explains.
    const ratio = (e * 10_000n) / f;
    exemptRatioBps = Number(ratio);
  }

  /* --- D2: the deemed 5% ---------------------------------------- */
  const d2 = c3 <= 0n ? 0n : applyRateBps(c3, input.deemedNonBusinessRateBps ?? 500);

  /* --- ⭐ THE RESIDUAL ------------------------------------------ */
  const eligibleCommonMinor = c3 - d1 - d2;

  /**
   * ⚠️ THE INVARIANT, ASSERTED RATHER THAN ASSUMED.
   *
   * If this ever fires, the reversal reported to the Government and the
   * credit taken into the ledger differ by the shortfall, and nothing
   * downstream would notice: both figures are plausible, both appear in
   * different boxes of the return, and only their sum is wrong.
   *
   * It cannot fire while `eligibleCommonMinor` is a subtraction. It is
   * here for the day somebody replaces it with `c3 × (1 − E/F) − d2`,
   * which is the same thing except for the rounding, and the rounding is
   * the whole point.
   */
  const partition = t1 + t2 + t3 + t4 + d1 + d2 + eligibleCommonMinor;
  if (partition !== c1) {
    throw new Error(
      `Rule 42 does not reconcile: the buckets and reversals total ${partition} ` +
        `paise against input tax of ${c1} paise. The eligible common credit must ` +
        `be C3 − D1 − D2 by SUBTRACTION; computing it independently makes the ` +
        `reversal and the availment disagree by the rounding, and the difference ` +
        `is unexplainable at an assessment.`,
    );
  }

  return {
    c1,
    t1,
    t2,
    t3,
    c2,
    t4,
    c3,
    d1,
    d2,
    eligibleCommonMinor,
    netEligibleMinor: t4 + eligibleCommonMinor,
    totalReversalMinor: d1 + d2,
    exemptRatioBps,
  };
}

/* ------------------------------------------------------------------ */
/* HEAD-WISE                                                           */
/* ------------------------------------------------------------------ */

export type Rule42HeadInput = {
  totalCredit: TaxHeads;
  nonBusiness: TaxHeads;
  exempt: TaxHeads;
  blocked: TaxHeads;
  taxable: TaxHeads;
  exemptTurnoverMinor: bigint;
  totalTurnoverMinor: bigint;
  deemedNonBusinessRateBps?: number;
};

export type Rule42HeadResult = {
  cgst: Rule42Result;
  sgst: Rule42Result;
  igst: Rule42Result;
  cess: Rule42Result;
  /** D1 + D2 per head — what goes into GSTR-3B Table 4(B). */
  reversal: TaxHeads;
  /** T4 + eligible common per head — Table 4(A). */
  netEligible: TaxHeads;
};

/**
 * ⭐ Rule 42, four times, one per tax head.
 *
 * ⚠️ THE TURNOVER RATIO IS THE SAME FOR ALL FOUR AND THE CREDIT IS NOT.
 * E and F are facts about the period's SUPPLIES; the four heads are facts
 * about the period's PURCHASES. Running one computation on the summed
 * credit and splitting the answer by the credit ratio would give the same
 * total and the wrong four numbers, and only the four numbers go in the
 * return.
 */
export function apportionRule42ByHead(input: Rule42HeadInput): Rule42HeadResult {
  const forHead = (key: keyof TaxHeads): Rule42Result =>
    apportionRule42({
      totalCreditMinor: input.totalCredit[key],
      nonBusinessMinor: input.nonBusiness[key],
      exemptMinor: input.exempt[key],
      blockedMinor: input.blocked[key],
      taxableMinor: input.taxable[key],
      exemptTurnoverMinor: input.exemptTurnoverMinor,
      totalTurnoverMinor: input.totalTurnoverMinor,
      ...(input.deemedNonBusinessRateBps === undefined
        ? {}
        : { deemedNonBusinessRateBps: input.deemedNonBusinessRateBps }),
    });

  const cgst = forHead("cgstMinor");
  const sgst = forHead("sgstMinor");
  const igst = forHead("igstMinor");
  const cess = forHead("cessMinor");

  return {
    cgst,
    sgst,
    igst,
    cess,
    reversal: {
      cgstMinor: cgst.totalReversalMinor,
      sgstMinor: sgst.totalReversalMinor,
      igstMinor: igst.totalReversalMinor,
      cessMinor: cess.totalReversalMinor,
    },
    netEligible: {
      cgstMinor: cgst.netEligibleMinor,
      sgstMinor: sgst.netEligibleMinor,
      igstMinor: igst.netEligibleMinor,
      cessMinor: cess.netEligibleMinor,
    },
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ RULE 43 — CAPITAL GOODS, OVER SIXTY MONTHS                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ WHY CAPITAL GOODS CANNOT GO THROUGH RULE 42, AND WHY GETTING IT
 * WRONG IS ALMOST INVISIBLE.
 *
 * Rule 42 apportions the period's common credit against the period's
 * turnover. Once. Rule 43 takes a capital item's common credit, spreads
 * it over SIXTY MONTHS at Tm = Tc ÷ 60, and reverses Te = Tm × E ÷ F in
 * each of those months.
 *
 * Put a chiller through Rule 42 and the whole reversal happens in the
 * month of purchase. The total reversed over five years is roughly
 * similar if the exempt ratio never moves — so the error hides. It stops
 * hiding when the ratio DOES move, which for a developer it always does:
 * the exempt share is driven by completed-building sales, and those are
 * lumpy. The month a completed tower is sold, the correct Rule 43
 * reversal for every capital item in the company jumps; a Rule 42
 * treatment reverses nothing, because the purchase was years ago.
 */
export const RULE_43_USEFUL_LIFE_MONTHS = 60;

export type Rule43Input = {
  /** Tc — common credit on the capital item, ONE head, in paise. */
  commonCreditMinor: bigint;
  exemptTurnoverMinor: bigint;
  totalTurnoverMinor: bigint;
  /** How many of the sixty months have already been reversed. */
  monthsElapsed?: number;
};

export type Rule43Result = {
  tc: bigint;
  /** Tm = Tc ÷ 60, the monthly slice. */
  tmMinor: bigint;
  /** Te = Tm × E ÷ F, this month's reversal. */
  teMinor: bigint;
  /** Months of the useful life still to run, after this one. */
  monthsRemaining: number;
  /**
   * ⭐ The final month's slice, which absorbs the rounding.
   *
   * ⚠️ Tc ÷ 60 does not divide evenly and 59 equal slices plus a
   * remainder is the only way the sixty slices sum to Tc. Reversing
   * `Tm` sixty times leaves up to 59 paise of a capital item's credit
   * permanently unreversed or over-reversed, per item, per head —
   * invisible on any one month and cumulative across a fleet.
   */
  finalMonthTmMinor: bigint;
};

export function apportionRule43(input: Rule43Input): Rule43Result {
  const tc = input.commonCreditMinor;
  if (tc < 0n) throw new Error("Rule 43 was given a negative capital credit.");

  const months = BigInt(RULE_43_USEFUL_LIFE_MONTHS);
  const tmMinor = tc / months;
  // The residue lands entirely on the last month, so sixty slices sum to
  // Tc exactly rather than to Tc minus up to 59 paise.
  const finalMonthTmMinor = tmMinor + (tc - tmMinor * months);

  const f = input.totalTurnoverMinor;
  const e = input.exemptTurnoverMinor;
  if (f < 0n || e < 0n) throw new Error("Rule 43 was given a negative turnover.");
  if (e > f) {
    throw new Error(
      "Exempt turnover exceeds total turnover in a Rule 43 computation. E is a " +
        "subset of F.",
    );
  }

  let teMinor = 0n;
  if (f > 0n && tmMinor > 0n) {
    const numerator = tmMinor * e;
    const quotient = numerator / f;
    const remainder = numerator % f;
    teMinor = remainder * 2n >= f ? quotient + 1n : quotient;
  }

  const elapsed = Math.max(0, Math.trunc(input.monthsElapsed ?? 0));
  return {
    tc,
    tmMinor,
    teMinor,
    monthsRemaining: Math.max(0, RULE_43_USEFUL_LIFE_MONTHS - elapsed - 1),
    finalMonthTmMinor,
  };
}

/* ------------------------------------------------------------------ */
/* BUILDING THE BUCKETS FROM LINES                                     */
/* ------------------------------------------------------------------ */

export type AttributedLine = {
  rule42Attribution:
    | "exclusively_non_business"
    | "exclusively_exempt"
    | "blocked"
    | "exclusively_taxable"
    | "common";
  /** ⚠️ Capital-goods lines go to Rule 43 and are EXCLUDED from C1. */
  isCapitalGoods?: boolean;
  heads: TaxHeads;
};

export type Rule42Buckets = {
  totalCredit: TaxHeads;
  nonBusiness: TaxHeads;
  exempt: TaxHeads;
  blocked: TaxHeads;
  taxable: TaxHeads;
  /** Not a Rule 42 letter — it is C3, and it is derived, never summed. */
  commonObserved: TaxHeads;
  /** Capital lines, kept aside for Rule 43. */
  capitalCommon: TaxHeads;
};

/**
 * Fold a period's lines into the Rule 42 buckets.
 *
 * ⚠️ C1 IS THE SUM OF T1..T4 AND COMMON, AND IT IS BUILT THAT WAY RATHER
 * THAN READ FROM A TOTAL. If C1 were taken from an invoice roll-up and
 * the buckets from the lines, the two could disagree — and `apportionRule42`
 * would then throw on a discrepancy that came from the loader rather than
 * from the data. Building both from one pass makes the partition true
 * before the rule ever sees it.
 *
 * ⚠️ CAPITAL GOODS ARE EXCLUDED FROM C1 ENTIRELY. Rule 42 says "inputs
 * and input services"; capital goods are Rule 43's subject and appear in
 * `capitalCommon`. Including them would reverse in one month what the law
 * spreads over sixty.
 */
export function bucketRule42(lines: readonly AttributedLine[]): Rule42Buckets {
  const zero = (): TaxHeads => ({
    cgstMinor: 0n,
    sgstMinor: 0n,
    igstMinor: 0n,
    cessMinor: 0n,
  });

  const buckets: Rule42Buckets = {
    totalCredit: zero(),
    nonBusiness: zero(),
    exempt: zero(),
    blocked: zero(),
    taxable: zero(),
    commonObserved: zero(),
    capitalCommon: zero(),
  };

  const add = (target: TaxHeads, heads: TaxHeads): void => {
    target.cgstMinor += heads.cgstMinor;
    target.sgstMinor += heads.sgstMinor;
    target.igstMinor += heads.igstMinor;
    target.cessMinor += heads.cessMinor;
  };

  for (const line of lines) {
    if (line.isCapitalGoods === true && line.rule42Attribution === "common") {
      add(buckets.capitalCommon, line.heads);
      continue;
    }

    add(buckets.totalCredit, line.heads);

    switch (line.rule42Attribution) {
      case "exclusively_non_business":
        add(buckets.nonBusiness, line.heads);
        break;
      case "exclusively_exempt":
        add(buckets.exempt, line.heads);
        break;
      case "blocked":
        add(buckets.blocked, line.heads);
        break;
      case "exclusively_taxable":
        add(buckets.taxable, line.heads);
        break;
      case "common":
        add(buckets.commonObserved, line.heads);
        break;
    }
  }

  return buckets;
}
