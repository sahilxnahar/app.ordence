import "server-only";

/**
 * Ordence — ⭐⭐⭐ RECORDING THAT AN EXPORT HAPPENED
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ORDER MATTERS MORE THAN THE CONTENT
 * ══════════════════════════════════════════════════════════════════════
 * The row is written BEFORE the bytes are returned to the caller, inside
 * the same tenant scope, and a failure to write it FAILS THE EXPORT.
 *
 * ⚠️ THAT IS THE OPPOSITE OF `writeAudit`, WHICH NEVER THROWS — and the
 * difference is deliberate. An audit record of an update is a record of
 * something that already happened and cannot be undone; swallowing its
 * failure loses history but does not change the world. An export log is
 * written before the disclosure, and swallowing its failure produces the
 * one outcome nobody can live with: the customer has the file and there
 * is no record that anybody took it.
 *
 * ⭐ SO IF WE CANNOT RECORD IT, WE DO NOT DO IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND A REFUSAL IS ALSO A ROW
 * ══════════════════════════════════════════════════════════════════════
 * `outcome: 'refused'` records an export that was asked for and not
 * given — over the row ceiling, a format the data cannot carry, a
 * permission the person did not have. A log that only contains successes
 * cannot tell you that somebody tried to take the whole customer master
 * three times on their last day.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { dataExports } from "@/db/schema/dpdp";
import { recordSecurityEvent } from "@/server/security/record";
import { isBulkExport, isOffHoursIst, BULK_EXPORT_RECORDS } from "@/lib/security/hours";
import type { ExportFormat } from "@/lib/export/registry";
import type { Workbook } from "@/lib/export/types";

export type ExportLogEntry = {
  readonly tenantId: string;
  readonly exportedBy: string;
  readonly subject: string;
  readonly datasetKeys: readonly string[];
  readonly format: ExportFormat;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly includesPersonalData: boolean;
  readonly personalColumns: readonly string[];
  readonly filters: Readonly<Record<string, unknown>>;
  readonly notes: readonly string[];
  readonly outcome: "delivered" | "refused" | "failed";
  readonly failureReason?: string | null;
};

export class ExportNotRecordedError extends Error {
  constructor(cause: unknown) {
    super(
      `The export was built but could not be recorded, so it has not been released. Ordence keeps ` +
        `a record of every export of workspace data — who ran it, what it contained and whether ` +
        `personal data was in it — and handing over a file it cannot account for is the one ` +
        `failure it will not accept. Try again; if this persists it is a fault on our side. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "ExportNotRecordedError";
  }
}

/**
 * ⭐ WHICH EXPORTED COLUMNS WERE PERSONAL, BY LABEL.
 *
 * ⚠️ THE LABELS AND NOT THE KEYS. `pan` is a key; "PAN" is what the
 * breach notification under s.8(6) has to say, and what a person reading
 * the export log recognises as their own data.
 */
export function personalColumnsOf(workbook: Workbook): string[] {
  const labels = new Set<string>();
  for (const dataset of workbook.datasets) {
    for (const column of dataset.columns) {
      if (column.personal) labels.add(column.label);
    }
  }
  return [...labels].sort();
}

/**
 * ⚠️ WRITES INSIDE `withTenant`, SO RLS IS IN FORCE. The `tenant_id` in
 * the values is not the security boundary — the policy is — it is there
 * because the column is NOT NULL.
 */
export async function recordExport(entry: ExportLogEntry): Promise<string> {
  try {
    return await withTenant(entry.tenantId, async (tx) => {
      const [row] = await tx
        .insert(dataExports)
        .values({
          tenantId: entry.tenantId,
          exportedBy: entry.exportedBy,
          subject: entry.subject.slice(0, 120),
          datasetKeys: [...entry.datasetKeys],
          format: entry.format,
          rowCount: entry.rowCount,
          byteCount: entry.byteCount,
          includesPersonalData: entry.includesPersonalData,
          personalColumns: [...entry.personalColumns],
          filters: entry.filters as Record<string, unknown>,
          notes: [...entry.notes],
          outcome: entry.outcome,
          failureReason: entry.failureReason ?? null,
        })
        .returning({ id: dataExports.id });

      if (!row) {
        throw new Error("the insert returned no row");
      }
      return row.id;
    });
  } catch (cause) {
    throw new ExportNotRecordedError(cause);
  }
}

/**
 * ⭐ WAVE 9 — RECORD, THEN TELL SECOPS. ONE DOOR.
 *
 * ⚠️ THE SECURITY EVENT IS EMITTED FROM HERE AND NOT FROM
 * `server/actions/export.ts`, even though the action is the only caller
 * today. The reason is the defect this whole wave exists to remove: an
 * emission at the call site is a line the NEXT export path forgets, and
 * the next export path is the one that matters — a scheduled report, a
 * bulk download, an API export. `recordExport` is already mandatory (it
 * throws, and the bytes are not released without it), so hanging the
 * security event off it makes the two impossible to separate.
 *
 * ⚠️ AFTER the log row commits, never before, and inside its own
 * try/catch. The ordering is the same argument the file header makes: the
 * disclosure record comes first because it is the one that must exist.
 */
export async function recordExportAndNotify(entry: ExportLogEntry): Promise<string> {
  const id = await recordExport(entry);

  try {
    await noteExportInSecurityStream(entry, new Date());
  } catch (err) {
    /*
     * Telemetry about a disclosure that is already fully recorded must
     * not be able to undo the disclosure. `onSecurityRecordFailure`
     * escalates the write failure itself; this catch is for anything the
     * recorder does not already own.
     */
    console.error("[export] could not note the export in the security stream", err);
  }

  return id;
}

/* ------------------------------------------------------------------ */
/* WAVE 9 — THE SECURITY STREAM, WHICH IS NOT THE EXPORT LOG           */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ TELL THE SECURITY STREAM THAT DATA LEFT THE WORKSPACE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `export.bulk` AND `export.off_hours` HAD NEVER BEEN EMITTED
 * ══════════════════════════════════════════════════════════════════════
 * Both types have been in `lib/security/events.ts` since Phase 20, with
 * severities, labels and SIEM mappings. Wave 5 then built the whole export
 * engine — six formats, a permission per dataset, a log that fails the
 * export if it cannot be written — and did not emit either of them,
 * because `data_exports` felt like the record and it is: of WHO TOOK
 * WHAT. It is not the record a security reviewer reads, and the two
 * streams are separated on purpose (see the header of
 * `lib/security/events.ts`).
 *
 * The concrete cost: `detectOffHoursBulkExport` filters observations by
 * `eventType.startsWith("export.")`. With nothing emitting an `export.*`
 * event, the rule ran on every scheduled sweep, examined zero rows and
 * reported nothing — for every input, forever. A detector that cannot
 * fire looks exactly like a quiet month.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY ONLY A DELIVERED EXPORT
 * ══════════════════════════════════════════════════════════════════════
 * `refused` and `failed` disclosed nothing. They are already rows in
 * `data_exports` with their reason, and a refused attempt by somebody
 * without the permission has ALSO written to `permission_denials`, which
 * is what `detectDenialSpike` reads. Putting refusals in the security
 * stream too would count the same event in three places and let the
 * off-hours correlation fire on somebody who received no data at all.
 *
 * ⚠️ IT CANNOT FAIL THE EXPORT, AND THAT IS THE OPPOSITE RULE TO THE ONE
 * ABOVE IT. `recordExport` throws if it cannot write, because releasing
 * bytes with no record of the disclosure is unacceptable. This function
 * is telemetry ABOUT a disclosure that has already been recorded in full;
 * failing the export because SecOps telemetry is unavailable would take
 * the product down for a reason the customer cannot act on. A failure
 * here goes to `onSecurityRecordFailure`, which alerts (wave 9,
 * `server/security/alerting.ts`).
 */
export async function noteExportInSecurityStream(entry: ExportLogEntry, at: Date): Promise<void> {
  if (entry.outcome !== "delivered") return;

  const bulk = isBulkExport(entry.rowCount);
  const offHours = isOffHoursIst(at);
  if (!bulk && !offHours) return;

  /**
   * ⚠️ TWO EVENTS AND NOT ONE COMBINED TYPE. The catalogue declares
   * `export.bulk` (notice) and `export.off_hours` (warning) separately,
   * and an export can be either without being both. The CORRELATION —
   * large AND out of hours, the departing-employee signature — is the
   * detector's job, and it can only do that job if both facts arrive as
   * facts rather than as one pre-judged row.
   */
  const common = {
    tenantId: entry.tenantId,
    source: "export",
    subjectType: "export",
    subjectId: entry.subject.slice(0, 120),
    actorUserId: entry.exportedBy,
    detail: {
      /**
       * ⚠️ `rowCount` IN THE DETAIL, NOT IN `occurrenceCount`. The
       * recorder owns `occurrence_count` and increments it when it
       * coalesces; a row count written there would be overwritten by the
       * next export inside the ten-second window. See
       * `lib/security/hours.ts` for the rule this broke.
       */
      rowCount: entry.rowCount,
      byteCount: entry.byteCount,
      format: entry.format,
      datasets: [...entry.datasetKeys],
      includesPersonalData: entry.includesPersonalData,
      /** Labels, never values — the same rule the export log follows. */
      personalColumns: [...entry.personalColumns],
      bulkThreshold: BULK_EXPORT_RECORDS,
    },
  } as const;

  if (bulk) {
    await recordSecurityEvent({
      ...common,
      type: "export.bulk",
      reason: `${entry.rowCount} records exported as ${entry.format}.`,
    });
  }

  if (offHours) {
    await recordSecurityEvent({
      ...common,
      type: "export.off_hours",
      reason: `Export run outside working hours (${entry.rowCount} records).`,
    });
  }
}

export type ExportLogRow = {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorName: string;
  readonly subject: string;
  readonly format: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly includesPersonalData: boolean;
  readonly personalColumns: readonly string[];
  readonly outcome: string;
  readonly failureReason: string | null;
  readonly notes: readonly string[];
};

/**
 * ⭐ THE LOG, NEWEST FIRST. This is the screen that answers "what left
 * the workspace", and it is the reason the table is worth having.
 */
export async function listExports(
  tenantId: string,
  options: { readonly limit?: number; readonly personalOnly?: boolean } = {},
): Promise<ExportLogRow[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  return withTenant(tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT e.id,
             e.occurred_at,
             coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email)
               AS actor_name,
             e.subject,
             e.format,
             e.row_count,
             e.byte_count,
             e.includes_personal_data,
             e.personal_columns,
             e.outcome,
             e.failure_reason,
             e.notes
        FROM data_exports e
        LEFT JOIN users u ON u.id = e.exported_by
       WHERE ${options.personalOnly ? sql`e.includes_personal_data` : sql`true`}
       ORDER BY e.occurred_at DESC
       LIMIT ${limit}
    `);

    /**
     * ⚠️ THE DRIVER RETURNS EITHER AN ARRAY OR `{ rows }` DEPENDING ON
     * WHICH ONE IS IN USE — `@neondatabase/serverless` in production and
     * `pg` in the drills and tests. `server/sales/references.ts` learned
     * this the hard way; reading `.rows` unconditionally yields undefined
     * under one of them and the screen shows an empty log, which is the
     * most dangerous possible way for THIS screen to be wrong.
     */
    const list = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : (((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]);

    return list.map((r) => ({
      id: String(r.id),
      occurredAt: new Date(r.occurred_at as string | Date),
      actorName: (r.actor_name as string | null) ?? "a user who has since been removed",
      subject: String(r.subject),
      format: String(r.format),
      rowCount: Number(r.row_count),
      /**
       * ⚠️ `byte_count` IS A `bigint` IN POSTGRES AND ARRIVES AS A STRING,
       * because a bigint does not fit a double. The cast is safe here — a
       * nine-petabyte export is not a thing — and it is done explicitly
       * rather than left to a `+` somewhere in the JSX.
       */
      byteCount: Number(r.byte_count),
      includesPersonalData: Boolean(r.includes_personal_data),
      personalColumns: (r.personal_columns as string[] | null) ?? [],
      outcome: String(r.outcome),
      failureReason: (r.failure_reason as string | null) ?? null,
      notes: (r.notes as string[] | null) ?? [],
    }));
  });
}
