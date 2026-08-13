/**
 * Ordence — ⭐⭐⭐ ONE SHAPE, WHATEVER SENT IT
 * Version: v1.13.0-alpha
 *
 * Pure. No clock, no network, no database.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE NORMALISED ENQUIRY IS THE POINT OF HAVING ADAPTERS AT ALL
 * ══════════════════════════════════════════════════════════════════════
 * IndiaMART sends SCREAMING_SNAKE_CASE. Meta sends an array of
 * `{name, values}` pairs whose names the advertiser chose. JustDial sends
 * a query string. If any of that reaches the ingest, the ingest grows a
 * `if (connector === "indiamart")` and the fourth connector is written by
 * copying the third.
 *
 * ⭐ EVERY ADAPTER RETURNS THIS, AND NOTHING DOWNSTREAM KNOWS WHO SENT
 * IT.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AND EVERY FIELD EXCEPT `externalId` IS OPTIONAL, DELIBERATELY
 * ══════════════════════════════════════════════════════════════════════
 * Real enquiries arrive with no name, no email, a mobile number with a
 * country code glued on, and a message in Hinglish. An adapter that
 * throws on a missing field turns a filable lead into a lost one.
 *
 * 🔴 THE ONE THING THAT IS NOT OPTIONAL IS SOMEBODY TO CONTACT. A lead
 * with neither a phone number nor an email address is not a lead; it is
 * a row that will sit in a list forever. That case is reported to the
 * owner rather than swallowed, because the enquiry was paid for and can
 * still be retrieved by hand from the provider's own panel.
 */

/** What every adapter produces. */
export interface NormalisedEnquiry {
  /**
   * 🔴 THE SENDER'S OWN ID, and the reason a resent enquiry lands once.
   * An id we mint cannot answer "have we seen this", because we mint a
   * new one every time we are asked.
   */
  readonly externalId: string;

  readonly name: string | null;
  readonly phone: string | null;
  readonly altPhone: string | null;
  readonly email: string | null;

  readonly companyName: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  /** ISO-3166 alpha-2, upper case, where the sender gives one. */
  readonly countryIso: string | null;

  /** What they asked about, in their words or the product's name. */
  readonly interestLabel: string | null;
  readonly message: string | null;

  /** When the buyer enquired, not when we received it. Null if unstated. */
  readonly occurredAt: Date | null;

  /**
   * ⭐ WHAT KIND OF EVENT. A missed call is not a message, and a product
   * enquiry is not a catalogue view. Filing them identically makes the
   * source report a lie.
   */
  readonly enquiryKind: EnquiryKind;

  /**
   * ⚠️ FIELDS THE ADAPTER DID NOT UNDERSTAND, kept rather than dropped.
   * The unmapped field is always the one the customer asks about.
   */
  readonly extra: Record<string, string>;
}

export type EnquiryKind =
  | "message"
  | "phone_call"
  | "missed_call"
  | "catalogue_view"
  | "form"
  | "unknown";

export type AdapterOutcome =
  | { readonly ok: true; readonly enquiry: NormalisedEnquiry }
  | {
      readonly ok: false;
      /** Mirrors `lead_intake_failures.reason_code`. */
      readonly reasonCode:
        | "no_contact_details"
        | "unparseable"
        | "unknown_shape"
        | "lead_fetch_failed"
        | "rejected_by_rules"
        | "internal_error";
      /** ⚠️ In words the owner can act on. Never "validation error". */
      readonly reason: string;
      /** Where one could be recovered, so the failure row can name it. */
      readonly externalId: string | null;
    };

/* ------------------------------------------------------------------ */
/* SHARED TIDYING                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ EVERY ONE OF THESE HAS ARRIVED IN A REAL FEED.
 *
 * IndiaMART substitutes the literal string "IndiaMART Buyer" when the
 * buyer gave no name. Storing that as a person's name produces a
 * pipeline full of identical rows and a mail merge that opens "Dear
 * IndiaMART Buyer".
 */
const PLACEHOLDER_NAMES = new Set([
  "indiamart buyer",
  "buyer",
  "n/a",
  "na",
  "null",
  "undefined",
  "-",
  "test",
  "xxx",
]);

export function cleanString(value: unknown, maxLength = 300): string | null {
  if (typeof value !== "string") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  if (trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

export function cleanName(value: unknown): string | null {
  const s = cleanString(value, 255);
  if (!s) return null;
  // ⭐ A placeholder is worse than nothing, because nothing is honest.
  if (PLACEHOLDER_NAMES.has(s.toLowerCase())) return null;
  return s;
}

/**
 * 🔴 A PHONE NUMBER IS KEPT AS TYPED AND MATCHED ON ITS LAST TEN DIGITS.
 *
 * ⚠️ `lib/crm/dedupe.ts` and the `phone_digits` generated column in 0061
 * both already do the matching. This only refuses things that are not
 * numbers at all, so that "+91 98765 43210" survives to be dialled by a
 * human exactly as the buyer wrote it.
 */
export function cleanPhone(value: unknown): string | null {
  const s = cleanString(value, 32);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  // ⚠️ Fewer than ten digits cannot be an Indian mobile, and a run of
  // zeroes is what a form submits when nobody typed anything.
  if (digits.length < 10) return null;
  if (/^0+$/.test(digits)) return null;
  return s;
}

export function cleanEmail(value: unknown): string | null {
  const s = cleanString(value, 320);
  if (!s) return null;
  const lower = s.toLowerCase();
  // Deliberately loose. A rejected real address costs more than a stored
  // bad one, which simply bounces and is visible.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(lower)) return null;
  return lower;
}

export function cleanCountryIso(value: unknown): string | null {
  const s = cleanString(value, 8);
  if (!s) return null;
  const up = s.toUpperCase().replace(/[^A-Z]/g, "");
  return up.length === 2 ? up : null;
}

/**
 * ⚠️ EVERY PROVIDER SENDS TIME IN ITS OWN WAY and none of them says which
 * zone. IndiaMART sends "2026-08-13 10:34:12", which is IST; Meta sends a
 * unix timestamp; JustDial sends a date and a time in separate
 * parameters.
 *
 * 🔴 AN UNMARKED LOCAL TIME PARSED AS UTC LANDS FIVE AND A HALF HOURS
 * EARLY, which puts a morning enquiry on the previous day's report often
 * enough to be noticed and never often enough to be diagnosed.
 */
export function parseIstish(value: unknown): Date | null {
  const s = cleanString(value, 40);
  if (!s) return null;

  // A unix timestamp, in seconds or milliseconds.
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));

  // Already carries a zone or a Z. Trust it.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ⭐ Bare "YYYY-MM-DD HH:MM:SS" — treated as IST, because that is what
  // it is, and said so explicitly rather than left to the runtime.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec ?? "00"}+05:30`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * 🔴 THE ONE RULE EVERY ADAPTER SHARES: THERE HAS TO BE SOMEBODY TO
 * CONTACT.
 */
export function hasSomebodyToContact(e: {
  phone: string | null;
  altPhone: string | null;
  email: string | null;
}): boolean {
  return Boolean(e.phone || e.altPhone || e.email);
}

export function noContactFailure(externalId: string | null): AdapterOutcome {
  return {
    ok: false,
    reasonCode: "no_contact_details",
    reason:
      "This enquiry arrived with no phone number and no email address, so there is nobody to call. It can usually still be seen in the provider's own panel.",
    externalId,
  };
}

/** Collects the fields an adapter did not map, so nothing is silently lost. */
export function collectExtra(
  source: Record<string, unknown>,
  mapped: readonly string[],
  limit = 20,
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (mapped.includes(key)) continue;
    const s = cleanString(value, 300);
    if (!s) continue;
    out[key] = s;
    if (++count >= limit) break;
  }
  return out;
}
