/**
 * Ordence — Granular Authorization Catalog
 * Version: v0.5.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A NOTE ON WHY THIS FILE DOES NOT DEFINE `user_roles` OR `role_permissions`
 * ══════════════════════════════════════════════════════════════════════════
 * Both tables — along with `roles` and `permissions` — were created in Phase 1
 * (`db/schema/core.ts`). Defining them again here would:
 *
 *   1. Break the build. `db/schema/index.ts` re-exports both modules; two
 *      exports named `userRoles` is a compile error.
 *   2. Split authorization across two sets of tables, so "what can this user
 *      do?" would have two possible answers.
 *
 * So this module EXTENDS the Phase 1 RBAC rather than duplicating it. It adds:
 *   - `PERMISSION_CATALOG` — the canonical list of every permission in the system
 *   - `ROLE_TEMPLATES`     — ready-made role definitions per the Phase 5 spec
 *   - `permission_audit`   — a record of denied attempts, for security review
 *
 * The tables themselves stay where they are, with the RLS policies already
 * protecting them.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import type { SystemRole } from "./core";

/* ------------------------------------------------------------------ */
/* PERMISSION CATALOG                                                  */
/* ------------------------------------------------------------------ */

/**
 * Every permission the platform recognises, in `resource:action` form.
 *
 * WHY A FROZEN CONSTANT AND NOT A DATABASE READ:
 * `checkPermission()` runs on essentially every server action. A database
 * round-trip per check would add latency to every request and make the Edge
 * runtime unusable. The catalog is code — versioned, type-checked, free to read.
 * Tenant-specific GRANTS live in the database; the vocabulary does not.
 */
export const PERMISSION_CATALOG = {
  /* ══════════════════════════════════════════════════════════════════
   * ⭐ THE DOTTED KEYS — AND WHY THEY WERE MISSING FOR MONTHS
   * ══════════════════════════════════════════════════════════════════
   * Everything below this block uses `resource:action`. The engines and
   * the later modules use `module.resource.action` instead. Two
   * vocabularies in one catalogue is not elegant, and consolidating them
   * would be a rename across every call site — worth doing, but not
   * worth doing silently in the middle of other work.
   *
   * ⚠️ WHAT MATTERS FAR MORE IS THAT THESE WERE ABSENT ALTOGETHER.
   *
   * `evaluatePermission()` fails closed on a key it does not recognise —
   * `reason: "unknown_permission"`, allowed: false — which is the right
   * behaviour and the reason this went unnoticed. A missing permission
   * does not throw at build time, does not warn, and does not show up in
   * any test. It simply denies, for every role including the workspace
   * owner, and the screen renders its "unavailable" branch.
   *
   * So `/land`, `/inventory` and `/orders` — all three shipped, all three
   * listed as live in the module registry — have been denying every user
   * since they were written. Their server actions ask for
   * `land.parcels.read`, `inventory.stock.read` and `sales.orders.read`,
   * and none of those existed here.
   *
   * ⚠️ THE LESSON WORTH KEEPING: a permission system that fails closed on
   * unknown keys needs the catalogue to be the SINGLE place keys are
   * defined, with the call sites typed against it. A free-form string
   * argument means a typo and a genuinely new permission are
   * indistinguishable — and both present as "you do not have access",
   * which reads like a configuration problem rather than a bug.
   */

  // ── Land & title (Phase 42) ──────────────────────────────────────
  "land.parcels.read": "View land parcels and title chains",
  "land.parcels.manage": "Create and edit land parcels",

  // ── Inventory (Phase 40) ─────────────────────────────────────────
  "inventory.stock.read": "View stock balances and movements",
  "inventory.items.manage": "Create and edit stock items",
  "inventory.movements.post": "Post stock receipts, issues and transfers",
  "inventory.reservations.manage": "Reserve and release stock",
  "inventory.warehouses.manage": "Create and edit warehouses",

  // ── Orders (Phase 39) ────────────────────────────────────────────
  "sales.orders.read": "View orders",
  "sales.orders.create": "Create orders",
  "sales.orders.update": "Edit orders",
  "sales.orders.confirm": "Confirm orders",
  "sales.orders.amend": "Amend a confirmed order",
  "sales.orders.cancel": "Cancel orders",
  "sales.orders.dispatch": "Dispatch orders",

  // ── ⭐ CREDIT CONTROL (Phase 48) ─────────────────────────────────
  //
  // ⚠️ THREE KEYS, AND THE THIRD IS THE ONE THAT MATTERS.
  //
  // `sales.credit.read`   — see a customer's limit, hold and exposure.
  // `sales.credit.manage` — set the limit, place and lift the hold.
  // `sales.orders.approve_credit` — confirm an order the credit check
  //                         routed to a human.
  //
  // ⭐ APPROVE IS SEPARATE FROM CONFIRM, AND SEPARATE FROM MANAGE, ON
  //    PURPOSE, BECAUSE OTHERWISE THE CONTROL IS DECORATION.
  //
  // Folded into `sales.orders.confirm`, the person blocked by the limit
  // approves their own override — which is what this codebase was
  // already doing at `server/actions/orders.ts:389` before Phase 48, and
  // the audit trail recorded it as a genuine approval.
  //
  // Folded into `sales.credit.manage`, the salesperson raises the
  // customer's limit instead of asking anyone, and the ceiling becomes a
  // number that describes the last order rather than constraining the
  // next one.
  //
  // ⚠️ AND NOTE WHICH ROLES GET WHAT, BELOW: the accountant SETS limits
  //    and does NOT approve overrides; the owner and administrator
  //    approve overrides. Setting the rule and waiving it are two jobs.
  "sales.credit.read": "View customer credit limits and exposure",
  "sales.credit.manage": "Set credit limits, place and lift credit holds",
  "sales.orders.approve_credit": "Approve an order that exceeds a customer's credit limit",

  // ── ⭐ ENGINE 1 · Scheduling & capacity ──────────────────────────
  "scheduling.bookings.read": "View the schedule",
  "scheduling.bookings.manage": "Create, amend and cancel bookings",
  "scheduling.resources.manage": "Create resources and take them out of service",

  // ── ⭐ ENGINE 2 · Rate & pricing ─────────────────────────────────
  "rates.cards.read": "View rate cards and quotes",
  "rates.cards.manage": "Create and edit rate cards, slabs and adjustments",

  // ── ⭐ ENGINE 3 · Field & mobile operations ──────────────────────
  "field.jobs.read": "View field jobs, visits and proof of service",
  "field.jobs.manage": "Dispatch jobs and record visits",

  // ── ⭐ ENGINE 4 · Compliance ─────────────────────────────────────
  "compliance.calendar.read": "View statutory deadlines",
  "compliance.calendar.manage": "Create obligations and complete filings",
  "compliance.licences.read": "View licences and renewal windows",
  "compliance.licences.manage": "Create, renew and retire licences",

  // ── ⭐ ENGINE 5 · Utility metering ───────────────────────────────
  "metering.readings.read": "View meters and readings",
  "metering.readings.manage": "Record readings and close billing periods",

  /* ══════════════════════════════════════════════════════════════════
   * ⭐ TWO READ KEYS ADDED FOR SCREENS THAT SPAN MODULES
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ BOTH ARE NEW BECAUSE NEITHER SCREEN FITS UNDER AN EXISTING KEY,
   * AND A SCREEN GATED ON A KEY THAT IS NOT IN THIS OBJECT DENIES EVERY
   * USER INCLUDING THE WORKSPACE OWNER — silently, with no build error
   * and no test failure. See the note at the top of this catalogue.
   *
   * `construction.costs.read` — /reports/cost assembles the contract
   *   value (`boqs`), what has been measured against it
   *   (`v_boq_consumption`), what has been certified for payment
   *   (`ra_bills`) and what has been committed to vendors
   *   (`purchase_invoices`) into one figure per project.
   *
   *   ⚠️ IT IS DELIBERATELY NOT `projects:read`. That key is held by
   *   every sales rep so they can see which project a lead is against.
   *   Contractor bill values, retention held and vendor commitment are
   *   not a thing a sales floor should read, and folding them behind a
   *   key already granted to `member` would publish them to it.
   *
   *   ⚠️ NOR IS IT `purchases:read`, which would be the reverse mistake:
   *   the page is 80% construction measurement and only touches the
   *   purchase ledger for its committed-cost total.
   *
   * `labour.timesheets.read` — /timesheets reads recorded time from the
   *   two places this product actually records it: `site_attendance`
   *   punches and `field_visits.on_site_minutes`.
   *
   *   ⚠️ ONE KEY SPANNING TWO MODULES, ON PURPOSE. Time against work is
   *   one question, and answering it from two sources under two keys
   *   would mean a person holding one of them sees half the hours and
   *   has no way to know the other half exists — which is worse than
   *   being refused, because a partial timesheet looks complete.
   *
   *   ⚠️ HOLDING IT DOES NOT GRANT `field.jobs.read`. This is time, not
   *   the job record, the customer address or the proof of service.
   */
  "construction.costs.read":
    "View cost against contract: BOQ consumption, RA bills and committed spend",
  "labour.timesheets.read":
    "View recorded time — site attendance, duty rosters and on-site minutes",

  /* ── ⭐ CONTRACTING — v0.69.0 ────────────────────────────────────
   *
   * ══════════════════════════════════════════════════════════════════
   * ⚠️ SIX KEYS, AND THE SEPARATIONS BETWEEN THEM ARE THE CONTROL.
   * ══════════════════════════════════════════════════════════════════
   * This is the one part of the product where a single person holding
   * every permission can pay a subcontractor for work nobody did. The
   * split below is the standard site separation of duties, written down:
   *
   *   MEASURE   the site engineer records what was built
   *   CHECK     somebody else agrees the measurement is right
   *   RAISE     a bill is assembled from checked measurements
   *   CERTIFY   the engineer certifies the value for payment
   *   APPROVE   a director releases it
   *
   * ⚠️ `measure` AND `check` ARE DELIBERATELY DIFFERENT KEYS. An
   * engineer who can both record and check their own measurement is the
   * entire control, defeated — and it is defeated silently, because a
   * self-checked measurement looks identical to a checked one.
   *
   * ⚠️ SO ARE `certify` AND `approve`. Certification is a professional
   * opinion about the work; approval is a decision to part with money.
   * Merging them means one person's signature does both jobs, which is
   * exactly the arrangement every construction fraud case turns on.
   *
   * ⚠️ NONE OF THESE GRANTS `construction.costs.read`. Being able to
   * raise a bill against one contract is not the same as seeing what
   * every contract on every project has cost.
   */
  "construction.boq.read": "View bills of quantities and their priced items",
  "construction.boq.manage":
    "Create and price bills of quantities, and issue them",
  "construction.measurement.record":
    "Record measurements against BOQ items in a measurement book",
  "construction.measurement.check":
    "⚠️ Check or reject somebody else's measurement — never held by the same person who records",
  "contracting.rabill.read": "View running-account bills and their lines",
  "contracting.rabill.raise":
    "Assemble a running-account bill from checked, unbilled measurements",
  "contracting.rabill.certify":
    "⚠️ Certify a bill's value for payment — an engineer's professional opinion",
  "contracting.rabill.approve":
    "⚠️ Approve a certified bill for payment — the instruction to pay",

  // ── CRM ──────────────────────────────────────────────────────────
  "contacts:read": "View contacts",
  "contacts:create": "Create contacts",
  "contacts:update": "Edit contacts",
  "contacts:delete": "Delete contacts",
  "contacts:export": "Export contact data",

  "companies:read": "View companies",
  "companies:create": "Create companies",
  "companies:update": "Edit companies",
  "companies:delete": "Delete companies",

  "deals:read": "View deals",
  "deals:create": "Create deals",
  "deals:update": "Edit deals",
  "deals:delete": "Delete deals",

  // ── Sales pipeline & inventory (Phase 22) ────────────────────────
  //
  // ⚠️ NOTE THE SEPARATIONS, because each one is a real segregation of
  // duties rather than a finer-grained menu:
  //
  //   `units:hold` vs `bookings:create` — a junior rep may take a flat
  //     off the market for a day; committing the company to a sale is a
  //     different act.
  //   `units:block` — withdrawing inventory from sale is a management
  //     decision, and a block does not expire on its own.
  //   `bookings:cancel` — frees a unit AND moves money. Dangerous.
  //   `partners:override_lock` — clearing a commission-protection window
  //     reassigns a commission somebody has already earned. This is the
  //     permission that settles a broker dispute, so it must be held by
  //     very few people and every use is audited.
  "leads:read": "View leads and the pipeline",
  "leads:create": "Create leads",
  "leads:update": "Edit leads and move them through the pipeline",
  "leads:assign": "Reassign a lead to another owner",
  "leads:delete": "Delete leads",
  "leads:export": "Export lead data",

  "projects:read": "View projects",
  "projects:manage": "Create and edit projects",

  "units:read": "View inventory and availability",
  "units:create": "Add units to a project",
  "units:update": "Edit unit details and pricing",
  "units:hold": "Hold a unit for a prospective buyer",
  "units:block": "Withdraw a unit from sale",

  "bookings:read": "View bookings",
  "bookings:create": "Book a unit for a buyer",
  "bookings:update": "Advance a booking through its stages",
  "bookings:cancel": "Cancel a booking, forfeit and refund",

  "payment_plans:read": "View payment plans and demands",
  "payment_plans:manage": "Generate and adjust payment plans",

  "partners:read": "View channel partners",
  "partners:manage": "Register and edit channel partners",
  "partners:override_lock": "Clear a commission-protection window",

  // ── Workflows & automation (Phase 23) ────────────────────────────
  //
  // ⚠️ THE SEPARATIONS HERE ARE ABOUT AUTHORITY, NOT ABOUT MENUS.
  //
  // A workflow is a program that runs as a person. So the permissions
  // divide along "who may write one", "who may make one live", and "what
  // may one do once it is live" — three different risks:
  //
  //   `workflows:update`  — writing a definition. Harmless on its own:
  //     a draft never runs.
  //   `workflows:publish` — ⭐ the one that matters. Publishing makes a
  //     definition live AND, for scheduled and webhook triggers, lends it
  //     the publisher's own identity for every future unattended run.
  //     That is a delegation of authority, which is why it is separate
  //     from editing and why it is on the dangerous list.
  //   `workflows:run`     — pressing the button on a manual workflow. The
  //     run then acts as the PRESSER, so this grants nothing the person
  //     did not already have.
  //   `workflows:send_email` / `workflows:http_request` — an automation
  //     that reaches outside the workspace. Editing a lead does not imply
  //     permission to write to that lead's buyer, or to post the record
  //     to a third-party endpoint.
  //   `workflows:cancel_run` — stopping something that is misbehaving.
  //     Deliberately wider than publishing: the person who has to stop a
  //     runaway at 6pm is rarely the person who published it.
  "workflows:read": "View automations",
  "workflows:create": "Create automations",
  "workflows:update": "Edit automation drafts",
  "workflows:publish": "Publish an automation and make it live",
  "workflows:archive": "Archive an automation",
  "workflows:run": "Run an automation manually",
  "workflows:runs_read": "View automation run history",
  "workflows:cancel_run": "Cancel a running automation",
  "workflows:approve": "Approve or reject an automation's request",
  "workflows:request_approval": "Let an automation ask a person to approve something",
  "workflows:send_email": "Let an automation send email",
  "workflows:http_request": "Let an automation call an external service",

  // ── Assets ───────────────────────────────────────────────────────
  "assets:read": "View assets and inventory",
  "assets:create": "Create assets",
  "assets:update": "Edit assets",
  "assets:delete": "Delete assets",
  "assets:bulk_update": "Bulk-edit assets",

  // ── Custom objects ───────────────────────────────────────────────
  "custom_objects:read": "View custom objects",
  "custom_objects:define": "Define new custom objects",
  "custom_objects:create_record": "Create custom object records",
  "custom_objects:update_record": "Edit custom object records",
  // ── Phase 24: runtime custom objects ─────────────────────────────
  //
  // ⚠️ THE SPLIT IS BETWEEN LOSING A ROW AND LOSING A TABLE.
  //
  // `custom_objects:define` already covers creating a record type and
  // adding a field — additive schema changes, all of which are undoable
  // by removing what was added. These two are not:
  //
  //   `delete_record` — one record. Soft-deleted, so recoverable, but it
  //     disappears from every view and every count, and the person who
  //     may create a record is not automatically the person who may make
  //     one go away.
  //   `drop_object` — ⭐ the whole TABLE and every record in it, with a
  //     real `DROP TABLE` and no undo. It is on the dangerous list below
  //     and it also requires the caller to state the live record count
  //     they are destroying — see `dropDynamicObjectSchema`.
  "custom_objects:delete_record": "Delete custom object records",
  "custom_objects:drop_object": "Permanently delete a record type and all its records",

  // ── Saved views (Phase 25) ───────────────────────────────────────
  //
  // ⚠️ SEVEN KEYS FOR WHAT LOOKS LIKE ONE FEATURE, AND EACH SPLIT IS A
  // DIFFERENT RISK RATHER THAN A FINER MENU:
  //
  //   `views:read` — may you use saved views at all. NOT permission to
  //     see the records in one: that is the OBJECT's own permission
  //     (`leads:read`, `bookings:read`, …), checked separately against
  //     the person opening the view, every time. Collapsing the two is
  //     exactly how a shared view becomes a privilege escalation.
  //   `views:share` — ⭐ publishing a view to everybody's picker. A small
  //     act of workspace administration: it becomes the thing a team
  //     looks at every morning, and it is what a workspace default is
  //     chosen from.
  //   `views:manage_shared` — editing or deleting somebody ELSE's shared
  //     view. Deliberately separate from `views:delete`, because the
  //     newest hire holding "delete your own views" must not be able to
  //     remove the board the whole sales floor works from.
  //   `views:read_all_records` — ⭐ THE SCOPE PERMISSION, and the only
  //     one here that changes which ROWS come back. Without it, every
  //     view over an object that has an owner is narrowed to the records
  //     the caller owns — through their own views as much as through
  //     shared ones, so there is no view anybody can build to get round
  //     it. Granted to the standard roles and revocable per user, which
  //     is how "this rep sees only their own pipeline" is expressed.
  "views:read": "View saved views",
  "views:create": "Create saved views",
  "views:update": "Edit saved views",
  "views:delete": "Delete saved views",
  "views:share": "Share a saved view with the whole workspace",
  "views:manage_shared": "Edit or delete a view somebody else shared",
  "views:read_all_records": "See records owned by other people in a view",

  // ── Legal / CLM ──────────────────────────────────────────────────
  "contracts:read": "View contracts",
  "contracts:create": "Draft contracts",
  "contracts:update": "Edit contracts",
  "contracts:delete": "Delete contracts",
  "contracts:approve": "Approve contracts for signature",
  "contracts:sign": "Execute and sign contracts",
  "contracts:legal_hold": "Place or lift a legal hold",
  "clauses:read": "View the clause library",
  "clauses:manage": "Add and approve clauses",

  // ── Accounting ───────────────────────────────────────────────────
  "ledgers:read": "View ledgers and balances",
  "ledgers:create": "Create ledgers",
  "ledgers:update": "Edit ledger settings",
  "transactions:read": "View transactions",
  "transactions:post": "Post journal entries",
  "transactions:reverse": "Reverse a posted transaction",
  "periods:read": "View accounting periods",
  "periods:close": "Close an accounting period",
  "periods:reopen": "Reopen a closed period",
  "reports:trial_balance": "Run the trial balance",
  "reports:export": "Export financial reports",

  // ── GST (Phase 32) ───────────────────────────────────────────────
  //
  // ⚠️ FOUR KEYS, AND THE SPLIT IS BY BLAST RADIUS RATHER THAN BY SCREEN.
  //
  //   `gst:read` — see the registrations, the counterparty GSTINs and the
  //     rate masters. Wide, because almost everybody downstream needs to
  //     know what rate a document carried and why.
  //   `gst:manage_registrations` — ⭐ which GSTIN we ISSUE FROM. Changing
  //     the primary registration changes the state every future invoice
  //     is taxed in, for the whole workspace, silently. On the dangerous
  //     list.
  //   `gst:manage_parties` — a buyer's or vendor's tax identity. Getting
  //     this wrong denies somebody an input credit; it does not restate
  //     history, so it is the mildest of the three writes.
  //   `gst:manage_rates` — ⭐ THE RATE MASTER. A rate is what every
  //     future invoice for that classification will be charged at, and a
  //     mistyped one is not visible on any screen until a return is
  //     filed against it. Held by whoever signs the returns, which in a
  //     developer is one or two people. On the dangerous list.
  //
  // ⚠️ NOTE WHAT NO KEY GRANTS: the ability to change the rate a
  // HISTORICAL invoice carries. That is not a permission, it is an
  // impossibility — the database refuses it (SQL 0021 §5) whoever asks.
  "gst:read": "View GST registrations, counterparties and rate masters",
  "gst:manage_registrations": "Add and retire our own GST registrations",
  "gst:manage_parties": "Record customer and vendor GSTINs",
  "gst:manage_rates": "Add and supersede HSN/SAC rate periods",

  // ── Purchases & input tax credit (Phase 33) ──────────────────────
  //
  // ⚠️ FIVE KEYS, SPLIT BY BLAST RADIUS RATHER THAN BY SCREEN, AND THE
  // SPLIT PUTS A SEAM WHERE THE MONEY IS.
  //
  //   `purchases:read` — see vendors, bills, the ITC register and the
  //     ageing. Wide, because everybody downstream needs to know what a
  //     bill cost and whether the credit on it was taken.
  //   `purchases:manage_vendors` — add a vendor, set their MSME status
  //     and their bank details. Mild in tax terms and material in fraud
  //     terms, which is why it is not the same key as recording a bill.
  //   `purchases:record_invoice` — enter a vendor bill, including its
  //     ⭐ Section 17(5) determination. This is where a developer's
  //     largest tax exposure is created.
  //   `purchases:claim_itc` — ⭐ PUT A CREDIT INTO A RETURN. On the
  //     dangerous list: an ineligible credit claimed here is money in the
  //     bank today and interest at 18% from today when it is found, and
  //     nothing on any screen looks wrong in between.
  //   `purchases:reverse_itc` — ⭐ TAKE ONE BACK, including running the
  //     Rule 42/43 apportionment. Also on the dangerous list, and for the
  //     mirror-image reason: an under-reversal understates the liability,
  //     and an over-reversal quietly gives away credit the workspace was
  //     entitled to. Both are silent.
  //
  // ⚠️ NOTE WHAT NO KEY GRANTS: claiming a credit against a line the
  // determination found BLOCKED. That is not a permission, it is an
  // impossibility — the database refuses it (SQL 0023 §5) whoever asks.
  "purchases:read": "View vendors, purchase invoices and the ITC register",
  "purchases:manage_vendors": "Add and edit vendors, MSME status and payment terms",
  "purchases:record_invoice": "Record a vendor bill and its ITC determination",
  "purchases:claim_itc": "Claim input tax credit into a tax period",
  "purchases:reverse_itc": "Reverse credit under Rule 42, Rule 43 or Rule 37",

  // ── ⭐ GSTR-2B reconciliation (Phase 34) ─────────────────────────
  //
  // FOUR KEYS, AND THE SEAM IS BETWEEN "LOOKING" AND "DECIDING".
  //
  //   `gstr2b:read` — see the imported statements, the worklist, the
  //     vendor chase and the summary. Wide, because "has this supplier
  //     filed?" is a purchasing question as much as an accounting one,
  //     and the person about to release next month's running account
  //     bill needs the answer.
  //   `gstr2b:import` — upload a statement. Narrow, and it is NOT the
  //     same key as reconciling: an import is what the article clerk
  //     does, and it writes the evidence every later decision rests on.
  //   `gstr2b:reconcile` — ⭐ run the engine and ACCEPT, REJECT or DEFER
  //     a proposed match. On the dangerous list: accepting a match is
  //     asserting that our invoice and the supplier's declaration are
  //     one document, which is the assertion an officer tests, and
  //     rejecting one leaves credit unclaimed against the Section 16(4)
  //     clock.
  //   `gstr2b:file` — ⭐⭐ FREEZE THE PERIOD. Also on the dangerous
  //     list, and it is the only one-way door in the phase: a filed
  //     reconciliation cannot be re-imported, restated or unfiled, and a
  //     period frozen early locks in a chase list nobody finished.
  //
  // ⚠️ NOTE WHAT NO KEY GRANTS: accepting a match below EXACT with
  // nobody named against it. That is not a permission, it is an
  // impossibility — the database refuses it (SQL 0024 §1) whoever asks.
  "gstr2b:read": "View imported GSTR-2B statements, mismatches and the vendor chase",
  "gstr2b:import": "Import a GSTR-2B statement from the portal",
  "gstr2b:reconcile": "Run the match engine and accept, reject or defer a match",
  "gstr2b:file": "Mark a period filed, freezing its reconciliation permanently",

  // ── ⭐ Tax Deducted at Source (Phase 36) ─────────────────────────
  //
  // FIVE KEYS, AND THE SEAM IS BETWEEN MONEY THAT IS OURS AND MONEY
  // THAT IS SOMEBODY ELSE'S.
  //
  //   `tds:read` — see deductees, the deduction register, challans,
  //     certificates and the returns. Wide, because "what was withheld
  //     from this contractor" is a purchasing question as much as an
  //     accounting one, and the person about to release a running-account
  //     bill needs the answer.
  //   `tds:manage_deductees` — add a deductee, record their PAN and their
  //     constitution. ⚠️ It looks like master data and it is not: the
  //     PAN decides 20% or 1% under Section 206AA, and the constitution
  //     decides 1% or 2% under Section 194C. Two fields, twentyfold.
  //   `tds:deduct` — ⭐ RECORD A DEDUCTION. On the dangerous list: this
  //     is where an under-deduction is created, and Section 201(1) makes
  //     the shortfall OURS whether or not the deductee paid their own
  //     tax on it. Nothing on any screen looks wrong in between.
  //   `tds:manage_challans` — record a deposit and map deductions to it.
  //     ⭐ Also on the dangerous list: mapping more tax to a challan than
  //     was deposited produces a return the Department ACCEPTS while some
  //     deductees silently get no credit, chosen by nothing anybody
  //     controls.
  //   `tds:file_return` — ⭐⭐ file the quarterly statement and issue the
  //     certificates. The one that reaches outside the company: until it
  //     is filed, every deductee's money sits under our TAN against
  //     nobody, and once it is filed a wrong figure is in a document the
  //     Government holds a copy of and the vendor attaches to their own
  //     return.
  //
  // ⚠️ NOTE WHAT NO KEY GRANTS: deducting below the Section 206AA rate
  // from a deductee with no PAN, or applying a Section 197 certificate
  // outside its window. Those are not permissions, they are
  // impossibilities — the database refuses them (SQL 0025 §5) whoever
  // asks.
  "tds:read": "View deductees, the TDS register, challans, certificates and returns",
  "tds:manage_deductees": "Add and edit deductees, their PAN and their constitution",
  "tds:deduct": "Record a tax deduction against a payment",
  "tds:manage_challans": "Record a TDS deposit and map deductions to it",
  "tds:file_return": "File a quarterly TDS statement and issue Form 16A/27D",

  // ── Administration ───────────────────────────────────────────────
  "users:read": "View team members",
  "users:invite": "Invite team members",
  "users:update": "Edit team members",
  "users:remove": "Remove team members",
  "roles:read": "View roles",
  "roles:manage": "Create and edit roles",
  "settings:read": "View workspace settings",
  "settings:update": "Change workspace settings",
  "billing:read": "View billing",
  "billing:manage": "Change plan and payment details",
  "audit:read": "View the audit log",
  "integrations:manage": "Manage integrations and API keys",

  // ── ⭐ Tally integration (Phase 37) ──────────────────────────────
  //
  // FIVE KEYS, AND THE SEAM IS BETWEEN "DESCRIBING OUR BOOKS" AND
  // "WRITING INTO SOMEBODY ELSE'S".
  //
  //   `tally:read` — see the mappings, the export batches, the
  //     reconciliation. Wide: "has April been sent yet?" is a question
  //     the accounts assistant, the project accountant and the CFO all
  //     ask, and the wrong answer to it is what doubles a company's
  //     turnover.
  //   `tally:manage_mappings` — ⭐ our chart of accounts ↔ their ledger
  //     names, and our projects ↔ their cost centres. It LOOKS like
  //     master data and it is not: a mapping pointed at the wrong Tally
  //     ledger does not fail, it posts a month of revenue to a ledger
  //     Tally invents, under a group it guesses.
  //   `tally:export` — ⭐⭐ ON THE DANGEROUS LIST. This is the one that
  //     produces a file somebody imports into the statutory books. A
  //     re-export whose keys have moved does not fail, does not warn and
  //     does not show up in any report — it doubles the period, and it
  //     is found by an auditor months later.
  //   `tally:push` — ⭐ POST it straight into a running Tally over the
  //     network. Also dangerous, and for a second reason: it is the only
  //     capability in this product that reaches an address a customer
  //     configured, so it is the one an SSRF attempt would go through.
  //     See `lib/tally/endpoint.ts`.
  //   `tally:import` — read their export back and reconcile. ⚠️ It
  //     WRITES NOTHING to our ledger, ever, so it is not on the
  //     dangerous list — but it does ingest a customer-supplied file,
  //     which is why the parser in `lib/tally/parse.ts` is hand-written
  //     and never expands an entity.
  //
  // ⚠️ NOTE WHAT NO KEY GRANTS: giving an already-exported transaction a
  // second Tally key, or exporting an unbalanced voucher. Those are not
  // permissions, they are impossibilities — the database refuses them
  // (SQL 0026 §6 and §1) whoever asks.
  "tally:read": "View Tally mappings, export batches and the reconciliation",
  "tally:manage_mappings": "Map our accounts and projects to Tally ledgers and cost centres",
  "tally:export": "Generate a Tally import file for a period",
  "tally:push": "Send an export directly to a running Tally instance",
  "tally:import": "Import a Tally export and reconcile it against our books",

  // ── ⭐ Receivables & demand notices (Phase 38) ───────────────────
  //
  // EIGHT KEYS, AND THE SEAMS ARE BETWEEN "ASKING FOR MONEY", "RECEIVING
  // IT" AND "THREATENING SOMEBODY'S HOME".
  //
  //   `receivables:read` — the ageing, the demands, the receipts, the
  //     statement. Wide: "has the third slab money come in?" is asked by
  //     the site, by sales and by the CFO in the same week.
  //   `receivables:manage_policy` — ⭐ ON THE DANGEROUS LIST. It sets the
  //     interest rate, the compounding rule and the dunning intervals for
  //     every future demand on a project. A rate typed wrong here is not
  //     visible on any screen until a buyer recomputes their own notice,
  //     and under Section 2(za) of RERA the rate charged to an allottee is
  //     the same rate the promoter must PAY on every delayed flat.
  //   `receivables:raise_demand` — draft one against a milestone whose
  //     trigger has been achieved. Not dangerous: a draft is not served.
  //   `receivables:issue_demand` — ⭐ SERVE IT, and cancel or supersede
  //     one. This is the act that creates a legal document under RERA and
  //     starts the interest clock. On the dangerous list because a demand
  //     that goes out wrong cannot be recalled — it can only be
  //     superseded, and the buyer keeps both.
  //   `receivables:record_receipt` — money in. The ordinary daily write.
  //   `receivables:allocate` — ⭐ ON THE DANGEROUS LIST, and it is the one
  //     that surprises people. It does not touch how much money exists; it
  //     moves a buyer's ALREADY-RECEIVED payment between demands. Under
  //     Section 59 of the Contract Act a buyer's own direction binds us,
  //     so re-appropriating against it is overriding a right — and the
  //     buyer's statement of account changes underneath a figure they were
  //     already given.
  //   `receivables:dun` — send a reminder, a first notice or a final
  //     notice. Not dangerous: each is a letter about a document the buyer
  //     already holds, and the ladder cannot skip a rung whoever asks.
  //   `receivables:warn_cancellation` — ⭐⭐ THE STRONGEST SINGLE KEY IN
  //     THIS PHASE. It authorises the letter that precedes terminating an
  //     allotment and forfeiting what a family has paid towards a home.
  //     Deliberately NOT held by the accountant who does everything else
  //     here, and deliberately outside the automatic sweep.
  //
  // ⚠️ NOTE WHAT NO KEY GRANTS: skipping a rung of the dunning ladder,
  // sending a cancellation warning with nobody named behind it, editing an
  // issued demand's figures, or applying a receipt whose parts do not sum.
  // Those are not permissions, they are impossibilities — the database
  // refuses them (SQL 0027 §5, §6 and §7) whoever asks.
  "receivables:read":
    "View demands, receipts, the ageing report and statements of account",
  "receivables:manage_policy":
    "Set interest terms, GST rate and the dunning ladder for a project",
  "receivables:raise_demand": "Draft a demand against an achieved milestone",
  "receivables:issue_demand": "Issue, cancel or supersede a demand notice",
  "receivables:record_receipt": "Record money received against a booking",
  "receivables:allocate": "Re-apply a receipt across demands, or release a bounce",
  "receivables:dun": "Send a reminder, first notice or final notice",
  "receivables:warn_cancellation":
    "Authorise a cancellation warning before termination of an allotment",
} as const;

export type PermissionKey = keyof typeof PERMISSION_CATALOG;

export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOG) as PermissionKey[];

/** Permissions whose misuse is materially damaging. Always audited on denial. */
export const DANGEROUS_PERMISSIONS: readonly PermissionKey[] = [
  "contacts:delete",
  "companies:delete",
  "deals:delete",
  "assets:delete",
  "contracts:delete",
  "contracts:sign",
  "contracts:legal_hold",
  "transactions:post",
  "transactions:reverse",
  "periods:close",
  "periods:reopen",
  "users:remove",
  "roles:manage",
  "billing:manage",
  "integrations:manage",
  "contacts:export",
  "reports:export",

  // Phase 22. Each of these either destroys inventory state or moves
  // money that somebody else has earned.
  "leads:delete",
  "leads:export",
  "units:block",
  "bookings:cancel",
  "partners:override_lock",

  // Phase 23. Publishing lends an automation the publisher's identity for
  // every unattended run it ever makes; the other two let it act outside
  // the workspace, where nothing can be taken back.
  "workflows:publish",
  "workflows:archive",
  "workflows:http_request",
  "workflows:send_email",

  // Phase 24. `DROP TABLE` on a runtime object destroys every record of
  // that type irreversibly — the most destructive single action in the
  // product, and the only one whose blast radius is a whole table.
  "custom_objects:drop_object",

  // Phase 25. Neither destroys data, and both are on this list because
  // their blast radius is other people:
  //
  //   `views:manage_shared` — one click removes the board a whole team
  //     works from, with no undo, because a view is a preference rather
  //     than history and is therefore hard-deleted.
  //   `views:read_all_records` — granting it back to somebody who was
  //     narrowed to their own records widens what they can see across
  //     every object in the product at once. That is a decision worth a
  //     line in the audit trail.
  "views:manage_shared",
  "views:read_all_records",

  // Phase 32. Neither destroys a row, and both are here because their
  // blast radius is EVERY FUTURE DOCUMENT and neither shows on a screen:
  //
  //   `gst:manage_rates` — a mistyped rate is charged on every invoice
  //     for that classification until somebody files a return against it
  //     and the figures do not reconcile. Weeks, typically.
  //   `gst:manage_registrations` — changing which GSTIN is primary
  //     changes the state every future supply is taxed in. The totals
  //     stay right to the paisa; the tax lands in a state we did not
  //     supply, and getting it back is a Section 77 claim.
  "gst:manage_rates",
  "gst:manage_registrations",

  // Phase 33. Both move money, in opposite directions, and NEITHER shows
  // on a screen as wrong:
  //
  //   `purchases:claim_itc` — an ineligible credit claimed is cash in the
  //     bank this month and interest at 18% under Section 50 from this
  //     month when it is found at an audit years later. The GSTR-3B files
  //     cleanly, the ledger shows a balance, nothing errors. It is the
  //     most profitable-looking mistake in the product.
  //   `purchases:reverse_itc` — the mirror. An under-reversal understates
  //     the liability; an over-reversal quietly gives away credit the
  //     workspace was entitled to and nobody ever asks for it back.
  "purchases:claim_itc",
  "purchases:reverse_itc",

  // ⭐ Phase 34. Both are decisions about a return the Government will
  // hold a copy of, and neither shows on a screen as wrong:
  //
  //   `gstr2b:reconcile` — accepting a match asserts that our invoice
  //     and a supplier's declaration are ONE document. Accept the wrong
  //     pair and credit is claimed on an invoice the supplier never
  //     filed, which Section 16(2)(aa) does not allow and which nothing
  //     in our own records could show. Reject a right pair and credit we
  //     are entitled to sits unclaimed against the Section 16(4) cliff,
  //     after which it is gone permanently.
  //   `gstr2b:file` — ⭐ THE ONLY ONE-WAY DOOR IN THE PHASE. Filing
  //     freezes the period: it cannot be re-imported, restated or
  //     unfiled. Frozen early, it locks in a chase list nobody finished
  //     and a set of figures nobody agreed to.
  "gstr2b:reconcile",
  "gstr2b:file",

  // ⭐ Phase 36. All three move money that is NOT OURS, and every one of
  // them fails silently in a way that lands on a third party first:
  //
  //   `tds:deduct` — an under-deduction is invisible. Four ₹25,000
  //     payments to a labour contractor cross Section 194C's ₹1,00,000
  //     annual threshold, and deducting on each in isolation is four
  //     correct-looking vouchers and no error anywhere. Section 201(1)
  //     then makes the whole shortfall ours, with interest from the date
  //     of each payment and 30% of the expenditure disallowed under
  //     40(a)(ia). Over-deducting is the mirror and is not recoverable
  //     by the deductee from us at all — Section 205 — only on their own
  //     return a year later.
  //   `tds:manage_challans` — ⭐ mapping more tax to a challan than was
  //     deposited into it produces a statement the Department ACCEPTS.
  //     Credit reaches deductees until the challan runs out, and which
  //     ones get nothing is decided by the order the records were
  //     processed in. They find out in October.
  //   `tds:file_return` — the figures go into documents the Government
  //     holds and the vendor attaches to their own assessment. A wrong
  //     one is corrected by a correction statement, not by an edit.
  "tds:deduct",
  "tds:manage_challans",
  "tds:file_return",

  // ⭐ Phase 37. Both of these write into books this product does not
  // own, and neither failure mode is visible from inside the product:
  //
  //   `tally:export` — ⭐⭐ the double post. Re-exporting a period whose
  //     deterministic keys have moved makes Tally CREATE a second copy of
  //     every voucher instead of altering the first. Both copies balance,
  //     the trial balance balances, every register foots, and the
  //     company's turnover is simply twice what it was. It is found at
  //     the year end by an auditor comparing the books to the GSTR-1.
  //     SQL 0026 §6 makes the key immutable per source row; this key
  //     decides who may set that in motion at all.
  //   `tally:push` — the only capability in the product that makes our
  //     servers open a connection to an address a customer typed. That
  //     is server-side request forgery by definition, and it is
  //     constrained rather than forbidden because Tally is only ever at
  //     a private address. See `lib/tally/endpoint.ts`.
  "tally:export",
  "tally:push",

  // ⭐ Phase 38. Three, and the third is the strongest single key in the
  // product:
  //
  //   `receivables:manage_policy` — the interest rate, the compounding
  //     rule and the ladder intervals for every future demand on a
  //     project. Nothing on any screen looks wrong when it is set wrong;
  //     the first person to notice is a buyer recomputing their own
  //     notice, and under Section 2(za) of RERA the rate charged to an
  //     allottee is the same rate the promoter must PAY on every delayed
  //     flat in the project.
  //   `receivables:allocate` — ⚠️ it moves money that has ALREADY been
  //     received, and received money is the one thing a buyer thinks is
  //     settled. Under Section 59 of the Contract Act their own direction
  //     binds us, so re-appropriating against it overrides a right — and
  //     a statement of account they were already given changes underneath
  //     them.
  //   `receivables:warn_cancellation` — ⭐⭐ the letter that precedes
  //     terminating an allotment and forfeiting what a family has paid
  //     towards a home. There is no more consequential single act in this
  //     product, it is deliberately outside the automatic sweep, and the
  //     database refuses the row without a named human and a reason
  //     (SQL 0027 §1).
  "receivables:manage_policy",
  "receivables:allocate",
  "receivables:warn_cancellation",
];

/* ------------------------------------------------------------------ */
/* ROLE TEMPLATES                                                      */
/* ------------------------------------------------------------------ */

export type RoleTemplate = {
  key: SystemRole;
  label: string;
  description: string;
  /** `"*"` grants everything. Otherwise an explicit list. */
  permissions: readonly PermissionKey[] | "*";
};

/**
 * Default permission sets. Each maps to a `system_role` enum value from Phase 1.
 *
 * Deliberate boundaries worth noting:
 *   - Accountant can POST and REVERSE but cannot CLOSE a period. Closing is an
 *     attestation that the books are final; it belongs to an owner or admin.
 *     Separating "record the numbers" from "declare them final" is standard
 *     segregation of duties.
 *   - Legal Counsel can SIGN contracts but has no access to the ledger at all.
 *   - Contractor is an external role: it sees only assets, and can neither
 *     export nor reach any financial or administrative surface.
 */
export const ROLE_TEMPLATES: Readonly<Record<SystemRole, RoleTemplate>> = {
  platform_super_admin: {
    key: "platform_super_admin",
    label: "Platform Super Admin",
    description: "Ordence platform staff. Full access across every workspace.",
    permissions: "*",
  },

  tenant_owner: {
    key: "tenant_owner",
    label: "Owner",
    description: "Owns the workspace. Full access including billing and period close.",
    permissions: "*",
  },

  tenant_admin: {
    key: "tenant_admin",
    label: "Administrator",
    description: "Runs the workspace day to day. Everything except billing changes.",
    permissions: ALL_PERMISSIONS.filter((p) => p !== "billing:manage"),
  },

  security_admin: {
    key: "security_admin",
    label: "Security Administrator",
    description: "Oversees access, audit and integrations. No financial or CRM write access.",
    permissions: [
      "users:read", "users:invite", "users:update", "users:remove",
      "roles:read", "roles:manage",
      "settings:read", "settings:update",
      "audit:read", "integrations:manage",
      "contacts:read", "companies:read", "assets:read", "contracts:read",
      "leads:read", "projects:read", "units:read", "bookings:read", "partners:read",
      // ⚠️ READS AUTOMATIONS AND CAN STOP THEM, BUT CANNOT PUBLISH ONE.
      //
      // An automation is a standing grant of somebody's authority, so who
      // holds it is a security question and this role must be able to see
      // the answer. Cancelling a run is the emergency brake — the person
      // who notices a runaway at 6pm is almost never the person who
      // published it, and making them find that person first is how a
      // small incident becomes a long one.
      "workflows:read", "workflows:runs_read", "workflows:cancel_run",
      // Phase 32. Reads the tax registry because "which GSTIN did we
      // issue that under" is an access question as much as a tax one.
      // Writes nothing: a rate is an accounting decision.
      "gst:read",
      // ⚠️ READS SAVED VIEWS, MANAGES NOBODY'S. A shared view is a
      // description of how a team looks at its data — useful context in a
      // review — and this role has no business rearranging the boards a
      // sales floor works from.
      "views:read", "views:read_all_records",
    ],
  },

  billing_admin: {
    key: "billing_admin",
    label: "Accountant",
    description:
      "Posts and reverses entries, runs reports. Cannot close a period — that is " +
      "an attestation reserved for an owner or administrator.",
    permissions: [
      "ledgers:read", "ledgers:create", "ledgers:update",
      "transactions:read", "transactions:post", "transactions:reverse",
      "periods:read",
      "reports:trial_balance", "reports:export",
      "billing:read", "billing:manage",
      "contacts:read", "companies:read", "deals:read", "assets:read",
      "contracts:read",
      // Reads the commercial side because the ledger has to reconcile
      // against it. No write access to inventory or the pipeline.
      "leads:read", "projects:read", "units:read", "bookings:read",
      "payment_plans:read", "payment_plans:manage", "partners:read",
      // ⭐ THE ROLE THAT OWNS GST. The accountant is the person who files
      // the returns, so they maintain the rate masters and the
      // counterparty GSTINs those returns are built from.
      //
      // ⚠️ NOT `gst:manage_registrations`. Taking or surrendering a
      // registration is a decision about where the company is legally
      // present — an owner or administrator signs that, not the person
      // who files against it.
      "gst:read", "gst:manage_rates", "gst:manage_parties",
      // ⭐ PHASE 48 — THE ROLE THAT SETS CREDIT LIMITS. The accountant
      // knows who pays and who does not; nobody else in a company this
      // size has that in front of them daily.
      //
      // ⚠️ NO `sales.orders.approve_credit`. Setting the ceiling and
      // waiving it are two jobs, and the accountant chasing the money is
      // the worst-placed person to decide that this one order is fine.
      // That key sits with the owner and the administrator only.
      "sales.credit.read", "sales.credit.manage",
      // ⭐ PHASE 33 — THE ROLE THAT OWNS THE INPUT SIDE TOO. The
      // accountant enters the vendor bills, makes the Section 17(5)
      // determination and puts the credit into the GSTR-3B they file.
      // Splitting the determination from the claim across two people
      // would be theatre: the same person does both in every developer
      // small enough to be on this product, and a gate somebody routinely
      // works around is worse than no gate.
      "purchases:read", "purchases:manage_vendors", "purchases:record_invoice",
      "purchases:claim_itc", "purchases:reverse_itc",
      // ⭐ COST AGAINST CONTRACT. The accountant is the person who is
      // asked "are we over on Tower A?" and the only one who already
      // holds both halves of the answer — the vendor ledger and the
      // certified bills. Owner and administrator get it through `*`;
      // this is the one role that needs it named.
      "construction.costs.read",
      /*
       * ⭐ CONTRACTING — READ AND RAISE, NEVER CERTIFY OR APPROVE (v0.69.0).
       *
       * The accountant assembles the bill: they are the one who knows the
       * TDS section, the cess rate and what was paid on the last one. So
       * `raise` belongs here.
       *
       * ⚠️ `certify` DOES NOT. Certification is a statement that the work
       * is worth the money, and it is an engineer's professional opinion,
       * not an accounting one. An accountant who could certify would be
       * attesting to concrete they have never seen.
       *
       * ⚠️ AND `approve` DOES NOT. Approval is the instruction to pay.
       * The person who assembles a payment must never be the person who
       * releases it — that is the oldest control in the book, and it is
       * the one every construction fraud case turns on.
       */
      "construction.boq.read", "contracting.rabill.read", "contracting.rabill.raise",
      // ⭐ PHASE 34 — ALL FOUR, INCLUDING `gstr2b:file`. The accountant
      // is the person who submits the GSTR-3B, and the freeze records
      // that they did. Putting the freeze on somebody else would mean
      // the return is filed with the portal and the working paper is
      // frozen a day later by an approver who was not there — and the
      // gap between the two is exactly where a late-filed supplier
      // silently changes the figures.
      "gstr2b:read", "gstr2b:import", "gstr2b:reconcile", "gstr2b:file",
      // ⭐ PHASE 36 — ALL FIVE. TDS is the accountant's whole job in a way
      // GST is not: the deduction is made when the bill is passed for
      // payment, the deposit is made by the 7th, the return is filed
      // quarterly and the certificate is chased by the vendor — one
      // person, one continuous obligation, with a statutory deadline
      // every month.
      //
      // ⚠️ SPLITTING `tds:deduct` FROM `tds:manage_challans` ACROSS TWO
      // PEOPLE WOULD BE WORSE THAN NOT SPLITTING IT. The deduction and
      // the deposit are seven days apart and interest under Section
      // 201(1A) runs at 1.5% a month FROM THE DATE OF DEDUCTION — so an
      // approval queue between them costs money at a fixed rate, and a
      // gate that costs money at a fixed rate is a gate somebody
      // routinely works around.
      "tds:read", "tds:manage_deductees", "tds:deduct",
      "tds:manage_challans", "tds:file_return",
      // ⭐ PHASE 37 — FOUR OF THE FIVE. The accountant is the person who
      // owns the Tally company: they set the mappings, they generate the
      // file and they import it, because they are the one who knows what
      // the firm's ledgers are actually called. Anyone else guessing that
      // is how "Sales A/c" becomes "Sales — Residential Units" and the
      // P&L grows a second sales line nobody reconciles.
      //
      // ⚠️ NOT `tally:push`, DELIBERATELY, AND IT IS THE ONLY SPLIT HERE.
      // Pushing is not an accounting act — it opens a network connection
      // from our servers to an address inside the customer's office, and
      // whether that path may exist at all is an infrastructure decision
      // an administrator makes once. The accountant's daily path is the
      // file, which is what most firms use anyway and which cannot reach
      // anything.
      "tally:read", "tally:manage_mappings", "tally:export", "tally:import",
      // ⭐ PHASE 38 — SEVEN OF THE EIGHT. Collections are the accountant's
      // job end to end: they raise the demand when the site confirms the
      // slab, they issue it, they bank the money, they apply it and they
      // send the chasing letters. Splitting any of that across two people
      // would put an approval queue in the middle of a process that runs
      // two thousand times over a project's life, and a gate somebody
      // works around a hundred times a month is worse than no gate.
      //
      // ⚠️ NOT `receivables:warn_cancellation`, AND THAT IS THE ONE
      // DELIBERATE SPLIT. Threatening to terminate an allotment and
      // forfeit what a family has paid towards a home is not an accounting
      // act — it is a decision about somebody's home, taken on legal
      // advice, and the person who has been chasing the money all quarter
      // is the worst-placed person in the company to take it dispassionately.
      // Counsel and the owner hold that key.
      "receivables:read", "receivables:manage_policy", "receivables:raise_demand",
      "receivables:issue_demand", "receivables:record_receipt",
      "receivables:allocate", "receivables:dun",
      "audit:read",
      // An automation that touches the commercial side is something the
      // accountant needs to be able to see when a number does not
      // reconcile — "which workflow set that?" is a real question.
      "workflows:read", "workflows:runs_read", "workflows:approve",
      // Builds their own reconciliation lists. Cannot share one to the
      // whole workspace — that is a sales-operations decision.
      "views:read", "views:create", "views:update", "views:delete",
      "views:read_all_records",
    ],
  },

  manager: {
    key: "manager",
    label: "Legal Counsel",
    description:
      "Drafts, approves and executes contracts. Deliberately has no ledger access.",
    permissions: [
      "contracts:read", "contracts:create", "contracts:update",
      "contracts:approve", "contracts:sign", "contracts:legal_hold",
      "clauses:read", "clauses:manage",
      "contacts:read", "contacts:create", "contacts:update",
      "companies:read", "companies:create", "companies:update",
      "deals:read", "deals:update",
      "assets:read",
      "custom_objects:read", "custom_objects:create_record", "custom_objects:update_record",
      "custom_objects:delete_record",
      // Drafts the agreement, so it reads the booking it is drawn from.
      "leads:read", "projects:read", "units:read", "bookings:read",
      "payment_plans:read", "partners:read",
      // Reads the tax position because the agreement recites it — the
      // consideration in an agreement to sell is stated inclusive or
      // exclusive of GST, and which one it is has to match the invoice.
      "gst:read",
      // Phase 33. Reads the purchase side because counsel drafts and
      // enforces the contractor agreements the bills arise under — a
      // retention dispute and an MSME 45-day claim are both legal
      // questions answered from this ledger. Writes nothing.
      "purchases:read",
      // ⚠️ PHASE 34: NO `gstr2b:read` FOR COUNSEL, DELIBERATELY. It looks
      // like an obvious companion to `purchases:read` and it is not. A
      // GSTR-2B is a Government-compiled list of every supplier who
      // invoiced this company in a month, which is a more complete
      // counterparty list than the purchase ledger itself — it was
      // assembled by somebody with no incentive to leave anything out.
      // Counsel needs the CONTRACT and the BILL under it, not the map of
      // who the company buys from.
      //
      // ⭐ PHASE 38 — READS EVERYTHING, WRITES ONE THING, AND THAT ONE
      // THING IS THE MOST CONSEQUENTIAL KEY IN THE PHASE.
      //
      // `receivables:warn_cancellation` sits HERE and not with the
      // accountant who does all the other collections work. The letter it
      // authorises precedes terminating an allotment and forfeiting what a
      // family has paid towards a home; it is answered, if it is answered,
      // by an advocate; and the RERA consequences of getting the sequence
      // wrong land on counsel's desk either way. The person who has been
      // chasing the money all quarter is the worst-placed person in the
      // company to take that decision dispassionately.
      //
      // ⚠️ Counsel gets `receivables:read` with it, because authorising a
      // cancellation warning without being able to read the account it is
      // about would be a signature on somebody else's summary.
      "receivables:read", "receivables:warn_cancellation",
      // ⭐ Phase 48, read only. Counsel drafting a recovery notice recites
      // the terms the customer was trading on; a hold and its reason are
      // part of the account's history the moment the account is disputed.
      "sales.credit.read",
      "audit:read",
      // Approves what an automation asks a human to approve — a contract
      // going out, a discount, a cancellation. Reads, approves, publishes
      // nothing.
      "workflows:read", "workflows:runs_read", "workflows:approve",
      "views:read", "views:create", "views:update", "views:delete",
      "views:read_all_records",
    ],
  },

  member: {
    key: "member",
    label: "Team Member",
    description: "Standard CRM access. No financial, legal-execution or admin rights.",
    permissions: [
      "contacts:read", "contacts:create", "contacts:update",
      "companies:read", "companies:create", "companies:update",
      "deals:read", "deals:create", "deals:update",
      "assets:read", "assets:create", "assets:update",
      "custom_objects:read", "custom_objects:create_record", "custom_objects:update_record",
      "custom_objects:delete_record",
      "contracts:read",
      // ⚠️ THE SALES EXECUTIVE. Reads inventory, works the pipeline,
      // holds a unit, creates and advances a booking.
      //
      // Deliberately WITHOUT: `units:block` (management withdrawing
      // stock), `bookings:cancel` (frees a unit and moves money),
      // `leads:export` (the whole pipeline in a spreadsheet is what
      // leaves with a departing rep), `partners:override_lock`
      // (reassigns a commission somebody earned) and `leads:delete`.
      "leads:read", "leads:create", "leads:update", "leads:assign",
      "projects:read",
      "units:read", "units:hold",
      "bookings:read", "bookings:create", "bookings:update",
      "payment_plans:read",
      "partners:read",
      // ⭐ PHASE 38 — READ ONLY, AND IT MATTERS THAT THEY HAVE IT. A rep
      // whose buyer rings about a demand needs to see what was demanded
      // and what has come in; without it they say "I'll find out and call
      // you back", which is how a collectable becomes a complaint.
      //
      // ⚠️ NO WRITE KEY AT ALL, INCLUDING `receivables:record_receipt`. A
      // rep recording a receipt is a rep recording that money arrived —
      // and a sales floor with a target is exactly the wrong place for
      // that judgement. The bank statement decides, and the accountant
      // reads the bank statement.
      "receivables:read",
      // ⭐ PHASE 48 — READ, AND ONLY READ. A rep who can see the ceiling
      // stops promising delivery on an order that is going to sit in
      // approval for two days. A rep who could RAISE the ceiling would
      // raise it, every time, at the exact moment the limit was doing
      // its job.
      "sales.credit.read",
      // ⚠️ READS, WRITES NOTHING. A rep quoting a flat needs to see the
      // rate that will be charged on it. Letting them CHANGE that rate
      // would let a negotiation move the tax, which is not theirs to
      // move and is not lawful anyway.
      "gst:read",
      "users:read",
      // ⚠️ RUNS AND APPROVES; DOES NOT AUTHOR OR PUBLISH.
      //
      // A manual run acts as the person who pressed the button, so
      // `workflows:run` grants a member nothing they did not already
      // have — the automation is a shortcut, not a privilege.
      // `workflows:publish` is absent for the opposite reason: it would
      // let a member lend their identity to an unattended schedule, and
      // the next person to review that grant would be nobody.
      "workflows:read", "workflows:run", "workflows:runs_read", "workflows:approve",
      // ⚠️ SHARES, BUT DOES NOT MANAGE WHAT OTHERS SHARED. A rep who
      // builds a useful board should be able to give it to the floor;
      // deleting somebody else's is `views:manage_shared`, which is on
      // the dangerous list and is not here.
      //
      // ⚠️ `views:read_all_records` IS GRANTED, which keeps a rep's saved
      // views consistent with the leads list they already see. Revoking
      // it per user (`overrides`) is how a workspace that wants reps
      // confined to their own pipeline says so — one switch, applied to
      // every view including the ones they build themselves.
      "views:read", "views:create", "views:update", "views:delete",
      "views:share", "views:read_all_records",
      /*
       * ⭐ THE SITE ENGINEER'S HALF OF CONTRACTING — v0.69.0.
       *
       * ⚠️ `record` WITHOUT `check`, AND THAT ASYMMETRY IS THE CONTROL.
       * The person who measures the work must not be the person who
       * agrees the measurement. Granting both here would defeat the
       * separation silently — a self-checked measurement is
       * indistinguishable from a checked one, and it flows straight
       * through to a bill.
       *
       * ⚠️ AND `rabill.read` WITHOUT `raise`. A site engineer should be
       * able to see what has been claimed against the work they
       * measured — that is how a wrong claim gets noticed — without
       * being able to assemble the claim themselves.
       */
      "construction.boq.read",
      "construction.measurement.record",
      "contracting.rabill.read",
    ],
  },

  read_only: {
    key: "read_only",
    label: "Read Only",
    description: "Can view but never change anything.",
    permissions: [
      "contacts:read", "companies:read", "deals:read", "assets:read",
      "custom_objects:read", "contracts:read", "clauses:read",
      "ledgers:read", "transactions:read", "periods:read",
      "leads:read", "projects:read", "units:read", "bookings:read",
      "payment_plans:read", "partners:read",
      "gst:read",
      // ⚠️ Phase 33 reads only, and note what is NOT here for `member`
      // above: a sales executive has no `purchases:read` at all. What we
      // pay our contractors is not something a rep needs and is exactly
      // what leaves with a departing one.
      "purchases:read",
      // Phase 34, read only. A read-only role that could accept a match
      // would not be read-only — accepting one asserts that two documents
      // are the same supply, which is the assertion an officer tests.
      "gstr2b:read",
      // ⭐ Phase 38, read only. The ageing report is what a director, a
      // lender's analyst and a project manager all open first, and none of
      // them should be able to move a rupee of it.
      //
      // ⚠️ AND UNLIKE `tds:read` BELOW, THIS ONE IS GRANTED. The
      // difference is whose data it is: `tds_deductees` carries a hundred
      // third parties' PANs, held only because the Income-tax Act demands
      // it. A demand notice is a document between this workspace and its
      // own buyer, and its amounts are the workspace's own business.
      "receivables:read",
      // ⚠️ PHASE 36: NO `tds:read` FOR READ-ONLY, DELIBERATELY, AND IT IS
      // THE ONLY PHASE SO FAR WHERE THE READ KEY IS WITHHELD FROM THIS
      // ROLE. `tds_deductees` is a list of every contractor, consultant,
      // landlord and landowner the company pays, WITH THEIR PAN — a
      // government identity number that is directly usable to look a
      // person up elsewhere, and that we hold only because the Income-tax
      // Act requires it. A role handed out for "let them see the
      // numbers" should not carry a hundred third parties' PANs with it.
      // ⭐ Phase 48, read only. Credit exposure is the first number a
      // director or a lender's analyst asks for, and neither of them
      // should be able to move a rupee of it.
      "sales.credit.read",
      "users:read", "settings:read",
      "workflows:read", "workflows:runs_read",
      // Opens saved views; saves none. A read-only role that could create
      // rows in `saved_views` would not be read-only.
      "views:read", "views:read_all_records",
    ],
  },

  guest: {
    key: "guest",
    label: "Contractor / External",
    description:
      "External collaborator. Sees only the assets shared with them. No export, " +
      "no financials, no administration.",
    // ⚠️ NO `leads:read`. An external collaborator has no business
    // seeing the buyer pipeline, and `units:read` is enough for a
    // contractor working on the building itself.
    //
    // ⚠️ AND NO `workflows:*` AT ALL — not even `read`. A workflow
    // definition names the fields, record types and external endpoints a
    // company automates against; read access to it is a map of how the
    // business runs, handed to somebody outside it.
    permissions: [
      "assets:read", "custom_objects:read", "contracts:read",
      "units:read", "projects:read",
    ],
  },
};

/** Resolve the effective permission set for a role. */
export function permissionsForRole(role: SystemRole): readonly PermissionKey[] {
  const template = ROLE_TEMPLATES[role];
  return template.permissions === "*" ? ALL_PERMISSIONS : template.permissions;
}

/* ------------------------------------------------------------------ */
/* PERMISSION DENIAL LOG                                               */
/* ------------------------------------------------------------------ */

/**
 * Records permission checks that FAILED.
 *
 * Successful checks are not recorded — they would be enormous and say nothing.
 * A denial, on the other hand, is a signal: either a user needs access they do
 * not have (a support issue), or someone is probing for what they can reach
 * (a security issue). A cluster of denials from one actor is the clearest early
 * indicator of an account being misused.
 */
export const permissionDenials = pgTable(
  "permission_denials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    clerkUserId: varchar("clerk_user_id", { length: 255 }),
    actorRole: varchar("actor_role", { length: 60 }),

    /** The permission that was requested, e.g. "periods:close". */
    permission: varchar("permission", { length: 120 }).notNull(),
    resourceType: varchar("resource_type", { length: 100 }),
    resourceId: varchar("resource_id", { length: 255 }),

    /** True when the permission is on the dangerous list. */
    wasDangerous: boolean("was_dangerous").default(false).notNull(),

    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    requestId: varchar("request_id", { length: 255 }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantIdx: index("permission_denials_tenant_idx").on(t.tenantId),
    tenantCreatedIdx: index("permission_denials_created_idx").on(t.tenantId, t.createdAt),
    userIdx: index("permission_denials_user_idx").on(t.tenantId, t.userId),
    permissionIdx: index("permission_denials_permission_idx").on(t.tenantId, t.permission),
    dangerousIdx: index("permission_denials_dangerous_idx").on(t.tenantId, t.wasDangerous),
  }),
);

export const permissionDenialsRelations = relations(permissionDenials, ({ one }) => ({
  tenant: one(tenants, { fields: [permissionDenials.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [permissionDenials.userId], references: [users.id] }),
}));

export type PermissionDenial = typeof permissionDenials.$inferSelect;
export type NewPermissionDenial = typeof permissionDenials.$inferInsert;
