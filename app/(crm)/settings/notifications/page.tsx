/**
 * Ordence — Settings · Notifications Page
 * Version: v1.53.0-alpha
 *
 * ⭐ THE PREFERENCES ARE LOADED ON THE SERVER AND HANDED DOWN.
 *
 * The previous version rendered the client component with no data and
 * let it read `localStorage` in an effect. That produced a skeleton on
 * every visit, a flash of the wrong state, and — the part that mattered
 * — a value only that one browser had ever seen. Loading here means the
 * first paint already shows the values the SENDER is using, because both
 * read the same row.
 */

import { getNotificationPreferences } from "@/server/actions/notification-preferences";
import { defaultNotificationPreferences } from "@/lib/notifications/preferences";
import NotificationsSettingsClient from "./notifications-settings-client";

export const dynamic = "force-dynamic";

export default async function NotificationsSettingsPage() {
  const result = await getNotificationPreferences();

  /*
   * ⚠️ A FAILED LOAD STILL RENDERS THE FORM, WITH THE DEFAULTS AND A
   * PLAIN WARNING. The alternative — an error page — leaves the user
   * unable to change a setting because we could not show them the
   * current one, which is the wrong trade for a screen whose whole
   * purpose is turning mail off.
   */
  return (
    <NotificationsSettingsClient
      initial={result.ok ? result.data : defaultNotificationPreferences()}
      loadError={result.ok ? null : result.error}
    />
  );
}
