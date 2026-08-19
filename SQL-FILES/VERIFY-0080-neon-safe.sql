-- =====================================================================
--  Ordence · VERIFY 0080 · read-only, SAFE AGAINST NEON
-- =====================================================================
--  ⭐ SELECT statements only. Nothing is created, altered or written.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. THE COLUMNS EXIST.
--
--     Six on sales_orders, one on projects. `missing` here means the
--     order table still cannot represent the correct answer.
-- ---------------------------------------------------------------------
SELECT 'sales_orders' AS table_name,
       c.column_name,
       c.data_type,
       c.is_nullable,
       c.column_default
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.table_name = 'sales_orders'
   AND c.column_name IN (
         'supply_type', 'property_state_code', 'recipient_registration',
         'place_of_supply_basis', 'place_of_supply_ref', 'is_union_territory'
       )
UNION ALL
SELECT 'projects', c.column_name, c.data_type, c.is_nullable, c.column_default
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.table_name = 'projects'
   AND c.column_name = 'state_code'
 ORDER BY table_name, column_name;
-- ⭐ SEVEN ROWS IS THE PASS.


-- ---------------------------------------------------------------------
--  2. THE FOUR CONSTRAINTS ARE IN FORCE.
--
--     These are what outlive the fix. The application path can no longer
--     reach them; an import, a psql prompt or the future REST API can.
-- ---------------------------------------------------------------------
SELECT con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
 WHERE rel.relname = 'sales_orders'
   AND con.conname IN (
         'sales_orders_immovable_property_pos',
         'sales_orders_sez_is_inter_state',
         'sales_orders_ut_is_intra_state',
         'sales_orders_pos_has_basis'
       )
 ORDER BY con.conname;
-- ⭐ FOUR ROWS IS THE PASS.


-- ---------------------------------------------------------------------
--  3. ⚠️ HOW MUCH WAS DECIDED BY STRING COMPARISON.
--
--     `legacy_state_compare` marks every order taxed before the engine
--     was wired in. That is not automatically wrong — for a plain
--     intra-state supply of services to a registered buyer the string
--     compare gives the same answer the engine does. It is UNVERIFIED,
--     which is a different thing, and this is the exact count.
-- ---------------------------------------------------------------------
SELECT place_of_supply_basis,
       count(*) AS orders,
       min(order_date) AS earliest,
       max(order_date) AS latest
  FROM sales_orders
 WHERE deleted_at IS NULL
 GROUP BY place_of_supply_basis
 ORDER BY orders DESC;


-- ---------------------------------------------------------------------
--  4. 🔴 THE ONES TO CHECK BY HAND.
--
--     A legacy order that has a project attached, or a works-contract
--     line, is an order where s.12(3) may have applied and the string
--     compare could not have known. These are the candidates for a wrong
--     tax, ranked by value.
-- ---------------------------------------------------------------------
SELECT o.order_no,
       o.order_date,
       o.place_of_supply_code,
       o.is_inter_state,
       o.project_id,
       p.name       AS project_name,
       p.state      AS project_state_prose,
       p.state_code AS project_state_code,
       o.total_minor
  FROM sales_orders o
  LEFT JOIN projects p ON p.id = o.project_id
 WHERE o.deleted_at IS NULL
   AND o.place_of_supply_basis = 'legacy_state_compare'
   AND (
        o.project_id IS NOT NULL
        OR EXISTS (
             SELECT 1 FROM sales_order_lines l
              WHERE l.order_id = o.id
                AND l.kind = 'works_contract'
           )
       )
 ORDER BY o.total_minor DESC
 LIMIT 100;
-- ⚠️ EVERY ROW HERE WITH A NULL project_state_code IS AN ORDER WHOSE
--    CORRECT PLACE OF SUPPLY WE STILL CANNOT COMPUTE, because the site's
--    state was never recorded as a code. Set projects.state_code first.


-- ---------------------------------------------------------------------
--  5. 🔴 SEZ ORDERS RECORDED AS INTRA-STATE.
--
--     Section 7(5)(b) makes every supply to an SEZ inter-state, however
--     close it is. Any row here under-collected IGST, and the interest
--     runs from the original date.
--
--     ⚠️ Reads the PARTY, not the order's own column, because the order
--     never recorded the recipient's registration before 0080 — which is
--     precisely why this could not be seen.
-- ---------------------------------------------------------------------
SELECT o.order_no,
       o.order_date,
       o.place_of_supply_code,
       o.is_inter_state,
       gp.legal_name AS buyer,
       gp.gstin,
       gp.registration_type,
       o.igst_minor,
       o.cgst_minor + o.sgst_minor AS cgst_sgst_minor,
       o.total_minor
  FROM sales_orders o
  JOIN gst_parties gp ON gp.id = o.gst_party_id
 WHERE o.deleted_at IS NULL
   AND gp.registration_type = 'sez'
   AND o.is_inter_state IS DISTINCT FROM true
 ORDER BY o.total_minor DESC;
-- ⭐ ZERO ROWS IS THE PASS.


-- ---------------------------------------------------------------------
--  6. ⚠️ INTRA-UT SUPPLIES BILLED AS CGST + SGST.
--
--     The money is right. The Act is wrong and so is the GSTR-1 box:
--     these are CGST + UTGST. 35, 04, 26, 25, 31 and 38 are the Union
--     Territories without a legislature.
-- ---------------------------------------------------------------------
SELECT count(*) AS intra_ut_orders_not_marked,
       sum(o.total_minor) AS total_minor
  FROM sales_orders o
 WHERE o.deleted_at IS NULL
   AND o.is_inter_state IS NOT TRUE
   AND o.place_of_supply_code IN ('35', '04', '26', '25', '31', '38')
   AND o.is_union_territory = false;
-- ⭐ ZERO IS THE PASS for orders written after 0080. A non-zero count is
--    entirely historical and is a reporting reclassification, not a
--    payment.


-- ---------------------------------------------------------------------
--  7. PROJECTS THAT CANNOT ANSWER SECTION 12(3) YET.
--
--     Every one of these blocks an immovable-property order until
--     somebody sets the code. That refusal is deliberate.
-- ---------------------------------------------------------------------
SELECT count(*) FILTER (WHERE state_code IS NULL)     AS projects_without_code,
       count(*) FILTER (WHERE state_code IS NOT NULL) AS projects_ready,
       count(*)                                       AS projects_total
  FROM projects
 WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------
--  8. AND THE THING THAT DECIDES WHETHER ANY POLICY IS RUNNING.
-- ---------------------------------------------------------------------
SELECT current_user,
       rolsuper,
       rolbypassrls,
       CASE
         WHEN rolsuper OR rolbypassrls
           THEN '🔴 This connection BYPASSES row-level security. Every policy is inert.'
         ELSE '✅ This connection is subject to row-level security.'
       END AS verdict
  FROM pg_roles
 WHERE rolname = current_user;
