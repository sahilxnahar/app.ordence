/**
 * Possession — the action that makes property revenue possible at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flat = (s: string) => s.replace(/\s+/g, " ");
/**
 * ⚠️ SQL COMMENTS ARE STRIPPED FOR NEGATIVE ASSERTIONS. `0052` explains
 * at length why it does NOT use `ALTER TYPE ... ADD VALUE`, so a raw
 * match finds the phrase in the reasoning and fails the file for saying
 * the right thing. Fourth time this pattern has caught me; it is now a
 * helper rather than a lesson.
 */
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const ACTIONS = read("server/actions/sales-posting.ts");
const SQL = read("SQL-FILES/0052_booking_possession.sql");
const PAGE = read("app/(crm)/sales/possession/page.tsx");
const FORM = read("components/invoices/record-possession.tsx");
const SCHEMA = read("db/schema/sales.ts");
const REGISTRY = read("lib/modules/registry.ts");

const POSSESSION = code(ACTIONS).slice(
  code(ACTIONS).indexOf("export async function recordPossession"),
  code(ACTIONS).indexOf("export async function listPossessionCandidates"),
);

/* ================================================================== */

describe("🔴 the advance is DERIVED, never typed", () => {
  /** Accepting a figure from a form recognises revenue no demand raised. */
  it("sums principal from demands that reached the ledger", () => {
    expect(POSSESSION).toContain("sum(${demandNotices.principalMinor})");
    expect(POSSESSION).toContain('inArray(demandNotices.status, ["issued", "part_paid", "paid"])');
  });

  /**
   * The GST on those demands was credited to output tax, not the
   * advance. Releasing the total recognises the Government's money as
   * turnover.
   */
  it("uses PRINCIPAL, never the demand total", () => {
    expect(POSSESSION).not.toContain("demandNotices.totalMinor");
    expect(POSSESSION).not.toContain("demandNotices.taxMinor");
  });

  it("refuses when no demand has been served", () => {
    expect(flat(POSSESSION)).toContain("create revenue out of nothing");
  });

  it("the schema has no amount field a form could post", () => {
    const schemaBlock = code(ACTIONS).slice(
      code(ACTIONS).indexOf("const recordPossessionSchema"),
      code(ACTIONS).indexOf("export async function recordPossession"),
    );
    expect(schemaBlock).not.toMatch(/amount|Minor/i);
  });
});

describe("🔴 possession happens once, and not to a cancelled booking", () => {
  /** Moving revenue between financial years is not an edit to wave through. */
  it("refuses a second possession rather than silently re-dating", () => {
    expect(POSSESSION).toContain("booking.possessionDate");
    expect(flat(POSSESSION)).toContain("was already recorded on");
  });

  /** The combination recognises revenue AND refunds the buyer, and it balances. */
  it("refuses a cancelled booking in the action AND in the database", () => {
    expect(POSSESSION).toContain('booking.status === "cancelled"');
    expect(SQL).toContain("bookings_possession_not_cancelled");
    expect(SQL).toContain("possession_date IS NULL OR status <> 'cancelled'");
  });
});

describe("⭐ possession is a DATE, not a status", () => {
  /**
   * A status column carrying the same fact can disagree with the date,
   * and the one that disagrees is always the one set by hand.
   */
  it("adds no member to booking_status", () => {
    expect(sqlCode(SQL)).not.toContain("ALTER TYPE");
    expect(sqlCode(SQL)).not.toMatch(/ADD VALUE/);
  });

  it("the migration says why", () => {
    expect(SQL.toLowerCase()).toContain("second source of truth");
  });

  it("the column exists in Drizzle and in the SQL", () => {
    expect(SCHEMA).toContain("possessionDate");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS possession_date date");
  });

  /** Most bookings never have one. */
  it("indexes it partially", () => {
    expect(SQL).toContain("WHERE possession_date IS NOT NULL");
  });

  /** Re-declaring a policy replaces whatever it says today. */
  it("does not touch the existing RLS policy", () => {
    expect(SQL).not.toContain("CREATE POLICY");
  });
});

describe("🔴 the screen states the consequence", () => {
  /** "Are you sure" is answered without being read. */
  it("names the amount being recognised as turnover", () => {
    expect(flat(FORM)).toContain("as turnover");
    expect(code(FORM)).toContain("inr(advanceMinor)");
  });

  /**
   * 2 April and 30 March are different financial years, and the person
   * pressing the button is thinking in calendar months.
   */
  it("shows the Indian financial year the revenue lands in", () => {
    expect(code(FORM)).toContain("function financialYear");
    expect(code(FORM)).toContain("m >= 4 ? y : y - 1");
  });

  /**
   * Control has transferred; the revenue is earned in full. But handing
   * keys to somebody who still owes money is a decision.
   */
  it("warns about uncollected money WITHOUT blocking", () => {
    expect(flat(FORM)).toContain("still uncollected");
    expect(code(FORM)).not.toMatch(/disabled=\{[^}]*outstanding/);
  });

  it("the button is disabled until a date is chosen", () => {
    expect(code(FORM)).toContain('date === ""');
  });

  it("money never floats on the way to the screen", () => {
    for (const src of [PAGE, FORM]) {
      expect(code(src)).toContain("padStart(3");
      expect(code(src)).not.toMatch(/Number\([^)]*\)\s*\/\s*100/);
    }
  });
});

describe("🔴 the screen is findable", () => {
  /** Buried in a booking detail it would be found by nobody. */
  it("has its own registry entry under money", () => {
    expect(REGISTRY).toContain('navId: "possession"');
    expect(REGISTRY).toContain('"/sales/possession"');
  });

  /** A button that can only produce an error is worse than no button. */
  it("lists only bookings with an advance to release", () => {
    const list = code(ACTIONS).slice(
      code(ACTIONS).indexOf("export async function listPossessionCandidates"),
    );
    expect(list).toContain("toBigIntAmount(r.advance) > 0n");
    expect(list).toContain('notInArray(bookings.status, ["cancelled"])');
  });

  it("leads with the value held as advances, not a count", () => {
    const head = PAGE.slice(0, PAGE.indexOf("Why it sits there"));
    expect(head).toContain("Held as advances, not yet revenue");
    expect(head).toContain("inr(pendingTotalMinor)");
  });

  it("explains on the page why the money sits there", () => {
    expect(flat(PAGE)).toContain("Ind AS 115");
  });
});

describe("⭐ recognising revenue is audited as critical", () => {
  it("writes a critical audit line carrying the amount", () => {
    expect(POSSESSION).toContain('severity: "critical"');
    expect(POSSESSION).toContain("revenueRecognisedMinor");
  });
});
