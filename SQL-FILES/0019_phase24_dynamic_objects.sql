-- ============================================================================
-- Ordence — Phase 24: Runtime Custom Objects
-- Version: v0.24.0-alpha
--
-- Run AFTER `npx drizzle-kit push`, and after `ALL-IN-ONE-SETUP.sql`,
-- `0017_change_log.sql` and `0018_phase23_workflows.sql` — it depends on
-- `set_updated_at()`, `app_current_tenant_id()` and `record_change()` from
-- those. Safe to run BEFORE push too: Section 1 creates its own tables
-- idempotently. Safe to re-run: every statement is guarded.
--
-- Contents:
--    1. Enum and metadata tables
--    2. Row-level security on the metadata
--    3. Cross-tenant reference integrity, and the keys relations need
--    4. ⭐ THE IDENTIFIER GATE — the anti-injection layer, in the database
--    5. ⭐ THE TABLE FACTORY — CREATE TABLE that cannot omit RLS
--    6. ⭐ COLUMNS — add and drop, safely
--    7. ⭐ DROPPING A TABLE THAT HOLDS DATA
--    8. updated_at, and the change log
--    9. Grants — including taking CREATE away from the app role
--   10. Verification
--
-- ============================================================================
-- ⚠️  READ THIS BEFORE THE SQL
-- ============================================================================
-- Twenty-three phases have had a fixed schema. A customer's data changed; the
-- shape of it did not. This phase lets a customer change the SHAPE, at run
-- time, by issuing real `CREATE TABLE` and `ALTER TABLE` against the same
-- database every other customer is on.
--
-- Two things can go wrong that could not go wrong before, and they are not
-- equally weighted with everything else in the file.
--
-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ ⭐ RISK A — A TABLE WITHOUT ROW-LEVEL SECURITY.                        │
-- └────────────────────────────────────────────────────────────────────────┘
-- One forgotten `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and every tenant on
-- the instance can read and write every other tenant's records of that type.
-- Not a bug — a cross-customer data leak, in a table nobody is watching,
-- created by a customer rather than by a deploy.
--
-- The obvious mitigation is a code review rule. That is not a mitigation; it
-- is a hope. So:
--
--   • The CREATE TABLE, the `ENABLE`, the `FORCE` and the policy with BOTH a
--     USING and a WITH CHECK clause are in ONE FUNCTION (§5), executed as one
--     statement block inside the caller's transaction. There is no argument
--     to that function that produces a table without them.
--   • The function then RE-READS `pg_class` and `pg_policy` and RAISES if
--     what it has just built is not protected. DDL is transactional in
--     PostgreSQL, so the raise unwinds the CREATE TABLE with it.
--   • §9 REVOKES `CREATE ON SCHEMA public` from the application role, so the
--     application literally cannot issue a bare CREATE TABLE. The
--     SECURITY DEFINER function is the only door.
--   • §10 sweeps EVERY `cx_` table in the database and reports any that is
--     not enabled, forced and policied — so drift introduced by a future
--     migration is caught by running this file again.
--
-- Twenty CRM, whose runtime-DDL idea this borrows, has no row-level security
-- on its runtime tables at all; isolation is a `WHERE` clause the application
-- remembers to add. That is defensible for a single-tenant deployment. On a
-- shared instance holding forty developers' buyer lists it is one missing
-- clause away from an incident that ends the company.
--
-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ ⭐ RISK B — SQL INJECTION THROUGH AN IDENTIFIER.                       │
-- └────────────────────────────────────────────────────────────────────────┘
-- `CREATE TABLE $1` is not valid SQL in any database and never will be. A
-- table name cannot be a bind parameter, so a name a customer typed must be
-- INTERPOLATED. Every rule this codebase has about parameterising values is
-- inapplicable here, which is exactly why it is dangerous: the habit that has
-- kept twenty-three phases safe does not apply and looks like it does.
--
-- Three layers, and the second and third are in this file:
--
--   1. `lib/dynamic/identifiers.ts` — a strict ALLOWLIST in TypeScript.
--   2. `dynamic_assert_identifier()` (§4) — the SAME allowlist, in the
--      database, because psql, an import script and a future API route can
--      all call these functions and none of them go through TypeScript.
--   3. `format('%I', …)` — never `||`, not once, anywhere in this file.
--      `%I` is PostgreSQL's own identifier quoter: it knows about embedded
--      quotes, about `NAMEDATALEN`, and about which words need quoting.
--
-- ⚠️ AND ONE MORE THING THAT IS EASY TO GET WRONG: `%I` IS FOR IDENTIFIERS
-- AND `%L` IS FOR LITERALS. Using `%I` on a value produces a COLUMN
-- REFERENCE — `CHECK (status = "active")` compares the column to a column
-- called `active`, which either errors or, if such a column exists, silently
-- passes for every row. The `select` option lists in §6 are the only place in
-- this file where a customer-supplied VALUE reaches SQL, and they use `%L`.
-- ============================================================================


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;


-- ############################################################################
-- SECTION 1 — ENUM AND METADATA TABLES
-- ############################################################################
--
-- `drizzle-kit push` creates these from `db/schema/dynamic-objects.ts`. They
-- are restated here for the same reason Phase 23 restates its tables: push
-- removes what it does not recognise, and a file that can only ever run
-- second is a file that fails on a fresh database.
--
-- ⚠️ THE FIELD TYPE ENUM IS GENERATED FROM `lib/dynamic/field-types.ts`. A
-- value added here by hand and not there is a field the database accepts and
-- the DDL planner cannot map to a column type — a field that can be created
-- and can never be written to. Add it in TypeScript; the enum follows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dynamic_field_type') THEN
    CREATE TYPE dynamic_field_type AS ENUM
      ('text','long_text','number','currency','boolean','date','datetime',
       'select','multi_select','email','phone','url','relation');
  END IF;
END
$$;


CREATE TABLE IF NOT EXISTS dynamic_objects (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Immutable. Appears in URLs, in the API and inside the physical table
  -- name. A rename changes `label` and nothing else — see the file header of
  -- db/schema/dynamic-objects.ts.
  api_name                 varchar(40)  NOT NULL,
  label                    varchar(120) NOT NULL,
  plural_label             varchar(120) NOT NULL,
  description              text,
  icon                     varchar(60)  NOT NULL DEFAULT 'box',
  color                    varchar(20)  NOT NULL DEFAULT '#B08D3C',

  -- ⭐ The physical table. Globally unique, not per-tenant: two workspaces
  -- both defining "Property" is the expected case, and a per-tenant unique
  -- would let the second CREATE TABLE fail with "relation already exists" —
  -- telling one customer about the existence of another.
  physical_table_name      varchar(63)  NOT NULL,

  display_field_api_name   varchar(50),
  is_active                boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  archived_at              timestamptz,
  archived_by              uuid,

  -- ⚠️ THE PREFIX AS A CONSTRAINT, NOT A CONVENTION.
  --
  -- The name is built with the prefix in TypeScript and the factory in §5
  -- refuses to create a table without it. This is the third statement of the
  -- same rule, and it is the one that survives somebody editing a row by
  -- hand: a metadata row pointing at `users` would make the generic CRUD
  -- layer read and write the users table under the caller's tenant scope.
  CONSTRAINT dynamic_objects_physical_prefixed
    CHECK (physical_table_name ~ '^cx_[a-z][a-z0-9_]*$'),
  CONSTRAINT dynamic_objects_api_name_shape
    CHECK (api_name ~ '^[a-z][a-z0-9_]*$')
);

CREATE TABLE IF NOT EXISTS dynamic_fields (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_id              uuid NOT NULL REFERENCES dynamic_objects(id) ON DELETE CASCADE,

  api_name               varchar(50)  NOT NULL,
  label                  varchar(150) NOT NULL,
  help_text              text,
  placeholder            varchar(200),
  field_type             dynamic_field_type NOT NULL,
  physical_column_name   varchar(63)  NOT NULL,

  is_required            boolean NOT NULL DEFAULT false,
  is_unique              boolean NOT NULL DEFAULT false,
  is_indexed             boolean NOT NULL DEFAULT false,
  is_hidden              boolean NOT NULL DEFAULT false,
  show_in_grid           boolean NOT NULL DEFAULT true,

  options                jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Exactly one of these two, and only on a relation field.
  relation_object_id     uuid,
  relation_core_table    varchar(63),

  default_value          text,
  sort_order             integer NOT NULL DEFAULT 0,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- ⚠️ Stamped in the SAME transaction as the physical DROP COLUMN. A field
  -- the product has stopped showing but is still storing is personal data
  -- nobody knows they hold.
  deleted_at             timestamptz,

  CONSTRAINT dynamic_fields_api_name_shape
    CHECK (api_name ~ '^[a-z][a-z0-9_]*$'
           AND physical_column_name ~ '^[a-z][a-z0-9_]*$'),

  -- ⭐ A FIELD MAY NOT BE NAMED AFTER A SYSTEM COLUMN.
  --
  -- `tenant_id` is the one that matters. A writable field of that name would
  -- be a form post choosing which workspace a record belongs to, and the only
  -- thing refusing it would be one clause in one policy. Stated here as well
  -- as in TypeScript because this one holds against a hand-written INSERT.
  CONSTRAINT dynamic_fields_not_system_column
    CHECK (api_name NOT IN ('id','tenant_id','created_at','updated_at',
                            'created_by','updated_by','deleted_at','deleted_by',
                            'ctid','oid','xmin','xmax','cmin','cmax','tableoid')),

  CONSTRAINT dynamic_fields_relation_target
    CHECK ((field_type = 'relation') = (
             (relation_object_id IS NOT NULL)::int
             + (relation_core_table IS NOT NULL)::int = 1)),

  -- A choice field with no choices allows nothing, so every write to it
  -- fails: a field that exists and cannot be used.
  CONSTRAINT dynamic_fields_choices_present
    CHECK (field_type NOT IN ('select','multi_select')
           OR jsonb_array_length(options) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dynamic_objects_api_name_unique
  ON dynamic_objects (tenant_id, api_name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dynamic_objects_physical_unique
  ON dynamic_objects (physical_table_name);
CREATE INDEX IF NOT EXISTS dynamic_objects_tenant_idx ON dynamic_objects (tenant_id);
CREATE INDEX IF NOT EXISTS dynamic_objects_tenant_active_idx
  ON dynamic_objects (tenant_id, is_active) WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dynamic_fields_object_name_unique
  ON dynamic_fields (object_id, api_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS dynamic_fields_tenant_idx ON dynamic_fields (tenant_id);
CREATE INDEX IF NOT EXISTS dynamic_fields_object_idx
  ON dynamic_fields (tenant_id, object_id, sort_order);


-- ############################################################################
-- SECTION 2 — ROW-LEVEL SECURITY ON THE METADATA
-- ############################################################################
--
-- ENABLE turns policies on. FORCE applies them to the table OWNER as well,
-- which is the half everybody forgets: without it the role that created the
-- table reads everything and the policies look like they work.
--
-- ⚠️ NO `app_is_platform_scope()` HERE. A tenant's object definitions are a
-- description of what that business tracks — "Site Visit", "Escalation",
-- "Litigation" — which is commercially sensitive in itself. Platform staff
-- resolving a billing webhook have no business reading it.

ALTER TABLE dynamic_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE dynamic_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dynamic_objects_tenant_isolation ON dynamic_objects;
CREATE POLICY dynamic_objects_tenant_isolation ON dynamic_objects
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE dynamic_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE dynamic_fields FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dynamic_fields_tenant_isolation ON dynamic_fields;
CREATE POLICY dynamic_fields_tenant_isolation ON dynamic_fields
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());


-- ############################################################################
-- SECTION 3 — CROSS-TENANT REFERENCE INTEGRITY
-- ############################################################################
--
-- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY.
-- Documented PostgreSQL behaviour, easy to read past, and the reason every
-- pointer in Phases 22, 23 and 24 is a COMPOSITE key on (col, tenant_id).
--
-- The shape of the hole here:
--
--     Tenant A inserts a field with
--         tenant_id          = A                    ← passes WITH CHECK
--         relation_object_id = <an object owned by B>  ← passes a plain FK
--
--     A's field now declares a foreign key to B's physical table. Every row
--     written through it would be refused by the composite FK on the physical
--     column — but the FIELD PICKER would list B's records, because the
--     picker's query is "rows of the table this field points at".
--
-- The core-table unique indexes below exist for a different reason: a
-- composite foreign key needs a UNIQUE (id, tenant_id) on its TARGET, and
-- without one `dynamic_add_field_column` cannot create a relation at all.

CREATE UNIQUE INDEX IF NOT EXISTS dynamic_objects_id_tenant_key
  ON dynamic_objects (id, tenant_id);

-- Targets a `relation` field may point at. Deliberately a SHORT ALLOWLIST of
-- customer content — not "every table with a tenant_id". A foreign key into
-- `audit_logs` would let a customer's own record pin an audit row in place
-- and stop retention from ever removing evidence about them.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','companies','deals','leads','projects',
                           'units','bookings','users']
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (id, tenant_id)',
        t || '_id_tenant_key', t);
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'dynamic_fields_object_same_tenant') THEN
    ALTER TABLE dynamic_fields
      ADD CONSTRAINT dynamic_fields_object_same_tenant
      FOREIGN KEY (object_id, tenant_id)
      REFERENCES dynamic_objects (id, tenant_id)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'dynamic_fields_relation_same_tenant') THEN
    ALTER TABLE dynamic_fields
      ADD CONSTRAINT dynamic_fields_relation_same_tenant
      FOREIGN KEY (relation_object_id, tenant_id)
      REFERENCES dynamic_objects (id, tenant_id)
      -- ⚠️ RESTRICT. Dropping an object that another object links to would
      -- leave a field describing a foreign key to a table that no longer
      -- exists. The physical FK would refuse the DROP anyway; this makes the
      -- refusal happen against the metadata, where the error can name the
      -- field and the object rather than a constraint.
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'dynamic_objects_created_by_same_tenant') THEN
    ALTER TABLE dynamic_objects
      ADD CONSTRAINT dynamic_objects_created_by_same_tenant
      FOREIGN KEY (created_by, tenant_id)
      REFERENCES users (id, tenant_id)
      ON DELETE SET NULL (created_by);
  END IF;
END
$$;


-- ############################################################################
-- SECTION 4 — ⭐ THE IDENTIFIER GATE
-- ############################################################################
--
-- The most important function in the phase after the factory itself.
--
-- ⚠️ IT DUPLICATES `lib/dynamic/identifiers.ts` ON PURPOSE.
--
-- Duplication is normally the thing to remove. Here it is the point: the
-- TypeScript check protects callers that go through TypeScript, and psql, an
-- import script, a `drizzle-kit` hook and a future API route are not among
-- them. A validation that lives only at the outermost layer is a validation
-- that stops applying the first time somebody adds a second entrance.
--
-- ⚠️ AND THE TWO COPIES ARE CHECKED AGAINST EACH OTHER in Section 10, by
-- feeding the same hostile strings to this function that
-- `tests/security/dynamic-objects.test.ts` feeds to the TypeScript one.

CREATE OR REPLACE FUNCTION dynamic_is_reserved_word(p_word text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  -- PostgreSQL's reserved and `reserved (can be function or type name)`
  -- categories. `%I` would quote every one of these correctly and the CREATE
  -- would succeed — the problem is every query written about the column
  -- afterwards, by us in a report or by a customer's analyst in a BI tool,
  -- all of which must remember the quotes forever.
  SELECT lower(p_word) = ANY (ARRAY[
    'all','analyse','analyze','and','any','array','as','asc','asymmetric',
    'authorization','between','bigint','binary','bit','boolean','both','case',
    'cast','char','character','check','coalesce','collate','collation',
    'column','concurrently','constraint','create','cross','current_catalog',
    'current_date','current_role','current_schema','current_time',
    'current_timestamp','current_user','date','dec','decimal','default',
    'deferrable','desc','distinct','do','else','end','except','exists',
    'extract','false','fetch','float','for','foreign','freeze','from','full',
    'grant','greatest','group','grouping','having','ilike','in','initially',
    'inner','inout','int','integer','intersect','interval','into','is',
    'isnull','join','lateral','leading','least','left','like','limit',
    'localtime','localtimestamp','national','natural','nchar','none','not',
    'notnull','null','nullif','numeric','offset','on','only','or','order',
    'out','outer','overlaps','overlay','placing','position','precision',
    'primary','real','references','returning','right','row','select',
    'session_user','setof','similar','smallint','some','substring',
    'symmetric','table','tablesample','then','time','timestamp','to',
    'trailing','treat','trim','true','union','unique','user','using','values',
    'varchar','variadic','verbose','when','where','window','with',
    'xmlattributes','xmlconcat','xmlelement','xmlexists','xmlforest',
    'xmlnamespaces','xmlparse','xmlpi','xmlroot','xmlserialize','xmltable'
  ]);
$$;


/*
 * ⭐ EVERY IDENTIFIER THAT REACHES DDL IN THIS FILE PASSES THROUGH HERE.
 *
 * `p_kind` is 'table' or 'column' and changes only which extra refusals
 * apply. Returns the name UNCHANGED — it never trims, lower-cases or
 * otherwise repairs its input, for the reason spelled out at length in
 * `lib/dynamic/identifiers.ts`: a name that is quietly rewritten is a name
 * that no longer matches what the customer typed, and Unicode case folding
 * is locale-dependent, so the rewrite can differ between two servers.
 */
CREATE OR REPLACE FUNCTION dynamic_assert_identifier(p_ident text, p_kind text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
BEGIN
  IF p_ident IS NULL OR p_ident = '' THEN
    RAISE EXCEPTION 'A % name is required.', p_kind USING ERRCODE = '42602';
  END IF;

  -- ⭐ THE ALLOWLIST. Anchored at both ends. An unanchored pattern matches a
  -- SUBSTRING and would approve `bob"; DROP TABLE users; --` without
  -- hesitation.
  IF p_ident !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION
      'Refused % name %: names must match ^[a-z][a-z0-9_]*$. Quotes, '
      'semicolons, spaces, hyphens, capitals and every non-ASCII character '
      'are refused rather than stripped — a sanitiser that turned '
      '"; DROP TABLE users; --" into "droptableusers" would have created a '
      'table nobody asked for.',
      p_kind, quote_literal(left(p_ident, 60))
      USING ERRCODE = '42602';
  END IF;

  -- ⚠️ THE SAME RULE A SECOND WAY, AS A NEGATIVE CHARACTER CLASS.
  --
  -- PostgreSQL's `$` matches only at end-of-string by default, so the anchor
  -- above is sufficient today. It stops being sufficient the moment somebody
  -- adds the `n` flag to that regex for an unrelated reason, and then a name
  -- containing a newline would pass with everything after the newline
  -- unchecked. This assertion cannot be broken that way.
  IF p_ident ~ '[^a-z0-9_]' THEN
    RAISE EXCEPTION 'Refused % name: it contains a character outside a-z0-9_.',
      p_kind USING ERRCODE = '42602';
  END IF;

  -- ⚠️ OCTETS, NOT CHARACTERS. PostgreSQL truncates identifiers past
  -- NAMEDATALEN-1 = 63 BYTES silently, with a notice nobody reads. Two long
  -- field names then become one column, and one field's unique constraint
  -- starts enforcing another field's values.
  IF octet_length(p_ident) > 63 THEN
    RAISE EXCEPTION
      'Refused % name: % bytes exceeds PostgreSQL''s 63-byte identifier '
      'limit, and longer names are TRUNCATED rather than rejected.',
      p_kind, octet_length(p_ident)
      USING ERRCODE = '42602';
  END IF;

  IF p_ident LIKE 'pg\_%' OR p_ident LIKE 'sql\_%' THEN
    RAISE EXCEPTION
      'Refused % name %: the "pg_" and "sql_" prefixes are reserved by '
      'PostgreSQL for its own catalogues.',
      p_kind, quote_literal(p_ident)
      USING ERRCODE = '42602';
  END IF;

  IF p_kind = 'column' THEN
    IF p_ident IN ('id','tenant_id','created_at','updated_at','created_by',
                   'updated_by','deleted_at','deleted_by',
                   'ctid','oid','xmin','xmax','cmin','cmax','tableoid') THEN
      RAISE EXCEPTION
        'Refused column name %: every record already has a system column of '
        'that name. "tenant_id" in particular is what row-level security is '
        'enforced on — a writable field of that name would let a form post '
        'choose which workspace a record belongs to.',
        quote_literal(p_ident)
        USING ERRCODE = '42602';
    END IF;

    IF dynamic_is_reserved_word(p_ident) THEN
      RAISE EXCEPTION
        'Refused column name %: it is a reserved SQL word. It would be quoted '
        'correctly here and would then break the first hand-written query '
        'that forgets the quotes — in a report, a BI tool, or at a psql '
        'prompt during an incident.',
        quote_literal(p_ident)
        USING ERRCODE = '42602';
    END IF;
  END IF;

  RETURN p_ident;
END;
$fn$;


/*
 * The field type → column type mapping.
 *
 * ⚠️ THE RETURN VALUE IS INTERPOLATED INTO DDL WITH `%s`, NOT `%I`.
 *
 * That is correct and it is only correct because the value can never come
 * from a caller: the input is constrained by the `dynamic_field_type` enum
 * and the output is a literal from the CASE below. `numeric(38,10)` and
 * `text[]` are not valid identifiers, so `%I` would quote them into
 * nonsense — which is why the check has to be on the INPUT rather than the
 * output. An unknown type RAISES; it never falls back to `text`, because a
 * fallback is a column that silently accepts the money somebody meant to
 * store as a whole number of paise.
 *
 * ⚠️ MUST AGREE WITH `FIELD_TYPE_CATALOG` IN `lib/dynamic/field-types.ts`.
 * Section 10 asserts every enum value maps to something.
 */
CREATE OR REPLACE FUNCTION dynamic_pg_type(p_field_type text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
BEGIN
  RETURN CASE p_field_type
    WHEN 'text'         THEN 'text'
    WHEN 'long_text'    THEN 'text'
    -- Exact decimal, never floating point: a CRM multiplies areas by rates
    -- and sums the results, and 0.1 + 0.2 is visible to a customer in a total.
    WHEN 'number'       THEN 'numeric(38,10)'
    -- ⭐ MONEY IS bigint MINOR UNITS (paise). The house rule since Phase 4.
    -- bigint raises on overflow instead of wrapping, and ₹0.10 has no exact
    -- binary representation.
    WHEN 'currency'     THEN 'bigint'
    WHEN 'boolean'      THEN 'boolean'
    -- `date`, not timestamptz. A handover date is a calendar day; storing it
    -- as an instant makes it move across a timezone boundary.
    WHEN 'date'         THEN 'date'
    WHEN 'datetime'     THEN 'timestamptz'
    -- text + CHECK rather than a PG enum: there is no ALTER TYPE … DROP
    -- VALUE, so a tenant who added a status by mistake could never remove it.
    WHEN 'select'       THEN 'text'
    WHEN 'multi_select' THEN 'text[]'
    WHEN 'email'        THEN 'text'
    WHEN 'phone'        THEN 'text'
    WHEN 'url'          THEN 'text'
    WHEN 'relation'     THEN 'uuid'
    ELSE NULL
  END;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;


/*
 * Deterministic, collision-free, always-short names for the indexes and
 * constraints this engine creates.
 *
 * ⚠️ `format('%I', table || '_' || column || '_uq')` IS THE OBVIOUS VERSION
 * AND IT IS A REAL BUG. A 52-byte table name plus a 50-byte column name is
 * 105 bytes; PostgreSQL truncates it to 63 SILENTLY, so two different long
 * columns produce the SAME index name — and the second CREATE INDEX either
 * fails confusingly or, for a unique index, ends up enforcing uniqueness on
 * the wrong column. The md5 fragment makes the short form unique.
 */
CREATE OR REPLACE FUNCTION dynamic_ddl_name(p_table text, p_column text, p_suffix text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT left(p_table, 20) || '_' || left(p_column, 20) || '_'
      || substr(md5(p_table || ':' || p_column || ':' || p_suffix), 1, 8)
      || '_' || p_suffix;
$$;


-- ############################################################################
-- SECTION 5 — ⭐⭐ THE TABLE FACTORY
-- ############################################################################
--
-- THE MOST IMPORTANT FUNCTION IN THE PHASE.
--
-- It is the ONLY way a runtime table comes into existence, and it cannot
-- produce one that is unprotected. Not "does not, if called correctly" —
-- cannot, because:
--
--   • it takes no argument that would switch row-level security off;
--   • the CREATE, the ENABLE, the FORCE and the policy are one block;
--   • it then RE-READS the catalogue and RAISES if the result is not
--     protected, which unwinds the CREATE with it (DDL is transactional in
--     PostgreSQL — this phase depends on that);
--   • §9 revokes CREATE on the schema from the application role, so there is
--     no second door.
--
-- ⚠️ WHY `SECURITY DEFINER`, AND WHAT IT COSTS.
--
-- The application role must be able to make tables without being able to make
-- tables. `SECURITY DEFINER` is how: the function runs as its owner (the
-- migration superuser), so it can issue DDL, while the caller cannot. The
-- cost is that EVERY LINE INSIDE THIS FUNCTION RUNS PRIVILEGED:
--
--   ⚠️ (a) `search_path` is PINNED. Without `SET search_path`, a caller who
--          can create a schema early in their own path can shadow `format`,
--          `md5` or a table this function reads — the textbook privilege
--          escalation against a DEFINER function.
--
--   ⚠️ (b) RLS DOES NOT APPLY INSIDE. The owner is a superuser, so every
--          SELECT here sees every tenant's rows. Every query below therefore
--          carries its own `tenant_id =` predicate explicitly. A missing one
--          is a cross-tenant read with no policy to catch it.
--
--   ⚠️ (c) THE TENANT IS CHECKED AGAINST THE SESSION, NOT TRUSTED. A caller
--          who could pass any `p_tenant_id` could create a table pinned to
--          somebody else's workspace, inside their cap, that they can then
--          write to. So `p_tenant_id` must equal `app_current_tenant_id()`.
--
--   ⚠️ (d) EXECUTE IS REVOKED FROM PUBLIC in §9. A SECURITY DEFINER function
--          executable by PUBLIC is executable by every role on the instance.

CREATE OR REPLACE FUNCTION dynamic_create_object_table(
  p_tenant_id  uuid,
  p_table_name text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_table    text;
  v_policy   text;
  v_objects  integer;
  v_enabled  boolean;
  v_forced   boolean;
  v_qual     text;
  v_check    text;
BEGIN
  -- ── (c) The caller does not get to choose the tenant ───────────────
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'A workspace is required to create a record type.'
      USING ERRCODE = '42501';
  END IF;

  IF app_current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION
      'Refusing to create a table for a workspace other than the one this '
      'session is scoped to. This function runs privileged; the workspace it '
      'acts on is taken from the session, never from its caller.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
    RAISE EXCEPTION 'That workspace does not exist.' USING ERRCODE = '23503';
  END IF;

  -- ── The name ───────────────────────────────────────────────────────
  v_table := dynamic_assert_identifier(p_table_name, 'table');

  -- ⭐ THE PREFIX IS ENFORCED HERE, NOT ONLY WHERE THE NAME IS BUILT.
  --
  -- This is what makes collision with a core table structurally impossible
  -- rather than conventionally unlikely. A caller asking for `users` is
  -- refused before any DDL is composed — and §10 asserts that no core table
  -- has acquired a `cx_` name, which is the other half of the guarantee.
  IF left(v_table, 3) <> 'cx_' OR octet_length(v_table) < 5 THEN
    RAISE EXCEPTION
      'Refused table name %: every runtime table must be named "cx_…". The '
      'prefix is what makes a collision with a built-in table impossible; '
      'without it a workspace could define a record type called "users".',
      quote_literal(v_table)
      USING ERRCODE = '42602';
  END IF;

  IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
    RAISE EXCEPTION
      'A table called % already exists. Physical names carry a random '
      'discriminator precisely so this cannot happen; if you are seeing it, '
      'the metadata row and the table have got out of step.',
      quote_literal(v_table)
      USING ERRCODE = '42P07';
  END IF;

  -- ── The cap (see lib/dynamic/limits.ts — MAX_OBJECTS_PER_TENANT) ────
  --
  -- ⚠️ (b) The tenant predicate is explicit. RLS does not apply in here.
  -- Counted AFTER the metadata row is inserted by the caller, in the same
  -- transaction, so the new object is included: `> 50` allows fifty.
  SELECT count(*) INTO v_objects
    FROM public.dynamic_objects o
   WHERE o.tenant_id = p_tenant_id AND o.archived_at IS NULL;

  IF v_objects > 50 THEN
    RAISE EXCEPTION
      'This workspace already has the maximum of 50 record types. Every one '
      'is a real table, and catalogue bloat is the one cost a single '
      'workspace can impose on every other workspace on this instance.'
      USING ERRCODE = '23514';
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- ⭐ THE TABLE, AND EVERYTHING THAT MAKES IT SAFE, IN ONE BLOCK
  -- ══════════════════════════════════════════════════════════════════
  --
  -- ⚠️ `tenant_id uuid NOT NULL` IS THE FIRST THING AND IT IS NOT
  -- OPTIONAL. Nullable, the policy `tenant_id = app_current_tenant_id()`
  -- would be NULL — never TRUE — for a row with no tenant, so the row
  -- would be invisible to everybody including the tenant that wrote it,
  -- and would sit in the table forever being backed up.
  EXECUTE format($ddl$
    CREATE TABLE public.%I (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_by  uuid,
      deleted_at  timestamptz,
      deleted_by  uuid,
      CONSTRAINT %I CHECK (tenant_id = %L::uuid)
    )
  $ddl$, v_table, left(v_table, 58) || '_tpin', p_tenant_id);

  -- ⭐ THE TENANT PIN, above. Belt to the policy's braces.
  --
  -- Each runtime table belongs to exactly ONE workspace — that is a fact of
  -- the design, so it may as well be a constraint. With it, a row belonging
  -- to another tenant cannot exist in this table even if the policy is
  -- dropped, even under a superuser, even through a restore. It costs one
  -- constant comparison per write and it converts "protected by a policy"
  -- into "structurally single-tenant, and also protected by a policy".

  -- Needed as the TARGET of a composite foreign key from a relation field.
  EXECUTE format('CREATE UNIQUE INDEX %I ON public.%I (id, tenant_id)',
                 left(v_table, 52) || '_id_tenant', v_table);

  -- The two queries every list view runs.
  EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, created_at DESC) '
                 'WHERE deleted_at IS NULL',
                 left(v_table, 50) || '_live_idx', v_table);

  -- ══════════════════════════════════════════════════════════════════
  -- ⭐⭐ ROW-LEVEL SECURITY. THE REASON THIS FUNCTION EXISTS.
  -- ══════════════════════════════════════════════════════════════════
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);

  -- ⚠️ FORCE IS THE HALF EVERYBODY FORGETS. Without it the policies do not
  -- apply to the table OWNER, so the table looks protected in every
  -- interface and is readable in full by whichever role created it.
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);

  v_policy := left(v_table, 45) || '_isolation';

  -- ⚠️ BOTH CLAUSES. USING controls what is READ (and what UPDATE and DELETE
  -- can see); WITH CHECK controls what is WRITTEN. With only USING, another
  -- tenant can INSERT a row into this table that is invisible to them and
  -- fully live for the owner — which for a custom object means planting
  -- records inside somebody else's workspace.
  EXECUTE format(
    'CREATE POLICY %I ON public.%I '
    'USING (tenant_id = app_current_tenant_id()) '
    'WITH CHECK (tenant_id = app_current_tenant_id())',
    v_policy, v_table);

  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON public.%I '
    'FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
    left(v_table, 50) || '_set_upd', v_table);

  -- ⚠️ THE CHANGE LOG COVERS RUNTIME TABLES TOO. `0017_change_log.sql`
  -- discovers tenant-scoped tables when it is RE-RUN; a table created at 3pm
  -- on a Tuesday would otherwise record nothing until somebody happened to
  -- re-run a migration. A hole in the change feed is invisible until data
  -- goes missing between two machines.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION record_change()',
      left(v_table, 50) || '_chglog', v_table);
  END IF;

  -- The application role gets DML and nothing else. It has no DDL rights on
  -- this table at all — ALTER goes through the functions in §6.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO ordence_app',
                   v_table);
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- ⭐⭐ SELF-VERIFICATION — PROVE IT, DO NOT ASSUME IT
  -- ══════════════════════════════════════════════════════════════════
  --
  -- Everything above is correct as written. This block exists because
  -- "correct as written" is exactly what every unprotected table in every
  -- post-mortem was, right up until an edit three months later.
  --
  -- If any of this fails the RAISE unwinds the whole transaction — the
  -- CREATE TABLE, the metadata row the caller inserted, all of it. The
  -- customer gets an error; nobody gets an unprotected table.
  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = v_table;

  IF v_enabled IS NOT TRUE OR v_forced IS NOT TRUE THEN
    RAISE EXCEPTION
      'ABORTING: the table % was created without row-level security '
      '(enabled=%, forced=%). Every workspace on this instance would have '
      'been able to read and write it. Rolling the whole transaction back.',
      quote_literal(v_table), v_enabled, v_forced
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_get_expr(p.polqual, p.polrelid),
         pg_get_expr(p.polwithcheck, p.polrelid)
    INTO v_qual, v_check
    FROM pg_policy p
   WHERE p.polrelid = format('public.%I', v_table)::regclass
   LIMIT 1;

  IF v_qual IS NULL OR v_check IS NULL
     OR v_qual  NOT LIKE '%tenant_id%'
     OR v_check NOT LIKE '%tenant_id%' THEN
    RAISE EXCEPTION
      'ABORTING: the isolation policy on % is incomplete (using=%, '
      'with check=%). A policy with only a USING clause lets another '
      'workspace plant rows here that are invisible to them and live for '
      'the owner.',
      quote_literal(v_table), coalesce(v_qual, '<none>'), coalesce(v_check, '<none>')
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_table
       AND c.column_name = 'tenant_id' AND c.is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      'ABORTING: % has no NOT NULL tenant_id. A null tenant makes the policy '
      'evaluate to NULL rather than TRUE, so the row is invisible to '
      'everybody and lives forever.',
      quote_literal(v_table)
      USING ERRCODE = '42501';
  END IF;

  RETURN v_table;
END;
$fn$;


-- ############################################################################
-- SECTION 6 — ⭐ COLUMNS
-- ############################################################################
--
-- Same SECURITY DEFINER reasoning as §5, and the same four hazards. The extra
-- one here is OWNERSHIP: a caller must not be able to add a column to a table
-- belonging to somebody else, and `to_regclass` will happily find any table in
-- the database. So the target is resolved through `dynamic_objects` with an
-- explicit tenant predicate, never through the catalogue.

CREATE OR REPLACE FUNCTION dynamic_add_field_column(
  p_tenant_id      uuid,
  p_table_name     text,
  p_column_name    text,
  p_field_type     text,
  p_required       boolean DEFAULT false,
  p_unique         boolean DEFAULT false,
  p_indexed        boolean DEFAULT false,
  p_options        text[]  DEFAULT NULL,
  p_relation_table text    DEFAULT NULL,
  p_on_delete      text    DEFAULT 'set_null'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_table   text;
  v_column  text;
  v_type    text;
  v_target  text;
  v_object  uuid;
  v_fields  integer;
  v_rows    bigint;
BEGIN
  IF app_current_tenant_id() IS DISTINCT FROM p_tenant_id OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION
      'Refusing to alter a table for a workspace other than the one this '
      'session is scoped to.'
      USING ERRCODE = '42501';
  END IF;

  v_table  := dynamic_assert_identifier(p_table_name, 'table');
  v_column := dynamic_assert_identifier(p_column_name, 'column');

  -- ⭐ OWNERSHIP, RESOLVED THROUGH THE METADATA AND NOT THE CATALOGUE.
  --
  -- ⚠️ The tenant predicate is explicit because RLS does not apply inside a
  -- SECURITY DEFINER function owned by a superuser. Without it, this lookup
  -- would find any workspace's object and this function would add a column to
  -- it — which for a `relation` field means creating a foreign key from
  -- somebody else's table into ours.
  SELECT o.id INTO v_object
    FROM public.dynamic_objects o
   WHERE o.physical_table_name = v_table
     AND o.tenant_id = p_tenant_id
     AND o.archived_at IS NULL;

  IF v_object IS NULL THEN
    -- ⚠️ The same message whether it belongs to somebody else or to nobody.
    -- The alternative is an oracle for which physical tables exist.
    RAISE EXCEPTION 'That record type does not exist in this workspace.'
      USING ERRCODE = '42P01';
  END IF;

  v_type := dynamic_pg_type(p_field_type);
  IF v_type IS NULL THEN
    RAISE EXCEPTION
      'Refused field type %: this engine has no column type for it. Refusing '
      'rather than defaulting to text — a text fallback silently accepts the '
      'money somebody meant to store as a whole number of paise.',
      quote_literal(coalesce(p_field_type, '<null>'))
      USING ERRCODE = '42704';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = v_table
       AND c.column_name = v_column
  ) THEN
    RAISE EXCEPTION 'This record type already has a field called %.',
      quote_literal(v_column) USING ERRCODE = '42701';
  END IF;

  -- The field cap (lib/dynamic/limits.ts — MAX_FIELDS_PER_OBJECT). Counted
  -- here as well as in TypeScript because two concurrent requests can each
  -- see ninety-nine.
  SELECT count(*) INTO v_fields
    FROM public.dynamic_fields f
   WHERE f.object_id = v_object AND f.deleted_at IS NULL;

  IF v_fields > 100 THEN
    RAISE EXCEPTION
      'A record type may have at most 100 fields. PostgreSQL allows far more; '
      'a table near its limit is unusable in every grid and holds an ACCESS '
      'EXCLUSIVE lock for measurably longer on every subsequent change.'
      USING ERRCODE = '23514';
  END IF;

  -- ══════════════════════════════════════════════════════════════════
  -- THE COLUMN
  -- ══════════════════════════════════════════════════════════════════
  --
  -- ⚠️ `%I` FOR THE NAME, `%s` FOR THE TYPE — AND THE ASYMMETRY IS
  -- DELIBERATE. `numeric(38,10)` and `text[]` are not identifiers, so `%I`
  -- would quote them into nonsense. `%s` is safe here and ONLY here because
  -- `v_type` cannot come from the caller: `dynamic_pg_type` maps a value the
  -- enum has already constrained onto a literal from a CASE, and returns NULL
  -- (refused above) for anything else.
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN %I %s', v_table, v_column, v_type);

  IF p_required THEN
    -- ⚠️ NOT NULL ON A TABLE THAT ALREADY HAS ROWS IS A FAILED MIGRATION.
    -- PostgreSQL validates the constraint against existing rows, all of which
    -- have NULL in a column added one statement ago. Refusing with a sentence
    -- beats `column "x" contains null values`, which names neither the field
    -- nor the remedy.
    EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION
        'This record type already has % record(s), so a required field cannot '
        'be added — every existing record would be missing it. Add it as '
        'optional, fill it in, then make it required.',
        v_rows
        USING ERRCODE = '23514';
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL', v_table, v_column);
  END IF;

  -- ── Choices ────────────────────────────────────────────────────────
  --
  -- ⚠️⚠️ `%L`, NOT `%I`. THE ONE PLACE IN THIS FILE WHERE A CUSTOMER-SUPPLIED
  -- VALUE REACHES SQL.
  --
  -- `%I` here would emit `CHECK (status = ANY ("active","won"))` — column
  -- references, not strings. That either errors, or (if a column of that name
  -- exists) silently compares the column to itself and passes for every row,
  -- which is a constraint that looks present and enforces nothing.
  IF p_options IS NOT NULL AND coalesce(array_length(p_options, 1), 0) > 0 THEN
    IF v_type = 'text[]' THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'CHECK (%I IS NULL OR %I <@ %L::text[])',
        v_table, dynamic_ddl_name(v_table, v_column, 'opt'),
        v_column, v_column, p_options);
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'CHECK (%I IS NULL OR %I = ANY (%L::text[]))',
        v_table, dynamic_ddl_name(v_table, v_column, 'opt'),
        v_column, v_column, p_options);
    END IF;
  END IF;

  -- ── Relation ───────────────────────────────────────────────────────
  IF p_relation_table IS NOT NULL THEN
    IF v_type <> 'uuid' THEN
      RAISE EXCEPTION 'Only a "Link to a record" field can point at another table.'
        USING ERRCODE = '42809';
    END IF;

    v_target := dynamic_assert_identifier(p_relation_table, 'table');

    IF left(v_target, 3) = 'cx_' THEN
      -- ⚠️ Explicit tenant predicate, again. A relation to another
      -- workspace's table would make the record picker list their records.
      IF NOT EXISTS (
        SELECT 1 FROM public.dynamic_objects o
         WHERE o.physical_table_name = v_target
           AND o.tenant_id = p_tenant_id
           AND o.archived_at IS NULL
      ) THEN
        RAISE EXCEPTION 'The record type this field links to does not exist '
                        'in this workspace.'
          USING ERRCODE = '42P01';
      END IF;
    ELSIF v_target NOT IN ('contacts','companies','deals','leads','projects',
                           'units','bookings','users') THEN
      -- ⭐ AN ALLOWLIST, NOT "ANY TABLE WITH A tenant_id". A foreign key into
      -- `audit_logs` would let a customer's own record pin an audit row in
      -- place and stop retention from removing evidence about them.
      RAISE EXCEPTION
        'A field cannot link to %. Only a short list of built-in record types '
        'may be linked to.',
        quote_literal(v_target)
        USING ERRCODE = '42501';
    END IF;

    -- ⭐ COMPOSITE, ON (column, tenant_id). NOT a plain FK to (id).
    --
    -- ⚠️ FOREIGN-KEY CHECKS RUN AS THE SYSTEM AND IGNORE ROW-LEVEL SECURITY.
    -- A single-column key to `leads(id)` would accept another workspace's
    -- lead id — the row would store it, and the picker would render that
    -- workspace's lead name inside ours.
    IF p_on_delete = 'restrict' THEN
      -- A required link cannot become NULL, so the delete is refused instead.
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'FOREIGN KEY (%I, tenant_id) REFERENCES public.%I (id, tenant_id) '
        'ON DELETE RESTRICT',
        v_table, dynamic_ddl_name(v_table, v_column, 'fk'),
        v_column, v_target);
    ELSE
      -- ⚠️ CASCADE IS NOT OFFERED AND WILL NOT BE. "Delete this contact"
      -- silently deleting eighty site visits is a data-loss feature with a
      -- confirmation dialog in front of it that nobody reads.
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I '
        'FOREIGN KEY (%I, tenant_id) REFERENCES public.%I (id, tenant_id) '
        'ON DELETE SET NULL (%I)',
        v_table, dynamic_ddl_name(v_table, v_column, 'fk'),
        v_column, v_target, v_column);
    END IF;
  END IF;

  -- ── Indexes ────────────────────────────────────────────────────────
  IF p_unique THEN
    -- ⚠️ SCOPED TO THE TENANT AND PARTIAL ON `deleted_at`. The table is
    -- single-tenant, so `(tenant_id, col)` is equivalent to `(col)` today —
    -- and it stays correct if that ever stops being true. Partial, because a
    -- soft-deleted record must not reserve a value forever: "that reference
    -- number is taken" about a record nobody can see is unanswerable support.
    EXECUTE format(
      'CREATE UNIQUE INDEX %I ON public.%I (tenant_id, %I) WHERE deleted_at IS NULL',
      dynamic_ddl_name(v_table, v_column, 'uq'), v_table, v_column);
  END IF;

  IF p_indexed THEN
    EXECUTE format('CREATE INDEX %I ON public.%I (tenant_id, %I)',
                   dynamic_ddl_name(v_table, v_column, 'ix'), v_table, v_column);
  END IF;

  RETURN v_column;
END;
$fn$;


/*
 * Dropping a column.
 *
 * ⚠️ THIS DESTROYS DATA AND THERE IS NO UNDO. `DROP COLUMN` takes the values
 * with it and PostgreSQL does not keep a copy. The confirmation lives one
 * layer up, in `server/dynamic/objects.ts`, because the person who has to
 * agree is looking at a screen rather than at a psql prompt.
 *
 * Indexes and constraints that mention the column go with it automatically —
 * that is `DROP COLUMN` semantics, not something this function arranges.
 */
CREATE OR REPLACE FUNCTION dynamic_drop_field_column(
  p_tenant_id   uuid,
  p_table_name  text,
  p_column_name text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_table  text;
  v_column text;
BEGIN
  IF app_current_tenant_id() IS DISTINCT FROM p_tenant_id OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Refusing to alter a table outside this session''s workspace.'
      USING ERRCODE = '42501';
  END IF;

  v_table  := dynamic_assert_identifier(p_table_name, 'table');
  -- ⚠️ 'column' kind, so the system-column refusal applies. Without it this
  -- function would happily drop `tenant_id` — turning a protected table into
  -- one whose policy references a column that no longer exists, and whose
  -- every query then fails. The metadata says a field can never be called
  -- that; this says the function can never be asked to.
  v_column := dynamic_assert_identifier(p_column_name, 'column');

  IF NOT EXISTS (
    SELECT 1 FROM public.dynamic_objects o
     WHERE o.physical_table_name = v_table AND o.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'That record type does not exist in this workspace.'
      USING ERRCODE = '42P01';
  END IF;

  EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS %I', v_table, v_column);
  RETURN v_column;
END;
$fn$;


-- ############################################################################
-- SECTION 7 — ⭐ DROPPING A TABLE THAT HOLDS DATA
-- ############################################################################
--
-- The most destructive operation in the product. `DROP TABLE` on a runtime
-- object destroys every record of that type, irreversibly, and the customer
-- who asks for it is usually tidying up.
--
-- ⚠️ THE CONFIRMATION IS A ROW COUNT, NOT A BOOLEAN.
--
-- `p_confirm boolean` would be honest and useless: it is set to `true` once,
-- at the call site, by a developer, and from then on every call is confirmed.
-- Requiring the caller to state HOW MANY LIVE RECORDS THEY ARE DESTROYING
-- means the number has to come from somewhere — a screen a person read — and
-- a count that has changed since they read it aborts the drop. That is the
-- same idea as an optimistic-concurrency check, applied to a decision instead
-- of a row.
--
-- ⚠️ AND IT REFUSES OUTRIGHT AT ZERO MISMATCH. There is no `force` parameter.
-- The remedy for "the count changed" is to look again.

CREATE OR REPLACE FUNCTION dynamic_drop_object_table(
  p_tenant_id       uuid,
  p_table_name      text,
  p_expected_rows   bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_table  text;
  v_actual bigint;
BEGIN
  IF app_current_tenant_id() IS DISTINCT FROM p_tenant_id OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Refusing to drop a table outside this session''s workspace.'
      USING ERRCODE = '42501';
  END IF;

  v_table := dynamic_assert_identifier(p_table_name, 'table');

  IF left(v_table, 3) <> 'cx_' THEN
    -- ⭐ THE PREFIX AGAIN, AND HERE IT IS LOAD-BEARING IN THE OTHER
    -- DIRECTION. Without this line, a caller who could reach this function
    -- with `p_table_name => 'users'` would drop the users table. The
    -- ownership check below would refuse it too — this is the check that
    -- does not depend on the metadata being intact.
    RAISE EXCEPTION
      'Refusing to drop %: only tables created by this engine ("cx_…") can '
      'be dropped through it.',
      quote_literal(v_table)
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.dynamic_objects o
     WHERE o.physical_table_name = v_table AND o.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'That record type does not exist in this workspace.'
      USING ERRCODE = '42P01';
  END IF;

  IF to_regclass(format('public.%I', v_table)) IS NULL THEN
    -- The metadata row survived a table that did not. Let the caller delete
    -- the row; there is nothing here to drop.
    RETURN 0;
  END IF;

  EXECUTE format('SELECT count(*) FROM public.%I WHERE deleted_at IS NULL', v_table)
    INTO v_actual;

  IF p_expected_rows IS NULL OR p_expected_rows <> v_actual THEN
    RAISE EXCEPTION
      'Refusing to drop %: it holds % live record(s) and the request expected '
      '%. Dropping the table destroys every one of them and there is no undo. '
      'Look at the current count and confirm that number.',
      quote_literal(v_table), v_actual, coalesce(p_expected_rows::text, 'no confirmation')
      USING ERRCODE = '23514';
  END IF;

  -- ⚠️ NO CASCADE. If another object has a relation field pointing here, the
  -- foreign key refuses the drop — and that refusal is correct. CASCADE would
  -- silently drop the OTHER object's column as well, which is one workspace
  -- member deleting a field from a colleague's record type by tidying up
  -- their own.
  EXECUTE format('DROP TABLE public.%I', v_table);
  RETURN v_actual;
END;
$fn$;


-- ############################################################################
-- SECTION 8 — updated_at, AND THE CHANGE LOG
-- ############################################################################

DROP TRIGGER IF EXISTS dynamic_objects_set_updated_at ON dynamic_objects;
CREATE TRIGGER dynamic_objects_set_updated_at BEFORE UPDATE ON dynamic_objects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS dynamic_fields_set_updated_at ON dynamic_fields;
CREATE TRIGGER dynamic_fields_set_updated_at BEFORE UPDATE ON dynamic_fields
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Attached here rather than left to `0017_change_log.sql`, which only
-- discovers tables when it is re-run — and a deployment applying files in
-- numerical order runs it before these exist.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_change') THEN
    FOREACH t IN ARRAY ARRAY['dynamic_objects','dynamic_fields']
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
-- SECTION 9 — GRANTS
-- ############################################################################
--
-- REVOKE before GRANT. An additive-only block is defeated by any prior
-- `GRANT ALL ON ALL TABLES`, which is the first thing most people run when a
-- query fails with "permission denied". Found the hard way in Phase 11.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app') THEN
    REVOKE ALL ON dynamic_objects FROM ordence_app;
    REVOKE ALL ON dynamic_fields  FROM ordence_app;

    -- ⚠️ DELETE IS GRANTED HERE, UNLIKE PHASE 23.
    --
    -- A workflow's run history is evidence and is never deleted. An object
    -- definition is not evidence — it is a description of a table, and when
    -- the table is dropped the description MUST go with it. A metadata row
    -- surviving its table produces an object in the customer's navigation
    -- whose every query fails; a table surviving its metadata row is worse
    -- still, holding personal data that nothing in the product can enumerate.
    -- Both halves are removed together or neither is.
    GRANT SELECT, INSERT, UPDATE, DELETE ON dynamic_objects TO ordence_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON dynamic_fields  TO ordence_app;

    -- ══════════════════════════════════════════════════════════════════
    -- ⭐⭐ TAKING `CREATE` AWAY FROM THE APPLICATION ROLE
    -- ══════════════════════════════════════════════════════════════════
    --
    -- THE LINE THAT MAKES §5 A GUARANTEE RATHER THAN A CONVENTION.
    --
    -- Until this, `ordence_app` could issue a bare `CREATE TABLE` — so the
    -- factory function was the way tables were made, not the only way, and
    -- "only through the factory" was a code-review rule. One future code
    -- path, one migration helper, one debugging session that leaves a
    -- `CREATE TABLE` behind, and there is a table with no row-level security
    -- that nothing in this file would have prevented.
    --
    -- After it, the application role CANNOT create a table, a view or an
    -- index in `public` at all. The SECURITY DEFINER functions above are the
    -- only door, and they cannot produce an unprotected table.
    --
    -- ⚠️ TEMPORARY TABLES ARE UNAFFECTED — they live in `pg_temp`, which is
    -- a different schema and a different grant. Nothing that relies on them
    -- breaks.
    --
    -- ⚠️ `drizzle-kit push` AND EVERY FILE IN `SQL-FILES/` RUN AS THE
    -- MIGRATION SUPERUSER, not as `ordence_app`. If a deployment ever starts
    -- running migrations as the application role, this REVOKE is what will
    -- fail first — loudly, at deploy time, which is the right place.
    REVOKE CREATE ON SCHEMA public FROM ordence_app;

    -- ⚠️ AND FROM `PUBLIC`, WHICH IS THE ONE PEOPLE MISS. Every role is a
    -- member of `PUBLIC`, so a grant there reaches `ordence_app` no matter what
    -- was revoked from it by name — `has_schema_privilege` would still say
    -- true and Check 11 would still fail. PostgreSQL 15 made this the default;
    -- databases created before it, or with an explicit `GRANT ALL ON SCHEMA
    -- public TO PUBLIC` in their history, still carry it.
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;

    GRANT USAGE ON SCHEMA public TO ordence_app;

    -- ⚠️ EXECUTE IS REVOKED FROM PUBLIC FIRST. A SECURITY DEFINER function
    -- executable by PUBLIC is executable by every role on the instance,
    -- including any read-only reporting role somebody adds later — and these
    -- functions run as a superuser.
    REVOKE ALL ON FUNCTION dynamic_create_object_table(uuid, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION dynamic_add_field_column(uuid, text, text, text,
                                                    boolean, boolean, boolean,
                                                    text[], text, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION dynamic_drop_field_column(uuid, text, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION dynamic_drop_object_table(uuid, text, bigint) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION dynamic_create_object_table(uuid, text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_add_field_column(uuid, text, text, text,
                                                       boolean, boolean, boolean,
                                                       text[], text, text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_drop_field_column(uuid, text, text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_drop_object_table(uuid, text, bigint) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_assert_identifier(text, text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_pg_type(text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_ddl_name(text, text, text) TO ordence_app;
    GRANT EXECUTE ON FUNCTION dynamic_is_reserved_word(text) TO ordence_app;
  END IF;
END
$$;


-- ############################################################################
-- SECTION 10 — VERIFICATION
-- ############################################################################
--
-- Every check names what breaks if it fails, because "FAIL" on its own tells
-- you nothing about whether to panic.

-- Check 1 — RLS is ENABLED **and FORCED** on the metadata tables.
SELECT
  c.relname AS table_name,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity
       THEN 'PASS (enabled + forced)'
       WHEN c.relrowsecurity
       THEN '*** FAIL — enabled but NOT FORCED: the owner bypasses it ***'
       ELSE '*** FAIL — ROW LEVEL SECURITY IS OFF ***'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('dynamic_objects','dynamic_fields')
ORDER BY c.relname;


-- Check 2 — every metadata policy has BOTH a read and a write clause.
SELECT
  tablename, policyname,
  CASE WHEN qual IS NOT NULL AND with_check IS NOT NULL
       THEN 'PASS (read + write)'
       WHEN with_check IS NULL
       THEN '*** FAIL — no WITH CHECK: a tenant can plant an object '
            'definition in another tenant''s workspace ***'
       ELSE '*** FAIL — no USING clause ***'
  END AS verdict
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('dynamic_objects','dynamic_fields')
ORDER BY tablename;


-- Check 3 — the composite foreign keys exist.
SELECT
  expected.conname,
  CASE WHEN pc.conname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — MISSING: a row can point at another tenant''s record ***'
  END AS verdict
FROM (VALUES
  ('dynamic_fields_object_same_tenant'),
  ('dynamic_fields_relation_same_tenant'),
  ('dynamic_objects_created_by_same_tenant')
) AS expected(conname)
LEFT JOIN pg_constraint pc ON pc.conname = expected.conname;


-- Check 4 — the engine's functions exist, and the dangerous ones are
-- SECURITY DEFINER with a pinned search_path.
--
-- ⚠️ `proconfig` is the pin. A SECURITY DEFINER function without one can be
-- attacked by a caller who controls their own search_path — the textbook
-- privilege escalation, and it is invisible in `\df`.
SELECT
  expected.proname,
  CASE
    WHEN p.proname IS NULL THEN '*** FAIL — FUNCTION MISSING ***'
    WHEN expected.needs_definer AND NOT p.prosecdef
      THEN '*** FAIL — not SECURITY DEFINER: the app role cannot create '
           'tables, so this function would simply never work ***'
    WHEN expected.needs_definer
         AND (p.proconfig IS NULL
              OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                              WHERE cfg LIKE 'search\_path=%'))
      THEN '*** FAIL — SECURITY DEFINER with no pinned search_path: a caller '
           'can shadow the functions it calls and run as the owner ***'
    ELSE 'PASS'
  END AS verdict
FROM (VALUES
  ('dynamic_assert_identifier',   false),
  ('dynamic_is_reserved_word',    false),
  ('dynamic_pg_type',             false),
  ('dynamic_ddl_name',            false),
  ('dynamic_create_object_table', true),
  ('dynamic_add_field_column',    true),
  ('dynamic_drop_field_column',   true),
  ('dynamic_drop_object_table',   true)
) AS expected(proname, needs_definer)
LEFT JOIN pg_proc p ON p.proname = expected.proname
ORDER BY expected.proname;


-- Check 5 — ⭐⭐ THE FACTORY REALLY DOES ATTACH RLS.
--
-- A function that exists and does nothing passes Check 4. This one CREATES A
-- REAL TABLE in a temporary workspace, inspects what came out, and rolls
-- everything back. It is the single most important check in the file.
DO $$
DECLARE
  v_tenant  uuid := gen_random_uuid();
  v_object  uuid := gen_random_uuid();
  v_table   text;
  v_enabled boolean;
  v_forced  boolean;
  v_qual    text;
  v_check   text;
  v_notnull boolean;
  v_pin     boolean;
BEGIN
  INSERT INTO tenants (id, clerk_org_id, slug, name, status)
    VALUES (v_tenant, 'org_vfy_' || v_tenant, 'vfy-' || left(v_tenant::text, 8),
            'Phase 24 verification', 'active');

  PERFORM set_config('app.current_tenant_id', v_tenant::text, true);

  v_table := 'cx_verify_' || left(replace(v_object::text, '-', ''), 8);

  INSERT INTO dynamic_objects
    (id, tenant_id, api_name, label, plural_label, physical_table_name)
    VALUES (v_object, v_tenant, 'verify', 'Verify', 'Verifies', v_table);

  PERFORM dynamic_create_object_table(v_tenant, v_table);

  SELECT c.relrowsecurity, c.relforcerowsecurity
    INTO v_enabled, v_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = v_table;

  SELECT pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
    INTO v_qual, v_check
    FROM pg_policy p WHERE p.polrelid = format('public.%I', v_table)::regclass;

  SELECT c.is_nullable = 'NO' INTO v_notnull
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = v_table
     AND c.column_name = 'tenant_id';

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = format('public.%I', v_table)::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%tenant_id%'
  ) INTO v_pin;

  IF v_enabled AND v_forced AND v_qual IS NOT NULL AND v_check IS NOT NULL
     AND coalesce(v_notnull, false) AND v_pin THEN
    RAISE NOTICE 'PASS: a runtime table is created with NOT NULL tenant_id, a '
                 'tenant CHECK pin, RLS enabled AND forced, and a policy with '
                 'both USING and WITH CHECK.';
  ELSE
    RAISE WARNING '*** FAIL — A RUNTIME TABLE WAS CREATED WITHOUT FULL '
                  'PROTECTION (enabled=%, forced=%, using=%, check=%, '
                  'tenant_id NOT NULL=%, pin=%). EVERY WORKSPACE ON THIS '
                  'INSTANCE CAN READ THAT CUSTOMER''S RECORDS. ***',
                  v_enabled, v_forced, v_qual IS NOT NULL, v_check IS NOT NULL,
                  v_notnull, v_pin;
  END IF;

  RAISE EXCEPTION 'verification rollback';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'verification rollback' THEN
    RAISE WARNING '*** FAIL — verification could not run: % ***', SQLERRM;
  END IF;
END
$$;


-- Check 6 — ⭐ THE IDENTIFIER GATE REALLY DOES REFUSE.
--
-- Same principle as Check 5: the gate is proved by feeding it the attacks
-- rather than by reading it. These are the exact strings
-- `tests/security/dynamic-objects.test.ts` feeds to the TypeScript copy — the
-- two validators are supposed to be the same rule in two languages, and this
-- is where that is checked.
DO $$
DECLARE
  attack   text;
  refused  boolean;
  passed   integer := 0;
  leaked   text[]  := ARRAY[]::text[];
BEGIN
  FOREACH attack IN ARRAY ARRAY[
    '"; DROP TABLE users; --',          -- quote breaking
    'users"; DROP TABLE users; --',     -- the same, with a plausible prefix
    'a'' OR ''1''=''1',                 -- literal breaking
    'users; DELETE FROM tenants',       -- statement stacking
    'SELECT',                           -- capitals
    'select',                           -- a reserved word
    'user',                             -- a reserved word that is also a column
    'tenant_id',                        -- ⭐ shadowing the RLS column
    'id',
    'created_at',
    'pg_class',                         -- catalogue prefix
    'usеrs',                            -- ⚠️ Cyrillic е — a homoglyph
    'ｕsers',                            -- fullwidth u
    'user' || chr(8203) || 's',         -- zero-width space
    'users' || chr(10) || 'DROP TABLE tenants',  -- embedded newline
    'café',                             -- non-ASCII
    '2fast',                            -- leading digit
    '_leading',                         -- leading underscore
    'has space',
    'has-hyphen',
    repeat('a', 64),                    -- 64 bytes: silently truncated
    repeat('é', 40)                     -- 40 chars, 80 bytes
  ]
  LOOP
    refused := false;
    BEGIN
      PERFORM dynamic_assert_identifier(attack, 'column');
    EXCEPTION WHEN OTHERS THEN
      refused := true;
    END;

    IF refused THEN
      passed := passed + 1;
    ELSE
      leaked := leaked || attack;
    END IF;
  END LOOP;

  IF array_length(leaked, 1) IS NULL THEN
    RAISE NOTICE 'PASS: all % identifier attacks refused (injection, reserved '
                 'words, system columns, homoglyphs, over-length).', passed;
  ELSE
    RAISE WARNING '*** FAIL — dynamic_assert_identifier ACCEPTED %. Every one '
                  'of these ends up interpolated into DDL. ***', leaked;
  END IF;
END
$$;


-- Check 7 — ⭐ NO CORE TABLE HAS A `cx_` NAME.
--
-- The whole collision guarantee rests on this. If a future phase ships a
-- table called `cx_something`, a workspace could be issued a physical name
-- that shadows it, and the generic CRUD layer would read and write a core
-- table under the caller's tenant scope.
SELECT
  CASE WHEN count(*) = 0
       THEN 'PASS: the cx_ namespace belongs to the runtime engine alone'
       ELSE '*** FAIL — ' || count(*) || ' core table(s) named cx_*. The '
            'prefix no longer guarantees anything. ***'
  END AS check_prefix_namespace
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname LIKE 'cx\_%'
  AND NOT EXISTS (
    SELECT 1 FROM dynamic_objects o WHERE o.physical_table_name = c.relname
  );


-- Check 8 — ⭐ EVERY RUNTIME TABLE THAT EXISTS TODAY IS PROTECTED.
--
-- The drift check. Check 5 proves the factory is correct NOW; this one proves
-- nothing created earlier has since lost its protection — to a restore, a
-- `drizzle-kit push` (which drops policies), or a manual fix.
--
-- ⚠️ `drizzle-kit push` DROPS RLS POLICIES. That is why `package.json` prints
-- a warning after it and why this file is re-run afterwards. This check is
-- what catches the day somebody skips that step.
SELECT
  c.relname AS runtime_table,
  CASE
    WHEN NOT c.relrowsecurity THEN
      '*** FAIL — RLS OFF: every workspace can read this customer''s records ***'
    WHEN NOT c.relforcerowsecurity THEN
      '*** FAIL — RLS not FORCED: the table owner bypasses it ***'
    WHEN NOT EXISTS (SELECT 1 FROM pg_policy p
                      WHERE p.polrelid = c.oid AND p.polqual IS NOT NULL
                        AND p.polwithcheck IS NOT NULL) THEN
      '*** FAIL — no policy with both USING and WITH CHECK ***'
    ELSE 'PASS'
  END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'cx\_%'
ORDER BY c.relname;
-- (No rows returned = no runtime tables yet = PASS by vacuum.)


-- Check 9 — the metadata and the catalogue agree.
--
-- A definition with no table produces an object in the customer's navigation
-- whose every query fails. A table with no definition is worse: customer
-- data, including personal data, that nothing in the product can enumerate,
-- export or delete.
SELECT 'definition with no table' AS problem, count(*) AS n,
       CASE WHEN count(*) = 0 THEN 'PASS'
            ELSE '*** FAIL — every read of this object type errors ***' END AS verdict
  FROM dynamic_objects o
 WHERE to_regclass(format('public.%I', o.physical_table_name)) IS NULL
UNION ALL
SELECT 'table with no definition', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS'
            ELSE '*** FAIL — orphaned customer data nothing can enumerate ***' END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'cx\_%'
   AND NOT EXISTS (SELECT 1 FROM dynamic_objects o
                    WHERE o.physical_table_name = c.relname)
UNION ALL
SELECT 'field with no column', count(*),
       CASE WHEN count(*) = 0 THEN 'PASS'
            ELSE '*** FAIL — a form field whose every write fails ***' END
  FROM dynamic_fields f
  JOIN dynamic_objects o ON o.id = f.object_id
 WHERE f.deleted_at IS NULL
   AND to_regclass(format('public.%I', o.physical_table_name)) IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = o.physical_table_name
        AND c.column_name = f.physical_column_name);


-- Check 10 — every relation target has the UNIQUE (id, tenant_id) a
-- composite foreign key needs. Without it, `relation` fields to that table
-- cannot be created at all — and the error a customer sees names an index.
SELECT
  expected.tbl,
  CASE WHEN to_regclass(format('public.%I', expected.tbl)) IS NULL
         THEN 'SKIP (table not present in this build)'
       WHEN EXISTS (
         SELECT 1 FROM pg_indexes i
          WHERE i.schemaname = 'public' AND i.tablename = expected.tbl
            AND i.indexdef LIKE '%UNIQUE%'
            AND i.indexdef LIKE '%(id, tenant_id)%')
         THEN 'PASS'
       ELSE '*** FAIL — a relation to this table cannot be created, and a '
            'single-column key would accept another tenant''s row ***'
  END AS verdict
FROM (VALUES
  ('contacts'),('companies'),('deals'),('leads'),
  ('projects'),('units'),('bookings'),('users'),('dynamic_objects')
) AS expected(tbl);


-- Check 11 — ⭐ THE APPLICATION ROLE CANNOT CREATE A TABLE.
--
-- This is what turns "tables are made by the factory" from a convention into
-- a guarantee. With CREATE on the schema, one stray `CREATE TABLE` anywhere
-- in the codebase is an unprotected table.
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ordence_app')
      THEN 'SKIP (no ordence_app role in this database)'
    WHEN has_schema_privilege('ordence_app', 'public', 'CREATE')
      THEN '*** FAIL — ordence_app can CREATE in public. It can therefore make '
           'a table with no row-level security, and the factory function is '
           'only a convention. ***'
    ELSE 'PASS: the factory function is the only way to create a table'
  END AS check_app_role_cannot_create;


-- Check 12 — every field type maps to a column type.
-- A missing mapping is a field type that can be stored in the metadata and
-- can never be turned into a column.
SELECT
  e.enumlabel AS field_type,
  CASE WHEN dynamic_pg_type(e.enumlabel) IS NULL
       THEN '*** FAIL — no column type: this field can be defined and never '
            'created ***'
       ELSE 'PASS (' || dynamic_pg_type(e.enumlabel) || ')'
  END AS verdict
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'dynamic_field_type'
ORDER BY e.enumsortorder;


-- Check 13 — money is bigint. Stated as its own check because it is the one
-- mapping whose silent change costs actual money.
SELECT
  CASE WHEN dynamic_pg_type('currency') = 'bigint'
       THEN 'PASS: money is bigint minor units'
       ELSE '*** FAIL — currency maps to ' || coalesce(dynamic_pg_type('currency'), 'nothing')
            || '. Money must be bigint paise: a float loses a paisa per '
            'instalment and a numeric invites a client-side float. ***'
  END AS check_money_is_bigint;


-- Check 14 — the change log covers this phase.
SELECT
  expected.tbl,
  CASE WHEN t.tgname IS NOT NULL THEN 'PASS'
       ELSE '*** FAIL — changes here are not recorded and could never sync ***'
  END AS verdict
FROM (VALUES ('dynamic_objects'), ('dynamic_fields')) AS expected(tbl)
LEFT JOIN pg_trigger t
       ON t.tgname = expected.tbl || '_change_log'
      AND t.tgrelid = expected.tbl::regclass
      AND NOT t.tgisinternal;
