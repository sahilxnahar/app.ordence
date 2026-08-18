/**
 * Ordence — ⭐⭐ THE MAIL OUTBOX AND THE SUPPRESSION LIST
 * Version: v1.54.0-alpha  ·  SQL 0097
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS TABLE EXISTS BECAUSE FOUR OTHER QUEUES HAD NO DRAIN
 * ══════════════════════════════════════════════════════════════════════
 * `credit_dunning_log` recorded `delivery = 'queued'` and its own header
 * admitted "there is no SMTP call, no Resend call and no webhook". The
 * user saw "reminder recorded". The customer received nothing.
 *
 * ⚠️ THE FIX IS NOT A `send()` INSIDE THE SWEEP. A sweep that mails
 * inline is a sweep that dies on invoice 40 of 300 with 39 letters gone
 * and no record of which, and reruns from the top. The queue was right.
 * What was missing was the thing that empties it, and the row shape that
 * lets emptying be safe.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* 1 · THE OUTBOX                                                      */
/* ------------------------------------------------------------------ */

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** `dunning` · `notification` · `contract` … what this message is for. */
    purpose: varchar("purpose", { length: 40 }).notNull(),

    /**
     * ⭐ WHAT THIS MESSAGE IS ABOUT, so the dispatcher can write the
     * outcome back to the record that asked for it. A dunning letter that
     * sends must move `credit_dunning_log.delivery` from `queued` to
     * `sent` — otherwise the collections screen keeps the same lie, in a
     * different table.
     */
    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),

    /**
     * 🔴 TWO COLUMNS FOR ONE ADDRESS, AND BOTH ARE LOAD-BEARING.
     * `to_email` is what we address the envelope to, exactly as the
     * customer gave it. `to_email_normalized` is the lowercased form the
     * suppression list is matched on. Matching on the display form would
     * let `Bob@Example.com` walk straight past a suppression stored for
     * `bob@example.com`.
     */
    toEmail: varchar("to_email", { length: 320 }).notNull(),
    toEmailNormalized: varchar("to_email_normalized", { length: 320 }).notNull(),
    replyTo: varchar("reply_to", { length: 320 }),

    subject: varchar("subject", { length: 300 }).notNull(),
    /**
     * 🔴 THE RENDERED BODY, KEPT, for the same reason `message_sends`
     * keeps its own: a demand notice is served evidence, and "template X
     * with parameters A and B" is not what the customer received. The
     * template will have been edited by the time anybody asks.
     */
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),

    /**
     * ⚠️ THE NOTIFICATION CATEGORY AND SEVERITY TRAVEL WITH THE ROW.
     * The per-user preference is applied at ENQUEUE time, by the caller
     * who knows who the recipient is — but they are recorded here so the
     * console can answer "why did this user get this" without guessing.
     */
    category: varchar("category", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 20 }).default("info").notNull(),
    /** Null for a counterparty who has no account with us. */
    recipientUserId: uuid("recipient_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * 🔴🔴 OURS, DERIVED FROM WHAT THE MESSAGE IS — never from the
     * attempt. Unique per tenant, so two sweeps racing produce one row,
     * and passed to Resend on EVERY attempt so a retry after a crash is
     * deduplicated by the provider rather than delivered twice.
     */
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),

    /** queued · sending · sent · bounced · suppressed · dead */
    status: varchar("status", { length: 20 }).default("queued").notNull(),

    /**
     * 🔴 NULL UNTIL THE PROVIDER CONFIRMS. A row with no id here is NOT
     * proof of delivery and must never be marked `sent`.
     */
    providerMessageId: varchar("provider_message_id", { length: 200 }),

    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    /** When this row becomes eligible again. The backoff, materialised. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * ⭐ THE CLAIM. `claim_token` is rewritten on every claim, and every
     * write-back names it in its WHERE clause — so a worker whose lease
     * expired while it was blocked cannot overwrite the state a newer
     * worker has since established.
     */
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),

    lastErrorCode: varchar("last_error_code", { length: 60 }),
    lastErrorMessage: varchar("last_error_message", { length: 500 }),

    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    deadAt: timestamp("dead_at", { withTimezone: true }),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    idempotencyUnique: uniqueIndex("email_outbox_idempotency_key").on(
      t.tenantId,
      t.idempotencyKey,
    ),
    /** The drain's own query: due work for one tenant, oldest first. */
    dueIdx: index("email_outbox_due_idx").on(t.tenantId, t.status, t.nextAttemptAt),
    subjectIdx: index("email_outbox_subject_idx").on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
    /** The webhook arrives holding a provider id and nothing else. */
    providerIdx: index("email_outbox_provider_idx").on(t.providerMessageId),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · THE SUPPRESSION LIST                                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 `tenant_id` IS NULLABLE HERE AND NOWHERE ELSE IN THIS SCHEMA.
 *
 * A hard bounce is a property of the MAILBOX, not of the workspace that
 * happened to write to it first. Mail from every tenant leaves under one
 * sending domain, so an address that does not exist costs every tenant's
 * delivery when we keep offering it — including the tenants doing nothing
 * wrong. Scoping the suppression to the tenant that discovered it would
 * mean the second tenant to mail that address burns the same reputation
 * again, and the third, and so on.
 *
 * ⭐ SO: `tenant_id IS NULL` MEANS GLOBAL. The RLS policy is
 *
 *     USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id())
 *
 * — every tenant READS the global list, and a tenant may add its own
 * suppressions (an operator saying "never mail this person again") which
 * nobody else can see. Only `withPlatformScope()` writes a global row,
 * which is what the bounce webhook runs under: it has no session and no
 * tenant, because a bounce belongs to nobody.
 *
 * ⚠️ THE POLICY STILL NAMES `app_current_tenant_id()`, so this table is
 * not an exception to tenant isolation — it is a table where NULL means
 * "everyone", and `check-rls-coverage` sees exactly the predicate it
 * requires.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** 🔴 NULL = global. See the note above; this is deliberate. */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),

    /** Always the normalised form. Never the display form. */
    emailNormalized: varchar("email_normalized", { length: 320 }).notNull(),

    /** hard_bounce · complaint · invalid · manual */
    reason: varchar("reason", { length: 30 }).notNull(),
    /** What the provider actually said. Kept verbatim, truncated. */
    detail: varchar("detail", { length: 500 }),
    /** resend_webhook · dispatcher · operator */
    source: varchar("source", { length: 30 }).notNull(),
    /** Which message earned it. The thread back to the evidence. */
    providerMessageId: varchar("provider_message_id", { length: 200 }),

    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /**
     * ⚠️ RELEASE IS A ROW STATE, NOT A DELETE. "This address was
     * suppressed for four months and then somebody lifted it" is a
     * question a deliverability problem forces you to ask, and a deleted
     * row cannot answer it. The partial unique index covers only
     * unreleased rows, so an address can be suppressed again afterwards.
     */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
    releaseReason: text("release_reason"),
  },
  (t) => ({
    /**
     * ⚠️ THE REAL INDEX IS PARTIAL AND USES `NULLS NOT DISTINCT`, which
     * Drizzle cannot express — 0097 carries it. Without `NULLS NOT
     * DISTINCT` a global row could be inserted twice, because in
     * PostgreSQL two NULLs are not equal, and the second insert would
     * quietly succeed where it must be a no-op.
     */
    lookupIdx: index("email_suppressions_lookup_idx").on(t.emailNormalized, t.tenantId),
  }),
);

export type EmailOutboxRow = typeof emailOutbox.$inferSelect;
export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;
