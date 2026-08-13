"use server";

/**
 * Ordence — ⭐⭐⭐ WHO IS ABOUT TO ORDER, AND WHO HAS STOPPED
 * Version: v1.16.0-alpha
 *
 * ⚠️ EVERY EXPORT IS AN ASYNC FUNCTION AND NONE TAKES A TENANT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THIS IS THE FEATURE THE OWNER ASKED FOR, IN THEIR OWN WORDS
 * ══════════════════════════════════════════════════════════════════════
 * "The system should recognise purchase patterns of my customers and
 * then notify me that this customer is likely to order today."
 *
 * 🔴 AND THE HALF THEY DID NOT ASK FOR IS WORTH MORE. A customer who
 * ordered every month for two years and has not ordered for seven weeks
 * has gone somewhere else, and nothing in an ERP reports an absence:
 * sales reports show what happened, and cannot show what did not.
 *
 * ⚠️ The nudge is worth a call. The silence is worth the account.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant } from "@/db";
import { customerRhythms, rhythmSignals } from "@/db/schema/patterns";
import { tasks } from "@/db/schema/work";
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  compareSignals,
  detectRhythm,
  signalFrom,
  type Signal,
} from "@/lib/patterns/rhythm";

const READ = "crm.contacts.read" as const;
const WRITE = "crm.contacts.write" as const;

/** ⚠️ IST, because a business day is a business day. */
function istToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/* ------------------------------------------------------------------ */
/* THE RECOMPUTE                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Reads every customer's order dates and replaces their rhythm row.
 *
 * 🔴 REPLACES, NEVER PATCHES. A derived row that can be partially
 * updated is a derived row that will disagree with the data it came
 * from, and 0068 refuses any update that does not move `computed_at`.
 */
export async function recomputeRhythms(): Promise<
  ActionResult<{
    readonly examined: number;
    readonly regular: number;
    readonly lapsed: number;
    readonly signalsRaised: number;
    readonly tasksRaised: number;
  }>
> {
  try {
    const ctx = await requirePermission(WRITE);
    const now = new Date();
    const today = istToday(now);

    const result = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        /**
         * ⭐ ORDER DATES PER CUSTOMER, FROM THE INVOICES THAT WERE
         * ACTUALLY RAISED.
         *
         * ⚠️ Not from quotations, and not from cancelled or void
         * invoices. A pattern built on things that did not happen
         * predicts things that will not happen.
         */
        const rows = await tx.execute(sql`
          SELECT c.id AS subject_id,
                 btrim(concat_ws(' ', c.first_name, c.last_name)) AS subject_label,
                 array_agg(DISTINCT i.invoice_date::text
                           ORDER BY i.invoice_date::text) AS order_dates
            FROM contacts c
            JOIN sales_invoices i ON i.contact_id = c.id
           WHERE c.tenant_id = ${ctx.tenant.id}::uuid
             AND i.tenant_id = ${ctx.tenant.id}::uuid
             -- 🔴 ISSUED AND BEYOND ONLY. A pattern built on drafts and
             -- cancellations predicts things that will not happen.
             AND i.status IN ('issued', 'part_paid', 'paid')
           GROUP BY c.id, c.first_name, c.last_name
        `);

        let regular = 0;
        let lapsed = 0;
        let signalsRaised = 0;
        let tasksRaised = 0;
        const examined = rowsOf(rows).length;

        for (const row of rowsOf<Record<string, unknown>>(rows)) {
          const dates = (row.order_dates as string[] | null) ?? [];
          const subjectId = String(row.subject_id);
          const label = String(row.subject_label ?? "This customer");

          const rhythm = detectRhythm(dates, today);
          if (rhythm.verdict === "regular") regular += 1;
          if (rhythm.verdict === "lapsed") lapsed += 1;

          /**
           * 🔴 THE REFUSALS ARE STORED TOO. "We looked and there is no
           * pattern" is an answer, and a screen showing only the
           * confident rows makes a business look like it has forty
           * customers when it has four hundred.
           */
          await tx
            .insert(customerRhythms)
            .values({
              tenantId: ctx.tenant.id,
              subjectType: "contact",
              subjectId,
              subjectLabel: label,
              verdict: rhythm.verdict,
              orderCount: rhythm.orderCount,
              firstOrderOn: rhythm.firstOrderOn,
              lastOrderOn: rhythm.lastOrderOn,
              medianGapDays: rhythm.medianGapDays,
              madDays: rhythm.madDays,
              expectedNextOn: rhythm.expectedNextOn,
              windowDays: rhythm.windowDays,
              confidence: rhythm.confidence,
              drift: rhythm.drift,
              explanation: rhythm.explanation.slice(0, 1000),
              computedAt: now,
              computedThroughOn: today,
            })
            .onConflictDoUpdate({
              target: [
                customerRhythms.tenantId,
                customerRhythms.subjectType,
                customerRhythms.subjectId,
              ],
              set: {
                subjectLabel: label,
                verdict: rhythm.verdict,
                orderCount: rhythm.orderCount,
                firstOrderOn: rhythm.firstOrderOn,
                lastOrderOn: rhythm.lastOrderOn,
                medianGapDays: rhythm.medianGapDays,
                madDays: rhythm.madDays,
                expectedNextOn: rhythm.expectedNextOn,
                windowDays: rhythm.windowDays,
                confidence: rhythm.confidence,
                drift: rhythm.drift,
                explanation: rhythm.explanation.slice(0, 1000),
                computedAt: now,
                computedThroughOn: today,
              },
            });

          const signal = signalFrom(rhythm, today, label);
          if (!signal) continue;

          /**
           * ⭐ THE OCCURRENCE IS WHAT MAKES A NIGHTLY JOB SURVIVABLE.
           *
           * 🔴 For a due signal it is the expected date; for a lapse it
           * is the month. So running this every night re-raises nothing,
           * and the salesman still trusts the list on the third day.
           */
          const occurrence =
            signal.kind === "lapsed" ? today.slice(0, 7) : signal.dueOn;

          const inserted = await tx
            .insert(rhythmSignals)
            .values({
              tenantId: ctx.tenant.id,
              subjectType: "contact",
              subjectId,
              subjectLabel: label,
              kind: signal.kind,
              occurrence,
              dueOn: signal.dueOn,
              confidence: signal.confidence,
              headline: signal.headline.slice(0, 300),
              detail: signal.detail.slice(0, 1000),
              raisedAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: rhythmSignals.id });

          const signalId = inserted[0]?.id as string | undefined;
          if (!signalId) continue;
          signalsRaised += 1;

          /**
           * 🔴🔴 AND THIS IS THE LINE THAT MAKES ANY OF IT MATTER.
           *
           * ⚠️ A prediction on a screen is a prediction nobody acts on.
           * 0060 built tasks; a signal that does not become one is a
           * report, and this business already has reports.
           */
          const task = await tx
            .insert(tasks)
            .values({
              tenantId: ctx.tenant.id,
              title: signal.headline.slice(0, 300),
              detail: signal.detail,
              subjectType: "contact",
              subjectId,
              subjectLabel: label,
              dueOn: today,
              priority: signal.priority,
              status: "open",
            })
            .returning({ id: tasks.id });

          const taskId = task[0]?.id as string | undefined;
          if (taskId) {
            tasksRaised += 1;
            await tx
              .update(rhythmSignals)
              .set({ taskId })
              .where(eq(rhythmSignals.id, signalId));
          }
        }

        await writeAudit(ctx, {
          action: "update",
          resourceType: "customer_rhythms",
          resourceId: ctx.tenant.id,
          newValue: { examined, regular, lapsed, signalsRaised },
          severity: "info",
        });

        return { examined, regular, lapsed, signalsRaised, tasksRaised };
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/rhythms");
    return { ok: true, data: result };
  } catch (err) {
    return toSalesActionError(err, "recomputeRhythms");
  }
}

/* ------------------------------------------------------------------ */
/* SCORING IT                                                          */
/* ------------------------------------------------------------------ */

const scoreSchema = z.object({
  signalId: z.string().uuid(),
  outcome: z.enum(["ordered", "no_order", "dismissed"]),
});

/**
 * ⭐⭐ A PREDICTION FEATURE NOBODY SCORES IS ASTROLOGY.
 *
 * 🔴 If the customer ordered, the signal was right. If nothing happened,
 * it was not. A business deserves to know which before it trusts the
 * list, and 0068 refuses to let a prediction be scored twice.
 */
export async function scoreSignal(
  input: unknown,
): Promise<ActionResult<{ scored: true }>> {
  try {
    const data = scoreSchema.parse(input);
    const ctx = await requirePermission(WRITE);

    await withTenant(
      ctx.tenant.id,
      async (tx) => {
        await tx
          .update(rhythmSignals)
          .set({ outcome: data.outcome, outcomeAt: new Date() })
          .where(
            and(
              eq(rhythmSignals.tenantId, ctx.tenant.id),
              eq(rhythmSignals.id, data.signalId),
            ),
          );
      },
      { impersonationId: ctx.impersonationId },
    );

    revalidatePath("/rhythms");
    return { ok: true, data: { scored: true } };
  } catch (err) {
    return toSalesActionError(err, "scoreSignal");
  }
}

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

export interface RhythmRow {
  readonly subjectId: string;
  readonly label: string;
  readonly verdict: string;
  readonly orderCount: number;
  readonly explanation: string;
  readonly confidence: number;
  readonly expectedNextOn: string | null;
  readonly drift: string;
}

export async function getRhythmBoard(): Promise<
  ActionResult<{
    readonly signals: readonly (Signal & { id: string; subjectId: string })[];
    readonly rhythms: readonly RhythmRow[];
    /** ⭐ How the predictions have actually done. */
    readonly scoreboard: {
      readonly scored: number;
      readonly right: number;
      readonly accuracy: number | null;
    };
    readonly computedAt: string | null;
  }>
> {
  try {
    const ctx = await requirePermission(READ);

    const data = await withTenant(
      ctx.tenant.id,
      async (tx) => {
        const open = await tx
          .select()
          .from(rhythmSignals)
          .where(
            and(
              eq(rhythmSignals.tenantId, ctx.tenant.id),
              sql`${rhythmSignals.outcome} IS NULL`,
            ),
          )
          .orderBy(desc(rhythmSignals.raisedAt))
          .limit(200);

        const rhythms = await tx
          .select()
          .from(customerRhythms)
          .where(eq(customerRhythms.tenantId, ctx.tenant.id))
          .orderBy(desc(customerRhythms.confidence))
          .limit(200);

        /**
         * 🔴 THE SCOREBOARD. `dismissed` is excluded from both halves:
         * somebody closing a card without looking is not evidence either
         * way, and counting it as a miss would make an honest feature
         * look broken.
         */
        const score = await tx.execute(sql`
          SELECT count(*) FILTER (WHERE outcome IN ('ordered', 'no_order'))::int AS scored,
                 count(*) FILTER (WHERE outcome = 'ordered')::int AS right_count
            FROM rhythm_signals
           WHERE tenant_id = ${ctx.tenant.id}::uuid
        `);
        const s = firstRow<{ scored: number; right_count: number }>(score);

        const signals = open
          .map((r: Record<string, unknown>) => ({
            id: String(r.id),
            subjectId: String(r.subjectId),
            kind: String(r.kind) as Signal["kind"],
            dueOn: String(r.dueOn),
            daysOut: 0,
            confidence: Number(r.confidence ?? 0),
            headline: String(r.headline),
            detail: String(r.detail),
            priority: "normal" as const,
          }))
          .sort(compareSignals);

        return {
          signals,
          rhythms: rhythms.map((r: Record<string, unknown>) => ({
            subjectId: String(r.subjectId),
            label: String(r.subjectLabel ?? ""),
            verdict: String(r.verdict),
            orderCount: Number(r.orderCount ?? 0),
            explanation: String(r.explanation),
            confidence: Number(r.confidence ?? 0),
            expectedNextOn: r.expectedNextOn ? String(r.expectedNextOn) : null,
            drift: String(r.drift),
          })),
          scoreboard: {
            scored: s?.scored ?? 0,
            right: s?.right_count ?? 0,
            accuracy:
              s && s.scored > 0
                ? Math.round((s.right_count / s.scored) * 100)
                : null,
          },
          computedAt:
            rhythms.length > 0
              ? (rhythms[0]?.computedAt as Date)?.toISOString() ?? null
              : null,
        };
      },
      { impersonationId: ctx.impersonationId },
    );

    return { ok: true, data };
  } catch (err) {
    return toSalesActionError(err, "getRhythmBoard");
  }
}

/* ------------------------------------------------------------------ */

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return Array.isArray(r?.rows) ? r.rows : Array.isArray(result) ? (result as T[]) : [];
}

function firstRow<T>(result: unknown): T | null {
  return rowsOf<T>(result)[0] ?? null;
}
