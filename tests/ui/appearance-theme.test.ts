/**
 * Ordence — ⭐⭐⭐ BATCH 142: DARK MODE AS A REMEMBERED PREFERENCE
 * Version: v1.54.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * THE RESOLVED DEFAULT FOR A USER WITH NO STORED PREFERENCE IS `light` —
 * not `system`, and not whatever the operating system happens to say.
 *
 * That is a product decision with domain reasons behind it (a site
 * engineer reading the screen in direct Indian sunlight; an accountant on
 * dense numeric tables for eight hours; documents that get printed) and
 * it is exactly the kind of decision a later reader "simplifies" into
 * `system` because following the OS feels like the polite default. These
 * tests make that simplification fail loudly, at three levels: the
 * constant, the parser, and the pre-hydration script that decides the
 * FIRST PAINT before any of this code has loaded.
 *
 * ⚠️ ASSERTIONS ARE ABOUT PROPERTIES, NOT SHAPES. Nothing here pins a
 * class list, an href, a sentence or a literal count. The theme
 * catalogue is read from the module, so adding a fourth mode does not
 * break a test that has no opinion about how many there are.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ================================================================== */
/* THE FAKE DATABASE — same discipline as batch 135's suite            */
/* ================================================================== */

/**
 * ⚠️ EVERYTHING THE `vi.mock` FACTORIES TOUCH LIVES INSIDE `vi.hoisted`.
 * `vi.mock` is hoisted above the imports, so a factory closing over an
 * ordinary top-level `const` reads it in the temporal dead zone and the
 * suite fails to collect at all.
 */
const h = vi.hoisted(() => {
  const state = {
    wheres: [] as unknown[],
    sets: [] as Record<string, unknown>[],
    storedPreferences: undefined as unknown,
  };

  class FakeSelect {
    from() {
      return this;
    }
    where(...args: unknown[]) {
      state.wheres.push(args);
      return this;
    }
    limit() {
      return Promise.resolve([{ preferences: state.storedPreferences }]);
    }
  }

  class FakeUpdate {
    set(values: Record<string, unknown>) {
      state.sets.push(values);
      return this;
    }
    where(...args: unknown[]) {
      state.wheres.push(args);
      return this;
    }
    returning() {
      const last = state.sets[state.sets.length - 1];
      return Promise.resolve([{ preferences: last?.["preferences"] }]);
    }
  }

  const tx = {
    select: () => new FakeSelect(),
    update: () => new FakeUpdate(),
  };

  const SESSION_USER_ID = "11111111-1111-1111-1111-111111111111";
  const SESSION_TENANT_ID = "22222222-2222-2222-2222-222222222222";

  return { state, tx, SESSION_USER_ID, SESSION_TENANT_ID };
});

const state = h.state;
const SESSION_USER_ID = h.SESSION_USER_ID;
const VICTIM_USER_ID = "99999999-9999-9999-9999-999999999999";

/** Pull every string literal out of a drizzle condition tree. */
function literalsIn(value: unknown, seen: Set<unknown> = new Set(), depth = 0): string[] {
  if (depth > 30 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((v) => literalsIn(v, seen, depth + 1));
  return Object.values(value as Record<string, unknown>).flatMap((v) =>
    literalsIn(v, seen, depth + 1),
  );
}

vi.mock("@/db", () => ({
  db: h.tx,
  withTenant: (_tenantId: string, cb: (t: typeof h.tx) => unknown) => cb(h.tx),
}));

vi.mock("@/server/audit", () => ({
  requirePermission: vi.fn(async () => ({
    tenant: { id: h.SESSION_TENANT_ID },
    user: { id: h.SESSION_USER_ID },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  APPEARANCE_PREFERENCES_KEY,
  DEFAULT_THEME,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  defaultAppearancePreferences,
  isThemeChoice,
  mergeAppearancePreferences,
  parseAppearancePreferences,
  resolveIsDark,
  themeLabel,
  type ThemeChoice,
} from "@/lib/appearance/preferences";
import {
  NOTIFICATION_PREFERENCES_KEY,
  defaultNotificationPreferences,
} from "@/lib/notifications/preferences";
import { DARK_SCRIPT } from "@/components/layout/theme-provider";
import {
  getAppearancePreferences,
  saveAppearancePreferences,
} from "@/server/actions/appearance-preferences";

const ALL_THEMES: readonly ThemeChoice[] = THEME_CHOICES.map((c) => c.key);

beforeEach(() => {
  state.wheres = [];
  state.sets = [];
  state.storedPreferences = {};
});

/* ================================================================== */
/* ① LIGHT IS THE DEFAULT                                              */
/* ================================================================== */

describe("the resolved default is light", () => {
  /**
   * 🔴 THE LOAD-BEARING ASSERTION OF THE BATCH. Stated three ways so that
   * "simplifying" any one of them still fails: the constant, the empty
   * column, and the absence of the OS as an input to the answer.
   */
  it("is light and is not the follow-the-OS state", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(DEFAULT_THEME).not.toBe("system");
    expect(defaultAppearancePreferences().theme).toBe("light");
  });

  it("holds for a user whose column has never been written", () => {
    for (const empty of [null, undefined, {}, { [NOTIFICATION_PREFERENCES_KEY]: {} }]) {
      expect(parseAppearancePreferences(empty).theme).toBe(DEFAULT_THEME);
    }
  });

  it("does not become dark because the operating system is dark", () => {
    /*
     * ⚠️ THE OS PREFERENCE IS AN ARGUMENT, and for the default it must
     * make NO DIFFERENCE. If this ever fails, someone has changed the
     * default to `system` — see the file header before "fixing" the test.
     */
    const stored = parseAppearancePreferences(null).theme;
    expect(resolveIsDark(stored, true)).toBe(false);
    expect(resolveIsDark(stored, false)).toBe(false);
  });

  it("keeps light as an explicit choice that outranks the OS", () => {
    expect(resolveIsDark("light", true)).toBe(false);
    expect(resolveIsDark("dark", false)).toBe(true);
  });

  it("lets system, and only system, follow the OS", () => {
    for (const theme of ALL_THEMES) {
      const followsOs = resolveIsDark(theme, true) !== resolveIsDark(theme, false);
      expect(followsOs).toBe(theme === "system");
    }
  });
});

/* ================================================================== */
/* ② THE FIRST PAINT AGREES WITH THE PARSER                            */
/* ================================================================== */

/**
 * ⭐ THE PRE-HYDRATION SCRIPT IS THE ONLY CODE THAT RUNS BEFORE THE
 * PARSER EXISTS, so it is the only place the default can drift unnoticed
 * — the symptom would be a flash of the wrong palette, which nobody
 * files a bug about. Rather than reading the script's source, the test
 * RUNS it against a fake document and asks what it painted.
 */
function runDarkScript(options: { stored: string | null; osPrefersDark: boolean }): boolean {
  const classes = new Set<string>();

  const fakeDocument = {
    documentElement: {
      classList: {
        toggle(name: string, force: boolean) {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };

  const fakeStorage = {
    getItem(key: string) {
      return key === THEME_STORAGE_KEY ? options.stored : null;
    },
  };

  const fakeWindow = {
    matchMedia: () => ({
      matches: options.osPrefersDark,
      addEventListener: () => undefined,
      addListener: () => undefined,
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("localStorage", "window", "document", DARK_SCRIPT);
  run(fakeStorage, fakeWindow, fakeDocument);

  return classes.has("dark");
}

describe("the pre-hydration script and the parser cannot disagree", () => {
  it("paints light for a first-time visitor whose OS is dark", () => {
    expect(runDarkScript({ stored: null, osPrefersDark: true })).toBe(false);
  });

  it("agrees with resolveIsDark for every cached value", () => {
    for (const theme of ALL_THEMES) {
      for (const osPrefersDark of [true, false]) {
        expect(runDarkScript({ stored: theme, osPrefersDark })).toBe(
          resolveIsDark(theme, osPrefersDark),
        );
      }
    }
  });

  it("treats an unreadable cache as absent rather than as a theme", () => {
    for (const junk of ["", "midnight", "SYSTEM", "null", "{}"]) {
      expect(runDarkScript({ stored: junk, osPrefersDark: true })).toBe(
        resolveIsDark(DEFAULT_THEME, true),
      );
    }
  });

  it("survives a browser that refuses storage entirely", () => {
    /*
     * ⚠️ Safari in private mode THROWS on getItem, and this script runs
     * before React exists to catch anything. An unhandled throw here is a
     * blank page, not a wrong colour.
     */
    const classes = new Set<string>();
    const run = new Function("localStorage", "window", "document", DARK_SCRIPT);
    expect(() =>
      run(
        {
          getItem() {
            throw new Error("SecurityError");
          },
        },
        {
          matchMedia: () => ({
            matches: true,
            addEventListener: () => undefined,
            addListener: () => undefined,
          }),
        },
        {
          documentElement: {
            classList: {
              toggle(name: string, force: boolean) {
                if (force) classes.add(name);
                else classes.delete(name);
              },
            },
          },
        },
      ),
    ).not.toThrow();
    expect(classes.has("dark")).toBe(false);
  });
});

/* ================================================================== */
/* ③ THE PARSER IS TOTAL                                               */
/* ================================================================== */

describe("parseAppearancePreferences is total", () => {
  /**
   * 🔴 `users.preferences` IS USER-CONTROLLED JSONB. It is read in the
   * authenticated layout on every request; a throw here would take down
   * every page rather than mis-colour one.
   */
  const junk: unknown[] = [
    null,
    undefined,
    "",
    "not json at all",
    "{",
    '"a bare json string"',
    42,
    true,
    [],
    [{ theme: "dark" }],
    {},
    { appearance: null },
    { appearance: "nonsense" },
    { appearance: [] },
    { theme: 7 },
    { theme: "midnight" },
    { appearance: { theme: { nested: "dark" } } },
  ];

  it("never throws and always answers with a known theme", () => {
    for (const value of junk) {
      const result = parseAppearancePreferences(value);
      expect(isThemeChoice(result.theme)).toBe(true);
      expect(ALL_THEMES).toContain(result.theme);
    }
  });

  it("resolves anything unreadable to the default rather than to dark", () => {
    for (const value of junk) {
      expect(parseAppearancePreferences(value).theme).toBe(DEFAULT_THEME);
    }
  });

  it("honours a stored choice, whichever nesting it arrives in", () => {
    for (const theme of ALL_THEMES) {
      expect(parseAppearancePreferences({ [APPEARANCE_PREFERENCES_KEY]: { theme } }).theme).toBe(
        theme,
      );
      expect(parseAppearancePreferences({ theme }).theme).toBe(theme);
      /* A driver that hands the column back as text. */
      expect(
        parseAppearancePreferences(JSON.stringify({ [APPEARANCE_PREFERENCES_KEY]: { theme } }))
          .theme,
      ).toBe(theme);
    }
  });
});

/* ================================================================== */
/* ④ ONE COLUMN, SIBLING KEYS                                          */
/* ================================================================== */

describe("appearance shares users.preferences without trampling it", () => {
  it("leaves every other preference family untouched", () => {
    const existing: Record<string, unknown> = {
      [NOTIFICATION_PREFERENCES_KEY]: defaultNotificationPreferences(),
      somethingThisReleaseHasNeverHeardOf: { keep: true },
    };

    const merged = mergeAppearancePreferences(existing, { theme: "dark" });

    for (const key of Object.keys(existing)) {
      expect(merged[key]).toEqual(existing[key]);
    }
    expect(parseAppearancePreferences(merged).theme).toBe("dark");
  });

  it("takes its own key rather than colonising the root", () => {
    /*
     * ⚠️ A root-level `theme` would be read by the parser (it tolerates
     * both nestings) but would put this family's value where a sibling
     * family could collide with it.
     */
    const merged = mergeAppearancePreferences({}, { theme: "system" });
    expect(Object.keys(merged)).toEqual([APPEARANCE_PREFERENCES_KEY]);
  });

  it("builds on junk without throwing away the new value", () => {
    for (const existing of [null, undefined, "garbage", 5, []]) {
      const merged = mergeAppearancePreferences(existing, { theme: "dark" });
      expect(parseAppearancePreferences(merged).theme).toBe("dark");
    }
  });
});

/* ================================================================== */
/* ⑤ EVERY STATE CARRIES A WORD                                        */
/* ================================================================== */

describe("no state is identified by colour alone", () => {
  /**
   * 🔴 One in twelve Indian men is colour-blind, and this batch is about
   * colour. A mode with no word is a mode they cannot select on purpose.
   */
  it("gives every mode a non-empty label and an explanation", () => {
    for (const choice of THEME_CHOICES) {
      expect(choice.label.trim().length).toBeGreaterThan(0);
      expect(choice.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives the modes distinct labels", () => {
    const labels = THEME_CHOICES.map((c) => c.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("always has a word to show, for every valid theme", () => {
    for (const theme of ALL_THEMES) {
      expect(themeLabel(theme).trim().length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* ⑥ THE SAVE IS PINNED TO THE SESSION                                 */
/* ================================================================== */

describe("saveAppearancePreferences writes only the caller's own row", () => {
  it("pins the session user id and ignores a forged one", async () => {
    const result = await saveAppearancePreferences({
      theme: "dark",
      // @ts-expect-error — the point of the test: extra keys must not steer the write.
      userId: VICTIM_USER_ID,
    });

    expect(result.ok).toBe(true);

    const literals = literalsIn(state.wheres);
    expect(literals).toContain(SESSION_USER_ID);
    expect(literals).not.toContain(VICTIM_USER_ID);
  });

  it("stores a value the parser reads back as the same theme", async () => {
    for (const theme of ALL_THEMES) {
      state.sets = [];
      const result = await saveAppearancePreferences({ theme });
      expect(result.ok && result.data.theme).toBe(theme);

      const written = state.sets[state.sets.length - 1]?.["preferences"];
      expect(parseAppearancePreferences(written).theme).toBe(theme);
    }
  });

  it("refuses a theme that is not one of the offered modes", async () => {
    const result = await saveAppearancePreferences({
      // @ts-expect-error — a hand-rolled RPC call, which is the realistic attack.
      theme: "midnight",
    });
    expect(result.ok).toBe(false);
    expect(state.sets).toHaveLength(0);
  });

  it("reads back the default when the row cannot be found", async () => {
    state.storedPreferences = undefined;
    const loaded = await getAppearancePreferences();
    expect(loaded.ok && loaded.data.theme).toBe(DEFAULT_THEME);
  });
});
