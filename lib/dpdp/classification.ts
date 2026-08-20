/**
 * Ordence — ⭐⭐⭐ THE PERSONAL-DATA INVENTORY
 * Version: v1.68.0-alpha
 *
 * Pure data. No database, no imports beyond types.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE IS FOR, IN ONE SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * An export or an erasure that quietly misses a table is worse than not
 * having the feature, because the customer believes they have complied
 * and they have not. This file is the list of every table in the schema
 * and, for each, whether it holds personal data and how to find the rows
 * belonging to one named person.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ HOW THIS LIST WAS ESTABLISHED, AND WHAT THAT DOES AND DOES NOT PROVE
 * ══════════════════════════════════════════════════════════════════════
 * ① Every `pgTable(...)` in `db/schema/*.ts` was parsed for its column
 *    names. 296 tables. Not read from memory, not from a doc.
 * ② `lib/dpdp/detector.ts` was run over every column name.
 * ③ Reach was derived from column naming conventions and then
 *    HAND-CORRECTED where reading the output showed the derivation was
 *    wrong — `audit_logs` had been pointed at `schedule_resources`
 *    because both have a `resource_id`; `saved_views` at a user because
 *    `group_by` ends in `_by`; `depreciation_lines` at `payroll_runs`
 *    because both have a `run_id`. There were about thirty of these.
 * ④ `scripts/check-data-classification.mjs` re-derives ① and ② on every
 *    build and fails when this file disagrees with the schema.
 *
 * 🔴 WHAT ④ PROVES: no table carrying personal-data-shaped columns can
 *    be added without somebody deciding what it holds. That is the
 *    property that survives the next module.
 *
 * ⚠️ WHAT IT DOES NOT PROVE: that every reach below is CORRECT. The gate
 *    checks that each declared column exists, that each parent resolves,
 *    that no chain cycles and that every chain terminates at a principal.
 *    It cannot check that `demand_notices.lead_id` means what it looks
 *    like it means. The direct-identifier tables were read individually;
 *    the link-only tables were structurally validated and not
 *    individually eyeballed. Saying so is the point — \"I found no
 *    counter-example\" and \"it is correct\" are different claims.
 *
 * ⚠️ AND THE SCHEMA IS NOT THE DATABASE. Roughly 296 tables are declared
 *    in Drizzle against 319 reported live by `/api/diag`. The difference
 *    is tables created only in SQL. The gate reads the schema, so a
 *    SQL-only table carrying personal data is invisible to it. That is a
 *    stated gap, not a solved problem.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A NOTE ON FOREIGN KEYS, WHICH IS THE REASON REACH IS DECLARED AND
 *    NOT WALKED
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is to walk the foreign keys. It does not work here.
 * `tds_deductions.deductee_id`, `demand_notices.lead_id`,
 * `purchase_invoices.vendor_id`, `notifications.user_id`,
 * `audit_logs.actor_user_id` and `saved_views.owner_user_id` carry NO
 * `.references()` in the Drizzle schema — the constraint lives in the
 * SQL file, added later, or was left off deliberately to break an import
 * cycle (see the comment on `consents.leadId`). An export that walked
 * Drizzle's foreign keys would silently skip every one of them.
 *
 * So the edge is declared here and the GATE checks the column exists.
 */

import type { RetentionRuleId } from "./retention";

/* ------------------------------------------------------------------ */
/* THE PRINCIPALS                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE NINE KINDS OF PERSON THIS PRODUCT HOLDS RECORDS ABOUT.
 *
 * ⚠️ NOT ALL OF THEM ARE DATA PRINCIPALS EVERY TIME. `vendor` and
 * `partner` are frequently companies, and a company is not a Data
 * Principal — s.2(j) says "the individual to whom the personal data
 * relates". A sole proprietorship IS an individual, and no column in
 * this schema tells the two apart. The engine therefore treats them as
 * principals and the workspace decides, rather than the reverse: a
 * refusal on the ground that we assumed you were a company is a refusal
 * the Act does not permit us to make by guessing.
 */
export type PrincipalKind =
  | "contact"
  | "lead"
  | "employee"
  | "user"
  | "worker"
  | "deductee"
  | "landowner"
  | "partner"
  | "vendor";

export const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  "contact", "lead", "employee", "user", "worker", "deductee", "landowner", "partner", "vendor",
];

/** The table each principal kind lives in. Cross-checked by the gate. */
export const PRINCIPAL_TABLES: Record<PrincipalKind, string> = {
  contact: "contacts",
  lead: "leads",
  employee: "employees",
  user: "users",
  worker: "site_workers",
  deductee: "tds_deductees",
  landowner: "landowners",
  partner: "channel_partners",
  vendor: "vendors",
};

/* ------------------------------------------------------------------ */
/* THE REACH                                                           */
/* ------------------------------------------------------------------ */

export type IdentifierKind = "email" | "phone";

/**
 * 🔴 HOW TO SELECT THE ROWS OF ONE TABLE THAT BELONG TO ONE PERSON.
 *
 * A table may have SEVERAL reaches and usually does. A `bookings` row
 * belongs to the allottee who bought the flat, to the sales
 * representative who sold it and to the channel partner who introduced
 * them — three different people, three legitimate access requests, one
 * row. Modelling one reach per table would have silently answered two of
 * those three requests with nothing.
 */
export type Reach =
  /** The table IS the person. */
  | { via: "self"; principal: PrincipalKind }
  /** A column on this table holds the principal's id. */
  | { via: "column"; column: string; principal: PrincipalKind }
  /** A column on this table points at another table that has its own reach. */
  | { via: "parent"; column: string; table: string }
  /**
   * ⭐ THE OTHER DIRECTION: another table points at THIS one. Used for
   * `companies`, which no contact-shaped column reaches, but which a
   * contact's `company_id` points at.
   */
  | { via: "reverse"; column: string; from: string }
  /**
   * ⚠️ MATCHED BY VALUE, NOT BY ID. `email_outbox.to_email` is a string
   * somebody typed. There is no key to join on, and an export that only
   * joined keys would never tell a person which emails were sent to them.
   */
  | { via: "identifier"; column: string; identifier: IdentifierKind }
  /**
   * 🔴 `subject_id` PLUS A DISCRIMINATOR COLUMN, WITH NO FOREIGN KEY.
   * The discriminator's values are data, not schema, so this reach is
   * only as good as what the writers put in it.
   */
  | { via: "polymorphic"; idColumn: string; kindColumn: string }
  /** 🔴 AN ADMITTED GAP. Printed in the export manifest, never hidden. */
  | { via: "none"; because: string };

export type Holds =
  /** The row is a person's record. */
  | "principal"
  /** The row contains or relates to personal data. */
  | "personal"
  /** 🔴 No personal data. `because` is mandatory and the gate enforces it. */
  | "operational";

/**
 * 🔴🔴 WHOSE DUTY IS THIS ROW UNDER? THE TWO HATS, MADE STRUCTURAL.
 *
 * For a workspace's contacts, employees and allottees the WORKSPACE is
 * the Data Fiduciary and Ordence is its Processor. For Ordence's own
 * staff, Ordence's billing records and Ordence's platform logs, ORDENCE
 * is the Fiduciary. The same database holds both.
 *
 * ⚠️ THIS FIELD EXISTS BECAUSE THE FIRST WORKING VERSION OF THE ERASURE
 * PLANNER PUT `platform_staff` IN THE DELETE LIST. A contact of a
 * customer asked a builder to forget them, and the plan proposed
 * deleting the row identifying an Ordence support engineer. Nothing
 * caught it: `retention.ts` already carried a paragraph explaining that
 * the two roles must not mix, and a paragraph enforces nothing. That is
 * defect number twelve in this codebase's own list, reproduced inside
 * the batch written to stop it.
 *
 * ⭐ The gate now derives half of this mechanically: a table with no
 * `tenant_id` column CANNOT be tenant-scoped, and saying otherwise
 * fails the build.
 */
export type Scope =
  /** The workspace is the Data Fiduciary. A tenant request may reach it. */
  | "tenant"
  /**
   * 🔴 ORDENCE IS THE DATA FIDUCIARY. A workspace's data-principal
   * request must NEVER reach these rows — doing so would disclose one
   * Fiduciary's records in answer to a request made to another.
   */
  | "platform";

export type TableClassification = {
  table: string;
  holds: Holds;
  scope: Scope;
  /** Required where a tenant-scoped table is nevertheless `platform`. */
  scopeNote?: string;
  /** Required when `holds` is "operational". Enforced by the gate. */
  because?: string;
  reaches: readonly Reach[];
  /** ⚠️ null means s.8(7) applies with no exception: erase on request. */
  retention: RetentionRuleId | null;
  /**
   * ⭐ Whether the identifying columns can be blanked while leaving a
   * statutory record intact. Almost always false: a tax invoice without
   * the recipient's name is not a tax invoice under CGST Rule 46.
   */
  redactable?: boolean;
};

/* ------------------------------------------------------------------ */
/* THE INVENTORY                                                       */
/* ------------------------------------------------------------------ */


/* ================================================================== */
/* db/schema/accounting.ts                                           */
/* ------------------------------------------------------------------ */
/* The ledger. Personal data here is thin — a counterparty name on   */
/* a journal line — but the ROWS are books of account and s.128(5)   */
/* holds them for eight financial years whatever anybody asks.       */
/* ================================================================== */

const LEDGERS: TableClassification = {
  table: "ledgers",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const TRANSACTIONS: TableClassification = {
  table: "transactions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const JOURNAL_ENTRIES: TableClassification = {
  table: "journal_entries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const FINANCIAL_PERIODS: TableClassification = {
  table: "financial_periods",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "closed_by", principal: "user" },
    { via: "column", column: "reopened_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const SALES_POSTING_ACCOUNTS: TableClassification = {
  table: "sales_posting_accounts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const BILLING_RATES: TableClassification = {
  table: "billing_rates",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const TIME_ENTRIES: TableClassification = {
  table: "time_entries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "column", column: "user_id", principal: "user" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/agents.ts                                               */
/* ================================================================== */

const AGENT_DEFINITIONS: TableClassification = {
  table: "agent_definitions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const AGENT_TRIGGERS: TableClassification = {
  table: "agent_triggers",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const AGENT_RUNS: TableClassification = {
  table: "agent_runs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "started_by", principal: "user" },
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/ai-credentials.ts                                       */
/* ================================================================== */

const AI_PROVIDER_CREDENTIALS: TableClassification = {
  table: "ai_provider_credentials",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/ai-patterns.ts                                          */
/* ================================================================== */

const TENANT_PATTERNS: TableClassification = {
  table: "tenant_patterns",
  scope: "tenant",
  holds: "operational",
  because: "aggregated behaviour counts keyed on a pattern string. ⚠️ `pattern_data` is jsonb written only by server/ai. If a pattern key ever carries a customer name this line becomes wrong and nothing will say so.",
  reaches: [
    { via: "none", because: "aggregated behaviour counts keyed on a pattern string, with no subject column. ⚠️ `pattern_data` is jsonb and is written only by server/ai — if a pattern key ever carries a customer name this becomes reachable and this line becomes wrong." },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/appraisals.ts                                           */
/* ================================================================== */

const REPORTING_LINES: TableClassification = {
  table: "reporting_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const APPRAISAL_CYCLES: TableClassification = {
  table: "appraisal_cycles",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const APPRAISAL_SUBJECTS: TableClassification = {
  table: "appraisal_subjects",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "manager_employee_id", principal: "employee" },
    { via: "column", column: "skip_level_employee_id", principal: "employee" },
    { via: "parent", column: "cycle_id", table: "appraisal_cycles" },
    { via: "column", column: "signed_off_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const APPRAISAL_REVIEWS: TableClassification = {
  table: "appraisal_reviews",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "reviewer_employee_id", principal: "employee" },
  ],
  retention: "wage-registers-code-rules",
};
const APPRAISAL_AMENDMENTS: TableClassification = {
  table: "appraisal_amendments",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "amended_by_employee_id", principal: "employee" },
    { via: "column", column: "amended_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};

/* ================================================================== */
/* db/schema/assets.ts                                               */
/* ================================================================== */

const ASSETS: TableClassification = {
  table: "assets",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "primary_contact_id", principal: "contact" },
    { via: "column", column: "assigned_user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: null,
};
const ASSET_RELATIONSHIPS: TableClassification = {
  table: "asset_relationships",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/auth.ts                                                 */
/* ------------------------------------------------------------------ */
/* `permission_denials` is append-only (0005) and records who was    */
/* refused what, from which IP. A refusal log is personal data       */
/* about the person refused.                                         */
/* ================================================================== */

const PERMISSION_DENIALS: TableClassification = {
  table: "permission_denials",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};

/* ================================================================== */
/* db/schema/banking.ts                                              */
/* ================================================================== */

const BANK_ACCOUNTS: TableClassification = {
  table: "bank_accounts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const BANK_STATEMENTS: TableClassification = {
  table: "bank_statements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "bank_account_id", table: "bank_accounts" },
    { via: "column", column: "imported_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const BANK_STATEMENT_LINES: TableClassification = {
  table: "bank_statement_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "statement_id", table: "bank_statements" },
    { via: "parent", column: "bank_account_id", table: "bank_accounts" },
  ],
  retention: "companies-act-128-5",
};
const BANK_LINE_MATCHES: TableClassification = {
  table: "bank_line_matches",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "confirmed_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
/**
 * ⭐⭐⭐ ADDED ON MERGE, NOT BY BRIEF H, AND THE GATE IS WHY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 H's OWN CHECK CAUGHT A CROSS-STREAM HOLE ON ITS FIRST RUN
 * ══════════════════════════════════════════════════════════════════════
 * `bank_charge_itc_deferrals` was created by 0110, in a different stream,
 * after Brief H had finished reading the schema. `check:data-classification`
 * refused the merged tree the moment both landed:
 *
 *     `supplier_gstin` matched the "gstin" rule (identifier) and
 *     lib/dpdp/classification.ts does not classify it.
 *
 * ⚠️ THAT IS EXACTLY THE FAILURE THE INVENTORY EXISTS FOR — a table
 * nobody classified is a table the export does not search and the
 * erasure planner does not consider, and neither says so.
 *
 * ⭐ AND THE HONEST ANSWER IS NOT "ADD IT TO THE EXPORT". The GSTIN on
 * this row belongs to A BANK. s.2(j) DPDPA 2023 defines a Data Principal
 * as "the individual to whom the personal data relates", and a banking
 * company is not an individual — the same reasoning `companies` carries
 * below. The identifier rule fired on the column NAME, which is the
 * right way for a detector to be wrong: loudly.
 *
 * 🔴 THE ROW IS STILL `personal`, FOR A DIFFERENT REASON. `resolved_by`
 * and `credit_posted_by` are `users` rows — Ordence staff or the
 * workspace's own people — and a person is entitled to know that they
 * transcribed a bank invoice and posted the credit on it. The reach is
 * through those columns and through the statement line, never through
 * the GSTIN.
 */
/* ================================================================== */
/* db/schema/billing.ts · SEATS — 0114                                */
/* ================================================================== */

/**
 * ⭐⭐⭐ ADDED WITH 0114, BECAUSE THE GATE REFUSED THE BATCH WITHOUT IT.
 *
 * `check:data-classification` caught both of these the moment the tables
 * landed: `granted_by_user_id` and `user_id` matched the "link-user"
 * rule. That is the check doing precisely its job on a batch written by
 * somebody who was thinking about seats and not about DPDPA.
 */

/**
 * 🔴 A SEAT REQUEST IS PERSONAL DATA ABOUT THE PERSON WAITING, AND THE
 * DECLINE REASON IS THE PART THAT MATTERS.
 *
 * The row records that a named individual was added to a workspace,
 * withheld a seat, waited, and was let in or refused — and if refused, a
 * sentence written ABOUT THEM by their employer explaining why. *"Left
 * the company before their start date"* is a statement about a person
 * held by a Data Fiduciary, and s.11 DPDPA entitles them to a copy of it.
 *
 * ⚠️ SO THIS MUST BE IN THE EXPORT. An access request that returned
 * everything except the note explaining why somebody was never given
 * access would be omitting the one record they are most likely to be
 * asking about.
 *
 * ⚠️ NO STATUTORY RETENTION. It is not a book of account and not an
 * employment record; erasure may remove it. `resolved_by` is reached
 * separately because the person who made the decision is also a Data
 * Principal, and a request from THEM should show that they made it.
 */
const SEAT_REQUESTS: TableClassification = {
  table: "seat_requests",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
    { via: "column", column: "resolved_by", principal: "user" },
  ],
  retention: null,
};

/**
 * ⚠️ A SEAT GRANT IS ABOUT CAPACITY, NOT ABOUT A PERSON — and it is still
 * `personal`, for one column.
 *
 * The grant itself is a commercial concession to a WORKSPACE, and a body
 * corporate is not a Data Principal (s.2(j)). What makes the row personal
 * is `granted_by_user_id`: somebody decided to give a customer free
 * capacity and wrote a reason, and that is an act attributable to a named
 * individual.
 *
 * 🔴 THE `seats` FIGURE AND THE `reason` ARE NOT THE PRINCIPAL'S DATA.
 * An access request from the person who granted it discloses that they
 * granted it; it does not entitle a workspace's contact to the commercial
 * terms Ordence gave that workspace.
 *
 * ⚠️ EIGHT YEARS. A grant changes what a customer was charged, so it is
 * evidence behind the books under s.128(5) Companies Act 2013 and erasure
 * must refuse inside that period.
 */
/**
 * ⭐⭐⭐ THE EXPORT LOG — SQL 0116 · WAVE 5
 *
 * 🔴 THE ONE TABLE IN THE INVENTORY WHOSE SUBJECT IS THE INVENTORY. Every
 * row records that personal data belonging to somebody ELSE left the
 * workspace, and names the person who took it.
 *
 * ⚠️ SO IT IS PERSONAL DATA ABOUT THE EXPORTER, AND `exported_by` IS THE
 * ONLY REACH. `personal_columns` holds COLUMN HEADINGS — "Name", "Mobile",
 * "PAN" — not values, so it is not a second copy of anybody's record and a
 * Data Principal export must not return other people's rows from it.
 *
 * 🔴 AND ERASURE MUST REFUSE. A departing employee asking for erasure of
 * the record of the exports they ran is asking for the one row an
 * investigation would need. s.8(5) DPDPA makes the Data Fiduciary
 * answerable for the personal data it disclosed, and that answerability
 * cannot be deleted by the person who caused the disclosure.
 *
 * ⚠️ 180 DAYS IS THE FLOOR, NOT THE CEILING. CERT-In's 28 April 2022
 * direction requires ICT system logs to be kept for 180 days within India,
 * and this is such a log. The DPDPA answerability argument runs longer;
 * where the two disagree the longer one governs, and this field records
 * the one that is a hard statutory refusal.
 */
const DATA_EXPORTS: TableClassification = {
  table: "data_exports",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "exported_by", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};

/* ================================================================== */
/* db/schema/import-runs.ts — SQL 0117 · WAVE 6                       */
/* ------------------------------------------------------------------ */
/* ⭐ THE MIGRATION TABLES. None of them holds the customer's FILE —  */
/* see the schema header — so none of them is a copy of the data a    */
/* Data Principal would ask about. What they hold is who ran the      */
/* migration and whether it finished.                                 */
/* ================================================================== */

/**
 * ⭐⭐ THE RUN. Personal data about the person who ran it, and nothing
 * else: `source_name` is a FILE NAME they chose, `expected_rows` is a
 * count.
 *
 * 🔴 ERASURE MUST REFUSE INSIDE THE STATUTORY WINDOW. A migration run is
 * the provenance of every record it created — "where did these 40,000
 * customers come from" has exactly one answer and this row is it. Under
 * s.128(5) Companies Act 2013 the books and the vouchers behind them are
 * kept for eight financial years, and a migration that created the
 * opening position is behind all of them.
 */
const IMPORT_RUNS: TableClassification = {
  table: "import_runs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "started_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/**
 * ⚠️ THE CHUNKS HOLD NO PERSONAL DATA AT ALL — they are counts and an
 * index — but they are NOT classified `none`, because they are reached
 * through the run and an erasure planner that treats them as unrelated
 * would leave orphaned evidence of a run it had removed.
 */
const IMPORT_RUN_CHUNKS: TableClassification = {
  table: "import_run_chunks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "run_id", table: "import_runs" },
  ],
  retention: "companies-act-128-5",
};

/**
 * ⭐ THE PROPOSAL. `source_headers` are the customer's own COLUMN
 * HEADINGS, not their data, and `proposal` maps one heading to one field.
 *
 * ⚠️ THAT IS A DELIBERATE PROPERTY OF WAVE 6 AND NOT AN ACCIDENT.
 * `server/import/ai-mapper.ts` sends headings and statistical
 * descriptions to a model and never a value, so this table can record
 * exactly what was sent without becoming a second copy of anybody's
 * personal data.
 */
const IMPORT_MAPPING_PROPOSALS: TableClassification = {
  table: "import_mapping_proposals",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "proposed_for", principal: "user" },
    { via: "parent", column: "run_id", table: "import_runs" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/import-runs.ts — SQL 0205 to 0210 · PHASE 2              */
/* ------------------------------------------------------------------ */
/* ⭐ THE MIGRATION LEDGER: what a run wrote, what the rows said       */
/* before it, and what an undo could not put back.                     */
/* ================================================================== */

/**
 * ⭐ THE SIDECAR. One row per row a migration wrote: which run, which
 * input line, which destination table and id, and whether the run created
 * that row or overwrote one that already existed.
 *
 * ⚠️ IT HOLDS NO PERSONAL DATA OF ITS OWN — no name, no address, no
 * value — and it is NOT classified `operational` for the same reason
 * `import_run_chunks` is not: it is a POINTER at rows that do, in a table
 * chosen at run time. An erasure planner that treated it as unrelated
 * would remove a person's `contacts` row and leave behind a record saying
 * which file and which line it came from, keyed by an id that no longer
 * resolves — evidence of an erased person, surviving the erasure.
 *
 * 🔴 AND `target_id` IS THE PART THAT MATTERS FOR A DATA-PRINCIPAL
 * EXPORT. "Where did my record come from?" is a question a data principal
 * may ask, and this table is the only thing in the product that can
 * answer it.
 */
const IMPORT_ROW_PROVENANCE: TableClassification = {
  table: "import_row_provenance",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "run_id", table: "import_runs" },
  ],
  retention: "companies-act-128-5",
};

/**
 * 🔴🔴 THE MOST PERSONAL-DATA-CARRYING TABLE IN THIS BATCH, AND THE
 *      DETECTOR DOES NOT SEE IT.
 *
 * `prior_values` is a VERBATIM COPY of a destination row as it stood
 * before a migration overwrote it. For the two contracted entities that
 * declare `restore-prior`, `capturePriorFields` is `["*"]` — so a row
 * here is a whole `companies` record, address and all, or a whole
 * `gst_parties` record including its GSTIN and PAN.
 *
 * ⚠️ `scripts/check-data-classification.mjs` DID NOT FLAG THIS TABLE.
 * Its 41 rules match on COLUMN NAMES, and no rule matches `prior_values`
 * — `freeform-jsonb` looks for `detail`, `details`, `payload`,
 * `metadata`, `raw` and `lines`. A column that holds an entire copy of
 * another table under a name the detector has never heard of is invisible
 * to it. The entry below is written because the table needs it, not
 * because the gate asked; the gap itself is written up in
 * PATCH-REQUEST-PHASE-2.md, because the next phase to store a customer
 * record under an unusual column name will hit it too.
 *
 * ⚠️ ERASURE HAS TO REACH IT. Erasing a person from `contacts` while a
 * verbatim pre-migration copy of their record sits here would be an
 * erasure that removed the visible copy and kept the hidden one.
 */
const IMPORT_ROW_PRIOR_VALUES: TableClassification = {
  table: "import_row_prior_values",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "run_id", table: "import_runs" },
  ],
  retention: "companies-act-128-5",
};

/**
 * ⭐ ONE ATTEMPT TO UNDO ONE MIGRATION. `requested_by` is a person, which
 * is what the detector matched on; the rest is counts and a sentence.
 */
const IMPORT_REVERSALS: TableClassification = {
  table: "import_reversals",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "requested_by", principal: "user" },
    { via: "parent", column: "run_id", table: "import_runs" },
  ],
  retention: "companies-act-128-5",
};

/**
 * ⭐ THE ROWS AN UNDO COULD NOT UNDO, AND WHAT BLOCKED EACH ONE.
 *
 * ⚠️ `blocked_by` IS THE DATABASE'S OWN ERROR MESSAGE, AND POSTGRES PUTS
 * VALUES IN THOSE. A unique-violation detail names the conflicting key; a
 * check-constraint violation prints the whole failing row. So this column
 * can and does contain fragments of customer records, and classifying it
 * `operational` because "it is only an error message" would be exactly
 * wrong.
 */
const IMPORT_REVERSAL_FAILURES: TableClassification = {
  table: "import_reversal_failures",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "reversal_id", table: "import_reversals" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/drawings.ts — SQL 0118 · WAVE 7                          */
/* ------------------------------------------------------------------ */
/* ⭐ THE DRAWING REGISTER. The DRAWINGS are the customer's technical  */
/* documents and hold no personal data in themselves; the register     */
/* around them records WHO issued, marked up and measured them, which  */
/* does.                                                               */
/* ================================================================== */

/**
 * ⚠️ A DRAWING IS A TECHNICAL DOCUMENT AND IS STILL PERSONAL DATA HERE,
 * because `created_by` names the person who put it in the register.
 *
 * 🔴 ERASURE MUST REFUSE INSIDE THE STATUTORY WINDOW. A drawing register
 * is the evidence of what was issued and built to. s.128(5) Companies Act
 * 2013 keeps the books and the vouchers behind them for eight financial
 * years, and a construction bill's vouchers are its measurements — which
 * cite the revision they came off.
 */
const DRAWINGS: TableClassification = {
  table: "drawings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/**
 * ⭐ `assumed_by` IS THE INTERESTING COLUMN AND THE REASON THIS TABLE IS
 * CLASSIFIED AT ALL. It names the person who decided what one drawing
 * unit means on a file that did not say — a measurement decision every
 * quantity taken off that sheet depends on.
 */
const DRAWING_REVISIONS: TableClassification = {
  table: "drawing_revisions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "drawing_id", table: "drawings" },
    { via: "column", column: "uploaded_by", principal: "user" },
    { via: "column", column: "assumed_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/**
 * 🔴 THE ONE HERE THAT GENUINELY HOLDS FREE TEXT ABOUT PEOPLE. A design
 * review comment is written by a named person about somebody else's work
 * — "the lintel level contradicts Ramesh's structural sheet" — and it is
 * exactly the kind of content a Data Principal access request under s.11
 * DPDPA is entitled to see.
 *
 * ⚠️ AND IT IS NOT ERASABLE ON REQUEST INSIDE THE WINDOW, for the same
 * reason the revision is not: a resolved comment is part of the record of
 * what was checked before construction.
 */
const DRAWING_MARKUPS: TableClassification = {
  table: "drawing_markups",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "revision_id", table: "drawing_revisions" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "resolved_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/**
 * ⚠️ A MEASURED QUANTITY IS A VOUCHER. It may already be in a running
 * bill, and `taken_by` is who is answerable for it.
 */
const DRAWING_MEASUREMENTS: TableClassification = {
  table: "drawing_measurements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "revision_id", table: "drawing_revisions" },
    { via: "column", column: "taken_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

const SEAT_GRANTS: TableClassification = {
  table: "seat_grants",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "granted_by_user_id", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

const BANK_CHARGE_ITC_DEFERRALS: TableClassification = {
  table: "bank_charge_itc_deferrals",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "statement_line_id", table: "bank_statement_lines" },
    { via: "parent", column: "bank_account_id", table: "bank_accounts" },
    { via: "column", column: "resolved_by", principal: "user" },
    { via: "column", column: "credit_posted_by", principal: "user" },
  ],
  /**
   * ⚠️ EIGHT YEARS, AND ERASURE MUST REFUSE INSIDE THAT. This row is the
   * evidence that an input tax credit was claimed and against which
   * invoice. s.128(5) Companies Act 2013 requires the books and the
   * vouchers behind them to be kept for eight financial years, and
   * s.16 CGST with Rule 36(4) is what an assessment reads it against.
   */
  retention: "companies-act-128-5",
};
const BANK_RECONCILIATIONS: TableClassification = {
  table: "bank_reconciliations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "bank_account_id", table: "bank_accounts" },
    { via: "parent", column: "statement_id", table: "bank_statements" },
    { via: "column", column: "signed_off_by", principal: "user" },
    { via: "column", column: "reopened_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const BANK_RECONCILIATION_ITEMS: TableClassification = {
  table: "bank_reconciliation_items",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "reconciliation_id", table: "bank_reconciliations" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/billing.ts                                              */
/* ------------------------------------------------------------------ */
/* ⚠️ ORDENCE'S OWN BOOKS, NOT THE CUSTOMER'S. Ordence is the Data   */
/* Fiduciary here, not the Processor. A workspace erasure request    */
/* must not reach these rows and a workspace export must not         */
/* disclose them.                                                    */
/* ================================================================== */

const PLANS: TableClassification = {
  table: "plans",
  scope: "platform",
  holds: "operational",
  because: "a price list",
  reaches: [
    { via: "none", because: "Ordence's price list. Identical for every workspace." },
  ],
  retention: "companies-act-128-5",
};
const SUBSCRIPTIONS: TableClassification = {
  table: "subscriptions",
  scope: "platform",
  scopeNote: "Ordence's commercial relationship with the workspace. Ordence is the Fiduciary for its own customer records.",
  holds: "operational",
  because: "the workspace's own subscription",
  reaches: [
    { via: "none", because: "the workspace's own subscription to Ordence. No natural person on the row; the billing contact is a `users` row and is reached there." },
  ],
  retention: "companies-act-128-5",
};
const INVOICES: TableClassification = {
  table: "invoices",
  scope: "platform",
  scopeNote: "Ordence invoicing the workspace. Ordence's books, under Ordence's s.128(5) duty. ⚠️ The workspace still receives these through the WHOLE-TENANT export in server/backup/export.ts, which is a different feature answering a different right.",
  holds: "personal",
  reaches: [
    { via: "parent", column: "subscription_id", table: "subscriptions" },
  ],
  retention: "companies-act-128-5",
};
const INVOICE_LINES: TableClassification = {
  table: "invoice_lines",
  scope: "platform",
  scopeNote: "lines of Ordence's own invoices.",
  holds: "personal",
  reaches: [
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
  ],
  retention: "companies-act-128-5",
};
const PAYMENT_EVENTS: TableClassification = {
  table: "payment_events",
  scope: "platform",
  scopeNote: "Ordence's payment-provider events.",
  holds: "personal",
  reaches: [
    { via: "parent", column: "subscription_id", table: "subscriptions" },
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
  ],
  retention: "companies-act-128-5",
};
const PAYMENT_METHODS: TableClassification = {
  table: "payment_methods",
  scope: "platform",
  scopeNote: "the workspace's card on file with Ordence.",
  holds: "personal",
  reaches: [
    { via: "column", column: "added_by_user_id", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/budgets.ts                                              */
/* ================================================================== */

const COST_CENTRES: TableClassification = {
  table: "cost_centres",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const BUDGET_LINES: TableClassification = {
  table: "budget_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/campaigns.ts                                            */
/* ================================================================== */

const CAMPAIGNS: TableClassification = {
  table: "campaigns",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "stop_requested_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const CAMPAIGN_RECIPIENTS: TableClassification = {
  table: "campaign_recipients",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "campaign_id", table: "campaigns" },
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "identifier", column: "phone_digits", identifier: "phone" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/clm.ts                                                  */
/* ------------------------------------------------------------------ */
/* Contracts. `contracts.legal_hold` is the only human-placed hold   */
/* in this build and it beats every other rule.                      */
/* ================================================================== */

const CONTRACTS: TableClassification = {
  table: "contracts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "parent", column: "asset_id", table: "assets" },
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "deal_id", table: "deals" },
    { via: "column", column: "owner_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const CONTRACT_VERSIONS: TableClassification = {
  table: "contract_versions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "contract_id", table: "contracts" },
    { via: "column", column: "author_user_id", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const CLAUSE_LIBRARY: TableClassification = {
  table: "clause_library",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};

/* ================================================================== */
/* db/schema/compliance.ts                                           */
/* ================================================================== */

const COMPLIANCE_OBLIGATIONS: TableClassification = {
  table: "compliance_obligations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "owner_user_id", principal: "user" },
  ],
  retention: null,
};
const COMPLIANCE_TASKS: TableClassification = {
  table: "compliance_tasks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "owner_user_id", principal: "user" },
    { via: "column", column: "completed_by_user_id", principal: "user" },
  ],
  retention: null,
};
const COMPLIANCE_EVIDENCE: TableClassification = {
  table: "compliance_evidence",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "uploaded_by_user_id", principal: "user" },
  ],
  retention: null,
};
const COMPLIANCE_LICENCES: TableClassification = {
  table: "compliance_licences",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "owner_user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/construction.ts                                         */
/* ================================================================== */

const BOQ_ITEM_MASTER: TableClassification = {
  table: "boq_item_master",
  scope: "tenant",
  holds: "operational",
  because: "item catalogue",
  reaches: [
    { via: "none", because: "the workspace's standard item catalogue." },
  ],
  retention: "limitation-article-55",
};
const BOQS: TableClassification = {
  table: "boqs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contractor_vendor_id", principal: "vendor" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "contract_id", table: "contracts" },
    { via: "column", column: "issued_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const BOQ_ITEMS: TableClassification = {
  table: "boq_items",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "boq_id", table: "boqs" },
    { via: "parent", column: "rate_analysis_id", table: "rate_analyses" },
  ],
  retention: "limitation-article-55",
};
const RATE_ANALYSES: TableClassification = {
  table: "rate_analyses",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const RATE_ANALYSIS_COMPONENTS: TableClassification = {
  table: "rate_analysis_components",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "rate_analysis_id", table: "rate_analyses" },
  ],
  retention: "limitation-article-55",
};
const BOQ_VARIATIONS: TableClassification = {
  table: "boq_variations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "boq_id", table: "boqs" },
    { via: "column", column: "submitted_by", principal: "user" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const BOQ_VARIATION_ITEMS: TableClassification = {
  table: "boq_variation_items",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "variation_id", table: "boq_variations" },
    { via: "parent", column: "boq_item_id", table: "boq_items" },
    { via: "parent", column: "rate_analysis_id", table: "rate_analyses" },
  ],
  retention: "limitation-article-55",
};
const MEASUREMENT_BOOKS: TableClassification = {
  table: "measurement_books",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "boq_id", table: "boqs" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const MEASUREMENT_ENTRIES: TableClassification = {
  table: "measurement_entries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "measurement_book_id", table: "measurement_books" },
    { via: "parent", column: "boq_item_id", table: "boq_items" },
    { via: "parent", column: "ra_bill_id", table: "ra_bills" },
    { via: "column", column: "measured_by", principal: "user" },
    { via: "column", column: "checked_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const CONTRACT_ADVANCES: TableClassification = {
  table: "contract_advances",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contractor_vendor_id", principal: "vendor" },
    { via: "parent", column: "boq_id", table: "boqs" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const RETENTION_LEDGER: TableClassification = {
  table: "retention_ledger",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contractor_vendor_id", principal: "vendor" },
    { via: "parent", column: "boq_id", table: "boqs" },
    { via: "parent", column: "ra_bill_id", table: "ra_bills" },
  ],
  retention: "limitation-article-55",
};

/* ================================================================== */
/* db/schema/contracting.ts                                          */
/* ================================================================== */

const WORKS_CONTRACTS: TableClassification = {
  table: "works_contracts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const COMPLIANCE_DOCS: TableClassification = {
  table: "compliance_docs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "verified_by", principal: "user" },
    { via: "column", column: "uploaded_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const ENGINEER_CERTIFICATIONS: TableClassification = {
  table: "engineer_certifications",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "contract_id", table: "contracts" },
    { via: "column", column: "certified_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const RA_BILLS: TableClassification = {
  table: "ra_bills",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "contract_id", table: "contracts" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "certified_by", principal: "user" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const RA_BILL_LINES: TableClassification = {
  table: "ra_bill_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "ra_bill_id", table: "ra_bills" },
    { via: "parent", column: "boq_item_id", table: "boq_items" },
  ],
  retention: "limitation-article-55",
};
const RETENTION_RELEASES: TableClassification = {
  table: "retention_releases",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "contract_id", table: "contracts" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};

/* ================================================================== */
/* db/schema/core.ts                                                 */
/* ------------------------------------------------------------------ */
/* 🔴 `audit_logs` is the hardest table in the schema for erasure:   */
/* append-only by trigger (0001) and hash-chained (0081). Its        */
/* refusal is `immutable-by-design`, NOT a statute.                  */
/* ================================================================== */

const TENANTS: TableClassification = {
  table: "tenants",
  scope: "platform",
  holds: "operational",
  because: "the workspace. A body corporate is not a Data Principal — s.2(j) says \"the individual to whom the personal data relates\". 🔴 But `deleted_at` on this row is where Ordence's OWN processor duty sits: see the batch report on the offboarding executor that does not exist.",
  reaches: [
    { via: "none", because: "the workspace itself. A body corporate, not a Data Principal (s.2(j))." },
  ],
  retention: null,
};
const USERS: TableClassification = {
  table: "users",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "user" },
  ],
  retention: null,
};
const PERMISSIONS: TableClassification = {
  table: "permissions",
  scope: "platform",
  holds: "operational",
  because: "capability keys",
  reaches: [
    { via: "none", because: "the permission catalogue. A list of capability keys." },
  ],
  retention: null,
};
const ROLES: TableClassification = {
  table: "roles",
  scope: "tenant",
  holds: "operational",
  because: "role definitions",
  reaches: [
    { via: "none", because: "NO REACH DECLARED — this table carries personal data that no export reaches." },
  ],
  retention: null,
};
const ROLE_PERMISSIONS: TableClassification = {
  table: "role_permissions",
  scope: "tenant",
  holds: "operational",
  because: "role/permission joins",
  reaches: [
    { via: "parent", column: "role_id", table: "roles" },
  ],
  retention: null,
};
const USER_ROLES: TableClassification = {
  table: "user_roles",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "role_id", table: "roles" },
    { via: "column", column: "user_id", principal: "user" },
    { via: "column", column: "assigned_by", principal: "user" },
  ],
  retention: null,
};
const AUDIT_LOGS: TableClassification = {
  table: "audit_logs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "actor_user_id", principal: "user" },
  ],
  retention: "audit-chain-immutable",
};

/* ================================================================== */
/* db/schema/credit.ts                                               */
/* ================================================================== */

const CUSTOMER_CREDIT_PROFILES: TableClassification = {
  table: "customer_credit_profiles",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const APPROVAL_LIMITS: TableClassification = {
  table: "approval_limits",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const CREDIT_HOLD_EVENTS: TableClassification = {
  table: "credit_hold_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "placed_by", principal: "user" },
    { via: "column", column: "released_by", principal: "user" },
  ],
  retention: null,
};
const CREDIT_HOLD_OVERRIDES: TableClassification = {
  table: "credit_hold_overrides",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "order_id", table: "sales_orders" },
    { via: "column", column: "actor_user_id", principal: "user" },
  ],
  retention: null,
};
const CREDIT_DUNNING_LADDERS: TableClassification = {
  table: "credit_dunning_ladders",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const CREDIT_DUNNING_STAGES: TableClassification = {
  table: "credit_dunning_stages",
  scope: "tenant",
  holds: "operational",
  because: "dunning ladder configuration",
  reaches: [
    { via: "parent", column: "ladder_id", table: "credit_dunning_ladders" },
  ],
  retention: null,
};
const CREDIT_DUNNING_LOG: TableClassification = {
  table: "credit_dunning_log",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "parent", column: "ladder_id", table: "credit_dunning_ladders" },
    { via: "identifier", column: "recipient_email", identifier: "email" },
    { via: "identifier", column: "recipient_phone", identifier: "phone" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/crm.ts                                                  */
/* ------------------------------------------------------------------ */
/* ⚠️ A COMPANY IS NOT A DATA PRINCIPAL. s.2(j) says \"the           */
/* individual\". `companies` is reached in reverse, as the           */
/* employer of an exported contact, because a person is entitled     */
/* to know which organisation you filed them under.                  */
/* ================================================================== */

const COMPANIES: TableClassification = {
  table: "companies",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "reverse", column: "company_id", from: "contacts" },
  ],
  retention: null,
};
const CONTACTS: TableClassification = {
  table: "contacts",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "contact" },
  ],
  retention: null,
};
const DEALS: TableClassification = {
  table: "deals",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "owner_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/custom-objects.ts                                       */
/* ================================================================== */

const CUSTOM_OBJECT_DEFINITIONS: TableClassification = {
  table: "custom_object_definitions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const CUSTOM_FIELD_DEFINITIONS: TableClassification = {
  table: "custom_field_definitions",
  scope: "tenant",
  holds: "operational",
  because: "field definitions",
  reaches: [
    { via: "parent", column: "object_definition_id", table: "custom_object_definitions" },
  ],
  retention: null,
};
const CUSTOM_OBJECT_RECORDS: TableClassification = {
  table: "custom_object_records",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "related_contact_id", principal: "contact" },
    { via: "column", column: "owner_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/dynamic-objects.ts                                      */
/* ================================================================== */

const DYNAMIC_OBJECTS: TableClassification = {
  table: "dynamic_objects",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "archived_by", principal: "user" },
  ],
  retention: null,
};
const DYNAMIC_FIELDS: TableClassification = {
  table: "dynamic_fields",
  scope: "tenant",
  holds: "operational",
  because: "field definitions",
  reaches: [
    { via: "parent", column: "object_id", table: "dynamic_objects" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/email.ts                                                */
/* ================================================================== */

const EMAIL_OUTBOX: TableClassification = {
  table: "email_outbox",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "identifier", column: "to_email", identifier: "email" },
    { via: "identifier", column: "to_email_normalized", identifier: "email" },
    { via: "column", column: "recipient_user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const EMAIL_SUPPRESSIONS: TableClassification = {
  table: "email_suppressions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "email_normalized", identifier: "email" },
    { via: "column", column: "released_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/field-ops.ts                                            */
/* ================================================================== */

const FIELD_JOBS: TableClassification = {
  table: "field_jobs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "customer_contact_id", principal: "contact" },
    { via: "parent", column: "rate_card_id", table: "rate_cards" },
    { via: "column", column: "assigned_user_id", principal: "user" },
  ],
  retention: null,
};
const FIELD_VISITS: TableClassification = {
  table: "field_visits",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "job_id", table: "field_jobs" },
    { via: "column", column: "technician_user_id", principal: "user" },
  ],
  retention: null,
};
const FIELD_PROOFS: TableClassification = {
  table: "field_proofs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "visit_id", table: "field_visits" },
    { via: "parent", column: "job_id", table: "field_jobs" },
    { via: "parent", column: "document_id", table: "documents" },
  ],
  retention: null,
};
const FIELD_JOB_MATERIALS: TableClassification = {
  table: "field_job_materials",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "job_id", table: "field_jobs" },
    { via: "parent", column: "visit_id", table: "field_visits" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/fixed-assets.ts                                         */
/* ================================================================== */

const IT_ASSET_BLOCKS: TableClassification = {
  table: "it_asset_blocks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const FIXED_ASSETS: TableClassification = {
  table: "fixed_assets",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const DEPRECIATION_RUNS: TableClassification = {
  table: "depreciation_runs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "computed_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const DEPRECIATION_LINES: TableClassification = {
  table: "depreciation_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "run_id", table: "depreciation_runs" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/front-office.ts                                         */
/* ------------------------------------------------------------------ */
/* ⭐ Consent already lives here and it is already purpose-scoped.    */
/* `consents.purpose`, `consents.channel`, `consents.notice_id` —    */
/* see the survey in the batch report; the brief's assumption that   */
/* this was a boolean was wrong.                                     */
/* ================================================================== */

const LEAD_SOURCES: TableClassification = {
  table: "lead_sources",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const PIPELINE_STAGES: TableClassification = {
  table: "pipeline_stages",
  scope: "tenant",
  holds: "operational",
  because: "pipeline configuration",
  reaches: [
    { via: "none", because: "the workspace's pipeline configuration." },
  ],
  retention: null,
};
const CONSENT_NOTICES: TableClassification = {
  table: "consent_notices",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const CONSENTS: TableClassification = {
  table: "consents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "column", column: "lead_id", principal: "lead" },
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const MESSAGE_THREADS: TableClassification = {
  table: "message_threads",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const THREAD_PARTICIPANTS: TableClassification = {
  table: "thread_participants",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "thread_id", table: "message_threads" },
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};
const MESSAGES: TableClassification = {
  table: "messages",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "thread_id", table: "message_threads" },
    { via: "column", column: "author_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/fx.ts                                                   */
/* ================================================================== */

const CURRENCY_UNITS: TableClassification = {
  table: "currency_units",
  scope: "platform",
  holds: "operational",
  because: "ISO 4217 exponents",
  reaches: [
    { via: "none", because: "ISO 4217 minor-unit exponents. Not tenant-scoped and not about anybody." },
  ],
  retention: null,
};
const FX_REFERENCE_RATES: TableClassification = {
  table: "fx_reference_rates",
  scope: "platform",
  holds: "operational",
  because: "published rates",
  reaches: [
    { via: "none", because: "published central-bank rates. Not tenant-scoped." },
  ],
  retention: null,
};
const FX_RATES: TableClassification = {
  table: "fx_rates",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "entered_by", principal: "user" },
  ],
  retention: null,
};
const FX_REVALUATIONS: TableClassification = {
  table: "fx_revaluations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const FX_REVALUATION_LINES: TableClassification = {
  table: "fx_revaluation_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "revaluation_id", table: "fx_revaluations" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/governance.ts                                           */
/* ================================================================== */

const DEPLOYMENT_RELEASES: TableClassification = {
  table: "deployment_releases",
  scope: "platform",
  scopeNote: "Ordence's deployment metadata.",
  holds: "operational",
  because: "deployment metadata",
  reaches: [
    { via: "none", because: "deployment metadata. `governance.ts` in this repo is DEPLOYMENT governance, not data governance." },
  ],
  retention: null,
};
const DEPLOYMENT_BACKUPS: TableClassification = {
  table: "deployment_backups",
  scope: "platform",
  scopeNote: "Ordence's backup metadata.",
  holds: "operational",
  because: "backup metadata",
  reaches: [
    { via: "parent", column: "release_id", table: "deployment_releases" },
  ],
  retention: null,
};
const UI_GOVERNANCE_CHECKS: TableClassification = {
  table: "ui_governance_checks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "checked_by", principal: "user" },
  ],
  retention: null,
};
const FLOW_SUBMISSIONS: TableClassification = {
  table: "flow_submissions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/gst.ts                                                  */
/* ------------------------------------------------------------------ */
/* GST records. One clock only: s.36. CGST Rules 46 and 56 add       */
/* content and location duties, not a second period.                 */
/* ================================================================== */

const GST_REGISTRATIONS: TableClassification = {
  table: "gst_registrations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const GST_PARTIES: TableClassification = {
  table: "gst_parties",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "reverse", column: "gst_party_id", from: "vendors" },
  ],
  retention: "cgst-36",
};
const HSN_SAC_CODES: TableClassification = {
  table: "hsn_sac_codes",
  scope: "tenant",
  holds: "operational",
  because: "the CBIC catalogue",
  reaches: [
    { via: "none", because: "the HSN/SAC catalogue as published by the CBIC." },
  ],
  retention: "cgst-36",
};
const HSN_SAC_RATES: TableClassification = {
  table: "hsn_sac_rates",
  scope: "tenant",
  holds: "operational",
  because: "rates against that catalogue",
  reaches: [
    { via: "parent", column: "hsn_sac_id", table: "hsn_sac_codes" },
  ],
  retention: "cgst-36",
};
const EWAY_BILLS: TableClassification = {
  table: "eway_bills",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "column", column: "cancelled_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const EWAY_BILL_VEHICLES: TableClassification = {
  table: "eway_bill_vehicles",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "eway_bill_id", table: "eway_bills" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const EWAY_BILL_ITEMS: TableClassification = {
  table: "eway_bill_items",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "eway_bill_id", table: "eway_bills" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/gstr2b.ts                                               */
/* ================================================================== */

const GSTR2B_DOCUMENTS: TableClassification = {
  table: "gstr2b_documents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "imported_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const GSTR2B_ROWS: TableClassification = {
  table: "gstr2b_rows",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "document_id", table: "gstr2b_documents" },
  ],
  retention: "cgst-36",
};
const GSTR2B_RECONCILIATIONS: TableClassification = {
  table: "gstr2b_reconciliations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "document_id", table: "gstr2b_documents" },
  ],
  retention: "cgst-36",
};
const GSTR2B_MATCHES: TableClassification = {
  table: "gstr2b_matches",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "reconciliation_id", table: "bank_reconciliations" },
    { via: "parent", column: "purchase_invoice_id", table: "purchase_invoices" },
    { via: "column", column: "action_by", principal: "user" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/integrations.ts                                         */
/* ================================================================== */

const CONNECTIONS: TableClassification = {
  table: "connections",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const SYNC_RUNS: TableClassification = {
  table: "sync_runs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
  ],
  retention: null,
};
const WEBHOOK_ENDPOINTS: TableClassification = {
  table: "webhook_endpoints",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const WEBHOOK_DELIVERIES: TableClassification = {
  table: "webhook_deliveries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "endpoint_id", table: "webhook_endpoints" },
  ],
  retention: "certin-180-day-logs",
};
const LEAD_INTAKE_FAILURES: TableClassification = {
  table: "lead_intake_failures",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "resolved_lead_id", principal: "lead" },
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "column", column: "resolved_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/inventory.ts                                            */
/* ================================================================== */

const WAREHOUSES: TableClassification = {
  table: "warehouses",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "preferred_vendor_id", principal: "vendor" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "manager_user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_ITEMS: TableClassification = {
  table: "stock_items",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "asset_id", table: "assets" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_MOVEMENTS: TableClassification = {
  table: "stock_movements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "stock_item_id", table: "stock_items" },
    { via: "parent", column: "batch_id", table: "tally_export_batches" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_BALANCES: TableClassification = {
  table: "stock_balances",
  scope: "tenant",
  holds: "operational",
  because: "quantities on hand",
  reaches: [
    { via: "parent", column: "stock_item_id", table: "stock_items" },
  ],
  retention: null,
};
const STOCK_RESERVATIONS: TableClassification = {
  table: "stock_reservations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "stock_item_id", table: "stock_items" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_COUNTS: TableClassification = {
  table: "stock_counts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "posted_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_COUNT_LINES: TableClassification = {
  table: "stock_count_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "count_id", table: "stock_counts" },
    { via: "parent", column: "stock_item_id", table: "stock_items" },
    { via: "column", column: "counted_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_BATCHES: TableClassification = {
  table: "stock_batches",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "stock_item_id", table: "stock_items" },
    { via: "column", column: "status_changed_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_SERIALS: TableClassification = {
  table: "stock_serials",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "stock_item_id", table: "stock_items" },
    { via: "parent", column: "batch_id", table: "tally_export_batches" },
    { via: "parent", column: "company_id", table: "companies" },
  ],
  retention: null,
};
const GOODS_RETURNS: TableClassification = {
  table: "goods_returns",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "parent", column: "credit_note_id", table: "sales_credit_notes" },
    { via: "column", column: "received_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const GOODS_RETURN_LINES: TableClassification = {
  table: "goods_return_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "goods_return_id", table: "goods_returns" },
    { via: "parent", column: "stock_item_id", table: "stock_items" },
  ],
  retention: null,
};
const STOCK_WRITE_OFFS: TableClassification = {
  table: "stock_write_offs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "stock_item_id", table: "stock_items" },
    { via: "parent", column: "batch_id", table: "tally_export_batches" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_TRANSFERS: TableClassification = {
  table: "stock_transfers",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const STOCK_TRANSFER_LINES: TableClassification = {
  table: "stock_transfer_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "transfer_id", table: "stock_transfers" },
    { via: "parent", column: "stock_item_id", table: "stock_items" },
  ],
  retention: null,
};
const LANDED_COSTS: TableClassification = {
  table: "landed_costs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "purchase_invoice_id", table: "purchase_invoices" },
    { via: "column", column: "applied_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const LANDED_COST_ALLOCATIONS: TableClassification = {
  table: "landed_cost_allocations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "landed_cost_id", table: "landed_costs" },
    { via: "parent", column: "stock_item_id", table: "stock_items" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/labour.ts                                               */
/* ------------------------------------------------------------------ */
/* Site labour. `site_workers.uan` and `photo_document_id` are the   */
/* sharpest personal data in the product: a government identifier    */
/* and a photograph of a person who is usually not a user of the     */
/* software and has no account through which to ask.                 */
/* ================================================================== */

const SITE_WORKERS: TableClassification = {
  table: "site_workers",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "worker" },
  ],
  retention: "esi-register-reg-32",
};
const WELFARE_LOGS: TableClassification = {
  table: "welfare_logs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "logged_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const PIECE_RATE_ENTRIES: TableClassification = {
  table: "piece_rate_entries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "ra_bill_id", table: "ra_bills" },
    { via: "column", column: "measured_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const SITE_ATTENDANCE: TableClassification = {
  table: "site_attendance",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "worker_id", principal: "worker" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: "esi-register-reg-32",
};
const DUTY_ROSTERS: TableClassification = {
  table: "duty_rosters",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const VENDOR_DEFAULTS: TableClassification = {
  table: "vendor_defaults",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "reported_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const DAILY_SITE_LOGS: TableClassification = {
  table: "daily_site_logs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "author_id", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const SITE_PHOTOS: TableClassification = {
  table: "site_photos",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "daily_site_log_id", table: "daily_site_logs" },
    { via: "parent", column: "document_id", table: "documents" },
  ],
  retention: "wage-registers-code-rules",
};

/* ================================================================== */
/* db/schema/land.ts                                                 */
/* ------------------------------------------------------------------ */
/* 🔴 `powers_of_attorney.grantor` and `.attorney` are two named     */
/* human beings in columns that contain neither \"name\" nor an      */
/* id. The first version of the detector walked straight past        */
/* them.                                                             */
/* ================================================================== */

const LAND_PARCELS: TableClassification = {
  table: "land_parcels",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const TITLE_DOCUMENTS: TableClassification = {
  table: "title_documents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "verified_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const LANDOWNERS: TableClassification = {
  table: "landowners",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "landowner" },
  ],
  retention: null,
};
const JOINT_DEVELOPMENT_AGREEMENTS: TableClassification = {
  table: "joint_development_agreements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const LAND_CONVERSIONS: TableClassification = {
  table: "land_conversions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const KHATA_RECORDS: TableClassification = {
  table: "khata_records",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "unit_id", table: "units" },
  ],
  retention: null,
};
const ESTAMP_CERTIFICATES: TableClassification = {
  table: "estamp_certificates",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "booking_id", table: "bookings" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const POWERS_OF_ATTORNEY: TableClassification = {
  table: "powers_of_attorney",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "document_id", table: "documents" },
  ],
  retention: null,
};
const DUE_DILIGENCE_RECORDS: TableClassification = {
  table: "due_diligence_records",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "unit_id", table: "units" },
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "verified_by", principal: "user" },
  ],
  retention: null,
};
const APPROVAL_SANCTIONS: TableClassification = {
  table: "approval_sanctions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "document_id", table: "documents" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const LIAISON_LOGS: TableClassification = {
  table: "liaison_logs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "chased_by", principal: "user" },
  ],
  retention: null,
};
const PLAN_SANCTIONS: TableClassification = {
  table: "plan_sanctions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
  ],
  retention: null,
};
const LAND_REVENUE_RECORDS: TableClassification = {
  table: "land_revenue_records",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "parcel_id", table: "land_parcels" },
    { via: "parent", column: "document_id", table: "documents" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/leave.ts                                                */
/* ================================================================== */

const LEAVE_PERIODS: TableClassification = {
  table: "leave_periods",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "closed_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const HOLIDAY_CALENDAR: TableClassification = {
  table: "holiday_calendar",
  scope: "tenant",
  holds: "operational",
  because: "holiday dates",
  reaches: [
    { via: "none", because: "the workspace's holiday list." },
  ],
  retention: "wage-registers-code-rules",
};
const LEAVE_TYPES: TableClassification = {
  table: "leave_types",
  scope: "tenant",
  holds: "operational",
  because: "leave policy",
  reaches: [
    { via: "none", because: "the workspace's leave policy." },
  ],
  retention: "wage-registers-code-rules",
};
const LEAVE_LEDGER: TableClassification = {
  table: "leave_ledger",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const LEAVE_REQUESTS: TableClassification = {
  table: "leave_requests",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "decided_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const STAFF_ATTENDANCE: TableClassification = {
  table: "staff_attendance",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "esi-register-reg-32",
};

/* ================================================================== */
/* db/schema/legal-billing.ts                                        */
/* ================================================================== */

const COURT_FEE_SCHEDULES: TableClassification = {
  table: "court_fee_schedules",
  scope: "tenant",
  holds: "operational",
  because: "court-fee schedules",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const COURT_FEE_SLABS: TableClassification = {
  table: "court_fee_slabs",
  scope: "tenant",
  holds: "operational",
  because: "court-fee slabs",
  reaches: [
    { via: "parent", column: "schedule_id", table: "court_fee_schedules" },
  ],
  retention: "companies-act-128-5",
};
const MATTER_DISBURSEMENTS: TableClassification = {
  table: "matter_disbursements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const COURT_FEE_REFUND_CLAIMS: TableClassification = {
  table: "court_fee_refund_claims",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const LEGAL_PRACTICE_PROFILE: TableClassification = {
  table: "legal_practice_profile",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};
const LEGAL_CLIENT_TAX_STATUS: TableClassification = {
  table: "legal_client_tax_status",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "confirmed_by", principal: "user" },
  ],
  retention: "companies-act-128-5",
};

/* ================================================================== */
/* db/schema/legal.ts                                                */
/* ================================================================== */

const LEGAL_MATTERS: TableClassification = {
  table: "legal_matters",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "responsible_user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const LEGAL_MATTER_EVENTS: TableClassification = {
  table: "legal_matter_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const LEGAL_HEARINGS: TableClassification = {
  table: "legal_hearings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "appeared_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const COURT_HOLIDAYS: TableClassification = {
  table: "court_holidays",
  scope: "tenant",
  holds: "operational",
  because: "court vacations",
  reaches: [
    { via: "none", because: "court vacation dates." },
  ],
  retention: null,
};
const CLIENT_ACCOUNT_ENTRIES: TableClassification = {
  table: "client_account_entries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/mcp.ts                                                  */
/* ================================================================== */

const MCP_TOKENS: TableClassification = {
  table: "mcp_tokens",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "acting_user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const MCP_CALL_LOG: TableClassification = {
  table: "mcp_call_log",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "token_id", table: "mcp_tokens" },
  ],
  retention: "certin-180-day-logs",
};

/* ================================================================== */
/* db/schema/messaging.ts                                            */
/* ================================================================== */

const MESSAGE_TEMPLATES: TableClassification = {
  table: "message_templates",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const SERVICE_WINDOWS: TableClassification = {
  table: "service_windows",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "identifier", column: "phone_digits", identifier: "phone" },
  ],
  retention: null,
};
const MESSAGE_SENDS: TableClassification = {
  table: "message_sends",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "identifier", column: "to_phone_digits", identifier: "phone" },
    { via: "identifier", column: "to_phone", identifier: "phone" },
    { via: "column", column: "requested_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/metering.ts                                             */
/* ================================================================== */

const USAGE_COUNTERS: TableClassification = {
  table: "usage_counters",
  scope: "tenant",
  holds: "operational",
  because: "metered totals",
  reaches: [
    { via: "none", because: "metered totals per workspace per period." },
  ],
  retention: null,
};
const USAGE_LEVELS: TableClassification = {
  table: "usage_levels",
  scope: "tenant",
  holds: "operational",
  because: "metered peaks",
  reaches: [
    { via: "none", because: "metered peaks per workspace." },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/notifications.ts                                        */
/* ================================================================== */

const NOTIFICATIONS: TableClassification = {
  table: "notifications",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/orders.ts                                               */
/* ================================================================== */

const SALES_ORDERS: TableClassification = {
  table: "sales_orders",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "column", column: "channel_partner_id", principal: "partner" },
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "gst_party_id", table: "gst_parties" },
    { via: "parent", column: "deal_id", table: "deals" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "booking_id", table: "bookings" },
    { via: "identifier", column: "shipping_phone", identifier: "phone" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "confirmed_by", principal: "user" },
    { via: "column", column: "cancelled_by", principal: "user" },
    { via: "column", column: "owner_user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: null,
};
const SALES_ORDER_LINES: TableClassification = {
  table: "sales_order_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "order_id", table: "sales_orders" },
    { via: "parent", column: "asset_id", table: "assets" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const SALES_ORDER_FULFILLMENTS: TableClassification = {
  table: "sales_order_fulfillments",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "order_id", table: "sales_orders" },
    { via: "identifier", column: "driver_phone", identifier: "phone" },
    { via: "column", column: "received_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const SALES_ORDER_FULFILLMENT_LINES: TableClassification = {
  table: "sales_order_fulfillment_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const SALES_ORDER_EVENTS: TableClassification = {
  table: "sales_order_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "order_id", table: "sales_orders" },
    { via: "column", column: "actor_user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/patterns.ts                                             */
/* ================================================================== */

const CUSTOMER_RHYTHMS: TableClassification = {
  table: "customer_rhythms",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
  ],
  retention: null,
};
const RHYTHM_SIGNALS: TableClassification = {
  table: "rhythm_signals",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
  ],
  retention: null,
};
const AUTOMATION_EVENTS: TableClassification = {
  table: "automation_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "none", because: "`record_id` is polymorphic across every object in the product with no discriminator that maps to a principal. 🔴 STATED GAP: `payload` carries the changed row, so this table DOES hold personal data that no export reaches." },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/payroll.ts                                              */
/* ------------------------------------------------------------------ */
/* Salary. Every row is personal data about a named individual and   */
/* most of it is also a statutory register.                          */
/* ================================================================== */

const EMPLOYEES: TableClassification = {
  table: "employees",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "employee" },
  ],
  retention: "esi-register-reg-32",
};
const PAY_COMPONENTS: TableClassification = {
  table: "pay_components",
  scope: "tenant",
  holds: "operational",
  because: "salary-structure definitions",
  reaches: [
    { via: "none", because: "the workspace's salary-structure definitions. `pf_applicable` is a policy flag on a component, not on a person." },
  ],
  retention: "wage-registers-code-rules",
};
const EMPLOYEE_PAY_STRUCTURE: TableClassification = {
  table: "employee_pay_structure",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const STATUTORY_RATES: TableClassification = {
  table: "statutory_rates",
  scope: "tenant",
  holds: "operational",
  because: "notified PF/ESI/PT rates",
  reaches: [
    { via: "none", because: "PF, ESI and professional-tax rate tables as notified." },
  ],
  retention: "wage-registers-code-rules",
};
const PAYROLL_RUNS: TableClassification = {
  table: "payroll_runs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "reverse", column: "run_id", from: "payslips" },
  ],
  retention: "wage-registers-code-rules",
};
const PAYSLIPS: TableClassification = {
  table: "payslips",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
  ],
  retention: "wage-registers-code-rules",
};
const EMPLOYEE_SETTLEMENTS: TableClassification = {
  table: "employee_settlements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const EMPLOYEE_ADVANCES: TableClassification = {
  table: "employee_advances",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const EMPLOYEE_ADVANCE_INSTALMENTS: TableClassification = {
  table: "employee_advance_instalments",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "advance_id", table: "employee_advances" },
  ],
  retention: "wage-registers-code-rules",
};
const EMPLOYEE_ADVANCE_RECOVERIES: TableClassification = {
  table: "employee_advance_recoveries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "advance_id", table: "employee_advances" },
    { via: "parent", column: "payslip_id", table: "payslips" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};
const EMPLOYEE_REIMBURSEMENT_CLAIMS: TableClassification = {
  table: "employee_reimbursement_claims",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "employee_id", principal: "employee" },
    { via: "parent", column: "payslip_id", table: "payslips" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "wage-registers-code-rules",
};

/* ================================================================== */
/* db/schema/platform-control.ts                                     */
/* ================================================================== */

const PLATFORM_APPROVAL_QUEUE: TableClassification = {
  table: "platform_approval_queue",
  scope: "platform",
  holds: "personal",
  reaches: [
    { via: "column", column: "requested_by", principal: "user" },
  ],
  retention: null,
};
const PLATFORM_ENTITLEMENT_HISTORY: TableClassification = {
  table: "platform_entitlement_history",
  scope: "platform",
  scopeNote: "tenant-scoped, but `changed_by` is an Ordence operator changing what a workspace has bought.",
  holds: "personal",
  reaches: [
    { via: "column", column: "changed_by", principal: "user" },
  ],
  retention: null,
};
const TENANT_HEALTH_EVENTS: TableClassification = {
  table: "tenant_health_events",
  scope: "platform",
  scopeNote: "tenant-scoped platform telemetry about a workspace's health, resolved by Ordence staff.",
  holds: "personal",
  reaches: [
    { via: "column", column: "resolved_by", principal: "user" },
  ],
  retention: null,
};
const PLATFORM_INCIDENTS: TableClassification = {
  table: "platform_incidents",
  scope: "platform",
  holds: "personal",
  reaches: [
    { via: "column", column: "declared_by", principal: "user" },
    { via: "column", column: "resolved_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/platform.ts                                             */
/* ------------------------------------------------------------------ */
/* 🔴 ORDENCE'S OWN STAFF AND ORDENCE'S OWN ACTIONS. Not             */
/* tenant-scoped. A workspace's Data Principal has no claim on       */
/* these and a workspace export must never include them.             */
/* ================================================================== */

const PLATFORM_STAFF: TableClassification = {
  table: "platform_staff",
  scope: "platform",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "email", identifier: "email" },
    { via: "identifier", column: "granted_by_email", identifier: "email" },
    { via: "column", column: "clerk_user_id", principal: "user" },
    { via: "column", column: "granted_by", principal: "user" },
    { via: "column", column: "revoked_by", principal: "user" },
  ],
  retention: null,
};
const PLATFORM_IMPERSONATION_SESSIONS: TableClassification = {
  table: "platform_impersonation_sessions",
  scope: "platform",
  scopeNote: "tenant-scoped, but `actor_email` is ORDENCE staff. ⚠️ STATED GAP: a workspace IS entitled to tell its Data Principal that an Ordence engineer read their record. That transparency answer is not built, and excluding this table is the safer of two wrong answers, not a right one.",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "actor_email", identifier: "email" },
    { via: "column", column: "subject_user_id", principal: "user" },
    { via: "column", column: "post_incident_by", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};
const TENANT_SUPPORT_CONSENTS: TableClassification = {
  table: "tenant_support_consents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "granted_by_email", identifier: "email" },
    { via: "column", column: "granted_by_user_id", principal: "user" },
    { via: "column", column: "revoked_by_user_id", principal: "user" },
  ],
  retention: null,
};
const PLATFORM_TENANT_FLAGS: TableClassification = {
  table: "platform_tenant_flags",
  scope: "platform",
  scopeNote: "tenant-scoped, but `set_by_email` is an ORDENCE staff member. The flag is a platform-control record about a workspace, not a workspace record about a person.",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "set_by_email", identifier: "email" },
  ],
  retention: null,
};
const PLATFORM_ACTION_LOG: TableClassification = {
  table: "platform_action_log",
  scope: "platform",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "actor_email", identifier: "email" },
  ],
  retention: "audit-chain-immutable",
};

/* ================================================================== */
/* db/schema/portals.ts                                              */
/* ================================================================== */

const PORTAL_LINKS: TableClassification = {
  table: "portal_links",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "recipient_email", identifier: "email" },
    { via: "column", column: "revoked_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "limitation-article-55",
};
const CONTRACT_SIGNATURES: TableClassification = {
  table: "contract_signatures",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "contract_id", table: "contracts" },
    { via: "parent", column: "portal_link_id", table: "portal_links" },
    { via: "identifier", column: "signer_email", identifier: "email" },
  ],
  retention: "limitation-article-55",
};

/* ================================================================== */
/* db/schema/pricing.ts                                              */
/* ================================================================== */

const RATE_CARDS: TableClassification = {
  table: "rate_cards",
  scope: "tenant",
  holds: "operational",
  because: "price lists",
  reaches: [
    { via: "none", because: "NO REACH DECLARED — this table carries personal data that no export reaches." },
  ],
  retention: "cgst-36",
};
const RATE_SLABS: TableClassification = {
  table: "rate_slabs",
  scope: "tenant",
  holds: "operational",
  because: "pricing slabs",
  reaches: [
    { via: "parent", column: "rate_card_id", table: "rate_cards" },
  ],
  retention: "cgst-36",
};
const RATE_ADJUSTMENTS: TableClassification = {
  table: "rate_adjustments",
  scope: "tenant",
  holds: "operational",
  because: "pricing adjustments",
  reaches: [
    { via: "parent", column: "rate_card_id", table: "rate_cards" },
  ],
  retention: "cgst-36",
};
const RATE_QUOTES: TableClassification = {
  table: "rate_quotes",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "rate_card_id", table: "rate_cards" },
  ],
  retention: "cgst-36",
};
const PRICE_AGREEMENTS: TableClassification = {
  table: "price_agreements",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const POST_SUPPLY_DISCOUNTS: TableClassification = {
  table: "post_supply_discounts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "credit_note_id", table: "sales_credit_notes" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const POST_SUPPLY_DISCOUNT_INVOICES: TableClassification = {
  table: "post_supply_discount_invoices",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/procurement.ts                                          */
/* ================================================================== */

const PURCHASE_ORDERS: TableClassification = {
  table: "purchase_orders",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const PURCHASE_ORDER_LINES: TableClassification = {
  table: "purchase_order_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "po_id", table: "purchase_orders" },
    { via: "parent", column: "stock_item_id", table: "stock_items" },
  ],
  retention: "cgst-36",
};
const GOODS_RECEIPTS: TableClassification = {
  table: "goods_receipts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "po_id", table: "purchase_orders" },
    { via: "column", column: "received_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const GOODS_RECEIPT_LINES: TableClassification = {
  table: "goods_receipt_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "grn_id", table: "goods_receipts" },
    { via: "parent", column: "stock_item_id", table: "stock_items" },
  ],
  retention: "cgst-36",
};
const VENDOR_PAYMENTS: TableClassification = {
  table: "vendor_payments",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "column", column: "approved_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const VENDOR_PAYMENT_ALLOCATIONS: TableClassification = {
  table: "vendor_payment_allocations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "payment_id", table: "vendor_payments" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/purchases.ts                                            */
/* ================================================================== */

const VENDORS: TableClassification = {
  table: "vendors",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "vendor" },
  ],
  retention: "cgst-36",
};
const PURCHASE_INVOICES: TableClassification = {
  table: "purchase_invoices",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "gst_party_id", table: "gst_parties" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "po_id", table: "purchase_orders" },
    { via: "parent", column: "grn_id", table: "goods_receipts" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const PURCHASE_INVOICE_LINES: TableClassification = {
  table: "purchase_invoice_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "purchase_invoice_id", table: "purchase_invoices" },
    { via: "parent", column: "hsn_sac_id", table: "hsn_sac_codes" },
    { via: "parent", column: "project_id", table: "projects" },
  ],
  retention: "cgst-36",
};
const ITC_REGISTER: TableClassification = {
  table: "itc_register",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "purchase_invoice_id", table: "purchase_invoices" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const VENDOR_LEDGER_ENTRIES: TableClassification = {
  table: "vendor_ledger_entries",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "parent", column: "purchase_invoice_id", table: "purchase_invoices" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/receivables.ts                                          */
/* ================================================================== */

const RECEIVABLE_POLICIES: TableClassification = {
  table: "receivable_policies",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const DUNNING_POLICIES: TableClassification = {
  table: "dunning_policies",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const DEMAND_NOTICES: TableClassification = {
  table: "demand_notices",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "lead_id", principal: "lead" },
    { via: "parent", column: "booking_id", table: "bookings" },
    { via: "parent", column: "milestone_id", table: "payment_milestones" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "issued_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "rera-state-rules",
};
const DEMAND_NOTICE_DOCUMENTS: TableClassification = {
  table: "demand_notice_documents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "demand_id", table: "demand_notices" },
  ],
  retention: "rera-state-rules",
};
const DUNNING_EVENTS: TableClassification = {
  table: "dunning_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "demand_id", table: "demand_notices" },
  ],
  retention: "rera-state-rules",
};
const RECEIPTS: TableClassification = {
  table: "receipts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "lead_id", principal: "lead" },
    { via: "parent", column: "booking_id", table: "bookings" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "rera-state-rules",
};
const RECEIPT_ALLOCATIONS: TableClassification = {
  table: "receipt_allocations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "receipt_id", table: "receipts" },
    { via: "parent", column: "demand_id", table: "demand_notices" },
    { via: "column", column: "allocated_by", principal: "user" },
  ],
  retention: "rera-state-rules",
};

/* ================================================================== */
/* db/schema/returns.ts                                              */
/* ================================================================== */

const GST_RETURNS: TableClassification = {
  table: "gst_returns",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "finalised_by", principal: "user" },
    { via: "column", column: "filed_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/sales-invoices.ts                                       */
/* ================================================================== */

const SALES_INVOICES: TableClassification = {
  table: "sales_invoices",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "parent", column: "company_id", table: "companies" },
    { via: "parent", column: "order_id", table: "sales_orders" },
    { via: "parent", column: "gst_party_id", table: "gst_parties" },
    { via: "column", column: "issued_by", principal: "user" },
    { via: "column", column: "cancelled_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const SALES_INVOICE_LINES: TableClassification = {
  table: "sales_invoice_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "parent", column: "asset_id", table: "assets" },
  ],
  retention: "cgst-36",
};
const CUSTOMER_RECEIPTS: TableClassification = {
  table: "customer_receipts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const CUSTOMER_RECEIPT_ALLOCATIONS: TableClassification = {
  table: "customer_receipt_allocations",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "receipt_id", table: "customer_receipts" },
  ],
  retention: "cgst-36",
};
const SALES_CREDIT_NOTES: TableClassification = {
  table: "sales_credit_notes",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "invoice_id", table: "sales_invoices" },
    { via: "parent", column: "company_id", table: "companies" },
    { via: "column", column: "issued_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const SALES_CREDIT_NOTE_LINES: TableClassification = {
  table: "sales_credit_note_lines",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "credit_note_id", table: "sales_credit_notes" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/sales.ts                                                */
/* ------------------------------------------------------------------ */
/* ⭐ THE ALLOTTEE. A `leads` row that has a `bookings` row is an     */
/* allottee of a registered real-estate project. The retention       */
/* rule that governs them is a STATE RERA rule, and the central      */
/* Act's s.11 — which the brief cited — states no period at all.     */
/* ================================================================== */

const PROJECTS: TableClassification = {
  table: "projects",
  scope: "tenant",
  holds: "operational",
  because: "a construction site. `latitude`, `longitude` and `address_line` locate a BUILDING, and `rera_number` registers that building with the state authority — none of them is about a person. ⚠️ The detector flags all four and is right to: the same four column names on a `field_visits` row would be a person's whereabouts.",
  reaches: [
    { via: "none", because: "a real-estate project. Not a person; allottees reach it through `bookings`." },
  ],
  retention: null,
};
const UNITS: TableClassification = {
  table: "units",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "held_for_lead_id", principal: "lead" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "held_by_user_id", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: "rera-state-rules",
};
const LEADS: TableClassification = {
  table: "leads",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "lead" },
  ],
  retention: null,
};
const LEAD_ACTIVITIES: TableClassification = {
  table: "lead_activities",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "lead_id", principal: "lead" },
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};
const CHANNEL_PARTNERS: TableClassification = {
  table: "channel_partners",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "partner" },
  ],
  retention: null,
};
const BOOKINGS: TableClassification = {
  table: "bookings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "lead_id", principal: "lead" },
    { via: "column", column: "channel_partner_id", principal: "partner" },
    { via: "parent", column: "unit_id", table: "units" },
    { via: "column", column: "sales_rep_id", principal: "user" },
    { via: "column", column: "possession_recorded_by", principal: "user" },
  ],
  retention: "rera-state-rules",
};
const PAYMENT_MILESTONES: TableClassification = {
  table: "payment_milestones",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "booking_id", table: "bookings" },
  ],
  retention: "rera-state-rules",
};
const CHANNEL_PARTNER_COMMISSIONS: TableClassification = {
  table: "channel_partner_commissions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "booking_id", table: "bookings" },
    { via: "column", column: "approved_by", principal: "user" },
  ],
  retention: "rera-state-rules",
};

/* ================================================================== */
/* db/schema/scheduling.ts                                           */
/* ================================================================== */

const SCHEDULE_RESOURCES: TableClassification = {
  table: "schedule_resources",
  scope: "tenant",
  holds: "operational",
  because: "a bookable room, machine or chair. ⚠️ `group_name` matched the detector's `_name` rule and is a grouping label. A workspace that names a resource after the practitioner who uses it — \"Dr Rao\" — puts a person in this column, and nothing here can tell.",
  reaches: [
    { via: "none", because: "a bookable room, machine or chair. `group_name` is a grouping label, not a person." },
  ],
  retention: null,
};
const SCHEDULE_BOOKINGS: TableClassification = {
  table: "schedule_bookings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "parent", column: "resource_id", table: "schedule_resources" },
    { via: "identifier", column: "party_phone", identifier: "phone" },
    { via: "column", column: "created_by_user_id", principal: "user" },
  ],
  retention: null,
};
const SCHEDULE_BLOCKS: TableClassification = {
  table: "schedule_blocks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "resource_id", table: "schedule_resources" },
    { via: "column", column: "created_by_user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/secops.ts                                               */
/* ------------------------------------------------------------------ */
/* Security events. Retained under CERT-In's 180-day direction,      */
/* which binds Ordence as a body corporate.                          */
/* ================================================================== */

const SECURITY_EVENTS: TableClassification = {
  table: "security_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "actor_user_id", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};
const LOGIN_LOCKOUTS: TableClassification = {
  table: "login_lockouts",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "email", identifier: "email" },
    { via: "column", column: "actor_user_id", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};

/* ================================================================== */
/* db/schema/slugs.ts                                                */
/* ================================================================== */

const RESERVED_SLUGS: TableClassification = {
  table: "reserved_slugs",
  scope: "platform",
  holds: "operational",
  because: "the reserved-subdomain blocklist",
  reaches: [
    { via: "none", because: "the reserved-subdomain blocklist." },
  ],
  retention: null,
};
const TENANT_SLUG_HISTORY: TableClassification = {
  table: "tenant_slug_history",
  scope: "tenant",
  holds: "operational",
  because: "subdomain history",
  reaches: [
    { via: "none", because: "workspace subdomains. A slug is chosen by the workspace and is not a person, though a sole trader may well have used their own name." },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/storage.ts                                              */
/* ------------------------------------------------------------------ */
/* ⚠️ `documents` is the widest personal-data surface in the         */
/* product and the schema cannot see inside it. A scanned Aadhaar    */
/* card is a row with a `file_name` and a `mime_type`.               */
/* ================================================================== */

const DOCUMENTS: TableClassification = {
  table: "documents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "uploaded_by", principal: "user" },
    { via: "column", column: "deleted_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/tally.ts                                                */
/* ================================================================== */

const TALLY_CONNECTIONS: TableClassification = {
  table: "tally_connections",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const TALLY_LEDGER_MAPPINGS: TableClassification = {
  table: "tally_ledger_mappings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const TALLY_COST_CENTRE_MAPPINGS: TableClassification = {
  table: "tally_cost_centre_mappings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "project_id", table: "projects" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const TALLY_EXPORT_BATCHES: TableClassification = {
  table: "tally_export_batches",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "column", column: "delivered_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const TALLY_VOUCHERS: TableClassification = {
  table: "tally_vouchers",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "batch_id", table: "tally_export_batches" },
  ],
  retention: "cgst-36",
};
const TALLY_IMPORT_BATCHES: TableClassification = {
  table: "tally_import_batches",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "connection_id", table: "connections" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "cgst-36",
};
const TALLY_RECONCILIATION_ITEMS: TableClassification = {
  table: "tally_reconciliation_items",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "resolved_by", principal: "user" },
  ],
  retention: "cgst-36",
};

/* ================================================================== */
/* db/schema/tds.ts                                                  */
/* ------------------------------------------------------------------ */
/* 🔴 NO PROVISION STATES A TDS RETENTION PERIOD. The seven years    */
/* here is derived from the s.201(3) and s.149 limitation windows    */
/* and is labelled `derived-limitation` so nobody quotes it as a     */
/* section.                                                          */
/* ================================================================== */

const TDS_DEDUCTEES: TableClassification = {
  table: "tds_deductees",
  scope: "tenant",
  holds: "principal",
  reaches: [
    { via: "self", principal: "deductee" },
  ],
  retention: "tds-limitation-derived",
};
const TDS_LOWER_DEDUCTION_CERTIFICATES: TableClassification = {
  table: "tds_lower_deduction_certificates",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "deductee_id", principal: "deductee" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "tds-limitation-derived",
};
const TDS_CHALLANS: TableClassification = {
  table: "tds_challans",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "tds-limitation-derived",
};
const TDS_RETURNS: TableClassification = {
  table: "tds_returns",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "tds-limitation-derived",
};
const TDS_DEDUCTIONS: TableClassification = {
  table: "tds_deductions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "deductee_id", principal: "deductee" },
    { via: "column", column: "vendor_id", principal: "vendor" },
    { via: "column", column: "channel_partner_id", principal: "partner" },
    { via: "parent", column: "purchase_invoice_id", table: "purchase_invoices" },
    { via: "parent", column: "project_id", table: "projects" },
    { via: "parent", column: "challan_id", table: "tds_challans" },
    { via: "parent", column: "tds_return_id", table: "tds_returns" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "tds-limitation-derived",
};
const TDS_CERTIFICATES: TableClassification = {
  table: "tds_certificates",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "deductee_id", principal: "deductee" },
    { via: "parent", column: "tds_return_id", table: "tds_returns" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "tds-limitation-derived",
};

/* ================================================================== */
/* db/schema/telemetry.ts                                            */
/* ------------------------------------------------------------------ */
/* `error_events` carries a user id and a stack trace;               */
/* `lib/telemetry/scrub.ts` redacts PAN- and Aadhaar-shaped          */
/* strings before write.                                             */
/* ================================================================== */

const ERROR_EVENTS: TableClassification = {
  table: "error_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};
const WEB_VITAL_EVENTS: TableClassification = {
  table: "web_vital_events",
  scope: "tenant",
  holds: "operational",
  because: "browser performance samples",
  reaches: [
    { via: "none", because: "browser performance samples. `route_pattern` is the parameterised route, never the resolved id, so no subject survives into the row." },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/utility-meters.ts                                       */
/* ================================================================== */

const UTILITY_METERS: TableClassification = {
  table: "utility_meters",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "consumer_contact_id", principal: "contact" },
    { via: "parent", column: "rate_card_id", table: "rate_cards" },
  ],
  retention: null,
};
const METER_READINGS: TableClassification = {
  table: "meter_readings",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "meter_id", table: "utility_meters" },
  ],
  retention: null,
};
const METER_BILLING_PERIODS: TableClassification = {
  table: "meter_billing_periods",
  scope: "tenant",
  holds: "operational",
  because: "meter billing windows",
  reaches: [
    { via: "parent", column: "meter_id", table: "utility_meters" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/vault.ts                                                */
/* ------------------------------------------------------------------ */
/* ⭐ `vault_consents` already models DPDPA consent with a purpose    */
/* and a notice. `vault_access_log` is a log and falls under         */
/* CERT-In.                                                          */
/* ================================================================== */

const VAULT_SECRETS: TableClassification = {
  table: "vault_secrets",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "owner_id", principal: "user" },
    { via: "column", column: "created_by_user_id", principal: "user" },
  ],
  retention: null,
};
const VAULT_ACCESS_LOG: TableClassification = {
  table: "vault_access_log",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "user_email", identifier: "email" },
    { via: "column", column: "owner_id", principal: "user" },
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: "certin-180-day-logs",
};
const VAULT_CONSENTS: TableClassification = {
  table: "vault_consents",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_kind" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/views.ts                                                */
/* ================================================================== */

const SAVED_VIEWS: TableClassification = {
  table: "saved_views",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "owner_user_id", principal: "user" },
  ],
  retention: null,
};
const SAVED_VIEW_DEFAULTS: TableClassification = {
  table: "saved_view_defaults",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/work.ts                                                 */
/* ================================================================== */

const TASKS: TableClassification = {
  table: "tasks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "column", column: "assigned_to", principal: "user" },
    { via: "column", column: "completed_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const ACTIVITIES: TableClassification = {
  table: "activities",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "column", column: "user_id", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const CALENDAR_EVENTS: TableClassification = {
  table: "calendar_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "polymorphic", idColumn: "subject_id", kindColumn: "subject_type" },
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "updated_by", principal: "user" },
  ],
  retention: null,
};
const CALENDAR_EVENT_ATTENDEES: TableClassification = {
  table: "calendar_event_attendees",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "contact_id", principal: "contact" },
    { via: "column", column: "user_id", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/workflows.ts                                            */
/* ------------------------------------------------------------------ */
/* Automations. `workflow_run_steps.input`/`.output` carry           */
/* whatever the workflow moved, which is frequently a contact.       */
/* ================================================================== */

const WORKFLOWS: TableClassification = {
  table: "workflows",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "created_by", principal: "user" },
    { via: "column", column: "archived_by", principal: "user" },
  ],
  retention: null,
};
const WORKFLOW_VERSIONS: TableClassification = {
  table: "workflow_versions",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "run_as_user_id", principal: "user" },
    { via: "column", column: "published_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: null,
};
const WORKFLOW_RUNS: TableClassification = {
  table: "workflow_runs",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "column", column: "actor_user_id", principal: "user" },
    { via: "parent", column: "workflow_id", table: "workflows" },
  ],
  retention: null,
};
const WORKFLOW_RUN_STEPS: TableClassification = {
  table: "workflow_run_steps",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "run_id", table: "workflow_runs" },
  ],
  retention: null,
};
const WORKFLOW_TASKS: TableClassification = {
  table: "workflow_tasks",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "run_id", table: "workflow_runs" },
    { via: "column", column: "assigned_to_user_id", principal: "user" },
    { via: "column", column: "responded_by", principal: "user" },
  ],
  retention: null,
};

/* ================================================================== */
/* db/schema/dpdp.ts                                                  */
/* ------------------------------------------------------------------ */
/* ⭐ THE FOUR TABLES THIS BATCH ADDED, AND THE FIRST FOUR THE NEW      */
/* GATE EVER CAUGHT. They were written, the migration was written, and */
/* `check-data-classification` refused the build until somebody        */
/* decided what they hold — on real tables, on the first opportunity,  */
/* rather than on a fixture built to make it pass.                     */
/* ================================================================== */

const DATA_PRINCIPAL_REQUESTS: TableClassification = {
  table: "data_principal_requests",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "identifier", column: "principal_email", identifier: "email" },
    { via: "identifier", column: "principal_phone", identifier: "phone" },
    { via: "column", column: "verified_by", principal: "user" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "compliance-evidence",
};
const DATA_PRINCIPAL_REQUEST_ANCHORS: TableClassification = {
  table: "data_principal_request_anchors",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "request_id", table: "data_principal_requests" },
    { via: "column", column: "created_by", principal: "user" },
  ],
  retention: "compliance-evidence",
};
const DATA_PRINCIPAL_REQUEST_EVENTS: TableClassification = {
  table: "data_principal_request_events",
  scope: "tenant",
  holds: "personal",
  reaches: [
    { via: "parent", column: "request_id", table: "data_principal_requests" },
    { via: "column", column: "actor_user_id", principal: "user" },
  ],
  retention: "compliance-evidence",
};
const PERSONAL_DATA_BREACHES: TableClassification = {
  table: "personal_data_breaches",
  scope: "tenant",
  holds: "personal",
  reaches: [{ via: "column", column: "created_by", principal: "user" }],
  retention: "compliance-evidence",
};

/* ------------------------------------------------------------------ */
/* THE REGISTRY                                                        */
/* ------------------------------------------------------------------ */

export const CLASSIFICATION: readonly TableClassification[] = [
  LEDGERS,
  TRANSACTIONS,
  JOURNAL_ENTRIES,
  FINANCIAL_PERIODS,
  SALES_POSTING_ACCOUNTS,
  BILLING_RATES,
  TIME_ENTRIES,
  AGENT_DEFINITIONS,
  AGENT_TRIGGERS,
  AGENT_RUNS,
  AI_PROVIDER_CREDENTIALS,
  TENANT_PATTERNS,
  REPORTING_LINES,
  APPRAISAL_CYCLES,
  APPRAISAL_SUBJECTS,
  APPRAISAL_REVIEWS,
  APPRAISAL_AMENDMENTS,
  ASSETS,
  ASSET_RELATIONSHIPS,
  PERMISSION_DENIALS,
  BANK_ACCOUNTS,
  BANK_STATEMENTS,
  BANK_STATEMENT_LINES,
  BANK_LINE_MATCHES,
  BANK_CHARGE_ITC_DEFERRALS,
  SEAT_REQUESTS,
  SEAT_GRANTS,
  DATA_EXPORTS,
  IMPORT_RUNS,
  IMPORT_RUN_CHUNKS,
  IMPORT_MAPPING_PROPOSALS,
  IMPORT_ROW_PROVENANCE,
  IMPORT_ROW_PRIOR_VALUES,
  IMPORT_REVERSALS,
  IMPORT_REVERSAL_FAILURES,
  DRAWINGS,
  DRAWING_REVISIONS,
  DRAWING_MARKUPS,
  DRAWING_MEASUREMENTS,
  BANK_RECONCILIATIONS,
  BANK_RECONCILIATION_ITEMS,
  PLANS,
  SUBSCRIPTIONS,
  INVOICES,
  INVOICE_LINES,
  PAYMENT_EVENTS,
  PAYMENT_METHODS,
  COST_CENTRES,
  BUDGET_LINES,
  CAMPAIGNS,
  CAMPAIGN_RECIPIENTS,
  CONTRACTS,
  CONTRACT_VERSIONS,
  CLAUSE_LIBRARY,
  COMPLIANCE_OBLIGATIONS,
  COMPLIANCE_TASKS,
  COMPLIANCE_EVIDENCE,
  COMPLIANCE_LICENCES,
  BOQ_ITEM_MASTER,
  BOQS,
  BOQ_ITEMS,
  RATE_ANALYSES,
  RATE_ANALYSIS_COMPONENTS,
  BOQ_VARIATIONS,
  BOQ_VARIATION_ITEMS,
  MEASUREMENT_BOOKS,
  MEASUREMENT_ENTRIES,
  CONTRACT_ADVANCES,
  RETENTION_LEDGER,
  WORKS_CONTRACTS,
  COMPLIANCE_DOCS,
  ENGINEER_CERTIFICATIONS,
  RA_BILLS,
  RA_BILL_LINES,
  RETENTION_RELEASES,
  TENANTS,
  USERS,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  USER_ROLES,
  AUDIT_LOGS,
  CUSTOMER_CREDIT_PROFILES,
  APPROVAL_LIMITS,
  CREDIT_HOLD_EVENTS,
  CREDIT_HOLD_OVERRIDES,
  CREDIT_DUNNING_LADDERS,
  CREDIT_DUNNING_STAGES,
  CREDIT_DUNNING_LOG,
  COMPANIES,
  CONTACTS,
  DEALS,
  CUSTOM_OBJECT_DEFINITIONS,
  CUSTOM_FIELD_DEFINITIONS,
  CUSTOM_OBJECT_RECORDS,
  DYNAMIC_OBJECTS,
  DYNAMIC_FIELDS,
  EMAIL_OUTBOX,
  EMAIL_SUPPRESSIONS,
  FIELD_JOBS,
  FIELD_VISITS,
  FIELD_PROOFS,
  FIELD_JOB_MATERIALS,
  IT_ASSET_BLOCKS,
  FIXED_ASSETS,
  DEPRECIATION_RUNS,
  DEPRECIATION_LINES,
  LEAD_SOURCES,
  PIPELINE_STAGES,
  CONSENT_NOTICES,
  CONSENTS,
  MESSAGE_THREADS,
  THREAD_PARTICIPANTS,
  MESSAGES,
  CURRENCY_UNITS,
  FX_REFERENCE_RATES,
  FX_RATES,
  FX_REVALUATIONS,
  FX_REVALUATION_LINES,
  DEPLOYMENT_RELEASES,
  DEPLOYMENT_BACKUPS,
  UI_GOVERNANCE_CHECKS,
  FLOW_SUBMISSIONS,
  GST_REGISTRATIONS,
  GST_PARTIES,
  HSN_SAC_CODES,
  HSN_SAC_RATES,
  EWAY_BILLS,
  EWAY_BILL_VEHICLES,
  EWAY_BILL_ITEMS,
  GSTR2B_DOCUMENTS,
  GSTR2B_ROWS,
  GSTR2B_RECONCILIATIONS,
  GSTR2B_MATCHES,
  CONNECTIONS,
  SYNC_RUNS,
  WEBHOOK_ENDPOINTS,
  WEBHOOK_DELIVERIES,
  LEAD_INTAKE_FAILURES,
  WAREHOUSES,
  STOCK_ITEMS,
  STOCK_MOVEMENTS,
  STOCK_BALANCES,
  STOCK_RESERVATIONS,
  STOCK_COUNTS,
  STOCK_COUNT_LINES,
  STOCK_BATCHES,
  STOCK_SERIALS,
  GOODS_RETURNS,
  GOODS_RETURN_LINES,
  STOCK_WRITE_OFFS,
  STOCK_TRANSFERS,
  STOCK_TRANSFER_LINES,
  LANDED_COSTS,
  LANDED_COST_ALLOCATIONS,
  SITE_WORKERS,
  WELFARE_LOGS,
  PIECE_RATE_ENTRIES,
  SITE_ATTENDANCE,
  DUTY_ROSTERS,
  VENDOR_DEFAULTS,
  DAILY_SITE_LOGS,
  SITE_PHOTOS,
  LAND_PARCELS,
  TITLE_DOCUMENTS,
  LANDOWNERS,
  JOINT_DEVELOPMENT_AGREEMENTS,
  LAND_CONVERSIONS,
  KHATA_RECORDS,
  ESTAMP_CERTIFICATES,
  POWERS_OF_ATTORNEY,
  DUE_DILIGENCE_RECORDS,
  APPROVAL_SANCTIONS,
  LIAISON_LOGS,
  PLAN_SANCTIONS,
  LAND_REVENUE_RECORDS,
  LEAVE_PERIODS,
  HOLIDAY_CALENDAR,
  LEAVE_TYPES,
  LEAVE_LEDGER,
  LEAVE_REQUESTS,
  STAFF_ATTENDANCE,
  COURT_FEE_SCHEDULES,
  COURT_FEE_SLABS,
  MATTER_DISBURSEMENTS,
  COURT_FEE_REFUND_CLAIMS,
  LEGAL_PRACTICE_PROFILE,
  LEGAL_CLIENT_TAX_STATUS,
  LEGAL_MATTERS,
  LEGAL_MATTER_EVENTS,
  LEGAL_HEARINGS,
  COURT_HOLIDAYS,
  CLIENT_ACCOUNT_ENTRIES,
  MCP_TOKENS,
  MCP_CALL_LOG,
  MESSAGE_TEMPLATES,
  SERVICE_WINDOWS,
  MESSAGE_SENDS,
  USAGE_COUNTERS,
  USAGE_LEVELS,
  NOTIFICATIONS,
  SALES_ORDERS,
  SALES_ORDER_LINES,
  SALES_ORDER_FULFILLMENTS,
  SALES_ORDER_FULFILLMENT_LINES,
  SALES_ORDER_EVENTS,
  CUSTOMER_RHYTHMS,
  RHYTHM_SIGNALS,
  AUTOMATION_EVENTS,
  EMPLOYEES,
  PAY_COMPONENTS,
  EMPLOYEE_PAY_STRUCTURE,
  STATUTORY_RATES,
  PAYROLL_RUNS,
  PAYSLIPS,
  EMPLOYEE_SETTLEMENTS,
  EMPLOYEE_ADVANCES,
  EMPLOYEE_ADVANCE_INSTALMENTS,
  EMPLOYEE_ADVANCE_RECOVERIES,
  EMPLOYEE_REIMBURSEMENT_CLAIMS,
  PLATFORM_APPROVAL_QUEUE,
  PLATFORM_ENTITLEMENT_HISTORY,
  TENANT_HEALTH_EVENTS,
  PLATFORM_INCIDENTS,
  PLATFORM_STAFF,
  PLATFORM_IMPERSONATION_SESSIONS,
  TENANT_SUPPORT_CONSENTS,
  PLATFORM_TENANT_FLAGS,
  PLATFORM_ACTION_LOG,
  PORTAL_LINKS,
  CONTRACT_SIGNATURES,
  RATE_CARDS,
  RATE_SLABS,
  RATE_ADJUSTMENTS,
  RATE_QUOTES,
  PRICE_AGREEMENTS,
  POST_SUPPLY_DISCOUNTS,
  POST_SUPPLY_DISCOUNT_INVOICES,
  PURCHASE_ORDERS,
  PURCHASE_ORDER_LINES,
  GOODS_RECEIPTS,
  GOODS_RECEIPT_LINES,
  VENDOR_PAYMENTS,
  VENDOR_PAYMENT_ALLOCATIONS,
  VENDORS,
  PURCHASE_INVOICES,
  PURCHASE_INVOICE_LINES,
  ITC_REGISTER,
  VENDOR_LEDGER_ENTRIES,
  RECEIVABLE_POLICIES,
  DUNNING_POLICIES,
  DEMAND_NOTICES,
  DEMAND_NOTICE_DOCUMENTS,
  DUNNING_EVENTS,
  RECEIPTS,
  RECEIPT_ALLOCATIONS,
  GST_RETURNS,
  SALES_INVOICES,
  SALES_INVOICE_LINES,
  CUSTOMER_RECEIPTS,
  CUSTOMER_RECEIPT_ALLOCATIONS,
  SALES_CREDIT_NOTES,
  SALES_CREDIT_NOTE_LINES,
  PROJECTS,
  UNITS,
  LEADS,
  LEAD_ACTIVITIES,
  CHANNEL_PARTNERS,
  BOOKINGS,
  PAYMENT_MILESTONES,
  CHANNEL_PARTNER_COMMISSIONS,
  SCHEDULE_RESOURCES,
  SCHEDULE_BOOKINGS,
  SCHEDULE_BLOCKS,
  SECURITY_EVENTS,
  LOGIN_LOCKOUTS,
  RESERVED_SLUGS,
  TENANT_SLUG_HISTORY,
  DOCUMENTS,
  TALLY_CONNECTIONS,
  TALLY_LEDGER_MAPPINGS,
  TALLY_COST_CENTRE_MAPPINGS,
  TALLY_EXPORT_BATCHES,
  TALLY_VOUCHERS,
  TALLY_IMPORT_BATCHES,
  TALLY_RECONCILIATION_ITEMS,
  TDS_DEDUCTEES,
  TDS_LOWER_DEDUCTION_CERTIFICATES,
  TDS_CHALLANS,
  TDS_RETURNS,
  TDS_DEDUCTIONS,
  TDS_CERTIFICATES,
  ERROR_EVENTS,
  WEB_VITAL_EVENTS,
  UTILITY_METERS,
  METER_READINGS,
  METER_BILLING_PERIODS,
  VAULT_SECRETS,
  VAULT_ACCESS_LOG,
  VAULT_CONSENTS,
  SAVED_VIEWS,
  SAVED_VIEW_DEFAULTS,
  TASKS,
  ACTIVITIES,
  CALENDAR_EVENTS,
  CALENDAR_EVENT_ATTENDEES,
  WORKFLOWS,
  WORKFLOW_VERSIONS,
  WORKFLOW_RUNS,
  WORKFLOW_RUN_STEPS,
  WORKFLOW_TASKS,
  DATA_PRINCIPAL_REQUESTS,
  DATA_PRINCIPAL_REQUEST_ANCHORS,
  DATA_PRINCIPAL_REQUEST_EVENTS,
  PERSONAL_DATA_BREACHES,
];

export const CLASSIFIED_TABLES: ReadonlySet<string> = new Set(CLASSIFICATION.map((c) => c.table));

const BY_TABLE = new Map(CLASSIFICATION.map((c) => [c.table, c]));

export function classificationFor(table: string): TableClassification | null {
  return BY_TABLE.get(table) ?? null;
}

/**
 * ⭐ THE TABLES THE EXPORT CANNOT REACH, WHICH GO IN THE MANIFEST.
 *
 * 🔴 THIS IS THE ONE EXPORT THAT MUST NEVER RETURN AN EMPTY ARRAY
 * BECAUSE SOMEBODY TIDIED IT AWAY. An admitted gap in a file the
 * customer receives is a bug report. The same gap, unadmitted, is a
 * customer telling a Data Principal that this is everything.
 */
export function unreachableTables(): TableClassification[] {
  return CLASSIFICATION.filter(
    (c) => c.holds !== "operational" && c.reaches.some((r) => r.via === "none"),
  );
}

/**
 * 🔴 THE ONLY TABLES A WORKSPACE'S DATA-PRINCIPAL REQUEST MAY REACH.
 *
 * Everything a tenant-initiated export or erasure touches goes through
 * here. `platform`-scoped tables are Ordence's own Fiduciary duty and
 * answering a workspace's request out of them would disclose one
 * Fiduciary's records to another.
 */
export function tenantScopedTables(): TableClassification[] {
  return CLASSIFICATION.filter((c) => c.scope === "tenant");
}

/** Tables that are somebody's own record. */
export function principalTables(): TableClassification[] {
  return CLASSIFICATION.filter((c) => c.holds === "principal");
}

/**
 * ⚠️ EVERY TABLE THAT CARRIES PERSONAL DATA, INCLUDING THE ONES THE
 * EXPORT CANNOT REACH. Used by the erasure planner, which must consider
 * a table it cannot search — the answer there is "we could not look",
 * which is a different answer from "there was nothing".
 */
export function personalDataTables(): TableClassification[] {
  return CLASSIFICATION.filter((c) => c.holds !== "operational");
}
