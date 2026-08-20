/**
 * Ordence — Colour maths for white-labelling
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS PURE, AND HAS NO IMPORTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * Every decision that can make a customer's workspace unreadable is made
 * here: whether a brand colour may carry text, how far it has to move
 * before it may, and what goes on top of it. Those decisions have to be
 * testable without a browser, without a database and without React,
 * because the one thing that must never happen is a contrast rule that is
 * only exercised by looking at a screen.
 *
 * WCAG 2.1 relative luminance and contrast ratio, implemented from the
 * specification rather than borrowed, because rule 5 of this project is
 * zero new npm dependencies.
 */

/** A colour in sRGB, 0–255 per channel. */
export type Rgb = { r: number; g: number; b: number };

/** A colour in HSL. `h` 0–360, `s` and `l` 0–100. */
export type Hsl = { h: number; s: number; l: number };

const HEX_SHORT = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Parse `#rgb` or `#rrggbb`.
 *
 * ⚠️ TOTAL, NEVER THROWING. The input is a value out of a `jsonb` column
 * three other code paths already write, and one of them (the Clerk
 * webhook) writes a constant nobody in this wave controls. A parser that
 * throws would turn a malformed stored colour into a 500 on every page of
 * the workspace; `null` turns it into "no brand colour", which is a
 * workspace that still works.
 */
export function parseHex(input: unknown): Rgb | null {
  if (typeof input !== "string") return null;
  const value = input.trim();

  const short = HEX_SHORT.exec(value);
  if (short) {
    const [, r = "0", g = "0", b = "0"] = short;
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }

  const long = HEX_LONG.exec(value);
  if (long) {
    const [, r = "00", g = "00", b = "00"] = long;
    return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
  }

  return null;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function toHex({ r, g, b }: Rgb): string {
  return (
    "#" +
    [r, g, b]
      .map((channel) => clampChannel(channel).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = clampChannel(r) / 255;
  const gn = clampChannel(g) / 255;
  const bn = clampChannel(b) / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hue < 60) [rp, gp, bp] = [c, x, 0];
  else if (hue < 120) [rp, gp, bp] = [x, c, 0];
  else if (hue < 180) [rp, gp, bp] = [0, c, x];
  else if (hue < 240) [rp, gp, bp] = [0, x, c];
  else if (hue < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];

  return {
    r: clampChannel((rp + m) * 255),
    g: clampChannel((gp + m) * 255),
    b: clampChannel((bp + m) * 255),
  };
}

/**
 * The Tailwind convention in `app/globals.css`: a BARE HSL TRIPLE, no
 * `hsl()` wrapper, because the config wraps it (`hsl(var(--primary))`).
 * Emitting `#B08D3C` or `hsl(38 45% 46%)` into one of those variables
 * produces `hsl(hsl(...))`, which is invalid and silently drops the
 * declaration — the failure is a workspace that quietly ignores its own
 * brand, which nobody reports as a bug.
 */
export function toCssTriple(hsl: Hsl): string {
  const h = Math.round(((hsl.h % 360) + 360) % 360);
  const s = Math.round(Math.max(0, Math.min(100, hsl.s)));
  const l = Math.round(Math.max(0, Math.min(100, hsl.l)));
  return `${h} ${s}% ${l}%`;
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number): number => {
    const v = clampChannel(raw) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1–21. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for normal-size text. */
export const AA_TEXT = 4.5;

/**
 * WCAG AA for user-interface components and graphical objects — a border,
 * a focus ring, the active-nav marker. Deliberately a different constant
 * from `AA_TEXT`: a 3:1 border is compliant and a 3:1 body text is not,
 * and collapsing them into one number is how a product ends up either
 * refusing legitimate brand colours or shipping unreadable ones.
 */
export const AA_NON_TEXT = 3;

/**
 * Move a colour along its own lightness axis until it clears `target`
 * against `against`, keeping hue and saturation.
 *
 * ⚠️ IT RETURNS THE BEST IT COULD DO, AND SAYS WHETHER THAT WAS ENOUGH.
 * A silent substitution is the failure the wave brief names: a customer
 * whose pale-yellow logo produced black text has been given a different
 * brand without being told. `met` is what the screen reports.
 *
 * The search is a fixed 1%-step walk, not a binary search: the ratio is
 * monotonic in lightness only away from the crossing point, and 100 steps
 * of exact arithmetic is both cheap and reproducible in a test.
 */
export function adjustForContrast(
  colour: Rgb,
  against: Rgb,
  target: number,
): { colour: Rgb; ratio: number; met: boolean; movedBy: number } {
  const start = contrastRatio(colour, against);
  if (start >= target) {
    return { colour, ratio: start, met: true, movedBy: 0 };
  }

  const base = rgbToHsl(colour);
  const backgroundIsLight = relativeLuminance(against) > 0.18;

  /*
   * Darken against a light background, lighten against a dark one. The
   * other direction can also reach the target — by going past the
   * background and out the far side — but it produces a colour nobody
   * would call the customer's brand.
   */
  const direction = backgroundIsLight ? -1 : 1;

  let best = { colour, ratio: start, met: false, movedBy: 0 };

  /*
   * ⚠️ THE WALK IS OVER INTEGER LIGHTNESS, AND THAT IS NOT TIDINESS.
   * What ships is `toCssTriple()`, which ROUNDS to whole numbers. A
   * search over fractional lightness can stop at a value that clears the
   * bar and then be rounded back under it — a ring measured at 3.00:1 in
   * the test and served at 2.93:1 in the browser. Measuring exactly what
   * is emitted is the only way the number on the screen is the number
   * that was checked.
   */
  const startL = Math.round(base.l);
  for (let step = 1; step <= 100; step += 1) {
    const l = startL + direction * step;
    if (l < 0 || l > 100) break;
    const candidate = hslToRgb({ h: Math.round(base.h), s: Math.round(base.s), l });
    const ratio = contrastRatio(candidate, against);
    if (ratio > best.ratio) {
      best = { colour: candidate, ratio, met: ratio >= target, movedBy: step };
    }
    if (ratio >= target) break;
  }

  return best;
}

/**
 * Black or white — whichever can be read on this colour.
 *
 * ⚠️ NOT "white unless the colour is light". That heuristic uses
 * lightness, and lightness is not luminance: a saturated yellow at L=50
 * is far brighter than a saturated blue at L=50, and the naive rule puts
 * white text on it.
 */
export function readableInk(background: Rgb): { colour: Rgb; ratio: number } {
  const white: Rgb = { r: 255, g: 255, b: 255 };
  /* Not pure black: `--foreground` in this product is 0 0% 10%. */
  const ink: Rgb = { r: 26, g: 26, b: 26 };

  const onWhite = contrastRatio(background, white);
  const onInk = contrastRatio(background, ink);

  return onWhite >= onInk
    ? { colour: white, ratio: onWhite }
    : { colour: ink, ratio: onInk };
}
