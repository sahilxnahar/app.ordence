import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE DRAWING REGISTER, SERVER SIDE
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THIS FILE DOES THAT THE BROWSER CANNOT
 * ══════════════════════════════════════════════════════════════════════
 * The parser and the renderer are pure and run in the viewer. What has to
 * happen here is the REGISTER: which sheet is current, what superseded
 * what, and — the one that matters — recording the unit decision with a
 * name on it.
 *
 * ⚠️ THE FILE IS PARSED ONCE ON UPLOAD, SERVER SIDE, TO FILL THE SUMMARY
 * COLUMNS. Not to store the geometry: the geometry is in the file, and a
 * second copy of it in the database goes stale the first time the engine
 * improves. What is stored is COUNTS and EXTENTS — enough to show a
 * register row and to sanity-check a later measurement.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  drawingMarkups,
  drawingMeasurements,
  drawingRevisions,
  drawings,
} from "@/db/schema/drawings";
import { parseDxf } from "@/lib/cad/dxf/parse";
import { identifyCadFile, dwgRefusal } from "@/lib/cad/dxf/lexer";
import type { DrawingUnit } from "@/lib/cad/types";
/**
 * ⭐ THE ROW SHAPES LIVE IN A PURE MODULE so a client component may
 * import them without pulling a server module into the browser bundle.
 * `check:boundaries` refused the first draft for exactly that.
 */
export type {
  DrawingRow,
  RevisionRow,
  MarkupRow,
  MeasurementRow,
} from "@/lib/cad/view-types";
import type {
  DrawingRow,
  RevisionRow,
  MarkupRow,
  MeasurementRow,
} from "@/lib/cad/view-types";

export class DrawingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrawingError";
  }
}

export type ParsedSummary = {
  readonly sourceFormat: "dxf";
  readonly entityCount: number;
  readonly layerCount: number;
  readonly unsupported: Readonly<Record<string, number>>;
  readonly declaredUnit: DrawingUnit | null;
  readonly extentMinX: number;
  readonly extentMinY: number;
  readonly extentMaxX: number;
  readonly extentMaxY: number;
  readonly warnings: readonly string[];
};

/**
 * ⭐⭐ READ AN UPLOADED CAD FILE AND SAY WHAT IT IS.
 *
 * 🔴 A DWG IS REFUSED WITH THE VERSION NAMED AND THE MENU PATH GIVEN.
 * "Unsupported file type" sends the customer to support; naming the
 * AutoCAD version and the two-click export sends them back to their own
 * software, which is where the fix is.
 */
export function summariseCadFile(bytes: Uint8Array): ParsedSummary {
  const kind = identifyCadFile(bytes);

  if (kind.kind === "dwg") throw new DrawingError(dwgRefusal(kind.version));

  if (kind.kind === "dxf-binary") {
    throw new DrawingError(
      "That is a binary DXF. It is a real format and a rare one, and Ordence reads the ordinary " +
        "text DXF that every program writes by default. Re-export it without ticking the binary " +
        "option.",
    );
  }

  if (kind.kind !== "dxf-ascii") {
    throw new DrawingError(
      "Ordence could not tell what that file is. It reads DXF — the interchange format every CAD " +
        "program writes. If this came out of CAD, export it again as DXF; if it is a PDF or an " +
        "image of a drawing, attach it as a document instead.",
    );
  }

  const drawing = parseDxf(new TextDecoder("utf-8").decode(bytes));

  return {
    sourceFormat: "dxf",
    entityCount: drawing.entities.length,
    layerCount: drawing.layers.length,
    unsupported: drawing.report.unsupported,
    declaredUnit: drawing.units,
    extentMinX: drawing.bounds.minX,
    extentMinY: drawing.bounds.minY,
    extentMaxX: drawing.bounds.maxX,
    extentMaxY: drawing.bounds.maxY,
    warnings: drawing.report.warnings,
  };
}

export async function listDrawings(tenantId: string, limit = 200): Promise<DrawingRow[]> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT d.id,
             d.drawing_number,
             d.title,
             d.discipline,
             d.status,
             d.current_revision_id,
             r.revision                                            AS current_revision,
             (SELECT count(*) FROM drawing_revisions x
               WHERE x.drawing_id = d.id)::int                     AS revision_count,
             (SELECT count(*) FROM drawing_markups m
               WHERE m.revision_id = d.current_revision_id
                 AND m.resolved_at IS NULL)::int                   AS open_markups,
             /* ⭐ THE COLUMN THE REGISTER IS ACTUALLY FOR, after
                "which revision": whether anything can be MEASURED off
                this sheet, or whether somebody still has to say what a
                drawing unit means. */
             (r.declared_unit IS NOT NULL AND r.declared_unit <> 'unitless')
               OR r.assumed_unit IS NOT NULL                       AS unit_known
        FROM drawings d
        LEFT JOIN drawing_revisions r ON r.id = d.current_revision_id
       ORDER BY d.drawing_number
       LIMIT ${Math.min(500, Math.max(1, limit))}
    `);

    const rows = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : (((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]);

    return rows.map((r) => ({
      id: String(r.id),
      drawingNumber: String(r.drawing_number),
      title: String(r.title),
      discipline: String(r.discipline),
      status: String(r.status),
      currentRevisionId: (r.current_revision_id as string | null) ?? null,
      currentRevision: (r.current_revision as string | null) ?? null,
      revisionCount: Number(r.revision_count ?? 0),
      openMarkups: Number(r.open_markups ?? 0),
      unitKnown: Boolean(r.unit_known),
    }));
  });
}

export async function createDrawing(args: {
  readonly tenantId: string;
  readonly createdBy: string;
  readonly drawingNumber: string;
  readonly title: string;
  readonly discipline: string;
  readonly projectId?: string | null;
}): Promise<string> {
  return withTenant(args.tenantId, async (tx) => {
    const [row] = await tx
      .insert(drawings)
      .values({
        tenantId: args.tenantId,
        createdBy: args.createdBy,
        drawingNumber: args.drawingNumber.trim(),
        title: args.title.trim(),
        discipline: args.discipline,
        projectId: args.projectId ?? null,
      })
      .returning({ id: drawings.id });
    if (!row) throw new DrawingError("The drawing could not be created.");
    return row.id;
  });
}

/**
 * ⭐⭐⭐ ISSUE A REVISION, AND SUPERSEDE THE ONE BEFORE IT.
 *
 * 🔴 BOTH IN ONE TRANSACTION. A revision inserted without its predecessor
 * being superseded leaves TWO sheets that both look current, which is the
 * single failure a drawing register exists to prevent — and the window
 * between two separate statements is exactly when somebody on site opens
 * the register.
 */
export async function issueRevision(args: {
  readonly tenantId: string;
  readonly drawingId: string;
  readonly uploadedBy: string;
  readonly revision: string;
  readonly documentId: string;
  readonly issuedOn?: string | null;
  readonly notes?: string | null;
  readonly summary: ParsedSummary;
}): Promise<{ revisionId: string; supersededRevision: string | null }> {
  return withTenant(args.tenantId, async (tx) => {
    const previous = await tx
      .select({
        id: drawingRevisions.id,
        revision: drawingRevisions.revision,
        order: drawingRevisions.revisionOrder,
      })
      .from(drawingRevisions)
      .where(
        and(
          eq(drawingRevisions.tenantId, args.tenantId),
          eq(drawingRevisions.drawingId, args.drawingId),
        ),
      )
      .orderBy(desc(drawingRevisions.revisionOrder))
      .limit(1);

    const latest = previous[0];
    const nextOrder = (latest?.order ?? 0) + 1;

    const [inserted] = await tx
      .insert(drawingRevisions)
      .values({
        tenantId: args.tenantId,
        drawingId: args.drawingId,
        revision: args.revision.trim(),
        revisionOrder: nextOrder,
        documentId: args.documentId,
        sourceFormat: args.summary.sourceFormat,
        entityCount: args.summary.entityCount,
        layerCount: args.summary.layerCount,
        unsupported: args.summary.unsupported as Record<string, unknown>,
        declaredUnit: args.summary.declaredUnit,
        extentMinX: args.summary.extentMinX,
        extentMinY: args.summary.extentMinY,
        extentMaxX: args.summary.extentMaxX,
        extentMaxY: args.summary.extentMaxY,
        issuedOn: args.issuedOn ?? null,
        uploadedBy: args.uploadedBy,
        notes: args.notes ?? null,
      })
      .returning({ id: drawingRevisions.id });

    if (!inserted) throw new DrawingError("The revision could not be recorded.");

    if (latest) {
      await tx
        .update(drawingRevisions)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(drawingRevisions.tenantId, args.tenantId),
            eq(drawingRevisions.id, latest.id),
          ),
        );
    }

    await tx
      .update(drawings)
      .set({ currentRevisionId: inserted.id, updatedAt: new Date() })
      .where(and(eq(drawings.tenantId, args.tenantId), eq(drawings.id, args.drawingId)));

    return { revisionId: inserted.id, supersededRevision: latest?.revision ?? null };
  });
}

/**
 * ⭐⭐ RECORD WHAT ONE DRAWING UNIT MEANS, WHEN THE FILE DID NOT SAY.
 *
 * 🔴 THIS IS A DECISION, NOT A SETTING, and it is stored with a name and
 * a time on it. Every measurement taken afterwards cites it. `0118`
 * refuses the row if any of the three columns is missing, and refuses it
 * outright if the file already declared a unit — overriding a stated unit
 * means the file is wrong, which is a different act.
 */
export async function assumeUnit(args: {
  readonly tenantId: string;
  readonly revisionId: string;
  readonly unit: DrawingUnit;
  readonly assumedBy: string;
}): Promise<void> {
  if (args.unit === "unitless") {
    throw new DrawingError(
      "\"Unitless\" is what the drawing already says. Choosing it again does not make anything " +
        "measurable — pick the unit one drawing unit actually represents.",
    );
  }
  await withTenant(args.tenantId, async (tx) => {
    const updated = await tx
      .update(drawingRevisions)
      .set({ assumedUnit: args.unit, assumedBy: args.assumedBy, assumedAt: new Date() })
      .where(
        and(
          eq(drawingRevisions.tenantId, args.tenantId),
          eq(drawingRevisions.id, args.revisionId),
        ),
      )
      .returning({ id: drawingRevisions.id });

    if (updated.length === 0) {
      throw new DrawingError(
        "That revision could not be updated. It may have been superseded, in which case it is " +
          "frozen: set the unit on the revision that is current.",
      );
    }
  });
}

export async function listRevisions(
  tenantId: string,
  drawingId: string,
): Promise<RevisionRow[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(drawingRevisions)
      .where(
        and(eq(drawingRevisions.tenantId, tenantId), eq(drawingRevisions.drawingId, drawingId)),
      )
      .orderBy(desc(drawingRevisions.revisionOrder));

    return rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      revisionOrder: r.revisionOrder,
      documentId: r.documentId,
      sourceFormat: r.sourceFormat,
      entityCount: r.entityCount,
      layerCount: r.layerCount,
      unsupported: (r.unsupported as Record<string, number>) ?? {},
      declaredUnit: r.declaredUnit,
      assumedUnit: r.assumedUnit,
      supersededAt: r.supersededAt,
      receivedAt: r.receivedAt,
      notes: r.notes,
    }));
  });
}

export async function listMarkups(
  tenantId: string,
  revisionId: string,
): Promise<MarkupRow[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(drawingMarkups)
      .where(
        and(eq(drawingMarkups.tenantId, tenantId), eq(drawingMarkups.revisionId, revisionId)),
      )
      .orderBy(drawingMarkups.createdAt);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      points: (r.points as { x: number; y: number }[]) ?? [],
      body: r.body,
      colour: r.colour,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    }));
  });
}

export async function addMarkup(args: {
  readonly tenantId: string;
  readonly revisionId: string;
  readonly createdBy: string;
  readonly kind: string;
  readonly points: readonly { x: number; y: number }[];
  readonly body?: string | null;
  readonly colour?: string;
}): Promise<string> {
  return withTenant(args.tenantId, async (tx) => {
    const [row] = await tx
      .insert(drawingMarkups)
      .values({
        tenantId: args.tenantId,
        revisionId: args.revisionId,
        createdBy: args.createdBy,
        kind: args.kind,
        points: [...args.points] as unknown as Record<string, unknown>,
        body: args.body ?? null,
        ...(args.colour ? { colour: args.colour } : {}),
      })
      .returning({ id: drawingMarkups.id });
    if (!row) throw new DrawingError("The markup could not be saved.");
    return row.id;
  });
}

export async function resolveMarkup(args: {
  readonly tenantId: string;
  readonly markupId: string;
  readonly resolvedBy: string;
}): Promise<void> {
  await withTenant(args.tenantId, (tx) =>
    tx
      .update(drawingMarkups)
      .set({ resolvedAt: new Date(), resolvedBy: args.resolvedBy })
      .where(
        and(eq(drawingMarkups.tenantId, args.tenantId), eq(drawingMarkups.id, args.markupId)),
      ),
  );
}

export async function listMeasurements(
  tenantId: string,
  revisionId: string,
): Promise<MeasurementRow[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(drawingMeasurements)
      .where(
        and(
          eq(drawingMeasurements.tenantId, tenantId),
          eq(drawingMeasurements.revisionId, revisionId),
        ),
      )
      .orderBy(desc(drawingMeasurements.takenAt));

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      layer: r.layer,
      valueSi: r.valueSi,
      maxErrorSi: r.maxErrorSi,
      isExact: r.isExact,
      unitBasis: r.unitBasis,
      unitWasAssumed: r.unitWasAssumed,
      takenAt: r.takenAt,
    }));
  });
}
