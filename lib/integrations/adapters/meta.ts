/**
 * Ordence — ⭐⭐⭐ META LEAD ADS
 * Version: v1.13.0-alpha
 *
 * Pure. No clock, no network, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE META WEBHOOK IS NOT A LEAD. IT IS A NOTIFICATION THAT ONE
 *    EXISTS.
 * ══════════════════════════════════════════════════════════════════════
 * The delivery carries `leadgen_id`, `form_id`, `page_id`, `ad_id` and a
 * timestamp. It carries **no name, no phone number and no answers.**
 * Those are fetched afterwards from the Graph API with the
 * `leads_retrieval` permission.
 *
 * ⚠️ WHICH MAKES META THE ONE CONNECTOR WHERE INTAKE IS TWO STEPS, AND
 * WHERE THE SECOND STEP CAN FAIL ON ITS OWN. An expired token turns
 * every arriving enquiry into a notification we acknowledged and a lead
 * we never read — and from the outside, a page full of nothing.
 *
 * ⭐ SO A FETCH FAILURE IS A `lead_intake_failures` ROW CARRYING THE
 * `leadgen_id`, which is enough for a person to open Meta's own Leads
 * Center and get the enquiry by hand. Losing the notification would lose
 * the only trace that somebody enquired at all.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND THE FIELD NAMES ARE THE ADVERTISER'S, NOT META'S
 * ══════════════════════════════════════════════════════════════════════
 * `field_data` is an array of `{name, values}` where `name` is whatever
 * the person who built the instant form typed. `full_name` is the
 * default; `naam`, `your_name` and `contact_person` are all real.
 *
 * 🔴 SO THE MATCH IS ON A LIST OF CANDIDATES PLUS A SHAPE TEST, and
 * anything unmatched is kept as an answer rather than dropped. A custom
 * question is usually the most valuable thing in the form: "how many
 * tonnes per month" tells the salesman more than the name does.
 */

import {
  cleanCountryIso,
  cleanEmail,
  cleanName,
  cleanPhone,
  cleanString,
  hasSomebodyToContact,
  noContactFailure,
  parseIstish,
  type AdapterOutcome,
  type NormalisedEnquiry,
} from "./types";

/* ------------------------------------------------------------------ */
/* THE NOTIFICATION                                                    */
/* ------------------------------------------------------------------ */

export interface LeadgenNotice {
  readonly leadgenId: string;
  readonly formId: string | null;
  readonly pageId: string | null;
  readonly adId: string | null;
  readonly createdAt: Date | null;
}

/**
 * ⭐ ONE DELIVERY MAY CARRY SEVERAL NOTICES. `entry` is an array and so
 * is `changes`, and Meta batches under load — which is exactly when a
 * campaign is working and the leads matter most.
 *
 * ⚠️ Reading `entry[0].changes[0]` is the standard mistake and it drops
 * every enquiry after the first, silently, only under load.
 */
export function parseLeadgenNotices(body: unknown): readonly LeadgenNotice[] {
  const doc = asRecord(body);
  if (!doc) return [];

  // ⚠️ Instagram and WhatsApp deliver on the same webhook. An `object`
  // that is not `page` is not ours, and treating it as a malformed lead
  // would fill the failure list with somebody else's traffic.
  if (cleanString(doc.object, 40) !== "page") return [];

  const entries = Array.isArray(doc.entry) ? doc.entry : [];
  const out: LeadgenNotice[] = [];

  for (const entry of entries) {
    const e = asRecord(entry);
    if (!e) continue;
    const changes = Array.isArray(e.changes) ? e.changes : [];
    for (const change of changes) {
      const c = asRecord(change);
      // ⭐ A page webhook also carries `feed`, `messages` and more.
      if (!c || cleanString(c.field, 40) !== "leadgen") continue;

      const v = asRecord(c.value);
      if (!v) continue;

      const leadgenId = cleanString(v.leadgen_id, 200);
      if (!leadgenId) continue;

      out.push({
        leadgenId,
        formId: cleanString(v.form_id, 200),
        pageId: cleanString(v.page_id, 200) ?? cleanString(e.id, 200),
        adId: cleanString(v.ad_id, 200),
        createdAt: parseIstish(v.created_time),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* THE VERIFICATION HANDSHAKE                                          */
/* ------------------------------------------------------------------ */

export type SubscribeVerdict =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false; readonly reason: string };

/**
 * 🔴 META CONFIRMS AN ENDPOINT BY GETTING IT WITH `hub.verify_token` AND
 * EXPECTING `hub.challenge` ECHOED BACK IN PLAIN TEXT.
 *
 * ⚠️ ECHOING THE CHALLENGE WITHOUT CHECKING THE TOKEN IS THE CLASSIC
 * ERROR, and it lets anybody who finds the address subscribe their own
 * page to it. The comparison is constant-time for the same reason every
 * other secret comparison in this codebase is.
 */
export function verifySubscription(
  params: {
    mode: string | null;
    token: string | null;
    challenge: string | null;
  },
  expectedToken: string | null,
  compare: (a: string, b: string) => boolean,
): SubscribeVerdict {
  if (params.mode !== "subscribe") {
    return { ok: false, reason: "Not a subscription request." };
  }
  if (!expectedToken) {
    return {
      ok: false,
      reason:
        "No verify token is stored for this connection, so the subscription cannot be confirmed. Enter one first.",
    };
  }
  if (!params.token || !compare(expectedToken, params.token)) {
    return { ok: false, reason: "The verify token did not match." };
  }
  if (!params.challenge) {
    return { ok: false, reason: "No challenge was sent to echo back." };
  }
  return { ok: true, challenge: params.challenge };
}

/* ------------------------------------------------------------------ */
/* THE LEAD ITSELF                                                     */
/* ------------------------------------------------------------------ */

const NAME_FIELDS = ["full_name", "name", "your_name", "contact_person", "naam", "first_name"];
const LAST_NAME_FIELDS = ["last_name", "surname"];
const PHONE_FIELDS = ["phone_number", "phone", "mobile", "mobile_number", "contact_number", "whatsapp_number"];
const EMAIL_FIELDS = ["email", "email_address", "work_email"];
const COMPANY_FIELDS = ["company_name", "company", "organisation", "organization", "firm_name"];
const CITY_FIELDS = ["city", "town", "city_name"];
const STATE_FIELDS = ["state", "province", "region"];
const ZIP_FIELDS = ["zip", "post_code", "postal_code", "pin_code", "pincode"];

function matches(name: string, candidates: readonly string[]): boolean {
  const n = name.toLowerCase().replace(/[_\s-]/g, "");
  return candidates.some((c) => c.toLowerCase().replace(/[_\s-]/g, "") === n);
}

/**
 * Parses the Graph API answer for one lead.
 *
 * `notice` supplies the ids, because the lead body does not repeat the
 * page or the ad in every API version and losing which campaign produced
 * an enquiry defeats the point of running campaigns.
 */
export function parseMetaLead(
  raw: unknown,
  notice: LeadgenNotice,
): AdapterOutcome {
  const rec = asRecord(raw);
  if (!rec) {
    return {
      ok: false,
      reasonCode: "lead_fetch_failed",
      reason:
        "Meta told us an enquiry existed but the answers could not be read. Open Meta's Leads Center and download it by hand; the reference is below.",
      externalId: notice.leadgenId,
    };
  }

  const fields = Array.isArray(rec.field_data) ? rec.field_data : [];

  let name: string | null = null;
  let lastName: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;
  let company: string | null = null;
  let city: string | null = null;
  let state: string | null = null;
  let pincode: string | null = null;
  const extra: Record<string, string> = {};

  for (const field of fields) {
    const f = asRecord(field);
    if (!f) continue;
    const fname = cleanString(f.name, 120);
    if (!fname) continue;

    // ⚠️ `values` is an ARRAY even for a single answer, and a
    // multiple-choice question genuinely returns several.
    const values = Array.isArray(f.values) ? f.values : [f.values];
    const value = cleanString(values.filter(Boolean).join(", "), 2000);
    if (!value) continue;

    if (!name && matches(fname, NAME_FIELDS)) name = cleanName(value);
    else if (!lastName && matches(fname, LAST_NAME_FIELDS)) lastName = cleanName(value);
    else if (!phone && matches(fname, PHONE_FIELDS)) phone = cleanPhone(value);
    else if (!email && matches(fname, EMAIL_FIELDS)) email = cleanEmail(value);
    else if (!company && matches(fname, COMPANY_FIELDS)) company = cleanString(value, 255);
    else if (!city && matches(fname, CITY_FIELDS)) city = cleanString(value, 160);
    else if (!state && matches(fname, STATE_FIELDS)) state = cleanString(value, 160);
    else if (!pincode && matches(fname, ZIP_FIELDS)) pincode = cleanString(value, 12);
    else if (Object.keys(extra).length < 20) {
      // ⭐ THE CUSTOM QUESTION IS OFTEN THE MOST VALUABLE ANSWER IN THE
      // FORM. "How many tonnes per month" tells a salesman more than the
      // name does, and no standard mapping will ever contain it.
      extra[fname] = value;
    }
  }

  if (!hasSomebodyToContact({ phone, altPhone: null, email })) {
    return noContactFailure(notice.leadgenId);
  }

  const fullName = [name, lastName].filter(Boolean).join(" ") || null;

  const enquiry: NormalisedEnquiry = {
    externalId: notice.leadgenId,
    name: fullName,
    phone,
    altPhone: null,
    email,
    companyName: company,
    city,
    state,
    pincode,
    countryIso: cleanCountryIso(rec.country) ?? null,
    // ⚠️ The form is the closest thing to "what they asked about", and
    // naming it beats a blank. A campaign running four forms wants to
    // know which one produced the enquiry.
    interestLabel:
      cleanString(rec.form_name, 300) ??
      (notice.formId ? `Meta form ${notice.formId}` : null),
    message: Object.entries(extra)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n") || null,
    occurredAt: parseIstish(rec.created_time) ?? notice.createdAt,
    enquiryKind: "form",
    extra: {
      ...extra,
      ...(notice.adId ? { meta_ad_id: notice.adId } : {}),
      ...(notice.formId ? { meta_form_id: notice.formId } : {}),
      ...(notice.pageId ? { meta_page_id: notice.pageId } : {}),
    },
  };

  return { ok: true, enquiry };
}

/**
 * ⚠️ THE FETCH FAILED, WHICH IS NOT THE SAME AS THE ENQUIRY BEING BAD.
 *
 * ⭐ The `leadgen_id` is carried into the failure row so a person can
 * find the enquiry in Meta's own Leads Center. Without it the record
 * says only that something was lost.
 */
export function leadFetchFailure(
  notice: LeadgenNotice,
  detail: string,
): AdapterOutcome {
  return {
    ok: false,
    reasonCode: "lead_fetch_failed",
    reason: `Meta reported an enquiry (${notice.leadgenId}) but the answers could not be fetched: ${detail}. The usual cause is an expired page access token. The enquiry is still in Meta's Leads Center.`,
    externalId: notice.leadgenId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
