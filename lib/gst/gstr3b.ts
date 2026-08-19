/**
 * Ordence — ⭐⭐⭐ GSTR-3B AND THE SET-OFF
 * Version: v1.24.0-alpha · Batch 16
 *
 * Pure. No database, no network, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 GSTR-1 IS A STATEMENT. GSTR-3B IS THE ONE YOU PAY FROM.
 * ══════════════════════════════════════════════════════════════════════
 * Ordence has built GSTR-1 since v0.9x. It lists outward supplies and it
 * settles nothing. The 3B is the monthly summary where output tax meets
 * input credit and whatever is left has to leave a bank account by the
 * twentieth.
 *
 * ⚠️ SO THIS FILE IS ABOUT ONE CALCULATION AND IT HAS AN EXACT RIGHT
 * ANSWER: given a liability and a set of credits, how much credit may be
 * used against what, and how much cash is therefore due.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 THE RULE EVERYBODY GETS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * **CGST CREDIT MAY NEVER BE SET OFF AGAINST SGST, AND SGST CREDIT MAY
 * NEVER BE SET OFF AGAINST CGST.** Not in any order, not as a last
 * resort, not ever. They are different governments.
 *
 * ⚠️ A set-off routine that treats the four credit pools as
 * interchangeable produces a smaller, entirely plausible cash figure —
 * and the department's own computation disagrees, which surfaces as a
 * demand with interest months later.
 *
 * The order that IS permitted (section 49 and rule 88A):
 *
 *   ① IGST credit is used FIRST and must be exhausted against IGST,
 *     CGST and SGST before any CGST or SGST credit is touched at all
 *     (section 49A).
 *   ② Whatever IGST credit remains after IGST may go against CGST and
 *     SGST **in any order**, and that freedom is worth real money — see
 *     the next block.
 *   ③ CGST credit → CGST liability, then IGST liability.
 *   ④ SGST credit → SGST liability, then IGST liability.
 *   ⑤ Cess credit → cess liability only.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE FREE CHOICE IN ② IS NOT FREE OF CONSEQUENCE
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A NAIVE IMPLEMENTATION SPENDS THE IGST BALANCE ON CGST FIRST AND
 * THEN ON SGST, AND IT LEAVES MONEY ON THE TABLE. I wrote that version
 * first, and a worked example in the tests caught it.
 *
 * ⚠️ THE EXAMPLE: liability ₹90,000 CGST and ₹90,000 SGST, credit
 * ₹20,000 IGST, ₹80,000 CGST and ₹80,000 SGST. Spending the IGST on
 * CGST first clears CGST entirely, leaves ₹10,000 of CGST credit
 * stranded, and pays ₹10,000 of SGST **in cash** — while the stranded
 * credit sits there unusable, because CGST credit can never cross to
 * SGST. Splitting the same ₹20,000 across both heads pays nothing at
 * all.
 *
 * ⭐ SO THE REMAINING IGST IS ALLOCATED AGAINST THE SHORTFALL EACH HEAD
 * WOULD STILL HAVE AFTER ITS OWN CREDIT — proportionally, so neither is
 * favoured. It is legal (any order is permitted), it is never worse, and
 * on the shape above it is ₹10,000 of cash a month better.
 *
 * 🔴 AND NOTHING SET OFF HERE IS ALLOWED TO GO NEGATIVE. A pool that
 * over-spends produces a credit balance that does not exist, which is
 * the arithmetic version of claiming money you were never given.
 */

export type Head = "igst" | "cgst" | "sgst" | "cess";

export interface HeadAmounts {
  readonly igst: bigint;
  readonly cgst: bigint;
  readonly sgst: bigint;
  readonly cess: bigint;
}

export const ZERO_HEADS: HeadAmounts = Object.freeze({
  igst: 0n,
  cgst: 0n,
  sgst: 0n,
  cess: 0n,
});

export function addHeads(a: HeadAmounts, b: HeadAmounts): HeadAmounts {
  return {
    igst: a.igst + b.igst,
    cgst: a.cgst + b.cgst,
    sgst: a.sgst + b.sgst,
    cess: a.cess + b.cess,
  };
}

export function totalOf(h: HeadAmounts): bigint {
  return h.igst + h.cgst + h.sgst + h.cess;
}

/* ------------------------------------------------------------------ */
/* THE SET-OFF                                                         */
/* ------------------------------------------------------------------ */

/** One movement of credit, recorded so the working can be printed. */
export interface SetoffMove {
  readonly creditHead: Head;
  readonly liabilityHead: Head;
  readonly amountMinor: bigint;
  /** ⭐ Why this move was permitted, in words, for the screen. */
  readonly rule: string;
}

export interface SetoffResult {
  readonly moves: readonly SetoffMove[];
  /** Credit used, by the pool it came from. */
  readonly creditUsed: HeadAmounts;
  /** Liability discharged by credit, by head. */
  readonly liabilityCleared: HeadAmounts;
  /** 🔴 What has to leave a bank account. */
  readonly cashPayable: HeadAmounts;
  /** Credit left over, carried to next month. */
  readonly creditCarried: HeadAmounts;
  readonly notes: readonly string[];
  /** Non-empty means the figures cannot be filed as they stand. */
  readonly problems: readonly string[];
}

/**
 * ⭐⭐ THE ORDER IS DATA, NOT CONTROL FLOW.
 *
 * ⚠️ WRITTEN AS A LIST SO IT CAN BE READ AGAINST THE SECTION. A set-off
 * expressed as nested conditionals is one somebody has to simulate in
 * their head to check, and the thing being checked is a legal rule.
 *
 * 🔴 NOTICE WHAT IS ABSENT: there is no (cgst → sgst) and no
 * (sgst → cgst) entry, and there never may be.
 */
const SETOFF_ORDER: readonly {
  credit: Head;
  liability: Head;
  rule: string;
}[] = Object.freeze([
  // ③ CGST credit: its own head first, then IGST. Never SGST.
  {
    credit: "cgst",
    liability: "cgst",
    rule: "CGST credit against CGST liability.",
  },
  {
    credit: "cgst",
    liability: "igst",
    rule: "CGST credit may be used against IGST once CGST liability is cleared.",
  },
  // ④ SGST credit: its own head first, then IGST. Never CGST.
  {
    credit: "sgst",
    liability: "sgst",
    rule: "SGST credit against SGST liability.",
  },
  {
    credit: "sgst",
    liability: "igst",
    rule: "SGST credit may be used against IGST once SGST liability is cleared.",
  },
  // ⑤ Cess is a closed loop.
  {
    credit: "cess",
    liability: "cess",
    rule: "Compensation cess credit may only be used against cess.",
  },
]);

function minOf(a: bigint, b: bigint): bigint {
  const low = a < b ? a : b;
  return low > 0n ? low : 0n;
}

function positive(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function computeSetoff(args: {
  readonly liability: HeadAmounts;
  /** This month's eligible credit plus anything carried forward. */
  readonly credit: HeadAmounts;
}): SetoffResult {
  const problems: string[] = [];
  const notes: string[] = [];

  for (const head of ["igst", "cgst", "sgst", "cess"] as const) {
    if (args.liability[head] < 0n) {
      problems.push(
        `The ${head.toUpperCase()} liability is negative, which cannot be filed. A credit note larger than the month's sales is carried forward, not shown as negative output tax.`,
      );
    }
    if (args.credit[head] < 0n) {
      problems.push(`The ${head.toUpperCase()} credit is negative, which is not a state a ledger can be in.`);
    }
  }

  const remainingLiability: Record<Head, bigint> = {
    igst: args.liability.igst,
    cgst: args.liability.cgst,
    sgst: args.liability.sgst,
    cess: args.liability.cess,
  };
  const remainingCredit: Record<Head, bigint> = {
    igst: args.credit.igst,
    cgst: args.credit.cgst,
    sgst: args.credit.sgst,
    cess: args.credit.cess,
  };

  const moves: SetoffMove[] = [];

  const spend = (credit: Head, liability: Head, amount: bigint, rule: string) => {
    if (amount <= 0n) return;
    remainingCredit[credit] -= amount;
    remainingLiability[liability] -= amount;
    moves.push({ creditHead: credit, liabilityHead: liability, amountMinor: amount, rule });
  };

  /* ---- ① IGST credit against IGST liability, compulsorily first ---- */
  spend(
    "igst",
    "igst",
    minOf(remainingCredit.igst, remainingLiability.igst),
    "IGST credit must be used against IGST liability before anything else, under rule 88A.",
  );

  /* ---- ② THE BALANCED SPLIT. See the header for why. -------------- */
  //
  // ⚠️ THE SHORTFALL IS WHAT EACH HEAD WOULD STILL OWE AFTER ITS OWN
  // CREDIT. Allocating against the raw liability instead would send IGST
  // credit to a head that could have paid for itself, and strand the
  // credit that was already sitting there.
  const shortfallCgst = positive(remainingLiability.cgst - remainingCredit.cgst);
  const shortfallSgst = positive(remainingLiability.sgst - remainingCredit.sgst);
  const totalShortfall = shortfallCgst + shortfallSgst;
  const spare = remainingCredit.igst;

  if (spare > 0n && totalShortfall > 0n) {
    let toCgst: bigint;
    if (spare >= totalShortfall) {
      // Enough to clear both shortfalls. Anything left over is spent on
      // whichever head still has liability, which the ordinary steps
      // below would do anyway; give each exactly its shortfall here.
      toCgst = shortfallCgst;
    } else {
      // ⭐ PROPORTIONAL, WITH THE REMAINDER GOING TO THE LARGER
      // SHORTFALL. Any split that stays within both shortfalls costs the
      // same cash; proportional is the one that does not quietly favour
      // one State's pool over the other.
      toCgst = (spare * shortfallCgst) / totalShortfall;
      const toSgst = spare - toCgst;
      if (toSgst > shortfallSgst) toCgst = spare - shortfallSgst;
      if (toCgst > shortfallCgst) toCgst = shortfallCgst;
    }
    const toSgst = minOf(spare - toCgst, shortfallSgst);

    spend(
      "igst",
      "cgst",
      minOf(toCgst, remainingLiability.cgst),
      "IGST credit left after clearing IGST, allocated against the CGST shortfall that CGST credit alone could not cover.",
    );
    spend(
      "igst",
      "sgst",
      minOf(toSgst, remainingLiability.sgst),
      "IGST credit left after clearing IGST, allocated against the SGST shortfall that SGST credit alone could not cover.",
    );
  }

  // ⚠️ ANY IGST CREDIT STILL LEFT is spent on whatever liability remains,
  // CGST then SGST. At this point both shortfalls are covered, so the
  // order genuinely does not matter.
  spend(
    "igst",
    "cgst",
    minOf(remainingCredit.igst, remainingLiability.cgst),
    "IGST credit left after clearing IGST may be used against CGST.",
  );
  spend(
    "igst",
    "sgst",
    minOf(remainingCredit.igst, remainingLiability.sgst),
    "IGST credit left after clearing IGST and CGST may be used against SGST.",
  );

  /* ---- ③ to ⑤ ---------------------------------------------------- */
  for (const step of SETOFF_ORDER) {
    spend(
      step.credit,
      step.liability,
      minOf(remainingCredit[step.credit], remainingLiability[step.liability]),
      step.rule,
    );
  }

  const creditUsed: HeadAmounts = {
    igst: args.credit.igst - remainingCredit.igst,
    cgst: args.credit.cgst - remainingCredit.cgst,
    sgst: args.credit.sgst - remainingCredit.sgst,
    cess: args.credit.cess - remainingCredit.cess,
  };

  const cashPayable: HeadAmounts = {
    igst: remainingLiability.igst,
    cgst: remainingLiability.cgst,
    sgst: remainingLiability.sgst,
    cess: remainingLiability.cess,
  };

  const liabilityCleared: HeadAmounts = {
    igst: args.liability.igst - cashPayable.igst,
    cgst: args.liability.cgst - cashPayable.cgst,
    sgst: args.liability.sgst - cashPayable.sgst,
    cess: args.liability.cess - cashPayable.cess,
  };

  const creditCarried: HeadAmounts = {
    igst: remainingCredit.igst,
    cgst: remainingCredit.cgst,
    sgst: remainingCredit.sgst,
    cess: remainingCredit.cess,
  };

  /**
   * ⭐ THE SENTENCE THAT SAVES SOMEBODY A PHONE CALL TO THEIR
   * ACCOUNTANT.
   *
   * ⚠️ Cash due in one State head while credit sits unused in the other
   * is not a bug and it is the most common "surely this is wrong" query.
   * It happens because CGST and SGST credit cannot cross, and saying so
   * here is cheaper than saying it on the phone.
   */
  if (
    (cashPayable.cgst > 0n && creditCarried.sgst > 0n) ||
    (cashPayable.sgst > 0n && creditCarried.cgst > 0n)
  ) {
    notes.push(
      "Cash is due under one State head while credit is left unused under the other. That is correct: CGST credit can never be set off against SGST, or the other way round. They are different governments, and the balance carries forward.",
    );
  }

  if (totalOf(creditCarried) > 0n && totalOf(cashPayable) === 0n) {
    notes.push(
      "Everything was settled from credit this month, and the balance carries forward.",
    );
  }

  return {
    moves,
    creditUsed,
    liabilityCleared,
    cashPayable,
    creditCarried,
    notes,
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* THE RETURN ITSELF                                                   */
/* ------------------------------------------------------------------ */

export interface Gstr3bFacts {
  readonly taxPeriod: string;
  readonly gstin: string;

  /** 3.1(a) — taxable outward supplies other than zero-rated and nil. */
  readonly outwardTaxable: HeadAmounts;
  readonly outwardTaxableValueMinor: bigint;

  /** 3.1(b) — zero-rated: exports and SEZ. Tax may be zero. */
  readonly outwardZeroRated: HeadAmounts;
  readonly outwardZeroRatedValueMinor: bigint;

  /** 3.1(c) — nil-rated and exempt. Value only. */
  readonly outwardExemptValueMinor: bigint;

  /**
   * 3.1(d) — INWARD supplies on which the recipient pays under reverse
   * charge.
   *
   * 🔴 IT SITS IN THE OUTWARD TABLE AND IT IS NOT A SALE. That placement
   * is the single most confusing thing on the form, and the reason it is
   * there is that the tax is payable by us: it belongs with what we owe,
   * not with what we bought.
   *
   * ⚠️ AND IT MUST BE PAID IN CASH. Reverse-charge liability cannot be
   * discharged from credit — the credit for it arises only after it has
   * been paid. Setting it off is the second most common 3B error.
   */
  readonly inwardRcm: HeadAmounts;
  readonly inwardRcmValueMinor: bigint;

  /** 4(A) — ITC available, before reversals. */
  readonly itcAvailable: HeadAmounts;
  /** 4(B) — ITC to be reversed: rule 42/43, and s.17(5) blocked credit. */
  readonly itcReversed: HeadAmounts;

  /** Balance in the credit ledger brought forward from last month. */
  readonly creditBroughtForward: HeadAmounts;

  /** 5.1 — interest and late fee, always cash. */
  readonly interestMinor: bigint;
  readonly lateFeeMinor: bigint;
}

export interface Gstr3bReturn {
  readonly taxPeriod: string;
  readonly gstin: string;

  /**
   * ⭐ TABLE 3.1(a)'s VALUE COLUMN, CARRIED THROUGH.
   *
   * ⚠️ I DROPPED THIS ON THE FIRST PASS. The build took the taxable
   * value in its facts, used it for nothing, and did not return it — so
   * the action storing the return had nowhere to read it from and wrote
   * a literal zero. A 3B whose tax is right and whose taxable value is
   * nil is a return that will not pass the portal's own validation, and
   * it looked entirely plausible in the database.
   */
  readonly outwardTaxableValueMinor: bigint;
  readonly outwardZeroRatedValueMinor: bigint;
  readonly outwardExemptValueMinor: bigint;

  readonly outputLiability: HeadAmounts;
  /** ⚠️ Separated, because it may not be set off. */
  readonly rcmLiability: HeadAmounts;
  readonly netItc: HeadAmounts;
  readonly creditAvailable: HeadAmounts;

  readonly setoff: SetoffResult;

  /** 🔴 What actually has to leave the bank, all in. */
  readonly cashPayableMinor: bigint;
  readonly cashByHead: HeadAmounts;
  readonly interestMinor: bigint;
  readonly lateFeeMinor: bigint;
  readonly totalCashMinor: bigint;

  readonly notes: readonly string[];
  readonly problems: readonly string[];
}

export function buildGstr3b(facts: Gstr3bFacts): Gstr3bReturn {
  const problems: string[] = [];
  const notes: string[] = [];

  /**
   * ⭐ REVERSE-CHARGE LIABILITY IS HELD OUT OF THE SET-OFF ENTIRELY.
   *
   * 🔴 It is payable in cash by law: the credit for a reverse-charge
   * supply arises only once the tax has been paid, so using credit to
   * pay it would be using a credit that does not exist yet. Folding it
   * into the set-off produces a smaller cash figure that is wrong in
   * exactly the direction the department notices.
   */
  const outputLiability = facts.outwardTaxable;
  const rcmLiability = facts.inwardRcm;

  const netItc: HeadAmounts = {
    igst: facts.itcAvailable.igst - facts.itcReversed.igst,
    cgst: facts.itcAvailable.cgst - facts.itcReversed.cgst,
    sgst: facts.itcAvailable.sgst - facts.itcReversed.sgst,
    cess: facts.itcAvailable.cess - facts.itcReversed.cess,
  };

  for (const head of ["igst", "cgst", "sgst", "cess"] as const) {
    if (netItc[head] < 0n) {
      // ⚠️ REVERSALS EXCEEDING AVAILABLE CREDIT IS ARITHMETICALLY
      // POSSIBLE AND MEANS SOMETHING REAL: credit taken in an earlier
      // month is being given back. It is a payable, not a negative
      // credit, and Ordence refuses to file it as one.
      problems.push(
        `Reversals under ${head.toUpperCase()} come to more than the credit available this month. That is a liability to be paid rather than a negative credit, and it has to be entered as one before this return can be filed.`,
      );
    }
  }

  const creditAvailable = addHeads(netItc, facts.creditBroughtForward);

  const setoff = computeSetoff({
    liability: outputLiability,
    credit: creditAvailable,
  });

  /**
   * 🔴 THE CASH FIGURE IS THE SET-OFF SHORTFALL PLUS THE WHOLE OF
   * REVERSE CHARGE, PLUS INTEREST AND LATE FEE.
   */
  const cashByHead: HeadAmounts = addHeads(setoff.cashPayable, rcmLiability);
  const cashPayable = totalOf(cashByHead);

  if (totalOf(rcmLiability) > 0n) {
    notes.push(
      "Reverse-charge tax is included in the cash figure in full and is deliberately not set off against credit. The credit for it only arises once it has been paid, so paying it from credit would be spending something that does not exist yet.",
    );
  }

  if (facts.outwardZeroRatedValueMinor > 0n && totalOf(facts.outwardZeroRated) === 0n) {
    notes.push(
      "Zero-rated supplies are reported at value with no tax, which is right for an export under a letter of undertaking. If any were made on payment of IGST, that tax belongs in the taxable row instead.",
    );
  }

  return {
    taxPeriod: facts.taxPeriod,
    gstin: facts.gstin,
    outwardTaxableValueMinor: facts.outwardTaxableValueMinor,
    outwardZeroRatedValueMinor: facts.outwardZeroRatedValueMinor,
    outwardExemptValueMinor: facts.outwardExemptValueMinor,
    outputLiability,
    rcmLiability,
    netItc,
    creditAvailable,
    setoff,
    cashPayableMinor: cashPayable,
    cashByHead,
    interestMinor: facts.interestMinor,
    lateFeeMinor: facts.lateFeeMinor,
    totalCashMinor: cashPayable + facts.interestMinor + facts.lateFeeMinor,
    notes: [...notes, ...setoff.notes],
    problems: [...problems, ...setoff.problems],
  };
}

/* ------------------------------------------------------------------ */
/* WHEN IT IS DUE                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE TWENTIETH OF THE FOLLOWING MONTH, and the phrasing matters.
 *
 * 🔴 "TWENTY DAYS AFTER THE PERIOD ENDS" IS A DIFFERENT DATE and it is
 * the mistake `server/actions/compliance.ts` already documents. February
 * ends on the 28th; twenty days later is 20 March by luck rather than by
 * rule, and in a 31-day month the two answers differ by three days.
 */
export function gstr3bDueDate(taxPeriod: string): string {
  const year = Number(taxPeriod.slice(0, 4));
  const month = Number(taxPeriod.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return taxPeriod;
  const dueMonth = month === 12 ? 1 : month + 1;
  const dueYear = month === 12 ? year + 1 : year;
  return `${dueYear}-${String(dueMonth).padStart(2, "0")}-20`;
}
