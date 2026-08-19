/**
 * Ordence — ⭐⭐ THE CUSTOMER'S VIEW OF THEIR OWN AUDIT TRAIL
 * Version: v1.60.0-alpha (Batch 30)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, IN ONE PARAGRAPH
 * ══════════════════════════════════════════════════════════════════════
 * `audit_logs` has been written since Phase 1 and read by nobody outside
 * the platform console. This file is the half that turns a row into a
 * sentence: it classifies an event, names who did it, and produces text
 * a non-technical workspace owner can read without knowing what a
 * `resource_type` is.
 *
 * It is deliberately PURE — the same rule `lib/audit/chain.ts` sets for
 * itself. No `@/db`, no `server-only`, no `next/headers`. That is what
 * lets the client component, the server action and the test all share one
 * definition of what an event MEANS, instead of three that drift.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DECISION 1 — STAFF ACCESS IS THE POINT OF THE PAGE, NOT A FILTER
 * ══════════════════════════════════════════════════════════════════════
 * A customer-facing audit page that shows only what the customer's own
 * people did is a page that answers the easy question. The question an
 * enterprise security review actually asks — the one that decides the
 * deal — is "can YOUR staff see OUR data, and how would we know?"
 *
 * Three distinct things count as our staff touching their workspace, and
 * all three land in `audit_logs` with the tenant's own `tenant_id`, so
 * all three are readable inside the customer's RLS scope:
 *
 *   1. AN ACTION TAKEN INSIDE AN IMPERSONATION SESSION.
 *      `writeAudit()` stamps `impersonation_id`. See decision 2 — this
 *      is the dangerous one, because the actor columns name the
 *      CUSTOMER'S OWN EMPLOYEE.
 *
 *   2. A PLATFORM CONSOLE ACTION ATTRIBUTED TO THE TENANT.
 *      `recordPlatformAudit()` (server/platform/guard.ts) writes
 *      `actor_role = 'platform_<grade>'` and `metadata.source =
 *      'platform_console'` into the tenant's own chain — starting and
 *      stopping an impersonation session, break-glass write-ups,
 *      console-side reads and config overrides.
 *
 *   3. BREAK-GLASS. Not a separate mechanism — an impersonation mode —
 *      but it is recorded at `critical` severity and deserves its own
 *      wording, because it is the one that happened WITHOUT consent.
 *
 * ⚠️ AND THE ONE WE CANNOT SHOW, SAID OUT LOUD RATHER THAN OMITTED.
 * A platform action with NO tenant attribution (`tenantId: null` —
 * capability denials, step-ups, cross-tenant searches) cannot go in
 * `audit_logs` at all: the RLS `WITH CHECK` evaluates `NULL = NULL` to
 * NULL and refuses it, so those rows live in `platform_action_log`,
 * which has no `tenant_id` and is not readable from a tenant scope.
 * `STAFF_ACCESS_COVERAGE` below is the sentence the page prints about
 * that. A page that silently omitted a category would be worse than one
 * that names it.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DECISION 2 — UNDER IMPERSONATION, `actor_email` IS THE CUSTOMER'S
 *     OWN EMPLOYEE. RENDERING IT PLAIN IS AN ACTIVE LIE.
 * ══════════════════════════════════════════════════════════════════════
 * `getImpersonatedTenantContext()` resolves the session's SUBJECT — a
 * real `users` row inside the customer's tenant — and hands it to
 * `requireTenantContext()` as `ctx.user`. `writeAudit()` then writes
 * `actorEmail: ctx.user.email`. So an invoice edited by our engineer
 * during a support session is recorded as:
 *
 *     actor_email      priya@customer.example      ← their employee
 *     actor_role       member                       ← their employee's role
 *     impersonation_id 8f3c…                        ← the ONLY tell
 *
 * The real operator's address is on the context as `operatorEmail` and
 * is never persisted to this table. (Reported, not fixed — `server/`
 * audit.ts and server/platform/** are not this batch's files.)
 *
 * ⭐ SO THIS FILE REFUSES TO PRINT `actor_email` AS "WHO DID IT"
 * WHENEVER `impersonationId` IS SET. It prints "Ordence support" as the
 * actor and the employee's address as "acting as", and it recovers the
 * operator's real address from the session's OWN audit row — the
 * `impersonate` row that `startImpersonation()` writes into this same
 * tenant's log with `resource_id = <session id>` and the operator's
 * address in `actor_email`. Same table, same tenant, same RLS scope: no
 * platform read is needed to name the human. See `resolveStaffAccess()`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 DECISION 3 — WHAT THE HASH CHAIN PROVES, WORDED FOR A CUSTOMER
 * ══════════════════════════════════════════════════════════════════════
 * Migration 0081 chains the rows with SHA-256 AND NO SECRET. An attacker
 * with UPDATE on the table can edit row N, recompute row N, and
 * recompute every row after it, and the chain verifies perfectly. The
 * word "tamper-proof" on a page a customer relies on is therefore a
 * claim that fails in precisely the moment it is needed — the moment
 * somebody with database access is the problem.
 *
 * `CHAIN_CLAIM` below is the exact wording the page prints. It says
 * tamper-EVIDENT, it says evident against WHOM (an editor who does not
 * rewrite the tail), it names the anchor that would close the gap, and
 * it says the anchor does not exist yet. Every one of those sentences is
 * load-bearing; softening any of them turns an honest control into a
 * marketing claim.
 */

/* ================================================================== */
/* THE ROW, AS READ                                                    */
/* ================================================================== */

/**
 * The columns the reader selects. Deliberately NOT `AuditLog` from the
 * schema: `old_value` and `new_value` are whole-record snapshots and
 * `ip_address`/`user_agent` are forensics. Neither belongs in a payload
 * shipped to a browser tab that anybody in the workspace with
 * `audit:read` can open, and a `select *` is how they get there.
 */
export type RawAuditRow = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  severity: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  impersonationId: string | null;
  /** NULL means the row is outside the 0081 chain. See `attestationOf()`. */
  chainSeq: number | null;
  createdAt: Date;
};

/**
 * One impersonation session, as recovered from this tenant's OWN audit
 * rows (`resource_type = 'impersonation_session'`). Never from the
 * platform tables — see decision 2.
 */
export type SessionFacts = {
  sessionId: string;
  operatorEmail: string | null;
  /** `break_glass` | `standing_consent` | `incident_consent`, if recorded. */
  mode: string | null;
  /** The written justification the operator had to supply. */
  justification: string | null;
};

/* ================================================================== */
/* CATEGORIES                                                          */
/* ================================================================== */

/**
 * ⭐ THE CATEGORIES ARE THE CUSTOMER'S QUESTIONS, NOT OUR COLUMN NAMES.
 *
 * `audit_action` has thirteen values and `resource_type` is open-ended
 * `varchar(100)` with roughly two hundred values in the codebase today.
 * A filter built from either is a filter nobody uses. These five are the
 * questions people actually arrive with.
 *
 * ⚠️ `staff_access` IS FIRST AND IT IS NOT ALPHABETICAL. It is the
 * reason the page exists.
 */
export const AUDIT_CATEGORIES = [
  "staff_access",
  "everything",
  "security",
  "changes",
  "sign_in",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<AuditCategory, string>> = Object.freeze({
  staff_access: "Ordence staff access",
  everything: "Everything",
  security: "Security and permissions",
  changes: "Changes to records",
  sign_in: "Sign-ins",
});

export function isAuditCategory(value: unknown): value is AuditCategory {
  return typeof value === "string" && (AUDIT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The `audit_action` values behind each category.
 *
 * ⚠️ `staff_access` IS ABSENT FROM THIS MAP ON PURPOSE. Staff access is
 * not an action — our people `create`, `update` and `read` like anybody
 * else. It is identified by `impersonation_id IS NOT NULL` or an
 * `actor_role` of `platform_*`, which is a predicate over different
 * columns entirely, and the reader builds it in SQL. Putting a fake
 * action list here would have produced a filter that quietly matched
 * only the two `impersonate` rows and missed every action taken during
 * the session — which is every row that matters.
 */
export const CATEGORY_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  security: ["security_event", "permission_change", "role_change", "login_failed"],
  changes: ["create", "update", "delete", "config_change"],
  sign_in: ["login", "logout", "login_failed"],
});

/* ================================================================== */
/* STAFF ACCESS                                                        */
/* ================================================================== */

export type StaffAccessKind = "impersonation" | "break_glass" | "console";

export type StaffAccess = {
  kind: StaffAccessKind;
  /** Our engineer's address, when it can be established. */
  operatorEmail: string | null;
  /** The customer's own user whose view was reproduced. */
  actingAs: string | null;
  sessionId: string | null;
  justification: string | null;
};

/** `platform_owner`, `platform_engineer`, … — written by `recordPlatformAudit()`. */
export function isPlatformActorRole(actorRole: string | null | undefined): boolean {
  return typeof actorRole === "string" && actorRole.startsWith("platform_");
}

/**
 * Decide whether a row is Ordence staff touching this workspace, and say
 * as much about the human as the tenant's own rows can support.
 *
 * ⚠️ THE ORDER OF THE TWO BRANCHES MATTERS. A console row written DURING
 * a session carries BOTH a `platform_*` role and an `impersonation_id`
 * (see `startImpersonation()`), and for that row `actor_email` is
 * genuinely the operator. Testing `impersonationId` first would label our
 * own operator as "acting as themselves" and lose their address.
 */
export function resolveStaffAccess(
  row: Pick<RawAuditRow, "actorEmail" | "actorRole" | "impersonationId" | "metadata" | "severity">,
  sessions: ReadonlyMap<string, SessionFacts> = new Map(),
): StaffAccess | null {
  const session = row.impersonationId ? sessions.get(row.impersonationId) ?? null : null;
  const fromConsole =
    isPlatformActorRole(row.actorRole) || row.metadata?.["source"] === "platform_console";

  if (fromConsole) {
    return {
      kind: session?.mode === "break_glass" ? "break_glass" : "console",
      operatorEmail: row.actorEmail,
      actingAs: null,
      sessionId: row.impersonationId,
      justification: session?.justification ?? null,
    };
  }

  if (row.impersonationId) {
    return {
      /**
       * ⭐ BREAK-GLASS IS NAMED SEPARATELY BECAUSE IT IS THE ONE THAT
       * HAPPENED WITHOUT THE CUSTOMER'S PERMISSION. Folding it in with
       * consented support would mean the row a customer most needs to
       * find reads exactly like the fifty routine ones above it.
       */
      kind: session?.mode === "break_glass" ? "break_glass" : "impersonation",
      operatorEmail: session?.operatorEmail ?? null,
      // 🔴 Decision 2: under impersonation `actor_email` is THEIR
      // employee, so it is reported as the face worn, never as the actor.
      actingAs: row.actorEmail,
      sessionId: row.impersonationId,
      justification: session?.justification ?? null,
    };
  }

  return null;
}

/**
 * Pull the session facts out of the `impersonation_session` rows that
 * live in this tenant's own log.
 *
 * ⚠️ START AND STOP BOTH PRODUCE A ROW FOR THE SAME `resource_id`. The
 * START row is the one with the justification and the mode, so a later
 * row must not overwrite a field the earlier one filled — hence the
 * `??` merge rather than a plain overwrite. Getting this backwards
 * blanks the justification on every closed session, which is every
 * session a customer reviews after the fact.
 */
export function collectSessionFacts(rows: readonly RawAuditRow[]): Map<string, SessionFacts> {
  const out = new Map<string, SessionFacts>();

  for (const row of rows) {
    if (row.resourceType !== "impersonation_session" || !row.resourceId) continue;

    const previous = out.get(row.resourceId);
    const mode = readString(row.metadata?.["mode"]) ?? readString(row.metadata?.["modeLabel"]);
    const breakGlass = row.metadata?.["breakGlass"] === true || row.severity === "critical";

    out.set(row.resourceId, {
      sessionId: row.resourceId,
      operatorEmail: previous?.operatorEmail ?? row.actorEmail,
      mode: previous?.mode ?? (breakGlass ? "break_glass" : mode),
      justification: previous?.justification ?? row.reason,
    });
  }

  return out;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* ================================================================== */
/* DATES — ASIA/KOLKATA, ALWAYS                                        */
/* ================================================================== */

const IST = "Asia/Kolkata";

/**
 * ⚠️ UTC IS YESTERDAY FOR THE FIRST 5.5 HOURS OF AN INDIAN DAY.
 *
 * An audit page is read to answer "what happened on the 14th". Printing
 * `createdAt.toISOString()` puts everything between 00:00 and 05:30 IST
 * on the previous date, so a login at 02:00 on the 14th is filed under
 * the 13th — and the one time anybody checks is during an incident,
 * when being a day out is the whole argument.
 */
export function formatIstDateTime(when: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(when);
}

/** `YYYY-MM-DD` in India, for grouping and for filenames. */
export function istDay(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

/**
 * The UTC instant at which an Indian civil day begins.
 *
 * ⚠️ `new Date("2026-08-15")` IS MIDNIGHT UTC, which is 05:30 on the
 * 15th in India — so a filter "from the 15th" built that way silently
 * drops every event in the first five and a half hours of the day the
 * customer asked about. The explicit `+05:30` offset is the fix, and it
 * is a constant because India has no daylight saving.
 */
export function istDayStartUtc(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Exclusive upper bound for an INCLUSIVE "to this day" filter. */
export function istDayEndUtc(day: string): Date | null {
  const start = istDayStartUtc(day);
  return start === null ? null : new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/* ================================================================== */
/* KEYSET CURSOR                                                       */
/* ================================================================== */

export type AuditCursor = { createdAt: Date; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * ⭐ WHY A CURSOR AND NOT A PAGE NUMBER.
 *
 * `audit_logs` grows without bound and is never pruned — it is
 * append-only by trigger. `OFFSET 20000` makes PostgreSQL walk and
 * discard twenty thousand rows before returning fifty, so the cost of
 * page 400 is paid on every page after it, forever, on the busiest
 * workspaces (which are the ones whose audit trail gets reviewed).
 *
 * ⚠️ AND OFFSET IS WRONG, NOT MERELY SLOW, ON AN APPEND-ONLY TABLE THAT
 * SORTS NEWEST-FIRST. Rows arrive at the head while somebody reads, so
 * every insert shifts the window by one and page 2 re-shows the last row
 * of page 1. On an audit trail that is not cosmetic: a reviewer paging
 * through an incident sees duplicates and, worse, MISSES rows that slid
 * past the boundary.
 *
 * The key is `(created_at, id)`, which is the leading edge of
 * `audit_logs_tenant_created_idx` plus a unique tiebreak. `created_at`
 * alone is NOT unique — a batch job writes several rows in the same
 * millisecond — and a keyset on a non-unique key skips rows at exactly
 * the boundary it is meant to protect.
 *
 * 🔴 AND NOT `chain_seq`, WHICH IS THE TEMPTING CHOICE. It is unique per
 * tenant, dense, and has its own index. It is also NULL on every row
 * `recordPlatformAudit()` writes — which is every platform-console row,
 * i.e. every staff-access row this page exists to show — and NULL on
 * every row written before 0081 and every row degraded under contention.
 * A keyset on `chain_seq` would have produced a staff-access page that
 * omits staff access, and it would have looked like it worked.
 */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return `${cursor.createdAt.toISOString()}~${cursor.id}`;
}

/**
 * Returns null for anything malformed, and the caller starts at the head.
 *
 * ⚠️ A CURSOR IS CLIENT-SUPPLIED INPUT. It carries no tenant and no
 * permission — it only says "resume here" — so the worst a forged one
 * can do is start the reader at a different point in THIS tenant's rows,
 * which the reader's own `tenant_id` predicate and RLS both still bound.
 * It is still parsed strictly, because a `Date` built from garbage is
 * `Invalid Date` and comparing against it silently matches nothing.
 */
export function decodeAuditCursor(raw: unknown): AuditCursor | null {
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("~");
  if (at <= 0) return null;

  const createdAt = new Date(raw.slice(0, at));
  const id = raw.slice(at + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) return null;

  return { createdAt, id };
}

/* ================================================================== */
/* FILTERS                                                             */
/* ================================================================== */

export type AuditFilters = {
  category: AuditCategory;
  /** Inclusive civil day in India, `YYYY-MM-DD`, or null. */
  from: string | null;
  to: string | null;
  /** Substring of the actor's email address. */
  actor: string | null;
  cursor: AuditCursor | null;
};

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE_MAX = 100;

/**
 * ⭐⭐ THE FILTER PARSER IS PURE, AND IT IS THE ONLY WAY IN.
 *
 * 🔴 THERE IS NO `tenantId` FIELD HERE AND THERE MUST NEVER BE ONE.
 * Every export of a `"use server"` module is a URL anybody who has
 * loaded the app can `curl`. `server/actions/notifications.ts` was
 * exactly this shape in v005 — it took `tenantId` from the caller and
 * handed it to `withTenant()`, which is the single route past RLS,
 * because row-level security enforces the tenant THE TRANSACTION
 * DECLARES. The reader takes its tenant from `requirePermission()`'s
 * context and from nowhere else, and this type is what makes that
 * mechanically true rather than merely intended.
 *
 * ⚠️ EVERY FIELD IS NARROWED TO A CLOSED SET OR A SHAPE. `category` must
 * be one of five constants, the dates must match `YYYY-MM-DD`, and
 * `actor` is length-capped and has its LIKE metacharacters escaped by
 * the reader. An unrecognised value falls back to the default rather
 * than being passed through — a filter that silently ignores a value it
 * does not understand shows MORE rows than asked for, which on this page
 * is the safe direction.
 */
export function parseAuditFilters(input: unknown): AuditFilters {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;

  const category = isAuditCategory(raw["category"]) ? raw["category"] : "everything";
  const actorRaw = typeof raw["actor"] === "string" ? raw["actor"].trim().slice(0, 320) : "";

  return {
    category,
    from: civilDayOrNull(raw["from"]),
    to: civilDayOrNull(raw["to"]),
    actor: actorRaw === "" ? null : actorRaw,
    cursor: decodeAuditCursor(raw["cursor"]),
  };
}

function civilDayOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * ⚠️ `%` AND `_` ARE WILDCARDS IN `LIKE`. A customer typing `a_b@` into
 * the actor box would otherwise match `axb@`, which is not wrong so much
 * as inexplicable — and an audit filter that returns rows the user did
 * not ask for is the wrong direction to be surprising in.
 */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/* ================================================================== */
/* THE SENTENCE                                                        */
/* ================================================================== */

export type EventTone = "staff" | "alarm" | "notice" | "plain";

export type AuditDetail = { label: string; value: string };

export type AuditEventView = {
  id: string;
  /** One sentence. Never contains JSON, never contains an object. */
  headline: string;
  /** "Ordence support", "priya@…", "An automated job". Never blank. */
  actor: string;
  /** Set only for staff access — the extra line the customer needs. */
  staffNote: string | null;
  when: string;
  day: string;
  tone: EventTone;
  category: AuditCategory;
  isStaffAccess: boolean;
  /** ⭐ Never raw metadata. Scalars only, humanised, capped. */
  details: AuditDetail[];
  attested: boolean;
  /** The reason a human typed, when there was one. */
  reason: string | null;
};

/**
 * ⚠️ `resource_type` IS OPEN-ENDED `varchar(100)`. This table covers the
 * ones whose de-snaked form reads badly to an Indian business owner —
 * "gst return" and "ra bill" are not what those are called. Anything not
 * listed falls through to `humaniseResourceType()`, which is why a new
 * module can ship without touching this file and still produce a
 * readable page.
 */
const RESOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  boq: "BOQ",
  boq_variation: "BOQ variation",
  eway_bill: "e-way bill",
  gst_return: "GST return",
  gstr1_return: "GSTR-1 return",
  itc_register: "ITC register",
  ra_bill: "RA bill",
  tds_challan: "TDS challan",
  tds_return: "TDS return",
  hsn_code: "HSN code",
  msme_declaration: "MSME declaration",
  impersonation_session: "support session",
  platform_capability: "platform permission",
  saved_view: "saved view",
  api_key: "API key",
  sales_invoice: "sales invoice",
  purchase_invoice: "purchase bill",
  tenant: "workspace",
  user: "team member",
});

export function humaniseResourceType(resourceType: string): string {
  const known = RESOURCE_LABELS[resourceType];
  if (known) return known;

  const words = resourceType
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.\-]+/g, " ")
    .trim()
    .toLowerCase();

  return words === "" ? "record" : words;
}

/**
 * The per-action wording.
 *
 * ⚠️ A `Record<AuditAction, …>` WOULD HAVE BEEN THE TYPED CHOICE AND IS
 * THE WRONG ONE. `action` arrives from the database as a string; the
 * enum can gain a value in a migration written by somebody who never
 * opens this file, and an exhaustive map would then throw or render
 * `undefined` on a page whose entire job is to be trustworthy. A lookup
 * with an honest fallback degrades instead — see `describeAuditEvent()`.
 */
const ACTION_SENTENCE: Readonly<Record<string, (what: string) => string>> = Object.freeze({
  create: (what) => `Created a ${what}`,
  update: (what) => `Changed a ${what}`,
  delete: (what) => `Deleted a ${what}`,
  read: (what) => `Looked at a ${what}`,
  export: (what) => `Downloaded ${what} data`,
  login: () => "Signed in",
  logout: () => "Signed out",
  login_failed: () => "A sign-in attempt was refused",
  permission_change: (what) => `Changed what someone may do with ${what}`,
  role_change: () => "Changed someone's role",
  config_change: (what) => `Changed the ${what} settings`,
  impersonate: () => "Ordence support opened a session in this workspace",
  security_event: (what) => `Security event on ${what}`,
});

/**
 * ⭐ METADATA IS NEVER RENDERED AS JSON, AND THIS IS THE WHOLE RULE.
 *
 * `metadata` is `jsonb` with no schema. `JSON.stringify()` on it
 * produces `{"periodId":"0f2…","closedBy":"…"}` in a table cell, which
 * is not a customer-facing screen — it is a database viewer with a
 * stylesheet. Worse, React THROWS on an object child, so a nested value
 * rendered directly crashes the page rather than looking ugly.
 *
 * So: scalars only, keys humanised, values length-capped, and a
 * non-scalar summarised by shape ("3 items") rather than serialised.
 * Nothing here can produce an object, and nothing here can produce an
 * unbounded string.
 */
const DETAIL_LIMIT = 6;
const DETAIL_VALUE_MAX = 120;

/** Keys that are ours, not theirs, or that are already said elsewhere. */
const DETAIL_SKIP = new Set([
  "source",
  "operatorGrade",
  "mode",
  "modeLabel",
  "breakGlass",
  "reason",
]);

export function describeMetadata(metadata: Record<string, unknown> | null): AuditDetail[] {
  if (!metadata) return [];

  const out: AuditDetail[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (out.length >= DETAIL_LIMIT) break;
    if (DETAIL_SKIP.has(key)) continue;

    const rendered = renderScalar(value);
    if (rendered === null) continue;

    out.push({ label: humaniseKey(key), value: rendered });
  }
  return out;
}

/**
 * ⚠️ `bigint` IS HANDLED AND `Number()` IS NOT USED ON IT. Money in
 * Ordence is minor units in a `bigint`; `Number(value)` on one is a
 * silent precision loss above 2^53 paise and a habit that spreads.
 * `String(value)` is exact and this is a display path, so exact is all
 * that is wanted.
 */
function renderScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(value.trim() === "" ? "—" : value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value.length === 1 ? "1 item" : `${value.length} items`;
  }
  if (typeof value === "object") {
    const count = Object.keys(value as Record<string, unknown>).length;
    return count === 1 ? "1 field" : `${count} fields`;
  }
  return null;
}

function truncate(value: string): string {
  return value.length <= DETAIL_VALUE_MAX ? value : `${value.slice(0, DETAIL_VALUE_MAX - 1)}…`;
}

function humaniseKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.\-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * 🔴 THE ATTESTATION FLAG IS PER ROW, NOT PER PAGE.
 *
 * `chain_seq IS NULL` means the row is outside the 0081 chain: written
 * before the migration, degraded under write contention, or — and this
 * is the one that matters here — written by `recordPlatformAudit()`,
 * which inserts into `audit_logs` directly and never calls the chained
 * appender. Every staff-access row is therefore currently UNATTESTED,
 * and a page that printed one green tick over the whole table would be
 * asserting the opposite of the truth about exactly the rows a customer
 * came to check.
 */
export function attestationOf(row: Pick<RawAuditRow, "chainSeq">): boolean {
  return row.chainSeq !== null && row.chainSeq !== undefined;
}

export function categoryOf(row: RawAuditRow, staff: StaffAccess | null): AuditCategory {
  if (staff) return "staff_access";
  if (CATEGORY_ACTIONS["security"]?.includes(row.action)) return "security";
  if (CATEGORY_ACTIONS["sign_in"]?.includes(row.action)) return "sign_in";
  if (CATEGORY_ACTIONS["changes"]?.includes(row.action)) return "changes";
  return "everything";
}

/**
 * Turn one row into one sentence.
 *
 * 🔴 THE UNKNOWN-ACTION PATH IS THE IMPORTANT ONE. `audit_action` is a
 * PostgreSQL enum that a future migration will extend, and this page is
 * the last thing anybody remembers to update. The choices were:
 *
 *   throw            — a new event kind takes down the audit page, and
 *                      it does so for every customer at once.
 *   print the row    — `[object Object]`, or JSON, on a compliance page.
 *   ⭐ say so plainly — chosen. The customer is told an event was
 *                      recorded, told what it touched, told when, and
 *                      told that we do not yet have wording for it. That
 *                      is a true statement, it is not alarming, and the
 *                      row is still exportable and still counted.
 */
export function describeAuditEvent(
  row: RawAuditRow,
  sessions: ReadonlyMap<string, SessionFacts> = new Map(),
): AuditEventView {
  const staff = resolveStaffAccess(row, sessions);
  const what = humaniseResourceType(row.resourceType);
  const sentence = ACTION_SENTENCE[row.action];

  const headline = sentence
    ? sentence(what)
    : `Recorded an event on a ${what} of a kind this page does not have wording for yet ` +
      `(“${row.action}”)`;

  const { actor, staffNote } = describeActor(row, staff);

  return {
    id: row.id,
    headline,
    actor,
    staffNote,
    when: formatIstDateTime(row.createdAt),
    day: istDay(row.createdAt),
    tone: toneOf(row, staff),
    category: categoryOf(row, staff),
    isStaffAccess: staff !== null,
    details: describeMetadata(row.metadata),
    attested: attestationOf(row),
    reason: row.reason,
  };
}

function describeActor(
  row: RawAuditRow,
  staff: StaffAccess | null,
): { actor: string; staffNote: string | null } {
  if (staff) {
    const who = staff.operatorEmail ?? "an Ordence staff member we cannot name from this log";
    const base = `Ordence support (${who})`;

    if (staff.kind === "break_glass") {
      return {
        actor: base,
        staffNote:
          "EMERGENCY ACCESS. This was taken under break-glass — without your " +
          "permission, read-only, time-limited, and your workspace owners were " +
          "emailed when it started." +
          (staff.justification ? ` Reason given: “${staff.justification}”` : ""),
      };
    }

    if (staff.kind === "impersonation") {
      return {
        actor: base,
        staffNote:
          `Taken inside a support session, using ${staff.actingAs ?? "one of your accounts"}` +
          "’s view of your workspace. The name on the record below is your " +
          "colleague's because that is whose view was reproduced — the action " +
          "was ours." +
          (staff.justification ? ` Reason given: “${staff.justification}”` : ""),
      };
    }

    return {
      actor: base,
      staffNote:
        "Taken from the Ordence support console against your workspace." +
        (staff.justification ? ` Reason given: “${staff.justification}”` : ""),
    };
  }

  if (row.actorRole === "system") {
    return { actor: row.actorEmail ?? "An automated job", staffNote: null };
  }

  return { actor: row.actorEmail ?? "Someone in your workspace", staffNote: null };
}

function toneOf(row: RawAuditRow, staff: StaffAccess | null): EventTone {
  if (staff?.kind === "break_glass" || row.severity === "critical") return "alarm";
  if (staff) return "staff";
  if (row.severity === "warning" || row.action === "login_failed") return "notice";
  return "plain";
}

/* ================================================================== */
/* WHAT WE CLAIM                                                       */
/* ================================================================== */

/**
 * 🔴 THE EXACT WORDS THE PAGE PRINTS ABOUT THE HASH CHAIN.
 *
 * They live here, as data, so the test can assert on them and so nobody
 * "tightens the copy" in a JSX file into a claim we cannot support.
 * Read `SQL-FILES/0081_audit_hash_chain.sql` before changing a word.
 */
export const CHAIN_CLAIM = Object.freeze({
  heading: "What this record can and cannot prove",
  evident:
    "Each entry is sealed with a fingerprint that includes the fingerprint of the " +
    "entry before it, so changing or removing one entry breaks every entry after " +
    "it. That makes editing this log DETECTABLE.",
  /**
   * ⚠️ THE SENTENCE THAT MUST NOT BE SOFTENED. SHA-256 with no secret:
   * anybody who can rewrite one row can rewrite the whole tail and the
   * chain verifies perfectly. "Tamper-proof" would be false, and false
   * in the one moment somebody is relying on it.
   */
  notProof:
    "It is tamper-EVIDENT, not tamper-proof. Someone with direct database access " +
    "who rewrote every later entry as well would produce a log that still checks " +
    "out. What the seal changes is the cost: a one-line edit becomes a rewrite of " +
    "everything since.",
  anchor:
    "Closing that gap needs a copy of the latest fingerprint kept somewhere we " +
    "cannot reach — your own inbox, or storage you control. We do not do that yet, " +
    "and we would rather say so here than let you assume it.",
  unattested:
    "Entries marked “not sealed” are outside that chain: they were recorded before " +
    "sealing was introduced, or under load, or by our support console, which does " +
    "not seal its entries yet. They are genuine records; they are simply not " +
    "covered by the fingerprint.",
});

/**
 * 🔴 WHAT THIS PAGE COVERS, AND WHAT IT DOES NOT. Printed, not omitted.
 */
export const STAFF_ACCESS_COVERAGE = Object.freeze({
  heading: "Ordence staff and your data",
  covered:
    "Every action our staff took inside your workspace appears here: support " +
    "sessions, emergency access, and anything done from our support console " +
    "against your account.",
  /**
   * ⚠️ The honest omission. `recordPlatformAudit()` routes rows with no
   * tenant attribution to `platform_action_log`, which has no
   * `tenant_id` and cannot be read from a tenant scope — reading it here
   * would mean a `withPlatformScope()` call on a customer-facing page,
   * which is the one thing this page must never contain.
   */
  notCovered:
    "Things we do that are not about your workspace specifically — platform-wide " +
    "maintenance, or a staff member being refused a permission — are recorded in " +
    "our own internal log and are not shown here, because those records are not " +
    "attached to your account.",
});

/* ================================================================== */
/* EXPORT                                                              */
/* ================================================================== */

export const AUDIT_CSV_HEADERS = [
  "Date and time (IST)",
  "What happened",
  "Who",
  "Ordence staff?",
  "Acting as",
  "Category",
  "Severity",
  "Reason given",
  "Record type",
  "Record id",
  "Sealed",
  "Chain position",
] as const;

/**
 * ⚠️ CSV INJECTION. A cell beginning `=`, `+`, `-`, `@`, a tab or a CR
 * is executed as a formula when the file is opened in Excel, and this
 * file is FULL of tenant-typed strings — `reason` is free text somebody
 * else typed. Prefixing with an apostrophe is the standard neutraliser
 * and keeps the value readable.
 *
 * ⭐ THE ROW CONTENT IS THE SAME `describeAuditEvent()` THE SCREEN USES.
 * A separate formatter for the export is how the file a customer hands
 * their auditor comes to disagree with the page they were reading.
 */
export function toCsvCell(value: string | null | undefined): string {
  const raw = value ?? "";
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function auditCsvRow(row: RawAuditRow, sessions: ReadonlyMap<string, SessionFacts>): string {
  const view = describeAuditEvent(row, sessions);
  const staff = resolveStaffAccess(row, sessions);

  return [
    toCsvCell(formatIstDateTime(row.createdAt)),
    toCsvCell(view.headline),
    toCsvCell(view.actor),
    toCsvCell(staff ? staffKindLabel(staff.kind) : "no"),
    toCsvCell(staff?.actingAs ?? ""),
    toCsvCell(CATEGORY_LABELS[view.category]),
    toCsvCell(row.severity),
    toCsvCell(row.reason ?? ""),
    toCsvCell(row.resourceType),
    toCsvCell(row.resourceId ?? ""),
    toCsvCell(view.attested ? "sealed" : "not sealed"),
    // Never `Number()`, never a float — it is a bigint position.
    toCsvCell(row.chainSeq === null ? "" : String(row.chainSeq)),
  ].join(",");
}

export function staffKindLabel(kind: StaffAccessKind): string {
  if (kind === "break_glass") return "yes — emergency access";
  if (kind === "impersonation") return "yes — support session";
  return "yes — support console";
}

export function auditCsvHeader(): string {
  /**
   * ⚠️ A BOM. Excel on Windows reads a UTF-8 CSV without one as
   * cp1252, which turns every rupee sign and every name with a
   * diacritic into mojibake in the file a customer sends to a regulator.
   */
  return `﻿${AUDIT_CSV_HEADERS.map((h) => toCsvCell(h)).join(",")}`;
}

export function auditExportFilename(now: Date): string {
  return `ordence-audit-trail-${istDay(now)}.csv`;
}
