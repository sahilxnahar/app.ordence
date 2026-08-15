-- =====================================================================
--  Ordence · 0081 · The audit log becomes TAMPER-EVIDENT
--  Version: v1.38.0-alpha  (Mega-wave 1, Batch 44)
-- =====================================================================
--
--  🔴 RUN THIS BEFORE PUSHING THE CODE, NOT AFTER.
--
--  ⚠️ THE OPPOSITE ORDER FROM 0079 AND 0080, AND THE REASON IS WORTH
--  ONE PARAGRAPH. Those two made policies and CHECKs STRICTER, so the
--  old code could no longer satisfy them and had to go out first. This
--  one only ADDS nullable columns and a helper function. Nothing that
--  exists today writes them, so on the current build this file is inert.
--  The NEW code, however, INSERTs `chain_seq`, `prev_hash`,
--  `content_hash` and `row_hash` — and against a database without those
--  columns every audit write raises 42703 `column does not exist`, which
--  `writeAudit`'s catch block swallows by design. Deploying the code
--  first therefore turns the audit trail off silently. That is character
--  for character the defect the comment block in `server/audit.ts`
--  describes at length, so it would be an unusually poor thing to
--  reintroduce in the migration that hardens the same table.
--
--  ⚠️ SAFE TO RUN TWICE. Columns are ADD ... IF NOT EXISTS, constraints
--  are DROP ... IF EXISTS then ADD, indexes are CREATE ... IF NOT
--  EXISTS, the function is CREATE OR REPLACE, all inside one
--  transaction.
--
-- =====================================================================
--  WHAT THIS FIXES, IN ONE PARAGRAPH
-- =====================================================================
--
--  `audit_logs` and `platform_action_log` are append-only BY POLICY. A
--  BEFORE UPDATE/DELETE trigger (`audit_logs_block_mutation()`, 0001)
--  refuses the statement, and RLS refuses the connection. Both controls
--  live INSIDE the database, so both are available to anybody who
--  reaches the database with owner rights:
--
--      ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
--      UPDATE audit_logs SET reason = 'routine' WHERE id = '...';
--      ALTER TABLE audit_logs ENABLE  TRIGGER audit_logs_no_update;
--
--  Three statements, no trace. The trigger prevents the APPLICATION from
--  rewriting history; it does not detect anything, and it was never
--  meant to. This migration adds the detection.
--
-- =====================================================================
--  THE SHAPE — TWO DIGESTS, AND WHY THERE ARE TWO
-- =====================================================================
--
--    content_hash  SHA-256 over the canonical JSON of the row's content.
--                  Produced by `hashAuditContent()` in lib/audit/chain.ts.
--                  🔴 IT CANNOT BE RECOMPUTED IN SQL, and no attempt is
--                  made to. Doing so would mean reimplementing
--                  JavaScript's JSON canonicalisation in PL/pgSQL —
--                  key order, number formatting, unicode escapes —
--                  exactly, forever, for three `jsonb` columns. Two
--                  implementations of that WILL drift, and every drift
--                  presents itself as a tampered row. A verifier that
--                  cries wolf gets muted, and a muted verifier is not a
--                  control.
--
--    row_hash      SHA-256 over (domain, scope, chain_seq, prev_hash,
--                  content_hash). ⭐ EVERY INPUT IS A PLAIN TEXT COLUMN,
--                  which is the entire point: `audit_chain_link_hash()`
--                  below recomputes it in SQL, byte for byte, with no
--                  JSON anywhere near it. That is what lets
--                  VERIFY-0081 prove the LINK layer — nothing removed,
--                  reordered or inserted — from a read-only session.
--
--  So the division of labour is explicit:
--
--      pure SQL      proves the chain's STRUCTURE
--      TypeScript    proves each row's CONTENT
--
--  and neither file claims the other's guarantee.
--
-- =====================================================================
--  🔴 WHAT THIS DOES NOT PROVE. READ THIS BEFORE QUOTING IT AT ANYBODY.
-- =====================================================================
--
--  SHA-256 HAS NO SECRET IN IT. An attacker with UPDATE on the table can
--  edit row N, recompute row N's hashes, and then recompute every row
--  after it, and the chain will verify perfectly. What the chain changes
--  is the COST and the NOISE: a one-row edit becomes a whole-tail
--  rewrite, which is loud in WAL, in replica lag, in backup diffs and in
--  table bloat, and which cannot be done by hand.
--
--  ⭐ THE THING THAT WOULD ACTUALLY CLOSE IT is an anchor — a copy of
--  each chain's head hash kept somewhere the attacker cannot reach (an
--  object store with a retention lock, a signed nightly mail, the
--  customer's own inbox). Then even the complete rewrite is provable,
--  because the recomputed head will not match the anchor. THAT IS NOT IN
--  THIS MIGRATION. Section 5 of VERIFY-0081 prints the head hash per
--  chain precisely so whoever owns the export job can anchor it.
--
--  Until then this gives TAMPER EVIDENCE AGAINST AN ATTACKER WHO DOES
--  NOT RECOMPUTE — which is very nearly all of them, because the
--  realistic insider edits the one row that embarrasses them — and
--  nothing stronger.
--
-- =====================================================================

BEGIN;

-- =====================================================================
--  SECTION 1 — THE COLUMNS
-- =====================================================================
--
--  🔴 EVERY COLUMN IS NULLABLE AND NOTHING IS BACKFILLED.
--
--  It would take one `UPDATE ... FROM` to walk the existing rows in
--  `created_at` order and give them a chain. It would also be a lie. A
--  hash computed TODAY over a row that has been sitting in a mutable
--  table for a year attests to the row's state at BACKFILL time and
--  presents itself as attesting to its state at WRITE time. That is the
--  single most dangerous thing an integrity feature can do: it converts
--  "we do not know" into "verified", and the people who would rely on it
--  are exactly the people who cannot check.
--
--  ⚠️ SO THE VERIFIER REPORTS "CHAIN STARTS AT ROW X" and counts the
--  rows before it as NOT ATTESTED. See section 2 of VERIFY-0081.
--
--  `chain_seq` is bigint rather than integer: it is per tenant and
--  monotonic forever, and an audit sequence that wraps at 2.1 billion is
--  a chain that silently forks on the busiest workspace we have.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS chain_seq    bigint,
  ADD COLUMN IF NOT EXISTS prev_hash    text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS row_hash     text;

ALTER TABLE platform_action_log
  ADD COLUMN IF NOT EXISTS chain_seq    bigint,
  ADD COLUMN IF NOT EXISTS prev_hash    text,
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS row_hash     text;

COMMENT ON COLUMN audit_logs.chain_seq IS
  'Dense 1-based position in THIS TENANT''S chain. NULL means the row is '
  'outside the chain: written before 0081, or degraded under contention. '
  'Never backfilled — a hash computed later proves nothing about earlier.';

COMMENT ON COLUMN audit_logs.prev_hash IS
  'row_hash of chain_seq - 1 in the same tenant. NULL only at the genesis '
  'row. This column is what makes an edit to row N force a recompute of '
  'every row after it.';

COMMENT ON COLUMN audit_logs.content_hash IS
  'SHA-256 of the canonical JSON of this row''s content, from '
  'lib/audit/chain.ts. NOT recomputable in SQL, by design — see 0081.';

COMMENT ON COLUMN audit_logs.row_hash IS
  'SHA-256 of (domain, scope, chain_seq, prev_hash, content_hash). Every '
  'input is a plain text column, so audit_chain_link_hash() recomputes it '
  'in SQL and VERIFY-0081 can prove the chain structure read-only.';

COMMENT ON COLUMN platform_action_log.chain_seq IS
  'Position in the single `platform` chain — this table has no tenant_id, '
  'because the Phase 17 rule sends tenant-attributed rows to audit_logs. '
  '🔴 NOT YET WRITTEN: recordPlatformAudit() lives in '
  'server/platform/guard.ts, which Batch 44 does not own. Every row here '
  'is still unchained and VERIFY-0081 reports it as such.';

-- =====================================================================
--  SECTION 2 — THE CONSTRAINTS
-- =====================================================================
--
--  ⭐ THE ALL-OR-NOTHING CHECK IS THE IMPORTANT ONE.
--
--  Without it, "partially hashed" is a legal state, and a partially
--  hashed row is unfalsifiable: an attacker who edits a row can simply
--  NULL its `content_hash` and claim the row predates the chain. With
--  it, the only two legal states are FULLY CHAINED and FULLY UNCHAINED,
--  so blanking a hash is itself a constraint violation that has to be
--  worked around by dropping the constraint — one more statement in the
--  audit-of-the-audit, and one more thing VERIFY-0081 section 1 checks
--  is still there.
--
--  ⚠️ `prev_hash` IS THE ONE EXCEPTION, because the genesis row has no
--  predecessor. It may be NULL, but ONLY on a chained row: an unchained
--  row with a `prev_hash` is nonsense.
--
--  ⚠️ AND THE HEX FORMAT CHECK IS NOT COSMETIC. `row_hash` is compared
--  to the output of `encode(sha256(...), 'hex')`, which is 64 lowercase
--  hex characters. A row storing `'DEADBEEF'` or an uppercase digest
--  would compare unequal and be reported as tampering, when the real
--  fault is a writer producing the wrong format. Refusing it at INSERT
--  names the writer instead of framing the row.

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_chain_all_or_nothing;
ALTER TABLE audit_logs ADD  CONSTRAINT audit_logs_chain_all_or_nothing CHECK (
  (chain_seq IS NULL     AND content_hash IS NULL     AND row_hash IS NULL
                         AND prev_hash    IS NULL)
  OR
  (chain_seq IS NOT NULL AND content_hash IS NOT NULL AND row_hash IS NOT NULL)
);

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_chain_hex;
ALTER TABLE audit_logs ADD  CONSTRAINT audit_logs_chain_hex CHECK (
  (prev_hash    IS NULL OR prev_hash    ~ '^[0-9a-f]{64}$')
  AND (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
  AND (row_hash     IS NULL OR row_hash     ~ '^[0-9a-f]{64}$')
  AND (chain_seq    IS NULL OR chain_seq >= 1)
);

ALTER TABLE platform_action_log DROP CONSTRAINT IF EXISTS platform_action_log_chain_all_or_nothing;
ALTER TABLE platform_action_log ADD  CONSTRAINT platform_action_log_chain_all_or_nothing CHECK (
  (chain_seq IS NULL     AND content_hash IS NULL     AND row_hash IS NULL
                         AND prev_hash    IS NULL)
  OR
  (chain_seq IS NOT NULL AND content_hash IS NOT NULL AND row_hash IS NOT NULL)
);

ALTER TABLE platform_action_log DROP CONSTRAINT IF EXISTS platform_action_log_chain_hex;
ALTER TABLE platform_action_log ADD  CONSTRAINT platform_action_log_chain_hex CHECK (
  (prev_hash    IS NULL OR prev_hash    ~ '^[0-9a-f]{64}$')
  AND (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
  AND (row_hash     IS NULL OR row_hash     ~ '^[0-9a-f]{64}$')
  AND (chain_seq    IS NULL OR chain_seq >= 1)
);

-- =====================================================================
--  SECTION 3 — THE UNIQUE INDEXES, WHICH ARE THE CONCURRENCY DESIGN
-- =====================================================================
--
--  ⚠️ THIS IS WHERE THE ANSWER TO "WHAT HAPPENS UNDER CONCURRENCY"
--  ACTUALLY LIVES. Two audit writes in the same tenant at the same
--  instant both read the same head and both compute `chain_seq = N+1`.
--  There were two honest options:
--
--    (a) A LOCK. `pg_advisory_xact_lock(tenant)` around read-then-append
--        serialises audit writes per tenant. Correct and simple, and it
--        makes the audit write something that can BLOCK — and a blocked
--        audit write on a request path is a blocked request.
--
--    (b) ⭐ OPTIMISTIC APPEND, WHICH IS WHAT THESE INDEXES IMPLEMENT.
--        The loser of the race hits `23505 unique_violation` at INSERT
--        instead of silently forking the chain, and `server/audit.ts`
--        retries against the new head. No lock is taken and none is held
--        across the hashing.
--
--  🔴 WITHOUT THESE INDEXES OPTION (b) IS NOT MERELY WEAKER, IT IS
--  WORTHLESS. Two rows at `chain_seq = 41` both pointing at row 40 is a
--  FORK, and a fork is indistinguishable from an insertion: the verifier
--  would have to pick one branch, and an attacker could insert a row by
--  simply writing a second seq 41. The uniqueness is what makes
--  "position N in this tenant's chain" mean one row.
--
--  ⚠️ TWO INDEXES ON `audit_logs`, NOT ONE, BECAUSE `tenant_id` IS
--  NULLABLE. In a plain `UNIQUE (tenant_id, chain_seq)` every NULL
--  tenant compares distinct from every other, so the platform rows —
--  precisely the ones about crossing tenant boundaries — would get no
--  uniqueness at all. `NULLS NOT DISTINCT` would also work on PG15+;
--  two partial indexes are used instead because they are explicit about
--  which population each one covers and they work on any version.
--
--  ⭐ THE PARTIAL PREDICATE ALSO KEEPS THE PRE-0081 ROWS OUT. Millions
--  of rows with `chain_seq IS NULL` are not indexed, so this costs
--  nothing on history and only indexes what is chained.

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_chain_tenant_seq_uq
  ON audit_logs (tenant_id, chain_seq)
  WHERE tenant_id IS NOT NULL AND chain_seq IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_chain_platform_seq_uq
  ON audit_logs (chain_seq)
  WHERE tenant_id IS NULL AND chain_seq IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS platform_action_log_chain_seq_uq
  ON platform_action_log (chain_seq)
  WHERE chain_seq IS NOT NULL;

-- =====================================================================
--  SECTION 4 — THE SQL TWIN OF `hashAuditLink()`
-- =====================================================================
--
--  🔴 THIS FUNCTION AND `hashAuditLink()` IN lib/audit/chain.ts MUST
--  PRODUCE IDENTICAL OUTPUT. They are a pair. Changing the framing in
--  one without the other makes every row written afterwards look
--  tampered to whichever verifier was not updated, which is the worst
--  possible failure mode for this feature: a false accusation.
--  `tests/ui/audit-chain.test.ts` asserts the two definitions still
--  describe the same encoding.
--
--  THE ENCODING, spelled out so it can be reimplemented anywhere:
--
--      domain  US  lp(scope)  US  lp(seq)  US  lp(prev)  US  lp(content)
--
--  where  US       = chr(31), the ASCII unit separator
--         lp(x)    = octet_length(x) || ':' || x
--         domain   = 'ordence-audit-chain-v1'
--         scope    = tenant_id::text, or 'platform' for a tenant-less row
--         prev     = prev_hash, or '' at the genesis row
--
--  ⚠️ WHY LENGTH PREFIXES. Plain concatenation makes ('ab','c') and
--  ('a','bc') the same input, so an attacker controlling two adjacent
--  fields can move a character across the boundary and keep the digest.
--  The separator alone is not enough — a field containing chr(31) would
--  forge a boundary. The length prefix makes the encoding injective, and
--  it is BYTES, not characters, because `octet_length` counts bytes and
--  `Buffer.byteLength` had to agree with it: '₹' is one character and
--  three bytes.
--
--  ⚠️ WHY THE EMPTY STRING FOR A MISSING `prev_hash` RATHER THAN
--  OMITTING THE FIELD. With a length prefix, `0:` is a distinct and
--  unforgeable encoding, so a genesis row cannot be made to hash like a
--  row whose predecessor was deleted. Omitting the field would collapse
--  those two into the same digest, which is exactly the tamper this
--  chain exists to catch.
--
--  ⭐ `sha256()` IS A BUILT-IN SINCE PostgreSQL 11. No pgcrypto, no
--  extension to install on Neon, nothing to ask a DBA for.
--
--  IMMUTABLE is correct and load-bearing: the output depends only on the
--  arguments, which is what lets a verifier query use it in a WHERE
--  clause without the planner re-evaluating it per row per predicate.

CREATE OR REPLACE FUNCTION audit_chain_link_hash(
  p_scope        text,
  p_seq          bigint,
  p_prev_hash    text,
  p_content_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT encode(
    sha256(convert_to(
      'ordence-audit-chain-v1'
      || chr(31) || octet_length(p_scope)::text        || ':' || p_scope
      || chr(31) || octet_length(p_seq::text)::text    || ':' || p_seq::text
      || chr(31) || octet_length(p_prev_hash)::text    || ':' || p_prev_hash
      || chr(31) || octet_length(p_content_hash)::text || ':' || p_content_hash,
      'UTF8')),
    'hex');
$fn$;

COMMENT ON FUNCTION audit_chain_link_hash(text, bigint, text, text) IS
  'SQL twin of hashAuditLink() in lib/audit/chain.ts. MUST produce '
  'identical output — they are a pair, and a change to one without the '
  'other makes every subsequent row look tampered. STRICT: pass '
  'coalesce(prev_hash, '''') at the genesis row, never NULL, or the '
  'result is NULL and the row reads as unverifiable rather than as '
  'genesis.';

-- =====================================================================
--  SECTION 5 — THE TABLE COMMENTS THAT WERE TOO CONFIDENT
-- =====================================================================
--
--  0001 says `audit_logs` is append-only so that "even a compromised
--  application account cannot rewrite history". True and worth keeping —
--  and read by more than one person as "history cannot be rewritten",
--  which was never what it said. The distinction now matters, because
--  0081 is the thing that addresses the other half.

COMMENT ON TABLE audit_logs IS
  'Append-only by trigger AND tamper-evident by hash chain (0081). The '
  'trigger stops the APPLICATION rewriting a row; it detects nothing, '
  'and anybody with owner rights can disable it, edit, and re-enable in '
  'three statements. The per-tenant chain in chain_seq/prev_hash/'
  'content_hash/row_hash is what makes that edit provable: changing row '
  'N forces recomputing every row after it. ⚠️ IT DOES NOT MAKE A FULL '
  'RECOMPUTE IMPOSSIBLE — SHA-256 has no secret in it. Anchor the head '
  'hash outside this database (VERIFY-0081 section 5) if you need that. '
  '⚠️ Rows written before 0081 carry NULLs and are NOT attested; they '
  'are deliberately not backfilled.';

COMMENT ON TABLE platform_action_log IS
  'Append-only register of what platform staff did, tenant-less by the '
  'Phase 17 rule. Carries the 0081 chain columns for a single `platform` '
  'chain, but 🔴 NOTHING WRITES THEM YET: recordPlatformAudit() lives in '
  'server/platform/guard.ts, outside Batch 44''s scope. VERIFY-0081 '
  'reports "0 of N chained — writer not wired" rather than treating the '
  'NULLs as a break.';

COMMIT;

-- =====================================================================
--  ⚠️ WHAT TO CHECK AFTER RUNNING THIS
-- =====================================================================
--
--  VERIFY-0081-neon-safe.sql          read-only, safe against Neon.
--                                     Section 3 verifies the EXISTING
--                                     chain and names the first broken
--                                     link if there is one.
--  DRILL-DO-NOT-RUN-IN-NEON-0081.sql  paired positives and refusals,
--                                     throwaway Postgres only. Its last
--                                     refusal edits a historical row and
--                                     shows the break appearing exactly
--                                     there.
--
--  🔴 IF VERIFY SECTION 3 REPORTS A BROKEN LINK ON THE DAY YOU RUN
--  THIS, it is not a tamper — there are no chained rows yet, so it will
--  report "chain not started". A break can only appear once the new code
--  has written rows. The first thing to check if one ever does appear is
--  whether `audit_chain_link_hash()` above still matches
--  `hashAuditLink()` in lib/audit/chain.ts, because a mismatched pair
--  frames innocent rows and is far likelier than an intruder.
-- =====================================================================
