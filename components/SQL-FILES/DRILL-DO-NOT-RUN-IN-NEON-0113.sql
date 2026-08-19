-- =====================================================================
--  DRILL , DO NOT RUN THIS IN NEON
-- =====================================================================
--
--  It applies 0113's four tables, seeds two workspaces, and then
--  deliberately tries to break every refusal the file claims, so the
--  refusals can be READ rather than assumed.
--
--     createdb drill0113
--     createuser drill_app --no-superuser --no-createdb --no-createrole
--     psql -q -d drill0113 -f DRILL-DO-NOT-RUN-IN-NEON-0113.sql
--
--  ⚠️ THE DDL IS NOT REPEATED HERE. Apply 0113 first, as the owner.
--  A drill that carried its own copy of the table definitions would test
--  the copy, and the copy is the one thing guaranteed to drift.
--
-- =====================================================================
--  🔴 WHY THIS DRILL HAS TWO ROLES AND NOT ONE
-- =====================================================================
--  Steps 1-4 run as the APPLICATION role, which is where row-level
--  security and the grants bite. A superuser or a role with
--  `rolbypassrls` walks straight past both, so every "MUST BE REFUSED"
--  would pass silently and prove nothing — the failure mode named in
--  `scripts/check-sql-rls-writes.mjs`, where 0092 was reviewed, applied
--  cleanly from a terminal, and still failed in the browser console
--  because it had never been executed as the role that would run it.
--
--  ⭐ STEP 5 RUNS AS THE OWNER, AND IT HAS TO. The application role is
--  granted INSERT and SELECT only on `data_principal_request_events`, so
--  an UPDATE from it is refused by the GRANT and the append-only TRIGGER
--  never fires. A drill that stopped at step 4 would report the table as
--  append-only having never once exercised the trigger — which is
--  precisely what 0087 did when it granted `bank_line_matches` without
--  DELETE citing a guard trigger that did not exist, and which 0102 had
--  to correct.
--
--  🔴 EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows breaks cannot tell "the policy works" from "the
--  table rejects everything", and a table that rejects everything passes
--  every refusal in this file.
-- =====================================================================


-- =====================================================================
--  STEP 0 , REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $guard$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production', 'ordence_prod')
  THEN
    RAISE EXCEPTION
      'REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;

  IF to_regclass('public.data_principal_requests') IS NULL THEN
    RAISE EXCEPTION
      'REFUSING: 0113 has not been applied to "%". Apply it as the owner first; '
      'this drill deliberately does not carry its own copy of the DDL.',
      current_database();
  END IF;
END;
$guard$;


-- =====================================================================
--  STEP 1 , TWO WORKSPACES
-- =====================================================================
INSERT INTO public.tenants (id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Workspace A'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Workspace B')
ON CONFLICT DO NOTHING;


-- =====================================================================
--  STEP 2 , A WRITES. B MUST NOT SEE IT, AND MUST STILL SEE ITS OWN.
--  🔴 RUN THE REST OF THIS FILE AS THE APPLICATION ROLE.
-- =====================================================================
SET app.current_tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';

INSERT INTO public.data_principal_requests
  (tenant_id, reference, kind, principal_label, verified_how)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'DPR-DRILL-A', 'erasure', 'R Sharma',
   'Called back on the number already held against the contact record.');

--  MUST BE 1
SELECT 'A sees its own' AS check, count(*) AS n FROM public.data_principal_requests;

SET app.current_tenant_id = 'bbbbbbbb-0000-0000-0000-000000000002';

--  MUST BE 0 , and the positive control below is what makes the 0 mean
--  something. Zero rows from a broken connection looks identical.
SELECT 'B sees A' AS check, count(*) AS n FROM public.data_principal_requests;

INSERT INTO public.data_principal_requests
  (tenant_id, reference, kind, principal_label, verified_how)
VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002', 'DPR-DRILL-B', 'access', 'Someone Else',
   'Government photo identification checked in person at the site office.');

--  MUST BE 1 , the positive control
SELECT 'B sees its own' AS check, count(*) AS n FROM public.data_principal_requests;

--  MUST BE REFUSED , B annexing a row into A
INSERT INTO public.data_principal_requests
  (tenant_id, reference, kind, principal_label, verified_how)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'DPR-FORGED', 'access', 'Forged',
   'Attempting to write into another workspace entirely.');


-- =====================================================================
--  STEP 3 , THE CONSTRAINTS THAT CARRY THE STATUTE
-- =====================================================================

--  MUST BE REFUSED , a tick is not verification
INSERT INTO public.data_principal_requests
  (tenant_id, reference, kind, principal_label, verified_how)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'DPR-SHORT', 'access', 'X', 'yes');

--  MUST BE REFUSED , answered while something still waits on a person
UPDATE public.data_principal_requests
   SET status = 'answered', needs_human_decision = true, outcome_manifest = '{}'::jsonb
 WHERE reference = 'DPR-DRILL-B';

--  MUST BE REFUSED , answered with no receipt of what was said
UPDATE public.data_principal_requests
   SET status = 'answered', needs_human_decision = false
 WHERE reference = 'DPR-DRILL-B';

--  🔴 MUST BE REFUSED , s.8(7)'s exception is a NAMED-LAW exception, and
--     this constraint is that sentence in the database.
INSERT INTO public.data_principal_request_events
  (tenant_id, request_id, action, table_name)
SELECT tenant_id, id, 'retained', 'sales_invoices'
  FROM public.data_principal_requests WHERE reference = 'DPR-DRILL-B';

--  MUST SUCCEED , the positive control: naming a rule is accepted
INSERT INTO public.data_principal_request_events
  (tenant_id, request_id, action, table_name, retention_rule, because)
SELECT tenant_id, id, 'retained', 'sales_invoices', 'cgst-36',
       'CGST s.36 requires 72 months from the annual return due date.'
  FROM public.data_principal_requests WHERE reference = 'DPR-DRILL-B';


-- =====================================================================
--  STEP 4 , THE BREACH ROW CANNOT BE TIDIED AWAY
-- =====================================================================

--  MUST BE REFUSED , closed with the people untold. s.8(6) requires both.
INSERT INTO public.personal_data_breaches
  (tenant_id, reference, noticed_at, nature, extent, timing_and_location,
   likely_consequences, mitigation_implemented, safeguards_for_principals,
   contact_person, status, board_intimated_at)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'PDB-DRILL-1', now(),
        'n', 'e', 't', 'c', 'm', 's', 'p', 'closed', now());

--  MUST BE REFUSED , recorded as told, with no record of what was said
INSERT INTO public.personal_data_breaches
  (tenant_id, reference, noticed_at, nature, extent, timing_and_location,
   likely_consequences, mitigation_implemented, safeguards_for_principals,
   contact_person, principals_intimated_at)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'PDB-DRILL-2', now(),
        'n', 'e', 't', 'c', 'm', 's', 'p', now());

--  MUST SUCCEED , the positive control
INSERT INTO public.personal_data_breaches
  (tenant_id, reference, noticed_at, nature, extent, timing_and_location,
   likely_consequences, mitigation_implemented, safeguards_for_principals,
   contact_person)
VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'PDB-DRILL-3', now(),
        'n', 'e', 't', 'c', 'm', 's', 'p');


-- =====================================================================
--  STEP 5 , THE APPEND-ONLY TRIGGER , RUN THIS PART AS THE OWNER
-- =====================================================================
--  🔴 AS THE APPLICATION ROLE BOTH STATEMENTS BELOW ARE REFUSED BY THE
--     GRANT AND THE TRIGGER NEVER FIRES. Reconnect as the table owner
--     before running these two, or this step proves the grant twice and
--     the trigger never — the 0087 mistake in a different costume.
--
--     \c - postgres
--     SET app.current_tenant_id = 'bbbbbbbb-0000-0000-0000-000000000002';
--
--  MUST BE REFUSED BY THE TRIGGER, with its own message
UPDATE public.data_principal_request_events SET because = 'rewritten after the fact';

--  MUST BE REFUSED BY THE TRIGGER
DELETE FROM public.data_principal_request_events;

--  MUST STILL BE 1
SELECT 'events survived' AS check, count(*) AS n FROM public.data_principal_request_events;


-- =====================================================================
--  STEP 6 , TEARDOWN
-- =====================================================================
DELETE FROM public.personal_data_breaches
 WHERE reference LIKE 'PDB-DRILL-%';
DELETE FROM public.tenants
 WHERE id IN ('aaaaaaaa-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000002');
