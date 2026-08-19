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
import { requirePermission, writeAudit } from "@/server/audit";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";
import {
  compareSignals,
  type Signal,
} from "@/lib/patterns/rhythm";
/**
 * ⭐ THE RECOMPUTE ITSELF, WHICH IS NO LONGER IN THIS FILE. Brief C moved
 * it so that a nightly schedule — which has no browser session — could
 * call it. See the header on the module.
 */
import { recomputeRhythmsForTenant } from "@/server/patterns/rhythm-recompute";

const READ = "contacts:read" as const;
const WRITE = "contacts:update" as const;

/* ------------------------------------------------------------------ */
/* THE RECOMPUTE                                                       */
/* ------------------------------------------------------------------ */

/**
 * ⭐ THE RECOMPUTE — THE INTERACTIVE DOOR ONTO IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE BODY MOVED TO `server/patterns/rhythm-recompute.ts` — Brief C
 * ══════════════════════════════════════════════════════════════════════
 * This function was the ONLY writer of `customer_rhythms` and
 * `rhythm_signals`, and nothing called it. The `/rhythms` board read what
 * was computed; nothing computed. The half of the feature the owner
 * valued most — the customer who has gone quiet — cannot be noticed by a
 * function that never runs.
 *
 * The caller that has to exist runs nightly and has no Clerk session, so
 * it cannot come through this file: every export here is a
 * browser-reachable RPC endpoint and one taking a `tenantId` would be a
 * way past row-level security.
 *
 * ⚠️ THE BUTTON STAYS. "Recompute now" after a bulk import is a real
 * request, and it is the only way to see today's answer today.
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

    const result = await recomputeRhythmsForTenant({
      tenantId: ctx.tenant.id,
      impersonationId: ctx.impersonationId,
      audit: (entry) =>
        writeAudit(ctx, {
          action: "update",
          resourceType: "customer_rhythms",
          resourceId: ctx.tenant.id,
          newValue: {
            examined: entry.examined,
            regular: entry.regular,
            lapsed: entry.lapsed,
            signalsRaised: entry.signalsRaised,
          },
          severity: "info",
        }),
    });

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
