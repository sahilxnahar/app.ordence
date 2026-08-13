-- =====================================================================
--  0058 — MATTERS, LIMITATION, THE DIARY, AND THE CLIENT ACCOUNT
--  Ordence · v1.7.0-alpha · Legal, batch 1
-- =====================================================================
--
--  ⭐⭐ WHAT A LAW FIRM ACTUALLY HAD, AND IT WAS THREE WORDS
--  ------------------------------------------------------------------
--  🔴 "Matters", "Cases" and "Hearings" were LABELS OVER OTHER THINGS.
--
--    matters  → /assets?type=matter   — an asset with a type field
--    cases    → /assets?type=case     — the same asset register
--    hearings → /calendar             — with feature: null
--
--  ⚠️ So an advocate got an ASSET CATALOGUE wearing the word "matter"
--  and a generic diary wearing the word "hearing". No limitation date
--  anywhere. No discipline about the next date. No client account. The
--  label was doing all of the work.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴 AND LIMITATION IS THE ONE THING SOFTWARE MUST NOT GET WRONG
--  ══════════════════════════════════════════════════════════════════
--  Section 3 of the Limitation Act, 1963: a suit filed after the
--  prescribed period **shall be dismissed** — "although limitation has
--  not been set up as a defence". The court raises it of its own motion.
--  The client's claim is not weakened; it is GONE, and it is gone
--  because of a date in a diary.
--
--  ⚠️ Every other deadline in this product costs money. This one costs
--  a client their case, and the firm its indemnity policy.
-- =====================================================================


-- =====================================================================
--  ① THE MATTER
-- =====================================================================
CREATE TABLE IF NOT EXISTS legal_matters (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    matter_no           varchar(40) NOT NULL,
    title               varchar(500) NOT NULL,
    company_id          uuid REFERENCES companies(id) ON DELETE RESTRICT,

    matter_type         varchar(30) NOT NULL DEFAULT 'litigation',
    /** Which side we are on. It changes every deadline that follows. */
    our_side            varchar(30),
    opposing_party      varchar(500),

    court_name          varchar(255),
    court_id            uuid,
    jurisdiction        varchar(120),
    case_number         varchar(120),
    filing_date         date,

    /**
     * 🔴 THE DATE LIMITATION RUNS FROM, AND IT IS **NOT** THE FILING
     *    DATE.
     *
     * A contract broken on 3 April 2023 and a suit filed on 1 August
     * 2025 are two different facts, and only the first one decides
     * whether the suit is competent. Software that stores only the
     * filing date can never answer the question that matters.
     */
    cause_of_action_date date,
    /** Which Article of the Schedule, or which special statute. */
    limitation_article  varchar(40),
    limitation_days     integer,
    /**
     * ⭐ COMPUTED AND STORED — after s.12 exclusion and after s.4
     * roll-forward past a court closure. Stored because it is the figure
     * somebody diarised and acted on; recomputing it next year against
     * an edited holiday list would give a different answer to the one on
     * the file note.
     */
    limitation_expires_on date,
    limitation_note     text,

    responsible_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    status              varchar(20) NOT NULL DEFAULT 'open',
    closed_on           date,
    outcome             text,

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT legal_matters_type_known CHECK (
        matter_type IN ('litigation', 'arbitration', 'advisory', 'transaction',
                        'compliance', 'notice', 'execution', 'appeal')
    ),
    CONSTRAINT legal_matters_side_known CHECK (
        our_side IS NULL OR our_side IN ('plaintiff', 'defendant', 'appellant',
                                         'respondent', 'petitioner', 'complainant',
                                         'accused', 'claimant', 'advisory')
    ),
    CONSTRAINT legal_matters_status_known CHECK (
        status IN ('open', 'filed', 'part_heard', 'reserved', 'disposed', 'closed')
    ),

    -- 🔴 A CONTENTIOUS MATTER WITHOUT A CAUSE-OF-ACTION DATE IS THE ONE
    --    THAT GETS MISSED. Without it there is no limitation date, and a
    --    matter with no limitation date never appears on the report that
    --    would have saved it. Advisory work is exempt because nothing is
    --    being sued on.
    CONSTRAINT legal_matters_contentious_has_cause_date CHECK (
        matter_type IN ('advisory', 'transaction', 'compliance')
        OR cause_of_action_date IS NOT NULL
    ),

    -- ⚠️ A suit cannot be filed before the cause of action arose. It is
    -- always a typed year, and it always looks plausible.
    CONSTRAINT legal_matters_filed_after_cause CHECK (
        filing_date IS NULL OR cause_of_action_date IS NULL
        OR filing_date >= cause_of_action_date
    ),
    CONSTRAINT legal_matters_closed_is_dated CHECK (
        status NOT IN ('disposed', 'closed') OR closed_on IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_matters_no_unique
    ON legal_matters (tenant_id, matter_no);
-- ⭐ THE QUERY THE WHOLE TABLE EXISTS FOR: what expires soonest.
CREATE INDEX IF NOT EXISTS legal_matters_limitation_idx
    ON legal_matters (tenant_id, limitation_expires_on)
    WHERE limitation_expires_on IS NOT NULL AND status IN ('open', 'filed');
CREATE INDEX IF NOT EXISTS legal_matters_client_idx
    ON legal_matters (tenant_id, company_id, status);
CREATE INDEX IF NOT EXISTS legal_matters_owner_idx
    ON legal_matters (tenant_id, responsible_user_id, status);


-- =====================================================================
--  ② THE EVENTS THAT RESTART THE CLOCK
-- =====================================================================
--  ⭐⭐ SECTIONS 18 AND 19 — ACKNOWLEDGEMENT AND PART PAYMENT.
--
--  A signed acknowledgement of liability, or a part payment of a debt,
--  starts a **fresh** period of limitation from the date it was made.
--
--  🔴 BUT ONLY IF IT WAS MADE **BEFORE** THE PERIOD EXPIRED.
--
--  ⚠️ THAT IS THE WHOLE TRAP. An acknowledgement on day 1,094 of a
--  three-year period gives three more years. The same letter on day
--  1,096 gives nothing at all — the right was already dead, and nothing
--  in the Act revives it. The two letters look identical on a file.
CREATE TABLE IF NOT EXISTS legal_matter_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    matter_id           uuid NOT NULL REFERENCES legal_matters(id) ON DELETE CASCADE,

    event_type          varchar(30) NOT NULL,
    event_date          date NOT NULL,
    description         text NOT NULL,
    document_ref        varchar(255),

    /** For a part payment under s.19. */
    amount_minor        bigint,

    /**
     * 🔴 WHETHER THIS RESTARTED LIMITATION — and the answer is decided
     *    by the trigger below, never by whoever is typing.
     */
    resets_limitation   boolean NOT NULL DEFAULT false,
    previous_expiry     date,
    new_expiry          date,
    reset_note          text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT legal_matter_events_type_known CHECK (
        event_type IN ('acknowledgement', 'part_payment', 'legal_notice',
                       'reply_notice', 'filing', 'service', 'order', 'other')
    ),
    CONSTRAINT legal_matter_events_amount_positive CHECK (
        amount_minor IS NULL OR amount_minor > 0
    ),
    -- ⚠️ A part payment with no amount is not a part payment.
    CONSTRAINT legal_matter_events_part_payment_has_amount CHECK (
        event_type <> 'part_payment' OR amount_minor IS NOT NULL
    ),
    -- 🔴 A RESET MUST NAME BOTH DATES. "Limitation was extended" with no
    --    figures is a claim; "from 2026-04-03 to 2029-04-03" is a fact
    --    somebody can check against the letter.
    CONSTRAINT legal_matter_events_reset_is_dated CHECK (
        NOT resets_limitation OR (previous_expiry IS NOT NULL AND new_expiry IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS legal_matter_events_matter_idx
    ON legal_matter_events (tenant_id, matter_id, event_date DESC);


--  🔴 THE TRIGGER THAT REFUSES TO REVIVE A DEAD RIGHT.
--
--  ⚠️ Nothing in the Limitation Act revives a claim once the period has
--  run. An acknowledgement after expiry is evidence of a moral debt and
--  of nothing else — and a system that lets somebody tick "this extends
--  limitation" on it produces a diary entry that is comforting and
--  false, which is worse than no diary entry at all.
CREATE OR REPLACE FUNCTION ordence_guard_limitation_reset()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  m RECORD;
BEGIN
  IF NOT NEW.resets_limitation THEN
    RETURN NEW;
  END IF;

  SELECT * INTO m FROM legal_matters WHERE id = NEW.matter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.event_type NOT IN ('acknowledgement', 'part_payment') THEN
    RAISE EXCEPTION
      'Only an acknowledgement in writing (s.18) or a part payment (s.19) starts a fresh period of limitation. A % does not, however useful it is on the file.',
      NEW.event_type
      USING ERRCODE = 'raise_exception';
  END IF;

  IF m.limitation_expires_on IS NULL THEN
    RAISE EXCEPTION
      'This matter has no limitation date recorded, so there is nothing for this acknowledgement to extend. Set the cause-of-action date and the article first.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 🔴 THE COMPARISON THAT DECIDES EVERYTHING. "Before the expiry of the
  --    prescribed period" — s.18(1). On the last day still counts.
  IF NEW.event_date > m.limitation_expires_on THEN
    RAISE EXCEPTION
      'This % is dated % and limitation on this matter expired on %. Section 18 starts a fresh period only where the acknowledgement was made BEFORE the period ran out — nothing in the Act revives a right that has already died. Record it as an event, but not as a reset.',
      NEW.event_type, NEW.event_date, m.limitation_expires_on
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.previous_expiry IS DISTINCT FROM m.limitation_expires_on THEN
    RAISE EXCEPTION
      'The previous expiry recorded on this event (%) does not match the matter (%). The event has to name the date it actually extended, or the audit trail says nothing.',
      NEW.previous_expiry, m.limitation_expires_on
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_limitation_reset ON legal_matter_events;
CREATE TRIGGER trg_guard_limitation_reset
  BEFORE INSERT ON legal_matter_events
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_limitation_reset();


-- =====================================================================
--  ③ THE DIARY
-- =====================================================================
--  🔴 A HEARING THAT HAPPENED AND HAS NO NEXT DATE IS A MATTER THAT HAS
--     FALLEN OFF THE DIARY.
--
--  ⚠️ That is how a suit is dismissed for default of appearance — not
--  because anybody decided to abandon it, but because the next date was
--  never written down and nobody was listed to attend. The constraint
--  below is the whole reason this table exists rather than a calendar
--  entry.
CREATE TABLE IF NOT EXISTS legal_hearings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    matter_id           uuid NOT NULL REFERENCES legal_matters(id) ON DELETE CASCADE,

    hearing_date        date NOT NULL,
    /** "Arguments", "evidence", "framing of issues", "mention". */
    purpose             varchar(255),
    before_judge        varchar(255),
    court_hall          varchar(60),
    /** Serial on the cause list, when there is one. */
    cause_list_item     varchar(40),

    status              varchar(20) NOT NULL DEFAULT 'listed',

    appeared_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    counsel_name        varchar(255),

    outcome             text,
    adjourned_reason    varchar(255),
    /** 🔴 The field that keeps the matter on the diary. */
    next_date           date,
    /** Set when the hearing ended the matter rather than continuing it. */
    disposed            boolean NOT NULL DEFAULT false,

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT legal_hearings_status_known CHECK (
        status IN ('listed', 'held', 'adjourned', 'not_reached', 'cancelled')
    ),

    -- 🔴 THE CONSTRAINT THIS TABLE EXISTS FOR.
    --    A hearing that was held or adjourned must produce EITHER the
    --    next date OR a disposal. Neither means nobody knows when to
    --    turn up next, and the first sign of that is an order sheet
    --    recording dismissal for non-appearance.
    --
    -- ⚠️ `not_reached` is deliberately included: a matter that was not
    --    reached still gets a next date, and it is the most commonly
    --    forgotten one because nothing happened.
    CONSTRAINT legal_hearings_held_has_a_future CHECK (
        status NOT IN ('held', 'adjourned', 'not_reached')
        OR next_date IS NOT NULL
        OR disposed
    ),

    -- ⚠️ The next date cannot be in the past relative to the hearing.
    CONSTRAINT legal_hearings_next_is_later CHECK (
        next_date IS NULL OR next_date > hearing_date
    ),
    -- ⚠️ An adjournment says why. "Adjourned" with no reason is the
    -- entry a client asks about six months later.
    CONSTRAINT legal_hearings_adjourned_is_explained CHECK (
        status <> 'adjourned' OR adjourned_reason IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS legal_hearings_matter_idx
    ON legal_hearings (tenant_id, matter_id, hearing_date DESC);
-- ⭐ Tomorrow's list, and the one thing a clerk opens the product for.
CREATE INDEX IF NOT EXISTS legal_hearings_diary_idx
    ON legal_hearings (tenant_id, hearing_date)
    WHERE status = 'listed';


-- =====================================================================
--  ④ WHEN THE COURT IS SHUT — SECTION 4
-- =====================================================================
--  ⭐ "Where the prescribed period for any suit, appeal or application
--    expires on a day when the court is closed, the suit, appeal or
--    application may be instituted on the day the court reopens."
--
--  ⚠️ MOST SOFTWARE DOES NOT DO THIS, and it fails in the safe
--  direction — it shows a date earlier than the true one. But it also
--  makes the product wrong when a client asks whether there is still
--  time, and "the system says yesterday" is not an answer.
CREATE TABLE IF NOT EXISTS court_holidays (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    /** Free text — a workspace may practise before several courts. */
    court_name          varchar(255) NOT NULL,
    holiday_date        date NOT NULL,
    description         varchar(255),
    /** Summer vacation, Dussehra, Christmas — a named block. */
    block_name          varchar(120),

    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS court_holidays_unique
    ON court_holidays (tenant_id, court_name, holiday_date);
CREATE INDEX IF NOT EXISTS court_holidays_date_idx
    ON court_holidays (tenant_id, holiday_date);


-- =====================================================================
--  ⑤ THE CLIENT ACCOUNT
-- =====================================================================
--  ⭐⭐ MONEY HELD FOR A CLIENT IS NOT THE FIRM'S MONEY.
--
--  Bar Council of India Rules, Chapter II, Section II — an advocate must
--  keep accounts of the client's money entrusted to him, showing what
--  was received, what was spent on the client's behalf, and what is
--  still held.
--
--  🔴 THE CARDINAL RULE IS NOT "KEEP RECORDS". IT IS THIS: **ONE
--     CLIENT'S MONEY MAY NEVER FUND ANOTHER CLIENT'S DISBURSEMENT** —
--     not even for an afternoon, not even where it is repaid the same
--     week.
--
--  ⚠️ AND THE TEST FOR IT IS ARITHMETIC, NOT INTENTION. If any client's
--  ledger goes into debit, the firm has paid out money it did not hold
--  for that client, which means it paid out somebody else's. That is why
--  the trigger below is the entire control, in one comparison.
--
--  ⭐ AND IT CORRECTS SOMETHING THIS PRODUCT ALREADY DECIDED. In
--  v0.98.0 a legal retainer was modelled as an unapplied customer
--  receipt, and that is still right commercially — one pot of the
--  client's money, one balance. But an unapplied receipt sitting in the
--  firm's bank account IS CLIENT MONEY IN THE FIRM'S ACCOUNT, and
--  nothing said so. This table is that missing half.
CREATE TABLE IF NOT EXISTS client_account_entries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    /** Nullable — money can be held generally for a client. */
    matter_id           uuid REFERENCES legal_matters(id) ON DELETE RESTRICT,

    entry_date          date NOT NULL,
    entry_kind          varchar(30) NOT NULL,
    description         text NOT NULL,
    reference_no        varchar(60),

    /**
     * ⭐ SIGNED, AND THERE IS NO DIRECTION COLUMN. Money in is positive,
     * money out is negative. A separate flag alongside an unsigned
     * amount is two facts that can contradict each other — the same
     * rule the stock ledger has followed since 0029.
     */
    amount_minor        bigint NOT NULL,

    /**
     * 🔴 A TRANSFER TO THE FIRM'S OWN ACCOUNT MUST NAME THE BILL.
     *    Fees come out of client money only once they have been billed.
     *    A transfer with no invoice behind it is the firm helping itself
     *    to money it is holding, which is the finding that ends careers.
     */
    invoice_id          uuid REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    /** The firm's bank movement this corresponds to. */
    bank_reference      varchar(120),

    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT client_account_entries_kind_known CHECK (
        entry_kind IN ('receipt', 'disbursement', 'transfer_to_office',
                       'refund_to_client', 'transfer_between_matters')
    ),
    CONSTRAINT client_account_entries_non_zero CHECK (amount_minor <> 0),

    -- ⚠️ THE SIGN MUST MATCH THE STATED KIND. A receipt for a negative
    -- amount is somebody's sign flipped in an import, and it is
    -- perfectly valid arithmetic pointing the wrong way.
    CONSTRAINT client_account_entries_sign_matches_kind CHECK (
        (entry_kind = 'receipt' AND amount_minor > 0)
        OR (entry_kind IN ('disbursement', 'transfer_to_office', 'refund_to_client')
            AND amount_minor < 0)
        OR entry_kind = 'transfer_between_matters'
    ),

    -- 🔴 FEES OUT ONLY AGAINST A BILL.
    CONSTRAINT client_account_entries_office_transfer_has_bill CHECK (
        entry_kind <> 'transfer_to_office' OR invoice_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS client_account_entries_client_idx
    ON client_account_entries (tenant_id, company_id, entry_date);
CREATE INDEX IF NOT EXISTS client_account_entries_matter_idx
    ON client_account_entries (tenant_id, matter_id, entry_date)
    WHERE matter_id IS NOT NULL;


--  🔴🔴 THE ENTIRE TRUST-ACCOUNTING CONTROL, IN ONE COMPARISON.
--
--  ⚠️ A client ledger that goes into debit means the firm paid out money
--  it was not holding for that client — which means it paid out another
--  client's money. There is no innocent version of that number, and it
--  is the single figure a Bar Council inspection looks for.
--
--  ⭐ IT IS CHECKED PER CLIENT **AND** PER MATTER. A firm holding
--  ₹5,00,000 for a client on one matter cannot spend it on that same
--  client's other matter without moving it deliberately — because the
--  two matters may bill separately, settle separately, and be disputed
--  separately.
CREATE OR REPLACE FUNCTION ordence_guard_client_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  client_balance bigint;
  matter_balance bigint;
  client_name    text;
BEGIN
  IF NEW.amount_minor >= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO client_balance
    FROM client_account_entries
   WHERE tenant_id = NEW.tenant_id
     AND company_id = NEW.company_id;

  SELECT name INTO client_name FROM companies WHERE id = NEW.company_id;

  IF client_balance + NEW.amount_minor < 0 THEN
    RAISE EXCEPTION
      'This would take %''s client account to %. A client ledger cannot go into debit — money paid out that was not held for this client is another client''s money, and there is no version of that which is anything else. Ask for funds on account first.',
      COALESCE(client_name, 'the client'),
      to_char((client_balance + NEW.amount_minor)::numeric / 100, 'FM999999999990.00')
      USING ERRCODE = 'raise_exception';
  END IF;

  -- ⭐ And per matter, where one is named.
  IF NEW.matter_id IS NOT NULL THEN
    SELECT COALESCE(SUM(amount_minor), 0) INTO matter_balance
      FROM client_account_entries
     WHERE tenant_id = NEW.tenant_id
       AND matter_id = NEW.matter_id;

    IF matter_balance + NEW.amount_minor < 0 THEN
      RAISE EXCEPTION
        'This matter holds only % of client money and this pays out more. Funds held on one matter are not available to another, even for the same client — move them deliberately with a transfer, so the file shows it happened.',
        to_char(matter_balance::numeric / 100, 'FM999999999990.00')
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_client_account ON client_account_entries;
CREATE TRIGGER trg_guard_client_account
  BEFORE INSERT ON client_account_entries
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_client_account();


-- =====================================================================
--  ROW-LEVEL SECURITY
-- =====================================================================
--  ⚠️ app_platform_scope() belongs in USING and NEVER in WITH CHECK.

ALTER TABLE legal_matters ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_matters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_matters_tenant_isolation ON public.legal_matters;
CREATE POLICY legal_matters_tenant_isolation ON public.legal_matters
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE legal_matter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_matter_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_matter_events_tenant_isolation ON public.legal_matter_events;
CREATE POLICY legal_matter_events_tenant_isolation ON public.legal_matter_events
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE legal_hearings ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_hearings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_hearings_tenant_isolation ON public.legal_hearings;
CREATE POLICY legal_hearings_tenant_isolation ON public.legal_hearings
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE court_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE court_holidays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS court_holidays_tenant_isolation ON public.court_holidays;
CREATE POLICY court_holidays_tenant_isolation ON public.court_holidays
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE client_account_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_account_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_account_entries_tenant_isolation ON public.client_account_entries;
CREATE POLICY client_account_entries_tenant_isolation ON public.client_account_entries
    USING      (tenant_id = app_current_tenant_id() OR app_platform_scope())
    WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON legal_matters          TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_matter_events    TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_hearings         TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON court_holidays         TO ordence_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON client_account_entries TO ordence_app;


-- =====================================================================
--  ⚠️ WHAT IS DELIBERATELY NOT HERE
-- =====================================================================
--  NO SHIPPED LIMITATION PERIODS IN THE DATABASE. The Articles live in
--  `lib/legal/limitation.ts` where they can be read, argued with and
--  tested. A table of periods somebody can edit is a table where a
--  three-year period quietly becomes one, and every matter created
--  afterwards inherits it.
--
--  NO `days_remaining` COLUMN. It is `expires_on - current_date` and a
--  stored copy needs a nightly job. The morning the job does not run is
--  the morning a matter shows 40 days left on the day it expires.
--
--  NO COURT-FEE TABLE YET. Court fees are levied under the Court Fees
--  Act as amended by each State, and the schedules differ enough that
--  shipping one set would be wrong everywhere except one State. That is
--  batch 2, and it will ship the STRUCTURE with no rates rather than
--  rates that are confidently wrong.
--
--  NO SEPARATE RETAINER TABLE — still. A retainer is money held for the
--  client, which is exactly `client_account_entries` plus the unapplied
--  receipt that has existed since v0.98.0. Two balances for one pot is
--  the failure that reconciliation exists to find.
-- =====================================================================
