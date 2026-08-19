-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates tables, seeds a chart of accounts and a journal, and then
--  deliberately breaks things to show them being refused. Throwaway
--  Postgres only.
--
--     createdb drill0084
--     psql -q -d drill0084 -f DRILL-DO-NOT-RUN-IN-NEON-0084.sql
--
--  ⚠️ THE FILENAME IS THE GUARD OF LAST RESORT AND STEP 0 IS THE GUARD
--  OF FIRST RESORT. Neither is a substitute for reading the name of the
--  database in the prompt before pressing enter.
--
--  ⚠️ LIKE 0082'S DRILL AND UNLIKE 0079'S, THIS ONE DOES NOT REFUSE TO
--  RUN AS A SUPERUSER. Nothing under test here is a permission: every
--  refusal below is a foreign key, a unique index, a CHECK constraint or
--  a trigger, and no role bypasses any of those. RLS is deliberately
--  absent from the reproduction — 0079's drill covers it — because
--  including it would invite the reader to think a refusal came from a
--  policy when it came from a key.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows breaks cannot tell "the constraint works" from
--  "the table rejects everything", and a table that rejects everything
--  passes every refusal in this file.
--
--  ══════════════════════════════════════════════════════════════════
--  WHAT IS PROVED HERE, IN ORDER
--  ══════════════════════════════════════════════════════════════════
--   1  A journal line may carry a cost centre, and two lines of ONE
--      transaction may carry DIFFERENT ones — decision ①. The split
--      electricity bill, posted.
--   2  A journal line may carry NONE, and the un-costed total is
--      recoverable as its own bucket — decision ②.
--   3  🔴 THE TOTALS RECONCILE: the sum over cost centres INCLUDING the
--      un-costed bucket equals the ungrouped P&L, and dropping the
--      NULLs makes it stop reconciling. Section 6 shows both numbers
--      side by side, which is the entire argument of this batch in two
--      rows of output.
--   4  A cost centre from ANOTHER TENANT cannot be put on a journal
--      line, because the foreign key is composite.
--   5  A used cost centre cannot be deleted.
--   6  Two cost centres whose codes differ only in case are refused.
--   7  One budget figure per (period, ledger, cost centre) — including
--      exactly one for the un-costed bucket, which is the case a plain
--      unique index would let through.
--   8  🔴 A BUDGET FOR A CLOSED PERIOD IS REFUSED ON INSERT, ON UPDATE,
--      ON DELETE, AND ON A MOVE OUT OF THE CLOSED PERIOD.
--   9  A negative budget is refused.
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
--  STEP 1 — THE SHAPES, REPRODUCED FROM 0002, 0005 AND 0084
-- =====================================================================
--
--  `ledgers`, `transactions`, `journal_entries` and `financial_periods`
--  are cut down to the columns this drill reasons about. Everything from
--  0084 is copied as it ships.

DROP TABLE IF EXISTS budget_lines, cost_centres, journal_entries,
                     transactions, financial_periods, ledgers,
                     users, tenants CASCADE;
DROP FUNCTION IF EXISTS enforce_budget_period_open() CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP TYPE IF EXISTS account_type, entry_type, transaction_status,
                    period_status CASCADE;

CREATE TABLE tenants (id uuid PRIMARY KEY);
CREATE TABLE users   (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TYPE account_type        AS ENUM ('asset','liability','equity','revenue','expense');
CREATE TYPE entry_type          AS ENUM ('debit','credit');
CREATE TYPE transaction_status  AS ENUM ('pending','posted','reversed','void');
CREATE TYPE period_status       AS ENUM ('open','closed','locked');

CREATE TABLE ledgers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  code         varchar(40) NOT NULL,
  name         varchar(200) NOT NULL,
  account_type account_type NOT NULL,
  deleted_at   timestamptz
);

CREATE TABLE transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  description      text NOT NULL,
  transaction_date date NOT NULL,
  status           transaction_status NOT NULL DEFAULT 'posted'
);

CREATE TABLE journal_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  ledger_id      uuid NOT NULL REFERENCES ledgers(id),
  entry_type     entry_type NOT NULL,
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),
  description    text
);

CREATE TABLE financial_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       varchar(120) NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  status     period_status NOT NULL DEFAULT 'open'
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---- everything below is 0084, verbatim ------------------------------

CREATE TABLE IF NOT EXISTS cost_centres (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code           varchar(40) NOT NULL,
    name           varchar(200) NOT NULL,
    description    text,
    is_active      boolean NOT NULL DEFAULT true,
    display_order  bigint NOT NULL DEFAULT 100,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT cost_centres_code_not_blank CHECK (length(btrim(code)) > 0),
    CONSTRAINT cost_centres_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cost_centres_id_tenant_key
    ON cost_centres (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS cost_centres_code_key
    ON cost_centres (tenant_id, upper(code));
CREATE INDEX IF NOT EXISTS cost_centres_tenant_idx
    ON cost_centres (tenant_id);
CREATE INDEX IF NOT EXISTS cost_centres_active_idx
    ON cost_centres (tenant_id, is_active, display_order);

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS cost_centre_id uuid;

ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_cost_centre_fk;
ALTER TABLE journal_entries
  ADD  CONSTRAINT journal_entries_cost_centre_fk
  FOREIGN KEY (cost_centre_id, tenant_id)
  REFERENCES cost_centres (id, tenant_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS journal_entries_cost_centre_idx
    ON journal_entries (tenant_id, cost_centre_id);

CREATE UNIQUE INDEX IF NOT EXISTS financial_periods_id_tenant_key
    ON financial_periods (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledgers_id_tenant_key
    ON ledgers (id, tenant_id);

CREATE TABLE IF NOT EXISTS budget_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_id       uuid NOT NULL,
    ledger_id       uuid NOT NULL,
    cost_centre_id  uuid,
    amount_minor    bigint NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT budget_lines_amount_non_negative CHECK (amount_minor >= 0),
    CONSTRAINT budget_lines_period_fk
      FOREIGN KEY (period_id, tenant_id)
      REFERENCES financial_periods (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT budget_lines_ledger_fk
      FOREIGN KEY (ledger_id, tenant_id)
      REFERENCES ledgers (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT budget_lines_cost_centre_fk
      FOREIGN KEY (cost_centre_id, tenant_id)
      REFERENCES cost_centres (id, tenant_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_lines_grain_key
    ON budget_lines (tenant_id, period_id, ledger_id, cost_centre_id)
    WHERE cost_centre_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS budget_lines_grain_uncosted_key
    ON budget_lines (tenant_id, period_id, ledger_id)
    WHERE cost_centre_id IS NULL;

CREATE INDEX IF NOT EXISTS budget_lines_tenant_idx
    ON budget_lines (tenant_id);
CREATE INDEX IF NOT EXISTS budget_lines_period_idx
    ON budget_lines (tenant_id, period_id, ledger_id);
CREATE INDEX IF NOT EXISTS budget_lines_cost_centre_idx
    ON budget_lines (tenant_id, cost_centre_id);

DROP TRIGGER IF EXISTS cost_centres_set_updated_at ON cost_centres;
CREATE TRIGGER cost_centres_set_updated_at
  BEFORE UPDATE ON cost_centres
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS budget_lines_set_updated_at ON budget_lines;
CREATE TRIGGER budget_lines_set_updated_at
  BEFORE UPDATE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_budget_period_open()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids    uuid[] := ARRAY[]::uuid[];
  v_id     uuid;
  v_period record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_ids := v_ids || OLD.period_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_ids := v_ids || NEW.period_id;
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    CONTINUE WHEN v_id IS NULL;

    SELECT fp.id, fp.name, fp.status, fp.start_date, fp.end_date
      INTO v_period
      FROM financial_periods fp
     WHERE fp.id = v_id;

    CONTINUE WHEN NOT FOUND;

    IF v_period.status <> 'open' THEN
      RAISE EXCEPTION
        'Cannot % this budget line: accounting period "%" (% to %) is %.',
        lower(TG_OP), v_period.name, v_period.start_date, v_period.end_date,
        v_period.status
        USING ERRCODE = 'check_violation',
              HINT = 'The actuals for a closed period are frozen. A budget that '
                     'can still move is a variance that changes after it has been '
                     'explained. Reopen the period first.';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_lines_period_lock ON budget_lines;
CREATE TRIGGER budget_lines_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_budget_period_open();

-- =====================================================================
--  STEP 2 — TWO TENANTS, A CHART OF ACCOUNTS, TWO DEPARTMENTS
-- =====================================================================

INSERT INTO tenants (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

INSERT INTO ledgers (id, tenant_id, code, name, account_type) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','4000','Sales',       'revenue'),
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','5100','Electricity', 'expense'),
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','2100','Trade payables','liability'),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','4000','Sales',       'revenue');

INSERT INTO cost_centres (id, tenant_id, code, name) VALUES
  ('ccccccc1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','PROD','Production'),
  ('ccccccc1-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','HO',  'Head Office'),
  -- The OTHER tenant's cost centre. Used in section 4.
  ('ccccccc2-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','PROD','Production');

INSERT INTO financial_periods (id, tenant_id, name, start_date, end_date, status) VALUES
  ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','April 2026','2026-04-01','2026-04-30','open'),
  ('dddddddd-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','May 2026',  '2026-05-01','2026-05-31','open');

\echo ''
\echo '====================================================================='
\echo ' POSITIVE 1 — ⭐ ONE INVOICE, TWO DEPARTMENTS, ONE PAYABLE'
\echo '   Decision ①. The electricity bill of Rs 1,20,000 split Rs 80,000'
\echo '   to Production and Rs 40,000 to Head Office. Note that the CREDIT'
\echo '   leg carries no cost centre: a payable belongs to the supplier.'
\echo '   A header dimension cannot record this at all.'
\echo '====================================================================='

INSERT INTO transactions (id, tenant_id, description, transaction_date, status) VALUES
  ('eeeeeeee-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Electricity — April','2026-04-18','posted');

INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, cost_centre_id, description) VALUES
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','debit',   '80000.00','ccccccc1-0000-0000-0000-000000000001','Production share'),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','debit',   '40000.00','ccccccc1-0000-0000-0000-000000000002','Head office share'),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000003','credit','120000.00',NULL,                                  'Supplier');

SELECT cc.code AS cost_centre, je.entry_type, je.amount, je.description
  FROM journal_entries je
  LEFT JOIN cost_centres cc ON cc.id = je.cost_centre_id
 WHERE je.transaction_id = 'eeeeeeee-0000-0000-0000-000000000001'
 ORDER BY je.amount DESC;
-- ⭐ EXPECT: three rows, two different cost centres, one NULL.

\echo ''
\echo '====================================================================='
\echo ' POSITIVE 2 — ⭐ AN UN-COSTED LINE IS ORDINARY, NOT AN ERROR'
\echo '   Decision ②. Sales of Rs 5,00,000 posted with no cost centre —'
\echo '   which is what EVERY line in every workspace looks like until a'
\echo '   posting path starts coding them.'
\echo '====================================================================='

INSERT INTO transactions (id, tenant_id, description, transaction_date, status) VALUES
  ('eeeeeeee-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','April sales','2026-04-20','posted');

INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, cost_centre_id) VALUES
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','credit','500000.00',NULL),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000003','debit', '500000.00',NULL);

\echo ''
\echo '====================================================================='
\echo ' POSITIVE 3 — ⭐ A REVERSAL PAIR. THE STATUS FILTER IS posted AND'
\echo '   reversed, AND "POSTED ONLY" IS THE TRAP.'
\echo '   Rs 90,000 of Production cost posted, then reversed. Both rows'
\echo '   stay in the journal forever. Section 6 shows what each filter'
\echo '   does to the total.'
\echo '====================================================================='

INSERT INTO transactions (id, tenant_id, description, transaction_date, status) VALUES
  ('eeeeeeee-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Miscoded consumable','2026-04-22','reversed'),
  ('eeeeeeee-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Reversal of miscode','2026-04-23','posted'),
  -- A voided transaction: the business says it never happened.
  ('eeeeeeee-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','Voided keying error','2026-04-24','void');

INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, cost_centre_id) VALUES
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','debit', '90000.00','ccccccc1-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000003','credit','90000.00',NULL),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000002','credit','90000.00','ccccccc1-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000003','debit', '90000.00',NULL),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','credit','77000.00',NULL),
  ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000003','debit', '77000.00',NULL);

\echo ''
\echo '====================================================================='
\echo ' REFUSAL 1 — 🔴 ANOTHER TENANT''S COST CENTRE ON A JOURNAL LINE'
\echo '   The composite foreign key (cost_centre_id, tenant_id) is what'
\echo '   refuses this. A plain REFERENCES cost_centres(id) would ACCEPT'
\echo '   it, and RLS would not notice: a policy governs what a session'
\echo '   can SELECT, not what a foreign-key check can find.'
\echo '====================================================================='
DO $$
BEGIN
  INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount, cost_centre_id)
  VALUES ('11111111-1111-1111-1111-111111111111','eeeeeeee-0000-0000-0000-000000000002',
          'aaaaaaaa-0000-0000-0000-000000000002','debit','1.00',
          'ccccccc2-0000-0000-0000-000000000001');
  RAISE EXCEPTION '🔴 DRILL FAILED — a cross-tenant cost centre was accepted onto a journal line.';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE '✅ REFUSED as designed: %', SQLERRM;
END
$$;

\echo ''
\echo '====================================================================='
\echo ' REFUSAL 2 — 🔴 DELETING A COST CENTRE THAT HAS BEEN USED'
\echo '   ON DELETE RESTRICT. CASCADE would delete journal lines from an'
\echo '   append-only ledger; SET NULL would move a department''s whole'
\echo '   history into the un-costed bucket the moment somebody tidied up.'
\echo '====================================================================='
DO $$
BEGIN
  DELETE FROM cost_centres WHERE id = 'ccccccc1-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED — a used cost centre was deleted.';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE '✅ REFUSED as designed: %', SQLERRM;
END
$$;

-- ⭐ THE WRITE THAT MUST STILL WORK: archiving it.
UPDATE cost_centres SET is_active = false
 WHERE id = 'ccccccc1-0000-0000-0000-000000000002';
SELECT code, is_active FROM cost_centres
 WHERE id = 'ccccccc1-0000-0000-0000-000000000002';
-- ⭐ EXPECT: HO, false. Archived, and still nameable on every report.
UPDATE cost_centres SET is_active = true
 WHERE id = 'ccccccc1-0000-0000-0000-000000000002';

\echo ''
\echo '====================================================================='
\echo ' REFUSAL 3 — 🔴 TWO COST CENTRES WHOSE CODES DIFFER ONLY IN CASE'
\echo '   "prod" and "PROD" is one department reported as two, and every'
\echo '   total that groups by code splits without saying that it split.'
\echo '====================================================================='
DO $$
BEGIN
  INSERT INTO cost_centres (tenant_id, code, name)
  VALUES ('11111111-1111-1111-1111-111111111111','prod','Production (duplicate)');
  RAISE EXCEPTION '🔴 DRILL FAILED — a case-variant duplicate code was accepted.';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '✅ REFUSED as designed: %', SQLERRM;
END
$$;

-- ⭐ THE WRITE THAT MUST STILL WORK: the same code in the OTHER tenant.
--    It already exists (seeded above), which is the point: uniqueness is
--    per tenant, not global.
SELECT tenant_id, code FROM cost_centres WHERE upper(code) = 'PROD' ORDER BY tenant_id;
-- ⭐ EXPECT: two rows, one per tenant.

\echo ''
\echo '====================================================================='
\echo ' POSITIVE 4 + REFUSAL 4 — ⭐ ONE BUDGET PER GRAIN, INCLUDING'
\echo '   EXACTLY ONE FOR THE UN-COSTED BUCKET'
\echo '   🔴 THE SECOND HALF IS THE ONE A PLAIN UNIQUE INDEX LETS THROUGH.'
\echo '   Postgres treats NULLs as distinct, so without the partial index'
\echo '   a workspace could hold five un-costed budget rows for one ledger'
\echo '   and the report would show whichever the planner reached first.'
\echo '====================================================================='

INSERT INTO budget_lines (tenant_id, period_id, ledger_id, cost_centre_id, amount_minor) VALUES
  ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','ccccccc1-0000-0000-0000-000000000001', 7000000),
  ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002','ccccccc1-0000-0000-0000-000000000002', 5000000),
  ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',NULL,                                 60000000),
  -- ⭐ ZERO IS A DECISION, NOT AN ABSENCE. "We are spending nothing on
  --    this account in this department." It is accepted.
  ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','ccccccc1-0000-0000-0000-000000000002',        0);

DO $$
BEGIN
  INSERT INTO budget_lines (tenant_id, period_id, ledger_id, cost_centre_id, amount_minor)
  VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000002','ccccccc1-0000-0000-0000-000000000001', 9900000);
  RAISE EXCEPTION '🔴 DRILL FAILED — a duplicate budget line was accepted.';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '✅ REFUSED as designed (costed grain): %', SQLERRM;
END
$$;

DO $$
BEGIN
  INSERT INTO budget_lines (tenant_id, period_id, ledger_id, cost_centre_id, amount_minor)
  VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001', NULL, 12300000);
  RAISE EXCEPTION '🔴 DRILL FAILED — a SECOND un-costed budget line was accepted. This is the NULLS-are-distinct trap.';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '✅ REFUSED as designed (un-costed grain): %', SQLERRM;
END
$$;

\echo ''
\echo '====================================================================='
\echo ' REFUSAL 5 — 🔴 A NEGATIVE BUDGET'
\echo '   A budget has no sign. Whether over is good news comes from the'
\echo '   ledger''s account type, and a minus here would give the report'
\echo '   two ways to say "adverse" that disagree with each other.'
\echo '====================================================================='
DO $$
BEGIN
  INSERT INTO budget_lines (tenant_id, period_id, ledger_id, cost_centre_id, amount_minor)
  VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000002',
          'aaaaaaaa-0000-0000-0000-000000000001', NULL, -100);
  RAISE EXCEPTION '🔴 DRILL FAILED — a negative budget was accepted.';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ REFUSED as designed: %', SQLERRM;
END
$$;

\echo ''
\echo '====================================================================='
\echo ' REFUSAL 6 — 🔴🔴 A BUDGET FOR A CLOSED PERIOD, FOUR WAYS'
\echo '   Decision ④. The actuals for a closed month are frozen by'
\echo '   enforce_period_close; a budget that can still move is a variance'
\echo '   that changes after somebody explained it to a board.'
\echo '====================================================================='

UPDATE financial_periods SET status = 'closed'
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

-- (a) INSERT into a closed period.
DO $$
BEGIN
  INSERT INTO budget_lines (tenant_id, period_id, ledger_id, cost_centre_id, amount_minor)
  VALUES ('11111111-1111-1111-1111-111111111111','dddddddd-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000002', NULL, 100000);
  RAISE EXCEPTION '🔴 DRILL FAILED — a budget was inserted into a closed period.';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ INSERT REFUSED as designed: %', SQLERRM;
END
$$;

-- (b) UPDATE a figure inside a closed period.
DO $$
BEGIN
  UPDATE budget_lines SET amount_minor = 1
   WHERE period_id = 'dddddddd-0000-0000-0000-000000000001'
     AND cost_centre_id = 'ccccccc1-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED — a budget in a closed period was edited.';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ UPDATE REFUSED as designed: %', SQLERRM;
END
$$;

-- (c) DELETE a figure from a closed period. Deleting a budget is exactly
--     as much of a restatement as changing it — the variance goes from a
--     number to "not budgeted".
DO $$
BEGIN
  DELETE FROM budget_lines
   WHERE period_id = 'dddddddd-0000-0000-0000-000000000001'
     AND cost_centre_id = 'ccccccc1-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED — a budget in a closed period was deleted.';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ DELETE REFUSED as designed: %', SQLERRM;
END
$$;

-- (d) 🔴 THE ONE A TRIGGER THAT ONLY LOOKED AT `NEW` WOULD MISS: moving a
--     budget line OUT of a closed period and into an open one. The row
--     ends up somewhere legal, so NEW is fine; what changed is the
--     CLOSED month, which now has one fewer budget than it was reported
--     with.
DO $$
BEGIN
  UPDATE budget_lines SET period_id = 'dddddddd-0000-0000-0000-000000000002'
   WHERE period_id = 'dddddddd-0000-0000-0000-000000000001'
     AND cost_centre_id = 'ccccccc1-0000-0000-0000-000000000001';
  RAISE EXCEPTION '🔴 DRILL FAILED — a budget was moved OUT of a closed period.';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '✅ MOVE-OUT REFUSED as designed: %', SQLERRM;
END
$$;

-- ⭐ THE WRITE THAT MUST STILL WORK: the OPEN period is unaffected.
UPDATE budget_lines SET amount_minor = 4500000
 WHERE period_id = 'dddddddd-0000-0000-0000-000000000002';
SELECT amount_minor FROM budget_lines
 WHERE period_id = 'dddddddd-0000-0000-0000-000000000002';
-- ⭐ EXPECT: 4500000. A closed month is frozen; an open one is not.

UPDATE financial_periods SET status = 'open'
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

\echo ''
\echo '====================================================================='
\echo ' 🔴🔴🔴 SECTION 6 — THE WHOLE ARGUMENT OF THIS BATCH, IN ONE TABLE'
\echo ''
\echo '   Four ways to total the same April journal. Only ONE of them'
\echo '   equals the profit & loss, and the three that do not are each a'
\echo '   plausible query somebody would write.'
\echo '====================================================================='

WITH scoped AS (
  SELECT je.cost_centre_id,
         l.account_type,
         t.status,
         CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END AS signed_amount
    FROM journal_entries je
    JOIN transactions t ON t.id = je.transaction_id
    JOIN ledgers      l ON l.id = je.ledger_id
   WHERE je.tenant_id = '11111111-1111-1111-1111-111111111111'
     AND l.account_type IN ('revenue','expense')
     AND l.deleted_at IS NULL
     AND t.transaction_date BETWEEN '2026-04-01' AND '2026-04-30'
)
SELECT '① P&L — every cost centre INCLUDING un-costed (posted+reversed)' AS method,
       sum(signed_amount) AS net_result,
       '⭐ THE RIGHT ANSWER. This is what the product renders.' AS verdict
  FROM scoped WHERE status IN ('posted','reversed')
UNION ALL
SELECT '② Dropping the un-costed lines (an INNER JOIN to cost_centres)',
       sum(signed_amount),
       '🔴 SHORT. Every figure on the page is individually right.'
  FROM scoped WHERE status IN ('posted','reversed') AND cost_centre_id IS NOT NULL
UNION ALL
SELECT '③ Filtering transactions to `posted` only',
       sum(signed_amount),
       '🔴 KEEPS THE CORRECTION, DROPS THE ERROR. Off by the reversed leg.'
  FROM scoped WHERE status = 'posted'
UNION ALL
SELECT '④ No status filter at all — counts the VOID transaction',
       sum(signed_amount),
       '🔴 Money in the P&L the business says never moved.'
  FROM scoped;

-- ⭐ EXPECT, for the April window seeded above:
--     ① 380000.00   = 500000 sales − 120000 electricity
--                     (the 90000 miscode and its reversal net to zero)
--     ② -120000.00  🔴 the un-costed 500000 of sales has vanished, so the
--                      report shows a LOSS OF 1,20,000 where the business
--                      made a profit of 3,80,000. The sign is flipped and
--                      the magnitude is wrong, from a query that reads
--                      like the obvious one.
--     ③ 470000.00   🔴 the reversal's credit is in, the original debit is
--                      not, so cost is understated by 90000.
--     ④ 457000.00   🔴 77000 of voided revenue counted.
--
--  🔴 NOTE WHAT ② DOES: it is not a small error and it is not a visible
--  one. It flips the sign of the result. Nothing on the page contradicts
--  it, every subtotal foots, and the only way anybody finds out is by
--  adding the departments up by hand and comparing them to the P&L —
--  which is exactly the check `lib/reconciliation/gate.ts` performs
--  before a single figure is rendered.

\echo ''
\echo '====================================================================='
\echo ' SECTION 7 — THE DEPARTMENTAL P&L AS THE PRODUCT RENDERS IT'
\echo '   Note the last row. On the day this ships it carries everything.'
\echo '====================================================================='

SELECT COALESCE(cc.code, '(none)')         AS cost_centre,
       COALESCE(cc.name, 'Not allocated')  AS label,
       sum(CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END) AS net_result,
       count(*)                            AS lines
  FROM journal_entries je
  JOIN transactions t ON t.id = je.transaction_id
  JOIN ledgers      l ON l.id = je.ledger_id
  LEFT JOIN cost_centres cc ON cc.id = je.cost_centre_id
 WHERE je.tenant_id = '11111111-1111-1111-1111-111111111111'
   AND l.account_type IN ('revenue','expense')
   AND l.deleted_at IS NULL
   AND t.status IN ('posted','reversed')
   AND t.transaction_date BETWEEN '2026-04-01' AND '2026-04-30'
 GROUP BY cc.code, cc.name
 ORDER BY (cc.code IS NULL), cc.code;
-- ⭐ EXPECT: HO -40000.00, PROD -80000.00, "Not allocated" 500000.00.
--    Total 380000.00 — equal to ① above, which is the check that makes
--    this screen defensible.

\echo ''
\echo '====================================================================='
\echo ' ✅ DRILL COMPLETE. Every refusal above printed a NOTICE beginning'
\echo '    with a tick, and every paired positive returned rows. If any'
\echo '    line reads "🔴 DRILL FAILED", the constraint it names is not'
\echo '    doing its job and 0084 must not be run against a real database.'
\echo '====================================================================='
