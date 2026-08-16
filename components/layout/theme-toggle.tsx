"use client";
import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "./theme-provider";
import { cn } from "@/lib/utils";

/**
 * ══════════════════════════════════════════════════════════════════════
 * DARK MODE TOGGLE — WAVE 8b (v1.50.0-alpha)
 * ══════════════════════════════════════════════════════════════════════
 * Cycles light → dark → system. "System" means follow the OS preference
 * and keep following it when the OS changes (the inline script in
 * theme-provider.tsx listens to the media query in that mode).
 *
 * Icon choice per state: Sun = light, Moon = dark, Monitor = system.
 * The icon shown is the mode the button will SWITCH TO, so the user never
 * has to guess what pressing it does.
 */

const CYCLE: Theme[] = ["light", "dark", "system"];
const LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length] ?? "dark";
  const currentLabel = LABELS[theme] ?? "System";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${currentLabel}. Click to switch to ${LABELS[next]}.`}
      title={`Theme: ${currentLabel} → ${LABELS[next]}`}
      onClick={() => setTheme(next)}
      className="h-9 w-9 shrink-0"
    >
      {next === "light" ? (
        <Sun className="h-4 w-4" />
      ) : next === "dark" ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Monitor className="h-4 w-4" />
      )}
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
      {LABELS[theme]}
    </span>
  );
}
