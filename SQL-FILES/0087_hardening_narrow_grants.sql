-- ############################################################################
-- 0087 — NARROW GRANTS FOR THE 0070–0085 MODULES (Hardening I / v1.49.0-alpha)
-- ############################################################################
--
-- PURPOSE
-- -------
-- The baseline grant (ALL-IN-ONE-SETUP.sql, Section 6) and every module file
-- that followed it rely on the same discipline: REVOKE to nothing, then grant
-- exactly what the application role needs. That discipline was carried module
-- by module through the platform waves — billing (plans is read-only),
-- usage (counters INSERT-only), security ops (SELECT/INSERT only) — but the
-- six later module files (0070 through 0085: banking, agents, platform
-- control, payroll, GST, real-estate commissions, leave & attendance, credit
-- control, cost centres, appraisals) never got their own REVOKE-and-narrow
-- block. As shipped, the application role holds whatever the blanket grant
-- said — which on any deployment that ever ran `GRANT ALL ON ALL TABLES` is
-- everything: DELETE on payroll history, UPDATE on ledger evidence, the lot.
--
-- This file closes that gap in one pass, table by table, with the reason for
-- every privilege next to it. It is the HARDENING-I half of the wave: the
-- middleware, CORS and cookie work is the other half, and the VERIFY pair
-- reads the grants back without touching data.
--
-- RUN ORDER
-- ---------
-- Glob-sorted after 0086; it must not run before the tables exist (it is
-- idempotent — CREATE TABLE IF NOT EXISTS is not needed because the tables
-- are created by the earlier files, and every statement here tolerates the
-- role being absent via the role-existence guard).
--
-- ROLE
-- ----
-- `ordence_app` is the application role the codebase connects as.
-- ---------------------------------------------------------------------------
-- ⚠️ REVOKE FIRST. THIS IS NOT DEFENSIVE PADDING.
-- ---------------------------------------------------------------------------
-- A GRANT block that only ever ADDS privileges is worthless as a restriction.
-- If the application role already holds DELETE on `payslips` from a blanket
-- grant, granting SELECT, INSERT below changes NOTHING — and the history
-- stays deleteable. Every table in this file is revoked to nothing first.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  -- The whole block is a no-op on deployments where the role does not exist
  -- yet. Nothing is narrowed that was never granted in the first place.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN

    -- ==================================================================
    -- BANKING (0070) — ingested evidence, not working data
    -- ==================================================================
    REVOKE ALL ON bank_accounts        FROM ordence_app;
    REVOKE ALL ON bank_statements      FROM ordence_app;
    REVOKE ALL ON bank_statement_lines FROM ordence_app;
    REVOKE ALL ON bank_line_matches    FROM ordence_app;
    -- Accounts are working data (reclassification, closure flags).
    GRANT SELECT, INSERT, UPDATE ON bank_accounts TO ordence_app;
    -- Statements and their lines are ingested evidence. The import is
    -- INSERT; a re-import overwrites via the upsert path in the service,
    -- which the import role may hold — the application has no business
    -- rewriting what the bank sent.
    GRANT SELECT, INSERT ON bank_statements      TO ordence_app;
    GRANT SELECT, INSERT ON bank_statement_lines TO ordence_app;
    -- Matches are append-only reconciliation evidence; the guard trigger
    -- fires for UPDATE/DELETE regardless, and the privilege layer is the
    -- belt to its braces.
    GRANT SELECT, INSERT ON bank_line_matches TO ordence_app;

    -- ==================================================================
    -- TENANT AGENTS (0071) — one autonomy guard, otherwise working data
    -- ==================================================================
    REVOKE ALL ON agent_definitions FROM ordence_app;
    REVOKE ALL ON agent_runs        FROM ordence_app;
    REVOKE ALL ON agent_triggers    FROM ordence_app;
    GRANT SELECT, INSERT, UPDATE ON agent_definitions TO ordence_app;
    -- Runs are append-only ledger rows (`state` moves only through the
    -- service's guarded transitions, and the autonomy trigger refuses
    -- self-approval writes); DELETE has no legitimate use — a run's
    -- history is evidence of what the agent did.
    GRANT SELECT, INSERT, UPDATE ON agent_runs TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_triggers TO ordence_app;

    -- ==================================================================
    -- PLATFORM CONTROL (0074) — platform-only tables
    -- ==================================================================
    REVOKE ALL ON platform_approval_queue    FROM ordence_app;
    REVOKE ALL ON platform_entitlement_history FROM ordence_app;
    REVOKE ALL ON platform_incidents         FROM ordence_app;
    REVOKE ALL ON tenant_health_events       FROM ordence_app;
    -- The approval queue is platform staff working data.
    GRANT SELECT, INSERT, UPDATE, DELETE ON platform_approval_queue TO ordence_app;
    -- Entitlement history, incidents and health events are platform
    -- evidence: append-only in intent, soft-mutable for platform staff
    -- resolving an incident. DELETE is never legitimate — evidence
    -- about what happened to tenants is not something to erase.
    GRANT SELECT, INSERT, UPDATE ON platform_entitlement_history TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON platform_incidents           TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON tenant_health_events         TO ordence_app;

    -- ==================================================================
    -- PAYROLL (0075) — the money tables
    -- ==================================================================
    REVOKE ALL ON employee_pay_structure FROM ordence_app;
    REVOKE ALL ON employees              FROM ordence_app;
    REVOKE ALL ON pay_components         FROM ordence_app;
    REVOKE ALL ON payroll_runs           FROM ordence_app;
    REVOKE ALL ON payslips               FROM ordence_app;
    REVOKE ALL ON statutory_rates        FROM ordence_app;
    -- Employees is HR master data; the app never deletes a person —
    -- termination flows through status, and the payroll ledger keeps
    -- referencing them afterwards.
    GRANT SELECT, INSERT, UPDATE ON employees TO ordence_app;
    -- Pay structures, components and statutory rates are configuration;
    -- config changes are UPDATE, catalogues gain entries by INSERT, and
    -- nothing here is deleted — a deleted rate silently re-prices every
    -- historical computation that referenced it.
    GRANT SELECT, INSERT, UPDATE ON employee_pay_structure TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON pay_components         TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON statutory_rates        TO ordence_app;
    -- Runs carry state while open (open → computing → posted) and are
    -- soft-frozen by trigger afterwards; DELETE would orphan the payslips.
    GRANT SELECT, INSERT, UPDATE ON payroll_runs TO ordence_app;
    -- Payslips: generated by INSERT during a run; the frozen-payslip
    -- trigger refuses UPDATE of a posted payslip at the trigger layer,
    -- and the privilege layer adds the belt — no UPDATE, no DELETE. A
    -- hard DELETE of a posted payslip removes the document the employee
    -- received, which is not recoverable and not justifiable.
    GRANT SELECT, INSERT ON payslips TO ordence_app;

    -- ==================================================================
    -- GST (0077) — returns are filed state machines
    -- ==================================================================
    REVOKE ALL ON gst_returns FROM ordence_app;
    -- State moves draft → filed through the service; the filed-return
    -- guard refuses edits to a filed return. DELETE is never legitimate —
    -- a deleted return is a deleted filing.
    GRANT SELECT, INSERT, UPDATE ON gst_returns TO ordence_app;

    -- ==================================================================
    -- REAL-ESTATE COMMISSIONS (0078)
    -- ==================================================================
    REVOKE ALL ON channel_partner_commissions FROM ordence_app;
    -- Status moves through the commission state machine; posted
    -- cancellations are refused by trigger. No DELETE — commission
    -- history is the audit trail of partner payouts.
    GRANT SELECT, INSERT, UPDATE ON channel_partner_commissions TO ordence_app;

    -- ==================================================================
    -- LEAVE & ATTENDANCE (0082)
    -- ==================================================================
    REVOKE ALL ON holiday_calendar   FROM ordence_app;
    REVOKE ALL ON leave_ledger       FROM ordence_app;
    REVOKE ALL ON leave_periods      FROM ordence_app;
    REVOKE ALL ON leave_requests     FROM ordence_app;
    REVOKE ALL ON leave_types        FROM ordence_app;
    REVOKE ALL ON staff_attendance   FROM ordence_app;
    -- Calendars and types are configuration.
    GRANT SELECT, INSERT, UPDATE ON holiday_calendar TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON leave_types      TO ordence_app;
    -- Periods are admin configuration, mutable.
    GRANT SELECT, INSERT, UPDATE ON leave_periods TO ordence_app;
    -- Requests move through approval state and are mutable until final.
    GRANT SELECT, INSERT, UPDATE ON leave_requests TO ordence_app;
    -- The leave ledger is append-only by trigger (leave_ledger_no_update /
    -- leave_ledger_no_delete): every balance change is a new row. The
    -- privilege layer matches the trigger — INSERT only.
    GRANT SELECT, INSERT ON leave_ledger TO ordence_app;
    -- Attendance is working data; the frozen-period trigger refuses edits
    -- inside closed periods, and UPDATE on open periods is legitimate.
    GRANT SELECT, INSERT, UPDATE ON staff_attendance TO ordence_app;

    -- ==================================================================
    -- CREDIT CONTROL & DUNNING (0083)
    -- ==================================================================
    REVOKE ALL ON credit_dunning_ladders FROM ordence_app;
    REVOKE ALL ON credit_dunning_log     FROM ordence_app;
    REVOKE ALL ON credit_dunning_stages  FROM ordence_app;
    REVOKE ALL ON credit_hold_events     FROM ordence_app;
    REVOKE ALL ON credit_hold_overrides  FROM ordence_app;
    -- Configuration and state machines.
    GRANT SELECT, INSERT, UPDATE ON credit_dunning_ladders TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON credit_dunning_stages  TO ordence_app;
    -- Holds and overrides are the credit working data.
    GRANT SELECT, INSERT, UPDATE ON credit_hold_events    TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON credit_hold_overrides TO ordence_app;
    -- The dunning log is append-only evidence: every stage the account
    -- passed through, in order. The privilege layer is the belt for the
    -- trigger's braces.
    GRANT SELECT, INSERT ON credit_dunning_log TO ordence_app;

    -- ==================================================================
    -- COST CENTRES & BUDGETS (0084)
    -- ==================================================================
    REVOKE ALL ON cost_centres FROM ordence_app;
    REVOKE ALL ON budget_lines FROM ordence_app;
    -- Working data with a period-lock trigger on budget lines; config
    -- changes and re-allocations are UPDATE, deletions are soft.
    GRANT SELECT, INSERT, UPDATE ON cost_centres TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON budget_lines TO ordence_app;

    -- ==================================================================
    -- APPRAISALS & ORG STRUCTURE (0085)
    -- ==================================================================
    REVOKE ALL ON appraisal_amendments FROM ordence_app;
    REVOKE ALL ON appraisal_cycles     FROM ordence_app;
    REVOKE ALL ON appraisal_reviews    FROM ordence_app;
    REVOKE ALL ON appraisal_subjects   FROM ordence_app;
    REVOKE ALL ON reporting_lines      FROM ordence_app;
    -- Cycles, reviews and subjects are state machines with signoff
    -- freezes; mutable while the flow is open.
    GRANT SELECT, INSERT, UPDATE ON appraisal_cycles     TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON appraisal_reviews    TO ordence_app;
    GRANT SELECT, INSERT, UPDATE ON appraisal_subjects   TO ordence_app;
    -- Org structure is admin working data.
    GRANT SELECT, INSERT, UPDATE, DELETE ON reporting_lines TO ordence_app;
    -- Amendments are the signoff-history audit log: append-only by
    -- trigger (appraisal_amendments_append_only).
    GRANT SELECT, INSERT ON appraisal_amendments TO ordence_app;

    -- ==================================================================
    -- SEQUENCES — USAGE for the application to generate IDs where needed
    -- ==================================================================
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ordence_app;

    -- ==================================================================
    -- FUNCTIONS — default PUBLIC execute is revoked; the documented
    -- surface is re-granted. Two tiers:
    --   1. RLS/tenant-context functions: needed by every request,
    --      including the connection-pooler's health probes, so PUBLIC.
    --   2. The application surface: the functions each module explicitly
    --      GRANTs (below). Guard triggers stay reachable from the table
    --      layer via SECURITY DEFINER ownership; arbitrary sessions
    --      cannot call them directly.
    -- ==================================================================
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ordence_app;

    GRANT EXECUTE ON FUNCTION app_current_tenant_id()          TO PUBLIC;
    GRANT EXECUTE ON FUNCTION app_current_impersonation_id()   TO PUBLIC;
    GRANT EXECUTE ON FUNCTION app_is_platform_scope()          TO PUBLIC;
    GRANT EXECUTE ON FUNCTION app_platform_scope()             TO PUBLIC;
    GRANT EXECUTE ON FUNCTION app_origin_id()                  TO PUBLIC;

    -- Application surface — re-granted to ordence_app so module queries
    -- and their guard-trigger chains keep working after the PUBLIC revoke.
    -- Signatures copied verbatim from the modules that GRANT them.
    GRANT EXECUTE ON FUNCTION claim_due_workflow_runs(uuid, integer)            TO ordence_app;
    GRANT EXECUTE ON FUNCTION expire_workflow_tasks(uuid)                       TO ordence_app;
    GRANT EXECUTE ON FUNCTION release_expired_unit_holds(uuid)                  TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_close_meter_period(uuid, uuid)            TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_vault_erase(uuid, uuid, text)             TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_price_slabs(uuid, uuid, bigint)           TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_quote_rate(uuid, uuid, bigint)            TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_select_rate_card
        (uuid, character varying, uuid, uuid, character varying, date)          TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_meter_consumption(numeric, numeric, integer, numeric) TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_haversine_m(numeric, numeric, numeric, numeric)       TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_apply_bps(bigint, integer)                TO ordence_app;
    GRANT EXECUTE ON FUNCTION ordence_div_round_half_up(bigint, bigint)         TO ordence_app;
    GRANT EXECUTE ON FUNCTION indian_financial_year(date)                       TO ordence_app;
    GRANT EXECUTE ON FUNCTION indian_financial_year(timestamp with time zone)   TO ordence_app;
    GRANT EXECUTE ON FUNCTION is_valid_gstin(text)                              TO ordence_app;
    GRANT EXECUTE ON FUNCTION gstin_check_character(text)                       TO ordence_app;
    GRANT EXECUTE ON FUNCTION itc_claim_deadline_period(date)                   TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_quarter_of(date)                              TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_return_due_date(character varying, tds_quarter) TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_deposit_due_date(date, tds_section)           TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_annual_threshold_minor(tds_section)           TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_section_206aa_floor_bps(tds_section)          TO ordence_app;
    GRANT EXECUTE ON FUNCTION tds_section_aggregates_whole(tds_section)         TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_create_object_table(uuid, text)           TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_drop_object_table(uuid, text, bigint)     TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_add_field_column
        (uuid, text, text, text, boolean, boolean, boolean, text[], text, text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_drop_field_column(uuid, text, text)       TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_assert_identifier(text, text)             TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_ddl_name(text, text, text)                TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_is_reserved_word(text)                    TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_pg_type(text)                             TO ordence_app;
    -- ------------------------------------------------------------------
    -- 🔴 prune_security_events(integer, boolean) IS DELIBERATELY ABSENT
    -- ------------------------------------------------------------------
    -- This line used to read:
    --
    --     GRANT EXECUTE ON FUNCTION prune_security_events(integer, boolean) TO ordence_app;
    --
    -- It was wrong, and it was wrong for four waves. The method above,
    -- "signatures copied verbatim from the modules that GRANT them", is
    -- correct for the twenty-nine other entries on this list, because
    -- their modules grant them to ordence_app. 0012_phase20_secops.sql
    -- grants THIS one to ordence_maintenance, directly under a comment
    -- that says the web application must never hold it:
    --
    --     -- Explicitly NOT granted: EXECUTE on prune_security_events().
    --     -- The web application must not be able to delete security
    --     -- history under any circumstances, including via a function
    --     -- that is allowed to.
    --
    -- The signature was copied; the role was not read. The function is
    -- SECURITY DEFINER and is the one sanctioned way past the
    -- append-only trigger, so EXECUTE on it defeats the append-only
    -- table privileges granted eighty lines above, entirely.
    --
    -- The REVOKE at the top of this block already removes it from
    -- ordence_app on any database that ran the old version of this file,
    -- but that only holds for a database that re-runs 0087. For a
    -- database that ran 0087 once and moved on,
    -- 0121_revoke_prune_from_app_role.sql is the repair.
    --
    -- The permanent control is `npm run check:sealed-grants` (gate 25),
    -- which fails the build if this line , or anything like it , comes
    -- back in any .sql file in the repository.
    --
    -- ordence_maintenance's grant from 0012 survives: the REVOKE above
    -- names PUBLIC and ordence_app only.
    -- ------------------------------------------------------------------

  END IF;
END
$$;

COMMIT;
