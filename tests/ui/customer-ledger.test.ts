/**
 * The customer ledger.
 *
 * The sign convention and the ageing basis are the two things that, got
 * wrong, produce a report that is confidently and completely backwards.
 */
import { describe, expect, it } from "vitest";
import {
  ageCustomerAccount,
  closingBalance,
  customerPosition,
  runningBalance,
  type CustomerLedgerEntry,
  type OpenDocument,
} from "@/lib/receivables/customer-ledger";

const inv = (id: string, date: string, amount: bigint, due?: string): CustomerLedgerEntry => ({
  id,
  entryDate: date,
  entryType: "invoice",
  reference: `INV-${id}`,
  dueDate: due ?? null,
  debitMinor: amount,
  creditMinor: 0n,
});

const rcpt = (id: string, date: string, amount: bigint): CustomerLedgerEntry => ({
  id,
  entryDate: date,
  entryType: "receipt",
  reference: `RCP-${id}`,
  debitMinor: 0n,
  creditMinor: amount,
});

describe("🔴 the sign convention — a receivable, the mirror of the vendor ledger", () => {
  it("an invoice increases what they owe", () => {
    expect(closingBalance([inv("a", "2026-04-01", 100_000n)])).toBe(100_000n);
  });

  it("a receipt decreases it", () => {
    expect(closingBalance([inv("a", "2026-04-01", 100_000n), rcpt("b", "2026-04-10", 40_000n)]))
      .toBe(60_000n);
  });

  /** Positive = they owe us. Negative = we hold their money. */
  it("goes negative when a customer overpays, and says so", () => {
    expect(closingBalance([inv("a", "2026-04-01", 100_000n), rcpt("b", "2026-04-10", 150_000n)]))
      .toBe(-50_000n);
  });
});

describe("🔴 the running balance is reproducible", () => {
  it("carries the balance down in date order", () => {
    const rows = runningBalance([
      rcpt("b", "2026-04-10", 40_000n),
      inv("a", "2026-04-01", 100_000n),
    ]);
    expect(rows.map((r) => r.balanceMinor)).toEqual([100_000n, 60_000n]);
  });

  /**
   * A payment settling an invoice raised the same morning must not appear
   * above it, or the statement shows the account in credit for one line
   * and the customer queries it.
   */
  it("puts an invoice before a receipt on the same day", () => {
    const rows = runningBalance([
      rcpt("z", "2026-04-01", 100_000n),
      inv("a", "2026-04-01", 100_000n),
    ]);
    expect(rows[0]?.entryType).toBe("invoice");
    expect(rows.every((r) => r.balanceMinor >= 0n)).toBe(true);
  });

  it("is deterministic across two renders of the same data", () => {
    const entries = [inv("a", "2026-04-01", 10n), inv("b", "2026-04-01", 20n)];
    const first = runningBalance(entries).map((r) => r.id);
    const second = runningBalance([...entries].reverse()).map((r) => r.id);
    expect(first).toEqual(second);
  });
});

describe("🔴 ageing runs from the DUE date, not the invoice date", () => {
  const docs: OpenDocument[] = [
    // Raised 45 days ago on 60-day terms — NOT late.
    {
      id: "young",
      reference: "A",
      documentDate: "2026-03-01",
      dueDate: "2026-04-30",
      outstandingMinor: 100_000n,
    },
    // Due 45 days ago — properly late.
    {
      id: "late",
      reference: "B",
      documentDate: "2026-01-01",
      dueDate: "2026-03-01",
      outstandingMinor: 50_000n,
    },
  ];

  const ageing = ageCustomerAccount(docs, "2026-04-15");

  it("counts the not-yet-due invoice as not yet due", () => {
    expect(ageing.notYetDueMinor).toBe(100_000n);
  });

  it("puts the genuinely overdue one in a bucket", () => {
    const bucketed = ageing.buckets.reduce((s, b) => s + b.amountMinor, 0n);
    expect(bucketed).toBe(50_000n);
  });

  /**
   * Folding not-yet-due into a "0–30 days" bucket makes a healthy account
   * indistinguishable from one a month late, and the two demand opposite
   * actions.
   */
  it("keeps not-yet-due OUT of the first bucket", () => {
    expect(ageing.buckets[0]?.amountMinor).toBe(0n);
  });

  it("totals everything outstanding regardless of bucket", () => {
    expect(ageing.outstandingMinor).toBe(150_000n);
  });

  it("falls back to the document date when no term was agreed", () => {
    const a = ageCustomerAccount(
      [{ id: "x", reference: "X", documentDate: "2026-01-01", outstandingMinor: 1n }],
      "2026-04-15",
    );
    expect(a.notYetDueMinor).toBe(0n);
    expect(a.oldestDocumentDays).toBeGreaterThan(100);
  });

  it("ignores a fully settled document", () => {
    const a = ageCustomerAccount(
      [{ id: "paid", reference: "P", documentDate: "2026-01-01", outstandingMinor: 0n }],
      "2026-04-15",
    );
    expect(a.outstandingMinor).toBe(0n);
  });
});

describe("🔴 unapplied credit is reported, never silently netted off", () => {
  it("keeps the two figures apart", () => {
    const p = customerPosition({
      entries: [inv("a", "2026-04-01", 200_000n), rcpt("b", "2026-04-02", 200_000n)],
      openDocuments: [
        {
          id: "a",
          reference: "A",
          documentDate: "2026-04-01",
          dueDate: "2026-04-05",
          outstandingMinor: 200_000n,
        },
      ],
      unappliedCreditMinor: 200_000n,
      asOf: "2026-05-01",
    });

    // A filing problem, not a payment problem — and both stay visible.
    expect(p.balanceMinor).toBe(0n);
    expect(p.unappliedCreditMinor).toBe(200_000n);
    expect(p.ageing.outstandingMinor).toBe(200_000n);
  });

  it("never reports negative unapplied credit", () => {
    const p = customerPosition({
      entries: [],
      openDocuments: [],
      unappliedCreditMinor: -500n,
      asOf: "2026-05-01",
    });
    expect(p.unappliedCreditMinor).toBe(0n);
  });
});
