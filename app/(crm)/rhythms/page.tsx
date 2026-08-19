/**
 * Ordence — ⭐⭐⭐ WHO TO RING TODAY
 * Version: v1.16.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ THE FEATURE THE OWNER ASKED FOR, AND THE HALF THEY DID NOT
 * ══════════════════════════════════════════════════════════════════════
 * "Notify me that this customer is likely to order today" is the top of
 * this screen.
 *
 * 🔴 The customer who has STOPPED is above it, because nothing else in
 * an ERP reports an absence. Sales reports show what happened; they
 * cannot show what did not.
 */

import Link from "next/link";
import { getRhythmBoard } from "@/server/actions/rhythms";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Order rhythm · Ordence" };

const KIND_LABEL: Record<string, string> = {
  lapsed: "has stopped",
  overdue: "late",
  due_now: "due now",
  due_soon: "due soon",
};

export default async function RhythmsPage() {
  const result = await getRhythmBoard();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Order rhythm</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { signals, rhythms, scoreboard, computedAt } = result.data;
  const lapsed = signals.filter((s) => s.kind === "lapsed");
  const due = signals.filter((s) => s.kind !== "lapsed");

  const byVerdict = rhythms.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Order rhythm</h1>
        <p className="text-sm text-muted-foreground">
          Which customers are about to order, and which have quietly stopped.
          {computedAt && (
            <>
              {" "}
              Worked out{" "}
              {new Date(computedAt).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
              })}
              .
            </>
          )}
        </p>
      </div>

      {/**
       * 🔴🔴 THE MOST VALUABLE LIST ON THE SCREEN, AND IT IS FIRST.
       */}
      <Card className={lapsed.length > 0 ? "border-destructive" : undefined}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Customers who have stopped ({lapsed.length})
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Each of these had a regular pattern and is now more than three times
            their own gap without ordering. Nothing else in an ERP reports this,
            because a sales report can only show what happened.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {lapsed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody with a regular pattern has gone quiet.
            </p>
          ) : (
            lapsed.map((s) => (
              <div key={s.id} className="rounded border p-3">
                <p className="text-sm font-medium">{s.headline}</p>
                <p className="mt-1 text-sm text-muted-foreground">{s.detail}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Likely to order ({due.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {due.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody is due within their usual window today.
            </p>
          ) : (
            due.map((s) => (
              <div key={s.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.headline}</span>
                  <Badge variant="secondary">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {s.confidence}% confident
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{s.detail}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/**
       * ⭐⭐ A PREDICTION FEATURE NOBODY SCORES IS ASTROLOGY.
       */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">How these predictions have done</CardTitle>
        </CardHeader>
        <CardContent>
          {scoreboard.accuracy === null ? (
            <p className="text-sm text-muted-foreground">
              Nothing scored yet. When one of these customers orders, or does
              not, mark the card. Until then this feature is asking you to trust
              it on nothing, and you should not.
            </p>
          ) : (
            <p className="text-sm">
              <strong className="tabular-nums">{scoreboard.accuracy}%</strong> of{" "}
              {scoreboard.scored} scored predictions were followed by an order.
              {scoreboard.accuracy < 50 && (
                <span className="text-destructive">
                  {" "}
                  That is worse than useful. The patterns here are not strong
                  enough to act on, and it is better to know that.
                </span>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            What Ordence will not predict ({rhythms.length} customers looked at)
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 The refusals are shown, not hidden. A screen showing
             * only the confident rows makes a business look like it has
             * forty customers when it has four hundred.
             */}
            Most customers do not have a pattern, and saying so is the honest
            answer. A list that predicts for everybody gets four polite refusals
            in a row and then nobody opens it again.
          </p>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <strong className="tabular-nums">{byVerdict.regular ?? 0}</strong> have
            a usable rhythm.
          </p>
          <p>
            <strong className="tabular-nums">{byVerdict.irregular ?? 0}</strong>{" "}
            order often enough but at gaps too uneven to call. They probably
            order when they run out rather than to a schedule.
          </p>
          <p>
            <strong className="tabular-nums">
              {byVerdict.too_few_orders ?? 0}
            </strong>{" "}
            have not ordered enough times yet. Four orders is the first point at
            which a typical gap means anything.
          </p>
          <p>
            <strong className="tabular-nums">{byVerdict.one_off ?? 0}</strong>{" "}
            bought once and never came back, which is worth a call in itself.
          </p>
          <p>
            <strong className="tabular-nums">{byVerdict.lapsed ?? 0}</strong> had a
            rhythm and have stopped.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How this works, in full</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            ⭐ <strong>The typical gap is a median, not an average.</strong> One
            bulk order before a price rise, or one gap over a factory shutdown,
            would drag an average far enough to make every prediction wrong.
          </p>
          <p>
            ⚠️ <strong>Four orders minimum.</strong> Two orders is one gap, and
            one gap is a coincidence rather than a pattern. Three orders is two
            gaps, and the middle of two numbers is just their average again.
          </p>
          <p>
            🔴 <strong>If the gaps swing by more than half the typical gap,
            Ordence says so and predicts nothing.</strong> A customer ordering
            every 30 days give or take 5 is predictable. Give or take 20, they
            are not, and pretending otherwise produces a call list of guesses.
          </p>
          <p>
            ⭐ <strong>&quot;Stopped&quot; is measured against their own
            gap, not the calendar.</strong> Ninety days is far too patient for a
            weekly customer and far too twitchy for a quarterly one. Three times
            their own rhythm is the only sensible measure of late.
          </p>
          <p>
            ⚠️ <strong>Customers whose gaps are getting longer are flagged even
            when they are never late.</strong> Somebody who has drifted from 30
            days to 45 over a year is leaving slowly, and they never appear on an
            overdue report because each order is on time against a rhythm that is
            itself decaying.
          </p>
          <p>
            Each of these becomes a{" "}
            <Link href="/tasks" className="underline">
              task
            </Link>{" "}
            with today&apos;s date on it, once — not every night.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
