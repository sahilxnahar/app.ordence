/**
 * Ordence — ⭐⭐⭐ THE RECONCILIATION GATE
 * Version: v1.46.0-alpha (Batch 49)
 *
 * Pure. No database, no clock, no imports from `server/`. Money is
 * `bigint` paise throughout and never passes through a `Number`. The
 * actions load the two sides; every rupee of judgement is decided here,
 * where it can be exercised without standing up Postgres.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 WHAT THIS IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * `lib/accounting/cash-flow.ts` established the doctrine for the cash
 * flow statement in Batch 65: compute the answer twice by two routes
 * that share no ledger, and when the two disagree render NO figure —
 * not amber, not asterisked, and not the "true" one either, because a
 * correct number printed under a heading that has just failed its own
 * check reads to the person holding it as VERIFICATION.
 *
 * That doctrine was written for one statement. It belongs to every
 * report in the product that asserts a money total, and this module is
 * that doctrine generalised so the billing and receivables screens can
 * apply it without each inventing its own idea of what "reconciles"
 * means. Three screens with three definitions of a passing check is
 * three screens that can each be persuaded, separately, that a gap is
 * acceptable.
 *
 * ⚠️ WHAT GOES WRONG WITHOUT IT, CONCRETELY. The ageing report is built
 * from `demand_notices`. The books are built from `journal_entries`.
 * Nothing in the schema ties the two together — `withdrawDemand` removes
 * a demand from the ageing report and posts no reversing entry, and
 * `markReceiptBounced` releases an allocation and posts nothing either.
 * Both operations are correct on their own side and both silently move
 * the two totals apart. The developer reads ₹4.2 crore off the screen,
 * the auditor reads ₹4.05 crore off the trial balance, and the first
 * anybody hears of it is a year later in an audit query.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ① THE CHECK COMPARES TWO **INDEPENDENT** COMPUTATIONS
 * ══════════════════════════════════════════════════════════════════════
 * This is the design point that everything else hangs off, and it is the
 * one that is easiest to lose in a refactor six months from now.
 *
 * A check that reads the same query twice proves only that the query is
 * deterministic. A check that sums a list and then compares the sum to
 * the total it printed from the same list proves only that addition is
 * associative. Neither is a reconciliation, and both LOOK exactly like
 * one on the screen — a green tick, a "reconciled" badge, and the same
 * confidence as a real check.
 *
 * So `ReconciliationSide` carries a `source` string alongside the
 * amount, naming WHERE the figure was obtained, and `reconcile()`
 * records a fault when the two sides of a check quote the same source.
 * It is a cheap structural guard rather than a proof — nothing stops
 * somebody writing two different strings over one query — but it makes
 * the collapse of a two-source check into a one-source check something
 * a person has to do ON PURPOSE, in a diff, with the word `source`
 * visible on both lines.
 *
 * ⚠️ AND A FAULTED CHECK IS TREATED AS A BREACH, not as a pass. A gate
 * that cannot vouch for its own independence has not verified anything,
 * and "we could not check" must never render like "we checked".
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ② A BREACH NAMES WHAT DISAGREES AND BY HOW MUCH
 * ══════════════════════════════════════════════════════════════════════
 * "Reconciliation failed" is an outage: nobody reading it knows which
 * two numbers are being compared, which one they should trust, or where
 * to start looking. It routes every occurrence to support.
 *
 *   "AR ageing says ₹4,20,000.00, the receivables control account says
 *    ₹4,05,500.00 — a difference of ₹14,500.00."
 *
 * is a work item. The accounts clerk knows both figures, can pull both
 * listings, and ₹14,500 is a number they can search for. So every check
 * carries LABELS for both sides and the sentence is built here, once,
 * rather than assembled differently on each screen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ ③ ROUNDING IS NOT A BREACH — AND THE TOLERANCE IS STATED, TINY,
 *      AND CAPPED IN CODE
 * ══════════════════════════════════════════════════════════════════════
 * A report that divides — a pro-rata split, an interest accrual, a tax
 * apportionment — can land a paisa away from a total that was never
 * divided. Failing the whole report for one paisa trains people to
 * ignore the banner, and a banner people ignore is worse than no banner,
 * because it launders the real breach when it comes.
 *
 * 🔴 BUT A TOLERANCE IS A LICENCE TO BE WRONG BY THAT MUCH. A tolerance
 * of ₹1 hides nothing useful. A tolerance of ₹100 hides a missing line.
 * A tolerance of ₹1,000 hides a missing invoice — and a tolerance wide
 * enough to hide a missing invoice IS a tolerance that hides missing
 * invoices, on the day it matters, silently.
 *
 * Three rules, all enforced below rather than written in a doc:
 *
 *   • Every check must STATE its tolerance. There is no default. A
 *     caller that has not thought about it cannot accidentally inherit
 *     somebody else's.
 *   • The tolerance is capped at `TOLERANCE_CEILING_MINOR` — 99 paise.
 *     Under one rupee, always. A tolerance at or above the cap is
 *     REFUSED: the check is evaluated at zero instead and the report is
 *     marked faulted, so widening the band cannot quietly make a red
 *     screen go green.
 *   • The right tolerance for a check whose two sides are sums of the
 *     same `bigint` paise with no division between them is `EXACT` —
 *     zero. Both AR checks in this batch are of that shape, so both are
 *     exact, and that fact is asserted in the tests rather than trusted.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 ④ AN UNCONFIGURED WORKSPACE IS NOT A PASS
 * ══════════════════════════════════════════════════════════════════════
 * On the first run of a new workspace nothing is mapped: there is no
 * receivables control account, no journal entries, and no invoices. Both
 * sides of every check are zero, `0n === 0n`, and a naive gate renders a
 * green tick over a workspace where nothing has ever been checked
 * against anything.
 *
 * ⚠️ THAT IS THE SAME FAILURE `cash-flow.ts` CALLS OUT FOR AN EMPTY CASH
 * LEDGER SET — "the page would render a complete, balanced, internally
 * consistent statement saying the company holds no money". Zero equals
 * zero is not evidence. It is the ABSENCE of evidence wearing evidence's
 * clothes.
 *
 * So `unconfigured` is a THIRD state, distinct from both, and the caller
 * must be able to tell it apart from a pass. `verified` is false in that
 * state and the UI says so in words.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 AND HERE IS WHERE THIS DEPARTS FROM THE CASH FLOW PRECEDENT, ON
 *      PURPOSE — READ THIS BEFORE "FIXING" IT
 * ══════════════════════════════════════════════════════════════════════
 * `buildCashFlow` treats a missing cash ledger as `usable === false` and
 * the statement is withheld entirely. That is right THERE and wrong
 * HERE, and the difference is what the report is made of.
 *
 *   • A cash flow statement is a statement ABOUT the cash ledgers. With
 *     no cash ledger there is no statement — the subject of the document
 *     does not exist. Withholding it is the only honest option.
 *
 *   • An ageing report is a statement about DEMAND NOTICES, which are
 *     primary documents that exist whether or not anybody has mapped a
 *     chart of accounts. The ledger is the CHECK, not the subject.
 *     Withholding the ageing report from every tenant who has not
 *     configured accounting would take away the only receivables view
 *     they have, in service of a check that was never available to them
 *     — and it is exactly the failure mode `server/accounting/
 *     post-sales.ts` already refused when it decided that "posting never
 *     blocks issuing".
 *
 * 🔴 SO: `renderable` and `verified` ARE TWO DIFFERENT FLAGS, and the
 * distinction is the whole reason this type has two booleans instead of
 * one `usable`.
 *
 *     state          renderable   verified
 *     ───────────────────────────────────────────────────────────────
 *     reconciled     true         true      figures, checked
 *     unconfigured   true         FALSE     figures, explicitly UNCHECKED
 *     breached       FALSE        false     no figures at all
 *
 * An UNCHECKED number and a number that FAILED its check are different
 * facts about the world and must not look the same on a screen. The
 * first says "nobody has verified this"; the second says "somebody
 * verified this and it is wrong". Collapsing them into one amber banner
 * is how the second gets treated like the first.
 */

/**
 * ⚠️ ONE MONEY FORMATTER FOR THE WHOLE PRODUCT, IMPORTED RATHER THAN
 * REIMPLEMENTED. Indian digit grouping is 2,2,3 and a second
 * implementation of it is how two screens end up disagreeing about where
 * the commas go in the same figure — on the two screens a reader is
 * comparing when they are already suspicious. `formatRupees` is pure and
 * isomorphic and takes `bigint` paise, which is exactly this module's
 * currency.
 */
import { formatRupees } from "@/lib/receivables/numbers";

/* ------------------------------------------------------------------ */
/* TOLERANCE                                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 THE HARD CEILING ON ANY TOLERANCE: 99 paise. One rupee is refused.
 *
 * ⚠️ IT IS A CONSTANT AND NOT A PARAMETER, DELIBERATELY. Every widening
 * of a reconciliation tolerance in the history of accounting software
 * began as a one-line change to make a red screen go green before a
 * board meeting. Making the cap a parameter puts that one-line change
 * back on the table; making it a constant means the change has to be
 * made HERE, in a file whose header explains what it costs, and reviewed
 * by somebody reading this paragraph.
 *
 * The smallest thing worth finding is a line on an invoice, and the
 * smallest of those in Indian practice is worth more than a rupee. A
 * band below one rupee therefore cannot conceal any missing document —
 * only the residue of a division.
 */
export const TOLERANCE_CEILING_MINOR = 100n;

/**
 * The tolerance for a check whose two sides are sums of the same integer
 * paise with no division anywhere between them. Zero. Both receivables
 * checks in this batch are of that shape.
 *
 * ⚠️ "EXACT" IS A STATED TOLERANCE, NOT AN ABSENT ONE. Writing `EXACT`
 * at a call site is a claim — "I have looked at both sides of this
 * comparison and neither one divides" — and it is a claim somebody can
 * disagree with in review. That is the point of requiring the field.
 */
export const EXACT = 0n;

/**
 * The tolerance for a check where exactly one side truncates a division
 * per row — a pro-rata split, an interest accrual carried to the paisa.
 * One paisa. Nothing in this batch uses it; it exists so that the first
 * report that genuinely needs a band has a stated one to reach for
 * instead of inventing ₹10.
 *
 * ⚠️ IT DOES NOT SCALE WITH ROW COUNT, AND THAT IS THE DECISION. "One
 * paisa per row" over fifty thousand rows is a ₹500 band, which is a
 * missing line item. A report whose per-row residue genuinely
 * accumulates has a design problem — it should carry its remainder, the
 * way `splitAcrossLegs` already does — and the right response is to fix
 * the split, not to widen the gate until the symptom disappears.
 */
export const ONE_PAISA = 1n;

/* ------------------------------------------------------------------ */
/* WHAT A CHECK IS                                                     */
/* ------------------------------------------------------------------ */

/**
 * One side of a comparison: an amount, what to call it on screen, and
 * where it came from.
 */
export type ReconciliationSide = {
  /**
   * What a reader calls this figure. Goes into the breach sentence
   * verbatim, so it must read as a noun phrase in the middle of one:
   * "AR ageing", "the receivables control account".
   */
  label: string;
  /**
   * 🔴 WHERE THE FIGURE CAME FROM — the table or query, not the label.
   * Two sides of one check quoting the same source is a fault, because
   * such a check proves only that the query is deterministic. See ① in
   * the header.
   */
  source: string;
  amountMinor: bigint;
};

export type ReconciliationCheckInput = {
  /** Stable id, so a UI can key off it and a test can name it. */
  id: string;
  /**
   * What this check ASSERTS, as a sentence a non-programmer can judge.
   * Shown beside a breach, because the reader's first question is not
   * "how big is the gap" but "what were you comparing".
   */
  claim: string;
  report: ReconciliationSide;
  ledger: ReconciliationSide;
  /**
   * 🔴 REQUIRED. No default — see ③ in the header. Use `EXACT` unless a
   * division genuinely happens on one side, and never anything at or
   * above `TOLERANCE_CEILING_MINOR`.
   */
  toleranceMinor: bigint;
  /**
   * 🔴 SET WHEN THE TWO FIGURES CANNOT MEANINGFULLY BE COMPARED AT ALL —
   * not "they disagree", but "subtracting one from the other would
   * produce a number that means nothing".
   *
   * ⚠️ THE CASE THIS EXISTS FOR IS A REPORT WHOSE TWO SIDES ARE ON
   * DIFFERENT CALENDARS. A back-dated ageing report shows TODAY'S
   * outstanding balances arranged into the buckets they would have been
   * in on the chosen date; the ledger side genuinely is the position on
   * that date. They can be equal by coincidence and unequal by
   * arithmetic that describes nothing.
   *
   * 🔴 SO THE CHECK BREACHES UNCONDITIONALLY AND THE DIFFERENCE IS
   * REPORTED AS ZERO. Publishing a gap here would send somebody hunting
   * for a transaction that does not exist, which is worse than saying
   * nothing — it is a false lead wearing a real one's clothes.
   *
   * ⚠️ AND IT GOES THROUGH THIS FUNCTION RATHER THAN BEING A SECOND
   * REFUSAL MECHANISM IN THE CALLER. One path to "no figures" is one
   * path somebody has to argue with to soften the rule.
   */
  notComparable?: string;
};

export type ReconciliationCheck = ReconciliationCheckInput & {
  /** `report − ledger`. Signed: which way round matters to the reader. */
  differenceMinor: bigint;
  breached: boolean;
  /**
   * The breach in one sentence, naming both figures and the gap. Empty
   * when the check passes — there is nothing to say about a check that
   * passed, and a "reconciled: difference ₹0.00" line is noise that
   * trains people to skim the ones that matter.
   */
  sentence: string;
};

export type ReconciliationState = "reconciled" | "unconfigured" | "breached";

export type ReconciliationInput = {
  /** The report being gated, named as the reader knows it. */
  subject: string;
  /**
   * 🔴 FALSE WHEN THERE IS NOTHING TO CHECK AGAINST — the control
   * account is not mapped, no ledger exists, the workspace has never
   * been invoiced. NOT "both sides happened to be zero". See ④.
   *
   * ⚠️ THE CALLER DECIDES THIS FROM STRUCTURE, NEVER FROM AN AMOUNT. A
   * gate that inferred "unconfigured" from `0n === 0n` would upgrade a
   * genuinely empty-and-correct workspace into an unchecked one, and —
   * far worse — would let a tenant whose control account balance is
   * coincidentally zero slip out of the checked state entirely.
   */
  ledgerConfigured: boolean;
  /**
   * Sentences explaining what is not configured, or which figures on the
   * report have no ledger counterpart at all. Shown in both the
   * unconfigured and the reconciled states — a figure nobody can check
   * stays uncheckable when the checkable ones pass.
   */
  notes?: readonly string[];
  checks: readonly ReconciliationCheckInput[];
};

export type Reconciliation = {
  subject: string;
  state: ReconciliationState;
  checks: ReconciliationCheck[];
  /** One sentence per failed check. Empty unless `state === "breached"`. */
  breaches: string[];
  notes: string[];
  /** 🔴 May the report's figures be shown at all? False only on breach. */
  renderable: boolean;
  /** 🔴 Has a second, independent source actually agreed? See ④. */
  verified: boolean;
};

/* ------------------------------------------------------------------ */
/* THE GATE                                                            */
/* ------------------------------------------------------------------ */

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * The breach, in one sentence somebody can act on. See ② in the header.
 *
 * ⚠️ BOTH FIGURES AND THE DIFFERENCE, ALWAYS. The difference alone is
 * not enough — a reader who does not know which of the two numbers is
 * the larger cannot tell whether the report is overstating or the books
 * are, and those send them to opposite ends of the problem.
 */
export function describeBreach(check: ReconciliationCheck): string {
  const gap = abs(check.differenceMinor);
  const direction =
    check.differenceMinor > 0n
      ? `${check.report.label} is higher by`
      : `${check.ledger.label} is higher by`;

  return (
    `${check.report.label} says ${formatRupees(check.report.amountMinor)}, ` +
    `${check.ledger.label} says ${formatRupees(check.ledger.amountMinor)} — ` +
    `${direction} ${formatRupees(gap)}.`
  );
}

/**
 * ⭐⭐⭐ RUN THE GATE.
 *
 * ⚠️ THIS FUNCTION NEVER THROWS. It is called from the read path of a
 * report, and an exception there becomes "something went wrong" — which
 * is indistinguishable to the reader from an outage and carries none of
 * the information a breach is supposed to carry. Every fault it can
 * detect, including faults in its own inputs, comes back as a breach
 * with a sentence attached.
 */
export function reconcile(input: ReconciliationInput): Reconciliation {
  const notes = [...(input.notes ?? [])];
  const checks: ReconciliationCheck[] = [];
  const breaches: string[] = [];

  for (const raw of input.checks) {
    /**
     * 🔴 AN ILLEGAL TOLERANCE IS REFUSED AND THE CHECK RUNS AT ZERO.
     *
     * ⚠️ THE FAIL-SAFE DIRECTION IS THE STRICT ONE. Honouring a ₹500
     * band while grumbling about it in a note would let the widening
     * work — the screen goes green and the note is below the fold.
     * Ignoring it means an over-wide tolerance makes the gate MORE
     * likely to fire, which is the direction that gets noticed and
     * fixed. A negative tolerance is treated the same way; it is a
     * typo, and honouring it would fail every check including the ones
     * that agree exactly.
     */
    const illegalTolerance =
      raw.toleranceMinor < 0n || raw.toleranceMinor >= TOLERANCE_CEILING_MINOR;
    const tolerance = illegalTolerance ? 0n : raw.toleranceMinor;

    /**
     * 🔴 THE INDEPENDENCE GUARD. See ① in the header. Two sides quoting
     * one source is not a reconciliation, and the safe reading of "we
     * cannot tell whether this check is real" is that it failed.
     */
    const sameSource = raw.report.source === raw.ledger.source;

    /**
     * 🔴 AN INCOMPARABLE CHECK IS NEVER DIFFERENCED. See `notComparable`
     * on the input type: a gap between two figures on different
     * calendars is a number that means nothing, and printing it sends
     * somebody hunting for a transaction that does not exist.
     */
    const incomparable = typeof raw.notComparable === "string";
    const differenceMinor = incomparable
      ? 0n
      : raw.report.amountMinor - raw.ledger.amountMinor;
    const outsideTolerance = !incomparable && abs(differenceMinor) > tolerance;
    const breached =
      incomparable || outsideTolerance || sameSource || illegalTolerance;

    const check: ReconciliationCheck = {
      ...raw,
      toleranceMinor: tolerance,
      differenceMinor,
      breached,
      sentence: "",
    };

    if (breached) {
      const parts: string[] = [];
      if (incomparable) parts.push(raw.notComparable as string);
      if (outsideTolerance) parts.push(describeBreach(check));
      if (sameSource) {
        parts.push(
          `This check could not be trusted: both figures were read from ` +
            `"${raw.report.source}", so it compares a number with itself and ` +
            `proves nothing. It is reported as a failure because a check that ` +
            `cannot verify anything must never render like one that did.`,
        );
      }
      if (illegalTolerance) {
        parts.push(
          `The rounding tolerance set for this check ` +
            `(${formatRupees(raw.toleranceMinor)}) is outside the permitted range of ` +
            `zero to ${formatRupees(TOLERANCE_CEILING_MINOR - 1n)}, so it was ignored and ` +
            `the figures were compared exactly. A tolerance wide enough to hide a ` +
            `missing invoice is a tolerance that hides missing invoices.`,
        );
      }
      check.sentence = parts.join(" ");
      breaches.push(`${raw.claim} ${check.sentence}`);
    }

    checks.push(check);
  }

  if (breaches.length > 0) {
    return {
      subject: input.subject,
      state: "breached",
      checks,
      breaches,
      notes,
      renderable: false,
      verified: false,
    };
  }

  /**
   * 🔴 THE UNCONFIGURED TEST RUNS **AFTER** THE CHECKS, NOT BEFORE, AND
   * THE ORDER IS LOAD-BEARING.
   *
   * ⚠️ A workspace can be missing its control account AND have a report
   * total that disagrees with something else that IS configured. Testing
   * `ledgerConfigured` first would return early and swallow that breach
   * under a mild "not configured yet" notice — the softest possible
   * presentation of the loudest possible fact. A breach outranks a
   * missing configuration every time.
   */
  if (!input.ledgerConfigured) {
    return {
      subject: input.subject,
      state: "unconfigured",
      checks,
      breaches: [],
      notes,
      // Figures still show: they come from the primary documents, and the
      // ledger is the check rather than the subject. See the header.
      renderable: true,
      // 🔴 But nothing has checked them. Not a green tick.
      verified: false,
    };
  }

  return {
    subject: input.subject,
    state: "reconciled",
    checks,
    breaches: [],
    notes,
    renderable: true,
    verified: true,
  };
}

/* ------------------------------------------------------------------ */
/* CROSSING TO THE CLIENT                                              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `JSON.stringify` THROWS ON A BIGINT, and every amount in here is
 * one. A `Reconciliation` returned raw from a server action crashes the
 * RSC boundary at runtime — on the screen that renders money, which is
 * the screen this whole module exists to protect.
 *
 * ⭐ AND IT IS SERIALISED HERE RATHER THAN IN EACH ACTION so that every
 * gated screen receives the SAME shape and can share one banner
 * component. Two screens with two shapes is two banners, and the second
 * one is where the rule gets softened.
 */
export type SerializedReconciliationCheck = {
  id: string;
  claim: string;
  reportLabel: string;
  reportMinor: string;
  ledgerLabel: string;
  ledgerMinor: string;
  differenceMinor: string;
  toleranceMinor: string;
  breached: boolean;
  sentence: string;
};

export type SerializedReconciliation = {
  subject: string;
  state: ReconciliationState;
  checks: SerializedReconciliationCheck[];
  breaches: string[];
  notes: string[];
  renderable: boolean;
  verified: boolean;
};

export function serializeReconciliation(r: Reconciliation): SerializedReconciliation {
  return {
    subject: r.subject,
    state: r.state,
    breaches: r.breaches,
    notes: r.notes,
    renderable: r.renderable,
    verified: r.verified,
    checks: r.checks.map((c) => ({
      id: c.id,
      claim: c.claim,
      reportLabel: c.report.label,
      reportMinor: c.report.amountMinor.toString(),
      ledgerLabel: c.ledger.label,
      ledgerMinor: c.ledger.amountMinor.toString(),
      differenceMinor: c.differenceMinor.toString(),
      toleranceMinor: c.toleranceMinor.toString(),
      breached: c.breached,
      sentence: c.sentence,
    })),
  };
}
