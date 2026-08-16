"use client";
import * as React from "react";

/**
 * ══════════════════════════════════════════════════════════════════════
 * DARK MODE — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 * The palette for both modes lives in `app/globals.css` (HSL tokens under
 * `:root` and `.dark`); this module only decides WHICH palette the page
 * wears, and persists that decision in localStorage under one key.
 *
 * WHY AN INLINE SCRIPT AND NOT A PURE CLIENT-STATE APPROACH.
 * Setting the `.dark` class only inside useEffect means the FIRST render
 * paints the light palette for dark-mode users — a flash of white that is
 * exactly what users of a dark product hate most. The inline script below
 * runs before React hydrates, so the class is already in place when the
 * first paint happens. It must stay in sync with ThemeScript below, so
 * the two are derived from one constant pair.
 */

export const THEME_STORAGE_KEY = "ordence-theme";
export const DARK_SCRIPT = `
(function(){
  var k='${THEME_STORAGE_KEY}';
  var v=(typeof localStorage!=='undefined'&&localStorage.getItem(k))||'system';
  var dark = v==='dark' || (v==='system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if(dark){document.documentElement.classList.add('dark');}
  document.addEventListener('DOMContentLoaded', function(){
    var m=window.matchMedia('(prefers-color-scheme: dark)');
    m.addEventListener('change', function(){
      if((localStorage.getItem('${THEME_STORAGE_KEY}')||'system')==='system'){
        document.documentElement.classList.toggle('dark', m.matches);
      }
    });
  });
})();
`;

export type Theme = "light" | "dark" | "system";

/**
 * The React-side hook. Reads/writes the same storage key as the inline
 * script, so a click on the toggle re-themes immediately and survives
 * refresh.
 */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = React.useState<Theme>("system");

  const setTheme = React.useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* Storage unavailable — ephemeral session, no crash. */
    }
    document.documentElement.classList.toggle("dark", resolveDark(t));
  }, []);

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
      setThemeState(stored && isTheme(stored) ? stored : "system");
    } catch {
      setThemeState("system");
    }
  }, []);

  return [theme, setTheme];
}

function isTheme(t: string): t is Theme {
  return t === "light" || t === "dark" || t === "system";
}

/** Matches the inline script's resolution — one source of truth each. */
function resolveDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * The <script> that runs before hydration, exactly matching the logic
 * above. Kept as a component so the layout decides where to mount it.
 */
export function ThemeScript() {
  // eslint-disable-next-line react/no-danger
  return <script dangerouslySetInnerHTML={{ __html: DARK_SCRIPT }} />;
}
