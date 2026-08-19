import "server-only";

/**
 * Ordence — ⭐⭐ THE ONE DOOR FROM TENANT CODE TO THE AI
 * Version: v1.65.0-alpha  ·  Batch 0105
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS WRAPPER EXISTS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * `chatCompletion` in `lib/ai/client.ts` is pure plumbing: it takes
 * credentials as data and knows nothing about tenants, the vault or the
 * database. That is deliberate and it must stay that way.
 *
 * ⭐ But something has to (a) resolve the credentials, (b) hand them
 * over and (c) write down what happened. Doing those three things at
 * each of the four call sites is three chances to forget the third one
 * at each of four places — and forgetting the third one is precisely how
 * `last_failure_kind` becomes another column that is declared,
 * displayed, and populated by nothing.
 *
 * 🔴 SO THERE IS ONE FUNCTION AND EVERY TENANT-FACING CALLER USES IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT IT DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not touch `sensitivity` and it has no way to. The lane rule is
 * enforced by `chooseProvider` over `provider.lane`, and a tenant's own
 * open-lane key is still an open-lane key. See `laneForCredential()`
 * in `lib/ai/credentials.ts` for why that is the right answer and not
 * merely the conservative one.
 */

import {
  chatCompletion,
  type ChatRequest,
  type ChatResponse,
} from "@/lib/ai/client";
import {
  recordCredentialOutcome,
  resolveProviderCredentials,
} from "@/server/ai/credentials";
/**
 * ⭐⭐⭐ 0115. This wrapper's own header says every tenant-facing caller
 * comes through here, and that is exactly why the metering belongs here:
 * one place, so "whose credits" cannot be forgotten at a call site.
 */
import { recordChatOutcome } from "@/server/ai/usage";
import { byoRefusal, platformKeysPermitted } from "@/lib/ai/credentials";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type TenantChatRequest = Omit<ChatRequest, "credentials"> & {
  readonly tenantId: string;
  /**
   * ⚠️ Pass the handle when you are already inside a `withTenant()`.
   * `server/automation/agent-dispatch.ts` is, and opening a second
   * transaction from inside the first takes a second connection out of a
   * shared pool for the whole length of an AI call.
   */
  readonly tx?: Tx;
  /**
   * ⭐ 0115. What asked — `assistant`, `goal_planner`, `agent_run`, a
   * sweep. It lands on the usage row, because "this workspace spent
   * ₹4,000 of our credits" is a different conversation from "this
   * workspace's nightly sweep spent ₹4,000 of our credits".
   */
  readonly feature?: string;
};

/**
 * ⭐⭐ A CHAT COMPLETION ON THIS WORKSPACE'S OWN KEYS WHERE IT HAS THEM,
 * AND ON ORDENCE'S WHERE IT DOES NOT.
 *
 * ⚠️ Takes `tenantId`, so this module is `server-only` and never
 * `"use server"`. `check-server-boundaries.mjs` rule 4 exists for
 * exactly that: an exported action taking a tenant id is the one route
 * past row-level security.
 */
export async function tenantChatCompletion(
  request: TenantChatRequest,
): Promise<ChatResponse> {
  const { tenantId, tx, feature, ...rest } = request;

  const { set, policy } = await resolveProviderCredentials(tenantId, tx);
  const usageFeature = feature ?? "assistant";

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THE BRING-YOUR-OWN REFUSAL, BEFORE ANYTHING IS SENT — 0115
   * ══════════════════════════════════════════════════════════════════
   * `chatCompletion` has a perfectly good "no AI provider is configured"
   * message, and it is the WRONG SENTENCE for this workspace. It reads
   * as a problem with Ordence's deployment, so the customer raises a
   * ticket about our product for a key only they can add — and we cannot
   * see it, cannot test it and must not read it.
   *
   * ⚠️ AND THE REFUSAL IS METERED. "This workspace tried the assistant
   * eleven times last week and has never added a key" is a sales
   * conversation, and it is invisible unless somebody records the
   * attempt.
   */
  const configuredCount = Object.keys(set.byProvider).length;
  if (!platformKeysPermitted(policy) && configuredCount === 0) {
    await recordChatOutcome({
      tenantId,
      feature: usageFeature,
      attempts: [],
      success: null,
      refusal: { providerId: "none", credentialSource: "tenant" },
    });
    return { ok: false, reason: byoRefusal(0), attempts: [] };
  }

  const response = await chatCompletion({ ...rest, credentials: set });

  /**
   * ⭐⭐⭐ WHOSE CREDITS, RECORDED — INCLUDING THE ATTEMPTS THAT FAILED.
   *
   * 🔴 THE FAILED ATTEMPTS ARE THE POINT. A workspace whose own key is
   * broken retries all day. Every one of those reached a provider and
   * cost tokens, and under `platform_allowed` or `byo_preferred` the
   * retry may have landed on OUR key. A table that recorded only the
   * successful call would report that workspace as cheapest in exactly
   * the month it cost us the most.
   *
   * ⚠️ IT IS AWAITED BUT IT CANNOT THROW. `recordAiUsage` swallows its
   * own errors and logs them, because a metering write must never take
   * down the thing it is measuring — the customer's answer is already in
   * hand and discarding it to protect a statistic is the wrong trade by
   * a wide margin.
   */
  await recordChatOutcome({
    tenantId,
    feature: usageFeature,
    attempts: response.attempts,
    success: response.ok
      ? {
          providerId: response.providerId,
          credentialSource: response.credentialSource,
          promptTokens: response.result.usage?.prompt_tokens ?? null,
          completionTokens: response.result.usage?.completion_tokens ?? null,
          totalTokens: response.result.usage?.total_tokens ?? null,
        }
      : null,
  });

  /**
   * ⭐ EVERY TENANT-SOURCED ATTEMPT IS WRITTEN DOWN, INCLUDING THE ONES
   * THAT FAILED BEFORE A LATER PROVIDER SUCCEEDED.
   *
   * 🔴 THIS IS THE HALF THAT IS EASY TO SKIP. If the customer's Groq key
   * is dead but Gemini answers, the request SUCCEEDS and the customer
   * never learns that the key they are paying for stopped working. The
   * router's failover is doing its job and hiding a fact the customer
   * needs. `response.attempts` is populated on the success path for
   * exactly this.
   */
  for (const attempt of response.attempts) {
    if (attempt.source !== "tenant") continue;
    await recordCredentialOutcome({
      tenantId,
      tx,
      providerId: attempt.providerId,
      outcome: "failure",
      kind: attempt.kind,
      detail: attempt.detail,
    });
  }

  if (response.ok && response.credentialSource === "tenant") {
    await recordCredentialOutcome({
      tenantId,
      tx,
      providerId: response.providerId,
      outcome: "success",
    });
  }

  return response;
}
