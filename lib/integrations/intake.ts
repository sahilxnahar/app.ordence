/**
 * Ordence — ⭐⭐⭐ WHAT AN ARRIVING ENQUIRY BECOMES
 * Version: v1.13.0-alpha
 *
 * Pure. `now` is always an argument. No database, no network.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 A LEAD IN A LIST NOBODY OPENS IS A LEAD NOBODY RINGS
 * ══════════════════════════════════════════════════════════════════════
 * This is the whole argument for the batch. Every business on the
 * industry list already receives IndiaMART enquiries; they arrive as an
 * email and a phone notification and they get answered when somebody
 * happens to look. The value of importing them is not the row. It is
 * that the row turns into something on a person's day, with a time on
 * it, that shows up as overdue when it is not done.
 *
 * ⭐ 0060 BUILT TASKS. 0061 BUILT THE TIMELINE AND CONSENT. 0064 BUILT
 * THE FRAME. This file is the sentence that joins them.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE FIRST HOUR IS THE PRODUCT
 * ══════════════════════════════════════════════════════════════════════
 * A buyer who sends an IndiaMART enquiry has almost always sent the same
 * enquiry to four other sellers in the same minute — the platform
 * encourages exactly that. The one who rings first is usually the one
 * who gets the order, and the gap that matters is measured in minutes.
 *
 * 🔴 A MISSED CALL IS MORE URGENT STILL. Somebody who actually rang and
 * did not get through has already tried hardest, and is the enquiry most
 * likely to be gone by tomorrow.
 */

import type { NormalisedEnquiry } from "./adapters/types";

/* ------------------------------------------------------------------ */
/* URGENCY                                                             */
/* ------------------------------------------------------------------ */

export type IntakePriority = "urgent" | "high" | "normal";

export interface IntakePlan {
  readonly title: string;
  readonly detail: string;
  readonly priority: IntakePriority;
  /** ⚠️ A moment, not a day. "Today" is not an answer for a lead. */
  readonly dueAt: Date;
  readonly dueOn: string;
  /** What the timeline entry says. */
  readonly activitySummary: string;
  readonly activityKind: string;
}

/**
 * ⭐ THE DEFAULT IS SIXTY MINUTES AND IT IS THE TENANT'S TO CHANGE.
 * 0065 puts it on the connection with a floor of five minutes and a
 * ceiling of a week, so it cannot be set to something meaningless.
 */
export const DEFAULT_INTAKE_MINUTES = 60;

/**
 * ⚠️ A MISSED CALL GETS A QUARTER OF THE TIME, whatever the setting.
 *
 * 🔴 Not an independent setting, because two dials produce a
 * configuration nobody understands and one of them ends up wrong. It is
 * a fraction of the one number the tenant chose, so raising that raises
 * both and the relationship survives.
 */
export const MISSED_CALL_FRACTION = 0.25;

export function planIntake(
  enquiry: NormalisedEnquiry,
  now: Date,
  options: {
    readonly dueMinutes?: number;
    readonly connectorLabel: string;
    readonly istDay: (d: Date) => string;
  },
): IntakePlan {
  const base = options.dueMinutes ?? DEFAULT_INTAKE_MINUTES;

  const isMissed = enquiry.enquiryKind === "missed_call";
  const isCall = enquiry.enquiryKind === "phone_call";

  const minutes = isMissed
    ? Math.max(5, Math.round(base * MISSED_CALL_FRACTION))
    : base;

  const dueAt = new Date(now.getTime() + minutes * 60_000);

  const who = enquiry.name ?? enquiry.companyName ?? enquiry.phone ?? "a new enquiry";
  const about = enquiry.interestLabel ? ` about ${enquiry.interestLabel}` : "";

  const title = isMissed
    ? `Call back ${who} — missed call from ${options.connectorLabel}`
    : `Call ${who}${about}`;

  const lines: string[] = [];
  if (enquiry.phone) lines.push(`Phone: ${enquiry.phone}`);
  if (enquiry.altPhone) lines.push(`Alternate: ${enquiry.altPhone}`);
  if (enquiry.email) lines.push(`Email: ${enquiry.email}`);
  if (enquiry.companyName) lines.push(`Company: ${enquiry.companyName}`);
  if (enquiry.city) lines.push(`City: ${[enquiry.city, enquiry.state].filter(Boolean).join(", ")}`);
  if (enquiry.message) lines.push(`\nThey said:\n${enquiry.message}`);

  // ⭐ THE UNMAPPED ANSWERS GO IN THE TASK, not only in a jsonb column
  // nobody opens. On a Meta form the custom question is usually the most
  // useful thing there is.
  const extraKeys = Object.keys(enquiry.extra);
  if (extraKeys.length > 0) {
    lines.push(
      `\nAlso sent:\n${extraKeys.map((k) => `${k}: ${enquiry.extra[k]}`).join("\n")}`,
    );
  }

  return {
    title: title.slice(0, 300),
    detail: lines.join("\n").slice(0, 4000),
    priority: isMissed ? "urgent" : isCall ? "high" : "normal",
    dueAt,
    dueOn: options.istDay(dueAt),
    activitySummary: describeArrival(enquiry, options.connectorLabel),
    activityKind: isMissed || isCall ? "call" : "note",
  };
}

/**
 * ⚠️ THE TIMELINE ENTRY SAYS WHAT ARRIVED AND FROM WHERE, in one line
 * somebody can read six months later without opening anything else.
 */
export function describeArrival(
  enquiry: NormalisedEnquiry,
  connectorLabel: string,
): string {
  const kind =
    enquiry.enquiryKind === "missed_call"
      ? "Missed call"
      : enquiry.enquiryKind === "phone_call"
        ? "Phone enquiry"
        : enquiry.enquiryKind === "form"
          ? "Form submission"
          : "Enquiry";

  const about = enquiry.interestLabel ? ` about ${enquiry.interestLabel}` : "";
  return `${kind} received from ${connectorLabel}${about}.`.slice(0, 500);
}

/* ------------------------------------------------------------------ */
/* THE NAME PROBLEM                                                    */
/* ------------------------------------------------------------------ */

/**
 * 🔴 `leads.name` IS NOT NULL AND HALF OF THESE ENQUIRIES HAVE NO NAME.
 *
 * ⚠️ THE THREE WRONG ANSWERS, all of which ship in real products:
 *
 *   "Unknown"           — a pipeline of identical rows, unsearchable.
 *   "IndiaMART Buyer"   — the placeholder the platform itself sends,
 *                         stored as though it were a person, and mail
 *                         merged into "Dear IndiaMART Buyer".
 *   Refuse the lead     — throwing away a paid enquiry over a blank.
 *
 * ⭐ SO THE FALLBACK IS SOMETHING A HUMAN CAN ACT ON: the company if
 * there is one, otherwise the number they rang from, which is exactly
 * what the salesman needs on the screen anyway. It is never a constant,
 * so two nameless enquiries never look like the same person.
 */
export function displayNameFor(enquiry: NormalisedEnquiry): string {
  if (enquiry.name) return enquiry.name.slice(0, 255);
  if (enquiry.companyName) return enquiry.companyName.slice(0, 255);
  if (enquiry.phone) return enquiry.phone.slice(0, 255);
  if (enquiry.altPhone) return enquiry.altPhone.slice(0, 255);
  if (enquiry.email) return enquiry.email.slice(0, 255);
  // ⚠️ Unreachable: the adapters refuse an enquiry with no contact at
  // all. Kept because `name` is NOT NULL and a crash here would lose the
  // enquiry the whole file exists to save.
  return `Enquiry ${enquiry.externalId}`.slice(0, 255);
}

/* ------------------------------------------------------------------ */
/* CONSENT                                                             */
/* ------------------------------------------------------------------ */

export type ContactBasis = "contract" | "consent" | "none";

/**
 * ⭐⭐ WHAT LAWFUL BASIS AN ARRIVING ENQUIRY GIVES US, AND WHAT IT DOES
 * NOT.
 *
 * 🔴 SOMEBODY WHO SENDS AN ENQUIRY HAS ASKED TO BE CONTACTED ABOUT THAT
 * ENQUIRY. Answering them is the thing they requested, and requiring a
 * separate tick before you may return a buyer's call would be absurd.
 *
 * ⚠️ IT IS NOT CONSENT TO A MARKETING LIST. That is the line every CRM
 * crosses: an imported enquiry becomes a contact, the contact becomes a
 * segment, and eighteen months later somebody who asked one question
 * about pipe fittings is receiving a Diwali campaign they never agreed
 * to. Under the DPDP Act that is a reportable complaint, and the record
 * of "they enquired" is not a defence.
 *
 * ⭐ SO THE INTAKE RECORDS THE NARROW BASIS AND NOTHING WIDER. The
 * campaign work in a later session reads `consents` and will find
 * nothing here, which is correct.
 */
export function basisFromEnquiry(enquiry: NormalisedEnquiry): {
  readonly basis: ContactBasis;
  readonly purpose: string;
  readonly note: string;
} {
  return {
    basis: "contract",
    purpose: "enquiry_response",
    note: `They sent this enquiry themselves${enquiry.occurredAt ? ` on ${enquiry.occurredAt.toISOString()}` : ""}, which is a request to be contacted about it. It is not agreement to a marketing list, and nothing here may be used as one.`,
  };
}
