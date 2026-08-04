/**
 * Ordence — GST Invoice Renderer
 * Version: v0.16.0-alpha
 *
 * Produces a self-contained HTML document that a customer can read,
 * print, or save as a PDF from their browser.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT INDIAN GST RULES REQUIRE ON A TAX INVOICE
 * ══════════════════════════════════════════════════════════════════════
 * This is not decoration. A customer files this document to claim input
 * tax credit, and a missing field gets the claim rejected — weeks later,
 * by which point they have paid you and are asking for a corrected copy
 * you cannot simply edit.
 *
 * Rule 46 of the CGST Rules requires, in substance:
 *   • the words "Tax Invoice"
 *   • supplier name, address and GSTIN
 *   • a consecutive serial number, unique within the financial year
 *   • date of issue
 *   • recipient name, address and GSTIN (where registered)
 *   • place of supply, for inter-state supplies
 *   • HSN or SAC code for each line
 *   • description, quantity, value
 *   • taxable value, rate, and the amount of tax — SPLIT into CGST, SGST
 *     and IGST, never as one combined figure
 *   • whether tax is payable on reverse charge
 *   • signature or digital signature
 *
 * Each is emitted below and each is marked. Where a field is genuinely
 * optional — an unregistered customer has no GSTIN — the document says
 * so explicitly rather than leaving a blank that reads like an omission.
 *
 * ⚠️ I am not your accountant. This implements the fields as I understand
 * them; have your CA review one real invoice before you issue a hundred.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SECURITY: EVERY INTERPOLATED VALUE IS ESCAPED
 * ══════════════════════════════════════════════════════════════════════
 * A customer controls their own legal name, address and line
 * descriptions. This document is rendered in a browser and may be
 * emailed. An unescaped `<script>` in a company name would execute in
 * whoever opens it — including our own staff reviewing an invoice.
 *
 * Same reasoning and the same helper shape as `lib/email/templates.ts`.
 */

import type { Invoice } from "@/db/schema/billing";
import { formatMoney, toBigIntAmount, GST_STATE_CODES } from "./money";

/* ------------------------------------------------------------------ */
/* ESCAPING                                                            */
/* ------------------------------------------------------------------ */

/**
 * HTML-escape. Handles the five characters that matter, plus the
 * backtick — which Internet Explorer historically treated as an
 * attribute delimiter, and which costs nothing to include.
 */
function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type InvoiceLineRow = {
  description: string;
  sacCode: string;
  quantity: number;
  unitAmountMinor: bigint | string;
  amountMinor: bigint | string;
  taxRateBps: number;
};

export type SupplierIdentity = {
  legalName: string;
  gstin: string | null;
  stateCode: string;
  address: string | null;
};

/* ------------------------------------------------------------------ */
/* FORMATTING                                                          */
/* ------------------------------------------------------------------ */

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  // dd MMM yyyy — unambiguous. 03/04/2026 is read as 3 April in India and
  // 4 March in the United States, and an invoice date is not a field to
  // leave ambiguous across a border.
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function stateName(code: string | null | undefined): string {
  if (!code) return "—";
  return `${GST_STATE_CODES[code] ?? "Unknown"} (${code})`;
}

/**
 * Amount in words — required on many Indian commercial documents and
 * expected by most accounts departments even where it is not.
 *
 * Uses the Indian numbering system: crore, lakh, thousand. Rendering
 * ₹12,34,567 as "one million two hundred…" would be read as an error.
 */
export function amountInWords(minor: bigint, currency = "INR"): string {
  if (currency !== "INR") return "";

  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;

  const ONES = [
    "", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
  ];
  const TENS = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
    "eighty", "ninety",
  ];

  function underHundred(n: number): string {
    if (n < 20) return ONES[n] ?? "";
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? (TENS[tens] ?? "") : `${TENS[tens]} ${ONES[ones]}`;
  }

  function underThousand(n: number): string {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    const parts: string[] = [];
    if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
    if (rest > 0) parts.push(underHundred(rest));
    return parts.join(" ");
  }

  if (rupees === 0n && paise === 0n) return "Zero rupees only";

  // Indian grouping: crore (10^7), lakh (10^5), thousand (10^3), then
  // the final hundreds. Deliberately NOT the western three-digit groups.
  const crore = Number(rupees / 10_000_000n);
  const lakh = Number((rupees / 100_000n) % 100n);
  const thousand = Number((rupees / 1_000n) % 100n);
  const hundred = Number(rupees % 1_000n);

  const parts: string[] = [];
  if (crore > 0) parts.push(`${underThousand(crore)} crore`);
  if (lakh > 0) parts.push(`${underHundred(lakh)} lakh`);
  if (thousand > 0) parts.push(`${underHundred(thousand)} thousand`);
  if (hundred > 0) parts.push(underThousand(hundred));

  const words = parts.join(" ").replace(/\s+/g, " ").trim();

  const rupeeWords = rupees > 0n ? `${words} rupees` : "";
  const paiseWords =
    paise > 0n ? `${underHundred(Number(paise))} paise` : "";

  const joined = [rupeeWords, paiseWords].filter(Boolean).join(" and ");

  /**
   * ⚠️ CAPITALISE THE FINAL STRING, NOT THE RUPEE WORDS.
   *
   * An earlier version capitalised `words` — the rupee portion — which is
   * EMPTY for any amount under one rupee. `amountInWords(45n)` then
   * returned "forty five paise only", lowercase, in the middle of an
   * otherwise formal document.
   *
   * Small, but this is a legal instrument and a lowercase sentence on it
   * reads as carelessness about everything else on the page. Caught by a
   * test that swept a range of amounts rather than checking one.
   */
  const sentence = `${negative ? "Minus " : ""}${joined} only`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/* ------------------------------------------------------------------ */
/* THE DOCUMENT                                                        */
/* ------------------------------------------------------------------ */

export function renderInvoiceHtml(args: {
  invoice: Invoice;
  lines: InvoiceLineRow[];
  supplier: SupplierIdentity;
}): string {
  const { invoice, lines, supplier } = args;
  const currency = invoice.currency;

  const cgst = toBigIntAmount(invoice.cgstMinor);
  const sgst = toBigIntAmount(invoice.sgstMinor);
  const igst = toBigIntAmount(invoice.igstMinor);
  const total = toBigIntAmount(invoice.totalMinor);
  const paid = toBigIntAmount(invoice.amountPaidMinor);
  const isInterState = igst > 0n;

  const address = invoice.customerAddress ?? {};
  const addressLines = [
    address.line1,
    address.line2,
    [address.city, address.state].filter(Boolean).join(", "),
    address.postalCode,
  ].filter((part): part is string => Boolean(part && part.trim()));

  const lineRows = lines
    .map(
      (line, index) => `
      <tr>
        <td class="num">${index + 1}</td>
        <td>${esc(line.description)}</td>
        <td class="num">${esc(line.sacCode)}</td>
        <td class="num">${esc(line.quantity)}</td>
        <td class="amt">${esc(formatMoney(toBigIntAmount(line.unitAmountMinor), currency))}</td>
        <td class="amt">${esc(formatMoney(toBigIntAmount(line.amountMinor), currency))}</td>
        <td class="num">${(line.taxRateBps / 100).toFixed(0)}%</td>
      </tr>`,
    )
    .join("");

  /* The tax rows differ by supply type — never both. */
  const taxRows = isInterState
    ? `<tr><th>IGST</th><td class="amt">${esc(formatMoney(igst, currency))}</td></tr>`
    : `<tr><th>CGST</th><td class="amt">${esc(formatMoney(cgst, currency))}</td></tr>
       <tr><th>SGST</th><td class="amt">${esc(formatMoney(sgst, currency))}</td></tr>`;

  const outstanding = total - paid;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax Invoice ${esc(invoice.invoiceNumber)}</title>
<style>
  /* Self-contained. No external fonts, no CDN — this document must
     render identically offline, in an email client, and in five years. */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a; background: #f6f7f9;
    margin: 0; padding: 24px; line-height: 1.5;
  }
  .sheet {
    max-width: 800px; margin: 0 auto; background: #fff; padding: 40px;
    border: 1px solid #e2e5ea; border-radius: 8px;
  }
  h1 { font-size: 20px; letter-spacing: .08em; text-transform: uppercase;
       margin: 0 0 4px; }
  .muted { color: #5b6472; font-size: 13px; }
  .row { display: flex; gap: 32px; flex-wrap: wrap; }
  .col { flex: 1 1 240px; min-width: 240px; }
  .block { margin-top: 28px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
           color: #7a828f; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e8eaee; text-align: left;
           vertical-align: top; }
  thead th { background: #f2f4f7; font-size: 11px; text-transform: uppercase;
             letter-spacing: .05em; color: #5b6472; border-bottom: 2px solid #d9dde3; }
  .num { text-align: center; white-space: nowrap; }
  /* Right-aligned and tabular so digits line up column-wise — the single
     most important typographic property of a financial document. */
  .amt { text-align: right; white-space: nowrap;
         font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: 320px; }
  .totals th { text-align: left; border: none; font-weight: 500; color: #5b6472; }
  .totals td { border: none; }
  .grand th, .grand td { border-top: 2px solid #1a1a1a; font-size: 16px;
                          font-weight: 700; color: #1a1a1a; padding-top: 10px; }
  .words { margin-top: 12px; font-size: 13px; font-style: italic; color: #3d4450; }
  .foot { margin-top: 36px; padding-top: 16px; border-top: 1px solid #e8eaee;
          font-size: 12px; color: #7a828f; }
  .sign { margin-top: 40px; text-align: right; font-size: 13px; }
  .sign .line { display: inline-block; border-top: 1px solid #9aa2ae;
                padding-top: 6px; min-width: 220px; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px;
          font-size: 11px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .05em; }
  .paid { background: #e6f4ea; color: #1e6b34; }
  .due  { background: #fdf0e3; color: #8a5216; }
  .void { background: #f1f2f4; color: #5b6472; }
  @media print {
    /* The customer's route to a PDF is Ctrl-P. Make that output clean. */
    body { background: #fff; padding: 0; }
    .sheet { border: none; border-radius: 0; padding: 0; max-width: none; }
  }
</style>
</head>
<body>
<div class="sheet">

  <!-- Rule 46: the document must say "Tax Invoice". Not "Invoice",
       not "Receipt". -->
  <div class="row">
    <div class="col">
      <h1>Tax Invoice</h1>
      <div class="muted">${esc(invoice.invoiceNumber)}</div>
    </div>
    <div class="col" style="text-align:right">
      <span class="pill ${
        invoice.status === "paid" ? "paid" : invoice.status === "void" ? "void" : "due"
      }">${esc(invoice.status === "open" ? "Due" : invoice.status)}</span>
      <div class="muted" style="margin-top:6px">
        Issued ${esc(formatDate(invoice.issuedAt))}<br>
        Due ${esc(formatDate(invoice.dueAt))}
      </div>
    </div>
  </div>

  <div class="row block">
    <!-- Rule 46: supplier name, address and GSTIN. -->
    <div class="col">
      <div class="label">From</div>
      <strong>${esc(supplier.legalName)}</strong><br>
      ${supplier.address ? `<span class="muted">${esc(supplier.address)}</span><br>` : ""}
      ${
        supplier.gstin
          ? `<span class="muted">GSTIN: ${esc(supplier.gstin)}</span>`
          : `<span class="muted">GSTIN not configured</span>`
      }
    </div>

    <!-- Rule 46: recipient name, address and GSTIN where registered. -->
    <div class="col">
      <div class="label">Billed to</div>
      <strong>${esc(invoice.customerLegalName ?? "—")}</strong><br>
      ${addressLines.map((l) => `<span class="muted">${esc(l)}</span><br>`).join("")}
      ${
        invoice.customerGstin
          ? `<span class="muted">GSTIN: ${esc(invoice.customerGstin)}</span>`
          : // Stated explicitly. A blank here reads as an omission by
            // whoever prepared the document; this reads as a fact.
            `<span class="muted">Unregistered (no GSTIN)</span>`
      }
    </div>
  </div>

  <div class="row block">
    <div class="col">
      <div class="label">Place of supply</div>
      <span class="muted">${esc(stateName(invoice.placeOfSupplyCode))}</span>
    </div>
    <div class="col">
      <div class="label">Supply type</div>
      <span class="muted">${isInterState ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}</span>
    </div>
    ${
      invoice.periodStart && invoice.periodEnd
        ? `<div class="col">
             <div class="label">Billing period</div>
             <span class="muted">${esc(formatDate(invoice.periodStart))} — ${esc(
               formatDate(invoice.periodEnd),
             )}</span>
           </div>`
        : ""
    }
  </div>

  <div class="block">
    <table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Description</th>
          <!-- Rule 46: HSN/SAC per line. -->
          <th class="num">SAC</th>
          <th class="num">Qty</th>
          <th class="amt">Rate</th>
          <th class="amt">Taxable value</th>
          <th class="num">GST</th>
        </tr>
      </thead>
      <tbody>${lineRows}</tbody>
    </table>
  </div>

  <div class="block">
    <table class="totals">
      <tr><th>Taxable value</th>
          <td class="amt">${esc(formatMoney(toBigIntAmount(invoice.subtotalMinor), currency))}</td></tr>
      <!-- Rule 46: tax SPLIT by head, never combined. -->
      ${taxRows}
      <tr class="grand"><th>Total</th>
          <td class="amt">${esc(formatMoney(total, currency))}</td></tr>
      ${
        paid > 0n
          ? `<tr><th>Paid</th><td class="amt">${esc(formatMoney(paid, currency))}</td></tr>
             <tr><th>Outstanding</th><td class="amt">${esc(
               formatMoney(outstanding, currency),
             )}</td></tr>`
          : ""
      }
    </table>
    <div class="words">${esc(amountInWords(total, currency))}</div>
  </div>

  <div class="foot">
    <!-- Rule 46: reverse-charge status must be stated. For a domestic
         SaaS supply it is "No", but the field cannot be omitted. -->
    Tax payable on reverse charge: <strong>No</strong><br>
    ${invoice.notes ? `${esc(invoice.notes)}<br>` : ""}
    This is a computer-generated invoice.
  </div>

  <!-- Rule 46: signature. A typed authorisation line is the accepted
       form for a computer-generated invoice. -->
  <div class="sign">
    <span class="line">For ${esc(supplier.legalName)} — Authorised signatory</span>
  </div>

</div>
</body>
</html>`;
}
