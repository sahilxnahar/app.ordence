-- ############################################################################
-- 0149 — AN IRN IS THE GOVERNMENT'S, NOT OURS, AND THE SCHEMA MUST SAY SO
--        (Wave 15 / Track E — GST, TDS and statutory correctness)
-- ############################################################################
--
-- WHY THIS FILE EXISTS
-- -------------------
-- `sales_invoices` has carried four e-invoicing columns since 0049:
--
--     irn              varchar(64)
--     ack_no           varchar(30)
--     signed_qr_code   text
--     irn_generated_at timestamptz
--
-- 🔴 NOTHING IN THE PRODUCT READS OR WRITES ANY OF THEM. `grep -r irn app/
-- server/ lib/ components/` returns the schema definition and nothing else.
-- There is no IRP client, no `POST /invoice`, no webhook. They are four empty
-- columns with a comment above them.
--
-- ⭐ WHICH IS EXACTLY WHY THIS IS THE MOMENT TO CONSTRAIN THEM. Every rule
-- below is free today and expensive later. A constraint added to an empty
-- column is a `ALTER TABLE`; the same constraint added after the IRP
-- integration ships is a `ALTER TABLE`, a backfill, a decision about the rows
-- that violate it, and a credit-and-reissue for the ones that are wrong. This
-- codebase has done that dance enough times to stop starting it.
--
-- WHAT AN IRN ACTUALLY IS, BECAUSE THE RULES BELOW ALL FOLLOW FROM IT
-- ------------------------------------------------------------------
-- Under Rule 48(4) a notified taxpayer's invoice is not a valid tax invoice
-- unless it has been reported to an Invoice Registration Portal and carries
-- the IRN and signed QR code the IRP returned. The IRP:
--
--   · computes the IRN as a hash of (supplier GSTIN, document number,
--     document type, financial year) and issues it ONCE — a second attempt
--     for the same document returns "duplicate IRN", not a new one;
--   · SIGNS the payload. The signed QR code the customer scans contains the
--     GSTINs, the document number and date, and the taxable and tax amounts;
--   · accepts a CANCELLATION only within 24 HOURS of generation, and only if
--     no e-way bill is active against it. After 24 hours the document can be
--     amended solely through a credit note in GSTR-1.
--
-- Every one of those is a database rule, and none of them is currently one:
--
--   🔴 the IRN could be edited, or set back to NULL, by any UPDATE;
--   🔴 two documents could carry the same IRN;
--   🔴 the taxable value the IRP SIGNED could be changed afterwards, leaving a
--      signed QR code that swears to a figure the invoice no longer shows —
--      the customer scans it and gets a different number from the one printed
--      six inches above it;
--   🔴 and a cancellation could be recorded three months after generation,
--      which is a record of something that did not happen, because the IRP
--      would have refused it.
--
-- WHAT THIS FILE DOES NOT DO
-- --------------------------
-- It does not call the IRP. It does not decide whether a tenant is above the
-- turnover threshold and therefore notified. It does not make an IRN mandatory
-- — `irn_status` defaults to `not_required`, which is the truth for every row
-- that exists today and for every workspace below the threshold. It makes the
-- retrofit unnecessary, and that is all it claims.
--
-- IS THERE DATA LOSS? No. Five nullable columns, one partial unique index, one
-- BEFORE trigger. §1 refuses to proceed if any existing row would violate the
-- new uniqueness, and reports the duplicates rather than removing them.
--
-- RUN ORDER: after 0049. Independent of 0146 and 0147 — it touches the header,
-- they touch the lines — but numbered after them because it is the same wave.
-- Code push order does not matter: no code path writes these columns, so
-- nothing that works today can start failing because this landed first.
--
-- ⚠️ NO FILE-LEVEL `BEGIN`/`COMMIT`. The Neon console sends each statement on
-- its own connection and the migration gate refuses a file containing either.
-- Every statement below is independently idempotent.
-- ############################################################################


-- ############################################################################
-- SECTION 1 — REFUSE TO PROCEED OVER EXISTING VIOLATIONS
-- ############################################################################
--
-- ⭐ THIS RUNS BEFORE THE INDEX, AND THAT IS THE POINT. `CREATE UNIQUE INDEX`
-- would fail on its own with `could not create unique index` and one example
-- key — no count, no invoice numbers, no instruction. A migration that fails
-- should say what to fix.
--
-- ⚠️ SECURITY DEFINER IS NOT USED AND MUST NOT BE. This block runs as the
-- migration runner. It groups within a tenant, which is not a cross-tenant
-- read, and it quotes only invoice numbers.

DO $$
DECLARE
  v_dupes    bigint;
  v_examples text;
BEGIN
  SELECT count(*), coalesce(string_agg(sample, '; '), '')
    INTO v_dupes, v_examples
    FROM (
      SELECT tenant_id, irn,
             string_agg(invoice_number, ', ' ORDER BY invoice_number) AS sample
        FROM sales_invoices
       WHERE irn IS NOT NULL
       GROUP BY tenant_id, irn
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      '0149 REFUSED: % IRN value(s) appear on more than one invoice in the same '
      'workspace. Examples: %. Do not delete either document. The IRP issues an '
      'IRN once per (supplier GSTIN, document number, document type, financial '
      'year), so two documents holding one IRN means at least one of them is '
      'carrying a number that was never issued to it — which is a decision to '
      'make against the IRP''s own records, not a row to drop. Clear the wrong '
      'one and re-run this file.',
      v_dupes, v_examples
      USING ERRCODE = '23505';
  END IF;

  RAISE NOTICE
    '0149 §1: no duplicate IRN within any workspace. Safe to install the '
    'uniqueness.';
END
$$;


-- ############################################################################
-- SECTION 2 — THE COLUMNS THE FOUR EXISTING ONES NEEDED ALL ALONG
-- ############################################################################
--
-- ⚠️ `irn_status` IS TEXT WITH A CHECK, NOT AN ENUM, AND THAT IS DELIBERATE.
-- `sales_invoice_status` is a real enum because its values are the document's
-- lifecycle and the product branches on every one of them. These five are the
-- state of a REMOTE call whose vocabulary belongs to the IRP; a Postgres enum
-- can only be extended by `ALTER TYPE ... ADD VALUE`, which cannot run inside
-- a transaction block on older servers and cannot be reordered at all. When
-- the IRP adds a state, a CHECK is one `ALTER TABLE`.
--
-- ⭐ `not_required` IS THE DEFAULT AND IT IS THE TRUE STATEMENT ABOUT EVERY
-- ROW THAT EXISTS TODAY. A default of `pending` would silently assert that
-- every historical invoice in every workspace is waiting on a government
-- call that will never be made, and any dashboard counting pending IRNs would
-- open at the full row count of the table.

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS irn_status            text        NOT NULL DEFAULT 'not_required',
  -- When the IRP accepted the cancellation. Distinct from `cancelled_at`,
  -- which is OUR cancellation of OUR document: an invoice can have its IRN
  -- cancelled at the portal and remain, briefly, an uncancelled invoice here.
  ADD COLUMN IF NOT EXISTS irn_cancelled_at      timestamptz,
  -- The IRP requires a cancellation reason code plus free text. 200 characters
  -- is the portal's own limit on the remarks field.
  ADD COLUMN IF NOT EXISTS irn_cancel_reason     varchar(200),
  -- ⭐ SHA-256, HEX, OF THE CANONICAL JSON THAT PRODUCED THIS IRN. This is the
  -- column that makes "the signed QR code is a lie" DETECTABLE rather than
  -- merely forbidden: recompute the hash from the document as it stands now
  -- and compare. The trigger in §4 prevents the drift; this proves it after
  -- the fact, including across a restore from backup.
  ADD COLUMN IF NOT EXISTS einvoice_payload_hash char(64),
  -- Why the IRP refused. Free text because the portal's error strings are not
  -- a vocabulary we control and truncating them loses the part that matters.
  ADD COLUMN IF NOT EXISTS irn_error             text;

COMMENT ON COLUMN sales_invoices.irn_status IS
  'State of this document at the Invoice Registration Portal. not_required is '
  'the truth below the Rule 48(4) turnover threshold and is the default. 0149.';
COMMENT ON COLUMN sales_invoices.einvoice_payload_hash IS
  'SHA-256 (hex) of the canonical payload that produced the IRN. Recomputing '
  'it from the document as it stands is how signed-figure drift is detected '
  'after the fact. 0149.';
COMMENT ON COLUMN sales_invoices.irn_cancelled_at IS
  'When the IRP accepted the cancellation. The portal allows this only within '
  '24 hours of generation; §4 refuses to record a later one. 0149.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_invoices_irn_status_known') THEN
    ALTER TABLE sales_invoices
      ADD CONSTRAINT sales_invoices_irn_status_known
      CHECK (irn_status IN ('not_required', 'pending', 'generated', 'cancelled', 'failed'));
  END IF;

  -- ⚠️ A 64-CHARACTER LOWER-CASE HEX DIGEST, ENFORCED. `char(64)` alone would
  -- silently accept the payload itself truncated to 64 characters, which is
  -- exactly the mistake a hash column exists to make impossible. Same argument
  -- as 0119's `rate_limit_counters_hash_is_a_hash`, same shape.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'sales_invoices_payload_hash_is_a_hash') THEN
    ALTER TABLE sales_invoices
      ADD CONSTRAINT sales_invoices_payload_hash_is_a_hash
      CHECK (einvoice_payload_hash IS NULL OR einvoice_payload_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;


-- ############################################################################
-- SECTION 3 — ONE IRN, ONE DOCUMENT
-- ############################################################################
--
-- ⚠️ PARTIAL, ON `irn IS NOT NULL`. Without the predicate every invoice that
-- does not need an IRN — which today is all of them — collides with every
-- other one, and the index refuses the second insert into an empty table.
--
-- ⚠️ AND IT IS SCOPED TO THE TENANT, NOT GLOBAL, WHICH IS A COMPROMISE AND IS
-- ARGUED IN §6 RATHER THAN HIDDEN. An IRN is globally unique at the IRP, so
-- `UNIQUE (irn)` would be the truer statement. It would also mean one tenant
-- can discover that another tenant holds a given IRN by attempting to insert
-- it and reading the error — a unique index is enforced beneath row-level
-- security, exactly as the foreign keys in 0146 are. Tenant-scoped catches the
-- realistic failure (a retry loop writing the same IRP response twice) without
-- building a cross-tenant oracle.

CREATE UNIQUE INDEX IF NOT EXISTS sales_invoices_irn_unique_idx
  ON sales_invoices (tenant_id, irn)
  WHERE irn IS NOT NULL;

-- A partial index over the documents actually waiting on, or failing at, the
-- portal. The retry sweeper's question is "what is stuck", and without this it
-- is a sequential scan over every invoice ever raised.
CREATE INDEX IF NOT EXISTS sales_invoices_irn_status_idx
  ON sales_invoices (tenant_id, irn_status)
  WHERE irn_status IN ('pending', 'failed');


-- ############################################################################
-- SECTION 3b — EXISTING ROWS THAT ALREADY HOLD AN IRN
-- ############################################################################
--
-- ⭐ THE BACKFILL RUNS BEFORE THE TRIGGER IS INSTALLED, AND THAT ORDER IS THE
-- WHOLE POINT. `ADD COLUMN ... DEFAULT 'not_required'` gives every existing row
-- that status, including any row that already carries an IRN — for which
-- `not_required` is false. §4 refuses to hold an IRN under a status of
-- `not_required`, so a row like that would be frozen out of every future
-- UPDATE, including being marked paid. The backfill is what stops this file
-- bricking a document it was written to protect.
--
-- ⚠️ THIS EMITS A `change_log` ROW PER INVOICE TOUCHED, which is a sync event
-- every connected client will see. On this database the count is zero — the
-- columns have never been written — and the NOTICE says so out loud rather
-- than leaving it to be assumed.

DO $$
DECLARE
  v_fixed bigint;
BEGIN
  UPDATE sales_invoices
     SET irn_status = 'generated'
   WHERE irn IS NOT NULL
     AND irn_status = 'not_required';

  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  IF v_fixed > 0 THEN
    RAISE NOTICE
      '0149 §3b: % invoice(s) already held an IRN and were moved from '
      'irn_status=not_required to generated. Each emitted a change_log row.',
      v_fixed;
  ELSE
    RAISE NOTICE
      '0149 §3b: no existing invoice holds an IRN, so nothing was backfilled '
      'and no sync event was generated.';
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — THE FOUR RULES, IN ONE TRIGGER
-- ############################################################################
--
-- ⭐ A TRIGGER AND NOT FOUR CHECK CONSTRAINTS, FOR ONE REASON: TWO OF THE FOUR
-- RULES NEED `OLD`. Immutability and the figure freeze are statements about a
-- TRANSITION, and a CHECK constraint cannot see the previous row. Splitting the
-- rules across two mechanisms — the two that fit a CHECK as CHECKs, the two
-- that do not as a trigger — would mean the same subject is governed in two
-- places, which is how `enforce_gst_rate_history_immutable` and
-- `block_used_gst_rate_delete` ended up counting the same thing two different
-- ways (0146 §3). One subject, one enforcement point.
--
-- ⚠️ SECURITY INVOKER. Unlike 0147's line trigger, this one reads nothing but
-- the row in front of it. There is no lookup that RLS could blind, so there is
-- no reason to escalate, and a SECURITY DEFINER function that does not need to
-- be one is a privilege-escalation surface bought for nothing.
--
-- ⚠️ AND IT DOES NOT DUPLICATE `sales_invoice_freeze_after_issue`. That trigger
-- (0049 §1) freezes the same figures once the document is ISSUED, and
-- deliberately leaves `irn`, `ack_no`, `signed_qr_code` and the e-way bill
-- columns movable, because the Government assigns those AFTER we issue. This
-- one is keyed on the IRN EXISTING, not on the status, and the two answer
-- different questions:
--
--     issued, no IRN yet   → 0049 freezes the figures. 0149 says nothing.
--     draft, IRN present   → 0049 says nothing. 0149 freezes the figures.
--     issued, IRN present  → both freeze. The first to raise wins; both name
--                            a true reason.
--
-- Trigger order on a table is alphabetical by name, so `sales_invoices_freeze`
-- fires before `sales_invoices_irn_integrity`. In the overlapping case the
-- message the user sees is 0049's, which mentions the credit note. That is the
-- better message of the two and the ordering was checked, not assumed.

CREATE OR REPLACE FUNCTION enforce_sales_invoice_irn_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  /* ─────────────────────────────────────────────────────────────────────
   * A. THE IRN IS IMMUTABLE ONCE ISSUED
   * ─────────────────────────────────────────────────────────────────────
   * Not ours to change and not ours to withdraw. The IRP issued this string
   * against this document; if it is wrong the remedy is a cancellation at
   * the portal (within 24 hours) or a credit note (after), both of which
   * leave the IRN exactly where it is. Setting it back to NULL is the more
   * dangerous half — it makes a reported document look unreported, and the
   * next sync run reports it again and gets "duplicate IRN" from the IRP
   * with no local record of why.
   */
  IF TG_OP = 'UPDATE' AND OLD.irn IS NOT NULL
     AND NEW.irn IS DISTINCT FROM OLD.irn THEN
    RAISE EXCEPTION
      'Invoice % already carries IRN %, and an IRN cannot be changed or '
      'removed. The Invoice Registration Portal issued it against this exact '
      'document and holds its own copy; editing ours makes the two disagree '
      'without making theirs wrong. Cancel it at the portal within 24 hours, '
      'or raise a credit note (Rule 53) after.',
      OLD.invoice_number, OLD.irn
      USING ERRCODE = 'check_violation';
  END IF;

  /* ─────────────────────────────────────────────────────────────────────
   * B. A STATUS WITHOUT ITS ARTEFACTS IS A LIE — AND SO IS THE MIRROR
   * ─────────────────────────────────────────────────────────────────────
   * `generated` is a claim that a specific government call returned. The
   * evidence of that call is the IRN, the acknowledgement number and the
   * timestamp. A row claiming it without them is a row that will be filed
   * in GSTR-1 as e-invoiced and reconciled against nothing.
   */
  IF NEW.irn_status = 'generated'
     AND (NEW.irn IS NULL OR NEW.ack_no IS NULL OR NEW.irn_generated_at IS NULL) THEN
    RAISE EXCEPTION
      'Invoice % is marked irn_status=generated but is missing %. An IRN was '
      'either returned by the portal, in which case all three of the IRN, the '
      'acknowledgement number and the generation time came back with it, or it '
      'was not, in which case the status is pending or failed.',
      NEW.invoice_number,
      concat_ws(', ',
        CASE WHEN NEW.irn IS NULL              THEN 'the IRN' END,
        CASE WHEN NEW.ack_no IS NULL           THEN 'the acknowledgement number' END,
        CASE WHEN NEW.irn_generated_at IS NULL THEN 'the generation timestamp' END)
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⭐ THE MIRROR. Holding an IRN while claiming the document did not need one,
  -- is still waiting for one, or failed to get one, is the same lie read from
  -- the other end. `failed` in particular means the portal REFUSED — there is
  -- no IRN to hold.
  IF NEW.irn IS NOT NULL AND NEW.irn_status NOT IN ('generated', 'cancelled') THEN
    RAISE EXCEPTION
      'Invoice % holds IRN % but is marked irn_status=%. A document that holds '
      'an IRN was registered; the only honest states for it are generated and '
      'cancelled.',
      NEW.invoice_number, NEW.irn, NEW.irn_status
      USING ERRCODE = 'check_violation';
  END IF;

  /* ─────────────────────────────────────────────────────────────────────
   * C. A CANCELLATION THE IRP WOULD HAVE REFUSED DID NOT HAPPEN
   * ─────────────────────────────────────────────────────────────────────
   * The portal accepts a cancellation only within 24 hours of generation.
   * Recording one outside that window is not a policy disagreement — it is
   * recording an event the other party rejected. The document is still live
   * at the IRP, still in the buyer's GSTR-2B, and our books say it is gone.
   *
   * ⚠️ `irn_generated_at` MUST BE PRESENT FOR THE WINDOW TO MEAN ANYTHING.
   * Without this clause the comparison against a NULL generation time is
   * NULL, the IF is not taken, and the rule silently passes on exactly the
   * rows that have no evidence at all. A check that skips when it cannot
   * see its input is the defect this wave was opened to remove.
   */
  IF NEW.irn_status = 'cancelled' THEN
    IF NEW.irn IS NULL OR NEW.irn_generated_at IS NULL THEN
      RAISE EXCEPTION
        'Invoice % is marked irn_status=cancelled but has no IRN and/or no '
        'generation time. There is nothing at the portal to have cancelled.',
        NEW.invoice_number
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.irn_cancelled_at IS NULL THEN
      RAISE EXCEPTION
        'Invoice % is marked irn_status=cancelled with no irn_cancelled_at. '
        'The 24-hour window the portal allows can only be checked against the '
        'moment the cancellation was accepted, so a cancellation without one '
        'cannot be shown to have been possible.',
        NEW.invoice_number
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.irn_cancelled_at > NEW.irn_generated_at + interval '24 hours' THEN
      RAISE EXCEPTION
        'Invoice % records its IRN as cancelled at %, which is % after it was '
        'generated at %. The Invoice Registration Portal accepts a '
        'cancellation only within 24 hours; it would have refused this one. '
        'The document is still live at the portal and still in the buyer''s '
        'GSTR-2B — the lawful remedy after the window closes is a credit note '
        '(Rule 53), which is its own numbered document.',
        NEW.invoice_number, NEW.irn_cancelled_at,
        justify_interval(NEW.irn_cancelled_at - NEW.irn_generated_at),
        NEW.irn_generated_at
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.irn_cancelled_at < NEW.irn_generated_at THEN
      RAISE EXCEPTION
        'Invoice % records its IRN as cancelled at %, before it was generated '
        'at %.',
        NEW.invoice_number, NEW.irn_cancelled_at, NEW.irn_generated_at
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  /* ─────────────────────────────────────────────────────────────────────
   * D. THE IRP HAS SIGNED THESE FIGURES
   * ─────────────────────────────────────────────────────────────────────
   * ⭐ THIS IS THE RULE THE OTHER THREE EXIST TO SUPPORT.
   *
   * The signed QR code the customer scans carries the supplier GSTIN, the
   * buyer GSTIN, the document number and date, and the taxable and tax
   * amounts. It is signed by the IRP's key and we cannot re-sign it. So the
   * instant any of those columns moves while an IRN is live, the QR code
   * printed on the document swears to a figure the document no longer
   * shows, and the customer scanning it gets a different answer from the
   * one printed six inches above it.
   *
   * ⚠️ KEYED ON `OLD.irn_status`, NOT `NEW`. The transition that CANCELS the
   * IRN must be allowed through — it changes the status and nothing else —
   * but a single UPDATE that cancels the IRN AND restates the figures must
   * not be. Reading OLD means the freeze is decided by what the document was
   * when the statement began, so cancel-and-restate is refused and
   * cancel-then-restate (two statements, in that order, with the second one
   * looking at an already-cancelled document) is allowed. That is the same
   * shape as the 24-hour rule: the portal has to have let go first.
   */
  IF TG_OP = 'UPDATE' AND OLD.irn IS NOT NULL AND OLD.irn_status <> 'cancelled' THEN
    IF NEW.taxable_value_minor  IS DISTINCT FROM OLD.taxable_value_minor
    OR NEW.cgst_minor           IS DISTINCT FROM OLD.cgst_minor
    OR NEW.sgst_minor           IS DISTINCT FROM OLD.sgst_minor
    OR NEW.igst_minor           IS DISTINCT FROM OLD.igst_minor
    OR NEW.cess_minor           IS DISTINCT FROM OLD.cess_minor
    OR NEW.total_minor          IS DISTINCT FROM OLD.total_minor
    OR NEW.supplier_gstin       IS DISTINCT FROM OLD.supplier_gstin
    OR NEW.customer_gstin       IS DISTINCT FROM OLD.customer_gstin
    OR NEW.invoice_number       IS DISTINCT FROM OLD.invoice_number
    OR NEW.invoice_date         IS DISTINCT FROM OLD.invoice_date
    OR NEW.place_of_supply_code IS DISTINCT FROM OLD.place_of_supply_code
    THEN
      RAISE EXCEPTION
        'Invoice % carries IRN % and its figures are signed. The Invoice '
        'Registration Portal hashed and signed the GSTINs, the document number '
        'and date, the place of supply and the tax amounts; the QR code on the '
        'document your customer holds attests to the values as they were. '
        'Changing them here does not change what was signed — it only makes '
        'the signature disagree with the invoice. Cancel the IRN at the portal '
        'within 24 hours of generation, or raise a credit note (Rule 53).',
        OLD.invoice_number, OLD.irn
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_sales_invoice_irn_integrity() IS
  'An IRN is immutable, unique to one document, consistent with its own '
  'status, cancellable only inside the IRP''s 24-hour window, and freezes the '
  'figures the IRP signed. 0149.';

DROP TRIGGER IF EXISTS sales_invoices_irn_integrity ON sales_invoices;
CREATE TRIGGER sales_invoices_irn_integrity
  BEFORE INSERT OR UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION enforce_sales_invoice_irn_integrity();


-- ############################################################################
-- SECTION 5 — SELF-VERIFICATION: ATTEMPT THE WRITES, DO NOT ASK THE CATALOGUE
-- ############################################################################
--
-- ⭐ EVERY CHECK BELOW PERFORMS A WRITE AND RECORDS WHETHER IT WAS REFUSED.
-- `SELECT count(*) FROM pg_trigger WHERE tgname = 'sales_invoices_irn_integrity'`
-- proves a name was registered. It does not prove the trigger refuses anything,
-- and this codebase has been bitten by exactly that distance often enough to
-- have stopped writing it.
--
-- The whole probe is one sub-block ended by a sentinel exception, so every row
-- it wrote is discarded. plpgsql variables are not transactional, so the
-- verdicts survive the rollback and the assertions below read them.
--
-- ⚠️ `v_ran` IS ASSERTED FIRST. If a fixture insert failed for an unrelated
-- reason every `r_*` flag would still read false, and a "did it refuse?"
-- assertion can be made to pass on a probe that never happened.
--
-- ⚠️ THE NEGATIVE CASES ARE NOT OPTIONAL. Five of the twelve assert that a
-- CORRECT write is still ACCEPTED. A trigger that refuses everything passes
-- every refusal test and takes the product down on the first invoice.
--
-- ⚠️ AND THE FIXTURE INVOICES ARE `draft` ON PURPOSE. 0049's freeze trigger
-- refuses the same figure edits once a document is issued. Probing on an
-- issued invoice would prove that THAT trigger works and tell us nothing about
-- this one. Check 12 issues a separate invoice specifically to prove 0049 is
-- still intact.

DO $$
DECLARE
  v_t        uuid := gen_random_uuid();
  v_co       uuid := gen_random_uuid();
  v_a        uuid := gen_random_uuid();   -- live IRN, draft
  v_b        uuid := gen_random_uuid();   -- second document, for uniqueness
  v_c        uuid := gen_random_uuid();   -- no IRN at all
  v_d        uuid := gen_random_uuid();   -- cancellation subject
  v_e        uuid := gen_random_uuid();   -- issued, for the 0049 regression
  v_irn      text := repeat('a', 64);
  v_gen      timestamptz := timestamptz '2026-08-19 10:00:00+05:30';

  v_ran            boolean := false;
  r_irn_changed    boolean := false;
  r_irn_nulled     boolean := false;
  r_status_no_ack  boolean := false;
  r_irn_bad_status boolean := false;
  r_late_cancel    boolean := false;
  r_cancel_no_time boolean := false;
  r_figures_frozen boolean := false;
  r_duplicate_irn  boolean := false;
  a_first_assign   boolean := false;
  a_cancel_in_time boolean := false;
  a_notes_move     boolean := false;
  a_no_irn_edit    boolean := false;
  a_0049_intact    boolean := false;
  v_err            text := '';
BEGIN
  BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_t, 'org_0149_' || substr(v_t::text, 1, 8),
            '0149-probe-' || substr(v_t::text, 1, 8), '0149 probe', 'active');
    INSERT INTO companies (id, tenant_id, name) VALUES (v_co, v_t, '0149 probe customer');

    INSERT INTO sales_invoices
      (id, tenant_id, invoice_number, financial_year, status, company_id,
       invoice_date, place_of_supply_code, is_inter_state, supply_type, currency,
       supplier_gstin, customer_gstin,
       taxable_value_minor, igst_minor, total_minor)
    VALUES
      (v_a, v_t, '0149-A', '2026-27', 'draft', v_co, DATE '2026-08-19', '29', true,
       'services', 'INR', '27AAAAA0000A1Z5', '29BBBBB0000B1Z4', 100000, 18000, 118000),
      (v_b, v_t, '0149-B', '2026-27', 'draft', v_co, DATE '2026-08-19', '29', true,
       'services', 'INR', '27AAAAA0000A1Z5', '29BBBBB0000B1Z4', 100000, 18000, 118000),
      (v_c, v_t, '0149-C', '2026-27', 'draft', v_co, DATE '2026-08-19', '29', true,
       'services', 'INR', '27AAAAA0000A1Z5', '29BBBBB0000B1Z4', 100000, 18000, 118000),
      (v_d, v_t, '0149-D', '2026-27', 'draft', v_co, DATE '2026-08-19', '29', true,
       'services', 'INR', '27AAAAA0000A1Z5', '29BBBBB0000B1Z4', 100000, 18000, 118000);

    -- ── ACCEPTANCE 1: THE FIRST ASSIGNMENT MUST WORK ────────────────────
    -- Everything else in this probe depends on it, so it runs first and its
    -- failure is reported as a failure rather than swallowed.
    BEGIN
      UPDATE sales_invoices
         SET irn = v_irn, ack_no = '112010000000123',
             irn_generated_at = v_gen, irn_status = 'generated',
             signed_qr_code = 'eyJhbGciOiJSUzI1NiJ9.probe',
             einvoice_payload_hash = repeat('0', 64)
       WHERE id = v_a;
      a_first_assign := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [assign] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- Same, on D, which will be cancelled inside the window.
    UPDATE sales_invoices
       SET irn = repeat('d', 64), ack_no = '112010000000999',
           irn_generated_at = v_gen, irn_status = 'generated'
     WHERE id = v_d;

    /* ── REFUSALS ─────────────────────────────────────────────────────── */

    -- 1. The IRN changed to a different value.
    BEGIN
      UPDATE sales_invoices SET irn = repeat('b', 64) WHERE id = v_a;
    EXCEPTION WHEN check_violation THEN r_irn_changed := true;
    END;

    -- 2. The IRN withdrawn. The more dangerous half: a reported document that
    --    looks unreported gets reported again and the IRP answers "duplicate".
    BEGIN
      UPDATE sales_invoices SET irn = NULL WHERE id = v_a;
    EXCEPTION WHEN check_violation THEN r_irn_nulled := true;
    END;

    -- 3. irn_status=generated with no acknowledgement number.
    BEGIN
      UPDATE sales_invoices
         SET irn_status = 'generated', irn_generated_at = v_gen
       WHERE id = v_c;
    EXCEPTION WHEN check_violation THEN r_status_no_ack := true;
    END;

    -- 4. The mirror: an IRN held under a status that denies it exists.
    BEGIN
      UPDATE sales_invoices SET irn_status = 'pending' WHERE id = v_a;
    EXCEPTION WHEN check_violation THEN r_irn_bad_status := true;
    END;

    -- 5. A cancellation recorded 48 hours after generation. The IRP would have
    --    refused it, so this is a record of something that did not happen.
    BEGIN
      UPDATE sales_invoices
         SET irn_status = 'cancelled',
             irn_cancelled_at = v_gen + interval '48 hours',
             irn_cancel_reason = '2 - Data entry mistake'
       WHERE id = v_d;
    EXCEPTION WHEN check_violation THEN r_late_cancel := true;
    END;

    -- 6. A cancellation with no time at all, which is the version of the same
    --    row that a NULL-blind check would let through.
    BEGIN
      UPDATE sales_invoices SET irn_status = 'cancelled' WHERE id = v_d;
    EXCEPTION WHEN check_violation THEN r_cancel_no_time := true;
    END;

    -- 7. ⭐ THE SIGNED FIGURES MOVED. This is the rule the file exists for.
    BEGIN
      UPDATE sales_invoices
         SET taxable_value_minor = 200000, igst_minor = 36000, total_minor = 236000
       WHERE id = v_a;
    EXCEPTION WHEN check_violation THEN r_figures_frozen := true;
    END;

    -- 8. The same IRN on a second document in the same workspace.
    BEGIN
      UPDATE sales_invoices
         SET irn = v_irn, ack_no = '112010000000124',
             irn_generated_at = v_gen, irn_status = 'generated'
       WHERE id = v_b;
    EXCEPTION WHEN unique_violation THEN r_duplicate_irn := true;
    END;

    /* ── ACCEPTANCES ──────────────────────────────────────────────────── */

    -- 9. A cancellation INSIDE the window. Recording what the portal actually
    --    allows must not be harder than recording what it does not.
    BEGIN
      UPDATE sales_invoices
         SET irn_status = 'cancelled',
             irn_cancelled_at = v_gen + interval '3 hours',
             irn_cancel_reason = '1 - Duplicate'
       WHERE id = v_d;
      a_cancel_in_time := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [9] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 10. A column the IRP never saw, on a document with a live IRN. Freezing
    --     the whole row would stop an invoice being marked paid, which is how
    --     a correctness control becomes an outage and then gets dropped.
    BEGIN
      UPDATE sales_invoices SET notes = '0149 probe note' WHERE id = v_a;
      a_notes_move := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [10] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 11. A draft with NO IRN must still be freely editable. Below the Rule
    --     48(4) threshold this is every invoice in the product.
    BEGIN
      UPDATE sales_invoices
         SET taxable_value_minor = 250000, igst_minor = 45000, total_minor = 295000
       WHERE id = v_c;
      a_no_irn_edit := true;
    EXCEPTION WHEN others THEN v_err := v_err || ' [11] ' || SQLSTATE || ' ' || SQLERRM;
    END;

    -- 12. ⭐ 0049'S FREEZE TRIGGER MUST STILL BITE. This file added a second
    --     BEFORE UPDATE trigger to the same table; the regression to be afraid
    --     of is not that the new one fails but that the old one stopped.
    INSERT INTO sales_invoices
      (id, tenant_id, invoice_number, financial_year, status, company_id,
       invoice_date, place_of_supply_code, is_inter_state, supply_type, currency,
       issued_at, taxable_value_minor, igst_minor, total_minor)
    VALUES
      (v_e, v_t, '0149-E', '2026-27', 'issued', v_co, DATE '2026-08-19', '29', true,
       'services', 'INR', now(), 100000, 18000, 118000);

    BEGIN
      UPDATE sales_invoices SET total_minor = 999999 WHERE id = v_e;
    EXCEPTION WHEN check_violation THEN a_0049_intact := true;
    END;

    v_ran := true;
    RAISE EXCEPTION '0149_PROBE_ROLLBACK' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> '0149_PROBE_ROLLBACK' THEN RAISE; END IF;
  END;

  IF NOT v_ran THEN
    RAISE EXCEPTION
      '0149 FAILED: the verification probe did not reach its own last line, so '
      'every verdict it recorded is meaningless. Do not read this as a pass. '
      'Errors collected: %', v_err;
  END IF;

  IF NOT a_first_assign THEN
    RAISE EXCEPTION
      '0149 FAILED: the FIRST assignment of an IRN to an invoice was refused '
      'with: %. Every other verdict in this probe was measured against a '
      'document that never got an IRN, so none of them mean anything, and the '
      'file has made e-invoicing impossible rather than correct.', v_err;
  END IF;

  IF NOT r_irn_changed THEN
    RAISE EXCEPTION '0149 FAILED: an existing IRN was changed to a different value and accepted.';
  END IF;
  IF NOT r_irn_nulled THEN
    RAISE EXCEPTION '0149 FAILED: an existing IRN was set back to NULL and accepted.';
  END IF;
  IF NOT r_status_no_ack THEN
    RAISE EXCEPTION '0149 FAILED: irn_status=generated was accepted with no IRN and no acknowledgement number.';
  END IF;
  IF NOT r_irn_bad_status THEN
    RAISE EXCEPTION '0149 FAILED: an invoice holding an IRN was accepted under irn_status=pending.';
  END IF;
  IF NOT r_late_cancel THEN
    RAISE EXCEPTION '0149 FAILED: an IRN cancellation recorded 48 hours after generation was accepted. The portal would have refused it.';
  END IF;
  IF NOT r_cancel_no_time THEN
    RAISE EXCEPTION '0149 FAILED: irn_status=cancelled was accepted with no irn_cancelled_at, so the 24-hour rule was never evaluated.';
  END IF;
  IF NOT r_figures_frozen THEN
    RAISE EXCEPTION '0149 FAILED: the taxable value and tax of an invoice carrying a live IRN were changed and accepted. The signed QR code on that document now attests to a different figure.';
  END IF;
  IF NOT r_duplicate_irn THEN
    RAISE EXCEPTION '0149 FAILED: the same IRN was accepted on two invoices in one workspace.';
  END IF;

  IF NOT (a_cancel_in_time AND a_notes_move AND a_no_irn_edit) THEN
    RAISE EXCEPTION
      '0149 FAILED: a CORRECT write was refused. cancel_within_24h=% '
      'note_on_irn_document=% edit_of_document_with_no_irn=%. Errors:%. A '
      'control that refuses correct documents is worse than the gap it closed.',
      a_cancel_in_time, a_notes_move, a_no_irn_edit, v_err;
  END IF;

  IF NOT a_0049_intact THEN
    RAISE EXCEPTION
      '0149 FAILED: 0049''s sales_invoices_freeze no longer refuses an edit to '
      'the total of an ISSUED invoice. This file was required not to disturb '
      'it and has.';
  END IF;

  RAISE NOTICE
    '0149 PASS: eight wrong writes were ATTEMPTED and REFUSED (IRN changed, '
    'IRN withdrawn, generated without an ack number, an IRN held under '
    'irn_status=pending, a cancellation 48h after generation, a cancellation '
    'with no time, the signed figures restated under a live IRN, and the same '
    'IRN on two documents) and five correct writes were ATTEMPTED and ACCEPTED '
    '(the first IRN assignment, a cancellation 3h after generation, a note on '
    'a document holding an IRN, a full figure edit on a document with no IRN, '
    'and 0049''s freeze still refusing an edit to an issued invoice). All '
    'probe rows were rolled back and nothing was left behind.';
END
$$;


-- ############################################################################
-- SECTION 6 — WHAT THIS FILE DELIBERATELY LEAVES OPEN
-- ############################################################################
--
-- ⚠️ IT DOES NOT MAKE AN IRN MANDATORY FOR ANYBODY. Rule 48(4) applies above a
-- turnover threshold that this database does not record, and no code path
-- populates any of these columns. A NOT NULL, or a status default of
-- `pending`, would refuse or mislabel every invoice the product currently
-- raises. When the IRP client ships, the rule "this tenant is notified,
-- therefore irn_status may not be not_required" belongs next to the code that
-- knows the turnover — with a coverage NUMBER reported here, not a floor
-- asserted.
--
-- ⚠️ UNIQUENESS IS PER TENANT, NOT GLOBAL. Argued in §3: a global unique index
-- is enforced beneath row-level security, so it would let one workspace probe
-- for another's IRN by attempting an insert and reading the error. The
-- realistic failure — a retry loop writing one IRP response twice — is caught
-- either way.
--
-- ⚠️ `einvoice_payload_hash` IS STORED AND NEVER VERIFIED HERE. Computing the
-- canonical e-invoice JSON is the IRP client's job and involves rules (field
-- order, which optional blocks are omitted, how quantities are formatted) that
-- have no business being transcribed into SQL — that is the argument 0147 §1
-- had to make for two rounding primitives, and it does not stretch this far.
-- What the column buys today is that drift becomes DETECTABLE after a restore
-- or a manual edit that bypassed the trigger, which is worth having before the
-- client exists.
--
-- ⚠️ IT DOES NOT FREEZE THE LINES. §D freezes the header figures the IRP
-- signed. 0049's `sales_invoice_lines_freeze` already refuses any line change
-- once the parent leaves `draft`, so an issued-and-reported document is
-- covered; a DRAFT document carrying an IRN is not, because that combination
-- should not exist and this file does not have the standing to forbid it —
-- `status` is 0049's column and the IRP client will be the thing that decides
-- an IRN is only requested at issue.
--
-- ⚠️ IT SAYS NOTHING ABOUT THE E-WAY BILL. `eway_bill_no` and `eway_bill_date`
-- have the same problem — unreferenced, unconstrained — and an active e-way
-- bill is one of the two reasons the IRP refuses a cancellation. That rule
-- cannot be written until something populates those columns, and it is listed
-- rather than guessed at.
-- ############################################################################
