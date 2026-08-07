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
import { and, eq, desc, asc, sql, isNull, inArray } from "drizzle-orm";
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
  // GST
  gstRegistrations,
  gstParties,
  // Purchases & ITC
  vendors,
  purchaseInvoices,
  itcRegister,
  // Receivables
  demandNotices,
  receipts,
  // Compliance
  complianceTasks,
  complianceObligations,
  complianceLicences,
  // Inventory
  stockItems,
  stockBalances,
  // Scheduling
  scheduleResources,
  scheduleBookings,
  // Field operations
  fieldJobs,
  // TDS
  tdsDeductions,
  tdsDeductees,
} from "@/db/schema";
import { MCP_TOOLS, findTool, scopePermits, type McpScope } from "@/lib/mcp/registry";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { createVariation } from "@/server/actions/variations";
import { upsertDailySiteLog } from "@/server/actions/labour";

/* ------------------------------------------------------------------ */
/* TOKEN RESOLUTION                                                    */
/* ------------------------------------------------------------------ */

export type McpSession = {
  /**
   * The MCP token id, or null for UI-originated calls (the assistant chat).
   *
   * ⚠️ When null, the call log records the tool name and outcome but
   * cannot update a token's last-used timestamp (there is no token).
   * The audit trail is still complete — every tool call is logged
   * with the acting user's id and the tenant id.
   */
  tokenId: string | null;
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

      if (outcome === "ok" && session.tokenId) {
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

    /* ---------------- GST registrations ---------------- */
    case "ordence_list_gst_registrations": {
      return withTenant(session.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: gstRegistrations.id,
            gstin: gstRegistrations.gstin,
            stateCode: gstRegistrations.stateCode,
            legalName: gstRegistrations.legalName,
            tradeName: gstRegistrations.tradeName,
            registrationType: gstRegistrations.registrationType,
            isPrimary: gstRegistrations.isPrimary,
            isActive: gstRegistrations.isActive,
            effectiveFrom: gstRegistrations.effectiveFrom,
            effectiveTo: gstRegistrations.effectiveTo,
          })
          .from(gstRegistrations)
          .where(eq(gstRegistrations.tenantId, session.tenantId))
          .orderBy(asc(gstRegistrations.stateCode));

        return rows.map((r) => ({
          ...r,
          isPrimary: r.isPrimary,
          status: r.isActive ? "active" : "surrendered",
        }));
      });
    }

    /* ---------------- GST parties ---------------- */
    case "ordence_list_gst_parties": {
      const partyType =
        typeof args.partyType === "string" ? args.partyType : null;
      return withTenant(session.tenantId, async (tx) => {
        let query = tx
          .select({
            id: gstParties.id,
            partyType: gstParties.partyType,
            legalName: gstParties.legalName,
            tradeName: gstParties.tradeName,
            gstin: gstParties.gstin,
            panNumber: gstParties.panNumber,
            registrationType: gstParties.registrationType,
            stateCode: gstParties.stateCode,
          })
          .from(gstParties)
          .where(eq(gstParties.tenantId, session.tenantId))
          .orderBy(asc(gstParties.legalName))
          .limit(200);

        if (partyType === "customer" || partyType === "vendor") {
          query = tx
            .select({
              id: gstParties.id,
              partyType: gstParties.partyType,
              legalName: gstParties.legalName,
              tradeName: gstParties.tradeName,
              gstin: gstParties.gstin,
              panNumber: gstParties.panNumber,
              registrationType: gstParties.registrationType,
              stateCode: gstParties.stateCode,
            })
            .from(gstParties)
            .where(
              and(
                eq(gstParties.tenantId, session.tenantId),
                eq(gstParties.partyType, partyType),
              ),
            )
            .orderBy(asc(gstParties.legalName))
            .limit(200);
        }

        return await query;
      });
    }

    /* ---------------- purchase invoices ---------------- */
    case "ordence_list_purchase_invoices": {
      const status =
        typeof args.status === "string" ? args.status : null;
      return withTenant(session.tenantId, async (tx) => {
        const conditions = [eq(purchaseInvoices.tenantId, session.tenantId)];
        if (status) {
          // Use a cast rather than importing the enum — the dispatch
          // layer validates by passing through; the DB CHECK enforces the
          // value.
          conditions.push(sql`${purchaseInvoices.status} = ${status}::purchase_invoice_status`);
        }

        const rows = await tx
          .select({
            id: purchaseInvoices.id,
            invoiceNumber: purchaseInvoices.invoiceNumber,
            invoiceDate: purchaseInvoices.invoiceDate,
            supplierGstin: purchaseInvoices.supplierGstin,
            taxableValueMinor: purchaseInvoices.taxableValueMinor,
            igstMinor: purchaseInvoices.igstMinor,
            cgstMinor: purchaseInvoices.cgstMinor,
            sgstMinor: purchaseInvoices.sgstMinor,
            cessMinor: purchaseInvoices.cessMinor,
            totalMinor: purchaseInvoices.totalMinor,
            itcEligibleTaxMinor: purchaseInvoices.itcEligibleTaxMinor,
            itcBlockedTaxMinor: purchaseInvoices.itcBlockedTaxMinor,
            taxPeriod: purchaseInvoices.taxPeriod,
            status: purchaseInvoices.status,
            isReverseCharge: purchaseInvoices.isReverseCharge,
            vendorId: purchaseInvoices.vendorId,
          })
          .from(purchaseInvoices)
          .where(and(...conditions))
          .orderBy(desc(purchaseInvoices.invoiceDate))
          .limit(100);

        // Join vendor names for context
        const vendorIds = [...new Set(rows.map((r) => r.vendorId))];
        const vendorRows = vendorIds.length
          ? await tx
              .select({ id: vendors.id, legalName: vendors.legalName })
              .from(vendors)
              .where(
                and(
                  eq(vendors.tenantId, session.tenantId),
                  inArray(vendors.id, vendorIds),
                ),
              )
          : [];
        const vendorMap = new Map(vendorRows.map((v) => [v.id, v.legalName]));

        return rows.map((r) => ({
          id: r.id,
          invoiceNumber: r.invoiceNumber,
          invoiceDate: r.invoiceDate,
          supplierGstin: r.supplierGstin,
          vendorName: vendorMap.get(r.vendorId) ?? null,
          taxableValue: money(r.taxableValueMinor),
          igst: money(r.igstMinor),
          cgst: money(r.cgstMinor),
          sgst: money(r.sgstMinor),
          cess: money(r.cessMinor),
          total: money(r.totalMinor),
          itcEligible: money(r.itcEligibleTaxMinor),
          itcBlocked: money(r.itcBlockedTaxMinor),
          taxPeriod: r.taxPeriod,
          status: r.status,
          isReverseCharge: r.isReverseCharge,
        }));
      });
    }

    /* ---------------- ITC register ---------------- */
    case "ordence_itc_register": {
      const status =
        typeof args.status === "string" ? args.status : null;
      return withTenant(session.tenantId, async (tx) => {
        const conditions = [eq(itcRegister.tenantId, session.tenantId)];
        if (status) {
          conditions.push(sql`${itcRegister.status} = ${status}::itc_register_status`);
        }

        const rows = await tx
          .select({
            id: itcRegister.id,
            taxPeriod: itcRegister.taxPeriod,
            status: itcRegister.status,
            reason: itcRegister.reason,
            statutoryRef: itcRegister.statutoryRef,
            note: itcRegister.note,
            cgstMinor: itcRegister.cgstMinor,
            sgstMinor: itcRegister.sgstMinor,
            igstMinor: itcRegister.igstMinor,
            cessMinor: itcRegister.cessMinor,
            purchaseInvoiceId: itcRegister.purchaseInvoiceId,
            vendorId: itcRegister.vendorId,
            filedAt: itcRegister.filedAt,
          })
          .from(itcRegister)
          .where(and(...conditions))
          .orderBy(desc(itcRegister.taxPeriod), desc(itcRegister.createdAt))
          .limit(100);

        return rows.map((r) => {
          const total =
            (r.cgstMinor ?? 0n) +
            (r.sgstMinor ?? 0n) +
            (r.igstMinor ?? 0n) +
            (r.cessMinor ?? 0n);
          return {
            id: r.id,
            taxPeriod: r.taxPeriod,
            status: r.status,
            reason: r.reason,
            statutoryRef: r.statutoryRef,
            note: r.note,
            cgst: money(r.cgstMinor),
            sgst: money(r.sgstMinor),
            igst: money(r.igstMinor),
            cess: money(r.cessMinor),
            total: money(total),
            filedAt: r.filedAt,
          };
        });
      });
    }

    /* ---------------- demand notices ---------------- */
    case "ordence_list_demand_notices": {
      const status =
        typeof args.status === "string" ? args.status : null;
      return withTenant(session.tenantId, async (tx) => {
        const conditions = [eq(demandNotices.tenantId, session.tenantId)];
        if (status) {
          conditions.push(sql`${demandNotices.status} = ${status}::demand_status`);
        }

        const rows = await tx
          .select({
            id: demandNotices.id,
            noticeNumber: demandNotices.noticeNumber,
            triggerLabel: demandNotices.triggerLabel,
            noticeDate: demandNotices.noticeDate,
            dueDate: demandNotices.dueDate,
            principalMinor: demandNotices.principalMinor,
            taxMinor: demandNotices.taxMinor,
            totalMinor: demandNotices.totalMinor,
            allocatedMinor: demandNotices.allocatedMinor,
            status: demandNotices.status,
            dunningStage: demandNotices.dunningStage,
            projectId: demandNotices.projectId,
          })
          .from(demandNotices)
          .where(and(...conditions))
          .orderBy(desc(demandNotices.noticeDate))
          .limit(100);

        return rows.map((r) => ({
          id: r.id,
          noticeNumber: r.noticeNumber,
          triggerLabel: r.triggerLabel,
          noticeDate: r.noticeDate,
          dueDate: r.dueDate,
          principal: money(r.principalMinor),
          tax: money(r.taxMinor),
          total: money(r.totalMinor),
          allocated: money(r.allocatedMinor),
          outstanding: money(
            (r.totalMinor ?? 0n) - (r.allocatedMinor ?? 0n),
          ),
          status: r.status,
          dunningStage: r.dunningStage,
        }));
      });
    }

    /* ---------------- receipts ---------------- */
    case "ordence_list_receipts": {
      return withTenant(session.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: receipts.id,
            receiptNumber: receipts.receiptNumber,
            receivedOn: receipts.receivedOn,
            amountMinor: receipts.amountMinor,
            tdsCreditMinor: receipts.tdsCreditMinor,
            allocatedMinor: receipts.allocatedMinor,
            method: receipts.method,
            status: receipts.status,
            instrumentRef: receipts.instrumentRef,
            clearedOn: receipts.clearedOn,
            bouncedOn: receipts.bouncedOn,
          })
          .from(receipts)
          .where(eq(receipts.tenantId, session.tenantId))
          .orderBy(desc(receipts.receivedOn))
          .limit(100);

        return rows.map((r) => ({
          id: r.id,
          receiptNumber: r.receiptNumber,
          receivedOn: r.receivedOn,
          amount: money(r.amountMinor),
          tdsCredit: money(r.tdsCreditMinor),
          allocated: money(r.allocatedMinor),
          method: r.method,
          status: r.status,
          instrumentRef: r.instrumentRef,
          clearedOn: r.clearedOn,
          bouncedOn: r.bouncedOn,
        }));
      });
    }

    /* ---------------- compliance calendar ---------------- */
    case "ordence_compliance_calendar": {
      const statusFilter =
        typeof args.status === "string" ? args.status : null;
      return withTenant(session.tenantId, async (tx) => {
        // When no status is specified, show non-terminal tasks only.
        // These are hardcoded constants, not user input — no injection risk.
        const terminalFilter = sql`${complianceTasks.status} NOT IN ('filed','not_applicable','waived')`;

        let rows;
        if (statusFilter) {
          rows = await tx
            .select({
              id: complianceTasks.id,
              periodLabel: complianceTasks.periodLabel,
              dueDate: complianceTasks.dueDate,
              status: complianceTasks.status,
              severity: complianceTasks.severity,
              filingReference: complianceTasks.filingReference,
              daysLate: complianceTasks.daysLate,
              lateFeeMinor: complianceTasks.lateFeeMinor,
              obligationId: complianceTasks.obligationId,
              subjectCompanyId: complianceTasks.subjectCompanyId,
            })
            .from(complianceTasks)
            .where(
              and(
                eq(complianceTasks.tenantId, session.tenantId),
                sql`${complianceTasks.status} = ${statusFilter}::compliance_task_status`,
              ),
            )
            .orderBy(asc(complianceTasks.dueDate))
            .limit(200);
        } else {
          rows = await tx
            .select({
              id: complianceTasks.id,
              periodLabel: complianceTasks.periodLabel,
              dueDate: complianceTasks.dueDate,
              status: complianceTasks.status,
              severity: complianceTasks.severity,
              filingReference: complianceTasks.filingReference,
              daysLate: complianceTasks.daysLate,
              lateFeeMinor: complianceTasks.lateFeeMinor,
              obligationId: complianceTasks.obligationId,
              subjectCompanyId: complianceTasks.subjectCompanyId,
            })
            .from(complianceTasks)
            .where(
              and(
                eq(complianceTasks.tenantId, session.tenantId),
                terminalFilter,
              ),
            )
            .orderBy(asc(complianceTasks.dueDate))
            .limit(200);
        }

        // Join obligation names
        const obligationIds = [
          ...new Set(rows.map((r) => r.obligationId).filter(Boolean)),
        ] as string[];
        const obligationRows = obligationIds.length
          ? await tx
              .select({
                id: complianceObligations.id,
                name: complianceObligations.name,
                authority: complianceObligations.authority,
                code: complianceObligations.code,
              })
              .from(complianceObligations)
              .where(
                and(
                  eq(complianceObligations.tenantId, session.tenantId),
                  inArray(complianceObligations.id, obligationIds),
                ),
              )
          : [];
        const obligationMap = new Map(
          obligationRows.map((o) => [o.id, o]),
        );

        const today = new Date().toISOString().slice(0, 10);

        return rows.map((r) => {
          const obligation = obligationMap.get(r.obligationId);
          const isOverdue =
            (r.status === "pending" || r.status === "in_progress") &&
            r.dueDate < today;
          return {
            id: r.id,
            obligationName: obligation?.name ?? "Unknown",
            authority: obligation?.authority ?? null,
            code: obligation?.code ?? null,
            periodLabel: r.periodLabel,
            dueDate: r.dueDate,
            status: r.status,
            severity: r.severity,
            overdue: isOverdue,
            filingReference: r.filingReference,
            daysLate: r.daysLate,
            lateFee: money(r.lateFeeMinor),
          };
        });
      });
    }

    /* ---------------- licences ---------------- */
    case "ordence_list_licences": {
      return withTenant(session.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: complianceLicences.id,
            licenceNumber: complianceLicences.licenceNumber,
            name: complianceLicences.name,
            authority: complianceLicences.authority,
            status: complianceLicences.status,
            issuedOn: complianceLicences.issuedOn,
            validFrom: complianceLicences.validFrom,
            validUntil: complianceLicences.validUntil,
            subjectCompanyId: complianceLicences.subjectCompanyId,
            appliesTo: complianceLicences.appliesTo,
          })
          .from(complianceLicences)
          .where(eq(complianceLicences.tenantId, session.tenantId))
          .orderBy(asc(complianceLicences.validUntil))
          .limit(200);

        const today = new Date().toISOString().slice(0, 10);

        return rows.map((r) => ({
          id: r.id,
          licenceNumber: r.licenceNumber,
          name: r.name,
          authority: r.authority,
          status: r.status,
          issuedOn: r.issuedOn,
          validFrom: r.validFrom,
          validUntil: r.validUntil,
          appliesTo: r.appliesTo,
          expiresSoon:
            r.validUntil &&
            r.validUntil <=
              new Date(Date.now() + 30 * 86_400_000)
                .toISOString()
                .slice(0, 10),
          isExpired: r.validUntil && r.validUntil < today,
        }));
      });
    }

    /* ---------------- stock position ---------------- */
    case "ordence_stock_position": {
      const lowStockOnly = args.lowStockOnly === true;
      return withTenant(session.tenantId, async (tx) => {
        // Join stock_balances with stock_items for a position view.
        const rows = await tx
          .select({
            itemId: stockItems.id,
            sku: stockItems.sku,
            itemName: stockItems.name,
            uom: stockItems.uom,
            reorderLevel: stockItems.reorderLevel,
            reorderQuantity: stockItems.reorderQuantity,
            warehouseId: stockBalances.warehouseId,
            onHand: stockBalances.quantityOnHand,
            reserved: stockBalances.quantityReserved,
          })
          .from(stockItems)
          .innerJoin(
            stockBalances,
            and(
              eq(stockBalances.tenantId, session.tenantId),
              eq(stockBalances.stockItemId, stockItems.id),
            ),
          )
          .where(
            and(
              eq(stockItems.tenantId, session.tenantId),
              isNull(stockItems.deletedAt),
              eq(stockItems.isActive, true),
            ),
          )
          .orderBy(asc(stockItems.sku))
          .limit(200);

        const formatted = rows.map((r) => {
          const onHandNum = Number(r.onHand ?? 0);
          const reservedNum = Number(r.reserved ?? 0);
          const available = onHandNum - reservedNum;
          const reorderLevelNum = r.reorderLevel
            ? Number(r.reorderLevel)
            : null;
          const isLow =
            reorderLevelNum !== null && onHandNum <= reorderLevelNum;
          return {
            itemId: r.itemId,
            sku: r.sku,
            name: r.itemName,
            uom: r.uom,
            warehouseId: r.warehouseId,
            onHand: r.onHand?.toString() ?? "0",
            reserved: r.reserved?.toString() ?? "0",
            available: available.toString(),
            reorderLevel: r.reorderLevel?.toString() ?? null,
            reorderQuantity: r.reorderQuantity?.toString() ?? null,
            isLowStock: isLow,
          };
        });

        return lowStockOnly
          ? formatted.filter((r) => r.isLowStock)
          : formatted;
      });
    }

    /* ---------------- scheduling bookings ---------------- */
    case "ordence_list_bookings": {
      const statusFilter =
        typeof args.status === "string" ? args.status : null;
      return withTenant(session.tenantId, async (tx) => {
        let rows;
        if (statusFilter) {
          rows = await tx
            .select({
              id: scheduleBookings.id,
              reference: scheduleBookings.reference,
              resourceId: scheduleBookings.resourceId,
              status: scheduleBookings.status,
              startTime: scheduleBookings.startsAt,
              endTime: scheduleBookings.endsAt,
              tenantId: scheduleBookings.tenantId,
            })
            .from(scheduleBookings)
            .where(
              and(
                eq(scheduleBookings.tenantId, session.tenantId),
                sql`${scheduleBookings.status} = ${statusFilter}::schedule_booking_status`,
              ),
            )
            .orderBy(asc(scheduleBookings.startsAt))
            .limit(100);
        } else {
          // Active bookings only: held, confirmed, checked_in, in_progress
          rows = await tx
            .select({
              id: scheduleBookings.id,
              reference: scheduleBookings.reference,
              resourceId: scheduleBookings.resourceId,
              status: scheduleBookings.status,
              startTime: scheduleBookings.startsAt,
              endTime: scheduleBookings.endsAt,
              tenantId: scheduleBookings.tenantId,
            })
            .from(scheduleBookings)
            .where(
              and(
                eq(scheduleBookings.tenantId, session.tenantId),
                sql`${scheduleBookings.status} IN ('held','confirmed','checked_in','in_progress')`,
              ),
            )
            .orderBy(asc(scheduleBookings.startsAt))
            .limit(100);
        }

        // Join resource names
        const resourceIds = [
          ...new Set(rows.map((r) => r.resourceId).filter(Boolean)),
        ] as string[];
        const resourceRows = resourceIds.length
          ? await tx
              .select({
                id: scheduleResources.id,
                name: scheduleResources.name,
                code: scheduleResources.code,
                kind: scheduleResources.kind,
              })
              .from(scheduleResources)
              .where(
                and(
                  eq(scheduleResources.tenantId, session.tenantId),
                  inArray(scheduleResources.id, resourceIds),
                ),
              )
          : [];
        const resourceMap = new Map(resourceRows.map((r) => [r.id, r]));

        return rows.map((r) => ({
          id: r.id,
          reference: r.reference,
          resourceName: resourceMap.get(r.resourceId)?.name ?? null,
          resourceCode: resourceMap.get(r.resourceId)?.code ?? null,
          resourceKind: resourceMap.get(r.resourceId)?.kind ?? null,
          status: r.status,
          startTime: r.startTime,
          endTime: r.endTime,
        }));
      });
    }

    /* ---------------- field jobs ---------------- */
    case "ordence_list_field_jobs": {
      const statusFilter =
        typeof args.status === "string" ? args.status : null;
      return withTenant(session.tenantId, async (tx) => {
        let rows;
        if (statusFilter) {
          rows = await tx
            .select({
              id: fieldJobs.id,
              jobNumber: fieldJobs.jobNumber,
              title: fieldJobs.title,
              jobKind: fieldJobs.jobKind,
              status: fieldJobs.status,
              priority: fieldJobs.priority,
              windowStart: fieldJobs.windowStart,
              windowEnd: fieldJobs.windowEnd,
              siteAddress: fieldJobs.siteAddress,
              assignedUserId: fieldJobs.assignedUserId,
              visitCount: fieldJobs.visitCount,
              completedAt: fieldJobs.completedAt,
              failureReason: fieldJobs.failureReason,
            })
            .from(fieldJobs)
            .where(
              and(
                eq(fieldJobs.tenantId, session.tenantId),
                sql`${fieldJobs.status} = ${statusFilter}::field_job_status`,
                isNull(fieldJobs.deletedAt),
              ),
            )
            .orderBy(asc(fieldJobs.windowStart))
            .limit(100);
        } else {
          // Active jobs: scheduled, dispatched, travelling, on_site, paused
          rows = await tx
            .select({
              id: fieldJobs.id,
              jobNumber: fieldJobs.jobNumber,
              title: fieldJobs.title,
              jobKind: fieldJobs.jobKind,
              status: fieldJobs.status,
              priority: fieldJobs.priority,
              windowStart: fieldJobs.windowStart,
              windowEnd: fieldJobs.windowEnd,
              siteAddress: fieldJobs.siteAddress,
              assignedUserId: fieldJobs.assignedUserId,
              visitCount: fieldJobs.visitCount,
              completedAt: fieldJobs.completedAt,
              failureReason: fieldJobs.failureReason,
            })
            .from(fieldJobs)
            .where(
              and(
                eq(fieldJobs.tenantId, session.tenantId),
                sql`${fieldJobs.status} IN ('scheduled','dispatched','travelling','on_site','paused')`,
                isNull(fieldJobs.deletedAt),
              ),
            )
            .orderBy(asc(fieldJobs.windowStart))
            .limit(100);
        }

        return rows.map((r) => ({
          id: r.id,
          jobNumber: r.jobNumber,
          title: r.title,
          jobKind: r.jobKind,
          status: r.status,
          priority: r.priority,
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
          siteAddress: r.siteAddress,
          visitCount: r.visitCount,
          completedAt: r.completedAt,
          failureReason: r.failureReason,
        }));
      });
    }

    /* ---------------- TDS deductions ---------------- */
    case "ordence_list_tds_deductions": {
      const sectionFilter =
        typeof args.section === "string" ? args.section : null;
      return withTenant(session.tenantId, async (tx) => {
        const conditions = [eq(tdsDeductions.tenantId, session.tenantId)];
        if (sectionFilter) {
          conditions.push(sql`${tdsDeductions.section} = ${sectionFilter}::tds_section`);
        }

        const rows = await tx
          .select({
            id: tdsDeductions.id,
            deducteeId: tdsDeductions.deducteeId,
            section: tdsDeductions.section,
            financialYear: tdsDeductions.financialYear,
            quarter: tdsDeductions.quarter,
            deductionDate: tdsDeductions.deductionDate,
            paymentBaseMinor: tdsDeductions.paymentBaseMinor,
            chargeableBaseMinor: tdsDeductions.chargeableBaseMinor,
            rateBps: tdsDeductions.rateBps,
            tdsMinor: tdsDeductions.tdsMinor,
            totalDeductedMinor: tdsDeductions.totalDeductedMinor,
            outcome: tdsDeductions.outcome,
            explanation: tdsDeductions.explanation,
            challanId: tdsDeductions.challanId,
          })
          .from(tdsDeductions)
          .where(and(...conditions))
          .orderBy(desc(tdsDeductions.deductionDate))
          .limit(100);

        // Join deductee names
        const deducteeIds = [
          ...new Set(rows.map((r) => r.deducteeId).filter(Boolean)),
        ] as string[];
        const deducteeRows = deducteeIds.length
          ? await tx
              .select({
                id: tdsDeductees.id,
                legalName: tdsDeductees.legalName,
                panNumber: tdsDeductees.panNumber,
              })
              .from(tdsDeductees)
              .where(
                and(
                  eq(tdsDeductees.tenantId, session.tenantId),
                  inArray(tdsDeductees.id, deducteeIds),
                ),
              )
          : [];
        const deducteeMap = new Map(deducteeRows.map((d) => [d.id, d]));

        return rows.map((r) => {
          const deductee = deducteeMap.get(r.deducteeId);
          return {
            id: r.id,
            deducteeName: deductee?.legalName ?? null,
            deducteePan: deductee?.panNumber ?? null,
            section: r.section,
            financialYear: r.financialYear,
            quarter: r.quarter,
            deductionDate: r.deductionDate,
            paymentBase: money(r.paymentBaseMinor),
            chargeableBase: money(r.chargeableBaseMinor),
            rateBps: r.rateBps,
            ratePercent: ((r.rateBps ?? 0) / 100).toFixed(2) + "%",
            tdsAmount: money(r.tdsMinor),
            totalDeducted: money(r.totalDeductedMinor),
            outcome: r.outcome,
            explanation: r.explanation,
            deposited: r.challanId !== null,
          };
        });
      });
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

    /* ---- v0.83.0-alpha: Additional write tools ---- */

    case "ordence_create_compliance_task": {
      return withTenant(session.tenantId, async (tx) => {
        const result = await tx
          .insert(complianceTasks)
          .values({
            tenantId: session.tenantId,
            obligationId: requireString(args, "obligationId"),
            periodLabel: requireString(args, "periodLabel"),
            dueDate: requireString(args, "dueDate"),
            status: "pending",
          } as unknown as typeof complianceTasks.$inferInsert)
          .returning({ id: complianceTasks.id });
        return { id: result[0]?.id, status: "created" };
      });
    }

    case "ordence_create_reminder": {
      const { createNotification } = await import("@/server/actions/notifications");
      const result = await createNotification({
        tenantId: session.tenantId,
        title: requireString(args, "title"),
        body: typeof args.body === "string" ? args.body : undefined,
        category: requireString(args, "category"),
        severity: typeof args.severity === "string" ? args.severity : "info",
        actionUrl: typeof args.actionUrl === "string" ? args.actionUrl : undefined,
        source: "ai_agent",
      });
      return result.ok ? { id: result.id, status: "created" } : { error: result.error };
    }

    case "ordence_update_deal_stage": {
      const { deals } = await import("@/db/schema");
      return withTenant(session.tenantId, async (tx) => {
        await tx
          .update(deals)
          .set({
            stage: requireString(args, "stage") as "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost",
            updatedAt: new Date(),
          })
          .where(and(eq(deals.id, requireString(args, "dealId")), eq(deals.tenantId, session.tenantId)));
        return { id: requireString(args, "dealId"), status: "updated" };
      });
    }

    case "ordence_create_note": {
      // Notes are stored as audit log entries with resourceType = "note"
      const { auditLogs } = await import("@/db/schema");
      return withTenant(session.tenantId, async (tx) => {
        await tx.insert(auditLogs).values({
          tenantId: session.tenantId,
          action: "create",
          resourceType: requireString(args, "recordType"),
          resourceId: requireString(args, "recordId"),
          newValue: { note: requireString(args, "body") },
          reason: "Note created via AI assistant",
        });
        return { status: "created" };
      });
    }

    case "ordence_send_email": {
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        throw new Error("Email sending is not configured. Set RESEND_API_KEY.");
      }
      const { Resend } = await import("resend");
      const resend = new Resend(resendKey);
      const fromEmail = process.env.RESEND_FROM_EMAIL || "Ordence <notifications@mail.ordence.com>";
      const result = await resend.emails.send({
        from: fromEmail,
        to: requireString(args, "to"),
        subject: requireString(args, "subject"),
        text: requireString(args, "body"),
      });
      return { id: result.data?.id, status: "sent" };
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
