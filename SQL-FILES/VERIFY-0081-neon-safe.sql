-- =====================================================================
--  Ordence · VERIFY 0081 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
--
--  🔴 WHAT SECTION 3 PROVES, AND WHAT IT CANNOT.
--
--  It recomputes `row_hash` for every chained row with
--  `audit_chain_link_hash()` and walks the links. That proves the
--  chain's STRUCTURE: no row was removed from it, none was inserted into
--  it, none was reordered, and no row's `content_hash` was swapped for
--  another row's.
--
--  ⚠️ IT DOES NOT PROVE THAT `content_hash` STILL MATCHES THE ROW'S OWN
--  COLUMNS. That digest is over canonical JSON produced by
--  `lib/audit/chain.ts`, and reproducing JavaScript's JSON
--  canonicalisation in PL/pgSQL — key order, number formatting, unicode
--  escapes — exactly and forever is how two verifiers come to disagree,
--  and every disagreement looks like tampering. Content verification is
--  `verifyAuditChain()` in that file. This one is the half that can be
--  run from a read-only session against production, and it is the half
--  that catches the shape of tamper an insider actually performs.
--
--  ⚠️ AND NEITHER HALF PROVES COMPLETENESS. Nothing here can show that
--  an action which SHOULD have been audited ever reached the table.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. THE COLUMNS AND THE CONSTRAINTS ARE ACTUALLY THERE.
--
--     `chain_columns` below must be 4 on both tables. `all_or_nothing`
--     false is the one that matters most: without that constraint,
--     "partially hashed" becomes a legal state, and a partially hashed
--     row is unfalsifiable — an intruder who edits a row can blank its
--     `content_hash` and claim the row predates the chain.
-- ---------------------------------------------------------------------
SELECT t.relname                                            AS table_name,
       count(*) FILTER (WHERE a.attname IN
             ('chain_seq', 'prev_hash', 'content_hash', 'row_hash')) AS chain_columns,
       EXISTS (SELECT 1 FROM pg_constraint k
                WHERE k.conrelid = t.oid
                  AND k.conname LIKE '%chain_all_or_nothing')        AS all_or_nothing,
       EXISTS (SELECT 1 FROM pg_constraint k
                WHERE k.conrelid = t.oid
                  AND k.conname LIKE '%chain_hex')                   AS hex_format_checked,
       (SELECT count(*) FROM pg_index i
         WHERE i.indrelid = t.oid AND i.indisunique
           AND pg_get_indexdef(i.indexrelid) LIKE '%chain_seq%')     AS unique_seq_indexes
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE n.nspname = 'public'
   AND t.relname IN ('audit_logs', 'platform_action_log')
 GROUP BY t.oid, t.relname
 ORDER BY t.relname;
-- ⭐ EXPECT: chain_columns = 4, both booleans true, and
--    unique_seq_indexes = 2 on audit_logs (tenant rows and platform
--    rows are indexed separately because tenant_id is nullable and NULLs
--    compare distinct), 1 on platform_action_log.


-- ---------------------------------------------------------------------
--  2. 🔴 WHERE EACH CHAIN STARTS — i.e. HOW MUCH OF HISTORY IS NOT
--     ATTESTED AT ALL.
--
--     Rows written before 0081 carry NULLs and were deliberately NOT
--     backfilled: a hash computed today over a row that has been sitting
--     in a mutable table for a year attests to its state TODAY while
--     presenting itself as attesting to its state when it was written.
--
--     ⚠️ READ `unchained_rows` BEFORE READING SECTION 3. Section 3 can
--     only ever say "the chain is intact"; this section is what stops
--     that being heard as "the history is intact".
-- ---------------------------------------------------------------------
SELECT coalesce(tenant_id::text, 'platform')                  AS scope,
       count(*)                                               AS total_rows,
       count(*) FILTER (WHERE chain_seq IS NULL)              AS unchained_rows,
       count(*) FILTER (WHERE chain_seq IS NOT NULL)          AS chained_rows,
       min(chain_seq)                                         AS chain_starts_at_seq,
       min(created_at) FILTER (WHERE chain_seq IS NOT NULL)   AS chain_starts_at,
       max(created_at) FILTER (WHERE chain_seq IS NULL)       AS last_unattested_row_at,
       CASE
         WHEN count(*) FILTER (WHERE chain_seq IS NOT NULL) = 0
           THEN '⚠️ No chained rows. Either 0081 shipped without the code, or this workspace has been idle since.'
         WHEN count(*) FILTER (WHERE chain_seq IS NULL) = 0
           THEN '✅ Every row in this scope is inside the chain.'
         ELSE '⚠️ Chain starts partway through. The rows before it are NOT attested and never will be.'
       END                                                    AS what_this_means
  FROM audit_logs
 GROUP BY 1
 ORDER BY unchained_rows DESC, scope
 LIMIT 100;


-- ---------------------------------------------------------------------
--  3. ⭐⭐ THE CHAIN ITSELF. ONE ROW PER SCOPE, AND A VERDICT.
--
--     Four independent faults are looked for, and they are checked in
--     this order because the first one that fires is the most specific:
--
--       row_hash_mismatch  the row's own stored hash is not what its
--                          position and content_hash imply — the row was
--                          edited and the hash was not recomputed.
--       sequence_gap       a position is missing — a row was removed
--                          from the middle of the chain.
--       link_broken        prev_hash is not the predecessor's row_hash —
--                          a row was substituted or reordered.
--       head_truncated     the earliest surviving row is not seq 1, or
--                          claims a predecessor that is no longer there
--                          — the START of the chain was cut off, which
--                          a naive verifier that only walks forwards
--                          would never notice.
-- ---------------------------------------------------------------------
WITH chained AS (
  SELECT id,
         coalesce(tenant_id::text, 'platform') AS scope,
         chain_seq, prev_hash, content_hash, row_hash, created_at
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
  SELECT scope, chain_seq, id, created_at,
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
       count(*)                                        AS chained_rows,
       min(chain_seq)                                  AS from_seq,
       max(chain_seq)                                  AS to_seq,
       count(*) FILTER (WHERE break_kind IS NOT NULL)  AS broken_links,
       CASE
         WHEN count(*) FILTER (WHERE break_kind IS NOT NULL) = 0
           THEN '✅ Chain structure intact. ⚠️ Says nothing about the unchained rows in section 2, and nothing about content — see the header.'
         ELSE '🔴 TAMPER EVIDENT. See the next query for the first broken link.'
       END                                             AS verdict
  FROM judged
 GROUP BY scope
 ORDER BY broken_links DESC, scope
 LIMIT 100;


-- ---------------------------------------------------------------------
--  4. 🔴 THE FIRST BROKEN LINK IN EACH SCOPE — THE ROW THAT WAS TOUCHED.
--
--     ⭐ ONLY THE FIRST, ON PURPOSE. After a genuine tamper every
--     subsequent row also fails, because each one covers the row before
--     it. Listing them all buries the row that was actually edited under
--     a thousand consequences of editing it. The first break IS the
--     location.
--
--     ⚠️ ZERO ROWS HERE IS THE PASS.
-- ---------------------------------------------------------------------
WITH chained AS (
  SELECT id,
         coalesce(tenant_id::text, 'platform') AS scope,
         chain_seq, prev_hash, content_hash, row_hash, created_at
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
  SELECT scope, chain_seq, id, created_at, row_hash, prev_hash,
         predecessor_hash,
         audit_chain_link_hash(scope, chain_seq, coalesce(prev_hash, ''), content_hash)
           AS row_hash_should_be,
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
SELECT DISTINCT ON (scope)
       scope,
       chain_seq          AS first_broken_seq,
       id                 AS first_broken_row,
       created_at         AS row_written_at,
       break_kind,
       row_hash           AS stored_row_hash,
       row_hash_should_be,
       prev_hash          AS stored_prev_hash,
       predecessor_hash   AS predecessor_row_hash
  FROM judged
 WHERE break_kind IS NOT NULL
 ORDER BY scope, chain_seq;


-- ---------------------------------------------------------------------
--  5. ⭐ THE HEAD HASH OF EACH CHAIN — THE VALUE TO ANCHOR OUTSIDE THIS
--     DATABASE.
--
--     🔴 THIS IS THE ONE THING THAT WOULD MAKE THE CHAIN PROOF RATHER
--     THAN EVIDENCE, AND IT IS NOT AUTOMATED YET. SHA-256 has no secret
--     in it, so an intruder with the patience to recompute the whole
--     tail leaves a chain that verifies perfectly. A copy of these
--     values kept somewhere they cannot reach — an object store with a
--     retention lock, a signed nightly mail, the customer's own inbox —
--     turns that recompute into something provable, because the new head
--     will not match the anchor.
--
--     Until an export job owns that, section 3 catches the intruder who
--     does not recompute, which is very nearly all of them, and this
--     section is a manual anchor: copy it somewhere, dated.
-- ---------------------------------------------------------------------
SELECT DISTINCT ON (coalesce(tenant_id::text, 'platform'))
       coalesce(tenant_id::text, 'platform') AS scope,
       chain_seq                             AS head_seq,
       row_hash                              AS head_hash,
       created_at                            AS head_written_at,
       now()                                 AS observed_at
  FROM audit_logs
 WHERE chain_seq IS NOT NULL
 ORDER BY coalesce(tenant_id::text, 'platform'), chain_seq DESC
 LIMIT 100;


-- ---------------------------------------------------------------------
--  6. ⚠️ `platform_action_log` — THE HALF THAT IS NOT WIRED.
--
--     Batch 44 owns `server/audit.ts` and not
--     `server/platform/guard.ts`, where `recordPlatformAudit()` lives.
--     So this table HAS the columns and NOTHING writes them.
--
--     🔴 THAT IS REPORTED, NOT HIDDEN. A silently empty integrity
--     column is worse than an absent one, because a reader assumes it is
--     populated. `chained = 0` here means "writer not wired", not
--     "chain broken" — and the day it stops being zero, this same query
--     starts verifying it.
-- ---------------------------------------------------------------------
SELECT count(*)                                      AS total_rows,
       count(*) FILTER (WHERE chain_seq IS NOT NULL) AS chained,
       CASE
         WHEN count(*) = 0 THEN 'Empty table — nothing to say.'
         WHEN count(*) FILTER (WHERE chain_seq IS NOT NULL) = 0
           THEN '⚠️ Writer NOT wired: recordPlatformAudit() in server/platform/guard.ts still writes unchained rows. Expected after Batch 44.'
         WHEN count(*) FILTER (WHERE chain_seq IS NULL) > 0
           THEN '⚠️ Partly chained — the chain starts partway through. Rows before it are not attested.'
         ELSE '✅ Fully chained.'
       END                                           AS writer_status
  FROM platform_action_log;


-- ---------------------------------------------------------------------
--  7. THE SQL TWIN IS STILL THERE, AND STILL SAYS WHAT IT SAID.
--
--     ⚠️ IF `audit_chain_link_hash()` IS EVER REDEFINED OUT OF STEP WITH
--     `hashAuditLink()` IN lib/audit/chain.ts, EVERY ROW WRITTEN
--     AFTERWARDS READS AS TAMPERED. A false accusation is the worst
--     failure this feature has, and it is far likelier than an intruder.
--     The known-answer test below is fixed: these inputs must always
--     produce this digest.
-- ---------------------------------------------------------------------
SELECT audit_chain_link_hash('platform', 1, '', 'a'),
       audit_chain_link_hash('platform', 1, '', 'a')
         = encode(sha256(convert_to(
             'ordence-audit-chain-v1'
             || chr(31) || '8:platform'
             || chr(31) || '1:1'
             || chr(31) || '0:'
             || chr(31) || '1:a', 'UTF8')), 'hex')
         AS framing_unchanged;
-- ⭐ `framing_unchanged` false means the function was redefined and the
--    chain's meaning changed underneath it. Compare against
--    `hashAuditLink()` before concluding anything about a broken link.


-- ---------------------------------------------------------------------
--  8. AND THE THING THAT DECIDES WHETHER ANY OF THIS SAW EVERY ROW.
--
--     ⚠️ THE OPPOSITE READING FROM VERIFY-0079. There, a connection
--     bypassing RLS made every policy inert and the verdict worthless.
--     Here, a connection SUBJECT to RLS sees only its own tenant's rows,
--     so a clean result covers one workspace and says nothing about the
--     rest. Both are fine; which one you have decides what the answer
--     above is an answer to.
-- ---------------------------------------------------------------------
SELECT current_user,
       rolsuper,
       rolbypassrls,
       nullif(current_setting('app.current_tenant_id', true), '') AS session_tenant,
       CASE
         WHEN rolsuper OR rolbypassrls
           THEN '✅ This connection sees EVERY chain. The verdict above covers the whole table.'
         WHEN nullif(current_setting('app.current_tenant_id', true), '') IS NOT NULL
           THEN '⚠️ Tenant-scoped: the verdict above covers ONE workspace. Other chains were not read.'
         ELSE '⚠️ Subject to RLS with no tenant set — audit_logs_tenant_isolation matched nothing, so the verdict above is over an EMPTY set. It is not a pass.'
       END AS what_the_verdict_covers
  FROM pg_roles
 WHERE rolname = current_user;
