/**
 * Ordence — ⭐ Raise a credit note against this invoice
 * Version: v0.96.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY THIS SCREEN EXISTS
 * ══════════════════════════════════════════════════════════════════════
 * `raiseCreditNote` and `issueCreditNote` have worked since Phase 52 and
 * nothing has ever rendered them. Until this screen, a sales return
 * could not be processed by a human being — the only lawful correction
 * to an issued tax invoice was reachable only from code.
 *
 * ⚠️ IT LIVES UNDER THE INVOICE, NOT UNDER A "NEW CREDIT NOTE" MENU.
 * A credit note that names no invoice is unreconcilable: GSTR-1 reports
 * it against the original document and the customer matches it against
 * the invoice in their books. Starting from the invoice makes the link
 * structural rather than something a person has to remember to fill in.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getCreditNoteContext } from "@/server/actions/sales-invoices";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RaiseCreditNote } from "@/components/invoices/raise-credit-note";

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

export default async function RaiseCreditNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getCreditNoteContext({ invoiceId: id });

  /**
   * ⚠️ `notFound()`, NOT an error page. A tenant asking for an invoice
   * that is not theirs and one asking for an invoice that does not exist
   * must be indistinguishable.
   */
  if (!result.ok) notFound();

  const { invoice, lines, headroomMinor, notes } = result.data;

  /**
   * ⚠️ A DRAFT OR CANCELLED INVOICE CANNOT BE CREDITED, AND THE FORM IS
   * NOT SHOWN AT ALL RATHER THAN SHOWN DISABLED. Crediting a draft is
   * meaningless — edit the draft. Crediting a cancelled invoice credits
   * a supply that never happened. The action refuses both; offering the
   * form invites the attempt.
   */
  const creditable = invoice.status !== "draft" && invoice.status !== "cancelled";

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <Link
          href={`/invoices/${invoice.id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {invoice.invoiceNumber}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Credit note</h1>
        <p className="text-sm text-muted-foreground">
          Against {invoice.invoiceNumber} ·{" "}
          {invoice.customerLegalName ?? "No customer name captured"}
          {invoice.customerGstin ? ` · ${invoice.customerGstin}` : " · unregistered"}
        </p>
      </div>

      {!creditable ? (
        <Card>
          <CardContent className="py-6 text-sm">
            {invoice.status === "draft" ? (
              <p>
                {invoice.invoiceNumber} is still a draft. A credit note reverses a document
                the customer holds — edit the draft instead.
              </p>
            ) : (
              <p>
                {invoice.invoiceNumber} was cancelled. Crediting it would reverse a supply
                that never happened.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {notes.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Already raised against this invoice
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {/**
                 * ⚠️ SHOWN BEFORE THE FORM, NOT AFTER IT. The most
                 * common mistake here is crediting the same return
                 * twice, and a list underneath the form is read after
                 * the mistake has been typed.
                 */}
                {notes.map((n) => (
                  <div key={n.id} className="flex justify-between gap-3">
                    <Link href={`/credit-notes/${n.id}`} className="hover:underline">
                      {n.status === "draft" ? "Draft" : n.creditNoteNumber}
                      <span className="text-muted-foreground"> · {n.noteDate}</span>
                      {n.status === "cancelled" && (
                        <span className="text-muted-foreground"> · discarded</span>
                      )}
                    </Link>
                    <span className="tabular-nums">{inr(n.totalMinor)}</span>
                  </div>
                ))}
                <p className="pt-1 text-xs text-muted-foreground">
                  Only issued notes consume the invoice&apos;s remaining credit. A draft
                  blocks nothing.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Invoice {inr(invoice.totalMinor)} · {inr(headroomMinor)} still creditable
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RaiseCreditNote
                invoiceId={invoice.id}
                invoiceNumber={invoice.invoiceNumber}
                invoiceDate={invoice.invoiceDate}
                isInterState={invoice.isInterState}
                placeOfSupplyCode={invoice.placeOfSupplyCode}
                headroomMinor={headroomMinor}
                lines={lines}
              />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
