"use server";

/**
 * Ordence — ⭐⭐⭐ THE MORNING SUMMARY
 * Version: v1.26.0-alpha · Batch 18
 *
 * ⚠️ Every export is an async function, and every one is a
 * browser-reachable RPC endpoint — which `check:guards`, new in this
 * version, now verifies rather than trusts.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE READ PERMISSION, AND IT IS DELIBERATELY A LOW ONE
 * ══════════════════════════════════════════════════════════════════════
 * This page shows what is owed to governments, what is unposted and who
 * is waiting for money. Every figure on it is aggregate — a total and a
 * count, never a person's salary or a named buyer's balance.
 *
 * 🔴 SO IT IS GATED ON `settings:read`, WHICH ALMOST EVERYBODY HAS,
 * rather than on the union of every permission behind every signal.
 * Requiring `payroll.read` AND `gst:read` AND `transactions:read` would
 * mean the only person who could open it is the person who least needs
 * telling — and the office manager who actually pays the PF challan on
 * the fifteenth would see nothing.
 *
 * ⚠️ THE COMPROMISE IS PAID FOR BY WHAT THE PAGE DOES NOT CARRY. There
 * are no names on it and no per-record amounts; every line is a count, a
 * total and a link. Following the link lands on a screen with its own
 * guard, which refuses if that person may not be there.
 */

import { requirePermission } from "@/server/audit";
import { sweepExceptions } from "@/server/command/sweep";
import { digest, SHOWN_BY_DEFAULT } from "@/lib/command/exceptions";
import { toCivilDay } from "@/lib/gst/constants";
import { toSalesActionError } from "@/server/sales/guards";
import type { ActionResult } from "@/lib/validators/crm";

export type MorningItem = {
  key: string;
  kind: string;
  headline: string;
  amountMinor: string | null;
  deadline: string | null;
  state: string;
  compounds: boolean;
  consequence: string;
  where: string;
  detail: string | null;
};

export type MorningSummary = {
  headline: string;
  allClear: boolean;
  actionableCount: number;
  totalAtStakeMinor: string;
  items: MorningItem[];
  hiddenNote: string | null;
  asOf: string;
};

export async function getMorningSummary(): Promise<ActionResult<MorningSummary>> {
  try {
    const ctx = await requirePermission("settings:read");

    /**
     * ⚠️ IST, NOT UTC. Every deadline on this page is an Indian
     * statutory date. At 06:00 IST on the 15th a UTC "today" still reads
     * the 14th, so the PF that is due today would be reported as due
     * tomorrow — on the one morning it matters.
     */
    const today = toCivilDay(new Date());

    const signals = await sweepExceptions(ctx.tenant.id, today);
    const result = digest(signals, SHOWN_BY_DEFAULT);

    return {
      ok: true,
      data: {
        headline: result.headline,
        allClear: result.allClear,
        actionableCount: result.actionableCount,
        totalAtStakeMinor: result.totalAtStakeMinor.toString(),
        items: result.shown.map((s) => ({
          key: s.key,
          kind: s.kind,
          headline: s.headline,
          amountMinor: s.amountMinor === null ? null : s.amountMinor.toString(),
          deadline: s.deadline,
          state: s.state,
          compounds: s.compounds,
          consequence: s.consequence,
          where: s.where,
          detail: s.detail ?? null,
        })),
        hiddenNote: result.hiddenNote,
        asOf: today,
      },
    };
  } catch (error) {
    return toSalesActionError(error, "getMorningSummary");
  }
}
