/**
 * Batches 55 & 56 — entitlements and metering, ENFORCED.
 *
 * ⚠️ These assert PROPERTIES, not shapes. No test here pins a count, a
 * message string or a key list: those change every time somebody ships a
 * module, and a test that fails on a correct change teaches people to
 * delete tests. What is pinned is the RULE — "a limit that is displayed is
 * a limit that refuses", "grace never reaches payroll or export", "the
 * derived number is the one that decides".
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { FEATURE_KEYS, type FeatureKey } from "@/lib/entitlements/features";
import {
  FEATURE_ENFORCEMENT,
  enforcedFeatures,
  unenforcedFeatures,
  isDeclaredOnly,
} from "@/lib/entitlements/enforcement";
import {
  isExemptWrite,
  permitsExport,
  permitsReads,
  permitsWrites,
  ACCESS_LEVELS,
  TRIAL_GRACE_DAYS,
} from "@/lib/billing/access-state";
import {
  GRACE_DEFAULTS,
  resolveGracePolicy,
  isStatutoryWrite,
  STATUTORY_WRITE_PREFIXES,
} from "@/lib/billing/grace";
import { overagePolicy, overageSentence } from "@/lib/metering/overage";
import { USAGE_METRICS, metricDefinition, serialiseQuotaState, evaluateQuota } from "@/lib/metering/quota";
import { canTakeSeats, countOccupiedSeats } from "@/lib/billing/seats";

/* ------------------------------------------------------------------ */
/* A TINY SOURCE READER                                                */
/* ------------------------------------------------------------------ */

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every server-side file that could hold a gate. Read once. */
const SERVER_SOURCE: string = (() => {
  const files = [...walk(join(ROOT, "server")), ...walk(join(ROOT, "app"))];
  return files
    .map((f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
})();

/**
 * Is there a server-side decision point that mentions this key?
 *
 * Deliberately loose: `requireFeature("x")`, a guard descriptor
 * `feature: "x"`, or a module constant. A stricter matcher would fail on
 * the next legitimate way somebody spells a gate, and the property under
 * test is "some server code reads this key", not "it is spelled thus".
 */
function hasServerGate(key: FeatureKey): boolean {
  // ⚠️ Matched against the SPELLINGS OF A GATE, not against any mention.
  // A key can appear in server code as route metadata, an upgrade-prompt
  // label or a nav entry — all of which DISPLAY it and refuse nothing.
  // Counting those as enforcement would make this test report exactly the
  // false comfort the ledger exists to remove.
  return [
    `requireFeature("${key}"`,
    `requireFeatureAndPermission("${key}"`,
    `hasFeature("${key}"`,
    `evaluateFeature("${key}"`,
    `feature: "${key}"`,
    `FEATURE = "${key}"`,
  ].some((spelling) => SERVER_SOURCE.includes(spelling));
}

/* ------------------------------------------------------------------ */
/* 1 · NO ENTITLEMENT MAY BE DECLARED AND ENFORCED BY NOTHING          */
/* ------------------------------------------------------------------ */

describe("the declared-vs-enforced ledger", () => {
  it("has a decision recorded for every key in the catalogue", () => {
    // 🔴 The load-bearing one. Adding a priced entitlement without saying
    // whether anything refuses it is the exact failure this batch went
    // looking for, three times over.
    const missing = FEATURE_KEYS.filter((k) => !(k in FEATURE_ENFORCEMENT));
    expect(missing, "catalogue keys with no enforcement decision").toEqual([]);
  });

  it("declares no key that is absent from the catalogue", () => {
    const stale = Object.keys(FEATURE_ENFORCEMENT).filter(
      (k) => !(FEATURE_KEYS as string[]).includes(k),
    );
    expect(stale, "ledger entries for keys that no longer exist").toEqual([]);
  });

  it("every key it calls enforced is actually read by server code", () => {
    const lying = enforcedFeatures().filter((k) => !hasServerGate(k));
    expect(lying, "marked `gated` but no server code reads them").toEqual([]);
  });

  it("every key it calls unenforced is genuinely read by nothing", () => {
    // The other direction matters just as much: a module that grew a gate
    // must come back and say so, or the ledger becomes folklore.
    const grown = unenforcedFeatures().filter((k) => hasServerGate(k));
    expect(grown, "marked `declared_only` but a gate now exists").toEqual([]);
  });

  it("treats an unknown key as undecided rather than as enforced", () => {
    expect(isDeclaredOnly("not.a.real.key" as FeatureKey)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2 · THE SEAT LIMIT REFUSES IN THE ENGINE, WITH THE UI BYPASSED      */
/* ------------------------------------------------------------------ */

describe("seat limits refuse below the UI", () => {
  it("refuses the seat that would exceed the plan, whoever asks", () => {
    // No component, no session, no button — just the rule. A `curl` and a
    // stale tab reach exactly this function and get exactly this answer.
    for (const purchased of [1, 5, 10, 250]) {
      expect(canTakeSeats(purchased, purchased, 1).allowed).toBe(false);
      expect(canTakeSeats(purchased - 1, purchased, 1).allowed).toBe(true);
    }
  });

  it("refuses a bulk request that would overshoot, not just a single one", () => {
    // The bypass that a per-click check misses: ask for ten at once.
    const verdict = canTakeSeats(8, 10, 5);
    expect(verdict.allowed).toBe(false);
  });

  it("counts seats from user rows rather than from a stored tally", () => {
    // 🔴 DERIVED, NOT COUNTED. The seat figure is a function of the rows,
    // so it cannot drift away from them.
    const rows = [
      { role: "member" as const, status: "active" },
      { role: "member" as const, status: "invited" },
      { role: "member" as const, status: "suspended" },
    ];
    const derived = countOccupiedSeats(rows);
    const byHand = rows.filter((r) => r.status === "active" || r.status === "invited").length;
    expect(derived).toBe(byHand);
  });

  it("performs the count inside the transaction that takes the seat", () => {
    // ⚠️ A source-level property, because the race it prevents cannot be
    // reproduced without two live connections. What is asserted is the
    // ORDER: the guard is inside the `withTenant` callback that writes,
    // not on a line before it.
    const src = readFileSync(join(ROOT, "server/actions/team.ts"), "utf8");
    const txStart = src.indexOf("withTenant(ctx.tenant.id, async (tx) => {");
    const guard = src.indexOf("requireSeatTx(");
    expect(txStart, "the seat write should open its own transaction").toBeGreaterThan(-1);
    expect(guard, "the seat guard should exist").toBeGreaterThan(txStart);
  });
});

/* ------------------------------------------------------------------ */
/* 3 · GRACE, NOT A CLIFF                                              */
/* ------------------------------------------------------------------ */

describe("a tenant in grace keeps working", () => {
  it("never blocks reading or exporting at any rung of the ladder", () => {
    // 🔴 Including the very bottom one. Holding a customer's books over an
    // invoice is the thing a CA warns every client away from.
    for (const level of ACCESS_LEVELS) {
      expect(permitsExport(level), `export blocked at ${level}`).toBe(true);
    }
    expect(ACCESS_LEVELS.filter((l) => !permitsReads(l))).toEqual(["locked"]);
  });

  it("still runs payroll when writes are otherwise restricted", () => {
    // 🔴 THE LOAD-BEARING ONE. Card failed on the 5th, payroll due on the
    // 7th. Every payroll write the product performs must survive.
    const restricted = ACCESS_LEVELS.filter((l) => !permitsWrites(l));
    expect(restricted.length).toBeGreaterThan(0);
    for (const operation of ["payroll:approve", "payroll:post", "payroll:run"]) {
      expect(isExemptWrite(operation), `${operation} refused during dunning`).toBe(true);
    }
  });

  it("exempts every statutory prefix it declares, and says which", () => {
    for (const prefix of STATUTORY_WRITE_PREFIXES) {
      expect(isStatutoryWrite(`${prefix}anything`)).toBe(true);
      expect(isExemptWrite(`${prefix}anything`)).toBe(true);
    }
  });

  it("still refuses ordinary writes, or the ladder means nothing", () => {
    // The counterweight: exemptions must be narrow enough that dunning
    // still has teeth on the writes nobody's deadline depends on.
    expect(isExemptWrite("contacts:create")).toBe(false);
    expect(isExemptWrite("deals:update")).toBe(false);
  });

  it("keeps the payment and export routes open, or the paywall is a trap", () => {
    for (const operation of ["billing:subscribe", "payment:update", "export:documents"]) {
      expect(isExemptWrite(operation)).toBe(true);
    }
  });
});

describe("the grace window is configuration with a stated default", () => {
  it("falls back to the documented default when nothing is configured", () => {
    // ⚠️ The failure mode this pins: an unset variable must not become
    // zero days of grace in a fresh environment.
    const policy = resolveGracePolicy({});
    expect(policy).toEqual(GRACE_DEFAULTS);
    expect(TRIAL_GRACE_DAYS).toBe(GRACE_DEFAULTS.trialGraceDays);
  });

  it("honours a configured window", () => {
    const policy = resolveGracePolicy({ NEXT_PUBLIC_ORDENCE_DUNNING_GRACE_DAYS: "14" });
    expect(policy.dunningGraceDays).toBe(14);
  });

  it("clamps nonsense back to something defensible rather than to zero", () => {
    for (const bad of ["", "  ", "-4", "abc", "99999"]) {
      const policy = resolveGracePolicy({ NEXT_PUBLIC_ORDENCE_TRIAL_GRACE_DAYS: bad });
      expect(policy.trialGraceDays).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4 · OVERAGE IS STATED, NOT IMPLIED                                  */
/* ------------------------------------------------------------------ */

describe("overage behaviour is stated for every metric", () => {
  it("gives every metric a policy and a sentence a customer can read", () => {
    for (const metric of USAGE_METRICS) {
      expect(["refused", "billed", "none"]).toContain(overagePolicy(metric));
      expect(overageSentence(metric).length).toBeGreaterThan(20);
    }
  });

  it("agrees with the engine about which metrics actually refuse", () => {
    // 🔴 The sentence and the enforcement come from the same fact. A
    // metric that blocks must not be described as billed, and vice versa.
    for (const metric of USAGE_METRICS) {
      const blocks = metricDefinition(metric).hardBlockBps !== null;
      expect(overagePolicy(metric) === "refused", `${metric}`).toBe(blocks);
    }
  });

  it("carries the sentence onto anything that renders a quota", () => {
    const state = serialiseQuotaState(
      evaluateQuota({ metric: "storage_bytes", used: 10n, limit: 100n }),
    );
    expect(state.overageSentence).toBe(overageSentence("storage_bytes"));
    expect(state.overagePolicy).toBe(overagePolicy("storage_bytes"));
  });
});

/* ------------------------------------------------------------------ */
/* 5 · DERIVED, NOT COUNTED                                            */
/* ------------------------------------------------------------------ */

describe("storage is decided from rows, not from a counter", () => {
  it("reads the derived figure inside the same transaction as the quota", () => {
    // ⚠️ Source-level, because the property is about which VALUE the gate
    // reads — unobservable without a database, and load-bearing enough
    // that "we changed it back" must not pass silently.
    const src = readFileSync(join(ROOT, "server/metering/query.ts"), "utf8");
    expect(src).toContain("deriveStorageBytesIn");
    const derive = src.indexOf("deriveStorageBytesIn(tx");
    const evaluate = src.indexOf("evaluateQuota({");
    expect(derive).toBeGreaterThan(-1);
    expect(evaluate).toBeGreaterThan(derive);
  });

  it("derives from exactly the rows reconciliation writes back", () => {
    // If the gate and the repair disagreed about which rows count, the
    // usage figure would flip between two values on refresh.
    const derive = readFileSync(join(ROOT, "server/metering/derive.ts"), "utf8");
    const record = readFileSync(join(ROOT, "server/metering/record.ts"), "utf8");
    for (const clause of ["SUM(size_bytes)", "FROM documents", "deleted_at IS NULL"]) {
      expect(derive, `derive.ts should filter on ${clause}`).toContain(clause);
      expect(record, `record.ts should filter on ${clause}`).toContain(clause);
    }
  });

  it("a derived total equals the rows it is derived from", () => {
    // The arithmetic property, without a database: summing sizes in
    // bigint must not lose bits the way a float sum would.
    // 2^53 and one more byte. Exact in bigint, unrepresentable in IEEE 754.
    const sizes = [9_007_199_254_740_992n, 1n];
    const derived = sizes.reduce((a, b) => a + b, 0n);
    expect(derived).toBe(9_007_199_254_740_993n);
    // The same addition in `number` silently loses the low bits — which is
    // precisely why `size_bytes` is summed in Postgres and read as text.
    const asFloat = sizes.reduce((a, b) => a + Number(b), 0);
    expect(BigInt(asFloat)).not.toBe(derived);
  });
});
