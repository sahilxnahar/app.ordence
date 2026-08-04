/**
 * Ordence — Usage Metering: quota arithmetic & period resolution
 * Version: v0.14.0-alpha (Phase 15)
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE FOUR FAILURES THESE TESTS EXIST TO PREVENT
 * ══════════════════════════════════════════════════════════════════════
 *
 *   1. STORAGE THAT ONLY EVER RISES. If `storage_bytes` is ever treated
 *      as a cumulative tally, a customer who uploads a file, deletes it
 *      and uploads it again is charged for both. Repeat over a year of
 *      ordinary housekeeping and a diligent customer is locked out of an
 *      account containing almost nothing.
 *
 *   2. A FLOAT IN A BILLABLE FIGURE. `Number(used) / Number(limit)` is
 *      correct for every value anybody will test by hand and wrong at the
 *      boundary — where it reports 100% for a tenant who is one byte
 *      short of their limit, and blocks them.
 *
 *   3. A QUOTA THAT BLOCKS BEFORE IT WARNS. Phase 14's principle is that
 *      a customer is never cut off without notice and never loses reach
 *      of their own data. A quota that refuses at exactly 100% with no
 *      prior warning, on every metric, breaks a third party's workflow —
 *      the person waiting for a contract has no idea our quota exists.
 *
 *   4. A CALENDAR MONTH PRETENDING TO BE A BILLING PERIOD. A
 *      subscription anchored on the 9th resets on the 9th. Bucketing by
 *      calendar month makes the usage page disagree with the invoice, and
 *      the invoice is the one read carefully.
 *
 * Everything here is PURE. No database, no mocks of anything carrying a
 * rule. The rules ARE these functions.
 */

import { describe, it, expect } from "vitest";

import {
  USAGE_METRICS,
  CUMULATIVE_METRICS,
  LEVEL_METRICS,
  QUOTA_NOTICE_BPS,
  QUOTA_WARNING_BPS,
  QUOTA_FULL_BPS,
  metricDefinition,
  isCumulativeMetric,
  isLevelMetric,
  isUsageMetric,
  limitForMetric,
  usedBasisPoints,
  blockThreshold,
  evaluateQuota,
  canConsume,
  formatBytes,
  formatCount,
  formatUsage,
  describeQuota,
  worstQuotaLevel,
  serialiseQuotaState,
  toBigIntUsage,
  type PlanQuotaLimits,
} from "@/lib/metering/quota";

import {
  resolveMeteringPeriod,
  calendarMonthPeriod,
  isSamePeriod,
  periodKey,
} from "@/lib/metering/period";

/** The Advanced plan's defaults, as they appear on `plans`. */
const PLAN: PlanQuotaLimits = {
  storageLimitMb: 512,
  emailsPerMonth: 500,
  apiCallsPerMonth: 10_000,
};

const MB = 1_048_576n;

/* ================================================================== */
/* 1. ⭐ TWO KINDS OF METRIC                                            */
/* ================================================================== */

describe("metric kinds — a level is not a tally", () => {
  it("⭐ storage is a LEVEL, and nothing else is", () => {
    // If this ever flips, a customer who deletes 30 GB keeps being billed
    // for it — and eventually cannot upload anything at all despite
    // storing almost nothing.
    expect(LEVEL_METRICS).toEqual(["storage_bytes"]);
    expect(isLevelMetric("storage_bytes")).toBe(true);
    expect(isCumulativeMetric("storage_bytes")).toBe(false);
  });

  it("emails, API calls and portal links are cumulative tallies", () => {
    for (const metric of ["emails_sent", "api_calls", "portal_links_created"] as const) {
      expect(isCumulativeMetric(metric), metric).toBe(true);
      expect(isLevelMetric(metric), metric).toBe(false);
    }
  });

  it("the two lists partition the metric set exactly — none missing, none in both", () => {
    // A metric in neither list is written to no table; a metric in both is
    // written to two, and the figures diverge silently.
    const union = [...CUMULATIVE_METRICS, ...LEVEL_METRICS].sort();
    expect(union).toEqual([...USAGE_METRICS].sort());
    expect(new Set(union).size).toBe(USAGE_METRICS.length);
  });

  it("rejects an unknown metric loudly rather than treating it as unlimited", () => {
    expect(isUsageMetric("emails")).toBe(false);
    // @ts-expect-error — deliberately wrong, to prove the runtime guard.
    expect(() => metricDefinition("emails")).toThrow(/Unknown usage metric/);
  });
});

/* ================================================================== */
/* 2. LIMITS COME FROM `plans`                                         */
/* ================================================================== */

describe("limitForMetric", () => {
  it("converts the plan's megabytes into BYTES, in mebibytes", () => {
    // 1 MB = 1,048,576 bytes, matching what the customer's own file
    // manager told them the file was. Using 1,000,000 would make our
    // figure 4.8% smaller than theirs at a gigabyte.
    expect(limitForMetric("storage_bytes", PLAN)).toBe(512n * MB);
  });

  it("passes counts through untouched", () => {
    expect(limitForMetric("emails_sent", PLAN)).toBe(500n);
    expect(limitForMetric("api_calls", PLAN)).toBe(10_000n);
  });

  it("⭐ a metric with no plan column is UNLIMITED, not zero", () => {
    // Getting this backwards caps an uncapped metric at nothing and
    // refuses every portal link on every plan.
    expect(limitForMetric("portal_links_created", PLAN)).toBeNull();
  });

  it("a negative catalogue value clamps to zero rather than granting credit", () => {
    expect(limitForMetric("emails_sent", { ...PLAN, emailsPerMonth: -50 })).toBe(0n);
  });
});

/* ================================================================== */
/* 3. ⭐ NO FLOATS ANYWHERE NEAR A BILLABLE FIGURE                      */
/* ================================================================== */

describe("usedBasisPoints — exact integer arithmetic", () => {
  it("⭐ is exact one unit below the limit, where a float has already said 100%", () => {
    // Be precise about the claim: at ordinary sizes a float would give the
    // same answer. The point is that this expression is exact BY
    // CONSTRUCTION rather than exact-until-it-is-not — and that the
    // "until" is reachable, because the same arithmetic is reused for the
    // `used × price` multiplication Phase 16 will do on these values.
    //
    // Past 2^53 the difference is not subtle: `Number()` rounds
    // 999,999,999,999,999,999 UP to 1e18, the subtraction disappears
    // entirely, and a tenant one unit BELOW their limit is reported as
    // being AT it — and refused.
    const limit = 1_000_000_000_000_000_000n;
    const used = limit - 1n;

    expect(Number(used) / Number(limit)).toBe(1); // the float, wrong
    expect(usedBasisPoints(used, limit)).toBe(9_999); // exact, and not blocking
  });

  it("floors rather than rounds, so 99.99% is never reported as 100%", () => {
    expect(usedBasisPoints(9_999n, 10_000n)).toBe(9_999);
    expect(usedBasisPoints(10_000n, 10_000n)).toBe(10_000);
  });

  it("⭐ a ZERO limit with usage is over, not NaN and not zero", () => {
    // `0/0` is NaN and every comparison against NaN is false, so a
    // misconfigured plan would read as neither at nor over its limit and
    // would never warn or block. Exactly the trap `computeSeatState`
    // guards against in Phase 13.
    expect(Number.isNaN(usedBasisPoints(5n, 0n))).toBe(false);
    expect(usedBasisPoints(5n, 0n)).toBeGreaterThan(QUOTA_FULL_BPS);
    expect(usedBasisPoints(0n, 0n)).toBe(0);
  });
});

describe("formatBytes — rounding happens in bigint", () => {
  it("renders the usual sizes", () => {
    expect(formatBytes(0n)).toBe("0 bytes");
    expect(formatBytes(1n)).toBe("1 byte");
    expect(formatBytes(1_536n)).toBe("1.5 KB");
    expect(formatBytes(512n * MB)).toBe("512 MB");
    expect(formatBytes(1_610_612_736n)).toBe("1.5 GB");
  });

  it("drops the decimal above 100 units, where it implies false precision", () => {
    expect(formatBytes(512n * MB)).not.toMatch(/\./);
  });

  it("⭐ is exact beyond 2^53, where a float has already lost digits", () => {
    const petabyte = 9_007_199_254_740_993n; // 2^53 + 1
    expect(formatBytes(petabyte)).toBe("8192 TB");
    // And the value itself survives a round trip, which is the property
    // that matters when it becomes an invoice line.
    expect(toBigIntUsage(petabyte.toString())).toBe(petabyte);
  });

  it("handles a negative reading without rendering nonsense", () => {
    // Should never occur — the level is clamped — but a display bug must
    // not be the thing that reports an internal drift to a customer.
    expect(formatBytes(-2_097_152n)).toBe("-2 MB");
  });
});

describe("formatCount", () => {
  it("groups in the Indian system, matching the money formatter", () => {
    expect(formatCount(1_234_567n)).toBe("12,34,567");
  });

  it("does not go through a float for an unrepresentable count", () => {
    const huge = 9_007_199_254_740_993n;
    expect(formatCount(huge)).toBe("9007199254740993");
  });
});

describe("toBigIntUsage", () => {
  it("normalises the shapes a driver can return", () => {
    expect(toBigIntUsage("42")).toBe(42n);
    expect(toBigIntUsage(42)).toBe(42n);
    expect(toBigIntUsage(42n)).toBe(42n);
    expect(toBigIntUsage(null)).toBe(0n);
  });

  it("⭐ REJECTS a float rather than coercing one", () => {
    // A value that arrives as 1e20 has already lost its low digits.
    // Accepting it would put that loss into a figure someone is billed for.
    expect(() => toBigIntUsage(1e20)).toThrow(/must not arrive as floats/);
    expect(() => toBigIntUsage(1.5)).toThrow();
    expect(() => toBigIntUsage("1.5")).toThrow(/Malformed/);
  });
});

/* ================================================================== */
/* 4. THE LADDER — WARN LONG BEFORE REFUSING                           */
/* ================================================================== */

describe("evaluateQuota", () => {
  const at = (used: bigint) =>
    evaluateQuota({ metric: "emails_sent", used, limit: 1_000n });

  it("is quiet well below the threshold", () => {
    expect(at(799n).level).toBe("ok");
    expect(describeQuota(at(799n))).toBeNull();
  });

  it("notices at exactly 80%, and says how much is left", () => {
    const state = at(800n);
    expect(state.usedBps).toBe(QUOTA_NOTICE_BPS);
    expect(state.level).toBe("notice");
    expect(describeQuota(state)).toMatch(/200 left/);
  });

  it("warns at exactly 95%", () => {
    expect(at(950n).usedBps).toBe(QUOTA_WARNING_BPS);
    expect(at(950n).level).toBe("warning");
  });

  it("is exceeded at exactly the limit, not one over it", () => {
    expect(at(1_000n).level).toBe("exceeded");
    expect(at(1_000n).isOver).toBe(true);
    expect(at(999n).isOver).toBe(false);
  });

  it("never reports negative remaining", () => {
    expect(at(4_000n).remaining).toBe(0n);
  });

  it("clamps a negative reading for display instead of showing '-4 MB used'", () => {
    // A negative stored level is an internal drift. Rendering it turns our
    // bug into the customer's confusion.
    expect(at(-5n).used).toBe(0n);
  });

  it("an unlimited metric is always ok and has no remaining figure", () => {
    const state = evaluateQuota({ metric: "portal_links_created", used: 9_999n, limit: null });
    expect(state.level).toBe("ok");
    expect(state.remaining).toBeNull();
    expect(state.isBlocked).toBe(false);
  });
});

/* ================================================================== */
/* 5. ⭐ OVER IS NOT THE SAME AS BLOCKED                                */
/* ================================================================== */

describe("canConsume — where each metric actually refuses", () => {
  it("⭐ STORAGE refuses at exactly the limit — the cost is ongoing and the remedy is free", () => {
    const limit = limitForMetric("storage_bytes", PLAN)!;
    expect(blockThreshold("storage_bytes", limit)).toBe(limit);

    const full = evaluateQuota({ metric: "storage_bytes", used: limit, limit });
    const verdict = canConsume(full, 1n);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("blocked");
    // A refusal with no route out is just a wall.
    expect(verdict.message).toMatch(/delete/i);
  });

  it("⭐ STORAGE's refusal never suggests the customer's data is gone or hidden", () => {
    const limit = limitForMetric("storage_bytes", PLAN)!;
    const verdict = canConsume(
      evaluateQuota({ metric: "storage_bytes", used: limit * 2n, limit }),
      1n,
    );
    expect(verdict.message).toMatch(/nothing you have uploaded is hidden or removed/i);
    expect(verdict.message).not.toMatch(/deleted your|will be removed|lost/i);
  });

  it("⭐ EMAIL is allowed at 101% and refused only past 150%", () => {
    // Refusing the 501st email on a 500-email plan does not inconvenience
    // the customer — it strands a THIRD PARTY waiting for a contract, who
    // has no idea a quota exists.
    const limit = 500n;
    const over = evaluateQuota({ metric: "emails_sent", used: 500n, limit });
    expect(over.level).toBe("exceeded");
    expect(canConsume(over, 1n).allowed).toBe(true);
    expect(canConsume(over, 1n).reason).toBe("over_but_permitted");

    expect(blockThreshold("emails_sent", limit)).toBe(750n);
    const atCeiling = evaluateQuota({ metric: "emails_sent", used: 750n, limit });
    expect(canConsume(atCeiling, 1n).allowed).toBe(false);

    // …and the last email below the ceiling still goes.
    const justUnder = evaluateQuota({ metric: "emails_sent", used: 749n, limit });
    expect(canConsume(justUnder, 1n).allowed).toBe(true);
  });

  it("⭐ API CALLS are never refused, at any multiple of the allowance", () => {
    // Phase 16 turns this into a billed overage. An API that starts
    // returning errors at an unannounced threshold is an outage we caused.
    const wildlyOver = evaluateQuota({
      metric: "api_calls",
      used: 10_000_000n,
      limit: 10_000n,
    });
    expect(wildlyOver.level).toBe("exceeded");
    expect(wildlyOver.isBlocked).toBe(false);
    expect(canConsume(wildlyOver, 500n).allowed).toBe(true);
    expect(canConsume(wildlyOver, 500n).message).toMatch(/nothing is blocked/i);
  });

  it("an unlimited metric says so rather than inventing a number", () => {
    const state = evaluateQuota({ metric: "portal_links_created", used: 12n, limit: null });
    expect(canConsume(state).reason).toBe("unlimited");
  });

  it("a bulk consumption that would cross the ceiling is refused as a whole", () => {
    const limit = limitForMetric("storage_bytes", PLAN)!;
    const nearlyFull = evaluateQuota({ metric: "storage_bytes", used: limit - 10n, limit });
    expect(canConsume(nearlyFull, 9n).allowed).toBe(true);
    expect(canConsume(nearlyFull, 11n).allowed).toBe(false);
  });

  it("a quota message never mentions permissions, seats or an administrator", () => {
    // Four denials, four remedies. "Upgrade your plan" shown to someone
    // who only needed to empty their bin is a charge they did not need.
    const limit = limitForMetric("storage_bytes", PLAN)!;
    const message = canConsume(
      evaluateQuota({ metric: "storage_bytes", used: limit, limit }),
      1n,
    ).message;
    expect(message).not.toMatch(/permission|administrator|seat/i);
  });
});

describe("worstQuotaLevel", () => {
  it("reports the worst rung across metrics — what a global banner shows", () => {
    const states = [
      evaluateQuota({ metric: "api_calls", used: 10n, limit: 10_000n }),
      evaluateQuota({ metric: "emails_sent", used: 480n, limit: 500n }),
      evaluateQuota({ metric: "storage_bytes", used: 600n * MB, limit: 512n * MB }),
    ];
    expect(worstQuotaLevel(states)).toBe("exceeded");
    expect(worstQuotaLevel([states[0]!])).toBe("ok");
  });
});

/* ================================================================== */
/* 6. THE RSC BOUNDARY                                                 */
/* ================================================================== */

describe("serialiseQuotaState", () => {
  it("⭐ survives JSON.stringify, which throws on a raw bigint", () => {
    const state = evaluateQuota({
      metric: "storage_bytes",
      used: 300n * MB,
      limit: 512n * MB,
    });

    expect(() => JSON.stringify(state)).toThrow(/BigInt/);
    expect(() => JSON.stringify(serialiseQuotaState(state))).not.toThrow();
  });

  it("carries pre-rendered copy so the client never re-derives it", () => {
    // A client that formats the numbers itself is a second implementation
    // of the formatter, and it will eventually disagree with the server
    // about whether someone is at 99% or 100%.
    const serialised = serialiseQuotaState(
      evaluateQuota({ metric: "storage_bytes", used: 300n * MB, limit: 512n * MB }),
    );
    expect(serialised.used).toBe((300n * MB).toString());
    expect(serialised.usedLabel).toBe("300 MB");
    expect(serialised.limitLabel).toBe("512 MB");
  });

  it("formatUsage picks the right unit for the metric", () => {
    expect(formatUsage("storage_bytes", 2_097_152n)).toBe("2 MB");
    expect(formatUsage("api_calls", 2_097_152n)).toBe("20,97,152");
  });
});

/* ================================================================== */
/* 7. ⭐ THE PERIOD IS THE BILLING PERIOD                               */
/* ================================================================== */

describe("resolveMeteringPeriod", () => {
  const monthly = (start: string, end: string) => ({
    subscriptionPeriodStart: new Date(start),
    subscriptionPeriodEnd: new Date(end),
    interval: "monthly" as const,
  });

  it("uses the subscription's own boundary, not the calendar month", () => {
    // Anchored on the 9th: the allowance runs 9th → 9th. Bucketing by
    // calendar month would reset it on the 1st, three weeks into a period
    // the customer has already half-consumed.
    const period = resolveMeteringPeriod({
      ...monthly("2026-03-09T10:30:00Z", "2026-04-09T10:30:00Z"),
      now: new Date("2026-03-28T00:00:00Z"),
    });

    expect(period.source).toBe("subscription");
    expect(period.periodStart.toISOString()).toBe("2026-03-09T10:30:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-04-09T10:30:00.000Z");
  });

  it("⭐ a subscription anchored on the 31st does NOT drift into March", () => {
    // JavaScript's Date rolls 31 February over to 2 or 3 March, which
    // silently moves the customer's anchor day forward for ever. By June
    // they are billed on the 3rd and nobody can explain why.
    // `addInterval` clamps to the last day of the target month instead —
    // which is what both payment providers do.
    const period = resolveMeteringPeriod({
      ...monthly("2026-01-31T00:00:00Z", "2026-02-28T00:00:00Z"),
      now: new Date("2026-03-04T00:00:00Z"), // past the stored end
    });

    expect(period.source).toBe("rolled_forward");
    expect(period.periodStart.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-03-28T00:00:00.000Z");
    // The specific bug: never 2 or 3 March.
    expect(period.periodEnd.getUTCMonth()).toBe(2); // March, not February+2 days
    expect(period.periodEnd.getUTCDate()).not.toBe(3);
  });

  it("clamps 31 January to 28 February in a non-leap year and 29 in a leap one", () => {
    const nonLeap = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2026-01-31T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2026-01-31T00:00:01Z"),
      interval: "monthly",
      now: new Date("2026-02-10T00:00:00Z"),
    });
    expect(nonLeap.periodEnd.toISOString()).toBe("2026-02-28T00:00:01.000Z");

    const leap = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2028-01-31T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2028-01-31T00:00:01Z"),
      interval: "monthly",
      now: new Date("2028-02-10T00:00:00Z"),
    });
    expect(leap.periodEnd.toISOString()).toBe("2028-02-29T00:00:01.000Z");
  });

  it("rolls forward while a renewal webhook is late, rather than inflating a closed month", () => {
    // The renewal happened; the webhook has not landed. Usage recorded now
    // must not be added to a period that has closed and is about to be
    // invoiced.
    const period = resolveMeteringPeriod({
      ...monthly("2026-03-09T00:00:00Z", "2026-04-09T00:00:00Z"),
      now: new Date("2026-04-09T00:00:30Z"), // thirty seconds late
    });
    expect(period.source).toBe("rolled_forward");
    expect(period.periodStart.toISOString()).toBe("2026-04-09T00:00:00.000Z");
  });

  it("honours quarterly and annual intervals", () => {
    const quarterly = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2026-01-09T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2026-04-09T00:00:00Z"),
      interval: "quarterly",
      now: new Date("2026-04-10T00:00:00Z"),
    });
    expect(quarterly.periodEnd.toISOString()).toBe("2026-07-09T00:00:00.000Z");

    const annual = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2025-04-09T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2026-04-09T00:00:00Z"),
      interval: "annual",
      now: new Date("2026-04-10T00:00:00Z"),
    });
    expect(annual.periodEnd.toISOString()).toBe("2027-04-09T00:00:00.000Z");
  });

  it("uses the stored period even when `now` is a moment before it starts", () => {
    // A webhook can advance the period seconds ahead of our clock. The
    // usage still belongs to the subscription the customer holds, not to a
    // synthesised past period nothing will ever invoice.
    const period = resolveMeteringPeriod({
      ...monthly("2026-03-09T00:00:00Z", "2026-04-09T00:00:00Z"),
      now: new Date("2026-03-08T23:59:59Z"),
    });
    expect(period.source).toBe("subscription");
    expect(period.periodStart.toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("falls back to the calendar month ONLY when there is no subscription", () => {
    const period = resolveMeteringPeriod({
      subscriptionPeriodStart: null,
      subscriptionPeriodEnd: null,
      interval: null,
      now: new Date("2026-07-31T18:00:00Z"),
    });
    expect(period.source).toBe("calendar_fallback");
    expect(period.periodStart.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("refuses to bucket against an inverted period", () => {
    const period = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2026-04-09T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2026-03-09T00:00:00Z"),
      interval: "monthly",
      now: new Date("2026-04-10T00:00:00Z"),
    });
    expect(period.source).toBe("calendar_fallback");
  });

  it("gives up rolling forward after two years rather than spinning", () => {
    // A corrupt anchor at the epoch must not spin tens of thousands of
    // iterations inside a best-effort recorder that is meant to be invisible.
    const period = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("1970-01-01T00:00:00Z"),
      subscriptionPeriodEnd: new Date("1970-02-01T00:00:00Z"),
      interval: "monthly",
      now: new Date("2026-07-31T00:00:00Z"),
    });
    expect(period.source).toBe("calendar_fallback");
  });
});

describe("period identity", () => {
  it("⭐ the bucket key is the start INSTANT, never YYYY-MM", () => {
    // Two subscriptions anchored on different days of the same month must
    // not collide. A `YYYY-MM` key would merge them.
    const ninth = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2026-03-09T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2026-04-09T00:00:00Z"),
      interval: "monthly",
      now: new Date("2026-03-20T00:00:00Z"),
    });
    const twentieth = resolveMeteringPeriod({
      subscriptionPeriodStart: new Date("2026-03-20T00:00:00Z"),
      subscriptionPeriodEnd: new Date("2026-04-20T00:00:00Z"),
      interval: "monthly",
      now: new Date("2026-03-25T00:00:00Z"),
    });

    expect(periodKey(ninth)).not.toBe(periodKey(twentieth));
    expect(isSamePeriod(ninth, twentieth)).toBe(false);
    expect(isSamePeriod(ninth, ninth)).toBe(true);
  });

  it("the calendar fallback is a whole UTC month", () => {
    const period = calendarMonthPeriod(new Date("2026-02-14T09:00:00Z"));
    expect(period.periodStart.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });
});
