/**
 * Ordence — ⭐⭐⭐ WHAT TO BUY, AND WHAT IS NOT MOVING
 * Version: v1.21.0-alpha
 *
 * Pure. No clock, no network, no database. `today` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 A REORDER REPORT THAT ONLY LOOKS AT THE SHELF IS WRONG BY DESIGN
 * ══════════════════════════════════════════════════════════════════════
 * "Quantity is below the reorder level" is the obvious rule and it
 * produces two failures every week in a real business.
 *
 * ⚠️ IT ORDERS THINGS ALREADY ON ORDER. Stock is at 40, the level is 50,
 * and 200 arrive on Thursday. A report that ignores the open purchase
 * order tells somebody to buy 200 more, and the warehouse ends up with
 * 440 of something it sells 20 of a month.
 *
 * ⚠️ AND IT ORDERS TOO LATE. An item at 51 with a level of 50 looks
 * healthy. If it sells 10 a day and takes 12 days to arrive, it will be
 * out of stock for a week before the delivery lands. The number that
 * matters is not the shelf today, it is the shelf on the day the goods
 * would arrive.
 *
 * ⭐ SO THE RULE IS: on-hand, plus what is already coming, minus what
 * will be used between now and then. That is the figure compared against
 * the reorder level, and it is the only one that produces a list a
 * purchase manager can act on without checking anything else.
 */

/** ⚠️ Thousandths, as everywhere in the stock ledger. */
export type Qty = string;

export function toThousandths(q: Qty): bigint {
  const t = q.trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(t)) {
    throw new Error(`A quantity must have at most three decimal places. Got "${q}".`);
  }
  const neg = t.startsWith("-");
  const [w = "0", f = ""] = (neg ? t.slice(1) : t).split(".");
  const v = BigInt(w) * 1000n + BigInt((f + "000").slice(0, 3));
  return neg ? -v : v;
}

export function fromThousandths(v: bigint): Qty {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 1000n}.${(a % 1000n).toString().padStart(3, "0")}`;
}

export interface ItemPosition {
  readonly stockItemId: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  /** 🔴 Null means nobody reorders this. It is not zero. */
  readonly reorderLevel: Qty | null;
  readonly reorderQuantity: Qty | null;
  readonly leadTimeDays: number | null;
  readonly onHand: Qty;
  /** ⭐ Approved purchase order lines not yet received. */
  readonly onOrder: Qty;
  /** Units used in the window below. The basis for the daily rate. */
  readonly usedInWindow: Qty;
  readonly windowDays: number;
  readonly unitCostMinor: bigint;
  readonly preferredVendorName: string | null;
  /** Null where nothing has ever moved. */
  readonly lastMovedOn: string | null;
  readonly firstStockedOn: string | null;
}

/** ⚠️ Used when an item has no lead time recorded. Deliberately not zero. */
export const ASSUMED_LEAD_DAYS = 7;

/**
 * ⚠️ HOW FAR BACK USAGE IS MEASURED.
 *
 * 🔴 NINETY DAYS RATHER THAN THIRTY. A thirty-day window on a business
 * with any seasonality produces a reorder list that panics in the busy
 * month and starves in the quiet one. Ninety smooths that without going
 * so far back that a genuine change in demand becomes invisible.
 */
export const USAGE_WINDOW_DAYS = 90;

export type Urgency = "out_of_stock" | "order_now" | "order_soon" | "ok";

export interface ReorderLine {
  readonly stockItemId: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  readonly onHand: Qty;
  readonly onOrder: Qty;
  /** 🔴 The figure the decision is actually made on. */
  readonly projectedOnArrival: Qty;
  readonly reorderLevel: Qty;
  readonly suggestedQuantity: Qty;
  readonly estimatedCostMinor: bigint;
  readonly dailyUsage: string;
  readonly daysOfCoverLeft: number | null;
  readonly leadTimeDays: number;
  readonly urgency: Urgency;
  readonly vendorName: string | null;
  readonly why: string;
}

/**
 * ⭐⭐ THE SUGGESTED PURCHASE LIST.
 *
 * ⚠️ ITEMS WITH NO REORDER LEVEL ARE SKIPPED ENTIRELY, which is 0029's
 * decision and the right one: an item nobody reorders appearing at zero
 * would fill the report with noise until people stopped reading it.
 */
export function suggestReorders(
  items: readonly ItemPosition[],
  today: Date,
): readonly ReorderLine[] {
  const out: ReorderLine[] = [];

  for (const it of items) {
    if (it.reorderLevel === null) continue;

    const level = toThousandths(it.reorderLevel);
    const onHand = toThousandths(it.onHand);
    const onOrder = toThousandths(it.onOrder);
    const used = toThousandths(it.usedInWindow);
    const lead = it.leadTimeDays ?? ASSUMED_LEAD_DAYS;

    // ⭐ Usage per day in thousandths. Integer arithmetic throughout.
    const perDay = it.windowDays > 0 ? used / BigInt(it.windowDays) : 0n;
    const willUse = perDay * BigInt(lead);

    // 🔴 THE FIGURE THAT MATTERS: the shelf on the day goods would land.
    const projected = onHand + onOrder - willUse;

    if (projected >= level) continue;

    const shortfall = level - projected;
    const suggested =
      it.reorderQuantity !== null
        ? maxOf(toThousandths(it.reorderQuantity), shortfall)
        : shortfall;

    const cover = perDay > 0n ? Number(onHand / perDay) : null;

    let urgency: Urgency;
    let why: string;
    if (onHand <= 0n) {
      urgency = "out_of_stock";
      why = `Nothing on the shelf. ${onOrder > 0n ? `${fromThousandths(onOrder)} already on order.` : "Nothing on order either."}`;
    } else if (projected <= 0n) {
      urgency = "order_now";
      why = `Will run out before a new order could arrive. ${lead} day lead time, about ${fromThousandths(perDay)} used a day.`;
    } else if (onHand < level) {
      urgency = "order_now";
      why = `Below the reorder level now, and ${fromThousandths(projected)} projected by the time an order would land.`;
    } else {
      // ⚠️ THE CASE THE NAIVE REPORT MISSES ENTIRELY. Above the level
      // today and below it by the time anything could arrive.
      urgency = "order_soon";
      why = `Above the reorder level today, but usage over a ${lead} day lead time brings it to ${fromThousandths(projected)}. Ordering after it drops is already too late.`;
    }

    out.push({
      stockItemId: it.stockItemId,
      sku: it.sku,
      name: it.name,
      uom: it.uom,
      onHand: it.onHand,
      onOrder: it.onOrder,
      projectedOnArrival: fromThousandths(projected),
      reorderLevel: it.reorderLevel,
      suggestedQuantity: fromThousandths(suggested),
      estimatedCostMinor: (suggested * it.unitCostMinor) / 1000n,
      dailyUsage: fromThousandths(perDay),
      daysOfCoverLeft: cover,
      leadTimeDays: lead,
      urgency,
      vendorName: it.preferredVendorName,
      why,
    });
  }

  return [...out].sort(byUrgencyThenValue);
}

/* ------------------------------------------------------------------ */
/* DEAD STOCK                                                          */
/* ------------------------------------------------------------------ */

export interface DeadStockLine {
  readonly stockItemId: string;
  readonly sku: string;
  readonly name: string;
  readonly onHand: Qty;
  readonly valueMinor: bigint;
  readonly daysStill: number;
  readonly band: "90" | "180" | "365" | "over_365";
  readonly neverMoved: boolean;
  readonly note: string;
}

export const DEAD_STOCK_BANDS = Object.freeze([90, 180, 365] as const);

/**
 * ⭐⭐ DEAD STOCK IS MONEY SITTING STILL, AND IT IS RANKED BY VALUE.
 *
 * 🔴 NOT BY AGE. The oldest item in most warehouses is a box of washers
 * worth ₹200 that nobody will ever care about. Sorting by age puts it at
 * the top and buries the ₹4 lakh of the wrong-colour tiles, which is the
 * only line on the report anybody would actually act on.
 *
 * ⚠️ AN ITEM THAT HAS NEVER MOVED IS FLAGGED SEPARATELY rather than
 * given an enormous age. It usually means a purchase nobody needed, and
 * that is a different conversation from something that sold once and
 * then stopped.
 */
export function findDeadStock(
  items: readonly ItemPosition[],
  today: Date,
  minimumDays = 90,
): readonly DeadStockLine[] {
  const out: DeadStockLine[] = [];

  for (const it of items) {
    const onHand = toThousandths(it.onHand);
    // ⚠️ Nothing on the shelf is not dead stock. It is just nothing.
    if (onHand <= 0n) continue;

    const since = it.lastMovedOn ?? it.firstStockedOn;
    if (since === null) continue;

    const days = daysBetween(since, isoOf(today));
    if (days === null || days < minimumDays) continue;

    const neverMoved = it.lastMovedOn === null;

    out.push({
      stockItemId: it.stockItemId,
      sku: it.sku,
      name: it.name,
      onHand: it.onHand,
      valueMinor: (onHand * it.unitCostMinor) / 1000n,
      daysStill: days,
      band: days > 365 ? "over_365" : days > 180 ? "365" : days > 90 ? "180" : "90",
      neverMoved,
      note: neverMoved
        ? `Has never moved since it was first stocked ${days} days ago. That is usually a purchase nobody needed rather than slow demand.`
        : `Last moved ${days} days ago.`,
    });
  }

  return [...out].sort((a, b) =>
    b.valueMinor > a.valueMinor ? 1 : b.valueMinor < a.valueMinor ? -1 : 0,
  );
}

/* ------------------------------------------------------------------ */
/* PLUMBING                                                            */
/* ------------------------------------------------------------------ */

function maxOf(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

const URGENCY_RANK: Record<Urgency, number> = {
  out_of_stock: 0,
  order_now: 1,
  order_soon: 2,
  ok: 3,
};

function byUrgencyThenValue(a: ReorderLine, b: ReorderLine): number {
  if (URGENCY_RANK[a.urgency] !== URGENCY_RANK[b.urgency]) {
    return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  }
  return b.estimatedCostMinor > a.estimatedCostMinor
    ? 1
    : b.estimatedCostMinor < a.estimatedCostMinor
      ? -1
      : 0;
}

export function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * ⚠️ DATES ARE COMPARED AS DAYS, not timestamps. Building a Date from a
 * bare date string lands on midnight UTC, which is the previous evening
 * in India and shifts every age by a day.
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
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}
