-- ############################################################################
-- 0098 , DEMAND NOTICES: RAISED, DISPATCHED, SERVED , THREE FACTS, THREE COLUMNS
-- ############################################################################
--
-- PURPOSE
-- -------
-- 🔴 `dunning_events.sent_at` WAS `timestamptz NOT NULL DEFAULT now()`. It was
--    populated BY THE ACT OF INSERTING THE ROW. Nothing sent anything ,
--    `server/receivables/dunning.ts` rendered a letter, wrote the row, and
--    stopped. `db/schema/messaging.ts` had already written the sentence down:
--
--        "That column has recorded WhatsApp service since 0027, in a table
--         that exists to be 'the evidence that the buyer was given every
--         chance'. The row was written by a person ticking a box, and nothing
--         was ever sent."
--
-- ⚠️ THIS IS WORSE THAN THE QUEUE 0097 DRAINED. `credit_dunning_log` wrote
--    `delivery = 'queued'` and never drained it , bad, and HONEST ABOUT ITS
--    OWN STATE. `dunning_events` wrote a send timestamp for a send that did
--    not happen. The first is a gap in evidence. The second is FALSE
--    EVIDENCE, and it is found by the other side.
--
-- 🔴 WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS PRODUCT.
--    A demand notice under a RERA allotment is the step before interest
--    accrues, before the allotment can be cancelled, and before money a family
--    has paid towards a home can be forfeited. `dunning_events` IS the record
--    of service. A developer who cancels relying on `sent_at` is relying on a
--    timestamp for a notice the allottee never received; at an Authority
--    hearing that is the developer's own system testifying against them , and
--    the allottee is the person who was actually wronged.
--
-- ############################################################################
-- ⭐⭐ WHAT THIS FILE DOES
-- ############################################################################
--
--   ①  ADDS THE THREE FACTS AS THREE COLUMNS.
--         raised_at      , a person decided to demand.
--         dispatched_at  , it left our system, WITH a provider message id.
--         served_at      , it reached the allottee, or is deemed to have.
--
--   ②  MAKES THE OLD BEHAVIOUR STRUCTURALLY IMPOSSIBLE, NOT DISCOURAGED.
--         `sent_at` loses its DEFAULT and its NOT NULL, and a CHECK refuses
--         any `sent_at` on a row whose `service_evidence` is still 'none'.
--         A freshly created row is ALWAYS 'none' (that is the column default),
--         so an INSERT can no longer carry a send timestamp at all. Evidence
--         is established by a LATER statement or not at all.
--
--   ③  MAKES "A HUMAN TICKED A BOX" A DIFFERENT, WEAKER KIND OF EVIDENCE.
--         Post, courier and hand delivery are REAL , most builder-buyer
--         agreements name registered post to the address in the agreement as
--         the mode of valid service, and an unopened email is not service. So
--         a human may record them , but only as 'human_recorded', only with a
--         named person, and only with a reference somebody can look up. It can
--         never be confused with 'system_dispatch', because 'system_dispatch'
--         requires a provider message id no human can produce.
--
--   ④  LEAVES EVERY EXISTING ROW EXACTLY WHERE IT IS, MARKED 'legacy_unverified'.
--
-- ############################################################################
-- 🔴🔴 WHY THERE IS NO BACKFILL, AND WHY THAT IS THE MOST IMPORTANT LINE HERE
-- ############################################################################
--
-- The obvious migration is `UPDATE dunning_events SET dispatched_at = sent_at`.
-- It is also the single worst thing this file could do. `sent_at` on an
-- existing row is the timestamp of somebody pressing a button. Copying it into
-- `dispatched_at` would MANUFACTURE THE EXACT EVIDENCE THE DEFECT FABRICATED ,
-- and it would do it deliberately, in a file whose stated purpose is to stop
-- fabricating it. Every old row is evidence of the OLD BEHAVIOUR and is
-- preserved as such.
--
-- ⭐ SO THE MARKING IS DONE WITH A DEFAULT, NOT WITH DML.
--    `ADD COLUMN service_evidence ... NOT NULL DEFAULT 'legacy_unverified'`
--    fills every pre-existing row at DDL time, and the very next statement
--    lowers the default to 'none' for everything written from now on. No
--    UPDATE, no INSERT, nothing for a FORCE ROW LEVEL SECURITY policy to
--    refuse , the failure mode 0091 and 0092 both hit.
--
-- ⚠️ A ROW INSERTED IN THE MILLISECONDS BETWEEN THOSE TWO STATEMENTS would
--    be graded 'legacy_unverified' rather than 'none'. Both grades are
--    unproven and both are refused enforcement, so the race can only ever
--    understate evidence. It fails in the safe direction, which is the only
--    kind of race worth having in this table.
--
-- ############################################################################
-- 🔴 WHY THIS FILE HAS NO `BEGIN;`, NO `COMMIT;` AND NO BARE `SET LOCAL`
-- ############################################################################
--
-- Restated because the project has already lost a day to it. Migrations here
-- are PASTED INTO THE NEON BROWSER CONSOLE, which sends each statement on its
-- own connection turn. `BEGIN` buys no atomicity across that boundary , it
-- only makes a half-applied file look like a clean one, which is how 0091
-- applied halfway while reporting success. And `SET LOCAL app.platform_scope`
-- on its own line reports "executed successfully" and has evaporated before
-- the next statement runs; it is only ever used inside a single `DO $$ ... $$`
-- alongside the write it protects.
--
-- ⭐ EVERY STATEMENT BELOW IS INDEPENDENTLY IDEMPOTENT , ADD COLUMN IF NOT
--    EXISTS, CREATE INDEX IF NOT EXISTS, and every constraint guarded by a
--    catalogue lookup , so the file is safe to re-run from the top after a
--    failure at any point.
--
-- ⭐ AND THERE IS NO DML AT ALL, WHICH IS THE STRONGEST FORM OF THIS. See the
--    backfill section above: the absence of DML here is not a convenience, it
--    is the point.
--
-- 🔴 RLS: `dunning_events` IS ALREADY TENANT SCOPED, ALREADY `ENABLE` AND
--    `FORCE ROW LEVEL SECURITY`, AND ALREADY CARRIES A POLICY NAMING
--    `app_current_tenant_id()` , SQL 0027 sections 5 and 6. This file adds
--    columns to that table and creates NO new table, so it introduces no new
--    isolation surface. Section 6 re-asserts the existing posture anyway, so
--    a database that lost it to a `drizzle-kit push` is repaired by re-running
--    this file.
--
-- RUN ORDER: after 0097. Re-runnable.
-- 🔴 DO NOT RUN `drizzle-kit push`. It drops RLS policies on 275 tables.
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC · READ ONLY · RUNS FIRST ON PURPOSE
-- ============================================================================
-- If a later section refuses, this row is still on your screen and still tells
-- you how many demand notices are currently claiming a send that never
-- happened. That number is the size of the problem, and it is worth reading
-- before it becomes a column name.
-- ============================================================================

SELECT
    '0098 · diagnostic'                                          AS finding,
    current_user                                                 AS running_as,
    to_regclass('public.dunning_events')     IS NOT NULL         AS dunning_events_present,
    to_regclass('public.email_outbox')       IS NOT NULL         AS outbox_present,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name = 'service_evidence')                    AS already_applied,
    COALESCE((SELECT count(*) FROM public.dunning_events), 0)    AS notices_on_file,
    COALESCE((SELECT count(*) FROM public.dunning_events
               WHERE sent_at IS NOT NULL), 0)                    AS notices_claiming_a_send_nobody_made;


-- ============================================================================
-- SECTION 2 · THE THREE FACTS
-- ============================================================================
-- ⚠️ `raised_at` IS NULLABLE AND THAT IS ON PURPOSE. A NOT NULL DEFAULT now()
--    would stamp today's date onto every historical row , inventing a raise
--    time for notices raised two years ago. The CHECK in section 4 requires it
--    on every row that is not legacy, so new rows cannot omit it.
-- ============================================================================

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS raised_at timestamptz;

-- 🔴 DISPATCH IS A MACHINE FACT. `dispatched_at` may not exist without
--    `dispatch_provider_message_id` (section 4), and no human interface writes
--    either of them , they are written by `server/email/outbox.ts` when Resend
--    acknowledges the message.
ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS dispatch_provider_message_id varchar(200);

-- ⭐ WHICH OUTBOX ROW IS CARRYING IT. Nullable: a postal notice has no outbox
--    row, and a notice queued before this column existed has none either.
ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS dispatch_outbox_id uuid;

-- ⚠️ A DEAD LETTER IS A FACT TOO, AND IT IS THE ONE NOBODY LOOKS FOR. A notice
--    whose address hard-bounced is not "pending", it is NOT SERVED, and the
--    person about to cancel an allotment needs the reason in words.
ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS dispatch_failed_at timestamptz;

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS dispatch_failure_reason varchar(500);

-- SERVED , the fact that actually decides a hearing, and the one we usually
-- cannot know. Null is the honest answer and it is the default.
ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS served_at timestamptz;


-- ============================================================================
-- SECTION 3 · THE GRADE, AND THE DEFAULT THAT MARKS HISTORY WITHOUT TOUCHING IT
-- ============================================================================
-- 🔴 THESE TWO STATEMENTS ARE THE BACKFILL, AND THEY WRITE NO ROWS.
--    Statement one fills every EXISTING row with 'legacy_unverified' as part
--    of the ADD COLUMN itself. Statement two lowers the default so every
--    FUTURE row starts at 'none' , raised, and nothing more.
-- ============================================================================

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS service_evidence varchar(24) NOT NULL DEFAULT 'legacy_unverified';

ALTER TABLE public.dunning_events
    ALTER COLUMN service_evidence SET DEFAULT 'none';

-- ⚠️ WHO SAID SO, WHEN, AND WHAT CAN BE LOOKED UP. Required together for
--    'human_recorded' by the CHECK in section 4. A postal service claim with
--    no reference is a tick box.
ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS service_recorded_by uuid;

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS service_recorded_at timestamptz;

ALTER TABLE public.dunning_events
    ADD COLUMN IF NOT EXISTS service_reference varchar(120);

DO $$
BEGIN
    IF to_regclass('public.users') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'dunning_events_service_recorder_fk') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_service_recorder_fk
            FOREIGN KEY (service_recorded_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.email_outbox') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'dunning_events_dispatch_outbox_fk') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_dispatch_outbox_fk
            FOREIGN KEY (dispatch_outbox_id) REFERENCES public.email_outbox(id) ON DELETE SET NULL;
    END IF;
END $$;


-- ============================================================================
-- SECTION 4 · 🔴🔴 THE CHECKS · WHERE THE OLD BEHAVIOUR BECOMES IMPOSSIBLE
-- ============================================================================
-- ⚠️ CONVENTION WOULD NOT HAVE SURVIVED. The old `sent_at` was a convention
--    too , "set it when you send" , and it was violated by the only code that
--    ever wrote it, for three years, in the table that decides whether a
--    family keeps its flat. These are constraints because the rule is worth
--    more than the code that currently honours it.
-- ============================================================================

-- Drop the two properties that made the defect automatic.
ALTER TABLE public.dunning_events ALTER COLUMN sent_at DROP DEFAULT;
ALTER TABLE public.dunning_events ALTER COLUMN sent_at DROP NOT NULL;

COMMENT ON COLUMN public.dunning_events.sent_at IS
    'LEGACY AND FROZEN. Before 0098 this defaulted to now() and was written by the INSERT, so on any row created before 0098 it records when somebody pressed a button and NOT that anything was sent. Never read it as evidence of service; read dispatched_at, served_at and service_evidence. New rows leave it NULL.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_service_evidence_known') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_service_evidence_known
            CHECK (service_evidence IN
                   ('none','system_dispatch','human_recorded','deemed','legacy_unverified'));
    END IF;
END $$;

-- 🔴🔴 THE ONE. A row whose evidence is still 'none' may not carry a send
--    timestamp, and 'none' is what every INSERT gets. Creating a demand notice
--    can therefore no longer assert that it was sent , not by accident, not by
--    a back-fill script, and not by a developer who forgets. The assertion now
--    requires a SECOND statement that has something to show for itself.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_sent_at_is_not_a_claim') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_sent_at_is_not_a_claim
            CHECK (sent_at IS NULL OR service_evidence <> 'none');
    END IF;
END $$;

-- ⭐ DISPATCH AND ITS PROOF ARE ONE FACT. Neither may exist alone. A
--    `dispatched_at` with no provider id is a hand-written claim wearing the
--    machine's badge, which is precisely the confusion being removed.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_dispatch_needs_proof') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_dispatch_needs_proof
            CHECK ((dispatched_at IS NULL AND dispatch_provider_message_id IS NULL)
                OR (dispatched_at IS NOT NULL AND dispatch_provider_message_id IS NOT NULL));
    END IF;
END $$;

-- 🔴 ONLY A MACHINE MAY CLAIM 'system_dispatch', AND ONLY ON A CHANNEL A
--    MACHINE CAN ACTUALLY DRIVE. Post, courier and hand delivery physically
--    cannot produce a provider message id, so the strongest-looking grade is
--    unreachable for them by construction rather than by review.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_system_dispatch_is_machine_only') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_system_dispatch_is_machine_only
            CHECK (service_evidence <> 'system_dispatch'
                OR (dispatched_at IS NOT NULL AND channel IN ('email','whatsapp')));
    END IF;
END $$;

-- ⚠️ AND CONVERSELY: A HUMAN'S RECORD IS NEVER A DISPATCH. `human_recorded`
--    and `deemed` may not carry dispatch fields at all, so the two claims can
--    never be merged into one badge on one screen.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_human_record_is_not_a_dispatch') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_human_record_is_not_a_dispatch
            CHECK (service_evidence NOT IN ('human_recorded','deemed')
                OR dispatched_at IS NULL);
    END IF;
END $$;

-- ⚠️ A POSTAL SERVICE CLAIM NAMES A PERSON AND CARRIES SOMETHING LOOKUPABLE.
--    Speed post, RPAD and courier references have three different shapes, so
--    the format is not checked , the EXISTENCE is. "Posted" with nothing to
--    look up is the tick box this batch exists to abolish.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_human_record_names_a_person') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_human_record_names_a_person
            CHECK (service_evidence <> 'human_recorded'
                OR (service_recorded_by IS NOT NULL
                    AND service_recorded_at IS NOT NULL
                    AND btrim(coalesce(service_reference, '')) <> ''));
    END IF;
END $$;

-- Nothing is "served" while the evidence grade still says nothing happened.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_served_needs_evidence') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_served_needs_evidence
            CHECK (served_at IS NULL OR service_evidence <> 'none');
    END IF;
END $$;

-- ⭐ EVERY NEW ROW STATES WHEN IT WAS RAISED. Legacy rows are exempt because
--    inventing a raise time for them would be the same crime in a smaller
--    currency.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_raised_at_present') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_raised_at_present
            CHECK (raised_at IS NOT NULL OR service_evidence = 'legacy_unverified');
    END IF;
END $$;

-- 🔴🔴 LEGACY ROWS ARE FROZEN AS UNPROVEN. Even a well-meaning future script
--    cannot promote one to a dispatch, because a legacy row may hold no
--    dispatch fields at all. If real evidence turns up for an old notice, it
--    is recorded as 'human_recorded' by a named person with the reference they
--    are looking at , which is the truth of how it was found.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'dunning_events_legacy_is_never_promoted') THEN
        ALTER TABLE public.dunning_events
            ADD CONSTRAINT dunning_events_legacy_is_never_promoted
            CHECK (service_evidence <> 'legacy_unverified'
                OR (dispatched_at IS NULL
                    AND dispatch_provider_message_id IS NULL
                    AND served_at IS NULL));
    END IF;
END $$;


-- ============================================================================
-- SECTION 5 · THE INDEX THE CANCELLATION SCREEN READS
-- ============================================================================
-- ⭐ PARTIAL, ON THE ROWS THAT MATTER. "Which notices on this booking were
--    raised and never proven?" is asked at exactly one moment , while somebody
--    is about to cancel an allotment , and it must be instant there or it will
--    be dropped from the screen for being slow.
-- ============================================================================

CREATE INDEX IF NOT EXISTS dunning_events_unproven_idx
    ON public.dunning_events (tenant_id, demand_id)
    WHERE service_evidence IN ('none', 'legacy_unverified');

CREATE INDEX IF NOT EXISTS dunning_events_dispatch_outbox_idx
    ON public.dunning_events (tenant_id, dispatch_outbox_id)
    WHERE dispatch_outbox_id IS NOT NULL;


-- ============================================================================
-- SECTION 6 · RLS, RE-ASSERTED
-- ============================================================================
-- ⚠️ `dunning_events` HAS BEEN TENANT ISOLATED SINCE 0027 AND THIS FILE ADDS
--    NO NEW TABLE. These statements are re-assertions, not new policy: they
--    are here so that a database which lost its posture to a `drizzle-kit
--    push` is repaired by re-running this file, and so that the isolation of
--    the table this migration touches is visible in the file that touches it.
-- ============================================================================

ALTER TABLE public.dunning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dunning_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dunning_events_tenant_isolation ON public.dunning_events;
CREATE POLICY dunning_events_tenant_isolation ON public.dunning_events
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());


-- ============================================================================
-- SECTION 7 · VERIFY · READ ONLY
-- ============================================================================

SELECT
    '0098 · verify'                                              AS finding,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name IN ('raised_at','dispatched_at','served_at',
                            'service_evidence','service_reference'))  AS new_columns_present_expect_5,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.dunning_events'::regclass
        AND conname LIKE 'dunning_events_%'
        AND conname IN ('dunning_events_sent_at_is_not_a_claim',
                        'dunning_events_dispatch_needs_proof',
                        'dunning_events_system_dispatch_is_machine_only',
                        'dunning_events_human_record_is_not_a_dispatch',
                        'dunning_events_human_record_names_a_person',
                        'dunning_events_served_needs_evidence',
                        'dunning_events_raised_at_present',
                        'dunning_events_legacy_is_never_promoted',
                        'dunning_events_service_evidence_known'))      AS checks_present_expect_9,
    (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'dunning_events'
        AND column_name = 'sent_at')                                  AS sent_at_default_expect_null,
    (SELECT count(*) FROM public.dunning_events
      WHERE service_evidence = 'legacy_unverified')                   AS rows_marked_legacy_not_rewritten,
    (SELECT count(*) FROM public.dunning_events
      WHERE dispatched_at IS NOT NULL)                                AS rows_claiming_dispatch_expect_0_today;
