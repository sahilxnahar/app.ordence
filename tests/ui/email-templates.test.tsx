/**
 * Ordence — Email Template Safety
 * Version: v0.8.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY EMAIL DESERVES XSS TESTING AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * It is tempting to assume mail clients are inert. They are not, and more
 * to the point every webmail client renders in a browser. A contract title
 * or contact name is tenant-supplied, and a tenant is not automatically
 * trustworthy — in a multi-tenant CRM, a hostile tenant is a realistic
 * threat model, not a paranoid one.
 *
 * These emails also leave the platform entirely. A payload that lands in a
 * client's inbox is beyond every control this system has.
 */

import { describe, it, expect } from "vitest";
import {
  renderContractReadyEmail,
  renderLedgerAlertEmail,
  esc,
  escUrl,
} from "@/lib/email/templates";

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "'><svg/onload=alert(1)>",
  '<iframe src="javascript:alert(1)">',
  '</td></tr><script>alert(1)</script>',
  '<body onload=alert(1)>',
  '"onmouseover="alert(1)',
];

describe("esc() — HTML escaping", () => {
  it.each(XSS_PAYLOADS)("neutralises %s", (payload) => {
    const escaped = esc(payload);
    expect(escaped).not.toContain("<script");
    expect(escaped).not.toContain("<img");
    expect(escaped).not.toContain("<svg");
    expect(escaped).not.toContain("<iframe");
    // No raw angle bracket survives, so nothing can open a tag.
    expect(escaped).not.toMatch(/[<>]/);
  });

  it("escapes both quote styles so attributes cannot be broken out of", () => {
    expect(esc(`a"b'c`)).toBe("a&quot;b&#39;c");
  });

  it("escapes the ampersand FIRST, so escapes are not double-encoded wrongly", () => {
    // If & were escaped last, "&lt;" produced by the < rule would become
    // "&amp;lt;" and the output would be visibly broken.
    expect(esc("<")).toBe("&lt;");
    expect(esc("&")).toBe("&amp;");
    expect(esc("&<")).toBe("&amp;&lt;");
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

describe("escUrl() — scheme allowlist", () => {
  it.each([
    ["https://ordence.com/contracts/1", "https://ordence.com/contracts/1"],
    ["http://localhost:3000/x", "http://localhost:3000/x"],
    ["mailto:legal@example.com", "mailto:legal@example.com"],
  ])("permits %s", (input, expected) => {
    expect(escUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example.com",
  ])("blocks %s", (input) => {
    // A scheme check that only compared the literal prefix would pass the
    // tab and newline variants — browsers strip those before parsing.
    expect(escUrl(input)).toBe("#");
  });
});

describe("ContractReadyEmail", () => {
  const base = {
    recipientName: "Priya",
    organizationName: "Ordence Developers",
    contractTitle: "Sale Agreement — Unit 304",
    reviewUrl: "https://app.example.com/contracts/abc",
  };

  it("renders a subject, HTML body and plain-text alternative", () => {
    const email = renderContractReadyEmail(base);

    expect(email.subject).toContain("Sale Agreement");
    expect(email.html).toContain("<html");
    // The text part is not optional politeness: a message with no text
    // alternative scores worse with spam filters and arrives blank through
    // gateways that strip HTML.
    expect(email.text.length).toBeGreaterThan(50);
    expect(email.text).not.toContain("<html");
  });

  it.each(XSS_PAYLOADS)("escapes a hostile contract title: %s", (payload) => {
    const email = renderContractReadyEmail({ ...base, contractTitle: payload });

    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).not.toContain("<img src=x onerror");
    expect(email.html).not.toContain("<svg/onload");
    expect(email.html).not.toContain("<iframe src=");
  });

  it("escapes a hostile recipient name", () => {
    const email = renderContractReadyEmail({
      ...base,
      recipientName: '<script>alert("pwned")</script>',
    });
    expect(email.html).not.toContain("<script>");
  });

  it("neutralises a javascript: review URL", () => {
    const email = renderContractReadyEmail({
      ...base,
      reviewUrl: "javascript:alert(document.cookie)",
    });
    // The href is defanged...
    expect(email.html).not.toContain('href="javascript:');
    // ...and the fallback "copy this link" text, which uses esc() rather
    // than escUrl(), must not become clickable markup either.
    expect(email.html).not.toContain("<script");
  });

  it("escapes a hostile covering note", () => {
    const email = renderContractReadyEmail({
      ...base,
      message: '</td></tr><script>alert(1)</script>',
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
  });

  it("omits optional detail rows entirely when absent", () => {
    const email = renderContractReadyEmail(base);
    expect(email.html).not.toContain("Reference");
    expect(email.html).not.toContain("undefined");
    expect(email.html).not.toContain("null");
  });

  it("includes supplied detail rows", () => {
    const email = renderContractReadyEmail({
      ...base,
      contractNumber: "AH-2026-0041",
      contractValue: "₹45,00,000.00",
    });
    expect(email.html).toContain("AH-2026-0041");
    expect(email.html).toContain("45,00,000.00");
    expect(email.text).toContain("AH-2026-0041");
  });
});

describe("LedgerAlertEmail", () => {
  const base = {
    recipientName: "Finance team",
    organizationName: "Ordence Developers",
    periodName: "FY2026 Q1",
    periodStart: "2026-04-01",
    periodEnd: "2026-06-30",
    totalDebits: "₹1,20,00,000.00",
    totalCredits: "₹1,20,00,000.00",
    isBalanced: true,
    closedByName: "R. Sharma",
    closedAt: "2026-07-31 18:04",
    wasForced: false,
    dashboardUrl: "https://app.example.com/accounting",
  };

  it("states a balanced close plainly in the subject", () => {
    const email = renderLedgerAlertEmail(base);
    expect(email.subject).toContain("balanced");
    expect(email.subject).not.toContain("UNBALANCED");
  });

  it("puts the warning in the SUBJECT when the books did not agree", () => {
    // An accountant scanning an inbox should not have to open the message
    // to learn the period was closed out of balance.
    const email = renderLedgerAlertEmail({
      ...base,
      isBalanced: false,
      difference: "₹1,250.00",
      wasForced: true,
    });

    expect(email.subject).toContain("UNBALANCED");
    expect(email.html).toContain("1,250.00");
    expect(email.html).toContain("deliberately overridden");
    expect(email.text).toContain("OUT OF BALANCE");
  });

  it("escapes a hostile period name", () => {
    const email = renderLedgerAlertEmail({
      ...base,
      periodName: '<img src=x onerror=alert(1)>',
    });
    expect(email.html).not.toContain("<img src=x onerror");
  });

  it("escapes hostile closing notes", () => {
    const email = renderLedgerAlertEmail({
      ...base,
      closingNotes: '<script>fetch("//evil")</script>',
    });
    expect(email.html).not.toContain("<script>");
  });

  it("always produces both an HTML and a text part", () => {
    const email = renderLedgerAlertEmail(base);
    expect(email.html).toContain("<html");
    expect(email.text).toContain("FY2026 Q1");
    expect(email.text).not.toContain("<html");
  });
});
