-- ══════════════════════════════════════════════════════════════════════
-- ORDENCE — 0043 · THE TABLES FOR ENGINE 1 AND ENGINE 4
-- v0.75.0-alpha
--
-- ⭐ RUN THIS BEFORE 0032 (compliance) AND 0033 (scheduling).
-- ══════════════════════════════════════════════════════════════════════
-- WHY THIS FILE EXISTS AT ALL — AND WHY IT IS AN ADMISSION
--
-- `0039_tables_paste_only.sql` was written to replace `drizzle-kit push`
-- for the paste-only deployment. It creates 33 tables covering Engines 2,
-- 3, 5 and 6, plus BOQ and site labour.
--
-- ⚠️ IT DOES NOT CREATE THE ENGINE 1 OR ENGINE 4 TABLES. Nothing did.
--
-- The consequence was silent and total: `0032_engine4_compliance.sql` and
-- `0033_engine1_scheduling.sql` both open with a guard that raises if
-- their tables are absent. So both files refused to run, every time, and
-- would have gone on refusing forever — the guard did its job perfectly
-- and reported a missing prerequisite that no file supplied.
--
-- Two engines have therefore been "written but never installed" since
-- they were built. Only the migration-state diagnostic caught it, and
-- only because it probes for a real object rather than trusting a list.
--
-- ══════════════════════════════════════════════════════════════════════
-- WHAT IT CREATES: 8 enum types and 7 tables
--   Engine 4 — compliance_obligations, compliance_tasks,
--              compliance_evidence, compliance_licences
--   Engine 1 — schedule_resources, schedule_bookings, schedule_blocks
--
-- ⚠️ SAFE TO RUN ON A DATABASE THAT ALREADY HAS SOME OF THIS. Every
-- statement is guarded. An object that exists is skipped, never altered
-- and never recreated. Running it twice changes nothing the second time.
--
-- ⚠️ IT CREATES ONLY. Nothing here drops a table, drops a column, or
-- deletes a row. There is no path through this file that loses data.
--
-- ⚠️ FOREIGN KEYS COME LAST, AFTER THE INDEXES — the same load-bearing
-- ordering as 0039. Several keys point at an `(id, tenant_id)` pair whose
-- uniqueness comes from a unique INDEX, not a table constraint. Emitted
-- in the obvious order, Postgres refuses with "there is no unique
-- constraint matching given keys", which reads like a missing column and
-- is really an index that had not been created yet.
--
-- ⚠️ ROW-LEVEL SECURITY IS NOT SET HERE. It is set by 0032 and 0033,
-- which is where the policies live. This file creates the tables; run
-- 0032 and 0033 immediately afterwards and do not stop in between.
-- ══════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 0 · PREREQUISITES
-- ══════════════════════════════════════════════════════════════════════
-- These four must already exist. If any is missing, a much earlier file
-- did not run and everything below would fail with a confusing error
-- about a foreign key instead of a clear one about a missing table.

DO $ordence$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ')
    INTO missing
    FROM unnest(ARRAY['tenants', 'users', 'companies', 'contacts']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Ordence 0043 cannot run: missing prerequisite table(s): %. Run the earlier numbered SQL files first.',
      missing;
  END IF;
END
$ordence$;


-- ══════════════════════════════════════════════════════════════════════
-- 1 · ENUM TYPES
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ POSTGRES HAS NO `CREATE TYPE IF NOT EXISTS`. Each one is therefore
-- wrapped so that a re-run is a no-op rather than an error that aborts
-- the whole transaction and leaves the operator staring at a rollback.

DO $ordence$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'compliance_authority') THEN
    CREATE TYPE public.compliance_authority AS ENUM (
      'gst', 'income_tax', 'tds', 'mca_roc', 'epfo', 'esic', 'labour',
      'professional_tax', 'customs', 'rbi', 'sebi', 'fssai',
      'pollution_control', 'fire', 'municipal', 'transport_rto',
      'electricity_cea', 'health_nmc', 'drugs_licensing', 'aerb',
      'state_excise', 'legal_metrology', 'internal', 'other'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'compliance_frequency') THEN
    CREATE TYPE public.compliance_frequency AS ENUM (
      'monthly', 'quarterly', 'half_yearly', 'annual', 'one_time', 'event_based'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'compliance_task_status') THEN
    CREATE TYPE public.compliance_task_status AS ENUM (
      'pending', 'in_progress', 'awaiting_client', 'ready_to_file',
      'filed', 'late_filed', 'missed', 'not_applicable', 'waived'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'compliance_severity') THEN
    CREATE TYPE public.compliance_severity AS ENUM (
      'informational', 'low', 'medium', 'high', 'critical'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'licence_status') THEN
    CREATE TYPE public.licence_status AS ENUM (
      'active', 'renewal_due', 'under_renewal', 'expired',
      'suspended', 'cancelled', 'not_required'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'resource_kind') THEN
    CREATE TYPE public.resource_kind AS ENUM (
      'room', 'bed', 'table', 'hall', 'practitioner', 'vehicle',
      'equipment', 'staff', 'slot', 'other'
    );
  END IF;

  -- ⚠️ NAMED `schedule_booking_status`, NOT `booking_status`.
  -- `booking_status` already exists for a real-estate property booking,
  -- which is a completely different lifecycle. Two "booking" concepts in
  -- one ERP is normal; the qualified name is what keeps them apart.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_booking_status') THEN
    CREATE TYPE public.schedule_booking_status AS ENUM (
      'held', 'confirmed', 'checked_in', 'in_progress',
      'completed', 'no_show', 'cancelled', 'waitlisted'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'schedule_block_kind') THEN
    CREATE TYPE public.schedule_block_kind AS ENUM (
      'maintenance', 'cleaning', 'closed', 'holiday',
      'reserved_internal', 'breakdown', 'other'
    );
  END IF;
END
$ordence$;


-- ══════════════════════════════════════════════════════════════════════
-- 2 · ENGINE 4 — THE COMPLIANCE REGISTER
-- ══════════════════════════════════════════════════════════════════════

-- ── 2.1 · OBLIGATIONS — the rule, not the task ──────────────────────
--
-- ⭐ `subject_company_id` NULL means "the tenant's own obligation"; set
-- means a client's. That one nullable column is what lets a CA firm and
-- its client share one engine. A separate client table would have
-- duplicated the ladder, the evidence store and the late-fee arithmetic,
-- and the copies would have diverged within a quarter.

CREATE TABLE IF NOT EXISTS public.compliance_obligations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,

    code                    varchar(100) NOT NULL,
    name                    varchar(300) NOT NULL,
    description             text,

    authority               public.compliance_authority NOT NULL,
    frequency               public.compliance_frequency NOT NULL,
    severity                public.compliance_severity NOT NULL DEFAULT 'medium',

    subject_company_id      uuid,

    -- ⚠️ Zero is a legitimate offset — advance tax falls due WITHIN the
    -- period it relates to — so this must never be treated as "unset".
    due_month_offset        integer NOT NULL DEFAULT 1,
    -- 31 is clamped to the month's real last day by trigger, so "last day
    -- of the month" needs no separate flag and February needs no case.
    due_day_of_month        integer NOT NULL DEFAULT 20,

    -- ⭐ The cost of lateness, STATED IN ADVANCE. A board showing what is
    -- due is mildly useful; one showing what being late will COST is what
    -- makes somebody act today instead of tomorrow.
    late_fee_per_day_minor  bigint NOT NULL DEFAULT 0,
    late_fee_cap_minor      bigint,
    interest_rate_bps       integer NOT NULL DEFAULT 0,
    penalty_note            text,

    legal_reference         varchar(300),

    -- ⚠️ Applicability is EXPLICIT, never inferred from turnover or from
    -- the presence of a registration. A tenant switched off by a rule
    -- nobody remembers writing has no idea it stopped filing.
    is_active               boolean NOT NULL DEFAULT true,
    applicability_note      text,

    effective_from          date,
    effective_to            date,

    owner_user_id           uuid,
    reminder_lead_days      integer NOT NULL DEFAULT 7,

    metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    deleted_at              timestamptz,

    CONSTRAINT compliance_obligations_due_day_valid
        CHECK (due_day_of_month BETWEEN 1 AND 31),
    CONSTRAINT compliance_obligations_due_offset_valid
        CHECK (due_month_offset BETWEEN 0 AND 24),
    CONSTRAINT compliance_obligations_late_fee_non_negative
        CHECK (late_fee_per_day_minor >= 0)
);


-- ── 2.2 · TASKS — one period's instance of one obligation ────────────
--
-- ⭐ `period_start`/`period_end` say WHAT the filing covers. `due_date`
-- is DERIVED from `period_end` by trigger in 0032. A typed due date is a
-- due date that will eventually be typed wrong.

CREATE TABLE IF NOT EXISTS public.compliance_tasks (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,

    obligation_id           uuid NOT NULL,

    -- Denormalised so that changing an obligation's subject later does
    -- not silently rewrite the history of who owed what.
    subject_company_id      uuid,

    period_start            date NOT NULL,
    period_end              date NOT NULL,
    period_label            varchar(60) NOT NULL,

    -- ⚠️ Written by trigger. Never accept this from a form.
    due_date                date NOT NULL,

    status                  public.compliance_task_status NOT NULL DEFAULT 'pending',
    severity                public.compliance_severity NOT NULL DEFAULT 'medium',

    owner_user_id           uuid,

    completed_at            timestamptz,
    completed_by_user_id    uuid,

    -- ⚠️ A filing with no reference is a filing you cannot prove. 0032's
    -- trigger refuses `filed` and `late_filed` without one, because "I
    -- definitely filed it" is not a defence anybody has ever won with.
    filing_reference        varchar(200),

    -- ⭐ Stored, not computed on read: the obligation's late fee may
    -- change next year and last year's penalty must not change with it.
    days_late               integer NOT NULL DEFAULT 0,
    late_fee_minor          bigint NOT NULL DEFAULT 0,

    -- Mandatory when status is `not_applicable` or `waived`.
    exemption_reason        text,
    notes                   text,

    last_reminded_at        timestamptz,
    reminder_count          integer NOT NULL DEFAULT 0,

    metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT compliance_tasks_period_ordered
        CHECK (period_end >= period_start),
    CONSTRAINT compliance_tasks_days_late_non_negative
        CHECK (days_late >= 0)
);


-- ── 2.3 · EVIDENCE — the proof ───────────────────────────────────────
--
-- ⚠️ APPEND-ONLY BY POLICY. Superseding a document adds a row; it never
-- replaces one. A store where the last version is the only version
-- cannot show that the earlier filing existed — which is precisely what
-- a revised return has to demonstrate.

CREATE TABLE IF NOT EXISTS public.compliance_evidence (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   uuid NOT NULL,

    task_id                     uuid NOT NULL,

    kind                        varchar(60) NOT NULL,
    title                       varchar(300) NOT NULL,

    -- Points at `documents`. Bytes live in R2, never in Postgres.
    document_id                 uuid,

    -- ⭐ SHA-256 of the bytes at upload. Without it, "here is the
    -- acknowledgement we filed" is a PDF somebody could have edited last
    -- week. With it, the file either hashes to the recorded value or it
    -- has changed — and which of those is true is not a matter of opinion.
    content_sha256              varchar(64),

    filing_reference            varchar(200),
    filed_on                    date,

    superseded_by_evidence_id   uuid,
    superseded_at               timestamptz,

    uploaded_by_user_id         uuid,
    notes                       text,

    created_at                  timestamptz NOT NULL DEFAULT now()
);


-- ── 2.4 · LICENCES — permissions that expire ─────────────────────────
--
-- ⭐ A LICENCE IS NOT A RECURRING FILING, AND MODELLING IT AS ONE FAILS.
-- A GST return recurs forever on a fixed calendar; an FSSAI licence has
-- ONE expiry date. Forcing it into the obligation table would mean
-- inventing a fake period. And the consequence of confusing them is
-- asymmetric: a late return costs a fee, an expired fire NOC or drug
-- licence stops the business operating that day.

CREATE TABLE IF NOT EXISTS public.compliance_licences (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,

    subject_company_id      uuid,

    name                    varchar(300) NOT NULL,
    authority               public.compliance_authority NOT NULL,
    licence_number          varchar(200),
    applies_to              varchar(300),

    issued_on               date,
    valid_from              date,
    valid_until             date,

    -- ⚠️ NOT a reminder. Some renewals legally cannot be applied for
    -- until a window opens; others take ninety days to process. This is
    -- the date from which being idle is ALREADY a problem.
    renewal_lead_days       integer NOT NULL DEFAULT 60,

    status                  public.licence_status NOT NULL DEFAULT 'active',
    severity                public.compliance_severity NOT NULL DEFAULT 'high',

    owner_user_id           uuid,
    document_id             uuid,

    renewal_fee_minor       bigint NOT NULL DEFAULT 0,
    notes                   text,

    metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    deleted_at              timestamptz,

    CONSTRAINT compliance_licences_validity_ordered
        CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);


-- ══════════════════════════════════════════════════════════════════════
-- 3 · ENGINE 1 — SCHEDULING
-- ══════════════════════════════════════════════════════════════════════

-- ── 3.1 · RESOURCES — the thing being booked ─────────────────────────

CREATE TABLE IF NOT EXISTS public.schedule_resources (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,

    code                    varchar(60) NOT NULL,
    name                    varchar(200) NOT NULL,
    kind                    public.resource_kind NOT NULL DEFAULT 'slot',

    group_name              varchar(120),

    -- ⭐ 1 → exclusive (a room, a truck, a surgeon): two overlapping
    -- bookings are refused outright. >1 → shared (a ward with 20 beds):
    -- overlap is legitimate and the COUNT is what gets checked.
    capacity                integer NOT NULL DEFAULT 1,

    -- ⚠️ ZERO BY DEFAULT, AND THAT DEFAULT IS THE SAFE ONE. A hotel
    -- turning this up to 3 is making a commercial decision it can defend.
    -- Every other vertical leaves it at zero and gets hard exclusivity —
    -- which is what a hospital bed and an operating theatre require.
    overbook_limit          integer NOT NULL DEFAULT 0,

    -- Enforced by EXTENDING the reserved range, not by a separate rule.
    -- A buffer that is merely displayed is a buffer the busy day ignores.
    buffer_minutes          integer NOT NULL DEFAULT 0,

    slot_minutes            integer NOT NULL DEFAULT 60,

    is_active               boolean NOT NULL DEFAULT true,
    is_bookable_online      boolean NOT NULL DEFAULT false,

    base_rate_minor         bigint NOT NULL DEFAULT 0,

    opening_hours           jsonb NOT NULL DEFAULT '{}'::jsonb,
    attributes              jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    deleted_at              timestamptz,

    CONSTRAINT schedule_resources_capacity_positive
        CHECK (capacity >= 1),
    CONSTRAINT schedule_resources_overbook_non_negative
        CHECK (overbook_limit >= 0),
    CONSTRAINT schedule_resources_buffer_non_negative
        CHECK (buffer_minutes >= 0)
);


-- ── 3.2 · BOOKINGS — the commitment ──────────────────────────────────
--
-- ⚠️ HALF-OPEN RANGES: [starts_at, ends_at). A booking ending at 11:00
-- and one starting at 11:00 do NOT overlap. This is not a detail — with
-- closed ranges, back-to-back appointments collide and every schedule
-- develops a one-minute gap that somebody eventually "fixes" by
-- disabling the check.

CREATE TABLE IF NOT EXISTS public.schedule_bookings (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,

    resource_id             uuid NOT NULL,
    reference               varchar(60) NOT NULL,

    starts_at               timestamptz NOT NULL,
    ends_at                 timestamptz NOT NULL,

    status                  public.schedule_booking_status NOT NULL DEFAULT 'held',

    -- ⚠️ A hold with no expiry is inventory lost forever to somebody who
    -- closed the tab. The sweeper releases these; this column is what
    -- makes that possible without guessing.
    hold_expires_at         timestamptz,

    quantity                integer NOT NULL DEFAULT 1,

    contact_id              uuid,
    party_name              varchar(200),
    party_phone             varchar(40),

    channel                 varchar(60) NOT NULL DEFAULT 'direct',

    quoted_rate_minor       bigint NOT NULL DEFAULT 0,

    -- ⭐ Recorded rather than merely permitted. An overbooking nobody can
    -- find afterwards is how a hotel discovers at 9pm that it has walked
    -- three guests. The flag makes the exposure a query.
    is_overbooking          boolean NOT NULL DEFAULT false,

    checked_in_at           timestamptz,
    completed_at            timestamptz,
    cancelled_at            timestamptz,
    cancellation_reason     text,

    notes                   text,
    created_by_user_id      uuid,

    metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    -- ⚠️ STRICTLY GREATER. A zero-length booking passes every overlap
    -- check ever written, because it overlaps nothing — so it silently
    -- consumes no capacity while appearing on the board as a real
    -- commitment.
    CONSTRAINT schedule_bookings_range_ordered
        CHECK (ends_at > starts_at),
    CONSTRAINT schedule_bookings_quantity_positive
        CHECK (quantity >= 1)
);


-- ── 3.3 · BLOCKS — time that is not for sale ─────────────────────────
--
-- ⚠️ A SEPARATE TABLE, NOT A BOOKING WITH A FAKE CUSTOMER. Modelling
-- maintenance as a booking is the obvious shortcut and it poisons every
-- number downstream: occupancy counts it as sold, revenue shows a
-- zero-value stay, and the cancellation rate includes the day the boiler
-- broke. Blocked time is not demand.

CREATE TABLE IF NOT EXISTS public.schedule_blocks (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,

    resource_id             uuid NOT NULL,

    kind                    public.schedule_block_kind NOT NULL DEFAULT 'maintenance',
    reason                  varchar(300) NOT NULL,

    starts_at               timestamptz NOT NULL,
    ends_at                 timestamptz NOT NULL,

    created_by_user_id      uuid,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT schedule_blocks_range_ordered
        CHECK (ends_at > starts_at)
);


-- ══════════════════════════════════════════════════════════════════════
-- 4 · INDEXES
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ THE `_id_tenant_key` UNIQUE INDEXES ARE NOT OPTIONAL AND NOT MERELY
-- FOR SPEED. They are what the composite foreign keys in section 5 point
-- at. Without them Postgres refuses those keys, and without those keys a
-- task could reference an obligation belonging to a DIFFERENT tenant —
-- and row-level security would not notice, because each row individually
-- passes its own policy.

-- Engine 4
CREATE INDEX        IF NOT EXISTS compliance_obligations_tenant_idx    ON public.compliance_obligations (tenant_id);
CREATE INDEX        IF NOT EXISTS compliance_obligations_subject_idx   ON public.compliance_obligations (tenant_id, subject_company_id);
CREATE INDEX        IF NOT EXISTS compliance_obligations_authority_idx ON public.compliance_obligations (tenant_id, authority);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_obligations_id_tenant_key ON public.compliance_obligations (id, tenant_id);

CREATE INDEX        IF NOT EXISTS compliance_tasks_tenant_idx          ON public.compliance_tasks (tenant_id);
CREATE INDEX        IF NOT EXISTS compliance_tasks_due_idx             ON public.compliance_tasks (tenant_id, status, due_date);
CREATE INDEX        IF NOT EXISTS compliance_tasks_subject_idx         ON public.compliance_tasks (tenant_id, subject_company_id, due_date);
CREATE INDEX        IF NOT EXISTS compliance_tasks_owner_idx           ON public.compliance_tasks (tenant_id, owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_tasks_id_tenant_key       ON public.compliance_tasks (id, tenant_id);

-- ⚠️ ONE TASK PER OBLIGATION PER PERIOD. The generator runs repeatedly —
-- nightly, and again by hand when somebody adds an obligation mid-year.
-- Without this, the second run silently doubles every task, and a board
-- showing each filing twice is a board people stop trusting in a week.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_tasks_obligation_period_key
    ON public.compliance_tasks (obligation_id, period_start);

CREATE INDEX        IF NOT EXISTS compliance_evidence_tenant_idx       ON public.compliance_evidence (tenant_id);
CREATE INDEX        IF NOT EXISTS compliance_evidence_task_idx         ON public.compliance_evidence (tenant_id, task_id);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_evidence_id_tenant_key    ON public.compliance_evidence (id, tenant_id);

CREATE INDEX        IF NOT EXISTS compliance_licences_tenant_idx       ON public.compliance_licences (tenant_id);
CREATE INDEX        IF NOT EXISTS compliance_licences_expiry_idx       ON public.compliance_licences (tenant_id, status, valid_until);
CREATE INDEX        IF NOT EXISTS compliance_licences_subject_idx      ON public.compliance_licences (tenant_id, subject_company_id);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_licences_id_tenant_key    ON public.compliance_licences (id, tenant_id);

-- Engine 1
CREATE INDEX        IF NOT EXISTS schedule_resources_tenant_idx        ON public.schedule_resources (tenant_id);
CREATE INDEX        IF NOT EXISTS schedule_resources_kind_idx          ON public.schedule_resources (tenant_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_resources_code_key          ON public.schedule_resources (tenant_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_resources_id_tenant_key     ON public.schedule_resources (id, tenant_id);

CREATE INDEX        IF NOT EXISTS schedule_bookings_tenant_idx         ON public.schedule_bookings (tenant_id);
CREATE INDEX        IF NOT EXISTS schedule_bookings_resource_time_idx  ON public.schedule_bookings (tenant_id, resource_id, starts_at);
CREATE INDEX        IF NOT EXISTS schedule_bookings_status_idx         ON public.schedule_bookings (tenant_id, status);
CREATE INDEX        IF NOT EXISTS schedule_bookings_hold_idx           ON public.schedule_bookings (hold_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_bookings_reference_key      ON public.schedule_bookings (tenant_id, reference);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_bookings_id_tenant_key      ON public.schedule_bookings (id, tenant_id);

CREATE INDEX        IF NOT EXISTS schedule_blocks_tenant_idx           ON public.schedule_blocks (tenant_id);
CREATE INDEX        IF NOT EXISTS schedule_blocks_resource_time_idx    ON public.schedule_blocks (tenant_id, resource_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_blocks_id_tenant_key        ON public.schedule_blocks (id, tenant_id);


-- ══════════════════════════════════════════════════════════════════════
-- 5 · FOREIGN KEYS — LAST, AND THAT ORDER IS LOAD-BEARING
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so each key is
-- guarded by name. A re-run skips it rather than aborting the whole
-- transaction on "constraint already exists".
--
-- ⭐ THE COMPOSITE KEYS ARE THE POINT. `(obligation_id, tenant_id)`
-- rather than `(obligation_id)` is what makes a cross-tenant reference
-- impossible at the storage layer, rather than merely unlikely at the
-- application layer.

DO $ordence$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      -- Engine 4 · tenant ownership
      ('compliance_obligations', 'compliance_obligations_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),
      ('compliance_obligations', 'compliance_obligations_subject_fk',
       'FOREIGN KEY (subject_company_id) REFERENCES public.companies(id) ON DELETE CASCADE'),
      ('compliance_obligations', 'compliance_obligations_owner_fk',
       'FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL'),

      ('compliance_tasks', 'compliance_tasks_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),
      -- ⭐ COMPOSITE — the task and its obligation must share a tenant.
      ('compliance_tasks', 'compliance_tasks_obligation_fk',
       'FOREIGN KEY (obligation_id, tenant_id) REFERENCES public.compliance_obligations(id, tenant_id) ON DELETE CASCADE'),
      ('compliance_tasks', 'compliance_tasks_subject_fk',
       'FOREIGN KEY (subject_company_id) REFERENCES public.companies(id) ON DELETE CASCADE'),
      ('compliance_tasks', 'compliance_tasks_owner_fk',
       'FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL'),
      ('compliance_tasks', 'compliance_tasks_completed_by_fk',
       'FOREIGN KEY (completed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL'),

      ('compliance_evidence', 'compliance_evidence_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),
      -- ⭐ COMPOSITE — evidence cannot attach to another tenant's task.
      ('compliance_evidence', 'compliance_evidence_task_fk',
       'FOREIGN KEY (task_id, tenant_id) REFERENCES public.compliance_tasks(id, tenant_id) ON DELETE CASCADE'),
      ('compliance_evidence', 'compliance_evidence_uploaded_by_fk',
       'FOREIGN KEY (uploaded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL'),

      ('compliance_licences', 'compliance_licences_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),
      ('compliance_licences', 'compliance_licences_subject_fk',
       'FOREIGN KEY (subject_company_id) REFERENCES public.companies(id) ON DELETE CASCADE'),
      ('compliance_licences', 'compliance_licences_owner_fk',
       'FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL'),

      -- Engine 1
      ('schedule_resources', 'schedule_resources_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),

      ('schedule_bookings', 'schedule_bookings_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),
      -- ⭐ COMPOSITE — a booking cannot occupy another tenant's resource.
      ('schedule_bookings', 'schedule_bookings_resource_fk',
       'FOREIGN KEY (resource_id, tenant_id) REFERENCES public.schedule_resources(id, tenant_id) ON DELETE CASCADE'),
      ('schedule_bookings', 'schedule_bookings_contact_fk',
       'FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL'),
      ('schedule_bookings', 'schedule_bookings_created_by_fk',
       'FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL'),

      ('schedule_blocks', 'schedule_blocks_tenant_fk',
       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE'),
      ('schedule_blocks', 'schedule_blocks_resource_fk',
       'FOREIGN KEY (resource_id, tenant_id) REFERENCES public.schedule_resources(id, tenant_id) ON DELETE CASCADE'),
      ('schedule_blocks', 'schedule_blocks_created_by_fk',
       'FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL')
    ) AS t(tbl, con, def)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class     r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND r.relname = fk.tbl AND c.conname = fk.con
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', fk.tbl, fk.con, fk.def);
    END IF;
  END LOOP;
END
$ordence$;


-- ══════════════════════════════════════════════════════════════════════
-- 6 · SELF-CHECK
-- ══════════════════════════════════════════════════════════════════════
-- ⚠️ THIS RAISES RATHER THAN PRINTING. A file that "mostly worked" and
-- said so in a NOTICE is a file whose failure is discovered later, by
-- 0032 refusing for a reason that now looks unrelated.

DO $ordence$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ')
    INTO missing
    FROM unnest(ARRAY[
      'compliance_obligations', 'compliance_tasks', 'compliance_evidence',
      'compliance_licences', 'schedule_resources', 'schedule_bookings',
      'schedule_blocks'
    ]) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Ordence 0043 did not complete: still missing %', missing;
  END IF;

  RAISE NOTICE 'Ordence 0043 OK — 7 tables and 8 enum types present. Now run 0032 and 0033.';
END
$ordence$;

COMMIT;

-- ══════════════════════════════════════════════════════════════════════
-- WHAT TO RUN NEXT, IN THIS ORDER
-- ══════════════════════════════════════════════════════════════════════
--   0032_engine4_compliance.sql   ← adds RLS, triggers and the board view
--   0033_engine1_scheduling.sql   ← adds RLS, the exclusion constraint
--
-- ⚠️ DO NOT STOP AFTER THIS FILE. These seven tables have NO row-level
-- security until 0032 and 0033 run. A table with a tenant_id and no
-- policy is readable by every tenant, and it looks entirely normal until
-- it isn't. Run all three in one sitting.
-- ══════════════════════════════════════════════════════════════════════
