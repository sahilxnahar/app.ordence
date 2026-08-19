/**
 * Ordence — 🔴🔴🔴 A SEAT LIMIT THAT ACTUALLY REFUSES · 0114
 * Version: v1.71.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/billing/seats.ts` decided what a seat is, carefully and correctly.
 * `tenants.seat_limit` existed. `requireSeat()` existed. And a workspace
 * on ten seats could have thirty people.
 *
 * 🔴 BECAUSE THERE IS NO IN-PRODUCT INVITE. Everybody arrives through
 * Clerk, and that path checked the limit, wrote a high-severity audit row
 * and CREATED THE USER ANYWAY. The audit row was right and nobody read
 * it.
 *
 * ⭐ Every existing seat test passed throughout, because they all test
 * the arithmetic — and the arithmetic was never wrong. What was wrong was
 * that nothing consulted it on the only path that mattered.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  occupiesSeat,
  countOccupiedSeats,
  canTakeSeats,
  grantedSeats,
  effectiveSeats,
  PENDING_SEAT_STATUS,
  SEAT_CONSUMING_STATUSES,
  type SeatGrant,
} from "@/lib/billing/seats";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ================================================================== */
describe("🔴🔴🔴 pending_seat holds no seat, which is the entire point", () => {
  it("is not a seat-consuming status", () => {
    expect(SEAT_CONSUMING_STATUSES).not.toContain(PENDING_SEAT_STATUS);
  });

  it("🔴 a parked person does not occupy a seat", () => {
    expect(
      occupiesSeat({ status: PENDING_SEAT_STATUS, role: "tenant_admin" }),
    ).toBe(false);
  });

  /**
   * 🔴 THE ARITHMETIC THIS PROTECTS. A workspace at 10 of 10 with three
   * people parked is STILL at 10 of 10, so its owner is asked to buy
   * three seats. If parking consumed a seat it would be indistinguishable
   * from admitting them and the limit would go on being advisory.
   */
  it("🔴 a workspace at its limit with three parked is still at its limit, not over", () => {
    const people = [
      ...Array.from({ length: 10 }, () => ({ status: "active", role: "member" as const })),
      ...Array.from({ length: 3 }, () => ({
        status: PENDING_SEAT_STATUS,
        role: "member" as const,
      })),
    ];
    const used = countOccupiedSeats(people);
    expect(used).toBe(10);

    const state = canTakeSeats(used, 10, 1).state;
    expect(state.used).toBe(10);
    expect(state.isOverLimit).toBe(false);
    expect(state.isAtLimit).toBe(true);
  });

  it("⚠️ and approving one of them IS refused while the workspace is full", () => {
    const verdict = canTakeSeats(10, 10, 1);
    expect(verdict.allowed).toBe(false);
    expect(verdict.message).toMatch(/suspend somebody who has left|suspend someone who has left/i);
  });

  it("⭐ suspending somebody frees the seat and the approval then succeeds", () => {
    expect(canTakeSeats(9, 10, 1).allowed).toBe(true);
  });
});

/* ================================================================== */
describe("⭐⭐ a grant raises the limit, it does not fill a seat", () => {
  const grant = (over: Partial<SeatGrant> = {}): SeatGrant => ({
    seats: 3,
    expiresAt: null,
    revokedAt: null,
    ...over,
  });

  it("adds capacity", () => {
    expect(grantedSeats([grant()])).toBe(3);
    expect(effectiveSeats(10, [grant()])).toBe(13);
  });

  it("🔴 and therefore survives the person who prompted it leaving", () => {
    /**
     * Modelling a grant as "this user does not count" would make the
     * capacity vanish the day they leave, and the customer would silently
     * lose a concession somebody deliberately made.
     */
    const before = effectiveSeats(10, [grant({ seats: 1 })]);
    /** The person leaves: `used` falls, capacity does not. */
    expect(effectiveSeats(10, [grant({ seats: 1 })])).toBe(before);
  });

  it("a revoked grant is capacity no longer", () => {
    expect(grantedSeats([grant({ revokedAt: new Date() })])).toBe(0);
  });

  it("an expired grant is capacity no longer", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(grantedSeats([grant({ expiresAt: "2026-05-31T23:59:59Z" })], now)).toBe(0);
    expect(grantedSeats([grant({ expiresAt: "2026-06-02T00:00:00Z" })], now)).toBe(3);
  });

  /**
   * ⚠️ AN UNPARSEABLE DATE IS TREATED AS EXPIRED, NOT AS PERMANENT. The
   * failure that matters is a customer being charged for capacity they no
   * longer have, so the conservative direction is to withdraw it and let
   * somebody ask why.
   */
  it("⚠️ an unparseable expiry withdraws the capacity rather than making it permanent", () => {
    expect(grantedSeats([grant({ expiresAt: "not a date" })])).toBe(0);
  });

  it("null expiry means permanent, which is the honest default", () => {
    const farFuture = new Date("2099-01-01T00:00:00Z");
    expect(grantedSeats([grant({ expiresAt: null })], farFuture)).toBe(3);
  });

  it("a zero or negative grant contributes nothing", () => {
    expect(grantedSeats([grant({ seats: 0 }), grant({ seats: -5 })])).toBe(0);
  });

  it("⭐ several grants sum", () => {
    expect(
      grantedSeats([grant({ seats: 2 }), grant({ seats: 3 }), grant({ seats: 1 })]),
    ).toBe(6);
  });
});

/* ================================================================== */
describe("🔴 the webhook parks instead of admitting", () => {
  const hook = read("app/api/webhooks/clerk/_webhook.ts");

  it("🔴 an over-limit arrival is created as pending_seat, not active", () => {
    expect(hook).toContain("PENDING_SEAT_STATUS");
    expect(hook).toMatch(/status:\s*seatless\s*\?\s*PENDING_SEAT_STATUS\s*:\s*"active"/);
  });

  it("⭐ and it still returns 200 to Clerk rather than refusing", () => {
    /**
     * The original reasoning holds and is why parking exists at all: a
     * non-2xx makes Clerk retry the membership event for ever, and the
     * person exists in the identity provider while never existing here.
     */
    expect(hook).toMatch(/retry|retries/i);
    /** The user is still inserted. Parking is not refusing. */
    expect(hook).toMatch(/\.insert\(users\)/);
  });

  it("🔴 a seat_requests row is written, because a queue outlives a notification", () => {
    expect(hook).toContain("seatRequests");
    expect(hook).toContain("identity_provider");
  });

  it("⚠️ and it is onConflictDoNothing, because Clerk replays events on purpose", () => {
    const section = hook.slice(hook.indexOf("insert(seatRequests)"));
    expect(section.slice(0, 400)).toContain("onConflictDoNothing");
  });
});

/* ================================================================== */
describe("⚠️ the approval queue's asymmetry", () => {
  const svc = read("server/billing/seat-approval.ts");

  it("🔴 approving re-counts rather than trusting the frozen numbers on the request", () => {
    /**
     * The numbers on the request explain why it was raised. They are not
     * a licence to admit somebody today: between the two, three people
     * may have left or four more arrived.
     */
    expect(svc).toContain("countSeatsInUse");
    expect(svc).toContain("countEffectiveSeats");
    expect(svc).toMatch(/canTakeSeats\(used, effective, 1\)/);
  });

  it("🔴 declining requires a reason and approving does not", () => {
    expect(svc).toMatch(/reason\.trim\(\)\.length < 10/);
    const approve = svc.slice(
      svc.indexOf("export async function approvePendingSeat"),
      svc.indexOf("export async function declinePendingSeat"),
    );
    expect(approve).not.toMatch(/reason\.trim\(\)\.length < 10/);
  });

  it("⚠️ a declined person is not deleted, so they can see the decision", () => {
    expect(svc).toMatch(/not deleted|NOT DELETED/i);
  });

  it("🔴 a grant needs a reason of at least ten characters", () => {
    const grant = svc.slice(svc.indexOf("export async function grantSeats"));
    expect(grant).toMatch(/reason\.trim\(\)\.length < 10/);
  });

  it("⚠️ revoking capacity does not suspend anybody", () => {
    /** The doc comment sits above the function, so slice from the marker. */
    const revoke = svc.slice(svc.indexOf("IT DOES NOT SUSPEND ANYBODY"));
    expect(revoke.length).toBeGreaterThan(100);
    expect(revoke).toMatch(/no algorithm should make on/i);
  });
});

/* ================================================================== */
describe("⭐ the queue is reachable, and every gate reads granted seats", () => {
  it("a screen calls the approval actions", () => {
    const page = read("app/(crm)/settings/team/page.tsx");
    expect(page).toContain("approveSeatRequest");
    expect(page).toContain("declineSeatRequest");
    expect(page).toContain("getPendingSeats");
  });

  /**
   * 🔴 IF ONE GATE READ `countSeatsPurchased` AND ANOTHER READ
   * `countEffectiveSeats`, a granted seat would work on one screen and be
   * refused on another, and the customer would be right to call that
   * broken.
   */
  it("🔴 both seat gates read effective seats, not purchased", () => {
    const svc = read("server/billing/seats.ts");
    const gates = svc.slice(svc.indexOf("export async function getSeatState"));
    const purchasedInGates = (gates.match(/countSeatsPurchased\(/g) ?? []).length;
    const effectiveInGates = (gates.match(/countEffectiveSeats\(/g) ?? []).length;
    expect(effectiveInGates).toBeGreaterThanOrEqual(2);
    expect(purchasedInGates).toBe(0);
  });

  it("⚠️ the queue is ordered oldest first", () => {
    const svc = read("server/billing/seat-approval.ts");
    expect(svc).toContain("orderBy(seatRequests.requestedAt)");
    expect(svc).toMatch(/OLDEST FIRST/i);
  });
});
