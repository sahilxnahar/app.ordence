/**
 * Ordence — Feature Catalogue & Plan Matrix
 * Version: v0.12.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ENTITLEMENTS ARE NOT PERMISSIONS. THEY ANSWER DIFFERENT QUESTIONS.
 * ══════════════════════════════════════════════════════════════════════
 * PERMISSION (Phase 5): "is this PERSON allowed to do this?"
 *   → depends on their role. A member cannot close a period.
 *   → denial means "ask your admin".
 *
 * ENTITLEMENT (this phase): "has this WORKSPACE paid for this?"
 *   → depends on the plan. Basic does not include trust accounting.
 *   → denial means "upgrade", and it is aimed at a different person
 *     entirely — the one holding the credit card.
 *
 * Both gates apply, independently, and in that order: entitlement first
 * (is the feature even present?), then permission (may YOU use it?).
 * Merging them would produce the single worst error message in a SaaS
 * product — "you do not have permission" shown to a workspace owner who
 * simply has not bought the tier, sending them to an admin who is
 * themselves.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE IS PURE AND ISOMORPHIC
 * ══════════════════════════════════════════════════════════════════════
 * No `server-only`, no database, no I/O. The pricing page, the upgrade
 * dialog, the navigation renderer and the server-side gate all need the
 * same matrix, and a second copy on the client is how "the page offered
 * it and the server refused" happens.
 *
 * The matrix is DATA, deliberately. Adding a feature is one entry here
 * and one `requireFeature()` call at the boundary — not a new column, not
 * a migration, not a deploy-order problem.
 */

import type { PlanTier } from "@/db/schema/core";

/* ------------------------------------------------------------------ */
/* THE FEATURE CATALOGUE                                               */
/* ------------------------------------------------------------------ */

/**
 * Every gateable capability in the product.
 *
 * Keys are `area.capability`. They are STABLE IDENTIFIERS — a renamed key
 * is a silent open door, because `can()` fails closed on an unknown key
 * and every call site referencing the old name would start denying. Add
 * new keys; never rename one.
 */
export const FEATURE_CATALOG = {
  /* --- Core CRM: present on every paid plan --------------------- */
  "crm.contacts": {
    label: "Contacts",
    description: "People and their details.",
    minTier: "basic",
  },
  "crm.companies": {
    label: "Companies",
    description: "Organisations and their relationships.",
    minTier: "basic",
  },
  "crm.deals": {
    label: "Deals",
    description: "Pipeline and opportunity tracking.",
    minTier: "basic",
  },
  "crm.custom_objects": {
    label: "Custom records",
    description: "Define your own record types without a migration.",
    minTier: "advanced",
  },
  "crm.bulk_import": {
    label: "Bulk import",
    description: "Import records from a spreadsheet.",
    minTier: "basic",
  },

  /* ═══════════════════════════════════════════════════════════════
   * ⭐ THE SHARED ENGINES — Session 1
   * ═══════════════════════════════════════════════════════════════
   * ⚠️ ONE KEY PER CAPABILITY, NOT PER INDUSTRY.
   *
   * A hotel's rooms, a hospital's beds and a haulier's trucks are the
   * same scheduling engine wearing three words. `hotel.rooms` +
   * `hospital.beds` + `logistics.slots` would be three keys for one
   * engine — and therefore three code paths, three sets of bugs, and a
   * price list nobody can explain. The vocabulary lives in the industry
   * template; the capability lives here, once.
   */
  "scheduling.resources": {
    label: "Scheduling",
    description: "Bookable resources, calendars and capacity.",
    minTier: "basic",
  },
  "scheduling.capacity": {
    label: "Capacity & yield",
    description: "Utilisation, overbooking policy and waitlists.",
    minTier: "advanced",
  },
  "rates.cards": {
    label: "Rate cards",
    description: "Price lists by season, channel, customer and slab.",
    minTier: "basic",
  },
  "rates.dynamic": {
    label: "Dynamic pricing",
    description: "Demand-linked and occupancy-linked rates.",
    minTier: "advanced",
  },
  "field.jobs": {
    label: "Field operations",
    description: "Job cards, dispatch and proof of service.",
    minTier: "basic",
  },
  "field.offline": {
    label: "Offline capture",
    description: "Works with no signal, syncs when it returns.",
    minTier: "advanced",
  },
  "compliance.calendar": {
    label: "Compliance deadlines",
    description: "Every statutory obligation, when it is due and what lateness costs.",
    minTier: "basic",
  },
  "compliance.licences": {
    label: "Licences & registrations",
    description: "Permissions that expire, and the renewal window before they do.",
    minTier: "basic",
  },
  "compliance.client_book": {
    label: "Client compliance book",
    description: "Track obligations on behalf of your clients, not just your own.",
    minTier: "advanced",
  },
  "metering.readings": {
    label: "Meters & readings",
    description: "Meter registry, readings and validation.",
    minTier: "basic",
  },
  "metering.net_settlement": {
    label: "Net metering",
    description: "Import, export, banked units and settlement.",
    minTier: "advanced",
  },
  "timesheets.entry": {
    label: "Timesheets",
    description: "Hours by person, project and task.",
    minTier: "basic",
  },
  /**
   * ⭐⭐ PAYROLL — v1.23.0-alpha, batch 15.
   *
   * ⚠️ `advanced`, NOT `basic`, AND IT IS A COMMERCIAL DECISION RATHER
   * THAN A TECHNICAL ONE. A business small enough to be on the basic
   * tier usually runs payroll on a spreadsheet or through its
   * accountant, and pricing it into the entry tier gives away the
   * feature most likely to justify an upgrade.
   *
   * 🔴 IT IS ALSO THE FEATURE WITH THE HIGHEST SUPPORT COST. Statutory
   * rates change, States disagree, and every question about a payslip
   * is asked by somebody who is owed money. Putting it behind a tier
   * that comes with support is honest in both directions.
   */
  "hr.payroll": {
    label: "Payroll",
    description:
      "Employees, salary structures, statutory deductions and a wage bill that posts to the ledger.",
    minTier: "advanced",
  },
  "timesheets.utilisation": {
    label: "Utilisation & WIP",
    description: "Billable ratio, realisation rate and unbilled work in progress.",
    minTier: "advanced",
  },
  "vault.sensitive": {
    label: "Sensitive-data vault",
    description: "Purpose-bound access, break-glass and consent for regulated data.",
    minTier: "enterprise",
  },

  /* --- Sales pipeline & inventory (Phase 22) --------------------- */
  //
  // ⚠️ `sales.pipeline` is BASIC, not Advanced, and that is a commercial
  // decision rather than an oversight. A real-estate developer evaluating
  // this product opens the leads board first; putting it behind an upgrade
  // wall means they never see the thing that differentiates us. The money
  // is made further down this list — brokerage, payment plans, the
  // channel-partner ledger — which is where the tiers actually bite.
  "sales.pipeline": {
    label: "Sales pipeline",
    description: "Leads, activity history and the pipeline board.",
    minTier: "basic",
  },
  "sales.inventory": {
    label: "Inventory",
    description: "Projects, units, availability and holds.",
    minTier: "basic",
  },
  "sales.bookings": {
    label: "Bookings",
    description: "Book a unit against a buyer, with cancellation handling.",
    minTier: "basic",
  },
  // ⚠️ `sales.orders` IS BASIC, AND THAT IS DELIBERATE. An order is the
  // record of what a customer agreed to buy. Withholding it from the
  // smallest customer means their commitments live in a spreadsheet, and
  // the whole product's claim — one place where the number is true — stops
  // being true for them on day one. The tier line goes at FULFILMENT,
  // below, which is where multi-warehouse dispatch and part-delivery
  // actually start costing us something to run.
  "sales.orders": {
    label: "Sales orders",
    description:
      "Confirmed customer orders with frozen lines, amendment revisions, pinned " +
      "HSN/SAC rates and separate ordered / fulfilled / invoiced quantities.",
    minTier: "basic",
  },
  "sales.fulfilment": {
    label: "Fulfilment & dispatch",
    description:
      "Delivery challans, part-shipment against order lines, carrier and vehicle " +
      "detail, e-way bill reference and proof of delivery.",
    minTier: "advanced",
  },
  // ⚠️ `inventory.stock` IS BASIC. A business that holds stock and cannot
  // see it has no ERP at all, whatever else it has paid for. The tier
  // line goes at multi-warehouse and batch/serial traceability below —
  // one shed is a Basic problem, nine sheds and expiry dates is not.
  "inventory.stock": {
    label: "Stock ledger",
    description:
      "Warehouses, stock items, and an append-only movement ledger with reservations " +
      "so available never gets confused with on hand.",
    minTier: "basic",
  },
  "inventory.traceability": {
    label: "Batch & serial traceability",
    description:
      "Batch and serial tracking, expiry dates, multi-warehouse transfers and cycle " +
      "counts with variance postings.",
    minTier: "advanced",
  },
  // ⚠️ `land.title` IS BASIC. The chain of title is the one thing a
  // developer cannot afford to get wrong, and a tier that put it behind an
  // upgrade would be selling "we will let you buy bad land until you pay
  // us". Same reasoning as `gst.tax_invoice`: every other gate in this
  // catalogue withholds convenience; this one would withhold the check
  // that stops a crore-scale mistake.
  "land.title": {
    label: "Land, title & JDA",
    description:
      "Land parcels, an ORDERED chain of title so a gap is visible, heir shares as " +
      "exact fractions, joint development agreements, khata, e-stamp and DC conversion.",
    minTier: "basic",
  },
  "land.approvals": {
    label: "Approvals & liaison",
    description:
      "Authority-wise sanction tracking with the desk a file is sitting on, the " +
      "liaison diary, FAR deviation against sanction and the occupancy-certificate gate.",
    minTier: "advanced",
  },
  /**
   * ⭐ THE CONTRACTING PAIR — added v0.69.0.
   *
   * ⚠️ TWO KEYS, NOT ONE, AND THE SPLIT IS THE POINT.
   *
   * A BOQ is an ESTIMATE. Raising one costs nothing, commits nothing and
   * is often done by a quantity surveyor or an estimator who has no
   * business approving a payment. Every developer needs it.
   *
   * An RA bill MOVES MONEY. It carries BOCW cess, retention, TDS and an
   * EPF/ESI compliance gate, and approving one is an instruction to pay a
   * subcontractor. Far fewer customers need it, and the ones who do are
   * running site contracts rather than buying flats.
   *
   * A single `construction.*` key would force those two onto the same
   * tier, which means either giving away the payment engine or charging
   * an estimator for it.
   */
  /**
   * ⭐⭐ WAVE 7 — THE DRAWING REGISTER, ON ITS OWN KEY.
   *
   * 🔴 NOT FOLDED INTO `construction.boq`, for exactly the reason the note
   * above gives about the BOQ and RA bills: a drawing register is useful
   * to somebody who never raises a bill of quantities. An architect, an
   * interior contractor and a facilities team all keep drawings and none
   * of them measure a BOQ.
   *
   * ⚠️ AND IT IS `basic`. The register is the thing that stops a site
   * building to a superseded sheet, which is not a premium concern.
   */
  "construction.drawings": {
    label: "Drawing register",
    description:
      "DXF drawings with revisions, layers, markups and measurements that cite the sheet " +
      "and the unit basis they came from. A revision supersedes the one before it and is " +
      "then frozen.",
    minTier: "basic",
  },
  "construction.boq": {
    label: "BOQ & measurement",
    description:
      "Bills of quantities with rate analysis and variation orders, measurement books, " +
      "and authorised-versus-measured tracking per line.",
    minTier: "basic",
  },
  "construction.ra_bills": {
    label: "RA bills & certification",
    description:
      "Running-account bills raised from measured work, with BOCW cess, retention, TDS " +
      "and a payment gate that will not release money without EPF/ESI evidence and an " +
      "engineer's certificate.",
    minTier: "advanced",
  },
  "sales.payment_plans": {
    label: "Payment plans",
    description: "Construction-linked milestone schedules and demands.",
    minTier: "advanced",
  },
  "sales.channel_partners": {
    label: "Channel partners",
    description: "Broker registry, KYC and commission-protected leads.",
    minTier: "advanced",
  },
  "sales.brokerage": {
    label: "Brokerage calculation",
    description: "Commission across percentage, flat-fee and rent bases.",
    minTier: "advanced",
  },

  /* --- GST (Phase 32) -------------------------------------------- */
  //
  // ⚠️ `gst.registry` AND `gst.tax_invoice` ARE BASIC, AND THAT IS NOT
  // GENEROSITY — IT IS THE ONLY DEFENSIBLE LINE.
  //
  // Charging the correct tax is not a feature, it is the law. A workspace
  // on the cheapest plan still issues documents that go into a return,
  // and a tier that made place-of-supply or GSTIN validation an upsell
  // would be selling "we will let you get this wrong until you pay us".
  // Every other gate in this catalogue withholds convenience; this one
  // would withhold compliance.
  //
  // The money is in `gst.rate_master`, and that IS a fair line: a
  // developer with one project and one rate does not need dated rate
  // histories per HSN. A developer with projects across three states, an
  // affordable-housing scheme at 1% and a commercial tower at 12% does,
  // and they are not on the basic plan.
  "gst.registry": {
    label: "GST registry",
    description:
      "Our GST registrations, customer and vendor GSTINs, with checksum validation.",
    minTier: "basic",
  },
  "gst.tax_invoice": {
    label: "Tax invoices",
    description:
      "Place of supply, CGST/SGST/UTGST/IGST, cess and reverse charge on a " +
      "Rule 46 compliant invoice.",
    minTier: "basic",
  },
  "gst.rate_master": {
    label: "HSN/SAC rate masters",
    description:
      "Dated HSN and SAC rate histories, so a historical invoice keeps the rate " +
      "that applied on its date.",
    minTier: "advanced",
  },

  /* --- Workflows & automation (Phase 23) ------------------------- */
  //
  // ⚠️ ALL FOUR SIT AT `advanced`, AND THE FLATNESS IS DELIBERATE.
  //
  // The tempting move is to ladder them — the builder on Advanced,
  // schedules on Enterprise, outbound HTTP higher still. It reads well on
  // a pricing page and it is a bad product: a customer who buys the
  // automation tier and then finds that automations cannot run on a
  // schedule has bought a feature that does not do the thing automation
  // means. The upgrade decision should be one question ("do we want the
  // product to do work for us?"), not a puzzle about which half.
  //
  // The tier bites at `basic → advanced`. That is where the money is, and
  // splitting it finer would mostly generate support tickets.
  "workflows.builder": {
    label: "Automations",
    description: "Build workflows that react to changes in your data.",
    minTier: "advanced",
  },
  "workflows.scheduled": {
    label: "Scheduled automations",
    description: "Run a workflow on a recurring schedule.",
    minTier: "advanced",
  },
  "workflows.webhooks": {
    label: "Inbound webhooks",
    description: "Let an external system start a workflow.",
    minTier: "advanced",
  },
  "workflows.http_request": {
    label: "Outbound requests",
    description: "Let a workflow call an external service.",
    minTier: "advanced",
  },

  /* --- Saved views (Phase 25) ----------------------------------- */
  //
  // ⚠️ THE SPLIT IS BETWEEN A PERSONAL PREFERENCE AND A TEAM ARTEFACT,
  // and it is the one place a tier line here is defensible.
  //
  // Saving your own filter is table stakes: a list page you cannot come
  // back to is a list page nobody uses, and putting that behind an
  // upgrade wall is the same mistake as gating `sales.pipeline` would
  // have been. So `views.saved` is BASIC.
  //
  // Sharing one is different in kind. A shared view is workspace
  // furniture — the board a sales floor opens every morning, the
  // workspace default a new hire inherits — and it only means anything
  // on a plan with enough people to share it with.
  "views.saved": {
    label: "Saved views",
    description: "Save a filter, sort and column layout under a name, on any record type.",
    minTier: "basic",
  },
  "views.shared": {
    label: "Shared views",
    description: "Publish a view to the whole workspace and set a default.",
    minTier: "advanced",
  },

  /* --- Assets --------------------------------------------------- */
  "assets.catalog": {
    label: "Asset catalogue",
    description: "Units, properties, matters and inventory.",
    minTier: "basic",
  },
  "assets.relationships": {
    label: "Asset relationships",
    description: "Parent/child and dependency graphs between assets.",
    minTier: "advanced",
  },

  /* --- Contracts ------------------------------------------------ */
  "clm.contracts": {
    label: "Contracts",
    description: "Contract records and their lifecycle.",
    minTier: "advanced",
  },
  "clm.document_assembly": {
    label: "Document assembly",
    description: "Generate documents from templates and clauses.",
    minTier: "advanced",
  },
  "clm.esignature": {
    label: "Electronic signature",
    description: "Send a contract for external approval and signature.",
    minTier: "advanced",
  },
  "clm.clause_library": {
    label: "Clause library",
    description: "A reusable, versioned library of contract clauses.",
    minTier: "advanced",
  },

  /* --- Accounting ----------------------------------------------- */
  "accounting.ledger": {
    label: "Trust accounting",
    description: "Double-entry ledger with enforced balance.",
    minTier: "advanced",
  },
  "accounting.period_close": {
    label: "Period close",
    description: "Lock a financial period against further posting.",
    minTier: "advanced",
  },

  /* --- Portal --------------------------------------------------- */
  "portal.external_links": {
    label: "Client portal",
    description: "Secure links for people outside your workspace.",
    minTier: "basic",
  },

  /* --- Storage & communications --------------------------------- */
  "storage.documents": {
    label: "Document vault",
    description: "Upload and store files against any record.",
    minTier: "basic",
  },
  "email.transactional": {
    label: "Email notifications",
    description: "Send notifications and portal invitations by email.",
    minTier: "basic",
  },

  /* --- Analytics ------------------------------------------------ */
  "analytics.dashboard": {
    label: "Executive dashboard",
    description: "Headline figures, charts and recent activity.",
    minTier: "advanced",
  },
  "analytics.export": {
    label: "Data export",
    description: "Export records and reports.",
    minTier: "advanced",
  },

  /* --- Administration ------------------------------------------- */
  "admin.custom_roles": {
    label: "Custom roles",
    description: "Compose roles beyond the nine built in.",
    minTier: "advanced",
  },
  "admin.audit_log": {
    label: "Audit log",
    description: "Read the immutable record of who did what.",
    minTier: "advanced",
  },
  "admin.api_access": {
    label: "API access",
    description: "Programmatic access to your workspace.",
    minTier: "advanced",
  },
  "admin.white_label": {
    label: "White labelling",
    description: "Your logo, colours and custom domain.",
    minTier: "enterprise",
  },
  "admin.sso": {
    label: "Single sign-on",
    description: "SAML / OIDC federation with your identity provider.",
    minTier: "enterprise",
  },
  "admin.data_residency": {
    label: "Data residency",
    description: "Choose the region your data is stored in.",
    minTier: "enterprise",
  },

  /* --- AI (Phase 51+; gated now so the tier means something) ----- */
  "ai.copilot": {
    label: "AI copilot",
    description: "Context-aware assistance inside the product.",
    minTier: "ai",
  },
  "ai.rag": {
    label: "Ask your data",
    description: "Natural-language questions answered from your records.",
    minTier: "ai",
  },

  /* --- Purchases & input tax credit (Phase 33) ------------------- */
  //
  // ⚠️ `purchases.invoices` AND `purchases.itc` ARE BASIC, FOR THE SAME
  // REASON `gst.tax_invoice` IS.
  //
  // Recording what you were charged and working out how much of that tax
  // you may keep is not a feature, it is the law. A workspace on the
  // cheapest plan still files a GSTR-3B, and a tier that made the Section
  // 17(5) determination an upsell would be selling "we will let you claim
  // credit you are not entitled to until you pay us" — which is worse
  // than useless, because the interest runs from the date of the claim.
  //
  // ⚠️ AND THE ONE THAT WOULD BE MOST TEMPTING TO GATE IS THE ONE THAT
  // MUST NOT BE. Blocked-credit determination is where a developer's
  // largest exposure sits: cement, steel and the main contractor's bill
  // for a building constructed on own account. Withholding it from the
  // small customer is withholding compliance from exactly the customer
  // least likely to have a tax adviser.
  "purchases.invoices": {
    label: "Purchase invoices",
    description:
      "Vendor bills with supplier GSTIN, place of supply, CGST/SGST/IGST/cess and " +
      "reverse charge.",
    minTier: "basic",
  },
  "purchases.itc": {
    label: "Input tax credit",
    description:
      "Section 17(5) blocked-credit determination per line, the ITC register, and " +
      "Rule 42/43 apportionment for mixed taxable and exempt supply.",
    minTier: "basic",
  },
  // The money IS here, and this is a fair line. A workspace with a
  // handful of vendors reads its payables off the invoice list. Ageing
  // buckets, per-vendor statements and the MSME 45-day exposure only
  // matter once there are hundreds of subcontractors — which is a
  // developer running more than one project, and they are not on Basic.
  "purchases.vendor_ledger": {
    label: "Vendor ledger & ageing",
    description:
      "Running vendor balances, ageing by due date, and the MSME 45-day payment " +
      "exposure under Section 43B(h).",
    minTier: "advanced",
  },

  /* --- ⭐ GSTR-2B reconciliation (Phase 34) --------------------- */
  //
  // ⚠️ BASIC, AND THIS IS THE ONE WHERE THE ARGUMENT IS STRONGEST.
  //
  // Section 16(2)(aa) makes the SUPPLIER'S filing a precondition of our
  // input tax credit, and Rule 36(4) has allowed no cushion at all since
  // January 2022. A workspace that cannot reconcile against 2B is a
  // workspace claiming credit it may not be entitled to — not through
  // carelessness, but because nothing in its own records could ever show
  // the difference. The bill looks identical either way.
  //
  // Gating it would be selling "we will let you claim credit the law
  // does not give you until you upgrade", and the interest under Section
  // 50 runs from the date of the claim. It is also precisely backwards
  // commercially: the customer least able to afford a ₹4 lakh
  // disallowance is the one on the cheapest plan, who has no tax adviser
  // reconciling it by hand in a spreadsheet.
  //
  // ⚠️ AND IT IS ONE KEY, NOT THREE. Splitting import, matching and the
  // vendor chase across tiers would mean a workspace that can see the
  // mismatch and not the vendor behind it — which is a screen that tells
  // you money is missing and refuses to say whose.
  "gst.gstr2b": {
    label: "GSTR-2B reconciliation",
    description:
      "Import the portal's GSTR-2B, match it against the purchase register, work " +
      "through the mismatches, chase suppliers who have not filed, and reconcile " +
      "input tax credit as per books against as per 2B against claimed.",
    minTier: "basic",
  },

  /* --- ⭐ Tax Deducted at Source (Phase 36) --------------------- */
  //
  // ⚠️ BASIC, AND THIS IS THE STRONGEST CASE ON THE WHOLE LIST.
  //
  // Every other tax feature in this product is about OUR money. TDS is
  // not: it is the government making the workspace its collection agent
  // on payments to other people, and an under-deduction is not a
  // reporting error, it is a debt. Section 201(1) makes the deductor an
  // assessee in default for the whole amount not deducted, interest
  // under 201(1A) runs from the date of each payment, and 30% of the
  // expenditure is disallowed under Section 40(a)(ia).
  //
  // ⭐ AND THE ERROR IS ONE OF ARITHMETIC, NOT OF JUDGEMENT. Four
  // ₹25,000 payments to a labour contractor cross Section 194C's
  // ₹1,00,000 annual threshold; the tax is then due on the whole
  // ₹1,00,000. A workspace without the cumulative engine tests each
  // payment on its own, deducts nothing, and has no way to find out.
  // Gating that behind a tier would be selling "we will let you accrue a
  // liability you cannot see until you upgrade" — and the customer least
  // able to absorb it is the one on the cheapest plan, who has no tax
  // department reconciling it by hand.
  //
  // ⚠️ IT IS ONE KEY AND NOT FIVE. Splitting the deduction from the
  // challan, or the challan from the return, would produce a workspace
  // that can compute what it owes and not record that it paid it —
  // which is exactly the state that leaves a deductee with no credit in
  // their Form 26AS while every screen looks finished.
  "tds.deductions": {
    label: "TDS deduction & compliance",
    description:
      "Deductees keyed on PAN, the deduction register with cumulative annual " +
      "thresholds, Sections 206AA/206AB and 197 rate resolution, challans and " +
      "late-deposit interest, Form 16A/27D assembly and the 24Q/26Q/27Q " +
      "quarterly returns with a validation pass.",
    minTier: "basic",
  },

  /* --- ⭐ Tally integration (Phase 37) -------------------------- */
  //
  // ⚠️ BASIC, AND FOR A DIFFERENT REASON FROM EVERY TAX FEATURE ABOVE.
  //
  // Those are gated low because withholding them creates a liability the
  // customer cannot see. This one is gated low because withholding it
  // creates a HABIT: a workspace that cannot export to Tally is a
  // workspace whose accountant re-types the month into Tally by hand,
  // and once that routine exists it never stops. The product then
  // becomes a screen beside the real books rather than the source of
  // them, and every later phase is arguing with a spreadsheet.
  //
  // ⭐ AND IT IS THE STRONGEST RETENTION FEATURE IN THE PRODUCT, which
  // is precisely the argument for NOT putting it behind a wall. A
  // customer who has mapped their chart of accounts, exported nine
  // months and reconciled them does not migrate; a customer on the
  // cheapest plan who never got to do that has nothing holding them.
  //
  // ⚠️ IT IS ONE KEY AND NOT THREE. Splitting the export from the
  // reconciliation would sell a workspace the ability to push vouchers
  // into somebody's statutory books and not the ability to check they
  // arrived once — which is the exact state in which a double post goes
  // unnoticed for a year.
  "accounting.tally": {
    label: "Tally integration",
    description:
      "Map the chart of accounts, vendors, customers and tax heads to Tally " +
      "ledgers and projects to Tally cost centres; generate importable Tally " +
      "XML for sales, purchase, receipt, payment, journal, contra, credit and " +
      "debit note vouchers with GST and HSN fields; push directly to a local " +
      "Tally; and reconcile a Tally export back against our ledger.",
    minTier: "basic",
  },

  /* --- ⭐ Receivables & demand notices (Phase 38) --------------- */
  //
  // ⚠️ ADVANCED, AND IT IS THE ONE TIER DECISION THAT MAKES ITSELF.
  //
  // A demand is raised against a construction-linked milestone, and
  // `sales.payment_plans` — which creates those milestones — is already
  // advanced. Putting collections on a lower tier than the plans they
  // collect against would sell a workspace the ability to demand money
  // against instalments it cannot define.
  //
  // ⭐ AND IT IS ONE KEY, NOT FOUR, WHICH IS THE MORE IMPORTANT DECISION.
  // Splitting the demand from the dunning ladder would sell somebody the
  // ability to raise a legal document and not the ability to chase it
  // correctly — and the ladder is not a convenience, it is the sequence a
  // developer must be able to produce before terminating an allotment.
  // Splitting the receipts off would leave a workspace demanding money it
  // cannot record as received, so every demand it raises stays
  // outstanding forever. Splitting the multi-language notices off would be
  // the worst of the four: it would price the ability to write to a buyer
  // in the language they read, which is the difference between a
  // collection and a follow-up call, and the workspaces least able to pay
  // for it are the ones whose buyers most need it.
  "sales.receivables": {
    label: "Receivables & demand notices",
    description:
      "Demand notices raised against construction milestones with the RERA trigger " +
      "stated on the document, in English, Hindi, Kannada, Tamil, Telugu and " +
      "Marathi; delay interest with a configurable compounding rule stated on the " +
      "notice and flagged against the RERA reference rate; ageing by project, " +
      "booking and buyer; receipts with exact, explainable allocation across " +
      "several demands, part payments and over-payment as credit; a four-rung " +
      "dunning ladder that cannot skip a step; and a statement of account that " +
      "foots.",
    minTier: "advanced",
  },
} as const satisfies Record<string, FeatureDefinition>;

type FeatureDefinition = {
  label: string;
  description: string;
  /** Lowest tier that includes this feature. */
  minTier: PlanTier;
};

export type FeatureKey = keyof typeof FEATURE_CATALOG;

export const FEATURE_KEYS = Object.keys(FEATURE_CATALOG) as FeatureKey[];

/* ------------------------------------------------------------------ */
/* TIER ORDERING                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tiers are a LADDER, not a set. Every tier includes everything below it,
 * which is why the catalogue stores a single `minTier` rather than a list
 * of tiers per feature.
 *
 * A per-tier list would let the matrix drift into a state where Advanced
 * has a feature Basic has and Enterprise does not — an inconsistency
 * nobody notices until an enterprise customer asks where their contacts
 * went. The ladder makes that unrepresentable.
 *
 * ⚠️ `trial` is rank 0 and NOT the bottom of the paid ladder. See
 * TRIAL_TIER_BEHAVIOUR below — it is a special case, deliberately.
 */
export const TIER_RANK: Readonly<Record<PlanTier, number>> = Object.freeze({
  trial: 0,
  basic: 1,
  advanced: 2,
  ai: 3,
  enterprise: 4,
});

export const TIER_LABELS: Readonly<Record<PlanTier, string>> = Object.freeze({
  trial: "Trial",
  basic: "Basic",
  advanced: "Advanced",
  ai: "AI",
  enterprise: "Enterprise",
});

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHAT A TRIAL GETS, AND WHY IT IS NOT "NOTHING"
 * ══════════════════════════════════════════════════════════════════════
 * A trial that only unlocks the cheapest tier is a bad trial: the
 * prospect evaluates the least impressive version of the product and
 * concludes it does not do what they need.
 *
 * So a trial is treated as **Advanced** for the purposes of feature
 * access — everything except the enterprise-only and AI capabilities,
 * which are sold rather than self-served anyway. The limits that bite
 * during a trial are the QUOTAS (seats, storage), not the features, and
 * those are metered separately in Phase 15.
 *
 * This is a commercial decision encoded as one constant, so it is easy
 * to find and easy to change.
 */
export const TRIAL_EFFECTIVE_TIER: PlanTier = "advanced";

/**
 * What a LAPSED workspace keeps.
 *
 * When a subscription no longer grants access, the tenant drops here
 * rather than to zero. The reasoning is in Phase 14, but the short
 * version: a customer whose card expired should find a limited product
 * and a clear "update your payment method", not a locked door and their
 * data apparently gone. The second is how you lose someone who was
 * always going to pay.
 */
export const LAPSED_EFFECTIVE_TIER: PlanTier = "basic";

/* ------------------------------------------------------------------ */
/* THE DECISION                                                        */
/* ------------------------------------------------------------------ */

export type EntitlementDecision = {
  allowed: boolean;
  feature: FeatureKey;
  /** The tier actually in force (after trial/lapse adjustment). */
  effectiveTier: PlanTier;
  /** The lowest tier that would grant it. */
  requiredTier: PlanTier;
  reason:
    | "included"
    | "requires_upgrade"
    | "unknown_feature"
    | "subscription_inactive"
    /**
     * ⭐ PLATFORM STAFF TURNED THIS ON FOR THIS ONE WORKSPACE, above what
     * their plan includes. A pilot, a migration, a promise made in a
     * sales call. Distinct from "included" on purpose: an override is a
     * FORK of the pricing model for one customer, and a fork nobody can
     * see is a fork nobody ever unwinds.
     */
    | "granted_by_override"
    /**
     * ⭐ PLATFORM STAFF TURNED THIS OFF for this workspace despite their
     * plan including it. Rare, and always for a reason — abuse, a
     * regulatory hold, a feature withdrawn mid-incident.
     *
     * ⚠️ THE MESSAGE FOR THIS MUST NOT SAY "UPGRADE". The customer is
     * already paying for it; offering to sell it to them again is the
     * worst possible response.
     */
    | "revoked_by_override";
  /** Ready to show a customer. Never mentions roles or permissions. */
  message: string;
};

/**
 * ⚠️ `Object.hasOwn`, NOT the `in` operator.
 *
 * `"toString" in FEATURE_CATALOG` is TRUE — `in` walks the prototype
 * chain, so every method on `Object.prototype` reads as a known feature:
 * `toString`, `constructor`, `hasOwnProperty`, `__proto__`.
 *
 * The first draft of this function used `in` and a test caught it. The
 * consequence was not immediately a granted feature — `FEATURE_CATALOG
 * ["toString"]` is a function, so `.minTier` is `undefined`,
 * `TIER_RANK[undefined]` is `undefined`, and the comparison came out
 * false — so it happened to fail closed. But it failed closed BY
 * ACCIDENT, through a chain of coincidences, and reported
 * `requires_upgrade` rather than `unknown_feature`. A gate that is safe
 * by luck is a gate that stops being safe when something unrelated
 * changes.
 */
export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && Object.hasOwn(FEATURE_CATALOG, value);
}

/**
 * Resolve the tier that actually applies.
 *
 * Kept separate from `evaluateFeature` so the trial and lapse rules are
 * stated once and cannot diverge between the gate, the navigation and the
 * pricing page.
 */
export function effectiveTier(args: {
  planTier: PlanTier;
  /** False when the subscription is cancelled, expired or unpaid. */
  subscriptionGrantsAccess: boolean;
}): PlanTier {
  if (!args.subscriptionGrantsAccess) return LAPSED_EFFECTIVE_TIER;
  if (args.planTier === "trial") return TRIAL_EFFECTIVE_TIER;
  return args.planTier;
}

/**
 * Decide whether a workspace is entitled to a feature.
 *
 * ⚠️ FAILS CLOSED on an unknown key. A typo at a call site must deny, not
 * grant — the opposite default turns every typo into a feature given away
 * free, and nothing would ever surface it. Same reasoning as
 * `evaluatePermission` in Phase 5.
 */
export function evaluateFeature(
  feature: string,
  context: {
    planTier: PlanTier;
    subscriptionGrantsAccess: boolean;
    /**
     * ⭐ PER-TENANT OVERRIDES SET BY PLATFORM STAFF — v0.43.0.
     *
     * A map of feature key → granted/revoked, resolved from
     * `platform_tenant_flags`. Absent for a workspace with no overrides,
     * which is almost all of them.
     *
     * ⚠️ THE OVERRIDE IS CHECKED BEFORE THE TIER, DELIBERATELY. If it were
     * checked after, a grant could only ever confirm what the plan already
     * allowed and a revoke could never take anything away — the whole
     * mechanism would be decorative. Checking first is what makes it real,
     * and it is also what makes it dangerous, which is why the database
     * requires a reason on every one.
     */
    overrides?: Readonly<Record<string, boolean>>;
  },
): EntitlementDecision {
  const tier = effectiveTier(context);

  if (!isFeatureKey(feature)) {
    return {
      allowed: false,
      feature: feature as FeatureKey,
      effectiveTier: tier,
      requiredTier: "enterprise",
      reason: "unknown_feature",
      message: "That feature is not available.",
    };
  }

  const definition = FEATURE_CATALOG[feature];
  const requiredTier = definition.minTier;

  /* --- ⭐ THE PER-TENANT OVERRIDE, CHECKED FIRST ------------------- */
  const override = context.overrides?.[feature];

  if (override === true) {
    return {
      allowed: true,
      feature,
      effectiveTier: tier,
      requiredTier,
      reason: "granted_by_override",
      message: `${definition.label} has been enabled for your workspace.`,
    };
  }

  if (override === false) {
    /**
     * ⚠️ THIS MESSAGE MUST NEVER OFFER AN UPGRADE. The customer may
     * already be paying for this tier; inviting them to buy something
     * they own is the worst response available. It says the thing is off
     * and points at a human, because a human turned it off.
     */
    return {
      allowed: false,
      feature,
      effectiveTier: tier,
      requiredTier,
      reason: "revoked_by_override",
      message: `${definition.label} has been switched off for your workspace. Please contact support — this is not something an upgrade will restore.`,
    };
  }

  const allowed = TIER_RANK[tier] >= TIER_RANK[requiredTier];

  if (allowed) {
    return {
      allowed: true,
      feature,
      effectiveTier: tier,
      requiredTier,
      reason: "included",
      message: `${definition.label} is included in your plan.`,
    };
  }

  /**
   * The message distinguishes "you never had this" from "you had this and
   * lost it". They are completely different situations for the reader:
   * the first is a purchase decision, the second is usually an expired
   * card and a moment of alarm about their data.
   */
  if (!context.subscriptionGrantsAccess) {
    return {
      allowed: false,
      feature,
      effectiveTier: tier,
      requiredTier,
      reason: "subscription_inactive",
      message:
        `${definition.label} is paused because your subscription is not active. ` +
        `Your data is safe — update your payment details to restore it.`,
    };
  }

  return {
    allowed: false,
    feature,
    effectiveTier: tier,
    requiredTier,
    reason: "requires_upgrade",
    message: `${definition.label} is available on the ${TIER_LABELS[requiredTier]} plan.`,
  };
}

/** Convenience predicate for render-time checks. */
export function hasFeature(
  feature: string,
  context: { planTier: PlanTier; subscriptionGrantsAccess: boolean },
): boolean {
  return evaluateFeature(feature, context).allowed;
}

/* ------------------------------------------------------------------ */
/* BULK QUERIES                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every feature a tier includes. Used by the pricing page and the
 * comparison table, so those are generated from the same matrix the gate
 * enforces rather than hand-maintained beside it.
 *
 * A hand-written pricing table that disagrees with the gate is a promise
 * you do not keep, and it is the kind of thing that gets discovered by a
 * customer rather than by a test.
 */
export function featuresForTier(tier: PlanTier): FeatureKey[] {
  return FEATURE_KEYS.filter(
    (key) => TIER_RANK[tier] >= TIER_RANK[FEATURE_CATALOG[key].minTier],
  );
}

/** Features gained by moving from one tier to another. Empty on a downgrade. */
export function featuresGainedBy(from: PlanTier, to: PlanTier): FeatureKey[] {
  if (TIER_RANK[to] <= TIER_RANK[from]) return [];
  const current = new Set(featuresForTier(from));
  return featuresForTier(to).filter((key) => !current.has(key));
}

/** Features LOST by moving from one tier to another. Empty on an upgrade. */
export function featuresLostBy(from: PlanTier, to: PlanTier): FeatureKey[] {
  if (TIER_RANK[to] >= TIER_RANK[from]) return [];
  const next = new Set(featuresForTier(to));
  return featuresForTier(from).filter((key) => !next.has(key));
}

/**
 * The cheapest tier that includes a feature. Drives the upgrade prompt:
 * pointing someone at Enterprise for something Advanced would give them
 * is a good way to lose the sale.
 */
export function lowestTierWith(feature: FeatureKey): PlanTier {
  return FEATURE_CATALOG[feature].minTier;
}
