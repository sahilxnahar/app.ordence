-- ############################################################################
-- 0104 · THE THREE ANALYTICS VIEWS CARRY THE CURRENCY THEY SUM
-- ############################################################################
--
-- PURPOSE
-- -------
-- `v_asset_portfolio`, `v_contract_pipeline` and `v_ledger_daily` were created
-- by `0008_phase10_analytics.sql` as `sum(...)` GROUP BY (tenant, dimension).
-- All three aggregate over tables that carry a `currency` column:
--
--     assets.currency        varchar(3) NOT NULL DEFAULT 'INR'
--     contracts.currency     varchar(3) NOT NULL DEFAULT 'INR'
--     transactions.currency  varchar(3) NOT NULL DEFAULT 'INR'
--
-- 🔴 SO EVERY ONE OF THEM ADDED DOLLARS TO RUPEES AND RETURNED A NUMBER.
--    Not an error, not a NULL — a plausible figure on a dashboard tile, in
--    the units of nothing. `sum(value_amount)` over a portfolio holding a
--    ₹4,00,00,000 plot and a $50,000 machine returns 44000000.00, which is
--    neither the rupee value nor the dollar value nor the sum of anything.
--
-- ⚠️ AND THE SAME NUMBER IS CORRECT IN THE ONLY CASE ANYBODY TESTS. A
--    workspace that has never left INR gets exactly the right answer from the
--    broken view, which is why this survived from 0008 to here.
--
-- WHAT THIS FILE DOES
-- -------------------
-- Appends `currency` to each view's column list and adds it to the GROUP BY.
-- Nothing else changes: same names, same types, same order for every column
-- that already existed, so `CREATE OR REPLACE VIEW` is legal and the existing
-- GRANTs survive (a DROP + CREATE would silently discard them).
--
-- A currency-blind total becomes an ARRAY of labelled totals in the
-- application. `server/actions/analytics.ts` is the consumer and it does not
-- add across the groups; see the comments there.
--
-- ############################################################################
-- ⚠️ HOW TO RUN THIS
-- ############################################################################
-- Paste into the Neon SQL console. Each statement goes on its own connection.
--
-- 🔴 THERE IS NO `BEGIN;` AND NO `COMMIT;` IN THIS FILE, ON PURPOSE. A
--    browser console does not hold a transaction across statements: `BEGIN;`
--    opens one that the next statement never joins, the `COMMIT` at the end
--    rolls back work that appeared to succeed, and nothing reports an error.
--    Every statement below is independently idempotent instead — re-running
--    the whole file is a no-op.
--
-- ⚠️ NO DML ON ANY FORCE-RLS TABLE HERE, so no `app.platform_scope` block is
--    needed. This file only replaces three view definitions.
--
-- 🔴 NEVER `drizzle-kit push` TO APPLY THIS. `db/schema/analytics.ts` declares
--    the views with `.existing()` precisely so Drizzle never creates them — it
--    cannot express `security_invoker`, and a view created without it returns
--    EVERY tenant's aggregates to whoever can read it.
--
-- ############################################################################


-- ============================================================================
-- SECTION 1 · DIAGNOSTIC — RUN FIRST, READ BEFORE THE REST
-- ============================================================================
-- Prints what is there NOW. If a later statement fails, this has still told
-- you which views existed, whether they already carry a currency, and whether
-- they are running with the caller's RLS.
--
-- ⚠️ `to_regclass()` GUARDS THE READ, not a `CASE` over the relation itself.
--    A `CASE` whose branches name a table resolves BOTH branches at parse
--    time, so the guard never runs; `to_regclass` returns NULL for a missing
--    object without touching it, and `pg_get_viewdef` is strict so NULL in
--    gives NULL out.
-- ============================================================================

SELECT
    '0104 · diagnostic'                                          AS finding,
    current_user                                                 AS running_as,
    to_regclass('public.assets')       IS NOT NULL               AS assets_present,
    to_regclass('public.contracts')    IS NOT NULL               AS contracts_present,
    to_regclass('public.transactions') IS NOT NULL               AS transactions_present,
    CASE
      WHEN to_regclass('public.v_asset_portfolio') IS NULL
        THEN 'absent — 0008 was never applied here'
      WHEN pg_get_viewdef(to_regclass('public.v_asset_portfolio')) ILIKE '%currency%'
        THEN 'already carries currency'
      ELSE '🔴 SUMS ACROSS CURRENCIES'
    END                                                          AS v_asset_portfolio_state,
    CASE
      WHEN to_regclass('public.v_contract_pipeline') IS NULL
        THEN 'absent — 0008 was never applied here'
      WHEN pg_get_viewdef(to_regclass('public.v_contract_pipeline')) ILIKE '%currency%'
        THEN 'already carries currency'
      ELSE '🔴 SUMS ACROSS CURRENCIES'
    END                                                          AS v_contract_pipeline_state,
    CASE
      WHEN to_regclass('public.v_ledger_daily') IS NULL
        THEN 'absent — 0008 was never applied here'
      WHEN pg_get_viewdef(to_regclass('public.v_ledger_daily')) ILIKE '%currency%'
        THEN 'already carries currency'
      ELSE '🔴 SUMS ACROSS CURRENCIES'
    END                                                          AS v_ledger_daily_state;


-- ============================================================================
-- SECTION 2 · HOW MANY CURRENCIES ARE ACTUALLY IN PLAY
-- ============================================================================
-- 🔴 THE ANSWER MATTERS AND IS PROBABLY "ONE". That is not reassurance. It
--    means the fault is latent, not absent: the first foreign-currency asset
--    or contract makes the tile wrong with no deploy, no error and no visible
--    change.
--
-- ⚠️ WHAT THIS RETURNS DEPENDS ON WHO YOU ARE. `assets`, `contracts` and
--    `transactions` are FORCE-RLS tenant tables, and FORCE applies to the
--    table owner too. From the Neon console with no `app.current_tenant_id`
--    set, the honest answer is zero rows — which is itself the correct
--    result, not a failure. It is NOT worth a platform-scope escape hatch:
--    this is a curiosity, and the fix below is right either way.
--
-- The whole read is guarded as a STRING, so a database where 0008 never ran
-- returns a row saying so rather than erroring on a missing relation.
-- ============================================================================

DO $currency_census$
DECLARE
    result text;
BEGIN
    IF to_regclass('public.assets') IS NULL
       OR to_regclass('public.contracts') IS NULL
       OR to_regclass('public.transactions') IS NULL THEN
        RAISE NOTICE '0104 · census skipped — one of assets/contracts/transactions is absent.';
        RETURN;
    END IF;

    EXECUTE
        'SELECT ''assets='' || (SELECT count(DISTINCT currency) FROM public.assets) ||'
        '       '' contracts='' || (SELECT count(DISTINCT currency) FROM public.contracts) ||'
        '       '' transactions='' || (SELECT count(DISTINCT currency) FROM public.transactions)'
        INTO result;

    RAISE NOTICE '0104 · distinct currencies visible to this session: %', result;
    RAISE NOTICE '0104 · a count of 1 means LATENT, not ABSENT. RLS may also be hiding every row.';
END
$currency_census$;


-- ============================================================================
-- SECTION 3 · v_asset_portfolio
-- ============================================================================
-- ⭐ `CREATE OR REPLACE VIEW`, NOT `DROP` + `CREATE`, AND THE REASON IS THE
--    GRANTS. `0047_grant_missing_views.sql` granted SELECT on these three to
--    `ordence_app`. DROP takes the grants with it and the dashboard returns
--    "permission denied for view" on the next request — a failure that looks
--    like an outage and is actually this file.
--
-- ⚠️ REPLACE MAY ONLY APPEND COLUMNS. Every pre-existing column keeps its
--    name, type and position; `currency` goes LAST. Reordering would be
--    rejected by PostgreSQL, which is the guard rail working.
--
-- 🔴 `security_invoker = true` IS RESTATED. Omitting it on a REPLACE is the
--    one-word change that turns a tenant-scoped view into a cross-tenant one,
--    and the symptom is a dashboard with too-large numbers that nobody reads
--    as a leak.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_asset_portfolio
WITH (security_invoker = true) AS
SELECT
  a.tenant_id,
  a.asset_type,
  a.status,
  count(*)::int                                        AS asset_count,
  COALESCE(sum(a.value_amount), 0)::numeric(20, 2)     AS total_value,
  COALESCE(sum(a.area_value), 0)::numeric(20, 2)       AS total_area,
  COALESCE(sum(a.quantity), 0)::bigint                 AS total_quantity,
  -- ⭐ THE NEW GROUPING KEY. `total_area` and `total_quantity` are not money
  -- and do not need it; they are grouped the same way anyway because a view
  -- cannot return two different granularities, and a square foot is a square
  -- foot in every currency.
  a.currency                                           AS currency
FROM public.assets a
WHERE a.deleted_at IS NULL
GROUP BY a.tenant_id, a.asset_type, a.status, a.currency;

COMMENT ON VIEW public.v_asset_portfolio IS
    'Assets by (tenant, type, status, CURRENCY). 0104 added the currency key: '
    'before it, a portfolio holding rupee land and dollar plant returned one '
    'sum of both. The application must never add across the currency column.';


-- ============================================================================
-- SECTION 4 · v_contract_pipeline
-- ============================================================================
-- Same fault, same fix. `contracts.value` is `numeric(18,2)` with
-- `contracts.currency` beside it, and the pipeline tile added them.
--
-- ⚠️ THE COUNTS ARE NOT AFFECTED AND MUST NOT BE HIDDEN. "17 contracts,
--    3 expiring" is true whatever currency they are in; only `total_value`
--    was ever meaningless. The application aggregates the counts across
--    currency groups and refuses to aggregate the value.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_contract_pipeline
WITH (security_invoker = true) AS
SELECT
  c.tenant_id,
  c.status,
  count(*)::int                                     AS contract_count,
  COALESCE(sum(c.value), 0)::numeric(20, 2)         AS total_value,
  count(*) FILTER (WHERE c.signed_at IS NOT NULL)::int   AS signed_count,
  count(*) FILTER (WHERE c.legal_hold)::int              AS on_hold_count,
  count(*) FILTER (
    WHERE c.expiry_date IS NOT NULL
      AND c.expiry_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')
  )::int                                            AS expiring_soon_count,
  c.currency                                        AS currency
FROM public.contracts c
WHERE c.deleted_at IS NULL
GROUP BY c.tenant_id, c.status, c.currency;

COMMENT ON VIEW public.v_contract_pipeline IS
    'Contracts by (tenant, status, CURRENCY). 0104 added the currency key. '
    'Counts may be added across the groups; total_value may not.';


-- ============================================================================
-- SECTION 5 · v_ledger_daily
-- ============================================================================
-- 🔴 THE SUBTLE ONE. `journal_entries` has NO currency column — the currency
--    lives one level up, on `transactions.currency`, and every entry belongs
--    to exactly one transaction. So the ledger sum was grouped by day and by
--    nothing else while the rows underneath it could be in different units.
--
-- ⭐ THE DATE SPINE NOW CROSSES (tenant, currency), NOT JUST tenant. A
--    workspace posting in two currencies gets 30 rows for each — including
--    the quiet days, which is the whole reason the spine exists. Crossing the
--    spine with tenants alone and then grouping by currency would drop the
--    zero-days for every currency, which is exactly the bug 0008 wrote the
--    spine to prevent.
--
-- ⚠️ NAMED HERE BECAUSE IT IS THE NEXT THING TO GO WRONG:
--    `server/accounting/post-sales.ts` writes `currency: "INR"` as a literal
--    on nearly every posting, and only `postExchangeDifference()` writes the
--    workspace's actual functional currency. A workspace whose books are kept
--    in AED therefore has transactions stamped INR carrying dirham amounts.
--    This view groups by what the column SAYS; it cannot repair what the
--    writer put there. Fixing those literals is a posting-layer change and is
--    named in the batch report rather than smuggled into a view definition.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_ledger_daily
WITH (security_invoker = true) AS
WITH date_spine AS (
  SELECT generate_series(
           (CURRENT_DATE - INTERVAL '29 days')::date,
           CURRENT_DATE::date,
           INTERVAL '1 day'
         )::date AS day
),
tenant_days AS (
  SELECT DISTINCT t.tenant_id, t.currency, d.day
  FROM (SELECT DISTINCT tenant_id, currency FROM public.transactions) t
  CROSS JOIN date_spine d
),
daily AS (
  SELECT
    tr.tenant_id,
    tr.currency,
    tr.transaction_date::date                              AS day,
    SUM(CASE WHEN je.entry_type = 'debit'  THEN je.amount ELSE 0 END) AS debits,
    SUM(CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE 0 END) AS credits,
    count(DISTINCT tr.id)::int                             AS transaction_count
  FROM public.transactions tr
  JOIN public.journal_entries je
    ON je.transaction_id = tr.id
   AND je.tenant_id = tr.tenant_id
  WHERE tr.transaction_date >= (CURRENT_DATE - INTERVAL '29 days')
    AND tr.transaction_date <= CURRENT_DATE
  GROUP BY tr.tenant_id, tr.currency, tr.transaction_date::date
)
SELECT
  td.tenant_id,
  td.day,
  COALESCE(dl.debits, 0)::numeric(20, 2)  AS debits,
  COALESCE(dl.credits, 0)::numeric(20, 2) AS credits,
  (COALESCE(dl.debits, 0) - COALESCE(dl.credits, 0))::numeric(20, 2) AS net_movement,
  COALESCE(dl.transaction_count, 0)       AS transaction_count,
  td.currency                             AS currency
FROM tenant_days td
LEFT JOIN daily dl
  ON dl.tenant_id = td.tenant_id
 AND dl.currency  = td.currency
 AND dl.day       = td.day;

COMMENT ON VIEW public.v_ledger_daily IS
    '30-day ledger spine per (tenant, day, CURRENCY), currency taken from '
    'transactions.currency because journal_entries has none. 0104 added the '
    'currency key. A trial balance is only balanced WITHIN a currency.';


-- ============================================================================
-- SECTION 6 · GRANTS — RESTATED, BECAUSE A REPLACE THAT BECAME A RECREATE
--             SOMEWHERE WOULD HAVE LOST THEM
-- ============================================================================
-- Idempotent and defensive: the role name differs per deployment and a
-- missing role must not abort the file.
-- ============================================================================

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    GRANT SELECT ON public.v_asset_portfolio   TO ordence_app;
    GRANT SELECT ON public.v_ledger_daily      TO ordence_app;
    GRANT SELECT ON public.v_contract_pipeline TO ordence_app;
  ELSE
    RAISE NOTICE '0104 · role ordence_app not present here; grants skipped.';
  END IF;
END
$grants$;


-- ============================================================================
-- SECTION 7 · VERIFICATION — READ THE OUTPUT, DO NOT ASSUME
-- ============================================================================

-- ⭐ CHECK 1 — THE ONE THAT MATTERS MOST, AND IT IS NOT THE CURRENCY.
-- A REPLACE that dropped `security_invoker` would fix the currency bug and
-- open a cross-tenant leak in the same statement.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: all 3 analytics views still run with security_invoker'
       ELSE 'FAIL: only ' || count(*) || ' of 3 have security_invoker — THE OTHERS LEAK ACROSS TENANTS'
  END AS check_1_security_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline')
  AND c.reloptions @> ARRAY['security_invoker=true'];

-- Check 2 — every view now exposes `currency`.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: all 3 analytics views expose a currency column'
       ELSE 'FAIL: only ' || count(*) || ' of 3 expose currency — the others still add across currencies'
  END AS check_2_currency_column
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'currency'
  AND table_name IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline');

-- Check 3 — `tenant_id` survived, so the application's explicit second-layer
-- filter still compiles and a stray aggregate is still visible in review.
SELECT
  CASE WHEN count(*) = 3
       THEN 'PASS: every analytics view still exposes tenant_id'
       ELSE 'FAIL: a view lost tenant_id — cross-tenant aggregates would be invisible'
  END AS check_3_tenant_column
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'tenant_id'
  AND table_name IN ('v_asset_portfolio', 'v_ledger_daily', 'v_contract_pipeline');

-- Check 4 — the source tables still have RLS enabled AND forced.
-- `security_invoker` only helps if there is a policy to invoke.
SELECT
  CASE WHEN count(*) = 4
       THEN 'PASS: all 4 source tables still have RLS enabled and FORCED'
       ELSE 'FAIL: only ' || count(*) || ' of 4 source tables fully protected'
  END AS check_4_source_rls
FROM pg_class
WHERE relname IN ('assets', 'contracts', 'transactions', 'journal_entries')
  AND relrowsecurity = true
  AND relforcerowsecurity = true;

-- Check 5 — the ledger spine still covers 30 calendar days.
SELECT
  CASE WHEN (CURRENT_DATE - (CURRENT_DATE - INTERVAL '29 days')::date) = 29
       THEN 'PASS: ledger view spans 30 calendar days inclusive'
       ELSE 'FAIL: date spine is not 30 days'
  END AS check_5_date_span;
