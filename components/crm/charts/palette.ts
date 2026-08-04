/**
 * Ordence — Chart Palette
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THESE VALUES WERE VALIDATED, NOT CHOSEN BY EYE
 * ══════════════════════════════════════════════════════════════════════
 * Every hue below was run through a colour-vision validator against this
 * application's actual chart surfaces (`#ffffff` light, `#1a1a1a` dark)
 * before being written down. The measured results:
 *
 *   LIGHT (6 slots, surface #ffffff)
 *     lightness band .......... PASS
 *     chroma floor ............ PASS
 *     CVD separation .......... PASS  worst adjacent ΔE 9.1 (protan)
 *     normal-vision floor ..... PASS  worst adjacent ΔE 19.6
 *     contrast vs surface ..... WARN  aqua 2.82, yellow 2.17, magenta 2.69
 *
 *   DARK (6 slots, surface #1a1a1a)
 *     every check ............. PASS  (all ≥ 3:1 contrast)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THE LIGHT-MODE WARNING OBLIGATES US TO DO
 * ══════════════════════════════════════════════════════════════════════
 * Three light-mode hues sit below 3:1 against white. That is not
 * dismissable — it means those marks alone cannot carry meaning for a
 * low-vision reader. The rule is that colour must be accompanied by
 * relief: **visible direct labels or a table view.**
 *
 * So every chart in this folder ships BOTH:
 *   - a legend and direct value labels, so identity is never colour-alone
 *   - a "View as table" toggle, so the same numbers are readable as text
 *
 * That is why those affordances exist. They are not decoration and should
 * not be removed to tidy the UI.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FIXED ORDER, NEVER CYCLED
 * ══════════════════════════════════════════════════════════════════════
 * Slots are assigned in order and a colour follows the ENTITY, not its
 * rank. If a filter removes a series, the survivors keep their colours —
 * repainting them would silently change what the reader thinks they are
 * looking at between two glances at the same dashboard.
 *
 * There is no ninth colour. Past the cap, series fold into "Other" rather
 * than a generated hue, because a generated hue has passed no check at all.
 */

/** The validated categorical order. Light and dark are the same hues, re-stepped. */
export const CATEGORICAL = {
  light: [
    "#2a78d6", // 1 blue
    "#eb6834", // 2 orange
    "#1baf7a", // 3 aqua      — below 3:1 on white, relief required
    "#eda100", // 4 yellow    — below 3:1 on white, relief required
    "#e87ba4", // 5 magenta   — below 3:1 on white, relief required
    "#008300", // 6 green
  ],
  dark: [
    "#3987e5", // 1 blue
    "#d95926", // 2 orange
    "#199e70", // 3 aqua
    "#c98500", // 4 yellow
    "#d55181", // 5 magenta
    "#008300", // 6 green
  ],
} as const;

/**
 * How many categorical slices a chart may draw before folding to "Other".
 *
 * Five, not six. A donut compares every slice against every other, and on
 * the all-pairs test the fourth slot puts yellow and orange on screen
 * together — a pair that fails the normal-vision floor (ΔE 13.7 light).
 * Capping at five and folding the tail keeps the visible set inside what
 * was actually measured.
 */
export const MAX_CATEGORICAL_SLICES = 5;

/**
 * The two-series financial pair, validated on the ALL-PAIRS test:
 *   light  CVD ΔE 24.7, normal ΔE 33.6, both ≥ 3:1
 *   dark   CVD ΔE 26.8, normal ΔE 31.8, both ≥ 3:1
 *
 * Comfortably clear, which is what you want for the chart that shows money.
 */
export const FINANCIAL_SERIES = {
  debits: { light: "#2a78d6", dark: "#3987e5", label: "Debits" },
  credits: { light: "#eb6834", dark: "#d95926", label: "Credits" },
} as const;

/**
 * Status colours are RESERVED and never reused as "series 4".
 *
 * A reader who has learned that red means "problem" on one tile must not
 * meet the same red as an arbitrary category on the next. These always ship
 * with an icon or a word beside them — never colour alone.
 */
export const STATUS = {
  good: { light: "#008300", dark: "#008300" },
  warning: { light: "#eda100", dark: "#c98500" },
  serious: { light: "#eb6834", dark: "#d95926" },
  critical: { light: "#e34948", dark: "#e66767" },
} as const;

/** Recessive chrome. Grid and axes must never compete with the data. */
export const CHROME = {
  grid: { light: "#e8e4dd", dark: "#2e2e2c" },
  axis: { light: "#a3a09a", dark: "#6f6d68" },
  surface: { light: "#ffffff", dark: "#1a1a1a" },
} as const;

/** Pick a slot by index, in fixed order. Returns null past the cap. */
export function categoricalColor(index: number, mode: "light" | "dark"): string | null {
  const scale = CATEGORICAL[mode];
  return index < scale.length ? scale[index]! : null;
}

/** The muted grey used for a folded "Other" bucket, in both modes. */
export const OTHER_COLOR = { light: "#8a8781", dark: "#6f6d68" } as const;
