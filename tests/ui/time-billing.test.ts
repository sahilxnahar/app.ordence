/**
 * Time & billing — the engine Legal and Professional Services run on.
 *
 * The arithmetic tests are real. Getting a billing increment or a rate
 * window wrong does not crash anything — it silently bills the wrong
 * amount on every entry, forever, in one direction.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BILLING_INCREMENTS,
  TimeBillingError,
  billableMinutes,
  minutesToHoursLabel,
  parseDuration,
  realisationPercent,
  resolveRate,
  summariseUnbilled,
  timeValueMinor,
  type RateRow,
} from "@/lib/billing/time";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const ACTIONS = read("server/actions/time-billing.ts");
const SQL = read("SQL-FILES/0053_time_and_billing.sql");

function rate(over: Partial<RateRow> = {}): RateRow {
  return {
    id: "r1",
    userId: null,
    roleName: null,
    companyId: null,
    rateMinor: 800_000n, // ₹8,000/hour
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...over,
  };
}

/* ================================================================== */

describe("🔴 the six-minute unit, and rounding UP", () => {
  /** Seven minutes is billed as two units, because the unit is the thing sold. */
  it("rounds up to the next whole unit", () => {
    expect(billableMinutes(7)).toBe(12);
    expect(billableMinutes(1)).toBe(6);
    expect(billableMinutes(6)).toBe(6);
    expect(billableMinutes(61)).toBe(66);
  });

  /**
   * Rounding to nearest would under-bill roughly half of all entries and
   * a firm would find out at year end.
   */
  it("never rounds down", () => {
    for (let m = 1; m <= 120; m += 1) {
      expect(billableMinutes(m)).toBeGreaterThanOrEqual(m);
      expect(billableMinutes(m) - m).toBeLessThan(6);
    }
  });

  /** Billing a note somebody made and deleted is a charge for nothing. */
  it("zero stays zero", () => {
    expect(billableMinutes(0)).toBe(0);
  });

  it("supports the other conventions", () => {
    expect(billableMinutes(20, "fifteen_minutes")).toBe(30);
    expect(billableMinutes(31, "thirty_minutes")).toBe(60);
    expect(billableMinutes(37, "exact")).toBe(37);
  });

  /** Hours as decimals are how a timesheet stops adding up. */
  it("refuses a fractional minute outright", () => {
    expect(() => billableMinutes(7.5)).toThrow(TimeBillingError);
    expect(() => billableMinutes(-5)).toThrow(TimeBillingError);
  });

  it("every named increment divides an hour", () => {
    for (const [name, mins] of Object.entries(BILLING_INCREMENTS)) {
      expect(60 % mins, name).toBe(0);
    }
  });
});

describe("🔴 value: multiply first, divide once, round half up", () => {
  it("a clean hour at ₹8,000", () => {
    expect(timeValueMinor({ billableMinutes: 60, rateMinorPerHour: 800_000n })).toBe(800_000n);
  });

  it("a six-minute unit is a tenth", () => {
    expect(timeValueMinor({ billableMinutes: 6, rateMinorPerHour: 800_000n })).toBe(80_000n);
  });

  /**
   * `rate / 60 * minutes` throws away the fraction of a paisa per minute
   * before multiplying it back up. A full day loses several rupees.
   */
  it("keeps the paise a divide-first order would lose", () => {
    // ₹7,777.77/hour for 7 minutes.
    const v = timeValueMinor({ billableMinutes: 7, rateMinorPerHour: 777_777n });
    const divideFirst = (777_777n / 60n) * 7n;
    expect(v).toBe(90_741n);
    expect(v).toBeGreaterThan(divideFirst);
  });

  /**
   * bigint division truncates toward zero, which under-bills by up to a
   * paisa on every entry — always in the client's favour, which is not a
   * place for a rounding rule to sit by accident.
   */
  it("rounds half up rather than truncating", () => {
    // 1 minute at ₹0.90/hour = 1.5 paise → 2.
    expect(timeValueMinor({ billableMinutes: 1, rateMinorPerHour: 90n })).toBe(2n);
  });

  it("refuses a negative rate", () => {
    expect(() => timeValueMinor({ billableMinutes: 6, rateMinorPerHour: -1n })).toThrow();
  });
});

describe("🔴 rate resolution: specificity beats recency", () => {
  const rates = [
    rate({ id: "house", rateMinor: 500_000n }),
    rate({ id: "role", roleName: "manager", rateMinor: 600_000n }),
    rate({ id: "person", userId: "u1", rateMinor: 700_000n }),
    rate({ id: "person-client", userId: "u1", companyId: "c1", rateMinor: 900_000n }),
  ];

  it("picks the person-and-client rate over everything else", () => {
    const r = resolveRate({
      rates,
      userId: "u1",
      roleName: "manager",
      companyId: "c1",
      onDate: "2026-06-01",
    });
    expect(r.found && r.rateId).toBe("person-client");
  });

  it("falls back down the ladder when the client differs", () => {
    const r = resolveRate({
      rates,
      userId: "u1",
      roleName: "manager",
      companyId: "c2",
      onDate: "2026-06-01",
    });
    expect(r.found && r.rateId).toBe("person");
  });

  /**
   * A house rate set yesterday must not override a rate negotiated in a
   * client's engagement letter last year.
   */
  it("a NEWER general rate never beats an OLDER specific one", () => {
    const r = resolveRate({
      rates: [
        rate({ id: "specific", userId: "u1", companyId: "c1", rateMinor: 900_000n, effectiveFrom: "2025-01-01" }),
        rate({ id: "house-new", rateMinor: 999_999n, effectiveFrom: "2026-08-01" }),
      ],
      userId: "u1",
      roleName: null,
      companyId: "c1",
      onDate: "2026-08-13",
    });
    expect(r.found && r.rateId).toBe("specific");
  });

  /** Work done in March bills at March's rate, whenever it is invoiced. */
  it("uses the window that covers the WORK date", () => {
    const rates2 = [
      rate({ id: "old", userId: "u1", rateMinor: 800_000n, effectiveFrom: "2025-04-01", effectiveTo: "2026-04-01" }),
      rate({ id: "new", userId: "u1", rateMinor: 950_000n, effectiveFrom: "2026-04-01" }),
    ];
    expect(resolveRate({ rates: rates2, userId: "u1", roleName: null, companyId: null, onDate: "2026-03-31" }).found &&
      resolveRate({ rates: rates2, userId: "u1", roleName: null, companyId: null, onDate: "2026-03-31" })).toMatchObject({ rateId: "old" });
    expect(resolveRate({ rates: rates2, userId: "u1", roleName: null, companyId: null, onDate: "2026-04-01" })).toMatchObject({ rateId: "new" });
  });

  /** A closed range makes the boundary day belong to two rates. */
  it("the window is half-open, so the boundary day belongs to ONE rate", () => {
    const r = resolveRate({
      rates: [rate({ id: "a", userId: "u1", effectiveFrom: "2026-01-01", effectiveTo: "2026-04-01" })],
      userId: "u1",
      roleName: null,
      companyId: null,
      onDate: "2026-04-01",
    });
    expect(r.found).toBe(false);
  });

  /** ₹0.00 on a client's bill is not queried until the year-end review. */
  it("no rate is an ANSWER, not a zero", () => {
    const r = resolveRate({ rates: [], userId: "u1", roleName: null, companyId: null, onDate: "2026-06-01" });
    expect(r.found).toBe(false);
    expect(r.found === false && r.reason).toContain("No billing rate");
  });
});

describe("people type time five ways", () => {
  it("reads all of them", () => {
    expect(parseDuration("2:30")).toBe(150);
    expect(parseDuration("2h 30m")).toBe(150);
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
  });

  /** Reading 2.5 as two minutes five would bill 1% of the right amount. */
  it("2.5 is two and a half HOURS", () => {
    expect(parseDuration("2.5")).toBe(150);
    expect(parseDuration("0.1")).toBe(6);
  });

  it("returns null rather than guessing", () => {
    expect(parseDuration("later")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  it("labels minutes back for a human", () => {
    expect(minutesToHoursLabel(150)).toBe("2:30");
    expect(minutesToHoursLabel(6)).toBe("0:06");
  });
});

describe("🔴 approved and pending are never summed", () => {
  const entries = [
    { id: "1", isBillable: true, status: "approved", billableMinutes: 60, valueMinor: 800_000n },
    { id: "2", isBillable: true, status: "draft", billableMinutes: 30, valueMinor: 400_000n },
    { id: "3", isBillable: false, status: "draft", billableMinutes: 0, valueMinor: 0n },
  ];

  /** One combined figure is what makes a practice think it is richer than it is. */
  it("reports them as two figures", () => {
    const s = summariseUnbilled(entries);
    expect(s.approvedValueMinor).toBe(800_000n);
    expect(s.pendingValueMinor).toBe(400_000n);
  });

  it("non-billable time carries no value", () => {
    const s = summariseUnbilled([
      { id: "x", isBillable: false, status: "approved", billableMinutes: 120, valueMinor: 0n },
    ]);
    expect(s.approvedValueMinor).toBe(0n);
    expect(s.nonBillableMinutes).toBe(120);
  });

  /** A practice with no timesheets has no realisation rate, not a rate of zero. */
  it("realisation is null when nothing was recorded", () => {
    expect(realisationPercent({ billableMinutes: 0, totalMinutes: 0 })).toBeNull();
    expect(realisationPercent({ billableMinutes: 90, totalMinutes: 120 })).toBe(75);
  });
});

describe("🔴 the rules that live in the database", () => {
  it("duration is an integer column, not a decimal", () => {
    expect(SQL).toMatch(/minutes\s+integer\s+NOT NULL/);
    expect(sqlCode(SQL)).not.toMatch(/minutes\s+(numeric|decimal|real|double)/i);
  });

  /** Otherwise "what have we billed" and "what is unbilled" are both true of one row. */
  it("a billed entry MUST name its invoice, and an unbilled one must not", () => {
    expect(SQL).toContain("time_entries_billed_has_invoice");
    expect(SQL).toContain("(status = 'billed') = (invoice_id IS NOT NULL)");
  });

  /** A written-off hour must not show in the figure somebody is chasing. */
  it("non-billable time is forced to zero value", () => {
    expect(SQL).toContain("time_entries_non_billable_is_free");
  });

  it("a rate must name a person, a role or a client", () => {
    expect(SQL).toContain("billing_rates_has_a_subject");
  });

  it("both tables are tenant-isolated and forced", () => {
    for (const t of ["billing_rates", "time_entries"]) {
      expect(SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(SQL, t).toContain(`${t}_tenant_isolation`);
    }
  });

  /** A legal retainer IS an unapplied customer receipt — already built. */
  it("creates no second table for retainers, and says why", () => {
    expect(sqlCode(SQL)).not.toMatch(/CREATE TABLE[^;]*retainer/i);
    expect(SQL.toLowerCase()).toContain("unapplied customer receipt");
  });
});

describe("🔴 the rules that live in the actions", () => {
  /** Updating in place re-prices every unbilled hour ever worked. */
  it("saving a rate INSERTS, it never updates in place", () => {
    const c = code(ACTIONS);
    const fn = c.slice(c.indexOf("export async function saveBillingRate"));
    expect(fn).toContain(".insert(billingRates)");
    expect(fn).not.toContain(".update(billingRates)");
  });

  /** The hour must carry the price it was worth when it was worked. */
  it("prices the entry on the WORK date, not today", () => {
    const c = code(ACTIONS);
    expect(c).toContain("onDate: data.entryDate");
    expect(c).not.toMatch(/onDate:\s*new Date\(\)/);
  });

  /** Somebody writing up their day at 7pm must not be blocked by a rate card. */
  it("a missing rate does not block recording", () => {
    const c = code(ACTIONS);
    const fn = c.slice(c.indexOf("export async function recordTimeEntry"));
    expect(fn).toContain("rated");
    expect(fn).not.toMatch(/if \(!resolved\.found\) throw/);
  });

  /** Otherwise anyone could put billable hours against a partner's name. */
  it("logging time for someone else needs the approval permission", () => {
    const c = code(ACTIONS);
    expect(c).toContain("forUser !== ctx.user.id");
  });

  /** An hour that was worked was worked. */
  it("write-off keeps the minutes and drops the value — never deletes", () => {
    const c = code(ACTIONS);
    const fn = c.slice(c.indexOf("export async function writeOffTimeEntries"));
    expect(fn).toContain('status: "written_off"');
    expect(fn).toContain("valueMinor: 0n");
    expect(fn).not.toMatch(/\.delete\(/);
  });

  it("billed time cannot be re-approved", () => {
    const c = code(ACTIONS);
    const fn = c.slice(c.indexOf("export async function approveTimeEntries"));
    expect(fn).toContain('inArray(timeEntries.status, ["draft", "submitted"])');
  });

  it("changing what an hour is worth is audited as critical", () => {
    const c = code(ACTIONS);
    const fn = c.slice(c.indexOf("export async function saveBillingRate"));
    expect(fn).toContain('severity: "critical"');
  });
});
