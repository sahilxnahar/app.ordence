/**
 * Ordence — The slug contract (Edge-safe, zero dependencies)
 * Version: v1.56.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE INCIDENT THIS FILE EXISTS FOR
 * ══════════════════════════════════════════════════════════════════════
 * There were TWO reserved-word lists and they disagreed by eight names in
 * each direction:
 *
 *   lib/tenant.ts:30                    decided what RESOLVES  (33 names)
 *   server/platform/provisioning.ts:80  decided what is CREATED (34 names)
 *
 * Provisioning would happily mint `assets`, `ns1`, `ns2`, `ftp`, `clerk`,
 * `preview`, `vercel` and `logout`. `lib/tenant.ts` then refused to resolve
 * them and fell back to `{ kind: "root" }`. The workspace provisioned
 * successfully, the operator saw success, and the customer's front door was
 * dead. Nothing reported it, because each half behaved exactly as written.
 *
 * The two files also disagreed about the minimum length: 3 in one, 1 in the
 * other. One-character labels are exactly the ones worth squatting.
 *
 * ⚠️ THE FIX IS NOT "KEEP THEM IN SYNC". Discipline is what produced the
 *    drift. The fix is that there is only one list, it lives here, and
 *    `tests/slug-contract.test.ts` reads `reserved_slugs` out of the
 *    database and asserts this file matches it exactly. A third copy cannot
 *    drift silently because something fails when it does.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE PRINCIPLE
 * ══════════════════════════════════════════════════════════════════════
 *      The availability check is advisory.
 *      The unique index is the truth.
 *      The insert is the claim.
 *
 * Everything in this file is a MISTAKE GUARD. It stops a typo becoming a
 * support ticket and it makes the form pleasant. It is not a boundary.
 * The boundary is `0091_slug_authority.sql`: two CHECK constraints, two
 * UNIQUE indexes and a SECURITY DEFINER trigger. Nothing here may ever be
 * the only refusal, because a check that runs before an insert is a race
 * whose window is the user's typing speed.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THIS FILE IMPORTS NOTHING, NOT EVEN ZOD
 * ══════════════════════════════════════════════════════════════════════
 * `lib/tenant.ts` imports it, `middleware.ts` imports `lib/tenant.ts`, and
 * middleware runs in the Edge Runtime on every single request. Zod is
 * Edge-compatible but it is not free, and a validation library has no
 * business in the hot path that decides which tenant a hostname belongs to.
 * The Zod schema lives in `lib/slug-schema.ts`, which imports FROM here and
 * is only ever pulled in by server code.
 *
 * The same reasoning bans `server-only` here: this module is legitimately
 * shared by the Edge middleware, server actions and the signup form.
 */

/* ------------------------------------------------------------------ */
/* SHAPE                                                               */
/* ------------------------------------------------------------------ */

/**
 * 3 to 63 characters, lowercase alphanumeric and hyphen, no leading or
 * trailing hyphen.
 *
 * ⚠️ THIS MUST STAY IDENTICAL TO `tenants_slug_shape` IN 0091. If they
 *    diverge, this file becomes a liar: the form accepts a name the
 *    database will refuse, and the user discovers it after filling in
 *    everything else.
 *
 * ⚠️ `{1,61}` in the middle, not `{0,61}`. That is what makes 3 the
 *    minimum. It reads like an off-by-one and it is not.
 *
 * 🔴 DO NOT ALLOW DOTS. The wildcard certificate `*.ordence.com` covers
 *    exactly ONE label. `acme.ordence.com` is covered; `acme.corp.ordence.com`
 *    is not, and would serve a certificate error to a paying customer with
 *    no way for them to understand why. A dot in a slug is a broken
 *    workspace, not a nested one.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

/* ------------------------------------------------------------------ */
/* RESERVED                                                            */
/* ------------------------------------------------------------------ */

/**
 * 🔴 RESERVED WORDS ARE A SECURITY CONTROL, NOT TIDINESS.
 *
 * Grouped by why, because a flat list invites someone to delete an entry
 * that looks harmless. Every one of these becomes a real hostname under a
 * certificate WE issue.
 *
 * ⚠️ THE `certificate` GROUP IS THE ONE PEOPLE MISS. `postmaster`,
 *    `hostmaster`, `webmaster` and `abuse` are addresses a certificate
 *    authority will accept as proof of domain control. A tenant holding one
 *    of those subdomains, with mail on it, can have a certificate issued for
 *    a name under our domain. That is not a phishing risk, it is a
 *    delegation of our identity.
 *
 * ⚠️ ADDING A NAME HERE IS NOT ENOUGH. The database is the enforcer. Add the
 *    row to `reserved_slugs` too, or `tests/slug-contract.test.ts` fails,
 *    which is the point of that test. In an emergency, insert into
 *    `reserved_slugs` FIRST: that takes effect immediately and does not need
 *    a deploy.
 */
const RESERVED_BY_CATEGORY = {
  /** Would let a tenant obtain a certificate for a name under our domain. */
  certificate: ["abuse", "hostmaster", "postmaster", "webmaster"],

  /** A hostname that claims to be Ordence, or to be privileged. */
  impersonate: [
    "admin", "administrator", "console", "internal", "ordence", "platform",
    "portal", "root", "secure", "security", "staff", "support", "system",
  ],

  /** Authentication and identity surfaces. */
  identity: [
    "account", "accounts", "auth", "clerk", "idp", "login", "logout", "oauth",
    "signin", "signup", "sso", "verification", "verify",
  ],

  /**
   * Mail routing and discovery. `_domainkey` is unreachable under the
   * current pattern and is listed anyway, so that the day someone allows a
   * leading underscore the row is already here.
   *
   * 🔴 `clkmail`, `clk` and `clk2` ARE NOT GENERIC. They are the LIVE Clerk
   *    hosts in the `ordence.com` zone (`clkmail` is the outbound mail
   *    CNAME; `clk._domainkey` and `clk2._domainkey` are the DKIM
   *    selectors). An explicit CNAME beats the Railway wildcard
   *    `*.ordence.com`, so a tenant that claimed `clkmail` would get a
   *    workspace whose hostname resolves to Clerk's mail infrastructure
   *    forever, provisioned successfully, with no error anywhere. Added by
   *    `0092_reserve_clerk_hosts.sql`.
   *
   * ⚠️ THE RULE, WHICH OUTLIVES THESE THREE NAMES: every time a vendor is
   *    given a CNAME under `ordence.com`, its label is reserved in the same
   *    change. This list is a mirror of the zone file, and a mirror goes
   *    stale silently.
   */
  mail: [
    "_domainkey", "autodiscover", "clk", "clk2", "clkmail", "dmarc", "email",
    "imap", "mail", "mx", "pop", "resend", "send", "smtp", "spf", "updates",
    "webmail",
  ],

  /** Money and statutory surfaces. High-value impersonation targets in
   *  India specifically: a `gst.ordence.com` that is not ours is a very
   *  cheap way to collect GSTINs. */
  money: [
    "billing", "gst", "invoice", "invoices", "pay", "payment", "payments",
  ],

  /** Infrastructure and environment labels. */
  infra: [
    "api", "app", "apps", "assets", "cdn", "ci", "dashboard", "dev", "ftp",
    "git", "ns1", "ns2", "preview", "staging", "static", "status", "test",
    "vercel", "vpn", "www",
  ],

  /** Public marketing surfaces. */
  marketing: ["blog", "docs", "help"],
} as const;

export type ReservedCategory = keyof typeof RESERVED_BY_CATEGORY;

/** The flat set. 71 names. Mirrored by `reserved_slugs` in the database. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(
  Object.values(RESERVED_BY_CATEGORY).flat(),
);

/** Which group a reserved name belongs to, for the operator console. */
export function reservedCategory(slug: string): ReservedCategory | null {
  for (const [category, names] of Object.entries(RESERVED_BY_CATEGORY)) {
    if ((names as readonly string[]).includes(slug)) {
      return category as ReservedCategory;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* THE CONFUSABLE FOLD                                                 */
/* ------------------------------------------------------------------ */

/**
 * ⭐ Collapses visually confusable spellings onto one canonical form.
 *
 *   hyphens vanish        acme-corp  → acmecorp
 *   "rn" → "m"            arnazon    → amazon
 *   "vv" → "w"            vvipro     → wipro
 *   "0" → "o"             0rdence    → ordence
 *   "1" and "l" → "i"     zedbui1ders and zedbuilders → zedbuiiders
 *
 * ⚠️ THIS MUST STAY BYTE-FOR-BYTE EQUIVALENT TO THE GENERATED COLUMN IN
 *    0091, INCLUDING THE ORDER OF OPERATIONS:
 *
 *      translate(
 *        replace(replace(replace(slug,'-',''),'rn','m'),'vv','w'),
 *        '01l', 'oii')
 *
 *    Hyphens are stripped FIRST, so `ka-rnataka` also folds. `rn` and `vv`
 *    are handled BEFORE the character translation, because they are digraph
 *    substitutions and `translate` is single-pass.
 *
 * 🔴 A REAL BUG THIS PARAGRAPH EXISTS TO PREVENT. The first version of the
 *    migration used `translate(x, '01l', 'oli')`, which maps `1` to `l`
 *    rather than to `i`. It looked right, it read right, and `zedbui1ders`
 *    walked straight past the unique index. It was caught by executing the
 *    constraint against PostgreSQL 16 with a planted collision, not by
 *    reading it. If you change this function, drill it the same way.
 *
 * WHY FOLD AT ALL
 *   Every tenant subdomain carries a certificate we issued, and the issuance
 *   is published in the public certificate transparency log within minutes.
 *   A hostname one glyph away from a real customer's, holding a valid
 *   certificate under our own domain, is the cheapest credible phishing
 *   setup that exists: the victim checks the padlock and the padlock is real.
 *
 * ⚠️ THE COST IS REAL AND IS ACCEPTED DELIBERATELY. This refuses `acme-corp`
 *    when `acmecorp` already exists, and those may be two unrelated
 *    companies. The cost of the refusal is one support conversation. The
 *    cost of the collision is a customer phished under our certificate.
 */
export function foldSlug(slug: string): string {
  const stripped = slug.toLowerCase().replace(/-/g, "");
  const digraphs = stripped.replace(/rn/g, "m").replace(/vv/g, "w");
  let out = "";
  for (const ch of digraphs) {
    if (ch === "0") out += "o";
    else if (ch === "1" || ch === "l") out += "i";
    else out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* REJECTIONS                                                          */
/* ------------------------------------------------------------------ */

/**
 * Why a slug was refused. Machine-readable, because the server maps
 * PostgreSQL SQLSTATEs onto exactly these values and the client must not
 * parse English to decide what to show.
 */
export type SlugRejectionCode =
  | "empty"
  | "too_short"
  | "too_long"
  | "bad_characters"
  | "leading_or_trailing_hyphen"
  | "reserved"
  | "taken"
  | "too_similar"
  | "recently_released";

export interface SlugRejection {
  code: SlugRejectionCode;
  /** Shown to an anonymous visitor on the public signup form. */
  publicMessage: string;
  /** Shown to Ordence staff in the console. May name the conflict. */
  operatorMessage: string;
}

/**
 * 🔴 THE PUBLIC AND OPERATOR MESSAGES ARE DELIBERATELY DIFFERENT FOR
 *    `taken`, `too_similar` AND `recently_released`, AND THE DIFFERENCE IS
 *    THE CONTROL.
 *
 *    A public form that says "too similar to acmecorp" is a lookup tool for
 *    which near-miss names are already taken, which is reconnaissance for
 *    precisely the attack the fold exists to prevent. The operator console
 *    may name the conflict, because the reader is staff.
 *
 * ⚠️ THIS IS NOT AN ATTEMPT TO KEEP TENANT SLUGS SECRET, AND NOBODY SHOULD
 *    LATER BUILD A FEATURE THAT ASSUMES THEY ARE. `acme.ordence.com`
 *    resolves in public DNS and its certificate is published the moment it
 *    is issued. The split above narrows a targeting oracle; it does not
 *    create confidentiality that does not exist.
 */
export const SLUG_REJECTIONS: Record<SlugRejectionCode, Omit<SlugRejection, "code">> = {
  empty: {
    publicMessage: "Choose an address for your workspace.",
    operatorMessage: "Slug is empty.",
  },
  too_short: {
    publicMessage: `At least ${SLUG_MIN_LENGTH} characters.`,
    operatorMessage: `Below the ${SLUG_MIN_LENGTH}-character minimum enforced by tenants_slug_shape.`,
  },
  too_long: {
    publicMessage: `At most ${SLUG_MAX_LENGTH} characters.`,
    operatorMessage: `Above the ${SLUG_MAX_LENGTH}-character DNS label limit.`,
  },
  bad_characters: {
    publicMessage: "Lowercase letters, numbers and hyphens only.",
    operatorMessage: "Contains a character outside [a-z0-9-]. Dots are banned: the wildcard certificate covers one label only.",
  },
  leading_or_trailing_hyphen: {
    publicMessage: "It cannot start or end with a hyphen.",
    operatorMessage: "Leading or trailing hyphen is not a legal DNS label.",
  },
  reserved: {
    publicMessage: "That name is reserved. Try something closer to your company name.",
    operatorMessage: "Present in reserved_slugs. Reserved names are a security control, not tidiness.",
  },
  taken: {
    publicMessage: "That address is already in use. Try another.",
    operatorMessage: "Exact slug collision on tenants_slug_unique.",
  },
  too_similar: {
    publicMessage: "That name is too similar to an existing workspace. Try adding a word.",
    operatorMessage: "Confusable-fold collision on tenants_slug_fold_unique. Naming the conflicting workspace is safe here and is not on the public form.",
  },
  recently_released: {
    publicMessage: "That address is not available. Try another.",
    operatorMessage: "Released within the 365-day retention window. The old hostname is still live in bookmarks, emailed links and the CT log.",
  },
};

export function rejection(code: SlugRejectionCode): SlugRejection {
  return { code, ...SLUG_REJECTIONS[code] };
}

/* ------------------------------------------------------------------ */
/* SQLSTATE MAPPING                                                    */
/* ------------------------------------------------------------------ */

/**
 * The guard in 0091 raises distinct SQLSTATEs so the application never has
 * to parse an error message in English to decide what to show.
 *
 *   P0091  reserved
 *   P0092  released within retention, exact
 *   P0093  released within retention, folded
 *   23505  unique_violation, from an index rather than the trigger
 *
 * ⚠️ 23505 IS AMBIGUOUS AND MUST BE DISAMBIGUATED BY CONSTRAINT NAME, not
 *    guessed. `tenants_slug_unique` and `tenants_slug_fold_unique` mean
 *    different things to the person reading the message.
 */
export function rejectionFromPgError(
  code: string | undefined,
  constraint: string | undefined,
): SlugRejection | null {
  switch (code) {
    case "P0091":
      return rejection("reserved");
    case "P0092":
    case "P0093":
      return rejection("recently_released");
    case "23505":
      if (constraint === "tenants_slug_fold_unique") return rejection("too_similar");
      if (constraint === "tenants_slug_unique") return rejection("taken");
      return null;
    case "23514":
      // A CHECK violation here means the client-side shape validation was
      // bypassed or has drifted from 0091. Treat it as a shape problem and
      // let the caller log it loudly, because it should be unreachable.
      if (constraint === "tenants_slug_lowercase") return rejection("bad_characters");
      if (constraint === "tenants_slug_shape") return rejection("bad_characters");
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

/**
 * Shape and reserved-word validation only. It cannot and must not check
 * uniqueness: that requires the database, and the answer is stale the
 * moment it is returned.
 *
 * Returns `null` when the slug is acceptable so far.
 */
export function checkSlugShape(raw: string): SlugRejection | null {
  const slug = raw.trim().toLowerCase();

  if (slug.length === 0) return rejection("empty");
  if (slug.length < SLUG_MIN_LENGTH) return rejection("too_short");
  if (slug.length > SLUG_MAX_LENGTH) return rejection("too_long");
  if (slug.startsWith("-") || slug.endsWith("-")) {
    return rejection("leading_or_trailing_hyphen");
  }
  if (!/^[a-z0-9-]+$/.test(slug)) return rejection("bad_characters");
  if (!SLUG_PATTERN.test(slug)) return rejection("bad_characters");
  if (RESERVED_SLUGS.has(slug)) return rejection("reserved");

  return null;
}

/**
 * The predicate `lib/tenant.ts` uses when resolving a hostname.
 *
 * ⚠️ IT IS DELIBERATELY THE SAME FUNCTION THE FORM USES. The drift between
 *    "what resolves" and "what can be created" is the incident at the top of
 *    this file. There is now one answer.
 */
export function isValidSlug(slug: string): boolean {
  return checkSlugShape(slug) === null;
}

/* ------------------------------------------------------------------ */
/* SUGGESTIONS                                                         */
/* ------------------------------------------------------------------ */

/**
 * Candidate alternatives for a slug that was refused.
 *
 * ⚠️ THESE ARE CANDIDATES, NOT OFFERS. The caller MUST check every one of
 *    them against the database before showing it. A suggestion that is
 *    itself taken is worse than no suggestion: it teaches the user that the
 *    form's answers are unreliable, on the one screen where they most need
 *    to believe it.
 *
 * Suffixes are chosen to be plausible for an Indian business rather than
 * generic: a contracting firm is far more likely to accept `acme-india` or
 * `acme-projects` than `acme-1`. Numeric fallbacks come last precisely
 * because they read as a consolation prize.
 */
const SUGGESTION_SUFFIXES = [
  "india", "group", "projects", "works", "co", "hq", "team", "infra",
] as const;

export function suggestSlugs(raw: string, limit = 6): string[] {
  const base = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  if (!base) return [];

  const out: string[] = [];
  const push = (candidate: string) => {
    if (out.length >= limit) return;
    if (candidate.length > SLUG_MAX_LENGTH) return;
    if (out.includes(candidate)) return;
    if (checkSlugShape(candidate) !== null) return;
    out.push(candidate);
  };

  for (const suffix of SUGGESTION_SUFFIXES) push(`${base}-${suffix}`);
  for (let n = 2; n <= 9; n += 1) push(`${base}-${n}`);

  return out;
}
