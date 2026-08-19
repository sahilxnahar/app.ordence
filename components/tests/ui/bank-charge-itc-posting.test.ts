/**
 * Ordence — 🔴🔴🔴 POSTING THE INPUT CREDIT ON A BANK CHARGE · 0112
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 * ══════════════════════════════════════════════════════════════════════
 * Batch 0110 built the register, the refusals and the screen, and stopped
 * at a boundary it was right to stop at — the posting builders live in a
 * file another stream owned. Its own report says what that left behind:
 *
 *     "Until it exists, `invoice_recorded` is a worklist state, not a
 *      posted credit."
 *
 * So a customer could transcribe the bank's tax invoice, watch the
 * arithmetic foot against the money that left the account, and the
 * recoverable tax stayed inside Bank Charges in the trial balance. The
 * register knew. The ledger did not. Nothing anywhere said so, because
 * "credit identified" is exactly what somebody reading that screen would
 * take to mean "it is in the books".
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 AND THE DESIGN DECISION UNDER TEST IS A REFUSAL
 * ══════════════════════════════════════════════════════════════════════
 * Posting is NOT a fourth status. Six of 0110's CHECK constraints read
 * `status <> 'invoice_recorded' OR <the real rule>`, so a `credit_posted`
 * status would have switched all six off for exactly the rows whose
 * figures are already in the ledger. `SQL-FILES/0112`'s drill proves the
 * constraint still fires on a posted row; these tests prove the
 * TypeScript side agrees with that shape.
 */

import { describe, expect, it } from "vitest";
import {
  buildBankChargeItcPosting,
  assertPurchaseBalances,
  PURCHASE_ROLE_META,
  POSTING_ROLE_REGISTRY,
  modulesNeeding,
  type PurchaseLeg,
} from "@/lib/accounting/sales-posting";
import {
  emptyTotalsFor,
  postingRefusal,
  postingStateLabel,
  totalByPeriod,
  type DeferralRow,
} from "@/lib/banking/bank-charge-itc";

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

const recorded = (over: Partial<DeferralRow> = {}) =>
  deferral({ status: "invoice_recorded", creditMinor: 180_00n, invoiceNo: "BNK/1", ...over });

const posted = (over: Partial<DeferralRow> = {}) =>
  recorded({ creditPostedAt: "2026-06-02T10:00:00.000Z", creditTransactionId: "t1", ...over });

const leg = (legs: readonly PurchaseLeg[], role: string) =>
  legs.find((l) => l.role === role) ?? null;

/* ================================================================== */
describe("⭐⭐⭐ the journal itself", () => {
  it("🔴 debits the four input heads and credits Bank Charges, not an asset", () => {
    const legs = buildBankChargeItcPosting({
      cgstMinor: 90_00n,
      sgstMinor: 90_00n,
      igstMinor: 0n,
      cessMinor: 0n,
      narration: "BNK/26/0091",
    });

    expect(leg(legs, "input_cgst")).toMatchObject({ entryType: "debit", amountMinor: 90_00n });
    expect(leg(legs, "input_sgst")).toMatchObject({ entryType: "debit", amountMinor: 90_00n });
    /**
     * 🔴 THE ONE THAT IS EASY TO GET WRONG. The credit is the EXPENSE,
     * because the expense was overstated: the gross went to Bank Charges
     * when part of it was recoverable tax. Crediting `expense` — the
     * Purchases role — would compile, balance, and take the tax out of
     * the wrong account, leaving Bank Charges overstated by exactly the
     * credit that was claimed.
     */
    expect(leg(legs, "bank_charges")).toMatchObject({
      entryType: "credit",
      amountMinor: 180_00n,
    });
    expect(leg(legs, "expense")).toBeNull();
    expect(leg(legs, "payable")).toBeNull();
    expect(leg(legs, "bank")).toBeNull();
  });

  it("⚠️ omits a head that is zero rather than posting a zero leg", () => {
    const legs = buildBankChargeItcPosting({
      cgstMinor: 90_00n,
      sgstMinor: 90_00n,
      igstMinor: 0n,
      cessMinor: 0n,
      narration: "n",
    });
    expect(leg(legs, "igst" as string)).toBeNull();
    expect(leg(legs, "input_igst")).toBeNull();
    expect(leg(legs, "input_cess")).toBeNull();
    expect(legs).toHaveLength(3);
  });

  it("⭐ an IGST charge posts one debit, because s.12(12) can make it inter-State", () => {
    const legs = buildBankChargeItcPosting({
      cgstMinor: 0n,
      sgstMinor: 0n,
      igstMinor: 180_00n,
      cessMinor: 0n,
      narration: "n",
    });
    expect(leg(legs, "input_igst")).toMatchObject({ amountMinor: 180_00n });
    expect(leg(legs, "bank_charges")).toMatchObject({ amountMinor: 180_00n });
    expect(legs).toHaveLength(2);
  });

  it("🔴 balances for every combination of heads — property, not example", () => {
    const values = [0n, 1n, 7n, 90_00n, 123_45n];
    for (const c of values)
      for (const s of values)
        for (const i of values)
          for (const cess of values) {
            if (c + s + i + cess === 0n) continue;
            const legs = buildBankChargeItcPosting({
              cgstMinor: c, sgstMinor: s, igstMinor: i, cessMinor: cess, narration: "n",
            });
            expect(() => assertPurchaseBalances(legs)).not.toThrow();
            const debits = legs.filter((l) => l.entryType === "debit")
              .reduce((t, l) => t + l.amountMinor, 0n);
            expect(leg(legs, "bank_charges")!.amountMinor).toBe(debits);
          }
  });

  it("🔴 refuses a zero credit rather than posting a journal of nothing", () => {
    expect(() =>
      buildBankChargeItcPosting({
        cgstMinor: 0n, sgstMinor: 0n, igstMinor: 0n, cessMinor: 0n, narration: "n",
      }),
    ).toThrow(/not a journal/i);
  });

  it("🔴 refuses a negative head rather than netting it — a bank credit note is its own document", () => {
    expect(() =>
      buildBankChargeItcPosting({
        cgstMinor: 200_00n, sgstMinor: -20_00n, igstMinor: 0n, cessMinor: 0n, narration: "n",
      }),
    ).toThrow(/cannot be negative/i);
  });
});

/* ================================================================== */
describe("⭐⭐ the role, and the registry it has to be visible in", () => {
  /**
   * 🔴 THE FAILURE THIS CATCHES IS THE ONE BATCH 0108 FOUND: a role a
   * builder can emit that the posting-accounts screen cannot map. The
   * operator then meets "no ledger is mapped for bank_charges" and opens
   * a screen the role is not on.
   */
  it("🔴 bank_charges is mappable and names BOTH modules that need it", () => {
    const entry = POSTING_ROLE_REGISTRY.find((r) => r.role === "bank_charges");
    expect(entry).toBeDefined();
    expect(modulesNeeding("bank_charges")).toEqual(
      expect.arrayContaining(["sales", "purchase"]),
    );
  });

  it("⚠️ the purchase family declares it, so a Record<PurchasePostingRole> cannot omit it", () => {
    expect(PURCHASE_ROLE_META.bank_charges).toBeDefined();
    expect(PURCHASE_ROLE_META.bank_charges.accountType).toBe("expense");
  });

  it("⭐ every input head this journal can emit is mappable too", () => {
    for (const role of ["input_cgst", "input_sgst", "input_igst", "input_cess"]) {
      expect(POSTING_ROLE_REGISTRY.some((r) => r.role === role)).toBe(true);
    }
  });
});

/* ================================================================== */
describe("🔴 the refusals, before the button is pressed", () => {
  it("refuses a second posting, naming the double claim rather than saying 'already done'", () => {
    expect(postingRefusal(posted())).toMatch(/already posted/i);
    expect(postingRefusal(posted())).toMatch(/Rule 36\(4\)/);
  });

  it("refuses a charge with no invoice, and cites s.16(2)(a) rather than the schema", () => {
    expect(postingRefusal(deferral())).toMatch(/16\(2\)\(a\)/);
  });

  it("refuses a not_claimable charge, and asks for the decision to be reversed first", () => {
    expect(
      postingRefusal(deferral({ status: "not_claimable" })),
    ).toMatch(/Reverse that decision/i);
  });

  it("⚠️ refuses a recorded invoice that carries no tax, and names the exemption", () => {
    const r = postingRefusal(recorded({ creditMinor: 0n }));
    expect(r).toMatch(/no tax/i);
    expect(r).toMatch(/12\/2017/);
  });

  it("⭐ permits exactly one case: recorded, unposted, with a credit on it", () => {
    expect(postingRefusal(recorded())).toBeNull();
  });
});

/* ================================================================== */
describe("⭐⭐ the label, which is what the register shows", () => {
  /**
   * 🔴 THE THREE STATUSES CANNOT TELL THESE TWO APART, which is why the
   * screen showed one number for both and one of them was a job nobody
   * knew was outstanding.
   */
  it("distinguishes recorded-and-unposted from posted", () => {
    expect(postingStateLabel(recorded())).toBe("Recorded, not yet posted");
    expect(postingStateLabel(posted())).toBe("Posted to the ledger");
  });

  it("⚠️ leaves the other two statuses reading exactly as they did before 0112", () => {
    expect(postingStateLabel(deferral())).toBe("No tax invoice yet");
    expect(postingStateLabel(deferral({ status: "not_claimable" }))).toBe(
      "Not claimable, deliberately",
    );
  });
});

/* ================================================================== */
describe("🔴🔴 the totals, and the identity that must never drift", () => {
  it("⭐ posted + unposted = identified, over a mixed period", () => {
    const rows = [
      recorded({ id: "a", creditMinor: 180_00n }),
      posted({ id: "b", creditMinor: 90_00n }),
      posted({ id: "c", creditMinor: 45_00n }),
      deferral({ id: "d" }),
      deferral({ id: "e", status: "not_claimable" }),
    ];
    const [t] = totalByPeriod(rows);
    expect(t.identifiedCreditMinor).toBe(315_00n);
    expect(t.postedCreditMinor).toBe(135_00n);
    expect(t.unpostedCreditMinor).toBe(180_00n);
    expect(t.postedCreditMinor + t.unpostedCreditMinor).toBe(t.identifiedCreditMinor);
    expect(t.postedCount + t.unpostedCount).toBe(t.identifiedCount);
  });

  it("🔴 a posted flag on a row that is not invoice_recorded is ignored, matching the CHECK", () => {
    /**
     * ⚠️ `_posted_needs_invoice` in 0112 makes this row unreachable in
     * the database. It is asserted anyway, because a hand-written row or
     * a future migration bug must not be able to make this function
     * report a credit as claimed that no invoice supports.
     */
    const rows = [
      deferral({
        id: "x",
        status: "not_claimable",
        creditMinor: 500_00n,
        creditPostedAt: "2026-06-02T00:00:00.000Z",
        creditTransactionId: "t9",
      }),
    ];
    const [t] = totalByPeriod(rows);
    expect(t.postedCreditMinor).toBe(0n);
    expect(t.postedCount).toBe(0);
  });

  it("⚠️ the identity also holds on an empty period", () => {
    const t = emptyTotalsFor("2026-05");
    expect(t.postedCreditMinor + t.unpostedCreditMinor).toBe(t.identifiedCreditMinor);
    expect(t.postedCount + t.unpostedCount).toBe(t.identifiedCount);
  });

  it("🔴 emptyTotalsFor has every field the type declares — no optional members", () => {
    /**
     * ⭐ THIS IS WHY THE HELPER EXISTS. The zero-totals object was
     * written out by hand in `server/actions/banking.ts` and 0112's four
     * new fields turned it into a type error. That was the good outcome,
     * and it was good only because nothing on `ItcPeriodTotals` is
     * optional. This test fails the day somebody makes one optional to
     * make a literal compile.
     */
    const t = emptyTotalsFor("2026-05");
    for (const v of Object.values(t)) expect(v).not.toBeUndefined();
    expect(Object.keys(t)).toHaveLength(13);
  });
});
