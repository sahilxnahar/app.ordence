"use client";

/**
 * Ordence — Settings · Appearance (the real control)
 * Version: v1.54.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THREE EXPLICIT OPTIONS, EACH WITH A WORD AND A SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * Not an icon that cycles through unlabelled states. A user who wants
 * light mode should be able to CHOOSE light mode, see that it is chosen,
 * and leave — not press a moon three times and read the tooltip to work
 * out where they landed.
 *
 * ⚠️ THE SELECTED OPTION SAYS "Selected", IN TEXT. One in twelve Indian
 * men is colour-blind and this screen is about colour: a ring, a tint or
 * a filled dot alone would leave them unable to tell which of three
 * identical-looking cards is in force. `aria-checked` covers screen
 * readers; the printed word covers everyone else.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PREVIEW APPLIES IMMEDIATELY, THE SAVE IS SEPARATE AND HONEST
 * ══════════════════════════════════════════════════════════════════════
 * Choosing repaints this browser at once — a colour control that makes
 * you press Save before you can see the colour is a control you have to
 * use twice. The write to `users.preferences` is fired by the same
 * click, and unlike the header shortcut THIS screen reports its result:
 * here the persistence is the whole point, so a silent failure would
 * leave the user believing the choice followed their account when it
 * only followed this laptop.
 */

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  THEME_CHOICES,
  type AppearancePreferences,
  type ThemeChoice,
} from "@/lib/appearance/preferences";
import { useTheme } from "@/components/layout/theme-provider";
import { saveAppearancePreferences } from "@/server/actions/appearance-preferences";

type Props = {
  /** Resolved server-side from `users.preferences`. Never optional. */
  initial: AppearancePreferences;
  /** Set when the row could not be read; the form shows the default and says so. */
  loadError: string | null;
};

export default function AppearanceSettingsClient({ initial, loadError }: Props) {
  /*
   * ⚠️ SEEDED FROM PROPS, NOT FROM AN EFFECT OR FROM STORAGE. There is
   * nothing left to load, so there is no window in which the form shows
   * one state and the account holds another.
   */
  const [theme, setLocalTheme] = useState<ThemeChoice>(initial.theme);
  const [pending, start] = useTransition();

  /*
   * ⚠️ `useTheme()` IS USED ONLY FOR THE REPAINT, not as the state this
   * form displays. The hook's own setter already persists; calling it
   * here would fire the action twice for one click, and the second
   * result would be the one nobody is listening to.
   */
  const [, applyTheme] = useTheme();

  function choose(next: ThemeChoice) {
    setLocalTheme(next);

    start(async () => {
      const result = await saveAppearancePreferences({ theme: next });

      if (!result.ok) {
        /*
         * ⚠️ THE UI IS ROLLED BACK TO WHAT THE ACCOUNT STILL SAYS. Leaving
         * the new palette on screen after a failed save is the lie this
         * batch exists to remove — the user would carry that belief to
         * their next device and find the old theme waiting.
         */
        setLocalTheme(initial.theme);
        toast.error(result.error);
        return;
      }

      /* ⭐ THE SERVER'S ANSWER, run back through the same parser every
         other reader uses, is what gets painted and shown. */
      setLocalTheme(result.data.theme);
      applyTheme(result.data.theme);
      toast.success(`Appearance saved to your account.`);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Appearance</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how Ordence looks. This is stored on your account, so it follows you to every
          device you sign in on. Invoices, payslips, challans and other printable documents stay on
          a bright, paper-like surface in every mode.
        </p>
      </div>

      {loadError ? (
        <p
          role="status"
          className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
        >
          Not loaded — your saved appearance could not be read ({loadError}). Light is shown below
          as the default; choosing an option will replace whatever is stored.
        </p>
      ) : null}

      {/*
        ⚠️ A RADIOGROUP, NOT THREE BUTTONS. Arrow keys move between the
        options and only one is in the tab order, which is what a user
        who navigates by keyboard expects of a three-way choice.
      */}
      <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
        {THEME_CHOICES.map((choice) => {
          const isSelected = choice.key === theme;

          return (
            <button
              key={choice.key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={pending}
              onClick={() => choose(choice.key)}
              className={
                isSelected
                  ? "rounded-lg border-2 border-primary bg-accent p-4 text-left disabled:opacity-60"
                  : "rounded-lg border border-border p-4 text-left hover:border-primary/50 disabled:opacity-60"
              }
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{choice.label}</span>
                {/*
                  🔴 THE WORD IS THE STATE. The border colour above is a
                  convenience for people who can see it; this span is what
                  makes the control usable for everybody else, and it is
                  why "Selected" is text rather than a tick glyph.
                */}
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {isSelected ? "Selected" : "Not selected"}
                </span>
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">{choice.description}</span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {pending ? "Saving your choice…" : "Your choice is saved as soon as you pick it."}
      </p>

      {/*
        ⭐ WHY LIGHT IS THE DEFAULT, SAID OUT LOUD TO THE USER. Somebody
        whose device is in dark mode will otherwise assume this screen is
        broken when Ordence opens bright. Telling them it is deliberate,
        and why, turns a suspected bug into a setting they know how to
        change.
      */}
      <p className="max-w-prose text-xs text-muted-foreground">
        Ordence opens in Light even if your device is set to dark, because the same screens are read
        in direct sunlight on site and for long stretches of numeric work in bright offices. Choose
        “Match my device” above if you would rather follow your operating system.
      </p>
    </div>
  );
}
