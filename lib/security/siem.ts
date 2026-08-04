/**
 * Ordence — SIEM Export Serialisers
 * Version: v0.12.0-alpha (Phase 20)
 *
 * ══════════════════════════════════════════════════════════════════════
 * NO VENDOR SDK. TWO TEXT FORMATS AND A HIGH-WATER MARK.
 * ══════════════════════════════════════════════════════════════════════
 * The temptation is a Splunk / Datadog / Sentinel client library. It is
 * refused for three reasons that apply to a security pipeline specifically:
 *
 *   1. IT PICKS THE CUSTOMER'S SIEM FOR THEM. Every enterprise buyer of a
 *      platform like this already has one, and it is not ours to choose. An
 *      NDJSON file on stdout or in a bucket is ingestible by all of them.
 *
 *   2. AN SDK IS A DEPENDENCY INSIDE THE SECURITY PATH. It ships its own
 *      transitive tree, its own network client and its own update cadence
 *      into the one subsystem whose integrity we are asserting. A serialiser
 *      that is a hundred lines of string building has no supply chain.
 *
 *   3. IT WOULD PUSH FROM A SERVERLESS FUNCTION. Which means retries,
 *      buffering and back-pressure inside a request lifecycle that can be
 *      frozen at any moment — i.e. a delivery guarantee we cannot honour.
 *      Pull-based export from a durable table is honest.
 *
 * TWO FORMATS:
 *   NDJSON — one JSON object per line. What every modern log pipeline wants.
 *   CEF    — ArcSight Common Event Format. Still what several bank and
 *            insurer SOCs require, and this product sells to firms that deal
 *            with both. It is a syntactically fussy format and the escaping
 *            rules are the entire difficulty; see `cefEscape`.
 *
 * This module is PURE — no database, no filesystem. It turns rows into text.
 * The caller decides where the text goes.
 */

import type { SecurityEventType, SecuritySeverity } from "./events";

/* ------------------------------------------------------------------ */
/* THE EXPORTABLE SHAPE                                                */
/* ------------------------------------------------------------------ */

/**
 * What an exporter feeds in. Structural, not the Drizzle row type — so this
 * module stays importable from a script with no database client, and so a
 * schema change cannot silently alter the wire format that a customer's SOC
 * has written parsing rules against.
 */
export type ExportableSecurityEvent = {
  id: string;
  eventType: SecurityEventType | string;
  severity: SecuritySeverity | string;
  tenantId: string | null;
  source: string;
  subjectType: string | null;
  subjectId: string | null;
  actorUserId: string | null;
  ipAddress: string | null;
  ipPrefix: string | null;
  requestId: string | null;
  route: string | null;
  country: string | null;
  occurrenceCount: number;
  detail: Record<string, unknown>;
  reason: string | null;
  occurredAt: Date;
  createdAt: Date;
};

/* ------------------------------------------------------------------ */
/* NDJSON                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serialise one event as a single NDJSON line.
 *
 * ⚠️ NEWLINES ARE STRIPPED FROM EVERY STRING VALUE, and that is a security
 * control rather than tidiness. NDJSON is line-delimited, so a value
 * containing a `\n` — say a `user-agent` an attacker chose — can terminate
 * the record early and let the remainder be parsed as a SECOND, fully
 * attacker-authored event. That is log injection: forging a
 * "severity: info, everything is fine" record inside the log that was
 * recording the attack. `JSON.stringify` escapes newlines correctly, so this
 * is already safe; the explicit strip below defends the case where someone
 * later "optimises" this function into template concatenation.
 */
export function toNdjsonLine(event: ExportableSecurityEvent): string {
  const record = {
    "@timestamp": event.occurredAt.toISOString(),
    ingested_at: event.createdAt.toISOString(),
    event: {
      id: event.id,
      kind: "alert",
      category: "security",
      type: event.eventType,
      severity: event.severity,
      count: event.occurrenceCount,
      reason: oneLine(event.reason),
      module: "ordence",
      dataset: "security_events",
    },
    // Multi-tenancy is a first-class dimension for a SOC — every rule they
    // write will want to scope, group or exclude by it.
    tenant: { id: event.tenantId },
    service: { name: "ordence", source: oneLine(event.source) },
    source: {
      ip: event.ipAddress,
      network: event.ipPrefix,
      geo: { country_iso_code: event.country },
    },
    user: { id: event.actorUserId },
    http: { request: { id: event.requestId }, route: oneLine(event.route) },
    target: { type: oneLine(event.subjectType), id: oneLine(event.subjectId) },
    // Already redacted on write by `sanitiseDetail()`. Not re-redacted here:
    // doing it twice invites the belief that either place alone is optional.
    labels: event.detail,
  };

  return JSON.stringify(record);
}

/** Serialise a batch. Trailing newline included — NDJSON files end with one. */
export function toNdjson(events: ExportableSecurityEvent[]): string {
  if (events.length === 0) return "";
  return events.map(toNdjsonLine).join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* CEF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * ArcSight severity is 0–10. Our four levels map onto it with gaps rather
 * than filling the range, so a future fifth level has somewhere to go without
 * renumbering rules a customer has already written.
 */
const CEF_SEVERITY: Record<string, number> = {
  info: 2,
  notice: 4,
  warning: 7,
  critical: 10,
};

/**
 * Escape a value for a CEF EXTENSION field (the `key=value` tail).
 *
 * The rules are unforgiving and getting them wrong is a parsing failure, not
 * a cosmetic one: `=` and `\` must be escaped, and a literal newline
 * TERMINATES THE EVENT. An unescaped newline in a user-agent would therefore
 * split one record into two and let the attacker author the second — the same
 * log-injection attack described above, and CEF is more vulnerable to it than
 * NDJSON because there is no quoting mechanism to fall back on.
 */
export function cefEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/[\r\n]+/g, " ");
}

/**
 * Escape a value for the CEF HEADER (the pipe-delimited prefix).
 * Different rules from the extension: here `|` is the delimiter and `=` is
 * ordinary. Using one escaper for both is the classic CEF bug.
 */
export function cefHeaderEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/**
 * Serialise one event as a CEF line.
 *
 * Header: CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extension
 *
 * The signature id is our event type verbatim. A SOC writes correlation rules
 * against that string, so it is part of a compatibility contract — which is
 * the second reason `SECURITY_EVENT_TYPES` is a closed set that changes only
 * by migration.
 */
export function toCefLine(event: ExportableSecurityEvent): string {
  const header = [
    "CEF:0",
    "Ordence",
    "Ordence",
    "0.12",
    cefHeaderEscape(String(event.eventType)),
    cefHeaderEscape(event.reason ?? String(event.eventType)),
    String(CEF_SEVERITY[String(event.severity)] ?? 4),
  ].join("|");

  const extension: Array<[string, string | null]> = [
    ["rt", String(event.occurredAt.getTime())],
    ["externalId", event.id],
    ["src", event.ipAddress],
    ["cs1Label", "tenantId"],
    ["cs1", event.tenantId],
    ["cs2Label", "source"],
    ["cs2", event.source],
    ["cs3Label", "subject"],
    ["cs3", event.subjectId ? `${event.subjectType ?? "subject"}:${event.subjectId}` : null],
    ["cs4Label", "requestId"],
    ["cs4", event.requestId],
    ["cn1Label", "occurrenceCount"],
    ["cn1", String(event.occurrenceCount)],
    ["suid", event.actorUserId],
    ["request", event.route],
    ["cs5Label", "detail"],
    // Detail is nested; CEF has no nested type, so it goes in as compact JSON.
    ["cs5", Object.keys(event.detail).length > 0 ? JSON.stringify(event.detail) : null],
  ];

  const tail = extension
    .filter((pair): pair is [string, string] => pair[1] !== null && pair[1] !== "")
    .map(([k, v]) => `${k}=${cefEscape(v)}`)
    .join(" ");

  return `${header}|${tail}`;
}

export function toCef(events: ExportableSecurityEvent[]): string {
  if (events.length === 0) return "";
  return events.map(toCefLine).join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* EXPORT CURSOR                                                       */
/* ------------------------------------------------------------------ */

export type SiemFormat = "ndjson" | "cef";

export function serialiseForSiem(
  events: ExportableSecurityEvent[],
  format: SiemFormat,
): string {
  return format === "cef" ? toCef(events) : toNdjson(events);
}

/**
 * Compute the cursor for the next export batch.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY A HIGH-WATER MARK AND NOT AN `exported_at` FLAG
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design — `UPDATE security_events SET exported_at = now()` after
 * shipping — requires UPDATE on an APPEND-ONLY table. Granting it, or adding
 * a trigger exception for "just this one column", reopens the table to
 * modification in general: the exception is a general UPDATE path that a
 * later change will reuse for something else. The append-only guarantee is
 * worth more than the convenience.
 *
 * So the exporter keeps a cursor (`created_at`, `id`) OUTSIDE the table and
 * asks for rows after it. The tuple, not the timestamp alone: two rows can
 * share a millisecond, and a timestamp-only cursor either skips one of them
 * (evidence lost) or repeats it forever (the export loops). Ordering by
 * `(created_at, id)` and comparing the pair is exact.
 *
 * ⚠️ AT-LEAST-ONCE, NOT EXACTLY-ONCE. If the shipment succeeds and the cursor
 * write fails, the next run re-sends the batch. That is the correct direction
 * for security telemetry — a duplicate alert is noise a SOC deduplicates on
 * `externalId`, a missing one is an attack nobody saw.
 */
export type SiemCursor = { createdAt: Date; id: string } | null;

export function nextSiemCursor(
  events: ExportableSecurityEvent[],
  previous: SiemCursor,
): SiemCursor {
  if (events.length === 0) return previous;

  let best = events[0]!;
  for (const event of events) {
    if (
      event.createdAt.getTime() > best.createdAt.getTime() ||
      (event.createdAt.getTime() === best.createdAt.getTime() && event.id > best.id)
    ) {
      best = event;
    }
  }

  return { createdAt: best.createdAt, id: best.id };
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/** Collapse newlines. See the log-injection note on `toNdjsonLine`. */
function oneLine(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[\r\n]+/g, " ");
}
