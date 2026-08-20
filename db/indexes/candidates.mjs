/**
 * Ordence — Track F · INDEX CANDIDATES AND THE CLAIM EACH ONE MAKES
 * Version: v1.81.0-alpha · Wave 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY A CANDIDATE FILE AND NOT JUST A MIGRATION
 * ══════════════════════════════════════════════════════════════════════
 * An index is a permanent tax on every INSERT, UPDATE and DELETE on its
 * table, paid forever, in exchange for a read that somebody believed
 * would get faster. This repository's characteristic defect is things
 * that were built and never reached; an index the planner declines to
 * use is exactly that defect, in a form that also slows writes down.
 *
 * So every candidate here carries:
 *   • `claims` — the query ids from `scripts/perf/queries.mjs` it says
 *     it will improve.
 *   • `expectUsed` — the index must APPEAR IN THE PLAN of at least one
 *     claimed query, or it is rejected. This is the check that stops an
 *     unusable index shipping.
 *   • `minImprovement` — the fraction of median time it must remove, or
 *     it is rejected as not worth the write cost.
 *
 * `scripts/perf/prove-indexes.mjs` enforces all three by creating each
 * candidate, re-measuring, and dropping it again. A candidate that is
 * not in the ACCEPTED set at the bottom of the report does not get a
 * migration number.
 */

export const CANDIDATES = [
  {
    id: "sales_invoices_tenant_due_idx",
    table: "sales_invoices",
    ddl: `CREATE INDEX IF NOT EXISTS sales_invoices_tenant_due_idx
            ON sales_invoices (tenant_id, due_date)`,
    claims: ["invoices.overdue"],
    expectUsed: true,
    minImprovement: 0.5,
    /**
     * ⭐ THE REASONING, WHICH IS ABOUT LEAKPROOFNESS AND NOT ABOUT THIS
     * TABLE.
     *
     * `sales_invoices_status_idx (tenant_id, status, due_date)` already
     * exists and looks like the right index for this query. Under RLS
     * the planner will not use it, and the reason is in `pg_proc`:
     *
     *     SELECT proname, proleakproof FROM pg_proc WHERE proname='enum_eq';
     *      enum_eq | f
     *
     * A qual that is NOT leakproof cannot be evaluated before the
     * row-security qual — otherwise an error message from the operator
     * could reveal a row the policy would have hidden. `status` is an
     * enum, so `status = ANY(...)` is stuck behind the RLS filter and
     * cannot become an index condition. `due_date < CURRENT_DATE` uses
     * `date_lt`, which IS leakproof, so it can.
     *
     * Hence: an index whose second column is the LEAKPROOF one. The
     * planner walks it in `due_date` order and the LIMIT stops it early,
     * instead of materialising every invoice the tenant has ever issued
     * and sorting them.
     */
    why: "enum_eq is not leakproof, so `status` cannot become an index condition under RLS; `due_date` can",
  },

  {
    id: "audit_logs_tenant_keyset_idx",
    table: "audit_logs",
    ddl: `CREATE INDEX IF NOT EXISTS audit_logs_tenant_keyset_idx
            ON audit_logs (tenant_id, created_at DESC, id DESC)`,
    claims: ["audit.page"],
    expectUsed: true,
    minImprovement: 0.2,
    /**
     * ⚠️ THE SECOND CRITERION, AND WHY THIS CANDIDATE NEEDS IT.
     * On a local SSD with the whole table in shared buffers this saves
     * almost no wall-clock. On Neon it saves two thirds of the pages the
     * query touches, and a page miss there is a network round trip to a
     * page server, not a memory read. Buffers are the honest currency.
     */
    minBufferImprovement: 0.5,
    /**
     * The existing `audit_logs_tenant_created_idx (tenant_id, created_at)`
     * cannot satisfy `ORDER BY created_at DESC, id DESC` — the tiebreak
     * column is not in it. Audit rows arrive in bursts and share a
     * timestamp, so the tiebreak is not decorative: it is what stops the
     * cursor in `audit-trail.ts:325` from returning overlapping pages.
     */
    why: "the keyset cursor orders by (created_at DESC, id DESC) and no index carries the tiebreak",
  },

  {
    id: "journal_entries_trial_balance_cover",
    table: "journal_entries",
    ddl: `CREATE INDEX IF NOT EXISTS journal_entries_trial_balance_cover
            ON journal_entries (tenant_id, ledger_id, entry_type) INCLUDE (amount_minor)`,
    claims: ["journal.trialBalance"],
    expectUsed: true,
    minImprovement: 0.2,
    why: "an index-only scan would avoid the 6,800-page heap scan the trial balance does today",
  },

  {
    id: "stock_movements_balance_cover",
    table: "stock_movements",
    ddl: `CREATE INDEX IF NOT EXISTS stock_movements_balance_cover
            ON stock_movements (tenant_id, stock_item_id, warehouse_id) INCLUDE (quantity)`,
    claims: ["stock.balance"],
    expectUsed: true,
    minImprovement: 0.2,
    why: "on-hand balance reads only three key columns plus quantity; the heap visit is pure waste",
  },

  {
    id: "change_log_tenant_changed_at_idx",
    table: "change_log",
    ddl: `CREATE INDEX IF NOT EXISTS change_log_tenant_changed_at_idx
            ON change_log (tenant_id, changed_at)`,
    claims: ["changeLog.retentionSweep"],
    expectUsed: true,
    minImprovement: 0.5,
    /**
     * 🔴 THE WORST-INDEXED TABLE IN THE SCHEMA, AND THE ONE THAT GROWS
     * FASTEST.
     *
     * `change_log` carries a `tenant_id` column and FORCE RLS, and its
     * only two indexes are `(tenant_id, seq) WHERE synced_at IS NULL` —
     * partial, so unusable for a general read — and `(table_name,
     * row_id, seq DESC)`, which does not begin with `tenant_id`. So
     * every tenant-scoped read of it is a full sequential scan.
     *
     * That would be tolerable on a small table. `record_change()` is
     * attached to 289 tables and writes a full `to_jsonb` image FOR EACH
     * ROW of every INSERT, UPDATE and DELETE — measured at 2 change_log
     * rows per `journal_entries` insert, because the `update_ledger_balance`
     * trigger's write to `ledgers` logs itself as well.
     *
     * And `prune_change_log()` (SQL-FILES/0128:113) loops over tenants
     * BY DESIGN, because a single un-scoped DELETE would be filtered to
     * nothing by RLS. One full scan per tenant, per retention run, of
     * the biggest table in the database.
     */
    why: "prune_change_log() scans the whole table once per tenant and no index leads with tenant_id",
  },

  {
    id: "campaign_recipients_tenant_idx",
    table: "campaign_recipients",
    ddl: `CREATE INDEX IF NOT EXISTS campaign_recipients_tenant_idx
            ON campaign_recipients (tenant_id, campaign_id)`,
    claims: ["campaign.recipientBoard"],
    expectUsed: true,
    minImprovement: 0.3,
    minBufferImprovement: 0.5,
    /**
     * All three existing indexes lead with `campaign_id`. Under RLS the
     * implicit predicate is on `tenant_id`, which none of them can
     * serve, so the board counts by scanning every recipient row the
     * whole installation has ever produced — a table that grows as
     * campaigns × audience.
     */
    why: "all three existing indexes lead with campaign_id; the RLS predicate is on tenant_id",
  },

  {
    id: "contacts_tenant_live_idx",
    table: "contacts",
    ddl: `CREATE INDEX IF NOT EXISTS contacts_tenant_live_idx
            ON contacts (tenant_id, created_at) WHERE deleted_at IS NULL`,
    claims: ["contacts.count", "export.contacts"],
    expectUsed: true,
    minImprovement: 0.2,
    why: "every contact list and every export filters `deleted_at IS NULL` and no index carries it",
  },
];

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHERE THE REMOVAL RULE LIVES, AND WHY IT IS NOT IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * A first draft of this file exported a `REMOVAL_RULES` array describing
 * the two categories of index to drop. Nothing consumed it. That is
 * precisely this repository's characteristic defect — declared and
 * unenforced — committed in the file whose job is to prevent it, so it
 * was deleted rather than left as decoration.
 *
 * The rule is `ordence_index_health()` in
 * `SQL-FILES/0155_perf_index_health_function.sql`. It is SQL because its
 * three consumers are SQL or read the catalogue:
 *
 *   • SQL-FILES/0156  drops the exact duplicates
 *   • SQL-FILES/0157  drops the redundant bare (tenant_id) indexes
 *   • scripts/perf/check-index-health.mjs  fails the build if either returns
 *
 * One definition, three consumers. Two copies of a rule are two rules,
 * and the second one is always the one that is wrong.
 */
