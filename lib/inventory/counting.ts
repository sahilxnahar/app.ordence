/**
 * Ordence — ⭐⭐⭐ THE STOCK COUNT
 * Version: v1.18.0-alpha
 *
 * Pure. No clock, no network, no database. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE COUNTER MUST NOT BE SHOWN THE EXPECTED QUANTITY
 * ══════════════════════════════════════════════════════════════════════
 * This is the entire control, and everything else in this file is
 * detail. A count sheet printed with the system figure already on it is
 * not a count. It is a confirmation exercise, and people confirm.
 *
 * ⚠️ THE FAILURE IS NOT LAZINESS, IT IS ARITHMETIC. Somebody counting
 * 240 boxes on a high shelf, holding a sheet that says 244, will count
 * again and find 244. The number on the paper is a hypothesis, and human
 * beings are extremely good at confirming hypotheses. Every stocktaking
 * standard worth the name calls this a blind count for that reason.
 *
 * ⭐ 0029 ALREADY MADE IT POSSIBLE. `expected_quantity` is snapshotted
 * into the line separately from `counted_quantity`, and the schema's own
 * comment explains why the expected figure is frozen rather than read
 * live. What was missing was anything that refused to hand the expected
 * figure to the person doing the counting. `sheetFor` is that refusal,
 * and it is a type, not a convention.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE COUNT THAT FINDS NOTHING IS THE SUSPICIOUS ONE
 * ══════════════════════════════════════════════════════════════════════
 * A warehouse of four hundred lines that comes back exactly right has
 * almost certainly been copied off the system rather than walked. Real
 * counts find small discrepancies everywhere: miscounts, unrecorded
 * samples, a broken box nobody wrote up.
 *
 * 🔴 SO A ZERO-VARIANCE COUNT IS REPORTED, NOT CELEBRATED. `assessCount`
 * says so in words. It does not block the posting, because a genuinely
 * clean count on eight lines is perfectly ordinary and refusing it would
 * teach people to add a fake variance.
 */

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 QUANTITIES ARE STRINGS, NOT NUMBERS, AND THIS IS DELIBERATE.
 *
 * ⚠️ `numeric(18,3)` in PostgreSQL does not fit in a double. 0.1 + 0.2
 * is not 0.3 in IEEE 754, and a warehouse dealing in kilograms to three
 * places will accumulate a drift that shows up as a permanent phantom
 * variance nobody can explain. Everything here works in integer
 * thousandths and converts at the edges.
 */
export type Quantity = string;

/** Thousandths of a unit, as a bigint. The internal representation. */
export type Milliunits = bigint;

export function toMilliunits(q: Quantity): Milliunits {
  const trimmed = q.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(trimmed)) {
    throw new Error(
      `A quantity must be a number with at most three decimal places. Got "${q}".`,
    );
  }
  const negative = trimmed.startsWith("-");
  const bare = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = bare.split(".");
  const padded = (fraction + "000").slice(0, 3);
  const value = BigInt(whole) * 1000n + BigInt(padded);
  return negative ? -value : value;
}

export function fromMilliunits(m: Milliunits): Quantity {
  const negative = m < 0n;
  const abs = negative ? -m : m;
  const whole = abs / 1000n;
  const fraction = (abs % 1000n).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/* ------------------------------------------------------------------ */
/* THE SHEET                                                           */
/* ------------------------------------------------------------------ */

/** What the database holds for one line. Never sent to a counter whole. */
export interface CountLine {
  readonly lineId: string;
  readonly stockItemId: string;
  readonly itemName: string;
  readonly itemCode: string;
  readonly batchNo: string | null;
  readonly uom: string;
  /** 🔴 THE SYSTEM FIGURE. Frozen when counting opened. */
  readonly expectedQuantity: Quantity;
  /** Null until somebody walks the aisle. */
  readonly countedQuantity: Quantity | null;
  readonly varianceNote: string | null;
  /** Minor units per single unit, for valuing the variance. */
  readonly unitCostMinor: bigint;
}

/**
 * ⭐⭐ WHAT A COUNTER IS ALLOWED TO SEE, AS A TYPE.
 *
 * 🔴 THERE IS NO `expectedQuantity` ON THIS INTERFACE AND THERE MUST
 * NEVER BE ONE. If a future screen needs it, that screen is the review
 * screen and it uses `CountLine`. Adding the field here to save a
 * round trip would quietly convert every count in the system into a
 * confirmation exercise, and nothing would report it: the variances
 * would simply go to zero and look like an improvement.
 */
export interface BlindSheetLine {
  readonly lineId: string;
  readonly itemName: string;
  readonly itemCode: string;
  readonly batchNo: string | null;
  readonly uom: string;
  readonly countedQuantity: Quantity | null;
}

/** Strip a line down to what may cross to the person counting. */
export function sheetFor(lines: readonly CountLine[]): readonly BlindSheetLine[] {
  return lines.map((l) => ({
    lineId: l.lineId,
    itemName: l.itemName,
    itemCode: l.itemCode,
    batchNo: l.batchNo,
    uom: l.uom,
    countedQuantity: l.countedQuantity,
  }));
}

/* ------------------------------------------------------------------ */
/* THE VARIANCE                                                        */
/* ------------------------------------------------------------------ */

export interface LineVariance {
  readonly lineId: string;
  readonly stockItemId: string;
  readonly itemName: string;
  readonly batchNo: string | null;
  readonly expected: Quantity;
  readonly counted: Quantity;
  /** ⚠️ Positive means MORE on the shelf than the system thought. */
  readonly differenceQuantity: Quantity;
  /** Positive means the business is richer than the books said. */
  readonly differenceValueMinor: bigint;
  readonly severity: VarianceSeverity;
  readonly needsNote: boolean;
  readonly hasNote: boolean;
}

/**
 * ⚠️ SEVERITY IS BY VALUE, NOT BY PERCENTAGE, AND THAT IS THE WHOLE
 * POINT.
 *
 * 🔴 A 5% variance on washers is a rounding error. A 5% variance on
 * bearings is a month's profit. Ranking a count by percentage puts the
 * screws at the top of the list and buries the thing worth
 * investigating, which is exactly what a busy person will act on.
 */
export type VarianceSeverity = "none" | "minor" | "notable" | "serious";

/**
 * ⭐ THE BANDS, IN MINOR UNITS, AS DATA.
 *
 * ⚠️ These are Ordence's opening defaults, not a law of accounting. A
 * jeweller and a hardware shop need different numbers, and when somebody
 * asks for that this becomes a column on the warehouse rather than a
 * bigger `if`.
 */
export const SEVERITY_BANDS = Object.freeze({
  /** Below this, worth recording and not worth anybody's morning. */
  minorBelowMinor: 100_000n,
  /** Below this, a supervisor looks. Above it, somebody investigates. */
  notableBelowMinor: 1_000_000n,
}) satisfies Readonly<Record<string, bigint>>;

/**
 * 🔴 A NOTE IS DEMANDED FOR ANY NON-ZERO VARIANCE, however small.
 *
 * ⚠️ The tempting rule is "a note above the minor band", and it is
 * wrong. The small unexplained differences are the ones that turn out,
 * a year later, to have been the same person taking the same thing every
 * week. A variance nobody had to write a sentence about is a variance
 * nobody looked at.
 */
export function varianceOf(line: CountLine, now: Date): LineVariance | null {
  void now;
  if (line.countedQuantity === null) return null;

  const expected = toMilliunits(line.expectedQuantity);
  const counted = toMilliunits(line.countedQuantity);
  const difference = counted - expected;

  // ⚠️ Value in minor units: (milliunits ÷ 1000) × unit cost, done as
  // integers throughout. Dividing last keeps the rounding in one place.
  const valueMinor = (difference * line.unitCostMinor) / 1000n;
  const magnitude = valueMinor < 0n ? -valueMinor : valueMinor;

  let severity: VarianceSeverity = "none";
  if (difference !== 0n) {
    severity =
      magnitude < SEVERITY_BANDS.minorBelowMinor
        ? "minor"
        : magnitude < SEVERITY_BANDS.notableBelowMinor
          ? "notable"
          : "serious";
  }

  return {
    lineId: line.lineId,
    stockItemId: line.stockItemId,
    itemName: line.itemName,
    batchNo: line.batchNo,
    expected: line.expectedQuantity,
    counted: line.countedQuantity,
    differenceQuantity: fromMilliunits(difference),
    differenceValueMinor: valueMinor,
    severity,
    needsNote: difference !== 0n,
    hasNote: (line.varianceNote ?? "").trim().length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* THE VERDICT                                                         */
/* ------------------------------------------------------------------ */

export interface CountAssessment {
  readonly countedLines: number;
  readonly uncountedLines: number;
  readonly variances: readonly LineVariance[];
  /** Net effect on the value of stock. Negative means the books were high. */
  readonly netValueMinor: bigint;
  /** ⚠️ Gains and losses are shown apart. See below. */
  readonly gainValueMinor: bigint;
  readonly lossValueMinor: bigint;
  /** Reasons the count may not be posted yet. Empty means it may. */
  readonly blockers: readonly string[];
  /** Things worth saying that do not block anything. */
  readonly remarks: readonly string[];
  readonly mayPost: boolean;
}

/**
 * 🔴🔴 GAINS AND LOSSES ARE NEVER NETTED FOR THE PURPOSE OF JUDGEMENT.
 *
 * ⚠️ A count that finds ₹4 lakh missing and ₹4 lakh extra nets to zero
 * and looks like a clean month. It is not a clean month. It is either
 * two large errors or a mis-picking problem moving stock between codes,
 * and the netted figure hides both. The net matters for the ledger; the
 * two halves matter for the person reading it.
 */
export function assessCount(
  lines: readonly CountLine[],
  now: Date,
): CountAssessment {
  const variances: LineVariance[] = [];
  let counted = 0;
  let uncounted = 0;
  let gain = 0n;
  let loss = 0n;

  for (const line of lines) {
    const v = varianceOf(line, now);
    if (v === null) {
      uncounted += 1;
      continue;
    }
    counted += 1;
    if (v.differenceValueMinor > 0n) gain += v.differenceValueMinor;
    if (v.differenceValueMinor < 0n) loss += -v.differenceValueMinor;
    if (v.severity !== "none" || v.needsNote) variances.push(v);
  }

  const blockers: string[] = [];
  const remarks: string[] = [];

  if (counted === 0) {
    blockers.push("Nothing has been counted yet.");
  }

  // 🔴 AN UNCOUNTED LINE IS NOT A ZERO. Treating a blank as "we found
  // none" would write off the entire holding of every item somebody did
  // not reach, which on a partial count is most of the warehouse.
  if (uncounted > 0) {
    blockers.push(
      `${uncounted} line${uncounted === 1 ? " has" : "s have"} not been counted. A blank is not the same as finding none, so the count cannot be posted until each one is either counted or removed from the sheet.`,
    );
  }

  const missingNotes = variances.filter((v) => v.needsNote && !v.hasNote);
  if (missingNotes.length > 0) {
    blockers.push(
      `${missingNotes.length} line${missingNotes.length === 1 ? "" : "s"} differ from the system and have no explanation written against them. Every difference needs a sentence, however small: the unexplained small ones are the ones that turn out to matter.`,
    );
  }

  if (counted > 0 && variances.length === 0) {
    // ⚠️ A remark, not a blocker. See the file header.
    remarks.push(
      counted >= 25
        ? `Every one of ${counted} lines matched exactly. On a sheet this size that is unusual enough to be worth a second look at how the counting was done.`
        : "Every line matched exactly.",
    );
  }

  const serious = variances.filter((v) => v.severity === "serious");
  if (serious.length > 0) {
    remarks.push(
      `${serious.length} line${serious.length === 1 ? "" : "s"} differ by more than the value of a serious variance. These are ranked by value rather than percentage, because a large percentage of something cheap is not the problem.`,
    );
  }

  if (gain > 0n && loss > 0n) {
    remarks.push(
      "This count found stock both missing and extra. The two are shown separately on purpose: offsetting quantities usually mean picking against the wrong code rather than a quiet month, and the net figure hides that entirely.",
    );
  }

  return {
    countedLines: counted,
    uncountedLines: uncounted,
    variances: [...variances].sort(compareBySeverity),
    netValueMinor: gain - loss,
    gainValueMinor: gain,
    lossValueMinor: loss,
    blockers,
    remarks,
    mayPost: blockers.length === 0,
  };
}

/** Worst first, then largest by value. What a person should read top down. */
function compareBySeverity(a: LineVariance, b: LineVariance): number {
  const rank: Record<VarianceSeverity, number> = {
    serious: 0,
    notable: 1,
    minor: 2,
    none: 3,
  };
  if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
  const av = a.differenceValueMinor < 0n ? -a.differenceValueMinor : a.differenceValueMinor;
  const bv = b.differenceValueMinor < 0n ? -b.differenceValueMinor : b.differenceValueMinor;
  return bv > av ? 1 : bv < av ? -1 : 0;
}

/* ------------------------------------------------------------------ */
/* WHAT THE POSTING LOOKS LIKE                                         */
/* ------------------------------------------------------------------ */

export interface AdjustmentMovement {
  readonly stockItemId: string;
  readonly batchNo: string | null;
  /** ⚠️ Signed. 0029 stores signed quantities on purpose; see its header. */
  readonly quantity: Quantity;
  readonly unitCostMinor: bigint;
  readonly note: string;
}

/**
 * ⭐ THE MOVEMENTS A POSTED COUNT WRITES.
 *
 * 🔴 A COUNT NEVER OVERWRITES A BALANCE. It writes the difference as
 * movements, exactly like a receipt or a dispatch, and the balance
 * follows from the movements as it always has. Setting the balance
 * directly would produce a stock ledger that does not add up to the
 * stock figure, and every question asked afterwards would have two
 * answers.
 *
 * ⚠️ ZERO-VARIANCE LINES PRODUCE NO MOVEMENT. A movement of zero is a
 * row that means nothing and has to be filtered out of every report
 * written from then on.
 */
export function movementsFor(
  assessment: CountAssessment,
  lines: readonly CountLine[],
): readonly AdjustmentMovement[] {
  const byId = new Map(lines.map((l) => [l.lineId, l]));
  const out: AdjustmentMovement[] = [];

  for (const v of assessment.variances) {
    if (toMilliunits(v.differenceQuantity) === 0n) continue;
    const line = byId.get(v.lineId);
    if (!line) continue;
    out.push({
      stockItemId: v.stockItemId,
      batchNo: v.batchNo,
      quantity: v.differenceQuantity,
      unitCostMinor: line.unitCostMinor,
      note: (line.varianceNote ?? "").trim(),
    });
  }

  return out;
}

/**
 * ⭐⭐ THE TWO LEDGER ROLES A COUNT NEEDS, AND WHY THEY ARE TWO.
 *
 * ⚠️ Posting both directions to one "stock adjustment" account nets them
 * off in the trial balance, and the year-end question "how much stock did
 * we lose" then has no answer anywhere in the system. An auditor asks
 * that question. So a gain and a loss go to different places even though
 * the arithmetic would work either way.
 */
export const POSTING_ROLES = Object.freeze({
  gain: "inventory_variance_gain",
  loss: "inventory_variance_loss",
  stock: "inventory_asset",
} as const);
