/**
 * Ordence — The Change Log
 * Version: v0.23.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS IS SYNC PREPARATION, NOT SYNC
 * ══════════════════════════════════════════════════════════════════════
 * Nothing in the product reads this table yet. It exists because two
 * decisions have to be right BEFORE any sync is written, and both become
 * impossible to retrofit once data exists:
 *
 *   1. Ids are generated locally, so two machines never collide.
 *   2. Every change is recorded AS IT HAPPENS.
 *
 * You cannot reconstruct history you never wrote down. That is the whole
 * argument, and these tests are what stop the recorder quietly stopping.
 *
 * ⚠️ The three tests that matter most are the ones proving `updated_at`
 * alone would NOT have been enough — deletions, field-level detail, and
 * origin. Those are the three ways the obvious approach loses data.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

let tenantA: string;
let tenantB: string;
let projectA: string;

beforeAll(async () => {
  tenantA = randomUUID();
  tenantB = randomUUID();
  projectA = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Change Log A"],
      [tenantB, "Change Log B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `cl-${id.slice(0, 8)}`, name],
      );
    }
    await c.query(`INSERT INTO projects (id, tenant_id, code, name) VALUES ($1,$2,'CL','Log Tower')`, [
      projectA,
      tenantA,
    ]);
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
    for (const table of ["units", "leads", "companies", "projects"]) {
      await c.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
    }
    await c.query(`DELETE FROM change_log WHERE tenant_id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]]);
  });
});

/* ================================================================== */
/* COVERAGE                                                            */
/* ================================================================== */

describe("coverage", () => {
  it("is attached to every tenant-scoped table that is not already immutable", async () => {
    // ⚠️ DISCOVERED, NOT LISTED. A hand-maintained list is a list
    // somebody forgets to extend, and the omission is silent — the table
    // simply never syncs, and nobody finds out until data goes missing
    // between two machines.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          LEFT JOIN pg_trigger tg
            ON tg.tgname = c.table_name || '_change_log' AND NOT tg.tgisinternal
         WHERE c.table_schema = 'public'
           AND c.column_name  = 'tenant_id'
           AND t.table_type   = 'BASE TABLE'
           AND tg.tgname IS NULL
           AND c.table_name NOT IN (
             'change_log','audit_logs','payment_events','security_events',
             'error_events','web_vital_events','permission_denials',
             'lead_activities','contract_signatures','usage_counters','usage_levels',
             'platform_impersonation_sessions','platform_tenant_flags',
             'tenant_support_consents','platform_action_log'
           )
      `);

      expect(
        rows.map((r) => r.table_name),
        "these tables record no changes, so anything written there can never sync",
      ).toEqual([]);
    });
  });
});

/* ================================================================== */
/* THE THREE THINGS `updated_at` CANNOT DO                             */
/* ================================================================== */

describe("what a timestamp column cannot tell you", () => {
  it("⭐ records DELETIONS, which a timestamp scan cannot see at all", async () => {
    // ══════════════════════════════════════════════════════════════
    // The failure this prevents: a row deleted on the laptop is simply
    // absent from `WHERE updated_at > last_sync`. The server never
    // learns it went, and helpfully restores it on the next sync. The
    // user deletes it again. Forever.
    // ══════════════════════════════════════════════════════════════
    // ⚠️ `companies`, not `units`. The application role has no DELETE on
    // units — they are soft-deleted, and the first draft of this test
    // was refused with 42501 for exactly that reason. The refusal is
    // correct, so the test moved to a table where a hard delete is a
    // legitimate operation rather than the grant moving to suit a test.
    const company = randomUUID();

    await asTenant(tenantA, async (c) => {
      await c.query(`INSERT INTO companies (id, tenant_id, name) VALUES ($1,$2,'Doomed Ltd')`, [
        company,
        tenantA,
      ]);
      await c.query(`DELETE FROM companies WHERE id = $1`, [company]);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT operation, old_row->>'name' AS name
           FROM change_log
          WHERE row_id = $1 ORDER BY seq`,
        [company],
      );

      expect(rows.map((r) => r.operation)).toEqual(["insert", "delete"]);
      // The deleted row's contents survive it. Without that, "restore
      // this" is not answerable.
      expect(rows[1].name).toBe("Doomed Ltd");
    });
  });

  it("⭐ records WHICH FIELDS changed, so a non-conflict is not treated as one", async () => {
    // Two people editing different fields of one lead is not a conflict.
    // `updated_at` cannot tell that apart from one that is, so the naive
    // approach either loses an edit or asks the user about nothing.
    const lead = randomUUID();

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone, temperature)
         VALUES ($1,$2,'LEAD-CL1','Original','+919111111111','warm')`,
        [lead, tenantA],
      );
      await c.query(`UPDATE leads SET temperature = 'hot' WHERE id = $1`, [lead]);
    });

    await asTenant(tenantA, async (c) => {
      const { rows } = await c.query(
        `SELECT changed_cols, old_row->>'temperature' AS was, new_row->>'temperature' AS now
           FROM change_log WHERE row_id = $1 AND operation = 'update' ORDER BY seq DESC LIMIT 1`,
        [lead],
      );

      expect(rows[0].changed_cols).toContain("temperature");
      // ⚠️ `updated_at` is deliberately excluded — it changes on every
      // single update, so including it would mark every edit as touching
      // the same field as every other edit, and the list would be
      // useless for the one question it exists to answer.
      expect(rows[0].changed_cols).not.toContain("updated_at");
      expect(rows[0].was).toBe("warm");
      expect(rows[0].now).toBe("hot");
    });
  });

  it("⭐ records WHERE a change came from, so it is not echoed back forever", async () => {
    // Without an origin, a change synced down from the server is
    // indistinguishable from a local edit — so the next sync pushes it
    // straight back, and two machines ping-pong one edit indefinitely.
    const lead = randomUUID();

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone)
         VALUES ($1,$2,'LEAD-CL2','Origin Test','+919222222222')`,
        [lead, tenantA],
      );

      const { rows } = await c.query(
        `SELECT origin_id FROM change_log WHERE row_id = $1`,
        [lead],
      );
      expect(rows[0].origin_id).toBeTruthy();

      const install = await c.query(`SELECT id FROM installation LIMIT 1`);
      expect(rows[0].origin_id).toBe(install.rows[0].id);
    });
  });
});

/* ================================================================== */
/* NOISE CONTROL                                                       */
/* ================================================================== */

describe("the log stays useful", () => {
  it("does not record an UPDATE that changed nothing of substance", async () => {
    // A log full of no-op updates makes "what happened to this record?"
    // unanswerable, which is the only question it exists to answer.
    const lead = randomUUID();

    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone)
         VALUES ($1,$2,'LEAD-CL3','No Op','+919333333333')`,
        [lead, tenantA],
      );
    });

    await asTenant(tenantA, async (c) => {
      // Sets `name` to what it already is. The updated_at trigger still
      // fires, so a naive recorder would log this.
      await c.query(`UPDATE leads SET name = 'No Op' WHERE id = $1`, [lead]);

      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM change_log WHERE row_id = $1 AND operation = 'update'`,
        [lead],
      );
      expect(rows[0].n).toBe(0);
    });
  });
});

/* ================================================================== */
/* ISOLATION AND IMMUTABILITY                                          */
/* ================================================================== */

describe("the log is itself protected", () => {
  it("one tenant cannot read another tenant's edit history", async () => {
    // ⚠️ An edit history is MORE revealing than the records themselves —
    // it shows what a competitor changed their pricing from, and when.
    const lead = randomUUID();
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone)
         VALUES ($1,$2,'LEAD-CL4','Private','+919444444444')`,
        [lead, tenantA],
      );
    });

    await asTenant(tenantB, async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM change_log WHERE row_id = $1`, [
        lead,
      ]);
      expect(rows[0].n).toBe(0);
    });
  });

  it("the application cannot rewrite or erase history", async () => {
    const lead = randomUUID();
    await asTenant(tenantA, async (c) => {
      await c.query(
        `INSERT INTO leads (id, tenant_id, reference, name, phone)
         VALUES ($1,$2,'LEAD-CL5','Immutable','+919555555555')`,
        [lead, tenantA],
      );
    });

    const updateError = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`UPDATE change_log SET new_row = '{}'::jsonb WHERE row_id = $1`, [lead]);
      }),
    );
    expect(updateError).not.toBeNull();
    expect(updateError!.code).toBe("42501");

    const deleteError = await expectError(() =>
      asTenant(tenantA, async (c) => {
        await c.query(`DELETE FROM change_log WHERE row_id = $1`, [lead]);
      }),
    );
    expect(deleteError).not.toBeNull();
    expect(deleteError!.code).toBe("42501");
  });
});
