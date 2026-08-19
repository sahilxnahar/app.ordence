/**
 * Ordence — Customer Credit Exposure
 * Version: v0.89.0-alpha
 *
 * Pure. `bigint` paise, no clock, no database, no imports from the data
 * layer. Everything this file needs is handed to it, and everything it
 * returns is a decision somebody can read out loud.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT "EXPOSURE" MEANS HERE, STATED ONCE SO IT IS NEVER GUESSED
 * ══════════════════════════════════════════════════════════════════════
 *
 *     exposure = Σ over a company's live orders of
 *                max(0, totalMinor − receivedValueMinor)
 *
 * That is: what we have committed to supply, less what has actually
 * arrived in the bank. It is a FORWARD figure, not an ageing one. An
 * order confirmed this morning with nothing paid is full exposure even
 * though not one rupee is overdue — which is the point. A credit limit
 * that only counts overdue money approves the order that breaks the
 * customer, and refuses the one after it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS DOES NOT IMPORT `lib/receivables/demand.ts`
 * ══════════════════════════════════════════════════════════════════════
 * The brief for this file said: if the codebase already computes what a
 * customer owes, IMPORT it, do not re-derive it. I checked. It does —
 * `demandPosition()` in `lib/receivables/demand.ts` — and it is
 * deliberately NOT used here, because it answers a different question
 * about a different counterparty.
 *
 *   `demand_notices`   keyed on  booking_id + milestone_id (both NOT NULL)
 *   `receipts`         keyed on  booking_id
 *   `sales_orders`     keyed on  company_id
 *   `customer_credit_profiles`   keyed on  company_id
 *
 * The receivables register is construction-linked: a demand is raised
 * against a RERA milestone on a unit booking, and its counterparty is a
 * lead, not a company. There is no `company_id` anywhere in
 * `db/schema/receivables.ts`. The only bridge is
 * `sales_orders.booking_id`, which is populated only "when this order is
 * the goods half of a unit booking" — nearly never.
 *
 * Joining them would not be reuse. It would be inventing a relationship
 * the schema does not assert, and the first flat buyer who is also a
 * trade customer would have one debt counted twice.
 *
 * ⚠️ SO: this file is the credit definition for the ORDER BOOK side.
 *    A real-estate buyer's demand position is `demandPosition()` and
 *    stays there. Two ledgers, two counterparties, and the honest thing
 *    is to keep them apart rather than average them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ NULL IS NOT ZERO
 * ══════════════════════════════════════════════════════════════════════
 * `creditLimitMinor` NULL = no limit set. Blocks nothing. The default.
 * `creditLimitMinor` 0    = blocked. Every order routes to approval.
 * Confusing the two stops a customer's entire trade overnight, and
 * nobody looks at the credit table first, because nobody set a limit.
 */

/* ------------------------------------------------------------------ */
/* WHICH ORDERS COUNT                                                  */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ THE EXCLUSION LIST IS SHORT ON PURPOSE, AND `closed` IS NOT ON IT.
 *
 * `draft` and `pending_approval` are excluded because neither is a
 * commitment yet — counting a draft would let a salesperson exhaust a
 * customer's limit with orders nobody agreed to.
 *
 * `cancelled` is excluded because the commitment was withdrawn.
 *
 * `closed` is INCLUDED, and that is the line most likely to be "fixed"
 * by someone later. `closed` means delivered and invoiced. It does not
 * mean paid. A closed order carrying `totalMinor > receivedValueMinor`
 * is precisely the debt a credit limit exists to notice — dropping it
 * because the word sounds final is how a limit stops seeing the oldest
 * money on the account.
 *
 * `on_hold` is included: the goods are promised, the paperwork is
 * paused. The customer's ceiling is still spoken for.
 */
export const EXPOSURE_EXCLUDED_STATUSES: readonly string[] = Object.freeze([
  "draft",
  "pending_approval",
  "cancelled",
]);

/**
 * One order, reduced to the four facts exposure needs.
 *
 * ⚠️ `totalMinor` AND `receivedValueMinor` ARE READ FROM THE ORDER ROW,
 *    NOT RECOMPUTED FROM LINES. Both are maintained by the trigger in
 *    SQL 0028 §4 on every line write. Summing the lines here would be a
 *    second definition of an order's value, and the day it disagrees
 *    with the first by ₹4,000 the salesperson trusts one screen and the
 *    accountant trusts the other — both inside the same system.
 */
export type OrderExposureFact = {
  id: string;
  orderNo: string;
  status: string;
  /** Order value including tax. Paise. Trigger-maintained. */
  totalMinor: bigint;
  /** What has actually been received against it. Paise. Trigger-maintained. */
  receivedValueMinor: bigint;
};

/** What one order contributes to the ceiling. Never negative. */
export function orderExposure(order: OrderExposureFact): bigint {
  if (EXPOSURE_EXCLUDED_STATUSES.includes(order.status)) return 0n;
  const unpaid = order.totalMinor - order.receivedValueMinor;
  return unpaid > 0n ? unpaid : 0n;
}

export type CompanyExposure = {
  /** Σ of `orderExposure` across every order handed in. Paise. */
  exposureMinor: bigint;
  /** How many orders contributed a non-zero figure. */
  contributingOrders: number;
  /** Orders seen but excluded by status — for the "why is this low?" question. */
  excludedOrders: number;
};

/**
 * ⚠️ AN OVERPAID ORDER DOES NOT SUBSIDISE AN UNPAID ONE.
 *
 * `orderExposure` floors at zero per order rather than summing signed
 * balances, so a customer who overpaid ₹50,000 on one order does not
 * silently gain ₹50,000 of headroom against another. Advance money is a
 * real thing and it belongs in the ledger; it is not the same as room
 * under a credit ceiling, and treating it as such is how a limit is
 * quietly exceeded by a customer who looks like they are ahead.
 */
export function companyExposure(orders: readonly OrderExposureFact[]): CompanyExposure {
  let exposureMinor = 0n;
  let contributingOrders = 0;
  let excludedOrders = 0;

  for (const order of orders) {
    if (EXPOSURE_EXCLUDED_STATUSES.includes(order.status)) {
      excludedOrders += 1;
      continue;
    }
    const amount = orderExposure(order);
    if (amount > 0n) {
      exposureMinor += amount;
      contributingOrders += 1;
    }
  }

  return { exposureMinor, contributingOrders, excludedOrders };
}

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

/**
 * The credit profile, reduced. `null` means no row exists, which means
 * exactly the same as a row with a NULL limit — no ceiling. Nothing has
 * to be seeded for existing customers.
 */
export type CreditProfileFacts = {
  /** ⚠️ NULL = unlimited. 0 = blocked. */
  creditLimitMinor: bigint | null;
  onHold: boolean;
  holdReason: string | null;
} | null;

export type CreditOutcome = "allow" | "approval_required";

export type CreditReasonCode =
  | "no_limit_set"
  | "within_limit"
  | "account_on_hold"
  | "limit_is_zero"
  | "limit_exceeded";

export type CreditDecision = {
  outcome: CreditOutcome;
  reasonCode: CreditReasonCode;
  /**
   * ⚠️ A SENTENCE FOR THE PERSON HOLDING THE PHONE, NOT FOR A LOG.
   *
   * Whoever reads this is standing in front of a customer. It states the
   * figures, so the next question ("by how much?") is already answered,
   * and it never says "denied" — the order is not refused, it is routed
   * to someone who may say yes.
   */
  message: string;
  /** Exposure before this order. Paise. */
  currentExposureMinor: bigint;
  /** Exposure if this order is confirmed. Paise. */
  projectedExposureMinor: bigint;
  /** The ceiling applied, or null if none. Paise. */
  limitMinor: bigint | null;
  /** How much room is left after this order. Negative = over. null if unlimited. */
  headroomMinor: bigint | null;
};

/** ₹ from paise, with Indian digit grouping. Display only — never arithmetic. */
function formatPaise(minor: bigint): string {
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

/**
 * Should this order go through, or does it need a human?
 *
 * ⚠️ THIS FUNCTION NEVER REFUSES AN ORDER. It returns
 *    `approval_required`, and the action layer decides what that means.
 *    A credit engine that returns "denied" gets wired to a dead end,
 *    because the business answer to a customer over their limit is
 *    almost never "no" — it is "not until someone senior looks".
 *
 * ⚠️ HOLD IS CHECKED BEFORE THE LIMIT, AND THE ORDER MATTERS. A held
 *    account that is also well inside its limit must still route to
 *    approval; checking the limit first would clear it. A hold is an
 *    operational fact — a bounced cheque, an open dispute — and it
 *    outranks the arithmetic.
 */
export function assessCredit(args: {
  profile: CreditProfileFacts;
  orders: readonly OrderExposureFact[];
  /** The order being confirmed, in paise. Excluded from `orders` by the caller. */
  newOrderTotalMinor: bigint;
}): CreditDecision {
  const { profile, orders, newOrderTotalMinor } = args;

  const current = companyExposure(orders).exposureMinor;
  const projected = current + (newOrderTotalMinor > 0n ? newOrderTotalMinor : 0n);

  const base = {
    currentExposureMinor: current,
    projectedExposureMinor: projected,
  };

  /* 1. Hold outranks everything. */
  if (profile?.onHold) {
    const why = profile.holdReason?.trim();
    return {
      ...base,
      outcome: "approval_required",
      reasonCode: "account_on_hold",
      limitMinor: profile.creditLimitMinor,
      headroomMinor:
        profile.creditLimitMinor === null ? null : profile.creditLimitMinor - projected,
      message: why
        ? `This account is on hold — ${why}. The order can be raised, but it needs approval before it is confirmed.`
        : "This account is on hold. The order can be raised, but it needs approval before it is confirmed. Whoever placed the hold has the reason.",
    };
  }

  /* 2. No profile, or a NULL limit: no ceiling exists. */
  if (profile === null || profile.creditLimitMinor === null) {
    return {
      ...base,
      outcome: "allow",
      reasonCode: "no_limit_set",
      limitMinor: null,
      headroomMinor: null,
      message: `No credit limit is set for this customer. Current exposure ${formatPaise(current)}.`,
    };
  }

  const limit = profile.creditLimitMinor;

  /* 3. Zero is a decision, not an absence. */
  if (limit === 0n) {
    return {
      ...base,
      outcome: "approval_required",
      reasonCode: "limit_is_zero",
      limitMinor: 0n,
      headroomMinor: -projected,
      message:
        "This customer's credit limit is set to zero, so every order needs approval regardless of value. That is a deliberate setting, not a missing one — clearing the limit entirely is what removes the ceiling.",
    };
  }

  /* 4. The arithmetic. */
  const headroom = limit - projected;
  if (headroom < 0n) {
    return {
      ...base,
      outcome: "approval_required",
      reasonCode: "limit_exceeded",
      limitMinor: limit,
      headroomMinor: headroom,
      message:
        `This order takes the customer to ${formatPaise(projected)} against a limit of ${formatPaise(limit)} — ` +
        `${formatPaise(-headroom)} over. Current exposure is ${formatPaise(current)}. ` +
        `The order can be raised; it needs approval before it is confirmed.`,
    };
  }

  return {
    ...base,
    outcome: "allow",
    reasonCode: "within_limit",
    limitMinor: limit,
    headroomMinor: headroom,
    message:
      `Within limit. ${formatPaise(projected)} of ${formatPaise(limit)} after this order, ` +
      `${formatPaise(headroom)} remaining.`,
  };
}

/* ------------------------------------------------------------------ */
/* APPROVAL LIMITS                                                     */
/* ------------------------------------------------------------------ */

/**
 * Whether a given role may approve a given value in a given scope.
 *
 * ⚠️ NULL `maxValueMinor` = UNLIMITED FOR THAT SCOPE, not "may approve
 *    nothing". Same rule as the credit limit, and the same failure mode
 *    if it is read the other way: every approval in the workspace stops,
 *    and the table that caused it looks empty.
 *
 * ⚠️ NO ROW AT ALL MEANS THE ROLE HAS NO APPROVAL AUTHORITY IN THAT
 *    SCOPE. That asymmetry with the credit profile is deliberate. An
 *    absent credit limit means "nobody has restricted this customer";
 *    an absent approval limit means "nobody has granted this role the
 *    power to sign". Defaulting authority open is how an approval ladder
 *    becomes decoration.
 */
export function mayApprove(args: {
  /** The matching row for (tenant, role, scope), or null if none exists. */
  limit: { maxValueMinor: bigint | null } | null;
  valueMinor: bigint;
}): { allowed: boolean; message: string } {
  const { limit, valueMinor } = args;

  if (limit === null) {
    return {
      allowed: false,
      message:
        "This role has no approval limit set for this kind of decision, so it cannot approve it. Someone with an approval limit configured needs to sign it off.",
    };
  }

  if (limit.maxValueMinor === null) {
    return { allowed: true, message: "Approved — this role has no ceiling in this scope." };
  }

  if (valueMinor > limit.maxValueMinor) {
    return {
      allowed: false,
      message:
        `This is ${formatPaise(valueMinor)} and the role may approve up to ${formatPaise(limit.maxValueMinor)}. ` +
        `It needs someone with a higher limit.`,
    };
  }

  return {
    allowed: true,
    message: `Approved — ${formatPaise(valueMinor)} is within this role's limit of ${formatPaise(limit.maxValueMinor)}.`,
  };
}
