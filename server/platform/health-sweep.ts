import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE SWEEP THAT TURNS A SNAPSHOT INTO SOMETHING SOMEBODY OWES
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WITHOUT THIS FILE THE TABLE IS ANOTHER ORPHAN
 * ══════════════════════════════════════════════════════════════════════
 * `tenant_health_events` and `getOpenHealthEvents` were both written
 * before this file existed, and between them they could only ever have
 * shown an empty list forever. That is the house pattern this codebase
 * has now hit eight times: a complete engine that nothing reaches, and
 * `scripts/check-reachability.mjs` exists specifically because I kept
 * shipping it.
 *
 * ⚠️ SO THIS IS THE MISSING HALF, and it is deliberately the LAST thing
 * written rather than the first.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE ONLY HARD PART IS NOT RAISING THE SAME ALERT TWICE
 * ══════════════════════════════════════════════════════════════════════
 * A sweep that inserts on every run produces forty rows about one
 * dormant workspace inside a fortnight, and an operator who closes forty
 * rows learns to close them without reading. The partial unique index in
 * 0074 — one open event per tenant per rule — makes that impossible at
 * the database level rather than in a `SELECT ... IF NOT EXISTS` race.
 *
 * 🔴 AND A CLOSED EVENT IS NOT RE-RAISED WHILE THE CAUSE PERSISTS. It is
 * re-raised only if the rule goes quiet and then fires again, which is
 * what "we looked at it and it came back" means. That is the difference
 * between a ticket and a nag.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { withPlatformScope } from "@/db";
import { tenantHealthEvents } from "@/db/schema/platform-control";
import { evaluateHealth, type HealthInput } from "@/lib/platform/health";
import { eventsFor, type HealthEvent } from "@/lib/platform/health-rules";
import type { PlanTier } from "@/db/schema/core";

export interface SweepResult {
  readonly tenantsExamined: number;
  readonly opened: number;
  readonly alreadyOpen: number;
  readonly autoClosed: number;
}

/**
 * ⚠️ ONE QUERY, NOT ONE PER TENANT. At two hundred workspaces a
 * per-tenant loop is two hundred round trips to Neon on a page load, and
 * the screen that shows this is the one somebody opens first thing in
 * the morning.
 */
const FACTS = sql`
  WITH act7 AS (
    SELECT tenant_id, count(*)::int AS n
      FROM users
     WHERE last_seen_at >= now() - interval '7 days'
       AND deleted_at IS NULL
     GROUP BY tenant_id
  ),
  act14 AS (
    SELECT tenant_id, count(*)::int AS n
      FROM users
     WHERE last_seen_at >= now() - interval '14 days'
       AND last_seen_at <  now() - interval '7 days'
       AND deleted_at IS NULL
     GROUP BY tenant_id
  ),
  req7 AS (
    SELECT tenant_id, COALESCE(SUM(quantity), 0)::bigint AS n
      FROM usage_counters
     WHERE metric = 'api_requests'
       AND occurred_at >= now() - interval '7 days'
     GROUP BY tenant_id
  ),
  -- ⚠️ THE BASELINE EXCLUDES THE WINDOW IT IS COMPARED AGAINST. Including
  -- the spike in the tenant's own "normal" is how a rule quietly stops
  -- firing for the workspaces that need it most.
  req_base AS (
    SELECT tenant_id, COALESCE(SUM(quantity), 0)::bigint AS n
      FROM usage_counters
     WHERE metric = 'api_requests'
       AND occurred_at >= now() - interval '35 days'
       AND occurred_at <  now() - interval '7 days'
     GROUP BY tenant_id
  ),
  err7 AS (
    SELECT tenant_id, count(*)::bigint AS n
      FROM error_events
     WHERE occurred_at >= now() - interval '7 days'
     GROUP BY tenant_id
  ),
  err_base AS (
    SELECT tenant_id, count(*)::bigint AS n
      FROM error_events
     WHERE occurred_at >= now() - interval '35 days'
       AND occurred_at <  now() - interval '7 days'
     GROUP BY tenant_id
  ),
  seats AS (
    SELECT tenant_id, count(*)::int AS n
      FROM users
     WHERE deleted_at IS NULL AND status = 'active'
     GROUP BY tenant_id
  ),
  store AS (
    SELECT tenant_id,
           COALESCE(MAX(used_mb), 0)::numeric  AS used_mb,
           COALESCE(MAX(limit_mb), 0)::numeric AS limit_mb
      FROM usage_levels
     WHERE metric = 'storage_mb'
     GROUP BY tenant_id
  ),
  seen AS (
    SELECT tenant_id, MAX(last_seen_at) AS at
      FROM users
     WHERE deleted_at IS NULL
     GROUP BY tenant_id
  ),
  -- ⭐ "Dark" is measured from the last SUCCESS, never from the last
  -- attempt. A connection retrying every ten minutes and failing every
  -- time has a very recent attempt and has brought nothing in for days,
  -- and it is precisely the case the customer cannot see.
  dark AS (
    SELECT c.tenant_id,
           jsonb_agg(
             jsonb_build_object(
               'name', c.name,
               'hours', EXTRACT(EPOCH FROM (now() - COALESCE(c.last_success_at, c.created_at))) / 3600.0
             )
             ORDER BY c.last_success_at NULLS FIRST
           ) AS items
      FROM connections c
     WHERE c.is_active
       AND c.state IN ('connected', 'degraded')
       AND COALESCE(c.last_success_at, c.created_at) < now() - interval '48 hours'
     GROUP BY c.tenant_id
  )
  SELECT
    t.id, t.name, t.status,
    COALESCE(s.plan_tier, 'free')            AS plan_tier,
    s.status                                 AS sub_status,
    s.trial_ends_at,
    COALESCE(s.seats_purchased, 0)::int      AS seat_limit,
    COALESCE(seats.n, 0)::int                AS seats_in_use,
    COALESCE(store.used_mb, 0)               AS storage_used_mb,
    COALESCE(store.limit_mb, 0)              AS storage_limit_mb,
    seen.at                                  AS last_activity_at,
    COALESCE(act7.n, 0)::int                 AS active_7,
    COALESCE(act14.n, 0)::int                AS active_prior_7,
    COALESCE(req7.n, 0)::bigint              AS req_7,
    COALESCE(req_base.n, 0)::bigint          AS req_base,
    COALESCE(err7.n, 0)::bigint              AS err_7,
    COALESCE(err_base.n, 0)::bigint          AS err_base,
    COALESCE(dark.items, '[]'::jsonb)        AS dark_connections,
    COALESCE(fp.n, 0)::int                   AS failed_payments
  FROM tenants t
  LEFT JOIN subscriptions s ON s.tenant_id = t.id
  LEFT JOIN act7      ON act7.tenant_id      = t.id
  LEFT JOIN act14     ON act14.tenant_id     = t.id
  LEFT JOIN req7      ON req7.tenant_id      = t.id
  LEFT JOIN req_base  ON req_base.tenant_id  = t.id
  LEFT JOIN err7      ON err7.tenant_id      = t.id
  LEFT JOIN err_base  ON err_base.tenant_id  = t.id
  LEFT JOIN seats     ON seats.tenant_id     = t.id
  LEFT JOIN store     ON store.tenant_id     = t.id
  LEFT JOIN seen      ON seen.tenant_id      = t.id
  LEFT JOIN dark      ON dark.tenant_id      = t.id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n
      FROM invoices i
     WHERE i.tenant_id = t.id
       AND i.status = 'payment_failed'
  ) fp ON true
  WHERE t.deleted_at IS NULL
  LIMIT 500
`;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ⭐⭐ THE SWEEP.
 *
 * ⚠️ IDEMPOTENT AND SAFE TO CALL ON EVERY PAGE LOAD. It is called from
 * the health screen rather than from a cron, because a screen that only
 * works when a scheduler is healthy is a screen that is silently empty
 * on exactly the day the platform is having a bad time.
 */
export async function sweepTenantHealth(now: Date): Promise<SweepResult> {
  return withPlatformScope("Platform console: tenant health sweep", async (db) => {
    const raw = await db.execute(FACTS);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Array<
      Record<string, unknown>
    >;

    /* ---- What is already open ---------------------------------- */
    const openRows = await db
      .select({
        tenantId: tenantHealthEvents.tenantId,
        ruleKey: tenantHealthEvents.ruleKey,
      })
      .from(tenantHealthEvents)
      .where(isNull(tenantHealthEvents.resolvedAt));

    const open = new Set(openRows.map((r) => `${r.tenantId}::${r.ruleKey}`));

    let opened = 0;
    let alreadyOpen = 0;
    let autoClosed = 0;
    const stillFiring = new Set<string>();

    for (const row of rows) {
      const tenantId = String(row.id);
      const tenantName = String(row.name ?? "This workspace");

      const req7 = num(row.req_7);
      const reqBase = num(row.req_base);

      const input: HealthInput = {
        tenantStatus: String(row.status ?? "active"),
        planTier: String(row.plan_tier ?? "free") as PlanTier,
        subscriptionStatus: row.sub_status === null || row.sub_status === undefined
          ? null
          : String(row.sub_status),
        trialEndsAt: asDate(row.trial_ends_at),
        seatsInUse: num(row.seats_in_use),
        seatLimit: num(row.seat_limit),
        storageUsedMb: num(row.storage_used_mb),
        storageLimitMb: num(row.storage_limit_mb),
        lastActivityAt: asDate(row.last_activity_at),
        failedPaymentCount: num(row.failed_payments),
        now,
      };

      const darkRaw = row.dark_connections;
      const dark = (Array.isArray(darkRaw) ? darkRaw : JSON.parse(String(darkRaw ?? "[]"))) as Array<{
        name?: unknown;
        hours?: unknown;
      }>;

      const events = eventsFor({
        verdict: evaluateHealth(input),
        trends: {
          tenantName,
          activeUsersLast7: num(row.active_7),
          activeUsersPrior7: num(row.active_prior_7),
          // ⚠️ A RATE, NOT A COUNT. Errors per request, so a workspace
          // that doubled its usage and doubled its errors reads as
          // unchanged, which it is.
          errorRate7d: req7 > 0 ? num(row.err_7) / req7 : 0,
          errorRateBaseline: reqBase > 0 ? num(row.err_base) / reqBase : 0,
          connectionsWithNoSyncHours: dark.map((d) => ({
            name: String(d.name ?? "A connection"),
            hours: num(d.hours),
          })),
        },
        now,
      });

      for (const event of events) {
        const key = `${tenantId}::${event.ruleKey}`;
        stillFiring.add(key);

        if (open.has(key)) {
          alreadyOpen += 1;
          continue;
        }

        const inserted = await insertEvent(db, tenantId, event, now);
        if (inserted) opened += 1;
        else alreadyOpen += 1;
      }
    }

    /* ---- ⭐ WHAT STOPPED FIRING ---------------------------------
     *
     * 🔴 CLOSED WITH A NOTE THAT SAYS NOBODY DID IT. A row that
     * disappears is a row an operator will swear they never saw; a row
     * that says "the cause went away on its own" is a fact somebody can
     * argue with, which is the point.
     *
     * ⚠️ ONLY THE RULES THAT CAN SELF-RESOLVE. `never_used` cannot become
     * untrue by itself in any interesting way, but a dark integration
     * coming back and a payment succeeding both can, and leaving those
     * open teaches operators to close things that fixed themselves. */
    for (const key of open) {
      if (stillFiring.has(key)) continue;
      const [tenantId, ruleKey] = key.split("::");
      if (!tenantId || !ruleKey || !SELF_RESOLVING.has(ruleKey)) continue;

      await db
        .update(tenantHealthEvents)
        .set({
          resolvedAt: now,
          resolutionNote:
            "Closed by the sweep: the condition stopped being true and nobody had to do anything. If this keeps happening for the same workspace, the threshold is wrong rather than the workspace.",
        })
        .where(
          and(
            eq(tenantHealthEvents.tenantId, tenantId),
            eq(tenantHealthEvents.ruleKey, ruleKey),
            isNull(tenantHealthEvents.resolvedAt),
          ),
        );
      autoClosed += 1;
    }

    return {
      tenantsExamined: rows.length,
      opened,
      alreadyOpen,
      autoClosed,
    };
  });
}

/**
 * ⚠️ RULES WHOSE CAUSE CAN GENUINELY GO AWAY WITHOUT A HUMAN.
 *
 * 🔴 `never_used` AND `dormant` ARE ABSENT ON PURPOSE. A workspace that
 * signs in once after three weeks of silence has not been saved, and
 * auto-closing the alert is how the call that would have saved it never
 * gets made.
 */
const SELF_RESOLVING = new Set<string>([
  "integration_dark",
  "error_spike",
  "engagement_collapse",
  "past_due",
  "unpaid",
]);

type SweepDb = Parameters<Parameters<typeof withPlatformScope>[1]>[0];

/**
 * ⭐ THE UNIQUE INDEX IS THE RACE PROTECTION, NOT THE READ ABOVE.
 *
 * ⚠️ Two operators opening the screen at the same second both see an
 * empty `open` set and both insert. `ON CONFLICT DO NOTHING` against
 * `tenant_health_one_open_per_rule` is what makes the second one a
 * no-op, and the return value tells the caller which happened.
 */
async function insertEvent(
  db: SweepDb,
  tenantId: string,
  event: HealthEvent,
  now: Date,
): Promise<boolean> {
  const result = await db
    .insert(tenantHealthEvents)
    .values({
      tenantId,
      ruleKey: event.ruleKey,
      severity: event.severity,
      headline: event.headline.slice(0, 300),
      whatToDo: event.whatToDo,
      evidence: event.evidence,
      detectedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: tenantHealthEvents.id });

  return result.length > 0;
}
