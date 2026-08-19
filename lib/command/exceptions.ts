/**
 * Ordence — ⭐⭐⭐ THE EXCEPTION ENGINE
 * Version: v1.26.0-alpha · Batch 18
 *
 * Pure and isomorphic. Money is `bigint` paise throughout.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE PROBLEM WITH EVERY "MORNING DASHBOARD" EVER SHIPPED
 * ══════════════════════════════════════════════════════════════════════
 * It shows counts. Twelve overdue invoices. Four unposted documents.
 * Three returns not filed. Every number is correct, the page is never
 * empty, and after a fortnight nobody opens it — because a page that
 * always has forty items on it is telling you nothing about today.
 *
 * ⚠️ AND THE RANKING IS ALWAYS WRONG IN THE SAME DIRECTION: by size, or
 * by recency. Both feel objective and neither is what matters.
 *
 *   • A ₹40 lakh receivable that is nine days late is a phone call.
 *   • A ₹4,000 PF payment that is one day late is damages under section
 *     14B that can exceed the contribution, plus interest under 7Q, and
 *     it CANNOT BE UNDONE by paying tomorrow.
 *
 * A dashboard sorted by amount puts the first at the top and buries the
 * second at number nineteen.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ SO THE RANKING IS BY CONSEQUENCE, AND CONSEQUENCE HAS THREE
 *        PARTS
 * ══════════════════════════════════════════════════════════════════════
 *   ① IS IT STILL FIXABLE TODAY? A deadline that passes tonight
 *      outranks one that passes in a week, whatever the amounts.
 *   ② DOES IT COMPOUND? Interest that accrues daily, a late fee per
 *      day, damages that ratchet. These get worse while the page is
 *      open. Most things do not.
 *   ③ HOW MUCH? Last, and deliberately last. Money is the tiebreaker,
 *      not the sort key.
 *
 * ⚠️ AND ITEMS WHOSE WINDOW HAS ALREADY CLOSED DROP TO THE BOTTOM
 * rather than screaming at the top. Nothing can be done about them
 * today; they are there to be learned from and to stop the next one.
 * Ranking them first is how a page trains people to ignore its top.
 */

/* ------------------------------------------------------------------ */
/* THE SHAPE OF A SIGNAL                                               */
/* ------------------------------------------------------------------ */

export type ExceptionState =
  /** The window closed. Nothing can be done today; it is here to be learned from. */
  | "missed"
  /** Past its date and still fixable. */
  | "overdue"
  /** The last day. */
  | "closing_today"
  /** Inside the warning window. */
  | "due_soon"
  /** Not urgent, but somebody should know. */
  | "watch";

export type ExceptionSignal = {
  /** Stable across days, so a UI can remember what was dismissed. */
  key: string;
  kind: string;
  headline: string;
  /** What is at stake, in paise. Null when the item is not about money. */
  amountMinor: bigint | null;
  /** ISO day the window closes. Null when there is no deadline. */
  deadline: string | null;
  state: ExceptionState;
  /**
   * 🔴 DOES IT GET WORSE ON ITS OWN? Interest, per-day late fees,
   * statutory damages. This is the single strongest ranking input after
   * "is it still fixable", and it is the one a count-based dashboard
   * has no way to express.
   */
  compounds: boolean;
  /** One sentence: what happens if this is ignored. Never a restatement of the headline. */
  consequence: string;
  /**
   * ⚠️ WHERE TO GO. Required, and it is what makes this an EXCEPTION
   * rather than a FACT. A line somebody cannot act on belongs in a
   * report, not on the page they open at nine in the morning.
   */
  where: string;
  /** Optional detail — a count, a name, a period. */
  detail?: string | null;
};

/* ------------------------------------------------------------------ */
/* ⭐⭐ THE RANKING                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE BANDS ARE FAR APART ON PURPOSE. A gap of 1,000 between bands
 * means no amount of money can lift a "due in five days" above a
 * "closing tonight" — which is exactly the failure this exists to
 * prevent. Adjacent scores are only ever compared within a band.
 */
const STATE_BAND: Readonly<Record<ExceptionState, number>> = Object.freeze({
  overdue: 5000,
  closing_today: 4000,
  due_soon: 3000,
  watch: 2000,
  /**
   * 🔴 BELOW `watch`, DELIBERATELY. A missed deadline is the most
   * emotive item on the page and the least actionable. Putting it first
   * means the first thing somebody reads every morning is a thing they
   * cannot fix, which is how a page stops being read.
   */
  missed: 1000,
});

/** ⚠️ Compounding is worth more than any amount, and less than the state. */
const COMPOUND_BONUS = 500;

/**
 * The money contribution is LOGARITHMIC and capped, and both matter.
 *
 * ⚠️ LINEAR MONEY WOULD MAKE THE SORT KEY BE MONEY. A ₹40 lakh
 * receivable would outrank a ₹4,000 PF default by a factor of a
 * thousand and swamp every band boundary. What we actually want is
 * "bigger breaks ties", which is what a bounded curve gives.
 */
function moneyWeight(amountMinor: bigint | null): number {
  if (amountMinor === null || amountMinor <= 0n) return 0;
  const rupees = Number(amountMinor / 100n);
  if (!Number.isFinite(rupees) || rupees <= 0) return 0;
  return Math.min(400, Math.round(Math.log10(rupees + 1) * 50));
}

export function scoreOf(signal: ExceptionSignal): number {
  return (
    STATE_BAND[signal.state] +
    (signal.compounds ? COMPOUND_BONUS : 0) +
    moneyWeight(signal.amountMinor)
  );
}

/**
 * ⚠️ A STABLE SORT WITH AN EXPLICIT TIEBREAK ON `key`.
 *
 * Two items with identical scores must not swap places between one
 * refresh and the next. A list that reorders itself while somebody is
 * reading it is a list they stop trusting, and `Array.sort` gives no
 * guarantee across engines for equal elements.
 */
export function rankExceptions(
  signals: readonly ExceptionSignal[],
): ExceptionSignal[] {
  return [...signals].sort((a, b) => {
    const diff = scoreOf(b) - scoreOf(a);
    if (diff !== 0) return diff;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ */
/* ⭐ THE CAP, AND SAYING WHAT IT DROPPED                              */
/* ------------------------------------------------------------------ */

export const SHOWN_BY_DEFAULT = 12;

export type ExceptionDigest = {
  shown: ExceptionSignal[];
  hiddenCount: number;
  /** ⚠️ Null when nothing was hidden. Never the string "0 more". */
  hiddenNote: string | null;
  headline: string;
  /** True when there is genuinely nothing to do. */
  allClear: boolean;
  totalAtStakeMinor: bigint;
  actionableCount: number;
};

/**
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐⭐ THE HEADLINE IS THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * Somebody reads one line of this page on a phone at a site office. It
 * has to be the true one.
 *
 * ⚠️ IT LEADS WITH THE THING THAT STOPS BEING FIXABLE SOONEST, not with
 * a count and not with a total. "4 items need attention" is a number
 * about the page. "PF for July is 2 days late and damages are running"
 * is a number about the business.
 */
export function digest(
  signals: readonly ExceptionSignal[],
  limit = SHOWN_BY_DEFAULT,
): ExceptionDigest {
  const ranked = rankExceptions(signals);

  /**
   * ⚠️ "MISSED" IS NOT ACTIONABLE AND IS NOT COUNTED AS SUCH. A page
   * reporting "7 things need attention" where three of them cannot be
   * done anything about is a page that has just lied about your morning.
   */
  const actionable = ranked.filter((s) => s.state !== "missed");
  const totalAtStakeMinor = actionable.reduce(
    (sum, s) => sum + (s.amountMinor ?? 0n),
    0n,
  );

  const shown = ranked.slice(0, limit);
  const hiddenCount = ranked.length - shown.length;

  return {
    shown,
    hiddenCount,
    /**
     * 🔴 NO SILENT CAPS. A list that quietly truncates reads as "that is
     * everything", and the twelfth-most-urgent thing is exactly the one
     * a busy morning drops.
     */
    hiddenNote:
      hiddenCount > 0
        ? `${hiddenCount} more not shown — this page keeps the ${limit} that cost the most to ignore.`
        : null,
    headline: headlineFor(ranked, actionable),
    allClear: actionable.length === 0,
    totalAtStakeMinor,
    actionableCount: actionable.length,
  };
}

function headlineFor(
  ranked: readonly ExceptionSignal[],
  actionable: readonly ExceptionSignal[],
): string {
  if (actionable.length === 0) {
    /**
     * ⭐ THE PAGE CAN BE EMPTY, AND IT HAS TO BE ABLE TO BE.
     *
     * ⚠️ A dashboard that always finds something is a dashboard that is
     * manufacturing work. If a business has posted everything and owes
     * nothing this week, the honest answer is to say so and let somebody
     * get on with their day.
     */
    const missed = ranked.length;
    return missed > 0
      ? `Nothing needs doing today. ${missed} thing${missed === 1 ? "" : "s"} below already passed their date — worth reading once so the next one does not.`
      : "Nothing needs attention today.";
  }

  const top = actionable[0]!;
  const rest = actionable.length - 1;
  const tail =
    rest > 0 ? ` and ${rest} other${rest === 1 ? "" : "s"}` : "";

  return `${top.headline}${tail}.`;
}

/* ------------------------------------------------------------------ */
/* DERIVING STATE FROM A DEADLINE                                      */
/* ------------------------------------------------------------------ */

export const DUE_SOON_DAYS = 5;

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  return Math.round((b - a) / 86_400_000);
}

/**
 * ⚠️ `graceDays` IS NOT A FUDGE FACTOR. Some windows genuinely close and
 * cannot be reopened — the section 34 credit-note deadline is the one
 * this batch met — and once past, the item is `missed` rather than
 * `overdue`. Others are merely late and remain fixable indefinitely, at
 * increasing cost. Treating those two the same is how a page tells
 * somebody to stop trying at the exact moment they still could.
 */
export function stateFor(args: {
  deadline: string | null;
  today: string;
  /** True when passing the deadline makes the action impossible, not just late. */
  closesPermanently?: boolean;
  dueSoonDays?: number;
}): ExceptionState {
  if (!args.deadline) return "watch";
  const days = daysBetween(args.today, args.deadline);
  if (days < 0) return args.closesPermanently ? "missed" : "overdue";
  if (days === 0) return "closing_today";
  if (days <= (args.dueSoonDays ?? DUE_SOON_DAYS)) return "due_soon";
  return "watch";
}
