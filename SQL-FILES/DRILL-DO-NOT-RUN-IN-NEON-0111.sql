-- =====================================================================
--  DRILL , DO NOT RUN THIS IN NEON
-- =====================================================================
--
--  It exercises what 0111 adds to `dunning_events` , the authority
--  column, the per-rung permission CHECK and the deemed-service CHECK ,
--  by trying to break each of them and reading the refusal, and by
--  making the write that must still work beside every refusal.
--
--     createdb drill0111
--     createuser drill_app --no-superuser --no-createdb --no-createrole
--     psql -q -d drill0111 -f DRILL-DO-NOT-RUN-IN-NEON-0111.sql   # as owner
--     psql -q -d drill0111 -U drill_app -f DRILL-DO-NOT-RUN-IN-NEON-0111.sql
--
--  🔴 THE SECOND RUN IS THE REAL ONE, AND STEP 0 REFUSES THE FIRST.
--
--  Two of the three things under test are CHECK constraints, which a
--  superuser is refused by exactly like anybody else. The third , the
--  tenant policy re-asserted by 0111 §7 , is a permission, and a
--  superuser or a role with `rolbypassrls` walks straight past it. Step 5
--  would then pass silently and prove nothing. This has caught this
--  project before: 0092 was reviewed, applied cleanly from a terminal,
--  and still failed in the browser console because it had never been
--  executed as the role that would run it.
--
--  ⚠️ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL SUCCEED. A
--  drill that only shows breaks cannot tell "the constraint works" from
--  "the table rejects everything", and a table that rejects everything
--  passes every refusal in this file.
-- =====================================================================


-- =====================================================================
--  STEP 0 , REFUSE TO RUN SOMEWHERE THAT MATTERS, OR AS SOMEBODY WHO
--           CANNOT BE REFUSED
-- =====================================================================
DO $guard$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      'REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = current_user
                AND (rolsuper OR rolbypassrls))
  THEN
    RAISE EXCEPTION
      'REFUSING: "%" is a superuser or carries BYPASSRLS, so step 5 would pass without proving anything. Re-run as an ordinary role.',
      current_user;
  END IF;
END
$guard$;


-- =====================================================================
--  STEP 1 , WHERE WE ARE STARTING FROM
--  ⚠️ Assumes 0027, 0098 and 0111 have been applied to this throwaway.
-- =====================================================================
SELECT
    'drill 0111 · start'                                       AS step,
    current_user                                               AS running_as,
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'dunning_events'
        AND column_name = 'authorised_permission')             AS authority_nullable_expect_NO,
    (SELECT column_default FROM information_schema.columns
      WHERE table_name = 'dunning_events'
        AND column_name = 'authorised_permission')             AS authority_default_expect_null;


-- =====================================================================
--  STEP 2 , THE AUTHORITY COLUMN IS NOT NULL WITH NO DEFAULT
--  ⭐ This is what makes "a writer that forgets" an error rather than an
--     unattributed notice.
-- =====================================================================
DO $step2$
DECLARE
    tenant CONSTANT uuid := current_setting('app.tenant_id', true)::uuid;
    refused boolean := false;
BEGIN
    BEGIN
        INSERT INTO dunning_events
          (tenant_id, demand_id, stage, rung, channel, raised_at,
           days_overdue, outstanding_minor)
        VALUES (tenant, gen_random_uuid(), 'reminder', 1, 'email', now(), 10, 100);
    EXCEPTION WHEN not_null_violation THEN
        refused := true;
    END;

    IF NOT refused THEN
        RAISE EXCEPTION
          'FAILED: a rung was written with no authority recorded against it. 0111 section 4 did not drop the default.';
    END IF;
    RAISE NOTICE 'PASS , a rung that does not state its authority is refused.';
END
$step2$;


-- =====================================================================
--  STEP 3 , THE PER-RUNG PERMISSION IS A FACT ABOUT THE ROW
--  🔴 The rung that precedes a forfeiture may not be recorded as
--     ordinary chasing work, whatever wrote it.
-- =====================================================================
DO $step3$
DECLARE
    tenant CONSTANT uuid := current_setting('app.tenant_id', true)::uuid;
    demand CONSTANT uuid := gen_random_uuid();
    refused boolean;
BEGIN
    -- ① A cancellation warning claiming the ordinary key.
    refused := false;
    BEGIN
        INSERT INTO dunning_events
          (tenant_id, demand_id, stage, rung, channel, raised_at, days_overdue,
           outstanding_minor, authorised_permission, authorised_by, authorised_reason)
        VALUES (tenant, demand, 'cancellation_warning', 4, 'post', now(), 90, 100,
                'receivables:dun', gen_random_uuid(), 'board resolution');
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a cancellation warning was recorded as ordinary dunning work.';
    END IF;

    -- ② A reminder claiming the forfeiture key. The split runs BOTH ways:
    --    counsel holds the top key and not the collecting one.
    refused := false;
    BEGIN
        INSERT INTO dunning_events
          (tenant_id, demand_id, stage, rung, channel, raised_at, days_overdue,
           outstanding_minor, authorised_permission)
        VALUES (tenant, gen_random_uuid(), 'reminder', 1, 'email', now(), 10, 100,
                'receivables:warn_cancellation');
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a reminder was recorded under the forfeiture key.';
    END IF;

    -- ③ ⚠️ AND THE WRITE THAT MUST STILL WORK.
    INSERT INTO dunning_events
      (tenant_id, demand_id, stage, rung, channel, raised_at, days_overdue,
       outstanding_minor, authorised_permission)
    VALUES (tenant, demand, 'reminder', 1, 'email', now(), 10, 100, 'receivables:dun');

    RAISE NOTICE 'PASS , the rung and the right must match, in both directions, and the correct pairing still writes.';
END
$step3$;


-- =====================================================================
--  STEP 4 , DEEMED SERVICE STATES ITS BASIS
--  ⭐ `deemed` is the strongest grade in the product and the only one no
--     machine ever touches. Take away the basis, the reference, the
--     person or the date and what is left is a tick box at the top of
--     the evidence scale.
-- =====================================================================
DO $step4$
DECLARE
    tenant CONSTANT uuid := current_setting('app.tenant_id', true)::uuid;
    target uuid;
    recorder uuid;
    refused boolean;
BEGIN
    SELECT id INTO target FROM dunning_events
      WHERE tenant_id = tenant AND channel IN ('post','courier','hand_delivery')
        AND dispatched_at IS NULL
      LIMIT 1;
    IF target IS NULL THEN
        INSERT INTO dunning_events
          (tenant_id, demand_id, stage, rung, channel, raised_at, days_overdue,
           outstanding_minor, authorised_permission)
        VALUES (tenant, gen_random_uuid(), 'reminder', 1, 'post', now(), 10, 100,
                'receivables:dun')
        RETURNING id INTO target;
    END IF;

    SELECT id INTO recorder FROM users WHERE tenant_id = tenant LIMIT 1;

    -- ① No basis.
    refused := false;
    BEGIN
        UPDATE dunning_events
           SET service_evidence = 'deemed', service_recorded_by = recorder,
               service_recorded_at = now(), served_at = now(),
               service_reference = 'EX123456789IN', service_basis = NULL
         WHERE id = target;
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a notice was deemed served with no stated basis.';
    END IF;

    -- ② No reference.
    refused := false;
    BEGIN
        UPDATE dunning_events
           SET service_evidence = 'deemed', service_recorded_by = recorder,
               service_recorded_at = now(), served_at = now(),
               service_reference = NULL,
               service_basis = 'Clause 14.2 of the agreement for sale; cover returned endorsed refused.'
         WHERE id = target;
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a notice was deemed served with nothing anybody can look up.';
    END IF;

    -- ③ Nobody's name on it.
    refused := false;
    BEGIN
        UPDATE dunning_events
           SET service_evidence = 'deemed', service_recorded_by = NULL,
               service_recorded_at = now(), served_at = now(),
               service_reference = 'EX123456789IN',
               service_basis = 'Clause 14.2 of the agreement for sale; cover returned endorsed refused.'
         WHERE id = target;
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a notice was deemed served by nobody.';
    END IF;

    -- ④ ⚠️ THE ONE THAT MUST WORK. A refused RPAD is the commonest real
    --    ending of a chase, and refusing to record it would push the only
    --    legally effective channel out of the system.
    UPDATE dunning_events
       SET service_evidence = 'deemed', service_recorded_by = recorder,
           service_recorded_at = now(), served_at = now(),
           service_reference = 'EX123456789IN',
           service_basis = 'Clause 14.2 of the agreement for sale; cover returned endorsed refused; s.27 General Clauses Act 1897.'
     WHERE id = target;

    -- ⑤ 🔴 AND 0098 STILL HOLDS OVER THE TOP OF IT: a deemed row may
    --    never be promoted into a machine dispatch.
    refused := false;
    BEGIN
        UPDATE dunning_events
           SET dispatched_at = now(), dispatch_provider_message_id = 'resend_fake'
         WHERE id = target;
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a deemed row was promoted into a dispatch. 0098 has been weakened.';
    END IF;

    RAISE NOTICE 'PASS , a deeming names a person, a date, a reference and a basis, and can never become a dispatch.';
END
$step4$;


-- =====================================================================
--  STEP 5 , THE ONLY TENANT BOUNDARY THIS PRODUCT HAS
--  🔴 THIS IS THE STEP THAT NEEDS A NON-SUPERUSER. Step 0 refuses one.
-- =====================================================================
DO $step5$
DECLARE
    mine  CONSTANT uuid := current_setting('app.tenant_id', true)::uuid;
    other uuid;
    refused boolean := false;
    visible bigint;
BEGIN
    SELECT id INTO other FROM tenants WHERE id <> mine LIMIT 1;
    IF other IS NULL THEN
        RAISE EXCEPTION 'This drill needs two tenants seeded to mean anything.';
    END IF;

    BEGIN
        INSERT INTO dunning_events
          (tenant_id, demand_id, stage, rung, channel, raised_at, days_overdue,
           outstanding_minor, authorised_permission)
        VALUES (other, gen_random_uuid(), 'reminder', 1, 'email', now(), 10, 100,
                'receivables:dun');
    EXCEPTION WHEN insufficient_privilege THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'FAILED: a rung was written into another workspace.';
    END IF;

    SELECT count(*) INTO visible FROM dunning_events WHERE tenant_id = other;
    IF visible <> 0 THEN
        RAISE EXCEPTION
          'FAILED: % of another workspace''s rungs are readable from here.', visible;
    END IF;

    RAISE NOTICE 'PASS , another workspace''s chase can be neither read nor written.';
END
$step5$;


-- =====================================================================
--  STEP 6 , WHAT THE DRILL LEFT BEHIND
-- =====================================================================
SELECT
    'drill 0111 · end'                                          AS step,
    count(*)                                                    AS rungs_visible,
    count(*) FILTER (WHERE service_evidence = 'deemed')         AS deemed_expect_1,
    count(*) FILTER (WHERE authorised_permission = 'legacy_unrecorded')
                                                                AS legacy_untouched,
    count(*) FILTER (WHERE stage = 'cancellation_warning'
                       AND authorised_permission = 'receivables:dun')
                                                                AS mislabelled_expect_0
FROM dunning_events;
