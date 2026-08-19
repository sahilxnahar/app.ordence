import "server-only";

/**
 * Ordence — ⭐⭐⭐ A MEASUREMENT THAT CITES ITS SOURCE
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE RULE
 * ══════════════════════════════════════════════════════════════════════
 * A measurement is recorded IN SI, with the unit basis it was derived
 * from, whether that basis was DECLARED BY THE FILE or ASSUMED BY A
 * PERSON, and an error bound.
 *
 * ⚠️ THE UNIT BASIS IS COPIED, NOT REFERENCED. If somebody later changes
 * the assumed unit on the revision, this measurement does NOT silently
 * change with it — it becomes visibly inconsistent, which is the correct
 * outcome and the one a re-measure exists to fix. A measurement that
 * quietly restated itself when a setting changed would be a quantity in a
 * bill that changed after the bill was raised.
 *
 * ⭐ AND THE ERROR BOUND IS NOT DECORATION. `lib/cad/geometry.ts` returns
 * one with every area, because flattening a curve to measure the region
 * it encloses is an approximation. An area used to price concrete, given
 * to three decimals with no error bound, is a number somebody will treat
 * as exact.
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { drawingMeasurements, drawingRevisions } from "@/db/schema/drawings";
import { areaToSquareMetres, toMetres, UNITLESS_REFUSAL } from "@/lib/cad/units";
import type { DrawingUnit } from "@/lib/cad/types";

export class MeasurementRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasurementRefused";
  }
}

/**
 * ⭐ WHICH UNIT APPLIES, AND WHETHER ANYBODY DECIDED IT.
 *
 * 🔴 THE DECLARED ONE WINS. A file that states its units is evidence; a
 * person's assumption is a decision made in its absence, and `0118`
 * refuses to record one over a declaration for exactly that reason.
 */
export function effectiveUnit(revision: {
  declaredUnit: string | null;
  assumedUnit: string | null;
}): { unit: DrawingUnit | null; assumed: boolean } {
  if (revision.declaredUnit && revision.declaredUnit !== "unitless") {
    return { unit: revision.declaredUnit as DrawingUnit, assumed: false };
  }
  if (revision.assumedUnit) return { unit: revision.assumedUnit as DrawingUnit, assumed: true };
  return { unit: null, assumed: false };
}

export type RecordMeasurementArgs = {
  readonly tenantId: string;
  readonly revisionId: string;
  readonly takenBy: string;
  readonly kind: "length" | "area" | "count";
  readonly label: string;
  readonly layer?: string | null;
  /** ⚠️ In the DRAWING's units. Converted here, once. */
  readonly rawValue: number;
  /** From `measureArea`. Zero for an exact length. */
  readonly rawMaxError: number;
  readonly isExact: boolean;
  readonly points: readonly { x: number; y: number }[];
};

export async function recordMeasurement(args: RecordMeasurementArgs): Promise<string> {
  return withTenant(args.tenantId, async (tx) => {
    const [revision] = await tx
      .select({
        id: drawingRevisions.id,
        declaredUnit: drawingRevisions.declaredUnit,
        assumedUnit: drawingRevisions.assumedUnit,
        supersededAt: drawingRevisions.supersededAt,
        revision: drawingRevisions.revision,
      })
      .from(drawingRevisions)
      .where(
        and(
          eq(drawingRevisions.tenantId, args.tenantId),
          eq(drawingRevisions.id, args.revisionId),
        ),
      );

    if (!revision) throw new MeasurementRefused("That revision is not in this workspace.");

    /**
     * ⚠️ MEASURING A SUPERSEDED SHEET IS ALLOWED AND IS NOT SILENT. There
     * are real reasons to take a quantity off an old revision — settling
     * a bill for work already done to it — and refusing would send the
     * quantity surveyor back to a printout. The measurement carries the
     * revision id, so anything derived from it says which sheet it came
     * off.
     */

    const { unit, assumed } = effectiveUnit(revision);
    if (!unit) {
      /**
       * 🔴 THE REFUSAL FROM `lib/cad/units.ts`, VERBATIM. One sentence in
       * the product for this, not two that drift apart.
       */
      throw new MeasurementRefused(UNITLESS_REFUSAL);
    }

    /** ⭐ Length scales by the factor; AREA SCALES BY THE SQUARE. */
    const convert = (value: number) =>
      args.kind === "area" ? areaToSquareMetres(value, unit) : toMetres(value, unit);

    const valueSi = args.kind === "count" ? args.rawValue : convert(args.rawValue);
    const maxErrorSi =
      args.kind === "count" ? 0 : args.isExact ? 0 : convert(args.rawMaxError);

    const [row] = await tx
      .insert(drawingMeasurements)
      .values({
        tenantId: args.tenantId,
        revisionId: args.revisionId,
        takenBy: args.takenBy,
        kind: args.kind,
        label: args.label.trim(),
        layer: args.layer ?? null,
        valueSi,
        maxErrorSi,
        isExact: args.isExact,
        unitBasis: unit,
        unitWasAssumed: assumed,
        points: [...args.points] as unknown as Record<string, unknown>,
      })
      .returning({ id: drawingMeasurements.id });

    if (!row) throw new MeasurementRefused("The measurement could not be recorded.");
    return row.id;
  });
}

/**
 * ⭐ THE SENTENCE A BOQ LINE QUOTES.
 *
 * ⚠️ IT NAMES THE REVISION, THE UNIT BASIS AND WHETHER THAT BASIS WAS
 * SOMEBODY'S ASSUMPTION. "412.150 m²" is a number. This is a number
 * somebody can check.
 */
export function citeMeasurement(m: {
  kind: string;
  valueSi: number;
  maxErrorSi: number;
  isExact: boolean;
  unitBasis: string;
  unitWasAssumed: boolean;
  label: string;
}, drawingNumber: string, revision: string): string {
  const unit = m.kind === "area" ? "m²" : m.kind === "length" ? "m" : "";
  const value = m.kind === "count" ? String(m.valueSi) : m.valueSi.toFixed(3);
  const error =
    m.isExact || m.maxErrorSi === 0
      ? " (exact)"
      : ` (±${m.maxErrorSi.toFixed(4)} ${unit} from curve flattening)`;
  const basis = m.unitWasAssumed
    ? `at 1 unit = 1 ${m.unitBasis.replace(/s$/, "")}, assumed`
    : `at 1 unit = 1 ${m.unitBasis.replace(/s$/, "")}, as declared by the file`;
  return `${m.label}: ${value} ${unit}${error}, from ${drawingNumber} Rev ${revision}, ${basis}`;
}
