/**
 * Ordence — Wave 2E, white-labelling: the proofs
 * Version: v1.90.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT TEST
 * ══════════════════════════════════════════════════════════════════════
 * It does not test "the colour applies". A test that a brand colour ends
 * up in a CSS variable passes on the day the feature is written and never
 * fails again, because nothing anybody would plausibly do breaks it.
 *
 * It tests the two things that WILL be broken by a well-meaning change:
 *
 *   1. THAT A BRAND COLOUR WHICH FAILS CONTRAST IS CAUGHT AND HANDLED.
 *      Induced with a pale yellow (fails) and a near-black (passes), and
 *      both outcomes are asserted — a check that only ever sees the
 *      passing case is a check that has never run.
 *
 *   2. THAT NO STATUS COLOUR MOVED. Green means the figures tie, amber
 *      that a person must look, red that something blocks the cutover.
 *      The assertion is byte equality of every reserved token before and
 *      after a brand is applied, across a spread of brands including a
 *      red one and a green one — because "theme the whole palette, it
 *      looks more branded" is the change somebody makes in six months.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  parseHex,
  toHex,
  contrastRatio,
  adjustForContrast,
  readableInk,
  rgbToHsl,
  hslToRgb,
  toCssTriple,
  AA_TEXT,
  AA_NON_TEXT,
} from "@/lib/branding/color";
import {
  BRANDABLE,
  RESERVED,
  brandCssVariables,
  brandStyleSheet,
  evaluateContrast,
  BRAND_SCOPE_CLASS,
} from "@/lib/branding/tokens";
import { extractPalette, dominantColour } from "@/lib/branding/extract";
import { logoSrc, servableLogoKey, wordmark, LOGO_ROUTE } from "@/lib/branding/logo";
import { parseBranding, mergeBranding } from "@/lib/branding/schema";
import { shouldPromptBrandingSetup } from "@/lib/branding/first-run";
import { MAX_WATERMARK_OPACITY } from "@/components/branding/brand-watermark";

const ROOT = path.resolve(__dirname, "../..");

/** The pale yellow from the wave brief: unreadable as text on white. */
const PALE_YELLOW = "#F5E663";
/** The near-black from the wave brief: readable without adjustment. */
const NEAR_BLACK = "#141414";

/* ================================================================== */
/* 1. CONTRAST — BOTH OUTCOMES, INDUCED                                */
/* ================================================================== */

describe("a brand colour that fails contrast is caught, not silently substituted", () => {
  it("refuses to let a pale yellow carry text, and says what it did instead", () => {
    const verdict = evaluateContrast(PALE_YELLOW, "light");
    expect(verdict).not.toBeNull();
    if (!verdict) return;

    /* THE INDUCED FAILURE. If this ever passes, the check is not running. */
    expect(verdict.passesText).toBe(false);
    expect(verdict.chosenRatio).toBeLessThan(AA_TEXT);

    /* It is still perfectly good as a border — that is the whole point. */
    expect(verdict.chosen).toBe("#f5e663");

    /* And the text variant is DARKER and DOES pass. */
    expect(verdict.applied).not.toBe(verdict.chosen);
    expect(verdict.appliedRatio).toBeGreaterThanOrEqual(AA_TEXT);
    expect(verdict.unreachable).toBe(false);

    /*
     * The adjusted colour is the same hue. A "fix" that swapped in a
     * different colour would pass every ratio assertion above and would
     * be exactly the silent substitution this is here to prevent.
     */
    const chosenHue = rgbToHsl(parseHex(verdict.chosen)!).h;
    const appliedHue = rgbToHsl(parseHex(verdict.applied)!).h;
    expect(Math.abs(chosenHue - appliedHue)).toBeLessThan(2);
  });

  it("leaves a near-black alone, because it already reads", () => {
    const verdict = evaluateContrast(NEAR_BLACK, "light");
    expect(verdict).not.toBeNull();
    if (!verdict) return;

    expect(verdict.passesText).toBe(true);
    expect(verdict.chosenRatio).toBeGreaterThanOrEqual(AA_TEXT);
    /* Untouched: applied === chosen. */
    expect(verdict.applied).toBe(verdict.chosen);
    expect(verdict.appliedRatio).toBeCloseTo(verdict.chosenRatio, 6);
  });

  it("judges the dark theme separately — a colour can pass one and fail the other", () => {
    const lightVerdict = evaluateContrast(NEAR_BLACK, "light");
    const darkVerdict = evaluateContrast(NEAR_BLACK, "dark");
    expect(lightVerdict?.passesText).toBe(true);
    /* Near-black on the dark page background is exactly the failure a
       single-theme check would ship. */
    expect(darkVerdict?.passesText).toBe(false);
    expect(darkVerdict?.appliedRatio).toBeGreaterThanOrEqual(AA_TEXT);

    /* And the correction went the other way — lighter, not darker. */
    const chosenL = rgbToHsl(parseHex(darkVerdict!.chosen)!).l;
    const appliedL = rgbToHsl(parseHex(darkVerdict!.applied)!).l;
    expect(appliedL).toBeGreaterThan(chosenL);
  });

  it("reports `unreachable` rather than pretending, when no shade can reach AA", () => {
    /*
     * Pure white against the white page background. There is no lightness
     * this hue can move to that clears 4.5:1 downwards without leaving
     * white behind entirely — the walk stops at black, which does pass,
     * so the interesting case is the OPPOSITE end: a colour on the dark
     * page that cannot be lightened enough. Use white on light.
     */
    const verdict = evaluateContrast("#ffffff", "light");
    expect(verdict?.passesText).toBe(false);
    /* Either it reached AA by going dark, or it says it could not.
       What it must never do is claim to pass. */
    if (verdict?.unreachable) {
      expect(verdict.appliedRatio).toBeLessThan(AA_TEXT);
    } else {
      expect(verdict!.appliedRatio).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("puts readable ink on the brand, by luminance and not by lightness", () => {
    /* Saturated yellow: L=50 in HSL, but far too bright for white text. */
    const yellow = parseHex("#FFD400")!;
    const ink = readableInk(yellow);
    expect(toHex(ink.colour)).toBe("#1a1a1a");
    expect(ink.ratio).toBeGreaterThanOrEqual(AA_TEXT);

    /* Saturated blue: the same HSL lightness, and white is correct. */
    const blue = parseHex("#1D4ED8")!;
    expect(toHex(readableInk(blue).colour)).toBe("#ffffff");
  });

  it("🔴 the EMITTED --primary clears AA, not merely the verdict that describes it", () => {
    /*
     * ══════════════════════════════════════════════════════════════
     * WHY THIS TEST EXISTS, AND IT IS THE MOST IMPORTANT ONE HERE
     * ══════════════════════════════════════════════════════════════
     * The first version of this file asserted `evaluateContrast()` — the
     * verdict SHOWN ON THE SCREEN — and nothing else. Deleting the
     * adjustment from `brandCssVariables()`, so that the pale yellow was
     * emitted verbatim into `--primary`, left all forty-four tests
     * green: the screen still said "we darkened it" while the browser
     * received the colour undarkened.
     *
     * That is this codebase's characteristic defect exactly —
     * declared-and-unenforced — reproduced inside the check written to
     * catch it, which is where it has been found four times before. The
     * assertion below is on the VALUE THAT SHIPS.
     */
    for (const scheme of ["light", "dark"] as const) {
      const background = scheme === "light" ? { r: 255, g: 255, b: 255 } : { r: 18, g: 18, b: 18 };
      for (const brand of [PALE_YELLOW, NEAR_BLACK, "#FFFFFF", "#1D4ED8", "#15803D"]) {
        const vars = brandCssVariables(brand, scheme) as Record<string, string>;
        const [h, s, l] = vars["--primary"]!.replace(/%/g, "").split(" ").map(Number);
        const emitted = hslToRgb({ h: h!, s: s!, l: l! });
        expect(
          contrastRatio(emitted, background),
          `--primary for ${brand} in the ${scheme} theme`,
        ).toBeGreaterThanOrEqual(AA_TEXT);

        /* And its ink is readable ON it — a button is text on a fill. */
        const [ih, is, il] = vars["--primary-foreground"]!.replace(/%/g, "").split(" ").map(Number);
        const ink = hslToRgb({ h: ih!, s: is!, l: il! });
        expect(contrastRatio(ink, emitted)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    }
  });

  it("the focus ring only has to clear the non-text bar, and does", () => {
    const vars = brandCssVariables(PALE_YELLOW, "light") as Record<string, string>;
    const ring = vars["--ring"];
    expect(ring).toBeTruthy();
    const [h, s, l] = ring!.replace(/%/g, "").split(" ").map(Number);
    const rgb = hslToRgb({ h: h!, s: s!, l: l! });
    expect(contrastRatio(rgb, { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(
      AA_NON_TEXT - 0.05,
    );
  });
});

/* ================================================================== */
/* 2. NO STATUS COLOUR MOVED — BYTE-IDENTICAL                          */
/* ================================================================== */

/** Read `:root` and `.dark` out of the real stylesheet, as text. */
function readGlobalTokens(block: ":root" | ".dark"): Record<string, string> {
  const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
  const start = css.indexOf(`${block} {`);
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  const body = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = /^\s*(--[a-z-]+):\s*([^;]+);/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  expect(Object.keys(out).length).toBeGreaterThan(10);
  return out;
}

describe("branding cannot move a status colour", () => {
  const brands = [
    "#B91C1C", // a red brand — the case in the brief
    "#15803D", // a green brand
    "#D97706", // an amber brand
    PALE_YELLOW,
    NEAR_BLACK,
    "#1D4ED8",
  ];

  it("emits nothing outside the allowlist, for any brand", () => {
    for (const brand of brands) {
      for (const scheme of ["light", "dark"] as const) {
        const emitted = Object.keys(brandCssVariables(brand, scheme));
        for (const name of emitted) {
          expect(BRANDABLE as readonly string[]).toContain(name);
        }
      }
    }
  });

  it("the allowlist and the reserved list do not intersect", () => {
    for (const name of BRANDABLE) {
      expect(Object.keys(RESERVED)).not.toContain(name);
    }
    /* And every status-bearing token is actually reserved, by name. */
    for (const name of ["--destructive", "--destructive-foreground", "--foreground", "--background"]) {
      expect(Object.keys(RESERVED)).toContain(name);
    }
  });

  it("leaves every reserved token BYTE-IDENTICAL after a brand is applied", () => {
    for (const scheme of ["light", "dark"] as const) {
      const before = readGlobalTokens(scheme === "light" ? ":root" : ".dark");

      for (const brand of brands) {
        const overrides = brandCssVariables(brand, scheme) as Record<string, string>;
        const after = { ...before, ...overrides };

        for (const name of Object.keys(RESERVED)) {
          if (!(name in before)) continue;
          /* Byte equality of the declaration text, not a colour comparison. */
          expect(after[name]).toBe(before[name]);
        }

        /* Named explicitly, because these three are the ones that matter. */
        expect(after["--destructive"]).toBe(before["--destructive"]);
        expect(after["--destructive-foreground"]).toBe(before["--destructive-foreground"]);
        expect(after["--foreground"]).toBe(before["--foreground"]);
      }
    }
  });

  it("no file in this wave writes a status colour into a custom property", () => {
    /*
     * The source-text half of the same claim. `brandCssVariables` filters
     * its own output, so the only way to reintroduce the defect is a
     * second emitter somewhere in the wave's files.
     */
    const files = [
      "lib/branding/tokens.ts",
      "lib/branding/color.ts",
      "components/branding/brand-scope.tsx",
      "components/branding/brand-watermark.tsx",
    ];
    for (const file of files) {
      let source = readFileSync(path.join(ROOT, file), "utf8");
      /*
       * The RESERVED map in tokens.ts NAMES every forbidden property, as
       * a key with a reason for a value. That is the refusal itself, not
       * an emission — so it is cut out before the scan. Cutting it is
       * safe because the runtime assertions above already prove the
       * emitter cannot produce those names whatever the source says.
       */
      const reservedStart = source.indexOf("export const RESERVED");
      if (reservedStart > -1) {
        const reservedEnd = source.indexOf("});", reservedStart);
        source = source.slice(0, reservedStart) + source.slice(reservedEnd);
      }
      /* A declaration, not a mention: `"--destructive":` assigns it. */
      expect(source).not.toMatch(/["'`]--destructive(-foreground)?["'`]\s*:/);
      expect(source).not.toMatch(/["'`]--foreground["'`]\s*:/);
      expect(source).not.toMatch(/["'`]--background["'`]\s*:/);
    }
  });

  it("the stylesheet is class-scoped and never touches :root", () => {
    const sheet = brandStyleSheet("#1D4ED8");
    expect(sheet).toContain(`.${BRAND_SCOPE_CLASS}{`);
    expect(sheet).toContain(`.dark .${BRAND_SCOPE_CLASS}{`);
    /* 🔴 A `:root` rule would be global and would reach the operator
       console. There must not be one. */
    expect(sheet).not.toContain(":root");
    expect(sheet).not.toContain("html");
  });

  it("emits bare HSL triples, because Tailwind wraps them", () => {
    const sheet = brandStyleSheet("#1D4ED8");
    /* `hsl(hsl(...))` is invalid and drops silently — the failure mode is
       a workspace that quietly ignores its own brand. */
    expect(sheet).not.toContain("hsl(");
    expect(sheet).not.toContain("#");
    expect(sheet).toMatch(/--primary:\d+ \d+% \d+%;/);
  });

  it("an unparseable colour brands nothing at all", () => {
    expect(brandCssVariables("not-a-colour", "light")).toEqual({});
    expect(brandStyleSheet("")).toBe("");
    expect(evaluateContrast("#gggggg")).toBeNull();
  });
});

/* ================================================================== */
/* 3. THE PALETTE COMES OUT OF THE LOGO                                */
/* ================================================================== */

/** Build RGBA pixel data from a list of [r,g,b,a,count] runs. */
function pixels(runs: [number, number, number, number, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [r, g, b, a, count] of runs) {
    for (let i = 0; i < count; i += 1) out.push(r, g, b, a);
  }
  return Uint8ClampedArray.from(out);
}

describe("the colour is derived from the logo", () => {
  it("ignores the white background and the black wordmark", () => {
    const data = pixels([
      [255, 255, 255, 255, 900], // background — the majority of any logo
      [10, 10, 10, 255, 80], // the wordmark
      [29, 78, 216, 255, 20], // the actual brand, a small device
    ]);
    const palette = extractPalette(data);
    expect(palette.length).toBe(1);
    expect(dominantColour(palette)).toBe("#1d4ed8");
  });

  it("ignores transparent padding", () => {
    const data = pixels([
      [29, 78, 216, 0, 500], // brand colour, but fully transparent
      [180, 30, 30, 255, 10],
    ]);
    expect(dominantColour(extractPalette(data))).toBe("#b41e1e");
  });

  it("offers alternates that are actually different colours", () => {
    const data = pixels([
      [29, 78, 216, 255, 100], // blue
      [33, 82, 220, 255, 90], // near-identical blue — must NOT be offered twice
      [200, 30, 30, 255, 60], // red
      [20, 160, 90, 255, 30], // green
    ]);
    const palette = extractPalette(data);
    expect(palette.length).toBe(3);
    const hues = palette.map((c) => rgbToHsl(parseHex(c.hex)!).h);
    for (let i = 1; i < hues.length; i += 1) {
      expect(Math.abs(hues[i]! - hues[i - 1]!)).toBeGreaterThan(20);
    }
    /* Most popular first — the pre-selected one is the dominant one. */
    expect(palette[0]!.weight).toBeGreaterThanOrEqual(palette[1]!.weight);
  });

  it("says it found nothing rather than returning grey, for a monochrome logo", () => {
    const data = pixels([[255, 255, 255, 255, 500], [0, 0, 0, 255, 500]]);
    expect(extractPalette(data)).toEqual([]);
    expect(dominantColour([])).toBeNull();
  });
});

/* ================================================================== */
/* 4. THE LOGO, AND WHAT HAPPENS WHEN IT DOES NOT LOAD                 */
/* ================================================================== */

const belongs = (key: string, tenantId: string): boolean =>
  !key.includes("..") && key.startsWith(`tenants/${tenantId}/`);

describe("the logo falls back to a readable wordmark", () => {
  it("prefers the uploaded key over the Clerk image", () => {
    const src = logoSrc({
      logoKey: "tenants/t1/branding/t1/1-logo.png",
      logoUrl: "https://img.clerk.com/x.png",
      logoUpdatedAt: 1234,
    });
    expect(src).toBe(`${LOGO_ROUTE}?v=1234`);
  });

  it("falls back to the Clerk image when nothing was uploaded", () => {
    expect(logoSrc({ logoUrl: "https://img.clerk.com/x.png" })).toBe(
      "https://img.clerk.com/x.png",
    );
  });

  it("refuses a non-https stored URL", () => {
    expect(logoSrc({ logoUrl: "javascript:alert(1)" })).toBeNull();
    expect(logoSrc({ logoUrl: "http://example.com/x.png" })).toBeNull();
  });

  it("has no logo at all for an empty branding object, and still names the workspace", () => {
    expect(logoSrc({})).toBeNull();
    expect(wordmark("Basaveshwar Constructions")).toBe("Basaveshwar Constructions");
    /* A workspace with a blank name still gets a word, never an empty box. */
    expect(wordmark("   ")).toBe("Workspace");
  });
});

describe("the logo route may only ever serve this tenant's object", () => {
  it("serves a key inside the tenant's own prefix", () => {
    expect(
      servableLogoKey({ logoKey: "tenants/t1/branding/t1/1-logo.png" }, "t1", belongs),
    ).toBe("tenants/t1/branding/t1/1-logo.png");
  });

  it("🔴 REFUSES a key belonging to another tenant", () => {
    expect(
      servableLogoKey({ logoKey: "tenants/VICTIM/contract/x/secret.pdf" }, "t1", belongs),
    ).toBeNull();
  });

  it("🔴 REFUSES traversal out of the prefix", () => {
    expect(
      servableLogoKey({ logoKey: "tenants/t1/../VICTIM/contract/x.pdf" }, "t1", belongs),
    ).toBeNull();
  });

  it("serves nothing when no logo was uploaded", () => {
    expect(servableLogoKey({ logoUrl: "https://x/y.png" }, "t1", belongs)).toBeNull();
  });
});

describe("the watermark cannot be turned up", () => {
  it("is capped at 4%", () => {
    expect(MAX_WATERMARK_OPACITY).toBeLessThanOrEqual(0.04);
    /* The component clamps rather than trusting its prop; the constant is
       the thing a future change has to move, with the comment attached. */
    expect(Math.min(MAX_WATERMARK_OPACITY, 0.5)).toBe(MAX_WATERMARK_OPACITY);
  });
});

/* ================================================================== */
/* 5. THE STORED SHAPE — THREE WRITERS, ONE COLUMN                     */
/* ================================================================== */

describe("branding is merged into, never replaced", () => {
  it("keeps keys this wave does not know about", () => {
    const existing = {
      logoUrl: "https://img.clerk.com/x.png",
      fontFamily: "Inter",
      accentColor: "#1A1A1A",
      primaryColor: "#B08D3C",
    };
    const merged = mergeBranding(existing, { primaryColor: "#1D4ED8" });
    expect(merged.primaryColor).toBe("#1D4ED8");
    /* The Clerk webhook's values survive. If they did not, the two
       writers would fight and the value would flicker. */
    expect(merged.logoUrl).toBe("https://img.clerk.com/x.png");
    expect(merged.fontFamily).toBe("Inter");
    expect(merged.accentColor).toBe("#1A1A1A");
  });

  it("removes a key when the patch says null", () => {
    const merged = mergeBranding({ logoKey: "tenants/t1/a", logoUrl: "https://x/y.png" }, {
      logoKey: null,
      logoUrl: null,
    });
    expect(merged.logoKey).toBeUndefined();
    expect(merged.logoUrl).toBeUndefined();
  });

  it("never throws on whatever the column happens to hold", () => {
    expect(parseBranding(null)).toEqual({});
    expect(parseBranding("a string")).toEqual({});
    expect(parseBranding(42)).toEqual({});
    expect(parseBranding({ primaryColor: "rgb(1,2,3)" })).toEqual({});
    expect(parseBranding({ primaryColor: "#ABC" }).primaryColor).toBe("#ABC");
  });
});

/* ================================================================== */
/* 6. THE FIRST-RUN PROMPT                                             */
/* ================================================================== */

describe("who gets sent to the branding screen unasked", () => {
  it("an owner of a workspace that has never decided", () => {
    expect(shouldPromptBrandingSetup({ branding: {}, role: "tenant_owner" })).toBe(true);
    expect(shouldPromptBrandingSetup({ branding: {}, role: "tenant_admin" })).toBe(true);
  });

  it("🔴 NEVER a member — they cannot submit the form and it is a dead end", () => {
    expect(shouldPromptBrandingSetup({ branding: {}, role: "tenant_member" })).toBe(false);
    expect(shouldPromptBrandingSetup({ branding: {}, role: "tenant_viewer" })).toBe(false);
  });

  it("never twice — skipping is a decision", () => {
    expect(
      shouldPromptBrandingSetup({ branding: { setupCompletedAt: 1 }, role: "tenant_owner" }),
    ).toBe(false);
  });

  it("never a workspace that already has a logo", () => {
    expect(
      shouldPromptBrandingSetup({ branding: { logoKey: "tenants/t1/a" }, role: "tenant_owner" }),
    ).toBe(false);
  });
});

/* ================================================================== */
/* 7. THE ACTION                                                       */
/* ================================================================== */

const h = vi.hoisted(() => {
  const state = {
    sets: [] as Record<string, unknown>[],
    wheres: [] as unknown[],
    audits: [] as Record<string, unknown>[],
    tenant: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Acme",
      branding: {
        logoUrl: "https://img.clerk.com/x.png",
        fontFamily: "Inter",
        primaryColor: "#B08D3C",
      } as Record<string, unknown>,
    },
  };

  class FakeUpdate {
    set(values: Record<string, unknown>) {
      state.sets.push(values);
      return this;
    }
    where(condition: unknown) {
      state.wheres.push(condition);
      return this;
    }
    returning() {
      return Promise.resolve([{ id: state.tenant.id }]);
    }
  }

  return {
    state,
    tx: { update: () => new FakeUpdate() },
  };
});

vi.mock("@/db", () => ({
  db: h.tx,
  withTenant: (_id: string, cb: (tx: unknown) => unknown) => cb(h.tx),
}));

vi.mock("@/server/audit", () => ({
  requirePermission: vi.fn(async () => ({
    tenant: h.state.tenant,
    user: { id: "u1" },
    role: "tenant_owner",
  })),
  writeAudit: vi.fn(async (_ctx: unknown, entry: Record<string, unknown>) => {
    h.state.audits.push(entry);
  }),
  auditMeta: (meta: Record<string, unknown>) => meta,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { updateBranding } = await import("@/server/actions/branding");

describe("updateBranding", () => {
  beforeEach(() => {
    h.state.sets = [];
    h.state.wheres = [];
    h.state.audits = [];
    h.state.tenant.branding = {
      logoUrl: "https://img.clerk.com/x.png",
      fontFamily: "Inter",
      primaryColor: "#B08D3C",
    };
  });

  it("saves the colour and keeps the other writers' keys", async () => {
    const result = await updateBranding({ primaryColor: "#1D4ED8" });
    expect(result.ok).toBe(true);
    const written = h.state.sets[0]!.branding as Record<string, unknown>;
    expect(written.primaryColor).toBe("#1D4ED8");
    expect(written.logoUrl).toBe("https://img.clerk.com/x.png");
    expect(written.fontFamily).toBe("Inter");
  });

  it("🔴 REFUSES a logo key belonging to another tenant, and writes nothing", async () => {
    const result = await updateBranding({
      primaryColor: "#1D4ED8",
      logoKey: "tenants/22222222-2222-4222-8222-222222222222/contract/x/secret.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does not belong/i);
    /* The induced failure's real assertion: no UPDATE was issued at all. */
    expect(h.state.sets).toEqual([]);
    expect(h.state.audits).toEqual([]);
  });

  it("accepts a key inside this tenant's own prefix", async () => {
    const key = `tenants/${h.state.tenant.id}/branding/${h.state.tenant.id}/1-logo.png`;
    const result = await updateBranding({ primaryColor: "#1D4ED8", logoKey: key });
    expect(result.ok).toBe(true);
    const written = h.state.sets[0]!.branding as Record<string, unknown>;
    expect(written.logoKey).toBe(key);
    expect(typeof written.logoUpdatedAt).toBe("number");
  });

  it("refuses a colour that is not a hex value", async () => {
    const result = await updateBranding({ primaryColor: "red" });
    expect(result.ok).toBe(false);
    expect(h.state.sets).toEqual([]);
  });

  it("records the contrast decision in the audit log", async () => {
    await updateBranding({ primaryColor: PALE_YELLOW });
    const entry = h.state.audits[0]!;
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.event).toBe("branding_updated");
    expect(meta.contrastAdjusted).toBe(true);
    expect(typeof meta.contrastRatio).toBe("number");
  });

  it("clearing the logo clears the Clerk fallback with it", async () => {
    const result = await updateBranding({ primaryColor: "#1D4ED8", removeLogo: true });
    expect(result.ok).toBe(true);
    const written = h.state.sets[0]!.branding as Record<string, unknown>;
    expect(written.logoKey).toBeUndefined();
    expect(written.logoUrl).toBeUndefined();
  });
});

/* A guard on the guard: the colour helpers themselves. */
describe("colour maths", () => {
  it("round-trips hex → hsl → hex within a rounding step", () => {
    for (const hex of ["#1d4ed8", "#b08d3c", "#f5e663", "#141414", "#ffffff"]) {
      const rgb = parseHex(hex)!;
      const back = hslToRgb(rgbToHsl(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it("matches the WCAG reference ratio for black on white", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 5);
  });

  it("accepts the three-digit form and rejects everything else", () => {
    expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex("abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHex("#abcd")).toBeNull();
    expect(parseHex(null)).toBeNull();
    expect(parseHex(123)).toBeNull();
  });

  it("emits the bare triple Tailwind expects", () => {
    expect(toCssTriple({ h: 38.4, s: 45.2, l: 46.1 })).toBe("38 45% 46%");
  });

  it("reports movedBy 0 when nothing had to move", () => {
    const result = adjustForContrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, AA_TEXT);
    expect(result.movedBy).toBe(0);
    expect(result.met).toBe(true);
  });
});
