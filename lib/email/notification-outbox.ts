/**
 * Ordence — ⭐ THE RULES THAT TURN A NOTIFICATION INTO OUTBOX ROWS.
 *              PURE, AND THE ONLY COPY OF THEM.
 * Version: v1.82.0-alpha  ·  SQL 0097 (table) + 0159 (ceiling)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WENT WRONG, STATED PLAINLY
 * ══════════════════════════════════════════════════════════════════════
 * `server/notifications/create.ts` committed its transaction and then fanned
 * out up to fifty `sendEmail` calls directly at the provider. Its own TODO
 * said so:
 *
 *     TODO: move this to the existing QStash queue (`lib/queue/`). Email is
 *     not the caller's business and should not be on its clock at all.
 *     Parallelising is the containment, not the cure.
 *
 * That path went around `email_outbox` entirely, and therefore around every
 * safeguard 0097 built:
 *
 *   · THE SUPPRESSION LIST WAS NOT CONSULTED. A hard-bounced mailbox kept
 *     being offered to the provider, on a schedule, forever. Mail from every
 *     workspace leaves under ONE sending domain, so that cost lands on
 *     tenants doing nothing wrong — a shared resource spent by whoever is
 *     careless.
 *   · A 429 WAS LOGGED AND THE MESSAGE WAS GONE. No attempt count, no
 *     backoff, no dead letter, and no row anybody could look at afterwards
 *     to answer "why did this user never hear from us".
 *   · A CRASH BETWEEN COMMIT AND SEND LOST THE MESSAGE WITH NO TRACE, and
 *     a re-run of the background worker that created the notification
 *     re-mailed all fifty, because nothing carried an idempotency key.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THESE RULES ARE IN A PURE FILE
 * ══════════════════════════════════════════════════════════════════════
 * Same argument as `lib/email/outbox.ts` and `lib/notifications/preferences.ts`.
 * The moment "which address gets a row, and under what key" is decided inside
 * the function that also opens a transaction, it can only be exercised by
 * standing up a database — so it stops being exercised, and a subtle rule
 * like the one in `planNotificationRecipients` below rots without anybody
 * noticing that it has.
 *
 * No I/O, no `server-only`, no database types, no `node:` imports. Every
 * function is total.
 *
 * ⚠️ THERE IS DELIBERATELY NO ADDRESS VALIDATION HERE. `lib/email/resend.ts`
 * already validates, de-duplicates and caps recipients, and
 * `classifyEmailFailure` already rules an undeliverable address `dead` rather
 * than retrying it. A second validator would be a second answer to the same
 * question, which is exactly how this codebase ended up with two `sendEmail`
 * functions that disagreed.
 */

/* ------------------------------------------------------------------ */
/* WHAT THESE ROWS ARE                                                 */
/* ------------------------------------------------------------------ */

/** `email_outbox.purpose` for everything this module plans. */
export const NOTIFICATION_OUTBOX_PURPOSE = "notification";

/**
 * `email_outbox.subject_type`. The thread back to the row that asked for
 * the message.
 *
 * ⚠️ `mirrorToSubject()` in `server/email/outbox.ts` knows two subject types
 * — `dunning_event` and `credit_dunning_log` — and returns quietly for any
 * other. So a notification's delivery outcome is recorded on the outbox row
 * and NOT written back onto `notifications`. That is a real gap, it is
 * listed in `PATCH-REQUEST-G.md`, and it is not silently pretended away
 * here: the outbox row is the record until the mirror exists.
 */
export const NOTIFICATION_SUBJECT_TYPE = "notification";

/**
 * The most recipients one notification may produce rows for.
 *
 * ⚠️ THE CAP IS HERE, ONCE, rather than in the caller's `.limit()` alone. A
 * bound that lives only in a query is a bound the next caller writes without.
 */
export const MAX_NOTIFICATION_RECIPIENTS = 50;

/* ------------------------------------------------------------------ */
/* DOES THIS NOTIFICATION EMAIL AT ALL                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ EMAIL IS OPT-IN BY SEVERITY, AND THE TEST IS EXHAUSTIVE ON PURPOSE.
 *
 * 🔴 THIS CONDITION USED TO READ:
 *
 *     severity === "critical" || severity === "warning" || !input.severity
 *
 * The third clause meant the DEFAULT — an ordinary `info` notification with
 * no severity passed — also emailed every active user in the workspace, and
 * `server/ai/background-workers.ts` creates those on a schedule. The comment
 * above it said "only if severity warrants it"; the code disagreed.
 *
 * It is a named function now so that the rule is one expression in one place
 * that a proof can hold still, rather than a boolean inlined next to a
 * transaction.
 */
export function severityWarrantsEmail(severity: string): boolean {
  return severity === "critical" || severity === "warning";
}

/* ------------------------------------------------------------------ */
/* THE SUBJECT LINE                                                    */
/* ------------------------------------------------------------------ */

/**
 * `email_outbox.subject` is `varchar(300)`.
 *
 * 🔴 A TITLE LONGER THAN THE COLUMN IS A FAILED INSERT INSIDE THE CALLER'S
 * TRANSACTION, which would roll back the notification itself — the in-app
 * notification lost because its email subject was long. Truncation here is
 * not cosmetic; it is what stops the delivery path from being able to
 * destroy the thing it is delivering.
 */
export const OUTBOX_SUBJECT_MAX = 300;

export function notificationEmailSubject(input: {
  severity: string;
  title: string;
}): string {
  const prefix = `[${input.severity.toUpperCase()}] `;
  const room = Math.max(0, OUTBOX_SUBJECT_MAX - prefix.length);
  const title = input.title.trim();
  return `${prefix}${title.length <= room ? title : title.slice(0, room)}`;
}

/* ------------------------------------------------------------------ */
/* THE IDEMPOTENCY KEY                                                 */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 DERIVED FROM WHAT THE MESSAGE IS, NEVER FROM THE CLOCK OR THE ATTEMPT.
 *
 * `email_outbox` carries a unique index on `(tenant_id, idempotency_key)`, so
 * this string is the only thing standing between a retried enqueue and a
 * second copy in somebody's inbox.
 *
 * ⚠️ AND IT IS BOUNDED BY CONSTRUCTION. The column is `varchar(200)`. Two
 * uuids and a fixed prefix is 85 characters and cannot grow — which is why
 * the key is keyed on the RECIPIENT'S USER ID rather than their address. An
 * address is `varchar(320)`; a key built from one could overflow the column
 * and fail the insert inside the caller's transaction, and truncating an
 * address to fit would make two different recipients share a key and one of
 * them silently never receive the message.
 *
 * ⚠️ WHAT THIS DOES AND DOES NOT PROMISE. It makes the enqueue idempotent
 * with respect to the notification row, which is the durable anchor: the same
 * notification cannot produce two rows for the same user. It does NOT
 * de-duplicate two different notifications that happen to say the same thing
 * — those are two distinct facts and both are owed.
 */
export function notificationIdempotencyKey(input: {
  notificationId: string;
  recipientUserId: string;
}): string {
  return `notification:${input.notificationId}:${input.recipientUserId}`;
}

/** The column width the key above is bounded against. Asserted by the proof. */
export const OUTBOX_IDEMPOTENCY_KEY_MAX = 200;

/* ------------------------------------------------------------------ */
/* WHO GETS A ROW                                                      */
/* ------------------------------------------------------------------ */

export type NotificationCandidate = {
  readonly userId: string;
  readonly email: string;
};

export type PlannedRecipient = {
  /** The envelope address, exactly as the user gave it. */
  readonly toEmail: string;
  /** The lowercased form the suppression list is matched on. */
  readonly toEmailNormalized: string;
  /** Whose row this is, and half of the idempotency key. */
  readonly recipientUserId: string;
};

/**
 * ⚠️ THE SAME NORMALISATION AS `lib/email/outbox.ts`, and it has to be. If
 * the planner stored `Bob@Example.COM` and the dispatcher matched the
 * suppression list on `bob@example.com`, the suppression would be a row
 * nobody matches — a control that exists, reports success and does nothing.
 *
 * It is duplicated as four characters of code rather than imported, because
 * importing it here would be the only edge between two pure modules that are
 * otherwise independent, and `normalizeEmail` in `lib/email/outbox.ts` is
 * itself the canonical one. If these two ever disagree the proof fails: it
 * asserts them equal on the same inputs.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * ⭐⭐ ONE ROW PER ADDRESS, AND THE TIE IS BROKEN DETERMINISTICALLY.
 *
 * 🔴 THE SUBTLE ONE, AND THE REASON THIS FUNCTION EXISTS AT ALL.
 *
 * Two active users in a workspace may share an address — a shared
 * `accounts@` mailbox given to two logins is ordinary in an SMB. If both got
 * a row, the mailbox would receive the same notification twice.
 *
 * De-duplicating alone is not enough. The recipient query has no `ORDER BY`,
 * so the row order is whatever the planner hands back that day. If the key
 * were built from "whichever user id arrived first", two containers running
 * the same notification could each keep a DIFFERENT user id for the same
 * address, produce two different keys, and the unique index — which is doing
 * the actual work of stopping a double send — would let both through.
 *
 * ⭐ SO THE RETAINED USER IS THE LEXICOGRAPHICALLY SMALLEST ID FOR THAT
 * ADDRESS. That is a property of the SET, not of the order it arrived in, so
 * every caller everywhere derives the same key from the same facts.
 *
 * Blank addresses are dropped rather than queued: an empty envelope is not a
 * message anybody is owed, and `email_outbox.to_email` is `NOT NULL`.
 */
export function planNotificationRecipients(
  candidates: readonly NotificationCandidate[],
): PlannedRecipient[] {
  const byAddress = new Map<string, PlannedRecipient>();

  for (const candidate of candidates) {
    const toEmail = String(candidate.email ?? "").trim();
    if (toEmail.length === 0) continue;

    const userId = String(candidate.userId ?? "").trim();
    if (userId.length === 0) continue;

    const toEmailNormalized = normalize(toEmail);
    const held = byAddress.get(toEmailNormalized);

    /*
     * ⚠️ `noUncheckedIndexedAccess` IS ON, so `held` is
     * `PlannedRecipient | undefined` and the two cases cannot be confused.
     * The comparison is `<`, not `<=`: a repeated id must not rewrite the
     * entry, or the retained `toEmail` display form would flip with the
     * input order and the row would differ between two identical runs.
     */
    if (held === undefined || userId < held.recipientUserId) {
      byAddress.set(toEmailNormalized, { toEmail, toEmailNormalized, recipientUserId: userId });
    }
  }

  /*
   * ⚠️ SORTED, AND THE CAP IS APPLIED AFTER SORTING. Taking the first fifty
   * of an unordered map would mean the fifty-first user is a different person
   * on every run, which is worse than a stable cap: it looks like flaky
   * delivery rather than a bound somebody chose.
   */
  return [...byAddress.values()]
    .sort((a, b) => (a.toEmailNormalized < b.toEmailNormalized ? -1 : 1))
    .slice(0, MAX_NOTIFICATION_RECIPIENTS);
}
