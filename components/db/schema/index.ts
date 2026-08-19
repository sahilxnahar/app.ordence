/**
 * Ordence — Schema Barrel
 * Version: v0.2.0-alpha
 *
 * Single import surface for the entire database schema. Drizzle's relational
 * query API needs every table and relation registered in one object, which is
 * what `db/index.ts` gets by importing `* as schema` from here.
 */

// Platform core — tenants, users, RBAC, audit
export * from "./core";

// Standard CRM entities
export * from "./crm";
export * from "./credit";

/**
 * ⭐ Phase 49 — the outward document.
 *
 * ⚠️ EXPORTED AFTER `./orders` AND `./gst`, WHICH IT REFERENCES. And note
 * it is NOT `./billing` — `billing.invoices` is Ordence billing its own
 * tenants; these are a tenant billing its customers. Same shape, opposite
 * direction, and merging them puts our revenue in their GSTR-1.
 */
export * from "./sales-invoices";

// Dynamic custom object engine (vertical SaaS)
export * from "./custom-objects";

// Universal asset & catalog engine
export * from "./assets";

// Contract lifecycle management
export * from "./clm";

// Double-entry trust accounting
export * from "./accounting";
export * from "./banking";
export * from "./agents";
export * from "./platform-control";

// Granular authorization catalog & denial log
export * from "./auth";

// Document storage metadata (bytes live in Vercel Blob, not Postgres)
export * from "./storage";

// External client portal — bearer-token links and signature evidence
export * from "./portals";

// Read-optimised analytics views (defined in SQL-FILES, typed here)
export * from "./analytics";

// Billing — plans, subscriptions, invoices, payment evidence
export * from "./billing";

// Telemetry — error and Core Web Vitals events (Phase 19)
export * from "./telemetry";

// Security operations — the structured security event stream (Phase 20)
export * from "./secops";

// Usage metering — per-tenant counters and levels (Phase 15)
export * from "./metering";

// Platform administration — staff, impersonation evidence, tenant flags (17/18)
export * from "./platform";

// Sales pipeline & inventory — projects, units, leads, bookings (Phase 22)
export * from "./sales";

// Workflow & automation engine — versioned definitions, runs, approvals (Phase 23)
export * from "./workflows";

// Runtime custom objects — metadata for tenant-defined tables created by real
// CREATE TABLE at runtime (Phase 24). Supersedes the JSONB engine in
// `./custom-objects`, which stays for the data already stored in it.
export * from "./dynamic-objects";

// Saved views — the generalised views engine over any record type (Phase 25)
export * from "./views";

// GST foundation — our registrations, counterparty GSTINs and ⭐ DATED
// HSN/SAC rates. Everything Indian-tax in later phases sits on this (Phase 32)
export * from "./gst";

// Purchases & ⭐ input tax credit — vendors, vendor invoices, the Section
// 17(5) determination, Rule 42/43 apportionment and the ITC register. The
// input side of GST, and what Phase 34's GSTR-2B reconciliation matches
// against (Phase 33)
export * from "./purchases";

// ⭐ GSTR-2B reconciliation — the imported statement (stored raw and
// immutable), its parsed rows, the explained match between it and the purchase
// register, and the per-period summary that freezes once filed. Section
// 16(2)(aa) makes the SUPPLIER'S filing a precondition of our input tax
// credit, so this is the phase that decides how much of Phase 33's
// determination we may actually claim (Phase 34)
export * from "./gstr2b";

// ⭐ Tax Deducted at Source — deductees keyed on PAN, the deduction register
// with its CUMULATIVE per-year threshold arithmetic, Section 197
// lower-deduction certificates, challans, Form 16A/27D assembly and the
// 24Q/26Q/27Q quarterly returns. Not a tax on us at all: the government
// making us its collection agent on payments we make to somebody else, which
// is why under-deducting makes US the assessee in default (Phase 36)
export * from "./tds";

// ⭐ Tally integration — the explicit mapping between our chart of accounts and
// a firm's own Tally ledger names, the vouchers generated from it, the export
// batches that record what was sent with a hash of the bytes, and the
// reconciliation of a Tally export read back. Its centre is
// `tally_vouchers.remote_id`: Tally de-duplicates on that key and on nothing
// else, so a source row that acquires a SECOND key gets a second voucher —
// balanced, invisible, and doubling the period (Phase 37)
export * from "./tally";

// ⭐ Receivables & demand notices — how a developer actually collects money.
// Demands raised AGAINST Phase 22's construction-linked milestones when the
// trigger is achieved, in ⭐ six languages because `leads.preferred_lang` has
// said since Phase 22 that a demand a buyer cannot read is a demand that does
// not get paid; delay interest whose compounding rule is stated ON the notice;
// ageing buckets; the dunning ladder that may not skip a rung and whose last
// rung may never be automatic; receipts, their exact allocation across several
// demands, and the statement of account that has to foot in front of somebody
// who disagrees with it (Phase 38)
export * from "./receivables";

// ⭐ Sales orders — the missing noun between a deal (a probability) and an
// invoice (a demand for money). An order is a COMMITMENT: goods agreed and
// not yet delivered. Its centre is the rule that a confirmed line's price
// and quantity do not move, because every downstream figure — dispatchable
// quantity, invoiceable value, recognised revenue, commission, the
// customer's own paperwork — is derived from that line, and an editable
// line restates all of them retroactively with nothing recording it.
// Quantity is deliberately three separate facts (ordered, fulfilled,
// cancelled) because "remaining" cannot distinguish "not shipped yet" from
// "short-shipped and closed", and those owe the customer opposite things
// (Phase 39)
export * from "./orders";

// ⭐ Inventory — warehouses, stock items, and the APPEND-ONLY stock ledger.
// Its centre is a refusal: stock on hand is not a column, it is a sum of
// movements. A `quantity_on_hand` integer that code adds to and subtracts
// from works for about a year and then drifts, with no history to find the
// cause and no remedy but a physical count. So every receipt, issue,
// transfer and adjustment is a row that is never updated and never deleted;
// a mistake is corrected by a reversing movement that names what it
// reverses. `stock_balances` is a cache the trigger maintains and nothing
// else writes — if it disagreed with the ledger it could be rebuilt in one
// query, and that property is the test of whether the design is right.
// Second only to that: AVAILABLE = ON HAND − RESERVED, which is what stops
// the same cement being promised to two customers (Phase 40)
export * from "./inventory";

// ⭐ Land, title and the JDA — PORT WAVE A, from the working single-company
// system. Where a developer's life actually starts: who owned the land, how
// they came to own it, whether that ownership is clean, and whether the thing
// may lawfully be built on. Its centre is that the chain of title is ORDERED,
// so a gap between one deed's buyer and the next deed's seller is visible
// rather than implied — an unordered pile of scans looks complete when the
// missing link is the one nobody uploaded. Shares are exact fractions, never
// percentages (three heirs of one third sum to 99.99 as decimals). A
// relinquishment and a POA revocation are recorded, never deleted, because a
// deed executed while the POA was live stays good afterwards (Phase 42)
export * from "./land";
export * from "./legal";
export * from "./legal-billing";
export * from "./work";
export * from "./front-office";
export * from "./procurement";

// ⭐ Running-account bills and contractor compliance — PORT WAVE B. The
// densest money document a developer signs: gross certified, less everything
// paid on earlier RA bills, less 1% BOCW labour cess, less 5% retention, less
// 194C TDS. Its centre is a rule with statute behind it — a contractor with
// no VERIFIED EPF/ESI challan for the period does not get paid for that
// period, because the developer is the principal employer and pays twice if
// the contractor did not deposit. `previous_paid` is derived by trigger and
// never typed: a hand-keyed cumulative figure drifts one plausible bill at a
// time and is discovered at the final bill, after the contractor has left
// (Phase 44)
export * from "./contracting";

// ⭐ ENGINE 4 — the compliance calendar (Session 1). The cheapest engine
// on the list and the one all ten verticals need: what must be done, for
// whom, by when, and what lateness costs. Its centre is one nullable
// column — `subject_company_id` — which lets the same table answer both
// "when is MY GST due" and "which of my four hundred clients has not
// filed", with no second schema. A separate client-compliance table would
// have duplicated the reminder ladder, the evidence store and the
// late-fee arithmetic, and the copies would have diverged on the first
// bug fix. Due dates are DERIVED from the period by trigger, never typed;
// a missed deadline moves to `missed` and stays, because a register you
// can tidy is a register no inspector will accept (Engine 4)
export * from "./compliance";

// ⭐ ENGINE 1 — scheduling & capacity (Session 1). The keystone: five
// verticals ask the same question — can this resource be committed for
// that span, and is it already promised elsewhere? Its centre is a
// refusal to solve concurrency in application code. Check-then-write is
// two statements, and every naive booking system works in testing and
// double-sells on the first busy day. So exclusivity is a POSTGRESQL
// EXCLUSION CONSTRAINT over a tstzrange, and shared capacity is counted
// under `FOR UPDATE` on the resource row. Overbooking stays possible
// because a hotel that cannot oversell loses money on no-shows — but it
// is a STATED allowance per resource and every instance is flagged,
// rather than an accident nobody can find at 9pm (Engine 1)
export * from "./scheduling";

// ⭐ ENGINE 2 — rate & pricing (Session 1). One slab formula for six
// verticals, so an electricity tariff, a freight rate and a volume
// discount stop being three pricing engines that round money three
// different ways. Its centre is `slab_mode`, which is REQUIRED and has NO
// DEFAULT: "first 100 at ₹4.50, next 200 at ₹6.20" means ₹1,380 to an
// electricity board (progressive) and ₹1,550 to a freight desk (flat) —
// a 27% gap on the same card, and a system that guesses is wrong for half
// its users with no clue which half. Money is bigint paise, rates are
// integer basis points, and rounding happens once at the end, half-up,
// because that is what Tally does and a reconciliation that drifts a
// rupee a line becomes an argument about arithmetic. Quotes are
// append-only: "what did you quote us on 14 March" is not answerable by
// recomputing, because the card has changed since (Engine 2)
export * from "./pricing";

// ⭐ ENGINE 5 — utility metering & consumption billing (Session 1).
// ⚠️ NOT `./metering`, which already exists and counts SaaS usage — these
// are physical meters. Its centre is that a reading is an ODOMETER and
// consumption is DERIVED: storing "450 units in July" throws away the
// only thing that could ever verify it, so a disputed month has your
// arithmetic and nothing to check it against. Two ways a reading goes
// DOWN legitimately, both handled: rollover (a 5-digit dial passing
// 99999 → 00042 consumed 43 units, not −99,957 — which would otherwise
// auto-issue a credit note for a year of free supply) and replacement
// (no arithmetic relationship at all, so a replacement is a new row and
// the engine refuses to subtract across meters). Net export is BANKED and
// carried forward, never netted within the month — netting quietly
// destroys the bank in the utility's favour, monthly (Engine 5)
export * from "./utility-meters";

// ⭐ ENGINE 3 — field & mobile operations (Session 1). Six verticals send
// somebody somewhere and need to prove they went: a solar commissioning,
// a delivery, a home-care visit, an AMC breakdown call, a meter round, a
// site inspection. Its centre is taking OFFLINE literally — a basement
// plant room, a lift, a village at the edge of coverage — so the DEVICE
// generates the idempotency key before its first attempt, and a phone
// that loses signal mid-submit and retries collides with itself instead
// of billing the customer twice. GPS is EVIDENCE, NOT A GATE: refusing a
// check-in 600m out does not stop the technician working (the customer is
// standing there), it stops the work being RECORDED, and what you get is
// a job history missing precisely the hard jobs. A visit is its own row
// because one job takes several, and the wasted second trip is the number
// nobody can otherwise see (Engine 3)
export * from "./field-ops";

// ⭐ ENGINE 6 — the sensitive-data vault (Session 1). The engine that
// exists so the other five can be careless. RLS answers "which tenant may
// read this row"; it does not answer "should a plaintext PAN exist in a
// backup at all" — and a leaked backup, a mis-scoped replica or a support
// engineer with a psql prompt are stopped by neither. So the database
// holds CIPHERTEXT ONLY and never the key: not pgcrypto, because
// `pgp_sym_encrypt(x,'key')` puts the key in pg_stat_statements and in
// every backup of the logs. Search survives via an HMAC blind index under
// a pepper held outside the database — a plain SHA-256 of a PAN IS the
// PAN, since the space is ~10^9 and a laptop enumerates it in minutes.
// Every decryption appends an access-log row with a purpose from a fixed
// list, because no policy stops someone entitled to read one record from
// reading four thousand — only a log makes it visible the next morning.
// Erasure zeroes the ciphertext and KEEPS the row, because the row is the
// proof that erasure happened (Engine 6)
export * from "./vault";

// ⭐ Bill of quantities, measurement books, rate analysis and variations
// — the construction side of what a contractor gets paid FOR.
//
// ⚠️ THIS IS NOT A SECOND RA-BILL ENGINE. It used to be: the file
// carried its own `ra_bills` and three companion tables, which collided
// head-on with `./contracting` and is why it sat unregistered while its
// genuinely unique work went unused. The duplicates are gone and the
// split is now by ownership — `./contracting` owns the BILL (what is
// certified, deducted and paid), this file owns what the bill is ABOUT.
//
// Its centre is that a quantity is MEASURED, not asserted. A rate is
// ₹6,450 per cum or per sqm and those are different contracts; the unit
// is part of the price, not a label. And a variation is a change to the
// contract rather than an edit to it, because "the client asked for
// granite instead of vitrified" is the single most common thing a
// contractor and a developer end up in arbitration about, and the only
// defence is a record of who approved what, when, at what rate
export * from "./construction";

// ⭐ Site labour — workers, attendance, welfare, piece rates, rosters,
// vendor defaults and the daily site log.
//
// ⚠️ IT IS WHAT MAKES THE CONTRACTOR-COMPLIANCE GATE IN `./contracting`
// MEAN ANYTHING. That gate refuses to pay a contractor with no verified
// EPF/ESI challan for the period — a rule with statute behind it, since
// the developer is the principal employer and pays twice if the
// contractor did not deposit. But a challan is only checkable against
// who was actually on site, and that is this file. Without it the gate
// verifies a document against nothing
export * from "./labour";

// ⭐ MCP access — tokens and the append-only call log (Batch 5).
export * from "./mcp";

// ⭐ Tenant pattern memory — learned business facts for AI agents (Phase D).
// Structured JSONB facts, per-tenant, RLS-protected. The Ordence equivalent
// of RUFLO's self-learning memory, but auditable and tenant-scoped.
export * from "./ai-patterns";

// Notifications — per-tenant notification center for alerts and insights
export * from "./notifications";

/**
 * ⭐ THE MAIL OUTBOX AND THE SUPPRESSION LIST (0097). The thing that
 * finally drains the queues four other tables were writing into.
 */
export * from "./email";

/**
 * Deployment releases/backups, the 460-batch tracker, and quick-flow
 * submissions — the four tables created by `SQL-FILES/0046`.
 *
 * ⚠️ Registered here because `drizzle-kit push` DROPS anything it does
 * not recognise. Present in SQL but absent from this barrel, they were
 * one `db:push` away from deletion.
 */
export * from "./governance";

/**
 * ⭐ THE INTEGRATION FRAME — connections, sync runs, webhook endpoints
 * and deliveries (SQL 0064).
 *
 * ⚠️ THERE IS DELIBERATELY NO SECRETS TABLE HERE. Integration
 * credentials go into `vault_secrets` from `./vault`, which has held
 * `api_credential` in its kind list since 0037 and which nothing had
 * ever written to. A second secrets table would have meant two erasure
 * paths and an access log that misses the credentials most worth
 * logging.
 */
export * from "./integrations";

/**
 * ⭐⭐ UTILITY MESSAGING — templates, the 24 hour window, and what was
 * actually sent (SQL 0066).
 *
 * 🔴 THIS IS WHAT MAKES `dunning_events.channel = 'whatsapp'` TRUE. That
 * column has recorded WhatsApp service since 0027 in a table built to be
 * evidence, and nothing had ever sent one.
 */
export * from "./messaging";

/**
 * ⭐⭐ CAMPAIGNS — and the audience frozen as rows at approval (SQL 0067).
 *
 * 🔴 NOT A SAVED FILTER. Every marketing tool re-runs the filter at send
 * time, so the list that goes out is not the list that was approved.
 */
export * from "./campaigns";

/**
 * ⭐⭐ ORDER RHYTHM, ITS SIGNALS, AND THE AUTOMATION EVENT QUEUE
 * (SQL 0068).
 *
 * 🔴 The automation engine has had triggers, conditions, an executor and
 * a screen since v0.7x, and no business event has ever reached it.
 * `automationEvents` is that queue, not a second engine.
 */
export * from "./patterns";

/**
 * ⭐⭐⭐ PAYROLL — Batch 15 (SQL 0075).
 *
 * 🔴 Employees are not `users` and are not `site_workers`. Both
 * separations are load-bearing: most employees never sign in, and
 * contract labour is paid through a vendor's RA bill rather than a
 * payslip.
 *
 * ⚠️ No Aadhaar and no bank account number. Ordence ACCRUES payroll; it
 * does not disburse it. See the file header for the full argument.
 */
export * from "./payroll";

/**
 * ⭐⭐⭐ LEAVE AND STAFF ATTENDANCE — Batch 59 (SQL 0082).
 *
 * ⚠️ EXPORTED AFTER `./payroll`, WHICH IT REFERENCES. `leave_ledger`,
 * `leave_requests` and `staff_attendance` all hang off `employees`, and
 * the dependency runs one way only.
 *
 * 🔴 `staff_attendance` IS THE TABLE THE PAYROLL RUN BOARD HAS BEEN
 * PASSING `attendance: []` IN PLACE OF. It is NOT `site_attendance` from
 * `./labour` — that one records punches for contract labour who are on
 * nobody's payroll.
 */
export * from "./leave";

/**
 * ⭐⭐⭐ THE MONTHLY RETURN — Batch 16 (SQL 0077).
 *
 * 🔴 One row per GSTIN per period, not per tenant. A business registered
 * in three States files three separate 3Bs with three separate set-offs,
 * and credit does not move between them.
 *
 * ⚠️ A filed return is frozen. GST provides no amendment of a filed 3B —
 * only an adjustment in the next one — so a system that allows an edit
 * teaches a workflow that does not exist.
 */
export * from "./returns";

/**
 * ⭐⭐⭐ COST CENTRES AND BUDGETS — Batch 68 (SQL 0084).
 *
 * ⚠️ EXPORTED AFTER `./accounting`, WHICH IT REFERENCES. `budget_lines`
 * hangs off `ledgers` and `financial_periods`, and the dependency runs
 * one way only — `accounting.ts` deliberately does NOT reference
 * `cost_centres` back, which is why `journal_entries.cost_centre_id`
 * carries its foreign key in the migration rather than in Drizzle.
 *
 * 🔴 THE COST CENTRE IS ON THE JOURNAL **LINE**. A header dimension
 * cannot record one invoice split across two departments, and
 * `journal_entries` is append-only, so retrofitting the grain later
 * means reversing and re-posting a year of history rather than running
 * an UPDATE.
 */
export * from "./budgets";

/**
 * ⭐⭐⭐ SLUG AUTHORITY — Batch 132 (SQL 0091).
 *
 * 🔴 EXPORTED AFTER `./core`, WHICH IT REFERENCES. `tenant_slug_history`
 * hangs off `tenants`, and the dependency runs one way only —
 * `core.ts` deliberately does NOT reference back, which is why
 * `tenantsRelations` gains no `slugHistory` side.
 *
 * 🔴 A TENANT SLUG IS A PUBLIC DNS LABEL UNDER OUR WILDCARD CERTIFICATE,
 * and every issuance is published in the public CT log within minutes.
 * Before 0091 the database knew one thing about slugs — a byte-comparing
 * unique index — while two TypeScript files, one deciding what RESOLVES
 * and one deciding what is CREATED, had drifted apart by eight names in
 * each direction. `reserved_slugs` is now the single list, and it is a
 * TABLE rather than a constraint so an operator can tighten it at 2am
 * without a deploy.
 *
 * ⚠️ THE AVAILABILITY CHECK IS ADVISORY. The unique index is the truth
 * and the insert is the claim. Any code path that asks "is acme free?"
 * and then TRUSTS the answer is a race whose window is the user's typing
 * speed; the greyed-out signup button is a mistake guard, never a
 * boundary.
 */
export * from "./slugs";

/**
 * ⭐⭐⭐ THE FIXED ASSET REGISTER AND THE DEPRECIATION ENGINE — Batch 100
 *        (SQL 0100).
 *
 * 🔴 EXPORTED AFTER `./assets`, `./accounting` AND `./core`, ALL THREE OF
 * WHICH IT REFERENCES — the CRM catalogue row for the same physical
 * thing, the ledger transaction a depreciation run posts, and the tenant.
 * The dependency runs one way only: `assets.ts` knows nothing about
 * capitalisation, and must not, because the `assets` table also holds the
 * flats a developer is SELLING and those are stock in trade.
 *
 * ⚠️ THIS IS A SECOND ASSET TABLE ON PURPOSE. See the header of
 * `fixed-assets.ts` for why `assets` was considered and rejected: a
 * `numeric(18,2)` "value" column is not a cost, a CRM catalogue entry is
 * not a block of assets, and Schedule II component accounting needs a
 * carve-out invariant an edge table cannot hold.
 */
export * from "./fixed-assets";

/**
 * ⭐⭐⭐ MULTI-CURRENCY AND FX — Batch 0101 (SQL 0101).
 *
 * 🔴 EXPORTED AFTER `./core` AND `./accounting`, BOTH OF WHICH IT
 * REFERENCES — the tenant, the user who typed a rate, and the ledger
 * transaction a revaluation posts.
 *
 * ⚠️ TWO OF ITS FIVE TABLES HAVE NO `tenant_id` AND THAT IS THE DESIGN,
 * NOT AN OMISSION. `currency_units` (how many decimals the dinar has) and
 * `fx_reference_rates` (what the RBI published) are the same fact for
 * every workspace. `fx_rates` — what somebody in THIS workspace typed —
 * is tenant-scoped with the ordinary policy and no escape hatch. The
 * header of `fx.ts` argues the split.
 */
export * from "./fx";

/**
 * ⭐⭐ PER-TENANT AI PROVIDER CREDENTIALS — Batch 0105 (SQL 0105).
 *
 * 🔴 FLAGGED LOUDLY, BECAUSE THIS FILE IS THE COLLISION POINT WHEN THREE
 * STREAMS LAND AT ONCE: this is ONE new line at the END, and it must
 * stay one line at the end. Nothing above it was touched.
 *
 * 🔴 EXPORTED AFTER `./core`, WHICH IT REFERENCES — the tenant that owns
 * the key and the user who typed it. It deliberately does NOT reference
 * `./vault`: the secret lives in `vault_secrets` under a loose
 * (owner_kind, owner_id) pair, exactly as a connection's credential
 * does, so the vault needs no foreign key to yet another table.
 *
 * ⚠️ THE TABLE HOLDS NO KEY. See the header of `ai-credentials.ts` for
 * why the row and the secret are separate objects, and why there is no
 * `lane` column on it.
 */
export * from "./ai-credentials";

/**
 * ⭐ Batch H — DPDPA 2023 data-principal requests, erasure refusals and
 * breach intimations. DDL in SQL-FILES/0110.
 *
 * ⚠️ EXPORTED AFTER `./core`, WHICH IT REFERENCES.
 */
export * from "./dpdp";
/** ⭐ 0117 · wave 6 — the migration engine. See db/schema/import-runs.ts. */
export * from "./import-runs";
/** ⭐ 0118 · wave 7 — the drawing register. See db/schema/drawings.ts. */
export * from "./drawings";
/** ⭐ 0119 · wave 8 — the cross-instance rate limit counter. */
export * from "./rate-limit";
