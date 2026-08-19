/**
 * Ordence — Infra wave 13: the cross-cutting mechanisms, checked exhaustively
 * Version: v1.80.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY TEST HERE REPLACES A FLOOR WITH AN EXHAUSTIVE CHECK
 * ══════════════════════════════════════════════════════════════════════
 * Four mechanisms in this product are attached table by table, by hand,
 * copied from one module migration to the next. Each has a verification
 * step, and three of the four were written as FLOORS:
 *
 *     0014: count(*) FILTER (...) >= 10  THEN 'PASS'
 *
 * 48 is greater than 10, so it printed PASS while the impersonation
 * delete guard covered 48 of 303 tenant tables. `check-rls-coverage.mjs`
 * was written to eliminate exactly this shape ("only 12 tables had RLS
 * and the CI step tested >= 100") and the shape survived in other files.
 *
 * ⚠️ THESE TESTS ASSERT ZERO GAPS, NOT A THRESHOLD. If a future module
 * migration adds a tenant table without calling the sweep, the failure
 * message names the table.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { asSuperuser, asTenant, expectError } from "../setup";

/* ================================================================== */
/* 1. THE FOUR COVERAGE SWEEPS                                         */
/* ================================================================== */

describe("cross-cutting mechanisms cover every table, not most of them", () => {
  it("⭐ every tenant-scoped table refuses DELETE under impersonation", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          LEFT JOIN pg_trigger tg
            ON tg.tgrelid = (quote_ident(c.table_name))::regclass
           AND tg.tgname  = 'no_delete_under_impersonation'
           AND NOT tg.tgisinternal
         WHERE c.table_schema = 'public'
           AND c.column_name  = 'tenant_id'
           AND t.table_type   = 'BASE TABLE'
           AND tg.tgname IS NULL
           AND c.table_name NOT IN (SELECT e.table_name FROM impersonation_guard_exclusions e)
         ORDER BY c.table_name
      `);
      expect(
        rows.map((r: { table_name: string }) => r.table_name),
        "a support engineer inside an impersonation session can DELETE from these tables",
      ).toEqual([]);
    });
  });

  it("⭐ every updated_at column is actually maintained", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public'
           AND c.column_name  = 'updated_at'
           AND t.table_type   = 'BASE TABLE'
           AND c.table_name NOT IN (SELECT e.table_name FROM updated_at_exclusions e)
           AND NOT EXISTS (
             SELECT 1 FROM pg_trigger tg
               JOIN pg_class pc ON pc.oid = tg.tgrelid
               JOIN pg_namespace pn ON pn.oid = pc.relnamespace
               JOIN pg_proc pp ON pp.oid = tg.tgfoid
              WHERE NOT tg.tgisinternal AND pn.nspname = 'public'
                AND pc.relname = c.table_name
                AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at'))
         ORDER BY c.table_name
      `);
      expect(
        rows.map((r: { table_name: string }) => r.table_name),
        "these tables have an updated_at that is set once on INSERT and never moves again",
      ).toEqual([]);
    });
  });

  it("🔴 no table has TWO updated_at triggers", async () => {
    // ══════════════════════════════════════════════════════════════════
    // THIS TEST CAUGHT A BUG IN 0126 ITSELF, ON ITS FIRST RUN.
    // ══════════════════════════════════════════════════════════════════
    // There are two functions doing this job: `set_updated_at()` on 159
    // tables and `ordence_touch_updated_at()` on 19. The first draft of
    // the sweep knew about one of them, so it attached a SECOND trigger
    // to twelve tables that were already covered by the other , including
    // `warehouses`, `stock_items` and `powers_of_attorney`.
    //
    // ⚠️ Two triggers both setting `updated_at = now()` is harmless today
    // and is still wrong: the next person to change one of the two
    // functions changes the behaviour of some tables and not others, and
    // nothing on the table says which.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT pc.relname AS table_name, count(*)::int AS n
          FROM pg_trigger tg
          JOIN pg_class pc ON pc.oid = tg.tgrelid
          JOIN pg_namespace pn ON pn.oid = pc.relnamespace
          JOIN pg_proc  pp ON pp.oid = tg.tgfoid
         WHERE NOT tg.tgisinternal
           AND pn.nspname = 'public'
           AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at')
         GROUP BY pc.relname
        HAVING count(*) > 1
         ORDER BY pc.relname
      `);
      expect(
        rows.map((r: { table_name: string }) => r.table_name),
        "these tables run two updated_at triggers",
      ).toEqual([]);
    });
  });

  it("⚠️ sales_orders is covered, under the other naming convention", async () => {
    // 0028 named its trigger `trg_touch_sales_orders` and pointed it at
    // `ordence_touch_updated_at`. A census keyed on the trigger NAME , the
    // shape 0017 and 0122 use for the change log , calls this uncovered.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT count(*)::int AS n
          FROM pg_trigger tg
          JOIN pg_class pc ON pc.oid = tg.tgrelid
          JOIN pg_proc  pp ON pp.oid = tg.tgfoid
         WHERE NOT tg.tgisinternal
           AND pc.relname = 'sales_orders'
           AND pp.proname IN ('set_updated_at', 'ordence_touch_updated_at')
      `);
      expect((rows[0] as { n: number }).n).toBe(1);
    });
  });

  it("⭐ every sweep is idempotent, so a module migration can call it safely", async () => {
    await asSuperuser(async (c) => {
      for (const fn of [
        "attach_change_log_triggers",
        "attach_impersonation_guards",
        "attach_updated_at_triggers",
      ]) {
        const { rows } = await c.query(`SELECT * FROM ${fn}()`);
        expect(rows, `${fn}() attached something on a second run`).toEqual([]);
      }
    });
  });

  it("⚠️ every exclusion in every registry carries a real reason", async () => {
    await asSuperuser(async (c) => {
      for (const table of [
        "change_log_exclusions",
        "impersonation_guard_exclusions",
        "updated_at_exclusions",
      ]) {
        const { rows } = await c.query(
          `SELECT table_name FROM ${table} WHERE length(btrim(reason)) < 25`,
        );
        expect(
          rows.map((r: { table_name: string }) => r.table_name),
          `${table} has entries with no real reason , an exclusion added to make a test pass`,
        ).toEqual([]);
      }
    });
  });
});

/* ================================================================== */
/* 2. THE STOCK LEDGER REFUSALS 0099 DROPPED                           */
/* ================================================================== */

describe("stock movements , the three checks 0099 removed while saying it kept them", () => {
  let tenant: string;
  let warehouse: string;
  let item: string;
  let user: string;

  it("sets up a warehouse and an item", async () => {
    tenant = randomUUID();
    warehouse = randomUUID();
    item = randomUUID();
    user = randomUUID();

    await asSuperuser(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,'Stock Checks','active')`,
        [tenant, `org_${tenant}`, `sk-${tenant.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, first_name, last_name)
         VALUES ($1,$2,$3,'store@example.test','Store','Keeper')`,
        [user, tenant, `usr_${user}`],
      );
      await c.query(
        `INSERT INTO warehouses (id, tenant_id, code, name, allow_negative_stock)
         VALUES ($1,$2,'WH1','Main Store', true)`,
        [warehouse, tenant],
      );
      await c.query(
        `INSERT INTO stock_items (id, tenant_id, sku, name, uom)
         VALUES ($1,$2,'CEM','Cement','bag')`,
        [item, tenant],
      );
    });
    expect(tenant).toBeTruthy();
  });

  /**
   * ⚠️ `allow_negative_stock` IS TRUE ON THIS WAREHOUSE ON PURPOSE. Without
   * it, an outward movement with a positive quantity would be refused by the
   * NEGATIVE STOCK check for a completely different reason, and the test
   * would pass while the sign check stayed absent. This is the
   * missing-GRANT problem in another costume: the right error for the wrong
   * reason is not a passing test.
   */
  const post = (over: Record<string, unknown>) =>
    asTenant(tenant, (c) =>
      c.query(
        `INSERT INTO stock_movements
           (tenant_id, stock_item_id, warehouse_id, reason, quantity,
            adjustment_note, approved_by, reverses_movement_id, moved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
        [
          tenant,
          item,
          warehouse,
          over.reason,
          over.quantity,
          over.note ?? null,
          over.approvedBy ?? null,
          over.reverses ?? null,
        ],
      ),
    );

  it("seeds 500 bags, so the floor guard is satisfied and the sign check is reachable", async () => {
    // ══════════════════════════════════════════════════════════════════
    // ⚠️ THIS STEP IS THE POINT OF THE WHOLE BLOCK, AND WITHOUT IT THESE
    //    TESTS WOULD HAVE PASSED FOR THE WRONG REASON.
    // ══════════════════════════════════════════════════════════════════
    // `trg_020_guard_stock_floor` (0040) is named to sort FIRST , PostgreSQL
    // fires BEFORE ROW triggers in alphabetical order by trigger name, and
    // "trg_020_" beats "trg_validate_". On an empty warehouse it refuses
    // every negative movement with "This movement would leave -500.000 of
    // Cement", which is a different guard entirely.
    //
    // A test that asserted only "an error was raised" would therefore have
    // gone green with the sign check still missing. This is the same shape
    // as `expectGuard` in telemetry-isolation.test.ts, which exists because
    // a missing GRANT raises the same SQLSTATE as the trigger under test.
    //
    // With 500 bags on hand the floor is satisfied for a -10 movement, and
    // the sign check is the next trigger to speak.
    await post({ reason: "purchase_receipt", quantity: 500 });
    expect(true).toBe(true);
  });

  it("🔴 REFUSES a purchase_receipt for a negative quantity", async () => {
    const err = await expectError(() => post({ reason: "purchase_receipt", quantity: -10 }));
    expect(
      err,
      "a receipt for a NEGATIVE quantity was accepted , it flows into stock_balances and every valuation derived from them",
    ).not.toBeNull();
    expect(
      err!.message,
      "the floor guard answered instead of the sign check, so this test proves nothing about the sign check",
    ).not.toMatch(/would leave/i);
    expect(err!.message).toMatch(/must be positive/i);
  });

  it("🔴 REFUSES a transfer_out for a positive quantity", async () => {
    const err = await expectError(() => post({ reason: "transfer_out", quantity: 500 }));
    expect(err, "an outward movement that ADDS stock was accepted").not.toBeNull();
    expect(err!.message).toMatch(/must be negative/i);
  });

  it("🔴 REFUSES an adjustment with no named approver", async () => {
    const err = await expectError(() =>
      post({
        reason: "adjustment",
        quantity: -10,
        note: "Counted short at the monthly stock take",
      }),
    );
    expect(
      err,
      "stock was written off with nobody's name against it",
    ).not.toBeNull();
    expect(err!.message).toMatch(/named approver/i);
  });

  it("🔴 REFUSES an adjustment note under ten characters", async () => {
    // 0099 weakened this to "not empty", which accepts "x".
    const err = await expectError(() =>
      post({ reason: "adjustment", quantity: -10, note: "x", approvedBy: user }),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/ten characters/i);
  });

  it("🔴 REFUSES a reversal that names no movement", async () => {
    const err = await expectError(() => post({ reason: "reversal", quantity: -10 }));
    expect(
      err,
      "a reversal pointing at nothing was accepted , an adjustment with a friendlier label",
    ).not.toBeNull();
    expect(err!.message).toMatch(/must name the movement/i);
  });

  it("✅ ACCEPTS a correct movement, so the tests above mean something", async () => {
    await post({
      reason: "adjustment",
      quantity: -10,
      note: "Counted short at the monthly stock take",
      approvedBy: user,
    });
    const rows = await asTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `SELECT quantity FROM stock_movements WHERE tenant_id = $1 ORDER BY quantity`,
        [tenant],
      );
      return rows.map((r: { quantity: string }) => Number(r.quantity));
    });
    // The +500 seed and the -10 adjustment. Every refusal above left nothing.
    expect(rows).toEqual([-10, 500]);
  });

  it("cleans up", async () => {
    await asSuperuser(async (c) => {
      /**
       * ⚠️ THE LEDGER REFUSES DELETE EVEN FOR THE OWNER, AND THAT IS RIGHT.
       * `ordence_stock_ledger_append_only` has no escape hatch , unlike the
       * telemetry retention sweep, which has one and documents it. Its
       * message tells you to post a reversal instead, which is correct advice
       * for a real ledger and no use to a test tearing down its own fixture.
       *
       * So the trigger is dropped and recreated around the teardown, as the
       * OWNER, in one statement each. This is the only honest way to remove
       * test rows from an append-only table, and doing it here rather than
       * weakening the trigger keeps the guarantee intact for the product.
       */
      await c.query(`ALTER TABLE stock_movements DISABLE TRIGGER trg_stock_ledger_append_only`);
      try {
        await c.query(`DELETE FROM stock_movements WHERE tenant_id = $1`, [tenant]);
      } finally {
        await c.query(`ALTER TABLE stock_movements ENABLE TRIGGER trg_stock_ledger_append_only`);
      }

      // And prove the guarantee is back on, so a failure here cannot leave
      // the ledger writable for every test that follows.
      const { rows } = await c.query(`
        SELECT tgenabled FROM pg_trigger
         WHERE tgrelid = 'stock_movements'::regclass
           AND tgname  = 'trg_stock_ledger_append_only'
      `);
      expect((rows[0] as { tgenabled: string } | undefined)?.tgenabled).toBe("O");

      await c.query(`DELETE FROM stock_balances WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM stock_items  WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM warehouses   WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM users        WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM change_log   WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM tenants      WHERE id = $1`, [tenant]);
    });
    expect(true).toBe(true);
  });
});

/* ================================================================== */
/* 3. THE GRANT 0087 TOOK AWAY                                         */
/* ================================================================== */

describe("credit_dunning_log , the delivery answer can be written back", () => {
  it("⭐ ordence_app holds UPDATE on exactly the four delivery columns", async () => {
    // 0083 granted UPDATE and said in prose that `delivery`, `sent_at`,
    // `failure_reason` and `next_action_on` must stay mutable because
    // something else delivers these and has to write the answer back.
    // 0087 revoked it in a REVOKE-then-narrow sweep and re-granted the
    // default evidence-table shape, SELECT and INSERT. Every notice then
    // stayed 'queued' forever and the collections screen reported that
    // nothing had ever been sent.
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT column_name FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = 'credit_dunning_log'
           AND grantee = 'ordence_app' AND privilege_type = 'UPDATE'
         ORDER BY column_name
      `);
      expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
        "delivery",
        "failure_reason",
        "next_action_on",
        "sent_at",
      ]);
    });
  });

  it("⚠️ and NOT on the rest of the row, which is a demand for money", async () => {
    await asSuperuser(async (c) => {
      const { rows } = await c.query(`
        SELECT count(*)::int AS n FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = 'credit_dunning_log'
           AND grantee = 'ordence_app' AND privilege_type = 'UPDATE'
           AND column_name IN ('recipient_email','amount_due_minor','stage_no',
                               'invoice_id','company_id','tenant_id')
      `);
      expect(
        (rows[0] as { n: number }).n,
        "the application can rewrite who was chased, for how much, at which rung",
      ).toBe(0);
    });
  });
});
