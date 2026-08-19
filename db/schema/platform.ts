/**
 * Ordence — Platform Console Schema (Phases 17 & 18)
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS THE ONLY SCHEMA IN THE PLATFORM THAT IS NOT TENANT-SCOPED
 * ══════════════════════════════════════════════════════════════════════
 * Every other table in this system carries a NOT NULL `tenant_id` and an
 * RLS policy that makes cross-tenant reads physically impossible. These
 * four tables exist to describe the people and the sessions that
 * deliberately cross that boundary — which means they are, collectively,
 * the highest-value target in the database.
 *
 * The shape follows from that. Two rules govern every table below:
 *
 *   1. A TENANT SESSION MUST NEVER SEE A PLATFORM ROW IT DOES NOT OWN.
 *      RLS on `platform_staff` and `platform_impersonation_sessions`
 *      admits only the platform-scoped connection (tenant context NULL),
 *      exactly like the orphan-event allowance on `payment_events`.
 *      `platform_tenant_flags` and `tenant_support_consents` are the two
 *      deliberate exceptions — a tenant may READ both, because both are
 *      statements about that tenant that the tenant is entitled to see.
 *
 *   2. EVIDENCE IS WRITE-ONCE. An impersonation record that can be edited
 *      proves nothing; it only shows what someone was later willing to
 *      say. `platform_impersonation_sessions` refuses DELETE outright and
 *      permits exactly one narrow UPDATE — closing an open session — with
 *      every other column frozen by trigger. See Section 3 of
 *      SQL-FILES/0014_phase17_platform.sql.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `platform_staff` EXISTS AT ALL, GIVEN `platform_super_admin`
 * ══════════════════════════════════════════════════════════════════════
 * `system_role` already contains `platform_super_admin`, and `lib/env.ts`
 * already carries `PLATFORM_ADMIN_EMAILS`. Neither is sufficient and this
 * table is the third leg, not a replacement. The full argument lives in
 * `lib/platform/roles.ts`; in one paragraph:
 *
 *   • `users.role = 'platform_super_admin'` is a row in a TENANT-SCOPED
 *     table, written by tenant-facing code paths. It legitimately means
 *     "our staff member sits inside this customer's workspace and does
 *     not consume a seat they paid for" (`lib/billing/seats.ts`). It is
 *     NOT, and must not become, the key to the cross-tenant console —
 *     that would make console access a property of a row inside a
 *     customer's own tenant.
 *
 *   • `PLATFORM_ADMIN_EMAILS` is a deploy-time allowlist. It cannot be
 *     revoked at 03:00 without a deploy, it cannot express an expiry or a
 *     capability level, and it keys on an email address, which is a
 *     label, not an identity.
 *
 *   • This table is revocable in one statement, expires, carries a grade,
 *     and records who granted it. But on its own it is a database row,
 *     and a database row is exactly what an attacker who reached the
 *     database can write.
 *
 * So the gate requires the ENV ALLOWLIST **and** AN ACTIVE ROW HERE.
 * Promotion needs a reviewed config deploy AND a grant made by existing
 * staff; neither key alone opens the door, and a tenant administrator
 * holds neither.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  inet,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a member of platform staff is allowed to do.
 *
 * Deliberately three grades and not one boolean. "Platform staff" is not
 * a single job: the person who answers a ticket at 09:00 and the person
 * who suspends a tenant for abuse are different people with different
 * blast radii, and collapsing them means the support rota holds the
 * ability to lock a customer out of their own workspace.
 *
 *   support   — read tenant metadata, run the directory search, start a
 *               CONSENTED impersonation. Cannot suspend, cannot
 *               break-glass, cannot grant staff.
 *   engineer  — the above, plus break-glass impersonation (read-only),
 *               plus feature flags.
 *   owner     — the above, plus suspend/reactivate and staff grants.
 *
 * The capability matrix is code, not data — see `lib/platform/roles.ts`.
 * A grade column plus a matrix in a frozen constant is auditable in a
 * diff; a per-person permission JSONB is not.
 */
export const platformGradeEnum = pgEnum("platform_grade", [
  "support",
  "engineer",
  "owner",
]);

export const platformStaffStatusEnum = pgEnum("platform_staff_status", [
  "active",
  "suspended",
  "revoked",
]);

/**
 * How an impersonation session came to be authorised.
 *
 * `break_glass` is not a failure mode, it is a named, narrower mode. The
 * argument for admitting it at all — and for making it READ-ONLY — is in
 * `lib/platform/impersonation-policy.ts`.
 */
export const impersonationModeEnum = pgEnum("impersonation_mode", [
  "standing_consent",
  "incident_consent",
  "break_glass",
]);

/** What the operator may do inside the session. */
export const impersonationScopeEnum = pgEnum("impersonation_scope", [
  "read_only",
  "read_write",
]);

/**
 * Why a session stopped.
 *
 * `expired` is written by whoever notices first (the next request, the
 * sweeper). It is NOT the authority on whether a session is live —
 * `expires_at` is, and it is checked on every use. A session whose
 * `ended_at` is still NULL an hour after `expires_at` is over is CLOSED;
 * the row simply has not been tidied. Treating the row as authoritative
 * would mean a failed sweeper silently extends every session in the
 * system.
 */
export const impersonationEndReasonEnum = pgEnum("impersonation_end_reason", [
  "operator_ended",
  "expired",
  "revoked_by_tenant",
  "revoked_by_platform",
  "session_binding_failed",
]);

/** How a tenant's consent to support access was obtained. */
export const supportConsentModeEnum = pgEnum("support_consent_mode", [
  "standing",
  "incident",
]);

/* ------------------------------------------------------------------ */
/* PLATFORM STAFF — the revocable half of the two-key model            */
/* ------------------------------------------------------------------ */

export const platformStaff = pgTable(
  "platform_staff",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * The Clerk user id — the actual identity, and the join key.
     *
     * ⚠️ NOT the email. An email address is a label that can be changed,
     * re-verified onto a different account, or recycled by a mail
     * provider after an employee leaves. `email` below is denormalised
     * for display and for the env-allowlist comparison; it is never the
     * primary matcher on its own.
     */
    clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull(),

    /** Denormalised for the console list and for allowlist matching. */
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 200 }),

    grade: platformGradeEnum("grade").default("support").notNull(),
    status: platformStaffStatusEnum("status").default("active").notNull(),

    /**
     * Standing access with no end date is how a contractor from 2023 is
     * still able to read every customer's billing record in 2026.
     * Nullable because a founder's grant legitimately has no expiry, but
     * the console warns on any row where this is NULL.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * Last time this operator proved a second factor.
     *
     * Read by `requireStepUp()` before any dangerous operation. See the
     * honest caveat in `server/platform/guard.ts`: without the Clerk
     * `fva` session claim this is a record of an assertion, not a
     * verification, and that gap is listed in the phase notes.
     */
    lastStepUpAt: timestamp("last_step_up_at", { withTimezone: true }),

    grantedBy: uuid("granted_by"),
    grantedByEmail: varchar("granted_by_email", { length: 320 }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    /** Mandatory written reason for the grant — a name and a ticket. */
    grantReason: text("grant_reason"),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    clerkUnique: uniqueIndex("platform_staff_clerk_unique").on(t.clerkUserId),
    emailIdx: index("platform_staff_email_idx").on(t.email),
    statusIdx: index("platform_staff_status_idx").on(t.status),
  }),
);

/* ------------------------------------------------------------------ */
/* IMPERSONATION SESSIONS — append-only evidence                       */
/* ------------------------------------------------------------------ */

/**
 * One row per impersonation. The row IS the evidence.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT FULLY IMMUTABLE, AND WHY THAT IS NOT A COMPROMISE
 * ══════════════════════════════════════════════════════════════════════
 * A strictly INSERT-only table cannot record that a session ended, so the
 * usual answer would be a second `impersonation_events` table folded at
 * read time. That was rejected for the same reason Phase 20 rejected
 * `security_anomalies`: the question a reviewer actually asks is "was
 * anyone inside Acme's workspace on the 14th, and for how long", and
 * making that a join across two tables is how the answer stops being
 * checked.
 *
 * Instead this follows the precedent set by issued invoices in Phase 11
 * (Section 4 of 0009): the row is frozen EXCEPT for a one-way close.
 * A trigger permits an UPDATE only when
 *
 *     • `ended_at` was NULL and is being set, and
 *     • every other column is byte-identical to what it was.
 *
 * So `expires_at` cannot be extended, `justification` cannot be rewritten
 * after the fact, `tenant_id` cannot be moved, a closed session cannot be
 * reopened, and DELETE is refused outright. The three facts that matter —
 * who, which tenant, under what authority, until when — are write-once.
 *
 * ⚠️ `ended_at` is a convenience, NOT the authority on liveness.
 * `expires_at` is. A session is live iff `now() < expires_at AND ended_at
 * IS NULL`. If the closing UPDATE were ever the thing that ended a
 * session, a failed write would leave the operator inside the customer's
 * workspace indefinitely.
 */
export const platformImpersonationSessions = pgTable(
  "platform_impersonation_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * `restrict`, not `cascade`. Deleting a tenant must not silently
     * erase the record that we were inside their workspace — that is the
     * one deletion an operator under investigation would most like to
     * perform, and it would look like ordinary housekeeping.
     */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    /** Denormalised so the evidence survives a tenant rename. */
    tenantSlug: varchar("tenant_slug", { length: 63 }).notNull(),

    staffId: uuid("staff_id")
      .notNull()
      .references(() => platformStaff.id, { onDelete: "restrict" }),

    /**
     * THE REAL HUMAN. Duplicated from `platform_staff` on purpose: this
     * is the column an auditor reads, and it must not depend on a join to
     * a row that could later be revoked, renamed or re-granted to
     * somebody else.
     */
    actorClerkId: varchar("actor_clerk_id", { length: 255 }).notNull(),
    actorEmail: varchar("actor_email", { length: 320 }).notNull(),

    mode: impersonationModeEnum("mode").notNull(),
    scope: impersonationScopeEnum("scope").notNull(),

    /** The consent this session leans on. NULL only for break-glass. */
    consentId: uuid("consent_id"),

    /**
     * Free text, minimum length enforced in Zod and by a CHECK in SQL.
     * "debug" is not a justification. A ticket reference and a sentence
     * is, and the difference shows up six months later when somebody has
     * to explain the access to the customer.
     */
    justification: text("justification").notNull(),

    /** Optional: the tenant user whose view is being reproduced. */
    subjectUserId: uuid("subject_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * THE HARD STOP. Enforced on every single use, not by a timer.
     * A background job that fails to run must not be able to extend
     * anybody's access, so nothing anywhere trusts a sweeper.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: impersonationEndReasonEnum("ended_reason"),

    /**
     * Session binding. A stolen console cookie replayed from another
     * network is the scenario this exists for: the recorded IP and
     * user-agent are re-checked on every use and a mismatch terminates
     * the session rather than merely logging it.
     */
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),

    /** Was the tenant told? Recorded, because "we notified them" is a claim. */
    tenantNotifiedAt: timestamp("tenant_notified_at", { withTimezone: true }),

    /** Cheap forensics: how much happened inside the window. */
    actionCount: integer("action_count").default(0).notNull(),
    blockedActionCount: integer("blocked_action_count").default(0).notNull(),

    /**
     * ⭐ BREAK-GLASS ONLY, AND A CHECK CONSTRAINT MAKES IT MANDATORY
     * THERE. This is the sentence the workspace owners read in the email
     * telling them their data was opened without their permission, so it
     * is written for them rather than for the log.
     */
    breakGlassReason: text("break_glass_reason"),

    /**
     * 🔴 THE DEBT. Until this is written the same operator cannot start
     * another break-glass session. See `lib/platform/break-glass.ts` —
     * this column is the only control in the whole path that costs
     * anything on the day AFTER the decision, which is why it is the one
     * that changes behaviour.
     */
    postIncidentNote: text("post_incident_note"),
    postIncidentAt: timestamp("post_incident_at", { withTimezone: true }),
    /** Not always the operator who went in. Somebody has to close it out. */
    postIncidentBy: uuid("post_incident_by").references(() => platformStaff.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantStartedIdx: index("impersonation_tenant_started_idx").on(t.tenantId, t.startedAt),
    actorIdx: index("impersonation_actor_idx").on(t.actorClerkId),
    // Drives "is anything live right now" without a table scan.
    liveIdx: index("impersonation_live_idx").on(t.expiresAt, t.endedAt),
  }),
);

/* ------------------------------------------------------------------ */
/* TENANT SUPPORT CONSENT                                              */
/* ------------------------------------------------------------------ */

/**
 * The customer's own record of having said yes.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A TABLE AND NOT A BOOLEAN IN `tenants.settings`
 * ══════════════════════════════════════════════════════════════════════
 * A boolean answers "may we?" and nothing else. When a customer asks —
 * and they do ask, usually during a security review — the questions are
 * "who in our organisation agreed to this, when, from where, and what
 * exactly did they agree to?". A JSONB flag cannot answer any of them,
 * and it can be flipped by any code path that writes `settings`, which is
 * several.
 *
 * Rows here are also the thing an impersonation session POINTS AT. A
 * session that claims consent and references a revoked or expired
 * consent row is a detectable inconsistency; a session that claims
 * consent because a boolean was true at the time is not.
 */
export const tenantSupportConsents = pgTable(
  "tenant_support_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    mode: supportConsentModeEnum("mode").notNull(),

    /**
     * What was agreed to. `read_only` consent means support may look and
     * may not touch — the honest default for a customer who just wants a
     * bug diagnosed.
     */
    scope: impersonationScopeEnum("scope").default("read_only").notNull(),

    /**
     * ⚠️ Granted by a TENANT user, never by platform staff. Enforced in
     * `server/platform/impersonation.ts` and by the RLS write policy: the
     * platform-scoped connection may READ this table and may not INSERT
     * into it. Consent that we can write ourselves is not consent.
     */
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedByEmail: varchar("granted_by_email", { length: 320 }),
    grantedByRole: varchar("granted_by_role", { length: 60 }),

    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Consent expires. Always. A standing grant defaults to 90 days and
     * the customer is re-asked — because "we agreed to that in 2024" is
     * not a defence anybody wants to make.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id"),

    /** For incident consent: the ticket or incident it belongs to. */
    reference: varchar("reference", { length: 200 }),
    note: text("note"),

    /** Evidence of the act of consenting. */
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("support_consents_tenant_idx").on(t.tenantId, t.grantedAt),
    liveIdx: index("support_consents_live_idx").on(t.tenantId, t.expiresAt),
  }),
);

/* ------------------------------------------------------------------ */
/* TENANT FEATURE FLAGS                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-tenant overrides on top of the plan matrix.
 *
 * ══════════════════════════════════════════════════════════════════════
 * FLAGS ARE NOT ENTITLEMENTS, AND THIS TABLE MUST NOT BECOME PRICING
 * ══════════════════════════════════════════════════════════════════════
 * `lib/entitlements/features.ts` answers "has this workspace PAID for
 * this?". This table answers "is this capability SWITCHED ON for this
 * workspace right now?" — a beta opt-in, a kill switch for a customer
 * hitting a bug, an early-access grant while a contract is being signed.
 *
 * The two must not merge. If a flag can grant a paid feature permanently
 * and silently, then the revenue model lives in a table with no invoice
 * attached to it, and the first time anybody notices is at renewal. So
 * every row carries an `expires_at` and a written `reason`, and the
 * console shows both.
 *
 * A tenant may READ its own flags — the app has to, in order to render —
 * and may never write them. That asymmetry is expressed directly in the
 * RLS policy: `USING` admits the owning tenant, `WITH CHECK` admits only
 * the platform-scoped connection.
 */
export const platformTenantFlags = pgTable(
  "platform_tenant_flags",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Stable identifier from `lib/platform/flags-catalog`. */
    flagKey: varchar("flag_key", { length: 120 }).notNull(),

    enabled: boolean("enabled").default(false).notNull(),

    /** Optional payload for non-boolean flags (limits, variants). */
    value: jsonb("value")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** Mandatory. "why is this on for this one customer" has to be answerable. */
    reason: text("reason").notNull(),

    /** Nullable, but the console nags: a flag with no end date is a fork. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    setByStaffId: uuid("set_by_staff_id").references(() => platformStaff.id, {
      onDelete: "set null",
    }),
    setByEmail: varchar("set_by_email", { length: 320 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantFlagUnique: uniqueIndex("platform_tenant_flags_unique").on(t.tenantId, t.flagKey),
    tenantIdx: index("platform_tenant_flags_tenant_idx").on(t.tenantId),
  }),
);

/* ------------------------------------------------------------------ */
/* PLATFORM ACTION LOG — the tenant-less half of the audit trail        */
/* ------------------------------------------------------------------ */

/**
 * Actions by platform staff that belong to NO SINGLE TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SPLIT RULE, AND WHY IT IS NOT A DESIGN PREFERENCE
 * ══════════════════════════════════════════════════════════════════════
 * The house rule from Phase 5 is emphatic: an audit trail split across
 * two tables cannot prove anything, because a reader has to trust both
 * are complete. This phase honours that everywhere it can — suspension,
 * impersonation start and stop, tenant detail reads and flag changes ALL
 * go into `audit_logs` with the tenant's id, so they appear in the
 * CUSTOMER'S OWN audit view. Nothing about a specific tenant lives here.
 *
 * What lives here is the residue: a directory search that spans every
 * tenant and belongs to none, a staff grant, a capability denial.
 *
 * That residue cannot go into `audit_logs`, and the reason is a fact
 * about the existing policy rather than an opinion. From Phase 1:
 *
 *     CREATE POLICY audit_logs_tenant_isolation ON audit_logs
 *       USING      (tenant_id = app_current_tenant_id())
 *       WITH CHECK (tenant_id = app_current_tenant_id());
 *
 * With no tenant context both sides evaluate `NULL = NULL` → NULL →
 * not true. Verified against PostgreSQL 16 as `ordence_app`:
 *
 *     INSERT INTO audit_logs (tenant_id, ...) VALUES (NULL, ...)
 *     →  ERROR: new row violates row-level security policy
 *
 * So a NULL-tenant audit row is not merely discouraged, it is IMPOSSIBLE
 * for the application role. (`payment_events` and `security_events` both
 * carry an explicit `OR (tenant_id IS NULL AND app_current_tenant_id()
 * IS NULL)` allowance for exactly this; `audit_logs` deliberately does
 * not, and this phase does not own that policy.)
 *
 * THE RULE IS THEREFORE MECHANICAL, WHICH IS WHY IT WILL NOT DRIFT:
 *
 *     has a tenant it belongs to  →  audit_logs   (customer can see it)
 *     belongs to no tenant        →  here         (platform only)
 *
 * Nothing is written to both. The alternative — widening the `audit_logs`
 * policy to admit NULL rows — is written out in full in the INTEGRATION
 * REQUIRED section of docs/PHASE-17-18-NOTES.md for whoever owns that
 * file to accept or reject.
 *
 * Append-only, same trigger treatment as `audit_logs` itself. This is the
 * table that records "an operator searched every workspace for an email
 * address"; a DELETE privilege on it would be an "erase the record of
 * what I looked at" privilege.
 */
export const platformActionLog = pgTable(
  "platform_action_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** The real human. Never a service account, never a shared login. */
    actorClerkId: varchar("actor_clerk_id", { length: 255 }).notNull(),
    actorEmail: varchar("actor_email", { length: 320 }).notNull(),
    actorGrade: platformGradeEnum("actor_grade").notNull(),

    /** e.g. "search", "staff_grant", "capability_denied". */
    action: varchar("action", { length: 60 }).notNull(),
    resourceType: varchar("resource_type", { length: 100 }).notNull(),
    resourceId: varchar("resource_id", { length: 255 }),

    /**
     * Mandatory written reason. `withPlatformScope()` already refuses
     * anything under ten characters; this column is where that sentence
     * ends up, and it is the entire value of the row six months later.
     */
    justification: text("justification").notNull(),

    /**
     * ⚠️ MUST NOT CONTAIN A RAW SEARCH TERM OR ANY CUSTOMER CONTENT.
     * Search terms are masked by `maskSearchTerm()` before they reach
     * here — logging "priya@acme.com" across thousands of rows would
     * build a second, unbounded copy of customer identities inside a
     * table retained for years.
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** How many rows the operator actually saw. Bounded by MAX_RESULTS. */
    resultCount: integer("result_count"),

    severity: varchar("severity", { length: 20 }).default("notice").notNull(),

    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    requestId: varchar("request_id", { length: 255 }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /* ---------------------------------------------------------------- */
    /* THE HASH CHAIN — SQL-FILES/0081_audit_hash_chain.sql (Batch 44)   */
    /* ---------------------------------------------------------------- */
    /**
     * 🔴 THESE COLUMNS EXIST AND ARE NOT YET WRITTEN. Said out loud
     * because a silently-empty integrity column is worse than an absent
     * one: a reader assumes it is populated.
     *
     * `recordPlatformAudit()` lives in `server/platform/guard.ts`, which
     * Batch 44 does not own, so every `platform_action_log` row is still
     * written UNCHAINED. `VERIFY-0081-neon-safe.sql` reports that as
     * "0 of N chained — writer not wired" rather than as a broken chain,
     * and wiring it is the same three lines `server/audit.ts` uses.
     *
     * ⚠️ THEY ARE DECLARED HERE ANYWAY so the Drizzle schema matches the
     * database. A column that exists in Postgres and not in the schema is
     * a column `drizzle-kit` will happily generate a DROP for.
     *
     * ⭐ THIS TABLE IS ONE CHAIN, not one per tenant, because it has no
     * `tenant_id` — the rows that belong to a workspace go to
     * `audit_logs` by the Phase 17 rule. Its scope key is the literal
     * `platform`; see constraint 2 in `lib/audit/chain.ts`.
     */
    chainSeq: bigint("chain_seq", { mode: "number" }),
    prevHash: text("prev_hash"),
    contentHash: text("content_hash"),
    rowHash: text("row_hash"),
  },
  (t) => ({
    actorCreatedIdx: index("platform_action_log_actor_idx").on(t.actorClerkId, t.createdAt),
    actionIdx: index("platform_action_log_action_idx").on(t.action, t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const platformStaffRelations = relations(platformStaff, ({ many }) => ({
  impersonationSessions: many(platformImpersonationSessions),
}));

export const platformImpersonationSessionsRelations = relations(
  platformImpersonationSessions,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [platformImpersonationSessions.tenantId],
      references: [tenants.id],
    }),
    staff: one(platformStaff, {
      fields: [platformImpersonationSessions.staffId],
      references: [platformStaff.id],
    }),
  }),
);

export const tenantSupportConsentsRelations = relations(tenantSupportConsents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tenantSupportConsents.tenantId],
    references: [tenants.id],
  }),
}));

export const platformTenantFlagsRelations = relations(platformTenantFlags, ({ one }) => ({
  tenant: one(tenants, {
    fields: [platformTenantFlags.tenantId],
    references: [tenants.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type PlatformStaff = typeof platformStaff.$inferSelect;
export type NewPlatformStaff = typeof platformStaff.$inferInsert;
export type ImpersonationSession = typeof platformImpersonationSessions.$inferSelect;
export type NewImpersonationSession = typeof platformImpersonationSessions.$inferInsert;
export type TenantSupportConsent = typeof tenantSupportConsents.$inferSelect;
export type NewTenantSupportConsent = typeof tenantSupportConsents.$inferInsert;
export type PlatformTenantFlag = typeof platformTenantFlags.$inferSelect;
export type NewPlatformTenantFlag = typeof platformTenantFlags.$inferInsert;
export type PlatformActionLogRow = typeof platformActionLog.$inferSelect;
export type NewPlatformActionLogRow = typeof platformActionLog.$inferInsert;

export type PlatformGrade = (typeof platformGradeEnum.enumValues)[number];
export type PlatformStaffStatus = (typeof platformStaffStatusEnum.enumValues)[number];
export type ImpersonationMode = (typeof impersonationModeEnum.enumValues)[number];
export type ImpersonationScope = (typeof impersonationScopeEnum.enumValues)[number];
export type ImpersonationEndReason = (typeof impersonationEndReasonEnum.enumValues)[number];
export type SupportConsentMode = (typeof supportConsentModeEnum.enumValues)[number];
