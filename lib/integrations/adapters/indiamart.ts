/**
 * Ordence — ⭐⭐⭐ INDIAMART
 * Version: v1.13.0-alpha
 *
 * Pure. No clock, no network, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ ONE ADAPTER FOR BOTH ROUTES, BECAUSE IT IS ONE PAYLOAD
 * ══════════════════════════════════════════════════════════════════════
 * The pull API answers with `{CODE, STATUS, MESSAGE, TOTAL_RECORDS,
 * RESPONSE: [...]}`. The push API POSTs one of those records on its own.
 * The record is the same record, and `UNIQUE_QUERY_ID` is the same id on
 * both routes.
 *
 * 🔴 WHICH IS WHAT MAKES RUNNING BOTH SAFE. Push is fast and pull is the
 * safety net; every enquiry therefore arrives twice by design, and lands
 * once because 0065 puts a unique index on that id.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 CODE 204 IS NOT AN ERROR AND THIS IS THE BUG EVERYBODY WRITES
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART returns **204 when there are simply no leads in the window**.
 *
 * ⚠️ `if (!response.ok) markFailed()` therefore reports a perfectly
 * healthy quiet Sunday as an outage. Consecutive failures climb, the
 * backoff lengthens, the connection goes `degraded`, and the customer is
 * told their IndiaMART integration is broken because nobody enquired.
 *
 * ⭐ Worse, it is self-confirming: the quieter the account, the more
 * "failures", so the smallest customers get the loudest false alarms.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND 401 MEANS "REGENERATED" MORE OFTEN THAN "WRONG"
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART's own documentation gives 401 as invalid, expired **or
 * regenerated**. In practice the third is the common one: somebody
 * pressed the regenerate button in the seller panel and did not tell
 * anybody. So the message says that, rather than "unauthorised".
 */

import {
  cleanCountryIso,
  cleanEmail,
  cleanName,
  cleanPhone,
  cleanString,
  collectExtra,
  hasSomebodyToContact,
  noContactFailure,
  parseIstish,
  type AdapterOutcome,
  type EnquiryKind,
  type NormalisedEnquiry,
} from "./types";
import type { FailureClass } from "../backoff";

/* ------------------------------------------------------------------ */
/* THE RESPONSE CODES, FROM INDIAMART'S OWN DOCUMENTATION              */
/* ------------------------------------------------------------------ */

export type IndiamartVerdict =
  | { readonly kind: "leads"; readonly records: readonly unknown[] }
  /** ⭐ Not an error. Nobody enquired. */
  | { readonly kind: "empty"; readonly note: string }
  | {
      readonly kind: "error";
      readonly failureClass: FailureClass;
      readonly message: string;
      readonly code: string;
    };

/**
 * 🔴 THE MAP THAT KEEPS A QUIET DAY OUT OF THE FAILURE LOG.
 *
 * ⚠️ Read from IndiaMART's documentation rather than inferred from
 * behaviour. A limit guessed from a 429 is a limit that will be guessed
 * again, differently, next year.
 */
export function classifyIndiamartCode(code: number): IndiamartVerdict | null {
  switch (code) {
    case 200:
      return null; // handled by the caller — there are records to read
    case 204:
      return {
        kind: "empty",
        note: "No enquiries in this window. This is a normal answer, not a fault.",
      };
    case 429:
      return {
        kind: "error",
        failureClass: "rate_limited",
        code: "429",
        message:
          "IndiaMART is limiting how often we may ask. Checking again after the wait it asked for.",
      };
    case 401:
      return {
        kind: "error",
        failureClass: "auth",
        code: "401",
        message:
          "IndiaMART rejected the key. The usual cause is that somebody pressed Regenerate in the seller panel; the new key has to be entered here as well.",
      };
    case 400:
      return {
        kind: "error",
        failureClass: "bad_request",
        code: "400",
        message:
          "IndiaMART refused the dates we asked for. It answers at most seven days at a time, and this is a fault at our end rather than yours.",
      };
    case 500:
      return {
        kind: "error",
        failureClass: "far_end",
        code: "500",
        message: "IndiaMART had a problem at their end. Trying again shortly.",
      };
    default:
      return {
        kind: "error",
        failureClass: "far_end",
        code: String(code),
        message: `IndiaMART answered with an unexpected code (${code}).`,
      };
  }
}

/**
 * ⚠️ THE WRAPPER, WHOSE `CODE` IS IN THE BODY AND NOT ONLY IN THE HTTP
 * STATUS. Reading only the HTTP status is how a 200 carrying `CODE: 401`
 * gets treated as a successful empty run, forever.
 */
export function readIndiamartResponse(
  body: unknown,
  httpStatus: number,
): IndiamartVerdict {
  const doc = asRecord(body);

  const bodyCode = doc ? Number(doc.CODE) : Number.NaN;
  const code = Number.isFinite(bodyCode) ? bodyCode : httpStatus;

  const classified = classifyIndiamartCode(code);
  if (classified) {
    // ⭐ Their own MESSAGE, where they gave one, beats ours.
    if (classified.kind === "error") {
      const theirs = doc ? cleanString(doc.MESSAGE, 300) : null;
      return theirs ? { ...classified, message: `${classified.message} (${theirs})` } : classified;
    }
    return classified;
  }

  const records = doc?.RESPONSE;
  if (!Array.isArray(records)) {
    // ⚠️ A 200 with no array is a shape we do not know. Not "no leads".
    return {
      kind: "error",
      failureClass: "far_end",
      code: "shape",
      message:
        "IndiaMART answered successfully but not in a shape we recognise, so nothing was imported rather than something wrong being imported.",
    };
  }

  // ⭐ An empty array on a 200 is also just a quiet day.
  if (records.length === 0) {
    return { kind: "empty", note: "No enquiries in this window." };
  }

  return { kind: "leads", records };
}

/* ------------------------------------------------------------------ */
/* THE RECORD                                                          */
/* ------------------------------------------------------------------ */

const MAPPED = [
  "UNIQUE_QUERY_ID",
  "QUERY_TYPE",
  "QUERY_TIME",
  "SENDER_NAME",
  "SENDER_MOBILE",
  "SENDER_MOBILE_ALT",
  "SENDER_PHONE",
  "SENDER_PHONE_ALT",
  "SENDER_EMAIL",
  "SENDER_EMAIL_ALT",
  "SENDER_COMPANY",
  "SENDER_ADDRESS",
  "SENDER_CITY",
  "SENDER_STATE",
  "SENDER_PINCODE",
  "SENDER_COUNTRY_ISO",
  "SUBJECT",
  "QUERY_PRODUCT_NAME",
  "QUERY_MESSAGE",
  "QUERY_MCAT_NAME",
  "CALL_DURATION",
  "RECEIVER_MOBILE",
];

/**
 * ⭐ THEIR QUERY TYPES, MAPPED RATHER THAN PASSED THROUGH.
 *
 * ⚠️ A missed call is not a message. Somebody who rang and did not get
 * through needs ringing back today; somebody who sent a product enquiry
 * can be answered with a quotation. Filing both as "enquiry" makes the
 * follow-up list useless, and the difference is already in the payload.
 */
const QUERY_TYPES: Readonly<Record<string, EnquiryKind>> = Object.freeze({
  W: "message", // WhatsApp / web enquiry
  B: "message", // Buy lead
  P: "phone_call", // Phone call
  BIZ: "message",
  PNS: "phone_call", // Pay-and-speak
  WA: "message",
  MISSED: "missed_call",
});

export function parseIndiamartRecord(raw: unknown): AdapterOutcome {
  const rec = asRecord(raw);
  if (!rec) {
    return {
      ok: false,
      reasonCode: "unparseable",
      reason:
        "IndiaMART sent something that is not an enquiry record, so it could not be filed.",
      externalId: null,
    };
  }

  const externalId = cleanString(rec.UNIQUE_QUERY_ID, 200);
  if (!externalId) {
    // 🔴 WITHOUT THEIR ID THERE IS NO WAY TO KNOW WE HAVE SEEN IT BEFORE.
    //
    // ⚠️ Filing it anyway would create a fresh duplicate on every retry,
    // and IndiaMART retries until we accept it. One unfiled enquiry that
    // somebody is told about beats an unbounded number of duplicates.
    return {
      ok: false,
      reasonCode: "unknown_shape",
      reason:
        "This enquiry arrived without IndiaMART's own reference number, so there is no safe way to tell a resend from a new enquiry. It is recorded here rather than filed, because their system retries and we would otherwise create a copy every time.",
      externalId: null,
    };
  }

  const phone = cleanPhone(rec.SENDER_MOBILE) ?? cleanPhone(rec.SENDER_PHONE);
  const altPhone =
    cleanPhone(rec.SENDER_MOBILE_ALT) ?? cleanPhone(rec.SENDER_PHONE_ALT);
  const email = cleanEmail(rec.SENDER_EMAIL) ?? cleanEmail(rec.SENDER_EMAIL_ALT);

  if (!hasSomebodyToContact({ phone, altPhone, email })) {
    return noContactFailure(externalId);
  }

  const queryType = cleanString(rec.QUERY_TYPE, 20)?.toUpperCase() ?? "";
  const callDuration = cleanString(rec.CALL_DURATION, 20);

  // ⭐ A CALL OF ZERO SECONDS IS A MISSED CALL, and it is the one most
  // worth ringing back within the hour.
  const kind: EnquiryKind =
    callDuration !== null && /^0+(:0+)*$/.test(callDuration)
      ? "missed_call"
      : (QUERY_TYPES[queryType] ?? (callDuration ? "phone_call" : "message"));

  const enquiry: NormalisedEnquiry = {
    externalId,
    name: cleanName(rec.SENDER_NAME),
    phone,
    altPhone,
    email,
    companyName: cleanString(rec.SENDER_COMPANY, 255),
    city: cleanString(rec.SENDER_CITY, 160),
    state: cleanString(rec.SENDER_STATE, 160),
    pincode: cleanString(rec.SENDER_PINCODE, 12),
    countryIso: cleanCountryIso(rec.SENDER_COUNTRY_ISO),
    // ⚠️ The product name is the useful one; the subject is often the
    // product name with "Requirement for" glued to the front.
    interestLabel:
      cleanString(rec.QUERY_PRODUCT_NAME, 300) ??
      cleanString(rec.QUERY_MCAT_NAME, 300) ??
      cleanString(rec.SUBJECT, 300),
    message: cleanString(rec.QUERY_MESSAGE, 2000) ?? cleanString(rec.SUBJECT, 2000),
    occurredAt: parseIstish(rec.QUERY_TIME),
    enquiryKind: kind,
    extra: collectExtra(rec, MAPPED),
  };

  return { ok: true, enquiry };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/* ------------------------------------------------------------------ */
/* THE PUSH                                                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴🔴 WHAT WE MUST ANSWER A PUSH WITH, AND WHY IT IS NOT OBVIOUS.
 *
 * IndiaMART expects HTTP 200. It retries at intervals until it gets one,
 * and **deactivates the push entirely after 48 hours of continuous
 * rejection** — after which a person has to switch it back on in their
 * panel.
 *
 * ⚠️ SO A BUG IN OUR HANDLER THAT RETURNS 500 FOR TWO DAYS DOES NOT
 * MERELY DELAY LEADS. IT SILENTLY UNSUBSCRIBES THE CUSTOMER. And nothing
 * on our side reports it, because the requests just stop arriving, which
 * looks exactly like a quiet week.
 *
 * ⭐ THEREFORE: ONCE THE DELIVERY IS DURABLY STORED, WE ANSWER 200 —
 * even if we could not turn it into a lead. The enquiry is safe in
 * `webhook_deliveries`, the failure is visible in
 * `lead_intake_failures`, and it can be filed by hand. Holding the
 * connection open by refusing an enquiry we have already saved risks the
 * whole feed to redeliver something we are not going to parse any better
 * the second time.
 *
 * ⚠️ A NON-200 IS RESERVED FOR THE ONE CASE WHERE A RETRY GENUINELY
 * HELPS: we did not manage to store it.
 */
export function pushAcknowledgement(stored: boolean): {
  status: number;
  body: { status: string; note: string };
} {
  if (stored) {
    return {
      status: 200,
      body: {
        status: "received",
        note: "Stored. Anything that could not be filed automatically is listed on the enquiries screen.",
      },
    };
  }
  return {
    status: 503,
    body: {
      status: "retry",
      note: "Not stored. Please send this enquiry again.",
    },
  };
}
