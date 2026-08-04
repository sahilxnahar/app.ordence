-- ============================================================================
-- Ordence — Phase 25: The Generalised Views Engine
-- Version: v0.25.0-alpha
--
-- Run AFTER `npx drizzle-kit push`, and after `ALL-IN-ONE-SETUP.sql`,
-- `0017_change_log.sql` and `0019_phase24_dynamic_objects.sql` — it depends on
-- `set_updated_at()`, `app_current_tenant_id()` and `record_change()` from
-- those, and its composite foreign key to `dynamic_objects` needs that table
-- to exist.
--
-- Safe to run before `drizzle-kit push` too — Section 1 creates the tables
-- itself, idempotently, so a deployment that applies SQL first is not broken.
-- Safe to re-run: every statement is guarded.
--
-- Contents:
--   1. Enum and tables
--   2. Row-level security
--   3. ⭐ Cross-tenant reference integrity — the hole RLS does NOT close
--   4. ⭐ THE SIZE AND SHAPE GUARDS — a filter tree is a denial-of-service
--   5. ⭐ SHARING INTEGRITY — unsharing must not strand anybody's default
--   6. How many views may exist
--   7. updated_at, and the change log
--   8. Grants
--   9. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- This phase stores QUESTIONS. A saved view is a filter, a sort order, a
-- grouping and a column list, saved under a name, and replayed on demand —
-- possibly by somebody else, possibly months later.
--
-- That produces two failure modes, and NEITHER of them can be closed by
-- anything in this file. Both are stated here anyway, because the reader who
-- comes looking for the defence in the schema needs to be sent to the right
-- place rather than reassured by a CHECK constraint that does not do what it
-- appears to.
--
--   ⭐ 1. A SAVED VIEW STORES SQL IDENTIFIERS.
--
--      `filter`, `sorts`, `group_by`, `date_field` and `visible_columns` all
--      hold FIELD NAMES. A column name cannot be a bind parameter — `ORDER BY
--      $1` sorts every row by the constant string — so those names are
--      INTERPOLATED into statements, weeks after a customer typed them.
--
--      There is no column type and no constraint that makes a stored string
--      safe to interpolate. The defence is `lib/views/registry.ts`, which
--      RESOLVES every stored name against a field table derived from real
--      Drizzle schema metadata and returns NOTHING for a name that is not on
--      it, and `lib/views/planner.ts`, which only ever accepts a resolved
--      descriptor. Not a regex, not an escape, not `quote_ident` — an
--      allowlist whose entries are constants of the compiled program.
--
--      What this file CAN do is bound the payload, so that a tree nobody
--      validated is at least a tree that fits. Section 4.
--
--   ⭐ 2. A SHARED VIEW IS A PERMISSION PROBLEM.
--
--      `is_shared` puts a view in everybody's picker. It must not put the
--      RECORDS in everybody's hands, and the natural implementation does
--      exactly that: replay the query the author saved, authorised when it
--      was saved, against the author. An external contractor with
--      `assets:read` then opens "All bookings this quarter" and reads the
--      order book. Nothing errors. Nothing logs.
--
--      RLS does not help here — every row really does belong to the reader's
--      tenant. The defence is `lib/views/access.ts`: the OBJECT's read
--      permission is checked against the person OPENING the view, on every
--      open, and the ownership scope is ANDed OUTSIDE the view's own filter
--      so that a view can only ever remove rows from a set the reader was
--      already entitled to.
--
-- The third theme of the file is Section 5, which is a smaller and more
-- ordinary problem: un-sharing a view leaves other people's saved defaults
-- pointing at something they can no longer see, and a list page whose default
-- view is invisible does not open at all — for one user, with an error nobody
-- else can reproduce.
-- ============================================================================


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ENUM AND TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/views.ts`. They are
-- restated here for the reason Phases 22–24 restate theirs: push removes what
-- it does not recognise, and a file that can only run second is a file that
-- fails on a fresh database.
--
-- ⚠️ `view_type` IS GENERATED FROM `lib/views/types.ts`. Add a value there;
-- the enum follows. A value added here by hand is one the database accepts and
-- no renderer can draw — a saved view that opens to a blank page.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'view_type') THEN
    CREATE TYPE view_type AS ENUM ('table','kanban','calendar');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS saved_views (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- ⭐ A KEY INTO A FROZEN REGISTRY, NOT A TABLE NAME.
  --
  -- Storing the table would mean the relation a generic reader selects from
  -- is a varchar out of a row: one UPDATE here points a saved view at `users`
  -- and reads it under the caller's own tenant scope, with RLS perfectly
  -- satisfied because those rows really are theirs.
  object_key            varchar(60) NOT NULL,
  dynamic_object_id     uuid,

  name                  varchar(80) NOT NULL,
  description           text,
  view_type             view_type NOT NULL DEFAULT 'table',

  -- ⚠️ The field names inside these four columns become SQL identifiers on
  -- every read. See the header. They are resolved, never trusted.
  filter                jsonb NOT NULL DEFAULT '{"type":"group","match":"all","children":[]}'::jsonb,
  sorts                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  group_by              varchar(63),
  date_field            varchar(63),
  visible_columns       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ⭐ Decides who may EDIT the view. Never decides what it RETURNS.
  owner_user_id         uuid NOT NULL,
  is_shared             boolean NOT NULL DEFAULT false,
  is_workspace_default  boolean NOT NULL DEFAULT false,

  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Exactly one of the two object selectors.
  CONSTRAINT saved_views_object_selector
    CHECK ((object_key = 'dynamic_object') = (dynamic_object_id IS NOT NULL)),

  -- ⚠️ A board with no grouping renders as one unlabelled column holding
  -- everything, which reads as "the board is broken" rather than as "this
  -- view is misconfigured". A calendar with no date field renders as nothing.
  CONSTRAINT saved_views_kanban_has_grouping
    CHECK (view_type <> 'kanban' OR group_by IS NOT NULL),
  CONSTRAINT saved_views_calendar_has_date
    CHECK (view_type <> 'calendar' OR date_field IS NOT NULL),

  -- ⚠️ Making somebody's PRIVATE working list the workspace default would show
  -- everybody a view they cannot see in their picker and cannot edit.
  CONSTRAINT saved_views_workspace_default_is_shared
    CHECK (NOT is_workspace_default OR is_shared)
);

CREATE TABLE IF NOT EXISTS saved_view_defaults (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,
  object_key         varchar(60) NOT NULL,
  dynamic_object_id  uuid,
  view_id            uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT saved_view_defaults_object_selector
    CHECK ((object_key = 'dynamic_object') = (dynamic_object_id IS NOT NULL))
);


-- ⚠️⚠️ EVERY UNIQUE INDEX BELOW IS SPLIT ON `dynamic_object_id IS NULL`, AND
-- IT IS THE SUBTLEST THING IN THIS FILE.
--
-- In a PostgreSQL unique index, NULLs are DISTINCT FROM EACH OTHER. So a
-- single index on (tenant_id, owner_user_id, object_key, dynamic_object_id,
-- name) enforces NOTHING for built-in objects, where `dynamic_object_id` is
-- always NULL: two rows of (A, u, 'lead', NULL, 'My leads') are two distinct
-- keys and both are accepted.
--
-- `\d saved_views` shows the index as UNIQUE. Every review passes. It simply
-- does not do the thing its name says. Splitting on IS NULL removes the
-- nullable column from the key in the case where it is always null.

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_unique
  ON saved_views (tenant_id, owner_user_id, object_key, name)
  WHERE dynamic_object_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_unique_dynamic
  ON saved_views (tenant_id, owner_user_id, dynamic_object_id, name)
  WHERE dynamic_object_id IS NOT NULL;

-- ⭐ At most ONE workspace default per object. Two means half the workspace
-- opens one view and half opens another, and neither can reproduce the other's
-- screen.
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_one_workspace_default
  ON saved_views (tenant_id, object_key)
  WHERE is_workspace_default AND dynamic_object_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_one_workspace_default_dyn
  ON saved_views (tenant_id, dynamic_object_id)
  WHERE is_workspace_default AND dynamic_object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS saved_views_tenant_idx ON saved_views (tenant_id);
CREATE INDEX IF NOT EXISTS saved_views_picker_idx
  ON saved_views (tenant_id, object_key, is_shared);
CREATE INDEX IF NOT EXISTS saved_views_owner_idx
  ON saved_views (tenant_id, owner_user_id);
CREATE INDEX IF NOT EXISTS saved_views_dynamic_idx
  ON saved_views (tenant_id, dynamic_object_id)
  WHERE dynamic_object_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saved_view_defaults_unique
  ON saved_view_defaults (tenant_id, user_id, object_key)
  WHERE dynamic_object_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS saved_view_defaults_unique_dynamic
  ON saved_view_defaults (tenant_id, user_id, dynamic_object_id)
  WHERE dynamic_object_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS saved_view_defaults_tenant_idx
  ON saved_view_defaults (tenant_id);
CREATE INDEX IF NOT EXISTS saved_view_defaults_view_idx
  ON saved_view_defaults (view_id);


-- ############################################################################
-- SECTION 2 — ROW-LEVEL SECURITY
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER as well,
-- which is the half everybody forgets: without it, the role that created the
-- table reads everything and the policies look like they are working.
--
-- ⚠️ NOTE WHAT IS ABSENT: no policy here carries `OR app_is_platform_scope()`.
-- A saved view is a description of how a company looks at its own data —
-- which pipeline stages it cares about, whose deals it watches, what it
-- considers overdue. Platform staff have no business reading it, and the
-- narrowing of that marker away from customer content was itself a defect
-- fixed in v0.14.1.

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_views_tenant_isolation ON saved_views;
CREATE POLICY saved_views_tenant_isolation ON saved_views
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE saved_view_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view_defaults FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_view_defaults_tenant_isolation ON saved_view_defaults;
CREATE POLICY saved_view_defaults_tenant_isolation ON saved_view_defaults
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ⚠️ THE POLICY IS PER TENANT, NOT PER USER, AND THAT IS DELIBERATE.
--
-- The obvious tightening is `AND (is_shared OR owner_user_id = app_current_user_id())`
-- so that RLS itself hides other people's private views. It is refused for two
-- reasons:
--
--   • There is no `app.current_user_id` setting. Adding one means every
--     `withTenant` call site sets a second variable, and the one that forgets
--     produces a session where the policy matches nothing — a page that is
--     empty rather than an error, which is the failure mode this codebase has
--     been bitten by twice (`withPlatformScope`, `writeAudit`).
--
--   • An admin holding `views:manage_shared` legitimately needs to see and
--     tidy shared views, and a policy that hid them would make the feature
--     impossible rather than merely awkward.
--
-- So visibility WITHIN a tenant is enforced in `server/views/definitions.ts`,
-- which never returns another person's private view, and the database enforces
-- the boundary that actually matters: the tenant one.


-- ############################################################################
-- SECTION 3 — ⭐ CROSS-TENANT REFERENCE INTEGRITY
-- ############################################################################
--
-- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY.
-- Documented PostgreSQL behaviour, easy to read past, and the reason every
-- pointer in this phase is a COMPOSITE key on (col, tenant_id).
--
-- The shape of the hole, concretely for this phase:
--
--     Tenant A inserts a saved view with
--         tenant_id         = A                          ← passes WITH CHECK
--         dynamic_object_id = <an object owned by B>      ← passes the FK
--
--     `server/views/objects.ts` then resolves that id — under tenant A's
--     scope, so the lookup returns nothing and the view refuses to open. That
--     is the good case, and it holds only because the resolver is
--     tenant-scoped. A composite key makes the row unrepresentable instead of
--     making it harmless, which is a much shorter thing to keep true.
--
--     `owner_user_id` is worse in a quieter way: pointed at a user in another
--     tenant it is an EXISTENCE ORACLE (the insert succeeds only for ids that
--     exist), and deleting that user writes into this tenant's rows.

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_id_tenant_key
  ON saved_views (id, tenant_id);

-- Already created by earlier phases; repeated so this file does not depend on
-- the order the SQL directory is applied in.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_key
  ON users (id, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS dynamic_objects_id_tenant_key
  ON dynamic_objects (id, tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_views_owner_same_tenant') THEN
    ALTER TABLE saved_views
      ADD CONSTRAINT saved_views_owner_same_tenant
      FOREIGN KEY (owner_user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      -- ⚠️ CASCADE, and it is the right answer here where it is the wrong
      -- answer for workflow runs. A saved view is a PREFERENCE, not history:
      -- it records how somebody liked to look at a list. When they leave,
      -- their private views are noise in every count and every picker, and
      -- nobody can inherit them because nobody knows what they were for.
      --
      -- ⚠️ THE SHARED ONES GO TOO, AND THAT IS THE PART TO THINK ABOUT. A
      -- team losing the board they work from because a colleague left is a
      -- real outage. `server/views/definitions.ts` therefore refuses to
      -- offboard silently: transferring shared views is part of the
      -- offboarding path, and this cascade is the backstop for a hard DELETE
      -- that went round it — which the product does not do anyway, because
      -- users are suspended rather than deleted.
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_views_created_by_same_tenant') THEN
    ALTER TABLE saved_views
      ADD CONSTRAINT saved_views_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_views_dynamic_object_same_tenant') THEN
    ALTER TABLE saved_views
      ADD CONSTRAINT saved_views_dynamic_object_same_tenant
      FOREIGN KEY (dynamic_object_id, tenant_id)
      REFERENCES dynamic_objects (id, tenant_id)
      -- The record type is gone, so every view over it is meaningless. A
      -- Phase 24 DROP is already an explicitly confirmed act that states the
      -- row count it is destroying; leaving views behind would make it fail
      -- with a foreign-key violation naming a table the customer has never
      -- heard of.
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_view_defaults_user_same_tenant') THEN
    ALTER TABLE saved_view_defaults
      ADD CONSTRAINT saved_view_defaults_user_same_tenant
      FOREIGN KEY (user_id, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_view_defaults_view_same_tenant') THEN
    ALTER TABLE saved_view_defaults
      ADD CONSTRAINT saved_view_defaults_view_same_tenant
      FOREIGN KEY (view_id, tenant_id)
      REFERENCES saved_views (id, tenant_id)
      -- ⚠️ A default pointing at a deleted view makes the object's list page
      -- fail to open, for one person, with an error nobody else can
      -- reproduce. Losing the preference is the correct outcome: they fall
      -- back to the workspace default.
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_view_defaults_dynamic_object_same_tenant') THEN
    ALTER TABLE saved_view_defaults
      ADD CONSTRAINT saved_view_defaults_dynamic_object_same_tenant
      FOREIGN KEY (dynamic_object_id, tenant_id)
      REFERENCES dynamic_objects (id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — ⭐ THE SIZE AND SHAPE GUARDS
-- ############################################################################
--
-- A filter is not a value. It is a small program, evaluated by PostgreSQL
-- against every candidate row, and it is stored once and replayed on every
-- page load forever after.
--
-- Two ways that becomes a denial of service, and NEITHER needs an attacker:
--
--   1. DEPTH. A tree 400 groups deep compiles to 400 nested parenthesised
--      expressions. `lib/views/planner.ts` recurses over it, the query planner
--      recurses over it again, and the second one is holding a connection from
--      a pool shared with every other workspace on the instance.
--
--   2. WIDTH. Sixty `ILIKE '%…%'` conditions over an unindexed text column is
--      sixty substring searches per row on a table with four hundred thousand
--      of them. Nothing about the query is wrong. It simply never finishes.
--
-- Depth and node count are enforced in `lib/views/validation.ts` (at save) and
-- `lib/views/planner.ts` (at replay). Both are APPLICATION rules, and a
-- support engineer in psql, a restore from an older schema, a bulk import or a
-- future API route each walk straight past them.
--
-- ⚠️ SO THE DATABASE ENFORCES THE ONE THING IT CAN ENFORCE WITHOUT PARSING
-- THE TREE: SIZE. 8 KiB of filter JSON is a generous ceiling for a filter a
-- person built by clicking, and a hard floor under the worst case — it bounds
-- node count and depth together, because neither can exceed what fits.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_views_filter_bounded') THEN
    ALTER TABLE saved_views
      ADD CONSTRAINT saved_views_filter_bounded
      -- 8192 is MAX_FILTER_BYTES in lib/views/limits.ts.
      CHECK (pg_column_size(filter) <= 8192);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_views_shape_bounded') THEN
    ALTER TABLE saved_views
      ADD CONSTRAINT saved_views_shape_bounded
      -- The three smaller payloads. A `sorts` array of ten thousand entries is
      -- an ORDER BY nothing can plan; a `visible_columns` array of the same is
      -- a select list the browser cannot draw. MAX_SORTS is 4 and
      -- MAX_VISIBLE_COLUMNS is 40 in lib/views/limits.ts — the ceilings here
      -- are deliberately looser, because this is the backstop and not the
      -- rule, and a constraint violation on a legitimate edit is a worse
      -- outcome than a slightly wide view.
      CHECK (
        jsonb_typeof(sorts) = 'array'
        AND jsonb_array_length(sorts) <= 16
        AND jsonb_typeof(visible_columns) = 'array'
        AND jsonb_array_length(visible_columns) <= 100
        AND jsonb_typeof(filter) = 'object'
      );
  END IF;
END
$$;


-- ############################################################################
-- SECTION 5 — ⭐ SHARING INTEGRITY
-- ############################################################################
--
-- Two rules about `saved_view_defaults` that the application would also
-- enforce and that must hold when it does not.
--
--   A. YOU MAY ONLY DEFAULT TO A VIEW YOU CAN SEE. Setting your default to
--      somebody else's private view would produce a list page that opens to a
--      view you cannot find, cannot edit and cannot change away from through
--      the picker — because the picker does not list it.
--
--   B. ⭐ UN-SHARING MUST NOT STRAND ANYBODY. This is the interesting one. A
--      view is shared, forty people set it as their default, the author makes
--      it private again. Forty list pages now point at a row those forty
--      people are no longer allowed to open. Nothing is corrupt; the product
--      is simply broken for forty people, and the author has no idea they did
--      it.
--
--      So un-sharing DROPS everybody else's default for it, in the same
--      transaction, and they fall back to the workspace default. The author
--      keeps theirs, because it is still their view.

CREATE OR REPLACE FUNCTION saved_view_defaults_check_visible()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_shared boolean;
  v_owner  uuid;
  v_tenant uuid;
BEGIN
  SELECT is_shared, owner_user_id, tenant_id
    INTO v_shared, v_owner, v_tenant
    FROM saved_views
   WHERE id = NEW.view_id;

  IF NOT FOUND THEN
    -- ⚠️ Cannot happen while the composite FK holds. Raised rather than
    -- ignored because "cannot happen" is where the interesting bugs live, and
    -- a trigger that shrugs at an impossible state hides the moment it stops
    -- being impossible.
    RAISE EXCEPTION 'That view does not exist.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'A default view must belong to the same workspace.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_shared AND v_owner <> NEW.user_id THEN
    RAISE EXCEPTION
      'You can only make a view your default if it is your own or shared with '
      'the workspace.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_view_defaults_visible ON saved_view_defaults;
CREATE TRIGGER saved_view_defaults_visible
  BEFORE INSERT OR UPDATE ON saved_view_defaults
  FOR EACH ROW EXECUTE FUNCTION saved_view_defaults_check_visible();


CREATE OR REPLACE FUNCTION saved_views_unshare_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_shared AND NOT NEW.is_shared THEN
    DELETE FROM saved_view_defaults
     WHERE view_id = NEW.id
       AND user_id <> NEW.owner_user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_views_unshare ON saved_views;
CREATE TRIGGER saved_views_unshare
  AFTER UPDATE ON saved_views
  FOR EACH ROW EXECUTE FUNCTION saved_views_unshare_cleanup();


-- ############################################################################
-- SECTION 6 — HOW MANY VIEWS MAY EXIST
-- ############################################################################
--
-- ⚠️ THE FAILURE THIS STOPS IS NOT STORAGE. A view is a few hundred bytes and
-- a million of them would not trouble the disk.
--
-- It is the PICKER. An integration (or a script, or an import that runs
-- nightly) that creates a view per run fills the dropdown on every list page
-- in the product with thousands of entries, and the workspace's own admins
-- can no longer find the three they use. Recovering from that means deleting
-- rows by hand, one workspace at a time, while the customer waits.
--
-- 500 is MAX_SAVED_VIEWS_PER_TENANT in lib/views/limits.ts. The server refuses
-- first, with a sentence somebody can act on; this refuses absolutely.

CREATE OR REPLACE FUNCTION saved_views_enforce_tenant_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM saved_views WHERE tenant_id = NEW.tenant_id;

  IF v_count >= 500 THEN
    RAISE EXCEPTION
      'This workspace already has 500 saved views, which is the maximum. '
      'Delete some before creating another.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS saved_views_tenant_cap ON saved_views;
CREATE TRIGGER saved_views_tenant_cap
  BEFORE INSERT ON saved_views
  FOR EACH ROW EXECUTE FUNCTION saved_views_enforce_tenant_cap();


-- ############################################################################
-- SECTION 7 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DROP TRIGGER IF EXISTS saved_views_set_updated_at ON saved_views;
CREATE TRIGGER saved_views_set_updated_at BEFORE UPDATE ON saved_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS saved_view_defaults_set_updated_at ON saved_view_defaults;
CREATE TRIGGER saved_view_defaults_set_updated_at BEFORE UPDATE ON saved_view_defaults
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ⚠️ ATTACHED HERE RATHER THAN LEFT TO 0017 for the reason Phase 23 gives:
-- that file discovers tenant-scoped tables when it is RE-RUN, and a deployment
-- applying files in numerical order runs it before these tables exist.
--
-- ⚠️ AND A SAVED VIEW IS WORTH LOGGING EVEN THOUGH IT IS "ONLY A PREFERENCE".
-- "Who made this the workspace default?" and "who un-shared the board the team
-- works from?" are both real questions, both asked in anger, and neither is
-- answerable from a table that only holds the current state.

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    FOREACH t IN ARRAY ARRAY['saved_views','saved_view_defaults']
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_change_log', t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
           FOR EACH ROW EXECUTE FUNCTION record_change()',
        t || '_change_log', t);
    END LOOP;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 8 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.
--
-- ⚠️ DELETE **IS** GRANTED HERE, WHICH IT IS NOT IN PHASES 22–24, AND THE
-- DIFFERENCE IS THE POINT.
--
-- A booking, a workflow run and a custom object all record something that
-- HAPPENED — money moved, an automation acted, a table was created. History
-- is not deletable, so those phases grant no DELETE at all and archive
-- instead.
--
-- A saved view records a PREFERENCE. Nothing happened. Soft-deleting it would
-- mean an `archived_at` column, a filter on every picker query, a "deleted
-- views" screen nobody wants and a name-uniqueness index that has to exclude
-- archived rows — all so that a user who tidied up their sidebar can undo it.
-- The change log (Section 7) keeps the record of what was removed and by whom,
-- which is the part that actually matters.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON saved_views         FROM ordence_app;
    REVOKE ALL ON saved_view_defaults FROM ordence_app;

    GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views         TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON saved_view_defaults TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 9 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on both tables.
-- ⚠️ `relforcerowsecurity` is the column that matters. A table with ENABLE but
-- not FORCE looks protected in every UI and is not protected against its own
-- owner.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF: every tenant can read and '
            'edit every other tenant''s saved views ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('saved_views','saved_view_defaults')
ORDER BY c.relname;


-- Check 2 — every policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant a saved view in '
            'another tenant''s workspace ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('saved_views','saved_view_defaults')
ORDER BY tablename;


-- Check 3 — every cross-table pointer is a COMPOSITE (col, tenant_id) key.
-- ⚠️ FK checks ignore RLS. A single-column key here is a saved view that can
-- point at another tenant's user or another tenant's record type.
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('saved_views_owner_same_tenant'),
  ('saved_views_created_by_same_tenant'),
  ('saved_views_dynamic_object_same_tenant'),
  ('saved_view_defaults_user_same_tenant'),
  ('saved_view_defaults_view_same_tenant'),
  ('saved_view_defaults_dynamic_object_same_tenant')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname
ORDER BY expected.conname;


-- Check 4 — the shape and size guards exist.
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: an unbounded filter tree can be stored, and '
            'replaying it holds a connection the whole instance shares ***'
  END AS verdict
FROM (VALUES
  ('saved_views_filter_bounded'),
  ('saved_views_shape_bounded'),
  ('saved_views_object_selector'),
  ('saved_views_kanban_has_grouping'),
  ('saved_views_calendar_has_date'),
  ('saved_views_workspace_default_is_shared')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname
ORDER BY expected.conname;


-- Check 5 — the triggers exist AND are enabled.
-- ⚠️ `tgenabled` is checked, not just presence. `ALTER TABLE … DISABLE TRIGGER`
-- during a data fix that nobody re-enabled leaves a guard that passes every
-- "is it installed?" check and does nothing.
SELECT
  expected.tgname,
  CASE WHEN t.tgname IS NULL THEN '*** FAIL — TRIGGER MISSING ***'
       WHEN t.tgenabled::text = 'O' THEN 'PASS (enabled)'
       ELSE '*** FAIL — trigger DISABLED: ' || t.tgenabled::text || ' ***'
  END AS verdict
FROM (VALUES
  ('saved_view_defaults_visible'),
  ('saved_views_unshare'),
  ('saved_views_tenant_cap'),
  ('saved_views_set_updated_at')
) AS expected(tgname)
LEFT JOIN pg_trigger t ON t.tgname = expected.tgname AND NOT t.tgisinternal
ORDER BY expected.tgname;


-- Check 6 — ⭐ THE NULL-DISTINCTNESS TRAP.
--
-- A unique index that includes a nullable column enforces nothing for the rows
-- where that column is NULL, because NULLs are distinct from each other. The
-- index still shows as UNIQUE in `\d`. This proves the partial indexes exist,
-- so that built-in objects are actually constrained.
SELECT
  expected.indexname,
  CASE WHEN i.indexname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: uniqueness is not enforced for built-in '
            'objects, because NULL <> NULL in a unique index ***'
  END AS verdict
FROM (VALUES
  ('saved_views_name_unique'),
  ('saved_views_one_workspace_default'),
  ('saved_view_defaults_unique')
) AS expected(indexname)
LEFT JOIN pg_indexes i
       ON i.indexname = expected.indexname AND i.schemaname = 'public'
ORDER BY expected.indexname;


-- Check 7 — ⭐ THE SHARING GUARD, EXERCISED RATHER THAN INSPECTED.
--
-- The lesson of Phase 23 was that a guard which EXISTS and does NOTHING passes
-- every structural check. So this one builds two users, a private view, and
-- tries to make it somebody else's default — and then shares it, defaults it,
-- un-shares it, and checks the stranded default is gone.
DO $$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_alice  uuid := gen_random_uuid();
  v_bob    uuid := gen_random_uuid();
  v_view   uuid := gen_random_uuid();
  v_left   integer;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
  VALUES (v_tenant, 'org_' || v_tenant, 'vfy-' || left(v_tenant::text, 8),
          'Views verification', 'active');

  INSERT INTO users (id, tenant_id, clerk_user_id, email, role, status) VALUES
    (v_alice, v_tenant, 'usr_' || v_alice, 'alice@verify.test', 'tenant_admin', 'active'),
    (v_bob,   v_tenant, 'usr_' || v_bob,   'bob@verify.test',   'member',       'active');

  INSERT INTO saved_views (id, tenant_id, object_key, name, owner_user_id, is_shared)
  VALUES (v_view, v_tenant, 'lead', 'Alice private', v_alice, false);

  /* --- A. Bob may not default to Alice's private view ------------ */
  BEGIN
    INSERT INTO saved_view_defaults (tenant_id, user_id, object_key, view_id)
    VALUES (v_tenant, v_bob, 'lead', v_view);

    RAISE WARNING '*** FAIL — a user was allowed to default to somebody else''s '
                  'PRIVATE view. Their list page now opens to a view they cannot '
                  'find, cannot edit and cannot change away from. ***';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a private view cannot become somebody else''s default.';
  END;

  /* --- B. Un-sharing removes the stranded defaults --------------- */
  UPDATE saved_views SET is_shared = true WHERE id = v_view;

  INSERT INTO saved_view_defaults (tenant_id, user_id, object_key, view_id)
  VALUES (v_tenant, v_bob, 'lead', v_view);

  UPDATE saved_views SET is_shared = false WHERE id = v_view;

  SELECT count(*) INTO v_left
    FROM saved_view_defaults WHERE view_id = v_view AND user_id = v_bob;

  IF v_left = 0 THEN
    RAISE NOTICE 'PASS: un-sharing a view cleared the defaults that pointed at it.';
  ELSE
    RAISE WARNING '*** FAIL — un-sharing left % stranded default(s). Those users'' '
                  'list pages now point at a view they may not open. ***', v_left;
  END IF;

  /* --- C. A workspace default must be shared --------------------- */
  BEGIN
    UPDATE saved_views SET is_workspace_default = true WHERE id = v_view;
    RAISE WARNING '*** FAIL — a PRIVATE view became the workspace default. Every '
                  'user now opens a view they cannot see in their picker. ***';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only a shared view can be the workspace default.';
  END;

  DELETE FROM saved_view_defaults WHERE tenant_id = v_tenant;
  DELETE FROM saved_views WHERE tenant_id = v_tenant;
  DELETE FROM users WHERE tenant_id = v_tenant;
  DELETE FROM change_log WHERE tenant_id = v_tenant;
  DELETE FROM tenants WHERE id = v_tenant;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
END
$$;


-- Check 8 — the application role has exactly the grants it needs.
-- (No rows returned = PASS.)
SELECT
  'saved_views grants' AS what,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS granted,
  CASE WHEN count(*) = 4 THEN 'PASS'
       ELSE '*** FAIL — the app role cannot manage saved views ***'
  END AS verdict
FROM information_schema.role_table_grants
WHERE grantee = 'ordence_app' AND table_name = 'saved_views'
GROUP BY table_name;


-- Check 9 — no view points at a record type from another workspace.
-- (No rows returned = PASS. The composite FK makes it impossible; this is the
-- check that says so out loud after a restore or a manual fix.)
SELECT
  v.id,
  '*** FAIL — this saved view names a record type belonging to another '
  'workspace ***' AS verdict
FROM saved_views v
JOIN dynamic_objects o ON o.id = v.dynamic_object_id
WHERE o.tenant_id <> v.tenant_id;


-- Check 10 — no filter is over the size ceiling.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: every stored filter is within the size ceiling'
       ELSE '*** FAIL — ' || count(*) || ' view(s) hold an oversized filter. '
            'Replaying one holds a connection the whole instance shares. ***'
  END AS verdict
FROM saved_views
WHERE pg_column_size(filter) > 8192;


-- Check 11 — the change log covers this phase.
SELECT
  expected.t AS table_name,
  CASE WHEN tg.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — changes here are not recorded and could never sync ***'
  END AS verdict
FROM (VALUES ('saved_views'), ('saved_view_defaults')) AS expected(t)
LEFT JOIN pg_trigger tg
       ON tg.tgname = expected.t || '_change_log' AND NOT tg.tgisinternal
ORDER BY expected.t;
