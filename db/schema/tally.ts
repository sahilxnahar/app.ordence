/**
 * Ordence — ⭐ Tally Integration (Phase 37)
 * Version: v0.37.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT PHASE 37 IS: THE PRODUCT LEAVING THE BUILDING
 * ══════════════════════════════════════════════════════════════════════
 * Every phase so far has been about what happens INSIDE this workspace.
 * This one is about what happens when the numbers leave it, because in
 * India they always do: the statutory books, the audit file, the balance
 * sheet the bank asks for and the return the chartered accountant signs
 * are all produced in Tally. The developer's own team may live in this
 * product all month; their accountant does not, and will not.
 *
 * So the integration is not a convenience. It is the difference between
 * being the system of record and being a screen somebody re-types into.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ HOW TALLY ACTUALLY INTEGRATES, WHICH IS NOT HOW ANYTHING ELSE DOES
 * ══════════════════════════════════════════════════════════════════════
 * There is no REST API. There is no cloud. There is no OAuth, no webhook
 * and no vendor-hosted anything. Tally exposes ONE mechanism:
 *
 *   • An XML request/response socket, spoken over HTTP, on a port the
 *     user turns on inside Tally (default 9000), bound to the machine
 *     Tally is running on. Usually a desktop in the accounts room.
 *   • And the same XML as a FILE, which Tally imports from
 *     Gateway → Import Data.
 *
 * ⭐ SO BOTH PATHS ARE BUILT, AND THE FILE PATH IS THE PRIMARY ONE.
 * The direct push is nicer when it works and it needs Tally running, the
 * right company open, the port enabled, and this server on the same
 * network as that desktop — which for a hosted product is almost never
 * true. The file always works, is what most firms actually use, and is
 * the one an accountant can inspect before importing. `tally_export_
 * batches.delivery_mode` records which was used.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ERROR THIS PHASE EXISTS TO PREVENT: THE DOUBLE POST
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ TALLY WILL CHEERFULLY IMPORT THE SAME VOUCHER TWICE.
 *
 * It does not de-duplicate on voucher number, on date, on amount, or on
 * anything else you might reasonably hope. Import April's file, notice a
 * ledger was misnamed, fix it, import April again — and April's sales
 * are now double. The trial balance still balances, because both copies
 * are balanced vouchers. Nothing is out of order. The turnover is simply
 * twice what it should be, and it is discovered at the year end by
 * somebody comparing the GSTR-1 to the books.
 *
 * The ONLY thing Tally will de-duplicate on is `REMOTEID` — the identity
 * an external system stamps on a voucher. Given the same REMOTEID and
 * `ACTION="Alter"`, Tally UPDATES the existing voucher instead of adding
 * one.
 *
 * ⚠️ WHICH MAKES THE REMOTEID A PIECE OF PERMANENT DATA, NOT A DETAIL OF
 * A PARTICULAR EXPORT. It is derived in `lib/tally/keys.ts` from the
 * tenant, the voucher type and the SOURCE ROW — never from the date, the
 * amount or the narration, because a corrected invoice must keep the key
 * of the invoice it corrects. It is stored on `tally_vouchers`, and SQL
 * 0026 §6 refuses to write a second, different key for a source row that
 * has already been exported. That refusal is the whole phase.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE SECOND ERROR: THE LEDGER NAME
 * ══════════════════════════════════════════════════════════════════════
 * A Tally ledger is identified by its NAME. Free text, typed by whoever
 * set the company up, and no two firms type it the same way — "Sales
 * A/c", "Sales Account", "Sales - Residential", "SALES". Tally matches on
 * the name and creates a new ledger under a guessed group when it does
 * not find one, so a mis-typed name does not fail: it silently invents
 * "Sales Account" under Suspense and puts a month's revenue in it.
 *
 * ⭐ SO THE MAPPING IS EXPLICIT, STORED, AND RESOLVED BEFORE EXPORT —
 * never inferred at export time from our own account name. An unmapped
 * account is a REFUSAL, in `lib/tally/ledgers.ts`, not a fallback.
 *
 * ⚠️ AND TALLY MATCHES LEDGER NAMES CASE-INSENSITIVELY. "Sales A/c" and
 * "sales a/c" are one ledger to Tally and two rows to a naive unique
 * index, which is why the uniqueness in SQL 0026 §2 is on `lower(name)`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE THIRD ERROR: XML THAT LOOKS FINE
 * ══════════════════════════════════════════════════════════════════════
 * A vendor called "Shah & Sons" produces `<LEDGERNAME>Shah & Sons</...>`,
 * which is not well-formed XML. Tally's importer does not report a parse
 * error against a line number; it reports "0 vouchers imported" or, on
 * some builds, imports everything up to that point and stops. The
 * accountant has a file that imported half of March.
 *
 * Every string that reaches the XML goes through `lib/tally/xml.ts`.
 * `tests/security/tally.test.ts` puts `&`, `<`, `>`, `"`, `'` and a
 * control character into a party name and round-trips it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not restate the ledger. `ledgers`, `transactions` and
 * `journal_entries` (Phase 4) are the books; a Tally voucher is a VIEW of
 * them in somebody else's vocabulary. It does not restate the invoice
 * either — `purchase_invoices` (Phase 33) and the GST tables (Phase 32)
 * are where the HSN, the rate and the place of supply live.
 *
 * It does not compute anything. The XML, the escaping, the deterministic
 * keys, the balance assertion, the parser and the reconciliation diff all
 * live in `lib/tally/`, which has no database import.
 *
 * ⚠️ Money is `bigint` paise. Tally speaks decimal rupees, and the
 * conversion happens once, in `lib/tally/amounts.ts`, by string
 * manipulation — never by dividing by 100 in floating point.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  jsonb,
  boolean,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { tenants, users } from "./core";
import { ledgers } from "./accounting";
import { projects } from "./sales";

/* ------------------------------------------------------------------ */
/* ENUMS — THE VOUCHER                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE EIGHT VOUCHER TYPES THAT MATTER, AND THEY ARE TALLY'S OWN.
 *
 * These are not our categories. They are the names Tally ships with, and
 * the string in `<VOUCHERTYPENAME>` must be one Tally recognises or the
 * voucher lands under a type it invents.
 *
 *   sales / purchase   — the two that carry GST, HSN and a party.
 *   receipt / payment  — money in and money out. ⚠️ A receipt is NOT a
 *                        sale: booking money against an under-construction
 *                        flat is a receipt against the customer ledger and
 *                        becomes revenue on a different day entirely.
 *   journal            — everything else with two named sides. Accruals,
 *                        depreciation, the TDS deduction entry.
 *   contra             — ⚠️ CASH/BANK TO CASH/BANK ONLY. Tally enforces
 *                        this and rejects a contra with any other ledger
 *                        on it, which is exactly the sort of refusal that
 *                        arrives as "0 vouchers imported".
 *   credit_note        — a sales return or a downward revision. Rule 53(1A)
 *                        under GST; Tally needs it as its own type so the
 *                        GSTR-1 tables in Tally pick it up.
 *   debit_note         — a purchase return or a vendor short-supply.
 *
 * ⚠️ WHAT IS NOT HERE: `stock journal`, `physical stock`, `delivery note`
 * and the rest of Tally's inventory vouchers. This product does not keep
 * stock in the Tally sense, and emitting a voucher type whose inventory
 * fields we cannot fill is how a "successful" import produces a stock
 * summary nobody can explain.
 */
export const tallyVoucherTypeEnum = pgEnum("tally_voucher_type", [
  "sales",
  "purchase",
  "receipt",
  "payment",
  "journal",
  "contra",
  "credit_note",
  "debit_note",
]);

/**
 * ⭐ TALLY'S PRIMARY GROUPS — THE PARENT A NEW LEDGER IS FILED UNDER.
 *
 * ⚠️ THE GROUP IS NOT COSMETIC. It decides which side of the balance
 * sheet a ledger appears on, whether it closes to the P&L at year end,
 * and whether Tally's own GST reports look at it at all. A tax ledger
 * filed under "Indirect Expenses" instead of "Duties & Taxes" produces a
 * GSTR-1 in Tally with no output tax on it, and a balance sheet that
 * balances perfectly while the liability is missing.
 *
 * These strings are Tally's, spelled Tally's way, including the
 * ampersand in "Duties & Taxes" — which is itself the first place the
 * XML escaping in `lib/tally/xml.ts` earns its keep.
 */
export const tallyLedgerGroupEnum = pgEnum("tally_ledger_group", [
  /** Customers. Party ledgers with bill-wise details. */
  "sundry_debtors",
  /** Vendors, contractors, sub-contractors. */
  "sundry_creditors",
  "sales_accounts",
  "purchase_accounts",
  /** ⭐ CGST/SGST/IGST/cess, and TDS payable. Tally's GST reports read this. */
  "duties_and_taxes",
  "bank_accounts",
  /** ⚠️ Tally's own name for it is "Bank OD A/c" — overdrafts are a liability. */
  "bank_od_account",
  "cash_in_hand",
  "direct_expenses",
  "indirect_expenses",
  "direct_incomes",
  "indirect_incomes",
  "current_assets",
  "current_liabilities",
  "fixed_assets",
  "investments",
  "loans_and_advances_asset",
  "secured_loans",
  "unsecured_loans",
  "capital_account",
  "reserves_and_surplus",
  "provisions",
  /** ⚠️ Where Tally puts what it cannot place. A mapping landing here is a bug. */
  "suspense_account",
]);

/**
 * WHAT ONE OF OUR THINGS A MAPPING POINTS AT.
 *
 * ⚠️ FOUR KINDS AND NOT ONE, BECAUSE THE THINGS BEING MAPPED ARE NOT THE
 * SAME KIND OF THING. A chart-of-accounts ledger is ours and has an id. A
 * vendor is a party and gets bill-wise details in Tally. A tax head has
 * no row anywhere — "output CGST" is a concept, not a record — so it is
 * keyed by a stable string instead.
 */
export const tallyMappingSourceEnum = pgEnum("tally_mapping_source", [
  /** A row in `ledgers` — our chart of accounts. */
  "ledger",
  /** A row in `vendors` (Phase 33). Becomes a Sundry Creditor. */
  "vendor",
  /** A row in `gst_parties` (Phase 32) on the customer side. Sundry Debtor. */
  "customer",
  /**
   * ⭐ A CONCEPT, KEYED BY STRING. `output_cgst`, `input_igst`,
   * `tds_194c_payable`, `round_off`. No row in this database is "the CGST
   * account" — the tax is a column on an invoice — but Tally needs a
   * named ledger to post it to.
   */
  "tax_head",
]);

/* ------------------------------------------------------------------ */
/* ENUMS — THE EXPORT                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `generated` AND `delivered` ARE DIFFERENT STATES AND THE GAP BETWEEN
 * THEM IS WHERE THE DOUBLE POST LIVES.
 *
 * A batch that was generated and never imported must not stop the period
 * being exported again; a batch that WAS imported must make the next
 * export an ALTER rather than a CREATE. `delivered_at` is what
 * distinguishes them, and it is set by the person confirming the import
 * or by a successful push — never by generating a file.
 *
 * `superseded` is set when a later batch covers the same period. The old
 * one stays: it is the evidence of what was sent, and the accountant's
 * question is always "which file did I import?".
 */
export const tallyExportStatusEnum = pgEnum("tally_export_status", [
  "draft",
  "generated",
  "delivered",
  "failed",
  "superseded",
]);

/**
 * ⭐ HOW THE XML GOT THERE.
 *
 * `file` — downloaded and imported by a person. The normal case.
 * `http_push` — POSTed straight into a running Tally. See
 *   `server/tally/push.ts` for why this is the constrained one.
 */
export const tallyDeliveryModeEnum = pgEnum("tally_delivery_mode", [
  "file",
  "http_push",
]);

export const tallyImportStatusEnum = pgEnum("tally_import_status", [
  "received",
  "parsed",
  "reconciled",
  "failed",
]);

/**
 * ⭐ WHAT THE RECONCILIATION FOUND.
 *
 * ⚠️ `missing_in_tally` AND `missing_in_ours` ARE NOT SYMMETRIC AND MUST
 * NEVER BE COLLAPSED INTO ONE "mismatch".
 *
 *   `missing_in_tally` — we exported it and their books do not have it.
 *     Either the file was never imported, or it was imported into the
 *     wrong company. Actionable by us.
 *   `missing_in_ours` — their books have a voucher we never sent. This is
 *     the NORMAL case, not an error: the accountant posts depreciation,
 *     year-end provisions and audit adjustments directly in Tally, and
 *     those must never be pulled back in. Flagging them as errors trains
 *     everybody to ignore the report.
 *   `amount_differs` — ⭐ the dangerous one. Same voucher, different
 *     figure. Somebody edited it on one side.
 */
export const tallyDiffKindEnum = pgEnum("tally_diff_kind", [
  "missing_in_tally",
  "missing_in_ours",
  "amount_differs",
  "date_differs",
  "party_differs",
  "voucher_type_differs",
  /** ⭐ Two of their vouchers carry one REMOTEID. The double post, found. */
  "duplicate_in_tally",
]);

export const tallyDiffStatusEnum = pgEnum("tally_diff_status", [
  "open",
  /** A person has looked and it is expected — a year-end journal, say. */
  "explained",
  /** Fixed on one side or the other; kept as the record that it was. */
  "resolved",
]);

/* ------------------------------------------------------------------ */
/* CONNECTIONS                                                         */
/* ------------------------------------------------------------------ */

/**
 * A configured Tally instance.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE SSRF TENSION, WRITTEN DOWN RATHER THAN QUIETLY RESOLVED
 * ══════════════════════════════════════════════════════════════════════
 * `lib/workflows/http-policy.ts` (Phase 23) blocks every private address:
 * loopback, RFC1918, link-local, the cloud metadata service. It exists
 * because "call an external service" is a text box in which a tenant
 * administrator types a URL that OUR SERVER fetches from INSIDE our
 * network.
 *
 * ⚠️ AND TALLY IS ALWAYS AT A PRIVATE ADDRESS. It runs on a desktop, on
 * localhost or on 192.168.x.x. The policy that makes workflows safe
 * forbids, by design, the exact address this feature needs.
 *
 * The wrong resolutions, both of which have shipped in real products:
 *   ✗ Turn the policy off for this call. One flag, and the SSRF hole is
 *     back — reachable by any tenant admin, aimed anywhere, including
 *     169.254.169.254.
 *   ✗ Allow "any private address". Same hole with extra steps: the
 *     metadata service IS a private address.
 *
 * ⭐ WHAT IS DONE INSTEAD: the private address is allowed only when it is
 * THIS ROW'S `host`, only when `allow_private_host` was deliberately
 * turned on, and only from a narrow list of ranges that a Tally desktop
 * can genuinely be on — loopback and RFC1918. `lib/tally/endpoint.ts`
 * refuses link-local (169.254/16, the metadata service), 0.0.0.0/8,
 * carrier-grade NAT and multicast EVEN WHEN the flag is set, because no
 * Tally has ever been on one and that is where the attack goes.
 *
 * ⚠️ AND IT IS STILL AN ADMIN-ONLY, AUDITED, PER-WORKSPACE OPT-IN, not a
 * default. A hosted deployment has no LAN worth reaching and should never
 * turn it on; the flag exists for the on-premise and VPN cases, which are
 * real and are most of this market.
 */
export const tallyConnections = pgTable(
  "tally_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** What a person calls it: "Accounts room desktop". */
    name: varchar("name", { length: 120 }).notNull(),

    /**
     * ⭐ THE COMPANY NAME AS TYPED INTO TALLY, EXACTLY.
     *
     * ⚠️ THIS IS THE FIELD THAT LOSES A MONTH. Tally's import goes into
     * whichever company is CURRENTLY OPEN unless the envelope names one
     * in `<SVCURRENTCOMPANY>`. A firm running "Ordence Pvt Ltd" and
     * "Ordence Pvt Ltd (2023-24)" side by side will import last
     * year's file into this year's company without a word of complaint,
     * and the only symptom is a turnover figure nobody can tie out.
     *
     * Free text, because it is free text in Tally, and it must match
     * character for character including the "(" and the year.
     */
    companyName: varchar("company_name", { length: 200 }).notNull(),

    /* --- ⭐ The push target. See the header. ---------------------- */

    /**
     * Hostname or IP of the machine Tally runs on. NULL means this
     * connection is file-only, which is the default and the common case.
     */
    host: varchar("host", { length: 255 }),
    /** Tally's default is 9000 and almost nobody changes it. */
    port: integer("port").default(9000).notNull(),
    /**
     * ⚠️ Tally speaks PLAIN HTTP. It has no TLS and no authentication of
     * any kind — anyone who can reach the port can read the whole company
     * or post a voucher into it. Recorded here so the value is a fact
     * about the deployment rather than an assumption in the code.
     */
    useTls: boolean("use_tls").default(false).notNull(),

    /**
     * ⭐⭐ THE DELIBERATE EXCEPTION. See the header for the whole
     * argument. Off by default; turning it on is an administrator action
     * and is audited.
     */
    allowPrivateHost: boolean("allow_private_host").default(false).notNull(),

    isActive: boolean("is_active").default(true).notNull(),

    /** Evidence of the last push, for the "is it even switched on?" question. */
    lastPushAt: timestamp("last_push_at", { withTimezone: true }),
    lastPushStatus: varchar("last_push_status", { length: 40 }),
    lastPushDetail: text("last_push_detail"),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    namePerTenant: uniqueIndex("tally_connections_name_tenant_unique").on(
      t.tenantId,
      t.name,
    ),
    tenantIdx: index("tally_connections_tenant_idx").on(t.tenantId, t.isActive),

    portSane: check(
      "tally_connections_port_sane",
      sql`${t.port} > 0 AND ${t.port} <= 65535`,
    ),
    /**
     * ⭐ A PRIVATE-HOST EXCEPTION WITH NO HOST IS A FLAG NOBODY CAN
     * DEFEND. It reads as "this workspace may reach internal addresses"
     * and names none — which is the shape a permissive default takes just
     * before somebody widens it.
     */
    privateHostIsNamed: check(
      "tally_connections_private_host_is_named",
      sql`(NOT ${t.allowPrivateHost}) OR ${t.host} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ LEDGER MASTER MAPPING                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ OUR ACCOUNT ↔ THEIR LEDGER NAME. Explicit, stored, never guessed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY A GUESS AT EXPORT TIME IS WORSE THAN A REFUSAL
 * ══════════════════════════════════════════════════════════════════════
 * The tempting implementation is to send our own account name and let
 * Tally match it. Tally's behaviour when it does not match is not an
 * error — it CREATES the ledger, under whatever group the voucher context
 * implies, and posts to it. So:
 *
 *     Our "Sales — Residential Units" arrives at a firm whose ledger is
 *     called "Sales A/c". Tally creates "Sales — Residential Units" under
 *     Sales Accounts. The import reports success. The P&L now has two
 *     sales lines, the older reports still point at the old one, and the
 *     accountant discovers it while preparing the audit file.
 *
 * And the em dash makes it worse: the same account exported from a
 * machine with a different locale can arrive as "Sales - Residential
 * Units", creating a THIRD ledger.
 *
 * ⭐ SO AN UNMAPPED ACCOUNT IS A REFUSAL. `lib/tally/ledgers.ts` throws
 * `UnmappedLedgerError` naming the account, and the export does not
 * generate. A file that will not generate is a ten-minute conversation. A
 * file that generates and quietly forks the chart of accounts is a
 * year-end.
 */
export const tallyLedgerMappings = pgTable(
  "tally_ledger_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    sourceKind: tallyMappingSourceEnum("source_kind").notNull(),

    /**
     * The row this maps. NULL for `tax_head`, which has no row.
     * ⚠️ Composite FK to `ledgers (id, tenant_id)` in SQL 0026 §4 — but
     * only for `source_kind = 'ledger'`, so it is enforced by trigger
     * rather than by a foreign key. See the note on `sourceKey`.
     */
    sourceId: uuid("source_id"),

    /**
     * ⭐ The stable string key for a `tax_head`: `output_cgst`,
     * `input_igst`, `tds_194c_payable`, `round_off`.
     *
     * ⚠️ IT IS A KEY, NOT A LABEL. Renaming it orphans every voucher
     * builder that asks for it, which is why `lib/tally/ledgers.ts`
     * defines the permitted set as a constant and the validator refuses
     * anything else. A free-text tax head would be a second, unchecked
     * chart of accounts.
     */
    sourceKey: varchar("source_key", { length: 60 }),

    /** ⚠️ Free text in Tally, and therefore free text here. Exactly as typed. */
    tallyLedgerName: varchar("tally_ledger_name", { length: 200 }).notNull(),
    tallyParentGroup: tallyLedgerGroupEnum("tally_parent_group").notNull(),

    /**
     * ⭐ A PARTY LEDGER GETS BILL-WISE DETAILS AND A GSTIN; A NOMINAL ONE
     * MUST NOT.
     *
     * ⚠️ Sending `<BILLALLOCATIONS.LIST>` on a Sales ledger is one of the
     * ways Tally rejects a whole file, and omitting it on a Sundry Debtor
     * leaves the outstanding un-aged — the party's balance is right and
     * the receivables ageing, which is what anyone actually looks at, is
     * empty.
     */
    isParty: boolean("is_party").default(false).notNull(),

    /**
     * The party's GSTIN, written to the ledger master so Tally's own GST
     * reports reconcile. NULL for nominal ledgers and unregistered parties.
     */
    partyGstin: varchar("party_gstin", { length: 15 }),
    /** Two digits. Tally stores the state on the party ledger master. */
    partyStateCode: varchar("party_state_code", { length: 2 }),

    /**
     * ⚠️ WHETHER TO SEND THE LEDGER MASTER AT ALL.
     *
     * When the ledger already exists in Tally — which for a firm with ten
     * years of books is nearly all of them — sending a master with
     * `ACTION="Create"` is refused and sending one with `ACTION="Alter"`
     * OVERWRITES the accountant's own settings: the group, the opening
     * balance behaviour, the bill-wise flag. Default off. Turning it on
     * is for the first-time setup of a brand-new company.
     */
    createMasterOnExport: boolean("create_master_on_export").default(false).notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⭐ ONE MAPPING PER SOURCE ROW. Two live mappings for one account
     * would mean the Tally ledger a voucher posts to is decided by a sort
     * order — and both would look correct in the mapping screen.
     */
    sourceRowUnique: uniqueIndex("tally_ledger_mappings_source_row_unique")
      .on(t.tenantId, t.sourceKind, t.sourceId)
      .where(sql`${t.sourceId} IS NOT NULL AND ${t.isActive}`),
    sourceKeyUnique: uniqueIndex("tally_ledger_mappings_source_key_unique")
      .on(t.tenantId, t.sourceKind, t.sourceKey)
      .where(sql`${t.sourceKey} IS NOT NULL AND ${t.isActive}`),

    /**
     * ⚠️ THE OTHER DIRECTION IS ENFORCED IN SQL 0026 §2, ON
     * `lower(tally_ledger_name)`, BECAUSE TALLY MATCHES NAMES
     * CASE-INSENSITIVELY.
     *
     * Two of our accounts mapped to one Tally ledger is not a harmless
     * merge: the reconciliation in `lib/tally/reconcile.ts` can then never
     * attribute a difference to one of them, so the report says "₹4,000
     * out" and cannot say on what. Drizzle cannot express an index on an
     * expression here, so this one is a plain index and the uniqueness
     * lives in the migration.
     */
    ledgerNameIdx: index("tally_ledger_mappings_name_idx").on(
      t.tenantId,
      t.tallyLedgerName,
    ),
    tenantIdx: index("tally_ledger_mappings_tenant_idx").on(t.tenantId, t.sourceKind),

    /**
     * ⭐ EXACTLY ONE OF `source_id` AND `source_key`. A mapping with
     * neither points at nothing; one with both has two identities and the
     * lookup would find it under one and miss it under the other.
     */
    identityIsSingular: check(
      "tally_ledger_mappings_identity_is_singular",
      sql`(${t.sourceId} IS NOT NULL AND ${t.sourceKey} IS NULL)
          OR (${t.sourceId} IS NULL AND ${t.sourceKey} IS NOT NULL)`,
    ),
    /** ⚠️ `tax_head` has no row; everything else must have one. */
    kindMatchesIdentity: check(
      "tally_ledger_mappings_kind_matches_identity",
      sql`(${t.sourceKind} = 'tax_head' AND ${t.sourceKey} IS NOT NULL)
          OR (${t.sourceKind} <> 'tax_head' AND ${t.sourceId} IS NOT NULL)`,
    ),
    /**
     * ⚠️ A LEDGER NAME OF SPACES IS A LEDGER TALLY WILL CREATE AND NOBODY
     * WILL EVER FIND. `btrim` rather than `<> ''`, because "  " passes the
     * naive check and is the value a copy-paste actually produces.
     */
    nameNotBlank: check(
      "tally_ledger_mappings_name_not_blank",
      sql`btrim(${t.tallyLedgerName}) <> ''`,
    ),
    gstinShape: check(
      "tally_ledger_mappings_gstin_shape",
      sql`${t.partyGstin} IS NULL
          OR ${t.partyGstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
    /**
     * ⚠️ A GSTIN ON A NOMINAL LEDGER IS A GSTIN THAT WILL NEVER BE
     * REPORTED. Tally reads the party GSTIN off the PARTY ledger; on a
     * Sales ledger it is inert, and its presence there means somebody
     * mapped a customer to a nominal account.
     */
    gstinOnlyOnParty: check(
      "tally_ledger_mappings_gstin_only_on_party",
      sql`${t.partyGstin} IS NULL OR ${t.isParty}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ COST CENTRES — PER-PROJECT P&L                                    */
/* ------------------------------------------------------------------ */

/**
 * Our project ↔ Tally's cost centre.
 *
 * ⚠️ THIS IS THE FEATURE THE DEVELOPER ACTUALLY WANTS AND THE ONE THEY
 * NEVER GET. A builder running four towers has one Tally company and one
 * P&L. "How did Basaveshwar Heights do on its own?" is unanswerable from
 * it — the cement is one purchase ledger, the labour is one contractor
 * ledger, and the split exists only in the site engineer's head.
 *
 * Tally answers it with cost centres, and cost centres are per-LEDGER-
 * ENTRY, not per-voucher: one purchase invoice can be allocated across
 * three projects. `tally_vouchers.entries[].costCentres` carries that.
 *
 * ⚠️ AND THE ALLOCATION MUST TOTAL THE ENTRY. Tally accepts a partial
 * allocation and reports the remainder as "unallocated" in a report
 * nobody opens — so the project P&Ls each look plausible and none of them
 * add up to the company. `lib/tally/vouchers.ts` refuses a partial
 * allocation before the voucher is written.
 */
export const tallyCostCentreMappings = pgTable(
  "tally_cost_centre_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → projects (id, tenant_id) in SQL 0026 §4. */
    projectId: uuid("project_id").notNull(),

    tallyCostCentreName: varchar("tally_cost_centre_name", { length: 200 }).notNull(),
    /**
     * Tally groups cost centres under a CATEGORY. "Primary Cost Category"
     * is the default and is what almost every company uses; naming a
     * category that does not exist creates one, with the same silent-fork
     * problem as a ledger name.
     */
    tallyCostCategory: varchar("tally_cost_category", { length: 200 })
      .default("Primary Cost Category")
      .notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectUnique: uniqueIndex("tally_cost_centre_project_unique")
      .on(t.tenantId, t.projectId)
      .where(sql`${t.isActive}`),
    tenantIdx: index("tally_cost_centre_tenant_idx").on(t.tenantId, t.isActive),
    nameNotBlank: check(
      "tally_cost_centre_name_not_blank",
      sql`btrim(${t.tallyCostCentreName}) <> ''
          AND btrim(${t.tallyCostCategory}) <> ''`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ EXPORT BATCHES                                                    */
/* ------------------------------------------------------------------ */

/**
 * One generated file, or one push.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE PERIOD AND THE HASH ARE BOTH ON THE ROW
 * ══════════════════════════════════════════════════════════════════════
 * The question an accountant asks three weeks later is never "what did
 * you export" — it is "IS THE FILE I AM HOLDING THE ONE THE SYSTEM
 * THINKS IT SENT?". A downloads folder with `tally-april.xml`,
 * `tally-april (1).xml` and `tally-april-final.xml` in it is the normal
 * state of the world.
 *
 * `payload_hash` answers it: hash the file, compare. Anything else —
 * timestamps, sizes, filenames — is a guess.
 *
 * ⚠️ AND THE BATCH TOTALS MUST BALANCE, WHICH IS A STRONGER CLAIM THAN
 * "each voucher balances". Tally imports voucher by voucher and a batch
 * whose vouchers individually balance always balances in total — so a
 * batch total that does NOT balance means a voucher was written to this
 * table without going through the builder. The CHECK is cheap and it
 * catches exactly that.
 */
export const tallyExportBatches = pgTable(
  "tally_export_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tally_connections (id, tenant_id). NULL for file-only. */
    connectionId: uuid("connection_id"),

    /** "TALLY/2026-04/001". Human-facing, unique per workspace. */
    batchNumber: varchar("batch_number", { length: 60 }).notNull(),

    /** ⭐ INCLUSIVE BOTH ENDS. The period the vouchers were selected for. */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),

    /** Which voucher types were included. A subset is legitimate and common. */
    voucherTypes: jsonb("voucher_types")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    status: tallyExportStatusEnum("status").default("draft").notNull(),
    deliveryMode: tallyDeliveryModeEnum("delivery_mode").default("file").notNull(),

    /** The company name the envelope was stamped with. See `tallyConnections`. */
    companyName: varchar("company_name", { length: 200 }).notNull(),

    voucherCount: integer("voucher_count").default(0).notNull(),
    masterCount: integer("master_count").default(0).notNull(),

    /** ⭐ Paise. Equal by construction; the CHECK proves it. */
    totalDebitMinor: bigint("total_debit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalCreditMinor: bigint("total_credit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** ⭐ SHA-256 of the exact bytes generated. Lower-case hex. */
    payloadHash: varchar("payload_hash", { length: 64 }),
    payloadBytes: integer("payload_bytes"),

    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /**
     * ⭐ SET WHEN TALLY HAS ACTUALLY TAKEN IT. Until then every voucher in
     * the batch is still a CREATE; afterwards the same source rows export
     * as ALTER against the same REMOTEID. See `lib/tally/keys.ts`.
     */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredBy: uuid("delivered_by"),

    /**
     * ⚠️ TALLY'S OWN RESPONSE, KEPT VERBATIM. Its import response is an
     * `<ENVELOPE>` carrying CREATED, ALTERED, IGNORED, ERRORS and
     * LASTVCHID counts, and "ERRORS 0 / CREATED 0" is a perfectly
     * successful-looking response that imported nothing. The numbers are
     * the only way to tell, and paraphrasing them loses it.
     */
    responsePayload: text("response_payload"),
    responseCreated: integer("response_created"),
    responseAltered: integer("response_altered"),
    responseIgnored: integer("response_ignored"),
    responseErrors: integer("response_errors"),

    failureReason: text("failure_reason"),

    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    batchNumberUnique: uniqueIndex("tally_export_batches_number_unique").on(
      t.tenantId,
      t.batchNumber,
    ),
    /** The "what have we sent for April?" query. */
    periodIdx: index("tally_export_batches_period_idx").on(
      t.tenantId,
      t.periodStart,
      t.periodEnd,
    ),
    statusIdx: index("tally_export_batches_status_idx").on(t.tenantId, t.status),
    hashIdx: index("tally_export_batches_hash_idx").on(t.tenantId, t.payloadHash),

    periodSane: check(
      "tally_export_batches_period_sane",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    nonNegative: check(
      "tally_export_batches_non_negative",
      sql`${t.voucherCount} >= 0 AND ${t.masterCount} >= 0
          AND ${t.totalDebitMinor} >= 0 AND ${t.totalCreditMinor} >= 0`,
    ),
    /** ⭐⭐ THE BATCH BALANCES. See the header. */
    batchBalances: check(
      "tally_export_batches_balances",
      sql`${t.totalDebitMinor} = ${t.totalCreditMinor}`,
    ),
    /**
     * ⚠️ A GENERATED BATCH HAS A HASH. Without one there is nothing to
     * compare the file in the downloads folder against, and "which file
     * did I import?" becomes unanswerable at exactly the moment it
     * matters.
     */
    generatedIsHashed: check(
      "tally_export_batches_generated_is_hashed",
      sql`${t.status} NOT IN ('generated','delivered')
          OR (${t.payloadHash} IS NOT NULL AND ${t.generatedAt} IS NOT NULL)`,
    ),
    hashShape: check(
      "tally_export_batches_hash_shape",
      sql`${t.payloadHash} IS NULL OR ${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    /** A delivered batch records WHEN. That timestamp is what flips CREATE to ALTER. */
    deliveredIsDated: check(
      "tally_export_batches_delivered_is_dated",
      sql`${t.status} <> 'delivered' OR ${t.deliveredAt} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐⭐ VOUCHERS — THE DETERMINISTIC KEY LIVES HERE                     */
/* ------------------------------------------------------------------ */

/**
 * One voucher, as it was sent.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ `remote_id` IS THE POINT OF THE WHOLE PHASE
 * ══════════════════════════════════════════════════════════════════════
 * Tally de-duplicates on REMOTEID and on nothing else. Same REMOTEID +
 * `ACTION="Alter"` updates in place; a different REMOTEID for the same
 * economic event adds a second voucher and doubles the books.
 *
 * ⚠️ SO THE KEY IS DERIVED FROM THE SOURCE ROW AND NOTHING ELSE.
 * `lib/tally/keys.ts` hashes (tenant, voucher type, source type, source
 * id). It does NOT hash the date, the amount, the narration, the batch or
 * the time — because a voucher that gets corrected must keep the key of
 * the voucher it corrects, and a key that moves when the amount moves is
 * a key that guarantees a duplicate on every correction.
 *
 * ⭐ AND SQL 0026 §6 REFUSES A SECOND, DIFFERENT KEY FOR A SOURCE ROW
 * THAT HAS ALREADY BEEN EXPORTED. That is the guarantee, at the database,
 * because the export path is not the only write path — a re-generation
 * after a code change is the one that will get it wrong, and it will get
 * it wrong quietly.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE SIGN CONVENTION, WHICH IS TALLY'S AND NOT OURS
 * ══════════════════════════════════════════════════════════════════════
 * In `<ALLLEDGERENTRIES.LIST>` Tally writes a DEBIT as a NEGATIVE
 * `<AMOUNT>` with `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>`, and a
 * CREDIT as a positive amount with `No`. Getting it backwards produces a
 * voucher that imports cleanly and posts every entry the wrong way round.
 * The stored columns here are unsigned paise and carry the direction in
 * `entries[].isDebit`; the conversion happens once, in
 * `lib/tally/vouchers.ts`.
 */
export const tallyVouchers = pgTable(
  "tally_vouchers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tally_export_batches (id, tenant_id). CASCADE. */
    batchId: uuid("batch_id").notNull(),

    voucherType: tallyVoucherTypeEnum("voucher_type").notNull(),

    /** ⭐⭐ THE DETERMINISTIC KEY. See the header. */
    remoteId: varchar("remote_id", { length: 64 }).notNull(),

    /**
     * Tally's own alter-key, returned by Tally after an import. NULL until
     * we have seen it. ⚠️ It is THEIRS, not ours — it changes if the
     * company is split or re-created, which is precisely why REMOTEID and
     * not this is what we key on.
     */
    voucherKey: varchar("voucher_key", { length: 80 }),

    /** The number printed on the document. Ours. */
    voucherNumber: varchar("voucher_number", { length: 64 }),
    voucherDate: date("voucher_date", { mode: "string" }).notNull(),

    /* --- Where it came from. Polymorphic by design. --------------- */

    /** `purchase_invoice`, `gst_invoice`, `transaction`, `tds_challan`, … */
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceId: uuid("source_id").notNull(),

    /* --- ⭐ GST, so Tally's own reports reconcile ------------------ */

    partyLedgerName: varchar("party_ledger_name", { length: 200 }),
    partyGstin: varchar("party_gstin", { length: 15 }),
    /**
     * ⭐ TWO DIGITS, AND IT IS NOT THE PARTY'S STATE.
     *
     * ⚠️ Section 12(3) of the IGST Act makes the place of supply for
     * anything relating to IMMOVABLE PROPERTY the state the PROPERTY is
     * in. A Bengaluru buyer purchasing a Pune flat is an intra-state
     * supply in Maharashtra — CGST+SGST, not IGST — and a Tally export
     * that sends the buyer's state produces a GSTR-1 in Tally that
     * disagrees with the one filed from this product. Phase 32 already
     * decided this per invoice; it is COPIED here, never re-derived.
     */
    placeOfSupplyCode: varchar("place_of_supply_code", { length: 2 }),
    /** "Sale of goods" / "Sale of services", written to Tally's GST fields. */
    gstRegistrationType: varchar("gst_registration_type", { length: 24 }),

    narration: text("narration"),
    /** The reference and its date — Tally's `<REFERENCE>` / `<REFERENCEDATE>`. */
    reference: varchar("reference", { length: 120 }),
    referenceDate: date("reference_date", { mode: "string" }),

    /* --- The money -------------------------------------------------- */

    totalDebitMinor: bigint("total_debit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalCreditMinor: bigint("total_credit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /**
     * ⭐ THE LEDGER ENTRIES, EXACTLY AS SENT.
     *
     * ⚠️ STORED, NOT REGENERATED. "What did we send Tally in April?" must
     * be answerable after the invoice has been amended, the mapping has
     * been re-pointed and the rate has changed — none of which restate
     * this row. A regenerated answer would be a description of today's
     * data wearing April's date.
     *
     * Amounts are DECIMAL STRINGS OF PAISE, because `JSON.stringify`
     * throws on a bigint and a `number` loses precision above 2^53.
     */
    entries: jsonb("entries")
      .$type<
        Array<{
          ledgerName: string;
          isDebit: boolean;
          /** Paise, as a decimal string. Unsigned. */
          amountMinor: string;
          costCentres?: Array<{
            category: string;
            name: string;
            amountMinor: string;
          }>;
          billAllocations?: Array<{
            name: string;
            billType: "New Ref" | "Agst Ref" | "Advance" | "On Account";
            amountMinor: string;
          }>;
          /** ⭐ HSN/SAC and rate, for the GST lines Tally reports on. */
          hsnSac?: string;
          gstRateBps?: number;
        }>
      >()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /**
     * ⭐ SHA-256 OF THE VOUCHER'S CONTENT, EXCLUDING THE KEY.
     *
     * This is what makes a re-export cheap and honest: same remote id and
     * same content hash means nothing changed and the voucher can be sent
     * as an idempotent ALTER; same remote id and a DIFFERENT content hash
     * means somebody amended the source, and the accountant is told which
     * vouchers actually moved rather than being handed a file of two
     * thousand unchanged ones.
     */
    contentHash: varchar("content_hash", { length: 64 }).notNull(),

    /**
     * ⚠️ Tally keeps CANCELLED vouchers, numbered and empty, so the
     * number series has no holes. Deleting instead of cancelling is what
     * makes an audit trail unusable.
     */
    isCancelled: boolean("is_cancelled").default(false).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⭐ ONE ROW PER REMOTE ID PER BATCH. Two would be the same voucher
     * twice in one file — which Tally resolves by importing the last one,
     * silently, so the file is "successful" and the figure is whichever
     * copy happened to be last.
     */
    batchRemoteUnique: uniqueIndex("tally_vouchers_batch_remote_unique").on(
      t.tenantId,
      t.batchId,
      t.remoteId,
    ),
    /**
     * ⭐⭐ THE INDEX THE ANTI-DUPLICATION GUARD LIVES ON. "Has this source
     * row been exported before, and under what key?" is the question SQL
     * 0026 §6 asks on every insert.
     */
    remoteIdIdx: index("tally_vouchers_remote_idx").on(t.tenantId, t.remoteId),
    sourceIdx: index("tally_vouchers_source_idx").on(
      t.tenantId,
      t.sourceType,
      t.sourceId,
      t.voucherType,
    ),
    batchIdx: index("tally_vouchers_batch_idx").on(t.tenantId, t.batchId),
    dateIdx: index("tally_vouchers_date_idx").on(t.tenantId, t.voucherDate),

    nonNegative: check(
      "tally_vouchers_non_negative",
      sql`${t.totalDebitMinor} >= 0 AND ${t.totalCreditMinor} >= 0`,
    ),
    /**
     * ⭐⭐ EVERY VOUCHER BALANCES, AT THE DATABASE.
     *
     * ⚠️ AN UNBALANCED VOUCHER IS REJECTED BY TALLY AFTER THE ACCOUNTANT
     * HAS SPENT AN HOUR ON THE IMPORT, and the message names a voucher
     * number in a file of two thousand. The builder asserts it, the
     * database refuses it, and the test proves it — three layers, because
     * the builder is not the only write path and an import of historical
     * vouchers is the one that will be wrong.
     */
    voucherBalances: check(
      "tally_vouchers_balances",
      sql`${t.totalDebitMinor} = ${t.totalCreditMinor}`,
    ),
    /**
     * ⚠️ A VOUCHER OF ZERO IS NOT A VOUCHER. It balances trivially, passes
     * every other check, imports successfully and does nothing — so a bug
     * that drops every leg produces a file that reports two thousand
     * vouchers created and moves no money at all. A CANCELLED voucher is
     * the one legitimate zero.
     */
    nonZeroUnlessCancelled: check(
      "tally_vouchers_non_zero_unless_cancelled",
      sql`${t.isCancelled} OR ${t.totalDebitMinor} > 0`,
    ),
    hashShape: check(
      "tally_vouchers_hash_shape",
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    /**
     * ⭐⭐ THE KEY HAS A SHAPE, AND THE SHAPE IS A CONTRACT.
     *
     * `lib/tally/keys.ts` emits `AHOS-<8>-<8>-<24>` hex. Checking it here
     * is not paranoia about typos — it is what stops a future write path
     * from stamping a `randomUUID()` on a voucher. A random key is
     * perfectly unique, imports perfectly, and produces a duplicate on
     * every single re-export, which is the failure this whole phase is
     * built to prevent. A UUID does not match this pattern.
     */
    remoteIdShape: check(
      "tally_vouchers_remote_id_shape",
      sql`${t.remoteId} ~ '^AHOS-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{24}$'`,
    ),
    gstinShape: check(
      "tally_vouchers_gstin_shape",
      sql`${t.partyGstin} IS NULL
          OR ${t.partyGstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
    posShape: check(
      "tally_vouchers_pos_shape",
      sql`${t.placeOfSupplyCode} IS NULL OR ${t.placeOfSupplyCode} ~ '^[0-9]{2}$'`,
    ),
    /**
     * ⚠️ A CONTRA WITH A PARTY IS A CONTRA TALLY REJECTS. Contra is
     * cash/bank to cash/bank by definition, and Tally enforces it — the
     * rejection arrives as a failed import, not as a field error.
     */
    contraHasNoParty: check(
      "tally_vouchers_contra_has_no_party",
      sql`${t.voucherType} <> 'contra' OR ${t.partyLedgerName} IS NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ IMPORT BACK FROM TALLY                                            */
/* ------------------------------------------------------------------ */

/**
 * A Tally XML export, read back so our books can be compared with theirs.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS NEVER WRITES TO OUR LEDGER. NOT ONCE, NOT WITH A FLAG.
 * ══════════════════════════════════════════════════════════════════════
 * The obvious next feature is "sync back", and it is the wrong feature.
 *
 *   • Our ledger is APPEND-ONLY and balance-enforced (Phase 4). Their
 *     file is a snapshot of a book that anybody with the Tally password
 *     can edit, including retrospectively, including in a closed period.
 *   • ⭐ The two are not supposed to agree. The accountant posts
 *     depreciation, provisions, prepayment reversals and audit
 *     adjustments directly in Tally, on purpose, and those are THEIR
 *     entries — pulling them in would put entries in our books that no
 *     workspace user made and no source document supports.
 *   • And "overwrite" against an append-only ledger is not implementable
 *     anyway without reversing entries, which is a decision a person
 *     makes.
 *
 * ⭐ SO THE OUTPUT IS A REPORT. `tally_reconciliation_items`, one row per
 * difference, each of which a person reads and decides about.
 *
 * ⚠️ AND THE RAW PAYLOAD IS KEPT VERBATIM, exactly as Phase 34 keeps the
 * GSTR-2B: it is the evidence. A parsed representation is our reading of
 * their file, and when the two disagree the argument is about the bytes.
 */
export const tallyImportBatches = pgTable(
  "tally_import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tally_connections (id, tenant_id). */
    connectionId: uuid("connection_id"),

    /** The filename or the request that produced it. Evidence, not decoration. */
    sourceLabel: varchar("source_label", { length: 255 }).notNull(),
    /** The company name found INSIDE their file — not the one we asked for. */
    companyName: varchar("company_name", { length: 200 }),

    /** The period the comparison covers. Inclusive both ends. */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),

    status: tallyImportStatusEnum("status").default("received").notNull(),

    voucherCount: integer("voucher_count").default(0).notNull(),
    totalDebitMinor: bigint("total_debit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    totalCreditMinor: bigint("total_credit_minor", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),

    /** ⭐ SHA-256 of the raw bytes. Re-importing the same file is a no-op. */
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    payloadBytes: integer("payload_bytes"),
    /** ⚠️ Verbatim. See the header. */
    rawPayload: text("raw_payload"),

    /**
     * ⚠️ WHAT OUR PARSER COULD NOT READ, kept rather than dropped. A
     * reconciliation run over a file we only half understood would report
     * their vouchers as missing, and "missing" is the finding that starts
     * a phone call to the accountant.
     */
    parseWarnings: jsonb("parse_warnings")
      .$type<Array<{ code: string; message: string; detail?: string }>>()
      .default(sql`'[]'::jsonb`)
      .notNull(),

    /* --- Roll-up of the diff, so a list page needs no aggregate. --- */
    differenceCount: integer("difference_count").default(0).notNull(),
    unresolvedCount: integer("unresolved_count").default(0).notNull(),

    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: uuid("created_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * ⭐ ONE ROW PER FILE PER WORKSPACE. The same export imported twice
     * would double every "missing in ours" finding and make the worklist
     * look twice as bad as it is — which is how a reconciliation report
     * stops being read.
     */
    payloadUnique: uniqueIndex("tally_import_batches_payload_unique").on(
      t.tenantId,
      t.payloadHash,
    ),
    periodIdx: index("tally_import_batches_period_idx").on(
      t.tenantId,
      t.periodStart,
      t.periodEnd,
    ),
    statusIdx: index("tally_import_batches_status_idx").on(t.tenantId, t.status),

    periodSane: check(
      "tally_import_batches_period_sane",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    hashShape: check(
      "tally_import_batches_hash_shape",
      sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    nonNegative: check(
      "tally_import_batches_non_negative",
      sql`${t.voucherCount} >= 0 AND ${t.differenceCount} >= 0
          AND ${t.unresolvedCount} >= 0
          AND ${t.totalDebitMinor} >= 0 AND ${t.totalCreditMinor} >= 0`,
    ),
    /** ⚠️ Unresolved is a subset of the differences, never more. */
    unresolvedBounded: check(
      "tally_import_batches_unresolved_bounded",
      sql`${t.unresolvedCount} <= ${t.differenceCount}`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* ⭐ THE DIFF                                                          */
/* ------------------------------------------------------------------ */

/**
 * One difference between our books and theirs.
 *
 * ⚠️ BOTH SIDES ARE ON THE ROW, INCLUDING WHEN ONE OF THEM IS EMPTY.
 * "Voucher AH/2026/0041 — ₹1,18,000 here, ₹1,18,500 there" is a finding
 * somebody can act on in ten seconds. "Voucher AH/2026/0041 does not
 * match" sends them to two screens and a calculator, and the second
 * version is what a diff produces when it stores only the verdict.
 */
export const tallyReconciliationItems = pgTable(
  "tally_reconciliation_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    /** Composite FK → tally_import_batches (id, tenant_id). CASCADE. */
    importBatchId: uuid("import_batch_id").notNull(),

    kind: tallyDiffKindEnum("kind").notNull(),
    status: tallyDiffStatusEnum("status").default("open").notNull(),

    /** ⭐ The key that ties the two sides together, when there is one. */
    remoteId: varchar("remote_id", { length: 64 }),

    /** Composite FK → tally_vouchers (id, tenant_id). NULL for `missing_in_ours`. */
    ourVoucherId: uuid("our_voucher_id"),

    /* --- Our side ------------------------------------------------- */
    ourVoucherNumber: varchar("our_voucher_number", { length: 64 }),
    ourVoucherDate: date("our_voucher_date", { mode: "string" }),
    ourVoucherType: varchar("our_voucher_type", { length: 24 }),
    ourAmountMinor: bigint("our_amount_minor", { mode: "bigint" }),
    ourPartyLedgerName: varchar("our_party_ledger_name", { length: 200 }),

    /* --- Their side ----------------------------------------------- */
    theirVoucherNumber: varchar("their_voucher_number", { length: 64 }),
    theirVoucherDate: date("their_voucher_date", { mode: "string" }),
    theirVoucherType: varchar("their_voucher_type", { length: 64 }),
    theirAmountMinor: bigint("their_amount_minor", { mode: "bigint" }),
    theirPartyLedgerName: varchar("their_party_ledger_name", { length: 200 }),

    /**
     * ⭐ THE SENTENCE. Written by `lib/tally/reconcile.ts`, stored on the
     * row. "₹500 more in Tally than here" is what a person reads; a kind
     * and two numbers is what they would otherwise have to assemble.
     */
    explanation: text("explanation").notNull(),

    /** What a person decided, and why. Kept even after `resolved`. */
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    batchIdx: index("tally_reconciliation_batch_idx").on(
      t.tenantId,
      t.importBatchId,
      t.kind,
    ),
    /** The worklist: what is still open, oldest first. */
    openIdx: index("tally_reconciliation_open_idx")
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.status} = 'open'`),
    voucherIdx: index("tally_reconciliation_voucher_idx").on(
      t.tenantId,
      t.ourVoucherId,
    ),

    /**
     * ⭐ A DIFFERENCE MUST HAVE A SIDE. `missing_in_tally` has ours,
     * `missing_in_ours` has theirs, everything else has both. A row with
     * neither is a finding about nothing, and it would still be counted
     * in `difference_count`.
     */
    hasASide: check(
      "tally_reconciliation_has_a_side",
      sql`${t.ourVoucherId} IS NOT NULL
          OR ${t.ourVoucherNumber} IS NOT NULL
          OR ${t.theirVoucherNumber} IS NOT NULL
          OR ${t.remoteId} IS NOT NULL`,
    ),
    /**
     * ⚠️ `missing_in_ours` MUST NOT NAME ONE OF OUR VOUCHERS. If it does,
     * the match failed and the row is mislabelled — and a mislabelled
     * "they have something we do not" is exactly the finding that gets
     * somebody to post a duplicate journal by hand.
     */
    missingInOursHasNoOurs: check(
      "tally_reconciliation_missing_in_ours_has_no_ours",
      sql`${t.kind} <> 'missing_in_ours' OR ${t.ourVoucherId} IS NULL`,
    ),
    /** The mirror. A voucher missing from Tally cannot carry their figure. */
    missingInTallyHasNoTheirs: check(
      "tally_reconciliation_missing_in_tally_has_no_theirs",
      sql`${t.kind} <> 'missing_in_tally' OR ${t.theirVoucherNumber} IS NULL`,
    ),
    /**
     * ⭐ AN `amount_differs` WITH EQUAL AMOUNTS IS A BUG IN THE DIFF, and
     * it is the bug that makes a reconciliation report useless: a hundred
     * findings that are not findings, and the four real ones lost in them.
     */
    amountDiffersActuallyDiffers: check(
      "tally_reconciliation_amount_differs_actually_differs",
      sql`${t.kind} <> 'amount_differs'
          OR (${t.ourAmountMinor} IS NOT NULL
              AND ${t.theirAmountMinor} IS NOT NULL
              AND ${t.ourAmountMinor} <> ${t.theirAmountMinor})`,
    ),
    /** A resolved finding records when. Otherwise "resolved" is a claim. */
    resolvedIsDated: check(
      "tally_reconciliation_resolved_is_dated",
      sql`${t.status} <> 'resolved' OR ${t.resolvedAt} IS NOT NULL`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* RELATIONS                                                           */
/* ------------------------------------------------------------------ */

export const tallyConnectionsRelations = relations(
  tallyConnections,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [tallyConnections.tenantId],
      references: [tenants.id],
    }),
    creator: one(users, {
      fields: [tallyConnections.createdBy],
      references: [users.id],
    }),
    exportBatches: many(tallyExportBatches),
    importBatches: many(tallyImportBatches),
  }),
);

export const tallyLedgerMappingsRelations = relations(
  tallyLedgerMappings,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tallyLedgerMappings.tenantId],
      references: [tenants.id],
    }),
    /**
     * ⚠️ ONLY MEANINGFUL WHEN `source_kind = 'ledger'`. The column is
     * polymorphic, so this relation is a navigation convenience and not a
     * constraint — the constraint is the trigger in SQL 0026 §5.
     */
    ledger: one(ledgers, {
      fields: [tallyLedgerMappings.sourceId],
      references: [ledgers.id],
    }),
  }),
);

export const tallyCostCentreMappingsRelations = relations(
  tallyCostCentreMappings,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tallyCostCentreMappings.tenantId],
      references: [tenants.id],
    }),
    project: one(projects, {
      fields: [tallyCostCentreMappings.projectId],
      references: [projects.id],
    }),
  }),
);

export const tallyExportBatchesRelations = relations(
  tallyExportBatches,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [tallyExportBatches.tenantId],
      references: [tenants.id],
    }),
    connection: one(tallyConnections, {
      fields: [tallyExportBatches.connectionId],
      references: [tallyConnections.id],
    }),
    vouchers: many(tallyVouchers),
  }),
);

export const tallyVouchersRelations = relations(tallyVouchers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tallyVouchers.tenantId],
    references: [tenants.id],
  }),
  batch: one(tallyExportBatches, {
    fields: [tallyVouchers.batchId],
    references: [tallyExportBatches.id],
  }),
}));

export const tallyImportBatchesRelations = relations(
  tallyImportBatches,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [tallyImportBatches.tenantId],
      references: [tenants.id],
    }),
    connection: one(tallyConnections, {
      fields: [tallyImportBatches.connectionId],
      references: [tallyConnections.id],
    }),
    items: many(tallyReconciliationItems),
  }),
);

export const tallyReconciliationItemsRelations = relations(
  tallyReconciliationItems,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [tallyReconciliationItems.tenantId],
      references: [tenants.id],
    }),
    importBatch: one(tallyImportBatches, {
      fields: [tallyReconciliationItems.importBatchId],
      references: [tallyImportBatches.id],
    }),
    ourVoucher: one(tallyVouchers, {
      fields: [tallyReconciliationItems.ourVoucherId],
      references: [tallyVouchers.id],
    }),
  }),
);

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type TallyConnection = typeof tallyConnections.$inferSelect;
export type NewTallyConnection = typeof tallyConnections.$inferInsert;
export type TallyLedgerMapping = typeof tallyLedgerMappings.$inferSelect;
export type NewTallyLedgerMapping = typeof tallyLedgerMappings.$inferInsert;
export type TallyCostCentreMapping = typeof tallyCostCentreMappings.$inferSelect;
export type NewTallyCostCentreMapping = typeof tallyCostCentreMappings.$inferInsert;
export type TallyExportBatch = typeof tallyExportBatches.$inferSelect;
export type NewTallyExportBatch = typeof tallyExportBatches.$inferInsert;
export type TallyVoucher = typeof tallyVouchers.$inferSelect;
export type NewTallyVoucher = typeof tallyVouchers.$inferInsert;
export type TallyImportBatch = typeof tallyImportBatches.$inferSelect;
export type NewTallyImportBatch = typeof tallyImportBatches.$inferInsert;
export type TallyReconciliationItem = typeof tallyReconciliationItems.$inferSelect;
export type NewTallyReconciliationItem = typeof tallyReconciliationItems.$inferInsert;

export type TallyVoucherType = (typeof tallyVoucherTypeEnum.enumValues)[number];
export type TallyLedgerGroup = (typeof tallyLedgerGroupEnum.enumValues)[number];
export type TallyMappingSource = (typeof tallyMappingSourceEnum.enumValues)[number];
export type TallyExportStatus = (typeof tallyExportStatusEnum.enumValues)[number];
export type TallyDeliveryMode = (typeof tallyDeliveryModeEnum.enumValues)[number];
export type TallyImportStatus = (typeof tallyImportStatusEnum.enumValues)[number];
export type TallyDiffKind = (typeof tallyDiffKindEnum.enumValues)[number];
export type TallyDiffStatus = (typeof tallyDiffStatusEnum.enumValues)[number];

/** One ledger entry on a voucher, as stored in `tally_vouchers.entries`. */
export type TallyVoucherEntry = TallyVoucher["entries"][number];
