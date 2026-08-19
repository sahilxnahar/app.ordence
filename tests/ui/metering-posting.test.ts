/**
 * Ordence — ⭐⭐⭐ THE METERING POSTING
 * Version: v1.28.0-alpha · Batch 20
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ELECTRICITY DUTY IS NOT INCOME, AND THAT IS THE WHOLE TEST FILE
 * ══════════════════════════════════════════════════════════════════════
 * A society or facility recovering electricity collects one number made
 * of three things, and one of them belongs to a State government. The
 * common spreadsheet books the lot to revenue: turnover overstated by
 * the duty on every unit ever billed, and a statutory liability that
 * never appears as one.
 *
 * ⚠️ THE ASSERTIONS ARE WORKED EXAMPLES WITH REAL NUMBERS. A test that
 * re-runs the implementation proves it is deterministic and nothing else.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertMeteringBalances,
  buildMeteringPosting,
  meteringProblem,
  meteringRolesUsed,
  METERING_ROLE_META,
} from "@/lib/accounting/sales-posting";
import { salesTransactionKey } from "@/server/accounting/post-sales";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * A flat's monthly bill:
 *   420 units × ₹7.50   = ₹3,150.00  energy
 *   fixed charge          ₹  150.00
 *   duty at 9%            ₹  283.50   ← the State's
 *   export credit         ₹    0.00
 *                         ─────────
 *   total                 ₹3,583.50
 */
const ORDINARY = {
  energyChargeMinor: 315_000n,
  fixedChargeMinor: 15_000n,
  dutyMinor: 28_350n,
  exportCreditMinor: 0n,
  totalMinor: 358_350n,
};

describe("the duty never reaches income", () => {
  it("credits revenue with the recovery only, not the duty", () => {
    const legs = buildMeteringPosting({
      facts: ORDINARY,
      meterLabel: "A-1204",
      periodLabel: "July 2026",
      consumerName: "R Iyer",
    });

    const revenue = legs.find((l) => l.role === "metering_revenue");
    /** ⚠️ ₹3,300 — energy plus fixed. NOT the ₹3,583.50 collected. */
    expect(revenue?.amountMinor).toBe(330_000n);
    expect(revenue?.entryType).toBe("credit");
  });

  it("holds the duty as a liability owed to the State", () => {
    const legs = buildMeteringPosting({
      facts: ORDINARY,
      meterLabel: "A-1204",
      periodLabel: "July 2026",
      consumerName: null,
    });
    const duty = legs.find((l) => l.role === "electricity_duty_payable");
    expect(duty?.amountMinor).toBe(28_350n);
    expect(duty?.entryType).toBe("credit");
    expect(duty?.description).toContain("State");
  });

  it("debits the consumer with everything they were billed", () => {
    const legs = buildMeteringPosting({
      facts: ORDINARY,
      meterLabel: "A-1204",
      periodLabel: "July 2026",
      consumerName: null,
    });
    const receivable = legs.find((l) => l.role === "receivable");
    expect(receivable?.amountMinor).toBe(358_350n);
    expect(receivable?.entryType).toBe("debit");
  });

  it("balances", () => {
    const legs = buildMeteringPosting({
      facts: ORDINARY,
      meterLabel: "A-1204",
      periodLabel: "July 2026",
      consumerName: null,
    });
    expect(() => assertMeteringBalances(legs)).not.toThrow();
  });

  /**
   * ⭐ THE MEASURE OF THE DEFECT THIS PREVENTS. Booking the whole bill to
   * revenue overstates a single flat's annual turnover by ₹3,402 — and a
   * society with two hundred flats by ₹6.8 lakh, on which income tax is
   * computed.
   */
  it("keeps ₹283.50 a month out of turnover, per meter", () => {
    const legs = buildMeteringPosting({
      facts: ORDINARY,
      meterLabel: "A-1204",
      periodLabel: "July 2026",
      consumerName: null,
    });
    const revenue = legs.find((l) => l.role === "metering_revenue")!.amountMinor;
    expect(ORDINARY.totalMinor - revenue).toBe(28_350n);
  });
});

/* ================================================================== */
/* ⭐⭐ NET METERING                                                    */
/* ================================================================== */

describe("net metering", () => {
  /** Export credit reduces what is owed, as contra-revenue. */
  const WITH_EXPORT = {
    energyChargeMinor: 315_000n,
    fixedChargeMinor: 15_000n,
    dutyMinor: 28_350n,
    exportCreditMinor: 120_000n, // ₹1,200
    totalMinor: 238_350n,
  };

  it("balances with an export credit", () => {
    const legs = buildMeteringPosting({
      facts: WITH_EXPORT,
      meterLabel: "B-701",
      periodLabel: "July 2026",
      consumerName: null,
    });
    expect(() => assertMeteringBalances(legs)).not.toThrow();
  });

  /**
   * ⚠️ CONTRA-REVENUE, NOT A COST OF SALES. It is a reduction of the
   * same income the charge credited, and putting it in expenses would
   * overstate both turnover and cost by the same amount — which nets to
   * the right profit and the wrong two numbers above it.
   */
  it("debits the export against revenue rather than expensing it", () => {
    const legs = buildMeteringPosting({
      facts: WITH_EXPORT,
      meterLabel: "B-701",
      periodLabel: "July 2026",
      consumerName: null,
    });
    const credit = legs.find((l) => l.role === "metering_export_credit");
    expect(credit?.entryType).toBe("debit");
    expect(credit?.amountMinor).toBe(120_000n);
    expect(METERING_ROLE_META.metering_export_credit.accountType).toBe("revenue");
  });

  /**
   * 🔴 A NEGATIVE BILL IS A PAYABLE, NOT A NEGATIVE DEBTOR.
   *
   * A rooftop array in a light month genuinely produces one. Carrying it
   * as a negative receivable puts a creditor in the debtors listing,
   * where nobody looks for it and where it quietly nets off somebody
   * else's overdue balance.
   */
  it("posts a credit owed to the consumer when the export exceeds the charges", () => {
    const facts = {
      energyChargeMinor: 50_000n,
      fixedChargeMinor: 15_000n,
      dutyMinor: 4_500n,
      exportCreditMinor: 120_000n,
      totalMinor: -50_500n,
    };
    expect(meteringProblem(facts)).toBeNull();

    const legs = buildMeteringPosting({
      facts,
      meterLabel: "B-701",
      periodLabel: "July 2026",
      consumerName: null,
    });
    expect(() => assertMeteringBalances(legs)).not.toThrow();

    expect(legs.some((l) => l.role === "receivable")).toBe(false);
    const owed = legs.find((l) => l.role === "metering_consumer_credit");
    expect(owed?.entryType).toBe("credit");
    expect(owed?.amountMinor).toBe(50_500n);
    expect(METERING_ROLE_META.metering_consumer_credit.accountType).toBe("liability");
  });

  it("drops the zero legs on a meter with no export and no duty", () => {
    const legs = buildMeteringPosting({
      facts: {
        energyChargeMinor: 100_000n,
        fixedChargeMinor: 0n,
        dutyMinor: 0n,
        exportCreditMinor: 0n,
        totalMinor: 100_000n,
      },
      meterLabel: "C-1",
      periodLabel: "July 2026",
      consumerName: null,
    });
    expect(meteringRolesUsed(legs).sort()).toEqual(["metering_revenue", "receivable"]);
  });
});

/* ================================================================== */
/* 🔴 THE STORED TOTAL IS CHECKED, NOT TRUSTED                         */
/* ================================================================== */

describe("the period has to add up before it posts", () => {
  it("accepts a consistent period", () => {
    expect(meteringProblem(ORDINARY)).toBeNull();
  });

  /**
   * ⚠️ THE ROW STORES ALL FIVE FIGURES, computed by a database function
   * at close. If they disagree, something recomputed one and not the
   * others — and posting from the stored total would put a figure in the
   * ledger that the bill the consumer received does not support.
   */
  it("refuses when the total disagrees with its own parts", () => {
    const problem = meteringProblem({ ...ORDINARY, totalMinor: 400_000n });
    expect(problem).not.toBeNull();
    expect(problem).toContain("do not add up");
    expect(problem).toContain("₹3,583.50".replace(/,/g, ""));
  });

  it("refuses a negative charge and says why an export is different", () => {
    const problem = meteringProblem({ ...ORDINARY, energyChargeMinor: -1n });
    expect(problem).toContain("never negative");
    expect(problem).toContain("export credit");
  });

  it("allows a negative TOTAL, which is the whole point of net metering", () => {
    expect(
      meteringProblem({
        energyChargeMinor: 10_000n,
        fixedChargeMinor: 0n,
        dutyMinor: 900n,
        exportCreditMinor: 50_000n,
        totalMinor: -39_100n,
      }),
    ).toBeNull();
  });
});

/* ================================================================== */
/* THE ROLE METADATA AND THE KEY                                       */
/* ================================================================== */

describe("the roles and the key", () => {
  const added = [
    "metering_revenue",
    "electricity_duty_payable",
    "metering_export_credit",
    "metering_consumer_credit",
  ] as const;

  for (const role of added) {
    it(`describes ${role} for the mapping screen`, () => {
      const meta = METERING_ROLE_META[role];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.tallyGroup.length).toBeGreaterThan(0);
      expect(meta.help.length).toBeGreaterThan(40);
    });
  }

  it("puts the duty on the liability side, where a levy belongs", () => {
    expect(METERING_ROLE_META.electricity_duty_payable.accountType).toBe("liability");
    expect(METERING_ROLE_META.electricity_duty_payable.tallyGroup).toBe("Duties & Taxes");
  });

  /** ⚠️ Its own tag — the trap that caught `vendor_payment` last session. */
  it("gives the meter period its own transaction tag", () => {
    expect(salesTransactionKey("meter_period", "abc")).toBe("SALES:MTR:abc");
    expect(salesTransactionKey("meter_period", "abc")).not.toContain(":RCP:");
  });
});

/* ================================================================== */
/* ⭐⭐⭐ THE DEBT LIST IS EMPTY                                        */
/* ================================================================== */

describe("the posting debt list", () => {
  it("metering reaches the ledger and is off the unposted list", () => {
    const actions = read("server/actions/metering.ts");
    expect(actions).toContain("@/server/accounting/post-sales");
    expect(actions).toContain("postMeterBill");

    const gate = read("scripts/check-posting-coverage.mjs");
    const unposted = gate.slice(
      gate.indexOf("const KNOWN_UNPOSTED"),
      gate.indexOf("const POSTING_MARKERS"),
    );
    expect(unposted).not.toContain("metering:");
  });

  /**
   * ⭐⭐⭐ `billing` LEFT THE MODULE LIST ENTIRELY, and that is a
   * CATEGORY CORRECTION rather than a completion.
   *
   * 🔴 Its excuse said subscription invoices are OUR revenue, not a
   * tenant's. That is not a reason it has not posted yet — it is a
   * reason it never will. There is no correct journal for it to write in
   * a tenant's ledger.
   *
   * ⚠️ AND A DEBT LIST CONTAINING SOMETHING THAT CAN NEVER BE PAID OFF
   * STOPS BEING A DEBT LIST. It can never reach zero, so the remaining
   * entry reads as unfinished work forever and nobody looks at it
   * closely enough to notice it is not work at all.
   */
  it("no longer counts our own subscription revenue as a tenant module", () => {
    const gate = read("scripts/check-posting-coverage.mjs");
    const modules = gate.slice(
      gate.indexOf("const FINANCIAL_MODULES"),
      gate.indexOf("const KNOWN_UNPOSTED"),
    );
    expect(modules).not.toContain('"billing",');
    expect(modules).toContain("CATEGORY CORRECTION");
  });

  /**
   * ⭐ THE LIST IS EMPTY, and it is only meaningful because the entries
   * left one at a time, by decision, each with the reasoning written
   * down — `labour` → `payroll`, `tds` → `vendor-payments`,
   * `receivables`, `sales-bookings`, and now `metering` and `billing`.
   */
  it("has nothing left on it", () => {
    const gate = read("scripts/check-posting-coverage.mjs");
    const unposted = gate.slice(
      gate.indexOf("const KNOWN_UNPOSTED"),
      gate.indexOf("const POSTING_MARKERS"),
    );
    /** No `"key":` or `key:` entries survive — only commentary. */
    expect(unposted).not.toMatch(/^\s{2}"?[a-z-]+"?:\s*$/m);
    expect(unposted).not.toMatch(/^\s{2}"?[a-z-]+"?:\s*"/m);
  });
});

describe("the bill is reachable from the meters screen", () => {
  it("offers posting only for finalised periods", () => {
    const ui = read("components/metering/meter-actions.tsx");
    expect(ui).toContain("postMeterBill");
    expect(ui).toContain("billablePeriods");
    expect(ui).toContain("p.isFinalised");
  });

  /** ⚠️ The screen says out loud why there is no GST leg. */
  it("explains the absent GST rather than leaving it unexplained", () => {
    const ui = read("components/metering/meter-actions.tsx");
    expect(ui).toContain("No GST is added");
    expect(ui).toContain("composite supply");
  });

  it("refuses an unfinalised period in the action too, not only in the UI", () => {
    expect(read("server/actions/metering.ts")).toContain("has not been finalised");
  });
});
