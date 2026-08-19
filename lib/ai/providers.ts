/**
 * Ordence — ⭐ THE AI PROVIDER REGISTRY
 * Version: v0.61.0-alpha  ·  Batch 2
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE LIST OF WHO CAN ANSWER, AND — MORE IMPORTANTLY — WHO MAY BE ASKED
 * ══════════════════════════════════════════════════════════════════════
 * Thirty-one providers offer a free tier. They are not interchangeable,
 * and the difference that matters is not speed or context window.
 *
 * ⚠️ MOST FREE TIERS RESERVE THE RIGHT TO TRAIN ON WHAT YOU SEND THEM.
 *
 * That is the price of free and it is stated in their terms. It is
 * completely fine for "draft a follow-up email" and completely
 * unacceptable for a contact's phone number, a contract's commercial
 * terms, or a patient record. Ordence holds all three.
 *
 * So every provider declares a LANE, and the lane is the first thing the
 * router reads. A provider is in `confidential` only if there is a
 * written commitment not to train on inputs — not because it seems
 * unlikely that they would.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE CONFIDENTIAL LANE IS DELIBERATELY ALMOST EMPTY
 * ══════════════════════════════════════════════════════════════════════
 * Two entries out of thirty-one. Padding it out with free tiers because
 * "they probably don't train on it" would make the whole design
 * decorative — the lane exists precisely to be hard to qualify for.
 *
 * Cloudflare Workers AI is the one that genuinely qualifies today: it
 * runs inside the account Ordence already deploys to, so tenant data
 * never leaves Cloudflare's network, and it is covered by the data
 * processing agreement already in place for R2 and the Worker itself.
 *
 * ══════════════════════════════════════════════════════════════════════
 * NO KEYS IN THIS FILE, EVER
 * ══════════════════════════════════════════════════════════════════════
 * Each provider names the ENVIRONMENT VARIABLE its key lives in. The key
 * itself is a Cloudflare Secret. This file is committed to git; a key in
 * it is a key published to everyone who ever clones the repository, and
 * git keeps it in history after the line is deleted.
 */

/* ------------------------------------------------------------------ */
/* LANES                                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHAT A PROVIDER IS ALLOWED TO BE SHOWN.
 *
 * `open`         — nothing about a real customer. Generic drafting,
 *                  public documents, marketing copy, code.
 * `confidential` — anything a tenant owns. Names, numbers, money,
 *                  contracts, health.
 *
 * ⚠️ A `confidential` provider may also serve `open` traffic. The reverse
 * is never true, and the router has no override for it — not a flag, not
 * an environment variable, not an "allow in emergencies". A rule with an
 * escape hatch is a rule that gets escaped on the busy afternoon.
 */
export type ProviderLane = "open" | "confidential";

export type AiProvider = {
  /** Stable machine key. Never renumber. */
  id: string;
  label: string;

  /** OpenAI-compatible base URL. */
  baseUrl: string;

  /**
   * The environment variable holding the key.
   *
   * ⚠️ THE NAME, NOT THE VALUE. See the header.
   */
  envVar: string;

  lane: ProviderLane;

  /** Default model id for this provider. */
  model: string;

  /**
   * Free-tier ceiling. `null` means "not published" — treated by the
   * router as unknown rather than unlimited, which is the safe reading.
   */
  requestsPerMinute: number | null;
  requestsPerDay: number | null;

  /** Rough context window, for choosing a model rather than a provider. */
  contextTokens: number;

  /**
   * ⚠️ STATED HONESTLY, INCLUDING WHEN IT IS INCONVENIENT.
   *
   * `true` means the provider's free terms permit training on inputs, or
   * are silent about it — which is the same thing for planning purposes.
   * This is what puts a provider in the `open` lane, so it is recorded
   * next to the decision rather than in a document nobody re-reads.
   */
  mayTrainOnInputs: boolean;

  /** Where a human goes to get a key. Shown in Settings. */
  keyUrl: string;

  /**
   * Jurisdiction of the operating company, where it is likely to matter
   * to an Indian enterprise customer's procurement team. Informational.
   */
  jurisdiction?: string;

  notes?: string;
};

/* ------------------------------------------------------------------ */
/* THE REGISTRY                                                        */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ ORDER IS PREFERENCE. The router walks a lane in this order and takes
 * the first provider with budget and a healthy breaker. So the sequence
 * below is a commercial and operational decision — fastest and most
 * generous first — not an alphabetical accident.
 */
export const AI_PROVIDERS: readonly AiProvider[] = Object.freeze([
  /* ---- CONFIDENTIAL LANE ---------------------------------------- */

  {
    id: "cloudflare_workers_ai",
    label: "Cloudflare Workers AI",
    // ⚠️ Account id is interpolated at call time from the runtime env; it
    // is not a secret but it is deployment-specific, so it does not
    // belong in a committed constant.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    envVar: "CF_AI_TOKEN",
    lane: "confidential",
    model: "@cf/meta/llama-3.1-8b-instruct",
    requestsPerMinute: 300,
    requestsPerDay: 10_000,
    contextTokens: 8_192,
    mayTrainOnInputs: false,
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    jurisdiction: "US (Cloudflare Inc.)",
    notes:
      "⭐ The default for anything tenant-owned. Runs inside the account " +
      "Ordence already deploys to, so the data never leaves Cloudflare's " +
      "network and is covered by the DPA already in place for R2.",
  },

  /* ---- OPEN LANE ------------------------------------------------- */

  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envVar: "GROQ_API_KEY",
    lane: "open",
    model: "llama-3.3-70b-versatile",
    requestsPerMinute: 30,
    requestsPerDay: 14_400,
    contextTokens: 128_000,
    mayTrainOnInputs: true,
    keyUrl: "https://console.groq.com/keys",
    jurisdiction: "US",
    notes: "Fastest of the free tiers. Email signup, no card. First choice.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    envVar: "CEREBRAS_API_KEY",
    lane: "open",
    model: "llama-3.3-70b",
    requestsPerMinute: 30,
    requestsPerDay: 14_400,
    contextTokens: 65_536,
    mayTrainOnInputs: true,
    keyUrl: "https://cloud.cerebras.ai/",
    jurisdiction: "US",
    notes: "Comparable limits to Groq. Good second, because it fails independently.",
  },
  {
    id: "google_gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVar: "GOOGLE_AI_API_KEY",
    lane: "open",
    model: "gemini-2.0-flash",
    requestsPerMinute: 15,
    requestsPerDay: 1_500,
    contextTokens: 1_000_000,
    mayTrainOnInputs: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
    jurisdiction: "US",
    notes:
      "Much lower per-minute limit but an enormous context window — the one " +
      "to reach for on a long document rather than for throughput.",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    envVar: "MISTRAL_API_KEY",
    lane: "open",
    model: "mistral-small-latest",
    requestsPerMinute: 60,
    requestsPerDay: 500_000,
    contextTokens: 128_000,
    mayTrainOnInputs: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    jurisdiction: "EU (France)",
  },
  {
    id: "cohere",
    label: "Cohere",
    baseUrl: "https://api.cohere.com/v2",
    envVar: "COHERE_API_KEY",
    lane: "open",
    model: "command-r-08-2024",
    requestsPerMinute: 20,
    requestsPerDay: 1_000,
    contextTokens: 128_000,
    mayTrainOnInputs: true,
    keyUrl: "https://dashboard.cohere.com/api-keys",
    jurisdiction: "Canada",
  },
  {
    id: "github_models",
    label: "GitHub Models",
    baseUrl: "https://models.github.ai/inference",
    envVar: "GITHUB_MODELS_TOKEN",
    lane: "open",
    model: "gpt-4o-mini",
    requestsPerMinute: 15,
    requestsPerDay: 150,
    contextTokens: 128_000,
    mayTrainOnInputs: true,
    keyUrl: "https://github.com/marketplace/models",
    jurisdiction: "US",
    notes: "Low daily ceiling. Useful as a last resort, not as a workhorse.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    lane: "open",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    requestsPerMinute: 20,
    requestsPerDay: 50,
    contextTokens: 128_000,
    mayTrainOnInputs: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    jurisdiction: "US",
    notes:
      "⚠️ Listed, but there is deliberately NO key configured. The four " +
      "previous OpenRouter keys leaked and were deleted. It stays in the " +
      "registry because it is a good aggregator worth reaching for later; " +
      "the router simply skips any provider whose env var is unset.",
  },
]);

/* ------------------------------------------------------------------ */
/* DERIVED                                                             */
/* ------------------------------------------------------------------ */

export const PROVIDERS_BY_ID: Readonly<Record<string, AiProvider>> =
  Object.freeze(Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, p])));

/**
 * The providers eligible for a given sensitivity, in preference order.
 *
 * ⚠️ `tenant` DOES NOT FALL BACK TO THE OPEN LANE. Not when every
 * confidential provider is rate-limited, not when one is down, not ever.
 * The correct behaviour when the confidential lane is exhausted is to
 * refuse and say so — a slow AI feature is an inconvenience, and a
 * customer's contract in a training set is not recoverable.
 */
export function providersFor(
  sensitivity: "open" | "tenant",
): readonly AiProvider[] {
  if (sensitivity === "tenant") {
    return AI_PROVIDERS.filter((p) => p.lane === "confidential");
  }
  // Confidential providers can serve open traffic too, but they are
  // listed AFTER the open ones: no reason to spend the scarce lane's
  // budget on a marketing email.
  return [
    ...AI_PROVIDERS.filter((p) => p.lane === "open"),
    ...AI_PROVIDERS.filter((p) => p.lane === "confidential"),
  ];
}

/** Every environment variable the registry expects. For `/api/diag`. */
export function providerEnvVars(): string[] {
  return [...new Set(AI_PROVIDERS.map((p) => p.envVar))].sort();
}
