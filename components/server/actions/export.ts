"use server";

/**
 * Ordence — ⭐⭐⭐ THE EXPORT ACTIONS
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ORDER OF OPERATIONS, WHICH IS THE WHOLE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 *   ① permission — the dataset's own, not a blanket "may export"
 *   ② validate   — format known, dates are dates, dataset exists
 *   ③ load       — inside `withTenant`, under RLS
 *   ④ render     — `server/export/render.ts`, the single door
 *   ⑤ 🔴 LOG     — and if the log fails, NOTHING IS RETURNED
 *   ⑥ return
 *
 * ⚠️ ⑤ BEFORE ⑥ IS NOT A STYLE CHOICE. `server/export/log.ts` explains
 * why its failure is fatal where `writeAudit`'s is not: an audit record
 * describes something that already happened, and an export log is written
 * before the disclosure. Returning the file and then failing to record it
 * produces the one outcome nobody can live with.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE BYTES COME BACK AS BASE64 AND NOT FROM A GET ROUTE
 * ══════════════════════════════════════════════════════════════════════
 * `app/(crm)/settings/recovery/export-button.tsx` already argued this and
 * it is right: "a GET endpoint returning every record in a workspace is
 * exactly the URL you do not want appearing in a browser history, a proxy
 * log or a shared screenshot." A server action is a POST with the session
 * attached and no URL to leak.
 *
 * 🔴 THE COST IS REAL AND IT IS BOUNDED ON PURPOSE. Base64 is a third
 * larger than the bytes and the whole thing crosses in one response, so
 * `MAX_EXPORT_ROWS` in the renderer is a limit that actually gets hit
 * rather than a comment.
 */

import { z } from "zod";

import { requirePermission, writeAudit } from "@/server/audit";
import { TenantAccessError } from "@/server/tenant-context";
import { PermissionDeniedError } from "@/lib/permissions";
import type { ActionResult } from "@/lib/validators/crm";

import {
  EXPORT_DATASETS,
  buildDataset,
  findDataset,
  type DatasetFilters,
} from "@/server/export/datasets";
import {
  ExportFormatUnavailableError,
  ExportTooLargeError,
  exportFileName,
  renderExport,
} from "@/server/export/render";
import {
  ExportNotRecordedError,
  listExports,
  personalColumnsOf,
  recordExportAndNotify,
  type ExportLogRow,
} from "@/server/export/log";
import {
  EXPORT_FORMATS,
  FORMAT_DESCRIPTORS,
  formatOptions,
  type ExportFormat,
} from "@/lib/export/registry";
import { ExportCellError } from "@/lib/export/values";
import { TallyExportUnavailable } from "@/lib/export/tally";
import type { Workbook } from "@/lib/export/types";

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function toActionError(err: unknown): ActionResult<never> {
  /**
   * ⭐ EACH OF THESE IS A SENTENCE THE PERSON CAN ACT ON, and collapsing
   * them into "something went wrong" is how a customer ends up filing a
   * support ticket about a limit that was already explained to them.
   */
  if (err instanceof ExportTooLargeError) return fail(err.message);
  if (err instanceof ExportFormatUnavailableError) return fail(err.message);
  if (err instanceof TallyExportUnavailable) return fail(err.message);
  if (err instanceof ExportNotRecordedError) return fail(err.message);
  if (err instanceof ExportCellError) return fail(err.message);
  if (err instanceof TenantAccessError) return fail(err.message);
  if (err instanceof PermissionDeniedError) return fail(err.message);
  if (err instanceof z.ZodError) return fail("That export request was not valid.");
  console.error("[export action]", err);
  return fail("The export could not be prepared. Please try again.");
}

/**
 * ⚠️ AN ISO DAY, NOT A `Date`. A string that reaches SQL as a bound
 * parameter and is refused before it gets there if it is not exactly ten
 * characters of date.
 */
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be written as YYYY-MM-DD.")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "That is not a real date.");

const runInput = z.object({
  datasetKey: z.string().min(1).max(64),
  format: z.enum(EXPORT_FORMATS),
  from: isoDay.optional(),
  to: isoDay.optional(),
});

/* ------------------------------------------------------------------ */
/* WHAT THIS PERSON MAY EXPORT                                         */
/* ------------------------------------------------------------------ */

export type ExportableDataset = {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly dated: boolean;
  readonly permission: string;
  readonly hasPersonalColumns: boolean;
};

/**
 * ⭐ THE CATALOGUE, FILTERED BY WHAT THIS PERSON MAY ACTUALLY TAKE.
 *
 * ⚠️ FILTERED, NOT GREYED OUT. A list of exports somebody cannot run,
 * shown to them by name, tells them what exists — which is a small
 * disclosure in itself and a support conversation about a button that
 * does nothing.
 */
export async function listExportableDatasets(): Promise<ActionResult<ExportableDataset[]>> {
  try {
    const allowed: ExportableDataset[] = [];
    for (const definition of EXPORT_DATASETS) {
      try {
        await requirePermission(definition.permission);
      } catch {
        continue;
      }
      allowed.push({
        key: definition.key,
        title: definition.title,
        description: definition.description,
        dated: definition.dated,
        permission: definition.permission,
        hasPersonalColumns: definition.columns.some((c) => c.personal),
      });
    }
    return { ok: true, data: allowed };
  } catch (err) {
    return toActionError(err);
  }
}

export type FormatChoice = {
  readonly id: ExportFormat;
  readonly label: string;
  readonly summary: string;
  readonly available: boolean;
  readonly reason?: string;
  readonly caution?: string;
};

/**
 * ⭐⭐ WHICH FORMATS THIS DATASET CAN BE TAKEN IN, AND WHAT EACH COSTS.
 *
 * 🔴 THIS RUNS THE QUERY WITH NO ROWS. Availability depends on the
 * dataset's SHAPE — its columns and its Tally mapping — not on its
 * contents, so the picker can be honest before anything is loaded. A
 * picker that offers a format and fails at the click is the thing this
 * avoids.
 */
export async function exportFormatsFor(
  datasetKey: string,
): Promise<ActionResult<FormatChoice[]>> {
  try {
    const definition = findDataset(datasetKey);
    if (!definition) return fail("That export does not exist.");
    await requirePermission(definition.permission);

    const probe: Workbook = {
      title: definition.title,
      generatedAt: new Date(0),
      datasets: [
        {
          key: definition.key,
          title: definition.title,
          columns: definition.columns,
          rows: [],
          notes: definition.notes,
          ...(definition.tally ? { tally: definition.tally } : {}),
        },
      ],
    };

    return {
      ok: true,
      data: formatOptions(probe).map((a) => ({
        id: a.format,
        label: FORMAT_DESCRIPTORS[a.format].label,
        summary: FORMAT_DESCRIPTORS[a.format].summary,
        available: a.available,
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.caution ? { caution: a.caution } : {}),
      })),
    };
  } catch (err) {
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* RUN IT                                                              */
/* ------------------------------------------------------------------ */

export type ExportPayload = {
  readonly fileName: string;
  readonly mediaType: string;
  /** The file, base64-encoded. See the header for why not a GET route. */
  readonly base64: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly notes: readonly string[];
  readonly includedPersonalData: boolean;
};

export async function runExport(input: unknown): Promise<ActionResult<ExportPayload>> {
  let ctx: Awaited<ReturnType<typeof requirePermission>> | null = null;
  let parsed: z.infer<typeof runInput> | null = null;

  try {
    parsed = runInput.parse(input);
    const definition = findDataset(parsed.datasetKey);
    if (!definition) return fail("That export does not exist.");

    ctx = await requirePermission(definition.permission);

    if (parsed.from && parsed.to && parsed.from > parsed.to) {
      return fail(
        `The period starts on ${parsed.from} and ends on ${parsed.to}. Nothing has been exported.`,
      );
    }
    if (!definition.dated && (parsed.from || parsed.to)) {
      /**
       * ⚠️ REFUSED RATHER THAN IGNORED. A person who set a date range and
       * received the whole table would have no way to tell, and would file
       * the file as if it were the period they asked for.
       */
      return fail(
        `"${definition.title}" is not a dated report — it is the current state, not a period. ` +
          `Remove the date range and export it again.`,
      );
    }

    const filters: DatasetFilters = {
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
    };

    const dataset = await buildDataset(definition, ctx.tenant.id, filters);
    const workbook: Workbook = {
      title: definition.title,
      generatedAt: new Date(),
      datasets: [dataset],
      context: {
        Workspace: ctx.tenant.name,
        ...(parsed.from || parsed.to
          ? { Period: `${parsed.from ?? "the beginning"} to ${parsed.to ?? "today"}` }
          : {}),
        "Exported by": ctx.user.email,
      },
    };

    const rendered = renderExport(workbook, parsed.format);
    const fileName = exportFileName(workbook, rendered);
    const personalColumns = personalColumnsOf(workbook);

    /**
     * 🔴 ⑤ — AND IT THROWS. See the header, and `server/export/log.ts`.
     */
    await recordExportAndNotify({
      tenantId: ctx.tenant.id,
      exportedBy: ctx.user.id,
      subject: definition.title,
      datasetKeys: [definition.key],
      format: parsed.format,
      rowCount: dataset.rows.length,
      byteCount: rendered.bytes.byteLength,
      includesPersonalData: personalColumns.length > 0,
      personalColumns,
      filters: { ...filters, format: parsed.format },
      notes: rendered.notes,
      outcome: "delivered",
    });

    /**
     * ⚠️ THE AUDIT ENTRY IS *AS WELL AS*, NOT INSTEAD OF. `audit_logs` is
     * where a reviewer looks for "what did this person do"; `data_exports`
     * is where they look for "what left the workspace". Both questions get
     * asked and they are not the same query.
     */
    await writeAudit(ctx, {
      action: "read",
      resourceType: "data_export",
      resourceId: definition.key,
      newValue: {
        format: parsed.format,
        rows: dataset.rows.length,
        personal: personalColumns.length > 0,
      },
      reason: `${definition.title} was exported as ${FORMAT_DESCRIPTORS[parsed.format].label}.`,
      severity: personalColumns.length > 0 ? "notice" : "info",
    });

    return {
      ok: true,
      data: {
        fileName,
        mediaType: rendered.mediaType,
        base64: Buffer.from(rendered.bytes).toString("base64"),
        rowCount: dataset.rows.length,
        byteCount: rendered.bytes.byteLength,
        notes: rendered.notes,
        includedPersonalData: personalColumns.length > 0,
      },
    };
  } catch (err) {
    /**
     * ⭐⭐ A REFUSAL IS ALSO A ROW. An export that was asked for and not
     * given is exactly what a later investigation wants to see — three
     * attempts at the customer master on somebody's last day is a pattern,
     * and a success-only log cannot show it.
     *
     * ⚠️ BEST-EFFORT, AND DELIBERATELY SO. We are already on the failure
     * path; a second failure here must not replace the first error with a
     * different one, because the person is owed the reason their export
     * did not happen.
     */
    if (ctx && parsed && !(err instanceof ExportNotRecordedError)) {
      const definition = findDataset(parsed.datasetKey);
      try {
        await recordExportAndNotify({
          tenantId: ctx.tenant.id,
          exportedBy: ctx.user.id,
          subject: definition?.title ?? parsed.datasetKey,
          datasetKeys: [parsed.datasetKey],
          format: parsed.format,
          rowCount: 0,
          byteCount: 0,
          includesPersonalData: false,
          personalColumns: [],
          filters: { from: parsed.from ?? null, to: parsed.to ?? null },
          notes: [],
          outcome: "refused",
          failureReason: err instanceof Error ? err.message.slice(0, 2000) : String(err),
        });
      } catch (loggingFailure) {
        console.error("[export action] could not record the refusal", loggingFailure);
      }
    }
    return toActionError(err);
  }
}

/* ------------------------------------------------------------------ */
/* THE LOG                                                             */
/* ------------------------------------------------------------------ */

export type ExportLogView = {
  readonly rows: readonly ExportLogRow[];
  readonly personalCount: number;
};

export async function getExportLog(input?: unknown): Promise<ActionResult<ExportLogView>> {
  try {
    const options = z
      .object({ personalOnly: z.boolean().optional(), limit: z.number().int().optional() })
      .optional()
      .parse(input);

    const ctx = await requirePermission("audit:read");
    const rows = await listExports(ctx.tenant.id, {
      ...(options?.personalOnly ? { personalOnly: true } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });

    return {
      ok: true,
      data: {
        rows,
        personalCount: rows.filter((r) => r.includesPersonalData).length,
      },
    };
  } catch (err) {
    return toActionError(err);
  }
}
