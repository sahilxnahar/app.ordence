/**
 * Ordence — the public slug-availability endpoint
 * Version: v1.57.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ WHAT THIS ENDPOINT IS, SO THAT WHAT IS TESTED MAKES SENSE
 * ══════════════════════════════════════════════════════════════════════
 *      The availability check is advisory.
 *      The unique index is the truth.
 *      The insert is the claim.
 *
 * Nothing here can prevent a duplicate, and no test below pretends it
 * can. What this file pins are the three things that would make the
 * endpoint actively harmful rather than merely advisory:
 *
 *   1. IT ASKS THE SAME QUESTIONS THE DATABASE ASKS, IN THE SAME ORDER.
 *      An availability check written from a different mental model than
 *      the insert is blind to precisely the mistakes the insert makes.
 *      That has already happened in this product: two reserved lists and
 *      two minimum lengths, and the customer's front door was dead while
 *      every log said success.
 *
 *   2. 🔴 A DATABASE FAILURE IS NOT A YES. The tempting failure path
 *      returns `available: true` so the signup button stays enabled
 *      during a blip. That teaches the form to say yes precisely when it
 *      knows least, and it is the one failure mode here that silently
 *      produces a duplicate.
 *
 *   3. EVERY SUGGESTION HAS ITSELF BEEN CHECKED. A suggestion that is
 *      taken is worse than no suggestion: the user clicks the name we
 *      made and we refuse it, on the one screen where they most need to
 *      believe our answers.
 *
 * ⚠️ AS EVERYWHERE IN GROUP A, THE ASSERTIONS ARE ON `code` AND ON
 *    STRUCTURE, NEVER ON THE ENGLISH. Where a message is compared it is
 *    compared against `SLUG_REJECTIONS`, so a rewording moves both sides
 *    together.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/db", () => ({ withPlatformScope: vi.fn() }));
vi.mock("@/lib/edge/limits", () => ({
  checkEdgeLimit: vi.fn(),
  edgeLimitStatus: (decision: { mode?: string }) => (decision.mode === "closed" ? 503 : 429),
}));

import { withPlatformScope } from "@/db";
import { checkEdgeLimit } from "@/lib/edge/limits";
import { SLUG_REJECTIONS, foldSlug, suggestSlugs } from "@/lib/slug";
import { checkSlugAvailability } from "@/app/api/public/slug-available/_availability";

const dialect = new PgDialect();

/* ================================================================== */
/* A DATABASE THAT ANSWERS, AND REMEMBERS WHAT IT WAS ASKED           */
/* ================================================================== */

type World = {
  /** Slugs held by a tenant row (soft-deleted or not — the index does not care). */
  tenants: Set<string>;
  /** Folds held by a tenant row. */
  folds: Set<string>;
  /** Slugs released inside the retention window. */
  released: Set<string>;
  /** Folds released inside the retention window. */
  releasedFolds: Set<string>;
};

const emptyWorld = (): World => ({
  tenants: new Set(),
  folds: new Set(),
  released: new Set(),
  releasedFolds: new Set(),
});

type Asked = { kind: string; text: string; params: unknown[] };

/**
 * Classify a statement by what it is FOR, not by its wording. The order
 * assertion below is about which question was asked, and reformatting
 * the SQL must not break it.
 */
function classify(text: string): string {
  if (/UNION ALL/i.test(text)) return "suggestions";
  if (/tenant_slug_history/i.test(text)) return "retention";
  if (/slug_fold\s*=/i.test(text)) return "fold";
  if (/\bslug\s*=/i.test(text)) return "exact";
  return "unknown";
}

function installDatabase(world: World): Asked[] {
  const asked: Asked[] = [];

  vi.mocked(withPlatformScope).mockImplementation((async (
    _reason: string,
    callback: (tx: unknown) => Promise<unknown>,
  ) => {
    const tx = {
      async execute(query: SQL) {
        const { sql: text, params } = dialect.sqlToQuery(query);
        const flat = text.replace(/\s+/g, " ").trim();
        const kind = classify(flat);
        asked.push({ kind, text: flat, params });

        switch (kind) {
          case "retention": {
            const [slug, fold] = params.slice(-2) as string[];
            return world.released.has(slug) || world.releasedFolds.has(fold) ? [{ "?column?": 1 }] : [];
          }
          case "exact":
            return world.tenants.has(String(params[0])) ? [{ "?column?": 1 }] : [];
          case "fold":
            return world.folds.has(String(params[0])) ? [{ "?column?": 1 }] : [];
          case "suggestions": {
            const rows: Array<{ slug: string | null; slug_fold: string | null }> = [];
            for (const param of params as string[]) {
              if (world.tenants.has(param) || world.released.has(param)) {
                rows.push({ slug: param, slug_fold: foldSlug(param) });
              }
              if (world.folds.has(param) || world.releasedFolds.has(param)) {
                rows.push({ slug: null, slug_fold: param });
              }
            }
            return rows;
          }
          default:
            throw new Error(`the fake database was asked something it does not recognise: ${flat}`);
        }
      },
    };
    return callback(tx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);

  return asked;
}

/** `withPlatformScope` that fails, i.e. the database is unreachable. */
function installBrokenDatabase() {
  vi.mocked(withPlatformScope).mockImplementation((async () => {
    throw new Error("connection terminated unexpectedly");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

const ALLOWED = {
  allowed: true,
  surface: "api",
  mode: "shared",
  reason: "ok",
  tier: null,
  tierSource: "n/a",
  limit: 10,
  remaining: 9,
  retryAfterSeconds: 0,
};

function allowEveryRequest() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(checkEdgeLimit).mockImplementation((async () => ALLOWED) as any);
}

const post = (body: unknown) =>
  new Request("https://ordence.com/api/public/slug-available", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

type Body = {
  available: boolean;
  reason?: { code: string; message: string };
  suggestions?: string[];
};

async function ask(slug: unknown) {
  const response = await checkSlugAvailability(post({ slug }));
  return { response, body: (await response.json()) as Body };
}

beforeEach(() => {
  vi.clearAllMocks();
  allowEveryRequest();
});

/* ================================================================== */
/* 1. THE ORDER OF THE CHECKS                                          */
/* ================================================================== */

describe("🔴 the checks run in the database's own order", () => {
  it("shape, reserved, retention, exact unique, fold unique", async () => {
    /**
     * Steps 1 and 2 are `checkSlugShape()` — the same function the
     * resolver and the operator console use — and leave no statement
     * behind. Steps 3 to 5 are the trigger's and the two indexes' own
     * predicates, and must be asked in that sequence: a `taken` answer
     * for a name that is actually inside the retention window would send
     * the user off inventing a new name for the wrong reason.
     */
    const asked = installDatabase(emptyWorld());
    const { body } = await ask("acme-corp");

    expect(body.available).toBe(true);
    expect(asked.map((a) => a.kind)).toEqual(["retention", "exact", "fold"]);
  });

  it("⭐ stops at the FIRST refusal — retention before either index", async () => {
    const world = emptyWorld();
    world.released.add("acme-corp");
    world.tenants.add("acme-corp");
    const asked = installDatabase(world);

    const { body } = await ask("acme-corp");

    expect(body.reason?.code).toBe("recently_released");
    expect(asked.filter((a) => a.kind === "exact")).toHaveLength(0);
    expect(asked.filter((a) => a.kind === "fold")).toHaveLength(0);
  });

  it("⭐ exact before fold — `taken` and `too_similar` are different answers", async () => {
    const world = emptyWorld();
    world.tenants.add("acme-corp");
    world.folds.add(foldSlug("acme-corp"));
    const asked = installDatabase(world);

    const { body } = await ask("acme-corp");

    expect(body.reason?.code).toBe("taken");
    expect(asked.filter((a) => a.kind === "fold")).toHaveLength(0);
  });

  it("🔴 a shape failure spends NO database at all", async () => {
    /**
     * The user is mid-keystroke — "ac" is not a rejected name, it is an
     * unfinished one — and a caller sending garbage must not be able to
     * spend our database on it.
     */
    const asked = installDatabase(emptyWorld());

    for (const bad of ["ab", "-acme", "acme.corp", "", "a".repeat(64)]) {
      const { body, response } = await ask(bad);
      expect(response.status).toBe(200);
      expect(body.available).toBe(false);
      expect(body.suggestions, `"${bad}" was offered suggestions under a half-typed name`).toBeUndefined();
    }
    expect(asked).toHaveLength(0);
  });

  it("a reserved name DOES reach the database, because it deserves suggestions", async () => {
    const asked = installDatabase(emptyWorld());
    const { body } = await ask("postmaster");

    expect(body.reason?.code).toBe("reserved");
    expect(asked.map((a) => a.kind)).toEqual(["suggestions"]);
    expect(body.suggestions?.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 2. 🔴 A DATABASE FAILURE IS NOT A YES                               */
/* ================================================================== */

describe("🔴 an unanswerable question is not a yes", () => {
  it("returns available: false when the database is unreachable", async () => {
    installBrokenDatabase();
    const { body } = await ask("acme-corp");
    expect(
      body.available,
      "the endpoint answered YES while it could not check. That is the one failure mode here " +
        "that silently produces a duplicate.",
    ).toBe(false);
  });

  it("⭐ carries NO reason code — 'we could not check' must stay distinguishable from 'no'", async () => {
    installBrokenDatabase();
    const { body } = await ask("acme-corp");
    expect("reason" in body).toBe(false);
    expect("suggestions" in body).toBe(false);
  });

  it("answers 503 with a retry hint rather than 200", async () => {
    installBrokenDatabase();
    const { response } = await ask("acme-corp");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("⚠️ never caches the failure, or any other answer", async () => {
    /** An availability answer is true for an instant. A cached "yes" for
     *  a name somebody else has since taken is discovered at the end of
     *  signup. */
    installBrokenDatabase();
    const broken = await ask("acme-corp");
    expect(broken.response.headers.get("cache-control")).toBe("no-store");

    installDatabase(emptyWorld());
    const fine = await ask("acme-corp");
    expect(fine.response.headers.get("cache-control")).toBe("no-store");
  });
});

/* ================================================================== */
/* 3. THE ANSWERS THEMSELVES                                           */
/* ================================================================== */

describe("each refusal arrives with the code the claim path would produce", () => {
  it("free → available, with nothing else", async () => {
    installDatabase(emptyWorld());
    const { body } = await ask("zed-builders");
    expect(body).toEqual({ available: true });
  });

  it("an existing tenant → taken", async () => {
    const world = emptyWorld();
    world.tenants.add("acme-corp");
    installDatabase(world);
    expect((await ask("acme-corp")).body.reason?.code).toBe("taken");
  });

  it("🔴 a confusable collision → too_similar, and the fold asked for is foldSlug()'s", async () => {
    const world = emptyWorld();
    world.folds.add(foldSlug("acmecorp"));
    const asked = installDatabase(world);

    const { body } = await ask("acme-corp");

    expect(body.reason?.code).toBe("too_similar");
    const foldQuery = asked.find((a) => a.kind === "fold")!;
    expect(
      foldQuery.params[0],
      "the endpoint queried a fold that foldSlug() did not produce — the check is only as " +
        "correct as those two agreeing, and disagreeing is what let zedbui1ders past the index.",
    ).toBe(foldSlug("acme-corp"));
  });

  it("a released name inside retention → recently_released, exact or folded", async () => {
    const exact = emptyWorld();
    exact.released.add("gone-away");
    installDatabase(exact);
    expect((await ask("gone-away")).body.reason?.code).toBe("recently_released");

    const folded = emptyWorld();
    folded.releasedFolds.add(foldSlug("gone-away"));
    installDatabase(folded);
    expect((await ask("goneaway")).body.reason?.code).toBe("recently_released");
  });

  it("🔴 the wire carries publicMessage and never operatorMessage", async () => {
    /**
     * The operator string may name the conflicting workspace, quote the
     * constraint and cite the retention date. All three are useful to
     * staff with a database in front of them and are reconnaissance in
     * the hands of an anonymous caller.
     */
    const world = emptyWorld();
    world.tenants.add("acme-corp");
    world.folds.add(foldSlug("zedbuilders"));
    world.released.add("gone-away");
    installDatabase(world);

    for (const [slug, code] of [
      ["acme-corp", "taken"],
      ["zedbui1ders", "too_similar"],
      ["gone-away", "recently_released"],
      ["postmaster", "reserved"],
      ["acme.corp", "bad_characters"],
    ] as const) {
      const { body } = await ask(slug);
      expect(body.reason?.code).toBe(code);
      expect(body.reason?.message).toBe(SLUG_REJECTIONS[code].publicMessage);
      expect(body.reason?.message).not.toBe(SLUG_REJECTIONS[code].operatorMessage);
    }
  });

  it("🔴 no refusal echoes the name the caller typed", async () => {
    const world = emptyWorld();
    for (const name of ["acmecorp", "zedbuilders", "vvipro", "karnataka"]) {
      world.tenants.add(name);
    }
    installDatabase(world);

    for (const name of ["acmecorp", "zedbuilders", "vvipro", "karnataka"]) {
      const { body } = await ask(name);
      expect(body.reason?.message.toLowerCase()).not.toContain(name);
    }
  });

  it("normalises before querying — a query for `Acme` would find nothing and report a taken name free", async () => {
    const world = emptyWorld();
    world.tenants.add("acme-corp");
    const asked = installDatabase(world);

    const { body } = await ask("  ACME-CORP  ");

    expect(body.reason?.code).toBe("taken");
    expect(asked.find((a) => a.kind === "exact")!.params[0]).toBe("acme-corp");
  });
});

/* ================================================================== */
/* 4. EVERY SUGGESTION HAS ITSELF BEEN CHECKED                         */
/* ================================================================== */

describe("⭐ a suggestion that is itself taken is worse than no suggestion", () => {
  it("asks the database about every candidate before offering any", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    const asked = installDatabase(world);

    const { body } = await ask("acme");
    const query = asked.find((a) => a.kind === "suggestions");

    expect(query, "suggestions were produced without a single database question").toBeDefined();
    for (const candidate of suggestSlugs("acme", 6)) {
      expect(
        query!.params,
        `"${candidate}" was a candidate but was never checked against the database`,
      ).toContain(candidate);
    }
    expect(body.suggestions!.length).toBeGreaterThan(0);
  });

  it("🔴 never offers a candidate that is already held", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    for (const candidate of suggestSlugs("acme", 6).slice(0, 3)) {
      world.tenants.add(candidate);
      world.folds.add(foldSlug(candidate));
    }
    installDatabase(world);

    const { body } = await ask("acme");

    for (const offered of body.suggestions ?? []) {
      expect(world.tenants.has(offered), `"${offered}" is already taken and was offered anyway`).toBe(false);
      expect(world.folds.has(foldSlug(offered))).toBe(false);
    }
  });

  it("🔴 never offers a candidate whose FOLD is held — the collision is a minute later, not never", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    const first = suggestSlugs("acme", 6)[0];
    world.folds.add(foldSlug(first));
    installDatabase(world);

    const { body } = await ask("acme");
    expect(body.suggestions).not.toContain(first);
  });

  it("never offers a candidate inside the retention window", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    const first = suggestSlugs("acme", 6)[0];
    world.released.add(first);
    installDatabase(world);

    const { body } = await ask("acme");
    expect(body.suggestions).not.toContain(first);
  });

  it("⚠️ offers no two candidates that fold together", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    installDatabase(world);

    const { body } = await ask("acme");
    const folds = (body.suggestions ?? []).map(foldSlug);
    expect(new Set(folds).size).toBe(folds.length);
  });

  it("caps the list — eight near-identical names is a decision, not a help", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    installDatabase(world);

    const { body } = await ask("acme");
    expect(body.suggestions!.length).toBeLessThanOrEqual(3);
  });

  it("omits the key entirely rather than shipping an empty list", async () => {
    const world = emptyWorld();
    world.tenants.add("acme");
    for (const candidate of suggestSlugs("acme", 6)) world.tenants.add(candidate);
    installDatabase(world);

    const { body } = await ask("acme");
    expect(body.available).toBe(false);
    expect("suggestions" in body).toBe(false);
  });
});

/* ================================================================== */
/* 5. THE ENVELOPE                                                     */
/* ================================================================== */

describe("the endpoint's edges", () => {
  it("🔴 a rate-limited caller never reaches the database", async () => {
    const asked = installDatabase(emptyWorld());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(checkEdgeLimit).mockImplementation((async () => ({
      ...ALLOWED,
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 17,
    })) as any);

    const response = await checkSlugAvailability(post({ slug: "acme-corp" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(asked).toHaveLength(0);
  });

  it("⚠️ a 429 publishes no limit, no remaining budget and no policy name", async () => {
    /** Those are a free calibration API for an anonymous caller, who
     *  stops probing for the threshold and simply reads it. */
    installDatabase(emptyWorld());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(checkEdgeLimit).mockImplementation((async () => ({
      ...ALLOWED,
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 5,
    })) as any);

    const response = await checkSlugAvailability(post({ slug: "acme-corp" }));
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain("10");
    expect(text).not.toContain("remaining");
    expect(text).not.toContain("api");
  });

  it("consumes BOTH windows, not whichever refuses first", async () => {
    /** Refusing on the minute window without touching the hour window
     *  means a caller permanently over the minute limit never
     *  accumulates an hourly count at all. */
    installDatabase(emptyWorld());
    await ask("acme-corp");
    expect(vi.mocked(checkEdgeLimit).mock.calls.length).toBe(2);
    const budgets = vi.mocked(checkEdgeLimit).mock.calls.map((c) => c[0].budget);
    expect(new Set(budgets.map((b) => b.windowSeconds))).toEqual(new Set([60, 3600]));
  });

  it("refuses an unparseable body without touching the database", async () => {
    const asked = installDatabase(emptyWorld());
    const response = await checkSlugAvailability(post("{not json"));
    expect(response.status).toBe(400);
    expect(asked).toHaveLength(0);
  });

  it("⚠️ refuses an unknown key rather than ignoring it", async () => {
    const asked = installDatabase(emptyWorld());
    const response = await checkSlugAvailability(post({ slug: "acme-corp", tenantId: "sneaky" }));
    expect(response.status).toBe(400);
    expect(asked).toHaveLength(0);
  });

  it("refuses a body that is too large, measured in BYTES", async () => {
    /** `.length` counts UTF-16 code units, so a body of astral-plane
     *  characters is up to 4x the bytes its length suggests. */
    installDatabase(emptyWorld());
    const response = await checkSlugAvailability(post({ slug: "𝔞".repeat(300) }));
    expect(response.status).toBe(413);
  });

  it("never echoes what an anonymous caller sent back at them", async () => {
    installDatabase(emptyWorld());
    const response = await checkSlugAvailability(post({ slug: 12345 }));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("12345");
  });
});
