/**
 * Ordence — ⭐ THE MCP TOOL REGISTRY
 * Version: v0.74.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT AN ASSISTANT IS ALLOWED TO DO, AND WHAT IT MUST NEVER DO
 * ══════════════════════════════════════════════════════════════════════
 * One list. `server/mcp/dispatch.ts` executes nothing that is not here,
 * and the HTTP route never reaches a server action directly. A tool that
 * is not in this file does not exist to an assistant.
 *
 * ⚠️ PURE. No database, no `next/headers`, no server actions. This module
 * is a description of a surface, which is why it can be unit-tested and
 * why the same list can be rendered in the admin console without pulling
 * a request context in with it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THE FOUR RULES THAT DECIDE WHAT GOES IN HERE
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. **READS ARE CHEAP, WRITES ARE DECISIONS.** Every read tool is
 *    available to a `read_only` token. Every write tool requires
 *    `read_write`, which a person has to choose deliberately.
 *
 * 2. **NOTHING THAT MOVES MONEY OR CHANGES A CEILING.** Certifying an RA
 *    bill, approving a variation and verifying a UAN are all absent, and
 *    absent on purpose. Those carry segregation-of-duties controls whose
 *    entire value is that a *second human* looked. An assistant holding
 *    a token issued by the first human is not a second human — it is the
 *    first human with extra steps, and routing an approval through it
 *    launders the control instead of satisfying it.
 *
 * 3. **NOTHING DESTRUCTIVE.** No delete, no drop, no revoke, no
 *    impersonation. An assistant that can be talked into a delete by a
 *    poisoned document is an assistant that will be.
 *
 * 4. **NOTHING TOUCHING THE SENSITIVE VAULT.** Engine 6 exists because
 *    health data needs purpose-bound access rather than role-based
 *    access. "An assistant asked" is not a treatment purpose.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THIS REGISTRY IS NOT A SECURITY BOUNDARY EITHER
 * ══════════════════════════════════════════════════════════════════════
 * Same rule as the module registry. Every handler still runs inside
 * `withTenant()` under row-level security, and still calls the same
 * guards the UI calls. This file decides what is OFFERED. The database
 * decides what is POSSIBLE.
 */

export type McpScope = "read_only" | "read_write";

export type McpToolParameter = {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
};

export type McpToolDefinition = {
  /** Namespaced so it cannot collide with another server's tool. */
  name: string;
  title: string;
  description: string;
  /** The minimum scope a token needs. */
  scope: McpScope;
  parameters: readonly McpToolParameter[];
  /**
   * Shown to the operator in the admin console, and included in the
   * tool description an assistant reads. Empty for ordinary reads.
   */
  caution?: string;
};

/* ------------------------------------------------------------------ */
/* READ TOOLS — available to every token                               */
/* ------------------------------------------------------------------ */

const READ_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "ordence_whoami",
    title: "Which workspace am I connected to",
    description:
      "Returns the tenant name, the user this token acts as, the token's scope, " +
      "and which modules the workspace has. Call this first — every other tool " +
      "operates inside that one workspace and cannot see any other.",
    scope: "read_only",
    parameters: [],
  },
  {
    name: "ordence_list_boqs",
    title: "List bills of quantities",
    description:
      "Every BOQ in the workspace with its code, title, status and project. " +
      "A BOQ is what a contractor is authorised to build.",
    scope: "read_only",
    parameters: [],
  },
  {
    name: "ordence_get_boq",
    title: "One bill of quantities in full",
    description:
      "A BOQ with its line items, quantities, rates and measured position.",
    scope: "read_only",
    parameters: [
      { name: "boqId", type: "string", required: true, description: "The BOQ's id." },
    ],
  },
  {
    name: "ordence_list_variations",
    title: "The variation register",
    description:
      "Every change to agreed scope: what was instructed, for how much, and " +
      "what happened to it. Includes rejected and withdrawn variations — a " +
      "register that hides refusals answers the wrong question.",
    scope: "read_only",
    parameters: [],
  },
  {
    name: "ordence_get_variation",
    title: "One variation order in full",
    description:
      "A variation with its priced lines, its additions and omissions shown " +
      "separately, and its approval history.",
    scope: "read_only",
    parameters: [
      {
        name: "variationId",
        type: "string",
        required: true,
        description: "The variation's id.",
      },
    ],
  },
  {
    name: "ordence_list_ra_bills",
    title: "Running-account bills",
    description:
      "What each subcontractor has claimed, what has been certified, what is " +
      "owed, and the retention and TDS on each.",
    scope: "read_only",
    parameters: [],
  },
  {
    name: "ordence_site_labour",
    title: "Site labour position",
    description:
      "Who is on the register, how many are admissible to site, how many " +
      "cannot work because their UAN is unverified, and what measured piece " +
      "work has not yet been billed.",
    scope: "read_only",
    parameters: [],
  },
  {
    name: "ordence_module_status",
    title: "What this workspace can do",
    description:
      "The modules the workspace has, grouped, with which are live. Useful " +
      "before suggesting a workflow the tenant has not bought.",
    scope: "read_only",
    parameters: [],
  },

  /* ---- GST ------------------------------------------------------- */
  {
    name: "ordence_list_gst_registrations",
    title: "The workspace's own GST registrations",
    description:
      "Every GSTIN this workspace holds, with its state code, legal name, " +
      "registration type and whether it is the primary. A developer " +
      "registered in more than one state has multiple rows. Use this to " +
      "answer 'which GSTIN do we issue from' before looking at invoices.",
    scope: "read_only",
    parameters: [],
  },
  {
    name: "ordence_list_gst_parties",
    title: "Counterparty GSTINs",
    description:
      "Every GSTIN that is not ours — buyers, vendors, contractors — with " +
      "their registration type, state code and PAN. Filtered to active " +
      "parties. Useful before raising or matching a tax document.",
    scope: "read_only",
    parameters: [
      {
        name: "partyType",
        type: "string",
        required: false,
        description: "Filter: 'customer' or 'vendor'. Omit for all.",
      },
    ],
  },

  /* ---- Purchases & ITC ------------------------------------------- */
  {
    name: "ordence_list_purchase_invoices",
    title: "Vendor bills received",
    description:
      "Purchase invoices recorded in the workspace, newest first, with the " +
      "supplier's invoice number, date, taxable value, total tax and ITC " +
      "eligibility per line. Useful for 'what did we buy this month' and " +
      "for GSTR-2B reconciliation prep.",
    scope: "read_only",
    parameters: [
      {
        name: "status",
        type: "string",
        required: false,
        description:
          "Filter by status: draft, recorded, approved, paid, cancelled. " +
          "Omit for all.",
      },
    ],
  },
  {
    name: "ordence_itc_register",
    title: "Input tax credit position",
    description:
      "The ITC register: every credit movement with its period, reason, " +
      "amount and status (claimed, blocked, deferred, reversed). This is " +
      "what answers 'how much input tax credit can we claim this period'.",
    scope: "read_only",
    parameters: [
      {
        name: "status",
        type: "string",
        required: false,
        description:
          "Filter: claimed, blocked, deferred, reversed. Omit for all.",
      },
    ],
  },

  /* ---- Receivables ----------------------------------------------- */
  {
    name: "ordence_list_demand_notices",
    title: "Demand notices (receivables)",
    description:
      "Demand notices raised against construction-linked milestones, with " +
      "notice number, due date, principal, tax, total, allocated so far and " +
      "status (draft, issued, part_paid, paid, cancelled, superseded). " +
      "Useful for 'what is outstanding' and 'who is overdue'.",
    scope: "read_only",
    parameters: [
      {
        name: "status",
        type: "string",
        required: false,
        description:
          "Filter: draft, issued, part_paid, paid, cancelled, superseded. " +
          "Omit for all.",
      },
    ],
  },
  {
    name: "ordence_list_receipts",
    title: "Receipts collected",
    description:
      "Receipts recorded in the workspace, newest first, with method, " +
      "amount, status (pending, cleared, bounced, cancelled) and the demand " +
      "notice they were allocated against. A bounced cheque is visible here " +
      "because it was never money.",
    scope: "read_only",
    parameters: [],
  },

  /* ---- Compliance ------------------------------------------------ */
  {
    name: "ordence_compliance_calendar",
    title: "Compliance calendar — what is due and what is late",
    description:
      "Every compliance task in the workspace, ordered by due date, with " +
      "the obligation name, authority, period label, due date, status and " +
      "severity. Tasks that are pending or in_progress and past their due " +
      "date are flagged as overdue. This is what answers 'what filings are " +
      "due this month' and 'are we behind on anything'.",
    scope: "read_only",
    parameters: [
      {
        name: "status",
        type: "string",
        required: false,
        description:
          "Filter: pending, in_progress, awaiting_client, ready_to_file, " +
          "filed, late_filed, missed, not_applicable, waived. Omit for all " +
          "non-terminal (excludes filed, not_applicable, waived).",
      },
    ],
  },
  {
    name: "ordence_list_licences",
    title: "Licences and registrations",
    description:
      "Licences and statutory registrations held by the workspace or its " +
      "client companies, with status (active, renewal_due, under_renewal, " +
      "expired, suspended, cancelled) and expiry date. Useful for 'what " +
      "expires soon' and 'are we operating on an expired licence'.",
    scope: "read_only",
    parameters: [],
  },

  /* ---- Inventory ------------------------------------------------- */
  {
    name: "ordence_stock_position",
    title: "Stock on hand and available",
    description:
      "Every stock item with its on-hand quantity and available quantity " +
      "(on hand minus reserved), per warehouse, plus reorder level. Items " +
      "at or below their reorder level are flagged. This is what answers " +
      "'what needs reordering' and 'can we fulfil this order'.",
    scope: "read_only",
    parameters: [
      {
        name: "lowStockOnly",
        type: "boolean",
        required: false,
        description:
          "If true, returns only items at or below their reorder level.",
      },
    ],
  },

  /* ---- Scheduling ------------------------------------------------ */
  {
    name: "ordence_list_bookings",
    title: "Scheduled bookings",
    description:
      "Bookings on the scheduling calendar, ordered by start time, with " +
      "resource name, reference, status and the time window. Useful for " +
      "'what is booked today' and 'is this resource free'.",
    scope: "read_only",
    parameters: [
      {
        name: "status",
        type: "string",
        required: false,
        description:
          "Filter: held, confirmed, checked_in, in_progress, completed, " +
          "no_show, cancelled, waitlisted. Omit for active (held, " +
          "confirmed, checked_in, in_progress).",
      },
    ],
  },

  /* ---- Field operations ------------------------------------------ */
  {
    name: "ordence_list_field_jobs",
    title: "Field jobs",
    description:
      "Field and mobile operations jobs, ordered by scheduled window, with " +
      "job number, title, kind, status, priority, assigned person, site " +
      "address and visit count. Useful for 'what is dispatched today', " +
      "'what is overdue' and 'which jobs needed multiple visits'.",
    scope: "read_only",
    parameters: [
      {
        name: "status",
        type: "string",
        required: false,
        description:
          "Filter: draft, scheduled, dispatched, travelling, on_site, " +
          "paused, completed, could_not_complete, cancelled. Omit for " +
          "active (scheduled, dispatched, travelling, on_site, paused).",
      },
    ],
  },

  /* ---- TDS ------------------------------------------------------- */
  {
    name: "ordence_list_tds_deductions",
    title: "TDS deductions",
    description:
      "Tax Deducted at Source entries, newest first, with the deductee " +
      "name, PAN, section, rate, amount deducted, amount paid and the " +
      "period. Useful for 'how much TDS did we deduct this quarter' and " +
      "'are we behind on any deductions'.",
    scope: "read_only",
    parameters: [
      {
        name: "section",
        type: "string",
        required: false,
        description:
          "Filter by TDS section: 194C, 194J_a, 194J_b, 194I_a, 194I_b, " +
          "194IA, 194Q, 194H, 194A, 195. Omit for all.",
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* WRITE TOOLS — require an explicitly granted read_write token         */
/* ------------------------------------------------------------------ */

const WRITE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "ordence_raise_variation",
    title: "Raise a variation order as a DRAFT",
    description:
      "Creates a variation in DRAFT against an issued BOQ. It authorises " +
      "nothing until a person prices it and a different person approves it. " +
      "This tool cannot submit or approve.",
    scope: "read_write",
    caution:
      "Creates a record a human then has to price and approve. It cannot move " +
      "the measurement ceiling and cannot approve anything.",
    parameters: [
      { name: "boqId", type: "string", required: true, description: "The BOQ to vary." },
      {
        name: "kind",
        type: "string",
        required: true,
        description:
          "addition | omission | rate_change | substitution | extra_item",
      },
      { name: "title", type: "string", required: true, description: "Short title." },
      {
        name: "reason",
        type: "string",
        required: true,
        description: "Why the change is needed. The contractor will ask.",
      },
      {
        name: "instructionRef",
        type: "string",
        required: false,
        description: "Site instruction reference, if there is one.",
      },
    ],
  },
  {
    name: "ordence_record_daily_site_log",
    title: "Record or update a daily site log",
    description:
      "Weather, rainfall, hours lost, labour count and what was done, for one " +
      "project on one date. One log per project per day — saving again updates " +
      "that day rather than creating a second record.",
    scope: "read_write",
    caution:
      "⚠️ This is an extension-of-time document. Rainfall and hours lost on a " +
      "given date decide delay claims. Record what happened, never an estimate.",
    parameters: [
      { name: "projectId", type: "string", required: true, description: "The project." },
      { name: "logDate", type: "string", required: true, description: "YYYY-MM-DD." },
      {
        name: "labourCount",
        type: "number",
        required: true,
        description: "How many people were on site.",
      },
      { name: "weather", type: "string", required: false, description: "Free text." },
      { name: "rainfallMm", type: "string", required: false, description: "Millimetres." },
      { name: "hoursLost", type: "string", required: false, description: "Hours." },
      { name: "workDone", type: "string", required: false, description: "What was built." },
      { name: "issues", type: "string", required: false, description: "Problems." },
    ],
  },

  /* ---- v0.83.0-alpha: Additional write tools ---- */

  {
    name: "ordence_create_compliance_task",
    title: "Create a compliance task",
    description:
      "Creates a compliance tracking task with a due date. Useful for " +
      "agents that identify an obligation the tenant needs to track.",
    scope: "read_write",
    caution: "Creates a task. It does not file anything or meet any deadline.",
    parameters: [
      { name: "obligationId", type: "string", required: true, description: "Link to an existing compliance obligation." },
      { name: "periodLabel", type: "string", required: true, description: "e.g. 'GST Aug 2026' or 'TDS Q2 2026'." },
      { name: "dueDate", type: "string", required: true, description: "YYYY-MM-DD." },
      { name: "notes", type: "string", required: false, description: "Optional context." },
    ],
  },
  {
    name: "ordence_create_reminder",
    title: "Create a reminder notification",
    description:
      "Creates an in-app notification for the tenant. The notification " +
      "appears in the bell icon and the notification center.",
    scope: "read_write",
    caution: "Creates a notification. It does not send an email or push alert.",
    parameters: [
      { name: "title", type: "string", required: true, description: "Short title." },
      { name: "body", type: "string", required: false, description: "Details." },
      { name: "category", type: "string", required: true, description: "compliance, finance, gst, receivables, inventory, field_ops, or system." },
      { name: "severity", type: "string", required: false, description: "info, warning, critical. Default: info." },
      { name: "actionUrl", type: "string", required: false, description: "Deep link to the relevant page." },
    ],
  },
  {
    name: "ordence_update_deal_stage",
    title: "Update a deal's stage",
    description:
      "Moves a deal to a new stage in the sales pipeline. Does not close " +
      "or delete the deal.",
    scope: "read_write",
    caution: "Updates a deal's stage. It cannot close, win, or delete a deal.",
    parameters: [
      { name: "dealId", type: "string", required: true, description: "The deal to update." },
      { name: "stage", type: "string", required: true, description: "New stage: lead, qualified, proposal, negotiation, won, lost." },
    ],
  },
  {
    name: "ordence_create_note",
    title: "Create a note on a record",
    description:
      "Adds a text note to a contact, deal, project, or compliance task. " +
      "Notes are append-only — existing notes are not modified.",
    scope: "read_write",
    caution: "Appends a note. It cannot edit or delete existing notes.",
    parameters: [
      { name: "recordType", type: "string", required: true, description: "contact, deal, project, or compliance_task." },
      { name: "recordId", type: "string", required: true, description: "The record to note on." },
      { name: "body", type: "string", required: true, description: "The note text." },
    ],
  },
  {
    name: "ordence_send_email",
    title: "Send an email notification",
    description:
      "Sends a transactional email via the configured Resend integration. " +
      "Requires RESEND_API_KEY to be set.",
    scope: "read_write",
    caution:
      "Sends an email to an external address. The recipient, subject, and body " +
      "are visible to the LLM provider. Do not include sensitive data.",
    parameters: [
      { name: "to", type: "string", required: true, description: "Recipient email address." },
      { name: "subject", type: "string", required: true, description: "Email subject line." },
      { name: "body", type: "string", required: true, description: "Plain text email body." },
    ],
  },
];

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  ...READ_TOOLS,
  ...WRITE_TOOLS,
]);

/**
 * ⭐ THE DENY LIST — capabilities deliberately absent, and why.
 *
 * ⚠️ THIS IS DOCUMENTATION, NOT ENFORCEMENT. Enforcement is that these
 * tools do not exist. The list is here so that the next person to add a
 * tool has to read the reasons before adding one of these, rather than
 * discovering the reasoning does not exist and assuming there was none.
 */
export const MCP_DELIBERATELY_ABSENT: Readonly<Record<string, string>> =
  Object.freeze({
    approve_variation:
      "Approval moves the measurement ceiling and is final. Its whole value is " +
      "that a SECOND HUMAN looked. A token issued by the first human is the " +
      "first human with extra steps.",
    certify_ra_bill:
      "Certification says work of this value was actually done. Only somebody " +
      "who stood on the site can say that.",
    approve_ra_bill:
      "Releases money. Same reasoning as certification, with a bank transfer at " +
      "the end of it.",
    verify_uan:
      "Admits a worker to site and makes an EPF contribution attributable. " +
      "Somebody accountable to the EPFO has to be the one vouching.",
    check_measurement:
      "The second pair of eyes on a measured quantity. Automating the check " +
      "removes the only thing the check is.",
    any_delete:
      "An assistant that can be talked into a delete by a poisoned document " +
      "will eventually be talked into one.",
    vault_read:
      "Engine 6 requires purpose-bound access for sensitive data. " +
      "'An assistant asked' is not a treatment purpose.",
    impersonate:
      "Staff impersonation is already the most powerful capability in the " +
      "product. It does not also need a programmatic entry point.",
    manage_mcp_tokens:
      "A token that can mint tokens cannot meaningfully be revoked.",
  });

export function findTool(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

/**
 * Does this token's scope permit this tool?
 *
 * ⚠️ FAILS CLOSED ON AN UNKNOWN TOOL. A missing entry returns false, not
 * true — so a typo in a tool name is a refusal rather than a bypass.
 */
export function scopePermits(scope: McpScope, toolName: string): boolean {
  const tool = findTool(toolName);
  if (!tool) return false;
  if (tool.scope === "read_only") return true;
  return scope === "read_write";
}

/** JSON Schema for the MCP `tools/list` response. */
export function toolInputSchema(tool: McpToolDefinition): {
  type: "object";
  properties: Record<string, { type: string; description: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  for (const p of tool.parameters) {
    properties[p.name] = { type: p.type, description: p.description };
    if (p.required) required.push(p.name);
  }

  return { type: "object", properties, required };
}

/**
 * The description an assistant actually reads.
 *
 * ⚠️ THE CAUTION IS PREPENDED, NOT APPENDED. A model that truncates a
 * long description keeps the beginning. The warning that a tool writes
 * an extension-of-time document belongs where it survives truncation.
 */
export function describeForModel(tool: McpToolDefinition): string {
  return tool.caution ? `${tool.caution}\n\n${tool.description}` : tool.description;
}
