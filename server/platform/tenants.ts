import "server-only";

/**
 * Ordence — Tenant Directory, Health & Suspension
 * Version: v0.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY QUERY IN THIS FILE CROSSES THE TENANT BOUNDARY ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * So every one of them goes through `withPlatformScope()` with a written
 * justification. That function exists to be grep-able: a security review
 * of this codebase should be able to run one search and find every place
 * isolation is deliberately set aside, with a sentence explaining why.
 *
 * ⚠️ WHAT THIS FILE READS, AND WHAT IT REFUSES TO READ
 * The columns below are metadata about the COMMERCIAL RELATIONSHIP —
 * plan, status, seat and storage counts, last sign-in. There is no query
 * here that touches a contact, a company, a deal, a document's filename
 * or a contract's text, and adding one would be a change to the data
 * protection posture of the product rather than a feature. The full
 * argument is in `lib/platform/search-scopes.ts`.
 *
 * Note in particular that storage is read as a SUM OF BYTES. Not names,
 * not counts by type, not the most recent upload — a number. That is
 * enough to answer "are they near their limit?" and not enough to learn
 * anything about what they keep.
 */

import { and, eq, ne, inArray, isNull, desc, sql, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { withPlatformScope, withTenant } from "@/db";
import { tenants, users, auditLogs } from "@/db/schema";
import { subscriptions } from "@/db/schema/billing";
import { documents } from "@/db/schema/storage";
import { platformImpersonationSessions, platformTenantFlags } from "@/db/schema/platform";
import { evaluateHealth, type HealthVerdict } from "@/lib/platform/health";
import { evaluateAccess } from "@/lib/billing/access-state";
import {
  tenantListSchema,
  suspendTenantSchema,
  reactivateTenantSchema,
  type PlatformResult,
} from "@/lib/platform/schemas";
import { requireCapability, recordPlatformAudit, type PlatformOperator } from "./guard";
import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* SHAPES                                                              */
/* ------------------------------------------------------------------ */

export type TenantSummary = {
  id: string;
  slug: string;
  name: string;
  status: string;
  planTier: PlanTier;
  subscriptionStatus: string | null;
  seatsInUse: number;
  seatLimit: number;
  storageUsedMb: number;
  storageLimitMb: number;
  lastActivityAt: string | null;
  trialEndsAt: string | null;
  createdAt: string;
  health: HealthVerdict;
  /** True when somebody from the platform is inside it right now. */
  impersonationLive: boolean;
  /**
   * Committed monthly recurring revenue, in MINOR UNITS, as a STRING.
   *
   * ⚠️ A string, not a number, and not a `bigint`. Postgres returns
   * `bigint` as text precisely because it does not fit in a JavaScript
   * number, and this value crosses a server→client boundary where a
   * `bigint` cannot be serialised at all. It is formatted for display and
   * never arithmetic'd in the browser.
   */
  mrrMinor: string;
  currency: string;
};

export type TenantDetail = TenantSummary & {
  legalName: string | null;
  customDomain: string | null;
  failedPaymentCount: number;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  /** Exactly what the customer currently sees — same function they see. */
  accessLevel: string;
  accessHeadline: string | null;
  /**
   * The commercial state, spelled out.
   *
   * Amounts are strings for the same reason `mrrMinor` is: they are
   * `bigint` in Postgres and cannot cross a server→client boundary as
   * anything else.
   */
  subscription: {
    status: string;
    provider: string;
    interval: string;
    seatsPurchased: number;
    unitAmountMinor: string;
    perSeatAmountMinor: string;
    currency: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancelledAt: string | null;
    cancellationReason: string | null;
  } | null;
  flags: Array<{
    key: string;
    enabled: boolean;
    reason: string;
    expiresAt: string | null;
    setByEmail: string | null;
  }>;
  recentImpersonations: Array<{
    id: string;
    actorEmail: string;
    mode: string;
    scope: string;
    startedAt: string;
    expiresAt: string;
    endedAt: string | null;
    justification: string;
  }>;
};

/* ------------------------------------------------------------------ */
/* DERIVED COLUMNS — computed IN SQL so the directory can be SORTED    */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE ARE SCALAR SUBQUERIES AND NOT JOINS
 * ══════════════════════════════════════════════════════════════════════
 * A directory you can only sort by "created" is a directory whose most
 * useful questions — "who is closest to their seat limit", "which paying
 * customer has gone quiet" — need a database client to answer. Sorting on
 * a derived column therefore has to happen in the DATABASE: sorting the
 * fifty rows that happen to be on the current page produces a list that
 * looks ordered and is not, which is worse than no sorting at all.
 *
 * Each aggregate is a CORRELATED SCALAR SUBQUERY rather than a LEFT JOIN
 * with a GROUP BY. Four joined one-to-many relations multiply against one
 * another and inflate every count — the classic "this tenant has 4,000
 * seats" bug that `loadUsage()` below was written to avoid. A scalar
 * subquery cannot multiply anything: it returns exactly one value per
 * tenant row, by construction.
 *
 * ⚠️ RLS STILL APPLIES INSIDE A SUBQUERY. These read `users`,
 * `documents` and `subscriptions`, all three of which carry the platform
 * READ clause from Section 6 of 0014 — and nothing here touches a table
 * that does not. Adding a customer-content table to this list would not
 * merely be a bad idea; the policies would return zero rows for it.
 */

/** Active, paying humans. Mirrors `lib/billing/seats.ts` exactly. */
const seatsInUseSql = sql<number>`(
  SELECT count(*)::int FROM users u
   WHERE u.tenant_id = ${tenants.id}
     AND u.deleted_at IS NULL
     AND u.status = 'active'
     AND u.role NOT IN ('platform_super_admin', 'guest')
)`;

/** A SUM OF BYTES. Never names, never types, never the latest upload. */
const storageUsedMbSql = sql<number>`(
  SELECT (coalesce(sum(d.size_bytes), 0) / 1048576)::int FROM documents d
   WHERE d.tenant_id = ${tenants.id} AND d.deleted_at IS NULL
)`;

const lastActivitySql = sql<Date | null>`(
  SELECT max(u.last_seen_at) FROM users u
   WHERE u.tenant_id = ${tenants.id} AND u.deleted_at IS NULL
)`;

/**
 * ⭐ COMMITTED MRR, NORMALISED TO ONE MONTH, IN MINOR UNITS.
 *
 * Three decisions worth stating, because MRR is a number people quote in
 * board meetings and a wrong one is worse than an absent one:
 *
 *   1. ONLY `active` AND `past_due` COUNT. A trial has not agreed to pay
 *      anything, and counting it is how a trial-heavy month reads as
 *      growth. `past_due` DOES count — the customer is contracted and
 *      the money is owed; that is a collections problem, not a revenue
 *      one. `paused`, `cancelled`, `unpaid` and `expired` are zero.
 *
 *   2. ANNUAL AND QUARTERLY ARE DIVIDED, NOT SUMMED. An annual plan
 *      contributes one twelfth per month. Integer division loses at most
 *      one minor unit per subscription, which is the correct trade
 *      against carrying a fractional currency amount.
 *
 *   3. SEATS ARE `seats_purchased`, NOT SEATS USED. MRR is what they
 *      agreed to pay, not what they are getting value from.
 */
const mrrMinorSql = sql<string>`(
  SELECT coalesce(sum(
    CASE s.interval
      WHEN 'monthly'   THEN (s.unit_amount_minor + s.per_seat_amount_minor * s.seats_purchased)
      WHEN 'quarterly' THEN (s.unit_amount_minor + s.per_seat_amount_minor * s.seats_purchased) / 3
      WHEN 'annual'    THEN (s.unit_amount_minor + s.per_seat_amount_minor * s.seats_purchased) / 12
      ELSE 0
    END
  ), 0)::text
    FROM subscriptions s
   WHERE s.tenant_id = ${tenants.id}
     AND s.deleted_at IS NULL
     AND s.status IN ('active', 'past_due')
)`;

const subscriptionStatusSql = sql<string | null>`(
  SELECT s.status FROM subscriptions s
   WHERE s.tenant_id = ${tenants.id} AND s.deleted_at IS NULL
   ORDER BY s.created_at DESC LIMIT 1
)`;

const failedPaymentsSql = sql<number>`(
  SELECT coalesce(max(s.failed_payment_count), 0)::int FROM subscriptions s
   WHERE s.tenant_id = ${tenants.id} AND s.deleted_at IS NULL
)`;

const currencySql = sql<string | null>`(
  SELECT s.currency FROM subscriptions s
   WHERE s.tenant_id = ${tenants.id} AND s.deleted_at IS NULL
   ORDER BY s.created_at DESC LIMIT 1
)`;

/**
 * Is one of us inside this workspace RIGHT NOW?
 *
 * ⚠️ `expires_at`, never `ended_at`. A sweeper that stops running must
 * not be able to make a live session look closed, nor an expired one look
 * open. Same rule as `isSessionLive()`; stated in SQL here because this
 * is the only copy the directory consults.
 */
const impersonationLiveSql = sql<boolean>`EXISTS (
  SELECT 1 FROM platform_impersonation_sessions i
   WHERE i.tenant_id = ${tenants.id}
     AND i.ended_at IS NULL
     AND i.expires_at > now()
)`;

/**
 * The sortable columns, as a CLOSED MAP from a public name to a SQL
 * fragment.
 *
 * ⚠️ THIS IS WHY THE SORT PARAMETER CANNOT BE INJECTED. The value from
 * the query string is used only to look up a key in this frozen object;
 * it is never interpolated into SQL. An unknown key falls back to
 * `created`. `direction` is likewise one of exactly two literals.
 */
const SORTABLE = Object.freeze({
  name: sql`lower(${tenants.name})`,
  created: sql`${tenants.createdAt}`,
  plan: sql`${tenants.planTier}`,
  status: sql`${tenants.status}`,
  seats: seatsInUseSql,
  storage: storageUsedMbSql,
  activity: lastActivitySql,
  mrr: sql`(${mrrMinorSql})::bigint`,
});

export const TENANT_SORT_KEYS = Object.keys(SORTABLE) as Array<keyof typeof SORTABLE>;
export type TenantSortKey = keyof typeof SORTABLE;

/**
 * The directory's own input schema.
 *
 * `tenantListSchema` (in `lib/platform/schemas.ts`) already carries the
 * filters and the bounds; sorting is added here rather than there because
 * it belongs to this query, and because the ordering options are a
 * property of the SQL above — the two must not be able to drift apart.
 */
const tenantDirectorySchema = tenantListSchema.extend({
  sort: z.enum(TENANT_SORT_KEYS as [TenantSortKey, ...TenantSortKey[]]).default("created"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

export type TenantDirectoryInput = z.input<typeof tenantDirectorySchema>;

/* ------------------------------------------------------------------ */
/* LIST                                                                */
/* ------------------------------------------------------------------ */

/**
 * The tenant directory.
 *
 * ⚠️ BOUNDED AND SORTED, NEVER "SELECT *". A console that can page
 * through every tenant unbounded is an export tool with a table in front
 * of it. `limit` is capped at 200 by the schema and the offset at 10,000;
 * anything beyond that is a report, and a report should be a deliberate,
 * separately-audited thing rather than a side effect of scrolling.
 *
 * The read itself is NOT audited per-row. Listing the directory is the
 * console's home page and auditing it would write a row every time an
 * operator glances at their dashboard, burying the accesses that matter
 * under the ones that do not. Opening a specific tenant IS audited, and
 * so is every search.
 *
 * ⚠️ ONE HONEST WART: the `health` filter is applied AFTER the page has
 * been fetched, because health is scored in TypeScript from six inputs
 * and is not a column. So it narrows the page, not the result set, and
 * the console says so next to the control. Everything else — the search,
 * the status and plan filters, the sort and the count — is done by the
 * database over the whole set.
 */
export async function listTenants(
  input: unknown,
): Promise<
  PlatformResult<{
    rows: TenantSummary[];
    total: number;
    limit: number;
    offset: number;
    sort: TenantSortKey;
    direction: "asc" | "desc";
    healthFilterNarrowedPage: boolean;
  }>
> {
  const operator = await requireCapability("tenants:list");
  const parsed = tenantDirectorySchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: "Invalid filters." };
  }
  const filters = parsed.data;
  const now = new Date();

  return withPlatformScope(
    "Platform console: list tenant directory with health, plan, usage and MRR",
    async (db) => {
      const conditions = [isNull(tenants.deletedAt)];

      if (filters.status !== "all") {
        conditions.push(
          eq(
            tenants.status,
            filters.status as "pending" | "active" | "suspended" | "archived" | "pending_deletion",
          ),
        );
      }
      if (filters.planTier !== "all") {
        conditions.push(eq(tenants.planTier, filters.planTier as PlanTier));
      }
      if (filters.query && filters.query.length >= 2) {
        // Prefix match, never `%term%`. A contains-search on tenant names
        // is a fine convenience and a poor habit to establish next to a
        // contains-search on emails, which is an enumeration tool.
        const term = `${filters.query}%`;
        const nameOrSlug = or(ilike(tenants.name, term), ilike(tenants.slug, term));
        if (nameOrSlug) conditions.push(nameOrSlug);
      }

      const where = and(...conditions);

      const [{ count = 0 } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tenants)
        .where(where);

      // The fragment comes from the frozen map above; only the DIRECTION
      // is chosen here, from two literals.
      const orderExpr = SORTABLE[filters.sort];
      const ordered =
        filters.direction === "asc" ? sql`${orderExpr} ASC NULLS LAST` : sql`${orderExpr} DESC NULLS LAST`;

      const tenantRows = await db
        .select({
          id: tenants.id,
          slug: tenants.slug,
          name: tenants.name,
          status: tenants.status,
          planTier: tenants.planTier,
          seatLimit: tenants.seatLimit,
          storageLimitMb: tenants.storageLimitMb,
          trialEndsAt: tenants.trialEndsAt,
          createdAt: tenants.createdAt,
          seatsInUse: seatsInUseSql,
          storageUsedMb: storageUsedMbSql,
          lastActivityAt: lastActivitySql,
          mrrMinor: mrrMinorSql,
          currency: currencySql,
          subscriptionStatus: subscriptionStatusSql,
          failedPaymentCount: failedPaymentsSql,
          impersonationLive: impersonationLiveSql,
        })
        .from(tenants)
        .where(where)
        // A second, unique key so the order is TOTAL. Without it, two
        // tenants with the same MRR can swap places between page 1 and
        // page 2 and a row is silently skipped.
        .orderBy(ordered, sql`${tenants.id} ASC`)
        .limit(filters.limit)
        .offset(filters.offset);

      const rows = tenantRows.map((t) => {
        const lastActivityAt = t.lastActivityAt ? new Date(t.lastActivityAt) : null;
        const health = evaluateHealth({
          tenantStatus: t.status,
          planTier: t.planTier,
          subscriptionStatus: t.subscriptionStatus ?? null,
          trialEndsAt: t.trialEndsAt,
          seatsInUse: t.seatsInUse,
          seatLimit: t.seatLimit,
          storageUsedMb: t.storageUsedMb,
          storageLimitMb: t.storageLimitMb,
          lastActivityAt,
          failedPaymentCount: t.failedPaymentCount,
          now,
        });

        return {
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          planTier: t.planTier,
          subscriptionStatus: t.subscriptionStatus ?? null,
          seatsInUse: t.seatsInUse,
          seatLimit: t.seatLimit,
          storageUsedMb: t.storageUsedMb,
          storageLimitMb: t.storageLimitMb,
          lastActivityAt: lastActivityAt?.toISOString() ?? null,
          trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
          health,
          impersonationLive: Boolean(t.impersonationLive),
          mrrMinor: String(t.mrrMinor ?? "0"),
          currency: t.currency ?? "INR",
        } satisfies TenantSummary;
      });

      const filtered =
        filters.health === "all"
          ? rows
          : rows.filter((r) => r.health.level === filters.health);

      void operator;
      return {
        ok: true as const,
        data: {
          rows: filtered,
          total: count,
          limit: filters.limit,
          offset: filters.offset,
          sort: filters.sort,
          direction: filters.direction,
          healthFilterNarrowedPage: filters.health !== "all",
        },
      };
    },
  );
}

/* ------------------------------------------------------------------ */
/* USAGE ROLLUP                                                        */
/* ------------------------------------------------------------------ */

type Usage = {
  subscriptionStatus: string | null;
  failedPaymentCount: number;
  seatsInUse: number;
  storageUsedMb: number;
  lastActivityAt: Date | null;
  impersonationLive: boolean;
};

/**
 * Four grouped queries rather than one join.
 *
 * A single query with four LEFT JOINs and three aggregates multiplies
 * rows against each other and silently inflates every count — the classic
 * "this tenant has 4,000 seats" bug. Four cheap grouped reads over a
 * bounded id list are correct by construction and easier to read.
 */
async function loadUsage(
  db: Parameters<Parameters<typeof withPlatformScope>[1]>[0],
  ids: string[],
): Promise<Map<string, Usage>> {
  const now = new Date();
  const result = new Map<string, Usage>();
  for (const id of ids) {
    result.set(id, {
      subscriptionStatus: null,
      failedPaymentCount: 0,
      seatsInUse: 0,
      storageUsedMb: 0,
      lastActivityAt: null,
      impersonationLive: false,
    });
  }

  const subs = await db
    .select({
      tenantId: subscriptions.tenantId,
      status: subscriptions.status,
      failedPaymentCount: subscriptions.failedPaymentCount,
    })
    .from(subscriptions)
    .where(and(inArray(subscriptions.tenantId, ids), isNull(subscriptions.deletedAt)));

  for (const s of subs) {
    const entry = result.get(s.tenantId);
    if (entry) {
      entry.subscriptionStatus = s.status;
      entry.failedPaymentCount = s.failedPaymentCount;
    }
  }

  // Seats in use mirrors `lib/billing/seats.ts`: platform staff sitting
  // inside a customer's workspace do NOT consume a seat the customer
  // paid for, and guests never did.
  const seats = await db
    .select({
      tenantId: users.tenantId,
      seats: sql<number>`count(*)::int`,
      lastSeen: sql<Date | null>`max(${users.lastSeenAt})`,
    })
    .from(users)
    .where(
      and(
        inArray(users.tenantId, ids),
        isNull(users.deletedAt),
        eq(users.status, "active"),
        ne(users.role, "platform_super_admin"),
        ne(users.role, "guest"),
      ),
    )
    .groupBy(users.tenantId);

  for (const s of seats) {
    const entry = result.get(s.tenantId);
    if (entry) {
      entry.seatsInUse = s.seats;
      entry.lastActivityAt = s.lastSeen ? new Date(s.lastSeen) : null;
    }
  }

  const storage = await db
    .select({
      tenantId: documents.tenantId,
      bytes: sql<string>`coalesce(sum(${documents.sizeBytes}), 0)::text`,
    })
    .from(documents)
    .where(and(inArray(documents.tenantId, ids), isNull(documents.deletedAt)))
    .groupBy(documents.tenantId);

  for (const s of storage) {
    const entry = result.get(s.tenantId);
    if (entry) entry.storageUsedMb = Math.round(Number(s.bytes) / 1_048_576);
  }

  // Liveness is `expires_at`, never `ended_at` — see the note in
  // `lib/platform/impersonation-policy.ts`. A failed sweeper must not be
  // able to make a live session look closed OR an expired one look open.
  const live = await db
    .select({ tenantId: platformImpersonationSessions.tenantId })
    .from(platformImpersonationSessions)
    .where(
      and(
        inArray(platformImpersonationSessions.tenantId, ids),
        isNull(platformImpersonationSessions.endedAt),
        sql`${platformImpersonationSessions.expiresAt} > ${now}`,
      ),
    );

  for (const l of live) {
    const entry = result.get(l.tenantId);
    if (entry) entry.impersonationLive = true;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* DETAIL                                                              */
/* ------------------------------------------------------------------ */

/**
 * Open one tenant.
 *
 * ⭐ THIS READ IS AUDITED, AND THE ROW LANDS IN THE CUSTOMER'S OWN AUDIT
 * LOG. Opening a specific workspace is a deliberate act aimed at one
 * customer, which is exactly the access a customer is entitled to see us
 * making. `recordPlatformAudit` writes it through `withTenant()` so the
 * tenant's RLS admits it — see the note in `guard.ts`.
 */
export async function getTenantDetail(
  tenantId: string,
): Promise<PlatformResult<TenantDetail>> {
  const operator = await requireCapability("tenants:read");
  const now = new Date();

  const detail = await withPlatformScope(
    `Platform console: open tenant detail ${tenantId} for support`,
    async (db) => {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return null;

      const usage = await loadUsage(db, [tenantId]);
      const u = usage.get(tenantId);

      // MRR uses the SAME expression the directory sorts on, so the
      // number on this page and the number in the list can never
      // disagree — two definitions of revenue is how a support call
      // turns into an argument about which screen is right.
      const [money] = await db
        .select({ mrrMinor: mrrMinorSql, currency: currencySql })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const [subscription] = await db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.tenantId, tenantId), isNull(subscriptions.deletedAt)))
        .limit(1);

      const flagRows = await db
        .select()
        .from(platformTenantFlags)
        .where(eq(platformTenantFlags.tenantId, tenantId));

      const sessionRows = await db
        .select()
        .from(platformImpersonationSessions)
        .where(eq(platformImpersonationSessions.tenantId, tenantId))
        .orderBy(desc(platformImpersonationSessions.startedAt))
        .limit(20);

      const health = evaluateHealth({
        tenantStatus: tenant.status,
        planTier: tenant.planTier,
        subscriptionStatus: u?.subscriptionStatus ?? null,
        trialEndsAt: tenant.trialEndsAt,
        seatsInUse: u?.seatsInUse ?? 0,
        seatLimit: tenant.seatLimit,
        storageUsedMb: u?.storageUsedMb ?? 0,
        storageLimitMb: tenant.storageLimitMb,
        lastActivityAt: u?.lastActivityAt ?? null,
        failedPaymentCount: u?.failedPaymentCount ?? 0,
        now,
      });

      // ⭐ The SAME function the customer's own banner calls. A console
      // that computed "what they can do" separately would eventually
      // disagree with the product, and the support conversation would
      // start with two people describing different systems.
      const access = evaluateAccess({
        subscriptionStatus: subscription?.status ?? null,
        planTier: tenant.planTier,
        tenantStatus: tenant.status,
        trialEndsAt: tenant.trialEndsAt,
        graceEndsAt: subscription?.graceEndsAt ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        failedPaymentCount: subscription?.failedPaymentCount ?? 0,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        now,
      });

      return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        legalName: tenant.legalName,
        customDomain: tenant.customDomain,
        status: tenant.status,
        planTier: tenant.planTier,
        subscriptionStatus: subscription?.status ?? null,
        seatsInUse: u?.seatsInUse ?? 0,
        seatLimit: tenant.seatLimit,
        storageUsedMb: u?.storageUsedMb ?? 0,
        storageLimitMb: tenant.storageLimitMb,
        lastActivityAt: u?.lastActivityAt?.toISOString() ?? null,
        trialEndsAt: tenant.trialEndsAt?.toISOString() ?? null,
        createdAt: tenant.createdAt.toISOString(),
        health,
        impersonationLive: u?.impersonationLive ?? false,
        mrrMinor: String(money?.mrrMinor ?? "0"),
        currency: money?.currency ?? subscription?.currency ?? "INR",
        failedPaymentCount: subscription?.failedPaymentCount ?? 0,
        currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
        graceEndsAt: subscription?.graceEndsAt?.toISOString() ?? null,
        accessLevel: access.level,
        accessHeadline: access.headline,
        subscription: subscription
          ? {
              status: subscription.status,
              provider: subscription.provider,
              interval: subscription.interval,
              seatsPurchased: subscription.seatsPurchased,
              unitAmountMinor: subscription.unitAmountMinor.toString(),
              perSeatAmountMinor: subscription.perSeatAmountMinor.toString(),
              currency: subscription.currency,
              currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
              currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
              cancellationReason: subscription.cancellationReason,
            }
          : null,
        flags: flagRows.map((f) => ({
          key: f.flagKey,
          enabled: f.enabled,
          reason: f.reason,
          expiresAt: f.expiresAt?.toISOString() ?? null,
          setByEmail: f.setByEmail,
        })),
        recentImpersonations: sessionRows.map((s) => ({
          id: s.id,
          actorEmail: s.actorEmail,
          mode: s.mode,
          scope: s.scope,
          startedAt: s.startedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          endedAt: s.endedAt?.toISOString() ?? null,
          justification: s.justification,
        })),
      } satisfies TenantDetail;
    },
  );

  if (!detail) return { ok: false, error: "Workspace not found." };

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "read",
    resourceType: "tenant",
    resourceId: tenantId,
    reason: "Platform staff opened this workspace in the support console.",
    severity: "notice",
    metadata: { slug: detail.slug },
  });

  return { ok: true, data: detail };
}

/* ------------------------------------------------------------------ */
/* SUSPEND / REACTIVATE                                                */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * SUSPENSION IS A SWITCH, NOT A DELETION. NOTHING HERE REMOVES DATA.
 * ══════════════════════════════════════════════════════════════════════
 * One column changes: `tenants.status` → `suspended`. That is the whole
 * mechanism, and it is deliberately the smallest possible one.
 *
 * What follows from it is already built:
 * `evaluateAccess()` maps `tenantStatus === "suspended"` to `locked`, and
 * `locked` still returns `canExport: true`. So a suspended customer can
 * sign in, reach billing, and download everything they own — they simply
 * cannot use the product. That is a collections and abuse control; it is
 * not a way to hold someone's records hostage, and under DPDP it must not
 * become one.
 *
 * Reversal restores the status the tenant HAD, read back from the audit
 * row written at suspension time. Blindly setting `active` would silently
 * complete the onboarding of a tenant that was `pending` — a workspace
 * that was never finished becoming live, quietly becoming live.
 */
export async function suspendTenant(input: unknown): Promise<PlatformResult<void>> {
  const operator = await requireCapability("tenants:suspend");
  const parsed = suspendTenantSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, confirmSlug, reason, customerMessage } = parsed.data;

  const outcome = await withPlatformScope(
    `Platform console: suspend tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { error: "Workspace not found." } as const;

      // The typed slug is a MISTAKE guard, not a security control —
      // anyone can type a slug. It exists because the console shows two
      // hundred near-identical rows and the failure it prevents is
      // suspending the wrong customer.
      if (tenant.slug !== confirmSlug.trim()) {
        return { error: "That is not this workspace's address." } as const;
      }
      if (tenant.status === "suspended") {
        return { error: "This workspace is already suspended." } as const;
      }

      await db
        .update(tenants)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

      return { previousStatus: tenant.status, slug: tenant.slug } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  // ⭐ The audit row is where `previousStatus` lives, and `audit_logs` is
  // append-only, so the record of what to restore cannot be edited by
  // whoever later performs the restore.
  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_suspension",
    resourceId: tenantId,
    oldValue: { status: outcome.previousStatus },
    newValue: { status: "suspended" },
    severity: "critical",
    reason,
    metadata: {
      customerMessage: customerMessage ?? null,
      slug: outcome.slug,
      reversible: true,
      dataDeleted: false,
    },
  });

  return { ok: true, data: undefined };
}

export async function reactivateTenant(input: unknown): Promise<PlatformResult<void>> {
  const operator = await requireCapability("tenants:suspend");
  const parsed = reactivateTenantSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Check the form.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, reason } = parsed.data;

  const previous = await readPreviousStatus(tenantId);

  const outcome = await withPlatformScope(
    `Platform console: reactivate tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { error: "Workspace not found." } as const;
      if (tenant.status !== "suspended") {
        return { error: "This workspace is not suspended." } as const;
      }

      await db
        .update(tenants)
        .set({ status: previous, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

      return { restoredTo: previous } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_suspension",
    resourceId: tenantId,
    oldValue: { status: "suspended" },
    newValue: { status: outcome.restoredTo },
    severity: "critical",
    reason,
    metadata: { restoredFromAudit: true },
  });

  return { ok: true, data: undefined };
}

/**
 * What status did this tenant hold before it was suspended?
 *
 * Read from the tenant's OWN audit log, inside the tenant's RLS context —
 * `audit_logs` policy is `tenant_id = app_current_tenant_id()`, so the
 * platform connection sees nothing there and must ask as the tenant. That
 * is the policy working correctly rather than an obstacle to route
 * around.
 *
 * Falls back to `active` when no suspension row exists (a tenant
 * suspended before this phase shipped, or by hand in SQL). `active` is
 * the safe fallback: the failure mode is a workspace that works when the
 * operator expected onboarding to resume, which is visible and
 * correctable, rather than one that silently cannot be used.
 */
async function readPreviousStatus(
  tenantId: string,
): Promise<"pending" | "active" | "archived"> {
  try {
    const rows = await withTenant(tenantId, async (tx) =>
      tx
        .select({ oldValue: auditLogs.oldValue })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, tenantId),
            eq(auditLogs.resourceType, "tenant_suspension"),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1),
    );

    const status = (rows[0]?.oldValue as { status?: unknown } | null)?.status;
    if (status === "pending" || status === "archived") return status;
    return "active";
  } catch (err) {
    console.error("[platform] could not read previous tenant status", err);
    return "active";
  }
}

export type { PlatformOperator };
