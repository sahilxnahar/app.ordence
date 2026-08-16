/**
 * Ordence — ⭐⭐ BATCH 30: THE CUSTOMER CAN READ THEIR OWN AUDIT TRAIL
 * Version: v1.60.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS ACTUALLY DEFENDING
 * ══════════════════════════════════════════════════════════════════════
 * Four properties, in descending order of what it costs to get them
 * wrong:
 *
 *   1. 🔴 STAFF ACCESS IS ON THE PAGE, AND IS NEVER ATTRIBUTED TO THE
 *      CUSTOMER'S OWN EMPLOYEE. Under impersonation `actor_email` is
 *      their colleague's address — see decision 2 in
 *      `lib/audit/customer-view.ts` — so the naive render is an active
 *      lie about who did something.
 *
 *   2. 🔴 THE READ CANNOT LEAVE THE TENANT. Asserted structurally: the
 *      action file contains no platform scope, no bare `db` client, and
 *      no export that takes a tenant.
 *
 *   3. ⚠️ AN UNKNOWN EVENT KIND DEGRADES, and metadata never reaches the
 *      screen as an object.
 *
 *   4. ⚠️ PAGINATION IS ON AN INDEXED KEY, dates are Indian, and the
 *      export covers the filtered set rather than the page.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUDIT_CATEGORIES,
  CATEGORY_ACTIONS,
  CHAIN_CLAIM,
  STAFF_ACCESS_COVERAGE,
  attestationOf,
  auditCsvHeader,
  auditCsvRow,
  auditExportFilename,
  categoryOf,
  collectSessionFacts,
  decodeAuditCursor,
  describeAuditEvent,
  describeMetadata,
  encodeAuditCursor,
  escapeLikeLiteral,
  formatIstDateTime,
  humaniseResourceType,
  istDay,
  istDayEndUtc,
  istDayStartUtc,
  parseAuditFilters,
  resolveStaffAccess,
  toCsvCell,
  type RawAuditRow,
} from "@/lib/audit/customer-view";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ACTION_SRC = read("server/actions/audit-trail.ts");
const VIEW_SRC = read("lib/audit/customer-view.ts");
const COMPONENT_SRC = read("components/audit/audit-trail-view.tsx");
const PAGE_SRC = read("app/(crm)/settings/audit/page.tsx");

/**
 * ⚠️ EVERY ASSERTION BELOW THAT CLAIMS SOME CODE IS ABSENT READS THIS,
 * NOT THE RAW FILE. These files are heavily commented, and half the
 * comments NAME the thing they forbid — the header of the action file
 * explains at length why there is no `withPlatformScope` in it, using
 * the word `withPlatformScope`. A test that grepped the raw source would
 * fail on the explanation of why it passes.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => m.replace(/[^\n]/g, " "));

const ACTION_CODE = codeOnly(ACTION_SRC);
const COMPONENT_CODE = codeOnly(COMPONENT_SRC);

/* ================================================================== */
/* FIXTURES                                                            */
/* ================================================================== */

const SESSION_ID = "8f3c1d2e-4b5a-4c6d-9e8f-0a1b2c3d4e5f";

function row(overrides: Partial<RawAuditRow> = {}): RawAuditRow {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    action: "update",
    resourceType: "sales_invoice",
    resourceId: "INV-042",
    actorEmail: "priya@customer.example",
    actorRole: "member",
    severity: "info",
    reason: null,
    metadata: {},
    impersonationId: null,
    chainSeq: 41,
    createdAt: new Date("2026-08-15T04:30:00.000Z"),
    ...overrides,
  };
}

/** The row `startImpersonation()` writes into the CUSTOMER'S own log. */
function sessionStartRow(overrides: Partial<RawAuditRow> = {}): RawAuditRow {
  return row({
    id: "99999999-2222-4333-8444-555555555555",
    action: "impersonate",
    resourceType: "impersonation_session",
    resourceId: SESSION_ID,
    actorEmail: "arjun@ordence.com",
    actorRole: "platform_engineer",
    severity: "warning",
    reason: "Investigating the duplicated invoice reported in ticket 8812.",
    metadata: { source: "platform_console", operatorGrade: "engineer", breakGlass: false },
    impersonationId: SESSION_ID,
    // 🔴 NULL, and that is not a fixture convenience — see the
    // attestation test below. `recordPlatformAudit()` really does write
    // these rows outside the 0081 chain.
    chainSeq: null,
    ...overrides,
  });
}

/* ================================================================== */
/* ① STAFF ACCESS — THE ONE OMISSION THAT WOULD MATTER                 */
/* ================================================================== */

describe("staff access is on the page, and is attributed to us", () => {
  it("names Ordence support, not the colleague whose view was worn", () => {
    const sessions = collectSessionFacts([sessionStartRow()]);
    const view = describeAuditEvent(row({ impersonationId: SESSION_ID }), sessions);

    expect(view.isStaffAccess).toBe(true);
    expect(view.actor).toContain("Ordence support");
    expect(view.actor).toContain("arjun@ordence.com");
    // 🔴 The customer's own employee must never be presented as the actor.
    expect(view.actor).not.toContain("priya@customer.example");
    // …but is still disclosed as the face that was worn.
    expect(view.staffNote).toContain("priya@customer.example");
  });

  it("says so honestly when the operator cannot be named from this log", () => {
    const view = describeAuditEvent(row({ impersonationId: SESSION_ID }), new Map());
    expect(view.isStaffAccess).toBe(true);
    expect(view.actor).toContain("cannot name");
    expect(view.actor).not.toContain("priya@customer.example");
  });

  it("treats a platform-console row as staff access on the actor role alone", () => {
    const view = describeAuditEvent(
      row({
        actorEmail: "ops@ordence.com",
        actorRole: "platform_owner",
        impersonationId: null,
        action: "read",
      }),
    );
    expect(view.isStaffAccess).toBe(true);
    expect(view.category).toBe("staff_access");
    expect(view.actor).toContain("ops@ordence.com");
  });

  it("catches a console row that only declares itself in metadata", () => {
    const staff = resolveStaffAccess({
      actorEmail: "ops@ordence.com",
      actorRole: null,
      impersonationId: null,
      metadata: { source: "platform_console" },
      severity: "notice",
    });
    expect(staff).not.toBeNull();
    expect(staff?.kind).toBe("console");
  });

  /**
   * ⭐ BREAK-GLASS IS THE ONE THAT HAPPENED WITHOUT PERMISSION. If it
   * read like ordinary consented support, the row a customer most needs
   * to find would look like the fifty routine ones above it.
   */
  it("separates emergency access from consented support, loudly", () => {
    const sessions = collectSessionFacts([
      sessionStartRow({
        severity: "critical",
        metadata: { source: "platform_console", breakGlass: true },
        reason: "Production incident 412: invoices failing to post for all tenants.",
      }),
    ]);
    const view = describeAuditEvent(row({ impersonationId: SESSION_ID }), sessions);

    expect(view.tone).toBe("alarm");
    expect(view.staffNote).toContain("EMERGENCY ACCESS");
    expect(view.staffNote).toContain("without your");
    expect(view.staffNote).toContain("Production incident 412");
  });

  /**
   * 🔴 THE FILTER THAT WOULD HAVE LOOKED RIGHT AND SHOWN TWO ROWS.
   *
   * `action = 'impersonate'` matches only the open and the close of a
   * session. Everything our engineer actually did in between carries an
   * ordinary action and is identified by `impersonation_id`. If
   * `CATEGORY_ACTIONS` ever gains a `staff_access` entry, the reader
   * will silently switch to that action list and the page will start
   * hiding the work.
   */
  it("does not define staff access as an action list", () => {
    expect(CATEGORY_ACTIONS["staff_access"]).toBeUndefined();
    expect(AUDIT_CATEGORIES).toContain("staff_access");
    expect(ACTION_CODE).toMatch(/isNotNull\(\s*auditLogs\.impersonationId\s*\)/);
    expect(ACTION_CODE).toMatch(/ilike\(\s*auditLogs\.actorRole/);
  });

  it("the reader resolves the operator without leaving the tenant", () => {
    // The join is against `audit_logs`, not the platform session table.
    // ⚠️ The literal lives in a string, so this half reads the RAW source;
    // the two absences below read the comment-stripped code, because the
    // header of the action file NAMES both tables while explaining why it
    // does not touch them.
    expect(ACTION_SRC).toContain('eq(auditLogs.resourceType, "impersonation_session")');
    expect(ACTION_CODE).not.toContain("platformImpersonationSessions");
    expect(ACTION_CODE).not.toContain("platformActionLog");
  });

  /** The page must say what it does NOT cover rather than quietly omit it. */
  it("states the coverage boundary in the customer's own words", () => {
    expect(STAFF_ACCESS_COVERAGE.notCovered.toLowerCase()).toContain("not shown here");
    expect(COMPONENT_SRC).toContain("STAFF_ACCESS_COVERAGE");
  });
});

/* ================================================================== */
/* ② THE READ CANNOT LEAVE THE TENANT                                  */
/* ================================================================== */

describe("tenant isolation, asserted structurally", () => {
  it("never opens a platform-scoped transaction", () => {
    expect(ACTION_CODE).not.toContain("withPlatformScope");
    // …and the file explains why, so the rule survives a refactor.
    expect(ACTION_SRC).toContain("withPlatformScope");
  });

  it("uses withTenant for every statement and never the bare client", () => {
    expect(ACTION_CODE).toContain("withTenant(ctx.tenant.id");
    expect(ACTION_CODE).not.toMatch(/\bimport\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*$/m);
    expect(ACTION_CODE).not.toMatch(/\bdb\s*\.\s*select\(/);
  });

  /**
   * 🔴 THE v005 SHAPE. An action that takes `tenantId` and hands it to
   * `withTenant()` is the single route past RLS, published as a URL.
   * `check:boundaries` rule 4 checks the same thing; this checks it in
   * the suite that runs on every commit.
   */
  it("publishes no export that accepts a tenant", () => {
    const exports = [...ACTION_CODE.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
    expect(exports.length).toBeGreaterThan(0);
    for (const [, name, params] of exports) {
      expect(`${name}:${params}`).not.toMatch(/tenantId/);
    }
  });

  /**
   * ⚠️ RLS DOES NOT DRAW THE LINE BETWEEN COLLEAGUES. Every row on this
   * page is inside one tenant, so the policy is satisfied by a query
   * that returns a colleague's bank details exactly as by one that does
   * not. The defence is the column list.
   */
  it("selects a named column list and never the snapshots or forensics", () => {
    expect(ACTION_CODE).toContain("AUDIT_COLUMNS");
    for (const forbidden of ["oldValue", "newValue", "ipAddress", "userAgent"]) {
      expect(ACTION_CODE).not.toContain(forbidden);
    }
    expect(ACTION_CODE).not.toMatch(/\.select\(\s*\)\s*\n?\s*\.from\(\s*auditLogs/);
  });

  it("guards both endpoints with a tier-2 permission in one hop", () => {
    const bodies = [
      ...ACTION_CODE.matchAll(/export async function (\w+)\([\s\S]{0,200}?\{([\s\S]{0,160})/g),
    ];
    // Two endpoints, no more. A third export is a third URL.
    expect(bodies.length).toBe(2);
    for (const [, name, body] of bodies) {
      expect(`${name}: ${body}`).toMatch(/require(Permission|AllPermissions)\(AUDIT_/);
    }
    // ⚠️ The keys themselves are strings, so this half reads the raw
    // source. Both are real entries in the permission catalogue —
    // `requirePermission` takes `PermissionKey`, so the compiler owns
    // spelling and this owns the read/write side of the line.
    expect(ACTION_SRC).toContain('const AUDIT_READ = "audit:read" as const');
    expect(ACTION_SRC).toContain('"workspace:export"');
  });

  /**
   * 🔴 A BULK DOWNLOAD OF EVERY PERSON'S MOVEMENT HISTORY IS NOT AN
   * ORDINARY READ. `exportWorkspace` sat behind `settings:read` — a key
   * the `read_only` role holds — for months while returning 26 tables
   * including this one. `check:guards` refuses the shape; this refuses
   * it in the suite too, so a well-meaning simplification back to a
   * single read key fails here first.
   */
  it("asks for more than a read key before handing over the whole log", () => {
    const exportBody = ACTION_CODE.slice(ACTION_CODE.indexOf("export async function exportAuditTrail"));
    expect(exportBody.slice(0, 200)).toContain("requireAllPermissions(AUDIT_EXPORT)");
    expect(ACTION_SRC).toMatch(/AUDIT_EXPORT\s*=\s*\[\s*"audit:read",\s*"workspace:export"/);
  });

  it("guards the page itself, not only the data call", () => {
    expect(codeOnly(PAGE_SRC)).toContain("requirePermission(");
  });

  it("escapes LIKE metacharacters so a filter cannot silently widen", () => {
    expect(escapeLikeLiteral("a_b%c")).toBe("a\\_b\\%c");
    expect(ACTION_CODE).toContain("escapeLikeLiteral");
  });

  it("refuses to accept a tenant through the filter parser", () => {
    const parsed = parseAuditFilters({
      tenantId: "00000000-0000-4000-8000-000000000000",
      category: "staff_access",
    });
    expect(Object.keys(parsed)).not.toContain("tenantId");
    expect(parsed.category).toBe("staff_access");
  });

  it("falls back to the widest category rather than passing a value through", () => {
    expect(parseAuditFilters({ category: "; drop table audit_logs" }).category).toBe("everything");
    expect(parseAuditFilters(null).category).toBe("everything");
    expect(parseAuditFilters({ from: "yesterday" }).from).toBeNull();
  });
});

/* ================================================================== */
/* ③ EVERY EVENT IS A SENTENCE, AND UNKNOWNS DEGRADE                   */
/* ================================================================== */

describe("an audit row reads as a sentence", () => {
  it("turns an action and a resource type into something a non-technical owner can read", () => {
    expect(describeAuditEvent(row()).headline).toBe("Changed a sales invoice");
    expect(describeAuditEvent(row({ action: "login" })).headline).toBe("Signed in");
    expect(describeAuditEvent(row({ action: "delete", resourceType: "ra_bill" })).headline).toBe(
      "Deleted a RA bill",
    );
  });

  it("humanises an unknown resource type instead of printing the column value", () => {
    expect(humaniseResourceType("stock_transfer")).toBe("stock transfer");
    expect(humaniseResourceType("someFutureThing")).toBe("some future thing");
    expect(humaniseResourceType("gst_return")).toBe("GST return");
    expect(humaniseResourceType("")).toBe("record");
  });

  /**
   * 🔴 `audit_action` IS A POSTGRES ENUM A FUTURE MIGRATION WILL EXTEND,
   * and this page is the last thing anybody remembers to update. It must
   * not throw and it must not print an object.
   */
  it("degrades honestly on an event kind it has never seen", () => {
    const view = describeAuditEvent(row({ action: "quantum_entangle" }));
    expect(view.headline).toContain("does not have wording for yet");
    expect(view.headline).toContain("quantum_entangle");
    expect(view.headline).not.toContain("undefined");
    expect(view.headline).not.toContain("[object");
    expect(view.category).toBe("everything");
  });

  it("never renders metadata as JSON, and never as an object", () => {
    const details = describeMetadata({
      periodId: "0f2c",
      nested: { a: 1, b: 2 },
      list: [1, 2, 3],
      flag: true,
      amountMinor: 1234567890123456789n,
      empty: null,
      source: "platform_console",
    });

    for (const d of details) {
      expect(typeof d.value).toBe("string");
      expect(d.value).not.toContain("{");
      expect(d.value).not.toContain("[object");
    }
    expect(details.find((d) => d.label === "Nested")?.value).toBe("2 fields");
    expect(details.find((d) => d.label === "List")?.value).toBe("3 items");
    expect(details.find((d) => d.label === "Flag")?.value).toBe("yes");
    // ⚠️ A bigint money value is stringified exactly, never through Number().
    expect(details.find((d) => d.label === "Amount minor")?.value).toBe("1234567890123456789");
    // Our own plumbing is not the customer's business.
    expect(details.find((d) => d.label === "Source")).toBeUndefined();
    expect(details.find((d) => d.label === "Empty")).toBeUndefined();
  });

  it("caps a long metadata value rather than letting it push the layout apart", () => {
    const [detail] = describeMetadata({ note: "x".repeat(500) });
    expect(detail).toBeDefined();
    expect(detail!.value.length).toBeLessThanOrEqual(120);
  });

  it("does not use JSON.stringify anywhere on the render path", () => {
    expect(codeOnly(VIEW_SRC)).not.toContain("JSON.stringify");
    expect(COMPONENT_CODE).not.toContain("JSON.stringify");
    expect(COMPONENT_CODE).not.toContain("dangerouslySetInnerHTML");
  });

  it("categorises rows into the questions a customer actually asks", () => {
    expect(categoryOf(row({ action: "login_failed" }), null)).toBe("security");
    expect(categoryOf(row({ action: "logout" }), null)).toBe("sign_in");
    expect(categoryOf(row({ action: "create" }), null)).toBe("changes");
    expect(categoryOf(row({ action: "read" }), null)).toBe("everything");
  });
});

/* ================================================================== */
/* ④ THE CHAIN CLAIM                                                   */
/* ================================================================== */

describe("what the page claims about the hash chain", () => {
  /**
   * 🔴 0081 USES SHA-256 WITH NO SECRET. A full tail rewrite verifies
   * perfectly. "Tamper-proof" on a page a customer relies on is a claim
   * that fails in the one moment it is needed.
   */
  it("says tamper-evident and refuses to say tamper-proof", () => {
    const all = Object.values(CHAIN_CLAIM).join(" ");
    expect(all).toContain("tamper-EVIDENT");
    expect(all.toLowerCase()).not.toContain("tamper-proof, ");
    expect(CHAIN_CLAIM.notProof.toLowerCase()).toContain("not tamper-proof");
  });

  it("names the attacker it is not evident against", () => {
    expect(CHAIN_CLAIM.notProof).toContain("rewrote every later entry");
  });

  it("says the anchor that would close the gap does not exist yet", () => {
    expect(CHAIN_CLAIM.anchor).toContain("We do not do that yet");
  });

  it("explains what an unsealed entry is instead of hiding it", () => {
    expect(CHAIN_CLAIM.unattested).toContain("support console");
  });

  /**
   * 🔴 THE ROWS THE PAGE EXISTS FOR ARE THE UNSEALED ONES.
   * `recordPlatformAudit()` inserts into `audit_logs` directly and never
   * calls the chained appender, so every staff-access row has
   * `chain_seq IS NULL`. A single green tick over the whole table would
   * assert the opposite of the truth about exactly those rows.
   */
  it("marks attestation per row, and a staff row is currently unsealed", () => {
    expect(attestationOf(row({ chainSeq: 41 }))).toBe(true);
    expect(attestationOf(sessionStartRow())).toBe(false);
    expect(describeAuditEvent(sessionStartRow()).attested).toBe(false);
    expect(COMPONENT_CODE).toContain("event.attested");
  });
});

/* ================================================================== */
/* ⑤ DATES ARE INDIAN                                                  */
/* ================================================================== */

describe("Asia/Kolkata, never raw UTC", () => {
  /**
   * ⚠️ 15 Aug 2026 at 04:30 UTC is 10:00 on the 15th in India. 14 Aug at
   * 20:00 UTC is 01:30 on the 15th — the case that files an event under
   * yesterday for the first five and a half hours of every Indian day.
   */
  it("puts an early-morning Indian event on the Indian day", () => {
    expect(istDay(new Date("2026-08-14T20:00:00.000Z"))).toBe("2026-08-15");
    expect(istDay(new Date("2026-08-15T04:30:00.000Z"))).toBe("2026-08-15");
  });

  it("formats a timestamp without an ISO string anywhere in it", () => {
    const text = formatIstDateTime(new Date("2026-08-14T20:00:00.000Z"));
    expect(text).toContain("2026");
    expect(text).not.toContain("T20:");
    expect(text).not.toContain("Z");
  });

  it("starts an Indian civil day 5.5 hours before midnight UTC", () => {
    expect(istDayStartUtc("2026-08-15")?.toISOString()).toBe("2026-08-14T18:30:00.000Z");
    expect(istDayEndUtc("2026-08-15")?.toISOString()).toBe("2026-08-15T18:30:00.000Z");
    expect(istDayStartUtc("not-a-day")).toBeNull();
  });

  it("builds the range from the Indian helpers, not from a bare Date", () => {
    expect(ACTION_CODE).toContain("istDayStartUtc");
    expect(ACTION_CODE).toContain("istDayEndUtc");
  });

  it("names the export file after the Indian day", () => {
    expect(auditExportFilename(new Date("2026-08-14T20:00:00.000Z"))).toContain("2026-08-15");
  });
});

/* ================================================================== */
/* ⑥ PAGINATION AND EXPORT                                             */
/* ================================================================== */

describe("volume: an unbounded table read on an indexed key", () => {
  it("round-trips a cursor and rejects a malformed one", () => {
    const cursor = { createdAt: new Date("2026-08-15T04:30:00.000Z"), id: row().id };
    const decoded = decodeAuditCursor(encodeAuditCursor(cursor));
    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.createdAt.toISOString()).toBe(cursor.createdAt.toISOString());

    expect(decodeAuditCursor("garbage")).toBeNull();
    expect(decodeAuditCursor(`nonsense~${row().id}`)).toBeNull();
    expect(decodeAuditCursor("2026-08-15T04:30:00.000Z~not-a-uuid")).toBeNull();
    expect(decodeAuditCursor(null)).toBeNull();
    expect(decodeAuditCursor(42)).toBeNull();
  });

  /**
   * 🔴 OFFSET IS BOTH SLOW AND WRONG HERE. Slow because the table is
   * append-only and never pruned; wrong because rows arrive at the head
   * while somebody reads, so every insert shifts the window and page 2
   * both repeats and skips rows.
   */
  it("uses no OFFSET and no count(*) anywhere in the reader", () => {
    expect(ACTION_CODE).not.toMatch(/\.offset\(/);
    expect(ACTION_CODE).not.toMatch(/count\(/i);
  });

  /**
   * 🔴 AND NOT `chain_seq`, WHICH IS NULL ON EVERY PLATFORM-CONSOLE ROW.
   * A keyset on it would have produced a staff-access page that omits
   * staff access.
   */
  it("keys on (created_at, id) and not on the chain sequence", () => {
    expect(ACTION_CODE).toMatch(/orderBy\(\s*desc\(auditLogs\.createdAt\)\s*,\s*desc\(auditLogs\.id\)/);
    expect(ACTION_CODE).not.toMatch(/orderBy\([^)]*chainSeq/);
    expect(ACTION_CODE).not.toMatch(/lt\(\s*auditLogs\.chainSeq/);
    // The unique tiebreak, without which rows sharing a millisecond are skipped.
    expect(ACTION_CODE).toMatch(/lt\(\s*auditLogs\.id\s*,/);
  });

  it("clamps a caller-supplied page size", () => {
    expect(ACTION_CODE).toContain("AUDIT_PAGE_SIZE_MAX");
    expect(ACTION_CODE).toMatch(/Math\.min\(Math\.max\(1, asked\), AUDIT_PAGE_SIZE_MAX\)/);
  });

  /**
   * ⭐ "GIVE ME THE LOG" IS THE REASON THE PAGE EXISTS. An export scoped
   * to the visible page is the feature that ships and then fails the one
   * time it is used.
   */
  it("exports the whole filtered set, in batches, and reports truncation", () => {
    expect(ACTION_CODE).toContain("MAX_EXPORT_ROWS");
    expect(ACTION_CODE).toContain("EXPORT_BATCH");
    expect(ACTION_CODE).toContain("truncated");
    // One predicate builder, shared — a second copy is how the file and
    // the screen come to disagree.
    const predicateUses = ACTION_CODE.match(/auditFilterPredicate\(/g) ?? [];
    expect(predicateUses.length).toBeGreaterThanOrEqual(3);
    expect(COMPONENT_CODE).toContain("result.truncated");
  });

  it("audits the export itself, after the read rather than before it", () => {
    expect(ACTION_CODE).toContain("writeAudit(ctx");
    const writeAt = ACTION_CODE.indexOf("writeAudit(ctx");
    const loopAt = ACTION_CODE.indexOf("for (;;)");
    expect(loopAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(loopAt);
  });
});

describe("the CSV a customer hands to their auditor", () => {
  it("neutralises a formula so a reason field cannot execute in Excel", () => {
    expect(toCsvCell("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    expect(toCsvCell("+1")).toBe(`"'+1"`);
    expect(toCsvCell("-1")).toBe(`"'-1"`);
    expect(toCsvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(toCsvCell(`he said "no"`)).toBe(`"he said ""no"""`);
    expect(toCsvCell(null)).toBe(`""`);
  });

  it("leads with a BOM so Excel on Windows does not mangle Indian names", () => {
    expect(auditCsvHeader().startsWith("﻿")).toBe(true);
  });

  it("carries the staff-access answer as its own column", () => {
    const sessions = collectSessionFacts([sessionStartRow()]);
    const line = auditCsvRow(row({ impersonationId: SESSION_ID }), sessions);

    expect(line).toContain("yes — support session");
    expect(line).toContain("arjun@ordence.com");
    expect(line).toContain("priya@customer.example");
    expect(auditCsvHeader()).toContain("Ordence staff?");

    // ⚠️ An action taken DURING a session goes through `writeAudit()` and
    // IS chained; the session's own row comes from `recordPlatformAudit()`
    // and is not. Both appear on the page and they are marked differently.
    expect(line).toContain('"sealed"');
    expect(auditCsvRow(sessionStartRow(), sessions)).toContain('"not sealed"');
  });

  it("says the same thing as the screen, because it is built from it", () => {
    const line = auditCsvRow(row(), new Map());
    expect(line).toContain(describeAuditEvent(row()).headline);
  });

  it("writes a chain position and a bigint without coercing either to a float", () => {
    expect(auditCsvRow(row({ chainSeq: 9007199254740991 }), new Map())).toContain(
      "9007199254740991",
    );
    // 🔴 Money is bigint minor units. `Number()` on one is a silent
    // precision loss, and a display path is exactly where that habit
    // starts. `describeMetadata()` stringifies a bigint directly.
    expect(describeMetadata({ amountMinor: 92233720368547758n })[0]?.value).toBe(
      "92233720368547758",
    );
    expect(codeOnly(VIEW_SRC)).not.toMatch(/Number\(\s*row\./);
    expect(codeOnly(VIEW_SRC)).not.toMatch(/\bparseFloat\b/);
    expect(codeOnly(VIEW_SRC)).not.toMatch(/\btoFixed\b/);
  });
});

/* ================================================================== */
/* ⑦ SESSION FACTS                                                     */
/* ================================================================== */

describe("recovering the support session from the tenant's own rows", () => {
  it("keeps the start row's justification when the stop row has its own", () => {
    const sessions = collectSessionFacts([
      sessionStartRow(),
      sessionStartRow({
        id: "77777777-2222-4333-8444-555555555555",
        reason: "Impersonation session ended by the operator.",
        severity: "notice",
        metadata: { source: "platform_console" },
      }),
    ]);

    const facts = sessions.get(SESSION_ID);
    expect(facts?.operatorEmail).toBe("arjun@ordence.com");
    expect(facts?.justification).toContain("ticket 8812");
  });

  it("ignores rows that are not session rows", () => {
    expect(collectSessionFacts([row()]).size).toBe(0);
  });

  it("labels a console row taken during a session as the operator, not as a face worn", () => {
    const sessions = collectSessionFacts([sessionStartRow()]);
    const staff = resolveStaffAccess(sessionStartRow(), sessions);
    expect(staff?.kind).toBe("console");
    expect(staff?.operatorEmail).toBe("arjun@ordence.com");
    expect(staff?.actingAs).toBeNull();
  });
});
