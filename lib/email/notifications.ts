/**
 * Ordence — Notification email RENDERING
 * Version: v1.82.0-alpha
 *
 * ⚠️ NEVER INCLUDES SENSITIVE DATA. Email bodies contain only the
 * notification title, body, and a link to the app. No financial figures,
 * no personal data, no vault contents.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE NO LONGER SENDS ANYTHING, AND THAT IS THE CHANGE
 * ══════════════════════════════════════════════════════════════════════
 * It used to export a second `sendEmail`. In its first form that function
 * called `resend.emails.send(...)` and returned `true` with the result
 * discarded — the Resend SDK does NOT throw when the provider rejects a
 * message, it returns `{ data, error }` — so it reported a suppressed
 * address, an unverified domain, a rate limit and a malformed payload
 * alike as success. Three separate files named it, by path, as the thing
 * not to do. v1.79 made it a thin adapter over `lib/email/resend.ts`,
 * which was the right repair for the caller it had.
 *
 * ⭐ v1.82 REMOVED THE CALLER INSTEAD. `server/notifications/create.ts`
 * now writes `email_outbox` rows inside its own transaction and lets the
 * dispatcher deliver them, so this module's `sendEmail` had no call sites
 * left anywhere in the repository.
 *
 * 🔴 IT IS DELETED RATHER THAN LEFT EXPORTED, and that is deliberate. An
 * exported sender with no callers is the codebase's own recurring defect
 * — built and unreachable — and worse than inert: it is the obvious thing
 * for the next person to reach for, and reaching for it puts a message
 * past the suppression list, the attempt ceiling and the delivery record
 * all at once. There is now exactly ONE way for this product to send an
 * email: `sendEmail` in `lib/email/resend.ts`, called by the dispatcher in
 * `server/email/outbox.ts`.
 *
 * ⚠️ THE REGRESSION TEST THAT PINNED THE OLD SHAPE STILL EXISTS and now
 * fails: `tests/ui/wave13-tooling.test.ts` asserts this file contains
 * `await import("./resend")`. That file belongs to another stream.
 * `PATCH-REQUEST-G.md` carries the replacement assertion, which is
 * stronger than the one it retires: no module outside
 * `server/email/outbox.ts` may call the dispatcher at all.
 *
 * What remains here is rendering, which has no I/O and no opinion about
 * delivery.
 */

import "server-only";

/**
 * Build an HTML email body for a notification.
 * Uses a simple, professional template.
 */
export function buildNotificationEmail(opts: {
  title: string;
  body?: string;
  actionUrl?: string;
  severity: string;
  tenantName: string;
  appUrl: string;
}): { html: string; text: string } {
  const severityColor =
    opts.severity === "critical"
      ? "#dc2626"
      : opts.severity === "warning"
        ? "#d97706"
        : "#2563eb";

  const severityLabel = opts.severity.toUpperCase();

  const actionLink = opts.actionUrl
    ? `<a href="${opts.appUrl}${opts.actionUrl}" style="display:inline-block;margin-top:16px;padding:8px 16px;background:#2563eb;color:white;text-decoration:none;border-radius:4px;font-size:14px;">View in Ordence</a>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7;">
        <tr><td style="padding:20px 24px;border-bottom:1px solid #e4e4e7;">
          <span style="font-size:18px;font-weight:600;color:#18181b;">Ordence</span>
          <span style="float:right;font-size:12px;color:#71717a;">${opts.tenantName}</span>
        </td></tr>
        <tr><td style="padding:24px;">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${severityColor};color:white;font-size:11px;font-weight:600;letter-spacing:0.5px;">${severityLabel}</span>
          <h2 style="margin:12px 0 8px;font-size:18px;color:#18181b;">${escapeHtml(opts.title)}</h2>
          ${opts.body ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#52525b;">${escapeHtml(opts.body)}</p>` : ""}
          ${actionLink}
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;">
          <p style="margin:0;font-size:12px;color:#a1a1aa;">
            This is an automated notification from Ordence. If you no longer wish to receive these emails,
            adjust your notification preferences in Settings → Notifications.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `Ordence — ${severityLabel}\n\n${opts.title}\n${opts.body ? `\n${opts.body}\n` : ""}${opts.actionUrl ? `\nView in Ordence: ${opts.appUrl}${opts.actionUrl}\n` : ""}\n—\nAutomated notification from Ordence for ${opts.tenantName}`;

  return { html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
