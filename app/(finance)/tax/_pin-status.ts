import "server-only";

/**
 * Ordence — ⭐ READING `gst_rate_pin_status`, THE RATE-PIN WORKLIST
 * Wave 15 / Track E — GST, TDS and statutory correctness
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS FILE IS IN THE WRONG DIRECTORY AND KNOWS IT
 * ══════════════════════════════════════════════════════════════════════
 * It belongs at `server/tax/pin-status.ts`, next to `server/tax/audit.ts`,
 * which is the reader for the sibling table. It sits under
 * `app/(finance)/` because Track E's delivery block is `app/(finance)/**`
 * and integration mechanically refuses a write outside it.
 *
 * ⭐ MOVING IT IS REQUESTED IN PATCH-REQUEST-E.md, and the move is a
 * rename plus an import fix — nothing here depends on being under `app/`.
 * Two things follow from where it currently sits and both are costs:
 *
 *   · the private row-shape helpers at the bottom are a SECOND COPY of
 *     the ones in `server/tax/audit.ts`, which are not exported. Two
 *     copies of "which driver shape did we get back" is exactly the kind
 *     of duplication that drifts;
 *   · a reader under `app/` reads as page code to anybody skimming, and
 *     page code that opens its own SQL is the defect this module is
 *     careful NOT to be. Hence the `server-only` guard on line 1 and the
 *     rule below.
 *
 * ⚠️ NO PAGE MAY IMPORT `@/db` DIRECTLY. The pages in this route group
 * call the functions here and `server/tax/audit.ts`; neither one opens a
 * connection of its own. `withTenant()` is the only door, and it is the
 * door because RLS — not a `WHERE tenant_id = …` somebody can forget — is
 * what keeps one workspace out of another's books.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ RAW SQL, AND WHY
 * ══════════════════════════════════════════════════════════════════════
 * `gst_rate_pin_status` is a VIEW created by SQL 0148. A view has no
 * Drizzle table object and `db/schema/**` belongs to another track, so
 * every statement here goes through `tx.execute(sql\`…\`)` — the same
 * position `server/tax/audit.ts` is in, for the same reason, with the
 * same consequence: a column rename in 0148 breaks this at RUNTIME rather
 * than at `tsc`.
 *
 * ⚠️ THE VIEW IS `security_invoker = true`. That is what makes RLS on the
 * underlying line tables apply to the CALLER rather than to the view's
 * owner. If somebody ever recreates it without that setting, every read
 * below silently returns every tenant's worklist and nothing here can
 * tell. It is asserted in 0148 §1 and tested in
 * `tests/security/tax-backfill.test.ts`.
 *
 * ⚠️ EVERY VALUE IS A BOUND PARAMETER. The only `sql.raw` in this file
 * would be a defect.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE VIEW ANSWERS AS AT NOW, NOT AS AT THE MIGRATION
 * ══════════════════════════════════════════════════════════════════════
 * 0148 says this explicitly and it is the trap in every number below. A
 * line reading `unbackfillable_no_rate_in_force` today reads `pinnable`
 * tomorrow if somebody adds the rate period that was in force on the
 * document's date. That is the useful behaviour — it is a worklist, and a
 * worklist that cannot shrink is a report — but it means these counts are
 * NOT a historical record and must never be quoted as one. The as-at
 * snapshot lives in 0148's own NOTICE output.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";

/* ------------------------------------------------------------------ */
/* THE VERDICTS                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THIS LIST IS 0148's `CASE` EXPRESSION, ENUMERATED. The database is
 * the authority; this is a copy kept so the UI can order and explain
 * them. A new arm added to that `CASE` and not added here does NOT
 * disappear from the screen — `describeVerdict()` in `page.tsx` falls through to a
 * legible default and the count is still rendered. Silently dropping an
 * unknown verdict would understate the worklist, which is the one failure
 * mode a worklist may not have.
 */
export const RATE_PIN_VERDICTS = [
  "already_pinned",
  "no_tax_to_trace",
  "pinnable",
  "unbackfillable_no_classification",
  "unbackfillable_no_rate_in_force",
  "unbackfillable_rate_disagrees",
  "unbackfillable_document_frozen",
] as const;

export type RatePinVerdict = (typeof RATE_PIN_VERDICTS)[number];

/** One `(verdict, document table)` bucket, as a count of lines. */
export type RatePinVerdictCount = {
  verdict: string;
  /** `sales_invoice_lines` or `sales_order_lines`. 0148 unions both. */
  documentTable: string;
  lines: number;
  /** Distinct parent documents behind those lines. */
  documents: number;
};

/** One document that has lines a human still has to deal with. */
export type RatePinDocument = {
  documentTable: string;
  documentId: string;
  documentNumber: string | null;
  documentDate: string;
  verdict: string;
  lines: number;
};

/* ------------------------------------------------------------------ */
/* ⭐ THE COUNTS                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every outward-supply line, bucketed by what can be proved about where
 * its rate came from.
 *
 * ⭐ IT RETURNS COUNTS AND NOTHING ELSE, AND THAT IS THE POINT. No score,
 * no ratio, no verdict on the workspace. This codebase has already paid
 * for a coverage check written `count(*) >= 10 THEN 'PASS'` for a
 * property that had to hold on 303 tables and reported PASS at 48 — a
 * threshold turns a number somebody would have questioned into a badge
 * nobody reads. The caller renders the numbers; the human interprets
 * them.
 *
 * ⚠️ GROUPED BY DOCUMENT TABLE AS WELL AS VERDICT. An invoice line and an
 * order line are not the same object: one has been issued to a customer
 * and its row is frozen, the other has not. Summing them would produce a
 * single number that no remedy applies to.
 */
export async function getRatePinVerdictCounts(
  tenantId: string,
): Promise<RatePinVerdictCount[]> {
  const result = await withTenant(tenantId, async (tx) =>
    tx.execute(sql`
      SELECT verdict                            AS verdict,
             document_table                     AS document_table,
             count(*)::int                      AS lines,
             count(DISTINCT document_id)::int   AS documents
        FROM gst_rate_pin_status
       GROUP BY verdict, document_table
       ORDER BY verdict ASC, document_table ASC
    `),
  );

  return extractRows(result).map((row) => ({
    verdict: asText(row.verdict) ?? "",
    documentTable: asText(row.document_table) ?? "",
    lines: asInt(row.lines),
    documents: asInt(row.documents),
  }));
}

/**
 * The documents behind the verdicts that need a human, newest first.
 *
 * ⚠️ `already_pinned` AND `no_tax_to_trace` ARE EXCLUDED. Both are
 * finished states — one has its citation, the other has no tax to cite —
 * and listing them would bury the handful of documents somebody actually
 * has to open under every document that is already fine.
 *
 * ⚠️ ONE ROW PER `(document, verdict)`, NOT PER DOCUMENT. A ten-line
 * invoice can have three lines with no classification and two whose rate
 * disagrees with the registry, and those are two different afternoons of
 * work. Collapsing to one row per document would have to pick a winner,
 * and whichever it picked would hide the other.
 *
 * ⚠️ BOUNDED, AND THE BOUND IS VISIBLE TO THE CALLER. The view has one
 * row per line in the workspace's entire outward-supply history; an
 * unbounded read here is a page that stops rendering on a real dataset.
 */
export async function getRatePinDocumentsNeedingAttention(
  tenantId: string,
  args?: { limit?: number },
): Promise<RatePinDocument[]> {
  const limit = Math.min(Math.max(1, Math.trunc(args?.limit ?? 100)), 1000);

  const result = await withTenant(tenantId, async (tx) =>
    tx.execute(sql`
      SELECT document_table       AS document_table,
             document_id::text    AS document_id,
             document_number      AS document_number,
             document_date::text  AS document_date,
             verdict              AS verdict,
             count(*)::int        AS lines
        FROM gst_rate_pin_status
       WHERE verdict <> 'already_pinned'
         AND verdict <> 'no_tax_to_trace'
       GROUP BY document_table, document_id, document_number, document_date, verdict
       ORDER BY document_date DESC, document_number ASC, verdict ASC
       LIMIT ${limit}
    `),
  );

  return extractRows(result).map((row) => ({
    documentTable: asText(row.document_table) ?? "",
    documentId: asText(row.document_id) ?? "",
    documentNumber: asText(row.document_number),
    documentDate: (asText(row.document_date) ?? "").slice(0, 10),
    verdict: asText(row.verdict) ?? "",
    lines: asInt(row.lines),
  }));
}

/* ------------------------------------------------------------------ */
/* PLUMBING — SEE THE HEADER: THIS IS A SECOND COPY                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ TWO DRIVER SHAPES, AND INDEXING `[0]` DIRECTLY IS WRONG ON ONE OF
 * THEM. `neon-http` returns a bare array; the pooled serverless driver
 * returns `{ rows }`. `server/tax/audit.ts` and
 * `server/platform/rls-posture.ts` both carry this note. Getting it wrong
 * here renders an empty worklist, which reads as "every line can prove
 * its rate" — the most reassuring possible way to be wrong.
 */
function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function asInt(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
