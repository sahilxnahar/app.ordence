/**
 * Ordence — the trust page tells the truth
 * Version: v1.52.x  (Batch 134)
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHAT THESE TESTS ARE ACTUALLY DEFENDING AGAINST
 * ══════════════════════════════════════════════════════════════════════
 * Not this commit. The trust page is honest today because somebody sat
 * down and made it honest. The risk is the edit eighteen months from now
 * — a launch, a big prospect, a marketing pass — where "bank-grade
 * encryption" gets added to a heading because it reads better, or "SOC 2
 * compliant" appears because a competitor's page has it.
 *
 * Nobody reviewing that pull request will think of it as a lie. It will
 * look like copy. So the check has to be mechanical.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHY THESE ASSERT PROPERTIES AND NOT STRINGS
 * ══════════════════════════════════════════════════════════════════════
 * A test that pins the page's exact wording fails on every legitimate
 * rewrite and teaches the next person to update the expected string
 * without reading it. These assert the properties that must survive ANY
 * rewrite:
 *
 *   1. No certification or superlative is claimed — a banned term may
 *      appear only inside a sentence that DENIES it.
 *   2. Every file the page offers as evidence actually exists.
 *   3. The gap section covers real ground rather than one token admission.
 *   4. The impersonation limits on the page equal the limits in the code.
 *   5. security.txt satisfies the parts of RFC 9116 that make it useful.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { HARD_CAP_MINUTES } from "@/lib/platform/impersonation-policy";
import { GET } from "@/app/security.txt/route";

const ROOT = process.cwd();
const TRUST_PAGE = resolve(ROOT, "app/(marketing)/trust/page.tsx");
const SECURITY_TXT = resolve(ROOT, "app/security.txt/route.ts");
const HOME_PAGE = resolve(ROOT, "app/page.tsx");

const read = (path: string): string => readFileSync(path, "utf8");

/**
 * 🔴 THE LIST. Ordence holds none of these certifications and none of
 * these adjectives mean anything measurable.
 *
 * "bank-grade" and "military-grade" describe no standard at all; a banker
 * who asks what grade that is receives no answer. "unhackable" is a claim
 * no system has ever been able to keep. The four certifications are real
 * standards, which is worse — the reader can and will ask for the report.
 */
const BANNED: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "SOC 2", pattern: /\bSOC\s*-?\s*2\b/i },
  { label: "ISO 27001", pattern: /\bISO\s*-?\s*27001\b/i },
  { label: "PCI", pattern: /\bPCI(\s*-?\s*DSS)?\b/i },
  { label: "HIPAA", pattern: /\bHIPAA\b/i },
  { label: "bank-grade", pattern: /\bbank[\s-]?grade\b/i },
  { label: "military-grade", pattern: /\bmilitary[\s-]?grade\b/i },
  { label: "unhackable", pattern: /\bunhackable\b/i },
];

/**
 * A term is permitted only where the surrounding sentence denies it.
 *
 * ⚠️ THIS IS THE WHOLE SUBTLETY OF THE TEST. Banning the words outright
 * would forbid the most valuable sentence on the page — "We hold no SOC 2
 * report and no ISO 27001 certificate" — and would push a future author
 * into deleting the admission instead of the claim. So the rule is not
 * "never say SOC 2"; it is "never say it without a negation attached".
 */
const NEGATION =
  /\b(no|not|none|never|neither|nor|without|cannot|lacks?|absent|do not|does not|have not|has not)\b/i;

/** Sentence-ish split: full stops, line breaks and list boundaries. */
function sentences(source: string): string[] {
  return source
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("the trust page makes no claim it cannot back", () => {
  const surfaces: readonly { readonly name: string; readonly path: string }[] = [
    { name: "the trust page", path: TRUST_PAGE },
    { name: "security.txt", path: SECURITY_TXT },
    { name: "the marketing home page", path: HOME_PAGE },
  ];

  for (const surface of surfaces) {
    for (const banned of BANNED) {
      it(`⭐ ${surface.name} never claims "${banned.label}" — it may only be denied`, () => {
        const offending = sentences(read(surface.path)).filter(
          (sentence) => banned.pattern.test(sentence) && !NEGATION.test(sentence),
        );

        /*
         * The message carries the offending sentence, because the person
         * who trips this will be mid-copy-edit and needs to see which line
         * they wrote, not merely that a rule exists.
         */
        expect(
          offending,
          `"${banned.label}" is claimed rather than denied in ${surface.path}:\n  ${offending.join("\n  ")}`,
        ).toEqual([]);
      });
    }
  }
});

describe("every claim points at something a reader can check", () => {
  /**
   * Any repository path the page names must resolve. A trust page whose
   * evidence trail is broken is back to being marketing: the reader is
   * asked to take the citation on faith, which is the thing the page was
   * written to avoid.
   */
  it("⭐ every file path cited on the trust page exists in this repository", () => {
    const source = read(TRUST_PAGE);
    const cited = new Set(source.match(/[\w./()[\]-]+\.(?:tsx?|mjs|sql)\b/g) ?? []);

    const missing = [...cited].filter((path) => !existsSync(resolve(ROOT, path)));

    expect(missing, `the page cites files that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  it("cites more than a token amount of evidence — a page with one citation is prose", () => {
    const cited = new Set(read(TRUST_PAGE).match(/[\w./()[\]-]+\.(?:tsx?|mjs|sql)\b/g) ?? []);
    expect(cited.size).toBeGreaterThan(3);
  });
});

describe("the honest-gaps section stays substantial", () => {
  /**
   * ⭐ A CA who has read a dozen vendor pages discounts the perfect ones.
   * This section is why the rest of the page is believable, so the test
   * guards its BREADTH rather than its wording: several different kinds of
   * gap, not one safe admission kept as decoration.
   */
  const TOPICS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
    { label: "audit reports / certification", pattern: /\b(SOC|ISO\s*-?\s*27001|certificat)/i },
    { label: "penetration testing", pattern: /\bpenetration test/i },
    { label: "uptime commitment", pattern: /\buptime\b/i },
    { label: "customer-managed keys", pattern: /\bkeys?\b/i },
    { label: "data residency", pattern: /\bresidency\b|\bregion\b/i },
  ];

  it("admits gaps across several different areas, not one", () => {
    const source = read(TRUST_PAGE);
    const covered = TOPICS.filter((topic) => topic.pattern.test(source)).map((t) => t.label);
    expect(covered.length, `only covered: ${covered.join(", ")}`).toBeGreaterThanOrEqual(3);
  });

  it("says plainly that it is describing things Ordence does NOT have", () => {
    /* The gap section must be legible as a gap section without colour. */
    expect(read(TRUST_PAGE)).toMatch(/do not have/i);
  });
});

describe("stated limits equal enforced limits", () => {
  /**
   * 🔴 THE FAILURE THIS CATCHES: somebody raises the impersonation cap in
   * `lib/platform/impersonation-policy.ts` and the trust page keeps
   * advertising the old number. That turns a true statement into a false
   * one with no edit to this page at all — which is precisely the class of
   * lie nobody notices.
   */
  const WORDS: Readonly<Record<number, string>> = {
    15: "fifteen",
    30: "thirty",
    45: "forty-five",
    60: "sixty",
  };

  it("the session cap written on the page is the cap the code enforces", () => {
    const word = WORDS[HARD_CAP_MINUTES];
    expect(word, `no spelled-out word for a ${HARD_CAP_MINUTES}-minute cap`).toBeDefined();

    const source = read(TRUST_PAGE);
    /* ⚠️ The WORD, not a numeral — the page spells numbers out in prose. */
    expect(source).toMatch(new RegExp(`${word}\\s+minutes`, "i"));

    /* And no other cap is advertised alongside it. */
    for (const [minutes, other] of Object.entries(WORDS)) {
      if (Number(minutes) === HARD_CAP_MINUTES) continue;
      if (Number(minutes) === 15) continue; // break-glass, a genuinely shorter limit
      expect(
        source,
        `the page advertises a ${minutes}-minute session cap that the code does not enforce`,
      ).not.toMatch(new RegExp(`${other}\\s+minutes`, "i"));
    }
  });

  it("describes support access as read-only by default, which is what the policy resolves to", () => {
    expect(read(TRUST_PAGE)).toMatch(/read-only by default/i);
  });
});

describe("security.txt is useful to somebody holding a vulnerability", () => {
  it("serves plain text, not HTML — scanners skip anything else", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("carries a Contact field, which is the only field that matters in a hurry", async () => {
    const body = await GET().text();
    expect(body).toMatch(/^Contact:\s*mailto:\S+@\S+/m);
  });

  it("⚠️ carries an Expires that is in the future and under a year out — a stale one signals nobody is home", async () => {
    const body = await GET().text();
    const line = /^Expires:\s*(\S+)/m.exec(body);
    expect(line, "RFC 9116 requires an Expires field").not.toBeNull();

    const raw = line?.[1];
    expect(raw).toBeDefined();

    const expires = new Date(raw ?? "").getTime();
    expect(Number.isNaN(expires)).toBe(false);

    const now = Date.now();
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    expect(expires).toBeGreaterThan(now);
    expect(expires - now).toBeLessThan(oneYear);
  });

  it("points at the trust page, so a reporter can see the policy before writing", async () => {
    const body = await GET().text();
    expect(body).toMatch(/\/trust\b/);
  });
});
