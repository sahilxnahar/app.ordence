/**
 * Ordence — MODULE REGISTRY & NAVIGATION FILTER
 * Sections A and B · v0.53.0
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS ACTUALLY FOR
 * ══════════════════════════════════════════════════════════════════════
 * The registry only works if it is COMPLETE. The moment one nav item
 * exists that the registry has never heard of, the sidebar silently
 * reverts to its old behaviour for that item — shown to everybody,
 * regardless of plan — and nothing anywhere reports it. That is exactly
 * the class of silent drift the registry was built to end, so it has to
 * be a build failure rather than a code review habit.
 *
 * Test 1 is therefore the point of this file. The rest guard the
 * arithmetic around it.
 *
 * No database. Runs under `npm run test:ui`.
 */

import { describe, it, expect } from "vitest";
import {
  MODULE_REGISTRY,
  MODULE_GROUPS,
  moduleForNavId,
  requiredFeatureKeys,
  groupedModules,
  comingSoonModules,
  type ModuleGroup,
} from "@/lib/modules/registry";
import {
  filterNavigationByEntitlement,
  explainHiddenNavItems,
} from "@/lib/modules/nav";
import { INDUSTRY_TEMPLATES, INDUSTRY_KEYS } from "@/lib/industry-templates";
import type { NavSection } from "@/lib/industry-templates";
import { FEATURE_CATALOG } from "@/lib/entitlements/features";

/* ------------------------------------------------------------------ */
/* 1. COMPLETENESS — the one that matters                              */
/* ------------------------------------------------------------------ */

describe("registry completeness", () => {
  it("knows every nav item in every industry template", () => {
    const missing: string[] = [];

    for (const key of INDUSTRY_KEYS) {
      for (const section of INDUSTRY_TEMPLATES[key].navigation) {
        for (const item of section.items) {
          if (!moduleForNavId(item.id)) {
            missing.push(`${key}/${section.id}/${item.id}`);
          }
        }
      }
    }

    expect(
      missing,
      `These nav items are not in lib/modules/registry.ts. Until they are, ` +
        `they ignore the customer's plan and are shown to everyone:\n  ` +
        missing.join("\n  "),
    ).toEqual([]);
  });

  it("points every module at a real entitlement key", () => {
    const bad = Object.values(MODULE_REGISTRY)
      .filter((m) => m.feature !== null && !(m.feature in FEATURE_CATALOG))
      .map((m) => `${m.navId} → "${m.feature}"`);

    // A typo here does not throw — it produces a key `checkFeatures` never
    // answers, so the module is hidden from every customer forever.
    expect(bad, `Unknown feature keys:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("uses a declared group for every module", () => {
    const groups = Object.keys(MODULE_GROUPS) as ModuleGroup[];
    for (const mod of Object.values(MODULE_REGISTRY)) {
      expect(groups).toContain(mod.group);
    }
  });

  it("keys the registry by the navId each entry declares", () => {
    // Guards against a copy-paste where the key and the navId disagree —
    // lookups then miss and the module silently falls through to shown.
    for (const [key, mod] of Object.entries(MODULE_REGISTRY)) {
      expect(mod.navId).toBe(key);
    }
  });

  it("keeps the always-available list short and deliberate", () => {
    const free = Object.values(MODULE_REGISTRY)
      .filter((m) => m.feature === null)
      .map((m) => m.navId)
      .sort();

    // Every entry here is a thing that can never be charged for. Changing
    // this list is a commercial decision, so it is written down.
    //
    // ⭐ `hearings` LEFT THIS LIST IN v1.7.0, and the change is
    // deliberate. It was free because it was `feature: null` — a nav
    // entry pointing at the generic calendar with nothing behind it. A
    // real hearing diary, with limitation dates and the next-date rule,
    // lives on `matters` and is a feature like any other.
    //
    // ⚠️ This test failing is the gate working: removing a nav entry
    // silently changes what a workspace gets for nothing.
    //
    // ⭐ `messaging` JOINED IN v1.14.0 for the same reason as
    // `connections`: it is where a customer sees what their own
    // WhatsApp account is costing them and what stopped working. Putting
    // the spend report behind a paywall would mean the customers most at
    // risk of a surprise bill are the ones who cannot see it coming.
    //
    // ⭐ `connections` JOINED THIS LIST IN v1.12.0, and that is also a
    // decision. It is where a customer plugs in their OWN IndiaMART,
    // JustDial, Meta or WhatsApp account. Refusing to let somebody
    // connect their own lead source until they upgrade loses the account
    // the upsell was aimed at, and it is the screen they open on the
    // morning the enquiries stopped. What gets charged for is the volume
    // that comes through it, not the socket.
    expect(free).toEqual([
      "assistant",
      "billing",
      "connections",
      "dashboard",
      "messaging",
      "notifications",
      "reports",
      "search",
      "settings",
      "setup",
      "team",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE SAME CAPABILITY UNDER DIFFERENT NAMES                        */
/* ------------------------------------------------------------------ */

describe("industry vocabulary", () => {
  it("sells one capability once, whatever it is called", () => {
    // "Clients" and "Contacts" are one purchase wearing two vocabularies.
    // If they ever diverge, a legal tenant pays for contacts and cannot
    // see clients — with no error anywhere.
    expect(moduleForNavId("clients")?.feature).toBe(
      moduleForNavId("contacts")?.feature,
    );
    expect(moduleForNavId("organisations")?.feature).toBe(
      moduleForNavId("companies")?.feature,
    );
    expect(moduleForNavId("engagements")?.feature).toBe(
      moduleForNavId("deals")?.feature,
    );
  });

  it("does not collapse two menu entries that share a route", () => {
    // `/assets?type=unit` and `/assets?type=plot` are the same href. They
    // must remain separately controllable, which is why the registry is
    // keyed on navId rather than href.
    expect(moduleForNavId("units")).toBeDefined();
    expect(moduleForNavId("plots")).toBeDefined();
    expect(moduleForNavId("units")?.navId).not.toBe(
      moduleForNavId("plots")?.navId,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE FILTER                                                       */
/* ------------------------------------------------------------------ */

const section = (items: Array<{ id: string; label: string }>): NavSection => ({
  id: "test",
  label: "Test",
  items: items.map((i) => ({ ...i, href: `/${i.id}`, icon: "box" })),
});

describe("filterNavigationByEntitlement", () => {
  it("removes a module the plan does not include", () => {
    const out = filterNavigationByEntitlement(
      [section([{ id: "contacts", label: "Contacts" }])],
      { "crm.contacts": false },
    );
    expect(out).toEqual([]); // section emptied, so section dropped
  });

  it("keeps a module the plan does include", () => {
    const out = filterNavigationByEntitlement(
      [section([{ id: "contacts", label: "Contacts" }])],
      { "crm.contacts": true },
    );
    expect(out[0]?.items.map((i) => i.id)).toEqual(["contacts"]);
  });

  it("treats an ABSENT key as denied, not as granted", () => {
    // The single most consequential line in the filter. `undefined` means
    // "nobody asked", and a truthiness check would read that as allowed —
    // handing out any feature whose key was mistyped in the registry.
    const out = filterNavigationByEntitlement(
      [section([{ id: "contacts", label: "Contacts" }])],
      {},
    );
    expect(out).toEqual([]);
  });

  it("always shows a module with no feature key", () => {
    const out = filterNavigationByEntitlement(
      [section([{ id: "settings", label: "Settings" }])],
      {},
    );
    expect(out[0]?.items.map((i) => i.id)).toEqual(["settings"]);
  });

  /**
   * ⚠️ THESE TWO TESTS USED TO HARD-CODE `deals` AS THE COMING-SOON
   * EXAMPLE, AND THEN `deals` SHIPPED.
   *
   * That is the ordinary fate of a fixture that names a real row: it is
   * correct until somebody does the work it was describing, and then it
   * fails for a reason that has nothing to do with the behaviour under
   * test. The behaviour — a coming_soon module is hidden however entitled
   * the workspace is — is still exactly right and still needs covering.
   *
   * ⭐ SO THE FIXTURE IS DERIVED FROM THE REGISTRY RATHER THAN NAMED. If
   * a coming_soon module exists, it is used. If none does, the test says
   * so out loud instead of quietly passing on an empty set — and it
   * starts exercising the real path again the moment anybody adds one.
   */
  const anyComingSoon = comingSoonModules()[0];

  it("hides a route that does not exist yet, even when entitled", () => {
    if (!anyComingSoon) {
      // Every module has a screen. Nothing to hide — assert that, so this
      // is a statement of fact rather than a vacuous pass.
      expect(comingSoonModules()).toEqual([]);
      return;
    }
    const out = filterNavigationByEntitlement(
      [section([{ id: anyComingSoon.navId, label: anyComingSoon.label }])],
      anyComingSoon.feature ? { [anyComingSoon.feature]: true } : {},
    );
    expect(out).toEqual([]);
  });

  it("shows coming_soon only when explicitly asked", () => {
    if (!anyComingSoon) {
      expect(comingSoonModules()).toEqual([]);
      return;
    }
    const out = filterNavigationByEntitlement(
      [section([{ id: anyComingSoon.navId, label: anyComingSoon.label }])],
      anyComingSoon.feature ? { [anyComingSoon.feature]: true } : {},
      { includeComingSoon: true },
    );
    expect(out[0]?.items.map((i) => i.id)).toEqual([anyComingSoon.navId]);
  });

  it("keeps an unknown nav id — fails OPEN, deliberately", () => {
    // A forgotten registry entry must not make a menu item vanish for
    // every customer at once. Test 1 is what catches the omission.
    const out = filterNavigationByEntitlement(
      [section([{ id: "not-in-registry", label: "Mystery" }])],
      {},
    );
    expect(out[0]?.items.map((i) => i.id)).toEqual(["not-in-registry"]);
  });

  it("drops a section only when it is left with nothing", () => {
    const out = filterNavigationByEntitlement(
      [
        section([
          { id: "contacts", label: "Contacts" },
          { id: "companies", label: "Companies" },
        ]),
      ],
      { "crm.contacts": true, "crm.companies": false },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.items.map((i) => i.id)).toEqual(["contacts"]);
  });

  it("does not mutate the sections it was given", () => {
    const input = [section([{ id: "contacts", label: "Contacts" }])];
    const before = JSON.stringify(input);
    filterNavigationByEntitlement(input, { "crm.contacts": false });
    expect(JSON.stringify(input)).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 4. A REAL WORKSPACE, END TO END                                     */
/* ------------------------------------------------------------------ */

describe("a real industry template", () => {
  it("shows a basic real-estate workspace strictly less than an entitled one", () => {
    const nav = INDUSTRY_TEMPLATES.real_estate_developer.navigation;

    const everything: Record<string, boolean> = {};
    for (const key of requiredFeatureKeys()) everything[key] = true;

    const rich = filterNavigationByEntitlement(nav, everything);
    const poor = filterNavigationByEntitlement(nav, {});

    const count = (s: NavSection[]) =>
      s.reduce((n, sec) => n + sec.items.length, 0);

    expect(count(poor)).toBeLessThan(count(rich));
    expect(count(poor)).toBeGreaterThan(0); // never an empty menu
  });

  it("never renders a heading with nothing under it", () => {
    for (const key of INDUSTRY_KEYS) {
      const out = filterNavigationByEntitlement(
        INDUSTRY_TEMPLATES[key].navigation,
        {},
      );
      for (const sec of out) expect(sec.items.length).toBeGreaterThan(0);
    }
  });

  it("explains every removal", () => {
    const hidden = explainHiddenNavItems(
      INDUSTRY_TEMPLATES.real_estate_developer.navigation,
      {},
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const h of hidden) expect(h.reason).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 5. DERIVED HELPERS                                                  */
/* ------------------------------------------------------------------ */

describe("derived helpers", () => {
  it("deduplicates feature keys shared by several modules", () => {
    const keys = requiredFeatureKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("offers no coming_soon module to the admin console", () => {
    // Selling a customer access to a 404 is worse than not listing it.
    for (const g of groupedModules()) {
      for (const m of g.modules) expect(m.status).toBe("live");
    }
  });

  it("still records the unbuilt routes so they are not forgotten", () => {
    const soon = comingSoonModules().map((m) => m.navId).sort();
    /**
     * ⚠️ AN EXPLICIT LIST, NOT A COUNT. A count would go green the moment
     * one route shipped and another was quietly added, which is the exact
     * drift this file exists to catch.
     *
     * ⭐ IT IS NOW EMPTY — every module in the registry has a screen.
     *
     * ⚠️ THAT MAKES THIS ASSERTION MORE IMPORTANT, NOT LESS. An empty list
     * means the next `coming_soon` entry anybody adds fails this test
     * immediately, which is the only thing standing between the registry
     * and a nav item that points at a 404. Do not delete this test because
     * it currently asserts nothing interesting — asserting nothing
     * interesting IS the desired state, and the test is what keeps it.
     */
    expect(soon).toEqual([]);
  });
});


/* ------------------------------------------------------------------ */
/* 6. THE TEN VERTICALS — Session 1                                    */
/* ------------------------------------------------------------------ */

describe("the ten verticals", () => {
  const VERTICALS: string[] = [
    "hospitality",
    "healthcare",
    "logistics",
    "trading",
    "electricity",
    "solar",
    "software",
    "small_business",
    "financial_services",
    "professional_services",
  ];

  it("registers all ten alongside the original three", () => {
    expect(INDUSTRY_KEYS.length).toBe(13);
    for (const v of VERTICALS) expect(INDUSTRY_KEYS).toContain(v);
  });

  it("gives every vertical Home and Administration", () => {
    // `makeVertical()` wraps them, so losing one would mean the builder
    // was bypassed — which is exactly the copy-paste the builder prevents.
    for (const key of INDUSTRY_KEYS) {
      const ids = INDUSTRY_TEMPLATES[key].navigation.map((s) => s.id);
      expect(ids[0]).toBe("core");
      expect(ids).toContain("admin");
    }
  });

  it("puts compliance FIRST for professional services and nowhere else", () => {
    // For a CA firm the deadline board is the product; every other screen
    // feeds it. Stated as a test so a later tidy-up cannot reorder it.
    const prof = INDUSTRY_TEMPLATES.professional_services.navigation;
    expect(prof[1]?.id).toBe("compliance");

    const hosp = INDUSTRY_TEMPLATES.hospitality.navigation;
    expect(hosp[1]?.id).not.toBe("compliance");
  });

  it("keeps small business the smallest of the ten verticals", () => {
    // The whole vertical is a restraint exercise: for an SME, hiding what
    // they do not need IS the product. If this ever stops being true,
    // somebody has added "just one more useful section".
    //
    // ⚠️ COMPARED AGAINST THE TEN, NOT ALL THIRTEEN. `generic` is a
    // near-empty starting point by design and is legitimately smaller —
    // an earlier version of this test asserted otherwise and failed, which
    // is the test being wrong rather than the templates.
    const count = (k: (typeof INDUSTRY_KEYS)[number]) =>
      INDUSTRY_TEMPLATES[k].navigation.reduce((n, s) => n + s.items.length, 0);

    const sme = count("small_business");
    for (const key of VERTICALS) {
      if (key === "small_business") continue;
      expect(sme).toBeLessThan(count(key as (typeof INDUSTRY_KEYS)[number]));
    }
  });

  it("sells one capability once, however the vertical names it", () => {
    // Guests / Patients / Consumers are crm.contacts in three costumes.
    // Separate keys would let a hospital lose Patients while keeping
    // Contacts — a state nobody meant to be possible.
    const contacts = moduleForNavId("contacts")?.feature;
    for (const alias of ["guests", "patients", "consumers", "clients"]) {
      expect(moduleForNavId(alias)?.feature).toBe(contacts);
    }
    expect(moduleForNavId("beds")?.feature).toBe(
      moduleForNavId("assets")?.feature,
    );
    expect(moduleForNavId("consignments")?.feature).toBe(
      moduleForNavId("orders")?.feature,
    );
  });

  it("names only real industries in every offer list", () => {
    for (const mod of Object.values(MODULE_REGISTRY)) {
      for (const ind of mod.industries ?? []) {
        expect(INDUSTRY_KEYS).toContain(ind);
      }
    }
  });

  it("uses ONE scheduling key across five verticals, not five keys", () => {
    // The single most important structural rule in Session 1. Three keys
    // for one engine means three code paths, three bugs, and a price list
    // nobody can explain.
    const scheduling = moduleForNavId("scheduling");
    expect(scheduling?.feature).toBe("scheduling.resources");
    expect(scheduling?.industries?.length).toBeGreaterThanOrEqual(5);

    const engineKeys = Object.values(MODULE_REGISTRY)
      .map((m) => m.feature)
      .filter((f): f is string => typeof f === "string")
      .filter((f) => f.startsWith("scheduling."));
    expect(new Set(engineKeys).size).toBeLessThanOrEqual(2);
  });
});
