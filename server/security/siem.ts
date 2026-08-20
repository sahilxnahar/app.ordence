import "server-only";

/**
 * Ordence — The SIEM exporter: the first caller lib/security/siem.ts ever had
 * Version: v1.82.0-alpha (Wave 14 · Track B)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT WAS ACTUALLY WRONG, AND IT IS NOT WHAT THE BRIEF SAID
 * ══════════════════════════════════════════════════════════════════════
 * Track B's brief says `server/security/siem.ts` "was built, reviewed,
 * tested, and has no callers at all". The first half is wrong and the
 * second half is right, which is a combination worth being precise about.
 *
 * There was no `server/security/siem.ts`. THIS file is new. What exists —
 * and what genuinely has no callers — is `lib/security/siem.ts`: 290
 * lines of NDJSON and CEF serialisers, a CEF severity map, a log-
 * injection defence, an export cursor, and 38 assertions in
 * `tests/ui/security-events.test.tsx` proving all of it correct.
 *
 * Verified by grep at v1.81.0-alpha: outside its own file, the only
 * reference in the whole tree is `scripts/check-security-events.mjs`
 * naming it as a file to EXCLUDE from a census. A wire format with no
 * wire, a cursor with nothing to advance, and a customer-facing
 * capability whose honest answer was no.
 *
 * ⭐ THIS FILE IS THE WIRE. It does not reimplement any of it: every byte
 * that leaves goes through `serialiseForSiem()` and every cursor comes
 * from `nextSiemCursor()`, both imported from `lib/security/siem.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TWO EXPORTS, TWO SCOPES, AND THE DIFFERENCE IS THE WHOLE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 *   exportForSiem()          platform-scoped. Every workspace. For our own
 *                            SOC feed. Cursor-resumable.
 *   exportTenantReview()     TENANT-scoped. One workspace, and the
 *                            filtering is done by ROW-LEVEL SECURITY, not
 *                            by a WHERE clause.
 *
 * 🔴 THE SECOND ONE IS THE ONE THAT COULD LEAK, so it is the one that
 * does not get to be trusted. `security_event_stream` is created `WITH
 * (security_invoker = true)` in SQL 0134 precisely so that a read inside
 * `withTenant(id)` returns that workspace's rows and nothing else, even
 * if the query is wrong. A `WHERE tenant_id = $1` would be one typo away
 * from handing Acme's security review to Beta Ltd, and the typo would
 * produce a plausible-looking file rather than an error.
 *
 * ══════════════════════════════════════════════════════════════════════
 * AT-LEAST-ONCE, AND THE CURSOR IS COMMITTED SEPARATELY ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * `exportForSiem()` reads and serialises. `commitSiemCursor()` advances
 * the high-water mark. They are two calls because the caller is the only
 * thing that knows whether the bytes actually arrived somewhere.
 *
 * Advancing the cursor inside the read would make the export
 * at-most-once: a shipment that failed after the cursor moved is evidence
 * nobody will ever see again. The other direction — a duplicate batch — is
 * noise a SOC deduplicates on event id, which is why every record carries
 * one.
 */

import {
  serialiseForSiem,
  nextSiemCursor,
  type ExportableSecurityEvent,
  type SiemCursor,
  type SiemFormat,
} from "@/lib/security/siem";

/* ================================================================== */
/* PLUMBING                                                            */
/* ================================================================== */

type Row = Record<string, unknown>;
import type { withPlatformScope } from "@/db";

/**
 * The transaction handle type, derived from `withPlatformScope` rather
 * than named, so it cannot drift from the real one. Same trick as
 * `server/metering/record.ts`, `server/security/record.ts` and
 * `server/billing/audit-billing.ts`.
 *
 * ⚠️ `import type`, SO THERE IS NO RUNTIME IMPORT OF `@/db`. That matters
 * here for the reason `server/metering/record.ts` states about its own:
 * `db/index.ts` validates the environment while constructing its client,
 * so a value import would mean merely importing this module can throw —
 * and these modules are imported from the surfaces they must never break.
 */
type TxLike = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

function rowsOf(result: unknown): Row[] {
  const r = (result as { rows?: Row[] })?.rows;
  if (Array.isArray(r)) return r;
  return Array.isArray(result) ? (result as Row[]) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  /**
   * ⚠️ THE EPOCH, NOT `new Date()`. A row whose timestamp could not be
   * parsed must not be stamped with the time it was exported: that would
   * put it at the right-hand edge of every chart in the customer's SOC
   * and, worse, would move the export cursor past every row behind it.
   */
  return new Date(0);
}

/** Map one `security_event_stream` row onto the exporter's wire type. */
function toExportable(row: Row): ExportableSecurityEvent {
  const detail = row.detail;
  return {
    // ⚠️ `<source_table>:<uuid>`, from the view. Two rows in two tables can
    // share a uuid, and the cursor breaks same-millisecond ties by comparing
    // ids — an ambiguous id there skips a row or repeats it forever.
    id: str(row.stream_id) ?? "unknown",
    eventType: str(row.event_type) ?? "unknown",
    severity: str(row.severity) ?? "info",
    tenantId: str(row.tenant_id),
    source: str(row.event_source) ?? "ordence",
    subjectType: str(row.subject_type),
    subjectId: str(row.subject_id),
    actorUserId: str(row.actor_user_id),
    ipAddress: str(row.ip_address),
    ipPrefix: str(row.ip_prefix),
    requestId: str(row.request_id),
    route: str(row.route),
    country: str(row.country),
    occurrenceCount:
      typeof row.occurrence_count === "number"
        ? row.occurrence_count
        : Number(row.occurrence_count ?? 1) || 1,
    detail:
      detail && typeof detail === "object" && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : {},
    reason: str(row.reason),
    occurredAt: toDate(row.occurred_at),
    createdAt: toDate(row.recorded_at),
  };
}

const MAX_BATCH = 5_000;

/* ================================================================== */
/* AVAILABILITY                                                        */
/* ================================================================== */

export type StreamAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Is the stream there at all?
 *
 * ⚠️ ASKED, NOT ASSUMED. This zip's SQL may be applied after its code, and
 * a query against a missing view throws a Postgres error whose message is
 * the least useful sentence available to an operator. "SQL-FILES/0134 has
 * not been applied" is the useful one.
 */
export async function siemStreamAvailability(): Promise<StreamAvailability> {
  try {
    const { withPlatformScope } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const present = await withPlatformScope(
      "siem export: confirm the audit event stream exists before reading it",
      async (tx: TxLike) => {
        const r = await tx.execute(
          sql`SELECT to_regclass('public.security_event_stream') IS NOT NULL AS present,
                     to_regclass('public.siem_export_cursors')  IS NOT NULL AS cursors`,
        );
        return rowsOf(r)[0];
      },
    );
    if (present?.present !== true) {
      return { available: false, reason: "SQL-FILES/0134 has not been applied: security_event_stream does not exist." };
    }
    if (present?.cursors !== true) {
      return { available: false, reason: "SQL-FILES/0134 has not been applied: siem_export_cursors does not exist." };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.name : "the database could not be reached",
    };
  }
}

/* ================================================================== */
/* PLATFORM EXPORT                                                     */
/* ================================================================== */

export type SiemExportResult = {
  destination: string;
  format: SiemFormat;
  events: ExportableSecurityEvent[];
  /** The serialised bytes. NDJSON or CEF, exactly as lib/security/siem.ts writes them. */
  payload: string;
  /** Where the cursor SHOULD move to once the bytes have landed. Not yet committed. */
  nextCursor: SiemCursor;
  previousCursor: SiemCursor;
  /** True when the batch filled — there is more waiting. */
  more: boolean;
};

/**
 * Read the next batch for a destination and serialise it.
 *
 * Does NOT advance the cursor. See the header.
 */
export async function exportForSiem(options: {
  destination: string;
  format?: SiemFormat;
  batchSize?: number;
}): Promise<SiemExportResult | { error: string }> {
  const destination = sanitiseDestination(options.destination);
  if (!destination) return { error: "destination must be a short symbolic name" };

  const format: SiemFormat = options.format === "cef" ? "cef" : "ndjson";
  const batchSize = Math.min(Math.max(Math.round(options.batchSize ?? 500), 1), MAX_BATCH);

  const availability = await siemStreamAvailability();
  if (!availability.available) return { error: availability.reason };

  try {
    const { withPlatformScope } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    const result = await withPlatformScope(
      "siem export: read the audit event stream across every workspace for the security feed",
      async (tx: TxLike) => {
        const cursorRow = rowsOf(
          await tx.execute(sql`
            SELECT cursor_created_at, cursor_id
              FROM siem_export_cursors
             WHERE destination = ${destination}
          `),
        )[0];

        const previousCursor: SiemCursor =
          cursorRow && cursorRow.cursor_created_at && cursorRow.cursor_id
            ? { createdAt: toDate(cursorRow.cursor_created_at), id: String(cursorRow.cursor_id) }
            : null;

        /**
         * ⚠️ THE TUPLE COMPARISON `(recorded_at, stream_id) > ($1, $2)`,
         * NOT `recorded_at > $1`.
         *
         * A timestamp-only cursor has two failure modes and both are silent.
         * `>` skips every other row that shares the last millisecond —
         * evidence gone, no error. `>=` re-sends the last row forever — the
         * export never advances and the feed looks busy. Postgres compares
         * row constructors lexicographically, which is exactly the ordering
         * `nextSiemCursor()` computes.
         */
        const batch = previousCursor
          ? await tx.execute(sql`
              SELECT * FROM security_event_stream
               WHERE (recorded_at, stream_id) > (${previousCursor.createdAt.toISOString()}::timestamptz, ${previousCursor.id})
               ORDER BY recorded_at ASC, stream_id ASC
               LIMIT ${batchSize}
            `)
          : await tx.execute(sql`
              SELECT * FROM security_event_stream
               ORDER BY recorded_at ASC, stream_id ASC
               LIMIT ${batchSize}
            `);

        return { previousCursor, rows: rowsOf(batch) };
      },
    );

    const events = result.rows.map(toExportable);

    return {
      destination,
      format,
      events,
      // ⭐ THE CALL THAT DID NOT EXIST. Every byte goes through the module
      // that was written for this and never used.
      payload: serialiseForSiem(events, format),
      nextCursor: nextSiemCursor(events, result.previousCursor),
      previousCursor: result.previousCursor,
      more: events.length === batchSize,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : "export failed" };
  }
}

/**
 * Move the high-water mark, AFTER the bytes have landed somewhere.
 *
 * ⚠️ IT REFUSES TO MOVE BACKWARDS. A caller that commits an old cursor —
 * a retry arriving late, two exporters racing — would otherwise re-send
 * everything since that point on the next run, forever. The `GREATEST`
 * comparison is in SQL rather than in JavaScript because two instances
 * can be doing this at the same moment.
 */
export async function commitSiemCursor(args: {
  destination: string;
  format?: SiemFormat;
  cursor: SiemCursor;
  exported: number;
  error?: string | null;
}): Promise<boolean> {
  const destination = sanitiseDestination(args.destination);
  if (!destination) return false;
  if (!args.cursor) return false;

  try {
    const { withPlatformScope } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    await withPlatformScope(
      "siem export: advance the export high-water mark after a batch was delivered",
      async (tx: TxLike) => {
        await tx.execute(sql`
          INSERT INTO siem_export_cursors (
            destination, format, cursor_created_at, cursor_id,
            last_exported_at, exported_total, last_error, updated_at
          ) VALUES (
            ${destination},
            ${args.format === "cef" ? "cef" : "ndjson"},
            ${args.cursor!.createdAt.toISOString()}::timestamptz,
            ${args.cursor!.id},
            now(),
            ${Math.max(0, Math.round(args.exported))},
            ${args.error ? String(args.error).slice(0, 500) : null},
            now()
          )
          ON CONFLICT (destination) DO UPDATE SET
            format            = excluded.format,
            cursor_created_at = GREATEST(siem_export_cursors.cursor_created_at, excluded.cursor_created_at),
            cursor_id         = CASE
                                  WHEN excluded.cursor_created_at > siem_export_cursors.cursor_created_at
                                    OR (excluded.cursor_created_at = siem_export_cursors.cursor_created_at
                                        AND excluded.cursor_id > siem_export_cursors.cursor_id)
                                  THEN excluded.cursor_id
                                  ELSE siem_export_cursors.cursor_id
                                END,
            last_exported_at  = now(),
            exported_total    = siem_export_cursors.exported_total + excluded.exported_total,
            last_error        = excluded.last_error,
            updated_at        = now()
        `);
      },
    );
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== */
/* TENANT SECURITY REVIEW                                              */
/* ================================================================== */

export type TenantReview = {
  tenantId: string;
  format: SiemFormat;
  events: ExportableSecurityEvent[];
  payload: string;
  from: Date;
  to: Date;
  truncated: boolean;
};

/**
 * One workspace's own security record, for their security review.
 *
 * 🔴 READ INSIDE `withTenant(tenantId)`, AND THE FILTERING IS DONE BY
 * ROW-LEVEL SECURITY RATHER THAN BY THE QUERY. There is no
 * `WHERE tenant_id = ...` below and that omission is deliberate: the view
 * is `security_invoker`, so Postgres applies each underlying table's
 * policy to THIS transaction's tenant. A query filter would be one typo
 * away from handing one customer another customer's security history, and
 * the typo would produce a plausible file rather than an error.
 *
 * ⚠️ THE PLATFORM BRANCHES DISAPPEAR AUTOMATICALLY, which is correct:
 * `platform_action_log` has no tenant column and its policy is
 * platform-only, so our staff register is simply not in a customer's
 * export. Their own impersonation SESSIONS are, because those are rows
 * about them and they are entitled to every one.
 */
export async function exportTenantReview(options: {
  tenantId: string;
  format?: SiemFormat;
  fromDays?: number;
  limit?: number;
}): Promise<TenantReview | { error: string }> {
  const format: SiemFormat = options.format === "cef" ? "cef" : "ndjson";
  const fromDays = Math.min(Math.max(Math.round(options.fromDays ?? 90), 1), 730);
  const limit = Math.min(Math.max(Math.round(options.limit ?? 5_000), 1), MAX_BATCH);

  const availability = await siemStreamAvailability();
  if (!availability.available) return { error: availability.reason };

  try {
    const { withTenant } = await import("@/db");
    const { sql } = await import("drizzle-orm");

    const to = new Date();
    const from = new Date(to.getTime() - fromDays * 24 * 60 * 60 * 1_000);

    const rows = await withTenant(options.tenantId, async (tx) => {
      const r = await tx.execute(sql`
        SELECT * FROM security_event_stream
         WHERE occurred_at >= ${from.toISOString()}::timestamptz
         ORDER BY occurred_at DESC, stream_id DESC
         LIMIT ${limit}
      `);
      return rowsOf(r);
    });

    const events = rows.map(toExportable);

    return {
      tenantId: options.tenantId,
      format,
      events,
      payload: serialiseForSiem(events, format),
      from,
      to,
      /**
       * ⚠️ SAID OUT LOUD. An export that silently stopped at the cap is a
       * file a customer will read as "this is everything", which is the
       * exact sentence 0116's header warns about.
       */
      truncated: events.length === limit,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 300) : "review export failed" };
  }
}

/* ================================================================== */
/* SUMMARY FOR THE CONSOLE                                             */
/* ================================================================== */

export type StreamSummary = {
  available: boolean;
  reason?: string;
  bySource: { sourceTable: string; events: number; latest: Date | null }[];
  destinations: {
    destination: string;
    format: string;
    exportedTotal: number;
    lastExportedAt: Date | null;
    lastError: string | null;
    /** How many rows are waiting behind the cursor. */
    pending: number | null;
  }[];
};

export async function summariseStream(windowDays = 30): Promise<StreamSummary> {
  const availability = await siemStreamAvailability();
  if (!availability.available) {
    return { available: false, reason: availability.reason, bySource: [], destinations: [] };
  }

  try {
    const { withPlatformScope } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    const days = Math.min(Math.max(Math.round(windowDays), 1), 365);

    return await withPlatformScope(
      "siem export: summarise the audit event stream and the state of each export feed",
      async (tx: TxLike) => {
        const bySource = rowsOf(
          await tx.execute(sql`
            SELECT source_table, count(*)::int AS events, max(recorded_at) AS latest
              FROM security_event_stream
             WHERE recorded_at >= now() - make_interval(days => ${days})
             GROUP BY source_table
             ORDER BY 2 DESC
          `),
        ).map((r) => ({
          sourceTable: str(r.source_table) ?? "unknown",
          events: Number(r.events ?? 0) || 0,
          latest: r.latest ? toDate(r.latest) : null,
        }));

        const destinations = rowsOf(
          await tx.execute(sql`
            SELECT c.destination, c.format, c.exported_total, c.last_exported_at, c.last_error,
                   (SELECT count(*) FROM security_event_stream s
                     WHERE c.cursor_created_at IS NULL
                        OR (s.recorded_at, s.stream_id) > (c.cursor_created_at, c.cursor_id))::int AS pending
              FROM siem_export_cursors c
             ORDER BY c.destination
          `),
        ).map((r) => ({
          destination: str(r.destination) ?? "",
          format: str(r.format) ?? "ndjson",
          exportedTotal: Number(r.exported_total ?? 0) || 0,
          lastExportedAt: r.last_exported_at ? toDate(r.last_exported_at) : null,
          lastError: str(r.last_error),
          pending: typeof r.pending === "number" ? r.pending : Number(r.pending ?? 0) || 0,
        }));

        return { available: true, bySource, destinations };
      },
    );
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.name : "the stream could not be summarised",
      bySource: [],
      destinations: [],
    };
  }
}

/* ================================================================== */
/* HELPERS                                                             */
/* ================================================================== */

/**
 * ⚠️ A DESTINATION NAME IS A PRIMARY KEY AND A LABEL, NOT FREE TEXT. It
 * ends up in a jsonb detail bag, in a log line and in a chat message.
 */
function sanitiseDestination(value: string): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(cleaned) ? cleaned : null;
}
