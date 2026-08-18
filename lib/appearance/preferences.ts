/**
 * Ordence — Appearance preference: ONE definition, read by both sides
 * Version: v1.54.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 LIGHT IS THE DEFAULT. DARK IS A PREFERENCE. NOT THE OTHER WAY.
 * ══════════════════════════════════════════════════════════════════════
 * This is a product decision with three domain reasons behind it, and it
 * is the line most likely to be "simplified" into `system` by a later
 * reader who assumes following the OS is always the polite default:
 *
 *  ① The site engineer is OUTDOORS IN INDIAN SUNLIGHT. A dark surface in
 *    direct sun is a mirror — he cannot read it, and he is the user with
 *    the least patience and the shortest session.
 *  ② The accountant reads DENSE NUMERIC TABLES FOR EIGHT HOURS in a
 *    bright office. Light-on-dark is the harder direction for sustained
 *    reading of digits, and this product is mostly digits.
 *  ③ ⭐ These screens get PRINTED — invoices, payslips, challans, GSTR
 *    summaries. A document surface is bright wherever it appears.
 *
 * ⚠️ SO `system` IS AN OPTION, NOT THE DEFAULT. Somebody whose laptop is
 * in dark mode still gets a light ERP until they ask for dark here. The
 * OS preference is evidence about their text editor at midnight; it is
 * not evidence about a tax register at noon.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ SAME COLUMN, SIBLING KEY, SAME DISCIPLINE AS BATCH 135
 * ══════════════════════════════════════════════════════════════════════
 * `users.preferences` (jsonb, migration 0093) already holds the
 * notification family under the `notifications` key. This family takes
 * the `appearance` key beside it. There is no second column, no second
 * table and no second mechanism — see `lib/notifications/preferences.ts`
 * for the shape this file deliberately copies.
 *
 * ⚠️ PURE ON PURPOSE, LIKE ITS SIBLING. No `server-only`, no I/O, no
 * database types: the pre-hydration inline script, the settings form,
 * the server action and the tests all import this same module. Two
 * copies of "what is the default" is exactly how a default drifts.
 *
 * ⚠️ EVERY FUNCTION IS TOTAL. Nothing here throws. The column is
 * user-controlled JSONB that may predate this release; an unreadable
 * value is not an error, it is an ABSENT value, and an absent value
 * takes the default — which here means the user gets a light,
 * readable UI rather than a page that failed to render.
 */

/* ------------------------------------------------------------------ */
/* THE THREE STATES                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE LABEL IS PART OF THE DATA, NOT PART OF THE FORM.
 * One in twelve Indian men is colour-blind, and this batch is ABOUT
 * colour — a control whose states differ only by a swatch or a moon
 * glyph is unusable for them. Every state carries a WORD, and the word
 * lives here so the header control and the settings form cannot end up
 * calling the same state two different things.
 */
export const THEME_CHOICES = [
  {
    key: "light",
    label: "Light",
    description: "Bright surfaces. Readable outdoors and in a lit office. The default.",
  },
  {
    key: "dark",
    label: "Dark",
    description: "Dark surfaces for low-light work. Printed documents stay bright.",
  },
  {
    key: "system",
    label: "Match my device",
    description: "Follow whatever this device's operating system is set to, and keep following it.",
  },
] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number]["key"];

/**
 * 🔴 THE LOAD-BEARING CONSTANT OF THIS BATCH. See the file header before
 * changing it to `"system"`.
 */
export const DEFAULT_THEME: ThemeChoice = "light";

export type AppearancePreferences = {
  theme: ThemeChoice;
};

export function defaultAppearancePreferences(): AppearancePreferences {
  return { theme: DEFAULT_THEME };
}

/** The key inside `users.preferences` that this family owns. */
export const APPEARANCE_PREFERENCES_KEY = "appearance";

/**
 * 🔴 THE ONLY PERMITTED `localStorage` KEY IN THE APPLICATION.
 * Its single job is described at the top of `theme-provider.tsx`: it is
 * a PAINT-FLASH CACHE of the server value, not a second source of truth.
 */
export const THEME_STORAGE_KEY = "ordence-theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/* ------------------------------------------------------------------ */
/* PARSING                                                             */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    /*
     * ⚠️ A JSONB COLUMN CAN LEGITIMATELY HOLD A JSON STRING, and some
     * drivers hand the whole column back as text. Tried once, and only
     * once, so a pathologically nested string cannot spin.
     */
    try {
      const reparsed: unknown = JSON.parse(value);
      return typeof reparsed === "object" && reparsed !== null && !Array.isArray(reparsed)
        ? (reparsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Resolve stored JSONB into a valid appearance preference.
 *
 * ⚠️ ACCEPTS `unknown` ON PURPOSE, for the same reason its sibling does:
 * the caller hands over a Drizzle jsonb column whose static type is a
 * promise the database does not keep.
 *
 * ⭐ TOLERATES BOTH NESTINGS — the whole `users.preferences` column, or
 * just the `appearance` sub-object. The nested form wins when present,
 * because that is what this module writes.
 *
 * ⚠️ AN UNRECOGNISED THEME IS NOT A THEME. A row saying
 * `{"theme":"midnight"}` — a value from a future release, or a typo made
 * by hand in psql — resolves to the default rather than to `.dark` being
 * left off with the rest of the page assuming otherwise.
 */
export function parseAppearancePreferences(raw: unknown): AppearancePreferences {
  const defaults = defaultAppearancePreferences();

  const root = asRecord(raw);
  if (!root) return defaults;

  const nested = asRecord(root[APPEARANCE_PREFERENCES_KEY]);
  const source = nested ?? root;

  const stored = source["theme"];
  return { theme: isThemeChoice(stored) ? stored : defaults.theme };
}

/**
 * The value to persist under `users.preferences`.
 *
 * ⚠️ MERGES INTO THE EXISTING COLUMN rather than replacing it. The column
 * is shared with `notifications` today and with families this release has
 * never heard of tomorrow; writing only our own key means saving a theme
 * cannot silently switch somebody's GST alerts back on.
 */
export function mergeAppearancePreferences(
  existing: unknown,
  prefs: AppearancePreferences,
): Record<string, unknown> {
  const root = asRecord(existing) ?? {};
  return { ...root, [APPEARANCE_PREFERENCES_KEY]: prefs };
}

/* ------------------------------------------------------------------ */
/* RESOLUTION                                                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ONE RESOLVER. The pre-hydration inline script, the React hook
 * and the tests all answer "is this page dark?" through this rule, and
 * the script re-states it in hand-written JS only because it must run
 * before any module loads — that copy is generated from this file's
 * constants so the two cannot disagree about the default.
 *
 * ⚠️ `prefersDark` IS AN ARGUMENT, NOT A `matchMedia` CALL. This module
 * is imported on the server, where there is no `window`; taking the OS
 * answer as data is what keeps the function pure and testable without
 * a DOM.
 */
export function resolveIsDark(theme: ThemeChoice, prefersDark: boolean): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return prefersDark;
}

/**
 * The word to show for the CURRENTLY CHOSEN state.
 *
 * ⚠️ NEVER RETURNS AN EMPTY STRING. Under `noUncheckedIndexedAccess` a
 * lookup table indexed by a union still needs a fallback the moment
 * somebody widens the union, and a control whose label vanished is
 * precisely the unlabelled state this batch exists to remove.
 */
export function themeLabel(theme: ThemeChoice): string {
  const found = THEME_CHOICES.find((choice) => choice.key === theme);
  return found ? found.label : THEME_CHOICES[0].label;
}
