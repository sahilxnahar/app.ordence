/**
 * Ordence — ⭐⭐ COURT FEES — THE STRUCTURE, DELIBERATELY WITHOUT THE RATES
 * Version: v1.8.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 ORDENCE SHIPS NO COURT FEE RATES, AND THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * Court fees are a **State** subject. The Court Fees Act 1870 still runs
 * in some States; Maharashtra has the **Bombay Court Fees Act 1959**;
 * Tamil Nadu, Kerala, Karnataka, Rajasthan, Punjab and others each have
 * their own Act, their own Schedules, their own ad valorem slabs and
 * their own maximum. High Courts add rules on top. Amendments arrive
 * every few budgets and are not announced anywhere a software vendor
 * reliably sees.
 *
 * ⚠️ **A stale slab is worse than no slab.** A firm that types the fee
 * from the schedule on the registry wall gets it right. A firm that
 * accepts a number Ordence computed from a Maharashtra table shipped
 * eighteen months ago, while filing in Bengaluru, gets it wrong — and
 * finds out when the plaint is returned for deficit court fee, which
 * costs the filing date, which can cost the limitation.
 *
 * ⭐ So this file computes a fee **from slabs the tenant entered**, shows
 * its working, and ships none of its own. The tenant types their
 * schedule once from the Act; Ordence does the arithmetic and remembers
 * it. That is the honest division of labour.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE VALUATION IS NOT THE CLAIM AMOUNT
 * ══════════════════════════════════════════════════════════════════════
 * The fee is computed on the **value of the suit for the purposes of
 * court fees and jurisdiction** — a statutory valuation under the Suits
 * Valuation Act and the relevant Court Fees Act. For a money suit it
 * usually equals the amount claimed. For a declaration, an injunction, a
 * partition, a specific performance suit or a suit for possession it
 * very often does not, and the difference is the whole subject of a
 * preliminary objection.
 *
 * ⭐ `legal_matters.suit_valuation_minor` is therefore its own column and
 * not an alias for the claim.
 */

export class CourtFeeError extends Error {}

/* ------------------------------------------------------------------ */
/* HOW A SCHEDULE IS SHAPED                                            */
/* ------------------------------------------------------------------ */

export type CourtFeeBasis =
  /** A flat sum, whatever the value. Most applications and appeals from orders. */
  | "fixed"
  /**
   * A percentage of the valuation, usually in bands, usually capped.
   * Article 1 of Schedule I in most State Acts.
   */
  | "ad_valorem"
  /** ⚠️ Neither — the fee is worked out under a rule the software cannot model. */
  | "manual";

export const COURT_FEE_BASES: readonly CourtFeeBasis[] = [
  "fixed",
  "ad_valorem",
  "manual",
] as const;

/**
 * One band of an ad valorem schedule.
 *
 * ⭐ Half-open: `fromMinor` inclusive, `uptoMinor` exclusive, with the
 * last band open-ended (`uptoMinor: null`) — the same convention the rate
 * card slabs have used since 0034, so there is one answer in the product
 * to "which band is ₹5,00,000 in".
 */
export type CourtFeeSlab = {
  fromMinor: bigint;
  uptoMinor: bigint | null;
  /**
   * Percentage in basis points applied to the portion of the valuation
   * falling in this band. 750 = 7.5%.
   */
  rateBps: number;
  /** A flat sum added for this band, where the Act expresses it that way. */
  addMinor?: bigint;
};

export type CourtFeeSchedule = {
  /** "Bombay Court Fees Act 1959, Schedule I, Article 1" — the tenant's words. */
  statuteRef: string;
  basis: CourtFeeBasis;
  /** For `fixed`. */
  fixedMinor?: bigint | null;
  /** For `ad_valorem`. */
  slabs?: readonly CourtFeeSlab[];
  /** 🔴 The maximum fee. Most State Acts have one and it bites on large suits. */
  maximumMinor?: bigint | null;
  /** A minimum, where the Act sets one. */
  minimumMinor?: bigint | null;
  /**
   * ⚠️ Some Acts require the fee to be rounded up to the next multiple of
   * ten rupees. Expressed in minor units; 1000 = ₹10.
   */
  roundUpToMinor?: bigint | null;
};

/* ------------------------------------------------------------------ */
/* VALIDATION — because a schedule with a hole in it is silent          */
/* ------------------------------------------------------------------ */

export type SlabProblem = { index: number; message: string };

/**
 * 🔴 A GAP IN A SCHEDULE DOES NOT THROW, IT UNDER-CHARGES.
 *
 * ⚠️ Bands entered as 0–1,00,000 and 2,00,000–upwards look fine on a
 * screen and quietly compute a fee on ₹1,50,000 as though the middle
 * lakh did not exist. So the slabs are validated as a set, and 0059
 * enforces the same thing with a deferrable constraint trigger — the
 * same shape as `ordence_validate_rate_slabs` in 0057.
 */
export function validateCourtFeeSlabs(slabs: readonly CourtFeeSlab[]): SlabProblem[] {
  const problems: SlabProblem[] = [];
  if (slabs.length === 0) {
    return [{ index: -1, message: "An ad valorem schedule needs at least one band." }];
  }

  const sorted = [...slabs].sort((a, b) => (a.fromMinor < b.fromMinor ? -1 : a.fromMinor > b.fromMinor ? 1 : 0));

  const first = sorted[0];
  if (first === undefined) {
    return [{ index: -1, message: "An ad valorem schedule needs at least one band." }];
  }
  if (first.fromMinor !== 0n) {
    problems.push({
      index: 0,
      message: `The first band must start at zero. It starts at ${first.fromMinor} minor units, so any valuation below that computes no fee at all.`,
    });
  }

  let openEnded = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s === undefined) continue;
    if (!Number.isInteger(s.rateBps) || s.rateBps < 0 || s.rateBps > 10000) {
      problems.push({ index: i, message: "A rate must be an integer between 0 and 10000 basis points." });
    }
    if (s.uptoMinor === null) {
      openEnded += 1;
      if (i !== sorted.length - 1) {
        problems.push({ index: i, message: "Only the last band may be open-ended." });
      }
      continue;
    }
    if (s.uptoMinor <= s.fromMinor) {
      problems.push({ index: i, message: "A band must end after it starts." });
      continue;
    }
    const next = sorted[i + 1];
    if (next === undefined) continue;
    if (next.fromMinor > s.uptoMinor) {
      problems.push({
        index: i,
        message: `Gap: this band ends at ${s.uptoMinor} and the next starts at ${next.fromMinor}. A valuation in between would be charged nothing.`,
      });
    } else if (next.fromMinor < s.uptoMinor) {
      problems.push({
        index: i,
        message: `Overlap: this band ends at ${s.uptoMinor} and the next starts at ${next.fromMinor}. The same rupee would be charged twice.`,
      });
    }
  }

  if (openEnded === 0) {
    const last = sorted[sorted.length - 1];
    problems.push({
      index: sorted.length - 1,
      message: `The top band must be open-ended, or a suit valued above ${
        last?.uptoMinor ?? 0n
      } computes no fee on the excess. Most State Acts cap the fee instead — set a maximum and leave the top band open.`,
    });
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* THE COMPUTATION, WITH ITS WORKING                                   */
/* ------------------------------------------------------------------ */

export type CourtFeeStep = {
  label: string;
  amountMinor: bigint;
};

export type CourtFeeResult = {
  feeMinor: bigint;
  /** ⭐ Shown on the screen. A number nobody can check is a number nobody trusts. */
  steps: readonly CourtFeeStep[];
  /** True where the statutory maximum bit. */
  cappedAtMaximum: boolean;
  statuteRef: string;
  notes: readonly string[];
};

/**
 * ⭐ Ad valorem fee, band by band, on the portion of the valuation
 * falling in each band.
 *
 * ⚠️ Some State Acts apply a single rate to the WHOLE valuation once it
 * crosses a band, rather than slicing it. That is a different rule and
 * this function does not model it — a schedule of that shape should be
 * entered as `manual`, and the screen says so rather than quietly
 * producing a slice-wise answer that is too low.
 */
export function computeCourtFee(args: {
  schedule: CourtFeeSchedule;
  valuationMinor: bigint;
}): CourtFeeResult {
  const { schedule, valuationMinor } = args;
  if (valuationMinor < 0n) {
    throw new CourtFeeError("A suit valuation cannot be negative.");
  }
  const notes: string[] = [];
  const steps: CourtFeeStep[] = [];

  if (schedule.basis === "manual") {
    throw new CourtFeeError(
      "This schedule is marked as worked out by hand. Ordence will not compute it — enter the fee from the Act.",
    );
  }

  let fee = 0n;

  if (schedule.basis === "fixed") {
    const fixed = schedule.fixedMinor;
    if (fixed === null || fixed === undefined) {
      throw new CourtFeeError("A fixed schedule needs a fixed amount.");
    }
    if (fixed < 0n) throw new CourtFeeError("A court fee cannot be negative.");
    fee = fixed;
    steps.push({ label: "Fixed fee under the schedule", amountMinor: fixed });
  } else {
    const slabs = schedule.slabs ?? [];
    const problems = validateCourtFeeSlabs(slabs);
    if (problems.length > 0) {
      throw new CourtFeeError(
        `This schedule cannot be used: ${problems.map((p) => p.message).join(" ")}`,
      );
    }
    const sorted = [...slabs].sort((a, b) =>
      a.fromMinor < b.fromMinor ? -1 : a.fromMinor > b.fromMinor ? 1 : 0,
    );
    for (const s of sorted) {
      if (valuationMinor <= s.fromMinor) break;
      const bandTop = s.uptoMinor === null ? valuationMinor : (valuationMinor < s.uptoMinor ? valuationMinor : s.uptoMinor);
      const portion = bandTop - s.fromMinor;
      if (portion <= 0n) continue;
      const onPortion = (portion * BigInt(s.rateBps)) / 10000n;
      const add = s.addMinor ?? 0n;
      fee += onPortion + add;
      steps.push({
        label:
          s.uptoMinor === null
            ? `${(s.rateBps / 100).toFixed(2)}% on the excess above ${s.fromMinor / 100n}`
            : `${(s.rateBps / 100).toFixed(2)}% on the slice from ${s.fromMinor / 100n} to ${bandTop / 100n}`,
        amountMinor: onPortion + add,
      });
    }
  }

  let capped = false;
  const max = schedule.maximumMinor;
  if (max !== null && max !== undefined && fee > max) {
    steps.push({ label: "Reduced to the statutory maximum", amountMinor: max - fee });
    fee = max;
    capped = true;
    notes.push(
      "⭐ The statutory maximum applies. Above this valuation the fee does not rise, which is why very large money suits are cheaper to file than their size suggests.",
    );
  }

  const min = schedule.minimumMinor;
  if (min !== null && min !== undefined && fee < min) {
    steps.push({ label: "Raised to the statutory minimum", amountMinor: min - fee });
    fee = min;
  }

  const round = schedule.roundUpToMinor;
  if (round !== null && round !== undefined && round > 0n) {
    const remainder = fee % round;
    if (remainder !== 0n) {
      const up = round - remainder;
      steps.push({ label: `Rounded up to the next multiple of ${round / 100n}`, amountMinor: up });
      fee += up;
    }
  }

  notes.push(
    "🔴 Check this against the schedule on the registry wall before the plaint is filed. Ordence computed it from the bands somebody in this firm typed in, and a plaint returned for deficit court fee loses its filing date.",
  );

  return { feeMinor: fee, steps, cappedAtMaximum: capped, statuteRef: schedule.statuteRef, notes };
}

/* ------------------------------------------------------------------ */
/* GETTING IT BACK                                                     */
/* ------------------------------------------------------------------ */

export type SettlementRoute =
  /** Award of a Lok Adalat under the Legal Services Authorities Act 1987. */
  | "lok_adalat"
  /** The court referred the parties to mediation under s.89 CPC. */
  | "court_referred_mediation"
  /** The court referred the parties to conciliation or arbitration under s.89 CPC. */
  | "court_referred_arbitration"
  /** ⚠️ The parties settled privately and then applied to withdraw. */
  | "private_settlement"
  /** Withdrawn for some other reason. */
  | "withdrawal";

export const SETTLEMENT_ROUTES: readonly SettlementRoute[] = [
  "lok_adalat",
  "court_referred_mediation",
  "court_referred_arbitration",
  "private_settlement",
  "withdrawal",
] as const;

export type RefundEntitlement = {
  /** `full`, `none`, or — most often — `state_specific`. */
  verdict: "full" | "none" | "state_specific";
  citation: string;
  reason: string;
  /** ⚠️ True where the firm must read its own State's Act to be sure. */
  checkStateAct: boolean;
  notes: readonly string[];
};

/**
 * ⭐⭐ WHETHER THE COURT FEE COMES BACK, WHICH DEPENDS ON HOW THE CASE
 *     ENDED AND ON WHICH STATE IT ENDED IN.
 *
 * 🔴 The Supreme Court decided this on **20 December 2024** in
 * *Sanjeevkumar Harakchand Kankariya v. Union of India* (2024 INSC 1004)
 * and the answer surprised people: **a Lok Adalat award and a mediated
 * settlement are not the same thing** and cannot be equated. A Lok Adalat
 * award carries a statutory refund of the full fee under **s.21 of the
 * Legal Services Authorities Act 1987**. A mediation settlement does not
 * get that refund by reading the LSA Act across — it gets whatever the
 * **State's own Court Fees Act** gives it, which in Maharashtra (after
 * the 2018 amendment to the Bombay Court Fees Act 1959) is a full
 * refund, and elsewhere may be nothing.
 *
 * ⚠️ So the honest answer for mediation is *"depends on your State"*, and
 * that is what this returns. A product that answers "full refund"
 * everywhere is telling a Karnataka firm something the Supreme Court has
 * specifically declined to say.
 */
export function refundEntitlement(args: {
  route: SettlementRoute;
  /** The tenant's own statute, where they have recorded it. */
  stateStatuteRef?: string | null;
}): RefundEntitlement {
  const where = args.stateStatuteRef ? ` (${args.stateStatuteRef})` : "";

  switch (args.route) {
    case "lok_adalat":
      return {
        verdict: "full",
        citation: "s.21, Legal Services Authorities Act 1987",
        reason:
          "Where a case is settled by an award of a Lok Adalat the whole of the court fee paid is refunded. This one is statutory, central, and does not depend on the State Act.",
        checkStateAct: false,
        notes: [
          "⭐ This is the cleanest route to a refund and it is why counsel often move a settled matter to the Lok Adalat rather than filing a compromise in court.",
        ],
      };

    case "court_referred_mediation":
      return {
        verdict: "state_specific",
        citation: `s.16 Court Fees Act 1870 or the State's own Court Fees Act${where}; Sanjeevkumar Harakchand Kankariya v. Union of India (2024) INSC 1004`,
        reason:
          "Where the court referred the parties to mediation under s.89 CPC and they settled, s.16 of the Court Fees Act 1870 gives back the full fee — but the 1870 Act has been replaced in several States. The Supreme Court held on 20 December 2024 that a mediation settlement cannot be equated with a Lok Adalat award and does not get the s.21 LSA Act refund by extension; what it gets is whatever the State's own Act gives.",
        checkStateAct: true,
        notes: [
          "🔴 Maharashtra amended the Bombay Court Fees Act 1959 in 2018 to give the full refund on any s.89 mode. Not every State has.",
          "⚠️ Claim it. The refund is not automatic — it is applied for, and the limitation for a refund application is its own deadline.",
        ],
      };

    case "court_referred_arbitration":
      return {
        verdict: "state_specific",
        citation: `s.16 Court Fees Act 1870 or the State's own Court Fees Act${where}`,
        reason:
          "A reference to arbitration or conciliation is one of the s.89 CPC modes, so s.16 reaches it on the same footing as mediation — subject to the same question of which Act applies in the State.",
        checkStateAct: true,
        notes: [],
      };

    case "private_settlement":
      return {
        verdict: "state_specific",
        citation: `s.16 Court Fees Act 1870${where}`,
        reason:
          "The parties settled out of court and then came back to withdraw. Whether s.16 reaches a settlement the court never referred is genuinely contested — some High Courts have read s.89 as covering any settlement the court later finds was lawfully arrived at, and the Supreme Court's 2024 reasoning on Lok Adalats has been read both ways since.",
        checkStateAct: true,
        notes: [
          "⭐ There is a practical answer that avoids the argument: ask the court to refer the matter to mediation or Lok Adalat and record the settlement there. It costs one date and removes the question.",
          "⚠️ Do not promise the client this refund before it is received.",
        ],
      };

    case "withdrawal":
      return {
        verdict: "none",
        citation: "s.16 applies only to a settlement through one of the s.89 CPC modes",
        reason:
          "A plaint simply withdrawn is not a settlement through a s.89 mode, and the court fee is not refundable. There are narrow exceptions in some State Acts for a plaint returned or rejected before service.",
        checkStateAct: true,
        notes: [
          "⚠️ Where the plaint was returned for want of jurisdiction, most State Acts allow the fee to be used again or refunded. That is a different provision from s.16.",
        ],
      };
  }
}
