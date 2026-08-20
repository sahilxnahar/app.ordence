/**
 * Ordence — ⭐ The tax invoice, on paper
 * Version: v0.97.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THIS IS THE DOCUMENT. EVERYTHING ELSE IS A SCREEN ABOUT IT.
 * ══════════════════════════════════════════════════════════════════════
 * Until now Ordence could raise an invoice, tax it correctly, check it
 * against Rule 46 and settle it — and could not produce the thing you
 * send to a customer. The Rule 46 panel asserted the document was
 * complete; nothing rendered the document.
 *
 * ⚠️ A DRAFT PRINTS WITH A WATERMARK RATHER THAN BEING REFUSED. People
 * print drafts to check them, and blocking that just means somebody
 * screenshots the edit screen instead. But a draft carries a placeholder
 * number, so it must be impossible to mistake for the real thing when it
 * is lying on a desk next to one.
 */

import { notFound } from "next/navigation";
import { getTenantContext } from "@/server/tenant-context";
import { BrandLogo } from "@/components/branding/brand-logo";
import { logoSrc } from "@/lib/branding/logo";
import Link from "next/link";
import { getInvoiceForPrint } from "@/server/actions/sales-invoices";
import { addressLines, formatGstin } from "@/lib/invoicing/print";
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

/** `2026-08-13` → `13-08-2026`. The form every Indian document uses. */
function dmy(iso: string | null): string {
  if (!iso) return "—";
  const parts = iso.slice(0, 10).split("-");
  if (parts.length !== 3) return iso;
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

export default async function InvoicePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getInvoiceForPrint({ invoiceId: id });
  if (!result.ok) notFound();

  const { invoice, supplier, recipient, lines, hsnSummary, copies, gaps } = result.data;
  const ctx = await getTenantContext();
  const isDraft = invoice.status === "draft";
  const igst = invoice.igstMinor !== "0";
  const stateHead = invoice.isUnionTerritory ? "UTGST" : "SGST";

  return (
    <>
      {/* ⚠️ The toolbar never prints. */}
      <div className="mx-auto mb-6 flex max-w-[210mm] items-center justify-between gap-4 px-4 print:hidden">
        <Link href={`/invoices/${invoice.id}`} className="text-sm hover:underline">
          ← Back to the invoice
        </Link>
        <div className="flex items-center gap-3">
          {gaps.length > 0 && (
            <span className="text-sm text-red-700">
              {gaps.length} field{gaps.length === 1 ? "" : "s"} Rule 46 requires{" "}
              {gaps.length === 1 ? "is" : "are"} missing
            </span>
          )}
          <PrintTrigger />
        </div>
      </div>

      {/**
       * ⚠️ ONE SHEET PER COPY — Rule 48(1). Three for goods, two for
       * services. Printing one page and asking the person to run three
       * copies gives three identical sheets, none of them marked, which
       * is the thing the rule exists to prevent.
       */}
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
            {/*
              ⭐ WAVE 2E , the placement customers care about most.

              ⚠️ A KNOWN AND DELIBERATE LIMITATION. This prints the
              workspace's CURRENT logo, so reprinting a two-year-old
              invoice shows today's logo rather than the one that was on
              the original. Everything else on this page is captured at
              issue , the supplier registration, the address, the GSTIN ,
              precisely because it must not drift. Capturing the logo per
              invoice needs a column on the invoice row, which is a
              migration nobody has written.

              🔴 THE COLOURS ARE NOT APPLIED TO PAPER AT ALL.
              `.document-surface` re-pins the palette so a printed
              document stays legible whatever a workspace's brand is.
            */}
            {ctx ? (
              <div className="absolute left-0 top-0">
                <BrandLogo
                  src={logoSrc(ctx.tenant.branding)}
                  tenantName={ctx.tenant.name}
                  height={36}
                />
              </div>
            ) : null}
            <p className="text-center text-[13px] font-bold uppercase tracking-wide">
              Tax Invoice
            </p>
            <p className="text-center text-[9px] uppercase tracking-wider">{copyLabel}</p>
          </header>

          <div className="relative grid grid-cols-2 gap-4 border-b border-black py-2">
            <div>
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Supplier
              </p>
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
                    <td className="pr-2 font-semibold">Invoice No.</td>
                    <td className="tabular-nums">
                      {isDraft ? "NOT YET ISSUED" : invoice.invoiceNumber}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-2 font-semibold">Invoice Date</td>
                    <td className="tabular-nums">{dmy(invoice.invoiceDate)}</td>
                  </tr>
                  {invoice.dueDate && (
                    <tr>
                      <td className="pr-2 font-semibold">Due Date</td>
                      <td className="tabular-nums">{dmy(invoice.dueDate)}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="pr-2 font-semibold">Place of Supply</td>
                    <td className="tabular-nums">
                      {invoice.placeOfSupplyCode ?? "—"}
                      {invoice.isInterState ? " (Inter-State)" : " (Intra-State)"}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-2 font-semibold">Reverse Charge</td>
                    <td>{invoice.isReverseCharge ? "Yes" : "No"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="relative grid grid-cols-2 gap-4 border-b border-black py-2">
            <div>
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Bill to / Recipient
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
              {/**
               * 🔴 THE ROW IS PRINTED EVEN THOUGH THE FIELD IS EMPTY.
               * Rule 46(o). Omitting it makes an incomplete invoice look
               * complete; showing it blank makes somebody ask.
               */}
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Address of Delivery — Rule 46(o)
              </p>
              <p className="text-neutral-500">Not captured</p>
            </div>
          </div>

          <table className="relative w-full border-collapse">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="py-1 pr-1 font-semibold">#</th>
                <th className="py-1 pr-1 font-semibold">Description of goods / services</th>
                <th className="py-1 pr-1 font-semibold">HSN/SAC</th>
                <th className="py-1 pr-1 text-right font-semibold">Qty</th>
                <th className="py-1 pr-1 font-semibold">UQC</th>
                <th className="py-1 pr-1 text-right font-semibold">Rate</th>
                <th className="py-1 pr-1 text-right font-semibold">Disc.</th>
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
                    {l.discountMinor === "0" ? "—" : inr(l.discountMinor)}
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

          <div className="relative mt-2 grid grid-cols-2 gap-4">
            <div className="avoid-break">
              {/* ⭐ Rule 46(g) — and the table GSTR-1 is reconciled against. */}
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                HSN / SAC Summary
              </p>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-neutral-400 text-left">
                    <th className="py-0.5 pr-1 font-semibold">HSN/SAC</th>
                    <th className="py-0.5 pr-1 text-right font-semibold">Qty</th>
                    <th className="py-0.5 pr-1 font-semibold">UQC</th>
                    <th className="py-0.5 pr-1 text-right font-semibold">Taxable</th>
                    <th className="py-0.5 text-right font-semibold">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {hsnSummary.map((h) => (
                    <tr key={`${h.hsnSacCode}-${h.uom}`} className="border-b border-neutral-200">
                      <td className="py-0.5 pr-1 tabular-nums">{h.hsnSacCode}</td>
                      <td className="py-0.5 pr-1 text-right tabular-nums">{h.quantity}</td>
                      <td className="py-0.5 pr-1">{h.uom}</td>
                      <td className="py-0.5 pr-1 text-right tabular-nums">
                        {inr(h.taxableValueMinor)}
                      </td>
                      <td className="py-0.5 text-right tabular-nums">
                        {inr(h.taxAmountMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="avoid-break">
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="pr-2">Taxable Value</td>
                    <td className="text-right tabular-nums">
                      {inr(invoice.taxableValueMinor)}
                    </td>
                  </tr>
                  {/**
                   * ⚠️ THE HEADS ARE NEVER SUMMED INTO ONE "GST" LINE.
                   * The recipient posts CGST, SGST and IGST to three
                   * different ledgers, and a combined figure makes them
                   * do a split the document already knew.
                   */}
                  {igst ? (
                    <tr>
                      <td className="pr-2">IGST</td>
                      <td className="text-right tabular-nums">{inr(invoice.igstMinor)}</td>
                    </tr>
                  ) : (
                    <>
                      <tr>
                        <td className="pr-2">CGST</td>
                        <td className="text-right tabular-nums">{inr(invoice.cgstMinor)}</td>
                      </tr>
                      <tr>
                        <td className="pr-2">{stateHead}</td>
                        <td className="text-right tabular-nums">{inr(invoice.sgstMinor)}</td>
                      </tr>
                    </>
                  )}
                  {invoice.cessMinor !== "0" && (
                    <tr>
                      <td className="pr-2">Cess</td>
                      <td className="text-right tabular-nums">{inr(invoice.cessMinor)}</td>
                    </tr>
                  )}
                  {invoice.roundOffMinor !== "0" && (
                    <tr>
                      <td className="pr-2">Round Off</td>
                      <td className="text-right tabular-nums">
                        {inr(invoice.roundOffMinor)}
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-black text-[12px] font-bold">
                    <td className="pr-2 pt-1">Total</td>
                    <td className="pt-1 text-right tabular-nums">₹ {inr(invoice.totalMinor)}</td>
                  </tr>
                  {invoice.receivedMinor !== "0" && (
                    <>
                      <tr>
                        <td className="pr-2">Received</td>
                        <td className="text-right tabular-nums">
                          {inr(invoice.receivedMinor)}
                        </td>
                      </tr>
                      <tr className="font-semibold">
                        <td className="pr-2">Balance Due</td>
                        <td className="text-right tabular-nums">
                          {inr(invoice.outstandingMinor)}
                        </td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ⭐ The tie-breaker when the figure is smudged or altered. */}
          <div className="avoid-break relative mt-2 border-y border-black py-1">
            <span className="font-semibold">Amount Chargeable (in words): </span>
            <span className="uppercase">{invoice.amountInWords}</span>
          </div>

          {invoice.isReverseCharge && (
            <p className="relative pt-1 font-semibold">
              Tax payable on reverse charge basis. Tax has not been collected on this
              invoice.
            </p>
          )}

          {(invoice.terms || invoice.notes) && (
            <div className="avoid-break relative pt-2">
              {invoice.terms && (
                <>
                  <p className="text-[9px] font-semibold uppercase text-neutral-600">
                    Terms
                  </p>
                  <p className="whitespace-pre-line">{invoice.terms}</p>
                </>
              )}
              {invoice.notes && (
                <>
                  <p className="pt-1 text-[9px] font-semibold uppercase text-neutral-600">
                    Notes
                  </p>
                  <p className="whitespace-pre-line">{invoice.notes}</p>
                </>
              )}
            </div>
          )}

          <div className="avoid-break relative grid grid-cols-2 gap-4 pt-4">
            <div>
              <p className="text-[9px] font-semibold uppercase text-neutral-600">
                Declaration
              </p>
              <p>
                We declare that this invoice shows the actual price of the goods or
                services described and that all particulars are true and correct.
              </p>
            </div>
            {/**
             * 🔴 THE SIGNATURE BLOCK IS PRINTED EMPTY — Rule 46(q).
             * An invoice with a blank signature line is one somebody
             * signs. An invoice with no signature line is one nobody
             * notices is unsigned.
             */}
            <div className="text-right">
              <p>For {supplier.legalName ?? "—"}</p>
              <div className="h-12" />
              <p className="border-t border-black pt-1 inline-block">
                Authorised Signatory
              </p>
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
            <p className="font-medium">
              What Rule 46 still wants on this document
            </p>
            <ul className="mt-2 space-y-1">
              {gaps.map((g) => (
                <li key={g.field}>
                  <span className="font-medium">{g.rule}</span> — {g.message}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-neutral-600">
              {/* Shown here and never on the sheet. */}
              This notice appears on screen only. It is not printed.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
