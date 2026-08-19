/**
 * Ordence — The tenant session policy (Batch 136)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS ARE FOR
 * ══════════════════════════════════════════════════════════════════════
 * Not "the module exists". Before this batch, `requireMfa` and
 * `sessionIdleMinutes` were saved, redisplayed as enabled and enforced by
 * nothing — so every assertion below is a way the repair could be worth
 * nothing, or worse than nothing, if it were wrong:
 *
 *   1. A WORKSPACE THAT REQUIRES MFA REFUSES A SESSION WITHOUT A SECOND
 *      FACTOR. If this passes when it should refuse, we are back to
 *      telling a customer their payroll is behind two factors while it is
 *      behind one password.
 *   2. AN IDLE SESSION PAST THE LIMIT IS REFUSED, and the limit is the
 *      workspace's number rather than a constant somebody hard-coded.
 *   3. THE REMEDY IS ALWAYS REACHABLE. A refusal that points at a page the
 *      refusal itself forbids is a locked door and a redirect loop.
 *   4. NOTHING THE CLIENT SENDS CAN BUY TIME. The deadline is the EARLIER
 *      of the two candidate ends, never the later — the rule Batch 28
 *      settled for impersonation.
 *   5. AN UNREADABLE SETTING IS NEVER "NO LIMIT".
 *
 * ⚠️ PROPERTIES, NOT SHAPES. Nothing here pins a sentence, a colour or a
 * count; the wording of a refusal is expected to improve.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_IDLE_MINUTES,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  SESSION_POLICY_EXEMPT_PATHS,
  evaluateSession,
  idleDeadlineMs,
  isSessionPolicyExempt,
  readFactorEvidence,
  readPolicyFromClaims,
  readSessionExpiryMs,
  readSessionPolicy,
  type FactorEvidence,
} from "@/lib/security/session-policy";

/** Clerk emits `fva` as [firstFactorAge, secondFactorAge] in minutes. */
const claims = (firstFactor: number, secondFactor: number) => ({
  fva: [firstFactor, secondFactor],
});

const NOW = Date.UTC(2026, 7, 18, 9, 0, 0);
const WORK_PATH = "/invoices/new";

describe("reading the two settings out of JSONB", () => {
  it("treats anything that is not exactly true as MFA-not-required", () => {
    for (const value of [undefined, null, false, 0, "true", "yes", 1, {}]) {
      expect(readSessionPolicy({ requireMfa: value }).requireMfa).toBe(false);
    }
    expect(readSessionPolicy({ requireMfa: true }).requireMfa).toBe(true);
  });

  it("never turns an unreadable idle setting into an unbounded session", () => {
    for (const value of [undefined, null, "60", NaN, Infinity, {}, []]) {
      const policy = readSessionPolicy({ sessionIdleMinutes: value });
      expect(Number.isFinite(policy.idleMinutes)).toBe(true);
      expect(policy.idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    }
    expect(readSessionPolicy(null).idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
  });

  it("clamps to the same bounds the settings form enforces on write", () => {
    for (const value of [-9999, 0, 1, 4, 5, 60, 1440, 5000]) {
      const { idleMinutes } = readSessionPolicy({ sessionIdleMinutes: value });
      expect(idleMinutes).toBeGreaterThanOrEqual(MIN_IDLE_MINUTES);
      expect(idleMinutes).toBeLessThanOrEqual(MAX_IDLE_MINUTES);
    }
  });
});

describe("what Clerk's signed claims actually say", () => {
  it("distinguishes 'no second factor' from 'we could not measure'", () => {
    const never = readFactorEvidence(claims(3, -1));
    expect(never.measured).toBe(true);
    expect(never.secondFactorMinutes).toBeNull();

    const absent = readFactorEvidence({ metadata: {} });
    expect(absent.measured).toBe(false);
    expect(absent.secondFactorMinutes).toBeNull();

    const verified = readFactorEvidence(claims(3, 3));
    expect(verified.measured).toBe(true);
    expect(verified.secondFactorMinutes).toBe(3);
  });

  it("reads nothing from a claim set that carries no policy", () => {
    expect(readPolicyFromClaims({ fva: [1, 1] })).toBeNull();
    expect(readPolicyFromClaims(null)).toBeNull();
    expect(readPolicyFromClaims({ tenantSecurity: { requireMfa: true } })?.requireMfa).toBe(
      true,
    );
  });

  it("converts the JWT expiry from seconds to milliseconds, or admits it cannot", () => {
    expect(readSessionExpiryMs({ exp: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(readSessionExpiryMs({})).toBeNull();
    expect(readSessionExpiryMs({ exp: "soon" })).toBeNull();
  });
});

describe("🔴 requireMfa — the load-bearing refusal", () => {
  const withoutSecondFactor: FactorEvidence = readFactorEvidence(claims(2, -1));

  it("REFUSES a user with no second factor in a workspace that requires one", () => {
    const verdict = evaluateSession({
      path: WORK_PATH,
      policy: { requireMfa: true, idleMinutes: 60 },
      factors: withoutSecondFactor,
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("mfa_required");
    expect(verdict.redirectTo).not.toBeNull();
  });

  it("lets the same user through when the workspace does not require MFA", () => {
    expect(
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: false, idleMinutes: 60 },
        factors: withoutSecondFactor,
        nowMs: NOW,
      }).outcome,
    ).toBe("allow");
  });

  it("admits a session that demonstrably stands on a second factor", () => {
    expect(
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: true, idleMinutes: 60 },
        factors: readFactorEvidence(claims(2, 2)),
        nowMs: NOW,
      }).outcome,
    ).toBe("allow");
  });

  it("refuses when the factor claim is missing entirely — unproven is not proven", () => {
    const verdict = evaluateSession({
      path: WORK_PATH,
      policy: { requireMfa: true, idleMinutes: 60 },
      factors: readFactorEvidence({}),
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("mfa_required");
    // …and the caller is told the limit could not be measured, so an
    // unmeasured control never looks like a satisfied one.
    expect(verdict.idleUnenforceable).toBe(true);
  });

  it("bites on the next request — an open session is not grandfathered", () => {
    // The identical session, evaluated before and after the admin ticks
    // the box. Nothing about the policy is captured at sign-in.
    const factors = withoutSecondFactor;
    const before = evaluateSession({
      path: WORK_PATH,
      policy: { requireMfa: false, idleMinutes: 60 },
      factors,
      nowMs: NOW,
    });
    const after = evaluateSession({
      path: WORK_PATH,
      policy: { requireMfa: true, idleMinutes: 60 },
      factors,
      nowMs: NOW,
    });
    expect(before.outcome).toBe("allow");
    expect(after.outcome).toBe("mfa_required");
  });
});

describe("🔴 sessionIdleMinutes — the workspace's own number, on the server's clock", () => {
  const fresh = (ageMinutes: number) => readFactorEvidence(claims(ageMinutes, ageMinutes));

  it("refuses past the limit and admits inside it, for every configured value", () => {
    for (const idleMinutes of [MIN_IDLE_MINUTES, 15, 60, 480, MAX_IDLE_MINUTES]) {
      const policy = { requireMfa: false, idleMinutes };
      expect(
        evaluateSession({ path: WORK_PATH, policy, factors: fresh(idleMinutes - 1), nowMs: NOW })
          .outcome,
      ).toBe("allow");
      expect(
        evaluateSession({ path: WORK_PATH, policy, factors: fresh(idleMinutes + 1), nowMs: NOW })
          .outcome,
      ).toBe("idle_expired");
    }
  });

  it("uses the tenant's number, not a constant — a shorter limit refuses sooner", () => {
    const factors = fresh(30);
    expect(
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: false, idleMinutes: 15 },
        factors,
        nowMs: NOW,
      }).outcome,
    ).toBe("idle_expired");
    expect(
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: false, idleMinutes: 240 },
        factors,
        nowMs: NOW,
      }).outcome,
    ).toBe("allow");
  });

  it("ends a stale session rather than sending it to enrol a new credential", () => {
    // Both rules are broken at once. The stale session must die first —
    // attaching a second factor to a session we have judged dead is worse
    // than either failure on its own.
    expect(
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: true, idleMinutes: 30 },
        factors: readFactorEvidence(claims(120, -1)),
        nowMs: NOW,
      }).outcome,
    ).toBe("idle_expired");
  });

  it("cannot be extended by anything the client could influence", () => {
    const lastVerifiedAtMs = NOW - 10 * 60_000;
    const own = idleDeadlineMs({ lastVerifiedAtMs, idleMinutes: 60 });

    // A far-future session expiry — the kind a forged or optimistic value
    // would look like — never moves the deadline later.
    expect(
      idleDeadlineMs({ lastVerifiedAtMs, idleMinutes: 60, sessionExpiresAtMs: own + 86_400_000 }),
    ).toBe(own);
    // A sooner end wins: the workspace may shorten, never lengthen.
    expect(
      idleDeadlineMs({ lastVerifiedAtMs, idleMinutes: 60, sessionExpiresAtMs: own - 60_000 }),
    ).toBe(own - 60_000);
    // Nonsense is ignored rather than treated as "no end at all".
    for (const bad of [Number.NaN, Infinity, null, undefined]) {
      expect(idleDeadlineMs({ lastVerifiedAtMs, idleMinutes: 60, sessionExpiresAtMs: bad })).toBe(
        own,
      );
    }
  });

  it("degrades visibly rather than silently when the age cannot be measured", () => {
    const verdict = evaluateSession({
      path: WORK_PATH,
      policy: { requireMfa: false, idleMinutes: 5 },
      factors: readFactorEvidence({}),
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("allow");
    expect(verdict.idleUnenforceable).toBe(true);
  });
});

describe("the gate never blocks its own remedy", () => {
  it("sends every refusal to a destination that is itself exempt", () => {
    const refusals = [
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: true, idleMinutes: 60 },
        factors: readFactorEvidence(claims(1, -1)),
        nowMs: NOW,
      }),
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: false, idleMinutes: 5 },
        factors: readFactorEvidence(claims(600, 600)),
        nowMs: NOW,
      }),
    ];
    for (const verdict of refusals) {
      expect(verdict.outcome).not.toBe("allow");
      expect(verdict.redirectTo).toBeTruthy();
      // The loop-freedom property: wherever we send them, the gate lets
      // them arrive.
      expect(isSessionPolicyExempt(verdict.redirectTo ?? "")).toBe(true);
    }
  });

  it("admits every exempt path under the harshest policy imaginable", () => {
    for (const path of SESSION_POLICY_EXEMPT_PATHS) {
      for (const candidate of [path, `${path}/sub/page`]) {
        expect(
          evaluateSession({
            path: candidate,
            policy: { requireMfa: true, idleMinutes: MIN_IDLE_MINUTES },
            factors: readFactorEvidence(claims(9999, -1)),
            nowMs: NOW,
          }).outcome,
        ).toBe("allow");
      }
    }
  });

  it("does not exempt an ordinary path that merely looks similar", () => {
    for (const path of SESSION_POLICY_EXEMPT_PATHS) {
      expect(isSessionPolicyExempt(`${path}-elsewhere`)).toBe(false);
    }
  });

  it("applies no exemption at all when the caller cannot see a path", () => {
    // A React Server Component is never told its URL, so the layout omits
    // the path — and omitting it must be the stricter reading.
    expect(
      evaluateSession({
        policy: { requireMfa: true, idleMinutes: 60 },
        factors: readFactorEvidence(claims(1, -1)),
        nowMs: NOW,
      }).outcome,
    ).toBe("mfa_required");
  });
});

describe("every state carries a word", () => {
  it("names each outcome in text, not by colour alone", () => {
    const seen = new Set<string>();
    for (const verdict of [
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: false, idleMinutes: 60 },
        factors: readFactorEvidence(claims(1, 1)),
        nowMs: NOW,
      }),
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: true, idleMinutes: 60 },
        factors: readFactorEvidence(claims(1, -1)),
        nowMs: NOW,
      }),
      evaluateSession({
        path: WORK_PATH,
        policy: { requireMfa: false, idleMinutes: 5 },
        factors: readFactorEvidence(claims(99, 99)),
        nowMs: NOW,
      }),
    ]) {
      expect(verdict.word.trim().length).toBeGreaterThan(0);
      expect(verdict.reason.trim().length).toBeGreaterThan(0);
      seen.add(verdict.word);
    }
    // Three distinct outcomes must not share one label.
    expect(seen.size).toBe(3);
  });
});
