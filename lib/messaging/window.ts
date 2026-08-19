/**
 * Ordence — ⭐⭐⭐ MAY WE SEND, AND WILL IT COST ANYTHING
 * Version: v1.14.0-alpha
 *
 * Pure. No clock, no database. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE SAME MESSAGE IS FREE OR CHARGED DEPENDING ON A CLOCK
 * ══════════════════════════════════════════════════════════════════════
 * A customer messages the business. That opens a **24 hour customer
 * service window**. Inside it, a utility template is free and a plain
 * reply is free. One minute after it closes, the identical utility
 * template is charged.
 *
 * ⚠️ NOTHING ABOUT THE MESSAGE CHANGES. Only the clock.
 *
 * ⭐ WHICH MAKES THE WINDOW THE ONE OPTIMISATION THAT ACTUALLY SAVES A
 * CUSTOMER MONEY, and no product tells them about it: send the payment
 * reminder while the buyer is still in conversation, and it is free.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ AND THE FREE ENTRY POINT WINDOW IS 72 HOURS, NOT 24
 * ══════════════════════════════════════════════════════════════════════
 * Opened by a click-to-WhatsApp advertisement or a page call-to-action.
 * Inside it **everything is free, including marketing**.
 *
 * ⚠️ A business running those ads has a materially different cost
 * profile from one that does not, and treating both the same either
 * overstates their bill or wastes the window.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 BILLED ON DELIVERY, NOT ON SEND
 * ══════════════════════════════════════════════════════════════════════
 * Meta charges "only when a template message is delivered", per message,
 * since 1 July 2025.
 *
 * ⚠️ SO AN ESTIMATE IS NOT A BILL. A send to a number that no longer has
 * WhatsApp costs nothing. Everything here that returns money returns an
 * ESTIMATE, and the real figure is written from the delivery receipt.
 */

export type MessageCategory = "marketing" | "utility" | "authentication" | "service";

/** Mirrors `message_templates.status` in 0066. */
export type TemplateStatus =
  | "in_review"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled";

export interface ServiceWindow {
  readonly openedAt: Date;
  readonly expiresAt: Date;
  readonly isFreeEntryPoint: boolean;
}

/** The ordinary window a customer's message opens. */
export const SERVICE_WINDOW_HOURS = 24;
/** ⭐ The one an ad click opens. Three times as long, and wider. */
export const FREE_ENTRY_POINT_HOURS = 72;

export function windowFrom(
  lastInboundAt: Date,
  options: { readonly freeEntryPoint?: boolean } = {},
): ServiceWindow {
  const hours = options.freeEntryPoint
    ? FREE_ENTRY_POINT_HOURS
    : SERVICE_WINDOW_HOURS;
  return {
    openedAt: lastInboundAt,
    expiresAt: new Date(lastInboundAt.getTime() + hours * 3_600_000),
    isFreeEntryPoint: options.freeEntryPoint ?? false,
  };
}

export function windowIsOpen(w: ServiceWindow | null, now: Date): boolean {
  return Boolean(w && w.expiresAt.getTime() > now.getTime());
}

/* ------------------------------------------------------------------ */
/* WILL IT COST ANYTHING                                               */
/* ------------------------------------------------------------------ */

export interface ChargeVerdict {
  readonly chargeable: boolean;
  /** Why, in words a customer can read on a screen. */
  readonly reason: string;
}

/**
 * 🔴 THE RULES, AS META STATES THEM.
 *
 *   • Inside a **free entry point** window: everything is free.
 *   • Inside an ordinary service window: **utility** templates and plain
 *     replies are free; marketing and authentication are charged.
 *   • Outside any window: only a template may be sent at all, and it is
 *     charged.
 *
 * ⚠️ `service` HERE MEANS A NON-TEMPLATE REPLY, which can only be sent
 * inside a window in the first place. Outside one it is not expensive;
 * it is impossible.
 */
export function willBeCharged(
  category: MessageCategory,
  window: ServiceWindow | null,
  now: Date,
): ChargeVerdict {
  const open = windowIsOpen(window, now);

  if (open && window?.isFreeEntryPoint) {
    return {
      chargeable: false,
      reason:
        "Free. This person arrived through an ad or a page button, which opens a 72 hour window in which every message is free.",
    };
  }

  if (category === "service") {
    return open
      ? {
          chargeable: false,
          reason: "Free. A plain reply inside the 24 hour window costs nothing.",
        }
      : {
          chargeable: false,
          reason:
            "Cannot be sent. Outside the 24 hour window only an approved template may be sent, not a plain message.",
        };
  }

  if (category === "utility" && open) {
    return {
      chargeable: false,
      reason:
        "Free. This customer messaged you within the last 24 hours, and a utility template inside that window costs nothing.",
    };
  }

  if (category === "utility") {
    return {
      chargeable: true,
      reason:
        "Charged. The 24 hour window has closed. Sending the same reminder while they are still in conversation would be free.",
    };
  }

  return {
    chargeable: true,
    reason:
      category === "marketing"
        ? "Charged. Marketing messages are never free, inside the window or outside it."
        : "Charged. Authentication messages are charged whether or not the window is open.",
  };
}

/* ------------------------------------------------------------------ */
/* MAY WE SEND AT ALL                                                  */
/* ------------------------------------------------------------------ */

export interface TemplateSnapshot {
  readonly name: string;
  readonly status: TemplateStatus;
  readonly category: MessageCategory;
  readonly requestedCategory: MessageCategory | null;
  readonly variableCount: number;
  readonly pausedUntil: Date | null;
  readonly pauseCount: number;
  readonly quality: "green" | "yellow" | "red" | "unknown" | null;
  readonly rejectionReason: string | null;
}

export interface SendGate {
  readonly maySend: boolean;
  readonly reason: string;
  /** ⭐ What a person should do about it. Null where nothing is needed. */
  readonly actionRequired: string | null;
  /** True where waiting will fix it by itself. */
  readonly retryable: boolean;
  readonly retryAfter: Date | null;
}

const ALLOWED: SendGate = {
  maySend: true,
  reason: "Approved and sendable.",
  actionRequired: null,
  retryable: false,
  retryAfter: null,
};

/**
 * 🔴🔴 A PAUSED TEMPLATE IS NOT A FAILED ONE, AND TREATING IT AS ONE IS
 *    HOW A BUSINESS LOSES THE TEMPLATE PERMANENTLY.
 *
 * Meta pauses a template on repeated negative feedback: three hours the
 * first time, six the second, **permanently disabled the third**.
 *
 * ⚠️ A retry loop that treats a pause as a transient error sends into
 * the next pause and reaches `disabled`, which cannot be undone and
 * takes the message with it.
 *
 * ⭐ SO A PAUSE IS RETRYABLE WITH A TIME, AND THE SECOND PAUSE SAYS SO
 * LOUDLY, because the third one is the end of that template.
 */
export function mayUseTemplate(
  template: TemplateSnapshot,
  now: Date,
): SendGate {
  switch (template.status) {
    case "approved":
      break;

    case "in_review":
      return {
        maySend: false,
        reason: `"${template.name}" is still with Meta for approval.`,
        actionRequired:
          "Nothing to do but wait. Approval usually takes minutes, occasionally a day.",
        retryable: true,
        retryAfter: null,
      };

    case "rejected":
      return {
        maySend: false,
        reason: `"${template.name}" was rejected: ${template.rejectionReason ?? "no reason was given"}.`,
        actionRequired:
          "Rewrite the wording and submit it again. Retrying the same text will be rejected again.",
        retryable: false,
        retryAfter: null,
      };

    case "disabled":
      return {
        maySend: false,
        reason: `"${template.name}" has been permanently disabled by Meta.`,
        // 🔴 THE END OF THE ROAD FOR THAT TEMPLATE.
        actionRequired:
          "This cannot be undone. Write a new template with different wording, and treat the feedback that caused it as real: recipients marked these messages as unwanted.",
        retryable: false,
        retryAfter: null,
      };

    case "paused":
      return {
        maySend: false,
        reason:
          template.pauseCount >= 2
            ? `"${template.name}" has been paused twice. A third pause disables it permanently.`
            : `"${template.name}" is paused by Meta until ${template.pausedUntil?.toISOString() ?? "shortly"} because recipients marked it as unwanted.`,
        actionRequired:
          template.pauseCount >= 2
            ? "Change the wording or who receives it before it is sent again. One more pause and this template is gone for good."
            : "It will resume by itself. Sending the same message to the same kind of audience afterwards will pause it again, for longer.",
        retryable: true,
        retryAfter: template.pausedUntil,
      };
  }

  // ⚠️ APPROVED, BUT SITTING ON RED.
  //
  // 🔴 Not blocked — Meta still permits the send — but it is the last
  // warning before a pause, and a product that says nothing here is a
  // product whose customer discovers the problem when the template dies.
  if (template.quality === "red") {
    return {
      maySend: true,
      reason: `"${template.name}" is approved but Meta rates its quality as low.`,
      actionRequired:
        "Recipients are marking these as unwanted. Change the wording or the audience now; the next step is an automatic pause.",
      retryable: false,
      retryAfter: null,
    };
  }

  return ALLOWED;
}

/**
 * ⚠️ META RE-CATEGORISES TEMPLATES, AND THE PRICE FOLLOWS.
 *
 * 🔴 A template written as `utility` that reads like an advertisement is
 * moved to `marketing`, and the identical send silently costs roughly
 * seven times more. Nothing tells the business; the bill does, a month
 * later.
 */
export function categoryDrifted(template: TemplateSnapshot): string | null {
  if (!template.requestedCategory) return null;
  if (template.requestedCategory === template.category) return null;
  return `"${template.name}" was submitted as ${template.requestedCategory} and Meta has classified it as ${template.category}. That changes what each message costs${template.category === "marketing" ? ", and marketing is never free even inside the 24 hour window" : ""}.`;
}
