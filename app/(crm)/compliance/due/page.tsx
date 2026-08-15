/**
 * Ordence — ⭐⭐⭐ WHAT IS DUE
 * Version: v1.24.0-alpha · Batch 16
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 EVERY FIGURE ON THIS PAGE WAS ALREADY CORRECT SOMEWHERE ELSE
 * ══════════════════════════════════════════════════════════════════════
 * GST output tax has been in the ledger since v0.9x, vendor TDS since
 * v1.11.0, and provident fund, pension, ESI, professional tax and salary
 * TDS since the payroll batch last session.
 *
 * ⚠️ AND NOTHING PUT THEM ON ONE PAGE WITH THEIR DUE DATES. The only way
 * to answer "what do I owe" was to open a trial balance and know which
 * eight accounts to read, which is a thing nobody does on the 6th of the
 * month — and the cost of missing one is not the tax, it is interest,
 * late fees and, for provident fund, damages that can exceed the
 * contribution itself.
 */

import Link from "next/link";
import { getStatutoryDue } from "@/server/actions/returns";
import { DueBoard, type DueItemView } from "@/components/returns/due-board";

export const dynamic = "force-dynamic";
export const metadata = { title: "What is due · Ordence" };

function lastMonthEnd(): string {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10);
}

export default async function DuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = typeof params.period === "string" ? params.period : undefined;
  const periodEnd = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : lastMonthEnd();

  const result = await getStatutoryDue({ periodEnd });

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">What is due</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const items: DueItemView[] = result.data.items.map((i) => ({
    kind: String(i.kind),
    label: String(i.label),
    authority: String(i.authority),
    amountMinor: String(i.amountMinor),
    dueOn: String(i.dueOn),
    state: String(i.state),
    daysUntil: Number(i.daysUntil ?? 0),
    ifLate: String(i.ifLate),
    note: i.note === null || i.note === undefined ? null : String(i.note),
  }));

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">What is due</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For the period ending {periodEnd}. Every figure is a balance in your own ledger, not a
          reminder somebody typed into a calendar.
        </p>
        {!result.data.gstPrepared ? (
          <p className="mt-2 text-xs">
            <Link href="/gst/gstr3b" className="underline">
              No GSTR-3B has been prepared for this period
            </Link>{" "}
            — so the GST cash figure is not known yet. The output tax in the ledger is not the
            answer; credit has to be set off against it first.
          </p>
        ) : null}
      </div>

      <DueBoard items={items} summary={result.data.summary} />
    </main>
  );
}
