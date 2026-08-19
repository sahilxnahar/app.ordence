import "server-only";

/**
 * Ordence — Tenant Data Export
 * Version: v0.21.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS ONE FUNCTION ANSWERS THREE DIFFERENT REQUIREMENTS
 * ══════════════════════════════════════════════════════════════════════
 *
 *   1. DISASTER RECOVERY. A customer-held copy is the backup that
 *      survives us — our provider, our account, our mistakes.
 *
 *   2. DPDP RIGHT OF ACCESS. A Data Principal may demand a copy of
 *      their data. That right does not lapse because an invoice is
 *      outstanding, which is why export is on the always-permitted list
 *      in `lib/billing/access-state.ts` even at the hardest lockout.
 *
 *   3. THE EXIT. A customer who wants to leave must be able to. A
 *      product that makes leaving hard is a product people are wary of
 *      joining, and the export is cheaper to build than the reputation
 *      is to repair.
 *
 * ⚠️ It is also, incidentally, the migration path to a self-hosted or
 * desktop instance. Because both sides run PostgreSQL with the same
 * schema, a JSON export restored into an empty database is an
 * afternoon's work — no sync engine required. That is not the reason
 * this exists, but it is why the format is kept boring and mechanical
 * rather than pretty.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY JSON AND NOT pg_dump
 * ══════════════════════════════════════════════════════════════════════
 * `pg_dump` is the better disaster-recovery artefact and we cannot use
 * it here: it dumps a DATABASE, not a TENANT. Running it would hand one
 * customer every other customer's rows, which is the single worst
 * possible outcome of a feature whose purpose is data protection.
 *
 * So this is a tenant-scoped read, executed inside `withTenant()`, with
 * RLS in force for every statement. If the isolation model is sound, the
 * export is correct by construction — and if it is not, this feature is
 * the least of the problems.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { redactPayload } from "@/lib/billing/redact";

/* ------------------------------------------------------------------ */
/* WHAT IS EXPORTED                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ AN ALLOWLIST, NEVER A SCAN OF `information_schema`.
 *
 * A dynamic "export every table with a tenant_id" is one migration away
 * from silently including something it should not — a token table, an
 * internal queue, a column added for debugging. An allowlist fails the
 * other way: a new table is simply missing until someone adds it, which
 * is a bug report rather than a disclosure.
 */
const EXPORTED_TABLES = [
  // The customer's own records — the reason they are here.
  "companies",
  "contacts",
  "deals",
  "assets",
  "asset_relationships",
  "contracts",
  "contract_versions",
  "clause_library",
  "custom_object_definitions",
  "custom_field_definitions",
  "custom_object_records",
  "documents",

  // Financial records. Their ledger is theirs.
  "ledgers",
  "transactions",
  "journal_entries",
  "financial_periods",

  // Billing history — they are entitled to their own invoices.
  "invoices",
  "invoice_lines",

  // Who did what. Requested more often than anything else on this list.
  "audit_logs",
] as const;

/**
 * Columns stripped from every table, wherever they appear.
 *
 * These are OUR bookkeeping, not the customer's data, and several are
 * actively dangerous to hand over:
 *
 *   `token_hash`      — a credential, even hashed.
 *   `blob_pathname`   — an internal storage path. Useless to them and a
 *                       map of our storage layout to anyone else.
 *   `provider_*_id`   — identifiers in OUR payment provider account.
 *
 * ⚠️ Matched by exact name AND by suffix, because a future column called
 * `razorpay_customer_id` should be caught without anyone remembering to
 * add it here.
 */
const EXCLUDED_COLUMNS = new Set([
  "token_hash",
  "token_prefix",
  "blob_pathname",
  "search_vector",
]);

const EXCLUDED_SUFFIXES = ["_secret", "_token", "_hash"];

function isExcludedColumn(name: string): boolean {
  if (EXCLUDED_COLUMNS.has(name)) return true;
  if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // Provider-side identifiers: ours, not theirs.
  if (/^(provider|razorpay|stripe)_.*_id$/.test(name)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* SERIALISATION                                                       */
/* ------------------------------------------------------------------ */

/**
 * `JSON.stringify` throws on a bigint — "Do not know how to serialize a
 * BigInt" — and every monetary column in this system is one. An export
 * that crashes on the first invoice is worse than no export, because it
 * fails at the moment a customer is already anxious.
 *
 * Dates become ISO 8601 strings so the file is readable and re-importable
 * without a parser that knows PostgreSQL's output format.
 */
function serialiseValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  // ⚠️ Cast is deliberate. Under @types/node 24 the `Buffer.isBuffer` guard
  // narrows to a generic `Buffer<ArrayBufferLike>` whose `toString` resolves
  // to Object.prototype's zero-argument version, so passing an encoding is
  // rejected — "Expected 0 arguments, but got 1". Naming the type restores
  // the Buffer overload without changing a byte of runtime behaviour.
  if (Buffer.isBuffer(value)) return (value as Buffer).toString("base64");
  if (Array.isArray(value)) return value.map(serialiseValue);
  if (typeof value === "object") {
    // JSONB columns can hold anything a webhook sent us. The redaction
    // pass from Phase 11 runs over them for the same reason it runs
    // there: cheap, and the interesting case is the one you did not
    // anticipate.
    return redactPayload(value);
  }
  return value;
}

function serialiseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isExcludedColumn(key)) continue;
    out[key] = serialiseValue(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* THE EXPORT                                                          */
/* ------------------------------------------------------------------ */

export type ExportManifest = {
  formatVersion: 1;
  exportedAt: string;
  tenantId: string;
  tenantName: string;
  /** Rows written per table. The customer's receipt that nothing was silently dropped. */
  counts: Record<string, number>;
  /** Tables that failed, with the reason. Never silently omitted. */
  failures: { table: string; reason: string }[];
  notes: string[];
};

export type TenantExport = {
  manifest: ExportManifest;
  data: Record<string, Record<string, unknown>[]>;
};

/**
 * Rows read per table.
 *
 * Not a limit on what the customer may have — a cap that silently
 * truncated an export would be the worst kind of bug, because the file
 * would look complete. It is a guard against a single query returning
 * more than a serverless function can hold in memory. When a table hits
 * it, the manifest RECORDS that it was capped, so the omission is
 * visible in the file itself.
 */
const MAX_ROWS_PER_TABLE = 50_000;

export async function exportTenantData(
  tenantId: string,
  tenantName: string,
): Promise<TenantExport> {
  const counts: Record<string, number> = {};
  const failures: { table: string; reason: string }[] = [];
  const notes: string[] = [];
  const data: Record<string, Record<string, unknown>[]> = {};

  await withTenant(tenantId, async (tx) => {
    for (const table of EXPORTED_TABLES) {
      try {
        /**
         * ⚠️ The table name is interpolated with `sql.raw`, which is
         * normally how injection happens. It is safe here and only here
         * because the values come from `EXPORTED_TABLES`, a frozen
         * literal array in this file — never from a request, a
         * parameter, or the database. If that ever changes, this
         * becomes a hole immediately.
         *
         * The tenant filter is NOT the security boundary either; RLS is.
         * It is here so the query plan uses the tenant index.
         */
        const result = await tx.execute(
          sql`SELECT * FROM ${sql.raw(table)}
               WHERE tenant_id = ${tenantId}
               LIMIT ${MAX_ROWS_PER_TABLE}`,
        );

        const rows = (result.rows ?? []) as Record<string, unknown>[];
        data[table] = rows.map(serialiseRow);
        counts[table] = rows.length;

        if (rows.length === MAX_ROWS_PER_TABLE) {
          notes.push(
            `${table}: capped at ${MAX_ROWS_PER_TABLE} rows. There is more — ` +
              `contact us for a complete extract.`,
          );
        }
      } catch (error) {
        /**
         * One failed table must not lose the other nineteen. A customer
         * who is leaving, or who has just had an incident, needs
         * whatever we can give them now — and needs to be TOLD what is
         * missing rather than discovering it later.
         */
        failures.push({
          table,
          reason: error instanceof Error ? error.message : "unknown error",
        });
        data[table] = [];
        counts[table] = 0;
      }
    }
  });

  if (failures.length > 0) {
    notes.push(
      `${failures.length} table(s) could not be exported and are listed in ` +
        `"failures". The rest of this file is complete.`,
    );
  }

  return {
    manifest: {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      tenantId,
      tenantName,
      counts,
      failures,
      notes,
    },
    data,
  };
}

/**
 * Render the export as a downloadable JSON string.
 *
 * Pretty-printed at two spaces. It roughly doubles the file size and it
 * is the right trade: the person opening this is often doing so in a
 * text editor during an incident, and a single-line 40 MB file is
 * unreadable exactly when readability matters most.
 */
export function serialiseExport(exported: TenantExport): string {
  return JSON.stringify(exported, null, 2);
}

/**
 * A filename that sorts chronologically and is safe on every OS.
 *
 * Colons are illegal in Windows filenames and ISO timestamps are full of
 * them, so they are stripped rather than left to fail on download.
 */
export function exportFileName(tenantName: string, at: Date): string {
  const slug = tenantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "workspace";

  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug}-export-${stamp}.json`;
}
