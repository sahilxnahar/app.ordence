/**
 * Ordence — ⭐⭐ ONE REVALUATION, LINE BY LINE
 * Version: v1.65.0-alpha · Batch 0101
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE WORKING PAPER, AND THE POST BUTTON IS NOT ON THE SAME CLICK
 * ══════════════════════════════════════════════════════════════════════
 * This is the page an auditor is shown. It carries every item the run
 * CONSIDERED — the ones restated at the closing rate and the ones left
 * alone, with the reason each was left alone written on its own row.
 *
 * Posting is a separate action on a separate control, guarded by
 * `fx:revalue`, and it is armed before it fires. A working paper becomes
 * a reported figure exactly once, deliberately.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { checkPermission } from "@/server/audit";
import { getRevaluationLines, listFxRevaluations } from "@/server/actions/fx";
import { PostRevaluation } from "@/components/fx/post-revaluation";
import { RevaluationWorking } from "@/components/fx/revaluation-working";
import { labelled } from "@/components/fx/fx-format";

export const dynamic = "force-dynamic";

export const metadata = { title: "Revaluation · Ordence" };

export default async function RevaluationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [working, history, revalue] = await Promise.all([
    getRevaluationLines(id),
    listFxRevaluations(),
    checkPermission("fx:revalue"),
  ]);

  if (!working.ok) {
    return (
      <div className="space-y-4 p-6">
        <Link href="/fx" className="text-xs underline">
          Currency &amp; FX
        </Link>
        <h1 className="text-2xl font-semibold">Revaluation</h1>
        {/* ⭐ A DENIAL AND A MISSING ROW READ DIFFERENTLY AND SAY SO. */}
        <p className="text-sm text-destructive" data-testid="fx-lines-error">
          {working.error}
        </p>
      </div>
    );
  }

  const run = history.ok ? history.data.find((r) => r.id === id) : undefined;
  if (history.ok && !run) notFound();

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <Link href="/fx" className="text-xs underline">
          Currency &amp; FX
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Restatement at {run?.asOfDate ?? "a reporting date"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Books kept in {working.data.functionalCurrency}. Monetary items restated at the
          closing rate; non-monetary items left at the rate they were first recognised at.
        </p>
      </header>

      {run && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Figure label="Exchange gain" value={labelled(run.gain, run.functionalCurrency)} />
          <Figure label="Exchange loss" value={labelled(run.loss, run.functionalCurrency)} />
          <Figure label="Net" value={labelled(run.net, run.functionalCurrency)} />
          <div className="rounded border p-3">
            <p className="text-xs text-muted-foreground">Items</p>
            <p className="text-lg font-semibold tabular-nums">
              {run.restatedCount} restated
            </p>
            <p className="text-xs text-muted-foreground">
              {run.skippedCount} not restated · listed below with reasons
            </p>
            <Badge variant={run.posted ? "secondary" : "outline"} className="mt-2 text-[10px]">
              {run.posted ? "posted" : "not posted"}
            </Badge>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">The working</CardTitle>
        </CardHeader>
        <CardContent>
          <RevaluationWorking
            functionalCurrency={working.data.functionalCurrency}
            lines={working.data.lines}
          />
        </CardContent>
      </Card>

      <PostRevaluation
        revaluationId={id}
        posted={run?.posted ?? false}
        unpostedReason={run?.unpostedReason ?? null}
        canRevalue={revalue.allowed}
      />
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
