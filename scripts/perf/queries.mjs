/**
 * Ordence — Track F · THE QUERY CATALOGUE
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * Every entry here is a SQL transcription of a query the application
 * actually issues, with the file and line it comes from written down. It
 * is NOT a synthetic benchmark. If a query in this file has no `source`,
 * it does not belong here.
 *
 * ⚠️ WHY TRANSCRIBE RATHER THAN CALL THE REAL CODE. The real call sites
 * are `"use server"` functions behind `requirePermission()`, which needs
 * Clerk, which needs a browser session. Standing that up to time a
 * SELECT would measure Clerk. The transcription is checked against the
 * source by `scripts/perf/check-catalogue-drift.mjs`, which fails when a
 * cited line no longer contains the table and predicate claimed here —
 * so the citation cannot rot silently.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY QUERY IS RUN WITH RLS IN FORCE, AS `ordence_app`
 * ══════════════════════════════════════════════════════════════════════
 * The harness sets `app.current_tenant_id` transaction-locally and
 * connects as a NOBYPASSRLS role, exactly as `withTenant()` does. The
 * explicit `tenant_id = $1` in each query below is therefore REDUNDANT
 * with the RLS policy and is written anyway — because the application
 * writes it, and removing it would change the plan.
 *
 * `budgetMs` is a wall-clock ceiling for the query at the load profile
 * in `scripts/perf/results/load-profile.json`, measured on the biggest
 * tenant. `budgetRows` is a ceiling on rows RETURNED — an unbounded
 * query fails that ceiling long before it fails the time one, which is
 * the point.
 */

/** The tenant the numbers are quoted against: the 40-point enterprise. */
export const BIG_TENANT_SLUG = "enterprise-01";
export const SMALL_TENANT_SLUG = "starter-01";

export const QUERIES = [
  {
    id: "invoices.list",
    title: "Invoice list, newest first (the sales landing page)",
    source: "server/actions/sales-invoices.ts:1666 listInvoices()",
    budgetMs: 25,
    budgetRows: 500,
    sql: `
      SELECT id, invoice_number, invoice_date, due_date, status,
             customer_legal_name, total_minor, received_minor
        FROM sales_invoices
       WHERE tenant_id = $1
       ORDER BY invoice_date DESC
       LIMIT 200`,
  },

  {
    id: "invoices.overdue",
    title: "Overdue receivables (credit control, dunning sweep)",
    source: "server/actions/sales-invoices.ts:1666 listInvoices(); server/invoicing/documents.ts:185",
    /**
     * ⚠️ DERIVED, NOT TRANSCRIBED, AND THE DIFFERENCE IS STATED BECAUSE
     * `check-catalogue-drift.mjs` would otherwise let it rot quietly.
     *
     * `listInvoices()` selects `status` and `due_date` for every invoice
     * and computes "overdue" in JavaScript afterwards (lines 1693-1710).
     * The SQL below pushes that predicate into the database, which is
     * what the query SHOULD be and what `server/credit/dunning-sweep.ts`
     * needs when it runs unattended over a large tenant. The plan it
     * exercises — a tenant + status + date-range read of
     * `sales_invoices` — is the one the application already issues.
     */
    derived: "pushes listInvoices()'s in-JavaScript overdue test into SQL",
    budgetMs: 25,
    budgetRows: 500,
    sql: `
      SELECT id, invoice_number, due_date, total_minor, received_minor,
             total_minor - received_minor AS outstanding_minor
        FROM sales_invoices
       WHERE tenant_id = $1
         AND status IN ('issued','part_paid')
         AND due_date < current_date
       ORDER BY due_date ASC
       LIMIT 200`,
  },

  {
    id: "contacts.page",
    title: "Contact list page 1, with company name",
    source: "server/actions/contacts.ts:153 listContacts()",
    budgetMs: 25,
    budgetRows: 100,
    sql: `
      SELECT c.id, c.first_name, c.last_name, c.email, c.job_title,
             co.name AS company_name
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = $1
       WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.last_name ASC, c.first_name ASC
       LIMIT 50 OFFSET 0`,
  },

  {
    id: "contacts.count",
    title: "Contact list total — the second half of the same Promise.all",
    source: "server/actions/contacts.ts:164 tx.select({value: count()})",
    budgetMs: 40,
    budgetRows: 1,
    sql: `
      SELECT count(*) AS value
        FROM contacts c
       WHERE c.tenant_id = $1 AND c.deleted_at IS NULL`,
  },

  {
    id: "audit.page",
    title: "Audit trail, keyset page (the repo's gold-standard pagination)",
    source: "server/actions/audit-trail.ts:325 loadAuditTrail()",
    budgetMs: 25,
    budgetRows: 51,
    sql: `
      SELECT id, action, resource_type, resource_id, created_at
        FROM audit_logs
       WHERE tenant_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 51`,
  },

  {
    id: "audit.byResource",
    title: "Audit history for one record (the record-detail drawer)",
    source: "server/audit.ts:780 listAuditForResource()",
    budgetMs: 25,
    budgetRows: 200,
    sql: `
      SELECT id, action, created_at
        FROM audit_logs
       WHERE tenant_id = $1
         AND resource_type = 'sales_invoice'
       ORDER BY created_at DESC
       LIMIT 200`,
  },

  {
    id: "journal.trialBalance",
    title: "Trial balance — sum per ledger, per side",
    source: "server/actions/accounting.ts getLedgers() / period close",
    budgetMs: 120,
    budgetRows: 200,
    sql: `
      SELECT ledger_id, entry_type, sum(amount_minor) AS total_minor, count(*) AS legs
        FROM journal_entries
       WHERE tenant_id = $1
       GROUP BY ledger_id, entry_type
       ORDER BY ledger_id, entry_type`,
  },

  {
    id: "journal.byLedger",
    title: "Ledger statement — one account, newest first",
    source: "server/actions/accounting.ts:1416 getLedgerEntries()",
    budgetMs: 25,
    budgetRows: 200,
    sql: `
      SELECT id, transaction_id, entry_type, amount_minor, created_at
        FROM journal_entries
       WHERE tenant_id = $1 AND ledger_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
  },

  {
    id: "journal.byTransaction",
    title: "The legs of one posting (drill-down from a transaction)",
    source: "server/actions/accounting.ts transaction detail",
    budgetMs: 15,
    budgetRows: 20,
    sql: `
      SELECT id, ledger_id, entry_type, amount_minor
        FROM journal_entries
       WHERE tenant_id = $1 AND transaction_id = $2`,
  },

  {
    id: "stock.balance",
    title: "On-hand balance per item per warehouse",
    source: "server/actions/inventory.ts:502; server/actions/stock-counts.ts:444",
    /**
     * ⚠️ DERIVED. The application reads `stock_balances`, a maintained
     * summary table, for on-hand figures. This aggregate over
     * `stock_movements` is what a reconciliation or a rebuild of that
     * summary costs, and it is the shape `server/actions/landed-cost.ts:316`
     * uses per share in a loop. It is in the catalogue because it is the
     * largest tenant-scoped aggregate in the product after the trial
     * balance.
     */
    derived: "aggregate rebuild of the stock_balances summary from stock_movements",
    budgetMs: 120,
    budgetRows: 20000,
    sql: `
      SELECT stock_item_id, warehouse_id, sum(quantity) AS on_hand
        FROM stock_movements
       WHERE tenant_id = $1
       GROUP BY stock_item_id, warehouse_id`,
  },

  {
    id: "invoice.detail",
    title: "One invoice with its lines",
    source: "server/actions/sales-invoices.ts:1762 getInvoiceDetail()",
    budgetMs: 15,
    budgetRows: 20,
    sql: `
      SELECT l.id, l.line_no, l.description, l.quantity, l.line_total_minor
        FROM sales_invoice_lines l
       WHERE l.tenant_id = $1 AND l.invoice_id = $2
       ORDER BY l.line_no`,
  },

  {
    id: "export.contacts",
    title: "Contact export — UNBOUNDED BY CONSTRUCTION",
    source: "server/export/datasets.ts:208 buildContactsDataset()",
    /**
     * ⚠️ THIS BUDGET IS DELIBERATELY THE ONE THAT FAILS. There is no
     * LIMIT in the source; `MAX_EXPORT_ROWS` in `server/export/render.ts:62`
     * is checked AFTER the whole result set is already in the heap. The
     * budget is set at the value a bounded version would meet, so the
     * gate reports the defect rather than blessing it.
     */
    budgetMs: 50,
    budgetRows: 1000,
    expectFail: "unbounded",
    sql: `
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
             co.name AS company_name
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = $1
       WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.created_at`,
  },

  {
    id: "changeLog.retentionSweep",
    title: "The per-tenant scan `prune_change_log()` does on every run",
    source: "SQL-FILES/0128_change_log_retention.sql:156 — `count(*)`/`DELETE ... WHERE changed_at < cutoff`",
    /**
     * ⚠️ `prune_change_log()` loops over tenants ON PURPOSE — the file
     * explains at line 113 that a single `DELETE FROM change_log` would
     * be scoped by RLS to nothing. The consequence is one scan PER
     * TENANT of the fastest-growing table in the product, and no index
     * on `change_log` begins with `tenant_id`.
     */
    budgetMs: 60,
    budgetRows: 1,
    sql: `
      SELECT count(*) AS n
        FROM change_log
       WHERE tenant_id = $1
         AND changed_at < now() - interval '180 days'`,
  },

  {
    id: "campaign.recipientBoard",
    title: "Campaign recipient counts (the send board)",
    source: "server/actions/campaigns.ts:266 getCampaignBoard()",
    /**
     * ⚠️ ANOTHER DELIBERATE FAILURE, AND ONE TRACK F CHOSE NOT TO FIX.
     *
     * `campaign_recipients` is one of the 11 tables under RLS with no
     * index leading with `tenant_id` — all three of its indexes lead
     * with `campaign_id`. So the send board counts by scanning every
     * recipient row the installation has ever produced.
     *
     * A `(tenant_id, campaign_id)` index WAS proposed and measured
     * (`db/indexes/candidates.mjs`), and `prove-indexes.mjs` REJECTED
     * it: the planner used it, buffer traffic fell 28%, and median time
     * did not move at all. That is below the bar this track set for
     * itself, so it is not shipped — an index that costs writes on a
     * fan-out table and buys 28% of pages is not obviously worth it at
     * 150,000 rows, and might be at 15,000,000.
     *
     * The budget is set at what a properly-indexed count SHOULD cost, so
     * the gate keeps reporting the gap rather than blessing the scan.
     * See TRACK-REPORT.md §4 for the number at which to revisit it.
     */
    budgetMs: 10,
    budgetRows: 1,
    expectFail: "no-tenant-leading-index",
    sql: `
      SELECT count(*) FILTER (WHERE is_included) AS included, count(*) AS total
        FROM campaign_recipients
       WHERE tenant_id = $1`,
  },

  {
    id: "audit.deepOffset",
    title: "Deep OFFSET — what `{page: 5000}` costs",
    source: "server/dynamic/records.ts:255 (page has no .max() in lib/validators/dynamic.ts:309)",
    /**
     * ⚠️ DERIVED. The unbounded-OFFSET pattern lives in
     * `server/dynamic/records.ts:255`, over a tenant's dynamic-object
     * table; `audit_logs` is used here only because it is the largest
     * seeded table with a stable ordering, so the cost of the pattern
     * can be measured at scale. The defect is the missing `.max()` on
     * `page`, not this table.
     */
    derived: "the deep-OFFSET pattern from records.ts, measured against audit_logs",
    /**
     * ⚠️ ALSO EXPECTED TO FAIL. `MAX_PAGE_OFFSET = 50_000` is declared in
     * `lib/pagination.ts:94` and consulted by no query in the repository.
     * This entry is the proof of that, in milliseconds.
     */
    budgetMs: 25,
    budgetRows: 50,
    expectFail: "deep-offset",
    sql: `
      SELECT id, action, created_at
        FROM audit_logs
       WHERE tenant_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 50 OFFSET 100000`,
  },
];

/**
 * Parameters that are not the tenant id are resolved against live data
 * at measurement time, so the catalogue carries no hard-coded uuids that
 * would rot the moment the seed is regenerated.
 */
export const EXTRA_PARAMS = {
  "journal.byLedger": (ctx) => [ctx.ledgerId],
  "journal.byTransaction": (ctx) => [ctx.transactionId],
  "invoice.detail": (ctx) => [ctx.invoiceId],
};
