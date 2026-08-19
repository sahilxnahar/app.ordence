"use server";

/**
 * Ordence — ⭐⭐ THE CLIENT ACCOUNT
 * Version: v1.7.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MONEY HELD FOR A CLIENT IS NOT THE FIRM'S MONEY
 * ══════════════════════════════════════════════════════════════════════
 * The cardinal rule of client accounting is not "keep records". It is
 * that **one client's money may never fund another client's
 * disbursement** — not for an afternoon, not where it is repaid the same
 * week.
 *
 * ⚠️ AND THE TEST FOR IT IS ARITHMETIC, NOT INTENTION. If any client's
 * ledger goes into debit, the firm paid out money it did not hold for
 * that client, which means it paid out somebody else's. There is no
 * innocent version of that number.
 *
 * ⭐ The guard is a trigger in 0058, not a check here. A rule this
 * important belongs where nothing can route around it — including a
 * future import script written in a hurry.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { clientAccountEntries, legalMatters } from "@/db/schema/legal";
import { companies } from "@/db/schema/crm";
import { salesInvoices } from "@/db/schema/sales-invoices";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { serializeAmount, toBigIntAmount } from "@/lib/billing/money";
import type { ActionResult } from "@/lib/validators/crm";

const READ = "sales.invoices.read" as const;
const WRITE = "sales.receipts.record" as const;

const civilDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const entrySchema = z.object({
  companyId: z.string().uuid(),
  matterId: z.string().uuid().nullish(),
  entryDate: civilDay,
  entryKind: z.enum([
    "receipt",
    "disbursement",
    "transfer_to_office",
    "refund_to_client",
  ]),
  description: z.string().trim().min(1).max(1000),
  referenceNo: z.string().trim().max(60).optional(),
  /** Always positive here; the sign is applied from the kind. */
  amountMinor: z.string().regex(/^\d+$/, "Whole paise, positive."),
  invoiceId: z.string().uuid().nullish(),
  bankReference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * ⭐⭐ MOVE CLIENT MONEY.
 *
 * 🔴 THE SIGN IS APPLIED FROM THE KIND, NEVER TYPED. A form that accepts
 *    a negative number invites a receipt entered as a payment out, which
 *    is perfectly valid arithmetic pointing the wrong way — and the
 *    balance it produces looks entirely plausible.
 *
 * 🔴 AND A TRANSFER TO THE FIRM'S OWN ACCOUNT MUST NAME THE BILL. Fees
 *    come out of client money only once they have been billed. A
 *    transfer with no invoice behind it is the firm helping itself to
 *    money it is holding.
 */
export async function recordClientAccountEntry(input: unknown): Promise<
  ActionResult<{
    id: string;
    balanceMinor: string;
    matterBalanceMinor: string | null;
  }>
> {
  try {
    const data = entrySchema.parse(input);
    const ctx = await requirePermission(WRITE);

    if (data.entryKind === "transfer_to_office" && !data.invoiceId) {
      throw new Error(
        "A transfer to the firm's own account has to name the bill it settles. Fees come out of client money only once they have been billed — a transfer with no invoice behind it is the firm helping itself to money it is holding for somebody else.",
      );
    }

    const signed =
      data.entryKind === "receipt"
        ? BigInt(data.amountMinor)
        : -BigInt(data.amountMinor);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        if (data.invoiceId) {
          const [inv] = await tx
            .select({ id: salesInvoices.id, status: salesInvoices.status })
            .from(salesInvoices)
            .where(
              and(
                eq(salesInvoices.tenantId, ctx.tenant.id),
                eq(salesInvoices.id, data.invoiceId),
              ),
            )
            .limit(1);
          if (!inv) throw new Error("That invoice does not exist.");
          /**
           * ⚠️ A DRAFT IS NOT A BILL. Taking fees against an invoice
           * nobody has issued is taking fees against nothing — the
           * client has not been told what they are being charged.
           */
          if (inv.status === "draft") {
            throw new Error(
              "That invoice is still a draft, so the client has not been billed. Fees can only come out of client money once the bill has been issued and the client knows what it is for.",
            );
          }
        }

        const [row] = await tx
          .insert(clientAccountEntries)
          .values({
            tenantId: ctx.tenant.id,
            companyId: data.companyId,
            matterId: data.matterId ?? null,
            entryDate: data.entryDate,
            entryKind: data.entryKind,
            description: data.description,
            referenceNo: data.referenceNo ?? null,
            /** 🔴 Signed from the kind, never from the form. */
            amountMinor: signed,
            invoiceId: data.invoiceId ?? null,
            bankReference: data.bankReference ?? null,
            notes: data.notes ?? null,
            createdBy: ctx.user.id,
          })
          .returning({ id: clientAccountEntries.id });

        if (!row) throw new Error("The entry could not be recorded.");

        const [bal] = await tx
          .select({
            balance: sql<string>`COALESCE(SUM(${clientAccountEntries.amountMinor}), 0)`,
          })
          .from(clientAccountEntries)
          .where(
            and(
              eq(clientAccountEntries.tenantId, ctx.tenant.id),
              eq(clientAccountEntries.companyId, data.companyId),
            ),
          );

        let matterBalance: string | null = null;
        if (data.matterId) {
          const [mb] = await tx
            .select({
              balance: sql<string>`COALESCE(SUM(${clientAccountEntries.amountMinor}), 0)`,
            })
            .from(clientAccountEntries)
            .where(
              and(
                eq(clientAccountEntries.tenantId, ctx.tenant.id),
                eq(clientAccountEntries.matterId, data.matterId),
              ),
            );
          matterBalance = serializeAmount(toBigIntAmount(mb?.balance ?? 0n));
        }

        await writeAudit(ctx, {
          action: "create",
          resourceType: "client_account_entry",
          resourceId: row.id,
          newValue: {
            entryKind: data.entryKind,
            amountMinor: serializeAmount(signed),
            invoiceId: data.invoiceId ?? null,
          },
          /** Client money is the one balance a regulator looks at. */
          severity: "critical",
        });

        return {
          id: row.id,
          balanceMinor: serializeAmount(toBigIntAmount(bal?.balance ?? 0n)),
          matterBalanceMinor: matterBalance,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/legal/client-account");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recordClientAccountEntry");
  }
}

/**
 * ⭐ WHAT IS HELD, FOR WHOM.
 *
 * 🔴 THE "IN DEBIT" COUNT SHOULD ALWAYS BE ZERO — the trigger in 0058
 *    makes it impossible to create one. It is reported anyway, because a
 *    control that is never shown is a control nobody trusts, and because
 *    a non-zero here would mean the trigger had been bypassed.
 */
export async function getClientAccount(): Promise<
  ActionResult<{
    clients: {
      companyId: string;
      companyName: string | null;
      balanceMinor: string;
      entryCount: number;
      lastEntry: string | null;
      inDebit: boolean;
    }[];
    totalHeldMinor: string;
    inDebitCount: number;
    /** Matters holding money but with no activity for a long while. */
    dormant: number;
    today: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const day = new Date().toISOString().slice(0, 10);

    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select({
          companyId: clientAccountEntries.companyId,
          companyName: companies.name,
          balance: sql<string>`SUM(${clientAccountEntries.amountMinor})`,
          entryCount: sql<number>`COUNT(*)::int`,
          lastEntry: sql<string>`MAX(${clientAccountEntries.entryDate})`,
        })
        .from(clientAccountEntries)
        .leftJoin(
          companies,
          and(
            eq(companies.id, clientAccountEntries.companyId),
            eq(companies.tenantId, ctx.tenant.id),
          ),
        )
        .where(eq(clientAccountEntries.tenantId, ctx.tenant.id))
        .groupBy(clientAccountEntries.companyId, companies.name)
        .limit(1000),
    );

    let total = 0n;
    let inDebitCount = 0;
    let dormant = 0;
    const cutoff = new Date(Date.parse(`${day}T00:00:00.000Z`) - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const clients = rows.map((r) => {
      const balance = toBigIntAmount(r.balance);
      total += balance;
      const inDebit = balance < 0n;
      if (inDebit) inDebitCount += 1;
      const last = r.lastEntry ? String(r.lastEntry) : null;
      /**
       * ⚠️ MONEY HELD AND NOT TOUCHED FOR A YEAR IS MONEY THAT SHOULD
       * PROBABLY HAVE GONE BACK. Holding a client's balance indefinitely
       * after the work is finished is its own regulatory problem.
       */
      if (balance > 0n && last && last < cutoff) dormant += 1;
      return {
        companyId: r.companyId,
        companyName: r.companyName,
        balanceMinor: serializeAmount(balance),
        entryCount: r.entryCount,
        lastEntry: last,
        inDebit,
      };
    });

    clients.sort((a, b) =>
      BigInt(b.balanceMinor) > BigInt(a.balanceMinor) ? 1 : -1,
    );

    return {
      ok: true,
      data: {
        clients,
        totalHeldMinor: serializeAmount(total),
        inDebitCount,
        dormant,
        today: day,
      },
    };
  } catch (err) {
    return toSalesActionError(err, "getClientAccount");
  }
}

export async function getClientAccountLedger(companyId: string): Promise<
  ActionResult<{
    rows: {
      id: string;
      entryDate: string;
      entryKind: string;
      description: string;
      matterNo: string | null;
      referenceNo: string | null;
      amountMinor: string;
      runningMinor: string;
      hasInvoice: boolean;
    }[];
    balanceMinor: string;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: clientAccountEntries.id,
          entryDate: clientAccountEntries.entryDate,
          entryKind: clientAccountEntries.entryKind,
          description: clientAccountEntries.description,
          referenceNo: clientAccountEntries.referenceNo,
          amountMinor: clientAccountEntries.amountMinor,
          invoiceId: clientAccountEntries.invoiceId,
          matterNo: legalMatters.matterNo,
        })
        .from(clientAccountEntries)
        .leftJoin(
          legalMatters,
          and(
            eq(legalMatters.id, clientAccountEntries.matterId),
            eq(legalMatters.tenantId, ctx.tenant.id),
          ),
        )
        .where(
          and(
            eq(clientAccountEntries.tenantId, ctx.tenant.id),
            eq(clientAccountEntries.companyId, companyId),
          ),
        )
        .orderBy(asc(clientAccountEntries.entryDate), asc(clientAccountEntries.createdAt))
        .limit(2000);

      /**
       * ⭐ THE RUNNING BALANCE IS COMPUTED IN ORDER, ON READ. A stored
       * running total is a figure that has to be rebuilt whenever
       * anything is entered out of date order — and the rebuild is where
       * the two versions diverge.
       */
      let running = 0n;
      const mapped = rows.map((r) => {
        const amt = toBigIntAmount(r.amountMinor);
        running += amt;
        return {
          id: r.id,
          entryDate: String(r.entryDate),
          entryKind: r.entryKind,
          description: r.description,
          matterNo: r.matterNo,
          referenceNo: r.referenceNo,
          amountMinor: serializeAmount(amt),
          runningMinor: serializeAmount(running),
          hasInvoice: r.invoiceId !== null,
        };
      });

      return { rows: mapped, balanceMinor: serializeAmount(running) };
    });

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getClientAccountLedger");
  }
}
