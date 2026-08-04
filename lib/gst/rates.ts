/**
 * Ordence — ⭐ Rate Resolution By Date
 * Version: v0.32.0-alpha
 *
 * Pure. No database import — the caller loads the rate history for a code
 * and hands it in. That is what makes this testable without a Postgres,
 * and it is also what lets a rate history be validated in a form before
 * anything is written.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE ONE RULE THIS FILE ENFORCES
 * ══════════════════════════════════════════════════════════════════════
 *     A HISTORICAL DOCUMENT KEEPS THE RATE THAT APPLIED ON ITS DATE.
 *
 * There is no function here that returns "the rate" for a code. Every
 * entry point takes a date, because the version that did not — a
 * `defaultRateBps` column read by the renderer — is the defect this
 * phase exists to make impossible.
 *
 * What that defect looks like when it happens: somebody updates the
 * under-construction residential rate from 12% to 5% in the master, and
 * every invoice raised before April 2019 re-renders at 5%. No exception,
 * no log line, no failing test. The PDF the buyer downloads stops
 * matching the one they were sent, the GSTR-1 reconciliation fails for a
 * whole quarter, and it is found during an assessment two years later.
 *
 * ══════════════════════════════════════════════════════════════════════
 * HALF-OPEN INTERVALS: [effectiveFrom, effectiveTo)
 * ══════════════════════════════════════════════════════════════════════
 * `effectiveFrom` is INCLUSIVE and `effectiveTo` is EXCLUSIVE. The 12%
 * period is [2017-07-01, 2019-04-01) and the 5% period is [2019-04-01,
 * null). An invoice dated exactly 2019-04-01 is a 5% invoice.
 *
 * The alternative — both ends inclusive — makes the changeover day belong
 * to two periods, and every rate change in the country happens on a day
 * somebody raises invoices. Half-open is the only convention where "the
 * old rate ends when the new one starts" is expressible without an
 * off-by-one day.
 */

import { toCivilDay } from "./constants";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

/**
 * One notification period. Shaped to be constructible straight from a
 * `hsn_sac_rates` row (dates arrive as `YYYY-MM-DD` strings from the
 * `date` column) and equally from a form.
 */
export type DatedRate = {
  id: string;
  rateBps: number;
  cessRateBps: number;
  /** Specific cess in paise per unit of quantity. */
  cessPerUnitMinor: bigint;
  /** Inclusive. `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** Exclusive, or null for "still current". `YYYY-MM-DD`. */
  effectiveTo: string | null;
  notificationRef?: string | null;
  itcEligible?: boolean;
  reverseCharge?: boolean;
};

export type RateProblem = {
  message: string;
  remedy: string;
};

/* ------------------------------------------------------------------ */
/* RESOLUTION                                                          */
/* ------------------------------------------------------------------ */

/**
 * The rate in force for `on`, or null if the code was not rated that day.
 *
 * ⚠️ NULL IS A REAL ANSWER AND MUST NOT BE COERCED TO ZERO. A code with
 * no rate on the document's date means either the classification did not
 * exist yet or somebody has left a hole in the history. Defaulting to 0%
 * would raise a zero-tax invoice that looks deliberate; the caller has to
 * decide, and `describeMissingRate` gives it something to say.
 */
export function resolveRateOn(
  rates: readonly DatedRate[],
  on: Date | string,
): DatedRate | null {
  const day = toCivilDay(on);

  // Ordering by `effectiveFrom` descending and taking the first match
  // means that if the history DOES overlap — which the database's EXCLUDE
  // constraint forbids, but an unsaved form can still contain — the most
  // recently commenced period wins. Deterministic beats arbitrary.
  const candidates = rates
    .filter((rate) => coversDay(rate, day))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));

  return candidates[0] ?? null;
}

/** Does this period cover the given civil day? Half-open. */
export function coversDay(rate: DatedRate, day: string): boolean {
  if (day < rate.effectiveFrom) return false;
  if (rate.effectiveTo !== null && day >= rate.effectiveTo) return false;
  return true;
}

export function describeMissingRate(code: string, on: Date | string): RateProblem {
  const day = toCivilDay(on);
  return {
    message: `No GST rate is recorded for ${code} on ${day}.`,
    remedy:
      `Add the rate that applied on ${day} to the rate history for ${code}. ` +
      `Do not change an existing period to cover this date unless the existing ` +
      `period is genuinely wrong — an invoice already raised under it keeps the ` +
      `rate it was raised at, and moving the period underneath it would restate ` +
      `a document that has already been filed.`,
  };
}

/* ------------------------------------------------------------------ */
/* HISTORY VALIDATION                                                  */
/* ------------------------------------------------------------------ */

/**
 * Check a proposed rate history before it is written.
 *
 * The database has an EXCLUDE constraint that refuses overlaps outright
 * (SQL Section 4). This exists so the form can say WHICH two periods
 * clash and by how much, rather than surfacing
 * `conflicting key value violates exclusion constraint`.
 *
 * ⚠️ A GAP IS A WARNING, NOT AN ERROR. Rate histories legitimately have
 * holes: a classification may have been unrated before GST commenced on
 * 1 July 2017, or introduced part-way through. Refusing a gap would stop
 * somebody entering a correct history. Refusing an OVERLAP is different —
 * two rates valid on one day means the invoice raised that day could
 * carry either, decided by a sort order.
 */
export function validateRateHistory(rates: readonly DatedRate[]): {
  errors: RateProblem[];
  warnings: RateProblem[];
} {
  const errors: RateProblem[] = [];
  const warnings: RateProblem[] = [];

  for (const rate of rates) {
    if (!Number.isInteger(rate.rateBps) || rate.rateBps < 0 || rate.rateBps > 10_000) {
      errors.push({
        message: `A rate of ${rate.rateBps} basis points is not a GST rate.`,
        remedy: "Enter the rate in basis points: 5% is 500, 18% is 1800.",
      });
    }
    if (rate.effectiveTo !== null && rate.effectiveTo <= rate.effectiveFrom) {
      errors.push({
        message: `A period running ${rate.effectiveFrom} → ${rate.effectiveTo} applies for no days at all.`,
        remedy:
          "A rate period ends the day the next one begins, and the end date is " +
          "exclusive. Make the end date later than the start date.",
      });
    }
  }

  const ordered = [...rates].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );

  let openEnded = 0;
  for (const rate of ordered) if (rate.effectiveTo === null) openEnded += 1;
  if (openEnded > 1) {
    errors.push({
      message: `${openEnded} rate periods are open-ended.`,
      remedy:
        "Only the current rate may have no end date. Close the earlier periods " +
        "on the day the next notification took effect.",
    });
  }

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const current = ordered[i];
    const next = ordered[i + 1];
    if (!current || !next) continue;

    const currentEnd = current.effectiveTo;
    if (currentEnd === null || currentEnd > next.effectiveFrom) {
      errors.push({
        message:
          `The period starting ${current.effectiveFrom} overlaps the one starting ` +
          `${next.effectiveFrom}.`,
        remedy:
          `Close the earlier period on ${next.effectiveFrom}. Two rates valid on ` +
          `one day means an invoice raised that day could carry either, decided ` +
          `by a sort order — and nothing on the document would show which.`,
      });
    } else if (currentEnd < next.effectiveFrom) {
      warnings.push({
        message: `Nothing is rated between ${currentEnd} and ${next.effectiveFrom}.`,
        remedy:
          "An invoice dated in that window will have no rate to resolve. That is " +
          "correct if the classification genuinely did not exist then; otherwise " +
          "extend the earlier period.",
      });
    }
  }

  return { errors, warnings };
}

/**
 * The end date to write when superseding a rate from `from` onwards.
 *
 * Trivial, and it exists so no call site ever writes `from - 1 day` — the
 * inclusive-end mistake that leaves the changeover day unrated and turns
 * one invoice into a zero-rated one.
 */
export function supersedeOn(from: Date | string): string {
  return toCivilDay(from);
}

/**
 * ⚠️ Would moving a period's end date orphan a document?
 *
 * The database refuses this too (SQL Section 5). Here so the UI can warn
 * before the user commits, naming the date that would fall out of cover.
 */
export function wouldOrphanDocuments(args: {
  currentFrom: string;
  proposedTo: string | null;
  latestDocumentDate: string | null;
}): RateProblem | null {
  const { proposedTo, latestDocumentDate, currentFrom } = args;
  if (latestDocumentDate === null) return null;

  if (latestDocumentDate < currentFrom) {
    return {
      message: `A document dated ${latestDocumentDate} already uses this rate, but the period would start after it.`,
      remedy:
        "Leave the start date where it is. Documents already raised under this " +
        "rate keep it, and moving the window off them makes the invoice and the " +
        "master disagree.",
    };
  }

  if (proposedTo !== null && latestDocumentDate >= proposedTo) {
    return {
      message: `A document dated ${latestDocumentDate} already uses this rate, and the period would end on ${proposedTo}.`,
      remedy:
        `End the period no earlier than the day after ${latestDocumentDate}, or ` +
        `raise a credit note and reissue the affected documents. An invoice must ` +
        `never point at a rate period that does not cover its own date.`,
    };
  }

  return null;
}
