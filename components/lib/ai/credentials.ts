/**
 * Ordence — ⭐⭐⭐ WHOSE KEY IS THIS, AND WHAT MAY IT BE SHOWN
 * Version: v1.65.0-alpha  ·  Batch 0105
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * Before this batch there was exactly one AI key per deployment, read
 * from `process.env` at the moment of the call, and every workspace on
 * the platform shared it. One key, one budget, one rate limit, one
 * circuit breaker. A heavy tenant degraded the assistant for every other
 * customer and the founder paid for all of it.
 *
 * A tenant may now bring their own. That turns one question into three,
 * and this file answers all three as PURE FUNCTIONS so they can be
 * argued about in a test rather than in production:
 *
 *   1. WHICH KEY does this request use?          → `ProviderCredential`
 *   2. WHOSE BUDGET does it spend?               → `budgetScopeFor()`
 *   3. WHAT IS THE TENANT TOLD WHEN IT FAILS?    → `classifyProviderFailure()`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 NOTHING HERE TOUCHES THE DATABASE, AND THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * The resolver — the thing that actually opens the vault — lives in
 * `server/ai/credentials.ts`. It has to, because it reads rows.
 *
 * ⚠️ `lib/ai/client.ts` must never import `@/db`. `npm run
 * check:boundaries` would fail it and would be right to: the router and
 * its plumbing are imported by pure planning code (`lib/ai/goal-planner
 * .ts`) and a database client dragged into that graph is a database
 * client dragged into anything that ever imports it. So the resolved
 * credentials are INJECTED into `chatCompletion` as data, and this file
 * is the shape of that data.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DECISION THIS BATCH EXISTS TO GET RIGHT
 * ══════════════════════════════════════════════════════════════════════
 * A tenant supplying their own OPEN-LANE key does NOT thereby become
 * eligible for confidential work. `laneForCredential()` below carries
 * the whole argument. It is the one thing in this file that must not be
 * softened.
 */

import { PROVIDERS_BY_ID, type AiProvider } from "@/lib/ai/providers";

/* ------------------------------------------------------------------ */
/* 1 · WHOSE KEY                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHERE A KEY CAME FROM. Not cosmetic — it decides whose budget is
 * spent, whose breaker trips, and which sentence a failure produces.
 *
 * `platform` — the founder's key, from `process.env`. Shared by every
 *              workspace that has not supplied its own.
 * `tenant`   — this workspace's own key, out of the vault.
 */
export type CredentialSource = "platform" | "tenant";

/**
 * A usable credential for one provider.
 *
 * 🔴 `apiKey` IS THE SECRET ITSELF. A value of this type must not be
 * logged, must not be returned from a server action, must not be
 * attached to a Sentry event, and must not be put in a React prop. It
 * goes into an Authorization header and nowhere else. `AttemptRecord`
 * below is the shape that IS safe to hand around, log and store — it
 * carries the provider, the source and the provider's own response
 * text, and no part of any key.
 */
export interface ProviderCredential {
  readonly providerId: string;
  /** 🔴 THE SECRET. See the note above. */
  readonly apiKey: string;
  /**
   * ⚠️ Cloudflare Workers AI interpolates an account id into its base
   * URL. It is NOT a secret, and it is NOT optional — see
   * `requiresAccountId()`.
   */
  readonly accountId: string | null;
  readonly source: CredentialSource;
  /**
   * ⭐ WHICH LEDGER THIS SPENDS FROM. See `budgetScopeFor()`.
   * Precomputed here because the pure client has no tenant id of its own
   * and must not be given one for any other purpose.
   */
  readonly budgetScope: string;
}

/** What `chatCompletion` is handed: provider id → the credential to use. */
export interface ProviderCredentialSet {
  readonly byProvider: Readonly<Record<string, ProviderCredential>>;
  /**
   * ⚠️ Providers that have a key but cannot be used, and WHY. This is
   * the difference between "not turned on" and "turned on wrong", and
   * the second one is invisible without it — the exact failure named in
   * the header of `note` below.
   */
  readonly unusable: readonly UnusableProvider[];
}

export interface UnusableProvider {
  readonly providerId: string;
  readonly source: CredentialSource;
  /**
   * ⭐ A SENTENCE FOR A PERSON, AND DELIBERATELY NOT ALSO A CODE.
   *
   * ⚠️ The first draft of this interface carried a `reason:
   * "missing_account_id"` discriminant beside it. Nothing read it —
   * every one of the three places that consume this (the client's
   * refusal text, the resolver's report, the settings banner) renders
   * the sentence. A field that is written and never read is the defect
   * this codebase keeps producing, so it was removed rather than left
   * to look like a control.
   */
  readonly note: string;
}

/* ------------------------------------------------------------------ */
/* 2 · THE LANE RULE                                                   */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ MAY A TENANT'S OWN OPEN-LANE KEY CARRY THAT TENANT'S DATA?
 *
 * 🔴 NO. Not with a checkbox, not with an acknowledgement, not with a
 *    signed waiver in the contract. There is no per-tenant setting for
 *    it and this function is a constant, not a lookup.
 *
 * The argument, because it is not obvious and a reasonable person asks
 * for the opposite:
 *
 * ① THE LANE IS ABOUT WHERE THE DATA GOES, NOT ABOUT WHO PAYS.
 *    `mayTrainOnInputs: true` on Groq is a fact about GROQ'S TERMS. It
 *    does not change because the request was billed to the customer's
 *    account rather than ours. The customer's key buys them their own
 *    quota; it buys nobody a different privacy policy.
 *
 * ② THE DATA IS NOT THE TENANT'S TO GIVE AWAY.
 *    A workspace holds its CUSTOMERS' phone numbers, its EMPLOYEES'
 *    salaries, its PATIENTS' identifiers, its counterparties' commercial
 *    terms. Under the Digital Personal Data Protection Act, 2023 the
 *    workspace is the Data Fiduciary for those people and the consent it
 *    holds (s.6) is consent to process for a stated purpose — not
 *    consent to hand the record to a third party that reserves the right
 *    to train on it. A workspace admin ticking a box in Settings cannot
 *    furnish consent on behalf of four thousand contacts who have never
 *    heard of Cerebras. Ordence would be the Data Processor that built
 *    the box.
 *
 * ③ AN ESCAPE HATCH IS THE FAILURE MODE, NOT THE FEATURE.
 *    `lib/ai/providers.ts` already says it: "A rule with an escape hatch
 *    is a rule that gets escaped on the busy afternoon." The busy
 *    afternoon here is concrete — the confidential lane is empty on this
 *    deployment today, the six background monitors are therefore
 *    refusing, and a per-tenant override would look exactly like the fix.
 *
 * ④ AND THE HONEST ANSWER TO THE CUSTOMER IS NOT "NO", IT IS
 *    "YES, WITH THE RIGHT KEY."
 *    ⭐ A tenant may absolutely bring their own CONFIDENTIAL-lane key.
 *    Cloudflare Workers AI is in that lane and is self-service; the
 *    registry already carries its `keyUrl`. So "it is my data, let me
 *    choose" is answered by a link, not by a refusal — the customer gets
 *    their own key, their own budget and their own breaker for tenant
 *    work, and the lane holds. That is a better product AND the safe
 *    one, which is why the trade-off is not painful.
 *
 * ⚠️ WHAT WOULD CHANGE THIS. A provider moving into the confidential
 *    lane — which happens by editing `lib/ai/providers.ts` after reading
 *    a written commitment not to train on inputs, and never by a runtime
 *    flag.
 */
/**
 * ⭐ The lane a credential may serve, which is the PROVIDER'S lane and
 * nothing else.
 *
 * 🔴 The `source` parameter is deliberately accepted and deliberately
 * ignored. Taking it and discarding it is the readable form of "we
 * considered this and the answer is no" — a signature that did not take
 * it would leave a future reader wondering whether the case had been
 * thought about. The test in `tests/ui/ai-tenant-credentials.test.ts`
 * asserts exactly this, for both sources, over the whole registry.
 */
export function laneForCredential(
  provider: AiProvider,
  _source: CredentialSource,
): AiProvider["lane"] {
  return provider.lane;
}

/* ------------------------------------------------------------------ */
/* 3 · WHOSE BUDGET                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE BUDGET AND THE BREAKER FOLLOW THE KEY, NOT THE TENANT.
 *
 * `lib/ai/client.ts` keeps `usedThisMinute`, `usedToday`,
 * `consecutiveFailures` and `breakerOpenUntil` in Upstash under one key
 * per provider. That was correct while there was one credential per
 * provider. It is wrong the moment there are many, in both directions:
 *
 *   🔴 A tenant on their OWN key counted against the shared ledger would
 *      exhaust the founder's Groq budget for everybody else, having
 *      spent none of it.
 *   🔴 A tenant whose OWN key is dead would trip the shared breaker and
 *      take Groq out of rotation for every other workspace for a minute.
 *
 * ⭐ So the state key gains a dimension: WHICH CREDENTIAL. Two tenants on
 *    the platform key share a ledger, because they share a quota. A
 *    tenant on their own key gets their own, because they have their own
 *    quota and their own bill.
 *
 * ⚠️ THIS CHANGES THE REDIS KEY SHAPE. Keys written by the previous
 *    build (`ai:provider-state:groq`) are simply never read again; they
 *    carry a five minute TTL and disappear on their own. No migration,
 *    and the worst case on the deploy is that one minute's counts start
 *    from zero — which is the cold-start case the router already treats
 *    as "full budget, healthy" by design.
 */
export const PLATFORM_BUDGET_SCOPE = "platform" as const;

export function budgetScopeFor(
  source: CredentialSource,
  tenantId: string | null,
): string {
  if (source === "platform") return PLATFORM_BUDGET_SCOPE;
  if (!tenantId) {
    /**
     * ⚠️ NOT A SILENT FALLBACK TO THE PLATFORM SCOPE. A tenant-sourced
     * credential with no tenant id is a bug in the resolver, and folding
     * it into the shared ledger would make that bug invisible by
     * charging somebody else for it.
     */
    throw new Error(
      "A tenant-sourced credential needs a tenant id to name its budget.",
    );
  }
  return `tenant:${tenantId}`;
}

/** The Upstash key for one (credential, provider) pair. */
export function providerStateKey(budgetScope: string, providerId: string): string {
  return `ai:provider-state:${budgetScope}:${providerId}`;
}

/* ------------------------------------------------------------------ */
/* 4 · THE PAIR THAT MUST NOT BE HALF-ENTERED                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 CLOUDFLARE WORKERS AI NEEDS TWO VALUES, AND THE SECOND ONE IS
 *    EASY TO FORGET.
 *
 * `lib/ai/client.ts` interpolates an account id into
 * `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`.
 * With a token and no account id the URL is built with an EMPTY SEGMENT,
 * the call 404s, the router records a failure, walks on, and NOTHING
 * ANYWHERE SAYS THE ACCOUNT ID IS MISSING. It reads as "Cloudflare is
 * down" forever.
 *
 * ⭐ So a credential for this provider is not usable without both, and
 * "not usable" is reported as its own state rather than as a failure.
 * The save action refuses the pair half-entered; the resolver refuses to
 * hand out a half credential; the settings screen says which half is
 * missing. Three places, because the customer can arrive at it from any
 * of them.
 */
export function requiresAccountId(providerId: string): boolean {
  return providerId === "cloudflare_workers_ai";
}

/** The env var the PLATFORM account id lives in. Named, never valued. */
export const PLATFORM_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID" as const;

/**
 * Whether a (key, accountId) pair is complete for this provider, and if
 * not, the sentence to show. Pure, so the same words appear on the
 * settings screen, in the action's refusal and in the resolver's report.
 */
export function credentialCompleteness(
  providerId: string,
  hasKey: boolean,
  accountId: string | null,
): { complete: boolean; note: string | null } {
  if (!hasKey) return { complete: false, note: null };
  if (!requiresAccountId(providerId)) return { complete: true, note: null };
  if (accountId && accountId.trim().length > 0) {
    return { complete: true, note: null };
  }
  const label = PROVIDERS_BY_ID[providerId]?.label ?? providerId;
  return {
    complete: false,
    note:
      `${label} needs an account id as well as a token. Without it the ` +
      `request URL is built with an empty account segment, every call ` +
      `fails, and nothing reports why. Enter both or neither.`,
  };
}

/**
 * ⚠️ Does the built URL still carry an unfilled placeholder? Called by
 * the client immediately before the fetch, as the last line of defence:
 * everything above is a check somebody could route around, and this one
 * is on the only path that reaches the network.
 */
export function urlIsFullyResolved(url: string): boolean {
  return !url.includes("{account_id}");
}

/* ------------------------------------------------------------------ */
/* 5 · AN HONEST FAILURE                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHY A CALL FAILED, IN THE TERMS THE PERSON READING IT CAN ACT ON.
 *
 * ⚠️ `auth` AND `rate_limited` ARE THE TWO THAT MUST NOT BE MERGED, and
 * the previous build merged them: `callProvider` produced
 * `"rate_limited"` for a 429 and `"error"` for everything else, so a
 * revoked key and a flaky provider were the same event. They are not:
 * one clears on its own in sixty seconds and the other never clears
 * until a person re-enters a key.
 */
export type CredentialFailureKind =
  /** 401 / 403 — the key is wrong, revoked, or lacks the scope. */
  | "auth"
  /** 402, or a 429 whose body names credits or a quota rather than a rate. */
  | "quota"
  /** 429 — the provider is working exactly as documented. Transient. */
  | "rate_limited"
  /** The credential is incomplete. Never reached the network. */
  | "misconfigured"
  /** Network, DNS, timeout. Nothing was answered. */
  | "unreachable"
  /** 5xx and anything unclassified. */
  | "error";

/**
 * ⚠️ SUBSTRING MATCHING ON A PROVIDER'S PROSE, AND IT IS A HEURISTIC.
 * Nine providers, nine wordings, no shared error schema. So the ONLY
 * thing the prose is allowed to do is separate `quota` from
 * `rate_limited` — both of which are already "this key cannot serve you
 * right now". It can never promote something to `auth`, because that is
 * the classification that tells a customer to go and change their key.
 * A wrong `auth` sends somebody to rotate a key that was fine.
 */
const QUOTA_WORDS =
  /\b(quota|credit|credits|billing|insufficient|exceeded your current|balance|payment required|out of funds)\b/i;

export function classifyProviderFailure(
  status: number | null,
  body: string,
): CredentialFailureKind {
  if (status === null) return "unreachable";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return QUOTA_WORDS.test(body) ? "quota" : "rate_limited";
  if (status >= 500) return "error";
  return "error";
}

/**
 * The router's own vocabulary is narrower than ours on purpose — it only
 * needs to know whether to trip the breaker.
 *
 * 🔴 `auth` AND `quota` MAP TO `error`, WHICH TRIPS THE BREAKER AFTER
 * THREE, AND THAT IS CORRECT. A dead key is not a transient condition;
 * hammering it three times a second produces nothing but 401s and the
 * latency of them. `rate_limited` stays `rate_limited` so it does NOT
 * trip, exactly as `router.afterFailure` argues.
 */
export function routerFailureKind(
  kind: CredentialFailureKind,
): "rate_limited" | "error" | "timeout" {
  if (kind === "rate_limited") return "rate_limited";
  if (kind === "unreachable") return "timeout";
  return "error";
}

/** One provider's turn in a single request. Carries no secret. */
export interface AttemptRecord {
  readonly providerId: string;
  readonly source: CredentialSource;
  readonly kind: CredentialFailureKind;
  readonly status: number | null;
  /**
   * ⚠️ The provider's own text, truncated. Safe: it is a response body,
   * never a request header. The KEY is never in here — `callProvider`
   * puts it in an Authorization header and reads only `response.text()`.
   */
  readonly detail: string;
}

/**
 * ⭐⭐ THE SENTENCE THE CUSTOMER READS.
 *
 * 🔴 THE POINT OF THIS WHOLE FUNCTION IS THE WORD "YOUR". A tenant who
 * has entered their own Groq key and whose Groq key has expired must be
 * told that their Groq key has expired. The previous build would have
 * shown them "All configured AI providers failed", which is true,
 * useless, and indistinguishable from an outage on our side — so they
 * would have raised a support ticket about our product for a key we
 * cannot see, cannot test and must not read.
 *
 * ⚠️ And the reverse matters just as much: when the PLATFORM key is the
 * one that died, the customer must NOT be sent to look at a settings
 * screen where they have entered nothing.
 */
export function explainAttempt(attempt: AttemptRecord): string {
  const label = PROVIDERS_BY_ID[attempt.providerId]?.label ?? attempt.providerId;
  const mine = attempt.source === "tenant";
  const where = mine
    ? "the key this workspace supplied"
    : "the key Ordence supplies";

  switch (attempt.kind) {
    case "auth":
      return mine
        ? `${label} rejected ${where} (HTTP ${attempt.status}). It is wrong, ` +
            `revoked, or lacks the required scope. Replace it in Settings → ` +
            `AI assistant; nobody at Ordence can see or repair it.`
        : `${label} rejected ${where} (HTTP ${attempt.status}). This is ours ` +
            `to fix, not yours. You can work around it today by adding your ` +
            `own ${label} key in Settings → AI assistant.`;
    case "quota":
      return mine
        ? `${label} reports that ${where} is out of quota or credit. Top it ` +
            `up with ${label}, or remove the key to fall back to Ordence's.`
        : `${label} reports that ${where} is out of quota or credit. Adding ` +
            `your own ${label} key in Settings → AI assistant gives this ` +
            `workspace its own allowance.`;
    case "rate_limited":
      return (
        `${label} is rate-limiting ${where}. This clears on its own within ` +
        `a minute and the request was not sent anywhere else.`
      );
    case "misconfigured":
      return `${label} is not fully configured: ${attempt.detail}`;
    case "unreachable":
      return `${label} could not be reached at all. Nothing was sent.`;
    default:
      return `${label} returned an error (HTTP ${attempt.status ?? "none"}).`;
  }
}

/**
 * ⭐ The whole request's failure, in one paragraph, built from the
 * attempts rather than from the last exception.
 *
 * ⚠️ THE TENANT'S OWN FAILURES ARE HOISTED TO THE FRONT. If one of five
 * attempts was on a key the customer can actually do something about,
 * that is the sentence they need first — putting it fifth is the same as
 * not writing it.
 */
export function explainAllAttempts(attempts: readonly AttemptRecord[]): string {
  if (attempts.length === 0) return "";
  const actionable = attempts.filter(
    (a) => a.source === "tenant" && (a.kind === "auth" || a.kind === "quota" || a.kind === "misconfigured"),
  );
  const rest = attempts.filter((a) => !actionable.includes(a));
  return [...actionable, ...rest].map(explainAttempt).join(" ");
}

/* ------------------------------------------------------------------ */
/* 6 · WHAT MAY BE PUT ON A SCREEN                                     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE SAFE HALF OF A CREDENTIAL. Everything a screen, a prop, a log
 * or a server-action return value is allowed to know.
 *
 * ⚠️ Deliberately NOT a masked prefix of the key, and not its length.
 * `db/schema/vault.ts` already made that decision for `api_credential`
 * and the reasoning holds here: the first four characters of an API key
 * are a provider fingerprint, and the length narrows a search. The
 * customer already knows which key they pasted; they do not need us to
 * prove it back to them.
 */
export interface CredentialSummary {
  readonly providerId: string;
  readonly label: string;
  readonly lane: AiProvider["lane"];
  readonly mayTrainOnInputs: boolean;
  readonly keyUrl: string;
  readonly jurisdiction: string | null;
  /** Whether THIS workspace has supplied one. */
  readonly tenantSupplied: boolean;
  /** Whether Ordence's own key would serve this provider. */
  readonly platformSupplied: boolean;
  /** Which one a request would actually use right now. `null` = neither. */
  readonly effectiveSource: CredentialSource | null;
  /** Set when a key is present but unusable. See `credentialCompleteness`. */
  readonly blockedNote: string | null;
}


/* ------------------------------------------------------------------ */
/* 7 · BEFORE THE MIGRATION HAS BEEN APPLIED                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE CODE MAY LAND BEFORE 0105 DOES, AND THE ASSISTANT MUST KEEP
 *    WORKING WHEN IT DOES.
 *
 * ⚠️ THIS IS THE BRANCH THAT USUALLY GOES UNTESTED, which is why it is a
 * pure function here rather than an inline `catch` in the resolver. "A
 * verify file that has only ever been run on the passing case is not a
 * verify file" — so both branches are exercised directly.
 *
 * 42P01 = undefined_table. 42703 = undefined_column, which covers a
 * HALF-applied file — the failure mode a browser console produces and
 * the one 0091 actually hit, where the run reported success and the
 * second half never landed.
 */
export function isMissingAiCredentialSchema(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === "42P01" || code === "42703") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /ai_provider_credentials/i.test(message) &&
    /does not exist|undefined/i.test(message);
}


/* ------------------------------------------------------------------ */
/* ⭐⭐⭐ WHOSE KEYS MAY BE USED — 0115                                 */
/* ------------------------------------------------------------------ */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE LINE THIS EXISTS TO DELETE
 * ══════════════════════════════════════════════════════════════════════
 * `server/ai/credentials.ts` built the tenant set like this:
 *
 *     const byProvider = { ...platform.byProvider };   // ours go in FIRST
 *     for (const row of rows) { ... }                   // theirs override
 *
 * A workspace that configured Groq and not Google reached Google ON OUR
 * KEY. Not as a fallback anybody chose — as the shape of the merge. 0105
 * was written to ADD bring-your-own; it was never asked to make it
 * exclusive.
 */
export const AI_CREDENTIAL_POLICIES = [
  "platform_allowed",
  "byo_preferred",
  "byo_required",
] as const;

export type AiCredentialPolicy = (typeof AI_CREDENTIAL_POLICIES)[number];

/**
 * ⚠️ THE DEFAULT IS THE STRICT ONE, AND IT IS THE DEFAULT IN CODE AS WELL
 * AS IN THE SCHEMA.
 *
 * 🔴 A `switch` WITH A DEFAULT BRANCH IS HOW THIS GOES WRONG. If an
 * unrecognised value fell through to "allow the platform keys", then a
 * typo, a truncated column, or a row written before the CHECK existed
 * would silently mean the opposite of what it says. So an unknown value
 * is treated as `byo_required`: the failure mode is a workspace being
 * told to add a key it may already have, which somebody notices in
 * minutes, rather than money leaving an account nobody is watching.
 */
export const DEFAULT_AI_CREDENTIAL_POLICY: AiCredentialPolicy = "byo_required";

export function parseAiCredentialPolicy(value: unknown): AiCredentialPolicy {
  return (AI_CREDENTIAL_POLICIES as readonly string[]).includes(value as string)
    ? (value as AiCredentialPolicy)
    : DEFAULT_AI_CREDENTIAL_POLICY;
}

/** Does this policy permit falling back to Ordence's own keys at all? */
export function platformKeysPermitted(policy: AiCredentialPolicy): boolean {
  return policy !== "byo_required";
}

/**
 * ⭐⭐⭐ THE MERGE, WITH THE POLICY APPLIED. One function, so no caller
 * can forget it.
 *
 * ⚠️ `byo_preferred` STILL MERGES, AND THAT IS NOT A LOOPHOLE. The
 * difference from `platform_allowed` is not in this function — it is that
 * every call made on a platform key under `byo_preferred` is metered and
 * shown to the customer. The point of that policy is a workspace that is
 * migrating: they see, in rupees, which providers they have not yet moved.
 *
 * 🔴 UNDER `byo_required` THE PLATFORM SET IS NOT MERGED AND ITS
 * `unusable` NOTES ARE DROPPED TOO. Telling a bring-your-own workspace
 * that "CF_AI_TOKEN is set in this deployment but CLOUDFLARE_ACCOUNT_ID
 * is not" would be leaking our deployment's configuration into their
 * settings screen, and it is not a problem they can act on.
 */
export function applyCredentialPolicy(args: {
  policy: AiCredentialPolicy;
  platform: ProviderCredentialSet;
  tenant: ProviderCredentialSet;
}): ProviderCredentialSet {
  const { policy, platform, tenant } = args;

  if (!platformKeysPermitted(policy)) {
    return { byProvider: { ...tenant.byProvider }, unusable: [...tenant.unusable] };
  }

  return {
    byProvider: { ...platform.byProvider, ...tenant.byProvider },
    unusable: [...platform.unusable, ...tenant.unusable],
  };
}

/**
 * ⭐ THE REFUSAL, WHEN A BRING-YOUR-OWN WORKSPACE ASKS FOR A PROVIDER IT
 * HAS NOT CONFIGURED.
 *
 * 🔴 IT NAMES THE FIX AND IT NEVER SAYS "unavailable". "The AI assistant
 * is unavailable" is indistinguishable from an outage on our side, so the
 * customer raises a ticket about our product for a key only they can add.
 */
export function byoRefusal(configuredCount: number): string {
  return configuredCount === 0
    ? "This workspace uses its own AI provider keys, and none has been added yet. " +
        "Add one in Settings → AI assistant. Ordence does not fall back to its own " +
        "keys for this workspace, so nothing is charged to us and nothing runs until " +
        "you add one."
    : "This workspace uses its own AI provider keys. None of the providers you have " +
        "configured is available right now — check Settings → AI assistant, where " +
        "each key's last failure is shown against it.";
}
