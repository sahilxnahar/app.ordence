/**
 * Ordence — PER-TENANT AI PROVIDER CREDENTIALS
 * Batch 0105 · v1.65.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS BATCH FIXED, AND THE TEST THAT WOULD HAVE CAUGHT IT
 * ══════════════════════════════════════════════════════════════════════
 * `lib/ai/client.ts` read `process.env[provider.envVar]` in two places
 * and there was no tenant dimension in the path at all. Every workspace
 * shared one key, one budget and one breaker.
 *
 * ⭐ The test that would have caught it is not "does the resolver
 * exist". It is `sends the key it was handed, not the one in the
 * environment` in section 2 — a behavioural assertion on the
 * Authorization header actually put on the wire. Everything else in this
 * file is scaffolding around that one.
 *
 * ⚠️ AND SECTION 1 IS THE ONE THAT MATTERS MOST. If a tenant's own
 * open-lane key can reach tenant data by ANY path, nothing else here is
 * worth anything.
 *
 * ⚠️ PROPERTIES, NOT SHAPES. Nothing below pins a provider count, a
 * total, an id or a suffix. Adding a provider to the registry, renaming
 * a label or changing a rate limit must not fail a single assertion
 * here — five correct changes have already been failed by counts in this
 * codebase.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { AI_PROVIDERS, PROVIDERS_BY_ID } from "@/lib/ai/providers";
import {
  PLATFORM_ACCOUNT_ID_ENV,
  PLATFORM_BUDGET_SCOPE,
  budgetScopeFor,
  classifyProviderFailure,
  credentialCompleteness,
  explainAllAttempts,
  explainAttempt,
  isMissingAiCredentialSchema,
  laneForCredential,
  providerStateKey,
  requiresAccountId,
  routerFailureKind,
  urlIsFullyResolved,
  type AttemptRecord,
  type ProviderCredential,
  type ProviderCredentialSet,
} from "@/lib/ai/credentials";
import { chatCompletion, platformCredentialSet } from "@/lib/ai/client";
import { aiProviderCredentials } from "@/db/schema/ai-credentials";

/* ================================================================== */
/* SCAFFOLDING                                                         */
/* ================================================================== */

const OPEN_PROVIDERS = AI_PROVIDERS.filter((p) => p.lane === "open");
const CONFIDENTIAL_PROVIDERS = AI_PROVIDERS.filter(
  (p) => p.lane === "confidential",
);

function credentialFor(
  providerId: string,
  source: "tenant" | "platform",
  tenantId: string | null = "11111111-1111-1111-1111-111111111111",
  accountId: string | null = null,
): ProviderCredential {
  return {
    providerId,
    apiKey: `key-for-${providerId}-${source}`,
    accountId: accountId ?? (requiresAccountId(providerId) ? "acct-123" : null),
    source,
    budgetScope: budgetScopeFor(source, tenantId),
  };
}

function setOf(...credentials: ProviderCredential[]): ProviderCredentialSet {
  return {
    byProvider: Object.fromEntries(credentials.map((c) => [c.providerId, c])),
    unusable: [],
  };
}

/** Every AI provider env var, so a test can start from a clean slate. */
const ALL_ENV_KEYS = [
  ...new Set(AI_PROVIDERS.map((p) => p.envVar)),
  PLATFORM_ACCOUNT_ID_ENV,
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ALL_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ALL_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

/** A fetch that answers every provider identically, recording the calls. */
function stubFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  });
  return calls;
}

function okResponse(content = "answered"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const MESSAGES = [{ role: "user" as const, content: "hello" }];

/* ================================================================== */
/* 1. THE LANE — the assertion the whole batch exists to preserve      */
/* ================================================================== */

describe("⭐ a tenant's own key does not change what a provider may see", () => {
  it("gives a credential the PROVIDER's lane, whoever supplied it", () => {
    // The signature takes a source and discards it. This asserts the
    // discarding, over the whole registry, for both sources.
    for (const provider of AI_PROVIDERS) {
      expect(laneForCredential(provider, "tenant")).toBe(provider.lane);
      expect(laneForCredential(provider, "platform")).toBe(provider.lane);
    }
  });

  it("🔴 refuses tenant data even when the tenant supplied every open-lane key", async () => {
    // The single most important behaviour in this file. Every open-lane
    // provider is configured ON THE CUSTOMER'S OWN KEY, healthy and
    // idle — and the answer is still no.
    const calls = stubFetch(() => okResponse());

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "tenant",
      credentials: setOf(
        ...OPEN_PROVIDERS.map((p) => credentialFor(p.id, "tenant")),
      ),
    });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.reason).toMatch(/will not be sent/i);
    // 🔴 And nothing was sent anywhere. A refusal that still made the
    // request would be a leak with an apology attached.
    expect(calls).toHaveLength(0);
  });

  it("does let a tenant's own CONFIDENTIAL-lane key carry tenant data", async () => {
    // ⭐ The answer to "it is my data and my key" is a link, not a
    // refusal. If this ever fails, the feature has become a no.
    const provider = CONFIDENTIAL_PROVIDERS[0]!;
    const calls = stubFetch(() => okResponse());

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "tenant",
      credentials: setOf(credentialFor(provider.id, "tenant")),
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.credentialSource).toBe("tenant");
    expect(calls).toHaveLength(1);
  });

  it("stores no per-tenant lane, override or allow flag on the credential row", () => {
    // A column like this is exactly how the rule would be reversed by a
    // later hurried edit. Asserted on the schema object rather than on
    // the SQL text, so renaming the migration cannot hide it.
    const columns = Object.keys(aiProviderCredentials);
    for (const name of columns) {
      expect(
        /lane|confidential|override|allowTenant|trainOn/i.test(name),
        `ai_provider_credentials.${name} looks like a per-tenant lane control`,
      ).toBe(false);
    }
  });
});

/* ================================================================== */
/* 2. THE KEY ACTUALLY PUT ON THE WIRE                                 */
/* ================================================================== */

describe("⭐ the credential that is used is the credential that was resolved", () => {
  it("🔴 sends the key it was handed, not the one in the environment", async () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT.
    const provider = OPEN_PROVIDERS[0]!;
    process.env[provider.envVar] = "PLATFORM-KEY-THAT-MUST-NOT-BE-SENT";

    const calls = stubFetch(() => okResponse());
    const tenantCredential = credentialFor(provider.id, "tenant");

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      credentials: setOf(tenantCredential),
    });

    expect(response.ok).toBe(true);
    const auth = String(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
    );
    expect(auth).toContain(tenantCredential.apiKey);
    expect(auth).not.toContain("PLATFORM-KEY-THAT-MUST-NOT-BE-SENT");
  });

  it("falls back to the platform environment when nothing is injected", async () => {
    // Unchanged behaviour for genuinely tenant-less work, and the reason
    // the injection is optional rather than required.
    const provider = OPEN_PROVIDERS[0]!;
    process.env[provider.envVar] = "PLATFORM-KEY";

    const calls = stubFetch(() => okResponse());

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
    });

    expect(response.ok).toBe(true);
    if (response.ok) expect(response.credentialSource).toBe("platform");
    expect(
      String((calls[0]!.init.headers as Record<string, string>).Authorization),
    ).toContain("PLATFORM-KEY");
  });

  it("🔴 interpolates the CREDENTIAL's account id, never the platform's", async () => {
    // A tenant's Cloudflare token pointed at Ordence's account id is a
    // customer's key sent to our account. It fails — after being sent.
    const provider = CONFIDENTIAL_PROVIDERS.find((p) =>
      requiresAccountId(p.id),
    )!;
    process.env[PLATFORM_ACCOUNT_ID_ENV] = "ORDENCE-ACCOUNT";

    const calls = stubFetch(() => okResponse());

    await chatCompletion({
      messages: MESSAGES,
      sensitivity: "tenant",
      credentials: setOf(
        credentialFor(provider.id, "tenant", "t-1", "CUSTOMER-ACCOUNT"),
      ),
    });

    expect(calls[0]!.url).toContain("CUSTOMER-ACCOUNT");
    expect(calls[0]!.url).not.toContain("ORDENCE-ACCOUNT");
  });

  it("a provider with no credential is simply not offered", async () => {
    // Not a failure — a provider not turned on. The router must never be
    // handed a provider it cannot call.
    const withKey = OPEN_PROVIDERS[0]!;
    const calls = stubFetch(() => okResponse());

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      credentials: setOf(credentialFor(withKey.id, "platform", null)),
    });

    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(new URL(withKey.baseUrl).host);
  });
});

/* ================================================================== */
/* 3. WHOSE BUDGET, WHOSE BREAKER                                      */
/* ================================================================== */

describe("⭐ budget and breaker follow the key, not the tenant", () => {
  it("names a different ledger for the platform and for each workspace", () => {
    const platform = budgetScopeFor("platform", null);
    const a = budgetScopeFor("tenant", "tenant-a");
    const b = budgetScopeFor("tenant", "tenant-b");

    expect(platform).toBe(PLATFORM_BUDGET_SCOPE);
    expect(new Set([platform, a, b]).size).toBe(3);
    for (const provider of AI_PROVIDERS) {
      const keys = [platform, a, b].map((s) => providerStateKey(s, provider.id));
      expect(new Set(keys).size).toBe(3);
    }
  });

  it("two workspaces sharing the PLATFORM key share one ledger", () => {
    // They share a quota, so they must share a count. Anything else
    // over-spends a free tier and produces the 429 the router exists to
    // avoid predicting wrongly.
    const provider = AI_PROVIDERS[0]!;
    const one = credentialFor(provider.id, "platform", null);
    const two = credentialFor(provider.id, "platform", null);
    expect(providerStateKey(one.budgetScope, provider.id)).toBe(
      providerStateKey(two.budgetScope, provider.id),
    );
  });

  it("🔴 refuses to name a budget for a tenant credential with no tenant", () => {
    // NOT a silent fold into the platform scope: that would make a
    // resolver bug invisible by charging somebody else for it.
    expect(() => budgetScopeFor("tenant", null)).toThrow(/tenant id/i);
  });

  it("🔴 a workspace's dead key does not trip the breaker for everyone else", async () => {
    // The failure this keying exists to prevent, asserted behaviourally
    // rather than by reading the key format.
    const provider = OPEN_PROVIDERS[0]!;
    const tenantId = "breaker-probe-tenant";

    stubFetch(() => new Response("upstream exploded", { status: 500 }));

    // Three consecutive failures on the WORKSPACE's own key opens the
    // breaker for that workspace. BREAKER_THRESHOLD is 3.
    for (let i = 0; i < 3; i++) {
      await chatCompletion({
        messages: MESSAGES,
        sensitivity: "open",
        maxRetries: 1,
        credentials: setOf(credentialFor(provider.id, "tenant", tenantId)),
      });
    }

    const theirs = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      maxRetries: 1,
      credentials: setOf(credentialFor(provider.id, "tenant", tenantId)),
    });
    expect(theirs.ok).toBe(false);
    // Nothing was sent: the breaker refused before the network.
    if (!theirs.ok) expect(theirs.attempts).toHaveLength(0);

    // ⭐ And the platform ledger is untouched, so everybody else is
    // still served. This is the assertion that matters.
    const platformCalls = stubFetch(() => okResponse());
    const ours = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      maxRetries: 1,
      credentials: setOf(credentialFor(provider.id, "platform", null)),
    });
    expect(ours.ok).toBe(true);
    expect(platformCalls.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 4. AN HONEST FAILURE                                                */
/* ================================================================== */

describe("⭐ the customer is told whose key failed and how", () => {
  it("separates a revoked key from a rate limit", () => {
    // The distinction the previous build collapsed. One clears in sixty
    // seconds; the other never clears until a person acts.
    expect(classifyProviderFailure(401, "")).toBe("auth");
    expect(classifyProviderFailure(403, "")).toBe("auth");
    expect(classifyProviderFailure(429, "slow down")).toBe("rate_limited");
    expect(classifyProviderFailure(402, "")).toBe("quota");
    expect(classifyProviderFailure(429, "you have exceeded your current quota")).toBe(
      "quota",
    );
    expect(classifyProviderFailure(503, "")).toBe("error");
    expect(classifyProviderFailure(null, "")).toBe("unreachable");
  });

  it("never promotes a wording to `auth`, only ever separates quota from rate", () => {
    // The prose heuristic must not be able to tell somebody to rotate a
    // key that was fine. Asserted as a property over the classifier
    // rather than over one example.
    for (const body of ["invalid api key", "unauthorized", "forbidden", "revoked"]) {
      expect(classifyProviderFailure(429, body)).not.toBe("auth");
      expect(classifyProviderFailure(500, body)).not.toBe("auth");
    }
  });

  it("trips the breaker on a dead key and not on a rate limit", () => {
    expect(routerFailureKind("rate_limited")).toBe("rate_limited");
    expect(routerFailureKind("auth")).toBe("error");
    expect(routerFailureKind("quota")).toBe("error");
    expect(routerFailureKind("unreachable")).toBe("timeout");
  });

  it("🔴 says the key is THEIRS when it is, and does not when it is not", () => {
    const provider = OPEN_PROVIDERS[0]!;
    const base = { providerId: provider.id, kind: "auth" as const, status: 401, detail: "" };

    const theirs = explainAttempt({ ...base, source: "tenant" });
    const ours = explainAttempt({ ...base, source: "platform" });

    expect(theirs).toMatch(/this workspace supplied/i);
    expect(theirs).toMatch(/Settings/);
    // ⚠️ And the reverse matters as much: a customer must not be sent to
    // a settings screen where they have entered nothing.
    expect(ours).toMatch(/ours to fix/i);
    expect(theirs).not.toBe(ours);
  });

  it("puts the failure the customer can act on first", () => {
    const [a, b] = OPEN_PROVIDERS;
    const attempts: AttemptRecord[] = [
      { providerId: a!.id, source: "platform", kind: "error", status: 500, detail: "" },
      { providerId: b!.id, source: "tenant", kind: "auth", status: 401, detail: "" },
    ];
    const sentence = explainAllAttempts(attempts);
    expect(sentence.indexOf(PROVIDERS_BY_ID[b!.id]!.label)).toBeLessThan(
      sentence.indexOf(PROVIDERS_BY_ID[a!.id]!.label),
    );
  });

  it("returns the attempts, with the source, from a failed request", async () => {
    const provider = OPEN_PROVIDERS[0]!;
    stubFetch(() => new Response("invalid api key", { status: 401 }));

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      maxRetries: 1,
      credentials: setOf(credentialFor(provider.id, "tenant", "attempts-probe")),
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.attempts.some((a) => a.source === "tenant")).toBe(true);
      expect(response.attempts.some((a) => a.kind === "auth")).toBe(true);
      expect(response.reason).toMatch(/this workspace supplied/i);
    }
  });

  it("🔴 reports a failure that a LATER provider papered over", async () => {
    // The half that is easy to skip: the router's failover succeeds and
    // the customer never learns the key they pay for has stopped
    // working. `attempts` is populated on the success path for this.
    const dead = OPEN_PROVIDERS[0]!;
    const alive = OPEN_PROVIDERS[1]!;
    const deadHost = new URL(dead.baseUrl).host;

    stubFetch((url) =>
      url.includes(deadHost)
        ? new Response("invalid api key", { status: 401 })
        : okResponse(),
    );

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      credentials: setOf(
        credentialFor(dead.id, "tenant", "papered-over"),
        credentialFor(alive.id, "platform", null),
      ),
    });

    expect(response.ok).toBe(true);
    expect(
      response.attempts.some((a) => a.providerId === dead.id && a.source === "tenant"),
    ).toBe(true);
  });

  it("🔴 never puts a key in an attempt record, on either path", async () => {
    // `AttemptRecord` is the only thing that leaves the client on a
    // failure, and it is stored (`last_failure_message`) and rendered.
    // The key must not be reachable from it.
    const provider = OPEN_PROVIDERS[0]!;
    const credential = credentialFor(provider.id, "tenant", "redaction-probe");
    stubFetch(() => new Response("invalid api key", { status: 401 }));

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "open",
      maxRetries: 1,
      credentials: setOf(credential),
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      const serialised = JSON.stringify({
        attempts: response.attempts,
        reason: response.reason,
      });
      expect(serialised).not.toContain(credential.apiKey);
    }
  });
});

/* ================================================================== */
/* 5. THE PAIR THAT MUST NOT BE HALF-ENTERED                           */
/* ================================================================== */

describe("⭐ a Cloudflare token without an account id is refused, not attempted", () => {
  it("knows which providers need a second value", () => {
    for (const provider of AI_PROVIDERS) {
      const needs = requiresAccountId(provider.id);
      // The property, not the list: a provider needs an account id
      // exactly when its base URL has a placeholder to fill.
      expect(needs).toBe(!urlIsFullyResolved(provider.baseUrl));
    }
  });

  it("refuses the half-entered pair with a sentence, and passes the complete one", () => {
    for (const provider of AI_PROVIDERS) {
      const half = credentialCompleteness(provider.id, true, null);
      const whole = credentialCompleteness(provider.id, true, "acct");
      expect(whole.complete).toBe(true);
      expect(half.complete).toBe(!requiresAccountId(provider.id));
      if (!half.complete) expect(half.note).toMatch(/account id/i);
    }
  });

  it("🔴 reports a half-configured platform Cloudflare as unusable, not as absent", async () => {
    // The bite named in the brief: with the token and no account id the
    // URL is malformed, the call fails, the router falls through, and
    // NOTHING REPORTS WHY.
    const provider = AI_PROVIDERS.find((p) => requiresAccountId(p.id))!;
    process.env[provider.envVar] = "a-token";
    // ⚠️ CLOUDFLARE_ACCOUNT_ID deliberately absent.

    const set = platformCredentialSet();
    expect(set.byProvider[provider.id]).toBeUndefined();
    const note = set.unusable.find((u) => u.providerId === provider.id);
    expect(note).toBeDefined();
    expect(note!.note).toMatch(/account id/i);
    expect(note!.note).toContain(PLATFORM_ACCOUNT_ID_ENV);
  });

  it("says so instead of claiming nothing is configured", async () => {
    const provider = AI_PROVIDERS.find((p) => requiresAccountId(p.id))!;
    process.env[provider.envVar] = "a-token";
    const calls = stubFetch(() => okResponse());

    const response = await chatCompletion({ messages: MESSAGES, sensitivity: "tenant" });

    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.reason).toMatch(/account id/i);
    expect(calls).toHaveLength(0);
  });

  it("🔴 never reaches the network with an unresolved account segment", async () => {
    // The last line of defence, on the only path that reaches the wire.
    const provider = AI_PROVIDERS.find((p) => requiresAccountId(p.id))!;
    const calls = stubFetch(() => okResponse());

    const response = await chatCompletion({
      messages: MESSAGES,
      sensitivity: "tenant",
      maxRetries: 1,
      credentials: setOf({
        providerId: provider.id,
        apiKey: "a-token",
        accountId: null, // routed around every other refusal
        source: "tenant",
        budgetScope: budgetScopeFor("tenant", "half-pair"),
      }),
    });

    expect(response.ok).toBe(false);
    expect(calls).toHaveLength(0);
    if (!response.ok) {
      expect(response.attempts.some((a) => a.kind === "misconfigured")).toBe(true);
    }
  });
});

/* ================================================================== */
/* 6. THE WIRING — no field is declared and read by nothing            */
/* ================================================================== */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** ⚠️ Comments mention every one of these names constantly. Only CODE
 *  counts, so comments are stripped before matching — the same thing
 *  `scripts/check-action-guards.mjs` does, and for the same reason:
 *  `throw new Error("call requirePermission")` is the same hole with a
 *  different quote mark. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe("⭐ every call site actually goes through the resolver", () => {
  it("🔴 leaves no direct `process.env[provider.envVar]` read outside the platform set", () => {
    // The two reads the brief named — client.ts:109 and :180 — are now
    // one, inside `platformCredentialSet`. This asserts nothing put
    // another one back.
    const source = stripComments(read("lib/ai/client.ts"));
    const reads = [...source.matchAll(/process\.env\[[^\]]*envVar[^\]]*\]/g)];
    expect(reads.length).toBe(1);
    const before = source.slice(0, reads[0]!.index);
    expect(before).toContain("export function platformCredentialSet");
  });

  it("calls chatCompletion from the client and its one wrapper, and nowhere else", () => {
    const offenders: string[] = [];
    for (const file of [...walk("app"), ...walk("lib"), ...walk("server")]) {
      if (file === "lib/ai/client.ts" || file === "server/ai/chat.ts") continue;
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const src = stripComments(read(file));
      if (/(?<!tenant)\bchatCompletion\s*\(/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ SCOPED TO THE ROUTING PATH, AND THE SCOPE IS THE HONEST PART.
   *
   * `lib/ai/conversation-memory.ts` and `lib/ai/patterns.ts` BOTH import
   * `@/db` today and both pass `check:boundaries`, because that gate
   * requires a module reaching the database to DECLARE a boundary — it
   * does not forbid the import. So "check:boundaries will fail an @/db
   * import under lib/ai" is not true of this tree, and asserting it here
   * would have failed on two files this batch never touched.
   *
   * ⭐ The rule that IS true, and is the one worth holding, is narrower:
   * the modules that decide and execute a provider call stay pure, so
   * the router remains testable as a function over a table and the
   * credential lookup stays somewhere it can be audited. Those five
   * files are named rather than globbed, so adding a sixth is a decision
   * somebody has to make here.
   */
  it("🔴 keeps the database out of the routing path, which is what makes injection necessary", () => {
    const ROUTING = [
      "lib/ai/client.ts",
      "lib/ai/credentials.ts",
      "lib/ai/router.ts",
      "lib/ai/providers.ts",
      "lib/ai/goal-planner.ts",
    ];
    for (const file of ROUTING) {
      const src = read(file).replace(/^\s*import\s+type\s+[^;]+;$/gm, "");
      expect(/from "@\/db"/.test(src), `${file} imports @/db`).toBe(false);
    }
  });

  it("stores the tenant's key in the vault and not on the credential row", () => {
    // The row is a preference; the secret is a secret. Two objects, two
    // sets of rules, and the looser one must not be able to hold a key.
    const action = stripComments(read("server/actions/ai-credentials.ts"));
    expect(action).toContain("putSecret");
    expect(action).toContain("eraseSecretsFor");
    // 🔴 No export here may return a value, so nothing may decrypt.
    expect(action).not.toContain("openSecret");
    expect(action).not.toContain("readForPerson");
  });

  it("🔴 records the outcome, so last_failure_kind is read at a decision point", () => {
    // The defect this codebase keeps producing is a column that is
    // declared, displayed and populated by nothing. These three columns
    // are written by the wrapper on both paths.
    const wrapper = stripComments(read("server/ai/chat.ts"));
    expect(wrapper).toContain("recordCredentialOutcome");
    expect(wrapper).toMatch(/outcome:\s*"failure"/);
    expect(wrapper).toMatch(/outcome:\s*"success"/);

    const resolver = stripComments(read("server/ai/credentials.ts"));
    // And read back: `disabled` decides whether the key is handed out at
    // all, which is a read that changes behaviour.
    expect(resolver).toMatch(/status === "disabled"/);
  });
});

/* ================================================================== */
/* 7. BEFORE 0105 IS APPLIED — the branch that usually goes untested   */
/* ================================================================== */

describe("⭐ the code surviving a database that has not run 0105 yet", () => {
  it("recognises a missing table and a half-applied one", () => {
    expect(isMissingAiCredentialSchema({ code: "42P01" })).toBe(true);
    expect(isMissingAiCredentialSchema({ code: "42703" })).toBe(true);
    expect(
      isMissingAiCredentialSchema(
        new Error('relation "ai_provider_credentials" does not exist'),
      ),
    ).toBe(true);
  });

  it("🔴 does NOT swallow a real error as a missing migration", () => {
    // The branch that makes the other one safe. A connection failure
    // silently downgraded to "the table is not there" would hide an
    // outage behind a feature notice.
    expect(isMissingAiCredentialSchema(new Error("connection terminated"))).toBe(
      false,
    );
    expect(isMissingAiCredentialSchema({ code: "42501" })).toBe(false);
    expect(isMissingAiCredentialSchema(null)).toBe(false);
  });
});

/* ================================================================== */
/* 8. THE RESOLVER ITSELF, OVER A FAKE TRANSACTION                     */
/* ================================================================== */

/**
 * ⚠️ NO DATABASE, AND THAT IS THE POINT RATHER THAN A COMPROMISE.
 *
 * `resolveProviderCredentials(tenantId, tx)` takes the transaction
 * handle, because `server/automation/agent-dispatch.ts` is already
 * inside one. That same seam lets the resolver be driven here over a
 * handle that returns rows we chose — including a handle that raises
 * 42P01, which is the branch that would otherwise never be entered until
 * the day somebody pushes code before SQL.
 *
 * "A verify file that has only ever been run on the passing case is not
 * a verify file." Both branches run below.
 */

import { getTableName } from "drizzle-orm";
import { sealSecret } from "@/server/vault/crypto";
import { vaultSecrets } from "@/db/schema/vault";
import {
  clearCredentialCache,
  resolveProviderCredentials,
} from "@/server/ai/credentials";

type Row = Record<string, unknown>;

/** A chainable stand-in for the Drizzle handle, answering by table. */
function fakeTx(rowsByTable: Record<string, Row[]>) {
  return {
    select() {
      let table = "";
      const builder = {
        from(t: unknown) {
          table = getTableName(t as Parameters<typeof getTableName>[0]);
          return builder;
        },
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        then<T>(
          resolve: (value: Row[]) => T,
          reject?: (reason: unknown) => T,
        ) {
          return Promise.resolve(rowsByTable[table] ?? []).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

/** A handle that fails the way a database without 0105 fails. */
function fakeTxMissingTable() {
  return {
    select() {
      const err = new Error(
        'relation "ai_provider_credentials" does not exist',
      ) as Error & { code?: string };
      err.code = "42P01";
      throw err;
    },
  };
}

describe("⭐ the resolver: this workspace first, then Ordence", () => {
  const VAULT_KEY = "VAULT_ENCRYPTION_KEY";
  const VAULT_PEPPER = "VAULT_BLIND_INDEX_PEPPER";
  let savedKey: string | undefined;
  let savedPepper: string | undefined;

  beforeEach(() => {
    savedKey = process.env[VAULT_KEY];
    savedPepper = process.env[VAULT_PEPPER];
    // ⚠️ A TEST VALUE, GENERATED HERE AND NEVER A REAL ONE. The real key
    // must never appear in a repository, a chat or a test fixture:
    // rotating it orphans every stored secret.
    process.env[VAULT_KEY] = "a".repeat(64);
    process.env[VAULT_PEPPER] = "p".repeat(48);
    clearCredentialCache();
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[VAULT_KEY];
    else process.env[VAULT_KEY] = savedKey;
    if (savedPepper === undefined) delete process.env[VAULT_PEPPER];
    else process.env[VAULT_PEPPER] = savedPepper;
    clearCredentialCache();
  });

  function vaultRowFor(ownerId: string, plaintext: string): Row {
    const sealed = sealSecret(plaintext, "api_credential");
    return {
      id: `secret-${ownerId}`,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      keyRef: sealed.keyRef,
      algorithm: sealed.algorithm,
      kind: "api_credential",
    };
  }

  it("🔴 falls back to the platform keys when 0105 has not been applied", async () => {
    const provider = OPEN_PROVIDERS[0]!;
    process.env[provider.envVar] = "ORDENCE-KEY";

    const resolved = await resolveProviderCredentials(
      "22222222-2222-2222-2222-222222222222",
      fakeTxMissingTable(),
    );

    // ⭐ Exactly today's behaviour: the assistant keeps working.
    expect(resolved.schemaReady).toBe(false);
    expect(resolved.set.byProvider[provider.id]?.source).toBe("platform");
    expect(resolved.set.byProvider[provider.id]?.apiKey).toBe("ORDENCE-KEY");
  });

  it("🔴 lets a real database error through rather than calling it a missing migration", async () => {
    const boom = {
      select() {
        const err = new Error("connection terminated unexpectedly") as Error & {
          code?: string;
        };
        err.code = "08006";
        throw err;
      },
    };
    await expect(
      resolveProviderCredentials("33333333-3333-3333-3333-333333333333", boom),
    ).rejects.toThrow(/connection terminated/);
  });

  it("uses the workspace's key for one provider and Ordence's for the rest", async () => {
    const mine = OPEN_PROVIDERS[0]!;
    const theirs = OPEN_PROVIDERS[1]!;
    process.env[mine.envVar] = "ORDENCE-KEY-FOR-MINE";
    process.env[theirs.envVar] = "ORDENCE-KEY-FOR-THEIRS";

    const tenantId = "44444444-4444-4444-4444-444444444444";
    const rowId = "row-1";

    const resolved = await resolveProviderCredentials(
      tenantId,
      fakeTx({
        [getTableName(aiProviderCredentials)]: [
          { id: rowId, providerId: mine.id, accountId: null, status: "active" },
        ],
        [getTableName(vaultSecrets)]: [vaultRowFor(rowId, "CUSTOMER-KEY")],
      }),
    );

    expect(resolved.schemaReady).toBe(true);

    // ⭐ THE FALLBACK IS PER PROVIDER, NOT ALL-OR-NOTHING.
    const ours = resolved.set.byProvider[theirs.id];
    const yours = resolved.set.byProvider[mine.id];
    expect(yours?.source).toBe("tenant");
    expect(yours?.apiKey).toBe("CUSTOMER-KEY");
    expect(ours?.source).toBe("platform");

    // And they spend different ledgers.
    expect(yours!.budgetScope).not.toBe(ours!.budgetScope);
    expect(yours!.budgetScope).toContain(tenantId);
  });

  it("🔴 skips a key the workspace switched off and hands back Ordence's", async () => {
    const provider = OPEN_PROVIDERS[0]!;
    process.env[provider.envVar] = "ORDENCE-KEY";
    const rowId = "row-2";

    const resolved = await resolveProviderCredentials(
      "55555555-5555-5555-5555-555555555555",
      fakeTx({
        [getTableName(aiProviderCredentials)]: [
          { id: rowId, providerId: provider.id, accountId: null, status: "disabled" },
        ],
        [getTableName(vaultSecrets)]: [vaultRowFor(rowId, "SWITCHED-OFF-KEY")],
      }),
    );

    expect(resolved.set.byProvider[provider.id]?.source).toBe("platform");
    expect(resolved.set.byProvider[provider.id]?.apiKey).toBe("ORDENCE-KEY");
  });

  it("keeps trying a key the router marked `failing`, because a person did not switch it off", async () => {
    // A key that failed once at 3am and works now must not need a human
    // to switch it back on.
    const provider = OPEN_PROVIDERS[0]!;
    const rowId = "row-3";

    const resolved = await resolveProviderCredentials(
      "66666666-6666-6666-6666-666666666666",
      fakeTx({
        [getTableName(aiProviderCredentials)]: [
          { id: rowId, providerId: provider.id, accountId: null, status: "failing" },
        ],
        [getTableName(vaultSecrets)]: [vaultRowFor(rowId, "RECOVERED-KEY")],
      }),
    );

    expect(resolved.set.byProvider[provider.id]?.source).toBe("tenant");
  });

  it("🔴 reports a half-entered Cloudflare pair without removing the working platform key", async () => {
    const provider = AI_PROVIDERS.find((p) => requiresAccountId(p.id))!;
    process.env[provider.envVar] = "ORDENCE-CF-TOKEN";
    process.env[PLATFORM_ACCOUNT_ID_ENV] = "ORDENCE-ACCOUNT";
    const rowId = "row-4";

    const resolved = await resolveProviderCredentials(
      "77777777-7777-7777-7777-777777777777",
      fakeTx({
        [getTableName(aiProviderCredentials)]: [
          // ⚠️ accountId null: the shape the database CHECK refuses, so
          // this can only arrive from an older row or a direct write.
          { id: rowId, providerId: provider.id, accountId: null, status: "active" },
        ],
        [getTableName(vaultSecrets)]: [vaultRowFor(rowId, "CUSTOMER-CF-TOKEN")],
      }),
    );

    expect(
      resolved.set.unusable.some(
        (u) => u.providerId === provider.id && u.source === "tenant",
      ),
    ).toBe(true);
    // ⭐ A broken entry of theirs must not remove a provider that was
    // working for them yesterday.
    expect(resolved.set.byProvider[provider.id]?.source).toBe("platform");
  });

  it("🔴 says the key cannot be read rather than pretending it is absent", async () => {
    // The commonest cause is a rotated VAULT_ENCRYPTION_KEY, which
    // orphans every stored secret at once. The customer must be told to
    // re-enter it, not shown "no provider configured".
    const provider = OPEN_PROVIDERS[0]!;
    const rowId = "row-5";
    const sealedUnderOldKey = vaultRowFor(rowId, "CUSTOMER-KEY");

    // Rotate. Same shape, different value.
    process.env[VAULT_KEY] = "b".repeat(64);
    clearCredentialCache();

    const resolved = await resolveProviderCredentials(
      "88888888-8888-8888-8888-888888888888",
      fakeTx({
        [getTableName(aiProviderCredentials)]: [
          { id: rowId, providerId: provider.id, accountId: null, status: "active" },
        ],
        [getTableName(vaultSecrets)]: [sealedUnderOldKey],
      }),
    );

    expect(resolved.set.byProvider[provider.id]).toBeUndefined();
    const note = resolved.set.unusable.find((u) => u.providerId === provider.id);
    expect(note?.note).toMatch(/could not be read|encryption key/i);
  });

  it("ignores a row for a provider the registry no longer knows", async () => {
    // A stale row must not take the whole assistant down for that
    // workspace.
    const resolved = await resolveProviderCredentials(
      "99999999-9999-9999-9999-999999999999",
      fakeTx({
        [getTableName(aiProviderCredentials)]: [
          { id: "row-6", providerId: "a_provider_we_removed", accountId: null, status: "active" },
        ],
        [getTableName(vaultSecrets)]: [],
      }),
    );
    expect(resolved.schemaReady).toBe(true);
    expect(resolved.set.byProvider["a_provider_we_removed"]).toBeUndefined();
  });
});
