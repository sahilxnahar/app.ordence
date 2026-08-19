/**
 * Ordence — ⭐⭐⭐ THE ROTATION BOARD'S TWO PROPERTIES
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE ARE PROPERTIES AND NOT SNAPSHOTS
 * ══════════════════════════════════════════════════════════════════════
 * Five tests in this suite were rewritten for pinning an exact string, an
 * href, a path or a count — assertions that fail when somebody renames a
 * column and pass when somebody reintroduces a leak. Neither test below
 * names a single secret, a single length or a single row count.
 *
 *   ① NO VALUE, PREFIX, SUFFIX OR LENGTH REACHES THE VIEW MODEL. Stated
 *     over the WHOLE serialised model against a fabricated environment,
 *     so it holds for fields that do not exist yet.
 *   ② THE BOARD'S NAMES ARE THE UNION OF THE IMPORTED LISTS. Set
 *     equality in both directions, so neither list can grow a name the
 *     board misses nor the board a name no list has.
 */

import { describe, expect, it } from "vitest";
import { BOOT_ADVISORY, BOOT_REQUIRED } from "@/lib/env-boot";
import { ENV_CATEGORIES } from "@/lib/platform/env-catalog";
import {
  SECRET_CATALOG,
  SECRET_NAMES,
  buildSecretBoard,
  isCataloguedSecret,
} from "@/lib/platform/secret-catalog";
import {
  SECRET_BANDS,
  bandForDays,
  bandSeverity,
  FRESH_MAX_DAYS,
  AGEING_MAX_DAYS,
} from "@/lib/platform/secret-board";

/* ------------------------------------------------------------------ */
/* ① THE LEAK PROPERTY                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE SENTINEL IS BUILT, NOT WRITTEN, so its LENGTH is a number
 * unlikely to appear in the model by coincidence — that matters, because
 * half of this test is looking for the length as well as the value.
 */
const SENTINEL = `sk_live_${"z".repeat(101)}`;
const SENTINEL_LENGTH = SENTINEL.length; // 109

/** Every number anywhere in a value, however deeply nested. */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) collectNumbers(v, out);
  return out;
}

describe("🔴 the rotation board never carries a secret's value, any part of it, or its length", () => {
  /** An environment in which EVERY catalogued name holds the sentinel. */
  const poisonedEnv: Record<string, string> = Object.fromEntries(
    SECRET_NAMES.map((name) => [name, SENTINEL]),
  );

  const model = buildSecretBoard({
    env: poisonedEnv,
    rotations: {},
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  const serialised = JSON.stringify(model);

  it("contains no field holding the value", () => {
    expect(serialised).not.toContain(SENTINEL);
  });

  it("contains no prefix or suffix of the value either", () => {
    // Any run of the sentinel long enough to be a recognisable fragment.
    // Four characters is the "last four" a masked display would show.
    for (const start of [0, 4, SENTINEL_LENGTH - 8, SENTINEL_LENGTH - 4]) {
      const fragment = SENTINEL.slice(start, start + 4);
      expect(serialised).not.toContain(fragment);
    }
  });

  it("contains no number equal to the value's length", () => {
    // The important half. A `length` field, a `chars`, a `size`, an
    // entropy estimate derived from it — any of them would put this
    // number into the model, and any of them is a truncated-paste oracle.
    expect(collectNumbers(model)).not.toContain(SENTINEL_LENGTH);
    expect(serialised).not.toContain(String(SENTINEL_LENGTH));
  });

  it("still answers the question it is allowed to answer", () => {
    // ⚠️ The negative assertions above would all pass on an empty model.
    // This one proves the model is doing its job while carrying nothing.
    expect(model.length).toBe(SECRET_CATALOG.length);
    expect(model.every((row) => row.present)).toBe(true);

    const absent = buildSecretBoard({
      env: {},
      rotations: {},
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    expect(absent.every((row) => row.present)).toBe(false);
    // An empty string is absence, not presence — the same question
    // `lib/env-boot.ts` asks.
    const blank = buildSecretBoard({
      env: Object.fromEntries(SECRET_NAMES.map((n) => [n, ""])),
      rotations: {},
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    expect(blank.some((row) => row.present)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* ② THE NO-DRIFT PROPERTY                                             */
/* ------------------------------------------------------------------ */

describe("⭐ the board's names are exactly the union of the lists it imports", () => {
  const union = new Set<string>([
    ...BOOT_REQUIRED,
    ...BOOT_ADVISORY.map((a) => a.name),
    ...ENV_CATEGORIES.flatMap((c) => [...c.required, ...c.optional]),
  ]);

  it("misses nothing any list names", () => {
    const onBoard = new Set(SECRET_NAMES);
    expect([...union].filter((n) => !onBoard.has(n))).toEqual([]);
  });

  it("invents nothing no list names", () => {
    expect(SECRET_NAMES.filter((n) => !union.has(n))).toEqual([]);
  });

  it("names each setting exactly once, even where a source repeats it", () => {
    // ENV_CATEGORIES really does list one category twice. A duplicated
    // row is a second thing to rotate against and a first row that then
    // looks overdue forever.
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length);
  });

  it("only accepts a name it catalogues", () => {
    for (const name of SECRET_NAMES) expect(isCataloguedSecret(name)).toBe(true);
    expect(isCataloguedSecret("NOT_A_SETTING_ANYWHERE")).toBe(false);
  });

  it("carries the advisory consequence for every name that has one", () => {
    for (const advisory of BOOT_ADVISORY) {
      const entry = SECRET_CATALOG.find((e) => e.name === advisory.name);
      expect(entry?.consequence).toBe(advisory.consequence);
    }
  });

  it("marks every boot-required name as required", () => {
    for (const name of BOOT_REQUIRED) {
      expect(SECRET_CATALOG.find((e) => e.name === name)?.bootRole).toBe("required");
    }
  });
});

/* ------------------------------------------------------------------ */
/* ③ THE HONESTY OF THE AGE BAND                                       */
/* ------------------------------------------------------------------ */

describe("⚠️ an unrecorded rotation is never reported as a recent one", () => {
  const now = new Date("2026-08-17T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it("says nothing recorded rather than zero days", () => {
    const rows = buildSecretBoard({ env: {}, rotations: {}, now });
    for (const row of rows) {
      expect(row.daysSinceRotation).toBeNull();
      expect(row.lastRotatedAt).toBeNull();
      expect(row.bandKey).toBe("never-recorded");
      expect(SECRET_BANDS[row.bandKey].word).toContain("never");
    }
  });

  it("bands a recorded rotation by its own age, in words", () => {
    const name = SECRET_NAMES[0];
    expect(name).toBeDefined();
    if (name === undefined) return;

    const banded = (days: number) => {
      const rows = buildSecretBoard({
        env: {},
        rotations: { [name]: { at: daysAgo(days), by: "ops@ordence.test", reason: "why" } },
        now,
      });
      return rows.find((r) => r.name === name);
    };

    expect(banded(1)?.bandKey).toBe("fresh");
    expect(banded(FRESH_MAX_DAYS)?.bandKey).toBe("ageing");
    expect(banded(AGEING_MAX_DAYS)?.bandKey).toBe("overdue");
    expect(banded(3)?.daysSinceRotation).toBe(3);

    // Every band prints a word, and no two bands share one.
    const words = Object.values(SECRET_BANDS).map((b) => b.word);
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(word.trim().length).toBeGreaterThan(0);
  });

  it("treats a corrupt stored date as nothing recorded, not as day zero", () => {
    const name = SECRET_NAMES[0];
    if (name === undefined) return;
    const rows = buildSecretBoard({
      env: {},
      rotations: { [name]: { at: "not-a-date", by: null, reason: null } },
      now,
    });
    const row = rows.find((r) => r.name === name);
    expect(row?.bandKey).toBe("never-recorded");
    expect(row?.daysSinceRotation).toBeNull();
  });

  it("sorts an unknown age above a known fresh one", () => {
    // An unmeasured secret is a worse position than a measured old one:
    // you cannot decide about what you cannot see.
    expect(bandSeverity("never-recorded")).toBeGreaterThan(bandSeverity("fresh"));
    expect(bandSeverity("overdue")).toBeGreaterThan(bandSeverity("never-recorded"));
    expect(bandForDays(null).key).toBe("never-recorded");
  });
});
