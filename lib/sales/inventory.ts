/**
 * Ordence — Inventory & Hold Rules
 * Version: v0.22.0-alpha
 *
 * Pure and isomorphic. Mirrors the guarantees enforced in
 * `SQL-FILES/0016_phase22_sales.sql`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS FILE DOES NOT ENFORCE ANYTHING. THE DATABASE DOES.
 * ══════════════════════════════════════════════════════════════════════
 * Worth being blunt about, because a file full of `canBook()` functions
 * reads like a security boundary and is not one. Every rule here is
 * *also* a constraint or a trigger in the SQL file, and the SQL is what
 * actually holds when two reps click at the same moment.
 *
 * What this file is for is the OTHER half of the problem: telling a
 * person why, before they act, in language that helps. A 23505 surfaced
 * to a sales executive on a launch weekend is an outage as far as they
 * are concerned.
 *
 * So: the database refuses, this explains. If the two ever disagree, the
 * database is right and this is the bug.
 */

import type { UnitStatus } from "@/db/schema/sales";

export const UNIT_STATUS_LABELS: Readonly<Record<UnitStatus, string>> = Object.freeze({
  available: "Available",
  held: "Held",
  booked: "Booked",
  sold: "Sold",
  blocked: "Blocked",
});

/**
 * ⚠️ `held` and `blocked` look similar on a board and behave nothing
 * alike. Held releases itself; blocked does not and no rep can override
 * it. Conflating them is how a unit management has withdrawn from sale
 * gets sold anyway.
 */
export const UNIT_STATUS_DESCRIPTIONS: Readonly<Record<UnitStatus, string>> =
  Object.freeze({
    available: "On the market and free to book.",
    held: "Reserved for a named buyer until a deadline. Releases automatically.",
    booked: "A live booking exists against it.",
    sold: "Registered. The sale is complete.",
    blocked: "Withdrawn from sale by management. Does not release on its own.",
  });

/** Statuses that mean the unit is not sellable to a new buyer. */
export const UNSELLABLE_STATUSES = Object.freeze<UnitStatus[]>([
  "booked",
  "sold",
  "blocked",
]);

/* ------------------------------------------------------------------ */
/* HOLD POLICY                                                         */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY HOLDS HAVE A CEILING
 * ══════════════════════════════════════════════════════════════════════
 * A hold takes a flat off the market. Without a maximum, the rational
 * move for any rep is to hold everything they might need, and inventory
 * quietly disappears — the board shows 40% held on a project with no
 * bookings, and nobody can say who did it or why.
 *
 * Seven days is the default because it covers a weekend plus the working
 * week it takes to get a cheque. Thirty is the ceiling because beyond a
 * month it is not a hold, it is an unrecorded booking.
 *
 * ⚠️ Both are DEFAULTS, not laws. The user asked for a highly
 * customisable product, and hold policy is exactly the sort of thing one
 * developer runs at 3 days and another at 21. `resolveHoldPolicy()`
 * takes tenant settings and falls back to these.
 */
export const DEFAULT_HOLD_POLICY = Object.freeze({
  defaultDays: 7,
  maxDays: 30,
  /** Whether a token amount must be recorded to place a hold. */
  requireToken: false,
});

export type HoldPolicy = {
  defaultDays: number;
  maxDays: number;
  requireToken: boolean;
};

export function resolveHoldPolicy(settings?: Partial<HoldPolicy> | null): HoldPolicy {
  const merged: HoldPolicy = {
    defaultDays: settings?.defaultDays ?? DEFAULT_HOLD_POLICY.defaultDays,
    maxDays: settings?.maxDays ?? DEFAULT_HOLD_POLICY.maxDays,
    requireToken: settings?.requireToken ?? DEFAULT_HOLD_POLICY.requireToken,
  };

  // ⚠️ Clamp rather than trust. These values arrive from a settings form,
  // and a tenant admin who types 3650 should get a year-capped policy,
  // not a decade of frozen inventory.
  merged.maxDays = clampInt(merged.maxDays, 1, 365);
  merged.defaultDays = clampInt(merged.defaultDays, 1, merged.maxDays);
  return Object.freeze(merged);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function holdExpiryFor(from: Date, days: number, policy: HoldPolicy): Date {
  const capped = clampInt(days, 1, policy.maxDays);
  return new Date(from.getTime() + capped * 86_400_000);
}

/* ------------------------------------------------------------------ */
/* DECISIONS                                                           */
/* ------------------------------------------------------------------ */

export type InventoryVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; remedy: string };

const OK: InventoryVerdict = Object.freeze({ allowed: true });

export type UnitSnapshot = {
  code: string;
  status: UnitStatus;
  deletedAt?: Date | null;
  holdUntil?: Date | null;
  heldForLeadId?: string | null;
};

/**
 * May this unit be held for this lead, right now?
 *
 * Mirrors the trigger `units_hold_valid`.
 */
export function canHold(
  unit: UnitSnapshot,
  forLeadId: string,
  now: Date,
): InventoryVerdict {
  if (unit.deletedAt) {
    return {
      allowed: false,
      reason: `Unit ${unit.code} has been deleted.`,
      remedy: "Restore it from the recycle bin first.",
    };
  }

  if (unit.status === "blocked") {
    return {
      allowed: false,
      reason: `Unit ${unit.code} has been withdrawn from sale by management.`,
      remedy:
        "Ask whoever blocked it to release it. A block is not a hold and does " +
        "not expire.",
    };
  }

  if (unit.status === "sold") {
    return {
      allowed: false,
      reason: `Unit ${unit.code} is already sold.`,
      remedy: "Pick another unit, or check whether the sale was cancelled.",
    };
  }

  if (unit.status === "booked") {
    return {
      allowed: false,
      reason: `Unit ${unit.code} already has a live booking.`,
      remedy: "Cancel that booking first if the buyer has withdrawn.",
    };
  }

  if (unit.status === "held" && isHoldLive(unit, now)) {
    if (unit.heldForLeadId === forLeadId) {
      // Re-holding for the same buyer is an extension, which is fine.
      return OK;
    }
    return {
      allowed: false,
      reason: `Unit ${unit.code} is held for another buyer until ${formatDeadline(unit.holdUntil)}.`,
      remedy:
        "Release the existing hold if that buyer has moved on, or wait for it " +
        "to expire — it releases itself.",
    };
  }

  return OK;
}

/**
 * May this unit be booked for this lead, right now?
 *
 * Mirrors the trigger `bookings_unit_bookable` and the partial unique
 * index `bookings_one_live_per_unit`.
 *
 * ⚠️ A TRUE ANSWER HERE IS NOT A GUARANTEE. Between this returning
 * `allowed` and the INSERT committing, another transaction can book the
 * same unit. That gap cannot be closed in application code — see the
 * long note in Section 3 of the SQL file — so the caller must still
 * handle a 23505 and translate it with `describeBookingCollision()`.
 */
export function canBook(
  unit: UnitSnapshot,
  forLeadId: string | null,
  now: Date,
): InventoryVerdict {
  if (unit.deletedAt) {
    return {
      allowed: false,
      reason: `Unit ${unit.code} has been deleted.`,
      remedy: "Restore it from the recycle bin first.",
    };
  }

  if (unit.status === "blocked") {
    return {
      allowed: false,
      reason: `Unit ${unit.code} is blocked and is not available for sale.`,
      remedy: "Management withdrew it from the market. It must be unblocked first.",
    };
  }

  if (unit.status === "sold") {
    return {
      allowed: false,
      reason: `Unit ${unit.code} is already sold.`,
      remedy: "Choose a different unit.",
    };
  }

  if (unit.status === "booked") {
    return {
      allowed: false,
      reason: `Unit ${unit.code} already has a live booking.`,
      remedy:
        "Cancel the existing booking, with a reason, before booking it for " +
        "someone else.",
    };
  }

  if (
    unit.status === "held" &&
    isHoldLive(unit, now) &&
    unit.heldForLeadId !== forLeadId
  ) {
    return {
      allowed: false,
      reason: `Unit ${unit.code} is held for another buyer until ${formatDeadline(unit.holdUntil)}.`,
      remedy: "Release the hold first, or wait for it to expire.",
    };
  }

  return OK;
}

export function isHoldLive(unit: UnitSnapshot, now: Date): boolean {
  if (unit.status !== "held") return false;
  if (!unit.holdUntil) return false;
  return unit.holdUntil.getTime() > now.getTime();
}

/** Whole hours left on a hold. Negative once it has lapsed. */
export function holdHoursRemaining(unit: UnitSnapshot, now: Date): number | null {
  if (!unit.holdUntil) return null;
  return Math.floor((unit.holdUntil.getTime() - now.getTime()) / 3_600_000);
}

function formatDeadline(at: Date | null | undefined): string {
  if (!at) return "an unspecified time";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(at);
}

/* ------------------------------------------------------------------ */
/* COLLISION TRANSLATION                                               */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE MOST USER-FACING FUNCTION IN THE PHASE.
 *
 * When two reps book one flat within the same second, the loser's
 * transaction fails with SQLSTATE 23505 on `bookings_one_live_per_unit`.
 * That is the system working exactly as designed — and to the person who
 * clicked, it is a red toast saying "duplicate key value violates unique
 * constraint".
 *
 * They will conclude the software is broken, and they will try again.
 */
export const BOOKING_COLLISION_SQLSTATE = "23505";
export const BOOKING_COLLISION_CONSTRAINT = "bookings_one_live_per_unit";

export function isBookingCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code !== BOOKING_COLLISION_SQLSTATE) return false;
  if (candidate.constraint === BOOKING_COLLISION_CONSTRAINT) return true;
  // Some drivers surface the constraint name only inside the message.
  return (
    typeof candidate.message === "string" &&
    candidate.message.includes(BOOKING_COLLISION_CONSTRAINT)
  );
}

export function describeBookingCollision(unitCode?: string | null): string {
  const which = unitCode ? `Unit ${unitCode}` : "That unit";
  return (
    `${which} was booked by someone else moments ago. Nothing has been saved, ` +
    `and no double booking was created — the system refused it deliberately. ` +
    `Refresh the inventory and pick another unit, or speak to the colleague ` +
    `who booked it.`
  );
}

/* ------------------------------------------------------------------ */
/* AVAILABILITY SUMMARY                                                */
/* ------------------------------------------------------------------ */

export type AvailabilitySummary = {
  total: number;
  available: number;
  held: number;
  booked: number;
  sold: number;
  blocked: number;
  /** Sold + booked as a proportion of everything not blocked. */
  absorptionPct: number;
};

/**
 * ⚠️ Absorption EXCLUDES blocked units from the denominator.
 *
 * A developer who has withheld 30 flats for promoters has not failed to
 * sell them — they were never on the market. Counting them as unsold
 * makes every project look like it is performing worse than it is, and
 * that number goes to a board.
 */
export function summariseAvailability(
  units: readonly { status: UnitStatus }[],
): AvailabilitySummary {
  const counts = { available: 0, held: 0, booked: 0, sold: 0, blocked: 0 };
  for (const unit of units) {
    counts[unit.status] += 1;
  }

  const marketable = units.length - counts.blocked;
  const absorbed = counts.booked + counts.sold;

  return {
    total: units.length,
    ...counts,
    absorptionPct:
      marketable === 0 ? 0 : Math.round((absorbed / marketable) * 1000) / 10,
  };
}
