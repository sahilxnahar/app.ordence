import "server-only";

/**
 * Ordence — Transactional Email Dispatcher
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * `import "server-only"` IS THE FIRST LINE FOR A REASON
 * ══════════════════════════════════════════════════════════════════════
 * This module reads `RESEND_API_KEY`. If a client component ever imports
 * it — directly, or three layers down through a shared barrel — the build
 * FAILS instead of quietly bundling an API key that can send mail as your
 * domain into JavaScript served to every visitor.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EMAIL FAILURE NEVER THROWS
 * ══════════════════════════════════════════════════════════════════════
 * Every function here returns a result object. None of them throw.
 *
 * That is deliberate and it is the important design decision in this file.
 * Consider closing an accounting period: the database writes are committed,
 * the books are locked, the audit row is recorded — and then the
 * notification email fails because Resend is rate-limiting.
 *
 * If that threw, the caller would report "period close failed" for an
 * operation that had already, irreversibly, succeeded. The user would try
 * again and get a confusing error about a period already being closed.
 *
 * Notification is genuinely secondary to the transaction it describes. So
 * a send failure is returned, logged, and surfaced as "the period closed;
 * we could not send the notification" — which is the truth.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY IT DEGRADES INSTEAD OF REQUIRING CONFIGURATION
 * ══════════════════════════════════════════════════════════════════════
 * `RESEND_API_KEY` is optional. Without it, `isEmailEnabled()` is false and
 * every send returns `{ ok: false, reason: "not_configured" }` without a
 * network call.
 *
 * This keeps `npm run build` free of real secrets — the CI build asserts
 * exactly that — and lets the whole application run locally with no email
 * provider at all.
 */

import { Resend } from "resend";
import {
  renderContractReadyEmail,
  renderLedgerAlertEmail,
  type ContractReadyEmailProps,
  type LedgerAlertEmailProps,
  type RenderedEmail,
} from "./templates";

/* ------------------------------------------------------------------ */
/* RESULT TYPES                                                        */
/* ------------------------------------------------------------------ */

export type EmailFailureReason =
  | "not_configured"
  | "invalid_recipient"
  | "provider_error"
  | "rate_limited"
  | "unknown";

export type EmailResult =
  | { ok: true; id: string; recipients: string[] }
  | { ok: false; reason: EmailFailureReason; message: string };

/* ------------------------------------------------------------------ */
/* CONFIGURATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * Resend's default sending domain.
 *
 * `onboarding@resend.dev` works with no DNS setup at all, but Resend only
 * delivers from it to the address that owns the API key. That makes it
 * perfect for a first smoke test and useless for real customers — a
 * distinction worth knowing before you conclude your emails are being
 * silently dropped. The deployment guide covers verifying a real domain.
 */
const DEFAULT_FROM = "Ordence <onboarding@resend.dev>";

export function isEmailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function getFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM;
}

/**
 * Lazily constructed, and never at module scope.
 *
 * A module-level `new Resend(process.env.RESEND_API_KEY!)` runs at import
 * time — including during `next build`, where the variable is absent. The
 * non-null assertion would then hand `undefined` to the constructor and the
 * build would fail on a page that merely imports something that imports
 * this file.
 */
let cachedClient: Resend | null = null;

function getClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!cachedClient) cachedClient = new Resend(apiKey);
  return cachedClient;
}

/* ------------------------------------------------------------------ */
/* RECIPIENT VALIDATION                                                */
/* ------------------------------------------------------------------ */

/**
 * An RFC 5322 dot-atom allowlist — the same pattern used for contact email
 * validation elsewhere in this codebase, and for the same reason: the
 * permissive `[^\s@]+@[^\s@]+\.[^\s@]+` shape accepted `<script>@evil.com`
 * when it was tested in Phase 3.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 320 && EMAIL_PATTERN.test(trimmed);
}

/**
 * Normalise a recipient list: trim, drop invalid entries, de-duplicate
 * case-insensitively, and cap the count.
 *
 * The cap matters. A caller that accidentally passes every contact in a
 * tenant would otherwise mail thousands of people and burn the sending
 * reputation of the domain in one request.
 */
function normalizeRecipients(input: string | string[]): {
  valid: string[];
  rejected: string[];
} {
  const raw = Array.isArray(input) ? input : [input];
  const seen = new Set<string>();
  const valid: string[] = [];
  const rejected: string[] = [];

  for (const entry of raw) {
    const trimmed = String(entry ?? "").trim();
    if (!trimmed) continue;

    if (!isValidEmail(trimmed)) {
      rejected.push(trimmed);
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(trimmed);
  }

  return { valid: valid.slice(0, 50), rejected };
}

/** Split a comma-separated env var such as `FINANCE_ALERT_EMAILS`. */
export function parseEmailList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* THE DISPATCHER                                                      */
/* ------------------------------------------------------------------ */

export type SendEmailOptions = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Deduplication key passed to Resend, so a retry does not double-send. */
  idempotencyKey?: string;
  /** Context for the log line. Never included in the message itself. */
  logContext?: Record<string, unknown>;
};

/**
 * Send one email. Never throws.
 *
 * @returns `{ ok: true, id }` on success, or a typed failure describing
 *          what went wrong and whether retrying is worthwhile.
 */
export async function sendEmail(options: SendEmailOptions): Promise<EmailResult> {
  const client = getClient();

  if (!client) {
    // Not an error worth alarming anyone about — email is simply not set up
    // in this environment. Logged at info so it is visible without noise.
    console.info("[email] skipped — RESEND_API_KEY is not set", {
      subject: options.subject,
      ...options.logContext,
    });
    return {
      ok: false,
      reason: "not_configured",
      message: "Email is not configured for this deployment.",
    };
  }

  const { valid, rejected } = normalizeRecipients(options.to);

  if (rejected.length > 0) {
    console.warn("[email] dropped invalid recipients", { count: rejected.length });
  }

  if (valid.length === 0) {
    return {
      ok: false,
      reason: "invalid_recipient",
      message: "No valid recipient address was supplied.",
    };
  }

  try {
    const { data, error } = await client.emails.send(
      {
        from: getFromAddress(),
        to: valid,
        subject: options.subject,
        html: options.html,
        // Always both parts. A message with no text alternative scores
        // worse with spam filters and arrives blank through gateways that
        // strip HTML.
        text: options.text,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      },
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
    );

    if (error) {
      const message = error.message ?? "The email provider rejected the message.";
      const isRateLimit = /rate|limit|429/i.test(`${error.name ?? ""} ${message}`);

      console.error("[email] provider error", {
        name: error.name,
        message,
        ...options.logContext,
      });

      return {
        ok: false,
        reason: isRateLimit ? "rate_limited" : "provider_error",
        message: isRateLimit
          ? "Too many emails sent just now. Please try again shortly."
          : "The email could not be sent. Please try again.",
      };
    }

    if (!data?.id) {
      return {
        ok: false,
        reason: "unknown",
        message: "The email provider did not confirm the send.",
      };
    }

    console.info("[email] sent", {
      id: data.id,
      recipientCount: valid.length,
      ...options.logContext,
    });

    return { ok: true, id: data.id, recipients: valid };
  } catch (err) {
    // A thrown error is a network failure or an SDK bug. It must not
    // propagate — see the note at the top of this file.
    console.error("[email] send threw", err, options.logContext);
    return {
      ok: false,
      reason: "unknown",
      message: "Could not reach the email provider.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* TYPED SENDERS                                                       */
/* ------------------------------------------------------------------ */

/**
 * Notify a counterparty that a contract draft is ready for review.
 *
 * The idempotency key is derived from the contract id and the recipient, so
 * a double-clicked "Send to Client" button does not put two identical
 * emails in a client's inbox.
 */
export async function sendContractReadyEmail(params: {
  to: string;
  replyTo?: string;
  contractId: string;
  props: ContractReadyEmailProps;
}): Promise<EmailResult> {
  const rendered: RenderedEmail = renderContractReadyEmail(params.props);

  return sendEmail({
    to: params.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: params.replyTo,
    idempotencyKey: `contract-ready:${params.contractId}:${params.to.toLowerCase()}`,
    logContext: { template: "contract_ready", contractId: params.contractId },
  });
}

/**
 * Notify finance contacts that an accounting period has been closed.
 *
 * Keyed on the period id, so the notification for a given close is sent
 * once even if the action is retried.
 */
export async function sendLedgerAlertEmail(params: {
  to: string | string[];
  periodId: string;
  props: LedgerAlertEmailProps;
}): Promise<EmailResult> {
  const rendered: RenderedEmail = renderLedgerAlertEmail(params.props);

  return sendEmail({
    to: params.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: `ledger-alert:${params.periodId}`,
    logContext: { template: "ledger_alert", periodId: params.periodId },
  });
}

export type { ContractReadyEmailProps, LedgerAlertEmailProps };
