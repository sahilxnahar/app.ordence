/**
 * Ordence — ⭐⭐ 0081: THE AUDIT LOG BECOMES TAMPER-EVIDENT
 * Version: v1.38.0-alpha  (Mega-wave 1, Batch 44)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 `audit_logs` AND `platform_action_log` WERE APPEND-ONLY BY POLICY.
 *    A BEFORE UPDATE/DELETE trigger refuses the statement and an RLS
 *    policy refuses the connection — and both live INSIDE the database,
 *    so both are available to anybody who reaches it with owner rights:
 *
 *        ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
 *        UPDATE audit_logs SET reason = 'routine' WHERE id = '...';
 *        ALTER TABLE audit_logs ENABLE  TRIGGER audit_logs_no_update;
 *
 *    Three statements, no trace anywhere. The trigger prevented the
 *    APPLICATION rewriting history; it never detected anything.
 *
 * ⭐ THE CHAIN MAKES THAT REWRITE PROVABLE, and the tests below are
 *    organised around the five things it must be honest about: that the
 *    chain covers the PREVIOUS row's hash, that it is PER TENANT, what
 *    happens under CONCURRENCY, that existing rows are NOT backfilled,
 *    and that a hashing failure never costs the audit row.
 *
 * ⚠️ AND AROUND THE ONE THING IT MUST NOT CLAIM. SHA-256 has no secret
 *    in it, so a complete tail rewrite verifies perfectly. Section ⑥
 *    asserts that the code SAYS so, in each of the three files a reader
 *    might open first.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AUDIT_CHAIN_DOMAIN,
  PLATFORM_CHAIN_SCOPE,
  canonicalJson,
  chainScopeFor,
  hashAuditContent,
  hashAuditLink,
  nextChainLink,
  verifyAuditChain,
  type AuditChainRow,
} from "@/lib/audit/chain";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const MIGRATION = read("SQL-FILES/0081_audit_hash_chain.sql");
const VERIFY = read("SQL-FILES/VERIFY-0081-neon-safe.sql");
const DRILL = read("SQL-FILES/DRILL-DO-NOT-RUN-IN-NEON-0081.sql");
const CHAIN = read("lib/audit/chain.ts");
const AUDIT = read("server/audit.ts");

/** Comment-stripped source, for the assertions about ABSENCE of code. */
const codeOnly = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/**
 * The same idea for SQL. ⚠️ IT IS NEEDED HERE AND THE NAIVE VERSION IS
 * ACTIVELY MISLEADING: 0081's header QUOTES the three statements an
 * intruder would run, `UPDATE audit_logs SET reason = ...` among them,
 * so a raw grep for a rewrite finds the description of the attack and
 * reports the migration as performing it.
 */
const sqlCodeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/* ------------------------------------------------------------------ */
/* A LITTLE CHAIN TO EXPERIMENT ON                                     */
/* ------------------------------------------------------------------ */

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type Built = { rows: AuditChainRow[] };

/** Append `n` rows to a fresh chain, exactly as `appendChainedAuditRow` does. */
function buildChain(scope: string, reasons: readonly string[]): Built {
  const rows: AuditChainRow[] = [];
  let head: { chainSeq: number; rowHash: string } | null = null;

  for (const [i, reason] of reasons.entries()) {
    const content = { action: "update", resourceType: "invoice", reason };
    const link = nextChainLink({ scope, head, content });
    rows.push({
      id: `row-${i + 1}`,
      chainSeq: link.chainSeq,
      prevHash: link.prevHash,
      contentHash: link.contentHash,
      rowHash: link.rowHash,
      content,
    });
    head = { chainSeq: link.chainSeq, rowHash: link.rowHash };
  }
  return { rows };
}

/* ================================================================== */
/* ① THE CHAIN COVERS THE PREVIOUS ROW'S HASH — CONSTRAINT 1           */
/* ================================================================== */

describe("the chain covers the previous row's hash, not just the row", () => {
  it("verifies a chain it just built", () => {
    const { rows } = buildChain(TENANT_A, ["a", "b", "c", "d"]);
    const report = verifyAuditChain(TENANT_A, rows);
    expect(report.ok).toBe(true);
    expect(report.firstBreak).toBeNull();
    expect(report.chainedRows).toBe(4);
    expect(report.headHash).toBe(rows[3]!.rowHash);
  });

  /**
   * ⭐ `prev_hash` IS AN INPUT TO `row_hash`, WHICH IS THE WHOLE
   * MECHANISM. Two rows with identical content at identical positions
   * but different predecessors must hash differently, or the chain is a
   * list of independent checksums wearing a chain's clothes.
   */
  it("gives a different row_hash to the same content after a different predecessor", () => {
    const content = { action: "update", reason: "same words either way" };
    const contentHash = hashAuditContent(content);
    const afterX = hashAuditLink({ scope: TENANT_A, seq: 7, prevHash: "0".repeat(64), contentHash });
    const afterY = hashAuditLink({ scope: TENANT_A, seq: 7, prevHash: "1".repeat(64), contentHash });
    expect(afterX).not.toBe(afterY);
  });

  /**
   * 🔴 THE HEADLINE. Editing a historical row is detected, and the
   * report NAMES the row rather than saying "something is wrong".
   */
  it("detects an edit to a historical row and points at that row", () => {
    const { rows } = buildChain(TENANT_A, ["a", "b", "c", "d", "e"]);
    // The intruder edits row 2's content and leaves the hashes alone.
    rows[1]!.content = { action: "update", resourceType: "invoice", reason: "routine" };

    const report = verifyAuditChain(TENANT_A, rows);
    expect(report.ok).toBe(false);
    expect(report.firstBreak?.kind).toBe("content_rewritten");
    expect(report.firstBreak?.chainSeq).toBe(2);
    expect(report.summary).toContain("TAMPER EVIDENT");
  });

  /**
   * 🔴 AND REPAIRING THAT ROW MOVES THE BREAK RATHER THAN CLOSING IT.
   * This is the property a per-row checksum does not have: the intruder
   * fixes row 2 and row 3 starts failing, because row 3's `prev_hash`
   * names the OLD row 2.
   */
  it("moves the break down the chain when the edited row is repaired", () => {
    const { rows } = buildChain(TENANT_A, ["a", "b", "c", "d", "e"]);
    const edited = { action: "update", resourceType: "invoice", reason: "routine" };
    rows[1]!.content = edited;
    // ... and recomputes row 2's own two hashes, competently.
    rows[1]!.contentHash = hashAuditContent(edited);
    rows[1]!.rowHash = hashAuditLink({
      scope: TENANT_A,
      seq: 2,
      prevHash: rows[1]!.prevHash,
      contentHash: rows[1]!.contentHash,
    });

    const report = verifyAuditChain(TENANT_A, rows);
    expect(report.ok).toBe(false);
    expect(report.firstBreak?.kind).toBe("link_broken");
    expect(report.firstBreak?.chainSeq).toBe(3);
  });

  /** Removing a row from the middle leaves a hole in the sequence. */
  it("detects a removed row", () => {
    const { rows } = buildChain(TENANT_A, ["a", "b", "c", "d"]);
    const survivors = rows.filter((r) => r.chainSeq !== 3);
    const report = verifyAuditChain(TENANT_A, survivors);
    expect(report.firstBreak?.kind).toBe("sequence_gap");
    expect(report.firstBreak?.chainSeq).toBe(4);
  });

  /**
   * ⚠️ A COMPLETE, COMPETENT REWRITE VERIFIES. This test exists to stop
   * anybody reading `ok: true` as proof of an untouched history — the
   * limit is asserted, not merely documented.
   */
  it("cannot detect a full tail rewrite, and the code says so", () => {
    const rewritten = buildChain(TENANT_A, ["a", "the edited version", "c", "d"]);
    const report = verifyAuditChain(TENANT_A, rewritten.rows);
    expect(report.ok).toBe(true);
    // The only thing that changed, and the only thing an anchor sees.
    const original = buildChain(TENANT_A, ["a", "b", "c", "d"]);
    expect(report.headHash).not.toBe(verifyAuditChain(TENANT_A, original.rows).headHash);
    expect(report.summary).toContain("anchor it outside this database");
  });
});

/* ================================================================== */
/* ② THE CHAIN IS PER TENANT — CONSTRAINT 2                            */
/* ================================================================== */

describe("the chain is per tenant", () => {
  /**
   * ⭐ THE SCOPE IS AN INPUT TO THE HASH. Without it, a row could be
   * lifted from one workspace's chain into another's at the same
   * position and verify — which would make the per-tenant chain a
   * numbering convention rather than a binding.
   */
  it("binds every row to its workspace", () => {
    const contentHash = hashAuditContent({ action: "login" });
    expect(hashAuditLink({ scope: TENANT_A, seq: 1, prevHash: null, contentHash })).not.toBe(
      hashAuditLink({ scope: TENANT_B, seq: 1, prevHash: null, contentHash }),
    );
  });

  /** Two workspaces number from 1 independently and never interleave. */
  it("numbers each workspace from 1", () => {
    const a = buildChain(TENANT_A, ["a1", "a2", "a3"]);
    const b = buildChain(TENANT_B, ["b1", "b2"]);
    expect(a.rows.map((r) => r.chainSeq)).toEqual([1, 2, 3]);
    expect(b.rows.map((r) => r.chainSeq)).toEqual([1, 2]);
    expect(verifyAuditChain(TENANT_A, a.rows).ok).toBe(true);
    expect(verifyAuditChain(TENANT_B, b.rows).ok).toBe(true);
  });

  /** Tenant-less rows get a word, not a null and not a zero uuid. */
  it("uses a scope key that cannot collide with a tenant id", () => {
    expect(chainScopeFor(null)).toBe(PLATFORM_CHAIN_SCOPE);
    expect(chainScopeFor(TENANT_A)).toBe(TENANT_A);
    // `platform` is not parseable as a uuid, so no tenant can ever take it.
    expect(PLATFORM_CHAIN_SCOPE).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * 🔴 THE ARGUMENT THAT SETTLES IT, AND IT MUST BE WRITTEN DOWN. A
   * global chain would need a write inside tenant A to READ tenant B's
   * last row, which `audit_logs_tenant_isolation` refuses — so it is
   * not merely undesirable, it is unimplementable without adding a
   * cross-tenant read path to the most sensitive table in the system.
   */
  it("records why a global chain is impossible here, not merely unwanted", () => {
    expect(CHAIN).toContain("A GLOBAL CHAIN IS NOT IMPLEMENTABLE UNDER THE RLS WE ALREADY");
    expect(CHAIN).toContain("IT LEAKS WRITE ORDER ACROSS CUSTOMERS");
    expect(CHAIN).toContain("ONE BUSY WORKSPACE WOULD SERIALISE EVERYBODY");
    // And the cost is stated rather than left for a reader to find.
    expect(CHAIN).toContain("proves nothing about the");
    expect(CHAIN).toContain("ORDER of events BETWEEN workspaces");
  });
});

/* ================================================================== */
/* ③ CONCURRENCY — CONSTRAINT 3                                        */
/* ================================================================== */

describe("what happens when two writes race", () => {
  /**
   * ⚠️ THE RACE, SIMULATED. Both writers read the same head, so both
   * compute seq 3. The chain columns they produce are IDENTICAL in
   * position, which is precisely why the database — not the code — has
   * to be the thing that rejects one of them.
   */
  it("produces a colliding sequence number, which is what the unique index is for", () => {
    const { rows } = buildChain(TENANT_A, ["a", "b"]);
    const head = { chainSeq: 2, rowHash: rows[1]!.rowHash! };

    const first = nextChainLink({ scope: TENANT_A, head, content: { action: "login" } });
    const second = nextChainLink({ scope: TENANT_A, head, content: { action: "logout" } });

    expect(first.chainSeq).toBe(3);
    expect(second.chainSeq).toBe(3);
    expect(first.prevHash).toBe(second.prevHash);
  });

  /**
   * 🔴 SO THE UNIQUE INDEXES ARE THE CONCURRENCY DESIGN, AND THEY ARE
   * PARTIAL. `tenant_id` is nullable, and in a plain UNIQUE every NULL
   * compares distinct from every other — so the platform rows, the ones
   * about crossing tenant boundaries, would get no uniqueness at all.
   */
  it("ships two partial unique indexes because tenant_id is nullable", () => {
    expect(MIGRATION).toContain("audit_logs_chain_tenant_seq_uq");
    expect(MIGRATION).toContain("audit_logs_chain_platform_seq_uq");
    expect(MIGRATION).toContain("WHERE tenant_id IS NOT NULL AND chain_seq IS NOT NULL");
    expect(MIGRATION).toContain("WHERE tenant_id IS NULL AND chain_seq IS NOT NULL");
    expect(MIGRATION).toContain("every NULL");
  });

  /**
   * ⚠️ NO LOCK. The choice is stated in the writer, with what it costs.
   * A grep for an advisory lock is the cheapest way to notice if
   * somebody later "fixes" the retry by serialising the audit trail.
   */
  it("takes no lock, and says why in the writer", () => {
    expect(codeOnly(AUDIT)).not.toContain("pg_advisory");
    expect(AUDIT).toContain("OPTIMISTIC, NOT LOCKED");
    expect(AUDIT).toMatch(/a blocked[\s*]+audit write is a blocked request/);
  });

  /**
   * ⭐ THE RETRY IS NARROW ON PURPOSE. Retrying any error would retry a
   * malformed row four times; retrying any 23505 would retry a primary
   * key collision. The constraint name has to match.
   */
  it("retries only the chain-position collision", () => {
    const code = codeOnly(AUDIT);
    expect(code).toContain("23505");
    expect(code).toContain("audit_logs_chain_tenant_seq_uq");
    expect(AUDIT).toContain("THE NARROWEST POSSIBLE TEST");
  });

  /** And it is honest that a sequence number is not a clock. */
  it("says plainly that chain_seq is an append order and not a happened-before", () => {
    expect(AUDIT).toContain("AN APPEND ORDER, NOT A CLOCK");
    expect(CHAIN).toContain("IT DOES NOT PROVE COMPLETENESS");
  });
});

/* ================================================================== */
/* ④ NOTHING IS BACKFILLED — CONSTRAINT 4                              */
/* ================================================================== */

describe("existing rows have no hash and are not given one", () => {
  /**
   * 🔴 THE VERIFIER REPORTS WHERE THE CHAIN STARTS RATHER THAN CLAIMING
   * THE HISTORY IS VERIFIED. A workspace with a year of pre-0081 rows
   * must not read `ok: true` as "the year is intact".
   */
  it("reports 'chain starts at row X' and counts what is not attested", () => {
    const { rows } = buildChain(TENANT_A, ["a", "b", "c"]);
    const withHistory: AuditChainRow[] = [
      { id: "old-1", chainSeq: null, prevHash: null, contentHash: null, rowHash: null },
      { id: "old-2", chainSeq: null, prevHash: null, contentHash: null, rowHash: null },
      ...rows,
    ];

    const report = verifyAuditChain(TENANT_A, withHistory);
    expect(report.ok).toBe(true);
    expect(report.unchainedRows).toBe(2);
    expect(report.startsAtSeq).toBe(1);
    expect(report.summary).toContain("CHAIN STARTS AT ROW 1");
    expect(report.summary).toContain("NOT attested");
  });

  /** A chain that begins at 4,001 is normal, not a truncation. */
  it("does not demand that the first chained row be seq 1", () => {
    const contentA = { action: "login" };
    const contentB = { action: "logout" };
    const hashA = hashAuditContent(contentA);
    const rowA = hashAuditLink({ scope: TENANT_A, seq: 4001, prevHash: null, contentHash: hashA });
    const hashB = hashAuditContent(contentB);
    const rowB = hashAuditLink({ scope: TENANT_A, seq: 4002, prevHash: rowA, contentHash: hashB });

    const report = verifyAuditChain(TENANT_A, [
      { id: "r1", chainSeq: 4001, prevHash: null, contentHash: hashA, rowHash: rowA, content: contentA },
      { id: "r2", chainSeq: 4002, prevHash: rowA, contentHash: hashB, rowHash: rowB, content: contentB },
    ]);
    expect(report.ok).toBe(true);
    expect(report.startsAtSeq).toBe(4001);
  });

  /**
   * ⚠️ NO BACKFILL ANYWHERE IN THE MIGRATION. A backfilled chain attests
   * to the row's state at BACKFILL time while presenting itself as
   * attesting to its state at WRITE time — it converts "we do not know"
   * into "verified" for exactly the people who cannot check.
   */
  it("the migration writes no data at all", () => {
    const sql = sqlCodeOnly(MIGRATION);
    expect(sql).not.toMatch(/UPDATE\s+(audit_logs|platform_action_log)/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(audit_logs|platform_action_log)/i);
    expect(MIGRATION).toContain("NOTHING IS BACKFILLED");
    expect(MIGRATION).toContain("converts");
    expect(MIGRATION).toContain('"we do not know" into "verified"');
  });

  /** And the verify has a section whose whole job is to say how much is not covered. */
  it("the verify reports unchained rows before it reports a verdict", () => {
    expect(VERIFY).toContain("unchained_rows");
    expect(VERIFY).toContain("chain_starts_at_seq");
    expect(VERIFY.indexOf("unchained_rows")).toBeLessThan(VERIFY.indexOf("broken_links"));
    expect(VERIFY).toContain("READ `unchained_rows` BEFORE READING SECTION 3");
  });
});

/* ================================================================== */
/* ⑤ AN AUDIT WRITE NEVER BREAKS THE OPERATION — CONSTRAINT 5          */
/* ================================================================== */

describe("hashing failure is not fatal", () => {
  /**
   * 🔴 THE ARGUMENT, WHICH IS SPECIFIC TO WHAT AN AUDIT ROW IS. By the
   * time `writeAudit` runs, the invoice is posted. Refusing to record it
   * does not undo it — it produces a system where the act happened and
   * nothing says so, which is the state an attacker wants.
   */
  it("degrades to an unchained row rather than losing the row", () => {
    const code = codeOnly(AUDIT);
    expect(code).toContain("appendUnchainedAuditRow");
    expect(code).toContain("[AUDIT CHAIN DEGRADED]");
    expect(AUDIT).toContain("THE AUDIT WRITE DESCRIBES AN OPERATION THAT ALREADY HAPPENED");
    expect(AUDIT).toContain("denial-of-audit");
  });

  /**
   * ⚠️ AND IT LEARNS 0079'S LESSON RATHER THAN REPEATING IT. The
   * telemetry writers swallowed 42501 silently and discarded every
   * attributed row for months. The rule is not "never swallow" — it is
   * "never swallow quietly".
   */
  it("cites the telemetry writers and draws the distinction", () => {
    expect(AUDIT).toContain("server/security/record.ts");
    expect(AUDIT).toMatch(/it is "never[\s*]+swallow quietly"/);
  });

  /** The degraded row is all-NULL, never half-hashed. */
  it("writes no chain columns at all when it degrades", () => {
    const fn = AUDIT.slice(
      AUDIT.indexOf("async function appendUnchainedAuditRow"),
      AUDIT.indexOf("/* ------------------------------------------------------------------ */\n/* AUDIT WRITER"),
    );
    const code = codeOnly(fn);
    expect(code).not.toContain("chainSeq:");
    expect(code).not.toContain("rowHash:");
    expect(code).not.toContain("contentHash:");
  });

  /**
   * ⭐ AND THE HOLE IT LEAVES IS NAMED. Sustained failure on one
   * tenant's chain produces unattested rows; the verify counts them per
   * tenant so a burst is itself the signal.
   */
  it("names the hole the degradation leaves", () => {
    expect(AUDIT).toContain("AND THE HOLE THIS LEAVES, SAID PLAINLY");
    expect(VERIFY).toContain("last_unattested_row_at");
  });
});

/* ================================================================== */
/* ⑥ WHAT IT DOES NOT PROVE, SAID IN EVERY FILE                        */
/* ================================================================== */

describe("the limits are written down where they will be read", () => {
  it("says SHA-256 has no secret, in all three places a reader starts", () => {
    for (const [name, text] of [
      ["lib/audit/chain.ts", CHAIN],
      ["0081", MIGRATION],
      ["VERIFY-0081", VERIFY],
    ] as const) {
      expect(text, name).toMatch(/SHA-256[\s*-]+has[\s*-]+no[\s*-]+secret[\s*-]+in[\s*-]+it/i);
    }
  });

  /** The one control that survives an intruder with database rights. */
  it("points at the anchor as the thing that would close it", () => {
    expect(MIGRATION).toContain("retention lock");
    expect(VERIFY).toContain("THE VALUE TO ANCHOR OUTSIDE THIS");
    expect(DRILL).toContain("THE ONE CONTROL THAT SURVIVES AN INTRUDER");
  });

  /** And that the SQL half cannot check content. */
  it("is explicit that SQL proves structure and TypeScript proves content", () => {
    expect(MIGRATION).toContain("pure SQL      proves the chain's STRUCTURE");
    expect(MIGRATION).toContain("TypeScript    proves each row's CONTENT");
    expect(VERIFY).toContain("IT DOES NOT PROVE THAT `content_hash` STILL MATCHES");
  });
});

/* ================================================================== */
/* ⑦ THE SQL TWIN AND THE TYPESCRIPT ONE AGREE                         */
/* ================================================================== */

describe("audit_chain_link_hash() and hashAuditLink() are a pair", () => {
  /**
   * 🔴 IF THESE TWO DRIFT, EVERY ROW WRITTEN AFTERWARDS READS AS
   * TAMPERED. A false accusation is the worst failure this feature has
   * and is far likelier than an intruder, so the encoding is asserted
   * character by character against an independent reimplementation of
   * what the SQL does.
   */
  it("produces the digest the SQL function's text describes", () => {
    const scope = TENANT_A;
    const seq = 3;
    const prev = "a".repeat(64);
    const content = "b".repeat(64);

    // Exactly what section 4 of 0081 concatenates: domain, then each
    // field as chr(31) || octet_length || ':' || value.
    const lp = (s: string) => `${Buffer.byteLength(s, "utf8")}:${s}`;
    const expected = createHash("sha256")
      .update(
        "ordence-audit-chain-v1" +
          "\u001f" + lp(scope) +
          "\u001f" + lp(String(seq)) +
          "\u001f" + lp(prev) +
          "\u001f" + lp(content),
        "utf8",
      )
      .digest("hex");

    expect(hashAuditLink({ scope, seq, prevHash: prev, contentHash: content })).toBe(expected);
  });

  /** The SQL text still has the framing the assertion above assumes. */
  it("keeps the framing in the SQL function", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("CREATE OR REPLACE FUNCTION audit_chain_link_hash"));
    expect(fn).toContain("'ordence-audit-chain-v1'");
    expect(fn).toContain("chr(31) || octet_length(p_scope)::text        || ':' || p_scope");
    expect(fn).toContain("chr(31) || octet_length(p_prev_hash)::text    || ':' || p_prev_hash");
    expect(fn).toContain("sha256(convert_to(");
    expect(fn).toContain("IMMUTABLE STRICT");
    expect(AUDIT_CHAIN_DOMAIN).toBe("ordence-audit-chain-v1");
  });

  /** And the drill copies it verbatim rather than paraphrasing it. */
  it("is copied verbatim into the drill", () => {
    const inMigration = MIGRATION.slice(
      MIGRATION.indexOf("CREATE OR REPLACE FUNCTION audit_chain_link_hash"),
      MIGRATION.indexOf("COMMENT ON FUNCTION audit_chain_link_hash"),
    ).trim();
    expect(DRILL).toContain(inMigration);
  });

  /**
   * ⚠️ THE VERIFY CARRIES A KNOWN-ANSWER TEST for the same reason: if
   * somebody redefines the function in the database, section 7 says so
   * before anybody concludes there is an intruder.
   */
  it("the verify carries a known-answer test for the framing", () => {
    expect(VERIFY).toContain("framing_unchanged");
    expect(VERIFY).toContain("'8:platform'");
    expect(hashAuditLink({ scope: "platform", seq: 1, prevHash: null, contentHash: "a" })).toBe(
      createHash("sha256")
        .update(
          "ordence-audit-chain-v1\u001f8:platform\u001f1:1\u001f0:\u001f1:a",
          "utf8",
        )
        .digest("hex"),
    );
  });
});

/* ================================================================== */
/* ⑧ CANONICAL JSON — WHERE TWO VERIFIERS WOULD OTHERWISE DISAGREE     */
/* ================================================================== */

describe("canonical JSON", () => {
  /**
   * 🔴 `JSON.stringify` KEY ORDER IS INSERTION ORDER, so the same
   * logical row built by two code paths would hash differently and every
   * difference would look like tampering.
   */
  it("is insensitive to key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(hashAuditContent({ reason: "x", action: "y" })).toBe(
      hashAuditContent({ action: "y", reason: "x" }),
    );
  });

  /** Nested objects too — metadata is arbitrarily deep. */
  it("sorts nested keys", () => {
    expect(canonicalJson({ m: { z: 1, a: [{ q: 1, b: 2 }] } })).toBe(
      canonicalJson({ m: { a: [{ b: 2, q: 1 }] , z: 1 } }),
    );
  });

  /** ⚠️ But array ORDER is significant — two orderings are two payloads. */
  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  /** `undefined` is dropped, matching what a never-set jsonb field is. */
  it("drops undefined rather than inventing null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  /** Dates are UTC ISO, so the same instant hashes the same in any zone. */
  it("renders dates as UTC ISO", () => {
    const d = new Date("2026-08-15T04:30:00.000Z");
    expect(canonicalJson({ at: d })).toContain("2026-08-15T04:30:00.000Z");
  });

  /**
   * ⚠️ NON-FINITE NUMBERS ARE REFUSED RATHER THAN SILENTLY BECOMING
   * `null`, which is what `JSON.stringify` does and which would make two
   * different rows hash identically.
   */
  it("refuses a non-finite number instead of collapsing it to null", () => {
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
  });

  /**
   * 🔴 LENGTH PREFIXES MAKE THE ENCODING INJECTIVE. Without them an
   * attacker controlling two adjacent fields can move a character across
   * the boundary and keep the digest — and `resource_type` and
   * `resource_id` are adjacent and both influenced from outside.
   */
  it("cannot be forged by rebalancing adjacent fields", () => {
    expect(hashAuditContent({ resourceType: "ab", resourceId: "c" })).not.toBe(
      hashAuditContent({ resourceType: "a", resourceId: "bc" }),
    );
  });

  /** And a genesis row does not hash like a row whose predecessor vanished. */
  it("encodes a missing prev_hash distinctly from an empty one", () => {
    const contentHash = hashAuditContent({ action: "login" });
    // null and "" are the same input by design (`?? ""`), and neither can
    // be confused with a real 64-char digest because of the length prefix.
    expect(hashAuditLink({ scope: TENANT_A, seq: 1, prevHash: null, contentHash })).toBe(
      hashAuditLink({ scope: TENANT_A, seq: 1, prevHash: "", contentHash }),
    );
    expect(hashAuditLink({ scope: TENANT_A, seq: 1, prevHash: null, contentHash })).not.toBe(
      hashAuditLink({ scope: TENANT_A, seq: 1, prevHash: "0".repeat(64), contentHash }),
    );
  });

  /** Byte length, not character length — `octet_length` counts bytes. */
  it("length-prefixes in bytes so the SQL twin agrees on non-ASCII", () => {
    const lp = (s: string) => `${Buffer.byteLength(s, "utf8")}:${s}`;
    expect(lp("₹")).toBe("3:₹");
    expect(CHAIN).toContain("BYTES, NOT CHARACTERS");
    expect(MIGRATION).toContain("is one character and");
  });
});

/* ================================================================== */
/* ⑨ THE MIGRATION, THE VERIFY AND THE DRILL DISCIPLINE                */
/* ================================================================== */

describe("the migration", () => {
  it("adds the four columns to both tables", () => {
    for (const col of ["chain_seq", "prev_hash", "content_hash", "row_hash"]) {
      expect(MIGRATION, col).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(MIGRATION).toContain("ALTER TABLE audit_logs");
    expect(MIGRATION).toContain("ALTER TABLE platform_action_log");
  });

  /**
   * 🔴 THE ALL-OR-NOTHING CHECK. Without it, "partially hashed" is a
   * legal state, and a partially hashed row is unfalsifiable: an
   * intruder can blank a `content_hash` and claim the row predates the
   * chain.
   */
  it("refuses a half-hashed row on both tables", () => {
    expect((MIGRATION.match(/chain_all_or_nothing CHECK/g) ?? []).length).toBe(2);
    expect((MIGRATION.match(/chain_hex CHECK/g) ?? []).length).toBe(2);
    expect(MIGRATION).toMatch(/a partially[\s*-]+hashed row is unfalsifiable/);
  });

  /** ⚠️ It runs BEFORE the code, which is the opposite of 0079 and 0080. */
  it("says to run it before the code, and why that is the opposite of 0079", () => {
    expect(MIGRATION).toContain("RUN THIS BEFORE PUSHING THE CODE, NOT AFTER");
    expect(MIGRATION).toContain("42703");
    expect(MIGRATION).toContain("turns the audit trail off silently");
  });

  it("is safe to run twice", () => {
    expect(MIGRATION).toContain("SAFE TO RUN TWICE");
    expect(MIGRATION).toContain("BEGIN;");
    expect(MIGRATION).toContain("COMMIT;");
  });

  /**
   * ⚠️ AND IT ADMITS THE HALF THAT IS NOT WIRED. `recordPlatformAudit()`
   * lives in `server/platform/guard.ts`, outside this batch, so
   * `platform_action_log` has the columns and nothing writes them. A
   * silently-empty integrity column is worse than an absent one.
   */
  it("admits that platform_action_log has no writer yet", () => {
    expect(MIGRATION).toContain("NOT YET WRITTEN");
    expect(MIGRATION).toContain("server/platform/guard.ts");
    expect(VERIFY).toContain("Writer NOT wired");
  });
});

describe("the verify", () => {
  it("is neon-safe and writes nothing", () => {
    expect(VERIFY).toContain("SAFE AGAINST NEON");
    expect(VERIFY).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/);
  });

  /** 🔴 IT VERIFIES THE EXISTING CHAIN AND NAMES THE FIRST BROKEN LINK. */
  it("verifies the chain and reports the first broken link", () => {
    expect(VERIFY).toContain("audit_chain_link_hash(");
    expect(VERIFY).toContain("first_broken_seq");
    expect(VERIFY).toContain("first_broken_row");
    expect(VERIFY).toContain("row_hash_should_be");
    for (const kind of ["row_hash_mismatch", "sequence_gap", "link_broken", "head_truncated"]) {
      expect(VERIFY, kind).toContain(kind);
    }
  });

  /**
   * ⭐ ONLY THE FIRST BREAK. After a genuine tamper every subsequent row
   * fails too; listing them buries the row that was actually edited.
   */
  it("reports only the first break, and says why", () => {
    expect(VERIFY).toContain("DISTINCT ON (scope)");
    expect(VERIFY).toContain("ONLY THE FIRST, ON PURPOSE");
  });

  /**
   * ⚠️ AND ITS ROLE CHECK READS THE OPPOSITE WAY FROM 0079'S. There, a
   * connection bypassing RLS made every policy inert. Here, a connection
   * SUBJECT to RLS sees one tenant, so a clean verdict covers one
   * workspace and says nothing about the rest.
   */
  it("ends by saying what the verdict actually covers", () => {
    expect(VERIFY).toContain("rolbypassrls");
    expect(VERIFY).toContain("THE OPPOSITE READING FROM VERIFY-0079");
    expect(VERIFY).toContain("It is not a pass");
  });
});

describe("the drill", () => {
  it("refuses to run against anything that looks real", () => {
    expect(DRILL).toContain("DO NOT RUN THIS IN NEON");
    expect(DRILL).toContain("current_database() LIKE '%neon%'");
    expect(DRILL).toContain("REFUSING");
  });

  /**
   * ⚠️ AND UNLIKE 0079'S DRILL IT DOES NOT REFUSE A SUPERUSER, WHICH IS
   * DELIBERATE AND EXPLAINED. 0079 tested RLS, which a superuser
   * bypasses. 0081 tests arithmetic, which nobody bypasses — and the
   * intruder this feature exists for IS the person who can turn the
   * append-only trigger off.
   */
  it("explains why a privileged role is the right role here", () => {
    expect(DRILL).toContain("DOES **NOT** REFUSE TO RUN AS A");
    expect(DRILL).toContain("THE ATTACKER THIS FEATURE EXISTS");
    expect(codeOnly(DRILL)).toContain("ALTER TABLE audit_logs DISABLE TRIGGER");
  });

  /** Paired positives and refusals, counted. */
  it("pairs six positives with seven refusals", () => {
    expect((DRILL.match(/⭐ POSITIVE \d/g) ?? []).length).toBe(6);
    expect((DRILL.match(/🔴 REFUSAL \d/g) ?? []).length).toBe(7);
    expect(DRILL).toContain("6 positives succeeded");
    expect(DRILL).toContain("7 refusals raised an error or reported a break");
  });

  /** 🔴 THE ONE THE TASK IS ABOUT: an edited historical row is caught. */
  it("edits a historical row and shows the break appearing there", () => {
    expect(DRILL).toContain("EDITING A HISTORICAL ROW IS NOW DETECTABLE");
    expect(DRILL).toContain("first_break_kind = row_hash_mismatch");
    expect(DRILL).toContain("repairing that row MOVES the break");
    expect(DRILL).toContain("first_break_kind = link_broken");
  });

  /** And a positive that the chain verifies, without which nothing else means anything. */
  it("proves a freshly written chain verifies first", () => {
    expect(DRILL).toContain("POSITIVE 1 — the chain verifies");
    expect(DRILL).toContain("IF POSITIVE 1 DID NOT SHOW broken_links = 0");
  });
});
