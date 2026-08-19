/**
 * Ordence — Contract Rendering
 * Version: v0.4.0-alpha
 *
 * Produces print-optimised HTML from a contract's structured body.
 *
 * SECURITY: contract sections contain tenant-authored text and merge values
 * pulled from the database. This output is written to a file and may later be
 * opened in a browser, so it is a genuine XSS sink. **Every interpolated value
 * passes through `escapeHtml()`.** There is no path here that emits raw input.
 */

import { createHash } from "node:crypto";
import type { ContractDocumentData } from "@/db/schema";

/** Escape the five characters that can break out of HTML text or attributes. */
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** SHA-256 hex digest — used for the contract version hash chain. */
export function contentHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type RenderOptions = {
  title: string;
  contractNumber?: string | null;
  status: string;
  versionNumber: number;
  documentData: ContractDocumentData;
  watermark?: string;
  pageSize?: "A4" | "Letter";
};

/**
 * Render a complete, self-contained HTML document.
 *
 * Print CSS is inlined so the file works offline and "Print → Save as PDF"
 * produces a correctly paginated document with running headers.
 */
export function renderContractHtml(options: RenderOptions): string {
  const {
    title,
    contractNumber,
    status,
    versionNumber,
    documentData,
    watermark,
    pageSize = "A4",
  } = options;

  const sections = [...(documentData.sections ?? [])].sort((a, b) => a.order - b.order);
  const parties = documentData.parties ?? [];
  const commercials = documentData.commercials;

  const partiesHtml = parties.length
    ? `
    <section class="parties">
      <h2>Parties</h2>
      ${parties
        .map(
          (p) => `
        <div class="party">
          <div class="party-role">${escapeHtml(p.role)}</div>
          <div class="party-name">${escapeHtml(p.name)}</div>
          ${p.entityType ? `<div class="party-meta">${escapeHtml(p.entityType)}</div>` : ""}
          ${p.address ? `<div class="party-meta">${escapeHtml(p.address)}</div>` : ""}
          ${
            p.signatoryName
              ? `<div class="party-meta">Signatory: ${escapeHtml(p.signatoryName)}${
                  p.signatoryDesignation ? `, ${escapeHtml(p.signatoryDesignation)}` : ""
                }</div>`
              : ""
          }
        </div>`,
        )
        .join("")}
    </section>`
    : "";

  const commercialsHtml = commercials
    ? `
    <section class="commercials">
      <h2>Commercial Terms</h2>
      <table class="terms">
        ${
          commercials.value
            ? `<tr><th>Contract Value</th><td>${escapeHtml(commercials.currency ?? "INR")} ${escapeHtml(commercials.value)}</td></tr>`
            : ""
        }
        ${
          commercials.retentionPct != null
            ? `<tr><th>Retention</th><td>${escapeHtml(commercials.retentionPct)}%</td></tr>`
            : ""
        }
        ${
          commercials.penaltyPerWeekPct != null
            ? `<tr><th>Liquidated Damages</th><td>${escapeHtml(commercials.penaltyPerWeekPct)}% per week</td></tr>`
            : ""
        }
      </table>
      ${
        commercials.paymentSchedule?.length
          ? `
        <h3>Payment Schedule</h3>
        <table class="schedule">
          <thead><tr><th>Milestone</th><th>%</th><th>Amount</th><th>Due</th></tr></thead>
          <tbody>
            ${commercials.paymentSchedule
              .map(
                (m) => `<tr>
                  <td>${escapeHtml(m.milestone)}</td>
                  <td>${m.pct != null ? escapeHtml(m.pct) : "—"}</td>
                  <td>${m.amount ? escapeHtml(m.amount) : "—"}</td>
                  <td>${m.dueDate ? escapeHtml(m.dueDate) : "—"}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>`
          : ""
      }
    </section>`
    : "";

  const sectionsHtml = sections
    .map(
      (s, i) => `
      <section class="clause">
        <h2><span class="clause-no">${i + 1}.</span> ${escapeHtml(s.heading)}</h2>
        <div class="clause-body">${escapeHtml(s.body).replace(/\n/g, "<br/>")}</div>
      </section>`,
    )
    .join("");

  const signatureBlocks = parties.length
    ? parties
        .map(
          (p) => `
      <div class="sign-block">
        <div class="sign-line"></div>
        <div class="sign-name">${escapeHtml(p.signatoryName ?? p.name)}</div>
        <div class="sign-meta">${escapeHtml(p.role)}${
          p.signatoryDesignation ? ` · ${escapeHtml(p.signatoryDesignation)}` : ""
        }</div>
        <div class="sign-meta">Date: _______________</div>
      </div>`,
        )
        .join("")
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${pageSize}; margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Times New Roman", Georgia, serif;
    font-size: 11.5pt; line-height: 1.6; color: #111; margin: 0;
    background: #fff; counter-reset: clause;
  }
  .doc { max-width: 190mm; margin: 0 auto; padding: 12mm; position: relative; }
  header.doc-head { border-bottom: 2px solid #B08D3C; padding-bottom: 10px; margin-bottom: 22px; }
  .doc-title { font-size: 18pt; font-weight: 700; margin: 0 0 4px; }
  .doc-meta { font-size: 9pt; color: #555; display: flex; gap: 16px; flex-wrap: wrap; }
  .doc-meta span { white-space: nowrap; }
  h2 { font-size: 12pt; font-weight: 700; margin: 20px 0 6px; page-break-after: avoid; }
  h3 { font-size: 11pt; font-weight: 700; margin: 14px 0 5px; }
  .clause { page-break-inside: avoid; }
  .clause-no { color: #B08D3C; margin-right: 5px; }
  .clause-body { text-align: justify; }
  .parties { margin: 18px 0; }
  .party { margin-bottom: 10px; padding-left: 10px; border-left: 3px solid #E5DCC7; }
  .party-role { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #B08D3C; font-weight: 700; }
  .party-name { font-weight: 700; }
  .party-meta { font-size: 10pt; color: #444; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10.5pt; }
  table.terms th { text-align: left; width: 38%; padding: 5px 8px; background: #FAF7F0; border: 1px solid #E5DCC7; }
  table.terms td { padding: 5px 8px; border: 1px solid #E5DCC7; }
  table.schedule th, table.schedule td { padding: 5px 8px; border: 1px solid #E5DCC7; text-align: left; }
  table.schedule thead th { background: #FAF7F0; }
  .signatures { margin-top: 40px; display: flex; gap: 40px; flex-wrap: wrap; page-break-inside: avoid; }
  .sign-block { flex: 1 1 210px; }
  .sign-line { border-bottom: 1px solid #333; height: 42px; margin-bottom: 6px; }
  .sign-name { font-weight: 700; font-size: 10.5pt; }
  .sign-meta { font-size: 9pt; color: #555; }
  footer.doc-foot { margin-top: 28px; padding-top: 8px; border-top: 1px solid #E5DCC7; font-size: 8.5pt; color: #777; }
  ${
    watermark
      ? `.watermark {
      position: fixed; top: 45%; left: 50%;
      transform: translate(-50%, -50%) rotate(-32deg);
      font-size: 82pt; font-weight: 700; color: rgba(176,141,60,0.10);
      pointer-events: none; z-index: 0; letter-spacing: .08em; white-space: nowrap;
    }`
      : ""
  }
  @media print { .no-print { display: none; } body { background: #fff; } }
</style>
</head>
<body>
${watermark ? `<div class="watermark">${escapeHtml(watermark)}</div>` : ""}
<div class="doc">
  <header class="doc-head">
    <h1 class="doc-title">${escapeHtml(title)}</h1>
    <div class="doc-meta">
      ${contractNumber ? `<span><strong>Ref:</strong> ${escapeHtml(contractNumber)}</span>` : ""}
      <span><strong>Status:</strong> ${escapeHtml(status)}</span>
      <span><strong>Version:</strong> ${escapeHtml(versionNumber)}</span>
      <span><strong>Generated:</strong> ${escapeHtml(new Date().toISOString().slice(0, 10))}</span>
    </div>
  </header>

  ${partiesHtml}
  ${commercialsHtml}
  ${sectionsHtml}

  ${
    signatureBlocks
      ? `<section class="signatures-wrap">
      <h2>Execution</h2>
      <div class="signatures">${signatureBlocks}</div>
    </section>`
      : ""
  }

  <footer class="doc-foot">
    Generated by Ordence · Version ${escapeHtml(versionNumber)} ·
    This document is system-generated and forms part of the contract record.
  </footer>
</div>
</body>
</html>`;
}
