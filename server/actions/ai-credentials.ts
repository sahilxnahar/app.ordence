"use server";

/**
 * Ordence — ⭐⭐⭐ A WORKSPACE'S OWN AI PROVIDER KEYS
 * Version: v1.65.0-alpha  ·  Batch 0105
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 NOT ONE EXPORT IN THIS FILE RETURNS A KEY
 * ══════════════════════════════════════════════════════════════════════
 * Every export here is a browser-reachable RPC endpoint with a stable
 * action id. An action that returned a stored provider key would be an
 * authenticated URL handing out every workspace's AI credentials, and it
 * would look completely ordinary in a code review.
 *
 * ⚠️ SO THE SHAPE IS ONE-WAY, exactly as `server/actions/connections.ts`
 * is: a key goes in through `saveAiProviderKey` and comes back out only
 * as "a key is stored", a status, and the dates. If a future screen ever
 * genuinely needs a value on a page, that is `readForPerson()` in
 * `server/vault/secrets.ts`, which demands a stated reason of at least
 * twenty characters and writes it to a log nobody can delete.
 *
 * ⭐ AND NOT EVEN A MASKED PREFIX. `db/schema/vault.ts` already made
 * that call for `api_credential` and the reasoning holds: the first four
 * characters of an API key are a provider fingerprint and the length
 * narrows a search. The customer knows which key they pasted.
 */

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  aiProviderCredentials,
  AI_CREDENTIAL_OWNER_KIND,
  AI_CREDENTIAL_SECRET_LABEL,
} from "@/db/schema/ai-credentials";
import { requirePermission, writeAudit } from "@/server/audit";
/** ⭐ 0115 — the policy and the measurement. */
import { parseAiCredentialPolicy } from "@/lib/ai/credentials";
import { usageSummary } from "@/server/ai/usage";
import { toSalesActionError } from "@/server/sales/guards";
import { vaultReadiness } from "@/server/vault/crypto";
import { eraseSecretsFor, putSecret } from "@/server/vault/secrets";
import {
  getAiProviderStatus,
  invalidateTenantCredentials,
  type AiProviderStatus,
} from "@/server/ai/credentials";
import { PROVIDERS_BY_ID } from "@/lib/ai/providers";
import { credentialCompleteness } from "@/lib/ai/credentials";
import type { ActionResult } from "@/lib/validators/crm";

const MANAGE = "settings:update" as const;

const SETTINGS_PATH = "/settings/ai";

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

/**
 * 🔴 READS `ai_provider_credentials`, WHICH HOLDS NO KEY, AND NEVER
 * TOUCHES `vault_secrets.ciphertext`. Same rule `getConnections` follows
 * and for the same reason: a value that is never loaded is a value that
 * cannot be accidentally serialised into a page.
 */
export async function getAiProviders(): Promise<
  ActionResult<AiProviderStatus & { vaultReady: boolean; vaultMessage: string | null }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    const readiness = vaultReadiness();
    const status = await getAiProviderStatus(ctx.tenant.id);
    return {
      ok: true,
      data: {
        ...status,
        vaultReady: readiness.ready,
        vaultMessage: readiness.message,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getAiProviders");
  }
}

/* ------------------------------------------------------------------ */
/* THE KEY                                                             */
/* ------------------------------------------------------------------ */

const saveSchema = z.object({
  providerId: z.string().min(1).max(60),
  /** ⚠️ Trimmed, because a pasted key almost always carries whitespace. */
  apiKey: z.string().min(8).max(4000),
  /**
   * ⚠️ NOT A SECRET, and it is required for exactly one provider. See
   * `requiresAccountId()` in lib/ai/credentials.ts.
   */
  accountId: z.string().max(120).optional().nullable(),
});

/**
 * 🔴 THE ONLY WAY A WORKSPACE'S AI KEY ENTERS THE SYSTEM, and it returns
 * nothing about the value except whether it changed.
 */
export async function saveAiProviderKey(
  input: unknown,
): Promise<ActionResult<{ rotated: boolean; unchanged: boolean }>> {
  try {
    const data = saveSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const provider = PROVIDERS_BY_ID[data.providerId];
    if (!provider) {
      return { ok: false, error: "That is not a provider Ordence knows about." };
    }

    /**
     * ⚠️ CHECKED BEFORE THE VALUE IS TOUCHED. A save that fails after a
     * key has been typed is a key that has been typed into a browser,
     * which is one autofill store and one screenshot away from being
     * somewhere else.
     */
    const readiness = vaultReadiness();
    if (!readiness.ready) {
      return { ok: false, error: readiness.message ?? "The vault is not configured." };
    }

    const apiKey = data.apiKey.trim();
    if (apiKey.length === 0) {
      return { ok: false, error: "Refusing to store an empty value." };
    }

    const accountId = data.accountId?.trim() || null;

    /**
     * 🔴 THE PAIR, REFUSED HERE FIRST AND WITH A SENTENCE A PERSON CAN
     * ACT ON. The database constraint in 0105 and the resolver both
     * refuse it too — three places, because the customer can arrive at
     * it from any of them, and because with a token and no account id
     * the request URL is built with an empty account segment, every call
     * fails, and nothing anywhere reports why.
     */
    const completeness = credentialCompleteness(data.providerId, true, accountId);
    if (!completeness.complete) {
      return { ok: false, error: completeness.note ?? "This credential is incomplete." };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [existing] = await tx
          .select({ id: aiProviderCredentials.id })
          .from(aiProviderCredentials)
          .where(
            and(
              eq(aiProviderCredentials.tenantId, ctx.tenant.id),
              eq(aiProviderCredentials.providerId, data.providerId),
            ),
          )
          .limit(1);

        let rowId = existing?.id ?? null;

        if (rowId === null) {
          /**
           * ⭐ THE ROW IS CREATED BEFORE THE SECRET IS SEALED, because
           * the vault stores the secret under this row's id as its
           * owner. The reverse order would need a placeholder owner and
           * an update, which is one more state to get wrong.
           */
          const [created] = await tx
            .insert(aiProviderCredentials)
            .values({
              tenantId: ctx.tenant.id,
              providerId: data.providerId,
              accountId,
              // ⚠️ 'active', not 'failing'. Nothing has failed yet, and a
              // key entered thirty seconds ago that has never been used
              // must not wear a red badge.
              status: "active",
              createdBy: ctx.user.id,
              updatedBy: ctx.user.id,
            })
            .returning({ id: aiProviderCredentials.id });
          rowId = created?.id ?? null;
        } else {
          await tx
            .update(aiProviderCredentials)
            .set({
              accountId,
              /**
               * ⭐ A NEW KEY CLEARS A FAILURE, because a `failing`
               * credential is one waiting for exactly this.
               *
               * ⚠️ It does NOT un-disable one somebody deliberately
               * switched off. Same distinction `saveCredential` makes
               * between a revoked connection and a paused one.
               */
              status: sql`CASE WHEN ${aiProviderCredentials.status} = 'disabled'
                               THEN 'disabled' ELSE 'active' END`,
              lastFailureAt: null,
              lastFailureKind: null,
              lastFailureMessage: null,
              updatedAt: new Date(),
              updatedBy: ctx.user.id,
            })
            .where(eq(aiProviderCredentials.id, rowId));
        }

        if (!rowId) throw new Error("The provider key could not be stored.");

        const put = await putSecret({
          tx,
          tenantId: ctx.tenant.id,
          ownerKind: AI_CREDENTIAL_OWNER_KIND,
          ownerId: rowId,
          kind: "api_credential",
          label: AI_CREDENTIAL_SECRET_LABEL,
          plaintext: apiKey,
          userId: ctx.user.id,
          userEmail: ctx.user.email ?? null,
        });

        if (!put.ok) throw new Error(put.error);

        await writeAudit(ctx, {
          action: "update",
          resourceType: "ai_provider_credential",
          resourceId: rowId,
          // 🔴 THE NAME OF THE PROVIDER. NEVER THE KEY, AND NEVER ITS
          // LENGTH OR ITS FIRST CHARACTERS.
          newValue: { providerId: data.providerId, rotated: put.rotated },
          severity: "critical",
        });

        return { rotated: put.rotated, unchanged: put.unchanged };
      },
      { impersonationId: ctx.impersonationId },
    );

    // ⭐ So the rotation takes effect on this instance immediately rather
    // than up to a minute later. See the cache note in server/ai/credentials.ts.
    invalidateTenantCredentials(ctx.tenant.id);
    revalidatePath(SETTINGS_PATH);
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "saveAiProviderKey");
  }
}

/* ------------------------------------------------------------------ */
/* ENABLE / DISABLE                                                    */
/* ------------------------------------------------------------------ */

const enabledSchema = z.object({
  providerId: z.string().min(1).max(60),
  enabled: z.boolean(),
});

/**
 * ⭐ SWITCH A STORED KEY OFF WITHOUT DELETING IT.
 *
 * ⚠️ The case this exists for is real and is not "tidiness": a customer
 * whose own Groq account is being investigated wants to fall back to
 * Ordence's key for a week without losing their key and having to get it
 * reissued. Deleting is the destructive answer to a reversible question.
 */
export async function setAiProviderEnabled(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  try {
    const data = enabledSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const status = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const next = data.enabled ? "active" : "disabled";
        await tx
          .update(aiProviderCredentials)
          .set({ status: next, updatedAt: new Date(), updatedBy: ctx.user.id })
          .where(
            and(
              eq(aiProviderCredentials.tenantId, ctx.tenant.id),
              eq(aiProviderCredentials.providerId, data.providerId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "ai_provider_credential",
          resourceId: data.providerId,
          newValue: { providerId: data.providerId, status: next },
          severity: "notice",
        });

        return next;
      },
      { impersonationId: ctx.impersonationId },
    );

    invalidateTenantCredentials(ctx.tenant.id);
    revalidatePath(SETTINGS_PATH);
    return { ok: true, data: { status } };
  } catch (err) {
    return toSalesActionError(err, "setAiProviderEnabled");
  }
}

/* ------------------------------------------------------------------ */
/* REMOVE                                                              */
/* ------------------------------------------------------------------ */

const removeSchema = z.object({
  providerId: z.string().min(1).max(60),
  reason: z.string().min(5).max(500),
});

/**
 * ⭐ REMOVING A KEY ERASES THE SECRET AND KEEPS THE RECORD THAT IT
 * EXISTED.
 *
 * 🔴 The vault has no DELETE for the application role, on purpose.
 * `ordence_vault_erase` zeroes the ciphertext and keeps the row as the
 * receipt, because an absence proves nothing: it is indistinguishable
 * from never having held the credential, and from having quietly moved
 * it somewhere else.
 *
 * ⚠️ THE `ai_provider_credentials` ROW ITSELF IS DELETED, AND THAT IS A
 * DIFFERENT DECISION FOR A DIFFERENT OBJECT. That row is a preference —
 * "this workspace uses its own Groq key" — not evidence. Keeping
 * tombstones would accumulate dead entries on a settings screen and the
 * unique index on (tenant_id, provider_id) would then refuse a re-add.
 * The evidence lives in `vault_secrets`, which cannot be deleted, and in
 * `audit_logs`, which is append-only. Section 4 of 0105 argues this at
 * the grant.
 */
export async function removeAiProviderKey(
  input: unknown,
): Promise<ActionResult<{ secretsErased: number }>> {
  try {
    const data = removeSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const secretsErased = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .select({ id: aiProviderCredentials.id })
          .from(aiProviderCredentials)
          .where(
            and(
              eq(aiProviderCredentials.tenantId, ctx.tenant.id),
              eq(aiProviderCredentials.providerId, data.providerId),
            ),
          )
          .limit(1);

        if (!row) throw new Error("No key is stored for that provider.");

        const erased = await eraseSecretsFor({
          tx,
          tenantId: ctx.tenant.id,
          ownerKind: AI_CREDENTIAL_OWNER_KIND,
          ownerId: row.id,
          reason: data.reason,
        });

        await tx
          .delete(aiProviderCredentials)
          .where(eq(aiProviderCredentials.id, row.id));

        await writeAudit(ctx, {
          action: "delete",
          resourceType: "ai_provider_credential",
          resourceId: row.id,
          newValue: {
            providerId: data.providerId,
            reason: data.reason,
            secretsErased: erased,
          },
          severity: "critical",
        });

        return erased;
      },
      { impersonationId: ctx.impersonationId },
    );

    invalidateTenantCredentials(ctx.tenant.id);
    revalidatePath(SETTINGS_PATH);
    return { ok: true, data: { secretsErased } };
  } catch (err) {
    return toSalesActionError(err, "removeAiProviderKey");
  }
}

/* ================================================================== */
/* ⭐⭐⭐ WHOSE CREDITS — 0115                                          */
/* ================================================================== */

/**
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE HOLE 0105 LEFT, AND IT WAS ONE LINE
 * ══════════════════════════════════════════════════════════════════════
 * 0105's resolver started from `{ ...platform.byProvider }` and let
 * tenant rows override. A workspace that configured Groq and not Google
 * reached Google ON ORDENCE'S KEY, silently. Not as a fallback anybody
 * chose — as the shape of the merge.
 *
 * ⭐ 0115 adds a policy. This is the screen's window onto it, plus the
 * measurement that makes it checkable rather than believable.
 */

export type AiSpendView = {
  policy: string;
  policyLabel: string;
  policyExplains: string;
  /** ⚠️ Split by whose key. A combined total answers the wrong question. */
  rows: Array<{
    providerId: string;
    credentialSource: string;
    calls: number;
    failedCalls: number;
    totalTokens: number;
  }>;
  platformCalls: number;
  tenantCalls: number;
  sinceIso: string;
};

const POLICY_COPY: Record<string, { label: string; explains: string }> = {
  byo_required: {
    label: "Your own keys only",
    explains:
      "Ordence's own provider keys are not available to this workspace at all. A provider you have not configured is unavailable, and nothing you do here is ever charged to Ordence.",
  },
  byo_preferred: {
    label: "Your own keys first",
    explains:
      "Your keys are used wherever you have them. For a provider you have not configured, Ordence's key is used and every one of those calls is counted below, so you can see exactly what is left to move.",
  },
  platform_allowed: {
    label: "Ordence's keys are available",
    explains:
      "Where you have not configured a provider, Ordence's own key is used. This is the arrangement workspaces had before the policy existed.",
  },
};

/**
 * ⚠️ `settings:read`, THE SAME AS SEEING THE KEYS. Knowing how much AI
 * this workspace used is not privileged relative to being able to add the
 * key that pays for it.
 */
export async function getAiSpend(
  input?: unknown,
): Promise<ActionResult<AiSpendView>> {
  try {
    const parsed = z
      .object({ days: z.number().int().min(1).max(365).optional() })
      .safeParse(input ?? {});
    const days = parsed.success ? (parsed.data.days ?? 30) : 30;

    const ctx = await requirePermission("settings:read");
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await usageSummary(ctx.tenant.id, since);
    const policy = parseAiCredentialPolicy(ctx.tenant.aiCredentialPolicy);
    const copy = POLICY_COPY[policy] ?? POLICY_COPY.byo_required!;

    return {
      ok: true,
      data: {
        policy,
        policyLabel: copy.label,
        policyExplains: copy.explains,
        rows: rows.map((r) => ({ ...r })),
        /**
         * 🔴 THE TWO NUMBERS THAT MATTER, SEPARATED. A workspace on
         * `byo_required` should see `platformCalls` at zero, and if it is
         * not zero then either the policy is not what they were told or
         * the resolver has a hole — and either way somebody should find
         * out from this screen rather than from an invoice.
         */
        platformCalls: rows
          .filter((r) => r.credentialSource === "platform")
          .reduce((t, r) => t + r.calls, 0),
        tenantCalls: rows
          .filter((r) => r.credentialSource === "tenant")
          .reduce((t, r) => t + r.calls, 0),
        sinceIso: since.toISOString(),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getAiSpend");
  }
}
