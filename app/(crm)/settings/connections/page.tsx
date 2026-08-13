/**
 * Ordence — ⭐⭐⭐ CONNECTIONS
 * Version: v1.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS NOT `/settings/integrations`, AND THE DIFFERENCE MATTERS
 * ══════════════════════════════════════════════════════════════════════
 * That page shows what ORDENCE is configured with: our Resend key, our
 * Razorpay account, read from environment variables and identical for
 * every tenant.
 *
 * ⭐ THIS PAGE IS THE CUSTOMER'S OWN ACCOUNTS: their IndiaMART seller
 * panel, their Meta page, their WhatsApp number. Different owner,
 * different credentials, different failure.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND THE POINT OF THE SCREEN IS THE BAD DAY
 * ══════════════════════════════════════════════════════════════════════
 * On a good day nobody opens it. It is opened on the morning the
 * enquiries stopped, and everything on it is arranged for that morning:
 * what broke, when it last worked, what we are doing about it, and
 * whether anybody needs to do anything.
 *
 * ⚠️ NOT ONE FIELD ON THIS PAGE SHOWS A CREDENTIAL. The server action
 * cannot return one.
 */

import Link from "next/link";
import { getConnections } from "@/server/actions/connections";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Connections · Ordence" };

function ago(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function stateTone(state: string): "default" | "secondary" | "destructive" {
  if (state === "connected") return "default";
  if (state === "paused") return "secondary";
  return "destructive";
}

export default async function ConnectionsPage() {
  const result = await getConnections();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { cards, available, vaultReady, vaultMessage } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Your own accounts on other systems. Ordence&apos;s own configuration
          is on the{" "}
          <Link href="/settings/integrations" className="underline">
            Integrations
          </Link>{" "}
          tab, which is a different thing.
        </p>
      </div>

      {/**
       * 🔴 THE VAULT WARNING COMES FIRST AND IS NOT DISMISSIBLE.
       *
       * ⚠️ Without the key nothing can be saved, and the worst possible
       * version of that is a person typing an API key into a form that
       * then refuses it. A key typed into a browser is a key in an
       * autofill store.
       */}
      {!vaultReady && (
        <Card className="border-destructive">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">
              Credentials cannot be stored yet
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{vaultMessage}</p>
            <p className="text-muted-foreground">
              Nothing is saved in the clear as a fallback. The encryption key
              lives outside the database on purpose, so that a database backup
              on its own decrypts nothing.
            </p>
          </CardContent>
        </Card>
      )}

      {cards.length === 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Nothing connected yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Connect a lead source and enquiries arrive in the pipeline
              automatically instead of being typed in from a phone.
            </p>
            <ul className="space-y-3">
              {available.map((a) => (
                <li key={a.key}>
                  <span className="font-medium text-foreground">{a.label}</span>
                  {!a.selfService && (
                    <Badge variant="secondary" className="ml-2">
                      needs their account manager
                    </Badge>
                  )}
                  <p className="mt-1 max-w-2xl">{a.setupNote}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : (
        cards.map((c) => (
          <Card
            key={c.id}
            className={
              c.health.tone === "danger" || c.state === "revoked"
                ? "border-destructive"
                : undefined
            }
          >
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{c.name}</CardTitle>
                <Badge variant="secondary">{c.label}</Badge>
                <Badge variant={stateTone(c.state)}>{c.state}</Badge>
                {c.transport === "push" && (
                  <Badge variant="secondary">they send to us</Badge>
                )}
              </div>
              {/**
               * 🔴 THE REASON, ON THE SCREEN THEY ARE ALREADY LOOKING AT.
               *
               * ⚠️ "Degraded" with no reason is the support call this
               * whole feature exists to prevent, which is why 0064
               * refuses to record an unhealthy state without one.
               */}
              {c.stateReason && (
                <p className="text-sm text-destructive">{c.stateReason}</p>
              )}
            </CardHeader>

            <CardContent className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Last worked
                  </p>
                  <p className="tabular-nums">{ago(c.lastSuccessAt)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Last tried
                  </p>
                  <p className="tabular-nums">{ago(c.lastAttemptAt)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Checking
                  </p>
                  <p>
                    {c.intervalSeconds === 0
                      ? "nothing to check, they send to us"
                      : `every ${Math.round(c.intervalSeconds / 60)} minutes`}
                  </p>
                </div>
              </div>

              <div>
                <p className="font-medium">{c.health.headline}</p>
                <p className="text-muted-foreground">{c.health.detail}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.nextFetchNote}
                </p>
              </div>

              {/**
               * ⚠️ NAMES ONLY. The vault holds the values and nothing on
               * this path so much as loads a ciphertext.
               */}
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Credentials
                </p>
                {c.missingSecrets.length > 0 ? (
                  <p className="text-destructive">
                    Missing: {c.missingSecrets.join(", ")}. Nothing will be
                    fetched until these are entered.
                  </p>
                ) : c.storedSecrets.length === 0 ? (
                  <p className="text-muted-foreground">
                    This connector needs none.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Stored: {c.storedSecrets.join(", ")}. Ordence does not show
                    a stored key back to anyone, including you. Enter a new one
                    to replace it.
                  </p>
                )}
              </div>

              {c.webhookPath && (
                <div>
                  <p className="text-xs uppercase text-muted-foreground">
                    Their delivery address
                  </p>
                  <code className="block break-all rounded bg-muted px-2 py-1 text-xs">
                    {c.webhookPath}
                  </code>
                  {!c.selfService && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.setupNote}
                    </p>
                  )}
                </div>
              )}

              {/**
               * ⭐⭐ THREE COUNTS, NOT ONE.
               *
               * 🔴 "Fetched 40" answers nothing. Forty seen, forty
               * repeats and nothing new is a healthy quiet day. Forty
               * seen and forty new every single time is the same
               * enquiries arriving over and over.
               */}
              {c.recentRuns.length > 0 && (
                <div className="overflow-x-auto">
                  <p className="mb-1 text-xs uppercase text-muted-foreground">
                    Recent checks
                  </p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1 pr-3 font-medium">When</th>
                        <th className="py-1 pr-3 font-medium">Result</th>
                        <th className="py-1 pr-3 text-right font-medium">Seen</th>
                        <th className="py-1 pr-3 text-right font-medium">New</th>
                        <th className="py-1 pr-3 text-right font-medium">
                          Repeats
                        </th>
                        <th className="py-1 pr-3 font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.recentRuns.slice(0, 8).map((r, i) => (
                        <tr key={`${r.startedAt}-${i}`} className="border-b last:border-0">
                          <td className="py-1 pr-3 tabular-nums">
                            {ago(r.startedAt)}
                          </td>
                          <td className="py-1 pr-3">{r.outcome}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {r.seen}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {r.fresh}
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">
                            {r.duplicate}
                          </td>
                          <td className="py-1 pr-3">{r.error ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Why this screen shows failures so prominently
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            🔴 When leads stop arriving, you ring us and ask why. If the answer
            is &quot;let me check with the developer&quot;, the integration has
            already failed twice: once technically, and once as a product.
          </p>
          <p>
            ⚠️ <strong>A locked connection and a broken one look identical
            from the outside.</strong> IndiaMART allows one check every five
            minutes and stops answering for fifteen if that is exceeded. So the
            lockout is recorded here, with the time it lifts, rather than being
            guessed at.
          </p>
          <p>
            ⭐ <strong>A rejected key is never retried.</strong> Presenting a
            key that has been refused, over and over, is how an account gets
            blocked at the other end. The connection stops and asks for a new
            one instead.
          </p>
          <p>
            ⚠️ <strong>Deliveries that arrive twice land once.</strong> Every
            one of these senders retries after a timeout, which is them doing
            the right thing. The second arrival is recorded and ignored rather
            than becoming a duplicate enquiry.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
