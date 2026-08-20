/**
 * Ordence — What a brand colour is allowed to touch
 * Version: v1.90.0-alpha (Wave 2E)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE RULE THIS FILE EXISTS TO MAKE UNBREAKABLE
 * ══════════════════════════════════════════════════════════════════════
 * The brand colour drives ACCENTS AND BORDERS. It never drives body text
 * and it never drives a status colour.
 *
 * In this product every colour that carries a status carries exactly one
 * meaning: green is *this ties*, amber is *a person must look*, red is
 * *this blocks the cutover*. A customer whose brand is red must not get a
 * workspace in which every heading looks like a blocked cutover, and a
 * customer whose brand is green must not get one in which a failing
 * reconciliation looks reconciled.
 *
 * ⚠️ THE RULE IS ENFORCED BY CONSTRUCTION, NOT BY REVIEW. `BRANDABLE`
 * below is the complete list of custom properties branding may emit, and
 * `brandCssVariables()` cannot return a name outside it — every candidate
 * is filtered through the allowlist on the way out. `RESERVED` names the
 * properties that are forbidden and says why for each, and a test asserts
 * the two sets do not intersect and that a brand of any colour leaves
 * every reserved token byte-identical.
 *
 * ⚠️ AND THE STATUS COLOURS ARE NOT CUSTOM PROPERTIES AT ALL. They are
 * literal Tailwind palette classes (`text-red-700`, `bg-amber-50`) in the
 * components that report status. There is deliberately no variable to
 * override: the reason a helpful future change cannot theme them is that
 * there is nothing to point at. `RESERVED` still names `--destructive`,
 * which IS a custom property and IS a status colour.
 */

import {
  AA_NON_TEXT,
  AA_TEXT,
  adjustForContrast,
  contrastRatio,
  parseHex,
  readableInk,
  rgbToHsl,
  hslToRgb,
  toCssTriple,
  toHex,
  type Rgb,
} from "./color";

/**
 * Every custom property branding may write. Adding a name here is a
 * deliberate act and needs a sentence saying why the property is an
 * accent and not a meaning.
 */
export const BRANDABLE = [
  /** Buttons, links and the active-nav marker. Text-safe: see below. */
  "--primary",
  /** Ink on `--primary`. Black or white, whichever can be read. */
  "--primary-foreground",
  /** The focus ring. Shares `--primary`'s role and must move with it. */
  "--ring",
  /** A tint of the brand used as a hover/selected background. */
  "--accent",
  /** Ink on that tint — NOT the brand colour; it is body-weight text. */
  "--accent-foreground",
  /**
   * The unmodified brand colour, for fills and borders where nothing is
   * read off it. `--primary` may have been darkened to carry text; this
   * one is what the customer actually chose, and it is what the sidebar
   * marker and the logo chip use.
   */
  "--brand",
  /** The brand colour at the lightness a 1px border needs. */
  "--brand-border",
] as const;

export type BrandableToken = (typeof BRANDABLE)[number];

/**
 * Forbidden, with the reason. A name in this list must never appear in
 * the output of `brandCssVariables()`.
 */
export const RESERVED: Readonly<Record<string, string>> = Object.freeze({
  "--foreground": "body text — legibility is not a brand decision",
  "--card-foreground": "body text on a card",
  "--muted-foreground": "secondary body text; already the weakest legible value",
  "--secondary-foreground": "body text on a secondary surface",
  "--background": "the page. A tinted page recolours every figure on it",
  "--card": "the surface figures are read off",
  "--secondary": "a neutral surface, not an accent",
  "--muted": "a neutral surface, not an accent",
  "--destructive": "STATUS. Red means this blocks the cutover",
  "--destructive-foreground": "ink on a status colour",
  "--border": "the neutral rule between rows; --brand-border is the branded one",
  "--input": "a form field's edge must not change meaning with a brand",
  "--radius": "shape, not colour, and a theme editor is out of scope",
});

/** The verdict shown on the branding screen. */
export type BrandContrast = {
  /** The colour the customer chose. */
  chosen: string;
  /** What `--primary` was actually set to. Differs when text needed it. */
  applied: string;
  /** Contrast of the CHOSEN colour against the page background. */
  chosenRatio: number;
  /** Contrast of the APPLIED colour against the page background. */
  appliedRatio: number;
  /** True when the chosen colour could carry text unchanged. */
  passesText: boolean;
  /** True when the chosen colour is at least usable as a border/ring. */
  passesNonText: boolean;
  /** True when even the adjusted colour could not reach AA text. */
  unreachable: boolean;
  /** Which theme this verdict was computed for. */
  scheme: "light" | "dark";
};

/** The two page backgrounds from `app/globals.css`. */
const BACKGROUNDS: Record<"light" | "dark", Rgb> = {
  /* :root  --background: 0 0% 100% */
  light: { r: 255, g: 255, b: 255 },
  /* .dark  --background: 0 0% 7%  */
  dark: { r: 18, g: 18, b: 18 },
};

/**
 * The contrast verdict for one colour in one theme.
 *
 * ⚠️ COMPUTED FOR BOTH THEMES, NOT ONE. A brand that reads on white can
 * be invisible on the dark palette and vice versa, and the workspace
 * offers both. Reporting only the light verdict would ship the dark
 * failure to whoever happened to prefer dark mode.
 */
export function evaluateContrast(
  hex: string,
  scheme: "light" | "dark" = "light",
): BrandContrast | null {
  const chosen = parseHex(hex);
  if (!chosen) return null;

  const background = BACKGROUNDS[scheme];
  const chosenRatio = contrastRatio(chosen, background);
  const adjusted = adjustForContrast(chosen, background, AA_TEXT);

  return {
    chosen: toHex(chosen),
    applied: toHex(adjusted.colour),
    chosenRatio,
    appliedRatio: adjusted.ratio,
    passesText: chosenRatio >= AA_TEXT,
    passesNonText: chosenRatio >= AA_NON_TEXT,
    unreachable: !adjusted.met,
    scheme,
  };
}

/**
 * The custom properties for one theme.
 *
 * Returns an empty object for a colour that cannot be parsed, which is
 * the same outcome as no brand at all: the product's own palette, intact.
 */
export function brandCssVariables(
  hex: string,
  scheme: "light" | "dark" = "light",
): Record<BrandableToken, string> | Record<string, never> {
  const chosen = parseHex(hex);
  if (!chosen) return {};

  const background = BACKGROUNDS[scheme];

  /*
   * `--primary` carries text (`text-primary` on the page background) AND
   * is a button fill. The text case is the binding one, so it gets the
   * adjusted colour; a button filled with the adjusted colour is still
   * recognisably the brand and is now guaranteed readable.
   */
  const textSafe = adjustForContrast(chosen, background, AA_TEXT).colour;

  /*
   * The ring and the border only have to be VISIBLE, not readable. They
   * keep the chosen colour when it clears 3:1 and are nudged when it does
   * not — a brand that is nearly the page colour would otherwise produce
   * a focus ring that cannot be seen, which is a keyboard-navigation
   * failure rather than an aesthetic one.
   */
  const visible = adjustForContrast(chosen, background, AA_NON_TEXT).colour;

  const ink = readableInk(textSafe).colour;

  /*
   * The tint. In light mode a very pale wash of the brand hue; in dark
   * mode a very deep one. Its FOREGROUND is the theme's own body ink,
   * never the brand — text on a hover row is body text.
   */
  const base = rgbToHsl(chosen);
  const tint = hslToRgb({
    h: base.h,
    s: Math.min(base.s, 45),
    l: scheme === "light" ? 92 : 18,
  });

  const emitted: Record<string, string> = {
    "--primary": toCssTriple(rgbToHsl(textSafe)),
    "--primary-foreground": toCssTriple(rgbToHsl(ink)),
    "--ring": toCssTriple(rgbToHsl(visible)),
    "--accent": toCssTriple(rgbToHsl(tint)),
    "--accent-foreground": scheme === "light" ? "0 0% 10%" : "0 0% 96%",
    "--brand": toCssTriple(base),
    "--brand-border": toCssTriple(rgbToHsl(visible)),
  };

  /*
   * 🔴 THE ALLOWLIST IS APPLIED ON THE WAY OUT, not asserted about in a
   * comment. A future edit that adds `"--foreground"` to the object above
   * changes nothing, because the name is not in `BRANDABLE` and the
   * filter drops it. That is the difference between a rule and a wish.
   */
  const safe: Record<string, string> = {};
  for (const name of BRANDABLE) {
    const value = emitted[name];
    if (typeof value === "string") safe[name] = value;
  }
  return safe as Record<BrandableToken, string>;
}

/**
 * The `<style>` body mounted on the tenant's layout.
 *
 * ⚠️ SCOPED TO A CLASS, NOT `:root`. Custom properties inherit, so a
 * declaration on a wrapper element wins for that subtree and loses
 * everywhere else — which is exactly the boundary wanted here: the CRM
 * shell is branded, and `app/platform/**` (Ordence staff, looking across
 * workspaces) is a different subtree that this rule cannot reach.
 *
 * ⚠️ AND THE DARK BLOCK IS `.dark .ordence-brand`, not a media query.
 * The theme in this product is a CLASS on `<html>` written by
 * `components/layout/theme-provider.tsx`; a `prefers-color-scheme` query
 * would disagree with it for anyone who chose a theme against their
 * system setting.
 */
export const BRAND_SCOPE_CLASS = "ordence-brand";

export function brandStyleSheet(hex: string): string {
  const light = brandCssVariables(hex, "light");
  const dark = brandCssVariables(hex, "dark");
  if (Object.keys(light).length === 0) return "";

  const body = (vars: Record<string, string>): string =>
    Object.entries(vars)
      .map(([name, value]) => `${name}:${value};`)
      .join("");

  return (
    `.${BRAND_SCOPE_CLASS}{${body(light)}}` +
    `.dark .${BRAND_SCOPE_CLASS}{${body(dark)}}`
  );
}
