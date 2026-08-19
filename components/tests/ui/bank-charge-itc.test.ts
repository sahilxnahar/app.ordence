/**
 * Ordence — 🔴🔴🔴 THE INPUT CREDIT ON A BANK CHARGE · Batch 0110
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * `0102` posts the GROSS bank charge and its role help says to claim the
 * input credit from the bank's own tax invoice by hand. Nothing recorded
 * that it was owed, nothing totalled it, and nothing ever asked — so the
 * credit on every bank charge went silently unclaimed.
 *
 * 🔴 AND THE OBVIOUS FIX IS THE ONE THAT FAILS AN AUDIT: split 18% off
 *    every charge. s.16(2)(a) CGST Act gives no credit without the tax
 *    invoice in hand; s.16(2)(aa) with Rule 36(4) wants it in GSTR-2B,
 *    which a figure with no supplier invoice number can never reach; and
 *    s.12(12) IGST Act can make a bank charge IGST rather than CGST+SGST.
 *
 * ⭐ SO THE TEST THAT MATTERS IS THAT A SPLIT WHICH DOES NOT FOOT TO THE
 *    MONEY THAT LEFT THE ACCOUNT IS REFUSED. That single arithmetic rule
 *    is what tells a transcribed invoice from an assumed rate, and it is
 *    asserted here as a property over every rate that could be guessed.
 */

import { describe, expect, it } from "vitest";
import {
  claimableCreditMinor,
  ITC_DEFERRAL_STATUSES,
  ITC_STATUS_META,
  taxPeriodOf,
  totalByPeriod,
  transcribedTotalMinor,
  transcriptionRefusal,
  unclaimedCreditNote,
  type DeferralRow,
  type TranscribedTaxInvoice,
} from "@/lib/banking/bank-charge-itc";

/* ------------------------------------------------------------------ */
/* HELPERS                                                             */
/* ------------------------------------------------------------------ */

/** A real GSTIN shape with a valid check character. */
const BANK_GSTIN = "27AAACR5055K1Z7";

function invoice(over: Partial<TranscribedTaxInvoice> = {}): TranscribedTaxInvoice {
  return {
    invoiceNo: "BNK/26/0091",
    invoiceDate: "2026-05-31",
    supplierGstin: BANK_GSTIN,
    taxableValueMinor: 1_000_00n,
    cgstMinor: 90_00n,
    sgstMinor: 90_00n,
    igstMinor: 0n,
    cessMinor: 0n,
    ...over,
  };
}

const check = (
  grossMinor: bigint,
  inv: TranscribedTaxInvoice,
  gstinProblem: string | null = null,
  chargeValueDate = "2026-05-14",
) => transcriptionRefusal({ grossMinor, invoice: inv, gstinProblem, chargeValueDate });

function deferral(over: Partial<DeferralRow> = {}): DeferralRow {
  return {
    id: "d1",
    statementLineId: "l1",
    valueDate: "2026-05-14",
    taxPeriod: "2026-05",
    grossMinor: 1_180_00n,
    status: "awaiting_invoice",
    creditMinor: 0n,
    invoiceNo: null,
    creditPostedAt: null,
    creditTransactionId: null,
    ...over,
  };
}

/* ================================================================== */
/* ① 🔴🔴🔴 THE SPLIT MUST FOOT TO THE MONEY THAT MOVED                */
/* ================================================================== */

describe("transcribing the bank's tax invoice", () => {
  it("accepts a split that foots exactly", () => {
    expect(check(1_180_00n, invoice())).toBeNull();
  });

  /**
   * 🔴🔴 THE PROPERTY, NOT A WORKED EXAMPLE.
   *
   * ⚠️ FOR EVERY RATE SOMEBODY MIGHT GUESS, AND FOR EVERY OFF-BY-A-PAISA
   *    VERSION OF THE RIGHT ONE, the transcription is refused unless the
   *    whole thing comes to the gross. This is the single check that
   *    stops a derived rate re-entering through the form, so it is
   *    asserted across the space rather than at one point.
   */
  it("refuses any split that does not come to the gross", () => {
    const gross = 1_180_00n;
    let refusals = 0;

    for (const taxable of [
      900_00n, 950_00n, 1_000_00n, 1_050_00n, 1_100_00n, 1_180_00n,
    ]) {
      for (const half of [0n, 45_00n, 60_00n, 90_00n, 106_20n]) {
        const total = taxable + half + half;
        const refusal = check(
          gross,
          invoice({ taxableValueMinor: taxable, cgstMinor: half, sgstMinor: half }),
        );
        if (total === gross) {
          // ⭐ The one combination that foots is the one that is allowed.
          // ⚠️ Unless it carries no tax at all, which is a different fact
          //    and gets its own refusal — see below.
          if (half > 0n) expect(refusal).toBeNull();
        } else {
          expect(refusal).not.toBeNull();
          refusals += 1;
        }
      }
    }

    expect(refusals).toBeGreaterThan(0);
  });

  /** ⚠️ Including one paisa out, in either direction. */
  it("refuses a split that is a single paisa out", () => {
    expect(check(1_180_00n, invoice({ cessMinor: 1n }))).not.toBeNull();
    expect(check(1_180_00n, invoice({ taxableValueMinor: 999_99n }))).not.toBeNull();
  });

  /**
   * ⭐ AND THE REFUSAL EXPLAINS THE CONSOLIDATED-INVOICE CASE rather than
   * inviting the operator to fudge a figure until the form submits. Banks
   * invoice a whole month at once, and the honest answer is to attribute
   * the part that belongs to each charge.
   */
  it("tells the operator what to do about a consolidated invoice", () => {
    const message = check(1_180_00n, invoice({ taxableValueMinor: 5_000_00n }));
    expect(message).toMatch(/several charges|belongs to it/i);
  });

  /**
   * 🔴 CGST AND SGST ARE TWO HALVES OF ONE RATE. A difference between
   * them is a transcription error, never something a bank charged.
   */
  it("refuses unequal CGST and SGST", () => {
    expect(
      check(1_180_00n, invoice({ cgstMinor: 100_00n, sgstMinor: 80_00n })),
    ).not.toBeNull();
  });

  /**
   * 🔴 ONE SUPPLY CARRIES IGST OR CGST+SGST, NEVER BOTH.
   *
   * ⚠️ THIS IS A TRANSCRIPTION CHECK, NOT A DETERMINATION. Which applies
   * is decided by the bank under s.12(12) IGST Act and printed on the
   * invoice; nothing in this module decides it.
   */
  it("refuses an invoice entered with both regimes, and accepts either alone", () => {
    expect(
      check(
        1_180_00n,
        invoice({ cgstMinor: 45_00n, sgstMinor: 45_00n, igstMinor: 90_00n }),
      ),
    ).not.toBeNull();

    expect(
      check(
        1_180_00n,
        invoice({ cgstMinor: 0n, sgstMinor: 0n, igstMinor: 180_00n }),
      ),
    ).toBeNull();
  });

  /**
   * 🔴 A CREDIT CLAIMED AGAINST A GSTIN THAT DOES NOT EXIST IS REJECTED
   * WHEN THE RETURN IS FILED, WEEKS LATER, AND THE MONTH IS CLOSED BY
   * THEN.
   */
  it("refuses a transcription whose GSTIN did not validate", () => {
    expect(check(1_180_00n, invoice(), "The check character is wrong.")).not.toBeNull();
  });

  it("refuses an invoice with no number", () => {
    expect(check(1_180_00n, invoice({ invoiceNo: "   " }))).not.toBeNull();
  });

  /**
   * ⚠️ THE INVOICE MAY BE DATED AFTER THE CHARGE — banks consolidate a
   * month and invoice at the end of it. It may NOT predate it: a date
   * typed into the wrong year puts the credit in a return already filed.
   */
  it("allows an invoice dated after the charge and refuses one dated before", () => {
    expect(check(1_180_00n, invoice({ invoiceDate: "2026-05-31" }))).toBeNull();
    expect(check(1_180_00n, invoice({ invoiceDate: "2026-05-14" }))).toBeNull();
    expect(check(1_180_00n, invoice({ invoiceDate: "2026-05-13" }))).not.toBeNull();
    expect(check(1_180_00n, invoice({ invoiceDate: "2025-05-31" }))).not.toBeNull();
  });

  /**
   * ⭐ AN INVOICE CARRYING NO TAX IS AN EXEMPT SUPPLY, WHICH IS A
   * DIFFERENT FACT FROM A ZERO CREDIT AND GETS A DIFFERENT ROUTE.
   * Interest is exempt under Notification 12/2017-CT(R) entry 27, and the
   * two look identical on a total.
   */
  it("refuses a no-tax invoice and points at the not-claimable route", () => {
    const message = check(
      1_180_00n,
      invoice({ taxableValueMinor: 1_180_00n, cgstMinor: 0n, sgstMinor: 0n }),
    );
    expect(message).not.toBeNull();
    expect(message!).toMatch(/not claimable/i);
  });

  it("refuses a negative figure on any head", () => {
    for (const over of [
      { taxableValueMinor: -1n },
      { cgstMinor: -1n },
      { sgstMinor: -1n },
      { igstMinor: -1n },
      { cessMinor: -1n },
    ]) {
      expect(check(1_180_00n, invoice(over))).not.toBeNull();
    }
  });

  /** ⭐ The credit is every tax head and nothing else. Exact bigint sums. */
  it("counts every tax head as credit and the taxable value as none of it", () => {
    const inv = invoice({
      taxableValueMinor: 1_000_00n,
      cgstMinor: 90_00n,
      sgstMinor: 90_00n,
    });
    expect(claimableCreditMinor(inv)).toBe(180_00n);
    expect(transcribedTotalMinor(inv)).toBe(1_180_00n);
    expect(transcribedTotalMinor(inv) - claimableCreditMinor(inv)).toBe(
      inv.taxableValueMinor,
    );
  });
});

/* ================================================================== */
/* ② 🔴 THE STATUS DECIDES WHICH TOTAL A ROW LANDS IN                  */
/* ================================================================== */

describe("the register totals", () => {
  /**
   * 🔴🔴 THE READ THAT MAKES `status` MEAN SOMETHING RATHER THAN MERELY
   *    EXIST. This codebase has shipped eleven fields that were declared
   *    and enforced by nothing; a status column that did not change a
   *    total would be the twelfth.
   */
  it("moves a charge between totals when only its status changes", () => {
    const base = deferral({ grossMinor: 1_180_00n });

    const awaiting = totalByPeriod([base])[0]!;
    expect(awaiting.awaitingInvoiceGrossMinor).toBe(1_180_00n);
    expect(awaiting.identifiedCreditMinor).toBe(0n);
    expect(awaiting.notClaimableGrossMinor).toBe(0n);

    const recorded = totalByPeriod([
      { ...base, status: "invoice_recorded", creditMinor: 180_00n },
    ])[0]!;
    expect(recorded.awaitingInvoiceGrossMinor).toBe(0n);
    expect(recorded.identifiedCreditMinor).toBe(180_00n);

    const refused = totalByPeriod([{ ...base, status: "not_claimable" }])[0]!;
    expect(refused.awaitingInvoiceGrossMinor).toBe(0n);
    expect(refused.notClaimableGrossMinor).toBe(1_180_00n);
  });

  /**
   * ⚠️ THE THREE TOTALS ARE NEVER NETTED. A single "unclaimed credit"
   * figure would combine an amount that is KNOWN with one that is not
   * knowable until an invoice arrives, and the combined number would be
   * wrong in a direction nobody could work out.
   *
   * ⭐ The property: the gross of the three buckets is the gross of the
   * period, whatever the mix of statuses.
   */
  it("splits the period's gross across the three buckets without loss", () => {
    const rows: DeferralRow[] = [
      deferral({ id: "a", grossMinor: 100_00n }),
      deferral({ id: "b", grossMinor: 250_00n, status: "invoice_recorded", creditMinor: 38_14n }),
      deferral({ id: "c", grossMinor: 375_00n, status: "not_claimable" }),
      deferral({ id: "d", grossMinor: 1n }),
    ];
    const totals = totalByPeriod(rows)[0]!;

    expect(
      totals.awaitingInvoiceGrossMinor +
        totals.notClaimableGrossMinor +
        // ⚠️ The recorded bucket reports CREDIT, not gross, so its gross is
        //    taken from the rows. That asymmetry is deliberate: what is
        //    useful about a recorded charge is the claim, and what is
        //    useful about an unrecorded one is how much money is at stake.
        rows
          .filter((r) => r.status === "invoice_recorded")
          .reduce((s, r) => s + r.grossMinor, 0n),
    ).toBe(totals.grossMinor);

    expect(
      totals.awaitingInvoiceCount + totals.identifiedCount + totals.notClaimableCount,
    ).toBe(totals.chargeCount);
  });

  /** ⭐ Periods are kept apart, and the newest is first for the person filing. */
  it("groups by tax period and puts the newest first", () => {
    const totals = totalByPeriod([
      deferral({ id: "a", taxPeriod: "2026-03" }),
      deferral({ id: "b", taxPeriod: "2026-05" }),
      deferral({ id: "c", taxPeriod: "2026-04" }),
    ]);
    const periods = totals.map((t) => t.taxPeriod);
    expect(periods).toEqual([...periods].sort().reverse());
    expect(new Set(periods).size).toBe(periods.length);
  });

  /**
   * ⭐ THE PERIOD IS THE MONTH THE BANK TOOK THE MONEY, never the month
   * it was noticed. A March charge found in June belongs in March's
   * return, which is the same rule the posting date follows.
   */
  it("takes the tax period from the value date", () => {
    expect(taxPeriodOf("2026-03-31")).toBe("2026-03");
    expect(taxPeriodOf("2026-01-01")).toBe("2026-01");
  });

  /**
   * ⚠️ THE SENTENCE APPEARS ONLY WHEN THERE IS SOMETHING TO CHASE. An
   * always-present line reading "0 charges" trains the eye to skip it.
   */
  it("says nothing when nothing is awaiting an invoice", () => {
    const clean = totalByPeriod([
      deferral({ status: "invoice_recorded", creditMinor: 180_00n }),
    ])[0]!;
    expect(unclaimedCreditNote(clean)).toBeNull();

    const dirty = totalByPeriod([deferral()])[0]!;
    expect(unclaimedCreditNote(dirty)).not.toBeNull();
    // ⭐ And it cites the statute rather than merely nagging.
    expect(unclaimedCreditNote(dirty)!).toMatch(/16\(2\)/);
  });
});

/* ================================================================== */
/* ③ THE VOCABULARY IS CLOSED AND DESCRIBED                            */
/* ================================================================== */

describe("the statuses", () => {
  /**
   * ⚠️ EVERY STATUS HAS HELP TEXT, because a three-way state an operator
   * cannot tell apart is a state they will set at random. Asserted over
   * the list rather than one by one, so a fourth status added later
   * cannot ship without its explanation.
   */
  it("describes every status it permits", () => {
    for (const status of ITC_DEFERRAL_STATUSES) {
      expect(ITC_STATUS_META[status].label.length).toBeGreaterThan(0);
      expect(ITC_STATUS_META[status].help.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ITC_STATUS_META).sort()).toEqual([...ITC_DEFERRAL_STATUSES].sort());
  });
});

/* ================================================================== */
/* ④ 🔴 THE MODULE DOES NOT DERIVE A RATE, AND SAYS SO IN CODE          */
/* ================================================================== */

describe("no rate is ever derived", () => {
  /**
   * 🔴🔴 THE STRUCTURAL ASSERTION. Every argument in this batch rests on
   *    the claim that no percentage is applied to a bank charge anywhere.
   *    A comment saying so is not enforcement; this is.
   *
   * ⚠️ IT READS THE SOURCE WITH COMMENTS AND STRINGS STRIPPED, for the
   *    same reason `scripts/check-tax-decisions.mjs` does: this file's own
   *    prose talks about 18%, and a check that fires on its explanation
   *    is a check that gets an exemption list bolted onto it.
   */
  it("contains no percentage arithmetic in the engine or its service", async () => {
    const { readFileSync } = await import("node:fs");

    const stripped = (path: string) => {
      const src = readFileSync(path, "utf8");
      let out = "";
      let i = 0;
      const blank = (s: string) => s.replace(/[^\n]/g, " ");
      while (i < src.length) {
        const two = src.slice(i, i + 2);
        if (two === "//") {
          const end = src.indexOf("\n", i);
          const stop = end === -1 ? src.length : end;
          out += blank(src.slice(i, stop));
          i = stop;
        } else if (two === "/*") {
          const end = src.indexOf("*/", i + 2);
          const stop = end === -1 ? src.length : end + 2;
          out += blank(src.slice(i, stop));
          i = stop;
        } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
          const quote = src[i];
          let j = i + 1;
          while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
          out += blank(src.slice(i, j + 1));
          i = j + 1;
        } else {
          out += src[i];
          i += 1;
        }
      }
      return out;
    };

    for (const path of [
      "lib/banking/bank-charge-itc.ts",
      "server/banking/bank-charge-itc-service.ts",
    ]) {
      const body = stripped(path);
      // 🔴 No rate constants, no basis points, no percentage division.
      expect(body).not.toMatch(/\b18\b|\bbps\b|\/\s*118|\*\s*0\.\d/);
      expect(body).not.toMatch(/applyRateBps|ratePercent|gstRate/);
    }
  });
});
