/**
 * Ordence — ⭐⭐ MOVING STOCK BETWEEN OUR OWN PLACES
 * Version: v1.5.0-alpha
 *
 * Pure. No database, no clock.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE TWO THINGS THIS FILE DECIDES, AND BOTH ARE COUNTER-INTUITIVE
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① **A transfer between two of our own godowns can be a TAXABLE SUPPLY.**
 *    Section 25(4) makes each GST registration a *distinct person*, and
 *    Schedule I para 2 makes a supply between distinct persons taxable
 *    **even without consideration**. So a Pune → Bengaluru branch move
 *    needs a tax invoice with IGST on it, and the receiving branch
 *    claims the credit.
 *
 * ② **It is decided by the GSTINs, not by the states** — and that is the
 *    intuitive mistake. Two godowns in different states under ONE GSTIN
 *    are still not a supply. Two godowns in ONE state under two GSTINs
 *    are. The state codes only decide *which* tax once the answer to (1)
 *    is yes.
 */

import { determinePlaceOfSupply } from "@/lib/gst/place-of-supply";
import type { GstRegistrationType } from "@/db/schema/gst";

/* ------------------------------------------------------------------ */
/* TAX TREATMENT                                                       */
/* ------------------------------------------------------------------ */

export class TransferError extends Error {}

export type TransferDocumentType = "delivery_challan" | "tax_invoice";
/**
 * ⚠️ `cgst_utgst` ADDED v1.37.0. Its absence is why every transfer into a
 * Union Territory was recorded under the wrong Act: the type could not
 * express the answer, so the code could not give it.
 */
export type TransferTaxKind = "none" | "cgst_sgst" | "cgst_utgst" | "igst";

export type TransferTreatment = {
  isTaxableSupply: boolean;
  documentType: TransferDocumentType;
  taxKind: TransferTaxKind;
  /** The plain-language reason, shown on the screen. */
  reason: string;
  /** The authority, for anybody who has to defend it. */
  authority: string;
};

/**
 * ⭐⭐ IS THIS TRANSFER A SUPPLY, AND WHAT DOCUMENT DOES IT NEED?
 *
 * 🔴 RECORDING AN INTER-GSTIN MOVE ON A DELIVERY CHALLAN understates
 *    outward supply on one GSTIN's GSTR-1 **and** denies the other
 *    branch its input credit. Both halves are found at the same
 *    assessment, and by then it has happened every month for two years.
 *
 * ⚠️ AND THE MIRROR IS EQUALLY EXPENSIVE. Raising a tax invoice for a
 * move between two godowns under one GSTIN charges tax on a supply that
 * never happened, inflates turnover, and creates a credit the same
 * entity then claims from itself.
 */
export function transferTaxTreatment(args: {
  fromGstin: string | null;
  toGstin: string | null;
  fromStateCode: string | null;
  toStateCode: string | null;
  /**
   * ⭐ THE FIELD WITHOUT WHICH s.7(5)(b) CANNOT BE APPLIED. A destination
   * that is an SEZ unit makes the move inter-state however close it is.
   * Defaults to "regular" so existing callers keep their behaviour for
   * every non-SEZ destination, which is all of them today.
   */
  toRegistrationType?: GstRegistrationType | null;
}): TransferTreatment {
  const from = args.fromGstin?.trim().toUpperCase() || null;
  const to = args.toGstin?.trim().toUpperCase() || null;

  /**
   * ⚠️ A GODOWN WITH NO GSTIN OF ITS OWN OPERATES UNDER THE SAME
   * REGISTRATION AS THE ONE IT IS MOVING TO OR FROM. Treating a missing
   * GSTIN as "different" would raise a tax invoice for every internal
   * move in a workspace that has not filled the field in.
   */
  if (!from || !to || from === to) {
    return {
      isTaxableSupply: false,
      documentType: "delivery_challan",
      taxKind: "none",
      reason:
        from && to && from === to
          ? "Both places are under the same GSTIN, so nothing is being supplied to anybody — this is one person moving their own goods."
          : "No separate registration is recorded for these locations, so they are treated as one registered person and this is not a supply.",
      authority: "Rule 55 — delivery challan. No tax.",
    };
  }

  /**
   * 🔴 DIFFERENT GSTINS = DISTINCT PERSONS = A SUPPLY, whatever the
   *    states are. Two registrations in ONE state (a business with an
   *    SEZ unit, or separate verticals) are still distinct persons.
   */

  /**
   * ⭐ v1.37.0 (Batch 33): WHICH TAX IS ASKED OF THE ENGINE, NOT OF `!==`.
   *
   * ══════════════════════════════════════════════════════════════════
   * 🔴 THIS FILE'S OWN COMMENT NAMED THE CASE IT GOT WRONG.
   * ══════════════════════════════════════════════════════════════════
   * Four lines above, "a business with an SEZ unit" is given as the
   * example of two registrations in one state. Then the code compared
   * the two state codes, found them equal, and answered `cgst_sgst`.
   *
   * Section 7(5)(b) says a supply to an SEZ unit is inter-state **even
   * when the SEZ is in our own state**. So a Pune head office moving
   * stock to its own Pune SEZ unit owed IGST and this function said
   * CGST + SGST. The document totals identically, the SEZ branch claims
   * a credit in the wrong pool, and the shortfall accrues interest from
   * the original date.
   *
   * ⚠️ AND THE SECOND BLIND SPOT: a transfer terminating in a Union
   * Territory without a legislature is CGST + UTGST, a different Act and
   * a different box. `interState ? "igst" : "cgst_sgst"` cannot say it.
   */
  const determination = determinePlaceOfSupply({
    supplierStateCode: args.fromStateCode ?? from.slice(0, 2),
    // Goods physically moving between two places: s.10(1)(a), the place
    // of supply is where the movement terminates.
    supplyType: "goods",
    recipientRegistration: args.toRegistrationType ?? "regular",
    recipientStateCode: args.toStateCode ?? to.slice(0, 2),
    deliveryStateCode: args.toStateCode ?? to.slice(0, 2),
  });

  /**
   * ⚠️ A REFUSAL HERE IS NOT SURVIVABLE BY GUESSING, so it is thrown.
   * The engine only refuses when the supplier state is unusable, and a
   * transfer out of an unusable registration is a data problem that a
   * default would bury.
   */
  if (!determination.ok) {
    throw new TransferError(
      `${determination.problem.message} ${determination.problem.remedy}`,
    );
  }

  const { isInterState, taxKind, statutoryRef } = determination.supply;

  return {
    isTaxableSupply: true,
    documentType: "tax_invoice",
    taxKind,
    reason: `These are two separate GST registrations, so they are distinct persons and this move is a supply between them — taxable even though no money changes hands. ${
      determination.supply.explanation
    }`,
    authority:
      "Section 25(4) read with Schedule I para 2 — supply between distinct persons, " +
      `without consideration. Place of supply: ${statutoryRef}.` +
      (isInterState ? "" : " Intra-state, so the credit stays in this state's pool."),
  };
}

/**
 * ⭐ RULE 28 — WHAT VALUE TO PUT ON IT.
 *
 * The hierarchy is open market value → like kind and quality → Rule 30/31.
 * ⚠️ **BUT the second proviso is what makes branch transfers workable:**
 * where the recipient is eligible for FULL input tax credit, *the value
 * declared in the invoice is deemed to be the open market value.*
 *
 * 🔴 So for the ordinary case — one company, both branches fully
 *    taxable — cost is a perfectly good transfer value and there is no
 *    valuation exercise to do. Where the receiving branch is NOT fully
 *    eligible (it makes exempt supplies), the proviso does not apply and
 *    an open market value is needed, which is a real piece of work
 *    somebody has to do rather than a number this function can invent.
 */
export function rule28Value(args: {
  costMinor: bigint;
  recipientHasFullItc: boolean;
  openMarketValueMinor?: bigint | null;
}): { valueMinor: bigint; needsOpenMarketValue: boolean; reason: string } {
  if (args.costMinor < 0n) throw new TransferError("Cost cannot be negative.");

  if (args.recipientHasFullItc) {
    return {
      valueMinor: args.openMarketValueMinor ?? args.costMinor,
      needsOpenMarketValue: false,
      reason:
        "The receiving branch can claim the whole credit, so Rule 28's second proviso deems whatever is declared on the invoice to be the open market value. Cost is a fine figure to use.",
    };
  }

  if (args.openMarketValueMinor && args.openMarketValueMinor > 0n) {
    return {
      valueMinor: args.openMarketValueMinor,
      needsOpenMarketValue: false,
      reason:
        "The receiving branch cannot claim the whole credit, so the second proviso does not apply and the open market value governs.",
    };
  }

  return {
    valueMinor: args.costMinor,
    needsOpenMarketValue: true,
    reason:
      "🔴 The receiving branch does not have full input tax credit, so Rule 28's deeming proviso does not apply here. Cost is being used as a placeholder — the open market value has to be established, and it is not a number this screen can work out.",
  };
}

/* ------------------------------------------------------------------ */
/* THE TRANSIT VARIANCE                                                */
/* ------------------------------------------------------------------ */

export type TransferLineCount = {
  lineNo: number;
  description: string;
  qtyDispatchedMilli: bigint;
  qtyReceivedMilli: bigint | null;
  unitCostMinor: bigint;
};

export type VarianceLine = {
  lineNo: number;
  description: string;
  shortMilli: bigint;
  /** What the missing goods were carried at. */
  lossMinor: bigint;
};

export type TransferVariance = {
  lines: VarianceLine[];
  totalShortMilli: bigint;
  totalLossMinor: bigint;
  /** True when every line has been counted at the far end. */
  fullyCounted: boolean;
};

/**
 * ⭐⭐ WHAT LEFT AND NEVER ARRIVED.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FAILURE THIS EXISTS FOR: POSTING ONLY WHAT ARRIVED
 * ══════════════════════════════════════════════════════════════════════
 * 100 bags leave Pune and 98 are counted at Nagpur. The obvious thing is
 * to receive 98 — and then the two missing bags are **simply gone**. No
 * error, no entry, and the stock ledger is short by two with nothing
 * naming why.
 *
 * ⚠️ The transit warehouse is what makes this visible at all: the two
 * bags are still sitting in it, so they show on a balance somebody has
 * to explain. Without a transit location they would have vanished
 * between two independent movements and no report could have found them.
 *
 * 🔴 AND THE LOSS CARRIES A TAX CONSEQUENCE. Goods "lost" are named in
 *    s.17(5)(h) — the input tax credit claimed on them is not available
 *    and has to be reversed, exactly as for an expiry write-off.
 */
export function transferVariance(
  lines: readonly TransferLineCount[],
): TransferVariance {
  const out: VarianceLine[] = [];
  let totalShortMilli = 0n;
  let totalLossMinor = 0n;
  let fullyCounted = true;

  for (const l of lines) {
    if (l.qtyReceivedMilli === null) {
      fullyCounted = false;
      continue;
    }
    if (l.qtyReceivedMilli > l.qtyDispatchedMilli) {
      /**
       * ⚠️ REFUSED RATHER THAN NETTED. More arriving than left is stock
       * from nowhere. If more bags genuinely turned up, the DISPATCH
       * count was wrong — and that is a correction at the sending end,
       * not a quiet gain at the receiving end.
       */
      throw new TransferError(
        `Line ${l.lineNo}: more was received than was dispatched. If more genuinely arrived, the dispatch count was wrong — correct it there rather than creating stock at this end.`,
      );
    }
    const shortMilli = l.qtyDispatchedMilli - l.qtyReceivedMilli;
    if (shortMilli === 0n) continue;

    /** Cost is per unit; quantity is thousandths. Rounded half up, once. */
    const lossMinor = (l.unitCostMinor * shortMilli + 500n) / 1000n;
    out.push({
      lineNo: l.lineNo,
      description: l.description,
      shortMilli,
      lossMinor,
    });
    totalShortMilli += shortMilli;
    totalLossMinor += lossMinor;
  }

  return { lines: out, totalShortMilli, totalLossMinor, fullyCounted };
}

/* ------------------------------------------------------------------ */
/* THE STATE MACHINE                                                   */
/* ------------------------------------------------------------------ */

export type TransferStatus = "draft" | "dispatched" | "received" | "cancelled";

export const TRANSFER_TRANSITIONS: Record<TransferStatus, readonly TransferStatus[]> = {
  draft: ["dispatched", "cancelled"],
  /**
   * ⚠️ A DISPATCHED TRANSFER CANNOT BE CANCELLED. The goods are on a
   * lorry. Cancelling would leave stock sitting in a transit warehouse
   * that no document accounts for — which is worse than the shortage it
   * was trying to tidy away. It gets received, short, and the difference
   * is written off by somebody who signs for it.
   */
  dispatched: ["received"],
  received: [],
  cancelled: [],
};

export function canTransitionTransfer(
  from: TransferStatus,
  to: TransferStatus,
): { allowed: boolean; reason: string } {
  if (TRANSFER_TRANSITIONS[from].includes(to)) return { allowed: true, reason: "" };

  if (from === "dispatched" && to === "cancelled") {
    return {
      allowed: false,
      reason:
        "The goods have already left, so this cannot be cancelled — they are sitting in transit and something has to account for them. Receive it with the quantity that actually arrived; the shortfall becomes a written-off loss with a name against it.",
    };
  }
  if (from === "received") {
    return {
      allowed: false,
      reason: "This transfer is complete. Correct it with a new transfer the other way.",
    };
  }
  return {
    allowed: false,
    reason: `A ${from} transfer cannot become ${to}.`,
  };
}

/* ------------------------------------------------------------------ */
/* WHAT THE SCREEN SAYS                                                */
/* ------------------------------------------------------------------ */

export type TransferHealth = {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
  detail: string;
};

/**
 * ⭐ HOW LONG HAS THIS BEEN ON A LORRY?
 *
 * ⚠️ THE AGE IS THE WHOLE ALARM. A transfer dispatched and never
 * received is stock nobody is counting, in a location nobody visits, and
 * it stays on the balance sheet indefinitely because the transit
 * warehouse is a real place. Two days is a lorry; three weeks is a
 * receipt somebody forgot to do, and the goods are probably on a shelf
 * at the far end being sold from nowhere.
 */
export function transferHealth(args: {
  status: TransferStatus;
  dispatchedAt: Date | null;
  now: Date;
  staleAfterDays?: number;
}): TransferHealth {
  const stale = args.staleAfterDays ?? 7;

  if (args.status === "draft") {
    return {
      tone: "neutral",
      label: "Not dispatched",
      detail: "Nothing has moved. The stock is still at the sending location.",
    };
  }
  if (args.status === "cancelled") {
    return { tone: "neutral", label: "Cancelled", detail: "Nothing moved." };
  }
  if (args.status === "received") {
    return { tone: "ok", label: "Received", detail: "The goods arrived and were counted." };
  }

  const days = args.dispatchedAt
    ? Math.floor((args.now.getTime() - args.dispatchedAt.getTime()) / 86_400_000)
    : 0;

  if (days >= stale) {
    return {
      tone: "danger",
      label: `In transit ${days} days`,
      detail:
        "🔴 This has been on the road too long. The stock is sitting in a transit location where nobody counts it — which usually means it arrived and the receipt was never entered, and the far end has been selling it from a balance that does not exist.",
    };
  }
  return {
    tone: "warn",
    label: days === 0 ? "In transit today" : `In transit ${days} day${days === 1 ? "" : "s"}`,
    detail:
      "On a lorry. The stock is ours and is in neither godown — it sits in the transit location until somebody counts it in.",
  };
}
