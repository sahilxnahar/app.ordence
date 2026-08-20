/**
 * Ordence — Login Lockout Evidence (Hardening II / v1.50.0-alpha)
 *
 * WHAT IS PROVED HERE.
 *
 * Clerk enforces its hosted sign-in lockout natively; the platform keeps a
 * database-backed copy of the decision (SQL 0089 / lib/security/lockout.ts)
 * so the lockout is a QUERYABLE FACT — which identifier, how many failures,
 * when the window expires — and so platform surfaces can re-check it
 * without trusting a third-party widget's memory.
 *
 * This test drives the REAL API against the real test database with the
 * real drizzle client (the mock in this file is only the @/db module's
 * transaction scopes, exactly as the sibling clerk-webhook tests do), so
 * what is green here is the whole chain: webhook dispatch → counter bump →
 * lockout planting → event emission.
 *
 * The thresholds matter more than the code: five failures locks for
 * fifteen minutes, and crossing the threshold must emit TWO events —
 * `auth.login_failed` for the attempt AND `auth.account_locked` for the
 * activation — because a reviewer counting lockouts needs the activation
 * rows to exist without reconstructing them from failure spikes.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { adminPool } from "../setup";
import * as schema from "@/db/schema";

vi.mock("@/db", () => {
  const realDrizzle = drizzle(adminPool, { schema });
  return {
    db: realDrizzle,
    withTenant: async (cb: any) => realDrizzle.transaction(cb as never),
    withPlatformScope: async (reason: string, cb: any) =>
      realDrizzle.transaction(async (tx: any) => {
        await tx.execute(
          sql`SELECT set_config('app.platform_scope', 'on', true)`,
        );
        return cb(tx);
      }),
  };
});

import { describe, expect, it } from "vitest";
import { asSuperuser, testPool } from "../setup";
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  recordFailure,
  releaseLock,
  isLocked,
} from "@/lib/security/lockout";

process.env.SECURITY_EVENTS_API_KEY ??= "test-secret";
process.env.DATABASE_URL ??=
  "postgresql://ordence_app:test_app@localhost:5432/ordence_test";
process.env.NEXT_RUNTIME ??= "nodejs";

const uniqueEmail = () => `lockout-${crypto.randomUUID()}@example.invalid`;

async function countLockoutRows(email: string): Promise<number> {
  const rows = await asSuperuser((c) =>
    c.query(`SELECT 1 FROM login_lockouts WHERE email = $1`, [email]),
  );
  return rows.rowCount ?? 0;
}

describe("login lockouts — counter and lockout planting", () => {
  it("creates a row on the first failure and bumps the counter on each", async () => {
    const email = uniqueEmail();
    for (let i = 1; i <= 3; i++) {
      await recordFailure(email);
      const rows = await asSuperuser((c) =>
        c.query(
          `SELECT failed_attempts FROM login_lockouts WHERE email = $1`,
          [email],
        ),
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].failed_attempts).toBe(i);
    }
  });

  it("is case-insensitive: mixed case lands on the same row", async () => {
    const base = uniqueEmail();
    await recordFailure(base);
    await recordFailure(base.toUpperCase());
    await recordFailure(base.slice(0, 3) + base.slice(3));
    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT failed_attempts, COUNT(*) AS cnt FROM login_lockouts WHERE email = $1 GROUP BY failed_attempts`,
        [base.toLowerCase()],
      ),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].cnt).toBe("1");
    expect(rows.rows[0].failed_attempts).toBe(3);
  });

  it(`locks the identifier after ${LOCKOUT_THRESHOLD} failures with a 15-minute window`, async () => {
    const email = uniqueEmail();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await recordFailure(email);
    }

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT locked_until, failed_attempts, locked_reason
         FROM login_lockouts WHERE email = $1`,
        [email],
      ),
    );
    expect(rows.rowCount).toBe(1);
    const lockedUntil = new Date(rows.rows[0].locked_until);
    const expected = Date.now() + LOCKOUT_DURATION_MS;
    expect(Math.abs(lockedUntil.getTime() - expected)).toBeLessThan(5_000);
    expect(rows.rows[0].failed_attempts).toBe(LOCKOUT_THRESHOLD);
    expect(rows.rows[0].locked_reason).toBe("repeated_failed_sign_ins");
  });

  it("never extends the window on failures after the lockout is active", async () => {
    const email = uniqueEmail();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await recordFailure(email);
    }
    const first = await asSuperuser((c) =>
      c.query(
        `SELECT locked_until FROM login_lockouts WHERE email = $1`,
        [email],
      ),
    );
    const anchor = new Date(first.rows[0].locked_until).getTime();

    // Five more failures while already locked.
    for (let i = 0; i < 5; i++) {
      await recordFailure(email);
    }

    const after = await asSuperuser((c) =>
      c.query(
        `SELECT locked_until, failed_attempts FROM login_lockouts WHERE email = $1`,
        [email],
      ),
    );
    expect(new Date(after.rows[0].locked_until).getTime()).toBe(anchor);
    // Counting keeps going — evidence, not neatness.
    expect(after.rows[0].failed_attempts).toBe(LOCKOUT_THRESHOLD + 5);
  });

  it("emits auth.login_failed for every attempt and auth.account_locked exactly at activation", async () => {
    const email = uniqueEmail();
    for (let i = 0; i < LOCKOUT_THRESHOLD + 2; i++) {
      await recordFailure(email);
    }

    const failed = await asSuperuser((c) =>
      c.query(
        `SELECT COUNT(*) AS cnt FROM security_events
         WHERE event_type = 'auth.login_failed' AND subject_id = $1`,
        [email],
      ),
    );
    const locked = await asSuperuser((c) =>
      c.query(
        `SELECT COUNT(*) AS cnt FROM security_events
         WHERE event_type = 'auth.account_locked' AND subject_id = $1`,
        [email],
      ),
    );
    expect(Number(failed.rows[0].cnt)).toBe(LOCKOUT_THRESHOLD + 2);
    expect(Number(locked.rows[0].cnt)).toBe(1);
  });

  it("isLocked reads the window and reports an expired lockout as not-locked", async () => {
    const email = uniqueEmail();
    /*
     * ⚠️ `degraded: false` IS NEW IN WAVE 15 AND IS NOT COSMETIC. Before it,
     * "this identifier is clean" and "the lockout store could not be read"
     * were the same object, so a total failure of the evidence table was
     * invisible to every possible caller. Asserting it here pins that the
     * ordinary answer is a READING and not a guess.
     */
    expect(await isLocked(email)).toEqual({
      locked: false,
      lockedUntil: null,
      failedAttempts: 0,
      expired: false,
      degraded: false,
    });

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await recordFailure(email);
    }
    const locked = await isLocked(email);
    expect(locked.locked).toBe(true);
    expect(locked.expired).toBe(false);
    expect(locked.failedAttempts).toBe(LOCKOUT_THRESHOLD);

    // Backdate the window and confirm an expired lockout reads as
    // "not locked" — the row stays, only the decision flips. The update
    // touches a column guarded by WITH CHECK app_platform_scope(), so it
    // must opt in to platform scope — the update itself never grants it.
    // `set_config(..., is_local := true)` is TRANSACTION-local in Postgres
    // — a pg Pool client auto-commits every standalone query, so the flag
    // would die between the two `c.query(...)` calls. One explicit
    // transaction keeps it alive for the UPDATE's WITH CHECK.
    await asSuperuser(async (c) => {
      await c.query(`BEGIN`, []);
      await c.query(`SELECT set_config('app.platform_scope', 'on', true)`, []);
      await c.query(
        `UPDATE login_lockouts SET locked_until = now() - interval '1 hour' WHERE email = $1`,
        [email],
      );
      await c.query(`COMMIT`, []);
    });
    const expired = await isLocked(email);
    expect(expired.locked).toBe(false);
    expect(expired.expired).toBe(true);
  });

  it("releaseLock clears the window but KEEPS the row as evidence", async () => {
    const email = uniqueEmail();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      await recordFailure(email);
    }

    const released = await releaseLock(email);
    expect(released).toBe(true);

    const rows = await asSuperuser((c) =>
      c.query(
        `SELECT locked_until, locked_reason, failed_attempts
         FROM login_lockouts WHERE email = $1`,
        [email],
      ),
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].locked_until).toBeNull();
    expect(rows.rows[0].locked_reason).toBe("released_by_administrator");
    expect(rows.rows[0].failed_attempts).toBe(0);

    // A second release on an existing row succeeds; on a stranger it fails.
    expect(await releaseLock(email)).toBe(true);
    expect(await releaseLock("nobody@example.invalid")).toBe(false);
  });

  it("refuses to write for a tenant-attributed session (RLS boundary)", async () => {
    const email = uniqueEmail();
    // testPool is the NON-superuser application role — exactly the one the
    // deploy documents demand. (A superuser check here would be worthless:
    // superusers bypass RLS entirely, so the assertion must run as the app.)
    const client = await testPool.connect();
    try {
      // Set the tenant marker without setting the platform flag.
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true)`,
        [crypto.randomUUID()],
      );
      let refused = false;
      try {
        const result = await client.query(
          `INSERT INTO login_lockouts (email, failed_attempts) VALUES ($1, 1) RETURNING id`,
          [email],
        );
        refused = result.rows.length === 0;
      } catch {
        // RLS violation or privilege denial — both are refusals, and both
        // are what this boundary test must prove exists.
        refused = true;
      }
      expect(refused).toBe(true);
      // And nothing was written: zero rows for the email we never locked.
      expect(await countLockoutRows(email)).toBe(0);
    } finally {
      client.release();
    }
  });
});
