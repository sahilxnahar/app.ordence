/**
 * Ordence — Industry Template Registry
 * Version: v0.3.0-alpha
 *
 * THE POLYMORPHIC UI ENGINE.
 *
 * One frontend application. Many industries. A real-estate developer sees
 * "Properties" and "Site Visits"; a legal advocate sees "Matters" and "Hearings".
 * Same code, same routes, same components — different vocabulary, navigation and
 * dashboard.
 *
 * WHY A STATIC REGISTRY, not database rows:
 *   Templates are read on EVERY request to build navigation. A database round-trip
 *   in the layout would add latency to every page load and defeat Edge rendering.
 *   These are code — versioned, type-checked, zero-cost to read. Tenant-specific
 *   *overrides* belong in the database; the base template does not.
 *
 * This module is pure data and pure functions: no imports from `db`, no Node
 * APIs. That keeps it usable from Edge middleware, server components and client
 * components alike.
 */

/* ------------------------------------------------------------------ */
/* TYPES                                                               */
/* ------------------------------------------------------------------ */

export type IndustryKey =
  | "generic"
  | "real_estate_developer"
  | "legal_advocate"
  /* ⭐ The ten verticals — Session 1, Part 2. Defined below via
   * `makeVertical()`. See docs/INDUSTRY-FEATURE-REGISTER.md. */
  | "hospitality"
  | "healthcare"
  | "logistics"
  | "trading"
  | "electricity"
  | "solar"
  | "software"
  | "small_business"
  | "financial_services"
  | "professional_services";

/** One entry in the sidebar. */
export type NavItem = {
  /** Stable id, used for permission checks and active-state matching. */
  id: string;
  label: string;
  href: string;
  /** Lucide icon name. Rendered dynamically by the sidebar. */
  icon: string;
  /** Roles allowed to see this item. Empty = everyone in the tenant. */
  roles?: readonly string[];
  /** Small count badge, resolved at render time. */
  badgeKey?: string;
};

export type NavSection = {
  id: string;
  label: string | null;
  items: readonly NavItem[];
};

/** A tile on the industry dashboard. */
export type DashboardWidget = {
  id: string;
  title: string;
  /** How the tile renders. */
  kind: "stat" | "list" | "progress" | "breakdown";
  /** Which server metric feeds it. */
  metric: string;
  /** Tailwind column span at `lg` and above. */
  span: 1 | 2 | 3 | 4;
  icon: string;
  /** Formatting hint for the value. */
  format?: "number" | "currency" | "percent" | "area";
  description?: string;
};

/**
 * Vocabulary overrides. The UI never hardcodes a noun — it asks the template.
 * `t("asset.plural")` returns "Properties" for real estate, "Matters" for legal.
 */
export type Terminology = Record<string, string>;

export type IndustryTemplate = {
  key: IndustryKey;
  label: string;
  description: string;
  /** Lucide icon representing the industry itself. */
  icon: string;
  /** Asset types this industry actually uses, in display order. */
  assetTypes: readonly string[];
  /** Default status values surfaced in filters. */
  primaryStatuses: readonly string[];
  navigation: readonly NavSection[];
  dashboard: readonly DashboardWidget[];
  terminology: Terminology;
  /** Suggested custom object definitions to seed on first login. */
  suggestedObjects: readonly {
    name: string;
    pluralName: string;
    slug: string;
    icon: string;
  }[];
};

/* ------------------------------------------------------------------ */
/* SHARED NAVIGATION                                                   */
/* ------------------------------------------------------------------ */

/** Present in every industry, so it is defined once. */
const CORE_NAV_SECTION: NavSection = {
  id: "core",
  label: null,
  items: [
    { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: "layout-dashboard" },
    { id: "search", label: "Search", href: "/search", icon: "search" },
    { id: "assistant", label: "Assistant", href: "/assistant", icon: "bot" },
  ],
};

const ADMIN_NAV_SECTION: NavSection = {
  id: "admin",
  label: "Administration",
  items: [
    {
      id: "settings",
      label: "Settings",
      href: "/settings",
      icon: "settings",
      roles: ["tenant_owner", "tenant_admin", "platform_super_admin"],
    },
    {
      id: "team",
      label: "Team",
      href: "/settings/team",
      icon: "users",
      roles: ["tenant_owner", "tenant_admin", "platform_super_admin"],
    },
    {
      id: "objects",
      label: "Custom Objects",
      href: "/settings/objects",
      icon: "shapes",
      roles: ["tenant_owner", "tenant_admin", "platform_super_admin"],
    },
    {
      /**
       * ⚠️ DELIBERATELY WIDER THAN THE OTHER ADMINISTRATION ITEMS.
       *
       * Settings, Team and Custom Objects are owner/admin work. Automations
       * is not: `workflows:read` is held by every role except `guest`, a
       * manager approves the human-in-the-loop steps, and the person who
       * has to stop a runaway automation at 6pm is rarely the person who
       * published it. Restricting this to admins would put the kill switch
       * behind the one person who is in a meeting.
       *
       * `guest` is excluded because it holds no `workflows:*` permission at
       * all — a definition names the fields, record types and external
       * endpoints a company automates against, which is a map of how the
       * business runs.
       */
      id: "automations",
      label: "Automations",
      href: "/automations",
      icon: "workflow",
      roles: [
        "platform_super_admin",
        "tenant_owner",
        "tenant_admin",
        "security_admin",
        "billing_admin",
        "manager",
        "member",
        "read_only",
      ],
    },
    {
      /**
       * ⚠️ NOT THE SAME THING AS "Custom Objects" ABOVE, AND BOTH ARE HERE
       * ON PURPOSE.
       *
       * `/settings/objects` is the Phase 2 engine: tenant-defined records
       * stored as JSONB rows in one shared table. `/objects` is the Phase
       * 24 engine: a real PostgreSQL table per record type, with typed
       * columns, real indexes and real foreign keys.
       *
       * They coexist because the first still holds customer data. Removing
       * its entry before that data has been migrated would leave records
       * that exist, are queryable and have no screen — which is worse than
       * two entries that need explaining.
       *
       * Owner/admin only: defining a record type issues DDL against the
       * shared database, and dropping one is `DROP TABLE`.
       */
      id: "record-types",
      label: "Record types",
      href: "/objects",
      icon: "table-2",
      roles: ["tenant_owner", "tenant_admin", "platform_super_admin"],
    },
  ],
};

/** Terminology every template inherits and may override. */
const BASE_TERMINOLOGY: Terminology = {
  "asset.singular": "Asset",
  "asset.plural": "Assets",
  "company.singular": "Company",
  "company.plural": "Companies",
  "contact.singular": "Contact",
  "contact.plural": "Contacts",
  "deal.singular": "Deal",
  "deal.plural": "Deals",
  "deal.value": "Deal Value",
  "deal.stage": "Stage",
  "pipeline.title": "Pipeline",
  "owner.label": "Owner",
};

/* ------------------------------------------------------------------ */
/* TEMPLATE: GENERIC                                                   */
/* ------------------------------------------------------------------ */

const GENERIC_TEMPLATE: IndustryTemplate = {
  key: "generic",
  label: "General Business",
  description: "Standard CRM for any business.",
  icon: "briefcase",
  assetTypes: ["product", "service", "custom"],
  primaryStatuses: ["available", "reserved", "inactive"],
  navigation: [
    CORE_NAV_SECTION,
    {
      id: "crm",
      label: "CRM",
      items: [
        { id: "contacts", label: "Contacts", href: "/contacts", icon: "user-round" },
        { id: "companies", label: "Companies", href: "/companies", icon: "building" },
        { id: "deals", label: "Deals", href: "/deals", icon: "handshake" },
      ],
    },
    {
      id: "catalog",
      label: "Catalog",
      items: [{ id: "assets", label: "Assets", href: "/assets", icon: "box" }],
    },
    ADMIN_NAV_SECTION,
  ],
  dashboard: [
    { id: "total-contacts", title: "Contacts", kind: "stat", metric: "contacts.total", span: 1, icon: "user-round", format: "number" },
    { id: "open-deals", title: "Open Deals", kind: "stat", metric: "deals.open", span: 1, icon: "handshake", format: "number" },
    { id: "pipeline-value", title: "Pipeline Value", kind: "stat", metric: "deals.pipelineValue", span: 1, icon: "indian-rupee", format: "currency" },
    { id: "total-assets", title: "Assets", kind: "stat", metric: "assets.total", span: 1, icon: "box", format: "number" },
    { id: "recent-deals", title: "Recent Deals", kind: "list", metric: "deals.recent", span: 2, icon: "clock" },
    { id: "stage-breakdown", title: "Deals by Stage", kind: "breakdown", metric: "deals.byStage", span: 2, icon: "chart-column" },
  ],
  terminology: BASE_TERMINOLOGY,
  suggestedObjects: [],
};

/* ------------------------------------------------------------------ */
/* TEMPLATE: REAL ESTATE DEVELOPER                                     */
/* ------------------------------------------------------------------ */

const REAL_ESTATE_TEMPLATE: IndustryTemplate = {
  key: "real_estate_developer",
  label: "Real Estate Developer",
  description:
    "Project-led development: land, towers, units, contractors and cost control.",
  icon: "building-2",
  assetTypes: ["project", "building", "unit", "plot", "property", "site"],
  primaryStatuses: [
    "planned",
    "in_progress",
    "available",
    "reserved",
    "under_offer",
    "sold",
    "leased",
  ],
  navigation: [
    CORE_NAV_SECTION,
    {
      id: "portfolio",
      label: "Portfolio",
      items: [
        { id: "projects", label: "Projects", href: "/assets?type=project", icon: "hard-hat" },
        { id: "buildings", label: "Buildings", href: "/assets?type=building", icon: "building-2" },
        { id: "units", label: "Units", href: "/assets?type=unit", icon: "door-open" },
        { id: "plots", label: "Land & Plots", href: "/assets?type=plot", icon: "map" },
        { id: "land", label: "Land & Title", href: "/land", icon: "map-pin" },
      ],
    },
    {
      id: "sales",
      label: "Sales",
      // Phase 22. These pointed at the generic CRM routes (/contacts,
      // /deals, /companies) because the real-estate surface did not
      // exist yet — a developer clicking "Bookings" landed on a deal
      // pipeline with none of the fields they needed. They now point at
      // the real thing.
      items: [
        { id: "leads", label: "Leads", href: "/sales/leads", icon: "user-round" },
        { id: "inventory", label: "Inventory", href: "/sales/inventory", icon: "door-open" },
        { id: "bookings", label: "Bookings", href: "/sales/bookings", icon: "file-signature" },
        { id: "channel-partners", label: "Channel Partners", href: "/sales/partners", icon: "handshake" },
      ],
    },
    {
      id: "delivery",
      label: "Delivery",
      items: [
        { id: "contractors", label: "Contractors", href: "/companies?type=contractor", icon: "users" },
        /*
         * ⭐ IN WORKFLOW ORDER, NOT ALPHABETICAL — v0.69.0.
         *
         * BOQ → RA Bills → Cost Control is the order the work actually
         * happens in: authorise, measure, claim, then look at what it
         * cost. A menu sorted any other way asks a site team to hold the
         * sequence in their head every time they use it.
         */
        { id: "boq", label: "BOQ", href: "/boq", icon: "file-text" },
        // ⚠️ Variations sits BETWEEN the BOQ and the bills, deliberately.
        // That is the order the work happens in: scope is agreed, scope
        // changes, and only then is the changed scope billed. A menu that
        // puts variations after billing invites the sequence people
        // actually regret — bill first, regularise later.
        { id: "variations", label: "Variations", href: "/variations", icon: "file-text" },
        { id: "site-labour", label: "Site labour", href: "/site-labour", icon: "users" },
        { id: "stock", label: "Materials", href: "/inventory", icon: "package" },
        { id: "ra-bills", label: "RA Bills", href: "/ra-bills", icon: "indian-rupee" },
        { id: "cost-control", label: "Cost Control", href: "/reports/cost", icon: "indian-rupee" },
        { id: "contracts", label: "Contracts", href: "/assets?type=contract", icon: "file-text" },
      ],
    },
    {
      id: "compliance",
      label: "Compliance",
      items: [
        { id: "compliance-board", label: "Deadlines", href: "/compliance", icon: "calendar-check" },
        { id: "licences", label: "Licences", href: "/compliance/licences", icon: "badge-check" },
      ],
    },
    {
      id: "finance",
      label: "Finance",
      items: [
        { id: "gst", label: "GST", href: "/gst", icon: "receipt" },
        { id: "gstr2b", label: "GSTR-2B", href: "/gstr2b", icon: "file-check" },
        { id: "tds", label: "TDS", href: "/tds", icon: "receipt" },
        { id: "accounting", label: "Ledger", href: "/accounting", icon: "book-open" },
        { id: "receivables", label: "Payments Due", href: "/receivables", icon: "indian-rupee" },
        { id: "purchases", label: "Purchases", href: "/purchases", icon: "shopping-cart" },
        { id: "statements", label: "Statements", href: "/statements", icon: "file-text" },
        { id: "tally", label: "Tally Export", href: "/tally", icon: "download" },
      ],
    },
    {
      id: "docs",
      label: "Documents",
      items: [
        { id: "documents", label: "Documents", href: "/documents", icon: "folder" },
      ],
    },
    ADMIN_NAV_SECTION,
  ],
  dashboard: [
    { id: "active-projects", title: "Active Projects", kind: "stat", metric: "assets.byType.project", span: 1, icon: "hard-hat", format: "number" },
    { id: "total-units", title: "Total Units", kind: "stat", metric: "assets.byType.unit", span: 1, icon: "door-open", format: "number" },
    { id: "units-sold", title: "Units Sold", kind: "stat", metric: "assets.status.sold", span: 1, icon: "circle-check", format: "number" },
    { id: "inventory-value", title: "Inventory Value", kind: "stat", metric: "assets.totalValue", span: 1, icon: "indian-rupee", format: "currency" },
    { id: "sales-velocity", title: "Booking Pipeline", kind: "breakdown", metric: "deals.byStage", span: 2, icon: "trending-up" },
    { id: "cost-variance", title: "Budget vs Committed", kind: "progress", metric: "assets.costVariance", span: 2, icon: "chart-column", description: "Across active projects" },
    { id: "saleable-area", title: "Saleable Area", kind: "stat", metric: "assets.totalArea", span: 1, icon: "ruler", format: "area" },
    { id: "contractor-count", title: "Contractors Engaged", kind: "stat", metric: "assets.contractors", span: 1, icon: "users", format: "number" },
  ],
  terminology: {
    ...BASE_TERMINOLOGY,
    "asset.singular": "Property",
    "asset.plural": "Properties",
    "contact.singular": "Lead",
    "contact.plural": "Leads",
    "company.singular": "Partner",
    "company.plural": "Partners",
    "deal.singular": "Booking",
    "deal.plural": "Bookings",
    "deal.value": "Booking Value",
    "deal.stage": "Booking Stage",
    "pipeline.title": "Sales Pipeline",
    "owner.label": "Relationship Manager",
  },
  suggestedObjects: [
    { name: "Site Visit", pluralName: "Site Visits", slug: "site-visit", icon: "map-pin" },
    { name: "Approval", pluralName: "Approvals", slug: "approval", icon: "stamp" },
    { name: "Payment Milestone", pluralName: "Payment Milestones", slug: "payment-milestone", icon: "indian-rupee" },
  ],
};

/* ------------------------------------------------------------------ */
/* TEMPLATE: LEGAL ADVOCATE                                            */
/* ------------------------------------------------------------------ */

const LEGAL_TEMPLATE: IndustryTemplate = {
  key: "legal_advocate",
  label: "Legal Advocate",
  description:
    "Matter-led practice: clients, cases, hearings, filings and time recovery.",
  icon: "scale",
  assetTypes: ["case", "matter", "contract", "policy"],
  primaryStatuses: ["draft", "in_progress", "reserved", "inactive", "archived"],
  navigation: [
    CORE_NAV_SECTION,
    {
      id: "practice",
      label: "Practice",
      /*
       * ⭐⭐ REWRITTEN IN v1.7.0. Until 0058 this section was three
       * words over one asset register: "Matters" and "Cases" both went
       * to /assets, and "Hearings" went to the generic calendar.
       *
       * 🔴 `cases` IS GONE RATHER THAN RE-POINTED. A matter and a case
       * were never two things — they were one word twice — and keeping
       * both would leave a menu entry that quietly means nothing.
       *
       * ⚠️ `hearings` IS GONE TOO, because a hearing only means anything
       * against the matter it belongs to. The question a clerk asks at
       * eight in the morning is "what is listed today", and the matters
       * screen answers it directly.
       */
      items: [
        { id: "matters", label: "Matters", href: "/legal/matters", icon: "gavel" },
        { id: "contracts", label: "Contracts", href: "/assets?type=contract", icon: "file-text" },
        { id: "time", label: "Time & Billing", href: "/time", icon: "clock" },
        { id: "client-account", label: "Client Account", href: "/legal/client-account", icon: "landmark" },
      ],
    },
    {
      id: "clients",
      label: "Clients",
      items: [
        { id: "clients", label: "Clients", href: "/contacts", icon: "user-round" },
        { id: "organisations", label: "Organisations", href: "/companies", icon: "building" },
        { id: "engagements", label: "Engagements", href: "/deals", icon: "briefcase" },
      ],
    },
    {
      id: "practice-mgmt",
      label: "Practice Management",
      items: [
        { id: "documents", label: "Documents", href: "/documents", icon: "folder" },
        { id: "billing", label: "Billing", href: "/billing", icon: "receipt" },
      ],
    },
    ADMIN_NAV_SECTION,
  ],
  dashboard: [
    { id: "active-matters", title: "Active Matters", kind: "stat", metric: "assets.byType.matter", span: 1, icon: "gavel", format: "number" },
    { id: "open-cases", title: "Open Cases", kind: "stat", metric: "assets.byType.case", span: 1, icon: "scale", format: "number" },
    { id: "clients-count", title: "Clients", kind: "stat", metric: "contacts.total", span: 1, icon: "user-round", format: "number" },
    { id: "billed-value", title: "Engagement Value", kind: "stat", metric: "deals.pipelineValue", span: 1, icon: "indian-rupee", format: "currency" },
    { id: "upcoming-hearings", title: "Upcoming Hearings", kind: "list", metric: "assets.upcoming", span: 2, icon: "calendar-days" },
    { id: "matter-stage", title: "Matters by Stage", kind: "breakdown", metric: "assets.byStatus", span: 2, icon: "chart-column" },
  ],
  terminology: {
    ...BASE_TERMINOLOGY,
    "asset.singular": "Matter",
    "asset.plural": "Matters",
    "contact.singular": "Client",
    "contact.plural": "Clients",
    "company.singular": "Organisation",
    "company.plural": "Organisations",
    "deal.singular": "Engagement",
    "deal.plural": "Engagements",
    "deal.value": "Engagement Value",
    "deal.stage": "Matter Stage",
    "pipeline.title": "Matter Pipeline",
    "owner.label": "Responsible Advocate",
  },
  suggestedObjects: [
    { name: "Hearing", pluralName: "Hearings", slug: "hearing", icon: "calendar-days" },
    { name: "Filing", pluralName: "Filings", slug: "filing", icon: "file-plus" },
    { name: "Time Entry", pluralName: "Time Entries", slug: "time-entry", icon: "clock" },
  ],
};

/* ------------------------------------------------------------------ */
/* REGISTRY & LOOKUP                                                   */
/* ------------------------------------------------------------------ */

/* ══════════════════════════════════════════════════════════════════════
 * ⭐ THE TEN VERTICALS — Session 1, Part 2 · v0.58.0
 * ══════════════════════════════════════════════════════════════════════
 *
 * Ten industries, defined through one builder rather than ten copies of
 * the same eighty lines.
 *
 * ⚠️ THE BUILDER IS NOT A TIDINESS EXERCISE. Written out longhand, these
 * ten templates would be ~800 lines of near-identical structure, and the
 * eleventh vertical would be written by copying the tenth. That is how a
 * "generic" section ends up subtly different in three industries and
 * nobody notices until a customer asks why their Settings menu is missing
 * an item. `makeVertical()` makes the SHARED parts unforkable and leaves
 * only the genuinely different parts visible — which is also what makes
 * the differences reviewable.
 *
 * ⚠️ AND VOCABULARY IS NOT CAPABILITY. A hotel's "Rooms" and a hospital's
 * "Beds" are the same scheduling engine wearing two words. The nav item
 * ids below therefore point at SHARED module ids from the registry
 * (`scheduling`, `rates`, `field-jobs`), never at industry-specific ones.
 * Three ids for one engine would mean three code paths and three bugs.
 * See docs/INDUSTRY-FEATURE-REGISTER.md, Part 4.
 */

type VerticalSpec = {
  key: IndustryKey;
  label: string;
  description: string;
  icon: string;
  assetTypes: readonly string[];
  primaryStatuses: readonly string[];
  /** Sections between Home and Administration. */
  sections: readonly NavSection[];
  dashboard: readonly DashboardWidget[];
  terminology: Terminology;
  suggestedObjects: IndustryTemplate["suggestedObjects"];
};

/**
 * Wraps a vertical's own sections in the shared Home and Administration
 * blocks, so no industry can accidentally lose Settings or Search.
 */
function makeVertical(spec: VerticalSpec): IndustryTemplate {
  return {
    key: spec.key,
    label: spec.label,
    description: spec.description,
    icon: spec.icon,
    assetTypes: spec.assetTypes,
    primaryStatuses: spec.primaryStatuses,
    navigation: [CORE_NAV_SECTION, ...spec.sections, ADMIN_NAV_SECTION],
    dashboard: spec.dashboard,
    terminology: { ...BASE_TERMINOLOGY, ...spec.terminology },
    suggestedObjects: spec.suggestedObjects,
  };
}

/** Present in every vertical that has statutory obligations — all ten. */
const COMPLIANCE_NAV_SECTION: NavSection = {
  id: "compliance",
  label: "Compliance",
  items: [
    { id: "compliance-board", label: "Deadlines", href: "/compliance", icon: "calendar-check" },
    { id: "licences", label: "Licences", href: "/compliance/licences", icon: "badge-check" },
  ],
};

/**
 * Present in every vertical that files GST, deducts TDS and keeps books —
 * which is every vertical. The same five modules, in the same order, so
 * that the finance tab is muscle memory regardless of industry.
 */
const FINANCE_NAV_SECTION: NavSection = {
  id: "finance",
  label: "Finance",
  items: [
    { id: "gst", label: "GST", href: "/gst", icon: "receipt" },
    { id: "gstr2b", label: "GSTR-2B", href: "/gstr2b", icon: "file-check" },
    { id: "tds", label: "TDS", href: "/tds", icon: "receipt" },
    { id: "accounting", label: "Ledger", href: "/accounting", icon: "book-open" },
    { id: "tally", label: "Tally Export", href: "/tally", icon: "download" },
  ],
};

/** Documents — present in every vertical. */
const DOCS_NAV_SECTION: NavSection = {
  id: "docs",
  label: "Documents",
  items: [
    { id: "documents", label: "Documents", href: "/documents", icon: "folder" },
  ],
};

/* ---- 1 · HOSPITALITY ---------------------------------------------- */

const HOSPITALITY_TEMPLATE = makeVertical({
  key: "hospitality",
  label: "Hospitality",
  description: "Hotels, resorts and restaurants: rooms, rates, folios and covers.",
  icon: "bed-double",
  assetTypes: ["property", "room", "hall", "outlet", "table"],
  primaryStatuses: ["available", "reserved", "occupied", "dirty", "out_of_order", "blocked"],
  sections: [
    {
      id: "front-office",
      label: "Front Office",
      items: [
        { id: "scheduling", label: "Reservations", href: "/scheduling", icon: "calendar-days" },
        { id: "arrivals", label: "Arrivals & Departures", href: "/scheduling?view=today", icon: "door-open" },
        { id: "guests", label: "Guests", href: "/contacts", icon: "user-round" },
        { id: "housekeeping", label: "Housekeeping", href: "/field-jobs?type=housekeeping", icon: "sparkles" },
      ],
    },
    {
      id: "revenue",
      label: "Revenue",
      items: [
        { id: "rates", label: "Rates & Availability", href: "/rates", icon: "indian-rupee" },
        { id: "assets", label: "Rooms & Outlets", href: "/assets", icon: "bed-double" },
        { id: "orders", label: "Bills & Folios", href: "/orders", icon: "receipt" },
        { id: "receivables", label: "Payments Due", href: "/receivables", icon: "hand-coins" },
      ],
    },
    FINANCE_NAV_SECTION,
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "occupancy", title: "Occupancy", kind: "stat", metric: "scheduling.utilisation", span: 1, icon: "percent", format: "percent" },
    { id: "adr", title: "Average Rate", kind: "stat", metric: "rates.average", span: 1, icon: "indian-rupee", format: "currency" },
    { id: "revpar", title: "RevPAR", kind: "stat", metric: "rates.revpar", span: 1, icon: "trending-up", format: "currency", description: "Revenue per available room" },
    { id: "arrivals-today", title: "Arrivals Today", kind: "stat", metric: "scheduling.arrivals", span: 1, icon: "door-open", format: "number" },
    { id: "pickup", title: "Booking Pace", kind: "breakdown", metric: "scheduling.byChannel", span: 2, icon: "chart-column" },
    { id: "rooms-status", title: "Room Status", kind: "breakdown", metric: "assets.byStatus", span: 2, icon: "bed-double" },
  ],
  terminology: {
    "asset.singular": "Room", "asset.plural": "Rooms",
    "contact.singular": "Guest", "contact.plural": "Guests",
    "deal.singular": "Reservation", "deal.plural": "Reservations",
    "order.singular": "Folio", "order.plural": "Folios",
    "owner.label": "Front Office Manager",
  },
  suggestedObjects: [
    { name: "Housekeeping Task", pluralName: "Housekeeping Tasks", slug: "housekeeping-task", icon: "sparkles" },
    { name: "Guest Request", pluralName: "Guest Requests", slug: "guest-request", icon: "concierge-bell" },
    { name: "Banquet Event", pluralName: "Banquet Events", slug: "banquet-event", icon: "party-popper" },
  ],
});

/* ---- 2 · HEALTHCARE ------------------------------------------------ */

const HEALTHCARE_TEMPLATE = makeVertical({
  key: "healthcare",
  label: "Hospitals & Clinics",
  description: "Patients, appointments, beds and the revenue cycle — clinical data kept separate.",
  icon: "stethoscope",
  assetTypes: ["bed", "ward", "theatre", "equipment", "ambulance"],
  primaryStatuses: ["available", "occupied", "reserved", "cleaning", "maintenance"],
  sections: [
    {
      id: "clinical",
      label: "Care",
      items: [
        { id: "patients", label: "Patients", href: "/contacts", icon: "user-round" },
        { id: "scheduling", label: "Appointments", href: "/scheduling", icon: "calendar-days" },
        { id: "beds", label: "Beds & Wards", href: "/assets?type=bed", icon: "bed" },
        { id: "field-jobs", label: "Rounds & Home Care", href: "/field-jobs", icon: "clipboard-list" },
      ],
    },
    {
      id: "revenue-cycle",
      label: "Billing",
      items: [
        { id: "orders", label: "Bills", href: "/orders", icon: "receipt" },
        { id: "receivables", label: "Claims & Dues", href: "/receivables", icon: "hand-coins" },
        { id: "inventory", label: "Pharmacy & Stores", href: "/inventory", icon: "pill" },
        { id: "rates", label: "Tariff", href: "/rates", icon: "indian-rupee" },
      ],
    },
    FINANCE_NAV_SECTION,
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "beds-occupied", title: "Bed Occupancy", kind: "stat", metric: "scheduling.utilisation", span: 1, icon: "bed", format: "percent" },
    { id: "appointments-today", title: "Appointments Today", kind: "stat", metric: "scheduling.today", span: 1, icon: "calendar-days", format: "number" },
    { id: "admissions", title: "Admissions", kind: "stat", metric: "scheduling.admissions", span: 1, icon: "door-open", format: "number" },
    { id: "claims-pending", title: "Claims Pending", kind: "stat", metric: "receivables.pending", span: 1, icon: "hand-coins", format: "currency" },
    { id: "dept-load", title: "Load by Department", kind: "breakdown", metric: "scheduling.byResource", span: 2, icon: "chart-column" },
    { id: "expiring-stock", title: "Expiring Stock", kind: "list", metric: "inventory.expiring", span: 2, icon: "pill" },
  ],
  terminology: {
    "asset.singular": "Bed", "asset.plural": "Beds",
    "contact.singular": "Patient", "contact.plural": "Patients",
    "company.singular": "Payer", "company.plural": "Payers",
    "deal.singular": "Episode", "deal.plural": "Episodes",
    "owner.label": "Consultant",
  },
  suggestedObjects: [
    { name: "Admission", pluralName: "Admissions", slug: "admission", icon: "door-open" },
    { name: "Investigation", pluralName: "Investigations", slug: "investigation", icon: "flask-conical" },
    { name: "Pre-Authorisation", pluralName: "Pre-Authorisations", slug: "pre-auth", icon: "shield-check" },
  ],
});

/* ---- 3 · LOGISTICS ------------------------------------------------- */

const LOGISTICS_TEMPLATE = makeVertical({
  key: "logistics",
  label: "Logistics & Transport",
  description: "Consignments, fleet, trips and the e-way bill.",
  icon: "truck",
  assetTypes: ["vehicle", "trailer", "warehouse", "container"],
  primaryStatuses: ["idle", "loading", "in_transit", "delivered", "maintenance", "detained"],
  sections: [
    {
      id: "operations",
      label: "Operations",
      items: [
        { id: "consignments", label: "Consignments", href: "/orders", icon: "package" },
        { id: "scheduling", label: "Trips & Dispatch", href: "/scheduling", icon: "calendar-days" },
        { id: "field-jobs", label: "Pickups & Deliveries", href: "/field-jobs", icon: "map-pin" },
        { id: "assets", label: "Fleet", href: "/assets?type=vehicle", icon: "truck" },
      ],
    },
    {
      id: "commercial",
      label: "Commercial",
      items: [
        { id: "companies", label: "Customers", href: "/companies", icon: "building-2" },
        { id: "rates", label: "Freight Rates", href: "/rates", icon: "indian-rupee" },
        { id: "receivables", label: "Payments Due", href: "/receivables", icon: "hand-coins" },
        { id: "inventory", label: "Warehouse Stock", href: "/inventory", icon: "boxes" },
      ],
    },
    FINANCE_NAV_SECTION,
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "in-transit", title: "In Transit", kind: "stat", metric: "orders.inTransit", span: 1, icon: "truck", format: "number" },
    { id: "fleet-util", title: "Fleet Utilisation", kind: "stat", metric: "scheduling.utilisation", span: 1, icon: "percent", format: "percent" },
    { id: "delivered-today", title: "Delivered Today", kind: "stat", metric: "field.completedToday", span: 1, icon: "circle-check", format: "number" },
    { id: "detention", title: "Detention Hours", kind: "stat", metric: "field.detentionHours", span: 1, icon: "clock", format: "number", description: "Billable and usually unbilled" },
    { id: "lane-revenue", title: "Revenue by Lane", kind: "breakdown", metric: "orders.byRoute", span: 2, icon: "route" },
    { id: "expiring-docs", title: "Expiring Vehicle Documents", kind: "list", metric: "compliance.licencesDue", span: 2, icon: "badge-alert" },
  ],
  terminology: {
    "asset.singular": "Vehicle", "asset.plural": "Fleet",
    "contact.singular": "Consignee", "contact.plural": "Consignees",
    "company.singular": "Shipper", "company.plural": "Shippers",
    "order.singular": "Consignment", "order.plural": "Consignments",
    "owner.label": "Operations Manager",
  },
  suggestedObjects: [
    { name: "Trip Sheet", pluralName: "Trip Sheets", slug: "trip-sheet", icon: "route" },
    { name: "Driver", pluralName: "Drivers", slug: "driver", icon: "id-card" },
    { name: "Claim", pluralName: "Claims", slug: "claim", icon: "triangle-alert" },
  ],
});

/* ---- 4 · TRADING & DISTRIBUTION ------------------------------------ */

const TRADING_TEMPLATE = makeVertical({
  key: "trading",
  label: "Trading & Distribution",
  description: "Buy, hold, sell: stock, margin, credit and GST end to end.",
  icon: "boxes",
  assetTypes: ["warehouse", "vehicle", "equipment"],
  primaryStatuses: ["in_stock", "reserved", "in_transit", "sold", "returned", "damaged"],
  sections: [
    {
      id: "trade",
      label: "Trade",
      items: [
        { id: "orders", label: "Sales Orders", href: "/orders", icon: "shopping-cart" },
        { id: "purchases", label: "Purchases", href: "/purchases", icon: "truck" },
        { id: "inventory", label: "Stock", href: "/inventory", icon: "boxes" },
        { id: "rates", label: "Price Lists", href: "/rates", icon: "indian-rupee" },
        { id: "companies", label: "Accounts", href: "/companies", icon: "building-2" },
        { id: "contacts", label: "Buyers", href: "/contacts", icon: "user-round" },
      ],
    },
    {
      id: "money",
      label: "Money",
      items: [
        { id: "receivables", label: "Payments Due", href: "/receivables", icon: "hand-coins" },
        { id: "statements", label: "Statements", href: "/statements", icon: "file-text" },
        { id: "gst", label: "GST", href: "/gst", icon: "landmark" },
        { id: "gstr2b", label: "GSTR-2B", href: "/gstr2b", icon: "file-check" },
        { id: "tds", label: "TDS", href: "/tds", icon: "scissors" },
        { id: "accounting", label: "Ledger", href: "/accounting", icon: "book-open" },
        { id: "tally", label: "Tally Export", href: "/tally", icon: "download" },
      ],
    },
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "stock-value", title: "Stock Value", kind: "stat", metric: "inventory.value", span: 1, icon: "boxes", format: "currency" },
    { id: "orders-open", title: "Open Orders", kind: "stat", metric: "orders.open", span: 1, icon: "shopping-cart", format: "number" },
    { id: "overdue", title: "Overdue", kind: "stat", metric: "receivables.overdue", span: 1, icon: "hand-coins", format: "currency" },
    { id: "margin", title: "Gross Margin", kind: "stat", metric: "orders.margin", span: 1, icon: "percent", format: "percent" },
    { id: "top-items", title: "Top Items by Margin", kind: "list", metric: "orders.topItems", span: 2, icon: "trending-up" },
    { id: "dead-stock", title: "Slow & Dead Stock", kind: "list", metric: "inventory.ageing", span: 2, icon: "clock" },
  ],
  terminology: {
    "asset.singular": "Warehouse", "asset.plural": "Warehouses",
    "contact.singular": "Buyer", "contact.plural": "Buyers",
    "company.singular": "Account", "company.plural": "Accounts",
    "owner.label": "Sales Manager",
  },
  suggestedObjects: [
    { name: "Scheme", pluralName: "Schemes", slug: "scheme", icon: "tag" },
    { name: "Beat Plan", pluralName: "Beat Plans", slug: "beat-plan", icon: "map" },
    { name: "Quality Check", pluralName: "Quality Checks", slug: "quality-check", icon: "clipboard-check" },
  ],
});

/* ---- 5 · ELECTRICITY ----------------------------------------------- */

const ELECTRICITY_TEMPLATE = makeVertical({
  key: "electricity",
  label: "Electricity & Utilities",
  description: "Connections, meters, slab tariffs and network losses.",
  icon: "zap",
  assetTypes: ["meter", "transformer", "feeder", "substation", "line"],
  primaryStatuses: ["energised", "disconnected", "under_installation", "faulty", "decommissioned"],
  sections: [
    {
      id: "supply",
      label: "Supply",
      items: [
        { id: "consumers", label: "Consumers", href: "/contacts", icon: "user-round" },
        { id: "meters", label: "Meters", href: "/meters", icon: "gauge" },
        { id: "readings", label: "Readings", href: "/meters/readings", icon: "activity" },
        { id: "assets", label: "Network", href: "/assets", icon: "zap" },
      ],
    },
    {
      id: "billing",
      label: "Billing",
      items: [
        { id: "rates", label: "Tariffs", href: "/rates", icon: "indian-rupee" },
        { id: "orders", label: "Bills", href: "/orders", icon: "receipt" },
        { id: "receivables", label: "Collections", href: "/receivables", icon: "hand-coins" },
        { id: "field-jobs", label: "Site Work", href: "/field-jobs", icon: "hard-hat" },
      ],
    },
    FINANCE_NAV_SECTION,
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "units-billed", title: "Units Billed", kind: "stat", metric: "metering.unitsBilled", span: 1, icon: "zap", format: "number" },
    { id: "collection-eff", title: "Collection Efficiency", kind: "stat", metric: "receivables.efficiency", span: 1, icon: "percent", format: "percent" },
    { id: "atc-loss", title: "AT&C Loss", kind: "stat", metric: "metering.atcLoss", span: 1, icon: "trending-down", format: "percent", description: "The number that defines a distribution business" },
    { id: "connections", title: "Active Connections", kind: "stat", metric: "metering.activeMeters", span: 1, icon: "gauge", format: "number" },
    { id: "load-profile", title: "Consumption by Category", kind: "breakdown", metric: "metering.byCategory", span: 2, icon: "chart-column" },
    { id: "anomalies", title: "Reading Anomalies", kind: "list", metric: "metering.anomalies", span: 2, icon: "triangle-alert" },
  ],
  terminology: {
    "asset.singular": "Asset", "asset.plural": "Network Assets",
    "contact.singular": "Consumer", "contact.plural": "Consumers",
    "order.singular": "Bill", "order.plural": "Bills",
    "owner.label": "Section Officer",
  },
  suggestedObjects: [
    { name: "Connection Request", pluralName: "Connection Requests", slug: "connection-request", icon: "plug" },
    { name: "Outage", pluralName: "Outages", slug: "outage", icon: "power-off" },
    { name: "Theft Case", pluralName: "Theft Cases", slug: "theft-case", icon: "triangle-alert" },
  ],
});

/* ---- 6 · SOLAR & RENEWABLES ---------------------------------------- */

const SOLAR_TEMPLATE = makeVertical({
  key: "solar",
  label: "Solar & Renewables",
  description: "A 25-year promise: design, install, and prove generation for a decade after.",
  icon: "sun",
  assetTypes: ["plant", "inverter", "string", "meter", "battery"],
  primaryStatuses: ["surveyed", "designed", "under_installation", "commissioned", "under_maintenance", "faulty"],
  sections: [
    {
      id: "projects",
      label: "Projects",
      items: [
        { id: "deals", label: "Enquiries", href: "/sales/leads", icon: "user-round" },
        { id: "assets", label: "Plants", href: "/assets?type=plant", icon: "sun" },
        { id: "field-jobs", label: "Site Work & O&M", href: "/field-jobs", icon: "hard-hat" },
        { id: "scheduling", label: "Service Schedule", href: "/scheduling", icon: "calendar-days" },
      ],
    },
    {
      id: "generation",
      label: "Generation",
      items: [
        { id: "meters", label: "Generation Meters", href: "/meters", icon: "gauge" },
        { id: "readings", label: "Output", href: "/meters/readings", icon: "activity" },
        { id: "orders", label: "Invoices", href: "/orders", icon: "receipt" },
        { id: "inventory", label: "Panels & Spares", href: "/inventory", icon: "boxes" },
      ],
    },
    FINANCE_NAV_SECTION,
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "capacity", title: "Installed Capacity", kind: "stat", metric: "assets.capacity", span: 1, icon: "sun", format: "number" },
    { id: "generation-mtd", title: "Generation MTD", kind: "stat", metric: "metering.generation", span: 1, icon: "zap", format: "number" },
    { id: "perf-ratio", title: "Performance Ratio", kind: "stat", metric: "metering.performanceRatio", span: 1, icon: "percent", format: "percent", description: "Actual against the warranty curve" },
    { id: "sites-live", title: "Sites Live", kind: "stat", metric: "assets.commissioned", span: 1, icon: "circle-check", format: "number" },
    { id: "actual-vs-est", title: "Actual vs Estimated", kind: "progress", metric: "metering.actualVsEstimate", span: 2, icon: "chart-column" },
    { id: "underperformers", title: "Underperforming Sites", kind: "list", metric: "metering.underperforming", span: 2, icon: "trending-down" },
  ],
  terminology: {
    "asset.singular": "Plant", "asset.plural": "Plants",
    "contact.singular": "Customer", "contact.plural": "Customers",
    "deal.singular": "Project", "deal.plural": "Projects",
    "owner.label": "Project Engineer",
  },
  suggestedObjects: [
    { name: "Site Survey", pluralName: "Site Surveys", slug: "site-survey", icon: "map-pin" },
    { name: "Subsidy Claim", pluralName: "Subsidy Claims", slug: "subsidy-claim", icon: "landmark" },
    { name: "Warranty Claim", pluralName: "Warranty Claims", slug: "warranty-claim", icon: "shield-check" },
  ],
});

/* ---- 7 · IT & SOFTWARE --------------------------------------------- */

const SOFTWARE_TEMPLATE = makeVertical({
  key: "software",
  label: "IT & Software",
  description: "Projects, timesheets, utilisation and subscription revenue.",
  icon: "code",
  assetTypes: ["product", "environment", "licence", "equipment"],
  primaryStatuses: ["planned", "in_progress", "in_review", "delivered", "on_hold", "cancelled"],
  sections: [
    {
      id: "delivery",
      label: "Delivery",
      items: [
        { id: "projects", label: "Projects", href: "/assets?type=project", icon: "kanban" },
        { id: "timesheets", label: "Timesheets", href: "/timesheets", icon: "clock" },
        { id: "scheduling", label: "Resourcing", href: "/scheduling", icon: "calendar-days" },
        { id: "contracts", label: "Contracts", href: "/contracts", icon: "file-text" },
      ],
    },
    {
      id: "commercial",
      label: "Commercial",
      items: [
        { id: "companies", label: "Clients", href: "/companies", icon: "building-2" },
        { id: "deals", label: "Pipeline", href: "/sales/leads", icon: "trending-up" },
        { id: "orders", label: "Invoices", href: "/orders", icon: "receipt" },
        { id: "receivables", label: "Payments Due", href: "/receivables", icon: "hand-coins" },
      ],
    },
    FINANCE_NAV_SECTION,
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "utilisation", title: "Utilisation", kind: "stat", metric: "timesheets.utilisation", span: 1, icon: "percent", format: "percent" },
    { id: "billable-hours", title: "Billable Hours", kind: "stat", metric: "timesheets.billable", span: 1, icon: "clock", format: "number" },
    { id: "realisation", title: "Realisation Rate", kind: "stat", metric: "timesheets.realisation", span: 1, icon: "trending-up", format: "percent", description: "Billed against worked" },
    { id: "mrr", title: "MRR", kind: "stat", metric: "billing.mrr", span: 1, icon: "indian-rupee", format: "currency" },
    { id: "project-margin", title: "Project Profitability", kind: "breakdown", metric: "projects.margin", span: 2, icon: "chart-column" },
    { id: "bench", title: "Bench", kind: "list", metric: "scheduling.unallocated", span: 2, icon: "users" },
  ],
  terminology: {
    "asset.singular": "Project", "asset.plural": "Projects",
    "contact.singular": "Contact", "contact.plural": "Contacts",
    "company.singular": "Client", "company.plural": "Clients",
    "deal.singular": "Opportunity", "deal.plural": "Opportunities",
    "owner.label": "Account Manager",
  },
  suggestedObjects: [
    { name: "Sprint", pluralName: "Sprints", slug: "sprint", icon: "kanban" },
    { name: "Change Request", pluralName: "Change Requests", slug: "change-request", icon: "git-pull-request" },
    { name: "SLA Incident", pluralName: "SLA Incidents", slug: "sla-incident", icon: "triangle-alert" },
  ],
});

/* ---- 8 · SMALL BUSINESS -------------------------------------------- */

/**
 * ⚠️ DELIBERATELY THE SHORTEST TEMPLATE IN THE FILE.
 *
 * An SME owner abandons anything that takes more than an afternoon to
 * start using. For this vertical, HIDING what they do not need is the
 * product — so the temptation to add "just one more useful section" is
 * the thing to resist. Four sections, nothing else.
 */
const SMALL_BUSINESS_TEMPLATE = makeVertical({
  key: "small_business",
  label: "Small Business",
  description: "Invoice, stock, payments. Nothing else in the way.",
  icon: "store",
  assetTypes: ["equipment", "vehicle", "property"],
  primaryStatuses: ["active", "inactive"],
  sections: [
    {
      id: "daily",
      label: "Daily",
      items: [
        { id: "orders", label: "Invoices", href: "/orders", icon: "receipt" },
        { id: "contacts", label: "Customers", href: "/contacts", icon: "user-round" },
        { id: "inventory", label: "Stock", href: "/inventory", icon: "boxes" },
        { id: "receivables", label: "Who Owes Me", href: "/receivables", icon: "hand-coins" },
      ],
    },
    {
      id: "money",
      label: "Money",
      items: [
        { id: "purchases", label: "Purchases", href: "/purchases", icon: "truck" },
        { id: "gst", label: "GST", href: "/gst", icon: "landmark" },
        { id: "compliance-board", label: "Deadlines", href: "/compliance", icon: "calendar-check" },
      ],
    },
  ],
  dashboard: [
    { id: "sales-today", title: "Sales Today", kind: "stat", metric: "orders.today", span: 1, icon: "indian-rupee", format: "currency" },
    { id: "owed", title: "Owed to Me", kind: "stat", metric: "receivables.outstanding", span: 1, icon: "hand-coins", format: "currency" },
    { id: "stock-value", title: "Stock Value", kind: "stat", metric: "inventory.value", span: 1, icon: "boxes", format: "currency" },
    { id: "due-soon", title: "Filings Due", kind: "stat", metric: "compliance.dueSoon", span: 1, icon: "calendar-check", format: "number" },
    { id: "top-customers", title: "Top Customers", kind: "list", metric: "orders.topCustomers", span: 2, icon: "users" },
  ],
  terminology: {
    "asset.singular": "Item", "asset.plural": "Items",
    "contact.singular": "Customer", "contact.plural": "Customers",
    "order.singular": "Invoice", "order.plural": "Invoices",
    "owner.label": "Owner",
  },
  suggestedObjects: [
    { name: "Expense", pluralName: "Expenses", slug: "expense", icon: "wallet" },
  ],
});

/* ---- 9 · FINANCIAL SERVICES ---------------------------------------- */

const FINANCE_TEMPLATE = makeVertical({
  key: "financial_services",
  label: "Financial Services",
  description: "Lending, broking and wealth — where auditability is the product.",
  icon: "landmark",
  assetTypes: ["product", "scheme", "portfolio", "collateral"],
  primaryStatuses: ["applied", "under_review", "sanctioned", "disbursed", "closed", "npa", "rejected"],
  sections: [
    {
      id: "clients",
      label: "Clients",
      items: [
        { id: "contacts", label: "Clients", href: "/contacts", icon: "user-round" },
        { id: "companies", label: "Entities", href: "/companies", icon: "building-2" },
        { id: "deals", label: "Applications", href: "/sales/leads", icon: "file-signature" },
        { id: "contracts", label: "Agreements", href: "/contracts", icon: "file-text" },
      ],
    },
    {
      id: "book",
      label: "Book",
      items: [
        { id: "receivables", label: "Repayments", href: "/receivables", icon: "hand-coins" },
        { id: "statements", label: "Statements", href: "/statements", icon: "file-text" },
        { id: "gst", label: "GST", href: "/gst", icon: "receipt" },
        { id: "gstr2b", label: "GSTR-2B", href: "/gstr2b", icon: "file-check" },
        { id: "tds", label: "TDS", href: "/tds", icon: "scissors" },
        { id: "accounting", label: "Ledger", href: "/accounting", icon: "book-open" },
        { id: "tally", label: "Tally Export", href: "/tally", icon: "download" },
      ],
    },
    COMPLIANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "aum", title: "Book Size", kind: "stat", metric: "receivables.principal", span: 1, icon: "landmark", format: "currency" },
    { id: "collections", title: "Collections MTD", kind: "stat", metric: "receivables.collected", span: 1, icon: "hand-coins", format: "currency" },
    { id: "npa", title: "NPA %", kind: "stat", metric: "receivables.npaRatio", span: 1, icon: "triangle-alert", format: "percent" },
    { id: "disbursed", title: "Disbursed MTD", kind: "stat", metric: "deals.disbursed", span: 1, icon: "trending-up", format: "currency" },
    { id: "ageing", title: "Overdue Ageing", kind: "breakdown", metric: "receivables.ageing", span: 2, icon: "chart-column" },
    { id: "kyc-pending", title: "KYC Pending", kind: "list", metric: "contacts.kycPending", span: 2, icon: "shield-alert" },
  ],
  terminology: {
    "asset.singular": "Product", "asset.plural": "Products",
    "contact.singular": "Client", "contact.plural": "Clients",
    "deal.singular": "Application", "deal.plural": "Applications",
    "owner.label": "Relationship Manager",
  },
  suggestedObjects: [
    { name: "KYC Record", pluralName: "KYC Records", slug: "kyc-record", icon: "id-card" },
    { name: "Collateral", pluralName: "Collateral", slug: "collateral", icon: "shield" },
    { name: "Collection Visit", pluralName: "Collection Visits", slug: "collection-visit", icon: "map-pin" },
  ],
});

/* ---- 10 · PROFESSIONAL SERVICES ------------------------------------ */

/**
 * ⚠️ THE ONLY VERTICAL WHERE COMPLIANCE IS THE FIRST SECTION, NOT THE
 * LAST. For a CA or CS firm the deadline board IS the product — every
 * other screen exists to feed it. Ordering it below "Clients" would be
 * technically consistent and practically wrong.
 */
const PROFESSIONAL_TEMPLATE = makeVertical({
  key: "professional_services",
  label: "Professional Services",
  description: "CA, CS and consulting: client deadlines, WIP and sign-off.",
  icon: "briefcase",
  assetTypes: ["engagement", "matter", "filing"],
  primaryStatuses: ["not_started", "in_progress", "with_client", "under_review", "filed", "closed"],
  sections: [
    {
      id: "compliance",
      label: "Compliance",
      items: [
        { id: "compliance-board", label: "Deadlines", href: "/compliance", icon: "calendar-check" },
        { id: "licences", label: "Registrations", href: "/compliance/licences", icon: "badge-check" },
      ],
    },
    {
      id: "practice",
      label: "Practice",
      items: [
        { id: "companies", label: "Clients", href: "/companies", icon: "building-2" },
        { id: "contacts", label: "Contacts", href: "/contacts", icon: "user-round" },
        { id: "timesheets", label: "Timesheets", href: "/timesheets", icon: "clock" },
        { id: "scheduling", label: "Workload", href: "/scheduling", icon: "calendar-days" },
      ],
    },
    {
      id: "billing",
      label: "Billing",
      items: [
        { id: "orders", label: "Invoices", href: "/orders", icon: "receipt" },
        { id: "receivables", label: "Payments Due", href: "/receivables", icon: "hand-coins" },
        { id: "contracts", label: "Engagements", href: "/contracts", icon: "file-text" },
      ],
    },
    FINANCE_NAV_SECTION,
    DOCS_NAV_SECTION,
  ],
  dashboard: [
    { id: "due-week", title: "Due This Week", kind: "stat", metric: "compliance.dueSoon", span: 1, icon: "calendar-check", format: "number" },
    { id: "overdue-filings", title: "Overdue", kind: "stat", metric: "compliance.overdue", span: 1, icon: "triangle-alert", format: "number" },
    { id: "exposure", title: "Late-Fee Exposure", kind: "stat", metric: "compliance.exposure", span: 1, icon: "indian-rupee", format: "currency", description: "What lateness costs if nothing changes" },
    { id: "wip", title: "Unbilled WIP", kind: "stat", metric: "timesheets.wip", span: 1, icon: "clock", format: "currency" },
    { id: "by-authority", title: "Filings by Authority", kind: "breakdown", metric: "compliance.byAuthority", span: 2, icon: "chart-column" },
    { id: "client-risk", title: "Clients at Risk", kind: "list", metric: "compliance.clientRisk", span: 2, icon: "shield-alert" },
  ],
  terminology: {
    "asset.singular": "Engagement", "asset.plural": "Engagements",
    "contact.singular": "Contact", "contact.plural": "Contacts",
    "company.singular": "Client", "company.plural": "Clients",
    "deal.singular": "Engagement", "deal.plural": "Engagements",
    "owner.label": "Engagement Partner",
  },
  suggestedObjects: [
    { name: "Filing", pluralName: "Filings", slug: "filing", icon: "file-check" },
    { name: "Query", pluralName: "Queries", slug: "query", icon: "message-circle-question" },
    { name: "DSC", pluralName: "DSCs", slug: "dsc", icon: "key-round" },
  ],
});


export const INDUSTRY_TEMPLATES: Readonly<Record<IndustryKey, IndustryTemplate>> = {
  hospitality: HOSPITALITY_TEMPLATE,
  healthcare: HEALTHCARE_TEMPLATE,
  logistics: LOGISTICS_TEMPLATE,
  trading: TRADING_TEMPLATE,
  electricity: ELECTRICITY_TEMPLATE,
  solar: SOLAR_TEMPLATE,
  software: SOFTWARE_TEMPLATE,
  small_business: SMALL_BUSINESS_TEMPLATE,
  financial_services: FINANCE_TEMPLATE,
  professional_services: PROFESSIONAL_TEMPLATE,
  generic: GENERIC_TEMPLATE,
  real_estate_developer: REAL_ESTATE_TEMPLATE,
  legal_advocate: LEGAL_TEMPLATE,
};

export const INDUSTRY_KEYS = Object.keys(INDUSTRY_TEMPLATES) as IndustryKey[];

/** Type guard for values arriving from the database or Clerk metadata. */
export function isIndustryKey(value: unknown): value is IndustryKey {
  return typeof value === "string" && value in INDUSTRY_TEMPLATES;
}

/**
 * Resolve a template from an untrusted value.
 * Always returns something — an unknown industry falls back to `generic` rather
 * than throwing, because a bad settings value must not take the app down.
 */
export function resolveIndustryTemplate(value: unknown): IndustryTemplate {
  if (isIndustryKey(value)) {
    // Non-null: `isIndustryKey` already proved the key exists.
    return INDUSTRY_TEMPLATES[value];
  }
  return GENERIC_TEMPLATE;
}

/**
 * Build a terminology lookup bound to one template.
 *
 * @example
 *   const t = createTranslator(template);
 *   t("asset.plural")        // "Properties"
 *   t("unknown.key")         // "unknown.key"  (visible, not silently blank)
 */
export function createTranslator(template: IndustryTemplate) {
  return function t(key: string, fallback?: string): string {
    return template.terminology[key] ?? fallback ?? key;
  };
}

/**
 * Filter navigation down to what a given role may see.
 * Sections that end up empty are dropped entirely, so no orphan headings render.
 */
export function filterNavigationByRole(
  sections: readonly NavSection[],
  role: string,
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => !item.roles || item.roles.length === 0 || item.roles.includes(role),
      ),
    }))
    .filter((section) => section.items.length > 0);
}

/** Options for an industry picker in settings. */
export function getIndustryOptions(): Array<{
  value: IndustryKey;
  label: string;
  description: string;
  icon: string;
}> {
  return INDUSTRY_KEYS.map((key) => {
    const tpl = INDUSTRY_TEMPLATES[key];
    return { value: key, label: tpl.label, description: tpl.description, icon: tpl.icon };
  });
}
