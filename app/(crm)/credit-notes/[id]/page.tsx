/**
 * Ordence — One credit note
 * Version: v0.96.0-alpha
 *
 * ⚠️ IT NAMES THE INVOICE IN THE HEADING, NOT IN A FIELD FURTHER DOWN.
 * A credit note is meaningless on its own: GSTR-1 reports it against the
 * original document and the customer matches it against the invoice in
 * their books. The first question anyone reading one has is "against
 * what", and it should not require scrolling.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getCreditNoteDetail } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditNoteActions } from "@/components/invoices/credit-note-actions";
import { CREDIT_NOTE_REASON_META } from "@/lib/invoicing/credit-note";

export const dynamic = "force-dynamic";

function inr(minorUnits: string | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "₹0.00";
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

function pct(bps: number | null): string {
  if (bps === null) return "—";
  return bps % 100 === 0 ? `${bps / 100}%` : `${(bps / 100).toFixed(2)}%`;
}

export default async function CreditNoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getCreditNoteDetail({ creditNoteId: id });
  if (!result.ok) notFound();

  const { note, lines } = result.data;
  const meta =
    CREDIT_NOTE_REASON_META[note.reasonCode as keyof typeof CREDIT_NOTE_REASON_META] ??
    null;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/credit-notes" className="text-sm text-muted-foreground hover:underline">
            ← Credit notes
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tabular-nums">
            {note.status === "draft" ? "Draft credit note" : note.creditNoteNumber}
          </h1>
          <p className="text-sm text-muted-foreground">
            Against{" "}
            <Link href={`/invoices/${note.invoiceId}`} className="hover:underline">
              {note.invoiceNumber}
            </Link>{" "}
            · {note.customerLegalName ?? "No customer name captured"}
            {note.customerGstin ? ` · ${note.customerGstin}` : " · unregistered"}
          </p>
        </div>
        <Badge variant={note.status === "issued" ? "secondary" : "outline"}>
          {note.status.replace(/_/g, " ")}
        </Badge>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ground</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {/**
           * ⚠️ THE STATUTE IS SHOWN. Somebody eventually has to defend
           * this document. "Section 34(1) — goods returned" can be
           * looked up; "sales return" cannot.
           */}
          <p className="font-medium">
            {meta?.label ?? note.reasonCode}
            {meta && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {meta.statute}
              </span>
            )}
          </p>
          <p className="text-muted-foreground">{note.reason}</p>
          <p className="pt-2 text-xs text-muted-foreground tabular-nums">
            Note date {note.noteDate} — decides the GSTR-1 period this reversal falls in.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <CreditNoteActions
            creditNoteId={note.id}
            status={note.status}
            invoiceNumber={note.invoiceNumber}
            totalLabel={inr(note.totalMinor)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">HSN/SAC</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Rate</th>
                <th className="py-2 pr-3 text-right font-medium">GST</th>
                <th className="py-2 pr-3 text-right font-medium">Taxable</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums">{l.lineNo}</td>
                  <td className="py-2 pr-3">{l.description}</td>
                  <td className="py-2 pr-3 tabular-nums">{l.hsnSacCode ?? "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {l.quantity} {l.uom}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(l.unitPriceMinor)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pct(l.taxRateBps)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {inr(l.taxableValueMinor)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{inr(l.lineTotalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 py-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Taxable value reversed</span>
            <span className="tabular-nums">{inr(note.taxableValueMinor)}</span>
          </div>
          {note.igstMinor !== "0" ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">IGST</span>
              <span className="tabular-nums">{inr(note.igstMinor)}</span>
            </div>
          ) : (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">CGST</span>
                <span className="tabular-nums">{inr(note.cgstMinor)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">SGST / UTGST</span>
                <span className="tabular-nums">{inr(note.sgstMinor)}</span>
              </div>
            </>
          )}
          {note.roundOffMinor !== "0" && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Round off</span>
              <span className="tabular-nums">{inr(note.roundOffMinor)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-semibold">
            <span>Credit note total</span>
            <span className="tabular-nums">{inr(note.totalMinor)}</span>
          </div>
          <p className="pt-2 text-xs text-muted-foreground">
            {/**
             * ⚠️ SHOWN AS A POSITIVE FIGURE AND LABELLED AS A REVERSAL.
             * Printing it negative reads as money owed to the customer,
             * which it is not — it reduces what they owe.
             */}
            This reduces what the customer owes on {note.invoiceNumber}. It is reported in
            GSTR-1 against that invoice, and the customer reverses the input tax credit they
            claimed on it.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
