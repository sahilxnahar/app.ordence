-- =====================================================================
-- PROJECT STATE CODES  ·  Repo: app.ordence
-- SECTION 1 IS READ ONLY. SECTION 2 IS A TEMPLATE YOU EDIT AND RUN.
-- =====================================================================
--
-- WHY THIS MATTERS, IN ONE PARAGRAPH
--   `projects.state_code` is how the product decides PLACE OF SUPPLY.
--   Place of supply decides whether a sale is INTRA-state (CGST + SGST)
--   or INTER-state (IGST). Those are different tax heads on the invoice,
--   different rows in GSTR-1, and different money. A project with no
--   state code is a project whose invoices the product cannot classify,
--   and a wrong classification is not a display bug: it is a filing
--   error that an assessing officer will find later, with interest.
--
-- 🔴 THE RLS DETAIL THAT WILL OTHERWISE WASTE YOUR EVENING
--
--   `projects` has exactly ONE policy (0016):
--
--       USING      (tenant_id = app_current_tenant_id())
--       WITH CHECK (tenant_id = app_current_tenant_id())
--
--   There is NO platform clause, on either side. That is deliberate and
--   correct: the console has no business reading or writing a customer's
--   project rows. It means `SET app.platform_scope = 'on'` does NOTHING
--   here. You must set the TENANT.
--
--   ⚠️ If your Neon role has BYPASSRLS this all works without the SET and
--      you will not notice. Section 0 of `0092` tells you which you are.
--      Set it anyway: a habit that only works because of a privilege is a
--      habit that breaks the first time it is used correctly.
-- =====================================================================


-- =====================================================================
-- SECTION 1 · READ ONLY · WHICH PROJECTS ARE MISSING A STATE CODE
-- ---------------------------------------------------------------------
-- ⚠️ Run this whole section as ONE statement block so the SET applies.
--    Replace the UUID with a real tenant id. Get tenant ids from:
--        SELECT id, slug, name FROM tenants ORDER BY created_at;
--    (`tenants` DOES carry a platform clause, so that one needs
--     SET app.platform_scope = 'on' instead. They are different tables
--     with different policies, which is the whole point of the design.)
-- =====================================================================

BEGIN;
SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';  -- <<< EDIT

SELECT
    'projects missing a state code' AS finding,
    p.id                            AS project_id,
    p.name                          AS project_name,
    p.state_code                    AS current_state_code,
    'invoices on this project cannot be classified as intra or inter state'
                                    AS consequence
FROM projects p
WHERE p.state_code IS NULL
ORDER BY p.name;

COMMIT;


-- =====================================================================
-- SECTION 2 · THE FIX · EDIT BEFORE RUNNING
-- ---------------------------------------------------------------------
-- 🔴 SET THE CODE THE PROJECT IS ACTUALLY IN. Do not batch-assign your
--    head-office state to everything to make the list go green. A wrong
--    state code is worse than a null one: null makes the product refuse
--    to classify, which is visible; wrong makes it classify confidently
--    and incorrectly, which is not.
--
-- Two-character GST state codes, the ones you are most likely to need:
--
--    27  Maharashtra      07  Delhi           29  Karnataka
--    24  Gujarat          33  Tamil Nadu      36  Telangana
--    09  Uttar Pradesh    08  Rajasthan       19  West Bengal
--    32  Kerala           23  Madhya Pradesh  06  Haryana
--    03  Punjab           10  Bihar           21  Odisha
--    22  Chhattisgarh     34  Puducherry      30  Goa
--
-- ⚠️ THEY ARE TWO CHARACTERS INCLUDING THE LEADING ZERO. `07`, not `7`.
--    The column is varchar(2) and `7` is a different string from `07`,
--    so it will store and then never match a GSTIN prefix.
-- =====================================================================

-- BEGIN;
-- SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000';  -- <<< EDIT
--
-- UPDATE projects SET state_code = '27' WHERE id = '<project-uuid>';  -- <<< EDIT
-- UPDATE projects SET state_code = '29' WHERE id = '<project-uuid>';  -- <<< EDIT
--
-- -- Re-read before committing. If this returns rows you are not done.
-- SELECT id, name, state_code FROM projects WHERE state_code IS NULL;
--
-- COMMIT;
