/**
 * Ordence — ⭐ ENGINE 5 · UTILITY METERING
 * Session 1 · v0.63.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE BRANCH IN THIS ENGINE IS WORTH MORE THAN ALL THE OTHERS
 * ══════════════════════════════════════════════════════════════════════
 * A meter reads 99999 one month and 00042 the next. Consumption is 43
 * units. Subtract naively and you get −99,957 — and a billing system that
 * accepts a negative consumption issues a credit note for roughly a
 * year of free supply, automatically, to whoever happens to be on that
 * meter that month.
 *
 * That is not a hypothetical. Every utility billing system has this bug
 * once. The tests below exist so this one has it zero times.
 *
 * ⚠️ NOT tests/ui/metering.test.tsx — that one covers Phase 15's SaaS
 * usage counters. Two different things called metering; deliberately
 * different file names.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  consumptionBetween,
  ANOMALY_HIGH_MULTIPLIER,
  ANOMALY_LOW_MULTIPLIER,
  ANOMALY_LOOKBACK,
  ACTUAL_READING_SOURCES,
} from "@/db/schema/utility-meters";

describe("⭐ the rollover branch", () => {
  it("reads 99999 → 00042 on a 5-digit dial as 43 units, not −99,957", () => {
    const r = consumptionBetween(99_999, 42, 5);
    expect(r.consumption).toBe(43);
    expect(r.isRollover).toBe(true);
  });

  it("agrees with the SQL fixture on the mid-wrap case", () => {
    // 99900 → 42 on 5 digits: 100 units to the wrap, then 42. Asserted
    // identically against ordence_meter_consumption() in test_engine5.sql.
    const r = consumptionBetween(99_900, 42, 5);
    expect(r.consumption).toBe(142);
    expect(r.isRollover).toBe(true);
  });

  it("does not invent a rollover on an ordinary increase", () => {
    const r = consumptionBetween(1500, 1760, 6);
    expect(r.consumption).toBe(260);
    expect(r.isRollover).toBe(false);
  });

  it("reports zero, not a wrap, when the dial has not moved", () => {
    const r = consumptionBetween(4200, 4200, 6);
    expect(r.consumption).toBe(0);
    expect(r.isRollover).toBe(false);
  });

  /**
   * ⚠️ THE CEILING IS PER-METER. A 5-digit meter wraps at 100000 and a
   * 6-digit one at 1000000. Assuming a fixed width bills the wrap ten
   * times over — or a tenth of it — depending on which way the guess went.
   */
  it("wraps at the ceiling of THIS meter's digit count", () => {
    expect(consumptionBetween(99_999, 42, 5).consumption).toBe(43);
    expect(consumptionBetween(99_999, 42, 6).consumption).toBe(900_043);
    expect(consumptionBetween(999_999, 42, 6).consumption).toBe(43);
  });

  it("applies the meter multiplier after the wrap arithmetic, not before", () => {
    const r = consumptionBetween(99_999, 42, 5, 10);
    expect(r.consumption).toBe(430);
  });

  it("applies the multiplier on an ordinary reading too", () => {
    expect(consumptionBetween(100, 150, 6, 10).consumption).toBe(500);
    expect(consumptionBetween(100, 150, 6).consumption).toBe(50);
  });

  /**
   * ⚠️ THE FUNCTION IS DELIBERATELY NOT THE JUDGE OF PLAUSIBILITY.
   *
   * 4000 → 40 is arithmetically a wrap and produces 996,040 units, which
   * is obviously a transposed digit. This function still returns it —
   * because deciding is the trigger's job, and it needs the meter's
   * history to decide. Splitting the two keeps the arithmetic pure and
   * testable; the SQL drift guard below asserts the trigger does its half.
   */
  it("returns the arithmetic answer even when it is implausible", () => {
    const r = consumptionBetween(4000, 40, 6);
    expect(r.consumption).toBe(996_040);
    expect(r.isRollover).toBe(true);
  });
});

describe("⭐ anomaly thresholds", () => {
  /**
   * ⚠️ ASYMMETRIC, ON PURPOSE. A doubling is often seasonal and honest —
   * an air conditioner bought in April. A collapse to two-fifths of
   * normal rarely is: it is a bypassed meter, a stopped dial, or a
   * misread. The numbers reflect the direction fraud actually travels in,
   * and making them symmetric "for consistency" would be a real
   * regression dressed as tidying.
   */
  it("is more sensitive downward than upward", () => {
    expect(ANOMALY_HIGH_MULTIPLIER).toBe(3.0);
    expect(ANOMALY_LOW_MULTIPLIER).toBe(0.4);

    /**
     * Read as fold-changes: consumption must TRIPLE before it is flagged,
     * but need only fall by 2.5× (to 40%). The downward trip-wire is the
     * tighter of the two, and that is the entire point — the asymmetry
     * would be pointless, or backwards, if 1/LOW were the larger number.
     */
    const riseNeededToFlag = ANOMALY_HIGH_MULTIPLIER;   // 3.0×
    const fallNeededToFlag = 1 / ANOMALY_LOW_MULTIPLIER; // 2.5×
    expect(fallNeededToFlag).toBeLessThan(riseNeededToFlag);
  });

  it("looks back far enough to have an average but not so far it is stale", () => {
    expect(ANOMALY_LOOKBACK).toBe(3);
  });

  it("does not count an estimate as an actual measurement", () => {
    expect(ACTUAL_READING_SOURCES).not.toContain("estimated");
    expect(ACTUAL_READING_SOURCES).toContain("manual");
    expect(ACTUAL_READING_SOURCES).toContain("smart_meter");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⭐ DRIFT GUARDS
 * ══════════════════════════════════════════════════════════════════════ */

const SQL = readFileSync(
  join(process.cwd(), "SQL-FILES", "0035_engine5_metering.sql"),
  "utf8",
);

describe("⭐ drift guard — the thresholds exist in two places", () => {
  it("uses the same high multiplier in the trigger as in TypeScript", () => {
    const pattern = new RegExp(
      `avg_recent\\s*\\*\\s*${ANOMALY_HIGH_MULTIPLIER.toFixed(1)}`,
    );
    expect(
      pattern.test(SQL),
      `ANOMALY_HIGH_MULTIPLIER is ${ANOMALY_HIGH_MULTIPLIER} in db/schema/utility-meters.ts but the trigger in 0035 does not use that number. The screen and the batch run would then disagree about which readings are suspicious.`,
    ).toBe(true);
  });

  it("uses the same low multiplier in the trigger as in TypeScript", () => {
    const pattern = new RegExp(
      `avg_recent\\s*\\*\\s*${ANOMALY_LOW_MULTIPLIER.toString()}`,
    );
    expect(pattern.test(SQL)).toBe(true);
  });

  it("uses the same lookback window", () => {
    expect(
      new RegExp(`LIMIT ${ANOMALY_LOOKBACK}\\s+-- ⚠️ MUST MATCH ANOMALY_LOOKBACK`).test(SQL),
      `ANOMALY_LOOKBACK is ${ANOMALY_LOOKBACK}; the trigger's history window must match or the two will judge the same reading differently.`,
    ).toBe(true);
  });
});

describe("⭐ drift guard — the guarantees the SQL is supposed to carry", () => {
  it("never lets the application delete a reading", () => {
    expect(
      /REVOKE\s+DELETE,\s*TRUNCATE\s+ON\s+meter_readings\s+FROM\s+ordence_app/i.test(SQL),
      "Deleting a reading silently re-chains everything after it: the next reading's baseline jumps back, that period's consumption doubles, and the invoice already sent no longer matches anything in the database.",
    ).toBe(true);
  });

  it("still allows UPDATE, because a dispute must be recordable", () => {
    expect(/GRANT SELECT, INSERT, UPDATE ON meter_readings TO ordence_app/.test(SQL)).toBe(true);
  });

  it("FORCEs row-level security", () => {
    expect(/FORCE ROW LEVEL SECURITY/.test(SQL)).toBe(true);
  });

  it("creates every view with security_invoker", () => {
    const views = SQL.match(/CREATE OR REPLACE VIEW\s+(\w+)/g) ?? [];
    const invokers = SQL.match(/security_invoker\s*=\s*true/g) ?? [];
    expect(views.length).toBeGreaterThan(0);
    expect(invokers.length).toBe(views.length);
  });

  it("orders the immutability guard before the derivation trigger", () => {
    /**
     * ⚠️ POSTGRES FIRES BEFORE TRIGGERS IN ALPHABETICAL ORDER BY NAME,
     * not in creation order. `005_immutable` must sort ahead of
     * `010_derive` so a rejected edit does no derivation work first.
     */
    const immutable = SQL.indexOf("trg_meter_readings_005_immutable");
    const derive = SQL.indexOf("trg_meter_readings_010_derive");
    expect(immutable).toBeGreaterThan(-1);
    expect(derive).toBeGreaterThan(-1);
    expect("005_immutable" < "010_derive").toBe(true);
  });

  it("refuses to subtract across a meter replacement", () => {
    expect(
      /AND meter_id\s+=\s+NEW\.meter_id/.test(SQL),
      "The previous-reading lookup must be constrained to the SAME meter. A replacement starts at zero and has no arithmetic relationship to its predecessor.",
    ).toBe(true);
  });

  it("banks net export rather than netting it away inside the period", () => {
    expect(
      /v_bank_close\s*:=\s*\(v_exported \+ v_bank_open\) - v_offset/.test(SQL),
      "Import minus export within the month destroys the bank — quietly, monthly, in the utility's favour, and invisibly on the invoice because the invoice only shows the net.",
    ).toBe(true);
    expect(
      /v_offset\s*:=\s*LEAST\(v_consumed, v_exported \+ v_bank_open\)/.test(SQL),
      "Export must offset import DOWN TO ZERO and no further; the remainder is the bank.",
    ).toBe(true);
  });

  it("chains readings by read_at, not by insertion order", () => {
    expect(
      /AND read_at\s+<\s+NEW\.read_at[\s\S]{0,120}ORDER BY read_at DESC/.test(SQL),
      "Readings arrive out of order constantly — a phone syncing three days late, a smart-meter backfill after a manual entry. Chaining by created_at makes consumption depend on upload order, which is not a property of the meter.",
    ).toBe(true);
  });
});
