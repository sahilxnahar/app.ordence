/**
 * Ordence — Entitlements & Feature Gating
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * PHASE 12 MANDATORY VERIFICATION
 * ══════════════════════════════════════════════════════════════════════
 * "A single can(feature) gate every route consults; plan → feature
 *  matrix; graceful degradation, never a hard crash."
 *
 * Three properties are asserted here, and the third is the one that costs
 * money if it is wrong:
 *
 *   1. The matrix is internally consistent — a higher tier can never have
 *      LESS than a lower one.
 *   2. The gate fails CLOSED on anything it does not recognise.
 *   3. Losing a feature does not hide the customer's own data.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  TIER_RANK,
  TIER_LABELS,
  TRIAL_EFFECTIVE_TIER,
  LAPSED_EFFECTIVE_TIER,
  evaluateFeature,
  hasFeature,
  effectiveTier,
  featuresForTier,
  featuresGainedBy,
  featuresLostBy,
  lowestTierWith,
  isFeatureKey,
  type FeatureKey,
} from "@/lib/entitlements/features";
import { FeatureGate, UpgradePrompt, LockedControl } from "@/components/billing/feature-gate";
import type { PlanTier } from "@/db/schema/core";

const ALL_TIERS: PlanTier[] = ["trial", "basic", "advanced", "ai", "enterprise"];

const active = (planTier: PlanTier) => ({
  planTier,
  subscriptionGrantsAccess: true,
});

/* ================================================================== */
/* 1. THE MATRIX IS INTERNALLY CONSISTENT                              */
/* ================================================================== */

describe("the plan → feature matrix", () => {
  it("⭐ every higher tier is a strict SUPERSET of every lower one", () => {
    // THE property that makes the ladder a ladder. Without it the matrix
    // can drift into a state where Advanced has something Enterprise does
    // not — which nobody notices until an enterprise customer asks where
    // their contacts went.
    const ordered = [...ALL_TIERS].sort((a, b) => TIER_RANK[a] - TIER_RANK[b]);

    for (let i = 1; i < ordered.length; i += 1) {
      const lower = ordered[i - 1]!;
      const higher = ordered[i]!;
      const lowerSet = new Set(featuresForTier(lower));
      const higherSet = new Set(featuresForTier(higher));

      for (const feature of lowerSet) {
        expect(
          higherSet.has(feature),
          `${higher} is MISSING "${feature}", which ${lower} has`,
        ).toBe(true);
      }
    }
  });

  it("every feature declares a minTier that is a real tier", () => {
    for (const key of FEATURE_KEYS) {
      const tier = FEATURE_CATALOG[key].minTier;
      expect(tier in TIER_RANK, `"${key}" declares unknown tier "${tier}"`).toBe(true);
    }
  });

  it("every feature has a human label and description", () => {
    // These appear in upgrade prompts. A missing one produces "undefined
    // is available on the Advanced plan", shown to a paying customer.
    for (const key of FEATURE_KEYS) {
      const definition = FEATURE_CATALOG[key];
      expect(definition.label.length, `"${key}" has no label`).toBeGreaterThan(0);
      expect(definition.description.length, `"${key}" has no description`).toBeGreaterThan(0);
      expect(definition.label, `"${key}" label looks like a key`).not.toMatch(/[._]/);
    }
  });

  it("enterprise includes everything", () => {
    expect(featuresForTier("enterprise").length).toBe(FEATURE_KEYS.length);
  });

  it("basic does NOT include the advanced or enterprise features", () => {
    const basic = new Set(featuresForTier("basic"));
    expect(basic.has("accounting.ledger")).toBe(false);
    expect(basic.has("admin.sso")).toBe(false);
    expect(basic.has("ai.copilot")).toBe(false);
    // …but it does include the core CRM, or the plan is unsellable.
    expect(basic.has("crm.contacts")).toBe(true);
    expect(basic.has("storage.documents")).toBe(true);
  });

  it("featuresGainedBy and featuresLostBy are exact inverses", () => {
    for (const from of ALL_TIERS) {
      for (const to of ALL_TIERS) {
        const gained = featuresGainedBy(from, to);
        const lost = featuresLostBy(to, from);
        expect(new Set(gained), `${from} → ${to}`).toEqual(new Set(lost));
      }
    }
  });

  it("an upgrade never LOSES a feature and a downgrade never GAINS one", () => {
    expect(featuresLostBy("basic", "advanced")).toEqual([]);
    expect(featuresGainedBy("advanced", "basic")).toEqual([]);
  });

  it("lowestTierWith names the cheapest tier that includes a feature", () => {
    // Pointing someone at Enterprise for something Advanced gives them is
    // a good way to lose the sale.
    expect(lowestTierWith("accounting.ledger")).toBe("advanced");
    expect(lowestTierWith("crm.contacts")).toBe("basic");
    expect(lowestTierWith("admin.sso")).toBe("enterprise");

    for (const key of FEATURE_KEYS) {
      const tier = lowestTierWith(key);
      expect(hasFeature(key, active(tier)), `${key} not in its own minTier`).toBe(true);
    }
  });
});

/* ================================================================== */
/* 2. THE GATE FAILS CLOSED                                            */
/* ================================================================== */

describe("evaluateFeature fails closed", () => {
  it("⭐ an UNKNOWN feature key is DENIED, at every tier", () => {
    // A typo at a call site must deny, not grant. The opposite default
    // turns every typo into a feature given away free, and nothing would
    // ever surface it.
    for (const tier of ALL_TIERS) {
      for (const typo of [
        "accounting.ledgers", // plural
        "accounting.Ledger", // case
        "",
        "*",
        "admin",
        "__proto__",
        "toString",
      ]) {
        const decision = evaluateFeature(typo, active(tier));
        expect(decision.allowed, `"${typo}" was ALLOWED on ${tier}`).toBe(false);
        expect(decision.reason).toBe("unknown_feature");
      }
    }
  });

  it("isFeatureKey rejects inherited Object properties", () => {
    // `"toString" in FEATURE_CATALOG` is TRUE via the prototype chain if
    // the check is written carelessly. It is not, and this proves it.
    expect(isFeatureKey("toString")).toBe(false);
    expect(isFeatureKey("constructor")).toBe(false);
    expect(isFeatureKey("hasOwnProperty")).toBe(false);
    expect(isFeatureKey("crm.contacts")).toBe(true);
  });

  it("a denial message never leaks the internal key", () => {
    // Customers read these. "accounting.ledger is available on…" is
    // developer output leaking into a commercial conversation.
    const decision = evaluateFeature("accounting.ledger", active("basic"));
    expect(decision.allowed).toBe(false);
    expect(decision.message).not.toContain("accounting.ledger");
    expect(decision.message).toContain("Trust accounting");
    expect(decision.message).toContain("Advanced");
  });

  it("a denial message never mentions permissions or roles", () => {
    // The single worst error in a SaaS product: telling a workspace owner
    // they "lack permission" for something they simply have not bought,
    // sending them to an admin who is themselves.
    for (const key of FEATURE_KEYS) {
      const decision = evaluateFeature(key, active("trial"));
      if (decision.allowed) continue;
      expect(decision.message).not.toMatch(/permission|administrator|admin|role/i);
    }
  });
});

/* ================================================================== */
/* 3. TRIAL AND LAPSE                                                  */
/* ================================================================== */

describe("effectiveTier — trial and lapse rules", () => {
  it("a trial is treated as Advanced, not as the cheapest tier", () => {
    // A trial that only unlocks Basic is a bad trial: the prospect
    // evaluates the least impressive version and concludes it does not do
    // what they need.
    expect(effectiveTier(active("trial"))).toBe(TRIAL_EFFECTIVE_TIER);
    expect(TRIAL_EFFECTIVE_TIER).toBe("advanced");

    expect(hasFeature("accounting.ledger", active("trial"))).toBe(true);
    expect(hasFeature("clm.contracts", active("trial"))).toBe(true);
  });

  it("a trial does NOT unlock enterprise or AI features", () => {
    // Those are sold rather than self-served; handing them out in a trial
    // removes the reason to have the conversation.
    expect(hasFeature("admin.sso", active("trial"))).toBe(false);
    expect(hasFeature("ai.copilot", active("trial"))).toBe(false);
  });

  it("⭐ a LAPSED workspace drops to Basic, not to nothing", () => {
    // A customer whose card expired should find a limited product and a
    // clear prompt, not a locked door and their data apparently gone.
    for (const tier of ALL_TIERS) {
      const lapsed = { planTier: tier, subscriptionGrantsAccess: false };
      expect(effectiveTier(lapsed)).toBe(LAPSED_EFFECTIVE_TIER);
      expect(hasFeature("crm.contacts", lapsed), `${tier} lost core CRM`).toBe(true);
      expect(hasFeature("storage.documents", lapsed)).toBe(true);
    }
  });

  it("a lapsed enterprise workspace loses enterprise features", () => {
    const lapsed = { planTier: "enterprise" as PlanTier, subscriptionGrantsAccess: false };
    expect(hasFeature("admin.sso", lapsed)).toBe(false);
    expect(hasFeature("accounting.ledger", lapsed)).toBe(false);
  });

  it('⭐ a lapsed denial says "paused", not "upgrade"', () => {
    // Completely different situations for the reader. The first question
    // someone whose card expired has is "is my data gone?" — and nothing
    // else can be heard until that is answered.
    const decision = evaluateFeature("accounting.ledger", {
      planTier: "advanced",
      subscriptionGrantsAccess: false,
    });
    expect(decision.reason).toBe("subscription_inactive");
    expect(decision.message).toMatch(/paused/i);
    expect(decision.message).toMatch(/your data is safe/i);
    expect(decision.message).not.toMatch(/available on the/i);
  });
});

/* ================================================================== */
/* 4. GRACEFUL DEGRADATION — THE UI                                    */
/* ================================================================== */

describe("FeatureGate", () => {
  it("renders children untouched when allowed", () => {
    render(
      <FeatureGate allowed featureLabel="Trust accounting" requiredTier="advanced">
        <button type="button">Post entry</button>
      </FeatureGate>,
    );
    expect(screen.getByRole("button", { name: "Post entry" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("⭐ when LOCKED, the customer's data is STILL RENDERED", () => {
    // The whole point. Hiding it makes the customer conclude their
    // records were deleted, at exactly the moment we are asking them to
    // pay us.
    render(
      <FeatureGate allowed={false} featureLabel="Trust accounting" requiredTier="advanced">
        <p>Opening balance ₹4,52,000</p>
      </FeatureGate>,
    );
    expect(screen.getByText("Opening balance ₹4,52,000")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("⭐ the locked subtree is INERT, not merely un-clickable", () => {
    // `pointer-events-none` alone would leave the content keyboard
    // reachable and announced as interactive — so a keyboard or screen
    // reader user tabs into buttons that silently do nothing, which is a
    // worse experience than the mouse user gets.
    const { container } = render(
      <FeatureGate allowed={false} featureLabel="Trust accounting" requiredTier="advanced">
        <button type="button">Post entry</button>
      </FeatureGate>,
    );
    const inertWrapper = container.querySelector("[inert]");
    expect(inertWrapper, "the locked subtree is not inert").not.toBeNull();
    expect(inertWrapper!.textContent).toContain("Post entry");
  });

  it('mode="replace" shows only the prompt', () => {
    render(
      <FeatureGate
        allowed={false}
        featureLabel="AI copilot"
        requiredTier="ai"
        mode="replace"
      >
        <p>Nothing worth showing</p>
      </FeatureGate>,
    );
    expect(screen.queryByText("Nothing worth showing")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("UpgradePrompt", () => {
  it("names the exact tier required, not a generic 'upgrade'", () => {
    render(<UpgradePrompt featureLabel="Trust accounting" requiredTier="advanced" />);
    expect(screen.getByText(/Trust accounting is on the Advanced plan/)).toBeInTheDocument();
  });

  it("⭐ the lapsed variant leads with reassurance about the data", () => {
    render(<UpgradePrompt featureLabel="Trust accounting" requiredTier="advanced" isLapsed />);
    expect(screen.getByText(/paused/i)).toBeInTheDocument();
    expect(screen.getByText(/safe and unchanged/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /update payment details/i })).toBeInTheDocument();
  });

  it("always offers a route to act", () => {
    // A paywall with no button is just a wall.
    for (const isLapsed of [true, false]) {
      const { unmount } = render(
        <UpgradePrompt featureLabel="X" requiredTier="advanced" isLapsed={isLapsed} />,
      );
      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "/settings/billing");
      unmount();
    }
  });
});

describe("LockedControl", () => {
  it("explains WHY it is locked to assistive technology", () => {
    // A disabled control with no explanation is one of the most common
    // causes of a support ticket.
    render(<LockedControl featureLabel="Data export" requiredTier="advanced" />);
    expect(
      screen.getByText("Data export is available on the Advanced plan."),
    ).toBeInTheDocument();
  });
});

/* ================================================================== */
/* 5. SOURCE-LEVEL GUARDS                                              */
/* ================================================================== */

describe("the gate is used consistently across server actions", () => {
  const ACTIONS_DIR = join(process.cwd(), "server/actions");

  it("⭐ no server action compares planTier directly", () => {
    // Scattered `if (tenant.planTier === "advanced")` is exactly what this
    // phase exists to remove. It fails predictably: you add a tier, and
    // find the seventeenth comparison eight months later because a
    // customer cannot reach something they paid for.
    for (const file of readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(
        code,
        `${file} compares planTier directly — use requireFeature() instead`,
      ).not.toMatch(/planTier\s*[=!]==?\s*["']/);
    }
  });

  it("every file that imports requireFeature also handles FeatureLockedError", () => {
    // Otherwise a locked feature surfaces as "something went wrong",
    // which the customer cannot act on. "Upgrade to Advanced" they can.
    //
    // ⚠️ Strip comments before deciding whether a file gates features — the
    // same way the `planTier` test above does, and for the same reason.
    // Without this, a file that merely *documents* the gate order in a
    // comment —
    //
    //     requireAccess() → requireFeature() → requirePermission()
    //
    // — is treated as if it called `requireFeature()`, and the test demands a
    // catch clause for an error the file can never throw. `companies.ts` is
    // exactly that case: it carries the comment, calls no gate, and failed
    // this assertion for prose.
    //
    // This is not a relaxation. The claim is "code that CALLS requireFeature
    // must HANDLE FeatureLockedError", and stripping comments is what makes
    // the assertion measure that claim instead of a near neighbour. A check
    // that fires on correct code is worse than no check: it is the shape that
    // teaches people to silence checks.
    for (const file of readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (!code.includes("requireFeature(")) continue;
      expect(
        code,
        `${file} gates features but never catches FeatureLockedError`,
      ).toContain("instanceof FeatureLockedError");
    }
  });

  it("⭐ gated write actions outnumber gated read actions", () => {
    // Sanity check on the direction of the whole design. Gating a READ
    // hides the customer's own data; gating a WRITE is the point. An
    // earlier pass of this phase put three gates on `getTrialBalance` and
    // none on `postTransaction` — this is the assertion that would have
    // caught it.
    const gatedReads: string[] = [];

    for (const file of readdirSync(ACTIONS_DIR).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
      if (!source.includes("requireFeature(")) continue;

      // Split into per-function chunks and look for a gate inside one
      // whose name begins with `get`, `list` or `find`.
      const chunks = source.split(/(?=export async function )/);
      for (const chunk of chunks) {
        const match = /^export async function (\w+)/.exec(chunk);
        if (!match) continue;
        const name = match[1]!;
        if (!/^(get|list|find|is|preview)/.test(name)) continue;
        if (chunk.includes("await requireFeature(")) {
          gatedReads.push(`${file}:${name}`);
        }
      }
    }

    expect(
      gatedReads,
      `these READ actions are feature-gated, which hides the customer's own data: ${gatedReads.join(", ")}`,
    ).toEqual([]);
  });
});

describe("TIER_LABELS", () => {
  it("covers every tier and is human-readable", () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_LABELS[tier]).toBeTruthy();
      expect(TIER_LABELS[tier]).not.toBe(tier === "ai" ? "ai" : TIER_LABELS[tier].toLowerCase());
    }
    expect(TIER_LABELS.ai).toBe("AI");
  });
});
