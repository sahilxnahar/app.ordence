import "server-only";

/**
 * Ordence — ⭐⭐⭐ THE RHYTHM RECOMPUTE, AS A FUNCTION A SCHEDULER CAN CALL
 * Version: v1.66.0-alpha (Brief C)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS MOVED OUT OF `server/actions/rhythms.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The `/rhythms` board reads `customer_rhythms` and `rhythm_signals`.
 * `recomputeRhythms` is the only thing in the product that writes them,
 * and NOTHING CALLED IT — no screen, no route, no schedule. The board
 * therefore showed whatever the last manual invocation had left, which on
 * a fresh workspace is nothing at all: a feature the owner asked for by
 * name, built correctly, displaying an empty table forever.
 *
 * ⚠️ THE FEATURE IS THE NIGHTLY RUN, NOT THE BUTTON. A "likely to order
 * today" signal that only appears when somebody remembers to press
 * refresh is a signal about the person pressing refresh.
 *
 * A scheduler has no Clerk session and no user, and
 * `server/actions/rhythms.ts` is a `"use server"` module where every
 * export is a browser-reachable RPC endpoint — so an export there taking
 * a `tenantId` would be a way past row-level security. `import
 * "server-only"` is what makes taking one safe here.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BODY IS THE ORIGINAL, MOVED, NOT REWRITTEN
 * ══════════════════════════════════════════════════════════════════════
 * Three substitutions and nothing else:
 *   ① `ctx.tenant.id`       → `args.tenantId`
 *   ② `ctx.impersonationId` → `args.impersonationId`, null for the cron
 *   ③ `writeAudit(ctx, …)`  → `args.audit(…)`. The interactive path
 *      passes the chained `writeAudit` against the person's name; the
 *      scheduled path passes `writeSystemAudit`, which appends to the
 *      SAME per-tenant chain rather than opening a second one.
 *
 * ⚠️ THE PERMISSION CHECK DID NOT MOVE. It is a statement about a
 * request, and this function has no request. The scheduler gates on the
 * workspace's entitlement instead — see `server/scheduling/registry.ts`.
 */

import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { customerRhythms, rhythmSignals } from "@/db/schema/patterns";
import { tasks } from "@/db/schema/work";
import { detectRhythm, signalFrom } from "@/lib/patterns/rhythm";

/** ⚠️ IST, because a business day is a business day. */
function istToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return Array.isArray(r?.rows) ? r.rows : Array.isArray(result) ? (result as T[]) : [];
}

export type RhythmRecomputeOutcome = {
  readonly examined: number;
  readonly regular: number;
  readonly lapsed: number;
  readonly signalsRaised: number;
  readonly tasksRaised: number;
};

export type RecomputeRhythmsArgs = {
  tenantId: string;
  impersonationId?: string | null;
  audit: (entry: RhythmRecomputeOutcome) => Promise<void>;
};

/**
 * ⭐ Reads every customer's order dates and replaces their rhythm row.
 *
 * 🔴 REPLACES, NEVER PATCHES. A derived row that can be partially updated
 * is a derived row that will disagree with the data it came from, and
 * 0068 refuses any update that does not move `computed_at`.
 *
 * ⭐ IDEMPOTENT BY OCCURRENCE, WHICH IS WHAT MAKES A NIGHTLY JOB
 * SURVIVABLE. The rhythm row is an upsert on
 * (tenant, subject_type, subject_id); the signal is
 * `ON CONFLICT DO NOTHING` against an occurrence key that is the expected
 * date for a due signal and the MONTH for a lapse. Running this twice in
 * one day raises no second signal and therefore creates no second task,
 * which is the difference between a salesman trusting the list on day
 * three and deleting it.
 */
export async function recomputeRhythmsForTenant(
  args: RecomputeRhythmsArgs,
): Promise<RhythmRecomputeOutcome> {
  const now = new Date();
  const today = istToday(now);

  return withTenant(
    args.tenantId,
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
         WHERE c.tenant_id = ${args.tenantId}::uuid
           AND i.tenant_id = ${args.tenantId}::uuid
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
            tenantId: args.tenantId,
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
            tenantId: args.tenantId,
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
            tenantId: args.tenantId,
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

      await args.audit({ examined, regular, lapsed, signalsRaised, tasksRaised });

      return { examined, regular, lapsed, signalsRaised, tasksRaised };
    },
    { impersonationId: args.impersonationId ?? null },
  );
}
