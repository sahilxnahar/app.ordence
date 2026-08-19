/**
 * Ordence — ⭐⭐⭐ THE DRAWING MODEL
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ FLATTENED TO 2D, AND SAYING SO
 * ══════════════════════════════════════════════════════════════════════
 * This model is two-dimensional. A DXF can hold a full 3D solid model,
 * and this engine reads the plan view of one: Z is preserved on points so
 * nothing is silently lost, and every measurement, every render and every
 * export is in the XY plane.
 *
 * ⚠️ THAT IS A REAL LIMITATION AND IT IS STATED EVERYWHERE IT MATTERS —
 * in the viewer, in the measurement panel and on the drawing record. A
 * viewer that silently projects a 3D model and calls the result "the
 * drawing" gives an area for a wall the customer measures as a floor.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CURVES ARE KEPT AS CURVES UNTIL THE LAST MOMENT
 * ══════════════════════════════════════════════════════════════════════
 * An arc flattened to line segments at parse time is an arc that can
 * never be re-exported as an arc, measured exactly, or snapped to. So an
 * ARC stays an ARC in this model and `lib/cad/geometry.ts` flattens it —
 * with a stated tolerance — only for rendering and for area.
 *
 * ⭐ THAT IS WHAT MAKES `lib/cad/export/dxf.ts` A ROUND TRIP rather than
 * a degradation. A drawing that goes out of Ordence and back in is the
 * same drawing.
 *
 * ⚠️ PURE. No database, no clock, no `node:`. It runs in the viewer.
 */

export type Point = {
  readonly x: number;
  readonly y: number;
  /** ⚠️ Kept, never used by the 2D engine. See the header. */
  readonly z: number;
};

export type Bounds = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

/**
 * ⭐ THE ENTITIES THIS ENGINE UNDERSTANDS. Anything else is kept as
 * `unsupported` WITH ITS TYPE NAME rather than dropped — see
 * `DrawingReport`. A drawing that silently loses its hatching looks
 * complete and is not.
 */
export type Entity =
  | { readonly kind: "line"; readonly layer: string; readonly a: Point; readonly b: Point }
  | {
      readonly kind: "polyline";
      readonly layer: string;
      readonly points: readonly Point[];
      readonly closed: boolean;
      /**
       * ⚠️ THE BULGE, PER VERTEX. A LWPOLYLINE's arc segments are encoded
       * as a "bulge" on the vertex the arc STARTS at — the tangent of a
       * quarter of the included angle. Ignoring it turns every rounded
       * corner in the drawing into a chamfer, which is a real change to a
       * real dimension and looks like a rendering choice.
       */
      readonly bulges: readonly number[];
    }
  | {
      readonly kind: "circle";
      readonly layer: string;
      readonly centre: Point;
      readonly radius: number;
    }
  | {
      readonly kind: "arc";
      readonly layer: string;
      readonly centre: Point;
      readonly radius: number;
      /** Degrees, counter-clockwise from +X, as DXF stores them. */
      readonly startAngle: number;
      readonly endAngle: number;
    }
  | {
      readonly kind: "ellipse";
      readonly layer: string;
      readonly centre: Point;
      /** Endpoint of the major axis, RELATIVE to the centre. */
      readonly majorAxis: Point;
      readonly ratio: number;
      readonly startParam: number;
      readonly endParam: number;
    }
  | { readonly kind: "point"; readonly layer: string; readonly at: Point }
  | {
      readonly kind: "text";
      readonly layer: string;
      readonly at: Point;
      readonly text: string;
      readonly height: number;
      /** Degrees. */
      readonly rotation: number;
    }
  | {
      readonly kind: "spline";
      readonly layer: string;
      /**
       * ⚠️ THE CONTROL POINTS, NOT THE CURVE. A spline is rendered
       * through its control polygon's de Boor evaluation in
       * `lib/cad/geometry.ts`, and a spline with fewer control points
       * than its degree requires is reported rather than drawn wrongly.
       */
      readonly controlPoints: readonly Point[];
      readonly degree: number;
      readonly knots: readonly number[];
      readonly closed: boolean;
    }
  | {
      readonly kind: "solid";
      readonly layer: string;
      /** Three or four corners. DXF orders the last two the wrong way round. */
      readonly corners: readonly Point[];
    }
  | {
      /**
       * ⭐ A BLOCK REFERENCE. Doors, windows, title blocks, north arrows,
       * every symbol on the drawing. Resolved against `blocks` at render
       * time rather than expanded at parse time, because a site plan can
       * reference the same door block four thousand times and expanding
       * them is four thousand copies of its geometry in memory.
       */
      readonly kind: "insert";
      readonly layer: string;
      readonly blockName: string;
      readonly at: Point;
      readonly scaleX: number;
      readonly scaleY: number;
      readonly rotation: number;
      /** ⚠️ Arrays of blocks are real: a row of parking bays is one INSERT. */
      readonly columns: number;
      readonly rows: number;
      readonly columnSpacing: number;
      readonly rowSpacing: number;
    };

export type Layer = {
  readonly name: string;
  /**
   * ⭐ THE AutoCAD COLOUR INDEX. Negative means the layer is OFF, which
   * is a real state a drawing relies on — a survey with its levels layer
   * turned off is not a survey with no levels.
   */
  readonly colour: number;
  readonly frozen: boolean;
  readonly locked: boolean;
};

export type Block = {
  readonly name: string;
  readonly basePoint: Point;
  readonly entities: readonly Entity[];
};

/**
 * ⭐⭐ WHAT A DRAWING IS WORTH, HONESTLY.
 *
 * 🔴 `unsupported` IS THE MOST IMPORTANT FIELD IN THIS TYPE. A viewer
 * that drops what it cannot read and shows the rest looks like it worked.
 * The count and the type names go on the screen, so "this drawing has 412
 * HATCH entities Ordence does not draw" is something the customer knows
 * BEFORE they use the view to make a decision.
 */
export type DrawingReport = {
  /** Entity type name → how many were skipped. */
  readonly unsupported: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
};

export type Drawing = {
  readonly entities: readonly Entity[];
  readonly layers: readonly Layer[];
  readonly blocks: Readonly<Record<string, Block>>;
  /** From $EXTMIN/$EXTMAX where present, else computed. */
  readonly bounds: Bounds;
  /** ⭐ From $INSUNITS. `null` when the file does not say — see units.ts. */
  readonly units: DrawingUnit | null;
  readonly report: DrawingReport;
};

/**
 * 🔴 THE UNIT IS THE WHOLE MEASUREMENT. A drawing in millimetres read as
 * metres is out by a factor of a thousand, and the number still looks
 * plausible on a site plan. `$INSUNITS = 0` means "unitless", which is
 * NOT a synonym for millimetres however common that assumption is.
 */
export type DrawingUnit =
  | "unitless"
  | "inches"
  | "feet"
  | "miles"
  | "millimetres"
  | "centimetres"
  | "metres"
  | "kilometres"
  | "microinches"
  | "mils"
  | "yards";
