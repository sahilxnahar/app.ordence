"use server";

/**
 * Ordence — ⭐⭐⭐ THE DRAWING REGISTER ACTIONS
 * Version: v1.75.0-alpha · Wave 7
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ FOUR PERMISSIONS, AND THE SPLIT IS THE POINT
 * ══════════════════════════════════════════════════════════════════════
 *   drawings:read     look at the sheet
 *   drawings:markup   raise a comment on it
 *   drawings:manage   issue a revision, supersede the one the site is
 *                     building to
 *   drawings:measure  🔴 take a quantity off it
 *
 * The last one is not the first one. A quantity taken off a drawing goes
 * into a BOQ and into a running bill somebody gets paid against; a site
 * engineer who may check a dimension on screen is not automatically a
 * quantity surveyor, and the difference is money.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";

import { requirePermission, writeAudit } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import { requireAccess, AccessRestrictedError } from "@/server/billing/access";
import { requireFeature, FeatureLockedError } from "@/server/entitlements";
import type { ActionResult } from "@/lib/validators/crm";

import {
  DrawingError,
  addMarkup,
  assumeUnit,
  createDrawing,
  issueRevision,
  listDrawings,
  listMarkups,
  listMeasurements,
  listRevisions,
  resolveMarkup,
  summariseCadFile,
  type DrawingRow,
  type MarkupRow,
  type MeasurementRow,
  type RevisionRow,
} from "@/server/cad/register";
import { MeasurementRefused, recordMeasurement } from "@/server/cad/measure";
import { readRevisionSource } from "@/server/cad/source";
import { DRAWING_UNITS } from "@/lib/cad/units";
import { DxfLexError } from "@/lib/cad/dxf/lexer";
import { DxfParseError } from "@/lib/cad/dxf/parse";

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

/**
 * ⭐⭐⭐ THE FOUR GATES, IN THE ORDER THE REST OF THIS PRODUCT USES THEM.
 *
 * ⚠️ ACCOUNT STANDING, THEN PLAN, THEN PERSON — broadest reason outermost,
 * so the customer is told the thing they can act on rather than an inner
 * detail. A workspace in arrears told "you lack permission" sends the
 * owner to ask an administrator who is themselves.
 *
 * 🔴 THE FEATURE GATE IS NOT OPTIONAL AND `lib/entitlements/enforcement.ts`
 * RECORDS THAT IT EXISTS. A key marked `gated` there with no gate in
 * `server/` fails the build — that ledger was written because a control
 * declared and enforced by nothing has been found in this codebase
 * repeatedly, and each time a customer believed a limit existed and it did
 * not.
 */
async function guardDrawings(permission: Parameters<typeof requirePermission>[0]) {
  const ctx = await requirePermission(permission);
  await requireAccess(permission, ctx);
  await requireFeature("construction.drawings", ctx);
  return ctx;
}

function toActionError(err: unknown): ActionResult<never> {
  /** Billing first: a workspace in arrears is in arrears, not under-permissioned. */
  if (err instanceof AccessRestrictedError) return fail(err.message);
  if (err instanceof FeatureLockedError) return fail(err.message);
  /**
   * ⭐ EVERY ONE OF THESE IS A SENTENCE THE PERSON CAN ACT ON. The DWG
   * refusal in particular names the AutoCAD version and the menu path, so
   * collapsing it into "something went wrong" would throw away the only
   * useful thing in it.
   */
  if (err instanceof DrawingError) return fail(err.message);
  if (err instanceof MeasurementRefused) return fail(err.message);
  if (err instanceof DxfLexError) return fail(err.message);
  if (err instanceof DxfParseError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) return fail("That request was not valid.");
  /**
   * ⚠️ A UNIQUE VIOLATION HERE IS ALWAYS THE SAME THING and deserves its
   * own sentence: two sheets sharing a number is how a site builds to the
   * wrong one.
   */
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") {
    return fail(
      "A drawing with that number already exists in this project. Two sheets sharing a number " +
        "is how a site builds to the wrong one, so Ordence will not create the second. If this " +
        "is a new issue of the same sheet, add it as a revision instead.",
    );
  }
  console.error("[drawings action]", err);
  return fail("That could not be completed. Please try again.");
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export async function getDrawings(): Promise<ActionResult<DrawingRow[]>> {
  try {
    const ctx = await guardDrawings("drawings:read");
    return { ok: true, data: await listDrawings(ctx.tenant.id) };
  } catch (err) {
    return toActionError(err);
  }
}

export type DrawingDetail = {
  readonly revisions: readonly RevisionRow[];
  readonly markups: readonly MarkupRow[];
  readonly measurements: readonly MeasurementRow[];
};

export async function getDrawingDetail(input: unknown): Promise<ActionResult<DrawingDetail>> {
  try {
    const params = z.object({ drawingId: z.string().uuid() }).parse(input);
    const ctx = await guardDrawings("drawings:read");

    const revisions = await listRevisions(ctx.tenant.id, params.drawingId);
    const current = revisions[0];
    if (!current) return { ok: true, data: { revisions, markups: [], measurements: [] } };

    const [markups, measurements] = await Promise.all([
      listMarkups(ctx.tenant.id, current.id),
      listMeasurements(ctx.tenant.id, current.id),
    ]);

    return { ok: true, data: { revisions, markups, measurements } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* MANAGE                                                              */
/* ------------------------------------------------------------------ */

export async function addDrawing(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const params = z
      .object({
        drawingNumber: z.string().min(1).max(80),
        title: z.string().min(1).max(255),
        discipline: z.enum([
          "architectural",
          "structural",
          "mep",
          "civil",
          "survey",
          "landscape",
          "interior",
          "other",
        ]),
        projectId: z.string().uuid().optional(),
      })
      .parse(input);

    const ctx = await guardDrawings("drawings:manage");
    const id = await createDrawing({
      tenantId: ctx.tenant.id,
      createdBy: ctx.user.id,
      drawingNumber: params.drawingNumber,
      title: params.title,
      discipline: params.discipline,
      projectId: params.projectId ?? null,
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "drawing",
      resourceId: id,
      newValue: { drawingNumber: params.drawingNumber, title: params.title },
      reason: `Drawing ${params.drawingNumber} was added to the register.`,
    });

    revalidatePath("/drawings");
    return { ok: true, data: { id } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐⭐ ADD A REVISION.
 *
 * ⚠️ THE FILE ARRIVES AS BASE64 AND IS PARSED HERE. Same argument as the
 * export path: a GET route returning a customer's drawings is a URL you
 * do not want in a browser history, and a POST with the session attached
 * has none.
 *
 * 🔴 THE PARSE HAPPENS BEFORE ANYTHING IS WRITTEN. A DWG, a binary DXF or
 * a corrupt file is refused with a sentence naming what it actually is,
 * rather than landing in the register as a revision nobody can open.
 */
export async function addRevision(input: unknown): Promise<
  ActionResult<{
    revisionId: string;
    supersededRevision: string | null;
    warnings: readonly string[];
    unitKnown: boolean;
  }>
> {
  try {
    const params = z
      .object({
        drawingId: z.string().uuid(),
        revision: z.string().min(1).max(20),
        documentId: z.string().uuid(),
        issuedOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        notes: z.string().max(4000).optional(),
        /** ⚠️ Capped. A 40MB site plan is 54MB of base64. */
        fileBase64: z.string().max(80 * 1024 * 1024),
      })
      .parse(input);

    const ctx = await guardDrawings("drawings:manage");

    const bytes = new Uint8Array(Buffer.from(params.fileBase64, "base64"));
    const summary = summariseCadFile(bytes);

    const result = await issueRevision({
      tenantId: ctx.tenant.id,
      drawingId: params.drawingId,
      uploadedBy: ctx.user.id,
      revision: params.revision,
      documentId: params.documentId,
      issuedOn: params.issuedOn ?? null,
      notes: params.notes ?? null,
      summary,
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "drawing_revision",
      resourceId: result.revisionId,
      newValue: {
        revision: params.revision,
        superseded: result.supersededRevision,
        entities: summary.entityCount,
        unsupported: summary.unsupported,
      },
      reason: result.supersededRevision
        ? `Revision ${params.revision} was issued and revision ${result.supersededRevision} was superseded.`
        : `Revision ${params.revision} was issued.`,
      severity: "notice",
    });

    revalidatePath("/drawings");
    return {
      ok: true,
      data: {
        revisionId: result.revisionId,
        supersededRevision: result.supersededRevision,
        warnings: summary.warnings,
        unitKnown: summary.declaredUnit !== null && summary.declaredUnit !== "unitless",
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐⭐⭐ SAY WHAT ONE DRAWING UNIT MEANS.
 *
 * 🔴 `drawings:manage`, NOT `drawings:measure`. This decision does not
 * produce one quantity, it produces EVERY quantity anybody ever takes off
 * this sheet. It belongs with issuing the revision, not with reading it.
 */
export async function setDrawingUnit(input: unknown): Promise<ActionResult<{ ok: true }>> {
  try {
    const params = z
      .object({
        revisionId: z.string().uuid(),
        unit: z.enum(DRAWING_UNITS as unknown as [string, ...string[]]),
      })
      .parse(input);

    const ctx = await guardDrawings("drawings:manage");

    await assumeUnit({
      tenantId: ctx.tenant.id,
      revisionId: params.revisionId,
      unit: params.unit as never,
      assumedBy: ctx.user.id,
    });

    await writeAudit(ctx, {
      action: "update",
      resourceType: "drawing_revision",
      resourceId: params.revisionId,
      newValue: { assumedUnit: params.unit },
      reason:
        `One drawing unit on this sheet was declared to mean one ${params.unit.replace(/s$/, "")}. ` +
        `Every measurement taken off it from now on depends on this.`,
      severity: "notice",
    });

    revalidatePath("/drawings");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* MARKUP                                                              */
/* ------------------------------------------------------------------ */

export async function addDrawingMarkup(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const params = z
      .object({
        revisionId: z.string().uuid(),
        kind: z.enum(["cloud", "arrow", "text", "dimension", "highlight", "pin"]),
        points: z.array(z.object({ x: z.number(), y: z.number() })).min(1).max(2000),
        body: z.string().max(4000).optional(),
        colour: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      })
      .parse(input);

    const ctx = await guardDrawings("drawings:markup");

    const id = await addMarkup({
      tenantId: ctx.tenant.id,
      revisionId: params.revisionId,
      createdBy: ctx.user.id,
      kind: params.kind,
      points: params.points,
      body: params.body ?? null,
      ...(params.colour ? { colour: params.colour } : {}),
    });

    revalidatePath("/drawings");
    return { ok: true, data: { id } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function resolveDrawingMarkup(input: unknown): Promise<ActionResult<{ ok: true }>> {
  try {
    const params = z.object({ markupId: z.string().uuid() }).parse(input);
    const ctx = await guardDrawings("drawings:markup");
    await resolveMarkup({
      tenantId: ctx.tenant.id,
      markupId: params.markupId,
      resolvedBy: ctx.user.id,
    });
    revalidatePath("/drawings");
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* MEASURE                                                             */
/* ------------------------------------------------------------------ */

export async function takeMeasurement(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const params = z
      .object({
        revisionId: z.string().uuid(),
        kind: z.enum(["length", "area", "count"]),
        label: z.string().min(1).max(200),
        layer: z.string().max(120).optional(),
        rawValue: z.number().nonnegative(),
        rawMaxError: z.number().nonnegative(),
        isExact: z.boolean(),
        points: z.array(z.object({ x: z.number(), y: z.number() })).max(5000),
      })
      .parse(input);

    /** 🔴 Its own permission. See the header. */
    const ctx = await guardDrawings("drawings:measure");

    const id = await recordMeasurement({
      tenantId: ctx.tenant.id,
      revisionId: params.revisionId,
      takenBy: ctx.user.id,
      kind: params.kind,
      label: params.label,
      layer: params.layer ?? null,
      rawValue: params.rawValue,
      rawMaxError: params.rawMaxError,
      isExact: params.isExact,
      points: params.points,
    });

    await writeAudit(ctx, {
      action: "create",
      resourceType: "drawing_measurement",
      resourceId: id,
      newValue: { kind: params.kind, label: params.label },
      reason: `A ${params.kind} was taken off a drawing. It may be billed against.`,
      severity: "notice",
    });

    revalidatePath("/drawings");
    return { ok: true, data: { id } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * ⭐⭐ THE FILE ITSELF, AS TEXT, FOR THE VIEWER.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS AN ACTION AND NOT A LINK TO THE FILE
 * ══════════════════════════════════════════════════════════════════════
 * A signed download URL for a customer's drawing is a URL that survives
 * in a browser history, a proxy log and a shared screenshot — the same
 * argument `app/(crm)/settings/recovery/export-button.tsx` makes and the
 * same one wave 5 makes about exports. A server action is a POST with the
 * session attached and no URL to leak.
 *
 * ⚠️ AND IT IS PERMISSION-CHECKED PER CALL. RLS scopes the revision to the
 * workspace; `drawings:read` decides whether this person may see it at
 * all, which RLS cannot express.
 */
export async function getRevisionSource(
  input: unknown,
): Promise<ActionResult<{ dxf: string }>> {
  try {
    const params = z.object({ revisionId: z.string().uuid() }).parse(input);
    const ctx = await guardDrawings("drawings:read");
    const dxf = await readRevisionSource(ctx.tenant.id, params.revisionId);
    return { ok: true, data: { dxf } };
  } catch (err) {
    return toActionError(err);
  }
}
