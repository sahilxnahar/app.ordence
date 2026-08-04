/**
 * Ordence — SecOps Schema (Phase 20)
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE TABLE. THE ARGUMENT FOR THAT IS THE POINT OF THIS HEADER.
 * ══════════════════════════════════════════════════════════════════════
 * Phase 20 adds `security_events` and nothing else. The obvious second and
 * third tables were both considered and both rejected:
 *
 *   `rate_limit_counters` — NO. The counters live in Redis, which is where a
 *     counter incremented on every request belongs. Writing them to Postgres
 *     would put a synchronous INSERT in front of every guarded route and make
 *     the rate limiter — the thing installed to survive a flood — the first
 *     component to fall over during one. Only the TRIP is recorded here, and
 *     a trip is rare by construction.
 *
 *   `security_anomalies` — NO. An anomaly detection is a security event; it
 *     is emitted as `anomaly.detected` into the same stream. Splitting it out
 *     would mean a SIEM has to union two tables to see one timeline, and the
 *     correlation rules that matter ("a denial spike AND a rate-limit trip
 *     from the same IP within five minutes") are exactly the ones that get
 *     harder when the timeline is split. Detector output carries its rule id
 *     and window in `detail`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE BOUNDARY WITH `audit_logs` AND `permission_denials`
 * ══════════════════════════════════════════════════════════════════════
 * Stated in full in `lib/security/events.ts`. In one line: `audit_logs`
 * records what a principal DID, `permission_denials` records what a known
 * principal was REFUSED, and this table records things that are NOT user
 * actions — a limiter trip, a forged signature, an inferred pattern. Nothing
 * is written to two of the three.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `tenant_id` IS NULLABLE HERE
 * ══════════════════════════════════════════════════════════════════════
 * This is the second table in the platform to break the NOT NULL rule, after
 * `payment_events`, and for a closely related reason — but the case is
 * actually stronger.
 *
 * The events most worth having arrive where no tenant is known:
 *
 *   • A webhook whose HMAC failed. We never got far enough to map it to a
 *     tenant, and we must not parse an unverified payload to try.
 *   • A portal token that does not exist. There is nothing to resolve.
 *   • A sign-in attempt for an email address that has no account.
 *   • A rate-limit trip in middleware, before any session is loaded.
 *
 * Refusing to store those would mean the table contains only the attacks that
 * got past authentication — that is, it would be blind to precisely the
 * perimeter it exists to watch. Inventing a placeholder tenant would be worse
 * still: a real tenant id that means "we don't know" corrupts every per-tenant
 * count in the table.
 *
 * THE NULL POLICY, enforced by RLS in `SQL-FILES/0012_phase20_secops.sql` and
 * identical in shape to `payment_events`:
 *
 *   tenant session (context = A)  → sees rows where tenant_id = A
 *   platform scope (context NULL) → sees rows where tenant_id IS NULL
 *
 * A tenant never sees another tenant's events and never sees the unattributed
 * ones. The unattributed ones are readable only by platform tooling, which is
 * correct — they are perimeter telemetry about our infrastructure, not about
 * any customer's data.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY APPEND-ONLY
 * ══════════════════════════════════════════════════════════════════════
 * The same argument as `audit_logs` and `payment_events`, with one addition
 * specific to this table: an attacker who reaches the database is the person
 * with the strongest possible motive to edit it. An audit trail is usually
 * tampered with to hide a business action; this stream is tampered with to
 * hide the intrusion itself. A DELETE privilege on `security_events` is,
 * functionally, an "erase the evidence of how I got in" privilege.
 *
 * UPDATE and DELETE are refused by a trigger raising SQLSTATE 42501, and the
 * application role is not granted them either — belt and braces, because a
 * trigger that gets dropped by `drizzle-kit push` is a silent failure.
 *
 * Retention is therefore handled by PARTITION-STYLE PRUNING run by a
 * privileged maintenance role, not by the app. That is deliberate friction:
 * deleting security history should require a different credential from the
 * one the web application holds.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { SECURITY_EVENT_TYPES, SECURITY_SEVERITIES } from "@/lib/security/events";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE ENUM VALUES ARE IMPORTED, NOT RETYPED.
 *
 * A hand-copied list in the schema would drift from the TypeScript union the
 * first time someone adds a member to one and not the other — and the
 * symptom is an INSERT that fails at runtime, in the code path that reports
 * an attack, which is the worst place in the system to discover a typo.
 * Deriving the Postgres enum from the same constant makes drift impossible.
 */
export const securityEventTypeEnum = pgEnum("security_event_type", SECURITY_EVENT_TYPES);

export const securitySeverityEnum = pgEnum("security_severity", SECURITY_SEVERITIES);

/* ------------------------------------------------------------------ */
/* SECURITY EVENTS                                                     */
/* ------------------------------------------------------------------ */

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * NULL means "no tenant could be attributed", never "all tenants".
     * See the header. The RLS policy in 0012 depends on this reading.
     *
     * `onDelete: "cascade"` is WRONG here and is deliberately not used:
     * deleting a tenant must not silently erase the record of attacks
     * mounted against it or from it. `set null` demotes the row to
     * platform-scoped and keeps it.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),

    eventType: securityEventTypeEnum("event_type").notNull(),
    severity: securitySeverityEnum("severity").default("info").notNull(),

    /** Emitting surface: "middleware", "api/webhooks/razorpay", "portal". */
    source: varchar("source", { length: 120 }).notNull(),

    /**
     * What the event concerns. NEVER a live credential — the recorder
     * enforces this, but read `lib/security/events.ts` before storing
     * anything token-shaped here. This column is exported to a SIEM.
     */
    subjectType: varchar("subject_type", { length: 60 }),
    subjectId: varchar("subject_id", { length: 255 }),

    /**
     * Populated ONLY when the actor was genuinely authenticated. A null here
     * is meaningful: it says the event happened outside any session, which is
     * true of most of the interesting ones.
     */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),

    /* --- Forensics ------------------------------------------------- */
    ipAddress: varchar("ip_address", { length: 45 }),
    /**
     * The /24 or /64 the address belongs to, precomputed.
     *
     * Not derivable in SQL cheaply and it is what every useful query groups
     * by — "one source, many portal tokens" is a query on the PREFIX, because
     * an attacker rotating through their own /64 looks like 18 quintillion
     * distinct addresses and one network.
     */
    ipPrefix: varchar("ip_prefix", { length: 60 }),
    userAgent: text("user_agent"),
    requestId: varchar("request_id", { length: 255 }),
    route: varchar("route", { length: 255 }),
    country: varchar("country", { length: 2 }),

    /** Which named rate-limit policy tripped, when applicable. */
    ratePolicy: varchar("rate_policy", { length: 30 }),

    /**
     * How many underlying occurrences this row represents.
     *
     * The recorder coalesces bursts (see `server/security/record.ts`): one row
     * saying "412 occurrences" is legible, 412 rows are a denial-of-service
     * against our own database mounted by our own logging.
     */
    occurrenceCount: integer("occurrence_count").default(1).notNull(),

    /** Redacted circumstance. Written through `sanitiseDetail()`, always. */
    detail: jsonb("detail")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    /** One sentence for an alert body. No secrets, no stack traces. */
    reason: text("reason"),

    /**
     * When it happened, which is not always when we recorded it — a detector
     * runs over a window and reports about the past.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Set once the row has been shipped to an external SIEM.
     *
     * ⚠️ This is the ONE column that would justify an UPDATE, and it is
     * deliberately NOT updated by the application: the append-only trigger
     * has no exception for it. Export progress is tracked by high-water mark
     * on `created_at` in the exporter instead. Carving a hole in an
     * append-only guard "just for one harmless column" is how such guards
     * stop being guards — the hole is a general UPDATE path that a later
     * change reuses.
     */
    exportedAt: timestamp("exported_at", { withTimezone: true }),
  },
  (t) => ({
    // The console's primary view: this tenant, newest first.
    tenantCreatedIdx: index("security_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    // Alerting: "any critical row in the last hour", across all tenants.
    severityIdx: index("security_events_severity_idx").on(t.severity, t.createdAt),
    typeIdx: index("security_events_type_idx").on(t.eventType, t.createdAt),
    // The anomaly detectors' access pattern — see server/security/anomalies.ts.
    prefixIdx: index("security_events_ip_prefix_idx").on(t.ipPrefix, t.createdAt),
    subjectIdx: index("security_events_subject_idx").on(t.subjectType, t.subjectId),
    // The SIEM exporter walks this in order, so it must be indexed on its own
    // and not only as the second column of a composite.
    createdIdx: index("security_events_created_idx").on(t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const securityEventsRelations = relations(securityEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [securityEvents.tenantId], references: [tenants.id] }),
  actor: one(users, { fields: [securityEvents.actorUserId], references: [users.id] }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type SecurityEventRow = typeof securityEvents.$inferSelect;
export type NewSecurityEventRow = typeof securityEvents.$inferInsert;
