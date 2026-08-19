/**
 * Ordence — ⭐⭐⭐ THE DRAWING REGISTER — SQL 0118 · WAVE 7
 * Version: v1.75.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE THREE PROPERTIES THIS SCHEMA IS BUILT AROUND
 * ══════════════════════════════════════════════════════════════════════
 * ① THE ORIGINAL FILE IS NEVER MODIFIED. Markups are rows in their own
 *    table, in DRAWING COORDINATES, and the file that goes back out is
 *    byte-identical to the one that came in.
 *
 * ② A REVISION IS IMMUTABLE ONCE SUPERSEDED. Rev B is what the slab was
 *    poured against.
 *
 * ③ A MEASUREMENT CITES THE REVISION AND THE UNIT DECISION IT CAME FROM,
 *    with an error bound. "412.150 m², from DRG-102 Rev C, at 1 unit =
 *    1 mm as declared by the file, ±0.004 m²" is a number an auditor can
 *    check. "412" is not.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users } from "./core";
import { documents } from "./storage";

export const drawings = pgTable(
  "drawings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** ⭐ The project's own number. Ours would be a second one nobody uses. */
    drawingNumber: varchar("drawing_number", { length: 80 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),

    /** ⚠️ Nullable: a tender drawing arrives before the project exists. */
    projectId: uuid("project_id"),

    discipline: varchar("discipline", { length: 40 })
      .default("architectural")
      .notNull(),

    /**
     * ⭐ Denormalised deliberately. "Which sheet is current" is asked on
     * every screen, and a lateral join for it over 4,000 drawings is the
     * query that makes the register slow.
     */
    currentRevisionId: uuid("current_revision_id"),

    status: varchar("status", { length: 20 }).default("for_information").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("drawings_tenant_idx").on(t.tenantId, t.discipline, t.drawingNumber),

    disciplineKnown: check(
      "drawings_discipline_known",
      sql`${t.discipline} IN ('architectural', 'structural', 'mep', 'civil', 'survey', 'landscape', 'interior', 'other')`,
    ),
    statusKnown: check(
      "drawings_status_known",
      sql`${t.status} IN ('for_information', 'for_approval', 'good_for_construction', 'as_built', 'superseded', 'void')`,
    ),
    numberNotBlank: check(
      "drawings_number_not_blank",
      sql`length(btrim(${t.drawingNumber})) > 0`,
    ),
  }),
);

export const drawingRevisions = pgTable(
  "drawing_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),

    revision: varchar("revision", { length: 20 }).notNull(),
    /**
     * ⚠️ AN ORDER, SEPARATELY FROM THE LABEL. "P2" does not sort after
     * "P10" as text, and "which is later" is the only question this
     * column exists to answer.
     */
    revisionOrder: integer("revision_order").notNull(),

    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),

    sourceFormat: varchar("source_format", { length: 12 }).notNull(),

    entityCount: integer("entity_count").default(0).notNull(),
    layerCount: integer("layer_count").default(0).notNull(),
    /** 🔴 What Ordence could not read, by name. `{"HATCH": 412}`. */
    unsupported: jsonb("unsupported").notNull().default({}),

    extentMinX: doublePrecision("extent_min_x"),
    extentMinY: doublePrecision("extent_min_y"),
    extentMaxX: doublePrecision("extent_max_x"),
    extentMaxY: doublePrecision("extent_max_y"),

    /**
     * 🔴 TWO COLUMNS, NOT ONE. `declaredUnit` is what the FILE said;
     * `assumedUnit` is what a PERSON said when it did not. A single
     * column would make "the drawing says millimetres" and "Ramesh thinks
     * it is millimetres" indistinguishable six months later, and only one
     * of those is evidence.
     */
    declaredUnit: varchar("declared_unit", { length: 20 }),
    assumedUnit: varchar("assumed_unit", { length: 20 }),
    assumedBy: uuid("assumed_by").references(() => users.id, { onDelete: "restrict" }),
    assumedAt: timestamp("assumed_at", { withTimezone: true }),

    issuedOn: date("issued_on", { mode: "string" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    /** ⚠️ Set when a later revision arrives. From then on this row is frozen. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),

    notes: text("notes"),
  },
  (t) => ({
    labelOnce: uniqueIndex("drawing_revisions_label_once").on(t.drawingId, t.revision),
    orderOnce: uniqueIndex("drawing_revisions_order_once").on(t.drawingId, t.revisionOrder),
    drawingIdx: index("drawing_revisions_drawing_idx").on(
      t.tenantId,
      t.drawingId,
      t.revisionOrder,
    ),

    formatKnown: check(
      "drawing_revisions_format_known",
      sql`${t.sourceFormat} IN ('dxf', 'pdf', 'svg', 'image')`,
    ),
    /** 🔴 An assumption is somebody's assumption. All three or none. */
    assumptionAttributed: check(
      "drawing_revisions_assumption_is_attributed",
      sql`(${t.assumedUnit} IS NULL) = (${t.assumedBy} IS NULL) AND (${t.assumedUnit} IS NULL) = (${t.assumedAt} IS NULL)`,
    ),
    /** ⚠️ And you do not assume what the file already told you. */
    noAssumptionOverDeclaration: check(
      "drawing_revisions_no_assumption_over_declaration",
      sql`${t.assumedUnit} IS NULL OR ${t.declaredUnit} IS NULL OR ${t.declaredUnit} = 'unitless'`,
    ),
    countsSane: check(
      "drawing_revisions_counts_sane",
      sql`${t.entityCount} >= 0 AND ${t.layerCount} >= 0`,
    ),
  }),
);

export const drawingMarkups = pgTable(
  "drawing_markups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * ⚠️ A MARKUP BELONGS TO A REVISION, NOT TO A DRAWING. A comment
     * about Rev B is not a comment about Rev C — the thing it points at
     * may have moved — and carrying it forward silently is how a resolved
     * comment reappears on a sheet that already fixed it.
     */
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => drawingRevisions.id, { onDelete: "cascade" }),

    kind: varchar("kind", { length: 20 }).notNull(),

    /**
     * ⭐ IN DRAWING UNITS, NOT SCREEN PIXELS. A markup stored at "x = 412
     * pixels" moves when somebody resizes their window and is meaningless
     * on a print.
     */
    points: jsonb("points").notNull(),
    body: text("body"),
    colour: varchar("colour", { length: 9 }).default("#e11d48").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    revisionIdx: index("drawing_markups_revision_idx").on(
      t.tenantId,
      t.revisionId,
      t.createdAt,
    ),

    kindKnown: check(
      "drawing_markups_kind_known",
      sql`${t.kind} IN ('cloud', 'arrow', 'text', 'dimension', 'highlight', 'pin')`,
    ),
    resolutionPair: check(
      "drawing_markups_resolution_pair",
      sql`(${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL)`,
    ),
    textHasBody: check(
      "drawing_markups_text_has_body",
      sql`${t.kind} <> 'text' OR length(btrim(coalesce(${t.body}, ''))) > 0`,
    ),
    pointsIsArray: check(
      "drawing_markups_points_is_array",
      sql`jsonb_typeof(${t.points}) = 'array' AND jsonb_array_length(${t.points}) > 0`,
    ),
  }),
);

/**
 * ⭐⭐⭐ THE TABLE THAT CONNECTS A DRAWING TO THE BILLING CHAIN.
 *
 * This product has `boqs`, `boq_items`, `rate_analyses` and
 * `measurement_books` and, before wave 7, nothing that held a drawing.
 * Every quantity in that chain was typed in by somebody reading a printed
 * sheet, and the answer to "where did this 412 square metres come from"
 * was a person's memory.
 */
export const drawingMeasurements = pgTable(
  "drawing_measurements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => drawingRevisions.id, { onDelete: "restrict" }),

    kind: varchar("kind", { length: 12 }).notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    layer: varchar("layer", { length: 120 }),

    /** ⭐ In SI, always. Adding two measurements must not need the drawing. */
    valueSi: doublePrecision("value_si").notNull(),
    /** 🔴 The bound. Flattening a curve to measure it is an approximation. */
    maxErrorSi: doublePrecision("max_error_si").default(0).notNull(),
    isExact: boolean("is_exact").default(false).notNull(),

    /**
     * ⚠️ COPIED AT THE TIME. If somebody later changes the assumed unit on
     * the revision, this measurement does not silently change with it — it
     * becomes visibly inconsistent, which is correct and is what a
     * re-measure exists to fix.
     */
    unitBasis: varchar("unit_basis", { length: 20 }).notNull(),
    unitWasAssumed: boolean("unit_was_assumed").notNull(),

    points: jsonb("points").notNull(),

    takenAt: timestamp("taken_at", { withTimezone: true }).defaultNow().notNull(),
    takenBy: uuid("taken_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    boqItemId: uuid("boq_item_id"),
  },
  (t) => ({
    revisionIdx: index("drawing_measurements_revision_idx").on(
      t.tenantId,
      t.revisionId,
      t.takenAt,
    ),

    kindKnown: check(
      "drawing_measurements_kind_known",
      sql`${t.kind} IN ('length', 'area', 'count')`,
    ),
    valueSane: check(
      "drawing_measurements_value_sane",
      sql`${t.valueSi} >= 0 AND ${t.maxErrorSi} >= 0`,
    ),
    /** 🔴 Exact means exact. The flag is what a BOQ would rely on. */
    exactHasNoError: check(
      "drawing_measurements_exact_has_no_error",
      sql`${t.isExact} = false OR ${t.maxErrorSi} = 0`,
    ),
    labelNotBlank: check(
      "drawing_measurements_label_not_blank",
      sql`length(btrim(${t.label})) > 0`,
    ),
    pointsIsArray: check(
      "drawing_measurements_points_is_array",
      sql`jsonb_typeof(${t.points}) = 'array'`,
    ),
  }),
);
