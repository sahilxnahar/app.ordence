/**
 * Ordence — ⭐⭐⭐ ADVANCES, LOANS AND REIMBURSEMENTS
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHY THESE ASSERTIONS AND NOT OTHERS
 * ══════════════════════════════════════════════════════════════════════
 * Every one of these failures is INVISIBLE to the person it costs. An
 * employee cannot see a paise of rounding in a schedule, cannot audit a
 * balance counter, cannot tell a refused deduction from a clamped one,
 * and has no idea that a missing bill turned a repayment into salary.
 *
 *   ① THE INSTALMENTS SUM TO THE PRINCIPAL EXACTLY, IN `bigint`, for a
 *     range of awkward principals and counts. Asserted as an EQUALITY on
 *     the fold, not on any one instalment, so the remainder can move
 *     without the test noticing and a lost paise cannot hide.
 *   ② THE BALANCE IS DERIVED FROM THE LEDGER. Asserted as a RELATION:
 *     the same advance with different ledgers produces different
 *     balances, and appending a recovery moves the balance by exactly
 *     that recovery. Nothing here reads a stored field, so a counter
 *     could not make it pass.
 *   ③ AN OVER-CAP RECOVERY REFUSES AND THE SCHEDULE EXTENDS. Asserted on
 *     BEHAVIOUR — nothing recovered, sum unchanged, tail moved — rather
 *     than on any message, and the two schedules differ only in the
 *     deferral so no arithmetic change can make it pass.
 *   ④ A REIMBURSEMENT WITHOUT EVIDENCE IS TAXABLE. Asserted as a
 *     relation between two claims that differ ONLY in the bill, so no
 *     wording, field ordering or default can make it pass by accident.
 *
 * ⚠️ AND ONE THAT MATTERS AS MUCH: THE CAP IS THE SETTLEMENT'S CAP. The
 * co-operative-society limb of the s.7(3) proviso is asserted THROUGH
 * the advances engine using the settlement's own exported constants. If
 * anybody writes a second cap here, that test fails.
 */

import { describe, expect, it } from "vitest";

import {
  ADVANCE_RECOVERY_KIND,
  addMonths,
  advanceStatus,
  buildInstalmentSchedule,
  decidePeriodRecovery,
  deferInstalment,
  maximumOutstandingMinor,
  outstandingMinor,
  type AdvanceAgreement,
  type RecoveryLedgerEntry,
} from "@/lib/payroll/advances";
import {
  DEDUCTION_CAP_BP,
  DEDUCTION_CAP_BP_WITH_CO_OPERATIVE,
  RECOVERY_HEAD_BY_KIND,
  maximumLawfulDeductionMinor,
  type Recovery,
} from "@/lib/payroll/settlement";
import {
  EVIDENCE_POLICY_DEFAULT,
  assessReimbursement,
  type EvidenceDocument,
  type ReimbursementClaim,
} from "@/lib/payroll/reimbursements";

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

function agreementFor(principalMinor: string, instalmentCount: number): AdvanceAgreement {
  return {
    kind: "salary_advance",
    principalMinor,
    instalmentCount,
    firstRecoveryPeriod: "2026-04",
    agreementReference: "ADV/2026/0007 — signed advance agreement",
    employeeConsentedOn: "2026-03-28",
    interestRateBp: 0,
    limits: null,
  };
}

const sumOf = (xs: readonly { readonly amountMinor: bigint }[]): bigint =>
  xs.reduce((s, x) => s + x.amountMinor, 0n);

/* ================================================================== */
/* ① THE SCHEDULE SUMS TO THE PRINCIPAL, EXACTLY                       */
/* ================================================================== */

describe("the instalment schedule", () => {
  /**
   * 🔴 THE LOAD-BEARING ONE. A schedule a paise short never closes the
   * advance; a paise over is a deduction s.7(1) does not authorise.
   */
  it("sums to the principal exactly for every awkward principal and count", () => {
    const principals = ["1000000", "1000001", "999999", "1", "7", "123456789", "10000000"];
    const counts = [1, 2, 3, 6, 7, 11, 12, 13, 24];

    for (const p of principals) {
      for (const n of counts) {
        const schedule = buildInstalmentSchedule(agreementFor(p, n));
        expect(schedule.problems).toEqual([]);
        // ⭐ The fold, not any one instalment.
        expect(sumOf(schedule.instalments)).toBe(BigInt(p));
        expect(schedule.totalMinor).toBe(BigInt(p));
        // The count agreed is the count scheduled — s.12(b).
        expect(schedule.instalments).toHaveLength(Math.min(n, n));
      }
    }
  });

  it("puts the remainder in the LAST instalment and nowhere else", () => {
    // ₹10,000 over three months is 3333.33 recurring.
    const schedule = buildInstalmentSchedule(agreementFor("1000000", 3));
    const [first, second, third] = schedule.instalments;
    expect(first?.amountMinor).toBe(second?.amountMinor);
    // ⚠️ Asserted as a RELATION, not as the literal 333334.
    expect((third?.amountMinor ?? 0n) - (first?.amountMinor ?? 0n)).toBe(
      1000000n - (first?.amountMinor ?? 0n) * 3n,
    );
    expect(sumOf(schedule.instalments)).toBe(1000000n);
  });

  it("never carries a float across the boundary", () => {
    // 🔴 The failure this guards: BigInt(30.5) THROWS. Every amount in
    // the schedule must be an exact bigint, so the round-trip through a
    // decimal string is lossless.
    const schedule = buildInstalmentSchedule(agreementFor("1000001", 7));
    for (const i of schedule.instalments) {
      expect(typeof i.amountMinor).toBe("bigint");
      expect(BigInt(i.amountMinor.toString())).toBe(i.amountMinor);
    }
  });

  it("refuses a schedule with no agreed instalments rather than inventing one", () => {
    const bad = buildInstalmentSchedule(agreementFor("1000000", 0));
    expect(bad.instalments).toEqual([]);
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it("says out loud that the State s.12(b) rules have not been configured", () => {
    // ⚠️ A STATED GAP, not a guessed limit.
    const schedule = buildInstalmentSchedule(agreementFor("1000000", 6));
    expect(schedule.notes.some((n) => n.includes("s.12(b)"))).toBe(true);
  });
});

/* ================================================================== */
/* ② THE BALANCE IS DERIVED FROM THE LEDGER                            */
/* ================================================================== */

describe("the outstanding balance", () => {
  const agreement = agreementFor("1000000", 4);

  /**
   * 🔴 ASSERTED AS A RELATION BETWEEN TWO LEDGERS. A stored counter
   * could not satisfy this, because nothing in the assertion reads a
   * field that a counter could live in.
   */
  it("moves by exactly the recovery that was appended, and by nothing else", () => {
    const before: readonly RecoveryLedgerEntry[] = [
      { period: "2026-04", amountMinor: "250000", payslipReference: "PS/1" },
    ];
    const after: readonly RecoveryLedgerEntry[] = [
      ...before,
      { period: "2026-05", amountMinor: "250000", payslipReference: "PS/2" },
    ];

    const a = outstandingMinor(agreement.principalMinor, before);
    const b = outstandingMinor(agreement.principalMinor, after);
    expect(a - b).toBe(250000n);
  });

  it("is the same number however the ledger rows are ordered", () => {
    // ⚠️ A counter depends on the order updates arrived in. A fold does
    // not, and that difference IS the reason for the fold.
    const forwards: readonly RecoveryLedgerEntry[] = [
      { period: "2026-04", amountMinor: "250000", payslipReference: "PS/1" },
      { period: "2026-05", amountMinor: "250000", payslipReference: "PS/2" },
      { period: "2026-06", amountMinor: "250000", payslipReference: "PS/3" },
    ];
    const backwards = [...forwards].reverse();
    expect(outstandingMinor(agreement.principalMinor, forwards)).toBe(
      outstandingMinor(agreement.principalMinor, backwards),
    );
  });

  it("reports an over-recovery rather than hiding it in a negative balance", () => {
    const over: readonly RecoveryLedgerEntry[] = [
      { period: "2026-04", amountMinor: "1000000", payslipReference: "PS/1" },
      { period: "2026-05", amountMinor: "50000", payslipReference: "PS/2" },
    ];
    const status = advanceStatus(agreement, over);
    expect(status.outstandingMinor).toBe(0n);
    // 🔴 The ₹500 taken beyond the principal is a refundable fact, not a
    // rounding artefact to be swallowed.
    expect(status.overRecoveredMinor).toBe(50000n);
  });

  it("computes the maximum outstanding balance Rule 3(7)(i) needs, and refuses to value the perquisite", () => {
    const ledger: readonly RecoveryLedgerEntry[] = [
      { period: "2026-05", amountMinor: "250000", payslipReference: "PS/2" },
      { period: "2026-04", amountMinor: "250000", payslipReference: "PS/1" },
    ];
    const status = advanceStatus(agreement, ledger);
    expect(status.maximumOutstandingMinor).toBe(1000000n);
    // ⚠️ THE STATED GAP IS A VALUE, not a silent zero.
    expect(status.perquisiteValuation).toBe("not_computed");
  });

  it("names the write-off as a taxable benefit it has not valued", () => {
    const status = advanceStatus(agreement, [], "400000");
    expect(status.outstandingMinor).toBe(600000n);
    expect(status.notes.some((n) => n.includes("WRITTEN OFF"))).toBe(true);
  });
});

/* ================================================================== */
/* ③ THE s.7(3) CAP — REFUSES, AND THE SCHEDULE EXTENDS                */
/* ================================================================== */

describe("recovery against the section 7(3) cap", () => {
  const agreement = agreementFor("1000000", 4);
  const schedule = buildInstalmentSchedule(agreement);

  const pfAndTax: readonly Recovery[] = [
    {
      kind: "provident_fund",
      description: "Employee PF",
      amountMinor: "180000",
      reference: "ECR 2026-04",
    },
    { kind: "income_tax", description: "TDS u/s 192", amountMinor: "120000", reference: "Q1" },
  ];

  it("recovers the whole instalment when it fits under the cap", () => {
    const first = schedule.instalments[0];
    expect(first).toBeDefined();
    const decision = decidePeriodRecovery({
      period: "2026-04",
      wagesForPeriodMinor: "5000000", // ₹50,000
      otherDeductions: pfAndTax,
      instalment: first!,
      kind: agreement.kind,
      agreementReference: agreement.agreementReference,
      outstandingMinor: 1000000n,
    });
    expect(decision.refused).toBe(false);
    expect(decision.recoverMinor).toBe(first!.amountMinor);
  });

  /**
   * 🔴🔴 THE LOAD-BEARING ONE. Asserted on BEHAVIOUR: nothing recovered,
   * and specifically NOT the headroom, which is what a clamp would give.
   */
  it("REFUSES rather than clamping to the headroom", () => {
    const first = schedule.instalments[0];
    expect(first).toBeDefined();
    const decision = decidePeriodRecovery({
      period: "2026-04",
      // ⚠️ Wages small enough that PF and TDS alone eat most of the cap.
      wagesForPeriodMinor: "620000",
      otherDeductions: pfAndTax,
      instalment: first!,
      kind: agreement.kind,
      agreementReference: agreement.agreementReference,
      outstandingMinor: 1000000n,
    });

    expect(decision.headroomMinor).toBeLessThan(decision.instalmentDueMinor);
    expect(decision.refused).toBe(true);
    // 🔴 ZERO. Not the headroom, which is what a silent clamp produces.
    expect(decision.recoverMinor).toBe(0n);
    expect(decision.recoverMinor).not.toBe(decision.headroomMinor);
    expect(decision.problems.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE SCHEDULE EXTENDS AND THE INSTALMENT DOES NOT SHRINK.
   * Asserted as three relations between the schedule before and after,
   * so nothing about the arithmetic can make it pass.
   */
  it("extends the schedule instead of shrinking the deduction", () => {
    const before = schedule.instalments;
    const after = deferInstalment(before, 1);

    // The money is untouched.
    expect(sumOf(after)).toBe(sumOf(before));
    expect(sumOf(after)).toBe(BigInt(agreement.principalMinor));
    // The same number of instalments, each the same amount.
    expect(after).toHaveLength(before.length);
    for (const b of before) {
      const a = after.find((x) => x.seq === b.seq);
      expect(a?.amountMinor).toBe(b.amountMinor);
    }
    // ⭐ And it now runs one wage period longer.
    const tailBefore = before.reduce((t, i) => (i.period > t ? i.period : t), "0000-00");
    const tailAfter = after.reduce((t, i) => (i.period > t ? i.period : t), "0000-00");
    expect(tailAfter > tailBefore).toBe(true);
    expect(tailAfter).toBe(addMonths(tailBefore, 1));
  });

  /**
   * ⭐⭐ THE CAP IS THE SETTLEMENT'S CAP, NOT A SECOND ONE.
   *
   * ⚠️ Asserted THROUGH the advances engine against the settlement's own
   * exported constant and helper. A duplicate cap in advances.ts would
   * have to be kept in step with this by hand, and the first correction
   * to either would break it — which is the whole point.
   */
  it("uses the settlement's cap, including the co-operative society limb", () => {
    const first = schedule.instalments[0];
    expect(first).toBeDefined();

    // ⚠️ Wages chosen so the instalment is REFUSED under the fifty per
    // cent limb and PERMITTED under the seventy-five per cent one. The
    // pair is the assertion: the same facts, one rupee apart, and the
    // answer changes because the proviso says it must.
    const plain = decidePeriodRecovery({
      period: "2026-04",
      wagesForPeriodMinor: "800000",
      otherDeductions: pfAndTax,
      instalment: first!,
      kind: agreement.kind,
      agreementReference: agreement.agreementReference,
      outstandingMinor: 1000000n,
    });
    expect(plain.capBp).toBe(DEDUCTION_CAP_BP);
    expect(plain.refused).toBe(true);
    expect(plain.maximumLawfulDeductionMinor).toBe(
      maximumLawfulDeductionMinor(800000n, DEDUCTION_CAP_BP),
    );

    // ⚠️ ONE RUPEE of co-operative society dues lifts the cap on the
    // WHOLE set — s.7(3) proviso, "wholly or partly".
    const withCoop = decidePeriodRecovery({
      period: "2026-04",
      wagesForPeriodMinor: "800000",
      otherDeductions: [
        ...pfAndTax,
        {
          kind: "co_operative_society",
          description: "Society subscription",
          amountMinor: "100",
          reference: "Soc/12",
        },
      ],
      instalment: first!,
      kind: agreement.kind,
      agreementReference: agreement.agreementReference,
      outstandingMinor: 1000000n,
    });
    expect(withCoop.capBp).toBe(DEDUCTION_CAP_BP_WITH_CO_OPERATIVE);
    expect(withCoop.maximumLawfulDeductionMinor).toBeGreaterThan(
      plain.maximumLawfulDeductionMinor,
    );
    // ⭐ And with the cap lifted, the instalment that was refused fits.
    expect(withCoop.refused).toBe(false);
  });

  it("recovers under a head section 7(2) actually enumerates", () => {
    for (const kind of ["salary_advance", "welfare_loan", "house_building_loan"] as const) {
      const head = RECOVERY_HEAD_BY_KIND[ADVANCE_RECOVERY_KIND[kind]];
      expect(head).toBeDefined();
      // 🔴 Not "unsettled". An advance IS on the list — s.7(2)(f), and
      // a welfare or housing loan at s.7(2)(fff)/(ffff).
      expect(head?.statutoryBasis).toBe("authorised");
    }
  });

  it("never recovers more than the ledger says is outstanding", () => {
    const last = schedule.instalments[3];
    expect(last).toBeDefined();
    const decision = decidePeriodRecovery({
      period: "2026-07",
      wagesForPeriodMinor: "5000000",
      otherDeductions: [],
      instalment: last!,
      kind: agreement.kind,
      agreementReference: agreement.agreementReference,
      // The ledger says only ₹100 is left, whatever the schedule says.
      outstandingMinor: 10000n,
    });
    expect(decision.recoverMinor).toBe(10000n);
    expect(decision.recoverMinor).toBeLessThan(last!.amountMinor);
  });
});

/* ================================================================== */
/* ④ EVIDENCE DECIDES THE TAX                                          */
/* ================================================================== */

describe("reimbursement against evidence", () => {
  const bill: EvidenceDocument = {
    kind: "bill",
    reference: "INV-4471",
    documentDate: "2026-04-12",
    amountMinor: "400000",
  };

  const base: ReimbursementClaim = {
    category: "travel",
    description: "Flight, Bengaluru to Delhi, client review",
    claimedMinor: "400000",
    incurredOn: "2026-04-11",
    evidence: [bill],
    incurredForEmployer: true,
    recoveredElsewhereMinor: null,
  };

  /**
   * 🔴🔴 THE LOAD-BEARING ONE. Two claims that differ ONLY in the
   * document. Nothing about wording, ordering or defaults can make this
   * pass by accident.
   */
  it("treats an identical claim as NOT wages with a bill and as TAXABLE without one", () => {
    const evidenced = assessReimbursement(base, EVIDENCE_POLICY_DEFAULT);
    const bare = assessReimbursement({ ...base, evidence: [] }, EVIDENCE_POLICY_DEFAULT);

    expect(evidenced.notWagesMinor).toBe(400000n);
    expect(evidenced.taxableAllowanceMinor).toBe(0n);
    expect(evidenced.incomeTaxTreatment).toBe("not_income");

    // ⭐ THE WHOLE FEATURE, IN ONE PAIR OF ASSERTIONS.
    expect(bare.notWagesMinor).toBe(0n);
    expect(bare.taxableAllowanceMinor).toBe(400000n);
    expect(bare.incomeTaxTreatment).toBe("taxable_as_salary");

    // ⚠️ And the employee is paid the same amount either way. The claim
    // is RECLASSIFIED, not refused.
    expect(bare.notWagesMinor + bare.taxableAllowanceMinor).toBe(
      evidenced.notWagesMinor + evidenced.taxableAllowanceMinor,
    );
  });

  it("does not let a self-declaration buy the exemption by default", () => {
    const declared = assessReimbursement(
      {
        ...base,
        evidence: [
          { kind: "self_declaration", reference: "decl-1", documentDate: "2026-04-12", amountMinor: "400000" },
        ],
      },
      EVIDENCE_POLICY_DEFAULT,
    );
    // 🔴 The employee asserting the expenditure is not evidence of it.
    expect(declared.taxableAllowanceMinor).toBe(400000n);

    // ⭐ But an establishment whose auditor accepts them may say so, and
    // then the SAME claim is evidenced. Configuration, not a silent flip.
    const accepted = assessReimbursement(
      {
        ...base,
        evidence: [
          { kind: "self_declaration", reference: "decl-1", documentDate: "2026-04-12", amountMinor: "400000" },
        ],
      },
      { ...EVIDENCE_POLICY_DEFAULT, acceptSelfDeclaration: true },
    );
    expect(accepted.notWagesMinor).toBe(400000n);
  });

  it("splits a partly-evidenced claim rather than exempting all of it", () => {
    const partial = assessReimbursement(
      { ...base, claimedMinor: "600000" },
      EVIDENCE_POLICY_DEFAULT,
    );
    expect(partial.notWagesMinor).toBe(400000n);
    expect(partial.taxableAllowanceMinor).toBe(200000n);
    expect(partial.treatment).toBe("part_reimbursement_part_allowance");
    // The split is the claim. Nothing is lost and nothing is invented.
    expect(partial.notWagesMinor + partial.taxableAllowanceMinor).toBe(600000n);
  });

  it("does not let a bill larger than the claim carry forward", () => {
    const big = assessReimbursement(
      { ...base, claimedMinor: "300000" },
      EVIDENCE_POLICY_DEFAULT,
    );
    expect(big.evidencedMinor).toBe(300000n);
    expect(big.notWagesMinor).toBe(300000n);
  });

  it("taxes a fully-billed expense that was not incurred for the employer", () => {
    // 🔴 No document can satisfy the duty test — s.10(14)(i).
    const personal = assessReimbursement(
      { ...base, incurredForEmployer: false },
      EVIDENCE_POLICY_DEFAULT,
    );
    expect(personal.notWagesMinor).toBe(0n);
    expect(personal.taxableAllowanceMinor).toBe(400000n);
  });

  it("treats a cost already recovered elsewhere as unevidenced", () => {
    const double = assessReimbursement(
      { ...base, recoveredElsewhereMinor: "400000" },
      EVIDENCE_POLICY_DEFAULT,
    );
    expect(double.taxableAllowanceMinor).toBe(400000n);
  });

  it("refuses to decide PF and ESI on the allowance portion, and says so", () => {
    const bare = assessReimbursement({ ...base, evidence: [] }, EVIDENCE_POLICY_DEFAULT);
    // ⚠️ A STATED GAP, in the type, so a caller must handle it.
    expect(bare.pfOnAllowance).toBe("notDecided");
    expect(bare.esiOnAllowance).toBe("notDecided");

    // ⭐ And on a genuine reimbursement there is nothing to decide.
    const evidenced = assessReimbursement(base, EVIDENCE_POLICY_DEFAULT);
    expect(evidenced.pfOnAllowance).toBe("no");
  });

  it("ignores a document dated before the expense it is offered for", () => {
    const backdated = assessReimbursement(
      {
        ...base,
        evidence: [{ ...bill, documentDate: "2026-03-01" }],
      },
      EVIDENCE_POLICY_DEFAULT,
    );
    expect(backdated.taxableAllowanceMinor).toBe(400000n);
  });
});

/* ================================================================== */
/* ⑤ PERIOD ARITHMETIC — PURE, AND ACROSS A YEAR BOUNDARY              */
/* ================================================================== */

describe("wage period arithmetic", () => {
  it("rolls across the year end without a clock", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });

  it("keeps the maximum outstanding right when the ledger arrives out of order", () => {
    const scrambled: readonly RecoveryLedgerEntry[] = [
      { period: "2026-06", amountMinor: "100000", payslipReference: "c" },
      { period: "2026-04", amountMinor: "100000", payslipReference: "a" },
      { period: "2026-05", amountMinor: "100000", payslipReference: "b" },
    ];
    expect(maximumOutstandingMinor("1000000", scrambled)).toBe(1000000n);
  });
});
