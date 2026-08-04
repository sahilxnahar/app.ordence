/**
 * Ordence — ⭐ ENGINE 3 · FIELD & MOBILE OPERATIONS
 * Session 1 · v0.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE TWO THINGS WORTH TESTING HERE ARE BOTH COUNTER-INTUITIVE
 * ══════════════════════════════════════════════════════════════════════
 * 1. The distance calculation must be spherical, because the flat-grid
 *    version is wrong by a quarter across India and wrong in the
 *    direction that makes a distant check-in look nearer.
 *
 * 2. The status machine must be enforced in the DATABASE, because the
 *    client is offline and replays its queue out of order. A test that
 *    only checks the TypeScript map proves the UI is polite; it proves
 *    nothing about what an offline phone can push.
 *
 * So half of this file is a drift guard over the .sql.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  haversineMetres,
  canTransition,
  FIELD_JOB_TRANSITIONS,
  SUSPICIOUS_DISTANCE_M,
  OPEN_JOB_STATUSES,
  fieldJobStatusEnum,
  type FieldJobStatus,
} from "@/db/schema/field-ops";

describe("⭐ haversine — distance on a sphere, not a grid", () => {
  it("measures CST to the Gateway of India at about 2 km", () => {
    const d = haversineMetres(18.9398, 72.8355, 18.922, 72.8347);
    expect(d).toBeGreaterThan(1900);
    expect(d).toBeLessThan(2100);
  });

  it("agrees with the SQL fixture to the metre", () => {
    // ordence_haversine_m() returns 1981 on this input; asserted in
    // test_engine36.sql. Both round the same way, so they must match.
    expect(haversineMetres(18.9398, 72.8355, 18.922, 72.8347)).toBe(1981);
  });

  /**
   * ⚠️ THE FLAT-GRID TRAP, MADE EXPLICIT.
   *
   * A degree of longitude is 111 km at the equator and about 97.7 km at
   * Delhi's latitude. Pythagoras on raw degrees assumes the first number
   * everywhere — a ~12% overstatement here, and worse further north. It
   * errs by making a check-in look FURTHER than it was in one direction
   * and nearer in another, which is precisely the signal being measured.
   */
  it("shortens a degree of longitude at Delhi's latitude", () => {
    const atDelhi = haversineMetres(28.6139, 77.209, 28.6139, 78.209);
    const atEquator = haversineMetres(0, 77.209, 0, 78.209);

    expect(atDelhi).toBeGreaterThan(95_000);
    expect(atDelhi).toBeLessThan(100_000);
    expect(atEquator).toBeGreaterThan(110_000);
    expect(atDelhi).toBeLessThan(atEquator);
  });

  it("is zero for identical points and symmetric between two", () => {
    expect(haversineMetres(19, 72.8, 19, 72.8)).toBe(0);
    expect(haversineMetres(19, 72.8, 28.6, 77.2)).toBe(
      haversineMetres(28.6, 77.2, 19, 72.8),
    );
  });

  it("handles the antipodal case without NaN", () => {
    // sqrt of a value nudged above 1 by floating point would produce NaN
    // from asin; the Math.min(1, …) clamp is what prevents it.
    const d = haversineMetres(0, 0, 0, 180);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(19_000_000);
  });

  it("does not treat a sign flip as a small distance", () => {
    // 1°N to 1°S is two degrees, not zero.
    expect(haversineMetres(1, 72.8, -1, 72.8)).toBeGreaterThan(220_000);
  });
});

describe("⭐ the suspicious-distance threshold", () => {
  /**
   * ⚠️ LOOSE ON PURPOSE. Urban GPS is routinely out by 100–200 m, and
   * far worse in a basement or under a metal roof. A threshold tight
   * enough to catch fraud would flag half of all honest check-ins — and a
   * team that sees a red mark on every job stops reading red marks, which
   * costs more than the fraud did.
   */
  it("is far enough out to mean something when it fires", () => {
    expect(SUSPICIOUS_DISTANCE_M).toBe(500);
    expect(SUSPICIOUS_DISTANCE_M).toBeGreaterThan(200);
  });
});

describe("⭐ the status machine", () => {
  it("refuses to complete a job that was never dispatched", () => {
    expect(canTransition("scheduled", "completed")).toBe(false);
    expect(canTransition("draft", "on_site")).toBe(false);
  });

  it("allows the ordinary path", () => {
    expect(canTransition("scheduled", "dispatched")).toBe(true);
    expect(canTransition("dispatched", "travelling")).toBe(true);
    expect(canTransition("travelling", "on_site")).toBe(true);
    expect(canTransition("on_site", "completed")).toBe(true);
  });

  /**
   * ⚠️ TERMINAL, AND THIS IS THE ASSERTION THAT PROTECTS THE ONE NUMBER
   * FIELD SERVICE IS MANAGED BY. If a completed job could be re-opened
   * and completed again, every failed first attempt would edit itself out
   * of the first-time-fix rate — which would then trend towards 100%
   * while the business got worse.
   */
  it("makes completed and cancelled terminal", () => {
    expect(FIELD_JOB_TRANSITIONS.completed).toHaveLength(0);
    expect(FIELD_JOB_TRANSITIONS.cancelled).toHaveLength(0);
    expect(canTransition("completed", "on_site")).toBe(false);
    expect(canTransition("cancelled", "scheduled")).toBe(false);
  });

  it("lets a failed job be re-scheduled, because that is a second visit", () => {
    expect(canTransition("could_not_complete", "scheduled")).toBe(true);
  });

  it("names every status in the transition map", () => {
    for (const s of fieldJobStatusEnum.enumValues) {
      expect(
        FIELD_JOB_TRANSITIONS[s as FieldJobStatus],
        `Status "${s}" has no entry in FIELD_JOB_TRANSITIONS, so canTransition() would throw on it at runtime.`,
      ).toBeDefined();
    }
  });

  it("never names a status that does not exist", () => {
    const valid = new Set<string>(fieldJobStatusEnum.enumValues);
    for (const [from, tos] of Object.entries(FIELD_JOB_TRANSITIONS)) {
      for (const to of tos) {
        expect(valid.has(to), `${from} → ${to} names an unknown status`).toBe(true);
      }
    }
  });

  it("counts the three terminal outcomes as distinct", () => {
    /**
     * ⚠️ "COMPLETED", "COULD NOT COMPLETE" AND "CANCELLED" ARE DIFFERENT
     * OUTCOMES. Collapsing them into one closed flag loses the only
     * number that matters operationally: a team with a 92% completion
     * rate and a team with 92% closed jobs are not the same team, and the
     * second may be driving to sites and finding nobody home half the
     * time.
     */
    const terminal = fieldJobStatusEnum.enumValues.filter(
      (s) => FIELD_JOB_TRANSITIONS[s as FieldJobStatus].length === 0,
    );
    expect(terminal.sort()).toEqual(["cancelled", "completed"]);
    expect(OPEN_JOB_STATUSES).not.toContain("could_not_complete");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⭐ DRIFT GUARDS — the offline client can only be stopped by the SQL
 * ══════════════════════════════════════════════════════════════════════ */

const SQL = readFileSync(
  join(process.cwd(), "SQL-FILES", "0036_engine3_field_ops.sql"),
  "utf8",
);

describe("⭐ drift guard — the SQL enforces the same machine", () => {
  it("lists the same permitted transitions as the TypeScript map", () => {
    const block = SQL.split("/*TRANSITIONS*/")[1]?.split("END;")[0] ?? "";
    expect(block).not.toBe("");

    for (const [from, tos] of Object.entries(FIELD_JOB_TRANSITIONS)) {
      const line =
        block.match(new RegExp(`WHEN\\s+'${from}'\\s+THEN\\s+(ARRAY\\[[^\\]]*\\])`))?.[1] ?? "";
      expect(line, `The SQL has no arm for status "${from}"`).not.toBe("");

      const inSql = [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
      expect(
        inSql,
        `Status "${from}" permits [${[...tos].sort().join(", ")}] in db/schema/field-ops.ts but [${inSql.join(", ")}] in 0036. An offline client replaying its queue would then be judged by a different rule than the UI applied.`,
      ).toEqual([...tos].sort());
    }
  });

  it("uses the same suspicious-distance threshold", () => {
    expect(
      new RegExp(`/\\*SUSPICIOUS-M\\*/\\s*${SUSPICIOUS_DISTANCE_M}\\b`).test(SQL),
      `SUSPICIOUS_DISTANCE_M is ${SUSPICIOUS_DISTANCE_M} in TypeScript; the trigger in 0036 must use the same number or a check-in flagged on one screen is clean on another.`,
    ).toBe(true);
  });

  it("computes distance rather than refusing the check-in", () => {
    /**
     * ⚠️ THE MOST IMPORTANT ASSERTION IN THIS FILE.
     *
     * Somebody will eventually propose turning the flag into a rejection.
     * It sounds like a fraud control and it is a data-loss bug: the
     * technician has a customer waiting, does the job anyway, and records
     * it later from the car park. You lose the record of exactly the
     * hardest jobs.
     */
    const trigger =
      SQL.split("CREATE OR REPLACE FUNCTION field_visit_derive()")[1]?.split(
        "$$;",
      )[0] ?? "";
    expect(trigger).not.toBe("");

    /**
     * ⚠️ MATCH WITHIN ONE STATEMENT, NOT A CHARACTER WINDOW. A RAISE ends
     * at its semicolon; a fixed lookahead spills into the next block and
     * matches the prose explaining why there is no such raise — which is
     * how a guard ends up asserting the presence of its own comment.
     */
    expect(
      /RAISE EXCEPTION[^;]{0,400}distance/i.test(trigger),
      "The visit trigger raises on distance. GPS is evidence, not a gate — see the header of 0036.",
    ).toBe(false);
    expect(/is_distance_suspicious\s*:=/.test(trigger)).toBe(true);
  });

  it("keeps proof of service append-only at the privilege level", () => {
    expect(
      /REVOKE\s+UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+field_proofs\s+FROM\s+ordence_app/i.test(SQL),
      "A photo that can be replaced afterwards is not evidence, it is a picture.",
    ).toBe(true);
  });

  it("makes the device own the idempotency key", () => {
    expect(
      /field_visits_client_event_key/.test(SQL) ||
        /client_event_id/.test(SQL),
    ).toBe(true);
  });

  it("FORCEs RLS and uses security_invoker on every view", () => {
    expect(/FORCE ROW LEVEL SECURITY/.test(SQL)).toBe(true);
    const views = SQL.match(/CREATE OR REPLACE VIEW\s+\w+/g) ?? [];
    const invokers = SQL.match(/security_invoker\s*=\s*true/g) ?? [];
    expect(views.length).toBeGreaterThan(0);
    expect(invokers.length).toBe(views.length);
  });

  it("refuses to complete a job with no checked-in visit", () => {
    expect(
      /no visit has been checked in against it/.test(SQL),
      "Without this, a mis-tapped button on a list screen closes a job nobody attended — and it looks identical to one that went perfectly.",
    ).toBe(true);
  });
});
