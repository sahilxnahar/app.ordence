/**
 * Ordence — What Platform Staff May See Across Tenants
 * Version: v0.14.0-alpha
 *
 * Pure. Defines the allow-list that `server/platform/search.ts` compiles
 * its queries from. There is no generic "search any table" path in this
 * phase, and that absence is the control.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE LINE, AND THE ARGUMENT FOR DRAWING IT HERE
 * ══════════════════════════════════════════════════════════════════════
 * A support engineer needs to answer questions like "which workspace is
 * priya@acme.com in", "why did invoice INV-2026-0042 fail", "is Acme on
 * the plan they think they are on". Those are answerable from records the
 * platform itself created about its own commercial relationship.
 *
 * They do NOT need to read Acme's contact notes. And the two are not on a
 * continuum — they are different categories of data with different legal
 * bases:
 *
 *   ┌─ PLATFORM RECORDS — visible, audited ────────────────────────────┐
 *   │ Tenant metadata, plan, status, seats, limits, health.            │
 *   │ Workspace USER identities: email, name, role, status.            │
 *   │ Subscriptions, invoices, payment state, invoice numbers.         │
 *   │ Audit and security METADATA: who did what, when — not payloads.  │
 *   │                                                                  │
 *   │ WHY: we are the CONTROLLER of these. We created them to bill and │
 *   │ provision. Support cannot function without them, and a customer  │
 *   │ asking "which of my people has admin?" expects us to know.       │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ CUSTOMER CONTENT — NOT visible, at any grade ───────────────────┐
 *   │ Contacts, companies, deals, custom object values, documents,     │
 *   │ contract text, journal narrations, uploaded files.               │
 *   │                                                                  │
 *   │ WHY: this is data about THIRD PARTIES who never had a            │
 *   │ relationship with us. Acme's client list is Acme's client list.  │
 *   │ We are a PROCESSOR for it; under DPDP, processing it for our own │
 *   │ convenience is processing without a basis. "It made the ticket   │
 *   │ faster" is not a purpose.                                        │
 *   │                                                                  │
 *   │ There is also a commercial argument that survives the legal one: │
 *   │ the first question in every enterprise security review is "can   │
 *   │ your staff read our data?". "Only with your recorded consent,    │
 *   │ inside a 60-minute audited session, and never by search" is an   │
 *   │ answer that wins deals. "Yes, if they have a reason" loses them. │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * ══════════════════════════════════════════════════════════════════════
 * SO WHAT HAPPENS WHEN SUPPORT GENUINELY NEEDS TO SEE A RECORD?
 * ══════════════════════════════════════════════════════════════════════
 * They impersonate — with the customer's consent, inside a session that
 * expires, wearing a banner, with every read attributable to them. That
 * path exists, is deliberate friction, and produces evidence. Search does
 * not, and must not, become a quiet second door to the same data with
 * none of those properties.
 *
 * ⚠️ ONE DELIBERATE EDGE. `documents` and `contracts` are searchable BY
 * IDENTIFIER ONLY (the id a customer quotes in a ticket), returning
 * existence, tenant and timestamps — never the title, never the bytes. A
 * customer who writes "document 8f2c… will not download" gets help; the
 * search cannot be used to enumerate what a workspace holds.
 */

/* ------------------------------------------------------------------ */
/* SCOPES                                                              */
/* ------------------------------------------------------------------ */

export const SEARCH_SCOPES = [
  "tenants",
  "workspace_users",
  "invoices",
  "subscriptions",
  "documents_by_id",
] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

export type ScopeDefinition = {
  label: string;
  /** Plain-language statement of what a result row contains. */
  returns: string;
  /**
   * Matching strategy.
   *   `exact`  — equality only. Used where a prefix search would be an
   *              enumeration tool (identifiers).
   *   `prefix` — case-insensitive starts-with. Never `%term%`: a
   *              contains-search on emails turns "a" into a customer list.
   */
  match: "exact" | "prefix";
  /** Minimum characters before the scope will run at all. */
  minLength: number;
  /** True when a result row can name a natural person. */
  containsPersonalData: boolean;
};

export const SCOPE_DEFINITIONS: Readonly<Record<SearchScope, ScopeDefinition>> =
  Object.freeze({
    tenants: {
      label: "Workspaces",
      returns: "Name, slug, plan, status, created date, seat and storage limits.",
      match: "prefix",
      minLength: 2,
      containsPersonalData: false,
    },
    workspace_users: {
      label: "Workspace members",
      returns: "Email, name, role and status of a user INSIDE a workspace.",
      match: "prefix",
      minLength: 3,
      containsPersonalData: true,
    },
    invoices: {
      label: "Invoices",
      returns: "Invoice number, tenant, status, totals and dates.",
      match: "exact",
      minLength: 4,
      containsPersonalData: false,
    },
    subscriptions: {
      label: "Subscriptions",
      returns: "Provider reference, tenant, plan, status and period.",
      match: "exact",
      minLength: 4,
      containsPersonalData: false,
    },
    documents_by_id: {
      label: "Document (by id)",
      returns:
        "Existence, owning tenant, size and timestamps. NEVER the filename or contents.",
      match: "exact",
      minLength: 8,
      containsPersonalData: false,
    },
  });

export function isSearchScope(value: unknown): value is SearchScope {
  return typeof value === "string" && (SEARCH_SCOPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* BOUNDS                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hard result cap.
 *
 * Not a page size — a CEILING, with no pagination past it. Pagination
 * would turn a bounded lookup into an export: fifty rows at a time,
 * repeated, is the whole customer directory. A search that hits the cap
 * tells the operator to narrow the query instead.
 */
export const MAX_RESULTS = 50;

/** Shortest query the search will accept at all. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Per-operator hourly budget.
 *
 * A support engineer runs a handful of lookups an hour. Two hundred is
 * not a support pattern; it is a scrape, and the budget turns that from
 * something noticed in a quarterly review into something refused at the
 * two-hundredth query.
 */
export const SEARCH_BUDGET_PER_HOUR = 200;

/**
 * Queries that are refused outright regardless of scope.
 *
 * These are the shapes that mean "give me everything" rather than "find
 * this one thing", and they are the difference between a lookup and a
 * dump.
 */
const WILDCARD_ONLY = /^[%*_\s.@-]*$/;

export type QueryVerdict =
  | { ok: true; normalised: string }
  | { ok: false; error: string };

export function validateQuery(raw: string, scope: SearchScope): QueryVerdict {
  const trimmed = raw.trim();

  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { ok: false, error: `Enter at least ${MIN_QUERY_LENGTH} characters.` };
  }
  if (WILDCARD_ONLY.test(trimmed)) {
    return {
      ok: false,
      error: "That query matches everything. Cross-tenant search is for finding one thing.",
    };
  }

  const def = SCOPE_DEFINITIONS[scope];
  if (trimmed.length < def.minLength) {
    return {
      ok: false,
      error: `${def.label} needs at least ${def.minLength} characters.`,
    };
  }

  return { ok: true, normalised: trimmed };
}

/**
 * Minimum length of the written justification attached to every search.
 *
 * ⚠️ THE JUSTIFICATION IS NOT A FORMALITY AND IT IS NOT A SPEED BUMP.
 * `withPlatformScope()` already refuses anything under ten characters. The
 * reason it is enforced again here, at a higher bar, is that the string
 * gets written verbatim into `audit_logs.reason` — and the value of a
 * cross-tenant access log is entirely determined by whether that column
 * says "ZD-4471 customer cannot find their invoice" or "checking".
 */
export const MIN_SEARCH_JUSTIFICATION = 15;

/* ------------------------------------------------------------------ */
/* REDACTION                                                           */
/* ------------------------------------------------------------------ */

/**
 * What gets written into the audit row for a search.
 *
 * ⚠️ THE SEARCH TERM ITSELF IS PERSONAL DATA. Logging
 * "priya@acme.com" verbatim across thousands of rows creates a second,
 * unbounded copy of customer identities inside a table that is retained
 * for years and exported to a SIEM.
 *
 * So the term is recorded PARTIALLY MASKED: enough to recognise the query
 * you ran during a review, not enough to be a directory in its own right.
 * The full term is never persisted anywhere.
 */
export function maskSearchTerm(term: string): string {
  const trimmed = term.trim();
  if (trimmed.includes("@")) {
    const [local = "", domain = ""] = trimmed.split("@");
    const head = local.slice(0, 2);
    return `${head}${local.length > 2 ? "…" : ""}@${domain}`;
  }
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 4)}…(${trimmed.length})`;
}
