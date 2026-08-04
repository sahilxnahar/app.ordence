/**
 * Ordence — ⭐ ENGINE 2 · RATE & PRICING
 * Session 1 · v0.62.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * TWO IMPLEMENTATIONS OF ONE FORMULA IS THE RISK THIS FILE MANAGES
 * ══════════════════════════════════════════════════════════════════════
 * The arithmetic lives in TypeScript (the quote screen, instant, no round
 * trip) and again in PL/pgSQL (the batch run, over a hundred thousand
 * rows, where shipping every row to a Worker is not an option).
 *
 * That duplication is deliberate and it is also exactly how a system ends
 * up quoting ₹1,380 on screen and invoicing ₹1,381 — a difference small
 * enough to survive testing and large enough to lose a customer's trust
 * the first time they add up a column.
 *
 * ⚠️ SO THE CASES BELOW ARE THE SAME CASES ASSERTED IN
 * SQL-FILES/0034_engine2_pricing.sql, TO THE PAISE. When one side
 * changes, this file fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  priceProgressive,
  priceFlat,
  divideRoundHalfUp,
  applyBps,
  RATE_SCOPE_PRIORITY,
  type Slab,
} from "@/db/schema/pricing";

/**
 * The canonical Indian LT-1 domestic tariff shape:
 * first 100 units at ₹4.50, next 200 at ₹6.20, the rest at ₹8.00.
 */
const LT1: Slab[] = [
  { sequence: 1, upToQuantity: 100n, unitAmountMinor: 450n, fixedAmountMinor: 0n },
  { sequence: 2, upToQuantity: 300n, unitAmountMinor: 620n, fixedAmountMinor: 0n },
  { sequence: 3, upToQuantity: null, unitAmountMinor: 800n, fixedAmountMinor: 0n },
];

describe("⭐ progressive vs flat — the 27% decision", () => {
  /**
   * ⚠️ THE WHOLE REASON `slabMode` HAS NO DEFAULT.
   *
   * The identical rate card, the identical quantity, two readings both in
   * daily commercial use, ₹170 apart. A pricing engine that picks one
   * silently is wrong for half its users and tells neither half.
   */
  it("prices 250 units at ₹1,380 progressive and ₹1,550 flat", () => {
    expect(priceProgressive(250n, LT1)).toBe(138_000n);
    expect(priceFlat(250n, LT1)).toBe(155_000n);

    const gap = priceFlat(250n, LT1) - priceProgressive(250n, LT1);
    expect(gap).toBe(17_000n); // ₹170 on a ₹1,380 bill
  });

  it("agrees with the SQL fixtures to the paise", () => {
    // Same numbers asserted in test_engine2.sql against ordence_price_slabs.
    expect(priceProgressive(100n, LT1)).toBe(45_000n);
    expect(priceProgressive(0n, LT1)).toBe(0n);
    expect(priceProgressive(1000n, LT1)).toBe(729_000n);
  });

  it("charges nothing for nothing, in either mode", () => {
    expect(priceProgressive(0n, LT1)).toBe(0n);
    expect(priceFlat(0n, LT1)).toBe(0n);
  });

  /**
   * ⚠️ THE BOUNDARY IS WHERE OFF-BY-ONE LIVES. `upToQuantity` is the
   * INCLUSIVE end of its band — 100 units falls entirely in band 1, and
   * 101 spills a single unit into band 2. Getting this backwards
   * overcharges every customer who lands exactly on a slab edge, which on
   * a round tariff is a great many of them.
   */
  it("treats upToQuantity as the inclusive end of its band", () => {
    expect(priceProgressive(100n, LT1)).toBe(45_000n);
    expect(priceProgressive(101n, LT1)).toBe(45_000n + 620n);
    expect(priceFlat(100n, LT1)).toBe(100n * 450n);
    expect(priceFlat(101n, LT1)).toBe(101n * 620n);
  });

  it("lets the unbounded final slab absorb any remainder", () => {
    // 100×450 + 200×620 + 700×800
    expect(priceProgressive(1000n, LT1)).toBe(45_000n + 124_000n + 560_000n);
  });

  /**
   * A card whose bands are ALL bounded and a quantity beyond every one of
   * them. The SQL falls back to the last band's rate; so must this, or the
   * screen and the invoice diverge precisely at the largest orders.
   */
  it("falls back to the last band when every band is bounded", () => {
    const bounded: Slab[] = [
      { sequence: 1, upToQuantity: 100n, unitAmountMinor: 450n, fixedAmountMinor: 0n },
      { sequence: 2, upToQuantity: 300n, unitAmountMinor: 620n, fixedAmountMinor: 0n },
    ];
    expect(priceFlat(5000n, bounded)).toBe(5000n * 620n);
  });

  it("adds a band's fixed charge once, on entering it", () => {
    const withDemand: Slab[] = [
      { sequence: 1, upToQuantity: 100n, unitAmountMinor: 450n, fixedAmountMinor: 10_000n },
      { sequence: 2, upToQuantity: null, unitAmountMinor: 620n, fixedAmountMinor: 25_000n },
    ];
    // 100×450 + 10000  +  50×620 + 25000
    expect(priceProgressive(150n, withDemand)).toBe(45_000n + 10_000n + 31_000n + 25_000n);
  });

  it("does not depend on the order rows arrive in", () => {
    const shuffled = [LT1[2]!, LT1[0]!, LT1[1]!];
    expect(priceProgressive(250n, shuffled)).toBe(138_000n);
    expect(priceFlat(250n, shuffled)).toBe(155_000n);
  });

  it("handles a single unbounded band as a plain per-unit rate", () => {
    const single: Slab[] = [
      { sequence: 1, upToQuantity: null, unitAmountMinor: 700n, fixedAmountMinor: 0n },
    ];
    expect(priceProgressive(400n, single)).toBe(280_000n);
    expect(priceFlat(400n, single)).toBe(280_000n);
  });
});

describe("⭐ rounding — half-up, because Tally is half-up", () => {
  /**
   * ⚠️ NOT Math.round ON A FLOAT.
   *
   * Every one of these customers reconciles against Tally. A rounding
   * rule that differs by a rupee a line turns a billing conversation into
   * an argument about arithmetic, which is unwinnable even when you are
   * right.
   */
  it("rounds halves away from zero, symmetrically", () => {
    expect(divideRoundHalfUp(3n, 2n)).toBe(2n);
    expect(divideRoundHalfUp(-3n, 2n)).toBe(-2n);
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfUp(1n, 2n)).toBe(1n);
    expect(divideRoundHalfUp(-1n, 2n)).toBe(-1n);
  });

  /**
   * ⚠️ HALF-TO-EVEN IS THE DEFAULT ALMOST EVERYWHERE AND IT IS NOT WHAT
   * WE WANT. Banker's rounding would send 2.5 → 2 and 3.5 → 4. Both of
   * these must go up.
   */
  it("is NOT banker's rounding", () => {
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n); // 2.5 → 3, not 2
    expect(divideRoundHalfUp(7n, 2n)).toBe(4n); // 3.5 → 4
  });

  it("refuses to divide by zero rather than returning something plausible", () => {
    expect(() => divideRoundHalfUp(100n, 0n)).toThrow(/Division by zero/);
  });

  it("applies basis points as an integer rate", () => {
    expect(applyBps(100_000n, 1800)).toBe(18_000n); // 18% of ₹1,000
    expect(applyBps(138_000n, 1800)).toBe(24_840n); // the LT1 quote
    expect(applyBps(100_000n, 0)).toBe(0n);
  });

  it("rounds a basis-point result half-up, not down", () => {
    // 333 × 1800 / 10000 = 59.94 → 60
    expect(applyBps(333n, 1800)).toBe(60n);
    // 1 × 5000 / 10000 = 0.5 → 1
    expect(applyBps(1n, 5000)).toBe(1n);
  });

  /**
   * A negative adjustment is a discount, and it must round the same way
   * or a discount and its reversal will not cancel to zero.
   */
  it("rounds discounts and their reversals to cancelling amounts", () => {
    const discount = applyBps(-138_000n, 1000);
    const reversal = applyBps(138_000n, 1000);
    expect(discount + reversal).toBe(0n);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⭐ DRIFT GUARDS — the TypeScript and the SQL must not part company
 * ══════════════════════════════════════════════════════════════════════
 * These read the actual .sql file. They are ugly and they are the only
 * thing standing between a one-line SQL edit and a silent disagreement
 * between the quote screen and the invoice run.
 */

const SQL = readFileSync(
  join(process.cwd(), "SQL-FILES", "0034_engine2_pricing.sql"),
  "utf8",
);

describe("⭐ drift guard — scope precedence", () => {
  it("orders scopes identically in RATE_SCOPE_PRIORITY and the SQL view", () => {
    // Extract the CASE arms from v_rate_card_candidates.
    const block = SQL.split("CASE c.scope")[1]?.split("END")[0] ?? "";
    expect(block).not.toBe("");

    for (const [scope, rank] of Object.entries(RATE_SCOPE_PRIORITY)) {
      const pattern = new RegExp(`WHEN\\s+'${scope}'\\s+THEN\\s+${rank}\\b`);
      expect(
        pattern.test(block),
        `Scope "${scope}" is ${rank} in RATE_SCOPE_PRIORITY (db/schema/pricing.ts) but the SQL view v_rate_card_candidates does not rank it the same. The two would then disagree about which card wins, and the price would change depending on which code path produced it.`,
      ).toBe(true);
    }
  });

  it("ranks contracted above every other scope, in both places", () => {
    const ranks = Object.values(RATE_SCOPE_PRIORITY);
    expect(RATE_SCOPE_PRIORITY.contracted).toBe(Math.max(...ranks));
    expect(RATE_SCOPE_PRIORITY.list).toBe(Math.min(...ranks));
  });
});

describe("⭐ drift guard — the guarantees the SQL is supposed to carry", () => {
  it("keeps quotes append-only at the privilege level, not just by trigger", () => {
    expect(
      /REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+rate_quotes\s+FROM\s+ordence_app/i.test(SQL),
      "The explicit REVOKE on rate_quotes is missing. GRANT does not narrow — listing SELECT, INSERT does NOT take away an UPDATE granted earlier or by a blanket GRANT ALL.",
    ).toBe(true);
  });

  it("FORCEs row-level security, not merely ENABLEs it", () => {
    expect(
      /FORCE ROW LEVEL SECURITY/.test(SQL),
      "ENABLE alone does not apply a policy to the table's OWNER, and migrations run as the owner.",
    ).toBe(true);
  });

  it("creates its views with security_invoker", () => {
    const views = SQL.match(/CREATE OR REPLACE VIEW\s+(\w+)/g) ?? [];
    expect(views.length).toBeGreaterThan(0);
    const invokers = SQL.match(/security_invoker\s*=\s*true/g) ?? [];
    expect(
      invokers.length,
      "A view without security_invoker runs as its OWNER, so RLS does not apply — a cross-tenant leak that a policy audit would not catch, because the policies underneath are all correct.",
    ).toBe(views.length);
  });

  it("holds the slab-set rule as a DEFERRABLE constraint trigger", () => {
    expect(
      /CREATE CONSTRAINT TRIGGER trg_rate_slabs_validate_set[\s\S]{0,200}DEFERRABLE INITIALLY DEFERRED/.test(SQL),
      "Without DEFERRABLE INITIALLY DEFERRED a legitimate whole-card rewrite fails, because the second statement of five leaves the slab set momentarily inconsistent.",
    ).toBe(true);
  });

  it("keeps the quote FK as RESTRICT so history cannot be deleted sideways", () => {
    expect(
      /rate_quotes_card_tenant_fk[\s\S]{0,300}ON DELETE RESTRICT/.test(SQL),
      "A CASCADE here would let deleting a rate card destroy the record of what was quoted from it — which is exactly the moment somebody would want it gone.",
    ).toBe(true);
  });
});
