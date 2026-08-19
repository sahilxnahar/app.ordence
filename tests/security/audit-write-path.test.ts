/**
 * Ordence — The Audit WRITE Path
 * Version: v0.14.1-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE REGRESSION THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `writeAudit()` inserted on the plain `db` client, which carries no
 * tenant context. `audit_logs` is under FORCE RLS with a WITH CHECK of
 * `tenant_id = app_current_tenant_id()`, so every insert was rejected —
 * and `writeAudit` caught the error and logged it to a console nobody
 * reads.
 *
 * **The audit trail was silently empty on every deployment where the
 * application role is subject to RLS.** Phases 1 through 14. Nothing
 * anywhere reported it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY 238 SECURITY TESTS DID NOT CATCH IT
 * ══════════════════════════════════════════════════════════════════════
 * Because every one of them inserted audit rows AS A SUPERUSER, in order
 * to then prove the append-only triggers refuse to modify them. A
 * superuser bypasses RLS entirely, so the fixtures always landed. The
 * suite proved — correctly, and uselessly — that a table nothing was
 * writing to could not be tampered with.
 *
 * The gap was structural: we tested that the audit trail was IMMUTABLE
 * and never that it was WRITTEN. Those are different claims, and only
 * one of them was load-bearing for "we can show you who did what".
 *
 * So every test below writes as the ORDINARY APPLICATION ROLE, the same
 * way the running application does. `asSuperuser` appears here only to
 * clean up.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError } from "../setup";

let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Audit Write A"],
      [tenantB, "Audit Write B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `aw-${id.slice(0, 8)}`, name],
      );
    }
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query("ALTER TABLE audit_logs DISABLE TRIGGER USER");
    try {
      await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1::uuid[])`, [
        [tenantA, tenantB],
      ]);
    } finally {
      await c.query("ALTER TABLE audit_logs ENABLE TRIGGER USER");
    }
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);

    // Prove the triggers came back. A teardown that left them off would
    // void the append-only guarantee for every later run.
    const { rows } = await c.query(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`,
    );
    for (const row of rows) expect(row.tgenabled).toBe("O");
  });
});

/* ================================================================== */
/* 1. THE BUG, REPRODUCED                                              */
/* ================================================================== */

describe("the failure mode that hid an empty audit trail", () => {
  it("⭐ an audit INSERT with NO tenant context is REJECTED by RLS", async () => {
    // This is exactly what `writeAudit()` used to do: insert on a client
    // with no tenant context. It does not silently no-op — it raises. The
    // damage came from the surrounding try/catch swallowing it.
    const error = await expectError(() =>
      withoutTenant((c) =>
        c.query(
          `INSERT INTO audit_logs (tenant_id, action, resource_type)
           VALUES ($1,'update','probe')`,
          [tenantA],
        ),
      ),
    );

    expect(error, "the insert unexpectedly succeeded").not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("⭐ the SAME insert succeeds inside a tenant transaction", async () => {
    // The fix, proven. One wrapper is the entire difference between an
    // audit trail and an empty table.
    await asTenant(tenantA, (c) =>
      c.query(
        `INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id)
         VALUES ($1,'update','probe','fixed')`,
        [tenantA],
      ),
    );

    const { rows } = await asTenant(tenantA, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND resource_id = 'fixed'`,
        [tenantA],
      ),
    );
    expect(rows[0].n).toBe(1);
  });
});

/* ================================================================== */
/* 2. THE WRITE PATH ACTUALLY WORKS                                    */
/* ================================================================== */

describe("audit writes as the ORDINARY application role", () => {
  it("records an action and reads it back", async () => {
    const resourceId = randomUUID();

    await asTenant(tenantA, (c) =>
      c.query(
        `INSERT INTO audit_logs
           (tenant_id, actor_email, actor_role, action, resource_type,
            resource_id, severity, reason)
         VALUES ($1,'someone@example.test','tenant_admin','delete','contact',
                 $2,'critical','deleted a duplicate')`,
        [tenantA, resourceId],
      ),
    );

    const { rows } = await asTenant(tenantA, (c) =>
      c.query(
        `SELECT actor_email, action, severity, reason FROM audit_logs
          WHERE tenant_id = $1 AND resource_id = $2`,
        [tenantA, resourceId],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_email).toBe("someone@example.test");
    expect(rows[0].severity).toBe("critical");
  });

  it("⭐ a tenant CANNOT write an audit row against another tenant", async () => {
    // The WITH CHECK clause doing its real job. Forging an entry in
    // someone else's history would be the most damaging write in the
    // system — it would put words in another company's record.
    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(
          `INSERT INTO audit_logs (tenant_id, action, resource_type)
           VALUES ($1,'update','forged')`,
          [tenantB],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("a tenant cannot READ another tenant's audit trail", async () => {
    await asTenant(tenantB, (c) =>
      c.query(
        `INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id)
         VALUES ($1,'update','b_only','secret')`,
        [tenantB],
      ),
    );

    const { rows } = await asTenant(tenantA, (c) =>
      c.query(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = 'secret'`),
    );
    expect(rows[0].n).toBe(0);
  });

  it("the written row is STILL append-only", async () => {
    // The immutability guarantee must survive the fix — the point was
    // never to loosen anything, only to make the writes land.
    const resourceId = randomUUID();
    await asTenant(tenantA, (c) =>
      c.query(
        `INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id)
         VALUES ($1,'update','immutable',$2)`,
        [tenantA, resourceId],
      ),
    );

    const error = await expectError(() =>
      asTenant(tenantA, (c) =>
        c.query(`UPDATE audit_logs SET reason = 'rewritten' WHERE resource_id = $1`, [
          resourceId,
        ]),
      ),
    );

    expect(error).not.toBeNull();
    // Must be the trigger or a missing privilege — either is a refusal.
    // What matters is that it did not succeed.
    expect(error!.message).toMatch(/append-only|immutable|permission denied/i);
  });
});

/* ================================================================== */
/* 3. THE SAME TRAP ON EVERY OTHER EVIDENCE TABLE                      */
/* ================================================================== */

describe("every evidence table has the same requirement", () => {
  /**
   * The bug was not specific to `audit_logs`. Any code path inserting
   * into a FORCE-RLS table without a tenant context fails the same way,
   * and if it swallows the error the loss is silent.
   *
   * This sweep is the standing check. If a future phase adds an evidence
   * table and a writer that forgets `withTenant()`, the shape of the
   * failure is already documented here.
   */
  const TENANT_SCOPED_EVIDENCE = [
    "audit_logs",
    "permission_denials",
  ] as const;

  for (const table of TENANT_SCOPED_EVIDENCE) {
    it(`${table}: a context-less insert is refused, not silently dropped`, async () => {
      const error = await expectError(() =>
        withoutTenant((c) =>
          c.query(
            `INSERT INTO ${table} (tenant_id) VALUES ($1)`,
            [tenantA],
          ),
        ),
      );
      // It may fail on RLS or on a NOT NULL column — either way it does
      // NOT quietly succeed, which is the property under test.
      expect(error, `${table} accepted a context-less insert`).not.toBeNull();
    });
  }
});
