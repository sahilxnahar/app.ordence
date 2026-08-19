"use client";
import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "./theme-provider";
import { THEME_CHOICES, themeLabel, type ThemeChoice } from "@/lib/appearance/preferences";
import { cn } from "@/lib/utils";

/**
 * ══════════════════════════════════════════════════════════════════════
 * THE HEADER SHORTCUT — Batch 142
 * ══════════════════════════════════════════════════════════════════════
 * This is the QUICK control. The real one, with the three states written
 * out as sentences and an explanation of each, is at
 * `/settings/appearance`; this button exists because the top bar is the
 * one surface every authenticated screen shares and because "it is too
 * bright out here" is a thing that happens mid-task.
 *
 * 🔴 IT SHOWS A WORD, NOT ONLY A GLYPH. One in twelve Indian men is
 * colour-blind, and a control whose whole subject is colour is the worst
 * possible place to encode state as a swatch or a moon. The current mode
 * is printed beside the icon; the icon is decoration on top of the word,
 * never a replacement for it.
 *
 * ⚠️ THE WORD NAMES THE STATE YOU ARE IN, and the accessible name spells
 * out the state you will move to. Those are two different questions and
 * a single glyph cannot answer both — which is exactly how the previous
 * version left people guessing.
 *
 * ⚠️ THE LABEL IS HIDDEN ON NARROW SCREENS, WHERE THE HEADER CANNOT HOLD
 * IT. It is not lost: `aria-label` and `title` carry the same words at
 * every width, so a screen reader and a long-press both still say
 * "Light", and the settings screen is one tap away.
 */

/**
 * ⚠️ THE ORDER COMES FROM THE CATALOGUE, NOT FROM A SECOND LIST HERE.
 * `light → dark → system` is the order the settings form shows too, so
 * a user who has learned one control has learned the other.
 */
const CYCLE: readonly ThemeChoice[] = THEME_CHOICES.map((choice) => choice.key);

function iconFor(theme: ThemeChoice) {
  if (theme === "light") return Sun;
  if (theme === "dark") return Moon;
  return Monitor;
}

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  /*
   * 🔴 `noUncheckedIndexedAccess` — indexing a `readonly ThemeChoice[]`
   * yields `ThemeChoice | undefined` no matter how obviously the modulo
   * keeps it in range, and the fallback is the DEFAULT rather than
   * `"dark"`: if this ever did go wrong, the failure should land on the
   * palette the product defaults to, not on the one the engineer in the
   * sun cannot read.
   */
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length] ?? "light";
  const CurrentIcon = iconFor(theme);

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Theme: ${themeLabel(theme)}. Activate to switch to ${themeLabel(next)}.`}
      title={`Theme: ${themeLabel(theme)} → ${themeLabel(next)}`}
      onClick={() => setTheme(next)}
      className="h-9 shrink-0 gap-2 px-2"
    >
      <CurrentIcon className="h-4 w-4" aria-hidden="true" />
      <span className="hidden text-xs font-medium sm:inline">{themeLabel(theme)}</span>
    </Button>
  );
}

/** Small inline indicator for places that show the current mode textually. */
export function ThemeLabel() {
  const [theme] = useTheme();
  return (
    <span
      className={cn(
        "rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground",
      )}
    >
      {themeLabel(theme)}
    </span>
  );
}
