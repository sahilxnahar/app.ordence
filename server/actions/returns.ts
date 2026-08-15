"use server";

/**
 * Ordence — ⭐⭐⭐ THE MONTHLY RETURN AND WHAT IS DUE
 * Version: v1.24.0-alpha · Batch 16
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT ID.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 TWO THINGS, AND THE SECOND ONE IS THE ONE PEOPLE WILL USE DAILY
 * ══════════════════════════════════════════════════════════════════════
 * The 3B is the harder piece and it runs once a month. The due list runs
 * every time somebody wonders what they owe, and until now that question
 * could only be answered by opening a trial balance and knowing which
 * eight accounts to read — which is a thing nobody does on the 6th.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { gstReturns } from "@/db/schema/returns";
import { journalEntries, salesPostingAccounts, transactions } from "@/db/schema/accounting";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import { postReturnSetoff } from "@/server/accounting/post-sales";
import {
  assembleGstr3b,
  gstr3bDueDate,
  periodWindow,
  rupeeStringToMinor,
} from "@/server/returns/assemble";
import { buildDueList, summariseDue } from "@/lib/compliance/statutory-due";
import { RETURN_ROLE_META } from "@/lib/accounting/sales-posting";
import type { ActionResult } from "@/lib/validators/crm";

/**
 * ⚠️ EXISTING KEYS, NOT NEW ONES. A return is a GST document and the
 * accountant already holds `gst:read`; posting the reclassification is
 * posting a transaction, which `transactions:post` already governs.
 *
 * 🔴 MINTING NEW KEYS FOR THIS WOULD MEAN EVERY EXISTING ROLE DENIES
 * SILENTLY on day one — the exact failure documented at the top of
 * `PERMISSION_CATALOG`, which denied `/land`, `/inventory` and `/orders`
 * to every user for months.
 */
const READ = "gst:read" as const;
const PREPARE = "gst:manage_rates" as const;
const POST = "transactions:post" as const;

type Refusal = { error: string };
type Ok<T> = T & { error?: undefined };
type Outcome<T> = Refusal | Ok<T>;

/* ================================================================== */
/* ① PREPARE                                                           */
/* ================================================================== */

const prepareSchema = z.object({
  gstin: z.string().trim().length(15),
  taxPeriod: z.string().regex(/^\d{4}-\d{2}$/),
  itcReversedIgstMinor: z.string().regex(/^\d+$/).default("0"),
  itcReversedCgstMinor: z.string().regex(/^\d+$/).default("0"),
  itcReversedSgstMinor: z.string().regex(/^\d+$/).default("0"),
  itcReversedCessMinor: z.string().regex(/^\d+$/).default("0"),
  interestMinor: z.string().regex(/^\d+$/).default("0"),
  lateFeeMinor: z.string().regex(/^\d+$/).default("0"),
});

/**
 * ⭐ ASSEMBLE FROM THE LEDGER AND WRITE A DRAFT. Recomputable until it
 * is finalised, which is what makes it safe to run on the 2nd and again
 * on the 18th after a late invoice lands.
 */
export async function prepareGstr3b(
  input: unknown,
): Promise<ActionResult<{ id: string; totalCashMinor: string; problems: string[]; note: string }>> {
  try {
    const ctx = await requirePermission(PREPARE);
    const parsed = prepareSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the form." };
    const d = parsed.data;

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ id: string; totalCashMinor: string; problems: string[] }>> => {
        const [existing] = await tx
          .select({ id: gstReturns.id, status: gstReturns.status })
          .from(gstReturns)
          .where(
            and(
              eq(gstReturns.tenantId, ctx.tenant.id),
              eq(gstReturns.gstin, d.gstin),
              eq(gstReturns.taxPeriod, d.taxPeriod),
              sql`${gstReturns.status} <> 'superseded'`,
            ),
          )
          .limit(1);

        if (existing && existing.status !== "draft") {
          return {
            error: `The ${d.taxPeriod} return has already been ${existing.status}. Supersede it with a reason if the figures need to change — a filed return cannot be edited, and GST corrects a mistake in a LATER period rather than by amending this one.`,
          };
        }

        const assembled = await assembleGstr3b(tx, {
          tenantId: ctx.tenant.id,
          gstin: d.gstin,
          taxPeriod: d.taxPeriod,
          itcReversed: {
            igst: BigInt(d.itcReversedIgstMinor),
            cgst: BigInt(d.itcReversedCgstMinor),
            sgst: BigInt(d.itcReversedSgstMinor),
            cess: BigInt(d.itcReversedCessMinor),
          },
          interestMinor: BigInt(d.interestMinor),
          lateFeeMinor: BigInt(d.lateFeeMinor),
        });

        const b = assembled.built;
        const { from } = periodWindow(d.taxPeriod);

        const values = {
          tenantId: ctx.tenant.id,
          returnType: "GSTR3B",
          gstin: d.gstin,
          taxPeriod: d.taxPeriod,
          periodStart: from,
          periodEnd: assembled.periodEnd,
          status: "draft" as const,
          outwardTaxableValueMinor: b.outwardTaxableValueMinor.toString(),
          outputIgstMinor: b.outputLiability.igst.toString(),
          outputCgstMinor: b.outputLiability.cgst.toString(),
          outputSgstMinor: b.outputLiability.sgst.toString(),
          outputCessMinor: b.outputLiability.cess.toString(),
          rcmIgstMinor: b.rcmLiability.igst.toString(),
          rcmCgstMinor: b.rcmLiability.cgst.toString(),
          rcmSgstMinor: b.rcmLiability.sgst.toString(),
          rcmCessMinor: b.rcmLiability.cess.toString(),
          itcIgstMinor: (b.netItc.igst + BigInt(d.itcReversedIgstMinor)).toString(),
          itcCgstMinor: (b.netItc.cgst + BigInt(d.itcReversedCgstMinor)).toString(),
          itcSgstMinor: (b.netItc.sgst + BigInt(d.itcReversedSgstMinor)).toString(),
          itcCessMinor: (b.netItc.cess + BigInt(d.itcReversedCessMinor)).toString(),
          itcReversedIgstMinor: d.itcReversedIgstMinor,
          itcReversedCgstMinor: d.itcReversedCgstMinor,
          itcReversedSgstMinor: d.itcReversedSgstMinor,
          itcReversedCessMinor: d.itcReversedCessMinor,
          cashIgstMinor: b.cashByHead.igst.toString(),
          cashCgstMinor: b.cashByHead.cgst.toString(),
          cashSgstMinor: b.cashByHead.sgst.toString(),
          cashCessMinor: b.cashByHead.cess.toString(),
          interestMinor: d.interestMinor,
          lateFeeMinor: d.lateFeeMinor,
          totalCashMinor: b.totalCashMinor.toString(),
          carriedIgstMinor: b.setoff.creditCarried.igst.toString(),
          carriedCgstMinor: b.setoff.creditCarried.cgst.toString(),
          carriedSgstMinor: b.setoff.creditCarried.sgst.toString(),
          carriedCessMinor: b.setoff.creditCarried.cess.toString(),
          setoffMoves: b.setoff.moves.map((m) => ({
            ...m,
            amountMinor: m.amountMinor.toString(),
          })),
          notes: [...b.notes],
          problems: [...b.problems],
          dueOn: gstr3bDueDate(d.taxPeriod),
          preparedAt: new Date(),
        };

        if (existing) {
          await tx.update(gstReturns).set(values).where(eq(gstReturns.id, existing.id));
          return {
            id: existing.id,
            totalCashMinor: b.totalCashMinor.toString(),
            problems: [...b.problems],
          };
        }

        const [row] = await tx
          .insert(gstReturns)
          .values({ ...values, createdBy: ctx.user.id })
          .returning({ id: gstReturns.id });

        return {
          id: row?.id ?? "",
          totalCashMinor: b.totalCashMinor.toString(),
          problems: [...b.problems],
        };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "gst_return",
      resourceId: outcome.id,
      newValue: { taxPeriod: d.taxPeriod, gstin: d.gstin },
    });

    revalidatePath("/gst/gstr3b");
    return {
      ok: true,
      data: {
        id: outcome.id,
        totalCashMinor: outcome.totalCashMinor,
        problems: outcome.problems,
        note:
          outcome.problems.length > 0
            ? "Prepared, with problems that have to be resolved before it can be finalised."
            : "Prepared from the ledger. Recompute freely until you finalise it.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "prepareGstr3b");
  }
}

/* ================================================================== */
/* ② FINALISE, FILE, POST                                              */
/* ================================================================== */

export async function finaliseGstr3b(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(PREPARE);
    const { returnId } = z.object({ returnId: z.string().uuid() }).parse(input);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ period: string }>> => {
        const [row] = await tx
          .select()
          .from(gstReturns)
          .where(and(eq(gstReturns.tenantId, ctx.tenant.id), eq(gstReturns.id, returnId)))
          .limit(1);

        if (!row) return { error: "No such return." };
        if (row.status !== "draft") {
          return { error: `This return is ${row.status} and only a draft can be finalised.` };
        }
        if ((row.problems as string[]).length > 0) {
          // 🔴 EVERY PROBLEM IS A FIGURE NOTHING IN THIS SYSTEM STANDS
          // BEHIND, and a return is a declaration to a government.
          return {
            error: `This return still carries ${(row.problems as string[]).length} problem${(row.problems as string[]).length === 1 ? "" : "s"}. Fix them and prepare it again — a return is a declaration, and every problem is a figure nothing here stands behind.`,
          };
        }

        await tx
          .update(gstReturns)
          .set({ status: "finalised", finalisedAt: new Date(), finalisedBy: ctx.user.id })
          .where(eq(gstReturns.id, returnId));

        return { period: row.taxPeriod };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gst_return",
      resourceId: returnId,
      newValue: { stage: "finalised", period: outcome.period },
    });

    revalidatePath("/gst/gstr3b");
    return {
      ok: true,
      data: {
        note: "Finalised. The figures are frozen — key them into the portal, then record the acknowledgement number here.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "finaliseGstr3b");
  }
}

const fileSchema = z.object({
  returnId: z.string().uuid(),
  arn: z.string().trim().min(4).max(40),
});

/**
 * ⭐ RECORDS THE PORTAL'S ACKNOWLEDGEMENT. Ordence does not file — that
 * needs a GSP — so this is a human keying back the number the portal
 * gave them, and its presence is what makes the return evidence.
 */
export async function recordGstr3bFiled(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(PREPARE);
    const parsed = fileSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "The acknowledgement number from the portal is required. Without it there is no evidence the return was actually accepted, and 'filed' becomes a claim nobody can check.",
      };
    }

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ done: true }>> => {
        const [row] = await tx
          .select({ status: gstReturns.status })
          .from(gstReturns)
          .where(and(eq(gstReturns.tenantId, ctx.tenant.id), eq(gstReturns.id, parsed.data.returnId)))
          .limit(1);

        if (!row) return { error: "No such return." };
        if (row.status !== "finalised") {
          return { error: "Only a finalised return can be marked as filed." };
        }

        await tx
          .update(gstReturns)
          .set({
            status: "filed",
            arn: parsed.data.arn,
            filedAt: new Date(),
            filedBy: ctx.user.id,
          })
          .where(eq(gstReturns.id, parsed.data.returnId));

        return { done: true };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "update",
      resourceType: "gst_return",
      resourceId: parsed.data.returnId,
      newValue: { stage: "filed", arn: parsed.data.arn },
      severity: "notice",
    });

    revalidatePath("/gst/gstr3b");
    return {
      ok: true,
      data: {
        note: "Recorded as filed. The figures are now locked — GST provides no amendment of a filed 3B, so a mistake is corrected in a later period.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "recordGstr3bFiled");
  }
}

/**
 * ⭐⭐⭐ THE RECLASSIFICATION. This is the entry that stops the output
 * and input tax accounts growing forever.
 */
export async function postReturnJournal(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(POST);
    const { returnId } = z.object({ returnId: z.string().uuid() }).parse(input);

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ transactionId: string; period: string }>> => {
        const [row] = await tx
          .select()
          .from(gstReturns)
          .where(and(eq(gstReturns.tenantId, ctx.tenant.id), eq(gstReturns.id, returnId)))
          .limit(1);

        if (!row) return { error: "No such return." };
        if (row.transactionId) return { error: "This return is already in the ledger." };
        if (row.status !== "finalised" && row.status !== "filed") {
          return {
            error: "Only a finalised or filed return can be posted. A draft can still change, and a journal that follows a changing figure is worse than no journal.",
          };
        }

        // ⭐ THE LIABILITY CLEARED BY CREDIT IS THE OUTPUT TAX MINUS THE
        // CASH SHORTFALL, per head. Both come from the stored set-off.
        const cleared = {
          igst: BigInt(row.outputIgstMinor) - BigInt(row.cashIgstMinor),
          cgst: BigInt(row.outputCgstMinor) - BigInt(row.cashCgstMinor),
          sgst: BigInt(row.outputSgstMinor) - BigInt(row.cashSgstMinor),
          cess: BigInt(row.outputCessMinor) - BigInt(row.cashCessMinor),
        };

        const moves = (row.setoffMoves as Array<{ creditHead: string; amountMinor: string }>) ?? [];
        const creditUsed = { igst: 0n, cgst: 0n, sgst: 0n, cess: 0n };
        for (const m of moves) {
          const head = m.creditHead as keyof typeof creditUsed;
          if (head in creditUsed) creditUsed[head] += BigInt(m.amountMinor);
        }

        const posted = await postReturnSetoff(tx, {
          tenantId: ctx.tenant.id,
          userId: ctx.user.id,
          returnId,
          taxPeriod: row.taxPeriod,
          periodEnd: String(row.periodEnd),
          facts: {
            liabilityCleared: {
              igst: cleared.igst > 0n ? cleared.igst : 0n,
              cgst: cleared.cgst > 0n ? cleared.cgst : 0n,
              sgst: cleared.sgst > 0n ? cleared.sgst : 0n,
              cess: cleared.cess > 0n ? cleared.cess : 0n,
            },
            creditUsed,
            cashByHead: {
              igst: BigInt(row.cashIgstMinor),
              cgst: BigInt(row.cashCgstMinor),
              sgst: BigInt(row.cashSgstMinor),
              cess: BigInt(row.cashCessMinor),
            },
            interestMinor: BigInt(row.interestMinor),
            lateFeeMinor: BigInt(row.lateFeeMinor),
          },
        });

        if (!posted.posted) {
          if (posted.reason === "unmapped_roles") {
            return {
              error: `The return cannot reach the ledger until these accounts are mapped: ${posted.missing
                .map((r) => RETURN_ROLE_META[r as keyof typeof RETURN_ROLE_META]?.label ?? r)
                .join(", ")}.`,
            };
          }
          if (posted.reason === "period_closed") {
            return { error: `${posted.period} is closed, and this return is dated in it.` };
          }
          if (posted.reason === "already_posted") {
            return { error: "This return is already in the ledger." };
          }
          return { error: "There was nothing in this return to post." };
        }

        await tx
          .update(gstReturns)
          .set({ transactionId: posted.transactionId })
          .where(eq(gstReturns.id, returnId));

        return { transactionId: posted.transactionId, period: row.taxPeriod };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    await writeAudit(ctx, {
      action: "create",
      resourceType: "transaction",
      resourceId: outcome.transactionId,
      newValue: { source: "gstr3b", period: outcome.period },
    });

    revalidatePath("/gst/gstr3b");
    return {
      ok: true,
      data: {
        note: "Posted. The output tax discharged this month has been cleared against the credit that discharged it, and what has to be paid sits in GST Payable (cash) rather than being buried in a growing balance.",
      },
    };
  } catch (error) {
    return toSalesActionError(error, "postReturnJournal");
  }
}

const supersedeSchema = z.object({
  returnId: z.string().uuid(),
  reason: z.string().trim().min(10).max(1000),
});

export async function supersedeReturn(
  input: unknown,
): Promise<ActionResult<{ note: string }>> {
  try {
    const ctx = await requirePermission(PREPARE);
    const parsed = supersedeSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "A reason of at least ten characters is required." };
    }

    const outcome = await withTenant(
      ctx.tenant.id,
      async (tx): Promise<Outcome<{ done: true }>> => {
        const [row] = await tx
          .select({ status: gstReturns.status, arn: gstReturns.arn })
          .from(gstReturns)
          .where(and(eq(gstReturns.tenantId, ctx.tenant.id), eq(gstReturns.id, parsed.data.returnId)))
          .limit(1);

        if (!row) return { error: "No such return." };
        if (row.status === "filed") {
          // 🔴 THE LAW HAS NO AMENDMENT OF A FILED 3B, so the product
          // must not offer one.
          return {
            error: `This return was filed and acknowledged as ${row.arn}. It cannot be superseded — GST provides no amendment of a filed 3B. A mistake is corrected in a LATER period, which is both the legal remedy and the only one the department recognises.`,
          };
        }

        await tx
          .update(gstReturns)
          .set({
            status: "superseded",
            supersededAt: new Date(),
            supersedeReason: parsed.data.reason,
          })
          .where(eq(gstReturns.id, parsed.data.returnId));

        return { done: true };
      },
    );

    if (outcome.error !== undefined) return { ok: false, error: outcome.error };

    revalidatePath("/gst/gstr3b");
    return {
      ok: true,
      data: { note: "Superseded. It stays on the record with its reason, and the period is free for another." },
    };
  } catch (error) {
    return toSalesActionError(error, "supersedeReturn");
  }
}

/* ================================================================== */
/* ③ READS                                                             */
/* ================================================================== */

export async function listReturns(): Promise<
  ActionResult<{ rows: ReadonlyArray<Record<string, unknown>> }>
> {
  try {
    const ctx = await requirePermission(READ);
    const rows = await withTenant(ctx.tenant.id, async (tx) =>
      tx
        .select()
        .from(gstReturns)
        .where(eq(gstReturns.tenantId, ctx.tenant.id))
        .orderBy(desc(gstReturns.taxPeriod))
        .limit(60),
    );
    return { ok: true, data: { rows: rows as ReadonlyArray<Record<string, unknown>> } };
  } catch (error) {
    return toSalesActionError(error, "listReturns");
  }
}

export async function getReturn(returnId: string): Promise<
  ActionResult<{ row: Record<string, unknown> | null }>
> {
  try {
    const ctx = await requirePermission(READ);
    const row = await withTenant(ctx.tenant.id, async (tx) => {
      const [r] = await tx
        .select()
        .from(gstReturns)
        .where(and(eq(gstReturns.tenantId, ctx.tenant.id), eq(gstReturns.id, returnId)))
        .limit(1);
      return r ?? null;
    });
    return { ok: true, data: { row: row as Record<string, unknown> | null } };
  } catch (error) {
    return toSalesActionError(error, "getReturn");
  }
}

/* ================================================================== */
/* ④ WHAT IS DUE — THE ONE PEOPLE WILL OPEN DAILY                      */
/* ================================================================== */

const dueSchema = z.object({
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * ⭐⭐⭐ EVERYTHING THIS BUSINESS OWES A GOVERNMENT FOR A PERIOD, WITH
 * DUE DATES, FROM ACTUAL LEDGER BALANCES.
 *
 * ⚠️ EVERY ONE OF THESE LIABILITIES WAS ALREADY CORRECT AND NONE OF
 * THEM WAS ON ONE PAGE. Provident fund, pension, ESI, professional tax
 * and salary TDS have existed since last session's payroll batch and
 * nothing has ever read their balances.
 */
export async function getStatutoryDue(
  input: unknown,
): Promise<
  ActionResult<{
    items: ReadonlyArray<Record<string, unknown>>;
    summary: string;
    gstPrepared: boolean;
  }>
> {
  try {
    const ctx = await requirePermission(READ);
    const parsed = dueSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Check the period." };
    const periodEnd = parsed.data.periodEnd;
    const taxPeriod = periodEnd.slice(0, 7);

    const data = await withTenant(ctx.tenant.id, async (tx) => {
      /**
       * ⭐ CLOSING BALANCES, NOT PERIOD MOVEMENTS.
       *
       * ⚠️ AND THAT IS THE OPPOSITE OF THE 3B, DELIBERATELY. A return
       * declares one month's activity; what you OWE is everything not
       * yet paid, including anything from an earlier month that was
       * missed. Using the month's movement here would show a clean
       * slate to a business three months behind.
       */
      const rows = await tx
        .select({
          role: salesPostingAccounts.role,
          debit: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'debit' THEN ${journalEntries.amount} ELSE 0 END), 0)`,
          credit: sql<string>`COALESCE(SUM(CASE WHEN ${journalEntries.entryType} = 'credit' THEN ${journalEntries.amount} ELSE 0 END), 0)`,
        })
        .from(journalEntries)
        .innerJoin(
          salesPostingAccounts,
          and(
            eq(salesPostingAccounts.ledgerId, journalEntries.ledgerId),
            eq(salesPostingAccounts.tenantId, journalEntries.tenantId),
          ),
        )
        .innerJoin(transactions, eq(transactions.id, journalEntries.transactionId))
        .where(
          and(
            eq(journalEntries.tenantId, ctx.tenant.id),
            sql`${transactions.transactionDate} <= ${periodEnd}::date`,
            eq(transactions.status, "posted"),
          ),
        )
        .groupBy(salesPostingAccounts.role);

      const balances: Record<string, bigint> = {};
      for (const r of rows) {
        // ⚠️ THESE ARE ALL LIABILITIES, so the balance is credits minus
        // debits and a negative is clamped to zero rather than shown as
        // a government owing money back.
        const net = rupeeStringToMinor(r.credit) - rupeeStringToMinor(r.debit);
        balances[r.role] = net > 0n ? net : 0n;
      }

      const [prepared] = await tx
        .select({ totalCashMinor: gstReturns.totalCashMinor })
        .from(gstReturns)
        .where(
          and(
            eq(gstReturns.tenantId, ctx.tenant.id),
            eq(gstReturns.taxPeriod, taxPeriod),
            sql`${gstReturns.status} <> 'superseded'`,
          ),
        )
        .limit(1);

      return { balances, gstCash: prepared ? BigInt(prepared.totalCashMinor) : null };
    });

    const items = buildDueList({
      periodEnd,
      balances: data.balances,
      gstCashPayableMinor: data.gstCash,
      today: new Date().toISOString().slice(0, 10),
    });

    return {
      ok: true,
      data: {
        items: items.map((i) => ({ ...i, amountMinor: i.amountMinor.toString() })),
        summary: summariseDue(items),
        gstPrepared: data.gstCash !== null,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "getStatutoryDue");
  }
}
