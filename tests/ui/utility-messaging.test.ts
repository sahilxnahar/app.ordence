/**
 * ⭐⭐⭐ FRONT OFFICE, BATCH 8 — UTILITY MESSAGING.
 *
 * 🔴 THE FIVE FAILURES THIS SUITE PINS DOWN.
 *
 *   ① `dunning_events.channel = 'whatsapp'` has been a CLAIM since 0027.
 *      The table exists to be evidence that a buyer was given every
 *      chance, the row is written by a person ticking a box, and nothing
 *      ever left the building. A gap in evidence is a gap; evidence of
 *      something that did not happen is a different problem, and the
 *      other side finds it.
 *
 *   ② Booking the cost at send time. Meta charges **only when a message
 *      is delivered**, so a send to a dead number costs nothing — and a
 *      spend ceiling counting attempts stops a business sending messages
 *      it was never going to be billed for.
 *
 *   ③ Treating a paused template as a transient failure. Meta pauses for
 *      three hours, then six, then **permanently**. A retry loop walks
 *      straight into the third one.
 *
 *   ④ Ignoring the 24 hour window. The identical utility message is free
 *      inside it and charged outside it. Nothing about the message
 *      changes; only the clock.
 *
 *   ⑤ A random idempotency key. A retry after a timeout then sends the
 *      same payment reminder twice, and the second is the one the
 *      customer complains about.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FREE_ENTRY_POINT_HOURS,
  SERVICE_WINDOW_HOURS,
  categoryDrifted,
  mayUseTemplate,
  willBeCharged,
  windowFrom,
  windowIsOpen,
  type ServiceWindow,
  type TemplateSnapshot,
} from "@/lib/messaging/window";
import { estimateBatch, maySendMessage } from "@/lib/messaging/gate";
import {
  MAX_PARAMETER_LENGTH,
  TemplateParameterError,
  checkTemplateBody,
  cleanParameter,
  idempotencyKey,
  renderTemplate,
  variableCountOf,
} from "@/lib/messaging/render";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0066_utility_messaging.sql");
const SQL_CODE = sqlCode(SQL);
const SEND = read("server/messaging/send.ts");
const PAGE = read("app/(crm)/messaging/page.tsx");
const CONSENT = read("lib/crm/consent.ts");

const NOW = new Date("2026-08-13T10:00:00.000Z");

function template(over: Partial<TemplateSnapshot> = {}): TemplateSnapshot {
  return {
    name: "payment_reminder",
    status: "approved",
    category: "utility",
    requestedCategory: "utility",
    variableCount: 2,
    pausedUntil: null,
    pauseCount: 0,
    quality: "green",
    rejectionReason: null,
    ...over,
  };
}

const openWindow: ServiceWindow = {
  openedAt: new Date(NOW.getTime() - 3_600_000),
  expiresAt: new Date(NOW.getTime() + 20 * 3_600_000),
  isFreeEntryPoint: false,
};

/* ================================================================== */
/* ⭐⭐⭐ ① THE CLAIM THAT WAS NEVER TRUE                              */
/* ================================================================== */

describe("⭐⭐ the sender the dunning ladder has been missing since 0027", () => {
  /**
   * 🔴 THE HEADLINE. `dunning_channel` has included `whatsapp` from the
   * start, in a table whose own comment calls it "the evidence that the
   * buyer was given every chance".
   */
  it("links a dunning event to the message that actually carried it", () => {
    expect(SQL_CODE).toContain("ALTER TABLE dunning_events ADD COLUMN IF NOT EXISTS message_send_id");
  });

  /**
   * ⚠️ NOT `NOT NULL`, AND THAT IS THE POINT. Post, courier and hand
   * delivery are real channels with no message behind them, and they are
   * the ones that actually constitute service under most agreements.
   */
  it("does not demand a message for post, courier or hand delivery", () => {
    expect(SQL_CODE).not.toContain("message_send_id uuid NOT NULL");
    expect(SQL).toContain("which are service in their own right");
  });

  /**
   * 🔴 THE ROW GOES IN BEFORE THE API CALL. A row written afterwards
   * does not exist when the process dies between the send and the
   * insert, and then the message went, the customer got it, we have no
   * record, and the next run sends it again.
   */
  it("writes the send row before it calls WhatsApp", () => {
    const fn = SEND.slice(SEND.indexOf("export async function sendUtilityMessage"));
    expect(fn.indexOf(".insert(messageSends)")).toBeLessThan(fn.indexOf("doFetch("));
  });

  /** 🔴 A sent message is evidence and cannot be deleted. */
  it("refuses to delete a sent message", () => {
    expect(SQL_CODE).toContain("A sent message cannot be deleted");
  });

  /**
   * ⚠️ THE RENDERED TEXT IS WHAT THE PERSON RECEIVED. "Template X with
   * parameters A, B" is not, and the template will have been edited by
   * the time anybody asks.
   */
  it("freezes what was actually sent", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF NEW.rendered_body IS DISTINCT FROM OLD.rendered_body",
    );
  });
});

/* ================================================================== */
/* ⭐⭐ ② BILLED ON DELIVERY, NOT ON SEND                              */
/* ================================================================== */

describe("⭐⭐ the money is only real on delivery", () => {
  /**
   * 🔴 META CHARGES "ONLY WHEN A TEMPLATE MESSAGE IS DELIVERED". A cost
   * booked at send time counts messages that were never charged.
   */
  it("refuses a cost on anything that was not delivered", () => {
    expect(flat(SQL_CODE)).toContain(
      "CONSTRAINT message_sends_cost_follows_delivery CHECK ( cost_minor IS NULL OR delivered_at IS NOT NULL )",
    );
  });

  it("does not write a cost when the send succeeds", () => {
    const afterSend = SEND.slice(
      SEND.indexOf('status: "sent",'),
      SEND.indexOf("return { ok: true, sendId"),
    );
    expect(code(afterSend)).not.toContain("costMinor");
  });

  it("writes the cost only from the delivery receipt", () => {
    const apply = SEND.slice(SEND.indexOf("export async function applyStatus"));
    const delivered = apply.slice(apply.indexOf('update.status === "delivered"'));
    expect(delivered).toContain("patch.costMinor");
  });

  /**
   * 🔴 A REPEATED DELIVERY RECEIPT MUST NOT DOUBLE THE SPEND. Providers
   * resend callbacks.
   */
  it("records the cost once and refuses to change it", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF OLD.cost_minor IS NOT NULL AND NEW.cost_minor IS DISTINCT FROM OLD.cost_minor THEN",
    );
  });

  /**
   * ⚠️ RECEIPTS ARRIVE OUT OF ORDER. A `sent` callback landing after a
   * `delivered` one must not walk the row backwards, or a delivered
   * message reports as merely sent and its cost is lost.
   */
  it("refuses to make a delivered message undelivered", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS NULL THEN",
    );
  });

  it("keeps the state order the database can rely on", () => {
    expect(flat(SQL_CODE)).toContain(
      "(delivered_at IS NULL OR sent_at IS NOT NULL) AND (read_at IS NULL OR delivered_at IS NOT NULL)",
    );
  });

  /** ⭐ And the screen says it in words, because it explains the bill. */
  it("explains delivery billing on the screen", () => {
    expect(flat(PAGE)).toContain("charges when a message is");
    expect(PAGE).toContain("did not arrive cost nothing");
  });

  /**
   * ⚠️ TWO FACTS v1.10.0 GOT WRONG, corrected now that something
   * actually sends: the billing change was 1 July 2025, and the charge
   * lands on delivery rather than on send.
   */
  it("corrects the date and the billing point in the consent library", () => {
    expect(CONSENT).toContain("1 July\n *    2025");
    expect(CONSENT).toContain("META CHARGES ON DELIVERY, NOT ON SEND");
  });
});

/* ================================================================== */
/* ⭐⭐ ③ A PAUSE IS NOT A FAILURE                                     */
/* ================================================================== */

describe("⭐⭐ templates", () => {
  it("sends an approved template", () => {
    expect(mayUseTemplate(template(), NOW).maySend).toBe(true);
  });

  /**
   * 🔴 THREE HOURS, THEN SIX, THEN PERMANENT. A retry loop that treats a
   * pause as a transient error walks into `disabled`, which cannot be
   * undone and takes the message with it.
   */
  it("treats a pause as retryable, with a time", () => {
    const until = new Date(NOW.getTime() + 3 * 3_600_000);
    const gate = mayUseTemplate(
      template({ status: "paused", pausedUntil: until, pauseCount: 1 }),
      NOW,
    );
    expect(gate.maySend).toBe(false);
    expect(gate.retryable).toBe(true);
    expect(gate.retryAfter).toEqual(until);
  });

  /** ⚠️ And the second pause says loudly what the third one means. */
  it("warns that a third pause is permanent", () => {
    const gate = mayUseTemplate(
      template({ status: "paused", pausedUntil: NOW, pauseCount: 2 }),
      NOW,
    );
    expect(gate.reason).toContain("third pause disables it permanently");
    expect(gate.actionRequired).toContain("gone for good");
  });

  /** 🔴 A rejection is not retryable. The same text is rejected again. */
  it("does not offer to retry a rejected template", () => {
    const gate = mayUseTemplate(
      template({ status: "rejected", rejectionReason: "Promotional content" }),
      NOW,
    );
    expect(gate.retryable).toBe(false);
    expect(gate.reason).toContain("Promotional content");
  });

  it("says a disabled template is the end of the road", () => {
    const gate = mayUseTemplate(template({ status: "disabled" }), NOW);
    expect(gate.retryable).toBe(false);
    expect(gate.actionRequired).toContain("cannot be undone");
  });

  /**
   * ⭐ APPROVED BUT ON RED IS NOT BLOCKED — Meta still permits it — and
   * it is the last warning before a pause. A product that says nothing
   * here is one whose customer finds out when the template dies.
   */
  it("lets a low-quality template send but says what is coming", () => {
    const gate = mayUseTemplate(template({ quality: "red" }), NOW);
    expect(gate.maySend).toBe(true);
    expect(gate.actionRequired).toContain("automatic pause");
  });

  /**
   * 🔴 META RE-CATEGORISES AND THE PRICE FOLLOWS. Nothing else in the
   * world tells the business this happened; the bill does, a month later.
   */
  it("reports a template Meta moved to marketing", () => {
    const drift = categoryDrifted(
      template({ requestedCategory: "utility", category: "marketing" }),
    );
    expect(drift).toContain("submitted as utility");
    expect(drift).toContain("never free");
  });

  it("says nothing when the category is what was asked for", () => {
    expect(categoryDrifted(template())).toBeNull();
  });

  it("refuses a rejected template with no reason at the database", () => {
    expect(flat(SQL_CODE)).toContain(
      "status <> 'rejected' OR rejection_reason IS NOT NULL",
    );
  });

  it("demands an end date on a pause, like a locked connection", () => {
    expect(flat(SQL_CODE)).toContain(
      "status <> 'paused' OR paused_until IS NOT NULL",
    );
  });
});

/* ================================================================== */
/* ⭐⭐ ④ THE CLOCK DECIDES THE PRICE                                  */
/* ================================================================== */

describe("⭐⭐ the 24 hour window", () => {
  it("runs 24 hours from their message", () => {
    const w = windowFrom(NOW);
    expect(SERVICE_WINDOW_HOURS).toBe(24);
    expect(w.expiresAt.getTime() - NOW.getTime()).toBe(24 * 3_600_000);
  });

  /** ⭐ An ad click opens 72 hours, and everything inside it is free. */
  it("runs 72 hours from an ad click", () => {
    const w = windowFrom(NOW, { freeEntryPoint: true });
    expect(FREE_ENTRY_POINT_HOURS).toBe(72);
    expect(w.expiresAt.getTime() - NOW.getTime()).toBe(72 * 3_600_000);
  });

  /**
   * 🔴 THE SAME MESSAGE, FREE OR CHARGED, DEPENDING ON A CLOCK. Nothing
   * about it changes.
   */
  it("makes a utility template free inside the window and charged outside", () => {
    expect(willBeCharged("utility", openWindow, NOW).chargeable).toBe(false);
    expect(willBeCharged("utility", null, NOW).chargeable).toBe(true);
  });

  /** ⚠️ And the charged answer names the thing that would have saved it. */
  it("says how the charge could have been avoided", () => {
    expect(willBeCharged("utility", null, NOW).reason).toContain(
      "still in conversation would be free",
    );
  });

  /** 🔴 Marketing is never free inside an ordinary window. */
  it("charges marketing even inside the 24 hour window", () => {
    const v = willBeCharged("marketing", openWindow, NOW);
    expect(v.chargeable).toBe(true);
    expect(v.reason).toContain("never free");
  });

  /** ⭐ But everything is free inside a free entry point window. */
  it("makes even marketing free inside the 72 hour window", () => {
    const free: ServiceWindow = { ...openWindow, isFreeEntryPoint: true };
    expect(willBeCharged("marketing", free, NOW).chargeable).toBe(false);
  });

  /**
   * ⚠️ A PLAIN REPLY OUTSIDE THE WINDOW IS NOT EXPENSIVE. It is
   * impossible, and saying "free" would be a lie that produces a silent
   * failure.
   */
  it("says a plain reply outside the window cannot be sent at all", () => {
    const v = willBeCharged("service", null, NOW);
    expect(v.chargeable).toBe(false);
    expect(v.reason).toContain("Cannot be sent");
  });

  it("closes an expired window", () => {
    const expired: ServiceWindow = {
      ...openWindow,
      expiresAt: new Date(NOW.getTime() - 1),
    };
    expect(windowIsOpen(expired, NOW)).toBe(false);
    expect(windowIsOpen(null, NOW)).toBe(false);
  });

  /**
   * ⭐ A SECOND INBOUND MESSAGE EXTENDS THE WINDOW AND NEVER SHORTENS
   * IT. Moving the expiry backwards would close a window that is
   * genuinely open and start charging for free messages.
   */
  it("never moves the expiry backwards", () => {
    expect(flat(SQL_CODE)).toContain("IF NEW.expires_at < OLD.expires_at THEN");
    expect(SQL_CODE).toContain("NEW.expires_at := OLD.expires_at");
  });

  it("never downgrades a running free entry point window", () => {
    expect(flat(SQL_CODE)).toContain(
      "IF OLD.is_free_entry_point AND OLD.expires_at > now() THEN",
    );
  });

  /** ⭐ And whether the window was open is frozen on the send row. */
  it("records whether the window was open at the moment of sending", () => {
    expect(flat(SQL_CODE)).toContain(
      "NEW.inside_service_window IS DISTINCT FROM OLD.inside_service_window",
    );
  });
});

/* ================================================================== */
/* ⭐⭐ ⑤ THE SAME REMINDER, TWICE                                     */
/* ================================================================== */

describe("⭐⭐ idempotency", () => {
  /**
   * 🔴 DERIVED FROM WHAT THE MESSAGE IS, NOT FROM WHEN IT WAS SENT. Meta
   * returns a message id only in the response, which is no use for
   * deciding whether to send.
   */
  it("produces the same key for the same message", () => {
    const a = idempotencyKey({ subjectType: "demand", subjectId: "D1", purpose: "rung3" });
    const b = idempotencyKey({ subjectType: "demand", subjectId: "D1", purpose: "rung3" });
    expect(a).toBe(b);
  });

  /**
   * ⚠️ AN OCCURRENCE ONLY WHERE A REPEAT IS GENUINELY A DIFFERENT
   * MESSAGE. August's statement is not September's; rung 3 is rung 3
   * however many times the job runs.
   */
  it("separates two months of the same statement", () => {
    const aug = idempotencyKey({ subjectType: "unit", subjectId: "U1", purpose: "statement", occurrence: "2026-08" });
    const sep = idempotencyKey({ subjectType: "unit", subjectId: "U1", purpose: "statement", occurrence: "2026-09" });
    expect(aug).not.toBe(sep);
  });

  it("refuses the same key at the database", () => {
    expect(flat(SQL_CODE)).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS message_sends_idempotency_unique ON message_sends (tenant_id, idempotency_key)",
    );
  });

  /**
   * 🔴 A TIMEOUT IS NOT A FAILURE. We do not know whether it went, so
   * the row stays pending rather than being marked failed and retried
   * into a second copy of a payment reminder.
   */
  it("leaves a timed-out send pending rather than retrying it", () => {
    const catchBlock = SEND.slice(SEND.indexOf('errorCode: "timeout"'));
    expect(catchBlock).toContain("deliberately left pending");
    expect(catchBlock.slice(0, 600)).not.toContain('status: "failed"');
  });

  /** ⭐ And the screen shows that number rather than hiding it. */
  it("shows the ones we genuinely do not know about", () => {
    expect(PAGE).toContain("We do not know");
    expect(PAGE).toContain("may deliver a second");
  });
});

/* ================================================================== */
/* ⭐⭐ ONE GATE, NOT FIVE SCATTERED CHECKS                            */
/* ================================================================== */

describe("⭐⭐ may this message go", () => {
  const caps = {
    sentToday: 0,
    spentTodayMinor: 0n,
    dailySendCap: null,
    dailySpendCapMinor: null,
  };

  const base = {
    category: "utility" as const,
    template: template(),
    window: openWindow,
    consentAllows: true,
    consentReason: "Permitted.",
    toPhoneDigits: "9876543210",
    alreadySent: false,
    caps,
  };

  it("lets a permitted message through", () => {
    const v = maySendMessage(base, NOW);
    expect(v.maySend).toBe(true);
    expect(v.chargeable).toBe(false);
  });

  /**
   * 🔴🔴 CONSENT IS FIRST, ALWAYS. Not because it is cheapest, but
   * because it is the only check where proceeding is a legal wrong
   * rather than an expense.
   */
  it("refuses on consent before anything else", () => {
    const v = maySendMessage(
      {
        ...base,
        consentAllows: false,
        consentReason: "They withdrew consent on 4 March.",
        // ⚠️ Everything else is ALSO wrong here. Consent must still win.
        template: template({ status: "disabled" }),
        toPhoneDigits: null,
        alreadySent: true,
        caps: { ...caps, sentToday: 999, dailySendCap: 10 },
      },
      NOW,
    );
    expect(v.refusalCode).toBe("no_consent");
    expect(v.reason).toContain("withdrew");
  });

  it("refuses when there is no usable number", () => {
    expect(maySendMessage({ ...base, toPhoneDigits: "123" }, NOW).refusalCode).toBe(
      "no_number",
    );
  });

  it("refuses when the template cannot be used", () => {
    const v = maySendMessage(
      { ...base, template: template({ status: "disabled" }) },
      NOW,
    );
    expect(v.refusalCode).toBe("template_unusable");
  });

  it("refuses at the daily send ceiling", () => {
    const v = maySendMessage(
      { ...base, caps: { ...caps, sentToday: 500, dailySendCap: 500 } },
      NOW,
    );
    expect(v.refusalCode).toBe("cap_reached");
  });

  it("refuses at the daily spend ceiling", () => {
    const v = maySendMessage(
      {
        ...base,
        caps: { ...caps, spentTodayMinor: 500_00n, dailySpendCapMinor: 500_00n },
      },
      NOW,
    );
    expect(v.refusalCode).toBe("cap_reached");
  });

  /**
   * ⚠️ APPROACHING THE CEILING IS WORTH SAYING BEFORE IT IS REACHED, so
   * a scheduled run does not stop halfway with no warning.
   */
  it("warns before the ceiling rather than only at it", () => {
    const v = maySendMessage(
      { ...base, caps: { ...caps, sentToday: 90, dailySendCap: 100 } },
      NOW,
    );
    expect(v.maySend).toBe(true);
    expect(v.warnings.some((w) => w.includes("90 of today's 100"))).toBe(true);
  });

  /** ⭐ The least interesting answer comes last. */
  it("reports a duplicate only when nothing else is wrong", () => {
    expect(maySendMessage({ ...base, alreadySent: true }, NOW).refusalCode).toBe(
      "already_sent",
    );
  });

  /** ⚠️ A re-categorisation is a warning, not a block. */
  it("passes the category drift through as a warning", () => {
    const v = maySendMessage(
      {
        ...base,
        window: null,
        template: template({ requestedCategory: "utility", category: "marketing" }),
        category: "marketing",
      },
      NOW,
    );
    expect(v.maySend).toBe(true);
    expect(v.warnings.some((w) => w.includes("classified it as marketing"))).toBe(true);
  });

  /** 🔴 And the sender consults the gate rather than reimplementing it. */
  it("is the only gate the sender uses", () => {
    expect(SEND).toContain("maySendMessage(");
    expect(SEND).toContain("mayContact(");
  });

  /**
   * ⭐ A UTILITY MESSAGE ABOUT SOMETHING THEY BOUGHT DOES NOT NEED
   * MARKETING CONSENT — and the flag that says so is deliberately NOT
   * passed for a marketing template.
   */
  it("does not let a contract unlock marketing", () => {
    expect(SEND).toContain('hasLegitimateContractualBasis: category !== "marketing"');
  });
});

/* ================================================================== */
/* ⭐ THE ESTIMATE, WHICH IS NOT A BILL                                */
/* ================================================================== */

describe("⭐ what it will cost, before", () => {
  it("charges only the ones outside a window", () => {
    const e = estimateBatch({
      recipients: [
        { insideWindow: true, freeEntryPoint: false },
        { insideWindow: false, freeEntryPoint: false },
        { insideWindow: false, freeEntryPoint: false },
      ],
      category: "utility",
      rateMinor: 15n,
    });
    expect(e.chargeable).toBe(2);
    expect(e.free).toBe(1);
    expect(e.estimatedMinor).toBe(30n);
  });

  /**
   * ⭐ THE NUMBER THAT CHANGES BEHAVIOUR IS WHAT THE WINDOW SAVED.
   * Nobody moves a send because it is cheaper; people move it because it
   * is free.
   */
  it("reports what the open windows saved", () => {
    const e = estimateBatch({
      recipients: Array.from({ length: 100 }, (_, i) => ({
        insideWindow: i < 40,
        freeEntryPoint: false,
      })),
      category: "utility",
      rateMinor: 15n,
    });
    expect(e.savedByWindowMinor).toBe(600n);
    expect(e.note).toContain("₹6.00");
  });

  it("charges every marketing recipient regardless of the window", () => {
    const e = estimateBatch({
      recipients: [
        { insideWindow: true, freeEntryPoint: false },
        { insideWindow: false, freeEntryPoint: false },
      ],
      category: "marketing",
      rateMinor: 109n,
    });
    expect(e.chargeable).toBe(2);
    expect(e.estimatedMinor).toBe(218n);
  });
});

/* ================================================================== */
/* ⭐ FILLING IN A TEMPLATE META OWNS                                  */
/* ================================================================== */

describe("⭐ template parameters", () => {
  /**
   * 🔴 THE HIGHEST PLACEHOLDER, NOT HOW MANY THERE ARE. `{{1}} … {{3}}`
   * with no `{{2}}` needs three parameters, and counting occurrences
   * produces a list one short.
   */
  it("counts the highest placeholder", () => {
    expect(variableCountOf("Hello {{1}}, your bill {{3}} is due")).toBe(3);
    expect(variableCountOf("No variables here")).toBe(0);
  });

  it("fills the template and returns the parameter array", () => {
    const r = renderTemplate("Dear {{1}}, ₹{{2}} is overdue. Please pay.", [
      "Ravi",
      "45,000",
    ]);
    expect(r.body).toBe("Dear Ravi, ₹45,000 is overdue. Please pay.");
    expect(r.parameters).toEqual(["Ravi", "45,000"]);
  });

  it("refuses a parameter list that does not match", () => {
    expect(() => renderTemplate("Hi {{1}} and {{2}}, thanks.", ["only one"])).toThrow(
      TemplateParameterError,
    );
    expect(() => renderTemplate("Hi {{1}}, thanks.", ["a", "b"])).toThrow(
      TemplateParameterError,
    );
  });

  /**
   * 🔴 THE ONE THAT BITES IN PRACTICE. The obvious thing to put in a
   * parameter is an address, and an address in a database has newlines
   * in it. Everything works with "Mumbai" and fails on the first real
   * customer.
   *
   * ⭐ So whitespace is COLLAPSED rather than refused: a refusal would
   * mean the payment reminder did not go because of the shape of
   * somebody's address.
   */
  it("collapses newlines in a parameter instead of refusing it", () => {
    expect(cleanParameter("12 MG Road\nPune\n411001")).toBe("12 MG Road Pune 411001");
    expect(cleanParameter("a    b")).toBe("a b");
  });

  it("refuses an empty parameter, which is always a bug at our end", () => {
    expect(() => renderTemplate("Hi {{1}}, thanks.", ["   "])).toThrow(
      TemplateParameterError,
    );
  });

  it("refuses a parameter over Meta's limit", () => {
    expect(() =>
      renderTemplate("Note: {{1}} end.", ["x".repeat(MAX_PARAMETER_LENGTH + 1)]),
    ).toThrow(TemplateParameterError);
  });

  it("names the parameter and the remedy rather than the rule", () => {
    try {
      renderTemplate("Hi {{1}} and {{2}}, thanks.", ["a", ""]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateParameterError);
      if (e instanceof TemplateParameterError) {
        expect(e.position).toBe(2);
        expect(e.remedy).toContain("blank parameter");
      }
    }
  });
});

describe("⭐ Meta's own formatting rules, checked before submission", () => {
  it("refuses a template that starts with a variable", () => {
    const p = checkTemplateBody("{{1}}, your order is ready.");
    expect(p.some((x) => x.problem.includes("starts with a variable"))).toBe(true);
  });

  it("refuses a template that ends with a variable", () => {
    const p = checkTemplateBody("Your order is ready {{1}}");
    expect(p.some((x) => x.problem.includes("ends with a variable"))).toBe(true);
  });

  /** ⚠️ Meta reads adjacent placeholders as smuggling arbitrary content. */
  it("refuses two variables with nothing between them", () => {
    const p = checkTemplateBody("Dear {{1}}{{2}}, thanks for your order.");
    expect(p.some((x) => x.problem.includes("next to each other"))).toBe(true);
  });

  it("refuses a skipped number", () => {
    const p = checkTemplateBody("Dear {{1}}, your total is {{3}} rupees, thanks.");
    expect(p.some((x) => x.problem.includes("no {{2}}"))).toBe(true);
  });

  /**
   * ⭐ THE MOSTLY-VARIABLES CHECK WARNS RATHER THAN REFUSES, because the
   * exact threshold is not published and a rule we invented must not
   * block a template Meta would have approved.
   */
  it("warns about too little fixed text without claiming certainty", () => {
    const p = checkTemplateBody("Hi {{1}} x {{2}} y");
    const warning = p.find((x) => x.problem.includes("very little fixed wording"));
    expect(warning?.remedy).toContain("not published");
  });

  it("passes a well-formed template", () => {
    expect(
      checkTemplateBody("Dear {{1}}, your payment of ₹{{2}} is due tomorrow. Thank you."),
    ).toEqual([]);
  });
});

/* ================================================================== */
/* ⭐ THE CEILING, IN THE DATABASE                                     */
/* ================================================================== */

describe("⭐⭐ a bug in a loop spends real money", () => {
  /**
   * 🔴 ENFORCED BY A TRIGGER, NOT BY THE SENDER. A limit enforced by the
   * code that does the sending is a limit the next code path forgets.
   */
  it("enforces the ceiling at the database", () => {
    expect(SQL_CODE).toContain("FUNCTION ordence_enforce_send_cap");
    expect(SQL_CODE).toContain("BEFORE INSERT ON message_sends");
  });

  /**
   * ⚠️ COUNTED ON ATTEMPTS, NOT ONLY ON DELIVERED SPEND, precisely
   * because spend lags: a runaway loop moves the attempt count
   * immediately and the money figure minutes later.
   */
  it("counts attempts as well as spend", () => {
    const fn = SQL_CODE.slice(
      SQL_CODE.indexOf("FUNCTION ordence_enforce_send_cap"),
      SQL_CODE.indexOf("trg_enforce_send_cap"),
    );
    expect(fn).toContain("v_send_cap");
    expect(fn).toContain("v_spend_cap");
  });

  /** ⭐ A refusal does not count against the ceiling it is the record of. */
  it("does not count a refusal against the ceiling", () => {
    expect(flat(SQL_CODE)).toContain("IF NEW.status = 'refused' THEN RETURN NEW;");
  });

  it("refuses a negative ceiling", () => {
    expect(flat(SQL_CODE)).toContain("CONSTRAINT connections_spend_caps_sane");
  });
});

describe("⭐ 0066's own rules", () => {
  it("demands a reason for a failed or refused send", () => {
    expect(flat(SQL_CODE)).toContain(
      "status NOT IN ('failed', 'refused') OR error_message IS NOT NULL",
    );
  });

  it("puts platform scope in USING and never in WITH CHECK", () => {
    const policies = SQL_CODE.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(3);
    for (const p of policies) {
      expect(p.slice(p.indexOf("WITH CHECK"))).not.toContain("app_platform_scope");
    }
  });
});
