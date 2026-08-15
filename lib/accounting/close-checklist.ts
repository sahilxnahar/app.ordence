/**
 * Ordence — ⭐⭐⭐ WHAT HAS TO BE TRUE BEFORE A MONTH IS SEALED
 * Version: v1.27.0-alpha · Batch 19
 *
 * Pure and isomorphic. Money is `bigint` paise throughout.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CLOSING A PERIOD IS AN ATTESTATION, AND ORDENCE HAS BEEN LETTING
 *    PEOPLE MAKE A FALSE ONE
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/periods.ts` has been careful about this since v0.5.0.
 * It requires a permission the Accountant deliberately does not hold, it
 * verifies that the period BALANCES before sealing, it snapshots every
 * ledger balance, and a reopen needs a written reason and produces a
 * critical audit record.
 *
 * ⚠️ AND IT HAS NEVER ASKED THE ONE QUESTION THAT MATTERS MOST: IS
 * ANYTHING FROM THIS MONTH STILL NOT IN THE BOOKS?
 *
 * A period with eleven unposted July documents balances perfectly. Zero
 * equals zero. The books are internally consistent and incomplete, and
 * the seal says they are final.
 *
 * 🔴 AND THE PERIOD LOCK THEN MAKES IT PERMANENT. `0073` refuses any
 * posting dated into a closed period — correctly — so those eleven
 * documents can now never be posted where they belong. The remedies are
 * both bad: reopen the month (a critical audit event that says somebody
 * sealed books they should not have), or date the entries into a month
 * they did not happen in.
 *
 * ⭐ SO THE CHECK BELONGS BEFORE THE SEAL, WHICH IS THE ONLY MOMENT IT
 *   COSTS NOTHING.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO CATEGORIES, AND CONFUSING THEM IS HOW A CHECK GETS OVERRIDDEN
 * ══════════════════════════════════════════════════════════════════════
 *   BLOCKING  — something dated in this period exists and is not in the
 *               ledger. Sealing makes it unpostable. There is no version
 *               of this that is fine.
 *   ADVISORY  — something is worth looking at and does not make the
 *               attestation false. An unfiled return, a refund nobody
 *               has paid. Real, and not a reason to refuse.
 *
 * A check that treats those the same gets overridden the first week, and
 * an override that becomes routine is worse than no check — it converts
 * a refusal into a click and leaves a record saying somebody considered
 * it.
 */

export type CloseBlockerSeverity = "blocking" | "advisory";

export type CloseBlocker = {
  key: string;
  /** The module the documents live in. */
  source: string;
  severity: CloseBlockerSeverity;
  /** How many documents. Zero-count blockers are never constructed. */
  count: number;
  headline: string;
  /** What sealing the period would do to these. */
  consequence: string;
  where: string;
  /** Total value where it is known and meaningful. */
  amountMinor: bigint | null;
  /** The oldest document date in the set, so "how far back" has an answer. */
  oldest: string | null;
};

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export type CloseVerdict = {
  /** True when nothing blocking remains. Advisories never block. */
  ready: boolean;
  blocking: CloseBlocker[];
  advisory: CloseBlocker[];
  /** Documents that would become unpostable. The number that matters. */
  strandedCount: number;
  headline: string;
  /**
   * ⚠️ WHAT AN OVERRIDE WOULD ACTUALLY DO, in a sentence, for the
   * confirmation. Not "are you sure" — a description of the outcome.
   */
  overrideWarning: string | null;
};

export function closeVerdict(blockers: readonly CloseBlocker[]): CloseVerdict {
  /**
   * ⚠️ SORTED BY COUNT WITHIN A CATEGORY, not by source name. The
   * module with forty stranded documents is the one somebody should
   * open first, and alphabetical order puts `brokerage` above it
   * because of how it is spelt.
   */
  const bySize = (a: CloseBlocker, b: CloseBlocker) =>
    b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  const blocking = blockers.filter((b) => b.severity === "blocking").sort(bySize);
  const advisory = blockers.filter((b) => b.severity === "advisory").sort(bySize);
  const strandedCount = blocking.reduce((sum, b) => sum + b.count, 0);

  if (blocking.length === 0) {
    return {
      ready: true,
      blocking,
      advisory,
      strandedCount: 0,
      headline:
        advisory.length === 0
          ? "Everything dated in this period is in the ledger. Ready to close."
          : `Everything dated in this period is in the ledger. ${advisory.length} thing${advisory.length === 1 ? "" : "s"} worth a look first, none of which stops the close.`,
      overrideWarning: null,
    };
  }

  return {
    ready: false,
    blocking,
    advisory,
    strandedCount,
    headline:
      `${strandedCount} document${strandedCount === 1 ? "" : "s"} dated in this period ` +
      `${strandedCount === 1 ? "has" : "have"} never reached the ledger. ` +
      `Closing now would seal books that are missing ${strandedCount === 1 ? "it" : "them"}.`,
    /**
     * ⭐ THE OVERRIDE TEXT NAMES THE CONSEQUENCE AND THE REMEDY, and it
     * is deliberately not reassuring. The existing unbalanced-close
     * override says "close with an explicit override"; this one has to
     * be harder to click, because an unbalanced period is VISIBLE on
     * every report and a missing entry is not visible anywhere.
     */
    overrideWarning:
      `Closing anyway will make ${strandedCount === 1 ? "this document" : `these ${strandedCount} documents`} ` +
      `impossible to post to the month ${strandedCount === 1 ? "it belongs" : "they belong"} in. ` +
      `The period lock will refuse ${strandedCount === 1 ? "it" : "them"}, and the only ways out are ` +
      `reopening the month — which is a critical audit event — or dating ${strandedCount === 1 ? "it" : "them"} ` +
      `into a month ${strandedCount === 1 ? "it" : "they"} did not happen in.`,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ THE SUMMARY LINE                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ IT NAMES THE MODULES, NOT JUST THE TOTAL. "3 documents unposted" is
 * a number somebody has to go hunting for. "3 unposted: 2 sales
 * invoices, 1 RA bill" is a morning's work already allocated.
 */
export function describeStranded(blocking: readonly CloseBlocker[]): string {
  if (blocking.length === 0) return "Nothing is stranded.";
  return blocking
    .map((b) => `${b.count} ${b.source}${b.count === 1 ? "" : "s"}`)
    .join(", ");
}

/* ------------------------------------------------------------------ */
/* PERIOD SHAPE                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ AN INCLUSIVE END DATE, because that is what `financial_periods`
 * stores and what the existing close query compares against. This
 * function exists so the readiness check and the close itself cannot
 * disagree about which days are in the period — which they would, the
 * first time one of them was rewritten to use a half-open window.
 */
export function periodContains(
  period: { startDate: string; endDate: string },
  day: string,
): boolean {
  return day >= period.startDate && day <= period.endDate;
}

/**
 * ⭐ A CLOSE IS ONLY MEANINGFUL ONCE THE PERIOD HAS ENDED.
 *
 * ⚠️ Sealing a month that is still running is not a smaller mistake than
 * sealing one with unposted documents — it is the same mistake with a
 * guaranteed outcome, because everything that happens for the rest of
 * the month is stranded by construction.
 */
export function periodHasEnded(
  period: { endDate: string },
  today: string,
): boolean {
  return today > period.endDate;
}
