/**
 * Ordence — ⭐⭐ BATCHES, EXPIRY, SERIALS AND GOODS COMING BACK
 * Version: v1.4.0-alpha
 *
 * Pure. No database, and 🔴 **no clock** — every function that depends on
 * "today" takes it as an argument. An expiry calculation that reads the
 * system clock cannot be tested on the one day that matters, which is
 * the day the stock expires.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 FEFO, NOT FIFO. THIS IS THE HEADLINE.
 * ══════════════════════════════════════════════════════════════════════
 * Every inventory system ships FIFO — issue the oldest receipt first.
 * For anything with an expiry date that is **the wrong rule**, and it is
 * wrong in a way that looks right on every screen.
 *
 *     Batch A · received 1 January · expires December
 *     Batch B · received 1 March   · expires June
 *
 * FIFO ships A first and leaves B on the shelf to die. The warehouse is
 * doing exactly what the software told it, the stock rotation report
 * looks healthy, and in June somebody writes off Batch B and blames the
 * buyer. **FEFO — first EXPIRED, first out — ships B.**
 *
 * ⚠️ AND FEFO IS NOT A SETTING THAT CAN SAFELY DEFAULT TO FIFO. A
 * distributor who does not know which rule their software uses is a
 * distributor who finds out from a write-off.
 */

/* ------------------------------------------------------------------ */
/* CONSTANTS                                                           */
/* ------------------------------------------------------------------ */

export class BatchError extends Error {}

const DAY_MS = 86_400_000;

/**
 * ⭐ HOW CLOSE TO EXPIRY IS "TOO CLOSE" — and it is per-item, not global.
 *
 * ⚠️ A supermarket chain will refuse a delivery with less than 70% of
 * its shelf life left. A cement dealer cares about three months. One
 * global "expiring soon" number would be wrong for both, so this is
 * only the fallback when an item says nothing.
 */
export const DEFAULT_EXPIRY_WARNING_DAYS = 90;

export type BatchStatus =
  | "active"
  | "quarantined"
  | "expired"
  | "recalled"
  | "written_off";

export type SerialStatus =
  | "in_stock"
  | "reserved"
  | "dispatched"
  | "returned"
  | "scrapped"
  | "quarantined";

export type ReturnCondition = "saleable" | "damaged" | "expired" | "opened" | "scrap";

export const RETURN_CONDITION_META: Record<
  ReturnCondition,
  { label: string; saleable: boolean; note: string }
> = {
  saleable: {
    label: "Saleable",
    saleable: true,
    note: "Back on the shelf. Unopened, undamaged, still inside its shelf life.",
  },
  opened: {
    label: "Opened",
    saleable: false,
    note: "The seal is broken. It may be perfectly good and it cannot be sold as new.",
  },
  damaged: {
    label: "Damaged",
    saleable: false,
    note: "Goes to quarantine. A damaged unit returned to a selling location is a unit the next customer receives.",
  },
  expired: {
    label: "Expired",
    saleable: false,
    note: "Cannot be resold at any price. Writing it off reverses the input tax credit under s.17(5)(h).",
  },
  scrap: {
    label: "Scrap",
    saleable: false,
    note: "Fit only for disposal.",
  },
};

/* ------------------------------------------------------------------ */
/* ① EXPIRY                                                            */
/* ------------------------------------------------------------------ */

export type ExpiryBucket =
  | "no_expiry"
  | "expired"
  | "expiring_now"
  | "expiring_soon"
  | "fresh";

export type ExpiryVerdict = {
  bucket: ExpiryBucket;
  daysLeft: number | null;
  saleable: boolean;
  label: string;
  detail: string;
};

/** Whole days between two civil dates, ignoring any time component. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const dayNumber = (v: Date | string): number => {
    const iso = typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10);
    const ms = Date.parse(`${iso}T00:00:00.000Z`);
    if (Number.isNaN(ms)) throw new BatchError(`Not a date: ${String(v)}`);
    return Math.floor(ms / DAY_MS);
  };
  return dayNumber(to) - dayNumber(from);
}

/**
 * ⭐ WHERE ONE BATCH SITS, TODAY.
 *
 * 🔴 STOCK EXPIRES AT THE END OF ITS EXPIRY DATE, NOT AT THE START.
 *    A batch marked "expires 31/03" is saleable ON 31 March. Treating
 *    the date as exclusive throws away a day of good stock on every
 *    batch a business ever holds — quietly, and always in the same
 *    direction.
 */
export function expiryVerdict(args: {
  expiryDate: string | null;
  today: string;
  warningDays?: number;
  status?: BatchStatus;
}): ExpiryVerdict {
  const warn = args.warningDays ?? DEFAULT_EXPIRY_WARNING_DAYS;

  if (args.status && args.status !== "active" && args.status !== "quarantined") {
    return {
      bucket: "expired",
      daysLeft: null,
      saleable: false,
      label: args.status === "recalled" ? "Recalled" : "Written off",
      detail: "This batch has been taken out of stock deliberately.",
    };
  }

  if (!args.expiryDate) {
    return {
      bucket: "no_expiry",
      daysLeft: null,
      saleable: true,
      label: "No expiry",
      detail: "Nothing recorded. Fine for hardware; a gap for anything perishable.",
    };
  }

  const daysLeft = daysBetween(args.today, args.expiryDate);

  if (daysLeft < 0) {
    return {
      bucket: "expired",
      daysLeft,
      saleable: false,
      label: `Expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? "" : "s"} ago`,
      detail:
        "This cannot be sold. It is still counted in stock on hand until it is written off — and writing it off reverses the input tax credit claimed on it.",
    };
  }
  if (daysLeft === 0) {
    return {
      bucket: "expiring_now",
      daysLeft,
      saleable: true,
      /** ⚠️ Saleable TODAY. The last day is a full day. */
      label: "Expires today",
      detail: "Still saleable today. Not tomorrow.",
    };
  }
  if (daysLeft <= warn) {
    return {
      bucket: "expiring_soon",
      daysLeft,
      saleable: true,
      label: `${daysLeft} days left`,
      detail:
        "Ship this before anything with a longer life. Many customers refuse a delivery with less than 70% of shelf life remaining.",
    };
  }
  return {
    bucket: "fresh",
    daysLeft,
    saleable: true,
    label: `${daysLeft} days left`,
    detail: "In date.",
  };
}

/** An expiry derived from a manufacture date and a shelf life. */
export function expiryFromShelfLife(args: {
  manufactureDate: string;
  shelfLifeDays: number;
}): string {
  if (!Number.isInteger(args.shelfLifeDays) || args.shelfLifeDays <= 0) {
    throw new BatchError("Shelf life must be a whole number of days.");
  }
  const base = Date.parse(`${args.manufactureDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(base)) throw new BatchError(`Not a date: ${args.manufactureDate}`);
  return new Date(base + args.shelfLifeDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * ⚠️ THE SHELF-LIFE RULE A CUSTOMER ACTUALLY WRITES INTO A CONTRACT.
 *
 * Retail chains do not say "not expired". They say "at least 70% of
 * shelf life remaining on delivery", and a consignment that fails is
 * refused at the gate with the lorry already there.
 */
export function meetsResidualShelfLife(args: {
  manufactureDate: string;
  expiryDate: string;
  onDate: string;
  requiredPercent: number;
}): { ok: boolean; residualPercent: number; detail: string } {
  const total = daysBetween(args.manufactureDate, args.expiryDate);
  if (total <= 0) {
    throw new BatchError("A batch cannot expire on or before it was made.");
  }
  const left = daysBetween(args.onDate, args.expiryDate);
  const residualPercent = Math.max(0, Math.round((left / total) * 100));
  const ok = residualPercent >= args.requiredPercent;
  return {
    ok,
    residualPercent,
    detail: ok
      ? `${residualPercent}% of shelf life remaining.`
      : `Only ${residualPercent}% of shelf life remains and the agreement requires ${args.requiredPercent}%. This consignment is likely to be refused at the customer's gate.`,
  };
}

/* ------------------------------------------------------------------ */
/* ② FEFO ALLOCATION                                                   */
/* ------------------------------------------------------------------ */

export type AllocatableBatch = {
  batchNo: string;
  expiryDate: string | null;
  /** Quantity available, in thousandths of a stocking unit. */
  availableMilli: bigint;
  receivedAt: string;
  status: BatchStatus;
};

export type Allocation = {
  batchNo: string;
  expiryDate: string | null;
  quantityMilli: bigint;
};

export type AllocationResult = {
  allocations: Allocation[];
  shortfallMilli: bigint;
  /** Batches skipped, and why — never silently dropped. */
  skipped: { batchNo: string; reason: string }[];
};

/**
 * ⭐⭐ FIRST EXPIRED, FIRST OUT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ORDERING RULE, AND WHY EACH TIE-BREAK IS WHERE IT IS
 * ══════════════════════════════════════════════════════════════════════
 *   1. Earliest expiry first — the whole point.
 *   2. ⚠️ A batch with NO expiry date goes LAST, not first. It is
 *      tempting to sort nulls first ("we do not know, so use it up"),
 *      but an unknown expiry is usually a data-entry gap on a NEW
 *      receipt, and shipping it ahead of a batch that genuinely expires
 *      next month is exactly the failure FEFO exists to prevent.
 *   3. Then oldest receipt — FIFO as the tie-break, so two batches with
 *      the same expiry still rotate sensibly.
 *   4. Then batch number, so the result is deterministic. ⚠️ Without a
 *      final tie-break the same request can allocate differently on two
 *      runs, and a picking list that changes between being printed and
 *      being confirmed is a picking list nobody trusts.
 *
 * ⚠️ QUANTITIES ARE bigint THOUSANDTHS, the same convention the stock
 * ledger already uses. Floating-point kilogrammes do not add up, and an
 * allocation that does not add up leaves a picker short by 0.001 with
 * nothing on the shelf to make it up.
 */
export function allocateFefo(args: {
  requiredMilli: bigint;
  batches: readonly AllocatableBatch[];
  today: string;
  /** Expired stock is excluded by default, and it must be a decision. */
  allowExpired?: boolean;
}): AllocationResult {
  if (args.requiredMilli <= 0n) {
    throw new BatchError("Ask for a positive quantity.");
  }

  const skipped: { batchNo: string; reason: string }[] = [];
  const usable: AllocatableBatch[] = [];

  for (const b of args.batches) {
    if (b.availableMilli <= 0n) continue;

    if (b.status === "recalled" || b.status === "written_off") {
      skipped.push({ batchNo: b.batchNo, reason: `The batch is ${b.status}.` });
      continue;
    }
    if (b.status === "quarantined") {
      skipped.push({
        batchNo: b.batchNo,
        reason: "The batch is quarantined and has to be released before it can ship.",
      });
      continue;
    }
    const v = expiryVerdict({ expiryDate: b.expiryDate, today: args.today });
    if (v.bucket === "expired" && !args.allowExpired) {
      skipped.push({
        batchNo: b.batchNo,
        reason: `Expired — ${v.label.toLowerCase()}.`,
      });
      continue;
    }
    usable.push(b);
  }

  const ordered = [...usable].sort((a, b) => {
    /** ⚠️ No expiry sorts LAST, not first. See the note above. */
    if (a.expiryDate === null && b.expiryDate !== null) return 1;
    if (a.expiryDate !== null && b.expiryDate === null) return -1;
    if (a.expiryDate !== null && b.expiryDate !== null && a.expiryDate !== b.expiryDate) {
      return a.expiryDate < b.expiryDate ? -1 : 1;
    }
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.batchNo < b.batchNo ? -1 : a.batchNo > b.batchNo ? 1 : 0;
  });

  const allocations: Allocation[] = [];
  let remaining = args.requiredMilli;

  for (const b of ordered) {
    if (remaining <= 0n) break;
    const take = b.availableMilli < remaining ? b.availableMilli : remaining;
    allocations.push({
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      quantityMilli: take,
    });
    remaining -= take;
  }

  return { allocations, shortfallMilli: remaining, skipped };
}

/* ------------------------------------------------------------------ */
/* ③ SECTION 17(5)(h) — THE INPUT TAX CREDIT ON WRITTEN-OFF GOODS      */
/* ------------------------------------------------------------------ */

export type ItcReversal = {
  reversalMinor: bigint;
  /** True when the position is genuinely arguable rather than settled. */
  arguable: boolean;
  explanation: string;
};

/**
 * ⭐⭐ WHAT HAS TO BE GIVEN BACK WHEN STOCK IS WRITTEN OFF.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 SECTION 17(5)(h): input tax credit is NOT available in respect of
 *    goods "lost, stolen, destroyed, written off or disposed of by way
 *    of gift or free samples".
 * ══════════════════════════════════════════════════════════════════════
 * So a stock write-off is **two** entries. The stock leaves, AND the
 * credit claimed when the goods were bought is reversed.
 *
 * ⚠️ MOST SOFTWARE DOES ONLY THE FIRST. The books balance, the GST
 * position does not, and the difference surfaces at an assessment with
 * interest running from the original claim.
 *
 * ⭐ AND THE PRODUCT DOES NOT PRETEND THE LAW IS SETTLED WHERE IT IS
 * NOT. For a trader who bought and resold the same goods the position is
 * clear. For a MANUFACTURER whose inputs lost their identity in
 * production there is a real argument — and the CBIC's own Circular
 * 72/46/2018-GST leaves the credit-note route open for time-expired
 * pharmaceuticals. Where it is arguable this says so and asks for a
 * reason, rather than computing a confident number.
 */
export function itcReversalOnWriteOff(args: {
  /** What the stock is carried at, in paise. */
  costMinor: bigint;
  /** The rate the credit was claimed at, in basis points. 1800 = 18%. */
  itcRateBps: number;
  reason: "expiry" | "damage" | "theft" | "obsolescence" | "recall" | "sample";
  /** True when the goods were manufactured here rather than bought in. */
  isManufactured?: boolean;
}): ItcReversal {
  if (args.costMinor < 0n) throw new BatchError("Cost cannot be negative.");
  if (!Number.isInteger(args.itcRateBps) || args.itcRateBps < 0) {
    throw new BatchError("The ITC rate must be whole basis points.");
  }

  /**
   * ⚠️ ROUNDED HALF UP, IN INTEGER ARITHMETIC. `bigint` division
   * truncates, which would under-reverse by up to a paisa on every
   * write-off — always in the taxpayer's favour, which is not where a
   * rounding rule should sit by accident when the counterparty is the
   * Government.
   */
  const reversalMinor = (args.costMinor * BigInt(args.itcRateBps) + 5000n) / 10000n;

  if (args.isManufactured) {
    return {
      reversalMinor,
      arguable: true,
      explanation:
        "These goods were manufactured here, so the inputs lost their identity in production. There is a real argument that s.17(5)(h) does not reach the input credit — and a contrary CBIC view. The figure below is the full reversal; if you are taking the other position, say so in the note.",
    };
  }

  if (args.reason === "sample") {
    return {
      reversalMinor,
      arguable: false,
      explanation:
        "Free samples are named in s.17(5)(h) directly. The credit on them is not available, whatever the commercial purpose.",
    };
  }

  return {
    reversalMinor,
    arguable: false,
    explanation:
      "Goods bought in and then written off. s.17(5)(h) blocks the credit claimed on them, and the reversal is declared in the GSTR-3B for the month of the write-off.",
  };
}

/* ------------------------------------------------------------------ */
/* ④ SECTION 34(2) — THE CREDIT-NOTE DEADLINE                          */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ THE DATE AFTER WHICH A SALES RETURN COSTS THE TAX.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 Section 34(2): a credit note's tax may only be adjusted if it is
 *    declared by **30 November following the end of the financial year
 *    of the original supply**, or the date the annual return is
 *    furnished — whichever is EARLIER.
 * ══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ AFTER THAT THE CREDIT NOTE CAN STILL BE ISSUED. The customer still
 * owes less. **But the GST is gone** — the supplier has paid tax on a
 * sale that was reversed and cannot recover it.
 *
 * ⭐ WHICH IS WHY THIS IS A DATE AND NOT A VALIDATION. A goods return
 * received on 2 December against a March invoice is perfectly legal and
 * has just cost 18% of the value. The screen counts down to it; it does
 * not block anything.
 */
export function creditNoteTaxDeadline(args: {
  /** The date of the ORIGINAL supply, not of the return. */
  supplyDate: string;
  /** If the annual return has been filed, it caps the deadline. */
  annualReturnFiledOn?: string | null;
}): string {
  const iso = args.supplyDate.slice(0, 10);
  const parts = iso.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    throw new BatchError(`Not a date: ${args.supplyDate}`);
  }

  /**
   * ⚠️ THE INDIAN FINANCIAL YEAR RUNS APRIL TO MARCH. A supply on
   * 30 March 2026 sits in FY 2025-26 and its deadline is 30 November
   * **2026**. A supply two days later sits in FY 2026-27 and has until
   * 30 November **2027** — a full year more. Reading the calendar year
   * instead gets one of those wrong every single year.
   */
  const fyEndYear = m >= 4 ? y + 1 : y;
  const statutory = `${fyEndYear}-11-30`;

  if (args.annualReturnFiledOn) {
    const filed = args.annualReturnFiledOn.slice(0, 10);
    return filed < statutory ? filed : statutory;
  }
  return statutory;
}

export type DeadlineVerdict = {
  deadline: string;
  daysLeft: number;
  /** False once the tax can no longer be adjusted. */
  taxRecoverable: boolean;
  label: string;
  detail: string;
};

export function creditNoteDeadlineVerdict(args: {
  supplyDate: string;
  today: string;
  annualReturnFiledOn?: string | null;
  taxAtStakeMinor?: bigint;
}): DeadlineVerdict {
  const deadline = creditNoteTaxDeadline(args);
  const daysLeft = daysBetween(args.today, deadline);
  const stake =
    args.taxAtStakeMinor && args.taxAtStakeMinor > 0n
      ? ` About ₹${(Number(args.taxAtStakeMinor) / 100).toFixed(2)} of GST turns on it.`
      : "";

  if (daysLeft < 0) {
    return {
      deadline,
      daysLeft,
      taxRecoverable: false,
      label: "Tax adjustment has lapsed",
      detail: `The s.34(2) window closed on ${deadline}. A credit note can still be raised and the customer still owes less — but the GST on the original sale cannot be recovered now.${stake}`,
    };
  }
  if (daysLeft <= 30) {
    return {
      deadline,
      daysLeft,
      taxRecoverable: true,
      label: `${daysLeft} days to adjust the tax`,
      detail: `Raise the credit note before ${deadline} or the GST on this sale stops being recoverable.${stake}`,
    };
  }
  return {
    deadline,
    daysLeft,
    taxRecoverable: true,
    label: `Tax adjustable until ${deadline}`,
    detail: "Inside the s.34(2) window.",
  };
}

/* ------------------------------------------------------------------ */
/* ⑤ SERIALS                                                           */
/* ------------------------------------------------------------------ */

/**
 * ⭐ WHICH SERIAL TRANSITIONS ARE REAL.
 *
 * 🔴 `dispatched → dispatched` IS ABSENT, AND IT IS THE POINT. One
 *    physical unit cannot be sent to two customers, and the second one
 *    finds out at delivery.
 */
export const SERIAL_TRANSITIONS: Record<SerialStatus, readonly SerialStatus[]> = {
  in_stock: ["reserved", "dispatched", "scrapped", "quarantined"],
  reserved: ["in_stock", "dispatched", "quarantined"],
  dispatched: ["returned"],
  returned: ["in_stock", "quarantined", "scrapped"],
  quarantined: ["in_stock", "scrapped"],
  /** ⚠️ Terminal. A scrapped unit does not come back. */
  scrapped: [],
};

export function canTransitionSerial(
  from: SerialStatus,
  to: SerialStatus,
): { allowed: boolean; reason: string } {
  if (from === to) {
    return { allowed: false, reason: `It is already ${from.replace("_", " ")}.` };
  }
  const allowed = SERIAL_TRANSITIONS[from].includes(to);
  if (allowed) return { allowed: true, reason: "" };

  if (from === "dispatched") {
    return {
      allowed: false,
      reason:
        "This unit has already been dispatched to a customer. If it came back, record the return first — a second dispatch of one serial is one machine promised to two people.",
    };
  }
  if (from === "scrapped") {
    return { allowed: false, reason: "A scrapped unit does not come back into stock." };
  }
  return {
    allowed: false,
    reason: `A unit that is ${from.replace("_", " ")} cannot become ${to.replace("_", " ")}.`,
  };
}

/**
 * ⚠️ WARRANTY RUNS FROM DISPATCH, NOT FROM RECEIPT INTO OUR WAREHOUSE.
 *
 * A panel that sat in a store for eight months has not used eight months
 * of its warranty. Starting the clock at receipt shortens every
 * customer's cover by however long the stock took to sell — and it is
 * the customer who discovers it, at the point of a claim.
 */
export function warrantyUntil(args: {
  dispatchedOn: string;
  warrantyMonths: number;
}): string {
  if (!Number.isInteger(args.warrantyMonths) || args.warrantyMonths < 0) {
    throw new BatchError("Warranty must be a whole number of months.");
  }
  const iso = args.dispatchedOn.slice(0, 10);
  const parts = iso.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) throw new BatchError(`Not a date: ${args.dispatchedOn}`);

  const targetMonthIndex = m - 1 + args.warrantyMonths;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12) + 1;

  /**
   * ⚠️ 31 JANUARY PLUS ONE MONTH IS 28 FEBRUARY, NOT 3 MARCH. Letting
   * the date overflow gives a customer three extra days of cover on some
   * months and none on others — arbitrary, and impossible to explain
   * when it is disputed.
   */
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function warrantyStatus(args: {
  warrantyUntil: string | null;
  today: string;
}): { inWarranty: boolean; daysLeft: number | null; label: string } {
  if (!args.warrantyUntil) {
    return { inWarranty: false, daysLeft: null, label: "No warranty recorded" };
  }
  const daysLeft = daysBetween(args.today, args.warrantyUntil);
  if (daysLeft < 0) {
    return {
      inWarranty: false,
      daysLeft,
      label: `Out of warranty since ${args.warrantyUntil}`,
    };
  }
  return {
    inWarranty: true,
    daysLeft,
    /** ⚠️ The last day of a warranty is a full day, same as an expiry. */
    label: `In warranty · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
  };
}

/* ------------------------------------------------------------------ */
/* ⑥ SUMMARIES THE SCREENS READ                                        */
/* ------------------------------------------------------------------ */

export type BatchSummaryRow = {
  expiryDate: string | null;
  quantityMilli: bigint;
  valueMinor: bigint;
  status: BatchStatus;
};

/**
 * ⚠️ EXPIRED VALUE AND EXPIRING VALUE ARE NEVER SUMMED. One is a loss
 * that has already happened and the other is a loss somebody can still
 * prevent by shipping it — a single "at risk" figure hides the half that
 * is still actionable.
 */
export function summariseBatches(rows: readonly BatchSummaryRow[], today: string) {
  let expiredValueMinor = 0n;
  let expiringValueMinor = 0n;
  let freshValueMinor = 0n;
  let expiredCount = 0;
  let expiringCount = 0;
  let noExpiryCount = 0;

  for (const r of rows) {
    const v = expiryVerdict({
      expiryDate: r.expiryDate,
      today,
      status: r.status,
    });
    if (v.bucket === "expired") {
      expiredValueMinor += r.valueMinor;
      expiredCount += 1;
    } else if (v.bucket === "expiring_soon" || v.bucket === "expiring_now") {
      expiringValueMinor += r.valueMinor;
      expiringCount += 1;
    } else {
      freshValueMinor += r.valueMinor;
      if (v.bucket === "no_expiry") noExpiryCount += 1;
    }
  }

  return {
    expiredValueMinor,
    expiringValueMinor,
    freshValueMinor,
    expiredCount,
    expiringCount,
    noExpiryCount,
  };
}
