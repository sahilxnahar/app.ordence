/**
 * Ordence — ⭐⭐⭐ WHEN IS THIS CUSTOMER DUE TO ORDER AGAIN
 * Version: v1.16.0-alpha
 *
 * Pure. `today` is always an argument. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE FAILURE MODE OF EVERY PREDICTION FEATURE IS CONFIDENCE
 * ══════════════════════════════════════════════════════════════════════
 * It predicts for everybody, because a list with names on it looks like a
 * working feature. The salesman rings four people who were not due, gets
 * four polite refusals, and stops opening the screen. After that the
 * feature is worse than nothing: it occupies the place where a real one
 * would go, and nobody will try again for two years.
 *
 * ⭐ SO THIS FILE REFUSES TO PREDICT MORE OFTEN THAN IT PREDICTS. Fewer
 * than four orders is not a pattern. A customer whose gaps swing from ten
 * days to ninety has no rhythm to find, and saying so is the honest and
 * more useful answer.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ AND THE MOST VALUABLE SIGNAL IS NOT "LIKELY TO ORDER TODAY"
 * ══════════════════════════════════════════════════════════════════════
 * It is "this one has stopped".
 *
 * 🔴 A customer who ordered every month for two years and has not
 * ordered for seven weeks has almost certainly gone somewhere else, and
 * nobody has noticed, because nothing in an ERP reports an absence. Sales
 * reports show what happened. They cannot show what did not.
 *
 * ⚠️ The nudge is worth a call. The silence is worth the account.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 MEDIAN, NOT MEAN. EVERYWHERE.
 * ══════════════════════════════════════════════════════════════════════
 * One bulk order before a price rise, or one gap over a factory
 * shutdown, drags a mean far enough to make every prediction wrong.
 *
 * ⭐ The spread is measured the same way, as the MEDIAN ABSOLUTE
 * DEVIATION rather than a standard deviation, because a standard
 * deviation is dragged by exactly the outliers a median was chosen to
 * survive. Using a robust centre with a fragile spread is the mistake
 * that makes a model look stable and behave erratically.
 */

/* ------------------------------------------------------------------ */
/* VOCABULARY                                                          */
/* ------------------------------------------------------------------ */

export type RhythmVerdict =
  /** ⭐ A usable rhythm. */
  | "regular"
  /** ⚠️ Orders, but no rhythm worth acting on. */
  | "irregular"
  /** 🔴 Not enough history to say anything. */
  | "too_few_orders"
  /** ⚠️ A rhythm that existed and has been abandoned. */
  | "lapsed"
  /** ⭐ One order, ever. A different kind of customer entirely. */
  | "one_off";

export type SignalKind =
  /** ⭐ Due about now. The nudge the owner asked for. */
  | "due_now"
  /** ⚠️ Due within the next few days. */
  | "due_soon"
  /** 🔴 Overdue against their own rhythm. The one that matters. */
  | "overdue"
  /** 🔴🔴 Gone. Long past any reasonable reading of their pattern. */
  | "lapsed";

export interface Rhythm {
  readonly verdict: RhythmVerdict;
  /** Days between orders, as a median. Null where there is no rhythm. */
  readonly medianGapDays: number | null;
  /** ⭐ Robust spread. Small means predictable. */
  readonly madDays: number | null;
  readonly orderCount: number;
  readonly firstOrderOn: string | null;
  readonly lastOrderOn: string | null;
  readonly daysSinceLastOrder: number | null;
  /** Null unless the verdict is `regular`. */
  readonly expectedNextOn: string | null;
  /** ⚠️ How wide the window around that date honestly is. */
  readonly windowDays: number | null;
  /** 0..100. See `confidenceOf` — it is deliberately hard to get high. */
  readonly confidence: number;
  /**
   * ⭐ THE SENTENCE A SALESMAN CAN ACT ON. Not a score.
   *
   * "They have ordered every 28 to 34 days for the last nine months" is
   * something somebody can decide about. "0.82" is not.
   */
  readonly explanation: string;
  /** ⚠️ Whether their gaps are getting longer. See `driftOf`. */
  readonly drift: "steady" | "slowing" | "quickening" | "unknown";
}

/* ------------------------------------------------------------------ */
/* THE THRESHOLDS, AND WHY EACH ONE IS WHERE IT IS                     */
/* ------------------------------------------------------------------ */

/**
 * 🔴 FOUR ORDERS, WHICH IS THREE GAPS.
 *
 * ⚠️ Two orders is one gap and one gap is not a pattern, it is a
 * coincidence. Three orders is two gaps, and a median of two numbers is
 * their mean, which defeats the entire reason for using a median.
 *
 * ⭐ Three gaps is the first point at which a median is a median.
 */
export const MIN_ORDERS_FOR_RHYTHM = 4;

/**
 * ⚠️ IF THE TYPICAL SWING IS MORE THAN HALF THE TYPICAL GAP, THERE IS
 * NO RHYTHM.
 *
 * A customer ordering every 30 days give or take 5 is predictable. Every
 * 30 days give or take 20 is a customer who orders when they run out,
 * and pretending otherwise produces a call list of guesses.
 */
export const MAX_RELATIVE_SPREAD = 0.5;

/**
 * 🔴 THREE TIMES THEIR OWN GAP AND THEY ARE GONE, not ours.
 *
 * ⚠️ A fixed "90 days" is wrong in both directions: it is far too
 * patient for somebody who orders weekly, and far too twitchy for
 * somebody who orders each quarter. The only sensible measure of late is
 * late *for them*.
 */
export const LAPSED_MULTIPLE = 3;

/** How close to the expected date counts as "now". */
export const DUE_NOW_DAYS = 2;
/** And how far ahead is worth putting on a list at all. */
export const DUE_SOON_DAYS = 7;

/* ------------------------------------------------------------------ */
/* ARITHMETIC                                                          */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** Whole days between two civil dates. Both are `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

export function addDays(day: string, days: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1] ?? 0;
  const hi = sorted[mid] ?? 0;
  return (lo + hi) / 2;
}

/**
 * ⭐ MEDIAN ABSOLUTE DEVIATION. The robust spread.
 *
 * 🔴 A standard deviation is dragged by exactly the outliers a median
 * was chosen to survive. Pairing a robust centre with a fragile spread
 * is what makes a model look stable and behave erratically.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

/* ------------------------------------------------------------------ */
/* THE RHYTHM                                                          */
/* ------------------------------------------------------------------ */

/**
 * `orderDates` are civil dates, `YYYY-MM-DD`, in any order. Duplicates
 * on one day are collapsed: two invoices raised the same morning are one
 * order for this purpose, and counting them twice invents a zero-day gap
 * that halves the median.
 */
export function detectRhythm(
  orderDates: readonly string[],
  today: string,
): Rhythm {
  const days = [...new Set(orderDates.filter(Boolean))].sort();
  const orderCount = days.length;

  const first = days[0] ?? null;
  const last = days[days.length - 1] ?? null;
  const sinceLast = last ? daysBetween(last, today) : null;

  const nothing = {
    medianGapDays: null,
    madDays: null,
    orderCount,
    firstOrderOn: first,
    lastOrderOn: last,
    daysSinceLastOrder: sinceLast,
    expectedNextOn: null,
    windowDays: null,
    confidence: 0,
    drift: "unknown" as const,
  };

  if (orderCount === 0) {
    return {
      ...nothing,
      verdict: "too_few_orders",
      explanation: "This customer has never ordered.",
    };
  }

  /**
   * ⭐ ONE ORDER IS NOT A BAD PATTERN. IT IS A DIFFERENT CUSTOMER.
   *
   * ⚠️ Worth saying separately, because "somebody who bought once and
   * never came back" is a real and actionable category, and burying it
   * in "not enough data" hides it.
   */
  if (orderCount === 1) {
    return {
      ...nothing,
      verdict: "one_off",
      explanation: `One order, on ${first}, and nothing since. Whether that is a customer who never came back or one who has not needed anything yet is worth a call rather than a guess.`,
    };
  }

  if (orderCount < MIN_ORDERS_FOR_RHYTHM) {
    return {
      ...nothing,
      verdict: "too_few_orders",
      explanation: `${orderCount} orders is not enough to see a pattern. ${MIN_ORDERS_FOR_RHYTHM} is the point at which the typical gap means anything, because ${MIN_ORDERS_FOR_RHYTHM - 1} gaps is the first time a middle value is a middle value.`,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i += 1) {
    gaps.push(daysBetween(days[i - 1] as string, days[i] as string));
  }

  const medianGap = median(gaps);
  const mad = medianAbsoluteDeviation(gaps);

  if (medianGap === null || mad === null || medianGap <= 0) {
    return {
      ...nothing,
      verdict: "irregular",
      explanation: "Their order dates do not produce a usable gap.",
    };
  }

  const relativeSpread = mad / medianGap;
  const drift = driftOf(gaps);

  /**
   * ⚠️ TOO ERRATIC TO PREDICT, AND THE EXPLANATION SAYS SO IN THEIR OWN
   * NUMBERS rather than in the language of statistics.
   */
  if (relativeSpread > MAX_RELATIVE_SPREAD) {
    return {
      ...nothing,
      verdict: "irregular",
      medianGapDays: Math.round(medianGap),
      madDays: Math.round(mad),
      drift,
      explanation: `${orderCount} orders, typically ${Math.round(medianGap)} days apart, but the gaps swing by about ${Math.round(mad)} days either way. That is too uneven to say when they are next due. They probably order when they run out rather than to a schedule.`,
    };
  }

  const expectedNextOn = addDays(last as string, Math.round(medianGap));
  const windowDays = Math.max(1, Math.round(mad));
  const confidence = confidenceOf({
    orderCount,
    relativeSpread,
    daysSinceLast: sinceLast ?? 0,
    medianGap,
  });

  /**
   * 🔴 LAPSED IS DECIDED AGAINST THEIR OWN GAP, NOT AGAINST A CALENDAR.
   *
   * ⚠️ A fixed 90 days is far too patient for a weekly customer and far
   * too twitchy for a quarterly one.
   */
  if (sinceLast !== null && sinceLast > medianGap * LAPSED_MULTIPLE) {
    return {
      verdict: "lapsed",
      medianGapDays: Math.round(medianGap),
      madDays: Math.round(mad),
      orderCount,
      firstOrderOn: first,
      lastOrderOn: last,
      daysSinceLastOrder: sinceLast,
      expectedNextOn: null,
      windowDays: null,
      confidence,
      drift,
      explanation: `They ordered ${orderCount} times, about every ${Math.round(medianGap)} days, and have not ordered for ${sinceLast} days. That is more than three times their own gap. This is the most valuable line on this screen: nothing else in an ERP reports a customer who has quietly stopped.`,
    };
  }

  const months = first ? Math.max(1, Math.round(daysBetween(first, today) / 30)) : 0;

  return {
    verdict: "regular",
    medianGapDays: Math.round(medianGap),
    madDays: Math.round(mad),
    orderCount,
    firstOrderOn: first,
    lastOrderOn: last,
    daysSinceLastOrder: sinceLast,
    expectedNextOn,
    windowDays,
    confidence,
    drift,
    explanation: `${orderCount} orders over about ${months} month${months === 1 ? "" : "s"}, every ${Math.round(medianGap) - windowDays} to ${Math.round(medianGap) + windowDays} days. Last order ${last}, so the next is due around ${expectedNextOn}.${drift === "slowing" ? " Their gaps have been getting longer, which is worth a look on its own." : drift === "quickening" ? " They have been ordering more often lately." : ""}`,
  };
}

/**
 * ⭐⭐ ARE THEIR GAPS GETTING LONGER?
 *
 * 🔴 A customer whose gap has gone from 30 days to 45 over a year is
 * leaving, slowly, and they will never appear on an overdue report
 * because they are never overdue. Each individual order is on time
 * against a rhythm that is itself decaying.
 *
 * ⚠️ Compared as the median of the older half against the median of the
 * newer half, so one bad quarter does not read as a trend.
 */
export function driftOf(gaps: readonly number[]): Rhythm["drift"] {
  if (gaps.length < 4) return "unknown";
  const mid = Math.floor(gaps.length / 2);
  const older = median(gaps.slice(0, mid));
  const newer = median(gaps.slice(mid));
  if (older === null || newer === null || older === 0) return "unknown";
  const change = (newer - older) / older;
  // ⚠️ A fifth either way. Below that is noise, and calling noise a
  // trend is how a report loses its reader.
  if (change > 0.2) return "slowing";
  if (change < -0.2) return "quickening";
  return "steady";
}

/**
 * 🔴 CONFIDENCE IS DELIBERATELY HARD TO GET HIGH.
 *
 * ⚠️ A number that reads 90% for everybody is a number nobody reads. The
 * ceiling here is reached only by a customer with a long, tight,
 * currently-on-track history — which is exactly the customer a salesman
 * would have named anyway, and that agreement is what makes the rest of
 * the list credible.
 */
export function confidenceOf(args: {
  readonly orderCount: number;
  readonly relativeSpread: number;
  readonly daysSinceLast: number;
  readonly medianGap: number;
}): number {
  // ⭐ History. Twelve orders is where this stops improving.
  const history = Math.min(1, (args.orderCount - MIN_ORDERS_FOR_RHYTHM + 1) / 9);

  // ⭐ Tightness. A spread of zero scores 1; half the gap scores 0.
  const tightness = Math.max(
    0,
    1 - args.relativeSpread / MAX_RELATIVE_SPREAD,
  );

  /**
   * ⚠️ FRESHNESS. A rhythm from a customer who last ordered four gaps
   * ago is a description of the past.
   */
  const freshness =
    args.medianGap <= 0
      ? 0
      : Math.max(0, 1 - args.daysSinceLast / (args.medianGap * LAPSED_MULTIPLE));

  // 🔴 MULTIPLIED, NOT AVERAGED. Any one of the three being poor should
  // sink the answer; an average lets two good numbers hide a fatal one.
  return Math.round(history * tightness * freshness * 100);
}

/* ------------------------------------------------------------------ */
/* THE SIGNAL                                                          */
/* ------------------------------------------------------------------ */

export interface Signal {
  readonly kind: SignalKind;
  readonly dueOn: string;
  readonly daysOut: number;
  readonly confidence: number;
  readonly headline: string;
  readonly detail: string;
  /** ⭐ `urgent` only for the ones that are actually urgent. */
  readonly priority: "urgent" | "high" | "normal";
}

/**
 * Turns a rhythm into something worth putting on somebody's day, or
 * nothing at all.
 *
 * 🔴 RETURNS NULL FAR MORE OFTEN THAN IT RETURNS A SIGNAL, and that is
 * the feature.
 */
export function signalFrom(
  rhythm: Rhythm,
  today: string,
  customerName: string,
  options: { readonly minConfidence?: number } = {},
): Signal | null {
  const minConfidence = options.minConfidence ?? 25;

  /**
   * 🔴🔴 THE LAPSED CUSTOMER IS REPORTED EVEN AT LOW CONFIDENCE, and it
   * is the only case that is.
   *
   * ⚠️ Confidence measures how well we can predict their NEXT order.
   * Somebody who has stopped has no next order to predict, so a low score
   * is expected and is not a reason to stay quiet. The evidence for
   * "they have gone" is the silence itself.
   */
  if (rhythm.verdict === "lapsed") {
    return {
      kind: "lapsed",
      dueOn: today,
      daysOut: 0,
      confidence: rhythm.confidence,
      headline: `${customerName} has stopped ordering`,
      detail: rhythm.explanation,
      priority: "urgent",
    };
  }

  if (rhythm.verdict !== "regular" || !rhythm.expectedNextOn) return null;
  if (rhythm.confidence < minConfidence) return null;

  const daysOut = daysBetween(today, rhythm.expectedNextOn);
  const window = rhythm.windowDays ?? 1;

  /**
   * 🔴 OVERDUE AGAINST THEIR OWN WINDOW. Not against the expected date:
   * a customer who varies by five days is not late on day one.
   */
  if (daysOut < -window) {
    return {
      kind: "overdue",
      dueOn: rhythm.expectedNextOn,
      daysOut,
      confidence: rhythm.confidence,
      headline: `${customerName} is ${Math.abs(daysOut)} days late`,
      detail: `${rhythm.explanation} They are now past the late end of their own window, which for this customer is unusual.`,
      priority: "high",
    };
  }

  if (Math.abs(daysOut) <= DUE_NOW_DAYS) {
    return {
      kind: "due_now",
      dueOn: rhythm.expectedNextOn,
      daysOut,
      confidence: rhythm.confidence,
      headline: `${customerName} is likely to order today`,
      detail: rhythm.explanation,
      priority: "high",
    };
  }

  if (daysOut > 0 && daysOut <= DUE_SOON_DAYS) {
    return {
      kind: "due_soon",
      dueOn: rhythm.expectedNextOn,
      daysOut,
      confidence: rhythm.confidence,
      headline: `${customerName} is due in ${daysOut} days`,
      detail: rhythm.explanation,
      priority: "normal",
    };
  }

  // ⚠️ Inside their window but not near either edge. Nothing to say.
  return null;
}

/**
 * ⭐ THE ORDER A CALL LIST SHOULD BE IN.
 *
 * 🔴 NOT BY CONFIDENCE. The most confident row is a customer who is
 * about to order anyway; ringing them changes nothing. The lapsed one,
 * whose confidence is low by definition, is the account worth saving.
 */
export function compareSignals(a: Signal, b: Signal): number {
  const rank: Record<SignalKind, number> = {
    lapsed: 0,
    overdue: 1,
    due_now: 2,
    due_soon: 3,
  };
  const byKind = rank[a.kind] - rank[b.kind];
  if (byKind !== 0) return byKind;
  // Within a kind, the more confident first.
  return b.confidence - a.confidence;
}
