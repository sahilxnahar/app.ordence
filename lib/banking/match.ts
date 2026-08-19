/**
 * Ordence — ⭐⭐⭐ MATCHING THE BANK TO THE BOOKS
 * Version: v1.18.0-alpha
 *
 * Pure. No clock, no network, no database. `today` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE STATEMENT IS THE TRUTH ABOUT THE BANK. THE LEDGER IS THE
 * TRUTH ABOUT THE BUSINESS. RECONCILIATION EXPLAINS THE DIFFERENCE.
 * ══════════════════════════════════════════════════════════════════════
 * It does not remove it. Every reconciliation tool that quietly "fixes"
 * the ledger to agree with the bank has destroyed the only evidence that
 * something was wrong, and the cheque that was never presented, the
 * payment taken twice, and the bank's own error all vanish into a tidy
 * green tick.
 *
 * ⭐ SO NOTHING HERE WRITES A LEDGER ENTRY. It proposes pairings. A
 * person confirms them, and the items that remain unpaired are the
 * output, not the failure.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE TWO KINDS OF UNMATCHED ARE COMPLETELY DIFFERENT PROBLEMS
 * ══════════════════════════════════════════════════════════════════════
 * IN THE BANK, NOT IN THE BOOKS: money moved and nobody recorded it.
 * Bank charges, a direct debit, interest, a customer who paid straight
 * into the account without telling anybody. Someone has to write it up.
 *
 * IN THE BOOKS, NOT IN THE BANK: we recorded money that has not moved.
 * A cheque issued and not presented, a payment that failed, or a receipt
 * entered against the wrong day. Some of these are fine and some are a
 * customer who has not actually paid.
 *
 * 🔴 A SINGLE "UNRECONCILED" NUMBER COMBINES THEM AND IS USELESS. They
 * are counted, listed and totalled apart everywhere in this file.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE MATCHER PROPOSES. IT NEVER DECIDES.
 * ══════════════════════════════════════════════════════════════════════
 * An auto-matcher that is confidently wrong is worse than one that asks,
 * because its mistakes are invisible: two ₹50,000 payments to different
 * vendors on the same day will match each other's statement lines
 * perfectly and reconcile to zero. The books balance and both ledgers
 * are wrong.
 *
 * ⚠️ SO CONFIDENCE IS RETURNED, NOT ACTED ON, AND AMBIGUITY IS REPORTED
 * AS AMBIGUITY: where two candidates score alike, `proposalsFor` says so
 * rather than picking the first.
 */

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 MONEY IS `bigint` MINOR UNITS, AS EVERYWHERE ELSE IN ORDENCE.
 *
 * ⚠️ SIGN CONVENTION, WRITTEN DOWN BECAUSE IT IS THE SINGLE EASIEST
 * THING TO GET BACKWARDS: positive is money INTO the account. A customer
 * receipt is positive. A vendor payment is negative. Bank charges are
 * negative. Every bank in India exports these as two columns headed
 * something like "withdrawal" and "deposit", and the importer is
 * responsible for turning that into one signed number before anything
 * here sees it.
 */
export type Minor = bigint;

/** One line off the bank's own statement. Never edited, only explained. */
export interface StatementLine {
  readonly id: string;
  /** The date the BANK says it happened, which is not always the real one. */
  readonly valueDate: string;
  readonly amountMinor: Minor;
  /** Whatever the bank wrote. Usually ugly, occasionally the only clue. */
  readonly narration: string;
  /** The bank's own reference, where it gives one. */
  readonly bankReference: string | null;
}

/** Something in our books that could explain a statement line. */
export interface LedgerCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly occurredOn: string;
  readonly amountMinor: Minor;
  /** Cheque number, UTR, receipt number: whatever we recorded. */
  readonly reference: string | null;
  /** The customer or vendor, for the person reading the proposal. */
  readonly counterpartyName: string | null;
  readonly documentNo: string | null;
}

export type CandidateKind =
  | "customer_receipt"
  | "vendor_payment"
  | "journal_entry";

/* ------------------------------------------------------------------ */
/* SCORING                                                             */
/* ------------------------------------------------------------------ */

export interface MatchScore {
  readonly candidateId: string;
  /** 0 to 100. ⚠️ Not a probability, and deliberately not called one. */
  readonly score: number;
  readonly confidence: Confidence;
  /** Why, in words, for the person deciding. */
  readonly reasons: readonly string[];
}

export type Confidence = "strong" | "possible" | "weak";

/**
 * 🔴 AN EXACT AMOUNT IS NECESSARY AND NOWHERE NEAR SUFFICIENT.
 *
 * ⚠️ This is the trap the whole module is arranged around. In a business
 * with regular payments, several will be for identical amounts, and
 * amount-only matching pairs them at random. It reconciles perfectly and
 * is wrong, and the error surfaces months later as two vendor accounts
 * that are both mysteriously out by the same figure.
 *
 * ⭐ SO AN AMOUNT MATCH ALONE NEVER REACHES `strong`. It needs the date
 * or the reference to agree as well.
 */
const AMOUNT_POINTS = 45;
const REFERENCE_POINTS = 35;
const DATE_POINTS = 20;

/** ⚠️ A cheque can clear a week after it is written. Three days is tight. */
export const DATE_TOLERANCE_DAYS = 5;

export const STRONG_AT = 80;
export const POSSIBLE_AT = 50;

export function scoreCandidate(
  line: StatementLine,
  candidate: LedgerCandidate,
): MatchScore {
  const reasons: string[] = [];
  let score = 0;

  // ① The amount, to the paisa. Not "close", not "within a rupee".
  const amountAgrees = line.amountMinor === candidate.amountMinor;
  if (amountAgrees) {
    score += AMOUNT_POINTS;
    reasons.push("The amount is exactly the same.");
  } else {
    // 🔴 A DIFFERENT AMOUNT IS NOT A WEAK MATCH, IT IS NOT A MATCH.
    // Partial-amount scoring is how a ₹9,000 receipt gets paired with a
    // ₹90,000 statement line by a tired person at half past six.
    return {
      candidateId: candidate.id,
      score: 0,
      confidence: "weak",
      reasons: ["The amounts are different, so these cannot be the same event."],
    };
  }

  // ② The reference, if both sides have one.
  const ref = normaliseReference(candidate.reference);
  if (ref !== null && ref.length >= 4) {
    const haystack = `${normaliseReference(line.narration) ?? ""} ${normaliseReference(line.bankReference) ?? ""}`;
    if (haystack.includes(ref)) {
      score += REFERENCE_POINTS;
      reasons.push(`The reference ${candidate.reference} appears on the bank line.`);
    }
  }

  // ③ The date, within tolerance.
  const gap = daysBetween(candidate.occurredOn, line.valueDate);
  if (gap !== null && Math.abs(gap) <= DATE_TOLERANCE_DAYS) {
    // ⭐ Nearer is better, but same-day is not required: a cheque
    // presented four days later is the normal case, not a suspicious one.
    const closeness = 1 - Math.abs(gap) / (DATE_TOLERANCE_DAYS + 1);
    score += Math.round(DATE_POINTS * closeness);
    reasons.push(
      gap === 0
        ? "Both are dated the same day."
        : `The bank dates it ${Math.abs(gap)} day${Math.abs(gap) === 1 ? "" : "s"} ${gap > 0 ? "after" : "before"} we recorded it, which is normal for a cheque.`,
    );
  } else if (gap !== null) {
    reasons.push(
      `We recorded this ${Math.abs(gap)} days ${gap > 0 ? "before" : "after"} the bank date, which is a long way apart for the same event.`,
    );
  }

  return {
    candidateId: candidate.id,
    score,
    confidence: score >= STRONG_AT ? "strong" : score >= POSSIBLE_AT ? "possible" : "weak",
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* PROPOSING                                                           */
/* ------------------------------------------------------------------ */

export interface Proposal {
  readonly statementLineId: string;
  /** Best first. Empty where nothing in the books explains this line. */
  readonly ranked: readonly MatchScore[];
  /**
   * ⭐⭐ TRUE WHERE THE TOP TWO ARE TOO CLOSE TO CHOOSE BETWEEN.
   *
   * 🔴 THIS IS THE FIELD THAT STOPS THE SILENT WRONG ANSWER. Two
   * identical payments on the same day produce two identical scores, and
   * a matcher that takes the first is right half the time and gives no
   * indication which half it is in.
   */
  readonly ambiguous: boolean;
  /** What a person should be told, in one line. */
  readonly headline: string;
}

/** ⚠️ Closer than this and we refuse to prefer one over the other. */
export const AMBIGUOUS_WITHIN = 10;

export function proposalsFor(
  line: StatementLine,
  candidates: readonly LedgerCandidate[],
): Proposal {
  const ranked = candidates
    .map((c) => scoreCandidate(line, c))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  const ambiguous =
    best !== undefined &&
    second !== undefined &&
    best.score - second.score < AMBIGUOUS_WITHIN;

  let headline: string;
  if (best === undefined) {
    headline =
      line.amountMinor > 0n
        ? "Money arrived that is not recorded anywhere in the books. Somebody has to write it up."
        : "Money left the account and is not recorded anywhere in the books. Somebody has to write it up.";
  } else if (ambiguous) {
    headline = `${ranked.filter((r) => best.score - r.score < AMBIGUOUS_WITHIN).length} entries fit this line equally well. Choosing for you would be a guess, and a wrong one reconciles perfectly while leaving two accounts wrong.`;
  } else if (best.confidence === "strong") {
    headline = "One entry fits this line well.";
  } else {
    headline =
      "One entry has the right amount, but nothing else about it agrees. Worth checking before accepting.";
  }

  return { statementLineId: line.id, ranked, ambiguous, headline };
}

/* ------------------------------------------------------------------ */
/* THE RECONCILIATION ITSELF                                           */
/* ------------------------------------------------------------------ */

export interface ReconciliationInput {
  /** What the ledger says the account holds at the closing date. */
  readonly ledgerClosingMinor: Minor;
  /** What the bank says. */
  readonly statementClosingMinor: Minor;
  /** Statement lines with nothing in the books to explain them. */
  readonly unmatchedInBank: readonly StatementLine[];
  /** Ledger entries the statement does not show. */
  readonly unmatchedInLedger: readonly LedgerCandidate[];
}

export interface ReconciliationStatement {
  readonly ledgerClosingMinor: Minor;
  readonly statementClosingMinor: Minor;
  /** ⚠️ Statement minus ledger. What has to be explained away. */
  readonly differenceMinor: Minor;
  readonly inBankNotBooksMinor: Minor;
  readonly inBooksNotBankMinor: Minor;
  /**
   * 🔴 WHAT IS LEFT AFTER BOTH LISTS ARE ACCOUNTED FOR. Zero means the
   * account reconciles. Anything else is a real, unexplained gap.
   */
  readonly unexplainedMinor: Minor;
  readonly reconciles: boolean;
  readonly notes: readonly string[];
}

/**
 * ⭐⭐ THE ARITHMETIC OF A BANK RECONCILIATION, WHICH IS SMALL AND
 * ALMOST ALWAYS WRITTEN BACKWARDS.
 *
 * Starting from the ledger:
 *   ledger balance
 *     + things the bank has that we have not recorded
 *     − things we have recorded that the bank has not
 *     = the bank's balance
 *
 * ⚠️ ANYTHING LEFT OVER IS NOT A ROUNDING ISSUE AND MUST NOT BE
 * PRESENTED AS ONE. A non-zero residue means either a match is wrong or
 * something is missing from both lists, and both are worth a person's
 * time. `unexplainedMinor` is reported plainly rather than folded into a
 * tolerance.
 */
export function reconcile(input: ReconciliationInput): ReconciliationStatement {
  const inBankNotBooks = sum(input.unmatchedInBank.map((l) => l.amountMinor));
  const inBooksNotBank = sum(input.unmatchedInLedger.map((c) => c.amountMinor));

  const expectedStatement =
    input.ledgerClosingMinor + inBankNotBooks - inBooksNotBank;
  const unexplained = input.statementClosingMinor - expectedStatement;

  const notes: string[] = [];

  if (unexplained !== 0n) {
    notes.push(
      "This account does not reconcile. After allowing for everything on both lists there is still a difference, which means either one of the confirmed matches is wrong or something is missing from both sides. It is not a rounding error.",
    );
  }

  if (input.unmatchedInBank.length > 0) {
    notes.push(
      `${input.unmatchedInBank.length} item${input.unmatchedInBank.length === 1 ? "" : "s"} moved through the bank without being recorded here. Bank charges, interest and direct debits usually live in this list, and so does a customer who paid straight into the account without telling anyone.`,
    );
  }

  if (input.unmatchedInLedger.length > 0) {
    notes.push(
      `${input.unmatchedInLedger.length} item${input.unmatchedInLedger.length === 1 ? " is" : "s are"} recorded here but have not reached the bank. A cheque written and not yet presented is normal. A customer receipt that never arrives is not, and the two look identical on this list until somebody checks the date.`,
    );
  }

  return {
    ledgerClosingMinor: input.ledgerClosingMinor,
    statementClosingMinor: input.statementClosingMinor,
    differenceMinor: input.statementClosingMinor - input.ledgerClosingMinor,
    inBankNotBooksMinor: inBankNotBooks,
    inBooksNotBankMinor: inBooksNotBank,
    unexplainedMinor: unexplained,
    reconciles: unexplained === 0n,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* THE DUPLICATE IMPORT                                                */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐⭐ THE MOST COMMON WAY A RECONCILIATION SILENTLY DOUBLES.
 *
 * ⚠️ Somebody downloads January, imports it, is not sure it worked, and
 * imports it again. Now every January transaction appears twice, half of
 * them match nothing, and the account is out by exactly the month's
 * turnover with no indication why.
 *
 * 🔴 A BANK GIVES NO RELIABLE UNIQUE ID, so the fingerprint is built
 * from what a bank cannot change between two exports of the same line:
 * the date, the exact amount, and the narration with its whitespace and
 * case flattened. Two genuinely separate identical payments on one day
 * will collide, which is why this REPORTS rather than REFUSES: the
 * screen shows what looks duplicated and a person decides.
 */
export function fingerprintOf(line: {
  valueDate: string;
  amountMinor: Minor;
  narration: string;
}): string {
  const narration = line.narration.replace(/\s+/g, " ").trim().toLowerCase();
  return `${line.valueDate}|${line.amountMinor.toString()}|${narration}`;
}

export interface DuplicateReport {
  readonly fingerprint: string;
  readonly count: number;
  readonly sample: string;
}

export function findDuplicates(
  incoming: ReadonlyArray<{ valueDate: string; amountMinor: Minor; narration: string }>,
  alreadyStored: readonly string[],
): readonly DuplicateReport[] {
  const seen = new Map<string, { count: number; sample: string }>();
  for (const f of alreadyStored) {
    seen.set(f, { count: (seen.get(f)?.count ?? 0) + 1, sample: "" });
  }

  const flagged = new Map<string, DuplicateReport>();
  for (const line of incoming) {
    const f = fingerprintOf(line);
    const prior = seen.get(f);
    if (prior) {
      flagged.set(f, {
        fingerprint: f,
        count: prior.count + 1,
        sample: line.narration.trim().slice(0, 120),
      });
    }
    seen.set(f, { count: (prior?.count ?? 0) + 1, sample: line.narration });
  }

  return [...flagged.values()];
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

function sum(values: readonly Minor[]): Minor {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/**
 * ⚠️ REFERENCES ARE COMPARED WITH EVERYTHING A HUMAN OR A BANK MIGHT
 * HAVE ADDED STRIPPED OUT. `CHQ 000123` and `chq-123` are the same
 * cheque, and leading zeros are added and removed by different systems
 * with no consistency whatsoever.
 */
export function normaliseReference(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length === 0) return null;

  /**
   * 🔴 LEADING ZEROS ARE STRIPPED FROM EVERY DIGIT RUN, NOT ONLY FROM A
   * REFERENCE THAT IS ENTIRELY NUMERIC.
   *
   * ⚠️ THE FIRST VERSION OF THIS ONLY HANDLED THE ALL-DIGITS CASE, AND A
   * TEST CAUGHT IT. `CHQ 000123` flattens to `chq000123` while `chq-123`
   * flattens to `chq123`, so the two most ordinary ways of writing the
   * same cheque number did not match. The prefixed form is the common
   * one: a cheque book prints the zeros and a person typing it into
   * Ordence does not.
   *
   * ⭐ A run that is entirely zeros collapses to a single `0` rather
   * than to nothing, because a reference of `0` is a reference and an
   * empty string is a bug that matches everything.
   */
  return cleaned.replace(/\d+/g, (run) => run.replace(/^0+/, "") || "0");
}

/**
 * ⚠️ DATES ARE `YYYY-MM-DD` STRINGS AND ARE COMPARED AS DAYS, not as
 * timestamps. A statement has no time on it, and constructing a Date
 * from a bare date string lands on midnight UTC, which is the previous
 * evening in India and shifts every comparison by a day.
 */
export function daysBetween(from: string, to: string): number | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (a === null || b === null) return null;
  return b - a;
}

function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 86_400_000);
}
