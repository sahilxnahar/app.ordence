-- ============================================================================
-- Ordence — Phase 37: ⭐ Tally Integration
-- Version: v0.37.0-alpha
--
-- Run AFTER `ALL-IN-ONE-SETUP.sql`, `0017_change_log.sql`, `0016_phase22_sales.sql`
-- and `0021_phase32_gst.sql`. It depends on `set_updated_at()`,
-- `app_current_tenant_id()`, `record_change()`, and on the tables `ledgers`,
-- `vendors`, `gst_parties` and `projects`.
--
-- Safe to run before `drizzle-kit push`: Section 1 creates its own types and
-- tables idempotently. Safe to re-run: every statement is guarded.
--
-- Contents:
--   1.  Enums and tables
--   2.  ⭐ ONE TALLY LEDGER NAME PER WORKSPACE — case-insensitively, as Tally
--   3.  Row-level security
--   4.  ⭐ Composite foreign keys — the hole RLS does NOT close
--   5.  ⭐ A MAPPING MUST POINT AT A ROW OF ITS OWN KIND
--   6.  ⭐⭐ THE DETERMINISTIC KEY — a source row may never get a second one
--   7.  ⭐ THE BATCH MUST EQUAL ITS VOUCHERS — deferred, at commit
--   8.  updated_at, and the change log
--   9.  Grants
--   10. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Every phase before this one was about what happens inside this workspace.
-- This one is about what happens when the numbers leave it — and in India they
-- always do, because the statutory books, the audit file and the return the
-- chartered accountant signs are all produced in Tally.
--
-- ⭐⭐ THE HAZARD IS THE DOUBLE POST, AND IT IS UNLIKE EVERY EARLIER PHASE'S.
--
--     April is exported and imported. Somebody notices a ledger was mapped to
--     the wrong name. The mapping is fixed and April is exported again.
--
--     ⚠️ TALLY IMPORTS IT A SECOND TIME. It does not de-duplicate on voucher
--     number, on date, or on amount. Both copies are BALANCED vouchers, so the
--     trial balance still balances, every register still foots, and no report
--     anywhere shows an error. April's revenue is simply twice what it was.
--
--     It is found at the year end, by somebody comparing the GSTR-1 filed from
--     this product against the turnover in the books — which is to say, months
--     later, by an auditor, in the one conversation a software vendor cannot
--     afford to be the subject of.
--
-- The ONLY thing Tally de-duplicates on is `REMOTEID`. Given the same REMOTEID
-- with ACTION="Alter" it UPDATES the voucher instead of adding one. So the
-- REMOTEID is not an implementation detail of an export — it is permanent data
-- about a source row, and Section 6 below refuses to let a source row acquire
-- a second, different one. That refusal IS this phase.
--
-- The other three that are just as quiet:
--
--   • ⚠️ AN UNBALANCED VOUCHER. Tally rejects it part-way through an import,
--     naming a voucher number in a file of two thousand, and on several builds
--     it abandons the rest rather than skipping the one. The accountant is left
--     with an unknown prefix of March in their books.
--   • ⚠️ A LEDGER NAME THAT DOES NOT MATCH. Tally does not fail — it CREATES
--     the ledger, under a group it guesses, and posts to it. Two sales ledgers,
--     ten years of saved reports pointing at the old one, and a successful
--     import.
--   • ⚠️ AN UNESCAPED AMPERSAND. "Shah & Sons" produces XML that is not
--     well-formed. Tally answers with "0 vouchers imported", or — worse —
--     imports everything up to that character and stops.
--
-- None of the four can be caught by looking at the product. So they are caught
-- here:
--
--   • Section 2 — one Tally ledger name per workspace, folded to lower case,
--     because Tally matches names case-insensitively and two of our accounts
--     silently merging into one of theirs makes every later difference
--     unattributable.
--   • Section 5 — a mapping may not point at a row of another kind, or at
--     another tenant's row.
--   • Section 6 — ⭐⭐ a source row that has been exported keeps its key
--     forever.
--   • Section 7 — a batch's stated totals must equal the vouchers in it, and
--     every voucher balances (a table CHECK, in Section 1).
--
-- Money is bigint paise. Rates are integer basis points.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — ENUMS AND TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/tally.ts`. They are restated
-- here because a file that can only run second is a file that fails on a fresh
-- database.

DO $$
BEGIN
  -- ⚠️ Tally's OWN eight types, spelled Tally's way. A `<VOUCHERTYPENAME>` the
  -- company does not have is not rejected — the voucher is filed under a type
  -- Tally invents, where it appears in no standard register.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_voucher_type') THEN
    CREATE TYPE tally_voucher_type AS ENUM
      ('sales','purchase','receipt','payment','journal','contra',
       'credit_note','debit_note');
  END IF;

  -- ⭐ Tally's primary groups. The group decides which side of the balance
  -- sheet a ledger lands on and whether Tally's GST reports look at it at all:
  -- a tax ledger under "Indirect Expenses" produces a GSTR-1 in Tally with no
  -- output tax on it and a balance sheet that balances perfectly.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_ledger_group') THEN
    CREATE TYPE tally_ledger_group AS ENUM
      ('sundry_debtors','sundry_creditors','sales_accounts','purchase_accounts',
       'duties_and_taxes','bank_accounts','bank_od_account','cash_in_hand',
       'direct_expenses','indirect_expenses','direct_incomes','indirect_incomes',
       'current_assets','current_liabilities','fixed_assets','investments',
       'loans_and_advances_asset','secured_loans','unsecured_loans',
       'capital_account','reserves_and_surplus','provisions','suspense_account');
  END IF;

  -- ⚠️ `tax_head` has no row anywhere in this database. "Output CGST" is a
  -- COLUMN on an invoice, not a record — and Tally needs a named ledger to
  -- post it to. Hence a string key rather than an id.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_mapping_source') THEN
    CREATE TYPE tally_mapping_source AS ENUM
      ('ledger','vendor','customer','tax_head');
  END IF;

  -- ⭐ `generated` and `delivered` are different states and the gap between
  -- them is where the double post lives: a file that was generated and never
  -- imported must NOT make the next export an ALTER of vouchers Tally does not
  -- have.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_export_status') THEN
    CREATE TYPE tally_export_status AS ENUM
      ('draft','generated','delivered','failed','superseded');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_delivery_mode') THEN
    CREATE TYPE tally_delivery_mode AS ENUM ('file','http_push');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_import_status') THEN
    CREATE TYPE tally_import_status AS ENUM
      ('received','parsed','reconciled','failed');
  END IF;

  -- ⚠️ `missing_in_tally` and `missing_in_ours` are NOT symmetric and must
  -- never be collapsed into one "mismatch". The second is the NORMAL case —
  -- depreciation, provisions and audit adjustments are posted directly in
  -- Tally on purpose — and flagging them as errors trains everybody to ignore
  -- the report.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_diff_kind') THEN
    CREATE TYPE tally_diff_kind AS ENUM
      ('missing_in_tally','missing_in_ours','amount_differs','date_differs',
       'party_differs','voucher_type_differs','duplicate_in_tally');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tally_diff_status') THEN
    CREATE TYPE tally_diff_status AS ENUM ('open','explained','resolved');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS tally_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                varchar(120) NOT NULL,
  -- ⭐ EXACTLY as typed into Tally, including any "(2023-24)" suffix. Without
  -- it in the envelope the import goes into whichever company is open, and a
  -- firm keeps last year's open beside this year's every April.
  company_name        varchar(200) NOT NULL,
  host                varchar(255),
  port                integer NOT NULL DEFAULT 9000,
  -- ⚠️ Tally has no TLS and no authentication of any kind. Recorded so the
  -- value is a fact about the deployment rather than an assumption in code.
  use_tls             boolean NOT NULL DEFAULT false,
  -- ⭐⭐ THE DELIBERATE SSRF EXCEPTION. Off by default. See
  -- `lib/tally/endpoint.ts` for the whole argument — Tally is only ever at a
  -- private address, and the metadata service is also a private address.
  allow_private_host  boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  last_push_at        timestamptz,
  last_push_status    varchar(40),
  last_push_detail    text,
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tally_connections_port_sane CHECK (port > 0 AND port <= 65535),
  -- ⭐ A private-host exception with no host is a permission nobody can review.
  CONSTRAINT tally_connections_private_host_is_named
    CHECK ((NOT allow_private_host) OR host IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS tally_ledger_mappings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_kind             tally_mapping_source NOT NULL,
  source_id               uuid,
  source_key              varchar(60),
  -- ⚠️ Free text in Tally, therefore free text here, therefore the reason
  -- Section 2 exists.
  tally_ledger_name       varchar(200) NOT NULL,
  tally_parent_group      tally_ledger_group NOT NULL,
  is_party                boolean NOT NULL DEFAULT false,
  party_gstin             varchar(15),
  party_state_code        varchar(2),
  -- ⚠️ OFF BY DEFAULT AND THAT IS NOT TIMIDITY. ACTION="Alter" on an existing
  -- ledger OVERWRITES the accountant's own settings — parent group, bill-wise
  -- flag, credit period. An export that "helpfully" ensures the masters exist
  -- resets all of them every month.
  create_master_on_export boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  notes                   text,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- ⭐ Exactly one identity. Both would mean the lookup finds it under one and
  -- misses it under the other.
  CONSTRAINT tally_ledger_mappings_identity_is_singular
    CHECK ((source_id IS NOT NULL AND source_key IS NULL)
           OR (source_id IS NULL AND source_key IS NOT NULL)),
  CONSTRAINT tally_ledger_mappings_kind_matches_identity
    CHECK ((source_kind = 'tax_head' AND source_key IS NOT NULL)
           OR (source_kind <> 'tax_head' AND source_id IS NOT NULL)),
  -- ⚠️ `btrim`, not `<> ''`. "  " passes the naive check and is what a
  -- copy-paste actually produces — and Tally will create a ledger with that
  -- name that no report shows and no search finds.
  CONSTRAINT tally_ledger_mappings_name_not_blank
    CHECK (btrim(tally_ledger_name) <> ''),
  CONSTRAINT tally_ledger_mappings_gstin_shape
    CHECK (party_gstin IS NULL
           OR party_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'),
  -- ⚠️ Tally reads the GSTIN off the PARTY ledger. On a nominal one it is
  -- inert, and its presence means a customer was mapped to a nominal account.
  CONSTRAINT tally_ledger_mappings_gstin_only_on_party
    CHECK (party_gstin IS NULL OR is_party)
);


CREATE TABLE IF NOT EXISTS tally_cost_centre_mappings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id              uuid NOT NULL,
  tally_cost_centre_name  varchar(200) NOT NULL,
  -- "Primary Cost Category" is the default in every Tally company. Naming one
  -- that does not exist creates it, with the same silent-fork problem a ledger
  -- name has.
  tally_cost_category     varchar(200) NOT NULL DEFAULT 'Primary Cost Category',
  is_active               boolean NOT NULL DEFAULT true,
  notes                   text,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tally_cost_centre_name_not_blank
    CHECK (btrim(tally_cost_centre_name) <> ''
           AND btrim(tally_cost_category) <> '')
);


CREATE TABLE IF NOT EXISTS tally_export_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id      uuid,
  batch_number       varchar(60) NOT NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  voucher_types      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             tally_export_status NOT NULL DEFAULT 'draft',
  delivery_mode      tally_delivery_mode NOT NULL DEFAULT 'file',
  company_name       varchar(200) NOT NULL,
  voucher_count      integer NOT NULL DEFAULT 0,
  master_count       integer NOT NULL DEFAULT 0,
  total_debit_minor  bigint NOT NULL DEFAULT 0,
  total_credit_minor bigint NOT NULL DEFAULT 0,
  -- ⭐ SHA-256 of the exact bytes. The only answer to "is the file in my
  -- downloads folder the one you think you sent?" that is not a guess about
  -- timestamps — and that folder always contains `tally-april (1).xml`.
  payload_hash       varchar(64),
  payload_bytes      integer,
  generated_at       timestamptz,
  -- ⭐ Set when Tally has ACTUALLY taken it. This timestamp is what flips the
  -- next export of the same source rows from CREATE to ALTER.
  delivered_at       timestamptz,
  delivered_by       uuid,
  -- ⚠️ Tally's response kept verbatim. "ERRORS 0 / CREATED 0" is a perfectly
  -- cheerful response that imported nothing, and the counts are the only way
  -- to tell.
  response_payload   text,
  response_created   integer,
  response_altered   integer,
  response_ignored   integer,
  response_errors    integer,
  failure_reason     text,
  notes              text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tally_export_batches_period_sane CHECK (period_end >= period_start),
  CONSTRAINT tally_export_batches_non_negative
    CHECK (voucher_count >= 0 AND master_count >= 0
           AND total_debit_minor >= 0 AND total_credit_minor >= 0),
  -- ⭐⭐ THE BATCH BALANCES. Individually balanced vouchers always sum to a
  -- balanced batch, so a batch that does NOT balance means a voucher reached
  -- this table without going through the builder.
  CONSTRAINT tally_export_batches_balances
    CHECK (total_debit_minor = total_credit_minor),
  CONSTRAINT tally_export_batches_generated_is_hashed
    CHECK (status NOT IN ('generated','delivered')
           OR (payload_hash IS NOT NULL AND generated_at IS NOT NULL)),
  CONSTRAINT tally_export_batches_hash_shape
    CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tally_export_batches_delivered_is_dated
    CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS tally_vouchers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id              uuid NOT NULL,
  voucher_type          tally_voucher_type NOT NULL,
  -- ⭐⭐ THE DETERMINISTIC KEY. Derived in `lib/tally/keys.ts` from the tenant,
  -- the voucher type and the SOURCE ROW — never from the date, the amount, the
  -- narration or the batch, because a corrected invoice must keep the key of
  -- the invoice it corrects.
  remote_id             varchar(64) NOT NULL,
  -- Tally's own alter key. THEIRS, and it changes if the company is restored
  -- from a backup — which is exactly why it is not what we key on.
  voucher_key           varchar(80),
  voucher_number        varchar(64),
  voucher_date          date NOT NULL,
  source_type           varchar(40) NOT NULL,
  source_id             uuid NOT NULL,
  party_ledger_name     varchar(200),
  party_gstin           varchar(15),
  -- ⭐ Section 12(3), IGST Act: for anything relating to immovable property
  -- the place of supply is the PROPERTY'S state, not the buyer's. Copied from
  -- the Phase 32 decision, never re-derived.
  place_of_supply_code  varchar(2),
  gst_registration_type varchar(24),
  narration             text,
  reference             varchar(120),
  reference_date        date,
  total_debit_minor     bigint NOT NULL DEFAULT 0,
  total_credit_minor    bigint NOT NULL DEFAULT 0,
  -- ⚠️ STORED, NOT REGENERATED. "What did we send Tally in April?" must be
  -- answerable after the invoice has been amended and the mapping re-pointed.
  entries               jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash          varchar(64) NOT NULL,
  is_cancelled          boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tally_vouchers_non_negative
    CHECK (total_debit_minor >= 0 AND total_credit_minor >= 0),
  -- ⭐⭐ EVERY VOUCHER BALANCES, AT THE DATABASE. Tally rejects an unbalanced
  -- voucher part-way through an import, naming a number in a file of thousands
  -- and — on several builds — abandoning the rest.
  CONSTRAINT tally_vouchers_balances
    CHECK (total_debit_minor = total_credit_minor),
  -- ⚠️ A voucher of zero balances trivially, passes every other check, imports
  -- successfully and moves nothing — so a bug that drops every leg reports two
  -- thousand vouchers created and no money moved.
  CONSTRAINT tally_vouchers_non_zero_unless_cancelled
    CHECK (is_cancelled OR total_debit_minor > 0),
  CONSTRAINT tally_vouchers_hash_shape CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- ⭐⭐ THE KEY HAS A SHAPE, AND THE SHAPE IS A CONTRACT. This is what stops
  -- a future write path stamping a `randomUUID()` on a voucher: a random key
  -- is perfectly unique, imports perfectly, and produces a duplicate on every
  -- re-export. A UUID does not match this pattern.
  CONSTRAINT tally_vouchers_remote_id_shape
    CHECK (remote_id ~ '^AHOS-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{24}$'),
  CONSTRAINT tally_vouchers_gstin_shape
    CHECK (party_gstin IS NULL
           OR party_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'),
  CONSTRAINT tally_vouchers_pos_shape
    CHECK (place_of_supply_code IS NULL OR place_of_supply_code ~ '^[0-9]{2}$'),
  -- ⚠️ Contra is cash/bank to cash/bank. Tally enforces it, and the
  -- enforcement arrives as a failed import rather than a field error.
  CONSTRAINT tally_vouchers_contra_has_no_party
    CHECK (voucher_type <> 'contra' OR party_ledger_name IS NULL)
);


CREATE TABLE IF NOT EXISTS tally_import_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id      uuid,
  source_label       varchar(255) NOT NULL,
  company_name       varchar(200),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  status             tally_import_status NOT NULL DEFAULT 'received',
  voucher_count      integer NOT NULL DEFAULT 0,
  total_debit_minor  bigint NOT NULL DEFAULT 0,
  total_credit_minor bigint NOT NULL DEFAULT 0,
  payload_hash       varchar(64) NOT NULL,
  payload_bytes      integer,
  -- ⚠️ VERBATIM, exactly as Phase 34 keeps the GSTR-2B. A parsed
  -- representation is our READING of their file; when the two disagree the
  -- argument is about the bytes.
  raw_payload        text,
  parse_warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  difference_count   integer NOT NULL DEFAULT 0,
  unresolved_count   integer NOT NULL DEFAULT 0,
  reconciled_at      timestamptz,
  notes              text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tally_import_batches_period_sane CHECK (period_end >= period_start),
  CONSTRAINT tally_import_batches_hash_shape
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tally_import_batches_non_negative
    CHECK (voucher_count >= 0 AND difference_count >= 0 AND unresolved_count >= 0
           AND total_debit_minor >= 0 AND total_credit_minor >= 0),
  CONSTRAINT tally_import_batches_unresolved_bounded
    CHECK (unresolved_count <= difference_count)
);


CREATE TABLE IF NOT EXISTS tally_reconciliation_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  import_batch_id         uuid NOT NULL,
  kind                    tally_diff_kind NOT NULL,
  status                  tally_diff_status NOT NULL DEFAULT 'open',
  remote_id               varchar(64),
  our_voucher_id          uuid,
  our_voucher_number      varchar(64),
  our_voucher_date        date,
  our_voucher_type        varchar(24),
  our_amount_minor        bigint,
  our_party_ledger_name   varchar(200),
  their_voucher_number    varchar(64),
  their_voucher_date      date,
  their_voucher_type      varchar(64),
  their_amount_minor      bigint,
  their_party_ledger_name varchar(200),
  -- ⭐ THE SENTENCE. "₹1,18,000 here, ₹1,18,500 there" is actionable in ten
  -- seconds; "does not match" sends somebody to two screens and a calculator.
  explanation             text NOT NULL,
  resolution_note         text,
  resolved_at             timestamptz,
  resolved_by             uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- ⭐ A difference must have a side. A row with neither is a finding about
  -- nothing that would still be counted in `difference_count`.
  CONSTRAINT tally_reconciliation_has_a_side
    CHECK (our_voucher_id IS NOT NULL OR our_voucher_number IS NOT NULL
           OR their_voucher_number IS NOT NULL OR remote_id IS NOT NULL),
  -- ⚠️ A mislabelled "they have something we do not" is exactly the finding
  -- that gets somebody to post a duplicate journal by hand.
  CONSTRAINT tally_reconciliation_missing_in_ours_has_no_ours
    CHECK (kind <> 'missing_in_ours' OR our_voucher_id IS NULL),
  CONSTRAINT tally_reconciliation_missing_in_tally_has_no_theirs
    CHECK (kind <> 'missing_in_tally' OR their_voucher_number IS NULL),
  -- ⭐ A hundred findings that are not findings is how the four real ones get
  -- lost.
  CONSTRAINT tally_reconciliation_amount_differs_actually_differs
    CHECK (kind <> 'amount_differs'
           OR (our_amount_minor IS NOT NULL AND their_amount_minor IS NOT NULL
               AND our_amount_minor <> their_amount_minor)),
  CONSTRAINT tally_reconciliation_resolved_is_dated
    CHECK (status <> 'resolved' OR resolved_at IS NOT NULL)
);


-- Indexes. `drizzle-kit push` creates these too; restated for a fresh database.
CREATE UNIQUE INDEX IF NOT EXISTS tally_connections_name_tenant_unique
  ON tally_connections (tenant_id, name);
CREATE INDEX IF NOT EXISTS tally_connections_tenant_idx
  ON tally_connections (tenant_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS tally_ledger_mappings_source_row_unique
  ON tally_ledger_mappings (tenant_id, source_kind, source_id)
  WHERE source_id IS NOT NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS tally_ledger_mappings_source_key_unique
  ON tally_ledger_mappings (tenant_id, source_kind, source_key)
  WHERE source_key IS NOT NULL AND is_active;
CREATE INDEX IF NOT EXISTS tally_ledger_mappings_name_idx
  ON tally_ledger_mappings (tenant_id, tally_ledger_name);
CREATE INDEX IF NOT EXISTS tally_ledger_mappings_tenant_idx
  ON tally_ledger_mappings (tenant_id, source_kind);

CREATE UNIQUE INDEX IF NOT EXISTS tally_cost_centre_project_unique
  ON tally_cost_centre_mappings (tenant_id, project_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS tally_cost_centre_tenant_idx
  ON tally_cost_centre_mappings (tenant_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS tally_export_batches_number_unique
  ON tally_export_batches (tenant_id, batch_number);
CREATE INDEX IF NOT EXISTS tally_export_batches_period_idx
  ON tally_export_batches (tenant_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS tally_export_batches_status_idx
  ON tally_export_batches (tenant_id, status);
CREATE INDEX IF NOT EXISTS tally_export_batches_hash_idx
  ON tally_export_batches (tenant_id, payload_hash);

CREATE UNIQUE INDEX IF NOT EXISTS tally_vouchers_batch_remote_unique
  ON tally_vouchers (tenant_id, batch_id, remote_id);
-- ⭐⭐ The index Section 6 lives on. "Has this source row been exported
-- before, and under what key?" is asked on every insert.
CREATE INDEX IF NOT EXISTS tally_vouchers_remote_idx
  ON tally_vouchers (tenant_id, remote_id);
CREATE INDEX IF NOT EXISTS tally_vouchers_source_idx
  ON tally_vouchers (tenant_id, source_type, source_id, voucher_type);
CREATE INDEX IF NOT EXISTS tally_vouchers_batch_idx
  ON tally_vouchers (tenant_id, batch_id);
CREATE INDEX IF NOT EXISTS tally_vouchers_date_idx
  ON tally_vouchers (tenant_id, voucher_date);

CREATE UNIQUE INDEX IF NOT EXISTS tally_import_batches_payload_unique
  ON tally_import_batches (tenant_id, payload_hash);
CREATE INDEX IF NOT EXISTS tally_import_batches_period_idx
  ON tally_import_batches (tenant_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS tally_import_batches_status_idx
  ON tally_import_batches (tenant_id, status);

CREATE INDEX IF NOT EXISTS tally_reconciliation_batch_idx
  ON tally_reconciliation_items (tenant_id, import_batch_id, kind);
CREATE INDEX IF NOT EXISTS tally_reconciliation_open_idx
  ON tally_reconciliation_items (tenant_id, created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tally_reconciliation_voucher_idx
  ON tally_reconciliation_items (tenant_id, our_voucher_id);


-- ############################################################################
-- SECTION 2 — ⭐ ONE TALLY LEDGER NAME PER WORKSPACE, FOLDED
-- ############################################################################
--
-- ⭐ THE INDEX THAT KEEPS THE RECONCILIATION MEANINGFUL.
--
--     Our "Sales — Residential" and our "Sales — Commercial" are both mapped
--     to the Tally ledger "Sales A/c" — perhaps deliberately, to keep the P&L
--     tidy, perhaps because somebody copied the row.
--
--     Both post to one ledger. Tally is happy. The books are right. And the
--     reconciliation in `lib/tally/reconcile.ts` can now never attribute a
--     difference to either of them: the report says "₹4,000 out on Sales A/c"
--     and cannot say on WHAT, forever.
--
-- ⚠️ AND IT IS ON `lower(...)`, BECAUSE TALLY MATCHES NAMES CASE-INSENSITIVELY.
-- "Sales A/c" and "sales a/c" are ONE ledger to Tally and two rows to a naive
-- unique index — after which each of our accounts posts to "its own" ledger and
-- both land in the same one, silently merged, which is the same failure
-- arriving through a door nobody watched.
--
-- ⚠️ `btrim` AND THE WHITESPACE COLLAPSE ARE IN IT TOO. "Sales  A/c" with two
-- spaces, out of a spreadsheet, is the same ledger to Tally and prints
-- identically in every report.
--
-- ⚠️ PARTIAL, on `is_active`. A mapping that has been retired and replaced is
-- history, and history must be allowed to contain the old name.

CREATE UNIQUE INDEX IF NOT EXISTS tally_ledger_mappings_name_ci_unique
  ON tally_ledger_mappings (tenant_id, lower(btrim(regexp_replace(tally_ledger_name, '\s+', ' ', 'g'))))
  WHERE is_active;

-- The same argument for cost centres. Two projects mapped to one Tally cost
-- centre produce a per-project P&L that silently reports the sum of two.
CREATE UNIQUE INDEX IF NOT EXISTS tally_cost_centre_name_ci_unique
  ON tally_cost_centre_mappings
     (tenant_id, tally_cost_category,
      lower(btrim(regexp_replace(tally_cost_centre_name, '\s+', ' ', 'g'))))
  WHERE is_active;


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER too, which
-- is the half everybody forgets: without it the role that created the table
-- reads everything and the policies look like they are working.
--
-- ⚠️ NO `app_is_platform_scope()` ON ANY POLICY HERE. `tally_ledger_mappings`
-- is a workspace's entire chart of accounts, its vendor list and its customer
-- list with their GSTINs; `tally_vouchers` is every transaction it has ever
-- exported, with the party and the amount. That is the complete commercial
-- picture of a business — who it buys from, who it sells to and for how much —
-- and it is a more complete one than any single ledger in this product,
-- because an export is deliberately comprehensive. Platform staff have no
-- business reading it.
--
-- ⚠️ AND `tally_connections` CARRIES `allow_private_host` AND A HOST. Reading
-- it tells you which workspaces have opened a path from our servers into their
-- office network and exactly where it points. That is a map of the estate.

ALTER TABLE tally_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_connections FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_connections_tenant_isolation ON tally_connections;
CREATE POLICY tally_connections_tenant_isolation ON tally_connections
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tally_ledger_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_ledger_mappings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_ledger_mappings_tenant_isolation ON tally_ledger_mappings;
CREATE POLICY tally_ledger_mappings_tenant_isolation ON tally_ledger_mappings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tally_cost_centre_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_cost_centre_mappings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_cost_centre_tenant_isolation ON tally_cost_centre_mappings;
CREATE POLICY tally_cost_centre_tenant_isolation ON tally_cost_centre_mappings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tally_export_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_export_batches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_export_batches_tenant_isolation ON tally_export_batches;
CREATE POLICY tally_export_batches_tenant_isolation ON tally_export_batches
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tally_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_vouchers FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_vouchers_tenant_isolation ON tally_vouchers;
CREATE POLICY tally_vouchers_tenant_isolation ON tally_vouchers
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tally_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_import_batches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_import_batches_tenant_isolation ON tally_import_batches;
CREATE POLICY tally_import_batches_tenant_isolation ON tally_import_batches
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE tally_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_reconciliation_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tally_reconciliation_tenant_isolation ON tally_reconciliation_items;
CREATE POLICY tally_reconciliation_tenant_isolation ON tally_reconciliation_items
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 4 — ⭐ COMPOSITE FOREIGN KEYS
-- ############################################################################
--
-- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY. That
-- is documented PostgreSQL behaviour and it is why every pointer in this phase
-- is a COMPOSITE key on (col, tenant_id).
--
-- The shape of the hole, concretely for this phase:
--
--     Tenant A inserts a voucher with
--         tenant_id = A                          ← passes WITH CHECK
--         batch_id  = <a batch owned by B>       ← passes a single-column FK
--
--     A's voucher is now inside B's export batch. When B generates the file,
--     A's voucher goes into B's Tally company — party name, amount and all —
--     and B's accountant imports a transaction belonging to a business they
--     have never heard of. B's batch totals then fail the Section 7 check for
--     reasons entirely inside a table B cannot read.
--
-- ⚠️ AND `our_voucher_id` ON A RECONCILIATION ITEM IS WORSE STILL: it would
-- publish another workspace's voucher number, date, party and amount into a
-- report this one reads.

CREATE UNIQUE INDEX IF NOT EXISTS tally_connections_id_tenant_key
  ON tally_connections (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tally_ledger_mappings_id_tenant_key
  ON tally_ledger_mappings (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tally_cost_centre_id_tenant_key
  ON tally_cost_centre_mappings (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tally_export_batches_id_tenant_key
  ON tally_export_batches (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tally_vouchers_id_tenant_key
  ON tally_vouchers (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS tally_import_batches_id_tenant_key
  ON tally_import_batches (id, tenant_id);

-- Parents in earlier phases. Created idempotently so this file does not depend
-- on the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key    ON users (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_tenant_key ON projects (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledgers_id_tenant_key  ON ledgers (id, tenant_id);

DO $$
BEGIN
  /* --- tally_connections ---------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_connections_created_by_same_tenant') THEN
    ALTER TABLE tally_connections ADD CONSTRAINT tally_connections_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- tally_cost_centre_mappings ------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_cost_centre_project_same_tenant') THEN
    ALTER TABLE tally_cost_centre_mappings
      ADD CONSTRAINT tally_cost_centre_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      -- CASCADE: a mapping is only meaningful while the project exists, and it
      -- carries nothing that outlives it.
      ON DELETE CASCADE;
  END IF;

  /* --- tally_export_batches ------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_export_batches_connection_same_tenant') THEN
    ALTER TABLE tally_export_batches
      ADD CONSTRAINT tally_export_batches_connection_same_tenant
      FOREIGN KEY (connection_id, tenant_id) REFERENCES tally_connections (id, tenant_id)
      -- ⚠️ SET NULL, not CASCADE. The batch is the evidence of what was sent
      -- and to which company; deleting a connection must not delete the record
      -- of everything that went through it.
      ON DELETE SET NULL (connection_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_export_batches_created_by_same_tenant') THEN
    ALTER TABLE tally_export_batches
      ADD CONSTRAINT tally_export_batches_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_export_batches_delivered_by_same_tenant') THEN
    ALTER TABLE tally_export_batches
      ADD CONSTRAINT tally_export_batches_delivered_by_same_tenant
      FOREIGN KEY (delivered_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (delivered_by);
  END IF;

  /* --- tally_vouchers ------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_vouchers_batch_same_tenant') THEN
    ALTER TABLE tally_vouchers ADD CONSTRAINT tally_vouchers_batch_same_tenant
      FOREIGN KEY (batch_id, tenant_id) REFERENCES tally_export_batches (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  /* --- tally_import_batches ------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_import_batches_connection_same_tenant') THEN
    ALTER TABLE tally_import_batches
      ADD CONSTRAINT tally_import_batches_connection_same_tenant
      FOREIGN KEY (connection_id, tenant_id) REFERENCES tally_connections (id, tenant_id)
      ON DELETE SET NULL (connection_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_import_batches_created_by_same_tenant') THEN
    ALTER TABLE tally_import_batches
      ADD CONSTRAINT tally_import_batches_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- tally_reconciliation_items ------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_reconciliation_batch_same_tenant') THEN
    ALTER TABLE tally_reconciliation_items
      ADD CONSTRAINT tally_reconciliation_batch_same_tenant
      FOREIGN KEY (import_batch_id, tenant_id)
      REFERENCES tally_import_batches (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_reconciliation_voucher_same_tenant') THEN
    ALTER TABLE tally_reconciliation_items
      ADD CONSTRAINT tally_reconciliation_voucher_same_tenant
      FOREIGN KEY (our_voucher_id, tenant_id) REFERENCES tally_vouchers (id, tenant_id)
      ON DELETE SET NULL (our_voucher_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'tally_reconciliation_resolved_by_same_tenant') THEN
    ALTER TABLE tally_reconciliation_items
      ADD CONSTRAINT tally_reconciliation_resolved_by_same_tenant
      FOREIGN KEY (resolved_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (resolved_by);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — ⭐ A MAPPING MUST POINT AT A ROW OF ITS OWN KIND
-- ############################################################################
--
-- ⚠️ `source_id` IS POLYMORPHIC, SO NO FOREIGN KEY CAN COVER IT. It points at
-- `ledgers` when the kind is `ledger`, at `vendors` when it is `vendor`, and at
-- `gst_parties` when it is `customer`. A conditional foreign key does not
-- exist, so the check is a trigger — and without it two things go wrong at
-- once:
--
--   • ⭐ A CROSS-TENANT POINTER. Section 4's composite keys close this for
--     every non-polymorphic column; this column has none, so the tenant check
--     has to be here or it is nowhere. Guessing vendor ids until one is
--     accepted would otherwise be an existence oracle over another workspace's
--     supplier list.
--   • A MAPPING POINTING AT THE WRONG KIND OF THING. A `vendor` mapping whose
--     `source_id` is actually a ledger id resolves to nothing at export time,
--     so the voucher builder refuses — correctly, but on the last day of the
--     month, with a message about an unmapped vendor that nobody can reconcile
--     against a mapping screen showing the vendor as mapped.

CREATE OR REPLACE FUNCTION tally_mapping_points_at_own_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF NEW.source_kind = 'tax_head' THEN
    -- No row to point at. The closed set of permitted keys is enforced by
    -- `lib/validators/tally.ts`; a free-text tax head here would be a second,
    -- unchecked chart of accounts.
    RETURN NEW;
  END IF;

  IF NEW.source_id IS NULL THEN
    RAISE EXCEPTION
      'A % mapping must name the record it maps. A mapping that points at '
      'nothing resolves to nothing at export time, and the refusal arrives on '
      'the last day of the month.', NEW.source_kind
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.source_kind = 'ledger' THEN
    SELECT EXISTS (SELECT 1 FROM ledgers
                   WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id)
      INTO v_exists;
  ELSIF NEW.source_kind = 'vendor' THEN
    SELECT EXISTS (SELECT 1 FROM vendors
                   WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id)
      INTO v_exists;
  ELSIF NEW.source_kind = 'customer' THEN
    SELECT EXISTS (SELECT 1 FROM gst_parties
                   WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id)
      INTO v_exists;
  ELSE
    v_exists := false;
  END IF;

  IF NOT v_exists THEN
    RAISE EXCEPTION
      'No % exists in this workspace with that identifier. ⚠️ Either the '
      'mapping names the wrong KIND of record — a vendor id filed as a ledger '
      'resolves to nothing at export time while the mapping screen shows it as '
      'mapped — or it names a record belonging to another workspace, which is '
      'refused here because a polymorphic column cannot carry a composite '
      'foreign key.', NEW.source_kind
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tally_mapping_kind_check ON tally_ledger_mappings;
CREATE TRIGGER tally_mapping_kind_check
  BEFORE INSERT OR UPDATE OF source_kind, source_id, tenant_id
  ON tally_ledger_mappings
  FOR EACH ROW EXECUTE FUNCTION tally_mapping_points_at_own_kind();


-- ############################################################################
-- SECTION 6 — ⭐⭐ THE DETERMINISTIC KEY
-- ############################################################################
--
-- ⭐⭐ THE GUARD THIS PHASE EXISTS FOR.
--
--     April is exported. Sixty vouchers, each stamped with a REMOTEID derived
--     from the source row. The accountant imports the file. Tally creates
--     sixty vouchers and remembers every key.
--
--     A month later, somebody re-generates April — because a mapping changed,
--     because a bill was amended, because the code was refactored. If the keys
--     come out the same, Tally ALTERS the sixty vouchers it has. If ONE of
--     them comes out different, Tally creates a SIXTY-FIRST voucher.
--
--     ⚠️ AND NOTHING REPORTS IT. Both vouchers balance. The trial balance
--     balances. The register foots. April's revenue is simply larger by one
--     invoice, and it is found by an auditor comparing turnover to the GSTR-1.
--
-- The ways a key changes are all quiet and all plausible:
--
--   • A refactor includes the amount or the date in the derivation, so every
--     corrected invoice becomes a new voucher.
--   • A back-fill script writes `gen_random_uuid()` because it looked like an
--     id column. (The `remote_id` CHECK in Section 1 refuses that shape, which
--     is the first line of defence; this trigger is the second.)
--   • A batch id creeps into the derivation, so every export is entirely new.
--
-- ⚠️ SO THE RULE IS ENFORCED AGAINST HISTORY, NOT AGAINST A FORMULA. The
-- database does not know how the key is computed and must not: it knows that
-- this source row was exported under THAT key before, and refuses any other.
-- A formula the trigger checked would have to be kept in step with
-- `lib/tally/keys.ts`, and a copy nobody checks is how a guard quietly stops
-- guarding.
--
-- ⚠️ IT IS A ROW-LEVEL BEFORE TRIGGER, NOT DEFERRED. There is no batching
-- concern here — a voucher's key is decided the moment it is written, and
-- refusing at the row is what puts the message next to the voucher that caused
-- it rather than at COMMIT next to sixty that did not.

CREATE OR REPLACE FUNCTION tally_voucher_key_is_stable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_key  varchar(64);
  v_other_source  record;
BEGIN
  /* --- ⭐ THE SAME SOURCE ROW MUST KEEP ITS KEY. ----------------- */
  SELECT remote_id INTO v_previous_key
  FROM tally_vouchers
  WHERE tenant_id    = NEW.tenant_id
    AND source_type  = NEW.source_type
    AND source_id    = NEW.source_id
    AND voucher_type = NEW.voucher_type
    AND id          <> NEW.id
  LIMIT 1;

  IF v_previous_key IS NOT NULL AND v_previous_key <> NEW.remote_id THEN
    RAISE EXCEPTION
      'This % has already been exported to Tally under the key %, and this '
      'export would give it the key % instead. ⚠️ REFUSED, because Tally '
      'de-duplicates on that key and on nothing else: a second key means a '
      'SECOND voucher for the same transaction, both balanced, in a trial '
      'balance that still balances. Nothing in Tally or here would report it, '
      'and it would be found at the year end by somebody comparing turnover to '
      'the GSTR-1. The key is derived in lib/tally/keys.ts from the tenant, the '
      'voucher type and the source row — never from the amount, the date or the '
      'batch — precisely so that a correction keeps the key of what it '
      'corrects.',
      NEW.source_type, v_previous_key, NEW.remote_id
      USING ERRCODE = 'unique_violation';
  END IF;

  /* --- ⚠️ AND THE REVERSE: ONE KEY, ONE SOURCE ROW. -------------- */
  --
  -- A key collision is the same disaster wearing the other hat: two different
  -- invoices sharing a REMOTEID means the second ALTERS the first in Tally, so
  -- one of them silently disappears from their books while both are present in
  -- ours. Rarer, worse, and free to check while we are here.
  SELECT source_type, source_id, voucher_type INTO v_other_source
  FROM tally_vouchers
  WHERE tenant_id = NEW.tenant_id
    AND remote_id = NEW.remote_id
    AND id       <> NEW.id
    AND (source_type <> NEW.source_type
         OR source_id <> NEW.source_id
         OR voucher_type <> NEW.voucher_type)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'The Tally key % is already used by a different % (%). ⚠️ REFUSED: two '
      'transactions sharing one key means the second one ALTERS the first in '
      'Tally, so one of them vanishes from their books while both are present '
      'in ours — and the vanished one is chosen by whichever was imported last.',
      NEW.remote_id, v_other_source.source_type, v_other_source.source_id
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tally_vouchers_key_stability ON tally_vouchers;
CREATE TRIGGER tally_vouchers_key_stability
  BEFORE INSERT OR UPDATE OF remote_id, source_type, source_id, voucher_type
  ON tally_vouchers
  FOR EACH ROW EXECUTE FUNCTION tally_voucher_key_is_stable();


-- ############################################################################
-- SECTION 7 — ⭐ THE BATCH MUST EQUAL ITS VOUCHERS
-- ############################################################################
--
-- ⭐ THE STORED TOTALS ON A BATCH ARE WHAT A PERSON READS AND WHAT A LIST PAGE
-- SHOWS. They are also derived, and a derived number that drifts from its
-- source is worse than no number: "62 vouchers, ₹48,20,000" beside a file
-- containing 61 vouchers and ₹47,10,000 is a reconciliation that PASSES against
-- a figure the accountant never saw.
--
-- ⚠️ DEFERRED, AND THAT IS ESSENTIAL. The exporter writes the batch row, then
-- the vouchers, then updates the totals — three statements in one transaction.
-- An immediate trigger would reject the batch row before its first voucher
-- existed.
--
-- ⚠️ AND IT FIRES ON BOTH TABLES. Checking only the voucher side means a batch
-- whose totals are edited afterwards passes; checking only the batch side means
-- a voucher deleted afterwards passes. Either half alone is a guard with a door
-- next to it.

CREATE OR REPLACE FUNCTION tally_batch_matches_its_vouchers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch_id  uuid;
  v_tenant_id uuid;
  v_batch     record;
  v_actual    record;
BEGIN
  IF TG_TABLE_NAME = 'tally_vouchers' THEN
    v_batch_id  := COALESCE(NEW.batch_id, OLD.batch_id);
    v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  ELSE
    v_batch_id  := COALESCE(NEW.id, OLD.id);
    v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  END IF;

  SELECT voucher_count, total_debit_minor, total_credit_minor, batch_number
    INTO v_batch
  FROM tally_export_batches
  WHERE id = v_batch_id AND tenant_id = v_tenant_id;

  -- The batch was deleted in this transaction; its vouchers went with it.
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*)                          AS n,
         COALESCE(sum(total_debit_minor),0)  AS dr,
         COALESCE(sum(total_credit_minor),0) AS cr
    INTO v_actual
  FROM tally_vouchers
  WHERE batch_id = v_batch_id AND tenant_id = v_tenant_id;

  IF v_batch.voucher_count <> v_actual.n
     OR v_batch.total_debit_minor <> v_actual.dr
     OR v_batch.total_credit_minor <> v_actual.cr THEN
    RAISE EXCEPTION
      'Export batch % says it holds % vouchers totalling %, and it actually '
      'holds % totalling %. ⚠️ REFUSED: the stored totals are what a person '
      'reads and what gets compared against the accountant''s import summary, '
      'so a batch whose figures disagree with its own contents is a '
      'reconciliation that passes against a number nobody ever saw.',
      v_batch.batch_number, v_batch.voucher_count, v_batch.total_debit_minor,
      v_actual.n, v_actual.dr
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tally_vouchers_batch_totals ON tally_vouchers;
CREATE CONSTRAINT TRIGGER tally_vouchers_batch_totals
  AFTER INSERT OR UPDATE OR DELETE ON tally_vouchers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tally_batch_matches_its_vouchers();

DROP TRIGGER IF EXISTS tally_export_batches_totals ON tally_export_batches;
CREATE CONSTRAINT TRIGGER tally_export_batches_totals
  AFTER INSERT OR UPDATE OF voucher_count, total_debit_minor, total_credit_minor
  ON tally_export_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tally_batch_matches_its_vouchers();


-- ############################################################################
-- SECTION 8 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['tally_connections','tally_ledger_mappings',
                         'tally_cost_centre_mappings','tally_export_batches',
                         'tally_vouchers','tally_import_batches',
                         'tally_reconciliation_items'];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t);
  END LOOP;

  -- ⚠️ ATTACHED HERE rather than left to 0017, which discovers tenant-scoped
  -- tables only when it is re-run — and a deployment applying files in
  -- numerical order runs it BEFORE these exist.
  --
  -- ⚠️ ALL SEVEN, INCLUDING `tally_vouchers`, AND THE FIRST DRAFT EXCLUDED IT.
  --
  -- The argument for excluding it is real: one export writes thousands of rows
  -- each carrying a jsonb of ledger entries, so logging them multiplies the
  -- change log by the size of the ledger. The argument against is stronger and
  -- is a whole-product invariant rather than a local optimisation: EVERY
  -- tenant-scoped table records its changes, because the change log is what
  -- offline sync replays and a table that records nothing can never sync — it
  -- simply goes missing between two machines, silently, and nobody finds out
  -- until data is gone. `tests/security/change-log.test.ts` DISCOVERS the
  -- tables rather than listing them, precisely so that a phase cannot opt
  -- itself out by forgetting.
  --
  -- ⚠️ AND FOR THIS TABLE THE HISTORY IS WORTH THE VOLUME. `remote_id` is the
  -- key that decides whether a re-import updates or duplicates; a change to it
  -- that nobody can see afterwards is the one change nobody could reconstruct.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    FOREACH t IN ARRAY tables
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_change_log', t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION record_change()',
        t || '_change_log', t);
    END LOOP;
  END IF;

  -- ⚠️ AND THE IMPERSONATION GUARD. A support session wearing a customer's
  -- face must not be able to DELETE an export batch: the batch is the record of
  -- what was put into somebody's statutory books, and deleting it leaves the
  -- customer unable to answer "did we already import April?" — which is the
  -- question whose wrong answer doubles their turnover.
  IF EXISTS (SELECT 1 FROM pg_proc
             WHERE proname = 'refuse_delete_under_impersonation') THEN
    FOREACH t IN ARRAY tables
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',
                     'no_delete_under_impersonation', t);
      EXECUTE format(
        'CREATE TRIGGER no_delete_under_impersonation BEFORE DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION refuse_delete_under_impersonation()',
        t);
    END LOOP;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 9 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.
--
-- ⚠️ NO DELETE ON `tally_export_batches` OR `tally_vouchers`, AND THAT IS THE
-- POINT OF THE TABLES.
--
-- An export batch is the record that a set of transactions was put into
-- somebody's statutory books. It is what answers "have we already imported
-- April?" — and the wrong answer to that question doubles a company's
-- turnover. A deleted batch does not just lose history; it actively causes the
-- failure the phase exists to prevent, because the next export sees no prior
-- delivery and sends every voucher as a CREATE.
--
-- A batch that should not have been generated is marked `superseded`, which is
-- also what a later batch covering the same period does to it.
--
-- ⚠️ `tally_vouchers` GETS NO DELETE EITHER, and it does not need one: the
-- CASCADE from a batch is a database-level operation and does not go through
-- the application role.
--
-- The mappings and the connections DO get DELETE, narrowly: a mapping created
-- by mistake before anything was exported is an ordinary correction, and the
-- rows that matter are protected by the RESTRICT-free design — a deleted
-- mapping cannot retrospectively change a voucher, because the voucher stores
-- the ledger names it was rendered with.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON tally_connections          FROM ordence_app;
    REVOKE ALL ON tally_ledger_mappings      FROM ordence_app;
    REVOKE ALL ON tally_cost_centre_mappings FROM ordence_app;
    REVOKE ALL ON tally_export_batches       FROM ordence_app;
    REVOKE ALL ON tally_vouchers             FROM ordence_app;
    REVOKE ALL ON tally_import_batches       FROM ordence_app;
    REVOKE ALL ON tally_reconciliation_items FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON tally_connections          TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tally_ledger_mappings      TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tally_cost_centre_mappings TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tally_export_batches       TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tally_vouchers             TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tally_import_batches       TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON tally_reconciliation_items TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 10 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on all seven new tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. ENABLE without FORCE
-- looks protected in every UI and is not protected against the owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read every '
            'other tenant''s chart of accounts, customer and vendor lists with '
            'GSTINs, and every transaction they have ever exported ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('tally_connections','tally_ledger_mappings',
                    'tally_cost_centre_mappings','tally_export_batches',
                    'tally_vouchers','tally_import_batches',
                    'tally_reconciliation_items')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant a voucher in another '
            'tenant''s export, which then goes into that company''s books ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('tally_connections','tally_ledger_mappings',
                    'tally_cost_centre_mappings','tally_export_batches',
                    'tally_vouchers','tally_import_batches',
                    'tally_reconciliation_items')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 4).
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('tally_connections_created_by_same_tenant'),
  ('tally_cost_centre_project_same_tenant'),
  ('tally_export_batches_connection_same_tenant'),
  ('tally_export_batches_created_by_same_tenant'),
  ('tally_export_batches_delivered_by_same_tenant'),
  ('tally_vouchers_batch_same_tenant'),
  ('tally_import_batches_connection_same_tenant'),
  ('tally_import_batches_created_by_same_tenant'),
  ('tally_reconciliation_batch_same_tenant'),
  ('tally_reconciliation_voucher_same_tenant'),
  ('tally_reconciliation_resolved_by_same_tenant')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname
ORDER BY expected.conname;


-- Check 4 — the guards are installed AND enabled.
-- ⚠️ `tgenabled` needs the ::text cast; without it the comparison silently
-- misbehaves. Found in Phase 11 against a real PostgreSQL.
SELECT
  expected.tgname,
  CASE WHEN t.tgname IS NULL THEN '*** FAIL — TRIGGER MISSING ***'
       WHEN t.tgenabled::text = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger DISABLED: ' || t.tgenabled::text || ' ***'
  END AS verdict
FROM (VALUES
  ('tally_mapping_kind_check',       'tally_ledger_mappings'),
  ('tally_vouchers_key_stability',   'tally_vouchers'),
  ('tally_vouchers_batch_totals',    'tally_vouchers'),
  ('tally_export_batches_totals',    'tally_export_batches')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tgname;


-- Check 5 — ⭐⭐ THE DOUBLE POST, PROVED NOT INSPECTED.
--
-- One purchase invoice, exported in April. In June the period is exported
-- again. The SAME key must be accepted — that is a re-import Tally will treat
-- as an ALTER. A DIFFERENT key must be REFUSED, because that is the second
-- voucher nobody will ever notice.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_batch_a uuid := gen_random_uuid();
  v_batch_b uuid := gen_random_uuid();
  v_source  uuid := gen_random_uuid();
  v_key     varchar(64) := 'AHOS-abcdef01-23456789-0123456789abcdef01234567';
  v_other   varchar(64) := 'AHOS-abcdef01-23456789-ffffffffffffffffffffffff';
  v_hash    varchar(64) := repeat('a', 64);
  v_same_ok  boolean := false;
  v_diff_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_tally_' || v_tenant,
            'tally-' || left(v_tenant::text, 8),
            'Tally key verification', 'active');

  INSERT INTO tally_export_batches
    (id, tenant_id, batch_number, period_start, period_end, company_name,
     voucher_count, total_debit_minor, total_credit_minor)
  VALUES
    (v_batch_a, v_tenant, 'TALLY/APR/001', DATE '2026-04-01', DATE '2026-04-30',
     'Verification Co', 1, 10000000, 10000000),
    (v_batch_b, v_tenant, 'TALLY/APR/002', DATE '2026-04-01', DATE '2026-04-30',
     'Verification Co', 1, 10000000, 10000000);

  INSERT INTO tally_vouchers
    (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
     source_type, source_id, party_ledger_name,
     total_debit_minor, total_credit_minor, content_hash)
  VALUES
    (v_tenant, v_batch_a, 'purchase', v_key, DATE '2026-04-12',
     'purchase_invoice', v_source, 'Sahyadri Cement & Co',
     10000000, 10000000, v_hash);

  /* --- ⭐ The re-export with the SAME key. MUST be ACCEPTED. ---- */
  BEGIN
    INSERT INTO tally_vouchers
      (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
       source_type, source_id, party_ledger_name,
       total_debit_minor, total_credit_minor, content_hash)
    VALUES
      (v_tenant, v_batch_b, 'purchase', v_key, DATE '2026-04-12',
       'purchase_invoice', v_source, 'Sahyadri Cement & Co',
       10000000, 10000000, v_hash);
    v_same_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_same_ok := false;
    RAISE NOTICE 'stable re-export refused: %', SQLERRM;
  END;

  /* --- ⭐⭐ The re-export with a DIFFERENT key. MUST be REFUSED. */
  BEGIN
    INSERT INTO tally_vouchers
      (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
       source_type, source_id, party_ledger_name,
       total_debit_minor, total_credit_minor, content_hash)
    VALUES
      (v_tenant, v_batch_b, 'purchase', v_other, DATE '2026-04-12',
       'purchase_invoice', v_source, 'Sahyadri Cement & Co',
       10000000, 10000000, v_hash);
  EXCEPTION WHEN OTHERS THEN
    v_diff_ref := true;
  END;

  IF v_same_ok AND v_diff_ref THEN
    RAISE NOTICE 'PASS: ⭐⭐ re-exporting a period keeps the same Tally key, so '
                 'a re-import ALTERS rather than duplicates — and a second, '
                 'different key for the same invoice is REFUSED.';
  ELSIF NOT v_same_ok THEN
    RAISE WARNING '*** FAIL — a STABLE re-export was refused, so a period can '
                  'never be corrected and re-sent at all. ***';
  ELSE
    RAISE WARNING '*** FAIL — ⭐⭐ A SECOND, DIFFERENT TALLY KEY WAS ACCEPTED '
                  'FOR AN INVOICE ALREADY EXPORTED. This is the double post: '
                  'Tally would create a second voucher, both would balance, the '
                  'trial balance would balance, and the company''s turnover '
                  'would be overstated by one invoice with nothing anywhere '
                  'reporting it. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — ⭐ AN UNBALANCED VOUCHER IS REFUSED, AND SO IS AN EMPTY ONE.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_batch   uuid := gen_random_uuid();
  v_hash    varchar(64) := repeat('b', 64);
  v_key     varchar(64) := 'AHOS-11111111-22222222-333333333333333333333333';
  v_unbal_ref boolean := false;
  v_zero_ref  boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_tallyb_' || v_tenant,
            'tallyb-' || left(v_tenant::text, 8),
            'Tally balance verification', 'active');
  INSERT INTO tally_export_batches
    (id, tenant_id, batch_number, period_start, period_end, company_name)
  VALUES
    (v_batch, v_tenant, 'TALLY/BAL/001', DATE '2026-04-01', DATE '2026-04-30',
     'Verification Co');

  BEGIN
    INSERT INTO tally_vouchers
      (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
       source_type, source_id, total_debit_minor, total_credit_minor, content_hash)
    VALUES
      (v_tenant, v_batch, 'journal', v_key, DATE '2026-04-12',
       'transaction', gen_random_uuid(), 10000000, 9999900, v_hash);
  EXCEPTION WHEN OTHERS THEN
    v_unbal_ref := true;
  END;

  BEGIN
    INSERT INTO tally_vouchers
      (tenant_id, batch_id, voucher_type, remote_id, voucher_date,
       source_type, source_id, total_debit_minor, total_credit_minor, content_hash)
    VALUES
      (v_tenant, v_batch, 'journal',
       'AHOS-11111111-22222222-444444444444444444444444', DATE '2026-04-12',
       'transaction', gen_random_uuid(), 0, 0, v_hash);
  EXCEPTION WHEN OTHERS THEN
    v_zero_ref := true;
  END;

  IF v_unbal_ref AND v_zero_ref THEN
    RAISE NOTICE 'PASS: ⭐ an unbalanced voucher (out by ₹1,000) and an empty '
                 'one are both refused before they can reach a file.';
  ELSIF NOT v_unbal_ref THEN
    RAISE WARNING '*** FAIL — ⭐ AN UNBALANCED VOUCHER WAS ACCEPTED. Tally '
                  'rejects one part-way through an import, naming a voucher '
                  'number in a file of thousands, and on several builds it '
                  'abandons the rest — leaving an unknown prefix of the period '
                  'in the customer''s statutory books. ***';
  ELSE
    RAISE WARNING '*** FAIL — a voucher with no money on it was accepted. It '
                  'balances trivially, imports successfully and moves nothing, '
                  'which is how a bug that drops every leg reports thousands of '
                  'vouchers created and no money moved. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 7 — ⭐ TWO OF OUR ACCOUNTS MAY NOT SHARE ONE TALLY LEDGER NAME,
-- case-insensitively and whitespace-insensitively, exactly as Tally matches.
DO $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_l1     uuid := gen_random_uuid();
  v_l2     uuid := gen_random_uuid();
  v_dup_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_tallyn_' || v_tenant,
            'tallyn-' || left(v_tenant::text, 8),
            'Tally name verification', 'active');
  INSERT INTO ledgers (id, tenant_id, name, code, account_type)
    VALUES (v_l1, v_tenant, 'Sales — Residential', 'S-RES', 'revenue'),
           (v_l2, v_tenant, 'Sales — Commercial',  'S-COM', 'revenue');

  INSERT INTO tally_ledger_mappings
    (tenant_id, source_kind, source_id, tally_ledger_name, tally_parent_group)
  VALUES (v_tenant, 'ledger', v_l1, 'Sales A/c', 'sales_accounts');

  BEGIN
    -- ⚠️ Different case AND a doubled space. One ledger to Tally.
    INSERT INTO tally_ledger_mappings
      (tenant_id, source_kind, source_id, tally_ledger_name, tally_parent_group)
    VALUES (v_tenant, 'ledger', v_l2, 'sales  a/c', 'sales_accounts');
  EXCEPTION WHEN OTHERS THEN
    v_dup_ref := true;
  END;

  IF v_dup_ref THEN
    RAISE NOTICE 'PASS: ⭐ two accounts cannot be mapped to one Tally ledger '
                 'name, and the check folds case and whitespace exactly as '
                 'Tally''s own matching does.';
  ELSE
    RAISE WARNING '*** FAIL — ⭐ TWO ACCOUNTS WERE MAPPED TO ONE TALLY LEDGER. '
                  'Both post to the same ledger, Tally is happy, the books are '
                  'right — and the reconciliation can then never attribute a '
                  'difference to either of them. The report says "₹4,000 out on '
                  'Sales A/c" and can never say on what. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 8 — ⭐ A MAPPING MAY NOT POINT AT ANOTHER TENANT'S RECORD, and a
-- polymorphic column has no composite foreign key to stop it.
DO $$
DECLARE
  v_tenant_a uuid := gen_random_uuid();
  v_tenant_b uuid := gen_random_uuid();
  v_ledger_b uuid := gen_random_uuid();
  v_cross_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant_a, 'org_tallyx1_' || v_tenant_a,
            'tallyx1-' || left(v_tenant_a::text, 8), 'Tally cross A', 'active'),
           (v_tenant_b, 'org_tallyx2_' || v_tenant_b,
            'tallyx2-' || left(v_tenant_b::text, 8), 'Tally cross B', 'active');
  INSERT INTO ledgers (id, tenant_id, name, code, account_type)
    VALUES (v_ledger_b, v_tenant_b, 'B''s Sales', 'S-B', 'revenue');

  BEGIN
    INSERT INTO tally_ledger_mappings
      (tenant_id, source_kind, source_id, tally_ledger_name, tally_parent_group)
    VALUES (v_tenant_a, 'ledger', v_ledger_b, 'Sales A/c', 'sales_accounts');
  EXCEPTION WHEN OTHERS THEN
    v_cross_ref := true;
  END;

  IF v_cross_ref THEN
    RAISE NOTICE 'PASS: ⭐ a mapping cannot point at another workspace''s '
                 'ledger. Guessing ids until one is accepted would otherwise be '
                 'an existence oracle over their chart of accounts.';
  ELSE
    RAISE WARNING '*** FAIL — A MAPPING POINTED AT ANOTHER TENANT''S LEDGER. '
                  'A polymorphic column carries no composite foreign key, so if '
                  'the Section 5 trigger is not doing this, nothing is. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 9 — ⚠️ THE APPLICATION ROLE MAY NOT DELETE AN EXPORT BATCH.
-- A deleted batch does not merely lose history: the next export of that period
-- sees no prior delivery and sends every voucher as a CREATE, which is the
-- double post arriving through the cleanest-looking door in the product.
SELECT
  expected.tbl AS table_name,
  CASE WHEN NOT has_table_privilege('ordence_app', expected.tbl, 'DELETE')
       THEN 'PASS (no DELETE)'
       ELSE '*** FAIL — the application role can DELETE ' || expected.tbl ||
            '. Losing the record that a period was already exported is what '
            'makes the next export send every voucher again as a CREATE ***'
  END AS verdict
FROM (VALUES ('tally_export_batches'), ('tally_vouchers'),
             ('tally_import_batches')) AS expected(tbl)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
ORDER BY expected.tbl;
