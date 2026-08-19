/**
 * Ordence — ⭐⭐⭐ WAS THIS PERSON AN INSURED PERSON WHEN THE
 * CONTRIBUTION PERIOD BEGAN?
 * Version: v1.52.0-alpha · Batch 79
 *
 * Pure. `bigint` paise. No I/O, no clock. The database read that feeds
 * it lives in `server/payroll/run.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT THIS REPLACES, AND WHY IT IS NOT A ROUNDING FIX
 * ══════════════════════════════════════════════════════════════════════
 * `computeRun()` used to hand `buildPayslip()` a hardcoded
 * `esiCoveredAtPeriodStart: false`, called an approximation in a
 * comment. Under s.2(9) of the ESI Act 1948 read with reg.4 of the ESI
 * (General) Regulations 1950, contribution periods run 1 April –
 * 30 September and 1 October – 31 March, and A PERSON COVERED WHEN THE
 * PERIOD BEGINS STAYS COVERED UNTIL IT ENDS however far their wages
 * rise. The hardcoded `false` dropped them the month of the rise.
 *
 * ⚠️ The cost of that is not a mis-stated challan. It is somebody who
 * believes they have ESI cover, whose employer stopped contributing, and
 * who finds out at a hospital counter — with their dependants, whose
 * cover is derived from theirs. For the employer it is s.85B interest
 * and damages plus the benefit itself.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE EVIDENCE, AND WHY ZERO ESI ON AN OLD PAYSLIP IS A FACT
 * ══════════════════════════════════════════════════════════════════════
 * The only honest source is what this employer actually paid: the
 * employee's own payslips from APPROVED or POSTED runs earlier in the
 * same contribution period. Two readings of such a payslip are sound,
 * and both survive the old bug:
 *
 *   ⭐ ESI WAS DEDUCTED ⇒ they were an insured person that month. By
 *     reg.4 coverage entered at any point in a period runs to the end of
 *     it, so this settles the question for every later month of the
 *     period — including a mid-period joiner, who never existed on the
 *     1st of April but is just as covered from the day they came in.
 *
 *   ⭐ NO ESI, AND NOT EXEMPT ⇒ their ESI gross was ABOVE the wage
 *     limit that month. `computeEsi()` cannot return zero for wages at
 *     or under the limit — coverage there does not depend on the flag at
 *     all. So a nil ESI payslip proves the wages, whatever the buggy
 *     flag was set to. Read on the FIRST month of the coverage window,
 *     where there is nothing to carry in, that proves NON-coverage.
 *
 * 🔴 WHAT IS NOT SOUND is reading nil ESI on a LATER month as
 * non-coverage. That is precisely the shape the old bug printed: above
 * the limit in July, covered since April, nil deducted. Nil in July says
 * only "above the limit in July"; it says nothing about April. When the
 * April payslip is missing, the question is genuinely OPEN, and this
 * module says so rather than picking the convenient answer.
 */

import { contributionPeriodRange } from "@/lib/payroll/returns/esic";

/**
 * ⭐ EVERY STATE CARRIES A WORD, so a screen, a log line and a human
 * reading this six months later all get the same sentence.
 */
export type EsiCoverageBasis =
  /** ESI is not configured for the period. `buildPayslip` already blocks. */
  | "rules_missing"
  /** Marked exempt on the employee record. Coverage never arises. */
  | "exempt"
  /** The window opens inside THIS month, so this month's wages decide it. */
  | "window_opens_now"
  /** An earlier payslip in this period actually deducted ESI. */
  | "evidence_covered"
  /** The window's first month was paid, non-exempt, and deducted nothing. */
  | "evidence_not_covered"
  /** 🔴 The window's first month has no payslip. Nobody knows. */
  | "evidence_missing";

export interface EsiHistoryRow {
  /** The run's period, not the payslip's; a run is one payroll month. */
  readonly runPeriodStart: string;
  readonly runPeriodEnd: string;
  readonly employeeEsiMinor: bigint;
  readonly employerEsiMinor: bigint;
}

export interface EsiCoveragePosition {
  /** What `computeEsi({ coveredAtPeriodStart })` is given. */
  readonly coveredAtPeriodStart: boolean;
  readonly basis: EsiCoverageBasis;
  /** 1 April or 1 October, or the joining date if they came in later. */
  readonly windowStart: string;
  /**
   * ⚠️ Period ends of APPROVED or POSTED runs in this contribution
   * period that deducted nothing from somebody the evidence shows was
   * covered. Money owed under s.85B, and a correction with its own
   * trail — never a silent recompute of a posted month.
   */
  readonly underContributedPeriodEnds: readonly string[];
}

/**
 * 🔴 THE DECISION, WITH NOTHING HIDDEN IN IT.
 *
 * `history` is every payslip this employee has in APPROVED or POSTED
 * runs whose period starts on or after the contribution period's first
 * day and strictly before this run's period. Draft and cancelled runs
 * are not evidence of anything: nobody was paid from them.
 */
export function resolveEsiCoverage(args: {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly joinedOn: string;
  readonly esiExempt: boolean;
  readonly hasRules: boolean;
  readonly history: readonly EsiHistoryRow[];
}): EsiCoveragePosition {
  const { from: periodFrom } = contributionPeriodRange(args.periodEnd);

  /**
   * ⭐ THE WINDOW OPENS AT THE LATER OF THE PERIOD AND THE JOINING DATE.
   * Somebody who joined in July has no April to be covered in, and
   * hunting for one finds nothing, which reads exactly like "not
   * covered" — the failure this module exists to refuse.
   */
  const windowStart = args.joinedOn > periodFrom ? args.joinedOn : periodFrom;
  const base = { windowStart, underContributedPeriodEnds: [] as readonly string[] };

  if (!args.hasRules) return { ...base, coveredAtPeriodStart: false, basis: "rules_missing" };
  if (args.esiExempt) return { ...base, coveredAtPeriodStart: false, basis: "exempt" };

  /**
   * ⭐ THE WINDOW OPENS IN THIS VERY MONTH — 1 April, 1 October, or the
   * day they joined. There is no earlier month to carry coverage in
   * from, so this month's own wages decide it and `false` is a FACT
   * rather than the old assumption wearing the same clothes.
   */
  if (windowStart >= args.periodStart) {
    return { ...base, coveredAtPeriodStart: false, basis: "window_opens_now" };
  }

  const earlier = [...args.history]
    .filter((r) => r.runPeriodStart >= periodFrom && r.runPeriodStart < args.periodStart)
    .sort((a, b) => (a.runPeriodStart < b.runPeriodStart ? -1 : a.runPeriodStart > b.runPeriodStart ? 1 : 0));

  const paidEsi = (r: EsiHistoryRow): boolean => r.employeeEsiMinor > 0n || r.employerEsiMinor > 0n;

  /**
   * ⚠️ THE MONTH THE WINDOW OPENS IN, if it was ever paid. Only this row
   * can prove ABSENCE of coverage; every other row can only prove
   * presence.
   */
  const openingMonth = earlier.find(
    (r) => r.runPeriodStart <= windowStart && r.runPeriodEnd >= windowStart,
  );

  const covered = earlier.some(paidEsi);

  /**
   * 🔴 THE RUNS THAT ARE ALREADY WRONG. Once a month in this period
   * deducted ESI, every later month of the same period owed it too. A
   * nil month after that is an omitted contribution, and it is REPORTED,
   * not repaired here: those runs are approved or posted, the employee
   * has the payslip, and quietly changing the number destroys the trail
   * that a correction and its s.85B interest have to be defended from.
   */
  const affected: string[] = [];
  let seenCovered = false;
  for (const row of earlier) {
    if (paidEsi(row)) {
      seenCovered = true;
      continue;
    }
    if (seenCovered) affected.push(row.runPeriodEnd);
  }

  if (covered) {
    return {
      ...base,
      coveredAtPeriodStart: true,
      basis: "evidence_covered",
      underContributedPeriodEnds: affected,
    };
  }

  if (openingMonth !== undefined) {
    // ⭐ Paid, not exempt, nil ESI ⇒ ESI gross was above the limit on the
    // day the window opened. They are outside the scheme for this period.
    return { ...base, coveredAtPeriodStart: false, basis: "evidence_not_covered" };
  }

  /**
   * 🔴🔴 NO EVIDENCE. THE TWO ERRORS ARE NOT THE SAME SIZE.
   *
   * Assuming COVERED over-contributes: the employer pays 3.25% it may
   * not have owed and the employee 0.75%, both recoverable, nobody hurt.
   * Assuming NOT COVERED ends a real person's medical cover and their
   * dependants' with it, and no refund afterwards buys back the
   * treatment they did not get.
   *
   * So the default is COVERED — and it is not left to stand quietly.
   * The caller turns this word into a BLOCKING problem on the payslip
   * whenever the wages make it matter, so a human decides before anybody
   * is paid. The default exists to be the safe answer if the human ever
   * fails to arrive, not to spare them the question.
   */
  return {
    ...base,
    coveredAtPeriodStart: true,
    basis: "evidence_missing",
    underContributedPeriodEnds: affected,
  };
}

/** ⭐ Whether the flag actually changed this month's money. */
export function coverageDecidedTheMoney(esiGrossMinor: bigint, wageLimitMinor: bigint): boolean {
  return esiGrossMinor > wageLimitMinor;
}
