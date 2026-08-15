-- =====================================================================
--  ORDENCE — 0078 · REAL ESTATE COMPLETION
--  Version: v1.25.0-alpha · Batch 17
--
--  ⚠️ RUN AFTER 0077. One new table, one new enum, seven new columns on
--  `bookings`, two triggers. Touches no existing column's type and
--  drops nothing.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded.
--  ⭐ ADDITIVE ONLY, so a code rollback leaves all of it sitting
--     harmless — the new columns are nullable and the new table is
--     simply unread.
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  WHAT THIS CLOSES
--  ══════════════════════════════════════════════════════════════════
--  `check-posting-coverage.mjs` has carried the same note against
--  `sales-bookings` for eleven sessions:
--
--     "A booking reserves a unit and moves no money. What is missing is
--      cancellation forfeiture and channel-partner brokerage — neither
--      has an action yet."
--
--  Both are money. A cancellation disposes of everything the buyer paid
--  and writes off everything they owed. Brokerage is the largest single
--  selling cost a developer has, and it carries a TDS liability that
--  the department collects interest on.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴 THE CANCELLATION IS THE HARD ONE, AND THE WRONG VERSION BALANCES
--  ══════════════════════════════════════════════════════════════════
--  `Dr Advance / Cr Forfeiture income` for the amount kept is a valid,
--  balanced journal. It also leaves the refund unrecorded, the unpaid
--  demands sitting as a receivable against a buyer who has gone, and
--  the output tax still owed on a sale that did not happen.
--
--  A cancellation has to return EVERY balance on the booking to zero,
--  in one entry, and there is exactly one arrangement that does:
--
--      Dr  Advance from customers      the whole advance standing
--      Dr  Output CGST/SGST/IGST       whatever the credit note reverses
--      Dr  Irrecoverable output tax    whatever it could not
--            Cr  Forfeiture income     kept
--            Cr  Buyer refund payable  going back
--            Cr  Booking receivable    demands raised and never paid
--
--  🔴 AND THE SECOND DEBIT IS THE ONE NOBODY EXPECTS. Section 34(2)
--  allows a credit note only until 30 NOVEMBER FOLLOWING THE END OF THE
--  FINANCIAL YEAR OF THE SUPPLY. A developer's demands run for three
--  years, so a cancellation in year three cannot reverse the tax
--  charged in year one. That tax is gone: paid to the Government on a
--  flat that was never sold, not creditable, and a real cost of the
--  cancellation. It gets its own account so it is visible instead of
--  being netted into forfeiture income, where it would overstate what
--  the developer actually kept.
-- =====================================================================

BEGIN;

-- =====================================================================
--  SECTION 1 · THE CANCELLATION COLUMNS ON `bookings`
-- =====================================================================
--
--  🔴 THE FIGURES ARE STORED, NOT RECOMPUTED LATER. What the credit
--  note reversed depends on the section 34 window, which depends on the
--  date the cancellation was posted. Re-deriving it next year gives a
--  different answer to the same question, and the journal that was
--  actually posted would then have no document behind it that agrees.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS gst_credit_note_number  varchar(40),
    ADD COLUMN IF NOT EXISTS reversed_cgst_minor     bigint,
    ADD COLUMN IF NOT EXISTS reversed_sgst_minor     bigint,
    ADD COLUMN IF NOT EXISTS reversed_igst_minor     bigint,
    --  ⚠️ Set by the posting path only. Null means the cancellation has
    --  been recorded and has NOT reached the ledger, which is a real and
    --  common state — the accounts may be mapped later than the sale
    --  team cancels.
    ADD COLUMN IF NOT EXISTS cancellation_posted_at  timestamptz,
    --  ⚠️ SEPARATE FROM `cancelled_at`, AND OFTEN MONTHS AFTER IT. "How
    --  long did this buyer wait for their money" is a question a
    --  consumer forum asks in those words, and one date cannot answer
    --  it.
    ADD COLUMN IF NOT EXISTS refund_paid_at          timestamptz,
    ADD COLUMN IF NOT EXISTS refund_reference        varchar(60);

DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_reversal_non_negative
    CHECK ((reversed_cgst_minor IS NULL OR reversed_cgst_minor >= 0)
       AND (reversed_sgst_minor IS NULL OR reversed_sgst_minor >= 0)
       AND (reversed_igst_minor IS NULL OR reversed_igst_minor >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--  ⚠️ A REFUND CANNOT BE PAID BEFORE THE CANCELLATION IS RECORDED.
--  Money leaving against a booking that is still live is either a
--  mis-keyed reference or a refund nobody approved, and both are worth
--  refusing at the row rather than explaining in a reconciliation.
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_refund_after_cancel
    CHECK (refund_paid_at IS NULL OR cancelled_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================================
--  SECTION 2 · THE GUARD: A POSTED CANCELLATION IS FROZEN
-- =====================================================================
--
--  🔴 ONCE THE CANCELLATION IS IN THE LEDGER, ITS FIGURES ARE IN A
--  TRIAL BALANCE AND POSSIBLY IN A FILED RETURN.
--
--  Editing the forfeit afterwards produces a booking whose numbers
--  disagree with the journal that was posted from them — and the
--  journal is the one an auditor reads. There is no "correct the
--  forfeit" operation in accounting; there is a further entry, dated
--  when the decision changed, which is a conversation the operator
--  should be having rather than an edit.
--
--  ⚠️ NOTE WHAT REMAINS EDITABLE: the refund payment fields. Paying the
--  refund is a LATER event and the whole point of the payable, so
--  freezing those would make the liability permanent.
CREATE OR REPLACE FUNCTION ordence_guard_posted_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.cancellation_posted_at IS NOT NULL THEN
    IF NEW.forfeit_amount_minor  IS DISTINCT FROM OLD.forfeit_amount_minor
       OR NEW.refund_amount_minor IS DISTINCT FROM OLD.refund_amount_minor
       OR NEW.reversed_cgst_minor IS DISTINCT FROM OLD.reversed_cgst_minor
       OR NEW.reversed_sgst_minor IS DISTINCT FROM OLD.reversed_sgst_minor
       OR NEW.reversed_igst_minor IS DISTINCT FROM OLD.reversed_igst_minor
       OR NEW.gst_credit_note_number IS DISTINCT FROM OLD.gst_credit_note_number
       OR NEW.cancellation_posted_at IS DISTINCT FROM OLD.cancellation_posted_at
       OR NEW.status IS DISTINCT FROM OLD.status
    THEN
      RAISE EXCEPTION
        'This cancellation has already been posted to the ledger. Its forfeit, refund and tax reversal are in a trial balance and cannot be edited here. If the decision has changed, post a further entry dated when it changed — that is what an auditor expects to find, and it leaves both decisions on the record.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  --  ⚠️ AND A CANCELLED BOOKING MAY NOT BE UN-CANCELLED even before it
  --  posts. The unit has been released and may already be re-sold; a
  --  booking coming back to life would put two buyers on one flat, which
  --  is the exact failure `bookings_one_live_per_unit` exists to stop
  --  and which it cannot catch on an UPDATE that revives the loser.
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION
      'This booking has been cancelled and the unit released. Reviving it could put two buyers on one flat. Create a new booking instead, which is also what the paper trail should show.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_posted_cancellation ON bookings;
CREATE TRIGGER ordence_guard_posted_cancellation
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_posted_cancellation();

-- =====================================================================
--  SECTION 3 · CHANNEL-PARTNER COMMISSIONS
-- =====================================================================
--
--  ══════════════════════════════════════════════════════════════════
--  ⭐ WHY BROKERAGE NEEDS A DOCUMENT AND NOT A COLUMN ON THE BOOKING
--  ══════════════════════════════════════════════════════════════════
--  `lib/sales/commission.ts` has been able to COMPUTE brokerage since
--  Phase 22, and the partner screen has shown the figure for almost as
--  long. Nothing has ever recorded it, so nothing has ever posted it.
--
--    • Brokerage is paid in TRANCHES — part on agreement, part on
--      registration, part on possession. A column holds only the last.
--    • The 194H threshold is tested on everything credited to that
--      partner in the SAME FINANCIAL YEAR, so each tranche has to be a
--      dated row or the threshold cannot be applied at all.
--    • The rate is resolved against the credit date and STORED, because
--      a statement for a closed year has to reproduce the rate that was
--      right then. 194H was 5% until 30 September 2024 and 2% after.
--    • And a broker disputes a figure a year later. The answer has to
--      be a document with a date on it.

DO $$ BEGIN
  CREATE TYPE commission_status AS ENUM
    ('draft', 'approved', 'posted', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS channel_partner_commissions (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    --  ⚠️ RESTRICT, NOT CASCADE. Deleting a partner must not take a
    --  posted brokerage bill with it — the journal entry would survive
    --  and its counterparty would not.
    partner_id                uuid NOT NULL
                                REFERENCES channel_partners(id) ON DELETE RESTRICT,
    --  Nullable: a referral fee is sometimes not tied to one booking.
    booking_id                uuid REFERENCES bookings(id) ON DELETE SET NULL,

    reference                 varchar(40) NOT NULL,
    status                    commission_status NOT NULL DEFAULT 'draft',

    --  🔴 THE CREDIT DATE. The 194H rate, the annual threshold and the
    --  financial year all resolve against this and never against now().
    credited_on               date NOT NULL,

    basis                     commission_basis NOT NULL,
    rate_bps                  integer,
    months_centis             integer,
    flat_minor                bigint,
    consideration_minor       bigint,
    workings                  text NOT NULL,

    gross_minor               bigint NOT NULL,

    partner_invoice_number    varchar(40),
    partner_invoice_date      date,
    cgst_minor                bigint NOT NULL DEFAULT 0,
    sgst_minor                bigint NOT NULL DEFAULT 0,
    igst_minor                bigint NOT NULL DEFAULT 0,
    --  🔴 FALSE BY DEFAULT, DELIBERATELY. Most residential projects sit
    --  on the 1%/5% concessional rate under Notification 3/2019 and get
    --  NO input credit at all. Defaulting to true would claim blocked
    --  credit on every brokerage bill in the commonest configuration in
    --  the market — a demand with interest and penalty on it.
    itc_eligible              boolean NOT NULL DEFAULT false,

    tds_minor                 bigint NOT NULL DEFAULT 0,
    tds_rate_bps              integer NOT NULL DEFAULT 0,
    --  ⭐ THE WHOLE YEAR'S BASE, not this bill's. 194H is an
    --  `aggregate_whole` threshold: once the year crosses ₹20,000, tax
    --  is due on everything credited in it, including the tranches paid
    --  earlier while the running total was still below.
    tds_chargeable_base_minor bigint NOT NULL DEFAULT 0,
    tds_explanation           text,

    net_payable_minor         bigint NOT NULL,

    approved_at               timestamptz,
    approved_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    posted_at                 timestamptz,
    paid_at                   timestamptz,
    payment_reference         varchar(60),

    note                      text,

    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    --  ⭐ THE ARITHMETIC IS A DATABASE GUARANTEE. net = gross + tax −
    --  TDS. A row that fails this produces a journal that does not
    --  balance, and refusing it here gives a message about the bill
    --  rather than about the ledger.
    CONSTRAINT cp_commissions_adds_up CHECK (
        net_payable_minor = gross_minor + cgst_minor + sgst_minor + igst_minor - tds_minor
    ),
    CONSTRAINT cp_commissions_amounts_non_negative CHECK (
        gross_minor >= 0 AND cgst_minor >= 0 AND sgst_minor >= 0
        AND igst_minor >= 0 AND tds_minor >= 0 AND net_payable_minor >= 0
    ),
    --  ⚠️ 20% under section 206AA is the highest this can legitimately
    --  be. Tax exceeding the fee is a units error — paise passed where
    --  rupees were expected produces exactly this shape.
    CONSTRAINT cp_commissions_tds_sane CHECK (tds_minor <= gross_minor),
    --  🔴 GST ONLY WITH AN INVOICE NUMBER. Input credit needs a
    --  document, and it is the first thing an officer asks for.
    CONSTRAINT cp_commissions_tax_needs_invoice CHECK (
        (cgst_minor + sgst_minor + igst_minor) = 0
        OR partner_invoice_number IS NOT NULL
    ),
    --  ⚠️ A supply is intra-State or inter-State; there is no third
    --  case. CGST alongside IGST is a place-of-supply error, and it
    --  flows straight into GSTR-3B if nothing refuses it.
    CONSTRAINT cp_commissions_tax_shape CHECK (
        igst_minor = 0 OR (cgst_minor = 0 AND sgst_minor = 0)
    ),
    --  ⚠️ A POSTED BILL HAS A DATE. Status and timestamp disagreeing is
    --  how "when was this posted" stops having an answer.
    CONSTRAINT cp_commissions_posted_has_date CHECK (
        status NOT IN ('posted', 'paid') OR posted_at IS NOT NULL
    ),
    CONSTRAINT cp_commissions_paid_has_date CHECK (
        status <> 'paid' OR paid_at IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS cp_commissions_reference_tenant_unique
    ON channel_partner_commissions (tenant_id, reference);

CREATE INDEX IF NOT EXISTS cp_commissions_tenant_idx
    ON channel_partner_commissions (tenant_id, credited_on DESC);

CREATE INDEX IF NOT EXISTS cp_commissions_partner_idx
    ON channel_partner_commissions (partner_id, credited_on DESC);

CREATE INDEX IF NOT EXISTS cp_commissions_booking_idx
    ON channel_partner_commissions (booking_id);

CREATE INDEX IF NOT EXISTS cp_commissions_tenant_status_idx
    ON channel_partner_commissions (tenant_id, status);

--  ⭐ ONE LIVE BILL PER PARTNER PER BOOKING PER CREDIT DATE.
--
--  ⚠️ NOT "ONE PER BOOKING". Brokerage genuinely is paid in tranches on
--  different dates, and forbidding that would push users into one
--  inflated bill — which breaks the TDS timing, since the threshold is
--  tested when each amount is CREDITED.
--
--  What it forbids is the same tranche entered twice: two people raise
--  the same bill on a busy launch weekend and the partner is paid twice.
CREATE UNIQUE INDEX IF NOT EXISTS cp_commissions_one_live_per_tranche
    ON channel_partner_commissions (partner_id, booking_id, credited_on)
    WHERE status <> 'cancelled' AND booking_id IS NOT NULL;

-- =====================================================================
--  SECTION 4 · THE GUARD: THE BROKERAGE BILL RATCHETS
-- =====================================================================
--
--  🔴 A POSTED BILL IS IN A TRIAL BALANCE AND IN A TDS RETURN. Letting
--  it walk back to `draft` for an edit would restate a deduction that
--  has already been certified to a broker on a Form 16A. The remedy for
--  a wrong bill is `cancelled` plus a new one — which is what the paper
--  trail should show anyway.
CREATE OR REPLACE FUNCTION ordence_guard_commission_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rank_old int;
  rank_new int;
BEGIN
  --  ⚠️ FROZEN FIGURES FIRST. Checking the status ratchet alone would
  --  let a posted bill keep its status and change its amount, which is
  --  the edit that actually costs money.
  IF OLD.status IN ('posted', 'paid') THEN
    IF NEW.gross_minor       IS DISTINCT FROM OLD.gross_minor
       OR NEW.cgst_minor     IS DISTINCT FROM OLD.cgst_minor
       OR NEW.sgst_minor     IS DISTINCT FROM OLD.sgst_minor
       OR NEW.igst_minor     IS DISTINCT FROM OLD.igst_minor
       OR NEW.tds_minor      IS DISTINCT FROM OLD.tds_minor
       OR NEW.tds_rate_bps   IS DISTINCT FROM OLD.tds_rate_bps
       OR NEW.net_payable_minor IS DISTINCT FROM OLD.net_payable_minor
       OR NEW.credited_on    IS DISTINCT FROM OLD.credited_on
       OR NEW.itc_eligible   IS DISTINCT FROM OLD.itc_eligible
       OR NEW.partner_id     IS DISTINCT FROM OLD.partner_id
    THEN
      RAISE EXCEPTION
        'This brokerage bill has been posted. Its figures are in the trial balance and the tax withheld has been reported under section 194H, so they cannot be edited. Cancel it and raise a replacement — a broker who is shown two documents can follow what happened; one document that changed silently is what a dispute is made of.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  rank_old := CASE OLD.status
                WHEN 'draft' THEN 1 WHEN 'approved' THEN 2
                WHEN 'posted' THEN 3 WHEN 'paid' THEN 4
                WHEN 'cancelled' THEN 9 END;
  rank_new := CASE NEW.status
                WHEN 'draft' THEN 1 WHEN 'approved' THEN 2
                WHEN 'posted' THEN 3 WHEN 'paid' THEN 4
                WHEN 'cancelled' THEN 9 END;

  --  ⚠️ `cancelled` IS REACHABLE FROM ANYTHING EXCEPT `paid`. Money that
  --  has left cannot be un-sent by a status change; that needs a
  --  recovery, which is its own document.
  IF NEW.status = 'cancelled' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION
        'This brokerage has already been paid. Cancelling the bill would leave a payment in the bank with nothing behind it. Recover the amount and record that, so both movements are on the record.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF rank_new < rank_old THEN
    RAISE EXCEPTION
      'A brokerage bill moves forward only: draft, approved, posted, paid. This one is % and cannot go back to %. If it is wrong, cancel it and raise another.',
      OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ordence_guard_commission_status ON channel_partner_commissions;
CREATE TRIGGER ordence_guard_commission_status
  BEFORE UPDATE ON channel_partner_commissions
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_commission_status();

-- =====================================================================
--  SECTION 5 · ROW LEVEL SECURITY
-- =====================================================================
--
--  ⭐ `app_platform_scope()` IN `USING` AND NEVER IN `WITH CHECK` — the
--  house rule the whole schema follows and that 0014 fails a deploy
--  over.
--
--  🔴 AND IT IS NOT OPTIONAL BECAUSE THE TABLE "LOOKS INTERNAL". RLS
--  that is not enabled is not a policy evaluating to false; it is NO
--  POLICY, and Postgres returns every row to every session. That
--  argument was made and was wrong once already, in 0074, and
--  `check:sql` refused the build over it.
ALTER TABLE channel_partner_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_partner_commissions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cp_commissions_isolation ON channel_partner_commissions;
CREATE POLICY cp_commissions_isolation ON channel_partner_commissions
  USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
  WITH CHECK (tenant_id = app_current_tenant_id());

COMMIT;

-- =====================================================================
--  ⭐ WHAT THIS FILE DELIBERATELY DOES NOT DO
-- =====================================================================
--
--  NO BROKERAGE CLAWBACK ON CANCELLATION. When a booking is cancelled
--  the brokerage paid on it is usually recoverable under the partner
--  agreement, and sometimes is not. Automating a debit note against a
--  broker on the strength of a status change would raise demands the
--  developer has not decided to make, against people they need next
--  quarter. The cancellation screen SAYS brokerage was paid and how
--  much; the decision stays with a human.
--
--  NO CAPITALISATION OF BROKERAGE AS A CONTRACT COST. Ind AS 115 allows
--  incremental costs of obtaining a contract to be carried as an asset
--  and released when control transfers — which for a three-year project
--  is materially different from expensing them at booking. Doing it
--  properly needs a contract-cost asset per booking and a release leg
--  inside the possession posting, and getting it half right would
--  capitalise costs that are never released. It is expensed, and the
--  screen says so.
--
--  NO AUTOMATIC SECTION 34 CREDIT NOTE. Whether the window is still
--  open is computed and shown; the numbers are entered. The credit note
--  itself is a GST document with its own series that has to agree with
--  what is declared on the portal, and inventing one from a cancellation
--  would put a document in the return that exists nowhere else.
-- =====================================================================
