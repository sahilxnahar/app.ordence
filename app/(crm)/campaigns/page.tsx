/**
 * Ordence — ⭐⭐⭐ CAMPAIGNS
 * Version: v1.15.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCREEN LEADS WITH WHO WAS LEFT OUT, NOT WITH WHO WAS SENT TO
 * ══════════════════════════════════════════════════════════════════════
 * "6,000 recipients · ₹6,540" is the number every marketing tool shows,
 * and it hides the only interesting fact: three thousand people were
 * dropped, and somebody should know why before pressing send rather than
 * a year later.
 */

import Link from "next/link";
import { getCampaigns } from "@/server/actions/campaigns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Campaigns · Ordence" };

const LIVE = new Set(["review", "approved", "sending"]);

export default async function CampaignsPage() {
  const result = await getCampaigns();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const campaigns = result.data;
  const live = campaigns.filter((c) => LIVE.has(c.status));

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="text-sm text-muted-foreground">
          Marketing sends, what they cost, and who was deliberately left out.
        </p>
      </div>

      {live.length > 0 && (
        <Card className="border-amber-500">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              In flight or waiting ({live.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {live.map((c) => (
              <p key={c.id}>
                <strong>{c.name}</strong> — {c.status}. {c.sent} of {c.included}{" "}
                sent.
                {c.status === "sending" && (
                  <>
                    {" "}
                    {/**
                     * 🔴 The stop is one click, deliberately. The moment
                     * somebody notices the wording is wrong is about
                     * ninety seconds into a send.
                     */}
                    <span className="text-destructive">
                      Stop it from the campaign if the wording is wrong; it takes
                      effect on the next message, not the next batch.
                    </span>
                  </>
                )}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {campaigns.length === 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">No campaigns yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              A campaign needs an approved marketing template and people who have
              agreed to marketing on WhatsApp. An enquiry is not that agreement.
            </p>
            <p>
              Check your{" "}
              <Link href="/messaging" className="underline">
                templates
              </Link>{" "}
              first.
            </p>
          </CardContent>
        </Card>
      ) : (
        campaigns.map((c) => (
          <Card key={c.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{c.name}</CardTitle>
                <Badge variant={c.status === "stopped" ? "destructive" : "secondary"}>
                  {c.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-4">
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    In the audience
                  </p>
                  <p className="text-lg font-semibold tabular-nums">{c.included}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">Sent</p>
                  <p className="text-lg font-semibold tabular-nums">{c.sent}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">Delivered</p>
                  <p className="text-lg font-semibold tabular-nums">{c.delivered}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">Cost</p>
                  <p className="text-lg font-semibold tabular-nums">{c.actualCost}</p>
                  {/**
                   * ⭐ Approved beside actual, because billing is on
                   * delivery: the two are never equal and the difference
                   * is the point.
                   */}
                  <p className="text-xs text-muted-foreground">
                    {c.approvedCost} approved
                  </p>
                </div>
              </div>

              {c.neverReached > 0 && (
                <p className="text-sm text-destructive">
                  {/**
                   * 🔴 A campaign that stopped halfway has told some
                   * customers about an offer and not the others.
                   */}
                  {c.neverReached} people in the approved audience were never
                  messaged. A campaign that reaches some of your customers and
                  not the rest is worse than one that was never sent.
                </p>
              )}

              {c.exclusions.length > 0 && (
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Left out ({c.excluded})
                  </p>
                  <ul className="mt-1 space-y-1">
                    {c.exclusions.map((e) => (
                      <li key={e.code} className="text-sm">
                        <span className="font-medium tabular-nums">{e.count}</span>{" "}
                        <span className="text-muted-foreground">
                          — {e.example}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How a campaign is checked</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            🔴 <strong>The audience is frozen when it is approved.</strong> It is
            a list of people, not a saved filter. Every other marketing tool
            re-runs the filter when the send starts, so somebody who enquired in
            the meantime receives a campaign nobody decided to send them, and the
            count that was approved is not the count that goes out.
          </p>
          <p>
            ⭐ <strong>The amount is typed, not ticked.</strong> This is the one
            action in Ordence that spends money it cannot get back. An amount
            somebody had to read and copy is an amount somebody read.
          </p>
          <p>
            ⚠️ <strong>Everybody left out is listed, with the reason.</strong> A
            list of 9,000 that quietly becomes 6,000 is how a firm spends a year
            not talking to a third of its customers.
          </p>
          <p>
            🔴 <strong>A withdrawal after approval still wins.</strong> The
            audience is frozen so nobody is added; somebody removing themselves
            is the opposite case, and consent is re-read for every message.
          </p>
          <p>
            ⚠️ <strong>A failed marketing message is not retried.</strong>{" "}
            WhatsApp quietly limits how many marketing messages a person
            receives, and trying again can block delivery to them for a further
            day. Once is once.
          </p>
          <p>
            ⭐ <strong>An enquiry is not consent to a campaign.</strong> Somebody
            who asked a question about a product agreed to be answered about it,
            and nothing more.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
