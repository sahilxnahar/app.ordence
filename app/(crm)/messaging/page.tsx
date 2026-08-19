/**
 * Ordence — ⭐⭐⭐ MESSAGING
 * Version: v1.14.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE NUMBER THIS SCREEN LEADS WITH IS NOT "MESSAGES SENT"
 * ══════════════════════════════════════════════════════════════════════
 * Every messaging product ever built leads with that, and it answers
 * nothing anybody asks. What an owner asks is: what did this cost me,
 * what did not get through, and what is about to stop working.
 */

import Link from "next/link";
import { getMessagingOverview } from "@/server/actions/messaging";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Messaging · Ordence" };

function inr(minor: string | null | undefined): string {
  if (!minor) return "₹0.00";
  const raw = String(minor);
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

export default async function MessagingPage() {
  const result = await getMessagingOverview();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Messaging</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { spend, templates, failures, pendingUnknown } = result.data;
  const blocked = templates.filter((t) => !t.maySend);
  const totalSpent = spend.reduce((a, s) => a + BigInt(s.spentMinor), 0n);
  const totalSaved = spend.reduce((a, s) => a + BigInt(s.savedMinor), 0n);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Messaging</h1>
        <p className="text-sm text-muted-foreground">
          What went out today, what it cost, and what did not reach anybody.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Spent today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totalSpent.toString())}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * 🔴 Billed on delivery, not on send. A message that never
               * arrived cost nothing.
               */}
              WhatsApp charges when a message is <strong>delivered</strong>, not
              when it is sent, so anything that did not arrive cost nothing.
            </p>
          </CardContent>
        </Card>

        <Card className={totalSaved > 0n ? "border-emerald-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Saved by the 24 hour window
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {inr(totalSaved.toString())}
            </p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐⭐ The only optimisation that actually saves money, and
               * no product tells anybody about it.
               */}
              A utility message sent while the customer is still in
              conversation with you is free. The same message an hour later is
              charged.
            </p>
          </CardContent>
        </Card>

        <Card className={pendingUnknown > 0 ? "border-amber-500" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              We do not know
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{pendingUnknown}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⚠️ The honest and uncomfortable number.
               */}
              Sent over an hour ago with no answer from WhatsApp either way.
              They are deliberately not retried: a retry may deliver a second
              copy of the same reminder.
            </p>
          </CardContent>
        </Card>
      </div>

      {blocked.length > 0 && (
        <Card className="border-destructive">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Templates that cannot be used ({blocked.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {blocked.map((t) => (
              <div key={t.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  <Badge variant="secondary">{t.category}</Badge>
                  <Badge variant="destructive">{t.status}</Badge>
                </div>
                <p className="mt-2 text-sm">{t.reason}</p>
                {t.actionRequired && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t.actionRequired}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Templates ({templates.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No templates yet. Nothing can be sent outside a 24 hour window
              without one.
            </p>
          ) : (
            templates.map((t) => (
              <div key={t.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">{t.language}</span>
                  <Badge variant="secondary">{t.category}</Badge>
                  {t.quality === "red" && <Badge variant="destructive">low quality</Badge>}
                </div>
                {/**
                 * ⚠️ META RE-CATEGORISES, AND THE PRICE FOLLOWS. Nothing
                 * else in the world tells the business this happened.
                 */}
                {t.drift && (
                  <p className="mt-2 text-sm text-amber-700">{t.drift}</p>
                )}
                {t.maySend && t.actionRequired && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t.actionRequired}
                  </p>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className={failures.length > 0 ? "border-destructive" : undefined}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Did not reach anybody ({failures.length})
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Including the ones Ordence itself refused to send, and why.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Everything that was attempted went out.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">To</th>
                  <th className="py-2 pr-3 font-medium">About</th>
                  <th className="py-2 pr-3 font-medium">What happened</th>
                  <th className="py-2 pr-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={f.id} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-3 tabular-nums">{f.toPhone ?? "—"}</td>
                    <td className="py-2 pr-3">{f.subjectType ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={f.status === "refused" ? "secondary" : "destructive"}>
                        {f.status}
                      </Badge>
                      <p className="mt-1 max-w-md text-xs">{f.errorMessage}</p>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-xs">
                      {new Date(f.queuedAt).toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata",
                      })}
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
          <CardTitle className="text-base">What decides the price</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            🔴 <strong>You are billed on delivery, not on send.</strong> A
            message to a number that no longer has WhatsApp costs nothing. So
            the figure above is what was actually charged, not what was
            attempted.
          </p>
          <p>
            ⭐ <strong>A utility message inside the 24 hour window is
            free.</strong> The window opens when the customer messages you and
            closes 24 hours later. Nothing about the message changes; only the
            clock. Sending the reminder while they are still in conversation is
            the one thing that reliably reduces this bill.
          </p>
          <p>
            ⭐ <strong>An ad click opens a 72 hour window in which everything
            is free</strong>, including marketing.
          </p>
          <p>
            ⚠️ <strong>Meta decides the category, not you.</strong> A template
            written as a utility message that reads like an advertisement gets
            moved to marketing, and the same send costs roughly seven times
            more. Any template that has been re-categorised is flagged above.
          </p>
          <p>
            ⚠️ <strong>A paused template is not a failed one.</strong> Meta
            pauses on complaints for three hours, then six, then permanently.
            Ordence does not retry into a pause, because the third one cannot
            be undone.
          </p>
          <p>
            🔴 <strong>The daily ceiling is enforced by the database</strong>,
            not by the code that sends. Set it on{" "}
            <Link href="/settings/connections" className="underline">
              the connection
            </Link>
            . A bug in a loop spends real money at about ₹1 a message.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
