import "server-only";

/**
 * Ordence — ⭐⭐ THE DISPATCHER. THE THING THAT WAS MISSING.
 * Version: v1.54.0-alpha  ·  SQL 0097
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `server/actions/credit.ts` wrote dunning letters into a queue and said
 * so in its own header: "IT QUEUES. IT DOES NOT SEND." Nothing emptied
 * the queue. This is the drain.
 *
 * ⚠️ IT USES `sendEmail` FROM `lib/email/resend.ts` AND ADDS NO SECOND
 * CLIENT. A second Resend client would mean two places that decide the
 * From address, two recipient validators, and two behaviours when the
 * key is absent — which is how the codebase already ended up with a
 * `sendEmail` in `lib/email/notifications.ts` that ignores every
 * safeguard in the real one.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE FOUR THINGS THAT MAKE SENDING MAIL DIFFERENT FROM SENDING
 *      ANYTHING ELSE
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① CLAIMING IS ATOMIC OR IT IS NOTHING.
 *    `UPDATE ... WHERE status = 'queued' ... FOR UPDATE SKIP LOCKED
 *    RETURNING` — one statement. Two workers cannot take the same row,
 *    and the second one does not block waiting for the first, it simply
 *    takes different work. A `SELECT` followed by an `UPDATE` is two
 *    containers both passing the same `if`, which is one dunning letter
 *    delivered twice.
 *
 * ② AN EMPTY `returning()` IS A CLAIM THAT DID NOT HAPPEN.
 *    `noUncheckedIndexedAccess` is on, so `rows[0]` is
 *    `Row | undefined` and the compiler will not let that be ignored.
 *    Every write-back below checks it. Treating an empty result as
 *    success is how a row gets marked `sent` by a worker whose lease had
 *    already been taken from it.
 *
 * ③ A CRASH BETWEEN "SENT" AND "MARKED SENT" MUST NOT RESEND.
 *    Our database cannot answer this alone — after such a crash we have
 *    no record either way. So the provider decides: every attempt on a
 *    row passes THE SAME idempotency key, derived from the row id and
 *    never from the attempt, and Resend returns the original message id
 *    rather than sending a second copy. The recovery is safe by
 *    construction and it also repairs the row. See `RESEND_IDEMPOTENCY`.
 *
 * ④ SUPPRESSION IS CHECKED AT SEND TIME, NOT AT ENQUEUE TIME.
 *    A letter queued on Monday and sent on Tuesday must respect a bounce
 *    that arrived on Monday night. Checking only at enqueue would be a
 *    suppression list with a hole exactly the width of the queue.
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withTenant, withPlatformScope } from "@/db";
import { emailOutbox, emailSuppressions } from "@/db/schema/email";
import { creditDunningLog } from "@/db/schema/credit";
import { dunningEvents } from "@/db/schema/receivables";
import { sendEmail, type EmailResult } from "@/lib/email/resend";
import { requireCapability } from "@/server/platform/guard";
import {
  CLAIM_LEASE_MS,
  EMAIL_MAX_ATTEMPTS,
  backoffDelayMs,
  decideAfterAttempt,
  isSuppressionReason,
  normalizeEmail,
  outboxIdempotencyKey,
  type SuppressionReason,
} from "@/lib/email/outbox";

/* ------------------------------------------------------------------ */
/* SMALL HELPERS                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `tx.execute()` RETURNS TWO DIFFERENT SHAPES depending on the driver
 * path — a bare array on the HTTP client, `{ rows }` on the WebSocket
 * one. Indexing `[0]` on the wrong one yields `undefined`, which under
 * these rules is "the claim did not happen" and would silently drain
 * nothing forever. Normalised once, here.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/* ------------------------------------------------------------------ */
/* ENQUEUE                                                             */
/* ------------------------------------------------------------------ */

export type EnqueueEmailInput = {
  tenantId: string;
  purpose: string;
  subjectType?: string | null;
  subjectId?: string | null;
  toEmail: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  category: string;
  severity?: string;
  recipientUserId?: string | null;
  /**
   * 🔴 DERIVED FROM WHAT THE MESSAGE IS, NEVER FROM THE CLOCK. Two
   * containers running the same sweep in the same millisecond must
   * produce the same key, or the unique index cannot stop them.
   */
  idempotencyKey: string;
  createdBy?: string | null;
  maxAttempts?: number;
};

/**
 * Put one message in the outbox. Returns the row id, or null when an
 * identical message was already queued.
 *
 * ⚠️ `null` IS A NORMAL OUTCOME, NOT AN ERROR. `onConflictDoNothing`
 * against the per-tenant idempotency key is the guarantee that a sweep
 * re-run does not double-chase a customer — a quiet no-op on the second
 * run rather than an exception, because a sweep that dies on invoice 40
 * of 300 is a sweep that never finishes.
 *
 * ⚠️ TAKES AN EXISTING TRANSACTION. The caller is usually already inside
 * `withTenant()` and the outbox row must land in the SAME transaction as
 * the record that asked for it. A message queued for a dunning log row
 * that then rolled back would be a letter chasing an invoice nobody
 * decided to chase.
 */
export async function enqueueEmail(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  input: EnqueueEmailInput,
): Promise<string | null> {
  const inserted = await tx
    .insert(emailOutbox)
    .values({
      tenantId: input.tenantId,
      purpose: input.purpose,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      toEmail: input.toEmail.trim(),
      toEmailNormalized: normalizeEmail(input.toEmail),
      replyTo: input.replyTo ?? null,
      subject: input.subject,
      bodyHtml: input.html,
      bodyText: input.text,
      category: input.category,
      severity: input.severity ?? "info",
      recipientUserId: input.recipientUserId ?? null,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? EMAIL_MAX_ATTEMPTS,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: emailOutbox.id });

  // ⚠️ An empty array here is "somebody else already queued this", which
  // is exactly what the unique index is for. It is never an error.
  return inserted[0]?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* SUPPRESSION                                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE PREDICATE READ ON EVERY SEND. Global rows (`tenant_id IS NULL`)
 * and this tenant's own rows both count; released rows do not.
 */
function activeSuppression(tenantId: string) {
  return and(
    or(isNull(emailSuppressions.tenantId), eq(emailSuppressions.tenantId, tenantId)),
    isNull(emailSuppressions.releasedAt),
  );
}

/**
 * Which of these addresses may we not write to?
 *
 * ⚠️ ONE QUERY FOR THE WHOLE BATCH, and the answer is a Set of NORMALISED
 * addresses. A per-row query would be fifty round trips inside a
 * transaction; a lookup on the display form would miss every suppression
 * whose casing differs, which is a control that reports success and does
 * nothing.
 */
async function loadSuppressed(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  addresses: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(addresses.map(normalizeEmail))].filter(Boolean);
  if (wanted.length === 0) return new Map();

  const rows = await tx
    .select({
      email: emailSuppressions.emailNormalized,
      reason: emailSuppressions.reason,
      detail: emailSuppressions.detail,
    })
    .from(emailSuppressions)
    .where(
      and(activeSuppression(tenantId), inArray(emailSuppressions.emailNormalized, wanted)),
    );

  const out = new Map<string, string>();
  for (const row of rows) {
    if (!out.has(row.email)) {
      out.set(row.email, row.detail ? `${row.reason}: ${row.detail}` : row.reason);
    }
  }
  return out;
}

/**
 * 🔴 SUPPRESS AN ADDRESS FOR EVERY TENANT. Called by the bounce webhook.
 *
 * ⚠️ IT RUNS UNDER `withPlatformScope` BECAUSE A BOUNCE BELONGS TO
 * NOBODY. The webhook has no session and no tenant — it has a provider
 * message id. And the row it writes is deliberately global: an address
 * that does not exist damages the sending reputation of `ordence.com`
 * itself, which every tenant shares, so the tenant that happened to
 * discover the bounce is not the only one that must stop.
 *
 * ⚠️ IDEMPOTENT. A webhook that is delivered twice — which every webhook
 * eventually is — must suppress once. `NULLS NOT DISTINCT` on the
 * partial unique index in 0097 is what makes the second insert a no-op;
 * without it two NULL tenant ids compare as unequal and the duplicate
 * would quietly succeed.
 */
export async function suppressEmailGlobally(input: {
  email: string;
  reason: SuppressionReason;
  detail?: string | null;
  source: string;
  providerMessageId?: string | null;
}): Promise<{ suppressed: boolean }> {
  const normalized = normalizeEmail(input.email);
  if (!normalized) return { suppressed: false };
  if (!isSuppressionReason(input.reason)) return { suppressed: false };

  return withPlatformScope(
    "A hard bounce or spam complaint suppresses an address for every tenant, because the sending reputation it damages is shared by all of them.",
    async (tx) => {
      const inserted = await tx
        .insert(emailSuppressions)
        .values({
          tenantId: null,
          emailNormalized: normalized,
          reason: input.reason,
          detail: input.detail?.slice(0, 500) ?? null,
          source: input.source,
          providerMessageId: input.providerMessageId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: emailSuppressions.id });

      /*
       * ⚠️ ALSO STOP WHAT IS STILL IN THE QUEUE. Suppressing the address
       * without draining the messages already owed to it would let the
       * next tick send every one of them and only then start refusing.
       * Under platform scope this reaches every tenant's queue, which is
       * the point.
       */
      await tx
        .update(emailOutbox)
        .set({
          status: "suppressed",
          lastErrorCode: input.reason,
          lastErrorMessage: `Suppressed before sending: ${input.reason}.`.slice(0, 500),
          claimToken: null,
        })
        .where(
          and(
            eq(emailOutbox.toEmailNormalized, normalized),
            inArray(emailOutbox.status, ["queued", "sending"]),
          ),
        );

      /*
       * ⚠️ `false` HERE MEANS "ALREADY SUPPRESSED", NOT "FAILED". The
       * webhook is delivered twice sooner or later, and the second
       * delivery must be a quiet no-op rather than a duplicate row or an
       * error — but the caller is told which of the two happened,
       * because "we suppressed 400 addresses last night" and "we
       * received 400 duplicate webhooks" are very different sentences.
       */
      return { suppressed: inserted.length > 0 };
    },
  );
}

/* ------------------------------------------------------------------ */
/* THE DRAIN                                                           */
/* ------------------------------------------------------------------ */

type ClaimedRow = {
  id: string;
  toEmail: string;
  toEmailNormalized: string;
  replyTo: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  attempts: number;
  maxAttempts: number;
  subjectType: string | null;
  subjectId: string | null;
  claimToken: string;
};

export type DispatchReport = {
  claimed: number;
  sent: number;
  suppressed: number;
  retrying: number;
  deferred: number;
  dead: number;
  released: number;
  /** ⭐ Present so an operator can see WHY, not only how many. */
  notes: string[];
};

export type SendFn = typeof sendEmail;

/**
 * 🔴 THE CLAIM. One statement, and the only place a row leaves `queued`.
 *
 * ⚠️ `FOR UPDATE SKIP LOCKED` ON THE INNER SELECT IS THE WHOLE THING.
 * Without `SKIP LOCKED` a second worker BLOCKS on the rows the first is
 * taking, wakes when they commit, re-evaluates `status = 'queued'`,
 * finds nothing, and has achieved nothing but latency. With it, the
 * second worker takes different rows and both make progress.
 *
 * ⚠️ `status = 'queued'` APPEARS IN BOTH THE INNER SELECT AND THE OUTER
 * UPDATE. The inner one chooses; the outer one is the guarantee. On a
 * database that re-evaluates the row after the lock is granted, only the
 * outer predicate stops a row that changed underneath us.
 *
 * ⚠️ ATTEMPTS ARE **NOT** INCREMENTED HERE. A claim is not an attempt —
 * a batch abandoned because the provider started rate limiting would
 * otherwise burn an attempt on messages that were never offered. The
 * increment happens on the failure write-back, and on lease expiry,
 * which is where an attempt genuinely was spent.
 */
async function claimBatch(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  limit: number,
  now: Date,
  token: string,
): Promise<ClaimedRow[]> {
  const result = await tx.execute(sql`
    UPDATE email_outbox AS o
       SET status      = 'sending',
           claim_token = ${token}::uuid,
           claimed_at  = ${now.toISOString()}::timestamptz
     WHERE o.id IN (
             SELECT c.id
               FROM email_outbox AS c
              WHERE c.tenant_id       = ${tenantId}::uuid
                AND c.status          = 'queued'
                AND c.next_attempt_at <= ${now.toISOString()}::timestamptz
              ORDER BY c.next_attempt_at ASC, c.queued_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT ${limit}
           )
       AND o.status = 'queued'
    RETURNING o.id, o.to_email, o.to_email_normalized, o.reply_to, o.subject,
              o.body_html, o.body_text, o.attempts, o.max_attempts,
              o.subject_type, o.subject_id
  `);

  return rowsOf(result).map((r) => ({
    id: str(r.id),
    toEmail: str(r.to_email),
    toEmailNormalized: str(r.to_email_normalized),
    replyTo: r.reply_to === null || r.reply_to === undefined ? null : str(r.reply_to),
    subject: str(r.subject),
    bodyHtml: str(r.body_html),
    bodyText: str(r.body_text),
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? EMAIL_MAX_ATTEMPTS),
    subjectType:
      r.subject_type === null || r.subject_type === undefined ? null : str(r.subject_type),
    subjectId: r.subject_id === null || r.subject_id === undefined ? null : str(r.subject_id),
    claimToken: token,
  }));
}

/**
 * ⭐ RECLAIM WHAT A DEAD WORKER LEFT BEHIND.
 *
 * 🔴 THIS IS THE ONLY PLACE THAT MAY MOVE A ROW OUT OF `sending`, AND IT
 * IS ALSO WHERE A CRASHED SEND BECOMES SAFE. The row goes back to
 * `queued` with an attempt spent — and when it is next picked up it
 * carries the SAME idempotency key, so if the crash happened AFTER the
 * provider accepted the message, Resend returns the original id and no
 * second email is delivered. That is why the key may never include the
 * attempt number.
 */
async function reclaimExpiredClaims(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  const result = await tx.execute(sql`
    UPDATE email_outbox
       SET status             = CASE
                                  WHEN attempts + 1 >= max_attempts THEN 'dead'
                                  ELSE 'queued'
                                END,
           attempts           = attempts + 1,
           next_attempt_at    = ${now.toISOString()}::timestamptz + interval '1 minute',
           dead_at            = CASE
                                  WHEN attempts + 1 >= max_attempts
                                  THEN ${now.toISOString()}::timestamptz
                                  ELSE dead_at
                                END,
           claim_token        = NULL,
           last_error_code    = 'claim_expired',
           last_error_message = 'A worker claimed this message and never reported back. It is offered again with the same idempotency key, so if it did reach the provider no second copy is delivered.'
     WHERE tenant_id  = ${tenantId}::uuid
       AND status     = 'sending'
       AND claimed_at < ${cutoff}::timestamptz
    RETURNING id
  `);
  return rowsOf(result).length;
}

/**
 * Write the outcome of ONE attempt back.
 *
 * 🔴 THE `claim_token` IN THE WHERE CLAUSE IS NOT DECORATION. A worker
 * that stalled past its lease, had the row reclaimed, and then woke up
 * would otherwise stamp its stale verdict over the state a newer worker
 * has since established. The update simply matches nothing instead, and
 * the caller is told — an empty `returning()` is a write that did not
 * happen and is never reported as success.
 */
async function writeBack(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  row: ClaimedRow,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const updated = await tx
    .update(emailOutbox)
    .set(patch)
    .where(
      and(
        eq(emailOutbox.id, row.id),
        eq(emailOutbox.status, "sending"),
        eq(emailOutbox.claimToken, row.claimToken),
      ),
    )
    .returning({ id: emailOutbox.id });

  return updated[0] !== undefined;
}

/**
 * ⭐ TELL THE RECORD THAT ASKED FOR THE LETTER WHAT HAPPENED TO IT.
 *
 * 🔴 WITHOUT THIS THE FIX IS HALF DONE. `credit_dunning_log.delivery`
 * would still read `queued` forever, the collections screen would still
 * say nothing had gone out, and the sweep would still be unable to tell
 * a letter that was delivered from one that was never attempted — which
 * is the exact defect this batch exists to end, moved one table across.
 */
async function mirrorToSubject(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  tenantId: string,
  row: ClaimedRow,
  outcome: {
    delivery: "sent" | "failed" | "suppressed";
    at: Date;
    reason?: string;
    providerMessageId?: string | null;
  },
): Promise<void> {
  /*
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 A REAL-ESTATE DEMAND NOTICE. THE ONLY WRITER OF `dispatched_at`.
   * ══════════════════════════════════════════════════════════════════
   * `dunning_events` used to stamp `sent_at` at the moment the row was
   * created, for a letter nothing ever sent — false evidence in the table
   * a developer puts in front of a RERA Authority to justify cancelling
   * an allotment. SQL 0098 split that into three facts and made the old
   * behaviour a constraint violation.
   *
   * ⭐ THIS IS WHERE THE MIDDLE FACT BECOMES TRUE, and it is the only
   * place in the codebase that can make it true: `dispatched_at` may not
   * exist without a provider message id (CHECK), and a provider message
   * id only comes back from Resend. No form, no import and no back-fill
   * can reach this state, which is the entire design.
   */
  if (row.subjectType === "dunning_event" && row.subjectId) {
    if (outcome.delivery === "sent" && outcome.providerMessageId) {
      await tx
        .update(dunningEvents)
        .set({
          serviceEvidence: "system_dispatch",
          dispatchedAt: outcome.at,
          dispatchProviderMessageId: outcome.providerMessageId,
          dispatchFailedAt: null,
          dispatchFailureReason: null,
          /*
           * ⚠️ THE LEGACY COLUMN IS FILLED ONLY NOW, when there is finally
           * something behind it. A report still reading `sent_at` stops
           * being wrong about this row instead of staying wrong quietly.
           */
          sentAt: outcome.at,
          updatedAt: outcome.at,
        })
        .where(
          and(eq(dunningEvents.id, row.subjectId), eq(dunningEvents.tenantId, tenantId)),
        );
    } else {
      /*
       * 🔴 A FAILED DEMAND NOTICE IS NOT "PENDING", IT IS NOT SERVED, and
       * the grade is deliberately left where it was. Recording the reason
       * without promoting the evidence is what lets the cancellation
       * screen say "this notice hard-bounced" rather than showing a blank
       * that reads like nothing has happened yet.
       */
      await tx
        .update(dunningEvents)
        .set({
          dispatchFailedAt: outcome.at,
          dispatchFailureReason: (outcome.reason ?? "The send did not succeed.").slice(0, 500),
          updatedAt: outcome.at,
        })
        .where(
          and(eq(dunningEvents.id, row.subjectId), eq(dunningEvents.tenantId, tenantId)),
        );
    }
    return;
  }

  if (row.subjectType !== "credit_dunning_log" || !row.subjectId) return;

  await tx
    .update(creditDunningLog)
    .set({
      delivery: outcome.delivery,
      sentAt: outcome.delivery === "sent" ? outcome.at : null,
      failureReason: outcome.reason ?? null,
    })
    .where(
      and(
        eq(creditDunningLog.id, row.subjectId),
        eq(creditDunningLog.tenantId, tenantId),
      ),
    );
}

/**
 * Drain one tenant's outbox.
 *
 * ⚠️ SEQUENTIAL, NOT `Promise.all`. Fifty parallel sends into a provider
 * that is already rate limiting turns one 429 into fifty, and every one
 * of them counts against the same bucket. Going one at a time also lets
 * the batch STOP the moment a rate limit appears, leaving the rest
 * genuinely untouched rather than fifty rows each carrying an attempt
 * they never really got.
 *
 * @param send injected only so the tests can drive it. Production always
 *             uses `sendEmail` from `lib/email/resend.ts`.
 */
export async function dispatchTenantOutbox(input: {
  tenantId: string;
  limit?: number;
  now?: Date;
  send?: SendFn;
}): Promise<DispatchReport> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const send = input.send ?? sendEmail;
  const token = randomUUID();

  const report: DispatchReport = {
    claimed: 0,
    sent: 0,
    suppressed: 0,
    retrying: 0,
    deferred: 0,
    dead: 0,
    released: 0,
    notes: [],
  };

  /*
   * ⚠️ THE CLAIM IS ITS OWN TRANSACTION AND COMMITS BEFORE ANY NETWORK
   * CALL. Holding a transaction open across an HTTPS round trip to
   * Resend would pin a pooled connection for the length of the slowest
   * provider response, and fifty of those exhaust the pool — a mail
   * backlog becoming a database outage.
   */
  const claimed = await withTenant(input.tenantId, async (tx) => {
    report.released = await reclaimExpiredClaims(tx, input.tenantId, now);
    const rows = await claimBatch(tx, input.tenantId, limit, now, token);
    const barred = await loadSuppressed(
      tx,
      input.tenantId,
      rows.map((r) => r.toEmailNormalized),
    );
    return { rows, barred };
  });

  report.claimed = claimed.rows.length;
  if (report.released > 0) {
    report.notes.push(
      `${report.released} message(s) had been claimed by a worker that never reported back and were offered again with the same idempotency key.`,
    );
  }
  if (claimed.rows.length === 0) return report;

  let rateLimited = false;

  for (const row of claimed.rows) {
    /*
     * 🔴 SUPPRESSION IS CHECKED HERE, AFTER THE CLAIM, BECAUSE THE QUEUE
     * HAS A DURATION. A letter queued on Monday and drained on Tuesday
     * must respect a bounce that arrived on Monday night.
     */
    const barredReason = claimed.barred.get(row.toEmailNormalized);
    if (barredReason) {
      await withTenant(input.tenantId, async (tx) => {
        const ok = await writeBack(tx, row, {
          status: "suppressed",
          claimToken: null,
          lastErrorCode: "suppressed",
          lastErrorMessage: `Not sent. This address is suppressed (${barredReason}).`.slice(0, 500),
        });
        if (ok) {
          await mirrorToSubject(tx, input.tenantId, row, {
            delivery: "suppressed",
            at: now,
            reason: `This address is suppressed (${barredReason}), so nothing was sent.`,
          });
        }
      });
      report.suppressed += 1;
      continue;
    }

    if (rateLimited) {
      // The provider said "later" on an earlier message in this batch.
      // Offering the rest immediately would spend the same bucket.
      await withTenant(input.tenantId, async (tx) => {
        await writeBack(tx, row, {
          status: "queued",
          claimToken: null,
          nextAttemptAt: new Date(now.getTime() + backoffDelayMs(row.attempts + 1)),
          lastErrorCode: "rate_limited",
          lastErrorMessage:
            "Held back because the provider was rate limiting earlier in this batch. No attempt was spent on it.",
        });
      });
      report.retrying += 1;
      continue;
    }

    let result: EmailResult;
    try {
      result = await send({
        to: row.toEmail,
        subject: row.subject,
        html: row.bodyHtml,
        text: row.bodyText,
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        /*
         * 🔴 THE SAME KEY ON EVERY ATTEMPT. This is the entire answer to
         * "a crash between send and mark must not resend": the provider
         * deduplicates and hands back the original id.
         */
        idempotencyKey: outboxIdempotencyKey(row.id),
        logContext: { outboxId: row.id, tenantId: input.tenantId },
      });
    } catch {
      /*
       * ⚠️ `sendEmail` DOCUMENTS THAT IT NEVER THROWS, AND THIS CATCH IS
       * STILL HERE. A thrown error would abandon the loop with the
       * remaining rows stuck in `sending` until their lease expires —
       * a promise in a comment is not a guarantee at a boundary.
       */
      result = { ok: false, reason: "unknown", message: "The send threw unexpectedly." };
    }

    /*
     * 🔴 THE VERDICT IS COMPUTED BY A PURE FUNCTION, NOT DECIDED HERE.
     * `decideAfterAttempt` is the only place that knows whether a failure
     * is worth repeating, and it lives in `lib/email/outbox.ts` so a unit
     * test can exercise it without a database and a mail provider. The
     * rules that decide whether a customer is ever chased again are not
     * allowed to be reachable only in production.
     */
    const verdict = decideAfterAttempt({
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      ok: result.ok,
      /*
       * ⚠️ THE PROVIDER ID IS PASSED, NOT ASSERTED. `EmailResult` makes
       * `id` reachable only on the `ok: true` branch, and the decision
       * function refuses `sent` without one anyway — belt and braces,
       * because the CHECK constraint in 0097 will refuse the write.
       */
      ...(result.ok ? { providerMessageId: result.id } : {}),
      ...(result.ok ? {} : { reason: result.reason, message: result.message }),
    });

    if (verdict.code === "rate_limited") rateLimited = true;

    const stored = await withTenant(input.tenantId, async (tx) => {
      const ok = await writeBack(tx, row, {
        status: verdict.status,
        claimToken: null,
        attempts: verdict.attemptsAfter,
        ...(verdict.status === "sent" && result.ok
          ? { providerMessageId: result.id, sentAt: now }
          : {}),
        ...(verdict.status === "dead" ? { deadAt: now } : {}),
        nextAttemptAt:
          verdict.delayMs > 0 ? new Date(now.getTime() + verdict.delayMs) : now,
        lastErrorCode: verdict.status === "sent" ? null : verdict.code,
        lastErrorMessage: verdict.status === "sent" ? null : verdict.explanation.slice(0, 500),
      });

      if (!ok) return false;

      if (verdict.status === "sent") {
        await mirrorToSubject(tx, input.tenantId, row, {
          delivery: "sent",
          at: now,
          // 🔴 The proof travels with the outcome. A demand notice cannot
          // be marked dispatched without it — the database says so.
          ...(result.ok ? { providerMessageId: result.id } : {}),
        });
      } else if (verdict.status === "dead") {
        await mirrorToSubject(tx, input.tenantId, row, {
          delivery: "failed",
          at: now,
          reason: verdict.explanation,
        });
      }
      return true;
    });

    if (!stored) {
      /*
       * ⚠️ AN EMPTY `returning()` IS A WRITE THAT DID NOT HAPPEN, AND IT
       * IS NEVER REPORTED AS SUCCESS. This worker's lease had expired and
       * a newer one owns the row; saying "sent" here would be a count
       * nobody can reconcile against the table.
       */
      report.notes.push(
        `Message ${row.id} finished after its claim had already expired, so a newer worker owns the row. Nothing was overwritten.`,
      );
      continue;
    }

    if (verdict.status === "sent") report.sent += 1;
    else if (verdict.status === "dead") {
      report.dead += 1;
      report.notes.push(`${row.toEmail}: ${verdict.explanation}`);
    } else if (verdict.attemptsAfter === row.attempts) {
      report.deferred += 1;
      report.notes.push(verdict.explanation);
    } else {
      report.retrying += 1;
    }
  }

  return report;
}

/* ------------------------------------------------------------------ */
/* WHAT THE PROVIDER TELLS US AFTERWARDS                               */
/* ------------------------------------------------------------------ */

/**
 * Record a delivery event that arrived by webhook.
 *
 * ⚠️ RUNS UNDER PLATFORM SCOPE BECAUSE THE WEBHOOK HAS NO TENANT. All it
 * carries is a provider message id, and finding which workspace that
 * belongs to is the whole reason for the lookup. The scope is used to
 * READ the owning tenant and to write the outcome onto that same row —
 * never to write into a tenant chosen by the payload.
 */
export async function recordDeliveryEvent(input: {
  providerMessageId: string;
  event: "bounced" | "complained" | "delivered";
  detail?: string | null;
  permanent: boolean;
  at: Date;
}): Promise<{ matched: boolean; suppressedEmail: string | null }> {
  if (!input.providerMessageId) return { matched: false, suppressedEmail: null };

  const found = await withPlatformScope(
    "A delivery webhook identifies a message only by the provider's id, so the owning workspace has to be looked up before the outcome can be recorded.",
    async (tx) => {
      const rows = await tx
        .select({
          id: emailOutbox.id,
          tenantId: emailOutbox.tenantId,
          email: emailOutbox.toEmailNormalized,
          subjectType: emailOutbox.subjectType,
          subjectId: emailOutbox.subjectId,
        })
        .from(emailOutbox)
        .where(eq(emailOutbox.providerMessageId, input.providerMessageId))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      if (input.event === "bounced" || input.event === "complained") {
        await tx
          .update(emailOutbox)
          .set({
            status: "bounced",
            bouncedAt: input.at,
            lastErrorCode: input.event === "complained" ? "complaint" : "bounce",
            lastErrorMessage: (input.detail ?? "The receiving server refused it.").slice(0, 500),
          })
          .where(eq(emailOutbox.id, row.id));

        if (row.subjectType === "credit_dunning_log" && row.subjectId) {
          /*
           * ⭐ A BOUNCE IS NOT A SEND, AND THE COLLECTIONS RECORD HAS TO
           * SAY SO. "We wrote to you on the 14th" is not a claim anybody
           * should make about a message the customer's mail server
           * refused.
           */
          await tx
            .update(creditDunningLog)
            .set({
              delivery: "failed",
              sentAt: null,
              failureReason: `The customer's mail server refused this message (${input.event}). It was not received.`,
            })
            .where(eq(creditDunningLog.id, row.subjectId));
        }
      }

      return { email: row.email, tenantId: row.tenantId };
    },
  );

  if (!found) return { matched: false, suppressedEmail: null };

  /*
   * 🔴 ONLY A PERMANENT FAILURE SUPPRESSES. "Mailbox full" and
   * "greylisted" are temporary; suppressing on them would permanently
   * silence a customer whose inbox was briefly over quota, and nobody
   * would ever notice. A complaint always suppresses — a real person
   * marked us as spam, and there is no soft version of that.
   */
  const shouldSuppress =
    input.event === "complained" || (input.event === "bounced" && input.permanent);

  if (!shouldSuppress) return { matched: true, suppressedEmail: null };

  await suppressEmailGlobally({
    email: found.email,
    reason: input.event === "complained" ? "complaint" : "hard_bounce",
    detail: input.detail ?? null,
    source: "resend_webhook",
    providerMessageId: input.providerMessageId,
  });

  return { matched: true, suppressedEmail: found.email };
}

/* ------------------------------------------------------------------ */
/* WHAT THE OPERATOR READS                                             */
/* ------------------------------------------------------------------ */

export type OutboxConsoleRow = {
  id: string;
  tenantId: string;
  purpose: string;
  toEmail: string;
  subject: string;
  category: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  nextAttemptAt: Date;
};

export type SuppressionConsoleRow = {
  id: string;
  tenantId: string | null;
  email: string;
  reason: string;
  detail: string | null;
  source: string;
  suppressedAt: Date;
};

/**
 * ⭐ THE CONSOLE'S READ. Cross-tenant, because deliverability is the one
 * problem that is genuinely not a tenant's own: a single workspace
 * mailing dead addresses degrades delivery for every other customer, and
 * nobody inside that workspace can see it happening.
 */
export async function readOutboxForConsole(options?: {
  status?: string;
  limit?: number;
}): Promise<{ outbox: OutboxConsoleRow[]; suppressions: SuppressionConsoleRow[] }> {
  /*
   * 🔴 THE CAPABILITY IS CHECKED HERE, NOT ONLY ON THE PAGE. This
   * function reads the SUBJECT LINE AND RECIPIENT of every message every
   * workspace has ever sent. A page-level guard protects the page; it
   * protects nothing about the function, and the function is the thing
   * that can be reached from anywhere else in the server tree.
   */
  await requireCapability("observatory:read");

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  const status = options?.status;

  return withPlatformScope(
    "The mail console shows queued, sent, bounced, suppressed and dead-lettered messages across every workspace, because sending reputation is shared and no single tenant can see it.",
    async (tx) => {
      const outbox = await tx
        .select({
          id: emailOutbox.id,
          tenantId: emailOutbox.tenantId,
          purpose: emailOutbox.purpose,
          toEmail: emailOutbox.toEmail,
          subject: emailOutbox.subject,
          category: emailOutbox.category,
          status: emailOutbox.status,
          attempts: emailOutbox.attempts,
          maxAttempts: emailOutbox.maxAttempts,
          providerMessageId: emailOutbox.providerMessageId,
          lastErrorCode: emailOutbox.lastErrorCode,
          lastErrorMessage: emailOutbox.lastErrorMessage,
          queuedAt: emailOutbox.queuedAt,
          sentAt: emailOutbox.sentAt,
          nextAttemptAt: emailOutbox.nextAttemptAt,
        })
        .from(emailOutbox)
        .where(status && status !== "all" ? eq(emailOutbox.status, status) : undefined)
        .orderBy(desc(emailOutbox.queuedAt))
        .limit(limit);

      const suppressions = await tx
        .select({
          id: emailSuppressions.id,
          tenantId: emailSuppressions.tenantId,
          email: emailSuppressions.emailNormalized,
          reason: emailSuppressions.reason,
          detail: emailSuppressions.detail,
          source: emailSuppressions.source,
          suppressedAt: emailSuppressions.suppressedAt,
        })
        .from(emailSuppressions)
        .where(isNull(emailSuppressions.releasedAt))
        .orderBy(desc(emailSuppressions.suppressedAt))
        .limit(limit);

      return { outbox, suppressions };
    },
  );
}
