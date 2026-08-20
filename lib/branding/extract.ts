/**
 * Ordence — Reading the palette out of the logo
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THE COLOUR IS DERIVED AND NOT ASKED FOR
 * ══════════════════════════════════════════════════════════════════════
 * The person setting this up is a bookkeeper on their first morning in a
 * new ledger. They have a logo file. They do not have `#1D4ED8`, and
 * asking them for it produces either a blank field or a wrong answer that
 * nobody notices for a year.
 *
 * So the colour comes out of the image, and the screen offers ALTERNATES.
 * The algorithm gets the dominant colour wrong often enough — a logo with
 * a large flat background, a photographic mark, a wordmark in grey with
 * one small coloured device — that "correct it in one click" has to be
 * part of the design rather than a settings page they find later.
 *
 * ⚠️ PURE, AND TAKES PIXELS RATHER THAN A FILE. The caller (a client
 * component) does the `<canvas>` work; this module does the counting. A
 * function that took a `File` would need a DOM and could only be tested
 * by driving a browser, which in practice means it would not be tested.
 */

import { parseHex, relativeLuminance, rgbToHsl, toHex, type Rgb } from "./color";

export type PaletteCandidate = {
  hex: string;
  /** Share of the counted pixels, 0–1. */
  weight: number;
};

/** How coarsely colours are grouped before counting. 16 levels per channel. */
const QUANTISE = 16;

/**
 * Pixels this pale, this dark or this grey are not brands.
 *
 * ⚠️ THEY ARE EXCLUDED FROM THE CANDIDATES, NOT FROM THE IMAGE. Almost
 * every logo is mostly white background and black text; counting those
 * would make every workspace in the product white or black, which is the
 * one outcome that looks like the feature is broken. A logo that really
 * IS monochrome falls through to `ORDENCE_DEFAULT_COLOR` at the call
 * site, which is a defensible product colour rather than a grey wash.
 */
const MIN_SATURATION = 12;
const MIN_LUMINANCE = 0.02;
const MAX_LUMINANCE = 0.92;

/** Below this alpha a pixel is transparent padding, not a colour. */
const MIN_ALPHA = 128;

/**
 * Count the colours in RGBA pixel data and return the most common ones,
 * most popular first.
 *
 * `maxCandidates` defaults to four: the pick plus three alternates is as
 * many as a person will scan before giving up and accepting the first.
 */
export function extractPalette(
  pixels: ArrayLike<number>,
  options: { maxCandidates?: number; minSeparation?: number } = {},
): PaletteCandidate[] {
  const maxCandidates = options.maxCandidates ?? 4;
  /* Two candidates closer than this in hue are the same colour twice. */
  const minSeparation = options.minSeparation ?? 24;

  const counts = new Map<number, { count: number; r: number; g: number; b: number }>();
  let counted = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const a = pixels[i + 3] ?? 0;

    if (a < MIN_ALPHA) continue;

    const rgb: Rgb = { r, g, b };
    const { s } = rgbToHsl(rgb);
    if (s < MIN_SATURATION) continue;

    const luminance = relativeLuminance(rgb);
    if (luminance < MIN_LUMINANCE || luminance > MAX_LUMINANCE) continue;

    const key =
      (Math.floor(r / QUANTISE) << 16) |
      (Math.floor(g / QUANTISE) << 8) |
      Math.floor(b / QUANTISE);

    const bucket = counts.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      counts.set(key, { count: 1, r, g, b });
    }
    counted += 1;
  }

  if (counted === 0) return [];

  const ordered = [...counts.values()].sort((a, b) => b.count - a.count);

  const chosen: (PaletteCandidate & { hue: number })[] = [];

  for (const bucket of ordered) {
    /*
     * The bucket's MEAN, not the quantised centre. Rounding a brand
     * colour to a 16-level grid moves it by up to eight levels per
     * channel, which is visible and would mean the colour we offer is
     * not the colour in their logo.
     */
    const rgb: Rgb = {
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
    };
    const { h } = rgbToHsl(rgb);

    /*
     * Skip a candidate that is a near-neighbour of one already offered.
     * Four swatches that are four shades of the same blue is a control
     * that looks like a choice and is not one.
     */
    const tooClose = chosen.some((existing) => {
      const delta = Math.abs(existing.hue - h);
      return Math.min(delta, 360 - delta) < minSeparation;
    });
    if (tooClose) continue;

    chosen.push({ hex: toHex(rgb), weight: bucket.count / counted, hue: h });
    if (chosen.length >= maxCandidates) break;
  }

  return chosen.map(({ hex, weight }) => ({ hex, weight }));
}

/**
 * The single colour to pre-select, or `null` when the image offered
 * nothing usable. Kept separate from `extractPalette` so the caller can
 * show the alternates it did not choose.
 */
export function dominantColour(candidates: readonly PaletteCandidate[]): string | null {
  const first = candidates[0];
  if (!first) return null;
  return parseHex(first.hex) ? first.hex : null;
}
