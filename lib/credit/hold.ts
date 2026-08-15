/**
 * Ordence — ⭐⭐ THE CREDIT HOLD, AS A RULE RATHER THAN A FLAG
 * Version: v1.46.0-alpha (Batch 40)
 *
 * Pure. `bigint` paise, no clock, no database. Every refusal in this
 * file is a value returned, never an exception — the throwing happens in
 * `lib/credit/enforce.ts`, one layer up, where there is a transaction to
 * abort. Keeping the judgement here means it can be exercised without
 * standing up Postgres.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A HOLD REFUSES THE WRITE. NOT THE BUTTON. THE WRITE.
 * ══════════════════════════════════════════════════════════════════════
 * `components/credit/*` hides the confirm control for a held customer,
 * and that is a courtesy. It is not a control. Every export of a
 * `"use server"` file is a browser-reachable RPC endpoint reachable with
 * `curl`, and `curl` has never rendered a button. A screen-only check is
 * a MISTAKE GUARD — it stops the salesperson who did not know — and the
 * person a credit hold exists to stop is, by construction, motivated.
 *
 * So `holdBlocksConfirmation()` below is called from inside
 * `confirmOrder`'s transaction, its answer is thrown, and the transaction
 * rolls back. `tests/ui/credit-control.test.ts` asserts the call site
 * exists by reading the source, because that is the kind of wiring
 * TypeScript cannot see the absence of.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND WHY A HOLD REFUSES WHERE AN OVER-LIMIT ORDER DOES NOT
 * ══════════════════════════════════════════════════════════════════════
 * v0.89.0 established that the credit engine never says "denied": an
 * order over the limit goes to `pending_approval`, where somebody senior
 * releases it. That is right, and it stays. The business answer to "this
 * customer is ₹40,000 over" is almost never no.
 *
 * 🔴 A HOLD IS A DIFFERENT SENTENCE. It is placed because a cheque
 * bounced, because a dispute is open, because the customer has stopped
 * answering. Routing that to `pending_approval` puts it in the same
 * queue as the routine over-limit orders — and every approval queue in
 * every business is eventually cleared by somebody working down it at
 * five o'clock. The hold would be indistinguishable from the noise it
 * was placed among.
 *
 * ⭐ SO THE HOLD REFUSES, AND THE WAY PAST IT IS A SIGNED OVERRIDE for
 * ONE order, with a reason, by a named person, recorded before the
 * confirmation rather than explained after it. Same outcome as an
 * approval; entirely different evidence.
 */

/* ------------------------------------------------------------------ */
/* MONEY, FOR SENTENCES                                                */
/* ------------------------------------------------------------------ */

/**
 * ₹ from paise, Indian digit grouping. Display only — never arithmetic.
 *
 * ⚠️ THE STRING IS BUILT FROM THE `bigint` BY DIVISION AND MODULO, never
 * by `Number(minor) / 100`. `Number` on a crore in paise is still exact
 * today and stops being exact at ₹90,07,19,92,54,740.99, and the failure
 * is a silently wrong rupee figure rather than a throw.
 */
export function formatPaise(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = abs % 100n;

  const digits = rupees.toString();
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    let rest = digits.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest.length > 0) parts.unshift(rest);
    grouped = `${parts.join(",")},${last3}`;
  }

  return `${negative ? "−" : ""}₹${grouped}.${paise.toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* THE FACTS                                                           */
/* ------------------------------------------------------------------ */

export type HoldSource = "manual" | "automatic";

/**
 * An unreleased row from `credit_hold_events`, or `null` when there is
 * none.
 *
 * ⚠️ THERE IS NO `isActive` FIELD, HERE OR IN THE TABLE. "On hold" IS
 * "a row exists with `releasedAt` null". A boolean beside a timestamp
 * that must always agree with it is two facts where there is one, and
 * the day they disagree the customer is both held and not held depending
 * on which query ran.
 */
export type ActiveHold = {
  id: string;
  source: HoldSource;
  reason: string;
  placedAt: Date;
} | null;

/**
 * An unconsumed row from `credit_hold_overrides` for THIS order.
 *
 * 🔴 THE `orderId` IS PART OF THE FACT AND IS CHECKED. An override is
 * keyed to one order by a unique index; a caller that loaded the
 * customer's most recent override instead of this order's would let one
 * signature release everything the customer ordered that week.
 */
export type OverrideFact = {
  id: string;
  orderId: string;
  actorUserId: string;
  reason: string;
  consumedAt: Date | null;
} | null;

/* ------------------------------------------------------------------ */
/* THE AUTOMATIC HOLD                                                  */
/* ------------------------------------------------------------------ */

/**
 * 🔴 AN AUTOMATIC HOLD IS NEVER LIFTED AUTOMATICALLY, AND THIS CONSTANT
 * IS HERE TO BE ARGUED WITH RATHER THAN DISCOVERED.
 *
 * The symmetry is tempting: if exposure over the limit places a hold,
 * exposure back under it should lift one. It is wrong for a reason that
 * only shows up in the field. A hold that lifts itself the moment a
 * receipt lands is a hold nobody ever has to look at — and the fact that
 * caused it (a customer who pays only when refused) outlives the
 * arithmetic that noticed it. The customer pays down ₹1 below the
 * ceiling, ships another order, and the cycle runs forever with no human
 * ever having formed a view.
 *
 * ⭐ THE CREDIT BOARD SHOWS EVERY HELD CUSTOMER WHOSE EXPOSURE IS NOW
 * BACK INSIDE THEIR LIMIT, with a one-click release. Same outcome, and a
 * person's name on it.
 */
export const AUTO_HOLDS_NEVER_SELF_RELEASE = true as const;

export type AutoHoldAssessment = {
  /** Place an `automatic` hold? False when one already exists. */
  shouldPlace: boolean;
  /** The sentence written into `credit_hold_events.reason`. */
  reason: string | null;
  /** Why not, for the board. Never shown as an error. */
  note: string;
};

/**
 * Should the sweep place an automatic hold on this customer?
 *
 * ⚠️ IT RETURNS `shouldPlace: false` WHEN A HOLD ALREADY EXISTS, and the
 * database says the same thing again with a partial unique index on
 * `(tenant_id, company_id) WHERE released_at IS NULL`. Two mechanisms
 * for one rule is not belt-and-braces here: this one produces a note a
 * human can read on the board, and the index is what actually holds when
 * two containers run the sweep in the same second. Neither is
 * sufficient alone.
 *
 * ⚠️ AND `autoHoldEnabled` IS CHECKED FIRST. Off by default — see the
 * column comment in 0083. A workspace that has not opted in gets the
 * board's "would be held" list and no writes.
 */
export function assessAutoHold(args: {
  autoHoldEnabled: boolean;
  activeHold: ActiveHold;
  limitMinor: bigint | null;
  exposureMinor: bigint;
}): AutoHoldAssessment {
  const { autoHoldEnabled, activeHold, limitMinor, exposureMinor } = args;

  if (activeHold) {
    return {
      shouldPlace: false,
      reason: null,
      note: `Already on hold since ${activeHold.placedAt.toISOString().slice(0, 10)} — ${activeHold.reason}`,
    };
  }

  /**
   * ⚠️ NULL IS NOT ZERO. NULL means no ceiling has been set and nothing
   * can be over it. Zero means blocked — and zero deliberately does NOT
   * place an automatic hold either, because 0048 already routes every
   * order for a zero-limit customer to approval and a hold on top of it
   * would refuse a customer somebody has explicitly chosen to trade with
   * under supervision.
   */
  if (limitMinor === null) {
    return { shouldPlace: false, reason: null, note: "No credit limit is set." };
  }
  if (limitMinor === 0n) {
    return {
      shouldPlace: false,
      reason: null,
      note: "Limit is zero — every order already routes to approval, which is the setting's purpose.",
    };
  }

  if (exposureMinor <= limitMinor) {
    return {
      shouldPlace: false,
      reason: null,
      note: `Within limit — ${formatPaise(limitMinor - exposureMinor)} of headroom.`,
    };
  }

  const over = exposureMinor - limitMinor;
  const reason =
    `Exposure ${formatPaise(exposureMinor)} against a limit of ${formatPaise(limitMinor)} — ` +
    `${formatPaise(over)} over. Placed automatically; it will not lift itself.`;

  if (!autoHoldEnabled) {
    return {
      shouldPlace: false,
      reason: null,
      note: `Would be held: ${reason} Automatic holds are switched off for this customer.`,
    };
  }

  return { shouldPlace: true, reason, note: reason };
}

/* ------------------------------------------------------------------ */
/* THE REFUSAL                                                         */
/* ------------------------------------------------------------------ */

export type HoldGateOutcome = {
  /** 🔴 True means the WRITE must not happen. */
  blocked: boolean;
  /** The sentence the person at the counter reads. */
  message: string;
  /**
   * The override that let this through, to be marked consumed in the
   * same transaction. NULL when nothing was overridden.
   */
  consumeOverrideId: string | null;
};

/**
 * ⭐⭐ THE GATE. Everything that asks "may this order be confirmed for a
 * held customer" comes here, so there is exactly one definition.
 *
 * ⚠️ AN OVERRIDE THAT HAS ALREADY BEEN CONSUMED DOES NOT COUNT, AND AN
 * OVERRIDE FOR A DIFFERENT ORDER DOES NOT COUNT. Both are refused here
 * as well as by the unique index, because the message matters: "there is
 * an override on file but it was raised for SO-202608-0041" is a
 * sentence somebody can act on, and `duplicate key value violates unique
 * constraint` is not.
 */
export function holdBlocksConfirmation(args: {
  orderId: string;
  orderNo: string;
  activeHold: ActiveHold;
  override: OverrideFact;
}): HoldGateOutcome {
  const { orderId, orderNo, activeHold, override } = args;

  if (!activeHold) {
    return { blocked: false, message: "", consumeOverrideId: null };
  }

  const held =
    `${orderNo} cannot be confirmed: this customer's account is on hold — ${activeHold.reason}`;

  if (!override) {
    return {
      blocked: true,
      consumeOverrideId: null,
      message:
        `${held} A hold is not an approval queue; nothing releases it by waiting. ` +
        `Either lift the hold, or record an override against this order saying why it goes out anyway.`,
    };
  }

  if (override.orderId !== orderId) {
    return {
      blocked: true,
      consumeOverrideId: null,
      message:
        `${held} There is an override on file for this customer, but it was raised against a ` +
        `different order and an override releases exactly one. Record one against ${orderNo}.`,
    };
  }

  if (override.consumedAt) {
    return {
      blocked: true,
      consumeOverrideId: null,
      message:
        `${held} The override for ${orderNo} has already been used, on ` +
        `${override.consumedAt.toISOString().slice(0, 10)}. One signature releases one order; ` +
        `raise a new one if this order genuinely needs to go out again.`,
    };
  }

  /**
   * ⭐ ALLOWED, AND THE SENTENCE STILL SAYS THE ACCOUNT IS HELD. The
   * person confirming should not be able to finish this transaction
   * under the impression that everything was fine.
   */
  return {
    blocked: false,
    consumeOverrideId: override.id,
    message:
      `Confirmed past a credit hold on a recorded override — ${override.reason} ` +
      `The account remains on hold: ${activeHold.reason}`,
  };
}
