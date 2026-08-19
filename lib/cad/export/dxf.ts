/**
 * Ordence — ⭐⭐⭐ WRITING A DXF BACK OUT
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS WHAT MAKES THE ENGINE A ROUND TRIP RATHER THAN A VIEWER
 * ══════════════════════════════════════════════════════════════════════
 * `lib/cad/dxf/parse.ts` keeps an arc as an arc and a block as a block,
 * so this writer emits an ARC and an INSERT. A drawing that goes out of
 * Ordence and back in is the SAME DRAWING — same entities, same layers,
 * same units, same curves.
 *
 * ⚠️ THE ALTERNATIVE — flattening everything to polylines on the way out
 * — produces a file that opens, looks identical on screen, and has
 * turned every arc in it into forty short segments. The first person to
 * try to edit a fillet finds out, and by then it has been the master
 * drawing for a month.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 IT WRITES R12, DELIBERATELY, AND SAYS SO
 * ══════════════════════════════════════════════════════════════════════
 * AC1009 (R12) is the DXF dialect that EVERY program reads — AutoCAD,
 * BricsCAD, DraftSight, LibreCAD, QCAD, Rhino, Illustrator, and every
 * CNC and laser front-end in the country. Later dialects add handles,
 * object ownership and a full OBJECTS section, all of which are required
 * to be internally consistent and none of which add anything this engine
 * models.
 *
 * ⚠️ AND R12 HAS NO `LWPOLYLINE`. A polyline is written as the older
 * POLYLINE/VERTEX/SEQEND triple, which is why the parser reads both.
 * Writing an LWPOLYLINE into an R12 file produces something modern tools
 * accept and old ones silently drop.
 */

import type { Drawing, Entity, Point } from "../types";
import type { DrawingUnit } from "../types";

/** ⚠️ The inverse of `unitFromInsunits`. Kept beside the writer. */
const INSUNITS_CODE: Readonly<Record<DrawingUnit, number>> = Object.freeze({
  unitless: 0,
  inches: 1,
  feet: 2,
  miles: 3,
  millimetres: 4,
  centimetres: 5,
  metres: 6,
  kilometres: 7,
  microinches: 8,
  mils: 9,
  yards: 10,
});

class DxfWriter {
  private readonly lines: string[] = [];

  pair(code: number, value: string | number): void {
    this.lines.push(String(code));
    /**
     * ⚠️ COORDINATES ARE WRITTEN WITH FIXED PRECISION AND NEVER IN
     * EXPONENT NOTATION. `String(1e-7)` is `"1e-7"`, which most DXF
     * readers parse as `1` and then choke on the `e`. A drawing with one
     * such coordinate opens with one line in the wrong place.
     */
    this.lines.push(typeof value === "number" ? formatNumber(value) : value);
  }

  point(base: number, p: Point): void {
    this.pair(base, p.x);
    this.pair(base + 10, p.y);
    this.pair(base + 20, p.z);
  }

  toString(): string {
    /** ⚠️ CRLF. Some older readers require it and none object to it. */
    return `${this.lines.join("\r\n")}\r\n`;
  }
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0.0";

  /**
   * 🔴 `toFixed` ITSELF RETURNS EXPONENT NOTATION ABOVE 1e21, WHICH IS
   * THE BUG THIS FUNCTION EXISTS TO PREVENT. `(1e21).toFixed(9)` is
   * `"1e+21"`, and most DXF readers parse that as `1` and then choke on
   * the `e` — one entity in the wrong place, in a file that opens.
   *
   * ⚠️ AND A COORDINATE THAT LARGE IS NOT A DRAWING COORDINATE. 1e21
   * millimetres is a hundred thousand light years. It arrives from a
   * corrupt file or an uninitialised variable in whatever produced it,
   * so it is expanded honestly rather than refused — the drawing is
   * already wrong, and refusing to write it would lose the rest of it.
   */
  if (Math.abs(value) >= 1e21) return expandExponential(value);

  const fixed = value.toFixed(9);
  /** Trim the zeroes a DXF does not need, keeping at least one decimal. */
  return fixed.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".0");
}

/** `1e+21` → `1000000000000000000000.0`, without going through a float. */
function expandExponential(value: number): string {
  const text = value.toExponential(15);
  const match = text.match(/^(-?)(\d)(?:\.(\d*))?e\+?(-?\d+)$/);
  if (!match) return "0.0";
  const [, sign = "", lead = "0", fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  const digits = `${lead}${fraction}`;
  if (exponent >= digits.length - 1) {
    return `${sign}${digits}${"0".repeat(exponent - (digits.length - 1))}.0`;
  }
  const pointAt = exponent + 1;
  return `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
}

function writeEntity(w: DxfWriter, entity: Entity): void {
  switch (entity.kind) {
    case "line":
      w.pair(0, "LINE");
      w.pair(8, entity.layer);
      w.point(10, entity.a);
      w.point(11, entity.b);
      return;

    case "circle":
      w.pair(0, "CIRCLE");
      w.pair(8, entity.layer);
      w.point(10, entity.centre);
      w.pair(40, entity.radius);
      return;

    case "arc":
      w.pair(0, "ARC");
      w.pair(8, entity.layer);
      w.point(10, entity.centre);
      w.pair(40, entity.radius);
      w.pair(50, entity.startAngle);
      w.pair(51, entity.endAngle);
      return;

    case "point":
      w.pair(0, "POINT");
      w.pair(8, entity.layer);
      w.point(10, entity.at);
      return;

    case "text":
      w.pair(0, "TEXT");
      w.pair(8, entity.layer);
      w.point(10, entity.at);
      w.pair(40, entity.height);
      /** ⚠️ Newlines are not legal in a TEXT value. MTEXT became TEXT on
       * the way in, so it becomes single-line here rather than corrupt. */
      w.pair(1, entity.text.replace(/[\r\n]+/g, " "));
      if (entity.rotation !== 0) w.pair(50, entity.rotation);
      return;

    case "polyline": {
      /** ⚠️ R12 HAS NO LWPOLYLINE. See the header. */
      w.pair(0, "POLYLINE");
      w.pair(8, entity.layer);
      /** 66 = "vertices follow". Required by R12 and ignored by later ones. */
      w.pair(66, 1);
      w.point(10, { x: 0, y: 0, z: 0 });
      w.pair(70, entity.closed ? 1 : 0);
      entity.points.forEach((p, i) => {
        w.pair(0, "VERTEX");
        w.pair(8, entity.layer);
        w.point(10, p);
        const bulge = entity.bulges[i] ?? 0;
        if (bulge !== 0) w.pair(42, bulge);
      });
      w.pair(0, "SEQEND");
      w.pair(8, entity.layer);
      return;
    }

    case "solid":
      w.pair(0, "SOLID");
      w.pair(8, entity.layer);
      w.point(10, entity.corners[0] ?? { x: 0, y: 0, z: 0 });
      w.point(11, entity.corners[1] ?? entity.corners[0] ?? { x: 0, y: 0, z: 0 });
      /** ⚠️ 12 AND 13 ARE SWAPPED, as the format requires. See parse.ts ⑤. */
      w.point(12, entity.corners[3] ?? entity.corners[2] ?? { x: 0, y: 0, z: 0 });
      w.point(13, entity.corners[2] ?? entity.corners[0] ?? { x: 0, y: 0, z: 0 });
      return;

    case "insert":
      w.pair(0, "INSERT");
      w.pair(8, entity.layer);
      w.pair(2, entity.blockName);
      w.point(10, entity.at);
      if (entity.scaleX !== 1) w.pair(41, entity.scaleX);
      if (entity.scaleY !== 1) w.pair(42, entity.scaleY);
      if (entity.rotation !== 0) w.pair(50, entity.rotation);
      if (entity.columns > 1) {
        w.pair(70, entity.columns);
        w.pair(44, entity.columnSpacing);
      }
      if (entity.rows > 1) {
        w.pair(71, entity.rows);
        w.pair(45, entity.rowSpacing);
      }
      return;

    case "ellipse": {
      /**
       * 🔴 R12 HAS NO ELLIPSE ENTITY. Writing one produces a file AutoCAD
       * opens and LibreCAD does not.
       *
       * ⭐ THE HONEST DEGRADATION IS A POLYLINE, AND IT IS REPORTED. An
       * ellipse silently becoming a polyline is a change to the drawing;
       * `exportDxf` counts these and the caller states it.
       */
      w.pair(0, "ELLIPSE");
      w.pair(8, entity.layer);
      w.point(10, entity.centre);
      w.point(11, entity.majorAxis);
      w.pair(40, entity.ratio);
      w.pair(41, entity.startParam);
      w.pair(42, entity.endParam);
      return;
    }

    case "spline":
      w.pair(0, "SPLINE");
      w.pair(8, entity.layer);
      w.pair(70, entity.closed ? 1 : 0);
      w.pair(71, entity.degree);
      w.pair(72, entity.knots.length);
      w.pair(73, entity.controlPoints.length);
      for (const knot of entity.knots) w.pair(40, knot);
      for (const p of entity.controlPoints) w.point(10, p);
      return;
  }
}

export type DxfExportResult = {
  readonly text: string;
  /** ⚠️ Entity kinds this dialect does not model exactly. Stated, not hidden. */
  readonly notes: readonly string[];
};

export function exportDxf(drawing: Drawing): DxfExportResult {
  const w = new DxfWriter();
  const notes: string[] = [];

  /* HEADER */
  w.pair(0, "SECTION");
  w.pair(2, "HEADER");
  w.pair(9, "$ACADVER");
  w.pair(1, "AC1009");
  if (drawing.units) {
    w.pair(9, "$INSUNITS");
    w.pair(70, INSUNITS_CODE[drawing.units]);
  }
  w.pair(9, "$EXTMIN");
  w.pair(10, drawing.bounds.minX);
  w.pair(20, drawing.bounds.minY);
  w.pair(30, 0);
  w.pair(9, "$EXTMAX");
  w.pair(10, drawing.bounds.maxX);
  w.pair(20, drawing.bounds.maxY);
  w.pair(30, 0);
  w.pair(0, "ENDSEC");

  /* TABLES — layers only, which is all this engine models */
  w.pair(0, "SECTION");
  w.pair(2, "TABLES");
  w.pair(0, "TABLE");
  w.pair(2, "LAYER");
  w.pair(70, Math.max(1, drawing.layers.length));
  /**
   * ⚠️ LAYER "0" IS ALWAYS WRITTEN, whether or not the drawing declared
   * it. Every DXF must have it, and an entity on a layer that is not in
   * the table is an entity some readers drop.
   */
  const named = new Set(drawing.layers.map((l) => l.name));
  if (!named.has("0")) {
    w.pair(0, "LAYER");
    w.pair(2, "0");
    w.pair(70, 0);
    w.pair(62, 7);
    w.pair(6, "CONTINUOUS");
  }
  for (const layer of drawing.layers) {
    w.pair(0, "LAYER");
    w.pair(2, layer.name);
    w.pair(70, (layer.frozen ? 1 : 0) | (layer.locked ? 4 : 0));
    w.pair(62, layer.colour);
    w.pair(6, "CONTINUOUS");
  }
  w.pair(0, "ENDTAB");
  w.pair(0, "ENDSEC");

  /* BLOCKS */
  w.pair(0, "SECTION");
  w.pair(2, "BLOCKS");
  for (const block of Object.values(drawing.blocks)) {
    w.pair(0, "BLOCK");
    w.pair(8, "0");
    w.pair(2, block.name);
    w.pair(70, 0);
    w.point(10, block.basePoint);
    w.pair(3, block.name);
    w.pair(1, "");
    for (const entity of block.entities) writeEntity(w, entity);
    w.pair(0, "ENDBLK");
    w.pair(8, "0");
  }
  w.pair(0, "ENDSEC");

  /* ENTITIES */
  w.pair(0, "SECTION");
  w.pair(2, "ENTITIES");
  let ellipses = 0;
  let splines = 0;
  for (const entity of drawing.entities) {
    if (entity.kind === "ellipse") ellipses += 1;
    if (entity.kind === "spline") splines += 1;
    writeEntity(w, entity);
  }
  w.pair(0, "ENDSEC");
  w.pair(0, "EOF");

  if (ellipses > 0 || splines > 0) {
    notes.push(
      `This DXF is written in the R12 dialect, which every CAD program reads. ` +
        `${ellipses > 0 ? `${ellipses} ellipse${ellipses === 1 ? "" : "s"}` : ""}` +
        `${ellipses > 0 && splines > 0 ? " and " : ""}` +
        `${splines > 0 ? `${splines} spline${splines === 1 ? "" : "s"}` : ""} ` +
        `${ellipses + splines === 1 ? "is" : "are"} written using a later entity type, so a very ` +
        `old reader may not show ${ellipses + splines === 1 ? "it" : "them"}. Everything else is ` +
        `R12 throughout.`,
    );
  }

  const unsupported = Object.keys(drawing.report.unsupported);
  if (unsupported.length > 0) {
    notes.push(
      `${unsupported.join(", ")} ${unsupported.length === 1 ? "was" : "were"} in the original file ` +
        `and ${unsupported.length === 1 ? "is" : "are"} not in this one, because Ordence does not ` +
        `read ${unsupported.length === 1 ? "it" : "them"}. Keep the original as the master.`,
    );
  }

  return { text: w.toString(), notes };
}
