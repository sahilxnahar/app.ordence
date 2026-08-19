import "server-only";

/**
 * Ordence — ⭐⭐⭐ WHOSE AI CREDITS, AS A FACT
 * Version: v1.72.0-alpha (0115)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BEFORE THIS, THE QUESTION HAD NO ANSWER
 * ══════════════════════════════════════════════════════════════════════
 * `0105` threaded `budget_scope` through every AI call specifically so
 * that *"a tenant paying for their own Groq key must not spend the
 * platform's Groq budget"*. What `budget_scope` actually tracks is
 * provider HEALTH — a cooldown after failures — not tokens and not money.
 *
 * So "how much did that workspace cost us last month" could not be
 * answered even approximately, and the answer to "are they on their own
 * keys" was a belief rather than a measurement.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ RECORDING FAILS SOFT, AND THAT IS DELIBERATE
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A METERING WRITE MUST NEVER TAKE DOWN THE THING IT IS MEASURING. If
 * this insert throws — a full disk, a lock, a schema not yet migrated —
 * the customer's assistant answer is already in hand and throwing it away
 * to protect a statistic would be the wrong trade by a wide margin.
 *
 * ⚠️ BUT A SWALLOWED FAILURE IS A SILENT UNDERCOUNT, so it is logged with
 * a marker somebody can grep for. An undercount nobody knows about is
 * exactly how a billing conversation goes wrong.
 */

import { sql as sqlTag } from "drizzle-orm";
import { withTenant } from "@/db";
import { aiUsage } from "@/db/schema/billing";
import type { CredentialSource } from "@/lib/ai/credentials";
import type { AttemptRecord } from "@/lib/ai/credentials";

export type UsageOutcome = "ok" | "failed" | "refused";

export type RecordUsageArgs = {
  tenantId: string;
  providerId: string;
  model?: string | null;
  credentialSource: CredentialSource;
  /**
   * ⚠️ UNDEFINED IS NOT ZERO. Not every provider returns usage, and a
   * zero would be a measurement where NULL is the honest statement that
   * the provider did not say. Summing NULLs as zero would understate our
   * own spend, invisibly.
   */
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  /** What asked: `assistant`, `goal_planner`, `agent_run`, a sweep. */
  feature: string;
  requestRef?: string | null;
  outcome?: UsageOutcome;
  failureKind?: string | null;
};

const toInt = (v: number | null | undefined): number | null =>
  v === null || v === undefined || Number.isNaN(v) ? null : Math.max(0, Math.trunc(v));

export async function recordAiUsage(args: RecordUsageArgs): Promise<void> {
  const outcome = args.outcome ?? "ok";
  try {
    await withTenant(args.tenantId, (tx) =>
      tx.insert(aiUsage).values({
        tenantId: args.tenantId,
        providerId: args.providerId.slice(0, 40),
        model: args.model?.slice(0, 120) ?? null,
        credentialSource: args.credentialSource,
        promptTokens: toInt(args.promptTokens),
        completionTokens: toInt(args.completionTokens),
        totalTokens: toInt(args.totalTokens),
        feature: args.feature.slice(0, 60),
        requestRef: args.requestRef?.slice(0, 120) ?? null,
        outcome,
        /**
         * 🔴 A CHECK CONSTRAINT REFUSES `failed` WITH NO KIND. Defaulting
         * it here rather than letting the insert throw keeps the fail-soft
         * promise above, and `unrecorded` is honest: something failed and
         * the caller did not say what.
         */
        failureKind:
          outcome === "failed" ? (args.failureKind ?? "unrecorded") : (args.failureKind ?? null),
      }),
    );
  } catch (err) {
    console.error(
      "[ai-usage] a metering row was not written. This is a silent undercount " +
        "of AI spend for this workspace until it is fixed.",
      {
        tenantId: args.tenantId,
        providerId: args.providerId,
        credentialSource: args.credentialSource,
        outcome,
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
    );
  }
}

/**
 * ⭐⭐ RECORD A WHOLE `chatCompletion` OUTCOME, INCLUDING THE PROVIDERS
 * THAT FAILED ON THE WAY.
 *
 * 🔴 THE FAILED ATTEMPTS ARE THE POINT. A workspace whose own key is
 * broken retries all day: every one of those attempts reached a provider,
 * cost tokens, and — if the policy allowed a fallback — may have landed
 * on OUR key. A table that recorded only the successful call would report
 * that workspace as cheapest in exactly the month it cost the most.
 *
 * ⚠️ A `misconfigured` ATTEMPT NEVER REACHED THE NETWORK and is not
 * recorded as spend. `lib/ai/client.ts` already makes that distinction
 * for the circuit breaker, and it is the same distinction here: an
 * unusable credential pair costs nothing at the provider.
 */
export async function recordChatOutcome(args: {
  tenantId: string;
  feature: string;
  requestRef?: string | null;
  model?: string | null;
  attempts: readonly AttemptRecord[];
  success?: {
    providerId: string;
    credentialSource: CredentialSource;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  /** Set when the router refused before anything was sent. */
  refusal?: { providerId: string; credentialSource: CredentialSource } | null;
}): Promise<void> {
  for (const attempt of args.attempts) {
    if (attempt.kind === "misconfigured") continue;
    await recordAiUsage({
      tenantId: args.tenantId,
      providerId: attempt.providerId,
      model: args.model ?? null,
      credentialSource: attempt.source,
      feature: args.feature,
      requestRef: args.requestRef ?? null,
      outcome: "failed",
      failureKind: attempt.kind,
    });
  }

  if (args.success) {
    await recordAiUsage({
      tenantId: args.tenantId,
      providerId: args.success.providerId,
      model: args.model ?? null,
      credentialSource: args.success.credentialSource,
      promptTokens: args.success.promptTokens,
      completionTokens: args.success.completionTokens,
      totalTokens: args.success.totalTokens,
      feature: args.feature,
      requestRef: args.requestRef ?? null,
      outcome: "ok",
    });
    return;
  }

  /**
   * ⚠️ A REFUSAL WITH NO ATTEMPTS IS STILL RECORDED, with no tokens. It
   * is how "this workspace tried to use the assistant eleven times last
   * week and has never added a key" becomes visible — which is a sales
   * conversation, not an error.
   */
  if (args.refusal && args.attempts.length === 0) {
    await recordAiUsage({
      tenantId: args.tenantId,
      providerId: args.refusal.providerId,
      credentialSource: args.refusal.credentialSource,
      feature: args.feature,
      requestRef: args.requestRef ?? null,
      outcome: "refused",
    });
  }
}

/* ------------------------------------------------------------------ */
/* ⭐ THE READ THAT MAKES IT WORTH RECORDING                           */
/* ------------------------------------------------------------------ */

export type UsageSummaryRow = {
  providerId: string;
  credentialSource: string;
  calls: number;
  failedCalls: number;
  totalTokens: number;
};

/**
 * ⚠️ SPLIT BY `credential_source`, ALWAYS. A combined total answers "how
 * much AI did they use", which is interesting. Split, it answers "how
 * much of it did WE pay for", which is the question this table was built
 * for and the only one that changes a decision.
 */
export async function usageSummary(
  tenantId: string,
  since: Date,
): Promise<readonly UsageSummaryRow[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.execute(sqlTag`
      SELECT provider_id,
             credential_source,
             count(*)::int                                       AS calls,
             count(*) FILTER (WHERE outcome = 'failed')::int      AS failed_calls,
             coalesce(sum(total_tokens), 0)::bigint              AS total_tokens
        FROM ai_usage
       WHERE tenant_id = ${tenantId}::uuid
         AND occurred_at >= ${since.toISOString()}::timestamptz
       GROUP BY provider_id, credential_source
       ORDER BY total_tokens DESC
    `),
  );

  const list = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: unknown[] }).rows ?? []);

  return list.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      providerId: String(row.provider_id ?? ""),
      credentialSource: String(row.credential_source ?? ""),
      calls: Number(row.calls ?? 0),
      failedCalls: Number(row.failed_calls ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
    };
  });
}
