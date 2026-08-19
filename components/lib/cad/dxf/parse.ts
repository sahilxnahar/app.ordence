/**
 * Ordence — ⭐⭐⭐ THE DXF PARSER
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT IT READS, AND WHAT IT SAYS ABOUT WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * HEADER   $INSUNITS, $EXTMIN, $EXTMAX
 * TABLES   LAYER — names, colours, frozen, locked
 * BLOCKS   every block definition, kept unexpanded
 * ENTITIES LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE, POINT,
 *          TEXT, MTEXT, SOLID, 3DFACE, SPLINE, INSERT
 *
 * 🔴 EVERYTHING ELSE IS COUNTED BY NAME, NOT DROPPED IN SILENCE.
 * `DrawingReport.unsupported` is the field this whole file exists to
 * populate honestly: a viewer that drops what it cannot read and shows
 * the rest LOOKS LIKE IT WORKED, and the customer uses it to make a
 * decision about a drawing that is missing its hatching, its dimensions
 * or a whole layer of proxy entities from a structural add-on.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE THINGS THAT MAKE A NAIVE DXF PARSER WRONG
 * ══════════════════════════════════════════════════════════════════════
 * ① **A `0` GROUP CODE STARTS A NEW THING.** Everything between one `0`
 *    and the next belongs to the entity the first one named. A parser
 *    that reads fields by group code without tracking that boundary
 *    attributes the next entity's layer to this one.
 *
 * ② **A POLYLINE IS THREE RECORD TYPES.** `POLYLINE`, then one `VERTEX`
 *    per point, then `SEQEND`. LWPOLYLINE — the modern one — is a single
 *    record with repeated `10`/`20` pairs. Both are everywhere; a file
 *    from 2003 has the first and a file from 2023 has the second.
 *
 * ③ **REPEATED GROUP CODES ARE THE POINT, NOT A CONFLICT.** An
 *    LWPOLYLINE's `10` appears once per vertex. Last-one-wins produces a
 *    polyline with one point.
 *
 * ④ **THE BULGE BELONGS TO THE VERTEX IT FOLLOWS.** Group 42 sets the
 *    bulge of the vertex most recently read, and a bulge with no vertex
 *    after it applies to the LAST one. Getting this off by one turns
 *    every rounded corner into a chamfer.
 *
 * ⑤ **`SOLID` ORDERS ITS LAST TWO CORNERS THE WRONG WAY ROUND.** Corner
 *    3 and corner 4 are swapped relative to a sane quadrilateral. Drawing
 *    them in file order produces a bow-tie.
 */

import { lexDxf, type DxfPair } from "./lexer";
import { unitFromInsunits } from "../units";
import type {
  Block,
  Bounds,
  Drawing,
  DrawingUnit,
  Entity,
  Layer,
  Point,
} from "../types";

export class DxfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DxfParseError";
  }
}

/** One record: the `0` value plus everything up to the next `0`. */
type Record0 = {
  readonly type: string;
  readonly pairs: readonly DxfPair[];
};

const ORIGIN: Point = { x: 0, y: 0, z: 0 };

/** ⚠️ Last one wins, which is correct for single-valued codes only. */
function num(pairs: readonly DxfPair[], code: number, fallback: number): number {
  let out = fallback;
  for (const pair of pairs) {
    if (pair.code !== code) continue;
    const value = Number(pair.value.trim());
    if (Number.isFinite(value)) out = value;
  }
  return out;
}

function str(pairs: readonly DxfPair[], code: number, fallback = ""): string {
  let out = fallback;
  for (const pair of pairs) if (pair.code === code) out = pair.value.trim();
  return out;
}

function point(pairs: readonly DxfPair[], base = 10): Point {
  return {
    x: num(pairs, base, 0),
    y: num(pairs, base + 10, 0),
    z: num(pairs, base + 20, 0),
  };
}

/**
 * ⭐ ③ AND ④ TOGETHER: the vertices of an LWPOLYLINE, in order, with the
 * bulge that belongs to each.
 */
function lwVertices(pairs: readonly DxfPair[]): { points: Point[]; bulges: number[] } {
  const points: Point[] = [];
  const bulges: number[] = [];
  let x: number | null = null;

  for (const pair of pairs) {
    if (pair.code === 10) {
      /** A new 10 closes the previous vertex, whatever followed it. */
      if (x !== null) {
        points.push({ x, y: 0, z: 0 });
        bulges.push(0);
      }
      x = Number(pair.value.trim());
      continue;
    }
    if (pair.code === 20 && x !== null) {
      points.push({ x, y: Number(pair.value.trim()), z: 0 });
      bulges.push(0);
      x = null;
      continue;
    }
    if (pair.code === 42 && points.length > 0) {
      /** ⚠️ ④ — the bulge of the vertex most recently completed. */
      bulges[points.length - 1] = Number(pair.value.trim());
    }
  }
  if (x !== null) {
    points.push({ x, y: 0, z: 0 });
    bulges.push(0);
  }
  return { points, bulges };
}

/** MTEXT's formatting codes, removed so the text reads as text. */
function stripMtextFormatting(raw: string): string {
  return raw
    .replace(/\\P/g, "\n")
    .replace(/\\[A-Za-z]+[^;\\]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\\\/g, "\\");
}

function entityFrom(record: Record0, report: Map<string, number>): Entity | null {
  const { type, pairs } = record;
  const layer = str(pairs, 8, "0");

  switch (type) {
    case "LINE":
      return { kind: "line", layer, a: point(pairs, 10), b: point(pairs, 11) };

    case "LWPOLYLINE": {
      const { points, bulges } = lwVertices(pairs);
      if (points.length < 2) return null;
      /** Bit 1 of group 70 is "closed". */
      const closed = (num(pairs, 70, 0) & 1) === 1;
      return { kind: "polyline", layer, points, bulges, closed };
    }

    case "CIRCLE":
      return {
        kind: "circle",
        layer,
        centre: point(pairs, 10),
        radius: num(pairs, 40, 0),
      };

    case "ARC":
      return {
        kind: "arc",
        layer,
        centre: point(pairs, 10),
        radius: num(pairs, 40, 0),
        startAngle: num(pairs, 50, 0),
        endAngle: num(pairs, 51, 360),
      };

    case "ELLIPSE":
      return {
        kind: "ellipse",
        layer,
        centre: point(pairs, 10),
        majorAxis: point(pairs, 11),
        ratio: num(pairs, 40, 1),
        startParam: num(pairs, 41, 0),
        endParam: num(pairs, 42, Math.PI * 2),
      };

    case "POINT":
      return { kind: "point", layer, at: point(pairs, 10) };

    case "TEXT":
      return {
        kind: "text",
        layer,
        at: point(pairs, 10),
        text: str(pairs, 1),
        height: num(pairs, 40, 2.5),
        rotation: num(pairs, 50, 0),
      };

    case "MTEXT": {
      /**
       * ⚠️ MTEXT'S CONTENT IS SPLIT ACROSS REPEATED `3` PAIRS WITH THE
       * LAST FRAGMENT IN `1`. Reading only group 1 gives the tail of a
       * long note and looks like the note was truncated by us.
       */
      let text = "";
      for (const pair of pairs) if (pair.code === 3) text += pair.value;
      text += str(pairs, 1);
      return {
        kind: "text",
        layer,
        at: point(pairs, 10),
        text: stripMtextFormatting(text),
        height: num(pairs, 40, 2.5),
        rotation: num(pairs, 50, 0),
      };
    }

    case "SOLID":
    case "3DFACE": {
      /** ⚠️ ⑤ — corners 3 and 4 are swapped in the file. */
      const corners = [point(pairs, 10), point(pairs, 11), point(pairs, 13), point(pairs, 12)];
      return { kind: "solid", layer, corners };
    }

    case "SPLINE": {
      const controlPoints: Point[] = [];
      let x: number | null = null;
      let y: number | null = null;
      for (const pair of pairs) {
        if (pair.code === 10) x = Number(pair.value.trim());
        else if (pair.code === 20) y = Number(pair.value.trim());
        else if (pair.code === 30 && x !== null && y !== null) {
          controlPoints.push({ x, y, z: Number(pair.value.trim()) });
          x = null;
          y = null;
        }
      }
      if (x !== null && y !== null) controlPoints.push({ x, y, z: 0 });
      const knots: number[] = [];
      for (const pair of pairs) if (pair.code === 40) knots.push(Number(pair.value.trim()));
      const flags = num(pairs, 70, 0);
      if (controlPoints.length < 2) return null;
      return {
        kind: "spline",
        layer,
        controlPoints,
        degree: num(pairs, 71, 3),
        knots,
        closed: (flags & 1) === 1,
      };
    }

    case "INSERT":
      return {
        kind: "insert",
        layer,
        blockName: str(pairs, 2),
        at: point(pairs, 10),
        scaleX: num(pairs, 41, 1),
        scaleY: num(pairs, 42, 1),
        rotation: num(pairs, 50, 0),
        columns: Math.max(1, Math.round(num(pairs, 70, 1))),
        rows: Math.max(1, Math.round(num(pairs, 71, 1))),
        columnSpacing: num(pairs, 44, 0),
        rowSpacing: num(pairs, 45, 0),
      };

    /**
     * ⚠️ THESE ARE STRUCTURE, NOT GEOMETRY, and counting them as
     * unsupported would report a clean drawing as full of holes.
     */
    case "SEQEND":
    case "ATTRIB":
    case "ATTDEF":
    case "VERTEX":
      return null;

    default:
      report.set(type, (report.get(type) ?? 0) + 1);
      return null;
  }
}

/** A limit, because a hostile or broken file should not take the tab down. */
export const MAX_ENTITIES = 2_000_000;

export function parseDxf(text: string): Drawing {
  const entities: Entity[] = [];
  const layers: Layer[] = [];
  const blocks: Record<string, Block> = {};
  const unsupported = new Map<string, number>();
  const warnings: string[] = [];

  let section = "";
  let tableName = "";
  let units: DrawingUnit | null = null;
  let extMin: Point | null = null;
  let extMax: Point | null = null;

  /** Where entities go: the drawing, or the block currently being defined. */
  let blockName: string | null = null;
  let blockBase: Point = ORIGIN;
  let blockEntities: Entity[] = [];

  /** ⚠️ ② — a POLYLINE accumulates VERTEX records until SEQEND. */
  let polyline: { layer: string; closed: boolean; points: Point[]; bulges: number[] } | null = null;

  let current: { type: string; pairs: DxfPair[] } | null = null;
  let headerVariable = "";

  const push = (entity: Entity | null) => {
    if (!entity) return;
    if (entities.length + blockEntities.length > MAX_ENTITIES) {
      throw new DxfParseError(
        `That drawing has more than ${MAX_ENTITIES.toLocaleString("en-IN")} entities. Ordence ` +
          `will not open it in a browser — it would take the tab down rather than showing you ` +
          `anything. Export the sheet you need rather than the whole model.`,
      );
    }
    if (blockName !== null) blockEntities.push(entity);
    else entities.push(entity);
  };

  const finishRecord = () => {
    if (!current) return;
    const record: Record0 = { type: current.type, pairs: current.pairs };
    current = null;

    switch (record.type) {
      case "SECTION":
        section = str(record.pairs, 2);
        return;
      case "ENDSEC":
        section = "";
        tableName = "";
        return;
      case "TABLE":
        tableName = str(record.pairs, 2);
        return;
      case "ENDTAB":
        tableName = "";
        return;

      case "LAYER":
        if (section === "TABLES" && tableName === "LAYER") {
          const flags = num(record.pairs, 70, 0);
          const colour = num(record.pairs, 62, 7);
          layers.push({
            name: str(record.pairs, 2),
            colour,
            /** ⚠️ A NEGATIVE COLOUR MEANS THE LAYER IS OFF. See types.ts. */
            frozen: (flags & 1) === 1,
            locked: (flags & 4) === 4,
          });
        }
        return;

      case "BLOCK":
        blockName = str(record.pairs, 2);
        blockBase = point(record.pairs, 10);
        blockEntities = [];
        return;

      case "ENDBLK":
        if (blockName !== null) {
          blocks[blockName] = { name: blockName, basePoint: blockBase, entities: blockEntities };
        }
        blockName = null;
        blockEntities = [];
        return;

      /* ⚠️ ② — the old three-record polyline. */
      case "POLYLINE":
        polyline = {
          layer: str(record.pairs, 8, "0"),
          closed: (num(record.pairs, 70, 0) & 1) === 1,
          points: [],
          bulges: [],
        };
        return;

      case "VERTEX":
        if (polyline) {
          polyline.points.push(point(record.pairs, 10));
          polyline.bulges.push(num(record.pairs, 42, 0));
        }
        return;

      case "SEQEND":
        if (polyline && polyline.points.length >= 2) {
          push({
            kind: "polyline",
            layer: polyline.layer,
            points: polyline.points,
            bulges: polyline.bulges,
            closed: polyline.closed,
          });
        }
        polyline = null;
        return;

      default:
        if (section === "ENTITIES" || section === "BLOCKS") {
          push(entityFrom(record, unsupported));
        }
    }
  };

  for (const pair of lexDxf(text)) {
    if (pair.code === 0) {
      finishRecord();
      current = { type: pair.value.trim(), pairs: [] };
      if (current.type === "EOF") break;
      continue;
    }

    /**
     * 🔴 THE SECTION NAME IS TAKEN THE MOMENT IT ARRIVES, NOT WHEN THE
     * `SECTION` RECORD CLOSES.
     *
     * ⚠️ THIS WAS A REAL BUG AND ITS SYMPTOM WAS SILENT. `finishRecord`
     * runs at the NEXT `0`, and the HEADER section's variables all arrive
     * BEFORE that — `9/$INSUNITS`, `70/4` — so `section` was still empty
     * when they went past and every one of them was swallowed into the
     * SECTION record's own pairs. The drawing came back with no units,
     * which then correctly refused to measure anything, so the failure
     * presented as "this engine cannot measure" rather than as a parser
     * bug. Caught by a test asserting the units, not by anything failing.
     */
    if (current?.type === "SECTION" && pair.code === 2) {
      section = pair.value.trim();
    }

    /**
     * ⚠️ THE HEADER IS NOT RECORDS. It is `9 / $VARNAME` followed by that
     * variable's values, with no `0` between them, so the record machine
     * above never sees it and this branch reads it directly.
     */
    if (section === "HEADER") {
      if (pair.code === 9) {
        headerVariable = pair.value.trim();
        continue;
      }
      if (headerVariable === "$INSUNITS" && pair.code === 70) {
        units = unitFromInsunits(Number(pair.value.trim()));
        continue;
      }
      /**
       * ⚠️ `$EXTMIN` ARRIVES AS THREE SEPARATE PAIRS, so the point is
       * built across iterations. TypeScript narrows `extMin` to `never`
       * inside this branch without the local, because it cannot see that
       * the assignment on the previous line widened it again.
       */
      if (headerVariable === "$EXTMIN") {
        const held: Point = extMin ?? ORIGIN;
        if (pair.code === 10) extMin = { x: Number(pair.value), y: held.y, z: 0 };
        if (pair.code === 20) extMin = { x: held.x, y: Number(pair.value), z: 0 };
        continue;
      }
      if (headerVariable === "$EXTMAX") {
        const held: Point = extMax ?? ORIGIN;
        if (pair.code === 10) extMax = { x: Number(pair.value), y: held.y, z: 0 };
        if (pair.code === 20) extMax = { x: held.x, y: Number(pair.value), z: 0 };
        continue;
      }
    }

    if (current) current.pairs.push(pair);
  }
  finishRecord();

  if (polyline) {
    /**
     * ⚠️ A POLYLINE WITH NO SEQEND IS A TRUNCATED FILE, and dropping it
     * silently loses a wall. Reported.
     */
    warnings.push(
      "One polyline in that drawing has no closing record, which means the file was truncated. " +
        "It has been left out rather than drawn to a point that was never in the file.",
    );
  }

  if (units === null) {
    warnings.push(
      "This drawing does not state its units. It will be shown, and no length or area will be " +
        "put on it until somebody says what one drawing unit means.",
    );
  }

  const bounds =
    extMin && extMax && extMax.x > extMin.x && extMax.y > extMin.y
      ? { minX: extMin.x, minY: extMin.y, maxX: extMax.x, maxY: extMax.y }
      : computeBounds(entities, blocks);

  if (entities.length === 0) {
    warnings.push(
      "Ordence found no drawable entities in that file. If it opens in CAD, it is most likely " +
        "made of proxy objects from an add-on, which only that add-on can draw.",
    );
  }

  return {
    entities,
    layers,
    blocks,
    bounds,
    units,
    report: { unsupported: Object.fromEntries(unsupported), warnings },
  };
}

/** ⚠️ Imported lazily to keep the parser's own dependency list at one file. */
import { boundsOf } from "../geometry";

function computeBounds(
  entities: readonly Entity[],
  blocks: Readonly<Record<string, Block>>,
): Bounds {
  return boundsOf(entities, blocks);
}
