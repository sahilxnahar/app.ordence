/**
 * Ordence — The audit hash chain
 * Version: v1.38.0-alpha  (Mega-wave 1, Batch 44)
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, IN ONE PARAGRAPH
 * ══════════════════════════════════════════════════════════════════════
 * `audit_logs` and `platform_action_log` are append-only BY POLICY: a
 * BEFORE UPDATE/DELETE trigger refuses the statement and an RLS policy
 * refuses the connection. Both controls live inside the database and both
 * are therefore available to anybody who reaches the database — a
 * `psql` session as the owner can `ALTER TABLE ... DISABLE TRIGGER`,
 * rewrite a row, and re-enable it, and nothing anywhere records that it
 * happened. This file makes that rewrite DETECTABLE.
 *
 * It is deliberately pure: no imports from `@/db`, no `server-only`, no
 * I/O. Hashing that cannot be called from a test, a script or a future
 * verifier job is hashing nobody checks.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 1 — WE HASH THE PREVIOUS ROW'S HASH, NOT JUST THE ROW
 * ══════════════════════════════════════════════════════════════════════
 * The naive version is a per-row digest of the row's own contents. It
 * catches exactly one attacker: the one who edits a row and forgets that
 * a checksum column exists. Against anybody who reads the schema it is
 * worthless, because recomputing one row's own digest after editing it is
 * a single UPDATE.
 *
 * Chaining changes the cost. `row_hash(N)` covers `row_hash(N-1)`, so
 * `row_hash(N+1)` covers it transitively, and so on to the head. Editing
 * row N therefore forces the attacker to recompute EVERY row after it or
 * leave a visible discontinuity at exactly the row they touched. A
 * one-row edit becomes a whole-tail rewrite:
 *
 *     seq 41  content_hash C41  prev ← row_hash(40)   row_hash R41
 *     seq 42  content_hash C42  prev ← R41            row_hash R42
 *     seq 43  content_hash C43  prev ← R42            row_hash R43
 *                                     ▲
 *              edit seq 41 and this stops matching. Fix R41 and seq 42's
 *              `prev_hash` stops matching. Fix that and R42 changes, so
 *              seq 43 breaks. The break moves; it does not disappear.
 *
 * ⚠️ AND HERE IS WHAT IT STILL DOES NOT PROVE, SAID PLAINLY. SHA-256 has
 * no secret in it. An attacker with UPDATE on the table and the patience
 * to run the recompute CAN rewrite the tail and leave a chain that
 * verifies perfectly. What the chain buys is:
 *
 *   • a partial or lazy tamper (the overwhelmingly common one — someone
 *     edits the row that embarrasses them) is caught immediately;
 *   • a complete tamper requires touching every subsequent row, which is
 *     loud in WAL, in replica lag, in backup diffs and in table bloat;
 *   • and IF the head hash has been copied somewhere the attacker cannot
 *     reach — an object store with retention lock, a signed nightly
 *     e-mail, a customer's own inbox — then even the complete rewrite is
 *     provable, because the recomputed head will not match the anchor.
 *
 * 🔴 THAT LAST BULLET IS THE ONE THAT ACTUALLY CLOSES IT, AND IT IS NOT
 * IMPLEMENTED HERE. `VERIFY-0081-neon-safe.sql` prints the head hash per
 * chain precisely so it can be anchored by whoever owns the export job.
 * Until something outside this database keeps a copy, this file gives
 * TAMPER EVIDENCE AGAINST AN ATTACKER WHO DOES NOT RECOMPUTE, and
 * nothing stronger. Claiming otherwise would be the kind of assurance
 * that is worse than none.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 CONSTRAINT 2 — THE CHAIN IS PER TENANT
 * ══════════════════════════════════════════════════════════════════════
 * Every chain is identified by a `scope` string: a tenant's uuid, or the
 * literal `platform` for the rows that belong to no workspace. There is
 * no global chain and there deliberately never will be. Four reasons, in
 * descending order of how hard they are to argue with:
 *
 *   1. ⭐ A GLOBAL CHAIN IS NOT IMPLEMENTABLE UNDER THE RLS WE ALREADY
 *      HAVE. `audit_logs_tenant_isolation` is
 *      `USING (tenant_id = app_current_tenant_id())`. To append to a
 *      global chain, a write inside tenant A must READ the last row —
 *      which may belong to tenant B — and the database refuses. The only
 *      way through is a `SECURITY DEFINER` function that bypasses tenant
 *      isolation on the audit table, i.e. adding a cross-tenant read path
 *      to the most sensitive table in the system in order to protect it.
 *
 *   2. IT LEAKS WRITE ORDER ACROSS CUSTOMERS. Tenant A verifying its own
 *      chain would have to be handed the hashes of the rows between its
 *      own — and gaps in its sequence numbers would tell it, precisely,
 *      how many audited actions every other workspace performed and when.
 *      That is a side channel on customer activity delivered by the
 *      integrity feature.
 *
 *   3. ONE BUSY WORKSPACE WOULD SERIALISE EVERYBODY. Appending to a chain
 *      means ordering against its current head. A single chain makes
 *      every audit write in the product contend on one row, so the
 *      noisiest customer sets the audit latency of every other customer.
 *      Per tenant, contention is bounded by that tenant's own traffic.
 *
 *   4. AND IT MAKES THE FAILURE BLAST RADIUS GLOBAL. One unchained row —
 *      see the degradation rule below — breaks the chain it is in. Per
 *      tenant that is one workspace's chain restarting; globally it is
 *      everybody's.
 *
 * ⚠️ THE COST, STATED: a per-tenant chain proves nothing about the
 * ORDER of events BETWEEN workspaces, and cannot detect the deletion of
 * an entire tenant's audit history (there is no other chain that
 * references it). `created_at` and the tenant row itself are the only
 * evidence there. A cross-chain "checkpoint" table that periodically
 * records every head hash would close that, and is the obvious next step
 * — it is not in this batch and is not pretended to be.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CONSTRAINT 3 — WHAT HAPPENS UNDER CONCURRENCY
 * ══════════════════════════════════════════════════════════════════════
 * Two audit writes in the same tenant at the same instant both read the
 * same head and both compute `prev_hash` from it. There are two honest
 * answers and this codebase picks the second:
 *
 *   (a) A LOCK. `pg_advisory_xact_lock(tenant)` around read-then-append
 *       serialises audit writes per tenant. Correct, simple, and it makes
 *       the audit write a point of contention that can BLOCK — and a
 *       blocked audit write on a request path is a blocked request. It
 *       also introduces a lock ordering that has to be reasoned about
 *       against every other lock the request already holds.
 *
 *   (b) ⭐ OPTIMISTIC APPEND, WHICH IS WHAT WE DO. The writer reads the
 *       head, computes the next sequence number, and inserts. A UNIQUE
 *       index on `(tenant_id, chain_seq)` means the loser of a race gets
 *       `23505 unique_violation` at INSERT rather than a silently forked
 *       chain, and retries against the new head. No lock is taken, no
 *       lock is held across the hashing, and the failure mode is a retry
 *       rather than a wait.
 *
 * 🔴 WHAT (b) GUARANTEES: within one tenant, `chain_seq` is dense and
 * total, and every row's `prev_hash` is the `row_hash` of the row with
 * the immediately preceding sequence number. Two writers cannot both
 * occupy a sequence number. That is enough for the verifier to prove
 * that no row was removed from, or inserted into, the middle of the
 * chain without a recompute.
 *
 * 🔴 WHAT (b) DOES **NOT** PROVE — and this is the honest part:
 *
 *   • `chain_seq` IS NOT A WALL-CLOCK ORDER. Under a race the writer
 *     that reached the index first gets the lower number even if its
 *     event happened microseconds later. The chain proves an APPEND
 *     order, not a happened-before relation. Anything that needs real
 *     ordering must read `created_at` and accept its resolution.
 *   • IT DOES NOT PROVE COMPLETENESS. Nothing here can show that an
 *     action which SHOULD have been audited ever reached the table. A
 *     chain over rows 1..N is silent about the write that was never
 *     attempted. Only the call sites can give you that, and they are
 *     `requirePermission` and `writeAudit`, not this file.
 *   • AND UNDER SUSTAINED CONTENTION IT DEGRADES RATHER THAN BLOCKING.
 *     See constraint 5.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CONSTRAINT 4 — EXISTING ROWS HAVE NO HASH, AND WE DO NOT FAKE ONE
 * ══════════════════════════════════════════════════════════════════════
 * Every row written before 0081 has NULL chain columns. It is trivial to
 * write a backfill that walks them in `created_at` order and computes a
 * chain — and it would be a lie. A hash computed today over a row that
 * has been sitting in a mutable table for a year proves only that the
 * row said this TODAY. It attests to the state at backfill time and
 * presents itself as attesting to the state at write time, which is the
 * single most dangerous thing an integrity feature can do: it converts
 * "we do not know" into "verified".
 *
 * So: no backfill. `verifyAuditChain()` reports `startsAtSeq` and
 * `unchainedRows`, and the caller is expected to say "chain starts at
 * row X; the N rows before it are outside it" rather than "history
 * verified".
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ CONSTRAINT 5 — AN AUDIT WRITE MUST NEVER BREAK THE OPERATION
 * ══════════════════════════════════════════════════════════════════════
 * Enforced in `server/audit.ts`, where the try/catch already lives; the
 * reasoning is recorded there. The part that belongs HERE is the shape
 * that makes the degradation legible: an unchained row is
 * `chain_seq IS NULL AND content_hash IS NULL AND row_hash IS NULL`, a
 * state the migration's CHECK constraint makes the ONLY permitted
 * partial state, and which the verifier counts and reports out loud.
 * A row that is present but outside the chain is strictly better than a
 * row that was never written, and strictly worse than a chained one, and
 * the reporting says which of the three you have.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/* THE DOMAIN SEPARATOR AND THE FRAMING                                */
/* ------------------------------------------------------------------ */

/**
 * Prefixed into every digest.
 *
 * ⚠️ THE VERSION IS PART OF THE HASH ON PURPOSE. If the canonical form
 * ever has to change, `v2` rows will simply fail to verify against a `v1`
 * verifier — which is loud and obviously a format change — instead of
 * verifying "wrong" and being indistinguishable from tampering. Changing
 * this string invalidates every hash ever written, so a change means a
 * new column or a new chain, never an edit to this constant.
 */
export const AUDIT_CHAIN_DOMAIN = "ordence-audit-chain-v1";

/** ASCII UNIT SEPARATOR. Chosen because it cannot occur in a hex digest,
 *  a uuid or an ISO timestamp, so a reader can see the framing. It is
 *  belt-and-braces only: the length prefixes below are what actually
 *  make the encoding unambiguous. */
const US = "\u001f";

/**
 * Length-prefix a field: `<bytes>:<value>`.
 *
 * 🔴 WITHOUT THIS THE HASH IS FORGEABLE BY REBALANCING. Plain
 * concatenation makes `("ab", "c")` and `("a", "bc")` the same input, so
 * an attacker who controls two adjacent fields can move a character
 * across the boundary and keep the digest. `resource_type` and
 * `resource_id` are adjacent and both attacker-influenced, which is
 * exactly the pair that matters.
 *
 * ⚠️ BYTES, NOT CHARACTERS. Postgres `octet_length()` counts bytes, and
 * `audit_chain_link_hash()` in 0081 has to produce byte-identical input
 * to this function or the SQL verifier disagrees with the TypeScript one
 * on every non-ASCII row. `"₹"` is one character and three bytes.
 */
function lp(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* CANONICAL JSON                                                      */
/* ------------------------------------------------------------------ */

/**
 * Deterministic serialisation of an audit row's content.
 *
 * 🔴 `JSON.stringify()` IS NOT DETERMINISTIC ENOUGH FOR THIS. Its key
 * order is insertion order, so the same logical row hashed by two code
 * paths that happened to build the object differently produces two
 * different digests — and every one of those looks exactly like
 * tampering to the verifier. Sorted keys are not a nicety here; they are
 * the difference between a verifier that means something and a verifier
 * that cries wolf until somebody switches it off.
 *
 * ⚠️ SORTED BY UTF-16 CODE UNIT (`<`), which is what `Array.sort()` does
 * by default and is stable across Node versions and locales.
 * `localeCompare` is NOT used precisely because it is locale-sensitive.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";

  if (value instanceof Date) {
    // ⚠️ ISO-8601 in UTC, milliseconds included. A `Date` rendered by
    // `toString()` carries the server's timezone, so the same instant
    // hashed in Mumbai and in a UTC container would differ.
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }

  const t = typeof value;

  if (t === "string" || t === "boolean") return JSON.stringify(value);

  if (t === "number") {
    // NaN and ±Infinity have no JSON form; `JSON.stringify` turns them
    // into `null` silently, which would make two different rows hash the
    // same. Refuse instead — a metadata payload containing Infinity is a
    // bug at the call site, not something to paper over in the hasher.
    if (!Number.isFinite(value as number)) {
      throw new TypeError("canonicalJson: non-finite number cannot be canonicalised.");
    }
    // `Object.is(-0, 0)` is false but `String(-0) === "0"`, so -0 and 0
    // collapse. That is correct: they are the same audited quantity.
    return String(value);
  }

  if (t === "bigint") {
    // Serialised as a decimal string, not a JSON number: a bigint that
    // survives a round trip through `JSON.parse` would come back as a
    // lossy double and re-hash differently.
    return JSON.stringify(`${value as bigint}n`);
  }

  if (Array.isArray(value)) {
    // ⚠️ Array order IS significant and is preserved. Two audit payloads
    // that differ only in the order of a list are different payloads.
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      // `undefined` is dropped, matching `JSON.stringify` and matching
      // what Postgres does with a jsonb field that was never set. A row
      // is not different because the writer passed `{ x: undefined }`.
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }

  // functions, symbols — a call site trying to audit one of these has a
  // bug, and silently hashing it as `null` would hide the bug forever.
  throw new TypeError(`canonicalJson: unsupported value of type ${t}.`);
}

/* ------------------------------------------------------------------ */
/* THE TWO DIGESTS, AND WHY THERE ARE TWO                              */
/* ------------------------------------------------------------------ */

/**
 * Digest of an audit row's CONTENT — everything the row says happened.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ WHY CONTENT AND LINK ARE SEPARATE DIGESTS
 * ══════════════════════════════════════════════════════════════════════
 * The obvious design is one hash over `prev_hash` plus every column. It
 * has one fatal property: NOTHING BUT THIS FILE CAN EVER CHECK IT. The
 * content includes three `jsonb` columns, and to re-hash them in SQL you
 * would have to reproduce JavaScript's JSON canonicalisation in
 * PL/pgSQL, exactly, forever — number formatting, unicode escapes, key
 * ordering. Two implementations of that WILL diverge, and every
 * divergence presents itself as a tampered row. A verifier that reports
 * false tampering gets muted, and a muted verifier is not a control.
 *
 * So the split is:
 *
 *   `content_hash` — SHA-256 over canonical JSON of the row's content.
 *                    Computed here, checkable ONLY here (and by anything
 *                    else running this exact function).
 *   `row_hash`     — SHA-256 over `(domain, scope, seq, prev_hash,
 *                    content_hash)`. Every input is a plain text column,
 *                    so `audit_chain_link_hash()` in 0081 recomputes it
 *                    in SQL, byte for byte, with no JSON involved.
 *
 * The consequence, stated so nobody over-reads the SQL verifier: pure
 * SQL proves the LINK layer — no row was removed, reordered or inserted,
 * and no row's `content_hash` was swapped for another — but it CANNOT
 * prove that `content_hash` still matches the row's own columns. That
 * check needs `verifyAuditChain()`. `VERIFY-0081-neon-safe.sql` says so
 * in its own header rather than leaving a reader to assume otherwise.
 */
export function hashAuditContent(content: Record<string, unknown>): string {
  return sha256Hex(
    [AUDIT_CHAIN_DOMAIN, "content", lp(canonicalJson(content))].join(US),
  );
}

export type AuditLinkInput = {
  /** Tenant uuid, or `PLATFORM_CHAIN_SCOPE`. See constraint 2. */
  scope: string;
  /** 1-based, dense within the scope. */
  seq: number;
  /** `row_hash` of `seq - 1`, or null at the genesis row. */
  prevHash: string | null;
  contentHash: string;
};

/**
 * Digest of a row's POSITION in its chain.
 *
 * ⚠️ THIS FUNCTION HAS A TWIN IN SQL. `audit_chain_link_hash()` in
 * `SQL-FILES/0081_audit_hash_chain.sql` must produce identical output.
 * Changing the framing here without changing it there makes every row
 * written afterwards look tampered to the SQL verifier — the two
 * definitions are commented as a pair in both files, and
 * `tests/ui/audit-chain.test.ts` asserts the SQL text still matches this
 * shape.
 *
 * ⭐ `prevHash: null` IS ENCODED AS THE EMPTY STRING, not omitted. With
 * length prefixes `0:` is a distinct, unforgeable encoding, so a genesis
 * row cannot be made to hash like a row whose predecessor was deleted.
 * The SQL twin uses `coalesce(prev_hash, '')` for exactly this.
 */
export function hashAuditLink(input: AuditLinkInput): string {
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    throw new RangeError("hashAuditLink: seq must be a positive integer.");
  }
  return sha256Hex(
    [
      AUDIT_CHAIN_DOMAIN,
      lp(input.scope),
      lp(String(input.seq)),
      lp(input.prevHash ?? ""),
      lp(input.contentHash),
    ].join(US),
  );
}

/**
 * The scope key for rows that belong to no workspace — `platform_action_log`
 * in its entirety, and the `tenant_id IS NULL` rows of `audit_logs`.
 *
 * ⚠️ IT IS A WORD, NOT A NULL AND NOT A ZERO UUID. A null scope would
 * make the digest input ambiguous with a tenant whose id serialised to
 * nothing; the all-zero uuid is a value somebody could one day insert as
 * a real tenant id. `platform` cannot be a uuid, so it can never collide
 * with one.
 */
export const PLATFORM_CHAIN_SCOPE = "platform";

export function chainScopeFor(tenantId: string | null | undefined): string {
  return tenantId ?? PLATFORM_CHAIN_SCOPE;
}

/* ------------------------------------------------------------------ */
/* APPENDING                                                           */
/* ------------------------------------------------------------------ */

export type AuditChainLink = {
  chainSeq: number;
  prevHash: string | null;
  contentHash: string;
  rowHash: string;
};

/** The head of a chain as read back from the table, or null if empty. */
export type AuditChainHead = { chainSeq: number; rowHash: string } | null;

/**
 * Compute the chain columns for a row about to be appended.
 *
 * Pure — it takes the head the caller read and returns the columns; it
 * does not know what a database is. That is what lets the test drive a
 * whole chain, a fork and three kinds of tamper without one.
 */
export function nextChainLink(args: {
  scope: string;
  head: AuditChainHead;
  content: Record<string, unknown>;
}): AuditChainLink {
  const contentHash = hashAuditContent(args.content);
  const chainSeq = (args.head?.chainSeq ?? 0) + 1;
  const prevHash = args.head?.rowHash ?? null;
  return {
    chainSeq,
    prevHash,
    contentHash,
    rowHash: hashAuditLink({ scope: args.scope, seq: chainSeq, prevHash, contentHash }),
  };
}

/* ------------------------------------------------------------------ */
/* VERIFYING                                                           */
/* ------------------------------------------------------------------ */

export type AuditChainRow = {
  /** Row identity, only ever used to name a break in the report. */
  id: string;
  chainSeq: number | null;
  prevHash: string | null;
  contentHash: string | null;
  rowHash: string | null;
  /** The row's content, rebuilt by the caller in the SAME shape the
   *  writer hashed. Omit to skip content verification for that row. */
  content?: Record<string, unknown>;
};

export type AuditChainBreakKind =
  /** The row's columns no longer hash to its stored `content_hash`. */
  | "content_rewritten"
  /** `row_hash` does not match `(scope, seq, prev_hash, content_hash)`. */
  | "row_hash_mismatch"
  /** `prev_hash` is not the predecessor's `row_hash`. */
  | "link_broken"
  /** A sequence number is missing — a row was removed. */
  | "sequence_gap"
  /** Partially-hashed row; the migration's CHECK should make this impossible. */
  | "malformed";

export type AuditChainBreak = {
  kind: AuditChainBreakKind;
  chainSeq: number;
  rowId: string;
  detail: string;
};

export type AuditChainReport = {
  scope: string;
  /** ⚠️ TRUE ONLY ABOUT THE CHAINED ROWS. Never read it as "history is
   *  intact" — read it together with `startsAtSeq` and `unchainedRows`. */
  ok: boolean;
  /** 🔴 CONSTRAINT 4. The first sequence number that exists at all. Rows
   *  older than this are OUTSIDE the chain and are not attested. */
  startsAtSeq: number | null;
  endsAtSeq: number | null;
  chainedRows: number;
  /** Rows carrying no hash: written before 0081, or degraded. */
  unchainedRows: number;
  /** The head `row_hash`. ⭐ THIS IS THE VALUE TO ANCHOR OUTSIDE THE
   *  DATABASE — see the note on constraint 1. */
  headHash: string | null;
  /** The first break, in sequence order. Null when the chain is intact. */
  firstBreak: AuditChainBreak | null;
  /** A one-line human summary that does not overclaim. */
  summary: string;
};

/**
 * Verify one chain, end to end.
 *
 * ⭐ IT REPORTS THE **FIRST** BREAK AND KEEPS GOING NO FURTHER FOR THAT
 * DIAGNOSIS. After a genuine tamper every subsequent row also fails,
 * because each one covers the one before it; listing all of them would
 * bury the row that was actually touched under a thousand consequences
 * of touching it. The first break IS the location of the edit.
 *
 * ⚠️ ROWS WITH NO HASH ARE COUNTED, NOT FAILED. A pre-0081 row is not
 * evidence of tampering, it is evidence of a chain that started later.
 * Failing them would make the verifier report a tamper on every
 * deployment that has any history at all, and it would be switched off
 * within a week.
 */
export function verifyAuditChain(
  scope: string,
  rows: readonly AuditChainRow[],
): AuditChainReport {
  const chained = rows
    .filter((r) => r.chainSeq !== null || r.rowHash !== null || r.contentHash !== null)
    .slice()
    .sort((a, b) => (a.chainSeq ?? 0) - (b.chainSeq ?? 0));

  const unchainedRows = rows.length - chained.length;

  const base: AuditChainReport = {
    scope,
    ok: true,
    startsAtSeq: null,
    endsAtSeq: null,
    chainedRows: chained.length,
    unchainedRows,
    headHash: null,
    firstBreak: null,
    summary: "",
  };

  if (chained.length === 0) {
    return {
      ...base,
      summary:
        `No chained rows for scope ${scope}. ` +
        `${unchainedRows} row(s) predate the chain and are NOT attested.`,
    };
  }

  const report = (b: AuditChainBreak): AuditChainReport => ({
    ...base,
    ok: false,
    startsAtSeq: chained[0]?.chainSeq ?? null,
    endsAtSeq: null,
    firstBreak: b,
    summary:
      `🔴 TAMPER EVIDENT for scope ${scope}: ${b.kind} at chain_seq ${b.chainSeq} ` +
      `(row ${b.rowId}). ${b.detail} Every row after it is unverifiable ` +
      `because each one covers the row before it.`,
  });

  let prev: AuditChainRow | null = null;

  for (const row of chained) {
    // A partially-hashed row cannot be reasoned about at all, and the
    // migration's CHECK constraint refuses to store one — so seeing it
    // means somebody was writing to the table outside the application.
    if (row.chainSeq === null || row.rowHash === null || row.contentHash === null) {
      return report({
        kind: "malformed",
        chainSeq: row.chainSeq ?? -1,
        rowId: row.id,
        detail:
          "Row has some chain columns set and others NULL, which the 0081 " +
          "CHECK constraint forbids.",
      });
    }

    if (prev === null) {
      // ⚠️ THE FIRST CHAINED ROW IS NOT REQUIRED TO BE seq 1. A workspace
      // whose chain begins at 4,001 simply had 4,000 rows before 0081.
      // Demanding seq 1 would report a tamper on every existing tenant.
      base.startsAtSeq = row.chainSeq;
    } else {
      const expected = (prev.chainSeq ?? 0) + 1;
      if (row.chainSeq !== expected) {
        return report({
          kind: "sequence_gap",
          chainSeq: row.chainSeq,
          rowId: row.id,
          detail: `Expected chain_seq ${expected}; a row was removed or never committed.`,
        });
      }
      if (row.prevHash !== prev.rowHash) {
        return report({
          kind: "link_broken",
          chainSeq: row.chainSeq,
          rowId: row.id,
          detail:
            `prev_hash ${row.prevHash ?? "NULL"} is not the row_hash of ` +
            `chain_seq ${prev.chainSeq} (${prev.rowHash}).`,
        });
      }
    }

    // Content check — only where the caller supplied the content. A
    // read that did not select the payload columns should not be able to
    // produce a false "content_rewritten".
    if (row.content !== undefined) {
      const recomputed = hashAuditContent(row.content);
      if (recomputed !== row.contentHash) {
        return report({
          kind: "content_rewritten",
          chainSeq: row.chainSeq,
          rowId: row.id,
          detail:
            `The row's own columns hash to ${recomputed} but it stores ` +
            `${row.contentHash}. The row was edited after it was written.`,
        });
      }
    }

    const expectedRowHash = hashAuditLink({
      scope,
      seq: row.chainSeq,
      prevHash: row.prevHash,
      contentHash: row.contentHash,
    });
    if (expectedRowHash !== row.rowHash) {
      return report({
        kind: "row_hash_mismatch",
        chainSeq: row.chainSeq,
        rowId: row.id,
        detail:
          `row_hash should be ${expectedRowHash} for this position and ` +
          `content_hash, but the row stores ${row.rowHash}.`,
      });
    }

    prev = row;
  }

  const head = chained[chained.length - 1]!;
  return {
    ...base,
    ok: true,
    startsAtSeq: chained[0]!.chainSeq,
    endsAtSeq: head.chainSeq,
    headHash: head.rowHash,
    summary:
      `✅ Chain intact for scope ${scope}: chain_seq ` +
      `${chained[0]!.chainSeq}…${head.chainSeq}, ${chained.length} row(s). ` +
      `⚠️ CHAIN STARTS AT ROW ${chained[0]!.chainSeq} — the ${unchainedRows} ` +
      `row(s) before it carry no hash and are NOT attested by this result. ` +
      `Head ${head.rowHash} — anchor it outside this database or a full-tail ` +
      `rewrite remains undetectable.`,
  };
}
