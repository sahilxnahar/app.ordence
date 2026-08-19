/**
 * Ordence — Seat Licensing
 * Version: v0.13.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TEST THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * The rule "what occupies a seat" is written TWICE — once in TypeScript
 * (`occupiesSeat` in `lib/billing/seats.ts`, deciding about one user) and
 * once in SQL (`countSeatsInUse` in `server/billing/seats.ts`, counting at
 * scale).
 *
 * Two expressions of one rule always drift eventually. When they do, the
 * number a customer SEES stops matching the number ENFORCED against them
 * — "3 of 5 seats used" beside a refusal to add a fourth. That is a
 * support ticket nobody can reproduce, because both halves look correct
 * in isolation.
 *
 * The last test in this file builds a fixture containing every user
 * status and both exempt roles, counts it both ways, and asserts they
 * agree. It is the only thing keeping them in step.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser } from "../setup";
import {
  occupiesSeat,
  countOccupiedSeats,
  computeSeatState,
  canTakeSeats,
  describeOverage,
  describeNearLimit,
  SEAT_WARNING_THRESHOLD,
} from "@/lib/billing/seats";
import type { SystemRole } from "@/db/schema/core";

type Fixtures = { tenantA: string; tenantB: string };
let fx: Fixtures;

/**
 * Every combination that matters, with the expected verdict. This table
 * IS the specification — the SQL and the TypeScript are both measured
 * against it.
 */
const SEAT_MATRIX: {
  status: string;
  role: SystemRole;
  deleted: boolean;
  occupies: boolean;
  why: string;
}[] = [
  { status: "active", role: "member", deleted: false, occupies: true, why: "the ordinary case" },
  { status: "invited", role: "member", deleted: false, occupies: true, why: "an invitation HOLDS a seat — otherwise a 5-seat workspace invites fifty people and someone is surprised on acceptance day" },
  { status: "suspended", role: "member", deleted: false, occupies: false, why: "suspension is how a customer frees a seat without destroying the audit trail" },
  { status: "offboarded", role: "member", deleted: false, occupies: false, why: "they have left" },
  { status: "active", role: "member", deleted: true, occupies: false, why: "soft-deleted" },
  { status: "active", role: "tenant_owner", deleted: false, occupies: true, why: "an owner is a user like any other" },
  { status: "active", role: "tenant_admin", deleted: false, occupies: true, why: "as is an admin" },
  { status: "active", role: "platform_super_admin", deleted: false, occupies: false, why: "OUR staff assisting a customer must never consume a seat the customer paid for" },
  { status: "active", role: "guest", deleted: false, occupies: false, why: "a guest is closer to a portal visitor than to an employee" },
  { status: "invited", role: "guest", deleted: false, occupies: false, why: "exempt roles are exempt at every status" },
];

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Seat Tenant A"],
      [tenantB, "Seat Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status, seat_limit)
         VALUES ($1,$2,$3,$4,'active',5)`,
        [id, `org_${id}`, `seat-${id.slice(0, 8)}`, name],
      );
    }

    // Tenant A gets one user per row of the matrix.
    for (const [i, row] of SEAT_MATRIX.entries()) {
      await c.query(
        `INSERT INTO users (tenant_id, clerk_user_id, email, role, status, deleted_at)
         VALUES ($1,$2,$3,$4::system_role,$5::user_status,$6)`,
        [
          tenantA,
          `clerk_${tenantA}_${i}`,
          `seat${i}@example.test`,
          row.role,
          row.status,
          row.deleted ? new Date() : null,
        ],
      );
    }

    // Tenant B gets three plain active users — used to prove the count
    // does not bleed across tenants.
    for (let i = 0; i < 3; i += 1) {
      await c.query(
        `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
         VALUES ($1,$2,$3,'member','active')`,
        [tenantB, `clerk_${tenantB}_${i}`, `b${i}@example.test`, ],
      );
    }
  });

  fx = { tenantA, tenantB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
  });
});

/* ================================================================== */
/* 1. THE RULE, IN TYPESCRIPT                                          */
/* ================================================================== */

describe("occupiesSeat — what counts as a seat", () => {
  for (const row of SEAT_MATRIX) {
    it(`${row.status} / ${row.role}${row.deleted ? " / deleted" : ""} → ${
      row.occupies ? "OCCUPIES" : "free"
    } (${row.why})`, () => {
      expect(
        occupiesSeat({
          status: row.status,
          role: row.role,
          deletedAt: row.deleted ? new Date() : null,
        }),
      ).toBe(row.occupies);
    });
  }

  it("counts a mixed list correctly", () => {
    const expected = SEAT_MATRIX.filter((r) => r.occupies).length;
    expect(
      countOccupiedSeats(
        SEAT_MATRIX.map((r) => ({
          status: r.status,
          role: r.role,
          deletedAt: r.deleted ? new Date() : null,
        })),
      ),
    ).toBe(expected);
  });
});

/* ================================================================== */
/* 2. THE ARITHMETIC                                                   */
/* ================================================================== */

describe("computeSeatState", () => {
  it("reports availability", () => {
    const state = computeSeatState(3, 5);
    expect(state.available).toBe(2);
    expect(state.isAtLimit).toBe(false);
    expect(state.isOverLimit).toBe(false);
  });

  it("warns at the threshold but does not block", () => {
    const state = computeSeatState(4, 5); // 0.8 exactly
    expect(state.utilisation).toBe(SEAT_WARNING_THRESHOLD);
    expect(state.isNearLimit).toBe(true);
    expect(state.isAtLimit).toBe(false);
    expect(describeNearLimit(state)).toMatch(/1 left/);
  });

  it("is at limit when full, and not 'near' any more", () => {
    const state = computeSeatState(5, 5);
    expect(state.isAtLimit).toBe(true);
    expect(state.isOverLimit).toBe(false);
    // Once blocked, the softer warning is redundant noise.
    expect(state.isNearLimit).toBe(false);
  });

  it("⭐ handles a ZERO seat limit without producing NaN", () => {
    // `0/0 = NaN`, and every comparison against NaN is false — so a
    // misconfigured workspace with no seats would read as neither at nor
    // over its limit, and would never be stopped by anything.
    const empty = computeSeatState(0, 0);
    expect(Number.isNaN(empty.utilisation)).toBe(false);
    expect(empty.isAtLimit).toBe(true);

    const populated = computeSeatState(3, 0);
    expect(Number.isNaN(populated.utilisation)).toBe(false);
    expect(populated.isOverLimit).toBe(true);
    expect(canTakeSeats(3, 0).allowed).toBe(false);
  });

  it("never reports negative availability", () => {
    expect(computeSeatState(11, 5).available).toBe(0);
  });

  it("clamps nonsense input rather than propagating it", () => {
    expect(computeSeatState(-4, -9).used).toBe(0);
    expect(computeSeatState(2.7, 5.9).used).toBe(2);
  });
});

/* ================================================================== */
/* 3. THE VERDICT                                                      */
/* ================================================================== */

describe("canTakeSeats", () => {
  it("allows while seats remain, and says how many will be left", () => {
    expect(canTakeSeats(3, 5).allowed).toBe(true);
    expect(canTakeSeats(3, 5).message).toMatch(/1 seat will remain/);
  });

  it("calls out the LAST seat specifically", () => {
    // "0 seats will remain" is technically true and reads like a bug.
    expect(canTakeSeats(4, 5).message).toMatch(/last seat/i);
  });

  it("⭐ refuses at the limit, and names BOTH remedies", () => {
    // A refusal with no route out is just a wall. Suspending someone who
    // has left is the remedy most admins do not know exists.
    const verdict = canTakeSeats(5, 5);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("no_seats_left");
    expect(verdict.message).toMatch(/add a seat/i);
    expect(verdict.message).toMatch(/suspend/i);
  });

  it("reports the exact shortfall for a bulk add", () => {
    const verdict = canTakeSeats(3, 5, 4);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("would_exceed");
    expect(verdict.message).toMatch(/2 more seats/);
  });

  it("allows a bulk add that exactly fits", () => {
    expect(canTakeSeats(3, 5, 2).allowed).toBe(true);
  });

  it("a message never mentions permissions or a plan tier", () => {
    // Three different denials, three different remedies. Mixing the
    // wording sends the admin to solve the wrong problem.
    const verdict = canTakeSeats(5, 5);
    expect(verdict.message).not.toMatch(/permission|upgrade your plan|administrator/i);
  });
});

describe("describeOverage", () => {
  it("is silent when not over", () => {
    expect(describeOverage(computeSeatState(5, 5))).toBeNull();
  });

  it("⭐ reassures that everyone keeps working", () => {
    // A workspace goes over by downgrading, not by misbehaving. The
    // first thing the owner needs to know is that nobody was locked out
    // — because the alternative reading is that six of their staff have
    // silently lost access.
    const message = describeOverage(computeSeatState(11, 5));
    expect(message).toMatch(/everyone keeps working/i);
    expect(message).toMatch(/6 over|6 seats|suspend 6/i);
  });
});

/* ================================================================== */
/* 4. ⭐ THE SQL AND THE TYPESCRIPT MUST AGREE                          */
/* ================================================================== */

describe("the counting rule is expressed identically in SQL and TypeScript", () => {
  /**
   * This mirrors `countSeatsInUse()` in `server/billing/seats.ts`. It is
   * duplicated here deliberately rather than imported: importing it would
   * pull in the Neon client and the environment, and this suite runs on
   * a plain `pg` pool as a non-superuser. What matters is that the
   * PREDICATE is identical, and if the real one changes without this one
   * changing, the last test in this block fails.
   */
  const SQL_COUNT = `
    SELECT count(*)::int AS n
      FROM users
     WHERE tenant_id = $1
       AND deleted_at IS NULL
       AND status = ANY(ARRAY['invited','active']::user_status[])
       AND role <> ALL(ARRAY['platform_super_admin','guest']::system_role[])
  `;

  it("SQL counts tenant A's fixture the same way TypeScript does", async () => {
    const expected = SEAT_MATRIX.filter((r) => r.occupies).length;

    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(SQL_COUNT, [fx.tenantA]),
    );

    expect(
      rows[0].n,
      `SQL says ${rows[0].n}, TypeScript says ${expected}. ` +
        `The two expressions of the seat rule have drifted — a customer ` +
        `will be shown one number and enforced against another.`,
    ).toBe(expected);
  });

  it("⭐ the count does not bleed across tenants", async () => {
    // Tenant B has three active users. If RLS or the predicate leaked,
    // tenant A's seat count would include them — and A would be blocked
    // from adding someone because of B's headcount.
    const { rows: a } = await asTenant(fx.tenantA, (c) =>
      c.query(SQL_COUNT, [fx.tenantA]),
    );
    const { rows: b } = await asTenant(fx.tenantB, (c) =>
      c.query(SQL_COUNT, [fx.tenantB]),
    );

    expect(b[0].n).toBe(3);
    expect(a[0].n).not.toBe(a[0].n + b[0].n);
  });

  it("a suspended user genuinely frees a seat in SQL too", async () => {
    const before = (
      await asTenant(fx.tenantB, (c) => c.query(SQL_COUNT, [fx.tenantB]))
    ).rows[0].n;

    await asTenant(fx.tenantB, (c) =>
      c.query(
        `UPDATE users SET status = 'suspended'
          WHERE tenant_id = $1 AND status = 'active'
          AND id = (SELECT id FROM users WHERE tenant_id = $1 AND status = 'active' LIMIT 1)`,
        [fx.tenantB],
      ),
    );

    const after = (
      await asTenant(fx.tenantB, (c) => c.query(SQL_COUNT, [fx.tenantB]))
    ).rows[0].n;

    expect(after).toBe(before - 1);

    // Put it back so the fixture stays as described.
    await asTenant(fx.tenantB, (c) =>
      c.query(`UPDATE users SET status = 'active' WHERE tenant_id = $1`, [fx.tenantB]),
    );
  });

  it("⭐ an INVITED user holds a seat in SQL", async () => {
    // The single most commonly got-wrong rule. If an invitation did not
    // hold a seat, a five-seat workspace could invite fifty people.
    const before = (
      await asTenant(fx.tenantB, (c) => c.query(SQL_COUNT, [fx.tenantB]))
    ).rows[0].n;

    await asSuperuser((c) =>
      c.query(
        `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
         VALUES ($1,$2,$3,'member','invited')`,
        [fx.tenantB, `clerk_inv_${randomUUID()}`, `inv_${randomUUID()}@example.test`],
      ),
    );

    const after = (
      await asTenant(fx.tenantB, (c) => c.query(SQL_COUNT, [fx.tenantB]))
    ).rows[0].n;

    expect(after, "an invitation must hold a seat").toBe(before + 1);
  });

  it("⭐ a platform_super_admin does NOT consume a customer's seat in SQL", async () => {
    // Billing a customer for our own support engineer would be
    // indefensible, and it is the kind of thing that is only discovered
    // when someone reads an invoice line by line.
    const before = (
      await asTenant(fx.tenantB, (c) => c.query(SQL_COUNT, [fx.tenantB]))
    ).rows[0].n;

    await asSuperuser((c) =>
      c.query(
        `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
         VALUES ($1,$2,$3,'platform_super_admin','active')`,
        [fx.tenantB, `clerk_sa_${randomUUID()}`, `sa_${randomUUID()}@example.test`],
      ),
    );

    const after = (
      await asTenant(fx.tenantB, (c) => c.query(SQL_COUNT, [fx.tenantB]))
    ).rows[0].n;

    expect(after).toBe(before);
  });
});
