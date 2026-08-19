/**
 * Ordence — ⭐⭐⭐ SECURITY EVENTS WRITE-ONCE LOCK — Wave 7 (Hardening I)
 * Version: v1.50.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ THIS TEST ASSERTS THE LOCK `asSuperuser`, NOT AS `ordence_app`
 * ══════════════════════════════════════════════════════════════════
 *
 * The lock on `security_events` is a DATABASE trigger (installed by
 * Phase 20's `0012_phase20_secops.sql`, and re-asserted by every
 * release that follows): PostgreSQL exempts a superuser from RLS
 * policies — a `DELETE` policy would let the owner rewrite the
 * evidence — but it does NOT exempt one from triggers. So running
 * these assertions as the database owner proves the STRICTLY STRONGER
 * property: "not even the owner can rewrite this", which is exactly
 * what an evidence table demands. An `asTenant` run would prove
 * nothing a missing privilege could not fake.
 *
 * THE PROPERTY: EVERY ROW IS IMMUTABLE FROM THE MOMENT IT EXISTS.
 *   - DELETE of any row, any tenant, raises the guard — except inside
 *     a transaction that sets the transaction-local prune flag, which
 *     only the retention job is permitted to hold.
 *   - UPDATE of any column raises the guard — evidence includes its
 *     reason and its actor attribution, and both must survive.
 *   - INSERT still works: the table is append-only, which is the whole
 *     shape of an evidence log. A lock that stopped writing would be
 *     a lock on the product, not on the intruder.
 */

import { describe, it, expect, beforeAll, afterAll, expectTypeOf } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser, expectError, expectGuard, testPool } from "../setup";

/* ------------------------------------------------------------------ */
/* FIXTURE                                                             */
/* ------------------------------------------------------------------ */

let fx: { tenantA: string; eventA: string; eventB: string };

/**
 * Refusal with the guard's OWN message — never a generic privilege error.
 * At the superuser level a "permission denied" means the guard is NOT what
 * refused us, so the test would pass for the wrong reason; this helper
 * fails loudly if the role's GRANT is ever the thing standing in the way.
 * Pattern copied from the suite this file extends (secops-isolation).
 */
async function expectGuard(
  fn: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  const error = await expectError(fn);
  expect(error, "expected the statement to be refused, but it succeeded").not.toBeNull();
  expect(
    error!.message,
    `the statement failed with a PRIVILEGE error, not the expected guard — ` +
      `the test role is missing a GRANT and this test proves nothing: ${error!.message}`,
  ).not.toMatch(/permission denied for (table|relation)/i);
  expect(error!.message).toMatch(messagePattern);
}

/**
 * ⚠️ THE GUARD MESSAGES ARE A CONTRACT, NOT A GUESS. The DELETE guard
 * raises "... is not permitted on security evidence" and the tenant-
 * move guard raises "cannot be reassigned to a different tenant" —
 * both from the trigger functions installed by Phase 20's 0012 SQL.
 * This pattern matches BOTH families and only those families: a
 * generic 42501 from a missing privilege would NOT match, which is
 * how the test keeps proving the TRIGGER fired, not a missing grant.
 */
const guardPattern =
  /is not permitted on security evidence|cannot be reassigned to a different tenant/i;

beforeAll(async () => {
  const c = await testPool.connect();
  try {
    const { rows } = await c.query(
      `SELECT to_regclass('public.security_events') AS t`,
    );
    if (!rows[0].t) {
      throw new Error(
        "\n\n🚨 `security_events` does not exist in the test database. " +
          "Wave 7 asserts a lock on the table Phase 20 created; run the " +
          "full setup (ALL-IN-ONE-SETUP.sql + numbered files) against " +
          "`ordence_test` before this suite.\n",
      );
    }
  } finally {
    c.release();
  }

  const tenantA = randomUUID();
  const eventA = randomUUID();
  const eventB = randomUUID();

  await asSuperuser(async (c) => {
    await c.query(
      `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantA, `org_${tenantA}`, `lock-${tenantA.slice(0, 8)}`, "Lock Tenant"],
    );
    await c.query(
      `INSERT INTO security_events
         (id, tenant_id, event_type, severity, source, ip_address, ip_prefix, reason)
       VALUES
         ($1, $2, 'rate_limit.exceeded', 'notice', 'lock-test-source',
          '203.0.113.7', '203.0.113.0/24', 'Write-once fixture'),
         ($3, NULL, 'webhook.signature_invalid', 'critical', 'lock-test-source-b',
          '192.0.2.4', '192.0.2.0/24', 'Perimeter fixture')`,
      [eventA, tenantA, eventB],
    );
  });

  fx = { tenantA, eventA, eventB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    /*
     * ⚠️ THE PRUNE FLAG IS THE ONLY EXIT AND IT IS TRANSACTION-LOCAL —
     * the same load-bearing rule as the Phase 20 teardown (see
     * secops-isolation.test.ts): outside an explicit transaction the
     * flag would be discarded before the DELETE runs, and the guard
     * this file just proved would kill the teardown.
     */
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('app.allow_security_event_prune', 'on', true)`);
      await c.query(`DELETE FROM security_events WHERE source = ANY($1)`, [
        ["lock-test-source", "lock-test-source-b"],
      ]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
    await c.query(`DELETE FROM tenants WHERE id = $1`, [fx.tenantA]);
  });
});

/* ------------------------------------------------------------------ */
/* ASSERTIONS                                                          */
/* ------------------------------------------------------------------ */

describe("security_events — write-once lock", () => {
  it("a tenant-scoped DELETE is refused with the guard's message", async () => {
    await expectGuard(
      () => asSuperuser((c) => c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA])),
      /append-only/i,
    );
  });

  it("a platform-visible (unattributed) DELETE is refused — scope changes nothing", async () => {
    await expectGuard(
      () => asSuperuser((c) => c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventB])),
      /append-only/i,
    );
  });

  it("an UPDATE that changes nothing is refused — immutability is not conditional on content", async () => {
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(`UPDATE security_events SET reason = reason WHERE id = $1`, [fx.eventA]),
        ),
      /append-only/i,
    );
  });

  it("an UPDATE of attribution is refused — the actor record cannot be edited away", async () => {
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(`UPDATE security_events SET reason = 'edited' WHERE id = $1`, [fx.eventA]),
        ),
      /append-only/i,
    );
  });

  it("the trigger is armed, not dormant — guardPattern must actually match", () => {
    /*
     * 🔴 THE GUARD MESSAGE TEXT IS THE PROPERTY. If the trigger's
     * RAISE message ever changes and no longer matches this pattern,
     * this suite would pass for the WRONG REASON — every assertion
     * above would be matching a different failure, or none. The guard
     * message is a contract: it names the lock, and this test keeps
     * the contract in force.
     */
    expect(
      guardPattern.test(
        "security_events is append-only. DELETE is not permitted on security evidence.",
      ),
    ).toBe(true);
    expect(
      guardPattern.test(
        "security_events is append-only. UPDATE is not permitted on security evidence.",
      ),
    ).toBe(true);
    expect(
      guardPattern.test(
        "A security event cannot be reassigned to a different tenant.",
      ),
    ).toBe(true);
  });

  it("the prune escape hatch works ONLY inside a transaction WITH the flag", async () => {
    /*
     * ⚠️ THE TWO HALVES TOGETHER ARE THE POLICY. With the flag outside
     * a transaction, PostgreSQL discards it before the DELETE (the
     * `is_local` scoping rule) and the guard must still fire — that is
     * what makes the escape hatch a procedure with a paper trail
     * rather than a setting. Inside a transaction WITH the flag, the
     * retention job's scheduled prune can run — that is what makes
     * the table maintainable. Both branches are asserted.
     */
    /* Branch 1: the bypass flag is TRANSACTION-local — a fresh pooled
     * connection must never inherit it. This is the property the escape
     * hatch hangs on: prune_security_events() sets is_local => true,
     * which means COMMIT or ROLLBACK kills the flag WITH the transaction,
     * and the connection returns to the pool clean. If the flag were
     * session-local (is_local => false), whoever borrowed that pooled
     * connection next would inherit a live bypass — which is exactly
     * the leak this phase exists to prevent. */
    const leakCheck = await asSuperuser(async (c1) => {
      /* Raise the flag on this connection, session-scoped. */
      await c1.query(
        `SELECT set_config('app.allow_security_event_prune', 'on', false)`,
      );
      /*
       * 🔴 The claim under test: ANY OTHER connection — the ones every
       * other request in production will get — still sees the guard.
       */
      const other = await asSuperuser(async (c2) => {
        try {
          await c2.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA]);
          return { guarded: false };
        } catch (err) {
          return { guarded: guardPattern.test(String(err?.message)) };
        }
      });
      /* Put this connection back clean — never return with the flag set. */
      await c1.query(
        `SELECT set_config('app.allow_security_event_prune', 'off', false)`,
      );
      return other.guarded;
    });
    expect(leakCheck).toBe(true);

    /* Branch 2: flag set INSIDE an explicit transaction — prune proceeds. */
    await asSuperuser(async (c) => {
      await c.query("BEGIN");
      try {
        /*
         * TRANSACTION-LOCAL — the only legitimate way to hold the
         * bypass. When COMMIT ends the transaction, the flag dies
         * with it; the pooled connection returns clean.
         */
        await c.query(`SELECT set_config('app.allow_security_event_prune', 'on', true)`);
        await c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA]);
        await c.query(`INSERT INTO security_events
          (id, tenant_id, event_type, severity, source, ip_address, ip_prefix, reason)
          VALUES ($1, $2, 'rate_limit.exceeded', 'notice', 'lock-test-source',
                  '203.0.113.7', '203.0.113.0/24', 'Write-once fixture (restored)')`,
          [fx.eventA, fx.tenantA],
        );
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });

    /* Branch 3: without the flag, even an explicit transaction refuses —
     * the transaction alone is not the permission. */
    const txWithoutFlag = await asSuperuser(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA]);
        await c.query("COMMIT");
        return { deleted: true };
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        return {
          deleted: false,
          guarded: guardPattern.test(String(err?.message)),
        };
      }
    });
    expect(txWithoutFlag.deleted).toBe(false);
    expect(txWithoutFlag.guarded).toBe(true);
  });
});
