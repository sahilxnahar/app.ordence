/**
 * Ordence — ⭐⭐⭐ CONSENT, AND WHETHER YOU MAY ACTUALLY SEND THAT
 * Version: v1.10.0-alpha
 *
 * Pure. No database, no clock. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE DEADLINE IS INSIDE THIS PLAN, NOT AFTER IT
 * ══════════════════════════════════════════════════════════════════════
 * The Digital Personal Data Protection Rules 2025 were notified on
 * **13 November 2025**. Consent manager registration closes November
 * 2026 and the **penalty regime begins May 2027**. Penalties run to
 * ₹250 crore for failing to keep reasonable security safeguards.
 *
 * ⚠️ CONSENT RECORDED AS A BOOLEAN IS NOT CONSENT. The Act turns on
 * three things a tick box cannot answer:
 *
 *   **What were they told?**  The notice, in the words shown.
 *   **For what purpose?**     Agreeing to order updates is not agreeing
 *                             to a campaign.
 *   **Can they take it back?** As easily as they gave it, and the
 *                             withdrawal has to be honoured everywhere.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR RULES THIS FILE ENFORCES, AND WHY EACH ONE EXISTS
 * ══════════════════════════════════════════════════════════════════════
 *
 * ① **Silence is not consent.** No record means no permission. The
 *    default is refuse, not allow. Every marketing system that defaults
 *    the other way does it because the list is bigger that way.
 *
 * ② **Withdrawal beats a grant, whatever the dates say.** A person who
 *    said stop has said stop. A later grant only counts if it is a
 *    genuinely new grant against a notice they were shown again, which
 *    is why 0061 refuses to flip a withdrawn row back to granted.
 *
 * ③ **A withdrawal on `all` reaches every channel.** Somebody who
 *    unsubscribes from email and keeps getting WhatsApp will complain,
 *    and under the Act it is a reportable complaint. One stop means
 *    stop.
 *
 * ④ **A grant with no notice behind it is a checkbox, not evidence.**
 *    It is ignored here even if the database somehow holds one.
 *
 * ⭐ AND THE ANSWER ALWAYS CARRIES ITS REASON, so the campaign screen
 * can say WHY somebody was excluded rather than silently dropping them
 * from a list. A silent exclusion is how a firm discovers it has been
 * mailing 6,000 people instead of 9,000 for a year.
 */

export class ConsentError extends Error {}

/* ------------------------------------------------------------------ */

export type ConsentPurpose =
  /** Campaigns, offers, newsletters. The one that needs consent. */
  | "marketing"
  /** Order confirmations, dispatch notes, payment receipts. */
  | "transactional"
  /** Support and service messages about something already bought. */
  | "service"
  /** Building a profile or scoring behaviour. */
  | "profiling"
  /** ⚠️ A blanket record. Powerful as a withdrawal, weak as a grant. */
  | "all";

export type ConsentChannel = "all" | "whatsapp" | "email" | "sms" | "call" | "post";

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  "marketing",
  "transactional",
  "service",
  "profiling",
  "all",
] as const;

export const CONSENT_CHANNELS: readonly ConsentChannel[] = [
  "all",
  "whatsapp",
  "email",
  "sms",
  "call",
  "post",
] as const;

export type ConsentRecord = {
  id: string;
  purpose: ConsentPurpose;
  channel: ConsentChannel;
  state: "granted" | "withdrawn";
  /** 🔴 A grant with no notice is not evidence of anything. */
  noticeId: string | null;
  /** ISO timestamps. */
  grantedAt: string | null;
  withdrawnAt: string | null;
};

export type ConsentVerdict = {
  allowed: boolean;
  /** The record that decided it, where one did. */
  decidedBy: string | null;
  reason: string;
  /** ⚠️ Set where the answer is "no" for a reason worth acting on. */
  remedy?: string;
};

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

function covers(recorded: ConsentPurpose, asked: ConsentPurpose): boolean {
  return recorded === "all" || recorded === asked;
}

function channelCovers(recorded: ConsentChannel, asked: ConsentChannel): boolean {
  return recorded === "all" || recorded === asked;
}

/**
 * ⭐⭐ MAY WE SEND THIS, TO THIS PERSON, ON THIS CHANNEL, FOR THIS
 *     PURPOSE?
 *
 * 🔴 THE ORDER IS THE WHOLE ALGORITHM.
 *
 *   1. Any withdrawal that covers this purpose and channel → **no**,
 *      and it does not matter what else is on file.
 *   2. A grant that covers both, and names a notice → yes.
 *   3. Anything else → **no**. Silence is not consent.
 *
 * ⚠️ Step 1 comes before step 2 deliberately, and it is not a
 * chronological comparison. A withdrawal is not outranked by an older
 * grant OR by a newer one, because 0061 refuses to record a new grant
 * over a withdrawal without a fresh notice: the only way a person is
 * back on the list is a genuinely new consent row.
 */
export function mayContact(args: {
  records: readonly ConsentRecord[];
  purpose: ConsentPurpose;
  channel: ConsentChannel;
  /**
   * ⭐ Transactional messages about something the person actually
   * bought do not need marketing consent. Passing this says the caller
   * has a live contractual reason to be in touch.
   *
   * 🔴 It does NOT unlock marketing. The purpose asked for still has to
   * be transactional or service, because "we have a contract" is the
   * excuse every firm reaches for when it wants to send an offer.
   */
  hasLegitimateContractualBasis?: boolean;
}): ConsentVerdict {
  if (args.purpose === "all") {
    throw new ConsentError(
      "'all' is a state a person can be in, not a question you can ask. Ask about a specific purpose.",
    );
  }

  /* ① A withdrawal covering this beats everything. */
  for (const r of args.records) {
    if (r.state !== "withdrawn") continue;
    if (!covers(r.purpose, args.purpose)) continue;
    if (!channelCovers(r.channel, args.channel)) continue;
    return {
      allowed: false,
      decidedBy: r.id,
      reason:
        r.channel === "all" && r.purpose === "all"
          ? `This person withdrew consent entirely${r.withdrawnAt ? ` on ${r.withdrawnAt.slice(0, 10)}` : ""}. That covers every channel and every purpose, including this one.`
          : `Consent for ${labelPurpose(r.purpose)} on ${labelChannel(r.channel)} was withdrawn${r.withdrawnAt ? ` on ${r.withdrawnAt.slice(0, 10)}` : ""}.`,
      remedy:
        "A withdrawal cannot be reversed by editing it. If they have agreed again, record a new consent against the notice they were shown this time.",
    };
  }

  /* ② A grant that covers it, and names its notice. */
  for (const r of args.records) {
    if (r.state !== "granted") continue;
    if (!covers(r.purpose, args.purpose)) continue;
    if (!channelCovers(r.channel, args.channel)) continue;
    if (r.noticeId === null) {
      /**
       * 🔴 IGNORED, NOT ACCEPTED. A grant with no notice behind it says
       * somebody agreed and does not say what to. That is the exact
       * thing an inspection asks to see, and it is not there.
       */
      continue;
    }
    return {
      allowed: true,
      decidedBy: r.id,
      reason: `Consent for ${labelPurpose(r.purpose)} on ${labelChannel(r.channel)} was given${r.grantedAt ? ` on ${r.grantedAt.slice(0, 10)}` : ""}, against a recorded notice.`,
    };
  }

  /* ③ A contractual basis, for the narrow purposes it actually covers. */
  if (
    args.hasLegitimateContractualBasis &&
    (args.purpose === "transactional" || args.purpose === "service")
  ) {
    return {
      allowed: true,
      decidedBy: null,
      reason:
        "This is a message about something the person is actually buying or has bought, not a campaign. A dispatch note or a payment receipt is part of performing the contract.",
    };
  }

  /* ④ Silence. */
  const hasUnevidenced = args.records.some(
    (r) => r.state === "granted" && r.noticeId === null,
  );
  return {
    allowed: false,
    decidedBy: null,
    reason: hasUnevidenced
      ? "There is a consent record for this person but it does not name the notice they were shown, so it is not evidence that they agreed to anything. It has been ignored."
      : "Nothing on file. Silence is not consent, so the answer is no.",
    remedy: hasUnevidenced
      ? "Ask again and record the consent properly, against the notice actually shown."
      : "Ask, show the notice, and record what they said.",
  };
}

function labelPurpose(p: ConsentPurpose): string {
  return p === "all" ? "every purpose" : p;
}
function labelChannel(c: ConsentChannel): string {
  return c === "all" ? "every channel" : c;
}

/* ------------------------------------------------------------------ */
/* THE LIST, BEFORE IT IS SENT                                         */
/* ------------------------------------------------------------------ */

export type AudienceMember<T> = { party: T; records: readonly ConsentRecord[] };

export type AudienceSplit<T> = {
  reachable: readonly T[];
  excluded: readonly { party: T; reason: string }[];
  /** ⭐ For the counter on the campaign screen. */
  reachableCount: number;
  excludedCount: number;
  /** 🔴 How many were dropped for having no record at all. */
  noRecordCount: number;
  /** 🔴 How many actively said stop. */
  withdrawnCount: number;
};

/**
 * ⭐⭐ SPLIT AN AUDIENCE, AND KEEP THE REASONS.
 *
 * 🔴 THE EXCLUSIONS ARE RETURNED, NOT DISCARDED. A campaign screen that
 *    quietly shows "3,000 recipients" when the list had 9,000 in it is
 *    how a firm spends a year wondering why its reach fell. The two
 *    reasons are also counted apart, because they need different
 *    actions: nobody-asked-them is a data collection problem, and
 *    they-said-stop is not a problem at all.
 */
export function splitAudience<T>(args: {
  members: readonly AudienceMember<T>[];
  purpose: ConsentPurpose;
  channel: ConsentChannel;
}): AudienceSplit<T> {
  const reachable: T[] = [];
  const excluded: { party: T; reason: string }[] = [];
  let noRecord = 0;
  let withdrawn = 0;

  for (const m of args.members) {
    const v = mayContact({
      records: m.records,
      purpose: args.purpose,
      channel: args.channel,
    });
    if (v.allowed) {
      reachable.push(m.party);
      continue;
    }
    excluded.push({ party: m.party, reason: v.reason });
    if (v.decidedBy === null) noRecord += 1;
    else withdrawn += 1;
  }

  return {
    reachable,
    excluded,
    reachableCount: reachable.length,
    excludedCount: excluded.length,
    noRecordCount: noRecord,
    withdrawnCount: withdrawn,
  };
}

/* ------------------------------------------------------------------ */
/* WHAT A SEND WOULD COST                                              */
/* ------------------------------------------------------------------ */

/**
 * 🔴 WHATSAPP MARKETING IS CHARGED PER MESSAGE DELIVERED IN INDIA,
 *    AND IT IS NOT CHEAP.
 *
 * ⚠️ TWO CORRECTIONS MADE IN v1.14.0, WHEN SOMETHING FINALLY SENT.
 *
 * ① Per-message billing replaced conversation billing on **1 July
 *    2025**, not 1 January 2026. This file had the wrong date from the
 *    day it was written and nothing depended on it until now.
 *
 * ② 🔴 **META CHARGES ON DELIVERY, NOT ON SEND.** "You are only charged
 *    when a template message is delivered." So the sentence below about
 *    money being "spent the instant somebody clicks send" is wrong, and
 *    the difference is not academic: a send to a number that no longer
 *    has WhatsApp costs nothing, and a spend ceiling that counts
 *    attempts stops a business from sending messages it was never going
 *    to be billed for.
 *
 * Marketing is roughly ₹1.09 a message and is never free. Utility is
 * roughly ₹0.145 and is free inside the 24 hour service window opened
 * by the customer messaging first.
 *
 * ⚠️ A campaign to 10,000 people costs up to about ₹10,900. So the cost
 * is ESTIMATED before the send and shown on the button, and the actual
 * figure is written from the delivery receipts afterwards. `message_sends.cost_minor`
 * in 0066 is NULL until a message is delivered, and a CHECK refuses a
 * cost on anything that was not.
 *
 * ⭐ THE RATES ARE ARGUMENTS, NOT CONSTANTS. They change, they differ by
 * country, and a stale rate baked into a release is the same mistake as
 * a stale court fee slab. `DEFAULT_RATES` is a starting point the tenant
 * overrides.
 */
export type MessageCategory = "marketing" | "utility" | "authentication" | "service";

export const DEFAULT_RATES_MINOR: Readonly<Record<MessageCategory, bigint>> = {
  /** ₹1.09 */
  marketing: 109n,
  /** ₹0.145, rounded up to the paisa. */
  utility: 15n,
  authentication: 15n,
  service: 0n,
};

export type SendEstimate = {
  recipients: number;
  category: MessageCategory;
  perMessageMinor: bigint;
  totalMinor: bigint;
  /** ⭐ How many are free because a service window is already open. */
  freeCount: number;
  chargeableCount: number;
  warning: string | null;
};

export function estimateSendCost(args: {
  recipients: number;
  category: MessageCategory;
  /** How many have an open 24 hour service window right now. */
  insideServiceWindow?: number;
  ratesMinor?: Readonly<Record<MessageCategory, bigint>>;
  /** ⚠️ Warn above this. Default ₹5,000. */
  warnAboveMinor?: bigint;
}): SendEstimate {
  if (!Number.isInteger(args.recipients) || args.recipients < 0) {
    throw new ConsentError("A recipient count must be a whole number, zero or more.");
  }
  const inWindow = Math.min(
    Math.max(0, Math.trunc(args.insideServiceWindow ?? 0)),
    args.recipients,
  );
  const rates = args.ratesMinor ?? DEFAULT_RATES_MINOR;
  const per = rates[args.category];
  if (per === undefined || per < 0n) {
    throw new ConsentError("A message rate must be zero or more.");
  }

  /**
   * 🔴 ONLY UTILITY AND SERVICE ARE FREE INSIDE THE WINDOW. Marketing
   * and authentication are charged whatever the window says, and
   * treating the window as a general discount is how an estimate comes
   * out at a seventh of the real bill.
   */
  const freeInWindow =
    args.category === "utility" || args.category === "service" ? inWindow : 0;
  const chargeable = args.recipients - freeInWindow;
  const total = BigInt(chargeable) * per;

  const warnAt = args.warnAboveMinor ?? 500_000n;
  const warning =
    total > warnAt
      ? `This send costs about ${formatMinor(total)}. It is spent the moment it goes, and it cannot be recalled.`
      : args.category === "marketing" && args.recipients > 0
        ? "Marketing messages are never free, whatever the service window says."
        : null;

  return {
    recipients: args.recipients,
    category: args.category,
    perMessageMinor: per,
    totalMinor: total,
    freeCount: freeInWindow,
    chargeableCount: chargeable,
    warning,
  };
}

/* ------------------------------------------------------------------ */

export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, "0");
  const whole = digits.slice(0, -2);
  const frac = digits.slice(-2);
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return `${negative ? "-" : ""}₹${grouped}.${frac}`;
}
