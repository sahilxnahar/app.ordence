/**
 * Ordence — Transactional Email Templates
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THESE ARE HTML STRING BUILDERS AND NOT REACT EMAIL COMPONENTS
 * ══════════════════════════════════════════════════════════════════════
 * `react-email` is a good library. It is the wrong tool here, for reasons
 * specific to this stack rather than any general objection:
 *
 *   1. BUNDLE AND COLD START. It pulls React rendering into the serverless
 *      function that sends mail. On the Hobby plan, function size and cold
 *      start are real constraints, and a period-close notification is not
 *      worth paying them on every invocation.
 *
 *   2. EMAIL HTML IS NOT WEB HTML. Outlook renders with Microsoft Word's
 *      engine. Gmail strips <style> blocks. The layout below is nested
 *      tables with inline styles because that is what actually renders —
 *      and a component abstraction over table hacks tends to hide exactly
 *      the details that break.
 *
 *   3. TYPE SAFETY IS THE PART THAT MATTERS, and a typed function
 *      signature gives it without a renderer.
 *
 * If rich templates become a product need, `react-email` is the right
 * upgrade. Today it would be weight without benefit.
 *
 * ══════════════════════════════════════════════════════════════════════
 * EVERY INTERPOLATED VALUE IS ESCAPED. NO EXCEPTIONS.
 * ══════════════════════════════════════════════════════════════════════
 * Contract titles, contact names and period names are all tenant-supplied.
 * A contact named `<img src=x onerror=...>` must not become markup in an
 * email that lands in someone's inbox. Mail clients vary wildly in what
 * they execute, and "probably inert" is not a security posture.
 *
 * `esc()` is applied to every single interpolation below. When adding a
 * field, escape it — the absence of a template literal without `esc()` is
 * a property this file is meant to preserve, and there is a test asserting
 * it.
 */

/* ------------------------------------------------------------------ */
/* ESCAPING                                                            */
/* ------------------------------------------------------------------ */

/**
 * Escape a value for safe interpolation into HTML.
 *
 * The five characters below are the complete set needed to prevent an
 * attacker-controlled string from becoming markup or breaking out of an
 * attribute value. Single and double quotes are both escaped because
 * attribute quoting style varies across this file's history.
 */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a URL for use in an `href`.
 *
 * Escaping alone is not enough here. `javascript:alert(1)` contains no
 * HTML-special characters, so `esc()` would pass it through untouched, and
 * some mail clients — and every webmail preview that renders in a browser
 * — will happily execute it.
 *
 * So the SCHEME is checked against an allowlist first. Anything that is not
 * http, https or mailto becomes "#".
 */
export function escUrl(value: string): string {
  const trimmed = String(value ?? "").trim();

  // Control characters stripped FIRST, written as explicit escapes.
  // "java\u0009script:alert(1)" is executed by real browsers — a tab
  // inside the scheme is ignored during parsing but defeats a naive
  // prefix check. This codebase shipped exactly that bug once before.
  // eslint-disable-next-line no-control-regex
  const withoutControls = trimmed.replace(/[\u0000-\u001F\u007F]/g, "");

  if (!/^(https?:|mailto:)/i.test(withoutControls)) return "#";
  return esc(withoutControls);
}

/* ------------------------------------------------------------------ */
/* SHARED CHROME                                                       */
/* ------------------------------------------------------------------ */

const BRAND = {
  gold: "#B8935A",
  ink: "#1A1A1A",
  muted: "#6B6B6B",
  border: "#E5E1DA",
  paper: "#FFFFFF",
  wash: "#FAF8F5",
} as const;

/**
 * The outer table shell every template shares.
 *
 * Tables rather than divs, inline styles rather than classes, and a fixed
 * 600px width — the three things that make an email render the same in
 * Outlook, Gmail and Apple Mail. This is not old-fashioned markup; it is
 * the markup that works.
 */
function shell(params: {
  title: string;
  preheader: string;
  body: string;
  footerNote?: string;
}): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${esc(params.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.wash};">

  <!-- Preheader: the grey preview text next to the subject line in an
       inbox list. Hidden in the body itself. Without it, clients show the
       first visible words, which is usually the company name repeated. -->
  <div style="display:none;font-size:1px;color:${BRAND.wash};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    ${esc(params.preheader)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.wash};">
    <tr>
      <td align="center" style="padding:32px 12px;">

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background-color:${BRAND.paper};border:1px solid ${BRAND.border};border-radius:8px;">

          <tr>
            <td style="padding:28px 32px 20px 32px;border-bottom:1px solid ${BRAND.border};">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;color:${BRAND.ink};letter-spacing:0.3px;">
                Ordence
              </div>
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${BRAND.muted};letter-spacing:1.4px;text-transform:uppercase;padding-top:3px;">
                Operating System
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 32px 32px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${BRAND.ink};">
              ${params.body}
            </td>
          </tr>

          <tr>
            <td style="padding:18px 32px 24px 32px;border-top:1px solid ${BRAND.border};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${BRAND.muted};">
              ${params.footerNote ? `<p style="margin:0 0 8px 0;">${params.footerNote}</p>` : ""}
              <p style="margin:0;">This is an automated message from Ordence. Please do not reply to this address.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A bulletproof-ish call-to-action button. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr>
      <td align="center" bgcolor="${BRAND.gold}" style="border-radius:6px;">
        <a href="${escUrl(href)}"
           style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:6px;">
          ${esc(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

/** A label/value row for the detail tables. */
function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 16px 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.muted};white-space:nowrap;vertical-align:top;">${esc(label)}</td>
    <td style="padding:6px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.ink};font-weight:bold;">${esc(value)}</td>
  </tr>`;
}

/** The shape every template returns. */
export type RenderedEmail = {
  subject: string;
  html: string;
  /**
   * A plain-text alternative.
   *
   * Not optional politeness: a message with no text part scores worse with
   * spam filters, and some corporate mail gateways strip HTML entirely.
   * A legal notification that silently arrives blank is worse than one that
   * arrives plain.
   */
  text: string;
};

/* ------------------------------------------------------------------ */
/* 1. CONTRACT READY                                                   */
/* ------------------------------------------------------------------ */

export type ContractReadyEmailProps = {
  /** Who is being written to. */
  recipientName: string;
  /** The tenant's own name — the sender as far as the reader is concerned. */
  organizationName: string;
  contractTitle: string;
  contractNumber?: string | null;
  contractType?: string | null;
  /** Formatted for display, e.g. "₹45,00,000.00". Never a raw float. */
  contractValue?: string | null;
  effectiveDate?: string | null;
  /**
   * Absolute URL where the contract can be reviewed.
   *
   * From Phase 9 this is a SECURE PORTAL URL (`/portal/<token>`), not an
   * internal app route. The recipient has no Clerk account — a link to
   * `/contracts/<id>` would bounce them to a sign-in page they can never
   * get past, which is exactly the dead end this phase existed to remove.
   */
  reviewUrl: string;
  /** When the portal link stops working, e.g. "2026-08-14". */
  portalExpiresAt?: string | null;
  /** Whether this link lets the recipient sign, or only read. */
  canSign?: boolean;
  /** Optional note typed by the sender. */
  message?: string | null;
  senderName?: string | null;
};

export function renderContractReadyEmail(
  props: ContractReadyEmailProps,
): RenderedEmail {
  const action = props.canSign ? "review and signature" : "review";
  const subject = props.contractNumber
    ? `${props.contractTitle} (${props.contractNumber}) is ready for your ${action}`
    : `${props.contractTitle} is ready for your ${action}`;

  const details: string[] = [];
  if (props.contractNumber) details.push(detailRow("Reference", props.contractNumber));
  if (props.contractType) details.push(detailRow("Type", props.contractType));
  if (props.contractValue) details.push(detailRow("Value", props.contractValue));
  if (props.effectiveDate) details.push(detailRow("Effective from", props.effectiveDate));

  const detailTable =
    details.length > 0
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;background-color:${BRAND.wash};border:1px solid ${BRAND.border};border-radius:6px;padding:8px 16px;width:100%;">
           ${details.join("")}
         </table>`
      : "";

  const senderNote = props.message
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">
         <tr>
           <td style="border-left:3px solid ${BRAND.gold};padding:4px 0 4px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-style:italic;color:${BRAND.ink};">
             ${esc(props.message)}
           </td>
         </tr>
       </table>`
    : "";

  const body = `
    <p style="margin:0 0 16px 0;">Dear ${esc(props.recipientName)},</p>

    <p style="margin:0 0 16px 0;">
      A draft of <strong>${esc(props.contractTitle)}</strong> has been prepared by
      ${esc(props.organizationName)} and is ready for your review.
    </p>

    ${detailTable}
    ${senderNote}

    ${button(props.reviewUrl, props.canSign ? "Review &amp; sign the document" : "Review the document")}

    <p style="margin:16px 0 0 0;font-size:13px;color:${BRAND.muted};">
      If the button does not work, copy this link into your browser:<br />
      <span style="word-break:break-all;">${esc(props.reviewUrl)}</span>
    </p>

    <!-- The security notice is not boilerplate. A recipient who understands
         that the link is personal and expiring is far less likely to forward
         it to a group inbox — which is the single most likely way a portal
         token leaks in practice. -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0 0;">
      <tr>
        <td style="background-color:${BRAND.wash};border:1px solid ${BRAND.border};border-radius:6px;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:${BRAND.muted};">
          <strong style="color:${BRAND.ink};">This link is personal to you.</strong><br />
          It opens the document without a password, so please do not forward
          this email.${props.portalExpiresAt ? ` The link stops working after ${esc(props.portalExpiresAt)}.` : ""}
          ${props.canSign ? " Signing through it can be done once." : ""}
        </td>
      </tr>
    </table>

    <p style="margin:20px 0 0 0;">
      ${props.senderName ? `${esc(props.senderName)}<br />` : ""}${esc(props.organizationName)}
    </p>`;

  const text = [
    `Dear ${props.recipientName},`,
    "",
    `A draft of "${props.contractTitle}" has been prepared by ${props.organizationName} and is ready for your review.`,
    "",
    props.contractNumber ? `Reference: ${props.contractNumber}` : "",
    props.contractType ? `Type: ${props.contractType}` : "",
    props.contractValue ? `Value: ${props.contractValue}` : "",
    props.effectiveDate ? `Effective from: ${props.effectiveDate}` : "",
    "",
    props.message ? `Note: ${props.message}` : "",
    "",
    props.canSign
      ? `Review and sign here: ${props.reviewUrl}`
      : `Review it here: ${props.reviewUrl}`,
    "",
    "This link is personal to you and opens the document without a password.",
    "Please do not forward this email." +
      (props.portalExpiresAt ? ` The link stops working after ${props.portalExpiresAt}.` : ""),
    "",
    props.senderName ? props.senderName : "",
    props.organizationName,
    "",
    "This is an automated message from Ordence. Please do not reply to this address.",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  return {
    subject,
    text,
    html: shell({
      title: subject,
      preheader: `${props.contractTitle} is ready for your review.`,
      body,
      footerNote: `You received this because ${esc(props.organizationName)} shared a document with you.`,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 2. LEDGER ALERT — PERIOD CLOSE                                      */
/* ------------------------------------------------------------------ */

export type LedgerAlertEmailProps = {
  recipientName: string;
  organizationName: string;
  periodName: string;
  periodStart: string;
  periodEnd: string;
  /** Formatted strings. Money is never a float anywhere in this system. */
  totalDebits: string;
  totalCredits: string;
  isBalanced: boolean;
  /** Present and non-zero only when the books did not agree. */
  difference?: string | null;
  closedByName: string;
  closedAt: string;
  /** Whether the closer explicitly overrode an unbalanced trial balance. */
  wasForced: boolean;
  closingNotes?: string | null;
  dashboardUrl: string;
};

export function renderLedgerAlertEmail(props: LedgerAlertEmailProps): RenderedEmail {
  // The subject carries the verdict. An accountant scanning an inbox should
  // not have to open the message to learn the books did not balance.
  const subject = props.isBalanced
    ? `Period closed: ${props.periodName} — books balanced`
    : `⚠ Period closed UNBALANCED: ${props.periodName}`;

  const verdictBanner = props.isBalanced
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">
         <tr>
           <td style="background-color:#F0F7F2;border:1px solid #B8D8C2;border-radius:6px;padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1F5130;">
             <strong>The trial balance agreed.</strong> Debits equal credits for this period.
           </td>
         </tr>
       </table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">
         <tr>
           <td style="background-color:#FDF2F2;border:1px solid #E8B4B4;border-radius:6px;padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#8B2020;">
             <strong>This period was closed while OUT OF BALANCE${props.wasForced ? " — the balance check was deliberately overridden" : ""}.</strong>
             ${props.difference ? `<br />Difference: ${esc(props.difference)}` : ""}
             <br /><br />These figures are now locked. Corrections must be posted as a
             reversing entry in an open period.
           </td>
         </tr>
       </table>`;

  const notes = props.closingNotes
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;">
         <tr>
           <td style="border-left:3px solid ${BRAND.border};padding:4px 0 4px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${BRAND.muted};">
             <strong style="color:${BRAND.ink};">Closing notes</strong><br />${esc(props.closingNotes)}
           </td>
         </tr>
       </table>`
    : "";

  const body = `
    <p style="margin:0 0 16px 0;">Dear ${esc(props.recipientName)},</p>

    <p style="margin:0 0 16px 0;">
      The accounting period <strong>${esc(props.periodName)}</strong> has been closed
      for ${esc(props.organizationName)}.
    </p>

    ${verdictBanner}

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;background-color:${BRAND.wash};border:1px solid ${BRAND.border};border-radius:6px;padding:8px 16px;">
      ${detailRow("Period", `${props.periodStart} to ${props.periodEnd}`)}
      ${detailRow("Total debits", props.totalDebits)}
      ${detailRow("Total credits", props.totalCredits)}
      ${detailRow("Closed by", props.closedByName)}
      ${detailRow("Closed at", props.closedAt)}
    </table>

    ${notes}

    <p style="margin:16px 0 0 0;">
      From now on the database will reject any entry dated inside this period —
      including back-dated corrections by an administrator. That is intended: it
      is what makes a closed period mean something.
    </p>

    ${button(props.dashboardUrl, "Open the accounting dashboard")}`;

  const text = [
    `Dear ${props.recipientName},`,
    "",
    `The accounting period "${props.periodName}" has been closed for ${props.organizationName}.`,
    "",
    props.isBalanced
      ? "The trial balance agreed. Debits equal credits for this period."
      : `WARNING: This period was closed while OUT OF BALANCE${props.wasForced ? " (the balance check was deliberately overridden)" : ""}.${props.difference ? ` Difference: ${props.difference}` : ""}`,
    "",
    `Period:        ${props.periodStart} to ${props.periodEnd}`,
    `Total debits:  ${props.totalDebits}`,
    `Total credits: ${props.totalCredits}`,
    `Closed by:     ${props.closedByName}`,
    `Closed at:     ${props.closedAt}`,
    "",
    props.closingNotes ? `Closing notes: ${props.closingNotes}` : "",
    "",
    "From now on the database will reject any entry dated inside this period, including back-dated corrections by an administrator.",
    "",
    `Accounting dashboard: ${props.dashboardUrl}`,
    "",
    "This is an automated message from Ordence. Please do not reply to this address.",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  return {
    subject,
    text,
    html: shell({
      title: subject,
      preheader: props.isBalanced
        ? `${props.periodName} closed. Debits equal credits.`
        : `${props.periodName} closed while out of balance.`,
      body,
      footerNote: "You received this because you are listed as a finance contact for this workspace.",
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 3. THE DUNNING LETTER                                               */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE MESSAGE THAT CHASES MONEY AN SMB IS OWED.
 *
 * 🔴 IT EXISTS BECAUSE UNTIL NOW THERE WAS NOTHING TO SEND. The sweep in
 * `server/actions/credit.ts` wrote a row saying a reminder had been
 * queued and its own header admitted "there is no SMTP call, no Resend
 * call and no webhook anywhere below". The owner believed they were
 * chasing; the customer had heard nothing.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE TONE IS A DESIGN DECISION, NOT A DRAFTING PREFERENCE
 * ══════════════════════════════════════════════════════════════════════
 * This letter goes to a CUSTOMER THE BUSINESS WANTS TO KEEP. An Indian
 * SMB chasing a ₹4,00,000 invoice is usually chasing somebody they will
 * sell to again next quarter, often somebody they know personally. So:
 *
 *   · No threats, and no invented consequence. The stage's own label
 *     carries the escalation; the words do not need to add to it.
 *   · The figures are stated once and are the ones on the invoice.
 *   · "If this has already been paid, please ignore this" is in every
 *     letter. Payments cross reminders constantly in a business that
 *     reconciles weekly, and a reminder that cannot be wrong reads as an
 *     accusation.
 *
 * ⚠️ NO PAYMENT LINK AND NO BANK DETAILS. Account numbers in an automated
 * email are the single most impersonated thing in Indian B2B fraud, and a
 * letter that trains a customer to pay whatever account arrives by mail
 * is a letter that eventually costs them the invoice twice.
 */
export type DunningLetterEmailProps = {
  /** Who is being written to. May be null — a company can be a recipient. */
  recipientName: string | null;
  /** The tenant's own name. The sender, as far as the reader is concerned. */
  organizationName: string;
  customerName: string;
  invoiceNumber: string;
  /** Formatted for display, e.g. "₹4,00,000.00". Never a raw float. */
  amountDue: string;
  dueDate: string | null;
  daysPastDue: number;
  /** The rung's own name, e.g. "Second reminder". */
  stageLabel: string;
  /** Who to reply to about it. Optional. */
  contactLine?: string | null;
};

export function renderDunningLetterEmail(props: DunningLetterEmailProps): RenderedEmail {
  const greeting = props.recipientName?.trim()
    ? `Dear ${props.recipientName.trim()},`
    : `Dear ${props.customerName},`;

  /*
   * ⚠️ THE SUBJECT NAMES THE INVOICE, NOT THE STAGE. "Second reminder"
   * in a subject line tells the recipient's colleagues how many times
   * they have been chased; the invoice number tells the accounts payable
   * clerk which document to look up. Only one of those helps get paid.
   */
  const subject = `${props.organizationName} — invoice ${props.invoiceNumber} is outstanding`;

  const ageSentence =
    props.daysPastDue > 0
      ? `It was due on ${props.dueDate ?? "the agreed date"} and is now ${props.daysPastDue} day${props.daysPastDue === 1 ? "" : "s"} past due.`
      : `It is due on ${props.dueDate ?? "the agreed date"}.`;

  const body = `
    <p style="margin:0 0 16px 0;">${esc(greeting)}</p>
    <p style="margin:0 0 16px 0;">
      This is a reminder about invoice <strong>${esc(props.invoiceNumber)}</strong>
      from ${esc(props.organizationName)}. ${esc(ageSentence)}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
      ${detailRow("Invoice", props.invoiceNumber)}
      ${detailRow("Amount outstanding", props.amountDue)}
      ${detailRow("Due date", props.dueDate ?? "—")}
      ${detailRow("Days past due", String(props.daysPastDue))}
      ${detailRow("Account", props.customerName)}
    </table>
    <p style="margin:0 0 16px 0;">
      If payment has already been made, please ignore this message — it may have
      crossed with your remittance. If there is a query on the invoice, replying
      to whoever sent it is the fastest way to settle it.
    </p>
    ${props.contactLine ? `<p style="margin:0 0 16px 0;">${esc(props.contactLine)}</p>` : ""}
    <p style="margin:0;">Thank you,<br/>${esc(props.organizationName)}</p>
  `;

  const text = [
    greeting,
    "",
    `This is a reminder about invoice ${props.invoiceNumber} from ${props.organizationName}. ${ageSentence}`,
    "",
    `Invoice:            ${props.invoiceNumber}`,
    `Amount outstanding: ${props.amountDue}`,
    `Due date:           ${props.dueDate ?? "—"}`,
    `Days past due:      ${props.daysPastDue}`,
    `Account:            ${props.customerName}`,
    "",
    "If payment has already been made, please ignore this message — it may have crossed with your remittance. If there is a query on the invoice, replying to whoever sent it is the fastest way to settle it.",
    props.contactLine ? "" : "",
    props.contactLine ?? "",
    "",
    `Thank you,`,
    props.organizationName,
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");

  return {
    subject,
    text,
    html: shell({
      title: subject,
      preheader: `Invoice ${props.invoiceNumber} — ${props.amountDue} outstanding.`,
      body,
      footerNote: `Sent on behalf of ${props.organizationName}. ${props.stageLabel}.`,
    }),
  };
}
