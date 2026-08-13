/**
 * ⭐⭐ E-WAY BILL — Rule 138.
 *
 * 🔴 THE ARITHMETIC TESTS ARE THE POINT. Getting a validity window wrong
 *    does not crash anything — it produces an e-way bill that expires
 *    while a lorry is still on the road, and the person who finds out is
 *    a driver at a checkpost facing detention of the goods AND the
 *    vehicle under s.129.
 *
 * ⚠️ EVERY TIME-DEPENDENT FUNCTION TAKES `now` AS AN ARGUMENT, which is
 * what makes the hour either side of midnight testable at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EWAY_CANCEL_WINDOW_HOURS,
  EWAY_EXTENSION_WINDOW_HOURS,
  EWAY_KM_PER_DAY_ODC,
  EWAY_KM_PER_DAY_REGULAR,
  EWAY_MAX_DISTANCE_KM,
  EWAY_MAX_DOCUMENT_AGE_DAYS,
  EWAY_MAX_LIFETIME_DAYS,
  EWAY_THRESHOLD_MINOR,
  EwayBillError,
  buildEwayPayload,
  canCancelEway,
  canExtendEway,
  consignmentValue,
  documentEligible,
  ewayHealth,
  ewayRequired,
  ewayValidUntil,
  ewayValidityDays,
  isValidVehicleNumber,
  istDayStart,
  minimumHsnDigits,
  nicDate,
  normaliseVehicleNumber,
  partBRequired,
} from "@/lib/gst/eway";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const sqlCode = (s: string) => s.replace(/--[^\n]*/g, "");

const SQL = read("SQL-FILES/0054_eway_bills.sql");
const ACTIONS = read("server/actions/eway.ts");
const LIB = read("lib/gst/eway.ts");
const PAGE = read("app/(crm)/gst/eway/page.tsx");
const DETAIL = read("app/(crm)/gst/eway/[id]/page.tsx");
const ACTIONS_UI = read("components/gst/eway-actions.tsx");
const PREPARE_UI = read("components/gst/prepare-eway.tsx");
const REGISTRY = read("lib/modules/registry.ts");
const POSTING_GATE = read("scripts/check-posting-coverage.mjs");

/** 14 March 2026, 00:04 IST — the classic worked example. */
const IST = (iso: string) => new Date(`${iso}+05:30`);

/* ================================================================== */

describe("🔴 the threshold, and both halves of Explanation 2", () => {
  it("is ₹50,000", () => {
    expect(EWAY_THRESHOLD_MINOR).toBe(5_000_000n);
  });

  /**
   * ⚠️ "EXCEEDING", NOT "AT OR ABOVE". A consignment of exactly ₹50,000
   * needs none — and round-number invoices are common precisely because
   * people aim at the threshold.
   */
  it("exactly ₹50,000 does NOT require an e-way bill", () => {
    expect(
      ewayRequired({ consignmentMinor: 5_000_000n, isInterState: true }).required,
    ).toBe(false);
    expect(
      ewayRequired({ consignmentMinor: 5_000_001n, isInterState: true }).required,
    ).toBe(true);
  });

  /**
   * 🔴 THE TAX COUNTS. Using the taxable value alone under-states by up
   * to 28% and skips e-way bills that were required.
   */
  it("consignment value INCLUDES the tax", () => {
    const v = consignmentValue([
      { taxableValueMinor: 4_500_000n, taxValueMinor: 810_000n, isExempt: false },
    ]);
    expect(v.consignmentMinor).toBe(5_310_000n);
    expect(ewayRequired({ consignmentMinor: v.consignmentMinor, isInterState: true }).required).toBe(
      true,
    );
    /** ⚠️ On the taxable value alone it would have been below the line. */
    expect(ewayRequired({ consignmentMinor: 4_500_000n, isInterState: true }).required).toBe(
      false,
    );
  });

  /** 🔴 Exempt lines drop out — but only on a document that has both. */
  it("excludes exempt supply on a MIXED document", () => {
    const v = consignmentValue([
      { taxableValueMinor: 3_000_000n, taxValueMinor: 540_000n, isExempt: false },
      { taxableValueMinor: 4_000_000n, taxValueMinor: 0n, isExempt: true },
    ]);
    expect(v.exemptExcluded).toBe(true);
    expect(v.exemptMinor).toBe(4_000_000n);
    expect(v.consignmentMinor).toBe(3_540_000n);
  });

  /**
   * ⚠️ THE HALF EVERYBODY DROPS. On a document that is ENTIRELY exempt
   * there is no "both", so the exclusion does not bite. Applying it
   * anyway computes ₹0 for a full lorry, which reads as "no e-way bill
   * needed" for a reason the rule never gave.
   */
  it("does NOT exclude exempt supply on a wholly-exempt document", () => {
    const v = consignmentValue([
      { taxableValueMinor: 8_000_000n, taxValueMinor: 0n, isExempt: true },
    ]);
    expect(v.exemptExcluded).toBe(false);
    expect(v.consignmentMinor).toBe(8_000_000n);
  });

  it("refuses a negative line rather than netting it off", () => {
    expect(() =>
      consignmentValue([
        { taxableValueMinor: -100n, taxValueMinor: 0n, isExempt: false },
      ]),
    ).toThrow(EwayBillError);
  });

  /**
   * 🔴 NO STATE CAN RAISE THE INTER-STATE LIMIT. A single configurable
   * "threshold" is how a workspace in a ₹1,00,000 State quietly stops
   * raising e-way bills for its out-of-state dispatches.
   */
  it("a State's higher threshold never applies inter-state", () => {
    const intra = ewayRequired({
      consignmentMinor: 8_000_000n,
      isInterState: false,
      intraStateThresholdMinor: 10_000_000n,
    });
    const inter = ewayRequired({
      consignmentMinor: 8_000_000n,
      isInterState: true,
      intraStateThresholdMinor: 10_000_000n,
    });
    expect(intra.required).toBe(false);
    expect(inter.required).toBe(true);
    expect(inter.thresholdMinor).toBe(EWAY_THRESHOLD_MINOR);
  });

  it("exempt goods and non-motorised conveyance need none at any value", () => {
    expect(
      ewayRequired({
        consignmentMinor: 90_000_000n,
        isInterState: true,
        isExemptGoods: true,
      }).required,
    ).toBe(false);
    expect(
      ewayRequired({
        consignmentMinor: 90_000_000n,
        isInterState: true,
        isNonMotorisedConveyance: true,
      }).required,
    ).toBe(false);
  });
});

describe("🔴 validity days — 'or part thereof' means round UP", () => {
  it("200 km is one day and 201 km is two", () => {
    expect(ewayValidityDays(1)).toBe(1);
    expect(ewayValidityDays(200)).toBe(1);
    expect(ewayValidityDays(201)).toBe(2);
    expect(ewayValidityDays(400)).toBe(2);
    expect(ewayValidityDays(401)).toBe(3);
  });

  /** A zero-distance movement is still one day, never zero. */
  it("zero distance is one day, not none", () => {
    expect(ewayValidityDays(0)).toBe(1);
  });

  /**
   * 🔴 OVER DIMENSIONAL CARGO GETS A TENTH OF THE ALLOWANCE. Giving a
   * turbine blade the regular figure expires its bill halfway through a
   * lawful, escorted, night-only journey.
   */
  it("ODC is 20 km per day, not 200", () => {
    expect(EWAY_KM_PER_DAY_REGULAR).toBe(200);
    expect(EWAY_KM_PER_DAY_ODC).toBe(20);
    expect(ewayValidityDays(100, "odc")).toBe(5);
    expect(ewayValidityDays(100, "regular")).toBe(1);
  });

  it("refuses a distance the portal will not accept", () => {
    expect(() => ewayValidityDays(EWAY_MAX_DISTANCE_KM + 1)).toThrow(EwayBillError);
    expect(() => ewayValidityDays(12.5)).toThrow(EwayBillError);
    expect(() => ewayValidityDays(-1)).toThrow(EwayBillError);
  });
});

describe("🔴 the off-by-one-day that is in most implementations", () => {
  /**
   * Explanation 1 to Rule 138(10): each day expires at midnight of the
   * day IMMEDIATELY FOLLOWING the date of generation. So a one-day bill
   * generated at 00:04 on 14 March runs to midnight ending the 15th —
   * not the 14th.
   */
  it("a one-day bill generated at 00:04 on the 14th expires at the end of the 15th", () => {
    const until = ewayValidUntil({
      partBEnteredAt: IST("2026-03-14T00:04:00"),
      distanceKm: 190,
    });
    expect(until.toISOString()).toBe(IST("2026-03-16T00:00:00").toISOString());
  });

  /**
   * ⚠️ THE NAIVE `generatedAt + days × 24h` IS SHORT BY UP TO A DAY, and
   * it is short in the direction that expires a bill while a lorry is
   * still moving.
   */
  it("the first day is longer than 24 hours, deliberately", () => {
    const at = IST("2026-03-14T23:55:00");
    const until = ewayValidUntil({ partBEnteredAt: at, distanceKm: 10 });
    const hours = (until.getTime() - at.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(24);
    expect(until.toISOString()).toBe(IST("2026-03-16T00:00:00").toISOString());
  });

  /**
   * 🔴 IT IS THE **IST** MIDNIGHT. Computing this in UTC moves every
   * expiry 5½ hours early — to 18:30 the previous evening, which is
   * exactly when the last leg of a day's delivery is running.
   */
  it("expiry lands on IST midnight, not UTC midnight", () => {
    const until = ewayValidUntil({
      partBEnteredAt: IST("2026-03-14T10:00:00"),
      distanceKm: 100,
    });
    /** 18:30Z is 00:00 IST the next day. */
    expect(until.toISOString().endsWith("18:30:00.000Z")).toBe(true);
  });

  it("an instant just before IST midnight still belongs to that IST day", () => {
    /** 18:29Z on the 13th is 23:59 IST on the 13th. */
    expect(istDayStart(new Date("2026-03-13T18:29:00Z")).toISOString()).toBe(
      IST("2026-03-13T00:00:00").toISOString(),
    );
    /** 18:30Z on the 13th is 00:00 IST on the 14th. */
    expect(istDayStart(new Date("2026-03-13T18:30:00Z")).toISOString()).toBe(
      IST("2026-03-14T00:00:00").toISOString(),
    );
  });

  it("more distance means more whole days", () => {
    const at = IST("2026-03-14T09:00:00");
    expect(ewayValidUntil({ partBEnteredAt: at, distanceKm: 850 }).toISOString()).toBe(
      IST("2026-03-20T00:00:00").toISOString(),
    );
  });
});

describe("⚠️ the windows", () => {
  const generated = IST("2026-03-14T10:00:00");

  it("cancellation is 24 hours and not a minute more", () => {
    expect(EWAY_CANCEL_WINDOW_HOURS).toBe(24);
    expect(
      canCancelEway({ generatedAt: generated, now: IST("2026-03-15T09:59:00") }).allowed,
    ).toBe(true);
    expect(
      canCancelEway({ generatedAt: generated, now: IST("2026-03-15T10:01:00") }).allowed,
    ).toBe(false);
  });

  /**
   * 🔴 THE PROVISO IS ABSOLUTE. Software that only counts the hours
   * offers a button the portal refuses, which teaches people to distrust
   * the screen.
   */
  it("verification in transit blocks cancellation even inside 24 hours", () => {
    const v = canCancelEway({
      generatedAt: generated,
      now: IST("2026-03-14T11:00:00"),
      verifiedInTransit: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("verified in transit");
  });

  /** Nothing generated means nothing on the portal to cancel. */
  it("a prepared bill can always be discarded", () => {
    expect(canCancelEway({ generatedAt: null, now: generated }).allowed).toBe(true);
  });

  /**
   * ⚠️ NOT "ANY TIME BEFORE EXPIRY". A bill with three days left cannot
   * be extended, and a transporter refused early will not try again in
   * the window that would have worked.
   */
  it("extension is an 8-hour band either side of expiry, and nowhere else", () => {
    expect(EWAY_EXTENSION_WINDOW_HOURS).toBe(8);
    const validUntil = IST("2026-03-20T00:00:00");
    const args = { validUntil, originalGeneratedAt: generated };

    expect(canExtendEway({ ...args, now: IST("2026-03-19T12:00:00") }).allowed).toBe(false);
    expect(canExtendEway({ ...args, now: IST("2026-03-19T17:00:00") }).allowed).toBe(true);
    expect(canExtendEway({ ...args, now: IST("2026-03-20T07:00:00") }).allowed).toBe(true);
    expect(canExtendEway({ ...args, now: IST("2026-03-20T09:00:00") }).allowed).toBe(false);
  });

  /**
   * ⭐ THE 1 JANUARY 2025 CEILING. Without it a bill lives for ever, one
   * extension at a time.
   */
  it("no extension can carry a bill past 360 days from ORIGINAL generation", () => {
    expect(EWAY_MAX_LIFETIME_DAYS).toBe(360);
    const originalGeneratedAt = IST("2025-01-01T10:00:00");
    const validUntil = IST("2026-01-05T00:00:00");
    const v = canExtendEway({
      validUntil,
      originalGeneratedAt,
      now: IST("2026-01-04T20:00:00"),
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("360");
  });

  /** ⚠️ Checked BEFORE anybody loads a lorry — the portal checks it at generation. */
  it("a document older than 180 days cannot get an e-way bill", () => {
    expect(EWAY_MAX_DOCUMENT_AGE_DAYS).toBe(180);
    const now = IST("2026-08-13T10:00:00");
    expect(documentEligible({ documentDate: IST("2026-08-01T00:00:00"), now }).allowed).toBe(
      true,
    );
    expect(documentEligible({ documentDate: IST("2026-01-01T00:00:00"), now }).allowed).toBe(
      false,
    );
  });

  it("a future-dated document is refused", () => {
    expect(
      documentEligible({
        documentDate: IST("2026-09-01T00:00:00"),
        now: IST("2026-08-13T10:00:00"),
      }).allowed,
    ).toBe(false);
  });
});

describe("🔴 Part B — 50 km AND within the State", () => {
  /** ⚠️ The inter-state half is the one people drop. */
  it("is excused only for a short leg inside the State", () => {
    expect(
      partBRequired({ distanceKm: 40, isInterState: false, isTransporterLeg: true })
        .allowed,
    ).toBe(false);
    expect(
      partBRequired({ distanceKm: 40, isInterState: true, isTransporterLeg: true })
        .allowed,
    ).toBe(true);
    expect(
      partBRequired({ distanceKm: 60, isInterState: false, isTransporterLeg: true })
        .allowed,
    ).toBe(true);
    /** Not a consignor↔transporter leg — the exemption does not apply. */
    expect(
      partBRequired({ distanceKm: 40, isInterState: false }).allowed,
    ).toBe(true);
  });
});

describe("⚠️ vehicle numbers the portal actually accepts", () => {
  /**
   * ⚠️ NOT JUST `MH12AB1234`. Defence, temporary and Bharat-series
   * plates are all real, all legal and all refused by a naive pattern —
   * and the person refused is trying to dispatch on a genuine lorry.
   */
  it("accepts the formats that exist on Indian roads", () => {
    for (const v of ["MH12AB1234", "DL1CAB1234", "MH121234", "22BH1234AA", "12A123456"]) {
      expect(isValidVehicleNumber(v), v).toBe(true);
    }
  });

  it("rejects rubbish", () => {
    for (const v of ["", "ABCD", "1234", "MH12AB12"]) {
      expect(isValidVehicleNumber(v), v).toBe(false);
    }
  });

  it("normalises spaces, hyphens and case before checking", () => {
    expect(normaliseVehicleNumber("mh-12 ab 1234")).toBe("MH12AB1234");
    expect(isValidVehicleNumber("mh-12 ab 1234")).toBe(true);
  });

  /** A minimum, never a maximum — more digits are always accepted. */
  it("HSN digits step up above ₹5 crore turnover", () => {
    expect(minimumHsnDigits(400_00_00_000n)).toBe(2);
    expect(minimumHsnDigits(600_00_00_000n)).toBe(4);
  });
});

describe("⚠️ the NIC payload", () => {
  const base = {
    supplyType: "outward" as const,
    subSupplyType: "supply" as const,
    documentType: "tax_invoice" as const,
    documentNo: "INV/2026-27/0001",
    documentDate: "2026-08-13",
    transactionType: "regular" as const,
    fromGstin: "27AAACO1234A1Z5",
    fromLegalName: "Ordence",
    fromPlace: "Pune",
    fromPincode: "411001",
    fromStateCode: "27",
    toGstin: null,
    toLegalName: "A person",
    toPlace: "Bengaluru",
    toPincode: "560001",
    toStateCode: "29",
    taxableValueMinor: 10_000_000n,
    cgstMinor: 0n,
    sgstMinor: 0n,
    igstMinor: 1_800_000n,
    cessMinor: 0n,
    totalValueMinor: 11_800_000n,
    transporterGstin: null,
    transporterName: "VRL",
    transporterDocNo: null,
    transporterDocDate: null,
    transportMode: "road" as const,
    distanceKm: 840,
    vehicleNo: "mh-12 ab 1234",
    vehicleType: "regular" as const,
    items: [
      {
        productName: "Cement",
        description: "OPC 53 grade",
        hsnCode: "2523",
        quantity: "100.000",
        uqc: "BAG",
        taxableValueMinor: 10_000_000n,
        cgstRateBps: 0,
        sgstRateBps: 0,
        igstRateBps: 1800,
        cessRateBps: 0,
      },
    ],
  };

  /**
   * 🔴 `URP` IS THE ANSWER, NOT A PLACEHOLDER. Leaving it blank is
   * rejected — and the whole class of B2C dispatches above ₹50,000 is
   * exactly what a small business's lorry is carrying.
   */
  it("an unregistered counterparty is declared as URP", () => {
    const p = buildEwayPayload(base);
    expect(p.toGstin).toBe("URP");
    expect(p.fromGstin).toBe("27AAACO1234A1Z5");
  });

  it("dates go out as dd/mm/yyyy", () => {
    expect(nicDate("2026-08-13")).toBe("13/08/2026");
    expect(buildEwayPayload(base).docDate).toBe("13/08/2026");
  });

  it("money goes out in rupees and rates as percentages", () => {
    const p = buildEwayPayload(base) as Record<string, unknown>;
    expect(p.totalValue).toBe(100000);
    expect(p.igstValue).toBe(18000);
    const items = p.itemList as { igstRate: number }[];
    expect(items[0]?.igstRate).toBe(18);
  });

  it("the vehicle number is normalised on the way out", () => {
    expect(buildEwayPayload(base).vehicleNo).toBe("MH12AB1234");
  });

  it("refuses a payload with no goods on it", () => {
    expect(() => buildEwayPayload({ ...base, items: [] })).toThrow(EwayBillError);
  });
});

describe("⭐ what the screen says about a lorry", () => {
  const now = IST("2026-08-13T10:00:00");

  /** 🔴 The most dangerous row: looks like an e-way bill, covers nothing. */
  it("a prepared bill is never shown as coverage", () => {
    const h = ewayHealth({ status: "prepared", validUntil: null, vehicleNo: null, now });
    expect(h.tone).toBe("warn");
    expect(h.detail).toContain("nothing may move");
  });

  it("an active bill with no vehicle is flagged as not valid for movement", () => {
    const h = ewayHealth({
      status: "active",
      validUntil: IST("2026-08-20T00:00:00"),
      vehicleNo: null,
      now,
    });
    expect(h.tone).toBe("danger");
    expect(h.label).toBe("No Part B");
  });

  it("expiry is computed from the timestamp, not from the status", () => {
    const h = ewayHealth({
      status: "active",
      validUntil: IST("2026-08-13T09:00:00"),
      vehicleNo: "MH12AB1234",
      now,
    });
    expect(h.label).toBe("Expired");
    expect(h.detail).toContain("s.129");
  });

  it("inside the extension window it warns rather than reassures", () => {
    const h = ewayHealth({
      status: "active",
      validUntil: IST("2026-08-13T15:00:00"),
      vehicleNo: "MH12AB1234",
      now,
    });
    expect(h.tone).toBe("warn");
  });

  /** "Valid for 0 more days" reads as an error rather than as 20 hours. */
  it("under a day is said in hours", () => {
    const h = ewayHealth({
      status: "active",
      validUntil: IST("2026-08-14T06:00:00"),
      vehicleNo: "MH12AB1234",
      now,
    });
    expect(h.label).toContain("hours");
  });
});

describe("🔴 the rules that live in the database", () => {
  it("an ACTIVE bill must carry a number and a validity", () => {
    expect(SQL).toContain("eway_bills_active_is_real");
    expect(SQL).toContain("status <> 'active'");
  });

  /** Two rows sharing one number means two consignments and one bill. */
  it("a portal number cannot be recorded twice", () => {
    expect(SQL).toContain("eway_bills_number_unique");
  });

  /** A second live bill doubles the value declared for goods that moved once. */
  it("one live e-way bill per source document", () => {
    expect(SQL).toContain("eway_bills_one_live_per_document");
    expect(SQL).toContain("WHERE status IN ('prepared', 'active')");
  });

  it("a leg by road needs a vehicle, and any other mode needs a document", () => {
    expect(SQL).toContain("eway_vehicles_identified");
  });

  it("an exempt line cannot also carry a tax rate", () => {
    expect(SQL).toContain("eway_items_exempt_is_untaxed");
  });

  it("validity cannot end before it starts", () => {
    expect(SQL).toContain("eway_bills_validity_ordered");
  });

  it("all three tables are tenant-isolated and forced", () => {
    for (const t of ["eway_bills", "eway_bill_vehicles", "eway_bill_items"]) {
      expect(SQL, t).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      expect(SQL, t).toContain(`${t}_tenant_isolation`);
    }
  });

  /**
   * ⚠️ A stored `is_expired` flag needs a job, and the gap between the
   * bill expiring and the job running is a gap in which the screen says
   * a truck is legal and it is not.
   */
  it("there is no stored is_expired column", () => {
    expect(sqlCode(SQL)).not.toMatch(/is_expired\s+boolean/);
  });
});

describe("🔴 the rules that live in the actions", () => {
  const c = code(ACTIONS);

  /** A draft carries a placeholder number that will never exist. */
  it("refuses a draft invoice", () => {
    expect(c).toContain('invoice.status === "draft"');
  });

  /** Rule 138 is about the movement of GOODS. Nothing moves on a legal fee. */
  it("refuses a services invoice", () => {
    expect(c).toContain('invoice.supplyType !== "goods"');
  });

  /** Checked before a lorry is loaded, not at the portal afterwards. */
  it("checks the 180-day document age before anything else", () => {
    expect(c).toContain("documentEligible(");
    expect(c.indexOf("documentEligible(")).toBeLessThan(c.indexOf("insert(ewayBills)"));
  });

  /**
   * 🔴 A PREPARED BILL IS NEVER INSERTED AS ACTIVE. That is the one
   * state that puts a truck on a road with nothing behind it.
   */
  it("prepare inserts status 'prepared', never 'active'", () => {
    const fn = c.slice(c.indexOf("export async function prepareEwayBill"));
    const insert = fn.slice(fn.indexOf(".insert(ewayBills)"));
    expect(insert.slice(0, 3000)).toContain('status: "prepared"');
  });

  /** Raising bills nobody needed is a question at an audit, not a kindness. */
  it("below the threshold is refused unless it is deliberate", () => {
    expect(c).toContain("!requirement.required && !data.voluntary");
  });

  /**
   * 🔴 THE CLOCK STARTS ON LEG ONE AND NEVER RESTARTS. Recomputing
   * validity from a later leg would silently extend every bill by
   * changing lorries — the exact abuse the extension window exists to
   * prevent, achieved without it noticing.
   */
  it("a transshipment buys no extra validity", () => {
    const fn = c.slice(c.indexOf("export async function addEwayLeg"));
    expect(fn).toContain("isFirstLeg");
    expect(fn).toContain("legNo === 1");
  });

  /** An officer's question is "where has this been". */
  it("adding a leg INSERTS, it never updates the previous leg", () => {
    const fn = c.slice(c.indexOf("export async function addEwayLeg"));
    expect(fn).toContain(".insert(ewayBillVehicles)");
    expect(fn).not.toContain(".update(ewayBillVehicles)");
    expect(fn).not.toMatch(/\.delete\(/);
  });

  /**
   * 🔴 `generatedAt` SURVIVES EVERY EXTENSION, or the 360-day ceiling
   * slides forward for ever.
   */
  it("extension never rewrites the original generation instant", () => {
    const fn = c.slice(
      c.indexOf("export async function extendEwayValidity"),
      c.indexOf("export async function cancelEwayBill"),
    );
    expect(fn).toContain("canExtendEway(");
    expect(fn).not.toMatch(/generatedAt:\s*(now|new Date)/);
  });

  /** A lorry 80 km short does not need another 1,200 km of validity. */
  it("extension recomputes validity from the REMAINING distance", () => {
    const fn = c.slice(c.indexOf("export async function extendEwayValidity"));
    expect(fn).toContain("remainingKm");
    expect(fn.slice(0, 4000)).toContain("distanceKm: data.remainingKm");
  });

  /** The portal keeps a cancelled bill, and so do we. */
  it("cancelling does not delete", () => {
    const fn = c.slice(c.indexOf("export async function cancelEwayBill"));
    expect(fn).toContain('status: "cancelled"');
    expect(fn).not.toMatch(/\.delete\(/);
  });

  /** An invoice quoting a cancelled bill prints a number covering nothing. */
  it("cancelling takes the number off the invoice", () => {
    const fn = c.slice(c.indexOf("export async function cancelEwayBill"));
    expect(fn).toContain("ewayBillNo: null");
  });

  /** Every export in a "use server" file is a browser-reachable endpoint. */
  it("the actions file exports only async functions and types", () => {
    expect(c.startsWith('"use server"')).toBe(true);
    const bad = c.match(/^export\s+(?:const|let|var|class|function)\s+\w+/gm);
    expect(bad ?? []).toEqual([]);
  });
});

describe("⚠️ it posts nothing, and that is deliberate", () => {
  /**
   * An e-way bill records a MOVEMENT, not an economic event. The revenue
   * was recognised when the invoice was issued. A journal here would
   * double the sale — once for the invoice, once for the lorry.
   */
  it("eway is not on the financial-modules list", () => {
    const block = POSTING_GATE.slice(
      POSTING_GATE.indexOf("const FINANCIAL_MODULES"),
      POSTING_GATE.indexOf("];", POSTING_GATE.indexOf("const FINANCIAL_MODULES")),
    );
    expect(block).not.toContain("eway");
  });

  it("and the action file says why", () => {
    expect(ACTIONS).toContain("POSTS NOTHING TO THE LEDGER");
  });
});

describe("⭐ the screens", () => {
  it("the list calls the engine and is in the menu", () => {
    expect(PAGE).toContain("getEwayBills");
    expect(PAGE).toContain("getEwayCandidates");
    expect(REGISTRY).toContain('href: "/gst/eway"');
    expect(REGISTRY).toContain('navId: "eway"');
  });

  it("the detail screen exposes every act", () => {
    expect(DETAIL).toContain("RecordEwayNumber");
    expect(DETAIL).toContain("AddEwayLeg");
    expect(DETAIL).toContain("ExtendEway");
    expect(DETAIL).toContain("CancelEway");
    expect(DETAIL).toContain("EwayPayload");
  });

  /**
   * ⚠️ TWO IMPLEMENTATIONS OF AN 8-HOUR WINDOW IS TWO ANSWERS TO "CAN I
   * EXTEND", and the person reading the screen would believe the wrong
   * one.
   */
  it("the client re-uses the same pure functions the server does", () => {
    expect(ACTIONS_UI).toContain('from "@/lib/gst/eway"');
    expect(ACTIONS_UI).toContain("canExtendEway");
    expect(ACTIONS_UI).toContain("canCancelEway");
    expect(PREPARE_UI).toContain("ewayValidityDays");
    expect(PREPARE_UI).toContain("partBRequired");
  });

  /** Distance is the only input that decides validity, and nobody knows that. */
  it("the prepare form shows the resulting validity while it is typed", () => {
    expect(PREPARE_UI).toContain("Valid for {days} day");
  });

  /** Both flag the state that is actually dangerous. */
  it("prepared-but-not-generated is called out on the list", () => {
    expect(PAGE).toContain("ungenerated");
    expect(PAGE).toContain("Nothing may move on them");
  });

  it("all three interactive files are client components", () => {
    for (const [n, s] of [
      ["eway-actions", ACTIONS_UI],
      ["prepare-eway", PREPARE_UI],
    ] as const) {
      expect(s.startsWith('"use client"'), n).toBe(true);
    }
    expect(PAGE.startsWith('"use client"')).toBe(false);
    expect(DETAIL.startsWith('"use client"')).toBe(false);
  });

  /** ⚠️ No GSP credentials, and the screen says so rather than pretending. */
  it("the product does not pretend to talk to the portal", () => {
    expect(DETAIL).toContain("no portal credentials");
    expect(LIB).toContain("IT DOES NOT SEND ONE");
  });
});
