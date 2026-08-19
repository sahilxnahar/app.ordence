/**
 * Ordence — checkSlugShape() and suggestSlugs()
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY ASSERTION IN THIS FILE IS ABOUT A PROPERTY, NEVER A SENTENCE
 * ══════════════════════════════════════════════════════════════════════
 * Three tests in this project have already had to be rewritten because
 * they pinned a SHAPE rather than a PROPERTY — one froze an author's
 * exact reason string, one froze an href, two froze a file path. Each
 * broke on a CORRECT fix and each taught nothing when it failed.
 *
 * So: the refusals are asserted by `code`, which is the machine-readable
 * value the server and the client both branch on and which
 * `rejectionFromPgError()` maps SQLSTATEs onto. Nothing here asserts the
 * English. Rewording `SLUG_REJECTIONS` must not break this file; changing
 * WHICH code an input produces must.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE ONE SECURITY PROPERTY IN THIS FILE
 * ══════════════════════════════════════════════════════════════════════
 * For `taken`, `too_similar` and `recently_released`, the PUBLIC message
 * must not name the workspace it collided with, or the slug that
 * collided. A signup form that says "too similar to acmecorp" is a free
 * lookup tool for which near-miss names already exist — which is
 * reconnaissance for exactly the phishing attack the confusable fold
 * exists to prevent. The OPERATOR message may name it; the reader there
 * is staff with a database in front of them.
 *
 * ⚠️ That is asserted twice, on purpose, because either alone is weak:
 *    once as a property over a corpus of workspace names (the message
 *    never contains the input), and once STRUCTURALLY (`rejection()`
 *    takes a code and nothing else, so the public message CANNOT be
 *    built from a conflict even if someone wanted it to be).
 */

import { describe, it, expect } from "vitest";

import {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_REJECTIONS,
  checkSlugShape,
  isValidSlug,
  rejection,
  rejectionFromPgError,
  suggestSlugs,
  type SlugRejectionCode,
} from "@/lib/slug";
import { operatorSlugSchema, slugSchema } from "@/lib/slug-schema";

/** Every code the type declares. Used so a new code cannot be forgotten. */
const ALL_CODES = Object.keys(SLUG_REJECTIONS) as SlugRejectionCode[];

/* ================================================================== */
/* 1. EVERY REJECTION CODE IS REACHABLE, AND THEY ARE ALL DIFFERENT    */
/* ================================================================== */

/**
 * One input per code, with the path it arrives by. The shape codes come
 * from `checkSlugShape()`; the other three are the database's answers
 * and reach the application only through `rejectionFromPgError()`.
 */
const SHAPE_CASES: Array<[SlugRejectionCode, string]> = [
  ["empty", ""],
  ["too_short", "ab"],
  ["too_long", "a".repeat(SLUG_MAX_LENGTH + 1)],
  ["bad_characters", "acme.corp"],
  ["leading_or_trailing_hyphen", "-acme"],
  ["reserved", "postmaster"],
];

const PG_CASES: Array<[SlugRejectionCode, string, string | undefined]> = [
  ["reserved", "P0091", undefined],
  ["recently_released", "P0092", undefined],
  ["recently_released", "P0093", undefined],
  ["too_similar", "23505", "tenants_slug_fold_unique"],
  ["taken", "23505", "tenants_slug_unique"],
];

describe("checkSlugShape — every refusal is reachable and distinguishable", () => {
  it.each(SHAPE_CASES)("returns %s", (code, input) => {
    expect(checkSlugShape(input)?.code).toBe(code);
  });

  it("🔴 every declared code is produced by some path — none is dead", () => {
    const reached = new Set<SlugRejectionCode>([
      ...SHAPE_CASES.map(([code]) => code),
      ...PG_CASES.map(([code]) => code),
    ]);
    const unreachable = ALL_CODES.filter((c) => !reached.has(c));
    expect(
      unreachable,
      `these codes are declared but no case in this file reaches them: ${unreachable.join(", ")}. ` +
        `A code nothing can produce is either dead, or a refusal that silently arrives as something else.`,
    ).toEqual([]);
  });

  it("⚠️ gives DIFFERENT codes to different faults — one bucket teaches the user nothing", () => {
    const codes = SHAPE_CASES.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("accepts a plainly good name", () => {
    expect(checkSlugShape("acme-corp")).toBeNull();
    expect(checkSlugShape("zed-builders")).toBeNull();
    expect(checkSlugShape("tata-steel-projects")).toBeNull();
  });

  it("normalises before deciding, so a form that echoes the trimmed value cannot disagree", () => {
    expect(checkSlugShape("  ACME-CORP  ")).toBeNull();
  });

  it("⚠️ isValidSlug is the SAME answer — the resolver and the form cannot drift", () => {
    /**
     * The original incident was `lib/tenant.ts` deciding what RESOLVES
     * and `provisioning.ts` deciding what is CREATED, disagreeing. There
     * is now one function; this pins that there still is.
     */
    const corpus = [
      "acme-corp", "ab", "", "-acme", "acme-", "acme.corp", "postmaster",
      "a".repeat(SLUG_MAX_LENGTH + 1), "a".repeat(SLUG_MAX_LENGTH), "abc", "ACME",
    ];
    for (const value of corpus) {
      expect(isValidSlug(value), `isValidSlug disagrees with checkSlugShape on "${value}"`).toBe(
        checkSlugShape(value) === null,
      );
    }
  });
});

describe("rejectionFromPgError — the SQLSTATE mapping", () => {
  it.each(PG_CASES)("maps %s", (code, sqlstate, constraint) => {
    expect(rejectionFromPgError(sqlstate, constraint)?.code).toBe(code);
  });

  it("🔴 returns null for an unrelated code, so the caller rethrows instead of swallowing", () => {
    /**
     * "Someone beat you to it" and "the database is down" must not
     * arrive at the user as the same sentence. A mapping that guesses
     * turns an outage into a refusal.
     */
    expect(rejectionFromPgError("08006", undefined)).toBeNull();
    expect(rejectionFromPgError("57014", undefined)).toBeNull();
    expect(rejectionFromPgError(undefined, undefined)).toBeNull();
  });

  it("🔴 refuses to guess which unique index fired", () => {
    /** 23505 is ambiguous. Named constraints mean different things to the
     *  person reading the message, so an unnamed one is not mapped. */
    expect(rejectionFromPgError("23505", undefined)).toBeNull();
    expect(rejectionFromPgError("23505", "some_other_unique")).toBeNull();
  });
});

/* ================================================================== */
/* 2. THE PUBLIC MESSAGE IS NOT A LOOKUP TOOL                          */
/* ================================================================== */

/** Codes whose refusal is caused by ANOTHER workspace existing. */
const CONFLICT_CODES: SlugRejectionCode[] = ["taken", "too_similar", "recently_released"];

/**
 * Names chosen to be un-English on purpose: a substring test against a
 * message containing ordinary words would pass or fail for the wrong
 * reason if the corpus were "app" or "use".
 */
const WORKSPACE_NAMES = [
  "acmecorp",
  "acme-corp",
  "zedbuilders",
  "zedbui1ders",
  "vvipro",
  "karnataka",
  "tatasteel",
  "arnazon-traders",
];

describe("🔴 the public refusal never names the workspace it collided with", () => {
  it.each(CONFLICT_CODES)("%s — publicMessage contains no slug from the corpus", (code) => {
    const { publicMessage } = rejection(code);
    const leaked = WORKSPACE_NAMES.filter((name) => publicMessage.toLowerCase().includes(name));
    expect(
      leaked,
      `the public message for "${code}" mentions ${leaked.join(", ")}. On an anonymous signup ` +
        `form that is a free oracle for which near-miss workspace names already exist.`,
    ).toEqual([]);
  });

  it.each(CONFLICT_CODES)("%s — publicMessage does not contain the slug the caller typed", (code) => {
    /**
     * The property, stated as the task states it: whatever the caller
     * typed, the sentence they get back must not echo it. A message
     * that echoes the input is one interpolation away from echoing the
     * conflict as well.
     */
    for (const typed of WORKSPACE_NAMES) {
      expect(rejection(code).publicMessage.toLowerCase()).not.toContain(typed);
    }
  });

  it("🔴 STRUCTURALLY cannot name a conflict — rejection() takes a code and nothing else", () => {
    /**
     * ⭐ THE ASSERTION THAT SURVIVES A REWORDING AND CATCHES THE REAL
     *    REGRESSION. Someone who wants "too similar to acmecorp" on the
     *    public form has to give `rejection()` a second parameter, or
     *    make `publicMessage` a function. Either changes this, and the
     *    change becomes a conversation instead of a deploy.
     */
    expect(rejection.length).toBe(1);
    for (const code of ALL_CODES) {
      expect(typeof SLUG_REJECTIONS[code].publicMessage).toBe("string");
      expect(typeof SLUG_REJECTIONS[code].operatorMessage).toBe("string");
    }
  });

  it("⚠️ keeps the operator message DIFFERENT for exactly those three, because the split is the control", () => {
    for (const code of CONFLICT_CODES) {
      const { publicMessage, operatorMessage } = rejection(code);
      expect(
        publicMessage,
        `"${code}" now says the same thing to an anonymous visitor and to staff. Either the ` +
          `operator lost the detail they need, or the public form gained detail it must not have.`,
      ).not.toBe(operatorMessage);
    }
  });

  it("every code carries both messages, non-empty", () => {
    for (const code of ALL_CODES) {
      expect(rejection(code).publicMessage.length).toBeGreaterThan(0);
      expect(rejection(code).operatorMessage.length).toBeGreaterThan(0);
      expect(rejection(code).code).toBe(code);
    }
  });

  it("the public zod schema speaks the public message and the operator schema the operator one", () => {
    /**
     * Referenced from the source constants rather than quoted, so a
     * rewording moves both sides together and this stays true.
     */
    const publicIssue = slugSchema.safeParse("postmaster");
    expect(publicIssue.success).toBe(false);
    expect(publicIssue.success === false && publicIssue.error.issues[0].message).toBe(
      SLUG_REJECTIONS.reserved.publicMessage,
    );

    const operatorIssue = operatorSlugSchema.safeParse("postmaster");
    expect(operatorIssue.success).toBe(false);
    expect(operatorIssue.success === false && operatorIssue.error.issues[0].message).toBe(
      SLUG_REJECTIONS.reserved.operatorMessage,
    );
  });

  it("🔴 the two schemas ACCEPT exactly the same set — only the wording may differ", () => {
    /**
     * If they ever differ in what they accept, an operator has been
     * handed the power to provision a workspace the resolver will not
     * serve. That is the original incident, rebuilt in a new shape.
     */
    const corpus = [
      "acme-corp", "", "  ", "ab", "abc", "-acme", "acme-", "acme.corp", "acme_corp",
      "postmaster", "ordence", "a".repeat(SLUG_MAX_LENGTH), "a".repeat(SLUG_MAX_LENGTH + 1),
      "ACME-CORP", " acme ", "0rdence", "zedbui1ders",
    ];
    for (const value of corpus) {
      expect(
        slugSchema.safeParse(value).success,
        `the public and operator schemas disagree about "${value}"`,
      ).toBe(operatorSlugSchema.safeParse(value).success);
    }
  });
});

/* ================================================================== */
/* 3. BOUNDARIES                                                       */
/* ================================================================== */

describe("the boundaries of a legal DNS label", () => {
  it("⚠️ 2 is refused and 3 is accepted — `{1,61}` in the middle is what makes 3 the minimum", () => {
    expect(checkSlugShape("ab")?.code).toBe("too_short");
    expect(checkSlugShape("abc")).toBeNull();
    expect(SLUG_MIN_LENGTH).toBe(3);
  });

  it("63 is accepted and 64 is refused — 63 is the DNS label limit", () => {
    expect(checkSlugShape("a".repeat(SLUG_MAX_LENGTH))).toBeNull();
    expect(checkSlugShape("a".repeat(SLUG_MAX_LENGTH + 1))?.code).toBe("too_long");
    expect(SLUG_MAX_LENGTH).toBe(63);
  });

  it("a one-character label is impossible, not merely undesirable", () => {
    expect(checkSlugShape("a")?.code).toBe("too_short");
  });

  it("refuses a leading and a trailing hyphen", () => {
    expect(checkSlugShape("-acme")?.code).toBe("leading_or_trailing_hyphen");
    expect(checkSlugShape("acme-")?.code).toBe("leading_or_trailing_hyphen");
    expect(checkSlugShape("-acme-")?.code).toBe("leading_or_trailing_hyphen");
    expect(checkSlugShape("---")?.code).toBe("leading_or_trailing_hyphen");
  });

  it("allows an interior hyphen, and several", () => {
    expect(checkSlugShape("a-b-c")).toBeNull();
    expect(checkSlugShape("acme--corp")).toBeNull();
  });

  it("🔴 refuses a dot — the wildcard certificate covers ONE label", () => {
    /**
     * `acme.ordence.com` is covered by `*.ordence.com`.
     * `acme.corp.ordence.com` is not, and would serve a certificate
     * error to a paying customer with no way for them to understand why.
     * A dot in a slug is a broken workspace, not a nested one.
     */
    expect(checkSlugShape("acme.corp")?.code).toBe("bad_characters");
    expect(checkSlugShape("a.b")?.code).toBe("bad_characters");
    expect(isValidSlug("acme.corp")).toBe(false);
  });

  it("refuses everything else outside [a-z0-9-]", () => {
    for (const bad of ["acme_corp", "acme corp", "acme/corp", "acme:corp", "acme@corp", "acmé-corp", "acme+corp"]) {
      expect(checkSlugShape(bad)?.code, `"${bad}" was accepted`).toBe("bad_characters");
    }
  });

  it("refuses an empty or whitespace-only name before anything else", () => {
    expect(checkSlugShape("")?.code).toBe("empty");
    expect(checkSlugShape("   ")?.code).toBe("empty");
  });

  it("refuses every reserved name, and the reserved list is not empty", () => {
    expect(RESERVED_SLUGS.size).toBeGreaterThan(0);
    for (const reserved of RESERVED_SLUGS) {
      if (reserved.length < SLUG_MIN_LENGTH) continue; // refused earlier, by length
      if (!/^[a-z0-9-]+$/.test(reserved)) continue; // e.g. _domainkey, unreachable by shape
      expect(checkSlugShape(reserved)?.code, `"${reserved}" is no longer refused`).toBe("reserved");
    }
  });
});

/* ================================================================== */
/* 4. SUGGESTIONS ARE CANDIDATES, AND EVERY ONE IS CLAIMABLE           */
/* ================================================================== */

/**
 * Inputs chosen to hit the awkward paths: too long to suffix, entirely
 * illegal characters, reserved, already hyphenated, and the empty case.
 */
const SUGGESTION_INPUTS = [
  "acme",
  "acme-corp",
  "ACME Corp",
  "postmaster",
  "ordence",
  "0rdence",
  "zedbui1ders",
  "a",
  "ab",
  "a".repeat(SLUG_MAX_LENGTH),
  "a".repeat(SLUG_MAX_LENGTH - 4),
  "a".repeat(SLUG_MAX_LENGTH + 20),
  "acme.corp",
  "-acme-",
  "tata steel projects",
  "क", // no [a-z0-9-] at all
];

describe("suggestSlugs — a suggestion the form would then refuse is worse than none", () => {
  it.each(SUGGESTION_INPUTS)("every candidate for %j passes checkSlugShape", (input) => {
    for (const candidate of suggestSlugs(input)) {
      expect(
        checkSlugShape(candidate),
        `suggestSlugs("${input}") offered "${candidate}", which checkSlugShape refuses. ` +
          `The user clicks the name we made and we say no.`,
      ).toBeNull();
    }
  });

  it.each(SUGGESTION_INPUTS)("no candidate for %j exceeds the DNS label limit", (input) => {
    for (const candidate of suggestSlugs(input)) {
      expect(candidate.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    }
  });

  it.each(SUGGESTION_INPUTS)("no candidate for %j is offered twice", (input) => {
    const candidates = suggestSlugs(input);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("returns [] for an empty input, and for one with nothing usable in it", () => {
    expect(suggestSlugs("")).toEqual([]);
    expect(suggestSlugs("   ")).toEqual([]);
    expect(suggestSlugs("---")).toEqual([]);
    expect(suggestSlugs("!!!")).toEqual([]);
    expect(suggestSlugs("क")).toEqual([]);
  });

  it("offers something useful for an ordinary refusal", () => {
    /** A refusal with no way forward is a wall. */
    expect(suggestSlugs("acme").length).toBeGreaterThan(0);
    expect(suggestSlugs("postmaster").length).toBeGreaterThan(0);
  });

  it("honours the limit, and never returns more than asked for", () => {
    for (const limit of [0, 1, 3, 6, 20]) {
      expect(suggestSlugs("acme", limit).length).toBeLessThanOrEqual(limit);
    }
  });

  it("⚠️ returns none rather than an illegal one when the base leaves no room", () => {
    /**
     * A 63-character base plus any suffix is over the limit. The right
     * answer is an empty list, not a truncated name that means something
     * else.
     */
    expect(suggestSlugs("a".repeat(SLUG_MAX_LENGTH))).toEqual([]);
  });

  it("never suggests a reserved name", () => {
    for (const input of SUGGESTION_INPUTS) {
      for (const candidate of suggestSlugs(input)) {
        expect(RESERVED_SLUGS.has(candidate), `"${candidate}" is reserved`).toBe(false);
      }
    }
  });

  it("⚠️ suggestions are derived from the input, so they still read as the user's own name", () => {
    /** Not a wording assertion: the candidate must actually contain the
     *  normalised base, or the "suggestion" is an unrelated name. */
    for (const candidate of suggestSlugs("Acme Corp")) {
      expect(candidate.startsWith("acmecorp")).toBe(true);
    }
  });
});
