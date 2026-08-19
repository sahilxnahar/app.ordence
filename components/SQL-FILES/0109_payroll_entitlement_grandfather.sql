-- ############################################################################
-- 0109 , PAYROLL BECOMES A PAID MODULE, WITHOUT CUTTING ANYBODY OFF ON THE DAY
-- ############################################################################
--
-- REPO: app.ordence   ·   BATCH: 0109   ·   BASE: v1.67.0-alpha
--
-- ############################################################################
-- WHAT THE CODE IN THIS BATCH CHANGED, AND WHY THIS FILE EXISTS
-- ############################################################################
--
-- hr.payroll has been priced at the Advanced tier in lib/entitlements/features.ts
-- since batch 15. Nothing anywhere asked. Every plan ran payroll, including the
-- free one: payroll runs, payslips, LOP in centidays, the regime election from
-- 0095, the advances ledger from 0096.
--
-- server/payroll/entitlement.ts now refuses the writes that START a payroll
-- commitment on a plan that does not include payroll.
--
-- 🔴 THE PROBLEM THAT CREATES, AND IT IS A REAL ONE. A workspace on Basic that
--    has been running payroll for months, correctly, using a screen we showed
--    them, loses the ability to open next month's run the moment the code
--    deploys. Nothing warned them. Nothing offered them a date. From their
--    side it is indistinguishable from the product breaking.
--
-- ⭐ SO THIS FILE GRANTS THOSE WORKSPACES, AND ONLY THOSE, A DATED OVERRIDE.
--    Ninety days of payroll at the plan they are on, recorded with a reason,
--    with an end date, in the table that already exists for exactly this.
--    lib/entitlements/overrides.ts states the rule it obeys: a grant above the
--    plan needs an expiry, because "an expiry turns it into what it actually is
--    , a trial with an end."
--
-- ⚠️ NOTHING IS REVOKED HERE AND NO DATA IS TOUCHED. This file only ever adds
--    permission. If it is not run, the gate is simply strict from day one.
--
-- ############################################################################
-- 🔴 HOW TO RUN THIS , READ BEFORE PASTING
-- ############################################################################
--
-- ORDER RELATIVE TO THE CODE PUSH: **RUN THIS FILE FIRST, THEN PUSH THE CODE.**
-- The override has no effect at all until the gate exists, so running it early
-- is harmless. Running it late leaves a window in which a customer who was
-- entitled to the grandfather is refused.
--
-- It is pasted into the Neon SQL editor, which sends EACH STATEMENT ON ITS OWN
-- CONNECTION. Therefore:
--   , there is no BEGIN and no COMMIT anywhere in this file;
--   , the write is a single DO block, so one statement is one transaction;
--   , every statement is independently re-runnable.
--
-- ⚠️ psql -f DOES NOT REPRODUCE THE WAY THIS FILE IS USED. It sends the whole
--    file on one connection. Testing it that way proves nothing about the way
--    it is actually run.
--
-- ############################################################################
-- ⚠️ AN HONEST NOTE ABOUT WHAT SECTION 3 WILL DO TODAY
-- ############################################################################
--
-- On a database with no customers on Basic who have payroll rows, section 3
-- inserts NOTHING and reports success. "It applied without error" and "it did
-- the thing it was for" are different claims, and only section 1 and section 2
-- can tell you which one you got. Read their output; do not read the absence
-- of an error.
--
-- ############################################################################


-- ============================================================================
-- ① DIAGNOSTIC FIRST , DO THE PAYROLL TABLES EVEN EXIST HERE?
-- ============================================================================
--
-- ⚠️ THIS STATEMENT NAMES NO TABLE IN A FROM CLAUSE, DELIBERATELY. A query that
--    selects FROM a table in order to find out whether that table exists fails
--    at PLANNING time, before any guard in it runs, and reports "relation does
--    not exist" instead of the answer it was written to give. to_regclass()
--    takes a name as text and returns NULL rather than raising.
--
-- If either answer below is "MISSING", stop: 0075 has not been applied on this
-- database and sections 2 and 3 will fail for that reason and no other.

SELECT
    CASE WHEN to_regclass('public.employees')    IS NULL THEN 'MISSING' ELSE 'present' END  AS employees,
    CASE WHEN to_regclass('public.payroll_runs') IS NULL THEN 'MISSING' ELSE 'present' END  AS payroll_runs,
    CASE WHEN to_regclass('public.platform_tenant_flags') IS NULL THEN 'MISSING' ELSE 'present' END AS tenant_flags,
    CASE WHEN to_regclass('public.platform_entitlement_history') IS NULL THEN 'MISSING' ELSE 'present' END AS entitlement_history;


-- ============================================================================
-- ② WHO IS ABOUT TO LOSE PAYROLL , THE MOST VALUABLE OUTPUT IN THIS FILE
-- ============================================================================
--
-- ⭐ THIS RUNS BEFORE THE WRITE, ON PURPOSE. A file whose most useful output
--    sits behind its least certain operation teaches nothing on the day it
--    breaks. Whatever section 3 does or does not do, this has already told the
--    operator the fact they actually need.
--
-- `contracted_tier` is the tier the workspace BOUGHT, resolved the same way
-- server/entitlements.ts resolves it: the subscription row is the authority and
-- tenants.plan_tier is a denormalised cache used only where no subscription
-- exists. A `trial` workspace is shown as trial and is NOT a target , trials
-- are treated as Advanced by the gate.
--
--   action = 'GRANDFATHER'   this workspace uses payroll, cannot afford to
--                            lose it on deploy day, and section 3 will grant it
--   action = 'already ok'    the plan includes payroll
--   action = 'no payroll use' nothing to protect

SELECT
    t.id                                        AS tenant_id,
    t.slug,
    COALESCE(sub.tier, t.plan_tier)             AS contracted_tier,
    use.employee_count,
    use.run_count,
    CASE
        WHEN use.employee_count = 0 AND use.run_count = 0 THEN 'no payroll use'
        WHEN COALESCE(sub.tier, t.plan_tier) = 'basic'    THEN 'GRANDFATHER'
        ELSE 'already ok'
    END                                         AS action
FROM tenants t
LEFT JOIN LATERAL (
    SELECT p.tier
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.tenant_id = t.id
      AND s.deleted_at IS NULL
      AND s.status IN ('trialing','active','past_due','unpaid','paused')
    ORDER BY s.created_at DESC
    LIMIT 1
) sub ON TRUE
CROSS JOIN LATERAL (
    SELECT
        (SELECT count(*) FROM employees e     WHERE e.tenant_id = t.id) AS employee_count,
        (SELECT count(*) FROM payroll_runs r  WHERE r.tenant_id = t.id) AS run_count
) use
WHERE t.deleted_at IS NULL
ORDER BY action, t.slug;


-- ============================================================================
-- ③ THE GRANT , ONE STATEMENT, ONE CONNECTION, ONE TRANSACTION
-- ============================================================================
--
-- ⚠️ A SINGLE DO BLOCK, BY CONSTRUCTION AND NOT BY CONVENTION. The console
--    gives each statement its own connection, so a multi-statement version of
--    this would set the platform scope on one connection and insert on another,
--    where the scope has evaporated. That failure reports success on the SET
--    and refuses on the INSERT, which reads as a broken table rather than as a
--    missing setting.
--
-- ⚠️ set_config(..., true) IS TRANSACTION-LOCAL. Inside a DO block that is the
--    block itself, which is what we want: the elevated scope does not outlive
--    the statement that needed it.
--
-- ⚠️ ON CONFLICT DO NOTHING, so re-running never doubles a grant and never
--    silently extends one that has already been shortened by hand.

DO $grandfather_payroll$
DECLARE
    v_granted   integer := 0;
    v_expires   timestamptz := now() + interval '90 days';
    v_reason    text :=
        'Batch 0109 grandfather. This workspace was using payroll before '
        'hr.payroll became an enforced entitlement, on a plan that does not '
        'include it. Ninety days at the current plan so a statutory obligation '
        'is never interrupted by a pricing change. Expires ' ||
        to_char((now() + interval '90 days')::date, 'DD Mon YYYY') ||
        '; after that the Advanced plan is required.';
BEGIN
    PERFORM set_config('app.platform_scope', 'on', true);

    IF to_regclass('public.employees') IS NULL
       OR to_regclass('public.payroll_runs') IS NULL
       OR to_regclass('public.platform_tenant_flags') IS NULL THEN
        RAISE NOTICE '0109: payroll or platform tables missing , nothing done. Apply 0075 and 0014 first.';
        RETURN;
    END IF;

    WITH contracted AS (
        SELECT
            t.id                            AS tenant_id,
            COALESCE(sub.tier, t.plan_tier) AS tier
        FROM tenants t
        LEFT JOIN LATERAL (
            SELECT p.tier
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
            WHERE s.tenant_id = t.id
              AND s.deleted_at IS NULL
              AND s.status IN ('trialing','active','past_due','unpaid','paused')
            ORDER BY s.created_at DESC
            LIMIT 1
        ) sub ON TRUE
        WHERE t.deleted_at IS NULL
    ),
    -- ⚠️ EITHER TABLE COUNTS. A workspace that has entered its people and has
    --    not yet run a payroll is exactly as stranded as one mid-run, and it is
    --    the one most likely to be about to run its first.
    using_payroll AS (
        SELECT DISTINCT tenant_id FROM employees
        UNION
        SELECT DISTINCT tenant_id FROM payroll_runs
    ),
    targets AS (
        SELECT c.tenant_id
        FROM contracted c
        JOIN using_payroll u ON u.tenant_id = c.tenant_id
        -- ⚠️ 'basic' ONLY. `trial` rises to Advanced in the gate, and every
        --    tier above basic already includes payroll, so a grant for any of
        --    them would be a row that explains nothing and expires confusingly.
        WHERE c.tier = 'basic'
    )
    INSERT INTO platform_tenant_flags
        (tenant_id, flag_key, enabled, value, reason, expires_at)
    SELECT
        tenant_id,
        'entitlement:hr.payroll',
        TRUE,
        '{}'::jsonb,
        v_reason,
        v_expires
    FROM targets
    ON CONFLICT (tenant_id, flag_key) DO NOTHING;

    GET DIAGNOSTICS v_granted = ROW_COUNT;

    -- ⭐ AND THE GRANT IS WRITTEN INTO THE HISTORY, because a change to what a
    --    customer can reach that leaves no record is the thing
    --    platform_entitlement_history exists to prevent. changed_by is NULL and
    --    the reason says why: no member of staff did this, a migration did.
    IF v_granted > 0 AND to_regclass('public.platform_entitlement_history') IS NOT NULL THEN
        INSERT INTO platform_entitlement_history
            (tenant_id, flag_key, before_enabled, after_enabled, changed_by, reason)
        SELECT
            f.tenant_id,
            f.flag_key,
            NULL,          -- there was no row before. NULL is not FALSE.
            TRUE,
            NULL,          -- a migration, not a person.
            v_reason
        FROM platform_tenant_flags f
        WHERE f.flag_key = 'entitlement:hr.payroll'
          AND f.reason LIKE 'Batch 0109 grandfather.%'
          AND NOT EXISTS (
              SELECT 1
              FROM platform_entitlement_history h
              WHERE h.tenant_id = f.tenant_id
                AND h.flag_key  = f.flag_key
                AND h.reason LIKE 'Batch 0109 grandfather.%'
          );
    END IF;

    RAISE NOTICE '0109: payroll grandfathered for % workspace(s), expiring %.',
        v_granted, v_expires;
END
$grandfather_payroll$;


-- ============================================================================
-- ④ VERIFY , AND IT EXERCISES BOTH BRANCHES, NOT ONLY THE PASSING ONE
-- ============================================================================
--
-- ⚠️ A verify that has only ever been run on the case that works is not a
--    verify. Read all four rows: `should_have_grant` and `has_grant` must
--    agree, and `outstanding` must be zero. A non-zero `outstanding` means a
--    workspace that uses payroll on Basic did NOT get a grant , which is the
--    failure this file exists to prevent, and it is silent otherwise.

SELECT
    count(*) FILTER (WHERE should_have_grant)                        AS should_have_grant,
    count(*) FILTER (WHERE has_grant)                                AS has_grant,
    count(*) FILTER (WHERE should_have_grant AND NOT has_grant)      AS outstanding,
    count(*) FILTER (WHERE has_grant AND NOT should_have_grant)      AS grants_no_longer_needed
FROM (
    SELECT
        t.id,
        (   COALESCE(sub.tier, t.plan_tier) = 'basic'
            AND (
                EXISTS (SELECT 1 FROM employees e    WHERE e.tenant_id = t.id)
             OR EXISTS (SELECT 1 FROM payroll_runs r WHERE r.tenant_id = t.id)
            )
        ) AS should_have_grant,
        EXISTS (
            SELECT 1 FROM platform_tenant_flags f
            WHERE f.tenant_id = t.id
              AND f.flag_key  = 'entitlement:hr.payroll'
              AND f.enabled
              AND (f.expires_at IS NULL OR f.expires_at > now())
        ) AS has_grant
    FROM tenants t
    LEFT JOIN LATERAL (
        SELECT p.tier
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = t.id
          AND s.deleted_at IS NULL
          AND s.status IN ('trialing','active','past_due','unpaid','paused')
        ORDER BY s.created_at DESC
        LIMIT 1
    ) sub ON TRUE
    WHERE t.deleted_at IS NULL
) x;


-- ============================================================================
-- ⑤ WHAT IS DELIBERATELY NOT HERE
-- ============================================================================
--
-- , NO SCHEMA CHANGE. No table, no column, no policy. Every table this file
--   touches was created and secured by 0014, 0074 and 0075, and their RLS is
--   unchanged.
--
-- , NO GRANDFATHER FOR THE OTHER MODULES GATED IN THIS BATCH. ai.copilot,
--   ai.rag, clm.contracts, clm.document_assembly, assets.catalog and
--   inventory.traceability are all now refused on plans that do not include
--   them, and none of them gets a dated grant. The difference is that payroll
--   carries a STATUTORY DEADLINE belonging to somebody who is owed money:
--   provident fund and ESI on the 15th, s.192 TDS on the 7th. Losing the
--   ability to draft a contract on Tuesday is an inconvenience with a price
--   attached; losing the ability to run payroll on Tuesday is a default under
--   s.201(1) of the Income-tax Act with interest running from the date of
--   payment. Only one of those needs ninety days.
--
-- , NO EXPIRY EXTENSION PATH. When these grants lapse the affected workspaces
--   are refused, which is the intended end state. Extending one is a console
--   action by a named person with a written reason, which is what
--   server/platform/configuration.ts is for. A second migration that quietly
--   renewed them would be the discount nobody signed off that
--   lib/entitlements/overrides.ts warns about.
