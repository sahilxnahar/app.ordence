-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates tables, seeds tenants, customers, invoices, orders and
--  holds, and then deliberately breaks things to show them being
--  refused. Throwaway Postgres only.
--
--     createdb drill0083
--     psql -q -d drill0083 -f DRILL-DO-NOT-RUN-IN-NEON-0083.sql
--
--  ⚠️ LIKE 0082'S DRILL, THIS ONE DOES NOT REFUSE TO RUN AS A SUPERUSER.
--  Nothing under test here is a permission: every refusal below is a
--  CHECK constraint, a unique index or a trigger, and no role bypasses
--  any of those. RLS is deliberately absent from the reproduction —
--  0079's drill covers it — because including it would invite the reader
--  to think a refusal came from a policy when it came from a constraint.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows breaks cannot tell "the constraint works" from
--  "the table rejects everything", and a table that rejects everything
--  passes every refusal in this file.
--
--  ⚠️ ONE THING HERE IS A DEMONSTRATION RATHER THAN A TEST, AND IS
--  LABELLED AS ONE. POSITIVE 5 shows the reconciliation gap opening when
--  a cheque bounces. Whether the application then REFUSES to print a
--  headroom figure lives in `lib/credit/headroom.ts` and is proved by
--  `tests/ui/credit-control.test.ts`; reimplementing that judgement in
--  SQL would give the product two credit engines that must agree
--  forever. What this file proves is that the DATA moves the way the
--  engine assumes, which is the half a database can be responsible for.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;

-- =====================================================================
--  STEP 1 — THE SHAPES, REPRODUCED FROM 0002, 0028, 0048, 0049 AND 0083
-- =====================================================================
--
--  `tenants`, `users`, `companies`, `sales_orders`, `sales_invoices`,
--  `customer_receipts` and `customer_receipt_allocations` are cut down
--  to the columns this drill reasons about. Everything from 0083 is
--  copied as it ships.

DROP TABLE IF EXISTS credit_dunning_log, credit_dunning_stages,
                     credit_dunning_ladders, credit_hold_overrides,
                     credit_hold_events, customer_credit_profiles,
                     customer_receipt_allocations, customer_receipts,
                     sales_invoices, sales_orders, companies, users,
                     tenants CASCADE;
DROP FUNCTION IF EXISTS ordence_mirror_credit_hold() CASCADE;
DROP FUNCTION IF EXISTS ordence_guard_credit_override_immutable() CASCADE;
DROP FUNCTION IF EXISTS ordence_guard_dunning_log_identity() CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP TYPE IF EXISTS credit_hold_source, credit_dunning_delivery,
                    credit_dunning_channel CASCADE;

CREATE TABLE tenants   (id uuid PRIMARY KEY);
CREATE TABLE users     (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id));
CREATE TABLE companies (
    id        uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name      varchar(255) NOT NULL
);

CREATE TABLE sales_orders (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id   uuid REFERENCES companies(id),
    order_no     varchar(40) NOT NULL,
    status       varchar(30) NOT NULL,
    total_minor  bigint NOT NULL DEFAULT 0,
    confirmed_at timestamptz
);

CREATE TABLE sales_invoices (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id      uuid NOT NULL REFERENCES companies(id),
    order_id        uuid REFERENCES sales_orders(id),
    invoice_number  varchar(60) NOT NULL,
    status          varchar(20) NOT NULL,
    due_date        date,
    total_minor     bigint NOT NULL DEFAULT 0,
    received_minor  bigint NOT NULL DEFAULT 0
);

CREATE TABLE customer_receipts (
    id          uuid PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    status      varchar(20) NOT NULL DEFAULT 'cleared',
    amount_minor bigint NOT NULL
);

CREATE TABLE customer_receipt_allocations (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    receipt_id   uuid NOT NULL REFERENCES customer_receipts(id),
    invoice_id   uuid NOT NULL REFERENCES sales_invoices(id),
    amount_minor bigint NOT NULL
);

-- 0048, cut down. `on_hold` is the mirror 0083's trigger maintains.
CREATE TABLE customer_credit_profiles (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    credit_limit_minor bigint,
    on_hold            boolean NOT NULL DEFAULT false,
    hold_reason        text,
    auto_hold_enabled  boolean NOT NULL DEFAULT false,
    dunning_ladder_id  uuid,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_credit_profiles_tenant_company_key
      UNIQUE (tenant_id, company_id)
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- --- 0083, verbatim ---------------------------------------------------

CREATE TYPE credit_hold_source AS ENUM ('manual', 'automatic');
CREATE TYPE credit_dunning_delivery AS ENUM ('queued', 'sent', 'failed', 'suppressed');
CREATE TYPE credit_dunning_channel AS ENUM
  ('email', 'sms', 'whatsapp', 'call', 'letter', 'visit');

CREATE TABLE credit_hold_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source          credit_hold_source NOT NULL,
    reason          text NOT NULL,
    placed_at       timestamptz NOT NULL DEFAULT now(),
    placed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    exposure_at_hold_minor  bigint,
    limit_at_hold_minor     bigint,
    released_at     timestamptz,
    released_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    release_reason  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credit_hold_events_reason_said
      CHECK (length(btrim(reason)) >= 4),
    CONSTRAINT credit_hold_events_manual_has_actor
      CHECK (source <> 'manual' OR placed_by IS NOT NULL),
    CONSTRAINT credit_hold_events_release_paired
      CHECK ((released_at IS NULL) = (released_by IS NULL)),
    CONSTRAINT credit_hold_events_release_after_placement
      CHECK (released_at IS NULL OR released_at >= placed_at)
);

CREATE UNIQUE INDEX credit_hold_events_one_active_key
    ON credit_hold_events (tenant_id, company_id)
    WHERE released_at IS NULL;

CREATE TABLE credit_hold_overrides (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    order_id        uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    hold_event_id   uuid REFERENCES credit_hold_events(id) ON DELETE SET NULL,
    actor_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason          text NOT NULL,
    exposure_at_override_minor bigint,
    limit_at_override_minor    bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    consumed_at     timestamptz,
    CONSTRAINT credit_hold_overrides_reason_said
      CHECK (length(btrim(reason)) >= 8),
    CONSTRAINT credit_hold_overrides_consumed_after_created
      CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX credit_hold_overrides_one_per_order_key
    ON credit_hold_overrides (tenant_id, order_id);

CREATE TABLE credit_dunning_ladders (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       varchar(80) NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX credit_dunning_ladders_one_default_key
    ON credit_dunning_ladders (tenant_id)
    WHERE is_default AND is_active;

CREATE TABLE credit_dunning_stages (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ladder_id     uuid NOT NULL REFERENCES credit_dunning_ladders(id) ON DELETE CASCADE,
    stage_no      integer NOT NULL,
    label         varchar(80) NOT NULL,
    days_past_due integer NOT NULL,
    channel       credit_dunning_channel NOT NULL DEFAULT 'email',
    template_key  varchar(80),
    places_hold   boolean NOT NULL DEFAULT false,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credit_dunning_stages_age_sane
      CHECK (days_past_due >= 0 AND days_past_due <= 3650),
    CONSTRAINT credit_dunning_stages_no_positive
      CHECK (stage_no >= 1 AND stage_no <= 20)
);

CREATE UNIQUE INDEX credit_dunning_stages_no_key
    ON credit_dunning_stages (tenant_id, ladder_id, stage_no);
CREATE UNIQUE INDEX credit_dunning_stages_age_key
    ON credit_dunning_stages (tenant_id, ladder_id, days_past_due);

CREATE TABLE credit_dunning_log (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id       uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    ladder_id        uuid REFERENCES credit_dunning_ladders(id) ON DELETE SET NULL,
    stage_id         uuid NOT NULL REFERENCES credit_dunning_stages(id) ON DELETE RESTRICT,
    stage_no         integer NOT NULL,
    days_past_due    integer NOT NULL,
    channel          credit_dunning_channel NOT NULL,
    template_key     varchar(80),
    recipient_name   varchar(160),
    recipient_email  varchar(255),
    recipient_phone  varchar(40),
    amount_due_minor bigint NOT NULL,
    delivery         credit_dunning_delivery NOT NULL DEFAULT 'queued',
    queued_at        timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz,
    failure_reason   text,
    next_action_on   date,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credit_dunning_log_amount_sane CHECK (amount_due_minor > 0),
    CONSTRAINT credit_dunning_log_sent_has_time
      CHECK (delivery <> 'sent' OR sent_at IS NOT NULL),
    CONSTRAINT credit_dunning_log_failed_has_reason
      CHECK (delivery <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT credit_dunning_log_email_has_address
      CHECK (channel <> 'email' OR recipient_email IS NOT NULL),
    CONSTRAINT credit_dunning_log_sms_has_number
      CHECK (channel NOT IN ('sms', 'whatsapp') OR recipient_phone IS NOT NULL)
);

CREATE UNIQUE INDEX credit_dunning_log_once_per_stage_key
    ON credit_dunning_log (tenant_id, invoice_id, stage_id);

CREATE OR REPLACE FUNCTION ordence_mirror_credit_hold()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid; v_company uuid; v_active boolean; v_reason text;
BEGIN
  v_tenant  := COALESCE(NEW.tenant_id,  OLD.tenant_id);
  v_company := COALESCE(NEW.company_id, OLD.company_id);
  SELECT true, e.reason INTO v_active, v_reason
    FROM credit_hold_events e
   WHERE e.tenant_id = v_tenant AND e.company_id = v_company
     AND e.released_at IS NULL
   LIMIT 1;
  IF v_active IS NULL THEN v_active := false; v_reason := NULL; END IF;
  INSERT INTO customer_credit_profiles (tenant_id, company_id, on_hold, hold_reason)
  VALUES (v_tenant, v_company, v_active, v_reason)
  ON CONFLICT (tenant_id, company_id)
  DO UPDATE SET on_hold = EXCLUDED.on_hold,
                hold_reason = EXCLUDED.hold_reason,
                updated_at = now();
  RETURN NULL;
END $$;

CREATE TRIGGER credit_hold_events_mirror
  AFTER INSERT OR UPDATE OR DELETE ON credit_hold_events
  FOR EACH ROW EXECUTE FUNCTION ordence_mirror_credit_hold();

CREATE OR REPLACE FUNCTION ordence_guard_credit_override_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '🔴 A credit hold override cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.exposure_at_override_minor IS DISTINCT FROM OLD.exposure_at_override_minor
     OR NEW.limit_at_override_minor IS DISTINCT FROM OLD.limit_at_override_minor
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION '🔴 A credit hold override is a signature. Only consumed_at may change.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION '🔴 An override that has been used cannot be un-used.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER credit_hold_overrides_immutable
  BEFORE UPDATE OR DELETE ON credit_hold_overrides
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_credit_override_immutable();

CREATE OR REPLACE FUNCTION ordence_guard_dunning_log_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '🔴 A dunning record cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
     OR NEW.stage_no IS DISTINCT FROM OLD.stage_no
     OR NEW.queued_at IS DISTINCT FROM OLD.queued_at
  THEN
    RAISE EXCEPTION '🔴 A dunning record may not be re-pointed at another invoice or stage.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER credit_dunning_log_identity
  BEFORE UPDATE OR DELETE ON credit_dunning_log
  FOR EACH ROW EXECUTE FUNCTION ordence_guard_dunning_log_identity();


-- =====================================================================
--  STEP 2 — SEED
-- =====================================================================

INSERT INTO tenants (id) VALUES
  ('11111111-1111-1111-1111-111111111111');

INSERT INTO users (id, tenant_id) VALUES
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222223', '11111111-1111-1111-1111-111111111111');

INSERT INTO companies (id, tenant_id, name) VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'Shree Traders'),
  ('33333333-3333-3333-3333-333333333334', '11111111-1111-1111-1111-111111111111',
   'Kaveri Steel');

INSERT INTO sales_orders (id, tenant_id, company_id, order_no, status, total_minor) VALUES
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'SO-202608-0001', 'draft', 50000000),
  ('44444444-4444-4444-4444-444444444445', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'SO-202608-0002', 'draft', 25000000);

INSERT INTO sales_invoices
  (id, tenant_id, company_id, order_id, invoice_number, status, due_date,
   total_minor, received_minor)
VALUES
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', NULL, 'AH/2026-27/0001', 'part_paid',
   DATE '2026-05-01', 40000000, 15000000);

INSERT INTO customer_receipts (id, tenant_id, status, amount_minor) VALUES
  ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111',
   'cleared', 15000000);

INSERT INTO customer_receipt_allocations
  (id, tenant_id, receipt_id, invoice_id, amount_minor)
VALUES
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
   '66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555',
   15000000);

INSERT INTO credit_dunning_ladders (id, tenant_id, name, is_default) VALUES
  ('88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111',
   'Standard trade', true);

INSERT INTO credit_dunning_stages
  (id, tenant_id, ladder_id, stage_no, label, days_past_due, channel, places_hold)
VALUES
  ('99999999-9999-9999-9999-999999999991', '11111111-1111-1111-1111-111111111111',
   '88888888-8888-8888-8888-888888888888', 1, 'Polite reminder',  7, 'email', false),
  ('99999999-9999-9999-9999-999999999992', '11111111-1111-1111-1111-111111111111',
   '88888888-8888-8888-8888-888888888888', 2, 'Firm reminder',   30, 'email', false),
  ('99999999-9999-9999-9999-999999999993', '11111111-1111-1111-1111-111111111111',
   '88888888-8888-8888-8888-888888888888', 3, 'Final notice',    60, 'call',  true);

\echo '=== SEEDED ==='


-- =====================================================================
--  POSITIVE 1 — A MANUAL HOLD IS PLACED, AND THE 0048 MIRROR FOLLOWS
-- =====================================================================
--
--  ⭐ THE PROFILE ROW DID NOT EXIST. A customer can be held before
--  anybody has ever set a credit limit on them — in fact that is the
--  common case — and a mirror trigger that only UPDATEd would silently
--  fail to mirror the hold for exactly those customers.

INSERT INTO credit_hold_events (tenant_id, company_id, source, reason, placed_by)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'manual',
        'Cheque 004182 returned unpaid on 12 August. Spoke to Mr Shah.',
        '22222222-2222-2222-2222-222222222222');

SELECT '✅ POSITIVE 1' AS drill,
       p.on_hold, left(p.hold_reason, 40) AS mirror_reason
  FROM customer_credit_profiles p
 WHERE p.company_id = '33333333-3333-3333-3333-333333333333';
-- ⭐ EXPECT: on_hold = true, mirror_reason quoting the cheque.


-- =====================================================================
--  REFUSAL 1 — A SECOND OPEN HOLD ON THE SAME CUSTOMER
-- =====================================================================
--
--  🔴 THIS IS THE IDEMPOTENCY GUARANTEE FOR THE AUTOMATIC SWEEP. Without
--  it a nightly job that places a hold for "exposure over limit" writes
--  one row a night forever.

DO $$
BEGIN
  INSERT INTO credit_hold_events (tenant_id, company_id, source, reason)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333',
          'automatic', 'Exposure over limit.');
  RAISE EXCEPTION '❌ DRILL FAILED — a second open hold was accepted.';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 1 — second open hold refused: %', SQLERRM;
END $$;

-- ⭐ AND THE SAME INSERT WITH `ON CONFLICT DO NOTHING` IS A QUIET NO-OP,
--    which is what `runDunningSweep` and `placeCreditHold` both use.
INSERT INTO credit_hold_events (tenant_id, company_id, source, reason)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'automatic', 'Exposure over limit.')
ON CONFLICT DO NOTHING;

SELECT '✅ POSITIVE 1b' AS drill, count(*) AS open_holds
  FROM credit_hold_events
 WHERE company_id = '33333333-3333-3333-3333-333333333333'
   AND released_at IS NULL;
-- ⭐ EXPECT: 1.


-- =====================================================================
--  REFUSAL 2 — A MANUAL HOLD WITH NO ACTOR
-- =====================================================================
--
--  ⚠️ `placed_by` IS NULLABLE ONLY SO THE AUTOMATIC SWEEP CAN OMIT IT.
--  Naming a person for a decision the ladder made is the `approvedBy`
--  bug of Phase 47 in a new table.

DO $$
BEGIN
  INSERT INTO credit_hold_events (tenant_id, company_id, source, reason)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333334',
          'manual', 'Somebody decided this.');
  RAISE EXCEPTION '❌ DRILL FAILED — a manual hold with no actor was accepted.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 2 — manual hold with no actor refused: %', SQLERRM;
END $$;

-- ⭐ AN AUTOMATIC ONE WITH NO ACTOR IS FINE, AND MUST BE.
INSERT INTO credit_hold_events (tenant_id, company_id, source, reason)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333334',
        'automatic',
        'Exposure ₹8,40,000 against a limit of ₹5,00,000 — ₹3,40,000 over.');

SELECT '✅ POSITIVE 2' AS drill, source, placed_by IS NULL AS no_actor
  FROM credit_hold_events
 WHERE company_id = '33333333-3333-3333-3333-333333333334';


-- =====================================================================
--  REFUSAL 3 — A HOLD REASON THAT SAYS NOTHING
-- =====================================================================
DO $$
BEGIN
  INSERT INTO credit_hold_events (tenant_id, company_id, source, reason, placed_by)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333',
          'manual', '  x  ', '22222222-2222-2222-2222-222222222222');
  RAISE EXCEPTION '❌ DRILL FAILED — a one-character reason was accepted.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 3 — empty hold reason refused: %', SQLERRM;
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 3 — refused by the one-open-hold index first: %', SQLERRM;
END $$;


-- =====================================================================
--  POSITIVE 3 — AN OVERRIDE IS RECORDED FOR ONE ORDER
-- =====================================================================
INSERT INTO credit_hold_overrides
  (tenant_id, company_id, order_id, actor_user_id, reason,
   exposure_at_override_minor, limit_at_override_minor)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
        '22222222-2222-2222-2222-222222222223',
        'Mr Shah has confirmed the RTGS, UTR HDFC0912441 quoted. Releasing against it.',
        25000000, 20000000);

SELECT '✅ POSITIVE 3' AS drill, order_id, consumed_at IS NULL AS unused
  FROM credit_hold_overrides;


-- =====================================================================
--  REFUSAL 4 — A SECOND OVERRIDE FOR THE SAME ORDER
-- =====================================================================
DO $$
BEGIN
  INSERT INTO credit_hold_overrides
    (tenant_id, company_id, order_id, actor_user_id, reason)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333',
          '44444444-4444-4444-4444-444444444444',
          '22222222-2222-2222-2222-222222222223',
          'Second thoughts, releasing again.');
  RAISE EXCEPTION '❌ DRILL FAILED — a second override on one order was accepted.';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 4 — second override on one order refused: %', SQLERRM;
END $$;

-- ⭐ A DIFFERENT ORDER GETS ITS OWN. One override releases exactly one.
INSERT INTO credit_hold_overrides
  (tenant_id, company_id, order_id, actor_user_id, reason)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444445',
        '22222222-2222-2222-2222-222222222223',
        'Same RTGS covers this one as well; both confirmed with the bank.');


-- =====================================================================
--  REFUSAL 5 — AN OVERRIDE REASON THAT IS NOT A SENTENCE
-- =====================================================================
--
--  🔴 EIGHT CHARACTERS, NOT FOUR. An override reason is read back in a
--  bad-debt review by somebody deciding whether it was judgement or
--  negligence. "ok" is not an answer to that question.
DO $$
BEGIN
  INSERT INTO credit_hold_overrides
    (tenant_id, company_id, order_id, actor_user_id, reason)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333334',
          '44444444-4444-4444-4444-444444444444',
          '22222222-2222-2222-2222-222222222223',
          'ok');
  RAISE EXCEPTION '❌ DRILL FAILED — "ok" was accepted as an override reason.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 5 — "ok" refused as an override reason: %', SQLERRM;
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 5 — refused by the one-per-order index first: %', SQLERRM;
END $$;


-- =====================================================================
--  REFUSAL 6 — EDITING AN OVERRIDE AFTER THE FACT
-- =====================================================================
--
--  ⚠️ THE ATTACK THIS REFUSES IS NOT AN ATTACK. It is somebody tidying
--  up. An override whose reason can be edited is an override whose
--  reason is whatever it needed to be by the time anybody looked.
DO $$
BEGIN
  UPDATE credit_hold_overrides
     SET reason = 'Approved by the director, all in order.'
   WHERE order_id = '44444444-4444-4444-4444-444444444444';
  RAISE EXCEPTION '❌ DRILL FAILED — an override reason was edited.';
EXCEPTION
  WHEN restrict_violation THEN
    RAISE NOTICE '✅ REFUSAL 6 — override edit refused: %', SQLERRM;
END $$;

DO $$
BEGIN
  DELETE FROM credit_hold_overrides
   WHERE order_id = '44444444-4444-4444-4444-444444444444';
  RAISE EXCEPTION '❌ DRILL FAILED — an override was deleted.';
EXCEPTION
  WHEN restrict_violation THEN
    RAISE NOTICE '✅ REFUSAL 6b — override delete refused: %', SQLERRM;
END $$;

-- ⭐ CONSUMING IT IS THE ONE PERMITTED CHANGE.
UPDATE credit_hold_overrides
   SET consumed_at = now()
 WHERE order_id = '44444444-4444-4444-4444-444444444444';

SELECT '✅ POSITIVE 4' AS drill, consumed_at IS NOT NULL AS consumed
  FROM credit_hold_overrides
 WHERE order_id = '44444444-4444-4444-4444-444444444444';


-- =====================================================================
--  REFUSAL 7 — UN-CONSUMING AN OVERRIDE
-- =====================================================================
--
--  🔴 IT WOULD LET ONE SIGNATURE RELEASE A SECOND ORDER.
DO $$
BEGIN
  UPDATE credit_hold_overrides
     SET consumed_at = NULL
   WHERE order_id = '44444444-4444-4444-4444-444444444444';
  RAISE EXCEPTION '❌ DRILL FAILED — a used override was un-used.';
EXCEPTION
  WHEN restrict_violation THEN
    RAISE NOTICE '✅ REFUSAL 7 — un-consuming refused: %', SQLERRM;
END $$;


-- =====================================================================
--  REFUSAL 8 — DELETING A USER WHO HAS SIGNED AN OVERRIDE
-- =====================================================================
--
--  ⚠️ EVERY OTHER ACTOR COLUMN IN THIS SCHEMA IS `ON DELETE SET NULL`.
--  This one is RESTRICT, because an override with no actor is exactly
--  the boolean flip the table exists to replace: it says an order went
--  out past a hold and nobody did it.
DO $$
BEGIN
  DELETE FROM users WHERE id = '22222222-2222-2222-2222-222222222223';
  RAISE EXCEPTION '❌ DRILL FAILED — an override signatory was deleted.';
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE NOTICE '✅ REFUSAL 8 — deleting an override signatory refused: %', SQLERRM;
END $$;


-- =====================================================================
--  POSITIVE 5 — A DUNNING STAGE IS RECORDED
-- =====================================================================
INSERT INTO credit_dunning_log
  (tenant_id, company_id, invoice_id, ladder_id, stage_id, stage_no,
   days_past_due, channel, recipient_name, recipient_email,
   amount_due_minor, delivery, next_action_on)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        '55555555-5555-5555-5555-555555555555',
        '88888888-8888-8888-8888-888888888888',
        '99999999-9999-9999-9999-999999999991',
        1, 9, 'email', 'Mr Shah', 'accounts@shreetraders.example',
        25000000, 'queued', DATE '2026-05-31');

SELECT '✅ POSITIVE 5' AS drill, stage_no, delivery, next_action_on
  FROM credit_dunning_log;
-- ⭐ EXPECT: delivery = 'queued'. Batch 40 SENDS NOTHING; `queued` is
--    the honest state and the board says so in those words.


-- =====================================================================
--  REFUSAL 9 — THE SAME STAGE, THE SAME INVOICE, TWICE
-- =====================================================================
--
--  🔴🔴 THIS IS THE ONE THAT MATTERS. A re-run of the schedule must not
--  send the same demanding letter twice.
DO $$
BEGIN
  INSERT INTO credit_dunning_log
    (tenant_id, company_id, invoice_id, ladder_id, stage_id, stage_no,
     days_past_due, channel, recipient_email, amount_due_minor)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333',
          '55555555-5555-5555-5555-555555555555',
          '88888888-8888-8888-8888-888888888888',
          '99999999-9999-9999-9999-999999999991',
          1, 10, 'email', 'accounts@shreetraders.example', 25000000);
  RAISE EXCEPTION '❌ DRILL FAILED — a stage was recorded twice for one invoice.';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 9 — repeat of a recorded stage refused: %', SQLERRM;
END $$;

-- ⭐ AND `ON CONFLICT DO NOTHING` — what the sweep actually uses — is a
--    quiet no-op rather than an exception that would abort the rest of
--    a 300-invoice run.
INSERT INTO credit_dunning_log
  (tenant_id, company_id, invoice_id, ladder_id, stage_id, stage_no,
   days_past_due, channel, recipient_email, amount_due_minor)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        '55555555-5555-5555-5555-555555555555',
        '88888888-8888-8888-8888-888888888888',
        '99999999-9999-9999-9999-999999999991',
        1, 10, 'email', 'accounts@shreetraders.example', 25000000)
ON CONFLICT DO NOTHING;

SELECT '✅ POSITIVE 5b' AS drill, count(*) AS rows_for_stage_1
  FROM credit_dunning_log
 WHERE invoice_id = '55555555-5555-5555-5555-555555555555'
   AND stage_id = '99999999-9999-9999-9999-999999999991';
-- ⭐ EXPECT: 1.

-- ⭐ A DIFFERENT STAGE ON THE SAME INVOICE IS FINE. The ladder escalates.
INSERT INTO credit_dunning_log
  (tenant_id, company_id, invoice_id, ladder_id, stage_id, stage_no,
   days_past_due, channel, recipient_email, amount_due_minor, next_action_on)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        '55555555-5555-5555-5555-555555555555',
        '88888888-8888-8888-8888-888888888888',
        '99999999-9999-9999-9999-999999999992',
        2, 32, 'email', 'accounts@shreetraders.example', 25000000,
        DATE '2026-06-30');


-- =====================================================================
--  REFUSAL 10 — RE-POINTING A RECORDED STAGE AT ANOTHER INVOICE
-- =====================================================================
--
--  ⚠️ THE UNIQUE INDEX ALONE DOES NOT STOP THIS. Moving a recorded row
--  onto a different invoice frees the (invoice, stage) pair to be
--  inserted again, and the customer is chased twice while the index
--  still reports one row per stage.
DO $$
BEGIN
  UPDATE credit_dunning_log
     SET invoice_id = '55555555-5555-5555-5555-555555555555',
         stage_id   = '99999999-9999-9999-9999-999999999993'
   WHERE stage_no = 2;
  RAISE EXCEPTION '❌ DRILL FAILED — a dunning record was re-pointed.';
EXCEPTION
  WHEN restrict_violation THEN
    RAISE NOTICE '✅ REFUSAL 10 — re-pointing a dunning record refused: %', SQLERRM;
END $$;

DO $$
BEGIN
  DELETE FROM credit_dunning_log WHERE stage_no = 2;
  RAISE EXCEPTION '❌ DRILL FAILED — a dunning record was deleted.';
EXCEPTION
  WHEN restrict_violation THEN
    RAISE NOTICE '✅ REFUSAL 10b — deleting a dunning record refused: %', SQLERRM;
END $$;

-- ⭐ MARKING IT SENT IS PERMITTED, AND IS THE ONLY WAY `sent` EVER
--    APPEARS. Nothing in Batch 40 does this; whatever delivers the row
--    does.
UPDATE credit_dunning_log
   SET delivery = 'sent', sent_at = now()
 WHERE stage_no = 2;

SELECT '✅ POSITIVE 6' AS drill, delivery, sent_at IS NOT NULL AS has_time
  FROM credit_dunning_log WHERE stage_no = 2;


-- =====================================================================
--  REFUSAL 11 — `sent` WITH NO TIMESTAMP, AND EMAIL WITH NO ADDRESS
-- =====================================================================
DO $$
BEGIN
  UPDATE credit_dunning_log SET delivery = 'sent', sent_at = NULL
   WHERE stage_no = 1;
  RAISE EXCEPTION '❌ DRILL FAILED — "sent" with no timestamp was accepted.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 11 — "sent" with no evidence refused: %', SQLERRM;
END $$;

DO $$
BEGIN
  INSERT INTO credit_dunning_log
    (tenant_id, company_id, invoice_id, ladder_id, stage_id, stage_no,
     days_past_due, channel, amount_due_minor)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '33333333-3333-3333-3333-333333333333',
          '55555555-5555-5555-5555-555555555555',
          '88888888-8888-8888-8888-888888888888',
          '99999999-9999-9999-9999-999999999993',
          3, 65, 'email', 25000000);
  RAISE EXCEPTION '❌ DRILL FAILED — an e-mail to nobody was queued.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 11b — e-mail with no address refused: %', SQLERRM;
END $$;


-- =====================================================================
--  REFUSAL 12 — TWO LADDER RUNGS AT THE SAME AGE
-- =====================================================================
--
--  🔴 IT WOULD MAKE "WHICH STAGE IS DUE ON DAY 30" UNANSWERABLE, and the
--  sweep would send both — two letters, same day, same customer,
--  different tone.
DO $$
BEGIN
  INSERT INTO credit_dunning_stages
    (tenant_id, ladder_id, stage_no, label, days_past_due)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '88888888-8888-8888-8888-888888888888',
          4, 'Another one at thirty days', 30);
  RAISE EXCEPTION '❌ DRILL FAILED — two rungs at the same age were accepted.';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 12 — duplicate rung age refused: %', SQLERRM;
END $$;

-- ⭐ A RUNG AT A NEW AGE IS FINE.
INSERT INTO credit_dunning_stages
  (tenant_id, ladder_id, stage_no, label, days_past_due, channel)
VALUES ('11111111-1111-1111-1111-111111111111',
        '88888888-8888-8888-8888-888888888888',
        4, 'Legal notice', 90, 'letter');


-- =====================================================================
--  REFUSAL 13 — A STAGE BEFORE THE MONEY IS DUE
-- =====================================================================
--
--  ⚠️ A NEGATIVE AGE IS NOT DUNNING. It is a payment reminder, and
--  mixing the two puts "you are overdue" in front of somebody who is not.
DO $$
BEGIN
  INSERT INTO credit_dunning_stages
    (tenant_id, ladder_id, stage_no, label, days_past_due)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '88888888-8888-8888-8888-888888888888',
          5, 'Three days before due', -3);
  RAISE EXCEPTION '❌ DRILL FAILED — a negative stage age was accepted.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 13 — negative stage age refused: %', SQLERRM;
END $$;

-- ⭐ ZERO IS LEGAL AND MEANS "ON THE DUE DATE".
INSERT INTO credit_dunning_stages
  (tenant_id, ladder_id, stage_no, label, days_past_due)
VALUES ('11111111-1111-1111-1111-111111111111',
        '88888888-8888-8888-8888-888888888888',
        5, 'Due today', 0);


-- =====================================================================
--  REFUSAL 14 — TWO DEFAULT LADDERS
-- =====================================================================
DO $$
BEGIN
  INSERT INTO credit_dunning_ladders (tenant_id, name, is_default)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Government terms', true);
  RAISE EXCEPTION '❌ DRILL FAILED — two default ladders were accepted.';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE '✅ REFUSAL 14 — second default ladder refused: %', SQLERRM;
END $$;

-- ⭐ A SECOND NON-DEFAULT LADDER IS FINE. Different customers, different
--    schedules — a distributor on 30-day terms and a government
--    department on 90 are both correct.
INSERT INTO credit_dunning_ladders (tenant_id, name, is_default)
VALUES ('11111111-1111-1111-1111-111111111111', 'Government terms', false);


-- =====================================================================
--  POSITIVE 7 (DEMONSTRATION, NOT A TEST) — THE RECONCILIATION GAP
--  OPENS WHEN A CHEQUE BOUNCES AND THE COLUMN IS NOT RE-DERIVED
-- =====================================================================
--
--  🔴 THIS IS THE SINGLE MOST LIKELY WAY CREDIT CONTROL FAILS SILENTLY.
--  `sales_invoices.received_minor` says the customer paid; the
--  allocations, filtered to receipts that actually settled, say they did
--  not. Exposure is understated by exactly the bounced amount, and the
--  credit limit lets through exactly the order it exists to stop — for
--  the exact customer whose cheque just bounced.
--
--  ⚠️ WHAT HAPPENS NEXT IS NOT A DATABASE DECISION. 0049's
--  `customer_receipt_status_cascade` re-derives the column in
--  production, and it is deliberately NOT reproduced here — the point of
--  this section is to show the gap that the reconciliation in
--  `lib/credit/headroom.ts` exists to catch when something has stopped
--  the cascade running. The application's response to the gap — print NO
--  headroom figure at all — lives in TypeScript and is proved by
--  `tests/ui/credit-control.test.ts`.

SELECT '— before the bounce —' AS stage,
       i.received_minor AS column_says,
       COALESCE(SUM(a.amount_minor) FILTER (WHERE r.status IN ('pending','cleared')), 0)
         AS allocations_say
  FROM sales_invoices i
  LEFT JOIN customer_receipt_allocations a ON a.invoice_id = i.id
  LEFT JOIN customer_receipts r ON r.id = a.receipt_id
 WHERE i.id = '55555555-5555-5555-5555-555555555555'
 GROUP BY i.received_minor;

UPDATE customer_receipts SET status = 'bounced'
 WHERE id = '66666666-6666-6666-6666-666666666666';

SELECT '— after the bounce, cascade not run —' AS stage,
       i.received_minor AS column_says,
       COALESCE(SUM(a.amount_minor) FILTER (WHERE r.status IN ('pending','cleared')), 0)
         AS allocations_say,
       i.received_minor
         - COALESCE(SUM(a.amount_minor) FILTER (WHERE r.status IN ('pending','cleared')), 0)
         AS difference_minor
  FROM sales_invoices i
  LEFT JOIN customer_receipt_allocations a ON a.invoice_id = i.id
  LEFT JOIN customer_receipts r ON r.id = a.receipt_id
 WHERE i.id = '55555555-5555-5555-5555-555555555555'
 GROUP BY i.received_minor;
-- 🔴 EXPECT: difference_minor = 15000000 (₹1,50,000). The board shows
--    NO headroom figure for this customer while that is true.


-- =====================================================================
--  POSITIVE 8 — LIFTING THE HOLD, AND THE MIRROR FOLLOWING BACK
-- =====================================================================
--
--  ⭐ AN AUTOMATIC HOLD IS LIFTED THE SAME WAY A MANUAL ONE IS: by a
--  person, with their id on the row. Nothing lifts itself.
UPDATE credit_hold_events
   SET released_at = now(),
       released_by = '22222222-2222-2222-2222-222222222222',
       release_reason = 'RTGS received in full, UTR HDFC0912441.'
 WHERE company_id = '33333333-3333-3333-3333-333333333333'
   AND released_at IS NULL;

SELECT '✅ POSITIVE 8' AS drill, p.on_hold AS mirror_says,
       p.hold_reason IS NULL AS reason_cleared
  FROM customer_credit_profiles p
 WHERE p.company_id = '33333333-3333-3333-3333-333333333333';
-- ⭐ EXPECT: mirror_says = false, reason_cleared = true.

-- ⭐ AND THE CUSTOMER CAN BE HELD AGAIN. The partial unique index only
--    ever constrained the OPEN hold — a customer who is held, released
--    and held again has three rows and a readable history, which is the
--    whole point of decision ②.
INSERT INTO credit_hold_events (tenant_id, company_id, source, reason, placed_by)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'manual', 'RTGS reversed by the bank on 20 August.',
        '22222222-2222-2222-2222-222222222222');

SELECT '✅ POSITIVE 8b' AS drill, count(*) AS holds_in_history
  FROM credit_hold_events
 WHERE company_id = '33333333-3333-3333-3333-333333333333';
-- ⭐ EXPECT: 2. A boolean flipped back to false would have shown 0.


-- =====================================================================
--  REFUSAL 15 — A RELEASE WITH NO RELEASER
-- =====================================================================
DO $$
BEGIN
  UPDATE credit_hold_events
     SET released_at = now()
   WHERE company_id = '33333333-3333-3333-3333-333333333334';
  RAISE EXCEPTION '❌ DRILL FAILED — a release with no releaser was accepted.';
EXCEPTION
  WHEN check_violation THEN
    RAISE NOTICE '✅ REFUSAL 15 — release with no releaser refused: %', SQLERRM;
END $$;


\echo ''
\echo '====================================================================='
\echo ' DRILL 0083 COMPLETE.'
\echo ' Every ✅ REFUSAL line above is a rule the database enforces without'
\echo ' the application. Every ✅ POSITIVE line is a write that must still'
\echo ' work — a table that refuses everything would have passed all the'
\echo ' refusals and none of these.'
\echo ''
\echo ' 🔴 WHAT THIS DRILL CANNOT SHOW: that confirmOrder actually asks.'
\echo '    That is source, not schema — tests/ui/credit-control.test.ts.'
\echo '====================================================================='
