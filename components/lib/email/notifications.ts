/**
 * Ordence — Email Notification Helper
 * Version: v0.83.0-alpha
 *
 * Sends email notifications via Resend when configured.
 * Falls back silently when RESEND_API_KEY is not set — the in-app
 * notification is still created, just not emailed.
 *
 * ⚠️ NEVER INCLUDES SENSITIVE DATA. Email bodies contain only the
 * notification title, body, and a link to the app. No financial figures,
 * no personal data, no vault contents.
 */

import "server-only";

type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * Send a notification email.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS USED TO BE A SECOND, BROKEN COPY OF THE DISPATCHER
 * ══════════════════════════════════════════════════════════════════════
 * It called `resend.emails.send(...)` and then `return true`, with the
 * result discarded. The Resend SDK does NOT throw when the provider
 * rejects a message — it returns `{ data, error }`. So this function
 * returned `true` for a suppressed address, an unverified domain, a rate
 * limit, and a malformed payload alike. Every notification email that
 * never arrived was reported as sent.
 *
 * ⚠️ AND IT WAS A KNOWN DEFECT. Three separate files name this exact
 * function, by path, as the thing not to do:
 *
 *   server/email/outbox.ts      "which is how the codebase already ended
 *   server/receivables/dunning.ts   up with a `sendEmail` in
 *                               lib/email/notifications.ts that ignores
 *                               every safeguard in the real one"
 *   lib/email/outbox.ts         "🔴 SUCCESS WITHOUT A PROVIDER ID IS NOT
 *                               SUCCESS"
 *
 * It was documented as wrong and left wired to a live caller.
 *
 * ⭐ SO IT IS NOW A THIN ADAPTER over `lib/email/resend.ts`, which checks
 * `error`, refuses success without a provider message id, classifies rate
 * limits, validates and de-duplicates recipients, and logs with context.
 * One dispatcher, one set of safeguards.
 *
 * The boolean return is kept because that is the contract this module's
 * callers were written against; the difference is that it is now the
 * truth.
 */
export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  const { sendEmail: dispatch } = await import("./resend");

  const result = await dispatch({
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    logContext: { channel: "notification" },
  });

  if (!result.ok) {
    // ⚠️ Named, not swallowed. `resend.ts` already logged the provider's
    // own words; this line says which subsystem lost the message, because
    // "[email] provider error" alone does not tell an operator whether a
    // notification, an invoice or a dunning notice went missing.
    console.error(
      `[email:notification] not delivered (${result.reason}): ${result.message}`,
    );
    return false;
  }

  return true;
}

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
