"use client";

/**
 * Ordence — ⭐⭐⭐ THE DRAWING VIEWER
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FILE IS PARSED AND RENDERED HERE, IN THE BROWSER
 * ══════════════════════════════════════════════════════════════════════
 * Every module under `lib/cad/` is pure — no database, no `node:` — so
 * the same parser and the same renderer run on both sides. A separate
 * server renderer would be a second drawing of the same file, and the two
 * would disagree on exactly the drawings that matter.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS SCREEN REFUSES TO DO
 * ══════════════════════════════════════════════════════════════════════
 * ① IT DOES NOT MEASURE A DRAWING THAT DOES NOT SAY WHAT ITS UNITS ARE.
 *    About a third of DXF files in circulation are exported unitless, and
 *    "unitless" is not a synonym for millimetres however often it turns
 *    out to be. The drawing is SHOWN; the measure tool is not offered
 *    until somebody with `drawings:manage` says what one unit means.
 *
 * ② IT DOES NOT HIDE WHAT IT COULD NOT READ. `report.unsupported` is on
 *    the screen, by entity type and count. A viewer that drops what it
 *    cannot read and shows the rest LOOKS LIKE IT WORKED, and somebody
 *    makes a decision from a drawing that is missing its hatching.
 *
 * ③ IT DOES NOT MODIFY THE ORIGINAL. Markups are an overlay in drawing
 *    coordinates. The file that goes back out is the file that came in.
 */

import { useMemo, useState, useTransition } from "react";
import { Ruler, MessageSquarePlus, TriangleAlert, Layers } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseDxf } from "@/lib/cad/dxf/parse";
import { drawingToSvg } from "@/lib/cad/render/svg";
import {
  measureArea,
  measureLength,
  measurementIsExact,
  strokesOf,
} from "@/lib/cad/geometry";
import { areaToSquareMetres, formatArea, formatLength, toMetres } from "@/lib/cad/units";
import type { DrawingUnit } from "@/lib/cad/types";
import type { ActionResult } from "@/lib/validators/crm";

type AddMarkup = (input: {
  revisionId: string;
  kind: "cloud" | "arrow" | "text" | "dimension" | "highlight" | "pin";
  points: { x: number; y: number }[];
  body?: string;
}) => Promise<ActionResult<{ id: string }>>;

type TakeMeasurement = (input: {
  revisionId: string;
  kind: "length" | "area" | "count";
  label: string;
  layer?: string;
  rawValue: number;
  rawMaxError: number;
  isExact: boolean;
  points: { x: number; y: number }[];
}) => Promise<ActionResult<{ id: string }>>;

export function DrawingViewer({
  revisionId,
  dxfText,
  unit,
  unitWasAssumed,
  canMarkup,
  canMeasure,
  addMarkup,
  takeMeasurement,
}: {
  revisionId: string;
  /** ⚠️ The DXF as text. Fetched once by the page and handed down. */
  dxfText: string;
  unit: DrawingUnit | null;
  unitWasAssumed: boolean;
  canMarkup: boolean;
  canMeasure: boolean;
  addMarkup: AddMarkup;
  takeMeasurement: TakeMeasurement;
}) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [comment, setComment] = useState("");
  const [pending, start] = useTransition();

  /**
   * ⚠️ PARSED ONCE PER FILE, NOT PER RENDER. A 40MB site plan is eight
   * million group-code pairs; re-parsing it when somebody toggles a layer
   * would freeze the tab.
   */
  const drawing = useMemo(() => {
    try {
      return parseDxf(dxfText);
    } catch {
      return null;
    }
  }, [dxfText]);

  const rendered = useMemo(
    () => (drawing ? drawingToSvg(drawing, { hiddenLayers: hidden, withText: true }) : null),
    [drawing, hidden],
  );

  const closedRegions = useMemo(() => {
    if (!drawing) return [];
    return strokesOf(drawing.entities, drawing.blocks)
      .filter((s) => s.closed && s.points.length >= 3)
      .slice(0, 500);
  }, [drawing]);

  if (!drawing || !rendered) {
    return (
      <p className="text-sm text-destructive">
        This revision could not be read. If it opens in CAD, it is most likely made of proxy
        objects from an add-on, which only that add-on can draw.
      </p>
    );
  }

  const unsupported = Object.entries(drawing.report.unsupported);

  function recordLength() {
    if (!drawing || !unit) return;
    const entity = drawing.entities.find((e) => e.kind === "line" || e.kind === "polyline");
    if (!entity) {
      toast.error("There is no line or polyline on this sheet to measure.");
      return;
    }
    const raw = measureLength(entity, drawing.blocks);
    const exact = measurementIsExact(entity);
    start(async () => {
      const result = await takeMeasurement({
        revisionId,
        kind: "length",
        label: label.trim() || "Length",
        layer: entity.layer,
        rawValue: raw,
        rawMaxError: 0,
        isExact: exact,
        points: [],
      });
      if (!result.ok) toast.error(result.error);
      else toast.success(`${formatLength(toMetres(raw, unit), unit)} recorded.`);
    });
  }

  function recordArea(index: number) {
    /**
     * ⚠️ `drawing` IS RE-CHECKED INSIDE THE CLOSURE. The early return
     * above narrows it for the render, and a callback captures the
     * nullable binding rather than the narrowed one — which the compiler
     * is right about and which would be a runtime crash the first time a
     * file failed to parse while a button was already on screen.
     */
    if (!unit || !drawing) return;
    const region = closedRegions[index];
    if (!region) return;
    const measured = measureArea(region.points);
    start(async () => {
      const result = await takeMeasurement({
        revisionId,
        kind: "area",
        label: label.trim() || `Area on ${region.layer}`,
        layer: region.layer,
        rawValue: measured.area,
        rawMaxError: measured.maximumError,
        isExact: measured.exact,
        points: region.points.slice(0, 500).map((p) => ({ x: p.x, y: p.y })),
      });
      if (!result.ok) toast.error(result.error);
      else toast.success(`${formatArea(areaToSquareMetres(measured.area, unit))} recorded.`);
    });
  }

  function raiseComment() {
    if (comment.trim() === "") {
      toast.error("A comment nobody can read is a dot on a drawing.");
      return;
    }
    if (!drawing) return;
    const centreX = (drawing.bounds.minX + drawing.bounds.maxX) / 2;
    const centreY = (drawing.bounds.minY + drawing.bounds.maxY) / 2;
    start(async () => {
      const result = await addMarkup({
        revisionId,
        kind: "text",
        points: [{ x: centreX, y: centreY }],
        body: comment.trim(),
      });
      if (!result.ok) toast.error(result.error);
      else {
        toast.success("Comment raised on this revision.");
        setComment("");
      }
    });
  }

  return (
    <div className="space-y-4">
      {/*
        🔴 ② WHAT WAS NOT DRAWN, BEFORE THE DRAWING RATHER THAN AFTER IT.
      */}
      {unsupported.length > 0 ? (
        <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            Ordence does not draw{" "}
            {unsupported.map(([type, count]) => `${count} ${type}`).join(", ")} from this file.
            What you see below is the rest of it. Open the original in CAD before making a
            decision that depends on those.
          </span>
        </p>
      ) : null}

      {drawing.report.warnings.map((warning) => (
        <p
          key={warning}
          className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
        >
          <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Layers className="h-4 w-4" aria-hidden="true" />
        {drawing.layers.map((layer) => {
          const off = hidden.includes(layer.name) || layer.colour < 0 || layer.frozen;
          return (
            <button
              key={layer.name}
              type="button"
              onClick={() =>
                setHidden((current) =>
                  current.includes(layer.name)
                    ? current.filter((n) => n !== layer.name)
                    : [...current, layer.name],
                )
              }
              className={`rounded-full border px-2.5 py-1 ${
                off ? "border-border text-muted-foreground line-through" : "border-primary/40"
              }`}
            >
              {layer.name}
              {layer.colour < 0 || layer.frozen ? " (off in the file)" : ""}
            </button>
          );
        })}
      </div>

      <div
        className="overflow-hidden rounded-lg border bg-card"
        /* ⚠️ The SVG is produced by our own renderer from our own parse of
           the file. Nothing from the drawing reaches the DOM unescaped —
           `drawingToSvg` escapes every text value it draws. */
        dangerouslySetInnerHTML={{ __html: rendered.svg }}
      />

      <p className="text-xs text-muted-foreground">
        {drawing.entities.length.toLocaleString("en-IN")} entities ·{" "}
        {rendered.strokeCount.toLocaleString("en-IN")} drawn ·{" "}
        {unit
          ? `1 unit = 1 ${unit.replace(/s$/, "")}${unitWasAssumed ? ", assumed by a person" : ", as the file states"}`
          : "this drawing does not state its units"}
      </p>

      {/* ── MEASURE ─────────────────────────────────────────────────── */}
      {canMeasure ? (
        unit ? (
          <div className="space-y-3 rounded-lg border bg-card p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Ruler className="h-4 w-4" aria-hidden="true" />
              Take a measurement
            </h3>
            <div className="space-y-1.5">
              <Label htmlFor="measure-label">What is it</Label>
              <Input
                id="measure-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ground floor slab"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={pending} onClick={recordLength}>
                Measure the first line
              </Button>
              {closedRegions.slice(0, 6).map((region, index) => (
                <Button
                  key={`${region.layer}-${index}`}
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => recordArea(index)}
                >
                  Area of region {index + 1} ({region.layer})
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {/*
                ⭐ THE ERROR BOUND IS EXPLAINED WHERE THE MEASUREMENT IS
                TAKEN, not in a tooltip on a number in a bill.
              */}
              A length along straight segments and arcs is exact. An area enclosing a curve is
              computed from a flattened outline, so it carries a stated error bound, and both go
              into the record with the revision and the unit they came from.
            </p>
          </div>
        ) : (
          <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>
              {/* 🔴 ① */}
              This drawing does not say what one drawing unit means, so nothing can be measured
              off it yet. That is a real state, not a fault — about a third of DXF files are
              exported without it, and it is not the same as millimetres however often it turns
              out to be. Somebody who can manage drawings needs to set it on this revision first.
            </span>
          </p>
        )
      ) : null}

      {/* ── MARK UP ─────────────────────────────────────────────────── */}
      {canMarkup ? (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            Raise a comment
          </h3>
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Check the lintel level against the structural drawing"
          />
          <Button type="button" disabled={pending} onClick={raiseComment}>
            Raise it on this revision
          </Button>
          <p className="text-xs text-muted-foreground">
            {/* ⚠️ ③ */}
            Comments are stored beside the drawing, in the drawing&apos;s own coordinates. The
            original file is never changed, so it goes back to the consultant exactly as it
            arrived. A comment belongs to this revision: when a new one is issued it does not
            follow, because the thing it points at may have moved.
          </p>
        </div>
      ) : null}
    </div>
  );
}
