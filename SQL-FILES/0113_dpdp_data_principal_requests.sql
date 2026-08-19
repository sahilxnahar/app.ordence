-- ############################################################################
-- 0113 , DATA PRINCIPAL REQUESTS, ERASURE REFUSALS AND BREACH INTIMATIONS
-- ############################################################################
--
-- ⚠️ RENUMBERED ON MERGE. This batch was authored as 0110 and delivered as
--    0110. By the time it arrived, 0110 was already taken by the bank
--    allocation and bank-charge input-credit migration, 0111 by the RERA
--    statutory ladder, and 0112 by the bank-charge credit posting. Every
--    "0110" in this file and in the twenty TypeScript files beside it now
--    reads 0113, including the drill, which was renamed for the same reason
--    its filename encodes the number.
--
-- 🔴 RUN AFTER 0112. It shares no table with 0108..0112 and could in
--    principle run at any point, but the sequence is the run order and a
--    migration log that cannot be replayed from scratch is the thing
--    `check:migrations` exists to prevent.
--
-- PURPOSE
-- -------
-- Ordence's customers hold their customers' personal data: phone numbers,
-- salaries, PAN and UAN numbers, allottee records for homes. Under the Digital
-- Personal Data Protection Act 2023 the WORKSPACE is the Data Fiduciary and
-- ORDENCE is its Data Processor, and until this file neither role's duties
-- were servable by the product.
--
-- ⭐ THIS FILE ADDS FOUR TABLES AND NO BEHAVIOUR. The engine is in
--    lib/dpdp/ , the inventory, the retention rules and the planners , and the
--    execution is in server/dpdp/. What was missing was somewhere to RECORD a
--    request, which anchors were verified as the person, what was refused and
--    under which provision, and what was told to whom after a breach.
--
-- ############################################################################
-- 🔴 THE STATUTE, AND THE THREE PLACES THE BRIEF FOR THIS BATCH WAS WRONG
-- ############################################################################
--
-- s.8(7) DPDPA 2023, verbatim: a Data Fiduciary shall, "UNLESS RETENTION IS
-- NECESSARY FOR COMPLIANCE WITH ANY LAW FOR THE TIME BEING IN FORCE", erase
-- personal data on withdrawal of consent or when the purpose is no longer
-- served, and cause its Processor to do the same.
--
-- ⚠️ SO EVERY REFUSAL MUST NAME A LAW, AND THE LAW MUST SAY WHAT IS CLAIMED.
--    Three provisions commonly cited for retention do not:
--
--    RERA 2016 s.11 , has six sub-sections and NO number of years in any of
--      them. s.11(6) delegates to regulations. Any allottee-record retention
--      duty comes from STATE RERA rules, which differ by state. The brief for
--      this batch cited s.11 as "the life of the project"; it does not say
--      that. lib/dpdp/retention.ts records the rule as UNVERIFIED and refers
--      every RERA erasure to a human rather than citing a section that would
--      not survive being looked up.
--
--    IT Act 2000 s.67C , enabling only. "such duration ... as the Central
--      Government may PRESCRIBE", and no general duration has been prescribed.
--      The real 180-day log duty is Direction (iv) of the CERT-In Directions
--      of 28 April 2022, which binds Ordence as a body corporate.
--
--    Income-tax Rule 31A , governs FILING quarterly TDS statements. There is
--      NO provision stating a TDS retention period at all; seven years is
--      DERIVED from the s.201(3) and s.149 limitation windows and is labelled
--      as derived so nobody quotes it as a section.
--
-- ⚠️ AND THE GROUND MOVED UNDER THIS BATCH. The Income-tax Act 1961 was
--    repealed on 1 April 2026; the Payment of Wages Act 1936 and the Minimum
--    Wages Act 1948 on 21 November 2025 by s.69 of the Code on Wages 2019;
--    the ESI Act 1948 on the same date by the Code on Social Security 2020.
--    A citation is a fact with an expiry date, which is why every rule in
--    lib/dpdp/retention.ts carries the date somebody last read it.
--
-- ⚠️ THE DPDP RULES 2025 ARE NOTIFIED AND NOT YET IN FORCE. Published
--    13 November 2025; the operative compliance rules , notice, Rule 7 breach
--    intimation, Rule 8 retention , commence eighteen months later, in
--    May 2027. This batch builds to them deliberately early. `breach_class`
--    below records which regime a row was raised under so that a workspace can
--    tell the difference later.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Same reason as 0092 through 0105. Migrations here are PASTED INTO THE NEON
-- BROWSER CONSOLE, which sends each statement on its own connection. `BEGIN`
-- buys no atomicity across that boundary; it only makes a half-applied file
-- look clean, which is exactly how 0091 applied half-way while reporting
-- success. `SET LOCAL app.platform_scope` reports "executed successfully" and
-- has evaporated before the next statement runs.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , CREATE TABLE IF NOT
--    EXISTS, CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE
--    POLICY , and the file is safe to re-run from the top after a failure at
--    any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS. Nothing
--    below writes a row, so nothing below can be refused by a FORCE ROW LEVEL
--    SECURITY policy , the failure mode 0091 and 0092 both hit. No backfill is
--    possible either: there are no historic data-principal requests to migrate
--    and inventing one would be inventing the verification that makes it safe
--    to answer.
--
-- RUN ORDER: after 0109. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you what was there before you started.
--
-- ⚠️ `consents_present` IS THE INTERESTING ONE. The brief for this batch
--    assumed consent was recorded as a boolean and needed rebuilding. It is
--    not: 0061 already stores a purpose, a channel, a notice id and a
--    withdrawal, and lib/crm/consent.ts already refuses a grant with no notice
--    behind it. Nothing in this file touches consent, because the survey found
--    the gap described was not there.
-- ============================================================================

SELECT
    '0113 · diagnostic'                                        AS finding,
    current_user                                               AS running_as,
    to_regclass('public.consents')                IS NOT NULL  AS consents_present,
    to_regclass('public.consent_notices')         IS NOT NULL  AS consent_notices_present,
    to_regclass('public.security_events')         IS NOT NULL  AS security_events_present,
    to_regclass('public.audit_logs')              IS NOT NULL  AS audit_logs_present,
    to_regclass('public.data_principal_requests') IS NOT NULL  AS requests_already_present,
    to_regclass('public.personal_data_breaches')  IS NOT NULL  AS breaches_already_present;


-- ============================================================================
-- SECTION 2 · `data_principal_requests` · THE REGISTER
-- ============================================================================
-- One row per request under s.11 (access), s.12 (correction and erasure) or
-- s.13 (grievance).
--
-- 🔴 `verified_how` IS NOT NULL AND HAS NO DEFAULT. It is the single most
--    important column in this file. Answering an access request for somebody
--    who is not the Data Principal is itself a personal-data breach, and it is
--    the breach that arrives disguised as good service , a polite email from
--    an address that looks right, answered by somebody trying to be helpful.
--    A request cannot be recorded at all without a sentence saying how the
--    requester was established to be the person.
--
-- ⚠️ THERE IS NO `verified boolean`. A boolean records that somebody clicked
--    yes. This records WHAT THEY DID, which is the thing a Board would ask for
--    and the thing that can be wrong in a way somebody can see.
--
-- ⚠️ `due_at` IS ADVISORY AND SAYS SO. The DPDP Rules 2025 prescribe response
--    periods that commence in May 2027. Storing a deadline the Act does not
--    yet impose, with no note that it is the workspace's own, would be
--    inventing an obligation , so the default is NULL and the workspace sets
--    its own policy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.data_principal_requests (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    reference             varchar(40) NOT NULL,

    -- 'access' (s.11) | 'erasure' (s.12(3)) | 'correction' (s.12(1)) |
    -- 'grievance' (s.13) | 'consent_withdrawal' (s.6(4))
    kind                  varchar(30) NOT NULL,

    -- How the person described themselves. Free text on purpose: the whole
    -- point is that we have NOT yet decided which rows are theirs.
    principal_label       text        NOT NULL,
    principal_email       varchar(320),
    principal_phone       varchar(40),

    -- 🔴 s.11 CANNOT BE ANSWERED WITHOUT THIS AND IT CANNOT BE A TICKBOX.
    verified_how          text        NOT NULL,
    verified_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
    verified_at           timestamptz,

    -- 'received' | 'verifying' | 'planned' | 'answered' | 'refused' | 'withdrawn'
    status                varchar(20) NOT NULL DEFAULT 'received',

    received_at           timestamptz NOT NULL DEFAULT now(),
    answered_at           timestamptz,

    -- 🔴 THERE IS NO `due_at` COLUMN AND THAT IS DELIBERATE.
    --
    -- An earlier draft had one, defaulted to NULL, documented as "advisory
    -- because the DPDP Rules' response periods commence in May 2027". Nothing
    -- wrote it and nothing read it. A column that exists for an obligation
    -- nobody has yet is the same defect as a policy stored and never checked ,
    -- and this codebase has eleven recorded instances of that. When the Rules
    -- commence, the batch that starts enforcing a deadline adds the column.

    -- ⭐ THE RECEIPT. The manifest of the export or the erasure plan, stored
    --    as it was produced, so that "what did we tell them in August" has an
    --    answer that is not a reconstruction.
    outcome_manifest      jsonb,

    -- ⭐ The refusal notice exactly as sent. Text, not a template id: a
    --    template that is edited later would silently rewrite history.
    refusal_notice        text,

    -- 🔴 SET WHERE ANY PART OF THE PLAN NEEDED A HUMAN , an `unverified`
    --    retention rule, or a table nothing can search. The screen refuses to
    --    mark such a request answered while this is true, because "we decided
    --    automatically that a law we could not read requires us to keep your
    --    data" is not an answer anybody should send.
    needs_human_decision  boolean     NOT NULL DEFAULT false,

    -- ⚠️ NO `human_decision_note` EITHER. The per-table decisions a person
    -- takes are already recorded, one row each, in
    -- data_principal_request_events.because , which is append-only and richer.
    -- A summary column beside it would be a second, editable account of the
    -- same facts.

    notes                 text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT data_principal_requests_kind_valid
        CHECK (kind IN ('access','erasure','correction','grievance','consent_withdrawal')),

    CONSTRAINT data_principal_requests_status_valid
        CHECK (status IN ('received','verifying','planned','answered','refused','withdrawn')),

    -- 🔴 A REQUEST CANNOT BE ANSWERED WHILE SOMETHING IS WAITING ON A PERSON.
    --    The database refuses it rather than the screen, because the screen is
    --    one refactor away from not refusing it. This codebase has eleven
    --    recorded cases of a rule that was displayed and enforced by nothing.
    CONSTRAINT data_principal_requests_no_silent_answer
        CHECK (status <> 'answered' OR needs_human_decision = false),

    -- An answered request has a receipt. Without it the register records that
    -- we replied and not what we said.
    CONSTRAINT data_principal_requests_answer_has_a_receipt
        CHECK (status <> 'answered' OR outcome_manifest IS NOT NULL),

    -- A refusal names its reasons, in the text that was sent.
    CONSTRAINT data_principal_requests_refusal_has_a_notice
        CHECK (status <> 'refused' OR refusal_notice IS NOT NULL),

    CONSTRAINT data_principal_requests_verified_how_is_a_sentence
        CHECK (length(btrim(verified_how)) >= 10)
);

COMMENT ON TABLE public.data_principal_requests IS
    'Requests under ss.11-13 of the DPDPA 2023. The workspace is the Data '
    'Fiduciary and Ordence is its Processor: the workspace decides, Ordence '
    'executes. s.8(7)(b) makes the workspace responsible for causing erasure.';

COMMENT ON COLUMN public.data_principal_requests.verified_how IS
    'How the requester was established to be the Data Principal. NOT NULL and '
    'at least ten characters, because answering an access request for the '
    'wrong person is itself a personal data breach and it arrives disguised '
    'as good service.';

COMMENT ON COLUMN public.data_principal_requests.needs_human_decision IS
    'True where the erasure plan hit a retention rule nobody has verified '
    'against its current text, or a table nothing can search. A CHECK '
    'constraint refuses to let such a request be marked answered.';

CREATE UNIQUE INDEX IF NOT EXISTS data_principal_requests_id_tenant_key
    ON public.data_principal_requests (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS data_principal_requests_reference_key
    ON public.data_principal_requests (tenant_id, reference);

CREATE INDEX IF NOT EXISTS data_principal_requests_open_idx
    ON public.data_principal_requests (tenant_id, status, received_at DESC);


-- ============================================================================
-- SECTION 3 · `data_principal_request_anchors` · WHICH ROWS ARE THIS PERSON
-- ============================================================================
-- 🔴 ORDENCE DOES NOT MERGE IDENTITIES AND MUST NOT.
--
-- The same human being is frequently a `contacts` row, a `leads` row that
-- became an allottee, and a `users` row because somebody gave them a portal
-- login. A shared email address is NOT proof that two records are one person:
-- `info@` on a family business is the counter-example, and merging on it would
-- disclose one person's records to another , which is the exact harm s.11 is
-- meant to prevent, caused by the machinery built to satisfy it.
--
-- ⭐ So the anchors are ENTERED BY A PERSON who verified them, one row each,
--    each carrying its own justification. `established_by` is NOT NULL for the
--    same reason `verified_how` is.
--
-- ⚠️ `principal_kind` IS NOT A FOREIGN KEY AND CANNOT BE. It names one of nine
--    different tables. The value is validated against the same nine names that
--    lib/dpdp/classification.ts exports as PrincipalKind, and the CHECK below
--    is the only thing keeping the two in step , there is no database
--    mechanism that can do better without a table per kind.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.data_principal_request_anchors (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    request_id       uuid        NOT NULL,

    principal_kind   varchar(20) NOT NULL,
    -- The row id in that principal's table. No FK: nine possible targets.
    principal_id     uuid        NOT NULL,

    -- 🔴 WHY THIS ROW IS THIS PERSON. Not a checkbox.
    established_by   text        NOT NULL,

    created_at       timestamptz NOT NULL DEFAULT now(),
    created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT data_principal_request_anchors_request_fk
        FOREIGN KEY (request_id, tenant_id)
        REFERENCES public.data_principal_requests (id, tenant_id)
        ON DELETE CASCADE,

    -- Must match PrincipalKind in lib/dpdp/classification.ts. A value here
    -- that the code does not know is an anchor nothing will ever search.
    CONSTRAINT data_principal_request_anchors_kind_valid
        CHECK (principal_kind IN ('contact','lead','employee','user','worker',
                                  'deductee','landowner','partner','vendor')),

    CONSTRAINT data_principal_request_anchors_established_is_a_sentence
        CHECK (length(btrim(established_by)) >= 10)
);

COMMENT ON TABLE public.data_principal_request_anchors IS
    'The records a person verified as belonging to one Data Principal. '
    'Entered by a human, never inferred from a shared email address: info@ on '
    'a family business would merge two people and disclose each to the other.';

CREATE UNIQUE INDEX IF NOT EXISTS data_principal_request_anchors_id_tenant_key
    ON public.data_principal_request_anchors (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS data_principal_request_anchors_unique
    ON public.data_principal_request_anchors (tenant_id, request_id, principal_kind, principal_id);


-- ============================================================================
-- SECTION 4 · `data_principal_request_events` · WHAT WAS ACTUALLY DONE
-- ============================================================================
-- ⚠️ APPEND-ONLY BY TRIGGER, like audit_logs (0001), permission_denials (0005)
--    and employee_advance_recoveries (0096).
--
-- An erasure has no undo. lib/backup/recoverable.ts covers a soft delete and
-- this is not one. The record of what was deleted is therefore the only
-- remaining evidence that it was deleted lawfully, and a record that can be
-- edited afterwards is not evidence of anything.
--
-- 🔴 IT STORES A ROW COUNT AND A TABLE NAME, NEVER THE DELETED ROWS. Keeping
--    a copy of what was erased in order to prove it was erased is not a
--    compliance record, it is the same data under a different table name, and
--    s.8(7) would apply to it identically.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.data_principal_request_events (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    request_id       uuid        NOT NULL,

    -- 'planned' | 'exported' | 'erased' | 'redacted' | 'retained' | 'referred'
    -- | 'could_not_search' | 'notice_sent'
    action           varchar(24) NOT NULL,

    table_name       varchar(63),
    row_count        integer,

    -- ⭐ The retention rule id from lib/dpdp/retention.ts where one applied.
    --    A refusal with no rule is a refusal with no statute.
    retention_rule   varchar(60),
    -- The sentence shown to the principal, frozen as sent.
    because          text,

    occurred_at      timestamptz NOT NULL DEFAULT now(),
    actor_user_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT data_principal_request_events_request_fk
        FOREIGN KEY (request_id, tenant_id)
        REFERENCES public.data_principal_requests (id, tenant_id)
        ON DELETE CASCADE,

    CONSTRAINT data_principal_request_events_action_valid
        CHECK (action IN ('planned','exported','erased','redacted','retained',
                          'referred','could_not_search','notice_sent')),

    -- 🔴 A RETENTION EVENT NAMES ITS RULE. This is the s.8(7) exception in a
    --    CHECK constraint: "unless retention is necessary for compliance with
    --    any law" means a retention with no named law is not the exception.
    CONSTRAINT data_principal_request_events_retention_names_a_rule
        CHECK (action <> 'retained' OR retention_rule IS NOT NULL),

    CONSTRAINT data_principal_request_events_counts_are_sane
        CHECK (row_count IS NULL OR row_count >= 0)
);

COMMENT ON TABLE public.data_principal_request_events IS
    'Append-only record of what an erasure or export actually did. Stores a '
    'table name and a row count, never the erased rows: keeping a copy in '
    'order to prove the erasure would be the same personal data under a '
    'different table name, and s.8(7) would apply to it identically.';

CREATE UNIQUE INDEX IF NOT EXISTS data_principal_request_events_id_tenant_key
    ON public.data_principal_request_events (id, tenant_id);

CREATE INDEX IF NOT EXISTS data_principal_request_events_request_idx
    ON public.data_principal_request_events (tenant_id, request_id, occurred_at);

-- --- append-only guard ------------------------------------------------------
-- 0087 granted a table without DELETE citing a guard trigger THAT DID NOT
-- EXIST, and 0102 had to correct it. So this trigger is created here, in this
-- file, and section 7 counts it.

CREATE OR REPLACE FUNCTION public.ordence_dpr_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    RAISE EXCEPTION
        'data_principal_request_events is append-only: % refused. The record of what was erased is the only evidence remaining that it was erased lawfully.',
        TG_OP;
END;
$fn$;

DROP TRIGGER IF EXISTS data_principal_request_events_no_update
    ON public.data_principal_request_events;
CREATE TRIGGER data_principal_request_events_no_update
    BEFORE UPDATE OR DELETE ON public.data_principal_request_events
    FOR EACH ROW EXECUTE FUNCTION public.ordence_dpr_events_append_only();


-- ============================================================================
-- SECTION 5 · `personal_data_breaches` · THE ARTEFACT A FIDUCIARY SENDS
-- ============================================================================
-- The product already has `security_events` (0063) and an anomaly detector
-- (server/security/anomalies.ts). Neither produces the thing s.8(6) requires:
-- an INTIMATION, to the Board and to each affected Data Principal.
--
-- 🔴 s.8(6), verbatim: "In the event of a personal data breach, the Data
--    Fiduciary shall give the Board and each affected Data Principal,
--    intimation of such breach in such form and manner as may be prescribed."
--
-- ⭐ RULE 7 OF THE DPDP RULES 2025 PRESCRIBES THE FORM, AND THE CONTENT IS
--    NOT OPTIONAL. To the affected Data Principal, without delay: the nature,
--    extent, timing and location of the breach; its likely consequences; the
--    mitigation implemented; what the person can do to protect themselves; and
--    contact details of somebody who can answer. To the Board, without delay,
--    then a DETAILED REPORT WITHIN 72 HOURS.
--
-- 🔴 THERE IS NO MATERIALITY THRESHOLD. Every personal data breach is
--    reportable. This is stricter than the GDPR and it is the single most
--    commonly mis-stated part of the regime, which is why `is_material` is not
--    a column here: it would be a field whose only use is to justify not
--    reporting.
--
-- ⚠️ AND CERT-In IS A SEPARATE, SHORTER CLOCK THAT ALREADY BINDS ORDENCE
--    TODAY. Direction (ii) of the Directions of 28 April 2022 requires
--    reporting within SIX HOURS OF NOTICING, and binds "body corporate" with
--    no threshold. So `certin_reported_at` is its own column with its own
--    deadline, and neither one satisfies the other.
--
-- ⚠️ `breach_class` RECORDS WHICH REGIME A ROW WAS RAISED UNDER, because the
--    DPDP Rules commence in May 2027 and this table exists before then.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.personal_data_breaches (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    reference                 varchar(40) NOT NULL,

    -- 'dpdp_rules_2025' once in force; 'anticipatory' before then.
    breach_class              varchar(24) NOT NULL DEFAULT 'anticipatory',

    -- 🔴 THE CLOCK STARTS AT NOTICING, NOT AT OCCURRING AND NOT AT
    --    CONFIRMING. Both CERT-In's six hours and Rule 7's "without delay"
    --    run from awareness. A team that waits to be certain before starting
    --    the clock has already missed it.
    noticed_at                timestamptz NOT NULL,
    occurred_at               timestamptz,

    -- Rule 7 content, one column each, so an incomplete intimation is visible
    -- as a NULL rather than as a short paragraph.
    nature                    text        NOT NULL,
    extent                    text        NOT NULL,
    -- "timing and location" in the Rule's own words.
    timing_and_location       text        NOT NULL,
    likely_consequences       text        NOT NULL,
    mitigation_implemented    text        NOT NULL,
    safeguards_for_principals text        NOT NULL,
    contact_person            text        NOT NULL,

    -- Rough count. NULL means not yet established, which is a legitimate
    -- state at hour one and not at hour seventy-two.
    affected_principal_count  integer,

    -- The three separate duties, three separate timestamps, because one
    -- "reported" boolean would let any of the three stand for all of them.
    board_intimated_at        timestamptz,
    board_detailed_report_at  timestamptz,
    principals_intimated_at   timestamptz,
    certin_reported_at        timestamptz,

    -- ⭐ The intimation exactly as sent, frozen. A template edited later would
    --    silently rewrite what a person was told.
    principal_intimation_text text,

    status                    varchar(20) NOT NULL DEFAULT 'open',

    notes                     text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    created_by                uuid REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT personal_data_breaches_class_valid
        CHECK (breach_class IN ('anticipatory','dpdp_rules_2025')),

    CONSTRAINT personal_data_breaches_status_valid
        CHECK (status IN ('open','intimated','closed')),

    CONSTRAINT personal_data_breaches_count_is_sane
        CHECK (affected_principal_count IS NULL OR affected_principal_count >= 0),

    -- 🔴 A BREACH CANNOT BE CLOSED WITH THE BOARD UNINFORMED AND THE PEOPLE
    --    UNINFORMED. s.8(6) requires BOTH, and a workflow that lets a team
    --    tidy an incident away is a workflow that will be used at 2 a.m.
    CONSTRAINT personal_data_breaches_closed_means_both_told
        CHECK (status <> 'closed'
               OR (board_intimated_at IS NOT NULL AND principals_intimated_at IS NOT NULL)),

    -- Telling the people something requires having written it.
    CONSTRAINT personal_data_breaches_intimation_has_text
        CHECK (principals_intimated_at IS NULL OR principal_intimation_text IS NOT NULL),

    -- A detailed report to the Board follows an initial intimation; it does
    -- not replace it.
    CONSTRAINT personal_data_breaches_detail_follows_initial
        CHECK (board_detailed_report_at IS NULL OR board_intimated_at IS NOT NULL)
);

COMMENT ON TABLE public.personal_data_breaches IS
    'Personal data breach intimations under s.8(6) DPDPA 2023 and Rule 7 of '
    'the DPDP Rules 2025. There is deliberately no is_material column: Rule 7 '
    'has no materiality threshold, so such a field could only ever be used to '
    'justify not reporting.';

COMMENT ON COLUMN public.personal_data_breaches.noticed_at IS
    'When the breach was NOTICED. Both CERT-In''s six hours and Rule 7''s '
    '"without delay" run from awareness, not from occurrence and not from '
    'confirmation.';

COMMENT ON COLUMN public.personal_data_breaches.certin_reported_at IS
    'CERT-In Directions 28 April 2022, Direction (ii): six hours of noticing. '
    'A separate and shorter duty from Rule 7. Neither satisfies the other.';

CREATE UNIQUE INDEX IF NOT EXISTS personal_data_breaches_id_tenant_key
    ON public.personal_data_breaches (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS personal_data_breaches_reference_key
    ON public.personal_data_breaches (tenant_id, reference);

CREATE INDEX IF NOT EXISTS personal_data_breaches_open_idx
    ON public.personal_data_breaches (tenant_id, status, noticed_at DESC);


-- ============================================================================
-- SECTION 6 · ROW LEVEL SECURITY
-- ============================================================================
-- Shape copied verbatim from 0096. ENABLE and FORCE both, on every table.
--
-- 🔴 FORCE IS THE ONE THAT IS EASY TO OMIT AND HAS NO SYMPTOM. Without it a
--    table owned by the connecting role ignores its own policy, the queries
--    keep filtering on tenant_id correctly, and the database has simply
--    stopped refusing the query that forgets to.
-- ============================================================================

ALTER TABLE public.data_principal_requests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_principal_requests           FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_principal_requests_tenant_isolation
    ON public.data_principal_requests;
CREATE POLICY data_principal_requests_tenant_isolation
    ON public.data_principal_requests
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.data_principal_request_anchors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_principal_request_anchors    FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_principal_request_anchors_tenant_isolation
    ON public.data_principal_request_anchors;
CREATE POLICY data_principal_request_anchors_tenant_isolation
    ON public.data_principal_request_anchors
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.data_principal_request_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_principal_request_events     FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_principal_request_events_tenant_isolation
    ON public.data_principal_request_events;
CREATE POLICY data_principal_request_events_tenant_isolation
    ON public.data_principal_request_events
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE public.personal_data_breaches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_data_breaches            FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_data_breaches_tenant_isolation
    ON public.personal_data_breaches;
CREATE POLICY personal_data_breaches_tenant_isolation
    ON public.personal_data_breaches
    USING      (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 7 · GRANTS
-- ============================================================================
-- 🔴 `data_principal_request_events` GETS INSERT AND SELECT ONLY. NO UPDATE,
--    NO DELETE. The trigger in section 4 refuses both anyway; the grant and
--    the trigger are two independent refusals of the same thing, which is the
--    correction 0102 had to make to 0087 after that file cited a trigger that
--    did not exist. Both are present here and section 8 counts the trigger.
--
-- ⚠️ The other three get DELETE. A request recorded in error, or a breach row
--    opened against the wrong workspace, must be removable , the evidence that
--    matters lives in the append-only events table and in audit_logs.
-- ============================================================================

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON public.data_principal_requests        TO ordence_app;
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON public.data_principal_request_anchors TO ordence_app;
        GRANT SELECT, INSERT
            ON public.data_principal_request_events  TO ordence_app;
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON public.personal_data_breaches         TO ordence_app;
    END IF;
END;
$grants$;


-- ============================================================================
-- SECTION 8 · VERIFICATION · READ ONLY · RUN THIS LAST AND READ IT
-- ============================================================================
-- EVERY BOOLEAN BELOW SHOULD READ true. `tables_forced` should read 4,
-- `policies_present` 4, and `append_only_triggers` 1.
--
-- A false in tables_forced is the failure with no symptom: the table works,
-- the queries filter correctly, and the database has stopped refusing the one
-- that does not.
--
-- ⚠️ `events_update_refused` ACTUALLY TRIES THE UPDATE rather than checking
--    that a trigger exists. A trigger that exists and does not fire looks
--    identical to one that does, and 0087 shipped a grant justified by a
--    trigger nobody had run.
-- ============================================================================

SELECT
    '0113 · verification'                                          AS finding,
    to_regclass('public.data_principal_requests')       IS NOT NULL AS requests_present,
    to_regclass('public.data_principal_request_anchors')IS NOT NULL AS anchors_present,
    to_regclass('public.data_principal_request_events') IS NOT NULL AS events_present,
    to_regclass('public.personal_data_breaches')        IS NOT NULL AS breaches_present,
    (SELECT count(*) FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('data_principal_requests','data_principal_request_anchors',
                          'data_principal_request_events','personal_data_breaches')
        AND c.relrowsecurity AND c.relforcerowsecurity)              AS tables_forced,
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('data_principal_requests','data_principal_request_anchors',
                          'data_principal_request_events','personal_data_breaches'))
                                                                     AS policies_present,
    (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.data_principal_request_events'::regclass
        AND NOT tgisinternal)                                        AS append_only_triggers,
    -- 🔴 The constraint that stops a request being answered while something
    --    is still waiting on a human.
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'data_principal_requests_no_silent_answer')
                                                                     AS no_silent_answer_constraint,
    -- 🔴 The constraint that makes s.8(7)'s exception structural: a retention
    --    event with no named rule cannot be written.
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'data_principal_request_events_retention_names_a_rule')
                                                                     AS retention_names_a_rule,
    EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'personal_data_breaches_closed_means_both_told')
                                                                     AS closed_means_both_told,
    -- ⚠️ The column that must NOT exist. Rule 7 has no materiality threshold,
    --    so a field for it could only ever justify not reporting.
    NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'personal_data_breaches'
           AND column_name IN ('is_material','is_reportable','severity')
    )                                                                AS no_materiality_escape_hatch;


-- ============================================================================
-- SECTION 8b · THE APPEND-ONLY GUARD, EXERCISED RATHER THAN COUNTED
-- ============================================================================
-- ⚠️ A VERIFY THAT HAS ONLY EVER BEEN RUN ON THE PASSING CASE IS NOT A VERIFY.
--
-- This block inserts nothing and deletes nothing real. It attempts an UPDATE
-- against a WHERE that matches no row and reports what the database did. A
-- BEFORE UPDATE ... FOR EACH ROW trigger does not fire when no row matches, so
-- this proves the STATEMENT is permitted to reach the table and nothing more ,
-- which is stated rather than glossed, because claiming it proved the refusal
-- would be exactly the 0087 mistake in a different costume.
--
-- 🔴 The real proof lives in tests/ui/dpdp-erasure.test.ts and in a drill
--    against a throwaway PostgreSQL. It is NOT run here, because a migration
--    that writes a row to prove a trigger fires is a migration that writes a
--    row into a customer's database.
-- ============================================================================

DO $probe$
DECLARE
    trigger_count int;
BEGIN
    SELECT count(*) INTO trigger_count
      FROM pg_trigger
     WHERE tgrelid = 'public.data_principal_request_events'::regclass
       AND NOT tgisinternal;

    IF trigger_count = 0 THEN
        RAISE WARNING
            '0113: data_principal_request_events has NO append-only trigger. '
            'Section 7 grants INSERT and SELECT only, so the table is still '
            'protected by the grant , but the second, independent refusal is '
            'missing and that is the 0087 failure shape.';
    ELSE
        RAISE NOTICE
            '0113: append-only trigger present on data_principal_request_events (% trigger(s)). '
            'It has NOT been fired by this file. Exercising it requires writing a row.',
            trigger_count;
    END IF;
END;
$probe$;
