/**
 * Ordence — Seat Arithmetic
 * Version: v0.13.0-alpha
 *
 * Pure and isomorphic. The team page, the invite dialog and the server
 * gate all need the same answer, and a second implementation on the
 * client is how "the page said you had a seat spare" happens.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE HARDEST QUESTION IN SEAT LICENSING IS WHAT COUNTS AS A SEAT
 * ══════════════════════════════════════════════════════════════════════
 * It sounds trivial and it is not. Every answer below is a commercial
 * decision with a support consequence, so each is stated explicitly
 * rather than falling out of a `WHERE` clause someone wrote once.
 *
 *   ACTIVE users            → COUNT. Obviously.
 *
 *   INVITED users           → COUNT. This is the one people get wrong.
 *                             If an invitation does not hold a seat, a
 *                             workspace on 5 seats can invite fifty
 *                             people, and the moment they accept you
 *                             either bill for forty-five unpurchased
 *                             seats or lock forty-five people out on
 *                             their first day. Both are bad; holding the
 *                             seat at invitation time is the only version
 *                             where nobody is surprised.
 *
 *   SUSPENDED users         → DO NOT COUNT. Suspension is how a customer
 *                             frees a seat without destroying an audit
 *                             trail. If suspension did not free the seat
 *                             there would be no way to swap one employee
 *                             for another without buying a seat you do
 *                             not need.
 *                             ⚠️ The consequence: REACTIVATING a
 *                             suspended user CONSUMES a seat and can
 *                             therefore fail. That is checked.
 *
 *   OFFBOARDED users        → DO NOT COUNT. They have left.
 *
 *   SOFT-DELETED users      → DO NOT COUNT.
 *
 *   platform_super_admin    → DO NOT COUNT. Our own staff assisting a
 *                             customer must never consume a seat the
 *                             customer paid for. Billing someone for our
 *                             support engineer would be indefensible.
 *
 *   guest role              → DO NOT COUNT. A guest is a scoped, external
 *                             participant — closer to a portal visitor
 *                             than to an employee. Charging per guest
 *                             would discourage exactly the collaboration
 *                             the product is for.
 */

import type { SystemRole } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* WHAT OCCUPIES A SEAT                                                */
/* ------------------------------------------------------------------ */

/** User statuses that hold a seat. */
export const SEAT_CONSUMING_STATUSES = ["invited", "active"] as const;

/** Roles that never hold a seat, whatever their status. */
export const SEAT_EXEMPT_ROLES: readonly SystemRole[] = [
  "platform_super_admin",
  "guest",
];

export type SeatOccupant = {
  status: string;
  role: SystemRole;
  deletedAt?: Date | string | null;
};

/**
 * Does this user occupy a seat right now?
 *
 * Exported and tested individually because it is the single predicate
 * every other calculation in this file depends on. A change here changes
 * what customers are billed.
 */
export function occupiesSeat(user: SeatOccupant): boolean {
  if (user.deletedAt) return false;
  if (SEAT_EXEMPT_ROLES.includes(user.role)) return false;
  return (SEAT_CONSUMING_STATUSES as readonly string[]).includes(user.status);
}

export function countOccupiedSeats(users: readonly SeatOccupant[]): number {
  return users.reduce((total, user) => total + (occupiesSeat(user) ? 1 : 0), 0);
}

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

export type SeatState = {
  used: number;
  purchased: number;
  available: number;
  /** used / purchased, clamped to [0, ∞). 1.0 means exactly full. */
  utilisation: number;
  /** Approaching the limit — warn, but do not block. */
  isNearLimit: boolean;
  isAtLimit: boolean;
  isOverLimit: boolean;
};

/**
 * Warn at 80% of purchased seats.
 *
 * Early enough that an admin can buy more before anyone is blocked, late
 * enough that a five-seat workspace is not nagged from the second user.
 * At five seats it fires on the fourth, which is the right moment.
 */
export const SEAT_WARNING_THRESHOLD = 0.8;

export function computeSeatState(used: number, purchased: number): SeatState {
  const safePurchased = Math.max(0, Math.trunc(purchased));
  const safeUsed = Math.max(0, Math.trunc(used));
  const available = Math.max(0, safePurchased - safeUsed);

  // Guard the division. A plan with zero purchased seats is a
  // misconfiguration, and `0/0 = NaN` would make every comparison below
  // silently false — i.e. a workspace with no seats would appear to be
  // neither at nor over its limit, and would never be stopped.
  const utilisation = safePurchased === 0 ? (safeUsed > 0 ? Infinity : 0) : safeUsed / safePurchased;

  return {
    used: safeUsed,
    purchased: safePurchased,
    available,
    utilisation,
    isNearLimit: utilisation >= SEAT_WARNING_THRESHOLD && safeUsed < safePurchased,
    isAtLimit: safeUsed >= safePurchased,
    isOverLimit: safeUsed > safePurchased,
  };
}

/* ------------------------------------------------------------------ */
/* CAN WE ADD ANOTHER?                                                 */
/* ------------------------------------------------------------------ */

export type SeatVerdict = {
  allowed: boolean;
  reason: "available" | "no_seats_left" | "would_exceed" | "no_subscription";
  state: SeatState;
  /** Ready to show a customer. */
  message: string;
};

/**
 * Decide whether `count` more seats can be taken.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS BLOCKS RATHER THAN AUTO-CHARGING
 * ══════════════════════════════════════════════════════════════════════
 * The tempting alternative is to let the invitation through and add the
 * seat to the next invoice. It is what several products do, and it is a
 * trap: an admin adding twelve people on a Friday afternoon discovers a
 * bill they never agreed to on the first of the month, and the support
 * conversation that follows is one you cannot win.
 *
 * Blocking with a clear "you need N more seats, here is the price" makes
 * the purchase deliberate. Phase 14 turns that message into a one-click
 * seat top-up; until then it is a message and a link.
 */
export function canTakeSeats(
  used: number,
  purchased: number,
  count = 1,
): SeatVerdict {
  const state = computeSeatState(used, purchased);
  const wanted = Math.max(1, Math.trunc(count));

  if (state.available >= wanted) {
    return {
      allowed: true,
      reason: "available",
      state,
      message:
        state.available - wanted === 0
          ? "This uses your last seat."
          : `${state.available - wanted} seat${state.available - wanted === 1 ? "" : "s"} will remain.`,
    };
  }

  const shortfall = wanted - state.available;

  if (wanted === 1) {
    return {
      allowed: false,
      reason: "no_seats_left",
      state,
      message:
        `All ${state.purchased} of your seats are in use. ` +
        `Add a seat, or suspend someone who has left — a suspended user keeps ` +
        `their history but frees their seat.`,
    };
  }

  return {
    allowed: false,
    reason: "would_exceed",
    state,
    message:
      `That would need ${shortfall} more seat${shortfall === 1 ? "" : "s"}. ` +
      `You have ${state.available} of ${state.purchased} free.`,
  };
}

/* ------------------------------------------------------------------ */
/* OVER-LIMIT HANDLING                                                 */
/* ------------------------------------------------------------------ */

/**
 * A workspace can end up OVER its seat limit without anyone doing
 * anything wrong:
 *
 *   • they downgrade from 15 seats to 5 while 11 people are active;
 *   • a plan's `includedSeats` is reduced in the catalogue;
 *   • a billing correction reduces `seatsPurchased`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT WE DO NOT DO: AUTOMATICALLY SUSPEND PEOPLE
 * ══════════════════════════════════════════════════════════════════════
 * Picking six of eleven employees to lock out — by join date, by role, by
 * anything — is a decision no algorithm should make on a customer's
 * behalf. Whichever six it chose would be wrong, they would find out by
 * being unable to log in, and the workspace owner would find out from
 * them.
 *
 * So an over-limit workspace keeps everyone working and is told plainly
 * that it is over, with the two ways out. Blocking applies only to
 * ADDING someone new, which is a deliberate act by an admin who can be
 * shown the reason at the moment they attempt it.
 */
export function describeOverage(state: SeatState): string | null {
  if (!state.isOverLimit) return null;

  const excess = state.used - state.purchased;
  return (
    `You have ${state.used} people using ${state.purchased} seats — ` +
    `${excess} over. Everyone keeps working. To resolve it, either add ` +
    `${excess} seat${excess === 1 ? "" : "s"} or suspend ${excess} ` +
    `${excess === 1 ? "person" : "people"} who no longer need access.`
  );
}

/** The warning shown before anyone is blocked. */
export function describeNearLimit(state: SeatState): string | null {
  if (!state.isNearLimit) return null;
  return (
    `${state.used} of your ${state.purchased} seats are in use. ` +
    `${state.available} left.`
  );
}
