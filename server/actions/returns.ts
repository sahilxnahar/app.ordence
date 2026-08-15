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

/**
 * ⚠️ THE MINIMUM AN OVERRIDE REASON HAS TO BE.
 *
 * Short enough that a real sentence clears it, long enough that
 * "adjustment", "as advised" and "." do not. A required field with no
 * floor is a field everybody fills with a full stop, and then the audit
 * trail records that a reason was given and nothing about what it was.
 */
const OVERRIDE_REASON_MIN = 20;

const prepareSchema = z.object({
  gstin: z.string().trim().length(15),
  taxPeriod: z.string().regex(/^\d{4}-\d{2}$/),
  itcReversedIgstMinor: z.string().regex(/^\d+$/).default("0"),
  itcReversedCgstMinor: z.string().regex(/^\d+$/).default("0"),
  itcReversedSgstMinor: z.string().regex(/^\d+$/).default("0"),
  itcReversedCessMinor: z.string().regex(/^\d+$/).default("0"),

  /**
   * ⭐⭐ WHAT THE RULE 42 ENGINE COMPUTED FOR THIS PERIOD.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 WHY THE COMPUTED FIGURE IS AN INPUT AND NOT RECOMPUTED HERE
   * ══════════════════════════════════════════════════════════════════
   * Rule 42 needs E and F — exempt and total turnover — and the
   * Explanation to the rule pulls into E the value of land sold and of
   * buildings sold AFTER the completion certificate. Neither raises a
   * tax invoice, because a sale after the certificate is outside GST
   * entirely (Schedule III para 5). They cannot be derived from any
   * table Ordence holds, so they are typed into the working panel, and
   * recomputing here without them would produce a DIFFERENT computed
   * figure from the one the operator was shown — which is worse than
   * not computing at all.
   *
   * ⚠️ SO THIS IS NOT A TRUST BOUNDARY AND IS NOT PRETENDING TO BE ONE.
   * A caller with curl can send any pair of numbers. What it buys is the
   * thing the operator at a keyboard cannot do: change the reversal
   * without leaving a record that they changed it and why.
   */
  itcReversalComputedIgstMinor: z.string().regex(/^\d+$/).optional(),
  itcReversalComputedCgstMinor: z.string().regex(/^\d+$/).optional(),
  itcReversalComputedSgstMinor: z.string().regex(/^\d+$/).optional(),
  itcReversalComputedCessMinor: z.string().regex(/^\d+$/).optional(),
  /** One line saying where the computed figure came from. Stored. */
  itcReversalBasis: z.string().trim().max(500).optional(),
  itcReversalOverrideReason: z.string().trim().max(2000).optional(),

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

    /* ---------------------------------------------------------------- */
    /* ⭐⭐⭐ THE REVERSAL: COMPUTED, OR OVERRIDDEN WITH A REASON        */
    /* ---------------------------------------------------------------- */
    //
    // 🔴 THE FIGURE THAT USED TO ARRIVE HERE WAS TYPED, AND NOTHING
    // RECORDED WHERE IT CAME FROM. Sections 17(5) and Rule 42 were
    // implemented, tested and unreachable; the return took whatever was
    // in the box. An accountant with a figure from their own working
    // papers is a legitimate case — Rule 43 on capital goods bought in
    // earlier periods is genuinely not in the computed number — but
    // SILENTLY replacing a computed figure is not, because then the
    // register and the return disagree and nothing says so.
    const reversalCheck = describeReversal(d);
    if (reversalCheck.refusal) return { ok: false, error: reversalCheck.refusal };

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
          /**
           * ⚠️ THE PROVENANCE GOES IN `notes`, WHICH IS A COLUMN ON THE
           * RETURN AND IS RENDERED. Not into a comment, not only into the
           * audit log — the person who opens this return in eighteen
           * months to answer a notice reads the return, and the sentence
           * saying whether the reversal was computed or overridden, and
           * on what basis, has to be there when they do.
           */
          notes: [...b.notes, reversalCheck.note],
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
      /**
       * ⭐ BOTH NUMBERS, NOT THE ONE THAT WON. The return row keeps the
       * figure that was filed; only the audit keeps the figure that was
       * refused and the reason it was refused. Recording just the filed
       * one would make an override indistinguishable from an agreement,
       * which is the whole thing an assessment wants to know.
       */
      newValue: {
        taxPeriod: d.taxPeriod,
        gstin: d.gstin,
        itcReversalEnteredMinor: reversalCheck.enteredTotalMinor,
        itcReversalComputedMinor: reversalCheck.computedTotalMinor,
        itcReversalOverridden: reversalCheck.overridden,
        itcReversalBasis: d.itcReversalBasis ?? null,
        itcReversalOverrideReason: d.itcReversalOverrideReason ?? null,
      },
      // An override is the event somebody goes looking for later; the
      // agreed case is routine and should not compete with it.
      severity: reversalCheck.overridden ? "notice" : "info",
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

/**
 * ⭐⭐ DECIDE WHETHER THE REVERSAL IN THE RETURN IS THE COMPUTED ONE, AND
 * WRITE THE SENTENCE THAT SAYS SO.
 *
 * ⚠️ NOT EXPORTED. This module is `"use server"`, and every export of
 * such a module is a public HTTP endpoint. A synchronous helper exported
 * from here would be published as an RPC that returns a refusal string —
 * useless to an attacker, but the boundary gate refuses it on principle
 * and the principle is right: the rule is "every export is an async
 * function", and a rule with one exception has none.
 */
function describeReversal(d: {
  itcReversedIgstMinor: string;
  itcReversedCgstMinor: string;
  itcReversedSgstMinor: string;
  itcReversedCessMinor: string;
  itcReversalComputedIgstMinor?: string | undefined;
  itcReversalComputedCgstMinor?: string | undefined;
  itcReversalComputedSgstMinor?: string | undefined;
  itcReversalComputedCessMinor?: string | undefined;
  itcReversalBasis?: string | undefined;
  itcReversalOverrideReason?: string | undefined;
}): {
  refusal: string | null;
  overridden: boolean;
  note: string;
  enteredTotalMinor: string;
  computedTotalMinor: string | null;
} {
  const entered = [
    BigInt(d.itcReversedIgstMinor),
    BigInt(d.itcReversedCgstMinor),
    BigInt(d.itcReversedSgstMinor),
    BigInt(d.itcReversedCessMinor),
  ];
  const enteredTotal = entered.reduce((sum, head) => sum + head, 0n);

  const computedHeads = [
    d.itcReversalComputedIgstMinor,
    d.itcReversalComputedCgstMinor,
    d.itcReversalComputedSgstMinor,
    d.itcReversalComputedCessMinor,
  ];
  const hasComputed = computedHeads.every((head) => head !== undefined);
  const computed = hasComputed ? computedHeads.map((head) => BigInt(head as string)) : null;
  const computedTotal = computed ? computed.reduce((sum, head) => sum + head, 0n) : null;

  /**
   * ⚠️ HEAD BY HEAD, NOT ON THE TOTAL. Four heads that sum to the same
   * figure are still a different return: ₹1,000 moved from CGST to SGST
   * reverses credit in the wrong pool, files cleanly, balances, and is
   * found years later. A total-only comparison would let it through
   * without ever asking for a reason.
   */
  const differs =
    computed === null
      ? enteredTotal !== 0n
      : computed.some((head, i) => head !== entered[i]);

  const reason = (d.itcReversalOverrideReason ?? "").trim();

  if (differs && reason.length < OVERRIDE_REASON_MIN) {
    return {
      refusal:
        computed === null
          ? "This return carries an ITC reversal but no Rule 42 working was run for the " +
            "period. Compute the reversal — the Section 17(5) and Rule 42 engines will do " +
            "it from the purchase lines and show you which bills were blocked under which " +
            "clause — or, if the figure comes from your own working papers, say so in a " +
            "sentence. A reversal with no stated source cannot be defended at an " +
            "assessment, and the person defending it will not be you."
          : "The reversal in this return differs from the computed Rule 42 figure. That is " +
            "allowed — Rule 43 on capital goods bought in earlier periods is not in the " +
            "computed number, and your working papers may be right — but it has to be " +
            "written down. Say in a sentence why the return carries a different figure. " +
            "Both numbers are kept with the return.",
      overridden: true,
      note: "",
      enteredTotalMinor: enteredTotal.toString(),
      computedTotalMinor: computedTotal === null ? null : computedTotal.toString(),
    };
  }

  if (differs) {
    return {
      refusal: null,
      overridden: true,
      note:
        `⚠️ ITC reversal OVERRIDDEN. Computed under Rule 42: ` +
        `${computedTotal === null ? "not computed" : `${computedTotal} paise`}. ` +
        `Filed in this return: ${enteredTotal} paise. Reason given: ${reason}` +
        (d.itcReversalBasis ? ` Computed basis: ${d.itcReversalBasis}` : ""),
      enteredTotalMinor: enteredTotal.toString(),
      computedTotalMinor: computedTotal === null ? null : computedTotal.toString(),
    };
  }

  if (computed === null) {
    // Nothing reversed and nothing computed. Saying so is worth one line:
    // a nil reversal that nobody decided looks identical to one somebody
    // did, and only the second one is an answer.
    return {
      refusal: null,
      overridden: false,
      note:
        "ITC reversal: nil. No Rule 42 working was run for this period — nil is the " +
        "figure by default, not by determination.",
      enteredTotalMinor: enteredTotal.toString(),
      computedTotalMinor: null,
    };
  }

  return {
    refusal: null,
    overridden: false,
    note:
      `ITC reversal ${enteredTotal} paise computed under Rule 42, accepted unchanged. ` +
      (d.itcReversalBasis ?? ""),
    enteredTotalMinor: enteredTotal.toString(),
    computedTotalMinor: computedTotal === null ? null : computedTotal.toString(),
  };
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
