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
    /**
     * ⭐⭐ ADDED IN v1.9.0. Fifty-nine migrations and there was no task
     * table anywhere. Ordence could record what a business IS and not
     * what anybody DID about any of it.
     *
     * 🔴 UNDER `home`, NOT `setup`. A task list is not configuration.
     * It is the first screen a person opens and the last one they close.
     */
    tasks: {
      navId: "tasks",
      label: "Tasks",
      description: "What has to be done, by whom, by when.",
      group: "home",
      feature: "crm.contacts",
      status: "live",
      href: "/tasks",
    },
    /**
     * ⭐ EVERYTHING DATED, IN ONE LIST. Hearings, filings, licence
     * renewals, money due, tasks and diary entries.
     *
     * ⚠️ Replaces the generic calendar the removed `hearings` module
     * used to point at. That one held nothing; this one holds six
     * sources and stores none of them.
     */
    calendar: {
      navId: "calendar",
      label: "Calendar",
      description: "Everything dated, from every module, in one day.",
      group: "home",
      feature: "crm.contacts",
      status: "live",
      href: "/calendar",
    },
    /**
     * ⭐⭐ ADDED IN v1.10.0. The cheapest loyalty feature on the plan:
     * ledgers do not create habit, conversations do.
     *
     * 🔴 The conversation lives on the record it is about, so the next
     * person to open the file finds it.
     */
    messages: {
      navId: "messages",
      label: "Messages",
      description: "Conversations, on the record they are about.",
      group: "home",
      feature: "crm.contacts",
      status: "live",
      href: "/messages",
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
      /**
       * ⭐ WAS `null` UNTIL BATCH 0109, AND `null` MEANS "PART OF WHAT A
       * WORKSPACE IS, RATHER THAN SOMETHING SOLD".
       *
       * The assistant is sold: `ai.copilot` sits at the `ai` tier in
       * `lib/entitlements/features.ts`. So the menu entry advertised a
       * paid module to every plan, and `/api/assistant` answered them.
       *
       * ⚠️ THIS LINE IS THE MENU, NOT THE GATE. The gate is in
       * `app/api/assistant/route.ts`, because a hidden link stops nobody
       * holding a session cookie and every call it forwards costs us
       * tokens at a third party.
       */
      feature: "ai.copilot",
      status: "live",
      href: "/assistant",
    },

    /* ---- CUSTOMERS ----------------------------------------------- */

    /**
     * 🔴 THE DPDP RULES 2025 WERE NOTIFIED ON 13 NOVEMBER 2025 AND THE
     * PENALTY REGIME BEGINS MAY 2027, which is inside the life of the
     * current plan rather than after it.
     *
     * ⚠️ Consent as a tick box is not consent. What matters is the
     * wording shown, the purpose agreed, and how easily it comes back.
     */
    consent: {
      navId: "consent",
      label: "Consent",
      description: "What each person agreed to, and what they were shown.",
      group: "customers",
      feature: "crm.contacts",
      status: "live",
      href: "/crm/consent",
    },
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
    /**
     * ⭐⭐ ADDED IN v1.13.0. Enquiries that arrived on their own.
     *
     * 🔴 NOT A SECOND LEAD LIST. The leads that filed cleanly are in the
     * pipeline where they belong; this screen is the ones that could not
     * be filed, and the customer paid for those exactly as much.
     */
    enquiries: {
      navId: "enquiries",
      label: "Enquiries",
      description: "What arrived from connected accounts, and anything that could not be filed.",
      group: "customers",
      feature: "crm.contacts",
      status: "live",
      href: "/enquiries",
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
    today: {
      navId: "today",
      label: "Today",
      description: "What needs attention, ordered by what it costs to ignore.",
      group: "customers",
      /**
       * 🔴 `feature: null` — THE SECOND MODULE TO BE UNGATED, AND FOR
       * THE SAME REASON AS THE FIRST.
       *
       * `statutory_due` was left ungated in v1.24.0 because a tenant who
       * has stopped paying us still has to pay the Government. This page
       * is the thing that TELLS THEM the deadline is coming.
       *
       * ⚠️ AND IT IS THE PAGE A DOWNGRADED WORKSPACE NEEDS MOST. Gating
       * it would mean the moment a business is short of money — which is
       * when a plan gets downgraded — is the moment we stop warning them
       * about the payments that carry damages.
       *
       * ⭐ It also carries no data of its own: every line is a count and
       * a total read from a module that has its own gate, so a locked
       * module simply contributes nothing to it.
       */
      feature: null,
      status: "live",
      href: "/command",
    },
    brokerage: {
      navId: "brokerage",
      label: "Brokerage",
      description: "What brokers have earned, what was withheld, what is owed.",
      group: "customers",
      /**
       * ⭐ `sales.brokerage` ALREADY EXISTED AS A FEATURE KEY and had
       * exactly one reference in the whole product, in a lead action.
       * The calculation it gated had no screen and no document — which
       * is the same shape as the engine itself.
       */
      feature: "sales.brokerage",
      status: "live",
      href: "/sales/brokerage",
    },
    cancellations: {
      navId: "cancellations",
      label: "Cancellations",
      description: "Forfeiture, refunds owed to buyers, and the tax reversal.",
      group: "customers",
      /**
       * ⚠️ GATED ON `sales.bookings`, THE SAME KEY THE BOOKINGS SCREEN
       * USES, and not on a key of its own. A tenant who can create a
       * booking must be able to close one: gating the cancellation
       * separately would let a workspace record sales it has no way to
       * unwind, and the balances would accumulate against buyers who
       * had gone.
       */
      feature: "sales.bookings",
      status: "live",
      href: "/sales/cancellations",
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
    /**
     * 🔴 UNDER `money`. A disbursement is a payment out that decides
     * whether tax is due on the recovery — Rule 33 of the CGST Rules —
     * so it belongs with the money, not with the matter it happens to
     * sit on.
     */
    disbursements: {
      navId: "disbursements",
      label: "Disbursements",
      description: "Court fees paid for clients, and the Rule 33 recovery at actual.",
      group: "money",
      feature: "sales.orders",
      status: "live",
      href: "/legal/disbursements",
      industries: ["legal_advocate", "professional_services"],
    },
    /**
     * ⭐ THE SCREEN THAT CORRECTS v1.2.0. `raiseInvoiceFromTime` charged
     * 18% forward on every invoice; for an advocate the supply is
     * exempt or on reverse charge nearly every time.
     */
    "fee-note": {
      navId: "fee-note",
      label: "Fee Note",
      description: "Who pays the GST on a lawyer's bill, worked out before it is raised.",
      group: "money",
      feature: "sales.orders",
      status: "live",
      href: "/legal/fee-note",
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
    /**
     * ⭐⭐ WAVE 7 — DRAWINGS, ON THEIR OWN FEATURE KEY.
     *
     * 🔴 THIS ENTRY EXISTS BECAUSE TWO TESTS REFUSED THE WAVE WITHOUT IT:
     *
     *     "These nav items are not in lib/modules/registry.ts. Until they
     *      are, they ignore the customer's plan and are shown to
     *      everyone."
     *
     * ⚠️ THAT IS THE WHOLE POINT OF THE REGISTRY and it is easy to miss —
     * a nav item added to a template renders perfectly, links correctly,
     * and is simply not gated. The customer on the tier that does not
     * include drawings sees the menu and a screen that works.
     */
    drawings: {
      navId: "drawings",
      label: "Drawings",
      description:
        "The register: which sheet is current, what it supersedes, and what can be measured off it.",
      group: "site",
      feature: "construction.drawings",
      status: "live",
      href: "/drawings",
    },

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
    /**
     * ⭐⭐ ADDED IN v1.11.0. The money going out had less discipline on
     * it than the money coming in, which is the wrong way round.
     *
     * 🔴 UNDER `money`. It decides which vendor gets paid this week, and
     * the answer is not "the oldest".
     */
    "payment-run": {
      navId: "payment-run",
      label: "Payment Run",
      description: "Who to pay this week, and which bills cannot be paid at all.",
      group: "money",
      feature: "purchases.invoices",
      status: "live",
      href: "/purchases/payment-run",
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
    /**
     * ⭐⭐ ADDED IN v1.12.0. The frame five integrations share.
     *
     * 🔴 NOT THE SAME AS `/settings/integrations`. That page is what
     * ORDENCE is configured with. This one is the customer's OWN
     * accounts, and it is opened on the morning the enquiries stopped.
     *
     * ⚠️ `feature: null`, like Settings and Team. Connecting a lead
     * source is not a paid module — refusing to let a customer plug in
     * their own IndiaMART account until they upgrade is how a product
     * loses the account it was trying to upsell.
     */
    /**
     * ⭐⭐ ADDED IN v1.14.0. What went out, what it cost, and what did
     * not reach anybody.
     *
     * 🔴 UNDER `setup`, beside Connections, because it is the same
     * question from the other end: that screen says whether the account
     * is working, this one says what it did today and what it charged.
     */
    /**
     * ⭐⭐ ADDED IN v1.15.0. Marketing sends and who was left out.
     *
     * 🔴 `feature: "crm.contacts"`, unlike Messaging. The spend report
     * has to be free because a customer at risk of a surprise bill must
     * see it coming; a marketing campaign tool is a paid capability and
     * charging for it is honest.
     */
    /**
     * ⭐⭐ ADDED IN v1.16.0. The feature the owner asked for by name.
     *
     * 🔴 And the half they did not ask for is worth more: the customer
     * who has quietly stopped. Nothing else in an ERP reports an absence.
     */
    rhythms: {
      navId: "rhythms",
      label: "Order rhythm",
      description: "Who is about to order, and who has quietly stopped.",
      group: "customers",
      feature: "crm.contacts",
      status: "live",
      href: "/rhythms",
    },
    campaigns: {
      navId: "campaigns",
      label: "Campaigns",
      description: "Marketing sends, what they cost, and who was left out.",
      group: "customers",
      feature: "crm.contacts",
      status: "live",
      href: "/campaigns",
    },
    messaging: {
      navId: "messaging",
      label: "Messaging",
      description: "WhatsApp spend, templates, and messages that did not arrive.",
      group: "setup",
      feature: null,
      status: "live",
      href: "/messaging",
    },
    connections: {
      navId: "connections",
      label: "Connections",
      description: "Lead sources and messaging accounts, and why one stopped.",
      group: "setup",
      feature: null,
      status: "live",
      href: "/settings/connections",
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
    /**
     * ⭐⭐⭐ PAYROLL — v1.23.0-alpha, batch 15.
     *
     * ⚠️ `money`, NOT `site`. Payroll is a wage BILL: it posts a
     * journal, it creates five statutory liabilities, and the person
     * who looks at it is the person who looks at the ledger. Filing it
     * beside site attendance would put it in front of a site engineer
     * and hide it from the accountant.
     *
     * 🔴 AND NO `industries` NARROWING. Everybody who employs anybody
     * runs payroll.
     */
    payroll: {
      navId: "payroll",
      label: "Payroll",
      description:
        "Employees, salary structures, statutory deductions and a wage bill that posts to the ledger.",
      group: "money",
      feature: "hr.payroll",
      status: "live",
      href: "/payroll",
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
    /**
     * ⭐⭐ THE RERA STATUTORY LADDER — v1.67.0.
     *
     * 🔴 ITS OWN ENTRY, NOT A TAB UNDER `receivables`. "What is owed and
     * how late" and "which family is one letter away from losing their
     * flat" are read by different people, on different days, under
     * different rights — the second needs
     * `receivables:warn_cancellation`, which the accountant who reads the
     * first deliberately does not hold. Filing the ladder inside the
     * ageing report would bury a statutory process behind a finance
     * screen and hide it from the person whose decision it is.
     *
     * ⚠️ GATED ON `sales.receivables`, THE SAME KEY THE DEMANDS NEED.
     * A workspace that may raise a demand may see the ladder that chases
     * it; a workspace that may not has nothing for this screen to show.
     *
     * ⚠️ REAL ESTATE ONLY. This is the RERA ladder, ending in a letter
     * that precedes forfeiting a home deposit.
     */
    "dunning-ladder": {
      navId: "dunning-ladder", label: "Statutory Ladder",
      description: "Which allottees are due for which rung, and what was served before.",
      group: "money", feature: "sales.receivables", status: "live", href: "/receivables/ladder",
      industries: ["real_estate_developer"],
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
    "period-close": {
      navId: "period-close",
      label: "Close a period",
      description: "What is still outside the ledger before a month is sealed.",
      group: "money",
      /**
       * ⚠️ `accounting.period_close`, THE SAME KEY `closeFinancialPeriod`
       * ALREADY REQUIRES. Gating the checklist on `accounting.ledger`
       * would show a workspace the list and then refuse the close it is
       * a checklist for.
       */
      feature: "accounting.period_close",
      status: "live",
      href: "/accounting/close",
    },
    /**
     * ⭐⭐ THE FIXED ASSET REGISTER — batch 100.
     *
     * 🔴 UNDER `money` AND BESIDE THE LEDGER, because the charge it
     * produces is a line of the profit and loss account and the person
     * who runs it is the person who closes the month. Filing it under
     * `site` with the stock it physically resembles would put a
     * statutory computation behind a storekeeper's menu.
     *
     * ⚠️ GATED ON `accounting.ledger`, THE SAME KEY THE POSTING NEEDS.
     * Depreciation ends in a journal entry; showing the register to a
     * workspace that cannot post one would advertise a screen whose
     * whole purpose is refused at the last step.
     */
    "fixed-assets": {
      navId: "fixed-assets",
      label: "Fixed Assets",
      description:
        "The register, Schedule II depreciation, the section 32 allowance and the difference between them.",
      group: "money",
      feature: "accounting.ledger",
      status: "live",
      href: "/fixed-assets",
    },
    /**
     * ⭐⭐⭐ BANK RECONCILIATION — REGISTERED IN 0110, AND IT SHOULD HAVE
     *    BEEN REGISTERED IN 0070.
     *
     * ══════════════════════════════════════════════════════════════════
     * 🔴 `/banking` HAS EXISTED SINCE v1.18.0 WITH NO REGISTRY ENTRY AND
     *    NO NAV ITEM ANYWHERE
     * ══════════════════════════════════════════════════════════════════
     * `0070` built statement import and matching; `0102` built the
     * reconciliation statement, the sign-off and the lock. Both shipped
     * with every gate green, because no gate asked whether the screen
     * could be REACHED. The only routes to it were the URL bar and a
     * back-link from a page nobody could reach either.
     *
     * ⚠️ AND WITH NO REGISTRY ENTRY IT WOULD IGNORE THE CUSTOMER'S PLAN
     *    ENTIRELY, which is defect number three on this codebase's list:
     *    34 of 71 entitlement keys built and never gated.
     *
     * ⭐ GATED ON `accounting.ledger`, THE SAME KEY THE POSTING NEEDS,
     *    and for the same reason `fixed-assets` is. A reconciliation ends
     *    in a journal — the bank charge written up from the statement —
     *    so showing this to a workspace that cannot post one would
     *    advertise a screen whose central button is refused at the last
     *    step. A `banking.*` key of its own would be the right answer and
     *    `lib/entitlements/features.ts` is not this batch's to change.
     */
    banking: {
      navId: "banking",
      label: "Bank Reconciliation",
      description:
        "Import the bank statement, explain every line against the books, and sign the reconciliation off on a date after which the month stops moving.",
      group: "money",
      feature: "accounting.ledger",
      status: "live",
      href: "/banking",
    },
    /**
     * ⭐ THE REGISTER THE RECONCILIATION SCREEN FEEDS — 0110.
     *
     * ⚠️ A SEPARATE ENTRY RATHER THAN A SUB-PAGE OF `banking`, because it
     * is opened by a different person at a different time: the
     * reconciliation is worked during the month and this is read when the
     * return is filed.
     */
    "bank-charge-itc": {
      navId: "bank-charge-itc",
      label: "Bank Charge Credit",
      description:
        "Bank charges are posted gross because the bank's tax invoice arrives separately. This is the input credit that is therefore not claimed yet, per tax period, with the invoice recorded against each charge.",
      group: "money",
      feature: "accounting.ledger",
      status: "live",
      href: "/banking/input-credit",
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
    /**
     * ⭐⭐⭐ RECORDING A DEDUCTION — WAVE ONE, AND IT IS ITS OWN ENTRY.
     *
     * ══════════════════════════════════════════════════════════════════
     * 🔴 `recordDeduction` HELD THE ONLY INSERT INTO `tds_deductions` AND
     *    NOTHING CALLED IT
     * ══════════════════════════════════════════════════════════════════
     * `/tds` imports three reads. The register could never receive a row,
     * so the interest exposure could only report zero, Form 26Q could
     * only be empty and Form 16A could only be empty — and every one of
     * those screens rendered correctly. An empty TDS register reads as
     * "nothing owed".
     *
     * ⚠️ ITS OWN ENTRY RATHER THAN A TAB UNDER `tds`, because it is the
     * one thing here that is done BEFORE a payment rather than after a
     * quarter. The register, the challans and the return are all read by
     * somebody closing a period; this is used by whoever is about to
     * transfer money, and burying it two clicks inside a compliance
     * screen is most of why nobody noticed it was missing.
     *
     * ⚠️ GATED ON `tds.deductions`, the same key the register uses. A
     * workspace that may not see the register has nothing to record into.
     */
    "tds-deduct": {
      navId: "tds-deduct", label: "Record a deduction",
      description: "Ask what comes off a payment before it is made, then record what was withheld.",
      group: "money", feature: "tds.deductions", status: "live", href: "/tds/deduct",
    },
    /**
     * ⭐⭐ MULTI-CURRENCY AND FX — v1.65.0-alpha, batch 0101.
     *
     * ⚠️ GATED ON `accounting.ledger` RATHER THAN ON A GATE OF ITS OWN.
     * The restatement this screen runs posts a double-entry journal, so a
     * workspace without the ledger has nowhere for an exchange difference
     * to land. One gate for the capability and its consequence, rather
     * than two that can disagree.
     */
    fx: {
      navId: "fx",
      label: "Currency & FX",
      description:
        "Exchange rates with a direction, a date and a source; exposure by currency; and the reporting-date restatement under AS 11 / Ind AS 21.",
      group: "money",
      feature: "accounting.ledger",
      status: "live",
      href: "/fx",
    },
    /**
     * ⭐⭐⭐ WHAT IS DUE — v1.24.0-alpha, batch 16.
     *
     * ⚠️ ITS OWN NAV ENTRY RATHER THAN A TAB INSIDE GST, because it is
     * not a GST screen. It answers one question — what does this
     * business owe a government right now — across GST, both TDS
     * sections, provident fund, ESI and professional tax. Filing it
     * under GST would hide the payroll liabilities from the person who
     * pays them.
     *
     * 🔴 NO FEATURE GATE. Knowing what you owe is not a paid capability.
     * A tenant who has stopped paying us still has to pay the
     * Government, and hiding this behind a tier would be the one
     * entitlement in the product with a genuine ethical problem.
     */
    statutory_due: {
      navId: "statutory_due",
      label: "What is due",
      description:
        "Everything owed to a government this month — GST, TDS, provident fund, ESI and professional tax — from your own ledger balances, with due dates.",
      group: "money",
      feature: null,
      status: "live",
      href: "/compliance/due",
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
