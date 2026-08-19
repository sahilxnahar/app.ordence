/**
 * Ordence — Telemetry & Observability Schema
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SUBSYSTEM IS ALLOWED TO REMEMBER
 * ══════════════════════════════════════════════════════════════════════
 * Every other table in this platform exists to hold customer data. This
 * one exists to hold DIAGNOSTICS, and the difference is load-bearing:
 * a diagnostics table is read by engineers, exported to dashboards,
 * retained longer than anyone tracks, and is the table most likely to be
 * copied into a third-party tool. It is therefore the WORST place in the
 * system for a customer's name, a contact's email, a contract value or a
 * record id to end up.
 *
 * So the rule for this file is stated once, here, and enforced by column
 * shape rather than by discipline:
 *
 *   NO FREE-TEXT COLUMN IN THIS FILE MAY EVER RECEIVE A VALUE THAT CAME
 *   STRAIGHT FROM A USER, A RECORD, OR A URL.
 *
 * Concretely:
 *   • `routePattern` is a PATTERN — `/contacts/:id/edit`, never
 *     `/contacts/9f8e…/edit`. `scrubUrl()` in lib/telemetry/scrub.ts is
 *     the only sanctioned way to produce one, and it is unit-tested with
 *     adversarial inputs.
 *   • `message` is a TRUNCATED, scrubbed exception message. It is stored
 *     because "TypeError: cannot read x of undefined" is the entire value
 *     of error tracking — but it is passed through the same scrubber, so
 *     an interpolated email or id is stripped before it lands.
 *   • `metadata` is an ALLOW-LISTED jsonb bag (see
 *     `TELEMETRY_METADATA_KEYS`), not "whatever the caller had lying
 *     around". A deny-list would have to anticipate every future field
 *     name; an allow-list fails closed on fields nobody thought about.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `fingerprint` EXISTS AND WHY `message` IS NOT THE GROUPING KEY
 * ══════════════════════════════════════════════════════════════════════
 * Grouping errors by their message looks obvious and is how observability
 * bills explode. Messages interpolate ids, counts, timestamps and paths,
 * so "the same bug" produces a new group on every occurrence and the
 * label set is unbounded — millions of one-row groups, no signal, and a
 * cardinality bill.
 *
 * `fingerprint` is a stable 16-hex-char digest of the NORMALISED stack
 * plus the NORMALISED message (see `fingerprintError()`). Two occurrences
 * of the same bug collide by construction; two different bugs do not. It
 * is indexed, and every "top errors" query groups on it.
 *
 * The same reasoning applies to `web_vital_events.routePattern`: patterns
 * are a bounded set the size of the app's route table. Raw URLs are not
 * bounded at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY `tenantId` IS NULLABLE ON BOTH TABLES
 * ══════════════════════════════════════════════════════════════════════
 * This is the same exception `payment_events` carries, for a structurally
 * identical reason, and it is explained at length in
 * SQL-FILES/0011_phase19_telemetry.sql.
 *
 * The short version: Web Vitals fire on the sign-in page, on the marketing
 * shell, and during the first paint of a page whose session has not
 * resolved yet. A crash in the auth bootstrap itself has no tenant BY
 * DEFINITION — and that is exactly the crash you most need recorded.
 * Requiring a tenant would mean the platform stops reporting precisely
 * when it is most broken.
 *
 * The RLS policy therefore mirrors `payment_events`: a tenant session sees
 * its own rows and NEVER an orphan; the platform-scoped connection (no
 * tenant context) sees only orphans. It is not a hole — the NULL rows are
 * unreachable from any tenant session.
 *
 * ══════════════════════════════════════════════════════════════════════
 * RETENTION IS A REAL OBLIGATION AND IS NOT YET IMPLEMENTED
 * ══════════════════════════════════════════════════════════════════════
 * Both tables carry an index on `capturedAt` specifically so a retention
 * sweep is a cheap ranged DELETE rather than a full scan. The sweep
 * itself is future work and is written up in docs/PHASE-19-NOTES.md.
 * Diagnostics kept forever are diagnostics that eventually become a
 * disclosure question, even when scrubbed.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
  numeric,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * Severity. Deliberately a CLOSED set rather than free text, because the
 * alerting rules in a later phase key off it — and a severity of
 * "CRITICAL!!" typed by one caller would silently never match a rule
 * looking for "fatal".
 *
 * `fatal` means the user could not continue (an error boundary caught it,
 * a route 500'd). `error` means something broke but the page survived.
 * `warning` is a degraded path we chose to keep working — a failed
 * optional fetch. Anything below that is not worth a database row.
 */
export const telemetrySeverityEnum = pgEnum("telemetry_severity", [
  "fatal",
  "error",
  "warning",
]);

/**
 * The Web Vitals we collect. This list is closed on purpose: it is the
 * cardinality bound on the metric label. FID is deliberately absent —
 * it was retired in favour of INP in 2024 and collecting both would
 * double the rows to measure the same thing worse.
 */
export const webVitalMetricEnum = pgEnum("web_vital_metric", [
  "LCP",
  "INP",
  "CLS",
  "FCP",
  "TTFB",
]);

/**
 * The browser's own verdict, stored alongside the raw value.
 *
 * WHY BOTH: thresholds move. Google has revised the "good" boundary for
 * more than one metric. If we stored only the rating, a threshold change
 * would make historical data incomparable; if we stored only the value,
 * every dashboard would have to hardcode the boundaries and drift apart.
 * The value is the fact; the rating is the interpretation at capture time.
 */
export const webVitalRatingEnum = pgEnum("web_vital_rating", [
  "good",
  "needs-improvement",
  "poor",
]);

/**
 * Coarse device class, derived on the client from viewport width. NOT a
 * user-agent string — a UA string is a high-entropy fingerprinting vector
 * and, combined with a tenant id, is closer to identifying an individual
 * than anything else we would be storing here.
 *
 * Three buckets is enough to answer the only question this field is for:
 * "is LCP bad for everyone, or only on phones?"
 */
export const telemetryDeviceClassEnum = pgEnum("telemetry_device_class", [
  "mobile",
  "tablet",
  "desktop",
  "unknown",
]);

/**
 * Connection class, from `navigator.connection.effectiveType` where the
 * browser exposes it. Same bounded-set reasoning as above.
 */
export const telemetryConnectionEnum = pgEnum("telemetry_connection", [
  "slow-2g",
  "2g",
  "3g",
  "4g",
  "unknown",
]);

/* ------------------------------------------------------------------ */
/* ERROR EVENTS  (tenant-scoped where a tenant is known; RLS)          */
/* ------------------------------------------------------------------ */

export const errorEvents = pgTable(
  "error_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * NULL means "this error happened outside any resolved tenant" — see
     * the file header. It is NOT a soft "we didn't bother" default: the
     * ingest route resolves the tenant from the session whenever one
     * exists, and only writes NULL when there genuinely is none.
     *
     * `onDelete: "set null"` rather than cascade: when a tenant is deleted
     * their diagnostics stop being attributable, which is the correct
     * outcome, but the row itself is still evidence that a bug fired.
     * Cascading would let a tenant deletion quietly erase the record of a
     * crash we may still be investigating.
     */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),

    /**
     * Which user hit it, when we know. A uuid, never an email or a name —
     * the id is a join key we control, and it can be severed by the same
     * `set null` if the user is erased under a DPDP request.
     */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),

    /**
     * ⭐ THE GROUPING KEY. Stable 16-hex-char digest of the normalised
     * stack + message. See `fingerprintError()`. Fixed width because it
     * is generated, never user-supplied.
     */
    fingerprint: varchar("fingerprint", { length: 32 }).notNull(),

    /**
     * Scrubbed, truncated exception message. Passed through `scrubText()`
     * before it gets here, so an interpolated email or uuid is already
     * `[redacted]` / `:id` by the time it is a column value.
     */
    message: text("message").notNull(),

    /** Constructor name, e.g. "TypeError". Bounded by the JS runtime. */
    errorName: varchar("error_name", { length: 120 }),

    /**
     * Scrubbed stack, truncated hard. Stored because without frames an
     * error report is a guess — but query strings and absolute file URLs
     * inside frames are scrubbed first, since a stack frame is a
     * surprisingly effective way to smuggle a full URL (and therefore a
     * record id) into a "safe" column.
     */
    stack: text("stack"),

    severity: telemetrySeverityEnum("severity").default("error").notNull(),

    /**
     * Route PATTERN. `/contacts/:id/edit`, never a real URL.
     * See the file header — this is the cardinality bound.
     */
    routePattern: varchar("route_pattern", { length: 200 }),

    /**
     * Whether the error came from the browser or the server. Almost every
     * triage question starts here, and answering it from the stack shape
     * is guesswork.
     */
    source: varchar("source", { length: 16 }).default("server").notNull(),

    /**
     * Deploy identity, e.g. a git sha. Without it, "is this fixed?" is
     * unanswerable — you cannot tell a resolved bug from one that simply
     * has not fired since.
     */
    release: varchar("release", { length: 80 }),

    /** Which environment produced it. Mixing prod and preview hides real spikes. */
    environment: varchar("environment", { length: 24 }).default("production").notNull(),

    /**
     * When the error ACTUALLY happened, per the reporter. Distinct from
     * `capturedAt` because a beacon queued on an offline tab can be
     * delivered minutes later — treating delivery time as occurrence time
     * would smear an outage across the wrong window.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),

    /** Server receipt time. The retention sweep ranges on THIS. */
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ALLOW-LISTED diagnostic context only. The ingest route filters keys
     * against `TELEMETRY_METADATA_KEYS` and drops everything else, so a
     * client that decides to attach `{ customer: {...} }` is silently
     * ignored rather than trusted.
     */
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (t) => ({
    fingerprintIdx: index("error_events_fingerprint_idx").on(t.fingerprint, t.capturedAt),
    tenantIdx: index("error_events_tenant_idx").on(t.tenantId, t.capturedAt),
    severityIdx: index("error_events_severity_idx").on(t.severity, t.capturedAt),
    routeIdx: index("error_events_route_idx").on(t.routePattern),
    // The retention sweep's index. Without it, "delete everything older
    // than 90 days" is a sequential scan of the largest table we own.
    capturedAtIdx: index("error_events_captured_at_idx").on(t.capturedAt),

    // A fingerprint is generated by us and is always exactly 16 hex chars.
    // A row that fails this came from something other than
    // `fingerprintError()` — which means either a bug or a forged POST,
    // and either way it must not become a grouping key.
    fingerprintShape: check(
      "error_events_fingerprint_shape",
      sql`${t.fingerprint} ~ '^[0-9a-f]{16}$'`,
    ),

    // Bound the free-text columns IN THE DATABASE, not only in the Zod
    // schema. The route caps them too; this is the copy that still holds
    // if a future caller writes directly. An unbounded `text` on a public
    // ingest endpoint is a storage-exhaustion primitive.
    messageBounded: check(
      "error_events_message_bounded",
      sql`char_length(${t.message}) BETWEEN 1 AND 2000`,
    ),
    stackBounded: check(
      "error_events_stack_bounded",
      sql`${t.stack} IS NULL OR char_length(${t.stack}) <= 8000`,
    ),

    // A route PATTERN never contains a query string or a scheme. If either
    // appears, `scrubUrl()` was bypassed and a real URL — with real ids in
    // it — is being stored. Refuse the row rather than keep the PII.
    routeIsPattern: check(
      "error_events_route_is_pattern",
      sql`${t.routePattern} IS NULL
          OR (${t.routePattern} NOT LIKE '%?%'
              AND ${t.routePattern} NOT LIKE '%://%'
              AND ${t.routePattern} LIKE '/%')`,
    ),

    sourceKnown: check(
      "error_events_source_known",
      sql`${t.source} IN ('client','server','edge','worker')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* WEB VITAL EVENTS  (tenant-scoped where known; RLS)                  */
/* ------------------------------------------------------------------ */

/**
 * One row per metric per page view. This is the highest-volume table in
 * the platform by a wide margin, which is why it carries no free text at
 * all: every column is an enum, a number, a bounded pattern or a uuid.
 * There is nothing here for PII to hide in.
 */
export const webVitalEvents = pgTable(
  "web_vital_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** NULL for pre-auth page views. Same policy as `errorEvents`. */
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),

    metric: webVitalMetricEnum("metric").notNull(),

    /**
     * WHY `numeric` AND NOT `double precision`.
     * CLS is a small unitless score where 0.1 vs 0.25 decides the rating,
     * and the other four are milliseconds. Binary floats make aggregate
     * comparisons across a percentile boundary non-deterministic — the
     * same dataset can land either side of a threshold depending on
     * summation order. `numeric` is exact, and Drizzle hands it back as a
     * string, which keeps arithmetic explicit exactly as the money columns
     * do in billing.
     */
    value: numeric("value", { precision: 14, scale: 4 }).notNull(),

    rating: webVitalRatingEnum("rating").notNull(),

    /** Route PATTERN. Same cardinality bound as `errorEvents`. */
    routePattern: varchar("route_pattern", { length: 200 }).notNull(),

    /** Coarse device hints. Never a user-agent string — see the enum note. */
    deviceClass: telemetryDeviceClassEnum("device_class").default("unknown").notNull(),
    connection: telemetryConnectionEnum("connection").default("unknown").notNull(),

    /**
     * Viewport width in CSS pixels, ROUNDED TO 100px by the reporter.
     * The exact width of a browser window is a genuine fingerprinting
     * signal; the bucket answers "is this a phone?" without being one.
     */
    viewportBucket: integer("viewport_bucket"),

    /**
     * Whether the navigation was a cold load, a soft client-side route
     * change, or a bfcache restore. Comparing an SPA transition's LCP
     * against a cold start's is comparing two different things, and doing
     * so accidentally is the single most common way Web Vitals dashboards
     * end up lying.
     */
    navigationType: varchar("navigation_type", { length: 24 }),

    release: varchar("release", { length: 80 }),
    environment: varchar("environment", { length: 24 }).default("production").notNull(),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("web_vital_events_tenant_idx").on(t.tenantId, t.capturedAt),
    metricRouteIdx: index("web_vital_events_metric_route_idx").on(
      t.metric,
      t.routePattern,
      t.capturedAt,
    ),
    capturedAtIdx: index("web_vital_events_captured_at_idx").on(t.capturedAt),

    // A negative duration is a broken clock, and a CLS of 400 is a parsing
    // bug. Both poison every percentile computed from the table, and a
    // poisoned p75 is worse than a missing one because it looks fine.
    // The upper bound is 10 minutes in ms — absurd for a page load, but
    // genuinely reachable on a dying connection, so it is not narrower.
    valueSane: check(
      "web_vital_events_value_sane",
      sql`${t.value} >= 0 AND ${t.value} <= 600000`,
    ),

    viewportSane: check(
      "web_vital_events_viewport_sane",
      sql`${t.viewportBucket} IS NULL
          OR (${t.viewportBucket} >= 0 AND ${t.viewportBucket} <= 20000)`,
    ),

    routeIsPattern: check(
      "web_vital_events_route_is_pattern",
      sql`${t.routePattern} NOT LIKE '%?%'
          AND ${t.routePattern} NOT LIKE '%://%'
          AND ${t.routePattern} LIKE '/%'`,
    ),

    navigationTypeKnown: check(
      "web_vital_events_navigation_type_known",
      sql`${t.navigationType} IS NULL
          OR ${t.navigationType} IN ('navigate','reload','back-forward',
                                     'back-forward-cache','prerender','route-change')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const errorEventsRelations = relations(errorEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [errorEvents.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [errorEvents.userId], references: [users.id] }),
}));

export const webVitalEventsRelations = relations(webVitalEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [webVitalEvents.tenantId], references: [tenants.id] }),
}));

/* ------------------------------------------------------------------ */
/* INFERRED TYPES                                                      */
/* ------------------------------------------------------------------ */

export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;
export type WebVitalEvent = typeof webVitalEvents.$inferSelect;
export type NewWebVitalEvent = typeof webVitalEvents.$inferInsert;

/**
 * ══════════════════════════════════════════════════════════════════════
 * A NOTE ON `telemetry_daily` — IT IS A VIEW, AND IT IS IN THE SQL FILE
 * ══════════════════════════════════════════════════════════════════════
 * The per-tenant health rollup (error count, fatal count, distinct bugs,
 * p75 LCP/INP/CLS per day) is defined as a SQL view in
 * SQL-FILES/0011_phase19_telemetry.sql and deliberately NOT declared here.
 *
 * WHY NOT HERE: `drizzle-kit push` reconciles tables it knows about. A
 * view declared in the Drizzle schema that depends on two tables is a
 * standing risk that a push drops and recreates it in the wrong order, or
 * drops it and does not recreate it at all. Views are cheap to define in
 * SQL and free to re-run; the migration file owns it.
 *
 * WHY A VIEW AND NOT A MATERIALISED VIEW: a materialised view needs a
 * refresh job, and a stale health dashboard that looks live is worse than
 * a slow one. If the plain view stops being fast enough, that is the point
 * at which a real rollup TABLE written by the retention sweep earns its
 * complexity — noted as future work in docs/PHASE-19-NOTES.md.
 *
 * ⚠️ The view is defined with `security_invoker = true`, so it is
 * evaluated under the CALLER's RLS context rather than the view owner's.
 * A view created by the table owner WITHOUT that option bypasses RLS
 * completely, and would have been a cross-tenant read of every error in
 * the platform dressed up as a dashboard.
 */
