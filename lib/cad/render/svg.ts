/**
 * Ordence — ⭐⭐⭐ THE DRAWING, AS SVG
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY SVG IS THE VIEWER AND NOT A CANVAS
 * ══════════════════════════════════════════════════════════════════════
 * A canvas viewer needs a render loop, a hit-test implementation, its own
 * zoom maths and a rasteriser for export. SVG gives all four free: the
 * browser pans and zooms it, `pointer-events` hit-tests it, and the same
 * bytes ARE the export — an SVG of a site plan opens in Illustrator,
 * Inkscape, a browser and Word.
 *
 * ⚠️ AND IT IS THE SAME RENDERER ON BOTH SIDES. The server produces a
 * thumbnail with this function; the browser produces the interactive view
 * with this function. A separate server renderer would be a second
 * drawing of the same file, and the two would disagree on exactly the
 * drawings that matter.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE Y AXIS IS FLIPPED, AND FORGETTING IT IS THE CLASSIC CAD BUG
 * ══════════════════════════════════════════════════════════════════════
 * CAD's Y increases upward. SVG's Y increases downward. A viewer that
 * ignores this shows every drawing MIRRORED — which is not obviously
 * wrong on a symmetrical plan, and is catastrophically wrong on a site
 * layout where somebody reads a setback off the picture.
 *
 * The flip is one `transform` on the root group, so no coordinate in this
 * file is negated by hand and there is nowhere for half of them to be
 * missed.
 */

import { strokesOf, type Stroke } from "../geometry";
import type { Drawing, Layer } from "../types";

/**
 * ⭐ THE AutoCAD COLOUR INDEX, for the seven colours that carry meaning.
 *
 * ⚠️ ACI 7 IS "BLACK OR WHITE" AND MEANS "THE OPPOSITE OF THE
 * BACKGROUND". It is the most common colour in every drawing, and
 * rendering it as literal black on a dark viewer makes most of the
 * drawing invisible. It is resolved against the background here.
 */
const ACI: Readonly<Record<number, string>> = Object.freeze({
  1: "#ff0000",
  2: "#ffff00",
  3: "#00ff00",
  4: "#00ffff",
  5: "#0000ff",
  6: "#ff00ff",
  8: "#808080",
  9: "#c0c0c0",
  30: "#ff7f00",
  250: "#333333",
  251: "#5b5b5b",
  252: "#848484",
  253: "#adadad",
  254: "#d6d6d6",
  255: "#ffffff",
});

export type SvgOptions = {
  readonly background?: "light" | "dark";
  /** Layers to leave out. A drawing's OFF layers are excluded by default. */
  readonly hiddenLayers?: readonly string[];
  readonly width?: number;
  readonly height?: number;
  readonly tolerance?: number;
  /** Draw TEXT entities. Off for a thumbnail: text at 3mm is noise there. */
  readonly withText?: boolean;
};

export type SvgResult = {
  readonly svg: string;
  readonly warnings: readonly string[];
  readonly strokeCount: number;
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colourFor(layer: Layer | undefined, background: "light" | "dark"): string {
  const fallback = background === "dark" ? "#e6e6e6" : "#1a1a1a";
  if (!layer) return fallback;
  const index = Math.abs(layer.colour);
  if (index === 7 || index === 0) return fallback;
  return ACI[index] ?? fallback;
}

/** Six decimals is a micron on a kilometre. More is bytes for nothing. */
const round = (value: number): string => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function pathOf(stroke: Stroke): string {
  if (stroke.points.length === 0) return "";
  const [first, ...rest] = stroke.points;
  let d = `M${round(first!.x)} ${round(first!.y)}`;
  for (const p of rest) d += `L${round(p.x)} ${round(p.y)}`;
  if (stroke.closed) d += "Z";
  return d;
}

export function drawingToSvg(drawing: Drawing, options: SvgOptions = {}): SvgResult {
  const background = options.background ?? "light";
  const warnings: string[] = [];
  const hidden = new Set(options.hiddenLayers ?? []);

  /**
   * ⭐ A LAYER TURNED OFF IN THE DRAWING STAYS OFF, and that is not a
   * default we invented — a survey with its levels layer off is not a
   * survey with no levels, and showing them anyway contradicts what the
   * person who drew it decided.
   */
  const layerByName = new Map(drawing.layers.map((l) => [l.name, l]));
  for (const layer of drawing.layers) {
    if (layer.colour < 0 || layer.frozen) hidden.add(layer.name);
  }

  const strokes = strokesOf(drawing.entities, drawing.blocks, {
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
    onWarning: (message) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
  }).filter((stroke) => !hidden.has(stroke.layer));

  const { minX, minY, maxX, maxY } = drawing.bounds;
  const width = Math.max(1e-6, maxX - minX);
  const height = Math.max(1e-6, maxY - minY);
  /** A little air, so a boundary line is not flush against the edge. */
  const pad = Math.max(width, height) * 0.02;

  /**
   * 🔴 THE STROKE WIDTH IS DERIVED FROM THE DRAWING'S SIZE, not fixed.
   * A fixed `stroke-width="1"` is invisible on a 400-metre site plan
   * measured in millimetres, and a solid black block on a 20mm detail.
   */
  const strokeWidth = Math.max(width, height) / 1400;

  const byLayer = new Map<string, Stroke[]>();
  for (const stroke of strokes) {
    const list = byLayer.get(stroke.layer) ?? [];
    list.push(stroke);
    byLayer.set(stroke.layer, list);
  }

  const groups: string[] = [];
  for (const [name, list] of byLayer) {
    const colour = colourFor(layerByName.get(name), background);
    const paths: string[] = [];
    const texts: string[] = [];

    for (const stroke of list) {
      if (stroke.text) {
        if (!options.withText) continue;
        const at = stroke.points[0]!;
        /**
         * ⚠️ THE TEXT IS FLIPPED BACK. The root group flips Y for the
         * whole drawing; without a second flip here every label reads
         * upside down and mirrored.
         */
        texts.push(
          `<text x="${round(at.x)}" y="${round(-at.y)}" font-size="${round(stroke.text.height)}" ` +
            `fill="${colour}" transform="translate(0 ${round(2 * at.y)}) scale(1 -1) ` +
            `rotate(${round(-stroke.text.rotation)} ${round(at.x)} ${round(at.y)})" ` +
            `dominant-baseline="hanging">${escapeXml(stroke.text.value)}</text>`,
        );
        continue;
      }
      if (stroke.points.length === 1) {
        const p = stroke.points[0]!;
        paths.push(
          `<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${round(strokeWidth * 2)}" fill="${colour}"/>`,
        );
        continue;
      }
      const d = pathOf(stroke);
      if (d) paths.push(`<path d="${d}"/>`);
    }

    groups.push(
      `<g data-layer="${escapeXml(name)}" stroke="${colour}" fill="none" ` +
        `stroke-width="${round(strokeWidth)}" stroke-linecap="round" ` +
        `stroke-linejoin="round">${paths.join("")}${texts.join("")}</g>`,
    );
  }

  /**
   * 🔴 THE FLIP, IN ONE PLACE. See the header. `translate(0, maxY+minY)`
   * then `scale(1,-1)` maps the drawing's Y range onto the same range
   * with the axis reversed, so the viewBox below is in drawing
   * coordinates and a caller can reason about it.
   */
  const flip = `translate(0 ${round(minY + maxY)}) scale(1 -1)`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${round(minX - pad)} ${round(minY - pad)} ${round(width + pad * 2)} ${round(height + pad * 2)}" ` +
    (options.width ? `width="${options.width}" ` : "") +
    (options.height ? `height="${options.height}" ` : "") +
    `role="img" aria-label="CAD drawing">` +
    `<rect x="${round(minX - pad)}" y="${round(minY - pad)}" width="${round(width + pad * 2)}" ` +
    `height="${round(height + pad * 2)}" fill="${background === "dark" ? "#12151a" : "#ffffff"}"/>` +
    `<g transform="${flip}">${groups.join("")}</g>` +
    `</svg>`;

  return { svg, warnings, strokeCount: strokes.length };
}
