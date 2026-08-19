/**
 * Ordence — ⭐⭐⭐ WHO IS IN, WHO IS OUT, AND WHY
 * Version: v1.15.0-alpha
 *
 * Pure. `now` is always an argument. No database, no network.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE AUDIENCE IS RESOLVED ONCE AND KEPT AS ROWS
 * ══════════════════════════════════════════════════════════════════════
 * Every marketing tool stores the FILTER and re-runs it when the send
 * starts. The list that goes out is then not the list that was approved:
 * somebody enquires in the twenty minutes between, matches the filter,
 * and receives a campaign nobody decided to send them.
 *
 * ⚠️ AND IT IS NOT A COUNTING ERROR. The person approving approved a
 * specific number of messages at a specific cost, and this is the one
 * place in the system where being wrong spends money that cannot be got
 * back.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ EVERY EXCLUSION IS A ROW, WITH ITS REASON
 * ══════════════════════════════════════════════════════════════════════
 * A list of 9,000 that becomes 6,000 is a list where 3,000 people were
 * dropped for reasons nobody saw. Some are correct ("they withdrew
 * consent"). Some are a data problem worth fixing ("no mobile number").
 * Some are a decision somebody may disagree with ("already messaged this
 * week").
 *
 * 🔴 A SILENT EXCLUSION IS HOW A FIRM DISCOVERS IT HAS BEEN MAILING
 * 6,000 PEOPLE INSTEAD OF 9,000 FOR A YEAR.
 */

import { mayContact, type ConsentRecord } from "@/lib/crm/consent";
import { willBeCharged, type ServiceWindow } from "@/lib/messaging/window";

export type ExclusionCode =
  | "no_consent"
  | "no_number"
  | "duplicate_number"
  | "recently_messaged"
  | "suppressed"
  | "quiet_hours";

export interface AudienceCandidate {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly consents: readonly ConsentRecord[];
  /** Their open window, if any. Decides whether this one is free. */
  readonly window: ServiceWindow | null;
  /** When they were last sent a marketing message. Null if never. */
  readonly lastMarketingAt: Date | null;
  /** ⚠️ A hard suppression, set by a person. Outranks everything. */
  readonly suppressed?: boolean;
}

export interface ResolvedRecipient {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly displayName: string | null;
  readonly phoneDigits: string | null;
  readonly isIncluded: boolean;
  readonly exclusionCode: ExclusionCode | null;
  readonly exclusionReason: string | null;
  readonly insideServiceWindow: boolean;
  readonly estimatedCostMinor: bigint;
}

export interface AudienceSummary {
  readonly recipients: readonly ResolvedRecipient[];
  readonly included: number;
  readonly excluded: number;
  readonly estimatedCostMinor: bigint;
  readonly freeCount: number;
  /** ⭐ Excluded, grouped, so the screen shows the shape of the loss. */
  readonly exclusionsByCode: Readonly<Record<string, number>>;
  /** The sentence the approval screen leads with. */
  readonly headline: string;
}

/**
 * ⭐ THE DEFAULT GAP BETWEEN MARKETING MESSAGES TO ONE PERSON.
 *
 * 🔴 NOT A LIMIT WE INVENTED FOR TIDINESS. WhatsApp itself limits how
 * many marketing templates a user receives "when they are less likely to
 * be receptive" — a dynamic, personalised cap we cannot predict — and a
 * message that hits it comes back as **error 131049, undelivered**.
 *
 * ⚠️ WORSE, RETRYING INTO IT IS PUNISHED: repeated attempts within 24
 * hours to users already at their limit can make further delivery to
 * them unavailable for up to a day. So the safest thing a product can do
 * is not go near it, and seven days is a gap no reasonable campaign
 * needs to breach.
 */
export const DEFAULT_MARKETING_GAP_DAYS = 7;

export function resolveAudience(args: {
  readonly candidates: readonly AudienceCandidate[];
  readonly rateMinor: bigint;
  readonly now: Date;
  readonly marketingGapDays?: number;
  /**
   * ⚠️ Quiet hours in IST, as [fromHour, toHour). A marketing message at
   * six in the morning is a complaint, and a complaint is what pauses
   * the template.
   */
  readonly quietHours?: readonly [number, number] | null;
}): AudienceSummary {
  const gapDays = args.marketingGapDays ?? DEFAULT_MARKETING_GAP_DAYS;
  const seenNumbers = new Set<string>();
  const recipients: ResolvedRecipient[] = [];

  for (const c of args.candidates) {
    const digits = (c.phone ?? "").replace(/\D/g, "").slice(-10);

    const base = {
      subjectType: c.subjectType,
      subjectId: c.subjectId,
      displayName: c.displayName,
      phoneDigits: digits.length === 10 ? digits : null,
      insideServiceWindow: Boolean(
        c.window && c.window.expiresAt.getTime() > args.now.getTime(),
      ),
    };

    const exclude = (
      code: ExclusionCode,
      reason: string,
    ): ResolvedRecipient => ({
      ...base,
      isIncluded: false,
      exclusionCode: code,
      exclusionReason: reason,
      estimatedCostMinor: 0n,
    });

    /**
     * 🔴 A HARD SUPPRESSION IS CHECKED FIRST AND OUTRANKS EVERYTHING,
     * including a live consent record. It is set by a person who had a
     * reason, and a system that lets a later automated grant override it
     * is a system that will message somebody who complained in writing.
     */
    if (c.suppressed) {
      recipients.push(
        exclude(
          "suppressed",
          "Somebody put a hold on messaging this contact. That outranks any consent record.",
        ),
      );
      continue;
    }

    /**
     * ⚠️ CONSENT SECOND, AND BEFORE THE PRACTICAL CHECKS, because it is
     * the only one where proceeding is a legal wrong rather than a
     * wasted message.
     *
     * 🔴 AND `hasLegitimateContractualBasis` IS NOT PASSED. This is
     * marketing. "We have a contract" is the excuse every firm reaches
     * for when it wants to send an offer, and the intake in 0065
     * deliberately recorded only the narrow basis.
     */
    const consent = mayContact({
      records: c.consents,
      channel: "whatsapp",
      purpose: "marketing",
    });
    if (!consent.allowed) {
      recipients.push(exclude("no_consent", consent.reason));
      continue;
    }

    if (!base.phoneDigits) {
      recipients.push(
        exclude(
          "no_number",
          "There is no usable mobile number on this record. Worth fixing: this person agreed to hear from you and cannot.",
        ),
      );
      continue;
    }

    /**
     * ⭐ THE SAME NUMBER TWICE IS ONE PERSON WITH TWO RECORDS, and
     * sending twice is the complaint that pauses the template.
     *
     * ⚠️ Excluded rather than merged. Merging two records is destructive
     * and belongs behind a person's decision, which `canMerge` in 0061
     * exists for and this deliberately does not call.
     */
    if (seenNumbers.has(base.phoneDigits)) {
      recipients.push(
        exclude(
          "duplicate_number",
          "Another record in this audience has the same mobile number. Only one message goes to a number; the duplicate records are worth merging afterwards.",
        ),
      );
      continue;
    }

    /**
     * 🔴 THE GAP. See `DEFAULT_MARKETING_GAP_DAYS`: this is not
     * tidiness, it is staying away from a limit WhatsApp enforces
     * invisibly and punishes retries against.
     */
    if (c.lastMarketingAt) {
      const days = (args.now.getTime() - c.lastMarketingAt.getTime()) / 86_400_000;
      if (days < gapDays) {
        recipients.push(
          exclude(
            "recently_messaged",
            `They were sent a marketing message ${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} ago. WhatsApp quietly limits how many a person receives, and a message that hits that limit is not delivered and cannot be usefully retried.`,
          ),
        );
        continue;
      }
    }

    /**
     * ⚠️ QUIET HOURS. A marketing message at six in the morning is a
     * complaint, and complaints are what pause a template permanently.
     */
    if (args.quietHours) {
      const hour = istHour(args.now);
      const [from, to] = args.quietHours;
      const quiet = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
      if (quiet) {
        recipients.push(
          exclude(
            "quiet_hours",
            `It is ${hour}:00 in India, inside the quiet hours set for this workspace. A marketing message now is a complaint, and complaints are what get a template paused.`,
          ),
        );
        continue;
      }
    }

    seenNumbers.add(base.phoneDigits);

    // ⭐ Marketing is charged inside an ordinary window and free only
    // inside a free entry point one.
    const charge = willBeCharged("marketing", c.window, args.now);

    recipients.push({
      ...base,
      isIncluded: true,
      exclusionCode: null,
      exclusionReason: null,
      estimatedCostMinor: charge.chargeable ? args.rateMinor : 0n,
    });
  }

  const included = recipients.filter((r) => r.isIncluded);
  const excluded = recipients.filter((r) => !r.isIncluded);
  const estimatedCostMinor = included.reduce(
    (a, r) => a + r.estimatedCostMinor,
    0n,
  );
  const freeCount = included.filter((r) => r.estimatedCostMinor === 0n).length;

  const exclusionsByCode: Record<string, number> = {};
  for (const r of excluded) {
    const key = r.exclusionCode ?? "unknown";
    exclusionsByCode[key] = (exclusionsByCode[key] ?? 0) + 1;
  }

  return {
    recipients,
    included: included.length,
    excluded: excluded.length,
    estimatedCostMinor,
    freeCount,
    exclusionsByCode,
    headline: headlineFor(
      args.candidates.length,
      included.length,
      excluded.length,
      estimatedCostMinor,
    ),
  };
}

/**
 * 🔴 THE SENTENCE THE APPROVAL SCREEN LEADS WITH, and it names the
 * shrinkage before it names the money.
 *
 * ⚠️ "6,000 recipients · ₹6,540" is the number every tool shows and it
 * hides the only interesting fact, which is that three thousand people
 * were dropped.
 */
export function headlineFor(
  candidates: number,
  included: number,
  excluded: number,
  costMinor: bigint,
): string {
  if (candidates === 0) return "This audience is empty.";
  if (included === 0) {
    return `None of these ${candidates} people can be messaged. Nothing will be sent.`;
  }
  const money = formatMinor(costMinor);
  if (excluded === 0) {
    return `${included} people, about ${money}.`;
  }
  return `${included} of ${candidates} people, about ${money}. ${excluded} will not be messaged, and the reasons are listed below.`;
}

function istHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(d),
  );
}

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
