-- =====================================================================
--  Ordence · VERIFY 0083 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
--
--  🔴 WHAT THIS PROVES AND WHAT IT CANNOT.
--
--  It proves the SHAPE: the five new tables exist, every one is
--  tenant-scoped with RLS enabled AND forced and a policy on it, the
--  hold table can hold at most one open hold per customer, an override
--  is one-per-order and append-only, a dunning stage can be recorded
--  once per invoice and no more, and the two evidence tables cannot be
--  deleted from by the application role.
--
--  ⚠️ IT CANNOT PROVE THAT THE ORDER PATH ACTUALLY CONSULTS ANY OF IT.
--  The refusal lives in `lib/credit/enforce.ts`, is called from inside
--  `confirmOrder`'s transaction, and is proved by
--  `tests/ui/credit-control.test.ts` reading the source. A database can
--  show that the evidence table exists; only the source can show that
--  something asks it. Section 8 is the honest half — it reports orders
--  that were confirmed while their customer was held, so a human can
--  look at the number and say whether it is zero.
--
--  ⚠️ AND IT CANNOT PROVE COMPLETENESS OF THE EXPOSURE FIGURE. Whether
--  an invoice that SHOULD exist was ever raised is not a question a
--  constraint can answer. Section 7 does what a database can: it reports
--  the customers whose two readings of "what has been received"
--  disagree, which is the specific way this feature fails silently.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. 🔴 THE TENANT BOUNDARY. THREE SEPARATE THINGS, REPORTED
--     SEPARATELY, BECAUSE THEY FAIL IN OPPOSITE DIRECTIONS.
--
--     `rls_enabled` false  → every tenant reads every other tenant's
--                            credit file: who is over their limit, who
--                            is held, and what a salesperson typed in
--                            the reason box assuming nobody outside the
--                            company would read it.
--     `rls_forced`  false  → RLS is on and the table OWNER ignores it,
--                            and this application connects as the owner.
--     `policies` = 0       → RLS is on with no policy, which denies
--                            everybody: not protected, unusable.
-- ---------------------------------------------------------------------
SELECT c.relname                                        AS table_name,
       c.relrowsecurity                                 AS rls_enabled,
       c.relforcerowsecurity                            AS rls_forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
       EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                  AND a.attnotnull AND NOT a.attisdropped)         AS tenant_id_not_null
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('credit_hold_events', 'credit_hold_overrides',
                     'credit_dunning_ladders', 'credit_dunning_stages',
                     'credit_dunning_log')
 ORDER BY c.relname;
-- ⭐ EXPECT: five rows; rls_enabled, rls_forced and tenant_id_not_null all
--    true; policies >= 1 on each. Fewer than five rows means 0083 has not
--    been run.


-- ---------------------------------------------------------------------
--  2. 🔴 THE POLICY PREDICATE, IN FULL.
--
--     ⚠️ `app_platform_scope()` MUST APPEAR IN `USING` AND MUST NOT
--     APPEAR IN `WITH CHECK`. Platform staff may READ across tenants to
--     answer a support question; a platform WRITE into somebody else's
--     workspace could lift a credit hold.
-- ---------------------------------------------------------------------
SELECT c.relname                              AS table_name,
       p.polname                              AS policy,
       pg_get_expr(p.polqual,      p.polrelid) AS using_clause,
       pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_clause
  FROM pg_policy p
  JOIN pg_class  c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('credit_hold_events', 'credit_hold_overrides',
                     'credit_dunning_ladders', 'credit_dunning_stages',
                     'credit_dunning_log')
 ORDER BY c.relname;
-- ⭐ EXPECT: using_clause mentions app_current_tenant_id() AND
--    app_platform_scope(); with_check_clause mentions
--    app_current_tenant_id() and NOT app_platform_scope().


-- ---------------------------------------------------------------------
--  3. 🔴🔴 THE THREE INDEXES THAT ARE THE PRODUCT RULES.
--
--     These are not performance indexes. Each one is a rule that cannot
--     be enforced anywhere else:
--
--     credit_hold_events_one_active_key
--         AT MOST ONE UNRELEASED HOLD PER CUSTOMER. This is the whole of
--         the idempotency guarantee for the automatic sweep — without it
--         a nightly job writes one hold row a night forever and a
--         customer who was over their limit for a week in June has 280
--         rows and no history anybody can read.
--
--     credit_hold_overrides_one_per_order_key
--         ONE OVERRIDE PER ORDER, EVER. Without it one signature
--         releases everything the customer ordered that week.
--
--     credit_dunning_log_once_per_stage_key
--         A STAGE IS RECORDED ONCE PER INVOICE. Without it two workers
--         reading "not sent" in the same millisecond send the same
--         demanding letter twice, which is the most reliable way there
--         is to turn a late payer into an angry one.
-- ---------------------------------------------------------------------
SELECT i.relname       AS index_name,
       t.relname       AS table_name,
       ix.indisunique  AS is_unique,
       pg_get_expr(ix.indpred, ix.indrelid) AS partial_predicate
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND i.relname IN ('credit_hold_events_one_active_key',
                     'credit_hold_overrides_one_per_order_key',
                     'credit_dunning_log_once_per_stage_key',
                     'credit_dunning_ladders_one_default_key',
                     'credit_dunning_stages_age_key')
 ORDER BY i.relname;
-- ⭐ EXPECT: five rows, all is_unique = true.
--    `credit_hold_events_one_active_key` MUST have a partial predicate
--    mentioning released_at — a non-partial unique index there would
--    allow a customer to be held exactly once in their lifetime.


-- ---------------------------------------------------------------------
--  4. 🔴 THE CONSTRAINTS THAT MAKE A REASON MANDATORY.
--
--     ⚠️ ZOD IS NOT THE BOUNDARY. `psql`, a migration script and a
--     support session all reach these tables without passing through it.
--     A reason field that accepts "x" is a reason field that will
--     contain "x".
-- ---------------------------------------------------------------------
SELECT rel.relname             AS table_name,
       con.conname             AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
 WHERE n.nspname = 'public'
   AND rel.relname IN ('credit_hold_events', 'credit_hold_overrides',
                       'credit_dunning_log', 'credit_dunning_stages')
   AND con.contype = 'c'
 ORDER BY rel.relname, con.conname;
-- ⭐ EXPECT to see, among others:
--    credit_hold_events_reason_said           length(btrim(reason)) >= 4
--    credit_hold_events_manual_has_actor      source <> 'manual' OR placed_by IS NOT NULL
--    credit_hold_overrides_reason_said        length(btrim(reason)) >= 8
--    credit_dunning_log_sent_has_time         delivery <> 'sent' OR sent_at IS NOT NULL
--    credit_dunning_stages_age_sane           days_past_due BETWEEN 0 AND 3650


-- ---------------------------------------------------------------------
--  5. 🔴 THE APPEND-ONLY TRIGGERS, AND THE WITHHELD DELETE GRANT.
--
--     Both say the same thing and they fail in different places: the
--     trigger catches the application and produces a sentence a
--     salesperson can read; the withheld GRANT catches everything that
--     is NOT the application — a migration script, a console session, a
--     well-meant cleanup job at 2am.
-- ---------------------------------------------------------------------
SELECT c.relname   AS table_name,
       t.tgname    AS trigger_name,
       NOT t.tgisinternal AS is_user_trigger
  FROM pg_trigger t
  JOIN pg_class   c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND NOT t.tgisinternal
   AND c.relname IN ('credit_hold_events', 'credit_hold_overrides',
                     'credit_dunning_log')
 ORDER BY c.relname, t.tgname;
-- ⭐ EXPECT: credit_hold_events_mirror, credit_hold_overrides_immutable,
--    credit_dunning_log_identity, plus the set_updated_at triggers.

SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'ordence_app'
   AND table_name IN ('credit_hold_events', 'credit_hold_overrides',
                      'credit_dunning_log', 'credit_dunning_ladders',
                      'credit_dunning_stages')
 ORDER BY table_name, privilege_type;
-- 🔴 EXPECT: NO `DELETE` row for credit_hold_events, credit_hold_overrides
--    or credit_dunning_log. DELETE on the two ladder tables is fine — a
--    ladder is configuration, an override is a signature.


-- ---------------------------------------------------------------------
--  6. ⚠️ THE MIRROR IS IN STEP.
--
--     `customer_credit_profiles.on_hold` is a denormalised copy kept by
--     the `credit_hold_events_mirror` trigger, and a copy that anybody
--     can update independently is a copy that will disagree. This finds
--     the disagreements. It should return NOTHING.
--
--     🔴 A ROW HERE MEANS SOMETHING WROTE `on_hold` DIRECTLY, and the
--     symptom is a customer who is held on one screen and not on
--     another — or, worse, held on the screen and not in `confirmOrder`.
-- ---------------------------------------------------------------------
SELECT p.tenant_id,
       p.company_id,
       p.on_hold                                   AS mirror_says,
       EXISTS (SELECT 1 FROM credit_hold_events e
                WHERE e.tenant_id = p.tenant_id
                  AND e.company_id = p.company_id
                  AND e.released_at IS NULL)       AS events_say
  FROM customer_credit_profiles p
 WHERE p.on_hold <> EXISTS (SELECT 1 FROM credit_hold_events e
                             WHERE e.tenant_id = p.tenant_id
                               AND e.company_id = p.company_id
                               AND e.released_at IS NULL);
-- ⭐ EXPECT: zero rows.


-- ---------------------------------------------------------------------
--  7. 🔴🔴 THE RECONCILIATION, IN SQL, FOR THE SAME REASON THE
--     APPLICATION DOES IT.
--
--     `sales_invoices.received_minor` is a maintained column; the
--     allocations are the underlying rows. `lib/credit/headroom.ts`
--     compares the two and refuses to print a headroom figure when they
--     disagree. This is the same comparison from the other side, so that
--     the answer can be obtained without the application.
--
--     ⚠️ THE RECEIPT STATUS FILTER IS QUOTED FROM 0049 §2 AND MUST MATCH
--     IT. `('pending', 'cleared')` — a bounced cheque settles nothing.
--     If 0049's definition changes, this query and
--     `lib/credit/queries.ts#SETTLING_RECEIPT_STATUSES` change with it,
--     or every customer breaches and the board shows nothing for anybody.
-- ---------------------------------------------------------------------
SELECT i.tenant_id,
       i.company_id,
       count(*)                                       AS invoices,
       SUM(i.received_minor)                          AS column_says,
       SUM(COALESCE(a.allocated, 0))                  AS allocations_say,
       SUM(i.received_minor) - SUM(COALESCE(a.allocated, 0)) AS difference_minor
  FROM sales_invoices i
  LEFT JOIN LATERAL (
        SELECT SUM(al.amount_minor) AS allocated
          FROM customer_receipt_allocations al
          JOIN customer_receipts r ON r.id = al.receipt_id
         WHERE al.invoice_id = i.id
           AND r.status IN ('pending', 'cleared')
  ) a ON true
 WHERE i.status NOT IN ('draft', 'cancelled')
 GROUP BY i.tenant_id, i.company_id
HAVING SUM(i.received_minor) <> SUM(COALESCE(a.allocated, 0))
 ORDER BY abs(SUM(i.received_minor) - SUM(COALESCE(a.allocated, 0))) DESC
 LIMIT 50;
-- 🔴 EXPECT: zero rows. Every row here is a customer whose credit board
--    shows NO headroom figure, and whose exposure is understated by
--    `difference_minor` if the column is the higher of the two — which
--    means the credit limit is letting through exactly the order it
--    exists to stop.


-- ---------------------------------------------------------------------
--  8. 🔴🔴 THE HONEST SECTION. ORDERS CONFIRMED WHILE THE CUSTOMER WAS
--     HELD, WITH NO OVERRIDE ON FILE.
--
--     ⚠️ THIS IS THE ONE TO READ BEFORE QUOTING ANY OF THE OTHERS AT
--     ANYBODY. Sections 1–7 prove the tables are shaped correctly. This
--     asks whether the shape has ever been used — whether an order has
--     gone out past a hold without the signature that is supposed to be
--     the only way past it.
--
--     ⚠️ IT IS APPROXIMATE, AND THE APPROXIMATION IS NAMED. `confirmed_at`
--     is compared against the hold's window; an order confirmed BEFORE
--     the hold was placed is legitimate and is excluded. An order
--     confirmed during a hold that was later released still shows here,
--     because the release does not retrospectively make the shipment
--     authorised.
-- ---------------------------------------------------------------------
SELECT o.tenant_id,
       o.order_no,
       o.confirmed_at,
       e.placed_at        AS hold_placed_at,
       e.released_at      AS hold_released_at,
       e.source           AS hold_source,
       left(e.reason, 80) AS hold_reason
  FROM sales_orders o
  JOIN credit_hold_events e
    ON e.tenant_id = o.tenant_id
   AND e.company_id = o.company_id
 WHERE o.confirmed_at IS NOT NULL
   AND o.confirmed_at >= e.placed_at
   AND (e.released_at IS NULL OR o.confirmed_at <= e.released_at)
   AND NOT EXISTS (
         SELECT 1 FROM credit_hold_overrides ov
          WHERE ov.tenant_id = o.tenant_id
            AND ov.order_id = o.id
       )
 ORDER BY o.confirmed_at DESC
 LIMIT 50;
-- 🔴 EXPECT: zero rows AFTER 0083 and the Batch 40 code are both live.
--    Rows dated BEFORE the deploy are expected and are the reason this
--    batch exists — until v1.46.0 a hold routed an order to
--    `pending_approval`, where somebody cleared it at five o'clock.


-- ---------------------------------------------------------------------
--  9. THE DUNNING QUEUE, AS IT STANDS.
--
--     ⚠️ `delivery = 'queued'` FOREVER IS THE EXPECTED STATE IN THIS
--     BATCH, NOT A BACKLOG ALARM. Batch 40 writes the records and sends
--     nothing — there is no SMTP call, no Resend call and no webhook.
--     A `sent` row means something outside this batch has started
--     delivering, and that is worth knowing before anybody tells a
--     customer we wrote to them.
-- ---------------------------------------------------------------------
SELECT delivery,
       count(*)                AS rows,
       min(queued_at)          AS oldest,
       max(queued_at)          AS newest,
       count(*) FILTER (WHERE sent_at IS NOT NULL) AS with_sent_at
  FROM credit_dunning_log
 GROUP BY delivery
 ORDER BY delivery;

-- The collections diary: what falls due next, oldest first.
SELECT l.tenant_id,
       l.next_action_on,
       count(*) AS invoices,
       SUM(l.amount_due_minor) AS amount_due_minor
  FROM credit_dunning_log l
 WHERE l.next_action_on IS NOT NULL
   AND l.delivery <> 'suppressed'
 GROUP BY l.tenant_id, l.next_action_on
 ORDER BY l.next_action_on
 LIMIT 50;


-- ---------------------------------------------------------------------
--  10. ⚠️ VERIFIED BY ABSENCE — THERE MUST BE NO STORED EXPOSURE.
--
--      A cached exposure is a cache of a sum, and a cache that disagrees
--      with its ledger is the exact failure `lib/reconciliation/gate.ts`
--      exists to refuse to render. If a column called `exposure_minor`
--      ever appears on `customer_credit_profiles`, the credit board has
--      two answers to one question and the screen will show whichever
--      one was written last.
-- ---------------------------------------------------------------------
SELECT a.attname AS suspicious_column
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'customer_credit_profiles'
   AND NOT a.attisdropped
   AND a.attname ~ 'exposure|headroom|outstanding|balance';
-- ⭐ EXPECT: zero rows.
