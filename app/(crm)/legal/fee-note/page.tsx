/**
 * Ordence — ⭐⭐⭐ THE FEE NOTE
 * Version: v1.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS SCREEN EXISTS BECAUSE v1.2.0 SHIPPED A DEFECT
 * ══════════════════════════════════════════════════════════════════════
 * `raiseInvoiceFromTime` charged **18% forward on every invoice**, from
 * v1.2.0 until now. For an advocate or a firm of advocates that is wrong
 * nearly every time — legal services are exempt under Notification
 * 12/2017 Sr. No. 45, or on **reverse charge** under Notification
 * 13/2017 Sr. No. 2 where the client pays and the invoice carries no tax
 * at all.
 *
 * ⚠️ And the error is not symmetrical. Tax charged that was not
 * chargeable is money collected as tax — s.76 requires it to be paid to
 * the Government whether or not it was due, and the client cannot claim
 * credit for it either. The firm cannot keep it and the client cannot
 * use it.
 *
 * ⭐ So the decision is shown, with its citation, BEFORE the bill is
 * raised — not buried in a tax field somebody types over.
 */

import Link from "next/link";
import { registrationPosition } from "@/server/actions/legal-billing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FeeNoteBuilder } from "@/components/legal/fee-note-builder";
import { getLegalOptions } from "@/server/actions/matters";

export const dynamic = "force-dynamic";

export const metadata = { title: "Fee note · Ordence" };

export default async function FeeNotePage() {
  const [reg, options] = await Promise.all([registrationPosition(), getLegalOptions()]);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Fee note</h1>
        <p className="text-sm text-muted-foreground">
          {/**
           * 🔴 The sentence that reverses everybody's default.
           */}
          An advocate almost never charges GST on legal services. The supply is
          either exempt, or the <em>client</em> pays the tax under reverse
          charge — so the bill carries none. Forward charge is the exception,
          and Ordence works out which one this is before the bill is raised.
        </p>
      </div>

      <FeeNoteBuilder
        clients={options.ok ? options.data.clients : []}
      />

      {reg.ok && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Does this firm have to be registered?{" "}
              <Badge variant={reg.data.mustRegister ? "destructive" : "default"}>
                {reg.data.mustRegister ? "yes" : "not on this basis"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{reg.data.reason}</p>
            <p className="text-xs text-muted-foreground">{reg.data.citation}</p>
            {reg.data.notes.map((n, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {n}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Why a lawyer&apos;s bill adds up differently</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            🔴 <strong>The court fee is not part of the value.</strong> Rule 33
            of the CGST Rules takes a pure agent&apos;s recovery out of the value
            of supply — so it is added <em>after</em> the tax, on its own line.
            Rule 33(ii) requires it to be &ldquo;separately indicated in the
            invoice&rdquo;, which means a bill that folds the court fee into the
            fee total has failed the rule on the face of the document, however
            correctly the money actually moved.
          </p>
          <p>
            🔴 <strong>And it has to be recovered at exactly what was paid.</strong>{" "}
            Explanation (d) allows the pure agent to receive &ldquo;only the
            actual amount incurred&rdquo;. A ₹500 rounding on a ₹50,000 court fee
            does not cost ₹90 of GST — it costs about ₹9,090, because the whole
            ₹50,500 drops into the value of supply. Ordence refuses to store that
            row at all.
          </p>
          <p>
            ⚠️ <strong>Reverse charge still gets reported.</strong> The supply
            goes into GSTR-1 table 4B even though no tax was charged on it.
            Leaving it out because the invoice showed nil is the most common way
            this goes wrong at the filing end.
          </p>
          <p>
            ⭐ <strong>And the threshold that matters is the client&apos;s.</strong>{" "}
            The exemption for a small business turns on whether the{" "}
            <em>client</em> was liable to register — so a Mumbai firm billing a
            small business in Manipur applies ₹10 lakh, not ₹20 lakh, and the
            same turnover is exempt in one State and on reverse charge in the
            other.
          </p>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        <Link href="/legal/matters" className="underline">
          Matters
        </Link>{" "}
        ·{" "}
        <Link href="/legal/disbursements" className="underline">
          Disbursements
        </Link>{" "}
        ·{" "}
        <Link href="/time" className="underline">
          Time &amp; billing
        </Link>
      </p>
    </main>
  );
}
