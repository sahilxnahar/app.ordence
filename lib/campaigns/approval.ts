/**
 * Ordence — ⭐⭐⭐ WHAT HAS TO BE TRUE BEFORE MONEY LEAVES
 * Version: v1.15.0-alpha
 *
 * Pure. `now` is always an argument.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS IS THE ONLY BUTTON IN ORDENCE THAT SPENDS THOUSANDS OF
 *    RUPEES IN ONE CLICK
 * ══════════════════════════════════════════════════════════════════════
 * Everything else that goes wrong in this system produces a wrong number
 * on a screen, and somebody fixes it. A campaign approved by mistake
 * reaches six thousand people, costs six thousand rupees, and cannot be
 * recalled — and the reputational half of that is worse than the money.
 *
 * ⭐ SO THE APPROVAL ASKS FOR THE AMOUNT TO BE TYPED, not ticked. The
 * same reasoning the tenant-suspension screen already uses for a typed
 * slug: an amount somebody had to read and copy is an amount somebody
 * read.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE APPROVAL IS FOR A SPECIFIC LIST, NOT FOR A CAMPAIGN
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 If the audience is rebuilt, the approval is void. Not "revalidated"
 * — void. The person approved 6,000 messages at ₹6,540, and 6,140
 * messages at ₹6,692 is a different decision that nobody made.
 */

import { formatMinor } from "./audience";

export type ApprovalBlockCode =
  | "no_audience"
  | "empty_audience"
  | "template_unusable"
  | "amount_mismatch"
  | "amount_not_typed"
  | "over_ceiling"
  | "audience_stale"
  | "self_approval";

export interface ApprovalBlock {
  readonly code: ApprovalBlockCode;
  readonly reason: string;
  readonly remedy: string;
}

export interface ApprovalRequest {
  readonly status: string;
  readonly audienceResolvedAt: Date | null;
  readonly includedCount: number;
  readonly estimatedCostMinor: bigint;
  /** What the person typed into the confirmation box. */
  readonly typedAmount: string;
  readonly approverId: string;
  /** ⭐ Who built the audience. */
  readonly createdBy: string | null;
  readonly templateMaySend: boolean;
  readonly templateReason: string;
  /** The connection's daily ceiling, if it has one. */
  readonly dailySendCap: number | null;
  readonly sentTodayCount: number;
  readonly dailySpendCapMinor: bigint | null;
  readonly spentTodayMinor: bigint;
  /**
   * ⚠️ How long a resolved audience may sit before it is stale. A list
   * built on Friday and approved on Monday has three days of withdrawn
   * consents in it.
   */
  readonly staleAfterHours?: number;
  /** Whether this workspace requires a second person. */
  readonly requiresSecondPerson?: boolean;
}

export const DEFAULT_AUDIENCE_STALE_HOURS = 24;

export interface ApprovalVerdict {
  readonly mayApprove: boolean;
  readonly blocks: readonly ApprovalBlock[];
  /** ⭐ Exactly what the person must type. */
  readonly expectedAmount: string;
  readonly warnings: readonly string[];
}

/**
 * ⚠️ THE ORDER IS THE ORDER OF THE CONSEQUENCES, and every block is
 * returned rather than only the first: somebody fixing an approval
 * screen one error at a time gives up, and giving up here means sending
 * it from a phone instead.
 */
export function checkApproval(
  req: ApprovalRequest,
  now: Date,
): ApprovalVerdict {
  const blocks: ApprovalBlock[] = [];
  const warnings: string[] = [];
  const expectedAmount = formatMinor(req.estimatedCostMinor);

  // ① There has to be a resolved list at all.
  if (!req.audienceResolvedAt) {
    blocks.push({
      code: "no_audience",
      reason: "The audience has not been worked out yet.",
      remedy:
        "Build the audience first. Approving a filter is approving a guess at who will receive this.",
    });
  } else {
    /**
     * ⚠️ A LIST BUILT ON FRIDAY AND APPROVED ON MONDAY has three days of
     * withdrawn consents in it, and those withdrawals are the ones that
     * matter most.
     */
    const hours = (now.getTime() - req.audienceResolvedAt.getTime()) / 3_600_000;
    const limit = req.staleAfterHours ?? DEFAULT_AUDIENCE_STALE_HOURS;
    if (hours > limit) {
      blocks.push({
        code: "audience_stale",
        reason: `This audience was worked out ${Math.floor(hours)} hours ago.`,
        remedy:
          "Build it again. Anybody who has withdrawn their consent since is still on this list, and they are exactly the people who must not receive it.",
      });
    }
  }

  if (req.includedCount === 0) {
    blocks.push({
      code: "empty_audience",
      reason: "Nobody in this audience can be messaged.",
      remedy:
        "Look at the exclusion reasons below. Usually it is consent, and usually that is correct.",
    });
  }

  // ② The template.
  if (!req.templateMaySend) {
    blocks.push({
      code: "template_unusable",
      reason: req.templateReason,
      remedy:
        "A campaign cannot be approved against a template that cannot be sent. Fix the template first.",
    });
  }

  // ③ 🔴 THE AMOUNT, TYPED.
  const typed = req.typedAmount.trim();
  if (typed.length === 0) {
    blocks.push({
      code: "amount_not_typed",
      reason: "The amount has not been confirmed.",
      remedy: `Type ${expectedAmount} to confirm. It is deliberately not a tick box: this is the one action in Ordence that spends money it cannot get back.`,
    });
  } else if (!amountsMatch(typed, expectedAmount)) {
    blocks.push({
      code: "amount_mismatch",
      reason: `You typed ${typed} and this campaign costs ${expectedAmount}.`,
      remedy:
        "If the figure surprised you, that is the check working. Look at the audience again before typing it.",
    });
  }

  // ④ ⚠️ THE CEILING FROM 0066, CHECKED BEFORE THE RUN RATHER THAN
  // HALFWAY THROUGH IT.
  //
  // 🔴 A campaign that stops at message 4,000 of 6,000 has told four
  // thousand people about an offer and left two thousand out, which is
  // worse than not sending it at all.
  if (req.dailySendCap !== null) {
    const remaining = req.dailySendCap - req.sentTodayCount;
    if (req.includedCount > remaining) {
      blocks.push({
        code: "over_ceiling",
        reason: `This campaign needs ${req.includedCount} messages and only ${Math.max(0, remaining)} remain under today's limit of ${req.dailySendCap}.`,
        remedy:
          "Raise the daily limit deliberately, or send this tomorrow. A campaign that stops halfway has told some of your customers about an offer and not the others, which is worse than not sending it.",
      });
    }
  }
  if (req.dailySpendCapMinor !== null) {
    const remaining = req.dailySpendCapMinor - req.spentTodayMinor;
    if (req.estimatedCostMinor > remaining) {
      blocks.push({
        code: "over_ceiling",
        reason: `This campaign is estimated at ${expectedAmount} and only ${formatMinor(remaining > 0n ? remaining : 0n)} remains under today's spend limit.`,
        remedy:
          "Raise the limit deliberately, or send it tomorrow. Stopping halfway through is worse than not starting.",
      });
    }
  }

  /**
   * ⑤ ⭐ THE SECOND PAIR OF EYES, WHERE THE WORKSPACE ASKS FOR ONE.
   *
   * ⚠️ Off by default. A one-person firm cannot supply a second person,
   * and a control that makes the product unusable for them is a control
   * they will switch off entirely — including for the case it was meant
   * to catch.
   */
  if (req.requiresSecondPerson && req.createdBy && req.createdBy === req.approverId) {
    blocks.push({
      code: "self_approval",
      reason: "You built this audience, and this workspace asks for a second person to approve a campaign.",
      remedy: "Ask a colleague to look at the list and approve it.",
    });
  }

  // ⚠️ Warnings do not block, and each one is something worth a second
  // look rather than a reason to stop.
  if (req.includedCount > 1000) {
    warnings.push(
      `${req.includedCount} people will receive this. Send it to twenty of them first if you have not seen the wording on a real phone.`,
    );
  }
  if (req.estimatedCostMinor === 0n && req.includedCount > 0) {
    warnings.push(
      "Nothing here is chargeable, which is unusual for a marketing campaign. Check the template category: a utility template sent as a campaign is a policy problem, not a saving.",
    );
  }

  return {
    mayApprove: blocks.length === 0,
    blocks,
    expectedAmount,
    warnings,
  };
}

/**
 * ⚠️ FORGIVING ABOUT FORMATTING, EXACT ABOUT THE NUMBER.
 *
 * ⭐ Somebody typing `6540` or `6,540.00` or `₹6,540.00` has read the
 * figure, which is the thing being tested. Rejecting them on a comma
 * teaches people to copy and paste, which defeats the entire control.
 */
export function amountsMatch(typed: string, expected: string): boolean {
  const normalise = (s: string) => {
    const cleaned = s.replace(/[₹,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const [whole, frac = ""] = cleaned.split(".");
    return `${whole}.${frac.padEnd(2, "0")}`;
  };
  const a = normalise(typed);
  const b = normalise(expected);
  return a !== null && b !== null && a === b;
}

/* ------------------------------------------------------------------ */
/* THE RUN                                                             */
/* ------------------------------------------------------------------ */

export type SendOutcome = "queued" | "sent" | "skipped" | "failed";

/**
 * 🔴🔴 WHATSAPP ERROR 131049: THE PER-USER MARKETING LIMIT.
 *
 * WhatsApp limits how many marketing templates a person receives "when
 * they are less likely to be receptive". The limit is dynamic,
 * personalised, and not published, so no product can predict it.
 *
 * ⚠️ THE MESSAGE COMES BACK FAILED AND UNDELIVERED — and repeated
 * attempts within 24 hours to somebody already at their limit can make
 * further delivery to them **unavailable for up to a day**.
 *
 * ⭐ SO IT IS THE ONE FAILURE THAT MUST NEVER BE RETRIED. A loop that
 * treats "failed" as "try again" turns one undelivered message into a
 * customer nobody can reach until tomorrow. Exactly the shape of the
 * paused-template trap in v1.14.0, and exactly as easy to get wrong.
 */
export const PER_USER_LIMIT_ERROR = "131049";

export interface RetryVerdict {
  readonly retry: boolean;
  readonly reason: string;
}

export function shouldRetry(errorCode: string | null): RetryVerdict {
  if (errorCode === PER_USER_LIMIT_ERROR) {
    return {
      retry: false,
      reason:
        "This person has received as many marketing messages as WhatsApp will currently deliver to them. Trying again makes it worse: repeated attempts can block delivery to them for a further day.",
    };
  }
  if (errorCode === "131026" || errorCode === "131047") {
    return {
      retry: false,
      reason:
        "This number cannot receive the message. Retrying will not change that.",
    };
  }
  if (errorCode === "131056" || errorCode === "80007") {
    return {
      retry: true,
      reason: "WhatsApp is rate limiting us. The remaining messages continue at a slower pace.",
    };
  }
  return {
    retry: false,
    reason:
      "Recorded and not retried. A marketing message that failed once is not worth risking a second charge and a second complaint.",
  };
}
