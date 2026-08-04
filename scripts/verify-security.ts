/**
 * Ordence — Security State Verifier
 * Version: v0.10.0-alpha
 *
 * Run with:  npm run db:verify
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS SCRIPT EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `drizzle-kit push` compares your Drizzle schema against the live database
 * and removes anything it does not recognise. Our Row-Level Security
 * policies are defined in `SQL-FILES/`, not in the Drizzle schema, so
 * `push` classifies every one of them as drift and DROPS THEM.
 *
 * Measured on a real database during Phase 10:
 *
 *     before `drizzle-kit push`  ->  25 tables with RLS, 25 policies
 *     after  `drizzle-kit push`  ->   0 tables with RLS,  0 policies
 *
 * The application keeps working. Every page renders. Every query succeeds.
 * The ONLY difference is that tenants can now read each other's data, and
 * nothing anywhere says so.
 *
 * That is why this script exists and why it exits non-zero on failure: the
 * protection is invisible when present and invisible when absent, so the
 * only way to know is to ask the database directly.
 *
 * RUN IT AFTER EVERY `db:push`, AND IN CI.
 */

import { Pool } from "pg";

const REQUIRED_RLS_TABLES = [
  "tenants", "users", "roles", "role_permissions", "user_roles", "audit_logs",
  "companies", "contacts", "deals",
  "custom_object_definitions", "custom_field_definitions", "custom_object_records",
  "assets", "asset_relationships",
  "contracts", "contract_versions", "clause_library",
  "ledgers", "transactions", "journal_entries",
  "financial_periods", "permission_denials",
  "documents",
  "portal_links", "contract_signatures",
  // Phase 11 — billing. `plans` is deliberately absent: it is platform
  // catalogue data with no tenant_id, protected by GRANT rather than RLS.
  "subscriptions", "invoices", "invoice_lines", "payment_events", "payment_methods",
  // Phase 19 — telemetry. Nullable tenant_id (Web Vitals fire before a
  // session exists), but the policy still admits NULL rows only from a
  // platform-scoped connection.
  "error_events", "web_vital_events",
  // Phase 20 — the security event stream.
  "security_events",
  // Phase 15 — usage metering. Monotonic, not append-only: an increment is
  // an UPDATE and a DECREASE is refused by trigger. A meter that can be
  // wound backwards is a meter you cannot bill from.
  "usage_counters", "usage_levels",
  // Phases 17/18 — platform administration. The impersonation record is
  // append-only evidence.
  "platform_impersonation_sessions", "platform_tenant_flags",
  "tenant_support_consents",
  // ⚠️ PHASE 29 — ADDED IN v0.31.0, AND THEY WERE MISSING FOR TWO PHASES.
  //
  // `platform_staff` is the map of who can cross the tenant boundary: the
  // name, work address and grade of every person worth phishing. A
  // customer who could read it would learn our internal access model.
  // `platform_action_log` is the record of what our staff did that
  // belongs to no single customer — cross-tenant searches, staff grants,
  // refused permissions.
  //
  // Neither has a `tenant_id`; their policies admit ONLY the
  // platform-scoped connection. That is a stronger rule than the usual
  // one, and it was going unverified — a `drizzle-kit push` that dropped
  // either policy would have left this script reporting PASS while
  // every workspace could read both tables.
  "platform_staff", "platform_action_log",
  // Phase 25 sync preparation — the change log records WHAT CHANGED and
  // WHERE IT CAME FROM on 31 tables, including deletions. It is a
  // shadow copy of the customer's edit history; a gap here leaks the
  // same facts as the tables it mirrors, in one place.
  "change_log",
  // Phase 22 — sales pipeline & inventory. `leads` and `bookings` hold the
  // most commercially sensitive rows in the product: who is buying, at what
  // price, through which broker. A gap here is a competitor reading a
  // developer's entire pipeline.
  "projects", "units", "leads", "lead_activities",
  "channel_partners", "bookings", "payment_milestones",
  // Phase 23 — the automation engine. A workflow definition is a map of
  // how a company operates, and a run's context holds copies of the
  // records that passed through it. A gap here leaks both — and a run
  // pointing at another tenant's version would EXECUTE their program
  // inside this workspace, which is worse than any read.
  "workflows", "workflow_versions", "workflow_runs",
  "workflow_run_steps", "workflow_tasks",
  // Phase 24 — runtime custom objects. These two describe every table the
  // DDL engine has created; a gap here tells one workspace what another
  // one tracks, which is commercially sensitive before a single record
  // exists.
  //
  // ⚠️ THE PHYSICAL TABLES THEMSELVES ARE NOT IN THIS LIST AND CANNOT BE:
  // their names are chosen by customers at run time. They are swept
  // separately by Check 8 of `SQL-FILES/0019_phase24_dynamic_objects.sql`,
  // which walks every `cx_*` relation and reports any that is not
  // enabled, forced and policied. Re-run that file after every
  // `drizzle-kit push` — push DROPS POLICIES.
  "dynamic_objects", "dynamic_fields",
  // Phase 25 — saved views. A view is a description of how a company
  // looks at its own data: which pipeline stages it watches, whose deals,
  // what it counts as overdue. A gap here leaks that, and — because a
  // shared view is replayed on demand — it would also let one workspace
  // plant a view in another's picker.
  "saved_views", "saved_view_defaults",
  // Phase 32 — GST. `gst_registrations` and `gst_parties` are the map of
  // where a company is registered and who it trades with; `hsn_sac_rates`
  // is what it charges. A gap here leaks a competitor's counterparty list
  // — and would let one workspace plant a rate in another's master, which
  // every future invoice of theirs would then be priced from.
  "gst_registrations", "gst_parties", "hsn_sac_codes", "hsn_sac_rates",
  // Phase 33 — purchases and input tax credit. `purchase_invoices` and
  // `vendor_ledger_entries` are who a company buys from, at what price
  // and on what terms — the most commercially valuable table in the
  // product after the sales pipeline, and the one a competitor would
  // most like. `purchase_invoice_lines` is worse still: its
  // `itc_purpose` column says which buildings a developer is SELLING and
  // which it is keeping, months before either is public. `itc_register`
  // is the company's tax position.
  "vendors", "purchase_invoices", "purchase_invoice_lines",
  "itc_register", "vendor_ledger_entries",
  // ⭐ Phase 34 — GSTR-2B. `gstr2b_documents` and `gstr2b_rows` are a
  // GOVERNMENT-COMPILED list of every supplier who invoiced this company
  // in a month, with amounts. It is a more complete and more reliable
  // counterparty list than the tenant's own purchase ledger, because it
  // was assembled by somebody with no incentive to leave anything out —
  // which makes a leak here strictly worse than a leak of Phase 33.
  // `gstr2b_matches` adds which of those the company disputes, and
  // `gstr2b_reconciliations` is how much credit it took against them.
  "gstr2b_documents", "gstr2b_rows", "gstr2b_reconciliations", "gstr2b_matches",
  // ⭐ Phase 36 — TDS. `tds_deductees` is the most personally sensitive
  // table in the product: every contractor, consultant, landlord and
  // landowner the company pays, WITH THEIR PAN. A PAN is a government
  // identity number for a THIRD PARTY, held only because the Income-tax
  // Act requires it, and directly usable to look a person up elsewhere —
  // so a leak here is not a leak of the tenant's commercial position, it
  // is a leak of a hundred other people's identity documents.
  // `tds_deductions` is what each of them was paid, month by month, which
  // is a better picture of a competitor's cost base than the purchase
  // ledger, because the register is per PAN rather than per relationship.
  "tds_deductees", "tds_lower_deduction_certificates", "tds_challans",
  "tds_returns", "tds_deductions", "tds_certificates",
  // ⭐ Phase 37 — Tally. `tally_ledger_mappings` is a workspace's entire
  // chart of accounts, vendor list and customer list WITH GSTINs in one
  // table, and `tally_vouchers` is every transaction it has ever
  // exported, with the party and the amount on each. That is a more
  // complete commercial picture of a business than any single ledger in
  // this product, because an export is deliberately comprehensive — it
  // exists precisely to be everything.
  // ⚠️ AND `tally_connections` CARRIES `allow_private_host` AND A HOST.
  // Reading it tells you which workspaces have opened a path from our
  // servers into their office network and exactly where it points, which
  // is a map of the estate rather than a leak of data.
  "tally_connections", "tally_ledger_mappings", "tally_cost_centre_mappings",
  "tally_export_batches", "tally_vouchers", "tally_import_batches",
  "tally_reconciliation_items",
  // ⭐ Phase 38 — receivables. `demand_notices` joined to `receipts` is a
  // developer's ENTIRE CASH POSITION: what has been demanded, what has
  // actually come in, from which named buyers, how late, and — in
  // `dunning_events` — which of those buyers are being threatened with
  // cancellation. That last table is the one that makes this group
  // different from every other commercial leak in the product: it is a
  // list of named individuals in financial difficulty over their own
  // home, and it belongs to a workspace's customers rather than to the
  // workspace.
  //
  // ⚠️ `demand_notice_documents` HOLDS THE SERVED DOCUMENT ITSELF, with
  // the buyer's name, unit and amount rendered into readable prose. A gap
  // there does not leak a row somebody has to interpret — it leaks the
  // letter.
  "receivable_policies", "dunning_policies", "demand_notices",
  "demand_notice_documents", "dunning_events", "receipts",
  "receipt_allocations",
] as const;

const REQUIRED_ANALYTICS_VIEWS = [
  "v_asset_portfolio",
  "v_ledger_daily",
  "v_contract_pipeline",
  // Phase 19. Without security_invoker this view hands every tenant's
  // error volume and performance profile to every other tenant.
  "telemetry_daily",
] as const;

const REQUIRED_TRIGGERS = [
  "journal_entries_balance_check",
  "journal_entries_period_lock",
  "documents_tenant_immutable",
  "documents_parent_immutable",
  "portal_links_tamper_guard",
  "contract_signatures_no_update",
  "contract_signatures_no_delete",
  // Phase 11 — billing integrity.
  "payment_events_no_update",
  "payment_events_no_delete",
  "invoices_issued_immutable",
  "invoice_lines_issued_immutable",
  "subscriptions_tenant_fixed",
  // Phase 19/20 — observability evidence is append-only for the same
  // reason payment evidence is: a record of an incident that can be
  // edited proves nothing.
  "security_events_no_update",
  "security_events_no_delete",
  // Phase 15 — the monotonic guard. Without it a tenant could wind their
  // own usage back to zero and never be billed for anything.
  "usage_counters_monotonic",
  // Phase 22 — the inventory guards. `bookings_unit_bookable` is the one
  // that takes FOR UPDATE on the unit; without it two reps booking the same
  // flat race, and the unique index becomes the only thing standing between
  // them and a double sale.
  "bookings_unit_bookable",
  "bookings_sync_unit",
  "units_hold_valid",
  "leads_cp_lock",
  "lead_activities_append_only",
  // Phase 23 — the loop guard. `workflow_runs_chain_guard` RECOMPUTES a
  // run's depth and causal chain from its parent instead of trusting the
  // caller, and refuses a version that is already in the chain. Without
  // it, "when a lead is updated, update the lead" is an infinite loop
  // that starts the moment somebody saves it.
  "workflow_runs_chain_guard",
  "workflow_runs_final",
  "workflow_versions_immutable",
  "workflows_no_delete_with_runs",
  "workflow_tasks_answered_once",
  // Phase 25 — the sharing guards. `saved_view_defaults_visible` refuses
  // a default that points at somebody else's private view, and
  // `saved_views_unshare` clears the defaults that un-sharing would
  // otherwise strand — a list page pointing at a view its owner may no
  // longer open does not render at all.
  "saved_view_defaults_visible",
  "saved_views_unshare",
  "saved_views_tenant_cap",
  // Phase 32 — ⭐ the rate-history guard. Without
  // `hsn_sac_rates_history_immutable`, "correcting" a rate in the master
  // silently restates every invoice ever raised under it: the PDFs
  // already sent stop matching the system, the GSTR-1 reconciliation for
  // that period fails, and nothing errors. `invoices_gst_reconciles` is
  // the deferred constraint trigger that refuses a document whose foot
  // disagrees with its own tax column.
  "hsn_sac_rates_history_immutable",
  "hsn_sac_rates_no_delete_when_used",
  "invoices_gst_reconciles",
  "invoice_lines_gst_reconciles",
  // Phase 33 — ⭐ the input-tax-credit guards. Each refuses something
  // that is silent, profitable in the short run, and expensive later:
  //
  //   `purchase_invoices_reconciles` — an invoice whose ITC split
  //     disagrees with its own lines. The eligible figure goes into a
  //     GSTR-3B and the blocked figure into the cost of a building; a gap
  //     reaches neither, and the return and the books then differ by
  //     exactly that amount, permanently, with no error.
  //   `itc_register_claim_matches_determination` — a credit claimed
  //     against a line the determination found BLOCKED under Section
  //     17(5).
  //   `itc_register_not_claimed_twice` — the SAME credit claimed in two
  //     different tax periods. Two rows, two months, two perfectly valid
  //     unique keys, and the same rupee claimed twice.
  "purchase_invoices_reconciles",
  "purchase_invoice_lines_reconciles",
  "itc_register_claim_matches_determination",
  "itc_register_not_claimed_twice",

  // ⭐ Phase 34 — the GSTR-2B guards. Each refuses something that is
  // silent, plausible at the time, and expensive later:
  //
  //   `gstr2b_documents_raw_immutable` — the raw statement being
  //     overwritten by our own interpretation of it. It is the only
  //     artefact in the product the customer cannot reconstruct from
  //     their own paper, and the portal will never serve the same
  //     GENERATION of a month again — it regenerates whenever a supplier
  //     files late.
  //   `gstr2b_documents_period_not_filed` and
  //     `gstr2b_reconciliations_frozen` — a FILED period being silently
  //     rewritten by a re-import. Re-importing is ordinary work; what
  //     must not happen is the working paper for a GSTR-3B the
  //     Government holds a copy of quietly ceasing to describe what was
  //     filed.
  //   `gstr2b_reconciliations_summary_agrees` — stored totals that do
  //     not describe the matches actually held. A dropped invoice makes
  //     "in books, not in 2B" SMALLER than it should be, which reads as
  //     good news: fewer suppliers to chase, more credit available.
  //   `gstr2b_matches_within_statement` — a match reaching across two
  //     registrations or two periods. Whether the supplier filed IN THIS
  //     PERIOD is the entire question Section 16(2)(aa) turns on.
  "gstr2b_documents_raw_immutable",
  "gstr2b_documents_period_not_filed",
  "gstr2b_reconciliations_frozen",
  "gstr2b_matches_not_filed",
  "gstr2b_matches_within_statement",
  "gstr2b_reconciliations_summary_agrees",
  "gstr2b_matches_summary_agrees",

  // ⭐ Phase 36 — the TDS guards. Each refuses something that is silent at
  // the time, lands on a THIRD PARTY first, and becomes ours later:
  //
  //   `tds_deductions_accumulation` — ⭐⭐ the one the phase exists for.
  //     Four ₹25,000 payments to a labour contractor cross Section 194C's
  //     ₹1,00,000 annual threshold, at which point tax is due on the
  //     WHOLE ₹1,00,000. This refuses a group that has deducted on part
  //     of its own aggregate, and it also refuses a running total that
  //     stops adding up — the aggregate is what the threshold was tested
  //     against, so a wrong one decided the deduction wrongly.
  //   `tds_deductions_rate_floor` — a deductee with no usable PAN
  //     deducted below the Section 206AA rate. TRACES raises a
  //     short-deduction demand for the whole year, and Section 205 bars
  //     recovering it from the deductee once it is deposited.
  //   `tds_deductions_certificate_window` — a Section 197 certificate
  //     applied outside its validity window, or to another section. A
  //     lapsed certificate is a real, correctly issued document and is no
  //     defence at all for the period after it closed.
  //   `tds_deductions_challan_capacity` / `tds_challans_capacity` — ⭐
  //     more tax mapped to a challan than was deposited into it. The
  //     return is ACCEPTED and the excess deductees get NO credit in
  //     their Form 26AS, chosen by the order the Department processes
  //     records in. They find out in October.
  "tds_deductions_accumulation",
  "tds_deductions_rate_floor",
  "tds_deductions_certificate_window",
  "tds_deductions_challan_capacity",
  "tds_challans_capacity",

  // ⭐ Phase 37 — the Tally guards. These protect books this product does
  // not own, which is why none of their failures is visible from inside
  // it:
  //
  //   `tally_vouchers_key_stability` — ⭐⭐ the one the phase exists for.
  //     Tally de-duplicates imported vouchers on REMOTEID and on nothing
  //     else. A source row that acquires a SECOND key gets a SECOND
  //     voucher in the customer's statutory books — both balanced, so the
  //     trial balance still balances, every register still foots, and the
  //     period's turnover is simply doubled. It is found months later by
  //     an auditor comparing the books to the GSTR-1.
  //   `tally_vouchers_batch_totals` / `tally_export_batches_totals` — the
  //     stored totals on a batch must equal the vouchers in it. They are
  //     what a person reads and what gets compared against the
  //     accountant's import summary, so a batch disagreeing with its own
  //     contents is a reconciliation that passes against a number nobody
  //     ever saw.
  //   `tally_mapping_kind_check` — a mapping pointing at another tenant's
  //     ledger, or at the wrong KIND of record. `source_id` is
  //     polymorphic and can carry no composite foreign key, so if this
  //     trigger is not doing it, nothing is.
  "tally_vouchers_key_stability",
  "tally_vouchers_batch_totals",
  "tally_export_batches_totals",
  "tally_mapping_kind_check",

  // ⭐ Phase 38 — the receivables guards. Every one of them protects a
  // document that has been served on a member of the public, which is why
  // none of their failures is visible from inside the product:
  //
  //   `receipt_allocations_sum_exactly` / `receipts_allocation_totals` /
  //     `demand_notices_allocation_totals` — ⭐⭐ a buyer's ₹5,00,000 must
  //     land somewhere exactly, and the receipt total, the demand totals
  //     and the allocation rows are read by three different screens. A
  //     gap between them is money applied to a demand nobody can name, or
  //     missing from one that keeps ageing and keeps being chased — found
  //     a year later by whoever prepares a statement for a buyer already
  //     in dispute.
  //   `dunning_events_no_skipped_rung` — ⭐⭐ reminder → first notice →
  //     final notice → cancellation warning. A buyer shown a later rung
  //     who never received an earlier one has a complete answer at the
  //     Authority, with the developer's own table as the evidence against
  //     them. The back-fill path is the one that skips, and the back-fill
  //     does not go through the application.
  //   `demand_notices_frozen_once_issued` — ⭐ the buyer holds a copy of
  //     the document, and their copy is the one that counts. A register
  //     that quietly disagrees with the paper served on somebody is worse
  //     than no register.
  "receipt_allocations_sum_exactly",
  "receipts_allocation_totals",
  "demand_notices_allocation_totals",
  "dunning_events_no_skipped_rung",
  "demand_notices_frozen_once_issued",

  /* ---- ⭐ PHASES 17/29 — THE EVIDENCE OF OUR OWN ACCESS ----------- */
  //
  // ⚠️ ADDED IN v0.31.0. Every one of these existed and none was
  // verified, which is the same failure this whole script was written
  // to prevent: a protection that is invisible when present and
  // invisible when absent.
  //
  // These are the guards on the records of what OUR STAFF did inside a
  // CUSTOMER'S workspace. Everything else in this list protects the
  // customer from themselves or from another tenant. This group
  // protects the customer from us, which makes it the group with the
  // strongest incentive behind removing it.
  //
  // `impersonation_freeze` pins the columns that constitute the
  // evidence — who, which tenant, under what consent, until when — so a
  // live session cannot be quietly relabelled after the fact.
  // `impersonation_no_delete` refuses the DELETE outright, including to
  // the database owner: a superuser is exempt from RLS and is NOT
  // exempt from triggers.
  "impersonation_freeze",
  "impersonation_no_delete",
  // The customer's permission. A consent row that can be edited cannot
  // prove permission was given, and one that can be deleted cannot
  // prove it was not.
  "support_consent_freeze",
  "support_consent_no_delete",
  // The cross-tenant action register. Without these an operator can
  // erase their own tracks, and the console keeps rendering.
  "platform_action_log_no_update",
  "platform_action_log_no_delete",

  /* ---- THE AUDIT TRAIL ITSELF ------------------------------------ */
  //
  // ⚠️ ALSO ADDED IN v0.31.0, AND IT IS ASTONISHING THAT IT WAS ABSENT.
  // `audit_logs` is the table every other claim in this product is
  // ultimately settled from. `tests/security/audit-immutability.test.ts`
  // has proved these triggers work since Phase 5; nothing checked they
  // were still installed on a live database after a push.
  "audit_logs_no_update",
  "audit_logs_no_delete",
  // The record of BLOCKED attempts, which is the half a security review
  // actually reads.
  "permission_denials_no_update",
  "permission_denials_no_delete",
] as const;

/**
 * ⭐ THE IMPERSONATION DELETE GUARD — v0.31.0.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE LIST AND NOT MORE ROWS IN `REQUIRED_TRIGGERS`
 * ══════════════════════════════════════════════════════════════════════
 * Every trigger above has a unique name. This one has the SAME name on
 * nineteen tables — `0014_phase17_platform.sql` installs it in a loop —
 * so a name-based check would pass while eighteen of the nineteen were
 * missing.
 *
 * That distinction is the whole point. The guard refuses DELETE while
 * `app.impersonation_id` is set, and it is the ONE forbidden operation
 * that does not depend on a developer remembering to call the TypeScript
 * gate. Deletion is also the only forbidden operation a customer cannot
 * detect afterwards: a deleted contact leaves no trace in their UI.
 *
 * ⚠️ AS OF v0.31.0 THIS GUARD IS LOADED. Until then `withTenant()` pinned
 * only the tenant id, nothing set `app.impersonation_id`, and the trigger
 * was installed, correct and INERT for two phases. It now fires, so a
 * table missing from the list below is a table an impersonating operator
 * can delete from.
 */
const IMPERSONATION_GUARDED_TABLES = [
  // Customer records
  "contacts", "companies", "deals", "custom_object_records",
  "assets", "documents", "contracts", "contract_versions",
  // Financial history
  "journal_entries", "transactions", "ledgers",
  // Money
  "subscriptions", "invoices", "invoice_lines", "payment_methods",
  // Access — the group that matters most. An impersonator who can delete
  // a user, a role or a role assignment can change who holds what, and
  // the change outlives the session.
  "users", "user_roles", "roles", "portal_links",
  // Phase 33 — the purchase ledger and the ITC register. ⚠️ A DELETED
  // PURCHASE INVOICE IS WORSE THAN A DELETED CONTACT, because it removes
  // the evidence for a credit ALREADY CLAIMED in a return the Government
  // holds a copy of. The customer's books then show less input tax than
  // their own filed GSTR-3B — a discrepancy in the direction that looks
  // like under-claiming, with no cause anywhere in their data.
  "vendors", "purchase_invoices", "purchase_invoice_lines",
  "itc_register", "vendor_ledger_entries",
  // ⭐ Phase 34 — and `gstr2b_documents` is the strongest case on this
  // whole list. A deleted purchase invoice can be re-entered from the
  // paper in the file. A deleted GSTR-2B statement can only be
  // re-downloaded from a portal that will never serve the same
  // generation of it again, because it regenerates whenever a supplier
  // files late. It is the one table whose contents the customer cannot
  // reconstruct from anything they hold.
  "gstr2b_documents", "gstr2b_rows", "gstr2b_reconciliations", "gstr2b_matches",
  // ⭐ Phase 36 — and the case here is different from every other entry on
  // this list. A deleted purchase invoice can be re-entered from the paper
  // in the file. A deleted TDS deduction cannot be undone at all: the tax
  // has already been paid to the Government under the customer's TAN and,
  // once the return is filed, credited to a THIRD PARTY'S Form 26AS. The
  // customer's books then show less tax withheld than the Government's
  // records show received, on behalf of a deductee whose name is no longer
  // anywhere — and the deductee has already claimed it on their own
  // return.
  "tds_deductees", "tds_lower_deduction_certificates", "tds_challans",
  "tds_returns", "tds_deductions", "tds_certificates",
  // ⭐ Phase 37. An export batch is not history, it is STATE: it is what
  // answers "have we already imported April?", and the wrong answer to
  // that question doubles a company's turnover. Deleting one does not
  // merely lose a record — it actively causes the failure the phase
  // exists to prevent, because the next export sees no prior delivery and
  // sends every voucher again as a CREATE. A support session wearing a
  // customer's face must not be able to set that in motion, and it would
  // leave no trace in the customer's own UI.
  "tally_export_batches", "tally_vouchers", "tally_import_batches",
  // ⭐ Phase 38, and the argument here is unlike every other entry on this
  // list because the missing row would be evidence in a dispute between
  // the CUSTOMER and a THIRD PARTY.
  //
  // Everything else protects a customer's own records from us. A deleted
  // demand notice deprives the customer of the document they served, on
  // which they charge interest and on which a termination rests — and a
  // demand that was never raised looks identical, from every screen they
  // have, to a demand that was deleted. A deleted rung of the dunning
  // ladder is a gap in the sequence a developer must produce before
  // forfeiting somebody's money, and the buyer's copy of the letter still
  // exists. A deleted receipt is somebody's money going missing from the
  // account of the person who paid it.
  "demand_notices", "demand_notice_documents", "dunning_events", "receipts",
  "receipt_allocations",
] as const;

/**
 * The accessors every policy and guard is written against.
 *
 * ⚠️ A MISSING FUNCTION IS NOT A LOUD FAILURE. `current_setting(name,
 * true)` returns NULL rather than raising, so a policy reading a
 * function that no longer exists fails at CREATE time — but a database
 * restored from a dump taken before Phase 17 simply has no
 * `app_current_impersonation_id()`, and the delete guard's trigger
 * function then errors on every DELETE it touches. Named here so the
 * answer arrives from this script instead of from a stack trace.
 */
const REQUIRED_FUNCTIONS = [
  "app_current_tenant_id",
  "app_is_platform_scope",
  "app_current_impersonation_id",
  "refuse_delete_under_impersonation",
] as const;

/**
 * Phase 22. Created by `SQL-FILES/0016_phase22_sales.sql`, never by the
 * Drizzle schema — Drizzle has no way to express a composite FK to a
 * (id, tenant_id) pair, and that pair is the whole point.
 */
const REQUIRED_COMPOSITE_FKS = [
  "units_project_same_tenant",
  "leads_project_same_tenant",
  "lead_activities_lead_same_tenant",
  "bookings_unit_same_tenant",
  "bookings_lead_same_tenant",
  "bookings_partner_same_tenant",
  "milestones_booking_same_tenant",
  "leads_partner_same_tenant",
  "units_held_lead_same_tenant",
  // ⚠️ The four edges into `users`. These were MISSING from both the SQL
  // and this list for a whole phase, and because they were missing from
  // this list the check reported PASS the entire time.
  //
  // The lesson is about the SCOPE of a cross-tenant audit: "every table
  // in this phase" is the wrong boundary. The right one is every column
  // that points at a tenant-scoped table, wherever that table lives.
  "leads_owner_same_tenant",
  "units_held_by_same_tenant",
  "bookings_rep_same_tenant",
  "lead_activities_user_same_tenant",
  // Phase 23. `workflow_runs_version_same_tenant` is the most important
  // one in this list: without it a run in tenant A can point at tenant
  // B's version and execute B's program against A's data, as one of A's
  // users, with every step authorised correctly and nothing logged.
  "workflow_versions_workflow_same_tenant",
  "workflow_versions_run_as_same_tenant",
  "workflow_runs_workflow_same_tenant",
  "workflow_runs_version_same_tenant",
  "workflow_runs_parent_same_tenant",
  "workflow_runs_actor_same_tenant",
  "workflow_run_steps_run_same_tenant",
  "workflow_tasks_run_same_tenant",
  "workflow_tasks_assignee_same_tenant",
  // Phase 24. A field whose `relation_object_id` points at another
  // tenant's object would make the record picker list their records —
  // the physical foreign key would refuse the write, but the picker
  // query is "rows of the table this field points at".
  "dynamic_fields_object_same_tenant",
  "dynamic_fields_relation_same_tenant",
  "dynamic_objects_created_by_same_tenant",
  // Phase 25. `saved_views_owner_same_tenant` is the one that matters:
  // pointed at a user in another tenant it is an existence oracle, and
  // deleting that user writes into this tenant's rows.
  "saved_views_owner_same_tenant",
  "saved_views_created_by_same_tenant",
  "saved_views_dynamic_object_same_tenant",
  "saved_view_defaults_user_same_tenant",
  "saved_view_defaults_view_same_tenant",
  "saved_view_defaults_dynamic_object_same_tenant",
  // Phase 32. `invoice_lines_gst_rate_same_tenant` is the one that
  // matters: without it an invoice in tenant A can be priced from tenant
  // B's rate master, so when somebody asks "why is this 12%?" the answer
  // is not in their data at all.
  "hsn_sac_rates_code_same_tenant",
  "gst_registrations_created_by_same_tenant",
  "gst_parties_lead_same_tenant",
  "gst_parties_partner_same_tenant",
  "gst_parties_company_same_tenant",
  "invoices_supplier_registration_same_tenant",
  "invoice_lines_gst_rate_same_tenant",
  // Phase 33. `purchase_invoice_lines_project_same_tenant` is the one
  // that matters most here: `itc_purpose` plus `project_id` IS the
  // evidence for the largest determination a developer makes, and a line
  // pointing at another tenant's project makes that evidence trail lead
  // to a building somebody else owns.
  "vendors_party_same_tenant",
  "vendors_company_same_tenant",
  "purchase_invoices_vendor_same_tenant",
  "purchase_invoices_registration_same_tenant",
  "purchase_invoices_project_same_tenant",
  "purchase_invoice_lines_invoice_same_tenant",
  "purchase_invoice_lines_rate_same_tenant",
  "purchase_invoice_lines_project_same_tenant",
  "itc_register_invoice_same_tenant",
  "itc_register_line_same_tenant",
  "itc_register_vendor_same_tenant",
  "vendor_ledger_vendor_same_tenant",
  "vendor_ledger_invoice_same_tenant",
  // ⭐ Phase 34. `gstr2b_matches_invoice_same_tenant` is the one that
  // matters most here, and not only because it stops a cross-tenant
  // pointer: without it, guessing purchase-invoice ids until one is
  // ACCEPTED is an existence oracle over another developer's purchase
  // ledger, and the resulting "matched" row confirms every hit.
  "gstr2b_documents_registration_same_tenant",
  "gstr2b_rows_document_same_tenant",
  "gstr2b_reconciliations_document_same_tenant",
  "gstr2b_matches_reconciliation_same_tenant",
  "gstr2b_matches_row_same_tenant",
  "gstr2b_matches_invoice_same_tenant",
  "gstr2b_matches_vendor_same_tenant",
  // ⭐ Phase 36. `tds_deductions_challan_same_tenant` is the one that
  // matters most, and not only because it stops a cross-tenant pointer:
  // without it, tenant B's deductions could be discharged by tenant A's
  // deposit — over-utilising A's challan with money that is not theirs,
  // so A's return silently withholds credit from A's OWN vendors, with
  // the cause sitting in a table A cannot read. `tds_deductions_
  // deductee_same_tenant` is a close second: guessing deductee ids until
  // one is accepted is an existence oracle over another developer's PAN
  // register.
  "tds_deductees_vendor_same_tenant",
  "tds_deductees_partner_same_tenant",
  "tds_ldc_deductee_same_tenant",
  "tds_deductions_deductee_same_tenant",
  "tds_deductions_certificate_same_tenant",
  "tds_deductions_challan_same_tenant",
  "tds_deductions_return_same_tenant",
  "tds_deductions_invoice_same_tenant",
  "tds_deductions_vendor_same_tenant",
  "tds_deductions_project_same_tenant",
  "tds_certificates_deductee_same_tenant",
  // ⭐ Phase 37. `tally_vouchers_batch_same_tenant` is the one that
  // matters most: without it tenant A could plant a voucher inside
  // tenant B's export batch, and when B generates the file that voucher —
  // party name, amount and all — goes into B's Tally company. B's
  // accountant then imports a transaction belonging to a business they
  // have never heard of, and B's batch totals fail the Section 7 check
  // for reasons entirely inside a table B cannot read.
  // `tally_reconciliation_voucher_same_tenant` is a close second: it
  // would publish another workspace's voucher number, date, party and
  // amount into a report this one reads.
  "tally_vouchers_batch_same_tenant",
  "tally_export_batches_connection_same_tenant",
  "tally_import_batches_connection_same_tenant",
  "tally_reconciliation_batch_same_tenant",
  "tally_reconciliation_voucher_same_tenant",
  "tally_cost_centre_project_same_tenant",
  // ⭐ Phase 38. `demand_notices_milestone_same_tenant` is the one that
  // matters most: without it a demand in tenant A can point at tenant B's
  // payment milestone, so the notice served on A's buyer would state a
  // construction event from a building A does not own — on a document
  // relied on to charge interest and, eventually, to terminate an
  // allotment.
  //
  // `receipt_allocations_demand_same_tenant` is a close second: it would
  // apply one workspace's money against another's demand, so B's buyer
  // would be told their outstanding is lower than it is, by a payment
  // nobody in B's workspace can see.
  "demand_notices_booking_same_tenant",
  "demand_notices_milestone_same_tenant",
  "demand_notices_project_same_tenant",
  "demand_notices_lead_same_tenant",
  "demand_notices_issued_by_same_tenant",
  "demand_notices_superseded_by_same_tenant",
  "demand_notice_documents_demand_same_tenant",
  "dunning_events_demand_same_tenant",
  "dunning_events_document_same_tenant",
  "dunning_events_authorised_by_same_tenant",
  "receipts_booking_same_tenant",
  "receipts_project_same_tenant",
  "receipts_lead_same_tenant",
  "receipts_created_by_same_tenant",
  "receipt_allocations_receipt_same_tenant",
  "receipt_allocations_demand_same_tenant",
  "receipt_allocations_allocated_by_same_tenant",
  "receivable_policies_project_same_tenant",
  "dunning_policies_project_same_tenant",
] as const;

type Check = { name: string; ok: boolean; detail: string; fatal: boolean };

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string, fatal = true) {
  checks.push({ name, ok, detail, fatal });
}

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

  if (!url) {
    console.error("DATABASE_URL is not set. Nothing to verify.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });

  try {
    /* ---- 1. RLS ENABLED AND FORCED --------------------------------- */
    // FORCE is the one people forget. Without it the table OWNER — often
    // the role the application connects as — bypasses every policy, and the
    // isolation is decorative.
    const rls = await pool.query<{ tablename: string; enabled: boolean; forced: boolean }>(
      `SELECT c.relname AS tablename,
              c.relrowsecurity AS enabled,
              c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [REQUIRED_RLS_TABLES as unknown as string[]],
    );

    const rlsMap = new Map(rls.rows.map((r) => [r.tablename, r]));
    const missingRls = REQUIRED_RLS_TABLES.filter((t) => {
      const row = rlsMap.get(t);
      return !row || !row.enabled || !row.forced;
    });

    record(
      "Row-Level Security enabled AND forced",
      missingRls.length === 0,
      missingRls.length === 0
        ? `all ${REQUIRED_RLS_TABLES.length} tables protected`
        : `UNPROTECTED: ${missingRls.join(", ")}`,
    );

    /* ---- 2. ISOLATION POLICIES EXIST ------------------------------- */
    const policies = await pool.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'`,
    );

    const tablesWithPolicy = new Set(policies.rows.map((r) => r.tablename));
    const missingPolicy = REQUIRED_RLS_TABLES.filter((t) => !tablesWithPolicy.has(t));

    record(
      "Tenant isolation policies present",
      missingPolicy.length === 0,
      missingPolicy.length === 0
        ? `${policies.rows.length} policies across ${tablesWithPolicy.size} tables`
        : `NO POLICY: ${missingPolicy.join(", ")}`,
    );

    /* ---- 3. POLICIES COVER WRITES TOO ------------------------------ */
    // A USING-only policy governs reads. Without WITH CHECK, a tenant can
    // INSERT a row stamped with someone else's tenant_id — invisible to
    // them afterwards, but sitting in the victim's workspace.
    const readOnlyPolicies = policies.rows.filter((r) => r.qual && !r.with_check);

    record(
      "Policies cover writes (WITH CHECK)",
      readOnlyPolicies.length === 0,
      readOnlyPolicies.length === 0
        ? "every policy defines USING and WITH CHECK"
        : `MISSING WITH CHECK: ${readOnlyPolicies.map((r) => `${r.tablename}.${r.policyname}`).join(", ")}`,
    );

    /* ---- 4. ⭐ ANALYTICS VIEWS RUN AS THE CALLER -------------------- */
    // A view without security_invoker runs as its OWNER and returns EVERY
    // tenant's aggregates, with no error and no visible symptom.
    const views = await pool.query<{ relname: string; invoker: boolean }>(
      `SELECT c.relname,
              COALESCE(c.reloptions @> ARRAY['security_invoker=true'], false) AS invoker
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($1)`,
      [REQUIRED_ANALYTICS_VIEWS as unknown as string[]],
    );

    const viewMap = new Map(views.rows.map((r) => [r.relname, r.invoker]));
    const leakyViews = REQUIRED_ANALYTICS_VIEWS.filter((v) => viewMap.get(v) !== true);

    record(
      "Analytics views run with security_invoker",
      leakyViews.length === 0,
      leakyViews.length === 0
        ? `all ${REQUIRED_ANALYTICS_VIEWS.length} views apply the caller's RLS`
        : `LEAKING ACROSS TENANTS: ${leakyViews.join(", ")}`,
    );

    /* ---- 5. INTEGRITY TRIGGERS ------------------------------------- */
    const triggers = await pool.query<{ tgname: string }>(
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
    );

    const triggerNames = new Set(triggers.rows.map((r) => r.tgname));
    const missingTriggers = REQUIRED_TRIGGERS.filter((t) => !triggerNames.has(t));

    record(
      "Financial and evidence triggers installed",
      missingTriggers.length === 0,
      missingTriggers.length === 0
        ? `${triggerNames.size} triggers present`
        : `MISSING: ${missingTriggers.join(", ")}`,
    );

    /* ---- 5b. ⭐ THE IMPERSONATION DELETE GUARD (Phases 17/29/31) --- */
    //
    // Checked by (trigger name, table) rather than by name alone: the
    // guard carries ONE name across nineteen tables, so a name-only
    // check passes while eighteen are missing. See the note on
    // `IMPERSONATION_GUARDED_TABLES`.
    const impersonationGuard = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgname = 'no_delete_under_impersonation'`,
    );

    const guarded = new Set(impersonationGuard.rows.map((r) => r.relname));
    const unguarded = IMPERSONATION_GUARDED_TABLES.filter((t) => !guarded.has(t));

    record(
      "⭐ Support impersonation cannot delete customer data",
      unguarded.length === 0,
      unguarded.length === 0
        ? `all ${IMPERSONATION_GUARDED_TABLES.length} tables refuse DELETE during a support session`
        : `UNGUARDED: ${unguarded.join(", ")} — our own staff can delete from ` +
          `these while impersonating a customer, and the customer cannot see it happen`,
    );

    /* ---- 5c. THE ACCESSOR FUNCTIONS THE POLICIES READ --------------- */
    const functions = await pool.query<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [REQUIRED_FUNCTIONS as unknown as string[]],
    );
    const functionNames = new Set(functions.rows.map((r) => r.proname));
    const missingFunctions = REQUIRED_FUNCTIONS.filter((f) => !functionNames.has(f));

    record(
      "Policy accessor functions present",
      missingFunctions.length === 0,
      missingFunctions.length === 0
        ? `all ${REQUIRED_FUNCTIONS.length} accessors defined`
        : `MISSING: ${missingFunctions.join(", ")} — re-run SQL-FILES/ALL-IN-ONE-SETUP.sql`,
    );

    /* ---- 6. APPEND-ONLY TABLES ------------------------------------- */
    const appendOnly = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT c.relname)::text AS n
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND (t.tgname LIKE '%_no_update' OR t.tgname LIKE '%_no_delete')`,
    );

    const appendOnlyCount = Number(appendOnly.rows[0]?.n ?? 0);
    record(
      "Append-only evidence tables",
      appendOnlyCount >= 5,
      `${appendOnlyCount} tables are append-only (expected 5+)`,
    );

    /* ---- 6b. ⭐ WEBHOOK REPLAY PROTECTION (Phase 11) ---------------- */
    //
    // THE most important single check in the billing subsystem. The unique
    // index on (provider, provider_event_id) is the ENTIRE defence against
    // a retried webhook being processed twice — which means a customer
    // charged twice, with no error and no symptom anywhere.
    //
    // `drizzle-kit push` recreates indexes it knows about, so this should
    // survive a push. It is checked anyway, because the cost of being
    // wrong here is a refund and a lost customer.
    const billingIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('payment_events_provider_event_unique',
                           'subscriptions_one_live_per_tenant',
                           -- ⚠️ Phase 22. This list is an ALLOWLIST, not a
                           -- pattern — a new critical index that is not added
                           -- here reads as MISSING even when it exists, which
                           -- is exactly what happened when this one was first
                           -- checked. Failing loud in that direction is the
                           -- right way round, but the list has to be kept up.
                           'bookings_one_live_per_unit')`,
    );
    const indexNames = new Set(billingIndexes.rows.map((r) => r.indexname));

    record(
      "Webhook replay protection (payment_events unique index)",
      indexNames.has("payment_events_provider_event_unique"),
      indexNames.has("payment_events_provider_event_unique")
        ? "a duplicate provider event cannot be recorded twice"
        : "MISSING — a retried webhook WILL be processed twice and charge a customer twice",
    );

    record(
      "One live subscription per tenant",
      indexNames.has("subscriptions_one_live_per_tenant"),
      indexNames.has("subscriptions_one_live_per_tenant")
        ? "a tenant cannot hold two live subscriptions"
        : "MISSING — a tenant can hold two live subscriptions and be billed twice",
    );

    /* ---- 5d. ⭐ THE DOUBLE-SALE INDEX (Phase 22) ------------------- */
    //
    // The single most consequential index in the product. Every other
    // integrity failure here is repairable with an UPDATE; two buyers
    // promised one flat is a refund, a broken relationship and a RERA
    // complaint.
    //
    // `drizzle-kit push` removes what it does not recognise, which is
    // exactly why this is checked after every push rather than trusted.
    record(
      "⭐ One live booking per unit",
      indexNames.has("bookings_one_live_per_unit"),
      indexNames.has("bookings_one_live_per_unit")
        ? "two reps cannot book the same flat"
        : "MISSING — TWO REPS BOOKING THE SAME FLAT WILL BOTH SUCCEED",
    );

    /* ---- 5e. CROSS-TENANT REFERENCE CONSTRAINTS (Phase 22) --------- */
    //
    // ⚠️ Foreign-key checks run as the system and IGNORE row-level
    // security. A single-column FK therefore lets a tenant point their
    // own row at ANOTHER tenant's parent record — the WITH CHECK passes
    // (the tenant is theirs) and the FK passes (the parent exists).
    //
    // These composite keys make that arithmetically impossible. They are
    // created by SQL-FILES, not by the schema, so a push drops nothing —
    // but a fresh database that skipped the SQL file would have none.
    const compositeFks = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1)`,
      [REQUIRED_COMPOSITE_FKS as unknown as string[]],
    );
    const fkNames = new Set(compositeFks.rows.map((r) => r.conname));
    const missingFks = REQUIRED_COMPOSITE_FKS.filter((name) => !fkNames.has(name));

    record(
      "Cross-tenant reference integrity",
      missingFks.length === 0,
      missingFks.length === 0
        ? `all ${REQUIRED_COMPOSITE_FKS.length} composite foreign keys present`
        : `MISSING: ${missingFks.join(", ")} — a row can point at another tenant's record`,
    );

    /* ---- 5f. NO UNIT IS CURRENTLY DOUBLE-SOLD ---------------------- */
    //
    // The index prevents it going forward. This proves the data is clean
    // today — which is what you need to know before trusting that the
    // index actually applied.
    const doubleSold = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT unit_id FROM bookings
          WHERE status <> 'cancelled' AND unit_id IS NOT NULL
          GROUP BY unit_id HAVING count(*) > 1
       ) d`,
    );
    const doubleSoldCount = Number(doubleSold.rows[0]?.n ?? 0);

    record(
      "No unit is promised to two buyers",
      doubleSoldCount === 0,
      doubleSoldCount === 0
        ? "no double bookings exist"
        : `${doubleSoldCount} UNIT(S) HAVE BEEN PROMISED TO MORE THAN ONE BUYER — deal with this first`,
    );

    /* ---- 5g. NO HOLD CAN OUTLIVE ITS DEADLINE ---------------------- */
    const orphanHolds = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM units
        WHERE status = 'held' AND (hold_until IS NULL OR held_for_lead_id IS NULL)`,
    );
    const orphanHoldCount = Number(orphanHolds.rows[0]?.n ?? 0);

    record(
      "Every held unit can release itself",
      orphanHoldCount === 0,
      orphanHoldCount === 0
        ? "no unit is held without a deadline and a buyer"
        : `${orphanHoldCount} unit(s) are held with no deadline — they will never return to the market`,
    );

    /* ---- 6c. BILLING PRIVILEGES (Phase 11) ------------------------- */
    //
    // Checked as privileges rather than as policies because that is how
    // they are enforced. A tenant repricing their own plan is the most
    // obvious attack on a billing system, and the cleanest defence is
    // that the privilege never existed.
    //
    // Skipped when the role is absent — on Neon the app usually connects
    // as the database owner and there is no separate `ordence_app`.
    const roleExists = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_roles WHERE rolname = 'ordence_app'`,
    );

    if (Number(roleExists.rows[0]?.n ?? 0) > 0) {
      const privileges = await pool.query<{
        plans_update: boolean;
        plans_select: boolean;
        events_update: boolean;
        events_delete: boolean;
        subs_delete: boolean;
      }>(
        `SELECT
           has_table_privilege('ordence_app','plans','UPDATE')           AS plans_update,
           has_table_privilege('ordence_app','plans','SELECT')           AS plans_select,
           has_table_privilege('ordence_app','payment_events','UPDATE')  AS events_update,
           has_table_privilege('ordence_app','payment_events','DELETE')  AS events_delete,
           has_table_privilege('ordence_app','subscriptions','DELETE')   AS subs_delete`,
      );

      const p = privileges.rows[0];
      const overreach: string[] = [];
      if (p?.plans_update) overreach.push("UPDATE on plans (can reprice itself)");
      if (p?.events_update) overreach.push("UPDATE on payment_events");
      if (p?.events_delete) overreach.push("DELETE on payment_events");
      if (p?.subs_delete) overreach.push("DELETE on subscriptions");

      record(
        "Billing privileges are restricted",
        overreach.length === 0 && Boolean(p?.plans_select),
        overreach.length === 0
          ? "the app can read the plan catalogue but not reprice it, and cannot alter payment evidence"
          : `THE APPLICATION ROLE HOLDS: ${overreach.join("; ")}`,
      );
    }

    /* ---- 7. THE APP ROLE SHOULD NOT BE A SUPERUSER ----------------- */
    // A superuser bypasses RLS entirely. If production connects as one,
    // every policy above is decorative.
    const role = await pool.query<{ rolname: string; super: boolean; bypass: boolean }>(
      `SELECT rolname, rolsuper AS super, rolbypassrls AS bypass
       FROM pg_roles WHERE rolname = current_user`,
    );

    const me = role.rows[0];
    record(
      "Connected role does not bypass RLS",
      !me?.super && !me?.bypass,
      me?.super || me?.bypass
        ? `'${me.rolname}' is superuser=${me.super} bypassrls=${me.bypass} — RLS DOES NOT APPLY to this role`
        : `'${me?.rolname}' is a normal role`,
      // Not fatal: this script is often run as an admin to INSPECT state.
      // What matters is that the APPLICATION does not connect as one, which
      // this cannot see from here.
      false,
    );

    /* ---- REPORT ---------------------------------------------------- */
    console.log("");
    console.log("═".repeat(72));
    console.log("  ORDENCE — DATABASE SECURITY VERIFICATION");
    console.log("═".repeat(72));
    console.log("");

    for (const c of checks) {
      const mark = c.ok ? "✅" : c.fatal ? "❌" : "⚠️ ";
      console.log(`${mark} ${c.name}`);
      console.log(`     ${c.detail}`);
    }

    const failures = checks.filter((c) => !c.ok && c.fatal);

    console.log("");
    console.log("═".repeat(72));

    if (failures.length === 0) {
      console.log("  ✅ ALL CHECKS PASSED — tenant isolation is in force.");
      console.log("═".repeat(72));
      console.log("");
      await pool.end();
      process.exit(0);
    }

    console.log(`  ❌ ${failures.length} CHECK(S) FAILED — DO NOT SERVE TRAFFIC.`);
    console.log("═".repeat(72));
    console.log("");
    console.log("  The most common cause is running `drizzle-kit push` (npm run");
    console.log("  db:push) without re-applying the security SQL afterwards.");
    console.log("  `push` treats our policies as drift and drops them.");
    console.log("");
    console.log("  TO FIX: run SQL-FILES/ALL-IN-ONE-SETUP.sql against this");
    console.log("  database, then run this verification again.");
    console.log("");

    await pool.end();
    process.exit(1);
  } catch (err) {
    console.error("Verification could not complete:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

void main();
