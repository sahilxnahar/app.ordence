-- =====================================================================
--  Ordence · VERIFY 0084 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
--
--  🔴 WHAT THIS PROVES AND WHAT IT CANNOT.
--
--  It proves the SHAPE: the two new tables exist and are tenant-scoped
--  with RLS enabled AND forced and a policy on each; the journal carries
--  a NULLABLE cost-centre column whose foreign key is COMPOSITE so it
--  cannot reach another tenant; the budget grain is unique on both
--  halves — including the un-costed half, which is the one Postgres
--  leaves open by default; and the closed-period trigger is attached for
--  all three of INSERT, UPDATE and DELETE.
--
--  ⚠️ IT CANNOT PROVE THAT THE VARIANCE ARITHMETIC IS RIGHT. The sign
--  convention lives in `lib/accounting/budget.ts` and is proved by
--  `tests/ui/cost-centres-and-budgets.test.ts`. Reimplementing it here
--  in SQL would give the product two variance engines that must agree
--  forever, and the first time they drift every department's result is
--  reported as wrong by whichever one was not updated. Section 6 does
--  the honest half instead: it computes the SAME total four ways and
--  prints all four, so a human can see which three are traps.
--
--  ⚠️ AND IT CANNOT PROVE COMPLETENESS. Nothing here can show that a
--  cost that SHOULD have been coded to a department ever was. Section 7
--  is about that, and it is the section to read before quoting any of
--  the others at anybody.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. 🔴 THE TENANT BOUNDARY. THREE SEPARATE THINGS, REPORTED
--     SEPARATELY, BECAUSE THEY FAIL IN OPPOSITE DIRECTIONS.
--
--     `rls_enabled` false  → every tenant reads every other tenant's
--                            budget — next quarter's plan, by department.
--     `rls_forced`  false  → RLS is on and the table OWNER ignores it,
--                            and this application connects as the owner.
--     `policies` = 0       → RLS is on with no policy, which denies
--                            everybody: the table is not protected, it is
--                            unusable.
--
--     ⭐ A single "protected" boolean would hide which of the three you
--     have, and the remedy is different for each.
-- ---------------------------------------------------------------------
SELECT c.relname                                        AS table_name,
       c.relrowsecurity                                 AS rls_enabled,
       c.relforcerowsecurity                            AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                  AND a.attnotnull AND NOT a.attisdropped)         AS tenant_id_not_null
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('cost_centres', 'budget_lines')
 ORDER BY c.relname;
-- ⭐ EXPECT: two rows; rls_enabled, rls_forced and tenant_id_not_null all
--    true; policies >= 1 on each. Fewer than two rows means 0084 has not
--    been run.


-- ---------------------------------------------------------------------
--  2. 🔴🔴 DECISION ① — THE DIMENSION IS ON THE **LINE**, VERIFIED BOTH
--     BY PRESENCE AND BY ABSENCE.
--
--     `journal_entries.cost_centre_id` must exist and must be NULLABLE.
--     `transactions.cost_centre_id` must NOT exist — a header dimension
--     cannot record one invoice split across two departments, and if one
--     ever appears the two grains will disagree with each other about
--     what a department cost.
--
--     ⚠️ THE NULLABILITY IS NOT A CONVENIENCE. Decision ②: NULL is the
--     un-costed bucket, and a NOT NULL here would force somebody to
--     invent a department for the supplier's credit leg.
-- ---------------------------------------------------------------------
SELECT 'journal_entries.cost_centre_id' AS what,
       CASE
         WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'journal_entries'
                             AND column_name = 'cost_centre_id')
           THEN '🔴 MISSING — 0084 has not been run. Every cost centre screen raises 42703.'
         WHEN (SELECT is_nullable FROM information_schema.columns
                WHERE table_name = 'journal_entries'
                  AND column_name = 'cost_centre_id') <> 'YES'
           THEN '🔴 NOT NULL — the un-costed bucket cannot exist and the credit leg of every purchase invoice needs an invented department.'
         ELSE '✅ Present and nullable. The line carries the dimension; NULL is the un-costed bucket.'
       END AS verdict
UNION ALL
SELECT 'transactions.cost_centre_id (must NOT exist)',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name = 'transactions'
                            AND column_name = 'cost_centre_id')
            THEN '🔴 A HEADER DIMENSION HAS APPEARED. Read decision ① of 0084 before keeping it: two grains give two answers for one invoice.'
            ELSE '✅ No header dimension. The grain is the journal line and only the journal line.'
       END;


-- ---------------------------------------------------------------------
--  3. 🔴 THE FOREIGN KEYS ARE COMPOSITE, WHICH IS THE ONLY THING THAT
--     STOPS A CROSS-TENANT REFERENCE ON A WRITE.
--
--     RLS governs what a session may SELECT. A foreign-key check runs
--     with the system's own visibility, so `REFERENCES cost_centres(id)`
--     is satisfied by ANY tenant's row and no policy notices. The second
--     column is what makes the constraint tenant-aware.
--
--     ⭐ `nkeys = 2` IS THE WHOLE ASSERTION. Read the `definition`
--     column to see which pair.
-- ---------------------------------------------------------------------
SELECT con.conname                                   AS constraint_name,
       rel.relname                                   AS on_table,
       array_length(con.conkey, 1)                   AS nkeys,
       pg_get_constraintdef(con.oid)                 AS definition,
       CASE WHEN array_length(con.conkey, 1) >= 2
            THEN '✅ Composite — carries tenant_id.'
            ELSE '🔴 SINGLE COLUMN — another tenant''s row satisfies this. RLS does not close it.'
       END                                           AS verdict
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
 WHERE con.contype = 'f'
   AND con.conname IN ('journal_entries_cost_centre_fk',
                       'budget_lines_period_fk',
                       'budget_lines_ledger_fk',
                       'budget_lines_cost_centre_fk')
 ORDER BY con.conname;
-- ⭐ EXPECT: four rows, every one with nkeys = 2 and ON DELETE RESTRICT.
--    RESTRICT matters: CASCADE would delete journal lines from an
--    append-only ledger, and SET NULL would silently move a department's
--    entire history into the un-costed bucket.


-- ---------------------------------------------------------------------
--  4. 🔴🔴 THE BUDGET GRAIN, INCLUDING THE HALF POSTGRES LEAVES OPEN.
--
--     ⚠️ NULLS ARE DISTINCT IN A UNIQUE INDEX BY DEFAULT. A single
--     four-column index therefore permits any number of UN-COSTED budget
--     rows for one period and ledger — all legal, and the report shows
--     whichever one the planner reaches first. A budget that changes
--     when the query plan does is a budget nobody can be held to.
--
--     Two partial indexes are the equivalent of `NULLS NOT DISTINCT` and
--     can be expressed in `db/schema/budgets.ts` as well, which is why
--     they are the form used.
-- ---------------------------------------------------------------------
SELECT i.relname                       AS index_name,
       pg_get_indexdef(i.oid)          AS definition
  FROM pg_class i
  JOIN pg_index x  ON x.indexrelid = i.oid
  JOIN pg_class t  ON t.oid = x.indrelid
 WHERE t.relname = 'budget_lines'
   AND i.relname IN ('budget_lines_grain_key', 'budget_lines_grain_uncosted_key')
 ORDER BY i.relname;
-- ⭐ EXPECT: exactly two rows. `budget_lines_grain_key` WHERE
--    cost_centre_id IS NOT NULL, and `budget_lines_grain_uncosted_key`
--    on (tenant_id, period_id, ledger_id) WHERE cost_centre_id IS NULL.
--    One row is worse than none: it means the costed half is guarded and
--    the un-costed half is not.

--  And the duplicates, if any got in before the index did.
SELECT tenant_id, period_id, ledger_id, count(*) AS uncosted_rows
  FROM budget_lines
 WHERE cost_centre_id IS NULL
 GROUP BY tenant_id, period_id, ledger_id
HAVING count(*) > 1;
-- ⭐ EXPECT: zero rows. Any row here is a period whose un-costed budget
--    figure is ambiguous.


-- ---------------------------------------------------------------------
--  5. 🔴🔴 DECISION ④ — A CLOSED PERIOD'S BUDGET IS FROZEN.
--
--     The trigger must be attached for INSERT, UPDATE **and** DELETE.
--     Deleting a budget line is exactly as much of a restatement as
--     editing one: the variance goes from a number somebody explained to
--     "not budgeted". And an UPDATE that MOVES a line out of the closed
--     period is the case a trigger that only inspected NEW would allow —
--     the row lands somewhere legal, and the closed month quietly has
--     one fewer budget than it was reported with.
-- ---------------------------------------------------------------------
SELECT tg.tgname                                       AS trigger_name,
       (tg.tgtype & 4)  <> 0                           AS fires_on_insert,
       (tg.tgtype & 16) <> 0                           AS fires_on_update,
       (tg.tgtype & 8)  <> 0                           AS fires_on_delete,
       (tg.tgtype & 2)  <> 0                           AS fires_before,
       (tg.tgtype & 1)  <> 0                           AS fires_per_row
  FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
 WHERE c.relname = 'budget_lines'
   AND NOT tg.tgisinternal
 ORDER BY tg.tgname;
-- ⭐ EXPECT: `budget_lines_period_lock` with insert, update, delete,
--    before and per-row all true. A missing DELETE is the quiet one.

--  🔴 AND THE DATA ITSELF: any budget line sitting in a period that is
--  no longer open. Rows here are not necessarily wrong — a period is
--  budgeted while open and then closed, which is the normal life of
--  every line — but a row here that somebody is still EDITING is the
--  condition the trigger exists to make impossible.
SELECT fp.status,
       count(*) AS budget_lines,
       CASE WHEN fp.status = 'open'
            THEN '✅ Editable.'
            ELSE '⭐ Frozen. Reopening the period is the only way to change these, and that is audited.'
       END AS note
  FROM budget_lines bl
  JOIN financial_periods fp ON fp.id = bl.period_id
 GROUP BY fp.status
 ORDER BY fp.status;


-- ---------------------------------------------------------------------
--  6. 🔴🔴🔴 THE WHOLE ARGUMENT OF THIS BATCH, AGAINST REAL DATA.
--
--     Four ways to total one tenant's revenue and expense over the
--     current financial year to date. Only ONE of them is the profit &
--     loss, and each of the other three is a query somebody would
--     plausibly write.
--
--     ⚠️ READ ② FIRST. Dropping the un-costed lines is what an inner
--     join to `cost_centres` does, it is what an ORM writes by default,
--     and on a workspace where nothing has been coded yet it reports the
--     business as having earned and spent NOTHING.
--
--     ⚠️ AND ③. "Posted only" is the obvious status filter and it keeps
--     every correction while dropping everything corrected —
--     `reverseTransaction` writes the mirror as a new `posted` row and
--     marks the original `reversed`.
--
--     ⭐ Substitute the tenant id and the dates. It is deliberately not
--     parameterised: pasting a tenant id is a moment where somebody
--     looks at which workspace they are about to quote figures for.
-- ---------------------------------------------------------------------
WITH scoped AS (
  SELECT je.cost_centre_id,
         t.status,
         CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END AS signed_amount
    FROM journal_entries je
    JOIN transactions t ON t.id = je.transaction_id AND t.tenant_id = je.tenant_id
    JOIN ledgers      l ON l.id = je.ledger_id      AND l.tenant_id = je.tenant_id
   WHERE je.tenant_id = '00000000-0000-0000-0000-000000000000'  -- ⬅ SET THIS
     AND l.account_type IN ('revenue', 'expense')
     AND l.deleted_at IS NULL
     AND t.transaction_date BETWEEN '2026-04-01' AND '2027-03-31'  -- ⬅ AND THESE
)
SELECT '① every cost centre INCLUDING un-costed, posted+reversed' AS method,
       COALESCE(sum(signed_amount), 0) AS net_result,
       '⭐ THE PROFIT & LOSS. This is the figure the product renders and reconciles against.' AS verdict
  FROM scoped WHERE status IN ('posted', 'reversed')
UNION ALL
SELECT '② un-costed lines dropped (an INNER JOIN to cost_centres)',
       COALESCE(sum(signed_amount), 0),
       '🔴 SHORT BY THE UN-COSTED BUCKET. Every figure on the page is individually right.'
  FROM scoped WHERE status IN ('posted', 'reversed') AND cost_centre_id IS NOT NULL
UNION ALL
SELECT '③ transactions filtered to `posted` only',
       COALESCE(sum(signed_amount), 0),
       '🔴 KEEPS EVERY CORRECTION, DROPS EVERYTHING CORRECTED.'
  FROM scoped WHERE status = 'posted'
UNION ALL
SELECT '④ no status filter at all',
       COALESCE(sum(signed_amount), 0),
       '🔴 COUNTS VOIDED TRANSACTIONS — money the business says never moved.'
  FROM scoped;
-- ⭐ EXPECT: ① is the P&L. ②, ③ and ④ differ from it by exactly the
--    un-costed bucket, the reversal pairs and the voided transactions
--    respectively. If ② equals ① the workspace has coded everything,
--    which almost never happens; if ② is zero, nothing has been coded at
--    all, which is the state on the day 0084 is run.


-- ---------------------------------------------------------------------
--  7. ⚠️ THE HONEST SECTION — HOW MUCH OF THE LEDGER IS ACTUALLY CODED.
--
--     🔴 NO SHAPE CHECK CAN ANSWER THIS AND IT IS THE ONLY NUMBER THAT
--     DECIDES WHETHER THE DEPARTMENTAL REPORT IS WORTH READING. A
--     workspace where 4% of lines carry a cost centre has a variance
--     report that is arithmetically perfect, reconciles to the P&L to
--     the paisa, and describes almost nothing.
--
--     ⭐ WHICH IS WHY THE UN-COSTED BUCKET IS ON THE SCREEN RATHER THAN
--     IN THIS FILE. A coverage figure that only an operator can run is a
--     coverage figure the customer never sees.
-- ---------------------------------------------------------------------
SELECT je.tenant_id,
       count(*)                                            AS pl_lines,
       count(*) FILTER (WHERE je.cost_centre_id IS NOT NULL) AS coded_lines,
       count(*) FILTER (WHERE je.cost_centre_id IS NULL)     AS uncoded_lines,
       CASE
         WHEN count(*) = 0 THEN 'No revenue or expense lines at all.'
         WHEN count(*) FILTER (WHERE je.cost_centre_id IS NOT NULL) = 0
           THEN '⭐ EXPECTED IMMEDIATELY AFTER 0084: nothing writes the column yet, so the whole result sits in "Not allocated". The report is correct and it is not yet useful.'
         ELSE '⭐ Partially coded. The "Not allocated" bucket on screen carries the remainder and the totals still reconcile.'
       END AS verdict
  FROM journal_entries je
  JOIN ledgers l ON l.id = je.ledger_id AND l.tenant_id = je.tenant_id
 WHERE l.account_type IN ('revenue', 'expense')
 GROUP BY je.tenant_id
 ORDER BY pl_lines DESC
 LIMIT 25;


-- ---------------------------------------------------------------------
--  8. ⚠️ THE COST CENTRE LIST ITSELF — AND THE ONE THING TO LOOK FOR.
--
--     🔴 A COST CENTRE THAT IS ARCHIVED AND STILL REFERENCED IS NORMAL
--     AND CORRECT: last year's costs keep their department name. A cost
--     centre that has NEVER been referenced and is INACTIVE is somebody
--     who set the list up and abandoned it, which is worth knowing
--     before quoting a departmental report at anybody.
-- ---------------------------------------------------------------------
SELECT cc.tenant_id,
       cc.code,
       cc.name,
       cc.is_active,
       (SELECT count(*) FROM journal_entries je WHERE je.cost_centre_id = cc.id) AS journal_lines,
       (SELECT count(*) FROM budget_lines bl   WHERE bl.cost_centre_id = cc.id) AS budget_lines
  FROM cost_centres cc
 ORDER BY cc.tenant_id, cc.code
 LIMIT 100;
-- ⭐ EXPECT: whatever the tenant set up. A row with journal_lines > 0 and
--    is_active = false is an archived department carrying real history —
--    which is exactly why this table has no `deleted_at`.
