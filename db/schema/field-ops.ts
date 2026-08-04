/**
 * Ordence — ⭐ ENGINE 3 · FIELD & MOBILE OPERATIONS
 * Version: v0.65.0-alpha  ·  Session 1
 *
 * ══════════════════════════════════════════════════════════════════════
 * SIX VERTICALS SEND SOMEBODY SOMEWHERE AND NEED TO PROVE THEY WENT
 * ══════════════════════════════════════════════════════════════════════
 * A solar installer commissioning a rooftop. A logistics driver making
 * a delivery. A hospital's home-care nurse. An AMC technician on a
 * breakdown call. A meter reader walking a round. A site engineer
 * recording a pour.
 *
 * The domain language differs completely and the shape does not: somebody
 * goes to a place, inside a window, does a stated thing, consumes some
 * parts, and leaves behind evidence that it happened.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DECISION THAT DEFINES THIS ENGINE: THE PHONE IS OFFLINE
 * ══════════════════════════════════════════════════════════════════════
 * Not "might occasionally be". A basement plant room, a lift, a rooftop
 * behind a parapet, a village on the edge of coverage, a driver in a
 * tunnel. Offline is the NORMAL case, and every design choice below
 * follows from taking that literally.
 *
 * ⚠️ SO THE DEVICE SUPPLIES THE IDEMPOTENCY KEY, NOT THE SERVER.
 *
 * A phone that submits a check-in, loses signal before the response, and
 * retries on reconnect has sent the same event twice. A server-generated
 * id cannot tell the two apart — they are two POSTs — so the technician
 * gets two visits, the job shows two hours of labour, and the customer is
 * billed twice. `client_event_id` is generated ON THE DEVICE before the
 * first attempt and is unique per tenant, so the retry collides with
 * itself and is absorbed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND GPS IS EVIDENCE, NOT A GATE
 * ══════════════════════════════════════════════════════════════════════
 * The instinct is to refuse a check-in more than N metres from the site.
 * It is wrong, and it fails in the direction that destroys the record.
 *
 * GPS in a basement plant room is wrong by hundreds of metres. Indoors it
 * drifts. On a cheap handset it lies. Refusing the check-in does not stop
 * the technician working — the customer is standing there — it stops the
 * work being RECORDED. What you get is a system every field team learns
 * to work around, and a job history that is missing precisely the hard
 * jobs.
 *
 * So the distance is computed, stored, and surfaced to a supervisor. A
 * check-in 4 km from site is a conversation, not a rejection.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { contacts, companies } from "./crm";

/* ------------------------------------------------------------------ */
/* ENUMS                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE TERMINAL STATES ARE THREE, NOT ONE.
 *
 * `completed`, `could_not_complete` and `cancelled` are genuinely
 * different outcomes and collapsing them loses the only number that
 * matters operationally. A team with a 92% completion rate and a team
 * with 92% "closed" jobs are not the same team — the second may be
 * driving to sites and finding nobody home half the time, which is a
 * scheduling problem invisible to anyone looking at a single closed flag.
 */
export const fieldJobStatusEnum = pgEnum("field_job_status", [
  "draft",
  "scheduled",
  "dispatched",
  "travelling",
  "on_site",
  "paused",
  "completed",
  "could_not_complete",
  "cancelled",
]);

export const fieldJobPriorityEnum = pgEnum("field_job_priority", [
  "routine",
  "standard",
  "urgent",
  "emergency",
]);

/**
 * What a visit left behind.
 *
 * ⚠️ `otp` IS HERE BECAUSE A SIGNATURE ON A PHONE PROVES ALMOST NOTHING.
 * Anybody can draw a squiggle. A one-time code sent to the customer's own
 * registered number and typed in by them is the only cheap proof that the
 * person who accepted the work was the person entitled to accept it —
 * which is what a disputed delivery or a disputed AMC visit turns on.
 */
export const fieldProofKindEnum = pgEnum("field_proof_kind", [
  "photo_before",
  "photo_after",
  "signature",
  "otp",
  "barcode_scan",
  "document",
  "reading",
  "note",
]);

/** Why a job could not be completed. Stated, not free text. */
export const fieldFailureReasonEnum = pgEnum("field_failure_reason", [
  "customer_absent",
  "access_denied",
  "site_not_ready",
  "part_unavailable",
  "wrong_address",
  "unsafe_conditions",
  "weather",
  "vehicle_breakdown",
  "customer_refused",
  "other",
]);

/* ------------------------------------------------------------------ */
/* 1 · JOBS                                                            */
/* ------------------------------------------------------------------ */

export const fieldJobs = pgTable(
  "field_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    jobNumber: varchar("job_number", { length: 60 }).notNull(),
    title: varchar("title", { length: 250 }).notNull(),
    description: text("description"),

    /** Installation, breakdown, delivery, meter read, inspection… */
    jobKind: varchar("job_kind", { length: 60 }).notNull(),

    status: fieldJobStatusEnum("status").default("draft").notNull(),
    priority: fieldJobPriorityEnum("priority").default("standard").notNull(),

    /* ---- Who it is for ------------------------------------------- */
    customerCompanyId: uuid("customer_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    customerContactId: uuid("customer_contact_id").references(
      () => contacts.id,
      { onDelete: "set null" },
    ),

    /* ---- Where ---------------------------------------------------- */
    siteAddress: text("site_address"),
    siteLandmark: varchar("site_landmark", { length: 250 }),

    /**
     * ⚠️ PLAIN numeric, NOT PostGIS.
     *
     * PostGIS is the right answer for routing, catchment analysis and
     * anything involving polygons. It is a heavy extension that Neon must
     * enable, that complicates every restore, and that this engine does
     * not need: the only spatial question here is "how far was the
     * technician from the site", which is one great-circle formula over
     * two points. Adding a dependency for a question answered by
     * arithmetic is a cost with no matching benefit.
     */
    siteLatitude: numeric("site_latitude", { precision: 10, scale: 7 }),
    siteLongitude: numeric("site_longitude", { precision: 10, scale: 7 }),

    /* ---- When ----------------------------------------------------- */
    /**
     * ⚠️ A WINDOW, NOT AN APPOINTMENT TIME.
     *
     * "Between 10 and 1" is what is actually promised to a customer and
     * what the technician is actually judged against. Storing a single
     * `scheduled_at` forces every SLA calculation to invent a tolerance,
     * and every team invents a different one.
     */
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),

    estimatedMinutes: integer("estimated_minutes"),

    /* ---- Who does it ---------------------------------------------- */
    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    crewName: varchar("crew_name", { length: 120 }),

    /* ---- Outcome --------------------------------------------------- */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: fieldFailureReasonEnum("failure_reason"),
    failureNote: text("failure_note"),

    /**
     * ⭐ How many times somebody has been sent for THIS job.
     *
     * ⚠️ THE SINGLE MOST USEFUL NUMBER IN FIELD SERVICE, AND THE ONE
     * ALWAYS MISSING. A job that took three visits cost three times the
     * travel and destroyed the customer's afternoon twice. Recorded on
     * the job rather than counted from visits at report time, because the
     * count is what a dispatcher needs to see on the list, at a glance,
     * before assigning a fourth.
     */
    visitCount: integer("visit_count").default(0).notNull(),

    /** Priced through Engine 2, if this job is billable. */
    rateCardId: uuid("rate_card_id"),
    quotedAmountMinor: bigint("quoted_amount_minor", { mode: "bigint" }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("field_jobs_tenant_idx").on(t.tenantId),
    statusIdx: index("field_jobs_status_idx").on(t.tenantId, t.status),
    assignedIdx: index("field_jobs_assigned_idx").on(
      t.tenantId,
      t.assignedUserId,
      t.windowStart,
    ),
    windowIdx: index("field_jobs_window_idx").on(t.tenantId, t.windowStart),
    numberKey: uniqueIndex("field_jobs_number_key").on(t.tenantId, t.jobNumber),
    tenantScoped: uniqueIndex("field_jobs_id_tenant_key").on(t.id, t.tenantId),
    windowOrdered: check(
      "field_jobs_window_ordered",
      sql`${t.windowEnd} IS NULL OR ${t.windowStart} IS NULL OR ${t.windowEnd} >= ${t.windowStart}`,
    ),
    /**
     * ⚠️ LATITUDE AND LONGITUDE ARE BOTH-OR-NEITHER. A row with one is a
     * point on the prime meridian or the equator, which is in the Gulf of
     * Guinea — a real coordinate, silently wrong, and the distance
     * calculation would happily report it.
     */
    coordsPaired: check(
      "field_jobs_coords_paired",
      sql`(${t.siteLatitude} IS NULL) = (${t.siteLongitude} IS NULL)`,
    ),
    coordsSane: check(
      "field_jobs_coords_sane",
      sql`${t.siteLatitude} IS NULL OR (${t.siteLatitude} BETWEEN -90 AND 90 AND ${t.siteLongitude} BETWEEN -180 AND 180)`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 2 · VISITS — one trip to the site                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐ A VISIT IS SEPARATE FROM A JOB BECAUSE ONE JOB TAKES SEVERAL.
 *
 * ⚠️ Folding check-in/check-out onto the job row is the standard mistake
 * and it silently overwrites: the second visit's check-in replaces the
 * first's, and the record of the wasted trip — the one that cost money
 * and annoyed the customer — is gone. Nothing errors, and the failure is
 * invisible precisely where it matters most.
 */
export const fieldVisits = pgTable(
  "field_visits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    jobId: uuid("job_id").notNull(),

    /**
     * ⭐ GENERATED ON THE DEVICE, BEFORE THE FIRST ATTEMPT.
     *
     * ⚠️ THIS COLUMN IS THE OFFLINE STORY. See the file header — a phone
     * that loses signal mid-submit and retries has sent the same event
     * twice, and only a key the DEVICE chose can tell that it is the same
     * event. A server-side id cannot: to the server they are two POSTs.
     */
    clientEventId: varchar("client_event_id", { length: 120 }).notNull(),

    sequence: integer("sequence").default(1).notNull(),

    /* ---- Arrival --------------------------------------------------- */
    /**
     * ⚠️ WHEN IT HAPPENED, per the device clock — NOT when the server
     * heard about it. A visit recorded at 11:05 and synced at 18:40 when
     * the technician got back into coverage is an 11:05 visit. Ordering
     * by arrival-at-the-server would put the whole day in upload order,
     * which is roughly the reverse of reality.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInLatitude: numeric("checked_in_latitude", { precision: 10, scale: 7 }),
    checkedInLongitude: numeric("checked_in_longitude", { precision: 10, scale: 7 }),
    /** Metres reported by the handset. Large = a fix not worth trusting. */
    checkedInAccuracyM: integer("checked_in_accuracy_m"),

    /* ---- Departure -------------------------------------------------- */
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    checkedOutLatitude: numeric("checked_out_latitude", { precision: 10, scale: 7 }),
    checkedOutLongitude: numeric("checked_out_longitude", { precision: 10, scale: 7 }),

    /* ---- Derived by trigger ---------------------------------------- */
    /**
     * ⭐ Metres between the check-in and the site. EVIDENCE, NOT A GATE.
     * See the file header for why this is not a rejection.
     */
    distanceFromSiteM: integer("distance_from_site_m"),
    isDistanceSuspicious: boolean("is_distance_suspicious")
      .default(false)
      .notNull(),
    onSiteMinutes: integer("on_site_minutes"),

    technicianUserId: uuid("technician_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    /**
     * ⚠️ WHEN THE SERVER RECEIVED IT. Kept ALONGSIDE `checked_in_at`, not
     * instead of it — the gap between the two is the only way to spot a
     * device whose clock is wrong, or a technician filling in yesterday's
     * work from the sofa.
     */
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("field_visits_tenant_idx").on(t.tenantId),
    jobIdx: index("field_visits_job_idx").on(t.tenantId, t.jobId, t.sequence),
    technicianIdx: index("field_visits_technician_idx").on(
      t.tenantId,
      t.technicianUserId,
      t.checkedInAt,
    ),
    suspiciousIdx: index("field_visits_suspicious_idx").on(
      t.tenantId,
      t.isDistanceSuspicious,
    ),
    /**
     * ⭐ THE IDEMPOTENCY KEY. A retried submit collides here and is
     * absorbed, instead of becoming a second visit and a second bill.
     */
    clientEventKey: uniqueIndex("field_visits_client_event_key").on(
      t.tenantId,
      t.clientEventId,
    ),
    tenantScoped: uniqueIndex("field_visits_id_tenant_key").on(t.id, t.tenantId),
    orderedTimes: check(
      "field_visits_times_ordered",
      sql`${t.checkedOutAt} IS NULL OR ${t.checkedInAt} IS NULL OR ${t.checkedOutAt} >= ${t.checkedInAt}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* 3 · PROOF OF SERVICE — append-only                                  */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE EVIDENCE. APPEND-ONLY, AND THAT IS THE ENTIRE VALUE.
 *
 * ⚠️ A photo that can be replaced after the fact is not evidence, it is
 * a picture. The whole reason a customer accepts "the technician attended
 * and the unit was working" is that nobody could have changed the record
 * afterwards. Editable proof is worth nothing in the only conversation it
 * exists for.
 */
export const fieldProofs = pgTable(
  "field_proofs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    visitId: uuid("visit_id").notNull(),
    jobId: uuid("job_id").notNull(),

    kind: fieldProofKindEnum("kind").notNull(),

    /** R2 object key for a photo or signature image. */
    documentId: uuid("document_id"),
    storageKey: varchar("storage_key", { length: 500 }),

    /** A reading, a scanned code, a typed note. */
    value: text("value"),

    /**
     * ⭐ Who accepted the work, and how we know.
     *
     * ⚠️ AN OTP IS VERIFIED SERVER-SIDE AND ONLY THE VERDICT IS STORED.
     * Keeping the code itself would let anyone with database read access
     * reconstruct an acceptance, which defeats the purpose of having sent
     * it to the customer's own number in the first place.
     */
    acceptedByName: varchar("accepted_by_name", { length: 200 }),
    otpVerified: boolean("otp_verified").default(false).notNull(),

    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    capturedLatitude: numeric("captured_latitude", { precision: 10, scale: 7 }),
    capturedLongitude: numeric("captured_longitude", { precision: 10, scale: 7 }),

    /** Device-side key, for the same offline reason as on the visit. */
    clientEventId: varchar("client_event_id", { length: 120 }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("field_proofs_tenant_idx").on(t.tenantId),
    visitIdx: index("field_proofs_visit_idx").on(t.tenantId, t.visitId),
    jobIdx: index("field_proofs_job_idx").on(t.tenantId, t.jobId, t.kind),
    clientEventKey: uniqueIndex("field_proofs_client_event_key").on(
      t.tenantId,
      t.clientEventId,
    ),
    tenantScoped: uniqueIndex("field_proofs_id_tenant_key").on(t.id, t.tenantId),
  }),
);

/* ------------------------------------------------------------------ */
/* 4 · MATERIALS CONSUMED ON SITE                                      */
/* ------------------------------------------------------------------ */

/**
 * What the technician actually fitted.
 *
 * ⚠️ RECORDED AGAINST THE VISIT, NOT THE JOB. A three-visit job that
 * consumed a part on the second visit and returned it on the third is
 * two movements, and a job-level quantity cannot express that. It is also
 * the only honest input to van-stock reconciliation, which is where
 * field-service parts actually go missing.
 */
export const fieldJobMaterials = pgTable(
  "field_job_materials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    jobId: uuid("job_id").notNull(),
    visitId: uuid("visit_id"),

    itemCode: varchar("item_code", { length: 100 }).notNull(),
    itemName: varchar("item_name", { length: 250 }).notNull(),

    /** Negative = returned to stock. */
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unit: varchar("unit", { length: 20 }).default("nos").notNull(),

    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** Warranty work is fitted but not charged. Stated, not inferred. */
    isBillable: boolean("is_billable").default(true).notNull(),
    isWarranty: boolean("is_warranty").default(false).notNull(),

    serialNumber: varchar("serial_number", { length: 120 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("field_job_materials_tenant_idx").on(t.tenantId),
    jobIdx: index("field_job_materials_job_idx").on(t.tenantId, t.jobId),
    itemIdx: index("field_job_materials_item_idx").on(t.tenantId, t.itemCode),
    tenantScoped: uniqueIndex("field_job_materials_id_tenant_key").on(
      t.id,
      t.tenantId,
    ),
    quantityNonZero: check(
      "field_job_materials_quantity_non_zero",
      sql`${t.quantity} <> 0`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* CONSTANTS & PURE ARITHMETIC                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ How far from the site a check-in may be before a supervisor is
 * shown it.
 *
 * ⚠️ 500 METRES, AND IT IS A FLAG AND NOT A LIMIT. Urban GPS is routinely
 * out by 100–200 m; a basement or a metal roof makes it far worse. A
 * threshold tight enough to catch fraud would flag half of all honest
 * check-ins, and a team that sees a red mark on every job stops reading
 * the red marks. This one is loose enough that a flag means something.
 */
export const SUSPICIOUS_DISTANCE_M = 500;

/** Statuses in which a job is still somebody's problem today. */
export const OPEN_JOB_STATUSES = [
  "scheduled",
  "dispatched",
  "travelling",
  "on_site",
  "paused",
] as const;

/**
 * ⭐ THE LEGAL STATUS TRANSITIONS.
 *
 * ⚠️ STATED AS A TABLE, NOT SCATTERED THROUGH THE UI. Every field app
 * grows a rule like "you cannot complete a job you never arrived at" in
 * three places, and the three drift. Here it is one map, enforced once,
 * in the database — where the offline client cannot route around it.
 */
export const FIELD_JOB_TRANSITIONS: Readonly<
  Record<FieldJobStatus, readonly FieldJobStatus[]>
> = Object.freeze({
  draft: ["scheduled", "cancelled"],
  scheduled: ["dispatched", "cancelled", "scheduled"],
  dispatched: ["travelling", "on_site", "could_not_complete", "cancelled", "scheduled"],
  travelling: ["on_site", "could_not_complete", "cancelled"],
  on_site: ["paused", "completed", "could_not_complete"],
  paused: ["on_site", "could_not_complete", "cancelled"],
  // ⚠️ TERMINAL. A completed job is re-opened by raising a NEW job that
  // references it, never by moving this one backwards — otherwise the
  // first-time-fix rate is unmeasurable, because the failures edit
  // themselves out of the record.
  completed: [],
  could_not_complete: ["scheduled"],
  cancelled: [],
});

export type FieldJobStatus = (typeof fieldJobStatusEnum.enumValues)[number];
export type FieldProofKind = (typeof fieldProofKindEnum.enumValues)[number];

/** Is this status change permitted? */
export function canTransition(
  from: FieldJobStatus,
  to: FieldJobStatus,
): boolean {
  return FIELD_JOB_TRANSITIONS[from].includes(to);
}

/**
 * ⭐ Great-circle distance in metres, by the haversine formula.
 *
 * ⚠️ NOT PYTHAGORAS ON LAT/LONG DEGREES. A degree of longitude is 111 km
 * at the equator and 85 km at Delhi's latitude — treating degrees as a
 * flat grid understates east–west distance by about a quarter across
 * India, consistently, and in the direction that makes a distant
 * check-in look closer than it was. That is the exact error this number
 * exists to catch.
 *
 * Mirrors ordence_haversine_m() in SQL-FILES/0036_engine3_field_ops.sql.
 */
export function haversineMetres(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000; // mean Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const fieldJobsRelations = relations(fieldJobs, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [fieldJobs.tenantId],
    references: [tenants.id],
  }),
  customer: one(companies, {
    fields: [fieldJobs.customerCompanyId],
    references: [companies.id],
  }),
  assignee: one(users, {
    fields: [fieldJobs.assignedUserId],
    references: [users.id],
  }),
  visits: many(fieldVisits),
  proofs: many(fieldProofs),
  materials: many(fieldJobMaterials),
}));

export const fieldVisitsRelations = relations(fieldVisits, ({ one, many }) => ({
  job: one(fieldJobs, {
    fields: [fieldVisits.jobId],
    references: [fieldJobs.id],
  }),
  technician: one(users, {
    fields: [fieldVisits.technicianUserId],
    references: [users.id],
  }),
  proofs: many(fieldProofs),
}));

export const fieldProofsRelations = relations(fieldProofs, ({ one }) => ({
  visit: one(fieldVisits, {
    fields: [fieldProofs.visitId],
    references: [fieldVisits.id],
  }),
  job: one(fieldJobs, {
    fields: [fieldProofs.jobId],
    references: [fieldJobs.id],
  }),
}));

export const fieldJobMaterialsRelations = relations(
  fieldJobMaterials,
  ({ one }) => ({
    job: one(fieldJobs, {
      fields: [fieldJobMaterials.jobId],
      references: [fieldJobs.id],
    }),
  }),
);
