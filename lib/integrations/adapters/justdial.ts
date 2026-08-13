/**
 * Ordence — ⭐⭐⭐ JUSTDIAL
 * Version: v1.13.0-alpha
 *
 * Pure. No clock, no network, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THIS IS THE ADAPTER WITH NO DOCUMENTATION BEHIND IT
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART and Meta both publish field lists. JustDial does not publish
 * a public integration reference at all: the delivery is configured by
 * their account manager, against whatever field names that account was
 * set up with, and different sellers report different names for the same
 * thing.
 *
 * ⚠️ SO THIS ADAPTER IS WRITTEN DEFENSIVELY ON PURPOSE, and that is a
 * stated design decision rather than sloppiness. It reads a LIST of
 * candidate names for each field, case-insensitively, and keeps
 * everything it did not recognise.
 *
 * ⭐ THE ALTERNATIVE — pinning one field name from one seller's setup —
 * fails silently for the second customer, and fails as "no leads are
 * arriving", which is the hardest failure in this whole batch to
 * diagnose.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND IT SIGNS NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * There is no signature, no shared secret and no token. The unguessable
 * address IS the security, which is why 0064 refuses a path token under
 * 32 characters at the database level.
 *
 * 🔴 WHICH ALSO MEANS ANYONE WHO LEARNS THE ADDRESS CAN POST TO IT. The
 * enquiry is stored, filed and shown as coming from JustDial, and the
 * screen does not claim it was verified — `signature_state` is
 * `not_required`, which is a different word from `verified` precisely so
 * this distinction survives.
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

/**
 * ⚠️ SEVERAL NAMES PER FIELD, BECAUSE DIFFERENT ACCOUNTS SEND DIFFERENT
 * ONES. Order matters: the most specific first.
 */
const FIELDS = Object.freeze({
  externalId: ["leadid", "lead_id", "id", "uniqueid", "unique_id", "docid"],
  name: ["prefix_name", "name", "customer_name", "cust_name", "person"],
  phone: ["mobile", "phone", "mobile_no", "mobilenumber", "contact", "number"],
  altPhone: ["phone2", "alt_mobile", "altmobile", "landline", "telephone"],
  email: ["email", "email_id", "emailid", "mail"],
  company: ["company", "company_name", "firm"],
  city: ["city", "area", "brancharea", "branch_area", "location"],
  state: ["state"],
  pincode: ["pincode", "pin", "zip"],
  category: ["category", "cat", "product", "service", "requirement"],
  message: ["message", "remarks", "comment", "query", "description"],
  date: ["dated", "date", "leaddate", "datetime", "created"],
  time: ["time", "leadtime"],
});

/**
 * ⭐ CASE-INSENSITIVE AND UNDERSCORE-INSENSITIVE LOOKUP.
 *
 * ⚠️ One account sends `Mobile`, another `mobile`, a third `mobile_no`.
 * Matching exactly is how a working integration breaks for the next
 * customer with no error anywhere.
 */
function pick(
  source: Record<string, unknown>,
  candidates: readonly string[],
): unknown {
  const flat = new Map<string, unknown>();
  for (const [k, v] of Object.entries(source)) {
    flat.set(k.toLowerCase().replace(/[_\s-]/g, ""), v);
  }
  for (const c of candidates) {
    const hit = flat.get(c.toLowerCase().replace(/[_\s-]/g, ""));
    if (hit !== undefined && hit !== null && String(hit).trim() !== "") return hit;
  }
  return undefined;
}

/**
 * Parses a JustDial delivery, which arrives as query-string parameters
 * or as a small JSON body depending on how their end was configured.
 *
 * ⚠️ `fallbackId` is required and is normally the delivery's own id. See
 * the note below on why this one adapter mints an id when the sender
 * gives none.
 */
export function parseJustdialLead(
  raw: unknown,
  fallbackId: string,
): AdapterOutcome {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;

  if (!rec || Object.keys(rec).length === 0) {
    return {
      ok: false,
      reasonCode: "unparseable",
      reason:
        "A JustDial delivery arrived with nothing in it. If this repeats, their account manager may have the wrong address configured.",
      externalId: null,
    };
  }

  const phone = cleanPhone(pick(rec, FIELDS.phone));
  const altPhone = cleanPhone(pick(rec, FIELDS.altPhone));
  const email = cleanEmail(pick(rec, FIELDS.email));

  /**
   * ⚠️ JUSTDIAL DOES NOT RELIABLY SEND AN ID, and unlike IndiaMART it
   * does not retry, so there is no unbounded-duplicate risk from filing
   * one without theirs.
   *
   * ⭐ SO THIS ONE ADAPTER FALLS BACK TO THE DELIVERY'S OWN ID, and the
   * difference from the IndiaMART rule is deliberate: there, a missing
   * id plus retries means a copy every hour forever; here, a missing id
   * plus no retries means one lead, once.
   *
   * 🔴 The cost is that a genuine JustDial resend would land twice. That
   * is the right trade against losing a paid enquiry outright, and the
   * person-level duplicate check from 0061 catches it on the screen.
   */
  const externalId = cleanString(pick(rec, FIELDS.externalId), 200) ?? fallbackId;

  if (!hasSomebodyToContact({ phone, altPhone, email })) {
    return noContactFailure(externalId);
  }

  const date = cleanString(pick(rec, FIELDS.date), 40);
  const time = cleanString(pick(rec, FIELDS.time), 20);
  const occurredAt = parseIstish(date && time ? `${date} ${time}` : (date ?? null));

  const mappedKeys = Object.values(FIELDS).flat();
  const extra: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(rec)) {
    const norm = k.toLowerCase().replace(/[_\s-]/g, "");
    if (mappedKeys.some((m) => m.toLowerCase().replace(/[_\s-]/g, "") === norm)) {
      continue;
    }
    const s = cleanString(v, 300);
    if (!s) continue;
    extra[k] = s;
    if (++n >= 20) break;
  }

  const enquiry: NormalisedEnquiry = {
    externalId,
    name: cleanName(pick(rec, FIELDS.name)),
    phone,
    altPhone,
    email,
    companyName: cleanString(pick(rec, FIELDS.company), 255),
    city: cleanString(pick(rec, FIELDS.city), 160),
    state: cleanString(pick(rec, FIELDS.state), 160),
    pincode: cleanString(pick(rec, FIELDS.pincode), 12),
    countryIso: cleanCountryIso(pick(rec, ["country", "country_iso"])) ?? "IN",
    interestLabel: cleanString(pick(rec, FIELDS.category), 300),
    message: cleanString(pick(rec, FIELDS.message), 2000),
    occurredAt,
    // ⚠️ JustDial's leads originate from a phone listing, but the
    // delivery does not say whether they rang or filled a form. `form`
    // would be a guess, so it is not made.
    enquiryKind: "unknown",
    extra,
  };

  return { ok: true, enquiry };
}
