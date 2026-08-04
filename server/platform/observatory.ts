"use server";

/**
 * Ordence — Platform Health & Revenue Observatory
 * Version: v0.32.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHY CLOUDFLARE CANNOT GIVE IT TO YOU
 * ══════════════════════════════════════════════════════════════════════════
 * Cloudflare's dashboard reports on a WORKER. One worker serves every tenant,
 * so its graphs answer "is the platform up" and nothing else. They cannot say
 * which tenant is generating the errors, which tenant is eating the shared
 * request budget, or which tenant has gone quiet and is about to churn —
 * because Cloudflare has no idea tenants exist.
 *
 * This module answers those, by aggregating rows the application already
 * writes: `errorEvents`, `webVitalEvents`, `usageCounters`, `usageLevels`,
 * `subscriptions`, `tenants`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY QUERY HERE CROSSES TENANT BOUNDARIES ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════════
 * That is the entire point of the screen, and it is also the most dangerous
 * thing in the codebase. Three rules hold it in place:
 *
 *   1. `withPlatformScope()` — the ONLY way to read across tenants. It sets
 *      `app.platform_scope` transaction-locally, requires a written
 *      justification, and is itself audited.
 *   2. `requireCapability("observatory:read")` runs FIRST, every time. No
 *      cached operator, no "the page already checked".
 *   3. AGGREGATES ONLY. Counts, sums, timestamps. No lead, no contact, no
 *      invoice line, no message body ever leaves this module. If a future
 *      change needs a customer record here, it belongs in the per-tenant
 *      insights screen behind impersonation and consent — not here.
 *
 * Rule 3 is the one that will be under pressure, because "just show me the
 * deal that errored" is a reasonable-sounding request. It is still a
 * cross-tenant record read, and the answer is still no.
 */

import { sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { requireCapability, recordPlatformAudit } from "./guard";
import type { PlatformResult } from "@/lib/platform/schemas";

/* ------------------------------------------------------------------ */
/* THE FREE-TIER BUDGET                                                */
/* ------------------------------------------------------------------ */

/**
 * Cloudflare's free plan allows 100,000 Worker requests per DAY, shared
 * across every tenant on the account.
 *
 * ⚠️ This is a platform-wide ceiling, not a per-tenant one, which makes it
 * behave unlike every other limit in the system: one tenant's bad afternoon
 * takes everybody else down with it. That is why the burn-down is on this
 * screen and not in each tenant's own usage panel — the tenant cannot see
 * the number that will actually break them.
 *
 * Set `ORDENCE_DAILY_REQUEST_BUDGET` once on a paid plan.
 */
function dailyRequestBudget(): number {
  const raw = (process.env as Record<string, string | undefined>)[
    "ORDENCE_DAILY_REQUEST_BUDGET"
  ];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000;
}

/** A tenant silent this long is the churn siren's trigger. */
const SILENT_DAYS_BEFORE_ALARM = 14;

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type ObservatoryTotals = {
  tenants: number;
  activeTenants: number;
  suspendedTenants: number;
  trialTenants: number;
  /** Minor units, as a STRING — bigint does not survive a server→client hop. */
  mrrMinor: string;
  currency: string;
  requestsToday: number;
  requestBudget: number;
  /** 0–100, clamped. Above 80 is where a free plan starts refusing people. */
  budgetUsedPct: number;
  errorsLast24h: number;
  /** Errors per thousand requests. The number that means something. */
  errorRatePerK: number;
};

export type TenantVital = {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  planTier: string;
  mrrMinor: string;
  requestsToday: number;
  /** Share of the SHARED daily budget this one tenant is consuming. */
  budgetSharePct: number;
  errors24h: number;
  p75LcpMs: number | null;
  storageUsedMb: number;
  storageLimitMb: number;
  storagePct: number;
  lastActivityAt: string | null;
  daysSilent: number | null;
  /** Ranked reasons this tenant needs attention. Empty means healthy. */
  alarms: string[];
};

export type FeatureAdoption = {
  metric: string;
  tenantsUsing: number;
  tenantsTotal: number;
  adoptionPct: number;
  totalEvents: number;
};

export type CohortRetention = {
  cohortMonth: string;
  tenantsStarted: number;
  stillActive: number;
  retentionPct: number;
};

export type Observatory = {
  generatedAt: string;
  totals: ObservatoryTotals;
  vitals: TenantVital[];
  adoption: FeatureAdoption[];
  cohorts: CohortRetention[];
  /** Tenants whose alarms are non-empty, worst first. */
  needsAttention: TenantVital[];
};

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/**
 * Postgres returns `count()` and `sum()` as bigint, which arrives here as a
 * string. Every one of these needs the same defensive read, so it lives in
 * one place rather than being re-derived at thirty call sites.
 */
function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** bigint money stays a string all the way to the browser. */
function minor(value: unknown): string {
  if (value === null || value === undefined) return "0";
  return String(value);
}

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  const raw = (part / whole) * 100;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/* ------------------------------------------------------------------ */
/* THE QUERY                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the whole observatory in ONE platform-scoped transaction.
 *
 * ⚠️ One transaction, not six. Six would each open a connection, each pay
 * the platform-scope audit cost, and — worse — each see a slightly different
 * instant, so the totals row would not add up to the tenant rows underneath
 * it. A cockpit whose summary disagrees with its own table teaches operators
 * to distrust it, and a distrusted dashboard is worse than no dashboard.
 */
export async function getObservatory(): Promise<PlatformResult<Observatory>> {
  const operator = await requireCapability("observatory:read");

  try {
    const budget = dailyRequestBudget();

    const data = await withPlatformScope(
      "Platform Health and Revenue Observatory: cross-tenant aggregates only, no record-level customer data.",
      async (tx) => {
        /* ── 1. Fleet totals and revenue ──────────────────────────────── */
        const totalsRows = await tx.execute(sql`
          SELECT
            count(*)::bigint                                              AS tenants,
            count(*) FILTER (WHERE t.status = 'active')::bigint           AS active,
            count(*) FILTER (WHERE t.status = 'suspended')::bigint        AS suspended,
            count(*) FILTER (WHERE s.status = 'trialing')::bigint         AS trialing,
            COALESCE(SUM(
              CASE WHEN s.status IN ('active','trialing','past_due')
                   THEN COALESCE(s.unit_amount_minor, 0)
                      + COALESCE(s.per_seat_amount_minor, 0)
                        * COALESCE(s.seats_purchased, 0)
                   ELSE 0 END
            ), 0)::bigint                                                 AS mrr_minor,
            COALESCE(MAX(s.currency), 'INR')                              AS currency
          FROM tenants t
          LEFT JOIN subscriptions s ON s.tenant_id = t.id
        `);
        const totalsRow = (totalsRows as unknown as Array<Record<string, unknown>>)[0] ?? {};

        /* ── 2. Requests today and errors, per tenant ─────────────────────
         *
         * `usage_counters` is the request meter the application already
         * increments. Reading it here rather than asking Cloudflare is what
         * makes the number attributable to a tenant at all.
         */
        const vitalRows = await tx.execute(sql`
          WITH reqs AS (
            SELECT tenant_id, COALESCE(SUM(quantity), 0)::bigint AS requests
              FROM usage_counters
             WHERE metric = 'api_requests'
               AND occurred_at >= date_trunc('day', now())
             GROUP BY tenant_id
          ),
          errs AS (
            SELECT tenant_id, count(*)::bigint AS errors
              FROM error_events
             WHERE occurred_at >= now() - interval '24 hours'
             GROUP BY tenant_id
          ),
          lcp AS (
            SELECT tenant_id,
                   percentile_disc(0.75) WITHIN GROUP (ORDER BY value)::numeric AS p75
              FROM web_vital_events
             WHERE metric = 'LCP'
               AND occurred_at >= now() - interval '24 hours'
             GROUP BY tenant_id
          ),
          store AS (
            SELECT tenant_id,
                   COALESCE(MAX(used_mb), 0)::numeric  AS used_mb,
                   COALESCE(MAX(limit_mb), 0)::numeric AS limit_mb
              FROM usage_levels
             WHERE metric = 'storage_mb'
             GROUP BY tenant_id
          )
          SELECT
            t.id, t.slug, t.name, t.status,
            COALESCE(s.plan_tier, 'free')                       AS plan_tier,
            (COALESCE(s.unit_amount_minor, 0)
             + COALESCE(s.per_seat_amount_minor, 0)
               * COALESCE(s.seats_purchased, 0))::bigint        AS mrr_minor,
            COALESCE(reqs.requests, 0)::bigint                  AS requests_today,
            COALESCE(errs.errors, 0)::bigint                    AS errors_24h,
            lcp.p75                                             AS p75_lcp,
            COALESCE(store.used_mb, 0)                          AS storage_used_mb,
            COALESCE(store.limit_mb, 0)                         AS storage_limit_mb,
            t.last_activity_at
          FROM tenants t
          LEFT JOIN subscriptions s ON s.tenant_id = t.id
          LEFT JOIN reqs  ON reqs.tenant_id  = t.id
          LEFT JOIN errs  ON errs.tenant_id  = t.id
          LEFT JOIN lcp   ON lcp.tenant_id   = t.id
          LEFT JOIN store ON store.tenant_id = t.id
          ORDER BY COALESCE(reqs.requests, 0) DESC, t.name ASC
          LIMIT 500
        `);

        /* ── 3. Feature adoption ──────────────────────────────────────────
         *
         * "Which modules earn their keep." A metric nobody meters is a
         * module nobody uses — and it is cheaper to learn that from a
         * heatmap than from a churn call.
         */
        const adoptionRows = await tx.execute(sql`
          SELECT metric::text                              AS metric,
                 count(DISTINCT tenant_id)::bigint         AS tenants_using,
                 COALESCE(SUM(quantity), 0)::bigint        AS total_events
            FROM usage_counters
           WHERE occurred_at >= now() - interval '30 days'
           GROUP BY metric
           ORDER BY 2 DESC, 3 DESC
        `);

        /* ── 4. Cohort retention by signup month ──────────────────────── */
        const cohortRows = await tx.execute(sql`
          SELECT to_char(date_trunc('month', t.created_at), 'YYYY-MM')     AS cohort_month,
                 count(*)::bigint                                          AS started,
                 count(*) FILTER (
                   WHERE t.status = 'active'
                     AND t.last_activity_at >= now() - interval '30 days'
                 )::bigint                                                 AS still_active
            FROM tenants t
           GROUP BY 1
           ORDER BY 1 DESC
           LIMIT 12
        `);

        return {
          totals: totalsRow,
          vitals: vitalRows as unknown as Array<Record<string, unknown>>,
          adoption: adoptionRows as unknown as Array<Record<string, unknown>>,
          cohorts: cohortRows as unknown as Array<Record<string, unknown>>,
        };
      },
    );

    /* ── Shape it ─────────────────────────────────────────────────────── */

    const tenantCount = num(data.totals.tenants);
    const now = Date.now();

    const vitals: TenantVital[] = data.vitals.map((row) => {
      const requestsToday = num(row.requests_today);
      const errors24h = num(row.errors_24h);
      const storageUsedMb = num(row.storage_used_mb);
      const storageLimitMb = num(row.storage_limit_mb);
      const lastActivityAt = iso(row.last_activity_at);

      const daysSilent = lastActivityAt
        ? Math.floor((now - new Date(lastActivityAt).getTime()) / 86_400_000)
        : null;

      const storagePct = pct(storageUsedMb, storageLimitMb);
      const budgetSharePct = pct(requestsToday, budget);

      /* The alarms. Ordered worst-first deliberately: an operator reads the
       * first line and stops, so the first line has to be the one that
       * costs money. */
      const alarms: string[] = [];
      if (String(row.status) === "suspended") {
        alarms.push("Suspended");
      }
      if (daysSilent !== null && daysSilent >= SILENT_DAYS_BEFORE_ALARM) {
        alarms.push(`Silent ${daysSilent} days — churn risk`);
      }
      if (requestsToday > 0 && errors24h / Math.max(requestsToday, 1) > 0.01) {
        alarms.push(`${errors24h} errors in 24h`);
      }
      if (storagePct >= 90) {
        alarms.push(`Storage ${storagePct}% of limit`);
      }
      if (budgetSharePct >= 25) {
        // One tenant taking a quarter of a SHARED ceiling is everyone's problem.
        alarms.push(`Using ${budgetSharePct}% of the platform request budget`);
      }

      return {
        tenantId: String(row.id),
        slug: String(row.slug),
        name: String(row.name),
        status: String(row.status),
        planTier: String(row.plan_tier),
        mrrMinor: minor(row.mrr_minor),
        requestsToday,
        budgetSharePct,
        errors24h,
        p75LcpMs: row.p75_lcp === null || row.p75_lcp === undefined ? null : num(row.p75_lcp),
        storageUsedMb,
        storageLimitMb,
        storagePct,
        lastActivityAt,
        daysSilent,
        alarms,
      };
    });

    const requestsToday = vitals.reduce((sum, v) => sum + v.requestsToday, 0);
    const errorsLast24h = vitals.reduce((sum, v) => sum + v.errors24h, 0);

    const totals: ObservatoryTotals = {
      tenants: tenantCount,
      activeTenants: num(data.totals.active),
      suspendedTenants: num(data.totals.suspended),
      trialTenants: num(data.totals.trialing),
      mrrMinor: minor(data.totals.mrr_minor),
      currency: String(data.totals.currency ?? "INR"),
      requestsToday,
      requestBudget: budget,
      budgetUsedPct: pct(requestsToday, budget),
      errorsLast24h,
      errorRatePerK:
        requestsToday > 0
          ? Math.round((errorsLast24h / requestsToday) * 1000 * 10) / 10
          : 0,
    };

    const adoption: FeatureAdoption[] = data.adoption.map((row) => {
      const tenantsUsing = num(row.tenants_using);
      return {
        metric: String(row.metric),
        tenantsUsing,
        tenantsTotal: tenantCount,
        adoptionPct: pct(tenantsUsing, tenantCount),
        totalEvents: num(row.total_events),
      };
    });

    const cohorts: CohortRetention[] = data.cohorts.map((row) => {
      const started = num(row.started);
      const stillActive = num(row.still_active);
      return {
        cohortMonth: String(row.cohort_month),
        tenantsStarted: started,
        stillActive,
        retentionPct: pct(stillActive, started),
      };
    });

    const needsAttention = vitals
      .filter((v) => v.alarms.length > 0)
      .sort((a, b) => b.alarms.length - a.alarms.length);

    await recordPlatformAudit({
      operator,
      // ⚠️ NULL, and that routes the row to `platform_action_log` rather than
      // a tenant's own `audit_logs`. Correct: this read spans every tenant
      // and belongs to none of them. Attributing it to one customer would
      // put a line in THEIR audit trail claiming we looked at THEIR data,
      // which is both untrue and alarming to read.
      tenantId: null,
      action: "read",
      resourceType: "platform_observatory",
      reason: "Fleet health and revenue review.",
      severity: "info",
      metadata: {
        tenants: tenantCount,
        budgetUsedPct: totals.budgetUsedPct,
        needsAttention: needsAttention.length,
      },
    });

    return {
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        totals,
        vitals,
        adoption,
        cohorts,
        needsAttention,
      },
    };
  } catch (error) {
    console.error("[observatory] failed:", error);
    // ⚠️ Never the raw message. This function reads across every tenant;
    // a leaked Postgres error can carry a slug, a column, or a value.
    return { ok: false, error: "Could not build the observatory. The failure was logged." };
  }
}
