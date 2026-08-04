/**
 * Ordence — Demand Notice Templates: English
 * Version: v0.38.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ENGLISH IS THE REFERENCE PACK, AND THE OTHER FIVE FOLLOW ITS SHAPE
 * ══════════════════════════════════════════════════════════════════════
 * Not because it is more important — a Kannada notice to a Bengaluru
 * buyer is more likely to be read than an English one — but because the
 * agreement for sale is almost always executed in English, and the
 * translated notices have to say the same things the agreement says.
 *
 * ⚠️ WHAT EVERY LETTER IN EVERY LANGUAGE MUST CONTAIN, AND WHY:
 *
 *   • ⭐ THE TRIGGER. "On completion of the 3rd slab, achieved on …".
 *     A construction-linked demand derives its force from the event, and
 *     "the slab was not cast when you demanded for it" is the buyer's
 *     complete answer to a notice that does not state it.
 *   • ⭐ THE INTEREST BASIS. The rate, the compounding rule, the day
 *     count, the grace. Interest must not compound silently.
 *   • THE AMOUNT IN FIGURES AND IN WORDS. The Indian convention on every
 *     financial instrument, for the same reason as a cheque: a figure can
 *     be altered with a pen.
 *   • ⚠️ "IF YOU HAVE ALREADY PAID, PLEASE IGNORE THIS." Post and
 *     accounting cross. Without that line every crossing produces an
 *     angry phone call, and by the third one the buyer stops reading the
 *     notices at all — which is the failure mode that matters, because
 *     the fourth one is the notice that counts.
 */

import { amountInWordsEnglish } from "../numbers";
import type { NoticeTemplatePack } from "./contract";

export const EN_PACK: NoticeTemplatePack = {
  language: "en",
  version: "1.0.0",
  endonym: "English",
  amountInWords: amountInWordsEnglish,

  demand: {
    subject: "Demand Notice {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
    body: [
      "{{developerName}}",
      "",
      "DEMAND NOTICE",
      "Notice no. {{noticeNumber}}    Date: {{noticeDate}}",
      "",
      "To: {{buyerName}}",
      "Unit: {{unitLabel}}, {{projectName}}",
      "",
      "Dear {{buyerName}},",
      "",
      "This demand is raised under the agreement for sale in respect of the above",
      "unit, upon achievement of the following stage of construction:",
      "",
      "    {{triggerLabel}}",
      "    Achieved on {{triggerAchievedOn}}",
      "",
      "The following amount is now due and payable:",
      "",
      "    Instalment                    {{principalAmount}}",
      "    GST                           {{taxAmount}}",
      "    Total payable                 {{totalAmount}}",
      "",
      "    ({{amountInWords}})",
      "",
      "Payment is due on or before {{dueDate}}.",
      "",
      "{{interestBasis}}",
      "",
      "If payment has already been made, please treat this notice as withdrawn and",
      "let us have the payment details so your account can be updated.",
      "",
      "{{contactLine}}",
    ].join("\n"),
  },

  stages: {
    reminder: {
      subject: "Reminder: {{noticeNumber}} due — {{unitLabel}}, {{projectName}}",
      body: [
        "Dear {{buyerName}},",
        "",
        "This is a reminder that demand notice {{noticeNumber}} dated {{noticeDate}},",
        "raised on {{triggerLabel}} (achieved on {{triggerAchievedOn}}) for unit",
        "{{unitLabel}} at {{projectName}}, fell due on {{dueDate}}.",
        "",
        "    Outstanding                   {{outstandingAmount}}",
        "    Interest to date              {{interestAmount}}",
        "    Payable today                 {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "If payment has already been made, please ignore this reminder and send us",
        "the payment details.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    first_notice: {
      subject: "First notice: {{noticeNumber}} overdue — {{unitLabel}}",
      body: [
        "{{developerName}}",
        "",
        "FIRST NOTICE",
        "In respect of demand notice {{noticeNumber}} dated {{noticeDate}}",
        "",
        "To: {{buyerName}}",
        "Unit: {{unitLabel}}, {{projectName}}",
        "",
        "Demand notice {{noticeNumber}}, raised on {{triggerLabel}} (achieved on",
        "{{triggerAchievedOn}}), fell due on {{dueDate}} and remains unpaid",
        "{{daysOverdue}} days later.",
        "",
        "    Outstanding                   {{outstandingAmount}}",
        "    Interest to date              {{interestAmount}}",
        "    Payable today                 {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "Please remit the amount above, or write to us if any part of it is",
        "disputed, so the position can be settled before it escalates.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    final_notice: {
      subject: "FINAL NOTICE: {{noticeNumber}} — {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "FINAL NOTICE",
        "In respect of demand notice {{noticeNumber}} dated {{noticeDate}}",
        "",
        "To: {{buyerName}}",
        "Unit: {{unitLabel}}, {{projectName}}",
        "",
        "Demand notice {{noticeNumber}}, raised on {{triggerLabel}} (achieved on",
        "{{triggerAchievedOn}}), fell due on {{dueDate}} and is now {{daysOverdue}}",
        "days overdue. A reminder and a first notice have already been sent.",
        "",
        "    Outstanding                   {{outstandingAmount}}",
        "    Interest to date              {{interestAmount}}",
        "    Payable today                 {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "Unless the amount is received, the allotment of the above unit may be",
        "considered for termination in accordance with the agreement for sale and",
        "the Real Estate (Regulation and Development) Act, 2016. If you are in",
        "difficulty, please contact us — a recorded arrangement is always",
        "preferable to a cancellation for both of us.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },

    cancellation_warning: {
      subject:
        "Notice before cancellation of allotment: {{unitLabel}}, {{projectName}}",
      body: [
        "{{developerName}}",
        "",
        "NOTICE BEFORE CANCELLATION OF ALLOTMENT",
        "In respect of demand notice {{noticeNumber}} dated {{noticeDate}}",
        "",
        "To: {{buyerName}}",
        "Unit: {{unitLabel}}, {{projectName}}",
        "",
        "Demand notice {{noticeNumber}}, raised on {{triggerLabel}} (achieved on",
        "{{triggerAchievedOn}}), fell due on {{dueDate}} and is {{daysOverdue}} days",
        "overdue. A reminder, a first notice and a final notice have been sent and",
        "no payment has been received.",
        "",
        "    Outstanding                   {{outstandingAmount}}",
        "    Interest to date              {{interestAmount}}",
        "    Payable today                 {{payableAmount}}",
        "",
        "    ({{amountInWords}})",
        "",
        "{{interestBasis}}",
        "",
        "Take notice that unless the above amount is received, the allotment of the",
        "said unit is liable to be cancelled in accordance with the agreement for",
        "sale, and the consequences provided for in that agreement — including",
        "forfeiture to the extent permitted by law — will follow.",
        "",
        "This notice is issued after consideration of your account and not",
        "automatically. If there is any reason the amount is not payable, or if you",
        "wish to propose a schedule, write to us immediately and it will be",
        "considered before any step is taken.",
        "",
        "{{contactLine}}",
      ].join("\n"),
    },
  },

  interestBasis: {
    sentence: "Interest at {{rate}} per annum, {{rule}}, on the outstanding principal {{from}}, calculated on {{count}}.",
    none: "No interest is charged on this demand.",
    fromDueDate: "from the due date of {{dueDate}}",
    fromGraceEnd:
      "from {{graceEnds}} (a grace period of {{graceDays}} days from the due date of {{dueDate}}, which is not charged)",
    graceCharged:
      "from the due date of {{dueDate}}, charged only if payment is not made within {{graceDays}} days of that date",
    compounding: {
      simple: "simple",
      monthly: "compounded monthly",
      quarterly: "compounded quarterly",
      annual: "compounded annually",
    },
    dayCount: {
      actual_365: "actual days over a 365-day year",
      actual_360: "actual days over a 360-day year",
      thirty_360: "a 30-day month over a 360-day year",
    },
  },
};
