import "server-only";

/**
 * Ordence — ⭐⭐⭐ EXECUTING A DATA-PRINCIPAL EXPORT
 * Version: v1.68.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS NOT `server/backup/export.ts` AND THE DIFFERENCE MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * That file exports a WORKSPACE — twenty-two allowlisted tables, every
 * row, for disaster recovery and for leaving. It has existed since Phase
 * 12 and it is correct for what it does.
 *
 * This file exports a PERSON. Every table in the inventory, only their
 * rows, with a manifest that states what was searched, what was not, and
 * why. Those are different rights: s.11 of the DPDPA is the Data
 * Principal's right of access, and it is not satisfied by handing them
 * the whole workspace — which would disclose every other customer's data
 * to them, the precise mistake `server/backup/export.ts` avoids by not
 * using `pg_dump`.
 *
 * ⚠️ AND ITS ALLOWLIST IS THE WRONG SHAPE FOR THIS. Twenty-two tables of
 * two hundred and ninety-six is right for "give the customer their
 * records back" and wrong for "tell this person everything you hold",
 * where the omission is the whole problem.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT MAKES THIS SAFE TO RUN
 * ══════════════════════════════════════════════════════════════════════
 * Every statement runs inside `withTenant()`, so RLS is in force for all
 * of it. The tenant predicate below is NOT the security boundary — the
 * policy is — it is there so the planner uses the tenant index.
 *
 * 🔴 EVERY TABLE AND COLUMN NAME REACHING `sql.raw` COMES FROM
 * `lib/dpdp/classification.ts`, WHICH IS A FROZEN LITERAL, AND IS
 * RE-VALIDATED AGAINST THE PARSED SCHEMA BEFORE USE. Never from a
 * request, a parameter or the database. `assertIdentifier` below is the
 * belt to that braces: if a future edit ever lets a value in from
 * outside, it fails loudly rather than interpolating.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { redactPayload } from "@/lib/billing/redact";
import {
  buildExportPlan,
  executionOrder,
  type ExportPlan,
  type Subject,
  type TablePlan,
} from "@/lib/dpdp/subject-graph";

/* ------------------------------------------------------------------ */

/**
 * ⚠️ COLUMNS WITHHELD FROM A DATA-PRINCIPAL EXPORT, WHEREVER THEY APPEAR.
 *
 * These are OUR credentials and OUR storage layout, and two of them
 * would be actively dangerous in the hands of somebody who has just
 * proved they can get a workspace to run a query for them.
 *
 * ⭐ The list is deliberately the same shape as the one in
 * `server/backup/export.ts` rather than a shared import: that file's
 * list answers "what does the customer not need", this one answers "what
 * must a third party never receive", and the day those two diverge is
 * the day sharing them would have been a bug.
 */
const WITHHELD_COLUMNS = new Set([
  "token_hash",
  "token_prefix",
  "blob_pathname",
  "search_vector",
  "webhook_secret_hash",
  "ciphertext",
  "blind_index",
  "prev_hash",
  "content_hash",
  "row_hash",
]);

const WITHHELD_SUFFIXES = ["_secret", "_token", "_hash", "_pepper"];

function isWithheld(name: string): boolean {
  if (WITHHELD_COLUMNS.has(name)) return true;
  if (WITHHELD_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (/^(provider|razorpay|stripe)_.*_id$/.test(name)) return true;
  return false;
}

/**
 * 🔴 THE LAST LINE BEFORE `sql.raw`.
 *
 * Nothing that reaches here should ever be attacker-influenced — the
 * inventory is a literal — but "should ever" is how injection arrives.
 */
function assertIdentifier(value: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(
      `Refusing to interpolate ${what} "${value}": it is not a bare lower-case identifier, ` +
        `so it did not come from lib/dpdp/classification.ts.`,
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */

function serialiseValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return (value as Buffer).toString("base64");
  if (Array.isArray(value)) return value.map(serialiseValue);
  if (typeof value === "object") {
    /**
     * ⚠️ A JSONB COLUMN HOLDS WHATEVER A WEBHOOK SENT US. The redaction
     * pass runs over it for the same reason it runs in the billing
     * providers: the interesting case is the one nobody anticipated.
     */
    return redactPayload(value);
  }
  return value;
}

function serialiseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (isWithheld(k)) continue;
    out[k] = serialiseValue(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * ⚠️ A CAP, NOT A LIMIT ON WHAT THE PERSON MAY HAVE.
 *
 * It is a guard against one query exhausting a serverless function's
 * memory. When a table hits it, the manifest RECORDS that it was capped
 * — the same discipline as `server/backup/export.ts`, and for the same
 * reason: a silently truncated export looks complete in the file.
 */
const MAX_ROWS_PER_TABLE = 20_000;

export type PrincipalExportManifest = {
  formatVersion: 1;
  exportedAt: string;
  tenantId: string;
  workspaceName: string;
  /** ⭐ Which records the operator verified as this person, and how. */
  anchors: { kind: string; id: string; establishedBy: string }[];
  /** Rows found per table. Zero is recorded, not omitted. */
  counts: Record<string, number>;
  /**
   * 🔴 THE SECTION THAT MAKES THIS DOCUMENT HONEST. Every table not
   * searched, with the reason, in the file the person receives.
   */
  notSearched: { table: string; reason: string; kind: TablePlan["verdict"] }[];
  /** Tables whose match is by typed value or by convention, not by key. */
  weakMatches: { table: string; confidence: string; why: string }[];
  /** Tables that errored. Never silently omitted. */
  failures: { table: string; reason: string }[];
  notes: string[];
  summary: ExportPlan["summary"];
};

export type PrincipalExport = {
  manifest: PrincipalExportManifest;
  data: Record<string, Record<string, unknown>[]>;
};

/* ------------------------------------------------------------------ */

export async function exportDataPrincipal(args: {
  tenantId: string;
  workspaceName: string;
  subject: Subject;
  /** Passed in. This module has no clock of its own. */
  now: Date;
}): Promise<PrincipalExport> {
  const plan = buildExportPlan(args.subject);
  const { order, cycles } = executionOrder(plan);
  const byTable = new Map(plan.tables.map((t) => [t.table, t]));

  const data: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};
  const failures: { table: string; reason: string }[] = [];
  const notes: string[] = [];
  const notSearched: PrincipalExportManifest["notSearched"] = [];
  const weakMatches: PrincipalExportManifest["weakMatches"] = [];

  /**
   * ⭐ The ids matched per table, so a `via-parent` hop has something to
   * join to. A table that matched nothing contributes an EMPTY set, and
   * its children then match nothing — which is correct and is why the
   * empty set is stored rather than the key being left absent.
   */
  const matched = new Map<string, string[]>();

  if (cycles.length > 0) {
    notes.push(
      `A cycle was found in the reach graph through ${cycles.join(", ")}. Those tables were not searched. ` +
        `The classification gate refuses cycles at build time, so this should be unreachable — if you are ` +
        `reading it, the gate was bypassed.`,
    );
  }

  await withTenant(args.tenantId, async (tx) => {
    for (const table of order) {
      const t = byTable.get(table);
      if (!t) continue;

      if (t.verdict !== "search" || cycles.includes(table)) {
        notSearched.push({ table, reason: t.note, kind: t.verdict });
        matched.set(table, []);
        continue;
      }

      /* --- build the predicate ------------------------------------- */

      const clauses = [];
      let unsatisfiable = false;

      for (const p of t.predicates) {
        switch (p.op) {
          case "id-in":
            if (p.ids.length === 0) break;
            clauses.push(sql`id = ANY(${p.ids}::uuid[])`);
            break;
          case "column-in": {
            if (p.ids.length === 0) break;
            const col = assertIdentifier(p.column, "column");
            clauses.push(sql`${sql.raw(col)} = ANY(${p.ids}::uuid[])`);
            break;
          }
          case "identifier-in": {
            if (p.values.length === 0) break;
            const col = assertIdentifier(p.column, "column");
            clauses.push(sql`lower(${sql.raw(col)}::text) = ANY(${p.values}::text[])`);
            break;
          }
          case "polymorphic-in": {
            if (p.ids.length === 0 || p.kinds.length === 0) break;
            const idCol = assertIdentifier(p.idColumn, "column");
            const kindCol = assertIdentifier(p.kindColumn, "column");
            clauses.push(
              sql`(${sql.raw(idCol)}::text = ANY(${p.ids}::text[]) AND ${sql.raw(kindCol)}::text = ANY(${p.kinds}::text[]))`,
            );
            break;
          }
          case "via-parent": {
            const parentIds = matched.get(p.parent);
            /**
             * ⚠️ AN UNRESOLVED PARENT IS NOT AN EMPTY PARENT. If the
             * parent was never executed — because it was itself
             * unsearchable — then joining to nothing would silently
             * report zero rows here as though we had looked.
             */
            if (parentIds === undefined) {
              unsatisfiable = true;
              break;
            }
            if (parentIds.length === 0) break;
            const col = assertIdentifier(p.column, "column");
            clauses.push(sql`${sql.raw(col)} = ANY(${parentIds}::uuid[])`);
            break;
          }
          case "via-reverse": {
            const fromIds = matched.get(p.from);
            if (fromIds === undefined) {
              unsatisfiable = true;
              break;
            }
            if (fromIds.length === 0) break;
            const from = assertIdentifier(p.from, "table");
            const col = assertIdentifier(p.column, "column");
            clauses.push(
              sql`id IN (SELECT ${sql.raw(col)} FROM ${sql.raw(from)} WHERE id = ANY(${fromIds}::uuid[]))`,
            );
            break;
          }
        }
      }

      if (unsatisfiable) {
        notSearched.push({
          table,
          reason: `${table} is reached through another table that could not itself be searched, so no rows here could be identified as this person's.`,
          kind: "no-reach",
        });
        matched.set(table, []);
        continue;
      }

      if (clauses.length === 0) {
        /**
         * 🔴 THE CASE THAT LOOKS LIKE SUCCESS AND IS NOT.
         *
         * Every predicate resolved to nothing to match on — the parent
         * found no rows, or no identifier was supplied. Running the
         * query anyway would return the WHOLE TABLE for this tenant and
         * hand one person every other person's records. Reporting zero
         * rows would claim we looked.
         */
        notSearched.push({
          table,
          reason: `${table} was reachable in principle and nothing this person supplied narrowed it to their rows, so it was not read. It was NOT searched and returned empty — those are different, and this is the first.`,
          kind: "not-applicable",
        });
        matched.set(table, []);
        continue;
      }

      /* --- run it --------------------------------------------------- */

      try {
        const safeTable = assertIdentifier(table, "table");
        const where = clauses.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} OR ${c}`));
        const result = await tx.execute(
          sql`SELECT * FROM ${sql.raw(safeTable)}
               WHERE tenant_id = ${args.tenantId}
                 AND (${where})
               LIMIT ${MAX_ROWS_PER_TABLE}`,
        );
        const rows = (result.rows ?? []) as Record<string, unknown>[];
        data[table] = rows.map(serialiseRow);
        counts[table] = rows.length;
        matched.set(
          table,
          rows.map((r) => String(r["id"] ?? "")).filter((v) => v.length > 0),
        );

        if (t.confidence && t.confidence !== "keyed" && rows.length > 0) {
          weakMatches.push({
            table,
            confidence: t.confidence,
            why:
              t.confidence === "by-value"
                ? "matched on an email address or phone number written as text. Two people who share an address share these rows, and a number that changed loses the older ones."
                : "matched on a discriminator column that no database constraint enforces. Rows labelled differently by whatever wrote them are not found.",
          });
        }

        if (rows.length === MAX_ROWS_PER_TABLE) {
          notes.push(
            `${table}: capped at ${MAX_ROWS_PER_TABLE} rows. There is more. This export is INCOMPLETE for this table and must not be presented as a full answer.`,
          );
        }
      } catch (error) {
        /**
         * One failed table must not lose the rest, and must not vanish.
         */
        failures.push({ table, reason: error instanceof Error ? error.message : "unknown error" });
        data[table] = [];
        counts[table] = 0;
        matched.set(table, []);
      }
    }
  });

  if (failures.length > 0) {
    notes.push(
      `${failures.length} table(s) could not be read and are listed under "failures". This export is not complete and the person receiving it must be told so.`,
    );
  }

  const unreachable = notSearched.filter((n) => n.kind === "no-reach");
  if (unreachable.length > 0) {
    notes.push(
      `${unreachable.length} table(s) hold personal data that Ordence cannot search for any individual. They are listed under "notSearched". This is a limitation of the product, not a statement that they are empty.`,
    );
  }

  return {
    manifest: {
      formatVersion: 1,
      exportedAt: args.now.toISOString(),
      tenantId: args.tenantId,
      workspaceName: args.workspaceName,
      anchors: args.subject.anchors.map((a) => ({
        kind: a.kind,
        id: a.id,
        establishedBy: a.establishedBy,
      })),
      counts,
      notSearched,
      weakMatches,
      failures,
      notes,
      summary: plan.summary,
    },
    data,
  };
}

/**
 * Pretty-printed at two spaces, like the workspace export, and for the
 * same reason: the person opening it is usually reading it, not parsing
 * it.
 */
export function serialisePrincipalExport(e: PrincipalExport): string {
  return JSON.stringify(e, null, 2);
}

export function principalExportFileName(reference: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 10);
  const safe = reference.replace(/[^A-Za-z0-9_-]/g, "-");
  return `ordence-data-principal-${safe}-${stamp}.json`;
}
