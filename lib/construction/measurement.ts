/**
 * Ordence — ⭐ Measurement Book
 * Version: v0.43.0-alpha
 *
 * Pure. Nothing here imports `@/db`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE MEASUREMENT BOOK IS THE PRIMARY RECORD
 * ══════════════════════════════════════════════════════════════════════
 * Everything a contractor is ever paid traces back to a page of it. In
 * public works it is a numbered, bound register produced in audit and in
 * arbitration, and its digital equivalent keeps the same properties or it
 * is not a measurement book:
 *
 *   • ⭐ THE WORKING IS VISIBLE. "12 × 4.500 × 0.230 × 3.000 = 37.260"
 *     is checkable by somebody standing at the wall with a tape.
 *     "37.260" is not. A system that stored only the answer would end the
 *     practice of checking measurement, quietly, in about a year.
 *
 *   • ⭐ MEASUREMENTS ACCUMULATE. Nobody re-measures last month's
 *     brickwork. The wall is measured as it stands and what was already
 *     certified is subtracted. That is why `cumulativeFor` exists and why
 *     the bill takes a running total rather than a period figure.
 *
 *   • ⭐ WHO MEASURED IS PART OF THE RECORD. Not for blame — because the
 *     person who measured may not certify, and a system that does not
 *     know who measured cannot enforce that.
 *
 * ⚠️ AND A DEDUCTION IS A POSITIVE QUANTITY MARKED AS A DEDUCTION. Doors,
 * windows, ducts and voids are measured positive and subtracted, which is
 * how the standard method of measurement reads and how a checker verifies
 * them. Storing them as negative quantities would let a deduction be
 * typed as an addition with nothing visible to distinguish the two.
 */

import {
  quantityFromDimensions,
  sumMinor,
  type Dimensions,
} from "./quantities";
import { checkAgainstBoq, type CeilingVerdict } from "./boq";

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type MeasurementStatusLike = "recorded" | "checked" | "billed" | "rejected";

export type MeasurementEntryInput = Dimensions & {
  id?: string;
  sequence: number;
  boqItemId: string;
  locationRef: string;
  levelRef?: string | null;
  description?: string | null;
  /** Supplied when the working is not dimensional (a count from a schedule). */
  quantityScaled?: bigint;
  isDeduction: boolean;
  measuredOn: string;
  measuredBy: string;
  status?: MeasurementStatusLike;
  raBillId?: string | null;
};

export type ComputedMeasurement = MeasurementEntryInput & {
  quantityScaled: bigint;
  /** Signed contribution: negative when it is a deduction. */
  netContributionScaled: bigint;
  working: string;
};

export class MeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementError";
  }
}

/* ------------------------------------------------------------------ */
/* ONE ENTRY                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Compute one entry, and produce the working as a readable string.
 *
 * `quantityScaled` may be supplied directly — a count read off a door
 * schedule has no dimensions. ⚠️ WHEN BOTH ARE GIVEN THEY MUST AGREE.
 * A stated answer that differs from its own working is either a typo or
 * an override, and both need somebody to look at them; silently
 * preferring one would hide whichever was wrong.
 */
export function computeEntry(entry: MeasurementEntryInput): ComputedMeasurement {
  const hasDimensions =
    entry.nosScaled != null ||
    entry.lengthScaled != null ||
    entry.breadthScaled != null ||
    entry.depthScaled != null;

  let quantityScaled: bigint;

  if (hasDimensions) {
    const derived = quantityFromDimensions(entry);
    if (entry.quantityScaled !== undefined && entry.quantityScaled !== derived) {
      throw new MeasurementError(
        `Entry ${entry.sequence} at ${entry.locationRef} states ` +
          `${fmt(entry.quantityScaled)} but its own working comes to ${fmt(derived)}. ` +
          `⚠️ REFUSED: a measurement whose answer disagrees with its dimensions is ` +
          `either a typo or an undeclared override, and both need a person. ` +
          `Silently preferring one of them would hide whichever was wrong — and ` +
          `the working is the only part a checker can verify against the building.`,
      );
    }
    quantityScaled = derived;
  } else {
    if (entry.quantityScaled === undefined) {
      throw new MeasurementError(
        `Entry ${entry.sequence} at ${entry.locationRef} has neither dimensions nor ` +
          `a stated quantity. A measurement book entry with no working and no ` +
          `answer is a blank line that will nevertheless be certified.`,
      );
    }
    if (entry.quantityScaled < 0n) {
      throw new MeasurementError(
        `Entry ${entry.sequence} carries a negative quantity. An opening or a void ` +
          `is measured POSITIVE and marked as a deduction — that is how the ` +
          `standard method of measurement reads and how a checker verifies it.`,
      );
    }
    quantityScaled = entry.quantityScaled;
  }

  if (!entry.locationRef?.trim()) {
    throw new MeasurementError(
      `Entry ${entry.sequence} has no location. ⚠️ A quantity with no location ` +
        `cannot be checked against the building, and checking against the ` +
        `building is what checking IS. "37.260 cum" is not verifiable; "37.260 ` +
        `cum, Tower A, grid C4-C6, 3rd floor slab" is.`,
    );
  }

  if (!entry.measuredBy?.trim()) {
    throw new MeasurementError(
      `Entry ${entry.sequence} has no measurer. ⚠️ An anonymous measurement is ` +
        `worthless as evidence, and it makes the measure-versus-certify ` +
        `separation impossible to enforce — the control that stops a contractor ` +
        `being paid for work that does not exist.`,
    );
  }

  return {
    ...entry,
    quantityScaled,
    netContributionScaled: entry.isDeduction ? -quantityScaled : quantityScaled,
    working: describeWorking(entry, quantityScaled),
  };
}

/** "12 × 4.500 × 0.230 × 3.000 = 37.260 (deduct)". */
export function describeWorking(
  entry: Dimensions & { isDeduction?: boolean },
  quantityScaled: bigint,
): string {
  const parts: string[] = [];
  if (entry.nosScaled != null) parts.push(fmt(entry.nosScaled));
  if (entry.lengthScaled != null) parts.push(fmt(entry.lengthScaled));
  if (entry.breadthScaled != null) parts.push(fmt(entry.breadthScaled));
  if (entry.depthScaled != null) parts.push(fmt(entry.depthScaled));

  const working = parts.length > 0 ? `${parts.join(" × ")} = ` : "";
  return `${working}${fmt(quantityScaled)}${entry.isDeduction ? " (deduct)" : ""}`;
}

/* ------------------------------------------------------------------ */
/* ⭐ ACCUMULATION                                                     */
/* ------------------------------------------------------------------ */

export type CumulativeMeasurement = {
  boqItemId: string;
  /** ⭐ Everything measured to date, net of deductions. */
  cumulativeQuantityScaled: bigint;
  additionsScaled: bigint;
  deductionsScaled: bigint;
  entryCount: number;
  /** Entries not yet checked. A bill should not consume these. */
  uncheckedCount: number;
};

/**
 * ⭐ THE RUNNING TOTAL FOR ONE BOQ ITEM.
 *
 * ⚠️ IT IS THE TOTAL OF EVERY ENTRY EVER MADE AGAINST THE ITEM, not of
 * this month's. That is the definition of a running account: the bill
 * takes this number and subtracts what the last bill took. Filtering by
 * period here — which looks harmless, and which somebody will suggest —
 * would turn every bill into a periodic invoice and break the only
 * property that makes the arithmetic self-correcting.
 */
export function cumulativeFor(
  boqItemId: string,
  entries: readonly ComputedMeasurement[],
): CumulativeMeasurement {
  const mine = entries.filter(
    (entry) => entry.boqItemId === boqItemId && entry.status !== "rejected",
  );

  const additions = mine.filter((entry) => !entry.isDeduction);
  const deductions = mine.filter((entry) => entry.isDeduction);

  const additionsScaled = sumMinor(additions.map((entry) => entry.quantityScaled));
  const deductionsScaled = sumMinor(deductions.map((entry) => entry.quantityScaled));

  return {
    boqItemId,
    cumulativeQuantityScaled: additionsScaled - deductionsScaled,
    additionsScaled,
    deductionsScaled,
    entryCount: mine.length,
    uncheckedCount: mine.filter((entry) => (entry.status ?? "recorded") === "recorded")
      .length,
  };
}

/** The same, for every item measured. Keyed by BOQ item id. */
export function cumulativeByItem(
  entries: readonly ComputedMeasurement[],
): Map<string, CumulativeMeasurement> {
  const ids = new Set(entries.map((entry) => entry.boqItemId));
  const result = new Map<string, CumulativeMeasurement>();
  for (const id of ids) result.set(id, cumulativeFor(id, entries));
  return result;
}

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE TWO REFUSALS                                               */
/* ------------------------------------------------------------------ */

export type MeasurementAdmission =
  | { ok: true; cumulativeQuantityScaled: bigint; headroomScaled: bigint }
  | { ok: false; reason: string; excessScaled?: bigint };

/**
 * ⭐⭐ MAY THIS ENTRY BE ADDED?
 *
 * Two refusals, and they are the two failures the whole phase is built
 * around:
 *
 *   1. ⭐ IT WOULD EXCEED THE BOQ. The authorised quantity is the BOQ
 *      plus APPROVED variations. Past that, a measurement is not a
 *      measurement — it is a change to the contract that nobody signed.
 *
 *   2. ⭐⭐ IT WOULD TAKE THE RUNNING TOTAL BELOW WHAT IS ALREADY
 *      CERTIFIED. Money has been paid against that certified quantity. A
 *      total that silently drops below it leaves the difference
 *      unaccounted for — and nothing errors, because the bill's own
 *      arithmetic stays internally consistent while producing a negative
 *      "now due" that gets netted off somewhere.
 */
export function admitEntry(args: {
  itemCode: string;
  uom: string;
  authorisedQuantityScaled: bigint;
  /** Sum of entries already recorded against this item. */
  existingCumulativeScaled: bigint;
  /** What a certified bill has already carried for this item. */
  certifiedQuantityScaled: bigint;
  entry: ComputedMeasurement;
  /** An approved variation covering a decrease, if one was given. */
  variationId?: string | null;
  decreaseReason?: string | null;
}): MeasurementAdmission {
  const proposed = args.existingCumulativeScaled + args.entry.netContributionScaled;

  if (proposed < 0n) {
    return {
      ok: false,
      reason:
        `Item ${args.itemCode}: this deduction takes the measured total to ` +
        `${fmt(proposed)} ${args.uom}. A cumulative measurement cannot be less ` +
        `than nothing — the deductions on this item now exceed everything ever ` +
        `measured against it, which means one of them is against the wrong line.`,
    };
  }

  const ceiling: CeilingVerdict = checkAgainstBoq({
    itemCode: args.itemCode,
    uom: args.uom,
    authorisedQuantityScaled: args.authorisedQuantityScaled,
    proposedCumulativeScaled: proposed,
  });
  if (!ceiling.ok) {
    return { ok: false, reason: ceiling.reason, excessScaled: ceiling.excessScaled };
  }

  if (proposed < args.certifiedQuantityScaled) {
    const shortfall = args.certifiedQuantityScaled - proposed;
    const explained = Boolean(args.variationId) && Boolean(args.decreaseReason?.trim());

    if (!explained) {
      return {
        ok: false,
        excessScaled: shortfall,
        reason:
          `Item ${args.itemCode}: this entry takes the measured total to ` +
          `${fmt(proposed)} ${args.uom}, below the ${fmt(args.certifiedQuantityScaled)} ` +
          `${args.uom} already CERTIFIED and paid. ⚠️ REFUSED WITHOUT AN APPROVED ` +
          `VARIATION AND A REASON. A silent decrease means money already paid ` +
          `against ${fmt(shortfall)} ${args.uom} of work is now unaccounted for — ` +
          `and nothing errors, because the next bill's own arithmetic stays ` +
          `consistent while producing a "now due" that somebody nets off. ` +
          `Re-measurement that finds an earlier measurement wrong is legitimate ` +
          `and common; doing it without saying so is what this refuses.`,
      };
    }
  }

  return {
    ok: true,
    cumulativeQuantityScaled: proposed,
    headroomScaled: args.authorisedQuantityScaled - proposed,
  };
}

/* ------------------------------------------------------------------ */
/* ⭐ SEGREGATION AT THE ENTRY LEVEL                                   */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE PERSON WHO MEASURED MAY NOT CHECK THEIR OWN ENTRY EITHER.
 *
 * The bill-level control (measure vs certify) is the one that matters
 * most, but it is defeated if the entry-level check is self-administered:
 * a checker who signs off their own measurements produces a bill whose
 * every input was verified by the person who wrote it.
 */
export function assertCheckerIsNotMeasurer(args: {
  measuredBy: string;
  checkedBy: string;
  sequence: number;
}): void {
  if (args.measuredBy === args.checkedBy) {
    throw new MeasurementError(
      `Entry ${args.sequence} was measured and checked by the same person. ` +
        `⚠️ REFUSED: checking a measurement means going to the building and ` +
        `verifying it against the working. Somebody verifying their own entry is ` +
        `not a control, and a bill whose every input was checked by the person ` +
        `who wrote it has no independent evidence behind it at all.`,
    );
  }
}

/* ------------------------------------------------------------------ */

function fmt(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, 3);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
