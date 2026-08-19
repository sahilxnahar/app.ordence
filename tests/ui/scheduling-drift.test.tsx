/**
 * Ordence — ENGINE 1 · THE DRIFT GUARD
 * v0.59.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE TEST, AND IT GUARDS THE MOST DANGEROUS EDIT IN THE ENGINE
 * ══════════════════════════════════════════════════════════════════════
 * `CAPACITY_CONSUMING_STATUSES` in db/schema/scheduling.ts and the
 * `status IN (...)` predicate of the exclusion constraint in
 * 0033_engine1_scheduling.sql must name exactly the same statuses.
 *
 * If they drift, the failure is silent and severe: a status that the
 * application believes occupies a room stops blocking a second booking at
 * the database. Nothing errors. Nothing looks wrong. The room is simply
 * sold twice, on the busiest day, because that is when both requests
 * arrive at once.
 *
 * The two live in different languages in different files, so no compiler
 * can relate them. This test can.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPACITY_CONSUMING_STATUSES,
  CAPACITY_RELEASING_STATUSES,
  consumesCapacity,
  scheduleBookingStatusEnum,
} from "@/db/schema/scheduling";

const SQL = readFileSync(
  resolve(__dirname, "../../SQL-FILES/0033_engine1_scheduling.sql"),
  "utf8",
);

/**
 * Every status list in the SQL that is MARKED as a capacity predicate.
 *
 * ⚠️ MARKED, NOT MATCHED BY SHAPE. An earlier version of this test simply
 * regexed for `status IN (...)` and failed — because it also caught a
 * comment, the "may this resource take new bookings" check (`held`,
 * `confirmed`), and the revenue list in the view (which correctly
 * includes `completed` and `no_show`, since a no-show is usually still
 * charged).
 *
 * Those are DIFFERENT QUESTIONS that happen to share a syntax. Loosening
 * the assertion to accommodate them would have gutted the guard; tagging
 * the four predicates that genuinely mean "occupies the resource" keeps
 * it exact and makes the intent visible in the SQL itself.
 */
function capacityStatusListsInSql(): string[][] {
  const out: string[][] = [];
  const re = /\/\*CAPACITY-STATUSES\*\/[^(]*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SQL)) !== null) {
    out.push(
      (m[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .filter(Boolean)
        .sort(),
    );
  }
  return out;
}

describe("scheduling: SQL and TypeScript agree on what occupies a resource", () => {
  it("finds the status predicates in the SQL at all", () => {
    // If this fails the file was restructured and the guard below is
    // vacuously passing — which is worse than a red test.
    expect(capacityStatusListsInSql().length).toBeGreaterThanOrEqual(5);
  });

  it("uses the SAME statuses in every SQL predicate as in the constant", () => {
    const expected = [...CAPACITY_CONSUMING_STATUSES].sort();
    for (const list of capacityStatusListsInSql()) {
      expect(
        list,
        `A status list in 0033_engine1_scheduling.sql is [${list.join(", ")}] ` +
          `but CAPACITY_CONSUMING_STATUSES is [${expected.join(", ")}]. ` +
          `They must match exactly, or a booking the app treats as live ` +
          `will stop blocking double-booking in the database — silently.`,
      ).toEqual(expected);
    }
  });

  it("declares the exclusion constraint over a range, not a timestamp", () => {
    // The guarantee is `&&` on a tstzrange under GiST. Anything else —
    // an equality check, a unique index on start time — permits partial
    // overlaps, which is the common case rather than the edge case.
    expect(SQL).toMatch(/EXCLUDE\s+USING\s+gist/i);
    expect(SQL).toMatch(/reserved_range\s+WITH\s+&&/i);
    expect(SQL).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/i);
  });

  it("locks the resource row before counting shared capacity", () => {
    // Without FOR UPDATE the count is read in one statement and acted on
    // in the next, which is the exact race the engine exists to close.
    expect(SQL).toMatch(/FOR UPDATE/);
  });

  it("accounts for every status exactly once", () => {
    const all = [...scheduleBookingStatusEnum.enumValues].sort();
    const covered = [
      ...CAPACITY_CONSUMING_STATUSES,
      ...CAPACITY_RELEASING_STATUSES,
    ].sort();
    // A status in neither list is a status nobody decided about.
    expect(covered).toEqual(all);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("agrees with the helper the UI calls", () => {
    for (const s of CAPACITY_CONSUMING_STATUSES) expect(consumesCapacity(s)).toBe(true);
    for (const s of CAPACITY_RELEASING_STATUSES) expect(consumesCapacity(s)).toBe(false);
  });
});
