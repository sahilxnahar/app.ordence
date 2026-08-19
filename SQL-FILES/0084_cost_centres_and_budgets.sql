-- =====================================================================
--  ORDENCE — 0084 · COST CENTRES AND BUDGETS
--  Version: v1.47.0-alpha · Batch 68
--
--  ⚠️ RUN AFTER 0083. Two new tables, one new nullable column on
--  `journal_entries`, one trigger. It reads `ledgers`, `transactions`,
--  `journal_entries` and `financial_periods` from 0002/0005 and changes
--  none of their existing columns.
--
--  ⭐ SAFE TO RE-RUN. Every statement is guarded: tables are CREATE ...
--     IF NOT EXISTS, the column is ADD COLUMN IF NOT EXISTS, constraints
--     are DROP ... IF EXISTS then ADD, indexes are CREATE ... IF NOT
--     EXISTS, functions are CREATE OR REPLACE, all inside one
--     transaction.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 RUN THIS **BEFORE** PUSHING THE CODE, AND HERE IS THE REASON
--  ══════════════════════════════════════════════════════════════════
--  The new code SELECTs `journal_entries.cost_centre_id` on the
--  DEPARTMENTAL P&L AND ON THE VARIANCE SCREEN, and SELECTs from
--  `cost_centres` and `budget_lines`. Against a database that has not
--  had this file run, those queries raise 42703 (undefined column) and
--  42P01 (undefined table) respectively, and the accounting section of
--  the product returns an error to every user in the workspace.
--
--  ⭐ AND IT IS INERT ON THE CURRENT BUILD, WHICH IS WHAT MAKES
--  "BEFORE" SAFE RATHER THAN MERELY NECESSARY. Nothing that ships today
--  reads `cost_centres`, `budget_lines`, or the new column. Every
--  existing query on `journal_entries` names its columns explicitly, so
--  an extra nullable one changes no result set anywhere.
--
--  ⚠️ AND THE COLUMN IS ADDED WITHOUT A DEFAULT, ON PURPOSE. `ADD
--  COLUMN ... uuid` with no DEFAULT is a catalogue-only change in
--  PostgreSQL 11 and later: no table rewrite, no long ACCESS EXCLUSIVE
--  lock on the one table in the product that every posting path writes
--  to. A `DEFAULT` — even a constant one — would still be metadata-only
--  on a modern server, but a `NOT NULL` with a backfill would rewrite
--  `journal_entries` in full, and on a workspace with millions of legs
--  that is a lock long enough to take the application down. It must stay
--  nullable for a design reason too, which is decision ② below.
--
--  ⚠️ THE ADD COLUMN DOES NOT FIRE `journal_entries`' APPEND-ONLY
--  TRIGGER. That trigger is FOR EACH ROW on UPDATE and DELETE; DDL is
--  not a row operation. Nothing here rewrites a single existing journal
--  line, and nothing here could — see decision ③.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 WHAT THIS UNBLOCKS, IN ONE PARAGRAPH
--  ══════════════════════════════════════════════════════════════════
--  Ordence can tell a business what it earned and what it spent. It
--  cannot tell it WHERE. A developer running four sites, a firm running
--  three practice areas and a manufacturer running two plants all read
--  one consolidated P&L and then rebuild the split by hand in a
--  spreadsheet every month — which is where the split then lives,
--  disagreeing with the books, unauditable, and owned by whoever built
--  it. This file adds the dimension to the ledger itself, and a budget
--  to measure each division against, so that the departmental view and
--  the statutory view are the same numbers grouped two ways rather than
--  two sets of numbers that have to be reconciled.
--
--  ══════════════════════════════════════════════════════════════════
--  🔴🔴 THE FIVE DECISIONS THIS FILE IS MADE OF
--  ══════════════════════════════════════════════════════════════════
--
--  ① THE COST CENTRE IS ON THE JOURNAL **LINE**, NEVER ON THE
--     TRANSACTION HEADER. This is the decision that cannot be undone.
--     One electricity bill of ₹1,20,000, ₹80,000 to Production and
--     ₹40,000 to Head Office, is ONE invoice, ONE payable and TWO cost
--     centres — and the credit leg belongs to neither of them. A header
--     dimension can record that only by inventing a second invoice the
--     supplier never issued (giving payables two open items for one
--     cheque) or by coding the whole bill to one department. Both
--     produce departmental accounts that look complete and are wrong.
--
--     ⚠️ AND RETROFITTING IT LATER IS NOT "ADD A COLUMN". A year of
--     history coded at header grain has to be re-coded at line grain —
--     and `journal_entries` is append-only (0005 §4), so re-coding is
--     not an UPDATE. It is a reversal and a re-post of every affected
--     transaction, done by somebody who was not there when the invoices
--     were entered.
--
--  ② THE UN-COSTED BUCKET IS A FIRST-CLASS ROW, NOT AN OMISSION.
--     `cost_centre_id` is NULLABLE on the journal line AND on the budget
--     line, and on BOTH it means the same thing: no department. It never
--     means "all departments" and it never means "to be tidied up".
--
--     🔴 THE TWO WAYS THIS FEATURE IS USUALLY BROKEN ARE BOTH SILENT.
--     Dropping the NULLs — an inner join to `cost_centres`, which is
--     what an ORM writes by default — makes the departmental P&L sum to
--     LESS than the P&L by an amount nothing on the page states. Lumping
--     the NULLs into a "General" default makes the total right and puts
--     everybody's uncoded cost on one department, whose manager then
--     disputes their own numbers and is correct to.
--
--     ⚠️ A VARIANCE REPORT WHOSE ACTUALS DO NOT SUM TO THE P&L IS A
--     REPORT NOBODY CAN DEFEND. So NULL is a bucket with a label, both
--     sides of the comparison define it identically, and the application
--     re-computes the total by an independent route and refuses to
--     render ANY figure when the two disagree.
--
--     ⭐ ON THE DAY THIS SHIPS EVERY RUPEE IS IN THAT BUCKET, because no
--     posting path writes the column yet. A design that treated the
--     un-costed bucket as an edge case would ship an empty screen.
--
--  ③ A MIS-CODED LINE IS FIXED BY REVERSAL, NEVER BY AN UPDATE.
--     `journal_entries` is append-only and this column does not change
--     that. Coding the wrong department is a posting error and is
--     corrected the way every posting error is corrected. ⭐ THAT IS A
--     FEATURE: it is what stops last quarter's departmental result
--     changing after somebody explained it to a board.
--
--  ④ A BUDGET PERIOD IS A `financial_periods` ROW. There is no second
--     calendar in this file, and that is two decisions in one.
--
--     • BUDGET AND ACTUAL ARE MEASURED OVER THE SAME WINDOW BY
--       CONSTRUCTION. A budget for "April" running 1–30 April, compared
--       against a financial period running 1 April–2 May because the
--       workspace closes on the first working day, is a variance made of
--       the calendar. Every figure in it is individually right.
--
--     • 🔴 A BUDGET FOR A CLOSED PERIOD MUST NOT BE SILENTLY EDITABLE,
--       and `financial_periods.status` is already the answer to that
--       question for the ledger. The actuals are frozen by
--       `enforce_period_close` (0005 §2); a budget that can still move
--       after the month is closed is a variance that changes after it
--       has been explained — to a board, to a lender, or inside a bonus
--       calculation. §5 below is that rule as a trigger, because a CHECK
--       constraint cannot see another table and a rule that lives only
--       in the application lasts until the first script.
--
--  ⑤ A BUDGET LINE IS PER LEDGER **AND** PER COST CENTRE, AND THE
--     AMOUNT IS UNSIGNED bigint PAISE. "₹40,00,000 for Production this
--     quarter" cannot be varianced, because Production has revenue as
--     well as cost and the two move in opposite directions; netting them
--     reports a department as on budget while its costs are 30% over and
--     its revenue is 30% over too. So the grain carries the ledger, the
--     ledger carries the account type, and the account type is what
--     decides whether over is good news. The sign convention is stated
--     once, in `lib/accounting/budget.ts`: A POSITIVE VARIANCE IS
--     FAVOURABLE, which is `budget − actual` for an expense and
--     `actual − budget` for revenue.
--
--  ══════════════════════════════════════════════════════════════════
--  ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT DO
--  ══════════════════════════════════════════════════════════════════
--  NO HIERARCHY OF COST CENTRES. No `parent_id`. A tree needs a roll-up
--  rule, a cycle check, and an answer to "is a parent's budget the sum
--  of its children or a cap over them" — and those two answers give
--  different variances for the same data. A flat list is honest about
--  what it is; a half-built tree reports a total nobody can trace.
--
--  NO BUDGET VERSIONS. No "original" versus "revised". A revision
--  overwrites and the previous figure survives in `audit_logs`. A
--  `version` column with no rule about which one a report reads gives
--  two people two different variances for the same month.
--
--  NO BALANCE-SHEET BUDGETING. Only revenue and expense ledgers may be
--  budgeted — enforced in the action, because `account_type` lives on
--  another table. Budgeting a bank balance is a cash forecast, and
--  letting one in would break the reconciliation this whole screen
--  rests on.
--
--  NO BACKFILL AND NO SEEDED "GENERAL" COST CENTRE. Seeding one would
--  make the un-costed bucket look allocated on the day it ships, which
--  is exactly the mistake decision ② exists to prevent.
-- =====================================================================

BEGIN;

-- ⚠️ REQUIRED BY §4. Defined by 0005 §5 and repeated here because a file
-- that only works when its neighbours ran first is a file that fails on
-- a fresh database at 2am.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- =====================================================================
--  ① COST CENTRES — THE DIMENSION
-- =====================================================================
--
--  ⚠️ THIS IS NOT `projects`. A construction project has a contract, a
--  BOQ, a site and a completion date, and `server/actions/cost-control.ts`
--  already reports against it. A cost centre is a REPORTING dimension
--  that need not correspond to anything physical — "Head Office", "South
--  Region", "Legacy Products" — and a business commonly wants both at
--  once. Forcing one to be the other lets a business with three projects
--  and two departments report on exactly one of those facts.
--
--  🔴 THERE IS NO `deleted_at` AND ITS ABSENCE IS THE DESIGN. A cost
--  centre that has been used is referenced by append-only journal lines
--  that can never be re-coded. Deleting the row — even softly — turns
--  every one of those lines into a bucket with no name, and last year's
--  departmental P&L grows a column headed by a UUID. `is_active` is what
--  "we do not use that department any more" means: gone from the picker,
--  still on the reports.
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

    --  A blank code sorts and groups as a distinct, invisible bucket
    --  that looks exactly like the un-costed one on every report.
    CONSTRAINT cost_centres_code_not_blank CHECK (length(btrim(code)) > 0),
    CONSTRAINT cost_centres_name_not_blank CHECK (length(btrim(name)) > 0)
);

--  ⭐ THE COMPOSITE KEY EXISTS SO ANOTHER TABLE CAN REFERENCE
--  (id, tenant_id) TOGETHER. See §2 — a plain foreign key on `id` alone
--  lets one tenant's journal line point at another tenant's cost centre.
--  RLS hides that row on READ and does nothing whatsoever about the
--  WRITE, because the foreign-key check runs as the system.
CREATE UNIQUE INDEX IF NOT EXISTS cost_centres_id_tenant_key
    ON cost_centres (id, tenant_id);

--  🔴 CASE-INSENSITIVE. "prod" and "PROD" as two cost centres is one
--  department reported as two, and every total that groups by code
--  splits without saying that it split.
CREATE UNIQUE INDEX IF NOT EXISTS cost_centres_code_key
    ON cost_centres (tenant_id, upper(code));

CREATE INDEX IF NOT EXISTS cost_centres_tenant_idx
    ON cost_centres (tenant_id);
CREATE INDEX IF NOT EXISTS cost_centres_active_idx
    ON cost_centres (tenant_id, is_active, display_order);

-- =====================================================================
--  ② THE DIMENSION ON THE JOURNAL **LINE**
-- =====================================================================
--
--  🔴🔴 DECISION ①. ON `journal_entries`, NOT ON `transactions`. Read the
--  header before moving it.
--
--  ⚠️ NULLABLE, AND NULL IS A NAMED BUCKET RATHER THAN MISSING DATA —
--  decision ②. The credit leg of a purchase invoice belongs to the
--  supplier and to no department; forcing a value would make somebody
--  invent one.
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS cost_centre_id uuid;

--  🔴🔴 THE FOREIGN KEY IS COMPOSITE, AND THE SECOND COLUMN IS THE WHOLE
--  POINT.
--
--  `REFERENCES cost_centres(id)` would be satisfied by ANY tenant's cost
--  centre. Row-level security governs what a session can SELECT; it does
--  not govern what a foreign-key check can find, because that check runs
--  with the system's own visibility. So a bug — or a crafted request —
--  that writes another workspace's cost-centre id onto a journal line
--  would be accepted by the database, and the row would then be
--  invisible to the tenant that owns the line and unnameable on their
--  own report.
--
--  ⭐ AND `MATCH SIMPLE` (the default) IS EXACTLY WHAT DECISION ② NEEDS:
--  when ANY column of a composite key is NULL the constraint is not
--  checked at all. `tenant_id` is NOT NULL, so the only way to get a
--  NULL in the pair is an un-costed line — which is precisely the case
--  that must be allowed.
--
--  ⚠️ ON DELETE RESTRICT, NOT CASCADE AND NOT SET NULL. CASCADE would
--  delete journal lines, which is unthinkable on an append-only ledger.
--  SET NULL would silently move a department's entire history into the
--  un-costed bucket the moment somebody tidied up the cost centre list.
ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_cost_centre_fk;
ALTER TABLE journal_entries
  ADD  CONSTRAINT journal_entries_cost_centre_fk
  FOREIGN KEY (cost_centre_id, tenant_id)
  REFERENCES cost_centres (id, tenant_id)
  ON DELETE RESTRICT;

--  ⭐ THE DEPARTMENTAL P&L QUERY. Grouping the whole journal by cost
--  centre over a date window without this is a sequential scan of every
--  line the tenant has ever posted, on a screen somebody opens once a
--  month and then waits for.
CREATE INDEX IF NOT EXISTS journal_entries_cost_centre_idx
    ON journal_entries (tenant_id, cost_centre_id);

-- =====================================================================
--  ③ THE COMPOSITE KEYS THE BUDGET TABLE NEEDS ON ITS PARENTS
-- =====================================================================
--
--  ⚠️ TWO REDUNDANT-LOOKING UNIQUE INDEXES ON TABLES THIS FILE DOES NOT
--  OWN, AND THEY ARE HERE FOR ONE REASON ONLY.
--
--  PostgreSQL requires a foreign key's TARGET columns to be covered by a
--  unique constraint or index. `(id, tenant_id)` on a table whose `id`
--  is already the primary key is trivially unique — it adds no rule that
--  was not already true, and it changes no existing behaviour. What it
--  adds is the ability to write `FOREIGN KEY (period_id, tenant_id)`
--  below, which is what stops a budget line in one workspace pointing at
--  another workspace's accounting period or chart of accounts.
--
--  🔴 THE ALTERNATIVE WAS A PLAIN SINGLE-COLUMN FOREIGN KEY PLUS A
--  COMMENT SAYING "THE APPLICATION CHECKS THE TENANT". RLS is the SOLE
--  tenant boundary in this product on READ; on a WRITE, a foreign key
--  that does not name the tenant is a hole that no policy closes.
CREATE UNIQUE INDEX IF NOT EXISTS financial_periods_id_tenant_key
    ON financial_periods (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledgers_id_tenant_key
    ON ledgers (id, tenant_id);

-- =====================================================================
--  ④ BUDGET LINES — ONE NUMBER PER PERIOD PER LEDGER PER COST CENTRE
-- =====================================================================
--
--  🔴 `amount_minor` IS bigint PAISE, UNSIGNED, AND NOT `numeric`.
--  Money is integer minor units everywhere in this product; a budget is
--  money. It is unsigned because the direction comes from the ledger's
--  account type and never from a sign — one way to express a thing is
--  one way to get it wrong.
--
--  🔴 ZERO IS LEGAL AND IS NOT THE SAME FACT AS NO ROW. Zero means "we
--  decided to spend nothing on this". No row means "nobody has looked".
--  ₹40,000 of actual against a zero budget is an overspend somebody has
--  to explain; ₹40,000 of actual against NO budget is an unbudgeted cost
--  that must not be rendered as a 100%-over-budget crisis, because
--  rendering it that way makes the whole screen red on day one and a
--  screen that is red everywhere is a screen nobody opens twice.
CREATE TABLE IF NOT EXISTS budget_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    --  ⭐ DECISION ④ — the SAME period row the ledger lock reads.
    period_id       uuid NOT NULL,
    ledger_id       uuid NOT NULL,

    --  🔴 NULL IS THE UN-COSTED BUCKET, IDENTICALLY TO THE JOURNAL LINE.
    --  It is not "all cost centres" and it is not "unallocated headroom".
    --  Because NULL means the same thing on both sides of the
    --  subtraction, the buckets line up one-for-one and the totals
    --  reconcile by construction rather than by discipline.
    cost_centre_id  uuid,

    amount_minor    bigint NOT NULL,
    note            text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT budget_lines_amount_non_negative CHECK (amount_minor >= 0),

    --  ⚠️ COMPOSITE, FOR THE REASON GIVEN IN §3. ON DELETE RESTRICT on
    --  the period, because deleting a period that carries a budget would
    --  leave a figure nobody can date. RESTRICT on the ledger for the
    --  same reason, and RESTRICT on the cost centre so that archiving is
    --  the only way a department leaves the picker.
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

--  🔴🔴 THE GRAIN, AS TWO PARTIAL UNIQUE INDEXES.
--
--  ⚠️ POSTGRES TREATS NULLS AS DISTINCT IN A UNIQUE INDEX BY DEFAULT, so
--  one four-column index would let a workspace hold five separate
--  un-costed budget rows for the same ledger and period — all of them
--  legal, and the report showing whichever one the planner reached
--  first. A budget that changes when the query plan does.
--
--  ⭐ `NULLS NOT DISTINCT` (PG15+) would say the same thing in one
--  index. Two partial indexes are used instead because Drizzle cannot
--  express `NULLS NOT DISTINCT` at the version this repo pins, and a
--  constraint that exists only here is a constraint `drizzle-kit push`
--  does not know about and can drop. The pair is written identically in
--  `db/schema/budgets.ts`, so the two files stay the same thing.
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

-- =====================================================================
--  ⑤ A BUDGET FOR A CLOSED PERIOD IS FROZEN — DECISION ④, AS A TRIGGER
-- =====================================================================
--
--  🔴 WHY THIS IS NOT A CHECK CONSTRAINT: a CHECK cannot read another
--  table, and "is this period open" lives in `financial_periods`.
--
--  🔴 WHY IT IS NOT LEFT TO THE APPLICATION: `server/actions/budgets.ts`
--  refuses the edit and says why, in a sentence somebody can act on, and
--  that refusal lasts exactly until the first background job, the first
--  data-fix script, and the first future service written by somebody who
--  never read this file. The application check is for the human. This
--  one is the guarantee.
--
--  ⚠️ BOTH SIDES OF AN UPDATE ARE CHECKED. Moving a budget line OUT of a
--  closed period is exactly as much of a restatement as changing one
--  inside it, and a trigger that looked only at NEW would allow it.
--
--  ⭐ IT MIRRORS `enforce_period_close` (0005 §2) DELIBERATELY, DOWN TO
--  THE HINT. The actuals for a closed month are frozen; the budget they
--  are measured against has to be frozen by the same event, or the
--  comparison is only half locked and a variance can be made to
--  disappear after it was explained.
CREATE OR REPLACE FUNCTION enforce_budget_period_open()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids    uuid[] := ARRAY[]::uuid[];
  v_id     uuid;
  v_period record;
BEGIN
  --  ⚠️ `OLD` AND `NEW` ARE READ ONLY UNDER A `TG_OP` GUARD, AND NEVER
  --  THROUGH `COALESCE(NEW, OLD)`. `OLD` is not assigned during an
  --  INSERT and `NEW` is not assigned during a DELETE; a `COALESCE` over
  --  both evaluates both arguments, so the tidy-looking version is the
  --  one that raises "record old is not assigned yet" on the first
  --  insert. The guarded form is longer and is correct in all three
  --  operations.
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

    -- No period row means no rule to apply. The foreign key already
    -- refuses a budget line pointing at a period that does not exist.
    CONTINUE WHEN NOT FOUND;

    IF v_period.status <> 'open' THEN
      RAISE EXCEPTION
        'Cannot % this budget line: accounting period "%" (% to %) is %.',
        lower(TG_OP), v_period.name, v_period.start_date, v_period.end_date,
        v_period.status
        USING ERRCODE = 'check_violation',
              HINT = 'The actuals for a closed period are frozen. A budget that '
                     'can still move is a variance that changes after it has been '
                     'explained. Reopen the period first — that requires the '
                     'periods:reopen permission and is fully audited.';
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
--  ⑥ ROW LEVEL SECURITY
-- =====================================================================
--
--  🔴 A COST CENTRE LIST IS A COMPANY'S ORGANISATION CHART AND A BUDGET
--  IS ITS PLAN. One tenant reading another's is a competitor reading
--  what the business intends to spend on each part of itself, next
--  quarter, by department — which is more commercially sensitive than
--  the actuals it will eventually publish.
--
--  ⭐ `app_platform_scope()` GOES IN `USING` AND NEVER IN `WITH CHECK`,
--  the house rule the whole schema follows and that 0014 fails a deploy
--  over: platform staff may READ across tenants to answer a support
--  question, and may never WRITE a row into a workspace that is not the
--  session's.
--
--  ⚠️ FORCE, NOT JUST ENABLE. This application connects as the table
--  owner, and an owner without FORCE bypasses every policy — which is
--  precisely what `check:rls-writes` was built after finding.
--
--  ⚠️ `journal_entries` ALREADY HAS ITS POLICY (0001) AND IS NOT TOUCHED
--  HERE. Adding a column does not change a table's RLS, and re-issuing
--  its policy from this file would put two migrations in charge of one
--  boundary.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_centres', 'budget_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (tenant_id = app_current_tenant_id() OR app_platform_scope()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_isolation', t
    );
  END LOOP;
END
$$;

-- =====================================================================
--  ⑦ THE TABLE COMMENTS, FOR WHOEVER OPENS THIS IN A CLIENT
-- =====================================================================

COMMENT ON COLUMN journal_entries.cost_centre_id IS
  '🔴 THE DIMENSION IS ON THE LINE, NOT ON THE TRANSACTION. One invoice '
  'split across two departments is one document with two coded legs, and '
  'a header dimension cannot express it. NULL is the un-costed bucket — '
  'a named row on every report with its own subtotal — and never '
  '"missing data". This table is append-only, so a mis-coded line is '
  'corrected by a reversal and a re-post, never by an UPDATE.';

COMMENT ON TABLE cost_centres IS
  'A reporting dimension over the ledger: department, branch, product '
  'line. NOT `projects`, which is a physical thing with a contract and a '
  'BOQ — a business commonly wants both. 🔴 THERE IS NO deleted_at: a '
  'used cost centre is referenced by append-only journal lines that can '
  'never be re-coded, so deleting it would head last year''s '
  'departmental P&L with a UUID. Archive with is_active instead.';

COMMENT ON COLUMN cost_centres.code IS
  'Unique per tenant, case-insensitively. "prod" and "PROD" as two cost '
  'centres is one department reported as two, and every total that '
  'groups by code splits without saying that it split.';

COMMENT ON TABLE budget_lines IS
  'One budgeted figure per accounting period per ledger per cost centre. '
  '🔴 THE PERIOD IS A financial_periods ROW — the same row the ledger '
  'lock reads — so budget and actual are measured over one window by '
  'construction, and closing the month freezes both. ⭐ ZERO IS A '
  'DECISION ("we are spending nothing on this"); NO ROW means nobody has '
  'looked, and the report renders the two differently.';

COMMENT ON COLUMN budget_lines.cost_centre_id IS
  'NULL is the un-costed bucket, identically to journal_entries. It is '
  'NOT "all cost centres". Because NULL means the same thing on both '
  'sides of the subtraction, the buckets line up one-for-one and budget '
  'versus actual reconciles to the profit & loss.';

COMMENT ON COLUMN budget_lines.amount_minor IS
  'Integer paise, unsigned. The direction comes from the ledger''s '
  'account type: a positive variance is FAVOURABLE, which is '
  '(budget - actual) for an expense and (actual - budget) for revenue. '
  'Over-spend and under-achievement are both bad news with opposite '
  'arithmetic. See lib/accounting/budget.ts.';

COMMIT;

-- =====================================================================
--  ⭐ WHAT COMES NEXT, STATED SO IT IS NOT MISTAKEN FOR AN OVERSIGHT
-- =====================================================================
--
--  🔴 NOTHING IN THE PRODUCT WRITES `journal_entries.cost_centre_id`
--  YET. `postTransaction` in `server/actions/accounting.ts` does not
--  accept one, and neither does any automated posting path — sales
--  invoices, purchases, payroll, RA bills. Until one of them does, every
--  line in every workspace sits in the un-costed bucket and the
--  departmental P&L shows one row called "Not allocated" carrying the
--  whole result.
--
--  ⚠️ THAT IS THE CORRECT BEHAVIOUR FOR THIS BATCH AND IT IS WHY
--  DECISION ② IS DECISION ②. The report is honest, it reconciles to the
--  P&L to the paisa on day one, and the moment a posting path starts
--  coding lines the numbers move out of the bucket without a backfill
--  and without a migration.
--
--  ⚠️ AND THE WRITE PATH IS DELIBERATELY NOT IN THIS BATCH. It touches
--  `postTransactionSchema`, `postTransaction` and the journal form —
--  the one code path every financial document in the product goes
--  through — and two batches editing that path in one release is how a
--  ledger gets written by two half-merged branches.
-- =====================================================================
