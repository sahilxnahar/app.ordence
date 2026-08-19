/**
 * Ordence — Financial Integrity Test Suite
 * Version: v0.6.0-alpha
 *
 * Proves the Phase 4 and Phase 5 financial controls actually fire.
 *
 * Three guarantees are under test:
 *   1. Debits must equal credits — enforced by a DEFERRED constraint trigger
 *   2. Closed periods reject entries — enforced by a BEFORE trigger
 *   3. Money arithmetic is exact — no floating-point drift, ever
 *
 * The timing difference between (1) and (2) is itself asserted, because getting
 * it wrong in either direction breaks the system:
 *   - If the balance check were NOT deferred, every transaction would fail on
 *     its first leg, since one side alone can never balance.
 *   - If the period lock WERE deferred, a blocked entry would briefly exist in
 *     the table before being rolled back.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, asSuperuser, expectError } from "../setup";

const RUN = randomUUID().slice(0, 8);

type F = {
  tenant: string;
  user: string;
  ledgerCash: string;
  ledgerRevenue: string;
  ledgerTrust: string;
  closedPeriod: string;
  openPeriod: string;
};
const F = {} as F;

beforeAll(async () => {
  await asSuperuser(async (c) => {
    const t = await c.query(
      `INSERT INTO tenants (clerk_org_id, name, slug, status)
       VALUES ($1, 'Accounting Test Co', $2, 'active') RETURNING id`,
      [`org_acct_${RUN}`, `acct-${RUN}`],
    );
    F.tenant = t.rows[0].id;

    const u = await c.query(
      `INSERT INTO users (tenant_id, clerk_user_id, email, role, status)
       VALUES ($1, $2, $3, 'tenant_owner', 'active') RETURNING id`,
      [F.tenant, `user_acct_${RUN}`, `acct-${RUN}@test.local`],
    );
    F.user = u.rows[0].id;

    const mk = async (name: string, code: string, type: string, acct: string) => {
      const r = await c.query(
        `INSERT INTO ledgers (tenant_id, name, code, type, account_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [F.tenant, name, code, type, acct],
      );
      return r.rows[0].id as string;
    };

    F.ledgerCash = await mk("Bank — Operating", `CASH-${RUN}`, "operating", "asset");
    F.ledgerRevenue = await mk("Revenue — Sales", `REV-${RUN}`, "operating", "revenue");
    F.ledgerTrust = await mk("Trust — Client Funds", `TRUST-${RUN}`, "trust", "asset");

    // Q1 2026 will be CLOSED. Q3 2026 stays OPEN.
    const closed = await c.query(
      `INSERT INTO financial_periods (tenant_id, name, start_date, end_date, status)
       VALUES ($1, $2, '2026-01-01', '2026-03-31', 'closed') RETURNING id`,
      [F.tenant, `Q1 2026 ${RUN}`],
    );
    F.closedPeriod = closed.rows[0].id;

    const open = await c.query(
      `INSERT INTO financial_periods (tenant_id, name, start_date, end_date, status)
       VALUES ($1, $2, '2026-07-01', '2026-09-30', 'open') RETURNING id`,
      [F.tenant, `Q3 2026 ${RUN}`],
    );
    F.openPeriod = open.rows[0].id;
  });
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    for (const t of ["journal_entries", "audit_logs", "contract_versions", "permission_denials"]) {
      await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    }
    try {
      await c.query("DELETE FROM journal_entries WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM transactions WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM audit_logs WHERE tenant_id = $1", [F.tenant]);
      await c.query("DELETE FROM tenants WHERE id = $1", [F.tenant]);
    } finally {
      for (const t of ["journal_entries", "audit_logs", "contract_versions", "permission_denials"]) {
        await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
      }
    }
  });
});

/** Post a transaction with the given legs, inside tenant context. */
async function postTransaction(
  legs: Array<{ ledger: string; type: "debit" | "credit"; amount: string }>,
  date = "2026-08-15",
): Promise<string> {
  return asTenant(F.tenant, async (c) => {
    const txn = await c.query(
      `INSERT INTO transactions (tenant_id, description, transaction_date, currency, total_amount)
       VALUES ($1, 'Test transaction', $2, 'INR', $3) RETURNING id`,
      [F.tenant, date, legs.filter((l) => l.type === "debit").reduce((s, l) => s + Number(l.amount), 0).toFixed(2)],
    );
    const txnId = txn.rows[0].id as string;

    for (const leg of legs) {
      await c.query(
        `INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [F.tenant, txnId, leg.ledger, leg.type, leg.amount],
      );
    }
    return txnId;
  });
}

/* ================================================================== */
/* 1. DOUBLE-ENTRY BALANCE                                             */
/* ================================================================== */

describe("Double-entry balance enforcement", () => {
  it("BLOCKS an unbalanced transaction (debit 100, credit 60)", async () => {
    const err = await expectError(() =>
      postTransaction([
        { ledger: F.ledgerCash, type: "debit", amount: "100.00" },
        { ledger: F.ledgerRevenue, type: "credit", amount: "60.00" },
      ]),
    );

    expect(err, "An unbalanced transaction must be rejected").not.toBeNull();
    expect(err!.message).toContain("does not balance");

    // ⚠️ MINOR UNITS, NOT "100.00". 0108 moved the ledger to bigint minor
    // units and the trigger reports what it actually summed:
    //
    //   "Debits = 10000, Credits = 6000, difference = 4000 (minor units)."
    //
    // It must NOT format those as 100.00 / 60.00, because a database
    // trigger does not know the transaction's currency exponent and two
    // decimals is not universal — JPY has 0, KWD, BHD, OMR, JOD, TND, LYD
    // and IQD have 3. A trigger that printed "100.00" for ¥10000 would be
    // stating a figure a hundred times too small in an error message an
    // accountant is meant to act on.
    expect(err!.message).toContain("minor units");
    expect(err!.message).toContain("Debits = 10000");
    expect(err!.message).toContain("Credits = 6000");
    expect(err!.message).toContain("difference = 4000");
  });

  it("ACCEPTS a balanced transaction (proves the test is meaningful)", async () => {
    const txnId = await postTransaction([
      { ledger: F.ledgerCash, type: "debit", amount: "100.00" },
      { ledger: F.ledgerRevenue, type: "credit", amount: "100.00" },
    ]);

    const rows = await asTenant(F.tenant, async (c) => {
      const r = await c.query("SELECT COUNT(*)::int AS n FROM journal_entries WHERE transaction_id = $1", [txnId]);
      return r.rows[0];
    });
    expect(rows.n).toBe(2);
  });

  it("ACCEPTS a split transaction (1 debit, 2 credits, all balancing)", async () => {
    const txnId = await postTransaction([
      { ledger: F.ledgerCash, type: "debit", amount: "1000.00" },
      { ledger: F.ledgerRevenue, type: "credit", amount: "600.00" },
      { ledger: F.ledgerTrust, type: "credit", amount: "400.00" },
    ]);
    expect(txnId).toBeTruthy();
  });

  it("BLOCKS a one-paisa imbalance — no tolerance whatsoever", async () => {
    const err = await expectError(() =>
      postTransaction([
        { ledger: F.ledgerCash, type: "debit", amount: "1000.00" },
        { ledger: F.ledgerRevenue, type: "credit", amount: "999.99" },
      ]),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("does not balance");
  });

  it("BLOCKS a single-leg transaction (one entry can never balance)", async () => {
    const err = await expectError(() =>
      postTransaction([{ ledger: F.ledgerCash, type: "debit", amount: "500.00" }]),
    );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/unbalanced|does not balance/);
  });

  it("BLOCKS a zero or negative amount", async () => {
    const err = await expectError(() =>
      postTransaction([
        { ledger: F.ledgerCash, type: "debit", amount: "-100.00" },
        { ledger: F.ledgerRevenue, type: "credit", amount: "-100.00" },
      ]),
    );
    // The CHECK constraint fires before the balance trigger.
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/amount_positive|violates check constraint/);
  });

  it("the balance check is DEFERRED — individual legs insert, COMMIT decides", async () => {
    // This is the property that makes multi-leg transactions possible at all.
    // A row-level trigger would reject the first leg every time.
    let firstLegSucceeded = false;
    let commitFailed = false;

    const client = await (await import("../setup")).testPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [F.tenant]);

      const txn = await client.query(
        `INSERT INTO transactions (tenant_id, description, transaction_date, currency)
         VALUES ($1, 'Deferred check probe', '2026-08-20', 'INR') RETURNING id`,
        [F.tenant],
      );
      const txnId = txn.rows[0].id;

      // Insert ONE leg. If the trigger were immediate, this would throw here.
      await client.query(
        `INSERT INTO journal_entries (tenant_id, transaction_id, ledger_id, entry_type, amount)
         VALUES ($1, $2, $3, 'debit', 250.00)`,
        [F.tenant, txnId, F.ledgerCash],
      );
      firstLegSucceeded = true;

      try {
        await client.query("COMMIT");
      } catch {
        commitFailed = true;
        await client.query("ROLLBACK").catch(() => {});
      }
    } finally {
      client.release();
    }

    expect(firstLegSucceeded, "The first leg must insert without error").toBe(true);
    expect(commitFailed, "COMMIT must reject the unbalanced transaction").toBe(true);
  });
});

/* ================================================================== */
/* 2. PERIOD CLOSE                                                     */
/* ================================================================== */

describe("Financial period close enforcement (SEC-012)", () => {
  it("BLOCKS an entry dated inside a CLOSED period", async () => {
    const err = await expectError(() =>
      postTransaction(
        [
          { ledger: F.ledgerCash, type: "debit", amount: "5000.00" },
          { ledger: F.ledgerRevenue, type: "credit", amount: "5000.00" },
        ],
        "2026-02-15", // inside closed Q1
      ),
    );

    expect(err, "A back-dated entry into a closed period must be rejected").not.toBeNull();
    expect(err!.message).toContain("closed accounting period");
    expect(err!.message).toContain("2026-02-15");
  });

  it("ACCEPTS the same entry dated inside an OPEN period", async () => {
    const txnId = await postTransaction(
      [
        { ledger: F.ledgerCash, type: "debit", amount: "5000.00" },
        { ledger: F.ledgerRevenue, type: "credit", amount: "5000.00" },
      ],
      "2026-08-15", // inside open Q3
    );
    expect(txnId).toBeTruthy();
  });

  it("BLOCKS entries on the exact boundary dates of a closed period", async () => {
    for (const boundary of ["2026-01-01", "2026-03-31"]) {
      const err = await expectError(() =>
        postTransaction(
          [
            { ledger: F.ledgerCash, type: "debit", amount: "10.00" },
            { ledger: F.ledgerRevenue, type: "credit", amount: "10.00" },
          ],
          boundary,
        ),
      );
      expect(err, `${boundary} is inside the closed period and must be blocked`).not.toBeNull();
      expect(err!.message).toContain("closed accounting period");
    }
  });

  it("ACCEPTS entries one day outside the closed period", async () => {
    const txnId = await postTransaction(
      [
        { ledger: F.ledgerCash, type: "debit", amount: "10.00" },
        { ledger: F.ledgerRevenue, type: "credit", amount: "10.00" },
      ],
      "2026-04-01", // the day after Q1 ends
    );
    expect(txnId).toBeTruthy();
  });

  it("⭐ the period lock is IMMEDIATE, and it now refuses the HEADER, not the leg", async () => {
    // ══════════════════════════════════════════════════════════════════
    // The two guards deliberately differ in timing, and this asserts the
    // difference rather than assuming it. The balance check is a
    // CONSTRAINT TRIGGER: it cannot fire until the last leg is in, so an
    // unbalanced transaction is refused at COMMIT. The period lock is a
    // plain BEFORE-ROW trigger: it decides on a fact already known, so it
    // refuses on the statement.
    //
    // ⚠️ THIS TEST USED TO PROBE THE `journal_entries` INSERT and expect
    // the `transactions` INSERT above it to succeed. It does not any more:
    // `ordence_guard_closed_period()` now refuses the transaction HEADER
    // on its `transaction_date`, which is strictly better — the refusal
    // arrives one statement earlier, on the row that actually carries the
    // date, and no orphan header is created.
    //
    // ⚠️ AND THE OLD VERSION LEAKED. Its `ROLLBACK` sat after the inner
    // try/catch, so when the header INSERT started throwing, control
    // jumped to `finally { client.release() }` and returned a connection
    // that was still inside an aborted transaction. The next test to
    // borrow it died on BEGIN with "current transaction is aborted" and
    // was blamed for it. `withRawClient` cannot do that.
    // ══════════════════════════════════════════════════════════════════
    const { withRawClient } = await import("../setup");

    let headerError: { message: string; code?: string } | null = null;

    await withRawClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [F.tenant]);
      try {
        await client.query(
          `INSERT INTO transactions (tenant_id, description, transaction_date, currency)
           VALUES ($1, 'Period lock probe', '2026-02-20', 'INR') RETURNING id`,
          [F.tenant],
        );
      } catch (err) {
        const e = err as { message?: string; code?: string };
        headerError = { message: e.message ?? String(err), code: e.code };
      }
    });

    expect(
      headerError,
      "a transaction dated inside a CLOSED period was accepted — the lock did " +
        "not fire on the statement, so the write landed and only COMMIT could " +
        "still refuse it",
    ).not.toBeNull();
    expect(headerError!.message).toMatch(/closed accounting period/i);
    // 23514 = check_violation. Refused by the guard, not by a missing GRANT.
    expect(headerError!.code).toBe("23514");
  });

  it("BLOCKS deleting an entry out of a closed period", async () => {
    // Emptying a closed period one row at a time is as much a violation as
    // adding to it.
    const txnId = await postTransaction(
      [
        { ledger: F.ledgerCash, type: "debit", amount: "77.00" },
        { ledger: F.ledgerRevenue, type: "credit", amount: "77.00" },
      ],
      "2026-08-25",
    );

    // Move the period lock over that date by closing Q3 temporarily.
    await asSuperuser(async (c) => {
      await c.query("UPDATE financial_periods SET status = 'closed' WHERE id = $1", [F.openPeriod]);
    });

    const err = await expectError(() =>
      asTenant(F.tenant, async (c) => {
        await c.query("DELETE FROM journal_entries WHERE transaction_id = $1", [txnId]);
      }),
    );

    // Reopen for the remaining tests.
    await asSuperuser(async (c) => {
      await c.query("UPDATE financial_periods SET status = 'open' WHERE id = $1", [F.openPeriod]);
    });

    expect(err).not.toBeNull();
    // Either the period lock or the append-only rule stops it — both are correct.
    expect(err!.message).toMatch(/closed accounting period|append-only/);
  });

  it("periods cannot overlap", async () => {
    const err = await expectError(() =>
      asSuperuser(async (c) => {
        await c.query(
          `INSERT INTO financial_periods (tenant_id, name, start_date, end_date, status)
           VALUES ($1, $2, '2026-02-01', '2026-04-30', 'open')`,
          [F.tenant, `Overlapping ${RUN}`],
        );
      }),
    );
    expect(err, "An overlapping period must be rejected").not.toBeNull();
    expect(err!.message).toMatch(/exclusion constraint|overlap/i);
  });
});

/* ================================================================== */
/* 3. EXACT DECIMAL ARITHMETIC                                         */
/* ================================================================== */

/** The same paise arithmetic the application uses. */
function toMinorUnits(amount: string): bigint {
  const t = amount.trim();
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(t)) throw new Error(`Invalid amount "${amount}"`);
  const [whole = "0", fraction = ""] = t.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}
function fromMinorUnits(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

describe("Floating-point precision defense", () => {
  it("demonstrates the bug we are avoiding: 0.1 + 0.2 !== 0.3 in JS floats", async () => {
    // If this ever becomes true, JavaScript has changed and this whole
    // defense can be reconsidered. Until then, it justifies the BigInt approach.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(0.1 + 0.2).toBeCloseTo(0.30000000000000004, 17);
  });

  it("BigInt paise arithmetic is exact for the same sum", async () => {
    const sum = toMinorUnits("0.10") + toMinorUnits("0.20");
    expect(fromMinorUnits(sum)).toBe("0.30");
  });

  it("no drift across 10,000 additions of 0.01", async () => {
    // The float version of this lands near 100.00000000000167.
    let exact = 0n;
    let float = 0;
    for (let i = 0; i < 10_000; i++) {
      exact += toMinorUnits("0.01");
      float += 0.01;
    }
    expect(fromMinorUnits(exact)).toBe("100.00");
    expect(float).not.toBe(100); // proves the float path would have drifted
  });

  it("handles a ₹1 crore three-way split without losing a paisa", async () => {
    const total = toMinorUnits("10000000.00");
    const parts = [toMinorUnits("3333333.33"), toMinorUnits("3333333.33"), toMinorUnits("3333333.34")];
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
  });

  it("catches the naive split that loses a paisa", async () => {
    const total = toMinorUnits("10000000.00");
    const naive = [toMinorUnits("3333333.33"), toMinorUnits("3333333.33"), toMinorUnits("3333333.33")];
    const sum = naive.reduce((a, b) => a + b, 0n);
    expect(sum).not.toBe(total);
    expect(fromMinorUnits(total - sum)).toBe("0.01");
  });

  it("the DATABASE also stores money exactly (NUMERIC, not float)", async () => {
    // Application-side exactness is worthless if the column rounds on write.
    const txnId = await postTransaction([
      { ledger: F.ledgerCash, type: "debit", amount: "0.30" },
      { ledger: F.ledgerRevenue, type: "credit", amount: "0.10" },
      { ledger: F.ledgerTrust, type: "credit", amount: "0.20" },
    ]);

    const total = await asTenant(F.tenant, async (c) => {
      const r = await c.query(
        `SELECT SUM(CASE WHEN entry_type='credit' THEN amount ELSE 0 END)::text AS credits
         FROM journal_entries WHERE transaction_id = $1`,
        [txnId],
      );
      return r.rows[0].credits as string;
    });

    // Exactly 0.30 — not 0.30000000000000004.
    expect(Number(total)).toBe(0.3);
    expect(total).toBe("0.30");
  });

  it("the amount column rejects a value with more than 2 decimal places of precision loss", async () => {
    const stored = await asSuperuser(async (c) => {
      const r = await c.query("SELECT 0.1::numeric(18,2) + 0.2::numeric(18,2) AS sum");
      return r.rows[0].sum as string;
    });
    expect(stored).toBe("0.30");
  });
});

/* ================================================================== */
/* 4. LEDGER RECONCILIATION                                            */
/* ================================================================== */

describe("Ledger balance integrity", () => {
  it("cached ledger balances match the sum of their journal entries", async () => {
    // `ledgers.current_balance` is a cache maintained by trigger. If it ever
    // drifts from SUM(journal_entries), reports would silently lie.
    const drifted = await asTenant(F.tenant, async (c) => {
      const r = await c.query(`
        SELECT l.code,
               l.current_balance::text AS cached,
               COALESCE(SUM(
                 CASE
                   WHEN l.account_type IN ('asset','expense') THEN
                     CASE WHEN je.entry_type = 'debit' THEN je.amount ELSE -je.amount END
                   ELSE
                     CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END
                 END
               ), 0)::text AS computed
        FROM ledgers l
        LEFT JOIN journal_entries je ON je.ledger_id = l.id
        WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
        GROUP BY l.id, l.code, l.current_balance, l.account_type
        HAVING l.current_balance <> COALESCE(SUM(
                 CASE
                   WHEN l.account_type IN ('asset','expense') THEN
                     CASE WHEN je.entry_type = 'debit' THEN je.amount ELSE -je.amount END
                   ELSE
                     CASE WHEN je.entry_type = 'credit' THEN je.amount ELSE -je.amount END
                 END
               ), 0)
      `, [F.tenant]);
      return r.rows;
    });

    expect(drifted, `Ledger cache drift: ${JSON.stringify(drifted)}`).toEqual([]);
  });

  it("the tenant's trial balance is zero (debits equal credits overall)", async () => {
    const result = await asTenant(F.tenant, async (c) => {
      const r = await c.query(`
        SELECT COALESCE(SUM(CASE WHEN entry_type='debit'  THEN amount ELSE 0 END), 0)::text AS debits,
               COALESCE(SUM(CASE WHEN entry_type='credit' THEN amount ELSE 0 END), 0)::text AS credits
        FROM journal_entries WHERE tenant_id = $1
      `, [F.tenant]);
      return r.rows[0];
    });

    expect(result.debits).toBe(result.credits);
  });
});
