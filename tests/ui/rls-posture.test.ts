/**
 * Ordence — the RLS posture interpreter
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS PROTECTS
 * ══════════════════════════════════════════════════════════════════════
 * Tenant isolation in this product IS row-level security. A connection
 * role with `rolbypassrls` skips every FORCE ROW LEVEL SECURITY policy
 * while `check:rls` keeps passing, because that gate reads pg_catalog and
 * the catalog stays correct. On Neon the default owner `neondb_owner`
 * carries `rolbypassrls`.
 *
 * ⚠️ THE FAILURE MODE THIS FILE EXISTS FOR IS A FALSE "ENFORCED". Saying
 *    "bypassed" when it is enforced costs one confused morning. Saying
 *    "enforced" when it is bypassed is how a cross-tenant read ships with
 *    every dashboard green, so the tests below lean hard on that side.
 */

import { describe, it, expect } from "vitest";

import {
  interpretRlsPosture,
  rlsPostureNeedsAttention,
  type RlsPostureFacts,
} from "@/lib/platform/rls-posture";

const facts = (over: Partial<RlsPostureFacts> = {}): RlsPostureFacts => ({
  role: "ordence_app",
  bypassesRls: false,
  isSuperuser: false,
  ...over,
});

describe("interpretRlsPosture", () => {
  it("reports enforced only when the role neither bypasses RLS nor is superuser", () => {
    expect(interpretRlsPosture(facts()).level).toBe("enforced");
  });

  /**
   * 🔴 THE CORE PROPERTY, ASSERTED EXHAUSTIVELY RATHER THAN BY EXAMPLE.
   *    Every combination of the two flags is enumerated, and "enforced"
   *    is required to be reachable ONLY from false/false. A future edit
   *    that adds a branch cannot quietly widen it.
   */
  it("never reports enforced when either flag is set", () => {
    for (const bypassesRls of [true, false]) {
      for (const isSuperuser of [true, false]) {
        const posture = interpretRlsPosture(facts({ bypassesRls, isSuperuser }));
        const shouldBeEnforced = !bypassesRls && !isSuperuser;
        expect(
          posture.level === "enforced",
          `bypassesRls=${bypassesRls} isSuperuser=${isSuperuser} produced "${posture.level}"`,
        ).toBe(shouldBeEnforced);
      }
    }
  });

  /**
   * ⚠️ `null` MEANS THE DATABASE DID NOT ANSWER. It must read as
   *    UNVERIFIED, never as safe. This is the same rule the availability
   *    endpoint follows: "we could not check" must never render as "yes".
   */
  it("treats an unanswered probe as unknown, not as enforced", () => {
    const posture = interpretRlsPosture(null);
    expect(posture.level).toBe("unknown");
    expect(posture.level).not.toBe("enforced");
    expect(rlsPostureNeedsAttention(posture)).toBe(true);
  });

  it("flags anything that is not confirmed enforced as needing attention", () => {
    expect(rlsPostureNeedsAttention(interpretRlsPosture(facts()))).toBe(false);
    for (const over of [{ bypassesRls: true }, { isSuperuser: true }]) {
      expect(rlsPostureNeedsAttention(interpretRlsPosture(facts(over)))).toBe(true);
    }
    expect(rlsPostureNeedsAttention(interpretRlsPosture(null))).toBe(true);
  });

  /**
   * 🔴 SUPERUSER IS A DISTINCT MESSAGE, NOT A SYNONYM FOR BYPASSRLS.
   *    `rolbypassrls` skips RLS and leaves triggers intact. A superuser
   *    skips triggers too, which takes out the slug guard, the
   *    closed-period guard and the append-only ledger guards. An operator
   *    reading one message must not conclude the other situation.
   */
  it("distinguishes superuser from plain bypassrls", () => {
    const sup = interpretRlsPosture(facts({ isSuperuser: true }));
    const byp = interpretRlsPosture(facts({ bypassesRls: true }));
    expect(sup.label).not.toBe(byp.label);
    expect(sup.detail).not.toBe(byp.detail);
    // The superuser case must mention that triggers go too; the plain
    // bypass case must not claim they do.
    expect(/trigger/i.test(sup.detail)).toBe(true);
  });

  /**
   * ⚠️ EVERY STATE CARRIES A WORD. Roughly one in twelve Indian men is
   *    colour-blind and the console renders these as banded status. A
   *    label that is only a colour is not a label.
   */
  it("gives every level a non-empty word label and a detail", () => {
    const all = [
      interpretRlsPosture(facts()),
      interpretRlsPosture(facts({ bypassesRls: true })),
      interpretRlsPosture(facts({ isSuperuser: true })),
      interpretRlsPosture(null),
    ];
    for (const p of all) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it("offers a remedy exactly when there is something to do", () => {
    expect(interpretRlsPosture(facts()).remedy).toBe("");
    for (const p of [
      interpretRlsPosture(facts({ bypassesRls: true })),
      interpretRlsPosture(facts({ isSuperuser: true })),
      interpretRlsPosture(null),
    ]) {
      expect(p.remedy.trim().length).toBeGreaterThan(0);
    }
  });

  it("names the role it saw, so the message is actionable", () => {
    const p = interpretRlsPosture(facts({ role: "neondb_owner", bypassesRls: true }));
    expect(p.detail).toContain("neondb_owner");
  });
});
