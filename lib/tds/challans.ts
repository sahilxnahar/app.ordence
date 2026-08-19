/**
 * Ordence — ⭐ Challans: Mapping Deductions to Deposits
 * Version: v0.36.0-alpha
 *
 * Pure. `bigint` paise, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE MAPPING IS A FIRST-CLASS THING AND NOT A REPORT
 * ══════════════════════════════════════════════════════════════════════
 * The quarterly return does not report "we deducted ₹4,00,000 and we
 * deposited ₹4,00,000". It reports, for EVERY deduction, WHICH challan
 * discharged it — by BSR code, deposit date and challan serial. The
 * Department then matches each challan against OLTAS and gives the
 * deductee credit for the deductions attached to a challan that matched.
 *
 * So a challan that is over-utilised — more tax mapped to it than was
 * ever deposited — does not produce a rounding difference. It produces a
 * return where some deductees get credit and others silently do not, and
 * the ones who do not are decided by the order the Department processes
 * records in. They ring up in October asking why their Form 26AS is
 * short, and the answer is that ₹4,00,000 of deductions were attached to
 * a ₹3,50,000 challan eight months ago.
 *
 * ⚠️ WHICH IS WHY OVER-UTILISATION IS REFUSED BY A DEFERRED CONSTRAINT
 * TRIGGER (SQL 0025 §7) AND NOT ONLY BY THIS FILE. The engine is one
 * write path. An import of a year of history is another, and an import is
 * where a hundred deductions get attached to one challan because the
 * spreadsheet had one challan column.
 */

import { formatPaise } from "./sections";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type ChallanFacts = {
  id: string;
  bsrCode: string;
  challanSerial: string;
  depositDate: string;
  /** The tax box on ITNS 281. NOT the total. */
  taxMinor: bigint;
  surchargeMinor: bigint;
  cessMinor: bigint;
  interestMinor: bigint;
  feeMinor: bigint;
  totalMinor: bigint;
};

export type MappedDeduction = {
  id: string;
  challanId: string | null;
  tdsMinor: bigint;
  surchargeMinor: bigint;
  cessMinor: bigint;
};

/**
 * ⭐ THE PART OF A CHALLAN AVAILABLE TO DISCHARGE DEDUCTIONS.
 *
 * ⚠️ INTEREST AND FEE ARE **NOT** AVAILABLE, AND LEAVING THEM IN IS THE
 * SUBTLE VERSION OF OVER-UTILISATION. A ₹1,00,000 challan carrying
 * ₹3,000 of Section 201(1A) interest discharges ₹97,000 of tax, not
 * ₹1,00,000. Reconciling against `total_minor` makes the books balance
 * perfectly while ₹3,000 of somebody's credit does not exist — and the
 * three thousand rupees of interest cannot pay anybody's tax, because
 * OLTAS keeps the boxes separate.
 */
export function challanTaxCapacityMinor(challan: ChallanFacts): bigint {
  return challan.taxMinor + challan.surchargeMinor + challan.cessMinor;
}

/* ------------------------------------------------------------------ */
/* RECONCILIATION                                                      */
/* ------------------------------------------------------------------ */

export type ChallanUtilisation = {
  challanId: string;
  bsrCode: string;
  challanSerial: string;
  depositDate: string;
  capacityMinor: bigint;
  utilisedMinor: bigint;
  /** Positive = money deposited against nothing. Negative is impossible. */
  unutilisedMinor: bigint;
  /** ⭐ How much more was mapped than deposited. Zero when healthy. */
  overUtilisedMinor: bigint;
  deductionCount: number;
  verdict: "exact" | "unutilised" | "over_utilised";
  message: string;
};

export type ChallanReconciliation = {
  utilisations: ChallanUtilisation[];

  totalDeductedMinor: bigint;
  totalMappedMinor: bigint;
  /** ⭐ Deducted, and attached to no challan at all. */
  unmappedMinor: bigint;
  unmappedCount: number;

  totalChallanCapacityMinor: bigint;
  totalUnutilisedMinor: bigint;
  totalOverUtilisedMinor: bigint;

  /** ⭐ The register and the challans agree to the paisa. */
  reconciles: boolean;
  problems: string[];
};

/**
 * ⭐ DOES THE DEDUCTION REGISTER RECONCILE TO THE CHALLANS, EXACTLY?
 *
 * Three questions, and all three have to be answered `yes`:
 *
 *   1. Is every deduction attached to a challan?
 *      An unattached one is tax we hold. It appears in no return and in
 *      no deductee's Form 26AS, and interest at 1.5% a month runs on it
 *      from the date of deduction.
 *
 *   2. ⭐ Is any challan over-utilised?
 *      More tax mapped to it than was deposited into it. See the header —
 *      this is the one that silently withholds credit from whichever
 *      deductees the Department happens to process last.
 *
 *   3. Is any challan unutilised?
 *      Money deposited against nothing. Usually a deduction that was
 *      never recorded — so the books understate the liability AND the
 *      deposit, which cancel out and look correct.
 *
 * ⚠️ `reconciles` IS EXACT. Not "within a rupee". Every figure in this
 * phase is integer paise from a rate applied by `applyRateBps`, so a
 * discrepancy is never rounding — it is a missing row, and a tolerance
 * would hide exactly the rows worth finding.
 */
export function reconcileChallans(args: {
  challans: readonly ChallanFacts[];
  deductions: readonly MappedDeduction[];
}): ChallanReconciliation {
  const byChallan = new Map<string, { minor: bigint; count: number }>();
  let totalDeductedMinor = 0n;
  let totalMappedMinor = 0n;
  let unmappedMinor = 0n;
  let unmappedCount = 0;

  for (const d of args.deductions) {
    const amount = d.tdsMinor + d.surchargeMinor + d.cessMinor;
    totalDeductedMinor += amount;
    if (amount === 0n) continue;

    if (!d.challanId) {
      unmappedMinor += amount;
      unmappedCount += 1;
      continue;
    }
    totalMappedMinor += amount;
    const bucket = byChallan.get(d.challanId) ?? { minor: 0n, count: 0 };
    bucket.minor += amount;
    bucket.count += 1;
    byChallan.set(d.challanId, bucket);
  }

  const utilisations: ChallanUtilisation[] = [];
  const problems: string[] = [];
  let totalChallanCapacityMinor = 0n;
  let totalUnutilisedMinor = 0n;
  let totalOverUtilisedMinor = 0n;

  for (const challan of args.challans) {
    const capacity = challanTaxCapacityMinor(challan);
    const used = byChallan.get(challan.id) ?? { minor: 0n, count: 0 };
    totalChallanCapacityMinor += capacity;

    const over = used.minor > capacity ? used.minor - capacity : 0n;
    const under = capacity > used.minor ? capacity - used.minor : 0n;
    totalOverUtilisedMinor += over;
    totalUnutilisedMinor += under;

    const key = `${challan.bsrCode}/${challan.depositDate}/${challan.challanSerial}`;

    let verdict: ChallanUtilisation["verdict"];
    let message: string;
    if (over > 0n) {
      verdict = "over_utilised";
      message =
        `⭐ Challan ${key} carries ${formatPaise(capacity)} of tax and ` +
        `${formatPaise(used.minor)} of deductions is mapped to it — ` +
        `${formatPaise(over)} more than was deposited. ⚠️ The return will be ` +
        `accepted and the excess deductees will get NO credit in their Form 26AS, ` +
        `chosen by nothing we control. They find out months later. Either the ` +
        `challan is short and the difference must be deposited with interest, or ` +
        `some of these deductions belong to another challan.`;
      problems.push(message);
    } else if (under > 0n) {
      verdict = "unutilised";
      message =
        `Challan ${key} has ${formatPaise(under)} of ${formatPaise(capacity)} ` +
        `unutilised — money deposited against no deduction. ⚠️ Usually a deduction ` +
        `that was never recorded, in which case the register understates the ` +
        `liability AND the deposit by the same amount, and the two cancel out on ` +
        `every total anybody looks at.`;
      problems.push(message);
    } else {
      verdict = "exact";
      message = `Challan ${key}: ${formatPaise(capacity)} deposited, fully utilised across ${used.count} deduction(s).`;
    }

    utilisations.push({
      challanId: challan.id,
      bsrCode: challan.bsrCode,
      challanSerial: challan.challanSerial,
      depositDate: challan.depositDate,
      capacityMinor: capacity,
      utilisedMinor: used.minor,
      unutilisedMinor: under,
      overUtilisedMinor: over,
      deductionCount: used.count,
      verdict,
      message,
    });
  }

  /* --- ⭐ Deductions pointing at a challan we were not given ------ */
  for (const [challanId, used] of byChallan) {
    if (args.challans.some((c) => c.id === challanId)) continue;
    totalOverUtilisedMinor += used.minor;
    problems.push(
      `${formatPaise(used.minor)} of deductions is mapped to challan ${challanId}, ` +
        `which is not in this period's challan list. ⚠️ Either the challan belongs ` +
        `to another quarter — in which case the deductions do too — or it has been ` +
        `deleted, and the deposit backing them no longer exists anywhere.`,
    );
  }

  if (unmappedCount > 0) {
    problems.push(
      `⭐ ${formatPaise(unmappedMinor)} of tax across ${unmappedCount} deduction(s) ` +
        `is attached to NO challan. That is money we deducted and are holding. It ` +
        `appears in no return and in no deductee's Form 26AS, and interest under ` +
        `Section 201(1A)(ii) runs on it at 1.5% per month or part of a month FROM ` +
        `THE DATE OF DEDUCTION — not from the due date.`,
    );
  }

  const reconciles =
    unmappedMinor === 0n &&
    totalOverUtilisedMinor === 0n &&
    totalUnutilisedMinor === 0n &&
    totalMappedMinor === totalChallanCapacityMinor;

  return {
    utilisations,
    totalDeductedMinor,
    totalMappedMinor,
    unmappedMinor,
    unmappedCount,
    totalChallanCapacityMinor,
    totalUnutilisedMinor,
    totalOverUtilisedMinor,
    reconciles,
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* ALLOCATION                                                          */
/* ------------------------------------------------------------------ */

export type AllocationResult = {
  /** Deduction id → challan id. */
  assignments: Array<{ deductionId: string; challanId: string; amountMinor: bigint }>;
  /** Deductions no challan had room for. */
  unallocated: Array<{ deductionId: string; amountMinor: bigint; reason: string }>;
  /** Capacity left, per challan. */
  remaining: Array<{ challanId: string; remainingMinor: bigint }>;
};

/**
 * Attach a quarter's unmapped deductions to its challans.
 *
 * ⚠️ IT NEVER SPLITS A DEDUCTION ACROSS TWO CHALLANS, and that is a
 * statement about the return format rather than a simplification. A
 * deductee record in the quarterly statement carries ONE challan
 * reference; a deduction spanning two challans has to be recorded as two
 * deductions, because that is what the file will contain. Splitting it
 * silently here would produce a mapping that cannot be filed.
 *
 * ⚠️ AND IT LEAVES THE REMAINDER UNALLOCATED RATHER THAN FORCING IT. A
 * deduction that fits nowhere is a real finding — the challan is short —
 * and the honest output is "this ₹4,000 has nowhere to go", not a
 * mapping that over-utilises a challan and passes.
 *
 * Deterministic: challans in deposit-date order, deductions largest
 * first. The same inputs give the same answer on every run, which matters
 * because a re-run that reshuffles the mapping changes which deductee
 * appears against which challan in a return that has already been filed.
 */
export function allocateToChallans(args: {
  challans: readonly ChallanFacts[];
  deductions: readonly MappedDeduction[];
}): AllocationResult {
  const remaining = new Map<string, bigint>();
  const ordered = [...args.challans].sort((a, b) =>
    a.depositDate === b.depositDate
      ? a.challanSerial.localeCompare(b.challanSerial)
      : a.depositDate.localeCompare(b.depositDate),
  );
  for (const c of ordered) {
    remaining.set(c.id, challanTaxCapacityMinor(c));
  }
  // Already-mapped deductions consume capacity first.
  for (const d of args.deductions) {
    if (!d.challanId) continue;
    const amount = d.tdsMinor + d.surchargeMinor + d.cessMinor;
    const left = remaining.get(d.challanId);
    if (left !== undefined) remaining.set(d.challanId, left - amount);
  }

  const pending = args.deductions
    .filter((d) => !d.challanId && d.tdsMinor + d.surchargeMinor + d.cessMinor > 0n)
    .sort((a, b) => {
      const av = a.tdsMinor + a.surchargeMinor + a.cessMinor;
      const bv = b.tdsMinor + b.surchargeMinor + b.cessMinor;
      return bv > av ? 1 : bv < av ? -1 : a.id.localeCompare(b.id);
    });

  const assignments: AllocationResult["assignments"] = [];
  const unallocated: AllocationResult["unallocated"] = [];

  for (const d of pending) {
    const amount = d.tdsMinor + d.surchargeMinor + d.cessMinor;
    const fit = ordered.find((c) => (remaining.get(c.id) ?? 0n) >= amount);
    if (!fit) {
      unallocated.push({
        deductionId: d.id,
        amountMinor: amount,
        reason:
          `No challan in this quarter has ${formatPaise(amount)} of unutilised ` +
          `capacity. ⚠️ Either a challan is missing, or the tax on this deduction ` +
          `was never deposited — in which case it is accruing interest at 1.5% a ` +
          `month from the date of deduction and the deductee will get no credit.`,
      });
      continue;
    }
    remaining.set(fit.id, (remaining.get(fit.id) ?? 0n) - amount);
    assignments.push({ deductionId: d.id, challanId: fit.id, amountMinor: amount });
  }

  return {
    assignments,
    unallocated,
    remaining: [...remaining.entries()].map(([challanId, remainingMinor]) => ({
      challanId,
      remainingMinor,
    })),
  };
}
