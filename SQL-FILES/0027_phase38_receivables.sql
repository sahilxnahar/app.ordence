-- ============================================================================
-- Ordence — Phase 38: ⭐ Receivables & Demand Notices
-- Version: v0.38.0-alpha
--
-- Run AFTER `ALL-IN-ONE-SETUP.sql`, `0017_change_log.sql` and
-- `0016_phase22_sales.sql`. It depends on `set_updated_at()`,
-- `app_current_tenant_id()`, `record_change()`,
-- `refuse_delete_under_impersonation()`, and on the tables `bookings`,
-- `payment_milestones`, `projects`, `leads` and `users`.
--
-- Safe to run before `drizzle-kit push`: Section 1 creates its own types and
-- tables idempotently. Safe to re-run: every statement is guarded.
--
-- Contents:
--   1.  Enums and tables
--   2.  ⭐ ONE LIVE DEMAND PER MILESTONE
--   3.  Row-level security
--   4.  ⭐ Composite foreign keys — the hole RLS does NOT close
--   5.  ⭐⭐ THE ALLOCATION MUST SUM EXACTLY — deferred, at commit
--   6.  ⭐⭐ THE DUNNING LADDER MAY NOT SKIP A RUNG
--   7.  ⭐ AN ISSUED DEMAND IS FROZEN
--   8.  updated_at, and the change log
--   9.  Grants
--   10. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Phase 22 sold the flat and built the construction-linked plan. Phase 32
-- worked out the tax. Nothing so far has ASKED THE BUYER FOR THE MONEY — and
-- that request is the most repeated act in a development company: a 240-flat
-- project on a nine-stage plan raises two thousand demands, chases most of
-- them, and lives or dies on how many are paid within thirty days.
--
-- ⚠️ A DEMAND IS A LEGAL DOCUMENT UNDER RERA, not a reminder. It is what the
-- developer relies on to charge interest and, after the ladder has been
-- climbed, to terminate the allotment and forfeit. Which is why the four
-- failures below are all SILENT, all arrive years later, and all arrive in
-- front of somebody with the power to order a refund.
--
-- ⭐⭐ 1. AN ALLOCATION THAT DOES NOT SUM.
--
--     A buyer pays ₹5,00,000 against three demands. Divide it three ways and
--     two paise vanish; round each up and the account is over-applied by a
--     paisa that never clears. Neither is visible: the receipt says ₹5,00,000,
--     each demand says "part paid", and the difference surfaces a year later
--     in a statement of account handed to a buyer who is already arguing about
--     possession.
--
--     Section 5 refuses, at COMMIT, any receipt whose allocation rows do not
--     add to its stated applied total, and any demand whose applied total
--     disagrees with the rows pointing at it.
--
-- ⭐⭐ 2. A SKIPPED RUNG ON THE DUNNING LADDER.
--
--     reminder → first notice → final notice → cancellation warning. A buyer
--     shown a cancellation warning who never received a first notice has a
--     complete answer at the Authority, and the developer's own system is the
--     evidence against them. Section 6 refuses a rung whose predecessor was
--     never sent — including to a back-fill script, which is how it happens.
--
--     ⚠️ AND THE LAST RUNG NEEDS A NAMED HUMAN. Everything below it can be
--     swept by a scheduled job; threatening to cancel an allotment and forfeit
--     somebody's money may not be, ever. "The system sent it automatically" is
--     not an answer anybody can give at a hearing.
--
-- ⭐ 3. TWO LIVE DEMANDS FOR ONE MILESTONE.
--
--     Two documents in a buyer's hands asking for the same money. They pay
--     one; the other ages into the 90+ bucket and the ladder starts climbing
--     against somebody who has paid. Section 2.
--
-- ⭐ 4. AN ISSUED DEMAND EDITED AFTERWARDS.
--
--     The document was served. Changing its amount, its due date or the event
--     it says fell due makes our register disagree with the paper in the
--     buyer's hand, and the buyer's copy is the one that counts. Section 7
--     freezes those columns once `issued_at` is set; a correction is a
--     SUPERSEDING demand, which leaves both documents in the record.
--
-- Money is bigint paise. Rates are integer basis points. Civil days are `date`.
-- ============================================================================


-- ############################################################################
-- SECTION 1 — ENUMS AND TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/receivables.ts`. They are
-- restated here because a file that can only run second is a file that fails on
-- a fresh database.

DO $$
BEGIN
  -- ⚠️ `superseded` IS NOT `cancelled`. Cancelled means the demand should
  -- never have gone out; superseded means it did, it was right, and a
  -- corrected one replaced it. The interest clock on a superseded demand runs
  -- from the ORIGINAL due date and a cancelled one has no clock at all.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'demand_status') THEN
    CREATE TYPE demand_status AS ENUM
      ('draft','issued','part_paid','paid','cancelled','superseded');
  END IF;

  -- ⭐ WHAT MADE THIS DEMAND FALL DUE. ⚠️ There is deliberately no `other`:
  -- "other" on a document whose whole defence is stating its own trigger is a
  -- blank the Authority reads aloud.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'demand_trigger_kind') THEN
    CREATE TYPE demand_trigger_kind AS ENUM
      ('construction_event','scheduled_date','booking_event','possession','statutory');
  END IF;

  -- ⭐ The six languages, matching what `leads.preferred_lang` has carried
  -- since Phase 22 — where the column's comment says exactly why it exists.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notice_language') THEN
    CREATE TYPE notice_language AS ENUM ('en','hi','kn','ta','te','mr');
  END IF;

  -- ⚠️ THE ENUM THAT DECIDES HOW MUCH THE BUYER OWES. On ₹10,00,000 held a
  -- year at 18% the four options differ by nearly ₹16,000. Any of them is
  -- defensible; choosing one SILENTLY is not, which is why
  -- `interest_basis_note` beside it is NOT NULL.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'interest_compounding') THEN
    CREATE TYPE interest_compounding AS ENUM ('simple','monthly','quarterly','annual');
  END IF;

  -- ⚠️ The convention nobody asks about that moves the number by 1.4%.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'interest_day_count') THEN
    CREATE TYPE interest_day_count AS ENUM ('actual_365','actual_360','thirty_360');
  END IF;

  -- ⭐ Section 60 of the Contract Act gives the creditor the right to
  -- appropriate. Which leg a rupee pays first is a real legal choice, so it is
  -- stored and stated rather than assumed.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'appropriation_order') THEN
    CREATE TYPE appropriation_order AS ENUM ('interest_first','principal_first');
  END IF;

  -- ⚠️ `specified` is Section 59 — a debtor's express appropriation BINDS the
  -- creditor. It is the buyer exercising a right, not a convenience.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'allocation_strategy') THEN
    CREATE TYPE allocation_strategy AS ENUM ('oldest_first','specified','credit');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dunning_stage') THEN
    CREATE TYPE dunning_stage AS ENUM
      ('reminder','first_notice','final_notice','cancellation_warning');
  END IF;

  -- ⚠️ `post`, `courier` and `hand_delivery` are on this list because they are
  -- what actually counts. Most builder-buyer agreements specify registered
  -- post to the address in the agreement as valid service; an email nobody
  -- opened is not service.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dunning_channel') THEN
    CREATE TYPE dunning_channel AS ENUM
      ('email','whatsapp','sms','post','courier','hand_delivery','portal');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'receipt_method') THEN
    CREATE TYPE receipt_method AS ENUM
      ('neft','rtgs','imps','upi','cheque','demand_draft','cash','card',
       'netbanking','home_loan_disbursement','adjustment');
  END IF;

  -- ⚠️ `bounced` is why a receipt is not simply a row meaning "paid". A cheque
  -- presented on the 5th and returned on the 12th was never money, and the
  -- interest clock never stopped.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'receipt_status') THEN
    CREATE TYPE receipt_status AS ENUM ('pending','cleared','bounced','cancelled');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS receivable_policies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = the workspace-wide default.
  project_id                  uuid,
  name                        varchar(160) NOT NULL,
  interest_rate_bps           integer NOT NULL DEFAULT 1800,
  -- ⭐ THE RERA SYMMETRIC RATE. Section 2(za) defines interest symmetrically:
  -- what the promoter charges an allottee for a late payment must equal what
  -- the promoter PAYS an allottee for delayed possession, which the State
  -- rules set at SBI's highest MCLR + 2%. Stored, not looked up, because MCLR
  -- moves and a demand is judged against the rate that applied when raised.
  reference_rate_bps          integer NOT NULL DEFAULT 1110,
  compounding                 interest_compounding NOT NULL DEFAULT 'simple',
  day_count                   interest_day_count NOT NULL DEFAULT 'actual_365',
  grace_days                  integer NOT NULL DEFAULT 0,
  grace_forgives_elapsed_days boolean NOT NULL DEFAULT false,
  demand_due_days             integer NOT NULL DEFAULT 15,
  gst_rate_bps                integer NOT NULL DEFAULT 500,
  appropriation_order         appropriation_order NOT NULL DEFAULT 'interest_first',
  default_allocation_strategy allocation_strategy NOT NULL DEFAULT 'oldest_first',
  is_active                   boolean NOT NULL DEFAULT true,
  notes                       text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ 10000 bps is 100% PER ANNUM. Above it is a typed extra digit, not a
  -- commercial decision.
  --
  -- ⚠️ AND IT DOES NOT CAP AT THE RERA REFERENCE RATE, DELIBERATELY. Whether a
  -- pre-RERA agreement's 24% is enforceable is a legal judgement counsel
  -- makes; refusing it here would stop a developer recording what their own
  -- contract says. `lib/receivables/interest.ts` FLAGS the gap instead — on
  -- the demand, on the notice and in the register.
  CONSTRAINT receivable_policies_rates_sane
    CHECK (interest_rate_bps >= 0 AND interest_rate_bps <= 10000
           AND reference_rate_bps >= 0 AND reference_rate_bps <= 10000
           AND gst_rate_bps >= 0 AND gst_rate_bps <= 10000),
  CONSTRAINT receivable_policies_periods_sane
    CHECK (grace_days >= 0 AND grace_days <= 365
           AND demand_due_days >= 0 AND demand_due_days <= 365)
);


CREATE TABLE IF NOT EXISTS dunning_policies (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id                      uuid,
  name                            varchar(160) NOT NULL,
  reminder_after_days             integer NOT NULL DEFAULT 3,
  first_notice_after_days         integer NOT NULL DEFAULT 15,
  final_notice_after_days         integer NOT NULL DEFAULT 30,
  cancellation_warning_after_days integer NOT NULL DEFAULT 60,
  -- ⚠️ THE MINIMUM GAP BETWEEN TWO RUNGS, WHATEVER THE THRESHOLDS SAY. A
  -- demand raised late, or a policy edited mid-chase, puts two thresholds in
  -- the past at once — and without this the ladder is climbed in a single
  -- sweep and the buyer receives a first notice and a final notice in the same
  -- minute.
  min_gap_days                    integer NOT NULL DEFAULT 7,
  pre_due_reminder_days           integer NOT NULL DEFAULT 0,
  is_active                       boolean NOT NULL DEFAULT true,
  notes                           text,
  created_by                      uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  -- ⚠️ A policy whose final notice fires before its first does not error — it
  -- sends both on the same morning, which reads to the buyer as a machine and
  -- to the Authority as a developer who never gave them a chance.
  CONSTRAINT dunning_policies_ladder_ascends
    CHECK (reminder_after_days < first_notice_after_days
           AND first_notice_after_days < final_notice_after_days
           AND final_notice_after_days < cancellation_warning_after_days),
  CONSTRAINT dunning_policies_days_sane
    CHECK (reminder_after_days >= 0 AND cancellation_warning_after_days <= 3650
           AND min_gap_days >= 0 AND min_gap_days <= 365
           AND pre_due_reminder_days >= 0 AND pre_due_reminder_days <= 90)
);


CREATE TABLE IF NOT EXISTS demand_notices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- ⭐ Human-facing, quoted on the payment and in every later letter.
  notice_number          varchar(40) NOT NULL,
  booking_id             uuid NOT NULL,
  -- ⚠️ NOT NULLABLE. A demand is raised against a milestone, full stop — that
  -- is what makes it a construction-linked demand rather than an invoice.
  milestone_id           uuid NOT NULL,
  project_id             uuid,
  lead_id                uuid,
  status                 demand_status NOT NULL DEFAULT 'draft',

  -- ⭐ WHAT TRIGGERED IT. All three NOT NULL, and that is the point of the
  -- table: a demand that cannot say what fell due, and when it was achieved,
  -- cannot be defended — and the day it needs defending is years after the
  -- person who raised it left.
  trigger_kind           demand_trigger_kind NOT NULL,
  trigger_label          varchar(255) NOT NULL,
  trigger_achieved_on    date NOT NULL,
  trigger_evidence       text,

  notice_date            date NOT NULL,
  due_date               date NOT NULL,

  principal_minor        bigint NOT NULL,
  gst_rate_bps           integer NOT NULL DEFAULT 0,
  cgst_minor             bigint NOT NULL DEFAULT 0,
  sgst_minor             bigint NOT NULL DEFAULT 0,
  igst_minor             bigint NOT NULL DEFAULT 0,
  cess_minor             bigint NOT NULL DEFAULT 0,
  tax_minor              bigint NOT NULL DEFAULT 0,
  total_minor            bigint NOT NULL,

  -- ⭐ THE INTEREST TERMS, FROZEN ON TO THE DOCUMENT. A policy edited in March
  -- must not silently restate what a January notice said.
  interest_rate_bps      integer NOT NULL DEFAULT 0,
  reference_rate_bps     integer NOT NULL DEFAULT 0,
  rate_exceeds_reference boolean NOT NULL DEFAULT false,
  compounding            interest_compounding NOT NULL DEFAULT 'simple',
  day_count              interest_day_count NOT NULL DEFAULT 'actual_365',
  grace_days             integer NOT NULL DEFAULT 0,
  -- ⚠️ NOT NULL. This is the sentence that goes on the notice — "interest at
  -- 18% per annum, simple, on the outstanding principal from 15 May 2026".
  -- Generated from the columns above so it cannot drift from the arithmetic it
  -- describes. INTEREST MUST NOT COMPOUND SILENTLY.
  interest_basis_note    text NOT NULL,

  allocated_minor        bigint NOT NULL DEFAULT 0,
  interest_paid_minor    bigint NOT NULL DEFAULT 0,

  language               notice_language NOT NULL DEFAULT 'en',
  dunning_stage          dunning_stage,
  last_dunned_at         timestamptz,

  issued_at              timestamptz,
  issued_by              uuid,
  cancelled_at           timestamptz,
  cancel_reason          text,
  superseded_by_id       uuid,
  notes                  text,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT demand_notices_principal_positive CHECK (principal_minor > 0),
  -- ⭐ THE FACE OF THE NOTICE MUST ADD UP. A total that is not principal plus
  -- tax is a document whose own arithmetic fails in front of the person paying
  -- it.
  CONSTRAINT demand_notices_totals_balance
    CHECK (tax_minor = cgst_minor + sgst_minor + igst_minor + cess_minor
           AND total_minor = principal_minor + tax_minor),
  -- ⚠️ CGST/SGST and IGST are mutually exclusive. A demand carrying both has
  -- been taxed twice for one supply, and the buyer pays it because the total
  -- still adds up.
  CONSTRAINT demand_notices_tax_kind_is_singular
    CHECK (igst_minor = 0 OR (cgst_minor = 0 AND sgst_minor = 0)),
  CONSTRAINT demand_notices_amounts_non_negative
    CHECK (cgst_minor >= 0 AND sgst_minor >= 0 AND igst_minor >= 0
           AND cess_minor >= 0 AND tax_minor >= 0 AND total_minor >= 0
           AND allocated_minor >= 0 AND interest_paid_minor >= 0),
  -- ⭐⭐ A DEMAND MAY NOT BE OVER-APPLIED. An over-payment is a CREDIT on the
  -- buyer's account, not a negative balance on a document — the moment a
  -- demand can go past its own total, the statement stops footing and no
  -- report anywhere shows why.
  CONSTRAINT demand_notices_not_over_applied
    CHECK (allocated_minor <= total_minor),
  CONSTRAINT demand_notices_rates_sane
    CHECK (interest_rate_bps >= 0 AND interest_rate_bps <= 10000
           AND reference_rate_bps >= 0 AND reference_rate_bps <= 10000
           AND gst_rate_bps >= 0 AND gst_rate_bps <= 10000
           AND grace_days >= 0 AND grace_days <= 365),
  CONSTRAINT demand_notices_due_after_notice CHECK (due_date >= notice_date),
  CONSTRAINT demand_notices_issued_is_dated
    CHECK (status IN ('draft','cancelled') OR issued_at IS NOT NULL),
  CONSTRAINT demand_notices_cancel_has_reason
    CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CONSTRAINT demand_notices_superseded_names_successor
    CHECK (status <> 'superseded' OR superseded_by_id IS NOT NULL),
  -- ⚠️ A ladder rung against a draft is a letter about a document the buyer
  -- never received.
  CONSTRAINT demand_notices_ladder_follows_issue
    CHECK (dunning_stage IS NULL OR issued_at IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS demand_notice_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  demand_id        uuid NOT NULL,
  language         notice_language NOT NULL,
  template_key     varchar(60) NOT NULL,
  template_version varchar(20) NOT NULL,
  subject          text NOT NULL,
  -- ⭐ STORED, NOT RE-RENDERED. "What did your notice actually say?" is the
  -- first question in every dispute, asked about a notice sent two releases
  -- ago. Re-rendering from the template answers a question about today's code.
  body             text NOT NULL,
  body_hash        varchar(64) NOT NULL,
  amount_in_words  text NOT NULL,
  -- ⚠️ WHICH LANGUAGE THE WORDS ARE REALLY IN, which is not always the
  -- document's. A wrong amount in words on a legal notice is worse than an
  -- untranslated one, and a column that cannot express "we fell back" hides it.
  words_language   notice_language NOT NULL,
  words_fell_back  boolean NOT NULL DEFAULT false,
  rendered_at      timestamptz NOT NULL DEFAULT now(),
  rendered_by      uuid,

  CONSTRAINT demand_notice_documents_hash_shape
    CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT demand_notice_documents_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT demand_notice_documents_fallback_is_honest
    CHECK ((NOT words_fell_back) OR words_language <> language)
);


CREATE TABLE IF NOT EXISTS dunning_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  demand_id         uuid NOT NULL,
  stage             dunning_stage NOT NULL,
  -- ⭐ 1..4, MATCHING THE STAGE. Redundant on purpose: Section 6 compares
  -- integers, and comparing enum labels by name is how a reordered enum
  -- silently reorders a legal process.
  rung              integer NOT NULL,
  channel           dunning_channel NOT NULL,
  language          notice_language NOT NULL DEFAULT 'en',
  recipient         varchar(320),
  sent_at           timestamptz NOT NULL DEFAULT now(),
  -- Frozen at the moment of sending. Never recomputed: the letter said what it
  -- said.
  days_overdue      integer NOT NULL,
  outstanding_minor bigint NOT NULL,
  interest_minor    bigint NOT NULL DEFAULT 0,
  authorised_by     uuid,
  authorised_reason text,
  document_id       uuid,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dunning_events_rung_matches_stage
    CHECK ((stage = 'reminder' AND rung = 1)
           OR (stage = 'first_notice' AND rung = 2)
           OR (stage = 'final_notice' AND rung = 3)
           OR (stage = 'cancellation_warning' AND rung = 4)),
  -- ⭐⭐ THE RUNG THAT MAY NEVER BE AUTOMATIC. Everything below it can be swept
  -- by a scheduled job. Threatening to terminate an allotment and forfeit
  -- somebody's money may not be.
  CONSTRAINT dunning_events_cancellation_is_authorised
    CHECK (stage <> 'cancellation_warning'
           OR (authorised_by IS NOT NULL
               AND btrim(coalesce(authorised_reason, '')) <> '')),
  CONSTRAINT dunning_events_amounts_sane
    CHECK (outstanding_minor >= 0 AND interest_minor >= 0)
);


CREATE TABLE IF NOT EXISTS receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_number      varchar(40) NOT NULL,
  -- ⭐ AGAINST A BOOKING, NOT A DEMAND. Which demands a transfer settles is
  -- decided afterwards — sometimes by the buyer (Section 59) and sometimes by
  -- us (Section 60). Tying the receipt to one demand would make the common
  -- case, one transfer clearing two and a half demands, unrecordable.
  booking_id          uuid NOT NULL,
  project_id          uuid,
  lead_id             uuid,
  received_on         date NOT NULL,
  amount_minor        bigint NOT NULL,
  -- ⭐ SECTION 194-IA. The BUYER deducts 1% of the consideration on any
  -- property over ₹50 lakh and pays it to the Government on the developer's
  -- behalf, so a ₹10,00,000 demand is settled by ₹9,90,000 in the bank plus
  -- ₹10,000 the developer claims in their own return. Counting only what
  -- arrived leaves 1% outstanding on EVERY demand, ages it into the buckets,
  -- and starts a dunning ladder against a buyer who paid in full and did
  -- exactly what the law told them to.
  tds_credit_minor    bigint NOT NULL DEFAULT 0,
  allocated_minor     bigint NOT NULL DEFAULT 0,
  method              receipt_method NOT NULL,
  status              receipt_status NOT NULL DEFAULT 'cleared',
  allocation_strategy allocation_strategy NOT NULL DEFAULT 'oldest_first',
  appropriation_order appropriation_order NOT NULL DEFAULT 'interest_first',
  instrument_ref      varchar(120),
  bank_ref            varchar(120),
  cleared_on          date,
  bounced_on          date,
  bounce_reason       text,
  notes               text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT receipts_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT receipts_amounts_non_negative
    CHECK (tds_credit_minor >= 0 AND allocated_minor >= 0),
  -- ⭐⭐ A RECEIPT MAY NOT APPLY MORE THAN IT IS WORTH. The excess is a credit —
  -- a real thing with a real balance — and without this check it becomes an
  -- over-application spread silently across demands nobody chose.
  CONSTRAINT receipts_not_over_applied
    CHECK (allocated_minor <= amount_minor + tds_credit_minor),
  -- ⚠️ A returned cheque was never money. It cannot still be applied.
  CONSTRAINT receipts_bounced_is_released
    CHECK (status <> 'bounced' OR allocated_minor = 0),
  CONSTRAINT receipts_bounced_is_dated
    CHECK (status <> 'bounced' OR bounced_on IS NOT NULL)
);


CREATE TABLE IF NOT EXISTS receipt_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id          uuid NOT NULL,
  demand_id           uuid NOT NULL,
  sequence            integer NOT NULL,
  -- ⭐ THREE LEGS, BECAUSE THEY ARE THREE DIFFERENT THINGS TO THREE DIFFERENT
  -- READERS: principal reduces what is owed on the flat, tax is GST already
  -- charged and must be accounted for in a return, interest is income and is
  -- the leg a buyer will dispute. One `amount_minor` would make the statement
  -- of account impossible to produce and the GST position impossible to
  -- reconcile.
  principal_minor     bigint NOT NULL DEFAULT 0,
  tax_minor           bigint NOT NULL DEFAULT 0,
  interest_minor      bigint NOT NULL DEFAULT 0,
  amount_minor        bigint NOT NULL,
  basis               allocation_strategy NOT NULL,
  appropriation_order appropriation_order NOT NULL DEFAULT 'interest_first',
  -- ⚠️ NOT NULL AND NOT A NOTE. It is the line the buyer is shown. The whole
  -- requirement of this phase is that a split can be EXPLAINED, and an
  -- explanation generated later from columns is one that changes when the code
  -- does.
  explanation         text NOT NULL,
  allocated_at        timestamptz NOT NULL DEFAULT now(),
  allocated_by        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT receipt_allocations_legs_balance
    CHECK (amount_minor = principal_minor + tax_minor + interest_minor),
  -- ⚠️ POSITIVE, NOT NON-NEGATIVE. A zero allocation appears on the buyer's
  -- statement, foots to nothing, and is indistinguishable from a bug that
  -- dropped a leg.
  CONSTRAINT receipt_allocations_amount_positive
    CHECK (amount_minor > 0 AND principal_minor >= 0
           AND tax_minor >= 0 AND interest_minor >= 0),
  CONSTRAINT receipt_allocations_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT receipt_allocations_explanation_not_blank
    CHECK (btrim(explanation) <> '')
);


-- Indexes. `drizzle-kit push` creates these too; restated for a fresh database.
CREATE INDEX IF NOT EXISTS receivable_policies_tenant_idx
  ON receivable_policies (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS receivable_policies_project_idx
  ON receivable_policies (tenant_id, project_id);

CREATE INDEX IF NOT EXISTS dunning_policies_tenant_idx
  ON dunning_policies (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS dunning_policies_project_idx
  ON dunning_policies (tenant_id, project_id);

CREATE UNIQUE INDEX IF NOT EXISTS demand_notices_number_tenant_unique
  ON demand_notices (tenant_id, notice_number);
CREATE INDEX IF NOT EXISTS demand_notices_tenant_idx
  ON demand_notices (tenant_id, status);
CREATE INDEX IF NOT EXISTS demand_notices_booking_idx
  ON demand_notices (tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS demand_notices_milestone_idx
  ON demand_notices (tenant_id, milestone_id);
CREATE INDEX IF NOT EXISTS demand_notices_due_idx
  ON demand_notices (tenant_id, due_date, status);
CREATE INDEX IF NOT EXISTS demand_notices_project_idx
  ON demand_notices (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS demand_notices_ladder_idx
  ON demand_notices (tenant_id, dunning_stage);

-- ⚠️ KEYED ON THE TEMPLATE AS WELL AS THE LANGUAGE. A demand produces FIVE
-- documents in a language over its life — the notice and the four rungs of the
-- ladder — and a key on (demand, language) alone silently drops four of them,
-- leaving no answer to "what did the final notice actually say?" for exactly
-- the letters that end up in front of an Authority.
CREATE UNIQUE INDEX IF NOT EXISTS demand_notice_documents_demand_doc_unique
  ON demand_notice_documents (tenant_id, demand_id, language, template_key);
CREATE INDEX IF NOT EXISTS demand_notice_documents_tenant_idx
  ON demand_notice_documents (tenant_id);
CREATE INDEX IF NOT EXISTS demand_notice_documents_demand_idx
  ON demand_notice_documents (tenant_id, demand_id);

CREATE INDEX IF NOT EXISTS dunning_events_demand_idx
  ON dunning_events (tenant_id, demand_id, rung);
CREATE INDEX IF NOT EXISTS dunning_events_tenant_idx
  ON dunning_events (tenant_id, sent_at);
CREATE INDEX IF NOT EXISTS dunning_events_stage_idx
  ON dunning_events (tenant_id, stage);
-- ⭐ One rung is sent once per demand. A second row is a re-send, and a re-send
-- that looks like a fresh rung is how a ladder appears to have been climbed
-- twice.
CREATE UNIQUE INDEX IF NOT EXISTS dunning_events_rung_once
  ON dunning_events (tenant_id, demand_id, stage);

CREATE UNIQUE INDEX IF NOT EXISTS receipts_number_tenant_unique
  ON receipts (tenant_id, receipt_number);
CREATE INDEX IF NOT EXISTS receipts_tenant_idx ON receipts (tenant_id, received_on);
CREATE INDEX IF NOT EXISTS receipts_booking_idx ON receipts (tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS receipts_status_idx ON receipts (tenant_id, status);
CREATE INDEX IF NOT EXISTS receipts_credit_idx
  ON receipts (tenant_id, booking_id, allocated_minor);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_allocations_pair_unique
  ON receipt_allocations (tenant_id, receipt_id, demand_id);
CREATE INDEX IF NOT EXISTS receipt_allocations_receipt_idx
  ON receipt_allocations (tenant_id, receipt_id, sequence);
CREATE INDEX IF NOT EXISTS receipt_allocations_demand_idx
  ON receipt_allocations (tenant_id, demand_id);


-- ############################################################################
-- SECTION 2 — ⭐ ONE LIVE DEMAND PER MILESTONE
-- ############################################################################
--
-- ⭐ THE SIMPLEST GUARD IN THE PHASE AND ONE OF THE TWO MOST DAMAGING TO OMIT.
--
--     The third slab is cast. The site engineer tells accounts; accounts raises
--     the demand. The project accountant, working from the RERA quarterly
--     update, raises it too. Both are correct, both are ₹8,74,563, and both
--     reach the buyer.
--
--     The buyer pays one. The other stays outstanding, ages into the 31-60
--     bucket, then the 61-90, and the dunning sweep starts sending notices to
--     somebody who has paid in full — ending, if nobody intervenes, at a
--     cancellation warning against a buyer with a receipt in their hand.
--
-- ⚠️ PARTIAL, on the live statuses. A cancelled or superseded demand is history
-- and history must be allowed to contain the earlier attempt — that is the
-- whole mechanism by which a wrong demand is corrected.

CREATE UNIQUE INDEX IF NOT EXISTS demand_notices_one_live_per_milestone
  ON demand_notices (tenant_id, milestone_id)
  WHERE status NOT IN ('cancelled','superseded');


-- ############################################################################
-- SECTION 3 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER too, which is
-- the half everybody forgets: without it the role that created the table reads
-- everything and the policies look like they are working.
--
-- ⚠️ NO `app_is_platform_scope()` ON ANY POLICY HERE, AND THE CASE IS STRONGER
-- THAN USUAL. `demand_notices` joined to `receipts` is a developer's ENTIRE
-- CASH POSITION: what has been demanded, what has actually come in, from which
-- buyers, how late, and which buyers are being threatened with cancellation.
-- That is the number a competitor bidding for the same land wants, the number a
-- lender re-prices on, and — in `dunning_events` — a list of named individuals
-- in financial difficulty. Platform staff have no business reading any of it.

ALTER TABLE receivable_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable_policies FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receivable_policies_tenant_isolation ON receivable_policies;
CREATE POLICY receivable_policies_tenant_isolation ON receivable_policies
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE dunning_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_policies FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dunning_policies_tenant_isolation ON dunning_policies;
CREATE POLICY dunning_policies_tenant_isolation ON dunning_policies
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE demand_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_notices FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demand_notices_tenant_isolation ON demand_notices;
CREATE POLICY demand_notices_tenant_isolation ON demand_notices
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE demand_notice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_notice_documents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demand_notice_documents_tenant_isolation ON demand_notice_documents;
CREATE POLICY demand_notice_documents_tenant_isolation ON demand_notice_documents
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE dunning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dunning_events_tenant_isolation ON dunning_events;
CREATE POLICY dunning_events_tenant_isolation ON dunning_events
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receipts_tenant_isolation ON receipts;
CREATE POLICY receipts_tenant_isolation ON receipts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_allocations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receipt_allocations_tenant_isolation ON receipt_allocations;
CREATE POLICY receipt_allocations_tenant_isolation ON receipt_allocations
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
--     Tenant A inserts an allocation with
--         tenant_id  = A                        ← passes WITH CHECK
--         demand_id  = <a demand owned by B>    ← passes a single-column FK
--
--     A's money is now applied against B's demand. B's demand shows part paid
--     against a receipt B cannot see, B's Section 5 totals fail for reasons
--     entirely inside a table B cannot read, and B's buyer is told their
--     outstanding is lower than it is.
--
-- ⚠️ AND `demand_notices.milestone_id` IS THE WORST ONE. Pointed at another
-- workspace's milestone, a demand would state a construction event from a
-- building this developer does not own — on a document that goes to a buyer and
-- is relied on to charge interest.

CREATE UNIQUE INDEX IF NOT EXISTS receivable_policies_id_tenant_key
  ON receivable_policies (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS dunning_policies_id_tenant_key
  ON dunning_policies (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS demand_notices_id_tenant_key
  ON demand_notices (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS demand_notice_documents_id_tenant_key
  ON demand_notice_documents (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_id_tenant_key
  ON receipts (id, tenant_id);

-- Parents in earlier phases. Created idempotently so this file does not depend
-- on the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key    ON users (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_tenant_key ON projects (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_id_tenant_key ON bookings (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS leads_id_tenant_key    ON leads (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_milestones_id_tenant_key
  ON payment_milestones (id, tenant_id);

DO $$
BEGIN
  /* --- receivable_policies -------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receivable_policies_project_same_tenant') THEN
    ALTER TABLE receivable_policies
      ADD CONSTRAINT receivable_policies_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receivable_policies_created_by_same_tenant') THEN
    ALTER TABLE receivable_policies
      ADD CONSTRAINT receivable_policies_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- dunning_policies ----------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dunning_policies_project_same_tenant') THEN
    ALTER TABLE dunning_policies
      ADD CONSTRAINT dunning_policies_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dunning_policies_created_by_same_tenant') THEN
    ALTER TABLE dunning_policies
      ADD CONSTRAINT dunning_policies_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- demand_notices ------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notices_booking_same_tenant') THEN
    ALTER TABLE demand_notices ADD CONSTRAINT demand_notices_booking_same_tenant
      FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id)
      -- CASCADE: a demand has no meaning without the booking it was raised
      -- under, and Phase 22 hard-deletes no booking — a cancelled one keeps its
      -- row and therefore keeps its demands.
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notices_milestone_same_tenant') THEN
    ALTER TABLE demand_notices ADD CONSTRAINT demand_notices_milestone_same_tenant
      FOREIGN KEY (milestone_id, tenant_id)
      REFERENCES payment_milestones (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notices_project_same_tenant') THEN
    ALTER TABLE demand_notices ADD CONSTRAINT demand_notices_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notices_lead_same_tenant') THEN
    ALTER TABLE demand_notices ADD CONSTRAINT demand_notices_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id)
      ON DELETE SET NULL (lead_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notices_issued_by_same_tenant') THEN
    ALTER TABLE demand_notices ADD CONSTRAINT demand_notices_issued_by_same_tenant
      FOREIGN KEY (issued_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (issued_by);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notices_superseded_by_same_tenant') THEN
    ALTER TABLE demand_notices
      ADD CONSTRAINT demand_notices_superseded_by_same_tenant
      FOREIGN KEY (superseded_by_id, tenant_id)
      REFERENCES demand_notices (id, tenant_id)
      ON DELETE SET NULL (superseded_by_id);
  END IF;

  /* --- demand_notice_documents ---------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'demand_notice_documents_demand_same_tenant') THEN
    ALTER TABLE demand_notice_documents
      ADD CONSTRAINT demand_notice_documents_demand_same_tenant
      FOREIGN KEY (demand_id, tenant_id) REFERENCES demand_notices (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  /* --- dunning_events ------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dunning_events_demand_same_tenant') THEN
    ALTER TABLE dunning_events ADD CONSTRAINT dunning_events_demand_same_tenant
      FOREIGN KEY (demand_id, tenant_id) REFERENCES demand_notices (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dunning_events_document_same_tenant') THEN
    ALTER TABLE dunning_events ADD CONSTRAINT dunning_events_document_same_tenant
      FOREIGN KEY (document_id, tenant_id)
      REFERENCES demand_notice_documents (id, tenant_id)
      ON DELETE SET NULL (document_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dunning_events_authorised_by_same_tenant') THEN
    ALTER TABLE dunning_events
      ADD CONSTRAINT dunning_events_authorised_by_same_tenant
      -- ⚠️ NOT `SET NULL`, and this is the one exception on the whole list.
      -- `authorised_by` on a cancellation warning is the evidence that a named
      -- human authorised the threat, and the table CHECK requires it to be
      -- present. Nulling it on a user deletion would either break the check or
      -- erase the authorisation — so a user who has authorised one cannot be
      -- hard-deleted, which is correct: Phase 5 deactivates users, it does not
      -- remove them.
      FOREIGN KEY (authorised_by, tenant_id) REFERENCES users (id, tenant_id);
  END IF;

  /* --- receipts -------------------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipts_booking_same_tenant') THEN
    ALTER TABLE receipts ADD CONSTRAINT receipts_booking_same_tenant
      FOREIGN KEY (booking_id, tenant_id) REFERENCES bookings (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipts_project_same_tenant') THEN
    ALTER TABLE receipts ADD CONSTRAINT receipts_project_same_tenant
      FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id)
      ON DELETE SET NULL (project_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipts_lead_same_tenant') THEN
    ALTER TABLE receipts ADD CONSTRAINT receipts_lead_same_tenant
      FOREIGN KEY (lead_id, tenant_id) REFERENCES leads (id, tenant_id)
      ON DELETE SET NULL (lead_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipts_created_by_same_tenant') THEN
    ALTER TABLE receipts ADD CONSTRAINT receipts_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  /* --- receipt_allocations --------------------------------------- */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipt_allocations_receipt_same_tenant') THEN
    ALTER TABLE receipt_allocations
      ADD CONSTRAINT receipt_allocations_receipt_same_tenant
      FOREIGN KEY (receipt_id, tenant_id) REFERENCES receipts (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipt_allocations_demand_same_tenant') THEN
    ALTER TABLE receipt_allocations
      ADD CONSTRAINT receipt_allocations_demand_same_tenant
      FOREIGN KEY (demand_id, tenant_id) REFERENCES demand_notices (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'receipt_allocations_allocated_by_same_tenant') THEN
    ALTER TABLE receipt_allocations
      ADD CONSTRAINT receipt_allocations_allocated_by_same_tenant
      FOREIGN KEY (allocated_by, tenant_id) REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (allocated_by);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — ⭐⭐ THE ALLOCATION MUST SUM EXACTLY
-- ############################################################################
--
-- ⭐⭐ THE GUARD THIS PHASE EXISTS FOR.
--
--     A buyer pays ₹5,00,000 against three outstanding demands. That money has
--     to land somewhere, exactly, and the buyer has to be able to be SHOWN
--     where. The ways it goes wrong are all arithmetic and all invisible:
--
--       • Divide it three ways in floating point and two paise vanish.
--       • Round each share up and the account is over-applied by a paisa that
--         never clears and that no report shows.
--       • Write the allocation rows, fail to update `allocated_minor`, and the
--         list page says "unpaid" while the ledger says "paid".
--       • Update `allocated_minor` and fail to write a row, and the buyer's
--         statement of account cannot say where their money went.
--
--     None of them errors. All of them are found months later, by whoever is
--     preparing a statement for a buyer who is already in dispute.
--
-- ⚠️ DEFERRED, AND THAT IS ESSENTIAL. Recording a receipt writes the receipt,
-- then the allocation rows, then updates the demands — several statements in
-- one transaction. An immediate trigger would reject the receipt before its
-- first allocation existed.
--
-- ⚠️ AND IT FIRES ON ALL THREE TABLES. Checking only the allocation side means
-- a stored total edited afterwards passes; checking only the totals means an
-- allocation deleted afterwards passes. Either half alone is a guard with a
-- door next to it.

CREATE OR REPLACE FUNCTION receivables_allocation_sums_exactly()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id  uuid;
  v_receipt_id uuid;
  v_demand_id  uuid;
  v_receipt    record;
  v_demand     record;
  v_actual     record;
BEGIN
  IF TG_TABLE_NAME = 'receipt_allocations' THEN
    v_tenant_id  := COALESCE(NEW.tenant_id, OLD.tenant_id);
    v_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);
    v_demand_id  := COALESCE(NEW.demand_id, OLD.demand_id);
  ELSIF TG_TABLE_NAME = 'receipts' THEN
    v_tenant_id  := COALESCE(NEW.tenant_id, OLD.tenant_id);
    v_receipt_id := COALESCE(NEW.id, OLD.id);
  ELSE
    v_tenant_id  := COALESCE(NEW.tenant_id, OLD.tenant_id);
    v_demand_id  := COALESCE(NEW.id, OLD.id);
  END IF;

  /* --- ⭐ THE RECEIPT SIDE --------------------------------------- */
  IF v_receipt_id IS NOT NULL THEN
    SELECT receipt_number, amount_minor, tds_credit_minor, allocated_minor
      INTO v_receipt
    FROM receipts WHERE id = v_receipt_id AND tenant_id = v_tenant_id;

    -- The receipt went in this transaction; its allocations went with it.
    IF FOUND THEN
      SELECT COALESCE(sum(amount_minor), 0) AS applied
        INTO v_actual
      FROM receipt_allocations
      WHERE receipt_id = v_receipt_id AND tenant_id = v_tenant_id;

      IF v_receipt.allocated_minor <> v_actual.applied THEN
        RAISE EXCEPTION
          'Receipt % says % paise have been applied and its allocation rows add '
          'up to %. ⚠️ REFUSED: the receipt total is what the list page and the '
          'buyer''s statement of account read, and the allocation rows are what '
          'says WHERE the money went. A gap between them is money that is '
          'either applied to a demand nobody can name, or missing from a demand '
          'that will keep ageing and keep being chased.',
          v_receipt.receipt_number, v_receipt.allocated_minor, v_actual.applied
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  /* --- ⭐ THE DEMAND SIDE ---------------------------------------- */
  IF v_demand_id IS NOT NULL THEN
    SELECT notice_number, total_minor, allocated_minor, interest_paid_minor
      INTO v_demand
    FROM demand_notices WHERE id = v_demand_id AND tenant_id = v_tenant_id;

    IF FOUND THEN
      SELECT COALESCE(sum(principal_minor + tax_minor), 0) AS applied,
             COALESCE(sum(interest_minor), 0)              AS interest
        INTO v_actual
      FROM receipt_allocations a
      JOIN receipts r ON r.id = a.receipt_id AND r.tenant_id = a.tenant_id
      WHERE a.demand_id = v_demand_id
        AND a.tenant_id = v_tenant_id
        -- ⚠️ A BOUNCED OR CANCELLED RECEIPT IS NOT MONEY. Its rows stay for
        -- the audit trail; they must not count towards a demand that is, in
        -- fact, still outstanding and still accruing interest.
        AND r.status IN ('pending','cleared');

      IF v_demand.allocated_minor <> v_actual.applied
         OR v_demand.interest_paid_minor <> v_actual.interest THEN
        RAISE EXCEPTION
          'Demand % says % paise of principal and tax and % of interest have '
          'been received, and the live allocations against it add up to % and '
          '%. ⚠️ REFUSED: these two numbers appear on different screens — the '
          'ageing report reads the demand, the statement of account reads the '
          'allocations — and when they disagree, one of them is telling a buyer '
          'they have paid when they have not, or chasing a buyer who has.',
          v_demand.notice_number, v_demand.allocated_minor,
          v_demand.interest_paid_minor, v_actual.applied, v_actual.interest
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS receipt_allocations_sum_exactly ON receipt_allocations;
CREATE CONSTRAINT TRIGGER receipt_allocations_sum_exactly
  AFTER INSERT OR UPDATE OR DELETE ON receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION receivables_allocation_sums_exactly();

DROP TRIGGER IF EXISTS receipts_allocation_totals ON receipts;
CREATE CONSTRAINT TRIGGER receipts_allocation_totals
  AFTER INSERT OR UPDATE OF allocated_minor, amount_minor, tds_credit_minor, status
  ON receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION receivables_allocation_sums_exactly();

DROP TRIGGER IF EXISTS demand_notices_allocation_totals ON demand_notices;
CREATE CONSTRAINT TRIGGER demand_notices_allocation_totals
  AFTER INSERT OR UPDATE OF allocated_minor, interest_paid_minor, total_minor
  ON demand_notices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION receivables_allocation_sums_exactly();


-- ############################################################################
-- SECTION 6 — ⭐⭐ THE DUNNING LADDER MAY NOT SKIP A RUNG
-- ############################################################################
--
-- ⭐⭐ reminder → first notice → final notice → cancellation warning.
--
--     A buyer shown a cancellation warning who never received a first notice
--     has a complete answer at the Authority — and the developer's own system
--     is the evidence against them, because `dunning_events` is exactly the
--     record that will be produced.
--
-- ⚠️ THE WAYS A RUNG GETS SKIPPED ARE ALL ORDINARY:
--
--   • A sweep runs for the first time against a demand that is already 70 days
--     overdue. Every threshold is in the past, so the naive implementation
--     sends the highest one.
--   • A back-fill imports a spreadsheet of letters somebody sent by hand, and
--     the spreadsheet only recorded the final ones.
--   • Somebody "escalates" from the UI on a demand whose earlier notices went
--     out under a previous system.
--
-- The application refuses all three in `lib/receivables/dunning.ts`. This
-- trigger is the second line, because the back-fill is exactly the path that
-- does not go through the application.
--
-- ⚠️ IT IS A BEFORE-ROW TRIGGER, NOT DEFERRED. A rung's validity is decided by
-- what has already been sent, which is a fact about the past — there is no
-- multi-statement construction to wait for, and refusing at the row is what
-- puts the message next to the letter that caused it.

CREATE OR REPLACE FUNCTION dunning_ladder_has_no_gaps()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_previous_rung integer;
  v_missing       text;
  v_last_sent     timestamptz;
BEGIN
  IF NEW.rung = 1 THEN
    RETURN NEW;
  END IF;

  SELECT max(rung), max(sent_at) INTO v_previous_rung, v_last_sent
  FROM dunning_events
  WHERE tenant_id = NEW.tenant_id
    AND demand_id = NEW.demand_id
    AND id       <> NEW.id
    AND rung      < NEW.rung;

  IF v_previous_rung IS NULL OR v_previous_rung <> NEW.rung - 1 THEN
    v_missing := CASE NEW.rung - 1
                   WHEN 1 THEN 'reminder'
                   WHEN 2 THEN 'first notice'
                   WHEN 3 THEN 'final notice'
                   ELSE 'previous notice'
                 END;
    RAISE EXCEPTION
      'This demand has not been sent a %, so a % cannot be sent. ⚠️ REFUSED: '
      'the ladder is reminder → first notice → final notice → cancellation '
      'warning, and a buyer shown a later rung who never received an earlier '
      'one has a complete answer at the Authority — with this table, which is '
      'the record the developer would produce, as the evidence against them. '
      'Send the % first. If it was sent outside this system, record it here '
      'with its real date and channel; back-filling the history is the '
      'supported path and skipping it is not.',
      v_missing, replace(NEW.stage::text, '_', ' '), v_missing
      USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ AND THE RUNGS MUST BE IN CHRONOLOGICAL ORDER. A final notice dated
  -- before the first notice reads, in the bundle produced at a hearing, as a
  -- developer who reconstructed the file afterwards.
  IF v_last_sent IS NOT NULL AND NEW.sent_at < v_last_sent THEN
    RAISE EXCEPTION
      'This % is dated %, which is before the previous rung was sent (%). '
      '⚠️ REFUSED: a ladder whose rungs are out of order reads, in the bundle '
      'produced at a hearing, as a file reconstructed after the event.',
      replace(NEW.stage::text, '_', ' '), NEW.sent_at, v_last_sent
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dunning_events_no_skipped_rung ON dunning_events;
CREATE TRIGGER dunning_events_no_skipped_rung
  BEFORE INSERT OR UPDATE OF stage, rung, demand_id, sent_at ON dunning_events
  FOR EACH ROW EXECUTE FUNCTION dunning_ladder_has_no_gaps();


-- ############################################################################
-- SECTION 7 — ⭐ AN ISSUED DEMAND IS FROZEN
-- ############################################################################
--
-- ⭐ THE DOCUMENT WAS SERVED. THE BUYER HAS A COPY.
--
--     Changing the amount, the due date, the tax, the interest terms or the
--     event it says fell due makes our register disagree with the paper in
--     their hand — and their copy is the one that counts. Worse, it does so
--     silently: every screen here shows the new figure, and the only evidence
--     the old one existed is in a change log nobody reads until there is a
--     dispute.
--
-- ⚠️ THE CORRECTION PATH IS A SUPERSEDING DEMAND, which leaves BOTH documents
-- in the record — the one that went out and the one that replaced it — and
-- which is what `demand_status` has a `superseded` value for.
--
-- ⚠️ `status`, `allocated_minor`, `interest_paid_minor`, `dunning_stage` and
-- the cancellation columns are NOT frozen. Those are what HAPPENS to the demand
-- afterwards, and freezing them would freeze the phase.

CREATE OR REPLACE FUNCTION demand_notice_is_frozen_once_issued()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_changed text;
BEGIN
  IF OLD.issued_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_changed := CASE
    WHEN NEW.principal_minor  IS DISTINCT FROM OLD.principal_minor  THEN 'the principal'
    WHEN NEW.total_minor      IS DISTINCT FROM OLD.total_minor      THEN 'the total'
    WHEN NEW.tax_minor        IS DISTINCT FROM OLD.tax_minor        THEN 'the tax'
    WHEN NEW.cgst_minor       IS DISTINCT FROM OLD.cgst_minor       THEN 'the CGST'
    WHEN NEW.sgst_minor       IS DISTINCT FROM OLD.sgst_minor       THEN 'the SGST'
    WHEN NEW.igst_minor       IS DISTINCT FROM OLD.igst_minor       THEN 'the IGST'
    WHEN NEW.cess_minor       IS DISTINCT FROM OLD.cess_minor       THEN 'the cess'
    WHEN NEW.due_date         IS DISTINCT FROM OLD.due_date         THEN 'the due date'
    WHEN NEW.notice_date      IS DISTINCT FROM OLD.notice_date      THEN 'the notice date'
    WHEN NEW.trigger_kind     IS DISTINCT FROM OLD.trigger_kind     THEN 'what triggered it'
    WHEN NEW.trigger_label    IS DISTINCT FROM OLD.trigger_label    THEN 'what triggered it'
    WHEN NEW.trigger_achieved_on
                              IS DISTINCT FROM OLD.trigger_achieved_on
                                                                    THEN 'when the trigger was achieved'
    WHEN NEW.interest_rate_bps IS DISTINCT FROM OLD.interest_rate_bps THEN 'the interest rate'
    WHEN NEW.compounding      IS DISTINCT FROM OLD.compounding      THEN 'the compounding rule'
    WHEN NEW.day_count        IS DISTINCT FROM OLD.day_count        THEN 'the day-count basis'
    WHEN NEW.grace_days       IS DISTINCT FROM OLD.grace_days       THEN 'the grace period'
    WHEN NEW.interest_basis_note
                              IS DISTINCT FROM OLD.interest_basis_note
                                                                    THEN 'the stated interest basis'
    WHEN NEW.milestone_id     IS DISTINCT FROM OLD.milestone_id     THEN 'the milestone'
    WHEN NEW.notice_number    IS DISTINCT FROM OLD.notice_number    THEN 'the notice number'
    ELSE NULL
  END;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'Demand % was issued on % and cannot have % changed. ⚠️ REFUSED: the '
      'buyer holds a copy of this document, and their copy is the one that '
      'counts. A register that quietly disagrees with the paper served on '
      'somebody is worse than no register — every screen here would show the '
      'new figure and nothing would show that the old one ever went out. '
      'Raise a corrected demand and mark this one superseded; both then stay '
      'in the record, which is what a superseding demand is for.',
      OLD.notice_number, OLD.issued_at::date, v_changed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS demand_notices_frozen_once_issued ON demand_notices;
CREATE TRIGGER demand_notices_frozen_once_issued
  BEFORE UPDATE ON demand_notices
  FOR EACH ROW EXECUTE FUNCTION demand_notice_is_frozen_once_issued();


-- ############################################################################
-- SECTION 8 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['receivable_policies','dunning_policies','demand_notices',
                         'demand_notice_documents','dunning_events','receipts',
                         'receipt_allocations'];
  -- ⚠️ `demand_notice_documents` has no `updated_at` — it is a rendered
  -- document, and a rendered document that can be updated is not evidence of
  -- what was sent.
  updatable text[] := ARRAY['receivable_policies','dunning_policies','demand_notices',
                            'dunning_events','receipts','receipt_allocations'];
BEGIN
  FOREACH t IN ARRAY updatable
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
  -- ⚠️ ALL SEVEN. `tests/security/change-log.test.ts` DISCOVERS tenant-scoped
  -- tables rather than listing them, precisely so a phase cannot opt itself out
  -- by forgetting — and for this phase the history is the point. "When did this
  -- demand's amount change, and who changed it?" is the question a buyer's
  -- advocate asks, and `receipt_allocations` carries the answer to "who decided
  -- my ₹5,00,000 went there?".
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

  -- ⚠️ AND THE IMPERSONATION GUARD. A support session wearing a customer's face
  -- must not be able to DELETE a demand, a receipt or a rung of the ladder.
  -- Every one of them is evidence in a dispute between the customer and their
  -- buyer, and its absence is not visible in the customer's own UI: a demand
  -- that was never raised and a demand that was deleted look identical from
  -- every screen they have.
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
-- ⚠️ NO DELETE ON `demand_notices`, `demand_notice_documents`, `dunning_events`
-- OR `receipts`, AND THAT IS THE POINT OF THOSE TABLES.
--
--   • A demand notice is a legal document that was served. Deleting one does
--     not correct it — it removes the developer's own evidence of what they
--     demanded and when, which is the evidence they need. A demand raised in
--     error is CANCELLED (with a reason) or SUPERSEDED.
--   • A rendered document is what the buyer actually received. Deleting it
--     leaves the developer unable to answer the first question in any dispute.
--   • A dunning event is the proof that the buyer was given every chance before
--     the allotment was threatened. A gap in the ladder is a gap in the case,
--     and a deleted rung IS a gap.
--   • A receipt is somebody's money. A receipt entered in error is CANCELLED,
--     and a cheque that came back is `bounced` — both of which keep the row and
--     both of which the buyer can be shown.
--
-- ⚠️ `receipt_allocations` DOES GET DELETE, NARROWLY, AND IT IS THE ONE
-- EXCEPTION. Re-applying a receipt — because a buyer said afterwards which
-- demand they meant (Section 59 gives them that right), or because a cheque
-- bounced and its allocations must be released — is ordinary, lawful work. It
-- is safe precisely because Section 5 fires on the delete: an allocation cannot
-- be removed without the demand and receipt totals being corrected in the same
-- transaction, so the books cannot be left unbalanced by it.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON receivable_policies      FROM ordence_app;
    REVOKE ALL ON dunning_policies         FROM ordence_app;
    REVOKE ALL ON demand_notices           FROM ordence_app;
    REVOKE ALL ON demand_notice_documents  FROM ordence_app;
    REVOKE ALL ON dunning_events           FROM ordence_app;
    REVOKE ALL ON receipts                 FROM ordence_app;
    REVOKE ALL ON receipt_allocations      FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON receivable_policies     TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON dunning_policies        TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON demand_notices          TO ordence_app;
    GRANT SELECT, INSERT                 ON demand_notice_documents TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON dunning_events          TO ordence_app;
    GRANT SELECT, INSERT, UPDATE         ON receipts                TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON receipt_allocations     TO ordence_app;
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
            'other tenant''s entire cash position — what was demanded, what came '
            'in, from which named buyers, how late, and who is being threatened '
            'with cancellation ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('receivable_policies','dunning_policies','demand_notices',
                    'demand_notice_documents','dunning_events','receipts',
                    'receipt_allocations')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can apply their money against '
            'another tenant''s demand ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('receivable_policies','dunning_policies','demand_notices',
                    'demand_notice_documents','dunning_events','receipts',
                    'receipt_allocations')
ORDER BY tablename;


-- Check 3 — ⭐ the composite foreign keys exist (Section 4).
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('receivable_policies_project_same_tenant'),
  ('receivable_policies_created_by_same_tenant'),
  ('dunning_policies_project_same_tenant'),
  ('dunning_policies_created_by_same_tenant'),
  ('demand_notices_booking_same_tenant'),
  ('demand_notices_milestone_same_tenant'),
  ('demand_notices_project_same_tenant'),
  ('demand_notices_lead_same_tenant'),
  ('demand_notices_issued_by_same_tenant'),
  ('demand_notices_superseded_by_same_tenant'),
  ('demand_notice_documents_demand_same_tenant'),
  ('dunning_events_demand_same_tenant'),
  ('dunning_events_document_same_tenant'),
  ('dunning_events_authorised_by_same_tenant'),
  ('receipts_booking_same_tenant'),
  ('receipts_project_same_tenant'),
  ('receipts_lead_same_tenant'),
  ('receipts_created_by_same_tenant'),
  ('receipt_allocations_receipt_same_tenant'),
  ('receipt_allocations_demand_same_tenant'),
  ('receipt_allocations_allocated_by_same_tenant')
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
  ('receipt_allocations_sum_exactly',    'receipt_allocations'),
  ('receipts_allocation_totals',         'receipts'),
  ('demand_notices_allocation_totals',   'demand_notices'),
  ('dunning_events_no_skipped_rung',     'dunning_events'),
  ('demand_notices_frozen_once_issued',  'demand_notices')
) AS expected(tgname, tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tgname
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal
ORDER BY expected.tgname;


-- Check 5 — ⭐⭐ THE ALLOCATION, PROVED NOT INSPECTED.
--
-- ₹5,00,000 against three demands of ₹1,80,000, ₹1,80,000 and ₹2,40,000. The
-- exact split — 1,80,000 + 1,80,000 + 1,40,000 — must be ACCEPTED. A split that
-- is one paisa short of the receipt's stated applied total must be REFUSED.
DO $$
DECLARE
  v_tenant   uuid := gen_random_uuid();
  v_project  uuid := gen_random_uuid();
  v_unit     uuid := gen_random_uuid();
  v_booking  uuid := gen_random_uuid();
  v_ms       uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_demand   uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_receipt  uuid := gen_random_uuid();
  v_amounts  bigint[] := ARRAY[18000000, 18000000, 24000000];
  v_applied  bigint[] := ARRAY[18000000, 18000000, 14000000];
  v_exact_ok boolean := false;
  v_short_ref boolean := false;
  i integer;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_recv_' || v_tenant,
            'recv-' || left(v_tenant::text, 8), 'Receivables verification', 'active');
  INSERT INTO projects (id, tenant_id, code, name)
    VALUES (v_project, v_tenant, 'VER', 'Verification Towers');
  INSERT INTO units (id, tenant_id, project_id, code)
    VALUES (v_unit, v_tenant, v_project, 'A-101');
  INSERT INTO bookings (id, tenant_id, reference, unit_id, agreement_value_minor)
    VALUES (v_booking, v_tenant, 'BKG-0001', v_unit, 60000000);

  FOR i IN 1..3 LOOP
    INSERT INTO payment_milestones (id, tenant_id, booking_id, label, amount_minor, sequence)
      VALUES (v_ms[i], v_tenant, v_booking, 'Stage ' || i, v_amounts[i], i);
    INSERT INTO demand_notices
      (id, tenant_id, notice_number, booking_id, milestone_id, project_id, status,
       trigger_kind, trigger_label, trigger_achieved_on, notice_date, due_date,
       principal_minor, total_minor, interest_basis_note, issued_at)
    VALUES
      (v_demand[i], v_tenant, 'DN/VER/000' || i, v_booking, v_ms[i], v_project,
       'issued', 'construction_event', 'On completion of slab ' || i,
       DATE '2026-01-10', DATE '2026-01-15', DATE '2026-01-30',
       v_amounts[i], v_amounts[i],
       'Interest at 11.10% per annum, simple, from the due date.', now());
  END LOOP;

  INSERT INTO receipts
    (id, tenant_id, receipt_number, booking_id, received_on, amount_minor,
     allocated_minor, method, status)
  VALUES
    (v_receipt, v_tenant, 'RCP/VER/0001', v_booking, DATE '2026-02-20',
     50000000, 50000000, 'neft', 'cleared');

  /* --- ⭐ THE EXACT SPLIT. MUST BE ACCEPTED. --------------------- */
  BEGIN
    FOR i IN 1..3 LOOP
      INSERT INTO receipt_allocations
        (tenant_id, receipt_id, demand_id, sequence, principal_minor, amount_minor,
         basis, explanation)
      VALUES
        (v_tenant, v_receipt, v_demand[i], i, v_applied[i], v_applied[i],
         'oldest_first', 'Applied oldest demand first.');
      UPDATE demand_notices SET allocated_minor = v_applied[i]
       WHERE id = v_demand[i] AND tenant_id = v_tenant;
    END LOOP;
    -- Forces the DEFERRED constraint triggers to fire now.
    SET CONSTRAINTS ALL IMMEDIATE;
    v_exact_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_exact_ok := false;
    RAISE NOTICE 'exact allocation refused: %', SQLERRM;
  END;

  /* --- ⭐⭐ ONE PAISA SHORT. MUST BE REFUSED. -------------------- */
  BEGIN
    UPDATE receipt_allocations SET amount_minor = amount_minor - 1,
                                   principal_minor = principal_minor - 1
     WHERE tenant_id = v_tenant AND receipt_id = v_receipt AND demand_id = v_demand[3];
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    v_short_ref := true;
  END;

  IF v_exact_ok AND v_short_ref THEN
    RAISE NOTICE 'PASS: ⭐⭐ ₹5,00,000 splits exactly across three demands, and a '
                 'split that is ONE PAISA short of the receipt is REFUSED.';
  ELSIF NOT v_exact_ok THEN
    RAISE WARNING '*** FAIL — an EXACT allocation was refused, so a receipt can '
                  'never be applied across more than one demand at all. ***';
  ELSE
    RAISE WARNING '*** FAIL — ⭐⭐ AN ALLOCATION ONE PAISA SHORT OF ITS RECEIPT '
                  'WAS ACCEPTED. The receipt says ₹5,00,000 applied; the rows '
                  'add to ₹4,99,999.99. Nothing errors, both numbers appear on '
                  'different screens, and the difference is found by whoever '
                  'prepares a statement of account for a buyer already in '
                  'dispute. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — ⭐⭐ THE LADDER CANNOT BE CLIMBED WITH A RUNG MISSING, and the last
-- rung cannot be sent without a named human behind it.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_project uuid := gen_random_uuid();
  v_unit    uuid := gen_random_uuid();
  v_booking uuid := gen_random_uuid();
  v_ms      uuid := gen_random_uuid();
  v_demand  uuid := gen_random_uuid();
  v_user    uuid := gen_random_uuid();
  v_skip_ref  boolean := false;
  v_step_ok   boolean := false;
  v_auto_ref  boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_dun_' || v_tenant,
            'dun-' || left(v_tenant::text, 8), 'Dunning verification', 'active');
  INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status)
    VALUES (v_user, v_tenant, 'user_dun_' || v_user, 'collections@example.com',
            'tenant_admin', 'active');
  INSERT INTO projects (id, tenant_id, code, name)
    VALUES (v_project, v_tenant, 'VER', 'Verification Towers');
  INSERT INTO units (id, tenant_id, project_id, code)
    VALUES (v_unit, v_tenant, v_project, 'B-902');
  INSERT INTO bookings (id, tenant_id, reference, unit_id)
    VALUES (v_booking, v_tenant, 'BKG-0002', v_unit);
  INSERT INTO payment_milestones (id, tenant_id, booking_id, label, amount_minor)
    VALUES (v_ms, v_tenant, v_booking, 'On completion of 7th slab', 25000000);
  INSERT INTO demand_notices
    (id, tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
     trigger_label, trigger_achieved_on, notice_date, due_date, principal_minor,
     total_minor, interest_basis_note, issued_at)
  VALUES
    (v_demand, v_tenant, 'DN/DUN/0001', v_booking, v_ms, 'issued',
     'construction_event', 'On completion of 7th slab', DATE '2026-01-10',
     DATE '2026-01-15', DATE '2026-01-30', 25000000, 25000000,
     'Interest at 11.10% per annum, simple, from the due date.', now());

  /* --- ⭐⭐ STRAIGHT TO THE FINAL NOTICE. MUST BE REFUSED. ------- */
  BEGIN
    INSERT INTO dunning_events
      (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor)
    VALUES (v_tenant, v_demand, 'final_notice', 3, 'email', 45, 25000000);
  EXCEPTION WHEN OTHERS THEN
    v_skip_ref := true;
  END;

  /* --- The ladder climbed properly. MUST be accepted. ----------- */
  --
  -- ⚠️ THREE SEPARATE STATEMENTS, NOT ONE MULTI-ROW INSERT. A BEFORE ROW
  -- trigger firing part-way through a multi-row INSERT is not guaranteed to see
  -- the earlier rows of its own command, so a batch would test the trigger
  -- against a snapshot that does not exist in production — where rungs are sent
  -- one letter at a time, days apart.
  BEGIN
    INSERT INTO dunning_events
      (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor,
       sent_at)
    VALUES (v_tenant, v_demand, 'reminder', 1, 'whatsapp', 3, 25000000,
            TIMESTAMPTZ '2026-02-02 10:00+05:30');
    INSERT INTO dunning_events
      (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor,
       sent_at)
    VALUES (v_tenant, v_demand, 'first_notice', 2, 'email', 15, 25000000,
            TIMESTAMPTZ '2026-02-14 10:00+05:30');
    INSERT INTO dunning_events
      (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor,
       sent_at)
    VALUES (v_tenant, v_demand, 'final_notice', 3, 'courier', 30, 25000000,
            TIMESTAMPTZ '2026-03-01 10:00+05:30');
    v_step_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_step_ok := false;
    RAISE NOTICE 'a properly climbed ladder was refused: %', SQLERRM;
  END;

  /* --- ⭐⭐ THE CANCELLATION WARNING WITH NOBODY BEHIND IT. ------ */
  BEGIN
    INSERT INTO dunning_events
      (tenant_id, demand_id, stage, rung, channel, days_overdue, outstanding_minor,
       sent_at)
    VALUES (v_tenant, v_demand, 'cancellation_warning', 4, 'post', 60, 25000000,
            TIMESTAMPTZ '2026-03-31 10:00+05:30');
  EXCEPTION WHEN OTHERS THEN
    v_auto_ref := true;
  END;

  IF v_skip_ref AND v_step_ok AND v_auto_ref THEN
    RAISE NOTICE 'PASS: ⭐⭐ the ladder cannot skip a rung, climbs correctly in '
                 'order, and a cancellation warning with no named human behind '
                 'it is REFUSED.';
  ELSIF NOT v_skip_ref THEN
    RAISE WARNING '*** FAIL — ⭐⭐ A FINAL NOTICE WAS SENT TO A BUYER WHO HAD '
                  'RECEIVED NOTHING BEFORE IT. That buyer has a complete answer '
                  'at the Authority, and this table — the developer''s own '
                  'record — is the evidence against them. ***';
  ELSIF NOT v_step_ok THEN
    RAISE WARNING '*** FAIL — a correctly climbed ladder was refused, so the '
                  'chase cannot be recorded at all. ***';
  ELSE
    RAISE WARNING '*** FAIL — ⭐⭐ A CANCELLATION WARNING WAS SENT WITH NO '
                  'AUTHORISING HUMAN. Threatening to terminate an allotment and '
                  'forfeit somebody''s money is not something a scheduled sweep '
                  'may do, and "the system sent it automatically" is not an '
                  'answer anybody can give at a hearing. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 7 — ⭐ ONE LIVE DEMAND PER MILESTONE.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_project uuid := gen_random_uuid();
  v_unit    uuid := gen_random_uuid();
  v_booking uuid := gen_random_uuid();
  v_ms      uuid := gen_random_uuid();
  v_dup_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_dmd_' || v_tenant,
            'dmd-' || left(v_tenant::text, 8), 'Demand verification', 'active');
  INSERT INTO projects (id, tenant_id, code, name)
    VALUES (v_project, v_tenant, 'VER', 'Verification Towers');
  INSERT INTO units (id, tenant_id, project_id, code)
    VALUES (v_unit, v_tenant, v_project, 'C-404');
  INSERT INTO bookings (id, tenant_id, reference, unit_id)
    VALUES (v_booking, v_tenant, 'BKG-0003', v_unit);
  INSERT INTO payment_milestones (id, tenant_id, booking_id, label, amount_minor)
    VALUES (v_ms, v_tenant, v_booking, 'On completion of 3rd slab', 87456300);

  INSERT INTO demand_notices
    (tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
     trigger_label, trigger_achieved_on, notice_date, due_date, principal_minor,
     total_minor, interest_basis_note, issued_at)
  VALUES
    (v_tenant, 'DN/DUP/0001', v_booking, v_ms, 'issued', 'construction_event',
     'On completion of 3rd slab', DATE '2026-01-10', DATE '2026-01-15',
     DATE '2026-01-30', 87456300, 87456300,
     'Interest at 11.10% per annum, simple, from the due date.', now());

  BEGIN
    -- Accounts raises it; the project accountant raises it too. Both correct.
    INSERT INTO demand_notices
      (tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
       trigger_label, trigger_achieved_on, notice_date, due_date, principal_minor,
       total_minor, interest_basis_note, issued_at)
    VALUES
      (v_tenant, 'DN/DUP/0002', v_booking, v_ms, 'issued', 'construction_event',
       'On completion of 3rd slab', DATE '2026-01-10', DATE '2026-01-16',
       DATE '2026-01-31', 87456300, 87456300,
       'Interest at 11.10% per annum, simple, from the due date.', now());
  EXCEPTION WHEN OTHERS THEN
    v_dup_ref := true;
  END;

  IF v_dup_ref THEN
    RAISE NOTICE 'PASS: ⭐ a milestone cannot carry two live demands.';
  ELSE
    RAISE WARNING '*** FAIL — ⭐ TWO LIVE DEMANDS WERE RAISED FOR ONE MILESTONE. '
                  'The buyer holds two documents asking for the same ₹8,74,563. '
                  'They pay one; the other ages into the 90+ bucket and the '
                  'dunning ladder starts climbing against somebody who has paid '
                  'in full. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 8 — ⭐ AN ISSUED DEMAND'S FIGURES CANNOT BE EDITED, and its status
-- still can.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_project uuid := gen_random_uuid();
  v_unit    uuid := gen_random_uuid();
  v_booking uuid := gen_random_uuid();
  v_ms      uuid := gen_random_uuid();
  v_demand  uuid := gen_random_uuid();
  v_edit_ref  boolean := false;
  v_status_ok boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_frz_' || v_tenant,
            'frz-' || left(v_tenant::text, 8), 'Freeze verification', 'active');
  INSERT INTO projects (id, tenant_id, code, name)
    VALUES (v_project, v_tenant, 'VER', 'Verification Towers');
  INSERT INTO units (id, tenant_id, project_id, code)
    VALUES (v_unit, v_tenant, v_project, 'D-1201');
  INSERT INTO bookings (id, tenant_id, reference, unit_id)
    VALUES (v_booking, v_tenant, 'BKG-0004', v_unit);
  INSERT INTO payment_milestones (id, tenant_id, booking_id, label, amount_minor)
    VALUES (v_ms, v_tenant, v_booking, 'On offer of possession', 50000000);
  INSERT INTO demand_notices
    (id, tenant_id, notice_number, booking_id, milestone_id, status, trigger_kind,
     trigger_label, trigger_achieved_on, notice_date, due_date, principal_minor,
     total_minor, interest_basis_note, issued_at)
  VALUES
    (v_demand, v_tenant, 'DN/FRZ/0001', v_booking, v_ms, 'issued', 'possession',
     'On offer of possession', DATE '2026-06-01', DATE '2026-06-02',
     DATE '2026-06-17', 50000000, 50000000,
     'Interest at 11.10% per annum, simple, from the due date.', now());

  BEGIN
    UPDATE demand_notices
       SET principal_minor = 55000000, total_minor = 55000000
     WHERE id = v_demand AND tenant_id = v_tenant;
  EXCEPTION WHEN OTHERS THEN
    v_edit_ref := true;
  END;

  BEGIN
    UPDATE demand_notices SET status = 'part_paid'
     WHERE id = v_demand AND tenant_id = v_tenant;
    v_status_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_status_ok := false;
  END;

  IF v_edit_ref AND v_status_ok THEN
    RAISE NOTICE 'PASS: ⭐ an issued demand''s figures are frozen, and what '
                 'HAPPENS to it afterwards still moves.';
  ELSIF NOT v_edit_ref THEN
    RAISE WARNING '*** FAIL — ⭐ AN ISSUED DEMAND''S PRINCIPAL WAS CHANGED. The '
                  'buyer holds a copy of the document; their copy is the one '
                  'that counts, and every screen here now shows a figure that '
                  'was never served on anybody. ***';
  ELSE
    RAISE WARNING '*** FAIL — the freeze is too broad: an issued demand cannot '
                  'even be marked part paid, which stops the phase working. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 9 — ⚠️ THE APPLICATION ROLE MAY NOT DELETE THE EVIDENCE.
-- A demand raised in error is cancelled or superseded; a receipt entered in
-- error is cancelled; a cheque that came back is bounced. Every one of those
-- keeps the row, and the row is what the customer shows their buyer.
SELECT
  expected.tbl AS table_name,
  CASE WHEN NOT has_table_privilege('ordence_app', expected.tbl, 'DELETE')
       THEN 'PASS (no DELETE)'
       ELSE '*** FAIL — the application role can DELETE ' || expected.tbl ||
            '. A demand that was never raised and a demand that was deleted look '
            'identical from every screen, and the second one is the developer''s '
            'own evidence of what they demanded ***'
  END AS verdict
FROM (VALUES ('demand_notices'), ('demand_notice_documents'),
             ('dunning_events'), ('receipts')) AS expected(tbl)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
ORDER BY expected.tbl;


-- Check 10 — ⭐ A BOUNCED RECEIPT CANNOT STILL BE APPLIED.
-- A cheque presented on the 5th and returned on the 12th was never money. If
-- its allocations stayed applied, the demand would show paid, the ladder would
-- stop, and the interest clock — which never stopped — would be understated.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_project uuid := gen_random_uuid();
  v_unit    uuid := gen_random_uuid();
  v_booking uuid := gen_random_uuid();
  v_bounce_ref boolean := false;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_bnc_' || v_tenant,
            'bnc-' || left(v_tenant::text, 8), 'Bounce verification', 'active');
  INSERT INTO projects (id, tenant_id, code, name)
    VALUES (v_project, v_tenant, 'VER', 'Verification Towers');
  INSERT INTO units (id, tenant_id, project_id, code)
    VALUES (v_unit, v_tenant, v_project, 'E-77');
  INSERT INTO bookings (id, tenant_id, reference, unit_id)
    VALUES (v_booking, v_tenant, 'BKG-0005', v_unit);

  BEGIN
    INSERT INTO receipts
      (tenant_id, receipt_number, booking_id, received_on, amount_minor,
       allocated_minor, method, status, bounced_on)
    VALUES
      (v_tenant, 'RCP/BNC/0001', v_booking, DATE '2026-02-05', 25000000,
       25000000, 'cheque', 'bounced', DATE '2026-02-12');
  EXCEPTION WHEN OTHERS THEN
    v_bounce_ref := true;
  END;

  IF v_bounce_ref THEN
    RAISE NOTICE 'PASS: ⭐ a bounced receipt cannot keep money applied against a '
                 'demand.';
  ELSE
    RAISE WARNING '*** FAIL — A BOUNCED CHEQUE STAYED APPLIED. The demand shows '
                  'paid, the dunning ladder stops, and the interest clock — '
                  'which never stopped — is understated for as long as nobody '
                  'notices. ***';
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;
