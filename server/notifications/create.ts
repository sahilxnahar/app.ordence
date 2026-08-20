import "server-only";

/**
 * Ordence — Notification creation (internal)
 * Version: v1.82.0-alpha  ·  SQL 0097 (outbox) + 0159 (ceiling)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS FUNCTION LIVES HERE AND NOT IN `server/actions/`
 * ══════════════════════════════════════════════════════════════════════
 * It used to be exported from `server/actions/notifications.ts`, which is
 * a `"use server"` file. That file's own header states the rule:
 *
 *     ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION. A "use server" file that
 *     exports anything else publishes it as an RPC endpoint reachable
 *     by anyone.
 *
 * The rule was followed — every export WAS an async function — and that
 * is precisely what made this one dangerous. `createNotification` takes
 * `tenantId` FROM ITS CALLER and passes it straight to `withTenant()`.
 * It never called `requireTenantContext()`.
 *
 * So it was a published endpoint that accepted the tenant to write into
 * as a parameter. Any authenticated session could invoke it with another
 * workspace's uuid and:
 *
 *   · insert a row into that workspace's notification feed
 *   · with an attacker-chosen title, body and actionUrl
 *   · and, at severity "critical" or "warning", EMAIL EVERY ACTIVE USER
 *     in that workspace — an Ordence-branded message containing a link
 *     the attacker chose
 *
 * Row-level security did not help. RLS enforces the tenant the
 * transaction declares, and this function let the caller declare it.
 * That is the one way past it, and it was reachable from a browser.
 *
 * ⚠️ THE FIX IS THE FILE IT IS IN, NOT A CHECK INSIDE IT.
 *
 * Adding `requireTenantContext()` here would have broken the real
 * callers — a background worker, the MCP dispatcher and the Clerk
 * webhook — which have no user session and legitimately act for a tenant
 * they were given. The correct boundary is: this is an INTERNAL module,
 * `server-only`, not callable from a browser at all. `check:boundaries`
 * enforces that a file like this declares `import "server-only"`, which
 * is the line above.
 *
 * If the UI ever needs to create a notification, add a THIN wrapper in
 * `server/actions/notifications.ts` that calls `requireTenantContext()`
 * and passes `ctx.tenant.id` — never a tenant id from the client.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT CHANGED IN 1.82.0, AND WHY IT IS THE WHOLE POINT OF THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * This function used to commit its transaction and THEN fan out up to
 * fifty `sendEmail` calls straight at the provider. Its own TODO admitted
 * the shape was wrong: "move this to the existing queue … Parallelising
 * is the containment, not the cure."
 *
 * That path went around `email_outbox` — and therefore around every
 * safeguard SQL 0097 built:
 *
 *   ① IT NEVER CONSULTED THE SUPPRESSION LIST. A hard-bounced mailbox was
 *     offered to the provider again on every worker run. Mail from every
 *     workspace leaves under ONE sending domain, so the cost of that lands
 *     on the delivery of tenants doing nothing wrong. It is the one email
 *     failure in this product that is not confined to the tenant causing
 *     it.
 *   ② A RATE LIMIT WAS A LOST MESSAGE. `console.error`, and gone. No
 *     attempt count, no backoff, no dead letter, and no row anyone could
 *     open afterwards to answer "why did this user never hear from us".
 *   ③ A CRASH BETWEEN COMMIT AND SEND LOST IT WITH NO TRACE, and a re-run
 *     of the background worker re-mailed all fifty, because nothing
 *     carried an idempotency key.
 *
 * ⭐ NOW: one `email_outbox` row per recipient, written INSIDE the same
 * transaction as the notification itself. Both land or neither does. The
 * dispatcher that already exists — claim lease, `FOR UPDATE SKIP LOCKED`,
 * suppression checked at send time, bounded backoff, dead letter with the
 * reason kept, and the same idempotency key on every attempt — is what
 * delivers them.
 *
 * ⚠️ AND IT STILL TRIES TO SEND IMMEDIATELY, ON PURPOSE. Read the note on
 * `drainAfterCommit` below before removing that. A queue whose drain is
 * not on a clock is not a deferred send; it is a deletion with a receipt,
 * and today nothing in production is on a clock.
 *
 * Callers, all server-side and all legitimate:
 *   server/ai/background-workers.ts
 *   server/mcp/dispatch.ts
 *   app/api/webhooks/clerk/_webhook.ts
 */

import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { notifications, users, tenants } from "@/db/schema";
import { buildNotificationEmail } from "@/lib/email/notifications";
import {
  MAX_NOTIFICATION_RECIPIENTS,
  NOTIFICATION_OUTBOX_PURPOSE,
  NOTIFICATION_SUBJECT_TYPE,
  notificationEmailSubject,
  notificationIdempotencyKey,
  planNotificationRecipients,
  severityWarrantsEmail,
} from "@/lib/email/notification-outbox";
/**
 * ⭐ THE OUTBOX IS IMPORTED, NOT REIMPLEMENTED. `server/email/outbox.ts`
 * belongs to another stream; nothing here writes to it beyond calling the
 * two functions it publishes for exactly this. A second enqueue path
 * would be a second set of rules about when a customer is chased, which
 * is how this codebase ended up with two `sendEmail` functions that
 * disagreed.
 */
import { dispatchTenantOutbox, enqueueEmail } from "@/server/email/outbox";
import {
  parseNotificationPreferences,
  shouldEmailNotification,
} from "@/lib/notifications/preferences";

/**
 * ⚠️ THE OPPORTUNISTIC DRAIN, AND WHY IT IS NOT A LAYERING MISTAKE.
 *
 * 🔴 `docs/current/CRON-RUNBOOK.md` opens with the fact that decided this:
 * Railway runs one service for Ordence and NO SCHEDULER IS ATTACHED TO IT.
 * "Until something calls the endpoints below on a clock, every job in this
 * document does not run, and nothing in the product says so." `mail_drain`
 * is one of those jobs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WAVE 17: TRACK A HAS LANDED, AND THIS CALL STILL STAYS. READ WHY.
 * ══════════════════════════════════════════════════════════════════════
 * Track A delivered `scheduler_runs`, per-job controls and expectations,
 * per-tenant schedules and pauses, a heartbeat and a watchdog (SQL
 * 0129-0132). That is the LEDGER, the CONTROLS and the WATCHDOG. None of
 * them is the clock: something still has to POST to `/api/workers` on a
 * schedule, and that is a deployment configuration no table can supply.
 *
 * ⭐ WHAT CHANGED IS THAT THE QUESTION IS NOW MEASURABLE. `docs/JOBS.md` §5
 * lists the three conditions for deleting this call, and every one of them
 * is a query against Track A's own tables rather than a matter of opinion:
 * `mail_drain` rows in `scheduler_runs` with a `finished_at`; a cadence in
 * `scheduler_job_expectations` that somebody has accepted as the maximum
 * wait for a `critical` notification; and the pause question below settled.
 *
 * 🔴 THE PAUSE QUESTION, BECAUSE IT CUTS THE OTHER WAY. This call does NOT
 * consult `scheduler_tenant_pauses`. An operator who pauses a workspace
 * stops `mail_drain` for it and this line keeps sending — a pause that does
 * not pause. That is an argument for DELETING this call, not for teaching
 * it to read another track's table. Deleting it before a clock exists would
 * trade a pause that does not pause for mail that does not send, which is
 * worse; so it stays until all three conditions hold, and not one day
 * longer.
 *
 * So moving these messages into the outbox and stopping there would have
 * traded "sent immediately, unrecorded, unsuppressed" for "never sent at
 * all" — the exact failure `lib/email/outbox.ts` names in its own header:
 * a queue with no drain is a deletion with a receipt. A durability change
 * that silences a workspace's critical alerts is not an improvement.
 *
 * ⭐ SO THE ROW IS DURABLE FIRST AND DELIVERED SECOND. The transaction is
 * the guarantee; this call is only latency. If it throws, if the provider
 * is down, if the container dies one line later — the row is already
 * committed and the sweep will find it. That ordering is the entire
 * difference from the code this replaced.
 *
 * ⚠️ IT IS BOUNDED AND IT NEVER THROWS. `dispatchTenantOutbox` claims with
 * `FOR UPDATE SKIP LOCKED`, so a concurrent sweep and this call cannot
 * take the same row, and a failure here must never fail the notification
 * that has already been recorded.
 */
async function drainAfterCommit(tenantId: string, queued: number): Promise<void> {
  try {
    await dispatchTenantOutbox({
      tenantId,
      /*
       * ⚠️ The bound is what we just queued, not a fixed batch. This is a
       * user-facing request path; it may pay for its own work and should
       * not volunteer to drain somebody's dunning backlog on top of it.
       */
      limit: Math.min(Math.max(queued, 1), MAX_NOTIFICATION_RECIPIENTS),
    });
  } catch (err) {
    console.error(
      `[notifications] the immediate outbox drain failed for tenant ${tenantId}. ` +
        `The messages are queued and committed, so the mail sweep will send them; ` +
        `nothing has been lost.`,
      err,
    );
  }
}

export async function createNotification(input: {
  tenantId: string;
  userId?: string;
  category: string;
  severity?: string;
  title: string;
  body?: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  source?: string;
  expiresAt?: Date;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const severity = input.severity ?? "info";

  /*
   * ⚠️ EMAIL IS OPT-IN BY SEVERITY. The rule is `severityWarrantsEmail` in
   * `lib/email/notification-outbox.ts` — one expression, in a pure module, so
   * a proof can hold it still. It used to include `|| !input.severity`, which
   * meant an ordinary `info` notification with no severity passed also
   * emailed every active user; `server/ai/background-workers.ts` creates
   * those on a schedule.
   */
  const shouldEmail = severityWarrantsEmail(severity);

  try {
    /*
     * ⚠️ ONE TRANSACTION, NOT THREE ROUND TRIPS — AND NOW IT CARRIES THE
     * SIDE EFFECT TOO.
     *
     * The insert, the tenant name, the recipient list AND the outbox rows are
     * all tenant-scoped writes and reads, so they belong in the same
     * `withTenant()` block. Previously this was an insert in one transaction,
     * a `db` read, and a SECOND transaction for the recipients — three
     * separate connections per notification.
     *
     * 🔴 The tenant-name lookup was also silently broken. It used the plain
     * `db` client, which carries NO tenant context, so every RLS policy
     * evaluates `tenant_id = app_current_tenant_id()` against NULL and matches
     * nothing — the same failure documented on `withPlatformScope()`. It
     * returned zero rows and fell through to "Your workspace" every single
     * time. Inside the transaction it actually resolves.
     *
     * 🔴🔴 AND THIS IS WHERE "NO SIDE EFFECT FOR A ROLLED-BACK TRANSACTION"
     * BECOMES TRUE. The outbox rows are written here, beside the notification
     * they describe. If anything below fails, Postgres removes both. There is
     * no window in which a workspace has been emailed about a notification
     * that does not exist.
     */
    const created = await withTenant(input.tenantId, async (tx) => {
      const result = await tx
        .insert(notifications)
        .values({
          tenantId: input.tenantId,
          userId: input.userId ?? null,
          category: input.category,
          severity,
          title: input.title,
          body: input.body ?? null,
          actionUrl: input.actionUrl ?? null,
          metadata: input.metadata ?? {},
          source: input.source ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning({ id: notifications.id });

      const id = result[0]?.id;
      if (!id) throw new Error("Notification insert returned no id.");

      if (!shouldEmail) return { id, queued: 0 };

      const tenantRow = await tx
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);

      /*
       * ⭐⭐ THE PREFERENCE COLUMN IS READ HERE, AND THIS IS THE POINT OF
       * THE 0093 / v1.53.0 CHANGE.
       *
       * 🔴 UNTIL THEN THIS LINE SELECTED ONLY `email`, AND THAT WAS THE
       *    DEFECT. The settings screen let a user switch off "Inventory"
       *    or turn off email delivery entirely, and stored the answer in
       *    that browser's `localStorage`. This function — a background
       *    worker's function, running on a schedule with no browser
       *    anywhere near it — could not read that store and so emailed
       *    every active user regardless. The switch moved, went grey,
       *    and changed nothing.
       *
       * ⚠️ `id` IS SELECTED TOO, AND IT IS LOAD-BEARING NOW. It is half of
       *    the idempotency key and it is `email_outbox.recipient_user_id`,
       *    so the mail console can answer "why did this person get this"
       *    without guessing from an address.
       */
      const userRows = await tx
        .select({ id: users.id, email: users.email, preferences: users.preferences })
        .from(users)
        .where(and(eq(users.tenantId, input.tenantId), eq(users.status, "active")))
        .limit(MAX_NOTIFICATION_RECIPIENTS);

      const wanted = userRows.filter((u) =>
        /*
         * ⚠️ `parseNotificationPreferences` IS TOTAL AND THAT MATTERS
         * MOST RIGHT HERE. One user's malformed JSONB must not throw
         * inside this filter and lose the notification for the other
         * forty-nine. Junk resolves to the permissive defaults, so an
         * unreadable preference delivers rather than silences.
         */
        shouldEmailNotification(parseNotificationPreferences(u.preferences), {
          category: input.category,
          severity,
        }),
      );

      const recipients = planNotificationRecipients(
        wanted.map((u) => ({ userId: u.id, email: u.email })),
      );

      if (recipients.length === 0) return { id, queued: 0 };

      const { html, text } = buildNotificationEmail({
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        severity,
        tenantName: tenantRow[0]?.name ?? "Your workspace",
        appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://app.ordence.com",
      });

      const subject = notificationEmailSubject({ severity, title: input.title });

      let queued = 0;
      for (const recipient of recipients) {
        /*
         * ⚠️ SEQUENTIAL, NOT `Promise.all`. These are inserts on ONE
         * transaction; issuing them concurrently on a single connection is
         * not parallelism, it is a race for the same session. The network
         * cost that made the old loop slow was the provider round trip, and
         * that is no longer on this path at all.
         *
         * ⚠️ A `null` RETURN IS A NORMAL OUTCOME. `enqueueEmail` collides on
         * `(tenant_id, idempotency_key)` and does nothing — which is the
         * guarantee that a retry cannot produce a second copy, not an error.
         */
        const outboxId = await enqueueEmail(tx, {
          tenantId: input.tenantId,
          purpose: NOTIFICATION_OUTBOX_PURPOSE,
          subjectType: NOTIFICATION_SUBJECT_TYPE,
          subjectId: id,
          toEmail: recipient.toEmail,
          subject,
          html,
          text,
          category: input.category,
          severity,
          recipientUserId: recipient.recipientUserId,
          idempotencyKey: notificationIdempotencyKey({
            notificationId: id,
            recipientUserId: recipient.recipientUserId,
          }),
        });
        if (outboxId) queued += 1;
      }

      return { id, queued };
    });

    /*
     * ⚠️ AFTER THE COMMIT, AND ONLY EVER AFTER IT. See `drainAfterCommit`.
     * The rows are already durable at this line; this is latency, not
     * delivery, and it cannot fail the notification.
     */
    if (created.queued > 0) await drainAfterCommit(input.tenantId, created.queued);

    /*
     * ⚠️ THE REAL ID. This used to return the literal string "created",
     * discarding the UUID the transaction had just computed. Every caller
     * that stored or echoed the id — including the `ordence_create_reminder`
     * MCP tool, which hands it to an AI agent — received the word "created"
     * where a UUID was promised by this function's own return type.
     */
    return { ok: true, id: created.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create notification.",
    };
  }
}
