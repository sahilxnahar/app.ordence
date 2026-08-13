/**
 * Ordence — ⭐⭐ MATTERS AND THE LIMITATION REPORT
 * Version: v1.7.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 "NO LIMITATION DATE" IS THE MOST DANGEROUS NUMBER ON THIS SCREEN
 * ══════════════════════════════════════════════════════════════════════
 * A matter with an expiry next week is at least *on* a list somebody
 * reads. A matter with no expiry at all will never appear on the report
 * that would have saved it, whatever the date — so it gets its own
 * counter, in red, ahead of everything else.
 *
 * ⚠️ AND EVERY DATE IS EVALUATED AGAINST TODAY ON EVERY RENDER. There is
 * no stored "days remaining" and no nightly sweep, because the morning
 * the job does not run is the morning a matter shows 40 days left on the
 * day it expires.
 */

import Link from "next/link";
import { getDiary, getMatters } from "@/server/actions/matters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Matters · Ordence" };

const TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "default",
  warn: "secondary",
  danger: "destructive",
  expired: "destructive",
  unknown: "destructive",
};

export default async function MattersPage() {
  const [matters, diary] = await Promise.all([getMatters(), getDiary(14)]);

  if (!matters.ok) {
    return (
      <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Matters</h1>
        <p className="text-sm text-destructive">{matters.error}</p>
      </main>
    );
  }

  const { rows, expired, within30, noLimitationDate, offDiary, today } = matters.data;
  const listed = diary.ok ? diary.data.rows : [];
  const live = rows.filter((r) => r.status !== "disposed" && r.status !== "closed");

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Matters</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 Section 3, stated first. It is why this screen exists at
           * all rather than a calendar entry.
           */}
          Under section 3 of the Limitation Act a suit filed out of time{" "}
          <em>must</em> be dismissed — the court raises it itself, even where
          the other side never pleads it. Every other deadline in Ordence costs
          money; this one ends a claim.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className={noLimitationDate > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              No limitation date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{noLimitationDate}</p>
            <p className="text-xs text-muted-foreground">
              {/* 🔴 These never appear on the report that would catch them. */}
              These will never show up on any deadline list, whatever the date.
              Record the cause-of-action date and the Article.
            </p>
          </CardContent>
        </Card>

        <Card className={expired > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Already time-barred
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{expired}</p>
            <p className="text-xs text-muted-foreground">
              Condonation under section 5 has to be applied for and proved. It is
              not automatic.
            </p>
          </CardContent>
        </Card>

        <Card className={within30 > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Expiring within 30 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{within30}</p>
            <p className="text-xs text-muted-foreground">
              Papers, court fee and vakalatnama ready <em>before</em> the date,
              not on it.
            </p>
          </CardContent>
        </Card>

        <Card className={offDiary > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Off the diary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{offDiary}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 The last hearing gave no next date and no disposal —
               * which is how a suit gets dismissed for non-appearance.
               */}
              The last hearing produced no next date and no disposal. Nobody is
              listed to attend these.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Listed in the next fortnight{" "}
            <span className="font-normal text-muted-foreground">({listed.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {listed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing listed. If that is wrong, the next dates from the last
              hearings were not recorded.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Matter</th>
                  <th className="py-2 pr-3 font-medium">Court</th>
                  <th className="py-2 pr-3 font-medium">For</th>
                  <th className="py-2 pr-3 font-medium">Appearing</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((h) => (
                  <tr key={h.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 tabular-nums font-medium">
                      {h.hearingDate}
                      {h.hearingDate === today && (
                        <Badge variant="destructive" className="ml-1">
                          today
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {h.matterNo}
                      <p className="text-xs text-muted-foreground">{h.title}</p>
                    </td>
                    <td className="py-2 pr-3">
                      {h.courtName ?? "—"}
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {h.caseNumber ?? ""}
                        {h.causeListItem ? ` · item ${h.causeListItem}` : ""}
                      </p>
                    </td>
                    <td className="py-2 pr-3">{h.purpose ?? "—"}</td>
                    <td className="py-2 pr-3">{h.appearedByName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Open matters, soonest first{" "}
            <span className="font-normal text-muted-foreground">({live.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {live.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open matters. Until there is one, the limitation report has
              nothing to watch.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Matter</th>
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium">Runs from</th>
                  <th className="py-2 pr-3 font-medium">Expires</th>
                  <th className="py-2 pr-3 font-medium">Next hearing</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {live.map((m) => (
                  <tr key={m.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/legal/matters/${m.id}`} className="underline">
                        {m.matterNo}
                      </Link>
                      <p className="text-xs text-muted-foreground">{m.title}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {m.courtName ?? ""} {m.caseNumber ?? ""}
                      </p>
                    </td>
                    <td className="py-2 pr-3">
                      {m.clientName ?? "—"}
                      <p className="text-xs text-muted-foreground">
                        {m.ourSide ?? m.matterType}
                      </p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-xs">
                      {m.causeOfActionDate ?? "—"}
                      <p className="text-muted-foreground">
                        {m.limitationCitation ?? "no article"}
                      </p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {m.limitationExpiresOn ?? "—"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {m.nextHearing ?? (
                        <span className="text-destructive">none listed</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={TONE[m.healthTone] ?? "outline"}>
                        {m.healthLabel}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/legal/client-account" className="underline">
          Client account
        </Link>{" "}
        ·{" "}
        <Link href="/time" className="underline">
          Time &amp; billing
        </Link>
      </p>
    </main>
  );
}
