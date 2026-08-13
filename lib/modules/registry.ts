/**
 * Ordence — THE MODULE REGISTRY
 * Version: v0.53.0 · Section A of the client-onboarding architecture
 *
 * ══════════════════════════════════════════════════════════════════════
 * ONE LIST. EVERYTHING READS FROM IT.
 * ══════════════════════════════════════════════════════════════════════
 * Before this file, the truth about "what can Ordence do, and who is
 * allowed to see it" lived in four places:
 *
 *   1. `lib/industry-templates.ts`  — a hand-written sidebar per industry
 *   2. `lib/entitlements/features.ts` — 53 feature keys and their tiers
 *   3. `docs/FEATURE-MAP-500.md`    — a register maintained by hand
 *   4. whoever remembered which customer had asked for what
 *
 * Four copies of one fact drift. They always drift, and the drift is
 * SILENT: a customer sees a menu item they did not buy, or does not see
 * one they did, and nothing anywhere reports a problem. The sidebar was
 * measurably in that state when this file was written — it advertised
 * seven links to routes that did not exist, and had never once consulted
 * the entitlement catalogue.
 *
 * ⚠️ HISTORICAL NOTE — v0.73.0-alpha. All seven of those routes were
 * built by v36, and every module below is now `live`. The paragraph
 * above is kept because it explains WHY this file exists; the dead links
 * it describes are gone. A stale comment claiming broken links still
 * exist is worse than no comment, because it sends whoever reads it
 * hunting a problem that was already fixed.
 *
 * This file is the join. Each entry says: here is a thing the product
 * does, here is what to call it in plain English, here is where it lives
 * in the menu, and here is the entitlement key that decides who sees it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT READS THIS
 * ══════════════════════════════════════════════════════════════════════
 *   • `lib/modules/nav.ts`      — filters the sidebar (Section B)
 *   • the platform admin console — renders the per-tenant toggles (C)
 *   • the client setup wizard    — offers what the plan includes (E)
 *   • the feature register       — generated, so it cannot go stale
 *
 * Adding a module means adding ONE entry here. The menu, the admin
 * toggle and the register all follow.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS IS NOT A SECURITY BOUNDARY
 * ══════════════════════════════════════════════════════════════════════
 * Hiding a menu item hides a menu item. It does not stop anyone typing
 * the URL. Every route and every server action still calls
 * `requireFeature()` / `requirePermission()` on the server, and must
 * continue to. This file decides what is POLITE to show, not what is
 * SAFE to reach.
 */

import type { FeatureKey } from "@/lib/entitlements/features";
import type { IndustryKey } from "@/lib/industry-templates";

/* ------------------------------------------------------------------ */
/* GROUPS — the six things a person might be trying to do              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ Grouped by INTENT, not by database table.
 *
 * The routes are named after the tables that back them — `receivables`,
 * `gstr2b`, `tally`. That is the right name for a schema and the wrong
 * name for a menu: nobody arrives at work intending to "do a GSTR-2B
 * reconciliation". They intend to sort out tax. So the group a module
 * belongs to is stated here rather than inferred from its URL, and the
 * URL never has to change.
 */
export type ModuleGroup =
  | "home"
  | "customers"
  | "projects"
  | "site"
  | "money"
  | "setup";

export const MODULE_GROUPS: Readonly<
  Record<ModuleGroup, { label: string; order: number }>
> = Object.freeze({
  home: { label: "Home", order: 1 },
  customers: { label: "Customers", order: 2 },
  projects: { label: "Projects & Land", order: 3 },
  site: { label: "Site", order: 4 },
  money: { label: "Money", order: 5 },
  setup: { label: "Setup", order: 6 },
});

/* ------------------------------------------------------------------ */
/* STATUS                                                              */
/* ------------------------------------------------------------------ */

/**
 * `coming_soon` is the important one and it is not decoration.
 *
 * ⚠️ HISTORICAL — v0.73.0-alpha. Seven sidebar entries once pointed at
 * routes that were never built: `/search`, `/deals`, `/documents`,
 * `/reports/cost`, `/calendar`, `/billing`, `/settings/objects`. Every
 * one rendered a 404 when clicked, and a customer cannot tell a missing
 * feature from a broken product — both look like software that does not
 * work. ALL SEVEN NOW EXIST. No module in this registry is
 * `coming_soon` today.
 *
 * The status stays in the type, because the next unbuilt module will
 * need it, and because the reasoning still holds: marking a module
 * removes it from the menu without deleting the intent to build it, and
 * without anybody having to remember which links were dead.
 */
export type ModuleStatus = "live" | "beta" | "coming_soon";

/* ------------------------------------------------------------------ */
/* THE DESCRIPTOR                                                      */
/* ------------------------------------------------------------------ */

export type ModuleDescriptor = {
  /**
   * ⚠️ MATCHED ON `NavItem.id`, NOT ON `href`.
   *
   * Several menu entries share a route with a filter — `/assets?type=unit`
   * and `/assets?type=plot` are both `/assets`. Matching on href would
   * make those one module, so hiding "Plots" would hide "Units" too.
   * The id is stable and already unique across every industry template.
   */
  navId: string;

  /** Plain English. What a person would say out loud. */
  label: string;

  /** One line, for the admin console and the setup wizard. */
  description: string;

  group: ModuleGroup;

  /**
   * The entitlement that decides visibility.
   *
   * `null` means ALWAYS AVAILABLE — the module is part of what a
   * workspace is, not something sold. Keep this list short and
   * deliberate: every `null` is a thing you can never charge for.
   */
  feature: FeatureKey | null;

  status: ModuleStatus;

  /** Recorded for the register and the admin console, never matched on. */
  href: string;

  /**
   * ⭐ Which verticals this module is OFFERED to — Session 1.
   *
   * `undefined` means every industry. A value narrows it.
   *
   * ⚠️ THIS IS AN OFFER LIST, NOT A SECOND ENTITLEMENT CHECK. It governs
   * what your admin console proposes when onboarding a hospital, so
   * nobody is asked whether the client wants freight rate cards. It does
   * NOT filter the sidebar: the industry template already decides that by
   * simply not listing the item, and two mechanisms deciding the same
   * thing is how they end up disagreeing.
   */
  industries?: readonly IndustryKey[];
};

/* ------------------------------------------------------------------ */
/* THE REGISTRY                                                        */
/* ------------------------------------------------------------------ */

/**
 * Keyed by `navId`. Every nav item in every industry template appears
 * here — `tests/ui/module-registry.test.tsx` fails the build if one does
 * not, which is what stops this file drifting from the templates the way
 * everything else drifted from everything else.
 *
 * ⚠️ Several ids map to the SAME feature on purpose. "Clients",
 * "Contacts" and "People" are one capability wearing three industry
 * vocabularies; they are sold once and must therefore appear and
 * disappear together. That is the bug this shape prevents.
 */
export const MODULE_REGISTRY: Readonly<Record<string, ModuleDescriptor>> =
  Object.freeze({
    /* ---- HOME ---------------------------------------------------- */

    dashboard: {
      navId: "dashboard",
      label: "Dashboard",
      description: "The overview a workspace opens on.",
      group: "home",
      // ⚠️ Deliberately null, NOT `analytics.dashboard`. Gating the home
      // screen on an entitlement means a lapsed customer signs in to a
      // workspace with no landing page and concludes their data is gone.
      // The individual PANELS are gated; the page itself is not.
      feature: null,
      status: "live",
      href: "/dashboard",
    },
    search: {
      navId: "search",
      label: "Search",
      description: "Search across every record type.",
      group: "home",
      feature: null,
      status: "live",
      href: "/search",
    },
    assistant: {
      navId: "assistant",
      label: "Assistant",
      description: "AI assistant for GST, receivables, compliance, and more.",
      group: "home",
      feature: null,
      status: "live",
      href: "/assistant",
    },

    /* ---- CUSTOMERS ----------------------------------------------- */

    contacts: {
      navId: "contacts",
      label: "Contacts",
      description: "People and their details.",
      group: "customers",
      feature: "crm.contacts",
      status: "live",
      href: "/contacts",
    },
    clients: {
      navId: "clients",
      label: "Clients",
      description: "People and their details, in legal vocabulary.",
      group: "customers",
      feature: "crm.contacts",
      status: "live",
      href: "/contacts",
    },
    companies: {
      navId: "companies",
      label: "Companies",
      description: "Organisations and their relationships.",
      group: "customers",
      feature: "crm.companies",
      status: "live",
      href: "/companies",
    },
    organisations: {
      navId: "organisations",
      label: "Organisations",
      description: "Companies, in legal vocabulary.",
      group: "customers",
      feature: "crm.companies",
      status: "live",
      href: "/companies",
    },
    contractors: {
      navId: "contractors",
      label: "Contractors",
      description: "Companies filtered to contractors.",
      group: "customers",
      feature: "crm.companies",
      status: "live",
      href: "/companies?type=contractor",
    },
    deals: {
      navId: "deals",
      label: "Deals",
      description: "Pipeline and opportunity tracking.",
      group: "customers",
      feature: "crm.deals",
      status: "live",
      href: "/deals",
    },
    engagements: {
      navId: "engagements",
      label: "Engagements",
      description: "Deals, in legal vocabulary.",
      group: "customers",
      feature: "crm.deals",
      status: "live", // same missing route as `deals`
      href: "/deals",
    },
    leads: {
      navId: "leads",
      label: "Leads",
      description: "The enquiry board and activity history.",
      group: "customers",
      feature: "sales.pipeline",
      status: "live",
      href: "/sales/leads",
    },
    bookings: {
      navId: "bookings",
      label: "Bookings",
      description: "Confirmed sales and their payment plans.",
      group: "customers",
      feature: "sales.bookings",
      status: "live",
      href: "/sales/bookings",
    },
    "channel-partners": {
      navId: "channel-partners",
      label: "Channel Partners",
      description: "Brokers, their deals and their brokerage ledger.",
      group: "customers",
      feature: "sales.channel_partners",
      status: "live",
      href: "/sales/partners",
    },

    /* ---- PROJECTS & LAND ----------------------------------------- */

    assets: {
      navId: "assets",
      label: "Assets",
      description: "Everything the business owns or manages.",
      group: "projects",
      feature: "assets.catalog",
      status: "live",
      href: "/assets",
    },
    projects: {
      navId: "projects",
      label: "Projects",
      description: "Developments, filtered from the asset catalogue.",
      group: "projects",
      feature: "assets.catalog",
      status: "live",
      href: "/assets?type=project",
    },
    buildings: {
      navId: "buildings",
      label: "Buildings",
      description: "Towers and blocks within a project.",
      group: "projects",
      feature: "assets.catalog",
      status: "live",
      href: "/assets?type=building",
    },
    units: {
      navId: "units",
      label: "Units",
      description: "Individual saleable units.",
      group: "projects",
      feature: "assets.catalog",
      status: "live",
      href: "/assets?type=unit",
    },
    plots: {
      navId: "plots",
      label: "Land & Plots",
      description: "Land parcels and their title position.",
      group: "projects",
      feature: "assets.catalog",
      status: "live",
      href: "/assets?type=plot",
    },
    inventory: {
      navId: "inventory",
      label: "Availability",
      description: "What is available, held or sold, at a glance.",
      group: "projects",
      feature: "sales.inventory",
      status: "live",
      href: "/sales/inventory",
    },
    /**
     * ⭐⭐ A REAL TABLE NOW, NOT A LABEL OVER THE ASSET CATALOGUE.
     *
     * 🔴 Until 0058 "Matters" pointed at `/assets?type=matter` and
     * "Cases" at `/assets?type=case` — the same asset register wearing
     * two words. An advocate got a catalogue with no limitation date,
     * no next-date discipline and no client account. The label was doing
     * all of the work.
     *
     * ⚠️ `cases` is deliberately GONE rather than re-pointed. A matter
     * and a case were never two things; they were one word twice, and
     * keeping both would leave a menu entry that quietly means nothing.
     */
    matters: {
      navId: "matters",
      label: "Matters",
      description: "Matters, limitation dates and the hearing diary.",
      group: "projects",
      feature: "sales.orders",
      status: "live",
      href: "/legal/matters",
      industries: ["legal_advocate", "professional_services"],
    },
    /**
     * 🔴 UNDER `money`, NOT `projects`. Client money is a regulated
     * balance that a Bar Council inspection asks about, and the person
     * who reconciles it is the person who reconciles the bank.
     */
    "client-account": {
      navId: "client-account",
      label: "Client Account",
      description: "Money held for clients, and the rule that it is never the firm's.",
      group: "money",
      feature: "sales.orders",
      status: "live",
      href: "/legal/client-account",
      industries: ["legal_advocate", "professional_services"],
    },
    contracts: {
      navId: "contracts",
      label: "Contracts",
      description: "Agreements and their obligations.",
      group: "projects",
      feature: "clm.contracts",
      status: "live",
      href: "/assets?type=contract",
    },
    /**
     * ⚠️ FOLDED INTO `matters`, DELIBERATELY. "Hearings" pointed at
     * `/calendar` with `feature: null` — a generic diary wearing a legal
     * word. A hearing only means anything against the matter it belongs
     * to, and the question a clerk asks at eight in the morning is "what
     * is listed today", which the matters screen answers directly.
     */

    /* ---- SITE ---------------------------------------------------- */

    "cost-control": {
      navId: "cost-control",
      label: "Cost Control",
      description: "Budget against actual, by project.",
      group: "site",
      feature: "analytics.dashboard",
      status: "live",
      href: "/reports/cost",
    },

    /*
     * ⭐ THE CONTRACTING PAIR — v0.69.0.
     *
     * ⚠️ TWO ENTRIES ON TWO DIFFERENT FEATURE KEYS, NOT ONE. A BOQ is an
     * estimate and every developer needs it; an RA bill moves money and
     * carries the EPF/ESI payment gate. Putting both behind one key
     * forces them onto one tier, which means either giving away the
     * payment engine or charging an estimator for it. See
     * `lib/entitlements/features.ts`.
     */
    boq: {
      navId: "boq",
      label: "BOQ",
      description: "What each contractor is authorised to build, and what has been measured.",
      group: "site",
      feature: "construction.boq",
      status: "live",
      href: "/boq",
    },

    /**
     * ⭐ VARIATIONS — added in Batch 2.1.
     *
     * ⚠️ IT SHARES `construction.boq`, DELIBERATELY. A variation changes
     * the BOQ's authorised quantities and rates; a tenant that has paid
     * for bills of quantities but not for "variations" would be able to
     * agree scope it can never record a change to, and the first change
     * order on any real site would put the register and the contract out
     * of step permanently.
     *
     * The separately-grantable control is the PERMISSION
     * `construction.variation.approve`, not the feature — because the
     * thing worth separating is who may approve, not who may see.
     */
    variations: {
      navId: "variations",
      label: "Variations",
      description: "Every change to agreed scope, and what happened to it.",
      group: "site",
      feature: "construction.boq",
      status: "live",
      href: "/variations",
    },

    /**
     * ⭐ SITE LABOUR — added in Batch 2.2.
     *
     * ⚠️ Also on `construction.boq`. A tenant that can raise an RA bill
     * but cannot record who was on site has bought half a system: the
     * bill says work was done and nothing says who did it. The EPF
     * challan will not reconcile, and the gap is only discovered at the
     * quarterly filing.
     */
    "site-labour": {
      navId: "site-labour",
      label: "Site labour",
      description: "Who may work, who was there, and what has not been billed.",
      group: "site",
      feature: "construction.boq",
      status: "live",
      href: "/site-labour",
    },

    "ra-bills": {
      navId: "ra-bills",
      label: "RA Bills",
      description: "Running-account bills raised from measured work, with retention and TDS.",
      group: "site",
      feature: "construction.ra_bills",
      status: "live",
      href: "/ra-bills",
    },

    /* ---- MONEY --------------------------------------------------- */

    billing: {
      navId: "billing",
      label: "Billing",
      description: "Your Ordence subscription and invoices.",
      group: "money",
      feature: null,
      // 🔴 /billing does not exist. The real screen is /settings/billing.
      // Left as coming_soon rather than silently repointed: the two are
      // different intents, and a menu entry that quietly goes somewhere
      // else is worse than one that is absent.
      status: "live",
      href: "/billing",
    },
    documents: {
      navId: "documents",
      label: "Documents",
      description: "Files attached to any record.",
      group: "money",
      feature: "storage.documents",
      status: "live",
      href: "/documents",
    },

    /* ---- SETUP --------------------------------------------------- */

    settings: {
      navId: "settings",
      label: "Settings",
      description: "Company details, branding and preferences.",
      group: "setup",
      feature: null,
      status: "live",
      href: "/settings",
    },
    team: {
      navId: "team",
      label: "Team",
      description: "Your people and what they may do.",
      group: "setup",
      feature: null,
      status: "live",
      href: "/settings/team",
    },
    objects: {
      navId: "objects",
      label: "Custom Objects",
      description: "The original JSONB-backed custom record engine.",
      group: "setup",
      feature: "crm.custom_objects",
      status: "live", // 🔴 /settings/objects does not exist
      href: "/settings/objects",
    },
    "record-types": {
      navId: "record-types",
      label: "Record types",
      description: "Define your own record types, with real columns.",
      group: "setup",
      feature: "crm.custom_objects",
      status: "live",
      href: "/objects",
    },
    /* ---- ENGINES (Session 1) ------------------------------------ */

    scheduling: {
      navId: "scheduling",
      label: "Scheduling",
      description: "Bookable resources, calendars and capacity.",
      group: "home",
      feature: "scheduling.resources",
      status: "live",
      href: "/scheduling",
      industries: ["hospitality","healthcare","logistics","solar","software","professional_services"],
    },
    arrivals: {
      navId: "arrivals",
      label: "Arrivals & Departures",
      description: "Today's movements, filtered from the schedule.",
      group: "home",
      feature: "scheduling.resources",
      status: "live",
      href: "/scheduling?view=today",
      industries: ["hospitality"],
    },
    rates: {
      navId: "rates",
      label: "Rates",
      description: "Price lists by season, channel, customer and slab.",
      group: "money",
      feature: "rates.cards",
      status: "live",
      href: "/rates",
      industries: ["hospitality","healthcare","logistics","trading","electricity"],
    },
    "field-jobs": {
      navId: "field-jobs",
      label: "Field Work",
      description: "Job cards, dispatch and proof of service.",
      group: "site",
      feature: "field.jobs",
      status: "live",
      href: "/field-jobs",
      industries: ["logistics","solar","healthcare","electricity","hospitality"],
    },
    housekeeping: {
      navId: "housekeeping",
      label: "Housekeeping",
      description: "Room status board and cleaning assignment.",
      group: "site",
      feature: "field.jobs",
      status: "live",
      href: "/field-jobs?type=housekeeping",
      industries: ["hospitality"],
    },
    "compliance-board": {
      navId: "compliance-board",
      label: "Deadlines",
      description: "Every statutory obligation, when it is due and what lateness costs.",
      group: "setup",
      feature: "compliance.calendar",
      status: "live",
      href: "/compliance",
    },
    licences: {
      navId: "licences",
      label: "Licences",
      description: "Permissions that expire, and the renewal window before they do.",
      group: "setup",
      feature: "compliance.licences",
      status: "live",
      href: "/compliance/licences",
    },
    meters: {
      navId: "meters",
      label: "Meters",
      description: "Meter registry and connections.",
      group: "site",
      feature: "metering.readings",
      status: "live",
      href: "/meters",
      industries: ["electricity","solar"],
    },
    readings: {
      navId: "readings",
      label: "Readings",
      description: "Consumption and generation, validated.",
      group: "site",
      feature: "metering.readings",
      status: "live",
      href: "/meters/readings",
      industries: ["electricity","solar"],
    },
    timesheets: {
      navId: "timesheets",
      label: "Timesheets",
      description: "Hours by person, project and task.",
      group: "site",
      feature: "timesheets.entry",
      status: "live",
      href: "/timesheets",
      industries: ["software","professional_services"],
    },

    /* ---- VERTICAL VOCABULARY OVER EXISTING MODULES --------------- */
    /*
     * ⚠️ SAME FEATURE KEY AS THE MODULE THEY RENAME. "Guests",
     * "Patients" and "Consumers" are `crm.contacts` in three costumes.
     * Giving them keys of their own would let a hospital lose Patients
     * while keeping Contacts, which is not a state anybody meant to be
     * possible.
     */
    guests: {
      navId: "guests", label: "Guests",
      description: "People, in hospitality vocabulary.",
      group: "customers", feature: "crm.contacts", status: "live",
      href: "/contacts", industries: ["hospitality"],
    },
    patients: {
      navId: "patients", label: "Patients",
      description: "People, in clinical vocabulary.",
      group: "customers", feature: "crm.contacts", status: "live",
      href: "/contacts", industries: ["healthcare"],
    },
    consumers: {
      navId: "consumers", label: "Consumers",
      description: "People, in utility vocabulary.",
      group: "customers", feature: "crm.contacts", status: "live",
      href: "/contacts", industries: ["electricity"],
    },
    beds: {
      navId: "beds", label: "Beds & Wards",
      description: "Assets, in clinical vocabulary.",
      group: "projects", feature: "assets.catalog", status: "live",
      href: "/assets?type=bed", industries: ["healthcare"],
    },
    consignments: {
      navId: "consignments", label: "Consignments",
      description: "Orders, in logistics vocabulary.",
      group: "site", feature: "sales.orders", status: "live",
      href: "/orders", industries: ["logistics"],
    },

    /* ---- EXISTING SCREENS, NOW REACHED BY THE VERTICALS ---------- */

    orders: {
      navId: "orders", label: "Orders",
      description: "Commitments made and not yet delivered.",
      group: "site", feature: "sales.orders", status: "live", href: "/orders",
    },
    /**
     * ⭐ PHASE 54 — the outward document finally has a screen.
     *
     * ⚠️ `group: "money"`, NOT `"site"`, and the difference is who looks.
     * Purchases sit under `site` because a site engineer passes a
     * contractor's bill. A sales invoice is read by whoever chases the
     * money, and they open the money group.
     */
    invoices: {
      navId: "invoices", label: "Invoices",
      description: "Tax invoices raised, and what is still owed on them.",
      group: "money", feature: "sales.orders", status: "live", href: "/invoices",
    },
    /**
     * ⚠️ ITS OWN ENTRY, NOT A TAB UNDER INVOICES. A credit note is a
     * separate document with its own consecutive series (Rule 53) and
     * its own GSTR-1 table (CDNR/CDNUR). Whoever is reconciling returns
     * at month end is looking for reversals, not for the invoice they
     * happen to hang off.
     */
    /** ⚠️ The key IS the navId — `module-registry.test.tsx` enforces it. */
    "credit-notes": {
      navId: "credit-notes", label: "Credit Notes",
      description: "Reversals of issued invoices — returns, rate revisions, discounts.",
      group: "money", feature: "sales.orders", status: "live", href: "/credit-notes",
    },
    purchases: {
      navId: "purchases", label: "Purchases",
      description: "Vendor invoices and input tax credit.",
      group: "site", feature: "purchases.invoices", status: "live", href: "/purchases",
    },
    /**
     * ⚠️ Its own entry rather than a tab under Invoices. Whoever is
     * clearing unapplied cash at month end is looking for money that has
     * arrived, not for a document that was sent.
     */
    /**
     * ⚠️ Under `money`, beside the documents it posts. Somebody who
     * notices the P&L is missing revenue looks here, not in Settings.
     */
    "sales-posting": {
      navId: "sales-posting", label: "Sales Posting",
      description: "Which ledger each part of a sales document posts to, and what is waiting.",
      group: "money", feature: "sales.orders", status: "live", href: "/accounting/posting",
    },
    /**
     * 🔴 Its own entry because it is the ONLY place property revenue is
     * ever recognised. Buried in a booking detail screen it would be
     * found by nobody, and a developer would report zero turnover while
     * wondering why.
     */
    /**
     * ⭐ UNDER `money`, NOT UNDER `site`, AND NOT BESIDE TIMESHEETS.
     *
     * ⚠️ "Timesheets" answers "who was here" from attendance punches and
     * field visits. THIS answers "what do we bill" — a different fact,
     * a different table, and a different person opening it. Filing them
     * together would put a partner's billing screen behind a
     * supervisor's muster roll.
     */
    time: {
      navId: "time", label: "Time & Billing",
      description: "Hours recorded, what they are worth, and the invoice they become.",
      group: "money", feature: "sales.orders", status: "live", href: "/time",
      industries: ["legal_advocate","professional_services","software"],
    },
    possession: {
      navId: "possession", label: "Possession",
      description: "Handing over flats — the moment property revenue is earned.",
      group: "money", feature: "sales.receivables", status: "live", href: "/sales/possession",
    },
    receipts: {
      navId: "receipts", label: "Receipts",
      description: "Money received, and what is still unapplied.",
      group: "money", feature: "sales.orders", status: "live", href: "/receipts",
    },
    receivables: {
      navId: "receivables", label: "Payments Due",
      description: "Demands raised, ageing and the dunning ladder.",
      group: "money", feature: "sales.receivables", status: "live", href: "/receivables",
    },
    statements: {
      navId: "statements", label: "Statements",
      description: "Statement of account, per customer.",
      group: "money", feature: "sales.receivables", status: "live", href: "/statements",
    },
    accounting: {
      navId: "accounting", label: "Ledger",
      description: "Double-entry books and period close.",
      group: "money", feature: "accounting.ledger", status: "live", href: "/accounting",
    },
    /**
     * ⭐ UNDER `money`, BESIDE RATES. A price check is opened while
     * somebody is on the phone to a customer holding an invoice at a
     * different figure — it answers "which card applied and what beat
     * what", which is a sales question, not a settings one.
     */
    "price-check": {
      navId: "price-check", label: "Price Check",
      description: "What a customer pays for a quantity on a date, and which rate card decided it.",
      group: "money", feature: "sales.orders", status: "live", href: "/rates/price-check",
      industries: ["trading","small_business","logistics","solar","hospitality"],
    },
    /**
     * 🔴 UNDER `money` BECAUSE IT IS A TAX DECISION, NOT A SALES ONE. A
     * rebate agreed after the period it covers cannot reduce GST, and
     * the person who needs to know that is filing a return.
     */
    "discounts": {
      navId: "discounts", label: "Rebates & Discounts",
      description: "Post-supply rebates, and whether s.15(3) lets them reduce the tax.",
      group: "money", feature: "gst.registry", status: "live", href: "/gst/discounts",
      industries: ["trading","small_business","logistics","solar"],
    },
    /**
     * ⭐ ITS OWN ENTRY BECAUSE IT IS A DOCUMENT, NOT A REPORT.
     *
     * 🔴 A transfer between two GSTINs is a taxable supply — it lands on
     * one branch's GSTR-1 and the other's input credit. Burying it under
     * a stock report would file a tax document as a warehouse task.
     */
    transfers: {
      navId: "transfers", label: "Stock Transfers",
      description: "Moving stock between our own places — and whether that is a supply.",
      group: "site", feature: "inventory.stock", status: "live", href: "/inventory/transfers",
      industries: ["trading","small_business","logistics","solar","real_estate_developer"],
    },
    /**
     * ⚠️ UNDER `site` WITH PURCHASES, NOT UNDER `money`. Whoever files a
     * freight bill is the person who files purchase invoices, and the
     * uplift figure is read by a buyer rather than an accountant.
     */
    "landed-cost": {
      navId: "landed-cost", label: "Landed Cost",
      description: "Freight, duty and clearing — what the goods really cost on the shelf.",
      group: "site", feature: "purchases.invoices", status: "live", href: "/purchases/landed-cost",
      industries: ["trading","small_business","solar","logistics"],
    },
    /**
     * ⭐ THREE ENTRIES UNDER `site`, BESIDE THE STOCK THEY DESCRIBE.
     *
     * 🔴 Expiry is read DAILY by a storekeeper, not monthly by an
     * accountant. Filing it under GST — where the ITC reversal lives —
     * would put a stock rotation screen behind a tax menu.
     */
    batches: {
      navId: "batches", label: "Batches & Expiry",
      description: "Batch numbers, expiry dates and what has to be written off.",
      group: "site", feature: "inventory.stock", status: "live", href: "/inventory/batches",
      industries: ["trading","small_business","solar","logistics","healthcare"],
    },
    serials: {
      navId: "serials", label: "Serial Numbers",
      description: "Where each unit is, who has it, and what warranty it carries.",
      group: "site", feature: "inventory.stock", status: "live", href: "/inventory/serials",
      industries: ["trading","solar","electricity","software"],
    },
    "goods-returns": {
      navId: "goods-returns", label: "Goods Returned",
      description: "Stock coming back, where it lands, and the s.34(2) tax deadline.",
      group: "site", feature: "inventory.stock", status: "live", href: "/inventory/returns",
      industries: ["trading","small_business","logistics","solar"],
    },
    /**
     * ⭐ ITS OWN ENTRY, NOT A TAB UNDER GST.
     *
     * 🔴 Everything else under GST is read monthly by an accountant.
     * This is read DAILY by a dispatch clerk with a driver waiting, and
     * burying it one click deeper is how a consignment leaves on a
     * `prepared` bill that covers nothing.
     */
    eway: {
      navId: "eway", label: "E-way Bills",
      description: "Rule 138 — the document a consignment cannot lawfully move without.",
      group: "money", feature: "gst.registry", status: "live", href: "/gst/eway",
      industries: ["trading","logistics","small_business","solar","real_estate_developer"],
    },
    gst: {
      navId: "gst", label: "GST",
      description: "Registrations, rates and returns.",
      group: "money", feature: "gst.registry", status: "live", href: "/gst",
    },
    tds: {
      navId: "tds", label: "TDS",
      description: "Deductions, challans and quarterly returns.",
      group: "money", feature: "tds.deductions", status: "live", href: "/tds",
    },
    gstr2b: {
      navId: "gstr2b",
      label: "GSTR-2B Reconciliation",
      description: "Match purchase invoices against the auto-generated GSTR-2B.",
      group: "money",
      feature: "gst.gstr2b",
      status: "live",
      href: "/gstr2b",
    },
    tally: {
      navId: "tally",
      label: "Tally Export",
      description: "Export vouchers and masters for Tally import.",
      group: "money",
      feature: "accounting.tally",
      status: "live",
      href: "/tally",
    },
    land: {
      navId: "land",
      label: "Land & Title",
      description: "Land parcels, survey numbers and the chain of title.",
      group: "projects",
      feature: "land.title",
      status: "live",
      href: "/land",
    },
    stock: {
      navId: "stock",
      label: "Materials",
      description: "Stock on hand, reserved and available. Reorder alerts.",
      group: "site",
      feature: "inventory.stock",
      status: "live",
      href: "/inventory",
    },

    automations: {
      navId: "automations",
      label: "Automations",
      description: "Rules that run when something happens.",
      group: "setup",
      feature: "workflows.builder",
      status: "live",
      href: "/automations",
    },

    notifications: {
      navId: "notifications",
      label: "Notifications",
      description: "Alerts from compliance deadlines, receivables, GST, and background workers.",
      group: "setup",
      feature: null, // always available
      status: "live",
      href: "/notifications",
    },

    setup: {
      navId: "setup",
      label: "Setup Wizard",
      description: "Guided first-time setup for new workspaces.",
      group: "setup",
      feature: null, // always available
      status: "live",
      href: "/setup",
    },

    reports: {
      navId: "reports",
      label: "Reports",
      description: "Predefined reports: GST, receivables, TDS, compliance, inventory, profitability.",
      group: "setup",
      feature: null, // always available
      status: "live",
      href: "/reports",
    },
  });

/* ------------------------------------------------------------------ */
/* DERIVED — never maintained by hand                                  */
/* ------------------------------------------------------------------ */

export const MODULE_NAV_IDS: readonly string[] = Object.freeze(
  Object.keys(MODULE_REGISTRY),
);

/** Look up a module. `undefined` for an id the registry has never heard of. */
export function moduleForNavId(navId: string): ModuleDescriptor | undefined {
  return MODULE_REGISTRY[navId];
}

/**
 * Every DISTINCT feature key any module depends on.
 *
 * This is what the layout passes to `checkFeatures()` — one call, one
 * query, every answer the menu needs. Deduplicated because several ids
 * share a feature; asking twice would be free but the shape would imply
 * they were separate purchases.
 */
export function requiredFeatureKeys(): FeatureKey[] {
  const seen = new Set<FeatureKey>();
  for (const mod of Object.values(MODULE_REGISTRY)) {
    if (mod.feature) seen.add(mod.feature);
  }
  return [...seen].sort();
}

/** Modules in one group, for the admin console and the wizard. */
export function modulesInGroup(group: ModuleGroup): ModuleDescriptor[] {
  return Object.values(MODULE_REGISTRY).filter((m) => m.group === group);
}

/**
 * Groups in display order, each with its live modules.
 *
 * `coming_soon` is excluded here as well: an admin console that lets you
 * sell a customer access to a 404 is worse than one that does not list
 * it. When a route ships, one word changes in this file and it appears
 * in the menu, the admin console and the register at the same moment.
 */
export function groupedModules(): Array<{
  group: ModuleGroup;
  label: string;
  modules: ModuleDescriptor[];
}> {
  return (Object.keys(MODULE_GROUPS) as ModuleGroup[])
    .sort((a, b) => MODULE_GROUPS[a].order - MODULE_GROUPS[b].order)
    .map((group) => ({
      group,
      label: MODULE_GROUPS[group].label,
      modules: modulesInGroup(group).filter((m) => m.status === "live"),
    }))
    .filter((g) => g.modules.length > 0);
}

/** Everything named but not yet reachable. Used by the roadmap register. */
export function comingSoonModules(): ModuleDescriptor[] {
  return Object.values(MODULE_REGISTRY).filter(
    (m) => m.status === "coming_soon",
  );
}
