/**
 * Ordence — Settings · Appearance
 * Version: v1.54.0-alpha
 *
 * ⭐ THE PREFERENCE IS LOADED ON THE SERVER AND HANDED DOWN, exactly as
 * the notifications screen next door does. The form never reads storage
 * to decide what to show: `localStorage` holds a paint-flash cache of
 * this value, and a form that rendered from the cache would show the
 * choice made on THIS browser rather than the one on the account.
 */

import { getAppearancePreferences } from "@/server/actions/appearance-preferences";
import { defaultAppearancePreferences } from "@/lib/appearance/preferences";
import AppearanceSettingsClient from "./appearance-settings-client";

export const dynamic = "force-dynamic";

export default async function AppearanceSettingsPage() {
  const result = await getAppearancePreferences();

  /*
   * ⚠️ A FAILED LOAD STILL RENDERS THE FORM, ON THE DEFAULTS, WITH A
   * PLAIN WARNING IN WORDS. An error page here would leave somebody
   * unable to escape a palette they cannot read because we could not
   * tell them which palette they are in.
   */
  return (
    <AppearanceSettingsClient
      initial={result.ok ? result.data : defaultAppearancePreferences()}
      loadError={result.ok ? null : result.error}
    />
  );
}
