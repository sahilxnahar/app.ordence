/**
 * Ordence — ⭐⭐⭐ THE MORNING SUMMARY
 * Version: v1.26.0-alpha · Batch 18
 *
 * ⚠️ The guard is on the action, not on this route.
 */

import { getMorningSummary } from "@/server/actions/command";
import { MorningBoard, type MorningItemView } from "@/components/command/morning-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today · Ordence" };

export default async function CommandPage() {
  const summary = await getMorningSummary();

  if (!summary.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm text-destructive">{summary.error}</p>
      </main>
    );
  }

  const items: MorningItemView[] = summary.data.items.map((i) => ({
    key: i.key,
    kind: i.kind,
    headline: i.headline,
    amountMinor: i.amountMinor,
    deadline: i.deadline,
    state: i.state,
    compounds: i.compounds,
    consequence: i.consequence,
    where: i.where,
    detail: i.detail,
  }));

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          What stops being fixable soonest, ordered by what it costs to ignore rather than
          by how big it is. A ₹4,000 provident fund payment one day late is a worse morning
          than a ₹40 lakh invoice nine days late, and a page sorted by amount gets that
          exactly backwards.
        </p>
      </div>

      <MorningBoard
        headline={summary.data.headline}
        allClear={summary.data.allClear}
        actionableCount={summary.data.actionableCount}
        totalAtStakeMinor={summary.data.totalAtStakeMinor}
        items={items}
        hiddenNote={summary.data.hiddenNote}
        asOf={summary.data.asOf}
      />
    </main>
  );
}
