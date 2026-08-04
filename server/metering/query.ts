import "server-only";

/**
 * Ordence — Usage & Quota Queries
 * Version: v0.14.0-alpha (Phase 15)
 *
 * The read side of Phase 15: what has this tenant used in the current
 * BILLING period, how does that compare to the quotas on their plan, and
 * what — if anything — should be refused because of it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE QUOTAS ARE READ FROM `plans`. THEY ARE NOT REDEFINED HERE.
 * ══════════════════════════════════════════════════════════════════════
 * `storage_limit_mb`, `emails_per_month` and `api_calls_per_month` have
 * existed since Phase 11. A second copy — a constant in this file, a
 * column on `tenants`, a JSON blob in an env var — would be a second place
 * for a quota to be wrong, and the copy the customer is ENFORCED against
 * would not necessarily be the one the pricing page RENDERS. That
 * discrepancy is discovered by a customer, in public.
 *
 * ══════════════════════════════════════════════════════════════════════
 * A TENANT WITH NO LIVE SUBSCRIPTION IS MEASURED, NOT CAPPED
 * ══════════════════════════════════════════════════════════════════════
 * Usage is still recorded — the buckets are written against a calendar
 * fallback period — but no quota is enforced, because there is no plan to
 * read one from.
 *
 * The obvious objection is that this makes "cancel your subscription" an
 * unlimited plan. It does not, and the reason is Phase 14: a workspace
 * without a live subscription passes through `notice` → `warning` →
 * `restricted`, and `restricted` is READ-ONLY. A read-only workspace
 * cannot upload, cannot send, cannot create a portal link. The access
 * ladder already closes that hole, and closing it a second time here —
 * by inventing a default quota and blocking against it — would mean a
 * workspace ten minutes into signup, before its subscription row exists,
 * gets refused its first upload with a message about a plan it has not
 * chosen yet. That is a worse first five minutes than any amount of
 * theoretical abuse.
 */

import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { subscriptions, plans } from "@/db/schema/billing";
import { usageCounters, usageLevels } from "@/db/schema/metering";
import {
  USAGE_METRICS,
  CUMULATIVE_METRICS,
  LEVEL_METRICS,
  canConsume,
  evaluateQuota,
  limitForMetric,
  metricDefinition,
  serialiseQuotaState,
  toBigIntUsage,
  worstQuotaLevel,
  type PlanQuotaLimits,
  type QuotaLevel,
  type QuotaState,
  type QuotaVerdict,
  type SerialisedQuotaState,
  type UsageMetric,
} from "@/lib/metering/quota";
import {
  resolveMeteringPeriod,
  type MeteringPeriod,
} from "@/lib/metering/period";
import type { BillingIntervalName } from "@/lib/billing/money";

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Distinct from `SeatLimitError`, `FeatureLockedError` and
 * `PermissionDeniedError`. Four denials, four different remedies:
 *
 *   permission  → "ask your admin"
 *   entitlement → "upgrade your plan"
 *   seats       → "buy a seat, or free one"
 *   quota       → "delete something, or upgrade"
 *
 * Collapsing any two of them guarantees the wrong advice eventually — and
 * "upgrade your plan" shown to someone who only needed to empty their bin
 * is a charge they did not need to make.
 */
export class QuotaExceededError extends Error {
  constructor(readonly verdict: QuotaVerdict) {
    super(verdict.message);
    this.name = "QuotaExceededError";
  }

  get state(): QuotaState {
    return this.verdict.state;
  }

  get metric(): UsageMetric {
    return this.verdict.state.metric;
  }
}

/* ------------------------------------------------------------------ */
/* THE TENANT'S BILLING CONTEXT                                        */
/* ------------------------------------------------------------------ */

export type MeteringContext = {
  period: MeteringPeriod;
  /** null when there is no live subscription — measured, not capped. */
  limits: PlanQuotaLimits | null;
  planCode: string | null;
  subscriptionStatus: string | null;
};

type CacheEntry = { expiresAt: number; context: MeteringContext };

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS IS CACHED, AND WHY ONLY FOR A MINUTE
 * ══════════════════════════════════════════════════════════════════════
 * Every metered API call would otherwise perform an extra join across
 * `subscriptions` and `plans` purely to learn a period boundary that moves
 * once a month. That is a query per request added to the hot path by the
 * BILLING system, which is the least acceptable place to add latency: it
 * is pure overhead to the customer.
 *
 * Sixty seconds is chosen so the worst case is bounded and boring: for up
 * to a minute after a period rolls over, or after a plan change, usage is
 * recorded against the previous period or compared against the previous
 * quota. A minute of usage in the adjacent bucket is a rounding error on
 * an invoice; a minute of the old quota cannot block anyone who was not
 * already blocked.
 *
 * It is per-INSTANCE, which on Vercel means it is not shared and not
 * coherent. That is fine here for exactly the same reason it was fine for
 * the rate limiter's fallback: nothing about correctness depends on two
 * instances agreeing, because the authoritative arithmetic happens in the
 * database.
 *
 * The map is BOUNDED. An unbounded per-tenant map in a long-lived Node
 * process is a slow memory leak that only shows up in production.
 */
const CONTEXT_TTL_MS = 60_000;
const CONTEXT_MAX_ENTRIES = 5_000;
const contextCache = new Map<string, CacheEntry>();

/** Drop cached context. Call after a plan change so the new quota is live. */
export function resetMeteringContext(tenantId?: string): void {
  if (tenantId) contextCache.delete(tenantId);
  else contextCache.clear();
}

export async function getTenantMeteringContext(
  tenantId: string,
  now: Date = new Date(),
): Promise<MeteringContext> {
  const cached = contextCache.get(tenantId);
  if (cached && cached.expiresAt > now.getTime()) return cached.context;

  const { withTenant } = await import("@/db");

  const row = await withTenant(tenantId, async (tx) => {
    const [found] = await tx
      .select({
        periodStart: subscriptions.currentPeriodStart,
        periodEnd: subscriptions.currentPeriodEnd,
        interval: subscriptions.interval,
        status: subscriptions.status,
        planCode: plans.code,
        storageLimitMb: plans.storageLimitMb,
        emailsPerMonth: plans.emailsPerMonth,
        apiCallsPerMonth: plans.apiCallsPerMonth,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(
        and(
          eq(subscriptions.tenantId, tenantId),
          sql`${subscriptions.deletedAt} IS NULL`,
          // The same live-status set Phase 13 uses. A cancelled
          // subscription's period must not keep defining buckets after it
          // has ended.
          sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
        ),
      )
      .limit(1);

    return found ?? null;
  });

  const context: MeteringContext = {
    period: resolveMeteringPeriod({
      subscriptionPeriodStart: row?.periodStart ?? null,
      subscriptionPeriodEnd: row?.periodEnd ?? null,
      interval: (row?.interval as BillingIntervalName | undefined) ?? null,
      now,
    }),
    limits: row
      ? {
          storageLimitMb: row.storageLimitMb,
          emailsPerMonth: row.emailsPerMonth,
          apiCallsPerMonth: row.apiCallsPerMonth,
        }
      : null,
    planCode: row?.planCode ?? null,
    subscriptionStatus: row?.status ?? null,
  };

  if (contextCache.size >= CONTEXT_MAX_ENTRIES) {
    // Evict the oldest tenth rather than clearing: a full clear during a
    // traffic spike stampedes the database with the query we just avoided.
    let evicted = 0;
    const target = Math.ceil(CONTEXT_MAX_ENTRIES * 0.1);
    for (const key of contextCache.keys()) {
      if (evicted >= target) break;
      contextCache.delete(key);
      evicted += 1;
    }
  }
  contextCache.set(tenantId, { expiresAt: now.getTime() + CONTEXT_TTL_MS, context });

  return context;
}

/* ------------------------------------------------------------------ */
/* CURRENT USAGE                                                       */
/* ------------------------------------------------------------------ */

export type UsageReading = Record<UsageMetric, bigint>;

function emptyReading(): UsageReading {
  return USAGE_METRICS.reduce((acc, metric) => {
    acc[metric] = 0n;
    return acc;
  }, {} as UsageReading);
}

/**
 * Everything this tenant has used in `period`.
 *
 * Two reads because there are two kinds of number, and they are combined
 * into one shape so no caller has to remember which is which:
 *
 *   • Cumulative metrics come from the bucket whose `period_start` matches
 *     EXACTLY. Not `>=`, not "the latest" — an exact match, because a
 *     rolled-forward period and a webhook-confirmed one can briefly both
 *     exist, and summing them would double-count.
 *   • The level metric comes from its single row, ignoring the period
 *     entirely. Bytes stored do not reset when a month does.
 */
export async function getCurrentUsage(
  tenantId: string,
  period: MeteringPeriod,
): Promise<UsageReading> {
  const { withTenant } = await import("@/db");

  return withTenant(tenantId, async (tx) => {
    const reading = emptyReading();

    const counters = await tx
      .select({ metric: usageCounters.metric, value: usageCounters.value })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.tenantId, tenantId),
          eq(usageCounters.periodStart, period.periodStart),
          inArray(usageCounters.metric, [...CUMULATIVE_METRICS]),
        ),
      );

    for (const row of counters) {
      reading[row.metric as UsageMetric] = toBigIntUsage(row.value);
    }

    const levels = await tx
      .select({ metric: usageLevels.metric, value: usageLevels.currentValue })
      .from(usageLevels)
      .where(
        and(
          eq(usageLevels.tenantId, tenantId),
          inArray(usageLevels.metric, [...LEVEL_METRICS]),
        ),
      );

    for (const row of levels) {
      reading[row.metric as UsageMetric] = toBigIntUsage(row.value);
    }

    return reading;
  });
}

/* ------------------------------------------------------------------ */
/* QUOTA STATE                                                         */
/* ------------------------------------------------------------------ */

export type TenantQuotaStates = {
  period: MeteringPeriod;
  limits: PlanQuotaLimits | null;
  states: QuotaState[];
  byMetric: Record<UsageMetric, QuotaState>;
};

export async function getQuotaStates(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantQuotaStates> {
  const context = await getTenantMeteringContext(tenantId, now);
  const usage = await getCurrentUsage(tenantId, context.period);

  const byMetric = USAGE_METRICS.reduce(
    (acc, metric) => {
      acc[metric] = evaluateQuota({
        metric,
        used: usage[metric] ?? 0n,
        // No plan → no limit → measured, not capped. See the header.
        limit: context.limits ? limitForMetric(metric, context.limits) : null,
      });
      return acc;
    },
    {} as Record<UsageMetric, QuotaState>,
  );

  return {
    period: context.period,
    limits: context.limits,
    states: USAGE_METRICS.map((m) => byMetric[m]),
    byMetric,
  };
}

export async function getQuotaState(
  tenantId: string,
  metric: UsageMetric,
  now: Date = new Date(),
): Promise<QuotaState> {
  const { byMetric } = await getQuotaStates(tenantId, now);
  return byMetric[metric];
}

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

/**
 * Non-throwing check. Use it to render a warning, disable a button, or
 * decide whether to show an upgrade prompt.
 *
 * ⚠️ This is ADVISORY for every metric that has no hard cap, and the
 * verdict says so (`reason: "over_but_permitted"`). A caller that treats
 * `state.isOver` as "refuse" rather than reading `allowed` will start
 * blocking API calls at 100%, which is a pricing decision Phase 16 owns
 * and this phase deliberately does not make.
 */
export async function checkQuota(
  tenantId: string,
  metric: UsageMetric,
  amount: bigint = 1n,
  now: Date = new Date(),
): Promise<QuotaVerdict> {
  const state = await getQuotaState(tenantId, metric, now);
  return canConsume(state, amount);
}

/**
 * Throwing gate. Call before consuming a HARD-CAPPED resource — today,
 * before accepting an upload.
 *
 * ⚠️ NEVER call this before a DELETE, an export or a read. Deleting is the
 * remedy for being over quota; gating the remedy behind the quota is the
 * trap this phase exists to avoid. And a customer's existing documents
 * must remain readable and downloadable at every level of overage,
 * exactly as Phase 14 keeps export available at every level of dunning.
 */
export async function requireQuota(
  tenantId: string,
  metric: UsageMetric,
  amount: bigint = 1n,
  now: Date = new Date(),
): Promise<QuotaVerdict> {
  const verdict = await checkQuota(tenantId, metric, amount, now);
  if (!verdict.allowed) throw new QuotaExceededError(verdict);
  return verdict;
}

/* ------------------------------------------------------------------ */
/* SUMMARY FOR THE UI                                                  */
/* ------------------------------------------------------------------ */

export type UsageSummary = {
  /** ISO strings — this crosses the RSC boundary. */
  periodStart: string;
  periodEnd: string;
  periodSource: MeteringPeriod["source"];
  planCode: string | null;
  /** False when there is no live subscription: measured, not capped. */
  hasPlan: boolean;
  /** The worst rung across all metrics — what a global banner shows. */
  worstLevel: QuotaLevel;
  metrics: (SerialisedQuotaState & { label: string })[];
};

/**
 * One call, everything the usage page needs, already serialised.
 *
 * ⭐ Every bigint is converted here, at the boundary, and the human copy is
 * rendered here too. Two reasons, and the second is the important one:
 * `JSON.stringify` throws on a bigint, so returning a raw `QuotaState`
 * from a server action crashes the RSC serialiser; and a client that
 * re-derives "1.4 GB of 2 GB" from raw numbers is a second implementation
 * of the formatter, which will eventually disagree with the server about
 * whether someone is at 99% or 100%.
 */
export async function getUsageSummary(
  tenantId: string,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const { period, limits, states } = await getQuotaStates(tenantId, now);
  const context = await getTenantMeteringContext(tenantId, now);

  return {
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    periodSource: period.source,
    planCode: context.planCode,
    hasPlan: limits !== null,
    worstLevel: worstQuotaLevel(states),
    metrics: states.map((state) => ({
      ...serialiseQuotaState(state),
      label: metricDefinition(state.metric).label,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* HISTORY                                                             */
/* ------------------------------------------------------------------ */

export type UsageHistoryRow = {
  periodStart: string;
  periodEnd: string;
  value: string;
};

/**
 * Closed buckets for one metric, most recent first.
 *
 * This is the answer to "why is my overage line ₹840" and it is the whole
 * reason usage is bucketed by period rather than held in a single mutable
 * counter. A number with no history cannot be defended in a billing
 * dispute; a row per period, written by an atomic increment and protected
 * from ever decreasing, can be.
 *
 * Level metrics have no per-period rows and return an empty list — their
 * history is a time series we do not keep, which is stated here rather
 * than faked.
 */
export async function getUsageHistory(
  tenantId: string,
  metric: UsageMetric,
  periods = 12,
): Promise<UsageHistoryRow[]> {
  if (metricDefinition(metric).kind !== "cumulative") return [];

  const { withTenant } = await import("@/db");

  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        periodStart: usageCounters.periodStart,
        periodEnd: usageCounters.periodEnd,
        value: usageCounters.value,
      })
      .from(usageCounters)
      .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.metric, metric)))
      .orderBy(desc(usageCounters.periodStart))
      .limit(Math.max(1, Math.min(periods, 60)));

    return rows.map((row) => ({
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      value: toBigIntUsage(row.value).toString(),
    }));
  });
}
