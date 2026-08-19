/**
 * Ordence — ⭐⭐⭐ BATCH 0102: RECONCILING, AS OPPOSED TO MATCHING
 * Version: v1.63.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THESE TESTS ARE FOR
 * ══════════════════════════════════════════════════════════════════════
 * 0070 shipped statement import and manual matching. It did not ship the
 * reconciliation: no statement an auditor could read, no event saying
 * "reconciled to this figure as at this date", and — the expensive one —
 * a `bank_accounts.reconciled_to` column that was written by nothing and
 * read by nothing. This product has shipped seven such fields. A lock of
 * that kind is worse than no lock, because it looks like control.
 *
 * ⚠️ SO THE CENTRE OF THIS FILE IS SECTION ④: WITH THE LOCK SET, THE
 * WRITE PATH MUST ACTUALLY REFUSE. Everything else is arithmetic.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ PROPERTIES, NEVER SHAPES
 * ══════════════════════════════════════════════════════════════════════
 * Nothing here pins a count, an id or a message. `expect(list.size)
 * .toBe(71)` has failed four correct changes in this repository. What is
 * asserted is what must be true of every reconciliation for ever:
 *
 *   • the printed statement always foots, exactly, in minor units
 *   • a machine proposal is never a confirmed match
 *   • the same file imported twice adds nothing
 *   • a locked date refuses the write
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBrs,
  categoryFor,
  isLockedByReconciliation,
  printableBrs,
  RECONCILIATION_CATEGORIES,
  CATEGORY_META,
  type BrsInput,
} from "@/lib/banking/reconciliation";
import { statementDigest } from "@/lib/banking/statement-digest";
import { fingerprintOf, findDuplicates, proposalsFor } from "@/lib/banking/match";
import type { LedgerCandidate, StatementLine } from "@/lib/banking/match";
import { buildBankAdjustmentPosting } from "@/lib/accounting/sales-posting";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are stripped so that a rule described in prose never counts. */
const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const ACTION = read("server/actions/banking.ts");
const SERVICE = read("server/banking/reconciliation-service.ts");
const SQL = read("SQL-FILES/0102_bank_reconciliation_statement_and_lock.sql");

/**
 * ⚠️ SQL COMMENTS ARE STRIPPED BEFORE ANY STRUCTURAL ASSERTION. This file
 * explains itself at length, and a rule described in a comment must never
 * satisfy a test that the statements are supposed to satisfy.
 */
const sqlCodeOnly = (s: string) =>
  s
    .split("\n")
    .map((l) => (l.trimStart().startsWith("--") ? "" : l))
    .join("\n");

const SQL_CODE = sqlCodeOnly(SQL);

/* ------------------------------------------------------------------ */
/* FIXTURES                                                            */
/* ------------------------------------------------------------------ */

function bankLine(
  id: string,
  valueDate: string,
  amountMinor: bigint,
  narration = "SOME NARRATION",
): StatementLine {
  return { id, valueDate, amountMinor, narration, bankReference: null };
}

function bookItem(
  id: string,
  occurredOn: string,
  amountMinor: bigint,
): LedgerCandidate {
  return {
    id,
    kind: amountMinor > 0n ? "customer_receipt" : "vendor_payment",
    occurredOn,
    amountMinor,
    reference: null,
    counterpartyName: null,
    documentNo: `DOC-${id}`,
  };
}

/* ================================================================== */
/* ① THE STATEMENT ALWAYS FOOTS — THE ONE INVARIANT                    */
/* ================================================================== */

describe("the bank reconciliation statement", () => {
  /**
   * 🔴 bank − cheques + deposits + charges − credits + difference = book,
   * EXACTLY, in minor units, for every input including nonsensical ones.
   *
   * ⚠️ THIS IS THE PROPERTY, NOT A NUMBER. A BRS that reaches the book
   * balance by quietly dropping the bit it could not explain is the exact
   * artefact the module exists to prevent, and it would still pass a test
   * that only checked a worked example.
   */
  const cases: BrsInput[] = [
    {
      bankBalanceMinor: 1_245_000_00n,
      bookBalanceMinor: 1_198_680_00n,
      unmatchedInBank: [
        bankLine("b1", "2026-03-31", -1_180_00n, "CHARGES"),
        bankLine("b2", "2026-03-30", 2_500_00n, "INT CR"),
      ],
      unmatchedInLedger: [
        bookItem("l1", "2026-03-28", -85_000_00n),
        bookItem("l2", "2026-03-29", 40_000_00n),
      ],
      partlyExplained: [],
      toleranceMinor: 0n,
    },
    // Nothing outstanding at all.
    {
      bankBalanceMinor: 500_00n,
      bookBalanceMinor: 500_00n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      partlyExplained: [],
      toleranceMinor: 0n,
    },
    // An overdrawn account: every balance negative.
    {
      bankBalanceMinor: -750_000_00n,
      bookBalanceMinor: -812_345_67n,
      unmatchedInBank: [bankLine("b1", "2026-01-05", -99_99n)],
      unmatchedInLedger: [bookItem("l1", "2026-01-04", -12_345_68n)],
      partlyExplained: [],
      toleranceMinor: 0n,
    },
    // A large, deliberately unexplained residue.
    {
      bankBalanceMinor: 1n,
      bookBalanceMinor: 999_999_999n,
      unmatchedInBank: [bankLine("b1", "2026-06-01", 7n)],
      unmatchedInLedger: [],
      partlyExplained: [],
      toleranceMinor: 0n,
    },
  ];

  it.each(cases.map((c, i) => [i, c] as const))(
    "foots exactly for case %i",
    (_i, input) => {
      const brs = buildBrs(input);
      const rebuilt =
        brs.bankBalanceMinor -
        brs.totals.chequesNotPresentedMinor +
        brs.totals.depositsNotCreditedMinor +
        brs.totals.bankChargesMinor -
        brs.totals.directCreditsMinor +
        brs.differenceMinor;

      expect(rebuilt).toBe(brs.bookBalanceMinor);
    },
  );

  /**
   * ⭐ AND THE PRINTED FORM FOOTS TOO, from its own lines, in its own
   * order. The renderer must never be able to produce a statement that
   * reads differently from the one the engine computed.
   */
  it.each(cases.map((c, i) => [i, c] as const))(
    "prints lines that foot for case %i",
    (_i, input) => {
      const brs = buildBrs(input);
      const lines = printableBrs(brs);

      const opening = lines.filter((l) => l.effect === "opening");
      const total = lines.filter((l) => l.effect === "total");
      expect(opening).toHaveLength(1);
      expect(total).toHaveLength(1);

      let running = opening[0]!.amountMinor;
      for (const line of lines) {
        if (line.effect === "add") running += line.amountMinor;
        if (line.effect === "subtract") running -= line.amountMinor;
      }
      expect(running).toBe(total[0]!.amountMinor);
    },
  );

  /**
   * 🔴 A NON-ZERO RESIDUE IS A LINE ON THE STATEMENT, NOT A FOOTNOTE.
   * Omitting it would let the printed statement foot while hiding the one
   * figure that says the account does not.
   */
  it("prints the residue when there is one", () => {
    const brs = buildBrs({
      bankBalanceMinor: 100_00n,
      bookBalanceMinor: 150_00n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      partlyExplained: [],
      toleranceMinor: 0n,
    });
    expect(brs.differenceMinor).not.toBe(0n);
    expect(
      printableBrs(brs).some((l) => l.amountMinor === brs.differenceMinor),
    ).toBe(true);
  });
});

/* ================================================================== */
/* ② THE CATEGORIES ARE DERIVED, NEVER CHOSEN                          */
/* ================================================================== */

describe("categorisation", () => {
  it("is a total function of the side and the sign", () => {
    for (const side of ["bank", "books"] as const) {
      for (const amount of [-1n, -999_999n, 1n, 999_999n]) {
        const category = categoryFor(side, amount);
        expect(RECONCILIATION_CATEGORIES).toContain(category);
      }
    }
  });

  /**
   * ⚠️ THE DIRECTION OF EVERY CATEGORY IS DECLARED IN ONE PLACE AND THE
   * ARITHMETIC USES IT. A category whose `effect` disagreed with how
   * `buildBrs` treats it would produce a statement that is internally
   * consistent and points the wrong way — which foots, and is wrong.
   */
  it("moves the bank balance towards the books in the declared direction", () => {
    for (const category of RECONCILIATION_CATEGORIES) {
      const amount = 10_000n;
      const side = category.startsWith("cheque") || category.startsWith("deposit")
        ? ("books" as const)
        : ("bank" as const);
      const signed =
        CATEGORY_META[category].effect === "add" === (side === "books")
          ? amount
          : -amount;

      const item =
        side === "bank"
          ? { unmatchedInBank: [bankLine("x", "2026-01-01", signed)], unmatchedInLedger: [] }
          : { unmatchedInBank: [], unmatchedInLedger: [bookItem("x", "2026-01-01", signed)] };

      const brs = buildBrs({
        bankBalanceMinor: 0n,
        bookBalanceMinor: 0n,
        partlyExplained: [],
        toleranceMinor: 0n,
        ...item,
      });

      expect(brs.items[0]!.category).toBe(category);

      const moved = brs.derivedBookBalanceMinor;
      if (CATEGORY_META[category].effect === "add") {
        expect(moved).toBe(amount);
      } else {
        expect(moved).toBe(-amount);
      }
    }
  });
});

/* ================================================================== */
/* ③ THE TOLERANCE NEVER SWALLOWS ANYTHING                             */
/* ================================================================== */

describe("the rounding tolerance", () => {
  const withDifference = (toleranceMinor: bigint) =>
    buildBrs({
      bankBalanceMinor: 100_00n,
      bookBalanceMinor: 100_40n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      partlyExplained: [],
      toleranceMinor,
    });

  /**
   * 🔴 A RECONCILIATION THAT BALANCES BECAUSE OF A TOLERANCE IS A
   * RECONCILIATION THAT DOES NOT BALANCE. `reconcilesExactly` must never
   * consult the tolerance, at any value.
   */
  it("never turns a difference into a reconciliation", () => {
    for (const tolerance of [0n, 1n, 40n, 10_000n]) {
      const brs = withDifference(tolerance);
      expect(brs.differenceMinor).toBe(40n);
      expect(brs.reconcilesExactly).toBe(false);
    }
  });

  it("is read at the comparison rather than defaulted", () => {
    expect(withDifference(0n).signOffPermitted).toBe(false);
    expect(withDifference(39n).signOffPermitted).toBe(false);
    expect(withDifference(40n).signOffPermitted).toBe(true);
  });

  /**
   * ⭐ ANYTHING IT LETS THROUGH IS RECORDED AS A DIFFERENCE. Absorbing is
   * not forgetting.
   */
  it("records what it absorbs, and absorbs nothing it did not let through", () => {
    expect(withDifference(40n).differenceAbsorbedMinor).toBe(40n);
    // Beyond reach: nothing is signed, so nothing is absorbed.
    expect(withDifference(39n).differenceAbsorbedMinor).toBe(0n);
    // Nothing to absorb.
    const clean = buildBrs({
      bankBalanceMinor: 100_00n,
      bookBalanceMinor: 100_00n,
      unmatchedInBank: [],
      unmatchedInLedger: [],
      partlyExplained: [],
      toleranceMinor: 10_000n,
    });
    expect(clean.differenceAbsorbedMinor).toBe(0n);
    expect(clean.reconcilesExactly).toBe(true);
  });

  it("says so on the statement whenever it did any work", () => {
    const brs = withDifference(40n);
    expect(brs.notes.join(" ")).toMatch(/tolerance/i);
  });

  /** ⚠️ A negative tolerance is a data oddity, not a licence. */
  it("treats a negative tolerance as none", () => {
    expect(withDifference(-500n).signOffPermitted).toBe(false);
  });
});

/* ================================================================== */
/* ④ 🔴🔴🔴 THE LOCK IS READ, AND THE WRITE PATH REFUSES                */
/* ================================================================== */

describe("the reconciliation lock", () => {
  /**
   * ⭐ `<=`, NOT `<`. A lock excluding its own boundary date leaves the
   * last day of every reconciled month editable — the day the month-end
   * entries are on.
   */
  it("includes its own boundary date", () => {
    expect(isLockedByReconciliation("2026-03-31", "2026-03-31")).toBe(true);
    expect(isLockedByReconciliation("2026-03-30", "2026-03-31")).toBe(true);
    expect(isLockedByReconciliation("2026-04-01", "2026-03-31")).toBe(false);
  });

  it("locks nothing when nothing has been reconciled", () => {
    expect(isLockedByReconciliation("1999-01-01", null)).toBe(false);
  });

  /**
   * ══════════════════════════════════════════════════════════════════
   * 🔴🔴 THE TEST THAT WOULD HAVE CAUGHT "DECLARED AND ENFORCED BY
   *      NOTHING"
   * ══════════════════════════════════════════════════════════════════
   * Seven fields in this product have been stored and read by nothing.
   * `reconciled_to` existed for five versions, was rendered on screen,
   * and was consulted by no write path at all.
   *
   * ⚠️ SO THIS ASSERTS THE READ, NOT THE COLUMN. Every action that can
   * move a reconciled figure must consult the lock, and the refusal must
   * come BEFORE the write it guards.
   */
  const guarded = ["confirmMatch", "unmatch", "postBankLineAdjustment"] as const;

  it.each(guarded)("%s consults the lock", (name) => {
    const code = codeOnly(ACTION);
    const start = code.indexOf(`export async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, start + 4000);
    expect(body).toContain("lineLockState(");
    expect(body).toContain("state.locked");
    expect(body).toContain("reconciliationLockRefusal(");
  });

  it("refuses before it deletes, not after", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(code.indexOf("export async function unmatch("));
    const check = body.indexOf("state.locked");
    const del = body.indexOf(".delete(bankLineMatches)");
    expect(check).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(-1);
    expect(check).toBeLessThan(del);
  });

  it("refuses before it inserts a match, not after", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(code.indexOf("export async function confirmMatch("));
    const check = body.indexOf("state.locked");
    const ins = body.indexOf(".insert(bankLineMatches)");
    expect(check).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(-1);
    expect(check).toBeLessThan(ins);
  });

  /**
   * ⭐ THE IMPORTER IS A WRITE PATH TOO. A lock that guarded only
   * matching would have a hole the size of the importer: a line added
   * inside a signed period changes a statement signed without it.
   */
  it("is consulted by the importer", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(
      code.indexOf("export async function importStatement("),
      code.indexOf("export interface LineWithProposal"),
    );
    expect(body).toContain("isLockedByReconciliation(");
    expect(body).toContain("bankAccounts.reconciledTo");
  });

  /**
   * 🔴 AND THE DATABASE HALF. The application produces a sentence; the
   * trigger makes the rule true for the import, the support fix and the
   * API route nobody has written yet. Same doctrine as 0073.
   */
  it("is enforced below the application, on every operation", () => {
    expect(SQL).toContain("ordence_guard_reconciled_bank_line");
    expect(SQL).toMatch(
      /BEFORE INSERT OR UPDATE OR DELETE ON public\.bank_line_matches/,
    );
    // The guard reads the account's lock date rather than a constant.
    expect(SQL).toContain("a.reconciled_to IS NOT NULL");
    expect(SQL).toContain("l.value_date <= a.reconciled_to");
  });

  /**
   * ⚠️ THE CASCADE ESCAPE HATCH IS THE SHAPE OF THE QUERY, NOT AN
   * EXCEPTION LIST. If the guard ever gained a `WHEN` clause or a
   * platform-scope bypass, deleting a tenant would start failing or the
   * lock would stop applying to the one role that can reach everything.
   */
  it("looks the lock up through the line and the account", () => {
    const fn = SQL.slice(
      SQL.indexOf("CREATE OR REPLACE FUNCTION ordence_guard_reconciled_bank_line"),
      SQL.indexOf("DROP TRIGGER IF EXISTS ordence_guard_reconciled_bank_line"),
    );
    expect(fn).toContain("FROM bank_statement_lines l");
    expect(fn).toContain("JOIN bank_accounts        a ON a.id = l.bank_account_id");
    expect(fn).not.toContain("app_platform_scope");
  });

  /** ⭐ Sign-off writes the lock. Without this the artefact is a screenshot. */
  it("is written by signing off, in the same transaction as the artefact", () => {
    const code = codeOnly(SERVICE);
    const body = code.slice(code.indexOf("export async function freezeReconciliation("));
    expect(body).toContain(".insert(bankReconciliations)");
    expect(body).toContain(".update(bankAccounts)");
    expect(body).toContain("reconciledTo: args.reconciledTo");
  });

  /** ⚠️ And moving it BACKWARDS needs a reason and keeps the row. */
  it("is only moved backwards by a reopen that records why", () => {
    const code = codeOnly(SERVICE);
    const body = code.slice(code.indexOf("export async function reopenReconciliation("));
    expect(body).toContain('status: "reopened"');
    expect(body).toContain("reopenReason: args.reason");
    expect(body).toContain("reconciledTo: restoredTo");
    // The evidence is kept, never deleted.
    expect(body).not.toContain("delete(bankReconciliations)");
  });
});

/* ================================================================== */
/* ⑤ THE SAME FILE IMPORTED TWICE ADDS NOTHING                         */
/* ================================================================== */

describe("duplicate import", () => {
  const file = {
    bankAccountId: "11111111-1111-1111-1111-111111111111",
    periodFrom: "2026-04-01",
    periodTo: "2026-04-30",
    openingBalanceMinor: 100_000_00n,
    closingBalanceMinor: 118_000_00n,
    lines: [
      { valueDate: "2026-04-02", amountMinor: -45_000_00n, narration: "NEFT DR RAMESH" },
      { valueDate: "2026-04-03", amountMinor: 63_000_00n, narration: "UPI  CR   ANITA " },
    ],
  };

  it("produces the same digest for the same file", () => {
    expect(statementDigest(file)).toBe(statementDigest(structuredClone(file)));
  });

  /**
   * ⚠️ EVERY FIELD PARTICIPATES. A digest that ignored one of them would
   * refuse a legitimate import, and a duplicate guard that refuses real
   * work is a guard somebody switches off.
   */
  it("differs when anything about the statement differs", () => {
    const base = statementDigest(file);
    expect(statementDigest({ ...file, periodTo: "2026-05-31" })).not.toBe(base);
    expect(statementDigest({ ...file, closingBalanceMinor: 118_000_01n })).not.toBe(base);
    expect(
      statementDigest({
        ...file,
        bankAccountId: "22222222-2222-2222-2222-222222222222",
      }),
    ).not.toBe(base);
    expect(
      statementDigest({
        ...file,
        lines: [file.lines[1]!, file.lines[0]!],
      }),
    ).not.toBe(base);
    expect(
      statementDigest({
        ...file,
        lines: [...file.lines, { valueDate: "2026-04-04", amountMinor: 1n, narration: "X" }],
      }),
    ).not.toBe(base);
  });

  /** ⭐ Cosmetic differences a bank makes between exports do not. */
  it("survives whitespace and case, which is what fingerprintOf is for", () => {
    const messy = {
      ...file,
      lines: file.lines.map((l) => ({
        ...l,
        narration: `  ${l.narration.toUpperCase().replace(/ +/g, "   ")} `,
      })),
    };
    expect(statementDigest(messy)).toBe(statementDigest(file));
  });

  it("is checked by the importer before anything is written", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(
      code.indexOf("export async function importStatement("),
      code.indexOf("export interface LineWithProposal"),
    );
    expect(body).toContain("statementDigest(");
    const check = body.indexOf("alreadyImported");
    const insert = body.indexOf(".insert(bankStatements)");
    expect(check).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(check).toBeLessThan(insert);
    expect(body).toContain("importDigest: digest");
  });

  /**
   * 🔴 AND THE LINE-LEVEL CHECK STILL ONLY WARNS. Two genuinely separate
   * identical payments on one day are real, and refusing them would be
   * wrong. The two guards are different strengths on purpose, and
   * hardening the line-level one would be a regression.
   */
  it("still reports rather than refuses at the line level", () => {
    const stored = file.lines.map(fingerprintOf);
    const flagged = findDuplicates(file.lines, stored);
    expect(flagged.length).toBeGreaterThan(0);
    expect(findDuplicates(file.lines, [])).toHaveLength(0);
  });
});

/* ================================================================== */
/* ⑥ A PROPOSAL IS NEVER A CONFIRMATION                                */
/* ================================================================== */

describe("the matcher", () => {
  /**
   * ⭐ ALREADY TRUE BEFORE THIS BATCH, AND ASSERTED SO IT STAYS TRUE.
   * `proposalsFor` and `scoreCandidate` were built in v1.18.0; this batch
   * did not rebuild them and must not have weakened them.
   */
  it("scores and ranks without ever deciding", () => {
    const line = bankLine("b", "2026-04-10", -50_000_00n, "NEFT DR 000123");
    const proposal = proposalsFor(line, [
      bookItem("a", "2026-04-09", -50_000_00n),
      bookItem("b", "2026-04-10", -50_000_00n),
    ]);
    expect(proposal.ranked.length).toBeGreaterThan(0);
    // Ambiguity is reported as ambiguity, not resolved by taking the first.
    expect(proposal.ambiguous).toBe(true);
    expect(proposal).not.toHaveProperty("confirmed");
  });

  it("never returns a match for a different amount", () => {
    const proposal = proposalsFor(bankLine("b", "2026-04-10", -50_000_00n), [
      bookItem("a", "2026-04-10", -49_999_99n),
    ]);
    expect(proposal.ranked).toHaveLength(0);
  });

  /**
   * 🔴 NOTHING AUTO-CONFIRMS, AT ANY SCORE. A confirmed match is a row a
   * person created, and the only writer of `bank_line_matches` outside
   * `confirmMatch` is the adjustment path — which writes the match for a
   * journal IT JUST POSTED, on a line the person chose.
   */
  it("has no auto-confirm path in the action module", () => {
    const code = codeOnly(ACTION);
    const inserts = [...code.matchAll(/\.insert\(bankLineMatches\)/g)];
    expect(inserts.length).toBeGreaterThan(0);
    for (const m of inserts) {
      /**
       * ⚠️ THE WINDOW IS THE `values({ ... })` OBJECT, NOT A FIXED NUMBER
       * OF CHARACTERS. This assertion read the next 800 characters until
       * 0110 added `allocated_minor` and its comment to the adjustment
       * path, at which point `confirmedBy` fell outside the window and a
       * correct change failed a correct test. That is the sixth time a
       * shape has failed a correct change in this codebase; the property
       * — every insert names the person who caused it — is unchanged.
       */
      const start = code.indexOf("{", code.indexOf(".values(", m.index!));
      let depth = 0;
      let end = start;
      while (end < code.length) {
        if (code[end] === "{") depth += 1;
        if (code[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        end += 1;
      }
      const values = code.slice(start, end + 1);
      // Every insert names the person who caused it.
      expect(values).toContain("confirmedBy: ctx.user.id");
    }
    expect(code).not.toMatch(/autoConfirm|confirmAll|matchAll\(/);
  });
});

/* ================================================================== */
/* ⑦ WHAT THE RECONCILIATION FINDS, IT CAN POST                        */
/* ================================================================== */

describe("posting a bank charge or interest", () => {
  it("builds balanced legs in both directions", () => {
    for (const kind of ["bank_charge", "interest_credited"] as const) {
      const legs = buildBankAdjustmentPosting({
        kind,
        amountMinor: 1_180_00n,
        narration: "SERVICE CHARGES",
      });
      const debit = legs
        .filter((l) => l.entryType === "debit")
        .reduce((s, l) => s + l.amountMinor, 0n);
      const credit = legs
        .filter((l) => l.entryType === "credit")
        .reduce((s, l) => s + l.amountMinor, 0n);
      expect(debit).toBe(credit);
      expect(debit).toBe(1_180_00n);
      // ⚠️ Direction lives in entryType. A negative leg is a bug.
      expect(legs.every((l) => l.amountMinor > 0n)).toBe(true);
    }
  });

  /**
   * ⭐ TWO ROLES, NOT ONE. Netting charges against interest makes both
   * invisible, and "what did this bank cost us this year" stops having an
   * answer.
   */
  it("keeps charges and interest in separate accounts", () => {
    const charge = buildBankAdjustmentPosting({
      kind: "bank_charge",
      amountMinor: 100n,
      narration: "x",
    });
    const interest = buildBankAdjustmentPosting({
      kind: "interest_credited",
      amountMinor: 100n,
      narration: "x",
    });
    const roles = (legs: ReturnType<typeof buildBankAdjustmentPosting>) =>
      legs.map((l) => l.role).filter((r) => r !== "bank");
    expect(roles(charge)).not.toEqual(roles(interest));
  });

  it("refuses an adjustment of nothing", () => {
    expect(() =>
      buildBankAdjustmentPosting({ kind: "bank_charge", amountMinor: 0n, narration: "x" }),
    ).toThrow();
  });

  /**
   * 🔴 IT GOES THROUGH THE ONE POSTING PATH. A second posting path in the
   * banking module would be a second place for the period lock to be
   * forgotten, which is how 0073 came to be written in the first place.
   */
  it("posts through server/accounting, not through a new path", () => {
    const code = codeOnly(ACTION);
    expect(code).toContain('from "@/server/accounting/post-sales"');
    expect(code).toContain("postBankAdjustment(");
    // Nothing in the banking action module writes a journal itself.
    expect(code).not.toContain("insert(journalEntries)");
    expect(code).not.toContain("insert(transactions)");
  });

  /**
   * ⚠️ THE BANK LEG IS THE ACCOUNT'S OWN LEDGER. A tenant with three bank
   * accounts has one `bank` role, and posting an HDFC charge to the ICICI
   * ledger leaves both accounts permanently unreconcilable.
   */
  it("pins the bank leg to the account's own ledger", () => {
    const code = codeOnly(read("server/accounting/post-sales.ts"));
    const body = code.slice(code.indexOf("export async function postBankAdjustment("));
    expect(body).toContain("ledgerOverrides: { bank: args.bankLedgerId }");
  });

  /** ⚠️ The bank's value date, never today. */
  it("dates the journal on the bank's value date", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(code.indexOf("export async function postBankLineAdjustment("));
    expect(body).toContain("valueDate: state.valueDate");
    expect(body).not.toContain("new Date().toISOString()");
  });
});

/* ================================================================== */
/* ⑧ THE ARTEFACT IS FROZEN, NOT RECOMPUTED                            */
/* ================================================================== */

describe("the signed reconciliation", () => {
  it("stores its items rather than re-deriving them", () => {
    const code = codeOnly(SERVICE);
    const body = code.slice(code.indexOf("export async function freezeReconciliation("));
    expect(body).toContain(".insert(bankReconciliationItems)");
    expect(body).toContain("brs.items.map(");
  });

  it("reads back from the frozen rows and computes nothing", () => {
    const code = codeOnly(ACTION);
    const body = code.slice(
      code.indexOf("export async function getSignedReconciliation("),
    );
    expect(body).toContain(".from(bankReconciliations)");
    expect(body).toContain(".from(bankReconciliationItems)");
    expect(body).not.toContain("buildBrs(");
    expect(body).not.toContain("buildReconciliationView(");
  });

  /**
   * 🔴 THE DATABASE REFUSES A CATEGORY THAT CONTRADICTS THE AMOUNT.
   * A statement whose lines are individually plausible and whose total is
   * wrong is the artefact this constraint exists to prevent.
   */
  it("has a constraint tying the category to the side and the sign", () => {
    expect(SQL).toContain("bank_reconciliation_items_category_matches_sign");
    for (const category of RECONCILIATION_CATEGORIES) {
      expect(SQL).toContain(category);
    }
  });

  /** ⚠️ And the tolerance cannot claim to have absorbed more than it is. */
  it("has a constraint capping what the tolerance absorbed", () => {
    expect(SQL).toContain("bank_reconciliations_absorbed_within_tolerance");
    expect(SQL).toContain("bank_reconciliations_absorbed_is_the_difference");
  });
});

/* ================================================================== */
/* ⑨ THE MIGRATION OBEYS THE CONSOLE RULES AND PROTECTS ITS TABLES      */
/* ================================================================== */

describe("0102", () => {
  /**
   * 🔴 A `BEGIN;` IN A PASTED FILE OPENS A TRANSACTION THE CONSOLE HOLDS.
   * One failing statement silently discards everything after it and the
   * final COMMIT rolls it all back with no visible error.
   */
  it("has no transaction control and no bare platform-scope statement", () => {
    expect(SQL).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(SQL).not.toMatch(/^\s*COMMIT\s*;/m);
    expect(SQL).not.toMatch(/^\s*SET LOCAL app\.platform_scope/m);
  });

  it("is independently idempotent", () => {
    for (const [pattern, guard] of [
      [/CREATE TABLE (?!IF NOT EXISTS)/, "CREATE TABLE IF NOT EXISTS"],
      [/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/, "CREATE INDEX IF NOT EXISTS"],
      [/ADD COLUMN (?!IF NOT EXISTS)/, "ADD COLUMN IF NOT EXISTS"],
    ] as const) {
      expect(SQL_CODE, `every statement must be re-runnable: ${guard}`).not.toMatch(
        pattern,
      );
    }
    // A policy is dropped before it is created; a trigger likewise.
    for (const m of SQL_CODE.matchAll(/CREATE POLICY (\w+)/g)) {
      expect(SQL_CODE).toContain(`DROP POLICY IF EXISTS ${m[1]}`);
    }
    for (const m of SQL_CODE.matchAll(/CREATE TRIGGER (\w+)/g)) {
      expect(SQL_CODE).toContain(`DROP TRIGGER IF EXISTS ${m[1]}`);
    }
  });

  /**
   * 🔴 RLS IS THE ONLY TENANT ISOLATION IN THIS PRODUCT, and FORCE
   * matters more than ENABLE: plain ENABLE does not apply to the table
   * owner, and this application connects as the owner.
   */
  it("enables, forces and grants a policy on every new tenant table", () => {
    for (const table of ["bank_reconciliations", "bank_reconciliation_items"]) {
      expect(SQL_CODE).toMatch(
        new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`),
      );
      expect(SQL_CODE).toMatch(
        new RegExp(`ALTER TABLE public\\.${table}\\s+FORCE\\s+ROW LEVEL SECURITY`),
      );
      expect(SQL_CODE).toMatch(new RegExp(`CREATE POLICY \\w+ ON public\\.${table}`));

      // ⭐ AND THE COLUMN THE POLICY DEPENDS ON, cascading from tenants.
      const body = SQL_CODE.slice(
        SQL_CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`),
      ).slice(0, 4000);
      expect(body).toMatch(
        /tenant_id\s+uuid\s+NOT NULL REFERENCES public\.tenants\(id\)\s+ON DELETE CASCADE/,
      );
    }
  });

  /**
   * ⚠️ `app_platform_scope()` BELONGS IN `USING` AND NEVER IN
   * `WITH CHECK`. Support may read a tenant's reconciliation; support
   * signing one is a different thing, one keyword apart.
   */
  it("never lets platform scope write into a tenant", () => {
    for (const m of SQL_CODE.matchAll(/WITH CHECK \(([^)]*)\)/g)) {
      expect(m[1]).not.toContain("app_platform_scope");
    }
  });

  /** ⭐ Money is bigint paise. Never numeric, never a float, in a new table. */
  it("uses bigint minor units for every money column it creates", () => {
    const tables = SQL_CODE.slice(
      SQL_CODE.indexOf("CREATE TABLE IF NOT EXISTS public.bank_reconciliations"),
    );
    for (const m of tables.matchAll(/^\s+(\w*minor)\s+(\w+)/gm)) {
      expect(m[2]).toBe("bigint");
    }
    expect(tables).not.toMatch(/numeric\(\d+,\s*2\)/);
    expect(tables).not.toContain("double precision");
  });
});
