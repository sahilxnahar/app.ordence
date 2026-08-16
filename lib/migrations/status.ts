import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { requirePlatformAdmin } from "@/server/platform/guard";

export type MigrationStatus = {
  num: string;
  fileName: string;
  signature: string;
  present: boolean;
};

export type MigrationsStatusResult = {
  summary: {
    total: number;
    applied: number;
    missing: number;
  };
  migrations: MigrationStatus[];
};

/**
 * Returns the status of migrations 0001..0085.
 * This mirrors the logic in SQL-FILES/WHICH-MIGRATIONS-ARE-APPLIED-neon-safe.sql
 */
export async function getMigrationsStatus(): Promise<MigrationsStatusResult> {
  // This should be a platform-only action
  await requirePlatformAdmin();

  const rows = await withPlatformScope(
    "Check applied migrations for platform console",
    async (tx) => {
      return tx.execute(sql`
        WITH expected (num, file_name, signature, present) AS (
          VALUES
          ('0001', '0001_rls_and_audit_guard.sql', 'policy tenant_self_isolation on tenants', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tenants' AND policyname='tenant_self_isolation'))),
          ('0002', '0002_phase2_rls.sql', 'policy companies_tenant_isolation on companies', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='companies' AND policyname='companies_tenant_isolation'))),
          ('0003', '0003_phase3_rls.sql', 'policy assets_tenant_isolation on assets', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='assets' AND policyname='assets_tenant_isolation'))),
          ('0005', '0005_phase5_controls.sql', 'policy financial_periods_tenant_isolation on financial_periods', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='financial_periods' AND policyname='financial_periods_tenant_isolation'))),
          ('0006', '0006_phase8_storage.sql', 'policy documents_tenant_isolation on documents', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='documents' AND policyname='documents_tenant_isolation'))),
          ('0007', '0007_phase9_portals.sql', 'policy portal_links_tenant_isolation on portal_links', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='portal_links' AND policyname='portal_links_tenant_isolation'))),
          ('0008', '0008_phase10_analytics.sql', 'view v_asset_portfolio', (to_regclass('public.v_asset_portfolio') IS NOT NULL)),
          ('0009', '0009_phase11_billing.sql', 'policy subscriptions_tenant_isolation on subscriptions', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscriptions' AND policyname='subscriptions_tenant_isolation'))),
          ('0011', '0011_phase19_telemetry.sql', 'view telemetry_daily', (to_regclass('public.telemetry_daily') IS NOT NULL)),
          ('0012', '0012_phase20_secops.sql', 'policy security_events_tenant_isolation on security_events', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='security_events' AND policyname='security_events_tenant_isolation'))),
          ('0013', '0013_phase15_metering.sql', 'policy usage_counters_tenant_isolation on usage_counters', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='usage_counters' AND policyname='usage_counters_tenant_isolation'))),
          ('0014', '0014_phase17_platform.sql', 'policy platform_staff_platform_only on platform_staff', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_staff' AND policyname='platform_staff_platform_only'))),
          ('0015', '0015_phase16_invoicing.sql', 'index invoices_one_per_period', (to_regclass('public.invoices_one_per_period') IS NOT NULL)),
          ('0016', '0016_phase22_sales.sql', 'index projects_id_tenant_key', (to_regclass('public.projects_id_tenant_key') IS NOT NULL)),
          ('0017', '0017_change_log.sql', 'table change_log', (to_regclass('public.change_log') IS NOT NULL)),
          ('0018', '0018_phase23_workflows.sql', 'table workflows', (to_regclass('public.workflows') IS NOT NULL)),
          ('0019', '0019_phase24_dynamic_objects.sql', 'table dynamic_objects', (to_regclass('public.dynamic_objects') IS NOT NULL)),
          ('0020', '0020_phase25_views.sql', 'table saved_views', (to_regclass('public.saved_views') IS NOT NULL)),
          ('0021', '0021_phase32_gst.sql', 'table gst_registrations', (to_regclass('public.gst_registrations') IS NOT NULL)),
          ('0022', '0022_phase29_admin_console.sql', 'index platform_action_log_created_idx', (to_regclass('public.platform_action_log_created_idx') IS NOT NULL)),
          ('0023', '0023_phase33_purchases.sql', 'table vendors', (to_regclass('public.vendors') IS NOT NULL)),
          ('0024', '0024_phase34_gstr2b.sql', 'table gstr2b_documents', (to_regclass('public.gstr2b_documents') IS NOT NULL)),
          ('0025', '0025_phase36_tds.sql', 'table tds_deductees', (to_regclass('public.tds_deductees') IS NOT NULL)),
          ('0026', '0026_phase37_tally.sql', 'table tally_connections', (to_regclass('public.tally_connections') IS NOT NULL)),
          ('0027', '0027_phase38_receivables.sql', 'table receivable_policies', (to_regclass('public.receivable_policies') IS NOT NULL)),
          ('0028', '0028_phase39_orders.sql', 'function ordence_freeze_confirmed_order_line()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_freeze_confirmed_order_line'))),
          ('0029', '0029_phase40_inventory.sql', 'function ordence_stock_ledger_append_only()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_stock_ledger_append_only'))),
          ('0030', '0030_phase42_land.sql', 'function ordence_guard_title_chain()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_guard_title_chain'))),
          ('0031', '0031_phase44_ra_bills.sql', 'function ordence_compute_ra_bill()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_compute_ra_bill'))),
          ('0032', '0032_engine4_compliance.sql', 'index compliance_obligations_own_code_key', (to_regclass('public.compliance_obligations_own_code_key') IS NOT NULL)),
          ('0033', '0033_engine1_scheduling.sql', 'column schedule_blocks.capacity_hint', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='schedule_blocks' AND column_name='capacity_hint'))),
          ('0034', '0034_engine2_pricing.sql', 'function rate_slabs_validate_set()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='rate_slabs_validate_set'))),
          ('0035', '0035_engine5_metering.sql', 'function ordence_meter_consumption()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_meter_consumption'))),
          ('0036', '0036_engine3_field_ops.sql', 'function ordence_haversine_m()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_haversine_m'))),
          ('0037', '0037_engine6_vault.sql', 'function vault_reject_plaintext()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='vault_reject_plaintext'))),
          ('0038', '0038_construction_labour.sql', 'index site_attendance_worker_punch_key', (to_regclass('public.site_attendance_worker_punch_key') IS NOT NULL)),
          ('0039', '0039_tables_paste_only.sql', 'table rate_cards', (to_regclass('public.rate_cards') IS NOT NULL)),
          ('0040', '0040_stock_reservation_floor.sql', 'function ordence_guard_stock_floor()', (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='ordence_guard_stock_floor'))),
          ('0041', '0041_contracting_depth.sql', 'column boqs.contract_id', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='boqs' AND column_name='contract_id'))),
          ('0042', '0042_mcp_access.sql', 'table mcp_tokens', (to_regclass('public.mcp_tokens') IS NOT NULL)),
          ('0043', '0043_engine1_engine4_tables.sql', 'table compliance_obligations', (to_regclass('public.compliance_obligations') IS NOT NULL)),
          ('0044', '0044_tenant_patterns.sql', 'table tenant_patterns', (to_regclass('public.tenant_patterns') IS NOT NULL)),
          ('0045', '0045_notifications.sql', 'table notifications', (to_regclass('public.notifications') IS NOT NULL)),
          ('0046', '0046_deployment_flows_governance.sql', 'table deployment_releases', (to_regclass('public.deployment_releases') IS NOT NULL)),
          ('0047', '0047_grant_missing_views.sql', 'role ordence_app', (EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordence_app'))),
          ('0048', '0048_credit_limits.sql', 'table customer_credit_profiles', (to_regclass('public.customer_credit_profiles') IS NOT NULL)),
          ('0049', '0049_sales_invoices.sql', 'table sales_invoices', (to_regclass('public.sales_invoices') IS NOT NULL)),
          ('0050', '0050_sales_credit_notes.sql', 'table sales_credit_notes', (to_regclass('public.sales_credit_notes') IS NOT NULL)),
          ('0051', '0051_sales_posting_accounts.sql', 'table sales_posting_accounts', (to_regclass('public.sales_posting_accounts') IS NOT NULL)),
          ('0052', '0052_booking_possession.sql', 'column bookings.possession_date', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='possession_date'))),
          ('0053', '0053_time_and_billing.sql', 'table billing_rates', (to_regclass('public.billing_rates') IS NOT NULL)),
          ('0054', '0054_eway_bills.sql', 'table eway_bills', (to_regclass('public.eway_bills') IS NOT NULL)),
          ('0055', '0055_batch_serial_returns.sql', 'table stock_batches', (to_regclass('public.stock_batches') IS NOT NULL)),
          ('0056', '0056_transfers_landed_cost.sql', 'table stock_transfers', (to_regclass('public.stock_transfers') IS NOT NULL)),
          ('0057', '0057_pricing_discounts.sql', 'table price_agreements', (to_regclass('public.price_agreements') IS NOT NULL)),
          ('0058', '0058_legal_matters.sql', 'table legal_matters', (to_regclass('public.legal_matters') IS NOT NULL)),
          ('0059', '0059_court_fees_disbursements.sql', 'table court_fee_schedules', (to_regclass('public.court_fee_schedules') IS NOT NULL)),
          ('0060', '0060_tasks_activities_calendar.sql', 'table tasks', (to_regclass('public.tasks') IS NOT NULL)),
          ('0061', '0061_crm_consent_messaging.sql', 'table lead_sources', (to_regclass('public.lead_sources') IS NOT NULL)),
          ('0063', '0063_purchase_orders_payments.sql', 'table purchase_orders', (to_regclass('public.purchase_orders') IS NOT NULL)),
          ('0064', '0064_integration_frame.sql', 'table connections', (to_regclass('public.connections') IS NOT NULL)),
          ('0065', '0065_lead_intake.sql', 'table lead_intake_failures', (to_regclass('public.lead_intake_failures') IS NOT NULL)),
          ('0066', '0066_utility_messaging.sql', 'table message_templates', (to_regclass('public.message_templates') IS NOT NULL)),
          ('0067', '0067_campaigns.sql', 'table campaigns', (to_regclass('public.campaigns') IS NOT NULL)),
          ('0068', '0068_order_rhythm.sql', 'table customer_rhythms', (to_regclass('public.customer_rhythms') IS NOT NULL)),
          ('0069', '0069_connection_probes.sql', 'column sync_runs.is_probe', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sync_runs' AND column_name='is_probe'))),
          ('0070', '0070_bank_reconciliation.sql', 'table bank_accounts', (to_regclass('public.bank_accounts') IS NOT NULL)),
          ('0071', '0071_tenant_agents.sql', 'table agent_definitions', (to_regclass('public.agent_definitions') IS NOT NULL)),
          ('0073', '0073_period_lock_and_reorder.sql', 'column stock_items.preferred_vendor_id', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items' AND column_name='preferred_vendor_id'))),
          ('0074', '0074_platform_control.sql', 'table platform_approval_queue', (to_regclass('public.platform_approval_queue') IS NOT NULL)),
          ('0075', '0075_payroll.sql', 'table employees', (to_regclass('public.employees') IS NOT NULL)),
          ('0077', '0077_monthly_return.sql', 'table gst_returns', (to_regclass('public.gst_returns') IS NOT NULL)),
          ('0078', '0078_real_estate_completion.sql', 'table channel_partner_commissions', (to_regclass('public.channel_partner_commissions') IS NOT NULL)),
          ('0079', '0079_rls_opt_in_and_telemetry.sql', 'policy platform_action_log_platform_only on platform_action_log', (EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_action_log' AND policyname='platform_action_log_platform_only'))),
          ('0080', '0080_orders_place_of_supply.sql', 'column sales_orders.supply_type', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders' AND column_name='supply_type'))),
          ('0081', '0081_audit_hash_chain.sql', 'column audit_logs.chain_seq', (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='chain_seq'))),
          ('0082', '0082_leave_and_attendance.sql', 'table leave_periods', (to_regclass('public.leave_periods') IS NOT NULL)),
          ('0083', '0083_credit_control_and_dunning.sql', 'table credit_hold_events', (to_regclass('public.credit_hold_events') IS NOT NULL)),
          ('0084', '0084_cost_centres_and_budgets.sql', 'table cost_centres', (to_regclass('public.cost_centres') IS NOT NULL)),
          ('0085', '0085_appraisals_and_org.sql', 'table reporting_lines', (to_regclass('public.reporting_lines') IS NOT NULL))
        )
        SELECT num, file_name, signature, present FROM expected ORDER BY num;
      `);
    },
  );

  const migrations = rows.rows as unknown as MigrationStatus[];

  const applied = migrations.filter((m) => m.present).length;
  const missing = migrations.filter((m) => !m.present).length;

  return {
    summary: {
      total: migrations.length,
      applied,
      missing,
    },
    migrations,
  };
}
