/**
 * Ordence — ⭐ THE AI CLIENT
 * Version: v0.76.0-alpha
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
 */
const inMemoryState = new Map<string, ProviderState>();

const STATE_KEY = "ai:provider-state";
const STATE_TTL = 300; // 5 minutes — long enough to track a budget window

async function readState(providerId: string): Promise<ProviderState> {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get<ProviderState>(`${STATE_KEY}:${providerId}`);
      if (raw) return raw;
    } catch {
      /* fall through to in-memory */
    }
  }
  return inMemoryState.get(providerId) ?? {
    usedThisMinute: 0,
    usedToday: 0,
    consecutiveFailures: 0,
    breakerOpenUntil: 0,
  };
}

async function writeState(providerId: string, state: ProviderState): Promise<void> {
  inMemoryState.set(providerId, state);
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`${STATE_KEY}:${providerId}`, state, { ex: STATE_TTL });
    } catch {
      /* non-fatal */
    }
  }
}

async function readAllStates(
  providerIds: readonly string[],
): Promise<Record<string, ProviderState | undefined>> {
  const entries = await Promise.all(
    providerIds.map(async (id) => [id, await readState(id)] as const),
  );
  return Object.fromEntries(entries);
}

/* ------------------------------------------------------------------ */
/* CONFIGURED PROVIDERS                                                */
/* ------------------------------------------------------------------ */

/**
 * Which providers have a key in the environment. The router skips any
 * provider whose env var is unset — a configured provider with no key is
 * not a failure, it is a provider not yet turned on.
 */
function configuredProviderIds(): string[] {
  return AI_PROVIDERS.filter((p) => {
    const val = process.env[p.envVar];
    return typeof val === "string" && val.length > 0;
  }).map((p) => p.id);
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
 * ⚠️ THE API KEY IS READ FROM `process.env` AT CALL TIME, never stored.
 * The provider registry names the env var; this file reads it when the
 * call is made. A key is never logged, never serialised, never passed to
 * the router.
 */
async function callProvider(
  provider: AiProvider,
  messages: ChatMessage[],
  tools?: ChatTool[],
  temperature?: number,
): Promise<ChatCompletionResult> {
  const apiKey = process.env[provider.envVar];
  if (!apiKey) {
    throw new Error(`Provider ${provider.id} has no key in ${provider.envVar}.`);
  }

  // ⚠️ Cloudflare Workers AI needs the account id interpolated.
  const baseUrl = provider.baseUrl.replace(
    "{account_id}",
    process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  );

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
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const isRateLimit = response.status === 429;

    throw new AiCallError(
      isRateLimit ? "rate_limited" : "error",
      `Provider ${provider.id} returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const choice = data.choices[0];
  if (!choice) {
    throw new AiCallError("error", `Provider ${provider.id} returned no choices.`);
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
 * whether to trip the breaker.
 */
class AiCallError extends Error {
  constructor(
    public kind: "rate_limited" | "error" | "timeout",
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
};

export type ChatResponse =
  | { ok: true; result: ChatCompletionResult; providerId: string }
  | { ok: false; reason: string };

/**
 * ⭐ Send a chat completion, walking the provider list on failure.
 *
 * The router's `attemptOrder` gives the full ordered list of providers
 * to try. This function walks it: call the first, on failure re-ask the
 * router with that provider excluded, call the next, and so on. State
 * (budget, breaker) is updated after each call.
 */
export async function chatCompletion(
  request: ChatRequest,
): Promise<ChatResponse> {
  const { messages, tools, sensitivity, temperature, maxRetries } = request;
  const configured = configuredProviderIds();

  if (configured.length === 0) {
    return {
      ok: false,
      reason:
        "No AI provider is configured for this deployment. Add at least one " +
        "provider key in the environment variables.",
    };
  }

  const now = Date.now();
  const states = await readAllStates(configured);

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
      return { ok: false, reason: decision.message };
    }
    return { ok: false, reason: "No provider available." };
  }

  const limit = Math.min(maxRetries ?? 3, order.length);

  for (let i = 0; i < limit; i++) {
    const provider = order[i]!;
    let state = await readState(provider.id);

    try {
      const result = await callProvider(
        provider,
        messages,
        tools,
        temperature,
      );

      // ⚠️ Success resets the failure counter. See router.afterSuccess.
      state = afterSuccess(state);
      await writeState(provider.id, state);

      return { ok: true, result, providerId: provider.id };
    } catch (err) {
      const kind =
        err instanceof AiCallError
          ? err.kind
          : err instanceof TypeError && err.message.includes("fetch")
            ? "timeout"
            : "error";

      // ⚠️ A rate-limit still counts against the budget. See router.
      state = afterFailure(state, Date.now(), kind as "rate_limited" | "error" | "timeout");
      await writeState(provider.id, state);

      // If this was the last provider, return the error
      if (i === limit - 1) {
        const reason =
          err instanceof Error ? err.message : "All providers failed.";
        return {
          ok: false,
          reason: `All configured AI providers failed. Last error: ${reason}`,
        };
      }

      // Otherwise, try the next provider in the order
      continue;
    }
  }

  return { ok: false, reason: "Exhausted all retries." };
}
