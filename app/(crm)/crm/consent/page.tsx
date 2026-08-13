/**
 * Ordence — ⭐⭐⭐ CONSENT
 * Version: v1.10.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE DEADLINE IS REAL AND IT IS DATED
 * ══════════════════════════════════════════════════════════════════════
 * The Digital Personal Data Protection Rules 2025 were notified on
 * 13 November 2025. Consent manager registration closes November 2026
 * and the penalty regime begins May 2027.
 *
 * ⚠️ CONSENT AS A TICK BOX IS NOT CONSENT. The Act turns on what the
 * person was told, for what purpose, and whether they can take it back.
 * A row saying somebody agreed, with no record of what they agreed to,
 * is exactly what an inspection asks for and does not find.
 */

import Link from "next/link";
import { getConsentOverview } from "@/server/actions/consent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export const metadata = { title: "Consent · Ordence" };

export default async function ConsentPage() {
  const result = await getConsentOverview();

  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Consent</h1>
        <p className="text-sm text-destructive">{result.error}</p>
      </main>
    );
  }

  const { notices, granted, withdrawn, unevidenced } = result.data;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Consent</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The sentence that reframes the whole feature.
           */}
          A tick box is not consent. What matters is the wording the person
          was shown, the purpose they agreed to, and how easily they can take
          it back. All three are recorded here, and a campaign cannot send to
          anybody the record does not cover.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className={unevidenced > 0 ? "border-destructive" : undefined}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Not evidence
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{unevidenced}</p>
            <p className="text-xs text-muted-foreground">
              {unevidenced === 0
                ? "Every consent on file names the notice it was given against. That is what makes it evidence rather than a claim."
                : "🔴 These say somebody agreed and do not say what to. They are ignored when a campaign asks, and they will not help if anybody asks. Collect them again properly."}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Consents held
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{granted}</p>
            <p className="text-xs text-muted-foreground">
              Each one names a purpose, a channel and the notice behind it.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Withdrawn
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{withdrawn}</p>
            <p className="text-xs text-muted-foreground">
              {/**
               * ⭐ Withdrawal is a state, not an absence. It has to
               * survive so the question "did we send anything after"
               * has an answer.
               */}
              Kept, not deleted. The question after a complaint is always when
              they said stop and whether anything went out afterwards.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Notices{" "}
            <span className="font-normal text-muted-foreground">
              ({notices.length})
            </span>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {/**
             * 🔴 The rule that makes the stored wording worth storing.
             */}
            Once anybody has agreed against a notice, its wording is frozen. A
            notice that can be edited after people agree to it is worth exactly
            as much as no notice at all. Publish a new version instead.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {notices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notices published. Until there is one, no consent can be
              recorded as evidence, because there is nothing for a person to
              have agreed to.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Notice</th>
                  <th className="py-2 pr-3 font-medium">Covers</th>
                  <th className="py-2 pr-3 font-medium">From</th>
                  <th className="py-2 pr-3 text-right font-medium">Agreed by</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => (
                  <tr key={n.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      {n.name}
                      <p className="text-xs text-muted-foreground">v{n.version}</p>
                    </td>
                    <td className="py-2 pr-3 text-xs">{n.purposes.join(", ")}</td>
                    <td className="py-2 pr-3 tabular-nums">{n.effectiveFrom}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{n.usedBy}</td>
                    <td className="py-2 pr-3">
                      {n.frozen ? (
                        <Badge variant="default">frozen</Badge>
                      ) : (
                        <Badge variant="outline">editable</Badge>
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
          <CardTitle className="text-base">The four rules Ordence enforces</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            🔴 <strong>Silence is not consent.</strong> No record means no
            permission. The default is refuse. Every marketing system that
            defaults the other way does it because the list is bigger that way.
          </p>
          <p>
            🔴 <strong>A withdrawal beats a grant, whatever the dates say.</strong>{" "}
            A withdrawn consent cannot be switched back on by editing it. If the
            person has agreed again, that is a new consent against the notice
            they were shown this time.
          </p>
          <p>
            🔴 <strong>One stop means stop.</strong> A withdrawal defaults to
            every purpose and every channel. Somebody who unsubscribes from
            email and keeps getting WhatsApp will complain, and that is a
            complaint with a statutory shape to it.
          </p>
          <p>
            🔴 <strong>A grant with no notice behind it is ignored.</strong> Not
            treated as weak evidence. Ignored, because it says somebody agreed
            and does not say what to.
          </p>
          <p>
            ⚠️ <strong>What this does not do:</strong> register a consent
            manager, or answer a data principal&apos;s access request for you.
            It keeps the record those things are built on.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/contacts" className="underline">
          Contacts
        </Link>{" "}
        ·{" "}
        <Link href="/messages" className="underline">
          Messages
        </Link>
      </p>
    </main>
  );
}
