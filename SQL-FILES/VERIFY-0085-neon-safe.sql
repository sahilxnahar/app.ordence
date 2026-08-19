-- =====================================================================
--  Ordence · VERIFY 0085 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
--
--  🔴 WHAT THIS PROVES AND WHAT IT CANNOT.
--
--  It proves the SHAPE: the five tables exist, every one is tenant-scoped
--  with RLS enabled AND forced and a policy on it, the cycle refusal is
--  installed as a TRIGGER and not merely as an application check, the
--  signed-off outcome is frozen, the amendment table is append-only, and
--  the amendment reason has a floor the database enforces.
--
--  ⚠️ IT CANNOT PROVE THAT THE HIERARCHY IS ACYCLIC IN THE PAST. Section
--  5 walks the current lines and reports any loop it finds, which is the
--  honest half a read-only file can do. A loop found there means rows
--  arrived before the trigger existed, or from a restore, or while the
--  trigger was disabled — the fix is to break the loop by hand.
--
--  🔴 AND IT CANNOT PROVE THE THING THAT MATTERS MOST, WHICH IS THAT NO
--  MANAGER CAN READ OUTSIDE THEIR OWN LINE. That is not a property of
--  the schema. Every colleague's appraisal is in the same tenant, so the
--  RLS policy is satisfied by a leaking query exactly as by a correct
--  one. The narrowing lives in the WHERE clause of
--  `server/actions/appraisals.ts` and is asserted by
--  `tests/ui/appraisals-and-org-chart.test.ts` against the source. There
--  is no query a database can run against itself to notice.
--
--  ⚠️ AND IT CANNOT PROVE THAT AN APPRAISAL IS FAIR. Section 8 is the
--  one to read before quoting any of the others at anybody.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. 🔴 THE TENANT BOUNDARY. THREE SEPARATE THINGS, REPORTED
--     SEPARATELY, BECAUSE THEY FAIL IN OPPOSITE DIRECTIONS.
--
--     `rls_enabled` false  → every tenant reads every other tenant's
--                            appraisal register.
--     `rls_forced`  false  → RLS is on and the table OWNER ignores it,
--                            and this application connects as the owner.
--     `policies` = 0       → RLS is on with no policy, which denies
--                            everybody: not protected, unusable.
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
   AND c.relname IN ('reporting_lines', 'appraisal_cycles', 'appraisal_subjects',
                     'appraisal_reviews', 'appraisal_amendments')
 ORDER BY c.relname;
-- ⭐ EXPECT: five rows; rls_enabled, rls_forced and tenant_id_not_null
--    all true; policies >= 1 on each. Fewer than five rows means 0085
--    has not been run.


-- ---------------------------------------------------------------------
--  2. 🔴🔴 THE CYCLE REFUSAL IS A TRIGGER, NOT A PROMISE.
--
--     `lib/hr/hierarchy.ts#wouldCreateCycle` is a courtesy so the person
--     gets a sentence instead of P0001. If THIS row is missing, the only
--     thing standing between the product and a hierarchy that hangs
--     every recursive query is a TypeScript function that an import, a
--     psql session or a future action does not go through.
-- ---------------------------------------------------------------------
SELECT t.tgname          AS trigger_name,
       c.relname         AS on_table,
       p.proname         AS function_name,
       NOT t.tgenabled = 'D' AS enabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal
   AND c.relname IN ('reporting_lines', 'appraisal_subjects',
                     'appraisal_reviews', 'appraisal_amendments')
 ORDER BY c.relname, t.tgname;
-- ⭐ EXPECT at least these, all enabled:
--      reporting_lines      · reporting_lines_no_cycle_check
--      appraisal_subjects   · appraisal_subjects_frozen_after_signoff
--      appraisal_reviews    · appraisal_reviews_reviewer_check
--      appraisal_reviews    · appraisal_reviews_frozen_after_submit
--      appraisal_amendments · appraisal_amendments_append_only
-- 🔴 A trigger present but DISABLED is the worst of the three states,
--    because every screen still says the rule is enforced.


-- ---------------------------------------------------------------------
--  3. THE CONSTRAINTS THE DECISIONS TURN ON, BY NAME.
--
--     ⚠️ CHECKED BY NAME RATHER THAN BY COUNTING. "five constraints
--     exist" is satisfied by five of the wrong ones.
-- ---------------------------------------------------------------------
SELECT conrelid::regclass::text AS table_name,
       conname                  AS constraint_name,
       pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conname IN (
   'reporting_lines_no_self',
   'reporting_lines_dates_ordered',
   'appraisal_cycles_dates_ordered',
   'appraisal_cycles_period_sane',
   'appraisal_subjects_signed_has_outcome',
   'appraisal_subjects_release_after_signoff',
   'appraisal_subjects_reviewer_not_self',
   'appraisal_amendments_reason_meant',
   'appraisal_amendments_changes_something'
 )
 ORDER BY table_name, constraint_name;
-- ⭐ EXPECT nine rows.


-- ---------------------------------------------------------------------
--  4. 🔴 ONE CURRENT REPORTING LINE PER EMPLOYEE.
--
--     Two open lines means two managers, and every recursive walk visits
--     the person twice — producing a chart with duplicated subtrees that
--     looks exactly like a real chart. The partial unique index should
--     make this impossible; this reports the fact rather than the index.
-- ---------------------------------------------------------------------
SELECT tenant_id, employee_id, count(*) AS open_lines
  FROM reporting_lines
 WHERE ended_on IS NULL
 GROUP BY tenant_id, employee_id
HAVING count(*) > 1
 ORDER BY open_lines DESC
 LIMIT 50;
-- ⭐ EXPECT zero rows.


-- ---------------------------------------------------------------------
--  5. 🔴🔴 IS THE CURRENT HIERARCHY ACYCLIC, RIGHT NOW?
--
--     ⚠️ THE RECURSION IS DEPTH-CAPPED AT 64 SO THIS FILE CANNOT ITSELF
--     BE THE THING THAT HANGS. A verify script that loops forever while
--     checking for loops is not a joke — it is what happens if the walk
--     trusts the data it is validating.
--
--     Any row returned is an employee whose chain revisits somebody
--     within 64 hops, or is deeper than 64. Both need a human.
-- ---------------------------------------------------------------------
WITH RECURSIVE walk AS (
  SELECT r.tenant_id,
         r.employee_id            AS start_id,
         r.manager_id             AS at_id,
         1                        AS depth,
         ARRAY[r.employee_id]     AS seen
    FROM reporting_lines r
   WHERE r.ended_on IS NULL
  UNION ALL
  SELECT w.tenant_id,
         w.start_id,
         r.manager_id,
         w.depth + 1,
         w.seen || w.at_id
    FROM walk w
    JOIN reporting_lines r
      ON r.tenant_id   = w.tenant_id
     AND r.employee_id = w.at_id
     AND r.ended_on IS NULL
   WHERE w.depth < 64
     AND NOT (w.at_id = ANY(w.seen))
)
SELECT tenant_id,
       start_id,
       max(depth) AS chain_depth,
       bool_or(at_id = start_id) AS revisits_itself
  FROM walk
 GROUP BY tenant_id, start_id
HAVING bool_or(at_id = start_id) OR max(depth) >= 64
 ORDER BY chain_depth DESC
 LIMIT 50;
-- ⭐ EXPECT zero rows.
-- 🔴 A row here means a cycle is ALREADY in the data. The trigger
--    prevents new ones; it cannot remove one that arrived from a restore
--    or from a session where it was disabled.


-- ---------------------------------------------------------------------
--  6. ⚠️ REPORTS POINTING AT SOMEBODY WHO HAS LEFT.
--
--     NOT AN ERROR AND DELIBERATELY NOT AUTO-CORRECTED. Nulling them
--     orphans people silently; re-pointing them at the grandparent
--     silently changes who signs off an appraisal for a period that
--     person did not supervise. This is the list a human clears, and the
--     org chart shows the same one.
-- ---------------------------------------------------------------------
SELECT r.tenant_id,
       e.full_name  AS reports,
       m.full_name  AS reports_to,
       m.left_on    AS manager_left_on
  FROM reporting_lines r
  JOIN employees e ON e.id = r.employee_id
  JOIN employees m ON m.id = r.manager_id
 WHERE r.ended_on IS NULL
   AND m.left_on IS NOT NULL
 ORDER BY m.left_on
 LIMIT 100;
-- ⭐ EXPECT: whatever it is. A long list means somebody has stopped
--    maintaining the chart, which is a management fact rather than a bug.


-- ---------------------------------------------------------------------
--  7. ⭐ THE REGISTER, SUMMARISED — AND THE AMENDMENTS, WHICH ARE THE
--     ONLY WAY A SIGNED-OFF OUTCOME EVER CHANGED.
-- ---------------------------------------------------------------------
SELECT c.fy_label,
       c.name,
       c.status,
       count(s.id)                                                   AS enrolled,
       count(*) FILTER (WHERE s.signed_off_at IS NOT NULL)            AS signed_off,
       count(*) FILTER (WHERE s.released_at   IS NOT NULL)            AS released,
       (SELECT count(*) FROM appraisal_amendments a
         WHERE a.subject_id IN (SELECT id FROM appraisal_subjects x
                                 WHERE x.cycle_id = c.id))            AS amendments
  FROM appraisal_cycles c
  LEFT JOIN appraisal_subjects s ON s.cycle_id = c.id
 GROUP BY c.id, c.fy_label, c.name, c.status
 ORDER BY c.fy_label DESC, c.name;
-- ⭐ `signed_off` > `released` is normal and healthy: the gap is the
--    conversation that has not happened yet.
-- ⚠️ A large `amendments` figure against one cycle is worth a look. It
--    is not necessarily wrong — but "we sign off then correct" as a
--    habit means the sign-off is not the decision anybody thinks it is.


-- ---------------------------------------------------------------------
--  8. 🔴🔴 WHAT NONE OF THE ABOVE PROVES. READ THIS BEFORE QUOTING ANY
--     OF IT AT ANYBODY.
--
--     ① IT CANNOT PROVE THAT A MANAGER CANNOT READ OUTSIDE THEIR LINE.
--        RLS scopes by tenant. Every colleague's row is in the same
--        tenant, so the policy is satisfied by the leaking query exactly
--        as by the correct one. The narrowing is
--        `inArray(appraisalSubjects.managerEmployeeId, mine)` in
--        `server/actions/appraisals.ts`, and the only thing that checks
--        it is a test that reads the source.
--
--     ② IT CANNOT PROVE THAT A SKIP-LEVEL REVIEW WAS NEVER SHOWN TO THE
--        MANAGER. The database stores the row; who was rendered it is a
--        property of `lib/hr/visibility.ts` and of every screen that
--        calls it.
--
--     ③ IT CANNOT PROVE THAT THE OUTCOME REFLECTS THE REVIEWS. Nothing
--        forces the signed-off rating to agree with the manager review,
--        and nothing should — a moderation conversation is allowed to
--        change a verdict. What is recorded is that both exist.
--
--     ④ AND NOTHING HERE TOUCHES PAY. There is no money column in 0085.
--        If somebody tells you the increment "came from the appraisal
--        system", it did not: somebody typed it into payroll.
-- ---------------------------------------------------------------------
SELECT 'read section 8 of this file before quoting sections 1-7' AS reminder;
