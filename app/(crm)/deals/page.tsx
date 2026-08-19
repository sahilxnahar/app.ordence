/**
 * Ordence — THE PIPELINE (labelled "Engagements" in the legal vertical)
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE ROUTE, TWO WORDS FOR THE SAME OBJECT
 * ══════════════════════════════════════════════════════════════════════
 * The module registry lists `deals` and `engagements` at this same href.
 * They are not two features. A property developer calls it a deal; a
 * chambers calls the identical row an engagement, and would find a
 * screen headed "Deals" faintly insulting. The vocabulary is the only
 * difference, so the vocabulary is the only thing that switches.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PAGE LEADS WITH THE REASON THE FORECAST IS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * A pipeline screen that opens with "₹4.2 crore in play" is a screen
 * that gets quoted in a board pack and never questioned. Everything
 * below is ordered by how much of that number it invalidates:
 *
 *   1. MIXED CURRENCIES — if there are two, the headline total is a sum
 *      of unlike things and has no unit at all. It is first because it
 *      makes every other figure on the page meaningless, and because
 *      nothing in the schema prevents it.
 *   2. PAST THEIR OWN CLOSE DATE — still counted, in a month that ended.
 *   3. STALLED — no movement in a month. Present in the total, absent
 *      from anybody's week.
 *   4. UNPRICED / OWNERLESS / CONTRADICTORY — each one a row that looks
 *      complete and contributes nothing true.
 *
 * ⚠️ ONLY THEN THE BOARD. A stage-by-stage summary is what people came
 * for; it is not what they needed to see first.
 */

import { Suspense } from "react";
import Link from "next/link";
import { listDealPipeline, type DealRow } from "@/server/actions/deals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Pipeline · Ordence" };

/**
 * Integer paise → Indian-grouped rupees.
 *
 * ⚠️ Takes a STRING and never converts it to a `number` on the way. The
 * whole point of carrying paise as a decimal string is lost the moment
 * somebody calls `Number()` on ₹12,34,56,789.01.
 */
function inr(minorUnits: string | null | undefined): string {
  if (!minorUnits) return "₹0.00";
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}

const STAGE_LABEL: Record<string, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

function stageTone(stage: string): string {
  if (stage === "won")
    return "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300";
  if (stage === "lost") return "text-muted-foreground";
  if (stage === "negotiation")
    return "border-blue-400 text-blue-700 dark:border-blue-700 dark:text-blue-300";
  return "";
}

function counterparty(d: DealRow): string {
  return d.companyName ?? d.contactName ?? "—";
}

async function PipelineBody({ engagements }: { engagements: boolean }) {
  const result = await listDealPipeline();

  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {engagements ? "Engagements" : "Pipeline"} unavailable
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{result.error}</p>
        </CardContent>
      </Card>
    );
  }

  const {
    deals,
    overdue,
    stalled,
    unpriced,
    ownerless,
    conflicted,
    byStage,
    openValueMinor,
    weightedValueMinor,
    currencies,
    overdueValueMinor,
  } = result.data;

  const noun = engagements ? "engagement" : "deal";
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
  const mixedCurrency = currencies.length > 1;

  return (
    <div className="space-y-6">
      {/* ── 1 · MIXED CURRENCIES. Every total below is a sum of unlike
             things. Nothing in the schema prevents this. ─────────────── */}
      {mixedCurrency && (
        <Card className="border-red-400 dark:border-red-700">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">
              This pipeline holds {currencies.length} currencies — every total
              on this page is a sum of unlike things
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="flex flex-wrap gap-2">
              {currencies.map((c) => (
                <li key={c}>
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {c}
                    <span className="ml-1.5 text-muted-foreground">
                      {open.filter((d) => d.currency === c).length} open
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              ⚠️ Each {noun} carries its own currency beside its amount, and
              nothing in the database stops one workspace holding both. The
              figures below add the numbers and ignore the units, which is
              what every spreadsheet built from this data will also do. Until
              a conversion rate is recorded against a date, the only honest
              reading of the headline is &ldquo;a number&rdquo;.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 2 · PAST THEIR OWN CLOSE DATE. Counted in a month that ended. */}
      {overdue.length > 0 && (
        <Card className="border-amber-400 dark:border-amber-700">
          <CardHeader>
            <CardTitle className="text-amber-700 dark:text-amber-300">
              {overdue.length} open {noun}
              {overdue.length === 1 ? "" : "s"} past their own close date —{" "}
              {inr(overdueValueMinor)} of the forecast
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {overdue.slice(0, 12).map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{d.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {counterparty(d)}
                  </span>
                  <span className="tabular-nums text-amber-700 dark:text-amber-300">
                    {d.daysPastClose}d past {d.expectedCloseDate}
                  </span>
                  <span className="tabular-nums">{inr(d.amountMinor)}</span>
                  <Badge variant="outline" className={stageTone(d.stage)}>
                    {STAGE_LABEL[d.stage] ?? d.stage}
                  </Badge>
                </li>
              ))}
            </ul>
            {overdue.length > 12 && (
              <p className="text-xs text-muted-foreground">
                …and {overdue.length - 12} more in the register below.
              </p>
            )}
            <p className="text-muted-foreground">
              The close date is what put this money into a particular month.
              That month has ended and the money is still counted in it, so
              every quarter it survives, it inflates the current one. Nothing
              moves a {noun} out of the forecast on its own — a date is not a
              deadline the database enforces.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 3 · STALLED. In the total, absent from anybody's week. ──── */}
      {stalled.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-blue-700 dark:text-blue-300">
              {stalled.length} open {noun}
              {stalled.length === 1 ? " has" : "s have"} not changed in a month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {stalled.slice(0, 10).map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{d.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {d.ownerName ?? "nobody"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {d.daysSinceUpdate}d quiet
                  </span>
                  <span className="tabular-nums">{inr(d.amountMinor)}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Silence is not a stage. A {noun} nobody has touched in thirty
              days is still contributing its full weighted value to the
              forecast while contributing nothing to anybody&apos;s week — and
              it is the row most likely to be lost without ever being marked
              lost, which is what makes the win rate look better than it is.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 4 · The numbers. ──────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={mixedCurrency ? "border-red-300 dark:border-red-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Open pipeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(openValueMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {mixedCurrency
                ? `⚠️ ${currencies.join(" + ")} added together.`
                : `${open.length} open ${noun}${open.length === 1 ? "" : "s"} in ${currencies[0] ?? "INR"}.`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Weighted forecast
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(weightedValueMinor)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Each amount times its own probability — which is typed, not
              derived from the stage.
            </p>
          </CardContent>
        </Card>

        {/* ⭐ Unpriced deals: fully present in every count, worth nothing
            in every total. The gap between the two is the point. */}
        <Card className={unpriced.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Carrying no amount
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {unpriced.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {open.length} open. Counted in the pipeline, worth zero in
              every total above.
            </p>
          </CardContent>
        </Card>

        <Card className={ownerless.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Nobody assigned
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {ownerless.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {conflicted.length} {noun}
              {conflicted.length === 1 ? "" : "s"} whose stage and probability
              disagree.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── 5 · Stage and probability contradicting each other. ────── */}
      {conflicted.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Stage and probability disagree
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="space-y-1">
              {conflicted.slice(0, 10).map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-3">
                  <span className="font-medium">{d.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {d.probabilityConflict}
                  </span>
                  <span className="ml-auto tabular-nums">
                    {inr(d.weightedMinor)} weighted
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Neither field is derived from the other, so both can be right
              about different things at once. A won {noun} at 40% under-states
              the forecast by the other 60%; a lost one above 0% keeps money in
              it that has already gone.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── 6 · The board. ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>By stage</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Stage</th>
                  <th className="px-4 py-2 text-right font-medium">Count</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 text-right font-medium">Weighted</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {byStage.map((s) => (
                  <tr
                    key={s.stage}
                    className={s.count === 0 ? "opacity-50" : "hover:bg-muted/40"}
                  >
                    <td className="px-4 py-2">
                      <Badge variant="outline" className={stageTone(s.stage)}>
                        {STAGE_LABEL[s.stage] ?? s.stage}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.count}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {inr(s.valueMinor)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {inr(s.weightedMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ── 7 · The register. ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{engagements ? "Engagements" : "Deals"}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {deals.length === 0 ? (
            <div className="space-y-3 px-6 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                Nothing in the pipeline yet.
              </p>
              <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                {engagements
                  ? "An engagement is a piece of work you expect to be instructed on: a named client, a fee you expect to bill, the date you expect it to be signed, and how likely you think that is. It is recorded from the first conversation — including the ones that never become an instruction, because the reason a client went elsewhere is the only thing that changes what you quote the next one."
                  : "A deal is money you expect to receive but have not yet: a counterparty, an amount, the date you expect it to close, and how likely you think that is. It is recorded from the first conversation — including the ones that never close, because a lost deal with a reason against it is worth more next quarter than a won one with nothing."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">
                      {engagements ? "Engagement" : "Deal"}
                    </th>
                    <th className="px-4 py-2 font-medium">Counterparty</th>
                    <th className="px-4 py-2 font-medium">Stage</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-right font-medium">Prob.</th>
                    <th className="px-4 py-2 font-medium">Expected close</th>
                    <th className="px-4 py-2 font-medium">Owner</th>
                    <th className="px-4 py-2 text-right font-medium">Quiet</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {deals.slice(0, 300).map((d) => {
                    const isOverdue =
                      d.stage !== "won" &&
                      d.stage !== "lost" &&
                      d.daysPastClose !== null &&
                      d.daysPastClose > 0;
                    return (
                      <tr
                        key={d.id}
                        className={
                          isOverdue
                            ? "bg-amber-50/60 hover:bg-amber-50 dark:bg-amber-950/20"
                            : "hover:bg-muted/40"
                        }
                      >
                        <td className="px-4 py-2 font-medium">
                          {d.title}
                          {d.lostReason && (
                            <div className="text-xs font-normal text-muted-foreground">
                              lost — {d.lostReason}
                            </div>
                          )}
                          {d.source && !d.lostReason && (
                            <div className="text-xs font-normal text-muted-foreground">
                              via {d.source}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs">{counterparty(d)}</td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className={stageTone(d.stage)}>
                            {STAGE_LABEL[d.stage] ?? d.stage}
                          </Badge>
                        </td>
                        {/* ⭐ "No amount" and "₹0.00" are different facts and
                            are shown differently. One is a decision. */}
                        <td className="px-4 py-2 text-right tabular-nums">
                          {d.hasAmount ? (
                            <>
                              {inr(d.amountMinor)}
                              {mixedCurrency && (
                                <div className="text-[10px] text-muted-foreground">
                                  {d.currency}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-amber-700 dark:text-amber-300">
                              not priced
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {d.probability}%
                          {d.probabilityConflict && (
                            <div className="text-[10px] text-amber-700 dark:text-amber-300">
                              conflicts
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-xs">
                          {d.expectedCloseDate ?? (
                            <span className="text-muted-foreground">
                              no date
                            </span>
                          )}
                          {isOverdue && (
                            <div className="text-[10px] text-amber-700 dark:text-amber-300">
                              {d.daysPastClose}d past
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {d.ownerName ?? (
                            <span className="text-amber-700 dark:text-amber-300">
                              unassigned
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          {d.daysSinceUpdate}d
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Amounts are stored as exact decimals and summed as integer paise —
        never as floating point — so a hundred {noun}s of ₹19.99 total ₹1,999.00
        here and not ₹1,998.9999999. Probability is a typed field, not a
        function of the stage: the two can disagree, and where they do it is
        listed above rather than quietly reconciled. This screen writes
        nothing.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted/40" />
        ))}
      </div>
      <div className="h-96 animate-pulse rounded-lg border bg-muted/40" />
    </div>
  );
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  /**
   * ⭐ `?as=engagements` switches the vocabulary and nothing else.
   *
   * ⚠️ Not a second route and not a second component. Two copies of this
   * page would drift within a month, and the vertical that got the stale
   * copy would be the one that never noticed.
   */
  const params = await searchParams;
  const engagements = params.as === "engagements";

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {engagements ? "Engagements" : "Deals"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {engagements
              ? "What you expect to be instructed on, what it is worth, and which of it has gone quiet."
              : "What you expect to close, what it is worth, and which of it is no longer true."}
          </p>
        </div>
        <Link
          href={engagements ? "/deals" : "/deals?as=engagements"}
          className="text-sm text-muted-foreground hover:underline"
        >
          {engagements ? "Deal vocabulary" : "Engagement vocabulary"}
        </Link>
      </header>

      <Suspense fallback={<Skeleton />}>
        <PipelineBody engagements={engagements} />
      </Suspense>
    </div>
  );
}
