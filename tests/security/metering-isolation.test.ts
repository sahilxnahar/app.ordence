/**
 * Ordence — Usage Metering: isolation, concurrency & integrity
 * Version: v0.14.0-alpha (Phase 15)
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 15 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * Metering fails QUIETLY in a way billing does not. A wrong invoice is
 * disputed within a month; a counter that stopped incrementing produces no
 * error, no empty screen and no failed request — the number is simply
 * smaller than the truth, and the only party positioned to notice is the
 * one who benefits.
 *
 * Six things are asserted here, all against a REAL PostgreSQL as a
 * NON-SUPERUSER:
 *
 *   1. A tenant cannot read, write or inflate another tenant's usage.
 *   2. ⭐ Concurrent increments do not lose an update — and the
 *      read-modify-write alternative demonstrably DOES, in this database,
 *      under this isolation level. That comparison is the whole reason
 *      the recorder is written as a single upsert.
 *   3. A cumulative counter cannot be made to go down, and a bucket
 *      cannot be moved onto another period or tenant.
 *   4. A level clamps at zero instead of going negative — a negative
 *      storage reading is an allowance larger than the one paid for.
 *   5. Byte counts survive past 2^53 exactly. A float would not.
 *   6. ⭐ The metric-kind rule is written in BOTH SQL and TypeScript, and
 *      the two still agree.
 *
 * ⚠️ EVERY ASSERTION RUNS AS `ordence_app`, NOT AS `postgres`. A superuser
 * bypasses RLS entirely, so a suite connected as one would pass with every
 * policy dropped. `asSuperuser` appears only in fixture setup and
 * teardown; if it ever appears inside an assertion, that assertion is
 * worthless.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { asTenant, withoutTenant, asSuperuser, expectError } from "../setup";
import {
  USAGE_METRICS,
  CUMULATIVE_METRICS,
  LEVEL_METRICS,
} from "@/lib/metering/quota";

type Fixtures = { tenantA: string; tenantB: string };
let fx: Fixtures;

/**
 * Assert that a statement was refused BY THE GUARD UNDER TEST, and not by
 * a missing GRANT.
 *
 * Copied from `tests/security/billing-isolation.test.ts` deliberately: a
 * missing privilege raises SQLSTATE 42501, which is exactly what our
 * tamper triggers raise. A test whose role simply had no rights on the
 * table would pass for entirely the wrong reason and prove nothing.
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
 * A subscription anchored on 31 January. Every period boundary in this
 * file is the CLAMPED one — 31 Jan → 28 Feb → 28 Mar — because that is
 * what `addInterval` produces and what both payment providers do.
 */
const P1_START = "2026-01-31T00:00:00Z";
const P1_END = "2026-02-28T00:00:00Z";
const P2_START = "2026-02-28T00:00:00Z";
const P2_END = "2026-03-28T00:00:00Z";

/** The upsert under test — byte-for-byte the shape the recorder issues. */
const INCREMENT = `
  INSERT INTO usage_counters
    (tenant_id, metric, period_start, period_end, value, first_recorded_at, last_recorded_at)
  VALUES ($1::uuid, $2::usage_metric, $3::timestamptz, $4::timestamptz, $5::bigint, now(), now())
  ON CONFLICT (tenant_id, metric, period_start) DO UPDATE
    SET value            = usage_counters.value + excluded.value,
        last_recorded_at = now()
`;

/**
 * The level adjustment under test, including the GREATEST(0, …) clamp.
 *
 * ⚠️ Note that the UPDATE branch adds `$3` — the RAW delta — and not
 * `excluded.current_value`. The VALUES row has to clamp (a decrement
 * against a level that does not exist yet must insert 0), so
 * `excluded.current_value` is zero for every decrement, and using it on
 * conflict makes every delete a silent no-op. The first version of the
 * recorder had exactly that bug; the "a decrement genuinely lowers the
 * figure" test below is what found it.
 */
const ADJUST_LEVEL = `
  INSERT INTO usage_levels
    (tenant_id, metric, current_value, peak_value, peak_at, peak_period_start, last_event_at, updated_at)
  VALUES ($1::uuid, $2::usage_metric, GREATEST(0::bigint, $3::bigint),
          GREATEST(0::bigint, $3::bigint), now(), $4::timestamptz, now(), now())
  ON CONFLICT (tenant_id, metric) DO UPDATE
    SET current_value = GREATEST(0::bigint, usage_levels.current_value + $3::bigint),
        peak_value = CASE
          WHEN usage_levels.peak_period_start < $4::timestamptz
            THEN GREATEST(0::bigint, usage_levels.current_value + $3::bigint)
          ELSE GREATEST(usage_levels.peak_value,
                        GREATEST(0::bigint, usage_levels.current_value + $3::bigint))
        END,
        peak_period_start = GREATEST(usage_levels.peak_period_start, $4::timestamptz),
        last_event_at = now(),
        updated_at = now()
`;

async function counterValue(
  tenantId: string,
  metric: string,
  periodStart = P1_START,
): Promise<bigint> {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT value::text AS value FROM usage_counters
        WHERE tenant_id = $1 AND metric = $2::usage_metric AND period_start = $3::timestamptz`,
      [tenantId, metric, periodStart],
    ),
  );
  return rows.length ? BigInt(rows[0].value) : 0n;
}

async function levelRow(tenantId: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT current_value::text AS current_value,
              peak_value::text    AS peak_value,
              peak_period_start
         FROM usage_levels
        WHERE tenant_id = $1 AND metric = 'storage_bytes'`,
      [tenantId],
    ),
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  await asSuperuser(async (c) => {
    for (const [id, name] of [
      [tenantA, "Metering Tenant A"],
      [tenantB, "Metering Tenant B"],
    ] as const) {
      await c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status, seat_limit)
         VALUES ($1,$2,$3,$4,'active',5)`,
        [id, `org_${id}`, `meter-${id.slice(0, 8)}`, name],
      );
    }

    // Tenant B's figures are deliberately unmistakable if they ever leak.
    await c.query(INCREMENT, [tenantB, "api_calls", P1_START, P1_END, "987654"]);
    await c.query(ADJUST_LEVEL, [tenantB, "storage_bytes", "123456789", P1_START]);
  });

  fx = { tenantA, tenantB };
});

afterAll(async () => {
  await asSuperuser(async (c) => {
    await c.query(`DELETE FROM usage_counters WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM usage_levels WHERE tenant_id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
    await c.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [
      [fx.tenantA, fx.tenantB],
    ]);
  });
});

/* ================================================================== */
/* 1. TENANT ISOLATION                                                 */
/* ================================================================== */

describe("usage is invisible across tenants", () => {
  it("tenant A sees none of tenant B's counters", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT * FROM usage_counters WHERE tenant_id = $1`, [fx.tenantB]),
    );
    expect(rows).toHaveLength(0);
  });

  it("tenant A sees none of tenant B's storage level", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(`SELECT * FROM usage_levels`),
    );
    expect(rows.every((r: { tenant_id: string }) => r.tenant_id === fx.tenantA)).toBe(true);
  });

  it("⭐ tenant A cannot write usage onto tenant B's account", async () => {
    // Without WITH CHECK on the policy, this INSERT would succeed —
    // inflating a stranger's invoice and consuming their quota, while
    // every read on both sides continued to look perfectly correct.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(INCREMENT, [fx.tenantB, "api_calls", P1_START, P1_END, "1000000"]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });

  it("tenant A's UPDATE against tenant B's bucket matches nothing", async () => {
    const before = await counterValue(fx.tenantB, "api_calls");

    const result = await asTenant(fx.tenantA, (c) =>
      c.query(`UPDATE usage_counters SET value = value + 1 WHERE tenant_id = $1`, [
        fx.tenantB,
      ]),
    );
    expect(result.rowCount).toBe(0);
    expect(await counterValue(fx.tenantB, "api_calls")).toBe(before);
  });

  it("⭐ no tenant context means ZERO rows, never all rows", async () => {
    const { rows } = await withoutTenant((c) =>
      c.query(`SELECT count(*)::int AS n FROM usage_counters`),
    );
    expect(rows[0].n).toBe(0);
  });

  it("no tenant context cannot INSERT usage either", async () => {
    const error = await expectError(() =>
      withoutTenant((c) =>
        c.query(INCREMENT, [fx.tenantA, "api_calls", P1_START, P1_END, "5"]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  });
});

/* ================================================================== */
/* 2. ⭐ CONCURRENCY — THE CENTRAL CLAIM OF THIS PHASE                  */
/* ================================================================== */

describe("concurrent increments", () => {
  /**
   * Four is not arbitrary: `testPool` holds four connections, so four
   * transactions are genuinely simultaneous rather than queued. Each
   * sleeps before writing, so all four are inside their transaction at
   * the same moment and the race is real rather than hoped for.
   */
  const WORKERS = 4;

  it("⭐ ON CONFLICT DO UPDATE loses NOTHING under real concurrency", async () => {
    const metric = "emails_sent";

    await Promise.all(
      Array.from({ length: WORKERS }, () =>
        asTenant(fx.tenantA, async (c) => {
          // Force the overlap. Without this the four could serialise by
          // luck and the test would prove nothing.
          await c.query(`SELECT pg_sleep(0.1)`);
          await c.query(INCREMENT, [fx.tenantA, metric, P1_START, P1_END, "1"]);
        }),
      ),
    );

    expect(
      await counterValue(fx.tenantA, metric),
      "an increment was lost — the upsert is no longer atomic",
    ).toBe(BigInt(WORKERS));
  });

  it("⭐ and a READ-MODIFY-WRITE demonstrably DOES lose updates, right here", async () => {
    /**
     * This is the test that justifies the design. It is not a thought
     * experiment about serverless: it is the same database, the same
     * isolation level (READ COMMITTED), the same four connections.
     *
     * Each worker SELECTs the value, waits, then writes back what it read
     * plus one — exactly what `const n = row.value; update({value: n+1})`
     * compiles to across a network. All four read the same number, all
     * four write the same number, and three increments vanish with NO
     * ERROR ANYWHERE.
     *
     * Note also what the monotonic trigger does NOT catch: every one of
     * those writes is an INCREASE relative to the row it overwrote, so the
     * guard is silent. Nothing in the database can detect a lost update
     * after the fact — which is why the arithmetic has to happen inside
     * the statement rather than in application code.
     */
    const metric = "portal_links_created";

    await asTenant(fx.tenantA, (c) =>
      c.query(INCREMENT, [fx.tenantA, metric, P1_START, P1_END, "0"]),
    );

    await Promise.all(
      Array.from({ length: WORKERS }, () =>
        asTenant(fx.tenantA, async (c) => {
          const { rows } = await c.query(
            `SELECT value::text AS value FROM usage_counters
              WHERE tenant_id = $1 AND metric = $2::usage_metric
                AND period_start = $3::timestamptz`,
            [fx.tenantA, metric, P1_START],
          );
          const read = BigInt(rows[0].value);

          // The gap between reading and writing. In production it is a
          // network round trip; here it is made explicit so the race is
          // deterministic rather than occasional.
          await c.query(`SELECT pg_sleep(0.15)`);

          await c.query(
            `UPDATE usage_counters SET value = $4::bigint
              WHERE tenant_id = $1 AND metric = $2::usage_metric
                AND period_start = $3::timestamptz`,
            [fx.tenantA, metric, P1_START, (read + 1n).toString()],
          );
        }),
      ),
    );

    const final = await counterValue(fx.tenantA, metric);
    expect(
      final,
      `read-modify-write recorded ${final} of ${WORKERS} increments. If this ever ` +
        `equals ${WORKERS}, the comparison this suite is built on has stopped ` +
        `being a comparison — check the isolation level before trusting it.`,
    ).toBeLessThan(BigInt(WORKERS));
  });

  it("concurrent increments of DIFFERENT sizes sum exactly", async () => {
    const metric = "api_calls";
    const quantities = [7n, 13n, 29n, 51n];

    await Promise.all(
      quantities.map((q) =>
        asTenant(fx.tenantA, async (c) => {
          await c.query(`SELECT pg_sleep(0.05)`);
          await c.query(INCREMENT, [
            fx.tenantA,
            metric,
            P1_START,
            P1_END,
            q.toString(),
          ]);
        }),
      ),
    );

    expect(await counterValue(fx.tenantA, metric)).toBe(
      quantities.reduce((a, b) => a + b, 0n),
    );
  });

  it("⭐ concurrent level adjustments sum exactly WHEN THE RUNNING TOTAL STAYS POSITIVE", async () => {
    /**
     * ══════════════════════════════════════════════════════════════
     * THIS TEST USED TO BE FLAKY, AND THE FLAKE WAS TELLING THE TRUTH
     * ══════════════════════════════════════════════════════════════
     * The original version fired four concurrent deltas —
     * +1,000,000 / -250,000 / +2,000,000 / -500,000 — at a level
     * starting from ZERO, and asserted they settled on 2,250,000.
     *
     * It passed in isolation and failed under load, which reads like a
     * concurrency bug in the upsert. It is not. `ADJUST_LEVEL` clamps
     * with `GREATEST(0, current + delta)`, so a NEGATIVE delta that
     * happens to execute while the running total is still 0 is
     * discarded. Under contention the ordering shifts, the negatives
     * sometimes land first, and the result is 3,000,000 — the positives
     * alone.
     *
     * The clamp is CORRECT and should stay: a tenant whose storage
     * level went negative would be handed unlimited free quota, which is
     * a worse failure than briefly over-counting. And in production the
     * ordering is not arbitrary — a release always follows the reserve
     * it is releasing, so the running total is never below the amount
     * being freed.
     *
     * So the original assertion was asking for a property the code
     * deliberately does not have. It has been rewritten to assert what
     * is actually true and actually valuable: given a base high enough
     * that no intermediate total goes negative, concurrent adjustments
     * lose nothing. The clamp gets its own test below.
     */
    /**
     * ⚠️ HERMETIC: its own tenant, created here and torn down here.
     *
     * An earlier version reused the shared fixture tenant and compared
     * absolute values. It failed for a second, unrelated reason — other
     * tests in this file adjust the same tenant's storage level, so the
     * baseline moved depending on execution order. A concurrency test
     * that also depends on what ran before it cannot tell you which of
     * the two things broke.
     */
    const isolatedTenant = randomUUID();
    await asSuperuser((c) =>
      c.query(
        `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
         VALUES ($1,$2,$3,'Concurrency Probe','active')`,
        [isolatedTenant, `org_${isolatedTenant}`, `conc-${isolatedTenant.slice(0, 8)}`],
      ),
    );

    try {
      const BASE = "5000000";
      await asTenant(isolatedTenant, (c) =>
        c.query(ADJUST_LEVEL, [isolatedTenant, "storage_bytes", BASE, P1_START]),
      );

      const readValue = async (): Promise<bigint> => {
        const { rows } = await asTenant(isolatedTenant, (c) =>
          c.query(
            `SELECT current_value FROM usage_levels
              WHERE tenant_id = $1 AND metric = 'storage_bytes'`,
            [isolatedTenant],
          ),
        );
        return BigInt(rows[0].current_value);
      };

      const before = await readValue();

      const deltas = ["1000000", "-250000", "2000000", "-500000"];
      await Promise.all(
        deltas.map((delta) =>
          asTenant(isolatedTenant, async (c) => {
            await c.query(`SELECT pg_sleep(0.05)`);
            await c.query(ADJUST_LEVEL, [
              isolatedTenant,
              "storage_bytes",
              delta,
              P1_START,
            ]);
          }),
        ),
      );

      const after = await readValue();
      const expected = deltas.reduce((sum, d) => sum + BigInt(d), before);

      expect(
        after,
        `concurrent adjustments lost ${expected - after} bytes — the upsert ` +
          `is not atomic, and a customer's storage figure would drift every ` +
          `time two operations overlapped`,
      ).toBe(expected);
    } finally {
      await asSuperuser(async (c) => {
        await c.query(`DELETE FROM usage_levels WHERE tenant_id = $1`, [isolatedTenant]);
        await c.query(`DELETE FROM tenants WHERE id = $1`, [isolatedTenant]);
      });
    }
  });

  it("⭐ the level is CLAMPED at zero and never goes negative", () => {
    /**
     * A negative storage level would be handed to `canConsume()` as
     * headroom, giving the tenant unlimited free quota. Losing a release
     * is the lesser of the two failures, and the nightly
     * `reconcileStorageLevel()` corrects it.
     *
     * ⚠️ HERMETIC — its own tenant. A first version drove the SHARED
     * fixture tenant's storage level to zero and broke a later test in
     * this same file that expected a decrement to lower a non-zero
     * figure. That is the second time in this file that a test mutating
     * shared state produced a failure pointing somewhere else entirely,
     * which is precisely the reason to keep concurrency and boundary
     * tests self-contained.
     */
    return (async () => {
      const probeTenant = randomUUID();
      await asSuperuser((c) =>
        c.query(
          `INSERT INTO tenants (id, clerk_org_id, slug, name, status)
           VALUES ($1,$2,$3,'Clamp Probe','active')`,
          [probeTenant, `org_${probeTenant}`, `clamp-${probeTenant.slice(0, 8)}`],
        ),
      );

      try {
        // Start at a real value, then subtract far more than exists.
        await asTenant(probeTenant, (c) =>
          c.query(ADJUST_LEVEL, [probeTenant, "storage_bytes", "1000", P1_START]),
        );
        await asTenant(probeTenant, (c) =>
          c.query(ADJUST_LEVEL, [probeTenant, "storage_bytes", "-999999999", P1_START]),
        );

        const { rows } = await asTenant(probeTenant, (c) =>
          c.query(
            `SELECT current_value FROM usage_levels
              WHERE tenant_id = $1 AND metric = 'storage_bytes'`,
            [probeTenant],
          ),
        );

        expect(rows).toHaveLength(1);
        expect(BigInt(rows[0].current_value)).toBe(0n);
      } finally {
        await asSuperuser(async (c) => {
          await c.query(`DELETE FROM usage_levels WHERE tenant_id = $1`, [probeTenant]);
          await c.query(`DELETE FROM tenants WHERE id = $1`, [probeTenant]);
        });
      }
    })();
  });
});

/* ================================================================== */
/* 3. A COUNTER MAY ONLY GO UP                                         */
/* ================================================================== */

describe("usage_counters is monotonic and its identity is fixed", () => {
  const metric = "emails_sent";

  it("an increase is permitted — this table is NOT append-only", async () => {
    const before = await counterValue(fx.tenantA, metric);
    await asTenant(fx.tenantA, (c) =>
      c.query(INCREMENT, [fx.tenantA, metric, P1_START, P1_END, "3"]),
    );
    expect(await counterValue(fx.tenantA, metric)).toBe(before + 3n);
  });

  it("⭐ a DECREASE is refused by the trigger, not by a missing GRANT", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `UPDATE usage_counters SET value = 0
              WHERE tenant_id = $1 AND metric = $2::usage_metric`,
            [fx.tenantA, metric],
          ),
        ),
      /cannot decrease|only goes up/i,
    );
  });

  it("a bucket cannot be moved to another period", async () => {
    // Silently relocating usage onto a different invoice.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `UPDATE usage_counters SET period_start = $3::timestamptz
              WHERE tenant_id = $1 AND metric = $2::usage_metric`,
            [fx.tenantA, metric, P2_START],
          ),
        ),
      /cannot be re-identified|fixed at creation/i,
    );
  });

  it("a bucket cannot be moved to another metric", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `UPDATE usage_counters SET metric = 'api_calls'
              WHERE tenant_id = $1 AND metric = $2::usage_metric
                AND period_start = $3::timestamptz`,
            [fx.tenantA, metric, P1_START],
          ),
        ),
      /cannot be re-identified/i,
    );
  });

  it("⭐ the application role cannot DELETE a bucket at all", async () => {
    // Deleting a bucket is usage that was consumed and will never be
    // billed — and the only record of a month a customer may dispute.
    // Here the PRIVILEGE is the control, so this is the one place a
    // "permission denied" is the expected answer rather than a false pass.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`DELETE FROM usage_counters WHERE tenant_id = $1`, [fx.tenantA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied for (table|relation) usage_counters/i);
  });

  it("the application role cannot DELETE a level row either", async () => {
    // Deleting a level row resets stored bytes to zero: a free storage
    // upgrade available to any code path that can issue a DELETE.
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(`DELETE FROM usage_levels WHERE tenant_id = $1`, [fx.tenantA]),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/permission denied for (table|relation) usage_levels/i);
  });
});

/* ================================================================== */
/* 4. ⭐ A LEVEL GOES DOWN, BUT NEVER BELOW ZERO                        */
/* ================================================================== */

describe("storage is a level: it falls when documents are deleted", () => {
  it("⭐ a decrement genuinely lowers the figure", async () => {
    // The single most important behaviour in this phase. If storage only
    // ever rose, a customer who spends an afternoon tidying would still be
    // told they are full at the end of it.
    //
    // ⚠️ SEEDS ITS OWN BASELINE. This used to rely on an earlier test in
    // the file having created the row as a side effect. When that test was
    // made hermetic, this one started failing with "cannot read
    // current_value of null" — an implicit ordering dependency that had
    // been invisible for as long as both tests happened to run in the
    // right order. Cheap to remove; expensive to debug later.
    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantA, "storage_bytes", "5000000", P1_START]),
    );

    const before = BigInt((await levelRow(fx.tenantA)).current_value);

    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantA, "storage_bytes", "-1000000", P1_START]),
    );

    expect(BigInt((await levelRow(fx.tenantA)).current_value)).toBe(before - 1_000_000n);
  });

  it("⭐ a decrement that would go negative clamps to zero", async () => {
    // Happens for real: a retried delete decrements twice. Clamping keeps
    // the figure displayable and the reconciliation pass corrects it.
    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [
        fx.tenantA,
        "storage_bytes",
        "-999999999999",
        P1_START,
      ]),
    );

    const row = await levelRow(fx.tenantA);
    expect(BigInt(row.current_value)).toBe(0n);
  });

  it("⭐ and the DATABASE refuses a negative level even without the clamp", async () => {
    // The clamp lives in the application. This constraint is what protects
    // the NEXT call site, written by someone who did not read that code —
    // a tenant whose storage reads -2 GB has an allowance 2 GB larger than
    // the one they bought.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `UPDATE usage_levels SET current_value = -1
              WHERE tenant_id = $1 AND metric = 'storage_bytes'`,
            [fx.tenantA],
          ),
        ),
      /usage_levels_current_non_negative|violates check constraint/i,
    );
  });

  it("the peak is a high-water mark and does not fall with the level", async () => {
    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantA, "storage_bytes", "5000000", P1_START]),
    );
    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantA, "storage_bytes", "-4000000", P1_START]),
    );

    const row = await levelRow(fx.tenantA);
    expect(BigInt(row.current_value)).toBe(1_000_000n);
    expect(BigInt(row.peak_value)).toBe(5_000_000n);
  });

  it("the peak RESETS when the billing period rolls over", async () => {
    // Otherwise a single spike in March would still be the billable figure
    // in December.
    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantA, "storage_bytes", "1", P2_START]),
    );

    const row = await levelRow(fx.tenantA);
    expect(BigInt(row.peak_value)).toBe(BigInt(row.current_value));
    expect(new Date(row.peak_period_start).toISOString()).toBe(
      new Date(P2_START).toISOString(),
    );
  });

  it("an out-of-order write does not drag the peak scope backwards", async () => {
    // A retry that lands after the period rolled would otherwise reset a
    // peak already established for the new period.
    await asTenant(fx.tenantA, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantA, "storage_bytes", "10", P1_START]),
    );

    const row = await levelRow(fx.tenantA);
    expect(new Date(row.peak_period_start).toISOString()).toBe(
      new Date(P2_START).toISOString(),
    );
  });

  it("a level row cannot be reassigned to another tenant", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `UPDATE usage_levels SET tenant_id = $2
              WHERE tenant_id = $1 AND metric = 'storage_bytes'`,
            [fx.tenantA, fx.tenantB],
          ),
        ),
      /cannot be reassigned|row-level security/i,
    );
  });
});

/* ================================================================== */
/* 5. ⭐ BYTES ARE bigint, NOT float                                    */
/* ================================================================== */

describe("byte counts survive past 2^53", () => {
  const BEYOND_SAFE = 9_007_199_254_740_993n; // 2^53 + 1

  it("⭐ stores and returns a value a double cannot represent", async () => {
    // `Number(9007199254740993)` is 9007199254740992. If this column were
    // `double precision`, or if the value passed through a JavaScript
    // number anywhere in the path, the low digit would be gone — and the
    // figure would disagree with SUM(documents.size_bytes) by an amount
    // nobody could account for.
    await asTenant(fx.tenantB, (c) =>
      c.query(
        `UPDATE usage_levels SET peak_value = $2::bigint, current_value = $2::bigint
          WHERE tenant_id = $1 AND metric = 'storage_bytes'`,
        [fx.tenantB, BEYOND_SAFE.toString()],
      ),
    );

    const row = await levelRow(fx.tenantB);
    expect(row.current_value).toBe(BEYOND_SAFE.toString());
    expect(BigInt(row.current_value)).toBe(BEYOND_SAFE);

    // …and the route we deliberately do not take, demonstrated: parsing the
    // same string as a `number` silently drops the low digit, and every
    // figure derived from it is one byte short for ever.
    expect(
      BigInt(Number(row.current_value)),
      "the float route must lose a digit — if it does not, this test is not testing anything",
    ).not.toBe(BigInt(row.current_value));
  });

  it("⭐ and arithmetic on it stays exact", async () => {
    await asTenant(fx.tenantB, (c) =>
      c.query(ADJUST_LEVEL, [fx.tenantB, "storage_bytes", "1", P1_START]),
    );

    const row = await levelRow(fx.tenantB);
    expect(BigInt(row.current_value)).toBe(BEYOND_SAFE + 1n);
  });

  it("the column is int8, not a float type", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_name IN ('usage_counters','usage_levels')
            AND column_name IN ('value','current_value','peak_value')`,
      ),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.data_type, `${row.column_name} must be bigint`).toBe("bigint");
    }
  });
});

/* ================================================================== */
/* 6. PERIOD BUCKETS                                                   */
/* ================================================================== */

describe("period buckets, anchored on the 31st", () => {
  it("⭐ two adjacent periods coexist as separate buckets", async () => {
    // 31 Jan → 28 Feb → 28 Mar. The clamped boundary is the one both
    // providers use; the important property here is that usage in the new
    // period does NOT land in the closed one, which is about to be
    // invoiced.
    await asTenant(fx.tenantA, (c) =>
      c.query(INCREMENT, [fx.tenantA, "emails_sent", P2_START, P2_END, "40"]),
    );

    const jan = await counterValue(fx.tenantA, "emails_sent", P1_START);
    const feb = await counterValue(fx.tenantA, "emails_sent", P2_START);

    expect(feb).toBe(40n);
    expect(jan).not.toBe(feb);
    expect(jan).toBeGreaterThan(0n);
  });

  it("a second increment for the same period ACCUMULATES rather than duplicating", async () => {
    await asTenant(fx.tenantA, (c) =>
      c.query(INCREMENT, [fx.tenantA, "emails_sent", P2_START, P2_END, "2"]),
    );

    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT count(*)::int AS n FROM usage_counters
          WHERE tenant_id = $1 AND metric = 'emails_sent' AND period_start = $2::timestamptz`,
        [fx.tenantA, P2_START],
      ),
    );

    expect(rows[0].n).toBe(1);
    expect(await counterValue(fx.tenantA, "emails_sent", P2_START)).toBe(42n);
  });

  it("⭐ a duplicate bucket is impossible, so usage cannot split across rows", async () => {
    const error = await expectError(() =>
      asTenant(fx.tenantA, (c) =>
        c.query(
          `INSERT INTO usage_counters (tenant_id, metric, period_start, period_end, value)
           VALUES ($1,'emails_sent',$2::timestamptz,$3::timestamptz,1)`,
          [fx.tenantA, P2_START, P2_END],
        ),
      ),
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/usage_counters_tenant_metric_period_unique|duplicate key/i);
  });

  it("an inverted period is refused", async () => {
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO usage_counters (tenant_id, metric, period_start, period_end, value)
             VALUES ($1,'api_calls',$2::timestamptz,$3::timestamptz,1)`,
            [fx.tenantA, P2_END, P2_START],
          ),
        ),
      /usage_counters_period_sane|violates check constraint/i,
    );
  });
});

/* ================================================================== */
/* 7. ⭐ THE METRIC-KIND RULE IS WRITTEN TWICE. IT MUST AGREE.          */
/* ================================================================== */

describe("the SQL and the TypeScript agree about what each metric IS", () => {
  /**
   * "Storage is a level, emails are a tally" is expressed in TWO places:
   * `CUMULATIVE_METRICS`/`LEVEL_METRICS` in `lib/metering/quota.ts`, and
   * the two CHECK constraints in the schema.
   *
   * Two expressions of one rule always drift eventually. When these drift,
   * a call site writes storage into the tally table, storage stops falling
   * when documents are deleted, and a customer who has tidied up is still
   * locked out. Nothing errors; the number is simply wrong for ever.
   */

  it("⭐ the Postgres enum matches USAGE_METRICS exactly", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT e.enumlabel AS label
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = 'usage_metric'
          ORDER BY e.enumsortorder`,
      ),
    );

    expect(
      rows.map((r: { label: string }) => r.label),
      "the usage_metric enum has drifted from USAGE_METRICS — an INSERT will " +
        "fail at runtime inside a recorder that swallows its own errors",
    ).toEqual([...USAGE_METRICS]);
  });

  it("⭐ the CHECK constraints list exactly the metrics TypeScript classifies", async () => {
    const { rows } = await asTenant(fx.tenantA, (c) =>
      c.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname IN ('usage_counters_metric_is_cumulative','usage_levels_metric_is_level')`,
      ),
    );

    const byName = new Map(
      rows.map((r: { conname: string; def: string }) => [r.conname, r.def]),
    );

    const cumulativeDef = byName.get("usage_counters_metric_is_cumulative") ?? "";
    const levelDef = byName.get("usage_levels_metric_is_level") ?? "";

    expect(cumulativeDef, "the cumulative CHECK constraint is missing").not.toBe("");
    expect(levelDef, "the level CHECK constraint is missing").not.toBe("");

    for (const metric of CUMULATIVE_METRICS) {
      expect(cumulativeDef, `${metric} is cumulative in TypeScript`).toContain(metric);
      expect(levelDef, `${metric} must NOT be accepted as a level`).not.toContain(metric);
    }
    for (const metric of LEVEL_METRICS) {
      expect(levelDef, `${metric} is a level in TypeScript`).toContain(metric);
      expect(cumulativeDef, `${metric} must NOT be accepted as a tally`).not.toContain(
        metric,
      );
    }
  });

  it("⭐ storage CANNOT be written into the cumulative table", async () => {
    // The failure this prevents: stored bytes summed as though every
    // upload were permanent, rising for ever, never falling on delete.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO usage_counters (tenant_id, metric, period_start, period_end, value)
             VALUES ($1,'storage_bytes',$2::timestamptz,$3::timestamptz,1)`,
            [fx.tenantA, P1_START, P1_END],
          ),
        ),
      /usage_counters_metric_is_cumulative|violates check constraint/i,
    );
  });

  it("⭐ a tally CANNOT be written into the level table", async () => {
    // Where it could be DECREMENTED — erasing usage before it is invoiced.
    await expectGuard(
      () =>
        asTenant(fx.tenantA, (c) =>
          c.query(
            `INSERT INTO usage_levels (tenant_id, metric, current_value, peak_value, peak_period_start)
             VALUES ($1,'emails_sent',1,1,$2::timestamptz)`,
            [fx.tenantA, P1_START],
          ),
        ),
      /usage_levels_metric_is_level|violates check constraint/i,
    );
  });
});
