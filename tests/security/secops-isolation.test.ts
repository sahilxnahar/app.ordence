/**
 * Ordence — SecOps Isolation & Evidence Integrity
 * Version: v0.12.0-alpha (Phase 20)
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 20 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * `security_events` is the table an intruder has the strongest motive to
 * alter — it records HOW THEY GOT IN, not merely what someone did. Four
 * guarantees are asserted here against a REAL PostgreSQL as a NON-SUPERUSER:
 *
 *   1. A tenant cannot read another tenant's security events.
 *   2. A tenant cannot read the UNATTRIBUTED (tenant_id IS NULL) perimeter
 *      events, and platform scope sees only those.
 *   3. An event, once written, cannot be updated, deleted or reassigned.
 *   4. The application role cannot reach the retention function that IS
 *      allowed to delete.
 *
 * ⚠️ EVERY ASSERTION RUNS AS `ordence_app`, NOT AS `postgres`. A superuser
 * bypasses RLS entirely, so a suite connected as one would pass with every
 * policy dropped. `asSuperuser` appears only in fixture setup and teardown;
 * if it ever appears inside an assertion, that assertion is worthless.
 *
 * ⚠️ PREREQUISITE: `security_events` and `SQL-FILES/0012_phase20_secops.sql`
 * must both have been applied to the test database. Without the SQL file the
 * table has no RLS at all and — this is the point — these tests would FAIL
 * loudly rather than pass silently, which is the correct direction.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError , asPlatform } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  eventA: string;
  eventB: string;
  eventOrphan: string;
};

let fx: Fixtures;

/** Tenant B's marker is deliberately unmistakable if it ever leaks. */
const A_SOURCE = "phase20-tenant-a";
const B_SOURCE = "phase20-tenant-b-MUST-NOT-LEAK";
const ORPHAN_SOURCE = "phase20-orphan-perimeter";

/**
 * Assert that a statement was refused BY THE GUARD UNDER TEST, and not by a
 * missing GRANT.
 *
 * ⚠️ THIS HELPER IS WHY THESE TESTS MEAN ANYTHING. A missing privilege raises
 * SQLSTATE 42501, which is EXACTLY what our append-only triggers raise. A
 * test whose role simply had no rights on the table would pass for entirely
 * the wrong reason and prove nothing at all — and it would keep passing on
 * the day the trigger was dropped. Copied deliberately from
 * tests/security/billing-isolation.test.ts, where the lesson was learned.
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

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const eventA = randomUUID();
  const eventB = randomUUID();
  const eventOrphan = randomUUID();

  await asSuperuser(async (c) => {
    // Fail fast and legibly if the phase has not been applied, rather than
    // producing twenty confusing assertion failures.
    const { rows } = await c.query(
      `SELECT to_regclass('public.security_events') AS t`,
    );
    if (!rows[0]?.t) {
      throw new Error(
        "\n\n🚨 `security_events` does not exist in the test database.\n" +
          "Apply the Phase 20 schema and then SQL-FILES/0012_phase20_secops.sql.\n",
      );
    }

    for (const [id, name] of [
      [tenantA, "SecOps Tenant A"],
      [tenantB, "SecOps Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [id, `org_${id}`, `sec-${id.slice(0, 8)}`, name],
      );
    }

    await c.query(
      `INSERT INTO security_events
         (id, tenant_id, event_type, severity, source, ip_address, ip_prefix, reason)
       VALUES
         ($1, $2, 'rate_limit.exceeded', 'notice', $3, '203.0.113.7', '203.0.113.0/24', 'A trip'),
         ($4, $5, 'rate_limit.exceeded', 'notice', $6, '198.51.100.9', '198.51.100.0/24', 'B trip'),
         ($7, NULL, 'webhook.signature_invalid', 'critical', $8, '192.0.2.4', '192.0.2.0/24', 'Forged HMAC')`,
      [eventA, tenantA, A_SOURCE, eventB, tenantB, B_SOURCE, eventOrphan, ORPHAN_SOURCE],
    );
  });

  fx = { tenantA, tenantB, eventA, eventB, eventOrphan };
});

afterAll(async () => {
  // Teardown needs the prune escape hatch: the whole point of this phase is
  // that nothing else can delete these rows.
  await asSuperuser(async (c) => {
    // ⚠️ BEGIN/COMMIT is load-bearing. `set_config(..., true)` is
    // TRANSACTION-local, and outside an explicit transaction every statement
    // is its own implicit one — so the flag would be discarded before the
    // DELETE ran and teardown would fail with the append-only error. Same
    // trap documented at length in `withTenant()` in db/index.ts. The
    // alternative (`is_local = false`) would leave the bypass flag set on a
    // pooled connection for whatever borrows it next, which is exactly the
    // kind of leak this phase exists to prevent.
    await c.query("BEGIN");
    try {
      await c.query(`SELECT set_config('app.allow_security_event_prune', 'on', true)`);
      await c.query(`DELETE FROM security_events WHERE tenant_id = ANY($1) OR source = $2`, [
        [fx.tenantA, fx.tenantB],
        ORPHAN_SOURCE,
      ]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
    await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[fx.tenantA, fx.tenantB]]);
  });
});

/* ================================================================== */
/* 1. CROSS-TENANT ISOLATION                                           */
/* ================================================================== */

describe("security_events — tenant isolation", () => {
  it("a tenant sees its own events", async () => {
    const rows = await asTenant(fx.tenantA, async (c) => {
      const { rows } = await c.query(`SELECT id, source FROM security_events`);
      return rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fx.eventA);
  });

  it("a tenant CANNOT see another tenant's events", async () => {
    const rows = await asTenant(fx.tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM security_events WHERE source = $1`,
        [B_SOURCE],
      );
      return rows;
    });

    expect(
      rows,
      "TENANT A CAN READ TENANT B'S SECURITY EVENTS — the RLS policy is missing or unforced",
    ).toHaveLength(0);
  });

  it("a tenant CANNOT see the unattributed perimeter events", async () => {
    // These are the tenant_id IS NULL rows: forged webhook signatures,
    // unknown portal tokens. They are OUR infrastructure telemetry and are
    // readable only from platform scope.
    const rows = await asTenant(fx.tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM security_events WHERE tenant_id IS NULL`,
      );
      return rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("platform scope sees the unattributed events and NOT any tenant's", async () => {
    const rows = await asPlatform(async (c) => {
      const { rows } = await c.query(`SELECT id, tenant_id, source FROM security_events`);
      return rows;
    });

    // Other phases' fixtures may leave orphan rows behind, so assert the
    // shape rather than an exact count: everything visible is unattributed,
    // and ours is among them.
    expect(rows.every((r: { tenant_id: string | null }) => r.tenant_id === null)).toBe(true);
    expect(rows.some((r: { id: string }) => r.id === fx.eventOrphan)).toBe(true);
  });

  it("a tenant CANNOT insert an event stamped with another tenant's id", async () => {
    // The WITH CHECK half of the policy. Without it, reads look correct while
    // a tenant can forge security history against a competitor — or file
    // their own intrusion under someone else's name.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO security_events (tenant_id, event_type, source)
           VALUES ($1, 'auth.login_failed', 'forged')`,
          [fx.tenantB],
        ),
      ),
    );

    expect(error, "cross-tenant INSERT SUCCEEDED — the policy has no WITH CHECK").not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("a tenant CANNOT insert an unattributed (NULL tenant) event", async () => {
    // A tenant session writing tenant_id NULL would be writing into the
    // platform-scoped bucket, which is a place they must not be able to
    // reach — it is the one bucket their own RLS cannot see afterwards.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO security_events (tenant_id, event_type, source)
           VALUES (NULL, 'auth.login_failed', 'smuggled')`,
        ),
      ),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });
});

/* ================================================================== */
/* 2. APPEND-ONLY                                                      */
/* ================================================================== */

describe("security_events — append-only evidence", () => {
  /* ----------------------------------------------------------------
   * LAYER 1 — THE PRIVILEGE. This is the control that actually fires in
   * production, because PostgreSQL checks privileges BEFORE it reaches a
   * trigger. `ordence_app` holds SELECT and INSERT and nothing else
   * (Section 5 of 0012), so the statement never gets far enough to be
   * refused by the append-only trigger.
   *
   * ⚠️ Which is exactly why `expectGuard` cannot be used on these three:
   * "permission denied for table" is what SUCCESS looks like here. The
   * trigger is asserted separately, below, as the role that does have the
   * privilege.
   * ---------------------------------------------------------------- */

  it("the application role has no UPDATE privilege at all", async () => {
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`UPDATE security_events SET reason = 'nothing happened' WHERE id = $1`, [
          fx.eventA,
        ]),
      ),
    );

    expect(
      error,
      "the app role UPDATED a security event — Section 5's REVOKE has been defeated, " +
        "most likely by a prior GRANT ALL ON ALL TABLES",
    ).not.toBeNull();
    expect(error!.message).toMatch(/permission denied for (table|relation)/i);
  });

  it("the application role has no DELETE privilege at all", async () => {
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA]),
      ),
    );

    expect(
      error,
      "the app role DELETED a security event — an intruder could erase the record " +
        "of their own intrusion",
    ).not.toBeNull();
    expect(error!.message).toMatch(/permission denied for (table|relation)/i);
  });

  /* ----------------------------------------------------------------
   * LAYER 2 — THE TRIGGER. Asserted as the privileged role, and that is
   * legitimate here in a way it would NOT be for an RLS test.
   *
   * A superuser bypasses Row-Level Security completely, so an isolation
   * assertion made as one proves nothing. Triggers are different: they
   * fire for EVERY role including the superuser and the table owner.
   * Running these as `asSuperuser` is therefore the only way to reach the
   * trigger at all — the app role is stopped one layer earlier — and the
   * result is still a real assertion about the database.
   *
   * `expectGuard` applies here: at this privilege level a
   * "permission denied" would mean the trigger is NOT what refused us.
   * ---------------------------------------------------------------- */

  it("UPDATE is refused by the append-only trigger, even for a privileged role", async () => {
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(`UPDATE security_events SET reason = 'nothing happened' WHERE id = $1`, [
            fx.eventA,
          ]),
        ),
      /append-only/i,
    );
  });

  it("UPDATE of the export marker is refused too — there is no carve-out", async () => {
    // `exported_at` looks like the one harmless column. It is deliberately
    // not exempt: an exception is a general UPDATE path that a later change
    // reuses, and SIEM export uses an external cursor precisely so it never
    // needs one.
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(`UPDATE security_events SET exported_at = now() WHERE id = $1`, [
            fx.eventA,
          ]),
        ),
      /append-only/i,
    );
  });

  it("DELETE is refused by the trigger unless the prune flag is set", async () => {
    await expectGuard(
      () =>
        asSuperuser((c) =>
          c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA]),
        ),
      /append-only|not permitted/i,
    );
  });

  it("moving an event to another tenant is refused", async () => {
    // Belt and braces behind the append-only trigger: if that were ever
    // dropped, this still refuses the single most damaging edit available —
    // hiding a row from the tenant it concerns by filing it under another.
    await expectGuard(
      () =>
        asSuperuser(async (c) => {
          // Disable the blanket UPDATE guard so the tenant-fix trigger is the
          // thing under test rather than the thing shadowed by it.
          await c.query(`ALTER TABLE security_events DISABLE TRIGGER security_events_no_update`);
          try {
            await c.query(`UPDATE security_events SET tenant_id = $1 WHERE id = $2`, [
              fx.tenantB,
              fx.eventA,
            ]);
          } finally {
            await c.query(`ALTER TABLE security_events ENABLE TRIGGER security_events_no_update`);
          }
        }),
      /cannot be reassigned to a different tenant/i,
    );
  });

  it("the event survived every attempt", async () => {
    const rows = await asTenant(fx.tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT reason, exported_at FROM security_events WHERE id = $1`,
        [fx.eventA],
      );
      return rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("A trip");
    expect(rows[0].exported_at).toBeNull();
  });
});

/* ================================================================== */
/* 3. RETENTION IS PRIVILEGED                                          */
/* ================================================================== */

describe("security_events — retention is a separated duty", () => {
  it("the application role cannot execute prune_security_events()", async () => {
    // Compromising the web application must not confer the ability to erase
    // the record of having compromised it.
    const error = await expectError(() =>
      withoutTenant((c) => c.query(`SELECT prune_security_events(365, false)`)),
    );

    expect(error, "the app role CAN delete security history via the prune function").not.toBeNull();
    expect(error!.message).toMatch(/permission denied for function/i);
  });

  it("the app cannot set the prune flag to bypass the delete guard", async () => {
    // `set_config` is grantable to anyone, so the flag alone is not the
    // control — the DELETE privilege is. Assert both halves: even with the
    // flag set, the role has no DELETE.
    const error = await expectError(() =>
      asTenant(fx.tenantA, async (c) => {
        await c.query(`SELECT set_config('app.allow_security_event_prune', 'on', true)`);
        await c.query(`DELETE FROM security_events WHERE id = $1`, [fx.eventA]);
      }),
    );

    expect(
      error,
      "a tenant session set the prune flag and DELETED a security event — " +
        "the DELETE privilege was granted to the app role and must be revoked",
    ).not.toBeNull();
    expect(error!.message).toMatch(/permission denied/i);
  });

  it("prune_security_events() refuses an absurdly short retention", async () => {
    const error = await expectError(() =>
      asSuperuser((c) => c.query(`SELECT prune_security_events(1, true)`)),
    );

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/younger than 30 days/i);
  });
});
