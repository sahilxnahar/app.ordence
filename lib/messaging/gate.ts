/**
 * Ordence — ⭐⭐⭐ THE ONE ANSWER TO "MAY THIS MESSAGE GO"
 * Version: v1.14.0-alpha
 *
 * Pure. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 FIVE SEPARATE REASONS A MESSAGE MUST NOT GO, AND ANY ONE OF THEM
 *    IS ENOUGH
 * ══════════════════════════════════════════════════════════════════════
 *   ① They withdrew consent, or never gave it.
 *   ② The template is not approved, or is paused.
 *   ③ There is no open window and this is not a template.
 *   ④ The daily ceiling is reached.
 *   ⑤ We have already sent this exact message.
 *
 * ⚠️ SCATTERED ACROSS FIVE CALL SITES, ONE OF THEM WILL BE MISSED — and
 * it will be missed in whichever path was written last and tested least,
 * which is always the automated one that sends at three in the morning.
 *
 * ⭐ SO THERE IS ONE FUNCTION, IT IS PURE, AND EVERY SEND PATH CALLS IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE ORDER OF THE CHECKS IS THE ORDER OF THE CONSEQUENCES
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSENT IS FIRST, ALWAYS. Not because it is cheapest to check, but
 * because it is the only one where proceeding is a legal wrong rather
 * than an expense. A message that a paused template would have blocked
 * anyway is still a message somebody asked us never to send.
 *
 * ⭐ AND THE DUPLICATE CHECK IS LAST, because "we already sent this" is
 * a fact about our records, and it is the least interesting answer to
 * give somebody who is not allowed to send it at all.
 */

import {
  categoryDrifted,
  mayUseTemplate,
  willBeCharged,
  type MessageCategory,
  type ServiceWindow,
  type TemplateSnapshot,
} from "./window";

export type RefusalCode =
  | "no_consent"
  | "template_unusable"
  | "no_window"
  | "cap_reached"
  | "already_sent"
  | "no_number";

export interface SendVerdict {
  readonly maySend: boolean;
  readonly refusalCode: RefusalCode | null;
  /** In words the customer reads on a screen. */
  readonly reason: string;
  readonly actionRequired: string | null;
  /** ⭐ Whether the money will actually be spent. */
  readonly chargeable: boolean;
  readonly costReason: string;
  /** Warnings that do not block, but that somebody should see. */
  readonly warnings: readonly string[];
}

export interface SendRequest {
  readonly category: MessageCategory;
  readonly template: TemplateSnapshot | null;
  readonly window: ServiceWindow | null;
  /** From `lib/crm/consent.ts`. `true` where contact is permitted. */
  readonly consentAllows: boolean;
  readonly consentReason: string;
  readonly toPhoneDigits: string | null;
  /** Already sent under the same idempotency key. */
  readonly alreadySent: boolean;
  readonly caps: {
    readonly sentToday: number;
    readonly spentTodayMinor: bigint;
    readonly dailySendCap: number | null;
    readonly dailySpendCapMinor: bigint | null;
  };
}

export function maySendMessage(req: SendRequest, now: Date): SendVerdict {
  const warnings: string[] = [];
  const charge = willBeCharged(req.category, req.window, now);

  const base = {
    chargeable: charge.chargeable,
    costReason: charge.reason,
  };

  // ① 🔴 CONSENT, FIRST, ALWAYS. See the header.
  if (!req.consentAllows) {
    return {
      ...base,
      maySend: false,
      refusalCode: "no_consent",
      reason: req.consentReason,
      actionRequired:
        "Nothing may be sent to this person on this channel. If they have asked to hear from you since, record a fresh agreement against the notice they were shown.",
      warnings,
    };
  }

  // ② Somebody to send it to.
  if (!req.toPhoneDigits || req.toPhoneDigits.replace(/\D/g, "").length < 10) {
    return {
      ...base,
      maySend: false,
      refusalCode: "no_number",
      reason: "There is no usable mobile number on this record.",
      actionRequired: "Add a mobile number, or send this by another channel.",
      warnings,
    };
  }

  // ③ The template.
  if (req.category !== "service") {
    if (!req.template) {
      return {
        ...base,
        maySend: false,
        refusalCode: "template_unusable",
        reason: "No approved template was chosen for this message.",
        actionRequired:
          "Pick a template. Outside the 24 hour window WhatsApp allows nothing else.",
        warnings,
      };
    }

    const gate = mayUseTemplate(req.template, now);
    const drift = categoryDrifted(req.template);
    if (drift) warnings.push(drift);
    if (gate.maySend && gate.actionRequired) warnings.push(gate.actionRequired);

    if (!gate.maySend) {
      return {
        ...base,
        maySend: false,
        refusalCode: "template_unusable",
        reason: gate.reason,
        actionRequired: gate.actionRequired,
        warnings,
      };
    }
  }

  // ④ A plain reply outside the window is not expensive. It is impossible.
  if (req.category === "service" && !charge.chargeable && charge.reason.startsWith("Cannot")) {
    return {
      ...base,
      maySend: false,
      refusalCode: "no_window",
      reason: charge.reason,
      actionRequired:
        "Use an approved template instead. A plain message can only be sent within 24 hours of them writing to you.",
      warnings,
    };
  }

  // ⑤ 🔴 THE CEILING. Counted on ATTEMPTS as well as on spend, because
  // spend is billed on delivery and therefore lags — a runaway loop
  // moves the attempt count immediately and the money figure minutes
  // later, by which time it is gone.
  const { caps } = req;
  if (caps.dailySendCap !== null && caps.sentToday >= caps.dailySendCap) {
    return {
      ...base,
      maySend: false,
      refusalCode: "cap_reached",
      reason: `This connection has already sent its daily limit of ${caps.dailySendCap} messages.`,
      actionRequired:
        "Nothing further will go out today. Raise the limit deliberately if that is what you intend.",
      warnings,
    };
  }
  if (
    caps.dailySpendCapMinor !== null &&
    caps.spentTodayMinor >= caps.dailySpendCapMinor
  ) {
    return {
      ...base,
      maySend: false,
      refusalCode: "cap_reached",
      reason: "This connection has reached its daily spend limit.",
      actionRequired:
        "Nothing further will go out today. Raise the limit deliberately if that is what you intend.",
      warnings,
    };
  }

  // ⚠️ APPROACHING THE CEILING IS WORTH SAYING BEFORE IT IS REACHED, so
  // a scheduled run does not stop halfway through with no warning.
  if (caps.dailySendCap !== null && caps.sentToday >= caps.dailySendCap * 0.8) {
    warnings.push(
      `${caps.sentToday} of today's ${caps.dailySendCap} messages have been used.`,
    );
  }

  // ⑥ ⭐ THE LEAST INTERESTING ANSWER, LAST.
  if (req.alreadySent) {
    return {
      ...base,
      maySend: false,
      refusalCode: "already_sent",
      reason: "This exact message has already been sent to this person.",
      actionRequired: null,
      warnings,
    };
  }

  return {
    ...base,
    maySend: true,
    refusalCode: null,
    reason: "Ready to send.",
    actionRequired: null,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* WHAT IT WILL COST, BEFORE                                           */
/* ------------------------------------------------------------------ */

export interface CostEstimate {
  readonly total: number;
  readonly chargeable: number;
  readonly free: number;
  readonly estimatedMinor: bigint;
  /**
   * ⭐ WHAT IS SAVED BY THE WINDOW BEING OPEN, which is the number that
   * changes behaviour. Nobody moves a send earlier because it is
   * "cheaper"; people move it because it is free.
   */
  readonly savedByWindowMinor: bigint;
  readonly note: string;
}

/**
 * 🔴 AN ESTIMATE IS NOT A BILL, AND THIS FUNCTION SAYS SO.
 *
 * ⚠️ Meta charges only on DELIVERY. A send to a number that no longer
 * has WhatsApp costs nothing at all, so the real figure is always lower
 * than this and is written from the delivery receipts.
 */
export function estimateBatch(args: {
  readonly recipients: readonly { insideWindow: boolean; freeEntryPoint: boolean }[];
  readonly category: MessageCategory;
  readonly rateMinor: bigint;
}): CostEstimate {
  let chargeable = 0;
  let free = 0;

  for (const r of args.recipients) {
    const w: ServiceWindow | null = r.insideWindow
      ? {
          openedAt: new Date(0),
          // ⚠️ A far-future expiry stands for "open"; this function is
          // about counting, and the window decision has been made by the
          // caller who knows the clock.
          expiresAt: new Date(8.64e15),
          isFreeEntryPoint: r.freeEntryPoint,
        }
      : null;
    if (willBeCharged(args.category, w, new Date(0)).chargeable) chargeable += 1;
    else free += 1;
  }

  const estimatedMinor = BigInt(chargeable) * args.rateMinor;
  const savedByWindowMinor = BigInt(free) * args.rateMinor;

  return {
    total: args.recipients.length,
    chargeable,
    free,
    estimatedMinor,
    savedByWindowMinor,
    note:
      free > 0
        ? `${free} of these are free because those people messaged you recently. That saves about ${formatMinor(savedByWindowMinor)}.`
        : "None of these fall inside a free window. Sending while a customer is still in conversation costs nothing.",
  };
}

function formatMinor(minor: bigint): string {
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
