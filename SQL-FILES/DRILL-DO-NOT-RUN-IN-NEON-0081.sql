-- =====================================================================
--  🔴🔴🔴 DRILL — DO NOT RUN THIS IN NEON 🔴🔴🔴
-- =====================================================================
--
--  It creates tables and rows, it DISABLES AN APPEND-ONLY TRIGGER, and
--  it then deliberately rewrites audit history to show the rewrite being
--  caught. Throwaway Postgres only.
--
--     createdb drill0081
--     psql -q -d drill0081 -f DRILL-DO-NOT-RUN-IN-NEON-0081.sql
--
--  ⚠️ UNLIKE 0079'S DRILL, THIS ONE DOES **NOT** REFUSE TO RUN AS A
--  SUPERUSER, AND THE REASON IS THE WHOLE POINT OF THE MIGRATION. 0079
--  tested ROW-LEVEL SECURITY, which a superuser bypasses, so running it
--  privileged would have passed every refusal for the wrong reason. 0081
--  tests a HASH CHAIN, which no role bypasses because it is arithmetic
--  and not a permission. Better still: THE ATTACKER THIS FEATURE EXISTS
--  FOR IS, BY DEFINITION, SOMEBODY WITH FULL DATABASE RIGHTS — the
--  person who can turn the append-only trigger off. So the drill runs as
--  exactly that person, and the point is that the tamper is still
--  visible afterwards.
--
--  ⭐ EVERY REFUSAL IS PAIRED WITH THE WRITE THAT MUST STILL WORK. A
--  drill that only shows breaks cannot tell "detecting tampering" from
--  "broken verifier that flags everything", and a verifier that cries
--  wolf is one that gets muted.
--
--  ⚠️ ONE REFUSAL HERE IS UNUSUAL AND DELIBERATE: POSITIVE 4 SHOWS THE
--  CHAIN VERIFYING AFTER A COMPLETE, COMPETENT REWRITE. That is not a
--  bug in the drill — it is the honest limit of an unanchored SHA-256
--  chain, demonstrated rather than described, and REFUSAL 5 immediately
--  afterwards shows the anchor catching what the chain could not.
-- =====================================================================


-- =====================================================================
--  STEP 0 — REFUSE TO RUN SOMEWHERE THAT MATTERS
-- =====================================================================
DO $$
BEGIN
  IF current_database() LIKE '%neon%'
     OR current_database() IN ('neondb', 'ordence', 'production')
  THEN
    RAISE EXCEPTION
      '🔴 REFUSING: database "%" looks real. Drills run on a throwaway only.',
      current_database();
  END IF;
END
$$;


-- =====================================================================
--  STEP 1 — THE SHAPES, REPRODUCED FROM THE MIGRATIONS
-- =====================================================================
--
--  `audit_logs` cut down to the columns this drill reasons about, plus
--  the append-only trigger from 0001 and everything 0081 adds.
--
--  ⚠️ RLS IS DELIBERATELY ABSENT. It is 0001's control and 0079's drill
--  covers it; here it would be inert anyway (see the header) and its
--  presence would only invite the reader to think a refusal below came
--  from a policy when it came from a digest.

DROP TABLE IF EXISTS audit_logs, chain_anchor CASCADE;
DROP FUNCTION IF EXISTS audit_chain_link_hash(text, bigint, text, text) CASCADE;
DROP FUNCTION IF EXISTS drill_content_hash(jsonb) CASCADE;
DROP FUNCTION IF EXISTS drill_append(uuid, text, text) CASCADE;

CREATE TABLE audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid,
  action       text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  chain_seq    bigint,
  prev_hash    text,
  content_hash text,
  row_hash     text
);

-- ---- from 0081 section 2 -------------------------------------------
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_chain_all_or_nothing CHECK (
  (chain_seq IS NULL     AND content_hash IS NULL     AND row_hash IS NULL
                         AND prev_hash    IS NULL)
  OR
  (chain_seq IS NOT NULL AND content_hash IS NOT NULL AND row_hash IS NOT NULL)
);

ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_chain_hex CHECK (
  (prev_hash    IS NULL OR prev_hash    ~ '^[0-9a-f]{64}$')
  AND (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
  AND (row_hash     IS NULL OR row_hash     ~ '^[0-9a-f]{64}$')
  AND (chain_seq    IS NULL OR chain_seq >= 1)
);

-- ---- from 0081 section 3 -------------------------------------------
CREATE UNIQUE INDEX audit_logs_chain_tenant_seq_uq
  ON audit_logs (tenant_id, chain_seq)
  WHERE tenant_id IS NOT NULL AND chain_seq IS NOT NULL;

CREATE UNIQUE INDEX audit_logs_chain_platform_seq_uq
  ON audit_logs (chain_seq)
  WHERE tenant_id IS NULL AND chain_seq IS NOT NULL;

-- ---- from 0001 -----------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

-- ---- from 0081 section 4, copied VERBATIM ---------------------------
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

/*
 * ⚠️ THE DRILL'S STAND-IN FOR `content_hash`, AND WHY A STAND-IN IS
 * HONEST HERE.
 *
 * In production `content_hash` is SHA-256 over canonical JSON produced
 * by `hashAuditContent()` in lib/audit/chain.ts, and SQL deliberately
 * does not reproduce that — see 0081's header for why reimplementing
 * JavaScript's JSON canonicalisation in PL/pgSQL is how two verifiers
 * come to disagree.
 *
 * ⭐ IT DOES NOT MATTER FOR THIS DRILL. Everything under test below —
 * the linkage, the sequence, the propagation of a break down the tail,
 * the uniqueness that stops a fork — belongs to the LINK layer, which is
 * exactly the layer VERIFY-0081 checks in production. All the drill
 * needs from `content_hash` is that it is a digest of the row's content,
 * so that editing the content and repairing the digest is the same two
 * steps an intruder would take.
 */
CREATE OR REPLACE FUNCTION drill_content_hash(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT encode(sha256(convert_to(
    'ordence-audit-chain-v1' || chr(31) || 'content' || chr(31)
    || octet_length(p::text)::text || ':' || p::text, 'UTF8')), 'hex');
$fn$;

/*
 * The append, mirroring `appendChainedAuditRow()` in server/audit.ts:
 * read the head of THIS TENANT'S chain, seq := head + 1, prev := head's
 * row_hash, hash, insert. The unique index is what turns a race into a
 * 23505 rather than a fork — REFUSAL 6 provokes it directly.
 */
CREATE OR REPLACE FUNCTION drill_append(p_tenant uuid, p_action text, p_reason text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_scope   text := coalesce(p_tenant::text, 'platform');
  v_seq     bigint;
  v_prev    text;
  v_content text;
BEGIN
  SELECT a.chain_seq, a.row_hash INTO v_seq, v_prev
    FROM audit_logs a
   WHERE coalesce(a.tenant_id::text, 'platform') = v_scope
     AND a.chain_seq IS NOT NULL
   ORDER BY a.chain_seq DESC
   LIMIT 1;

  v_seq := coalesce(v_seq, 0) + 1;
  v_content := drill_content_hash(jsonb_build_object('action', p_action, 'reason', p_reason));

  INSERT INTO audit_logs (tenant_id, action, reason,
                          chain_seq, prev_hash, content_hash, row_hash)
  VALUES (p_tenant, p_action, p_reason,
          v_seq, v_prev, v_content,
          audit_chain_link_hash(v_scope, v_seq, coalesce(v_prev, ''), v_content));
END;
$fn$;

/*
 * THE VERIFIER — the same four faults, in the same order, as sections 3
 * and 4 of VERIFY-0081-neon-safe.sql. Kept as a view so every assertion
 * below reads `SELECT * FROM chain_report` and the drill cannot
 * accidentally test a verifier that is not the shipped one.
 */
CREATE OR REPLACE VIEW chain_report AS
WITH chained AS (
  SELECT id, coalesce(tenant_id::text, 'platform') AS scope,
         chain_seq, prev_hash, content_hash, row_hash
    FROM audit_logs
   WHERE chain_seq IS NOT NULL
),
linked AS (
  SELECT c.*,
         lag(c.row_hash)  OVER w AS predecessor_hash,
         lag(c.chain_seq) OVER w AS predecessor_seq
    FROM chained c
  WINDOW w AS (PARTITION BY c.scope ORDER BY c.chain_seq)
),
judged AS (
  SELECT scope, chain_seq,
         CASE
           WHEN row_hash <> audit_chain_link_hash(
                  scope, chain_seq, coalesce(prev_hash, ''), content_hash)
             THEN 'row_hash_mismatch'
           WHEN predecessor_seq IS NULL AND (chain_seq <> 1 OR prev_hash IS NOT NULL)
             THEN 'head_truncated'
           WHEN predecessor_seq IS NOT NULL AND chain_seq <> predecessor_seq + 1
             THEN 'sequence_gap'
           WHEN predecessor_seq IS NOT NULL AND prev_hash IS DISTINCT FROM predecessor_hash
             THEN 'link_broken'
           ELSE NULL
         END AS break_kind
    FROM linked
)
SELECT scope,
       count(*)                                       AS chained_rows,
       count(*) FILTER (WHERE break_kind IS NOT NULL) AS broken_links,
       (array_agg(chain_seq  ORDER BY chain_seq)
          FILTER (WHERE break_kind IS NOT NULL))[1]   AS first_broken_seq,
       (array_agg(break_kind ORDER BY chain_seq)
          FILTER (WHERE break_kind IS NOT NULL))[1]   AS first_break_kind
  FROM judged
 GROUP BY scope
 ORDER BY scope;

-- The out-of-band copy of each head hash. ⭐ IN PRODUCTION THIS TABLE
-- IS NOT IN THIS DATABASE — that is the entire value of an anchor. Here
-- it stands in for the object store with a retention lock.
CREATE TABLE chain_anchor (
  scope       text PRIMARY KEY,
  head_seq    bigint NOT NULL,
  head_hash   text   NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now()
);


-- =====================================================================
--  STEP 2 — SOME HISTORY
-- =====================================================================
--
--  Tenant A: five chained rows.
--  Tenant B: three chained rows, kept clean so the later refusals have
--            a control to compare against.
--  Tenant C: ⭐ TWO UNCHAINED ROWS FIRST, then two chained ones — this
--            is every existing workspace on the day 0081 ships, and it
--            is what POSITIVE 6 is about.

\set A '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set B '''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'''
\set C '''cccccccc-cccc-cccc-cccc-cccccccccccc'''

SELECT drill_append(:A::uuid, 'login',            'Priya signed in');
SELECT drill_append(:A::uuid, 'update',           'Invoice INV-0042 total changed to 118000');
SELECT drill_append(:A::uuid, 'permission_change','Ravi granted transactions:post');
SELECT drill_append(:A::uuid, 'export',           'Customer list exported');
SELECT drill_append(:A::uuid, 'delete',           'Draft order removed');

SELECT drill_append(:B::uuid, 'login',  'Anita signed in');
SELECT drill_append(:B::uuid, 'update', 'Contact updated');
SELECT drill_append(:B::uuid, 'logout', 'Anita signed out');

-- Pre-0081 rows: present, real, and carrying no hash. Never backfilled.
INSERT INTO audit_logs (tenant_id, action, reason)
VALUES (:C::uuid, 'login',  'written months before 0081'),
       (:C::uuid, 'update', 'also written before 0081');
SELECT drill_append(:C::uuid, 'login',  'the first row after 0081 shipped');
SELECT drill_append(:C::uuid, 'export', 'and the second');


\set ON_ERROR_STOP off

-- ---------------------------------------------------------------------
\echo '--- ⭐ POSITIVE 1 — the chain verifies -------------------------'
--     🔴 THE ASSERTION THE WHOLE FILE HANGS ON. If a freshly written
--     chain does not verify, every refusal below is meaningless because
--     the verifier flags everything.
-- ---------------------------------------------------------------------
SELECT * FROM chain_report;
-- EXPECT: broken_links = 0 for all three scopes.

-- ---------------------------------------------------------------------
\echo '--- ⭐ POSITIVE 2 — the chains are PER TENANT ------------------'
--     Each workspace numbers from 1 independently. A global chain would
--     need a write inside tenant A to read tenant B's last row, which
--     `audit_logs_tenant_isolation` refuses outright — so a global chain
--     is not merely undesirable here, it is unimplementable without
--     adding a cross-tenant read path to the most sensitive table there
--     is. See constraint 2 in lib/audit/chain.ts.
-- ---------------------------------------------------------------------
SELECT coalesce(tenant_id::text, 'platform') AS scope,
       min(chain_seq) AS from_seq, max(chain_seq) AS to_seq, count(*) AS rows
  FROM audit_logs WHERE chain_seq IS NOT NULL GROUP BY 1 ORDER BY 1;
-- EXPECT: three scopes, each starting at 1. A→1..5, B→1..3, C→1..2.

-- The anchor, taken while the chain is known good.
INSERT INTO chain_anchor (scope, head_seq, head_hash)
SELECT DISTINCT ON (coalesce(tenant_id::text, 'platform'))
       coalesce(tenant_id::text, 'platform'), chain_seq, row_hash
  FROM audit_logs WHERE chain_seq IS NOT NULL
 ORDER BY 1, chain_seq DESC;

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 1 — the append-only trigger still refuses -------'
--     The policy layer from 0001 is untouched. 0081 adds detection; it
--     does not replace prevention, and an audit trail that lost the
--     trigger in exchange for a hash would be a worse trade.
-- ---------------------------------------------------------------------
UPDATE audit_logs SET reason = 'nothing to see here'
 WHERE tenant_id = :A::uuid AND chain_seq = 3;
-- EXPECT: ERROR 42501 audit_logs is append-only; UPDATE is not permitted

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 2 — EDITING A HISTORICAL ROW IS NOW DETECTABLE --'
--     🔴🔴 THE HEADLINE. The intruder has database rights, so they turn
--     the trigger off — three statements, no trace, and this is exactly
--     what "append-only by policy" could never stop.
--
--     They edit seq 3 (the permission grant they would rather nobody
--     read) AND repair its `content_hash`, because leaving the content
--     digest stale would be caught by the TypeScript verifier. What they
--     have NOT done is repair `row_hash`.
-- ---------------------------------------------------------------------
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
UPDATE audit_logs
   SET reason       = 'routine access review',
       content_hash = drill_content_hash(
         jsonb_build_object('action', 'permission_change',
                            'reason', 'routine access review'))
 WHERE tenant_id = :A::uuid AND chain_seq = 3;
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;

SELECT * FROM chain_report WHERE scope = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
-- EXPECT: broken_links = 1, first_broken_seq = 3,
--         first_break_kind = row_hash_mismatch
-- ⭐ EXACTLY ONE ROW IS FLAGGED, AND IT IS THE ONE THEY TOUCHED. Rows 4
--    and 5 still link cleanly, because their `prev_hash` names the STALE
--    `row_hash` of seq 3, which the intruder did not think to change.
--    The verifier does not merely say "something is wrong" — it names
--    the row. REFUSAL 3 is what happens when they do think of it.

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 3 — repairing that row MOVES the break ----------'
--     🔴 THIS IS CONSTRAINT 1 MADE VISIBLE. The intruder recomputes seq
--     3's `row_hash` so its own row is self-consistent again. The break
--     does not disappear — it moves to seq 4, because seq 4's
--     `prev_hash` still names the OLD seq 3.
--
--     A per-row hash with no chaining would have ended here, with the
--     tamper repaired in two statements. Chaining is what turns a
--     one-row edit into a whole-tail rewrite.
-- ---------------------------------------------------------------------
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
UPDATE audit_logs
   SET row_hash = audit_chain_link_hash(
         tenant_id::text, chain_seq, coalesce(prev_hash, ''), content_hash)
 WHERE tenant_id = :A::uuid AND chain_seq = 3;
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;

SELECT * FROM chain_report WHERE scope = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
-- EXPECT: broken_links = 1, first_broken_seq = 4, first_break_kind = link_broken
-- ⭐ THE COUNT DID NOT GROW — THE BREAK MOVED. Seq 3 is now internally
--    consistent and seq 4 is not, so repairing one row bought the
--    intruder nothing except a different row to repair. Repeat five
--    times and they have rewritten the whole tail (POSITIVE 3).

-- ---------------------------------------------------------------------
\echo '--- ⭐ POSITIVE 3 — and rewriting the WHOLE TAIL verifies ------'
--     ⚠️ A POSITIVE THAT PROVES A LIMIT, NOT A CAPABILITY. SHA-256 has
--     no secret in it, so an intruder patient enough to walk the tail
--     leaves a chain that verifies perfectly. Anyone who reads the chain
--     as proof of an untouched history needs to see this happen.
--
--     What it cost them: every row after the edit had to be rewritten,
--     which is loud in WAL, in replica lag, in backup diffs and in table
--     bloat, and cannot be done by hand. What it did NOT cost them:
--     anything the verifier in this database can see.
-- ---------------------------------------------------------------------
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update;
DO $$
DECLARE r record; v_prev text;
BEGIN
  FOR r IN SELECT id, tenant_id, chain_seq, content_hash FROM audit_logs
            WHERE tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
              AND chain_seq >= 4 ORDER BY chain_seq
  LOOP
    SELECT a.row_hash INTO v_prev FROM audit_logs a
      WHERE a.tenant_id = r.tenant_id AND a.chain_seq = r.chain_seq - 1;
    UPDATE audit_logs
       SET prev_hash = v_prev,
           row_hash  = audit_chain_link_hash(
             r.tenant_id::text, r.chain_seq, coalesce(v_prev, ''), r.content_hash)
     WHERE id = r.id;
  END LOOP;
END
$$;
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update;

SELECT * FROM chain_report WHERE scope = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
-- EXPECT: broken_links = 0. The chain says the history is intact. It is not.

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 4 — but the ANCHOR still catches it -------------'
--     ⭐ THE ONE CONTROL THAT SURVIVES AN INTRUDER WITH FULL DATABASE
--     RIGHTS, because it is not in the database. The head hash recorded
--     while the chain was known good no longer matches the head hash
--     now, and nothing they can do inside Postgres changes the copy.
--
--     🔴 THIS IS WHY SECTION 5 OF VERIFY-0081 PRINTS THE HEAD HASH.
--     Nothing automates the export yet, and until something does, the
--     chain gives tamper evidence against an intruder who does not
--     recompute — which is very nearly all of them — and not proof.
-- ---------------------------------------------------------------------
SELECT k.scope,
       k.head_hash                       AS anchored_head,
       h.row_hash                        AS head_now,
       (k.head_hash = h.row_hash)        AS anchor_matches
  FROM chain_anchor k
  JOIN LATERAL (
    SELECT row_hash FROM audit_logs a
     WHERE coalesce(a.tenant_id::text, 'platform') = k.scope
       AND a.chain_seq IS NOT NULL
     ORDER BY a.chain_seq DESC LIMIT 1
  ) h ON true
 ORDER BY k.scope;
-- EXPECT: anchor_matches = false for tenant A, true for B and C.

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 5 — removing a row leaves a gap -----------------'
--     Tenant B, kept clean until now. Deleting the middle row is the
--     other obvious tamper, and it is caught by the sequence rather than
--     by a hash: seq 3 arrives where seq 2 should be.
-- ---------------------------------------------------------------------
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_delete;
DELETE FROM audit_logs WHERE tenant_id = :B::uuid AND chain_seq = 2;
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_delete;

SELECT * FROM chain_report WHERE scope = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- EXPECT: broken_links = 1, first_broken_seq = 3, first_break_kind = sequence_gap

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 6 — a FORKED chain is impossible ----------------'
--     ⚠️ THIS IS THE CONCURRENCY DESIGN, TESTED. Two audit writes in
--     one tenant at the same instant both read the same head and both
--     compute the same next sequence number. The unique index turns the
--     loser into a 23505 that `server/audit.ts` retries, instead of two
--     rows sharing position 5 — and two rows at one position is
--     indistinguishable from an insertion, so an intruder could add a
--     row simply by writing a second seq 5.
-- ---------------------------------------------------------------------
INSERT INTO audit_logs (tenant_id, action, reason, chain_seq, prev_hash, content_hash, row_hash)
SELECT tenant_id, 'update', 'a second row at the same position',
       chain_seq, prev_hash, content_hash, row_hash
  FROM audit_logs WHERE tenant_id = :A::uuid AND chain_seq = 5;
-- EXPECT: ERROR 23505 duplicate key value violates unique constraint
--         "audit_logs_chain_tenant_seq_uq"

-- ---------------------------------------------------------------------
\echo '--- 🔴 REFUSAL 7 — a HALF-hashed row is impossible -------------'
--     Without the all-or-nothing CHECK, "partially hashed" is a legal
--     state and a partially hashed row is unfalsifiable: an intruder who
--     edits a row can blank its `content_hash` and claim it predates the
--     chain. With it, blanking a hash is itself a violation they have to
--     work around by dropping the constraint — one more statement, and
--     one more thing VERIFY-0081 section 1 checks is still there.
-- ---------------------------------------------------------------------
INSERT INTO audit_logs (tenant_id, action, chain_seq, prev_hash, content_hash, row_hash)
VALUES (:A::uuid, 'update', 99, NULL, NULL, repeat('f', 64));
-- EXPECT: ERROR 23514 violates check constraint "audit_logs_chain_all_or_nothing"

-- ---------------------------------------------------------------------
\echo '--- ⭐ POSITIVE 4 — an UNCHAINED row is still accepted ---------'
--     🔴 CONSTRAINT 5, AND IT IS THE REASON THIS IS A POSITIVE AND NOT
--     A REFUSAL. An audit write must never break the operation it
--     describes. When hashing cannot complete — the head read failed,
--     or the optimistic append lost its retries under sustained
--     contention — `server/audit.ts` writes the row with every chain
--     column NULL rather than losing it. A row outside the chain is
--     strictly better than no row, strictly worse than a chained one,
--     and the verifier says which of the three you have.
-- ---------------------------------------------------------------------
INSERT INTO audit_logs (tenant_id, action, reason)
VALUES (:A::uuid, 'security_event', 'written while the chain was unavailable')
RETURNING action, chain_seq, row_hash;
-- EXPECT: one row, chain_seq NULL, row_hash NULL. (RETURNING rather than
--         a bare INSERT because `psql -q` suppresses the command tag,
--         and a positive nobody can see in the transcript is not one.)

-- ---------------------------------------------------------------------
\echo '--- ⭐ POSITIVE 5 — degraded rows do not read as a tamper ------'
--     The row just written is counted as unchained, not reported as a
--     break. A verifier that failed on it would flag every deployment
--     with any history at all, and would be switched off within a week.
-- ---------------------------------------------------------------------
SELECT * FROM chain_report WHERE scope = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
-- EXPECT: broken_links = 0 — tenant C is untouched despite its two
--         pre-0081 rows, and tenant A's new unchained row did not
--         change tenant A's chained count either.

-- ---------------------------------------------------------------------
\echo '--- ⭐ POSITIVE 6 — "chain starts at row X", not "verified" ----'
--     🔴 CONSTRAINT 4. Tenant C has two rows written before 0081. They
--     are NOT backfilled: a hash computed today over a row that has sat
--     in a mutable table for a year attests to its state today while
--     presenting itself as attesting to its state when it was written,
--     which turns "we do not know" into "verified" for exactly the
--     people who cannot check.
-- ---------------------------------------------------------------------
SELECT coalesce(tenant_id::text, 'platform')         AS scope,
       count(*)                                      AS total_rows,
       count(*) FILTER (WHERE chain_seq IS NULL)     AS unchained_not_attested,
       min(chain_seq)                                AS chain_starts_at_seq
  FROM audit_logs
 GROUP BY 1 ORDER BY 1;
-- EXPECT: tenant C shows 4 rows, 2 unchained, chain starting at seq 1.
--         Those 2 are outside the chain and always will be.

\set ON_ERROR_STOP on

-- =====================================================================
--  SUMMARY OF WHAT MUST HAVE HAPPENED
-- =====================================================================
--    6 positives succeeded
--    7 refusals raised an error or reported a break
--
--  ⚠️ IF POSITIVE 1 DID NOT SHOW broken_links = 0, STOP AND READ
--  NOTHING ELSE. A verifier that flags a freshly written chain flags
--  everything, and every refusal below it passed for the wrong reason.
--
--  ⚠️ AND IF POSITIVE 3 SHOWED A BREAK, the drill is wrong rather than
--  the feature: a complete tail rewrite IS supposed to verify. That is
--  the limit this file exists to make visible, and REFUSAL 4 is the only
--  thing that catches it.
-- =====================================================================
