/**
 * Ordence — ⭐⭐⭐ THE BALANCE, WHICH IS A FOLD AND NOT A COLUMN
 * Version: v1.46.0-alpha · Batch 59
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THERE IS NO `leave_balances` TABLE, AND THIS FILE IS WHY
 * ══════════════════════════════════════════════════════════════════════
 * A stored balance is a cache of a sum over a ledger. Caches go stale.
 * This one goes stale in the worst possible place: an employee has their
 * own list of the days they took, and when the two disagree the employee
 * is right and the system has no argument. "The system says eight" is not
 * a sentence anybody can defend in a room.
 *
 * ⚠️ THE FAILURE IS NOT HYPOTHETICAL AND IT IS NOT RARE. It arrives the
 * first time a write path forgets to update the cache — a bulk import, a
 * cancellation, an admin adjustment made in a transaction that rolled
 * back halfway. From then on every screen is confidently wrong and
 * nothing reports it, because the cache is the only thing anybody reads.
 *
 * ⭐ SO THE BALANCE IS COMPUTED, EVERY TIME, FROM THE ENTRIES. The
 * ledger is append-only (`leave_ledger_block_mutation()`), which means
 * the fold is reproducible: the same entries always produce the same
 * number, and a disagreement is a disagreement about the entries, which
 * is an argument that can actually be had.
 *
 * ⚠️ AND IF IT EVER BECOMES TOO SLOW, THE ANSWER IS A MATERIALISED VIEW
 * WITH A REFRESH — a cache that says out loud that it is one — and not a
 * column somebody updates by hand.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ TWO NUMBERS, NOT ONE: `balance` AND `available`
 * ══════════════════════════════════════════════════════════════════════
 * DECISION ④. An approved leave request COMMITS days; it does not spend
 * them. Somebody with 10 days earned and 4 days approved for December
 * has a BALANCE of 10 and an AVAILABLE of 6.
 *
 * 🔴 COLLAPSING THE TWO IN EITHER DIRECTION IS A REAL BUG:
 *
 *   Deducting on approval  → the employee who cancels their holiday has
 *                            lost four days until somebody notices, and
 *                            the leave register says they were absent on
 *                            days they worked.
 *   Ignoring the approval  → two people book the same week off against
 *                            the same six remaining days, both are
 *                            approved, and the second one goes onto loss
 *                            of pay in the month it happens.
 */

import { parseDaysOrZero, type Centidays } from "./days";

/**
 * The nine kinds `leave_ledger.kind` can hold. Duplicated from the enum
 * deliberately: this file is pure and must not import the schema, and a
 * mismatch is caught by `tests/ui/leave.test.ts`, which reads both.
 */
export type LeaveEntryKind =
  | "opening_balance"
  | "accrual"
  | "carry_forward_in"
  | "lapse"
  | "taken"
  | "encashed"
  | "adjustment"
  | "commitment"
  | "commitment_release";

/** One row of `leave_ledger`, as the fold needs it. */
export interface LedgerEntryFacts {
  readonly kind: LeaveEntryKind;
  /** ⚠️ The raw `numeric` string from Drizzle. Parsed in here, once. */
  readonly daysDelta: string | number;
}

export interface LeaveBalance {
  readonly openingCentidays: Centidays;
  readonly carriedInCentidays: Centidays;
  readonly accruedCentidays: Centidays;
  readonly adjustedCentidays: Centidays;
  /** Positive numbers, for display. `taken` is stored negative. */
  readonly takenCentidays: Centidays;
  readonly encashedCentidays: Centidays;
  readonly lapsedCentidays: Centidays;
  /** ⭐ What has been earned and not yet spent. */
  readonly balanceCentidays: Centidays;
  /** Positive. Approved-but-not-taken. */
  readonly committedCentidays: Centidays;
  /** 🔴 What may still be applied for: balance − committed. */
  readonly availableCentidays: Centidays;
  readonly entryCount: number;
}

const ZERO: LeaveBalance = {
  openingCentidays: 0,
  carriedInCentidays: 0,
  accruedCentidays: 0,
  adjustedCentidays: 0,
  takenCentidays: 0,
  encashedCentidays: 0,
  lapsedCentidays: 0,
  balanceCentidays: 0,
  committedCentidays: 0,
  availableCentidays: 0,
  entryCount: 0,
};

/**
 * ⭐ THE FOLD. Order-independent by construction — it is a sum, and a sum
 * that depended on the order of its terms would make "recompute the
 * balance" a different answer depending on how the rows came back.
 */
export function foldLedger(entries: readonly LedgerEntryFacts[]): LeaveBalance {
  let opening = 0;
  let carried = 0;
  let accrued = 0;
  let adjusted = 0;
  let taken = 0;
  let encashed = 0;
  let lapsed = 0;
  let committed = 0;

  for (const e of entries) {
    const d = parseDaysOrZero(e.daysDelta);
    switch (e.kind) {
      case "opening_balance":
        opening += d;
        break;
      case "carry_forward_in":
        carried += d;
        break;
      case "accrual":
        accrued += d;
        break;
      case "adjustment":
        adjusted += d;
        break;
      case "taken":
        taken += -d;
        break;
      case "encashed":
        encashed += -d;
        break;
      case "lapse":
        lapsed += -d;
        break;
      /*
       * 🔴 THE TWO THAT DO NOT TOUCH THE BALANCE. A commitment is
       * negative and a release is positive, so they cancel out to the
       * outstanding reservation with no special-casing.
       */
      case "commitment":
      case "commitment_release":
        committed += -d;
        break;
      default:
        /*
         * ⚠️ AN UNKNOWN KIND IS IGNORED RATHER THAN GUESSED AT. A new
         * enum value added to the database without a case here would
         * otherwise be folded into whichever bucket the fallthrough
         * happened to reach, and a balance wrong by one entry looks like
         * a balance.
         */
        break;
    }
  }

  const balance = opening + carried + accrued + adjusted - taken - encashed - lapsed;

  return {
    openingCentidays: opening,
    carriedInCentidays: carried,
    accruedCentidays: accrued,
    adjustedCentidays: adjusted,
    takenCentidays: taken,
    encashedCentidays: encashed,
    lapsedCentidays: lapsed,
    balanceCentidays: balance,
    committedCentidays: committed,
    availableCentidays: balance - committed,
    entryCount: entries.length,
  };
}

/** An employee with no entries at all has a balance of zero, not an error. */
export function emptyBalance(): LeaveBalance {
  return ZERO;
}

/* ================================================================== */
/* CARRY-FORWARD — DECISION ③                                          */
/* ================================================================== */

export interface CarryForwardOutcome {
  /** Written into the NEW period as `carry_forward_in`. Never negative. */
  readonly carriedCentidays: Centidays;
  /** Written into the OLD period as `lapse`. Never negative. */
  readonly lapsedCentidays: Centidays;
  readonly workingNote: string;
}

/**
 * ⭐⭐ THE CAP IS AN ARGUMENT, NOT AN OPTION.
 *
 * `capCentidays` has no "unlimited" value and the column behind it is
 * `NOT NULL`. Pass 0 for "use it or lose it", which is the commonest
 * policy in India and a perfectly good one — it just has to be a decision
 * somebody made.
 *
 * 🔴 WHAT UNCAPPED CARRY-FORWARD COSTS, ARITHMETICALLY. Thirty people
 * leaving five days a year unused, carried without limit, is 150 days a
 * year of accumulating obligation. After six years it is 900 days — very
 * nearly three person-years of salary — and it has never appeared in a
 * single management account, because nothing in the product was asked to
 * value it. It becomes cash in one quarter the first time a team turns
 * over.
 *
 * ⚠️ A NEGATIVE BALANCE CARRIES IN FULL AND NEVER LAPSES. Lapsing a debt
 * would forgive an overdraft silently, and the employee who borrowed
 * three days against next year's accrual would find them written off by a
 * background job. The cap is a ceiling on what an employee may KEEP, not
 * on what they may OWE.
 */
export function carryForward(args: {
  readonly closingCentidays: Centidays;
  readonly capCentidays: Centidays;
}): CarryForwardOutcome {
  const closing = args.closingCentidays;
  const cap = Math.max(0, args.capCentidays);

  if (closing < 0) {
    return {
      carriedCentidays: closing,
      lapsedCentidays: 0,
      workingNote:
        `A negative balance of ${fmt(-closing)} days carries forward in full. ` +
        `A cap limits what may be kept, not what is owed — lapsing it would write off a debt nobody decided to forgive.`,
    };
  }

  const carried = Math.min(closing, cap);
  const lapsed = closing - carried;

  return {
    carriedCentidays: carried,
    lapsedCentidays: lapsed,
    workingNote:
      lapsed > 0
        ? `${fmt(closing)} days were unused. The carry-forward cap is ${fmt(cap)}, so ${fmt(carried)} carry into the new leave year and ${fmt(lapsed)} lapse.`
        : `${fmt(closing)} days carry into the new leave year, within the cap of ${fmt(cap)}.`,
  };
}

/* ================================================================== */
/* ENCASHMENT — DECISION ③, THE OTHER HALF                             */
/* ================================================================== */

export interface EncashmentOutcome {
  readonly allowedCentidays: Centidays;
  readonly refusedCentidays: Centidays;
  readonly reason: string | null;
}

/**
 * ⚠️ THREE LIMITS, AND THE THIRD IS THE ONE PEOPLE FORGET.
 *
 *   the balance          you cannot cash days you do not have
 *   the annual cap       the policy's ceiling on cash-out
 *   the minimum retained 🔴 what must be LEFT afterwards
 *
 * Encashing to zero and then falling ill is how somebody ends up on loss
 * of pay in the month after they were paid for their leave, and it is the
 * employer who looks like they engineered it.
 *
 * ⭐ `alreadyEncashedCentidays` IS THIS PERIOD'S ENCASHMENTS ONLY. The
 * cap is annual; carrying it across years would make it a lifetime limit,
 * which is not what any policy document means by it.
 */
export function encashable(args: {
  readonly balanceCentidays: Centidays;
  readonly capCentidays: Centidays;
  readonly minRetainCentidays: Centidays;
  readonly alreadyEncashedCentidays: Centidays;
  readonly requestedCentidays: Centidays;
}): EncashmentOutcome {
  const requested = Math.max(0, args.requestedCentidays);
  const capLeft = Math.max(0, args.capCentidays - Math.max(0, args.alreadyEncashedCentidays));
  const spendable = Math.max(0, args.balanceCentidays - Math.max(0, args.minRetainCentidays));

  const ceiling = Math.min(capLeft, spendable);
  const allowed = Math.min(requested, ceiling);
  const refused = requested - allowed;

  let reason: string | null = null;
  if (refused > 0) {
    if (ceiling === capLeft && capLeft < spendable) {
      reason =
        `The annual encashment cap for this leave type is ${fmt(args.capCentidays)} days and ` +
        `${fmt(args.alreadyEncashedCentidays)} have already been paid out this leave year.`;
    } else if (args.minRetainCentidays > 0) {
      reason =
        `${fmt(args.minRetainCentidays)} days must remain after an encashment, so only ` +
        `${fmt(spendable)} of a balance of ${fmt(args.balanceCentidays)} can be paid out.`;
    } else {
      reason = `The balance is ${fmt(args.balanceCentidays)} days.`;
    }
  }

  return { allowedCentidays: allowed, refusedCentidays: refused, reason };
}

/**
 * ⭐ WHAT AN ENCASHMENT IS WORTH, IN PAISE.
 *
 * 🔴 MONEY IS `bigint` MINOR UNITS HERE AS IT IS EVERYWHERE ELSE IN
 * ORDENCE, and the multiplication happens before the division so that a
 * half day of a ₹1,000 daily rate is 50,000 paise and not 49,999.
 *
 * ⚠️ THIS FUNCTION DOES NOT DECIDE THE DAILY RATE, AND THAT IS THE
 * CONTENTIOUS PART. Whether leave is encashed on basic, on basic+DA or on
 * gross is a policy question with real money on it and no single right
 * answer; the caller supplies the rate it has decided on, and the payslip
 * says which. A default hidden in here would be a policy nobody typed.
 *
 * ⭐ ROUNDED TO THE RUPEE, half away from zero, because payslips and
 * bank transfers are in rupees and a stray paisa is a reconciliation
 * item nobody can spend.
 */
export function encashmentValueMinor(
  centidays: Centidays,
  dailyRateMinor: bigint,
): bigint {
  const paise = (BigInt(Math.trunc(centidays)) * dailyRateMinor) / 100n;
  return roundToRupee(paise);
}

function roundToRupee(paise: bigint): bigint {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const remainder = abs % 100n;
  const rounded = remainder >= 50n ? abs - remainder + 100n : abs - remainder;
  return negative ? -rounded : rounded;
}

function fmt(centidays: Centidays): string {
  return (centidays / 100).toFixed(2).replace(/\.00$/, "");
}
