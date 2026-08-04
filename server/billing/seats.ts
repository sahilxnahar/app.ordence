import "server-only";

/**
 * Ordence — Server-Side Seat Gate
 * Version: v0.13.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * SEATS ARE COUNTED LIVE, NEVER CACHED
 * ══════════════════════════════════════════════════════════════════════
 * There is an obvious optimisation here — keep a `seatsUsed` counter on
 * the tenant and increment it — and it is a trap. Every path that
 * changes a user's status would have to remember to adjust it: invite,
 * accept, suspend, reactivate, offboard, soft-delete, the Clerk webhook,
 * a bulk import, an admin correction. One missed path and the counter
 * drifts, and a drifted seat counter either blocks a customer who has
 * seats free or lets them exceed what they paid for. Both surface as
 * support tickets weeks later, and neither is reproducible.
 *
 * A `COUNT(*)` against an indexed `(tenant_id, status)` on a table with
 * tens of rows per tenant is measured in microseconds. There is no
 * performance problem to solve here, only a correctness one to avoid
 * creating.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE RACE, AND WHY IT IS ACCEPTED
 * ══════════════════════════════════════════════════════════════════════
 * Two admins inviting the last seat simultaneously can both pass the
 * check and both succeed, leaving the workspace one seat over.
 *
 * A database-level guarantee would need either a `SELECT … FOR UPDATE` on
 * the tenant row for every invitation — serialising an unrelated hot row
 * — or an exclusion constraint that cannot express "count of rows
 * matching a predicate".
 *
 * The consequence of losing the race is that a customer has one extra
 * person working for a moment and is told they are over limit. Nobody is
 * charged, nobody is locked out, and the next admin action reconciles it.
 * That is a proportionate outcome, unlike the double-billing race in
 * Phase 11 — which is why THAT one is enforced by a unique index and this
 * one is not.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, subscriptions, plans } from "@/db/schema";
import {
  canTakeSeats,
  computeSeatState,
  describeOverage,
  describeNearLimit,
  SEAT_EXEMPT_ROLES,
  SEAT_CONSUMING_STATUSES,
  type SeatState,
  type SeatVerdict,
} from "@/lib/billing/seats";

/* ------------------------------------------------------------------ */
/* ERRORS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Distinct from `FeatureLockedError` and `PermissionDeniedError`.
 *
 * Three different denials with three different remedies:
 *   permission  → "ask your admin"
 *   entitlement → "upgrade your plan"
 *   seats       → "buy a seat, or free one"
 *
 * Collapsing any two of them guarantees the wrong advice eventually.
 */
export class SeatLimitError extends Error {
  constructor(readonly verdict: SeatVerdict) {
    super(verdict.message);
    this.name = "SeatLimitError";
  }

  get state(): SeatState {
    return this.verdict.state;
  }
}

/* ------------------------------------------------------------------ */
/* COUNTING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Count seats in use for a tenant.
 *
 * ⚠️ The predicate here MUST match `occupiesSeat()` in
 * `lib/billing/seats.ts`. They are two expressions of one rule — one in
 * SQL for counting at scale, one in TypeScript for deciding about a
 * single user — and if they diverge the number shown to a customer stops
 * matching the number enforced against them.
 *
 * `tests/security/seat-licensing.test.ts` asserts they agree against a
 * real database, over a fixture containing every status and both exempt
 * roles. That test is the only thing keeping them in step.
 */
export async function countSeatsInUse(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        sql`${users.deletedAt} IS NULL`,
        sql`${users.status} = ANY(${sql.raw(
          `ARRAY[${SEAT_CONSUMING_STATUSES.map((s) => `'${s}'`).join(",")}]::user_status[]`,
        )})`,
        sql`${users.role} <> ALL(${sql.raw(
          `ARRAY[${SEAT_EXEMPT_ROLES.map((r) => `'${r}'`).join(",")}]::system_role[]`,
        )})`,
      ),
    );

  return row?.count ?? 0;
}

/**
 * How many seats a tenant has bought.
 *
 * Prefers the SUBSCRIPTION, falling back to `tenants.seat_limit`, for the
 * same reason the entitlement gate prefers the subscription: the column
 * on `tenants` is a cache maintained by webhook, and a delayed webhook
 * would block a customer who has just bought seats.
 *
 * When neither exists — a workspace mid-signup — the plan's
 * `includedSeats` is the answer.
 */
export async function countSeatsPurchased(
  tenantId: string,
  fallbackSeatLimit: number,
): Promise<number> {
  const [row] = await db
    .select({
      seatsPurchased: subscriptions.seatsPurchased,
      includedSeats: plans.includedSeats,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.tenantId, tenantId),
        sql`${subscriptions.deletedAt} IS NULL`,
        sql`${subscriptions.status} IN ('trialing','active','past_due','unpaid','paused')`,
      ),
    )
    .limit(1);

  if (!row) return Math.max(0, fallbackSeatLimit);

  // `seatsPurchased` is what they actually bought; `includedSeats` is the
  // plan's floor. Take the larger — a plan whose floor rose in the
  // catalogue should not silently reduce what a customer already has.
  return Math.max(row.seatsPurchased, row.includedSeats, 0);
}

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

export async function getSeatState(
  tenantId: string,
  fallbackSeatLimit: number,
): Promise<SeatState> {
  const [used, purchased] = await Promise.all([
    countSeatsInUse(tenantId),
    countSeatsPurchased(tenantId, fallbackSeatLimit),
  ]);
  return computeSeatState(used, purchased);
}

/** Non-throwing check. Use to render a warning or disable a button. */
export async function checkSeatAvailability(
  tenantId: string,
  fallbackSeatLimit: number,
  count = 1,
): Promise<SeatVerdict> {
  const [used, purchased] = await Promise.all([
    countSeatsInUse(tenantId),
    countSeatsPurchased(tenantId, fallbackSeatLimit),
  ]);
  return canTakeSeats(used, purchased, count);
}

/**
 * Throwing gate. Call before any action that puts a user into `invited`
 * or `active`.
 *
 * ⚠️ Reactivating a suspended user goes through here too. Suspension
 * frees a seat, so un-suspending takes one — and it can fail. That
 * asymmetry surprises people, so the message says what to do about it.
 */
export async function requireSeat(
  tenantId: string,
  fallbackSeatLimit: number,
  count = 1,
): Promise<SeatVerdict> {
  const verdict = await checkSeatAvailability(tenantId, fallbackSeatLimit, count);
  if (!verdict.allowed) throw new SeatLimitError(verdict);
  return verdict;
}

/* ------------------------------------------------------------------ */
/* SUMMARY FOR THE UI                                                  */
/* ------------------------------------------------------------------ */

export type SeatSummary = SeatState & {
  /** Non-null when the workspace is over its limit. */
  overageMessage: string | null;
  /** Non-null when approaching the limit but not yet blocked. */
  warningMessage: string | null;
};

export async function getSeatSummary(
  tenantId: string,
  fallbackSeatLimit: number,
): Promise<SeatSummary> {
  const state = await getSeatState(tenantId, fallbackSeatLimit);
  return {
    ...state,
    overageMessage: describeOverage(state),
    warningMessage: describeNearLimit(state),
  };
}
