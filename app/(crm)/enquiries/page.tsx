/**
 * Ordence — ⭐⭐⭐ ENQUIRIES
 * Version: v1.13.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE ONES THAT ARRIVED, AND THE ONES THAT NEARLY DID
 * ══════════════════════════════════════════════════════════════════════
 * A lead that filed cleanly is in the pipeline, where it belongs, with a
 * task against it and a time on that task. It does not need a screen.
 *
 * ⚠️ WHAT HAS NOWHERE ELSE TO LIVE IS THE ENQUIRY THAT COULD NOT BE
 * FILED. The customer paid for that one exactly as much as the others:
 * IndiaMART charges for the subscription that produced it, Meta charged
 * for the click. Without this page it is money spent and thrown away,
 * and nobody ever finds out.
 */

import Link from "next/link";
import { getArrivedLeads, getEnquiryIntake } from "@/server/actions/enquiries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Enquiries · Ordence" };

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

export default async function EnquiriesPage() {
  const [intake, arrived] = await Promise.all([
    getEnquiryIntake(),
    getArrivedLeads(),
  ]);

  if (!intake.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Enquiries</h1>
        <p className="text-sm text-destructive">{intake.error}</p>
      </main>
    );
  }

  const {
    failures,
    openFailureCount,
    arrivedToday,
    arrivedThisWeek,
    lastArrivalAt,
    quietConnections,
  } = intake.data;

  const leads = arrived.ok ? arrived.data : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Enquiries</h1>
        <p className="text-sm text-muted-foreground">
          What arrived on its own from{" "}
          <Link href="/settings/connections" className="underline">
            your connected accounts
          </Link>
          , and anything that could not be filed.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={openFailureCount > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Could not be filed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{openFailureCount}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 The sentence that says why this number is first.
               */}
              You paid for these enquiries too. Each one can still be filed by
              hand from the provider&apos;s own panel.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Arrived today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{arrivedToday}</p>
            <p className="text-xs text-muted-foreground">
              {arrivedThisWeek} this week. Last one {when(lastArrivalAt)}.
            </p>
          </CardContent>
        </Card>

        <Card className={quietConnections.length > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Working but silent
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {quietConnections.length}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐⭐ THE FAILURE NOTHING ELSE REPORTS. Every run
               * succeeded, the state says connected, and no enquiry has
               * arrived for a week.
               */}
              {quietConnections.length === 0
                ? "Every connected account has brought something this week."
                : `${quietConnections.join(", ")} — connected, every check succeeded, and nothing has come through for seven days. Usually a filter or a subscription changed at their end.`}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className={openFailureCount > 0 ? "border-destructive" : undefined}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Enquiries that need a person{" "}
            <span className="font-normal text-muted-foreground">
              ({failures.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * ⚠️ Every row says what to DO, not what category it is in.
             */}
            Each of these arrived and could not be turned into a lead
            automatically. The reason says what to do about it.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing outstanding. Every enquiry that arrived was filed.
            </p>
          ) : (
            failures.map((f) => (
              <div key={f.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{f.connectorLabel}</Badge>
                  <span className="text-sm font-medium">{f.connectionName}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {when(f.occurredAt)}
                  </span>
                  {f.externalId && (
                    <code className="rounded bg-muted px-1 text-xs">
                      {f.externalId}
                    </code>
                  )}
                </div>
                <p className="mt-2 text-sm">{f.reason}</p>
                <p className="mt-1 text-sm text-muted-foreground">{f.whatToDo}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Filed automatically{" "}
            <span className="font-normal text-muted-foreground">
              ({leads.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Each of these already has a call task against it with a time on it.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {leads.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has arrived automatically yet. Connect an account to start.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Reference</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">About</th>
                  <th className="py-2 pr-3 font-medium">From</th>
                  <th className="py-2 pr-3 font-medium">Arrived</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      {/*
                        ⭐ WAVE 10 — THIS POINTED AT `/leads/:id`, WHICH
                        HAS NEVER EXISTED. The lead detail screen lives at
                        `/sales/leads/:id` and always has; the enquiries
                        table was written against a route that was planned
                        and then built somewhere else, and every reference
                        number in this list 404'd.
                      */}
                      <Link href={`/sales/leads/${l.id}`} className="underline">
                        {l.reference}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">
                      {l.name}
                      {l.phone && (
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {l.phone}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-3">{l.interestLabel ?? "—"}</td>
                    <td className="py-2 pr-3">{l.connectorLabel}</td>
                    <td className="py-2 pr-3 tabular-nums">{when(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Why the first hour matters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            🔴 A buyer who sends an IndiaMART enquiry has almost always sent the
            same enquiry to four other sellers in the same minute. The platform
            encourages exactly that. The seller who rings first usually gets the
            order, and the gap that decides it is measured in minutes.
          </p>
          <p>
            ⭐ <strong>So every arriving enquiry becomes a task with a time on
            it</strong>, not a row in a list. A lead in a list nobody opens is a
            lead nobody rings.
          </p>
          <p>
            ⚠️ <strong>A missed call gets a quarter of that time.</strong>{" "}
            Somebody who actually rang and did not get through has already tried
            hardest, and is the enquiry most likely to be gone by tomorrow.
          </p>
          <p>
            ⚠️ <strong>The same enquiry arriving twice lands once.</strong>{" "}
            IndiaMART pushes a lead the moment it happens and also answers for
            it on the pull, and retries until we accept it, so every enquiry
            reaches us more than once by design.
          </p>
          <p>
            ⭐ <strong>But the same person enquiring again is a new lead</strong>,
            and it is shown as a possible duplicate rather than refused. A
            genuine second enquiry six months later is real business, and
            refusing it teaches people to type fake numbers.
          </p>
          <p>
            🔴 <strong>An enquiry is not consent to a marketing list.</strong>{" "}
            They asked to be contacted about the thing they asked about, and
            that is what is recorded. Nothing here may be used as agreement to a
            campaign.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
