import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE RESOLVER: ASK THE TENANT FIRST, THEN THE PLATFORM
 * Version: v1.65.0-alpha  ·  Batch 0105
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES
 * ══════════════════════════════════════════════════════════════════════
 * `lib/ai/client.ts` had exactly two reads of a provider key and both
 * were `process.env`:
 *
 *   :109  which providers exist  → a PLATFORM-WIDE FACT
 *   :180  which key to send      → a PLATFORM-WIDE VALUE
 *
 * There was no tenant dimension in the path at all, so every workspace
 * shared one key, one free-tier budget, one rate limit and one circuit
 * breaker. This module is the tenant dimension.
 *
 * ⚠️ IT LIVES IN `server/` BECAUSE IT READS THE DATABASE AND OPENS THE
 * VAULT. `lib/ai/*` may not import `@/db` — `npm run check:boundaries`
 * would fail it, correctly, because `lib/ai/goal-planner.ts` is pure
 * planning code in the same import graph. So this produces a
 * `ProviderCredentialSet` and `chatCompletion` takes it as data.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE FALLBACK IS PER PROVIDER, NOT ALL-OR-NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * A workspace that has supplied a Groq key and nothing else uses THEIR
 * Groq and OUR Gemini. Making it all-or-nothing in either direction is
 * worse: "any tenant key means no platform keys" silently removes
 * providers the customer never asked to lose, and "platform always wins"
 * makes the feature decorative.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE KEY IS READ AT CALL TIME, NOT AT MODULE LOAD
 * ══════════════════════════════════════════════════════════════════════
 * `server/vault/crypto.ts:125-131` sets out why, and it applies to the
 * vault key and to this cache alike: a module-level read runs during
 * `next build`, when secrets are legitimately absent, and it freezes the
 * value for the process lifetime, which breaks rotation.
 *
 * 🔴 THE CACHE BELOW IS BOUNDED AT SIXTY SECONDS FOR EXACTLY THAT
 *    REASON, and `invalidateTenantCredentials()` is called by the save
 *    and remove actions so a rotation is immediate on the instance that
 *    performed it and at most a minute behind everywhere else. A cache
 *    with no expiry would be a module-level read wearing a Map.
 */

import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  aiProviderCredentials,
  AI_CREDENTIAL_OWNER_KIND,
  AI_CREDENTIAL_SECRET_LABEL,
} from "@/db/schema/ai-credentials";
import { PROVIDERS_BY_ID, AI_PROVIDERS } from "@/lib/ai/providers";
import { platformCredentialSet } from "@/lib/ai/client";
import {
  applyCredentialPolicy,
  parseAiCredentialPolicy,
  type AiCredentialPolicy,
} from "@/lib/ai/credentials";
import { tenants } from "@/db/schema/core";
import {
  budgetScopeFor,
  credentialCompleteness,
  isMissingAiCredentialSchema,
  laneForCredential,
  requiresAccountId,
  type CredentialFailureKind,
  type CredentialSource,
  type CredentialSummary,
  type ProviderCredential,
  type ProviderCredentialSet,
  type UnusableProvider,
} from "@/lib/ai/credentials";
import { readForAiProvider } from "@/server/vault/secrets";

/**
 * The Drizzle transaction handle from `withTenant`. Typed loosely for
 * the same reason `server/vault/secrets.ts` does it: this module must
 * be usable from inside somebody else's transaction without importing
 * their handle's type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/* ------------------------------------------------------------------ */
/* MIGRATION TOLERANCE                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE CODE MAY LAND BEFORE 0105 DOES, AND IT MUST NOT BREAK THE
 *    ASSISTANT WHEN IT DOES.
 *
 * ⚠️ The classifier itself is a PURE function in `lib/ai/credentials.ts`
 * so that both of its branches can be exercised without a database.
 * `tests/ui/ai-tenant-credentials.test.ts` runs the resolver over a fake
 * transaction that throws 42P01 and asserts the platform set comes back
 * — rather than trusting the shape of a catch nobody has ever entered.
 */
const isSchemaMissingError = isMissingAiCredentialSchema;

/* ------------------------------------------------------------------ */
/* THE CACHE                                                           */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  readonly set: ProviderCredentialSet;
  readonly schemaReady: boolean;
  /** ⭐ 0115. Cached with the set, so a flip is picked up on the same TTL. */
  readonly policy: AiCredentialPolicy;
  readonly expiresAt: number;
}

/**
 * 🔴 THIS MAP HOLDS DECRYPTED API KEYS IN PROCESS MEMORY, and that is
 * stated rather than hidden. It is the same exposure `process.env` has
 * always had for the platform keys, bounded to sixty seconds and to the
 * tenants actually making AI calls.
 *
 * ⚠️ WHY IT EXISTS AT ALL: `server/ai/agent-runner.ts` loops up to
 * MAX_TOOL_ROUNDS chat completions in one conversation. Without this,
 * one customer question is a dozen transactions and a dozen AES-GCM
 * opens. The alternative — resolving once and threading the set through
 * every caller — was rejected because a set threaded through six call
 * sites is a set that gets stale in the one that forgets to re-resolve.
 */
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/**
 * ⭐ Called by `saveAiProviderKey` and `removeAiProviderKey` so a
 * rotation takes effect on this instance immediately. Other instances
 * pick it up within `CACHE_TTL_MS`.
 */
export function invalidateTenantCredentials(tenantId: string): void {
  cache.delete(tenantId);
}

/** For tests, and for nothing else. */
export function clearCredentialCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* THE RESOLVE                                                         */
/* ------------------------------------------------------------------ */

interface ResolvedCredentials {
  readonly set: ProviderCredentialSet;
  /**
   * ⚠️ `false` means 0105 has not been applied on this database. The
   * settings screen says so in words rather than showing an empty list
   * that looks like "you have not added any keys".
   */
  readonly schemaReady: boolean;
  /**
   * ⭐ 0115. The caller needs this to phrase a refusal: "this workspace
   * uses its own keys and none is configured" is a different sentence
   * from "no AI provider is configured for this deployment", and only
   * one of them is a problem the customer can fix.
   */
  readonly policy: AiCredentialPolicy;
}

async function loadFromDatabase(
  tx: Tx,
  tenantId: string,
): Promise<ResolvedCredentials> {
  const platform = platformCredentialSet();

  /**
   * ⭐⭐⭐ 0115 — THE POLICY, READ FIRST.
   *
   * ⚠️ A MISSING COLUMN MEANS 0115 HAS NOT BEEN APPLIED, and the honest
   * answer there is the pre-0115 behaviour rather than a hard cutover: a
   * deployment running new code against an old database must not stop
   * every workspace's assistant. `parseAiCredentialPolicy` defaults to
   * the STRICT value, so this is the one place that deliberately does
   * not use it.
   */
  let policy: AiCredentialPolicy = "platform_allowed";
  try {
    const [row] = await tx
      .select({ policy: tenants.aiCredentialPolicy })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (row?.policy) policy = parseAiCredentialPolicy(row.policy);
  } catch (err) {
    if (!isSchemaMissingError(err)) throw err;
  }

  let rows: Array<{
    id: string;
    providerId: string;
    accountId: string | null;
    status: string;
  }>;

  try {
    rows = (await tx
      .select({
        id: aiProviderCredentials.id,
        providerId: aiProviderCredentials.providerId,
        accountId: aiProviderCredentials.accountId,
        status: aiProviderCredentials.status,
      })
      .from(aiProviderCredentials)
      .where(eq(aiProviderCredentials.tenantId, tenantId))) as typeof rows;
  } catch (err) {
    if (isSchemaMissingError(err)) {
      /**
       * ⭐ Today's behaviour, exactly. The assistant keeps working on the
       * platform keys and the screen explains why nothing can be added.
       *
       * 🔴 EXCEPT UNDER `byo_required`. If somebody has been told their
       * workspace spends only its own keys, a missing `0105` table must
       * not quietly hand them ours — it must say there are no keys.
       */
      return {
        set: applyCredentialPolicy({
          policy,
          platform,
          tenant: { byProvider: {}, unusable: [] },
        }),
        schemaReady: false,
        policy,
      };
    }
    throw err;
  }

  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐⭐ 0115 — THE MERGE IS NO LONGER UNCONDITIONAL
   * ══════════════════════════════════════════════════════════════════
   * This used to be `{ ...platform.byProvider }` outright, so a workspace
   * that had configured Groq and not Google reached Google ON OUR KEY.
   * Not as a fallback anybody chose — as the shape of the merge.
   *
   * 🔴 THE TENANT SET IS NOW BUILT ALONE, and `applyCredentialPolicy()`
   * decides at the end whether the platform set goes underneath it. One
   * function, in `lib/ai/credentials.ts`, so no caller can forget it and
   * no second copy of the rule can drift.
   */
  const byProvider: Record<string, ProviderCredential> = {};
  const unusable: UnusableProvider[] = [];

  for (const row of rows) {
    /**
     * ⚠️ AN UNKNOWN PROVIDER ID IS SKIPPED, NOT THROWN ON. The registry
     * is a constant in the application and the column is a string; a row
     * left behind by a provider that was removed from the registry must
     * not take the whole assistant down for that workspace.
     */
    const provider = PROVIDERS_BY_ID[row.providerId];
    if (!provider) continue;

    /**
     * 🔴 `disabled` IS THE ONLY STATE THAT STOPS THE KEY BEING USED, and
     * it is the only state a PERSON sets. `failing` is written by the
     * router and deliberately does NOT skip the key: a key that failed
     * once at 3am and works now must not need a human to switch it back
     * on.
     */
    if (row.status === "disabled") continue;

    const completeness = credentialCompleteness(
      row.providerId,
      true,
      row.accountId,
    );
    if (!completeness.complete) {
      unusable.push({
        providerId: row.providerId,
        source: "tenant",
        note: completeness.note ?? "This credential is incomplete.",
      });
      // ⚠️ AND THE PLATFORM KEY IS LEFT IN PLACE. A tenant's broken entry
      // must not remove a provider that was working for them yesterday.
      continue;
    }

    const secret = await readForAiProvider({
      tx,
      tenantId,
      credentialId: row.id,
    });

    if (!secret.ok) {
      /**
       * ⚠️ THE COMMONEST CAUSE HERE IS A ROTATED `VAULT_ENCRYPTION_KEY`,
       * which orphans every stored secret. `openSecret` already produces
       * the right sentence and names the two real causes. It is surfaced
       * as `misconfigured` — the customer must re-enter the key — rather
       * than swallowed into "no provider configured".
       */
      unusable.push({
        providerId: row.providerId,
        source: "tenant",
        note: `${provider.label}: ${secret.error}`,
      });
      continue;
    }

    // ⭐ THE TENANT'S KEY REPLACES THE PLATFORM'S FOR THIS PROVIDER ONLY.
    byProvider[row.providerId] = {
      providerId: row.providerId,
      apiKey: secret.value,
      accountId: requiresAccountId(row.providerId) ? row.accountId : null,
      source: "tenant",
      budgetScope: budgetScopeFor("tenant", tenantId),
    };
  }

  /**
   * 🔴 THE POLICY IS APPLIED HERE AND NOWHERE ELSE. Under `byo_required`
   * the platform set is not merged and its `unusable` notes are dropped
   * with it — telling a bring-your-own workspace that our own
   * `CF_AI_TOKEN` is half-configured would leak this deployment's
   * settings into their screen, about a problem they cannot act on.
   */
  return {
    set: applyCredentialPolicy({ policy, platform, tenant: { byProvider, unusable } }),
    schemaReady: true,
    policy,
  };
}

/**
 * ⭐⭐ THE CREDENTIALS ONE WORKSPACE'S AI CALLS SHOULD USE.
 *
 * ⚠️ Takes a tenant id, so it lives in a `server-only` module and NOT in
 * a `"use server"` action file. `check-server-boundaries.mjs` rule 4
 * exists for exactly this: an exported action that accepts a tenant id
 * is the one route past row-level security.
 *
 * `tx` is optional. Pass it when you are already inside a
 * `withTenant()` — `server/automation/agent-dispatch.ts` is, and opening
 * a second transaction from inside the first would take a second
 * connection out of the pool for the length of an AI call.
 */
export async function resolveProviderCredentials(
  tenantId: string,
  tx?: Tx,
): Promise<ResolvedCredentials> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) {
    return { set: hit.set, schemaReady: hit.schemaReady, policy: hit.policy };
  }

  const resolved = tx
    ? await loadFromDatabase(tx, tenantId)
    : await withTenant(tenantId, (inner) => loadFromDatabase(inner, tenantId));

  cache.set(tenantId, {
    set: resolved.set,
    schemaReady: resolved.schemaReady,
    policy: resolved.policy,
    expiresAt: now + CACHE_TTL_MS,
  });

  return resolved;
}

/* ------------------------------------------------------------------ */
/* RECORDING WHAT HAPPENED                                             */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE WRITE THAT MAKES THE COLUMNS MEAN SOMETHING.
 *
 * 🔴 THIS EXISTS BECAUSE OF THE DEFECT THIS CODEBASE KEEPS PRODUCING:
 * ten times something has been declared, displayed, and enforced or
 * populated by nothing. `last_failure_kind` would be exactly that if
 * only the settings screen ever mentioned it.
 *
 * ⚠️ ONLY TENANT-SOURCED CREDENTIALS ARE RECORDED. There is no row for
 * the platform key and there should not be — it is not the tenant's
 * property, its health is the same for every workspace, and writing a
 * row per tenant for it would be a per-tenant copy of one global fact.
 */
export async function recordCredentialOutcome(args: {
  readonly tenantId: string;
  readonly providerId: string;
  readonly outcome: "success" | "failure";
  readonly kind?: CredentialFailureKind;
  readonly detail?: string;
  readonly tx?: Tx;
}): Promise<void> {
  const run = async (tx: Tx) => {
    const now = new Date();

    if (args.outcome === "success") {
      await tx
        .update(aiProviderCredentials)
        .set({
          lastSuccessAt: now,
          lastUsedAt: now,
          useCount: sql`${aiProviderCredentials.useCount} + 1`,
          /**
           * ⭐ A SUCCESS CLEARS `failing`, AND ONLY `failing`.
           *
           * ⚠️ It must not clear `disabled`. Somebody who switched their
           * key off should not have it switched back on by a call that
           * happened to succeed — and one cannot succeed, because the
           * resolver skips disabled rows. The condition is belt to that
           * brace and it also documents the intent.
           */
          status: sql`CASE WHEN ${aiProviderCredentials.status} = 'failing'
                           THEN 'active' ELSE ${aiProviderCredentials.status} END`,
          lastFailureKind: null,
          lastFailureMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(aiProviderCredentials.tenantId, args.tenantId),
            eq(aiProviderCredentials.providerId, args.providerId),
          ),
        );
      return;
    }

    /**
     * ⚠️ `rate_limited` DOES NOT MARK THE CREDENTIAL AS FAILING, for the
     * same reason `router.afterFailure` does not trip the breaker on a
     * 429: being rate-limited is the provider working exactly as
     * documented, and it recovers on its own at the top of the next
     * minute. Painting a red badge on a customer's settings screen for
     * it would train them to ignore the badge.
     */
    const marksFailing =
      args.kind === "auth" || args.kind === "quota" || args.kind === "misconfigured";

    await tx
      .update(aiProviderCredentials)
      .set({
        lastUsedAt: now,
        useCount: sql`${aiProviderCredentials.useCount} + 1`,
        lastFailureAt: now,
        lastFailureKind: args.kind ?? "error",
        // ⚠️ The provider's own words, truncated. A RESPONSE body: the
        // key travels in a request header and is never read back.
        lastFailureMessage: (args.detail ?? "").slice(0, 1000) || null,
        status: sql`CASE WHEN ${aiProviderCredentials.status} = 'disabled'
                         THEN 'disabled'
                         ELSE ${marksFailing ? sql`'failing'` : aiProviderCredentials.status}
                    END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiProviderCredentials.tenantId, args.tenantId),
          eq(aiProviderCredentials.providerId, args.providerId),
        ),
      );
  };

  try {
    if (args.tx) await run(args.tx);
    else await withTenant(args.tenantId, run);
  } catch (err) {
    /**
     * ⚠️ NEVER FATAL. This is bookkeeping about an AI call that has
     * already happened. Failing the customer's request because we could
     * not write a `last_used_at` would be a worse product than a stale
     * timestamp, and before 0105 is applied the table is not there at
     * all.
     */
    if (!isSchemaMissingError(err)) {
      console.error("[ai-credentials] outcome not recorded:", err);
    }
  }

  // ⭐ The status changed, so the cached set is stale in the one way that
  // matters: a newly `disabled` row must stop being handed out.
  invalidateTenantCredentials(args.tenantId);
}

/* ------------------------------------------------------------------ */
/* WHAT THE SETTINGS SCREEN IS ALLOWED TO SEE                          */
/* ------------------------------------------------------------------ */

export interface ProviderStatusRow extends CredentialSummary {
  readonly status: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
  readonly lastFailureAt: string | null;
  readonly lastFailureKind: string | null;
  readonly lastFailureMessage: string | null;
  readonly accountId: string | null;
  readonly requiresAccountId: boolean;
}

export interface AiProviderStatus {
  readonly schemaReady: boolean;
  readonly rows: readonly ProviderStatusRow[];
  /**
   * ⭐⭐ WHETHER ANY PROVIDER MAY SEE THIS WORKSPACE'S OWN DATA.
   *
   * 🔴 THIS IS THE NUMBER THE BRIEF ASKED TO BE MADE LEGIBLE. The live
   * deployment has `OPENROUTER_API_KEY` and nothing else. OpenRouter is
   * open-lane, so this is ZERO, so all six background monitors — every
   * one of which declares `sensitivity: "tenant"` — have no eligible
   * provider and refuse on every run. Correctly, and completely
   * silently. A count on a screen is the difference.
   */
  readonly confidentialProvidersAvailable: number;
}

/**
 * 🔴 NOT ONE FIELD RETURNED HERE IS A CREDENTIAL, and there is no code
 * path from this function to one. It reads `ai_provider_credentials`,
 * which holds no key, and it never touches `vault_secrets.ciphertext` —
 * the same rule `getConnections` follows and for the same reason: a
 * value that is never loaded is a value that cannot be accidentally
 * serialised into a page.
 */
export async function getAiProviderStatus(
  tenantId: string,
): Promise<AiProviderStatus> {
  const platform = platformCredentialSet();

  let schemaReady = true;
  let rows: Array<{
    providerId: string;
    accountId: string | null;
    status: string;
    lastSuccessAt: Date | null;
    lastUsedAt: Date | null;
    useCount: number;
    lastFailureAt: Date | null;
    lastFailureKind: string | null;
    lastFailureMessage: string | null;
  }> = [];

  try {
    rows = (await withTenant(tenantId, (tx) =>
      tx
        .select({
          providerId: aiProviderCredentials.providerId,
          accountId: aiProviderCredentials.accountId,
          status: aiProviderCredentials.status,
          lastSuccessAt: aiProviderCredentials.lastSuccessAt,
          lastUsedAt: aiProviderCredentials.lastUsedAt,
          useCount: aiProviderCredentials.useCount,
          lastFailureAt: aiProviderCredentials.lastFailureAt,
          lastFailureKind: aiProviderCredentials.lastFailureKind,
          lastFailureMessage: aiProviderCredentials.lastFailureMessage,
        })
        .from(aiProviderCredentials)
        .where(eq(aiProviderCredentials.tenantId, tenantId)),
    )) as typeof rows;
  } catch (err) {
    if (!isSchemaMissingError(err)) throw err;
    schemaReady = false;
  }

  const byId = new Map(rows.map((r) => [r.providerId, r]));

  const out: ProviderStatusRow[] = AI_PROVIDERS.map((provider) => {
    const row = byId.get(provider.id);
    const platformCred = platform.byProvider[provider.id];

    const completeness = credentialCompleteness(
      provider.id,
      row !== undefined,
      row?.accountId ?? null,
    );

    const tenantUsable =
      row !== undefined && row.status !== "disabled" && completeness.complete;

    /**
     * ⭐ WHICH KEY A REQUEST WOULD ACTUALLY USE RIGHT NOW. Not "which
     * keys exist" — the customer needs to know which one is answering,
     * because that is what decides who gets the bill and who fixes it.
     */
    const effectiveSource: CredentialSource | null = tenantUsable
      ? "tenant"
      : platformCred
        ? "platform"
        : null;

    const blockedFromPlatform = platform.unusable.find(
      (u) => u.providerId === provider.id,
    );

    return {
      providerId: provider.id,
      /**
       * ⭐⭐ THE LANE ON THE SCREEN COMES THROUGH THE RULE, NOT ROUND IT.
       *
       * 🔴 `provider.lane` would produce the identical string today and
       * that is exactly why this goes through `laneForCredential()`
       * instead. The screen's sentence — "may be shown your own business
       * data" versus "general drafting only" — is the customer's whole
       * basis for deciding what to paste in. If somebody ever adds a
       * per-tenant lane override, it has to be added to that function,
       * where the argument against it is written down, rather than to a
       * ternary here that nobody would think to look at.
       */
      lane: laneForCredential(
        provider,
        tenantUsable ? "tenant" : "platform",
      ),
      label: provider.label,
      mayTrainOnInputs: provider.mayTrainOnInputs,
      keyUrl: provider.keyUrl,
      jurisdiction: provider.jurisdiction ?? null,
      tenantSupplied: row !== undefined,
      platformSupplied: platformCred !== undefined,
      effectiveSource,
      blockedNote:
        (row !== undefined && !completeness.complete ? completeness.note : null) ??
        blockedFromPlatform?.note ??
        null,
      status: row?.status ?? null,
      lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
      lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
      useCount: Number(row?.useCount ?? 0),
      lastFailureAt: row?.lastFailureAt?.toISOString() ?? null,
      lastFailureKind: row?.lastFailureKind ?? null,
      lastFailureMessage: row?.lastFailureMessage ?? null,
      accountId: row?.accountId ?? null,
      requiresAccountId: requiresAccountId(provider.id),
    };
  });

  return {
    schemaReady,
    rows: out,
    confidentialProvidersAvailable: out.filter(
      (r) => r.lane === "confidential" && r.effectiveSource !== null,
    ).length,
  };
}

/** Re-exported so callers need one import, not two. */
export { AI_CREDENTIAL_OWNER_KIND, AI_CREDENTIAL_SECRET_LABEL };
