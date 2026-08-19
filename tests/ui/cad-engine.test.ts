/**
 * Ordence — 🔴🔴🔴 THE DRAWING ENGINE · WAVE 7
 * Version: v1.75.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE CLAIM UNDER TEST
 * ══════════════════════════════════════════════════════════════════════
 * A DXF read by Ordence, exported by Ordence and read again is THE SAME
 * DRAWING — same entities, same curves, same layers, same units. That is
 * what separates a round trip from a viewer that degrades everything it
 * touches into polylines.
 *
 * 🔴 AND THE FOUR THINGS THAT ARE SILENTLY WRONG IN A NAIVE CAD READER:
 *
 *   ① the Y axis is flipped between CAD and SVG, so a viewer that
 *      ignores it MIRRORS every drawing — invisible on a symmetrical
 *      plan, catastrophic on a site layout somebody reads a setback off;
 *   ② the bulge on a polyline vertex encodes an ARC, and dropping it
 *      turns every rounded corner into a chamfer;
 *   ③ SOLID orders its last two corners the wrong way round, and drawing
 *      them in file order produces a bow-tie;
 *   ④ a unitless drawing is not a millimetre drawing, and measuring it
 *      anyway is wrong by a factor of a thousand with a plausible number.
 */

import { describe, expect, it } from "vitest";

import { identifyCadFile, dwgRefusal, lexDxf, DxfLexError } from "@/lib/cad/dxf/lexer";
import { parseDxf } from "@/lib/cad/dxf/parse";
import { exportDxf } from "@/lib/cad/export/dxf";
import { drawingToSvg } from "@/lib/cad/render/svg";
import {
  flattenArc,
  flattenBulge,
  measureArea,
  measureLength,
  measurementIsExact,
  strokesOf,
  boundsOf,
} from "@/lib/cad/geometry";
import { toMetres, areaToSquareMetres, UnknownScaleError, formatArea } from "@/lib/cad/units";

const encoder = new TextEncoder();

/* ================================================================== */
/* A DXF WITH EVERY TRAP IN IT                                        */
/* ================================================================== */

const FIXTURE = [
  "999", "written by hand for the Ordence tests",
  "0", "SECTION", "2", "HEADER",
  "9", "$ACADVER", "1", "AC1009",
  "9", "$INSUNITS", "70", "4",
  "9", "$EXTMIN", "10", "0.0", "20", "0.0", "30", "0.0",
  "9", "$EXTMAX", "10", "4000.0", "20", "3000.0", "30", "0.0",
  "0", "ENDSEC",

  "0", "SECTION", "2", "TABLES",
  "0", "TABLE", "2", "LAYER", "70", "3",
  "0", "LAYER", "2", "0", "70", "0", "62", "7",
  "0", "LAYER", "2", "WALLS", "70", "0", "62", "1",
  /* 🔴 A NEGATIVE COLOUR MEANS THE LAYER IS OFF. */
  "0", "LAYER", "2", "SETTING-OUT", "70", "0", "62", "-5",
  "0", "ENDTAB",
  "0", "ENDSEC",

  "0", "SECTION", "2", "BLOCKS",
  "0", "BLOCK", "8", "0", "2", "DOOR", "70", "0",
  "10", "0.0", "20", "0.0", "30", "0.0", "3", "DOOR", "1", "",
  "0", "LINE", "8", "0", "10", "0.0", "20", "0.0", "30", "0.0",
  "11", "900.0", "21", "0.0", "31", "0.0",
  "0", "ENDBLK", "8", "0",
  "0", "ENDSEC",

  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "WALLS",
  "10", "0.0", "20", "0.0", "30", "0.0",
  "11", "4000.0", "21", "0.0", "31", "0.0",

  /* ⚠️ ② — a closed LWPOLYLINE with a bulge on its third vertex. */
  "0", "LWPOLYLINE", "8", "WALLS", "90", "4", "70", "1",
  "10", "0.0", "20", "0.0",
  "10", "1000.0", "20", "0.0",
  "10", "1000.0", "20", "1000.0", "42", "0.5",
  "10", "0.0", "20", "1000.0",

  "0", "CIRCLE", "8", "WALLS", "10", "2000.0", "20", "1500.0", "30", "0.0", "40", "250.0",
  "0", "ARC", "8", "WALLS", "10", "3000.0", "20", "1500.0", "30", "0.0",
  "40", "500.0", "50", "0.0", "51", "90.0",

  /* ⚠️ ③ — SOLID with its last two corners in file order. */
  "0", "SOLID", "8", "WALLS",
  "10", "0.0", "20", "2000.0", "30", "0.0",
  "11", "500.0", "21", "2000.0", "31", "0.0",
  "12", "0.0", "22", "2500.0", "32", "0.0",
  "13", "500.0", "23", "2500.0", "33", "0.0",

  /* The old three-record polyline, which a 2003 file still uses. */
  "0", "POLYLINE", "8", "WALLS", "66", "1", "70", "0",
  "10", "0.0", "20", "0.0", "30", "0.0",
  "0", "VERTEX", "8", "WALLS", "10", "100.0", "20", "2800.0", "30", "0.0",
  "0", "VERTEX", "8", "WALLS", "10", "900.0", "20", "2800.0", "30", "0.0",
  "0", "SEQEND", "8", "WALLS",

  "0", "TEXT", "8", "WALLS", "10", "100.0", "20", "100.0", "30", "0.0",
  "40", "100.0", "1", "GROUND FLOOR",

  /* MTEXT content is split across repeated 3 pairs with the tail in 1. */
  "0", "MTEXT", "8", "WALLS", "10", "200.0", "20", "200.0", "30", "0.0", "40", "80.0",
  "3", "ALL DIMENSIONS IN ", "1", "MILLIMETRES",

  "0", "INSERT", "8", "WALLS", "2", "DOOR",
  "10", "1500.0", "20", "0.0", "30", "0.0", "50", "90.0",

  /* 🔴 An entity type this engine does not read. It must be COUNTED. */
  "0", "HATCH", "8", "WALLS", "10", "0.0", "20", "0.0",
  "0", "HATCH", "8", "WALLS", "10", "1.0", "20", "1.0",

  "0", "ENDSEC",
  "0", "EOF",
].join("\r\n");

/* ================================================================== */
describe("⭐ identifying what somebody actually uploaded", () => {
  it("recognises an ASCII DXF even with a comment first", () => {
    expect(identifyCadFile(encoder.encode(FIXTURE)).kind).toBe("dxf-ascii");
  });

  it("🔴 recognises a DWG and NAMES the AutoCAD version", () => {
    /*
     * "Unsupported file type" sends the customer to support. Naming the
     * version and the menu path sends them back to their own software,
     * which is where the fix is.
     */
    const dwg = encoder.encode("AC1032    rest of a dwg");
    const kind = identifyCadFile(dwg);
    expect(kind.kind).toBe("dwg");
    if (kind.kind === "dwg") {
      expect(kind.version).toMatch(/2018/);
      expect(dwgRefusal(kind.version)).toMatch(/Files of type/);
      expect(dwgRefusal(kind.version)).toMatch(/DraftSight|LibreCAD/);
    }
  });

  it("recognises a binary DXF rather than reading it as text", () => {
    const binary = encoder.encode("AutoCAD Binary DXF\r\n ");
    expect(identifyCadFile(binary).kind).toBe("dxf-binary");
  });

  it("refuses a group code that is not a number, naming the line", () => {
    expect(() => [...lexDxf("hello\nworld\n")]).toThrow(DxfLexError);
  });

  it("refuses a file that ends mid-pair rather than guessing", () => {
    expect(() => [...lexDxf("0\nSECTION\n2\n")]).toThrow(/truncated/);
  });
});

/* ================================================================== */
describe("🔴 the parser reads what is there and counts what it cannot", () => {
  const drawing = parseDxf(FIXTURE);

  it("reads the units from the header", () => {
    expect(drawing.units).toBe("millimetres");
  });

  it("reads the layers, including the one that is switched off", () => {
    expect(drawing.layers.map((l) => l.name)).toEqual(["0", "WALLS", "SETTING-OUT"]);
    expect(drawing.layers.find((l) => l.name === "SETTING-OUT")!.colour).toBeLessThan(0);
  });

  it("reads every entity kind in the fixture", () => {
    const kinds = drawing.entities.map((e) => e.kind).sort();
    expect(kinds).toContain("line");
    expect(kinds).toContain("polyline");
    expect(kinds).toContain("circle");
    expect(kinds).toContain("arc");
    expect(kinds).toContain("solid");
    expect(kinds).toContain("text");
    expect(kinds).toContain("insert");
  });

  it("🔴 COUNTS the entity type it does not read, by name", () => {
    /*
     * A viewer that drops what it cannot read and shows the rest LOOKS
     * LIKE IT WORKED, and the customer uses it to make a decision about a
     * drawing missing its hatching.
     */
    expect(drawing.report.unsupported.HATCH).toBe(2);
  });

  it("⚠️ ② keeps the bulge on the vertex it belongs to", () => {
    const poly = drawing.entities.find((e) => e.kind === "polyline" && e.closed);
    expect(poly).toBeTruthy();
    if (poly?.kind === "polyline") {
      expect(poly.points).toHaveLength(4);
      /* The bulge is on vertex index 2, not 1 and not 3. */
      expect(poly.bulges[2]).toBe(0.5);
      expect(poly.bulges[1]).toBe(0);
    }
  });

  it("⚠️ ③ un-swaps SOLID's last two corners", () => {
    const solid = drawing.entities.find((e) => e.kind === "solid");
    expect(solid).toBeTruthy();
    if (solid?.kind === "solid") {
      /* In file order the third corner is (0,2500); a sane quad wants (500,2500). */
      expect(solid.corners[2]).toMatchObject({ x: 500, y: 2500 });
      expect(solid.corners[3]).toMatchObject({ x: 0, y: 2500 });
    }
  });

  it("reads the old POLYLINE/VERTEX/SEQEND triple as well as LWPOLYLINE", () => {
    const open = drawing.entities.filter((e) => e.kind === "polyline" && !e.closed);
    expect(open).toHaveLength(1);
  });

  it("assembles MTEXT from its repeated fragments", () => {
    const text = drawing.entities.filter((e) => e.kind === "text");
    const values = text.map((t) => (t.kind === "text" ? t.text : ""));
    expect(values).toContain("ALL DIMENSIONS IN MILLIMETRES");
  });

  it("keeps blocks unexpanded and resolves them at render time", () => {
    expect(Object.keys(drawing.blocks)).toEqual(["DOOR"]);
    const strokes = strokesOf(drawing.entities, drawing.blocks);
    /* The INSERT contributes the block's one line, rotated 90°. */
    const door = strokes.find(
      (s) => s.points.length === 2 && Math.abs(s.points[0]!.x - 1500) < 1e-6,
    );
    expect(door).toBeTruthy();
    expect(door!.points[1]!.y).toBeCloseTo(900, 6);
    expect(door!.points[1]!.x).toBeCloseTo(1500, 6);
  });
});

/* ================================================================== */
describe("⭐ geometry: curves stay curves until the last moment", () => {
  it("flattens an arc to a stated tolerance rather than a fixed count", () => {
    /*
     * A fixed segment count makes a 30mm fillet smooth and a 40m road
     * curve visibly faceted, in the same drawing.
     */
    const small = flattenArc({ x: 0, y: 0, z: 0 }, 10, 0, 90, 0.05);
    const large = flattenArc({ x: 0, y: 0, z: 0 }, 10000, 0, 90, 0.05);
    expect(large.length).toBeGreaterThan(small.length);

    /* Every point is on the circle, to well inside the tolerance. */
    for (const p of large) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 10000)).toBeLessThan(1e-6);
    }
  });

  it("🔴 keeps the SIGN of a bulge, so a fillet is not mirrored", () => {
    /**
     * ⚠️ THIS TEST WAS WRITTEN WITH THE SIGN THE WRONG WAY ROUND, and the
     * code was right. Recording the correction rather than "fixing" the
     * engine to match a wrong expectation.
     *
     * 🔴 THE DERIVATION, so nobody has to re-do it: for counter-clockwise
     * motion the centre of curvature is to the LEFT of the direction of
     * travel. A positive bulge is counter-clockwise (DXF reference), so
     * travelling along +X the centre is ABOVE the chord and the arc
     * therefore bulges BELOW it.
     *
     * ⭐ SANITY CHECK: a rectangle wound counter-clockwise has its
     * interior on the left, so its fillets bulge to the right — outward,
     * which is what a fillet on a convex corner looks like. Consistent.
     *
     * ⭐ AND THE MAGNITUDE IS CHECKED TOO. A bulge of 0.5 over a chord of
     * 100 has a sagitta of exactly 25: (chord / 2) × |bulge|.
     */
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 100, y: 0, z: 0 };
    const positive = flattenBulge(from, to, 0.5);
    const negative = flattenBulge(from, to, -0.5);
    /**
     * ⚠️ THE EXTREME OF THE FLATTENED POINTS, NOT THE MIDDLE ONE. The
     * apex of the true arc does not always land on a sample — the segment
     * count comes from the tolerance, not from a fixed number — so
     * "the middle point" is up to half a segment away from it and the
     * assertion would be about the sampling rather than about the sign.
     */
    const deepest = Math.min(...positive.map((p) => p.y));
    const highest = Math.max(...negative.map((p) => p.y));

    expect(deepest).toBeLessThan(0);
    expect(highest).toBeGreaterThan(0);

    /**
     * ⭐ AND FLATTENING IS INSCRIBED, so the sampled extreme is at most
     * the tolerance short of the true sagitta and never beyond it.
     */
    expect(Math.abs(deepest)).toBeLessThanOrEqual(25);
    expect(Math.abs(deepest)).toBeGreaterThan(25 - 0.5);
    expect(Math.abs(highest)).toBeLessThanOrEqual(25);
    expect(Math.abs(highest)).toBeGreaterThan(25 - 0.5);

    /** A bulge of 1 is a semicircle, by definition: sagitta = radius. */
    const semicircle = flattenBulge(from, to, 1);
    const apex = Math.min(...semicircle.map((p) => p.y));
    expect(apex).toBeLessThan(0);
    expect(Math.abs(apex)).toBeGreaterThan(49.5);
    expect(Math.abs(apex)).toBeLessThanOrEqual(50);
  });

  it("🔴 measures a LINE, a CIRCLE, an ARC and a POLYLINE exactly", () => {
    const drawing = parseDxf(FIXTURE);
    const circle = drawing.entities.find((e) => e.kind === "circle")!;
    expect(measureLength(circle, drawing.blocks)).toBeCloseTo(2 * Math.PI * 250, 9);
    expect(measurementIsExact(circle)).toBe(true);

    const arc = drawing.entities.find((e) => e.kind === "arc")!;
    /* A quarter of a 500-radius circle. rθ, exactly. */
    expect(measureLength(arc, drawing.blocks)).toBeCloseTo((Math.PI * 500) / 2, 9);

    const line = drawing.entities.find((e) => e.kind === "line")!;
    expect(measureLength(line, drawing.blocks)).toBe(4000);
  });

  it("⚠️ returns an ERROR BOUND with every area, because it is not exact", () => {
    /*
     * An area used to price concrete, given to nine decimal places with
     * no error bound, is a number somebody will treat as exact.
     */
    const square = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
      { x: 1000, y: 1000, z: 0 },
      { x: 0, y: 1000, z: 0 },
    ];
    const measured = measureArea(square, 0.05);
    expect(measured.area).toBe(1000000);
    expect(measured.maximumError).toBeGreaterThan(0);
    expect(measureArea(square, 0.05, true).maximumError).toBe(0);
  });

  it("computes bounds when the header does not give them", () => {
    const drawing = parseDxf(FIXTURE);
    const bounds = boundsOf(drawing.entities, drawing.blocks);
    expect(bounds.minX).toBeLessThanOrEqual(0);
    expect(bounds.maxX).toBeGreaterThanOrEqual(3500);
  });
});

/* ================================================================== */
describe("🔴 ④ a unitless drawing is not a millimetre drawing", () => {
  it("refuses to convert a length without a unit", () => {
    expect(() => toMetres(1000, null)).toThrow(UnknownScaleError);
    expect(() => toMetres(1000, "unitless")).toThrow(/does not say what one drawing unit means/);
  });

  it("converts correctly once somebody says", () => {
    expect(toMetres(1000, "millimetres")).toBe(1);
    expect(toMetres(1, "feet")).toBeCloseTo(0.3048, 9);
  });

  it("⚠️ scales AREA by the square, not by the factor", () => {
    /* One square metre is 1,000,000 square millimetres, not 1,000. */
    expect(areaToSquareMetres(1000000, "millimetres")).toBeCloseTo(1, 9);
  });

  it("gives an Indian plot area in hectares and acres as well", () => {
    const formatted = formatArea(4046.8564224);
    expect(formatted).toMatch(/acre/);
    expect(formatted).toMatch(/1\.0000 acre/);
  });

  it("warns on the drawing rather than staying silent", () => {
    const noUnits = FIXTURE.replace("$INSUNITS", "$NOPE");
    const drawing = parseDxf(noUnits);
    expect(drawing.units).toBeNull();
    expect(drawing.report.warnings.join(" ")).toMatch(/does not state its units/);
  });
});

/* ================================================================== */
describe("🔴 ① the SVG is not mirrored", () => {
  const drawing = parseDxf(FIXTURE);
  const rendered = drawingToSvg(drawing, { withText: true });

  it("flips Y exactly once, on the root group", () => {
    expect(rendered.svg).toContain('<g transform="translate(0 3000) scale(1 -1)">');
  });

  it("leaves out a layer the drawing itself switched off", () => {
    expect(rendered.svg).not.toContain('data-layer="SETTING-OUT"');
  });

  it("groups by layer, so the viewer can toggle them", () => {
    expect(rendered.svg).toContain('data-layer="WALLS"');
  });

  it("scales the stroke width from the drawing, not a constant", () => {
    /* A fixed width is invisible on a 400m site plan and solid on a 20mm detail. */
    const width = Number(rendered.svg.match(/stroke-width="([\d.]+)"/)![1]);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(10);
  });

  it("escapes text that came out of the customer's drawing", () => {
    const hostile = FIXTURE.replace("GROUND FLOOR", "</text><script>x</script>");
    const out = drawingToSvg(parseDxf(hostile), { withText: true });
    expect(out.svg).not.toContain("<script>");
    expect(out.svg).toContain("&lt;script&gt;");
  });
});

/* ================================================================== */
describe("⭐⭐⭐ the round trip: out and back is the same drawing", () => {
  const original = parseDxf(FIXTURE);
  const exported = exportDxf(original);
  const reread = parseDxf(exported.text);

  it("keeps the units", () => {
    expect(reread.units).toBe(original.units);
  });

  it("keeps every layer, its colour and its off state", () => {
    expect(reread.layers.map((l) => `${l.name}:${l.colour}`)).toEqual(
      original.layers.map((l) => `${l.name}:${l.colour}`),
    );
  });

  it("🔴 keeps an ARC as an ARC, not as forty short segments", () => {
    const before = original.entities.filter((e) => e.kind === "arc");
    const after = reread.entities.filter((e) => e.kind === "arc");
    expect(after).toHaveLength(before.length);
    expect(after[0]).toMatchObject({ radius: 500, startAngle: 0, endAngle: 90 });
  });

  it("🔴 keeps the bulge, so a rounded corner does not become a chamfer", () => {
    const before = original.entities.find((e) => e.kind === "polyline" && e.closed);
    const after = reread.entities.find((e) => e.kind === "polyline" && e.closed);
    expect(after).toBeTruthy();
    if (before?.kind === "polyline" && after?.kind === "polyline") {
      expect(after.bulges[2]).toBeCloseTo(before.bulges[2]!, 9);
      expect(after.closed).toBe(true);
    }
  });

  it("keeps the block and its placement", () => {
    expect(Object.keys(reread.blocks)).toEqual(["DOOR"]);
    const insert = reread.entities.find((e) => e.kind === "insert");
    expect(insert).toMatchObject({ blockName: "DOOR", rotation: 90 });
  });

  it("measures the same after the round trip", () => {
    const lengthOf = (d: typeof original) =>
      d.entities.reduce((total, e) => total + measureLength(e, d.blocks), 0);
    expect(lengthOf(reread)).toBeCloseTo(lengthOf(original), 6);
  });

  it("⚠️ says what the original had that the export does not", () => {
    /* The two HATCH entities. Stated, not silently absent. */
    expect(exported.notes.join(" ")).toMatch(/HATCH/);
    expect(exported.notes.join(" ")).toMatch(/Keep the original as the master/);
  });

  it("writes no coordinate in exponent notation", () => {
    /*
     * `String(1e-7)` is `"1e-7"`, which most DXF readers parse as `1` and
     * then choke on the `e` — one line in the wrong place, in a file that
     * opens.
     */
    const tiny = exportDxf({
      ...original,
      entities: [
        {
          kind: "line",
          layer: "0",
          a: { x: 0.0000001, y: 0, z: 0 },
          b: { x: 1e21, y: 0, z: 0 },
        },
      ],
    });
    expect(tiny.text).not.toMatch(/\de[+-]\d/i);
  });

  it("always writes layer 0, even when the drawing did not declare it", () => {
    const withoutZero = exportDxf({ ...original, layers: [] });
    expect(withoutZero.text).toContain("LAYER");
  });
});
