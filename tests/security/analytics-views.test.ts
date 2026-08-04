/**
 * Ordence — Analytics View Isolation
 * Version: v0.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 10 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * "Verify that the RLS policies successfully cascade into the new SQL
 *  Views, ensuring an admin can NEVER see aggregate financial data from
 *  another tenant."
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ANSWER IS THAT THEY DO NOT CASCADE — UNLESS YOU MAKE THEM
 * ══════════════════════════════════════════════════════════════════════
 * A PostgreSQL view runs with the privileges of its OWNER by default, not
 * of the caller. A view over `journal_entries` owned by the table owner
 * therefore returns EVERY tenant's entries to anyone permitted to select
 * from the view. The RLS policies underneath are never consulted.
 *
 * `WITH (security_invoker = true)` reverses that: the view executes as the
 * caller, so the caller's policies apply.
 *
 * The first test below PROVES the difference by building both kinds of
 * view over the same table and querying them in the same session. It is
 * written as a demonstration rather than an assertion about our own views
 * because the failure is silent — nothing errors, the numbers are simply
 * wrong in the most dangerous possible direction — and a test that merely
 * checked a flag would not show why the flag matters.
 *
 * Every assertion runs as a NON-SUPERUSER. A superuser bypasses RLS
 * entirely, so a suite connected as one would pass even with every policy
 * dropped.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser } from "../setup";

type Fixtures = {
  tenantA: string;
  tenantB: string;
  contractA: string;
  contractB: string;
};

let fx: Fixtures;

/** Tenant B's numbers are deliberately unmistakable if they ever leak. */
const A_ASSET_VALUE = "5000000.00";
const B_ASSET_VALUE = "9999999.00";
const A_AMOUNT = "1000.00";
const B_AMOUNT = "7777777.00";

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const contractA = randomUUID();
  const contractB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Analytics Tenant A"],
      [tenantB, "Analytics Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,$4,'active')`,
        [id, `org_${id}`, `an-${id.slice(0, 8)}`, name],
      );
    }

    for (const [id, tenant, title, value] of [
      [contractA, tenantA, "A contract", "250000.00"],
      [contractB, tenantB, "B contract", "8888888.00"],
    ] as const) {
      await c.query(
        `INSERT INTO contracts (id, tenant_id, title, contract_type, status, value)
         VALUES ($1,$2,$3,'sale_agreement','draft',$4)`,
        [id, tenant, title, value],
      );
    }

    for (const [tenant, name, value] of [
      [tenantA, "A Tower", A_ASSET_VALUE],
      [tenantB, "B Tower", B_ASSET_VALUE],
    ] as const) {
      await c.query(
        `INSERT INTO assets (id, tenant_id, name, asset_type, status, value_amount)
         VALUES ($1,$2,$3,'building','available',$4)`,
        [randomUUID(), tenant, name, value],
      );
    }

    // A balanced transaction per tenant, dated today so it lands inside the
    // 30-day window the ledger view covers.
    for (const [tenant, amount] of [
      [tenantA, A_AMOUNT],
      [tenantB, B_AMOUNT],
    ] as const) {
      const bank = randomUUID();
      const sales = randomUUID();
      const txn = randomUUID();

      await c.query(
        `INSERT INTO ledgers (id, tenant_id, name, code, type, account_type)
         VALUES ($1,$2,'Bank','1100','operating','asset'),
                ($3,$2,'Sales','4100','operating','revenue')`,
        [bank, tenant, sales],
      );

      await c.query(
        `INSERT INTO transactions (id, tenant_id, description, transaction_date, currency)
         VALUES ($1,$2,'Analytics fixture',CURRENT_DATE,'INR')`,
        [txn, tenant],
      );

      await c.query(
        `INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
         VALUES ($1,$2,$3,'debit',$5), ($1,$2,$4,'credit',$5)`,
        [tenant, txn, bank, sales, amount],
      );
    }
  });

  fx = { tenantA, tenantB, contractA, contractB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    const ids = [fx.tenantA, fx.tenantB];
    await c.query(`ALTER TABLE journal_entries DISABLE TRIGGER USER`);
    await c.query(`DELETE FROM journal_entries WHERE tenant_id = ANY($1)`, [ids]);
    await c.query(`ALTER TABLE journal_entries ENABLE TRIGGER USER`);
    await c.query(`DELETE FROM transactions WHERE tenant_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM ledgers WHERE tenant_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM assets WHERE tenant_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM contracts WHERE tenant_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1)`, [ids]);
  });
});

/* ================================================================== */
/* THE DEMONSTRATION                                                  */
/* ================================================================== */

describe("⭐ RLS does not reach through a view unless security_invoker is set", () => {
  it("a NAIVE view leaks every tenant; a security_invoker view does not", async () => {
    // Build both kinds over the same table, in the same database.
    await asSuperuser(async (c) => {
      await c.query(`DROP VIEW IF EXISTS test_naive_view`);
      await c.query(`DROP VIEW IF EXISTS test_invoker_view`);

      await c.query(
        `CREATE VIEW test_naive_view AS
         SELECT tenant_id, count(*)::int AS n FROM contracts GROUP BY tenant_id`,
      );
      await c.query(
        `CREATE VIEW test_invoker_view WITH (security_invoker = true) AS
         SELECT tenant_id, count(*)::int AS n FROM contracts GROUP BY tenant_id`,
      );

      await c.query(`GRANT SELECT ON test_naive_view, test_invoker_view TO ordence_app`);
    });

    const result = await asTenant(fx.tenantA, async (c) => {
      const naive = await c.query(
        `SELECT count(DISTINCT tenant_id)::int AS tenants FROM test_naive_view`,
      );
      const invoker = await c.query(
        `SELECT count(DISTINCT tenant_id)::int AS tenants FROM test_invoker_view`,
      );
      const base = await c.query(
        `SELECT count(DISTINCT tenant_id)::int AS tenants FROM contracts`,
      );

      return {
        naive: naive.rows[0].tenants as number,
        invoker: invoker.rows[0].tenants as number,
        base: base.rows[0].tenants as number,
      };
    });

    await asSuperuser(async (c) => {
      await c.query(`DROP VIEW IF EXISTS test_naive_view`);
      await c.query(`DROP VIEW IF EXISTS test_invoker_view`);
    });

    // The base table is correctly isolated — RLS works.
    expect(result.base).toBe(1);

    // The security_invoker view matches the base table.
    expect(result.invoker).toBe(1);

    // ⭐ The naive view does NOT. This is the whole point: it sees more
    // than one tenant while the caller's own table access sees exactly one.
    expect(result.naive).toBeGreaterThan(1);
  });
});

/* ================================================================== */
/* OUR VIEWS                                                          */
/* ================================================================== */

describe("analytics views — configuration", () => {
  it("all three views exist and are marked security_invoker", async () => {
    const rows = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT c.relname,
                COALESCE(c.reloptions @> ARRAY['security_invoker=true'], false) AS invoker
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'v'
           AND c.relname IN ('v_asset_portfolio','v_ledger_daily','v_contract_pipeline')`,
      );
      return r.rows as Array<{ relname: string; invoker: boolean }>;
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.invoker, `${row.relname} is NOT security_invoker — it leaks`).toBe(true);
    }
  });

  it("every view exposes tenant_id", async () => {
    // So the application can filter explicitly as a second layer, and so a
    // stray cross-tenant aggregate is visible in a query rather than hidden.
    const names = await asSuperuser(async (c) => {
      const r = await c.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema='public' AND column_name='tenant_id'
           AND table_name IN ('v_asset_portfolio','v_ledger_daily','v_contract_pipeline')`,
      );
      return r.rows.map((x: { table_name: string }) => x.table_name);
    });

    expect(names).toHaveLength(3);
  });
});

/* ================================================================== */
/* AGGREGATE ISOLATION — THE MANDATORY CHECK                          */
/* ================================================================== */

describe("analytics views — an admin can NEVER see another tenant's aggregates", () => {
  it("asset totals are the tenant's own, not the platform's", async () => {
    const a = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `SELECT count(DISTINCT tenant_id)::int AS tenants,
                COALESCE(sum(total_value),0)::text AS value
         FROM v_asset_portfolio`,
      );
      return r.rows[0] as { tenants: number; value: string };
    });

    expect(a.tenants).toBe(1);
    expect(a.value).toBe(A_ASSET_VALUE);
    // The decisive assertion: tenant B's value is nowhere in the total.
    expect(a.value).not.toContain("9999999");
  });

  it("ledger totals are the tenant's own money only", async () => {
    const a = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `SELECT count(DISTINCT tenant_id)::int AS tenants,
                COALESCE(sum(debits),0)::text  AS debits,
                COALESCE(sum(credits),0)::text AS credits
         FROM v_ledger_daily`,
      );
      return r.rows[0] as { tenants: number; debits: string; credits: string };
    });

    expect(a.tenants).toBe(1);
    expect(a.debits).toBe(A_AMOUNT);
    expect(a.credits).toBe(A_AMOUNT);

    // If isolation failed, this would be 7778777.00 — and it would look
    // like a perfectly plausible number on a dashboard.
    expect(a.debits).not.toContain("7777777");
  });

  it("contract totals are the tenant's own", async () => {
    const a = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `SELECT count(DISTINCT tenant_id)::int AS tenants,
                COALESCE(sum(total_value),0)::text AS value
         FROM v_contract_pipeline`,
      );
      return r.rows[0] as { tenants: number; value: string };
    });

    expect(a.tenants).toBe(1);
    expect(a.value).toBe("250000.00");
    expect(a.value).not.toContain("8888888");
  });

  it("tenant B sees ITS OWN figures — isolation is symmetric", async () => {
    // A view that returned nothing to everyone would pass every test above
    // and be useless. This proves the isolation works in both directions.
    const b = await asTenant(fx.tenantB, async (c) => {
      const r = await c.query(
        `SELECT COALESCE(sum(total_value),0)::text AS value FROM v_asset_portfolio`,
      );
      return r.rows[0].value as string;
    });

    expect(b).toBe(B_ASSET_VALUE);
  });

  it("NO tenant context returns ZERO rows from every view", async () => {
    const counts = await withoutTenant(async (c) => {
      const assets = await c.query(`SELECT count(*)::int AS n FROM v_asset_portfolio`);
      const ledger = await c.query(`SELECT count(*)::int AS n FROM v_ledger_daily`);
      const contracts = await c.query(`SELECT count(*)::int AS n FROM v_contract_pipeline`);
      return {
        assets: assets.rows[0].n as number,
        ledger: ledger.rows[0].n as number,
        contracts: contracts.rows[0].n as number,
      };
    });

    // Fail closed. Not "all rows", which is what a view without
    // security_invoker would return here.
    expect(counts.assets).toBe(0);
    expect(counts.ledger).toBe(0);
    expect(counts.contracts).toBe(0);
  });

  it("a garbage tenant context returns zero rows", async () => {
    const n = await asTenant(randomUUID(), async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM v_asset_portfolio`);
      return r.rows[0].n as number;
    });

    expect(n).toBe(0);
  });
});

/* ================================================================== */
/* CORRECTNESS                                                        */
/* ================================================================== */

describe("analytics views — correctness", () => {
  it("the ledger view returns exactly 30 days, including quiet ones", async () => {
    // A `GROUP BY date` would return 1 row here — the single day with a
    // transaction — and the chart would render a fortnight of inactivity
    // as one bar. The date spine is what makes the gaps visible.
    const rows = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM v_ledger_daily`);
      return r.rows[0].n as number;
    });

    expect(rows).toBe(30);
  });

  it("days with no activity report zero, not null", async () => {
    // A null would become `NaN` after arithmetic in the application and
    // render as a broken tile rather than an empty day.
    const nulls = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM v_ledger_daily
         WHERE debits IS NULL OR credits IS NULL OR net_movement IS NULL`,
      );
      return r.rows[0].n as number;
    });

    expect(nulls).toBe(0);
  });

  it("the ledger view agrees with the base tables", async () => {
    // The view is an optimisation. If it ever disagrees with the ledger it
    // is describing, the optimisation is a liability.
    const [viaView, viaTables] = await asTenant(fx.tenantA, async (c) => {
      const v = await c.query(
        `SELECT COALESCE(sum(debits),0)::text AS total FROM v_ledger_daily`,
      );
      const t = await c.query(
        `SELECT COALESCE(sum(amount),0)::text AS total
         FROM journal_entries WHERE entry_type = 'debit'`,
      );
      return [v.rows[0].total as string, t.rows[0].total as string];
    });

    expect(viaView).toBe(viaTables);
  });

  it("net movement equals debits minus credits", async () => {
    const mismatches = await asTenant(fx.tenantA, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM v_ledger_daily
         WHERE net_movement <> (debits - credits)`,
      );
      return r.rows[0].n as number;
    });

    expect(mismatches).toBe(0);
  });
});
