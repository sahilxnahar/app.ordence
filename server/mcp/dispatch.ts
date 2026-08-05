import "server-only";

/**
 * Ordence — ⭐ MCP DISPATCH
 * Version: v0.74.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE ORDER OF OPERATIONS IS THE SECURITY CONTROL — AGAIN
 * ══════════════════════════════════════════════════════════════════════
 * `middleware.ts` says it about HTTP requests. It is equally true here:
 *
 *   1. Hash the bearer token — never compare a plaintext secret
 *   2. Resolve it, which applies revocation and expiry IN THE DATABASE
 *   3. Check the tool exists in the registry — unknown tools fail closed
 *   4. Check the token's SCOPE permits that tool
 *   5. Execute inside `withTenant()`, under row-level security
 *   6. Log the call — including if it was refused at steps 3, 4 or 5
 *
 * ⚠️ STEP 6 RUNS FOR REFUSALS TOO. A log of only successful calls answers
 * "what did it do" and cannot answer "what did it try to do". An
 * assistant repeatedly attempting writes on a read-only token is the
 * clearest signal of a prompt injection there is, and it is invisible if
 * refusals go unrecorded.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ══════════════════════════════════════════════════════════════════════
 * It does not construct a `TenantContext`, and it does not call
 * `requireTenantContext()`. There is no Clerk session on an MCP request —
 * inventing a context would mean fabricating the very thing the security
 * model depends on being real.
 *
 * Instead every handler runs inside `withTenant(tenantId, …)`, so
 * PostgreSQL row-level security is the enforcing layer. That is the
 * SECOND of the two gates, and on this path it is the only one — which
 * is exactly why the tool registry is small, why writes are separately
 * scoped, and why nothing here can approve, certify, delete or reach the
 * sensitive vault.
 */

import { createHash } from "node:crypto";
import { and, eq, desc, asc, sql, isNull } from "drizzle-orm";
import { withTenant } from "@/db";
import {
  mcpTokens,
  mcpCallLog,
  tenants,
  users,
  boqs,
  boqItems,
  boqVariations,
  boqVariationItems,
  raBills,
  siteWorkers,
  pieceRateEntries,
  dailySiteLogs,
  projects,
} from "@/db/schema";
import { MCP_TOOLS, findTool, scopePermits, type McpScope } from "@/lib/mcp/registry";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { createVariation } from "@/server/actions/variations";
import { upsertDailySiteLog } from "@/server/actions/labour";

/* ------------------------------------------------------------------ */
/* TOKEN RESOLUTION                                                    */
/* ------------------------------------------------------------------ */

export type McpSession = {
  tokenId: string;
  tenantId: string;
  scope: McpScope;
  actingUserId: string;
};

/**
 * ⚠️ SHA-256, HEX, LOWERCASE — the exact format `mcp_tokens_hash_is_sha256`
 * enforces. A mismatch here would silently fail every lookup and look
 * like "the token is wrong".
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Resolve a bearer token to a session, or null.
 *
 * ⚠️ CALLS `mcp_resolve_token`, THE ONE SECURITY DEFINER FUNCTION.
 *
 * RLS on `mcp_tokens` keys off `app.current_tenant_id`, and we do not
 * know the tenant until the row is read. The alternatives were putting
 * the tenant id in the token (letting the client assert its own tenant —
 * the exact header-spoofing attack the middleware strips six headers to
 * prevent) or exempting the table from RLS entirely. The function
 * returns no secret and applies revocation and expiry itself.
 *
 * `withTenant` needs a tenant id, and we have none yet, so this uses the
 * all-zero UUID: a syntactically valid id that matches no tenant, so if
 * anything in this path ever touched a tenant table it would return
 * nothing rather than another tenant's rows.
 */
const NO_TENANT = "00000000-0000-0000-0000-000000000000";

export async function resolveSession(bearer: string): Promise<McpSession | null> {
  const trimmed = bearer.trim();
  if (trimmed.length < 32) return null;

  const digest = hashToken(trimmed);

  const rows = await withTenant(NO_TENANT, async (tx) => {
    const result = await tx.execute(
      sql`SELECT token_id, tenant_id, scope, acting_user_id
            FROM public.mcp_resolve_token(${digest})`,
    );
    return (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [];
  });

  const row = (rows as Record<string, unknown>[])[0];
  if (!row) return null;

  return {
    tokenId: String(row.token_id),
    tenantId: String(row.tenant_id),
    scope: String(row.scope) as McpScope,
    actingUserId: String(row.acting_user_id),
  };
}

/* ------------------------------------------------------------------ */
/* LOGGING                                                             */
/* ------------------------------------------------------------------ */

async function logCall(
  session: McpSession,
  toolName: string,
  outcome: "ok" | "refused" | "error",
  durationMs: number,
  argumentKeys: string[],
  refusalReason?: string,
): Promise<void> {
  /**
   * ⚠️ LOGGING NEVER THROWS INTO THE CALLER.
   *
   * A failed log must not turn a successful read into an error the
   * assistant reports back as "Ordence is down". The log is important;
   * it is not more important than the request.
   */
  try {
    await withTenant(session.tenantId, async (tx) => {
      await tx.insert(mcpCallLog).values({
        tenantId: session.tenantId,
        tokenId: session.tokenId,
        toolName,
        outcome,
        durationMs,
        // ⚠️ KEYS ONLY. Values can be a customer's name or a contract sum.
        argumentKeys,
        refusalReason: refusalReason ?? null,
      });

      if (outcome === "ok") {
        await tx
          .update(mcpTokens)
          .set({
            lastUsedAt: new Date(),
            callCount: sql`${mcpTokens.callCount} + 1`,
          })
          .where(
            and(
              eq(mcpTokens.tenantId, session.tenantId),
              eq(mcpTokens.id, session.tokenId),
            ),
          );
      }
    });
  } catch {
    /* deliberately swallowed — see above */
  }
}

/* ------------------------------------------------------------------ */
/* MONEY FORMATTING                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY FIGURE LEAVES AS A STRING.
 *
 * `JSON.stringify` throws on a bigint. An MCP response containing a raw
 * bigint does not return a wrong number — it fails the whole response,
 * and the assistant reports an outage.
 */
function money(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "0.00";
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function micro(value: bigint | null | undefined, decimals = 3): string {
  if (value === null || value === undefined) return "0";
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1_000_000n;
  const frac = (magnitude % 1_000_000n).toString().padStart(6, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/* ------------------------------------------------------------------ */
/* THE HANDLERS                                                        */
/* ------------------------------------------------------------------ */

type Args = Record<string, unknown>;

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" is required and must be text.`);
  }
  return value.trim();
}

async function runTool(
  session: McpSession,
  toolName: string,
  args: Args,
): Promise<unknown> {
  switch (toolName) {
    /* ---------------- whoami ---------------- */
    case "ordence_whoami": {
      return withTenant(session.tenantId, async (tx) => {
        const [tenant] = await tx
          .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
          .from(tenants)
          .where(eq(tenants.id, session.tenantId))
          .limit(1);

        const [user] = await tx
          // ⚠️ `users` has firstName/lastName, NOT `name`. Same class of
          // mistake as `vendors.name`. Read the schema.
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(users)
          .where(
            and(eq(users.tenantId, session.tenantId), eq(users.id, session.actingUserId)),
          )
          .limit(1);

        return {
          workspace: tenant?.name ?? "unknown",
          workspaceSlug: tenant?.slug ?? null,
          actingAs:
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
            user?.email ||
            "unknown",
          scope: session.scope,
          note:
            session.scope === "read_only"
              ? "This token is READ ONLY. Write tools will be refused."
              : "This token can create drafts and record site logs. It cannot " +
                "approve, certify, verify or delete anything.",
        };
      });
    }

    /* ---------------- BOQs ---------------- */
    case "ordence_list_boqs": {
      return withTenant(session.tenantId, async (tx) =>
        tx
          .select({
            id: boqs.id,
            code: boqs.code,
            title: boqs.title,
            workPackage: boqs.workPackage,
            status: boqs.status,
            projectId: boqs.projectId,
          })
          .from(boqs)
          .where(eq(boqs.tenantId, session.tenantId))
          .orderBy(asc(boqs.code)),
      );
    }

    case "ordence_get_boq": {
      const boqId = requireString(args, "boqId");
      return withTenant(session.tenantId, async (tx) => {
        const [head] = await tx
          .select({
            id: boqs.id,
            code: boqs.code,
            title: boqs.title,
            status: boqs.status,
            workPackage: boqs.workPackage,
          })
          .from(boqs)
          .where(and(eq(boqs.tenantId, session.tenantId), eq(boqs.id, boqId)))
          .limit(1);

        if (!head) return { error: "No BOQ with that id in this workspace." };

        const items = await tx
          .select({
            itemCode: boqItems.itemCode,
            description: boqItems.description,
            uom: boqItems.uom,
            quantityScaled: boqItems.quantityScaled,
            rateMinor: boqItems.rateMinor,
            amountMinor: boqItems.amountMinor,
          })
          .from(boqItems)
          .where(
            and(eq(boqItems.tenantId, session.tenantId), eq(boqItems.boqId, boqId)),
          )
          .orderBy(asc(boqItems.sequence));

        return {
          ...head,
          items: items.map((i) => ({
            itemCode: i.itemCode,
            description: i.description,
            uom: i.uom,
            quantity: micro(i.quantityScaled),
            rate: money(i.rateMinor),
            amount: money(i.amountMinor),
          })),
        };
      });
    }

    /* ---------------- variations ---------------- */
    case "ordence_list_variations": {
      return withTenant(session.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: boqVariations.id,
            number: boqVariations.variationNumber,
            kind: boqVariations.kind,
            status: boqVariations.status,
            title: boqVariations.title,
            effectMinor: boqVariations.effectMinor,
            instructedOn: boqVariations.instructedOn,
          })
          .from(boqVariations)
          .where(eq(boqVariations.tenantId, session.tenantId))
          .orderBy(desc(boqVariations.createdAt));

        return rows.map((r) => ({
          ...r,
          effect: money(r.effectMinor),
          effectMinor: undefined,
          countsTowardsContractSum: r.status === "approved",
        }));
      });
    }

    case "ordence_get_variation": {
      const variationId = requireString(args, "variationId");
      return withTenant(session.tenantId, async (tx) => {
        const [head] = await tx
          .select({
            id: boqVariations.id,
            number: boqVariations.variationNumber,
            kind: boqVariations.kind,
            status: boqVariations.status,
            title: boqVariations.title,
            reason: boqVariations.reason,
            effectMinor: boqVariations.effectMinor,
            rejectionReason: boqVariations.rejectionReason,
          })
          .from(boqVariations)
          .where(
            and(
              eq(boqVariations.tenantId, session.tenantId),
              eq(boqVariations.id, variationId),
            ),
          )
          .limit(1);

        if (!head) return { error: "No variation with that id in this workspace." };

        const lines = await tx
          .select({
            sequence: boqVariationItems.sequence,
            description: boqVariationItems.description,
            uom: boqVariationItems.uom,
            quantityDeltaScaled: boqVariationItems.quantityDeltaScaled,
            rateMinor: boqVariationItems.rateMinor,
            amountDeltaMinor: boqVariationItems.amountDeltaMinor,
            replacesRate: boqVariationItems.replacesRate,
          })
          .from(boqVariationItems)
          .where(
            and(
              eq(boqVariationItems.tenantId, session.tenantId),
              eq(boqVariationItems.variationId, variationId),
            ),
          )
          .orderBy(asc(boqVariationItems.sequence));

        let additions = 0n;
        let omissions = 0n;
        for (const l of lines) {
          if (l.amountDeltaMinor >= 0n) additions += l.amountDeltaMinor;
          else omissions += l.amountDeltaMinor;
        }

        return {
          id: head.id,
          number: head.number,
          kind: head.kind,
          status: head.status,
          title: head.title,
          reason: head.reason,
          rejectionReason: head.rejectionReason,
          netEffect: money(head.effectMinor),
          additions: money(additions),
          omissions: money(omissions),
          countsTowardsContractSum: head.status === "approved",
          lines: lines.map((l) => ({
            sequence: l.sequence,
            description: l.description,
            uom: l.uom,
            quantityDelta: micro(l.quantityDeltaScaled),
            rate: money(l.rateMinor),
            amountDelta: money(l.amountDeltaMinor),
            replacesRate: l.replacesRate,
          })),
        };
      });
    }

    /* ---------------- RA bills ---------------- */
    case "ordence_list_ra_bills": {
      return withTenant(session.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: raBills.id,
            billNo: raBills.billNo,
            sequence: raBills.sequence,
            status: raBills.status,
            grossValueMinor: raBills.grossValueMinor,
            retentionAmountMinor: raBills.retentionAmountMinor,
            tdsAmountMinor: raBills.tdsAmountMinor,
            cessAmountMinor: raBills.cessAmountMinor,
            previousPaidMinor: raBills.previousPaidMinor,
            netPayableMinor: raBills.netPayableMinor,
          })
          .from(raBills)
          .where(eq(raBills.tenantId, session.tenantId))
          .orderBy(desc(raBills.sequence));

        return rows.map((r) => ({
          id: r.id,
          billNo: r.billNo,
          sequence: r.sequence,
          status: r.status,
          gross: money(r.grossValueMinor),
          retention: money(r.retentionAmountMinor),
          cess: money(r.cessAmountMinor),
          tds: money(r.tdsAmountMinor),
          // ⚠️ CONTEXT, NOT A DEDUCTION. The database does not
          // subtract previous_paid from the net payable, and a
          // response that implied otherwise would not foot
          // against the bill a subcontractor is holding.
          previouslyPaidForContext: money(r.previousPaidMinor),
          netPayable: money(r.netPayableMinor),
        }));
      });
    }

    /* ---------------- site labour ---------------- */
    case "ordence_site_labour": {
      return withTenant(session.tenantId, async (tx) => {
        const workers = await tx
          .select({
            id: siteWorkers.id,
            name: siteWorkers.workerName,
            trade: siteWorkers.trade,
            uanStatus: siteWorkers.uanStatus,
            isAdmissible: siteWorkers.isAdmissible,
            blockedReason: siteWorkers.blockedReason,
            exitedOn: siteWorkers.exitedOn,
          })
          .from(siteWorkers)
          .where(eq(siteWorkers.tenantId, session.tenantId))
          .orderBy(asc(siteWorkers.workerName));

        const unbilled = await tx
          .select({ amountMinor: pieceRateEntries.amountMinor })
          .from(pieceRateEntries)
          .where(
            and(
              eq(pieceRateEntries.tenantId, session.tenantId),
              isNull(pieceRateEntries.raBillId),
            ),
          );

        let unbilledTotal = 0n;
        for (const u of unbilled) unbilledTotal += u.amountMinor;

        const blocked = workers.filter((w) => !w.isAdmissible && !w.exitedOn);

        return {
          onRegister: workers.length,
          admissible: workers.filter((w) => w.isAdmissible).length,
          cannotWork: blocked.length,
          cannotWorkDetail: blocked.map((w) => ({
            name: w.name,
            reason: w.blockedReason ?? "UAN not verified",
          })),
          unbilledPieceWork: money(unbilledTotal),
          note:
            blocked.length > 0
              ? `${blocked.length} worker(s) cannot be recorded as attending until ` +
                `their UAN is verified by a person with the right permission. ` +
                `That verification is not available through this interface.`
              : "Everybody on the register is admissible to site.",
        };
      });
    }

    /* ---------------- modules ---------------- */
    case "ordence_module_status": {
      return Object.entries(MODULE_REGISTRY).map(([navId, m]) => ({
        navId,
        label: m.label,
        group: m.group,
        status: m.status,
        href: m.href,
        description: m.description,
      }));
    }

    /* ---------------- WRITES ---------------- */
    case "ordence_raise_variation": {
      /**
       * ⚠️ CALLS THE SAME SERVER ACTION THE UI CALLS.
       *
       * Not a parallel implementation. A second write path is a second
       * place for the rules to be slightly different, and the difference
       * is always discovered by a customer.
       *
       * ⚠️ `createVariation` internally calls `requireTenantContext()`,
       * which needs a Clerk session. On an MCP request there is none —
       * so this returns the refusal that produces, rather than pretending
       * to have a session. See the note at the head of this file and
       * `docs/MCP.md` for the resolution path.
       */
      const result = await createVariation({
        boqId: requireString(args, "boqId"),
        kind: requireString(args, "kind"),
        title: requireString(args, "title"),
        reason: requireString(args, "reason"),
        instructionRef:
          typeof args.instructionRef === "string" ? args.instructionRef : null,
      });
      return result;
    }

    case "ordence_record_daily_site_log": {
      const result = await upsertDailySiteLog({
        projectId: requireString(args, "projectId"),
        logDate: requireString(args, "logDate"),
        labourCount: Number(args.labourCount ?? 0),
        weather: typeof args.weather === "string" ? args.weather : null,
        rainfallMm: typeof args.rainfallMm === "string" ? args.rainfallMm : null,
        hoursLost: typeof args.hoursLost === "string" ? args.hoursLost : null,
        workDone: typeof args.workDone === "string" ? args.workDone : null,
        issues: typeof args.issues === "string" ? args.issues : null,
      });
      return result;
    }

    default:
      throw new Error(`No such tool: ${toolName}`);
  }
}

/* ------------------------------------------------------------------ */
/* THE ENTRY POINT                                                     */
/* ------------------------------------------------------------------ */

export type DispatchResult =
  | { ok: true; data: unknown }
  | { ok: false; refused: true; reason: string }
  | { ok: false; refused: false; reason: string };

export async function dispatchTool(
  session: McpSession,
  toolName: string,
  args: Args,
): Promise<DispatchResult> {
  const started = Date.now();
  const argumentKeys = Object.keys(args ?? {});

  /* --- 3. does the tool exist? Unknown fails CLOSED. --- */
  const tool = findTool(toolName);
  if (!tool) {
    const reason =
      `No tool called "${toolName}". Call tools/list to see what this ` +
      `workspace offers.`;
    await logCall(session, toolName, "refused", Date.now() - started, argumentKeys, reason);
    return { ok: false, refused: true, reason };
  }

  /* --- 4. does the SCOPE permit it? --- */
  if (!scopePermits(session.scope, toolName)) {
    const reason =
      `"${toolName}" needs a read_write token and this one is read_only. ` +
      `A person has to grant that deliberately in the Ordence admin console.`;
    await logCall(session, toolName, "refused", Date.now() - started, argumentKeys, reason);
    return { ok: false, refused: true, reason };
  }

  /* --- 5. execute --- */
  try {
    const data = await runTool(session, toolName, args ?? {});
    await logCall(session, toolName, "ok", Date.now() - started, argumentKeys);
    return { ok: true, data };
  } catch (err) {
    /**
     * ⚠️ THE MESSAGE IS PASSED THROUGH, NOT REPLACED.
     *
     * Ordence's refusals are written for a person — "the raiser cannot
     * approve their own variation", "this worker is not admissible".
     * Collapsing them into "an error occurred" throws away the only part
     * that tells the assistant what to do differently, and guarantees it
     * retries the same call.
     */
    const reason = err instanceof Error ? err.message : "The tool failed.";
    await logCall(session, toolName, "error", Date.now() - started, argumentKeys, reason);
    return { ok: false, refused: false, reason };
  }
}

export { MCP_TOOLS };
