/**
 * Ordence — 🔴🔴🔴 WHOSE AI CREDITS · 0115
 * Version: v1.72.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT, AND IT WAS ONE LINE
 * ══════════════════════════════════════════════════════════════════════
 * `0105` built everything: a credential row per workspace per provider,
 * the key in `vault_secrets` under AES-256-GCM, a settings screen, and
 * `budget_scope` threaded through every call precisely so that *"a tenant
 * paying for their own Groq key must not spend the platform's Groq
 * budget"*.
 *
 * 🔴 AND THE RESOLVER STARTED FROM THE PLATFORM SET:
 *
 *     const byProvider = { ...platform.byProvider };
 *
 * So a workspace that had configured Groq and not Google reached Google
 * ON ORDENCE'S KEY. Not as a fallback anybody chose — as the shape of the
 * merge. Every 0105 test passed throughout, because they all tested that
 * a tenant key OVERRIDES, and it does.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCredentialPolicy,
  parseAiCredentialPolicy,
  platformKeysPermitted,
  byoRefusal,
  DEFAULT_AI_CREDENTIAL_POLICY,
  AI_CREDENTIAL_POLICIES,
  type ProviderCredentialSet,
} from "@/lib/ai/credentials";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * ⚠️ COMMENTS STRIPPED, FOR THE REASON THE REACHABILITY GATE LEARNED THE
 * HARD WAY. `server/ai/credentials.ts` now carries a paragraph explaining
 * that it USED TO say `{ ...platform.byProvider }`. An assertion over raw
 * text would read that explanation as the code it is warning about, and
 * the better the comment, the more certainly the test fails.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const cred = (id: string, source: "platform" | "tenant") => ({
  providerId: id,
  apiKey: "k",
  accountId: null,
  source,
  budgetScope: source === "platform" ? "platform" : "tenant:t1",
});

const platform: ProviderCredentialSet = {
  byProvider: {
    groq: cred("groq", "platform"),
    google: cred("google", "platform"),
    cohere: cred("cohere", "platform"),
  },
  unusable: [
    { providerId: "cloudflare_workers_ai", source: "platform", note: "half configured" },
  ],
};

const tenant: ProviderCredentialSet = {
  byProvider: { groq: cred("groq", "tenant") },
  unusable: [],
};

/* ================================================================== */
describe("🔴🔴🔴 byo_required does not merge the platform set at all", () => {
  it("🔴 a provider the workspace has NOT configured is simply absent", () => {
    const set = applyCredentialPolicy({ policy: "byo_required", platform, tenant });
    expect(Object.keys(set.byProvider).sort()).toEqual(["groq"]);
    /** The exact hole: google was reachable on our key before 0115. */
    expect(set.byProvider.google).toBeUndefined();
    expect(set.byProvider.cohere).toBeUndefined();
  });

  it("🔴 and the one it HAS configured is its own key, not ours", () => {
    const set = applyCredentialPolicy({ policy: "byo_required", platform, tenant });
    expect(set.byProvider.groq?.source).toBe("tenant");
  });

  /**
   * ⚠️ THE `unusable` NOTES GO TOO. Telling a bring-your-own workspace
   * that "CF_AI_TOKEN is set in this deployment but CLOUDFLARE_ACCOUNT_ID
   * is not" leaks OUR deployment's configuration into THEIR settings
   * screen, about a problem they cannot act on.
   */
  it("⚠️ the platform's own misconfiguration notes are not leaked to them", () => {
    const set = applyCredentialPolicy({ policy: "byo_required", platform, tenant });
    expect(set.unusable).toHaveLength(0);
  });

  it("⭐ a workspace with no keys at all gets an empty set, not ours", () => {
    const set = applyCredentialPolicy({
      policy: "byo_required",
      platform,
      tenant: { byProvider: {}, unusable: [] },
    });
    expect(Object.keys(set.byProvider)).toHaveLength(0);
  });
});

/* ================================================================== */
describe("⚠️ the other two policies, and how they differ", () => {
  it("platform_allowed is the pre-0115 behaviour, exactly", () => {
    const set = applyCredentialPolicy({ policy: "platform_allowed", platform, tenant });
    expect(Object.keys(set.byProvider).sort()).toEqual(["cohere", "google", "groq"]);
    /** Theirs still wins where they have one. */
    expect(set.byProvider.groq?.source).toBe("tenant");
    expect(set.byProvider.google?.source).toBe("platform");
  });

  /**
   * ⚠️ `byo_preferred` MERGES TOO, AND THAT IS NOT A LOOPHOLE. The
   * difference is not in this function: it is that every platform-key
   * call under that policy is metered and shown to the customer, so a
   * workspace migrating can see in numbers what it has not yet moved.
   */
  it("byo_preferred merges, and the difference is that it is measured", () => {
    const set = applyCredentialPolicy({ policy: "byo_preferred", platform, tenant });
    expect(set.byProvider.google?.source).toBe("platform");
    expect(platformKeysPermitted("byo_preferred")).toBe(true);
    expect(platformKeysPermitted("byo_required")).toBe(false);
  });
});

/* ================================================================== */
describe("🔴 an unknown policy is the STRICT one, not the permissive one", () => {
  /**
   * 🔴 A `switch` WITH A DEFAULT BRANCH IS HOW THIS GOES WRONG. If an
   * unrecognised value fell through to "allow the platform keys", then a
   * typo, a truncated column, or a row written before the CHECK existed
   * would silently mean the opposite of what it says.
   *
   * The failure mode chosen instead is a workspace being told to add a
   * key it may already have — noticed in minutes — rather than money
   * leaving an account nobody is watching.
   */
  it("defaults to byo_required", () => {
    expect(DEFAULT_AI_CREDENTIAL_POLICY).toBe("byo_required");
  });

  it.each([
    ["byo-required", "a hyphen instead of an underscore"],
    ["BYO_REQUIRED", "the wrong case"],
    ["", "an empty column"],
    [null, "a null"],
    [undefined, "a missing column"],
    ["platform-allowed", "a misspelling of the permissive one"],
  ])("%s (%s) resolves to byo_required", (value) => {
    expect(parseAiCredentialPolicy(value)).toBe("byo_required");
  });

  it("⭐ and every real value survives the round trip", () => {
    for (const p of AI_CREDENTIAL_POLICIES) {
      expect(parseAiCredentialPolicy(p)).toBe(p);
    }
  });
});

/* ================================================================== */
describe("⭐ the refusal names the fix and never says 'unavailable'", () => {
  /**
   * 🔴 "The AI assistant is unavailable" is indistinguishable from an
   * outage on our side, so the customer raises a ticket about our product
   * for a key only they can add — and we cannot see it, cannot test it
   * and must not read it.
   */
  it("names the screen when nothing is configured", () => {
    const msg = byoRefusal(0);
    expect(msg).toMatch(/Settings . AI assistant/);
    expect(msg).toMatch(/does not fall back/i);
    expect(msg).not.toMatch(/^AI is unavailable/i);
  });

  it("says something different when they have keys but none is working", () => {
    expect(byoRefusal(2)).toMatch(/last failure is shown against it/i);
  });
});

/* ================================================================== */
describe("🔴 the resolver and the one door actually use it", () => {
  it("🔴 the resolver no longer seeds from the platform set", () => {
    const src = codeOnly(read("server/ai/credentials.ts"));
    /**
     * The exact line 0115 exists to delete. The file still DESCRIBES it
     * in a comment, which is why this reads stripped source.
     */
    expect(src).not.toContain("{ ...platform.byProvider }");
    expect(src).toContain("applyCredentialPolicy");
  });

  it("⚠️ and the schema-missing path honours the policy too", () => {
    /**
     * If somebody has been told their workspace spends only its own
     * keys, a missing 0105 table must not quietly hand them ours.
     */
    const src = read("server/ai/credentials.ts");
    /**
     * ⚠️ ANCHORED ON THE CREDENTIALS FALLBACK, NOT THE FIRST
     * `isSchemaMissingError` IN THE FILE — the policy read above it has
     * its own, and slicing from that would test the wrong branch.
     */
    const marker = "Today's behaviour, exactly";
    const fallback = src.slice(src.indexOf(marker), src.indexOf(marker) + 900);
    expect(fallback).toContain("applyCredentialPolicy");
    expect(fallback).toMatch(/EXCEPT UNDER .byo_required./);
  });

  it("⭐ every tenant AI call is metered at the single door", () => {
    const src = read("server/ai/chat.ts");
    expect(src).toContain("recordChatOutcome");
    /** Including the attempts that failed before a later provider won. */
    expect(src).toContain("attempts: response.attempts");
  });

  it("🔴 and a bring-your-own refusal is recorded, not just returned", () => {
    const src = read("server/ai/chat.ts");
    const refusal = src.slice(src.indexOf("platformKeysPermitted(policy)"));
    expect(refusal.slice(0, 600)).toContain("recordChatOutcome");
    expect(refusal.slice(0, 900)).toContain("byoRefusal");
  });
});

/* ================================================================== */
describe("⚠️ metering fails soft, and says so when it does", () => {
  const src = read("server/ai/usage.ts");

  /**
   * 🔴 A METERING WRITE MUST NEVER TAKE DOWN THE THING IT IS MEASURING.
   * The customer's answer is already in hand, and discarding it to
   * protect a statistic is the wrong trade by a wide margin.
   */
  it("swallows its own errors", () => {
    expect(src).toMatch(/catch \(err\)/);
    expect(src).toMatch(/never take down the thing it is measuring/i);
  });

  it("⚠️ but logs a marker, because a silent undercount is how billing goes wrong", () => {
    expect(src).toContain("[ai-usage]");
    expect(src).toMatch(/silent undercount/i);
  });

  /**
   * ⚠️ A `misconfigured` ATTEMPT NEVER REACHED THE NETWORK, so it is not
   * spend. `lib/ai/client.ts` already makes that distinction for the
   * circuit breaker and it is the same distinction here.
   */
  it("does not record a misconfigured attempt as spend", () => {
    expect(src).toMatch(/kind === "misconfigured"/);
  });

  it("⚠️ and undefined tokens stay NULL rather than becoming zero", () => {
    expect(src).toMatch(/UNDEFINED IS NOT ZERO/i);
    expect(src).toMatch(/=== null \|\| v === undefined/);
  });
});

/* ================================================================== */
describe("⭐ only Ordence can change the policy, and the customer can see it", () => {
  it("the platform console has the control and demands a reason", () => {
    const src = read("server/platform/configuration.ts");
    expect(src).toContain("setAiCredentialPolicy");
    const fn = src.slice(src.indexOf("setAiCredentialPolicySchema"));
    expect(fn.slice(0, 900)).toMatch(/\.min\(\s*10/);
  });

  it("🔴 moving a workspace ONTO our keys is audited louder than moving them off", () => {
    const src = read("server/platform/configuration.ts");
    const fn = src.slice(src.indexOf("export async function setAiCredentialPolicy"));
    expect(fn).toMatch(/policy === "platform_allowed" \? "warning" : "notice"/);
  });

  it("⭐ the customer's screen shows the policy and the split, with no switch", () => {
    const page = read("app/(crm)/settings/ai/page.tsx");
    expect(page).toContain("getAiSpend");
    expect(page).toContain("AiSpendPanel");
    const panel = read("components/ai/spend-panel.tsx");
    /** Shown without a control: they cannot move themselves onto our keys. */
    expect(panel.replace(/\s+\*?\s*/g, " ")).toMatch(
      /A workspace cannot move itself onto Ordence.s keys/i,
    );
    /** And the number that should be zero is called out when it is not. */
    expect(panel).toMatch(/This should be zero on this policy/);
  });
});
