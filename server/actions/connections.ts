"use server";

/**
 * Ordence — ⭐⭐⭐ CONNECTIONS
 * Version: v1.12.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 NOT ONE EXPORT IN THIS FILE RETURNS A CREDENTIAL
 * ══════════════════════════════════════════════════════════════════════
 * Every export here is a browser-reachable RPC endpoint. An action that
 * returned a stored API key would be an authenticated URL that hands out
 * every tenant's integration credentials, and it would look completely
 * ordinary in a code review.
 *
 * ⚠️ SO THE SHAPE IS ONE-WAY. A secret goes in through `saveCredential`
 * and comes back out only as the vault's masked display and its access
 * count. If a future screen genuinely needs a value on a page, that is
 * `readForPerson` in `server/vault/secrets.ts`, which demands a stated
 * reason and writes it to a log nobody can delete.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THE FAILURE LOG IS THE FEATURE
 * ══════════════════════════════════════════════════════════════════════
 * When leads stop arriving the customer rings and asks why. If the
 * answer is "let me check with the developer", the integration has
 * already failed twice: once technically, and once as a product.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import {
  connections,
  syncRuns,
  webhookEndpoints,
} from "@/db/schema/integrations";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { generatePathToken, vaultReadiness } from "@/server/vault/crypto";
import {
  CONNECTION_OWNER_KIND,
  eraseSecretsFor,
  putSecret,
} from "@/server/vault/secrets";
import type { ActionResult } from "@/lib/validators/crm";
import { webhookPathFor, webhookUrlFor } from "@/lib/integrations/webhook-path";
import { probeConnection as runProbe } from "@/server/integrations/probe";
import {
  CONNECTOR_POLICIES,
  assessSyncHealth,
  effectiveIntervalSeconds,
  mayFetchNow,
  policyFor,
  type ConnectionState,
  type ConnectorKey,
  type ConnectorPolicy,
  type SyncOutcome,
} from "@/lib/integrations/policy";

const MANAGE = "settings:update" as const;

const connectorKeys = Object.keys(CONNECTOR_POLICIES) as [
  ConnectorKey,
  ...ConnectorKey[],
];

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

const createSchema = z.object({
  connectorKey: z.enum(connectorKeys),
  name: z.string().min(1).max(160),
  config: z.record(z.unknown()).default({}),
  pollEverySeconds: z.number().int().min(0).max(86_400).optional(),
});

export async function createConnection(
  input: unknown,
): Promise<ActionResult<{ id: string; webhookPath: string | null }>> {
  try {
    const data = createSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const policy = policyFor(data.connectorKey);
    if (!policy) return { ok: false, error: "Unknown connector." };

    // ⭐ THE FAR END'S FLOOR WINS OVER WHATEVER WAS TYPED.
    //
    // ⚠️ Somebody entering 60 seconds for a connector with a five minute
    // floor should not be able to lock their own account out.
    const requested = data.pollEverySeconds ?? policy.defaultPollSeconds;
    const pollEverySeconds =
      policy.transport === "push" || requested === 0
        ? 0
        : Math.max(requested, policy.minIntervalSeconds);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [row] = await tx
          .insert(connections)
          .values({
            tenantId: ctx.tenant.id,
            connectorKey: data.connectorKey,
            name: data.name,
            config: data.config,
            pollEverySeconds,
            // 🔴 A NEW CONNECTION IS PAUSED, NOT CONNECTED.
            //
            // ⚠️ It has no credential yet. Creating it in a "connected"
            // state would put a green tick on a screen for something
            // that has never once worked.
            state: "paused",
            createdBy: ctx.user.id,
            updatedBy: ctx.user.id,
          })
          .returning({ id: connections.id });

        if (!row) throw new Error("The connection could not be saved.");

        // ⭐ A PUSH CONNECTOR GETS ITS ADDRESS IMMEDIATELY, because for
        // JustDial that address is the entire setup: it goes to their
        // account manager and nothing happens until it does.
        let webhookPath: string | null = null;
        if (policy.transport !== "pull") {
          const pathToken = generatePathToken();
          await tx.insert(webhookEndpoints).values({
            tenantId: ctx.tenant.id,
            connectionId: row.id,
            pathToken,
            // ⭐ FROM THE POLICY TABLE, NOT FROM A TERNARY HERE.
            //
            // 🔴 The ternary this replaced assumed anything that was not
            // JustDial signs with `x-hub-signature-256`. IndiaMART's push
            // documents no signature of any kind, so every one of its
            // deliveries would have been recorded `absent` and refused.
            verification: policy.webhookVerification,
            signatureHeader: policy.webhookSignatureHeader,
            createdBy: ctx.user.id,
          });
          // 🔴 THE HELPER, NOT A TEMPLATE STRING. This line used to read
          // `/api/webhooks/${data.connectorKey}/${pathToken}`, and there
          // has never been a route with a connector segment in it. See
          // lib/integrations/webhook-path.ts.
          webhookPath = webhookPathFor(pathToken);
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "connection",
          resourceId: row.id,
          newValue: { connectorKey: data.connectorKey, name: data.name },
          severity: "notice",
        });

        return { id: row.id, webhookPath };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/connections");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "createConnection");
  }
}

/* ------------------------------------------------------------------ */
/* THE CREDENTIAL                                                      */
/* ------------------------------------------------------------------ */

const credentialSchema = z.object({
  connectionId: z.string().uuid(),
  secretName: z.string().min(1).max(60),
  /** ⚠️ Trimmed, because a pasted key almost always carries whitespace. */
  value: z.string().min(8).max(4000),
  expiresAt: z.coerce.date().optional().nullable(),
});

/**
 * 🔴 THE ONLY WAY A CREDENTIAL ENTERS THE SYSTEM, and it returns
 * nothing about the value except whether it changed.
 */
export async function saveCredential(
  input: unknown,
): Promise<ActionResult<{ rotated: boolean; unchanged: boolean }>> {
  try {
    const data = credentialSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    // ⚠️ CHECKED BEFORE THE VALUE IS TOUCHED. A save that fails after a
    // key has been typed is a key that has been typed into a browser,
    // which is one autofill store away from being somewhere else.
    const readiness = vaultReadiness();
    if (!readiness.ready) {
      return { ok: false, error: readiness.message ?? "The vault is not configured." };
    }

    const value = data.value.trim();
    if (value.length === 0) {
      return { ok: false, error: "Refusing to store an empty value." };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [connection] = await tx
          .select({
            id: connections.id,
            connectorKey: connections.connectorKey,
            state: connections.state,
          })
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, ctx.tenant.id),
              eq(connections.id, data.connectionId),
            ),
          )
          .limit(1);

        if (!connection) throw new Error("No such connection.");

        const policy = policyFor(connection.connectorKey);
        if (policy && !policy.secretNames.includes(data.secretName)) {
          throw new Error(
            `${policy.label} does not use a secret called "${data.secretName}". It expects: ${policy.secretNames.join(", ") || "none"}.`,
          );
        }

        const put = await putSecret({
          tx,
          tenantId: ctx.tenant.id,
          ownerKind: CONNECTION_OWNER_KIND,
          ownerId: connection.id,
          kind: "api_credential",
          label: data.secretName,
          plaintext: value,
          userId: ctx.user.id,
          userEmail: ctx.user.email ?? null,
          expiresAt: data.expiresAt ?? null,
        });

        if (!put.ok) throw new Error(put.error);

        // ⭐ A NEW KEY CLEARS A REVOCATION, because a revoked connection
        // is one waiting for exactly this.
        //
        // ⚠️ It does NOT un-pause a connection somebody deliberately
        // switched off, and it does not claim "connected" either. The
        // first successful fetch decides that.
        if (connection.state === "revoked" && !put.unchanged) {
          await tx
            .update(connections)
            .set({
              state: "paused",
              stateReason: null,
              consecutiveFailures: 0,
              lockedUntil: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: new Date(),
              updatedBy: ctx.user.id,
            })
            .where(eq(connections.id, connection.id));
        }

        await writeAudit(ctx, {
          action: "update",
          resourceType: "connection_credential",
          resourceId: connection.id,
          // 🔴 THE NAME OF THE SECRET. NEVER THE SECRET, AND NEVER ITS
          // LENGTH OR ITS FIRST CHARACTERS.
          newValue: { secretName: data.secretName, rotated: put.rotated },
          severity: "critical",
        });

        return { rotated: put.rotated, unchanged: put.unchanged };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/connections");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "saveCredential");
  }
}

/* ------------------------------------------------------------------ */
/* PAUSE, RESUME, REMOVE                                               */
/* ------------------------------------------------------------------ */

const stateSchema = z.object({
  connectionId: z.string().uuid(),
  active: z.boolean(),
});

export async function setConnectionActive(
  input: unknown,
): Promise<ActionResult<{ state: string }>> {
  try {
    const data = stateSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const state = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const next: ConnectionState = data.active ? "connected" : "paused";
        await tx
          .update(connections)
          .set({
            isActive: data.active,
            state: next,
            // ⚠️ 0064 refuses any state but connected or paused without a
            // reason, and both of these are reason-free by definition.
            stateReason: null,
            lockedUntil: null,
            consecutiveFailures: 0,
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(connections.tenantId, ctx.tenant.id),
              eq(connections.id, data.connectionId),
            ),
          );

        await writeAudit(ctx, {
          action: "update",
          resourceType: "connection",
          resourceId: data.connectionId,
          newValue: { state: next },
          severity: "notice",
        });
        return next;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/connections");
    return { ok: true, data: { state } };
  } catch (err) {
    return toSalesActionError(err, "setConnectionActive");
  }
}

const removeSchema = z.object({
  connectionId: z.string().uuid(),
  reason: z.string().min(5).max(500),
});

/**
 * ⭐ REMOVING A CONNECTION ERASES ITS CREDENTIALS AND KEEPS THE RECORD
 * THAT THEY EXISTED.
 *
 * 🔴 The vault has no DELETE for the application role, on purpose.
 * `ordence_vault_erase` zeroes the ciphertext and keeps the row as the
 * receipt, because an absence proves nothing: it is indistinguishable
 * from never having held the credential, and from having quietly moved
 * it somewhere else.
 */
export async function removeConnection(
  input: unknown,
): Promise<ActionResult<{ secretsErased: number }>> {
  try {
    const data = removeSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const secretsErased = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const erased = await eraseSecretsFor({
          tx,
          tenantId: ctx.tenant.id,
          ownerKind: CONNECTION_OWNER_KIND,
          ownerId: data.connectionId,
          reason: data.reason,
        });

        await tx
          .update(connections)
          .set({
            isActive: false,
            state: "revoked",
            stateReason: `Removed: ${data.reason}`,
            updatedAt: new Date(),
            updatedBy: ctx.user.id,
          })
          .where(
            and(
              eq(connections.tenantId, ctx.tenant.id),
              eq(connections.id, data.connectionId),
            ),
          );

        await writeAudit(ctx, {
          action: "delete",
          resourceType: "connection",
          resourceId: data.connectionId,
          newValue: { reason: data.reason, secretsErased: erased },
          severity: "critical",
        });

        return erased;
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/connections");
    return { ok: true, data: { secretsErased } };
  } catch (err) {
    return toSalesActionError(err, "removeConnection");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export interface ConnectionCard {
  readonly id: string;
  readonly connectorKey: string;
  readonly label: string;
  readonly name: string;
  readonly state: ConnectionState;
  readonly stateReason: string | null;
  readonly isActive: boolean;
  readonly transport: ConnectorPolicy["transport"];
  readonly selfService: boolean;
  readonly setupNote: string;
  readonly intervalSeconds: number;
  readonly lastSuccessAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lockedUntil: string | null;
  readonly consecutiveFailures: number;
  /** ⚠️ Names only. Never values, never fingerprints of values. */
  readonly missingSecrets: readonly string[];
  readonly storedSecrets: readonly string[];
  readonly webhookPath: string | null;
  /** ⭐ The whole address, which is the only form a person can use. */
  readonly webhookUrl: string | null;
  /** ⚠️ Which fields the setup screen must offer. From the policy table. */
  readonly secretNames: readonly string[];
  readonly verifyMethod: string;
  readonly nextFetchNote: string;
  readonly health: { tone: string; headline: string; detail: string };
  readonly recentRuns: ReadonlyArray<{
    outcome: SyncOutcome;
    startedAt: string;
    seen: number;
    fresh: number;
    duplicate: number;
    failed: number;
    error: string | null;
  }>;
}

export async function getConnections(): Promise<
  ActionResult<{
    readonly vaultReady: boolean;
    readonly vaultMessage: string | null;
    readonly cards: readonly ConnectionCard[];
    readonly available: ReadonlyArray<{
      key: string;
      label: string;
      transport: string;
      selfService: boolean;
      setupNote: string;
      secretNames: readonly string[];
      verifyMethod: string;
    }>;
  }>
> {
  try {
    const ctx = await requirePermission(MANAGE);
    const now = new Date();
    // ⚠️ Read here, not at module scope. A module-level read runs during
    // `next build`, when the value is legitimately the default.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

    const cards = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const rows = await tx
          .select()
          .from(connections)
          .where(eq(connections.tenantId, ctx.tenant.id))
          .orderBy(connections.connectorKey, connections.name);

        const out: ConnectionCard[] = [];

        for (const row of rows) {
          const policy = policyFor(row.connectorKey);

          /**
           * ⭐ WHICH SECRETS EXIST, FROM THE VAULT, BY NAME ONLY.
           *
           * 🔴 NOT `SELECT ciphertext`. Nothing on this path may load a
           * ciphertext, because a value that is never loaded is a value
           * that cannot be accidentally serialised into a page.
           */
          const stored = await tx.execute(sql`
            SELECT label
              FROM vault_secrets
             WHERE tenant_id  = ${ctx.tenant.id}::uuid
               AND owner_kind = ${CONNECTION_OWNER_KIND}
               AND owner_id   = ${row.id}::uuid
               AND status     = 'active'
          `);
          const storedNames = (
            (stored as unknown as { rows?: Array<{ label: string | null }> })
              .rows ?? (stored as unknown as Array<{ label: string | null }>)
          )
            .map((r) => r.label)
            .filter((l): l is string => Boolean(l));

          const endpoint = await tx
            .select({ pathToken: webhookEndpoints.pathToken })
            .from(webhookEndpoints)
            .where(
              and(
                eq(webhookEndpoints.tenantId, ctx.tenant.id),
                eq(webhookEndpoints.connectionId, row.id),
                eq(webhookEndpoints.isActive, true),
              ),
            )
            .limit(1);

          const runs = await tx
            .select({
              outcome: syncRuns.outcome,
              startedAt: syncRuns.startedAt,
              itemsSeen: syncRuns.itemsSeen,
              itemsNew: syncRuns.itemsNew,
              itemsDuplicate: syncRuns.itemsDuplicate,
              itemsFailed: syncRuns.itemsFailed,
              errorMessage: syncRuns.errorMessage,
            })
            .from(syncRuns)
            .where(
              and(
                eq(syncRuns.tenantId, ctx.tenant.id),
                eq(syncRuns.connectionId, row.id),
                // 🔴 PROBES ARE EXCLUDED, AND THIS IS THE POINT OF THE
                // FLAG. This list is read on the morning enquiries
                // stopped. Twenty Test clicks from setup day sitting at
                // the top of it push the actual failure off the screen.
                eq(syncRuns.isProbe, false),
              ),
            )
            .orderBy(desc(syncRuns.startedAt))
            .limit(20);

          const snapshot = {
            connectorKey: row.connectorKey,
            state: row.state as ConnectionState,
            isActive: row.isActive,
            pollEverySeconds: row.pollEverySeconds,
            lastAttemptAt: row.lastAttemptAt,
            lastSuccessAt: row.lastSuccessAt,
            cursorAt: row.cursorAt,
            lockedUntil: row.lockedUntil,
          };

          const health = assessSyncHealth(
            runs.map((r) => ({
              outcome: r.outcome as SyncOutcome,
              startedAt: r.startedAt,
              itemsSeen: r.itemsSeen,
              itemsNew: r.itemsNew,
              itemsDuplicate: r.itemsDuplicate,
              itemsFailed: r.itemsFailed,
            })),
            now,
          );

          out.push({
            id: row.id,
            connectorKey: row.connectorKey,
            label: policy?.label ?? row.connectorKey,
            name: row.name,
            state: row.state as ConnectionState,
            stateReason: row.stateReason,
            isActive: row.isActive,
            transport: policy?.transport ?? "pull",
            selfService: policy?.selfService ?? true,
            setupNote: policy?.setupNote ?? "",
            intervalSeconds: effectiveIntervalSeconds(snapshot),
            lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
            lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
            lockedUntil: row.lockedUntil?.toISOString() ?? null,
            consecutiveFailures: row.consecutiveFailures,
            storedSecrets: storedNames,
            missingSecrets: (policy?.secretNames ?? []).filter(
              (n) => !storedNames.includes(n),
            ),
            secretNames: policy?.secretNames ?? [],
            verifyMethod: policy?.verifyMethod ?? "inbound_only",
            webhookPath: endpoint[0]
              ? webhookPathFor(endpoint[0].pathToken)
              : null,
            webhookUrl: endpoint[0] ? webhookUrlFor(baseUrl, endpoint[0].pathToken) : null,
            nextFetchNote: mayFetchNow(snapshot, now).reason,
            health,
            recentRuns: runs.map((r) => ({
              outcome: r.outcome as SyncOutcome,
              startedAt: r.startedAt.toISOString(),
              seen: r.itemsSeen,
              fresh: r.itemsNew,
              duplicate: r.itemsDuplicate,
              failed: r.itemsFailed,
              error: r.errorMessage,
            })),
          });
        }

        return out;
      },
      { impersonationId: ctx.impersonationId },
    );

    const readiness = vaultReadiness();

    return {
      ok: true,
      data: {
        vaultReady: readiness.ready,
        vaultMessage: readiness.message,
        cards,
        available: Object.values(CONNECTOR_POLICIES).map((p) => ({
          key: p.key,
          label: p.label,
          transport: p.transport,
          selfService: p.selfService,
          setupNote: p.setupNote,
          secretNames: p.secretNames,
          verifyMethod: p.verifyMethod,
        })),
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getConnections");
  }
}

/* ------------------------------------------------------------------ */
/* THE VERIFY TOKEN                                                     */
/* ------------------------------------------------------------------ */

const verifyTokenSchema = z.object({ connectionId: z.string().uuid() });

/**
 * ⭐⭐⭐ THE ONE SECRET THAT MUST BE SHOWN, AND THE ONLY MOMENT IT IS.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A VERIFY TOKEN IS NOT A KEY. ITS PURPOSE IS TO BE TYPED SOMEWHERE
 * ELSE.
 * ══════════════════════════════════════════════════════════════════════
 * Meta confirms a webhook by GETting it with `hub.verify_token` and
 * expecting `hub.challenge` echoed back. For that to work the same
 * string has to exist in two places: our vault, and a form on Meta's
 * dashboard that a person fills in by hand.
 *
 * ⚠️ EVERY OTHER SECRET IN THIS SYSTEM IS WRITE-ONLY, AND THIS ONE
 * CANNOT BE. So the compromise is placed where it does least harm:
 *
 * 🔴 THE VALUE IS RETURNED EXACTLY ONCE, AT THE MOMENT IT IS MINTED,
 * AND CAN NEVER BE READ AGAIN. There is no "show token" button and
 * there will not be one. Somebody who loses it generates another, which
 * costs them one paste into Meta and costs us nothing. An action that
 * could re-read it would be an authenticated URL that hands out every
 * tenant's webhook tokens, and it would look entirely ordinary in a
 * review — which is the argument the header of this file already makes
 * about `saveCredential`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THIS IS WHY IT IS A BUTTON RATHER THAN A TERMINAL COMMAND
 * ══════════════════════════════════════════════════════════════════════
 * `openssl rand -hex 32` produces a perfectly good verify token. It
 * also requires a terminal, which the person setting up their own
 * WhatsApp account does not have and should not need. A platform whose
 * onboarding has a shell command in step four is a platform that
 * onboards nobody without a phone call.
 */
export async function generateVerifyToken(
  input: unknown,
): Promise<ActionResult<{ verifyToken: string; connectorLabel: string }>> {
  try {
    const data = verifyTokenSchema.parse(input);
    const ctx = await requirePermission(MANAGE);

    const readiness = vaultReadiness();
    if (!readiness.ready) {
      return { ok: false, error: readiness.message ?? "The vault is not configured." };
    }

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const [connection] = await tx
          .select({ id: connections.id, connectorKey: connections.connectorKey })
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, ctx.tenant.id),
              eq(connections.id, data.connectionId),
            ),
          )
          .limit(1);

        if (!connection) throw new Error("No such connection.");

        const policy = policyFor(connection.connectorKey);
        if (!policy || !policy.secretNames.includes("verify_token")) {
          throw new Error(
            `${policy?.label ?? "This connector"} does not use a verify token.`,
          );
        }

        // ⭐ THE SAME MINT AS THE WEBHOOK PATH. One source of randomness,
        // already audited, already the right length.
        const verifyToken = generatePathToken();

        const put = await putSecret({
          tx,
          tenantId: ctx.tenant.id,
          ownerKind: CONNECTION_OWNER_KIND,
          ownerId: connection.id,
          kind: "api_credential",
          label: "verify_token",
          plaintext: verifyToken,
          userId: ctx.user.id,
          userEmail: ctx.user.email ?? null,
          expiresAt: null,
        });

        if (!put.ok) throw new Error(put.error);

        await writeAudit(ctx, {
          action: "update",
          resourceType: "connection_credential",
          resourceId: connection.id,
          // 🔴 THAT ONE WAS MINTED. NEVER WHICH ONE.
          newValue: { secretName: "verify_token", minted: true, rotated: put.rotated },
          severity: "critical",
        });

        return { verifyToken, connectorLabel: policy.label };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/connections");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "generateVerifyToken");
  }
}

/* ------------------------------------------------------------------ */
/* THE PROBE                                                            */
/* ------------------------------------------------------------------ */

const probeSchema = z.object({ connectionId: z.string().uuid() });

/**
 * ⭐⭐ "DOES THIS ACTUALLY WORK", ASKED AT THE MOMENT SOMEBODY CARES.
 *
 * ⚠️ THE ALTERNATIVE IS FINDING OUT ON THURSDAY. A wrong key and a quiet
 * week look identical on the connections screen, and the difference is
 * three days of enquiries that went to a competitor.
 *
 * 🔴 A PROBE IS NOT A SYNC. It is recorded as its own kind of run
 * (`is_probe` in 0069) so that a hundred setup attempts do not drown the
 * log a person reads on the bad morning, and so that a probe can never
 * move the cursor and skip real enquiries.
 */
export async function probeConnection(
  input: unknown,
): Promise<ActionResult<{ ok: boolean; headline: string; detail: string }>> {
  try {
    const data = probeSchema.parse(input);
    const ctx = await requirePermission(MANAGE);
    const now = new Date();

    const report = await withTenant(
      ctx.tenant.id,
      async (tx) =>
        runProbe({
          tx,
          tenantId: ctx.tenant.id,
          connectionId: data.connectionId,
          now,
        }),
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/settings/connections");
    return { ok: true, data: report };
  } catch (err) {
    return toSalesActionError(err, "probeConnection");
  }
}
