/**
 * Ordence — ⭐ THE AI CLIENT
 * Version: v1.65.0-alpha  (was v0.76.0-alpha)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS SEPARATELY FROM THE ROUTER
 * ══════════════════════════════════════════════════════════════════════
 * The router (`lib/ai/router.ts`) is pure functions: given a set of
 * provider states, pick one. This file is the plumbing — it makes the
 * actual HTTP call, tracks the state the router reads, and handles
 * retries with exclusion.
 *
 * The router's header says "the decision lives there, and the plumbing
 * lives in client.ts where it belongs." This is that file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECURITY: THE CONFIDENTIAL LANE IS NEVER BYPASSED
 * ══════════════════════════════════════════════════════════════════════
 * If `sensitivity` is `tenant`, only confidential-lane providers are
 * eligible. The router enforces this — this file passes the sensitivity
 * through and never overrides it. A slow AI feature is an inconvenience;
 * a customer's contract in a training set is not recoverable.
 *
 * 🔴 AND A TENANT'S OWN KEY DOES NOT CHANGE THAT. Credentials are
 * injected below, and a tenant-supplied open-lane key is still an
 * open-lane key: `chooseProvider` filters by `provider.lane` and knows
 * nothing about who paid. See `laneForCredential()` in
 * `lib/ai/credentials.ts` for the whole argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHAT CHANGED IN THIS BATCH: THE KEY IS INJECTED, NOT LOOKED UP
 * ══════════════════════════════════════════════════════════════════════
 * This file used to read `process.env[provider.envVar]` in two places —
 * once to decide which providers exist, once to make the call — and
 * there was no tenant dimension in either. Every workspace shared one
 * key, one budget, one rate limit and one breaker.
 *
 * A workspace can now bring its own. The lookup that finds it reads the
 * database and the vault, so it CANNOT live here:
 *
 * 🔴 `lib/ai/*` MUST NOT IMPORT `@/db`. `npm run check:boundaries` would
 *    fail it and would be right to — `lib/ai/goal-planner.ts` is pure
 *    planning code that imports this module, and a database client
 *    dragged into that graph is dragged into everything downstream of it.
 *
 * ⭐ SO THE RESOLVED CREDENTIALS ARE PASSED IN AS DATA
 *   (`ChatRequest.credentials`). `server/ai/credentials.ts` produces
 *   them; `server/ai/chat.ts` is the wrapper every tenant-facing caller
 *   goes through. When nothing is injected this file falls back to
 *   `platformCredentialSet()` below, which is exactly the old behaviour
 *   and is the correct behaviour for genuinely tenant-less work.
 */

import "server-only";

import {
  chooseProvider,
  attemptOrder,
  afterSuccess,
  afterFailure,
  type RouterInput,
  type ProviderState,
} from "@/lib/ai/router";
import { AI_PROVIDERS, type AiProvider } from "@/lib/ai/providers";
import {
  PLATFORM_ACCOUNT_ID_ENV,
  PLATFORM_BUDGET_SCOPE,
  classifyProviderFailure,
  credentialCompleteness,
  explainAllAttempts,
  providerStateKey,
  requiresAccountId,
  routerFailureKind,
  urlIsFullyResolved,
  type AttemptRecord,
  type CredentialSource,
  type ProviderCredential,
  type ProviderCredentialSet,
  type UnusableProvider,
} from "@/lib/ai/credentials";
import { getRedis } from "@/lib/redis";

/* ------------------------------------------------------------------ */
/* STATE TRACKING                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ IN-MEMORY FALLBACK. On a single-instance deployment this is
 * sufficient. On a multi-instance deployment (Railway replicas), each
 * instance tracks its own view, which means the budget counts are
 * approximate — a provider may be slightly over or under its real usage.
 *
 * The Upstash Redis path below makes the counts shared. When Redis is
 * configured, state is read from and written to it; when it is not, the
 * in-memory map is used. Either way, the circuit breaker works: a
 * provider that is failing fails on every instance, and the breaker
 * opens on whichever instance observed the failures.
 *
 * ⭐⭐ THE MAP IS NOW KEYED BY (BUDGET SCOPE, PROVIDER), NOT BY PROVIDER.
 *
 * 🔴 THIS IS THE HALF OF THE FEATURE THAT IS EASY TO SKIP AND EXPENSIVE
 *    TO GET WRONG. A tenant paying for their own Groq key must not spend
 *    the platform's Groq budget, and a tenant whose own key is dead must
 *    not trip the platform's Groq breaker and take the provider out of
 *    rotation for every other workspace. Both directions are real; see
 *    `budgetScopeFor()`.
 *
 * ⚠️ The key SHAPE changed, so keys written by the previous build are
 *    never read again. They carry a five-minute TTL and disappear on
 *    their own. The worst case on deploy is one minute of counts
 *    starting from zero, which is the cold-start case the router already
 *    treats as "full budget, healthy" by design.
 */
const inMemoryState = new Map<string, ProviderState>();

const STATE_TTL = 300; // 5 minutes — long enough to track a budget window

const FRESH_STATE: ProviderState = {
  usedThisMinute: 0,
  usedToday: 0,
  consecutiveFailures: 0,
  breakerOpenUntil: 0,
};

async function readState(
  budgetScope: string,
  providerId: string,
): Promise<ProviderState> {
  const key = providerStateKey(budgetScope, providerId);
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<ProviderState>(key);
      if (raw) return raw;
    } catch {
      /* fall through to in-memory */
    }
  }
  return inMemoryState.get(key) ?? { ...FRESH_STATE };
}

async function writeState(
  budgetScope: string,
  providerId: string,
  state: ProviderState,
): Promise<void> {
  const key = providerStateKey(budgetScope, providerId);
  inMemoryState.set(key, state);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(key, state, { ex: STATE_TTL });
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * ⚠️ EACH PROVIDER'S STATE IS READ UNDER ITS OWN CREDENTIAL'S SCOPE. A
 * workspace on its own Groq key and Ordence's Gemini key reads two
 * different ledgers in one request, which is correct: they are two
 * different quotas.
 */
async function readAllStates(
  credentials: ProviderCredentialSet,
  providerIds: readonly string[],
): Promise<Record<string, ProviderState | undefined>> {
  const entries = await Promise.all(
    providerIds.map(async (id) => {
      const cred = credentials.byProvider[id];
      if (!cred) return [id, undefined] as const;
      return [id, await readState(cred.budgetScope, id)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/* ------------------------------------------------------------------ */
/* THE PLATFORM CREDENTIAL SET                                         */
/* ------------------------------------------------------------------ */

/**
 * ⭐ ORDENCE'S OWN KEYS, READ FROM THE ENVIRONMENT AT CALL TIME.
 *
 * ⚠️ AT CALL TIME, NOT AT MODULE LOAD, and this is not a style
 * preference. `server/vault/crypto.ts` sets out why: a module-level read
 * runs during `next build`, when secrets are legitimately absent, and
 * fails the build. It also freezes the value for the process lifetime,
 * which breaks rotation. The old code got this right and so does this.
 *
 * ⭐ IT ALSO NOW REFUSES A HALF-CONFIGURED CLOUDFLARE. `CF_AI_TOKEN`
 * without `CLOUDFLARE_ACCOUNT_ID` used to produce a provider that looked
 * configured, built a URL with an empty account segment, failed every
 * call, and reported nothing anywhere. It is now reported as UNUSABLE
 * with the reason, which is the difference between "the confidential
 * lane is off" and "the confidential lane is on and broken".
 */
export function platformCredentialSet(): ProviderCredentialSet {
  const byProvider: Record<string, ProviderCredential> = {};
  const unusable: UnusableProvider[] = [];

  // ⚠️ Read once per call, not once per provider, so a rotation cannot
  // land between two providers inside a single request.
  const accountId = process.env[PLATFORM_ACCOUNT_ID_ENV]?.trim() || null;

  for (const provider of AI_PROVIDERS) {
    const raw = process.env[provider.envVar];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key.length === 0) continue;

    const completeness = credentialCompleteness(provider.id, true, accountId);
    if (!completeness.complete) {
      unusable.push({
        providerId: provider.id,
        source: "platform",
        note:
          `${completeness.note} ${provider.envVar} is set in this ` +
          `deployment but ${PLATFORM_ACCOUNT_ID_ENV} is not.`,
      });
      continue;
    }

    byProvider[provider.id] = {
      providerId: provider.id,
      apiKey: key,
      accountId: requiresAccountId(provider.id) ? accountId : null,
      source: "platform",
      budgetScope: PLATFORM_BUDGET_SCOPE,
    };
  }

  return { byProvider, unusable };
}

/**
 * Which providers can actually be called with the credentials in hand.
 *
 * ⚠️ THIS REPLACES A `process.env` SCAN. The old version made "which
 * providers exist" a platform-wide fact; it is now a fact about the
 * caller's credentials, which is the entire point of the batch.
 */
function configuredProviderIds(credentials: ProviderCredentialSet): string[] {
  return AI_PROVIDERS.filter((p) => credentials.byProvider[p.id] !== undefined).map(
    (p) => p.id,
  );
}

/* ------------------------------------------------------------------ */
/* THE CHAT COMPLETION CALL                                            */
/* ------------------------------------------------------------------ */

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For tool messages: which tool call this is a response to. */
  tool_call_id?: string;
  /** For assistant messages that request tool calls. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type ChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatCompletionResult = {
  message: ChatMessage;
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

/**
 * The shape of an OpenAI-compatible chat completion response. Every
 * provider in the registry speaks this protocol.
 */
type OpenAIChatResponse = {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

/**
 * Make a single chat completion request to one provider.
 *
 * ⚠️ THE API KEY ARRIVES AS AN ARGUMENT AND IS NEVER STORED. It is never
 * logged, never serialised, never passed to the router, and never put in
 * an error message — `AiCallError` below carries the provider's RESPONSE
 * body, which cannot contain a request header.
 */
async function callProvider(
  provider: AiProvider,
  credential: ProviderCredential,
  messages: ChatMessage[],
  tools?: ChatTool[],
  temperature?: number,
): Promise<ChatCompletionResult> {
  /**
   * ⭐ THE ACCOUNT ID COMES FROM THE CREDENTIAL, NOT FROM `process.env`.
   *
   * 🔴 This line used to be `process.env.CLOUDFLARE_ACCOUNT_ID ?? ""`,
   * which meant a TENANT's Cloudflare token would have been interpolated
   * into ORDENCE'S account id — a customer's key pointed at our account.
   * That call fails, but it fails after being sent.
   */
  const baseUrl = provider.baseUrl.replace(
    "{account_id}",
    credential.accountId ?? "",
  );

  /**
   * 🔴 THE LAST LINE OF DEFENCE, ON THE ONLY PATH THAT REACHES THE
   * NETWORK. Everything above — the action, the constraint, the resolver
   * — refuses a half-entered Cloudflare pair. This one catches whatever
   * route around all three would otherwise produce a URL with an empty
   * account segment, a 404, and no explanation anywhere.
   */
  if (!urlIsFullyResolved(baseUrl) || (requiresAccountId(provider.id) && !credential.accountId)) {
    throw new AiCallError(
      "misconfigured",
      null,
      `${provider.label} needs an account id alongside its token and does not have one.`,
    );
  }

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: temperature ?? 0.3,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    /**
     * ⭐ THE STATUS IS CARRIED, NOT COLLAPSED.
     *
     * 🔴 The previous version reduced every non-429 to `"error"`, so a
     * revoked key and a flaky provider were the same event. They are
     * not: one clears on its own in sixty seconds and the other never
     * clears until a person re-enters a key. `classifyProviderFailure`
     * makes that distinction and it is the whole basis of telling a
     * customer that the failure is THEIR key.
     */
    throw new AiCallError(
      classifyProviderFailure(response.status, text),
      response.status,
      `Provider ${provider.id} returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const choice = data.choices[0];
  if (!choice) {
    throw new AiCallError("error", response.status, `Provider ${provider.id} returned no choices.`);
  }

  const message: ChatMessage = {
    role: "assistant",
    content: choice.message.content ?? "",
    tool_calls: choice.message.tool_calls,
  };

  return {
    message,
    finishReason: choice.finish_reason,
    usage: data.usage,
  };
}

/**
 * Custom error that carries the failure kind, so the retry loop knows
 * whether to trip the breaker — and now the HTTP status, so the caller
 * can tell the customer whose key was rejected.
 */
class AiCallError extends Error {
  constructor(
    public kind: AttemptRecord["kind"],
    public status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT — with retry and failover                           */
/* ------------------------------------------------------------------ */

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ChatTool[];
  sensitivity: "open" | "tenant";
  temperature?: number;
  /** Maximum retries across providers. Default 3. */
  maxRetries?: number;
  /**
   * ⭐ THE RESOLVED CREDENTIALS FOR THIS CALLER.
   *
   * ⚠️ Produced by `server/ai/credentials.ts`, which reads the vault.
   * Omitted means "Ordence's own keys" — correct for platform work and
   * for any caller with no tenant, and identical to the behaviour before
   * this batch.
   */
  credentials?: ProviderCredentialSet;
};

export type ChatResponse =
  | {
      ok: true;
      result: ChatCompletionResult;
      providerId: string;
      /** ⭐ Whose key answered. Recorded against the run. */
      credentialSource: CredentialSource;
      /** ⚠️ Providers tried and failed BEFORE this one succeeded. */
      attempts: readonly AttemptRecord[];
    }
  | {
      ok: false;
      reason: string;
      /**
       * ⭐ EVERY PROVIDER TRIED, WHY IT FAILED, AND WHOSE KEY IT WAS.
       *
       * 🔴 This is what lets the caller record "the customer's own Groq
       * key was rejected" against the credential row instead of showing
       * them a generic "AI unavailable". Empty when the router refused
       * before anything was sent, which is itself the answer.
       */
      attempts: readonly AttemptRecord[];
    };

/**
 * ⭐ Send a chat completion, walking the provider list on failure.
 *
 * The router's `attemptOrder` gives the full ordered list of providers
 * to try. This function walks it: call the first, on failure re-ask the
 * router with that provider excluded, call the next, and so on. State
 * (budget, breaker) is updated after each call, under the budget scope
 * of the credential that was actually used.
 */
export async function chatCompletion(
  request: ChatRequest,
): Promise<ChatResponse> {
  const { messages, tools, sensitivity, temperature, maxRetries } = request;

  // ⚠️ Falls back to the platform's own keys. Same behaviour as before
  // this batch for any caller that has not been given a tenant.
  const credentials = request.credentials ?? platformCredentialSet();
  const configured = configuredProviderIds(credentials);
  const attempts: AttemptRecord[] = [];

  if (configured.length === 0) {
    /**
     * ⭐ THE UNUSABLE LIST IS SPOKEN, NOT SWALLOWED.
     *
     * ⚠️ "No AI provider is configured" is a lie when a Cloudflare token
     * IS configured and is missing its account id. That is the exact
     * shape of failure this batch was asked to make legible.
     */
    const blocked = credentials.unusable
      .map((u) => u.note)
      .join(" ");
    return {
      ok: false,
      attempts,
      reason:
        blocked.length > 0
          ? `No AI provider can be used. ${blocked}`
          : "No AI provider is configured for this workspace or for this " +
            "deployment. Add a provider key in Settings → AI assistant, or " +
            "ask Ordence to configure one.",
    };
  }

  const now = Date.now();
  const states = await readAllStates(credentials, configured);

  const routerInput: RouterInput = {
    sensitivity,
    states,
    configured,
    now,
  };

  const order = attemptOrder(routerInput);

  if (order.length === 0) {
    // Get the specific refusal reason from the router
    const decision = chooseProvider(routerInput);
    if (!decision.ok) {
      return { ok: false, reason: decision.message, attempts };
    }
    return { ok: false, reason: "No provider available.", attempts };
  }

  const limit = Math.min(maxRetries ?? 3, order.length);

  for (let i = 0; i < limit; i++) {
    const provider = order[i]!;
    const credential = credentials.byProvider[provider.id]!;
    let state = await readState(credential.budgetScope, provider.id);

    try {
      const result = await callProvider(
        provider,
        credential,
        messages,
        tools,
        temperature,
      );

      // ⚠️ Success resets the failure counter. See router.afterSuccess.
      state = afterSuccess(state);
      await writeState(credential.budgetScope, provider.id, state);

      return {
        ok: true,
        result,
        providerId: provider.id,
        credentialSource: credential.source,
        attempts,
      };
    } catch (err) {
      const kind: AttemptRecord["kind"] =
        err instanceof AiCallError
          ? err.kind
          : err instanceof TypeError && err.message.includes("fetch")
            ? "unreachable"
            : "error";

      attempts.push({
        providerId: provider.id,
        source: credential.source,
        kind,
        status: err instanceof AiCallError ? err.status : null,
        detail: err instanceof Error ? err.message.slice(0, 500) : "",
      });

      /**
       * ⚠️ A `misconfigured` CREDENTIAL NEVER REACHED THE NETWORK, SO IT
       * DOES NOT SPEND BUDGET AND DOES NOT COUNT TOWARDS THE BREAKER.
       * Counting it would make an unusable Cloudflare pair look like a
       * failing Cloudflare, and the customer would be told to wait for a
       * recovery that cannot happen.
       */
      if (kind !== "misconfigured") {
        // ⚠️ A rate-limit still counts against the budget. See router.
        state = afterFailure(state, Date.now(), routerFailureKind(kind));
        await writeState(credential.budgetScope, provider.id, state);
      }

      // If this was the last provider, return the error
      if (i === limit - 1) {
        /**
         * ⭐⭐ THE ROUTER'S OWN REASON TEXT, EXTENDED RATHER THAN
         *     REPLACED.
         *
         * 🔴 THE POINT IS THE WORD "YOUR". A tenant whose own Groq key
         * has expired must be told that their own Groq key has expired.
         * The previous build showed them "All configured AI providers
         * failed. Last error: …", which is true, useless, and
         * indistinguishable from an outage on our side — so they would
         * raise a ticket about our product for a key we cannot see,
         * cannot test and must not read.
         */
        return {
          ok: false,
          attempts,
          reason: explainAllAttempts(attempts),
        };
      }

      // Otherwise, try the next provider in the order
      continue;
    }
  }

  return { ok: false, reason: "Exhausted all retries.", attempts };
}
