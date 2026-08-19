/**
 * ⭐⭐ LEGAL, BATCH 1 — LIMITATION, THE DIARY, AND CLIENT MONEY.
 *
 * 🔴 THESE ARE THE HIGHEST-CONSEQUENCE TESTS IN THE PRODUCT. Every other
 *    deadline in Ordence costs money. A limitation date that is one day
 *    wrong ends a client's claim — section 3 makes the court dismiss a
 *    time-barred suit even where the other side never pleads it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LIMITATION_ARTICLES,
  LimitationError,
  addDays,
  addMonths,
  addYears,
  applyAcknowledgement,
  chequeDishonourDeadlines,
  computeLimitation,
  daysBetween,
  limitationHealth,
} from "@/lib/legal/limitation";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");
/**
 * ⚠️ JSX WRAPS PROSE ACROSS LINES, so a substring assertion against a
 * rendered sentence fails on where the formatter happened to break it.
 * Flattening whitespace first is the same fix this suite has needed
 * four times before — it is a helper, not a lesson to re-learn.
 */
const flat = (s: string) => s.replace(/\s+/g, " ");

const SQL = read("SQL-FILES/0058_legal_matters.sql");
const MATTER_ACTIONS = read("server/actions/matters.ts");
const CLIENT_ACTIONS = read("server/actions/client-account.ts");
const LIB = read("lib/legal/limitation.ts");
const MATTERS_PAGE = read("app/(crm)/legal/matters/page.tsx");
const MATTER_DETAIL = read("app/(crm)/legal/matters/[id]/page.tsx");
const CLIENT_PAGE = read("app/(crm)/legal/client-account/page.tsx");
const REGISTRY = read("lib/modules/registry.ts");
const TEMPLATES = read("lib/industry-templates.ts");

function fnBody(src: string, name: string): string {
  const c = code(src);
  const start = c.indexOf(`export async function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const after = c.indexOf("export async function", start + 10);
  return after === -1 ? c.slice(start) : c.slice(start, after);
}

/* ================================================================== */

describe("🔴 section 12(1) — the starting day is excluded", () => {
  /**
   * 🔴 A contract broken on 3 April 2023 gives three years running from
   *    4 April 2023, expiring on 3 April 2026 — the anniversary, which
   *    is the answer every practitioner expects.
   */
  it("a three-year period lands on the anniversary", () => {
    const c = computeLimitation({
      articleKey: "art_55",
      causeOfActionDate: "2023-04-03",
    });
    expect(c.expiresOn).toBe("2026-04-03");
    expect(c.workings.join(" ")).toContain("Section 12(1) excludes that day");
  });

  it("a 90-day appeal period counts from the day after the decree", () => {
    const c = computeLimitation({
      articleKey: "art_116_hc",
      causeOfActionDate: "2026-01-01",
    });
    /** Runs from 2 January; 90 days ends on 1 April. */
    expect(c.expiresOn).toBe("2026-04-01");
    expect(daysBetween("2026-01-02", c.expiresOn)).toBe(89);
  });

  /** ⚠️ s.12(2) — the time taken to obtain a certified copy is excluded. */
  it("excluded copying days push the date out", () => {
    const base = computeLimitation({
      articleKey: "art_116_hc",
      causeOfActionDate: "2026-01-01",
    });
    const withCopy = computeLimitation({
      articleKey: "art_116_hc",
      causeOfActionDate: "2026-01-01",
      excludedDays: 12,
    });
    expect(daysBetween(base.expiresOn, withCopy.expiresOn)).toBe(12);
    expect(withCopy.workings.join(" ")).toContain("certified copy");
  });

  /** ⚠️ Adding years, not 365 × n. A leap year would land a day early. */
  it("a twelve-year period spanning leap years is exact", () => {
    const c = computeLimitation({
      articleKey: "art_65",
      causeOfActionDate: "2014-02-28",
    });
    expect(c.expiresOn).toBe("2026-02-28");
  });

  it("29 February clamps rather than overflowing", () => {
    expect(addYears("2024-02-29", 3)).toBe("2027-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("refuses an article it does not know, and names the residuary", () => {
    expect(() =>
      computeLimitation({ articleKey: "art_999", causeOfActionDate: "2026-01-01" }),
    ).toThrow(LimitationError);
    try {
      computeLimitation({ articleKey: "art_999", causeOfActionDate: "2026-01-01" });
    } catch (e) {
      expect(String(e)).toContain("Article 113");
    }
  });
});

describe("🔴 section 4 — when the court is closed", () => {
  /**
   * ⭐ "Where the prescribed period expires on a day when the court is
   *   closed, the suit may be instituted on the day the court reopens."
   *   Most software does not do this.
   */
  it("rolls forward to the reopening day", () => {
    const c = computeLimitation({
      articleKey: "art_55",
      causeOfActionDate: "2023-04-03",
      courtHolidays: ["2026-04-03", "2026-04-04", "2026-04-05"],
    });
    expect(c.rawExpiry).toBe("2026-04-03");
    expect(c.expiresOn).toBe("2026-04-06");
    expect(c.extendedByCourtClosure).toBe(true);
    expect(c.workings.join(" ")).toContain("Section 4");
  });

  it("leaves it alone when the court is open", () => {
    const c = computeLimitation({
      articleKey: "art_55",
      causeOfActionDate: "2023-04-03",
      courtHolidays: ["2026-05-01"],
    });
    expect(c.expiresOn).toBe("2026-04-03");
    expect(c.extendedByCourtClosure).toBe(false);
  });

  /** ⚠️ A holiday list that never ends is a bug, not a vacation. */
  it("refuses a calendar that closes the court for over a year", () => {
    const holidays: string[] = [];
    let d = "2026-04-03";
    for (let i = 0; i < 420; i += 1) {
      holidays.push(d);
      d = addDays(d, 1);
    }
    expect(() =>
      computeLimitation({
        articleKey: "art_55",
        causeOfActionDate: "2023-04-03",
        courtHolidays: holidays,
      }),
    ).toThrow(LimitationError);
  });
});

describe("🔴 sections 18 and 19 — the two-day difference", () => {
  const expiry = "2026-04-03";

  /**
   * 🔴 THE WHOLE TRAP. Day 1,094 gives three more years; the same letter
   *    on day 1,096 gives nothing, and the two look identical on a file.
   */
  it("an acknowledgement one day BEFORE expiry gives a fresh period", () => {
    const r = applyAcknowledgement({
      articleKey: "art_55",
      currentExpiry: expiry,
      acknowledgementDate: "2026-04-02",
    });
    expect(r.accepted).toBe(true);
    expect(r.newExpiry).toBe("2029-04-02");
  });

  /** ⚠️ "Before the expiration" — the last day still counts. */
  it("on the last day it still counts", () => {
    const r = applyAcknowledgement({
      articleKey: "art_55",
      currentExpiry: expiry,
      acknowledgementDate: expiry,
    });
    expect(r.accepted).toBe(true);
  });

  it("one day AFTER expiry gives nothing at all", () => {
    const r = applyAcknowledgement({
      articleKey: "art_55",
      currentExpiry: expiry,
      acknowledgementDate: "2026-04-04",
    });
    expect(r.accepted).toBe(false);
    expect(r.newExpiry).toBeNull();
    expect(r.reason).toContain("revives");
  });

  /**
   * ⚠️ NOT EVERY PERIOD CAN BE EXTENDED. A judgment debtor's promise
   * does not buy a decree-holder more time to execute.
   */
  it("execution of a decree is not extendable by acknowledgement", () => {
    expect(LIMITATION_ARTICLES.art_136?.extendableByAcknowledgement).toBe(false);
    const r = applyAcknowledgement({
      articleKey: "art_136",
      currentExpiry: "2030-01-01",
      acknowledgementDate: "2026-01-01",
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("not extended");
  });

  /** ⭐ The fresh period is itself subject to s.12 and s.4. */
  it("the fresh period respects the court calendar too", () => {
    const r = applyAcknowledgement({
      articleKey: "art_55",
      currentExpiry: expiry,
      acknowledgementDate: "2026-04-02",
      courtHolidays: ["2029-04-02", "2029-04-03"],
    });
    expect(r.newExpiry).toBe("2029-04-04");
  });
});

describe("⭐ the articles that ship", () => {
  it("every article names what the period runs FROM", () => {
    for (const [k, a] of Object.entries(LIMITATION_ARTICLES)) {
      expect(a.runsFrom.length, k).toBeGreaterThan(10);
      expect(a.period, k).toBeGreaterThan(0);
    }
  });

  /** ⭐ The residuary is included so there is always a correct answer. */
  it("the residuary Article 113 is three years", () => {
    expect(LIMITATION_ARTICLES.art_113?.period).toBe(3);
    expect(LIMITATION_ARTICLES.art_113?.unit).toBe("years");
  });

  /**
   * 🔴 s.34(3) of the Arbitration Act — three months plus thirty days
   *    "but not thereafter". Those three words are absolute.
   */
  it("the arbitration period carries its absolute cap", () => {
    const a = LIMITATION_ARTICLES.arb_34;
    expect(a?.period).toBe(3);
    expect(a?.unit).toBe("months");
    expect(a?.note).toContain("but not thereafter");
  });

  /** ⚠️ Article 22 runs from the DEMAND, not from the deposit. */
  it("a deposit payable on demand runs from the demand", () => {
    expect(LIMITATION_ARTICLES.art_22?.runsFrom).toContain("demand");
    expect(LIMITATION_ARTICLES.art_22?.note).toContain("DEMAND");
  });
});

describe("🔴 s.138 NI Act — three deadlines, each starting the next", () => {
  /**
   * 🔴 THE FAILURE IS ALWAYS THE SAME: counting the 30 days from the
   *    cheque date, or the one month from the notice rather than from
   *    the expiry of the fifteen days.
   */
  it("computes the whole chain from the bank's memo", () => {
    const d = chequeDishonourDeadlines({
      dishonourInformedOn: "2026-04-01",
      noticeServedOn: "2026-04-10",
    });
    expect(d.noticeDueBy).toBe("2026-05-01");
    expect(d.drawerPayBy).toBe("2026-04-25");
    /** ⚠️ The day AFTER the fifteen expire. */
    expect(d.causeOfActionOn).toBe("2026-04-26");
    expect(d.complaintDueBy).toBe("2026-05-26");
  });

  /** ⚠️ Nothing runs until the notice is served. */
  it("nothing runs before the notice is served", () => {
    const d = chequeDishonourDeadlines({ dishonourInformedOn: "2026-04-01" });
    expect(d.drawerPayBy).toBeNull();
    expect(d.complaintDueBy).toBeNull();
    expect(d.workings.join(" ")).toContain("No notice has been served");
  });

  /** ⭐ Payment inside the fifteen days means no offence at all. */
  it("payment inside the notice period means there is no cause of action", () => {
    const d = chequeDishonourDeadlines({
      dishonourInformedOn: "2026-04-01",
      noticeServedOn: "2026-04-10",
      paidWithinNoticePeriod: true,
    });
    expect(d.causeOfActionOn).toBeNull();
    expect(d.workings.join(" ")).toContain("no offence was committed");
  });
});

describe("⚠️ what the screen says", () => {
  const today = "2026-08-13";

  /**
   * 🔴 A MATTER WITH NO LIMITATION DATE IS THE MOST DANGEROUS ROW — it
   *    will never appear on the report that would have saved it.
   */
  it("no limitation date is its own alarm", () => {
    const h = limitationHealth({ expiresOn: null, today });
    expect(h.tone).toBe("unknown");
    expect(h.detail).toContain("never appear on the report");
  });

  /** ⚠️ The last day is a full day. Showing it as expired sends somebody home. */
  it("a period expiring today can still be filed today", () => {
    const h = limitationHealth({ expiresOn: today, today });
    expect(h.tone).toBe("danger");
    expect(h.label).toBe("Expires today");
    expect(h.detail).toContain("Not tomorrow");
  });

  it("and not the day after", () => {
    const h = limitationHealth({ expiresOn: "2026-08-12", today });
    expect(h.tone).toBe("expired");
    expect(h.detail).toContain("section 3");
    expect(h.detail).toContain("not automatic");
  });

  it("warns inside thirty days and reassures beyond the window", () => {
    expect(limitationHealth({ expiresOn: "2026-09-01", today }).tone).toBe("danger");
    expect(limitationHealth({ expiresOn: "2026-10-15", today }).tone).toBe("warn");
    expect(limitationHealth({ expiresOn: "2027-10-15", today }).tone).toBe("ok");
  });
});

describe("🔴 the rules that live in the database", () => {
  /** 🔴 A matter with no cause-of-action date never appears on the report. */
  it("a contentious matter must name the cause-of-action date", () => {
    expect(SQL).toContain("legal_matters_contentious_has_cause_date");
  });

  /** 🔴 The constraint the hearings table exists for. */
  it("a hearing that was held must give a next date or a disposal", () => {
    expect(SQL).toContain("legal_hearings_held_has_a_future");
    expect(SQL).toContain("next_date IS NOT NULL");
  });

  /** ⚠️ `not_reached` is included deliberately — the forgotten one. */
  it("a matter that was not reached still needs a next date", () => {
    expect(SQL).toContain("'held', 'adjourned', 'not_reached'");
  });

  it("an adjournment says why", () => {
    expect(SQL).toContain("legal_hearings_adjourned_is_explained");
  });

  /** 🔴 The trigger that refuses to revive a dead right. */
  it("an acknowledgement after expiry cannot be recorded as a reset", () => {
    expect(SQL).toContain("ordence_guard_limitation_reset");
    expect(SQL).toContain("NEW.event_date > m.limitation_expires_on");
    expect(SQL).toContain("revives a right");
  });

  it("only an acknowledgement or a part payment can reset it", () => {
    expect(SQL).toContain("NEW.event_type NOT IN ('acknowledgement', 'part_payment')");
  });

  /** 🔴🔴 The entire trust-accounting control. */
  it("a client ledger cannot go into debit", () => {
    expect(SQL).toContain("ordence_guard_client_account");
    expect(SQL).toContain("client_balance + NEW.amount_minor < 0");
    expect(SQL).toContain("another client");
  });

  /** ⭐ And per matter, not only per client. */
  it("funds held on one matter are not available to another", () => {
    expect(SQL).toContain("matter_balance + NEW.amount_minor < 0");
  });

  /** 🔴 Fees out only against a bill. */
  it("a transfer to the firm's account must name an invoice", () => {
    expect(SQL).toContain("client_account_entries_office_transfer_has_bill");
  });

  it("the sign must match the stated kind", () => {
    expect(SQL).toContain("client_account_entries_sign_matches_kind");
  });

  it("every new table is tenant-isolated and forced", () => {
    for (const t of [
      "legal_matters",
      "legal_matter_events",
      "legal_hearings",
      "court_holidays",
      "client_account_entries",
    ]) {
      expect(SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(SQL, t).toContain(`${t}_tenant_isolation`);
    }
  });

  /** ⚠️ A table of periods somebody can edit is a three-year period that
   *  quietly becomes one. */
  it("no limitation periods are stored in the database", () => {
    expect(sqlCode(SQL)).not.toMatch(/CREATE TABLE[^;]*limitation_periods/i);
    expect(SQL).toContain("NO SHIPPED LIMITATION PERIODS IN THE DATABASE");
  });

  it("there is no stored days-remaining column", () => {
    expect(sqlCode(SQL)).not.toMatch(/days_remaining/);
  });
});

describe("🔴 the rules that live in the actions", () => {
  const m = code(MATTER_ACTIONS);
  const c = code(CLIENT_ACTIONS);

  /** 🔴 A field for the expiry is a field for last year's arithmetic. */
  it("the limitation date is computed, never accepted from the form", () => {
    expect(m).toContain("computeLimitation(");
    expect(m).not.toMatch(/limitationExpiresOn:\s*data\./);
  });

  it("a contentious matter without a cause date is refused", () => {
    const fn = fnBody(MATTER_ACTIONS, "saveMatter");
    expect(fn).toContain("contentious && !data.causeOfActionDate");
    expect(fn).toContain("never appears on the report");
  });

  /** ⚠️ A High Court vacation does not close a district court. */
  it("court holidays are matched by court name", () => {
    expect(m).toContain("holidaysFor(");
    expect(m).toContain("!courtName || r.court === courtName");
  });

  /** 🔴 A tick-box saying "this extends limitation" is comforting and false. */
  it("whether an event extends limitation is computed, not typed", () => {
    const fn = fnBody(MATTER_ACTIONS, "recordMatterEvent");
    expect(fn).toContain("applyAcknowledgement(");
    expect(fn).toContain("resetsLimitation: extended");
    expect(fn).not.toMatch(/resetsLimitation:\s*data\./);
  });

  it("the workings are kept, not just the date", () => {
    const fn = fnBody(MATTER_ACTIONS, "saveMatter");
    expect(fn).toContain("limitationNote: workings.join");
  });

  /** 🔴 The rule the hearings table exists for, said before the constraint. */
  it("a held hearing with no next date and no disposal is refused", () => {
    const fn = fnBody(MATTER_ACTIONS, "saveHearing");
    expect(fn).toContain("default of appearance");
  });

  /** 🔴 The sign comes from the kind, never from the form. */
  it("client-account amounts are signed from the entry kind", () => {
    const fn = fnBody(CLIENT_ACTIONS, "recordClientAccountEntry");
    expect(fn).toContain('data.entryKind === "receipt"');
    expect(fn).toContain("amountMinor: signed");
  });

  /** ⚠️ A draft is not a bill. */
  it("fees cannot be taken against a draft invoice", () => {
    const fn = fnBody(CLIENT_ACTIONS, "recordClientAccountEntry");
    expect(fn).toContain('inv.status === "draft"');
    expect(fn).toContain("client has not been billed");
  });

  it("a transfer to the office must name a bill", () => {
    const fn = fnBody(CLIENT_ACTIONS, "recordClientAccountEntry");
    expect(fn).toContain('data.entryKind === "transfer_to_office" && !data.invoiceId');
  });

  /** ⚠️ A stored running total diverges the moment anything is backdated. */
  it("the running balance is computed on read", () => {
    const fn = fnBody(CLIENT_ACTIONS, "getClientAccountLedger");
    expect(fn).toContain("running +=");
  });

  /** Every export in a "use server" file is a browser-reachable endpoint. */
  it("both action files export only async functions and types", () => {
    for (const [n, s] of [
      ["matters", m],
      ["client-account", c],
    ] as const) {
      expect(s.startsWith('"use server"'), n).toBe(true);
      const bad = s.match(/^export\s+(?:const|let|var|class|function)\s+\w+/gm);
      expect(bad ?? [], n).toEqual([]);
    }
  });
});

describe("⭐ the screens, and the labels that are gone", () => {
  /**
   * 🔴 "Matters" and "Cases" both pointed at /assets?type=…, and
   *    "Hearings" at the generic calendar. The label was doing all of
   *    the work.
   */
  it("matters points at a real screen now", () => {
    expect(REGISTRY).toContain('href: "/legal/matters"');
    expect(REGISTRY).not.toContain('href: "/assets?type=matter"');
  });

  it("cases is gone rather than re-pointed, and it says why", () => {
    expect(REGISTRY).not.toContain('href: "/assets?type=case"');
    expect(REGISTRY).toContain("one word twice");
  });

  it("hearings is folded into matters", () => {
    expect(REGISTRY).toContain("FOLDED INTO `matters`");
  });

  it("the legal industry template was rewritten to match", () => {
    expect(TEMPLATES).toContain('href: "/legal/matters"');
    expect(TEMPLATES).toContain('href: "/legal/client-account"');
    expect(TEMPLATES).not.toContain('{ id: "cases"');
  });

  it("the client account is in the menu", () => {
    expect(REGISTRY).toContain('href: "/legal/client-account"');
  });

  /** 🔴 The most dangerous number gets its own counter, first. */
  it("the matters screen counts matters with no limitation date", () => {
    expect(MATTERS_PAGE).toContain("noLimitationDate");
    expect(flat(MATTERS_PAGE)).toContain("never show up on any deadline list");
  });

  it("it counts matters that have fallen off the diary", () => {
    expect(MATTERS_PAGE).toContain("offDiary");
    expect(flat(MATTERS_PAGE)).toContain("Nobody is listed to attend");
  });

  /** ⚠️ A date somebody has to take on trust is a date nobody checks. */
  it("the detail screen shows the workings, not just the date", () => {
    expect(MATTER_DETAIL).toContain("limitationNote");
  });

  it("the client-account screen explains why zero-in-debit matters", () => {
    expect(CLIENT_PAGE).toContain("inDebitCount");
    expect(flat(CLIENT_PAGE)).toContain("another client");
  });

  /** ⚠️ Honest about what it does NOT do. */
  it("it says the bank reconciliation is still a person's job", () => {
    expect(flat(CLIENT_PAGE)).toContain("does not reconcile");
  });

  it("pages are server components", () => {
    for (const p of [MATTERS_PAGE, MATTER_DETAIL, CLIENT_PAGE]) {
      expect(p.startsWith('"use client"')).toBe(false);
    }
  });

  /** The engine is pure and has no clock. */
  it("the limitation library reads no clock", () => {
    const c = code(LIB);
    expect(c).not.toMatch(/Date\.now\(\)/);
    expect(c).not.toMatch(/new Date\(\)/);
  });
});
