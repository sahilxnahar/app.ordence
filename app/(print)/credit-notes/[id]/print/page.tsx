/**
 * Ordence — ⭐ The credit note, on paper
 * Version: v0.98.0-alpha
 *
 * ⚠️ THE CUSTOMER HAS TO RECEIVE THIS. A credit note is not an internal
 * adjustment: they reverse input tax credit against it, and their
 * accountant files it beside the original invoice. One that exists only
 * in our database leaves them in default of Section 34 without knowing.
 *
 * 🔴 IT SAYS "CREDIT NOTE" IN THE LARGEST TYPE ON THE PAGE, and it names
 *    the invoice it reverses directly under the number — Rule 53. That
 *    reference is the single thing distinguishing this document from an
 *    invoice with a minus sign, and a reader who misses it books it as a
 *    fresh supply.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { getCreditNoteForPrint } from "@/server/actions/sales-invoices";
import { addressLines, formatGstin } from "@/lib/invoicing/print";
import { CREDIT_NOTE_REASON_META } from "@/lib/invoicing/credit-note";
import { PrintTrigger } from "@/components/invoices/print-trigger";

export const dynamic = "force-dynamic";

function inr(minorUnits: string | null | undefined): string {
  if (minorUnits === null || minorUnits === undefined) return "0.00";
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
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

function pct(bps: number | null): string {
  if (bps === null) return "—";
  return bps % 100 === 0 ? `${bps / 100}%` : `${(bps / 100).toFixed(2)}%`;
}

function dmy(iso: string | null): string {
  if (!iso) return "—";
  const parts = iso.slice(0, 10).split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

export default async function CreditNotePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getCreditNoteForPrint({ creditNoteId: id });
  if (!result.ok) notFound();

  const { note, supplier, recipient, lines, copies, gaps } = result.data;
  const isDraft = note.status === "draft";
  const igst = note.igstMinor !== "0";
  const meta =
    CREDIT_NOTE_REASON_META[note.reasonCode as keyof typeof CREDIT_NOTE_REASON_META] ?? null;

  return (
    <>
      <div className="mx-auto mb-6 flex max-w-[210mm] items-center justify-between gap-4 px-4 print:hidden">
        <Link href={`/credit-notes/${note.id}`} className="text-sm hover:underline">
          ← Back to the credit note
        </Link>
        <PrintTrigger />
      </div>

      {copies.map((copyLabel, copyIndex) => (
        <section
          key={copyLabel}
          className={`sheet relative mx-auto mb-8 w-[210mm] bg-white p-[10mm] text-[10.5px] leading-snug text-black shadow print:mb-0 print:shadow-none ${
            copyIndex < copies.length - 1 ? "print:break-after-page" : ""
          }`}
        >
          {isDraft && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rotate-[-30deg] text-[72px] font-bold uppercase tracking-widest text-neutral-200">
                Draft
              </span>
            </div>
          )}

          <header className="relative border-b-2 border-black pb-2">
            <p className="text-center text-[13px] font-bold uppercase tracking-wide">
              Credit Note
            </p>
            <p className="text-center text-[9px] uppercase tracking-wider">{copyLabel}</p>
          </header>

          <div className="relative grid grid-cols-2 gap-4 border-b border-black py-2">
            <div>
              <p className="text-[9px] font-semibold uppercase text-neutral-600">Supplier</p>
              <p className="text-[12px] font-bold">
                {supplier.legalName ?? "— your legal name is not set —"}
              </p>
              {supplier.tradeName && <p>{supplier.tradeName}</p>}
              {addressLines(supplier.address).map((l) => (
                <p key={l}>{l}</p>
              ))}
              <p className="pt-1">
                <span className="font-semibold">GSTIN: </span>
                {formatGstin(supplier.gstin) || "— not set —"}
              </p>
            </div>
            <div className="border-l border-neutral-300 pl-4">
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="pr-2 font-semibold">Credit Note No.</td>
                    <td className="tabular-nums">
                      {isDraft ? "NOT YET ISSUED" : note.creditNoteNumber}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-2 font-semibold">Credit Note Date</td>
                    <td className="tabular-nums">{dmy(note.noteDate)}</td>
                  </tr>
                  {/**
                   * 🔴 RULE 53 — THE ORIGINAL DOCUMENT, IN THE HEADER.
                   * Without these two rows this is an invoice with a
                   * minus sign, and the recipient books it as a supply.
                   */}
                  <tr className="border-t border-neutral-300">
                    <td className="pr-2 font-semibold">Against Invoice</td>
                    <td className="tabular-nums">{note.invoiceNumber}</td>
                  </tr>
                  <tr>
                    <td className="pr-2 font-semibold">Invoice Date</td>
                    <td className="tabular-nums">{dmy(note.invoiceDate)}</td>
                  </tr>
                  <tr>
                    <td className="pr-2 font-semibold">Place of Supply</td>
                    <td className="tabular-nums">
                      {note.placeOfSupplyCode ?? "—"}
                      {note.isInterState ? " (Inter-State)" : " (Intra-State)"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="relative grid grid-cols-2 gap-4 border-b border-black py-2">
            <div>
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Recipient
              </p>
              <p className="text-[12px] font-bold">
                {recipient.legalName ?? "— no recipient name captured —"}
              </p>
              {addressLines(recipient.address).map((l) => (
                <p key={l}>{l}</p>
              ))}
              <p className="pt-1">
                <span className="font-semibold">GSTIN: </span>
                {formatGstin(recipient.gstin) || "Unregistered"}
              </p>
            </div>
            <div className="border-l border-neutral-300 pl-4">
              {/* ⭐ The statutory ground, on the face of the document. */}
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Reason for credit
              </p>
              <p className="font-semibold">
                {meta?.label ?? note.reasonCode}
                {meta && <span className="font-normal"> — {meta.statute}</span>}
              </p>
              <p>{note.reason}</p>
            </div>
          </div>

          <table className="relative w-full border-collapse">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="py-1 pr-1 font-semibold">#</th>
                <th className="py-1 pr-1 font-semibold">Description</th>
                <th className="py-1 pr-1 font-semibold">HSN/SAC</th>
                <th className="py-1 pr-1 text-right font-semibold">Qty</th>
                <th className="py-1 pr-1 font-semibold">UQC</th>
                <th className="py-1 pr-1 text-right font-semibold">Rate</th>
                <th className="py-1 pr-1 text-right font-semibold">Taxable</th>
                <th className="py-1 pr-1 text-right font-semibold">GST%</th>
                <th className="py-1 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-neutral-300 align-top">
                  <td className="py-1 pr-1 tabular-nums">{l.lineNo}</td>
                  <td className="py-1 pr-1">{l.description}</td>
                  <td className="py-1 pr-1 tabular-nums">{l.hsnSacCode ?? "—"}</td>
                  <td className="py-1 pr-1 text-right tabular-nums">{l.quantity}</td>
                  <td className="py-1 pr-1">{l.uom}</td>
                  <td className="py-1 pr-1 text-right tabular-nums">
                    {inr(l.unitPriceMinor)}
                  </td>
                  <td className="py-1 pr-1 text-right tabular-nums">
                    {inr(l.taxableValueMinor)}
                  </td>
                  <td className="py-1 pr-1 text-right tabular-nums">{pct(l.taxRateBps)}</td>
                  <td className="py-1 text-right tabular-nums">{inr(l.lineTotalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="avoid-break relative mt-2 flex justify-end">
            <table className="w-1/2">
              <tbody>
                <tr>
                  <td className="pr-2">Taxable Value Credited</td>
                  <td className="text-right tabular-nums">{inr(note.taxableValueMinor)}</td>
                </tr>
                {igst ? (
                  <tr>
                    <td className="pr-2">IGST</td>
                    <td className="text-right tabular-nums">{inr(note.igstMinor)}</td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td className="pr-2">CGST</td>
                      <td className="text-right tabular-nums">{inr(note.cgstMinor)}</td>
                    </tr>
                    <tr>
                      <td className="pr-2">SGST / UTGST</td>
                      <td className="text-right tabular-nums">{inr(note.sgstMinor)}</td>
                    </tr>
                  </>
                )}
                {note.roundOffMinor !== "0" && (
                  <tr>
                    <td className="pr-2">Round Off</td>
                    <td className="text-right tabular-nums">{inr(note.roundOffMinor)}</td>
                  </tr>
                )}
                <tr className="border-t border-black text-[12px] font-bold">
                  <td className="pr-2 pt-1">Total Credited</td>
                  <td className="pt-1 text-right tabular-nums">₹ {inr(note.totalMinor)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="avoid-break relative mt-2 border-y border-black py-1">
            <span className="font-semibold">Amount Credited (in words): </span>
            <span className="uppercase">{note.amountInWords}</span>
          </div>

          {/**
           * ⚠️ SAID IN PLAIN WORDS ON THE DOCUMENT. The recipient has an
           * obligation here — reversing the input tax credit they already
           * claimed — and a document that only shows figures leaves them
           * to work that out.
           */}
          <p className="relative pt-2">
            This credit note reduces the amount payable under invoice{" "}
            <span className="font-semibold">{note.invoiceNumber}</span> dated{" "}
            {dmy(note.invoiceDate)}. The recipient is required to reverse the input tax
            credit claimed on the value credited above.
          </p>

          <div className="avoid-break relative grid grid-cols-2 gap-4 pt-4">
            <div>
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Declaration
              </p>
              <p>
                We declare that the particulars given above are true and correct and that
                this credit note is issued under Section 34 of the CGST Act, 2017.
              </p>
            </div>
            <div className="text-right">
              <p>For {supplier.legalName ?? "—"}</p>
              <div className="h-12" />
              <p className="inline-block border-t border-black pt-1">Authorised Signatory</p>
            </div>
          </div>

          <p className="relative pt-3 text-center text-[8px] text-neutral-500">
            This is a computer-generated document produced by Ordence.
          </p>
        </section>
      ))}

      {gaps.length > 0 && (
        <div className="mx-auto mt-4 max-w-[210mm] px-4 print:hidden">
          <div className="rounded border border-red-300 bg-red-50 p-4 text-sm">
            <p className="font-medium">What is still missing from this document</p>
            <ul className="mt-2 space-y-1">
              {gaps.map((g) => (
                <li key={g.field}>
                  <span className="font-medium">{g.rule}</span> — {g.message}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-neutral-600">
              This notice appears on screen only. It is not printed.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
