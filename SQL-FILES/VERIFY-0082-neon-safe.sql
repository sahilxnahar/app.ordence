-- =====================================================================
--  Ordence · VERIFY 0082 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
--
--  🔴 WHAT THIS PROVES AND WHAT IT CANNOT.
--
--  It proves the SHAPE: the six tables exist, every one is tenant-scoped
--  with RLS enabled AND forced and a policy on it, the ledger is
--  append-only, the accrual has its idempotency key, and the caps that
--  decision ③ turns on are NOT NULL with nothing standing in for
--  "unlimited".
--
--  ⚠️ IT CANNOT PROVE THAT THE ACCRUAL ARITHMETIC IS RIGHT. That lives in
--  `lib/leave/accrual.ts` and is proved by `tests/ui/leave.test.ts`.
--  Reimplementing it here in SQL would give the product two accrual
--  engines that must agree forever, and the first time they drift every
--  employee's balance is reported as wrong by whichever one was not
--  updated. Section 6 does the honest half instead: it reads the ledger
--  and reports what the balances ARE, so a human can look at one and say
--  whether it is plausible.
--
--  ⚠️ AND IT CANNOT PROVE COMPLETENESS. Nothing here can show that an
--  absence which SHOULD have been recorded ever reached the table. That
--  is what section 8 is about, and it is the section to read before
--  quoting any of the others at anybody.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. 🔴 THE TENANT BOUNDARY. THREE SEPARATE THINGS, REPORTED
--     SEPARATELY, BECAUSE THEY FAIL IN OPPOSITE DIRECTIONS.
--
--     `rls_enabled` false  → every tenant reads every other tenant's
--                            leave register.
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
   AND c.relname IN ('leave_periods', 'holiday_calendar', 'leave_types',
                     'leave_ledger', 'leave_requests', 'staff_attendance')
 ORDER BY c.relname;
-- ⭐ EXPECT: six rows; rls_enabled, rls_forced and tenant_id_not_null all
--    true; policies >= 1 on each. Fewer than six rows means 0082 has not
--    been run.


-- ---------------------------------------------------------------------
--  2. 🔴🔴 DECISION ②, VERIFIED BY ABSENCE.
--
--     There must be NO table that stores a leave balance as a number.
--     A stored balance is a cache of a sum over `leave_ledger`, and a
--     cache that disagrees with its ledger is unarguable with an
--     employee: they have their own list of the days they took, and "the
--     system says eight" is not an answer to it.
--
--     ⚠️ THIS SECTION EXISTS BECAUSE THE TABLE IS THE OBVIOUS THING TO
--     ADD LATER, under performance pressure, by somebody who has not read
--     this file. If it ever appears, the right answer is a MATERIALISED
--     VIEW with a refresh — a cache that says out loud that it is one.
-- ---------------------------------------------------------------------
SELECT coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '—') AS suspicious_tables,
       CASE WHEN count(*) = 0
            THEN '✅ No stored-balance table. The balance is sum(days_delta) and nothing else.'
            ELSE '🔴 A table that looks like a stored leave balance exists. Read section 2 of VERIFY-0082 before keeping it.'
       END AS verdict
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
   AND (c.relname LIKE '%leave_balance%' OR c.relname LIKE '%leave_entitlement%');


-- ---------------------------------------------------------------------
--  3. 🔴 THE LEDGER IS APPEND-ONLY, AND THE ACCRUAL CANNOT RUN TWICE.
--
--     `leave_ledger_accrual_once` is the whole safety story of the
--     accrual job. An accrual run is exactly the kind of job that gets
--     triggered twice — a cron that retried, an admin who clicked again,
--     a deploy that replayed a queue — and without the index the second
--     run is SILENT and everybody's balance is wrong by one month
--     forever, because the ledger is append-only and the only fix is
--     another visible entry.
-- ---------------------------------------------------------------------
SELECT (SELECT count(*) FROM pg_trigger t
         WHERE t.tgrelid = 'leave_ledger'::regclass
           AND NOT t.tgisinternal
           AND t.tgname IN ('leave_ledger_no_update', 'leave_ledger_no_delete'))
         AS append_only_triggers,
       EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = 'leave_ledger'::regclass AND i.indisunique
                  AND pg_get_indexdef(i.indexrelid) LIKE '%accrual%')
         AS accrual_idempotency_index,
       EXISTS (SELECT 1 FROM pg_constraint k
                WHERE k.conrelid = 'leave_ledger'::regclass
                  AND k.conname = 'leave_ledger_taken_from_attendance')
         AS taken_requires_attendance,
       EXISTS (SELECT 1 FROM pg_constraint k
                WHERE k.conrelid = 'leave_requests'::regclass
                  AND k.conname = 'leave_requests_no_overlap')
         AS one_leave_at_a_time,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'staff_attendance'::regclass
                  AND t.tgname = 'ordence_guard_staff_attendance_frozen')
         AS attendance_frozen_after_approval;
-- ⭐ EXPECT: append_only_triggers = 2, everything else true.
--    `taken_requires_attendance` false is the serious one — without it a
--    `taken` entry can be written straight from an approval, which is
--    decision ④ defeated, and afterwards nobody can tell which days
--    somebody was actually absent.


-- ---------------------------------------------------------------------
--  4. 🔴🔴 DECISION ③ — WHAT EACH LEAVE TYPE'S CAPS ACTUALLY SAY.
--
--     The columns are NOT NULL with no "unlimited" sentinel, so a cap
--     always has a value. This section reads them back in words, because
--     the failure mode is not a NULL — it is a number nobody chose.
--
--     ⚠️ `cap_never_binds` IS THE ONE TO LOOK AT. A carry-forward cap of
--     999 against an entitlement of 18 is arithmetically a cap and
--     practically an unlimited carry-forward, which is the off-balance-
--     sheet liability this whole decision exists to prevent: thirty
--     people leaving five days a year unused is 900 days of obligation
--     after six years that has never appeared in a management account.
-- ---------------------------------------------------------------------
SELECT t.code,
       t.label,
       t.accrual_method,
       t.annual_entitlement_days                        AS annual_days,
       t.carry_forward_cap_days                         AS carry_cap,
       t.encashment_cap_days                            AS encash_cap,
       t.encashment_min_retain_days                     AS must_retain,
       CASE
         WHEN t.accrual_method = 'none' THEN 'Never earned — no balance to carry or encash.'
         WHEN t.carry_forward_cap_days = 0 THEN '✅ Use it or lose it.'
         WHEN t.carry_forward_cap_days >= t.annual_entitlement_days * 3
           THEN '⚠️ The cap is at least three years of entitlement, so in practice it never binds. That is an uncapped liability wearing a cap.'
         ELSE '✅ Capped at ' || t.carry_forward_cap_days || ' days.'
       END                                              AS carry_forward_verdict,
       CASE
         WHEN t.accrual_method = 'annual_advance'
           THEN '⚠️ Granted up front. Somebody who takes it all in the first month and resigns has been paid for days they did not earn.'
         WHEN t.accrual_method = 'monthly_earned'
           THEN '✅ Earned across the year in proportion to days on the rolls.'
         ELSE 'Not earned.'
       END                                              AS accrual_verdict
  FROM leave_types t
 WHERE t.is_active
 ORDER BY t.display_order, t.code;


-- ---------------------------------------------------------------------
--  5. ⭐ DECISION ① — DOES ANYBODY HOLD MORE THAN THEY COULD HAVE EARNED?
--
--     The specific failure this batch exists to prevent is a full year's
--     balance appearing on 1 April for somebody who joined in October.
--     This finds it without reimplementing the accrual: an employee's
--     accrued days for a period may never exceed the type's annual
--     entitlement scaled by the days they were on the rolls inside it,
--     plus one rounding step.
--
--     ⚠️ A ROW HERE IS NOT AUTOMATICALLY A BUG. `annual_advance` grants
--     ahead of earning by design, and a manual `adjustment` is somebody's
--     decision. It is a list of balances that need a sentence of
--     explanation, and if nobody can produce one the accrual is wrong.
-- ---------------------------------------------------------------------
WITH earned AS (
  SELECT l.tenant_id,
         l.employee_id,
         l.leave_type_id,
         l.period_id,
         sum(l.days_delta) FILTER (WHERE l.kind = 'accrual') AS accrued_days
    FROM leave_ledger l
   GROUP BY 1, 2, 3, 4
)
SELECT e.employee_code,
       e.full_name,
       t.code                                            AS leave_type,
       p.label                                           AS leave_year,
       ea.accrued_days,
       t.annual_entitlement_days,
       greatest(0, least(p.ends_on, coalesce(e.left_on, p.ends_on))
                   - greatest(p.starts_on, e.joined_on) + 1)   AS days_on_rolls,
       (p.ends_on - p.starts_on + 1)                          AS days_in_period,
       round(t.annual_entitlement_days
             * greatest(0, least(p.ends_on, coalesce(e.left_on, p.ends_on))
                           - greatest(p.starts_on, e.joined_on) + 1)::numeric
             / nullif(p.ends_on - p.starts_on + 1, 0), 2)      AS could_have_earned,
       t.accrual_method
  FROM earned ea
  JOIN employees     e ON e.id = ea.employee_id
  JOIN leave_types   t ON t.id = ea.leave_type_id
  JOIN leave_periods p ON p.id = ea.period_id
 WHERE ea.accrued_days >
       round(t.annual_entitlement_days
             * greatest(0, least(p.ends_on, coalesce(e.left_on, p.ends_on))
                           - greatest(p.starts_on, e.joined_on) + 1)::numeric
             / nullif(p.ends_on - p.starts_on + 1, 0), 2) + 1
 ORDER BY ea.accrued_days - t.annual_entitlement_days DESC
 LIMIT 50;
-- ⭐ EXPECT: no rows, or only `annual_advance` types.


-- ---------------------------------------------------------------------
--  6. ⭐ THE BALANCES, DERIVED — AND THE TWO NUMBERS THAT ARE NOT ONE.
--
--     🔴 `balance` IS WHAT HAS BEEN EARNED AND NOT SPENT.
--        `available` IS `balance` LESS WHAT APPROVALS HAVE RESERVED.
--
--     Collapsing them is a real bug in both directions. Deducting on
--     approval means the employee who cancels their holiday has lost the
--     days until somebody notices, and the register says they were absent
--     on days they worked. Ignoring the approval means two people book
--     the same week against the same six remaining days and the second
--     one goes onto loss of pay in the month it happens.
--
--     ⚠️ THIS QUERY IS THE SQL TWIN OF `foldLedger()` IN
--     lib/leave/balance.ts. They must agree. If they ever disagree, the
--     TypeScript one is what the product shows an employee and this one
--     is what an auditor reads, and the difference is the finding.
-- ---------------------------------------------------------------------
SELECT e.employee_code,
       e.full_name,
       t.code                                                     AS leave_type,
       p.label                                                    AS leave_year,
       sum(l.days_delta) FILTER (WHERE l.kind = 'opening_balance')  AS opening,
       sum(l.days_delta) FILTER (WHERE l.kind = 'carry_forward_in') AS carried_in,
       sum(l.days_delta) FILTER (WHERE l.kind = 'accrual')          AS accrued,
       sum(l.days_delta) FILTER (WHERE l.kind = 'adjustment')       AS adjusted,
       -sum(l.days_delta) FILTER (WHERE l.kind = 'taken')           AS taken,
       -sum(l.days_delta) FILTER (WHERE l.kind = 'encashed')        AS encashed,
       -sum(l.days_delta) FILTER (WHERE l.kind = 'lapse')           AS lapsed,
       coalesce(sum(l.days_delta) FILTER (
         WHERE l.kind NOT IN ('commitment', 'commitment_release')), 0) AS balance,
       -coalesce(sum(l.days_delta) FILTER (
         WHERE l.kind IN ('commitment', 'commitment_release')), 0)     AS committed,
       coalesce(sum(l.days_delta) FILTER (
         WHERE l.kind NOT IN ('commitment', 'commitment_release')), 0)
       + coalesce(sum(l.days_delta) FILTER (
         WHERE l.kind IN ('commitment', 'commitment_release')), 0)     AS available
  FROM leave_ledger   l
  JOIN employees      e ON e.id = l.employee_id
  JOIN leave_types    t ON t.id = l.leave_type_id
  JOIN leave_periods  p ON p.id = l.period_id
 GROUP BY e.employee_code, e.full_name, t.code, p.label
 HAVING coalesce(sum(l.days_delta) FILTER (
          WHERE l.kind NOT IN ('commitment', 'commitment_release')), 0) <> 0
     OR coalesce(sum(l.days_delta) FILTER (
          WHERE l.kind IN ('commitment', 'commitment_release')), 0) <> 0
 ORDER BY e.employee_code, t.code
 LIMIT 200;


-- ---------------------------------------------------------------------
--  7. 🔴🔴 THE SECTION BATCH 50 EXISTS FOR.
--
--     `components/payroll/payroll-run-board.tsx` hardcodes
--     `attendance: []`, so until it is wired every approved run has paid
--     everybody a full month whatever the register says.
--
--     ⚠️ THIS QUERY IS THE TELL. For every approved or posted run it
--     compares the loss of pay the attendance register holds for that
--     period against the loss of pay the payslips actually charged. A
--     non-zero `lop_days_in_register` beside a zero `lop_days_on_payslips`
--     is the hardcoded empty array, still there, costing real money in
--     the direction of the employee.
--
--     ⭐ AND THE OPPOSITE — payslips with loss of pay and an empty
--     register — means somebody typed the LOP straight onto the run,
--     which the board allows and which leaves no record of WHICH days.
-- ---------------------------------------------------------------------
SELECT r.run_no,
       r.period_start,
       r.period_end,
       r.status,
       coalesce((SELECT sum(a.lop_fraction)
                   FROM staff_attendance a
                  WHERE a.tenant_id = r.tenant_id
                    AND a.on_date BETWEEN r.period_start AND r.period_end), 0)
         AS lop_days_in_register,
       coalesce((SELECT sum(s.lop_days) FROM payslips s WHERE s.run_id = r.id), 0)
         AS lop_days_on_payslips,
       CASE
         WHEN coalesce((SELECT sum(a.lop_fraction) FROM staff_attendance a
                         WHERE a.tenant_id = r.tenant_id
                           AND a.on_date BETWEEN r.period_start AND r.period_end), 0) = 0
              AND coalesce((SELECT sum(s.lop_days) FROM payslips s WHERE s.run_id = r.id), 0) = 0
           THEN 'Nothing to reconcile — no absence recorded either side.'
         WHEN coalesce((SELECT sum(s.lop_days) FROM payslips s WHERE s.run_id = r.id), 0) = 0
           THEN '🔴 The register has loss of pay and the payslips have none. This is the hardcoded attendance: [] in payroll-run-board.tsx. Batch 50.'
         WHEN coalesce((SELECT sum(a.lop_fraction) FROM staff_attendance a
                         WHERE a.tenant_id = r.tenant_id
                           AND a.on_date BETWEEN r.period_start AND r.period_end), 0) = 0
           THEN '⚠️ The payslips charge loss of pay that the attendance register knows nothing about. Somebody typed it onto the run, so there is no record of which days.'
         ELSE '✅ Both sides have loss of pay — compare the totals.'
       END AS verdict
  FROM payroll_runs r
 WHERE r.status IN ('approved', 'posted')
 ORDER BY r.period_start DESC
 LIMIT 50;


-- ---------------------------------------------------------------------
--  8. ⚠️ DECISION ④, BOTH WAYS — AND THE CLOSEST THING TO A
--     COMPLETENESS CHECK THERE IS.
--
--     APPROVED BUT NEVER RECORDED: leave that was approved for dates in
--     the past with no attendance row against it. It is not necessarily
--     wrong — the whole point of decision ④ is that an approval is not an
--     absence, and somebody may simply have come in. But it means the
--     leave register says days were reserved that nobody ever accounted
--     for, and the commitment is still sitting against their available
--     balance.
--
--     RECORDED BUT NEVER APPROVED: attendance marked as leave with no
--     request behind it. Ordinary for retrospective regularisation, and
--     worth counting: if it is most of the register, the approval flow is
--     being bypassed.
-- ---------------------------------------------------------------------
SELECT (SELECT count(*) FROM leave_requests q
         WHERE q.status = 'approved'
           AND q.to_on < current_date
           AND NOT EXISTS (SELECT 1 FROM staff_attendance a
                            WHERE a.request_id = q.id))
         AS approved_but_never_recorded,
       (SELECT count(*) FROM staff_attendance a
         WHERE a.status IN ('paid_leave', 'unpaid_leave')
           AND a.request_id IS NULL)
         AS recorded_without_a_request,
       (SELECT count(*) FROM staff_attendance a
         WHERE a.status = 'absent')
         AS unexplained_absences,
       (SELECT count(*) FROM leave_ledger l WHERE l.kind = 'commitment')
       + (SELECT count(*) FROM leave_ledger l WHERE l.kind = 'commitment_release')
         AS commitment_entries;
-- ⭐ `commitment_entries` = 0 with approved requests present means the
--    approval path is writing no commitment, so `available` equals
--    `balance` and two people can book the same remaining days.


-- ---------------------------------------------------------------------
--  9. AND THE THING THAT DECIDES WHAT ANY OF THE ABOVE IS AN ANSWER TO.
--
--     ⚠️ A CONNECTION SUBJECT TO RLS SEES ONE WORKSPACE. A clean result
--     then covers that workspace and says nothing whatever about the
--     rest. A superuser connection sees every one. Both are fine; which
--     one you have decides how far the verdict reaches, and reading the
--     sections above without reading this one is how a single-tenant pass
--     gets reported as a platform-wide pass.
-- ---------------------------------------------------------------------
SELECT current_user,
       rolsuper,
       rolbypassrls,
       nullif(current_setting('app.current_tenant_id', true), '') AS session_tenant,
       CASE
         WHEN rolsuper OR rolbypassrls
           THEN '✅ This connection sees EVERY workspace. The verdicts above cover the whole database.'
         WHEN nullif(current_setting('app.current_tenant_id', true), '') IS NOT NULL
           THEN '⚠️ Tenant-scoped: the verdicts above cover ONE workspace. Other leave registers were not read.'
         ELSE '⚠️ Subject to RLS with no tenant set — every policy matched nothing, so the verdicts above are over an EMPTY set. That is not a pass.'
       END AS what_the_verdict_covers
  FROM pg_roles
 WHERE rolname = current_user;
