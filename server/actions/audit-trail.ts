"use server";

/**
 * Ordence — ⭐⭐ THE CUSTOMER'S AUDIT TRAIL: THE READER
 * Version: v1.60.0-alpha (Batch 30)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 RLS ALONE DOES NOT MAKE THIS FILE SAFE, AND THAT IS THE WHOLE POINT
 * ══════════════════════════════════════════════════════════════════════
 * `audit_logs` is under RLS with a policy of `tenant_id =
 * app_current_tenant_id()`. It is easy to read that and conclude the
 * reader cannot leak. Two things break that conclusion:
 *
 *   1. THE POLICY IS SATISFIED BY A LEAKING QUERY EXACTLY AS BY A
 *      CORRECT ONE. Every colleague's row — every row about anybody in
 *      the workspace — is in the same tenant. RLS draws the boundary
 *      between COMPANIES, and this page's second boundary, between what
 *      a reader may see of their own company, is drawn by the
 *      permission check and by which columns are selected. Nothing in
 *      the database enforces it.
 *
 *   2. RLS IS NOT EVEN ARMED UNDER PLATFORM SCOPE.
 *      `withPlatformScope()` sets `app.platform_scope`, and the policies
 *      let that through by design. One convenience call — "just read the
 *      operator's name from `platform_impersonation_sessions`" — and
 *      this page becomes a cross-tenant reader with a customer-facing
 *      URL. So this file contains NO `withPlatformScope` and no `db`
 *      import at all: every statement runs inside
 *      `withTenant(ctx.tenant.id, …)`, and `tests/ui/
 *      customer-audit-view.test.ts` asserts the absence.
 *
 * ⭐ AND THE `tenant_id` PREDICATE IS WRITTEN OUT ANYWAY. It is
 * redundant while the policy holds — which is the argument for writing
 * it: if the policy is ever dropped, disabled, or the read is ever moved
 * under platform scope by somebody in a hurry, the predicate is the
 * thing still standing. Belt AND braces, on the one page whose failure
 * mode is "customer A reads customer B".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY EXPORT HERE IS A URL
 * ══════════════════════════════════════════════════════════════════════
 * `"use server"` publishes each export as a browser-reachable RPC
 * endpoint with a stable id. Both exports call `requirePermission
 * ("audit:read")` on their FIRST line — in this file, one hop from the
 * export, where `check:guards` can see it and where a future refactor of
 * anything downstream cannot quietly remove it.
 */

import { and, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { withTenant } from "@/db";
import { auditLogs } from "@/db/schema";
import {
  requireAllPermissions,
  requirePermission,
  writeAudit,
  type AuditAction,
} from "@/server/audit";
import {
  AUDIT_PAGE_SIZE,
  AUDIT_PAGE_SIZE_MAX,
  CATEGORY_ACTIONS,
  auditCsvHeader,
  auditCsvRow,
  auditExportFilename,
  collectSessionFacts,
  describeAuditEvent,
  encodeAuditCursor,
  escapeLikeLiteral,
  istDayEndUtc,
  istDayStartUtc,
  parseAuditFilters,
  type AuditEventView,
  type AuditFilters,
  type RawAuditRow,
  type SessionFacts,
} from "@/lib/audit/customer-view";

/**
 * ⭐ READING THE PAGE. Held by `tenant_owner`, `tenant_admin`,
 * `security_admin`, `accountant` and `manager` — the roles that have a
 * reason to ask who did something.
 */
const AUDIT_READ = "audit:read" as const;

/**
 * ⭐⭐ THE EXPORT ASKS FOR MORE, AND THE ARGUMENT WENT BOTH WAYS.
 *
 * The first version guarded the download with `audit:read` alone, on the
 * reasoning that the CSV contains exactly the rows the page already
 * renders — anybody who can read the screen can page through it with the
 * same endpoint in a loop, so a second key withholds nothing and only
 * makes the honest path harder than the dishonest one.
 *
 * ⚠️ `check:guards` DISAGREED, AND ON REFLECTION IT IS RIGHT. Its rule —
 * "a write behind a read key" — exists because `exportWorkspace` sat
 * behind `settings:read` for months while returning 26 tables including
 * this one. The shape it recognises is exactly this shape: a bulk
 * download of everything, gated on the permission to look at one page of
 * it. "They could scrape it anyway" is the argument that lost that time
 * too.
 *
 * 🔴 AND THE CONTENT IS NOT THE PAGE. A complete audit CSV is the
 * movement history of every named person in the company — who signed in
 * from where, at what hour, what they touched, and when they stopped.
 * That is a different object from fifty rows on a screen, and handing it
 * to an outside party is an owner's decision.
 *
 * ⚠️ THE COST, STATED PLAINLY: `security_admin` holds `audit:read` and
 * NOT `workspace:export`, so the role whose entire job is reviewing
 * access can read every row and cannot download them. They are not
 * blocked from the work — the page is unfiltered for them — but handing
 * the file to an external auditor now needs an owner or an admin.
 *
 * ⭐ THE RIGHT LONG-TERM ANSWER IS A NARROWER KEY, `audit:export`,
 * granted to `security_admin` alongside the owner and admin, so that
 * pulling the access log is neither a full workspace dump nor an
 * ordinary read. Adding a permission key is not this batch's to make —
 * it is REPORTED rather than invented, and this pair is the closest
 * correct thing in the existing catalogue.
 */
const AUDIT_EXPORT = ["audit:read", "workspace:export"] as const;

/** Hard stop on one export. See `exportAuditTrail`. */
const MAX_EXPORT_ROWS = 50_000;
const EXPORT_BATCH = 1_000;

export type AuditPage = {
  events: AuditEventView[];
  /** Opaque keyset cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /**
   * ⚠️ NO TOTAL COUNT, AND THAT IS THE SAME DECISION AS NO OFFSET.
   * `count(*)` over an append-only table that is never pruned is a full
   * index scan on every page load, and it grows for exactly the
   * workspaces whose audit trail gets read. "More below" is the honest
   * and cheap answer.
   */
  hasMore: boolean;
};

export type AuditExport = {
  filename: string;
  csv: string;
  rowCount: number;
  /** True when the cap was hit. The caller MUST tell the user. */
  truncated: boolean;
};

/* ================================================================== */
/* THE PREDICATE — BUILT ONCE, USED BY BOTH                            */
/* ================================================================== */

/**
 * 🔴 THE PAGE AND THE EXPORT SHARE THIS FUNCTION, AND THEY MUST.
 *
 * The failure this prevents is not hypothetical: a customer filters to
 * "staff access, last March", exports, and gets a file built by a second
 * copy of the predicate that has since drifted — more rows, fewer rows,
 * a different date boundary. They hand that file to a regulator. The
 * only defence that survives maintenance is that there is one predicate
 * and both callers pass through it.
 *
 * ⚠️ `tenantId` IS A PARAMETER OF THIS HELPER AND NOT OF ANY EXPORT.
 * It is supplied by `requirePermission()`'s resolved context inside this
 * module. It never crosses the RPC boundary.
 */
function auditFilterPredicate(tenantId: string, filters: AuditFilters): SQL {
  const clauses: (SQL | undefined)[] = [
    // ⭐ Redundant while the RLS policy holds. Present because the day it
    // is not redundant is the day it matters. See the header.
    eq(auditLogs.tenantId, tenantId),
  ];

  if (filters.category === "staff_access") {
    /**
     * 🔴 STAFF ACCESS IS A PREDICATE OVER TWO COLUMNS, NOT AN ACTION.
     *
     * `impersonation_id IS NOT NULL` catches every action taken inside a
     * support session — the invoice our engineer edited, not merely the
     * two rows saying the session opened and closed.
     * `actor_role LIKE 'platform\_%'` catches everything
     * `recordPlatformAudit()` writes against this tenant from the
     * console.
     *
     * ⚠️ FILTERING ON `action = 'impersonate'` WOULD HAVE LOOKED RIGHT
     * AND SHOWN TWO ROWS PER SESSION — the open and the close — while
     * hiding everything that happened in between. That is the exact
     * shape of a screen that passes review and answers the wrong
     * question.
     *
     * ⚠️ `\_` ESCAPES THE UNDERSCORE. Unescaped, `platform_%` matches
     * `platformX…` too. Nothing writes such a role today; a pattern that
     * only works because nothing violates it is not a pattern.
     */
    clauses.push(
      or(
        isNotNull(auditLogs.impersonationId),
        ilike(auditLogs.actorRole, "platform\\_%"),
        sql`${auditLogs.metadata} ->> 'source' = 'platform_console'`,
      ),
    );
  } else {
    const actions = CATEGORY_ACTIONS[filters.category];
    if (actions && actions.length > 0) {
      /**
       * ⚠️ THE CAST IS NARROWING, NOT LAUNDERING. `CATEGORY_ACTIONS`
       * lives in a PURE module that must not import `@/server/audit`,
       * so its values are typed `readonly string[]`; the column's type
       * is the `audit_action` enum union. The values in that table are
       * the enum's own members, and if one ever stops being — because a
       * migration renames a value — the wrong outcome is a filter that
       * matches nothing, not a query that misbehaves. Widening it to
       * `unknown` first would hide a genuine type error; this does not.
       */
      clauses.push(inArray(auditLogs.action, actions as readonly AuditAction[]));
    }
  }

  /**
   * ⚠️ THE DAY BOUNDARIES ARE INDIAN, NOT UTC. `from` is the first
   * instant of that civil day in Asia/Kolkata and `to` is exclusive of
   * the following one, so "to the 15th" includes everything up to
   * 23:59:59 IST on the 15th rather than stopping at 05:29 IST.
   */
  if (filters.from) {
    const start = istDayStartUtc(filters.from);
    if (start) clauses.push(gte(auditLogs.createdAt, start));
  }
  if (filters.to) {
    const end = istDayEndUtc(filters.to);
    if (end) clauses.push(lt(auditLogs.createdAt, end));
  }

  if (filters.actor) {
    clauses.push(ilike(auditLogs.actorEmail, `%${escapeLikeLiteral(filters.actor)}%`));
  }

  if (filters.cursor) {
    /**
     * ⭐ THE KEYSET, SPELLED OUT RATHER THAN AS A ROW COMPARISON.
     *
     * `(created_at, id) < (:at, :id)` is tidier and PostgreSQL optimises
     * it well, but Drizzle has no first-class row-value operator and the
     * `sql` escape hatch here would be the one place a raw fragment
     * touched a user-supplied value on this page. The expanded form is
     * three parameterised comparisons and reads the same to the planner:
     * the `created_at` range still drives
     * `audit_logs_tenant_created_idx`.
     *
     * ⚠️ `id` IS THE TIEBREAK BECAUSE `created_at` IS NOT UNIQUE. A
     * background job writes several rows inside one millisecond, and a
     * keyset on the timestamp alone SKIPS the ones sharing the boundary
     * value — silently, and only under load, which is when the trail is
     * most worth reading.
     */
    clauses.push(
      or(
        lt(auditLogs.createdAt, filters.cursor.createdAt),
        and(
          eq(auditLogs.createdAt, filters.cursor.createdAt),
          lt(auditLogs.id, filters.cursor.id),
        ),
      ),
    );
  }

  const predicate = and(...clauses);
  // `and()` is only `undefined` for an empty list, and the tenant clause
  // is unconditional — but the type says otherwise and a non-null
  // assertion on a security predicate is not a thing to write.
  return predicate ?? eq(auditLogs.tenantId, tenantId);
}

/**
 * The columns the page is allowed to see.
 *
 * 🔴 NOT `select()` WITH NO ARGUMENT. `old_value` and `new_value` are
 * full before/after snapshots of whatever changed — salary rows, bank
 * details, a contact's private notes — and `ip_address` and `user_agent`
 * are forensics about a named colleague. `audit:read` is held by roles
 * that have no business reading any of it (`manager` is Legal Counsel;
 * `accountant` is the bookkeeper). A `select *` would publish all of it
 * to a browser tab through an RPC endpoint, and nobody would notice
 * because the screen only renders a dozen fields.
 */
const AUDIT_COLUMNS = {
  id: auditLogs.id,
  action: auditLogs.action,
  resourceType: auditLogs.resourceType,
  resourceId: auditLogs.resourceId,
  actorEmail: auditLogs.actorEmail,
  actorRole: auditLogs.actorRole,
  severity: auditLogs.severity,
  reason: auditLogs.reason,
  metadata: auditLogs.metadata,
  impersonationId: auditLogs.impersonationId,
  chainSeq: auditLogs.chainSeq,
  createdAt: auditLogs.createdAt,
} as const;

/**
 * ⚠️ THE PAGE SIZE IS CLAMPED, NOT TRUSTED. It arrives from the browser
 * on a published endpoint, and an unclamped one turns a paginated reader
 * back into `SELECT *` — `{ pageSize: 5000000 }` is one line of `curl`.
 * A non-numeric value falls back to the default rather than to `NaN`,
 * which `LIMIT` would reject at the database with an error naming
 * nothing useful.
 */
function resolvePageSize(input: unknown): number {
  const raw = (input as { pageSize?: unknown } | null)?.pageSize;
  const asked = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : AUDIT_PAGE_SIZE;
  return Math.min(Math.max(1, asked), AUDIT_PAGE_SIZE_MAX);
}

/* ================================================================== */
/* READ ONE PAGE                                                       */
/* ================================================================== */

export async function loadAuditTrail(input: unknown): Promise<AuditPage> {
  const ctx = await requirePermission(AUDIT_READ);
  const filters = parseAuditFilters(input);
  const size = resolvePageSize(input);

  const { rows, sessions } = await withTenant(ctx.tenant.id, async (tx) => {
    const page = (await tx
      .select(AUDIT_COLUMNS)
      .from(auditLogs)
      .where(auditFilterPredicate(ctx.tenant.id, filters))
      // ⚠️ Both keys, both descending, and in the same order as the
      // cursor comparison above. A mismatch here does not error — it
      // quietly returns overlapping pages.
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      // One extra row is how "is there more" is answered without a count.
      .limit(size + 1)) as RawAuditRow[];

    return { rows: page, sessions: await loadSessionFacts(tx, ctx.tenant.id, page) };
  });

  const hasMore = rows.length > size;
  const visible = hasMore ? rows.slice(0, size) : rows;
  const last = visible[visible.length - 1];

  return {
    events: visible.map((row) => describeAuditEvent(row, sessions)),
    nextCursor:
      hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null,
    hasMore,
  };
}

/**
 * Name the human behind each support session on this page.
 *
 * ⭐⭐ THIS IS THE JOIN THAT DOES NOT NEED PLATFORM SCOPE.
 *
 * The operator's address is on `platform_impersonation_sessions`, and
 * reading it would mean `withPlatformScope()` on a customer-facing page
 * — a cross-tenant read behind a URL every customer can reach. It is
 * also unnecessary: `startImpersonation()` already writes an
 * `impersonate` row into THIS TENANT'S OWN `audit_logs` with
 * `resource_id` set to the session id and the operator's address in
 * `actor_email`, precisely so the customer can see it. So the answer is
 * in the same table, in the same tenant, under the same RLS predicate.
 *
 * ⚠️ AND WHEN IT IS NOT THERE, THE PAGE SAYS SO rather than guessing.
 * A session started before that row existed, or trimmed from a restored
 * database, yields no name — `describeActor()` prints "an Ordence staff
 * member we cannot name from this log", which is an honest sentence and
 * a bug report at the same time.
 */
type AuditTx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function loadSessionFacts(
  tx: AuditTx,
  tenantId: string,
  rows: readonly RawAuditRow[],
): Promise<Map<string, SessionFacts>> {
  const ids = Array.from(
    new Set(rows.map((r) => r.impersonationId).filter((v): v is string => typeof v === "string")),
  );
  if (ids.length === 0) return new Map();

  const sessionRows = (await tx
    .select(AUDIT_COLUMNS)
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, tenantId),
        eq(auditLogs.resourceType, "impersonation_session"),
        inArray(auditLogs.resourceId, ids),
      ),
    )
    // Oldest first: the START row carries the mode and the justification,
    // and `collectSessionFacts()` keeps the first non-null of each.
    .orderBy(auditLogs.createdAt)
    .limit(ids.length * 4)) as RawAuditRow[];

  return collectSessionFacts(sessionRows);
}

/* ================================================================== */
/* EXPORT                                                              */
/* ================================================================== */

/**
 * The whole filtered set as CSV — not the page.
 *
 * ⭐ "GIVE ME THE LOG" IS WHY THIS SCREEN EXISTS. A customer under a
 * regulator's question, or answering their own auditor, needs the rows
 * that match what they filtered to, not the fifty currently on screen.
 * An export scoped to the visible page is the feature that gets shipped
 * and then quietly fails the one time it is used, because nobody notices
 * that the file has fifty lines until somebody counts.
 *
 * ⚠️ SO IT PAGES THROUGH THE SAME KEYSET, with the same predicate
 * function, until the set is exhausted or the cap is reached — and when
 * the cap IS reached it says so in the return value rather than handing
 * back a silently short file. A truncated export that looks complete is
 * strictly worse than a refusal.
 *
 * ⚠️ THE CAP IS A MEMORY BOUND, NOT A POLICY. 50,000 rows of CSV is a
 * few megabytes assembled in the server's heap and shipped through an
 * RPC response; an uncapped export on a large workspace is an
 * out-of-memory error on a shared runtime, which takes out other
 * customers' requests. A streaming route handler would remove the cap
 * and is the right next step — see the batch report.
 */
export async function exportAuditTrail(input: unknown): Promise<AuditExport> {
  const ctx = await requireAllPermissions(AUDIT_EXPORT);
  const filters = parseAuditFilters(input);

  const lines: string[] = [auditCsvHeader()];
  let rowCount = 0;
  let truncated = false;
  // ⚠️ Starts from the CALLER'S cursor if they sent one, so an export
  // taken mid-scroll covers the same set the screen is showing rather
  // than a different one. Usually null.
  let cursor = filters.cursor;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const batchSize = Math.min(EXPORT_BATCH, MAX_EXPORT_ROWS - rowCount + 1);
    if (batchSize <= 0) {
      truncated = true;
      break;
    }

    const { rows, sessions } = await withTenant(ctx.tenant.id, async (tx) => {
      const batch = (await tx
        .select(AUDIT_COLUMNS)
        .from(auditLogs)
        .where(auditFilterPredicate(ctx.tenant.id, { ...filters, cursor }))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(batchSize)) as RawAuditRow[];

      return { rows: batch, sessions: await loadSessionFacts(tx, ctx.tenant.id, batch) };
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      if (rowCount >= MAX_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      lines.push(auditCsvRow(row, sessions));
      rowCount++;
    }

    if (truncated || rows.length < batchSize) break;

    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  /**
   * 🔴 THE EXPORT AUDITS ITSELF, AND THIS IS THE ACTUAL CONTROL.
   *
   * Somebody pulling the entire access history of a workspace is an
   * event a workspace owner should be able to find later — including,
   * and especially, when the person pulling it is leaving. The row lands
   * in the same chain as everything else and shows up on this page, so
   * it cannot be suppressed by whoever ran the export.
   *
   * ⚠️ IT IS WRITTEN AFTER THE READ, DELIBERATELY. Written first, a
   * failed or refused export would leave a record of a download that
   * never happened, and "we can see you took a copy" is a serious enough
   * sentence that it should only be said about copies that were taken.
   */
  await writeAudit(ctx, {
    action: "export",
    resourceType: "audit_log",
    metadata: {
      rowCount,
      truncated,
      category: filters.category,
      from: filters.from,
      to: filters.to,
      actor: filters.actor,
    },
    reason: "Downloaded the workspace audit trail as CSV.",
    severity: "notice",
  });

  return {
    filename: auditExportFilename(new Date()),
    // ⚠️ CRLF. A CSV opened in Excel on Windows is the destination for
    // most of these files, and a lone LF puts every row in one cell.
    csv: `${lines.join("\r\n")}\r\n`,
    rowCount,
    truncated,
  };
}
