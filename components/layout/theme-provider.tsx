"use client";
import * as React from "react";
import {
  DEFAULT_THEME,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  isThemeChoice,
  resolveIsDark,
  type ThemeChoice,
} from "@/lib/appearance/preferences";
import { saveAppearancePreferences } from "@/server/actions/appearance-preferences";

/**
 * ══════════════════════════════════════════════════════════════════════
 * THEME — WHICH PALETTE THE PAGE WEARS (Batch 142)
 * ══════════════════════════════════════════════════════════════════════
 * The palettes themselves live in `app/globals.css` as HSL tokens under
 * `:root` and `.dark`, and the whole application is built on those
 * tokens via `tailwind.config.ts`. That is why this file can switch the
 * entire product by adding one class to `<html>` and why nothing here
 * needs a per-component `dark:` variant.
 *
 * 🔴 THE DEFAULT IS `light`, NOT `system`. The three domain reasons are
 * written out in `lib/appearance/preferences.ts`; the short version is
 * sunlight, eight-hour numeric tables, and paper. A laptop set to dark
 * does not tell us anything about a tax register read at noon.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THERE IS A `localStorage` CALL IN A CODEBASE THAT BANS IT
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SERVER VALUE IS THE TRUTH. `users.preferences.appearance.theme`
 * is where the choice lives, it is written by
 * `server/actions/appearance-preferences.ts`, and it follows the person
 * to every device they sign in from.
 *
 * ⚠️ STORAGE HERE IS A PAINT-FLASH CACHE OF THAT VALUE AND NOTHING ELSE.
 * The server value cannot be known before the first byte of HTML is
 * parsed. Applying `.dark` only in an effect means the first frame is
 * painted in the OTHER palette — a white flash for dark-mode users on
 * every navigation. `DARK_SCRIPT` below runs before hydration, so the
 * class is already on `<html>` when the first paint happens, and the
 * only value available that early is one this browser wrote last time.
 *
 * 🔴 SO: DO NOT DELETE THESE CALLS, AND DO NOT ADD MORE. The cache is
 * REFRESHED FROM THE SERVER on every authenticated load — see
 * `<ThemeSync />` — so it can never become an independent second answer.
 * If the two disagree, the server wins, always, within one tick of load.
 *
 * ⚠️ A SIGNED-OUT VISITOR HAS NO SERVER VALUE, and storage alone is the
 * correct and only possible answer for them. The marketing pages are
 * light-only anyway, so in practice the cache is doing nothing there
 * except keeping a returning, signed-out user's choice from flickering.
 */

/**
 * ⚠️ RE-EXPORTED, NOT REDEFINED. Older call sites imported these two from
 * here; the definitions moved to the pure module so the server action and
 * the tests could see them without pulling in a `"use client"` file.
 */
export { THEME_STORAGE_KEY };
export type Theme = ThemeChoice;

/**
 * ⚠️ THE SCRIPT IS HAND-WRITTEN JS THAT RESTATES `resolveIsDark()`.
 * It has to: it runs before any module has loaded. The values it can
 * disagree about — the storage key, the valid states and the DEFAULT —
 * are INTERPOLATED FROM THE SAME CONSTANTS the rest of the app imports,
 * so the one thing that could silently drift (the default) cannot.
 *
 * ⚠️ EVERY STORAGE ACCESS IS WRAPPED. Safari in private mode throws on
 * `localStorage.getItem`, and an exception here happens before React
 * exists to catch it — the page would render blank rather than in the
 * wrong colour.
 */
const VALID_THEMES_JS = JSON.stringify(THEME_CHOICES.map((choice) => choice.key));

export const DARK_SCRIPT = `
(function(){
  var k=${JSON.stringify(THEME_STORAGE_KEY)};
  var valid=${VALID_THEMES_JS};
  var v=${JSON.stringify(DEFAULT_THEME)};
  try{
    var s=localStorage.getItem(k);
    if(s&&valid.indexOf(s)!==-1){v=s;}
  }catch(e){}
  var mq=window.matchMedia('(prefers-color-scheme: dark)');
  document.documentElement.classList.toggle('dark', v==='dark'||(v==='system'&&mq.matches));
  var onChange=function(){
    var cur=${JSON.stringify(DEFAULT_THEME)};
    try{
      var c=localStorage.getItem(k);
      if(c&&valid.indexOf(c)!==-1){cur=c;}
    }catch(e){}
    if(cur==='system'){document.documentElement.classList.toggle('dark', mq.matches);}
  };
  if(mq.addEventListener){mq.addEventListener('change',onChange);}
  else if(mq.addListener){mq.addListener(onChange);}
})();
`;

/* ------------------------------------------------------------------ */
/* THE CLIENT-SIDE STORE                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ONE MODULE-LEVEL STORE, NOT A HOOK PER CONSUMER. The header control
 * and the settings form are on screen at once on `/settings/appearance`.
 * With independent `useState` the two would disagree the moment either
 * was used, and the user would be looking at a control that claims the
 * theme is Light while the page is dark. A React context would work too,
 * but it would have to be mounted above both, and the pre-hydration
 * script has already established the truth by then anyway.
 */
const listeners = new Set<() => void>();

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Read the paint-flash cache. Anything unreadable or unknown = default. */
function readCache(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function writeCache(theme: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* Private mode, quota, disabled storage — the page still works. */
  }
}

function applyClass(theme: ThemeChoice): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveIsDark(theme, prefersDark()));
}

/**
 * Apply a theme to THIS DOCUMENT and refresh the cache. Says nothing to
 * the server — used both by the user's own click (which persists
 * separately) and by `<ThemeSync />` reconciling a value that already
 * came FROM the server.
 */
function applyLocally(theme: ThemeChoice): void {
  writeCache(theme);
  applyClass(theme);
  for (const listener of listeners) listener();
}

/**
 * The React-side hook.
 *
 * ⚠️ THE FIRST RENDER RETURNS THE DEFAULT, NOT THE CACHE. Reading storage
 * during render would return a different answer on the server (where
 * there is none) than in the browser, and React would blow away the
 * hydrated markup. The PAINT is already correct by then — the inline
 * script saw to that — so this is only about which word the control
 * shows, and it settles in the first effect.
 */
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setThemeState] = React.useState<ThemeChoice>(DEFAULT_THEME);

  React.useEffect(() => {
    setThemeState(readCache());
    const listener = () => setThemeState(readCache());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setTheme = React.useCallback((next: ThemeChoice) => {
    /*
     * ⭐ PAINT FIRST, PERSIST SECOND. Waiting for the round trip before
     * repainting would make a colour switch feel broken on a site
     * engineer's 3G connection, and the write is not something he needs
     * to wait for to know it worked.
     */
    applyLocally(next);

    /*
     * ⚠️ FAILURE IS SWALLOWED ON PURPOSE, AND ONLY HERE. A signed-out
     * visitor, or an expired session, gets an error from the action; the
     * right outcome for them is the theme they just picked applied to
     * this browser, not a red toast about a preference they never asked
     * to sync. The settings form takes the same action's result and DOES
     * report it, because there the save is the point.
     */
    void saveAppearancePreferences({ theme: next }).catch(() => {
      /* Device-local only. See above. */
    });
  }, []);

  return [theme, setTheme];
}

/* ------------------------------------------------------------------ */
/* MOUNTED COMPONENTS                                                  */
/* ------------------------------------------------------------------ */

/**
 * The `<script>` that runs before hydration. Kept as a component so the
 * root layout decides where it is mounted — it must be before any
 * painted markup.
 */
export function ThemeScript() {
  // eslint-disable-next-line react/no-danger
  return <script dangerouslySetInnerHTML={{ __html: DARK_SCRIPT }} />;
}

/**
 * ⭐ THE PIECE THAT MAKES STORAGE A CACHE RATHER THAN A SOURCE OF TRUTH.
 *
 * Mounted inside the authenticated layout with the value read from
 * `users.preferences` on the server. If this browser's cache disagrees —
 * because the user changed the theme on their phone, or because they
 * signed in as somebody else on a shared site laptop — the SERVER WINS
 * and the cache is rewritten on the spot.
 *
 * ⚠️ RENDERS NOTHING AND HAS NO EFFECT ON THE PAINT PATH. By the time
 * this runs the page is already visible in whatever the cache said; the
 * reconcile is a same-tick class swap for the rare disagreement, not a
 * second render of the page.
 */
export function ThemeSync({ serverTheme }: { serverTheme: ThemeChoice }) {
  React.useEffect(() => {
    if (readCache() !== serverTheme) applyLocally(serverTheme);
  }, [serverTheme]);

  return null;
}
