import "server-only";

/**
 * Ordence — ⭐⭐⭐ WHAT CAN BE EXPORTED, AND WHO MAY
 * Version: v1.73.0-alpha · Wave 5
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A CATALOGUE, NOT A GENERIC "EXPORT ANY TABLE" ENDPOINT
 * ══════════════════════════════════════════════════════════════════════
 * The tempting shape for wave 5 is one action taking a table name. It is
 * also a data-exfiltration endpoint with a nice UI: any authenticated
 * user, any table, and the only thing between them and `vault_secrets` is
 * whether somebody remembered an allowlist.
 *
 * ⭐ SO EVERY EXPORTABLE THING IS DECLARED HERE, BY NAME, WITH:
 *
 *   ① the PERMISSION it requires — its own, not a blanket "can export"
 *   ② the COLUMNS, typed, so money keeps its currency and codes stay text
 *   ③ which columns are PERSONAL, so `data_exports` can record what left
 *   ④ the SQL, parameterised, running inside `withTenant` under RLS
 *
 * ⚠️ AND ② IS NOT DOCUMENTATION. `lib/export/values.ts` refuses a money
 * column with no currency column beside it, so a careless entry here
 * fails at build time in the tests rather than producing a spreadsheet of
 * unlabelled numbers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THE PERMISSIONS ARE THE NARROW ONES
 * ══════════════════════════════════════════════════════════════════════
 * `contacts:export` already exists in `db/schema/auth.ts` and has since
 * Phase 4 — "Export contact data" — and until this wave NOTHING CHECKED
 * IT, because there was nothing to check. Reusing it rather than
 * inventing `export:run` means the roles a workspace already configured
 * keep meaning what they say.
 *
 * 🔴 AND READING IS NOT EXPORTING. A salesperson who may see a contact
 * may not necessarily take the whole list home; that is the distinction
 * `contacts:read` and `contacts:export` were created to express, and a
 * single blanket permission would collapse it.
 */

import { sql } from "drizzle-orm";
import { withTenant } from "@/db";
import type { PermissionKey } from "@/db/schema/auth";
import type { Column, Dataset, Row } from "@/lib/export/types";

export type DatasetFilters = {
  /** Inclusive ISO day. */
  readonly from?: string;
  /** Inclusive ISO day. */
  readonly to?: string;
};

export type DatasetDefinition = {
  readonly key: string;
  readonly title: string;
  /** One line, shown in the picker. */
  readonly description: string;
  /**
   * ⚠️ THE PERMISSION KEY, TYPED. `PermissionKey` is `keyof typeof
   * PERMISSION_CATALOG`, so a typo here is a compile error rather than a
   * permission check that passes because nothing matches it. Wave 3 hit
   * exactly this: `users:manage` looked right and does not exist.
   */
  readonly permission: PermissionKey;
  /** True when this dataset accepts a date range. */
  readonly dated: boolean;
  readonly columns: readonly Column[];
  readonly notes?: readonly string[];
  readonly tally?: Dataset["tally"];
  readonly load: (tenantId: string, filters: DatasetFilters) => Promise<Row[]>;
};

/**
 * ⚠️ THE DATE RANGE IS BOUND, NEVER INTERPOLATED, and it is validated as
 * an ISO day before it reaches here by `server/actions/export.ts`. Two
 * defences rather than one, because this is the one place in wave 5 where
 * user input reaches SQL.
 */
function dayRange(column: string, filters: DatasetFilters) {
  const clauses = [];
  if (filters.from) clauses.push(sql`${sql.raw(column)} >= ${filters.from}::date`);
  if (filters.to) clauses.push(sql`${sql.raw(column)} <= ${filters.to}::date`);
  if (clauses.length === 0) return sql`true`;
  if (clauses.length === 1) return clauses[0]!;
  return sql`${clauses[0]!} AND ${clauses[1]!}`;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[]);
}

/** ⚠️ `bigint` columns arrive as strings from the driver. Kept exact. */
function minor(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  return BigInt(String(value));
}

/* ------------------------------------------------------------------ */
/* ① THE SALES REGISTER                                                */
/* ------------------------------------------------------------------ */

const SALES_REGISTER: DatasetDefinition = {
  key: "sales-register",
  title: "Sales register",
  description: "Every sales invoice in the period, with its tax split and its currency.",
  permission: "reports:export",
  dated: true,
  notes: [
    /**
     * ⚠️ THE CAVEAT TRAVELS WITH THE FILE. A note that lives only in the
     * screen's tooltip does not survive an export, and the spreadsheet is
     * what gets emailed to the auditor.
     */
    "Drafts are included and are marked as such in the Status column. A draft invoice is not a tax invoice and does not appear in GSTR-1.",
    "Amounts are in the currency each invoice was raised in, shown in the Currency column. Do not total a column that mixes currencies.",
  ],
  columns: [
    { key: "invoice_number", label: "Invoice no.", kind: "code", width: 18 },
    { key: "invoice_date", label: "Date", kind: "date", width: 12 },
    { key: "status", label: "Status", kind: "text", width: 12 },
    { key: "customer", label: "Customer", kind: "text", width: 32, personal: true },
    { key: "customer_gstin", label: "Customer GSTIN", kind: "code", width: 18, personal: true },
    { key: "place_of_supply", label: "Place of supply", kind: "code", width: 10 },
    { key: "currency", label: "Currency", kind: "code", width: 10 },
    { key: "taxable_value", label: "Taxable value", kind: "money", currencyKey: "currency", width: 16 },
    { key: "cgst", label: "CGST", kind: "money", currencyKey: "currency", width: 14 },
    { key: "sgst", label: "SGST", kind: "money", currencyKey: "currency", width: 14 },
    { key: "igst", label: "IGST", kind: "money", currencyKey: "currency", width: 14 },
    { key: "cess", label: "Cess", kind: "money", currencyKey: "currency", width: 12 },
    { key: "total", label: "Invoice total", kind: "money", currencyKey: "currency", width: 16 },
  ],
  tally: {
    kind: "vouchers-elsewhere",
    where: "Settings → Tally → Export a period",
  },
  load: (tenantId, filters) =>
    withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT i.invoice_number,
               i.invoice_date,
               i.status::text                       AS status,
               coalesce(i.customer_legal_name, c.name) AS customer,
               i.customer_gstin,
               i.place_of_supply_code               AS place_of_supply,
               i.currency,
               i.taxable_value_minor,
               i.cgst_minor,
               i.sgst_minor,
               i.igst_minor,
               i.cess_minor,
               i.total_minor
          FROM sales_invoices i
          LEFT JOIN companies c ON c.id = i.company_id
         WHERE ${dayRange("i.invoice_date", filters)}
         ORDER BY i.invoice_date, i.invoice_number
      `);
      return rowsOf(result).map((r) => ({
        invoice_number: r.invoice_number as string,
        invoice_date: r.invoice_date as string,
        status: r.status as string,
        customer: (r.customer as string | null) ?? "",
        customer_gstin: (r.customer_gstin as string | null) ?? "",
        place_of_supply: (r.place_of_supply as string | null) ?? "",
        currency: (r.currency as string | null) ?? "INR",
        taxable_value: minor(r.taxable_value_minor),
        cgst: minor(r.cgst_minor),
        sgst: minor(r.sgst_minor),
        igst: minor(r.igst_minor),
        cess: minor(r.cess_minor),
        total: minor(r.total_minor),
      }));
    }),
};

/* ------------------------------------------------------------------ */
/* ② CONTACTS                                                          */
/* ------------------------------------------------------------------ */

const CONTACTS: DatasetDefinition = {
  key: "contacts",
  title: "Contacts",
  description: "The contact list, with the personal fields it holds.",
  /** 🔴 `contacts:export`, and reading is not exporting. See the header. */
  permission: "contacts:export",
  dated: false,
  notes: [
    "This export contains personal data. Ordence records who ran it, when, and which personal fields it contained.",
    "Contacts that have been deleted are not included.",
  ],
  columns: [
    { key: "first_name", label: "First name", kind: "text", width: 18, personal: true },
    { key: "last_name", label: "Last name", kind: "text", width: 18, personal: true },
    { key: "company", label: "Company", kind: "text", width: 28 },
    { key: "job_title", label: "Job title", kind: "text", width: 22 },
    { key: "email", label: "Email", kind: "text", width: 30, personal: true },
    { key: "phone", label: "Phone", kind: "code", width: 16, personal: true },
    { key: "mobile", label: "Mobile", kind: "code", width: 16, personal: true },
    { key: "owner", label: "Owner", kind: "text", width: 22, personal: true },
    { key: "last_contacted_at", label: "Last contacted", kind: "datetime", width: 20 },
    { key: "created_at", label: "Created", kind: "datetime", width: 20 },
  ],
  load: (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT ct.first_name,
               ct.last_name,
               co.name AS company,
               ct.job_title,
               ct.email,
               ct.phone,
               ct.mobile,
               coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email)
                 AS owner,
               ct.last_contacted_at,
               ct.created_at
          FROM contacts ct
          LEFT JOIN companies co ON co.id = ct.company_id
          LEFT JOIN users u      ON u.id  = ct.owner_id
         WHERE ct.deleted_at IS NULL
         ORDER BY ct.last_name NULLS LAST, ct.first_name
      `);
      return rowsOf(result).map((r) => ({
        first_name: (r.first_name as string | null) ?? "",
        last_name: (r.last_name as string | null) ?? "",
        company: (r.company as string | null) ?? "",
        job_title: (r.job_title as string | null) ?? "",
        email: (r.email as string | null) ?? "",
        phone: (r.phone as string | null) ?? "",
        mobile: (r.mobile as string | null) ?? "",
        owner: (r.owner as string | null) ?? "",
        last_contacted_at: (r.last_contacted_at as Date | null) ?? null,
        created_at: (r.created_at as Date | null) ?? null,
      }));
    }),
};

/* ------------------------------------------------------------------ */
/* ③ THE CHART OF ACCOUNTS                                             */
/* ------------------------------------------------------------------ */

const LEDGERS: DatasetDefinition = {
  key: "ledgers",
  title: "Chart of accounts",
  description: "Every ledger, its code, its type and its currency.",
  permission: "reports:export",
  dated: false,
  notes: [
    /**
     * ⭐ THE SENTENCE THAT EXPLAINS WHY THIS ONE IS NOT A TALLY EXPORT
     * even though it obviously looks like one. See `lib/export/tally.ts`.
     */
    "This is Ordence's chart of accounts. It is not a Tally ledger list — the Tally group each account belongs to is a decision recorded in Settings → Tally → Ledger mapping, and the Tally export is taken from there.",
  ],
  columns: [
    { key: "code", label: "Code", kind: "code", width: 12 },
    { key: "name", label: "Ledger", kind: "text", width: 36 },
    { key: "account_type", label: "Account type", kind: "text", width: 14 },
    { key: "type", label: "Ledger type", kind: "text", width: 14 },
    { key: "currency", label: "Currency", kind: "code", width: 10 },
    { key: "is_active", label: "Active", kind: "boolean", width: 10 },
  ],
  load: (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT code, name, account_type::text AS account_type, type::text AS type,
               currency, is_active
          FROM ledgers
         ORDER BY code
      `);
      return rowsOf(result).map((r) => ({
        code: r.code as string,
        name: r.name as string,
        account_type: r.account_type as string,
        type: r.type as string,
        currency: (r.currency as string | null) ?? "INR",
        is_active: Boolean(r.is_active),
      }));
    }),
};

/* ------------------------------------------------------------------ */
/* ④ THE TALLY LEDGER MASTERS — THE ONE WITH A REAL TALLY MAPPING      */
/* ------------------------------------------------------------------ */

const TALLY_LEDGER_MASTERS: DatasetDefinition = {
  key: "tally-ledger-masters",
  title: "Tally ledger masters",
  description: "The ledgers this workspace has mapped to Tally, ready to create there.",
  permission: "tally:export",
  dated: false,
  notes: [
    /**
     * 🔴 THE OPENING BALANCE IS NOT IN THIS FILE AND THE READER MUST KNOW
     * WHY. A ledger master re-imported over an existing ledger RESETS its
     * opening balance, so a "helpful" balance in a masters file silently
     * rewrites the customer's books on the second import.
     */
    "Ledger masters only. Opening balances are not included: re-importing a master that carries one resets the balance of the ledger it matches in Tally. Opening balances belong in a journal voucher dated the first day of the year.",
    "Only mappings marked to create the master on export are included.",
  ],
  columns: [
    { key: "tally_ledger_name", label: "Ledger name", kind: "text", width: 36 },
    { key: "tally_parent_group", label: "Tally group", kind: "text", width: 22 },
    { key: "is_party", label: "Party ledger", kind: "boolean", width: 12 },
    { key: "party_gstin", label: "GSTIN", kind: "code", width: 18 },
    { key: "party_state_code", label: "State", kind: "code", width: 8 },
  ],
  tally: {
    kind: "ledger-master",
    nameKey: "tally_ledger_name",
    parentGroupKey: "tally_parent_group",
    gstinKey: "party_gstin",
    isParty: true,
  },
  load: (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT tally_ledger_name,
               tally_parent_group::text AS tally_parent_group,
               is_party,
               party_gstin,
               party_state_code
          FROM tally_ledger_mappings
         WHERE is_active AND create_master_on_export
         ORDER BY tally_ledger_name
      `);
      return rowsOf(result).map((r) => ({
        tally_ledger_name: r.tally_ledger_name as string,
        tally_parent_group: r.tally_parent_group as string,
        is_party: Boolean(r.is_party),
        party_gstin: (r.party_gstin as string | null) ?? "",
        party_state_code: (r.party_state_code as string | null) ?? "",
      }));
    }),
};

/* ------------------------------------------------------------------ */
/* ⑤ THE EXPORT LOG ITSELF                                             */
/* ------------------------------------------------------------------ */

const EXPORT_LOG: DatasetDefinition = {
  key: "export-log",
  title: "Export log",
  description: "Every export taken from this workspace, and whether personal data was in it.",
  permission: "audit:read",
  dated: true,
  notes: [
    /**
     * ⚠️ YES, EXPORTING THE EXPORT LOG IS ITSELF LOGGED. It has to be:
     * the log's whole value is that it is complete, and an exception for
     * the one export that reveals every other export would be the first
     * thing anybody covering their tracks would use.
     */
    "Taking this export is itself recorded in this log.",
    "This log records what was exported and by whom. It never holds the exported file.",
  ],
  columns: [
    { key: "occurred_at", label: "When", kind: "datetime", width: 20 },
    { key: "actor", label: "Who", kind: "text", width: 24, personal: true },
    { key: "subject", label: "What", kind: "text", width: 28 },
    { key: "format", label: "Format", kind: "text", width: 10 },
    { key: "row_count", label: "Rows", kind: "integer", width: 10 },
    { key: "includes_personal_data", label: "Personal data", kind: "boolean", width: 14 },
    { key: "personal_columns", label: "Personal fields", kind: "text", width: 36 },
    { key: "outcome", label: "Outcome", kind: "text", width: 12 },
  ],
  load: (tenantId, filters) =>
    withTenant(tenantId, async (tx) => {
      const result = await tx.execute(sql`
        SELECT e.occurred_at,
               coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email)
                 AS actor,
               e.subject, e.format, e.row_count,
               e.includes_personal_data,
               array_to_string(e.personal_columns, ', ') AS personal_columns,
               e.outcome
          FROM data_exports e
          LEFT JOIN users u ON u.id = e.exported_by
         WHERE ${dayRange("e.occurred_at::date", filters)}
         ORDER BY e.occurred_at DESC
      `);
      return rowsOf(result).map((r) => ({
        occurred_at: r.occurred_at as Date,
        actor: (r.actor as string | null) ?? "",
        subject: r.subject as string,
        format: r.format as string,
        row_count: Number(r.row_count),
        includes_personal_data: Boolean(r.includes_personal_data),
        personal_columns: (r.personal_columns as string | null) ?? "",
        outcome: r.outcome as string,
      }));
    }),
};

/* ------------------------------------------------------------------ */

export const EXPORT_DATASETS: readonly DatasetDefinition[] = [
  SALES_REGISTER,
  CONTACTS,
  LEDGERS,
  TALLY_LEDGER_MASTERS,
  EXPORT_LOG,
];

export function findDataset(key: string): DatasetDefinition | undefined {
  return EXPORT_DATASETS.find((d) => d.key === key);
}

/** The definition turned into a renderable dataset, with its rows loaded. */
export async function buildDataset(
  definition: DatasetDefinition,
  tenantId: string,
  filters: DatasetFilters,
): Promise<Dataset> {
  const rows = await definition.load(tenantId, filters);
  return {
    key: definition.key,
    title: definition.title,
    columns: definition.columns,
    rows,
    notes: definition.notes,
    ...(definition.tally ? { tally: definition.tally } : {}),
  };
}
