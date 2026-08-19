/**
 * Ordence — ⭐⭐ THE UNIT IS THE WHOLE MEASUREMENT
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS ITS OWN FILE AND NOT A CONSTANT
 * ══════════════════════════════════════════════════════════════════════
 * A drawing in millimetres read as metres is out by a factor of a
 * thousand, and on a site plan the number still looks plausible. A
 * quantity taken off it goes into a BOQ, the BOQ goes into a tender, and
 * nobody finds it until somebody orders concrete.
 *
 * ⚠️ `$INSUNITS = 0` MEANS "UNITLESS", AND IT IS NOT A SYNONYM FOR
 * MILLIMETRES however common that assumption is. Roughly a third of the
 * DXFs in circulation are unitless — every one exported by a tool that
 * did not bother to set it — and the honest handling is to REFUSE TO
 * MEASURE until a person says what a drawing unit is.
 *
 * ⭐ THIS IS THE SAME ARGUMENT `lib/fx/currency.ts` MAKES ABOUT MONEY:
 *   *"a guess of two is wrong by a factor of ten for the Gulf dinars"*.
 * A number with no unit is not a measurement, it is a number.
 */

import type { DrawingUnit } from "./types";

/** ⭐ The `$INSUNITS` table, DXF reference, HEADER section. */
const INSUNITS: Readonly<Record<number, DrawingUnit>> = Object.freeze({
  0: "unitless",
  1: "inches",
  2: "feet",
  3: "miles",
  4: "millimetres",
  5: "centimetres",
  6: "metres",
  7: "kilometres",
  8: "microinches",
  9: "mils",
  10: "yards",
});

export function unitFromInsunits(value: number): DrawingUnit | null {
  return INSUNITS[value] ?? null;
}

/** Metres per one drawing unit. `null` for unitless — deliberately. */
const METRES_PER_UNIT: Readonly<Record<DrawingUnit, number | null>> = Object.freeze({
  unitless: null,
  microinches: 0.0000000254,
  mils: 0.0000254,
  inches: 0.0254,
  feet: 0.3048,
  yards: 0.9144,
  miles: 1609.344,
  millimetres: 0.001,
  centimetres: 0.01,
  metres: 1,
  kilometres: 1000,
});

export class UnknownScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownScaleError";
  }
}

/**
 * ⭐⭐ THE REFUSAL, IN THE WORDS OF SOMEBODY WHO HAS TO ACT ON IT.
 */
export const UNITLESS_REFUSAL =
  "This drawing does not say what one drawing unit means. That is a real state — about a third " +
  "of DXF files in circulation are exported without it — and it is not the same as millimetres, " +
  "however often it turns out to be. Ordence will show the drawing and will not put a length or " +
  "an area on it until somebody says. Set the unit on the drawing record and every measurement " +
  "taken from it will carry that unit and that decision.";

/**
 * Convert a length in drawing units to metres.
 *
 * ⚠️ THROWS FOR A UNITLESS DRAWING RATHER THAN ASSUMING. See the header.
 */
export function toMetres(length: number, unit: DrawingUnit | null): number {
  if (unit === null || unit === "unitless") throw new UnknownScaleError(UNITLESS_REFUSAL);
  const factor = METRES_PER_UNIT[unit];
  if (factor === null) throw new UnknownScaleError(UNITLESS_REFUSAL);
  return length * factor;
}

/**
 * ⚠️ AREA SCALES BY THE SQUARE, AND FORGETTING THAT IS THE SECOND
 * FACTOR-OF-A-MILLION MISTAKE AVAILABLE HERE. One square metre is
 * 1,000,000 square millimetres, not 1,000.
 */
export function areaToSquareMetres(area: number, unit: DrawingUnit | null): number {
  if (unit === null || unit === "unitless") throw new UnknownScaleError(UNITLESS_REFUSAL);
  const factor = METRES_PER_UNIT[unit];
  if (factor === null) throw new UnknownScaleError(UNITLESS_REFUSAL);
  return area * factor * factor;
}

/**
 * ⭐ HOW A LENGTH IS SHOWN TO AN INDIAN SITE ENGINEER.
 *
 * ⚠️ NOT `toFixed(2)` ON EVERYTHING. A 45-metre boundary shown as
 * "45.00 m" and a 12-millimetre bar shown as "0.01 m" are the same
 * function being wrong in two directions. The unit is chosen from the
 * magnitude, and the drawing's own unit is named beside it so nobody has
 * to trust the conversion.
 */
export function formatLength(metres: number, unit: DrawingUnit): string {
  const absolute = Math.abs(metres);
  if (absolute >= 1000) return `${(metres / 1000).toFixed(3)} km`;
  if (absolute >= 1) return `${metres.toFixed(3)} m`;
  if (absolute >= 0.01) return `${(metres * 100).toFixed(1)} cm`;
  return `${(metres * 1000).toFixed(0)} mm`;
}

export function formatArea(squareMetres: number): string {
  const absolute = Math.abs(squareMetres);
  /**
   * ⭐ THE ACRE AND THE HECTARE BOTH APPEAR ON INDIAN LAND DOCUMENTS and
   * a plot given only in square metres is a plot somebody has to convert
   * by hand before they can check it against the sale deed.
   */
  /**
   * ⚠️ THE THRESHOLD IS A PLOT, NOT A HECTARE. It was 10,000 m² — one
   * hectare — which meant a one-acre plot, the single most common unit
   * on an Indian sale deed, was shown only in square metres and had to be
   * converted by hand before it could be checked against the document.
   */
  if (absolute >= 1_000) {
    return `${squareMetres.toFixed(1)} m² (${(squareMetres / 10_000).toFixed(4)} ha · ${(squareMetres / 4046.8564224).toFixed(4)} acre)`;
  }
  if (absolute >= 1) return `${squareMetres.toFixed(3)} m²`;
  return `${(squareMetres * 10_000).toFixed(1)} cm²`;
}

export const DRAWING_UNITS: readonly DrawingUnit[] = [
  "millimetres",
  "centimetres",
  "metres",
  "kilometres",
  "inches",
  "feet",
  "yards",
  "miles",
  "mils",
  "microinches",
  "unitless",
];
