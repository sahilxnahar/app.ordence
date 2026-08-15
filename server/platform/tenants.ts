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
import {
  configOverrideKeyFor,
  resolveConfig,
  type TenantOverrideInput,
} from "@/lib/platform/config-chain";
import {
  exportTenantData,
  serialiseExport,
  exportFileName,
} from "@/server/backup/export";
import { requireCapability, recordPlatformAudit, type PlatformOperator } from "./guard";
import { getConfigChain } from "./configuration";
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
  /**
   * ⭐ The effective customer-facing suspension message, resolved global
   * → plan → workspace override.
   *
   * ⚠️ `layer` MATTERS ON THE SCREEN. "This is the global default" and
   * "somebody wrote this for this customer" are different facts, and an
   * operator about to lock a workspace out needs to know which one they
   * are looking at.
   */
  suspensionMessage: {
    effective: string;
    layer: "global" | "plan" | "tenant";
    setByEmail: string | null;
  };
  /** Null unless a termination has been scheduled or cancelled. */
  offboarding: OffboardingView | null;
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
        /*
         * ⚠️ FILTERED, BECAUSE THIS TABLE NOW HOLDS FOUR NAMESPACES.
         * `platform_tenant_flags` carries flags, `entitlement:`
         * overrides, `config:` values and the `lifecycle:` offboarding
         * record. Listing all four under a heading that says "feature
         * flags" would put a scheduled deletion in a list of beta
         * toggles, where nobody would read it as one.
         */
        flags: flagRows
          .filter((f) => !f.flagKey.includes(":"))
          .map((f) => ({
            key: f.flagKey,
            enabled: f.enabled,
            reason: f.reason,
            expiresAt: f.expiresAt?.toISOString() ?? null,
            setByEmail: f.setByEmail,
          })),
        /*
         * ⭐ WHAT THIS CUSTOMER WOULD BE TOLD, resolved through the
         * chain from the rows already in hand. See the caveat carried
         * on the field itself: the customer's own banner does not read
         * this yet.
         */
        suspensionMessage: (() => {
          const row = flagRows.find(
            (f) => f.flagKey === configOverrideKeyFor("suspension.customer_message"),
          );
          const override: TenantOverrideInput = row
            ? {
                present: true,
                raw: (row.value as { value?: unknown } | null)?.value,
                reason: row.reason,
                setByEmail: row.setByEmail,
                setAt: row.updatedAt.toISOString(),
              }
            : { present: false };
          const resolved = resolveConfig({
            key: "suspension.customer_message",
            // ⚠️ The cached column, not the subscription's tier. This
            // page reports `tenants.plan_tier` throughout and a message
            // resolved against a different tier than the plan shown
            // beside it would be unexplainable on a support call.
            planTier: tenant.planTier,
            override,
          });
          return {
            effective: String(resolved.effective),
            layer: resolved.effectiveLayer,
            setByEmail: row?.setByEmail ?? null,
          };
        })(),
        /*
         * ⭐ Derived from the same rows, at the same `now` the health
         * verdict used. A countdown computed from a second clock read
         * can disagree with the badge beside it by a minute, which is
         * exactly the sort of thing that makes an operator distrust the
         * screen at the moment they most need to believe it.
         */
        offboarding: (() => {
          const row = flagRows.find((f) => f.flagKey === OFFBOARDING_FLAG_KEY);
          const value = row?.value as unknown as Partial<OffboardingRecord> | null;
          if (!value || typeof value.scheduledFor !== "string") return null;
          return offboardingView(value as OffboardingRecord, now);
        })(),
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

      /*
       * ══════════════════════════════════════════════════════════════
       * ⭐⭐ THE CUSTOMER-FACING MESSAGE NOW HAS SOMEWHERE TO LIVE
       * ══════════════════════════════════════════════════════════════
       * `customerMessage` has been collected by `suspendTenantSchema`
       * since v0.14.0 and its only destination was an audit metadata
       * blob. Nothing could read it back, so a field the operator was
       * asked to write carefully was, in effect, a comment.
       *
       * ⭐ It is now the TENANT LAYER of `suspension.customer_message`
       * in the configuration chain: typed, capped at 500 characters,
       * carrying this operator's name, resolvable against a global
       * default and a plan-level one, and readable by
       * `getTenantDetail` so the console can show exactly what is on
       * file for this customer.
       *
       * ⚠️ AND HERE IS WHAT IT STILL DOES NOT DO, SAID PLAINLY: the
       * lockout banner the customer actually sees is built by
       * `evaluateAccess()` in `lib/billing/access-state.ts`, which
       * returns a fixed sentence and does not consult this value. That
       * file is not owned by this batch. The console says so next to
       * the field rather than letting an operator believe they have
       * written something the customer will read.
       */
      if (customerMessage) {
        await db
          .insert(platformTenantFlags)
          .values({
            tenantId,
            flagKey: configOverrideKeyFor("suspension.customer_message"),
            enabled: true,
            value: { value: customerMessage },
            reason,
            expiresAt: null,
            setByStaffId: operator.staff.id,
            setByEmail: operator.email,
          })
          .onConflictDoUpdate({
            target: [platformTenantFlags.tenantId, platformTenantFlags.flagKey],
            set: {
              enabled: true,
              value: { value: customerMessage },
              reason,
              setByStaffId: operator.staff.id,
              setByEmail: operator.email,
              updatedAt: new Date(),
            },
          });
      }

      return { previousStatus: tenant.status, slug: tenant.slug } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  /*
   * ⚠️ A SECOND AUDIT ROW, WITH THE RESOURCE TYPE THE CONFIGURATION
   * HISTORY READS. `listConfigVersions` selects on
   * `tenant_config_override`; folding this change into the suspension
   * row would leave the customer's message history with a hole in it
   * exactly where the message was most likely to have been set.
   */
  if (customerMessage) {
    await recordPlatformAudit({
      operator,
      tenantId,
      action: "config_change",
      resourceType: "tenant_config_override",
      resourceId: "suspension.customer_message",
      oldValue: null,
      newValue: { effective: customerMessage, layer: "tenant" },
      severity: "warning",
      reason: `Set while suspending this workspace: ${reason}`,
      metadata: { configKey: "suspension.customer_message", setDuring: "suspension" },
    });
  }

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

/* ================================================================== */
/* ⭐⭐⭐ OFFBOARDING — BATCH 46                                        */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════
 * Ordence could suspend a customer and could not offboard one. There was
 * no code path anywhere in this repository that terminated a workspace,
 * which `lib/platform/roles.ts` already says out loud in the comment that
 * put provisioning on the step-up list. So a customer who left stayed a
 * customer forever, in every report, on a public hostname.
 *
 * ⚠️ THIS BATCH DOES NOT DELETE ANYTHING. Read that again before
 * changing anything below. What it builds is the RECORD and the WINDOW:
 *
 *   ① a request that carries three separate confirmations,
 *   ② a SECOND APPROVER, through the queue that already exists,
 *   ③ a scheduled moment, written down, some hours in the future,
 *   ④ a cancel that actually works and restores the previous status,
 *   ⑤ an export the departing customer is entitled to,
 *   ⑥ a retention countdown after the scheduled moment.
 *
 * 🔴 NOTHING RUNS STEP ⑦. There is no cron, no queue worker and no
 * scheduled function in this build that reads a due termination and
 * deletes a workspace. `offboardingView()` returns `executorPresent:
 * false` and the panel says so in as many words, because a screen that
 * shows a countdown to a deletion that will never happen is worse than
 * no screen: an operator tells a customer "your data is gone on the
 * 14th", and it is not.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THE 24-HOUR WINDOW IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * Three confirmations and a second approver still add up to a button
 * that deletes a company the moment it is pressed. Every one of those
 * controls is spent BEFORE the irreversible thing happens; none of them
 * helps the person who realises, forty minutes later, that they had two
 * tabs open. The window is the only control that is still available
 * AFTER the mistake has been made, and it is the reason this is
 * survivable at all.
 *
 * ⚠️ SO THE WINDOW IS DATA, NOT A CONSTANT. It comes from the
 * configuration chain (`offboarding.cancel_window_hours`), it is frozen
 * onto the record at approval time so a later config change cannot
 * shorten a window a customer was already promised, and the cancel
 * checks the frozen value.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHERE THE RECORD LIVES, AND WHY IT IS NOT A NEW TABLE
 * ══════════════════════════════════════════════════════════════════════
 * This batch ships with NO MIGRATION, so a `tenant_offboarding` table
 * was not available. The record goes into `platform_tenant_flags` under
 * a fourth namespace, `lifecycle:` — the same table, the same RLS
 * policy, and the same reasoning `lib/entitlements/overrides.ts` gives
 * for keeping `entitlement:` apart from the flag catalogue.
 *
 * That table is a genuinely reasonable home: it is platform-owned,
 * tenant-scoped, has a jsonb payload column, carries the acting staff
 * member and their email, and the customer's own connection may READ it
 * — which, for the record of their own deletion, they are entitled to.
 *
 * ⚠️ WHAT IT COSTS, STATED PLAINLY: there is one row per workspace, so
 * the record is CURRENT-STATE ONLY. The history of a cancelled-then-
 * re-requested termination lives in `audit_logs`, not here. A dedicated
 * table with one row per attempt would be better and is the first thing
 * to build when a migration is available.
 */

/** The fourth namespace in `platform_tenant_flags`. */
const OFFBOARDING_FLAG_KEY = "lifecycle:offboarding";

/**
 * ⚠️ TYPED AS A LITERAL, NOT AS A FREE STRING, and re-checked on the
 * server. This is the second of the three confirmations and its whole
 * job is to be impossible to produce by muscle memory.
 */
const TERMINATION_PHRASE = "DELETE ALL DATA";

export type OffboardingRecord = {
  /** `scheduled` while it is live; `cancelled` once it has been pulled. */
  stage: "scheduled" | "cancelled";
  requestedByEmail: string;
  requestedAt: string;
  approvedByEmail: string;
  approvedAt: string;
  /** ⭐ The moment the deletion becomes due. Frozen at approval. */
  scheduledFor: string;
  /** Frozen too, so the screen can say "you had 24 hours" truthfully. */
  cancelWindowHours: number;
  retentionDays: number;
  retentionEndsAt: string;
  /** Restored verbatim on cancel. Never assumed to be `active`. */
  previousStatus: "pending" | "active" | "suspended" | "archived";
  reason: string;
  exportedAt?: string;
  exportRowCount?: number;
  exportFailures?: string[];
  cancelledAt?: string;
  cancelledByEmail?: string;
  cancelReason?: string;
};

export type OffboardingView = OffboardingRecord & {
  /**
   * Derived from the clock, never stored. A stored phase is a phase that
   * is wrong exactly when somebody is looking at it — the same argument
   * `isTenantFlagEnabled` makes about applying expiry in the query
   * rather than in a job.
   */
  phase: "cancel_window" | "retention" | "deletion_due" | "cancelled";
  minutesLeftInWindow: number;
  daysLeftInRetention: number;
  cancellable: boolean;
  /**
   * 🔴 FALSE, AND HARDCODED FALSE ON PURPOSE. Nothing in this build
   * executes a due termination. Flip this only in the commit that adds
   * the executor, and the panel's wording changes with it.
   */
  executorPresent: false;
};

/** Pure. `now` is an argument so the screen and a test can agree. */
export function offboardingView(record: OffboardingRecord, now: Date): OffboardingView {
  const scheduledFor = new Date(record.scheduledFor).getTime();
  const retentionEndsAt = new Date(record.retentionEndsAt).getTime();
  const t = now.getTime();

  const phase: OffboardingView["phase"] =
    record.stage === "cancelled"
      ? "cancelled"
      : t < scheduledFor
        ? "cancel_window"
        : t < retentionEndsAt
          ? "retention"
          : "deletion_due";

  return {
    ...record,
    phase,
    minutesLeftInWindow: Math.max(0, Math.ceil((scheduledFor - t) / 60_000)),
    daysLeftInRetention: Math.max(0, Math.ceil((retentionEndsAt - t) / 86_400_000)),
    /*
     * ⚠️ CANCELLABLE FOR AS LONG AS NOTHING HAS BEEN DELETED, WHICH IS
     * FOREVER IN THIS BUILD — and that is not the window being fake, it
     * is the window being honest about the executor that does not exist.
     * Refusing to cancel a "missed" termination would strand a workspace
     * in `pending_deletion` with no way back and nothing to have caused
     * it. The phase above still says whether the window was missed, and
     * the audit row records that it was cancelled late.
     */
    cancellable: record.stage === "scheduled",
    executorPresent: false,
  };
}

/** Read the current record, or null. Never throws — a broken row reads as absent. */
async function readOffboarding(tenantId: string): Promise<OffboardingRecord | null> {
  try {
    const [row] = await withPlatformScope(
      `Platform console: read offboarding record for tenant ${tenantId}`,
      async (db) =>
        db
          .select()
          .from(platformTenantFlags)
          .where(
            and(
              eq(platformTenantFlags.tenantId, tenantId),
              eq(platformTenantFlags.flagKey, OFFBOARDING_FLAG_KEY),
            ),
          )
          .limit(1),
    );
    if (!row) return null;
    const value = row.value as unknown as Partial<OffboardingRecord> | null;
    if (!value || typeof value.scheduledFor !== "string") return null;
    return value as OffboardingRecord;
  } catch (err) {
    console.error("[platform] offboarding record could not be read", { tenantId, err });
    return null;
  }
}

async function writeOffboarding(args: {
  tenantId: string;
  record: OffboardingRecord;
  operator: PlatformOperator;
  justification: string;
}): Promise<void> {
  await withPlatformScope(
    `Platform console: record offboarding state ${args.record.stage} for tenant ${args.tenantId}`,
    async (db) => {
      await db
        .insert(platformTenantFlags)
        .values({
          tenantId: args.tenantId,
          flagKey: OFFBOARDING_FLAG_KEY,
          // Live while scheduled, off once cancelled. The ROW is never
          // deleted: the evidence that a termination was requested and
          // pulled is the most interesting thing on the workspace.
          enabled: args.record.stage === "scheduled",
          value: args.record as unknown as Record<string, unknown>,
          reason: args.justification,
          // ⚠️ NEVER AN EXPIRY. A record that expires is a scheduled
          // deletion that quietly stops existing on the day it matters.
          expiresAt: null,
          setByStaffId: args.operator.staff.id,
          setByEmail: args.operator.email,
        })
        .onConflictDoUpdate({
          target: [platformTenantFlags.tenantId, platformTenantFlags.flagKey],
          set: {
            enabled: args.record.stage === "scheduled",
            value: args.record as unknown as Record<string, unknown>,
            reason: args.justification,
            expiresAt: null,
            setByStaffId: args.operator.staff.id,
            setByEmail: args.operator.email,
            updatedAt: new Date(),
          },
        });
    },
  );
}

/* ------------------------------------------------------------------ */
/* SCHEDULE — the approval executor                                    */
/* ------------------------------------------------------------------ */

const scheduleTerminationSchema = z.object({
  tenantId: z.string().uuid(),
  /** ① The workspace address, typed. */
  confirmSlug: z.string().trim().min(1),
  /** ② A phrase that cannot be produced by muscle memory. */
  confirmPhrase: z.string().trim(),
  /** ③ An explicit acknowledgement that the export was offered. */
  acknowledgeExport: z.literal(true),
  reason: z.string().trim().min(20).max(1000),
  requestedByEmail: z.string().email(),
  requestedAt: z.string(),
});

/**
 * ⭐⭐⭐ APPROVAL PUTS A DATE ON THE CALENDAR. IT DOES NOT DELETE.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE GUARD IS HERE, AT THE FUNCTION, AND IT IS `tenants:suspend`
 * ══════════════════════════════════════════════════════════════════════
 * This is reachable only through the approval executor registered in
 * `control-actions.ts` — exactly like `suspendTenant`, and for the same
 * reason: one door with two locks. The capability check still lives at
 * the top of the function, because the function is what an executor
 * calls and a guard at the caller is a guard somebody eventually calls
 * around.
 *
 * 🔴 IT IS `tenants:suspend` AND NOT A `tenants:terminate` CAPABILITY
 * BECAUSE NO SUCH CAPABILITY EXISTS AND `lib/platform/roles.ts` IS NOT
 * OWNED BY THIS BATCH. `tenants:suspend` is the strictest gate
 * available: owner grade only, and on `STEP_UP_CAPABILITIES`, so a
 * lifted cookie with no fresh second factor cannot reach it. Adding
 * `tenants:terminate` is the right follow-up and is listed in the batch
 * report.
 */
export async function scheduleTenantTermination(
  input: unknown,
): Promise<PlatformResult<{ scheduledFor: string; note: string }>> {
  const operator = await requireCapability("tenants:suspend");

  const parsed = scheduleTerminationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "The stored request is not a complete termination request. Nothing has been changed; raise it again.",
    };
  }
  const { tenantId, confirmSlug, confirmPhrase, reason, requestedByEmail, requestedAt } =
    parsed.data;

  /*
   * ⚠️ THE THREE CONFIRMATIONS ARE CHECKED AGAIN HERE, hours after they
   * were typed. Not paranoia about the queue row — it is validated on
   * the way in — but because the SLUG can change between request and
   * approval. A workspace that was renamed is a workspace where the
   * approver may be looking at a different customer than the requester
   * was, and that is precisely the mistake the typed slug exists to
   * catch.
   */
  if (confirmPhrase !== TERMINATION_PHRASE) {
    return { ok: false, error: "The confirmation phrase does not match." };
  }

  const now = new Date();

  // The window and the retention come from the configuration chain, so
  // an enterprise customer's longer window is a property of their plan
  // rather than a number somebody remembered.
  const chain = await getConfigChain(tenantId);
  if (!chain.ok) return { ok: false, error: chain.error };

  const windowHours = Number(
    chain.data.resolutions.find((r) => r.key === "offboarding.cancel_window_hours")?.effective ??
      24,
  );
  const retentionDays = Number(
    chain.data.resolutions.find((r) => r.key === "offboarding.retention_days")?.effective ?? 30,
  );

  const scheduledFor = new Date(now.getTime() + windowHours * 3_600_000);
  const retentionEndsAt = new Date(scheduledFor.getTime() + retentionDays * 86_400_000);

  const outcome = await withPlatformScope(
    `Platform console: schedule termination of tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const [tenant] = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { error: "Workspace not found." } as const;
      if (tenant.slug !== confirmSlug.trim()) {
        return {
          error:
            "This workspace's address has changed since the request was raised. Nothing has been scheduled — raise it again against the current address.",
        } as const;
      }
      if (tenant.status === "pending_deletion") {
        return { error: "A termination is already scheduled for this workspace." } as const;
      }

      /*
       * ⭐ `pending_deletion` IS THE GRACE STAGE, AND IT ALREADY WORKS.
       * `evaluateAccess()` maps it to `locked` with `canExport: true` —
       * the customer cannot use the product and can still take their
       * data out. Nothing new had to be built for the read-only grace
       * period; it was already the meaning of this status.
       */
      await db
        .update(tenants)
        .set({ status: "pending_deletion", updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

      return { previousStatus: tenant.status, slug: tenant.slug, name: tenant.name } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  const record: OffboardingRecord = {
    stage: "scheduled",
    requestedByEmail,
    requestedAt,
    approvedByEmail: operator.email,
    approvedAt: now.toISOString(),
    scheduledFor: scheduledFor.toISOString(),
    cancelWindowHours: windowHours,
    retentionDays,
    retentionEndsAt: retentionEndsAt.toISOString(),
    previousStatus: outcome.previousStatus as OffboardingRecord["previousStatus"],
    reason,
  };

  await writeOffboarding({ tenantId, record, operator, justification: reason });

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_termination",
    resourceId: tenantId,
    oldValue: { status: outcome.previousStatus },
    newValue: { status: "pending_deletion", scheduledFor: record.scheduledFor },
    severity: "critical",
    reason,
    metadata: {
      slug: outcome.slug,
      requestedByEmail,
      approvedByEmail: operator.email,
      cancelWindowHours: windowHours,
      retentionDays,
      retentionEndsAt: record.retentionEndsAt,
      // ⚠️ SAID IN THE AUDIT ROW TOO, not only on the screen. Somebody
      // reading this trail in a year must not conclude from a
      // "termination" row that data was destroyed on that date.
      dataDeleted: false,
      executorPresent: false,
      note: "Scheduled only. No process in this build carries out a due termination.",
    },
  });

  return {
    ok: true,
    data: {
      scheduledFor: record.scheduledFor,
      note: `${outcome.name} is locked and read-only. Deletion is scheduled for ${record.scheduledFor}, and it can be cancelled at any time until then. Nothing has been deleted, and nothing in this build deletes it.`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* CANCEL — the control that has to actually work                      */
/* ------------------------------------------------------------------ */

const cancelTerminationSchema = z.object({
  tenantId: z.string().uuid(),
  reason: z.string().trim().min(15).max(1000),
});

/**
 * ⭐⭐⭐ THE CANCEL. NO SECOND APPROVER, NO TYPED SLUG, NO CEREMONY.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 STOPPING A DESTRUCTIVE ACTION MUST BE EASIER THAN STARTING ONE
 * ══════════════════════════════════════════════════════════════════════
 * Every control on the request path exists to slow somebody down.
 * Applying any of them here would be exactly backwards: the person
 * cancelling has realised a mistake, is probably on the phone to the
 * customer, and every extra field is a minute the workspace stays
 * locked. Symmetry between "delete" and "do not delete" is a design
 * error that reads as rigour.
 *
 * ⚠️ IT RESTORES THE STATUS THE WORKSPACE HELD, from the frozen record —
 * not `active`. Blindly setting `active` would silently complete the
 * onboarding of a workspace that was `pending`, and would un-suspend one
 * that was suspended for abuse. Same rule as `reactivateTenant`.
 */
export async function cancelTenantTermination(
  input: unknown,
): Promise<PlatformResult<{ note: string }>> {
  const operator = await requireCapability("tenants:suspend");

  const parsed = cancelTerminationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "A reason of at least fifteen characters is required.",
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { tenantId, reason } = parsed.data;
  const now = new Date();

  const record = await readOffboarding(tenantId);
  if (!record) {
    return { ok: false, error: "No termination is scheduled for this workspace." };
  }
  if (record.stage !== "scheduled") {
    return { ok: false, error: "That termination has already been cancelled." };
  }

  const view = offboardingView(record, now);
  const lateCancel = view.phase !== "cancel_window";

  const outcome = await withPlatformScope(
    `Platform console: cancel scheduled termination of tenant ${tenantId} — ${reason.slice(0, 80)}`,
    async (db) => {
      const [tenant] = await db
        .select({ status: tenants.status, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) return { error: "Workspace not found." } as const;

      await db
        .update(tenants)
        .set({ status: record.previousStatus, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));

      return { name: tenant.name, wasStatus: tenant.status } as const;
    },
  );

  if (outcome.error) return { ok: false, error: outcome.error };

  await writeOffboarding({
    tenantId,
    record: {
      ...record,
      stage: "cancelled",
      cancelledAt: now.toISOString(),
      cancelledByEmail: operator.email,
      cancelReason: reason,
    },
    operator,
    justification: reason,
  });

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "config_change",
    resourceType: "tenant_termination",
    resourceId: tenantId,
    oldValue: { status: outcome.wasStatus, scheduledFor: record.scheduledFor },
    newValue: { status: record.previousStatus, cancelled: true },
    severity: "critical",
    reason,
    metadata: {
      cancelledByEmail: operator.email,
      // ⚠️ RECORDED SEPARATELY. A cancel inside the window is the control
      // working; a cancel after it is a workspace that sat in
      // `pending_deletion` past its date because nothing runs the job.
      // A reviewer counting the second kind is counting how badly the
      // missing executor is needed.
      insideCancelWindow: !lateCancel,
      scheduledFor: record.scheduledFor,
      dataDeleted: false,
    },
  });

  return {
    ok: true,
    data: {
      note: lateCancel
        ? `${outcome.name} is back to ${record.previousStatus}. The scheduled moment had already passed — nothing had run, because no process in this build carries out a due termination.`
        : `${outcome.name} is back to ${record.previousStatus}. Cancelled with ${view.minutesLeftInWindow} minutes of the window left.`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* EXPORT — what the departing customer is owed                        */
/* ------------------------------------------------------------------ */

const exportSnapshotSchema = z.object({ tenantId: z.string().uuid() });

/**
 * ⚠️ ~8 MB OF JSON. Above that the file is not returned through the
 * server action and the manifest is, with a sentence saying so. A server
 * action response is buffered in memory on both ends; a 200 MB string
 * does not fail politely, it takes the console down for everybody at the
 * moment somebody is trying to help a customer leave.
 */
const MAX_INLINE_EXPORT_BYTES = 8_000_000;

/**
 * ⭐⭐ THE EXPORT STEP, AND IT REALLY RUNS.
 *
 * `server/backup/export.ts` has been able to serialise a whole workspace
 * since Phase 12 and nothing on the console had ever called it. This is
 * the call: it reads through `withTenant`, so the customer's own RLS
 * decides what comes out, and it records the row counts onto the
 * offboarding record as a RECEIPT — the count is the evidence that the
 * export was produced before the deletion date, which is the fact a
 * DPDP complaint six months later turns on.
 *
 * ⚠️ GUARDED WITH `tenants:suspend`, NOT `tenants:read`. Every other
 * console read is metadata about the commercial relationship; this one
 * returns the customer's actual records. It belongs with the strictest
 * gate available — owner grade and a fresh second factor — and it is
 * audited as an `export` against the customer's own log so they can see
 * that we took a copy.
 */
export async function exportOffboardingSnapshot(
  input: unknown,
): Promise<
  PlatformResult<{
    fileName: string;
    rowCount: number;
    failures: string[];
    /** Null when the extract was too large to hand back inline. */
    file: string | null;
    note: string;
  }>
> {
  const operator = await requireCapability("tenants:suspend");

  const parsed = exportSnapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the form." };
  const { tenantId } = parsed.data;

  const [tenant] = await withPlatformScope(
    `Platform console: read workspace name for offboarding export ${tenantId}`,
    async (db) =>
      db
        .select({ name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
  );

  if (!tenant) return { ok: false, error: "Workspace not found." };

  const now = new Date();
  const exported = await exportTenantData(tenantId, tenant.name);
  const rowCount = Object.values(exported.manifest.counts).reduce((a, b) => a + b, 0);
  const failures = exported.manifest.failures.map((f) => `${f.table}: ${f.reason}`);

  const serialised = serialiseExport(exported);
  const tooLarge = serialised.length > MAX_INLINE_EXPORT_BYTES;

  // The receipt goes onto the offboarding record when there is one. An
  // export taken before a termination is requested is still a valid
  // export; it simply has nowhere to be a receipt for yet.
  const record = await readOffboarding(tenantId);
  if (record) {
    await writeOffboarding({
      tenantId,
      record: {
        ...record,
        exportedAt: now.toISOString(),
        exportRowCount: rowCount,
        exportFailures: failures,
      },
      operator,
      justification: record.reason,
    });
  }

  await recordPlatformAudit({
    operator,
    tenantId,
    action: "export",
    resourceType: "tenant_offboarding_export",
    resourceId: tenantId,
    severity: "critical",
    reason:
      "Platform staff produced a full export of this workspace's records as part of offboarding.",
    metadata: {
      rowCount,
      tables: Object.keys(exported.manifest.counts).length,
      failures,
      deliveredInline: !tooLarge,
    },
  });

  return {
    ok: true,
    data: {
      fileName: exportFileName(tenant.name, now),
      rowCount,
      failures,
      file: tooLarge ? null : serialised,
      note: tooLarge
        ? `${rowCount} rows were read and the extract is too large to download from this screen. The counts are recorded on the offboarding record; produce the file from the backup tooling.`
        : `${rowCount} rows across ${Object.keys(exported.manifest.counts).length} tables.${
            failures.length > 0
              ? ` ${failures.length} table(s) failed and are listed in the file — the rest is complete.`
              : ""
          }`,
    },
  };
}

/** The record plus everything derived from the clock, for the panel. */
export async function getOffboarding(
  tenantId: string,
): Promise<OffboardingView | null> {
  const record = await readOffboarding(tenantId);
  return record ? offboardingView(record, new Date()) : null;
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
