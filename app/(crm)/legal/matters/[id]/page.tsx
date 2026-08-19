/**
 * Ordence — ⭐ One matter
 * Version: v1.7.0-alpha
 *
 * ⚠️ THE LIMITATION WORKINGS ARE SHOWN, NOT JUST THE DATE. "Expires
 * 3 April 2026" is a number somebody has to take on trust. "Article 55
 * runs from when the contract was broken, here 3 April 2023; section
 * 12(1) excludes that day, so the period runs from the 4th; three years
 * from there expires on 3 April 2026" is a file note a partner can check
 * against the brief.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMatterDetail } from "@/server/actions/matters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

function inr(minorUnits: string | null): string {
  if (minorUnits === null) return "—";
  const digits = String(minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2) || "0";
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `₹${grouped}.${frac}`;
}

const TONE_CLASS: Record<string, string> = {
  ok: "border-emerald-500 bg-emerald-50",
  warn: "border-amber-500 bg-amber-50",
  danger: "border-destructive bg-red-50",
  expired: "border-destructive bg-red-50",
  unknown: "border-destructive bg-red-50",
};

export default async function MatterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getMatterDetail(id);
  if (!result.ok) notFound();

  const { matter, hearings, events } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/legal/matters" className="underline">
            Matters
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{matter.matterNo}</h1>
        <p className="text-sm text-muted-foreground">{matter.title}</p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {matter.clientName ?? "—"}
          {matter.ourSide ? ` · ${matter.ourSide}` : ""}
          {matter.courtName ? ` · ${matter.courtName}` : ""}
          {matter.caseNumber ? ` · ${matter.caseNumber}` : ""}
        </p>
      </div>

      {/**
       * 🔴 THE DEADLINE FIRST, WITH ITS WORKINGS. It is the one fact on
       * this page that can end the client's claim.
       */}
      <div className={`rounded border-l-4 p-4 ${TONE_CLASS[matter.healthTone] ?? ""}`}>
        <p className="font-semibold">
          {matter.healthLabel}
          {matter.limitationExpiresOn ? ` · ${matter.limitationExpiresOn}` : ""}
        </p>
        <p className="mt-1 text-sm">{matter.healthDetail}</p>
        {matter.limitationNote && (
          <p className="mt-2 text-xs text-muted-foreground">{matter.limitationNote}</p>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Hearings{" "}
            <span className="font-normal text-muted-foreground">({hearings.length})</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 A hearing that happened and gave nothing back is how a
             * suit gets dismissed for default of appearance.
             */}
            Every hearing that was held has to produce either the next date or a
            disposal. A matter with neither is a matter nobody is listed to
            attend.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {hearings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hearings recorded yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">For</th>
                  <th className="py-2 pr-3 font-medium">Before</th>
                  <th className="py-2 pr-3 font-medium">What happened</th>
                  <th className="py-2 pr-3 font-medium">Next</th>
                </tr>
              </thead>
              <tbody>
                {hearings.map((h) => (
                  <tr key={h.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 tabular-nums">{h.hearingDate}</td>
                    <td className="py-2 pr-3">{h.purpose ?? "—"}</td>
                    <td className="py-2 pr-3">{h.beforeJudge ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={h.disposed ? "default" : "outline"}>
                        {h.status.replace("_", " ")}
                      </Badge>
                      {h.adjournedReason && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {h.adjournedReason}
                        </p>
                      )}
                      {h.outcome && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {h.outcome}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {h.disposed ? (
                        <Badge variant="default">disposed</Badge>
                      ) : h.nextDate ? (
                        h.nextDate
                      ) : (
                        <Badge variant="destructive">off the diary</Badge>
                      )}
                    </td>
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
            Events{" "}
            <span className="font-normal text-muted-foreground">({events.length})</span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 The trap, stated. The same letter two days later gives
             * nothing, and the two look identical on a file.
             */}
            An acknowledgement in writing or a part payment starts a fresh period
            under sections 18 and 19 — but only if it was made <em>before</em>{" "}
            the period expired. Afterwards it is evidence of a moral obligation
            and of nothing else.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">What</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 pr-3 font-medium">Effect on limitation</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.eventDate}-${i}`} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 tabular-nums">{e.eventDate}</td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">
                        {e.eventType.replace(/_/g, " ")}
                      </span>
                      <p className="text-xs text-muted-foreground">{e.description}</p>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {inr(e.amountMinor)}
                    </td>
                    <td className="py-2 pr-3">
                      {e.resetsLimitation ? (
                        <>
                          <Badge variant="default">extended</Badge>
                          <p className="mt-1 text-xs tabular-nums">
                            {e.previousExpiry} → {e.newExpiry}
                          </p>
                        </>
                      ) : (
                        <Badge variant="outline">no effect</Badge>
                      )}
                      {e.resetNote && (
                        <p className="mt-1 max-w-md text-xs text-muted-foreground">
                          {e.resetNote}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
