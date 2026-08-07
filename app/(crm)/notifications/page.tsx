/**
 * Ordence — Notification Center Page
 * Version: v0.81.0-alpha
 */

import NotificationsClient from "./notifications-client";

export const dynamic = "force-dynamic";

export default function NotificationsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <NotificationsClient />
    </div>
  );
}
