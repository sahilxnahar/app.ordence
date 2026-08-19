/**
 * Ordence — ⭐⭐⭐ THE GEOMETRY: FLATTENING, BOUNDS, LENGTH AND AREA
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ FLATTENING HAPPENS HERE AND NOWHERE ELSE
 * ══════════════════════════════════════════════════════════════════════
 * `lib/cad/dxf/parse.ts` keeps an arc as an arc. This file turns it into
 * points, with a STATED tolerance, and only for the two things that need
 * points: drawing it, and measuring an enclosed area.
 *
 * ⚠️ THE TOLERANCE IS A SAGITTA, NOT A SEGMENT COUNT. A fixed count of
 * segments makes a 30mm fillet smooth and a 40m road curve visibly
 * faceted, in the same drawing, because a circle's error depends on its
 * radius. Bounding the maximum deviation from the true arc means both are
 * as accurate as each other, and the number is expressed in DRAWING
 * UNITS so it can be compared against the drawing's own tolerances.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 LENGTH IS EXACT, AREA IS NOT, AND THE DIFFERENCE IS DECLARED
 * ══════════════════════════════════════════════════════════════════════
 * The length of an arc is rθ — a closed form, exact to the last digit.
 * The area enclosed by a polygon with arcs in it is computed from the
 * flattened outline, so it is an approximation bounded by the tolerance.
 *
 * ⚠️ `measureArea` RETURNS THAT BOUND ALONGSIDE THE NUMBER, and the
 * screen shows it. An area used to price concrete, given to nine decimal
 * places with no error bound, is a number somebody will treat as exact.
 */

import type { Block, Bounds, Entity, Point } from "./types";

/** ⭐ Maximum deviation from the true curve, in drawing units. */
export const DEFAULT_TOLERANCE = 0.05;

/** ⚠️ Even a hairline curve gets this many, so a tiny circle is a circle. */
const MIN_SEGMENTS = 8;
/** And a bound, because a 10km arc at 0.05 tolerance is 100,000 segments. */
const MAX_SEGMENTS = 512;

export const EMPTY_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/* ------------------------------------------------------------------ */
/* TRANSFORMS                                                          */
/* ------------------------------------------------------------------ */

export type Transform = {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
};

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function apply(t: Transform, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f, z: p.z };
}

export function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function insertTransform(
  at: Point,
  scaleX: number,
  scaleY: number,
  rotationDegrees: number,
  basePoint: Point,
): Transform {
  const angle = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  /**
   * ⚠️ THE BLOCK'S BASE POINT IS SUBTRACTED FIRST. A block whose base
   * point is not the origin — most title blocks — lands at the wrong
   * place otherwise, offset by exactly the base point, which looks like a
   * scaling bug and is not.
   */
  const sx = scaleX * cos;
  const sy = scaleY * cos;
  return {
    a: sx,
    b: scaleX * sin,
    c: -scaleY * sin,
    d: sy,
    e: at.x - (basePoint.x * scaleX * cos - basePoint.y * scaleY * sin),
    f: at.y - (basePoint.x * scaleX * sin + basePoint.y * scaleY * cos),
  };
}

/* ------------------------------------------------------------------ */
/* FLATTENING                                                          */
/* ------------------------------------------------------------------ */

function segmentsFor(radius: number, sweepRadians: number, tolerance: number): number {
  if (radius <= 0) return MIN_SEGMENTS;
  /**
   * The half-angle whose sagitta equals the tolerance:
   *   sagitta = r(1 - cos(θ/2))  ⇒  θ = 2·acos(1 - tol/r)
   */
  const ratio = Math.min(1, tolerance / radius);
  const perSegment = 2 * Math.acos(Math.max(-1, 1 - ratio));
  if (!Number.isFinite(perSegment) || perSegment <= 0) return MAX_SEGMENTS;
  return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.ceil(Math.abs(sweepRadians) / perSegment)));
}

export function flattenArc(
  centre: Point,
  radius: number,
  startDegrees: number,
  endDegrees: number,
  tolerance = DEFAULT_TOLERANCE,
): Point[] {
  const start = (startDegrees * Math.PI) / 180;
  let end = (endDegrees * Math.PI) / 180;
  /** ⚠️ DXF arcs are always counter-clockwise from start to end. */
  while (end <= start) end += Math.PI * 2;
  const sweep = end - start;
  const count = segmentsFor(radius, sweep, tolerance);
  const out: Point[] = [];
  for (let i = 0; i <= count; i += 1) {
    const angle = start + (sweep * i) / count;
    out.push({
      x: centre.x + radius * Math.cos(angle),
      y: centre.y + radius * Math.sin(angle),
      z: centre.z,
    });
  }
  return out;
}

/**
 * ⭐⭐ THE BULGE. `bulge = tan(θ/4)` where θ is the included angle of the
 * arc from this vertex to the next.
 *
 * 🔴 THE SIGN IS THE DIRECTION. Negative is clockwise. Taking the
 * absolute value — which is the obvious way to make the maths behave —
 * mirrors every concave fillet in the drawing into a convex one.
 */
export function flattenBulge(
  from: Point,
  to: Point,
  bulge: number,
  tolerance = DEFAULT_TOLERANCE,
): Point[] {
  if (bulge === 0) return [to];

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return [to];

  const included = 4 * Math.atan(Math.abs(bulge));
  const radius = chord / (2 * Math.sin(included / 2));
  /** Perpendicular offset from the chord's midpoint to the centre. */
  const sagitta = (chord / 2) * Math.abs(bulge);
  const height = radius - sagitta;
  const sign = bulge > 0 ? 1 : -1;

  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const centre: Point = {
    x: midX - (sign * height * dy) / chord,
    y: midY + (sign * height * dx) / chord,
    z: from.z,
  };

  const startAngle = Math.atan2(from.y - centre.y, from.x - centre.x);
  const endAngle = Math.atan2(to.y - centre.y, to.x - centre.x);
  let sweep = endAngle - startAngle;
  if (sign > 0) {
    while (sweep <= 0) sweep += Math.PI * 2;
  } else {
    while (sweep >= 0) sweep -= Math.PI * 2;
  }

  const count = segmentsFor(radius, sweep, tolerance);
  const out: Point[] = [];
  for (let i = 1; i <= count; i += 1) {
    const angle = startAngle + (sweep * i) / count;
    out.push({
      x: centre.x + radius * Math.cos(angle),
      y: centre.y + radius * Math.sin(angle),
      z: from.z,
    });
  }
  return out;
}

export function flattenPolyline(
  points: readonly Point[],
  bulges: readonly number[],
  closed: boolean,
  tolerance = DEFAULT_TOLERANCE,
): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [points[0]!];
  const limit = closed ? points.length : points.length - 1;
  for (let i = 0; i < limit; i += 1) {
    const from = points[i]!;
    const to = points[(i + 1) % points.length]!;
    out.push(...flattenBulge(from, to, bulges[i] ?? 0, tolerance));
  }
  return out;
}

export function flattenEllipse(
  centre: Point,
  majorAxis: Point,
  ratio: number,
  startParam: number,
  endParam: number,
  tolerance = DEFAULT_TOLERANCE,
): Point[] {
  const major = Math.hypot(majorAxis.x, majorAxis.y);
  const minor = major * ratio;
  const rotation = Math.atan2(majorAxis.y, majorAxis.x);
  let end = endParam;
  while (end <= startParam) end += Math.PI * 2;
  const count = segmentsFor(Math.max(major, minor), end - startParam, tolerance);

  const out: Point[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = startParam + ((end - startParam) * i) / count;
    const x = major * Math.cos(t);
    const y = minor * Math.sin(t);
    out.push({
      x: centre.x + x * Math.cos(rotation) - y * Math.sin(rotation),
      y: centre.y + x * Math.sin(rotation) + y * Math.cos(rotation),
      z: centre.z,
    });
  }
  return out;
}

/**
 * ⭐ A B-SPLINE, EVALUATED THROUGH de BOOR.
 *
 * ⚠️ IT FALLS BACK TO THE CONTROL POLYGON WHEN THE KNOT VECTOR IS
 * MISSING OR THE WRONG LENGTH, AND SAYS SO IN THE RETURN. Some exporters
 * write control points and no knots. A silent fallback would draw a
 * visibly wrong curve; the flag lets the caller report it.
 */
export function flattenSpline(
  controlPoints: readonly Point[],
  degree: number,
  knots: readonly number[],
  tolerance = DEFAULT_TOLERANCE,
): { points: Point[]; approximated: boolean } {
  const n = controlPoints.length;
  if (n < 2) return { points: [...controlPoints], approximated: true };

  const p = Math.max(1, Math.min(degree, n - 1));
  const expected = n + p + 1;
  if (knots.length !== expected) {
    return { points: [...controlPoints], approximated: true };
  }

  const span = knots[n]! - knots[p]!;
  if (!(span > 0)) return { points: [...controlPoints], approximated: true };

  /** Segment count from the control polygon's length, not from a constant. */
  let polygonLength = 0;
  for (let i = 1; i < n; i += 1) {
    polygonLength += Math.hypot(
      controlPoints[i]!.x - controlPoints[i - 1]!.x,
      controlPoints[i]!.y - controlPoints[i - 1]!.y,
    );
  }
  const count = Math.max(
    MIN_SEGMENTS,
    Math.min(MAX_SEGMENTS, Math.ceil(polygonLength / Math.max(tolerance * 20, 1e-9))),
  );

  const evaluate = (t: number): Point => {
    /** Find the knot span. */
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]!) k += 1;

    const d: Point[] = [];
    for (let j = 0; j <= p; j += 1) d.push(controlPoints[k - p + j]!);

    for (let r = 1; r <= p; r += 1) {
      for (let j = p; j >= r; j -= 1) {
        const i = k - p + j;
        const denominator = knots[i + p - r + 1]! - knots[i]!;
        const alpha = denominator === 0 ? 0 : (t - knots[i]!) / denominator;
        const previous = d[j - 1]!;
        const currentPoint = d[j]!;
        d[j] = {
          x: (1 - alpha) * previous.x + alpha * currentPoint.x,
          y: (1 - alpha) * previous.y + alpha * currentPoint.y,
          z: (1 - alpha) * previous.z + alpha * currentPoint.z,
        };
      }
    }
    return d[p]!;
  };

  const points: Point[] = [];
  for (let i = 0; i <= count; i += 1) {
    points.push(evaluate(knots[p]! + (span * i) / count));
  }
  return { points, approximated: false };
}

/* ------------------------------------------------------------------ */
/* ONE ENTITY → POLYLINES, WITH TRANSFORMS AND BLOCKS RESOLVED        */
/* ------------------------------------------------------------------ */

export type Stroke = {
  readonly layer: string;
  readonly points: readonly Point[];
  readonly closed: boolean;
  /** Present for a TEXT entity, which is drawn rather than stroked. */
  readonly text?: { readonly value: string; readonly height: number; readonly rotation: number };
};

/** ⚠️ Blocks can nest. This bound stops a self-referencing one hanging. */
const MAX_BLOCK_DEPTH = 16;

export function strokesOf(
  entities: readonly Entity[],
  blocks: Readonly<Record<string, Block>>,
  options: {
    readonly transform?: Transform;
    readonly tolerance?: number;
    readonly depth?: number;
    readonly onWarning?: (message: string) => void;
  } = {},
): Stroke[] {
  const transform = options.transform ?? IDENTITY;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const depth = options.depth ?? 0;
  const out: Stroke[] = [];

  const move = (points: readonly Point[]) => points.map((p) => apply(transform, p));

  for (const entity of entities) {
    switch (entity.kind) {
      case "line":
        out.push({ layer: entity.layer, points: move([entity.a, entity.b]), closed: false });
        break;
      case "polyline":
        out.push({
          layer: entity.layer,
          points: move(flattenPolyline(entity.points, entity.bulges, entity.closed, tolerance)),
          closed: entity.closed,
        });
        break;
      case "circle":
        out.push({
          layer: entity.layer,
          points: move(flattenArc(entity.centre, entity.radius, 0, 360, tolerance)),
          closed: true,
        });
        break;
      case "arc":
        out.push({
          layer: entity.layer,
          points: move(
            flattenArc(entity.centre, entity.radius, entity.startAngle, entity.endAngle, tolerance),
          ),
          closed: false,
        });
        break;
      case "ellipse":
        out.push({
          layer: entity.layer,
          points: move(
            flattenEllipse(
              entity.centre,
              entity.majorAxis,
              entity.ratio,
              entity.startParam,
              entity.endParam,
              tolerance,
            ),
          ),
          closed: Math.abs(entity.endParam - entity.startParam) >= Math.PI * 2 - 1e-9,
        });
        break;
      case "spline": {
        const flat = flattenSpline(entity.controlPoints, entity.degree, entity.knots, tolerance);
        if (flat.approximated) {
          options.onWarning?.(
            `A spline on layer "${entity.layer}" has no usable knot vector, so it is drawn ` +
              `through its control points rather than as the curve. It is close, and it is not ` +
              `the curve — do not measure it.`,
          );
        }
        out.push({ layer: entity.layer, points: move(flat.points), closed: entity.closed });
        break;
      }
      case "solid":
        out.push({ layer: entity.layer, points: move(entity.corners), closed: true });
        break;
      case "point":
        out.push({ layer: entity.layer, points: move([entity.at]), closed: false });
        break;
      case "text":
        out.push({
          layer: entity.layer,
          points: move([entity.at]),
          closed: false,
          text: { value: entity.text, height: entity.height, rotation: entity.rotation },
        });
        break;
      case "insert": {
        if (depth >= MAX_BLOCK_DEPTH) {
          options.onWarning?.(
            `Block "${entity.blockName}" is nested more than ${MAX_BLOCK_DEPTH} deep, or refers ` +
              `to itself. It has been left out rather than drawn forever.`,
          );
          break;
        }
        const block = blocks[entity.blockName];
        if (!block) {
          options.onWarning?.(
            `The drawing places block "${entity.blockName}", which is not defined in the file. ` +
              `Its symbol is missing from the view — usually a sign the DXF was exported without ` +
              `its externally referenced drawings.`,
          );
          break;
        }
        /** ⚠️ Arrays of blocks are real: a row of parking bays is one INSERT. */
        for (let column = 0; column < entity.columns; column += 1) {
          for (let row = 0; row < entity.rows; row += 1) {
            const at: Point = {
              x: entity.at.x + column * entity.columnSpacing,
              y: entity.at.y + row * entity.rowSpacing,
              z: entity.at.z,
            };
            const local = insertTransform(
              at,
              entity.scaleX,
              entity.scaleY,
              entity.rotation,
              block.basePoint,
            );
            out.push(
              ...strokesOf(block.entities, blocks, {
                transform: compose(transform, local),
                tolerance,
                depth: depth + 1,
                ...(options.onWarning ? { onWarning: options.onWarning } : {}),
              }),
            );
          }
        }
        break;
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* BOUNDS                                                              */
/* ------------------------------------------------------------------ */

export function boundsOf(
  entities: readonly Entity[],
  blocks: Readonly<Record<string, Block>>,
): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokesOf(entities, blocks)) {
    for (const p of stroke.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }

  if (!Number.isFinite(minX)) return EMPTY_BOUNDS;
  return { minX, minY, maxX, maxY };
}

/* ------------------------------------------------------------------ */
/* MEASUREMENT                                                         */
/* ------------------------------------------------------------------ */

/** ⭐ EXACT. rθ for an arc, √(dx²+dy²) for a segment. No flattening. */
export function measureLength(entity: Entity, blocks: Readonly<Record<string, Block>>): number {
  switch (entity.kind) {
    case "line":
      return Math.hypot(entity.b.x - entity.a.x, entity.b.y - entity.a.y);
    case "circle":
      return 2 * Math.PI * entity.radius;
    case "arc": {
      let sweep = entity.endAngle - entity.startAngle;
      while (sweep <= 0) sweep += 360;
      return (sweep * Math.PI * entity.radius) / 180;
    }
    case "polyline": {
      let total = 0;
      const limit = entity.closed ? entity.points.length : entity.points.length - 1;
      for (let i = 0; i < limit; i += 1) {
        const from = entity.points[i]!;
        const to = entity.points[(i + 1) % entity.points.length]!;
        const bulge = entity.bulges[i] ?? 0;
        const chord = Math.hypot(to.x - from.x, to.y - from.y);
        if (bulge === 0) {
          total += chord;
          continue;
        }
        /** ⭐ Exact for the arc too: r·θ, both derived from the bulge. */
        const included = 4 * Math.atan(Math.abs(bulge));
        const radius = chord / (2 * Math.sin(included / 2));
        total += radius * included;
      }
      return total;
    }
    default: {
      /**
       * ⚠️ EVERYTHING ELSE IS MEASURED FROM ITS FLATTENED FORM, which is
       * an approximation. `measurementIsExact` below is how a caller
       * knows which it got.
       */
      let total = 0;
      for (const stroke of strokesOf([entity], blocks)) {
        for (let i = 1; i < stroke.points.length; i += 1) {
          total += Math.hypot(
            stroke.points[i]!.x - stroke.points[i - 1]!.x,
            stroke.points[i]!.y - stroke.points[i - 1]!.y,
          );
        }
      }
      return total;
    }
  }
}

export function measurementIsExact(entity: Entity): boolean {
  return (
    entity.kind === "line" ||
    entity.kind === "circle" ||
    entity.kind === "arc" ||
    entity.kind === "polyline"
  );
}

export type AreaMeasurement = {
  readonly area: number;
  /** ⚠️ Absolute, in drawing units squared. Shown beside the number. */
  readonly maximumError: number;
  readonly exact: boolean;
};

/**
 * ⭐⭐ THE SHOELACE FORMULA over the flattened outline.
 *
 * 🔴 THE ERROR BOUND IS RETURNED, NOT HIDDEN. Flattening a curve INSIDE
 * the true outline understates the area by at most (perimeter × tolerance
 * / 2). An area used to price concrete, given to nine decimal places with
 * no error bound, is a number somebody will treat as exact.
 */
export function measureArea(
  points: readonly Point[],
  tolerance = DEFAULT_TOLERANCE,
  exact = false,
): AreaMeasurement {
  if (points.length < 3) return { area: 0, maximumError: 0, exact: true };

  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }

  return {
    area: Math.abs(twiceArea / 2),
    maximumError: exact ? 0 : (perimeter * tolerance) / 2,
    exact,
  };
}
