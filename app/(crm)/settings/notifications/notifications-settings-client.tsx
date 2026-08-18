"use client";

/**
 * Ordence — Settings · Notifications
 * Version: v1.53.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS SCREEN USED TO BE
 * ══════════════════════════════════════════════════════════════════════
 * Every switch on this page wrote to `localStorage` under
 * `ordence_notification_prefs`, and its own comment admitted it: "in
 * production this would come from the user's settings JSONB."
 *
 * The device-sync problem was the least of it. The mail is sent by
 * `server/notifications/create.ts`, which runs in a background worker
 * and cannot read a browser's storage under any circumstances. So the
 * user turned off "Inventory", got a green toast saying the preference
 * was saved, and kept receiving inventory mail forever. A switch that
 * reports success and switches nothing is worse than no switch: the
 * user stops watching for the mail they think they silenced, so the one
 * person who could notice the failure has been trained not to.
 *
 * ⭐ NOW: loaded by the server component from `users.preferences`, saved
 *    through a server action, read on the send path by the SAME parser
 *    this file imports. There is no local fallback and there must never
 *    be one — a fallback is how the old behaviour comes back for the
 *    users whose save happened to fail.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY STATE CARRIES A WORD, NOT ONLY A COLOUR
 * ══════════════════════════════════════════════════════════════════════
 * One in twelve Indian men is colour-blind. A grey-versus-blue pill is
 * unreadable to them, and on this screen the two colours mean "you will
 * be emailed" and "you will not" — the difference between noticing a GST
 * deadline and missing it. So every toggle prints "On" or "Off" beside
 * itself, and the chosen severity prints "Selected".
 */

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SEVERITIES,
  type NotificationCategoryKey,
  type NotificationPreferences,
  type NotificationSeverity,
} from "@/lib/notifications/preferences";
import { saveNotificationPreferences } from "@/server/actions/notification-preferences";

type Props = {
  /** Resolved server-side from `users.preferences`. Never optional. */
  initial: NotificationPreferences;
  /** Set when the row could not be read; the form shows defaults and says so. */
  loadError: string | null;
};

export default function NotificationsSettingsClient({ initial, loadError }: Props) {
  /*
   * ⚠️ SEEDED FROM PROPS, NOT FROM AN EFFECT. There is no loading state
   * and no skeleton because there is nothing left to load — which is
   * also why there is no window in which the form shows one thing and
   * the server believes another.
   */
  const [prefs, setPrefs] = useState<NotificationPreferences>(initial);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const result = await saveNotificationPreferences({
        emailEnabled: prefs.emailEnabled,
        minSeverity: prefs.minSeverity,
        categories: prefs.categories,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      /*
       * ⭐ THE SERVER'S ANSWER REPLACES LOCAL STATE. The action returns
       * the row it actually stored, run back through the same parser the
       * sender uses. If normalisation changed anything, the user sees
       * what will really happen rather than what they typed.
       */
      setPrefs(result.data);
      toast.success("Notification preferences saved to your account.");
    });
  }

  function toggleCategory(key: NotificationCategoryKey) {
    setPrefs((prev) => ({
      ...prev,
      categories: { ...prev.categories, [key]: !prev.categories[key] },
    }));
  }

  function setSeverity(key: NotificationSeverity) {
    setPrefs((prev) => ({ ...prev, minSeverity: key }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control which alerts you receive and how they are delivered. These settings are stored on
          your account, so they apply on every device and to email sent while you are signed out.
        </p>
      </div>

      {loadError ? (
        <p
          role="status"
          className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground"
        >
          Not loaded — your saved preferences could not be read ({loadError}). The defaults are
          shown below; saving will replace whatever is stored.
        </p>
      ) : null}

      {/* Email delivery */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Email delivery</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Send notifications to your email in addition to the in-app bell.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* ⚠️ THE WORD, NOT ONLY THE COLOUR. */}
            <span className="text-xs font-medium">{prefs.emailEnabled ? "On" : "Off"}</span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.emailEnabled}
              aria-label="Email delivery"
              onClick={() => setPrefs((prev) => ({ ...prev, emailEnabled: !prev.emailEnabled }))}
              className={`relative h-6 w-11 rounded-full transition-colors ${
                prefs.emailEnabled ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                  prefs.emailEnabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Minimum severity */}
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">Minimum severity</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Only receive notifications at or above this severity level.
        </p>
        <div className="mt-3 space-y-2">
          {NOTIFICATION_SEVERITIES.map((s) => {
            const chosen = prefs.minSeverity === s.key;
            return (
              <label
                key={s.key}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
                  chosen ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <input
                  type="radio"
                  name="severity"
                  value={s.key}
                  checked={chosen}
                  onChange={() => setSeverity(s.key)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium">{s.label}</p>
                  <p className="text-xs text-muted-foreground">{s.description}</p>
                </div>
                {/* ⚠️ The border tint alone does not say which one is chosen. */}
                {chosen ? <span className="text-xs font-medium">Selected</span> : null}
              </label>
            );
          })}
        </div>
      </div>

      {/* Category preferences */}
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium">Categories</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Choose which types of notifications you want to receive.
        </p>
        <div className="mt-3 space-y-2">
          {NOTIFICATION_CATEGORIES.map((cat) => {
            const on = prefs.categories[cat.key];
            return (
              <div
                key={cat.key}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium">{cat.label}</p>
                  <p className="text-xs text-muted-foreground">{cat.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{on ? "On" : "Off"}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={cat.label}
                    onClick={() => toggleCategory(cat.key)}
                    className={`relative h-6 w-11 rounded-full transition-colors ${
                      on ? "bg-primary" : "bg-muted"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                        on ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Save */}
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {pending ? "Saving..." : "Save preferences"}
      </button>
    </div>
  );
}
