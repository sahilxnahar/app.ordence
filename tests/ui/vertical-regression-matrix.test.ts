/**
 * Ordence — VERTICAL REGRESSION MATRIX
 * tests/ui/vertical-regression-matrix.test.ts
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE BREAKAGE THIS FILE STANDS IN FRONT OF
 * ══════════════════════════════════════════════════════════════════════
 * A change made for ONE vertical silently breaks ANOTHER.
 *
 * The contracting and real-estate packs are exercised every day, so a
 * mistake in them surfaces within hours. The legal pack, the healthcare
 * pack and the electricity pack are exercised on the day a customer in
 * that industry signs — and that customer then IS the regression test.
 * A nav entry pointing at a route that was renamed, a vocabulary key
 * that resolves to "", a nav id the module registry has never heard of:
 * each of those is invisible until the one workspace configured for
 * that industry opens its sidebar.
 *
 * ⭐ WHY A MATRIX AND NOT ONE FILE PER VERTICAL
 * One file per vertical only covers the verticals somebody remembered to
 * write a file for, which is never the one that just got added. This
 * file enumerates the verticals FROM THE SOURCE OF TRUTH
 * (`INDUSTRY_TEMPLATES` in lib/industry-templates.ts — the object the
 * running app reads) and asserts the invariants against every entry it
 * finds. A fourteenth vertical added tomorrow is covered tomorrow, by
 * nobody's effort. If it is added half-configured — no navigation, an
 * unknown module key, a blank label — this file goes red before it
 * ships.
 *
 * 🔴 NOTHING HERE PINS A COUNT, A LABEL, AN href OR A PATH.
 * "There are thirteen verticals" is not an invariant, it is today's
 * inventory, and asserting it fails every correct addition. What IS
 * asserted: the set is NON-EMPTY (so an empty parse cannot masquerade as
 * agreement), and every member satisfies the property. Vocabulary is
 * checked for being present and non-blank, never for saying "Rooms".
 *
 * ⚠️ OVERLAP WITH tests/ui/module-registry.test.tsx IS DELIBERATE.
 * That file asks "is the registry complete?" and answers globally, in
 * one flat list. This one asks "is vertical X shippable?" and answers
 * per vertical, so a failure names the industry that broke rather than
 * the id that broke. Same fact, different blast-radius report.
 *
 * No database, no network. Reads the app directory off disk to prove nav
 * destinations exist. Runs under `npx vitest run --project=ui`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  INDUSTRY_TEMPLATES,
  INDUSTRY_KEYS,
  createTranslator,
  filterNavigationByRole,
  resolveIndustryTemplate,
  type IndustryTemplate,
  type NavItem,
} from "@/lib/industry-templates";
import { MODULE_REGISTRY, moduleForNavId } from "@/lib/modules/registry";
import { FEATURE_CATALOG } from "@/lib/entitlements/features";

const ROOT = join(__dirname, "..", "..");

/* ------------------------------------------------------------------ */
/* THE ENUMERATION — the whole point of the file                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 DERIVED, NEVER TYPED OUT. The day someone hard-codes this list is
 * the day a new vertical stops being covered, and the failure mode of
 * that is silence.
 */
const VERTICALS: ReadonlyArray<readonly [string, IndustryTemplate]> =
  Object.entries(INDUSTRY_TEMPLATES);

/** Every nav item of a template, flattened, with its section for messages. */
function navItems(
  tpl: IndustryTemplate,
): Array<{ sectionId: string; item: NavItem }> {
  return tpl.navigation.flatMap((section) =>
    section.items.map((item) => ({ sectionId: section.id, item })),
  );
}

/** `/assets?type=unit` and `/scheduling?view=today` are both real pages. */
function pathOf(href: string): string {
  const q = href.split("?")[0] ?? href;
  return q.split("#")[0] ?? q;
}

/* ------------------------------------------------------------------ */
/* ROUTES ON DISK                                                      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Built by walking `app/`, not by listing paths in this file.
 * A literal list of routes would have to be edited every time a page is
 * added, and would drift into being a second, wrong source of truth —
 * which is the exact failure this whole pack exists to catch, reproduced
 * inside the test that catches it.
 *
 * Route groups — the `(crm)` / `(auth)` parentheses directories — do not
 * appear in URLs, so their segment is dropped. `api/` is excluded: those
 * are handlers, never nav destinations.
 */
function collectRoutes(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, urlPath: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "api") continue;
      const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
      const next = isGroup ? urlPath : `${urlPath}/${entry.name}`;
      const child = join(dir, entry.name);
      if (
        existsSync(join(child, "page.tsx")) ||
        existsSync(join(child, "page.ts"))
      ) {
        found.add(next === "" ? "/" : next);
      }
      walk(child, next);
    }
  };
  walk(join(ROOT, "app"), "");
  if (existsSync(join(ROOT, "app", "page.tsx"))) found.add("/");
  return found;
}

const ROUTES = collectRoutes();

/**
 * A dynamic segment (`/deals/[id]`) matches a concrete path. No template
 * currently points at one, but a future "Matters → /legal/matters/new"
 * must not fail for the wrong reason.
 */
function routeExists(path: string): boolean {
  if (ROUTES.has(path)) return true;
  const wanted = path.split("/").filter(Boolean);
  for (const route of ROUTES) {
    const parts = route.split("/").filter(Boolean);
    if (parts.length !== wanted.length) continue;
    const ok = parts.every((part, i) => {
      const w = wanted[i];
      if (w === undefined) return false;
      return part === w || (part.startsWith("[") && part.endsWith("]"));
    });
    if (ok) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 0. THE SET ITSELF                                                   */
/* ------------------------------------------------------------------ */

describe("the vertical set", () => {
  /**
   * ⭐ THE GUARD ON EVERY OTHER TEST IN THIS FILE.
   * Every assertion below is a loop over `VERTICALS`. If that enumeration
   * ever came back empty — a refactor that renames the export, a barrel
   * file that starts re-exporting `{}` — every loop would pass by
   * iterating nothing, and this pack would report perfect health while
   * covering zero industries. Vacuous agreement is the failure mode of
   * matrix tests; this is the only assertion standing against it.
   */
  it("is non-empty and route-inspectable", () => {
    expect(VERTICALS.length).toBeGreaterThan(0);
    expect(ROUTES.size).toBeGreaterThan(0);
  });

  it("exposes the same keys through INDUSTRY_KEYS as the templates map", () => {
    // Two exported views of one fact. They are read by different callers
    // (the settings dropdown reads the keys, the layout reads the map),
    // so they drifting apart means an industry you can select and cannot
    // render.
    expect([...INDUSTRY_KEYS].sort()).toEqual(VERTICALS.map(([k]) => k).sort());
  });

  it("gives every template the key it is filed under", () => {
    // 🔴 The copy-paste bug: a new vertical cloned from the last one keeps
    // `key: "solar"` while sitting at `electricity:`. Everything renders,
    // and every lookup that round-trips through `template.key` — audit
    // logs, industry switching, analytics — reports the wrong industry.
    for (const [key, tpl] of VERTICALS) {
      expect(tpl.key, `template filed under "${key}"`).toBe(key);
    }
  });

  it("resolves every key back to its own template", () => {
    // `resolveIndustryTemplate` falls back to generic rather than throwing.
    // That is right for junk from the database and WRONG for a real key —
    // a vertical that silently resolves to generic loses its entire nav.
    for (const [key, tpl] of VERTICALS) {
      expect(resolveIndustryTemplate(key).key, `resolve("${key}")`).toBe(tpl.key);
    }
  });

  it("describes every vertical in words a human picked", () => {
    // These three strings are the industry picker at provisioning. A blank
    // label renders as an unselectable empty row in the dropdown.
    for (const [key, tpl] of VERTICALS) {
      expect(tpl.label.trim(), `${key}.label`).not.toBe("");
      expect(tpl.description.trim(), `${key}.description`).not.toBe("");
      expect(tpl.icon.trim(), `${key}.icon`).not.toBe("");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 1. NAVIGATION                                                       */
/* ------------------------------------------------------------------ */

describe("every vertical resolves to a usable navigation set", () => {
  it("gives every vertical at least one section and no empty section", () => {
    // An empty section renders as a heading with nothing under it — the
    // shape a half-configured new vertical takes.
    for (const [key, tpl] of VERTICALS) {
      expect(tpl.navigation.length, `${key} has no navigation`).toBeGreaterThan(0);
      for (const section of tpl.navigation) {
        expect(section.id.trim(), `${key} section id`).not.toBe("");
        expect(section.items.length, `${key} → section "${section.id}"`).toBeGreaterThan(0);
      }
    }
  });

  it("never repeats a section id or a nav id inside one vertical", () => {
    // ⚠️ Ids are matched on for active-state highlighting and for the
    // entitlement filter. A duplicate inside one template means two menu
    // entries light up together, and hiding one hides both.
    for (const [key, tpl] of VERTICALS) {
      const sectionIds = tpl.navigation.map((s) => s.id);
      expect(new Set(sectionIds).size, `${key} duplicate section id`).toBe(sectionIds.length);
      const navIds = navItems(tpl).map((n) => n.item.id);
      expect(new Set(navIds).size, `${key} duplicate nav id`).toBe(navIds.length);
    }
  });

  it("labels every nav entry with something visible", () => {
    // 🔴 An empty label renders as a blank clickable row. The user sees a
    // gap in the sidebar that navigates somewhere when clicked.
    for (const [key, tpl] of VERTICALS) {
      for (const { sectionId, item } of navItems(tpl)) {
        expect(item.label.trim(), `${key} → ${sectionId} → ${item.id}`).not.toBe("");
        expect(item.icon.trim(), `${key} → ${item.id} icon`).not.toBe("");
      }
    }
  });

  it("points every nav destination at a page that exists", () => {
    /**
     * ⭐ THE ONE THAT CATCHES CROSS-VERTICAL BREAKAGE.
     * Renaming `app/(crm)/gst` while updating the two templates you had
     * open leaves the other eleven pointing at a 404. Nothing else in the
     * codebase connects a template href to a file on disk, so this is the
     * only place that failure is visible before a customer clicks it.
     */
    const broken: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const { item } of navItems(tpl)) {
        if (!routeExists(pathOf(item.href))) {
          broken.push(`${key} → ${item.id} → ${item.href}`);
        }
      }
    }
    expect(broken, "nav destinations with no page.tsx").toEqual([]);
  });

  it("keeps a landing page for every role in every vertical", () => {
    /**
     * ⚠️ `filterNavigationByRole` drops sections that empty out. A vertical
     * that gated everything behind admin roles would sign a `member` in to
     * a sidebar with nothing in it — technically working, functionally a
     * locked door. Asserted as "at least one destination", NOT as "the
     * Dashboard item", because which page a role lands on is a product
     * decision and pinning it would fail a correct change.
     */
    const roles = ["tenant_owner", "tenant_admin", "manager", "member", "read_only"];
    for (const [key, tpl] of VERTICALS) {
      for (const role of roles) {
        const visible = filterNavigationByRole(tpl.navigation, role);
        const count = visible.reduce((n, s) => n + s.items.length, 0);
        expect(count, `${key} shows nothing to "${role}"`).toBeGreaterThan(0);
        for (const section of visible) {
          expect(section.items.length, `${key}/${role} empty heading`).toBeGreaterThan(0);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. MODULE KEYS                                                      */
/* ------------------------------------------------------------------ */

describe("every vertical names module keys the registry knows", () => {
  it("has a registry entry for every nav id it enables", () => {
    /**
     * 🔴 AN UNKNOWN KEY DOES NOT ERROR — IT NO-OPS.
     * `filterNavigationByEntitlement` fails OPEN on an id the registry has
     * never heard of (deliberately: an unknown id must not blank the
     * sidebar). The consequence is that a typo'd or never-registered nav
     * id ships as a menu entry visible to EVERY plan, including the ones
     * that did not pay for it. Silent, revenue-shaped, and invisible in
     * every other test if the vertical is one nobody opens.
     */
    const unknown: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const { item } of navItems(tpl)) {
        if (!moduleForNavId(item.id)) unknown.push(`${key} → ${item.id}`);
      }
    }
    expect(unknown, "nav ids missing from MODULE_REGISTRY").toEqual([]);
  });

  it("resolves every enabled module to a real entitlement or to none", () => {
    // A feature key that is not in the catalogue evaluates as DENIED, so
    // the module vanishes for every tenant on every plan — a typo removes
    // a paid feature from the product rather than failing loudly.
    const bad: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const { item } of navItems(tpl)) {
        const mod = moduleForNavId(item.id);
        if (!mod) continue; // reported by the test above
        if (mod.feature !== null && !(mod.feature in FEATURE_CATALOG)) {
          bad.push(`${key} → ${item.id} → ${String(mod.feature)}`);
        }
      }
    }
    expect(bad, "modules pointing at unknown feature keys").toEqual([]);
  });

  it("only offers a module to industries that exist", () => {
    // The offer list is what the admin console proposes at onboarding. A
    // stale key here means a vertical that was renamed keeps being offered
    // modules under its old name and stops being offered them under its
    // new one — a provisioning bug with no error message.
    const known = new Set(VERTICALS.map(([k]) => k));
    const bad: string[] = [];
    for (const mod of Object.values(MODULE_REGISTRY)) {
      for (const industry of mod.industries ?? []) {
        if (!known.has(industry)) bad.push(`${mod.navId} → ${industry}`);
      }
    }
    expect(bad, "offer lists naming industries that do not exist").toEqual([]);
  });

  it("gives every LIVE module a page that exists", () => {
    /**
     * ⚠️ THE MIRROR OF THE NAV-DESTINATION TEST, FROM THE REGISTRY SIDE.
     * A module can be `live`, entitled, offered to five industries and
     * point at a directory nobody created. The sidebar would then show it
     * to every paying tenant in those industries and 404 all of them.
     *
     * 🔴 Restricted to `live` on purpose. `coming_soon` entries record
     * routes that are deliberately unbuilt — that is what the status
     * means, and failing on them would punish the honest declaration.
     */
    const missing: string[] = [];
    for (const mod of Object.values(MODULE_REGISTRY)) {
      if (mod.status !== "live") continue;
      if (!routeExists(pathOf(mod.href))) missing.push(`${mod.navId} → ${mod.href}`);
    }
    expect(missing, "live modules with no page.tsx").toEqual([]);
  });

  /**
   * ⚠️ DROPPED ON PURPOSE: "one nav id points at one destination in every
   * vertical". It reads like an invariant and is not one today — four
   * ids already diverge (see the report filed with this pack). Whether
   * that divergence is a bug is the owner's call, and a test that fails
   * the build to make an argument is a test that gets deleted. The
   * statutory half of the same idea — where divergence is not a matter of
   * taste — is asserted in section 6 instead.
   */
});

/* ------------------------------------------------------------------ */
/* 3. VOCABULARY                                                       */
/* ------------------------------------------------------------------ */

/**
 * The contract every screen relies on. Taken from the generic template
 * rather than typed out here: generic is the template every other one
 * layers over, so its key set IS the set the UI is entitled to ask for.
 * Adding a term to the base therefore extends this test automatically —
 * and catches the vertical that forgot to inherit it.
 */
const REQUIRED_TERMS = Object.keys(INDUSTRY_TEMPLATES.generic.terminology);

describe("every vertical speaks a complete vocabulary", () => {
  it("has a base vocabulary worth checking against", () => {
    expect(REQUIRED_TERMS.length).toBeGreaterThan(0);
  });

  it("defines every base term in every vertical", () => {
    /**
     * 🔴 THE MISSING-SPREAD BUG.
     * Ten verticals get the base terms through `makeVertical()`. The three
     * older templates spread `BASE_TERMINOLOGY` by hand. A fourteenth
     * written longhand from one of those — and forgetting the spread —
     * loses every term it did not restate. `createTranslator` then returns
     * the KEY itself, so the screen reads "deal.plural" where it should
     * read "Bookings". Visible to the customer, invisible to the compiler.
     */
    const missing: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const term of REQUIRED_TERMS) {
        if (!(term in tpl.terminology)) missing.push(`${key} → ${term}`);
      }
    }
    expect(missing, "base vocabulary terms not covered").toEqual([]);
  });

  it("never resolves a term to blank or to whitespace", () => {
    // ⚠️ An empty override is worse than a missing one: the missing key
    // falls back to something readable, the empty string renders a button
    // with no text on it. Whitespace-only is the same bug wearing a space.
    const blank: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const [term, value] of Object.entries(tpl.terminology)) {
        if (typeof value !== "string" || value.trim() === "") {
          blank.push(`${key} → ${term} → ${JSON.stringify(value)}`);
        }
      }
    }
    expect(blank, "blank vocabulary overrides").toEqual([]);
  });

  it("returns a readable word, not the key, through the translator", () => {
    // The translator is what the components actually call. Testing the
    // object and not the accessor would miss a change to the lookup.
    for (const [key, tpl] of VERTICALS) {
      const t = createTranslator(tpl);
      for (const term of REQUIRED_TERMS) {
        const word = t(term);
        expect(word.trim(), `${key} → t("${term}")`).not.toBe("");
        expect(word, `${key} → t("${term}") leaked the key`).not.toBe(term);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. DASHBOARD                                                        */
/* ------------------------------------------------------------------ */

describe("every vertical has a dashboard that can render", () => {
  it("gives every vertical at least one tile", () => {
    // The dashboard is the landing page. A vertical with no tiles signs
    // its first user in to an empty screen.
    for (const [key, tpl] of VERTICALS) {
      expect(tpl.dashboard.length, `${key} has no dashboard tiles`).toBeGreaterThan(0);
    }
  });

  it("describes every tile completely and uniquely", () => {
    // `id` keys the React list; `metric` is the server lookup. A duplicate
    // id drops a tile silently, a blank metric renders a tile with no
    // number in it. Span is a Tailwind column count — 0 or 9 is a layout
    // that collapses.
    for (const [key, tpl] of VERTICALS) {
      const ids = tpl.dashboard.map((w) => w.id);
      expect(new Set(ids).size, `${key} duplicate widget id`).toBe(ids.length);
      for (const widget of tpl.dashboard) {
        expect(widget.title.trim(), `${key} → ${widget.id} title`).not.toBe("");
        expect(widget.metric.trim(), `${key} → ${widget.id} metric`).not.toBe("");
        expect(widget.icon.trim(), `${key} → ${widget.id} icon`).not.toBe("");
        expect([1, 2, 3, 4], `${key} → ${widget.id} span`).toContain(widget.span);
        expect(
          ["stat", "list", "progress", "breakdown"],
          `${key} → ${widget.id} kind`,
        ).toContain(widget.kind);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. SEED DATA AND FILTERS                                            */
/* ------------------------------------------------------------------ */

describe("every vertical seeds and filters sanely", () => {
  it("offers asset types and statuses that are non-blank and distinct", () => {
    // These populate filter dropdowns. A duplicate renders twice; a blank
    // renders an option that selects nothing.
    for (const [key, tpl] of VERTICALS) {
      for (const [name, values] of [
        ["assetTypes", tpl.assetTypes],
        ["primaryStatuses", tpl.primaryStatuses],
      ] as const) {
        expect(values.length, `${key}.${name} is empty`).toBeGreaterThan(0);
        expect(new Set(values).size, `${key}.${name} has duplicates`).toBe(values.length);
        for (const value of values) {
          expect(value.trim(), `${key}.${name} blank entry`).not.toBe("");
        }
      }
    }
  });

  it("seeds custom objects with slugs a URL can carry", () => {
    /**
     * ⚠️ Slugs are seeded into the database on first login and then appear
     * in routes. A slug with a space or a capital is a 404 the customer
     * meets on day one, and it cannot be fixed without touching their
     * data. Duplicates inside one vertical collide on insert.
     */
    for (const [key, tpl] of VERTICALS) {
      const slugs = tpl.suggestedObjects.map((o) => o.slug);
      expect(new Set(slugs).size, `${key} duplicate suggested slug`).toBe(slugs.length);
      for (const obj of tpl.suggestedObjects) {
        expect(obj.name.trim(), `${key} → object name`).not.toBe("");
        expect(obj.pluralName.trim(), `${key} → ${obj.name} pluralName`).not.toBe("");
        expect(obj.icon.trim(), `${key} → ${obj.name} icon`).not.toBe("");
        expect(obj.slug, `${key} → ${obj.name} slug`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. STATUTORY BEHAVIOUR                                              */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ GST, TDS AND PAYROLL ARE LAW, NOT PREFERENCE.
 *
 * A hotel and a law firm file the same GSTR-1 under the same Act. Nothing
 * about an industry template may change what a statutory screen IS or
 * where it lives — a template may choose not to surface it, but it may
 * never surface a DIFFERENT one, and it may never restrict it to a
 * subset of roles inside a tenant that is legally obliged to file.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT ASSERTED HERE: "every vertical shows GST".
 * Two templates do not, and whether they should is a product decision
 * reported to the owner, not a test that fails the build on somebody
 * else's behalf. See the report accompanying this file.
 */
const STATUTORY_NAV_IDS = ["gst", "gstr2b", "tds", "eway", "payroll", "tally"] as const;

describe("statutory paths do not vary by vertical", () => {
  it("recognises the statutory ids it is guarding", () => {
    // If a statutory module is renamed, this file must fail rather than
    // quietly guard nothing — the guard going vacuous is the same class of
    // bug as the guard being wrong.
    for (const id of STATUTORY_NAV_IDS) {
      expect(moduleForNavId(id), `statutory module "${id}" missing`).toBeDefined();
    }
  });

  it("sends every vertical that exposes a statutory screen to the same one", () => {
    // 🔴 One vertical re-pointing "GST" at its own page means one industry
    // filing from code nobody else exercises.
    const drift: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const { item } of navItems(tpl)) {
        const statutory = STATUTORY_NAV_IDS.find((id) => id === item.id);
        if (!statutory) continue;
        const canonical = moduleForNavId(statutory);
        if (canonical && pathOf(canonical.href) !== pathOf(item.href)) {
          drift.push(`${key} → ${item.id} → ${item.href} (registry: ${canonical.href})`);
        }
      }
    }
    expect(drift, "verticals re-pointing a statutory destination").toEqual([]);
  });

  it("never hides a statutory screen behind a role inside the tenant", () => {
    /**
     * ⚠️ The obligation to file belongs to the WORKSPACE, not to whoever
     * happens to hold `tenant_owner`. A vertical that added
     * `roles: ["tenant_owner"]` to its GST entry would leave the accounts
     * clerk who actually files unable to reach the screen, and the failure
     * would look like a permissions question rather than a missed return.
     */
    const gated: string[] = [];
    for (const [key, tpl] of VERTICALS) {
      for (const { item } of navItems(tpl)) {
        if (!STATUTORY_NAV_IDS.some((id) => id === item.id)) continue;
        if (item.roles && item.roles.length > 0) {
          gated.push(`${key} → ${item.id} → ${item.roles.join(",")}`);
        }
      }
    }
    expect(gated, "statutory screens restricted by role").toEqual([]);
  });
});
